'use strict';
/* ASHBEARER v3 :: core.js
   OWNER: foundation architect. FROZEN after the foundation phase: do not edit.
   If you need something from core that is missing, add it in YOUR module under your own
   namespace (AB.<yours>.*) and talk to other modules through AB + AB.bus (see INTERFACES.md).

   Files are classic scripts loaded in order by js/boot.js; three.js + addons come from vendor/three.bundle.js
   (window.ABVendor). `AB` is declared once here and shared by every later file (global lexical scope).

   Provides: AB namespace, AB.THREE, AB.addons, AB.C (content), AB.util, AB.RNG/AB.rng, AB.store,
   AB.bus, AB.settings, AB.renderer/scene/camera, AB.post (composer + grade pass), AB.quality,
   AB.loop (fixed-step sim + render toggle + fastForward + slowmo), AB.input, AB.cam (3rd-person rig),
   AB.core (init/resize/stats).                                                                      */


// three.js + addons come from vendor/three.bundle.js (window.ABVendor), loaded before this file.
const { THREE, Sky, Water, Reflector, Lensflare, LensflareElement, EffectComposer, RenderPass, UnrealBloomPass, OutputPass, ShaderPass, FXAAShader, SimplexNoise, ImprovedNoise, MeshSurfaceSampler, Octree, Capsule, RoundedBoxGeometry, ConvexGeometry, RoomEnvironment, CSM, DecalGeometry, CCDIKSolver, BufferGeometryUtils } = window.ABVendor;

const AB = (window.AB = window.AB || {});

AB.VERSION = '3.0.0';
AB.THREE = THREE;
AB.addons = {
  Sky, Water, Reflector, Lensflare, LensflareElement,
  EffectComposer, RenderPass, UnrealBloomPass, OutputPass, ShaderPass, FXAAShader,
  BufferGeometryUtils, SimplexNoise, ImprovedNoise, MeshSurfaceSampler, Octree, Capsule,
  RoundedBoxGeometry, ConvexGeometry, RoomEnvironment, CSM, DecalGeometry, CCDIKSolver
};
AB.C = window.ASHBEARER_CONTENT || null;   // read-only content (never mutate)

// ======================================================================================
// UTIL (pure helpers; allocation-free unless noted)
// ======================================================================================
{
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
  const _sv = new THREE.Vector3();
  AB.util = {
    TAU,
    clamp,
    lerp,
    invLerp: (a, b, v) => (b === a ? 0 : (v - a) / (b - a)),
    smoothstep: (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
    // frame-rate independent exponential smoothing: lambda ~ 1/time-constant (higher = snappier)
    damp: (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt)),
    dampAngle: (cur, target, lambda, dt) => cur + wrapAngle(target - cur) * (1 - Math.exp(-lambda * dt)),
    dampV3: (cur, target, lambda, dt) => cur.lerp(target, 1 - Math.exp(-lambda * dt)),
    wrapAngle,
    // yaw convention: yaw 0 faces +Z; direction = (sin(yaw), 0, cos(yaw)); Object3D.rotation.y = yaw
    yawTo: (dx, dz) => Math.atan2(dx, dz),
    dirX: (yaw) => Math.sin(yaw),
    dirZ: (yaw) => Math.cos(yaw),
    dist2: (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); },
    distSq2: (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; },
    ease: {
      linear: (t) => t,
      in: (t) => t * t,
      out: (t) => 1 - (1 - t) * (1 - t),
      inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
      smooth: (t) => t * t * (3 - 2 * t)
    },
    hash32(input) {
      const s = String(input);
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
      return h >>> 0;
    },
    // Project a world point to CSS pixels relative to #ab-view. out = {x, y, visible, depth}. No allocation.
    toScreen(v, out) {
      out = out || {};
      const cam = AB.camera;
      if (!cam) { out.x = out.y = 0; out.visible = false; out.depth = 1; return out; }
      _sv.copy(v).project(cam);
      const w = AB.core.width, h = AB.core.height;
      out.x = (_sv.x * 0.5 + 0.5) * w;
      out.y = (-_sv.y * 0.5 + 0.5) * h;
      out.depth = _sv.z;
      out.visible = _sv.z > -1 && _sv.z < 1 && _sv.x > -1.15 && _sv.x < 1.15 && _sv.y > -1.15 && _sv.y < 1.15;
      return out;
    },
    // Dispose a subtree's GPU resources. Materials/textures/geometries flagged userData.shared === true are kept
    // (AB.tex caches set that flag). Removes obj from its parent.
    disposeObject(obj) {
      if (!obj) return;
      if (obj.parent) obj.parent.remove(obj);
      obj.traverse((o) => {
        if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) {
          if (!m || (m.userData && m.userData.shared)) continue;
          for (const k in m) {
            const t = m[k];
            if (t && t.isTexture && !(t.userData && t.userData.shared)) t.dispose();
          }
          m.dispose();
        }
        if (o.isInstancedMesh && o.dispose) o.dispose();
        if (o.isLight && o.shadow && o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
      });
    },
    fmtTime(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }
  };
}

// ======================================================================================
// RNG (mulberry32). Sim randomness ONLY from seeded RNGs; Math.random only for cosmetics.
// ======================================================================================
{
  class RNG {
    constructor(seed) { this.s = (typeof seed === 'number' ? seed : AB.util.hash32(seed)) >>> 0; }
    next() {
      let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    float(a = 0, b = 1) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }        // inclusive
    chance(p) { return this.next() < p; }
    pick(arr) { return arr && arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined; }
    shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    weighted(arr, wfn) {
      let tot = 0;
      for (const x of arr) tot += Math.max(0, wfn(x));
      if (tot <= 0) return this.pick(arr);
      let r = this.next() * tot;
      for (const x of arr) { r -= Math.max(0, wfn(x)); if (r < 0) return x; }
      return arr[arr.length - 1];
    }
    gauss() { let u = 0, v = 0; while (u === 0) u = this.next(); v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(AB.util.TAU * v); }
    fork(label) { return new RNG(AB.util.hash32(String(label) + ':' + this.s)); }
    get state() { return this.s; }
    set state(v) { this.s = v >>> 0; }
  }
  AB.RNG = RNG;
  AB.rng = (seed) => new RNG(seed);
  AB.rand = new RNG(12345);   // the RUN's sim RNG; game.js replaces it on newRun/load (combat rolls use AB.rand)
}

