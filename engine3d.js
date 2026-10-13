// 3D engine: built from each car's real geometry (bore, stroke, rod, bank angle, header sizes)
// and driven every frame by the simulated engine in engine-view.js.

const Engine3D = (() => {
  const SC = 10; // metres to scene units
  let renderer = null, scene, camera, canvas = null, group = null, rig = null, keyFor = null;
  let yaw = -0.55, pitch = 0.62, dist = 8, target = null, auto = true;
  const pointers = new Map(); let pinch0 = 0, dist0 = 0;

  function loadThree() {
    if (window.THREE) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('3D library failed to load'));
      document.head.appendChild(s);
    });
  }

  function init(c) {
    canvas = c;
    renderer = new THREE.WebGLRenderer({ canvas: c, antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1, 0.05, 300);
    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x221a14, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.15); key.position.set(5, 8, 6); scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb0ff, 0.55); rim.position.set(-6, 3, -5); scene.add(rim);
    const under = new THREE.DirectionalLight(0xffb070, 0.25); under.position.set(0, -6, 2); scene.add(under);
    target = new THREE.Vector3();
    // Orbit: drag to turn, pinch or wheel to zoom.
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); auto = false; if (pointers.size === 2) { pinch0 = spread(); dist0 = dist; } });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) { yaw -= (e.clientX - px) * 0.008; pitch = Math.max(-1.3, Math.min(1.35, pitch + (e.clientY - py) * 0.006)); }
      else if (pointers.size === 2 && pinch0) dist = Math.max(2, Math.min(40, dist0 * pinch0 / spread()));
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = 0; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); dist = Math.max(2, Math.min(40, dist * (1 + Math.sign(e.deltaY) * 0.1))); auto = false; }, { passive: false });
  }
  const spread = () => { const p = [...pointers.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1; };

  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: o.m ?? 0.7, roughness: o.r ?? 0.35, transparent: o.t != null, opacity: o.t ?? 1, depthWrite: o.t == null, side: o.side ?? THREE.FrontSide, emissive: o.e ?? 0x000000 });
  const cyl = (r1, r2, h, m, seg = 24, open = false) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg, 1, open), m);
  const box = (x, y, z, m) => new THREE.Mesh(new THREE.BoxGeometry(x, y, z), m);

  function dispose() {
    if (!group) return;
    group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
    scene.remove(group); group = null;
  }

  function build(e, core) {
    dispose();
    const P = e.sound.physics, look = P.look, names = e.firingOrder.split('-');
    const bore = P.bore * SC, stroke = P.stroke * SC, r = stroke / 2, rod = (P.rod ?? P.stroke * 1.65) * SC;
    const hp = bore * 0.5, pitchX = bore * 1.3;
    group = new THREE.Group(); scene.add(group);
    rig = { cyl: [], cams: [], flywheel: null, pulley: null, runners: [], turbos: [], glow: [] };
    const M = {
      block: mat(0xaeb5bd, { m: 0.5, r: 0.5, t: 0.07, side: THREE.DoubleSide }),
      liner: mat(0xc9ced4, { m: 0.6, r: 0.3, t: 0.12, side: THREE.DoubleSide }),
      piston: mat(0xd4d8dd, { m: 0.85, r: 0.28 }),
      rod: mat(0x8d939b, { m: 0.9, r: 0.3 }),
      crank: mat(0x5d636b, { m: 0.95, r: 0.25 }),
      head: mat(0x9aa1a9, { m: 0.6, r: 0.4, t: 0.2, side: THREE.DoubleSide }),
      cover: mat(new THREE.Color(look.covers).getHex(), { m: 0.15, r: 0.75 }), // crinkle-finish paint
      cam: mat(0x7a8088, { m: 0.9, r: 0.25 }),
      valveIn: mat(0x5aa0ff, { m: 0.6, r: 0.3, e: 0x0a1a33 }),
      valveEx: mat(0xff6a3d, { m: 0.6, r: 0.3, e: 0x2a0a00 }),
      fly: mat(0x40454c, { m: 0.9, r: 0.3 }),
      stack: mat(0xb8bec6, { m: 0.95, r: 0.15 }),
      plenum: mat(0x2b2e33, { m: 0.4, r: 0.5 }),
      turbo: mat(0x8c8f94, { m: 0.85, r: 0.35 }),
    };
    const L = core.layout;
    const banks = L.banks.map((b) => [...b.cyls].sort((a, c) => names[a].localeCompare(names[c], undefined, { numeric: true })));
    const nb = banks.length, perBank = Math.max(...banks.map((b) => b.length));
    const tilt = (bi) => look.type === 'inline' ? 0 : (bi === 0 ? -1 : 1) * look.angle / 2 * Math.PI / 180;
    const yTop = r + rod + hp / 2 + bore * 0.08, headH = bore * 0.5;
    const len = perBank * pitchX + (nb > 1 ? pitchX * 0.5 : 0);

    // Crankshaft main journal, flywheel at the back, pulley at the front.
    const main = cyl(bore * 0.13, bore * 0.13, len + bore * 1.2, M.crank); main.rotation.z = Math.PI / 2; group.add(main);
    const fly = new THREE.Group(); fly.position.x = -len / 2 - bore * 0.55;
    const flyDisc = cyl(r * 3.4, r * 3.4, bore * 0.18, M.fly, 40); flyDisc.rotation.z = Math.PI / 2; fly.add(flyDisc);
    for (let k = 0; k < 6; k++) { const b = box(bore * 0.2, r * 0.6, r * 0.6, M.crank); b.position.set(-bore * 0.1, Math.cos(k) * r * 2.4, Math.sin(k) * r * 2.4); fly.add(b); }
    group.add(fly); rig.flywheel = fly;
    const pul = new THREE.Group(); pul.position.x = len / 2 + bore * 0.5;
    const pd = cyl(r * 1.4, r * 1.4, bore * 0.22, M.cam, 32); pd.rotation.z = Math.PI / 2; pul.add(pd);
    const pk = box(bore * 0.24, r * 0.4, r * 0.25, M.crank); pk.position.y = r * 1.1; pul.add(pk);
    group.add(pul); rig.pulley = pul;

    banks.forEach((cyls, bi) => {
      const a = tilt(bi), bank = new THREE.Group(); bank.rotation.x = a; group.add(bank);
      const exSign = look.type === 'inline' ? -1 : Math.sign(a);
      const xOff = nb > 1 ? (bi === 0 ? -0.25 : 0.25) * pitchX : 0;
      const xs = cyls.map((_, k) => (k - (cyls.length - 1) / 2) * pitchX + xOff);
      // Block, head and cam cover for this bank (see-through so the internals show).
      // The block is only the barrel around the cylinders, so the crank and rods stay visible.
      const blockH = r * 2 + hp + bore * 0.1;
      const blk = box(cyls.length * pitchX + bore * 0.3, blockH, bore * 1.3, M.block); blk.position.y = yTop - blockH / 2; bank.add(blk);
      const head = box(cyls.length * pitchX + bore * 0.3, headH, bore * 1.55, M.head); head.position.y = yTop + headH / 2; bank.add(head);
      const cover = box(cyls.length * pitchX + bore * 0.2, headH * 0.42, bore * 1.35, M.cover); cover.position.y = yTop + headH + headH * 0.21; bank.add(cover);
      // Camshafts: intake and exhaust, half crank speed, with a lobe per cylinder.
      [-1, 1].forEach((side) => {
        const cg = new THREE.Group(); cg.position.set(xOff, yTop + headH * 0.72, side * exSign * bore * 0.26);
        const shaft = cyl(bore * 0.06, bore * 0.06, cyls.length * pitchX + bore * 0.2, M.cam, 12); shaft.rotation.z = Math.PI / 2; cg.add(shaft);
        bank.add(cg); rig.cams.push({ g: cg, lobes: [] });
      });
      cyls.forEach((ci, k) => {
        const x = xs[k], c = { ci, a, bank, x, exSign };
        // Liner.
        const lh = yTop - (rod - r - hp / 2);
        const liner = cyl(bore / 2 * 1.04, bore / 2 * 1.04, lh, M.liner, 28, true); liner.position.set(x, yTop - lh / 2, 0); bank.add(liner);
        // Piston, rod, crank throw.
        c.piston = cyl(bore / 2, bore / 2, hp, M.piston, 28); c.piston.position.x = x; bank.add(c.piston);
        c.rod = box(bore * 0.16, rod, bore * 0.1, M.rod); c.rod.position.x = x; bank.add(c.rod);
        c.throw = new THREE.Group(); c.throw.position.x = x;
        const web = box(bore * 0.12, r * 2.1, bore * 0.5, M.crank); web.position.y = r * 0.25;
        const web2 = web.clone(); web.position.x = -bore * 0.22; web2.position.x = bore * 0.22;
        const cw = box(bore * 0.5, r * 0.8, bore * 0.7, M.crank); cw.position.y = -r * 0.9; // counterweight
        const pin = cyl(bore * 0.11, bore * 0.11, bore * 0.32, M.crank, 16); pin.rotation.z = Math.PI / 2; pin.position.y = r;
        c.throw.add(web, web2, cw, pin); bank.add(c.throw);
        // Combustion chamber glow.
        c.glow = new THREE.Mesh(new THREE.CircleGeometry(bore / 2 * 0.98, 28), new THREE.MeshBasicMaterial({ color: 0xffaa55, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        c.glow.rotation.x = Math.PI / 2; c.glow.position.set(x, yTop - bore * 0.02, 0); bank.add(c.glow);
        c.light = new THREE.Mesh(new THREE.CylinderGeometry(bore / 2 * 0.97, bore / 2 * 0.97, 1, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0xff8833, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        c.light.position.x = x; bank.add(c.light);
        // Valves: two intake, two exhaust.
        c.valves = [];
        [[-1, M.valveIn, 0], [1, M.valveEx, 1]].forEach(([side, m, which]) => {
          for (const dx of [-0.2, 0.2]) {
            const v = new THREE.Group();
            const stem = cyl(bore * 0.025, bore * 0.025, headH * 0.8, m, 8); stem.position.y = headH * 0.4;
            const disc = cyl(bore * 0.13, bore * 0.11, bore * 0.03, m, 16);
            v.add(stem, disc); v.position.set(x + dx * bore, yTop + bore * 0.01, side * exSign * bore * 0.24); bank.add(v);
            c.valves.push({ v, which });
          }
        });
        // Cam lobes.
        const ph = core.cyl[ci].off / 2 * Math.PI / 180;
        addLobe(rig.cams[rig.cams.length - 2].g, x - xOff, bore, M.cam, ph);
        addLobe(rig.cams[rig.cams.length - 1].g, x - xOff, bore, M.cam, ph + 0.9);
        // Velocity stacks on individual throttle bodies.
        if (look.stacks) {
          const st = cyl(bore * 0.24, bore * 0.17, bore * 0.7, M.stack, 20, true);
          st.position.set(x, yTop + headH * 0.9, -exSign * bore * 1.05); st.rotation.x = -exSign * 0.5; bank.add(st);
        }
        rig.cyl[ci] = c;
      });
      bank.updateMatrixWorld(true);
    });
    group.updateMatrixWorld(true);

    // Intake plenum: in the V, on top of a flat engine, beside an inline one.
    if (!look.stacks) {
      const pl = box(len * 0.85, bore * 0.6, bore * 1.0, M.plenum);
      pl.position.set(0, look.type === 'v' ? yTop * 1.15 : look.type === 'flat' ? bore * 1.6 : yTop * 0.8, look.type === 'inline' ? bore * 1.5 : 0);
      group.add(pl);
    }

    // Exhaust headers: out of each port, curving down and back to a collector under the bank.
    L.banks.forEach((B, bi) => {
      const cyls = B.cyls, sideCyl = rig.cyl[cyls[0]];
      const outward = new THREE.Vector3(0, 0, sideCyl.exSign * 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), sideCyl.a);
      const portsW = cyls.map((ci) => { const c = rig.cyl[ci]; return c.bank.localToWorld(new THREE.Vector3(c.x, yTop - bore * 0.05, c.exSign * bore * 0.78)); });
      const xMean = portsW.reduce((s, v) => s + v.x, 0) / portsW.length;
      const down = look.type === 'flat' ? -1.0 : -0.6;
      const coll = new THREE.Vector3(len / 2 + bore * 0.8, (look.type === 'flat' ? -r - rod * 0.9 : -r - rod * 0.6), portsW[0].z + outward.z * bore * 1.2);
      B.runners.forEach((tube, k) => {
        const p0 = portsW[k], p1 = p0.clone().addScaledVector(outward, bore * 0.7);
        const p2 = new THREE.Vector3(p0.x * 0.6 + coll.x * 0.4, p1.y + down * rod * 0.9, p1.z + outward.z * bore * 0.4);
        const curve = new THREE.CatmullRomCurve3([p0, p1, p2, coll]);
        const m = mat(0x6b625a, { m: 0.85, r: 0.4, e: 0x000000 });
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, P.exhaust.runnerD / 2 * SC, 10), m);
        group.add(mesh); rig.runners.push({ m, tube, base: 0 });
      });
      // Collector and the pipe on to the back, or a turbo.
      const end = coll.clone().add(new THREE.Vector3(bore * 2.2, -bore * 0.2, -outward.z * bore * 0.2));
      if (B.turbine) {
        const tg = new THREE.Group(); tg.position.copy(coll).add(new THREE.Vector3(bore * 0.5, 0, 0));
        const snail = new THREE.Mesh(new THREE.TorusGeometry(bore * 0.42, bore * 0.2, 12, 28), M.turbo); snail.rotation.y = Math.PI / 2; tg.add(snail);
        const wheel = new THREE.Group();
        for (let k = 0; k < 9; k++) { const blade = box(bore * 0.03, bore * 0.32, bore * 0.08, M.cam); blade.rotation.x = k / 9 * Math.PI * 2; blade.position.set(0, Math.cos(k / 9 * Math.PI * 2) * bore * 0.16, Math.sin(k / 9 * Math.PI * 2) * bore * 0.16); wheel.add(blade); }
        tg.add(wheel); group.add(tg); rig.turbos.push(wheel);
      }
      const cm = mat(0x6b625a, { m: 0.85, r: 0.4 });
      const cmesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(coll, end), 8, P.exhaust.collectorD / 2 * SC, 12), cm);
      group.add(cmesh); rig.runners.push({ m: cm, tube: B.collector, base: 0 });
    });

    // Frame the camera on the engine.
    const bb = new THREE.Box3().setFromObject(group), size = bb.getSize(new THREE.Vector3()).length();
    bb.getCenter(target); dist = size * 0.95; yaw = -0.55; pitch = 0.62;
  }

  function addLobe(cg, x, bore, m, phase) {
    const pivot = new THREE.Group(); pivot.position.x = x; pivot.rotation.x = -phase;
    const lobe = box(bore * 0.1, bore * 0.22, bore * 0.14, m); lobe.position.y = bore * 0.06; pivot.add(lobe); cg.add(pivot); return pivot;
  }

  // Heat colour for the headers: dull steel, then dull red, orange, bright yellow.
  // Real heat colours: nothing below ~550 °C, then dull cherry red, orange, and only near 1,000 °C yellow.
  function heat(k) {
    const c = new THREE.Color();
    c.setRGB(Math.min(1, k * 1.2) * 0.9, Math.max(0, k - 0.45) * 0.7, Math.max(0, k - 0.9) * 0.8);
    return c;
  }

  function update(core, e, egtC, boostBar) {
    if (!group) return;
    const P = e.sound.physics, bore = P.bore * SC, r = P.stroke * SC / 2, rod = (P.rod ?? P.stroke * 1.65) * SC;
    const yTop = r + rod + bore * 0.25 + bore * 0.08, amax = Math.PI * P.inValve * P.inValve / 4 * (P.valves / 2) * 0.85 * 0.68;
    let crank = 0;
    rig.cyl.forEach((c, i) => {
      if (!c) return;
      const st = core.cyl[i], th = (st.th || 0) * Math.PI / 180, tc = th % (Math.PI * 2);
      if (i === 0) crank = tc;
      const s = r * Math.cos(tc) + Math.sqrt(rod * rod - (r * Math.sin(tc)) ** 2);
      c.piston.position.y = s;
      c.throw.rotation.x = tc;
      const py = r * Math.cos(tc), pz = r * Math.sin(tc), vy = s - py, vz = -pz;
      c.rod.position.set(c.x, (s + py) / 2, (pz) / 2);
      c.rod.rotation.x = Math.atan2(vz, vy);
      // Valves drop by their lift (shown at twice scale so it reads).
      const [Ai, Ae] = st.lift || [0, 0];
      c.valves.forEach(({ v, which }) => { v.position.y = yTop + bore * 0.01 - Math.min(1, (which ? Ae : Ai) / amax) * bore * 0.12; });
      // Gas glow: hot burning charge lights the chamber; it fades as it expands.
      const T = st.T || 300, burn = st.xb > 0 && st.xb < 1 ? 1 - st.xb * 0.6 : 0;
      const k = Math.max(0, Math.min(1, (T - 700) / 1800));
      c.glow.material.opacity = Math.min(1, k * 0.9 + burn * 0.6);
      c.glow.material.color.setRGB(1, 0.55 + 0.4 * k + 0.3 * burn, 0.25 + 0.6 * burn);
      const gasH = Math.max(0.01, yTop - (s + bore * 0.25));
      c.light.scale.y = gasH; c.light.position.y = yTop - gasH / 2;
      c.light.material.opacity = Math.min(0.8, k * 0.45 + burn * 0.5);
    });
    rig.cams.forEach(({ g }) => { g.rotation.x = crank / 2; });
    rig.flywheel.rotation.x = crank; rig.pulley.rotation.x = crank;
    rig.turbos.forEach((w) => { w.rotation.x += 0.05 + boostBar * 0.6; });
    // Headers glow with exhaust temperature, and flash with each pulse passing.
    const hk = Math.max(0, Math.min(1, (egtC - 550) / 450));
    rig.runners.forEach((rn) => {
      const p = core.pipePressure(rn.tube, 0.25), pulse = Math.max(0, Math.min(1, p / 30000));
      // Each exhaust pulse flashes its pipe a little brighter as it passes.
      rn.m.emissive.copy(heat(Math.min(1, hk + pulse * 0.25 * (0.3 + hk))));
      rn.m.emissiveIntensity = 0.9;
    });
  }

  function render() {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
    }
    if (auto) yaw += 0.0025;
    camera.position.set(target.x + dist * Math.cos(pitch) * Math.sin(yaw), target.y + dist * Math.sin(pitch), target.z + dist * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(target);
    scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0a0b0d');
    renderer.render(scene, camera);
  }

  async function ensure(c, e, core, id) {
    await loadThree();
    if (!renderer) init(c);
    if (keyFor !== id) { build(e, core); keyFor = id; auto = true; }
  }

  return { ensure, update, render, get ready() { return !!renderer && !!group; }, reset() { keyFor = null; } };
})();
