'use strict';
/* ASHBEARER v3 :: vfx.js
   OWNER: ACTORS lane (actors.js + vfx.js).
   Purely cosmetic effects. FRAME system (order 60) pulls AB.combat.threats() / projectiles() / units() and reacts to
   bus events; never changes simulation state; Math.random is fine here; all handlers skip work while fastForwarding.
   Systems: two GPU point-particle pools (additive glow: sparks, embers, motes / alpha: dust, smoke, blood, snow,
   splash), weapon trails (ribbons sampled from actor sockets during swings), real projectiles (arrow, stone, knife,
   bolt, spit, curse) with trails, ground telegraph decals conformed to the terrain (fill sweep to impact), status
   visuals (guard shimmer, mark sigil, weak drip, bleed drops, stun swirl, hidden ash, taunt pulse, empower/regen
   motes), magic ribbons (mends, songs, encouragement), lantern light, the Emberheart glow/light, the Wield shockwave
   (screen dim, shard flare, ring, pillar, embers, dust), footstep dust/splash/snow/ash puffs, hit/heal/death bursts,
   lock-on and controlled-hero rings, optional world-space damage numbers (AB.vfx.numbers = true; off by default
   because ui.js draws DOM numbers). Camera reactions: shake on heavy hits, FOV kick on dodge, flash on the ember. */
{
  const T = AB.THREE;
  const U = AB.util;
  const V3 = T.Vector3;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const tmp = new V3(), tmp2 = new V3(), tmp3 = new V3();
  const col = new T.Color();
  let root = null, ready = false;
  const FF = () => AB.loop.fastForwarding;

  // =====================================================================================================
  // 1. PARTICLES: CPU-simulated ring buffers drawn as soft round GPU points (size in metres, fog aware)
  // =====================================================================================================
  const PV = 'attribute float aSize; attribute float aAlpha; varying vec3 vC; varying float vA; uniform float uScale;\n#include <fog_pars_vertex>\n' +
    'void main(){ vC = color; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); float dz = -mvPosition.z; vA = aAlpha * smoothstep(0.8, 3.5, dz); gl_PointSize = clamp(aSize * uScale / max(0.05, dz), 0.0, 120.0); gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}';
  const PF = (additive) => 'varying vec3 vC; varying float vA; uniform float uSoft;\n#include <fog_pars_fragment>\n' +
    'void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = smoothstep(1.0, uSoft, r) * vA; if (a < 0.004) discard; gl_FragColor = vec4(vC, a);\n' +
    (additive ? '#ifdef USE_FOG\n #ifdef FOG_EXP2\n float ff = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);\n #else\n float ff = smoothstep(fogNear, fogFar, vFogDepth);\n #endif\n gl_FragColor.rgb *= 1.0 - ff;\n#endif\n'
      : '#include <fog_fragment>\n') + '#include <colorspace_fragment>\n}';
  class Pool {
    constructor(n, additive, soft) {
      this.n = n; this.head = 0; this.live = 0;
      this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3); this.alpha = new Float32Array(n); this.size = new Float32Array(n);
      this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n); this.a0 = new Float32Array(n); this.s0 = new Float32Array(n);
      this.grav = new Float32Array(n); this.drag = new Float32Array(n); this.grow = new Float32Array(n); this.fadeIn = new Float32Array(n);
      for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -1e5;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('color', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('aAlpha', new T.BufferAttribute(this.alpha, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('aSize', new T.BufferAttribute(this.size, 1).setUsage(T.DynamicDrawUsage));
      this.mat = new T.ShaderMaterial({ uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { uScale: { value: 400 }, uSoft: { value: soft } }]),
        vertexShader: PV, fragmentShader: PF(additive), vertexColors: true, transparent: true, depthWrite: false, fog: true,
        blending: additive ? T.AdditiveBlending : T.NormalBlending });
      this.pts = new T.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 950 : 940;
      this.g = g;
    }
    emit(x, y, z, vx, vy, vz, life, size, r, gg, b, a, o) {
      const i = this.head; this.head = (this.head + 1) % this.n;
      const k = i * 3;
      this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z; this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
      this.col[k] = r; this.col[k + 1] = gg; this.col[k + 2] = b;
      this.life[i] = life; this.max[i] = life; this.a0[i] = a; this.s0[i] = size; this.size[i] = size; this.alpha[i] = 0;
      this.grav[i] = o && o.grav != null ? o.grav : 0; this.drag[i] = o && o.drag != null ? o.drag : 1.5; this.grow[i] = o && o.grow != null ? o.grow : 0; this.fadeIn[i] = o && o.fadeIn != null ? o.fadeIn : 0.08;
    }
    update(dt) {
      const n = this.n, P = this.pos, V = this.vel;
      let live = 0;
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; P[i * 3 + 1] = -1e5; } continue; }
        live++;
        this.life[i] -= dt;
        const k = i * 3, dr = Math.exp(-this.drag[i] * dt);
        V[k] *= dr; V[k + 1] = V[k + 1] * dr - this.grav[i] * dt; V[k + 2] *= dr;
        P[k] += V[k] * dt; P[k + 1] += V[k + 1] * dt; P[k + 2] += V[k + 2] * dt;
        const age = this.max[i] - this.life[i], q = this.life[i] / this.max[i];
        this.alpha[i] = this.life[i] <= 0 ? 0 : this.a0[i] * Math.min(1, age / this.fadeIn[i]) * Math.min(1, q * 2.2);
        this.size[i] = this.s0[i] * (1 + this.grow[i] * age);
      }
      // idle systems neither upload nor draw (integrator, perf); one last upload clears the faded particles
      const was = this.wasLive; this.wasLive = live > 0;
      this.pts.visible = live > 0 || was;
      if (!live && !was) return;
      const at = this.g.attributes;
      at.position.needsUpdate = at.color.needsUpdate = at.aAlpha.needsUpdate = at.aSize.needsUpdate = true;
    }
    clear() { this.life.fill(0); }
  }
  let ADD = null, ALP = null;
  const PQ = () => (AB.quality && AB.quality.settings ? AB.quality.settings.particles : 1);
  // convenience emitters
  function sparks(x, y, z, n, hex, speed, life, size, grav, up) {
    if (!ADD) return; col.setHex(hex);
    const m = Math.max(1, Math.round(n * PQ()));
    for (let i = 0; i < m; i++) { const a = Math.random() * TAU, e = rnd(-0.3, 1) * (up || 1), s = speed * rnd(0.4, 1); ADD.emit(x, y, z, Math.cos(a) * s, e * s, Math.sin(a) * s, life * rnd(0.6, 1.1), size * rnd(0.6, 1.2), col.r * 2.2, col.g * 2.2, col.b * 2.2, 1, { grav: grav != null ? grav : 9, drag: 2.5, fadeIn: 0.01 }); }
  }
  function motes(x, y, z, n, hex, spread, rise, life, size, br) {
    if (!ADD) return; col.setHex(hex);
    const m = Math.max(1, Math.round(n * PQ())), b = br || 2;
    for (let i = 0; i < m; i++) ADD.emit(x + rnd(-spread, spread), y + rnd(-spread * 0.5, spread), z + rnd(-spread, spread), rnd(-0.2, 0.2), rise * rnd(0.5, 1.2), rnd(-0.2, 0.2), life * rnd(0.6, 1.2), size * rnd(0.7, 1.3), col.r * b, col.g * b, col.b * b, 1, { grav: -0.2, drag: 0.8, fadeIn: 0.15 });
  }
  function puff(x, y, z, n, hex, spread, speed, life, size, a, o) {
    if (!ALP) return; col.setHex(hex);
    const m = Math.max(1, Math.round(n * PQ()));
    for (let i = 0; i < m; i++) { const ang = Math.random() * TAU, s = speed * rnd(0.3, 1); ALP.emit(x + rnd(-spread, spread), y + rnd(0, spread * 0.5), z + rnd(-spread, spread), Math.cos(ang) * s, rnd(0.2, 1) * speed * ((o && o.up) || 0.6), Math.sin(ang) * s, life * rnd(0.7, 1.2), size * rnd(0.7, 1.3), col.r, col.g, col.b, a, { grav: (o && o.grav) || -0.15, drag: (o && o.drag) || 2.2, grow: (o && o.grow) != null ? o.grow : 1.2, fadeIn: 0.06 }); }
  }
  function drops(x, y, z, n, hex, speed, life, size, a) {
    if (!ALP) return; col.setHex(hex);
    const m = Math.max(1, Math.round(n * PQ()));
    for (let i = 0; i < m; i++) { const ang = Math.random() * TAU, s = speed * rnd(0.3, 1); ALP.emit(x, y, z, Math.cos(ang) * s, rnd(0.2, 1.2) * speed, Math.sin(ang) * s, life * rnd(0.7, 1.1), size * rnd(0.6, 1.2), col.r, col.g, col.b, a || 0.95, { grav: 9.5, drag: 0.6, grow: 0, fadeIn: 0.01 }); }
  }

  // =====================================================================================================
  // 2. GROUND DECALS: telegraphs (conformed to terrain) and expanding rings (shockwaves, ripples, pulses)
  // =====================================================================================================
  const RINGS = 4, SEGS = 40;
  function discGeo() {
    const pos = [], rad = [], ang = [], idx = [];
    for (let r = 0; r <= RINGS; r++) for (let s = 0; s <= SEGS; s++) { const rr = r / RINGS, a = s / SEGS * TAU; pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr); rad.push(rr); ang.push(s / SEGS); }
    for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEGS; s++) { const a = r * (SEGS + 1) + s, b = a + SEGS + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }   // counter-clockwise seen from above
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aR', new T.Float32BufferAttribute(rad, 1)); g.setAttribute('aA', new T.Float32BufferAttribute(ang, 1));
    g.setIndex(idx);
    return g;
  }
  const TEL_V = 'attribute float aR; attribute float aA; varying float vR; varying float vAng; void main(){ vR = aR; vAng = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const TEL_F = 'uniform vec3 uColor; uniform float uProg; uniform float uTime; uniform float uKind; uniform float uAlpha; varying float vR; varying float vAng;\n' +
    'void main(){ float r = vR; float edge = smoothstep(0.88, 0.97, r) * (1.0 - smoothstep(0.985, 1.0, r));\n' +
    ' float fill = (1.0 - smoothstep(uProg - 0.02, uProg, r)) * 0.32;\n' +
    ' float front = smoothstep(uProg - 0.07, uProg, r) * (1.0 - smoothstep(uProg, uProg + 0.015, r)) * step(0.02, uProg);\n' +
    ' float danger = smoothstep(0.75, 1.0, uProg); float pulse = 0.65 + 0.35 * sin(uTime * (8.0 + danger * 18.0));\n' +
    ' float runes = 0.0; if (uKind > 0.5 && uKind < 1.5) { float t = fract(vAng * 24.0 + uTime * 0.15); runes = step(0.82, r) * step(r, 0.88) * step(0.2, t) * step(t, 0.55) * 0.8; }\n' +
    ' float cross = 0.0; if (uKind > 1.5) { float a = fract(vAng * 4.0); cross = (step(a, 0.02) + step(0.98, a)) * step(0.25, r) * step(r, 0.95) * 0.9 + (1.0 - smoothstep(0.08, 0.14, r)) * 0.9; }\n' +
    ' float a = (edge * (0.75 + 0.25 * danger) * pulse + fill * (0.7 + 0.6 * danger) + front * 0.9 + runes + cross) * uAlpha; if (a < 0.003) discard;\n' +
    ' vec3 c = uColor * (1.0 + danger * 1.2 + front * 0.8); gl_FragColor = vec4(c, a);\n#include <colorspace_fragment>\n}';
  const tels = [];
  function makeTel() {
    const m = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color() }, uProg: { value: 0 }, uTime: { value: 0 }, uKind: { value: 0 }, uAlpha: { value: 1 } }, vertexShader: TEL_V, fragmentShader: TEL_F,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const mesh = new T.Mesh(discGeo(), m); mesh.frustumCulled = false; mesh.renderOrder = 5;
    root.add(mesh);
    return { mesh, id: -1, x: 0, z: 0, r: 0, fade: 0 };
  }
  // conform a unit disc (scaled by r) to the ground around (x, z); vertices are in world space (mesh at origin)
  function conform(geo, x, z, r, lift) {
    const P = geo.attributes.position, R = geo.attributes.aR, A = geo.attributes.aA;
    const H = AB.world && AB.world.heightAt;
    for (let i = 0; i < P.count; i++) {
      const rr = R.getX(i) * r, a = A.getX(i) * TAU, px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      P.setXYZ(i, px, (H ? AB.world.heightAt(px, pz) : 0) + lift, pz);
    }
    P.needsUpdate = true;
  }
  // expanding rings (one-shot)
  const RING_F = 'uniform vec3 uColor; uniform float uAlpha; uniform float uWidth; varying float vR; varying float vAng;\n' +
    'void main(){ float a = smoothstep(1.0 - uWidth, 1.0 - uWidth * 0.3, vR) * (1.0 - smoothstep(0.97, 1.0, vR)) + (1.0 - smoothstep(0.0, 1.0 - uWidth, vR)) * 0.06; a *= uAlpha; if (a < 0.003) discard; gl_FragColor = vec4(uColor, a);\n#include <colorspace_fragment>\n}';
  const rings = [];
  function ring(x, z, r0, r1, dur, hex, intensity, width, o) {
    if (!root || FF()) return null;
    let R = rings.find((q) => !q.on);
    if (!R) {
      if (rings.length >= 16) R = rings.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b));
      else {
        const m = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color() }, uAlpha: { value: 1 }, uWidth: { value: 0.3 } }, vertexShader: TEL_V, fragmentShader: RING_F, transparent: true, depthWrite: false, blending: T.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
        R = { mesh: new T.Mesh(discGeo(), m), on: false }; R.mesh.frustumCulled = false; R.mesh.renderOrder = 960; root.add(R.mesh); rings.push(R);
      }
    }
    R.on = true; R.x = x; R.z = z; R.r0 = r0; R.r1 = r1; R.t = 0; R.dur = dur; R.inten = intensity || 1.5; R.lift = (o && o.lift) || 0.08; R.ease = o && o.ease;
    R.mesh.material.uniforms.uColor.value.setHex(hex); R.mesh.material.uniforms.uWidth.value = width || 0.25; R.mesh.visible = true;
    return R;
  }
  function updateRings(dt) {
    for (const R of rings) {
      if (!R.on) continue;
      R.t += dt; const q = clamp(R.t / R.dur, 0, 1);
      const e = R.ease === 'in' ? q * q : 1 - (1 - q) * (1 - q);
      const r = R.r0 + (R.r1 - R.r0) * e;
      conform(R.mesh.geometry, R.x, R.z, Math.max(0.05, r), R.lift);
      const u = R.mesh.material.uniforms; u.uAlpha.value = R.inten * (1 - q) * Math.min(1, R.t / 0.05);
      if (q >= 1) { R.on = false; R.mesh.visible = false; }
    }
  }

  // =====================================================================================================
  // 3. TRAILS: ribbons following two sockets (weapon base + tip) during a swing
  // =====================================================================================================
  const TRAIL_N = 18;
  const TR_V = 'attribute float aA; varying float vA; varying float vS; attribute float aS; void main(){ vA = aA; vS = aS; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const TR_F = 'uniform vec3 uColor; varying float vA; varying float vS; void main(){ float a = vA * smoothstep(0.0, 0.5, vS) * (0.55 + 0.45 * vS); if (a < 0.003) discard; gl_FragColor = vec4(uColor * (0.6 + vS * 0.8), a);\n#include <colorspace_fragment>\n}';
  const trails = [], samplePool = [];
  const sample = () => samplePool.pop() || { a: new V3(), b: new V3(), t: 0 };
  function makeTrail() {
    const pos = new Float32Array(TRAIL_N * 2 * 3), al = new Float32Array(TRAIL_N * 2), sd = new Float32Array(TRAIL_N * 2), idx = [];
    for (let i = 0; i < TRAIL_N; i++) { sd[i * 2] = 0; sd[i * 2 + 1] = 1; }
    for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage)); g.setAttribute('aA', new T.BufferAttribute(al, 1).setUsage(T.DynamicDrawUsage)); g.setAttribute('aS', new T.BufferAttribute(sd, 1));
    g.setIndex(idx);
    const m = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color(1, 1, 1) } }, vertexShader: TR_V, fragmentShader: TR_F, transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
    const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 955; root.add(mesh);
    return { mesh, g, samples: [], unit: null, until: 0, tipName: 'weapon_tip', baseName: 'weapon_base', alpha: 0.6 };
  }
  function startTrail(u, hex, dur, alpha, which) {
    if (!root || FF()) return;
    let tr = trails.find((t) => t.unit === u && t.which === (which || 1));
    if (!tr) tr = trails.find((t) => !t.unit && !t.samples.length);
    if (!tr) { if (trails.length >= 10) return; tr = makeTrail(); trails.push(tr); }
    tr.unit = u; tr.until = now + dur; tr.which = which || 1; while (tr.samples.length) samplePool.push(tr.samples.pop()); tr.alpha = alpha || 0.55;
    tr.tipName = which === 2 ? 'weapon2_tip' : 'weapon_tip'; tr.baseName = which === 2 ? 'weapon2_base' : 'weapon_base';
    tr.mesh.material.uniforms.uColor.value.setHex(hex);
  }
  function updateTrails(dt) {
    for (const tr of trails) {
      const S = tr.samples;
      if (tr.unit && now < tr.until && tr.unit.spawned !== false && AB.actors.view(tr.unit)) {
        const a = AB.actors.socket(tr.unit, tr.baseName, tmp2), b = AB.actors.socket(tr.unit, tr.tipName, tmp3);
        const last = S[S.length - 1];
        if (last && last.b.distanceTo(b) > 0.35) {   // fill fast swings with intermediate samples
          const n = Math.min(4, Math.floor(last.b.distanceTo(b) / 0.2));
          for (let i = 1; i <= n; i++) { const q = i / (n + 1), s = sample(); s.a.copy(last.a).lerp(a, q); s.b.copy(last.b).lerp(b, q); s.t = now - dt * (1 - q); S.push(s); }
        }
        const s = sample(); s.a.copy(a); s.b.copy(b); s.t = now; S.push(s);
      } else if (tr.unit && now >= tr.until) tr.unit = null;
      while (S.length && (now - S[0].t > 0.16 || S.length > TRAIL_N)) samplePool.push(S.shift());
      const P = tr.g.attributes.position.array, A = tr.g.attributes.aA.array;
      if (S.length < 2) { tr.mesh.visible = false; continue; }
      tr.mesh.visible = true;
      for (let i = 0; i < TRAIL_N; i++) {
        const s = S[Math.max(0, Math.min(S.length - 1, S.length - TRAIL_N + i))];
        const age = now - s.t, al = i < TRAIL_N - S.length ? 0 : Math.pow(clamp(1 - age / 0.16, 0, 1), 1.5) * tr.alpha;
        const o = i * 6; P[o] = s.a.x; P[o + 1] = s.a.y; P[o + 2] = s.a.z; P[o + 3] = s.b.x; P[o + 4] = s.b.y; P[o + 5] = s.b.z; A[i * 2] = al; A[i * 2 + 1] = al;
      }
      tr.g.attributes.position.needsUpdate = true; tr.g.attributes.aA.needsUpdate = true;
    }
  }

  // =====================================================================================================
  // 4. PROJECTILES (pooled meshes per kind) + magic ribbons
  // =====================================================================================================
  const projGeo = {};
  function projMesh(kind) {
    let g = projGeo[kind], m;
    if (!g) {
      const BGU = AB.addons.BufferGeometryUtils;
      if (kind === 'arrow') {
        const shaft = new T.CylinderGeometry(0.008, 0.008, 0.78, 5).rotateX(Math.PI / 2);
        const head = new T.ConeGeometry(0.02, 0.07, 4).rotateX(Math.PI / 2).translate(0, 0, 0.42);
        const f1 = new T.PlaneGeometry(0.03, 0.1).rotateY(Math.PI / 2).translate(0, 0.015, -0.32), f2 = new T.PlaneGeometry(0.03, 0.1).rotateY(Math.PI / 2).rotateZ(Math.PI * 2 / 3).translate(0, -0.008, -0.32), f3 = new T.PlaneGeometry(0.03, 0.1).rotateY(Math.PI / 2).rotateZ(-Math.PI * 2 / 3).translate(0, -0.008, -0.32);
        for (const x of [f1, f2, f3]) x.deleteAttribute('uv');
        for (const x of [shaft, head]) x.deleteAttribute('uv');
        g = BGU.mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed(), f1.toNonIndexed(), f2.toNonIndexed(), f3.toNonIndexed()]);
      } else if (kind === 'stone') g = new T.DodecahedronGeometry(0.05, 0);
      else if (kind === 'knife') { g = new T.BoxGeometry(0.015, 0.03, 0.26); }
      else g = new T.IcosahedronGeometry(kind === 'spit' ? 0.09 : 0.11, 1);
      g.userData.shared = true; projGeo[kind] = g;
    }
    if (kind === 'arrow') m = new T.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.7, side: T.DoubleSide });
    else if (kind === 'stone') m = new T.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.9, flatShading: true });
    else if (kind === 'knife') m = new T.MeshStandardMaterial({ color: 0xb0b4b8, roughness: 0.3, metalness: 0.9 });
    else m = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, blending: T.AdditiveBlending });
    const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.castShadow = kind === 'arrow' || kind === 'stone';
    return mesh;
  }
  const projPool = {};          // kind -> [mesh]
  const projVis = new Map();    // proj id -> { mesh, kind, off: V3, t, hex, src }
  function projStyle(p) {
    const src = AB.combat.unit(p.src);
    const id = src ? src.id : '', glyph = src ? src.glyph : '';
    if (p.kind === 'bolt') return id === 'tamsin' ? { hex: 0xffd27a, trail: 0xffc860, kind: 'bolt', size: 0.8, song: true } : { hex: 0xfff0c8, trail: 0xffe0a0, kind: 'bolt', size: 1 };
    if (p.kind === 'curse') {
      if (glyph === 'shade' || glyph === 'wraith') return src && src.def && src.def.act === 3 ? { hex: 0xff7a30, trail: 0x3a2a24, kind: 'curse', smoke: true, size: 1 } : { hex: 0x8ac8ff, trail: 0x2a3440, kind: 'curse', smoke: true, size: 1 };
      if (glyph === 'sentinel') return { hex: 0x7ae0d0, trail: 0x5ad0c0, kind: 'curse', size: 1 };
      return { hex: 0xff6a20, trail: 0xff4a10, kind: 'curse', size: 1.1, ember: true };
    }
    if (p.kind === 'spit') return { hex: 0x9ad04a, trail: 0x6a8a30, kind: 'spit', size: 1 };
    return { hex: 0xffffff, kind: p.kind, size: 1 };
  }
  function onProjectile({ proj }) {
    if (!proj || !root || FF()) return;
    const st = projStyle(proj);
    const list = projPool[st.kind] || (projPool[st.kind] = []);
    let mesh = list.pop();
    if (!mesh) { mesh = projMesh(st.kind); root.add(mesh); }
    mesh.visible = true;
    if (mesh.material.color && (st.kind === 'bolt' || st.kind === 'curse' || st.kind === 'spit')) mesh.material.color.setHex(st.hex).multiplyScalar(2.5);
    mesh.scale.setScalar(st.size || 1);
    // visual launch from the shooter's muzzle socket, easing into the simulated path
    const src = AB.combat.unit(proj.src);
    const off = new V3();
    if (src && AB.actors.view(src)) { AB.actors.socket(src, 'muzzle', off); off.sub(proj.pos); if (off.length() > 2.5) off.set(0, 0, 0); }
    projVis.set(proj.id, { mesh, kind: st.kind, st, off, t: 0, spin: rnd(-1, 1) });
    if (src && src.id === 'maddoc') { AB.actors.socket(src, 'lantern', tmp3); flashLight(tmp3.x + Math.sin(src.facing || 0), tmp3.y, tmp3.z + Math.cos(src.facing || 0), 0xffe0a0, 8, 0.25); }
    if (st.kind === 'curse' || st.kind === 'bolt') { tmp.copy(proj.pos).add(off); sparks(tmp.x, tmp.y, tmp.z, 8, st.hex, 2, 0.35, 0.12, 0, 1); }
  }
  function onProjectileEnd({ proj, unit }) {
    if (!proj) return;
    const pv = projVis.get(proj.id);
    if (pv) { pv.mesh.visible = false; (projPool[pv.kind] || (projPool[pv.kind] = [])).push(pv.mesh); projVis.delete(proj.id); }
    if (!root || FF()) return;
    const st = pv ? pv.st : projStyle(proj);
    const x = proj.pos.x, y = proj.pos.y, z = proj.pos.z;
    if (st.kind === 'bolt') { sparks(x, y, z, 14, st.hex, 3.5, 0.45, 0.14, 1, 1); motes(x, y, z, 6, st.hex, 0.2, 0.6, 0.8, 0.12); flashLight(x, y, z, st.hex, 2.5, 0.18); if (st.song) ring(x, z, 0.2, 1.6, 0.45, 0xffc860, 0.9, 0.2); }
    else if (st.kind === 'curse') { sparks(x, y, z, 16, st.hex, 3.5, 0.5, 0.13, 2, 1); puff(x, y, z, 6, st.smoke ? 0x1a1a1e : 0x2a2420, 0.2, 1.2, 0.9, 0.35, 0.5); flashLight(x, y, z, st.hex, 2.5, 0.2); }
    else if (st.kind === 'spit') { drops(x, y, z, 12, 0x6a8a30, 2.5, 0.6, 0.07, 0.9); puff(x, y, z, 3, 0x7a9a40, 0.15, 0.6, 0.6, 0.3, 0.5); }
    else if (st.kind === 'stone' || st.kind === 'knife') { puff(x, y, z, 4, 0x8a8070, 0.08, 1.2, 0.5, 0.18, 0.5); sparks(x, y, z, unit && /sentinel|soldier|herald/.test(unit.glyph || '') ? 8 : 2, 0xffd8a0, 3, 0.3, 0.06, 9, 1); }
    else if (st.kind === 'arrow') { if (!unit) puff(x, AB.world.heightAt(x, z) + 0.05, z, 4, 0x6a5a48, 0.1, 0.8, 0.6, 0.18, 0.5); }
  }
  function updateProjectiles(dt) {
    const ps = AB.combat.projectiles();
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      let pv = projVis.get(p.id);
      if (!pv) { onProjectile({ proj: p }); pv = projVis.get(p.id); if (!pv) continue; }
      pv.t += dt;
      const k = Math.max(0, 1 - pv.t / 0.14);
      const m = pv.mesh;
      m.position.copy(p.pos).addScaledVector(pv.off, k * k);
      tmp.copy(p.pos).add(p.vel); m.lookAt(tmp);
      if (pv.kind === 'stone' || pv.kind === 'knife') { m.rotateX(pv.t * 22 * (pv.spin > 0 ? 1 : -1)); }
      const st = pv.st;
      if (st.kind === 'bolt' || st.kind === 'curse' || st.kind === 'spit') {
        m.scale.setScalar((st.size || 1) * (0.85 + 0.15 * Math.sin(now * 30 + p.id)));
        if (st.trail != null) {
          col.setHex(st.trail);
          const n = st.kind === 'spit' ? 1 : 2;
          for (let j = 0; j < n; j++) ADD && ADD.emit(m.position.x + rnd(-0.04, 0.04), m.position.y + rnd(-0.04, 0.04), m.position.z + rnd(-0.04, 0.04), rnd(-0.3, 0.3), rnd(-0.2, 0.4), rnd(-0.3, 0.3), 0.35, st.kind === 'spit' ? 0.09 : 0.16, col.r * 2.5, col.g * 2.5, col.b * 2.5, 1, { drag: 3, fadeIn: 0.01 });
          if (st.song) { const a = now * 18 + p.id; ADD && ADD.emit(m.position.x + Math.cos(a) * 0.15, m.position.y + Math.sin(a) * 0.15, m.position.z, 0, 0.2, 0, 0.5, 0.1, 2.4, 1.9, 0.9, 1, { drag: 2, fadeIn: 0.02 }); }
          if (st.smoke && Math.random() < 0.6) ALP && ALP.emit(m.position.x, m.position.y, m.position.z, rnd(-0.2, 0.2), rnd(0, 0.3), rnd(-0.2, 0.2), 0.7, 0.3, 0.06, 0.06, 0.07, 0.45, { grow: 1.5, drag: 2 });
          if (st.ember && Math.random() < 0.5) puff(m.position.x, m.position.y, m.position.z, 1, 0x2a2018, 0.03, 0.2, 0.6, 0.18, 0.35);
        }
      } else if (pv.kind === 'arrow' && Math.random() < 0.5) { ALP && ALP.emit(m.position.x, m.position.y, m.position.z, 0, 0, 0, 0.18, 0.05, 0.9, 0.9, 0.9, 0.25, { grow: 1, drag: 1 }); }
    }
    // stale visuals (projectile removed without an end event, e.g. level change)
    if (projVis.size > ps.length) {
      for (const [id, pv] of projVis) { let alive = false; for (let i = 0; i < ps.length; i++) if (ps[i].id === id) { alive = true; break; } if (!alive) { pv.mesh.visible = false; (projPool[pv.kind] || (projPool[pv.kind] = [])).push(pv.mesh); projVis.delete(id); } }
    }
  }
  // magic ribbons: a glowing band drawn along a moving curve from a source point to a target (mends, encouragement)
  const ribbons = [];
  const RIB_N = 24;
  function ribbon(fromUnit, fromSock, toUnit, hex, dur, o) {
    if (!root || FF()) return;
    let R = ribbons.find((r) => !r.on);
    if (!R) {
      if (ribbons.length >= 8) return;
      const pos = new Float32Array(RIB_N * 2 * 3), al = new Float32Array(RIB_N * 2), sd = new Float32Array(RIB_N * 2), idx = [];
      for (let i = 0; i < RIB_N; i++) { sd[i * 2] = 0; sd[i * 2 + 1] = 1; }
      for (let i = 0; i < RIB_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage)); g.setAttribute('aA', new T.BufferAttribute(al, 1).setUsage(T.DynamicDrawUsage)); g.setAttribute('aS', new T.BufferAttribute(sd, 1));
      g.setIndex(idx);
      const m = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color() } }, vertexShader: TR_V, fragmentShader: 'uniform vec3 uColor; varying float vA; varying float vS; void main(){ float e = 1.0 - abs(vS * 2.0 - 1.0); float a = vA * e; if (a < 0.003) discard; gl_FragColor = vec4(uColor * (1.0 + e), a);\n#include <colorspace_fragment>\n}',
        transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
      R = { mesh: new T.Mesh(g, m), g, on: false }; R.mesh.frustumCulled = false; R.mesh.renderOrder = 956; root.add(R.mesh); ribbons.push(R);
    }
    R.on = true; R.from = fromUnit; R.sock = fromSock; R.to = toUnit; R.t = 0; R.dur = dur || 0.7; R.seed = Math.random() * 10; R.width = (o && o.width) || 0.07; R.lift = (o && o.lift) || 0.8; R.spiral = o && o.spiral;
    R.mesh.material.uniforms.uColor.value.setHex(hex).multiplyScalar(1.6); R.mesh.visible = true;
  }
  const _a = new V3(), _b = new V3(), _c = new V3(), _side = new V3();
  function updateRibbons(dt) {
    for (const R of ribbons) {
      if (!R.on) continue;
      R.t += dt; const q = R.t / R.dur;
      if (q >= 1 || !R.from || !R.to) { R.on = false; R.mesh.visible = false; continue; }
      AB.actors.socket(R.from, R.sock || 'hand_r', _a); AB.actors.socket(R.to, 'chest', _b);
      _c.copy(_a).add(_b).multiplyScalar(0.5); _c.y += R.lift;
      const head = Math.min(1, q * 2.2), tail = Math.max(0, q * 1.6 - 0.6);
      const P = R.g.attributes.position.array, A = R.g.attributes.aA.array;
      tmp.subVectors(_b, _a); _side.set(-tmp.z, 0, tmp.x).normalize();
      for (let i = 0; i < RIB_N; i++) {
        const s = tail + (head - tail) * (i / (RIB_N - 1));
        const u1 = 1 - s;
        const x = u1 * u1 * _a.x + 2 * u1 * s * _c.x + s * s * _b.x, y = u1 * u1 * _a.y + 2 * u1 * s * _c.y + s * s * _b.y, z = u1 * u1 * _a.z + 2 * u1 * s * _c.z + s * s * _b.z;
        const w = Math.sin(s * 9 + R.seed + R.t * 8) * 0.12 * Math.sin(s * Math.PI);
        const px = x + _side.x * w, pz = z + _side.z * w, py = y + Math.cos(s * 7 + R.seed) * 0.06;
        const wd = R.width * Math.sin(Math.min(1, (i + 1) / RIB_N) * Math.PI);
        P[i * 6] = px; P[i * 6 + 1] = py - wd; P[i * 6 + 2] = pz; P[i * 6 + 3] = px; P[i * 6 + 4] = py + wd; P[i * 6 + 5] = pz;
        const al = (1 - Math.abs(q - 0.5) * 1.2) * 0.9; A[i * 2] = A[i * 2 + 1] = al;
        if (i === RIB_N - 1 && Math.random() < 0.6) ADD && ADD.emit(px, py, pz, rnd(-0.3, 0.3), rnd(0, 0.5), rnd(-0.3, 0.3), 0.5, 0.1, R.mesh.material.uniforms.uColor.value.r, R.mesh.material.uniforms.uColor.value.g, R.mesh.material.uniforms.uColor.value.b, 1, { drag: 2 });
      }
      R.g.attributes.position.needsUpdate = true; R.g.attributes.aA.needsUpdate = true;
    }
  }

  // =====================================================================================================
  // 5. LIGHTS (fixed set, created once so light counts never change): Emberheart, lantern, effect flash
  // =====================================================================================================
  let emberLight = null, lanternLight = null, fxLight = null, fxT = 0, fxDur = 0.2, fxI = 0, lanternBoost = 0;
  function flashLight(x, y, z, hex, intensity, dur) {
    if (!fxLight || FF()) return;
    if (fxT > 0 && fxI * (fxT / fxDur) > intensity) return;
    fxLight.position.set(x, y + 0.3, z); fxLight.color.setHex(hex); fxI = intensity; fxDur = dur || 0.2; fxT = fxDur;
  }
  function lanternPulse(k) { lanternBoost = Math.max(lanternBoost, k); }

  // =====================================================================================================
  // 6. STATUS VISUALS
  // =====================================================================================================
  const stat = new Map();    // uid -> { guard, mark, acc: {...} }
  let guardGeo = null, sigilTex = null;
  const GUARD_F = 'uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec3 vN; varying vec3 vP; varying vec3 vV;\n' +
    'void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); float hex = 0.5 + 0.5 * sin(vP.y * 22.0 - uTime * 3.0) * sin(atan(vP.x, vP.z) * 9.0); float a = (f * f * f * 0.8 + hex * f * f * 0.3) * uAlpha; gl_FragColor = vec4(uColor * (0.7 + f), a);\n#include <colorspace_fragment>\n}';
  const GUARD_V = 'varying vec3 vN; varying vec3 vP; varying vec3 vV; void main(){ vN = normalMatrix * normal; vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }';
  function makeSigil() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.translate(64, 64); g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineCap = 'round';
    g.lineWidth = 5; g.beginPath(); g.arc(0, 0, 52, 0, TAU); g.stroke();
    g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 42, 0, TAU); g.stroke();
    g.lineWidth = 4; for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.beginPath(); g.moveTo(Math.cos(a) * 14, Math.sin(a) * 14); g.lineTo(Math.cos(a) * 36, Math.sin(a) * 36); g.stroke(); g.beginPath(); g.moveTo(Math.cos(a + 0.35) * 30, Math.sin(a + 0.35) * 30); g.lineTo(Math.cos(a) * 36, Math.sin(a) * 36); g.lineTo(Math.cos(a - 0.35) * 30, Math.sin(a - 0.35) * 30); g.stroke(); }
    g.lineWidth = 3; for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; g.beginPath(); g.moveTo(Math.cos(a) * 44, Math.sin(a) * 44); g.lineTo(Math.cos(a) * (i % 2 ? 50 : 48), Math.sin(a) * (i % 2 ? 50 : 48)); g.stroke(); }
    g.beginPath(); g.arc(0, 0, 7, 0, TAU); g.fill();
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.userData.shared = true; return t;
  }
  function statusFor(u) {
    let s = stat.get(u.uid);
    if (!s) { s = { guard: null, mark: null, acc: { weak: 0, bleed: 0, hidden: 0, empower: 0, regen: 0, taunt: 0, stun: 0, ember: 0 } }; stat.set(u.uid, s); }
    return s;
  }
  function dropStatus(uid) {
    const s = stat.get(uid); if (!s) return;
    if (s.guard) AB.util.disposeObject(s.guard);
    if (s.mark) { s.mark.material.dispose(); root.remove(s.mark); }
    stat.delete(uid);
  }
  function updateStatus(u, dt) {
    const st = u.status || {};
    const alive = u.alive && !u.downed && u.spawned !== false;
    const any = alive && (st.guard || st.mark || st.weak || st.bleed || st.stun || st.hidden || st.taunt || st.empower || st.regen);
    let s = stat.get(u.uid);
    if (!any && !s) return;
    s = statusFor(u);
    const h = u.height || 1.7, x = u.pos.x, y = u.pos.y, z = u.pos.z;
    // guard: a pale shimmering shell
    if (alive && st.guard) {
      if (!s.guard) {
        if (!guardGeo) { guardGeo = new T.SphereGeometry(1, 20, 14); guardGeo.userData.shared = true; }
        const m = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color(0x9ec2e6) }, uTime: { value: 0 }, uAlpha: { value: 0 } }, vertexShader: GUARD_V, fragmentShader: GUARD_F, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
        s.guard = new T.Mesh(guardGeo, m); s.guard.renderOrder = 957; root.add(s.guard);
      }
      const g = s.guard; g.visible = true;
      g.position.set(x, y + h * 0.5, z); g.scale.set((u.radius || 0.4) + 0.22, h * 0.58, (u.radius || 0.4) + 0.22);
      const un = g.material.uniforms; un.uTime.value = now; s.gT = (s.gT || 0) + dt;
      let ga = s.gT < 0.25 ? 0.7 * Math.sin(s.gT / 0.25 * Math.PI * 0.5) : Math.max(0, 0.7 - (s.gT - 0.25) * 2.2);
      if (s.gHit > 0) { s.gHit = Math.max(0, s.gHit - dt); ga = Math.max(ga, 0.45 * s.gHit / 0.3); }
      un.uAlpha.value = ga * (0.9 + 0.1 * Math.sin(now * 3));
      g.visible = un.uAlpha.value > 0.005;
      if (Math.random() < dt * 1.2) ring(x, z, (u.radius || 0.4) + 0.25, (u.radius || 0.4) + 0.45, 0.6, 0x9ec2e6, 0.3, 0.04);
    } else if (s.guard) { s.gT = 0; const un = s.guard.material.uniforms; un.uAlpha.value = Math.max(0, un.uAlpha.value - dt * 3); if (un.uAlpha.value <= 0) s.guard.visible = false; }
    // mark: red sigil over the head
    if (alive && st.mark) {
      if (!s.mark) { if (!sigilTex) sigilTex = makeSigil(); s.mark = new T.Sprite(new T.SpriteMaterial({ map: sigilTex, color: 0xff4a3a, transparent: true, depthWrite: false, blending: T.AdditiveBlending })); s.mark.renderOrder = 958; root.add(s.mark); }
      s.mark.visible = true;
      AB.actors.socket(u, 'top', tmp);
      s.mark.position.set(x, Math.max(tmp.y, y + h) + 0.35 + Math.sin(now * 2.5) * 0.05, z);
      const sc = 0.55 + 0.05 * Math.sin(now * 5);
      s.mark.scale.set(sc, sc, 1); s.mark.material.rotation = Math.sin(now * 0.9) * 0.3; s.mark.material.opacity = 0.85;
      s.mark.material.color.setRGB(2.2, 0.5, 0.35);
    } else if (s.mark) s.mark.visible = false;
    if (!alive) return;
    const a = s.acc;
    // weak: grey drip; bleed: dark drops; hidden: ash wisps; empower: gold motes; regen: green motes; stun: swirl; taunt: pulse
    if (st.weak) { a.weak += dt * 3; while (a.weak > 1) { a.weak--; ALP && ALP.emit(x + rnd(-0.2, 0.2), y + h * rnd(0.3, 0.8), z + rnd(-0.2, 0.2), 0, -0.3, 0, 1.2, 0.07, 0.42, 0.4, 0.46, 0.75, { grav: 1.5, drag: 1, grow: 0 }); } }
    if (st.bleed) { a.bleed += dt * 4; while (a.bleed > 1) { a.bleed--; AB.actors.socket(u, 'chest', tmp); drops(tmp.x + rnd(-0.12, 0.12), tmp.y - 0.1, tmp.z + rnd(-0.12, 0.12), 1, 0x4a0808, 0.6, 0.7, 0.05, 0.95); } }
    if (st.hidden) { a.hidden += dt * 6; while (a.hidden > 1) { a.hidden--; ALP && ALP.emit(x + rnd(-0.35, 0.35), y + rnd(0, h), z + rnd(-0.35, 0.35), rnd(-0.1, 0.1), rnd(0.3, 0.7), rnd(-0.1, 0.1), 1.4, 0.18, 0.55, 0.53, 0.5, 0.35, { grow: 1.2, drag: 1, grav: 0 }); } }
    if (st.empower) { a.empower += dt * 7; while (a.empower > 1) { a.empower--; motes(x, y + h * rnd(0.1, 0.6), z, 1, 0xffc86a, (u.radius || 0.4) + 0.2, 0.9, 0.9, 0.08); } }
    if (st.regen) { a.regen += dt * 4; while (a.regen > 1) { a.regen--; motes(x, y + h * rnd(0.1, 0.6), z, 1, 0x86e09f, (u.radius || 0.4) + 0.15, 0.7, 1.0, 0.08); } }
    if (st.stun) {
      AB.actors.socket(u, 'head', tmp);
      for (let i = 0; i < 3; i++) { const ang = now * 5 + i * TAU / 3; ADD && ADD.emit(tmp.x + Math.cos(ang) * 0.28, tmp.y + 0.22 + Math.sin(now * 3 + i) * 0.04, tmp.z + Math.sin(ang) * 0.28, 0, 0, 0, 0.3, 0.09, 2.6, 2.4, 1.6, 1, { drag: 1, fadeIn: 0.01 }); }
    }
    if (st.taunt) { a.taunt -= dt; if (a.taunt <= 0) { a.taunt = 0.9; ring(x, z, (u.radius || 0.4) + 0.2, 3.2, 0.8, 0xff6a3a, 1.1, 0.18); } }
  }

  // per-unit ambient effects: smoke trailing from wraiths and shades, ripples around lurkers in water, embers off cinder foes
  const amb = new Map();
  function ambient(u, dt) {
    if (!u.alive || u.spawned === false) return;
    const g = u.glyph || '';
    if (g !== 'wraith' && g !== 'shade' && g !== 'lurker' && !/^(cinder|slag|kiln)/.test(u.id || '')) return;
    if (AB.camera && AB.camera.position.distanceToSquared(u.pos) > 2500) return;
    let a = amb.get(u.uid); if (!a) { a = { t: Math.random() }; amb.set(u.uid, a); }
    const h = u.height || 1.8;
    if (g === 'wraith' || g === 'shade') {
      a.t += dt * 10;
      const ember = u.def && u.def.act === 3;
      while (a.t > 1) { a.t--; ALP && ALP.emit(u.pos.x + rnd(-0.35, 0.35) * (u.scale || 1), u.pos.y + rnd(0, 0.5), u.pos.z + rnd(-0.35, 0.35) * (u.scale || 1), rnd(-0.15, 0.15) - u.vel.x * 0.2, rnd(0.2, 0.6), rnd(-0.15, 0.15) - u.vel.z * 0.2, rnd(1.0, 1.8), rnd(0.25, 0.45) * (u.scale || 1), ember ? 0.09 : 0.05, ember ? 0.07 : 0.06, ember ? 0.06 : 0.07, g === 'shade' ? 0.3 : 0.45, { grow: 1.3, drag: 1.2, grav: -0.1 }); if (ember && Math.random() < 0.2) sparks(u.pos.x, u.pos.y + h * 0.4, u.pos.z, 1, 0xff7a2a, 0.6, 1.0, 0.04, -0.3, 2); }
    } else if (g === 'lurker') {
      a.t += dt * 0.9;
      if (a.t > 1) { a.t = 0; const s = AB.world.surfaceAt ? AB.world.surfaceAt(u.pos.x, u.pos.z) : 'water'; ring(u.pos.x, u.pos.z, 0.4 * (u.scale || 1), 1.8 * (u.scale || 1), 1.4, s === 'water' ? 0x5a7a8a : 0x5a5a50, 0.5, 0.25, { lift: 0.04 }); }
    } else {
      a.t += dt * 3;
      while (a.t > 1) { a.t--; sparks(u.pos.x + rnd(-0.3, 0.3), u.pos.y + h * rnd(0.2, 0.8), u.pos.z + rnd(-0.3, 0.3), 1, 0xff7a2a, 0.5, 1.1, 0.04, -0.5, 2); }
    }
  }
  // downed heroes: a bleeding-out ring (red, fills toward the fall) that turns green while an ally revives them
  const downedTel = new Map();
  function updateDowned(us) {
    const DT = (AB.combat.TUNE && AB.combat.TUNE.downT) || 20, RT = (AB.combat.TUNE && AB.combat.TUNE.reviveT) || 2;
    for (let i = 0; i < us.length; i++) {
      const u = us[i];
      if (u.kind !== 'hero') continue;
      let g = downedTel.get(u.uid);
      if (!u.downed || !u.alive) { if (g) { g.mesh.visible = false; } continue; }
      if (!g) { g = makeTel(); downedTel.set(u.uid, g); }
      g.mesh.visible = true;
      conform(g.mesh.geometry, u.pos.x, u.pos.z, 1.2, 0.05);
      const un = g.mesh.material.uniforms, rev = clamp((u.reviveT || 0) / RT, 0, 1);
      un.uKind.value = 0; un.uTime.value = now; un.uAlpha.value = 0.85;
      if (rev > 0.01) { un.uProg.value = rev; un.uColor.value.setHex(0x86e09f); if (Math.random() < 0.3) motes(u.pos.x, u.pos.y + 0.4, u.pos.z, 1, 0x9fe0a8, 0.4, 0.8, 0.8, 0.07); }
      else { un.uProg.value = clamp(1 - (u.downT || 0) / DT, 0, 1); un.uColor.value.setHex(0xb02a20); }
    }
  }
  function onRevived({ unit }) {
    if (!unit || !root || FF()) return;
    motes(unit.pos.x, unit.pos.y + 0.3, unit.pos.z, 24, 0xffe8b0, 0.4, 1.4, 1.2, 0.09);
    ring(unit.pos.x, unit.pos.z, 0.3, 2.6, 0.7, 0xffe0a0, 1.5, 0.2);
    flashLight(unit.pos.x, unit.pos.y + 1, unit.pos.z, 0xffe0a0, 6, 0.4);
  }

  // =====================================================================================================
  // 7. THE EMBERHEART: glow light on Wren's hand + embers at high Corruption; the Wield shockwave
  // =====================================================================================================
  let veil = null, veilT = 0, flare = null, flareT = -1, flareTex = null, pillar = null, pillarT = -1, wave = null;
  function makeFlareTex() {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,220,160,0.9)'); gr.addColorStop(0.45, 'rgba(255,140,60,0.25)'); gr.addColorStop(1, 'rgba(255,100,30,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(255,210,150,0.8)'; g.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI; g.beginPath(); g.moveTo(64 - Math.cos(a) * 62, 64 - Math.sin(a) * 62); g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); g.stroke(); }
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.userData.shared = true; return t;
  }
  function ensureEmberRig() {
    if (veil || !AB.camera) return;
    veil = new T.Mesh(new T.PlaneGeometry(4, 4), new T.MeshBasicMaterial({ color: 0x050302, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    veil.position.set(0, 0, -0.15); veil.renderOrder = 900; veil.frustumCulled = false; veil.visible = false;
    AB.camera.add(veil);
    flareTex = makeFlareTex();
    flare = new T.Sprite(new T.SpriteMaterial({ map: flareTex, color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending }));
    flare.renderOrder = 970; flare.visible = false; root.add(flare);
    const pg = new T.CylinderGeometry(1, 1, 1, 28, 1, true); pg.translate(0, 0.5, 0);
    pillar = new T.Mesh(pg, new T.ShaderMaterial({ uniforms: { uA: { value: 0 }, uC: { value: new T.Color(0xff8a3a) } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uA; uniform vec3 uC; varying vec2 vU; void main(){ float a = uA * pow(1.0 - vU.y, 2.0) * (0.6 + 0.4 * sin(vU.x * 60.0)); gl_FragColor = vec4(uC * 2.5, a);\n#include <colorspace_fragment>\n}' }));
    pillar.renderOrder = 960; pillar.visible = false; pillar.frustumCulled = false; root.add(pillar);
  }
  function onEmber({ unit, x, y, z, radius }) {
    if (!root || FF()) return;
    ensureEmberRig();
    const R = radius || 9;
    const hand = unit ? AB.actors.socket(unit, 'ember', new V3()) : new V3(x, y + 1, z);
    veilT = 0.0001; if (veil) veil.visible = true;
    flareT = 0; if (flare) { flare.position.copy(hand); flare.visible = true; }
    pillarT = 0; if (pillar) { pillar.position.set(x, y - 0.2, z); pillar.visible = true; }
    wave = { x, z, t: 0, R };
    ring(x, z, 0.3, R, 0.6, 0xff8a3a, 2.4, 0.12);
    ring(x, z, 0.2, R * 0.75, 0.9, 0xff5a1a, 1.2, 0.5);
    // embers from the hand and shard flecks
    if (ADD) {
      for (let i = 0; i < 120 * PQ(); i++) { const a = Math.random() * TAU, e = rnd(-0.1, 1.2), s = rnd(3, 11); ADD.emit(hand.x, hand.y, hand.z, Math.cos(a) * s, e * s * 0.7, Math.sin(a) * s, rnd(0.6, 1.5), rnd(0.035, 0.1), 3.2, rnd(1.1, 1.9), 0.4, 1, { grav: -0.6, drag: 1.6, fadeIn: 0.01 }); }
      for (let i = 0; i < 24; i++) { const a = Math.random() * TAU, s = rnd(5, 9); ADD.emit(hand.x, hand.y, hand.z, Math.cos(a) * s, rnd(1, 4), Math.sin(a) * s, rnd(0.25, 0.5), 0.22, 4, 3, 2, 1, { grav: 3, drag: 3, fadeIn: 0.01 }); }
    }
    flashLight(hand.x, hand.y, hand.z, 0xff7a2a, 40, 0.6);
    AB.post.flash(0.28);
    if (AB.cam) { AB.cam.shake(0.35, 0.45); AB.cam.fovKick(-4, 0.45); }
  }
  function updateEmber(dt) {
    // veil (screen dim) 0 -> 0.5 -> 0 over ~1 s
    if (veil && veilT > 0) { veilT += dt; const q = veilT; veil.material.opacity = q < 0.08 ? q / 0.08 * 0.5 : Math.max(0, 0.5 * (1 - (q - 0.08) / 0.9)); if (q > 1) { veilT = 0; veil.visible = false; } }
    if (flare && flareT >= 0) { flareT += dt; const q = flareT / 0.55; const s = 0.4 + Math.sin(Math.min(1, q) * Math.PI * 0.5) * 3.6; flare.scale.set(s, s, 1); flare.material.opacity = Math.max(0, 1 - q); flare.material.rotation = flareT * 1.5; if (q >= 1) { flareT = -1; flare.visible = false; } }
    if (pillar && pillarT >= 0) { pillarT += dt; const q = pillarT / 0.5; pillar.scale.set(0.25 + q * 1.4, 7 * (1 - q * 0.3), 0.25 + q * 1.4); pillar.material.uniforms.uA.value = Math.max(0, 0.45 * (1 - q) * (1 - q)); if (q >= 1) { pillarT = -1; pillar.visible = false; } }
    if (wave) {   // dust thrown up along the expanding ring
      wave.t += dt; const q = wave.t / 0.6; const r = 0.3 + (wave.R - 0.3) * (1 - (1 - Math.min(1, q)) * (1 - Math.min(1, q)));
      const n = Math.round(6 * PQ());
      for (let i = 0; i < n; i++) { const a = Math.random() * TAU, px = wave.x + Math.cos(a) * r, pz = wave.z + Math.sin(a) * r, py = AB.world.heightAt(px, pz); ALP && ALP.emit(px, py + 0.1, pz, Math.cos(a) * 2, rnd(0.4, 1.2), Math.sin(a) * 2, rnd(0.5, 0.9), rnd(0.22, 0.38), 0.16, 0.13, 0.11, 0.35, { grow: 1.2, drag: 2.5, grav: -0.1 }); if (Math.random() < 0.3) ADD && ADD.emit(px, py + 0.2, pz, Math.cos(a), rnd(1, 3), Math.sin(a), rnd(0.6, 1.2), 0.08, 3, 1.4, 0.4, 1, { grav: -0.4, drag: 1 }); }
      if (q >= 1) wave = null;
    }
    // the Emberheart in Wren's hand
    const r = AB.state && AB.state.run;
    let w = null;
    const us = AB.combat.units();
    for (let i = 0; i < us.length; i++) { const u = us[i]; if (u.id === 'wren' && (u.kind === 'hero' || u.kind === 'display') && u.alive !== false) { w = u; break; } }
    if (w && AB.actors.view(w)) {
      AB.actors.socket(w, 'ember', tmp);
      const c = r ? r.corruption || 0 : 10;
      emberLight.position.copy(tmp);
      emberLight.intensity = (1.2 + c / 100 * 7) * (0.85 + 0.15 * Math.sin(now * 7.3) * Math.sin(now * 3.1)) * (w.downed ? 0.5 : 1) * (w.status && w.status.hidden ? 0.3 : 1);
      emberLight.distance = 5 + c / 100 * 5;
      const s = statusFor(w).acc;
      s.ember += dt * (c >= 40 ? 2 + (c - 40) / 10 : 0.5);
      while (s.ember > 1) { s.ember--; ADD && ADD.emit(tmp.x + rnd(-0.05, 0.05), tmp.y, tmp.z + rnd(-0.05, 0.05), rnd(-0.2, 0.2), rnd(0.3, 0.9), rnd(-0.2, 0.2), rnd(0.8, 1.6), rnd(0.03, 0.06), 3, 1.3, 0.35, 1, { grav: -0.3, drag: 0.8 }); if (c >= 70 && Math.random() < 0.4) ALP && ALP.emit(tmp.x, tmp.y, tmp.z, rnd(-0.1, 0.1), rnd(0.2, 0.5), rnd(-0.1, 0.1), 1.5, 0.12, 0.06, 0.05, 0.05, 0.4, { grow: 2, drag: 1, grav: 0 }); }
    } else emberLight.intensity = 0;
    // Maddoc's lantern
    let m = null;
    for (let i = 0; i < us.length; i++) { const u = us[i]; if (u.id === 'maddoc' && u.alive !== false && u.spawned !== false) { m = u; break; } }
    if (m && AB.actors.view(m)) {
      AB.actors.socket(m, 'lantern', tmp);
      lanternBoost = Math.max(0, lanternBoost - dt * 1.6);
      // keep the light at least 0.75 m from his head (the socket swings to 0.2-0.3 m while walking: white-hair blowout)
      AB.actors.socket(m, 'head', tmp2);
      tmp3.subVectors(tmp, tmp2); const hl = tmp3.length();
      if (hl < 0.75) { if (hl < 1e-3) tmp3.set(Math.sin(m.facing || 0), 0, Math.cos(m.facing || 0)); else tmp3.multiplyScalar(1 / hl); tmp.copy(tmp2).addScaledVector(tmp3, 0.75); }
      lanternLight.position.copy(tmp);
      lanternLight.intensity = (2.0 + Math.min(lanternBoost, 0.6) * 4) * (0.92 + 0.08 * Math.sin(now * 11) * Math.sin(now * 4.3)) * (m.downed ? 0.4 : 1);
      lanternLight.distance = 9 + Math.min(lanternBoost, 0.6) * 6;
      if (Math.random() < dt * 3) ADD && ADD.emit(tmp.x, tmp.y + 0.05, tmp.z, rnd(-0.05, 0.05), rnd(0.2, 0.4), rnd(-0.05, 0.05), 0.8, 0.03, 3, 2.4, 1.2, 1, { grav: -0.2, drag: 1 });
    } else lanternLight.intensity = 0;
    // effect flash light
    if (fxT > 0) { fxT -= dt; fxLight.intensity = fxI * Math.max(0, fxT / fxDur); } else fxLight.intensity = 0;
  }

  // =====================================================================================================
  // 8. TELEGRAPHS + lock / controlled rings
  // =====================================================================================================
  const lastThreat = new Map();   // src uid -> { x, z, r, kind }
  let lockRing = null, ctlRing = null;
  function updateTelegraphs() {
    const th = AB.combat.threats();
    let i = 0;
    for (; i < th.length; i++) {
      const t = th[i];
      if (i >= tels.length) tels.push(makeTel());
      const g = tels[i];
      g.mesh.visible = true;
      const src = AB.combat.unit(t.src), boss = src && src.tier === 'boss';
      const prog = t.total > 0 ? clamp(1 - t.left / t.total, 0, 1) : 1;
      if (g.id !== t.id || Math.abs(g.x - t.x) > 0.02 || Math.abs(g.z - t.z) > 0.02 || g.r !== t.radius) { conform(g.mesh.geometry, t.x, t.z, t.radius, 0.06); g.id = t.id; g.x = t.x; g.z = t.z; g.r = t.radius; }
      const u = g.mesh.material.uniforms;
      u.uProg.value = prog; u.uTime.value = now; u.uKind.value = t.kind === 'aoe' ? 1 : t.kind === 'proj' ? 2 : 0;
      u.uColor.value.setHex(t.kind === 'proj' ? 0xffa060 : boss ? 0xc02a1e : 0xd4574f);
      u.uAlpha.value = Math.min(1, prog * 6 + 0.25);
      lastThreat.set(t.src, { x: t.x, z: t.z, r: t.radius, kind: t.kind });
    }
    for (; i < tels.length; i++) tels[i].mesh.visible = false;
    // lock-on target and the controlled hero (subtle)
    const lk = AB.combat.lockTarget ? AB.combat.lockTarget() : null;
    if (lk && lk.alive) {
      if (!lockRing) lockRing = makeTel();
      lockRing.mesh.visible = true; conform(lockRing.mesh.geometry, lk.pos.x, lk.pos.z, (lk.radius || 0.5) + 0.35, 0.05);
      const u = lockRing.mesh.material.uniforms; u.uProg.value = 0; u.uKind.value = 0; u.uColor.value.setHex(0xd6b25e); u.uAlpha.value = 0.75; u.uTime.value = 0;
    } else if (lockRing) lockRing.mesh.visible = false;
    const c = AB.combat.controlled ? AB.combat.controlled() : null;
    if (c && c.alive && AB.state && AB.state.screen === 'play') {
      if (!ctlRing) ctlRing = makeTel();
      ctlRing.mesh.visible = true; conform(ctlRing.mesh.geometry, c.pos.x, c.pos.z, (c.radius || 0.4) + 0.3, 0.04);
      const u = ctlRing.mesh.material.uniforms; u.uProg.value = 0; u.uKind.value = 0; u.uColor.value.setHex(0x9ec2e6); u.uAlpha.value = 0.2; u.uTime.value = 0;
    } else if (ctlRing) ctlRing.mesh.visible = false;
  }

  // contact shadows: one instanced soft dark blob per unit, laid on the ground (grounds characters in shade / low tier)
  let blobs = null;
  const BLOB_MAX = 64, _bm = new T.Matrix4(), _bq = new T.Quaternion(), _bn = new V3(), _bp = new V3(), _bsv = new V3(), _up = new V3(0, 1, 0);
  function updateBlobs() {
    if (!blobs) {
      const g = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const m = new T.ShaderMaterial({ uniforms: { uA: { value: 0.4 } }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        vertexShader: 'varying vec2 vU; void main(){ vU = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float uA; varying vec2 vU; void main(){ float r = dot(vU, vU); float a = pow(max(0.0, 1.0 - r), 2.0) * uA; if (a < 0.004) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }' });
      blobs = new T.InstancedMesh(g, m, BLOB_MAX); blobs.frustumCulled = false; blobs.renderOrder = 4; root.add(blobs);
    }
    const sh = AB.quality && AB.quality.settings && AB.quality.settings.shadows;
    blobs.material.uniforms.uA.value = sh ? 0.38 : 0.55;
    const us = AB.combat.units();
    let n = 0;
    for (let i = 0; i < us.length && n < BLOB_MAX; i++) {
      const u = us[i];
      if (u.spawned === false) continue;
      const v = AB.actors.view(u); if (!v) continue;
      const gy = AB.world.heightAt(u.pos.x, u.pos.z);
      const lift = u.pos.y - gy;
      let r = ((u.radius || 0.4) * 2.4 + 0.25) * (u.glyph === 'swarm' ? 1.4 : 1);
      if (u.glyph === 'wyrm') r *= 1.8;
      const fade = u.alive ? 1 : Math.max(0, 1 - (u.deadT || 0) / 3);
      const k = Math.max(0.2, 1 - lift * 0.5) * fade * (u.glyph === 'swarm' || u.float ? 0.55 : 1) * (u.status && u.status.hidden ? 0.4 : 1);
      if (AB.world.normalAt) AB.world.normalAt(u.pos.x, u.pos.z, _bn); else _bn.set(0, 1, 0);
      _bq.setFromUnitVectors(_up, _bn);
      const fy = Math.sin(u.facing || 0), fz = Math.cos(u.facing || 0);
      _bp.set(u.pos.x + (u.glyph === 'wyrm' ? -fy * 1.2 * (u.scale || 1) : 0), gy + 0.03, u.pos.z + (u.glyph === 'wyrm' ? -fz * 1.2 * (u.scale || 1) : 0));
      _bsv.set(r * k + 0.001, 1, r * k + 0.001);
      _bm.compose(_bp, _bq, _bsv);
      blobs.setMatrixAt(n++, _bm);
    }
    blobs.count = n;
    blobs.instanceMatrix.needsUpdate = true;
  }

  // =====================================================================================================
  // 9. EVENTS
  // =====================================================================================================
  const HIT_STYLE = (u) => {
    const g = u.glyph || '';
    if (u.kind === 'hero') return u.id === 'brakka' ? 'metal' : 'blood';
    if (g === 'sentinel') return 'stone';
    if (g === 'soldier' || g === 'herald') return 'metal';
    if (g === 'wraith' || g === 'shade') return 'smoke';
    if (g === 'swarm') return 'bits';
    if (g === 'spider') return 'ichor';
    if (g === 'troll' && u.def && u.def.act > 1) return 'stone';
    if ((u.id || '').startsWith('cinder') || (u.id || '').startsWith('slag') || (u.id || '').startsWith('kiln')) return 'ember';
    return 'blood';
  };
  function onHit({ unit, src, amount, kind, heavy }) {
    if (!unit || !root || FF()) return;
    if (amount > 0 && unit.status && unit.status.guard) { const gs = stat.get(unit.uid); if (gs) gs.gHit = 0.3; }
    AB.actors.socket(unit, 'chest', tmp);
    if (src && src.pos) { tmp2.set(src.pos.x - unit.pos.x, 0, src.pos.z - unit.pos.z).normalize(); tmp.addScaledVector(tmp2, (unit.radius || 0.4) * 0.8); } else tmp2.set(0, 0, 0);
    const x = tmp.x, y = tmp.y, z = tmp.z;
    if (kind === 'dodged') { puff(unit.pos.x, unit.pos.y + 0.8, unit.pos.z, 5, 0xd8d8d0, 0.3, 1.2, 0.35, 0.25, 0.25, { grow: 2 }); return; }
    if (kind === 'bleed') { drops(x, y, z, 4, 0x4a0808, 1.2, 0.6, 0.05); return; }
    if (!amount) return;
    const big = heavy || amount >= 12;
    const st = HIT_STYLE(unit);
    const n = big ? 1.8 : 1;
    // the attacker's weapon colours the impact: magic from casters, sparks from steel
    const sid = src ? src.id : '';
    if (sid === 'maddoc') { sparks(x, y, z, 12 * n, 0xffe8b0, 3, 0.4, 0.12, 0.5, 1); flashLight(x, y, z, 0xffd090, 2.2, 0.15); }
    else if (sid === 'tamsin') { motes(x, y, z, 8 * n, 0xffd27a, 0.25, 0.8, 0.6, 0.1); }
    if (st === 'metal' || st === 'stone') sparks(x, y, z, 10 * n, 0xffd8a0, 5, 0.35, 0.05, 9, 1);
    if (st === 'stone') puff(x, y, z, 5 * n, 0x8a8678, 0.12, 1.5, 0.6, 0.22, 0.6, { grav: 3, grow: 0.8 });
    else if (st === 'blood') { drops(x, y, z, 6 * n, unit.kind === 'hero' ? 0x5a0a0a : 0x3a0a08, 2.4, 0.55, 0.055); puff(x, y, z, 2, 0x3a1a14, 0.05, 0.5, 0.3, 0.12, 0.35, { grow: 1 }); }
    else if (st === 'ichor') drops(x, y, z, 7 * n, 0x3a4a14, 2.4, 0.55, 0.06);
    else if (st === 'smoke') puff(x, y, z, 7 * n, 0x14161a, 0.2, 1.2, 0.8, 0.35, 0.55, { grow: 1.6 });
    else if (st === 'bits') drops(x, y, z, 8 * n, 0x1a1814, 2, 0.5, 0.04);
    else if (st === 'ember') { sparks(x, y, z, 12 * n, 0xff7a2a, 4, 0.5, 0.07, 6, 1); puff(x, y, z, 3, 0x2a2420, 0.1, 0.8, 0.6, 0.2, 0.45); }
    if (big) { sparks(x, y, z, 4, 0xffe0c0, 6, 0.16, 0.045, 2, 1); }
    // camera: heavy hits on the hero you control, any heavy boss blow
    if (AB.cam) {
      const ctl = AB.combat.controlled();
      if (unit === ctl) AB.cam.shake(big ? 0.22 : 0.08, big ? 0.3 : 0.15);
      else if (src && src.tier === 'boss' && big) AB.cam.shake(0.14, 0.25);
      else if (src === ctl && big) AB.cam.shake(0.06, 0.1);
    }
    if (numbersOn()) number(unit, amount, unit.kind === 'hero' ? '#d4574f' : big ? '#ffc06a' : '#e8e2cf');
  }
  function onHeal({ unit, amount, kind }) {
    if (!unit || !root || FF() || !amount) return;
    if (kind === 'regen') { motes(unit.pos.x, unit.pos.y + 0.6, unit.pos.z, 3, 0x86e09f, 0.35, 0.7, 0.9, 0.07); return; }
    const n = clamp(amount, 4, 18);
    motes(unit.pos.x, unit.pos.y + 0.3, unit.pos.z, n, 0x9fe0a8, (unit.radius || 0.4) + 0.15, 1.1, 1.1, 0.09);
    motes(unit.pos.x, unit.pos.y + 0.6, unit.pos.z, n * 0.4, 0xffe0a0, 0.3, 0.8, 1.0, 0.06);
    ring(unit.pos.x, unit.pos.z, 0.2, (unit.radius || 0.4) + 0.9, 0.7, 0x86e09f, 1.1, 0.3);
    if (numbersOn()) number(unit, amount, '#86b08f', '+');
  }
  const pending = [];   // delayed cosmetic effects { at, fn }
  function later(sec, fn) { pending.push({ at: now + sec, fn }); }
  function onDeath({ unit }) {
    if (!unit || !root || FF()) return;
    const g = unit.glyph || '', x = unit.pos.x, y = unit.pos.y, z = unit.pos.z, h = unit.height || 1.7;
    if (g === 'wraith' || g === 'shade') {
      for (let i = 0; i < 4; i++) later(i * 0.2, () => puff(x, y + h * (0.3 + i * 0.15), z, 10, 0x101216, 0.35, 1.0, 1.6, 0.5, 0.55, { grow: 1.8, up: 1.2, grav: -0.4 }));
      sparks(x, y + h * 0.85, z, 14, unit.def && unit.def.act === 3 ? 0xff9040 : 0x9ad8ff, 2, 0.9, 0.08, -0.5, 1);
    } else if (g === 'swarm') {
      drops(x, y + 1, z, 16, 0x1a1814, 2, 0.8, 0.04);
    } else {
      const ember = /^(cinder|slag|kiln)/.test(unit.id || '');
      later(0.65, () => { const gy = AB.world.heightAt(x, z); puff(x, gy + 0.1, z, 8 * Math.max(1, unit.scale || 1), 0x6a5e50, 0.5 * (unit.scale || 1), 1.6, 1.0, 0.45, 0.45, { grow: 1.5, up: 0.4 }); if (ember) sparks(x, gy + 0.3, z, 20, 0xff7a2a, 3, 1.0, 0.06, -0.3, 1); });
    }
    if (unit.tier === 'boss') { flashLight(x, y + h * 0.6, z, 0xffe0b0, 25, 0.9); ring(x, z, 0.5, 10, 1.2, 0xffd8a0, 1.6, 0.15); }
  }
  function onAction(ev) {
    const u = ev.unit; if (!u || !root || FF()) return;
    const ab = ev.ability || '';
    if (ev.phase === 'start') {
      // weapon trails for melee swings (timed to the swing of the clip)
      if (ev.slot !== 'intent') {
        const melee = /twin_cuts|hammer_blow|dirty_blade|backstab|cut_purse|hunters_volley|mark_quarry|defy/.test(ab) || (ab === 'cutting_verse' && ev.target && U.dist2(ev.target.pos.x, ev.target.pos.z, u.pos.x, u.pos.z) < 3.2);
        const dur = (u.action ? u.action.dur : 0.8) + 0.1;
        if (melee) {
          const hex = u.id === 'brakka' ? 0xb8c8d8 : u.id === 'rook' ? 0xd8d8e0 : u.id === 'ysolde' ? 0xc8e0c8 : u.id === 'tamsin' ? 0xffd090 : 0xd0d0d0;
          startTrail(u, hex, dur, 0.5, 1);
          if (u.id === 'ysolde') startTrail(u, hex, dur, 0.5, 2);
        }
        if (ab === 'wield_emberheart') startTrail(u, 0xff8a3a, dur, 0.8, 2);
      } else {
        const melee = ev.shape === 'melee' || ev.shape === 'aoe';
        const g = u.glyph || '';
        if (melee && !/hound|beast|spider|lurker|wyrm|swarm/.test(g)) startTrail(u, u.tier === 'boss' ? 0xff9a6a : 0xb0a898, (ev.windup || 0.9) + 0.5, u.tier === 'boss' ? 0.55 : 0.35, 1);
        // casters gather power while winding up
        if (ev.shape === 'cast' || ev.shape === 'proj') { AB.actors.socket(u, 'muzzle', tmp); const hex = /shade|wraith/.test(g) ? 0x8ac8ff : g === 'spider' ? 0x9ad04a : g === 'sentinel' ? 0x7ae0d0 : 0xff7a30; for (let i = 0; i < 3; i++) later(i * 0.15, () => { AB.actors.socket(u, 'muzzle', tmp); motes(tmp.x, tmp.y, tmp.z, 4, hex, 0.25, 0.2, 0.5, 0.08); }); }
      }
      return;
    }
    // release
    if (ev.slot === 'intent') {
      const lt = lastThreat.get(u.uid);
      if (ev.shape === 'aoe' && lt) {
        const gy = AB.world.heightAt(lt.x, lt.z);
        ring(lt.x, lt.z, 0.3, lt.r * 1.1, 0.5, u.tier === 'boss' ? 0xff5a2a : 0xd8a070, 1.4, 0.2);
        puff(lt.x, gy + 0.1, lt.z, 14, 0x6a5e50, lt.r * 0.6, 2.2, 0.9, 0.45, 0.5, { grow: 1.3, up: 0.5 });
        if (AB.cam && AB.combat.controlled() && U.dist2(AB.combat.controlled().pos.x, AB.combat.controlled().pos.z, lt.x, lt.z) < 14) AB.cam.shake(u.tier === 'boss' ? 0.25 : 0.12, 0.3);
      }
      if (ev.shape === 'cast') {
        const t = ev.target && ev.target.pos ? ev.target : null;
        AB.actors.socket(u, 'muzzle', tmp);
        const g = u.glyph || '', hex = /shade|wraith/.test(g) ? 0x6a8aa8 : 0xff6a2a;
        puff(tmp.x, tmp.y, tmp.z, 8, /shade|wraith/.test(g) ? 0x101418 : 0x2a1a14, 0.3, 1.2, 1.0, 0.35, 0.5, { grow: 1.6 });
        if (t) ribbon(u, 'muzzle', t, hex, 0.6, { width: 0.05, lift: 0.4 });
        if (/horn|call|whistle|proclaim|roar|bellow|howl/.test(ab)) ring(u.pos.x, u.pos.z, 0.5, 8, 0.9, 0xd8b080, 0.9, 0.12);
      }
      return;
    }
    const t = ev.target;
    switch (ab) {
      case 'encourage': if (t && t !== u) ribbon(u, 'hand_r', t, 0xffc86a, 0.7); motes(u.pos.x, u.pos.y + 1, u.pos.z, 10, 0xffd08a, 0.3, 0.9, 0.9, 0.07); break;
      case 'fade_into_ash': puff(u.pos.x, u.pos.y + 0.4, u.pos.z, 26, 0x4a4642, 0.5, 1.6, 1.4, 0.5, 0.55, { grow: 1.6, up: 0.8 }); sparks(u.pos.x, u.pos.y + 0.8, u.pos.z, 20, 0xff7a2a, 2, 1.0, 0.05, -0.3, 1); break;
      case 'mend': if (t) ribbon(u, 'hand_l', t, 0x9fe0a8, 0.75, { width: 0.08 }); lanternPulse(0.5); break;
      case 'kindle_old_light': {
        AB.actors.socket(u, 'lantern', tmp); flashLight(tmp.x + Math.sin(u.facing || 0), tmp.y, tmp.z + Math.cos(u.facing || 0), 0xffe0a0, 22, 0.9);
        ring(u.pos.x, u.pos.z, 0.5, 14, 1.0, 0xffe0a0, 1.6, 0.15);
        for (const a of AB.combat.units()) if (a.kind === 'hero' && a !== u && a.alive && !a.downed && U.dist2(a.pos.x, a.pos.z, u.pos.x, u.pos.z) < 16) ribbon(u, 'lantern', a, 0xffe8b0, 0.9, { width: 0.06, lift: 1.4 });
        motes(tmp.x, tmp.y, tmp.z, 30, 0xffe8b0, 0.4, 1.4, 1.2, 0.08);
        break;
      }
      case 'lantern_flare': { AB.actors.socket(u, 'lantern', tmp); flashLight(tmp.x + Math.sin(u.facing || 0), tmp.y, tmp.z + Math.cos(u.facing || 0), 0xffe0a0, 10, 0.35); sparks(tmp.x, tmp.y, tmp.z, 12, 0xffe0a0, 2, 0.4, 0.1, 0, 1); break; }
      case 'marching_song': {
        for (let i = 0; i < 3; i++) later(i * 0.18, () => ring(u.pos.x, u.pos.z, 0.4, 9, 0.9, 0xffc860, 1.1, 0.1));
        for (const a of AB.combat.units()) if (a.kind === 'hero' && a.alive && !a.downed && a !== u && U.dist2(a.pos.x, a.pos.z, u.pos.x, u.pos.z) < 16) ribbon(u, 'mouth', a, 0xffc860, 0.9, { width: 0.04, lift: 1.0 });
        motes(u.pos.x, u.pos.y + 1.2, u.pos.z, 18, 0xffd27a, 0.4, 1.2, 1.2, 0.07);
        break;
      }
      case 'dirge_old_kings': { for (let i = 0; i < 3; i++) later(i * 0.22, () => ring(u.pos.x, u.pos.z, 0.6, 10, 1.1, 0x8a6ab0, 1.0, 0.25)); if (t) puff(t.pos.x, t.pos.y + 1, t.pos.z, 12, 0x2a2238, 0.6, 1.0, 1.2, 0.5, 0.45, { grow: 1.6 }); break; }
      case 'shield_wall': ring(u.pos.x, u.pos.z, 0.3, 6, 0.6, 0x9ec2e6, 1.6, 0.18); puff(u.pos.x, u.pos.y + 0.1, u.pos.z, 10, 0x6a5e50, 0.6, 1.5, 0.7, 0.35, 0.4, { up: 0.3 }); if (AB.cam && u === AB.combat.controlled()) AB.cam.shake(0.08, 0.15); break;
      case 'defy': ring(u.pos.x, u.pos.z, 0.4, 7, 0.7, 0xff6a3a, 1.6, 0.2); break;
      case 'rain_of_thorns': {
        if (t) { const cx = t.pos.x, cz = t.pos.z; for (let i = 0; i < 14; i++) later(0.15 + i * 0.03, () => { const a = Math.random() * TAU, r = Math.random() * 4.5, px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r, py = AB.world.heightAt(px, pz); thorn(px, py, pz); }); }
        break;
      }
      case 'cut_purse': if (t) { for (let i = 0; i < 6; i++) ADD && ADD.emit(t.pos.x, t.pos.y + 1, t.pos.z, (u.pos.x - t.pos.x) * rnd(0.8, 1.4), rnd(1.5, 3), (u.pos.z - t.pos.z) * rnd(0.8, 1.4), 0.7, 0.07, 3, 2.4, 0.8, 1, { grav: 6, drag: 0.5, fadeIn: 0.01 }); } break;
      case 'mark_quarry': if (t) { AB.actors.socket(t, 'head', tmp); sparks(tmp.x, tmp.y + 0.3, tmp.z, 10, 0xff4a3a, 2, 0.5, 0.08, 0, 1); } break;
      default: break;
    }
  }
  // falling arrows for Rain of Thorns (visual only)
  const thorns = [];
  function thorn(x, y, z) {
    let th = thorns.find((t) => !t.on);
    if (!th) { if (thorns.length >= 20) return; th = { mesh: projMesh('arrow'), on: false }; root.add(th.mesh); thorns.push(th); }
    th.on = true; th.t = 0; th.x = x; th.y = y; th.z = z; th.mesh.visible = true; th.ox = rnd(-2, 2); th.oz = rnd(-2, 2);
  }
  function updateThorns(dt) {
    for (const th of thorns) {
      if (!th.on) continue;
      th.t += dt; const q = Math.min(1, th.t / 0.28);
      const sx = th.x + th.ox * (1 - q), sy = th.y + 14 * (1 - q), sz = th.z + th.oz * (1 - q);
      th.mesh.position.set(sx, sy + 0.3, sz); tmp.set(th.x, th.y, th.z); th.mesh.lookAt(tmp);
      if (q >= 1 && !th.landed) { th.landed = true; puff(th.x, th.y + 0.05, th.z, 3, 0x6a5a48, 0.08, 1, 0.5, 0.2, 0.5); }
      if (th.t > 1.6) { th.on = false; th.landed = false; th.mesh.visible = false; }
    }
  }
  function onDodge({ unit }) {
    if (!unit || !root || FF()) return;
    puff(unit.pos.x, unit.pos.y + 0.05, unit.pos.z, 8, surfaceDust(unit.pos.x, unit.pos.z), 0.25, 1.6, 0.6, 0.3, 0.45, { up: 0.3 });
    if (AB.cam && unit === AB.combat.controlled()) AB.cam.fovKick(5, 0.35);
  }
  function surfaceDust(x, z) {
    const s = AB.world && AB.world.surfaceAt ? AB.world.surfaceAt(x, z) : 'dirt';
    return s === 'snow' ? 0xe8eef4 : s === 'ash' ? 0x3a3634 : s === 'stone' ? 0x8a8680 : s === 'water' ? 0xc8d8e0 : s === 'grass' ? 0x7a7058 : 0x7a6a58;
  }
  function step(o) {
    if (!root || FF()) return;
    const s = o.surface || 'dirt', x = o.x, y = o.y, z = o.z, k = o.scale || 1;
    if (s === 'water') { drops(x, y + 0.05, z, 5 * k, 0xc8dce8, 1.6, 0.4, 0.05, 0.7); ring(x, z, 0.1, 0.7 * k, 0.8, 0x6a8a9a, 0.6, 0.35, { lift: 0.03 }); return; }
    if (s === 'wood') return;
    const hex = surfaceDust(x, z);
    const n = s === 'snow' ? 3 : s === 'grass' ? 1 : s === 'stone' ? 1 : 2;
    puff(x, y + 0.04, z, n * k, hex, 0.08 * k, s === 'snow' ? 0.8 : 0.6, s === 'snow' ? 0.55 : 0.5, (s === 'snow' ? 0.17 : 0.14) * k, s === 'snow' ? 0.32 : s === 'grass' ? 0.18 : 0.28, { up: 0.4, grow: 1.2 });
    if (s === 'ash' && Math.random() < 0.25) sparks(x, y + 0.05, z, 2, 0xff7a2a, 0.8, 0.8, 0.04, -0.4, 2);
    if (k > 1.6) ring(x, z, 0.2, 1.2 * k, 0.5, 0x8a7a68, 0.35, 0.3);
  }

  // =====================================================================================================
  // 10. OPTIONAL WORLD-SPACE DAMAGE NUMBERS (off by default; ui.js renders DOM numbers)
  // =====================================================================================================
  const nums = [];
  const numbersOn = () => AB.vfx.numbers === true || (AB.vfx.numbers !== false && AB.ui && AB.ui.damageNumbers === false);
  function number(u, amount, css, prefix) {
    let N = nums.find((n) => !n.on);
    if (!N) {
      if (nums.length >= 24) return;
      const c = document.createElement('canvas'); c.width = 128; c.height = 64;
      const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
      const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      sp.renderOrder = 990; root.add(sp);
      N = { c, tex, sp, on: false }; nums.push(N);
    }
    const g = N.c.getContext('2d'); g.clearRect(0, 0, 128, 64);
    g.font = 'bold 40px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 6; g.strokeStyle = 'rgba(10,8,6,0.85)';
    const txt = (prefix || '') + Math.round(amount); g.strokeText(txt, 64, 34); g.fillStyle = css; g.fillText(txt, 64, 34);
    N.tex.needsUpdate = true; N.on = true; N.t = 0; AB.actors.socket(u, 'top', N.p = new V3()); N.p.x += rnd(-0.3, 0.3); N.sp.visible = true;
  }
  function updateNumbers(dt) {
    for (const N of nums) { if (!N.on) continue; N.t += dt; const q = N.t / 0.9; N.sp.position.set(N.p.x, N.p.y + q * 0.7, N.p.z); const s = 0.55 * (q < 0.12 ? 0.6 + q / 0.12 * 0.5 : 1.1 - (q - 0.12) * 0.15); N.sp.scale.set(s * 2, s, 1); N.sp.material.opacity = Math.min(1, (1 - q) * 3); if (q >= 1) { N.on = false; N.sp.visible = false; } }
  }

  // =====================================================================================================
  // 11. FRAME + API
  // =====================================================================================================
  let now = 0;
  function ensureRoot() {
    if (root || !AB.scene) return root;
    root = new T.Group(); root.name = 'vfx'; AB.scene.add(root);
    const q = PQ();
    ADD = new Pool(Math.round(1400 * Math.max(0.5, q)), true, 0.15);
    ALP = new Pool(Math.round(1400 * Math.max(0.5, q)), false, 0.35);
    root.add(ADD.pts); root.add(ALP.pts);
    emberLight = new T.PointLight(0xff7a2a, 0, 7, 2); lanternLight = new T.PointLight(0xffd59a, 0, 9, 2); fxLight = new T.PointLight(0xffa060, 0, 12, 2);
    root.add(emberLight); root.add(lanternLight); root.add(fxLight);
    ready = true;
    return root;
  }
  function frame(dt, realDt) {
    if (!ensureRoot()) return;
    const d = Math.min(0.1, dt);
    now += d;
    if (AB.renderer && AB.camera) {
      const scale = AB.renderer.domElement.height / (2 * Math.tan(AB.camera.fov * Math.PI / 360));
      ADD.mat.uniforms.uScale.value = scale; ALP.mat.uniforms.uScale.value = scale;
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= now) { const p = pending[i]; pending.splice(i, 1); try { p.fn(); } catch (e) { /* cosmetic */ } }
    try { updateTelegraphs(); } catch (e) { warnOnce('tel', e); }
    try { updateBlobs(); } catch (e) { warnOnce('blobs', e); }
    try { updateProjectiles(d); } catch (e) { warnOnce('proj', e); }
    try { const us = AB.combat.units(); for (let i = 0; i < us.length; i++) { updateStatus(us[i], d); ambient(us[i], d); } updateDowned(us); } catch (e) { warnOnce('status', e); }
    try { updateEmber(d); } catch (e) { warnOnce('ember', e); }
    updateTrails(d); updateRibbons(d); updateRings(d); updateThorns(d); updateNumbers(d);
    ADD.update(d); ALP.update(d);
    void realDt;
  }
  const warned = {};
  function warnOnce(k, e) { if (!warned[k]) { warned[k] = true; console.warn('[vfx] ' + k, e); } }
  function clearAll() {
    if (ADD) { ADD.clear(); ALP.clear(); }
    for (const R of rings) { R.on = false; R.mesh.visible = false; }
    for (const R of ribbons) { R.on = false; R.mesh.visible = false; }
    for (const tr of trails) { tr.unit = null; while (tr.samples.length) samplePool.push(tr.samples.pop()); tr.mesh.visible = false; }
    for (const th of thorns) { th.on = false; th.mesh.visible = false; }
    for (const [id, pv] of projVis) { pv.mesh.visible = false; (projPool[pv.kind] || (projPool[pv.kind] = [])).push(pv.mesh); projVis.delete(id); }
    for (const uid of Array.from(stat.keys())) dropStatus(uid);
    lastThreat.clear(); pending.length = 0; wave = null; amb.clear();
    for (const g of downedTel.values()) g.mesh.visible = false;
  }
  AB.vfx = {
    numbers: undefined,      // true: draw world-space damage numbers here (ui.js normally draws DOM ones)
    init() {
      AB.bus.on('unit:hit', onHit);
      AB.bus.on('unit:heal', onHeal);
      AB.bus.on('unit:death', onDeath);
      AB.bus.on('unit:action', onAction);
      AB.bus.on('ember', onEmber);
      AB.bus.on('dodge', onDodge);
      AB.bus.on('projectile', onProjectile);
      AB.bus.on('projectile:end', onProjectileEnd);
      AB.bus.on('unit:revived', onRevived);
      AB.bus.on('unit:despawn', ({ unit }) => { if (unit) { dropStatus(unit.uid); amb.delete(unit.uid); const g = downedTel.get(unit.uid); if (g) { AB.util.disposeObject(g.mesh); downedTel.delete(unit.uid); } for (const tr of trails) if (tr.unit === unit) tr.unit = null; } });
      AB.bus.on('level:disposed', clearAll);
      AB.bus.on('run:new', clearAll);
      AB.loop.add('vfx', frame, { phase: 'frame', order: AB.loop.ORDER.vfx });
    },
    // spawn(name, opts): one-shot effects. burst {x,y,z,n,color,speed,life} | wave {x,y,z,radius} (the ember shockwave) |
    // step {x,y,z,surface,scale} | ring {x,z,r0,r1,dur,color} | puff {x,y,z,n,color,size} | motes {x,y,z,n,color} | flash {x,y,z,color,intensity}
    spawn(name, o = {}) {
      if (!ensureRoot() || FF()) return;
      const x = o.x || 0, y = o.y || 0, z = o.z || 0;
      if (name === 'burst') sparks(x, y, z, o.n || 12, o.color != null ? o.color : 0xffffff, o.speed || 4, o.life || 0.6, o.size || 0.1, 6, 1);
      else if (name === 'wave') onEmber({ unit: o.unit || null, x, y, z, radius: o.radius || 6 });
      else if (name === 'step') step(o);
      else if (name === 'ring') ring(x, z, o.r0 || 0.2, o.r1 || 3, o.dur || 0.6, o.color != null ? o.color : 0xffd8a0, o.intensity || 1.4, o.width || 0.25);
      else if (name === 'puff') puff(x, y, z, o.n || 8, o.color != null ? o.color : 0x7a6a58, o.spread || 0.2, o.speed || 1, o.life || 0.8, o.size || 0.3, o.alpha || 0.5);
      else if (name === 'motes') motes(x, y, z, o.n || 8, o.color != null ? o.color : 0xffd8a0, o.spread || 0.3, o.rise || 0.8, o.life || 1, o.size || 0.08);
      else if (name === 'flash') flashLight(x, y, z, o.color != null ? o.color : 0xffd8a0, o.intensity || 8, o.dur || 0.25);
    },
    ready: () => ready,
    _frame: (dt) => frame(dt, dt),     // profiling hook for tools
    stats: () => ({ add: ADD ? ADD.n : 0, alp: ALP ? ALP.n : 0, trails: trails.length, rings: rings.length, tels: tels.length, statuses: stat.size, projectiles: projVis.size })
  };
}