// ======================================================================================
// STORAGE (every access in try/catch; works with storage absent/throwing)
// ======================================================================================
AB.store = {
  get(key, fallback = null) { try { const s = window.localStorage.getItem(key); return s == null ? fallback : JSON.parse(s); } catch (e) { return fallback; } },
  set(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },
  remove(key) { try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ } }
};

// ======================================================================================
// EVENT BUS. Synchronous, registration order. A throwing listener is logged and skipped.
// ======================================================================================
{
  const map = new Map();
  const errSeen = new Set();
  AB.bus = {
    on(name, fn) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(fn);
      return () => AB.bus.off(name, fn);
    },
    once(name, fn) { const off = AB.bus.on(name, (p) => { off(); fn(p); }); return off; },
    off(name, fn) { const l = map.get(name); if (!l) return; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    emit(name, payload) {
      const l = map.get(name);
      if (!l || !l.length) return;
      const copy = l.length === 1 ? l : l.slice();
      for (let i = 0; i < copy.length; i++) {
        try { copy[i](payload); } catch (e) {
          const key = name + ':' + (e && e.message);
          if (!errSeen.has(key) && errSeen.size < 200) { errSeen.add(key); console.error('[AB.bus] listener for "' + name + '" threw:', e); }
        }
      }
    },
    count(name) { const l = map.get(name); return l ? l.length : 0; }
  };
}

// ======================================================================================
// SETTINGS (persisted prefs). Change with AB.setSetting(key, value) -> emits 'settings'.
// ======================================================================================
{
  const PREFS_KEY = 'ashbearer_v3_prefs';
  let reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* ignore */ }
  const defaults = { quality: 'auto', sound: true, volume: 0.8, music: 0.7, sensitivity: 1, invertY: false, shake: true, reducedMotion: reduced };
  AB.settings = Object.assign({}, defaults, AB.store.get(PREFS_KEY, {}) || {});
  AB.setSetting = (key, value) => {
    if (!(key in defaults)) return;
    AB.settings[key] = value;
    AB.store.set(PREFS_KEY, AB.settings);
    if (key === 'quality') AB.quality.set(value === 'auto' ? AB.quality.tier : value, { auto: value === 'auto', save: false });
    AB.bus.emit('settings', { key, value, settings: AB.settings });
  };
}

// ======================================================================================
// QUALITY TIERS + adaptive measurement
// ======================================================================================
{
  const TIERS = {
    high:   { tier: 'high',   shadows: true, shadowMapSize: 2048, foliageShadows: true,  bloom: true,  grass: 30000, pixelRatio: 2,   msaa: 4, particles: 1.0,  drawDistance: 320, detail: 1.0 },
    medium: { tier: 'medium', shadows: true, shadowMapSize: 1024, foliageShadows: true,  bloom: true,  grass: 12000, pixelRatio: 1.5, msaa: 2, particles: 0.7,  drawDistance: 240, detail: 0.75 },
    low:    { tier: 'low',    shadows: true, shadowMapSize: 1024, foliageShadows: false, bloom: false, grass: 4000,  pixelRatio: 1,   msaa: 0, particles: 0.45, drawDistance: 180, detail: 0.5 }
  };
  const ORDER = ['low', 'medium', 'high'];
  // First-launch auto preset: phones and low-end / software GPUs -> low, tablets -> medium, others -> high.
  // Detected once and remembered (AUTO_KEY); the in-game fps measurement can still step it down.
  const AUTO_KEY = 'ashbearer_v3_autotier';
  function detectTier() {
    let coarse = false, phone = false, gpu = '';
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { /* ignore */ }
    const sw = Math.min(screen.width || 0, screen.height || 0) || Math.min(innerWidth, innerHeight);
    phone = (coarse && sw <= 600) || /iPhone|iPod|Android.+Mobile|Mobile Safari/i.test(navigator.userAgent || '');
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      }
    } catch (e) { /* ignore */ }
    const weakGpu = /swiftshader|llvmpipe|softpipe|software|basic render|mali-[2-4]|mali-t|adreno \(tm\) [2-5]\d\d|powervr|sgx|videocore|intel.*(hd graphics [2-5]\d{2,3}|gma)/i.test(gpu);
    const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
    if (phone || weakGpu || mem <= 2 || cores <= 2) return 'low';
    if (coarse || mem <= 4 || cores <= 4) return 'medium';
    return 'high';
  }
  let autoTier = AB.store.get(AUTO_KEY, null);
  if (AB.settings.quality === 'auto' && !TIERS[autoTier]) { autoTier = detectTier(); AB.store.set(AUTO_KEY, autoTier); }
  const startTier = AB.settings.quality !== 'auto' && TIERS[AB.settings.quality] ? AB.settings.quality : (TIERS[autoTier] ? autoTier : 'medium');
  const meas = { on: false, t: 0, frames: 0, rounds: 0 };
  AB.quality = {
    TIERS,
    tier: startTier,
    settings: Object.assign({}, TIERS[startTier]),
    auto: AB.settings.quality === 'auto',
    // set(tier, {auto}) : apply a tier now (renderer, composer, bloom) and emit 'quality' {tier, settings}
    set(tier, opts = {}) {
      if (!TIERS[tier]) return;
      if (opts.auto != null) AB.quality.auto = !!opts.auto;
      const changed = tier !== AB.quality.tier;
      AB.quality.tier = tier;
      AB.quality.settings = Object.assign({}, TIERS[tier]);
      if (AB.core && AB.core.applyQuality) AB.core.applyQuality();
      if (changed || opts.force) AB.bus.emit('quality', { tier, settings: AB.quality.settings });
    },
    // Start a 3 s fps measurement (call after each level load). When auto, steps down a tier if slow.
    measure() { meas.on = true; meas.t = 0; meas.frames = 0; meas.rounds = 0; },
    _frame(realDt) {
      if (!meas.on || !AB.loop.render) return;
      meas.t += realDt; meas.frames++;
      if (meas.t < 3) return;
      const fps = meas.frames / meas.t;
      AB.quality.lastMeasured = fps;
      meas.on = false;
      if (!AB.quality.auto) return;
      const i = ORDER.indexOf(AB.quality.tier);
      const floor = AB.quality.tier === 'high' ? 50 : 28;
      // first trade resolution (0.25 steps down to 1.0) on HIGH, only then step the tier down
      const s = AB.quality.settings, dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      if (fps < floor && AB.quality.tier === 'high' && Math.min(dpr, s.pixelRatio) > 1.01) {
        s.pixelRatio = Math.max(1, Math.min(dpr, s.pixelRatio) - 0.25);
        if (AB.core && AB.core.resize) AB.core.resize();
        meas.on = true; meas.t = 0; meas.frames = 0;
        return;
      }
      if (fps < floor && i > 0) {
        AB.quality.set(ORDER[i - 1]);
        if (++meas.rounds < 2) { meas.on = true; meas.t = 0; meas.frames = 0; }
      }
    },
    lastMeasured: 0
  };
}

