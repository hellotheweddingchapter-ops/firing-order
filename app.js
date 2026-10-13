// Drivetrain model and UI. Takes a vehicle speed (simulated, or from GPS), works out
// what a combustion car would be doing at that speed, and drives the synthesis worklet.
// The Tesla side (GPS filter, load inference, test drive) lives in drive-model.js.

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;

const S = {
  engineId: 'gt3', source: 'sim', trans: 'auto', variant: 'lr', chill: false, mode: 'comfort',
  gpsStyle: false, listen: 'cabin', speedComp: true,
  ign: 'off', ignT: 0, runStart: 0,
  v: 0, aTrue: 0, pedal: 0, pedalT: 0, brake: 0,
  keyPedal: 0, ptrPedal: 0,
  est: new SpeedFilter(6), li: new LoadInference(), nextFix: 0, drive: null,
  load: 0, overrun: false,
  gear: 0, shift: null, lastShift: -10, kickArmed: true,
  rpm: 0, fuelCut: true, limiting: false,
  cutUntil: 0, blipUntil: 0, crackleBoost: 0, pendingCrack: 0, vShown: 0, aShown: 0,
  gps: { watch: null, fixes: [], acc: null, last: null, status: 'Not started', native: 0, total: 0 },
  t: 0,
};
const ENG = () => ENGINES[S.engineId];
const aMax = (v) => TESLA.aMax(v, S.variant, S.chill);
const wheelRpm = (v) => v / (TAU * ENG().tireR) * 60;
const gearRpm = (g, v) => wheelRpm(v) * ENG().gears[g] * ENG().final;
const sport = () => S.mode === 'sport';

// ---------- audio ----------
let ctx = null, node = null, gain = null, analyser = null;
async function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('engine-worklet.js?v=8');
  node = new AudioWorkletNode(ctx, 'engine', { numberOfInputs: 0, outputChannelCount: [2] });
  gain = ctx.createGain(); gain.gain.value = +$('#volume').value;
  analyser = ctx.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0.6;
  node.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
  sendConfig();
}
const sendConfig = () => node && node.port.postMessage({ type: 'config', cfg: ENG().sound });

// ---------- ignition ----------
async function toggleIgnition() {
  if (S.ign === 'off' || S.ign === 'stopping') {
    try { await ensureAudio(); } catch (err) { toast('Audio could not start: ' + err.message); return; }
    S.ign = 'cranking'; S.ignT = S.t;
    try { await navigator.wakeLock?.request('screen'); } catch (_) {}
  } else {
    S.ign = 'stopping'; S.ignT = S.t;
  }
  renderControls();
}

// ---------- shifting ----------
function shiftTo(g, manual) {
  const e = ENG();
  g = clamp(g, 0, e.gears.length - 1);
  if (g === S.gear) return false;
  const up = g > S.gear;
  if (manual && !up && gearRpm(g, S.vShown) > e.redline) { toast('Downshift refused: it would over-rev'); return false; }
  S.shift = { from: S.rpm, t: 0, dur: (e.shiftMs / 1000) * (up ? 1 : 1.4) * (sport() ? 0.8 : 1.15) };
  S.gear = g; S.lastShift = S.t;
  // A hard upshift cuts the ignition for a moment: that is where the upshift crack comes from.
  if (up && S.load > 0.6) { S.cutUntil = S.t + 0.06; S.crackleBoost = e.upshiftCrack * (sport() ? 1 : 0.4); }
  // Downshifts are rev-matched with a blip; Sport blips harder and lets it pop on the way down.
  if (!up) { S.blipUntil = S.t + (sport() ? 0.16 : 0.1); S.blipLoad = sport() ? 0.6 : 0.3; S.pendingCrack = e.downshiftCrack * (sport() ? 1 : 0.2); }
  return true;
}

// Shift maps. Comfort upshifts early and lets the engine settle at 1,300-2,200 rpm on a cruise,
// the way modern automatics do. Sport holds gears and keeps the engine on the boil.
function shiftPoints(e, load) {
  if (sport()) return { up: lerp(e.redline * 0.45, e.redline - 200, Math.pow(load, 0.8)), down: lerp(e.redline * 0.22, e.redline * 0.55, Math.pow(load, 1.2)) };
  return { up: lerp(2100, e.redline - 300, Math.pow(load, 1.5)), down: lerp(1150, 3300, Math.pow(load, 1.3)) };
}

