// The Tesla side of the model: what the car is doing, read from speed alone, and what a
// combustion engine would have to do to match it. No access to the pedal: everything here is
// inferred from GPS speed, so the filtering decides how the sound feels.

const TESLA = {
  // a0: launch acceleration (m/s²). pm: usable power per kg (W/kg), which caps acceleration at speed.
  variants: {
    rwd:  { a0: 5.2, pm: 115 },
    lr:   { a0: 6.6, pm: 150 },
    perf: { a0: 9.0, pm: 215 },
  },
  // Chill caps acceleration at roughly half. Flooring it in Chill is still the driver asking for everything.
  aMax(v, variant, chill) {
    const t = TESLA.variants[variant] || TESLA.variants.lr;
    return Math.min(t.a0, t.pm / Math.max(v, 1)) * (chill ? 0.5 : 1);
  },
  // Road load: rolling resistance plus aero, as deceleration (m/s²) when coasting.
  drag: (v) => 0.15 + 0.00045 * v * v,
  // Lifting off: standard regen pulls up to about 0.2 g and fades out at walking pace.
  regen: (v) => 1.8 * Math.min(1, Math.max(0, (v - 0.5) / 4)),
};

const clampN = (x, a, b) => (x < a ? a : x > b ? b : x);

// Constant-acceleration Kalman filter on speed. Works at any fix rate (1 Hz or 10 Hz) because
// the process noise scales with the time between updates.
class SpeedFilter {
  constructor(q = 6, adaptive = true) { this.q = q; this.adaptive = adaptive; this.reset(); }
  reset() { this.v = 0; this.a = 0; this.aS = 0; this.P = [4, 0, 4]; this.init = false; this.sinceFix = 1e9; this.nv = null; }
  predict(dt) {
    this.sinceFix += dt;
    // No fixes for a while (tunnel, car park): hold speed and let acceleration relax to zero.
    if (this.sinceFix > 1.5) this.a *= Math.exp(-dt / 0.6);
    this.v = Math.max(0, this.v + this.a * dt);
    const [p00, p01, p11] = this.P, q = this.q;
    this.P = [
      p00 + dt * 2 * p01 + dt * dt * p11 + q * dt * dt * dt / 3,
      p01 + dt * p11 + q * dt * dt / 2,
      p11 + q * dt,
    ];
    this.aS += (this.a - this.aS) * Math.min(1, dt / 0.12);
  }
  // z: measured speed (m/s). r: its variance as a starting guess. The filter then learns how
  // noisy the car's speed really is from its own prediction errors, and trusts it accordingly.
  measure(z, r = 0.04) {
    this.sinceFix = 0;
    if (!this.init) { this.v = z; this.init = true; return; }
    const [p00, p01, p11] = this.P, y = z - this.v;
    if (this.adaptive) {
      if (this.nv === null) this.nv = r;
      if (z > 1) this.nv += (Math.max(y * y - p00, 0) - this.nv) * 0.02; // only while moving: parked speed reads a clean zero
      r = clampN(this.nv, 0.0004, 1);
    }
    this.r = r;
    const s = p00 + r, k0 = p00 / s, k1 = p01 / s;
    this.v = Math.max(0, this.v + k0 * y);
    this.a = clampN(this.a + k1 * y, -12, 12);
    this.P = [(1 - k0) * p00, (1 - k0) * p01, p11 - k1 * p01];
  }
  get lost() { return this.sinceFix > 1.5; }
}

