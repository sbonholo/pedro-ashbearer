'use strict';
/* ASHBEARER v3 :: audio.js
   OWNER: UI lane (game flow + ui + audio).
   Procedural WebAudio, no files: per-act ambience (wind, gusts, birds, crickets, frogs, water, drips, cave hum, ash hiss,
   rumble, fire crackle), footsteps by surface (actors:step), combat sound on the bus (swings per weapon, bow and sling,
   clashes, impacts, creature calls per glyph, deaths, the Emberheart, heals, dodges, perfect dodges, interrupts),
   UI and loot sounds, and a generative score per act (pads, plucks, a flute-like melody, bass) with combat drums and an
   ostinato that swell in fights (harder for bosses). Nothing is created before the first user gesture. Respects
   AB.settings.sound / volume / music. Silent during fastForward. Simple stereo placement from the camera. */
{
  const U = AB.util;
  let ctx = null, master = null, comp = null, sfxBus = null, musicBus = null, ambBus = null, verbIn = null, delayIn = null;
  let noiseBuf = null, brownBuf = null;
  let mode = 'title', act = 1, zone = '', level = null;
  let combatMix = 0, combatTarget = 0, bossMode = false;
  const amb = {};             // persistent ambience layers
  const T0 = { birds: 2, crick: 0, frog: 3, drip: 1, howl: 20, crackle: 0, owl: 9, bubble: 2 };
  const timers = Object.assign({}, T0);
  let stepBudget = 0;
  const live = () => ctx && ctx.state === 'running' && AB.settings.sound && !AB.loop.fastForwarding;
  const R = () => Math.random();
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // ----------------------------------------------------------------------------------------- graph
  function makeNoise(seconds, brown) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return b;
  }
  function makeVerb(seconds, decay) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  function ensure() {
    if (ctx) { if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; return null; }
    master = ctx.createGain(); master.gain.value = 0;
    comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
    ambBus = ctx.createGain(); ambBus.gain.value = 0.8; ambBus.connect(master);
    // shared reverb + a dotted-eighth delay for plucks
    const verb = ctx.createConvolver(); verb.buffer = makeVerb(3.2, 2.6);
    verbIn = ctx.createGain(); verbIn.gain.value = 1;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.55;
    verbIn.connect(verb); verb.connect(verbOut); verbOut.connect(master);
    amb.verbOut = verbOut;
    delayIn = ctx.createGain(); delayIn.gain.value = 0.32;
    const dl = ctx.createDelay(1.5); dl.delayTime.value = 0.42; const fb = ctx.createGain(); fb.gain.value = 0.32; const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 2400;
    delayIn.connect(dl); dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(musicBus); dlf.connect(verbIn);
    noiseBuf = makeNoise(2, false); brownBuf = makeNoise(4, true);
    buildAmbience();
    applyVolume();
    setScene();
    return ctx;
  }
  function applyVolume() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(AB.settings.sound ? AB.settings.volume * 1.45 : 0, t, 0.08);
    musicBus.gain.setTargetAtTime(AB.settings.music * 0.9, t, 0.4);
  }
  function loop(buf, dest, filterType, freq, q, gain) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = 0; s.loopEnd = buf.duration;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q || 0.7;
    const g = ctx.createGain(); g.gain.value = gain || 0;
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(ctx.currentTime + Math.random() * 0.5, Math.random() * buf.duration * 0.9);
    return { s, f, g };
  }
  function buildAmbience() {
    amb.wind = loop(brownBuf, ambBus, 'bandpass', 420, 0.6, 0);
    amb.wind2 = loop(noiseBuf, ambBus, 'bandpass', 1400, 2.5, 0);       // whistling gusts
    amb.hiss = loop(noiseBuf, ambBus, 'highpass', 4200, 0.5, 0);        // snow / ash
    amb.rumble = loop(brownBuf, ambBus, 'lowpass', 110, 0.8, 0);         // the March, the Forge
    amb.water = loop(noiseBuf, ambBus, 'bandpass', 900, 0.9, 0);         // streams and fen
    amb.fire = loop(brownBuf, ambBus, 'lowpass', 380, 0.7, 0);           // a campfire's roar
    amb.hum = ctx.createOscillator(); amb.hum.type = 'sine'; amb.hum.frequency.value = 55;
    amb.humG = ctx.createGain(); amb.humG.gain.value = 0; amb.hum.connect(amb.humG); amb.humG.connect(ambBus); amb.hum.start();
    amb.gust = 0; amb.gustT = 0; amb.waterNear = 0; amb.fireNear = 0;
  }

  // ----------------------------------------------------------------------------------------- one-shot helpers
  const tmpV = new AB.THREE.Vector3();
  function place(pos, near) {
    // stereo pan + distance gain from the camera; null when too far to hear
    if (!pos || !AB.camera) return { g: 1, pan: 0 };
    const c = AB.cam.position;
    const dx = pos.x - c.x, dz = pos.z - c.z, dy = (pos.y || 0) - c.y;
    const d = Math.hypot(dx, dz, dy * 0.5);
    const lim = near || 46;
    if (d > lim) return null;
    const yaw = AB.cam.yaw, rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const pan = U.clamp((dx * rx + dz * rz) / Math.max(4, d), -1, 1) * 0.75;
    return { g: 1 / (1 + Math.max(0, d - 5) / 9), pan };
  }
  function outNode(pl, wet) {
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain(); g.gain.value = pl ? pl.g : 1;
    if (p) { p.pan.value = pl ? pl.pan : 0; g.connect(p); p.connect(sfxBus); if (wet) { const w = ctx.createGain(); w.gain.value = wet; p.connect(w); w.connect(verbIn); } }
    else { g.connect(sfxBus); }
    return g;
  }
  function tone(dest, { type = 'sine', f = 440, f2 = 0, t = 0, a = 0.005, d = 0.3, g = 0.2, curve = 'exp', detune = 0 }) {
    const at = ctx.currentTime + t;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, at); if (detune) o.detune.value = detune;
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), at + a + d);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + a);
    if (curve === 'exp') e.gain.exponentialRampToValueAtTime(0.0001, at + a + d); else e.gain.linearRampToValueAtTime(0, at + a + d);
    o.connect(e); e.connect(dest); o.start(at); o.stop(at + a + d + 0.05);
    return o;
  }
  function noise(dest, { t = 0, a = 0.003, d = 0.15, g = 0.3, type = 'bandpass', f = 1000, f2 = 0, q = 1, brown = false, rate = 1 }) {
    const at = ctx.currentTime + t;
    const s = ctx.createBufferSource(); s.buffer = brown ? brownBuf : noiseBuf; s.playbackRate.value = rate;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, at); fl.Q.value = q;
    if (f2) fl.frequency.exponentialRampToValueAtTime(Math.max(30, f2), at + a + d);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + a); e.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
    s.loop = true;
    s.connect(fl); fl.connect(e); e.connect(dest);
    s.start(at, Math.random() * Math.max(0, s.buffer.duration - 0.5)); s.stop(at + a + d + 0.05);
  }
  function metal(dest, base, g, d, t = 0) {
    // inharmonic partials: a sword ringing
    const parts = [1, 2.76, 5.4, 8.93];
    parts.forEach((k, i) => tone(dest, { type: 'sine', f: base * k * (1 + (R() - 0.5) * 0.01), t, a: 0.002, d: d / (1 + i * 0.6), g: g / (1 + i * 0.9) }));
  }

  // ----------------------------------------------------------------------------------------- sounds
  const STYLE = { wren: 'sling', ysolde: 'blades', brakka: 'hammer', neve: 'bow', maddoc: 'staff', rook: 'sword', tamsin: 'spear' };
  const BLADED = { blades: 1, sword: 1, spear: 1, soldier: 1, bandit: 1, herald: 1, sentinel: 1 };
  function swing(u, slot) {
    const pl = place(u.pos); if (!pl) return;
    const o = outNode(pl, 0.12);
    const st = STYLE[u.id] || 'sword';
    const heavy = slot !== 'attack';
    if (st === 'bow') { noise(o, { f: 900, f2: 500, d: 0.35, g: 0.05, q: 3 }); return; }        // the draw; release on 'projectile'
    if (st === 'sling') { for (let i = 0; i < 3; i++) noise(o, { t: i * 0.09, f: 700 + i * 200, f2: 1400, d: 0.08, g: 0.07, q: 2 }); return; }
    if (st === 'staff') { noise(o, { f: 500, f2: 1200, d: 0.22, g: 0.12, q: 1.2 }); tone(o, { type: 'sine', f: 520, f2: 780, d: 0.3, g: 0.03 }); return; }
    if (st === 'hammer') { noise(o, { f: 300, f2: 900, d: 0.3, g: heavy ? 0.26 : 0.2, q: 0.9, brown: true }); return; }
    if (st === 'blades') { noise(o, { f: 1200, f2: 3200, d: 0.12, g: 0.13, q: 1.4 }); noise(o, { t: 0.11, f: 1300, f2: 3400, d: 0.1, g: 0.11, q: 1.4 }); return; }
    noise(o, { f: 800, f2: 2600, d: 0.18, g: heavy ? 0.18 : 0.15, q: 1.2 });
  }
  function hit({ unit, src, amount, kind, heavy }) {
    if (!unit) return;
    const pl = place(unit.pos); if (!pl) return;
    const o = outNode(pl, 0.18);
    if (kind === 'dodged') { noise(o, { f: 1500, f2: 600, d: 0.14, g: 0.08 }); return; }
    if (kind === 'immune') { metal(o, 900, 0.08, 0.5); return; }
    if (kind === 'bleed') { noise(o, { f: 500, d: 0.08, g: 0.05, type: 'lowpass' }); return; }
    const big = heavy || amount >= 12;
    const s = src && (src.id ? STYLE[src.id] : null) || (src && src.glyph) || '';
    const guarded = unit.status && unit.status.guard;
    if (guarded || BLADED[s] || (unit.glyph === 'sentinel')) metal(o, 520 + R() * 380, big ? 0.13 : 0.08, big ? 0.9 : 0.5);
    // body: thud + crunch
    tone(o, { type: 'sine', f: big ? 120 : 160, f2: 45, d: big ? 0.28 : 0.16, g: big ? 0.5 : 0.32 });
    noise(o, { f: big ? 700 : 1100, f2: 250, d: big ? 0.22 : 0.12, g: big ? 0.32 : 0.22, q: 0.8 });
    if (unit.side === 'party' && unit === AB.combat.controlled()) noise(o, { type: 'lowpass', f: 300, d: 0.25, g: 0.25, brown: true });
  }
  const CALL = {
    hound: (o, s) => { tone(o, { type: 'sawtooth', f: 240 * s, f2: 160 * s, a: 0.02, d: 0.35, g: 0.08 }); noise(o, { f: 900 * s, d: 0.3, g: 0.08, q: 2 }); },
    beast: (o, s) => { tone(o, { type: 'sawtooth', f: 110 * s, f2: 70 * s, a: 0.05, d: 0.7, g: 0.12 }); noise(o, { type: 'lowpass', f: 600, d: 0.6, g: 0.16, brown: true }); },
    troll: (o, s) => { tone(o, { type: 'sawtooth', f: 70 * s, f2: 48 * s, a: 0.1, d: 1.1, g: 0.18 }); tone(o, { type: 'square', f: 105 * s, f2: 72 * s, a: 0.1, d: 1, g: 0.05 }); },
    spider: (o) => { for (let i = 0; i < 9; i++) noise(o, { t: i * 0.035, f: 3000 + R() * 2000, d: 0.02, g: 0.09, q: 6 }); },
    wraith: (o) => { noise(o, { f: 700, f2: 2400, a: 0.3, d: 1.1, g: 0.12, q: 8 }); tone(o, { type: 'sine', f: 330, f2: 300, a: 0.3, d: 1.2, g: 0.04, detune: 14 }); },
    shade: (o) => CALL.wraith(o),
    swarm: (o) => { noise(o, { f: 2400, a: 0.2, d: 0.9, g: 0.08, q: 4 }); },
    lurker: (o, s) => { noise(o, { type: 'lowpass', f: 400, f2: 120, a: 0.05, d: 0.8, g: 0.2, brown: true }); tone(o, { type: 'sine', f: 90 * s, f2: 60 * s, d: 0.8, g: 0.12 }); },
    wyrm: (o, s) => { noise(o, { f: 3000, f2: 1500, a: 0.05, d: 0.7, g: 0.12, q: 1.5 }); tone(o, { type: 'sawtooth', f: 90 * s, f2: 55 * s, a: 0.08, d: 0.9, g: 0.12 }); },
    sentinel: (o) => { metal(o, 140, 0.12, 1.4); noise(o, { type: 'lowpass', f: 300, d: 0.5, g: 0.18, brown: true }); },
    ghoul: (o, s) => { tone(o, { type: 'sawtooth', f: 180 * s, f2: 120 * s, a: 0.05, d: 0.5, g: 0.07 }); noise(o, { f: 1600, d: 0.45, g: 0.06, q: 3 }); },
    human: (o, s) => { tone(o, { type: 'sawtooth', f: 150 * s, f2: 125 * s, a: 0.04, d: 0.35, g: 0.05 }); noise(o, { f: 900, d: 0.3, g: 0.05, q: 2.5 }); }
  };
  function call(u, kind) {
    if (!u || u.side !== 'foe') return;
    const pl = place(u.pos, 60); if (!pl) return;
    const o = outNode(pl, 0.35);
    const sc = u.tier === 'boss' ? 0.7 : u.tier === 'elite' ? 0.85 : 1;
    const f = CALL[u.glyph] || CALL.human;
    if (kind === 'death') o.gain.value *= 0.8;
    f(o, sc * (kind === 'death' ? 0.8 : 1));
  }
  function projectile(p) {
    if (!p || !p.pos) return;
    const pl = place(p.pos); if (!pl) return;
    const o = outNode(pl, 0.1);
    switch (p.kind) {
      case 'arrow': tone(o, { type: 'triangle', f: 196, f2: 180, d: 0.25, g: 0.12 }); noise(o, { f: 2400, f2: 900, d: 0.28, g: 0.06, q: 2 }); break;
      case 'stone': noise(o, { f: 1800, f2: 700, d: 0.2, g: 0.08, q: 1.5 }); break;
      case 'knife': noise(o, { f: 3000, f2: 1500, d: 0.16, g: 0.07, q: 3 }); break;
      case 'bolt': tone(o, { type: 'sine', f: 880, f2: 1320, d: 0.35, g: 0.05 }); tone(o, { type: 'sine', f: 1320, f2: 990, d: 0.3, g: 0.03, t: 0.03 }); break;
      case 'spit': noise(o, { f: 900, f2: 400, d: 0.2, g: 0.1, q: 4 }); break;
      case 'curse': tone(o, { type: 'sawtooth', f: 110, f2: 90, a: 0.05, d: 0.5, g: 0.05 }); noise(o, { f: 600, d: 0.4, g: 0.06, q: 8 }); break;
      default: noise(o, { f: 1200, d: 0.15, g: 0.06 });
    }
  }
  function ember(pos) {
    const o = outNode(place(pos, 80) || { g: 1, pan: 0 }, 0.6);
    tone(o, { type: 'sine', f: 90, f2: 30, a: 0.01, d: 1.6, g: 0.7 });
    noise(o, { type: 'lowpass', f: 2000, f2: 200, a: 0.02, d: 1.4, g: 0.5, brown: true });
    noise(o, { f: 300, f2: 4000, a: 0.25, d: 0.5, g: 0.12, q: 0.8 });
    [1, 1.5, 2.01, 3.02].forEach((k, i) => tone(o, { type: 'sine', f: 330 * k, t: 0.05 + i * 0.04, a: 0.05, d: 2.2, g: 0.05 / (1 + i * 0.3) }));
  }
  function chime(freqs, g = 0.06, d = 1.6, wet = 0.4, t = 0) {
    const o = outNode({ g: 1, pan: 0 }, wet);
    freqs.forEach((f, i) => { tone(o, { type: 'sine', f, t: t + i * 0.07, a: 0.004, d, g }); tone(o, { type: 'sine', f: f * 2.01, t: t + i * 0.07, a: 0.004, d: d * 0.5, g: g * 0.3 }); });
  }
  function step(e) {
    if (stepBudget <= 0) return;
    const u = e.unit; if (!u) return;
    const ctl = AB.combat.controlled();
    const pos = tmpV.set(e.x, e.y, e.z);
    const pl = place(pos, u === ctl ? 40 : 22); if (!pl) return;
    stepBudget--;
    const k = (u === ctl ? 1 : u.side === 'party' ? 0.5 : 0.7) * (e.heavy ? 1.6 : 1);
    const o = outNode({ g: pl.g * k, pan: pl.pan }, 0.06);
    const jit = 0.85 + R() * 0.3;
    switch (e.surface) {
      case 'stone': noise(o, { f: 2600 * jit, d: 0.04, g: 0.12, q: 1.2 }); tone(o, { type: 'triangle', f: 180 * jit, d: 0.04, g: 0.05 }); break;
      case 'wood': tone(o, { type: 'sine', f: 140 * jit, f2: 90, d: 0.09, g: 0.16 }); noise(o, { f: 1800, d: 0.03, g: 0.05 }); break;
      case 'snow': for (let i = 0; i < 4; i++) noise(o, { t: i * 0.018, f: (1800 + R() * 1600), d: 0.03, g: 0.07, q: 2 }); break;
      case 'water': noise(o, { f: 1400 * jit, f2: 500, d: 0.16, g: 0.14, q: 1.4 }); noise(o, { t: 0.05, f: 2600, d: 0.08, g: 0.04, q: 3 }); break;
      case 'ash': noise(o, { type: 'lowpass', f: 700 * jit, d: 0.09, g: 0.12 }); noise(o, { f: 3500, d: 0.06, g: 0.025, q: 1 }); break;
      case 'dirt': noise(o, { f: 900 * jit, d: 0.07, g: 0.12, q: 0.9 }); tone(o, { type: 'sine', f: 90, d: 0.06, g: 0.08 }); break;
      default: noise(o, { type: 'lowpass', f: 1300 * jit, d: 0.08, g: 0.1 }); noise(o, { f: 4200, d: 0.04, g: 0.02, q: 1 }); break;   // grass
    }
    if (e.heavy) tone(o, { type: 'sine', f: 60, f2: 35, d: 0.35, g: 0.35 });
  }
  // play(name, opts): named one-shot (also used by the 'sfx' bus event)
  function play(name, opts = {}) {
    if (!live()) return;
    const pl = opts.pos ? place(opts.pos, 60) : { g: 1, pan: 0 };
    if (!pl) return;
    const o = () => outNode(pl, 0.25);
    switch (name) {
      case 'coin': { const d = o(); tone(d, { type: 'sine', f: 2093, d: 0.12, g: 0.05 }); tone(d, { type: 'sine', f: 2637, t: 0.06, d: 0.25, g: 0.05 }); metal(d, 1800, 0.03, 0.3, 0.02); break; }
      case 'chest': { const d = o(); tone(d, { type: 'sawtooth', f: 90, f2: 140, a: 0.02, d: 0.45, g: 0.04 }); noise(d, { type: 'lowpass', f: 500, d: 0.3, g: 0.12, brown: true }); chime([784, 988, 1175], 0.04, 1.2, 0.4, 0.3); break; }
      case 'click': { const d = o(); tone(d, { type: 'triangle', f: 1100, d: 0.035, g: 0.03 }); break; }
      case 'heal': chime([660, 880, 1320], 0.035, 1.4, 0.5); break;
      case 'item': chime([523, 659], 0.04, 0.9, 0.3); break;
      case 'checkpoint': chime([392, 494, 587, 784], 0.035, 2.4, 0.6); break;
      case 'discover': chime([1047, 1568], 0.025, 1.4, 0.6); break;
      case 'zone': chime([294, 440, 587], 0.03, 3, 0.7); break;
      case 'victory': { const d = o(); [0, 4, 7, 12].forEach((s, i) => tone(d, { type: 'sawtooth', f: midi(62 + s), t: i * 0.09, a: 0.02, d: 1.2 - i * 0.15, g: 0.035 })); break; }
      case 'downed': { const d = o(); tone(d, { type: 'sine', f: 70, f2: 50, d: 0.5, g: 0.35 }); tone(d, { type: 'sine', f: 70, f2: 50, t: 0.28, d: 0.5, g: 0.25 }); chime([311, 233], 0.03, 2, 0.6, 0.1); break; }
      case 'fallen': chime([220, 207.65, 174.6], 0.05, 3.5, 0.8); break;
      case 'perfect': { const d = o(); tone(d, { type: 'sine', f: 1760, d: 0.6, g: 0.06 }); tone(d, { type: 'sine', f: 2637, t: 0.04, d: 0.5, g: 0.04 }); noise(d, { f: 600, f2: 3000, d: 0.3, g: 0.06 }); break; }
      case 'interrupt': { const d = o(); noise(d, { f: 2400, d: 0.06, g: 0.2, q: 0.8 }); metal(d, 700, 0.06, 0.4); break; }
      case 'whisper': { const d = outNode({ g: 1, pan: (R() - 0.5) * 1.2 }, 0.9); noise(d, { f: 2600, f2: 1800, a: 0.6, d: 2.2, g: 0.05, q: 6 }); tone(d, { type: 'sine', f: 55, a: 1, d: 2.5, g: 0.12 }); break; }
      case 'alert': break;
      case 'rewind': chime([196, 185, 174.6, 164.8], 0.05, 2.2, 0.8); break;
      default: break;
    }
  }

  // ----------------------------------------------------------------------------------------- generative score
  const SCALES = { dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], ionian: [0, 2, 4, 5, 7, 9, 11], lydian: [0, 2, 4, 6, 7, 9, 11], harm: [0, 2, 3, 5, 7, 8, 11] };
  const THEME = {
    title: { root: 50, scale: 'aeolian', bpm: 62, prog: [0, 5, 3, 4, 0, 5, 6, 4], arp: 0.45, mel: 0.55, lp: 1400, bright: 0.8 },
    a1: { root: 50, scale: 'dorian', bpm: 68, prog: [0, 3, 0, 4, 5, 3, 6, 4], arp: 0.5, mel: 0.45, lp: 1600, bright: 1 },
    a2: { root: 45, scale: 'aeolian', bpm: 56, prog: [0, 5, 2, 6, 0, 3, 4, 4], arp: 0.3, mel: 0.35, lp: 1100, bright: 0.7 },
    a3: { root: 48, scale: 'phrygian', bpm: 52, prog: [0, 1, 0, 6, 5, 1, 0, 0], arp: 0.22, mel: 0.25, lp: 800, bright: 0.5 },
    camp: { root: 53, scale: 'lydian', bpm: 70, prog: [0, 4, 5, 3], arp: 0.6, mel: 0.5, lp: 1800, bright: 1 },
    forge: { root: 41, scale: 'phrygian', bpm: 46, prog: [0, 1, 0, 1, 6, 5], arp: 0.12, mel: 0.15, lp: 600, bright: 0.4 },
    win: { root: 50, scale: 'ionian', bpm: 64, prog: [0, 4, 5, 3, 0, 3, 4, 0], arp: 0.6, mel: 0.6, lp: 2200, bright: 1.2 },
    loss: { root: 45, scale: 'aeolian', bpm: 50, prog: [0, 5, 3, 4], arp: 0.25, mel: 0.3, lp: 900, bright: 0.5 }
  };
  const mus = { theme: THEME.title, beat: 0, nextT: 0, bar: 0, chordIdx: 0, phrase: [], drumT: 0, drumStep: 0, last: 0, padOut: null, combatG: null, melodyLast: 0 };
  function themeKey() {
    if (mode === 'title') return 'title';
    if (mode === 'camp') return 'camp';
    if (mode === 'forge') return 'forge';
    if (mode === 'ending_win') return 'win';
    if (mode === 'ending_loss') return 'loss';
    return 'a' + Math.min(3, Math.max(1, act || 1));
  }
  function degreeNote(th, deg, oct) {
    const sc = SCALES[th.scale]; const n = sc.length;
    const o = Math.floor(deg / n), i = ((deg % n) + n) % n;
    return th.root + sc[i] + 12 * (o + (oct || 0));
  }
  function ensureMusicNodes() {
    if (mus.padOut) return;
    mus.padF = ctx.createBiquadFilter(); mus.padF.type = 'lowpass'; mus.padF.frequency.value = 1200; mus.padF.Q.value = 0.5;
    mus.padOut = ctx.createGain(); mus.padOut.gain.value = 0.9;
    mus.padF.connect(mus.padOut); mus.padOut.connect(musicBus);
    const pw = ctx.createGain(); pw.gain.value = 0.45; mus.padOut.connect(pw); pw.connect(verbIn);
    mus.combatG = ctx.createGain(); mus.combatG.gain.value = 0; mus.combatG.connect(musicBus);
    const cw = ctx.createGain(); cw.gain.value = 0.18; mus.combatG.connect(cw); cw.connect(verbIn);
  }
  function padChord(th, deg, at, dur) {
    const notes = [degreeNote(th, deg, -1), degreeNote(th, deg + 2, -1), degreeNote(th, deg + 4, -1), degreeNote(th, deg + 7, -1)];
    notes.forEach((n, i) => {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator(); o.type = i === 0 ? 'triangle' : 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
        const g = ctx.createGain(); const pk = (i === 0 ? 0.05 : 0.022) * (th.bright || 1);
        g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(pk, at + 1.6); g.gain.setValueAtTime(pk, at + dur - 0.2); g.gain.linearRampToValueAtTime(0.0001, at + dur + 2.2);
        o.connect(g); g.connect(mus.padF); o.start(at); o.stop(at + dur + 2.4);
      }
    });
    // bass
    const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = midi(degreeNote(th, deg, -2));
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.0001, at); bg.gain.linearRampToValueAtTime(0.11, at + 0.4); bg.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.5);
    b.connect(bg); bg.connect(musicBus); b.start(at); b.stop(at + dur + 0.6);
  }
  function pluck(n, at, g, dest) {
    const f = midi(n);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + 0.004); e.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
    const e2 = ctx.createGain(); e2.gain.value = 0.25;
    o.connect(e); o2.connect(e2); e2.connect(e); e.connect(dest || musicBus); e.connect(delayIn);
    o.start(at); o2.start(at); o.stop(at + 1.7); o2.stop(at + 1.7);
  }
  function flute(n, at, dur, g) {
    const f = midi(n);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2; const vg = ctx.createGain(); vg.gain.setValueAtTime(0, at); vg.gain.linearRampToValueAtTime(f * 0.006, at + dur * 0.6);
    vib.connect(vg); vg.connect(o.frequency);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + 0.09); e.gain.setValueAtTime(g * 0.85, at + dur * 0.7); e.gain.linearRampToValueAtTime(0.0001, at + dur + 0.25);
    o.connect(e); e.connect(musicBus); const w = ctx.createGain(); w.gain.value = 0.7; e.connect(w); w.connect(verbIn);
    o.start(at); vib.start(at); o.stop(at + dur + 0.3); vib.stop(at + dur + 0.3);
    // breath
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = f * 2; bf.Q.value = 3;
    const bgn = ctx.createGain(); bgn.gain.setValueAtTime(0.0001, at); bgn.gain.linearRampToValueAtTime(g * 0.25, at + 0.05); bgn.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    s.connect(bf); bf.connect(bgn); bgn.connect(musicBus); s.start(at, R()); s.stop(at + 0.35);
  }
  function drum(at, kind, g) {
    const d = mus.combatG;
    if (kind === 'taiko') {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.35);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + 0.004); e.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
      o.connect(e); e.connect(d); o.start(at); o.stop(at + 0.6);
      const s = ctx.createBufferSource(); s.buffer = brownBuf; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
      const n = ctx.createGain(); n.gain.setValueAtTime(g * 0.6, at); n.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      s.connect(f); f.connect(n); n.connect(d); s.start(at, R() * 2); s.stop(at + 0.15);
    } else if (kind === 'frame') {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(220, at); o.frequency.exponentialRampToValueAtTime(140, at + 0.12);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + 0.003); e.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(e); e.connect(d); o.start(at); o.stop(at + 0.2);
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 0.8;
      const n = ctx.createGain(); n.gain.setValueAtTime(g * 0.5, at); n.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
      s.connect(f); f.connect(n); n.connect(d); s.start(at, R()); s.stop(at + 0.08);
    } else {
      // low string ostinato note (kind = midi number)
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(kind);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(900, at); f.frequency.exponentialRampToValueAtTime(260, at + 0.22); f.Q.value = 2;
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(g, at + 0.01); e.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      o.connect(f); f.connect(e); e.connect(d); o.start(at); o.stop(at + 0.3);
    }
  }
  function brass(at, th, deg) {
    [0, 2, 4].forEach((k) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(degreeNote(th, deg + k, 0));
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(300, at); f.frequency.linearRampToValueAtTime(1600, at + 0.12); f.frequency.exponentialRampToValueAtTime(500, at + 0.9);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, at); e.gain.linearRampToValueAtTime(0.045, at + 0.06); e.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
      o.connect(f); f.connect(e); e.connect(mus.combatG); o.start(at); o.stop(at + 1.2);
    });
  }
  function scheduleMusic() {
    ensureMusicNodes();
    const now = ctx.currentTime, ahead = now + 0.3;
    const key = themeKey();
    const th = THEME[key] || THEME.a1;
    if (mus.theme !== th) { mus.theme = th; mus.chordIdx = 0; mus.beat = 0; if (mus.nextT < now) mus.nextT = now + 0.1; mus.padF.frequency.setTargetAtTime(th.lp, now, 1.5); }
    if (mus.nextT < now - 1) mus.nextT = now + 0.05;
    const spb = 60 / th.bpm;
    while (mus.nextT < ahead) {
      const at = mus.nextT, b = mus.beat;
      if (b % 8 === 0) { const deg = th.prog[mus.chordIdx % th.prog.length]; mus.deg = deg; padChord(th, deg, at, spb * 8); mus.chordIdx++; }
      // plucked arpeggio on eighths
      for (let h = 0; h < 2; h++) {
        if (R() < th.arp * (combatMix > 0.5 ? 0.5 : 1)) {
          const chordTones = [0, 2, 4, 7, 9];
          const n = degreeNote(th, (mus.deg || 0) + chordTones[Math.floor(R() * chordTones.length)], 1);
          pluck(n, at + h * spb / 2, 0.05 * (0.6 + R() * 0.5));
        }
      }
      // melody: occasional stepwise phrases
      if (b % 4 === 0 && !mus.phrase.length && R() < th.mel * 0.4 && combatMix < 0.6) {
        const len = 3 + Math.floor(R() * 4); let d = (mus.deg || 0) + (R() < 0.5 ? 4 : 2);
        for (let i = 0; i < len; i++) { mus.phrase.push({ d, dur: R() < 0.35 ? 2 : 1 }); d += R() < 0.5 ? -1 : 1; if (R() < 0.2) d += R() < 0.5 ? 2 : -2; }
        mus.phrase[mus.phrase.length - 1].dur = 3;
      }
      if (mus.phrase.length && (mus.phraseWait || 0) <= 0) {
        const p = mus.phrase.shift();
        flute(degreeNote(th, p.d, 1), at, p.dur * spb * 0.95, 0.045);
        mus.phraseWait = p.dur;
      }
      mus.phraseWait = (mus.phraseWait || 0) - 1;
      mus.beat++; mus.nextT += spb;
    }
    // combat layer: drums + ostinato (+ brass for bosses), its own tempo
    const cbpm = bossMode ? 118 : 104, s16 = 60 / cbpm / 4;
    if (mus.drumT < now - 0.5) mus.drumT = now + 0.05;
    while (mus.drumT < ahead) {
      const at = mus.drumT, st = mus.drumStep % 16;
      if (combatMix > 0.02) {
        const k = combatMix;
        if (st === 0 || st === 10 || (bossMode && st === 6)) drum(at, 'taiko', 0.5 * k);
        if (st === 8 || (st === 14 && R() < 0.6)) drum(at, 'taiko', 0.32 * k);
        if (st % 4 === 2) drum(at, 'frame', 0.12 * k);
        if (st % 2 === 0) { const root = degreeNote(mus.theme, mus.deg || 0, -1); drum(at, st % 8 === 6 ? root + 7 : root, 0.06 * k); }
        if (bossMode && st === 0 && (mus.drumStep / 16) % 2 === 0) brass(at, mus.theme, mus.deg || 0);
      }
      mus.drumStep++; mus.drumT += s16;
    }
  }

  // ----------------------------------------------------------------------------------------- ambience (frame)
  const AMB = {
    title: { wind: 0.05, windF: 420, hiss: 0, rumble: 0, birds: 0.6, crick: 0 },
    1: { wind: 0.06, windF: 450, hiss: 0, rumble: 0, birds: 1, crick: 0.2 },
    'the Whisperwood': { wind: 0.05, windF: 380, birds: 0.7, crick: 0.7, owl: 1 },
    'the Fenmarsh': { wind: 0.045, windF: 340, birds: 0.15, crick: 1, frog: 1, water: 0.06 },
    2: { wind: 0.16, windF: 620, hiss: 0.022, rumble: 0, birds: 0, crick: 0, howl: 1 },
    'the Gate of Undervault': { wind: 0.1, windF: 520, hiss: 0.01, drip: 0.5, hum: 0.02 },
    'the Drowned Halls of Undervault': { wind: 0.015, windF: 300, hiss: 0, drip: 1, hum: 0.05, water: 0.05, verb: 1 },
    3: { wind: 0.1, windF: 360, hiss: 0.02, rumble: 0.12, crackle: 0.5 },
    'the Gate of Mount Cindral': { wind: 0.08, windF: 320, hiss: 0.015, rumble: 0.2, crackle: 0.8 },
    forge: { wind: 0.02, windF: 250, rumble: 0.3, crackle: 1, bubble: 1, hum: 0.03 }
  };
  let ambP = AMB.title;
  function setScene() {
    if (!ctx) return;
    const a = mode === 'title' || !AB.state.run ? 'title' : level && level.act === 'forge' ? 'forge' : (level ? level.act : act);
    const base = AMB[a] || AMB[1];
    ambP = Object.assign({ wind: 0, windF: 400, hiss: 0, rumble: 0, birds: 0, crick: 0, frog: 0, owl: 0, howl: 0, drip: 0, hum: 0, water: 0, crackle: 0, bubble: 0, verb: 0 }, base, AMB[zone] || {});
    const t = ctx.currentTime;
    amb.hiss.g.gain.setTargetAtTime(ambP.hiss, t, 1.5);
    amb.rumble.g.gain.setTargetAtTime(ambP.rumble, t, 2);
    amb.humG.gain.setTargetAtTime(ambP.hum, t, 2);
    amb.verbOut.gain.setTargetAtTime(ambP.verb ? 0.95 : 0.55, t, 1.5);
  }
  function chirp(o, f0) {
    const n = 2 + Math.floor(R() * 4);
    for (let i = 0; i < n; i++) tone(o, { type: 'sine', f: f0 * (1 + R() * 0.2), f2: f0 * (1.3 + R() * 0.5), t: i * (0.07 + R() * 0.05), a: 0.005, d: 0.05 + R() * 0.05, g: 0.025 });
  }
  function ambFrame(dt) {
    const t = ctx.currentTime;
    const u = AB.combat && AB.combat.controlled ? AB.combat.controlled() : null;
    // gusts: a slow random walk on the wind
    amb.gustT -= dt;
    if (amb.gustT <= 0) { amb.gustT = 2 + R() * 5; amb.gust = R() * R(); }
    const w = ambP.wind * (0.7 + amb.gust * 1.1);
    amb.wind.g.gain.setTargetAtTime(w, t, 1.6);
    amb.wind.f.frequency.setTargetAtTime(ambP.windF * (0.8 + amb.gust * 0.8), t, 2);
    amb.wind2.g.gain.setTargetAtTime(ambP.wind * amb.gust * amb.gust * 0.25, t, 1.2);
    amb.wind2.f.frequency.setTargetAtTime(900 + amb.gust * 1400, t, 1.5);
    // nearby water and fire (sampled a few times per second)
    amb.sampleT = (amb.sampleT || 0) - dt;
    if (amb.sampleT <= 0 && u && AB.world.level) {
      amb.sampleT = 0.4;
      let wn = 0;
      if (AB.world.surfaceAt) for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; if (AB.world.surfaceAt(u.pos.x + Math.sin(a) * 6, u.pos.z + Math.cos(a) * 6) === 'water') wn++; }
      amb.waterNear = wn / 6;
      let fd = 1e9;
      for (const p of AB.world.level.pois) if (p.type === 'camp' || p.type === 'haven' || p.type === 'forge') fd = Math.min(fd, U.dist2(p.x, p.z, u.pos.x, u.pos.z));
      amb.fireNear = U.clamp(1 - fd / 22, 0, 1);
    }
    if (mode === 'title') { amb.waterNear = 0; amb.fireNear = 0; }
    amb.water.g.gain.setTargetAtTime(Math.max(ambP.water, amb.waterNear * 0.08), t, 0.8);
    amb.water.f.frequency.setTargetAtTime(700 + R() * 600, t, 0.1);
    amb.fire.g.gain.setTargetAtTime(amb.fireNear * 0.12 + (mode === 'camp' ? 0.1 : 0), t, 0.8);
    // one-shot life
    const loud = (k) => outNode({ g: k, pan: (R() - 0.5) * 1.4 }, 0.5);
    timers.birds -= dt * ambP.birds; if (timers.birds <= 0) { timers.birds = 2 + R() * 6; chirp(loud(0.6 + R() * 0.4), 2200 + R() * 1800); }
    timers.crick -= dt * ambP.crick; if (timers.crick <= 0) { timers.crick = 0.6 + R() * 1.4; const o = loud(0.3); for (let i = 0; i < 6; i++) tone(o, { type: 'sine', f: 4300 + R() * 300, t: i * 0.035, a: 0.003, d: 0.02, g: 0.02 }); }
    timers.frog -= dt * ambP.frog; if (timers.frog <= 0) { timers.frog = 1.5 + R() * 4; const o = loud(0.5); for (let i = 0; i < 2; i++) tone(o, { type: 'square', f: 150 + R() * 40, f2: 110, t: i * 0.16, a: 0.01, d: 0.1, g: 0.025 }); }
    timers.owl -= dt * ambP.owl; if (timers.owl <= 0) { timers.owl = 14 + R() * 18; const o = loud(0.5); tone(o, { type: 'sine', f: 440, f2: 400, a: 0.06, d: 0.35, g: 0.03 }); tone(o, { type: 'sine', f: 420, f2: 380, t: 0.55, a: 0.06, d: 0.6, g: 0.035 }); }
    timers.howl -= dt * ambP.howl; if (timers.howl <= 0) { timers.howl = 25 + R() * 30; const o = loud(0.35); tone(o, { type: 'sawtooth', f: 330, f2: 520, a: 0.6, d: 2.2, g: 0.012 }); noise(o, { f: 900, f2: 1400, a: 0.5, d: 2, g: 0.03, q: 6 }); }
    timers.drip -= dt * ambP.drip; if (timers.drip <= 0) { timers.drip = 0.5 + R() * 2.2; const o = loud(0.5); tone(o, { type: 'sine', f: 1100 + R() * 1400, f2: 700, a: 0.002, d: 0.12, g: 0.04 }); }
    timers.crackle -= dt * Math.max(ambP.crackle, amb.fireNear * 1.5 + (mode === 'camp' ? 1.5 : 0)); if (timers.crackle <= 0) { timers.crackle = 0.05 + R() * 0.3; const o = loud(0.5); noise(o, { f: 2000 + R() * 3000, d: 0.01 + R() * 0.02, g: 0.06 + R() * 0.06, q: 1.5 }); }
    timers.bubble -= dt * ambP.bubble; if (timers.bubble <= 0) { timers.bubble = 0.8 + R() * 2; const o = loud(0.6); tone(o, { type: 'sine', f: 70 + R() * 50, f2: 140, a: 0.01, d: 0.25, g: 0.08 }); }
  }
  function frame(dt, realDt) {
    if (!ctx || ctx.state !== 'running') return;
    const rdt = Math.min(0.1, realDt || dt || 0.016);
    stepBudget = 3;
    combatMix = U.damp(combatMix, combatTarget, combatTarget > combatMix ? 1.4 : 0.35, rdt);
    if (mus.combatG) mus.combatG.gain.setTargetAtTime(combatMix > 0.01 ? 1 : 0, ctx.currentTime, 0.2);
    if (!AB.settings.sound) return;
    scheduleMusic();
    ambFrame(rdt);
  }
  function setMode(m, a) {
    mode = m || 'explore';
    if (a) act = a;
    combatTarget = mode === 'combat' || mode === 'boss' ? 1 : 0;
    bossMode = mode === 'boss';
    setScene();
  }

  AB.audio = {
    init() {
      const unlock = () => { if (AB.settings.sound) ensure(); };
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock);
      document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend().catch(() => {}); else if (AB.settings.sound) ctx.resume().catch(() => {}); });
      const B = AB.bus;
      B.on('settings', ({ key }) => { if (key === 'sound' || key === 'volume' || key === 'music') { if (AB.settings.sound) ensure(); applyVolume(); } });
      B.on('music', ({ mode: m, act: a }) => setMode(m, a));
      B.on('level:built', ({ level: lv }) => { level = lv; zone = ''; if (lv && typeof lv.act === 'number') act = lv.act; setScene(); });
      B.on('zone', ({ name }) => { zone = name || ''; setScene(); if (live() && AB.state.screen === 'play') play('zone'); });
      B.on('run:new', () => { act = 1; });
      B.on('sfx', ({ name, pos }) => play(name, { pos }));
      B.on('ui:click', () => play('click'));
      B.on('actors:step', (e) => { if (live()) step(e); });
      B.on('unit:action', ({ unit, slot, phase, shape }) => {
        if (!live() || !unit || phase !== 'start') return;
        if (unit.side === 'party' && slot !== 'intent') swing(unit, slot);
        else if (unit.side === 'foe' && (unit.tier === 'boss' || unit.tier === 'elite' || shape === 'cast') && R() < (unit.tier === 'boss' ? 0.6 : 0.3)) call(unit, 'windup');
      });
      B.on('projectile', ({ proj }) => { if (live()) projectile(proj); });
      B.on('unit:hit', (e) => { if (live()) hit(e); });
      B.on('unit:heal', ({ unit, kind, amount }) => { if (live() && kind !== 'regen' && kind !== 'loot' && amount >= 3 && unit && unit === AB.combat.controlled()) play('heal'); });
      B.on('unit:death', ({ unit }) => { if (live() && unit && unit.side === 'foe') call(unit, 'death'); });
      B.on('combat:alert', ({ unit }) => { if (live() && R() < 0.7) call(unit, 'alert'); });
      B.on('combat:phase', ({ unit }) => { if (live()) { call(unit, 'roar'); call(unit, 'roar'); } });
      B.on('ember', ({ x, y, z }) => { if (live()) ember({ x, y, z }); });
      B.on('dodge', ({ unit }) => { if (live() && unit) { const pl = place(unit.pos); if (pl) noise(outNode(pl, 0.05), { f: 700, f2: 1800, d: 0.2, g: unit === AB.combat.controlled() ? 0.12 : 0.05, q: 0.8 }); } });
      B.on('combat:perfect', () => play('perfect'));
      B.on('combat:interrupt', ({ unit }) => play('interrupt', { pos: unit && unit.pos }));
      B.on('unit:downed', ({ unit }) => { if (unit && unit.side === 'party') play('downed'); });
      B.on('hero:fallen', () => play('fallen'));
      B.on('item:used', () => play('item'));
      B.on('victory', () => play('victory'));
      B.on('checkpoint', () => play('checkpoint'));
      B.on('whisper', () => play('whisper'));
      B.on('rewind', () => play('rewind'));
      B.on('poi:discovered', ({ poi }) => { if (poi && (poi.type === 'chest' || poi.type === 'shrine' || poi.type === 'haven')) play('discover'); });
      AB.loop.add('audio', frame, { phase: 'frame', order: AB.loop.ORDER.audio });
    },
    play, ensure,
    // meter(): output level (dBFS: rms, peak) for tools
    meter() {
      if (!ctx) return null;
      if (!amb.an) { amb.an = ctx.createAnalyser(); amb.an.fftSize = 2048; comp.connect(amb.an); amb.buf = new Float32Array(2048); }
      amb.an.getFloatTimeDomainData(amb.buf);
      let s = 0, p = 0; for (let i = 0; i < amb.buf.length; i++) { const v = amb.buf[i]; s += v * v; p = Math.max(p, Math.abs(v)); }
      const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
      return { rms: +db(Math.sqrt(s / amb.buf.length)).toFixed(1), peak: +db(p).toFixed(1) };
    },
    get context() { return ctx; },
    get mode() { return mode; },
    get combatMix() { return combatMix; }
  };
}