function autoShift(v, load) {
  const e = ENG(), n = e.gears.length, since = S.t - S.lastShift;
  if (v < 1.2) { if (S.gear !== 0 && !S.shift) S.gear = 0; return; }
  const { up: upAt, down: downAt } = shiftPoints(e, load);
  const r = gearRpm(S.gear, v);
  // Kickdown: a big pedal request drops straight to the lowest gear that stays under 88% of redline.
  if (load > 0.75 && S.kickArmed && since > 0.3 && r < e.redline * 0.6) {
    for (let g = 0; g < S.gear; g++) {
      if (gearRpm(g, v) < e.redline * 0.88) { shiftTo(g); S.kickArmed = false; return; }
    }
  }
  if (load < 0.55) S.kickArmed = true;
  // Light-load shifts wait longer, so a gently varying cruise doesn't hunt between gears.
  if (since < (load < 0.35 && !S.overrun ? 1.5 : 0.5)) return;
  // Both modes also upshift at steady light throttle whenever the next gear still keeps the engine
  // comfortably above its lugging point: that is what puts a real automatic in 5th at 50 km/h.
  const economyUp = !S.overrun && load < (sport() ? 0.3 : 0.4) && S.gear < n - 1 && gearRpm(S.gear + 1, v) > downAt * (sport() ? 1.05 : 1.12);
  if ((r > upAt || economyUp) && S.gear < n - 1) shiftTo(S.gear + 1);
  else if (S.gear > 0 && r < downAt && gearRpm(S.gear - 1, v) < upAt * 0.9) shiftTo(S.gear - 1);
}

// ---------- main loop ----------
let lastTick = performance.now();
function tick() {
  const now = performance.now(), dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now; S.t += dt;
  const e = ENG();

  // Pedal ramps like a foot, not a switch.
  S.pedalT = Math.max(S.keyPedal, S.ptrPedal);
  S.pedal += clamp(S.pedalT - S.pedal, -8 * dt, 14 * dt);

  // 1. Vehicle speed: the scripted test drive, simulated EV physics, or GPS.
  let v, a, load, overrun;
  if (S.source === 'sim') {
    let acc;
    if (S.drive) {
      acc = S.drive.step(dt, S.v, aMax(S.v));
      S.pedal = clamp((acc + TESLA.drag(S.v)) / aMax(S.v), 0, 1);
      if (S.drive.done) { S.drive = null; renderControls(); toast('Test drive finished'); }
    } else {
      // One-pedal driving: lift off and the car regenerates, like engine braking but stronger.
      acc = S.pedal * aMax(S.v) - TESLA.drag(S.v) * (S.v > 0.1 ? 1 : 0) - S.brake * 8 - (S.pedal < 0.02 ? TESLA.regen(S.v) : 0);
    }
    S.v = Math.max(0, S.v + acc * dt); S.aTrue = S.v > 0 ? acc : 0;
    if (S.gpsStyle || S.drive) {
      // Feed the simulated speed through what the car's GPS delivers: 10 Hz (measured in a Model 3/Y), slightly late.
      S.est.predict(dt);
      S.hist = S.hist || [];
      S.hist.push([S.t, S.v]); while (S.hist.length && S.hist[0][0] < S.t - 1) S.hist.shift();
      if (S.t >= S.nextFix) {
        S.nextFix = S.t + 1 / 10;
        const past = S.hist.find((h) => h[0] >= S.t - 0.2) || S.hist[0];
        S.est.measure(Math.max(0, past[1] + 0.1 * gaussian()), 0.01);
      }
      v = S.est.v; a = S.est.aS;
    } else { v = S.v; a = S.aTrue; }
  } else {
    S.est.predict(dt); v = S.est.v; a = S.est.aS;
    if (S.est.lost && S.gps.status === 'Live') S.gps.status = 'Signal lost: holding speed';
  }

  // 2. Engine load: read straight off the pedal, or inferred from acceleration.
  if (S.source === 'sim' && !S.gpsStyle && !S.drive) {
    load = S.pedal; overrun = S.pedal < 0.03 && v > 2;
    S.load += (load - S.load) * Math.min(1, dt / (load > S.load ? 0.02 : 0.06));
  } else {
    const r = S.li.update(v, a, dt, aMax(v), TESLA.drag(v), S.est.fast);
    S.load = r.load; overrun = r.overrun;
  }
  S.overrun = overrun;
  S.vShown = v; S.aShown = a;

  // 3. Gearbox → target revs.
  if (S.trans === 'auto' && !S.shift) autoShift(v, S.load);
  let target = gearRpm(S.gear, v);
  const slip = S.load * 1700 * clamp(1 - v / 8, 0, 1) * (S.gear <= 1 ? 1 : 0); // clutch slip pulling away
  target = Math.max(target, e.idle + slip, v < 0.3 ? e.idle : 0);
  if (S.shift) {
    S.shift.t += dt;
    const k = clamp(S.shift.t / S.shift.dur, 0, 1), ease = k * k * (3 - 2 * k);
    target = lerp(S.shift.from, target, ease);
    if (k >= 1) S.shift = null;
  }

  // Fuel is cut on the overrun until revs fall near idle, then injection resumes.
  let fuelCut = S.overrun && S.rpm > e.idle + 450;
  let sendLoad = S.load;
  S.limiting = false;
  if (target >= e.limiter) {
    target = e.limiter; S.limiting = true;
    if (S.load > 0.05) { const ph = (S.t * e.limiterHz) % 1; if (ph < 0.45) { fuelCut = true; target -= 220; } }
  }
  if (S.t < S.cutUntil) fuelCut = true;
  if (S.t < S.blipUntil) { sendLoad = Math.max(sendLoad, S.blipLoad || 0.4); fuelCut = false; }
  else if (S.pendingCrack) { S.crackleBoost = Math.max(S.crackleBoost, S.pendingCrack); S.pendingCrack = 0; }
  S.crackleBoost *= Math.exp(-dt / 0.15);

  // 4. Ignition overrides.
  let starter = false;
  if (S.ign === 'off') { target = 0; fuelCut = true; sendLoad = 0; }
  else if (S.ign === 'cranking') {
    target = 210 + 40 * Math.sin(S.t * 22); fuelCut = true; starter = true; sendLoad = 0;
    if (S.t - S.ignT > 0.8) { S.ign = 'running'; S.runStart = S.t; renderControls(); }
  } else if (S.ign === 'running') {
    const since = S.t - S.runStart;
    if (since < 1.6) { target = Math.max(target, e.idle + e.flare * Math.exp(-since / 0.45)); if (since < 0.5) sendLoad = Math.max(sendLoad, 0.35); }
  } else if (S.ign === 'stopping') {
    target = 0; fuelCut = true; sendLoad = 0;
    if (S.t - S.ignT > 1.2) { S.ign = 'off'; renderControls(); }
  }

  const tau = S.shift ? 0.025 : (target > S.rpm ? e.revTau[0] : e.revTau[1]);
  S.rpm += (target - S.rpm) * Math.min(1, dt / tau);
  if (S.ign === 'cranking') S.rpm = target;
  S.fuelCut = fuelCut;

  // Wind and tyre roar rise with speed; lift the engine a little (up to +4 dB) so it isn't buried.
  if (gain) {
    const vol = +$('#volume').value * (S.speedComp ? 1 + 0.58 * clamp((v - 14) / 22, 0, 1) : 1);
    gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.3);
  }

  if (node) node.port.postMessage({ type: 'params', rpm: S.rpm, load: sendLoad, fuelCut, starter, crackleBoost: S.crackleBoost, speed: v, listen: S.listen, sport: sport() });
}
setInterval(tick, 1000 / 60);

