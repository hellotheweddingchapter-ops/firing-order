// Engine sound fingerprinting: rpm tracking, order tracking and spectral balance.
// Used offline (Node) to measure real recordings and the synthesis the same way.

const fs = require('fs');

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || fmt.bits !== 16) throw new Error('need 16-bit PCM wav');
  const n = Math.floor(data.length / 2 / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2);
    x[i] = s / fmt.ch / 32768;
  }
  return { x, sr: fmt.sr };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + h] * cr - im[i + k + h] * ci, vi = re[i + k + h] * ci + im[i + k + h] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + h] = ur - vr; im[i + k + h] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// Magnitude spectrogram (dB), Hann window.
function stft(x, sr, N = 4096, hop = 512) {
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const frames = [];
  for (let s = 0; s + N <= x.length; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    const db = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) db[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
    frames.push({ t: (s + N / 2) / sr, db });
  }
  return { frames, binHz: sr / N, N, hop };
}

// Track the firing frequency frame by frame: a harmonic comb scored against the spectrum,
// then the smoothest high-scoring path through time (dynamic programming).
function trackRpm(x, sr, cylinders, rpmMin, rpmMax) {
  const { frames, binHz } = stft(x, sr, 4096, 512);
  const fire = (rpm) => rpm / 60 * cylinders / 2;
  const cands = [];
  for (let r = rpmMin; r <= rpmMax; r += 25) cands.push(r);
  const at = (db, f) => { const k = f / binHz, i = Math.floor(k), w = k - i; return i + 1 < db.length ? db[i] * (1 - w) + db[i + 1] * w : -120; };
  const score = frames.map((fr) => {
    // Normalise per frame so loud frames don't dominate, then score each candidate.
    let mean = 0; for (let k = 2; k < 600; k++) mean += fr.db[k]; mean /= 598;
    return cands.map((r) => {
      const f = fire(r); let s = 0;
      for (let m = 1; m <= 6; m++) s += (at(fr.db, m * f) - mean) / m;
      // Penalise the half-way points so a subharmonic can't win.
      for (let m = 1; m <= 3; m++) s -= 0.5 * (at(fr.db, (m - 0.5) * f) - mean) / m;
      return s;
    });
  });
  const T = frames.length, C = cands.length, dtF = 512 / sr;
  const maxStep = Math.ceil(9000 * dtF / 25) + 1; // revs change at most ~9,000 rpm/s
  const acc = score.map(() => new Float32Array(C)), back = score.map(() => new Int32Array(C));
  acc[0].set(score[0]);
  for (let t = 1; t < T; t++) {
    for (let c = 0; c < C; c++) {
      let best = -Infinity, bi = c;
      // Gear changes drop revs suddenly: allow big downward jumps, penalised.
      for (let p = Math.max(0, c - maxStep); p < C; p++) {
        const jump = c - p;
        if (jump > maxStep) continue;
        const pen = jump >= -maxStep ? Math.abs(jump) * 0.15 : 6 + Math.abs(jump) * 0.01;
        const v = acc[t - 1][p] - pen;
        if (v > best) { best = v; bi = p; }
      }
      acc[t][c] = best + score[t][c]; back[t][c] = bi;
    }
  }
  let c = 0; for (let i = 1; i < C; i++) if (acc[T - 1][i] > acc[T - 1][c]) c = i;
  const rpm = new Float32Array(T), conf = new Float32Array(T);
  for (let t = T - 1; t >= 0; t--) { rpm[t] = cands[c]; conf[t] = score[t][c]; c = back[t][c]; }
  return { t: frames.map((f) => f.t), rpm, conf, frames, binHz };
}

