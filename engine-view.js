// Engine view: the simulated engine, drawn. It runs its own copy of the same simulation as
// the sound (same code, same build, same revs, throttle, boost and lift-off), slowed down so
// one engine cycle takes a couple of seconds and the moving parts can be seen.

const EngineView = (() => {
  const SR = 48000;
  let core = null, coreFor = null, open = false, slow = 2.2, sel = 0, raf = 0, simPhase = 0;
  const $v = (q) => document.querySelector(q);
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function build() {
    const e = ENG();
    core = new PhysCore({ ...e.sound.physics, idleRpm: e.idle }, e.sound.firing, SR);
    core.record = true; coreFor = S.engineId; simPhase = 0;
    // Run it up to a steady state before showing anything.
    advance(SR * 0.4, true);
    sel = 0;
    const order = e.firingOrder.split('-');
    $v('#evTitle').textContent = e.name;
    $v('#evSub').textContent = `${e.spec.split(' · ')[0]} · firing ${e.firingOrder}`;
    $v('#evCyl').innerHTML = order.map((n, i) => `<option value="${i}">Cylinder ${n}</option>`).join('');
  }

  function inputs() {
    const e = ENG(), running = S.ign === 'running' || S.ign === 'cranking';
    const rpm = running ? Math.max(150, S.rpm) : 0;
    const boost = e.sound.turbo && !S.fuelCut ? S.load * Math.min(1, Math.max(0, (S.rpm - e.sound.turbo.spoolRpm) / 2500)) * (e.sound.turbo.maxBar ?? 1) : 0;
    return { rpm, load: Math.max(0.02, S.load), cut: !!S.fuelCut || !running, boost };
  }

  function advance(n, warm) {
    const { rpm, load, cut, boost } = warm ? { rpm: Math.max(800, S.rpm || ENG().idle), load: Math.max(0.05, S.load), cut: false, boost: 0 } : inputs();
    if (rpm <= 0) return;
    core.setGas(S.egt ? S.egt + 273 : 900);
    const dph = rpm / 120 / SR;
    for (let i = 0; i < n; i++) {
      core.step(simPhase, dph, rpm, load, cut, boost, 1, 0.03, () => Math.random() * 2 - 1);
      simPhase = (simPhase + dph) % 1;
    }
  }

  function fit(c) {
    const dpr = devicePixelRatio || 1, r = c.getBoundingClientRect();
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w: r.width, h: r.height };
  }

  // Gas colour by temperature: cold charge blue-grey, compressed warm, burning white-yellow.
  function gasColor(T, flame) {
    const k = Math.min(1, Math.max(0, (T - 300) / 2200));
    const r = Math.round(60 + 195 * Math.min(1, k * 1.6)), g = Math.round(70 + 150 * Math.max(0, k - 0.35) * 1.5), b = Math.round(120 - 90 * Math.min(1, k * 2) + 120 * Math.max(0, k - 0.8) * 4);
    return `rgba(${Math.min(255, r + flame * 40)},${Math.min(255, g + flame * 60)},${Math.min(255, b)},${0.35 + 0.6 * k})`;
  }

  function drawCylinders() {
    const { g, w, h } = fit($v('#evCyls'));
    g.clearRect(0, 0, w, h);
    const e = ENG(), names = e.firingOrder.split('-'), L = core.layout, S0 = e.sound.physics;
    const banks = L.banks.map((b) => [...b.cyls].sort((a, c) => names[a].localeCompare(names[c], undefined, { numeric: true })));
    const n = banks.reduce((s, b) => s + b.length, 0), gap = banks.length > 1 ? 18 : 0;
    const cw = Math.min(92, (w - gap * (banks.length - 1)) / n), stroke = S0.stroke, bore = S0.bore;
    const scale = Math.min(cw * 0.62 / bore, (h - 72) / (stroke * 3.7));
    const fg = cssv('--fg'), dim = cssv('--dim'), line = cssv('--line'), red = cssv('--accent'), blue = cssv('--blue');
    let x0 = (w - (n * cw + gap * (banks.length - 1))) / 2;
    g.font = `600 11px ${cssv('--font-ui')}`; g.textAlign = 'center';
    banks.forEach((cyls, bi) => {
      cyls.forEach((ci) => {
        const c = core.cyl[ci], cx = x0 + cw / 2;
        const boreW = bore * scale, top = 22, rc = stroke / 2 * scale, rod = (S0.rod ?? stroke * 1.65) * scale;
        const a = (c.th || 0) * Math.PI / 180;
        const crankY = top + 14 + rc * 2 + rod + rc + 8;
        const pinX = cx + rc * Math.sin(a), pinY = crankY - rc * Math.cos(a);
        const pistonY = crankY - rc * Math.cos(a) - Math.sqrt(rod * rod - (rc * Math.sin(a)) ** 2);
        const headY = top + 14, pistonTop = pistonY - 10;
        const burning = c.xb > 0 && c.xb < 1 ? c.xb : 0;
        // Gas in the cylinder.
        g.fillStyle = gasColor(c.T, burning);
        g.fillRect(cx - boreW / 2, headY, boreW, Math.max(1, pistonTop - headY));
        if (burning) { g.fillStyle = `rgba(255,236,170,${0.85 * (1 - burning)})`; g.fillRect(cx - boreW / 2, headY, boreW, Math.max(1, (pistonTop - headY) * Math.min(1, burning * 1.6))); }
        // Walls and head.
        g.strokeStyle = line; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx - boreW / 2, headY); g.lineTo(cx - boreW / 2, crankY - rc - 6); g.moveTo(cx + boreW / 2, headY); g.lineTo(cx + boreW / 2, crankY - rc - 6); g.stroke();
        g.fillStyle = cssv('--surface-2'); g.fillRect(cx - boreW / 2 - 3, top, boreW + 6, 14);
        // Valves: drop by their lift (exaggerated so it shows).
        const [Ai, Ae] = c.lift || [0, 0], amax = Math.PI * S0.inValve * S0.inValve / 4 * (S0.valves / 2) * 0.85 * 0.68;
        const vIn = Math.min(1, Ai / amax) * 10, vEx = Math.min(1, Ae / amax) * 10;
        g.fillStyle = blue; g.fillRect(cx - boreW * 0.32 - 5, headY - 2 + vIn, 10, 3);
        g.fillStyle = red; g.fillRect(cx + boreW * 0.32 - 5, headY - 2 + vEx, 10, 3);
        // Piston, rod, crank.
        g.fillStyle = cssv('--dim'); g.fillRect(cx - boreW / 2 + 1, pistonTop, boreW - 2, 12);
        g.strokeStyle = fg; g.lineWidth = 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(cx, pistonY); g.lineTo(pinX, pinY); g.stroke();
        g.strokeStyle = line; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, crankY, rc, 0, Math.PI * 2); g.stroke();
        g.fillStyle = fg; g.beginPath(); g.arc(pinX, pinY, 3, 0, Math.PI * 2); g.fill();
        // Labels: number, pressure.
        g.fillStyle = ci === sel ? red : dim;
        g.fillText(names[ci], cx, 12);
        g.fillStyle = fg;
        g.fillText(`${(c.p / 1e5).toFixed(c.p > 1e6 ? 0 : 1)} bar`, cx, crankY + rc + 18);
        if (ci === sel) { g.strokeStyle = red; g.lineWidth = 2; g.strokeRect(cx - cw / 2 + 2, 2, cw - 4, h - 4); }
        c._hit = [cx - cw / 2, cx + cw / 2];
        x0 += cw;
      });
      x0 += gap;
    });
  }

  function drawTrace() {
    const { g, w, h } = fit($v('#evTrace'));
    g.clearRect(0, 0, w, h);
    const c = core.cyl[sel], tr = c.trace, S0 = ENG().sound.physics;
    if (!tr) return;
    const padL = 34, padB = 18, pw = w - padL - 6, ph = h - padB - 8;
    let maxP = 10e5; for (let i = 0; i < 360; i++) maxP = Math.max(maxP, tr[i]);
    maxP = Math.ceil(maxP / 2e6) * 2e6;
    // Show -360..+360 with firing TDC in the middle.
    const xOf = (th) => padL + ((th + 360) % 720) / 720 * pw, yOf = (p) => 8 + ph * (1 - p / maxP);
    const cam = S0.cam, band = (a0, a1, col) => { g.fillStyle = col; let x0 = xOf(a0), x1 = xOf(a1); if (x1 < x0) { g.fillRect(x0, 8, padL + pw - x0, ph); x0 = padL; } g.fillRect(x0, 8, x1 - x0, ph); };
    band(180 - cam.evo, 360 + cam.evc, 'rgba(232,33,39,0.12)');
    band(360 - cam.ivo, 540 + cam.ivc, 'rgba(61,139,255,0.12)');
    g.strokeStyle = cssv('--line'); g.fillStyle = cssv('--dim'); g.lineWidth = 1; g.font = `500 10px ${cssv('--font-ui')}`;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let p = 0; p <= maxP; p += maxP / 4) { const y = Math.round(yOf(p)) + 0.5; g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + pw, y); g.stroke(); g.fillText(`${Math.round(p / 1e5)}`, padL - 4, y); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    [['−360', 360], ['−180', 540], ['TDC', 0], ['+180', 180], ['+360', 359.9]].forEach(([t, th]) => g.fillText(t, xOf(th), 8 + ph + 4));
    g.strokeStyle = cssv('--accent'); g.lineWidth = 2; g.beginPath();
    for (let k = 0; k <= 360; k++) {
      const th = (k * 2 + 360) % 720, i = (th / 2) | 0, x = padL + k / 360 * pw, y = yOf(tr[i % 360]);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    // Where the crank is now.
    const x = xOf(c.th || 0); g.strokeStyle = cssv('--fg'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 8 + ph); g.stroke(); g.setLineDash([]);
    g.fillStyle = cssv('--dim'); g.textAlign = 'left'; g.fillText('bar', 2, 0);
  }

  // Pressure colour: blue for suction, neutral at ambient, red to white for pressure pulses.
  function pColor(p) {
    // Square-root scale so small waves still show: 0.15 bar of pulse is already bright orange.
    const k = Math.sign(p) * Math.min(1, Math.sqrt(Math.abs(p) / 15000));
    if (k >= 0) return `rgb(${Math.round(80 + 175 * k)},${Math.round(80 + 110 * k * k)},${Math.round(92 - 72 * k)})`;
    return `rgb(${Math.round(80 + 20 * k)},${Math.round(80 + 40 * -k)},${Math.round(92 - 163 * k)})`;
  }
  function pipe(g, t, x0, y0, x1, y1, scale) {
    const N = 14, wpx = Math.max(3, Math.sqrt(t.A / Math.PI) * 2 * scale);
    g.lineWidth = wpx; g.lineCap = 'butt';
    for (let k = 0; k < N; k++) {
      const u0 = k / N, u1 = (k + 1) / N;
      g.strokeStyle = pColor(core.pipePressure(t, (u0 + u1) / 2));
      g.beginPath(); g.moveTo(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0); g.lineTo(x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1); g.stroke();
    }
  }
  function drawExhaust() {
    const { g, w, h } = fit($v('#evExhaust'));
    g.clearRect(0, 0, w, h);
    const L = core.layout, nb = L.banks.length, sc = Math.min(h / nb / 0.25, 400);
    const cols = { port: 18, sec: w * 0.2, col: w * 0.32, turbo: w * 0.42, mid: w * 0.55, box: w * 0.72, tail: w * 0.86, end: w - 14 };
    const rowY = (b) => h * (nb > 1 ? (b + 0.5) / nb : 0.5);
    const labels = [];
    const bankEnd = {};
    L.banks.forEach((B, bi) => {
      const yc = rowY(bi), spread = Math.min(h / nb * 0.8, 18 * B.runners.length);
      const ys = B.runners.map((_, k) => yc - spread / 2 + spread * (k + 0.5) / B.runners.length);
      let xEnd = cols.col, yEnd = yc;
      if (B.secondaries) {
        const ya = (ys[0] + ys[2]) / 2, yb = (ys[1] + ys[3]) / 2;
        [0, 2].forEach((k) => pipe(g, B.runners[k], cols.port, ys[k], cols.sec, ya, sc));
        [1, 3].forEach((k) => pipe(g, B.runners[k], cols.port, ys[k], cols.sec, yb, sc));
        pipe(g, B.secondaries[0], cols.sec, ya, cols.col, yc, sc); pipe(g, B.secondaries[1], cols.sec, yb, cols.col, yc, sc);
      } else B.runners.forEach((r, k) => pipe(g, r, cols.port, ys[k], cols.col, yc, sc));
      pipe(g, B.collector, cols.col, yc, cols.turbo, yc, sc);
      xEnd = cols.turbo;
      if (B.turbine) {
        g.fillStyle = cssv('--surface-2'); g.beginPath(); g.arc(cols.turbo + 10, yc, 11, 0, Math.PI * 2); g.fill();
        pipe(g, B.turbine, cols.turbo, yc, cols.turbo + 20, yc, sc);
        pipe(g, B.downpipe, cols.turbo + 20, yc, cols.mid, yc, sc); xEnd = cols.mid;
        if (bi === 0) labels.push(['turbo', cols.turbo + 10]);
      }
      bankEnd[B.bank] = [xEnd, yc, B.turbine ? B.downpipe : B.collector];
      g.fillStyle = cssv('--dim'); g.font = `600 10px ${cssv('--font-ui')}`; g.textAlign = 'left';
      g.fillText(nb > 1 ? `Bank ${bi + 1}` : 'Headers', 2, Math.max(11, yc - spread / 2 - 6));
    });
    L.rear.forEach((R) => {
      const ys = R.banks.map((b) => bankEnd[b][1]), y = ys.reduce((s, v) => s + v, 0) / ys.length;
      const xs = R.banks.map((b) => bankEnd[b][0]), xm = Math.max(...xs);
      if (R.banks.length > 1) {
        // Banks merge: each bank's pipe runs into the junction, then one pipe to the silencer.
        R.banks.forEach((b, k) => pipe(g, bankEnd[b][2], bankEnd[b][0], ys[k], cols.mid, y, sc));
        pipe(g, R.mid, cols.mid, y, cols.box, y, sc);
        g.fillStyle = cssv('--fg'); g.beginPath(); g.arc(cols.mid, y, 3, 0, Math.PI * 2); g.fill();
      } else pipe(g, R.mid, bankEnd[R.banks[0]][0], ys[0], cols.box, y, sc);
      // Silencer box and its bypass.
      pipe(g, R.box, cols.box, y, cols.tail, y, sc * 0.55);
      g.strokeStyle = cssv('--line'); g.lineWidth = 1; g.strokeRect(cols.box, y - Math.sqrt(R.box.A / Math.PI) * sc * 0.55 - 2, cols.tail - cols.box, Math.sqrt(R.box.A / Math.PI) * 2 * sc * 0.55 + 4);
      R.tails.forEach((t, k) => { const ty = y + (k - (R.tails.length - 1) / 2) * 14; pipe(g, t, cols.tail, y, cols.end, ty, sc); });
    });
    labels.push(['headers', (cols.port + cols.col) / 2], ['collector', (cols.col + cols.turbo) / 2], ['silencer', (cols.box + cols.tail) / 2], ['tailpipes', (cols.tail + cols.end) / 2]);
    g.fillStyle = cssv('--dim'); g.font = `600 10px ${cssv('--font-ui')}`; g.textAlign = 'center';
    labels.forEach(([t, x]) => g.fillText(t.toUpperCase(), x, h - 4));
  }

  function drawStats() {
    const i = inputs(), mapBar = core.pPl / 101325;
    let peak = 0; const tr = core.cyl[sel].trace; if (tr) for (let k = 0; k < 360; k++) peak = Math.max(peak, tr[k]);
    $v('#evStats').innerHTML = [
      ['Revs', `${Math.round(i.rpm).toLocaleString('en')}<small>rpm</small>`],
      ['Throttle', i.cut ? 'shut<small>fuel cut</small>' : `${Math.round(S.load * 100)}<small>%</small>`],
      [mapBar > 1.02 ? 'Boost' : 'Manifold', mapBar > 1.02 ? `+${(mapBar - 1).toFixed(2)}<small>bar</small>` : `${mapBar.toFixed(2)}<small>bar</small>`],
      ['Peak pressure', `${Math.round(peak / 1e5)}<small>bar</small>`],
      ['Exhaust', `${Math.round(S.egt || 20)}<small>°C</small>`],
    ].map(([k, v]) => `<div><span class="cap">${k}</span><b>${v}</b></div>`).join('');
  }

  function frame() {
    if (!open) return;
    if (coreFor !== S.engineId) build();
    const i = inputs();
    // One engine cycle per `slow` seconds of screen time, whatever the revs.
    if (i.rpm > 0) {
      const cycle = 120 / i.rpm, steps = Math.max(1, Math.round(SR * cycle / slow / 60));
      advance(Math.min(steps, 2000));
    }
    drawCylinders(); drawTrace(); drawExhaust(); drawStats();
    $v('#evNote').textContent = i.rpm > 0
      ? `The same simulation as the sound, slowed ${Math.round(slow * i.rpm / 120)}× so one engine cycle takes ${slow} s.`
      : 'Start the engine to see it run.';
    raf = requestAnimationFrame(frame);
  }

  function show() {
    open = true; $v('#engineView').hidden = false;
    if (coreFor !== S.engineId || !core) build();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  }
  function hide() { open = false; $v('#engineView').hidden = true; cancelAnimationFrame(raf); }

  document.addEventListener('DOMContentLoaded', () => {});
  $v('#viewBtn').addEventListener('click', show);
  $v('#evClose').addEventListener('click', hide);
  $v('#evCyl').addEventListener('change', (ev) => { sel = +ev.target.value; });
  $v('#evCyls').addEventListener('click', (ev) => {
    const r = ev.currentTarget.getBoundingClientRect(), x = ev.clientX - r.left;
    core.cyl.forEach((c, i) => { if (c._hit && x >= c._hit[0] && x < c._hit[1]) { sel = i; $v('#evCyl').value = i; } });
  });
  document.querySelectorAll('[data-slow]').forEach((b) => b.addEventListener('click', () => {
    slow = +b.dataset.slow;
    document.querySelectorAll('[data-slow]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  }));
  addEventListener('keydown', (ev) => { if (ev.code === 'Escape' && open) hide(); });
  return { show, hide };
})();
