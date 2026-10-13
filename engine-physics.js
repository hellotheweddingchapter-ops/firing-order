// Physical engine model.
//
// Every cylinder is simulated as a chamber of gas: the piston moves on its crank, the valves
// open on their cam profiles, air flows in from the intake plenum through the throttle, fuel
// burns over tens of degrees, and burnt gas blows down into the exhaust. The exhaust is a
// network of pipes simulated as travelling pressure waves (digital waveguides) that meet at
// junctions, pass through a silencer and leave through open tailpipes, which radiate.
//
// The sound is what leaves the tailpipes and the intake mouth, plus the block shaking from
// cylinder pressure. Nothing is shaped by hand: idle lope, throttle vacuum, overrun pumping and
// exhaust tuning all come from the simulation.
//
// Loaded into the AudioWorklet scope before engine-worklet.js; also usable from Node.

const PG = 1.35, PR = 287, PCV = PR / (PG - 1), PCP = PCV + PR, PATM = 101325, TAMB = 300;

// Isentropic orifice flow function psi(pressure ratio), tabulated.
const PSI_N = 2048, PSI = new Float32Array(PSI_N + 2);
{
  const crit = Math.pow(2 / (PG + 1), PG / (PG - 1));
  const choked = Math.sqrt(PG) * Math.pow(2 / (PG + 1), (PG + 1) / (2 * (PG - 1)));
  for (let i = 0; i <= PSI_N + 1; i++) {
    const pr = Math.min(1, i / PSI_N);
    PSI[i] = pr <= crit ? choked : Math.sqrt(Math.max(0, 2 * PG / (PG - 1) * (Math.pow(pr, 2 / PG) - Math.pow(pr, (PG + 1) / PG))));
  }
}
// Mass flow (kg/s) from side 1 to side 2 through effective area a (m²); negative when reversed.
function orifice(a, p1, t1, p2, t2) {
  if (a <= 0) return 0;
  if (p1 >= p2) {
    const x = p2 / p1 * PSI_N, i = x | 0;
    return a * p1 / Math.sqrt(PR * t1) * (PSI[i] + (PSI[i + 1] - PSI[i]) * (x - i));
  }
  const x = p1 / p2 * PSI_N, i = x | 0;
  return -a * p2 / Math.sqrt(PR * t2) * (PSI[i] + (PSI[i + 1] - PSI[i]) * (x - i));
}

class PDelay {
  constructor(max) { this.n = Math.ceil(max) + 4; this.buf = new Float32Array(this.n); this.w = 0; }
  write(x) { this.buf[this.w] = x; if (++this.w >= this.n) this.w = 0; }
  read(d) {
    let r = this.w - d; if (r < 0) r += this.n;
    const i = r | 0, f = r - i, j = i + 1 >= this.n ? 0 : i + 1;
    return this.buf[i] + (this.buf[j] - this.buf[i]) * f;
  }
}

// A pipe: right-going and left-going pressure waves (Pa, relative to ambient) with losses.
class Tube {
  constructor(len, diam, sr, o = {}) {
    this.A = Math.PI * diam * diam / 4;
    this.base = Math.max(1.5, len / 500 * sr); // delay in samples at c = 500 m/s; scaled by gas temperature
    const max = this.base * 1.7 + 4;
    this.f = new PDelay(max); this.b = new PDelay(max);
    this.loss = o.loss ?? Math.exp(-len * (0.05 + 0.0015 / diam)); // friction and heat transfer per pass
    this.lp = o.lp ?? 0.8;                                         // high-frequency damping per pass
    this.valve = !!o.valve; this.open = 1;
    this.lf = 0; this.lb = 0; this.aEnd = 0; this.aStart = 0; this.oEnd = 0; this.oStart = 0; this.pStart = 0; this.rl = 0;
  }
  arrive(scale) {
    const d = this.base * scale;
    this.lf += (this.f.read(d) - this.lf) * this.lp; this.lb += (this.b.read(d) - this.lb) * this.lp;
    this.aEnd = this.lf * this.loss; this.aStart = this.lb * this.loss;
  }
  commit() { this.f.write(this.oStart); this.b.write(this.oEnd); }
  get Aeff() { return this.valve ? this.A * (0.04 + 0.96 * this.open) : this.A; }
}