// Order spectrum: resample to a fixed number of samples per crank revolution, so each
// harmonic of the engine sits in one bin even while the revs climb.
function orderSpectra(x, sr, track, opts = {}) {
  const spr = opts.spr || 64, revs = opts.revs || 32, maxOrder = opts.maxOrder || 12;
  // Interpolated rpm at a time. Calls arrive in time order, so a moving cursor keeps this linear.
  let cur = 1;
  const rpmAt = (time) => {
    const ts = track.t; if (time <= ts[0]) return track.rpm[0];
    if (time < ts[cur - 1]) cur = 1;
    while (cur < ts.length && ts[cur] < time) cur++;
    if (cur >= ts.length) return track.rpm[ts.length - 1];
    const w = (time - ts[cur - 1]) / (ts[cur] - ts[cur - 1]);
    return track.rpm[cur - 1] * (1 - w) + track.rpm[cur] * w;
  };
  // Shaft angle (revolutions) for every sample, then the times at which each angle step is reached.
  const ang = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) ang[i] = ang[i - 1] + rpmAt(i / sr) / 60 / sr;
  const total = Math.floor(ang[x.length - 1] * spr), y = new Float32Array(total), yt = new Float32Array(total);
  let j = 0;
  for (let k = 0; k < total; k++) {
    const a = k / spr;
    while (j < x.length - 2 && ang[j + 1] < a) j++;
    const w = (a - ang[j]) / Math.max(1e-9, ang[j + 1] - ang[j]);
    y[k] = x[j] * (1 - w) + x[j + 1] * w; yt[k] = (j + w) / sr;
  }
  const N = spr * revs, out = [];
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  for (let s = 0; s + N <= total; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = y[s + i] * win[i];
    fft(re, im);
    const ord = [];
    for (let h = 1; h <= maxOrder * 2; h++) {
      // Order h/2 sits at bin h/2*revs; take the peak of +-1 bin to tolerate tracking error.
      const k = Math.round(h / 2 * revs);
      let p = 0; for (let d = -1; d <= 1; d++) p = Math.max(p, re[k + d] ** 2 + im[k + d] ** 2);
      ord.push(10 * Math.log10(p + 1e-14));
    }
    // Noise floor: the median level a quarter-order away from every harmonic, where an engine puts nothing.
    const gaps = [];
    for (let h = 1; h <= maxOrder * 2; h++) { const k = Math.round((h / 2 + 0.25) * revs); gaps.push(10 * Math.log10(re[k] ** 2 + im[k] ** 2 + 1e-14)); }
    gaps.sort((a, b) => a - b);
    out.push({ t: yt[s + N / 2], rpm: rpmAt(yt[s + N / 2]), ord, floor: gaps[gaps.length >> 1] });
  }
  return out;
}

// Tonal balance: third-octave band levels relative to the total, 50 Hz to 8 kHz.
const BANDS = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000];
function balance(frames, binHz, useFrame = () => true) {
  const acc = new Float64Array(BANDS.length); let n = 0;
  frames.forEach((fr, i) => {
    if (!useFrame(i)) return; n++;
    BANDS.forEach((fc, b) => {
      const lo = fc / 1.122, hi = fc * 1.122; let p = 0;
      for (let k = Math.ceil(lo / binHz); k <= Math.floor(hi / binHz); k++) p += 10 ** (fr.db[k] / 10);
      acc[b] += p;
    });
  });
  const tot = acc.reduce((s, v) => s + v, 0);
  return Array.from(acc, (v) => 10 * Math.log10(v / tot + 1e-14));
}

// Fingerprint: order levels relative to the firing order, averaged in rpm bins, plus balance.
function fingerprint(x, sr, cylinders, track, rpmBins) {
  const spectra = orderSpectra(x, sr, track);
  const fireIdx = cylinders - 1; // order cylinders/2 is entry (cylinders/2)*2 - 1
  const bins = rpmBins.map(([lo, hi]) => {
    const rows = spectra.filter((s) => s.rpm >= lo && s.rpm < hi);
    if (!rows.length) return null;
    const rel = rows[0].ord.map((_, h) => rows.reduce((sum, r) => sum + (r.ord[h] - r.ord[fireIdx]), 0) / rows.length);
    const floor = rows.reduce((sum, r) => sum + (r.floor - r.ord[fireIdx]), 0) / rows.length;
    return { lo, hi, n: rows.length, rel, floor };
  });
  return { bins, balance: balance(track.frames, track.binHz) };
}

module.exports = { readWav, stft, trackRpm, orderSpectra, fingerprint, balance, BANDS };