// ======================================================================================
// LOOP: fixed-step simulation (1/60 s) + per-frame visuals + render toggle + fastForward + slowmo
// ======================================================================================
{
  const STEP = 1 / 60;
  const systems = [];          // {name, fn, phase, order, always}
  let stepList = [], frameList = [];
  const errCount = new Map();
  function rebuild() {
    systems.sort((a, b) => a.order - b.order);
    stepList = systems.filter((s) => s.phase === 'step');
    frameList = systems.filter((s) => s.phase === 'frame');
  }
  function call(s, a, b) {
    try { s.fn(a, b); } catch (e) {
      const k = s.name + ':' + (e && e.message);
      const n = (errCount.get(k) || 0) + 1;
      errCount.set(k, n);
      AB.loop.errors++;
      if (n <= 3) console.error('[AB.loop] system "' + s.name + '" threw:', e);
    }
  }
  let acc = 0, last = 0, running = false, slowT = 0, slowScale = 1, fpsT = 0, fpsN = 0;
  const loop = AB.loop = {
    STEP,
    ORDER: { input: 0, bot: 10, game: 20, combat: 30, world: 40, actors: 50, vfx: 60, camera: 70, ui: 80, audio: 90 },
    time: 0,          // simulation seconds since boot (advances only in steps)
    frame: 0,         // rendered frames
    steps: 0,         // sim steps run
    render: true,     // false = run sim + frame systems but skip GPU rendering
    simPaused: false, // true = step systems without {always:true} are skipped (modal screens, cinematics)
    timeScale: 1,     // multiplies real time fed to the sim (slowmo uses it)
    fps: 0,
    errors: 0,
    fastForwarding: false,
    // add(name, fn, {phase:'step'|'frame', order, always}) ; step fn(dt) ; frame fn(dt, realDt)
    add(name, fn, opts = {}) {
      loop.remove(name);
      systems.push({ name, fn, phase: opts.phase || 'step', order: opts.order != null ? opts.order : 50, always: !!opts.always });
      rebuild();
    },
    remove(name) { const i = systems.findIndex((s) => s.name === name); if (i >= 0) { systems.splice(i, 1); rebuild(); } },
    list() { return systems.map((s) => ({ name: s.name, phase: s.phase, order: s.order, always: s.always })); },
    step(dt) {
      AB.input._beginStep(dt);
      for (let i = 0; i < stepList.length; i++) {
        const s = stepList[i];
        if (loop.simPaused && !s.always) continue;
        call(s, dt);
      }
      AB.input._endStep();
      loop.time += dt;
      loop.steps++;
    },
    // Run the simulation for `seconds` of sim time synchronously, WITHOUT frame systems or rendering.
    fastForward(seconds) {
      const n = Math.max(0, Math.round(seconds / STEP));
      const t0 = performance.now();
      loop.fastForwarding = true;
      try { for (let i = 0; i < n; i++) loop.step(STEP); } finally { loop.fastForwarding = false; }
      acc = 0;
      return { steps: n, ms: Math.round(performance.now() - t0) };
    },
    // Slow motion: sim runs at `scale` for `dur` REAL seconds (e.g. slowmo(0.3, 0.3) on boss kills).
    slowmo(scale, dur) { slowScale = AB.util.clamp(scale, 0.05, 1); slowT = Math.max(slowT, dur); },
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(tick);
    },
    stop() { running = false; },
    get running() { return running; }
  };
  // Pause the whole loop (sim + rendering) while the tab is hidden; resume where it left off on return.
  let hiddenStop = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (running) { hiddenStop = true; loop.stop(); } }
    else if (hiddenStop) { hiddenStop = false; acc = 0; loop.start(); }
  });
  function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    let realDt = (now - last) / 1000;
    last = now;
    if (!(realDt > 0)) realDt = 0;
    if (realDt > 0.1) realDt = 0.1;
    if (slowT > 0) { slowT -= realDt; if (slowT <= 0) slowScale = 1; }
    const scale = loop.timeScale * slowScale;
    acc += realDt * scale;
    let n = 0;
    while (acc >= STEP && n < 6) { loop.step(STEP); acc -= STEP; n++; }
    if (n >= 6) acc = 0;
    const vdt = realDt * scale;
    for (let i = 0; i < frameList.length; i++) call(frameList[i], vdt, realDt);
    AB.input._endFrame();
    fpsT += realDt; fpsN++;
    if (fpsT >= 1) { loop.fps = Math.round((fpsN / fpsT) * 10) / 10; fpsT = 0; fpsN = 0; }
    AB.quality._frame(realDt);
    if (loop.render) AB.core.render();
    loop.frame++;
  }
}