function gaussian() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(TAU * Math.random()); }

function startTestDrive() {
  S.source = 'sim'; stopGps();
  S.v = 0; S.gear = 0; S.shift = null; S.est.reset(); S.li.reset(); S.hist = [];
  S.drive = new TestDrive();
  if (S.ign !== 'running' && S.ign !== 'cranking') toggleIgnition();
  renderControls();
}

// ---------- GPS ----------
function startGps() {
  if (!('geolocation' in navigator)) { S.gps.status = 'This browser has no location access'; return; }
  S.est.reset(); S.li.reset(); S.gps.last = null; S.gps.fixes = [];
  S.gps.status = 'Waiting for the first fix…';
  S.gps.watch = navigator.geolocation.watchPosition(onFix, (err) => {
    S.gps.status = err.code === 1 ? 'Location permission denied. Allow it in the browser settings.' : 'No GPS signal: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}
function stopGps() { if (S.gps.watch !== null) navigator.geolocation.clearWatch(S.gps.watch); S.gps.watch = null; }
function onFix(pos) {
  const t = S.t, c = pos.coords;
  let speed = c.speed, r = 0.01; // Doppler speed from the receiver: about ±0.1 m/s
  S.gps.total++;
  if (speed === null || Number.isNaN(speed)) {
    // No speed in the fix: derive it from the distance since the last one. Much noisier.
    const l = S.gps.last;
    if (l) {
      const R = 6371000, toR = Math.PI / 180, dtf = Math.max(0.05, t - l.t);
      const dLat = (c.latitude - l.lat) * toR, dLon = (c.longitude - l.lon) * toR;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(l.lat * toR) * Math.cos(c.latitude * toR) * Math.sin(dLon / 2) ** 2;
      speed = (2 * R * Math.asin(Math.sqrt(h))) / dtf;
      r = clamp(((c.accuracy || 5) * 0.3 / dtf) ** 2, 0.05, 9);
    } else speed = 0;
  } else S.gps.native++;
  S.gps.last = { lat: c.latitude, lon: c.longitude, t };
  S.gps.acc = c.accuracy;
  S.gps.fixes.push(t);
  S.est.measure(speed, r);
  S.gps.status = 'Live';
}

// ---------- input ----------
const $ = (q) => document.querySelector(q);
const keys = new Set();
function updateKeys() {
  if (S.source !== 'sim') { S.keyPedal = 0; S.brake = 0; return; }
  const throttle = keys.has('ArrowUp') || keys.has('KeyW');
  S.keyPedal = throttle ? (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 0.4 : 1) : 0;
  S.brake = keys.has('ArrowDown') || keys.has('KeyS') || brakeHeld ? 1 : 0;
}
let brakeHeld = false;
addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, select')) return;
  if (ev.code === 'Space') { ev.preventDefault(); toggleIgnition(); return; }
  if (ev.repeat) return;
  const shiftUp = ['KeyE', 'BracketRight', 'PageUp'], shiftDown = ['KeyQ', 'BracketLeft', 'PageDown'];
  if (S.source === 'gps') { shiftUp.push('ArrowUp'); shiftDown.push('ArrowDown'); }
  if (shiftUp.includes(ev.code)) { paddle(+1); ev.preventDefault(); return; }
  if (shiftDown.includes(ev.code)) { paddle(-1); ev.preventDefault(); return; }
  if (ev.code.startsWith('Arrow')) ev.preventDefault();
  keys.add(ev.code); updateKeys();
});
addEventListener('keyup', (ev) => { keys.delete(ev.code); updateKeys(); });
addEventListener('blur', () => { keys.clear(); updateKeys(); });

// Steering wheel scroll button (and mouse wheel) shifts. The car sends these to the page.
let wheelLock = 0;
addEventListener('wheel', (ev) => {
  if (drawerOpen) return;
  ev.preventDefault();
  if (S.t < wheelLock || Math.abs(ev.deltaY) < 4) return;
  wheelLock = S.t + 0.18;
  paddle(ev.deltaY < 0 ? +1 : -1);
}, { passive: false });

function paddle(dir) {
  if (S.trans !== 'manual') { S.trans = 'manual'; renderControls(); toast('Manual'); }
  shiftTo(S.gear + dir, true);
}
$('#upBtn').addEventListener('click', () => paddle(+1));
$('#downBtn').addEventListener('click', () => paddle(-1));

// Accelerator: press and slide right for more pedal; it springs back on release.
const pedalEl = $('#pedal');
function pedalFromPointer(ev) {
  const r = pedalEl.getBoundingClientRect();
  S.ptrPedal = clamp((ev.clientX - r.left) / r.width * 1.1, 0.1, 1);
}
pedalEl.addEventListener('pointerdown', (ev) => { pedalEl.setPointerCapture(ev.pointerId); pedalFromPointer(ev); });
pedalEl.addEventListener('pointermove', (ev) => { if (pedalEl.hasPointerCapture(ev.pointerId)) pedalFromPointer(ev); });
const pedalUp = () => { S.ptrPedal = 0; };
pedalEl.addEventListener('pointerup', pedalUp);
pedalEl.addEventListener('pointercancel', pedalUp);
const brakeEl = $('#brake');
brakeEl.addEventListener('pointerdown', (ev) => { brakeEl.setPointerCapture(ev.pointerId); brakeHeld = true; updateKeys(); });
const brakeUp = () => { brakeHeld = false; updateKeys(); };
brakeEl.addEventListener('pointerup', brakeUp);
brakeEl.addEventListener('pointercancel', brakeUp);

// ---------- preferences ----------
const prefs = (() => { try { return JSON.parse(localStorage.getItem('fo-prefs') || '{}'); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('fo-prefs', JSON.stringify(prefs)); } catch (_) {} };
if (prefs.engineId && ENGINES[prefs.engineId]) S.engineId = prefs.engineId;
if (prefs.variant) S.variant = prefs.variant;
if (prefs.listen) S.listen = prefs.listen;
S.unit = prefs.unit || 'kmh';
if (prefs.mode) S.mode = prefs.mode;
if (prefs.chill != null) S.chill = prefs.chill;
if (prefs.speedComp != null) S.speedComp = prefs.speedComp;
S.theme = prefs.theme || 'auto';
S.egt = 20;
$('#variant').value = S.variant;
if (prefs.volume != null) $('#volume').value = prefs.volume;
function applyTheme() {
  if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', S.theme);
}
applyTheme();

// ---------- controls ----------
function setPressed(sel, attr, val) {
  document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', b.dataset[attr] === val));
}
function renderControls() {
  setPressed('[data-engine]', 'engine', S.engineId);
  setPressed('[data-source]', 'source', S.source);
  setPressed('[data-trans]', 'trans', S.trans);
  setPressed('[data-listen]', 'listen', S.listen);
  setPressed('[data-theme-set]', 'themeSet', S.theme);
  setPressed('[data-unit]', 'unit', S.unit);
  setPressed('[data-mode]', 'mode', S.mode);
  $('#chill').checked = S.chill;
  $('#speedComp').checked = S.speedComp;
  $('#driveBtn').classList.toggle('on', !!S.drive);
  $('#driveBtn span').textContent = S.drive ? 'Stop drive' : 'Test drive';
  $('#driveTag').hidden = !S.drive;
  const on = S.ign === 'running' || S.ign === 'cranking';
  $('#ignition').classList.toggle('on', on);
  $('#simOnly').hidden = S.source !== 'sim';
  $('#gpsPanel').hidden = S.source !== 'gps';
  $('#telemetry').classList.toggle('gps', S.source === 'gps');
  $('#gpsStyle').checked = S.gpsStyle;
  $('#transTag').textContent = S.trans === 'auto' ? 'Auto' : 'Manual';
  $('#unitLabel').textContent = S.unit === 'mph' ? 'mph' : 'km/h';
}

$('#engines').innerHTML = Object.entries(ENGINES).map(([id, e]) => `
  <button class="car" type="button" data-engine="${id}" aria-pressed="false">
    <em>${e.layout}</em>
    <b>${e.badge}</b>
    <span>${e.name.replace(/ (GT3|GT-R|S3|458 Italia)$/, '')} · ${e.redline.toLocaleString('en')} rpm</span>
  </button>`).join('');
document.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
  if (S.engineId === b.dataset.engine) return;
  S.engineId = b.dataset.engine; S.gear = 0; S.shift = null;
  prefs.engineId = S.engineId; savePrefs();
  sendConfig();
  if (S.ign === 'running') { S.ign = 'cranking'; S.ignT = S.t; }
  renderControls(); drawEngineInfo();
}));
document.querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => {
  S.source = b.dataset.source;
  S.est.reset(); S.v = 0; S.keyPedal = 0; S.ptrPedal = 0;
  if (S.source === 'gps') startGps(); else stopGps();
  renderControls();
}));
document.querySelectorAll('[data-trans]').forEach((b) => b.addEventListener('click', () => { S.trans = b.dataset.trans; renderControls(); }));
document.querySelectorAll('[data-listen]').forEach((b) => b.addEventListener('click', () => { S.listen = prefs.listen = b.dataset.listen; savePrefs(); renderControls(); }));
document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => { S.theme = prefs.theme = b.dataset.themeSet; savePrefs(); applyTheme(); renderControls(); }));
document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { S.unit = prefs.unit = b.dataset.unit; savePrefs(); renderControls(); }));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { S.mode = prefs.mode = b.dataset.mode; savePrefs(); renderControls(); }));
$('#chill').addEventListener('change', (ev) => { S.chill = prefs.chill = ev.target.checked; savePrefs(); });
$('#speedComp').addEventListener('change', (ev) => { S.speedComp = prefs.speedComp = ev.target.checked; savePrefs(); });
$('#driveBtn').addEventListener('click', () => {
  if (S.drive) { S.drive = null; S.v = 0; renderControls(); return; }
  startTestDrive();
});
$('#variant').addEventListener('change', (ev) => { S.variant = prefs.variant = ev.target.value; savePrefs(); });
$('#gpsStyle').addEventListener('change', (ev) => { S.gpsStyle = ev.target.checked; S.est.reset(); S.est.v = S.v; });
$('#volume').addEventListener('input', (ev) => { if (gain) gain.gain.value = +ev.target.value; prefs.volume = +ev.target.value; savePrefs(); });
$('#ignition').addEventListener('click', toggleIgnition);

