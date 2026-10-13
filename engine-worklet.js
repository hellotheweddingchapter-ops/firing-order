// Firing-event engine synthesis.
//
// Nothing here is a recording. Each combustion event produces an exhaust pressure pulse
// (blowdown, then a scavenging dip) at its own crank angle. Pulses run through their
// header runners into the bank pipes, a shared rear section, the muffler and, when the
// car has them, exhaust bypass valves. Intake events feed a separate induction path.
//
// The pipes are delay-line resonators whose length follows exhaust gas temperature:
// hotter gas means a faster speed of sound, so resonances rise as the engine works.
//
// Pulse model after Doerfler & Wyse, "Neural Engine Sound Synthesis with Physics-Informed
// Inductive Biases" (arXiv:2603.09391): envelope (1 − e^(−αu))·e^(−βu) times a harmonic
// series with exponential decay e^(−kλ/2), with a time warp u^ν for the falling pitch.
//
// Runs inside an AudioWorklet. Also loadable in Node for offline renders.

const TAU = Math.PI * 2;
const TBL = 1024;

let seed = 0x2545f491;
function rnd() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 2147483648 - 1;
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const decay = (sec, sr) => Math.exp(-1 / Math.max(1e-5, sec * sr));

// Delay line with fractional, linearly interpolated reads. read(d): the sample from d samples ago (d >= 1).
class FDelay {
  constructor(maxSamples) { this.n = Math.ceil(maxSamples) + 4; this.buf = new Float32Array(this.n); this.w = 0; }
  write(x) { this.buf[this.w] = x; if (++this.w >= this.n) this.w = 0; }
  read(d) {
    let r = this.w - d;
    if (r < 0) r += this.n;
    const i = r | 0, f = r - i, j = i + 1 >= this.n ? 0 : i + 1;
    return this.buf[i] + (this.buf[j] - this.buf[i]) * f;
  }
}

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr) {
    f = Math.max(10, Math.min(f, sr * 0.45));
    const w = TAU * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// First-order all-pass: shifts phase only. Different settings left and right widen a mono source.
class AllPass {
  constructor(g) { this.g = g; this.x1 = 0; this.y1 = 0; }
  run(x) { const y = -this.g * x + this.x1 + this.g * this.y1; this.x1 = x; this.y1 = y; return y; }
}

// One exhaust pressure pulse over normalised time u in [0, 1].
function buildPulse(lambda, p, K) {
  const t = new Float32Array(TBL + 2);
  let peak = 0;
  for (let i = 0; i <= TBL; i++) {
    const u = i / TBL;
    const env = (1 - Math.exp(-p.attack * u)) * Math.exp(-p.decay * u);
    const w = Math.pow(u, p.nu);
    let c = 0;
    for (let k = 1; k <= K; k++) c += Math.exp(-0.5 * k * lambda) * Math.sin(TAU * k * w);
    t[i] = env * c;
    peak = Math.max(peak, Math.abs(t[i]));
  }
  for (let i = 0; i <= TBL; i++) t[i] /= peak;
  t[TBL + 1] = t[TBL];
  return t;
}

// Harmonic counts for the band-limited pulse set. Short pulses (high revs) get fewer
// harmonics so nothing lands above Nyquist and folds back as fizz.
const MIPS = [18, 13, 9, 6, 4, 3, 2];

const crossed = (at, prev, ph, wrapped) => (wrapped ? (at > prev || at <= ph) : (at > prev && at <= ph));

class EngineDSP {
  constructor(sr) {
    this.sr = sr;
    this.cfg = null;
    this.rpm = 0; this.rpmT = 0;
    this.load = 0; this.loadT = 0;
    this.fuelCut = true; this.starter = false; this.crackleBoost = 0;
    this.speed = 0; this.cabin = true;
    this.phase = 0; this.ctl = 0; this.hunt = 0; this.huntV = 0;
    this.kR = 1 - Math.exp(-1 / (0.012 * sr));
    this.kL = 1 - Math.exp(-1 / (0.03 * sr));
    this.kLup = 1 - Math.exp(-1 / (0.006 * sr));
  }

  configure(cfg) {
    const sr = this.sr, ms = (v) => v * sr / 1000;
    this.cfg = cfg;
    this.tabs = MIPS.map((K) => ({ K, L: buildPulse(cfg.pulse.lambdaLight, cfg.pulse, K), F: buildPulse(cfg.pulse.lambdaFull, cfg.pulse, K) }));
    this.tIntake = this.tabs[Math.min(2, this.tabs.length - 1)].L; // intake pulses are soft: a mid table is enough
    // Delays are specified at 700 K; cold gas makes them up to ~1.5x longer.
    this.cyl = cfg.firing.map((ev) => ({
      at: (ev.deg % 720) / 720, ati: ((ev.deg + 360) % 720) / 720,
      bank: ev.bank || 0, gain: ev.gain || 1,
      u: 1, du: 0, amp: 0, mix: 0, nz: 0, tab: null, drift: 0, atJ: (ev.deg % 720) / 720,
      iu: 1, idu: 0, iamp: 0,
      rLen: ms(ev.runnerMs), runner: new FDelay(ms(ev.runnerMs) * 1.6 + 2), rlp: 0,
    }));
    this.banks = cfg.banks.map((b) => ({
      pLen: ms(b.pipeMs), pipe: new FDelay(ms(b.pipeMs) * 1.6 + 4),
      muff: cfg.muffler.map((m) => ({ f: new Biquad().set('bp', m.f, m.q, sr), g: m.g })),
      closed: new Biquad().set('lp', cfg.valve ? cfg.valve.closedHz : 20000, 0.7, sr),
      tone: new Biquad().set('lp', 2000, 0.7, sr),
      gl: 1 - 0.45 * (b.pan || 0), gr: 1 + 0.45 * (b.pan || 0),
      ck: { e1: 0, e2: 0, nz: 0 }, y: 0,
    }));
    this.tLen = ms(cfg.tail.ms); this.tail = new FDelay(this.tLen * 1.6 + 4);
    const it = cfg.intake;
    this.iLen = ms(it.runnerMs); this.irun = new FDelay(this.iLen * 1.6 + 4); this.ilp = 0;
    this.plenum = new Biquad().set('bp', it.hz, it.q, sr); this.plenumHz = it.hz;
    this.roarBp = new Biquad().set('bp', it.hz * 2.5, 0.8, sr);
    this.hissBp = new Biquad().set('bp', 3600, 1.6, sr);
    this.blockLp = new Biquad().set('lp', cfg.blockHz, 0.9, sr);
    this.blockLp2 = new Biquad().set('lp', cfg.blockHz * 1.4, 0.6, sr);
    this.clickHp = new Biquad().set('hp', 4500, 0.7, sr);
    this.mechHp = new Biquad().set('hp', 2800, 0.7, sr);
    this.hissHp = new Biquad().set('hp', 3800, 0.7, sr);
    this.bovBp = new Biquad().set('bp', 2000, 1.2, sr);
    this.flutterBp = new Biquad().set('bp', 750, 1.3, sr);
    // Cabin: transmission through the body. Mass law above a few hundred hertz, plus leakage.
    this.kTL = 1 - Math.exp(-TAU * 380 / sr);
    this.tlM = 0; this.tlS = 0;
    this.leakM = new Biquad().set('lp', 3000, 0.7, sr);
    this.apL = [new AllPass(0.45), new AllPass(-0.2)];
    this.apR = [new AllPass(-0.35), new AllPass(0.55)];
    this.dc = { lx: 0, ly: 0, rx: 0, ry: 0 };
    // Four-line feedback delay network for a short, decorrelated stereo tail.
    this.fdn = [7.3, 9.1, 11.7, 13.9].map((m) => ({ d: new FDelay(ms(m * 3.4) + 4), base: ms(m), lp: 0 }));
    this.fdnOut = [0, 0, 0, 0];
    this.crackles = [];
    this.env = 0; this.click = 0;
    this.temp = 380; // just started: cold exhaust
    this.tScale = 1; this.vmix = 0; this.valveOpen = false;
    this.shafts = cfg.turbo ? Array.from({ length: cfg.turbo.count }, (_, i) => ({ s: 0, ph: 0, det: 1 + i * 0.031, bp: new Biquad() })) : [];
    this.gearBp = new Biquad(); this.diffBp = new Biquad(); this.wob = 0;
    this.boost = 0; this.bov = 0; this.bovT = 0; this.fph = 0;
    this.gph = 0; this.dph = 0; this.aph = 0; this.sph = 0;
    this.bankIn = new Float32Array(this.banks.length);
    this.control();
  }

  setParams(p) {
    const t = this.cfg && this.cfg.turbo;
    if (t && this.boost > 0.3 && this.loadT > 0.45 && (p.load < 0.1 || p.fuelCut)) {
      // Throttle snapped shut on boost: the bypass valve vents (or the compressor surges).
      this.bov = this.boost; this.bovT = 0; this.boost *= 0.3;
    }
    this.rpmT = p.rpm; this.loadT = p.load; this.fuelCut = !!p.fuelCut;
    this.starter = !!p.starter; this.crackleBoost = p.crackleBoost || 0;
    this.speed = p.speed || 0; this.cabin = p.listen !== 'outside';
    this.sport = !!p.sport;
  }

  // Everything that follows rpm, load and temperature, refreshed every 32 samples.
  control() {
    const c = this.cfg, sr = this.sr, blk = 32 / sr;
    const rn = clamp(this.rpm / c.redline, 0, 1.1);
    const burning = this.fuelCut ? 0 : 1;
    // Exhaust gas temperature in kelvin: seconds to heat up, longer to cool.
    const tT = this.rpm < 50 ? 300 : 450 + 600 * this.load * burning + 250 * rn;
    this.temp += (tT - this.temp) * blk / (tT > this.temp ? 3 : 7);
    this.tScale = 1 / Math.sqrt(this.temp / 700);

    this.dN = decay(0.0016, sr);
    this.cR = decay(0.00012, sr); this.cF = decay(0.0007, sr); this.cN = decay(0.004, sr);
    this.dClick = decay(0.00025, sr);

    let fc = c.tone.base + c.tone.load * this.load + c.tone.rpm * this.rpm;
    if (this.fuelCut) fc *= 0.75;
    for (const b of this.banks) b.tone.set('lp', fc, 0.75, sr);

    if (c.valve) {
      // Sport holds the bypass valves open; Comfort opens them only when the engine is working.
      const open = this.sport || this.rpm > c.valve.rpm || this.load > c.valve.load;
      const close = this.rpm < c.valve.rpm * 0.85 && this.load < c.valve.load * 0.7;
      if (open) this.valveOpen = true; else if (close) this.valveOpen = false;
      this.vmix += ((this.valveOpen ? 1 : 0) - this.vmix) * blk / 0.15;
    } else this.vmix = 1;

    const it = c.intake;
    const pHz = this.rpm > it.flapRpm ? it.flapHz : it.hz;
    this.plenumHz += (pHz - this.plenumHz) * blk / 0.08;
    this.plenum.set('bp', this.plenumHz, it.q, sr);

    if (c.gearWhine) {
      this.gearBp.set('bp', Math.max(40, this.rpm / 60 * c.gearWhine.teeth), 30, sr);
      this.diffBp.set('bp', Math.max(40, this.speed * c.gearWhine.perMs), 30, sr);
    }
    this.wob += blk * 0.9;
    // Idle control hunts a little; it settles once the engine is pulling.
    const idleNear = clamp(1 - (this.rpmT - c.idle) / 400, 0, 1) * (this.loadT < 0.15 ? 1 : 0);
    this.huntV = (this.huntV || 0) * 0.995 + rnd() * 0.0006;
    this.hunt = idleNear * (0.009 * Math.sin(TAU * this.wob * 0.8) + this.huntV);
    const lowRev = clamp(1 - (this.rpm - c.idle) / 1500, 0, 1);
    this.jit = c.jitter * (1 + 2 * lowRev);

    if (c.turbo) {
      const tb = c.turbo;
      const sT = burning * this.load * clamp((this.rpm - tb.spoolRpm) / 2500, 0, 1);
      for (const sh of this.shafts) {
        sh.s += (sT - sh.s) * blk / (sT > sh.s ? tb.lag : 1.6); // shafts coast down slowly
        sh.f = (tb.whineBase + tb.whineSpan * sh.s) * sh.det;
        sh.bp.set('bp', sh.f, 25, sr);
      }
      this.boost += (sT - this.boost) * blk / (sT > this.boost ? tb.lag * 0.8 : 0.08);
      if (this.bov > 0.001) {
        this.bovT += blk;
        if (tb.bov === 'whoosh') this.bovBp.set('bp', 700 + 2400 * Math.exp(-this.bovT / 0.25), 1.1, sr);
        if (this.bovT > 1.4) this.bov = 0;
      }
    }
  }

  fire(c, late = 0) {
    const cfg = this.cfg, p = cfg.pulse, rpm = Math.max(this.rpm, 150);
    const span = clamp(p.spanDeg / (6 * rpm), p.minMs / 1000, p.maxMs / 1000);
    c.du = 1 / (span * this.sr); c.u = late * c.du;
    // Highest harmonic of the pulse is about 1.5·K/span Hz once the time warp is counted.
    const nyq = 0.42 * this.sr * span / 1.5;
    c.tab = this.tabs.find((t) => t.K <= nyq) || this.tabs[this.tabs.length - 1];
    // Each cylinder wanders a little from cycle to cycle, in strength and in timing.
    c.drift = 0.94 * c.drift + 0.06 * rnd() * 3;
    c.atJ = (c.at + cfg.timingJitterDeg / 720 * rnd() + 1) % 1;
    if (this.fuelCut) {
      c.amp = 0.1 * (0.4 + this.rpm / cfg.redline); c.mix = 0; // compression only, no combustion
      c.nz = cfg.overrunAir * (0.3 + this.rpm / cfg.redline); // air pumped through: the hollow overrun burble
      if (this.rpm > 1800) {
        const pr = cfg.crackle * (this.sport ? 1 : 0.25) * (0.25 + this.rpm / cfg.redline) + this.crackleBoost;
        if (Math.random() < pr) {
          const big = Math.random() < 0.15;
          this.crackles.push({ wait: (0.002 + Math.random() * 0.03) * this.sr, bank: c.bank, amp: big ? 1.4 + Math.random() : 0.3 + Math.random() * 0.7 });
        }
      }
    } else {
      // Cylinder pressure follows throttle: cruise is around 10 dB below full load at the same revs.
      c.amp = (0.09 + 0.91 * Math.pow(this.load, cfg.dyn || 1.35)) * c.gain * (1 + this.jit * rnd() + 0.05 * c.drift);
      c.mix = Math.pow(this.load, 0.7);
      c.nz = c.amp * cfg.noise * (0.3 + this.load);
    }
    this.click = Math.max(this.click, cfg.mech.click * (0.3 + this.rpm / cfg.redline));
  }

  intakeEvent(c, late = 0) {
    const it = this.cfg.intake, rpm = Math.max(this.rpm, 150);
    const span = clamp(this.cfg.pulse.spanDeg * 1.4 / (6 * rpm), 0.0015, 0.012);
    c.idu = 1 / (span * this.sr); c.iu = late * c.idu;
    // A closed throttle starves the intake; on boost the compressor does the breathing instead.
    c.iamp = it.gain * (0.15 + 0.85 * this.load) * (0.25 + this.rpm / this.cfg.redline);
  }

  render(L, R, n) {
    const cfg = this.cfg, sr = this.sr, cyl = this.cyl, banks = this.banks, bankIn = this.bankIn;
    const nb = banks.length, rl = cfg.redline;
    for (let s = 0; s < n; s++) {
      if ((this.ctl++ & 31) === 0) this.control();
      this.rpm += (this.rpmT * (1 + this.hunt) - this.rpm) * this.kR;
      this.load += (this.loadT - this.load) * (this.loadT > this.load ? this.kLup : this.kL); // throttle opens fast, closes softer
      const rpm = this.rpm, ts = this.tScale, load = this.load;

      // Advance the crank through the 720° four-stroke cycle.
      const prev = this.phase;
      const dph = rpm / 120 / sr;
      let ph = prev + dph, wrapped = false;
      if (ph >= 1) { ph -= 1; wrapped = true; }
      this.phase = ph;
      if (rpm > 40) {
        for (let i = 0; i < cyl.length; i++) {
          // Events start at their exact crank angle, between samples, not on the next sample.
          if (crossed(cyl[i].atJ, prev, ph, wrapped)) this.fire(cyl[i], (((ph - cyl[i].atJ) % 1) + 1) % 1 / dph);
          if (crossed(cyl[i].ati, prev, ph, wrapped)) this.intakeEvent(cyl[i], (((ph - cyl[i].ati) % 1) + 1) % 1 / dph);
        }
      }

      // Exhaust pulses through their header runners; intake pulses into the plenum.
      for (let b = 0; b < nb; b++) bankIn[b] = 0;
      let raw = 0, intake = 0;
      const turb = cfg.turb * load;
      for (let i = 0; i < cyl.length; i++) {
        const c = cyl[i];
        let p = 0;
        if (c.u < 1) {
          const tL = c.tab.L, tF = c.tab.F;
          const x = c.u * TBL, k = x | 0, f = x - k;
          const a = tL[k] + (tL[k + 1] - tL[k]) * f, b = tF[k] + (tF[k + 1] - tF[k]) * f;
          p = c.amp * (a + (b - a) * c.mix) * (1 + turb * rnd());
          c.u += c.du;
        }
        c.nz *= this.dN;
        p += c.nz * rnd();
        raw += p;
        c.rlp += (c.runner.read(c.rLen * ts) - c.rlp) * 0.5;
        const y = p + cfg.runnerFb * c.rlp;
        c.runner.write(y);
        bankIn[c.bank] += y;
        if (c.iu < 1) {
          const tL = this.tIntake;
          const x = c.iu * TBL, k = x | 0;
          intake -= c.iamp * (tL[k] + (tL[k + 1] - tL[k]) * (x - k));
          c.iu += c.idu;
        }
      }

      // Overrun crackles: unburnt fuel lights off in the hot pipe a few milliseconds later.
      for (let k = this.crackles.length - 1; k >= 0; k--) {
        const q = this.crackles[k];
        if (--q.wait <= 0) {
          const ck = banks[q.bank].ck;
          ck.e1 = q.amp; ck.e2 = q.amp; ck.nz = q.amp * 1.3;
          this.crackles.splice(k, 1);
        }
      }

      // Bank pipes (Karplus-Strong style), then the shared rear section.
      let tailIn = 0;
      const rasp = 1 + cfg.rasp * (0.2 + load) * 3;
      const pa = cfg.pipeA, pb = cfg.pipeB, pfb = cfg.pipeFb;
      for (let b = 0; b < nb; b++) {
        const bk = banks[b], ck = bk.ck;
        ck.e1 *= this.cR; ck.e2 *= this.cF; ck.nz *= this.cN;
        bk.crack = (ck.e2 - ck.e1) + ck.nz * rnd();
        // Strong pulses steepen as they travel: soft saturation adds the rasp.
        const x = Math.tanh((bankIn[b] + bk.crack) * rasp) / Math.sqrt(rasp);
        const d = bk.pLen * ts;
        const back = pa * bk.pipe.read(d) + pb * bk.pipe.read(d + 1);
        const y = x + pfb * back;
        bk.pipe.write(y);
        bk.y = y; tailIn += y;
      }
      const td = this.tLen * ts;
      const tback = 0.5 * this.tail.read(td) + 0.42 * this.tail.read(td + 1);
      const tail = tailIn / nb + cfg.tail.fb * tback;
      this.tail.write(tail);

      let exL = 0, exR = 0;
      const tm = cfg.tail.mix, vm = this.vmix, cg = cfg.valve ? cfg.valve.closedGain : 1;
      for (let b = 0; b < nb; b++) {
        const bk = banks[b];
        const y = bk.y * (1 - tm) + tail * tm;
        let m = y * cfg.mufflerDirect;
        for (let j = 0; j < bk.muff.length; j++) m += bk.muff[j].f.run(y) * bk.muff[j].g;
        const closed = bk.closed.run(m) * cg;
        m = closed + (m - closed) * vm;
        m = bk.tone.run(m) + bk.crack * 0.3;
        exL += m * bk.gl; exR += m * bk.gr;
      }

      // Induction: plenum resonance plus roar through the intake runner.
      const it = cfg.intake, rn = rpm / rl;
      this.ilp += (this.irun.read(this.iLen * 1.2) - this.ilp) * 0.6;
      const iy = intake - 0.4 * this.ilp;
      this.irun.write(iy);
      this.env += (Math.abs(raw) - this.env) * 0.01;
      // Part throttle: air squeezing past a nearly closed throttle plate gives a faint hiss.
      const partOpen = load > 0.03 && !this.fuelCut ? Math.exp(-((load - 0.18) ** 2) / 0.02) : 0;
      const induction = this.plenum.run(iy) * 1.6 + this.roarBp.run(rnd()) * this.env * load * (0.2 + rn) * it.roar
        + this.hissBp.run(rnd()) * this.env * partOpen * (0.3 + rn) * (it.hiss ?? 0.05);

      // Engine block and valvetrain.
      const blk = this.blockLp2.run(this.blockLp.run(raw)) * cfg.blockGain;
      this.click *= this.dClick;
      const mech = this.clickHp.run(rnd()) * this.click + this.mechHp.run(rnd()) * this.env * rn * rn * cfg.mech.noise;

      let extra = 0, act = 0;
      if (cfg.turbo) {
        const tb = cfg.turbo;
        const wob = 1 + 0.004 * Math.sin(TAU * this.wob) + 0.002 * Math.sin(TAU * this.wob * 2.7);
        for (const sh of this.shafts) {
          sh.ph += sh.f * wob / sr;
          if (sh.ph > 1) sh.ph -= 1;
          // Blade-pass tone, its second harmonic, and the turbulent band around it.
          const tone = Math.sin(TAU * sh.ph) * 0.55 + Math.sin(2 * TAU * sh.ph) * 0.12 + sh.bp.run(rnd()) * 2.2;
          extra += tone * sh.s * sh.s * (0.3 + 0.7 * load) * tb.whineGain;
        }
        extra += this.hissHp.run(rnd()) * this.boost * load * tb.hissGain;
        if (this.bov > 0.001) {
          const env = this.bov * Math.exp(-this.bovT / 0.3);
          if (tb.bov === 'whoosh') extra += this.bovBp.run(rnd()) * env * tb.bovGain;
          else {
            this.fph += (24 - 12 * this.bovT) / sr;
            const chop = Math.max(0, Math.sin(TAU * this.fph));
            extra += this.flutterBp.run(rnd()) * env * chop * chop * chop * tb.bovGain;
          }
        }
      }
      if (cfg.gearWhine) {
        // Gear mesh tied to the input shaft, and the final drive tied to road speed.
        const gw = cfg.gearWhine, moving = clamp(this.speed / 8, 0, 1);
        this.gph += rpm / 60 * gw.teeth / sr; if (this.gph > 1) this.gph -= 1;
        this.dph += this.speed * gw.perMs / sr; if (this.dph > 1) this.dph -= 1;
        const gTone = Math.sin(TAU * this.gph) * 0.6 + this.gearBp.run(rnd()) * 2.5;
        const dTone = Math.sin(TAU * this.dph) * 0.6 + this.diffBp.run(rnd()) * 2.5;
        extra += (gTone * (0.35 + 0.65 * load) * gw.gain + dTone * gw.diffGain) * moving;
      }
      if (cfg.actuator && this.cabin && !this.fuelCut) {
        // Audi-style cabin sound actuator: reinforces the firing order through the body.
        this.aph += rpm / 60 * cyl.length / 2 / sr; if (this.aph > 1) this.aph -= 1;
        act = (Math.sin(TAU * this.aph) + 0.4 * Math.sin(2 * TAU * this.aph)) * cfg.actuator * Math.pow(load, 1.4) * clamp(rpm / 1500, 0, 1);
      }
      if (this.starter) {
        this.sph += cfg.starterHz / sr; if (this.sph > 1) this.sph -= 1;
        const rhythm = 0.55 + 0.45 * Math.cos(TAU * ph * cyl.length);
        extra += (Math.sin(TAU * this.sph) * 0.6 + Math.sin(TAU * this.sph * 2.03) * 0.3 + rnd() * 0.15) * rhythm * 0.06;
      }

      const ex = cfg.exhaustGain;
      let l, r;
      if (this.cabin) {
        // What a driver hears in a petrol car: the engine after it has come through the body.
        // The Tesla's own cabin supplies the room and the boom, so none is added here.
        const cb = cfg.cabin;
        const exM = (exL + exR) * 0.5 * ex, exS = (exL - exR) * 0.5 * ex;
        const airborne = exM * cb.exhaust + induction * cb.intake + mech * cb.mech + extra;
        this.tlM += (airborne - this.tlM) * this.kTL;          // −6 dB per octave above ~380 Hz
        this.tlS += (exS * cb.exhaust - this.tlS) * this.kTL;
        const through = this.tlM + this.leakM.run(airborne) * (cb.leak ?? 0.16); // glass and seals leak a little edge
        // Structure-borne: the block shakes the floor and seats. The actuator plays from speakers.
        const core = (through + blk * cb.block) * cfg.cabinGain + act;
        let cl = core + this.tlS * cfg.cabinGain, cr = core - this.tlS * cfg.cabinGain;
        for (const ap of this.apL) cl = ap.run(cl);
        for (const ap of this.apR) cr = ap.run(cr);
        l = cl; r = cr;
      } else {
        const mono = blk + induction + mech + extra + act;
        l = mono + exL * ex; r = mono + exR * ex;
      }
      // Outside only: a light, wide tail for the space around the car. Inside, the Tesla's cabin is the room.
      if (!this.cabin) {
        const scale = 3.2, fb = 0.6, mix = 0.08;
        const f = this.fdn, o = this.fdnOut;
        for (let i = 0; i < 4; i++) { f[i].lp += (f[i].d.read(f[i].base * scale) - f[i].lp) * 0.45; o[i] = f[i].lp; }
        const inp = (l + r) * 0.5;
        // Hadamard mix keeps the network lossless before the feedback gain.
        const h0 = o[0] + o[1] + o[2] + o[3], h1 = o[0] - o[1] + o[2] - o[3], h2 = o[0] + o[1] - o[2] - o[3], h3 = o[0] - o[1] - o[2] + o[3];
        f[0].d.write(inp + h0 * 0.5 * fb); f[1].d.write(inp + h1 * 0.5 * fb);
        f[2].d.write(inp + h2 * 0.5 * fb); f[3].d.write(inp + h3 * 0.5 * fb);
        l += (o[0] + o[2]) * mix; r += (o[1] + o[3]) * mix;
      }
      l = Math.tanh(l * cfg.drive); r = Math.tanh(r * cfg.drive);
      const d = this.dc; // DC blocker, ~20 Hz
      d.ly = l - d.lx + 0.9974 * d.ly; d.lx = l;
      d.ry = r - d.rx + 0.9974 * d.ry; d.rx = r;
      L[s] = d.ly * 0.85;
      R[s] = d.ry * 0.85;
    }
  }
}

if (typeof registerProcessor === 'function') {
  class EngineProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new EngineDSP(sampleRate);
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'config') this.dsp.configure(m.cfg);
        else if (m.type === 'params') this.dsp.setParams(m);
      };
    }
    process(_inputs, outputs) {
      const out = outputs[0];
      if (this.dsp.cfg && out.length) this.dsp.render(out[0], out[1] || new Float32Array(out[0].length), out[0].length);
      return true;
    }
  }
  registerProcessor('engine', EngineProcessor);
}

if (typeof module !== 'undefined') module.exports = { EngineDSP };
