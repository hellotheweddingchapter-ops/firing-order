// Compares the synthesis with a real recording, fingerprint against fingerprint, and can
// search the sound settings for the closest match.
//   node tools/match.js <engineId>            report the mismatch
//   node tools/match.js <engineId> --fit      tune the settings and write tools/fitted-<id>.json

const path = require('path'), fs = require('fs');
const root = path.join(__dirname, '..');
const F = require('./fingerprint.js');
const { EngineDSP } = require(path.join(root, 'engine-worklet.js'));
const ENGINES = require(path.join(root, 'engines.js'));

// Recordings (Wikimedia Commons, CC BY-SA 3.0; see README for credits). For each: cylinders
// to track with, rpm range, the stretch where the car is clearly audible, and a factor to fix
// tracking that locks onto a bank's note instead of the firing note.
const REFS = {
  gt3: { file: 'gt3rs.wav', cyl: 6, lo: 900, hi: 9000, from: 0.6, to: 7.4, scale: 1, label: 'Porsche 997 GT3 RS launch, Goodwood (Edvvc)' },
  f458: { file: 'f458.wav', cyl: 8, lo: 1000, hi: 9200, from: 2.5, to: 9.8, scale: 2, label: 'Ferrari 458 Italia launch, Goodwood (Edvvc)' },
  // The same GT3 RS clip split by gear, to check the fit generalises: fit on one, test on the other.
  gt3gear1: { engine: 'gt3', file: 'gt3rs.wav', cyl: 6, lo: 900, hi: 9000, from: 0.6, to: 3.7, scale: 1, label: 'GT3 RS, 1st gear only' },
  gt3gear2: { engine: 'gt3', file: 'gt3rs.wav', cyl: 6, lo: 900, hi: 9000, from: 4.0, to: 7.4, scale: 1, label: 'GT3 RS, 2nd gear only' },
  // Held out for checking: a different flat-six, car-mounted mic, lower revs. Not used for fitting.
  cayman: { engine: 'gt3', file: 'cayman.wav', cyl: 6, lo: 800, hi: 7600, from: 2.0, to: 17.0, scale: 1, label: 'Porsche Cayman S, car-mounted mic (John64)' },
  gtr: { file: 'gtr.wav', cyl: 6, lo: 800, hi: 7300, from: 1.4, to: 5.8, scale: 1, label: 'Nissan GT-R SpecV launch, Goodwood (Edvvc)' },
};
const RPM_BINS = [[1500, 2500], [2500, 3500], [3500, 5000], [5000, 6500], [6500, 8000], [8000, 9500]];

function reference(id) {
  const r = REFS[id];
  const { x, sr } = F.readWav(path.join(root, 'reference', r.file));
  const tr = F.trackRpm(x, sr, r.cyl, r.lo, r.hi);
  const a = Math.floor(r.from * sr), b = Math.floor(r.to * sr), seg = x.subarray(a, b);
  // Re-run the analysis on the stretch, with the corrected rpm trace.
  const keep = tr.t.map((t, i) => [t, i]).filter(([t]) => t >= r.from && t <= r.to);
  const rpmT = keep.map(([t]) => t - r.from), rpmV = Float32Array.from(keep, ([, i]) => tr.rpm[i] * r.scale);
  // Smooth the trace a little: the tracker steps in 25 rpm.
  for (let k = 0; k < 3; k++) for (let i = 1; i < rpmV.length - 1; i++) rpmV[i] = (rpmV[i - 1] + 2 * rpmV[i] + rpmV[i + 1]) / 4;
  const st = F.stft(seg, sr);
  const track = { t: rpmT, rpm: rpmV, frames: st.frames, binHz: st.binHz };
  return { sr, x: seg, track, fp: F.fingerprint(seg, sr, ENGINES[r.engine || id].sound.firing.length, track, RPM_BINS) };
}