// Pipes meeting at a point: pressure is shared, flows add up (area-weighted scattering).
class Junction {
  constructor(ends) { this.ends = ends; this.src = 0; }
  solve() {
    let sA = 0, sAa = 0;
    for (const [t, side] of this.ends) { const A = t.Aeff, a = side ? t.aEnd : t.aStart; sA += A; sAa += A * a; }
    const pJ = 2 * sAa / sA + this.src;
    for (const [t, side] of this.ends) { if (side) t.oEnd = pJ - t.aEnd; else t.oStart = pJ - t.aStart; }
    this.src = 0;
  }
}

const deg = (x) => ((x % 720) + 720) % 720;

class PhysCore {
  // spec: geometry and cams (see engines.js `physics`); firing: [{deg, bank}].
  constructor(spec, firing, sr) {
    this.sr = sr; this.spec = spec;
    const S = spec, nc = firing.length;
    const bore = S.bore, stroke = S.stroke, rod = S.rod ?? stroke * 1.65;
    this.Ap = Math.PI * bore * bore / 4;
    const Vd = this.Ap * stroke, Vc = Vd / (S.cr - 1), rc = stroke / 2;
    // Tables over 720° at quarter-degree steps: volume and the two valves' flow areas.
    const NT = 2880; this.NT = NT;
    this.V = new Float32Array(NT + 1); this.Ai = new Float32Array(NT + 1); this.Ae = new Float32Array(NT + 1);
    const lift = (th, open, close, Lmax) => {
      const o = deg(open), dur = deg(close - open), x = deg(th - o);
      return x < dur ? Lmax * Math.sin(Math.PI * x / dur) ** 2 : 0;
    };
    const curtain = (L, d, n) => Math.min(n * Math.PI * d * L, n * Math.PI * d * d / 4 * 0.85) * 0.68;
    const c = S.cam;
    for (let k = 0; k <= NT; k++) {
      const th = k / 4, a = th * Math.PI / 180;
      const s = rc * (1 - Math.cos(a)) + rod - Math.sqrt(rod * rod - (rc * Math.sin(a)) ** 2);
      this.V[k] = Vc + this.Ap * s;
      // Firing TDC at 0°: exhaust stroke 180-360, intake 360-540.
      this.Ae[k] = curtain(lift(th, 180 - c.evo, 360 + c.evc, c.lift), S.exValve, S.valves / 2);
      this.Ai[k] = curtain(lift(th, 360 - c.ivo, 540 + c.ivc, c.lift), S.inValve, S.valves / 2);
    }
    this.ivcDeg = deg(540 + c.ivc);
    this.cyl = firing.map((f, i) => ({
      off: f.deg, bank: f.bank || 0, m: PATM * this.V[0] / (PR * TAMB), T: TAMB, prev: 0,
      Q: 0, burnPrev: 0, xb: 0, spark: 0, burn: 50, pk: 0, q: 0,
    }));
    // Intake plenum and throttle.
    this.Vp = S.plenum; this.pPl = PATM; this.mPl = PATM * this.Vp / (PR * TAMB); this.Ath = 1e-4;
    this.AthMax = S.throttle;
    // Exhaust network.
    this.buildExhaust(S.exhaust, firing);
    // Intake snorkel: the induction roar radiates from its mouth.
    this.snorkel = new Tube(S.intakeLen ?? 0.5, S.intakeDiam ?? 0.08, sr, { lp: 0.7 });
    this.snQ = 0; this.mth = 0; this.mthPrev = 0;
    this.texScale = 1; this.rho = 0.4; this.cGas = 550;
    this.blockHp = 0; this.forcePrev = 0;
  }