// ---------- drawer ----------
let drawerOpen = false;
function setDrawer(open) {
  drawerOpen = open;
  $('#drawer').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', !open);
  $('#backdrop').hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', open);
  if (open) $('#closeBtn').focus();
}
$('#menuBtn').addEventListener('click', () => setDrawer(true));
$('#closeBtn').addEventListener('click', () => setDrawer(false));
$('#backdrop').addEventListener('click', () => setDrawer(false));
addEventListener('keydown', (ev) => { if (ev.code === 'Escape' && drawerOpen) setDrawer(false); });

// ---------- reference recording ----------
let refBuf = null, refSrc = null, refGain = null, refAnalyser = null;
$('#refFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    await ensureAudio();
    refBuf = await ctx.decodeAudioData(await f.arrayBuffer());
  } catch (err) { toast('That file could not be read. Try WAV, MP3 or M4A.'); return; }
  stopRef();
  $('#refName').textContent = f.name;
  $('#refPlay').disabled = false;
});
function stopRef() { if (refSrc) { refSrc.stop(); refSrc = null; } $('#refPlay').textContent = 'Play'; }
$('#refPlay').addEventListener('click', () => {
  if (refSrc) { stopRef(); return; }
  if (!refAnalyser) {
    refGain = ctx.createGain(); refAnalyser = ctx.createAnalyser();
    refAnalyser.fftSize = 8192; refAnalyser.smoothingTimeConstant = 0.6;
    refGain.connect(refAnalyser); refAnalyser.connect(ctx.destination);
  }
  refSrc = ctx.createBufferSource(); refSrc.buffer = refBuf; refSrc.loop = true;
  refSrc.connect(refGain); refSrc.start();
  $('#refPlay').textContent = 'Stop';
});