// ======================================================================================
// INPUT: keyboard + mouse + touch (floating joystick, right-half look) + gamepad
// Gameplay reads AB.input.move / moveWorld / pressed(a) / held(a) inside STEP systems.
// ======================================================================================
{
  const ACTIONS = ['attack', 'skill1', 'skill2', 'ember', 'dodge', 'interact', 'switch1', 'switch2', 'switch3', 'switch4',
    'pause', 'inventory', 'party', 'target', 'map', 'sprint'];
  const KEYMAP = {
    KeyJ: 'attack', KeyK: 'skill1', KeyL: 'skill2', KeyQ: 'ember', Space: 'dodge', KeyE: 'interact',
    Digit1: 'switch1', Digit2: 'switch2', Digit3: 'switch3', Digit4: 'switch4',
    Numpad1: 'switch1', Numpad2: 'switch2', Numpad3: 'switch3', Numpad4: 'switch4',
    Escape: 'pause', KeyP: 'pause', KeyI: 'inventory', Tab: 'party', KeyF: 'target', KeyM: 'map',
    ShiftLeft: 'sprint', ShiftRight: 'sprint'
  };
  const MOVEKEYS = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  const PAD = { 2: 'attack', 3: 'skill1', 4: 'skill2', 5: 'ember', 0: 'dodge', 1: 'interact', 9: 'pause', 8: 'inventory',
    12: 'switch1', 13: 'switch3', 14: 'switch4', 15: 'switch2', 10: 'target', 7: 'attack', 6: 'sprint' };

  let pending = new Set(), stepPressed = new Set();
  const heldKeys = new Set();        // KeyboardEvent.code currently down
  const heldActs = new Map();        // action -> count of sources holding it
  const mv = { u: 0, d: 0, l: 0, r: 0 };
  const joy = { id: -1, active: false, ox: 0, oy: 0, x: 0, y: 0, R: 60 };
  const look = { id: -1, lx: 0, ly: 0 };
  const mouse = { btn: -1, sx: 0, sy: 0, lx: 0, ly: 0, drag: false, t: 0 };
  const padPrev = [];
  let joyEl = null, knobEl = null, root = null, view = null;

  const holdAct = (a, on) => {
    const n = heldActs.get(a) || 0;
    if (on) { heldActs.set(a, n + 1); pending.add(a); }
    else if (n <= 1) heldActs.delete(a); else heldActs.set(a, n - 1);
  };
  const setDevice = (d) => {
    if (input.device === d) return;
    input.device = d;
    if (root) root.dataset.input = d;
    AB.bus.emit('input:device', { device: d });
  };

  const input = AB.input = {
    ACTIONS,
    move: { x: 0, y: 0 },          // stick/keys: x right, y forward; |v| <= 1
    moveWorld: { x: 0, z: 0 },     // camera-relative move converted to world XZ; |v| <= 1
    look: { dx: 0, dy: 0 },        // orbit deltas in CSS px since last frame (camera consumes)
    zoom: 0,                       // wheel delta since last frame (camera consumes)
    device: 'kbm',                 // 'kbm' | 'touch' | 'pad' (last used); mirrored to #ab-root[data-input]
    isTouch: false,                // coarse pointer device
    gameplay: false,               // game sets true during free play: enables preventDefault on Space/Tab/arrows
    joystick: joy,                 // read-only state of the floating joystick
    lastLookT: -99,                // AB.loop.time of the last manual orbit input
    pressed: (a) => stepPressed.has(a),          // true during exactly ONE sim step after the press
    held: (a) => heldActs.has(a),
    press(a) { holdAct(a, true); },             // programmatic hold start (DOM buttons): pressed() next step, held() until release
    release(a) { holdAct(a, false); },
    tap(a) { pending.add(a); },                 // one-shot press (bot, DOM)
    driven: false,                 // true when driveWorld() overrode moveWorld during the current step
    // Override moveWorld for the CURRENT step (call from a step system that runs before combat, e.g. the bot at order 10).
    driveWorld(x, z) { const l = Math.hypot(x, z); const k = l > 1 ? 1 / l : 1; input.moveWorld.x = x * k; input.moveWorld.z = z * k; input.driven = true; },
    clear() { pending.clear(); stepPressed.clear(); heldKeys.clear(); heldActs.clear(); mv.u = mv.d = mv.l = mv.r = 0; joy.active = false; joy.id = -1; joy.x = joy.y = 0; look.id = -1; mouse.btn = -1; showJoy(false); },
    _beginStep() {
      const t = stepPressed; stepPressed = pending; pending = t; pending.clear();
      let x = (mv.r ? 1 : 0) - (mv.l ? 1 : 0), y = (mv.u ? 1 : 0) - (mv.d ? 1 : 0);
      if (joy.active) { x += joy.x; y += joy.y; }
      pollPad();
      x += padAxes.x; y += padAxes.y;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      input.move.x = x; input.move.y = y;
      input.driven = false;
      const yaw = AB.cam ? AB.cam.yaw : 0;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      input.moveWorld.x = rx * x + fx * y;
      input.moveWorld.z = rz * x + fz * y;
    },
    _endStep() { /* reserved */ },
    _endFrame() { input.look.dx = 0; input.look.dy = 0; input.zoom = 0; },
    _attach() {
      root = document.getElementById('ab-root');
      view = document.getElementById('ab-view');
      try { input.isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { /* ignore */ }
      setDevice(input.isTouch ? 'touch' : 'kbm');
      if (root) root.dataset.input = input.device;
      const touchHost = document.getElementById('ab-touch') || root;
      if (touchHost) {
        joyEl = document.createElement('div'); joyEl.className = 'ab-joy'; joyEl.hidden = true;
        knobEl = document.createElement('div'); knobEl.className = 'ab-joy-knob';
        joyEl.appendChild(knobEl); touchHost.appendChild(joyEl);
      }
      window.addEventListener('keydown', onKey, { passive: false });
      window.addEventListener('keyup', onKey, { passive: false });
      window.addEventListener('blur', () => input.clear());
      document.addEventListener('visibilitychange', () => { if (document.hidden) input.clear(); });
      if (view) {
        view.addEventListener('pointerdown', onDown, { passive: false });
        view.addEventListener('pointermove', onMove, { passive: false });
        view.addEventListener('pointerup', onUp, { passive: false });
        view.addEventListener('pointercancel', onUp, { passive: false });
        view.addEventListener('contextmenu', (e) => e.preventDefault());
        view.addEventListener('wheel', (e) => { e.preventDefault(); input.zoom += Math.sign(e.deltaY) * Math.min(120, Math.abs(e.deltaY)); setDevice('kbm'); }, { passive: false });
      }
      window.addEventListener('gamepadconnected', () => setDevice('pad'));
    }
  };

  function isFormTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }
  function isActivatable(t) {
    if (!t || !t.tagName) return false;
    return t.tagName === 'BUTTON' || t.tagName === 'A' || t.getAttribute('role') === 'button' || t.tagName === 'SUMMARY';
  }
  function onKey(e) {
    const down = e.type === 'keydown';
    if (isFormTarget(e.target)) return;
    const code = e.code;
    if (down && (code === 'Space' || code === 'Enter') && isActivatable(e.target) && !input.gameplay) return;
    const m = MOVEKEYS[code];
    const a = KEYMAP[code];
    if (!m && !a) return;
    if (input.gameplay && (code === 'Space' || code === 'Tab' || code.startsWith('Arrow'))) e.preventDefault();
    // keep Tab for focus navigation in menus, except on the party screen it opened (Tab toggles it like I and M; integrator)
    if (!input.gameplay && code === 'Tab' && !(AB.state && AB.state.screen === 'party')) return;
    if (code === 'Tab' && AB.state && AB.state.screen === 'party') e.preventDefault();
    setDevice('kbm');
    if (down) {
      if (heldKeys.has(code)) return;   // ignore auto-repeat
      heldKeys.add(code);
      if (m) mv[m] = 1;
      if (a) holdAct(a, true);
    } else {
      heldKeys.delete(code);
      if (m) {
        // a direction is released only when no key for it remains
        let still = false;
        for (const k of heldKeys) if (MOVEKEYS[k] === m) still = true;
        if (!still) mv[m] = 0;
      }
      if (a) holdAct(a, false);
    }
  }
  function showJoy(on) {
    if (!joyEl) return;
    joyEl.hidden = !on;
    if (on) { joyEl.style.left = joy.ox + 'px'; joyEl.style.top = joy.oy + 'px'; knobEl.style.transform = 'translate(0px,0px)'; }
  }
  function localXY(e) {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, r.width];
  }
  function onDown(e) {
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const [x, y, w] = localXY(e);
    try { view.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (touch) {
      setDevice('touch');
      e.preventDefault();
      if (x < w * 0.5 && joy.id < 0) {
        joy.id = e.pointerId; joy.active = true; joy.ox = x; joy.oy = y; joy.x = joy.y = 0;
        showJoy(true);
      } else if (look.id < 0) {
        look.id = e.pointerId; look.lx = x; look.ly = y;
      }
      return;
    }
    setDevice('kbm');
    if (mouse.btn >= 0) return;
    mouse.btn = e.button; mouse.sx = mouse.lx = x; mouse.sy = mouse.ly = y; mouse.drag = false; mouse.t = performance.now();
    if (e.button === 0) holdAct('attack', true);
  }
  function onMove(e) {
    const [x, y] = localXY(e);
    if (e.pointerId === joy.id) {
      let dx = x - joy.ox, dy = y - joy.oy;
      const l = Math.hypot(dx, dy);
      if (l > joy.R) { dx *= joy.R / l; dy *= joy.R / l; }
      joy.x = dx / joy.R; joy.y = -dy / joy.R;
      const dl = Math.hypot(joy.x, joy.y);
      if (dl < 0.12) { joy.x = 0; joy.y = 0; }
      if (knobEl) knobEl.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
      return;
    }
    if (e.pointerId === look.id) {
      input.look.dx += (x - look.lx) * 1.25; input.look.dy += (y - look.ly) * 1.25;
      look.lx = x; look.ly = y;
      input.lastLookT = AB.loop.time;
      return;
    }
    if (mouse.btn >= 0) {
      if (!mouse.drag && Math.hypot(x - mouse.sx, y - mouse.sy) > 6) {
        mouse.drag = true;
        if (mouse.btn === 0) holdAct('attack', false);
      }
      if (mouse.drag) {
        input.look.dx += x - mouse.lx; input.look.dy += y - mouse.ly;
        input.lastLookT = AB.loop.time;
      }
      mouse.lx = x; mouse.ly = y;
    }
  }
  function onUp(e) {
    if (e.pointerId === joy.id) { joy.id = -1; joy.active = false; joy.x = joy.y = 0; showJoy(false); return; }
    if (e.pointerId === look.id) { look.id = -1; return; }
    if (mouse.btn >= 0 && (e.button === mouse.btn || e.type === 'pointercancel')) {
      if (mouse.btn === 0 && !mouse.drag) holdAct('attack', false);
      if (mouse.btn === 2 && !mouse.drag && performance.now() - mouse.t < 400) pending.add('skill1');
      mouse.btn = -1; mouse.drag = false;
    }
  }
  const padAxes = { x: 0, y: 0 };
  let padSeen = false;
  try { window.addEventListener('gamepadconnected', () => { padSeen = true; }); } catch (e) { /* ignore */ }
  function pollPad() {
    padAxes.x = padAxes.y = 0;
    if (!padSeen || !navigator.getGamepads) return;
    let pads;
    try { pads = navigator.getGamepads(); } catch (e) { return; }
    const p = pads && (pads[0] || pads[1]);
    if (!p) return;
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const lx = dz(p.axes[0] || 0), ly = dz(p.axes[1] || 0), rx = dz(p.axes[2] || 0), ry = dz(p.axes[3] || 0);
    if (lx || ly || rx || ry) setDevice('pad');
    padAxes.x = lx; padAxes.y = -ly;
    if (rx || ry) { input.look.dx += rx * 9; input.look.dy += ry * 7; input.lastLookT = AB.loop.time; }
    for (const k in PAD) {
      const b = p.buttons[k];
      const on = !!(b && (b.pressed || b.value > 0.5));
      if (on !== !!padPrev[k]) { holdAct(PAD[k], on); if (on) setDevice('pad'); }
      padPrev[k] = on;
    }
  }
}