  buildExhaust(X, firing) {
    const sr = this.sr, T = (l, d, o) => { const t = new Tube(l, d, sr, o); this.tubes.push(t); return t; };
    this.tubes = []; this.junctions = []; this.ports = []; this.tails = [];
    const banks = [...new Set(firing.map((f) => f.bank || 0))];
    const bankOut = {};
    for (const b of banks) {
      const members = firing.map((f, i) => [f, i]).filter(([f]) => (f.bank || 0) === b);
      const runners = members.map(([f, i], k) => {
        const t = T(X.runner * (1 + (X.runnerSpread ?? 0.08) * Math.sin(i * 2.3 + b)), X.runnerD);
        this.ports[i] = t;
        return t;
      });
      let last;
      if (X.pairs && runners.length === 4) {
        // 4-2-1: cylinders 180° apart share a secondary, then the secondaries merge.
        const s1 = T(X.secondary, X.secondaryD), s2 = T(X.secondary, X.secondaryD);
        this.junctions.push(new Junction([[runners[0], 1], [runners[2], 1], [s1, 0]]));
        this.junctions.push(new Junction([[runners[1], 1], [runners[3], 1], [s2, 0]]));
        last = T(X.collector, X.collectorD);
        this.junctions.push(new Junction([[s1, 1], [s2, 1], [last, 0]]));
      } else {
        last = T(X.collector, X.collectorD);
        this.junctions.push(new Junction([...runners.map((r) => [r, 1]), [last, 0]]));
      }
      if (X.turbine) {
        // The turbine is a hard restriction that soaks up the sharp edges of each pulse.
        const tu = T(0.08, X.turbine, { loss: 0.75, lp: 0.35 }), dp = T(X.downpipe, X.collectorD);
        this.junctions.push(new Junction([[last, 1], [tu, 0]]));
        this.junctions.push(new Junction([[tu, 1], [dp, 0]]));
        last = dp;
      }
      bankOut[b] = { t: last, bank: b };
      this.bankJ = this.bankJ || [];
      this.bankJ[b] = this.junctions.find((j) => j.ends.some(([t, s]) => t === bankOut[b].t && s === 0)) || this.junctions[this.junctions.length - 1];
    }
    const silencer = (inT, pan) => {
      // Straight-through box with a bypass valve, then a tailpipe that radiates.
      const box = T(X.box, X.boxD, { lp: X.boxLp ?? 0.55, loss: 0.9 }), by = T(X.box, X.tailD, { valve: true });
      this.junctions.push(new Junction([[inT, 1], [box, 0], [by, 0]]));
      for (let k = 0; k < (X.tips ?? 1); k++) {
        const tail = T(X.tail * (1 + 0.07 * k), X.tailD, { lp: 0.9 });
        this.tails.push({ t: tail, pan, rl: 0, q: 0 });
      }
      const outs = this.tails.slice(-(X.tips ?? 1)).map((x) => [x.t, 0]);
      this.junctions.push(new Junction([[box, 1], [by, 1], ...outs]));
      this.bypass = this.bypass || []; this.bypass.push(by);
    };
    const outs = Object.values(bankOut);
    if (outs.length > 1 && X.merge) {
      const mid = T(X.mid, X.midD);
      this.junctions.push(new Junction([...outs.map((o) => [o.t, 1]), [mid, 0]]));
      silencer(mid, 0);
    } else {
      outs.forEach((o, k) => {
        const mid = T(X.mid, X.midD);
        this.junctions.push(new Junction([[o.t, 1], [mid, 0]]));
        silencer(mid, outs.length > 1 ? (k ? 0.5 : -0.5) : 0);
      });
    }
  }

  // Exhaust gas temperature sets the speed of sound in every pipe.
  setGas(texK) {
    const T = Math.max(350, texK);
    this.cGas = Math.sqrt(PG * PR * T);
    this.texScale = 500 / this.cGas;
    this.rho = PATM / (PR * T);
    this.Tex = T;
  }