// ---------- car check ----------
// Records what the car's browser actually provides: GPS rate and speed, sensors, how the
// steering-wheel scroll button arrives, audio output. Results stay on screen to photograph.
function runCarCheck() {
  const out = $('#checkOut'), rows = {};
  const put = (k, v) => { rows[k] = v; out.innerHTML = Object.entries(rows).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join(''); };
  const ua = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  put('Browser', ua ? 'Chrome ' + ua[1] : navigator.userAgent.slice(0, 60));
  put('Screen', `${innerWidth}×${innerHeight} @${devicePixelRatio}x · ${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}`);
  put('Audio worklet', 'AudioWorkletNode' in window ? 'yes' : 'NO');
  ensureAudio().then(() => put('Audio output', `${ctx.sampleRate} Hz · latency ${Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000)} ms · ${ctx.state}`)).catch((e) => put('Audio output', 'failed: ' + e.message));
  put('Wake lock', 'wakeLock' in navigator ? 'yes' : 'no');
  put('Offline cache', 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'active' : 'available, not yet active') : 'no');
  // GPS
  const fixes = [], nf = new SpeedFilter(6, true);
  let watch = null, moving = 0, lastT = null;
  if ('geolocation' in navigator) {
    put('GPS', 'waiting…');
    watch = navigator.geolocation.watchPosition((p) => {
      const now = performance.now();
      fixes.push({ t: now, s: p.coords.speed, acc: p.coords.accuracy, h: p.coords.heading });
      const n = fixes.length;
      put('GPS', 'receiving');
      // Speed noise while moving, learned by the same filter the app uses.
      if (p.coords.speed != null) {
        if (lastT !== null) nf.predict((now - lastT) / 1000);
        lastT = now; nf.measure(p.coords.speed, 0.01);
        if (p.coords.speed > 2) moving++;
        put('Speed noise moving', moving > 30 ? `±${Math.sqrt(nf.r).toFixed(3)} m/s (${moving} fixes)` : 'drive to measure');
      }
      if (n > 1) {
        const gaps = fixes.slice(1).map((f, i) => f.t - fixes[i].t).sort((a, b) => a - b);
        const med = gaps[Math.floor(gaps.length / 2)];
        const withSpeed = fixes.filter((f) => f.s != null && !Number.isNaN(f.s)).length;
        put('GPS rate', `${(1000 / med).toFixed(1)} Hz (median gap ${Math.round(med)} ms, ${n} fixes)`);
        put('GPS speed field', `${Math.round(withSpeed / n * 100)}% of fixes${withSpeed ? ' · last ' + (fixes[n - 1].s ?? 0).toFixed(2) + ' m/s' : ''}`);
        put('GPS accuracy', `±${Math.round(fixes[n - 1].acc)} m`);
      } else put('GPS', 'first fix received');
    }, (err) => put('GPS', err.code === 1 ? 'permission denied' : 'error: ' + err.message), { enableHighAccuracy: true, maximumAge: 0 });
  } else put('GPS', 'not available');
  // Motion sensors
  let motion = 0;
  const onMotion = () => { motion++; };
  addEventListener('devicemotion', onMotion);
  put('Motion sensor', 'DeviceMotionEvent' in window ? 'listening…' : 'not available');
  // Steering wheel scroll button: whatever event it produces
  const seen = new Set();
  const onWheel = (e) => { seen.add(`wheel ${e.deltaY > 0 ? 'down' : 'up'}`); put('Scroll button', [...seen].join(', ')); };
  const onKey = (e) => { seen.add(`key ${e.code || e.key}`); put('Scroll button', [...seen].join(', ')); };
  addEventListener('wheel', onWheel, { capture: true });
  addEventListener('keydown', onKey, { capture: true });
  put('Scroll button', 'roll the left scroll wheel now');
  let left = 90;
  $('#checkBtn').disabled = true;
  const timer = setInterval(() => {
    left--;
    $('#checkState').textContent = left > 0 ? `Running · ${left} s left` : 'Done · photograph the results';
    put('Motion sensor', 'DeviceMotionEvent' in window ? (motion ? `yes · ${motion} readings` : 'no readings') : 'not available');
    if (left <= 0) {
      clearInterval(timer);
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      removeEventListener('devicemotion', onMotion);
      removeEventListener('wheel', onWheel, { capture: true });
      removeEventListener('keydown', onKey, { capture: true });
      if (!seen.size) put('Scroll button', 'nothing received');
      put('GPS', fixes.length ? 'done' : 'no fixes');
      $('#checkBtn').disabled = false;
    }
  }, 1000);
}
$('#checkBtn').addEventListener('click', runCarCheck);

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