// Turns speed and acceleration into engine load, the way a petrol car's throttle would sit.
class LoadInference {
  constructor() { this.reset(); }
  reset() { this.load = 0; this.overrun = false; this.dwell = 0; this.aSlow = 0; }
  update(v, a, dt, aMax, drag) {
    const net = a + drag; // what the engine must supply, beyond holding speed
    // Lift-off is judged on a slower reading, so GPS noise in town can't flick the engine in and out of overrun.
    this.aSlow += (a - this.aSlow) * Math.min(1, dt / 0.3);
    const netSlow = this.aSlow + drag;
    let target;
    this.dwell += dt;
    if (v < 2 && this.aSlow > -0.6 && a < 0.5) {
      // Standing or creeping: below walking pace the clutch is open, so the engine just idles.
      target = 0.06;
      if (this.overrun) { this.overrun = false; this.dwell = 0; }
    } else {
      // Decelerating harder than the car would coast means the driver lifted: closed throttle.
      const want = this.overrun ? netSlow < -0.1 : netSlow < -0.4;
      if (want !== this.overrun && this.dwell > 0.4) { this.overrun = want; this.dwell = 0; }
      target = this.overrun ? 0 : clampN(0.08 + 0.92 * Math.pow(Math.max(net, 0) / aMax, 0.85), 0.05, 1);
    }
    // Steady at cruise, quick when the pedal really moves: GPS noise mustn't wobble the sound.
    const dl = Math.abs(target - this.load);
    const tau = 0.6 + (0.06 - 0.6) * clampN(dl / 0.15, 0, 1);
    this.load += (target - this.load) * Math.min(1, dt / tau);
    return { load: this.load, overrun: this.overrun };
  }
}

// A 90-second drive with the accelerations a Tesla really makes: town, lights, a motorway with
// cruise control, an overtake, a slip road and a roundabout.
const TEST_DRIVE = [
  { label: 'Waiting at the lights', hold: 3 },
  { label: 'Pulling away', to: 50, a: 1.7 },
  { label: 'Town at 50', hold: 8, wobble: 0.2 },
  { label: 'Braking for lights', to: 0, a: -2.0 },
  { label: 'Waiting', hold: 3 },
  { label: 'Joining the motorway', to: 112, a: 'max' },
  { label: 'Cruise control at 110', to: 110, a: -0.4 },
  { label: 'Cruise control at 110', hold: 12, wobble: 0.12 },
  { label: 'Overtaking', to: 135, a: 'max' },
  { label: 'Settling at 120', to: 120, a: -0.7 },
  { label: 'Cruising at 120', hold: 6, wobble: 0.12 },
  { label: 'Slip road', to: 60, a: -1.5 },
  { label: 'Roundabout', to: 30, a: -2.2 },
  { label: 'Out of the roundabout', to: 55, a: 2.2 },
  { label: 'Town at 50', to: 50, a: -0.5 },
  { label: 'Town at 50', hold: 5, wobble: 0.2 },
  { label: 'Stopping', to: 0, a: -1.8 },
  { label: 'Parked', hold: 3 },
];

class TestDrive {
  constructor(script = TEST_DRIVE) { this.s = script; this.i = 0; this.t = 0; this.acc = 0; this.done = false; }
  get label() { return this.done ? 'Finished' : this.s[this.i].label; }
  // Returns the acceleration the car makes this step (m/s²).
  step(dt, v, aMax) {
    if (this.done) return 0;
    const seg = this.s[this.i];
    this.t += dt;
    let want = 0, next = false;
    if (seg.hold != null) {
      if (seg.wobble) want = seg.wobble * (Math.sin(this.t * 0.9) + 0.5 * Math.sin(this.t * 2.3 + 1));
      if (this.t >= seg.hold) next = true;
    } else {
      const dv = seg.to / 3.6 - v, mag = seg.a === 'max' ? aMax * 0.97 : Math.abs(seg.a);
      want = Math.sign(dv) * mag * clampN(Math.abs(dv) / 2.5, 0.25, 1);
      if (Math.abs(dv) < 0.2 || (seg.to === 0 && v < 0.05)) next = true;
    }
    // A foot, not a switch: acceleration builds over a few tenths of a second.
    this.acc += (want - this.acc) * Math.min(1, dt / 0.35);
    if (seg.to === 0 && v < 0.05 && this.acc < 0) this.acc = 0;
    if (next) { this.i++; this.t = 0; if (this.i >= this.s.length) this.done = true; }
    return this.acc;
  }
}

if (typeof module !== 'undefined') module.exports = { TESLA, SpeedFilter, LoadInference, TestDrive, TEST_DRIVE };
