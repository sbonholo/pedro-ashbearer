'use strict';
/* ASHBEARER v3 :: actors.js
   OWNER: ACTORS lane (actors.js + vfx.js).
   Procedural characters: every unit is ONE SkinnedMesh (1 draw call + 1 shadow call) built from smooth skinned tubes,
   lathes and props bound to an Object3D bone hierarchy, textured by a procedural 16-tile PBR atlas (skin, cloth weave,
   wool, leather, mail, plate, bronze, wood, hair, fur, stone, scales, oilskin, bone, wet flesh, rope) sampled per
   vertex tile with fract() in a patched MeshStandardMaterial (+ per-vertex glow channels and a rim term).
   Rigs: human (heroes and humanoid foes), quad (hound, beast), spider (8 IK legs), serpent (lurker, wyrm),
   float (wraith, shade), swarm (instanced cloud). Animation = procedural locomotion matched to speed (no foot sliding)
   + keyframed clips in impact-normalised time (0 start, 1 impact, 2 end) + crossfades + springs (cloaks, braids,
   tails, lanterns) + procedural death falls. Posed every FRAME (order 50) from unit sim state and bus events.
   Never writes simulation fields: only unit.view. Cosmetic randomness uses Math.random.
   Bus events added by this lane: 'actors:step' {unit, x, y, z, surface, foot, heavy} (footfalls, for audio/vfx). */
{
  const T = AB.THREE;
  const U = AB.util;
  const V3 = T.Vector3;
  const TAU = Math.PI * 2;
  const PI = Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const _v1 = new V3(), _v2 = new V3(), _v3 = new V3(), _v4 = new V3();
  const _q1 = new T.Quaternion(), _q2 = new T.Quaternion();
  const _m1 = new T.Matrix4(), _m2 = new T.Matrix4();
  const _e1 = new T.Euler();
  const _c1 = new T.Color(), _c2 = new T.Color();
  const col = (hex) => new T.Color(hex);

  // =====================================================================================================
  // 1. PROCEDURAL PBR ATLAS (512 x 512, 4 x 4 tiles of 128 px; albedo (detail, tinted by vertex colour),
  //    normal, ORM (G roughness, B metalness)). Generated once; tileable inside each tile.
  // =====================================================================================================
  const TS = 128, TPR = 4, AS = TS * TPR;
  const TILE = { skin: 0, cloth: 1, wool: 2, leather: 3, mail: 4, plate: 5, bronze: 6, wood: 7, hair: 8, fur: 9, stone: 10, scale: 11, oilskin: 12, bone: 13, flesh: 14, rope: 15 };
  const TEXM = 0.2;   // metres covered by one tile repeat on a body
  const tileOff = (name) => { const i = TILE[name] != null ? TILE[name] : 1; return [(i % TPR) / TPR, Math.floor(i / TPR) / TPR]; };
  let atlas = null;

  function pnoise(px, py, seed) {      // smooth periodic value noise on the tile grid, [0, 1]
    const r = AB.rng('act-noise-' + px + '-' + py + '-' + seed);
    const g = new Float32Array(px * py); for (let i = 0; i < g.length; i++) g[i] = r.next();
    const out = new Float32Array(TS * TS);
    for (let y = 0; y < TS; y++) {
      const fy = y / TS * py, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % py;
      for (let x = 0; x < TS; x++) {
        const fx = x / TS * px, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % px;
        const a = g[y0 * px + x0], b = g[y0 * px + x1], c = g[y1 * px + x0], d = g[y1 * px + x1];
        out[y * TS + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
      }
    }
    return out;
  }
  function worley(n, seed) {           // periodic cellular noise: f1, f2 (in cell units), cell id hash
    const r = AB.rng('act-worley-' + n + '-' + seed);
    const px = new Float32Array(n * n), py = new Float32Array(n * n), id = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) { px[i] = r.next(); py[i] = r.next(); id[i] = r.next(); }
    const f1 = new Float32Array(TS * TS), f2 = new Float32Array(TS * TS), cid = new Float32Array(TS * TS);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const fx = x / TS * n, fy = y / TS * n, cx = Math.floor(fx), cy = Math.floor(fy);
      let d1 = 9, d2 = 9, best = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j, wx = ((gx % n) + n) % n, wy = ((gy % n) + n) % n, k = wy * n + wx;
        const dx = gx + px[k] - fx, dy = gy + py[k] - fy, d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) { d2 = d1; d1 = d; best = id[k]; } else if (d < d2) d2 = d;
      }
      const o = y * TS + x; f1[o] = d1; f2[o] = d2; cid[o] = best;
    }
    return { f1, f2, id: cid };
  }
  function genAtlas() {
    const ALB = new Uint8Array(AS * AS * 4), NRM = new Uint8Array(AS * AS * 4), ORM = new Uint8Array(AS * AS * 4);
    const H = new Float32Array(TS * TS);
    const n4 = pnoise(4, 4, 1), n8 = pnoise(8, 8, 2), n16 = pnoise(16, 16, 3), n32 = pnoise(32, 32, 4), n64 = pnoise(64, 64, 5);
    const n8b = pnoise(8, 8, 6), brushed = pnoise(4, 64, 7), strands = pnoise(64, 4, 8), strands2 = pnoise(32, 8, 9), n16b = pnoise(16, 16, 10);
    const w16 = worley(16, 1), w8 = worley(8, 2), w5 = worley(5, 3), w4 = worley(4, 4);
    const tmp = [0, 0, 0, 0, 0, 0];   // h, r, g, b, rough, metal
    const ridge = (v) => 1 - Math.abs(2 * v - 1);
    const gens = {
      skin(x, y, i, o) { const a = 0.9 + (n16[i] - 0.5) * 0.1 + (n64[i] - 0.5) * 0.04; o[0] = n64[i] * 0.3 + n32[i] * 0.2; o[1] = a * (1.0 + (n8[i] - 0.5) * 0.06); o[2] = a * 0.985; o[3] = a * 0.975; o[4] = 0.52 + n32[i] * 0.16; o[5] = 0; },
      cloth(x, y, i, o) {
        const wx = x % 6, wy = y % 6, cell = (Math.floor(x / 6) + Math.floor(y / 6)) & 1;
        const sa = Math.sin(PI * (wx + 0.5) / 6), sb = Math.sin(PI * (wy + 0.5) / 6);
        const h = cell ? sa * (0.55 + 0.45 * sb) : sb * (0.55 + 0.45 * sa);
        o[0] = h * 0.8 + n64[i] * 0.2; const a = 0.74 + h * 0.2 + (n16[i] - 0.5) * 0.12 + (n64[i] - 0.5) * 0.06;
        o[1] = o[2] = o[3] = a; o[4] = 0.88 + n32[i] * 0.1; o[5] = 0;
      },
      wool(x, y, i, o) {
        const d = ((x + y) % 8) / 8, tw = Math.sin(d * TAU) * 0.5 + 0.5;
        o[0] = tw * 0.5 + n64[i] * 0.5; const a = 0.7 + tw * 0.12 + (n8[i] - 0.5) * 0.16 + (n64[i] - 0.5) * 0.1;
        o[1] = o[2] = o[3] = a; o[4] = 0.95; o[5] = 0;
      },
      leather(x, y, i, o) {
        const bump = 1 - Math.min(1, w16.f1[i] * 1.3), cr = ridge(n8[i]), cr2 = Math.pow(cr, 6);
        o[0] = bump * 0.35 + cr * 0.25 - cr2 * 0.3; const a = 0.7 + (n16[i] - 0.5) * 0.22 + cr2 * 0.12 + (n64[i] - 0.5) * 0.05;
        o[1] = a; o[2] = a * 0.98; o[3] = a * 0.95; o[4] = 0.5 + n16[i] * 0.22 - cr2 * 0.08; o[5] = 0;
      },
      mail(x, y, i, o) {
        const P = 8, row = Math.floor(y / (P * 0.75)), off = (row & 1) * P * 0.5;
        let best = 9;
        for (let r = row - 1; r <= row + 1; r++) {
          const cy = (r + 0.5) * P * 0.75, ox = (r & 1) * P * 0.5;
          for (let k = -1; k <= 1; k++) { const cx = (Math.floor((x - ox) / P) + k + 0.5) * P + ox; const d = Math.abs(Math.hypot(x - cx, y - cy) - P * 0.38); if (d < best) best = d; }
        }
        void off;
        const ring = Math.max(0, 1 - best / 1.6);
        o[0] = ring; const a = 0.22 + ring * 0.78 * (0.85 + n16[i] * 0.3); o[1] = o[2] = o[3] = a; o[4] = 0.55 - ring * 0.2 + n32[i] * 0.1; o[5] = 0.35 + ring * 0.65;
      },
      plate(x, y, i, o) {
        const scr = Math.pow(1 - Math.min(1, (w5.f2[i] - w5.f1[i]) * 20), 3);
        o[0] = brushed[i] * 0.15 + n8[i] * 0.25 - scr * 0.25; const a = 0.84 + (n16[i] - 0.5) * 0.12 + scr * 0.1;
        o[1] = o[2] = o[3] = a; o[4] = 0.26 + n16[i] * 0.16 + brushed[i] * 0.08 + scr * 0.1; o[5] = 1;
      },
      bronze(x, y, i, o) {
        const p = sstep(0.55, 0.75, n16[i] * 0.6 + n32[i] * 0.4);
        o[0] = n8[i] * 0.3 + p * 0.25 + n64[i] * 0.05; const a = 0.95 - p * 0.15;
        o[1] = a * (1 - p * 0.45); o[2] = a * (1 - p * 0.1); o[3] = a * (1 - p * 0.25); o[4] = 0.32 + n32[i] * 0.12 + p * 0.45; o[5] = 1 - p * 0.75;
      },
      wood(x, y, i, o) {
        const g = Math.sin((x + n16[i] * 26 + n4[i] * 18) * TAU / 14), g2 = Math.pow(0.5 + 0.5 * g, 3);
        o[0] = g * 0.25 + n64[i] * 0.1 + strands[i] * 0.15; const a = 0.66 + 0.24 * (1 - g2) + (n8[i] - 0.5) * 0.12;
        o[1] = a; o[2] = a * 0.97; o[3] = a * 0.92; o[4] = 0.72 + n32[i] * 0.12; o[5] = 0;
      },
      hair(x, y, i, o) {
        const s = strands[i] * 0.7 + strands2[i] * 0.3;
        o[0] = s; const a = 0.62 + s * 0.42 + (n16[i] - 0.5) * 0.08; o[1] = o[2] = o[3] = a; o[4] = 0.42 + (1 - s) * 0.25; o[5] = 0;
      },
      fur(x, y, i, o) {
        const clump = 1 - Math.min(1, w8.f1[i] * 1.2), s = strands[i] * 0.6 + strands2[i] * 0.4;
        o[0] = s * 0.6 + clump * 0.4; const a = 0.5 + o[0] * 0.5 + (n16[i] - 0.5) * 0.1; o[1] = o[2] = o[3] = a; o[4] = 0.88; o[5] = 0;
      },
      stone(x, y, i, o) {
        const crack = 1 - sstep(0, 0.07, w5.f2[i] - w5.f1[i]), cr2 = 1 - sstep(0, 0.05, w16.f2[i] - w16.f1[i]);
        o[0] = n8[i] * 0.4 + n32[i] * 0.3 + n64[i] * 0.1 - crack * 0.5 - cr2 * 0.12;
        const a = 0.68 + (n16[i] - 0.5) * 0.26 + (n64[i] - 0.5) * 0.08 - crack * 0.32 - cr2 * 0.08; o[1] = a; o[2] = a * 0.99; o[3] = a * 0.97; o[4] = 0.86 + n32[i] * 0.1; o[5] = 0;
      },
      scale(x, y, i, o) {
        const SW = 16, SH = 12, row = Math.floor(y / SH), ox = (row & 1) * SW * 0.5, cx = Math.floor((x - ox) / SW) * SW + SW * 0.5 + ox, cy = row * SH;
        let d = Math.hypot((x - cx) / (SW * 0.6), (y - cy) / (SH * 1.05));
        const cx2 = Math.floor((x - ox - SW * 0.5) / SW) * SW + SW + ox, cy2 = (row + 1) * SH - SH;
        void cx2; void cy2;
        d = Math.min(d, 1.2);
        const h = Math.max(0, 1 - d * d), rnd = (Math.sin(cx * 12.9898 + row * 78.233) * 43758.5453) % 1;
        o[0] = h; const a = 0.62 + h * 0.3 + Math.abs(rnd) * 0.12; o[1] = o[2] = o[3] = a; o[4] = 0.32 + (1 - h) * 0.32; o[5] = 0.05;
      },
      oilskin(x, y, i, o) {
        const c = Math.pow(ridge(n16[i]), 4) * 0.7 + Math.pow(ridge(n8b[i]), 6) * 0.5;
        o[0] = c * 0.5 + n64[i] * 0.04; const a = 0.84 + (n8[i] - 0.5) * 0.14 + c * 0.08; o[1] = o[2] = o[3] = a; o[4] = 0.3 + (1 - c) * 0.12 + n32[i] * 0.18; o[5] = 0;
      },
      bone(x, y, i, o) {
        const g = Math.sin(y / TS * TAU * 6 + n8[i] * 3);
        o[0] = n32[i] * 0.2 + g * 0.12; const a = 0.86 + g * 0.05 + (n16[i] - 0.5) * 0.1; o[1] = a; o[2] = a * 0.98; o[3] = a * 0.92; o[4] = 0.45 + n16[i] * 0.1; o[5] = 0;
      },
      flesh(x, y, i, o) {
        const vein = Math.pow(ridge(n8b[i]), 10), bl = n16b[i];
        o[0] = n32[i] * 0.3 + vein * 0.3 + w8.f1[i] * 0.1; const a = 0.72 + (bl - 0.5) * 0.3 - vein * 0.16;
        o[1] = a * (1 + vein * 0.1); o[2] = a; o[3] = a * (1 - vein * 0.05); o[4] = 0.22 + n32[i] * 0.25 + (1 - bl) * 0.1; o[5] = 0;
      },
      rope(x, y, i, o) {
        const wx = x % 12, wy = y % 12, cell = (Math.floor(x / 12) + Math.floor(y / 12)) & 1;
        const sa = Math.sin(PI * (wx + 0.5) / 12), sb = Math.sin(PI * (wy + 0.5) / 12);
        const h = cell ? sa * (0.5 + 0.5 * sb) : sb * (0.5 + 0.5 * sa);
        o[0] = h * 0.7 + n64[i] * 0.3; const a = 0.68 + h * 0.22 + (n16[i] - 0.5) * 0.12; o[1] = o[2] = o[3] = a; o[4] = 0.96; o[5] = 0;
      }
    };
    const STRENGTH = { skin: 0.6, cloth: 1.6, wool: 1.4, leather: 1.4, mail: 3.0, plate: 0.8, bronze: 1.0, wood: 1.4, hair: 2.0, fur: 2.0, stone: 2.4, scale: 2.6, oilskin: 1.4, bone: 0.8, flesh: 1.2, rope: 2.2 };
    for (const name in TILE) {
      const ti = TILE[name], ox = (ti % TPR) * TS, oy = Math.floor(ti / TPR) * TS, gen = gens[name];
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const i = y * TS + x;
        gen(x, y, i, tmp);
        H[i] = tmp[0];
        const p = ((oy + y) * AS + ox + x) * 4;
        ALB[p] = clamp(tmp[1], 0, 1) * 255; ALB[p + 1] = clamp(tmp[2], 0, 1) * 255; ALB[p + 2] = clamp(tmp[3], 0, 1) * 255; ALB[p + 3] = 255;
        ORM[p] = 255; ORM[p + 1] = clamp(tmp[4], 0.04, 1) * 255; ORM[p + 2] = clamp(tmp[5], 0, 1) * 255; ORM[p + 3] = 255;
      }
      const s = STRENGTH[name] || 1;
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const xl = (x + TS - 1) % TS, xr = (x + 1) % TS, yd = (y + TS - 1) % TS, yu = (y + 1) % TS;
        const dx = (H[y * TS + xl] - H[y * TS + xr]) * s, dy = (H[yd * TS + x] - H[yu * TS + x]) * s;
        const l = Math.sqrt(dx * dx + dy * dy + 1);
        const p = ((oy + y) * AS + ox + x) * 4;
        NRM[p] = (dx / l * 0.5 + 0.5) * 255; NRM[p + 1] = (dy / l * 0.5 + 0.5) * 255; NRM[p + 2] = (1 / l * 0.5 + 0.5) * 255; NRM[p + 3] = 255;
      }
    }
    const mk = (data, srgb) => {
      const t = new T.DataTexture(data, AS, AS, T.RGBAFormat);
      t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
      t.wrapS = t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 4;
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      t.needsUpdate = true; t.userData.shared = true;
      return t;
    };
    return { map: mk(ALB, true), normal: mk(NRM, false), orm: mk(ORM, false) };
  }

  // =====================================================================================================
  // 2. ACTOR MATERIAL: MeshStandardMaterial + atlas tiles (fract, textureGrad: no seams) + glow channels + rim
  // =====================================================================================================
  const ATL_IN = 2 / AS, ATL_SZ = 1 / TPR - 2 * ATL_IN;
  const FRAG_HEAD = '\nvarying vec2 vTileOff;\nvarying vec2 vGlowV;\nuniform vec3 uGlowColor;\nuniform float uGlow;\nuniform vec3 uGlow2Color;\nuniform float uGlow2;\nuniform vec3 uRimColor;\nuniform float uRimPow;\nuniform float uDither;\n' +
    'float abBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }\n' +
    'float abBayer4(vec2 a) { return abBayer2(0.5 * a) * 0.25 + abBayer2(a); }\n' +
    'vec4 atlasTex(sampler2D t, vec2 uv) { vec2 f = fract(uv); return textureGrad(t, vTileOff + ' + ATL_IN.toFixed(6) + ' + f * ' + ATL_SZ.toFixed(6) + ', dFdx(uv) * ' + ATL_SZ.toFixed(6) + ', dFdy(uv) * ' + ATL_SZ.toFixed(6) + '); }\n';
  function patchActorShader(sh) {
    const u = this.userData.u;
    for (const k in u) sh.uniforms[k] = u[k];
    const SC = T.ShaderChunk;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aTile;\nattribute vec2 aGlow;\nvarying vec2 vTileOff;\nvarying vec2 vGlowV;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTileOff = aTile; vGlowV = aGlow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_HEAD)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (uDither > 0.0 && abBayer4(gl_FragCoord.xy) < uDither) discard;')
      .replace('#include <map_fragment>', SC.map_fragment.replace('texture2D( map, vMapUv )', 'atlasTex( map, vMapUv )'))
      .replace('#include <roughnessmap_fragment>', SC.roughnessmap_fragment.replace('texture2D( roughnessMap, vRoughnessMapUv )', 'atlasTex( roughnessMap, vRoughnessMapUv )'))
      .replace('#include <metalnessmap_fragment>', SC.metalnessmap_fragment.replace('texture2D( metalnessMap, vMetalnessMapUv )', 'atlasTex( metalnessMap, vMetalnessMapUv )'))
      .replace('#include <normal_fragment_maps>', SC.normal_fragment_maps.replace('texture2D( normalMap, vNormalMapUv )', 'atlasTex( normalMap, vNormalMapUv )'))
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' +
        'float abLum = dot(sampledDiffuseColor.rgb, vec3(0.3333));\n' +
        'float abCrack = 0.035 + 0.965 * smoothstep(0.26, 0.04, abLum);\n' +
        'totalEmissiveRadiance += uGlowColor * (vGlowV.x * uGlow) + uGlow2Color * (vGlowV.y * uGlow2 * abCrack);\n' +
        'float abRim = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);\n' +
        'totalEmissiveRadiance += uRimColor * pow(abRim, uRimPow);\n');
  }
  let envTex = null, pmrem = null;
  const mats = new Set();
  function makeMat(o = {}) {
    const m = new T.MeshStandardMaterial({ vertexColors: true, map: atlas.map, normalMap: atlas.normal, roughnessMap: atlas.orm, metalnessMap: atlas.orm, roughness: 1, metalness: 1 });
    m.normalScale.set(0.9, 0.9);
    m.envMap = envTex; m.envMapIntensity = o.env != null ? o.env : 0.55;
    m.userData.u = {
      uGlowColor: { value: col(o.glow != null ? o.glow : 0xff7b2e) }, uGlow: { value: o.glowI != null ? o.glowI : 0 },
      uGlow2Color: { value: col(o.glow2 != null ? o.glow2 : 0xff5a1a) }, uGlow2: { value: o.glow2I != null ? o.glow2I : 0 },
      uRimColor: { value: col(o.rim != null ? o.rim : 0x000000) }, uRimPow: { value: o.rimPow || 3 }, uDither: { value: 0 }
    };
    m.onBeforeCompile = patchActorShader;
    m.customProgramCacheKey = () => 'abActor2';
    mats.add(m);
    return m;
  }
  // a fallback environment (sky gradient) so metals read as metal; re-tinted per level from the fog colour
  function buildEnv() {
    if (!AB.renderer) return;
    try {
      if (!pmrem) pmrem = new T.PMREMGenerator(AB.renderer);
      const fog = AB.scene && AB.scene.fog ? AB.scene.fog.color : col(0x8a8f96);
      const act = AB.world && AB.world.level ? AB.world.level.act : 1;
      const sky = fog.clone().lerp(col(act === 3 ? 0xa04a30 : act === 2 ? 0x8aa0c0 : 0xd8c8a0), 0.45).multiplyScalar(1.15);
      const ground = fog.clone().multiplyScalar(0.25).lerp(col(0x2a2218), 0.5);
      const sc = new T.Scene();
      const g = new T.SphereGeometry(10, 24, 12);
      const m = new T.ShaderMaterial({ side: T.BackSide, depthWrite: false,
        uniforms: { top: { value: sky }, hor: { value: fog.clone().multiplyScalar(1.1) }, bot: { value: ground }, sun: { value: new V3(0.4, 0.5, 0.6).normalize() } },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 hor; uniform vec3 bot; uniform vec3 sun; varying vec3 vP; void main(){ float y = vP.y; vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.6)) : mix(hor, bot, pow(-y, 0.5)); c += vec3(1.0, 0.9, 0.75) * pow(max(dot(vP, sun), 0.0), 24.0) * 2.5; gl_FragColor = vec4(c, 1.0); }' });
      sc.add(new T.Mesh(g, m));
      const rt = pmrem.fromScene(sc, 0.03);
      g.dispose(); m.dispose();
      const old = envTex;
      envTex = rt.texture; envTex.userData.shared = true;
      for (const mm of mats) mm.envMap = envTex;
      if (old && old !== envTex) { const ort = old._abRT; if (ort) ort.dispose(); else old.dispose(); }
      envTex._abRT = rt;
    } catch (e) { console.warn('[actors] env map failed', e); }
  }

  // =====================================================================================================
  // 3. SKINNED GEOMETRY BUILDER
  //    B.bone(name, parent, x, y, z) defines the bind-pose skeleton (identity rotations; offsets in parent space).
  //    B.add(geometry, matrix, o) merges a three.js geometry: o = { c: colour|fn(p, n, out), tile, glow: [g1, g2] | fn,
  //    w: 'bone' | [[bone, w], ...] | fn(p) -> [[bone, w]...], uv: [su, sv] | 'auto', ao }.
  // =====================================================================================================
  class Builder {
    constructor() {
      this.pos = []; this.nor = []; this.uv = []; this.col = []; this.si = []; this.sw = []; this.til = []; this.glw = []; this.idx = [];
      this.n = 0; this.bones = []; this.bi = {}; this.wp = {}; this.sockets = {};
    }
    bone(name, parent, x, y, z) {
      const p = parent != null ? this.bi[parent] : -1;
      if (parent != null && p == null) throw new Error('builder: no parent bone ' + parent);
      this.bi[name] = this.bones.length;
      this.bones.push({ name, parent: p, p: [x, y, z] });
      const w = new V3(x, y, z); if (p >= 0) w.add(this.wp[parent]);
      this.wp[name] = w;
      return this.bi[name];
    }
    has(name) { return this.bi[name] != null; }
    W(name) { return this.wp[name]; }
    socket(name, bone, x, y, z) { this.sockets[name] = { bone, off: [x, y, z] }; }
    add(g, m, o) {
      const P = g.attributes.position, N = g.attributes.normal, UVa = g.attributes.uv;
      const nm = new T.Matrix3().getNormalMatrix(m);
      const base = this.n;
      let su = 1, sv = 1;
      if (o.uv && o.uv !== 'auto') { su = o.uv[0]; sv = o.uv[1]; }
      else {
        if (!g.boundingBox) g.computeBoundingBox();
        const s = g.boundingBox.getSize(_v4); const sc = _v3.setFromMatrixScale(m);
        su = Math.max(1, Math.round((s.x * sc.x + s.z * sc.z) * 0.5 * PI / TEXM)); sv = Math.max(0.25, s.y * sc.y / TEXM);
      }
      const t = tileOff(o.tile || 'cloth');
      const fixedC = typeof o.c === 'function' ? null : col(o.c != null ? o.c : 0x888888);
      const gfn = typeof o.glow === 'function' ? o.glow : null, gfix = gfn ? null : (o.glow || [0, 0]);
      const wfn = typeof o.w === 'function' ? o.w : null;
      const wfix = wfn ? null : (typeof o.w === 'string' ? [[o.w, 1]] : o.w || [['root', 1]]);
      const ao = o.ao != null ? o.ao : 0.22;
      const p = new V3(), n = new V3(), c = new T.Color();
      for (let i = 0; i < P.count; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(m);
        if (N) n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); else n.set(0, 1, 0);
        this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
        if (UVa) this.uv.push(UVa.getX(i) * su, UVa.getY(i) * sv); else this.uv.push(p.x / TEXM, p.y / TEXM);
        if (fixedC) c.copy(fixedC); else o.c(p, n, c);
        const k = 1 - ao * (0.5 - n.y * 0.5);
        this.col.push(c.r * k, c.g * k, c.b * k);
        this.til.push(t[0], t[1]);
        const gl = gfn ? gfn(p, n) : gfix; this.glw.push(gl[0] || 0, gl[1] || 0);
        const ws = wfn ? wfn(p) : wfix;
        this.pushW(ws);
      }
      if (g.index) { const I = g.index; for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i)); }
      else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
      this.n += P.count;
      if (o.dispose !== false) g.dispose();
    }
    pushW(ws) {
      const si = [0, 0, 0, 0], sw = [0, 0, 0, 0];
      let k = 0, tot = 0;
      for (const [b, w] of ws) {
        if (w <= 1e-4) continue;
        const bi = typeof b === 'number' ? b : this.bi[b];
        if (bi == null) throw new Error('builder: unknown bone ' + b);
        let j = 0; for (; j < k; j++) if (si[j] === bi) { sw[j] += w; break; }
        if (j === k && k < 4) { si[k] = bi; sw[k] = w; k++; }
        tot += w;
      }
      if (tot <= 0) { si[0] = 0; sw[0] = 1; tot = 1; }
      this.si.push(si[0], si[1], si[2], si[3]); this.sw.push(sw[0] / tot, sw[1] / tot, sw[2] / tot, sw[3] / tot);
    }
    build() {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(this.nor, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('color', new T.Float32BufferAttribute(this.col, 3));
      g.setAttribute('skinIndex', new T.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new T.Float32BufferAttribute(this.sw, 4));
      g.setAttribute('aTile', new T.Float32BufferAttribute(this.til, 2));
      g.setAttribute('aGlow', new T.Float32BufferAttribute(this.glw, 2));
      g.setIndex(this.n > 65535 ? new T.Uint32BufferAttribute(this.idx, 1) : new T.Uint16BufferAttribute(this.idx, 1));
      g.computeBoundingSphere();
      g.userData.shared = true;
      return g;
    }
  }

  // ------------------------------------------------------------------------------- geometry helpers
  const Y = new V3(0, 1, 0);
  function M(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    return new T.Matrix4().compose(new V3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new V3(sx, sy, sz));
  }
  function Mv(p, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) { return M(p.x, p.y, p.z, rx, ry, rz, sx, sy, sz); }
  // matrix that maps a +Y unit-length primitive (centred at origin, length 1) onto the segment a -> b
  function Mseg(a, b, sx = 1, sz = sx, twist = 0) {
    const d = _v1.subVectors(b, a); const len = d.length() || 1e-6;
    const q = new T.Quaternion().setFromUnitVectors(Y, d.clone().divideScalar(len));
    if (twist) q.multiply(new T.Quaternion().setFromAxisAngle(Y, twist));
    return new T.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new V3(sx, len, sz));
  }
  const vv = (x, y, z) => new V3(x, y, z);
  // weights along a chain of joints [{p: V3, bone}]: a point is projected on the polyline; near interior joints the two
  // adjacent bones blend over +-blend metres (smooth elbows/knees/spines).
  function chainW(chain, blend = 0.06) {
    const L = [0];
    for (let i = 1; i < chain.length; i++) L.push(L[i - 1] + chain[i].p.distanceTo(chain[i - 1].p));
    const total = L[L.length - 1];
    return (p) => {
      // nearest segment
      let best = 0, bd = 1e9, bs = 0;
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i].p, b = chain[i + 1].p;
        const ab = _v2.subVectors(b, a), l2 = ab.lengthSq() || 1e-9;
        const t = clamp(_v3.subVectors(p, a).dot(ab) / l2, 0, 1);
        const q = _v4.copy(a).addScaledVector(ab, t);
        const d = q.distanceToSquared(p);
        if (d < bd - 1e-9) { bd = d; best = i; bs = L[i] + t * (L[i + 1] - L[i]); }
      }
      void best; void total;
      // find interior joint nearest to s
      for (let j = 1; j < chain.length - 1; j++) {
        const dj = bs - L[j];
        if (Math.abs(dj) < blend) { const k = sstep(-blend, blend, dj); return [[chain[j - 1].bone, 1 - k], [chain[j].bone, k]]; }
      }
      let seg = 0; for (let j = 1; j < chain.length - 1; j++) if (bs >= L[j]) seg = j;
      return [[chain[seg].bone, 1]];
    };
  }
  // smooth tube along points with per-point elliptical radii. pts: [{p, rw (sideways), rf (front), rb (back)?}]
  // fwd = the "front" direction used to orient cross sections; caps: 0 none, 1 = round
  function tube(B, pts, o) {
    const seg = o.seg || 10, n = pts.length;
    const pos = [], nor = [], uv = [], idx = [];
    const fwd0 = o.fwd || vv(0, 0, 1);
    const frames = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(n - 1, i + 1)].p;
      const t = b.clone().sub(a).normalize();
      const nn = fwd0.clone().addScaledVector(t, -fwd0.dot(t));
      if (nn.lengthSq() < 1e-6) nn.set(1, 0, 0).addScaledVector(t, -t.x);
      nn.normalize();
      const bb = new V3().crossVectors(t, nn).normalize();
      if (i > 0) acc += pts[i].p.distanceTo(pts[i - 1].p);
      frames.push({ t, n: nn, b: bb, s: acc });
    }
    const circ = (pts.reduce((s, q) => s + (q.rw + (q.rf || q.rw)) * 0.5, 0) / n) * TAU;
    const su = Math.max(1, Math.round(circ / TEXM)) * (o.uScale || 1);
    const rings = [];
    const pushRing = (c, f, rw, rf, rb, vS, shrink) => {
      const start = pos.length / 3;
      for (let k = 0; k <= seg; k++) {
        const th = k / seg * TAU, ct = Math.cos(th), st = Math.sin(th);
        const rr = ct >= 0 ? rf : rb;
        const px = c.x + f.n.x * ct * rr + f.b.x * st * rw, py = c.y + f.n.y * ct * rr + f.b.y * st * rw, pz = c.z + f.n.z * ct * rr + f.b.z * st * rw;
        pos.push(px, py, pz);
        // normal of an ellipse: (ct / rr, st / rw) in the (n, b) plane, blended toward the tangent on caps
        let nx = f.n.x * ct / Math.max(rr, 1e-4) + f.b.x * st / Math.max(rw, 1e-4), ny = f.n.y * ct / Math.max(rr, 1e-4) + f.b.y * st / Math.max(rw, 1e-4), nz = f.n.z * ct / Math.max(rr, 1e-4) + f.b.z * st / Math.max(rw, 1e-4);
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        if (shrink) { nx = nx * shrink[0] + f.t.x * shrink[1]; ny = ny * shrink[0] + f.t.y * shrink[1]; nz = nz * shrink[0] + f.t.z * shrink[1]; }
        nor.push(nx, ny, nz);
        uv.push(k / seg * su, vS / TEXM);
      }
      rings.push(start);
    };
    const cap = (i, dir) => {
      const q = pts[i], f = frames[i], steps = 3;
      const ring = [];
      for (let s = steps; s >= 1; s--) {
        const a = s / (steps + 1) * PI * 0.5;
        const k = Math.cos(a), h = Math.sin(a) * Math.min(q.rw, q.rf || q.rw) * (o.capLen || 1);
        const c = q.p.clone().addScaledVector(f.t, h * dir);
        ring.push([c, k, h]);
      }
      return ring;
    };
    if (o.cap0) { const r = cap(0, -1); for (const [c, k, h] of r) pushRing(c, frames[0], pts[0].rw * k, (pts[0].rf || pts[0].rw) * k, (pts[0].rb || pts[0].rf || pts[0].rw) * k, frames[0].s - h, [k, -Math.sqrt(1 - k * k)]); }
    for (let i = 0; i < n; i++) { const q = pts[i]; pushRing(q.p, frames[i], q.rw, q.rf || q.rw, q.rb || q.rf || q.rw, frames[i].s); }
    if (o.cap1) { const r = cap(n - 1, 1).reverse(); for (const [c, k, h] of r) pushRing(c, frames[n - 1], pts[n - 1].rw * k, (pts[n - 1].rf || pts[n - 1].rw) * k, (pts[n - 1].rb || pts[n - 1].rf || pts[n - 1].rw) * k, frames[n - 1].s + h, [k, Math.sqrt(1 - k * k)]); }
    // tips
    const tip = (i, dir) => { const q = pts[i], f = frames[i]; const c = q.p.clone().addScaledVector(f.t, dir * Math.min(q.rw, q.rf || q.rw) * (o.capLen || 1)); const s0 = pos.length / 3; for (let k = 0; k <= seg; k++) { pos.push(c.x, c.y, c.z); nor.push(f.t.x * dir, f.t.y * dir, f.t.z * dir); uv.push(k / seg * su, (frames[i].s + dir * 0.01) / TEXM); } return s0; };
    let t0 = -1, t1 = -1;
    if (o.cap0) t0 = tip(0, -1);
    if (o.cap1) t1 = tip(n - 1, 1);
    const R = seg + 1;
    const flip = !!o.flip;
    const quad = (a, b) => { for (let k = 0; k < seg; k++) { const i0 = a + k, i1 = a + k + 1, j0 = b + k, j1 = b + k + 1; if (flip) idx.push(i0, j0, i1, i1, j0, j1); else idx.push(i0, i1, j0, i1, j1, j0); } };
    for (let r = 0; r < rings.length - 1; r++) quad(rings[r], rings[r + 1]);
    if (t0 >= 0) quad(t0, rings[0]);
    if (t1 >= 0) quad(rings[rings.length - 1], t1);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    B.add(g, new T.Matrix4(), Object.assign({ uv: [1, 1] }, o));
  }
  // lathe around the Y axis (profile [[r, y]...]) placed by matrix m; sx/sz scale the cross section
  function lathe(B, prof, m, o) {
    const pts = prof.map(([r, y]) => new T.Vector2(Math.max(0.0005, r), y));
    const g = new T.LatheGeometry(pts, o.seg || 14, o.phi0 || 0, o.phiLen || TAU);
    B.add(g, m, o);
  }
  function sphere(B, c, rx, ry, rz, o, rot) {
    const g = new T.SphereGeometry(1, o.ws || 12, o.hs || 9);
    B.add(g, M(c.x, c.y, c.z, rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0, rx, ry, rz), o);
  }
  function rbox(B, c, sx, sy, sz, o, rot, rad) {
    const g = new AB.addons.RoundedBoxGeometry(1, 1, 1, 1, rad != null ? rad : 0.18);
    B.add(g, M(c.x, c.y, c.z, rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0, sx, sy, sz), o);
  }
  function cyl(B, a, b, r0, r1, o, seg) {
    const g = new T.CylinderGeometry(r1, r0, 1, seg || 8, 1, !!o.open);
    B.add(g, Mseg(a, b, 1, 1), o);
  }
  function cone(B, a, b, r, o, seg) { cyl(B, a, b, r, 0.0005, o, seg); }
  function torus(B, c, R, r, m, o, arc) {
    const g = new T.TorusGeometry(R, r, o.rs || 6, o.ts || 16, arc || TAU);
    B.add(g, m || M(c.x, c.y, c.z), o);
  }
  // a flat blade from a 2D outline [[x, y]...] (y along the blade), thickness th, bevelled edge
  function blade(B, outline, th, m, o) {
    const s = new T.Shape(); outline.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    const g = new T.ExtrudeGeometry(s, { depth: th, bevelEnabled: true, bevelThickness: th * 0.45, bevelSize: th * 0.9, bevelSegments: 1, curveSegments: 4 });
    g.translate(0, 0, -th / 2);
    B.add(g, m, Object.assign({ uv: [1 / TEXM, 1 / TEXM] }, o));
  }

  // =====================================================================================================
  // 4. HUMAN RIG (heroes + humanoid foes). Bind pose: standing, arms hanging, facing +Z, LEFT side = +X.
  //    Rotation conventions used by every clip: spine/neck/head X+ = bend forward, Y+ = turn left, Z+ = lean right;
  //    limbs (hanging down): X- = swing forward/raise, X+ = back; left arm Z+ / right arm Z- = abduct outward;
  //    forearm X- = elbow flex; shin X+ = knee flex; foot X+ = toes down. Props held in a fist lie along hand +Z.
  // =====================================================================================================
  function humanProps(h, b) {
    const k = h / 1.75;
    const P = { h, k, head: b.head || 1, sh: b.sh || 1, hip: b.hip || 1, mass: b.mass || 1, legs: b.legs || 1, arms: b.arms || 1,
      fem: !!b.fem, bust: b.bust || 0, belly: b.belly || 1, neckL: b.neck || 1, block: !!b.block, limb: b.limb || 1 };
    P.headH = 0.13 * h * P.head;
    P.top = h;
    P.headC = h - P.headH * 0.5;
    P.headPivot = h - P.headH * 0.8;
    P.neckBase = h - P.headH - 0.05 * k * P.neckL;
    P.shY = P.neckBase - 0.05 * k;
    const r = P.neckBase / 1.48;
    P.hipJ = 0.905 * r * P.legs;
    P.spineY = P.hipJ + (P.shY - P.hipJ) * 0.32;
    P.chestY = P.hipJ + (P.shY - P.hipJ) * 0.72;
    P.ankle = 0.075 * k;
    P.knee = P.ankle + (P.hipJ - P.ankle) * 0.49;
    P.shX = 0.182 * k * P.sh;
    P.hipX = 0.088 * k * P.hip;
    P.upperArm = 0.29 * k * P.arms; P.foreArm = 0.255 * k * P.arms; P.handL = 0.16 * k * P.arms;
    P.fist = 0.065 * k * P.arms;
    return P;
  }
  function humanSkeleton(B, P) {
    const k = P.k;
    B.bone('root', null, 0, 0, 0);
    B.bone('hips', 'root', 0, P.hipJ + 0.03 * k, 0);
    B.bone('spine', 'hips', 0, P.spineY - P.hipJ - 0.03 * k, 0);
    B.bone('chest', 'spine', 0, P.chestY - P.spineY, 0);
    B.bone('neck', 'chest', 0, P.neckBase - P.chestY, -0.005 * k);
    B.bone('head', 'neck', 0, P.headPivot - P.neckBase, 0.012 * k);
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) {
      B.bone('upperarm_' + sd, 'chest', s * P.shX, P.shY - P.chestY, -0.01 * k);
      B.bone('forearm_' + sd, 'upperarm_' + sd, 0, -P.upperArm, 0);
      B.bone('hand_' + sd, 'forearm_' + sd, 0, -P.foreArm, 0);
      B.bone('thigh_' + sd, 'hips', s * P.hipX, -0.03 * k, 0);
      B.bone('shin_' + sd, 'thigh_' + sd, 0, P.knee - P.hipJ, 0);
      B.bone('foot_' + sd, 'shin_' + sd, 0, P.ankle - P.knee, 0);
    }
  }
  const boneW = (B, name, parent, w) => { const pw = B.W(parent); return B.bone(name, parent, w.x - pw.x, w.y - pw.y, w.z - pw.z); };
  // torso cross-section at height y: [W, F, Bk] (half widths), from the ring table of the body
  function torsoRings(P, L) {
    const k = P.k * P.mass, sh = P.sh, hip = P.hip * (P.fem ? 1.08 : 1), bel = P.belly;
    return [
      { y: P.hipJ - 0.07 * P.k, w: 0.1 * hip * k, f: 0.07 * k, b: 0.08 * k },
      { y: P.hipJ + 0.0 * P.k, w: 0.152 * hip * k, f: 0.095 * k, b: 0.11 * k * (P.fem ? 1.06 : 1) },
      { y: P.spineY, w: 0.132 * k * (P.fem ? 0.9 : 1) * Math.max(1, bel * 0.95), f: 0.09 * k * bel, b: 0.083 * k },
      { y: (P.spineY + P.chestY) * 0.5, w: 0.142 * sh * k, f: 0.098 * k * Math.max(1, bel * 0.9), b: 0.09 * k },
      { y: P.chestY, w: 0.152 * sh * k, f: (0.104 + P.bust * 0.018) * k, b: 0.097 * k },
      { y: P.shY - 0.03 * P.k, w: 0.154 * sh * k, f: 0.085 * k, b: 0.09 * k },
      { y: P.shY + 0.022 * P.k, w: 0.118 * sh * k, f: 0.068 * k, b: 0.078 * k },
      { y: P.neckBase + 0.004 * P.k, w: 0.06 * k * (L && L.neckW || 1), f: 0.05 * k, b: 0.055 * k }
    ];
  }
  function ringAt(R, y) {
    if (y <= R[0].y) return R[0];
    for (let i = 0; i < R.length - 1; i++) if (y <= R[i + 1].y) { const t = (y - R[i].y) / (R[i + 1].y - R[i].y); return { y, w: lerp(R[i].w, R[i + 1].w, t), f: lerp(R[i].f, R[i + 1].f, t), b: lerp(R[i].b, R[i + 1].b, t) }; }
    return R[R.length - 1];
  }
  // a point on the torso surface at height y and angle a (0 = front, +PI/2 = left (+X)), pushed out by d
  function torsoPt(R, y, a, d, out) {
    const r = ringAt(R, y), ca = Math.cos(a), sa = Math.sin(a);
    const rr = ca >= 0 ? r.f : r.b;
    return (out || new V3()).set(sa * (r.w + d), y, ca * (rr + d));
  }
  function torsoW(P) {
    const k = P.k;
    return chainW([{ p: vv(0, P.hipJ - 0.1 * k, 0), bone: 'hips' }, { p: vv(0, P.spineY, 0), bone: 'spine' }, { p: vv(0, P.chestY, 0), bone: 'chest' }, { p: vv(0, P.neckBase + 0.01 * k, 0), bone: 'neck' }, { p: vv(0, P.top, 0), bone: 'neck' }], 0.07 * k);
  }
  function headDeform(x, y, z) {   // unit-sphere coords -> skull shape (jaw taper, flat face, fuller back)
    if (y < 0) { const t = -y; x *= 1 - 0.3 * Math.pow(t, 1.4); z *= 1 - 0.08 * t; if (z > 0) z += 0.05 * t * t; }
    if (z > 0.55) z = 0.55 + (z - 0.55) * 0.55;
    if (z < 0 && y > -0.3) z *= 1.07;
    if (y > 0.25) x *= 0.97;
    return [x, y, z];
  }
  // parametric shell around the head: lon in [lon0, lon1] (0 = front), lat from latTop(lon) to latBot(lon) (0 = crown)
  function headShell(B, P, L, o) {
    const k = P.k * P.head;
    const RX = 0.079 * k, RY = 0.108 * k, RZ = 0.093 * k, C = vv(0, P.headC, 0.012 * P.k);
    const NU = o.nu || 20, NV = o.nv || 9;
    const pos = [], uv = [], idx = [];
    const lon0 = o.lon0 != null ? o.lon0 : -PI, lon1 = o.lon1 != null ? o.lon1 : PI;
    for (let i = 0; i <= NU; i++) {
      const u = lon0 + (lon1 - lon0) * i / NU;
      const fb = (Math.cos(u) + 1) * 0.5;      // 1 front, 0 back
      const vt = o.latTop ? o.latTop(u, fb) : 0, vb = o.latBot(u, fb);
      for (let j = 0; j <= NV; j++) {
        const v = vt + (vb - vt) * j / NV;
        let x = Math.sin(v) * Math.sin(u), y = Math.cos(v), z = Math.sin(v) * Math.cos(u);
        [x, y, z] = headDeform(x, y, z);
        let th = o.th(u, v, fb);
        const ext = o.drop ? o.drop(u, v, fb) : 0;
        let px = C.x + x * RX * (1 + th), py = C.y + y * RY * (1 + th) - ext, pz = C.z + z * RZ * (1 + th);
        if (o.flare && ext > 0) { const f = o.flare * ext; px += Math.sin(u) * f; pz += Math.cos(u) * f * 0.7; }
        if (o.warp) { const w = o.warp(u, v, fb, px, py, pz); px = w[0]; py = w[1]; pz = w[2]; }
        pos.push(px, py, pz);
        uv.push(i / NU * (o.su || 4), j / NV * (o.sv || 2));
      }
    }
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j, b = a + NV + 1;
      if (o.inner) idx.push(a, b, a + 1, b, b + 1, a + 1); else idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    B.add(g, new T.Matrix4(), Object.assign({ uv: [1, 1] }, o.opt));
  }
  function noise3(x, y, z) { return Math.sin(x * 12.9 + y * 4.1) * 0.5 + Math.sin(y * 9.7 + z * 7.3) * 0.3 + Math.sin(z * 11.3 + x * 5.9) * 0.2; }

  function buildHead(B, P, L) {
    const k = P.k * P.head, kk = P.k;
    const RX = 0.079 * k, RY = 0.108 * k, RZ = 0.093 * k, C = vv(0, P.headC, 0.012 * kk);
    const skin = col(L.skin || 0xc89a7c), hairC = col((L.hair && L.hair.c) || 0x3a2a1e);
    const eyeY = C.y + 0.012 * k, eyeX = 0.031 * k;
    const stub = L.beard && L.beard.style === 'stubble';
    const g = new T.SphereGeometry(1, 20, 14);
    const pa = g.attributes.position, na = g.attributes.normal;
    for (let i = 0; i < pa.count; i++) {
      const [x, y, z] = headDeform(pa.getX(i), pa.getY(i), pa.getZ(i));
      pa.setXYZ(i, C.x + x * RX, C.y + y * RY, C.z + z * RZ);
      void na;
    }
    g.computeVertexNormals();
    const paint = (p, n, out) => {
      out.copy(skin);
      const lx = (p.x - C.x) / RX, ly = (p.y - C.y) / RY, lz = (p.z - C.z) / RZ;
      const eyeD = Math.min(Math.hypot(lx - 0.39, ly - 0.11, (lz - 0.82) * 0.6), Math.hypot(lx + 0.39, ly - 0.11, (lz - 0.82) * 0.6));
      out.multiplyScalar(1 - 0.32 * (1 - sstep(0.05, 0.3, eyeD)));
      const ch = Math.min(Math.hypot(lx - 0.48, ly + 0.25, lz - 0.7), Math.hypot(lx + 0.48, ly + 0.25, lz - 0.7));
      out.lerp(_c1.setRGB(out.r * 1.12, out.g * 0.86, out.b * 0.84), (1 - sstep(0.1, 0.4, ch)) * 0.55);
      const lip = Math.hypot(lx * 1.6, (ly + 0.5) * 3.2, (lz - 0.86) * 1.5);
      out.lerp(_c1.setRGB(skin.r * 0.78, skin.g * 0.5, skin.b * 0.48), (1 - sstep(0.12, 0.42, lip)) * 0.75);
      if (stub && ly < -0.15 && lz > -0.3) out.lerp(hairC, 0.35 * sstep(-0.15, -0.45, ly));
      if (L.facePaint) L.facePaint(lx, ly, lz, out);
      return out;
    };
    B.add(g, new T.Matrix4(), { c: paint, tile: L.skinTile || 'skin', w: 'head', uv: [3, 3], ao: 0.15 });
    // eyes, brows, nose, ears, mouth
    const ez = C.z + RZ * 0.76;
    const eyeC = L.eyes != null ? L.eyes : 0x1e1612, eyeGlow = L.eyeGlow ? [1, 0] : [0, 0];
    boneW(B, 'eyes', 'head', vv(0, eyeY, ez));
    for (const s of [1, -1]) {
      sphere(B, vv(s * eyeX, eyeY, ez), 0.0115 * k, 0.0085 * k, 0.006 * k, { c: eyeC, tile: 'bone', w: 'eyes', glow: eyeGlow, ws: 8, hs: 6, ao: 0 });
      if (!L.noBrows) rbox(B, vv(s * (eyeX + 0.002 * k), eyeY + 0.021 * k, ez + 0.002 * k), 0.034 * k, 0.0075 * k, 0.012 * k, { c: L.brows != null ? L.brows : hairC.clone().multiplyScalar(0.7), tile: 'hair', w: 'head', ao: 0 }, [0, 0, s * -0.14], 0.4);
      if (!L.noEars) sphere(B, vv(s * RX * 0.93, eyeY - 0.012 * k, C.z - 0.008 * k), 0.012 * k, 0.026 * k, 0.018 * k, { c: skin.clone().multiplyScalar(0.92), tile: 'skin', w: 'head', ws: 8, hs: 6 });
    }
    if (!L.noNose) rbox(B, vv(0, eyeY - 0.03 * k, ez + 0.012 * k), 0.017 * k, 0.04 * k, 0.022 * k, { c: skin.clone().multiplyScalar(0.97), tile: 'skin', w: 'head', ao: 0.05 }, [-0.32, 0, 0], 0.45);
    rbox(B, vv(0, eyeY - 0.064 * k, ez - 0.006 * k), 0.026 * k, 0.005 * k, 0.008 * k, { c: skin.clone().multiplyScalar(0.45).lerp(col(0x5a2a22), 0.4), tile: 'skin', w: 'head', ao: 0 }, null, 0.4);
    // neck
    const nk = 0.052 * P.k * P.mass * (L.neckW || 1);
    tube(B, [{ p: vv(0, P.neckBase - 0.03 * P.k, -0.005 * P.k), rw: nk * 1.1, rf: nk, rb: nk * 1.05 }, { p: vv(0, P.headPivot, 0.006 * P.k), rw: nk * 0.92, rf: nk * 0.9 }, { p: vv(0, P.headPivot + 0.04 * P.k, 0.012 * P.k), rw: nk * 0.85, rf: nk * 0.85 }],
      { seg: 10, c: L.neckC != null ? L.neckC : skin, tile: L.neckTile || L.skinTile || 'skin', w: (p) => (p.y > P.headPivot - 0.005 * P.k ? [['head', 1]] : [['neck', 1]]) });
    return { C, RX, RY, RZ, eyeY, ez };
  }
  function buildHair(B, P, L) {
    const H = L.hair; if (!H || H.style === 'none' || H.style === 'bald') return;
    const c = col(H.c || 0x3a2a1e);
    const st = H.style;
    const messy = st === 'messy' ? 0.28 : st === 'curly' ? 0.34 : 0.05;
    const front = st === 'messy' ? 0.42 : st === 'curly' ? 0.36 : st === 'fringe' ? 0.4 : 0.3;
    const back = st === 'long' ? 0.98 : st === 'braid' || st === 'tied' || st === 'bun' ? 0.7 : 0.66;
    const side = st === 'long' ? 0.72 : 0.5;
    headShell(B, P, L, {
      nu: 22, nv: 8, su: 6, sv: 2,
      latBot: (u, fb) => PI * ((fb > 0.5 ? lerp(side, front, (fb - 0.5) * 2) : lerp(back, side, fb * 2)) + (fb > 0.75 ? 0.03 * Math.cos(u * 9) : 0.02 * Math.sin(u * 7))),
      th: (u, v) => 0.05 + 0.07 * Math.cos(v * 0.9) + (st === 'long' ? 0.03 : 0) + (messy + 0.06) * Math.max(-0.2, noise3(Math.sin(u) * 2.2, v * 1.6, Math.cos(u) * 2.2)) * 0.7,
      drop: st === 'long' ? (u, v, fb) => (v > PI * 0.62 && fb < 0.65 ? (v - PI * 0.62) * 0.55 * P.k * (1 - fb) : 0) : null,
      flare: st === 'long' ? 0.25 : 0,
      opt: { c: (p, n, out) => out.copy(c).multiplyScalar(0.85 + 0.15 * n.y), tile: 'hair', w: (p) => (st === 'long' && p.y < P.headPivot - 0.02 * P.k ? [['head', 0.6], ['neck', 0.4]] : [['head', 1]]), ao: 0.1 }
    });
    const k = P.k * P.head;
    if (st === 'bun' || st === 'tied') sphere(B, vv(0, P.headC + 0.03 * k, -0.11 * k), 0.045 * k, 0.04 * k, 0.04 * k, { c, tile: 'hair', w: 'head' });
    if (st === 'braid') {
      // braid chain: 3 bones from the back of the head
      const b0 = vv(0, P.headC - 0.02 * k, -0.095 * k);
      boneW(B, 'braid0', 'head', b0);
      boneW(B, 'braid1', 'braid0', vv(0, b0.y - 0.13 * P.k, b0.z - 0.03 * P.k));
      boneW(B, 'braid2', 'braid1', vv(0, b0.y - 0.27 * P.k, b0.z - 0.035 * P.k));
      const pts = [];
      for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push({ p: vv(Math.sin(t * 30) * 0.004 * P.k, b0.y - t * 0.36 * P.k, b0.z - 0.03 * P.k * Math.sin(t * 2.4)), rw: (0.026 - t * 0.012) * P.k * (1 + 0.25 * Math.abs(Math.sin(t * 24))), rf: (0.022 - t * 0.01) * P.k }); }
      tube(B, pts, { seg: 6, c, tile: 'hair', cap1: true, uScale: 2, w: chainW([{ p: b0, bone: 'braid0' }, { p: B.W('braid1'), bone: 'braid1' }, { p: B.W('braid2'), bone: 'braid2' }, { p: vv(0, b0.y - 0.5 * P.k, b0.z), bone: 'braid2' }], 0.05 * P.k) });
      torus(B, null, 0.02 * P.k, 0.006 * P.k, M(0, b0.y - 0.33 * P.k, b0.z - 0.03 * P.k, PI / 2), { c: 0x6a3a22, tile: 'leather', w: 'braid2', rs: 4, ts: 8 });
    }
    if (st === 'messy' || st === 'curly') {
      // clumps of hair over the scalp give a broken, tousled silhouette; locks fall over the brow
      const rng = AB.rng('hair-' + (H.c || 0) + st);
      const RX = 0.079 * k, RY = 0.108 * k, RZ = 0.093 * k, C0 = vv(0, P.headC, 0.012 * P.k);
      const n = st === 'curly' ? 28 : 22;
      for (let i = 0; i < n; i++) {
        const u = rng.float(-PI, PI), fb = (Math.cos(u) + 1) * 0.5;
        const vmax = (fb > 0.5 ? lerp(side, front, (fb - 0.5) * 2) : lerp(back, side, fb * 2)) * PI;
        const v = rng.float(0.05, 0.92) * vmax;
        let [x, y, z] = headDeform(Math.sin(v) * Math.sin(u), Math.cos(v), Math.sin(v) * Math.cos(u));
        const th = 1.06 + rng.float(0, 0.08);
        const p0 = vv(C0.x + x * RX * th, C0.y + y * RY * th, C0.z + z * RZ * th);
        const r = (st === 'curly' ? rng.float(0.026, 0.036) : rng.float(0.022, 0.034)) * k;
        const cc = c.clone().multiplyScalar(rng.float(0.8, 1.15));
        sphere(B, p0, r * (st === 'curly' ? 1 : 1.3), r * (st === 'curly' ? 0.9 : 0.75), r, { c: cc, tile: 'hair', w: 'head', ws: 6, hs: 4, ao: 0.1 }, [rng.float(-0.5, 0.5), u, rng.float(-0.4, 0.4)]);
      }
      for (let i = 0; i < 9; i++) {
        const a = -1.2 + i * 0.3 + rng.float(-0.08, 0.08), y0 = P.headC + (0.055 + 0.02 * Math.cos(a * 2)) * k, len = rng.float(0.04, 0.075) * k;
        cone(B, vv(Math.sin(a) * 0.072 * k, y0, Math.cos(a) * 0.078 * k + 0.012 * k), vv(Math.sin(a) * 0.088 * k, y0 - len, Math.cos(a) * 0.09 * k + 0.02 * k), 0.017 * k, { c: c.clone().multiplyScalar(rng.float(0.85, 1.1)), tile: 'hair', w: 'head' }, 5);
      }
    }
  }
  function buildBeard(B, P, L) {
    const D = L.beard; if (!D || D.style === 'stubble' || D.style === 'none') return;
    const c = col(D.c || 0x8a8a84), long = D.style === 'long';
    headShell(B, P, L, { nu: 14, nv: 6, su: 4, sv: 2, lon0: -1.45, lon1: 1.45,
      latTop: (u, fb) => PI * lerp(0.6, 0.53, fb * fb),
      latBot: (u, fb) => PI * lerp(0.62, 0.97, fb),
      th: (u, v, fb) => 0.06 + fb * 0.12,
      drop: long ? (u, v, fb) => (v > PI * 0.8 ? (v - PI * 0.8) * 0.36 * P.k * fb : 0) : null,
      opt: { c: (p, n, out) => out.copy(c).multiplyScalar(0.85 + 0.15 * n.y), tile: 'hair', w: 'head', ao: 0.1 } });
    // moustache
    const k = P.k * P.head;
    for (const s of [1, -1]) cone(B, vv(s * 0.004 * k, P.headC - 0.04 * k, 0.1 * k), vv(s * 0.04 * k, P.headC - 0.06 * k, 0.088 * k), 0.012 * k, { c, tile: 'hair', w: 'head' }, 5);
  }

  function buildBody(B, P, L) {
    const k = P.k, mk = P.k * P.mass * P.limb;
    const R = torsoRings(P, L);
    const tw = torsoW(P);
    const T0 = L.torso || { c: 0x6a6050, tile: 'cloth' };
    // ---- torso (painted by the outermost garment; optional lower part (trousers) below the belt line)
    const pts = R.map((r) => ({ p: vv(0, r.y, 0), rw: r.w, rf: r.f, rb: r.b }));
    const beltY = P.spineY - 0.035 * k;
    if (P.block) {
      for (const [a, b, bone, w] of [[R[1].y - 0.05 * k, P.spineY + 0.02 * k, 'hips', 1], [P.spineY - 0.02 * k, P.shY + 0.02 * k, 'chest', 1.15]]) {
        rbox(B, vv(0, (a + b) / 2, 0), 0.31 * P.sh * k * P.mass * w, b - a, 0.22 * k * P.mass * w, { c: T0.c, tile: T0.tile, w: bone, glow: T0.glow || [0, 0] }, null, 0.12);
      }
    } else {
      tube(B, pts, { seg: 16, c: T0.c, tile: T0.tile, w: tw, cap0: true, glow: T0.glow, capLen: 0.6 });
    }
    // ---- arms
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) {
      const sh = vv(s * P.shX, P.shY, -0.01 * k), el = vv(s * P.shX, P.shY - P.upperArm, -0.01 * k), wr = vv(s * P.shX, el.y - P.foreArm, -0.01 * k), tip = vv(s * P.shX, wr.y - P.handL, -0.01 * k);
      const aw = chainW([{ p: sh, bone: 'upperarm_' + sd }, { p: el, bone: 'forearm_' + sd }, { p: wr, bone: 'hand_' + sd }, { p: tip, bone: 'hand_' + sd }], 0.055 * k);
      const armW = (p) => { const w = aw(p); if (p.y > sh.y - 0.06 * k) { const t = 1 - sstep(sh.y - 0.06 * k, sh.y + 0.04 * k, p.y); return w.map(([b, x]) => [b, x * t]).concat([['chest', 1 - t]]); } return w; };
      const SL = L.sleeve || T0, slen = SL.len != null ? SL.len : 1;
      const prof = [[0, 0.05], [0.18, 0.049], [0.42, 0.043], [0.52, 0.039], [0.6, 0.045], [0.78, 0.039], [0.98, 0.03]];
      const at = (t) => { const ue = P.upperArm / (P.upperArm + P.foreArm); const yy = t < ue ? sh.y - t / ue * P.upperArm : el.y - (t - ue) / (1 - ue) * P.foreArm; return vv(s * P.shX, yy, -0.01 * k); };
      const rad = (t) => { for (let i = 0; i < prof.length - 1; i++) if (t <= prof[i + 1][0]) return lerp(prof[i][1], prof[i + 1][1], (t - prof[i][0]) / (prof[i + 1][0] - prof[i][0])); return 0.03; };
      const mkSeg = (t0, t1, n, grow, c, tile, glow, cap0) => {
        const ps = []; for (let i = 0; i <= n; i++) { const t = lerp(t0, t1, i / n); const r = rad(t) * mk * (1 + grow) * (L.armThick || 1); ps.push({ p: at(t), rw: r, rf: r * 1.05 }); }
        tube(B, ps, { seg: 10, c, tile, w: armW, cap0, glow, capLen: 0.55 });
      };
      const bodyArm = L.armSkin != null ? L.armSkin : L.skin;
      if (slen > 0.02) mkSeg(0, Math.min(1, slen), 7, (SL.puff || 0) + 0.02, SL.c, SL.tile, SL.glow, true);
      if (slen < 0.99) mkSeg(Math.max(0, slen - 0.04), 1, slen < 0.3 ? 7 : 3, 0, bodyArm, L.skinTile || 'skin', L.armGlow, slen <= 0.02);
      if (L.cuff) mkSeg(L.cuff.from || 0.66, L.cuff.to || 0.97, 3, 0.16, L.cuff.c, L.cuff.tile || 'leather', L.cuff.glow, false);
      // hand (fist)
      const hc = L.gloves ? L.gloves.c : L.handC != null ? L.handC : L.skin;
      const ht = L.gloves ? L.gloves.tile || 'leather' : L.skinTile || 'skin';
      const hk = k * P.arms * (L.handScale || 1);
      rbox(B, vv(s * P.shX, wr.y - 0.055 * hk, -0.01 * k + 0.004 * hk), 0.042 * hk, 0.085 * hk, 0.07 * hk, { c: hc, tile: ht, w: 'hand_' + sd, glow: L.handGlow }, null, 0.4);
      cyl(B, vv(s * (P.shX - 0.012 * hk), wr.y - 0.035 * hk, 0.03 * hk), vv(s * (P.shX - 0.016 * hk), wr.y - 0.07 * hk, 0.048 * hk), 0.012 * hk, 0.01 * hk, { c: hc, tile: ht, w: 'hand_' + sd }, 6);
      if (L.claws) for (let i = 0; i < 4; i++) cone(B, vv(s * P.shX + (i - 1.5) * 0.002 * hk, wr.y - 0.09 * hk, (i - 1.5) * 0.017 * hk), vv(s * P.shX, wr.y - 0.16 * hk, (i - 1.5) * 0.02 * hk + 0.03 * hk), 0.007 * hk, { c: L.claws, tile: 'bone', w: 'hand_' + sd }, 5);
    }
    // ---- legs
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) {
      if (L.noLegs) break;
      const hp = vv(s * P.hipX, P.hipJ, 0), kn = vv(s * P.hipX, P.knee, 0.01 * k), an = vv(s * P.hipX, P.ankle, 0);
      const lw0 = chainW([{ p: hp, bone: 'thigh_' + sd }, { p: kn, bone: 'shin_' + sd }, { p: an, bone: 'foot_' + sd }, { p: vv(an.x, -0.1, 0), bone: 'foot_' + sd }], 0.06 * k);
      const legW = (p) => { const w = lw0(p); if (p.y > hp.y - 0.12 * k) { const t = sstep(hp.y - 0.12 * k, hp.y + 0.05 * k, p.y) * 0.7; return w.map(([b, x]) => [b, x * (1 - t)]).concat([['hips', t]]); } return w; };
      const LG = L.legs || { c: 0x4a4038, tile: 'wool' };
      const BT = L.boots || { c: 0x3a2a1e, tile: 'leather', top: 0.45 };
      const prof = [[0, 0.088, 0.082], [0.25, 0.08, 0.077], [0.45, 0.06, 0.06], [0.5, 0.053, 0.056], [0.62, 0.058, 0.064], [0.85, 0.043, 0.045], [1, 0.037, 0.04]];
      const at = (t) => (t < 0.5 ? hp.clone().lerp(kn, t * 2) : kn.clone().lerp(an, (t - 0.5) * 2));
      const rad = (t, j) => { for (let i = 0; i < prof.length - 1; i++) if (t <= prof[i + 1][0]) return lerp(prof[i][j], prof[i + 1][j], (t - prof[i][0]) / (prof[i + 1][0] - prof[i][0])); return prof[prof.length - 1][j]; };
      const lk = mk * (L.legThick || 1);
      const seg = (t0, t1, n, grow, c, tile, top, glow) => { const ps = []; for (let i = 0; i <= n; i++) { const t = lerp(t0, t1, i / n); ps.push({ p: at(t).add(vv(0, i === 0 && top ? 0.06 * k : 0, 0)), rw: rad(t, 1) * lk * (1 + grow), rf: rad(t, 2) * lk * (1 + grow) }); } tube(B, ps, { seg: 10, c, tile, w: legW, glow }); };
      const bootTop = 1 - (BT.top != null ? BT.top : 0.45) * 0.5;
      seg(0, Math.min(1, bootTop + 0.03), 8, 0, LG.c, LG.tile, true, LG.glow);
      if (BT.top > 0) seg(bootTop, 1, 4, 0.1, BT.c, BT.tile || 'leather', false, BT.glow);
      if (BT.cuff !== false && BT.top > 0) seg(bootTop - 0.015, bootTop + 0.05, 1, 0.2, BT.c, BT.tile || 'leather', false);
      // foot
      const fk = k * (L.footScale || 1);
      if (L.paws) {
        rbox(B, vv(an.x, P.ankle - 0.045 * fk, 0.045 * fk), 0.09 * fk, 0.07 * fk, 0.2 * fk, { c: L.paws, tile: L.skinTile || 'skin', w: 'foot_' + sd }, null, 0.4);
        for (let i = 0; i < 3; i++) cone(B, vv(an.x + (i - 1) * 0.026 * fk, P.ankle - 0.06 * fk, 0.13 * fk), vv(an.x + (i - 1) * 0.03 * fk, P.ankle - 0.08 * fk, 0.19 * fk), 0.012 * fk, { c: 0x2a2620, tile: 'bone', w: 'foot_' + sd }, 5);
      } else {
        rbox(B, vv(an.x, P.ankle - 0.043 * fk, 0.05 * fk), 0.092 * fk * P.mass, 0.07 * fk, 0.25 * fk, { c: BT.c, tile: BT.tile || 'leather', w: 'foot_' + sd, glow: BT.glow }, [0.04, 0, 0], 0.45);
        rbox(B, vv(an.x, P.ankle - 0.068 * fk, 0.045 * fk), 0.094 * fk * P.mass, 0.022 * fk, 0.258 * fk, { c: 0x1e1814, tile: 'leather', w: 'foot_' + sd }, null, 0.3);
      }
    }
    return R;
  }

  // ---- garments over the body
  function buildSkirt(B, P, R, S) {
    // S: { c, tile, top (y), len (m), flare (m), open (gap angle at front), inner c, glow, jag }
    const k = P.k;
    const top = S.top != null ? S.top : P.spineY - 0.02 * k;
    const NA = 22, NS = 5, gap = S.open || 0;
    const a0 = gap / 2, a1 = TAU - gap / 2;
    const r0 = ringAt(R, top);
    const pos = [], uv = [], idx = [], ws = [];
    for (let i = 0; i <= NA; i++) {
      const a = a0 + (a1 - a0) * i / NA;
      for (let j = 0; j <= NS; j++) {
        const s = j / NS;
        const jag = S.jag ? (Math.sin(a * 7.3) * 0.5 + Math.sin(a * 13.1) * 0.5) * S.jag * s * s : 0;
        const y = top - S.len * s + jag;
        const rb = ringAt(R, Math.max(R[0].y, y));
        const sa = Math.sin(a), ca = Math.cos(a);
        const fl = (S.flare || 0.05) * s * (S.backFlare && ca < 0 ? S.backFlare : 1);
        const rw = Math.max(rb.w, r0.w * (s > 0.3 ? 0.98 : 1)) + 0.014 * k + fl, rr = (ca >= 0 ? Math.max(rb.f, r0.f * 0.9) : Math.max(rb.b, r0.b * 0.95)) + 0.014 * k + fl;
        pos.push(sa * rw, y, ca * rr);
        uv.push(i / NA * Math.round((rw + rr) * PI / TEXM), (S.len * s) / TEXM);
        const side = sstep(-0.5, 0.5, sa);                        // 1 = left
        const f = sstep(0.05, 1, s) * (S.stiff ? 0.45 : 0.8);
        ws.push([['hips', 1 - f], ['thigh_l', f * side], ['thigh_r', f * (1 - side)]]);
      }
    }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NS; j++) { const a = i * (NS + 1) + j, b = a + NS + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    const make = (inner) => {
      const g = new T.BufferGeometry();
      const pp = pos.slice();
      if (inner) for (let i = 0; i < pp.length; i += 3) { const l = Math.hypot(pp[i], pp[i + 2]) || 1; pp[i] -= pp[i] / l * 0.008 * k; pp[i + 2] -= pp[i + 2] / l * 0.008 * k; }
      g.setAttribute('position', new T.Float32BufferAttribute(pp, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      const ii = inner ? idx.map((v, n) => idx[n - (n % 3) + [0, 2, 1][n % 3]]) : idx;
      g.setIndex(ii); g.computeVertexNormals();
      let vi = 0;
      B.add(g, new T.Matrix4(), { c: inner ? (S.inner != null ? S.inner : col(S.c).multiplyScalar(0.55)) : S.c, tile: S.tile || 'cloth', uv: [1, 1], glow: S.glow, w: () => ws[vi++] });
    };
    make(false);
    if (S.inner !== false) make(true);
  }
  function buildCloak(B, P, R, C) {
    // C: { c, tile, len, width (angle half-extent), hood: 'up'|'down', inner, flare, collar }
    const k = P.k;
    const A = C.width || PI * 0.62, len = C.len || 0.9 * k, NA = 16, NS = 8;
    const topY = P.shY + 0.035 * k;
    const cols = [-A * 0.62, 0, A * 0.62], rows = [0, 0.38, 0.72];
    const ptAt = (a, s, out) => {
      const y = topY - len * s;
      const rt = ringAt(R, P.shY - 0.01 * k);
      const ry = ringAt(R, Math.max(R[0].y + 0.01, y));
      const w0 = rt.w + 0.06 * k * P.sh, b0 = rt.b + 0.03 * k;
      const fl = (C.flare != null ? C.flare : 0.14) * k * s;
      const w = Math.max(w0 * (1 - s * 0.15), ry.w + 0.04 * k) + fl, bk = Math.max(b0, ry.b + 0.035 * k) + fl * 0.8 + 0.03 * k * s;
      const sa = Math.sin(a), ca = Math.cos(a);
      // a = 0 at the back centre; |a| -> A wraps toward the front of the shoulders
      const front = Math.max(0, -ca);
      return out.set(sa * w, y + (s < 0.1 ? front * 0.02 * k : 0), -ca * bk + front * (ry.f * 0.25));
    };
    // bones: 3 columns x 3 rows
    for (let ci = 0; ci < 3; ci++) {
      let parent = 'chest';
      for (let ri = 0; ri < 3; ri++) {
        const w = ptAt(cols[ci], rows[ri], new V3());
        boneW(B, 'clk' + ci + ri, parent, w);
        parent = 'clk' + ci + ri;
      }
    }
    const wAt = (a, s) => {
      let c0 = 0, c1 = 1, tc = 0;
      if (a <= cols[0]) { c0 = c1 = 0; } else if (a >= cols[2]) { c0 = c1 = 2; } else if (a < 0) { c0 = 0; c1 = 1; tc = (a - cols[0]) / (0 - cols[0]); } else { c0 = 1; c1 = 2; tc = a / cols[2]; }
      let r0 = 0, r1 = 1, tr = 0;
      if (s >= rows[2]) { r0 = r1 = 2; } else if (s >= rows[1]) { r0 = 1; r1 = 2; tr = (s - rows[1]) / (rows[2] - rows[1]); } else { r0 = 0; r1 = 1; tr = s / rows[1]; }
      tc = sstep(0, 1, tc); tr = sstep(0, 1, tr);
      const out = [['clk' + c0 + r0, (1 - tc) * (1 - tr)], ['clk' + c1 + r0, tc * (1 - tr)], ['clk' + c0 + r1, (1 - tc) * tr], ['clk' + c1 + r1, tc * tr]];
      const chestW = 1 - sstep(0.0, 0.12, s);
      return out.map(([b, w]) => [b, w * (1 - chestW)]).concat([['chest', chestW]]);
    };
    const pos = [], uv = [], idx = [], ws = [];
    const p = new V3();
    for (let i = 0; i <= NA; i++) {
      const a = -A + 2 * A * i / NA;
      for (let j = 0; j <= NS; j++) {
        const s = j / NS;
        const jag = C.jag ? (Math.sin(a * 9.1) * 0.6 + Math.sin(a * 17.3) * 0.4) * C.jag * s * s : 0;
        ptAt(a, s + jag / len, p);
        pos.push(p.x, p.y, p.z); uv.push(i / NA * Math.round(A * 2 * 0.22 * k / TEXM * 1.2 + 1), s * len / TEXM);
        ws.push(wAt(a, s));
      }
    }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NS; j++) { const a = i * (NS + 1) + j, b = a + NS + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const make = (inner) => {
      const g = new T.BufferGeometry();
      const pp = pos.slice();
      if (inner) for (let i = 0; i < pp.length; i += 3) { const l = Math.hypot(pp[i], pp[i + 2]) || 1; pp[i] -= pp[i] / l * 0.01 * k; pp[i + 2] -= pp[i + 2] / l * 0.01 * k; }
      g.setAttribute('position', new T.Float32BufferAttribute(pp, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      g.setIndex(inner ? idx.map((v, n) => idx[n - (n % 3) + [0, 2, 1][n % 3]]) : idx); g.computeVertexNormals();
      let vi = 0;
      B.add(g, new T.Matrix4(), { c: inner ? (C.inner != null ? C.inner : col(C.c).multiplyScalar(0.5)) : C.c, tile: C.tile || 'wool', uv: [1, 1], w: () => ws[vi++], ao: 0.1 });
    };
    make(false); make(true);
    // collar roll / lowered hood
    const nb = ringAt(R, P.neckBase);
    if (C.hood === 'down') {
      const g = new T.TorusGeometry(1, 0.32, 8, 18, PI * 1.25);
      B.add(g, M(0, P.neckBase - 0.01 * k, -0.025 * k, PI / 2 + 0.25, 0, PI * 0.875, nb.w + 0.065 * k, nb.b + 0.075 * k, 0.07 * k), { c: C.c, tile: C.tile || 'wool', w: [['chest', 0.8], ['neck', 0.2]], uv: [3, 1] });
    } else if (C.collar !== false) {
      torus(B, null, 1, 0.22, M(0, P.neckBase - 0.012 * k, -0.01 * k, PI / 2, 0, 0, nb.w + 0.05 * k, nb.b + 0.055 * k, 0.05 * k), { c: C.c, tile: C.tile || 'wool', w: [['chest', 0.75], ['neck', 0.25]], rs: 5, ts: 16 });
    }
    // clasp
    sphere(B, vv(0.07 * k, P.neckBase - 0.03 * k, ringAt(R, P.neckBase - 0.03 * k).f + 0.03 * k), 0.016 * k, 0.016 * k, 0.008 * k, { c: C.clasp || 0xb08a4a, tile: 'bronze', w: 'chest', ws: 8, hs: 6 });
    if (C.hood === 'up') buildHood(B, P, C);
  }
  function buildHood(B, P, C) {
    const kk = P.k;
    headShell(B, P, {}, { nu: 22, nv: 9, su: 4, sv: 2,
      latBot: (u, fb) => PI * (fb > 0.7 ? lerp(0.62, 0.22, (fb - 0.7) / 0.3) : 0.97),
      th: (u, v, fb) => 0.2 + 0.05 * (1 - fb) + (v > PI * 0.7 ? (v - PI * 0.7) * 0.5 : 0),
      drop: (u, v, fb) => (v > PI * 0.72 ? (v - PI * 0.72) * 0.16 * kk : 0), flare: 0.9,
      warp: (u, v, fb, x, y, z) => { if (fb < 0.35 && v < PI * 0.45) { const t = (0.35 - fb) / 0.35 * (1 - v / (PI * 0.45)); return [x, y + t * 0.02 * kk, z - t * 0.07 * kk]; } return [x, y, z]; },
      opt: { c: C.hoodC != null ? C.hoodC : C.c, tile: C.tile || 'wool', w: (p) => (p.y > P.headPivot - 0.03 * kk ? [['head', 1]] : [['head', 0.45], ['neck', 0.3], ['chest', 0.25]]), ao: 0.2 } });
    headShell(B, P, {}, { nu: 22, nv: 9, su: 4, sv: 2, inner: true,
      latBot: (u, fb) => PI * (fb > 0.7 ? lerp(0.62, 0.22, (fb - 0.7) / 0.3) : 0.97),
      th: (u, v, fb) => 0.17 + 0.05 * (1 - fb) + (v > PI * 0.7 ? (v - PI * 0.7) * 0.5 : 0),
      drop: (u, v, fb) => (v > PI * 0.72 ? (v - PI * 0.72) * 0.16 * kk : 0), flare: 0.9,
      opt: { c: col(C.hoodC != null ? C.hoodC : C.c).multiplyScalar(0.35), tile: C.tile || 'wool', w: (p) => (p.y > P.headPivot - 0.03 * kk ? [['head', 1]] : [['head', 0.45], ['neck', 0.3], ['chest', 0.25]]), ao: 0 } });
  }
  function buildBelt(B, P, R, Bt) {
    const k = P.k, y = Bt.y != null ? Bt.y : P.spineY - 0.03 * k;
    const r = ringAt(R, y);
    const w = torsoW(P);
    const g = new T.TorusGeometry(1, 0.03, 4, 24);
    const sz = (Bt.h || 0.045) * k;
    B.add(g, M(0, y, (r.f - r.b) * 0.5 * 0, PI / 2, 0, 0, r.w + 0.012 * k, (r.f + r.b) * 0.5 + 0.012 * k, sz / 0.06), { c: Bt.c || 0x3a2618, tile: 'leather', w, uv: [6, 1] });
    if (Bt.buckle !== false) rbox(B, vv(0, y, r.f + 0.016 * k), 0.045 * k, sz * 1.2, 0.012 * k, { c: Bt.buckle || 0xa08850, tile: 'bronze', w }, null, 0.3);
  }
  function strap(B, P, R, list, o) {
    // list: [[y, angle]] points on the torso; tube 0.012 thick following the surface
    const k = P.k, w = torsoW(P);
    const pts = [];
    for (let i = 0; i < list.length - 1; i++) for (let j = 0; j < 4; j++) {
      const t = j / 4, y = lerp(list[i][0], list[i + 1][0], t), a = lerp(list[i][1], list[i + 1][1], t);
      pts.push({ p: torsoPt(R, y, a, 0.01 * k), rw: (o.w || 0.022) * k, rf: 0.006 * k });
    }
    const l = list[list.length - 1]; pts.push({ p: torsoPt(R, l[0], l[1], 0.01 * k), rw: (o.w || 0.022) * k, rf: 0.006 * k });
    tube(B, pts, { seg: 4, c: o.c || 0x3a2618, tile: o.tile || 'leather', w, fwd: vv(0, 0, 1) });
  }
  function pauldrons(B, P, R, S) {
    const k = P.k;
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) {
      const g = new T.SphereGeometry(1, 12, 6, 0, TAU, 0, PI * 0.5);
      B.add(g, M(s * (P.shX + 0.005 * k), P.shY + 0.012 * k, -0.005 * k, 0, 0, s * -0.35, 0.085 * k * (S.scale || 1), 0.07 * k * (S.scale || 1), 0.085 * k * (S.scale || 1)), { c: S.c, tile: S.tile || 'plate', w: [['upperarm_' + sd, 0.65], ['chest', 0.35]], glow: S.glow });
      if (S.rim) torus(B, null, 1, 0.08, M(s * (P.shX + 0.005 * k), P.shY + 0.012 * k, -0.005 * k, PI / 2, 0, s * -0.35, 0.085 * k * (S.scale || 1), 0.085 * k * (S.scale || 1), 0.07 * k), { c: S.rim, tile: 'bronze', w: [['upperarm_' + sd, 0.65], ['chest', 0.35]], rs: 4, ts: 12 });
    }
  }
  function mantle(B, P, R, S) {
    const k = P.k, nb = ringAt(R, P.neckBase - 0.02 * k);
    const g = new T.TorusGeometry(1, 0.45, 8, 20);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i); const n = 1 + 0.18 * noise3(x * 2, y * 2, z * 2); pa.setXYZ(i, x * n, y * n, z * n); }
    g.computeVertexNormals();
    const sc = S.scale || 1;
    B.add(g, M(0, P.neckBase - 0.04 * k, -0.025 * k, PI / 2 + 0.22, 0, 0, nb.w + 0.052 * k * sc, nb.b + 0.07 * k * sc, 0.19 * k * sc), { c: S.c, tile: S.tile || 'fur', w: [['chest', 0.85], ['neck', 0.15]], uv: [6, 2] });
  }
  function scarf(B, P, R, S) {
    const k = P.k, nb = ringAt(R, P.neckBase);
    torus(B, null, 1, 0.42, M(0, P.neckBase + 0.005 * k, 0.0, PI / 2 - 0.1, 0, 0, nb.w + 0.03 * k, nb.b + 0.035 * k, 0.065 * k), { c: S.c, tile: 'wool', w: [['neck', 0.6], ['chest', 0.4]], rs: 7, ts: 16, uv: [4, 1] });
    const s0 = vv(0.035 * k, P.neckBase - 0.03 * k, nb.f + 0.04 * k);
    boneW(B, 'scarf0', 'chest', s0);
    boneW(B, 'scarf1', 'scarf0', vv(s0.x + 0.02 * k, s0.y - 0.16 * k, s0.z + 0.015 * k));
    const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push({ p: vv(s0.x + 0.03 * k * t, s0.y - t * 0.32 * k, s0.z + 0.01 * k), rw: 0.034 * k, rf: 0.008 * k }); }
    tube(B, pts, { seg: 4, c: S.c, tile: 'wool', cap1: true, w: chainW([{ p: s0, bone: 'scarf0' }, { p: B.W('scarf1'), bone: 'scarf1' }, { p: vv(s0.x, s0.y - 0.5 * k, s0.z), bone: 'scarf1' }], 0.05 * k) });
  }

  // ---- helmets and head gear
  function buildHelm(B, P, L, H) {
    const k = P.k * P.head, kk = P.k, C = vv(0, P.headC, 0.012 * kk);
    const c = H.c || 0x6a6a6a, tile = H.tile || 'plate';
    const dome = (th, lat, o) => headShell(B, P, L, { nu: 20, nv: 6, su: 4, sv: 2, latBot: (u, fb) => PI * (fb > 0.6 ? lat[0] : lat[1]), th: () => th, opt: Object.assign({ c, tile, w: 'head' }, o || {}) });
    switch (H.style) {
      case 'horned':
        dome(0.14, [0.36, 0.55]);
        for (const s of [1, -1]) {
          const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push({ p: vv(s * (0.085 + t * 0.09) * k, C.y + (0.04 + t * 0.08 - t * t * 0.02) * k, (0.01 - t * 0.06 + t * t * 0.08) * k), rw: (0.022 - t * 0.019) * k, rf: (0.022 - t * 0.019) * k }); }
          tube(B, pts, { seg: 6, c: H.horn || 0xd8ccb0, tile: 'bone', w: 'head', cap1: true });
        }
        torus(B, null, 1, 0.06, M(C.x, C.y + 0.01 * k, C.z, PI / 2 + 0.12, 0, 0, 0.098 * k, 0.11 * k, 0.1 * k), { c: H.rim || 0x5a4a30, tile: 'bronze', w: 'head', rs: 4, ts: 18 });
        rbox(B, vv(0, C.y - 0.005 * k, 0.11 * k), 0.016 * k, 0.07 * k, 0.012 * k, { c, tile, w: 'head' }, null, 0.3);
        break;
      case 'crested':
        dome(0.14, [0.4, 0.62]);
        rbox(B, vv(0, C.y + 0.11 * k, -0.01 * k), 0.018 * k, 0.07 * k, 0.2 * k, { c: H.crest || 0x8a2a1e, tile: 'fur', w: 'head' }, [0.15, 0, 0], 0.4);
        for (const s of [1, -1]) rbox(B, vv(s * 0.075 * k, C.y - 0.04 * k, 0.04 * k), 0.012 * k, 0.07 * k, 0.06 * k, { c, tile, w: 'head' }, [0, s * 0.3, 0], 0.3);
        break;
      case 'full':
        dome(0.16, [0.98, 0.92], {});
        rbox(B, vv(0, C.y + 0.01 * k, 0.1 * k), 0.07 * k, 0.012 * k, 0.012 * k, { c: 0x111111, tile: 'plate', w: 'head', glow: H.slitGlow ? [1, 0] : [0, 0] }, null, 0.4);
        if (H.plume) cone(B, vv(0, C.y + 0.1 * k, -0.02 * k), vv(0, C.y + 0.26 * k, -0.12 * k), 0.035 * k, { c: H.plume, tile: 'fur', w: 'head' }, 6);
        break;
      case 'mitre':
        lathe(B, [[0.09, 0], [0.088, 0.02], [0.08, 0.12], [0.05, 0.24], [0.0005, 0.3]], M(C.x, C.y + 0.05 * k, C.z - 0.005 * k, -0.1, 0, 0, k, k, k * 0.62), { c, tile: H.tile || 'cloth', w: 'head', seg: 12, glow: H.glow });
        torus(B, null, 1, 0.08, M(C.x, C.y + 0.055 * k, C.z - 0.005 * k, PI / 2 - 0.1, 0, 0, 0.09 * k, 0.057 * k, 0.07 * k), { c: H.rim || 0xb08a4a, tile: 'bronze', w: 'head', rs: 4, ts: 16 });
        break;
      case 'crown': {
        torus(B, null, 1, 0.12, M(C.x, C.y + 0.07 * k, C.z, PI / 2, 0, 0, 0.088 * k, 0.098 * k, 0.07 * k), { c, tile: 'plate', w: 'head', rs: 5, ts: 18, glow: [0, 0.6] });
        for (let i = 0; i < 9; i++) { const a = i / 9 * TAU; const r0 = vv(Math.sin(a) * 0.088 * k, C.y + 0.075 * k, Math.cos(a) * 0.098 * k + C.z); cone(B, r0, r0.clone().add(vv(Math.sin(a) * 0.03 * k, (0.09 + (i % 2) * 0.05) * k, Math.cos(a) * 0.03 * k)), 0.014 * k, { c, tile: 'plate', w: 'head', glow: [0, 1] }, 5); }
        break;
      }
      case 'candle':
        dome(0.1, [0.42, 0.5], { tile: 'leather' });
        cyl(B, vv(0, C.y + 0.1 * k, 0.04 * k), vv(0, C.y + 0.17 * k, 0.05 * k), 0.016 * k, 0.014 * k, { c: 0xd8d0b0, tile: 'bone', w: 'head', glow: [0.25, 0] }, 6);
        break;
      case 'mask':   // cloth over the lower face (bandits)
        headShell(B, P, L, { nu: 14, nv: 5, lon0: -1.7, lon1: 1.7, su: 3, sv: 1, latTop: () => PI * 0.5, latBot: (u, fb) => PI * lerp(0.7, 0.98, fb), th: () => 0.12, drop: (u, v, fb) => (v > PI * 0.85 ? (v - PI * 0.85) * 0.4 * kk * fb : 0), opt: { c, tile: H.tile || 'cloth', w: 'head' } });
        break;
      case 'skullcap':
        dome(0.08, [0.3, 0.52], { tile: H.tile || 'leather' });
        break;
      case 'block': {   // sentinel head: a carved stone block with a bronze brow and a glowing slit
        rbox(B, vv(0, C.y, 0.0), 0.2 * k, 0.24 * k, 0.21 * k, { c, tile: 'stone', w: 'head' }, null, 0.15);
        rbox(B, vv(0, C.y + 0.035 * k, 0.1 * k), 0.21 * k, 0.04 * k, 0.03 * k, { c: H.rim || 0x8a6a3a, tile: 'bronze', w: 'head' }, null, 0.2);
        rbox(B, vv(0, C.y - 0.005 * k, 0.105 * k), 0.13 * k, 0.016 * k, 0.012 * k, { c: 0x101010, tile: 'stone', w: 'head', glow: [1, 0] }, null, 0.4);
        if (H.crown) for (let i = 0; i < 5; i++) cone(B, vv((i - 2) * 0.045 * k, C.y + 0.12 * k, 0), vv((i - 2) * 0.055 * k, C.y + (0.22 + (i === 2 ? 0.06 : 0)) * k, -0.01 * k), 0.022 * k, { c: H.rim || 0x8a6a3a, tile: 'bronze', w: 'head' }, 5);
        break;
      }
      default: break;
    }
  }

  // ---- props held in a fist lie along hand +Z (forward when the arm hangs; up when the forearm is flexed level)
  const Mperm = (x, y, z) => new T.Matrix4().set(0, 0, 1, x, 1, 0, 0, y, 0, 1, 0, z, 0, 0, 0, 1);   // outline (x width, y length, z thick) -> (Y, Z, X)
  function buildProp(B, P, R, S) {
    const k = P.k, sd = S.hand || 'r', s = sd === 'l' ? 1 : -1;
    const hw = B.has('hand_' + sd) ? B.W('hand_' + sd) : vv(0, 0, 0);
    const hb = 'hand_' + sd;
    const hs = (x, y, z) => vv(hw.x + x * s, hw.y - P.fist + y, hw.z + z);
    const sock = (name, bone, p) => { const bw = B.W(bone); B.socket(name, bone, p.x - bw.x, p.y - bw.y, p.z - bw.z); };
    const main = sd === 'r' ? 'weapon' : 'weapon2';
    const steel = S.c || 0xa8aaae, wood = S.wood || 0x5a3e26, lea = S.grip || 0x3a2418;
    const ks = S.scale || 1;
    switch (S.t) {
      case 'sword': case 'greatsword': case 'knife': case 'longknife': case 'dagger': case 'cleaver': {
        const big = S.t === 'greatsword';
        const len = (S.len || (big ? 1.25 : S.t === 'sword' ? 0.8 : S.t === 'longknife' ? 0.44 : S.t === 'cleaver' ? 0.48 : 0.3)) * ks;
        const w = (S.w || (big ? 0.062 : S.t === 'cleaver' ? 0.13 : S.t === 'sword' ? 0.046 : 0.036)) * ks;
        const g0 = 0.05 * ks;
        const out = S.t === 'cleaver' ? [[-w * 0.15, 0], [w * 0.15, 0], [w * 0.2, len * 0.15], [w * 0.95, len * 0.2], [w, len], [-w * 0.2, len * 0.98], [-w * 0.2, len * 0.15]]
          : S.t === 'longknife' ? [[-w / 2, 0], [w / 2, 0], [w * 0.55, len * 0.6], [w * 0.1, len], [-w * 0.45, len * 0.75]]
          : [[-w / 2, 0], [w / 2, 0], [w * 0.42, len * 0.82], [0, len], [-w * 0.42, len * 0.82]];
        const base = hs(0, 0, g0 + 0.012 * ks);
        blade(B, out, (S.t === 'cleaver' ? 0.008 : 0.007) * ks, Mperm(base.x, base.y, base.z), { c: steel, tile: 'plate', w: hb, glow: S.glow });
        // fuller line (darker groove) for swords
        if (S.t === 'sword' || big) rbox(B, hs(0, 0, g0 + len * 0.42), 0.0085 * ks, w * 0.18, len * 0.62, { c: col(steel).multiplyScalar(0.6), tile: 'plate', w: hb, glow: S.glow }, null, 0.3);
        // guard, grip, pommel
        if (S.t !== 'cleaver') rbox(B, hs(0, 0, g0), 0.024 * ks, (big ? 0.26 : S.t === 'sword' ? 0.17 : 0.07) * ks, 0.022 * ks, { c: S.guard || 0x6a5a40, tile: 'bronze', w: hb }, null, 0.3);
        const gl = (big ? 0.26 : S.t === 'sword' ? 0.13 : 0.1) * ks;
        cyl(B, hs(0, 0, g0 - gl), hs(0, 0, g0), 0.016 * ks, 0.018 * ks, { c: lea, tile: 'leather', w: hb }, 6);
        sphere(B, hs(0, 0, g0 - gl - 0.012 * ks), 0.024 * ks, 0.024 * ks, 0.024 * ks, { c: S.guard || 0x6a5a40, tile: 'bronze', w: hb, ws: 8, hs: 6 });
        sock(main + '_base', hb, hs(0, 0, g0 + 0.06 * ks)); sock(main + '_tip', hb, hs(0, 0, g0 + len));
        break;
      }
      case 'hammer': case 'warhammer': case 'maul': case 'club': case 'treeclub': case 'pick': case 'scourge': {
        const big = S.t === 'warhammer' || S.t === 'maul' || S.t === 'treeclub';
        const L1 = (S.len || (S.t === 'hammer' ? 0.62 : S.t === 'club' ? 1.25 : S.t === 'pick' ? 0.75 : S.t === 'scourge' ? 0.38 : S.t === 'treeclub' ? 1.5 : 1.25)) * ks;
        const back = (S.t === 'club' ? 0.35 : S.t === 'hammer' || S.t === 'pick' || S.t === 'scourge' ? 0.1 : 0.3) * ks;
        if (S.t === 'treeclub') {
          const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push({ p: hs(Math.sin(t * 5) * 0.03 * ks, Math.sin(t * 3) * 0.02 * ks, -back + t * (L1 + back)), rw: (0.045 + t * t * 0.1) * ks * (1 + 0.15 * Math.sin(t * 13)), rf: (0.045 + t * t * 0.09) * ks }); }
          tube(B, pts, { seg: 8, c: S.wood || 0x4a3a2a, tile: 'wood', w: hb, cap0: true, cap1: true, fwd: vv(0, 1, 0) });
          for (let i = 0; i < 5; i++) { const z = L1 * (0.55 + i * 0.09), a = i * 2.3; cone(B, hs(Math.cos(a) * 0.1 * ks, Math.sin(a) * 0.1 * ks, z), hs(Math.cos(a) * 0.2 * ks, Math.sin(a) * 0.2 * ks, z + 0.04 * ks), 0.025 * ks, { c: 0x6a6050, tile: 'bone', w: hb }, 5); }
        } else {
          cyl(B, hs(0, 0, -back), hs(0, 0, L1), (big ? 0.03 : 0.019) * ks, (big ? 0.034 : 0.02) * ks, { c: wood, tile: 'wood', w: hb }, 7);
          cyl(B, hs(0, 0, -0.02 * ks), hs(0, 0, 0.12 * ks), 0.023 * ks, 0.023 * ks, { c: lea, tile: 'leather', w: hb }, 7);
        }
        const top = hs(0, 0, L1);
        if (S.t === 'hammer' || S.t === 'warhammer') {
          const hk = S.t === 'warhammer' ? 2.1 : 1;
          rbox(B, hs(0, 0, L1 - 0.03 * ks * hk), 0.09 * ks * hk, 0.2 * ks * hk, 0.1 * ks * hk, { c: steel, tile: S.tile || 'plate', w: hb, glow: S.glow }, null, 0.2);
          rbox(B, hs(0, 0, L1 - 0.03 * ks * hk), 0.1 * ks * hk, 0.03 * ks * hk, 0.11 * ks * hk, { c: S.band || 0x6a5030, tile: 'bronze', w: hb, glow: S.glow }, null, 0.3);
        } else if (S.t === 'maul') {
          rbox(B, hs(0, 0, L1 - 0.1 * ks), 0.26 * ks, 0.3 * ks, 0.26 * ks, { c: steel, tile: 'stone', w: hb, glow: [0, 1] }, null, 0.25);
        } else if (S.t === 'club') {
          sphere(B, hs(0, 0, L1), 0.06 * ks, 0.06 * ks, 0.07 * ks, { c: wood, tile: 'wood', w: hb, ws: 8, hs: 6 });
          if (S.ember) { sphere(B, hs(0, 0, L1 + 0.05 * ks), 0.035 * ks, 0.035 * ks, 0.035 * ks, { c: 0xffa040, tile: 'stone', w: hb, glow: [1, 0], ws: 8, hs: 6 }); sock('muzzle', hb, hs(0, 0, L1 + 0.06 * ks)); }
        } else if (S.t === 'pick') {
          const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6 * 2 - 1; pts.push({ p: hs(0, t * 0.22 * ks, L1 - 0.02 * ks - Math.abs(t) * t * 0.0 - t * t * 0.06 * ks), rw: (0.022 - Math.abs(t) * 0.016) * ks, rf: 0.02 * ks }); }
          tube(B, pts, { seg: 6, c: S.c || 0x5a5a58, tile: 'plate', w: hb, cap0: true, cap1: true, fwd: vv(0, 0, 1) });
        } else if (S.t === 'scourge') {
          for (let i = 0; i < 3; i++) { const a = (i - 1) * 0.35; const pts = []; for (let j = 0; j <= 5; j++) { const t = j / 5; pts.push({ p: hs(Math.sin(a) * t * 0.12 * ks, -t * t * 0.18 * ks, L1 + t * 0.35 * ks), rw: 0.008 * ks, rf: 0.008 * ks }); } tube(B, pts, { seg: 4, c: 0x2a1a14, tile: 'leather', w: hb, glow: S.glow, fwd: vv(0, 1, 0) }); }
        }
        sock(main + '_base', hb, hs(0, 0, L1 * 0.55)); sock(main + '_tip', hb, top);
        break;
      }
      case 'spear': case 'halberd': case 'banner': {
        const L1 = (S.len || (S.t === 'banner' ? 1.7 : 1.35)) * ks, back = (S.back || 0.75) * ks;
        cyl(B, hs(0, 0, -back), hs(0, 0, L1), 0.017 * ks, 0.018 * ks, { c: wood, tile: 'wood', w: hb }, 7);
        if (S.t === 'spear') {
          blade(B, [[-0.022 * ks, 0], [0.022 * ks, 0], [0.034 * ks, 0.09 * ks], [0, 0.3 * ks], [-0.034 * ks, 0.09 * ks]], 0.008 * ks, (() => { const b = hs(0, 0, L1); return Mperm(b.x, b.y, b.z); })(), { c: steel, tile: 'plate', w: hb, glow: S.glow });
          cyl(B, hs(0, 0, L1 - 0.04 * ks), hs(0, 0, L1 + 0.02 * ks), 0.022 * ks, 0.018 * ks, { c: 0x4a4440, tile: 'plate', w: hb }, 6);
          if (S.tassel) cone(B, hs(0, -0.02 * ks, L1 - 0.06 * ks), hs(0, -0.18 * ks, L1 - 0.1 * ks), 0.03 * ks, { c: S.tassel, tile: 'wool', w: hb }, 6);
          sock(main + '_tip', hb, hs(0, 0, L1 + 0.3 * ks)); sock(main + '_base', hb, hs(0, 0, L1 - 0.1 * ks));
        } else if (S.t === 'halberd') {
          blade(B, [[0, 0], [0.2 * ks, -0.02 * ks], [0.26 * ks, 0.14 * ks], [0.18 * ks, 0.22 * ks], [0, 0.16 * ks]], 0.01 * ks, (() => { const b = hs(0, 0, L1 - 0.22 * ks); return Mperm(b.x, b.y, b.z); })(), { c: steel, tile: 'plate', w: hb });
          cone(B, hs(0, 0, L1), hs(0, 0, L1 + 0.24 * ks), 0.02 * ks, { c: steel, tile: 'plate', w: hb }, 5);
          cone(B, hs(0, 0, L1 - 0.12 * ks), hs(0, -0.14 * ks, L1 - 0.04 * ks), 0.016 * ks, { c: steel, tile: 'plate', w: hb }, 5);
          sock(main + '_tip', hb, hs(0, 0.2 * ks, L1 - 0.1 * ks)); sock(main + '_base', hb, hs(0, 0, L1 - 0.3 * ks));
        } else {
          // banner: crossbar + cloth hanging from it, a finial
          cyl(B, hs(-0.3 * ks, 0, L1 - 0.06 * ks), hs(0.3 * ks, 0, L1 - 0.06 * ks), 0.012 * ks, 0.012 * ks, { c: wood, tile: 'wood', w: hb }, 6);
          rbox(B, hs(0, -0.3 * ks, L1 - 0.1 * ks), 0.56 * ks, 0.6 * ks, 0.012 * ks, { c: S.cloth || 0x6a1a14, tile: 'wool', w: hb, glow: [0, 0.4] }, [0, 0, 0], 0.05);
          cone(B, hs(0, 0, L1), hs(0, 0, L1 + 0.14 * ks), 0.03 * ks, { c: 0xb08a4a, tile: 'bronze', w: hb }, 6);
          sock(main + '_tip', hb, hs(0, 0, L1 + 0.14 * ks)); sock(main + '_base', hb, hs(0, 0, L1 - 0.3 * ks));
          sock('muzzle', hb, hs(0, 0, L1 + 0.14 * ks));
        }
        break;
      }
      case 'shield_round': case 'shield_tall': {
        const fa = B.W('forearm_' + sd), fb = B.W('hand_' + sd);
        const c0 = fa.clone().lerp(fb, 0.55).add(vv(s * 0.07 * k, 0, 0.01 * k));
        if (S.t === 'shield_round') {
          const r = (S.r || 0.36) * ks;
          B.add(new T.CylinderGeometry(r, r, 0.03 * ks, 22, 1), M(c0.x, c0.y, c0.z, 0, 0, PI / 2), { c: S.wood || 0x6a4a2c, tile: 'wood', w: 'forearm_' + sd, uv: [6, 1] });
          torus(B, null, r, 0.018 * ks, M(c0.x + s * 0.004, c0.y, c0.z, 0, PI / 2, 0), { c: S.rim || 0x5a5856, tile: 'plate', w: 'forearm_' + sd, rs: 5, ts: 24 });
          const g = new T.SphereGeometry(0.075 * ks, 10, 6, 0, TAU, 0, PI * 0.5);
          B.add(g, M(c0.x + s * 0.016 * ks, c0.y, c0.z, 0, 0, -s * PI / 2), { c: S.boss || 0x8a8a88, tile: 'plate', w: 'forearm_' + sd });
          if (S.paint) for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + 0.3; rbox(B, vv(c0.x + s * 0.017 * ks, c0.y + Math.sin(a) * r * 0.55, c0.z + Math.cos(a) * r * 0.55), 0.004 * ks, r * 0.5, 0.06 * ks, { c: S.paint, tile: 'cloth', w: 'forearm_' + sd }, [a, 0, 0], 0.2); }
        } else {
          rbox(B, c0.clone().add(vv(0, 0.08 * ks, 0)), 0.04 * ks, 1.0 * ks, 0.5 * ks, { c: S.wood || 0x4a3a2a, tile: 'bronze', w: 'forearm_' + sd }, null, 0.12);
          rbox(B, c0.clone().add(vv(s * 0.022 * ks, 0.08 * ks, 0)), 0.012 * ks, 0.9 * ks, 0.08 * ks, { c: S.rim || 0x8a6a3a, tile: 'bronze', w: 'forearm_' + sd, glow: [0, 0.3] }, null, 0.3);
        }
        sock('shield', 'forearm_' + sd, c0.clone().add(vv(s * 0.03 * k, 0, 0)));
        break;
      }
      case 'bow': {
        // longbow in the LEFT hand: stave along hand Z, tips toward the archer (hand +Y); string tips -> 'nock' bone
        const L1 = 0.76 * ks;
        const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12 * 2 - 1; pts.push({ p: hs(0, t * t * 0.13 * ks, t * L1), rw: (0.022 - Math.abs(t) * 0.012) * ks, rf: (0.016 - Math.abs(t) * 0.008) * ks }); }
        tube(B, pts, { seg: 6, c: S.wood || 0x6a4a2a, tile: 'wood', w: hb, cap0: true, cap1: true, fwd: vv(0, 1, 0) });
        cyl(B, hs(0, 0, -0.06 * ks), hs(0, 0, 0.06 * ks), 0.024 * ks, 0.024 * ks, { c: lea, tile: 'leather', w: hb }, 6);
        const tipA = hs(0, 0.13 * ks, -L1), tipB = hs(0, 0.13 * ks, L1), nock = hs(0, 0.13 * ks, 0);
        boneW(B, 'nock', hb, nock);
        for (const tp of [tipA, tipB]) {
          const n = 6, ps = []; for (let i = 0; i <= n; i++) ps.push({ p: tp.clone().lerp(nock, i / n), rw: 0.0035 * ks, rf: 0.0035 * ks });
          tube(B, ps, { seg: 3, c: 0xd8d0b8, tile: 'rope', w: (p) => { const t = clamp(p.distanceTo(tp) / tp.distanceTo(nock), 0, 1); return [[hb, 1 - t], ['nock', t]]; } });
        }
        // the nocked arrow (bone 'arrow' under 'nock'; shown while drawing): points from the nock toward hand -Y (target)
        boneW(B, 'arrow', 'nock', nock);
        const a0 = nock.clone(), a1 = nock.clone().add(vv(0, -0.78 * ks, 0));
        cyl(B, a0, a1, 0.005 * ks, 0.005 * ks, { c: 0x8a6a40, tile: 'wood', w: 'arrow' }, 4);
        cone(B, a1, a1.clone().add(vv(0, -0.05 * ks, 0)), 0.012 * ks, { c: 0x6a6a6a, tile: 'plate', w: 'arrow' }, 4);
        for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; rbox(B, a0.clone().add(vv(Math.sin(a) * 0.008 * ks, -0.06 * ks, Math.cos(a) * 0.008 * ks)), 0.004 * ks, 0.09 * ks, 0.022 * ks, { c: S.fletch || 0xd8d0c0, tile: 'cloth', w: 'arrow' }, [0, a, 0], 0.1); }
        sock('weapon2_tip', hb, tipB); sock('weapon2_base', hb, tipA); sock('muzzle', 'nock', nock.clone().add(vv(0, -0.6 * ks, 0)));
        break;
      }
      case 'quiver': {
        const top = torsoPt(R, P.shY + 0.02 * k, PI * 0.82, 0.05 * k), bot = torsoPt(R, P.spineY, PI * 1.1, 0.06 * k);
        cyl(B, bot, top, 0.05 * k, 0.055 * k, { c: S.c || 0x4a3020, tile: 'leather', w: 'chest' }, 9);
        torus(B, null, 0.055 * k, 0.008 * k, Mseg(top, top.clone().add(top.clone().sub(bot).normalize().multiplyScalar(0.001)), 1, 1).multiply(new T.Matrix4().makeRotationX(PI / 2)), { c: 0x2a1a10, tile: 'leather', w: 'chest', rs: 4, ts: 12 });
        const dir = top.clone().sub(bot).normalize();
        for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const o = vv(Math.sin(a) * 0.025 * k, 0, Math.cos(a) * 0.025 * k); const b0 = top.clone().add(o), b1 = b0.clone().addScaledVector(dir, 0.11 * k); cyl(B, b0.clone().addScaledVector(dir, -0.05 * k), b1, 0.004 * k, 0.004 * k, { c: 0x8a6a40, tile: 'wood', w: 'chest' }, 4); rbox(B, b1.clone().addScaledVector(dir, -0.03 * k), 0.022 * k, 0.07 * k, 0.004 * k, { c: S.fletch || 0xd8d0c0, tile: 'cloth', w: 'chest' }, [0, a, 0.5], 0.1); }
        strap(B, P, R, [[P.shY, PI * 0.75], [P.shY + 0.01 * k, PI * 0.15], [P.chestY, -PI * 0.25], [P.spineY + 0.02 * k, -PI * 0.55], [P.spineY + 0.04 * k, -PI * 0.9]], { c: 0x3a2418, w: 0.02 });
        break;
      }
      case 'staff_lantern': {
        const L1 = 0.72 * ks, back = 1.02 * ks;
        const pts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push({ p: hs(Math.sin(t * 7) * 0.006, 0, -back + t * (L1 + back)), rw: 0.02 * ks * (1 + 0.15 * Math.sin(t * 21)), rf: 0.019 * ks }); }
        tube(B, pts, { seg: 7, c: S.wood || 0x4a3626, tile: 'wood', w: hb, cap0: true, fwd: vv(0, 1, 0) });
        // crook at the top
        const crook = []; for (let i = 0; i <= 6; i++) { const a = i / 6 * PI * 0.9; crook.push({ p: hs(0, (Math.cos(a) - 1) * -0.0 + Math.sin(a) * 0.09 * ks, L1 + Math.sin(a) * 0.02 + (1 - Math.cos(a)) * 0.0 + Math.sin(a) * 0.05 * ks), rw: 0.016 * ks, rf: 0.016 * ks }); }
        tube(B, crook, { seg: 6, c: S.wood || 0x4a3626, tile: 'wood', w: hb, cap1: true, fwd: vv(0, 1, 0) });
        const hook = hs(0, 0.16 * ks, L1 + 0.05 * ks);
        boneW(B, 'lantern', hb, hook);
        // lantern hanging below the hook (in bind pose, hand-space -Y is "down" only when the arm hangs; the pendulum
        // code keeps the 'lantern' bone upright in world space, so it is modelled hanging along world -Y)
        const lc = hook.clone().add(vv(0, -0.14 * ks, 0));
        cyl(B, hook, hook.clone().add(vv(0, -0.06 * ks, 0)), 0.003 * ks, 0.003 * ks, { c: 0x2a2a2a, tile: 'plate', w: 'lantern' }, 4);
        lathe(B, [[0.045, 0], [0.04, 0.02], [0.01, 0.045], [0.005, 0.06]], M(lc.x, lc.y + 0.055 * ks, lc.z, 0, 0, 0, ks), { c: 0x3a3430, tile: 'plate', w: 'lantern', seg: 8 });
        lathe(B, [[0.005, -0.012], [0.05, -0.008], [0.05, 0]], M(lc.x, lc.y - 0.06 * ks, lc.z, 0, 0, 0, ks), { c: 0x3a3430, tile: 'plate', w: 'lantern', seg: 8 });
        for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + PI / 4; cyl(B, lc.clone().add(vv(Math.sin(a) * 0.04 * ks, -0.06 * ks, Math.cos(a) * 0.04 * ks)), lc.clone().add(vv(Math.sin(a) * 0.04 * ks, 0.055 * ks, Math.cos(a) * 0.04 * ks)), 0.004 * ks, 0.004 * ks, { c: 0x2a2624, tile: 'plate', w: 'lantern' }, 4); }
        sphere(B, lc, 0.034 * ks, 0.05 * ks, 0.034 * ks, { c: 0xffe0a0, tile: 'bone', w: 'lantern', glow: [1, 0], ws: 10, hs: 8, ao: 0 });
        sock('lantern', 'lantern', lc); sock('muzzle', 'lantern', lc);
        sock('weapon_tip', hb, hs(0, 0, L1)); sock('weapon_base', hb, hs(0, 0, 0.3 * ks));
        break;
      }
      case 'sling': {
        boneW(B, 'sling1', hb, hs(0, 0, 0.02));
        boneW(B, 'sling2', 'sling1', hs(0, -0.32, 0.02));
        const a = hs(0, 0, 0.02), b = hs(0, -0.32, 0.02);
        for (const off of [-0.012, 0.012]) { const ps = []; for (let i = 0; i <= 5; i++) ps.push({ p: a.clone().lerp(b, i / 5).add(vv(0, 0, off * Math.sin(i / 5 * PI) * 2)), rw: 0.003, rf: 0.003 }); tube(B, ps, { seg: 3, c: 0x6a5a40, tile: 'rope', w: (p) => { const t = clamp((a.y - p.y) / 0.32, 0, 1); return [['sling1', 1 - t], ['sling2', t]]; } }); }
        sphere(B, b, 0.03, 0.02, 0.028, { c: 0x4a3420, tile: 'leather', w: 'sling2', ws: 8, hs: 6 });
        boneW(B, 'slingstone', 'sling2', b);
        sphere(B, b.clone().add(vv(0, 0.006, 0)), 0.022, 0.02, 0.022, { c: 0x8a8478, tile: 'stone', w: 'slingstone', ws: 7, hs: 5 });
        sock('muzzle', 'sling2', b); sock('weapon_tip', 'sling2', b); sock('weapon_base', hb, a);
        break;
      }
      case 'emberheart': {
        const c = hs(0, -0.005, 0.045);
        const g = new T.OctahedronGeometry(1, 0);
        const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) { const y = pa.getY(i); pa.setY(i, y * 1.9); pa.setX(i, pa.getX(i) * (1 + 0.2 * Math.sign(y))); }
        g.computeVertexNormals();
        B.add(g, M(c.x, c.y, c.z, 0.3, 0.4, 0.2, 0.026), { c: 0xffb070, tile: 'bone', w: hb, glow: [1, 0], ao: 0 });
        const g2 = new T.OctahedronGeometry(1, 0); g2.scale(0.6, 1.3, 0.6);
        B.add(g2, M(c.x + 0.015, c.y + 0.01, c.z - 0.01, -0.5, 0, 0.6, 0.018), { c: 0xffa060, tile: 'bone', w: hb, glow: [1, 0], ao: 0 });
        sock('ember', hb, c); sock('weapon2_tip', hb, c); sock('weapon2_base', hb, hs(0, 0, 0));
        break;
      }
      case 'lute': {
        const top = torsoPt(R, P.shY + 0.03 * k, PI * 1.2, 0.07 * k), bot = torsoPt(R, P.spineY - 0.02 * k, PI * 0.88, 0.09 * k);
        const dir = top.clone().sub(bot).normalize();
        const q = new T.Quaternion().setFromUnitVectors(Y, dir);
        const mb = new T.Matrix4().compose(bot, q, vv(1, 1, 0.5));
        lathe(B, [[0.0005, -0.02], [0.1, 0.03], [0.13, 0.12], [0.11, 0.2], [0.06, 0.27], [0.03, 0.3]], mb, { c: S.wood || 0x8a5a2a, tile: 'wood', w: 'chest', seg: 14 });
        cyl(B, bot.clone().addScaledVector(dir, 0.28), bot.clone().addScaledVector(dir, 0.58), 0.022, 0.018, { c: 0x4a3020, tile: 'wood', w: 'chest' }, 6);
        rbox(B, bot.clone().addScaledVector(dir, 0.62), 0.05, 0.1, 0.03, { c: 0x4a3020, tile: 'wood', w: 'chest' }, null, 0.2);
        strap(B, P, R, [[P.shY, -PI * 0.75], [P.shY + 0.01 * k, -PI * 0.15], [P.chestY, PI * 0.25], [P.spineY + 0.02 * k, PI * 0.6], [P.spineY + 0.03 * k, PI * 0.9]], { c: 0x6a2a20, w: 0.024, tile: 'wool' });
        break;
      }
      case 'drum': {
        const c = torsoPt(R, P.hipJ + 0.02 * k, -PI * 0.55, 0.09 * k);
        B.add(new T.CylinderGeometry(0.11, 0.11, 0.07, 14), M(c.x, c.y, c.z, 0, 0, PI / 2 - 0.2), { c: 0xb8a888, tile: 'leather', w: 'hips', uv: [3, 1] });
        torus(B, null, 0.112, 0.008, M(c.x, c.y, c.z, 0, PI / 2, 0.2), { c: 0x6a4a2a, tile: 'wood', w: 'hips', rs: 4, ts: 16 });
        break;
      }
      case 'satchel': {
        const c = torsoPt(R, P.hipJ + 0.02 * k, S.side === 'l' ? PI * 0.62 : -PI * 0.62, 0.06 * k);
        rbox(B, c, 0.08 * k, 0.17 * k, 0.21 * k, { c: S.c || 0x6a4a2a, tile: 'leather', w: 'hips' }, [0, S.side === 'l' ? 0.6 : -0.6, 0], 0.3);
        rbox(B, c.clone().add(vv(0, 0.05 * k, 0)), 0.09 * k, 0.07 * k, 0.215 * k, { c: col(S.c || 0x6a4a2a).multiplyScalar(0.8), tile: 'leather', w: 'hips' }, [0, S.side === 'l' ? 0.6 : -0.6, 0], 0.3);
        const sa = S.side === 'l' ? -1 : 1;
        strap(B, P, R, [[P.shY, sa * PI * 0.8], [P.shY + 0.012 * k, sa * PI * 0.2], [P.chestY, -sa * PI * 0.2], [P.spineY, -sa * PI * 0.45], [P.hipJ + 0.08 * k, -sa * PI * 0.6]], { c: 0x3a2418, w: 0.02 });
        break;
      }
      case 'bandolier': {
        strap(B, P, R, [[P.shY, PI * 0.8], [P.shY + 0.012 * k, PI * 0.25], [P.chestY, -PI * 0.12], [P.spineY + 0.02 * k, -PI * 0.42], [P.spineY - 0.01 * k, -PI * 0.7]], { c: 0x2a1c14, w: 0.04 });
        for (let i = 0; i < 4; i++) {
          const y = lerp(P.shY - 0.03 * k, P.spineY + 0.06 * k, i / 3), a = lerp(PI * 0.12, -PI * 0.38, i / 3);
          const p0 = torsoPt(R, y, a, 0.02 * k);
          const g = new T.Shape(); g.moveTo(-0.012, 0); g.lineTo(0.012, 0); g.lineTo(0, 0.12); g.lineTo(-0.012, 0);
          const eg = new T.ExtrudeGeometry(g, { depth: 0.004, bevelEnabled: false }); eg.translate(0, -0.06, 0);
          B.add(eg, M(p0.x, p0.y, p0.z, 0, a, 0.5), { c: 0xb0b2b6, tile: 'plate', w: 'chest', uv: [5, 5] });
        }
        break;
      }
      case 'horn': {
        const c = torsoPt(R, P.hipJ + 0.04 * k, PI * 0.45, 0.07 * k);
        const pts = []; for (let i = 0; i <= 7; i++) { const t = i / 7; pts.push({ p: c.clone().add(vv(t * 0.06 * k, -t * 0.05 * k + t * t * 0.12 * k, (t - 0.5) * 0.3 * k)), rw: (0.012 + t * t * 0.04) * k, rf: (0.012 + t * t * 0.04) * k }); }
        tube(B, pts, { seg: 8, c: S.c || 0xd8c8a8, tile: 'bone', w: 'hips', cap0: true, fwd: vv(0, 1, 0) });
        break;
      }
      case 'censer': {
        // a censer on a chain in the left hand: bones 'censer' (pendulum, kept hanging in world space)
        const top = hs(0, 0, 0.03);
        boneW(B, 'censer', hb, top);
        const ball = top.clone().add(vv(0, -0.32 * ks, 0));
        cyl(B, top, ball.clone().add(vv(0, 0.06 * ks, 0)), 0.004 * ks, 0.004 * ks, { c: 0x6a5a40, tile: 'bronze', w: 'censer' }, 4);
        sphere(B, ball, 0.07 * ks, 0.07 * ks, 0.07 * ks, { c: S.c || 0x8a6a3a, tile: 'bronze', w: 'censer', ws: 10, hs: 8 });
        torus(B, null, 0.07 * ks, 0.012 * ks, M(ball.x, ball.y, ball.z, PI / 2, 0, 0), { c: 0xffa040, tile: 'stone', w: 'censer', glow: [1, 0], rs: 4, ts: 14 });
        sock('censer', 'censer', ball); sock('muzzle', 'censer', ball);
        break;
      }
      case 'book': {
        const c = hs(0, 0.02, 0.1);
        rbox(B, c, 0.05 * ks, 0.2 * ks, 0.16 * ks, { c: S.c || 0x4a2a1a, tile: 'leather', w: hb }, [0.3, 0, 0], 0.15);
        rbox(B, c.clone().add(vv(0, 0.02 * ks, 0)), 0.056 * ks, 0.18 * ks, 0.14 * ks, { c: 0xd8c8a0, tile: 'cloth', w: hb, glow: [0.5, 0] }, [0.3, 0, 0], 0.1);
        sock('muzzle', hb, c);
        break;
      }
      default: break;
    }
  }
  function buildExtra(B, P, R, E, L) {
    const k = P.k;
    if (E.t === 'spines') {   // thorns / slate plates along the back
      for (let i = 0; i < (E.n || 9); i++) {
        const y = lerp(P.spineY - 0.05 * k, P.neckBase, i / ((E.n || 9) - 1)), a = PI + (i % 3 - 1) * 0.5;
        const p0 = torsoPt(R, y, a, -0.01 * k), dir = vv(Math.sin(a) * 0.5, 0.45, Math.cos(a)).normalize();
        if (E.plates) rbox(B, p0.clone().addScaledVector(dir, 0.03 * k), 0.16 * k, 0.04 * k, 0.12 * k, { c: E.c, tile: 'stone', w: torsoW(P), glow: E.glow }, [0.4, a, 0], 0.2);
        else cone(B, p0, p0.clone().addScaledVector(dir, (0.12 + (i % 2) * 0.08) * k), 0.035 * k, { c: E.c, tile: 'bone', w: torsoW(P), glow: E.glow }, 5);
      }
    } else if (E.t === 'antlers') {
      const C = vv(0, P.headC + 0.08 * k, 0);
      for (const s of [1, -1]) {
        const base = C.clone().add(vv(s * 0.06 * k, 0.04 * k, -0.02 * k));
        const tipA = base.clone().add(vv(s * 0.22 * k, 0.32 * k, -0.08 * k));
        const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push({ p: base.clone().lerp(tipA, t).add(vv(s * Math.sin(t * PI) * 0.06 * k, 0, 0)), rw: (0.02 - t * 0.012) * k, rf: (0.02 - t * 0.012) * k }); }
        tube(B, pts, { seg: 5, c: E.c || 0xd8d0c0, tile: 'bone', w: 'head', cap1: true, fwd: vv(0, 0, 1) });
        for (let j = 0; j < 3; j++) { const p0 = base.clone().lerp(tipA, 0.35 + j * 0.2); cone(B, p0, p0.clone().add(vv(s * 0.04 * k, 0.12 * k, (j - 1) * 0.06 * k)), 0.012 * k, { c: E.c || 0xd8d0c0, tile: 'bone', w: 'head' }, 5); }
      }
    } else if (E.t === 'coins') {
      strap(B, P, R, [[P.shY, PI * 0.7], [P.chestY + 0.02 * k, PI * 0.08], [P.chestY, -PI * 0.1], [P.shY, -PI * 0.7]], { c: 0xb08a40, w: 0.016, tile: 'bronze' });
    } else if (E.t === 'stole') {
      strap(B, P, R, [[P.neckBase - 0.01 * k, PI * 0.6], [P.chestY, PI * 0.12], [P.hipJ - 0.05 * k, PI * 0.1]], { c: E.c || 0xb08a40, w: 0.05, tile: 'cloth' });
      strap(B, P, R, [[P.neckBase - 0.01 * k, -PI * 0.6], [P.chestY, -PI * 0.12], [P.hipJ - 0.05 * k, -PI * 0.1]], { c: E.c || 0xb08a40, w: 0.05, tile: 'cloth' });
    } else if (E.t === 'runes') {
      for (let i = 0; i < 6; i++) { const y = lerp(P.spineY, P.shY - 0.06 * k, i / 5), a = (i - 2.5) * 0.25; rbox(B, torsoPt(R, y, a, 0.11 * k), 0.035 * k, 0.012 * k, 0.012 * k, { c: 0x2a2a2a, tile: 'stone', w: torsoW(P), glow: [0, 1] }, [0, a, i * 0.7], 0.3); }
    } else if (E.t === 'chestplate') {
      const g = new T.SphereGeometry(1, 14, 8, -PI * 0.5, PI, 0.15 * PI, 0.6 * PI);
      const r = ringAt(R, P.chestY);
      B.add(g, M(0, P.chestY + 0.01 * k, 0.0, 0, 0, 0, r.w + 0.02 * k, (P.shY - P.spineY) * 0.62, r.f + 0.025 * k), { c: E.c, tile: E.tile || 'plate', w: torsoW(P), glow: E.glow });
    } else if (E.t === 'bracer') {
      void L;
    }
  }

  // ---- full human template from a look spec
  function buildHuman(L) {
    const B = new Builder();
    const P = humanProps(L.h, L.build || {});
    humanSkeleton(B, P);
    const R = buildBody(B, P, L);
    if (L.skirt) buildSkirt(B, P, R, L.skirt);
    if (L.skirt2) buildSkirt(B, P, R, L.skirt2);
    buildHead(B, P, L);
    if (!(L.cloak && L.cloak.hood === 'up') && !(L.helm && (L.helm.style === 'full' || L.helm.style === 'block'))) buildHair(B, P, L);
    buildBeard(B, P, L);
    if (L.belt) buildBelt(B, P, R, L.belt);
    if (L.mantle) mantle(B, P, R, L.mantle);
    if (L.pauldrons) pauldrons(B, P, R, L.pauldrons);
    if (L.scarf) scarf(B, P, R, L.scarf);
    for (const E of L.extras || []) buildExtra(B, P, R, E, L);
    if (L.cloak) buildCloak(B, P, R, L.cloak);
    if (L.helm) buildHelm(B, P, L, L.helm);
    for (const S of L.props || []) buildProp(B, P, R, S);
    // standard sockets
    const so = (name, bone, p) => { const bw = B.W(bone); B.socket(name, bone, p.x - bw.x, p.y - bw.y, p.z - bw.z); };
    so('head', 'head', vv(0, P.headC, 0.02 * P.k)); so('chest', 'chest', vv(0, P.chestY, 0.05 * P.k)); so('mouth', 'head', vv(0, P.headC - 0.05 * P.k, 0.09 * P.k));
    so('hand_r', 'hand_r', B.W('hand_r').clone().add(vv(0, -P.fist, 0))); so('hand_l', 'hand_l', B.W('hand_l').clone().add(vv(0, -P.fist, 0)));
    so('foot_l', 'foot_l', B.W('foot_l').clone().add(vv(0, -0.06 * P.k, 0.04 * P.k))); so('foot_r', 'foot_r', B.W('foot_r').clone().add(vv(0, -0.06 * P.k, 0.04 * P.k)));
    so('top', 'head', vv(0, P.top + 0.05, 0));
    if (!B.sockets.weapon_tip) { so('weapon_tip', 'hand_r', B.W('hand_r').clone().add(vv(0, -P.fist, 0.1))); so('weapon_base', 'hand_r', B.W('hand_r').clone().add(vv(0, -P.fist, 0))); }
    if (!B.sockets.muzzle) so('muzzle', 'hand_r', B.W('hand_r').clone().add(vv(0, -P.fist, 0.05)));
    return { geo: B.build(), bones: B.bones, sockets: B.sockets, P, h: L.h, rig: 'human' };
  }

  // =====================================================================================================
  // 5. LOOKS: heroes by id, foes by content id (falls back to glyph + act). Muted natural palette.
  // =====================================================================================================
  const HERO_LOOK = {
    wren: { h: 1.32, style: 'hero', build: { head: 1.13, sh: 0.94, hip: 1.0, mass: 1.04, legs: 0.93, arms: 0.98 }, skin: 0xdcac8a, hair: { style: 'messy', c: 0x5a3820 },
      torso: { c: 0x5e4630, tile: 'leather' }, sleeve: { c: 0x9c8c6c, tile: 'cloth', len: 0.9, puff: 0.06 }, legs: { c: 0x575140, tile: 'wool' }, boots: { c: 0x3e2c1e, top: 0.55 },
      skirt: { c: 0x9c8c6c, tile: 'cloth', len: 0.1, flare: 0.02, inner: false }, belt: { c: 0x3a2618 },
      cloak: { c: 0x4c4a32, tile: 'oilskin', len: 0.74, hood: 'down', flare: 0.13, inner: 0x3a2a1a, clasp: 0x9a7a40 },
      props: [{ t: 'sling', hand: 'r' }, { t: 'emberheart', hand: 'l' }, { t: 'satchel', side: 'r', c: 0x6a4a2a }],
      glow: 0xff7b2e },
    ysolde: { h: 1.74, style: 'hero', build: { fem: true, sh: 0.94, hip: 1.0, mass: 0.92, legs: 1.04 }, skin: 0xc8946e, hair: { style: 'tied', c: 0x6a3020 },
      torso: { c: 0x4a4a32, tile: 'leather' }, sleeve: { c: 0x575a48, tile: 'wool', len: 1 }, cuff: { c: 0x3a2a1c, tile: 'leather', from: 0.62, to: 0.97 },
      legs: { c: 0x3e3a30, tile: 'wool' }, boots: { c: 0x2e2418, top: 0.85 }, skirt: { c: 0x4a4a32, tile: 'leather', len: 0.24, open: 0.6, flare: 0.05 }, belt: { c: 0x2e1e12 },
      cloak: { c: 0x56604e, tile: 'wool', len: 1.02, hood: 'up', width: PI * 0.66, inner: 0x3a3e30, flare: 0.16 },
      props: [{ t: 'longknife', hand: 'r' }, { t: 'longknife', hand: 'l' }] },
    brakka: { h: 1.8, style: 'heavy', build: { fem: true, sh: 1.3, hip: 1.12, mass: 1.32, legs: 0.97, arms: 1.02, neck: 0.9 }, skin: 0xd0a080, hair: { style: 'braid', c: 0x7a3c1c },
      torso: { c: 0x8c8e90, tile: 'mail' }, sleeve: { c: 0x8c8e90, tile: 'mail', len: 0.5 }, cuff: { c: 0x4a3424, tile: 'leather', from: 0.55, to: 0.96 }, armSkin: 0x6a5a48,
      legs: { c: 0x4a3e30, tile: 'wool' }, boots: { c: 0x3a2a1c, top: 0.62 }, skirt: { c: 0x8c8e90, tile: 'mail', len: 0.38, flare: 0.07, open: 0.45, inner: 0x4a4a4a, stiff: true },
      belt: { c: 0x2e1e12, h: 0.06, buckle: 0xb0904a }, mantle: { c: 0x6a5a48, tile: 'fur', scale: 1.1 },
      props: [{ t: 'hammer', hand: 'r', c: 0x8a8c90 }, { t: 'shield_round', hand: 'l', wood: 0x6a4a2c, paint: 0x8a3a24, r: 0.38 }] },
    neve: { h: 1.68, style: 'hero', build: { fem: true, sh: 0.9, mass: 0.88, legs: 1.05 }, skin: 0xe2b896, hair: { style: 'braid', c: 0x8a6a3c },
      torso: { c: 0x4e5a3a, tile: 'cloth' }, sleeve: { c: 0x4e5a3a, tile: 'cloth', len: 1 }, cuff: { c: 0x3a2a1c, tile: 'leather', from: 0.6, to: 0.97 },
      legs: { c: 0x4a4436, tile: 'wool' }, boots: { c: 0x3a2c1e, top: 0.55 }, skirt: { c: 0x4e5a3a, tile: 'cloth', len: 0.22, flare: 0.05, open: 0.4 }, belt: { c: 0x3a2618 },
      cloak: { c: 0x5a5040, tile: 'wool', len: 0.42, hood: 'down', width: PI * 0.58, flare: 0.06 },
      props: [{ t: 'bow', hand: 'l', wood: 0x6a4a2a }, { t: 'quiver', c: 0x4a3020 }] },
    maddoc: { h: 1.76, style: 'old', build: { sh: 0.97, mass: 0.92, belly: 1.05 }, skin: 0xcf9f82, hair: { style: 'short', c: 0xd8d4cc }, beard: { style: 'long', c: 0xd4d0c8 },
      torso: { c: 0x5a4632, tile: 'wool' }, sleeve: { c: 0x5a4632, tile: 'wool', len: 1, puff: 0.08 }, legs: { c: 0x3e3a34, tile: 'wool' }, boots: { c: 0x2e2218, top: 0.4 },
      skirt: { c: 0x5a4632, tile: 'wool', len: 0.78, open: 0.55, flare: 0.13, inner: 0x3a3024 }, belt: { c: 0x2a1c12 },
      props: [{ t: 'staff_lantern', hand: 'r', wood: 0x4a3626 }, { t: 'satchel', side: 'l', c: 0x5a4028 }] },
    rook: { h: 1.8, style: 'hero', build: { sh: 1.08, mass: 1.0 }, skin: 0xb88a68, hair: { style: 'short', c: 0x1e1a18 }, beard: { style: 'stubble', c: 0x1e1a18 },
      torso: { c: 0x3a2a20, tile: 'leather' }, sleeve: { c: 0x3a2a20, tile: 'leather', len: 1 }, cuff: { c: 0x241a14, tile: 'leather', from: 0.7, to: 0.98 },
      legs: { c: 0x2e2a26, tile: 'wool' }, boots: { c: 0x221810, top: 0.8 }, skirt: { c: 0x3a2a20, tile: 'leather', len: 0.32, open: 0.75, flare: 0.06 }, belt: { c: 0x1e140e, buckle: 0xb8b8b8 },
      cloak: { c: 0x5a2420, tile: 'wool', len: 0.55, width: PI * 0.42, flare: 0.05, collar: false },
      props: [{ t: 'sword', hand: 'r' }, { t: 'bandolier' }] },
    tamsin: { h: 1.64, style: 'hero', build: { fem: true, sh: 0.9, mass: 0.9 }, skin: 0x9a6a4a, hair: { style: 'curly', c: 0x1a1410 },
      torso: { c: 0x34485a, tile: 'wool' }, sleeve: { c: 0xa89a7a, tile: 'cloth', len: 0.95, puff: 0.14 }, legs: { c: 0x4a4038, tile: 'wool' }, boots: { c: 0x3a281c, top: 0.5 },
      skirt: { c: 0x34485a, tile: 'wool', len: 0.44, flare: 0.13, open: 0.25 }, belt: { c: 0x6a4a2a }, scarf: { c: 0xb03024 },
      props: [{ t: 'spear', hand: 'r', len: 1.15, back: 0.6, tassel: 0xb03024 }, { t: 'lute' }, { t: 'drum' }] }
  };
  const ACT_OF = (u) => (u && u.def && u.def.act) || (AB.world && AB.world.level && typeof AB.world.level.act === 'number' ? AB.world.level.act : 1);
  const FOE_LOOK = {
    hedge_cutthroat: { rig: 'human', h: 1.75, style: 'rogue', build: { mass: 0.92 }, skin: 0xb08060, hair: { style: 'short', c: 0x2a2018 }, torso: { c: 0x4a3a2a, tile: 'leather' }, sleeve: { c: 0x5a5040, tile: 'wool', len: 1 },
      legs: { c: 0x3e3830, tile: 'wool' }, boots: { c: 0x2e241a, top: 0.5 }, belt: { c: 0x2a1c12 }, helm: { style: 'mask', c: 0x5a4a3a }, cloak: { c: 0x4a4434, tile: 'wool', len: 0.6, hood: 'up', jag: 0.06 },
      props: [{ t: 'knife', hand: 'r' }, { t: 'dagger', hand: 'l' }] },
    tithe_taker: { rig: 'human', h: 1.75, style: 'heavy', build: { sh: 1.15, mass: 1.25, belly: 1.3 }, skin: 0xb88a6a, hair: { style: 'short', c: 0x3a2a1e }, beard: { style: 'full', c: 0x3a2a1e },
      torso: { c: 0x4a3424, tile: 'leather' }, sleeve: { c: 0x5a4a3a, tile: 'wool', len: 1 }, legs: { c: 0x3a3028, tile: 'wool' }, boots: { c: 0x2a1e14, top: 0.7 },
      skirt: { c: 0x4a3424, tile: 'leather', len: 0.6, open: 0.6, flare: 0.1 }, belt: { c: 0x2a1c12, buckle: 0xb08a40 }, helm: { style: 'skullcap', c: 0x3a2a1e }, extras: [{ t: 'coins' }],
      props: [{ t: 'cleaver', hand: 'r' }] },
    pass_reaver: { rig: 'human', h: 1.85, style: 'soldier', build: { sh: 1.1, mass: 1.1 }, skin: 0xc09070, beard: { style: 'full', c: 0x6a5a48 }, torso: { c: 0x7a7c80, tile: 'mail' }, sleeve: { c: 0x4a4a4a, tile: 'wool', len: 1 },
      legs: { c: 0x6a5a48, tile: 'fur' }, boots: { c: 0x3a2e24, top: 0.6 }, skirt: { c: 0x7a7c80, tile: 'mail', len: 0.34, flare: 0.06, stiff: true }, belt: { c: 0x2a1c12 },
      mantle: { c: 0x9a8a78, tile: 'fur', scale: 1.15 }, helm: { style: 'horned', c: 0x6a6c70 }, props: [{ t: 'halberd', hand: 'r' }] },
    ashguard_spear: { rig: 'human', h: 1.85, style: 'soldier', build: { sh: 1.06, mass: 1.05 }, skin: 0x8a6048, torso: { c: 0x5a4a32, tile: 'scale' }, sleeve: { c: 0x3a3028, tile: 'wool', len: 1 }, cuff: { c: 0x6a5434, tile: 'bronze' },
      legs: { c: 0x2a2420, tile: 'wool' }, boots: { c: 0x5a4a32, tile: 'bronze', top: 0.75 }, skirt: { c: 0x5a4a32, tile: 'bronze', len: 0.3, stiff: true, flare: 0.05 }, belt: { c: 0x2a1c12 },
      pauldrons: { c: 0x5a4a32, tile: 'bronze', rim: 0x8a6a3a }, helm: { style: 'crested', c: 0x5a4a32, tile: 'bronze', crest: 0x6a1a14 }, props: [{ t: 'spear', hand: 'r', len: 1.5, c: 0x8a7a60 }, { t: 'shield_tall', hand: 'l', wood: 0x4a3a2a, rim: 0x8a6a3a }] },
    ember_pilgrim: { rig: 'human', h: 1.75, style: 'caster', build: { mass: 0.9 }, skin: 0xa88068, torso: { c: 0x5a4632, tile: 'wool' }, sleeve: { c: 0x5a4632, tile: 'wool', len: 1, puff: 0.18 },
      legs: { c: 0x4a3a2a, tile: 'wool' }, boots: { c: 0x2e2218, top: 0.3 }, skirt: { c: 0x5a4632, tile: 'wool', len: 0.86, flare: 0.16, jag: 0.04 }, belt: { c: 0x8a7a5a, buckle: false },
      cloak: { c: 0x4a3a2a, tile: 'wool', len: 0.5, hood: 'up', jag: 0.05 }, props: [{ t: 'club', hand: 'r', ember: true, len: 1.4 }], glow: 0xff7b2e },
    ash_acolyte: { rig: 'human', h: 1.75, style: 'caster', build: { mass: 0.9 }, skin: 0x9a9088, facePaint: (x, y, z, out) => out.lerp(_c1.setRGB(0.25, 0.24, 0.23), 0.5 * sstep(0.4, -0.2, y)),
      torso: { c: 0x6a6660, tile: 'wool' }, sleeve: { c: 0x6a6660, tile: 'wool', len: 1, puff: 0.15 }, legs: { c: 0x4a4640, tile: 'wool' }, boots: { c: 0x2e2a24, top: 0.3 },
      skirt: { c: 0x6a6660, tile: 'wool', len: 0.86, flare: 0.14, jag: 0.03 }, belt: { c: 0x9a7a30, buckle: false }, extras: [{ t: 'stole', c: 0x9a7a30 }],
      cloak: { c: 0x5a5650, tile: 'wool', len: 0.5, hood: 'up' }, props: [{ t: 'book', hand: 'l', c: 0x3a2014 }, { t: 'dagger', hand: 'r' }], glow: 0xff9a40 },
    kiln_priest: { rig: 'human', h: 1.8, style: 'caster', build: { mass: 0.95 }, skin: 0x8a5a48, beard: { style: 'full', c: 0x2a1a14 }, torso: { c: 0x3a1a16, tile: 'wool' }, sleeve: { c: 0x3a1a16, tile: 'wool', len: 1, puff: 0.2 },
      legs: { c: 0x2a1a14, tile: 'wool' }, boots: { c: 0x1e1410, top: 0.3 }, skirt: { c: 0x3a1a16, tile: 'wool', len: 0.95, flare: 0.18 }, belt: { c: 0xb08a40 }, extras: [{ t: 'stole', c: 0xa07a30 }],
      helm: { style: 'mitre', c: 0x5a1a14, rim: 0xb08a40 }, props: [{ t: 'censer', hand: 'l' }, { t: 'club', hand: 'r', len: 1.5, wood: 0x2a1a14, ember: true }], glow: 0xff7b2e },
    burnt_inquisitor: { rig: 'human', h: 1.8, style: 'heavy', build: { sh: 1.1, mass: 1.15 }, skin: 0x5a4038, torso: { c: 0x2a2420, tile: 'plate', glow: [0, 0.6] }, sleeve: { c: 0x4a1a14, tile: 'wool', len: 1 },
      legs: { c: 0x2a1a14, tile: 'wool' }, boots: { c: 0x2a2420, tile: 'plate', top: 0.7 }, skirt: { c: 0x4a1a14, tile: 'wool', len: 0.8, flare: 0.12, jag: 0.06, glow: [0, 0.3] }, belt: { c: 0x1a1210 },
      pauldrons: { c: 0x2a2420, tile: 'plate' }, helm: { style: 'full', c: 0x2a2420, slitGlow: true }, props: [{ t: 'scourge', hand: 'r', glow: [0, 1] }, { t: 'censer', hand: 'l' }], glow: 0xff7b2e, glow2: 0xff5a1a, glow2I: 0.9 },
    march_herald: { rig: 'human', h: 2.0, style: 'soldier', build: { sh: 1.08, mass: 1.05 }, skin: 0x6a5048, torso: { c: 0x4a4440, tile: 'plate' }, sleeve: { c: 0x3a2420, tile: 'wool', len: 1 }, cuff: { c: 0x4a4440, tile: 'plate' },
      legs: { c: 0x2a2420, tile: 'wool' }, boots: { c: 0x4a4440, tile: 'plate', top: 0.7 }, skirt: { c: 0x5a1a14, tile: 'wool', len: 0.5, flare: 0.08 }, belt: { c: 0x1a1210 },
      pauldrons: { c: 0x4a4440, tile: 'plate', rim: 0x8a6a3a }, helm: { style: 'full', c: 0x4a4440, slitGlow: true, plume: 0x6a1a14 }, cloak: { c: 0x5a1a14, tile: 'wool', len: 1.0, collar: false },
      props: [{ t: 'banner', hand: 'r', cloth: 0x6a1a14 }, { t: 'horn' }], glow: 0xff8a3a },
    cinder_regent: { rig: 'human', h: 2.0, style: 'boss', build: { sh: 1.18, mass: 1.12 }, skin: 0x4a3028, torso: { c: 0x2a2622, tile: 'plate', glow: [0, 0.8] }, sleeve: { c: 0x2a2622, tile: 'mail', len: 1 }, cuff: { c: 0x2a2622, tile: 'plate', glow: [0, 0.6] },
      legs: { c: 0x1e1a18, tile: 'mail' }, boots: { c: 0x2a2622, tile: 'plate', top: 0.8, glow: [0, 0.6] }, skirt: { c: 0x2a2622, tile: 'plate', len: 0.42, stiff: true, flare: 0.06, glow: [0, 0.5] }, belt: { c: 0x1a1210, buckle: 0xb08a40 },
      pauldrons: { c: 0x2a2622, tile: 'plate', rim: 0xb08a40, scale: 1.25, glow: [0, 0.7] }, mantle: { c: 0x2a2420, tile: 'fur', scale: 1.1 }, helm: { style: 'crown', c: 0x3a3028 }, eyes: 0xff9040, eyeGlow: true,
      cloak: { c: 0x6a1410, tile: 'wool', len: 1.15, width: PI * 0.7, collar: false, jag: 0.05 }, extras: [{ t: 'chestplate', c: 0x2a2622, glow: [0, 0.9] }],
      props: [{ t: 'greatsword', hand: 'r', c: 0x3a3030, glow: [0, 1] }], glow: 0xff9040, glow2: 0xff5a14, glow2I: 1.4 },
    mire_ghoul: { rig: 'human', h: 1.5, style: 'ghoul', build: { mass: 0.72, arms: 1.25, legs: 0.92, head: 0.95, limb: 0.8 }, skin: 0x6a7058, skinTile: 'flesh', torso: { c: 0x6a7058, tile: 'flesh' }, sleeve: { len: 0 },
      legs: { c: 0x6a7058, tile: 'flesh' }, boots: { top: 0 }, paws: 0x5a6048, skirt: { c: 0x3a3428, tile: 'wool', len: 0.26, jag: 0.09, flare: 0.04 }, claws: 0x2a2620, eyes: 0xc8d890, eyeGlow: true, noBrows: true,
      hair: { style: 'long', c: 0x2a2a22 }, glow: 0xb0c870 },
    delver_husk: { rig: 'human', h: 1.5, style: 'ghoul', build: { mass: 0.78, arms: 1.15, legs: 0.95, limb: 0.85 }, skin: 0x9a9488, skinTile: 'flesh', torso: { c: 0x5a5048, tile: 'cloth' }, sleeve: { c: 0x5a5048, tile: 'cloth', len: 0.4 },
      legs: { c: 0x4a4440, tile: 'cloth' }, boots: { c: 0x3a3028, top: 0.4 }, skirt: { c: 0x5a5048, tile: 'cloth', len: 0.18, jag: 0.06 }, eyes: 0xa8c8d8, eyeGlow: true, noBrows: true,
      helm: { style: 'candle', c: 0x4a3a2a }, props: [{ t: 'pick', hand: 'r' }], glow: 0x9ac8e0 },
    slag_ghoul: { rig: 'human', h: 1.5, style: 'ghoul', build: { mass: 0.8, arms: 1.22, legs: 0.92, limb: 0.85 }, skin: 0x2a2220, skinTile: 'stone', torso: { c: 0x2a2220, tile: 'stone', glow: [0, 1] }, sleeve: { len: 0 }, armGlow: [0, 0.8],
      legs: { c: 0x2a2220, tile: 'stone', glow: [0, 0.8] }, boots: { top: 0 }, paws: 0x2a2220, claws: 0x1a1410, eyes: 0xffa040, eyeGlow: true, noBrows: true, noEars: true, glow: 0xffa040, glow2: 0xff5a14, glow2I: 1.2 },
    thornback_troll: { rig: 'human', h: 3.0, style: 'brute', build: { sh: 1.55, mass: 1.9, legs: 0.8, arms: 1.25, head: 0.72, belly: 1.25, neck: 0.5, hip: 1.2, limb: 1.1 }, skin: 0x5a6248, skinTile: 'stone', torso: { c: 0x5a6248, tile: 'stone' }, sleeve: { len: 0 },
      legs: { c: 0x5a6248, tile: 'stone' }, boots: { top: 0 }, paws: 0x4a5040, skirt: { c: 0x4a3a28, tile: 'fur', len: 0.32, jag: 0.1, flare: 0.08 }, claws: 0x2a2620, eyes: 0xd8c050, eyeGlow: true, noBrows: true, handScale: 1.4, footScale: 1.3,
      extras: [{ t: 'spines', c: 0x6a5a40, n: 11 }], props: [{ t: 'treeclub', hand: 'r', scale: 1.15, wood: 0x4a3a2a }], glow: 0xd8c050 },
    slatehide_troll: { rig: 'human', h: 3.0, style: 'brute', build: { sh: 1.6, mass: 1.95, legs: 0.8, arms: 1.25, head: 0.72, belly: 1.2, neck: 0.5, hip: 1.2, limb: 1.1 }, skin: 0x5a5e66, skinTile: 'stone', torso: { c: 0x5a5e66, tile: 'stone' }, sleeve: { len: 0 },
      legs: { c: 0x5a5e66, tile: 'stone' }, boots: { top: 0 }, paws: 0x4a4e56, skirt: { c: 0x3a3a3a, tile: 'fur', len: 0.3, jag: 0.1 }, claws: 0x2a2a2a, eyes: 0xa8c8e8, eyeGlow: true, noBrows: true, handScale: 1.45, footScale: 1.3,
      extras: [{ t: 'spines', c: 0x6a6e76, n: 9, plates: true }], props: [{ t: 'treeclub', hand: 'r', scale: 1.1, wood: 0x5a5a5a }], glow: 0xa8c8e8 },
    kiln_troll: { rig: 'human', h: 3.0, style: 'brute', build: { sh: 1.6, mass: 1.95, legs: 0.8, arms: 1.25, head: 0.72, belly: 1.3, neck: 0.5, hip: 1.2, limb: 1.1 }, skin: 0x2e2622, skinTile: 'stone', torso: { c: 0x2e2622, tile: 'stone', glow: [0, 1] }, sleeve: { len: 0 }, armGlow: [0, 0.8],
      legs: { c: 0x2e2622, tile: 'stone', glow: [0, 0.7] }, boots: { top: 0 }, paws: 0x2a2220, skirt: { c: 0x2a2018, tile: 'leather', len: 0.3, jag: 0.08 }, claws: 0x1a1410, eyes: 0xffa040, eyeGlow: true, noBrows: true, handScale: 1.45, footScale: 1.3,
      extras: [{ t: 'spines', c: 0x3a2e28, n: 9, plates: true, glow: [0, 1] }], props: [{ t: 'maul', hand: 'r', scale: 1.1, c: 0x3a3030, wood: 0x2a2018 }], glow: 0xffa040, glow2: 0xff5a14, glow2I: 1.1 },
    delver_sentinel: { rig: 'human', h: 2.4, style: 'construct', build: { sh: 1.35, mass: 1.5, head: 0.85, arms: 1.1, block: true, neck: 0.4, limb: 1.15 }, skin: 0x6a6860, skinTile: 'stone', torso: { c: 0x6a6860, tile: 'stone' }, sleeve: { len: 0 },
      armSkin: 0x6a6860, cuff: { c: 0x8a6a3a, tile: 'bronze', from: 0.5, to: 0.95 }, legs: { c: 0x6a6860, tile: 'stone' }, boots: { c: 0x8a6a3a, tile: 'bronze', top: 0.6 }, handScale: 1.7, footScale: 1.4, noBrows: true,
      pauldrons: { c: 0x8a6a3a, tile: 'bronze', scale: 1.3 }, helm: { style: 'block', c: 0x6a6860, rim: 0x8a6a3a }, extras: [{ t: 'runes' }], glow: 0x7ae0d0, glow2: 0x5ad0c0, glow2I: 1.2 },
    last_warden: { rig: 'human', h: 2.4, style: 'construct', build: { sh: 1.4, mass: 1.55, head: 0.85, arms: 1.12, block: true, neck: 0.4, limb: 1.15 }, skin: 0x5a6068, skinTile: 'stone', torso: { c: 0x5a6068, tile: 'stone' }, sleeve: { len: 0 },
      armSkin: 0x5a6068, cuff: { c: 0x9a7a40, tile: 'bronze', from: 0.45, to: 0.95 }, legs: { c: 0x5a6068, tile: 'stone' }, boots: { c: 0x9a7a40, tile: 'bronze', top: 0.6 }, handScale: 1.6, footScale: 1.4, noBrows: true,
      pauldrons: { c: 0x9a7a40, tile: 'bronze', scale: 1.4, rim: 0x6a5030 }, helm: { style: 'block', c: 0x5a6068, rim: 0x9a7a40, crown: true }, extras: [{ t: 'runes' }],
      cloak: { c: 0x2a3a40, tile: 'wool', len: 1.2, width: PI * 0.55, collar: false, jag: 0.08 },
      props: [{ t: 'warhammer', hand: 'r', c: 0x6a6a68, tile: 'stone', band: 0x9a7a40, len: 1.35, scale: 1.1 }], glow: 0x8ad0ff, glow2: 0x5ab0e0, glow2I: 1.3 },
    hollow_huntsman: { rig: 'human', h: 2.0, style: 'float', build: { mass: 0.82, arms: 1.12, sh: 1.05 }, skin: 0x101418, torso: { c: 0x2a3034, tile: 'wool' }, sleeve: { c: 0x2a3034, tile: 'wool', len: 1, puff: 0.3 },
      noLegs: true, skirt: { c: 0x2a3034, tile: 'wool', len: 1.05, flare: 0.2, jag: 0.16, inner: 0x0a0c0e }, cloak: { c: 0x3a4044, tile: 'fur', len: 1.0, hood: 'up', jag: 0.14, hoodC: 0x2a3034, width: PI * 0.7 },
      handC: 0x2a2e30, claws: 0x9ab0c0, eyes: 0x9ad8ff, eyeGlow: true, noBrows: true, noNose: true, noEars: true, extras: [{ t: 'antlers', c: 0xd0ccc0 }],
      props: [{ t: 'spear', hand: 'r', len: 1.5, c: 0xb8d8e8, glow: [0, 1] }, { t: 'horn', c: 0xc8c0a8 }], glow: 0x9ad8ff, glow2: 0x9ad8ff, glow2I: 0.8, rim: 0x203848 },
    smoke_wraith: { rig: 'human', h: 2.0, style: 'float', build: { mass: 0.78, arms: 1.15 }, skin: 0x0a0806, torso: { c: 0x2a2624, tile: 'wool' }, sleeve: { c: 0x2a2624, tile: 'wool', len: 1, puff: 0.35 },
      noLegs: true, skirt: { c: 0x2a2624, tile: 'wool', len: 1.05, flare: 0.22, jag: 0.18, inner: 0x0a0806 }, cloak: { c: 0x3a3430, tile: 'wool', len: 0.9, hood: 'up', jag: 0.15 },
      handC: 0x1a1614, claws: 0x3a3430, eyes: 0xff9040, eyeGlow: true, noBrows: true, noNose: true, noEars: true, glow: 0xff8a3a, rim: 0x2a1408 },
    whisperwood_shade: { rig: 'human', h: 1.9, style: 'float', ghost: 0.62, build: { mass: 0.75, arms: 1.1 }, skin: 0x0a0c0a, torso: { c: 0x4a564a, tile: 'wool' }, sleeve: { c: 0x4a564a, tile: 'wool', len: 1, puff: 0.3 },
      noLegs: true, skirt: { c: 0x4a564a, tile: 'wool', len: 1.0, flare: 0.2, jag: 0.2 }, cloak: { c: 0x3a463c, tile: 'wool', len: 0.8, hood: 'up', jag: 0.12 },
      handC: 0x2a302a, claws: 0x5a6a5a, eyes: 0xc8f0b0, eyeGlow: true, noBrows: true, noNose: true, noEars: true, glow: 0xc8f0b0, rim: 0x4a7a5a },
    deep_echo: { rig: 'human', h: 1.9, style: 'float', ghost: 0.58, build: { mass: 0.75, arms: 1.12 }, skin: 0x06080c, torso: { c: 0x2a3a4a, tile: 'wool' }, sleeve: { c: 0x2a3a4a, tile: 'wool', len: 1, puff: 0.3 },
      noLegs: true, skirt: { c: 0x2a3a4a, tile: 'wool', len: 1.0, flare: 0.22, jag: 0.2 }, cloak: { c: 0x1e2a36, tile: 'wool', len: 0.8, hood: 'up', jag: 0.12 },
      handC: 0x1a2430, claws: 0x5a7a9a, eyes: 0x8ac8ff, eyeGlow: true, noBrows: true, noNose: true, noEars: true, glow: 0x8ac8ff, rim: 0x3a6a9a }
  };
  // per-glyph fallbacks (unknown ids) by act
  const GLYPH_FALLBACK = { bandit: 'hedge_cutthroat', soldier: ['pass_reaver', 'pass_reaver', 'ashguard_spear'], cultist: ['ember_pilgrim', 'ash_acolyte', 'ash_acolyte'], priest: 'kiln_priest',
    herald: 'march_herald', ghoul: ['mire_ghoul', 'delver_husk', 'slag_ghoul'], troll: ['thornback_troll', 'slatehide_troll', 'kiln_troll'], sentinel: 'delver_sentinel',
    wraith: ['hollow_huntsman', 'smoke_wraith', 'smoke_wraith'], shade: ['whisperwood_shade', 'deep_echo', 'deep_echo'] };
  // non-human looks
  const BEAST_LOOK = {
    ash_hound: { rig: 'quad', h: 1.0, kind: 'hound', c: 0x4a4644, belly: 0x6a6460, tile: 'fur', eyes: 0xff8a3a, glow: 0xff7b2e, glow2: 0xff5a1a, glow2I: 0.35, cracks: true },
    cinder_hound: { rig: 'quad', h: 1.0, kind: 'hound', c: 0x2a2220, belly: 0x3a2e28, tile: 'stone', eyes: 0xffa040, glow: 0xffa040, glow2: 0xff5a14, glow2I: 1.3, cracks: true },
    greyspire_wolf: { rig: 'quad', h: 1.3, kind: 'wolf', c: 0x8a8a88, belly: 0xc8c4bc, tile: 'fur', eyes: 0xd8e0b0, glow: 0xd8e8c0, mane: true },
    whisperwood_weaver: { rig: 'spider', h: 0.9, c: 0x2e2620, mark: 0xb0a890, eyes: 0x9ae070, glow: 0x9ae070 },
    fen_lurker: { rig: 'serpent', h: 1.6, kind: 'lurker', c: 0x3e4a38, belly: 0x8a8a68, spots: 0x9ae0b0, glow: 0x9ae0b0, eyes: 0xd8f0a0 },
    cistern_lurker: { rig: 'serpent', h: 1.6, kind: 'lurker', c: 0x4a5660, belly: 0x9aa0a0, spots: 0x8ad0ff, glow: 0x8ad0ff, eyes: 0xc0e8ff },
    undervault_wyrm: { rig: 'serpent', h: 1.6, kind: 'wyrm', c: 0x8a8678, belly: 0xb8b0a0, eyes: 0xa8e0ff, glow: 0xa8e0ff, frill: 0x6a5a6a },
    cinderworm: { rig: 'serpent', h: 1.6, kind: 'wyrm', c: 0x2a2220, belly: 0x3a2a24, eyes: 0xffa040, glow: 0xffa040, glow2: 0xff5a14, glow2I: 1.3, cracks: true },
    marsh_midges: { rig: 'swarm', kind: 'midge', c: 0x141410, n: 130 },
    blindwing_swarm: { rig: 'swarm', kind: 'bat', c: 0x1e1a1a, n: 22 },
    ember_moths: { rig: 'swarm', kind: 'moth', c: 0xffa050, n: 34, glow: 0xff9a40 }
  };
  const BEAST_FALLBACK = { hound: ['ash_hound', 'ash_hound', 'cinder_hound'], beast: 'greyspire_wolf', spider: 'whisperwood_weaver', lurker: ['fen_lurker', 'cistern_lurker', 'cistern_lurker'],
    wyrm: ['undervault_wyrm', 'undervault_wyrm', 'cinderworm'], swarm: ['marsh_midges', 'blindwing_swarm', 'ember_moths'] };
  function pickFallback(tbl, glyph, act) { const f = tbl[glyph]; if (!f) return null; return Array.isArray(f) ? f[clamp(act - 1, 0, 2)] : f; }
  function lookFor(u) {
    if (u.side === 'party' || u.kind === 'hero' || u.kind === 'display') return { key: 'hero:' + u.id, look: HERO_LOOK[u.id] || HERO_LOOK.rook };
    const act = ACT_OF(u);
    if (FOE_LOOK[u.id]) return { key: 'foe:' + u.id, look: FOE_LOOK[u.id] };
    if (BEAST_LOOK[u.id]) return { key: 'foe:' + u.id, look: BEAST_LOOK[u.id] };
    const f1 = pickFallback(GLYPH_FALLBACK, u.glyph, act); if (f1) return { key: 'foe:' + f1, look: FOE_LOOK[f1] };
    const f2 = pickFallback(BEAST_FALLBACK, u.glyph, act); if (f2) return { key: 'foe:' + f2, look: BEAST_LOOK[f2] };
    return { key: 'foe:hedge_cutthroat', look: FOE_LOOK.hedge_cutthroat };
  }

  // =====================================================================================================
  // 6. NON-HUMAN RIGS
  // =====================================================================================================
  function buildQuad(L) {
    const B = new Builder(), k = L.h / 1.0, wolf = L.kind === 'wolf';
    const c = col(L.c), bel = col(L.belly || L.c);
    const sh = 0.66 * k, hp = 0.62 * k;
    B.bone('root', null, 0, 0, 0);
    B.bone('pelvis', 'root', 0, hp, -0.36 * k);
    boneW(B, 'spine', 'pelvis', vv(0, hp + 0.02 * k, -0.04 * k));
    boneW(B, 'chest', 'spine', vv(0, sh, 0.26 * k));
    boneW(B, 'neck', 'chest', vv(0, sh + 0.06 * k, 0.4 * k));
    boneW(B, 'head', 'neck', vv(0, sh + 0.2 * k, 0.55 * k));
    boneW(B, 'jaw', 'head', vv(0, sh + 0.16 * k, 0.6 * k));
    boneW(B, 'tail0', 'pelvis', vv(0, hp + 0.04 * k, -0.5 * k));
    boneW(B, 'tail1', 'tail0', vv(0, hp - 0.04 * k, -0.68 * k));
    boneW(B, 'tail2', 'tail1', vv(0, hp - 0.14 * k, -0.84 * k));
    const legs = [];
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) {
      boneW(B, 'fu_' + sd, 'chest', vv(s * 0.1 * k, sh - 0.1 * k, 0.3 * k));
      boneW(B, 'fl_' + sd, 'fu_' + sd, vv(s * 0.1 * k, 0.36 * k, 0.27 * k));
      boneW(B, 'fp_' + sd, 'fl_' + sd, vv(s * 0.1 * k, 0.09 * k, 0.3 * k));
      boneW(B, 'bu_' + sd, 'pelvis', vv(s * 0.1 * k, hp - 0.04 * k, -0.4 * k));
      boneW(B, 'bl_' + sd, 'bu_' + sd, vv(s * 0.1 * k, 0.36 * k, -0.3 * k));
      boneW(B, 'bh_' + sd, 'bl_' + sd, vv(s * 0.1 * k, 0.15 * k, -0.45 * k));
      legs.push(sd);
    }
    // body tube along the spine (fwd = up so "front" radius = top, "back" radius = belly)
    const fur = L.tile || 'fur';
    const paint = (p, n, out) => { out.copy(c).lerp(bel, sstep(0.2, -0.7, n.y) * 0.8); out.multiplyScalar(0.9 + 0.1 * Math.sin(p.z * 23 + p.x * 9)); return out; };
    const crackG = L.cracks ? (p) => [0, Math.max(0, Math.sin(p.x * 41 + p.z * 17) * Math.sin(p.y * 37 - p.z * 23) - 0.55) * 2.2] : null;
    const bw = chainW([{ p: vv(0, hp, -0.6 * k), bone: 'pelvis' }, { p: vv(0, hp, -0.04 * k), bone: 'spine' }, { p: vv(0, sh, 0.26 * k), bone: 'chest' }, { p: vv(0, sh + 0.06 * k, 0.42 * k), bone: 'neck' }, { p: vv(0, sh + 0.2 * k, 0.56 * k), bone: 'head' }], 0.1 * k);
    const mk = wolf ? 1.3 : 1.08;
    const body = [[-0.56, hp + 0.0, 0.05, 0.05, 0.05], [-0.48, hp + 0.0, 0.115, 0.09, 0.12], [-0.34, hp + 0.0, 0.13, 0.1, 0.13], [-0.16, hp + 0.01, 0.11, 0.09, 0.1], [0.04, hp + 0.0, 0.125, 0.1, 0.16],
      [0.2, sh - 0.01, 0.145, 0.11, 0.21], [0.32, sh + 0.0, 0.14, 0.115, 0.19], [0.42, sh + 0.06, 0.115, 0.11, 0.13], [0.5, sh + 0.14, 0.088, 0.09, 0.095], [0.56, sh + 0.21, 0.075, 0.075, 0.075]];
    tube(B, body.map(([z, y, w, up, dn]) => ({ p: vv(0, y, z * k), rw: w * k * mk, rf: up * k * mk, rb: dn * k * mk })), { seg: 14, c: paint, tile: fur, w: bw, cap0: true, fwd: vv(0, 1, 0), glow: crackG, uScale: 1.5 });
    if (L.mane || wolf) {
      const g = new T.TorusGeometry(1, 0.55, 8, 16); const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i); const n = 1 + 0.25 * noise3(x * 3, y * 3, z * 3); pa.setXYZ(i, x * n, y * n, z * n); }
      g.computeVertexNormals();
      B.add(g, M(0, sh + 0.09 * k, 0.42 * k, PI / 2 - 0.9, 0, 0, 0.15 * k, 0.15 * k, 0.13 * k), { c: (p, n, out) => paint(p, n, out).multiplyScalar(1.15), tile: 'fur', w: [['neck', 0.6], ['chest', 0.4]], uv: [4, 2] });
    }
    // head: skull + tapered muzzle + jaw + ears + eyes + teeth
    const hc = vv(0, sh + 0.22 * k, 0.6 * k);
    sphere(B, hc, 0.078 * k * mk, 0.072 * k * mk, 0.095 * k * mk, { c: paint, tile: fur, w: 'head', glow: crackG });
    tube(B, [{ p: hc.clone().add(vv(0, -0.005 * k, 0.05 * k)), rw: 0.055 * k * mk, rf: 0.05 * k * mk, rb: 0.035 * k }, { p: hc.clone().add(vv(0, -0.015 * k, 0.14 * k)), rw: 0.038 * k * mk, rf: 0.035 * k * mk, rb: 0.022 * k }, { p: hc.clone().add(vv(0, -0.02 * k, 0.2 * k)), rw: 0.026 * k, rf: 0.026 * k, rb: 0.015 * k }],
      { seg: 10, c: paint, tile: fur, w: 'head', cap1: true, fwd: vv(0, 1, 0), glow: crackG });
    sphere(B, hc.clone().add(vv(0, -0.008 * k, 0.215 * k)), 0.017 * k, 0.014 * k, 0.012 * k, { c: 0x141010, tile: 'flesh', w: 'head', ws: 8, hs: 6 });
    tube(B, [{ p: hc.clone().add(vv(0, -0.045 * k, 0.04 * k)), rw: 0.04 * k, rf: 0.012 * k, rb: 0.016 * k }, { p: hc.clone().add(vv(0, -0.05 * k, 0.18 * k)), rw: 0.022 * k, rf: 0.01 * k, rb: 0.01 * k }], { seg: 8, c: paint, tile: fur, w: 'jaw', cap1: true, fwd: vv(0, 1, 0) });
    for (const s of [1, -1]) {
      for (let i = 0; i < 3; i++) cone(B, hc.clone().add(vv(s * (0.018 - i * 0.004) * k, -0.03 * k, (0.17 - i * 0.03) * k)), hc.clone().add(vv(s * (0.018 - i * 0.004) * k, -0.05 * k, (0.17 - i * 0.03) * k)), 0.005 * k, { c: 0xd8d0b8, tile: 'bone', w: 'head' }, 4);
      sphere(B, hc.clone().add(vv(s * 0.04 * k, 0.018 * k, 0.07 * k)), 0.011 * k, 0.009 * k, 0.008 * k, { c: L.eyes || 0x201810, tile: 'bone', w: 'head', glow: L.glow ? [1, 0] : [0, 0], ws: 8, hs: 6, ao: 0 });
      cone(B, hc.clone().add(vv(s * 0.045 * k, 0.05 * k, -0.01 * k)), hc.clone().add(vv(s * 0.06 * k, 0.14 * k, -0.04 * k)), 0.028 * k, { c: paint, tile: fur, w: 'head' }, 5);
    }
    // legs
    const lp = (sd, names, rads) => {
      const pts = names.map((n) => B.W(n));
      const end = pts[pts.length - 1].clone().add(vv(0, -0.09 * k, 0.02 * k));
      const ch = names.map((n) => ({ p: B.W(n), bone: n })).concat([{ p: end, bone: names[names.length - 1] }]);
      const w = chainW(ch, 0.05 * k);
      const all = pts.concat([end]);
      const tp = all.map((p, i) => ({ p: p.clone().add(vv(0, i === 0 ? 0.05 * k : 0, 0)), rw: rads[i] * k * mk, rf: rads[i] * k * mk * 1.15 }));
      tube(B, tp, { seg: 8, c: paint, tile: fur, w, fwd: vv(0, 0, 1), glow: crackG });
      sphere(B, end.clone().add(vv(0, 0.01 * k, 0.03 * k)), 0.034 * k * mk, 0.022 * k, 0.05 * k * mk, { c: col(L.c).multiplyScalar(0.6), tile: 'leather', w: names[names.length - 1], ws: 8, hs: 6 });
    };
    for (const sd of legs) { lp(sd, ['fu_' + sd, 'fl_' + sd, 'fp_' + sd], [0.065, 0.04, 0.03, 0.026]); lp(sd, ['bu_' + sd, 'bl_' + sd, 'bh_' + sd], [0.085, 0.05, 0.03, 0.026]); }
    // tail
    const tw = chainW([{ p: B.W('tail0'), bone: 'tail0' }, { p: B.W('tail1'), bone: 'tail1' }, { p: B.W('tail2'), bone: 'tail2' }, { p: B.W('tail2').clone().add(vv(0, -0.1 * k, -0.12 * k)), bone: 'tail2' }], 0.06 * k);
    const tr = wolf ? [0.05, 0.07, 0.065, 0.02] : [0.04, 0.045, 0.04, 0.015];
    tube(B, [B.W('tail0'), B.W('tail1'), B.W('tail2'), B.W('tail2').clone().add(vv(0, -0.1 * k, -0.12 * k))].map((p, i) => ({ p, rw: tr[i] * k * mk, rf: tr[i] * k * mk })), { seg: 8, c: paint, tile: fur, w: tw, cap1: true, fwd: vv(0, 1, 0) });
    const so = (n, b, p) => { const w = B.W(b); B.socket(n, b, p.x - w.x, p.y - w.y, p.z - w.z); };
    so('head', 'head', hc); so('mouth', 'jaw', hc.clone().add(vv(0, -0.04 * k, 0.2 * k))); so('chest', 'chest', vv(0, sh - 0.05 * k, 0.25 * k)); so('top', 'head', hc.clone().add(vv(0, 0.2 * k, 0)));
    so('weapon_tip', 'jaw', hc.clone().add(vv(0, -0.04 * k, 0.2 * k))); so('weapon_base', 'head', hc); so('muzzle', 'jaw', hc.clone().add(vv(0, -0.03 * k, 0.2 * k)));
    for (const sd of legs) { so('foot_f' + sd, 'fp_' + sd, B.W('fp_' + sd).clone().add(vv(0, -0.08 * k, 0.02 * k))); so('foot_b' + sd, 'bh_' + sd, B.W('bh_' + sd).clone().add(vv(0, -0.08 * k, 0.02 * k))); }
    so('hand_r', 'fp_r', B.W('fp_r')); so('hand_l', 'fp_l', B.W('fp_l')); so('foot_l', 'bh_l', B.W('bh_l')); so('foot_r', 'bh_r', B.W('bh_r'));
    return { geo: B.build(), bones: B.bones, sockets: B.sockets, h: L.h, rig: 'quad', k };
  }

  function buildSpider(L) {
    const B = new Builder(), k = L.h / 0.9;
    const c = col(L.c), mark = col(L.mark || 0xa09880);
    B.bone('root', null, 0, 0, 0);
    B.bone('body', 'root', 0, 0.42 * k, 0.1 * k);
    boneW(B, 'abdomen', 'body', vv(0, 0.47 * k, -0.12 * k));
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) boneW(B, 'fang_' + sd, 'body', vv(s * 0.05 * k, 0.4 * k, 0.33 * k));
    const legs = [];
    const angs = [0.5, 1.05, 1.75, 2.45];
    for (let i = 0; i < 8; i++) {
      const s = i < 4 ? 1 : -1, a = angs[i % 4] * s;
      const att = vv(Math.sin(a) * 0.14 * k, 0.43 * k, 0.1 * k + Math.cos(a) * 0.12 * k);
      const knee = vv(Math.sin(a) * 0.48 * k, 0.78 * k, 0.1 * k + Math.cos(a) * 0.4 * k);
      const foot = vv(Math.sin(a) * 0.9 * k, 0, 0.1 * k + Math.cos(a) * 0.78 * k);
      boneW(B, 'lega' + i, 'body', att); boneW(B, 'legb' + i, 'lega' + i, knee);
      legs.push({ a, att, knee, foot, L1: att.distanceTo(knee), L2: knee.distanceTo(foot) });
      const w = chainW([{ p: att, bone: 'lega' + i }, { p: knee, bone: 'legb' + i }, { p: foot, bone: 'legb' + i }], 0.04 * k);
      const pts = [att, att.clone().lerp(knee, 0.5), knee, knee.clone().lerp(foot, 0.35), knee.clone().lerp(foot, 0.75), foot].map((p, j) => ({ p, rw: [0.04, 0.034, 0.028, 0.024, 0.016, 0.006][j] * k, rf: [0.04, 0.034, 0.028, 0.024, 0.016, 0.006][j] * k }));
      tube(B, pts, { seg: 6, c: (p, n, o) => o.copy(c).lerp(mark, (Math.sin(p.distanceTo(att) * 40) > 0.6 ? 0.35 : 0)), tile: 'scale', w, cap0: true, fwd: vv(0, 1, 0) });
    }
    // cephalothorax + abdomen with a pale mark
    sphere(B, vv(0, 0.43 * k, 0.12 * k), 0.17 * k, 0.11 * k, 0.2 * k, { c, tile: 'scale', w: 'body' });
    sphere(B, vv(0, 0.47 * k, 0.3 * k), 0.09 * k, 0.08 * k, 0.08 * k, { c, tile: 'scale', w: 'body' });
    sphere(B, vv(0, 0.52 * k, -0.34 * k), 0.27 * k, 0.24 * k, 0.36 * k, { c: (p, n, o) => { o.copy(c); const d = Math.hypot(p.x / k * 3.2, (p.z / k + 0.34) * 1.6); if (n.y > 0.3 && Math.abs(Math.sin(d * 5)) < 0.25 && d < 1.2) o.lerp(mark, 0.75); return o; }, tile: 'fur', w: 'abdomen', ws: 16, hs: 12 });
    for (let i = 0; i < 6; i++) { const ex = ((i % 3) - 1) * 0.03 * k, ey = (0.5 + Math.floor(i / 3) * 0.03) * k; sphere(B, vv(ex, ey, 0.37 * k), 0.012 * k, 0.012 * k, 0.012 * k, { c: L.eyes, tile: 'bone', w: 'body', glow: [1, 0], ws: 6, hs: 5, ao: 0 }); }
    for (const [s, sd] of [[1, 'l'], [-1, 'r']]) cone(B, vv(s * 0.04 * k, 0.4 * k, 0.36 * k), vv(s * 0.02 * k, 0.28 * k, 0.42 * k), 0.025 * k, { c: 0x1a1410, tile: 'bone', w: 'fang_' + sd }, 5);
    const so = (n, b, p) => { const w = B.W(b); B.socket(n, b, p.x - w.x, p.y - w.y, p.z - w.z); };
    so('head', 'body', vv(0, 0.5 * k, 0.32 * k)); so('mouth', 'body', vv(0, 0.36 * k, 0.42 * k)); so('chest', 'body', vv(0, 0.45 * k, 0.1 * k)); so('top', 'abdomen', vv(0, 0.85 * k, -0.3 * k));
    so('weapon_tip', 'body', vv(0, 0.32 * k, 0.45 * k)); so('weapon_base', 'body', vv(0, 0.42 * k, 0.3 * k)); so('muzzle', 'body', vv(0, 0.38 * k, 0.45 * k));
    so('hand_r', 'legb4', legs[4].foot); so('hand_l', 'legb0', legs[0].foot); so('foot_l', 'legb1', legs[1].foot); so('foot_r', 'legb5', legs[5].foot);
    return { geo: B.build(), bones: B.bones, sockets: B.sockets, h: L.h, rig: 'spider', k, legs };
  }

  function buildSerpent(L) {
    const B = new Builder(), k = L.h / 1.6, lurk = L.kind === 'lurker';
    const c = col(L.c), bel = col(L.belly || L.c), spots = L.spots ? col(L.spots) : null;
    B.bone('root', null, 0, 0, 0);
    const N = lurk ? 9 : 12;
    const P = [];
    if (lurk) { for (let i = 0; i < N; i++) P.push(vv(0, (-0.75 + i * 0.27) * k, 0)); }
    else { for (let i = 0; i < N; i++) P.push(vv(0, 0.3 * k, (-2.5 + i * 0.27) * k)); }
    let parent = 'root';
    for (let i = 0; i < N; i++) { boneW(B, 'sp' + i, parent, P[i]); parent = 'sp' + i; }
    const headP = lurk ? P[N - 1].clone().add(vv(0, 0.2 * k, 0.02 * k)) : P[N - 1].clone().add(vv(0, 0, 0.26 * k));
    boneW(B, 'head', 'sp' + (N - 1), headP);
    boneW(B, 'jaw', 'head', headP.clone().add(lurk ? vv(0, -0.02 * k, 0.04 * k) : vv(0, -0.06 * k, 0.04 * k)));
    const chain = P.map((p, i) => ({ p, bone: 'sp' + i })).concat([{ p: headP, bone: 'head' }]);
    const w = chainW(chain, 0.11 * k);
    const pts = [];
    const tot = lurk ? 1 : 1;
    void tot;
    const NR = lurk ? 28 : 46;
    for (let i = 0; i <= NR; i++) {
      const t = i / NR;
      const p = lurk ? vv(0, (-0.95 + t * 2.58) * k, 0) : vv(0, 0.3 * k, (-2.75 + t * 3.5) * k);
      let r = lurk ? (0.21 - t * 0.08) * (1 + 0.06 * Math.sin(t * 40)) : (t < 0.12 ? 0.04 + t / 0.12 * 0.16 : t < 0.7 ? 0.2 + Math.sin((t - 0.12) / 0.58 * PI) * 0.1 : 0.2 - (t - 0.7) * 0.22);
      if (!lurk) r *= 1 + 0.07 * Math.abs(Math.sin(t * 34));
      pts.push({ p, rw: r * k, rf: r * k * (lurk ? 0.9 : 0.85), rb: r * k * 0.8 });
    }
    const fwd = lurk ? vv(0, 0, 1) : vv(0, 1, 0);
    const paint = (p, n, out) => {
      const up = lurk ? n.z : n.y;
      out.copy(c).lerp(bel, sstep(0.1, -0.7, up) * 0.85);
      if (spots && Math.sin(p.x * 60) * Math.sin(p.y * 47 + p.z * 31) > 0.82) out.lerp(spots, 0.6);
      if (!lurk) { const t = (p.z / k + 2.75) / 3.5; if (Math.abs(Math.sin(t * 34)) < 0.18) out.multiplyScalar(0.55); }
      return out;
    };
    const gl = (p) => { let g2 = 0; if (L.cracks && !lurk) { const t = (p.z / k + 2.75) / 3.5; g2 = Math.abs(Math.sin(t * 34)) < 0.16 ? 1 : 0; } const sp = spots && Math.sin(p.x * 60) * Math.sin(p.y * 47 + p.z * 31) > 0.86 ? 0.6 : 0; return [sp, g2]; };
    tube(B, pts, { seg: 14, c: paint, tile: 'scale', w, cap0: true, fwd, glow: gl, uScale: 2 });
    // head
    const hd = lurk ? vv(0, 0, 1) : vv(0, 0, 1);
    const hc = headP.clone().add(hd.clone().multiplyScalar(0.1 * k));
    sphere(B, hc, 0.12 * k, (lurk ? 0.09 : 0.1) * k, 0.2 * k, { c: paint, tile: 'scale', w: 'head', glow: gl });
    sphere(B, hc.clone().add(vv(0, -0.06 * k, 0.04 * k)), 0.1 * k, 0.035 * k, 0.17 * k, { c: bel, tile: 'scale', w: 'jaw' });
    for (const s of [1, -1]) {
      sphere(B, hc.clone().add(vv(s * 0.085 * k, 0.04 * k, 0.07 * k)), 0.022 * k, 0.018 * k, 0.02 * k, { c: L.eyes, tile: 'bone', w: 'head', glow: [1, 0], ws: 8, hs: 6, ao: 0 });
      for (let i = 0; i < 4; i++) cone(B, hc.clone().add(vv(s * (0.06 - i * 0.008) * k, -0.04 * k, (0.16 - i * 0.04) * k)), hc.clone().add(vv(s * (0.06 - i * 0.008) * k, -0.08 * k, (0.16 - i * 0.04) * k)), 0.008 * k, { c: 0xe0d8c0, tile: 'bone', w: 'head' }, 4);
      if (!lurk) {
        cone(B, hc.clone().add(vv(s * 0.07 * k, 0.07 * k, -0.06 * k)), hc.clone().add(vv(s * 0.16 * k, 0.16 * k, -0.28 * k)), 0.03 * k, { c: 0xc8c0a8, tile: 'bone', w: 'head' }, 6);
        if (L.frill) rbox(B, hc.clone().add(vv(s * 0.14 * k, 0.02 * k, -0.12 * k)), 0.012 * k, 0.16 * k, 0.12 * k, { c: L.frill, tile: 'flesh', w: 'head' }, [0, s * 0.5, s * 0.6], 0.2);
      } else {
        rbox(B, hc.clone().add(vv(s * 0.1 * k, 0, -0.1 * k)), 0.01 * k, 0.12 * k, 0.1 * k, { c: col(L.c).multiplyScalar(0.8), tile: 'flesh', w: 'head', glow: [0.3, 0] }, [0, s * 0.6, 0], 0.2);
      }
    }
    // dorsal fin / ridge
    for (let i = 1; i < N; i++) {
      const p0 = P[i];
      const up = lurk ? vv(0, 0, -1) : vv(0, 1, 0);
      const r = lurk ? 0.14 * k : (0.22 + 0.06 * Math.sin(i / N * PI)) * k;
      cone(B, p0.clone().addScaledVector(up, r * 0.8), p0.clone().addScaledVector(up, r + (lurk ? 0.06 : 0.1) * k).add(lurk ? vv(0, -0.06 * k, 0) : vv(0, 0, -0.08 * k)), 0.04 * k, { c: col(L.c).multiplyScalar(0.7), tile: 'bone', w: 'sp' + i, glow: L.cracks ? [0, 0.6] : [0, 0] }, 4);
    }
    const so = (n, b, p) => { const ww = B.W(b); B.socket(n, b, p.x - ww.x, p.y - ww.y, p.z - ww.z); };
    so('head', 'head', hc); so('mouth', 'jaw', hc.clone().add(vv(0, -0.04 * k, 0.2 * k))); so('chest', 'sp' + (N - 3), P[N - 3]); so('top', 'head', hc.clone().add(vv(0, 0.3 * k, 0)));
    so('weapon_tip', 'jaw', hc.clone().add(vv(0, -0.04 * k, 0.22 * k))); so('weapon_base', 'head', hc); so('muzzle', 'jaw', hc.clone().add(vv(0, -0.02 * k, 0.24 * k)));
    so('hand_r', 'head', hc); so('hand_l', 'head', hc); so('foot_l', 'sp0', P[0]); so('foot_r', 'sp0', P[0]);
    return { geo: B.build(), bones: B.bones, sockets: B.sockets, h: L.h, rig: 'serpent', lurk, k, N };
  }

  // swarm: an InstancedMesh of tiny winged bodies flapping in the vertex shader (one draw call per swarm)
  const swarmGeo = {};
  function swarmGeometry(kind) {
    if (swarmGeo[kind]) return swarmGeo[kind];
    const s = kind === 'bat' ? 0.16 : kind === 'moth' ? 0.07 : 0.03;
    const pos = [], idx = [];
    // body (thin diamond) + two wings (triangles); wing vertices have |x| > body
    const v = (x, y, z) => { pos.push(x * s, y * s, z * s); return pos.length / 3 - 1; };
    const b0 = v(0, 0, 0.6), b1 = v(0.12, 0, 0), b2 = v(0, 0, -0.6), b3 = v(-0.12, 0, 0), bt = v(0, 0.12, 0);
    idx.push(b0, b1, bt, b1, b2, bt, b2, b3, bt, b3, b0, bt);
    for (const sx of [1, -1]) {
      const r0 = v(0.1 * sx, 0, 0.3), r1 = v(1.0 * sx, 0.05, kind === 'bat' ? 0.1 : 0.25), r2 = v(0.85 * sx, 0, -0.45), r3 = v(0.1 * sx, 0, -0.3);
      if (sx > 0) idx.push(r0, r1, r2, r0, r2, r3); else idx.push(r0, r2, r1, r0, r3, r2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.userData.shared = true;
    swarmGeo[kind] = g;
    return g;
  }
  function swarmMaterial(L) {
    const glow = !!L.glow;
    const m = new T.MeshStandardMaterial({ color: col(L.c), roughness: 0.8, metalness: 0, side: T.DoubleSide, emissive: glow ? col(L.glow) : col(0), emissiveIntensity: glow ? 1.6 : 0 });
    const flap = L.kind === 'bat' ? 14 : L.kind === 'moth' ? 22 : 60;
    m.userData.uT = { value: 0 };
    m.onBeforeCompile = function (sh) {
      sh.uniforms.uSwarmT = this.userData.uT;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uSwarmT;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ float ph = uSwarmT * ' + flap.toFixed(1) + ' + float(gl_InstanceID) * 1.731; float ax = abs(transformed.x); transformed.y += sin(ph) * ax * 0.9; transformed.x *= 0.75 + 0.25 * cos(ph); }');
    };
    m.customProgramCacheKey = () => 'abSwarm' + flap;
    return m;
  }

  // =====================================================================================================
  // 7. ANIMATION CORE: clips in impact-normalised time tau (0 start, 1 impact, 2 end). Keys: [tau, {bone: [x, y, z],
  //    $p: [x, y, z] root offset (template metres), $r: [x, y, z] root rotation}]. Bones a clip names are "owned" by it;
  //    others keep the base (locomotion) pose. full: legs too even while moving.
  // =====================================================================================================
  const RP = -1, RR = -2;   // pseudo bone indices for root position / rotation
  function compileClip(def, ix) {
    const tracks = new Map();
    for (const [tau, pose] of def.keys) {
      for (const name in pose) {
        const i = name === '$p' ? RP : name === '$r' ? RR : ix[name];
        if (i == null) continue;
        let tr = tracks.get(i); if (!tr) { tr = { i, t: [], v: [], leg: /thigh|shin|foot/.test(name) || i === RP }; tracks.set(i, tr); }
        tr.t.push(tau); tr.v.push(pose[name]);
      }
    }
    return { def, tracks: Array.from(tracks.values()), full: !!def.full, dur: def.dur || 0.45, name: def.name };
  }
  function evalTrack(tr, tau, out) {
    const t = tr.t, n = t.length;
    if (tau <= t[0] || n === 1) { const v = tr.v[0]; out[0] = v[0]; out[1] = v[1] || 0; out[2] = v[2] || 0; return; }
    if (tau >= t[n - 1]) { const v = tr.v[n - 1]; out[0] = v[0]; out[1] = v[1] || 0; out[2] = v[2] || 0; return; }
    let j = 0; while (j < n - 2 && tau > t[j + 1]) j++;
    const a = tr.v[j], b = tr.v[j + 1];
    let u = (tau - t[j]) / (t[j + 1] - t[j]);
    u = u * u * (3 - 2 * u);
    out[0] = a[0] + (b[0] - a[0]) * u; out[1] = (a[1] || 0) + ((b[1] || 0) - (a[1] || 0)) * u; out[2] = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * u;
  }
  const _tv = [0, 0, 0];
  // blend a clip into pose arrays (rot: Float32Array nb*3, root: {p: [3], r: [3]}) with weight w
  function applyClip(cl, tau, w, moving, rot, rp, rr) {
    for (const tr of cl.tracks) {
      if (moving && tr.leg && !cl.full) continue;
      evalTrack(tr, tau, _tv);
      if (tr.i === RP) { rp[0] += (_tv[0] - rp[0]) * w; rp[1] += (_tv[1] - rp[1]) * w; rp[2] += (_tv[2] - rp[2]) * w; continue; }
      if (tr.i === RR) { _tv[1] = U.wrapAngle(_tv[1]); rr[0] += (_tv[0] - rr[0]) * w; rr[1] += (_tv[1] - rr[1]) * w; rr[2] += (_tv[2] - rr[2]) * w; continue; }
      const o = tr.i * 3;
      rot[o] += (_tv[0] - rot[o]) * w; rot[o + 1] += (_tv[1] - rot[o + 1]) * w; rot[o + 2] += (_tv[2] - rot[o + 2]) * w;
    }
  }
  // mirror a clip definition left <-> right (negate Y and Z rotations, root X position and Y/Z rotation)
  function mirrorDef(def) {
    const keys = def.keys.map(([t, p]) => {
      const q = {};
      for (const n in p) {
        const v = p[n];
        const m = n.endsWith('_l') ? n.slice(0, -2) + '_r' : n.endsWith('_r') ? n.slice(0, -2) + '_l' : n;
        if (n === '$p') q[m] = [-v[0], v[1] || 0, v[2] || 0];
        else q[m] = [v[0], -(v[1] || 0), -(v[2] || 0)];
      }
      return [t, q];
    });
    return Object.assign({}, def, { keys, name: def.name + '_m' });
  }

  // ---- HUMAN CLIPS (right-handed unless noted). Arm X- raises forward; right arm Z- abducts outward.
  const HC = {
    slash: { keys: [
      [0.55, { chest: [0.06, -0.7, 0.05], spine: [0.05, -0.3, 0], head: [0, 0.5, 0], upperarm_r: [-0.7, 0.5, -1.35], forearm_r: [-1.4, 0, 0], hand_r: [-0.2, 0.5, 0.2], upperarm_l: [-0.45, 0, 0.35], forearm_l: [-0.9, 0, 0],
        thigh_l: [-0.35, 0, 0.1], shin_l: [0.35, 0, 0], thigh_r: [0.2, 0, -0.12], shin_r: [0.4, 0, 0], foot_l: [0.0, 0, 0], $r: [0, -0.2, 0], $p: [0, -0.04, -0.02] }],
      [1.0, { chest: [0.16, 0.5, 0], spine: [0.1, 0.25, 0], head: [0, -0.35, 0], upperarm_r: [-1.45, -0.2, -0.35], forearm_r: [-0.25, 0, 0], hand_r: [1.15, -0.3, 0], upperarm_l: [-0.15, 0, 0.6], forearm_l: [-0.5, 0, 0],
        thigh_l: [-0.6, 0, 0.1], shin_l: [0.55, 0, 0], thigh_r: [0.35, 0, -0.1], shin_r: [0.25, 0, 0], $r: [0, 0.22, 0], $p: [0, -0.09, 0.14] }],
      [1.3, { chest: [0.2, 0.85, 0], spine: [0.12, 0.35, 0], upperarm_r: [-1.1, -0.5, 0.35], forearm_r: [-0.55, 0, 0], hand_r: [1.2, -0.5, 0], $r: [0, 0.3, 0] }],
      [2.0, { chest: [0.08, 0.2, 0], spine: [0.05, 0.1, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-0.9, 0, 0], hand_r: [0.2, 0, 0], upperarm_l: [-0.2, 0, 0.3], forearm_l: [-0.6, 0, 0], head: [0, 0, 0],
        thigh_l: [-0.25, 0, 0.08], shin_l: [0.35, 0, 0], thigh_r: [0.1, 0, -0.08], shin_r: [0.35, 0, 0], $r: [0, 0.05, 0], $p: [0, -0.04, 0.05] }]] },
    backslash: { keys: [
      [0.55, { chest: [0.08, 0.8, 0], spine: [0.05, 0.3, 0], head: [0, -0.4, 0], upperarm_r: [-1.2, -0.6, 0.5], forearm_r: [-1.5, 0, 0], hand_r: [0.0, -0.8, 0], upperarm_l: [-0.3, 0, 0.5], forearm_l: [-0.7, 0, 0],
        thigh_l: [-0.3, 0, 0.1], shin_l: [0.4, 0, 0], thigh_r: [0.15, 0, -0.1], shin_r: [0.35, 0, 0], $r: [0, 0.25, 0], $p: [0, -0.05, 0] }],
      [1.0, { chest: [0.14, -0.45, 0], spine: [0.08, -0.2, 0], head: [0, 0.3, 0], upperarm_r: [-1.5, 0.2, -0.9], forearm_r: [-0.2, 0, 0], hand_r: [1.1, 0.3, 0], upperarm_l: [-0.1, 0, 0.5],
        thigh_l: [-0.5, 0, 0.12], shin_l: [0.5, 0, 0], thigh_r: [0.3, 0, -0.12], shin_r: [0.3, 0, 0], $r: [0, -0.25, 0], $p: [0, -0.08, 0.12] }],
      [1.3, { chest: [0.15, -0.75, 0], upperarm_r: [-1.0, 0.4, -1.2], forearm_r: [-0.4, 0, 0], hand_r: [1.1, 0.5, 0], $r: [0, -0.32, 0] }],
      [2.0, { chest: [0.06, -0.1, 0], spine: [0.04, 0, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-0.9, 0, 0], hand_r: [0.2, 0, 0], head: [0, 0, 0], thigh_l: [-0.25, 0, 0.08], shin_l: [0.35, 0, 0], thigh_r: [0.1, 0, -0.08], shin_r: [0.35, 0, 0], $r: [0, 0, 0], $p: [0, -0.04, 0.04] }]] },
    overhead: { keys: [
      [0.6, { chest: [-0.28, -0.2, 0], spine: [-0.15, -0.1, 0], head: [-0.2, 0.15, 0], upperarm_r: [-2.75, 0, -0.25], forearm_r: [-1.3, 0, 0], hand_r: [-0.4, 0, 0], upperarm_l: [-2.4, 0, 0.3], forearm_l: [-1.2, 0, 0],
        thigh_l: [-0.4, 0, 0.12], shin_l: [0.3, 0, 0], thigh_r: [0.25, 0, -0.1], shin_r: [0.3, 0, 0], $p: [0, 0.02, -0.04] }],
      [1.0, { chest: [0.5, 0.1, 0], spine: [0.3, 0.05, 0], head: [0.15, 0, 0], upperarm_r: [-1.05, 0, -0.2], forearm_r: [-0.1, 0, 0], hand_r: [1.45, 0, 0], upperarm_l: [-1.0, 0, 0.3], forearm_l: [-0.4, 0, 0],
        thigh_l: [-0.7, 0, 0.12], shin_l: [0.7, 0, 0], thigh_r: [0.4, 0, -0.1], shin_r: [0.35, 0, 0], foot_l: [0.0, 0, 0], $p: [0, -0.16, 0.16] }],
      [1.35, { chest: [0.55, 0.1, 0], spine: [0.3, 0, 0], upperarm_r: [-0.8, 0, -0.2], forearm_r: [-0.1, 0, 0], hand_r: [1.55, 0, 0] }],
      [2.0, { chest: [0.1, 0, 0], spine: [0.05, 0, 0], head: [0, 0, 0], upperarm_r: [-0.5, 0, -0.25], forearm_r: [-1.0, 0, 0], hand_r: [0.1, 0, 0], upperarm_l: [-0.3, 0, 0.3], forearm_l: [-0.8, 0, 0],
        thigh_l: [-0.25, 0, 0.08], shin_l: [0.35, 0, 0], thigh_r: [0.1, 0, -0.08], shin_r: [0.35, 0, 0], $p: [0, -0.04, 0.04] }]] },
    thrust: { keys: [
      [0.6, { chest: [0.0, -0.55, 0], spine: [-0.05, -0.25, 0], head: [0, 0.45, 0], upperarm_r: [-0.4, 0, -0.35], forearm_r: [-1.9, 0, 0], hand_r: [1.1, 0, 0], upperarm_l: [-0.9, 0, 0.3], forearm_l: [-0.7, 0, 0],
        thigh_l: [-0.3, 0, 0.1], shin_l: [0.5, 0, 0], thigh_r: [0.3, 0, -0.1], shin_r: [0.55, 0, 0], $r: [0, -0.3, 0], $p: [0, -0.08, -0.08] }],
      [1.0, { chest: [0.2, 0.2, 0], spine: [0.15, 0.1, 0], head: [-0.1, -0.15, 0], upperarm_r: [-1.5, 0, -0.1], forearm_r: [-0.05, 0, 0], hand_r: [1.45, 0, 0], upperarm_l: [0.2, 0, 0.4], forearm_l: [-0.3, 0, 0],
        thigh_l: [-0.85, 0, 0.1], shin_l: [0.8, 0, 0], thigh_r: [0.55, 0, -0.08], shin_r: [0.15, 0, 0], foot_r: [0.4, 0, 0], $r: [0, 0.1, 0], $p: [0, -0.15, 0.3] }],
      [1.3, { upperarm_r: [-1.45, 0, -0.1], forearm_r: [-0.1, 0, 0], hand_r: [1.4, 0, 0] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0.04, 0, 0], head: [0, 0, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-1.0, 0, 0], hand_r: [0.4, 0, 0], upperarm_l: [-0.2, 0, 0.3], forearm_l: [-0.6, 0, 0],
        thigh_l: [-0.25, 0, 0.08], shin_l: [0.35, 0, 0], thigh_r: [0.1, 0, -0.08], shin_r: [0.35, 0, 0], foot_r: [0, 0, 0], $r: [0, 0, 0], $p: [0, -0.04, 0.05] }]] },
    twin: { keys: [
      [0.45, { chest: [0.1, -0.6, 0], head: [0, 0.4, 0], upperarm_r: [-0.9, 0.4, -1.2], forearm_r: [-1.4, 0, 0], hand_r: [0.2, 0.4, 0], upperarm_l: [-0.6, 0, 0.6], forearm_l: [-1.3, 0, 0], hand_l: [0.4, 0, 0],
        thigh_l: [-0.4, 0, 0.12], shin_l: [0.5, 0, 0], thigh_r: [0.3, 0, -0.12], shin_r: [0.5, 0, 0], $r: [0, -0.2, 0], $p: [0, -0.1, 0] }],
      [0.8, { chest: [0.15, 0.4, 0], head: [0, -0.3, 0], upperarm_r: [-1.4, -0.3, -0.2], forearm_r: [-0.3, 0, 0], hand_r: [0.3, -0.4, 0], upperarm_l: [-0.9, -0.4, 1.2], forearm_l: [-1.4, 0, 0], hand_l: [0.2, -0.4, 0], $r: [0, 0.15, 0], $p: [0, -0.12, 0.1] }],
      [1.0, { chest: [0.18, -0.45, 0], head: [0, 0.3, 0], upperarm_r: [-1.0, -0.5, 0.4], forearm_r: [-0.9, 0, 0], upperarm_l: [-1.4, 0.3, 0.2], forearm_l: [-0.3, 0, 0], hand_l: [0.3, 0.4, 0],
        thigh_l: [-0.65, 0, 0.12], shin_l: [0.6, 0, 0], thigh_r: [0.4, 0, -0.12], shin_r: [0.3, 0, 0], $r: [0, -0.15, 0], $p: [0, -0.14, 0.2] }],
      [1.3, { chest: [0.15, -0.6, 0], upperarm_l: [-1.1, 0.5, -0.4], forearm_l: [-0.5, 0, 0], $r: [0, -0.25, 0] }],
      [2.0, { chest: [0.1, 0, 0], head: [0, 0, 0], upperarm_r: [-0.6, 0, -0.3], forearm_r: [-1.0, 0, 0], hand_r: [0.3, 0, 0], upperarm_l: [-0.6, 0, 0.3], forearm_l: [-1.0, 0, 0], hand_l: [0.3, 0, 0],
        thigh_l: [-0.3, 0, 0.1], shin_l: [0.45, 0, 0], thigh_r: [0.15, 0, -0.1], shin_r: [0.45, 0, 0], $r: [0, 0, 0], $p: [0, -0.07, 0.04] }]] },
    flurry: { full: true, keys: [
      [0.5, { chest: [0.15, -0.6, 0], upperarm_r: [-1.2, 0, -1.3], forearm_r: [-0.4, 0, 0], upperarm_l: [-1.2, 0, 1.3], forearm_l: [-0.4, 0, 0], thigh_l: [-0.5, 0, 0.2], shin_l: [0.7, 0, 0], thigh_r: [-0.2, 0, -0.2], shin_r: [0.7, 0, 0], $p: [0, -0.15, 0], $r: [0, -0.8, 0] }],
      [1.0, { chest: [0.15, 0.2, 0], upperarm_r: [-1.5, 0, -1.4], forearm_r: [-0.1, 0, 0], upperarm_l: [-1.5, 0, 1.4], forearm_l: [-0.1, 0, 0], $r: [0, 2.6, 0], $p: [0, -0.12, 0] }],
      [1.4, { $r: [0, 5.6, 0], chest: [0.1, 0.3, 0] }],
      [2.0, { chest: [0.05, 0, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-1, 0, 0], upperarm_l: [-0.5, 0, 0.3], forearm_l: [-1, 0, 0], thigh_l: [-0.2, 0, 0.08], shin_l: [0.3, 0, 0], thigh_r: [0.1, 0, -0.08], shin_r: [0.3, 0, 0], $r: [0, 6.283, 0], $p: [0, -0.04, 0] }]] },
    bash: { keys: [   // shield bash with the LEFT arm + roar
      [0.6, { chest: [0.0, 0.5, 0], spine: [0, 0.2, 0], upperarm_l: [-0.5, -0.4, 0.3], forearm_l: [-1.6, -0.5, 0], upperarm_r: [-0.3, 0, -0.5], forearm_r: [-1.6, 0, 0],
        thigh_l: [-0.3, 0, 0.1], shin_l: [0.6, 0, 0], thigh_r: [0.3, 0, -0.1], shin_r: [0.6, 0, 0], $r: [0, 0.35, 0], $p: [0, -0.12, -0.08] }],
      [1.0, { chest: [0.2, -0.45, 0], spine: [0.1, -0.2, 0], upperarm_l: [-1.4, -0.6, 0.1], forearm_l: [-1.2, -0.6, 0], head: [0.1, 0.2, 0],
        thigh_l: [-0.8, 0, 0.1], shin_l: [0.7, 0, 0], thigh_r: [0.55, 0, -0.1], shin_r: [0.2, 0, 0], $r: [0, -0.2, 0], $p: [0, -0.14, 0.32] }],
      [1.35, { chest: [-0.25, 0, 0], head: [-0.45, 0, 0], upperarm_r: [-2.4, 0, -0.5], forearm_r: [-1.2, 0, 0] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_l: [-0.35, 0, 0.25], forearm_l: [-1.3, -0.4, 0], upperarm_r: [-0.3, 0, -0.25], forearm_r: [-1.6, 0, 0],
        thigh_l: [-0.25, 0, 0.1], shin_l: [0.4, 0, 0], thigh_r: [0.1, 0, -0.1], shin_r: [0.4, 0, 0], $r: [0, 0, 0], $p: [0, -0.06, 0.05] }]] },
    brace: { full: true, keys: [
      [0.7, { chest: [0.2, 0.1, 0], spine: [0.15, 0, 0], upperarm_l: [-1.25, -0.6, 0.1], forearm_l: [-1.35, -0.7, 0], upperarm_r: [-0.4, 0, -0.4], forearm_r: [-1.8, 0, 0],
        thigh_l: [-0.7, 0, 0.18], shin_l: [1.0, 0, 0], foot_l: [-0.25, 0, 0], thigh_r: [0.1, 0, -0.18], shin_r: [0.9, 0, 0], foot_r: [-0.3, 0, 0], $p: [0, -0.24, 0] }],
      [1.0, { chest: [0.25, 0.1, 0], spine: [0.2, 0, 0], head: [-0.15, 0, 0], $p: [0, -0.3, 0.06] }],
      [1.6, { chest: [0.22, 0.1, 0], $p: [0, -0.28, 0.04] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_l: [-0.35, 0, 0.25], forearm_l: [-1.3, -0.4, 0], upperarm_r: [-0.3, 0, -0.25], forearm_r: [-1.6, 0, 0], thigh_l: [-0.2, 0, 0.1], shin_l: [0.3, 0, 0], foot_l: [0, 0, 0], thigh_r: [0.1, 0, -0.1], shin_r: [0.3, 0, 0], foot_r: [0, 0, 0], $p: [0, -0.03, 0] }]] },
    bow: { keys: [   // LEFT hand holds the bow forward, RIGHT hand draws the string to the cheek ('nock' bone follows hand_r)
      [0.25, { chest: [0, -0.9, 0], spine: [0, -0.35, 0], head: [0, 1.1, 0], neck: [0, 0.2, 0], upperarm_l: [-0.6, 0, 1.25], forearm_l: [-0.4, 0, 0], hand_l: [-0.3, 0.3, 0], upperarm_r: [-1.3, 0, -0.3], forearm_r: [-1.4, 0, 0],
        thigh_l: [-0.25, 0, 0.18], shin_l: [0.2, 0, 0], thigh_r: [0.1, 0, -0.2], shin_r: [0.2, 0, 0], $r: [0, -0.7, 0] }],
      [0.8, { chest: [-0.05, -1.25, 0], spine: [0, -0.4, 0], head: [0.05, 1.4, 0.0], neck: [0, 0.25, 0], upperarm_l: [-0.35, 0, 1.5], forearm_l: [-0.05, 0, 0], hand_l: [-0.5, 0.0, 0.2], upperarm_r: [-0.3, -0.4, -1.45], forearm_r: [-2.4, 0, 0], hand_r: [0, 0, 0], $r: [0, -0.95, 0] }],
      [1.0, { upperarm_r: [-0.25, -0.4, -1.6], forearm_r: [-2.5, 0, 0], $r: [0, -0.95, 0] }],
      [1.15, { upperarm_r: [0.0, -0.3, -1.4], forearm_r: [-1.9, 0, 0], hand_r: [0.3, 0, 0], head: [0.05, 1.35, 0] }],
      [2.0, { chest: [0, -0.4, 0], spine: [0, -0.15, 0], head: [0, 0.4, 0], neck: [0, 0, 0], upperarm_l: [-0.3, 0, 0.35], forearm_l: [-0.5, 0, 0], hand_l: [-1.0, 0, 0], upperarm_r: [-0.2, 0, -0.2], forearm_r: [-0.6, 0, 0], $r: [0, -0.3, 0] }]] },
    sling: { keys: [   // whirl the sling overhead with the RIGHT arm, release forward
      [0.3, { chest: [0, -0.35, 0], upperarm_r: [-2.3, 0, -0.6], forearm_r: [-0.8, 0, 0], head: [-0.1, 0.3, 0], upperarm_l: [-0.5, 0, 0.3], forearm_l: [-1.4, 0, 0], thigh_l: [-0.35, 0, 0.1], shin_l: [0.3, 0, 0], thigh_r: [0.25, 0, -0.1], shin_r: [0.35, 0, 0], $r: [0, -0.3, 0] }],
      [0.8, { chest: [-0.05, -0.5, 0], upperarm_r: [-2.5, 0, -0.9], forearm_r: [-0.6, 0, 0], $r: [0, -0.35, 0] }],
      [1.0, { chest: [0.25, 0.4, 0], spine: [0.1, 0.2, 0], upperarm_r: [-1.5, 0, -0.1], forearm_r: [-0.1, 0, 0], hand_r: [0.3, 0, 0], head: [0, -0.2, 0], thigh_l: [-0.55, 0, 0.1], shin_l: [0.45, 0, 0], thigh_r: [0.35, 0, -0.1], shin_r: [0.25, 0, 0], $r: [0, 0.2, 0], $p: [0, -0.06, 0.12] }],
      [1.3, { upperarm_r: [-1.0, 0, 0.3], forearm_r: [-0.3, 0, 0], chest: [0.3, 0.6, 0] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.2, 0, -0.15], forearm_r: [-0.4, 0, 0], hand_r: [0, 0, 0], thigh_l: [-0.15, 0, 0.06], shin_l: [0.2, 0, 0], thigh_r: [0.05, 0, -0.06], shin_r: [0.2, 0, 0], $r: [0, 0, 0], $p: [0, -0.02, 0.03] }]] },
    cast: { keys: [   // right palm thrust (also Tamsin's verse, Wren's rally variant)
      [0.6, { chest: [-0.1, -0.4, 0], upperarm_r: [-0.7, 0, -0.6], forearm_r: [-1.8, 0, 0], hand_r: [-0.3, 0, 0], upperarm_l: [-0.6, 0, 0.5], forearm_l: [-1.2, 0, 0], head: [-0.1, 0.3, 0], $r: [0, -0.2, 0] }],
      [1.0, { chest: [0.15, 0.3, 0], upperarm_r: [-1.55, 0, -0.1], forearm_r: [-0.1, 0, 0], hand_r: [-0.6, 0, 0], head: [0, -0.15, 0], upperarm_l: [-0.2, 0, 0.6], forearm_l: [-0.4, 0, 0], $r: [0, 0.15, 0], $p: [0, -0.03, 0.08] }],
      [1.5, { upperarm_r: [-1.45, 0, -0.15], forearm_r: [-0.15, 0, 0] }],
      [2.0, { chest: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.6, 0, 0], hand_r: [0, 0, 0], upperarm_l: [-0.2, 0, 0.2], forearm_l: [-0.5, 0, 0], head: [0, 0, 0], $r: [0, 0, 0], $p: [0, 0, 0] }]] },
    cast2: { keys: [  // both arms raised then thrust forward (cultists, priests, shades)
      [0.7, { chest: [-0.35, 0, 0], spine: [-0.15, 0, 0], head: [-0.35, 0, 0], upperarm_r: [-2.6, 0, -0.5], forearm_r: [-0.4, 0, 0], upperarm_l: [-2.6, 0, 0.5], forearm_l: [-0.4, 0, 0], hand_r: [-0.5, 0, 0], hand_l: [-0.5, 0, 0], $p: [0, 0.03, -0.05] }],
      [1.0, { chest: [0.35, 0, 0], spine: [0.2, 0, 0], head: [0.1, 0, 0], upperarm_r: [-1.5, 0, -0.2], forearm_r: [-0.1, 0, 0], upperarm_l: [-1.5, 0, 0.2], forearm_l: [-0.1, 0, 0], hand_r: [-0.7, 0, 0], hand_l: [-0.7, 0, 0], $p: [0, -0.05, 0.12] }],
      [1.5, { chest: [0.3, 0, 0] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.6, 0, 0], upperarm_l: [-0.3, 0, 0.2], forearm_l: [-0.6, 0, 0], hand_r: [0, 0, 0], hand_l: [0, 0, 0], $p: [0, 0, 0] }]] },
    lantern: { keys: [   // Maddoc thrusts the staff-lantern toward the foe
      [0.6, { chest: [-0.1, -0.35, 0], upperarm_r: [-0.6, 0, -0.3], forearm_r: [-1.6, 0, 0], hand_r: [-0.4, 0, 0], upperarm_l: [-0.9, 0, 0.3], forearm_l: [-1.3, 0, 0], $r: [0, -0.2, 0], $p: [0, -0.03, -0.04] }],
      [1.0, { chest: [0.2, 0.2, 0], spine: [0.1, 0, 0], upperarm_r: [-1.45, 0, -0.15], forearm_r: [-0.5, 0, 0], hand_r: [1.25, 0, 0], upperarm_l: [-0.6, 0, 0.5], forearm_l: [-0.5, 0, 0], thigh_l: [-0.45, 0, 0.1], shin_l: [0.4, 0, 0], thigh_r: [0.3, 0, -0.1], shin_r: [0.25, 0, 0], $r: [0, 0.1, 0], $p: [0, -0.07, 0.16] }],
      [1.4, { upperarm_r: [-1.4, 0, -0.15], forearm_r: [-0.6, 0, 0], hand_r: [1.1, 0, 0] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], upperarm_r: [-0.25, 0, -0.12], forearm_r: [-1.25, 0, 0], hand_r: [0, 0, 0], upperarm_l: [-0.1, 0, 0.15], forearm_l: [-0.3, 0, 0], thigh_l: [0, 0, 0], shin_l: [0.1, 0, 0], thigh_r: [0, 0, 0], shin_r: [0.1, 0, 0], $r: [0, 0, 0], $p: [0, 0, 0] }]] },
    kindle: { keys: [   // raise the lantern high: pulse of old light
      [0.7, { chest: [0.1, 0, 0], head: [0.25, 0, 0], upperarm_r: [-0.8, 0, -0.3], forearm_r: [-1.8, 0, 0], upperarm_l: [-0.9, 0, 0.6], forearm_l: [-1.4, 0, 0], $p: [0, -0.08, 0] }],
      [1.0, { chest: [-0.3, 0, 0], spine: [-0.1, 0, 0], head: [-0.45, 0, 0], upperarm_r: [-2.9, 0, -0.2], forearm_r: [-0.9, 0, 0], hand_r: [0.2, 0, 0], upperarm_l: [-1.2, 0, 1.1], forearm_l: [-0.3, 0, 0], $p: [0, 0.04, 0] }],
      [1.6, { upperarm_r: [-2.85, 0, -0.2], head: [-0.35, 0, 0] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.25, 0, -0.12], forearm_r: [-1.25, 0, 0], hand_r: [0, 0, 0], upperarm_l: [-0.1, 0, 0.15], forearm_l: [-0.3, 0, 0], $p: [0, 0, 0] }]] },
    mend: { keys: [   // left palm toward an ally
      [0.6, { chest: [0, 0.2, 0], upperarm_l: [-0.6, 0, 0.5], forearm_l: [-1.6, 0, 0], hand_l: [-0.3, 0, 0], head: [0.2, -0.2, 0] }],
      [1.0, { chest: [0.1, -0.2, 0], upperarm_l: [-1.45, 0, 0.25], forearm_l: [-0.2, 0, 0], hand_l: [-0.8, 0, 0], head: [0.05, 0.1, 0], $p: [0, -0.02, 0.05] }],
      [1.6, { upperarm_l: [-1.4, 0, 0.3], forearm_l: [-0.25, 0, 0] }],
      [2.0, { chest: [0, 0, 0], upperarm_l: [-0.1, 0, 0.15], forearm_l: [-0.3, 0, 0], hand_l: [0, 0, 0], head: [0, 0, 0], $p: [0, 0, 0] }]] },
    rally: { keys: [  // Wren: fist to the heart, then raise the hand (Encourage)
      [0.6, { chest: [0.15, 0, 0], head: [0.2, 0, 0], upperarm_r: [-0.6, 0, 0.1], forearm_r: [-2.2, 0.4, 0], hand_r: [0, 0, 0] }],
      [1.0, { chest: [-0.2, 0, 0], head: [-0.2, 0, 0], upperarm_r: [-2.7, 0, -0.35], forearm_r: [-0.3, 0, 0], hand_r: [-0.2, 0, 0], $p: [0, 0.03, 0] }],
      [1.6, { upperarm_r: [-2.6, 0, -0.35] }],
      [2.0, { chest: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.2, 0, -0.15], forearm_r: [-0.4, 0, 0], hand_r: [0, 0, 0], $p: [0, 0, 0] }]] },
    wield: { full: true, keys: [  // Wren raises the Emberheart overhead with both hands, then drives it down
      [0.55, { chest: [-0.35, 0, 0], spine: [-0.2, 0, 0], head: [-0.5, 0, 0], upperarm_l: [-2.85, 0, 0.15], forearm_l: [-0.6, 0, 0], upperarm_r: [-2.7, 0, -0.15], forearm_r: [-0.7, 0, 0],
        thigh_l: [-0.1, 0, 0.12], shin_l: [0.1, 0, 0], thigh_r: [-0.1, 0, -0.12], shin_r: [0.1, 0, 0], $p: [0, 0.05, 0] }],
      [0.85, { chest: [-0.45, 0, 0], head: [-0.6, 0, 0], upperarm_l: [-3.0, 0, 0.1], upperarm_r: [-2.9, 0, -0.1], $p: [0, 0.08, 0] }],
      [1.0, { chest: [0.7, 0, 0], spine: [0.35, 0, 0], head: [0.4, 0, 0], upperarm_l: [-1.0, 0, 0.1], forearm_l: [-0.2, 0, 0], upperarm_r: [-1.0, 0, -0.1], forearm_r: [-0.2, 0, 0],
        thigh_l: [-1.0, 0, 0.15], shin_l: [1.6, 0, 0], foot_l: [-0.4, 0, 0], thigh_r: [0.1, 0, -0.15], shin_r: [1.9, 0, 0], foot_r: [0.5, 0, 0], $p: [0, -0.32, 0.08] }],
      [1.5, { chest: [0.65, 0, 0], head: [0.2, 0, 0], $p: [0, -0.3, 0.08] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_l: [-0.3, 0, 0.15], forearm_l: [-1.3, 0.3, 0], upperarm_r: [-0.2, 0, -0.15], forearm_r: [-0.4, 0, 0],
        thigh_l: [0, 0, 0], shin_l: [0, 0, 0], foot_l: [0, 0, 0], thigh_r: [0, 0, 0], shin_r: [0, 0, 0], foot_r: [0, 0, 0], $p: [0, 0, 0] }]] },
    fade: { full: true, keys: [  // crouch and wrap the cloak
      [0.7, { chest: [0.45, 0.2, 0], spine: [0.25, 0, 0], head: [0.4, 0, 0], upperarm_l: [-1.0, 0, -0.5], forearm_l: [-1.9, 0, 0], upperarm_r: [-1.0, 0, 0.5], forearm_r: [-1.9, 0, 0],
        thigh_l: [-0.9, 0, 0.1], shin_l: [1.5, 0, 0], foot_l: [-0.5, 0, 0], thigh_r: [-0.9, 0, -0.1], shin_r: [1.5, 0, 0], foot_r: [-0.5, 0, 0], $p: [0, -0.3, 0] }],
      [1.0, { $p: [0, -0.34, 0] }],
      [2.0, { chest: [0.1, 0, 0], spine: [0.05, 0, 0], head: [0, 0, 0], upperarm_l: [-0.3, 0, 0.15], forearm_l: [-1.3, 0.3, 0], upperarm_r: [-0.2, 0, -0.15], forearm_r: [-0.4, 0, 0],
        thigh_l: [-0.3, 0, 0.05], shin_l: [0.5, 0, 0], foot_l: [-0.2, 0, 0], thigh_r: [-0.3, 0, -0.05], shin_r: [0.5, 0, 0], foot_r: [-0.2, 0, 0], $p: [0, -0.08, 0] }]] },
    song: { keys: [   // Tamsin: spear raised, chest out, a stamp on the beat
      [0.6, { chest: [-0.25, 0, 0], head: [-0.35, 0.2, 0], upperarm_r: [-2.2, 0, -0.3], forearm_r: [-1.2, 0, 0], upperarm_l: [-1.2, 0, 0.9], forearm_l: [-0.6, 0, 0], thigh_l: [-0.7, 0, 0.1], shin_l: [0.9, 0, 0], $p: [0, 0.02, 0] }],
      [1.0, { chest: [-0.3, 0, 0], head: [-0.45, 0, 0], upperarm_r: [-2.7, 0, -0.3], forearm_r: [-0.9, 0, 0], upperarm_l: [-1.6, 0, 1.3], forearm_l: [-0.3, 0, 0], thigh_l: [-0.1, 0, 0.1], shin_l: [0.1, 0, 0], $p: [0, -0.03, 0] }],
      [1.6, { head: [-0.3, -0.2, 0], upperarm_l: [-1.5, 0, 1.2] }],
      [2.0, { chest: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-1.4, 0, 0], upperarm_l: [-0.2, 0, 0.2], forearm_l: [-0.4, 0, 0], thigh_l: [0, 0, 0], shin_l: [0, 0, 0], $p: [0, 0, 0] }]] },
    dirge: { keys: [   // arms spread wide, head back: the old kings' song
      [0.6, { chest: [0.2, 0, 0], head: [0.4, 0, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-1.4, 0, 0], upperarm_l: [-0.5, 0, 0.3], forearm_l: [-1.4, 0, 0], $p: [0, -0.05, 0] }],
      [1.0, { chest: [-0.35, 0, 0], spine: [-0.15, 0, 0], head: [-0.6, 0, 0], upperarm_r: [-1.3, 0, -1.3], forearm_r: [-0.2, 0, 0], upperarm_l: [-1.3, 0, 1.3], forearm_l: [-0.2, 0, 0], $p: [0, 0.02, 0] }],
      [1.6, { head: [-0.5, 0, 0], upperarm_r: [-1.2, 0, -1.4], upperarm_l: [-1.2, 0, 1.4] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-1.4, 0, 0], upperarm_l: [-0.2, 0, 0.2], forearm_l: [-0.4, 0, 0], $p: [0, 0, 0] }]] },
    jab: { keys: [   // spear jab (Tamsin close range, spearmen)
      [0.6, { chest: [0, -0.4, 0], upperarm_r: [-0.1, 0, -0.3], forearm_r: [-1.4, 0, 0], hand_r: [1.2, 0, 0], upperarm_l: [-0.9, 0, 0.1], forearm_l: [-1.2, 0.6, 0], thigh_l: [-0.3, 0, 0.1], shin_l: [0.45, 0, 0], thigh_r: [0.25, 0, -0.1], shin_r: [0.45, 0, 0], $r: [0, -0.3, 0], $p: [0, -0.07, -0.08] }],
      [1.0, { chest: [0.2, 0.15, 0], upperarm_r: [-1.2, 0, -0.1], forearm_r: [-0.3, 0, 0], hand_r: [1.25, 0, 0], upperarm_l: [-1.3, 0, 0.0], forearm_l: [-0.5, 0.5, 0], thigh_l: [-0.75, 0, 0.1], shin_l: [0.7, 0, 0], thigh_r: [0.5, 0, -0.1], shin_r: [0.2, 0, 0], $r: [0, 0.1, 0], $p: [0, -0.12, 0.3] }],
      [1.3, { upperarm_r: [-1.15, 0, -0.1], forearm_r: [-0.35, 0, 0] }],
      [2.0, { chest: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-1.3, 0, 0], hand_r: [0.2, 0, 0], upperarm_l: [-0.2, 0, 0.2], forearm_l: [-0.4, 0, 0], thigh_l: [-0.2, 0, 0.06], shin_l: [0.3, 0, 0], thigh_r: [0.05, 0, -0.06], shin_r: [0.3, 0, 0], $r: [0, 0, 0], $p: [0, -0.03, 0.03] }]] },
    claw: { keys: [   // ghoul swipe (right claw), body lunges
      [0.6, { chest: [0.1, -0.7, 0], spine: [0.2, -0.3, 0], head: [-0.4, 0.5, 0], upperarm_r: [-1.6, 0.4, -1.3], forearm_r: [-1.2, 0, 0], hand_r: [-0.6, 0, 0], upperarm_l: [-0.7, 0, 0.5], forearm_l: [-0.8, 0, 0], $r: [0, -0.3, 0], $p: [0, -0.08, -0.06] }],
      [1.0, { chest: [0.45, 0.45, 0], spine: [0.35, 0.2, 0], head: [-0.6, -0.3, 0], upperarm_r: [-1.2, -0.3, 0.4], forearm_r: [-0.4, 0, 0], hand_r: [0.2, 0, 0], thigh_l: [-0.7, 0, 0.1], shin_l: [0.7, 0, 0], thigh_r: [0.45, 0, -0.1], shin_r: [0.4, 0, 0], $r: [0, 0.3, 0], $p: [0, -0.14, 0.3] }],
      [1.3, { upperarm_r: [-0.9, -0.4, 0.6] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.5, 0, -0.2], forearm_r: [-0.5, 0, 0], hand_r: [0, 0, 0], upperarm_l: [-0.5, 0, 0.2], forearm_l: [-0.5, 0, 0], thigh_l: [0, 0, 0], shin_l: [0, 0, 0], thigh_r: [0, 0, 0], shin_r: [0, 0, 0], $r: [0, 0, 0], $p: [0, 0, 0] }]] },
    grab: { keys: [   // both arms reach and clutch
      [0.6, { chest: [-0.1, 0, 0], head: [-0.3, 0, 0], upperarm_r: [-1.6, 0, -0.9], forearm_r: [-0.6, 0, 0], upperarm_l: [-1.6, 0, 0.9], forearm_l: [-0.6, 0, 0], $p: [0, -0.04, -0.06] }],
      [1.0, { chest: [0.45, 0, 0], spine: [0.3, 0, 0], head: [-0.2, 0, 0], upperarm_r: [-1.5, 0, -0.1], forearm_r: [-0.9, 0, 0], upperarm_l: [-1.5, 0, 0.1], forearm_l: [-0.9, 0, 0], thigh_l: [-0.6, 0, 0.1], shin_l: [0.6, 0, 0], thigh_r: [0.4, 0, -0.1], shin_r: [0.3, 0, 0], $p: [0, -0.12, 0.3] }],
      [1.5, { chest: [0.4, 0, 0] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.4, 0, -0.2], forearm_r: [-0.5, 0, 0], upperarm_l: [-0.4, 0, 0.2], forearm_l: [-0.5, 0, 0], thigh_l: [0, 0, 0], shin_l: [0, 0, 0], thigh_r: [0, 0, 0], shin_r: [0, 0, 0], $p: [0, 0, 0] }]] },
    slam: { full: true, keys: [   // two-handed overhead slam into the ground (troll, warden, sentinel aoe)
      [0.6, { chest: [-0.35, 0, 0], spine: [-0.15, 0, 0], head: [-0.3, 0, 0], upperarm_r: [-2.8, 0, -0.35], forearm_r: [-0.7, 0, 0], upperarm_l: [-2.8, 0, 0.35], forearm_l: [-0.7, 0, 0], hand_r: [-0.3, 0, 0], hand_l: [-0.3, 0, 0],
        thigh_l: [-0.2, 0, 0.15], shin_l: [0.25, 0, 0], thigh_r: [0.05, 0, -0.15], shin_r: [0.25, 0, 0], $p: [0, 0.04, -0.06] }],
      [1.0, { chest: [0.75, 0, 0], spine: [0.45, 0, 0], head: [0.2, 0, 0], upperarm_r: [-1.0, 0, -0.1], forearm_r: [-0.2, 0, 0], upperarm_l: [-1.0, 0, 0.1], forearm_l: [-0.2, 0, 0], hand_r: [0.6, 0, 0], hand_l: [0.6, 0, 0],
        thigh_l: [-0.9, 0, 0.18], shin_l: [1.1, 0, 0], foot_l: [-0.2, 0, 0], thigh_r: [0.1, 0, -0.18], shin_r: [1.0, 0, 0], foot_r: [-0.1, 0, 0], $p: [0, -0.28, 0.14] }],
      [1.4, { chest: [0.7, 0, 0], spine: [0.42, 0, 0], $p: [0, -0.26, 0.14] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.4, 0, -0.2], forearm_r: [-0.6, 0, 0], upperarm_l: [-0.4, 0, 0.2], forearm_l: [-0.6, 0, 0], hand_r: [0, 0, 0], hand_l: [0, 0, 0],
        thigh_l: [-0.1, 0, 0.1], shin_l: [0.2, 0, 0], foot_l: [0, 0, 0], thigh_r: [0, 0, -0.1], shin_r: [0.2, 0, 0], foot_r: [0, 0, 0], $p: [0, -0.04, 0] }]] },
    roar: { keys: [   // bellow / roar / horn
      [0.6, { chest: [0.35, 0, 0], head: [0.35, 0, 0], upperarm_r: [-0.4, 0, -0.5], forearm_r: [-1.2, 0, 0], upperarm_l: [-0.4, 0, 0.5], forearm_l: [-1.2, 0, 0], $p: [0, -0.08, 0] }],
      [1.0, { chest: [-0.35, 0, 0], spine: [-0.2, 0, 0], head: [-0.6, 0, 0], neck: [-0.2, 0, 0], upperarm_r: [-0.9, 0, -1.3], forearm_r: [-0.9, 0, 0], upperarm_l: [-0.9, 0, 1.3], forearm_l: [-0.9, 0, 0], $p: [0, 0.03, 0] }],
      [1.6, { chest: [-0.3, 0, 0], head: [-0.55, 0.15, 0] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], neck: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.5, 0, 0], upperarm_l: [-0.3, 0, 0.2], forearm_l: [-0.5, 0, 0], $p: [0, 0, 0] }]] },
    horn: { keys: [   // raise the left hand to the mouth (horn), head back
      [0.6, { upperarm_l: [-1.0, 0, 0.3], forearm_l: [-2.2, -0.5, 0], head: [0.1, 0, 0] }],
      [1.0, { upperarm_l: [-1.5, 0, -0.1], forearm_l: [-2.3, -0.6, 0], head: [-0.4, 0, 0], chest: [-0.25, 0, 0], upperarm_r: [-1.2, 0, -0.6], forearm_r: [-0.6, 0, 0] }],
      [1.7, { head: [-0.45, 0, 0], chest: [-0.25, 0, 0] }],
      [2.0, { upperarm_l: [-0.3, 0, 0.2], forearm_l: [-0.5, 0, 0], head: [0, 0, 0], chest: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.6, 0, 0] }]] },
    sweep: { full: true, keys: [   // two-handed horizontal sweep (aoe for armed humanoids)
      [0.6, { chest: [0.1, -1.0, 0], spine: [0.05, -0.4, 0], head: [0, 0.6, 0], upperarm_r: [-1.0, 0.4, -1.3], forearm_r: [-0.9, 0, 0], upperarm_l: [-1.2, 0, 0.1], forearm_l: [-1.3, 0, 0],
        thigh_l: [-0.4, 0, 0.2], shin_l: [0.6, 0, 0], thigh_r: [0.1, 0, -0.2], shin_r: [0.6, 0, 0], $r: [0, -0.5, 0], $p: [0, -0.12, 0] }],
      [1.0, { chest: [0.2, 0.7, 0], spine: [0.1, 0.3, 0], head: [0, -0.4, 0], upperarm_r: [-1.4, -0.2, -0.3], forearm_r: [-0.2, 0, 0], upperarm_l: [-1.3, -0.4, 0.6], forearm_l: [-0.5, 0, 0], $r: [0, 0.6, 0], $p: [0, -0.16, 0.06] }],
      [1.35, { chest: [0.2, 1.0, 0], $r: [0, 0.9, 0], upperarm_r: [-1.1, -0.6, 0.5] }],
      [2.0, { chest: [0.05, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.5, 0, -0.3], forearm_r: [-0.9, 0, 0], upperarm_l: [-0.4, 0, 0.3], forearm_l: [-0.8, 0, 0], thigh_l: [-0.1, 0, 0.1], shin_l: [0.2, 0, 0], thigh_r: [0, 0, -0.1], shin_r: [0.2, 0, 0], $r: [0, 0, 0], $p: [0, -0.04, 0] }]] },
    throw: { keys: [   // underarm throw (dust, knives)
      [0.6, { chest: [0.1, -0.5, 0], upperarm_r: [0.7, 0, -0.3], forearm_r: [-0.4, 0, 0], thigh_l: [-0.3, 0, 0.1], shin_l: [0.4, 0, 0], $r: [0, -0.3, 0], $p: [0, -0.08, 0] }],
      [1.0, { chest: [0.15, 0.4, 0], upperarm_r: [-1.3, 0, -0.2], forearm_r: [-0.2, 0, 0], hand_r: [-0.4, 0, 0], thigh_l: [-0.55, 0, 0.1], shin_l: [0.5, 0, 0], $r: [0, 0.25, 0], $p: [0, -0.06, 0.15] }],
      [2.0, { chest: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.6, 0, 0], hand_r: [0, 0, 0], thigh_l: [0, 0, 0], shin_l: [0, 0, 0], $r: [0, 0, 0], $p: [0, 0, 0] }]] },
    punch: { keys: [   // construct fist
      [0.6, { chest: [0, -0.5, 0], upperarm_r: [0.4, 0, -0.4], forearm_r: [-1.9, 0, 0], upperarm_l: [-0.9, 0, 0.3], forearm_l: [-1.4, 0, 0], thigh_r: [0.3, 0, -0.1], shin_r: [0.3, 0, 0], $r: [0, -0.3, 0], $p: [0, -0.04, -0.05] }],
      [1.0, { chest: [0.15, 0.4, 0], upperarm_r: [-1.6, 0, -0.1], forearm_r: [-0.1, 0, 0], upperarm_l: [-0.2, 0, 0.4], forearm_l: [-0.8, 0, 0], thigh_l: [-0.5, 0, 0.1], shin_l: [0.4, 0, 0], thigh_r: [0.4, 0, -0.1], shin_r: [0.2, 0, 0], $r: [0, 0.25, 0], $p: [0, -0.08, 0.25] }],
      [1.4, { upperarm_r: [-1.5, 0, -0.1] }],
      [2.0, { chest: [0, 0, 0], upperarm_r: [-0.3, 0, -0.2], forearm_r: [-0.5, 0, 0], upperarm_l: [-0.3, 0, 0.2], forearm_l: [-0.5, 0, 0], thigh_l: [0, 0, 0], shin_l: [0, 0, 0], thigh_r: [0, 0, 0], shin_r: [0, 0, 0], $r: [0, 0, 0], $p: [0, 0, 0] }]] },
    victory: { keys: [
      [0.5, { chest: [-0.1, 0.2, 0], upperarm_r: [-1.6, 0, -0.6], forearm_r: [-1.6, 0, 0], head: [-0.1, 0, 0] }],
      [1.0, { chest: [-0.25, 0.1, 0], spine: [-0.08, 0, 0], head: [-0.35, 0.1, 0], upperarm_r: [-2.9, 0, -0.35], forearm_r: [-0.25, 0, 0], hand_r: [-0.4, 0, 0], $p: [0, 0.02, 0] }],
      [1.6, { head: [-0.3, -0.1, 0], upperarm_r: [-2.85, 0, -0.35] }],
      [2.0, { chest: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0], upperarm_r: [-0.4, 0, -0.2], forearm_r: [-0.6, 0, 0], hand_r: [0, 0, 0], $p: [0, 0, 0] }]] }
  };
  HC.claw_m = mirrorDef(Object.assign({ name: 'claw' }, HC.claw));
  // hero ability -> clip (arrays = combo variants)
  const HERO_CLIP = {
    sling_stone: 'sling', encourage: 'rally', wield_emberheart: 'wield', fade_into_ash: 'fade',
    twin_cuts: 'twin', mark_quarry: 'thrust', hunters_volley: 'flurry',
    hammer_blow: ['slash', 'backslash', 'overhead'], shield_wall: 'brace', defy: 'bash',
    swift_arrow: 'bow', pinning_shot: 'bow', rain_of_thorns: 'bow',
    lantern_flare: 'lantern', mend: 'mend', kindle_old_light: 'kindle',
    dirty_blade: ['slash', 'backslash', 'thrust'], backstab: 'thrust', cut_purse: 'backslash',
    cutting_verse: 'cast', marching_song: 'song', dirge_old_kings: 'dirge'
  };
  // humanoid foe clips by look style + intent shape (melee | aoe | proj | cast)
  const FOE_CLIP = {
    rogue: { melee: ['thrust', 'slash'], aoe: 'sweep', proj: 'throw', cast: 'throw' },
    heavy: { melee: ['overhead', 'slash'], aoe: 'sweep', proj: 'cast', cast: 'roar' },
    soldier: { melee: ['jab', 'thrust'], aoe: 'sweep', proj: 'cast', cast: 'horn' },
    caster: { melee: ['overhead', 'slash'], aoe: 'cast2', proj: 'cast', cast: 'cast2' },
    ghoul: { melee: ['claw', 'claw_m'], aoe: 'grab', proj: 'claw', cast: 'grab' },
    brute: { melee: ['overhead', 'slash'], aoe: 'slam', proj: 'throw', cast: 'roar' },
    construct: { melee: ['punch', 'overhead'], aoe: 'slam', proj: 'cast', cast: 'roar' },
    float: { melee: ['claw', 'thrust'], aoe: 'cast2', proj: 'cast', cast: 'cast2' },
    boss: { melee: ['overhead', 'slash', 'thrust'], aoe: 'sweep', proj: 'cast', cast: 'roar' },
    hero: { melee: ['slash'], aoe: 'sweep', proj: 'cast', cast: 'cast' }
  };
  const FOE_INTENT_CLIP = { horn: 'horn', call_gatewatch: 'horn', whistle: 'horn', rally: 'roar', proclaim: 'roar', bellow: 'roar', roar: 'roar', furnace_roar: 'roar', hollow_call: 'roar',
    dust: 'throw', stamp: 'slam', quake: 'slam', deep_hammer: 'slam', floodgates: 'cast2', seal_halls: 'cast2', wake_husks: 'cast2', rime_spear: 'thrust', reaping_sweep: 'sweep',
    sunder: 'overhead', brand: 'cast', decree: 'cast2', gatewatch: 'horn', boulder: 'slam', crush: 'overhead', sweep: 'sweep', hide: 'roar', lock_shields: 'brace', shield: 'brace', brace: 'brace' };

  // per-hero carry (relaxed) and ready (combat) arm poses; walking swing scales per arm
  const CARRY = {
    wren: { relax: { upperarm_l: [-0.35, 0.2, 0.12], forearm_l: [-1.35, 0.35, 0], hand_l: [0.2, 0, 0] }, ready: { upperarm_l: [-0.5, 0.3, 0.2], forearm_l: [-1.5, 0.4, 0], upperarm_r: [-0.3, 0, -0.35], forearm_r: [-0.7, 0, 0] }, swingL: 0.25, swingR: 1 },
    ysolde: { relax: { hand_r: [0.7, 0, 0], hand_l: [0.7, 0, 0] }, ready: { upperarm_r: [-0.55, 0, -0.3], forearm_r: [-1.1, 0, 0], hand_r: [0.3, 0.2, 0], upperarm_l: [-0.55, 0, 0.3], forearm_l: [-1.0, 0, 0], hand_l: [0.3, -0.2, 0] }, swingL: 1, swingR: 1 },
    brakka: { relax: { upperarm_r: [-0.3, 0, -0.25], forearm_r: [-2.25, 0, 0], hand_r: [0.2, 0, 0], upperarm_l: [0.05, 0, 0.16], forearm_l: [-0.55, -0.35, 0] }, ready: { upperarm_l: [-0.7, -0.35, 0.15], forearm_l: [-1.3, -0.6, 0], upperarm_r: [-0.5, 0, -0.45], forearm_r: [-1.5, 0, 0], hand_r: [0, 0, 0] }, swingL: 0.3, swingR: 0.2 },
    neve: { relax: { hand_l: [-1.15, 0, 0], forearm_l: [-0.3, 0, 0] }, ready: { upperarm_l: [-0.35, 0, 0.35], forearm_l: [-0.5, 0, 0], hand_l: [-1.0, 0, 0], upperarm_r: [-0.4, 0, -0.2], forearm_r: [-0.8, 0, 0] }, swingL: 0.6, swingR: 1 },
    maddoc: { relax: { upperarm_r: [-0.25, 0, -0.12], forearm_r: [-1.25, 0, 0], hand_r: [0, 0, 0] }, ready: { upperarm_r: [-0.55, 0, -0.2], forearm_r: [-1.2, 0, 0], upperarm_l: [-0.5, 0, 0.3], forearm_l: [-1.1, 0, 0] }, swingL: 1, swingR: 0.2 },
    rook: { relax: { hand_r: [1.0, 0, 0] }, ready: { upperarm_r: [-0.5, 0, -0.3], forearm_r: [-1.0, 0, 0], hand_r: [-0.1, 0, 0], upperarm_l: [-0.3, 0, 0.3], forearm_l: [-0.9, 0, 0] }, swingL: 1, swingR: 1 },
    tamsin: { relax: { upperarm_r: [-0.25, 0, -0.15], forearm_r: [-1.4, 0, 0], hand_r: [0, 0, 0] }, ready: { upperarm_r: [-0.4, 0, -0.25], forearm_r: [-0.9, 0, 0], hand_r: [1.0, 0, 0], upperarm_l: [-0.6, 0, 0.15], forearm_l: [-0.9, 0.5, 0] }, swingL: 1, swingR: 0.25 }
  };
  const STYLE = {   // locomotion personality
    hero: { stride: 1, bob: 1, lean: 1, armSwing: 1, crouch: 0, hunch: 0, wide: 0, cadence: 1 },
    heavy: { stride: 0.95, bob: 1.2, lean: 0.8, armSwing: 0.7, crouch: 0.05, hunch: 0.05, wide: 0.06, cadence: 0.92 },
    old: { stride: 0.85, bob: 0.7, lean: 0.6, armSwing: 0.5, crouch: 0.04, hunch: 0.22, wide: 0.02, cadence: 0.95 },
    rogue: { stride: 1, bob: 0.9, lean: 1.2, armSwing: 0.8, crouch: 0.08, hunch: 0.1, wide: 0.03, cadence: 1 },
    soldier: { stride: 1, bob: 0.8, lean: 0.7, armSwing: 0.6, crouch: 0.02, hunch: 0, wide: 0.03, cadence: 1 },
    caster: { stride: 0.85, bob: 0.6, lean: 0.6, armSwing: 0.35, crouch: 0, hunch: 0.08, wide: 0, cadence: 0.95 },
    ghoul: { stride: 1.05, bob: 1.6, lean: 1.6, armSwing: 1.2, crouch: 0.22, hunch: 0.55, wide: 0.05, cadence: 1.1 },
    brute: { stride: 0.9, bob: 1.5, lean: 1, armSwing: 0.8, crouch: 0.15, hunch: 0.35, wide: 0.1, cadence: 0.85 },
    construct: { stride: 0.9, bob: 1.1, lean: 0.4, armSwing: 0.45, crouch: 0.06, hunch: 0.05, wide: 0.08, cadence: 0.85 },
    boss: { stride: 1, bob: 0.9, lean: 0.7, armSwing: 0.6, crouch: 0.03, hunch: 0, wide: 0.06, cadence: 0.9 },
    float: { stride: 1, bob: 0, lean: 1, armSwing: 0, crouch: 0, hunch: 0.1, wide: 0, cadence: 1 }
  };

  // ---- non-human clips (same key format)
  const QC = {   // quadrupeds
    bite: { keys: [[0.7, { chest: [0.15, 0, 0], neck: [0.2, 0, 0], head: [0.1, 0, 0], jaw: [0, 0, 0], fu_l: [-0.2, 0, 0], fu_r: [-0.2, 0, 0], bu_l: [-0.35, 0, 0], bu_r: [-0.35, 0, 0], bl_l: [0.5, 0, 0], bl_r: [0.5, 0, 0], $p: [0, -0.1, -0.12] }],
      [1.0, { chest: [-0.15, 0, 0], neck: [-0.1, 0, 0], head: [0.25, 0, 0], jaw: [0.75, 0, 0], fu_l: [-0.9, 0, 0], fu_r: [-0.7, 0, 0], fl_l: [0.6, 0, 0], fl_r: [0.5, 0, 0], bu_l: [0.3, 0, 0], bu_r: [0.3, 0, 0], bl_l: [0, 0, 0], bl_r: [0, 0, 0], $p: [0, 0.06, 0.5] }],
      [1.25, { jaw: [0.05, 0, 0], head: [0.3, 0.25, 0.2] }],
      [2.0, { chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], jaw: [0, 0, 0], fu_l: [0, 0, 0], fu_r: [0, 0, 0], fl_l: [0, 0, 0], fl_r: [0, 0, 0], bu_l: [0, 0, 0], bu_r: [0, 0, 0], bl_l: [0, 0, 0], bl_r: [0, 0, 0], $p: [0, 0, 0] }]], full: true },
    pounce: { full: true, keys: [[0.75, { chest: [0.2, 0, 0], pelvis: [-0.15, 0, 0], neck: [0.25, 0, 0], head: [-0.1, 0, 0], fu_l: [0.3, 0, 0], fu_r: [0.3, 0, 0], fl_l: [0.6, 0, 0], fl_r: [0.6, 0, 0], bu_l: [-0.6, 0, 0], bu_r: [-0.6, 0, 0], bl_l: [0.8, 0, 0], bl_r: [0.8, 0, 0], bh_l: [-0.5, 0, 0], bh_r: [-0.5, 0, 0], $p: [0, -0.18, -0.2] }],
      [1.0, { chest: [-0.35, 0, 0], pelvis: [0.2, 0, 0], neck: [-0.2, 0, 0], head: [0.3, 0, 0], jaw: [0.8, 0, 0], fu_l: [-1.5, 0, 0], fu_r: [-1.4, 0, 0], fl_l: [0.2, 0, 0], fl_r: [0.3, 0, 0], bu_l: [0.6, 0, 0], bu_r: [0.6, 0, 0], bl_l: [-0.2, 0, 0], bl_r: [-0.2, 0, 0], $p: [0, 0.35, 0.9], $r: [-0.25, 0, 0] }],
      [1.35, { jaw: [0.1, 0, 0], $p: [0, 0.05, 0.7], $r: [0.1, 0, 0] }],
      [2.0, { chest: [0, 0, 0], pelvis: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], jaw: [0, 0, 0], fu_l: [0, 0, 0], fu_r: [0, 0, 0], fl_l: [0, 0, 0], fl_r: [0, 0, 0], bu_l: [0, 0, 0], bu_r: [0, 0, 0], bl_l: [0, 0, 0], bl_r: [0, 0, 0], bh_l: [0, 0, 0], bh_r: [0, 0, 0], $p: [0, 0, 0], $r: [0, 0, 0] }]] },
    howl: { keys: [[0.7, { neck: [0.3, 0, 0], head: [0.3, 0, 0], $p: [0, -0.04, 0] }], [1.0, { neck: [-0.9, 0, 0], head: [-0.5, 0, 0], jaw: [0.6, 0, 0], chest: [-0.15, 0, 0] }], [1.7, { neck: [-0.85, 0, 0], jaw: [0.5, 0, 0] }], [2.0, { neck: [0, 0, 0], head: [0, 0, 0], jaw: [0, 0, 0], chest: [0, 0, 0], $p: [0, 0, 0] }]] }
  };
  const SC = {   // spider (body bones; legs are IK, front legs raised by the animator during strikes)
    sbite: { keys: [[0.7, { body: [-0.35, 0, 0], abdomen: [0.25, 0, 0], fang_l: [0, -0.5, 0], fang_r: [0, 0.5, 0], $p: [0, 0.1, -0.15] }], [1.0, { body: [0.25, 0, 0], abdomen: [-0.15, 0, 0], fang_l: [0, 0.3, 0], fang_r: [0, -0.3, 0], $p: [0, -0.05, 0.45] }], [2.0, { body: [0, 0, 0], abdomen: [0, 0, 0], fang_l: [0, 0, 0], fang_r: [0, 0, 0], $p: [0, 0, 0] }]] },
    sspit: { keys: [[0.7, { body: [-0.2, 0, 0], abdomen: [-0.6, 0, 0], $p: [0, 0.06, -0.1] }], [1.0, { body: [0.15, 0, 0], abdomen: [0.2, 0, 0], $p: [0, -0.04, 0.1] }], [2.0, { body: [0, 0, 0], abdomen: [0, 0, 0], $p: [0, 0, 0] }]] }
  };
  const WC = {   // serpents (bone names sp0..spN, head, jaw); strike curves are added procedurally
    lash: { keys: [[0.8, { head: [-0.3, 0, 0], jaw: [0.2, 0, 0] }], [1.0, { head: [0.35, 0, 0], jaw: [0.8, 0, 0] }], [1.3, { jaw: [0.1, 0, 0] }], [2.0, { head: [0, 0, 0], jaw: [0, 0, 0] }]] },
    breath: { keys: [[0.8, { head: [-0.45, 0, 0], jaw: [0.1, 0, 0] }], [1.0, { head: [0.1, 0, 0], jaw: [0.9, 0, 0] }], [1.7, { head: [0.15, 0, 0], jaw: [0.85, 0, 0] }], [2.0, { head: [0, 0, 0], jaw: [0, 0, 0] }]] }
  };
  const LIB = { human: HC, quad: QC, spider: SC, serpent: WC };

  // =====================================================================================================
  // 8. VIEWS
  // =====================================================================================================
  const views = new Map();
  const tpls = new Map();
  function template(key, look) {
    let t = tpls.get(key); if (t) return t;
    t = look.rig === 'quad' ? buildQuad(look) : look.rig === 'spider' ? buildSpider(look) : look.rig === 'serpent' ? buildSerpent(look) : buildHuman(look);
    t.look = look; t.key = key; t.ix = {}; t.bones.forEach((b, i) => { t.ix[b.name] = i; });
    for (const n in t.sockets) t.sockets[n].bi = t.ix[t.sockets[n].bone];
    t.clips = {};
    if (t.rig === 'human') { const P = t.P; t.thL = P.hipJ - P.knee; t.shL = P.knee - P.ankle; t.legLen = P.hipJ - P.ankle + 0.07 * P.k; }
    t.radius = t.rig === 'serpent' && !t.lurk ? 3.2 * t.k : t.h * 1.25;
    tpls.set(key, t);
    return t;
  }
  function clipFor(t, name) {
    if (!name) return null;
    if (t.clips[name] === undefined) { const lib = LIB[t.rig] || HC; const def = lib[name]; t.clips[name] = def ? compileClip(Object.assign({ name }, def), t.ix) : null; }
    return t.clips[name];
  }
  const glowOf = (look) => look.glow != null ? look.glow : 0xff7b2e;
  function create(u) {
    if (!u || !AB.scene || !atlas || views.has(u.uid)) return;
    let look, key;
    try { ({ key, look } = lookFor(u)); } catch (e) { console.warn('[actors] look', e); return; }
    if (look.rig === 'swarm') { createSwarm(u, look); return; }
    let t;
    try { t = template(key, look); } catch (e) { console.warn('[actors] template ' + key + ' failed', e); return; }
    const bones = t.bones.map((d) => { const b = new T.Bone(); b.name = d.name; b.position.set(d.p[0], d.p[1], d.p[2]); return b; });
    t.bones.forEach((d, i) => { if (d.parent >= 0) bones[d.parent].add(bones[i]); });
    const mat = makeMat({ glow: glowOf(look), glowI: look.glowI != null ? look.glowI : 2.4, glow2: look.glow2 || 0xff5a1a, glow2I: look.glow2I || 0, rim: look.rim || 0, env: look.rig === 'human' ? 0.55 : 0.4 });
    if (look.ghost) { mat.transparent = true; mat.opacity = look.ghost; mat.depthWrite = true; }
    const mesh = new T.SkinnedMesh(t.geo, mat);
    mesh.add(bones[0]);
    mesh.bind(new T.Skeleton(bones));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.boundingSphere = new T.Sphere(new V3(0, t.h * 0.5, t.rig === 'serpent' && !t.lurk ? -1.0 * t.k : 0), t.radius);
    mesh.name = 'actor:' + u.id;
    const root = new T.Group();
    root.name = 'unit:' + u.id;
    root.add(mesh);
    const sc = (u.height || t.h) / t.h;
    root.scale.setScalar(sc);
    root.position.copy(u.pos);
    root.rotation.y = u.facing;
    AB.scene.add(root);
    const nb = bones.length;
    const v = { u, t, look, rig: t.rig, mesh, mat, root, bones, nb, scale: sc,
      rot: new Float32Array(nb * 3), prev: new Float32Array(nb * 3), out: new Float32Array(nb * 3), rp: [0, 0, 0], rr: [0, 0, 0], prp: [0, 0, 0], prr: [0, 0, 0], orp: [0, 0, 0], orr: [0, 0, 0],
      base: '', fadeT: 1, fadeDur: 0.15, phase: Math.random() * TAU, tph: 0, spd: 0, vfwd: 0, vside: 0, acc: 0, yaw: u.facing, yawRate: 0, alert: 0, act: null, hit: null, death: null,
      springs: {}, time: Math.random() * 20, seed: Math.random() * 10, lastPh: 0, lookYaw: 0, lookT: 0, lookUid: 0, skip: 0, skipDt: 0, opacity: look.ghost || 1, hidden: false, chosen: false,
      ix: t.ix, legs: null, stepFeet: null, emberT: 0 };
    if (t.rig === 'spider') v.legs = t.legs.map((l) => ({ plant: new V3(), from: new V3(), to: new V3(), st: 0, stepping: false, init: false }));
    views.set(u.uid, v);
    u.view = root;
    try { animate(v, 1 / 60); } catch (e) { console.warn('[actors] first pose', e); }
  }
  function createSwarm(u, look) {
    const n = Math.max(6, Math.round(look.n * (AB.quality.settings.particles != null ? 0.5 + 0.5 * AB.quality.settings.particles : 1)));
    const mat = swarmMaterial(look);
    const im = new T.InstancedMesh(swarmGeometry(look.kind), mat, n);
    im.frustumCulled = false; im.castShadow = look.kind === 'bat'; im.receiveShadow = false;
    const root = new T.Group(); root.name = 'unit:' + u.id; root.add(im);
    AB.scene.add(root);
    const bugs = [];
    for (let i = 0; i < n; i++) bugs.push({ a: Math.random() * TAU, r: 0.3 + Math.random() * 0.9, y: (Math.random() - 0.5) * 1.1, sp: (0.8 + Math.random() * 1.6) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * TAU, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 });
    const v = { u, look, rig: 'swarm', mesh: im, mat, root, bugs, time: Math.random() * 10, act: null, death: null, scale: (u.height || 1.6) / 1.6, center: new V3().copy(u.pos), surge: 0, contract: 0, hit: null };
    views.set(u.uid, v);
    u.view = root;
  }
  function remove(u) {
    const v = views.get(u.uid); if (!v) return;
    views.delete(u.uid);
    mats.delete(v.mat);
    if (v.mesh && v.mesh.isSkinnedMesh && v.mesh.skeleton) v.mesh.skeleton.dispose();
    AB.util.disposeObject(v.root);
    if (v.mat) v.mat.dispose();
    if (u.view === v.root) u.view = null;
  }

  // ---- helpers writing into the current view's pose arrays
  let CV = null;
  const R = (name, x, y, z) => { const i = CV.ix[name]; if (i == null) return; const o = i * 3; CV.rot[o] += x; CV.rot[o + 1] += y; CV.rot[o + 2] += z; };
  const RS = (name, x, y, z) => { const i = CV.ix[name]; if (i == null) return; const o = i * 3; CV.rot[o] = x; CV.rot[o + 1] = y; CV.rot[o + 2] = z; };
  function addPose(map, w) { if (!map) return; for (const n in map) { const q = map[n]; R(n, q[0] * w, (q[1] || 0) * w, (q[2] || 0) * w); } }
  function spring(st, target, k, c, dt) { const a = -k * (st.x - target) - c * st.v; st.v += a * dt; st.x += st.v * dt; if (st.x > 3) st.x = 3; if (st.x < -3) st.x = -3; return st.x; }
  const SP = (v, name) => v.springs[name] || (v.springs[name] = { x: 0, v: 0 });

  // ---- human: locomotion / idle / stance (writes base pose into rot, rp, rr)
  function humanLoco(v, dt) {
    const u = v.u, t = v.t, P = t.P, L = v.look, st = STYLE[L.style] || STYLE.hero, cr = CARRY[u.id];
    const spT = v.spd / v.scale, legLen = t.legLen;
    const rel = spT / legLen * 0.84;
    const mw = sstep(0.12, 0.7, spT), r = sstep(2.3, 4.3, rel);
    const time = v.time;
    if (L.style === 'float') {
      const m = Math.min(1, spT / 4);
      for (const [sd, s] of [['l', 1], ['r', -1]]) {
        R('thigh_' + sd, 0.2 + 0.4 * m + 0.06 * Math.sin(time * 1.3 + s), 0, s * 0.05); R('shin_' + sd, 0.35 + 0.2 * m, 0, 0); R('foot_' + sd, 0.5, 0, 0);
        R('upperarm_' + sd, 0.1 + 0.35 * m + 0.08 * Math.sin(time * 1.1 + s * 0.7), 0, s * (0.18 + 0.05 * Math.sin(time * 0.9 + s))); R('forearm_' + sd, -0.35 - 0.1 * Math.sin(time * 1.2 + s), 0, 0); R('hand_' + sd, 0.2, 0, 0);
      }
      R('spine', 0.08 + st.hunch * 0.5, 0, 0); R('chest', 0.06 + 0.03 * Math.sin(time * 1.6), 0, 0); R('neck', 0.15, 0, 0); R('head', 0.05 + 0.06 * Math.sin(time * 0.7), 0.25 * Math.sin(time * 0.31 + v.seed), 0);
      v.rp[1] += 0.07 * Math.sin(time * 1.8 + v.seed); v.rr[0] += 0.24 * m;
      return;
    }
    // stride-matched gait phase (backwards when moving against the facing)
    const back = v.vfwd < -0.3 * v.spd && v.spd > 0.5;
    const Lc = legLen * clamp(1.35 + 0.32 * rel, 1.35, 3.4) * st.stride;
    v.phase += TAU * spT / Lc * dt * (back ? -1 : 1) * st.cadence;
    // turning in place: shuffle
    const turn = (1 - mw) * sstep(0.7, 2.0, Math.abs(v.yawRate));
    if (turn > 0.01) v.tph += dt * (5 + Math.abs(v.yawRate) * 1.5);
    const A = Math.asin(clamp(Lc / (4 * legLen), 0, 0.9)) * (1 - 0.18 * r);
    const crouch = st.crouch + v.alert * 0.12 * (u.side === 'party' ? 1 : 0.6);
    let extMax = -1;
    const exts = [0, 0];
    for (let li = 0; li < 2; li++) {
      const sd = li === 0 ? 'l' : 'r', s = li === 0 ? 1 : -1;
      const ph = v.phase + li * PI;
      const sn = Math.sin(ph), cs = Math.cos(ph), swing = Math.max(0, cs);
      let th = (-A * sn - 0.1 * r) * mw;
      let kn = (0.05 + Math.pow(swing, 1.3) * (0.9 + 0.95 * r) + 0.28 * r * Math.max(0, -cs)) * mw;
      // shuffle while turning
      const tsn = Math.sin(v.tph + li * PI);
      th += -0.18 * Math.max(0, tsn) * turn; kn += 0.4 * Math.max(0, tsn) * turn;
      // stance crouch + combat stagger of the feet
      th += -crouch * 1.1 - v.alert * 0.12 * s * (1 - mw); kn += crouch * 2.1;
      const push = sstep(-0.2, -0.9, sn) * Math.max(0, -cs) * mw;
      const ft = -(th + kn) + 0.35 * push - 0.15 * swing * mw;
      RS('thigh_' + sd, th, (st.wide * 0.5) * s * 0, s * (st.wide + v.alert * 0.07 * (1 - mw) + 0.02));
      RS('shin_' + sd, kn, 0, 0);
      RS('foot_' + sd, ft, 0, -s * (st.wide + 0.02));
      exts[li] = t.thL * Math.cos(th) + t.shL * Math.cos(th + kn);
      extMax = Math.max(extMax, exts[li]);
    }
    const yWalk = extMax - (t.thL + t.shL);
    const yRun = (-0.035 * Math.cos(2 * v.phase) - 0.03) * legLen / 0.84 - crouch * 0.6 * legLen;
    v.rp[1] += lerp(yWalk, yRun, r * mw) * (0.6 + 0.4 * st.bob) + (st.bob - 1) * -0.02 * Math.abs(Math.sin(v.phase)) * mw;
    // hips and torso
    const sn = Math.sin(v.phase);
    const hipYaw = v.hipYaw || 0;
    R('hips', 0, hipYaw + 0.1 * A * sn * mw, 0.05 * sn * mw * (1 - 0.5 * r));
    const lean = (0.03 + 0.17 * r) * st.lean * mw + clamp(v.acc * 0.03, -0.15, 0.2) + v.alert * 0.08;
    const breath = Math.sin(time * 1.7 + v.seed) * 0.022 * (1 - mw * 0.5);
    R('spine', lean * 0.5 + st.hunch * 0.6, -0.08 * A * sn * mw, 0);
    R('chest', lean * 0.5 + st.hunch * 0.35 + breath, -0.15 * A * sn * mw - hipYaw * 0.85, 0);
    R('neck', -st.hunch * 0.45 - lean * 0.3, 0, 0);
    R('head', -st.hunch * 0.45 - lean * 0.4 + 0.02 * Math.sin(time * 0.6), 0, 0);
    // idle life: weight shift and a look around
    const idle = (1 - mw) * (1 - v.alert);
    R('hips', 0, 0, 0.025 * Math.sin(time * 0.45 + v.seed) * idle);
    R('head', 0, 0.28 * Math.sin(time * 0.21 + v.seed) * idle, 0.04 * Math.sin(time * 0.33) * idle);
    // personality in idle: Wren glances at the Emberheart, Tamsin sways to a tune, Maddoc leans on the staff...
    if (idle > 0.05) {
      const ph = time + v.seed * 3, cyc = (ph % 9) / 9, beat = Math.sin(time * 4.2);
      switch (u.id) {
        case 'wren': { const g = sstep(0.55, 0.65, cyc) * (1 - sstep(0.85, 0.95, cyc)) * idle; R('head', 0.45 * g, 0.35 * g, 0); R('upperarm_l', -0.25 * g, 0, 0); R('forearm_l', -0.3 * g, 0, 0); break; }
        case 'tamsin': R('hips', 0, 0, 0.04 * beat * idle); R('head', 0.05 * Math.abs(beat) * idle, 0, -0.06 * beat * idle); R('chest', 0, 0, -0.03 * beat * idle); break;
        case 'maddoc': R('spine', 0.06 * idle, 0, 0); R('chest', 0.04 * idle, -0.1 * idle, 0); R('upperarm_r', -0.1 * idle, 0, 0); break;
        case 'rook': R('hips', 0, 0.1 * idle, 0.06 * idle); R('thigh_l', -0.12 * idle, 0, 0.06 * idle); R('shin_l', 0.2 * idle, 0, 0); R('chest', 0, -0.1 * idle, -0.03 * idle); break;
        case 'neve': { const g = sstep(0.3, 0.38, cyc) * (1 - sstep(0.6, 0.68, cyc)) * idle; R('head', 0.2 * g, -0.4 * g, 0); R('upperarm_r', -0.6 * g, 0, 0.2 * g); R('forearm_r', -1.0 * g, 0, 0); break; }
        case 'brakka': { const g = Math.max(0, Math.sin(ph * 0.7)) * idle; R('chest', -0.05 * g, 0, 0); R('upperarm_l', 0, 0, 0.05 * g); R('upperarm_r', 0, 0, -0.05 * g); break; }
        case 'ysolde': R('head', 0, 0.35 * Math.sin(ph * 0.35) * idle, 0); R('spine', 0.04 * idle, 0, 0); break;
        default: break;
      }
    }
    // arms: swing opposite the legs, carry poses
    const Aa = (0.26 + 0.55 * r) * mw * st.armSwing;
    const sl = cr ? cr.swingL : 1, srr = cr ? cr.swingR : 1;
    R('upperarm_l', Aa * sn * sl, 0, 0.1 + 0.06 * r + 0.015 * Math.sin(time * 1.7));
    R('upperarm_r', -Aa * sn * srr, 0, -0.1 - 0.06 * r - 0.015 * Math.sin(time * 1.7));
    R('forearm_l', -(0.12 + 1.05 * r) * mw * sl - 0.1, 0, 0);
    R('forearm_r', -(0.12 + 1.05 * r) * mw * srr - 0.1, 0, 0);
    if (L.style === 'ghoul' || L.style === 'brute') { R('upperarm_l', -0.25, 0, 0.12); R('upperarm_r', -0.25, 0, -0.12); R('forearm_l', -0.3, 0, 0); R('forearm_r', -0.3, 0, 0); }
    if (cr) { addPose(cr.relax, 1 - v.alert); addPose(cr.ready, v.alert); }
    else if (L.props && L.props.length) {
      const p = L.props[0].t;
      const pole = p === 'spear' || p === 'halberd' || p === 'banner' || p === 'club';
      if (pole) addPose({ upperarm_r: [-0.25, 0, -0.15], forearm_r: [-1.35, 0, 0] }, 1 - v.alert * 0.5);
      if (pole) addPose({ upperarm_r: [-0.2, 0, -0.1], forearm_r: [0.3, 0, 0], hand_r: [0.9, 0, 0] }, v.alert * 0.5);
      if (p === 'greatsword' || p === 'maul' || p === 'warhammer' || p === 'treeclub') { addPose({ upperarm_r: [-0.1, 0, -0.15], forearm_r: [-0.35, 0, 0], hand_r: [1.35, 0, 0] }, 1 - v.alert); addPose({ upperarm_r: [-0.45, 0, -0.25], forearm_r: [-0.9, 0, 0], hand_r: [0.2, 0, 0], upperarm_l: [-0.6, -0.3, 0.1], forearm_l: [-1.1, 0, 0] }, v.alert); }
      if (p === 'knife' || p === 'cleaver' || p === 'scourge' || p === 'pick' || p === 'dagger') addPose({ upperarm_r: [-0.35, 0, -0.2], forearm_r: [-0.9, 0, 0], hand_r: [0.4, 0, 0] }, v.alert);
    }
    if (L.style === 'caster' && !(L.props && L.props.some((p) => p.t === 'club'))) addPose({ upperarm_l: [-0.35, 0, -0.1], forearm_l: [-1.4, 0.5, 0], upperarm_r: [-0.35, 0, 0.1], forearm_r: [-1.4, -0.5, 0] }, 0.6 * (1 - v.alert));
    // lean into turns (root roll) while moving
    v.rr[2] += clamp(-v.yawRate * spT * 0.025, -0.18, 0.18);
    // footsteps: one per half cycle (heel strike when a thigh is most forward)
    const q = Math.floor((v.phase - PI * 0.5) / PI);
    if (q !== v.stepQ) { if (v.stepQ != null && mw > 0.5) footfall(v, (q & 1) ? 'foot_r' : 'foot_l'); v.stepQ = q; }
  }
  function humanDowned(v) {
    const t = v.t, P = t.P, u = v.u;
    const rv = clamp((u.reviveT || 0) / 2, 0, 1), tm = v.time;
    RS('thigh_r', 0.05, 0, -0.06); RS('shin_r', 1.62, 0, 0); RS('foot_r', 0.95, 0, 0);
    RS('thigh_l', -1.3, 0, 0.14); RS('shin_l', 1.38, 0, 0); RS('foot_l', -0.08, 0, 0);
    RS('spine', 0.32 - rv * 0.2, 0.1, 0); RS('chest', 0.22 + 0.05 * Math.sin(tm * 3.1) - rv * 0.15, 0, 0); RS('neck', 0.2, 0, 0); RS('head', 0.45 - rv * 0.55, 0.15, 0);
    RS('upperarm_l', -0.85, 0, 0.12); RS('forearm_l', -0.55, 0, 0); RS('hand_l', 0.3, 0, 0);
    RS('upperarm_r', -0.15 - 0.1 * Math.sin(tm * 3.1), 0, -0.32); RS('forearm_r', -0.15, 0, 0); RS('hand_r', 0.6, 0, 0);
    v.rp[1] = (t.thL + 0.06 * P.k) - P.hipJ + 0.02 * Math.sin(tm * 3.1);
  }
  function humanStagger(v) {
    const tm = v.time * 1.0;
    R('spine', 0.1, 0, 0.18 * Math.sin(tm * 4.2)); R('chest', 0.05, 0, 0.1 * Math.sin(tm * 4.2 + 1)); R('head', 0.3 + 0.15 * Math.sin(tm * 3), 0.2 * Math.sin(tm * 2.1), 0.2 * Math.sin(tm * 2.7));
    R('upperarm_l', -0.2, 0, 0.4 + 0.1 * Math.sin(tm * 5)); R('upperarm_r', -0.2, 0, -0.4 - 0.1 * Math.sin(tm * 5.3)); R('forearm_l', -0.4, 0, 0); R('forearm_r', -0.4, 0, 0);
    for (const [sd, s] of [['l', 1], ['r', -1]]) { R('thigh_' + sd, -0.25, 0, s * 0.08); R('shin_' + sd, 0.5, 0, 0); R('foot_' + sd, -0.25, 0, 0); }
    v.rp[1] -= 0.06; v.rp[0] += 0.05 * Math.sin(tm * 4.2); v.rr[2] += 0.07 * Math.sin(tm * 4.2);
  }
  function humanDodge(v) {
    const u = v.u, P = v.t.P;
    const dur = (AB.combat && AB.combat.TUNE && AB.combat.TUNE.dodgeDur) || 0.42;
    const tau = clamp(u.anim.t / dur, 0, 1);
    if (v.look.style === 'float') { v.rr[0] += 0.55 * Math.sin(tau * PI); v.rp[1] += 0.1 * Math.sin(tau * PI); return; }
    const tuck = Math.sin(tau * PI);
    for (const [sd, s] of [['l', 1], ['r', -1]]) { RS('thigh_' + sd, -1.9 * tuck, 0, s * 0.1); RS('shin_' + sd, 2.1 * tuck, 0, 0); RS('foot_' + sd, -0.3 * tuck, 0, 0); RS('upperarm_' + sd, -1.3 * tuck, 0, s * 0.15); RS('forearm_' + sd, -1.6 * tuck, 0, 0); }
    RS('spine', 0.7 * tuck, 0, 0); RS('chest', 0.5 * tuck, 0, 0); RS('head', 0.7 * tuck, 0, 0); RS('neck', 0.2 * tuck, 0, 0);
    const th = TAU * sstep(0.06, 0.94, tau), hc = P.hipJ * 0.5;
    v.rr[0] = th;
    v.rp[1] = hc * (1 - Math.cos(th)) - 0.12 * P.hipJ * tuck; v.rp[2] = -hc * Math.sin(th);
  }
  function humanDeath(v, dt) {
    const d = v.death, P = v.t.P, st = v.look.style, tm = d.t;
    if (st === 'float') {
      const k = sstep(0, 1.4, tm);
      R('head', -0.5 * k, 0, 0); R('chest', -0.3 * k, 0, 0); R('upperarm_l', -2.2 * k, 0, 0.5 * k); R('upperarm_r', -2.2 * k, 0, -0.5 * k);
      v.rp[1] -= tm * 0.5; v.rr[0] -= 0.25 * k; v.fade = 1 - sstep(0.2, 1.6, tm);
      return;
    }
    const k1 = sstep(0, 0.28, tm), k2 = Math.pow(sstep(0.12, 0.78, tm), 1.7), k3 = sstep(0.75, 1.5, tm);
    const fwd = d.fz > 0.3, side = Math.abs(d.fx) > Math.abs(d.fz);
    for (const [sd, s] of [['l', 1], ['r', -1]]) {
      RS('thigh_' + sd, lerp(-0.55 * k1, -0.15, k3), 0, s * 0.12 * k2); RS('shin_' + sd, lerp(1.1 * k1, 0.25, k3), 0, 0); RS('foot_' + sd, lerp(-0.35 * k1, 0.4, k3), 0, 0);
      const flop = st === 'construct' ? 0.2 : 1;
      RS('upperarm_' + sd, lerp(-0.3 * k1, fwd ? -1.6 : -0.35, k3 * flop) + (fwd ? -0.6 * k2 * (1 - k3) : 0), 0, s * lerp(0.5 * k1, fwd ? 0.3 : 1.15, k3 * flop));
      RS('forearm_' + sd, lerp(-0.6 * k1, -0.25, k3), 0, 0);
    }
    RS('spine', (fwd ? 0.25 : -0.15) * k1 * (1 - k3), 0, 0); RS('chest', (fwd ? 0.2 : -0.2) * k1 * (1 - k3), 0, 0);
    RS('head', (fwd ? 0.2 : -0.45) * k1 * (1 - k3) + (fwd ? -0.3 : 0.1) * k3, 0.65 * k3 * (d.side || 1), 0);
    const th = (PI / 2 - 0.1) * k2 + (tm > 0.78 ? 0.06 * Math.sin((tm - 0.78) * 16) * Math.exp(-(tm - 0.78) * 7) : 0);
    if (side) v.rr[2] = -th * Math.sign(d.fx); else v.rr[0] = fwd ? th : -th;
    v.rp[1] = lerp(-0.26 * k1 * P.hipJ, 0.07 * P.k, k2);
    void dt;
  }

  // ---- quadruped
  const GAITS = { walk: [0.25, 0.75, 0.0, 0.5], trot: [0.0, 0.5, 0.5, 0.0], gallop: [0.55, 0.65, 0.0, 0.1] };
  const QLEG = [['fu_l', 'fl_l', 'fp_l', 1, true], ['fu_r', 'fl_r', 'fp_r', -1, true], ['bu_l', 'bl_l', 'bh_l', 1, false], ['bu_r', 'bl_r', 'bh_r', -1, false]];
  function quadGait(v, offs, A, flex, w) {
    for (let i = 0; i < 4; i++) {
      const [up, lo, pw, , front] = QLEG[i];
      const ph = (v.phase / TAU + offs[i]) * TAU, sn = Math.sin(ph), cs = Math.cos(ph), sw = Math.max(0, cs);
      R(up, -A * sn * w, 0, 0);
      if (front) { R(lo, Math.pow(sw, 1.4) * flex * 1.3 * w, 0, 0); R(pw, -Math.pow(sw, 1.2) * flex * 0.6 * w, 0, 0); }
      else { R(lo, -Math.pow(sw, 1.4) * flex * 0.8 * w, 0, 0); R(pw, Math.pow(sw, 1.4) * flex * 1.1 * w, 0, 0); }
    }
  }
  function quadLoco(v, dt) {
    const t = v.t, k = t.k, spT = v.spd / v.scale, tm = v.time;
    const mw = sstep(0.1, 0.6, spT);
    const trot = sstep(1.6, 2.6, spT / k), gal = sstep(3.6, 4.8, spT / k);
    const Lc = k * (gal > 0.5 ? 2.3 : trot > 0.5 ? 1.35 : 0.95);
    v.phase += TAU * spT / Lc * dt;
    const A = (0.35 + 0.25 * trot + 0.3 * gal) * mw, flex = (0.55 + 0.4 * gal) * mw;
    const wWalk = (1 - trot) * (1 - gal), wTrot = trot * (1 - gal), wGal = gal;
    if (wWalk > 0.01) quadGait(v, GAITS.walk, A, flex, wWalk);
    if (wTrot > 0.01) quadGait(v, GAITS.trot, A, flex, wTrot);
    if (wGal > 0.01) quadGait(v, GAITS.gallop, A * 1.15, flex * 1.1, wGal);
    const ph = v.phase;
    R('spine', 0.12 * Math.sin(ph) * gal, 0.03 * Math.sin(ph) * mw * (1 - gal), 0);
    R('chest', -0.08 * Math.sin(ph) * gal, 0, 0.02 * Math.sin(ph) * mw);
    R('pelvis', 0.08 * Math.sin(ph + 1) * gal, 0, -0.03 * Math.sin(ph) * mw * (1 - gal));
    v.rp[1] += (-0.02 * Math.cos(2 * ph) * (1 - gal) + 0.05 * Math.sin(ph) * gal) * k * mw;
    v.rr[0] += 0.05 * Math.sin(ph) * gal;
    R('neck', 0.15 * mw + (v.alert * 0.3) - 0.06 * Math.sin(tm * 0.5) * (1 - mw), 0.15 * Math.sin(tm * 0.3 + v.seed) * (1 - mw), 0);
    R('head', -0.08 * Math.sin(2 * ph) * mw - v.alert * 0.15, 0, 0);
    R('jaw', (0.15 + 0.08 * Math.sin(tm * 6)) * (mw * 0.6 + v.alert * 0.5), 0, 0);
    // alert crouch (stalking)
    if (v.alert > 0) { for (const n of ['fu_l', 'fu_r']) R(n, 0.15 * v.alert, 0, 0); for (const n of ['fl_l', 'fl_r']) R(n, 0.3 * v.alert, 0, 0); for (const n of ['bu_l', 'bu_r']) R(n, -0.2 * v.alert, 0, 0); for (const n of ['bl_l', 'bl_r']) R(n, -0.15 * v.alert, 0, 0); for (const n of ['bh_l', 'bh_r']) R(n, 0.45 * v.alert, 0, 0); v.rp[1] -= 0.08 * k * v.alert; }
    // breathing + tail
    R('chest', 0.02 * Math.sin(tm * 2.4), 0, 0);
    const ts = SP(v, 'tail');
    spring(ts, Math.sin(tm * (1.2 + 3 * mw)) * (0.25 + 0.2 * mw) + v.yawRate * 0.2, 60, 6, dt);
    R('tail0', -0.2 + 0.35 * mw - v.alert * 0.2, ts.x * 0.5, 0); R('tail1', 0.15, ts.x * 0.6, 0); R('tail2', 0.15, ts.x * 0.8, 0);
    const q = Math.floor(ph / PI);
    if (q !== v.stepQ) { if (v.stepQ != null && mw > 0.5) footfall(v, (q & 1) ? 'foot_fl' : 'foot_br', true); v.stepQ = q; }
  }
  function quadDeath(v) {
    const d = v.death, tm = d.t, k = Math.pow(sstep(0.05, 0.6, tm), 1.5), k3 = sstep(0.5, 1.2, tm);
    for (const [up, lo, pw] of QLEG) { RS(up, -0.3 * k3, 0, 0); RS(lo, 0.4 * k, 0, 0); RS(pw, -0.2 * k, 0, 0); }
    RS('neck', 0.3 * k, 0, 0); RS('head', 0.2 * k, 0, 0); RS('jaw', 0.35 * k3, 0, 0);
    v.rr[2] = (PI / 2 - 0.15) * k * (d.side || 1);
    v.rp[1] = -0.1 * v.t.k * k;
  }
  // ---- spider: IK legs with planted feet and alternating steps
  const _hipW = new V3(), _tgt = new V3(), _kneeL = new V3(), _ftL = new V3(), _dirA = new V3(), _dirB = new V3(), _upL = new V3(), _m4 = new T.Matrix4(), _qa = new T.Quaternion();
  function spiderLegs(v, dt) {
    const t = v.t, k = t.k, body = v.bones[t.ix.body], rootM = v.root.matrixWorld;
    const inv = _m4.copy(body.matrixWorld).invert();
    const vel = v.u.vel, dead = !!v.death, strike = v.act && v.act.cl && v.act.cl.name === 'sbite' ? Math.sin(clamp(v.act.tau, 0, 1.6) / 1.6 * PI) : 0;
    let groupStepping = [false, false];
    for (let i = 0; i < 8; i++) if (v.legs[i].stepping) groupStepping[(i + (i >= 4 ? 1 : 0)) % 2] = true;
    for (let i = 0; i < 8; i++) {
      const L = t.legs[i], st = v.legs[i], grp = (i + (i >= 4 ? 1 : 0)) % 2;
      // desired foot (world): rest foot in root space + velocity lead
      _tgt.copy(L.foot).multiplyScalar(dead ? 0.35 : 1);
      if (dead) _tgt.y = 0.3 * k;
      _tgt.applyMatrix4(rootM);
      _tgt.x += vel.x * 0.16; _tgt.z += vel.z * 0.16;
      _tgt.y = (AB.world && AB.world.heightAt ? AB.world.heightAt(_tgt.x, _tgt.z) : v.u.pos.y) + (dead ? 0.35 * k * v.scale : 0);
      if (!st.init || st.plant.distanceToSquared(_tgt) > 9 * v.scale * v.scale) { st.plant.copy(_tgt); st.init = true; st.stepping = false; }
      if (!st.stepping && !groupStepping[1 - grp] && st.plant.distanceTo(_tgt) > 0.22 * k * v.scale) { st.stepping = true; st.st = 0; st.from.copy(st.plant); st.to.copy(_tgt); groupStepping[grp] = true; }
      let fx, fy, fz;
      if (st.stepping) {
        st.st += dt / 0.13; st.to.lerp(_tgt, 0.3);
        const q = clamp(st.st, 0, 1);
        fx = lerp(st.from.x, st.to.x, q); fz = lerp(st.from.z, st.to.z, q); fy = lerp(st.from.y, st.to.y, q) + Math.sin(q * PI) * 0.18 * k * v.scale;
        if (st.st >= 1) { st.stepping = false; st.plant.copy(st.to); if (i === 0 || i === 5) footfall(v, null, true, st.plant); }
      } else { fx = st.plant.x; fy = st.plant.y; fz = st.plant.z; }
      // raise the front legs during a bite
      if (i % 4 === 0 && strike > 0) { _ftL.set(fx, fy, fz); _upL.copy(L.knee).applyMatrix4(rootM); _ftL.lerp(_upL, strike * 0.8); _ftL.y += strike * 0.35 * k * v.scale; fx = _ftL.x; fy = _ftL.y; fz = _ftL.z; }
      // IK in body space
      _ftL.set(fx, fy, fz).applyMatrix4(inv);
      _hipW.copy(L.att).sub(t.bones[t.ix.body].p ? _v1.set(t.bones[t.ix.body].p[0], t.bones[t.ix.body].p[1], t.bones[t.ix.body].p[2]) : _v1.set(0, 0, 0));
      const hip = _hipW;   // attachment in body-local (body bind at its own position; identity rotation)
      const L1 = L.L1, L2 = L.L2;
      _dirA.subVectors(_ftL, hip); let d = _dirA.length(); if (d < 1e-4) d = 1e-4;
      _dirA.divideScalar(d); d = Math.min(d, (L1 + L2) * 0.999);
      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      _upL.set(0, 1, 0).addScaledVector(_dirA, -_dirA.y); if (_upL.lengthSq() < 1e-6) _upL.set(1, 0, 0); _upL.normalize();
      _kneeL.copy(hip).addScaledVector(_dirA, a).addScaledVector(_upL, hgt);
      const bA = v.bones[t.ix['lega' + i]], bB = v.bones[t.ix['legb' + i]];
      const bindA = _v2.subVectors(L.knee, L.att).normalize();
      _dirB.subVectors(_kneeL, hip).normalize();
      bA.quaternion.setFromUnitVectors(bindA, _dirB);
      const bindB = _v3.subVectors(L.foot, L.knee).normalize();
      _dirB.subVectors(_ftL, _kneeL).normalize().applyQuaternion(_qa.copy(bA.quaternion).invert());
      bB.quaternion.setFromUnitVectors(bindB, _dirB);
    }
  }
  // ---- serpent
  function serpentPose(v, dt) {
    const t = v.t, N = t.N, tm = v.time, spT = v.spd / v.scale, mw = sstep(0.1, 0.8, spT);
    const act = v.act, tau = act ? act.tau : 0, aw = act ? act.w : 0;
    const rear = act ? sstep(0.2, 0.95, Math.min(tau, 1)) * (1 - sstep(1.0, 1.08, tau)) : 0;
    const strike = act ? sstep(0.95, 1.05, tau) * (1 - sstep(1.3, 2.0, tau)) : 0;
    v.phase += dt * (1.2 + spT * 2.2);
    if (v.submergeT > 0) { v.submergeT -= dt / 2.4; v.submerge = Math.sin(clamp(1 - v.submergeT, 0, 1) * PI); } else v.submerge = 0;
    if (t.lurk) {
      for (let i = 0; i < N; i++) {
        const f = i / (N - 1);
        const base = f < 0.25 ? 0.03 : f < 0.6 ? -0.2 : 0.3;
        const sway = Math.sin(tm * 1.4 - i * 0.6) * 0.07 * (0.5 + f);
        RS('sp' + i, base + sway - rear * 0.16 * f * aw + strike * 0.3 * f * aw, Math.sin(v.phase - i * 0.7) * 0.12 * mw * (1 - f), Math.sin(tm * 1.1 - i * 0.5) * 0.06 * f);
      }
      RS('head', -0.55 + Math.sin(tm * 0.9) * 0.08 + rear * 0.2, 0, 0);
      v.rp[1] += Math.sin(tm * 1.3) * 0.05 * v.t.k - (v.submerge || 0) * 1.6 * v.t.k;
    } else {
      for (let i = 0; i < N; i++) {
        const f = i / (N - 1), front = sstep(0.6, 1, f);
        const und = Math.sin(v.phase * 2.2 - i * 0.75) * (0.12 + 0.18 * mw) * (1 - front * 0.7);
        const lift = -0.3 * sstep(0.55, 0.95, f);
        RS('sp' + i, lift - rear * front * 0.25 * aw + strike * front * 0.35 * aw, und, 0);
      }
      RS('head', 0.75 + rear * 0.15 * aw - strike * 0.2 * aw, Math.sin(tm * 0.7) * 0.15, 0);
      v.rp[1] -= (v.submerge || 0) * 1.0 * v.t.k;
    }
  }
  function serpentDeath(v) {
    const d = v.death, k = sstep(0, 1.0, d.t), N = v.t.N;
    for (let i = 0; i < N; i++) { const o = v.ix['sp' + i] * 3; v.rot[o] *= 1 - k; v.rot[o + 2] += (v.t.lurk ? 0.25 : 0.05) * k * (d.side || 1); if (v.t.lurk) v.rot[o] += 0.08 * k; }
    v.rot[v.ix.jaw * 3] = 0.5 * k;
    if (v.t.lurk) v.rp[1] -= k * 1.4 * v.t.k; else v.rr[2] += 0.5 * k * (d.side || 1);
  }

  function footfall(v, sock, heavy, at) {
    if (AB.loop.fastForwarding || !AB.camera) return;
    const p = _v4;
    if (at) p.copy(at); else if (!socketWorld(v, sock, p)) return;
    if (AB.camera.position.distanceToSquared(p) > 1600) return;
    const surface = AB.world && AB.world.surfaceAt ? AB.world.surfaceAt(p.x, p.z) : 'dirt';
    const y = AB.world && AB.world.heightAt ? AB.world.heightAt(p.x, p.z) : p.y;
    const big = v.scale > 1.3 || v.look.style === 'brute' || v.look.style === 'construct';
    AB.bus.emit('actors:step', { unit: v.u, x: p.x, y, z: p.z, surface, foot: sock, heavy: !!(heavy && big) || big });
    if (AB.vfx && AB.vfx.spawn) AB.vfx.spawn('step', { x: p.x, y, z: p.z, surface, scale: v.scale * (big ? 1.8 : 1) });
    if (big && v.scale > 1.5 && AB.cam && AB.camera.position.distanceToSquared(p) < 400) AB.cam.shake(0.03 * v.scale, 0.12);
  }

  // =====================================================================================================
  // 9. PER-FRAME POSING
  // =====================================================================================================
  const _sw = new V3(), _qp = new T.Quaternion(), _qs = new T.Quaternion(), _eu = new T.Euler(), _mInv = new T.Matrix4();
  function socketWorld(v, name, out) {
    if (!v || !v.t) return false;
    const s = v.t.sockets[name]; if (!s || s.bi == null) return false;
    out.set(s.off[0], s.off[1], s.off[2]).applyMatrix4(v.bones[s.bi].matrixWorld);
    return true;
  }
  function baseKind(v) {
    const u = v.u;
    if (v.death) return 'dead';
    const s = u.anim ? u.anim.state : 'idle';
    if (s === 'downed') return 'downed';
    if (s === 'dodge') return 'dodge';
    if (s === 'stagger') return 'stagger';
    return 'loco';
  }
  const FADE_IN = { dodge: 0.06, downed: 0.3, stagger: 0.15, dead: 0.08, loco: 0.18 };
  function startAct(v, name, mode, o) {
    const cl = clipFor(v.t, name); if (!cl) return;
    v.act = Object.assign({ cl, mode, t: 0, age: 0, tau: 0, w: 0, ref: null, windup: 0.8, dur: cl.dur }, o || {});
  }
  function updateAct(v, dt) {
    const a = v.act; if (!a) return;
    a.age += dt; a.t += dt;
    const u = v.u;
    if (a.mode === 'act') {
      const x = u.action;
      if (x && x === a.ref) a.tau = x.t < x.hitAt ? x.t / Math.max(0.01, x.hitAt) : 1 + (x.t - x.hitAt) / Math.max(0.05, x.dur - x.hitAt);
      else { a.mode = 'free'; a.rate = 1 / 0.3; }
    } else if (a.mode === 'windup') {
      a.tau = Math.min(0.97, a.t / Math.max(0.1, a.windup));
      if (!u.atk && a.t > a.windup + 0.25) { a.mode = 'free'; a.rate = 1 / 0.25; }
    } else if (a.mode === 'strike') a.tau = 1 + a.t / a.dur;
    else if (a.mode === 'free') a.tau = Math.min(2, a.tau + dt * (a.rate || 1 / 0.5));
    else if (a.mode === 'timed') a.tau = Math.min(2, a.t / a.dur * 2);
    const fin = 1 - sstep(1.7, 2.0, a.tau), fadeIn = sstep(0, 0.07, a.age);
    a.w = fin * fadeIn;
    if (a.tau >= 2) v.act = null;
  }
  function animate(v, dt) {
    const u = v.u;
    v.time += dt;
    // smoothed motion state
    const sp = Math.hypot(u.vel.x, u.vel.z);
    const prevSp = v.spd;
    v.spd = U.damp(v.spd, sp, 12, dt);
    v.acc = U.damp(v.acc, (v.spd - prevSp) / Math.max(dt, 1e-3), 6, dt);
    const fy = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    v.vfwd = u.vel.x * fy + u.vel.z * fz; v.vside = u.vel.x * fz - u.vel.z * fy;
    const prevYaw = v.yaw;
    v.yaw = U.dampAngle(v.yaw, u.facing, v.death ? 2 : 14, dt);
    v.yawRate = U.damp(v.yawRate, U.wrapAngle(v.yaw - prevYaw) / Math.max(dt, 1e-3), 10, dt);
    // hips turn toward a sideways move while the torso keeps facing (strafe)
    let mdir = 0;
    if (v.spd > 0.6) { mdir = Math.atan2(v.vside, v.vfwd); if (Math.abs(mdir) > PI * 0.62) mdir = U.wrapAngle(mdir - PI); }
    v.hipYaw = U.damp(v.hipYaw || 0, clamp(-mdir * 0.6, -0.8, 0.8), 8, dt);
    // combat alertness
    const engaged = u.side === 'foe' ? !!(u.enc && u.enc.engaged) : (AB.combat && AB.combat.inCombat && u.kind !== 'display') || (u.kind === 'display' && v.chosen);
    v.alert = U.damp(v.alert, engaged && !u.downed ? 1 : 0, 3, dt);
    // reset pose
    CV = v;
    v.rot.fill(0); v.rp[0] = v.rp[1] = v.rp[2] = 0; v.rr[0] = v.rr[1] = v.rr[2] = 0;
    // base layer (with crossfade on change)
    const bk = baseKind(v);
    if (bk !== v.base) {
      v.prev.set(v.out); v.prp[0] = v.orp[0]; v.prp[1] = v.orp[1]; v.prp[2] = v.orp[2]; v.prr[0] = v.orr[0]; v.prr[1] = v.orr[1]; v.prr[2] = v.orr[2];
      v.fadeT = 0; v.fadeDur = v.base === 'downed' && bk === 'loco' ? 0.7 : v.base === 'dodge' ? 0.16 : FADE_IN[bk] || 0.15;
      if (v.base === 'dodge' && v.rr) { v.prr[0] = U.wrapAngle(v.prr[0]); }
      v.base = bk;
    }
    if (v.death) v.death.t += dt;
    updateAct(v, dt);
    if (v.rig === 'human') {
      if (bk === 'dead') humanDeath(v, dt);
      else if (bk === 'downed') humanDowned(v);
      else if (bk === 'dodge') humanDodge(v);
      else { humanLoco(v, dt); if (bk === 'stagger') humanStagger(v); }
      if (v.act && bk !== 'dead' && bk !== 'downed' && bk !== 'dodge') applyClip(v.act.cl, v.act.tau, v.act.w, v.spd > 1.0 * v.scale, v.rot, v.rp, v.rr);
      headLook(v, dt);
    } else if (v.rig === 'quad') {
      // pitch the body to the slope under it (front and back legs on different ground heights)
      if (AB.world && AB.world.heightAt) {
        const L = 0.8 * v.t.k * v.scale, fx = Math.sin(v.yaw) * L * 0.5, fz = Math.cos(v.yaw) * L * 0.5;
        const dh = AB.world.heightAt(u.pos.x + fx, u.pos.z + fz) - AB.world.heightAt(u.pos.x - fx, u.pos.z - fz);
        v.slope = U.damp(v.slope || 0, clamp(-Math.atan2(dh, L), -0.5, 0.5), 8, dt);
        v.rr[0] += v.slope;
      }
      if (bk === 'dead') quadDeath(v); else { quadLoco(v, dt); if (bk === 'stagger') { R('neck', 0.3, 0.2 * Math.sin(v.time * 4), 0); v.rr[2] += 0.08 * Math.sin(v.time * 5); } }
      if (v.act && bk !== 'dead') applyClip(v.act.cl, v.act.tau, v.act.w, false, v.rot, v.rp, v.rr);
    } else if (v.rig === 'spider') {
      R('body', 0.02 * Math.sin(v.time * 2), 0, 0); R('abdomen', 0.04 * Math.sin(v.time * 1.6), 0.05 * Math.sin(v.time * 0.7), 0);
      if (bk === 'dead') { v.rp[1] = -0.25 * v.t.k * sstep(0, 0.4, v.death.t); R('abdomen', 0.3, 0, 0); }
      if (v.act && bk !== 'dead') applyClip(v.act.cl, v.act.tau, v.act.w, false, v.rot, v.rp, v.rr);
      if (v.spd > 0.5) { v.rp[1] += 0.015 * Math.sin(v.time * 18); }
    } else if (v.rig === 'serpent') {
      serpentPose(v, dt);
      if (bk === 'dead') serpentDeath(v);
      else if (v.act) applyClip(v.act.cl, v.act.tau, v.act.w, false, v.rot, v.rp, v.rr);
    }
    // additive hit reaction (direction-aware kick)
    if (v.hit && bk !== 'dead') {
      const h = v.hit; h.t += dt;
      const tau = h.heavy ? 0.09 : 0.06, kk = (h.t / tau) * Math.exp(1 - h.t / tau), amp = (h.heavy ? 0.5 : 0.28) * kk;
      if (v.rig === 'human') {
        R('spine', h.lz * amp, 0, -h.lx * amp * 0.8); R('chest', h.lz * amp * 0.6, h.lx * amp * 0.4, 0); R('head', h.lz * amp * 0.9, 0, -h.lx * amp * 0.6);
        R('upperarm_l', -0.2 * amp, 0, 0.5 * amp); R('upperarm_r', -0.2 * amp, 0, -0.5 * amp);
      } else if (v.rig === 'quad') { R('chest', h.lz * amp, 0, 0); R('neck', h.lz * amp, h.lx * amp, 0); }
      else if (v.rig === 'serpent') { R('sp' + (v.t.N - 2), h.lz * amp, h.lx * amp, 0); R('head', h.lz * amp, 0, 0); }
      else if (v.rig === 'spider') R('body', h.lz * amp * 0.6, 0, -h.lx * amp * 0.6);
      v.rp[0] += h.lx * 0.08 * kk; v.rp[2] += h.lz * 0.08 * kk;
      if (h.t > 0.6) v.hit = null;
    }
    // crossfade from the previous base
    let out = v.rot, rp = v.rp, rr = v.rr;
    if (v.fadeT < v.fadeDur) {
      v.fadeT += dt;
      const k = sstep(0, 1, v.fadeT / v.fadeDur);
      const o = v.out, p = v.prev;
      for (let i = 0; i < o.length; i++) o[i] = p[i] + (out[i] - p[i]) * k;
      for (let i = 0; i < 3; i++) { v.orp[i] = v.prp[i] + (rp[i] - v.prp[i]) * k; v.orr[i] = v.prr[i] + (rr[i] - v.prr[i]) * k; }
      out = o; rp = v.orp; rr = v.orr;
    } else { v.out.set(out); v.orp[0] = rp[0]; v.orp[1] = rp[1]; v.orp[2] = rp[2]; v.orr[0] = rr[0]; v.orr[1] = rr[1]; v.orr[2] = rr[2]; }
    // apply to bones (spider legs are IK and keep their quaternions)
    const bones = v.bones;
    for (let i = 1; i < v.nb; i++) {
      const b = bones[i];
      if (v.rig === 'spider' && b.name.startsWith('leg')) continue;
      b.rotation.set(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    }
    // blinks (eyes bone squashes for ~0.12 s every few seconds; closed while downed or dead)
    if (v.ix.eyes != null) {
      v.blinkT = (v.blinkT == null ? Math.random() * 4 : v.blinkT) - dt;
      if (v.blinkT < -0.12) v.blinkT = 2 + Math.random() * 4;
      const shut = bk === 'dead' || (bk === 'downed' && Math.sin(v.time * 0.7) > 0.3) || v.look.eyeGlow ? (v.look.eyeGlow && bk !== 'dead' ? 0 : 1) : (v.blinkT < 0 ? 1 : 0);
      bones[v.ix.eyes].scale.set(1, 1 - 0.85 * shut, 1);
    }
    // root transform: unit position + facing + offsets (template metres scaled)
    const sc = v.scale;
    v.root.position.set(u.pos.x, u.pos.y, u.pos.z);
    v.root.rotation.set(0, v.yaw, 0);
    bones[0].position.set(rp[0], rp[1], rp[2]);
    bones[0].rotation.set(rr[0], rr[1], rr[2], 'YXZ');
    void sc;
    // secondary motion
    springs(v, dt);
    v.root.updateMatrixWorld(true);
    if (v.rig === 'human' && (bk === 'loco' || bk === 'stagger') && v.look.style !== 'float') { if (footIK(v, dt)) v.root.updateMatrixWorld(true); }
    if (v.rig === 'spider') { spiderLegs(v, dt); v.root.updateMatrixWorld(true); }
    props(v, dt);
    materials(v, dt);
  }
  // ground the feet on slopes: drop the pelvis to the lower foot and bend the other knee (stance feet only)
  const _fl = new V3(), _fr = new V3();
  function footIK(v, dt) {
    if (!AB.world || !AB.world.heightAt) return false;
    if (!socketWorld(v, 'foot_l', _fl) || !socketWorld(v, 'foot_r', _fr)) return false;
    const t = v.t, P = t.P, sc = v.scale, sole = 0.012 * P.k;
    const mw = sstep(0.12, 0.7, v.spd / sc);
    const cs = Math.cos(v.phase);
    const wl = mw > 0.3 ? sstep(0.25, -0.35, cs) : 1, wr = mw > 0.3 ? sstep(0.25, -0.35, -cs) : 1;
    const eL = clamp((AB.world.heightAt(_fl.x, _fl.z) - _fl.y) / sc + sole, -0.4, 0.4) * wl, eR = clamp((AB.world.heightAt(_fr.x, _fr.z) - _fr.y) / sc + sole, -0.4, 0.4) * wr;
    const drop = clamp(Math.min(eL, eR, 0), -0.3, 0);
    v.ikDrop = U.damp(v.ikDrop || 0, drop, 14, dt);
    v.ikL = U.damp(v.ikL || 0, Math.max(0, eL - drop), 14, dt);
    v.ikR = U.damp(v.ikR || 0, Math.max(0, eR - drop), 14, dt);
    if (Math.abs(v.ikDrop) < 0.004 && v.ikL < 0.004 && v.ikR < 0.004) return false;
    const ix = v.ix, B = v.bones, ll = t.thL + t.shL;
    v.bones[0].position.y += v.ikDrop;
    for (const [sd, r] of [['l', v.ikL], ['r', v.ikR]]) {
      if (r < 0.004) continue;
      const a = clamp(r / ll * 1.25, 0, 0.75);
      B[ix['thigh_' + sd]].rotation.x -= a; B[ix['shin_' + sd]].rotation.x += 2 * a; B[ix['foot_' + sd]].rotation.x -= a;
    }
    return true;
  }
  // springs: cloak columns, braid, scarf
  function springs(v, dt) {
    if (v.rig !== 'human') return;
    const ix = v.ix, u = v.u, sc = v.scale;
    const spT = v.spd / sc, f = clamp(v.vfwd / sc, -2, 7), side = clamp(v.vside / sc, -4, 4);
    const tm = v.time, wind = (AB.world && AB.world.uniforms && AB.world.uniforms.uWind) ? 1 : 1;
    const dead = !!v.death;
    if (ix.clk00 != null) {
      const legBack = Math.max(v.out[ix.thigh_l * 3] || 0, v.out[ix.thigh_r * 3] || 0, 0);
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
        const s = SP(v, 'cx' + c + r), sz = SP(v, 'cz' + c + r);
        const tgt = (dead ? 0 : f * 0.075 * (0.6 + r * 0.25) + Math.max(0, -v.acc) * 0.0 + 0.05 * Math.sin(tm * 1.7 + c + r) * wind) + (r > 0 ? legBack * 0.35 : 0) + (v.base === 'dodge' ? 0.4 : 0);
        spring(s, clamp(tgt, -0.25, 1.1), 40 - r * 8, 5, dt);
        spring(sz, -side * 0.06 + 0.05 * Math.sin(tm * 1.3 + c * 1.7) * (r + 1) * 0.5 + (c - 1) * Math.min(0.25, spT * 0.03), 34, 5, dt);
        const b = v.bones[ix['clk' + c + r]];
        b.rotation.set(s.x * (r === 0 ? 0.6 : 0.5), 0, sz.x * 0.5);
      }
    }
    if (ix.braid0 != null) {
      const s = SP(v, 'braid'), sz = SP(v, 'braidz');
      spring(s, clamp(f * 0.09, -0.2, 0.7) + 0.05 * Math.sin(tm * 2), 30, 3.5, dt); spring(sz, -side * 0.08 - v.yawRate * 0.12, 26, 3, dt);
      for (const n of ['braid0', 'braid1', 'braid2']) v.bones[ix[n]].rotation.set(s.x * 0.6 + (n === 'braid0' ? 0.15 : 0), 0, sz.x * 0.6);
    }
    if (ix.scarf0 != null) {
      const s = SP(v, 'scarf'), sz = SP(v, 'scarfz');
      spring(s, clamp(f * 0.1, -0.2, 0.9) + 0.06 * Math.sin(tm * 2.3), 26, 3, dt); spring(sz, -side * 0.1 + 0.05 * Math.sin(tm * 1.7), 22, 3, dt);
      v.bones[ix.scarf0].rotation.set(s.x * 0.5, 0, sz.x * 0.5); v.bones[ix.scarf1].rotation.set(s.x * 0.6, 0, sz.x * 0.6);
    }
  }
  // world-hanging props (lantern, censer, sling at rest), bow string and arrow, sling whirl
  function hangUpright(v, name, dt, gain) {
    const b = v.bones[v.ix[name]]; if (!b) return;
    const s = SP(v, name + 'x'), sz = SP(v, name + 'z');
    const fy = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const ax = v.u.vel.x - (v.lpvx || 0), az = v.u.vel.z - (v.lpvz || 0);
    spring(s, -(ax * fy + az * fz) * 0.05 * gain + Math.sin(v.time * 1.1) * 0.03, 22, 2.2, dt);
    spring(sz, (ax * fz - az * fy) * 0.05 * gain, 22, 2.2, dt);
    b.parent.getWorldQuaternion(_qp);
    _qs.setFromEuler(_eu.set(s.x, v.yaw, sz.x, 'YXZ'));
    b.quaternion.copy(_qp.invert()).multiply(_qs);
    b.updateMatrixWorld(true);
  }
  const _hr = new V3(), _gl = new V3();
  function props(v, dt) {
    if (v.rig !== 'human') return;
    const ix = v.ix, a = v.act;
    if (ix.lantern != null) hangUpright(v, 'lantern', dt, 1);
    if (ix.censer != null) hangUpright(v, 'censer', dt, 1.6);
    if (ix.sling1 != null) {
      const whirl = a && a.cl.name === 'sling' && a.tau < 1.02;
      const b1 = v.bones[ix.sling1];
      if (whirl) { v.slingA = (v.slingA || 0) + dt * (14 + a.tau * 16); b1.quaternion.setFromEuler(_eu.set(v.slingA, 0, 0, 'XYZ')); b1.updateMatrixWorld(true); }
      else hangUpright(v, 'sling1', dt, 2);
      const stone = v.bones[ix.slingstone];
      const showStone = !(a && a.cl.name === 'sling' && a.tau >= 1.0 && a.tau < 1.75);
      stone.scale.setScalar(showStone ? 1 : 0.0001); stone.updateMatrixWorld(true);
    }
    if (ix.nock != null) {
      const nock = v.bones[ix.nock], arrow = v.bones[ix.arrow], hl = v.bones[ix.hand_l], hrB = v.bones[ix.hand_r];
      const t = v.t, rest = t.bones[ix.nock].p;
      const drawing = a && a.cl.name === 'bow' && a.tau > 0.3 && a.tau < 1.0;
      const k = drawing ? sstep(0.3, 0.75, a.tau) : 0;
      _mInv.copy(hl.matrixWorld).invert();
      _hr.set(0, -t.P.fist, 0.02).applyMatrix4(hrB.matrixWorld).applyMatrix4(_mInv);
      const sx = SP(v, 'nk');
      if (!drawing && v.wasDrawing) sx.x = 1;   // snap
      v.wasDrawing = drawing;
      const kk = drawing ? k : spring(sx, 0, 400, 14, dt) * 0.3;
      nock.position.set(lerp(rest[0], _hr.x, kk), lerp(rest[1], _hr.y, kk), lerp(rest[2], _hr.z, kk));
      const show = a && a.cl.name === 'bow' && a.tau > 0.15 && a.tau < 1.0;
      arrow.scale.setScalar(show ? 1 : 0.0001);
      _gl.set(0, -t.P.fist, 0).sub(nock.position).normalize();
      arrow.quaternion.setFromUnitVectors(_v1.set(0, -1, 0), _gl);
      nock.updateMatrixWorld(true);
    }
    v.lpvx = v.u.vel.x; v.lpvz = v.u.vel.z;
  }
  function headLook(v, dt) {
    const u = v.u;
    v.lookT -= dt;
    if (v.lookT <= 0) {
      v.lookT = 0.3 + Math.random() * 0.2;
      let tgt = null;
      if (u.atk && u.atk.target) tgt = AB.combat.unit(u.atk.target);
      else if (u.action && u.action.target) tgt = AB.combat.unit(u.action.target);
      else if (u.side === 'party' && AB.combat.inCombat && u.kind !== 'display') tgt = AB.combat.nearestFoe(u, 14);
      else if (u.side === 'foe' && u.tgt) tgt = AB.combat.unit(u.tgt);
      else if (u.side === 'party' && u.kind === 'hero' && Math.random() < 0.35) { const c = AB.combat.controlled(); if (c && c !== u && v.spd < 1) { tgt = c; v.lookT = 1.5 + Math.random() * 2; } }
      v.lookUid = tgt && tgt !== u ? tgt.uid : 0;
    }
    let want = 0;
    if (v.lookUid) { const t = AB.combat.unit(v.lookUid); if (t) want = clamp(U.wrapAngle(Math.atan2(t.pos.x - u.pos.x, t.pos.z - u.pos.z) - v.yaw), -1.1, 1.1); }
    v.lookYaw = U.damp(v.lookYaw, want, 6, dt);
    R('head', 0, v.lookYaw * 0.55, 0); R('neck', 0, v.lookYaw * 0.3, 0);
  }
  // a faint backlight rim on heroes when the camera looks toward the sun (faces read in dusk / blue-hour backlight)
  const RIMC = { 1: col(0xffb070), 2: col(0x9ab4e0), 3: col(0xff7040), forge: col(0xff7040) };
  const _camF = new V3(); let _camFrame = -1, _camK = 0;
  function backRim(out) {
    if (!AB.world || !AB.world.sun || !AB.world.sun.userData || !AB.world.sun.userData.dir || !AB.camera) return false;
    if (_camFrame !== AB.loop.frame) { _camFrame = AB.loop.frame; AB.camera.getWorldDirection(_camF); _camK = Math.max(0, _camF.dot(AB.world.sun.userData.dir)) * 0.22; }
    if (_camK <= 0.002) return false;
    const lv = AB.world.level, rc = RIMC[lv ? lv.act : 1] || RIMC[1];
    out.setRGB(rc.r * _camK, rc.g * _camK, rc.b * _camK);
    return true;
  }
  function materials(v, dt) {
    const u = v.u, m = v.mat, U2 = m.userData.u;
    // hit flash (combat sets unit.flash on damage)
    let fl = u.flash > 0 ? clamp(u.flash / 0.18, 0, 1) : 0; fl *= fl;
    m.emissive.setRGB(fl * 0.07, fl * 0.05, fl * 0.04);
    // glow channels
    const L = v.look;
    let g = L.glowI != null ? L.glowI : 2.4;
    if (u.id === 'wren' && AB.state && AB.state.run) {
      const c = AB.state.run.corruption || 0;
      g = 1.6 + c / 100 * 7 + (c >= 70 ? Math.sin(v.time * 6) * 1.5 : Math.sin(v.time * 2.2) * 0.3);
    }
    if (v.death) g *= 1 - sstep(0.2, 1.5, v.death.t);
    U2.uGlow.value = g;
    let g2 = L.glow2I || 0; if (g2) g2 *= 0.85 + 0.15 * Math.sin(v.time * 2.3 + v.seed); if (v.death) g2 *= 1 - sstep(0.3, 2.0, v.death.t);
    U2.uGlow2.value = g2;
    // foe wind-up: a red rim that swells toward the strike (body telegraph)
    let rimK = 0;
    if (u.side === 'foe' && v.act && v.act.mode === 'windup') rimK = sstep(0.2, 0.97, v.act.tau);
    const base = v.rimBase || (L.rim != null ? (v.rimBase = col(L.rim)) : null);
    if (rimK > 0) { U2.uRimColor.value.setRGB(0.9 * rimK, 0.22 * rimK, 0.06 * rimK); U2.uRimPow.value = 3; }
    else if (base) U2.uRimColor.value.copy(base);
    else if ((u.kind === 'hero' || u.kind === 'display') && backRim(U2.uRimColor.value)) U2.uRimPow.value = 2.5;
    else U2.uRimColor.value.setRGB(0, 0, 0);
    if (fl > 0) { const c = U2.uRimColor.value; c.r += 0.5 * fl; c.g += 0.42 * fl; c.b += 0.36 * fl; }
    // companions standing between the camera and the controlled hero fade out (screen-door dither, no sorting)
    let dw = 0;
    if (u.side === 'party' && AB.cam && AB.cam.mode === 'follow' && AB.camera && AB.combat && u !== AB.combat.controlled() && AB.state && AB.state.screen === 'play') {
      const cp = AB.camera.position, f = AB.cam.focus;
      const dx = f.x - cp.x, dy = f.y - cp.y, dz = f.z - cp.z, L2 = dx * dx + dy * dy + dz * dz || 1;
      const rr = (u.radius || 0.4) + 0.2;
      for (let k = 0; k < 2 && !dw; k++) {
        const px = u.pos.x, py = u.pos.y + (u.height || 1.7) * (k ? 0.88 : 0.55), pz = u.pos.z;
        const tt = ((px - cp.x) * dx + (py - cp.y) * dy + (pz - cp.z) * dz) / L2;
        if (tt <= 0 || tt >= 0.96) continue;
        const ex = cp.x + dx * tt - px, ey = cp.y + dy * tt - py, ez = cp.z + dz * tt - pz;
        if (ex * ex + ey * ey + ez * ez < rr * rr) dw = 0.65;
      }
    }
    const dst = 3.25 * Math.max(dt || 0, 0.001);
    v.dither = (v.dither || 0) + clamp(dw - (v.dither || 0), -dst, dst);
    U2.uDither.value = v.dither < 0.01 ? 0 : v.dither;
    // hidden = translucent; shades are always a little ghostly; floaters fade on death
    const hidden = !!(u.status && u.status.hidden);
    let op = hidden ? 0.28 : (L.ghost || 1);
    if (v.fade != null) op *= v.fade;
    const tr = op < 0.999;
    if (tr !== m.transparent) { m.transparent = tr; m.needsUpdate = true; }
    m.opacity = op;
    m.depthWrite = !hidden;
    v.mesh.castShadow = op > 0.5;
    // corpse sink before combat despawns it
    if (v.death && u.side === 'foe') {
      const cs = (AB.combat && AB.combat.TUNE && AB.combat.TUNE.corpseSec) || 4;
      const k = sstep(cs - 1.2, cs - 0.05, u.deadT || v.death.t);
      if (k > 0) v.root.position.y -= k * 0.8 * v.scale;
    }
    void dt;
  }

  // ---- swarm
  const _sm = new T.Matrix4(), _sq = new T.Quaternion(), _sv = new V3(), _ss = new V3();
  function animSwarm(v, dt) {
    const u = v.u, look = v.look, im = v.mesh, sc = v.scale;
    v.time += dt;
    v.mat.userData.uT.value = v.time;
    const tm = v.time;
    const tgtY = u.pos.y + 1.0 * sc + Math.sin(tm * 1.3) * 0.15;
    v.center.x = U.damp(v.center.x, u.pos.x, 5, dt); v.center.z = U.damp(v.center.z, u.pos.z, 5, dt); v.center.y = U.damp(v.center.y, tgtY, 5, dt);
    const a = v.act;
    const contract = a && a.mode === 'windup' ? sstep(0, 1, a.tau) : 0;
    const surge = a && a.tau >= 1 ? Math.sin(clamp((a.tau - 1) / 0.8, 0, 1) * PI) : 0;
    const dead = v.death ? v.death.t : -1;
    const fx = Math.sin(u.facing), fz = Math.cos(u.facing);
    const big = look.kind === 'bat' ? 1.0 : 1;
    for (let i = 0; i < v.bugs.length; i++) {
      const b = v.bugs[i];
      b.a += dt * b.sp * (1 + contract * 2);
      const r = b.r * sc * (1 - contract * 0.55) * (1 + 0.25 * Math.sin(tm * 1.7 + b.ph)) * big;
      let x = v.center.x + Math.cos(b.a) * r + fx * surge * 2.2 * sc, y = v.center.y + b.y * sc * (1 - contract * 0.5) + Math.sin(tm * 3 + b.ph) * 0.15, z = v.center.z + Math.sin(b.a) * r + fz * surge * 2.2 * sc;
      if (dead >= 0) { const k = dead; x += Math.cos(b.ph) * k * 3; z += Math.sin(b.ph) * k * 3; y += (look.kind === 'moth' ? -1 : 1) * k * 1.2 - k * k * 0.8; }
      const s = (dead >= 0 ? Math.max(0, 1 - dead / 1.4) : 1) * (look.kind === 'midge' ? 1.6 : 1);
      _sq.setFromAxisAngle(Y, -b.a + (b.sp > 0 ? 0 : PI));
      _sm.compose(_sv.set(x, y, z), _sq, _ss.set(s, s, s));
      im.setMatrixAt(i, _sm);
    }
    im.instanceMatrix.needsUpdate = true;
    // hidden / flash
    const fl = u.flash > 0 ? clamp(u.flash / 0.18, 0, 1) : 0;
    if (!look.glow) v.mat.emissive.setRGB(fl * 0.5, fl * 0.15, fl * 0.1);
    if (a) { a.age += dt; a.t += dt; if (a.mode === 'windup') { a.tau = Math.min(0.97, a.t / Math.max(0.1, a.windup)); if (!u.atk && a.t > a.windup + 0.25) { a.mode = 'strike'; a.t = 0; } } else a.tau = 1 + a.t / 0.8; if (a.tau >= 2) v.act = null; }
    if (v.death) v.death.t += dt;
  }

  // =====================================================================================================
  // 10. EVENTS
  // =====================================================================================================
  function heroClipName(v, ev) {
    const u = v.u, ab = ev.ability;
    let n = HERO_CLIP[ab];
    if (Array.isArray(n)) n = n[(u.action ? u.action.combo : 0) % n.length] || n[0];
    if (!n) n = ev.slot === 'attack' ? 'slash' : 'cast';
    const t = ev.target;
    const near = t && t !== u && t.pos && U.dist2(t.pos.x, t.pos.z, u.pos.x, u.pos.z) < 2.6 + (t.radius || 0.4);
    if (u.id === 'tamsin' && ab === 'cutting_verse' && near) n = 'jab';
    if (u.id === 'maddoc' && ab === 'lantern_flare' && near) n = 'lantern';
    return n;
  }
  function foeClipName(v, ev) {
    const L = v.look, id = ev.intent ? ev.intent.id : ev.ability;
    if (v.rig === 'quad') return ev.shape === 'cast' ? 'howl' : (ev.shape === 'aoe' || /lunge|pounce|run_down|hamstring/.test(id || '')) ? 'pounce' : 'bite';
    if (v.rig === 'spider') return ev.shape === 'proj' || ev.shape === 'cast' ? 'sspit' : 'sbite';
    if (v.rig === 'serpent') return ev.shape === 'aoe' || /breath|erupt|maw|spit/.test(id || '') ? 'breath' : 'lash';
    if (FOE_INTENT_CLIP[id]) return FOE_INTENT_CLIP[id];
    const tbl = FOE_CLIP[L.style] || FOE_CLIP.heavy;
    let n = tbl[ev.shape] || tbl.melee;
    if (Array.isArray(n)) n = n[Math.floor(Math.random() * n.length)];
    return n;
  }
  function onAction(ev) {
    const u = ev.unit; if (!u) return;
    const v = views.get(u.uid); if (!v) return;
    if (v.rig === 'swarm') {
      if (ev.slot === 'intent' && ev.phase === 'start') v.act = { mode: 'windup', t: 0, age: 0, tau: 0, windup: ev.windup || 0.8 };
      else if (ev.phase === 'release' && v.act) { v.act.mode = 'strike'; v.act.t = 0; }
      return;
    }
    if (ev.slot === 'intent') {
      if (ev.phase === 'start') {
        const n = foeClipName(v, ev);
        startAct(v, n, 'windup', { windup: ev.windup || (u.atk ? u.atk.windup : 0.8) });
        if (v.rig === 'serpent' && ev.intent && /submerge|sink|ambush|burrow/.test(ev.intent.id)) v.submergeT = 1;
      } else if (ev.phase === 'release') {
        if (v.act && v.act.mode === 'windup') { v.act.mode = 'strike'; v.act.t = 0; v.act.tau = 1; }
        else { const n = foeClipName(v, ev); startAct(v, n, 'strike'); if (v.act) v.act.tau = 1; }
      }
      return;
    }
    if (ev.phase === 'start') {
      const n = heroClipName(v, ev);
      startAct(v, n, 'act', { ref: u.action });
    }
  }
  function onHit(ev) {
    const u = ev.unit; if (!u || ev.kind === 'dodged' || !ev.amount) return;
    const v = views.get(u.uid); if (!v || v.rig === 'swarm') return;
    const s = ev.src && ev.src.pos ? ev.src : null;
    let dx = 0, dz = -1;
    if (s) { dx = u.pos.x - s.pos.x; dz = u.pos.z - s.pos.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
    // to local (facing) frame: lz along facing, lx along local +X (left)
    const fy = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const lz = dx * fy + dz * fz, lx = dx * fz - dz * fy;
    const heavy = !!ev.heavy || ev.amount >= 12;
    v.hit = { t: 0, lx, lz, heavy };
    v.lastHit = { lx, lz };
  }
  function onDeath(ev) {
    const u = ev.unit; if (!u) return;
    const v = views.get(u.uid); if (!v) return;
    const h = v.lastHit || { lx: (Math.random() - 0.5) * 0.4, lz: -1 };
    v.death = { t: 0, fx: h.lx, fz: h.lz, side: Math.random() < 0.5 ? -1 : 1 };
    v.act = null; v.hit = null;
  }
  function onRevived(ev) { const v = ev.unit && views.get(ev.unit.uid); if (v) { v.death = null; v.fade = null; } }
  function onCombatEnd(ev) {
    if (!ev || ev.result !== 'won' || AB.loop.fastForwarding) return;
    for (const v of views.values()) {
      if (v.rig !== 'human' || v.u.side !== 'party' || !v.u.alive || v.u.downed || v.act) continue;
      const d = Math.random() * 0.4;
      setTimeout(() => { if (views.get(v.u.uid) === v && !v.act && v.u.alive && !v.u.downed) startAct(v, 'victory', 'timed', { dur: 1.6 }); }, d * 1000);
    }
  }

  // =====================================================================================================
  // 11. FRAME + API
  // =====================================================================================================
  const _frus = new T.Frustum(), _pm = new T.Matrix4(), _bs = new T.Sphere();
  function frame(dt) {
    if (!atlas) return;
    const cam = AB.camera;
    if (cam) { cam.updateMatrixWorld(); _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); _frus.setFromProjectionMatrix(_pm); }
    const scr = AB.state ? AB.state.screen : '';
    const pick = scr === 'pick' && AB.state.modal ? AB.state.modal.chosen || [] : null;
    for (const v of views.values()) {
      try {
        if (v.rig === 'swarm') { animSwarm(v, dt); continue; }
        if (pick && v.u.kind === 'display') {
          const ch = pick.includes(v.u.id) || v.u.id === 'wren';
          if (ch && !v.chosen && v.u.id !== 'wren') startAct(v, 'victory', 'timed', { dur: 1.4 });
          v.chosen = ch;
        }
        // distance-based update rate (far units animate at a lower rate)
        if (cam) {
          const d2 = cam.position.distanceToSquared(v.u.pos);
          // foes far down the road (lost in the haze anyway) are not drawn at all: saves 10-15 draw calls per frame
          const hide = v.u.kind === 'enemy' && v.u.tier !== 'boss' && d2 > 22500;
          if (v.root.visible === hide) v.root.visible = !hide;
          let every = d2 > 14400 ? 8 : d2 > 3600 ? 3 : 1;
          if (every < 8 && v.t) { _bs.center.set(v.u.pos.x, v.u.pos.y + v.t.h * v.scale * 0.5, v.u.pos.z); _bs.radius = v.t.radius * v.scale; if (!_frus.intersectsSphere(_bs)) every = 6; }
          v.skipDt += dt;
          if (++v.skip < every) { v.root.position.set(v.u.pos.x, v.u.pos.y, v.u.pos.z); continue; }
          v.skip = 0;
          const ddt = Math.min(v.skipDt, 0.1); v.skipDt = 0;
          animate(v, ddt);
        } else animate(v, dt);
      } catch (e) {
        if (!v.err) { v.err = true; console.warn('[actors] pose failed for ' + (v.u && v.u.id), e); }
      }
    }
  }
  const portraits = {};
  function renderPortrait(id, size) {
    const r = AB.renderer;
    const look = HERO_LOOK[id], t = template('hero:' + id, look);
    const bones = t.bones.map((d) => { const b = new T.Bone(); b.name = d.name; b.position.set(d.p[0], d.p[1], d.p[2]); return b; });
    t.bones.forEach((d, i) => { if (d.parent >= 0) bones[d.parent].add(bones[i]); });
    const mat = makeMat({ glow: glowOf(look), glowI: 2.4 });
    const mesh = new T.SkinnedMesh(t.geo, mat); mesh.add(bones[0]); mesh.bind(new T.Skeleton(bones));
    // a relaxed three-quarter pose
    const ix = t.ix, set = (n, x, y, z) => { if (ix[n] != null) bones[ix[n]].rotation.set(x, y, z); };
    set('head', 0.05, -0.25, 0); set('chest', 0, 0.2, 0); set('upperarm_l', 0, 0, 0.12); set('upperarm_r', 0, 0, -0.12);
    if (CARRY[id]) for (const n in CARRY[id].relax) { const q = CARRY[id].relax[n]; set(n, q[0], q[1] || 0, q[2] || 0); }
    const sc = new T.Scene();
    sc.add(mesh);
    sc.add(new T.HemisphereLight(0xd8d0c0, 0x2a2420, 1.2));
    const key = new T.DirectionalLight(0xffe2c0, 2.6); key.position.set(-1.5, 2.5, 2.5); sc.add(key);
    const rim = new T.DirectionalLight(0x9ec2e6, 1.4); rim.position.set(1.5, 1.8, -2.5); sc.add(rim);
    const P = t.P, hy = P.headC;
    const cam = new T.PerspectiveCamera(28, 1, 0.05, 20);
    cam.position.set(-0.12, hy + 0.02, 0.9 * (P.h / 1.75) + 0.1); cam.lookAt(0, hy - 0.06 * P.k, 0);
    mesh.updateMatrixWorld(true);
    const rt = new T.WebGLRenderTarget(size, size, { samples: 4 });
    const prevRT = r.getRenderTarget(), prevTM = r.toneMapping;
    sc.background = new T.Color(0x1c2632);
    r.setRenderTarget(rt); r.clear(); r.render(sc, cam);
    const px = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(rt, 0, 0, size, size, px);
    r.setRenderTarget(prevRT); r.toneMapping = prevTM;
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d'), img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const si = ((size - 1 - y) * size + x) * 4, di = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) { const v = px[si + c] / 255, tm = v / (1 + v * 0.6) * 1.25; img.data[di + c] = Math.round(Math.pow(Math.min(1, tm), 1 / 2.2) * 255); }
      img.data[di + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    rt.dispose(); mesh.skeleton.dispose(); mat.dispose(); mats.delete(mat);
    return cv.toDataURL('image/png');
  }
  AB.actors = {
    init() {
      try { atlas = genAtlas(); } catch (e) { console.warn('[actors] atlas failed', e); atlas = null; }
      buildEnv();
      AB.bus.on('unit:spawn', ({ unit }) => create(unit));
      AB.bus.on('unit:despawn', ({ unit }) => remove(unit));
      AB.bus.on('unit:action', onAction);
      AB.bus.on('unit:hit', onHit);
      AB.bus.on('unit:death', onDeath);
      AB.bus.on('unit:revived', onRevived);
      AB.bus.on('combat:end', onCombatEnd);
      AB.bus.on('level:built', () => { buildEnv(); });
      AB.loop.add('actors', frame, { phase: 'frame', order: AB.loop.ORDER.actors });
    },
    create, remove,
    view: (u) => (u ? views.get(u.uid) || null : null),
    count: () => views.size,
    // socket(unit, name, out) -> world position of a body point: hand_r hand_l head chest feet mouth top muzzle ember lantern
    //   weapon_tip weapon_base weapon2_tip weapon2_base shield censer foot_l foot_r (falls back to an estimate)
    socket(u, name, out) {
      out = out || new V3();
      const v = u ? views.get(u.uid) : null;
      if (name === 'feet') { out.set(u.pos.x, u.pos.y, u.pos.z); return out; }
      if (v && v.t && socketWorld(v, name, out)) return out;
      if (v && v.rig === 'swarm') { out.copy(v.center); return out; }
      if (v && v.t) { const alt = name === 'muzzle' || name === 'ember' ? 'hand_r' : name.startsWith('weapon2') ? 'hand_l' : name.startsWith('weapon') ? 'hand_r' : name === 'lantern' ? 'hand_r' : 'chest'; if (socketWorld(v, alt, out)) return out; }
      const h = (u && u.height) || 1.7;
      const y = name === 'head' || name === 'top' ? h * 0.92 : name === 'chest' ? h * 0.65 : h * 0.55;
      const side = name === 'hand_r' || name.startsWith('weapon') ? -0.3 : name === 'hand_l' ? 0.3 : 0;
      const yaw = v ? v.yaw : (u ? u.facing : 0);
      out.set(u.pos.x + Math.cos(yaw) * side + Math.sin(yaw) * (side ? 0.25 : 0), u.pos.y + y, u.pos.z - Math.sin(yaw) * side + Math.cos(yaw) * (side ? 0.25 : 0));
      return out;
    },
    // debug / showcase: freeze a view on a clip at tau (0..2), or a base state ('dodge' 0..1, 'downed', 'dead' t, 'stagger')
    preview(u, clip, tau, opts) {
      const v = u ? views.get(u.uid) : null; if (!v || v.rig === 'swarm') return false;
      if (clip === 'dead') { v.death = { t: tau, fx: 0, fz: (opts && opts.fz) != null ? opts.fz : -1, side: 1 }; v.act = null; return true; }
      v.death = null;
      if (!clip) { v.act = null; return true; }
      const cl = clipFor(v.t || {}, clip); if (!cl && v.rig !== 'swarm') return false;
      v.act = { cl, mode: 'hold', t: 0, age: 1, tau, w: 1, frozen: true };
      return true;
    },
    clips: (u) => { const v = u ? views.get(u.uid) : null; if (!v) return []; return Object.keys(LIB[v.rig] || {}); },
    templates: () => Array.from(tpls.keys()),
    heroLook: (id) => HERO_LOOK[id] || null,
    // portrait(heroId, size = 128) -> data URL (PNG) of the hero's head and shoulders, rendered once and cached; null
    // without WebGL. For UI party portraits / pick cards.
    portrait(id, size = 128) {
      const key = id + ':' + size;
      if (portraits[key] !== undefined) return portraits[key];
      portraits[key] = null;
      if (!AB.renderer || !atlas || !HERO_LOOK[id]) return null;
      try { portraits[key] = renderPortrait(id, size); } catch (e) { console.warn('[actors] portrait', e); }
      return portraits[key];
    },
    _views: views,
    _frame: (dt) => frame(dt)          // profiling hook for tools
  };
}