// ======================================================================================
// CORE: renderer, scene, camera, post-processing, resize, render
// ======================================================================================
{
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uGrain: { value: 0.05 },
      uVignette: { value: 0.35 },
      uEmber: { value: 0 },
      uFade: { value: 0 },
      uSat: { value: 1 },
      uContrast: { value: 1 },
      uFlash: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uEmberColor: { value: new THREE.Color(0xff5a1f) }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uGrain, uVignette, uEmber, uFade, uSat, uContrast, uFlash;',
      'uniform vec3 uTint, uEmberColor; varying vec2 vUv;',
      'float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }',
      'void main(){',
      '  vec3 col = texture2D(tDiffuse, vUv).rgb;',
      '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
      '  col = mix(vec3(l), col, uSat);',
      '  col = (col - 0.5) * uContrast + 0.5;',
      '  col *= uTint;',
      '  vec2 d = vUv - 0.5; d.x *= uRes.x / max(uRes.y, 1.0);',
      '  float r = length(d);',
      '  col *= mix(1.0, smoothstep(0.95, 0.25, r), uVignette);',
      '  float pulse = 0.85 + 0.15 * sin(uTime * 2.4);',
      '  float edge = smoothstep(0.32, 0.9, r * (1.0 + 0.25 * uEmber));',
      '  col = mix(col, col * 0.55 + uEmberColor * 0.55, clamp(uEmber * edge * pulse, 0.0, 0.85));',
      '  col += uFlash;',
      '  col *= 1.0 - uFade;',
      '  float n = hash(vUv * uRes + fract(uTime * 7.31) * 113.0) - 0.5;',
      '  col += n * uGrain * (0.6 + 0.4 * (1.0 - l));',
      '  gl_FragColor = vec4(max(col, 0.0), 1.0);',
      '}'
    ].join('\n')
  };

  const core = AB.core = {
    ready: false,
    width: 1, height: 1,
    view: null, canvas: null,
    stats: { calls: 0, triangles: 0, geometries: 0, textures: 0 },
    init() {
      if (core.ready) return;
      core.view = document.getElementById('ab-view') || document.body;
      AB.scene = new THREE.Scene();
      AB.scene.background = new THREE.Color(0x141c26);
      AB.scene.fog = new THREE.FogExp2(0x8a9aa8, 0.008);
      AB.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 1500);
      AB.camera.position.set(0, 3, 8);
      AB.scene.add(AB.camera);   // so camera-attached objects (e.g. weather volumes) render
      try {
        AB.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false });
        AB.gl = true;
      } catch (e) {
        console.warn('[AB.core] WebGL unavailable:', e && e.message);
        AB.renderer = null; AB.gl = false;
      }
      if (AB.renderer) {
        const r = AB.renderer;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.shadowMap.enabled = true;
        r.shadowMap.type = THREE.PCFSoftShadowMap;
        r.info.autoReset = false;
        core.canvas = r.domElement;
        core.canvas.className = 'ab-canvas';
        core.canvas.setAttribute('tabindex', '-1');
        core.view.appendChild(core.canvas);
        const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: AB.quality.settings.msaa });
        const composer = new EffectComposer(r, rt);
        const renderPass = new RenderPass(AB.scene, AB.camera);
        const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.6, 0.86);
        const output = new OutputPass();
        const fxaa = new ShaderPass(FXAAShader);
        const grade = new ShaderPass(GradeShader);
        composer.addPass(renderPass);
        composer.addPass(bloom);
        composer.addPass(output);
        composer.addPass(fxaa);
        composer.addPass(grade);
        AB.post = Object.assign(AB.post || {}, { composer, renderPass, bloom, output, fxaa, grade, uniforms: grade.uniforms });
      } else {
        AB.post = AB.post || {};
      }
      AB.input._attach();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => core.resize()) : null;
      if (ro) ro.observe(core.view);
      window.addEventListener('resize', () => core.resize());
      core.applyQuality();
      core.resize();
      AB.loop.add('core.post', postFrame, { phase: 'frame', order: 75 });
      AB.loop.add('camera', (dt, realDt) => AB.cam.update(dt, realDt), { phase: 'frame', order: AB.loop.ORDER.camera });
      core.ready = true;
    },
    resize() {
      const v = core.view;
      const w = Math.max(1, (v && v.clientWidth) || window.innerWidth || 1);
      const h = Math.max(1, (v && v.clientHeight) || window.innerHeight || 1);
      core.width = w; core.height = h;
      if (AB.camera) { AB.camera.aspect = w / h; AB.camera.updateProjectionMatrix(); }
      // portrait phones: keep ~37 deg of horizontal view (a fixed 52 deg vertical FOV is a 25 deg slit at 390x844)
      if (AB.cam) { const a = w / h; AB.cam.baseFov = a < 1 ? Math.min(74, 2 * Math.atan(Math.tan(26 * Math.PI / 180) / Math.sqrt(a)) * 180 / Math.PI) : 52; }
      if (!AB.renderer) return;
      const pr = Math.min(window.devicePixelRatio || 1, AB.quality.settings.pixelRatio, 2);
      AB.renderer.setPixelRatio(pr);
      AB.renderer.setSize(w, h, false);
      core.canvas.style.width = w + 'px';
      core.canvas.style.height = h + 'px';
      const p = AB.post;
      if (p.composer) {
        p.composer.setPixelRatio(pr);
        p.composer.setSize(w, h);
        // UnrealBloomPass ignores .resolution after construction; setSize drives its mip chain. Below HIGH the chain
        // starts at quarter resolution (4x fewer bloom pixels, the same soft glow).
        if (AB.quality.tier !== 'high') p.bloom.setSize(Math.round(w * pr * 0.5), Math.round(h * pr * 0.5));
        p.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        p.uniforms.uRes.value.set(w * pr, h * pr);
      }
      AB.bus.emit('resize', { width: w, height: h });
    },
    applyQuality() {
      const q = AB.quality.settings;
      if (!AB.renderer) return;
      AB.renderer.shadowMap.enabled = q.shadows;
      const p = AB.post;
      if (p.composer) {
        p.bloom.enabled = q.bloom;
        p.fxaa.enabled = q.msaa === 0;
        for (const rt of [p.composer.renderTarget1, p.composer.renderTarget2]) {
          if (rt.samples !== q.msaa) { rt.samples = q.msaa; rt.dispose(); }
        }
      }
      core.resize();
    },
    render() {
      if (!AB.renderer || !AB.scene || !AB.camera) return;
      const info = AB.renderer.info;
      info.reset();
      const p = AB.post;
      if (p.composer && p.enabled !== false) p.composer.render();
      else AB.renderer.render(AB.scene, AB.camera);
      core.stats.calls = info.render.calls;
      core.stats.triangles = info.render.triangles;
      core.stats.geometries = info.memory.geometries;
      core.stats.textures = info.memory.textures;
    },
    // Render one frame right now (used by tests/screenshots after fastForward).
    renderNow() { for (let i = 0; i < 2; i++) { AB.cam.update(1 / 60, 1 / 60); postFrame(1 / 60); } core.render(); }
  };

  // Post params: modules write these numbers; core copies them into the grade uniforms each frame.
  //  vignette 0..1 (base darkening), grain 0..0.2, ember 0..1 (Corruption edge glow; ui.js drives it),
  //  fade 0..1 (to black; game.js transitions), saturation, contrast, flash 0..1 (white add; decays), tint Color.
  AB.post = AB.post || {};
  AB.post.params = { vignette: 0.38, grain: 0.055, ember: 0, fade: 0, saturation: 1, contrast: 1.04, flash: 0, tint: new THREE.Color(1, 1, 1) };
  AB.post.bloomParams = { strength: 0.55, radius: 0.6, threshold: 0.86 };
  const fadeTween = { on: false, from: 0, to: 0, t: 0, dur: 1 };
  // Real-time (frame) fade. Cosmetic only: never gate game flow on it (fastForward skips frames).
  AB.post.fadeTo = (to, dur = 0.6) => { fadeTween.on = true; fadeTween.from = AB.post.params.fade; fadeTween.to = to; fadeTween.t = 0; fadeTween.dur = Math.max(0.001, dur); };
  AB.post.flash = (amount = 0.35) => { AB.post.params.flash = Math.max(AB.post.params.flash, amount); };
  function postFrame(dt, realDt) {
    const p = AB.post;
    const pr = p.params;
    if (fadeTween.on) {
      fadeTween.t += realDt || dt;
      const k = Math.min(1, fadeTween.t / fadeTween.dur);
      pr.fade = fadeTween.from + (fadeTween.to - fadeTween.from) * AB.util.ease.inOut(k);
      if (k >= 1) fadeTween.on = false;
    }
    if (pr.flash > 0) pr.flash = Math.max(0, pr.flash - (realDt || dt) * 2.5);
    if (!p.uniforms) return;
    const u = p.uniforms;
    u.uTime.value = AB.loop.time + AB.loop.frame * 0.0001;
    u.uGrain.value = pr.grain;
    u.uVignette.value = pr.vignette;
    u.uEmber.value = pr.ember;
    u.uFade.value = pr.fade;
    u.uSat.value = pr.saturation;
    u.uContrast.value = pr.contrast;
    u.uFlash.value = pr.flash;
    u.uTint.value.copy(pr.tint);
    if (p.bloom) { p.bloom.strength = p.bloomParams.strength; p.bloom.radius = p.bloomParams.radius; p.bloom.threshold = p.bloomParams.threshold; }
  }
}