function render(cfg, track, sr, listen = 'outside') {
  const dur = track.t[track.t.length - 1] + 0.1, N = Math.floor(dur * sr);
  const L = new Float32Array(N), R = new Float32Array(N), d = new EngineDSP(sr);
  d.configure(cfg);
  d.temp = 900; // the car has been running: warm exhaust, as at a hillclimb start
  let j = 0;
  for (let i = 0; i < N; i += 128) {
    const t = i / sr;
    while (j < track.t.length - 1 && track.t[j + 1] < t) j++;
    const rpm = track.rpm[j];
    d.setParams({ rpm, load: 1, fuelCut: 0, listen, speed: 20 });
    d.rpm = rpm; // follow the measured trace exactly
    d.render(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, N - i));
  }
  return L;
}

function synthFP(cfg, ref) {
  const y = render(cfg, ref.track, ref.sr);
  const st = F.stft(y, ref.sr);
  const track = { ...ref.track, frames: st.frames, binHz: st.binHz };
  return F.fingerprint(y, ref.sr, cfg.firing.length, track, RPM_BINS);
}

// Mismatch in dB: harmonic structure (relative to the firing note) and tonal balance.
function compare(a, b) {
  const ord = [], bal = [];
  a.bins.forEach((ba, i) => {
    const bb = b.bins[i];
    if (!ba || !bb || ba.n < 2) return;
    // A harmonic buried in the recording's noise can't be measured: then only penalise the
    // synthesis if it puts clear energy there. Otherwise compare, with the synthesis floored at
    // the same noise level (being cleaner than a crowd is not a fault).
    const fl = ba.floor + 4;
    ba.rel.forEach((v, h) => {
      const sv = bb.rel[h];
      const d = v < fl ? Math.max(0, sv - fl) : Math.max(sv, ba.floor) - v;
      ord.push({ order: (h + 1) / 2, rpm: `${ba.lo}-${ba.hi}`, d: Math.max(-20, Math.min(20, d)), audible: v >= fl });
    });
  });
  // Balance: 80 Hz to 6.3 kHz. Crowd noise and distance colour the recordings, so it counts for half.
  a.balance.forEach((v, k) => { if (k >= 2 && k <= 21) bal.push({ band: F.BANDS[k], d: b.balance[k] - v }); });
  const rms = (arr) => Math.sqrt(arr.reduce((s, e) => s + e.d * e.d, 0) / Math.max(1, arr.length));
  return { ord, bal, score: rms(ord) + 0.5 * rms(bal), ordRms: rms(ord), balRms: rms(bal) };
}

// The settings the fit may move, with limits. Multiplicative steps keep them in proportion.
const KNOBS = [
  ['pulse.lambdaFull', 0.1, 1.5], ['pulse.spanDeg', 70, 260], ['pulse.nu', 0.5, 1],
  ['banks.0.pipeMs', 2, 14], ['tail.ms', 3, 16], ['tail.mix', 0.05, 0.7],
  ['pipeFb', -0.85, -0.2], ['runnerFb', -0.7, -0.1],
  ['muffler.0.f', 50, 400], ['muffler.0.g', 0.1, 2], ['muffler.1.f', 150, 1200], ['muffler.1.g', 0.1, 2],
  ['muffler.2.f', 400, 3500], ['muffler.2.g', 0.05, 1.5], ['mufflerDirect', 0.1, 1],
  ['tone.base', 300, 4000], ['tone.rpm', 0.05, 1], ['rasp', 0, 1],
  ['intake.gain', 0, 2], ['intake.hz', 200, 1500], ['intake.roar', 0, 1], ['mech.noise', 0, 0.3],
  // Bank and cylinder differences: they set the half-orders and the per-bank notes.
  ['banks.1.pipeMs', 2, 14], ['banks.1.gain', 0.3, 1.7], ['cylSpread', 0.2, 4],
];
// cylSpread is not a setting of its own: it scales every cylinder's deviation from the average.
function applyVirtual(c, base) {
  const sp = c.cylSpread ?? 1;
  c.firing.forEach((ev, i) => { ev.gain = 1 + ((base.firing[i].gain ?? 1) - 1) * sp; ev.runnerMs = base.firing[i].runnerMs * (1 + (sp - 1) * 0.15 * Math.sin(i * 2.1)); });
  return c;
}
const getP = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
const setP = (o, p, val) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((v, k) => v[k], o)[last] = val; };