  // One audio sample. phase: crank position as a fraction of the 720° cycle.
  // Returns { l, r, intake, block } in pascals (relative), scaled later.
  step(phase0, dph, rpm, load, fuelCut, boost, valveOpen, jitter, rnd) {
    const S = this.spec, sr = this.sr, sub = 2, dt = 1 / (sr * sub);
    const pSrc = PATM * (1 + boost);
    // Throttle: a fast controller holds the manifold pressure the pedal asks for.
    // Pedal to manifold pressure: light cruise sits deep in vacuum (about 0.3-0.45 bar), full
    // throttle at atmosphere or boost. Near idle revs the cams set it: big overlap idles lumpy.
    const base = S.cruiseMap ?? 0.28, nearIdle = Math.max(0, 1 - (rpm - (S.idleRpm ?? 900)) / 600);
    let pT = PATM * (base + (pSrc / PATM * 0.97 - base) * Math.pow(load, 1.1));
    pT = Math.max(pT, PATM * (S.idleMap ?? 0.4) * nearIdle);
    if (fuelCut) pT = PATM * (S.overrunMap ?? 0.3);
    this.Ath *= Math.exp(Math.max(-0.02, Math.min(0.02, (pT - this.pPl) / PATM * 0.03)));
    this.Ath = Math.min(this.AthMax, Math.max(S.idleArea ?? 4e-5, this.Ath));
    const Tpl = TAMB + 60 * boost;
    for (const b of this.bypass) b.open = valveOpen;

    // Pressure at each exhaust port from last sample's waves.
    const nc = this.cyl.length, rn = rpm / S.redline;
    let mIn = 0, force = 0;
    const ex = this.exFlow || (this.exFlow = new Float32Array(nc));
    ex.fill(0);
    for (let s = 0; s < sub; s++) {
      const ph = phase0 + dph * (s + 1) / sub;
      let pPl = this.mPl * PR * Tpl / this.Vp;
      for (let i = 0; i < nc; i++) {
        const c = this.cyl[i];
        const th = deg(ph * 720 - c.off), k = th * 4, k0 = k | 0, fr = k - k0;
        const V = this.V[k0] + (this.V[k0 + 1] - this.V[k0]) * fr;
        const Ai = this.Ai[k0] + (this.Ai[k0 + 1] - this.Ai[k0]) * fr;
        const Ae = this.Ae[k0] + (this.Ae[k0 + 1] - this.Ae[k0]) * fr;
        if (c.Vprev === undefined) { c.Vprev = V; c.m = PATM * V / (PR * TAMB); c.prev = th; } // start at ambient, wherever the piston is
        const dV = V - c.Vprev; c.Vprev = V;
        const p = c.m * PR * c.T / V;
        const mi = Ai > 0 ? orifice(Ai, pPl, Tpl, p, c.T) : 0;
        const me = Ae > 0 ? this.portFlow(Ae, p, c.T, this.ports[i]) : 0;
        // Intake valve closing: the charge is trapped, fuel is metered, spark is set.
        const prevTh = c.prev; c.prev = th;
        if ((prevTh < this.ivcDeg && th >= this.ivcDeg) || (prevTh > th && this.ivcDeg < th)) {
          const air = c.m * (1 - (S.residual ?? 0.07));
          const lam = load > 0.8 ? 0.88 : 1;
          c.Q = fuelCut ? 0 : air / (14.7 * lam) * 43e6 * 0.92 * (1 + jitter * rnd());
          c.spark = 720 - (S.spark ?? 18) - 14 * rn + 5 * load;
          c.burn = (S.burn ?? 45) + 22 * rn;
          c.xb = 0;
        }
        // Combustion: Wiebe burn curve after the spark.
        let dQ = 0;
        if (c.Q > 0) {
          const phi = deg(th - c.spark);
          if (phi < c.burn) {
            const xb = 1 - Math.exp(-5 * (phi / c.burn) ** 3);
            if (xb > c.xb) { dQ = c.Q * (xb - c.xb); c.xb = xb; }
          } else if (c.xb > 0) { dQ = c.Q * (1 - c.xb); c.Q = 0; c.xb = 0; }
        }
        // Energy balance: flows carry enthalpy, the piston does work, the walls take heat.
        const hin = mi > 0 ? PCP * Tpl : PCP * c.T, hout = me > 0 ? PCP * c.T : PCP * this.Tex;
        const loss = (S.heatLoss ?? 30) * c.m * PCV * (c.T - 420) * dt;
        let U = c.m * PCV * c.T + (hin * mi - hout * me) * dt - p * dV + dQ - loss;
        c.m = Math.max(1e-7, c.m + (mi - me) * dt);
        c.T = Math.min(3200, Math.max(220, U / (c.m * PCV)));
        mIn += mi; ex[i] += me / sub;
        force += (c.m * PR * c.T / V - PATM);
      }
      // Plenum: fed by the throttle, drained by the cylinders. Solved implicitly for the new
      // pressure, because big throttle bodies make the plenum react faster than one step.
      const pSn = pSrc, k = PR * Tpl / this.Vp * dt; // intake roar is radiated one-way: it does not feed back
      const p0 = this.mPl * PR * Tpl / this.Vp, Ath = this.Ath * 0.8;
      const h = (pn) => pn - p0 - k * (orifice(Ath, pSn, TAMB, pn, Tpl) - mIn);
      // Safeguarded Newton from the current pressure: each step changes it by only a few pascals,
      // so the solve has to be precise, not just bracketed.
      let lo = 2000, hi = Math.max(pSn, p0) * 1.05 + 1000, x = p0;
      for (let it = 0; it < 8; it++) {
        const hx = h(x);
        if (Math.abs(hx) < 0.01) break;
        if (hx > 0) hi = x; else lo = x;
        const d = (h(x + 1) - hx);
        let nx = d > 0 ? x - hx / d : (lo + hi) / 2;
        if (!(nx > lo && nx < hi)) nx = (lo + hi) / 2;
        x = nx;
      }
      this.pPl = x;
      this.mth = orifice(Ath, pSn, TAMB, this.pPl, Tpl);
      this.mPl = this.pPl * this.Vp / (PR * Tpl);
      mIn = 0;
    }

    // Exhaust waves.
    const sc = this.texScale, cg = this.cGas;
    for (const t of this.tubes) t.arrive(sc);
    this.snorkel.arrive(500 / 347); // cold intake air: slower sound
    for (let i = 0; i < nc; i++) {
      // Port: closed valve reflects; flow out of the cylinder launches a pressure wave c·ṁ/A.
      const t = this.ports[i];
      t.oStart = t.aStart + cg * ex[i] / t.A; // p = rho·c·u with u = mdot/(rho·A)
      t.pStart = t.aStart + t.oStart;
    }
    for (const j of this.junctions) j.solve();
    let l = 0, r = 0;
    for (const tl of this.tails) {
      // Open end: low frequencies reflect inverted, high frequencies escape and radiate.
      const t = tl.t, a = t.aEnd;
      tl.rl += (a - tl.rl) * 0.35;
      t.oEnd = -0.97 * tl.rl;
      const q = (a - t.oEnd) * t.A, rad = q - tl.q; tl.q = q;
      l += rad * (1 - tl.pan * 0.6); r += rad * (1 + tl.pan * 0.6);
    }
    for (const t of this.tubes) t.commit();
    // Intake: throttle flow drawn out of the snorkel, roar radiated at its mouth.
    const sn = this.snorkel, cin = 347;
    sn.oStart = sn.aStart - cin * this.mth / (1.18 * sn.A);
    sn.pStart = sn.aStart + sn.oStart;
    sn.rl += (sn.aEnd - sn.rl) * 0.35;
    sn.oEnd = -0.97 * sn.rl;
    const qi = (sn.aEnd - sn.oEnd) * sn.A, intake = qi - this.snQ; this.snQ = qi;
    sn.commit();
    // Block: the piston force shakes the engine; keep the vibration, drop the static part.
    force = force / sub * this.Ap;
    this.blockHp += (force - this.blockHp) * 0.002;
    const block = force - this.blockHp;
    return { l, r, intake, block, map: this.pPl / PATM };
  }

