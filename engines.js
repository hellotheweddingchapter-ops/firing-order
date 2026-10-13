// Engine definitions. Top level: drivetrain for the gearbox model. `sound`: the synthesis.
// Firing angles are crank degrees in the 720° four-stroke cycle, listed in firing order.
// Pipe and runner lengths are delays in ms at 700 K exhaust gas temperature.
// Ratios marked "approx." could not be confirmed from a published source.
// Car names describe the simulated sound; there is no affiliation with the manufacturers.

const ENGINES = {
  gt3: {
    name: 'Porsche 911 GT3', badge: 'GT3', layout: 'F6',
    spec: '4.0 flat-six · naturally aspirated · 9,000 rpm',
    firingOrder: '1-6-2-4-3-5',
    note: 'Alternates banks every 120°. Hard, metallic, and most of the howl comes from the intake, whose resonance flaps switch near 5,600 rpm.',
    idle: 900, redline: 9000, limiter: 9000, limiterHz: 16,
    gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], final: 4.35, tireR: 0.35, // approx.
    shiftMs: 90, revTau: [0.045, 0.075], flare: 1100,
    upshiftCrack: 0.15, downshiftCrack: 0.1,
    sound: {
      // Physical build (engine-physics.js): metres, m², m³ and crank degrees.
      physics: {"redline":9000,"bore":0.102,"stroke":0.0815,"cr":13.3,"valves":4,"inValve":0.042,"exValve":0.035,"cam":{"ivo":40,"ivc":75,"evo":70,"evc":40,"lift":0.0125},"plenum":0.006,"throttle":0.0108,"idleArea":0.000016,"idleMap":0.5,"exhaust":{"runner":0.4,"runnerD":0.04,"collector":0.25,"collectorD":0.06,"merge":true,"mid":0.6,"midD":0.07,"box":0.35,"boxD":0.14,"tail":0.25,"tailD":0.075,"tips":2},"gain":{"exhaust":0.1,"intake":0.25,"block":0.000004},"crackPa":12000},
      idle: 900, redline: 9000,
      firing: [
        { deg: 0,   bank: 0, runnerMs: 0.86, gain: 1.00 }, // 1
        { deg: 120, bank: 1, runnerMs: 0.92, gain: 0.98 }, // 6
        { deg: 240, bank: 0, runnerMs: 0.90, gain: 1.02 }, // 2
        { deg: 360, bank: 1, runnerMs: 0.84, gain: 0.99 }, // 4
        { deg: 480, bank: 0, runnerMs: 0.95, gain: 1.01 }, // 3
        { deg: 600, bank: 1, runnerMs: 0.88, gain: 0.98 }, // 5
      ],
      banks: [{ pipeMs: 4.2, pan: -0.3 }, { pipeMs: 4.5, pan: 0.3 }],
      pulse: { spanDeg: 140, minMs: 0.9, maxMs: 6, attack: 70, decay: 6, nu: 0.75, lambdaLight: 1.0, lambdaFull: 0.28 },
      runnerFb: -0.35, pipeFb: -0.55, pipeA: 0.55, pipeB: 0.4,
      tail: { ms: 6.5, fb: -0.45, mix: 0.35 },
      muffler: [{ f: 160, q: 1.2, g: 0.8 }, { f: 520, q: 1.8, g: 0.6 }, { f: 1400, q: 1.4, g: 0.4 }],
      mufflerDirect: 0.5,
      valve: null, // straight-through: nothing closes
      tone: { base: 1200, load: 4000, rpm: 0.45 },
      dyn: 1.75, rasp: 0.25,
      intake: { gain: 0.9, hz: 520, q: 1.6, runnerMs: 1.6, flapRpm: 5600, flapHz: 780, roar: 0.35 },
      mech: { click: 0.12, noise: 0.06 },
      turbo: null,
      timingJitterDeg: 0.6, overrunAir: 0.18, cabin: { exhaust: 0.9, intake: 1.5, mech: 1.2, block: 1.1 , leak: 0.35 }, cabinGain: 1.4, crackle: 0.15, jitter: 0.025, turb: 0.15, noise: 0.15,
      blockHz: 160, blockGain: 0.7, exhaustGain: 1.55, drive: 1.2, starterHz: 420,
    },
  },

  gtr: {
    name: 'Nissan GT-R', badge: 'GT-R', layout: 'V6 TT',
    spec: '3.8 twin-turbo V6 · VR38DETT · 7,000 rpm',
    firingOrder: 'R1-L1-R2-L2-R3-L3',
    note: 'A 60° V6 with a turbo on each bank. The turbines soak up the sharp edges, so it sounds dark and raspy, with turbo whistle and the whine of the rear transaxle on top.',
    idle: 800, redline: 7000, limiter: 7100, limiterHz: 11,
    gears: [4.056, 2.301, 1.595, 1.248, 1.001, 0.796], final: 3.7, tireR: 0.35,
    shiftMs: 160, revTau: [0.09, 0.14], flare: 700,
    upshiftCrack: 0.05, downshiftCrack: 0.03,
    sound: {
      // Physical build (engine-physics.js): metres, m², m³ and crank degrees.
      physics: {"redline":7000,"bore":0.0955,"stroke":0.0884,"cr":9,"valves":4,"inValve":0.037,"exValve":0.032,"cam":{"ivo":15,"ivc":55,"evo":55,"evc":15,"lift":0.0105},"plenum":0.007,"throttle":0.0057,"idleArea":0.000012,"idleMap":0.45,"exhaust":{"runner":0.25,"runnerD":0.038,"collector":0.12,"collectorD":0.055,"turbine":0.045,"downpipe":0.7,"merge":true,"mid":1.2,"midD":0.08,"box":0.5,"boxD":0.16,"tail":0.3,"tailD":0.08,"tips":2},"gain":{"exhaust":0.2,"intake":0.25,"block":0.000004},"crackPa":12000},
      idle: 800, redline: 7000,
      firing: [
        { deg: 0,   bank: 0, runnerMs: 1.30, gain: 1.00 },
        { deg: 120, bank: 1, runnerMs: 1.42, gain: 0.97 },
        { deg: 240, bank: 0, runnerMs: 1.36, gain: 1.03 },
        { deg: 360, bank: 1, runnerMs: 1.25, gain: 0.99 },
        { deg: 480, bank: 0, runnerMs: 1.48, gain: 1.02 },
        { deg: 600, bank: 1, runnerMs: 1.33, gain: 0.97 },
      ],
      banks: [{ pipeMs: 8.5, pan: -0.25 }, { pipeMs: 9.1, pan: 0.25 }],
      pulse: { spanDeg: 170, minMs: 1.4, maxMs: 8, attack: 45, decay: 5, nu: 0.85, lambdaLight: 1.4, lambdaFull: 0.7 },
      runnerFb: -0.3, pipeFb: -0.6, pipeA: 0.5, pipeB: 0.42,
      tail: { ms: 11, fb: -0.5, mix: 0.45 },
      muffler: [{ f: 90, q: 1.2, g: 1.0 }, { f: 300, q: 1.6, g: 0.6 }, { f: 800, q: 1.4, g: 0.3 }],
      mufflerDirect: 0.3,
      valve: null, // straight-through: nothing closes
      tone: { base: 600, load: 2200, rpm: 0.25 },
      rasp: 0.45,
      intake: { gain: 0.15, hz: 400, q: 1.2, runnerMs: 2.2, flapRpm: 1e9, flapHz: 400, roar: 0.1 },
      mech: { click: 0.05, noise: 0.05 },
      turbo: { maxBar: 1, count: 2, spoolRpm: 2400, lag: 0.55, whineBase: 2600, whineSpan: 7000, whineGain: 0.03, hissGain: 0.07, bov: 'whoosh', bovGain: 0.35 },
      gearWhine: { teeth: 29, gain: 0.012, perMs: 38, diffGain: 0.008 },
      timingJitterDeg: 0.8, overrunAir: 0.22, cabin: { exhaust: 1.0, intake: 0.6, mech: 0.5, block: 1.3 , leak: 0.35 }, cabinGain: 1.15, crackle: 0.12, jitter: 0.03, turb: 0.25, noise: 0.3,
      blockHz: 150, blockGain: 0.9, exhaustGain: 1.0, drive: 1.2, starterHz: 380,
    },
  },

  s3: {
    name: 'Audi S3', badge: 'S3', layout: 'I4 T',
    spec: '2.0 TFSI turbo four · EA888 · 6,500 rpm',
    firingOrder: '1-3-4-2',
    note: 'An even four-cylinder: buzzy, with cabin boom in the mid-range. A deliberate ignition cut on each upshift makes the S tronic crack, and a cabin actuator thickens the note.',
    idle: 750, redline: 6500, limiter: 6700, limiterHz: 10,
    gears: [3.4, 2.75, 1.77, 1.22, 0.93, 0.75, 0.63], final: 3.94, tireR: 0.33, // approx.
    shiftMs: 100, revTau: [0.07, 0.11], flare: 900,
    upshiftCrack: 0.75, downshiftCrack: 0.15,
    sound: {
      // Physical build (engine-physics.js): metres, m², m³ and crank degrees.
      physics: {"redline":6500,"bore":0.0825,"stroke":0.0928,"cr":9.3,"valves":4,"inValve":0.034,"exValve":0.028,"cam":{"ivo":12,"ivc":45,"evo":50,"evc":12,"lift":0.0105},"plenum":0.004,"throttle":0.0028,"idleArea":0.000008,"idleMap":0.42,"exhaust":{"runner":0.15,"runnerD":0.036,"collector":0.1,"collectorD":0.05,"turbine":0.042,"downpipe":0.6,"mid":2,"midD":0.07,"box":0.5,"boxD":0.14,"tail":0.3,"tailD":0.075,"tips":2},"gain":{"exhaust":0.1,"intake":0.25,"block":0.000004},"crackPa":12000},
      idle: 750, redline: 6500,
      firing: [
        { deg: 0,   runnerMs: 1.20, gain: 1.00 }, // 1
        { deg: 180, runnerMs: 1.35, gain: 0.97 }, // 3
        { deg: 360, runnerMs: 1.30, gain: 1.03 }, // 4
        { deg: 540, runnerMs: 1.15, gain: 0.99 }, // 2
      ],
      banks: [{ pipeMs: 7.8, pan: 0 }],
      pulse: { spanDeg: 160, minMs: 1.2, maxMs: 7, attack: 55, decay: 5.5, nu: 0.8, lambdaLight: 1.2, lambdaFull: 0.5 },
      runnerFb: -0.4, pipeFb: -0.6, pipeA: 0.5, pipeB: 0.42,
      tail: { ms: 10, fb: -0.5, mix: 0.4 },
      muffler: [{ f: 85, q: 1.3, g: 1.1 }, { f: 260, q: 2.0, g: 0.6 }, { f: 700, q: 1.5, g: 0.3 }],
      mufflerDirect: 0.35,
      valve: null, // straight-through: nothing closes
      tone: { base: 700, load: 2600, rpm: 0.3 },
      rasp: 0.35,
      intake: { gain: 0.12, hz: 450, q: 1.2, runnerMs: 2.0, flapRpm: 1e9, flapHz: 450, roar: 0.08 },
      mech: { click: 0.05, noise: 0.04 },
      turbo: { maxBar: 1.3, count: 1, spoolRpm: 1800, lag: 0.45, whineBase: 3000, whineSpan: 6000, whineGain: 0.015, hissGain: 0.06, bov: 'whoosh', bovGain: 0.3 },
      actuator: 0.05,
      timingJitterDeg: 0.8, overrunAir: 0.25, cabin: { exhaust: 1.0, intake: 0.5, mech: 0.4, block: 1.4 , leak: 0.35 }, cabinGain: 1.12, crackle: 0.2, jitter: 0.03, turb: 0.2, noise: 0.3,
      blockHz: 170, blockGain: 1.0, exhaustGain: 0.95, drive: 1.25, starterHz: 400,
    },
  },

  f458: {
    name: 'Ferrari 458 Italia', badge: '458', layout: 'V8',
    spec: '4.5 flat-plane V8 · F136 · 9,000 rpm',
    firingOrder: '1-5-3-7-4-8-2-6',
    note: 'A flat-plane crank: each bank fires evenly every 180°, like two four-cylinders interleaved. That gives the scream instead of a V8 burble. Bypass valves open under load.',
    idle: 1000, redline: 9000, limiter: 9000, limiterHz: 18,
    gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], final: 5.14, tireR: 0.345,
    shiftMs: 60, revTau: [0.04, 0.07], flare: 1500,
    upshiftCrack: 0.25, downshiftCrack: 0.35,
    sound: {
      // Physical build (engine-physics.js): metres, m², m³ and crank degrees.
      physics: {"redline":9000,"bore":0.094,"stroke":0.081,"cr":12.5,"valves":4,"inValve":0.037,"exValve":0.031,"cam":{"ivo":24,"ivc":62,"evo":58,"evc":24,"lift":0.012},"plenum":0.007,"throttle":0.012,"idleArea":0.000018,"idleMap":0.5,"exhaust":{"runner":0.33,"runnerD":0.04,"pairs":true,"secondary":0.3,"secondaryD":0.048,"collector":0.2,"collectorD":0.058,"merge":false,"mid":0.5,"midD":0.065,"box":0.35,"boxD":0.13,"tail":0.2,"tailD":0.07,"tips":1},"gain":{"exhaust":0.18,"intake":0.25,"block":0.000004},"crackPa":12000},
      idle: 1000, redline: 9000,
      firing: [
        { deg: 0,   bank: 0, runnerMs: 0.90, gain: 1.00 }, // 1
        { deg: 90,  bank: 1, runnerMs: 0.88, gain: 0.99 }, // 5
        { deg: 180, bank: 0, runnerMs: 0.93, gain: 1.01 }, // 3
        { deg: 270, bank: 1, runnerMs: 0.91, gain: 0.98 }, // 7
        { deg: 360, bank: 0, runnerMs: 0.87, gain: 1.02 }, // 4
        { deg: 450, bank: 1, runnerMs: 0.94, gain: 1.00 }, // 8
        { deg: 540, bank: 0, runnerMs: 0.89, gain: 0.99 }, // 2
        { deg: 630, bank: 1, runnerMs: 0.92, gain: 1.01 }, // 6
      ],
      banks: [{ pipeMs: 5.0, pan: -0.35 }, { pipeMs: 5.2, pan: 0.35 }],
      pulse: { spanDeg: 120, minMs: 0.7, maxMs: 5, attack: 80, decay: 6.5, nu: 0.7, lambdaLight: 0.9, lambdaFull: 0.22 },
      runnerFb: -0.35, pipeFb: -0.5, pipeA: 0.55, pipeB: 0.38,
      tail: { ms: 6, fb: -0.4, mix: 0.3 },
      muffler: [{ f: 200, q: 1.2, g: 0.7 }, { f: 650, q: 1.6, g: 0.6 }, { f: 1800, q: 1.3, g: 0.45 }],
      mufflerDirect: 0.55,
      valve: null, // straight-through: nothing closes
      tone: { base: 1400, load: 4500, rpm: 0.5 },
      rasp: 0.2,
      intake: { gain: 0.6, hz: 700, q: 1.4, runnerMs: 1.3, flapRpm: 6500, flapHz: 950, roar: 0.3 },
      mech: { click: 0.08, noise: 0.05 },
      turbo: null,
      timingJitterDeg: 0.5, overrunAir: 0.16, cabin: { exhaust: 0.9, intake: 1.4, mech: 1.0, block: 1.0 , leak: 0.35 }, cabinGain: 1.15, crackle: 0.12, jitter: 0.02, turb: 0.12, noise: 0.15,
      blockHz: 180, blockGain: 0.6, exhaustGain: 0.97, drive: 1.2, starterHz: 450,
    },
  },
};

if (typeof module !== 'undefined') {
  module.exports = ENGINES;
  // In Node (tools, offline renders) pick up the fitted settings the same way the page does.
  try { require('./engines-fitted.js')(ENGINES); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
}