function fit(id, ref, base) {
  let cfg = JSON.parse(JSON.stringify(base)); cfg.cylSpread = 1;
  if (cfg.banks[1] && cfg.banks[1].gain == null) cfg.banks[1].gain = 1;
  let best = compare(ref.fp, synthFP(cfg, ref)).score;
  const knobs = KNOBS.filter(([p]) => getP(cfg, p) != null);
  console.log(`start ${best.toFixed(2)} dB`);
  let step = 0.3;
  for (let sweep = 0; sweep < 7 && step > 0.03; sweep++) {
    let improved = false;
    for (const [p, lo, hi] of knobs) {
      const v0 = getP(cfg, p);
      for (const dir of [1, -1]) {
        const v = Math.max(lo, Math.min(hi, v0 < 0 ? v0 * (1 - dir * step) : (v0 === 0 ? (dir > 0 ? (hi - lo) * 0.1 : 0) : v0 * (1 + dir * step))));
        if (v === v0) continue;
        const c = JSON.parse(JSON.stringify(cfg)); setP(c, p, v);
        if (p === 'cylSpread') applyVirtual(c, base);
        const s = compare(ref.fp, synthFP(c, ref)).score;
        if (s < best - 0.01) { best = s; cfg = c; improved = true; break; }
      }
    }
    console.log(`sweep ${sweep + 1}: ${best.toFixed(2)} dB (step ${Math.round(step * 100)}%)`);
    if (!improved) step /= 2;
  }
  return { cfg, best };
}

function report(label, cmp) {
  console.log(`${label}: harmonic structure off by ${cmp.ordRms.toFixed(1)} dB rms, tonal balance off by ${cmp.balRms.toFixed(1)} dB rms (score ${cmp.score.toFixed(2)})`);
  const worst = [...cmp.ord].sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 5);
  console.log('  biggest harmonic gaps: ' + worst.map((w) => `order ${w.order} @${w.rpm} ${w.d > 0 ? '+' : ''}${w.d.toFixed(0)} dB`).join(', '));
  console.log('  balance by band (synth minus real): ' + cmp.bal.filter((_, i) => i % 2 === 0).map((b) => `${b.band >= 1000 ? b.band / 1000 + 'k' : b.band}:${b.d > 0 ? '+' : ''}${b.d.toFixed(0)}`).join(' '));
}

if (require.main === module) {
  const id = process.argv[2], doFit = process.argv.includes('--fit');
  const ref = reference(id);
  console.log(`${ENGINES[id].name} vs ${REFS[id].label}`);
  report('current', compare(ref.fp, synthFP(ENGINES[id].sound, ref)));
  if (doFit) {
    const { cfg } = fit(id, ref, ENGINES[id].sound);
    report('fitted ', compare(ref.fp, synthFP(cfg, ref)));
    const changed = {};
    for (const [p] of KNOBS) { const a = getP(ENGINES[id].sound, p) ?? (p === 'cylSpread' ? 1 : p === 'banks.1.gain' ? 1 : undefined), b = getP(cfg, p); if (a != null && Math.abs(a - b) > 1e-9) changed[p] = [a, +b.toFixed(4)]; }
    fs.writeFileSync(path.join(__dirname, `fitted-${id}.json`), JSON.stringify({ changed, cfg }, null, 1));
    console.log('changed: ' + Object.entries(changed).map(([p, [a, b]]) => `${p} ${a}→${b}`).join(', '));
  }
}

module.exports = { reference, synthFP, compare, render, fit, REFS };