  // Flow out through an exhaust valve, solved together with the pressure it raises in the pipe:
  // port pressure = ambient + 2·(arriving wave) + (c/A)·flow. Flow falls as port pressure rises,
  // so bisection on the flow always converges, however violent the blowdown.
  portFlow(Ae, p, T, port) {
    const base = PATM + 2 * port.aStart, Zc = this.cGas / port.A;
    const g = (m) => m - orifice(Ae, p, T, Math.max(5000, base + Zc * m), this.Tex);
    const cap = Ae * Math.max(p, base) / Math.sqrt(PR * 250) * 0.7 + 1e-6;
    let lo = -cap, hi = cap, glo = g(lo), ghi = g(hi);
    if (glo > 0) return lo; if (ghi < 0) return hi;
    for (let k = 0; k < 7; k++) {
      // False position with a bisection guard.
      let m = (lo * ghi - hi * glo) / (ghi - glo);
      if (!(m > lo && m < hi) || k % 3 === 2) m = (lo + hi) / 2;
      const gm = g(m);
      if (gm > 0) { hi = m; ghi = gm; } else { lo = m; glo = gm; }
    }
    return (lo * ghi - hi * glo) / (ghi - glo);
  }

  // Overrun crackle: a pressure kick at a bank's collector.
  crack(bank, p) { const j = this.bankJ[bank] || this.bankJ[0]; if (j) j.src += p; }
}

if (typeof globalThis !== 'undefined') globalThis.PhysCore = PhysCore;
if (typeof module !== 'undefined') module.exports = { PhysCore };