function drawEngineInfo() {
  const e = ENG();
  $('#engNote').textContent = e.note;
  $('#engName').textContent = e.name;
  $('#engLayout').textContent = e.spec.split(' · ').slice(0, 2).join(' · ');
  $('#gearCount').textContent = `${e.gears.length}-speed`;
  $('#strip').innerHTML = e.gears.map((_, i) => `<i>${i + 1}</i>`).join('');
  $('#boostBox').style.opacity = e.sound.turbo ? '' : '0.35';
}

// ---------- drawing ----------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let palette = {};
function readPalette() {
  palette = { fg: css('--fg'), dim: css('--dim'), off: css('--seg-off'), red: css('--accent'), amber: css('--amber'), blue: css('--blue'), glow: +css('--glow'), line: css('--line'), num: css('--font-num') };
}
readPalette();
new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', readPalette);

function fitCanvas(c) {
  const dpr = devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

// Shift lights: green, then amber, then red as revs approach the shift point; all blue to shift.
const LIGHTS = 15;
$('#lights').innerHTML = Array.from({ length: LIGHTS }, (_, i) => `<i class="${i < 5 ? 'g' : i < 10 ? 'a' : 'r'}"></i>`).join('');
const lightEls = [...document.querySelectorAll('#lights i')];
function drawLights() {
  const e = ENG(), shiftAt = e.redline - 300, start = shiftAt - Math.max(2200, e.redline * 0.3);
  const k = S.ign === 'off' ? 0 : clamp((S.rpm - start) / (shiftAt - start), 0, 1);
  const lit = Math.round(k * LIGHTS);
  const flash = S.ign !== 'off' && (S.limiting || S.rpm >= shiftAt) && (S.t * 8) % 1 < 0.6;
  $('#lights').classList.toggle('flash', flash);
  lightEls.forEach((el, i) => el.classList.toggle('on', i < lit));
}

// Segmented rev counter: lit segments up to the current revs, redline zone in red.
function drawTach() {
  const { g, w, h } = fitCanvas($('#tach'));
  const e = ENG(), max = Math.ceil((e.redline + 500) / 1000) * 1000, P = palette;
  const cx = w / 2, cy = h * 0.54, R = Math.min(w * 0.42, h * 0.47);
  const a0 = Math.PI * 0.72, sweep = Math.PI * 1.56;
  const ang = (rpm) => a0 + sweep * clamp(rpm / max, 0, 1);
  const N = 80, segW = sweep / N, thick = Math.max(14, R * 0.12);
  g.clearRect(0, 0, w, h);
  const lit = S.ign === 'off' ? 0 : S.rpm / max * N;
  for (let i = 0; i < N; i++) {
    const rpm = (i + 0.5) / N * max, inRed = rpm >= e.redline;
    const on = i < lit;
    const s0 = a0 + i * segW + segW * 0.14, s1 = a0 + (i + 1) * segW - segW * 0.14;
    let col = inRed ? P.red : P.off;
    if (on) col = inRed || S.limiting ? P.red : rpm > e.redline - 1500 ? P.amber : P.fg;
    g.beginPath();
    g.arc(cx, cy, R, s0, s1);
    g.arc(cx, cy, R - thick, s1, s0, true);
    g.closePath();
    g.globalAlpha = !on && inRed ? 0.35 : 1;
    g.shadowBlur = on && P.glow ? 14 : 0; g.shadowColor = col;
    g.fillStyle = col; g.fill();
  }
  g.globalAlpha = 1; g.shadowBlur = 0;
  // Numerals, every 1,000 rpm.
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(R * 0.11)}px ${P.num}`;
  for (let k = 0; k <= max; k += 1000) {
    const an = ang(k), rr = R - thick - R * 0.12;
    g.fillStyle = k >= e.redline ? P.red : P.dim;
    g.fillText(String(k / 1000), cx + Math.cos(an) * rr, cy + Math.sin(an) * rr);
    g.strokeStyle = k >= e.redline ? P.red : P.dim; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(an) * (R + 6), cy + Math.sin(an) * (R + 6));
    g.lineTo(cx + Math.cos(an) * (R + 14), cy + Math.sin(an) * (R + 14));
    g.stroke();
  }
  // Peak-hold marker: where the revs last peaked, fading over two seconds.
  if (S.peakRpm > 0) {
    const an = ang(S.peakRpm);
    g.strokeStyle = P.red; g.lineWidth = 3; g.globalAlpha = clamp(1 - (S.t - S.peakT) / 2, 0, 1);
    g.beginPath();
    g.moveTo(cx + Math.cos(an) * (R + 4), cy + Math.sin(an) * (R + 4));
    g.lineTo(cx + Math.cos(an) * (R - thick - 4), cy + Math.sin(an) * (R - thick - 4));
    g.stroke(); g.globalAlpha = 1;
  }
}

function drawSpectrum() {
  const { g, w, h } = fitCanvas($('#spectrum'));
  const P = palette;
  g.clearRect(0, 0, w, h);
  const fMin = 20, fMax = 4000, lx = (f) => Math.log(f / fMin) / Math.log(fMax / fMin) * w, base = h - 16;
  g.strokeStyle = P.line; g.lineWidth = 1;
  g.fillStyle = P.dim; g.font = `500 10px ${css('--font-ui')}`; g.textBaseline = 'bottom'; g.textAlign = 'center';
  for (const f of [50, 100, 200, 500, 1000, 2000]) {
    const x = Math.round(lx(f)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, base); g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x, h - 2);
  }
  const trace = (an, color, fill) => {
    const bins = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(bins);
    const hz = ctx.sampleRate / an.fftSize;
    g.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const f = fMin * Math.pow(fMax / fMin, px / w), i = Math.round(f / hz);
      const y = base * (1 - (clamp(bins[i] ?? -140, -110, -10) + 110) / 100);
      if (px === 0) g.moveTo(px, y); else g.lineTo(px, y);
    }
    if (fill) { g.lineTo(w, base); g.lineTo(0, base); g.closePath(); g.globalAlpha = 0.18; g.fillStyle = color; g.fill(); g.globalAlpha = 1; }
    g.strokeStyle = color; g.lineWidth = 1.25; g.stroke();
  };
  if (analyser) trace(analyser, P.red, true);
  if (refSrc && refAnalyser) trace(refAnalyser, P.blue, false);
  if (S.rpm > 100) {
    const ff = S.rpm / 60 * ENG().sound.firing.length / 2;
    if (ff > fMin && ff < fMax) {
      const x = lx(ff), right = x > w - 90;
      g.strokeStyle = P.fg; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, base); g.stroke(); g.setLineDash([]);
      g.fillStyle = P.fg; g.textAlign = right ? 'right' : 'left'; g.textBaseline = 'top';
      g.fillText(`firing ${Math.round(ff)} Hz`, x + (right ? -5 : 5), 4);
    }
  }
}

function setBar(id, k) { $(id).style.setProperty('--k', clamp(k, 0, 1).toFixed(3)); }
const stateText = () => S.ign === 'off' ? 'Engine off' : S.ign === 'cranking' ? 'Cranking' : S.ign === 'stopping' ? 'Switching off'
  : S.limiting ? 'Limiter' : S.shift ? 'Shift' : S.fuelCut ? 'Overrun' : S.load > 0.75 ? 'Full load' : S.load > 0.2 ? 'Part load' : S.vShown < 1 ? 'Idle' : 'Cruise';
let boostShown = 0, lastText = {};
function setText(id, txt) { if (lastText[id] !== txt) { lastText[id] = txt; $(id).innerHTML = txt; } }
function drawReadouts(dt) {
  const e = ENG();
  const neutral = S.vShown < 0.3 && S.load < 0.05 && S.trans === 'auto';
  setText('#gear', S.ign === 'off' ? '–' : neutral ? 'N' : String(S.gear + 1));
  setText('#rpmNum', (Math.round(S.rpm / 10) * 10).toLocaleString('en'));
  const sp = (S.vShown || 0) * (S.unit === 'mph' ? 2.23694 : 3.6);
  setText('#speed', String(Math.round(sp)));
  const st = stateText();
  setText('#state', st);
  $('#state').className = 'state' + (S.limiting ? ' warn' : S.ign === 'running' ? ' live' : '');
  $('#dash').classList.toggle('hot', S.limiting);
  const valveOpen = !e.sound.valve || (S.ign === 'running' && (S.rpm > e.sound.valve.rpm || S.load > e.sound.valve.load));
  setText('#valveTag', valveOpen || (sport() && S.ign === 'running') ? 'Valves open' : 'Valves shut');
  if (S.drive) setText('#driveTag', S.drive.label);
  $('#valveTag').classList.toggle('on', !!valveOpen);
  document.querySelectorAll('#strip i').forEach((el, i) => el.classList.toggle('cur', S.ign !== 'off' && !neutral && i === S.gear));

  setText('#loadVal', `${Math.round(S.load * 100)}<small>%</small>`); setBar('#loadBar', S.load);
  const acc = (S.aShown || 0) / 9.81;
  setText('#accVal', `${acc < 0 ? '−' : ''}${Math.abs(acc).toFixed(2)}<small>g</small>`);
  setBar('#accBar', Math.abs(acc) / 0.9);
  $('#accBar').classList.toggle('blue', acc < 0);
  if (e.sound.turbo) {
    const bT = S.fuelCut ? 0 : S.load * clamp((S.rpm - e.sound.turbo.spoolRpm) / 2500, 0, 1);
    boostShown += (bT - boostShown) * Math.min(1, dt / (bT > boostShown ? e.sound.turbo.lag * 0.8 : 0.08));
  } else boostShown = 0;
  setText('#boostVal', `${(boostShown * 1.6).toFixed(1)}<small>bar</small>`); setBar('#boostBar', boostShown);
  // Exhaust gas temperature, same model the sound engine uses for its pipe resonances.
  const tT = S.ign === 'off' || S.rpm < 50 ? 20 : 180 + 600 * (S.fuelCut ? 0 : S.load) + 250 * S.rpm / e.redline;
  S.egt += (tT - S.egt) * Math.min(1, dt / (tT > S.egt ? 3 : 7));
  setText('#egtVal', `${Math.round(S.egt)}<small>°C</small>`); setBar('#egtBar', S.egt / 950);

  if (S.rpm > (S.peakRpm || 0) || S.t - S.peakT > 2) { S.peakRpm = S.rpm; S.peakT = S.t; }

  if (S.source === 'gps') {
    S.gps.fixes = S.gps.fixes.filter((t) => S.t - t < 2);
    const rate = S.gps.fixes.length / 2;
    setText('#srcChip', S.gps.status === 'Live' ? `GPS · ${rate.toFixed(0)} Hz` : 'GPS · waiting');
    $('#srcChip').classList.toggle('live', S.gps.status === 'Live');
    setText('#gpsStatus', S.gps.status);
    setText('#gpsRate', rate.toFixed(1) + ' Hz');
    setText('#gpsAcc', S.gps.acc == null ? '—' : '±' + Math.round(S.gps.acc) + ' m');
  } else {
    setText('#srcChip', S.gpsStyle ? 'Simulator · GPS feel' : 'Simulator');
    $('#srcChip').classList.toggle('live', S.ign === 'running');
  }
  $('#pedalFill').style.setProperty('--k', S.pedal.toFixed(3));
  $('#brake').classList.toggle('held', S.brake > 0);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  drawLights(); drawTach(); drawReadouts(dt);
  if (drawerOpen) drawSpectrum();
  requestAnimationFrame(frame);
}

renderControls(); drawEngineInfo();
requestAnimationFrame(frame);

// Offline: once loaded over HTTPS, the app keeps working in the car without a connection.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js?v=8').catch(() => {});
}