// ======================================================================================
// CAMERA RIG: third-person follow + orbit + zoom + terrain/hook collision + shake + fov kick
//             + cinematic shots. Runs as a FRAME system (order 70).
// Camera position = focus + (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch)) * dist
// ======================================================================================
{
  const V = THREE.Vector3;
  const U = AB.util;
  const desired = new V(), tmp = new V(), lookPt = new V(), shakeOff = new V(), shotPos = new V(), shotLook = new V();
  let curDist = 7, shakeAmp = 0, shakeT = 0, shakeDur = 0.0001, kick = 0, kickT = 0, kickDur = 0.0001, lastFov = 0;
  let shots = null, shotIdx = 0, shotT = 0, shotOpts = null;
  const cam = AB.cam = {
    mode: 'follow',            // 'follow' | 'cinematic' | 'fixed'
    target: null,              // anything with .pos (Vector3, feet position) e.g. a Unit; optional .height (m)
    yaw: 0, pitch: 0.3, dist: 7,
    minDist: 2.2, maxDist: 14, minPitch: -0.3, maxPitch: 1.2,
    height: 1.45,              // look height above target feet when target.height is unknown
    focus: new V(),            // smoothed look-at point (world reads it to centre the shadow camera)
    position: new V(0, 3, 8),  // smoothed camera position (before shake)
    lockOn: null,              // optional Vector3 / {pos}: frame it with the target (combat lock-on assist)
    autoRecenter: true,
    collide: null,             // optional fn(from: Vector3, to: Vector3) -> allowed distance (m) or null (world sets)
    baseFov: 52,
    follow(target, opts = {}) {
      cam.target = target;
      cam.mode = 'follow';
      shots = null;
      if (opts.yaw != null) cam.yaw = opts.yaw;
      if (opts.pitch != null) cam.pitch = opts.pitch;
      if (opts.dist != null) cam.dist = opts.dist;
      if (opts.snap !== false) cam.snap();
    },
    snap() {
      if (!cam.target || !cam.target.pos) return;
      targetLook(lookPt);
      cam.focus.copy(lookPt);
      curDist = cam.dist;
      place(desired, cam.focus, cam.dist);
      groundClamp(desired);
      cam.position.copy(desired);
      applyToCamera(0);
    },
    shake(amp = 0.3, dur = 0.25) {
      if (!AB.settings.shake) return;
      const k = AB.settings.reducedMotion ? 0.35 : 1;
      shakeAmp = Math.max(shakeAmp * (shakeT / shakeDur), amp * k); shakeDur = Math.max(0.05, dur); shakeT = shakeDur;
    },
    fovKick(deg = 6, dur = 0.35) { kick = AB.settings.reducedMotion ? deg * 0.4 : deg; kickDur = Math.max(0.05, dur); kickT = kickDur; },
    // Cinematic shots. shot = { from:[x,y,z]|Vector3, to, lookFrom, lookTo, dur (s), ease?, fov? }
    //   or { fn(t, outPos, outLook), dur }. opts = { loop: bool, onDone() } (cosmetic only: never gate flow on it).
    play(list, opts = {}) {
      shots = (list || []).filter(Boolean); shotIdx = 0; shotT = 0; shotOpts = opts;
      cam.mode = shots.length ? 'cinematic' : 'follow';
      if (shots.length) evalShot(shots[0], 0);
      return { stop: () => cam.stop() };
    },
    stop(opts = {}) {
      shots = null;
      cam.mode = cam.target ? 'follow' : 'fixed';
      if (opts.snap !== false && cam.target) cam.snap();
    },
    // Fixed camera: place and aim once (mode 'fixed'); e.g. menus.
    set(pos, look) {
      shots = null; cam.mode = 'fixed';
      cam.position.set(pos[0] != null ? pos[0] : pos.x, pos[1] != null ? pos[1] : pos.y, pos[2] != null ? pos[2] : pos.z);
      cam.focus.set(look[0] != null ? look[0] : look.x, look[1] != null ? look[1] : look.y, look[2] != null ? look[2] : look.z);
      applyToCamera(0);
    },
    update(dt, realDt) {
      const rdt = realDt || dt || 0;
      const inp = AB.input;
      const sens = AB.settings.sensitivity || 1;
      if (cam.mode === 'cinematic' && shots) {
        shotT += rdt;
        let s = shots[shotIdx];
        if (shotT >= (s.dur || 1)) {
          shotT = 0; shotIdx++;
          if (shotIdx >= shots.length) {
            if (shotOpts && shotOpts.loop) shotIdx = 0;
            else {
              const done = shotOpts && shotOpts.onDone;
              shots = null; cam.mode = cam.target ? 'follow' : 'fixed';
              if (cam.target) cam.snap();
              if (done) { try { done(); } catch (e) { console.error(e); } }
              return;
            }
          }
          s = shots[shotIdx];
        }
        evalShot(s, Math.min(1, shotT / (s.dur || 1)));
        inp.look.dx = inp.look.dy = 0; inp.zoom = 0;
        applyToCamera(rdt);
        return;
      }
      if (cam.mode !== 'follow' || !cam.target || !cam.target.pos) { applyToCamera(rdt); return; }
      // orbit + zoom
      if (inp.look.dx || inp.look.dy) {
        cam.yaw -= inp.look.dx * 0.0048 * sens;
        cam.pitch += inp.look.dy * 0.0036 * sens * (AB.settings.invertY ? -1 : 1);
      }
      if (inp.zoom) cam.dist *= 1 + inp.zoom * 0.0011;
      cam.dist = U.clamp(cam.dist, cam.minDist, cam.maxDist);
      cam.pitch = U.clamp(cam.pitch, cam.minPitch, cam.maxPitch);
      const idle = AB.loop.time - inp.lastLookT;
      // lock-on framing assist, else gentle recenter behind the moving target
      const lk = cam.lockOn && (cam.lockOn.pos || cam.lockOn);
      const t = cam.target;
      if (lk && lk.x != null && idle > 1.0) {
        const dx = t.pos.x - lk.x, dz = t.pos.z - lk.z;
        if (dx * dx + dz * dz > 1) cam.yaw = U.dampAngle(cam.yaw, Math.atan2(dx, dz), cam.lockSoft ? 1.3 : 2.2, rdt);
      } else if (cam.autoRecenter && idle > 1.8 && (Math.abs(inp.move.x) + Math.abs(inp.move.y) > 0.2) && t.facing != null) {
        cam.yaw = U.dampAngle(cam.yaw, t.facing + Math.PI, 0.9, rdt);
      }
      // focus
      targetLook(lookPt);
      if (cam.focus.distanceToSquared(lookPt) > 400) cam.focus.copy(lookPt);
      cam.focus.x = U.damp(cam.focus.x, lookPt.x, 14, rdt);
      cam.focus.z = U.damp(cam.focus.z, lookPt.z, 14, rdt);
      cam.focus.y = U.damp(cam.focus.y, lookPt.y, 7, rdt);
      // collision: allowed distance
      let allowed = cam.dist;
      place(desired, cam.focus, cam.dist);
      if (AB.world && AB.world.heightAt) {
        for (let i = 1; i <= 6; i++) {
          const f = i / 6;
          tmp.lerpVectors(cam.focus, desired, f);
          const g = AB.world.heightAt(tmp.x, tmp.z) + 0.45;
          if (tmp.y < g) { allowed = Math.min(allowed, Math.max(cam.minDist * 0.6, cam.dist * (f - 1 / 6))); break; }
        }
      }
      if (cam.collide) {
        try { const d = cam.collide(cam.focus, desired); if (d != null && d < allowed) allowed = Math.max(0.6, d - 0.25); } catch (e) { /* hook errors are not fatal */ }
      }
      curDist = allowed < curDist ? U.damp(curDist, allowed, 22, rdt) : U.damp(curDist, allowed, 3.2, rdt);
      place(cam.position, cam.focus, curDist);
      groundClamp(cam.position);
      applyToCamera(rdt);
    }
  };
  function targetLook(out) {
    const t = cam.target;
    const h = t.height != null ? t.height * 0.82 : cam.height;
    out.set(t.pos.x, t.pos.y + h, t.pos.z);
    return out;
  }
  function place(out, focus, d) {
    const cp = Math.cos(cam.pitch);
    out.set(focus.x + Math.sin(cam.yaw) * cp * d, focus.y + Math.sin(cam.pitch) * d, focus.z + Math.cos(cam.yaw) * cp * d);
    return out;
  }
  function groundClamp(p) {
    if (AB.world && AB.world.heightAt) { const g = AB.world.heightAt(p.x, p.z) + 0.35; if (p.y < g) p.y = g; }
  }
  const asV = (a, out) => (a == null ? out : Array.isArray(a) ? out.set(a[0], a[1], a[2]) : out.copy(a));
  function evalShot(s, t) {
    const k = (s.ease ? (U.ease[s.ease] || U.ease.inOut) : U.ease.inOut)(t);
    if (s.fn) { s.fn(k, shotPos, shotLook); }
    else {
      asV(s.from, shotPos); asV(s.to || s.from, tmp); shotPos.lerp(tmp, k);
      asV(s.lookFrom, shotLook); asV(s.lookTo || s.lookFrom, tmp); shotLook.lerp(tmp, k);
    }
    cam.position.copy(shotPos); cam.focus.copy(shotLook);
    if (s.fov) cam._shotFov = s.fov; else cam._shotFov = 0;
  }
  function applyToCamera(rdt) {
    const c = AB.camera;
    if (!c) return;
    shakeOff.set(0, 0, 0);
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - rdt);
      const a = shakeAmp * (shakeT / shakeDur);
      const tt = AB.loop.time * 1000 + AB.loop.frame;
      shakeOff.set(Math.sin(tt * 0.071) * a, Math.sin(tt * 0.093 + 1.3) * a * 0.8, Math.sin(tt * 0.057 + 2.1) * a);
    }
    c.position.copy(cam.position).add(shakeOff);
    c.lookAt(cam.focus.x + shakeOff.x * 0.4, cam.focus.y + shakeOff.y * 0.4, cam.focus.z + shakeOff.z * 0.4);
    let fov = cam._shotFov || cam.baseFov;
    if (kickT > 0) { kickT = Math.max(0, kickT - rdt); fov += kick * Math.sin(Math.PI * (1 - kickT / kickDur)); }
    if (Math.abs(fov - lastFov) > 0.01) { c.fov = fov; c.updateProjectionMatrix(); lastFov = fov; }
  }
}
