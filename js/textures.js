'use strict';
/* ASHBEARER v3 :: textures.js
   OWNER: WORLD lane (world.js + textures.js).
   Procedural PBR texture kit, generated in code once and cached (no image files).
   Every texture is a tileable DataTexture built from periodic gradient noise / Worley cells:
     map (sRGB albedo) + normalMap (linear, OpenGL convention, height in alpha) + roughnessMap (ORM: R ao, G rough, B metal).
   Everything returned is SHARED (userData.shared = true): AB.util.disposeObject never frees it on level change.
   API (INTERFACES.md section 4): init, get(name, rx, ry), material(name, opts), canvas, texture, dot
   Extras (world lane, readable by anyone): card(name) alpha cards, noise(), waterNormal(), splat(name), emissive(name). */
{
  const T = AB.THREE;
  const TAU = Math.PI * 2;
  const sets = new Map();        // name -> { map, normalMap, roughnessMap, size }
  const clones = new Map();      // name|rx|ry -> set clone with its own repeat (shares GPU images)
  const mats = new Map();        // key -> MeshStandardMaterial
  const cards = new Map();       // name -> DataTexture (sRGB + alpha)
  const splats = new Map();      // name -> { map: albedo rgb + roughness a, normal: rgb + height a }
  const emissives = new Map();
  const raw = new Map();         // name -> generated arrays (kept until the splat pack is made)
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const sm = (a, b, v) => { const t = cl((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const fract = (v) => v - Math.floor(v);
  const hash = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);

  // ======================================================================= tileable noise kit
  // periodic gradient noise over an integer lattice Px x Py, sampled at (x in [0,Px), y in [0,Py))
  function lattice(Px, Py, rng) {
    const g = new Float32Array(Px * Py * 2);
    for (let i = 0; i < Px * Py; i++) { const a = rng.next() * TAU; g[2 * i] = Math.cos(a); g[2 * i + 1] = Math.sin(a); }
    return g;
  }
  function gnoise(g, Px, Py, x, y) {
    let xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    xi %= Px; if (xi < 0) xi += Px; yi %= Py; if (yi < 0) yi += Py;
    const x1 = xi + 1 === Px ? 0 : xi + 1, y1 = yi + 1 === Py ? 0 : yi + 1;
    const a = (yi * Px + xi) * 2, b = (yi * Px + x1) * 2, c = (y1 * Px + xi) * 2, d = (y1 * Px + x1) * 2;
    const va = g[a] * xf + g[a + 1] * yf, vb = g[b] * (xf - 1) + g[b + 1] * yf;
    const vc = g[c] * xf + g[c + 1] * (yf - 1), vd = g[d] * (xf - 1) + g[d + 1] * (yf - 1);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const ab = va + (vb - va) * u, cd = vc + (vd - vc) * u;
    return ab + (cd - ab) * v;
  }
  // fbm(N, rng, P, octaves, {py, gain, ridged, warp: Float32Array, warpAmt, turb}) -> Float32Array N*N in 0..1
  function fbm(N, rng, P, oct, o = {}) {
    const out = new Float32Array(N * N);
    const py0 = o.py || P, gain = o.gain != null ? o.gain : 0.5;
    let amp = 1, px = P, py = py0;
    for (let k = 0; k < oct; k++) {
      const g = lattice(px, py, rng);
      const sx = px / N, sy = py / N, wa = (o.warpAmt || 0);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = j * N + i;
          let x = i * sx, y = j * sy;
          if (o.warp) { const w = (o.warp[idx] - 0.5) * wa; x += w * px; y += w * py * 0.7; }
          let n = gnoise(g, px, py, x, y);
          if (o.ridged) { n = 1 - Math.abs(n) * 1.6; n *= n; } else if (o.turb) n = Math.abs(n) * 1.6;
          out[idx] += n * amp;
        }
      }
      amp *= gain; px *= 2; py *= 2;
    }
    return norm(out);
  }
  function norm(a) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
    return a;
  }
  // tileable Worley cells: C x C cells (Cy rows if given). f1/f2 in cell units, id = cell hash 0..1
  function worley(N, C, rng, jit = 0.9, Cy = C) {
    const px = new Float32Array(C * Cy), py = new Float32Array(C * Cy), ids = new Float32Array(C * Cy);
    for (let i = 0; i < C * Cy; i++) { px[i] = 0.5 + (rng.next() - 0.5) * jit; py[i] = 0.5 + (rng.next() - 0.5) * jit; ids[i] = rng.next(); }
    const f1 = new Float32Array(N * N), f2 = new Float32Array(N * N), id = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const fy = j / N * Cy, cy = Math.floor(fy);
      for (let i = 0; i < N; i++) {
        const fx = i / N * C, cx = Math.floor(fx);
        let d1 = 9, d2 = 9, best = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = cy + oy, wy = ((ny % Cy) + Cy) % Cy;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = cx + ox, wx = ((nx % C) + C) % C, k = wy * C + wx;
            const dx = nx + px[k] - fx, dy = ny + py[k] - fy, d = Math.sqrt(dx * dx + dy * dy);
            if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
          }
        }
        const idx = j * N + i;
        f1[idx] = d1; f2[idx] = d2; id[idx] = ids[best];
      }
    }
    return { f1, f2, id };
  }
  // ======================================================================= packing
  // anisotropic filtering: 8x on GPUs; off on software rasterisers (SwiftShader / llvmpipe), where it dominates the cost
  let aniso = null, softGL = false, maxAniso = 4;
  const allTex = [];
  function anisoLevel() {
    if (aniso != null) return aniso;
    try {
      const r = AB.renderer, gl = r && r.getContext(), ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      softGL = /swiftshader|llvmpipe|software/i.test(name);
      maxAniso = r ? Math.min(8, r.capabilities.getMaxAnisotropy()) : 4;
    } catch (e) { /* ignore */ }
    aniso = softGL && AB.quality.tier !== 'high' ? 1 : maxAniso;
    return aniso;
  }
  function onQuality() {
    if (!softGL) return;
    const a = AB.quality.tier !== 'high' ? 1 : maxAniso;
    if (a === aniso) return;
    aniso = a;
    for (const t of allTex) { t.anisotropy = a; t.needsUpdate = true; }
  }
  function dataTex(data, N, srgb, M = N) {
    const t = new T.DataTexture(data, N, M, T.RGBAFormat, T.UnsignedByteType);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    t.anisotropy = anisoLevel();
    allTex.push(t);
    t.needsUpdate = true;
    t.userData.shared = true;
    return t;
  }
  function normalFrom(h, N, k) {
    const out = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      const jm = ((j - 1 + N) % N) * N, jp = ((j + 1) % N) * N, jr = j * N;
      for (let i = 0; i < N; i++) {
        const im = (i - 1 + N) % N, ip = (i + 1) % N;
        const nx = (h[jr + im] - h[jr + ip]) * k, ny = (h[jm + i] - h[jp + i]) * k;
        const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const o = (jr + i) * 4;
        out[o] = (nx * l * 0.5 + 0.5) * 255; out[o + 1] = (ny * l * 0.5 + 0.5) * 255; out[o + 2] = (l * 0.5 + 0.5) * 255; out[o + 3] = cl(h[jr + i]) * 255;
      }
    }
    return out;
  }
  // recipe result r = { N, col: Float32Array 3N^2 (sRGB 0..1), h, rough, ao?, metal (0..1), nk (normal strength) }
  function finish(name, r) {
    const N = r.N, n2 = N * N;
    const alb = new Uint8Array(n2 * 4), orm = new Uint8Array(n2 * 4);
    for (let i = 0; i < n2; i++) {
      alb[i * 4] = cl(r.col[i * 3]) * 255; alb[i * 4 + 1] = cl(r.col[i * 3 + 1]) * 255; alb[i * 4 + 2] = cl(r.col[i * 3 + 2]) * 255; alb[i * 4 + 3] = 255;
      orm[i * 4] = (r.ao ? cl(r.ao[i]) : 1) * 255; orm[i * 4 + 1] = cl(r.rough[i]) * 255; orm[i * 4 + 2] = (r.metalA ? cl(r.metalA[i]) : (r.metal || 0)) * 255; orm[i * 4 + 3] = 255;
    }
    const nor = normalFrom(r.h, N, r.nk || 4);
    raw.set(name, { N, alb, nor, orm });
    const set = { map: dataTex(alb, N, true), normalMap: dataTex(nor, N, false), roughnessMap: dataTex(orm, N, false), size: N, metal: (r.metal || 0) > 0.5 };
    if (r.emis) emissives.set(name, dataTex(r.emis, N, true));
    return set;
  }
  const C3 = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  function paint(N, fn) {   // fn(i, x, y, out3) -> col
    const col = new Float32Array(N * N * 3), o = [0, 0, 0];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const idx = j * N + i; fn(idx, i, j, o); col[idx * 3] = o[0]; col[idx * 3 + 1] = o[1]; col[idx * 3 + 2] = o[2]; }
    return col;
  }
  const lerp3 = (o, a, b, t) => { o[0] = mix(a[0], b[0], t); o[1] = mix(a[1], b[1], t); o[2] = mix(a[2], b[2], t); return o; };
  const mul3 = (o, k) => { o[0] *= k; o[1] *= k; o[2] *= k; return o; };
  const arr = (N, fn) => { const a = new Float32Array(N * N); for (let i = 0; i < N * N; i++) a[i] = fn(i); return a; };

  // ======================================================================= recipes
  const BIG = () => (AB.quality && AB.quality.tier === 'low' ? 256 : 512);
  const R = {
    grass(rng, N = BIG()) {
      const p = fbm(N, rng, 3, 4), f = fbm(N, rng, 24, 3), w = worley(N, 48, rng), dry = fbm(N, rng, 5, 3);
      const st = fbm(N, rng, 64, 2, { py: 8 });
      const g1 = C3(0x46562a), g2 = C3(0x728036), dr = C3(0x9c8c52), soil = C3(0x4a3c26), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, g1, g2, f[i] * 0.5 + (1 - w.f1[i]) * 0.25 + st[i] * 0.25);
        lerp3(o, o, lerp3(t, o, dr, 1), sm(0.5, 0.85, dry[i]) * 0.6);
        if (f[i] < 0.2 && p[i] > 0.45) lerp3(o, o, soil, 0.55);
        mul3(o, 0.88 + p[i] * 0.25);
      });
      const h = arr(N, (i) => (1 - w.f1[i]) * 0.4 + f[i] * 0.3 + st[i] * 0.3);
      return { N, col, h, rough: arr(N, (i) => 0.82 + f[i] * 0.15), ao: arr(N, (i) => 0.75 + h[i] * 0.25), nk: 3 };
    },
    forest(rng, N = BIG()) {   // leaf litter: many small overlapping leaves, needles, a little moss and soil
      const warp = fbm(N, rng, 8, 3);
      const w = worley(N, 70, rng, 1), w2 = worley(N, 34, rng, 1), f = fbm(N, rng, 16, 4), m = fbm(N, rng, 4, 3), n2 = fbm(N, rng, 48, 2, { py: 12 });
      const pal = [C3(0x5a3e22), C3(0x7a5428), C3(0x6a4420), C3(0x4a3a24), C3(0x8a6a34), C3(0x5a5228), C3(0x6e3a1c)], soil = C3(0x2e2216), moss = C3(0x46562a), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        const e1 = w.f2[i] - w.f1[i], e2 = w2.f2[i] - w2.f1[i];
        const top = e1 > 0.05 + warp[i] * 0.08 ? w.id[i] : w2.id[i];
        const c = pal[Math.floor(top * pal.length) % pal.length];
        lerp3(o, soil, c, sm(0.0, 0.06, Math.max(e1, e2 * 0.7)) * 0.85 + 0.15);
        if (n2[i] > 0.78) lerp3(o, o, lerp3(t, pal[4], soil, 0.3), 0.6);
        if (m[i] > 0.66) lerp3(o, o, moss, sm(0.66, 0.82, m[i]) * 0.75);
        mul3(o, 0.8 + f[i] * 0.35);
      });
      const h = arr(N, (i) => sm(0.0, 0.08, w.f2[i] - w.f1[i]) * 0.45 + sm(0.0, 0.1, w2.f2[i] - w2.f1[i]) * 0.25 + f[i] * 0.3);
      return { N, col, h, rough: arr(N, (i) => 0.84 + f[i] * 0.14), ao: arr(N, (i) => 0.65 + h[i] * 0.35), nk: 4 };
    },
    dirt(rng, N = BIG()) {
      const f = fbm(N, rng, 6, 6), w = worley(N, 40, rng), s = fbm(N, rng, 3, 3);
      const d1 = C3(0x4a3826), d2 = C3(0x6e5638), pb = C3(0x7a7064), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, d1, d2, f[i]);
        const peb = 1 - sm(0.28, 0.4, w.f1[i]);
        if (peb > 0) lerp3(o, o, mul3(lerp3(t, pb, d1, w.id[i] * 0.6), 0.8 + w.id[i] * 0.4), peb);
        mul3(o, 0.85 + s[i] * 0.3);
      });
      const h = arr(N, (i) => f[i] * 0.5 + (1 - sm(0.2, 0.42, w.f1[i])) * 0.5);
      return { N, col, h, rough: arr(N, (i) => 0.88 + f[i] * 0.1 - (1 - sm(0.28, 0.4, w.f1[i])) * 0.15), ao: arr(N, (i) => 0.65 + h[i] * 0.35), nk: 5 };
    },
    road(rng, N = BIG()) {   // packed earth + gravel, lighter, worn
      const f = fbm(N, rng, 5, 6), w = worley(N, 64, rng), w2 = worley(N, 18, rng), s = fbm(N, rng, 2, 3);
      const d1 = C3(0x5e4a34), d2 = C3(0x8a7356), pb = C3(0x8c8478), dk = C3(0x3c2e20), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, d1, d2, f[i] * 0.7 + s[i] * 0.3);
        const peb = 1 - sm(0.25, 0.36, w.f1[i]);
        if (peb > 0) lerp3(o, o, lerp3(t, pb, dk, w.id[i] * 0.7), peb * 0.85);
        const st = 1 - sm(0.18, 0.3, w2.f1[i]);
        if (st > 0 && w2.id[i] > 0.6) lerp3(o, o, mul3(lerp3(t, pb, d2, 0.5), 0.9 + w2.id[i] * 0.2), st);
      });
      const h = arr(N, (i) => f[i] * 0.35 + (1 - sm(0.2, 0.38, w.f1[i])) * 0.35 + (w2.id[i] > 0.6 ? (1 - sm(0.12, 0.3, w2.f1[i])) * 0.3 : 0));
      return { N, col, h, rough: arr(N, (i) => 0.8 + f[i] * 0.15), ao: arr(N, (i) => 0.6 + h[i] * 0.4), nk: 6 };
    },
    rock(rng, N = BIG()) {
      const warp = fbm(N, rng, 3, 3);
      const r1 = fbm(N, rng, 4, 6, { ridged: true, warp, warpAmt: 0.35 }), w = worley(N, 6, rng), f = fbm(N, rng, 32, 3), tint = fbm(N, rng, 2, 3);
      const c1 = C3(0x4c4944), c2 = C3(0x77726a), warm = C3(0x6e5c48), lich = C3(0x6b6e50);
      const col = paint(N, (i, x, y, o) => {
        const strata = 0.5 + 0.5 * Math.sin((y / N) * TAU * 6 + r1[i] * 5 + warp[i] * 4);
        lerp3(o, c1, c2, r1[i] * 0.6 + strata * 0.25 + f[i] * 0.15);
        lerp3(o, o, warm, sm(0.55, 0.85, tint[i]) * 0.4);
        if (f[i] > 0.72 && r1[i] > 0.55) lerp3(o, o, lich, 0.35);
        const crack = 1 - sm(0.0, 0.06, w.f2[i] - w.f1[i]);
        mul3(o, 1 - crack * 0.55);
      });
      const h = arr(N, (i) => { const crack = 1 - sm(0.0, 0.07, w.f2[i] - w.f1[i]); const strata = 0.5 + 0.5 * Math.sin(((i / N | 0) / N) * TAU * 6 + r1[i] * 5 + warp[i] * 4); return r1[i] * 0.6 + strata * 0.15 + f[i] * 0.25 - crack * 0.45; });
      return { N, col, h: norm(h), rough: arr(N, (i) => 0.78 + f[i] * 0.15), ao: arr(N, (i) => 0.45 + h[i] * 0.55), nk: 7 };
    },
    mud(rng, N = BIG()) {
      const f = fbm(N, rng, 5, 5), p = fbm(N, rng, 3, 4), w = worley(N, 30, rng), roots = fbm(N, rng, 8, 4, { ridged: true });
      const m1 = C3(0x1e1912), m2 = C3(0x3d3122), wet = C3(0x15130f), rt = C3(0x4a3a26);
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, m1, m2, f[i]);
        const pud = sm(0.6, 0.72, p[i]);
        lerp3(o, o, wet, pud * 0.8);
        if (roots[i] > 0.82) lerp3(o, o, rt, (roots[i] - 0.82) * 4);
        if (w.f1[i] < 0.22 && pud < 0.5) lerp3(o, o, m2, 0.5);
      });
      const h = arr(N, (i) => f[i] * 0.5 - sm(0.6, 0.72, p[i]) * 0.3 + (roots[i] > 0.82 ? 0.2 : 0) + (1 - sm(0.1, 0.25, w.f1[i])) * 0.2);
      return { N, col, h: norm(h), rough: arr(N, (i) => mix(0.75, 0.12, sm(0.58, 0.7, p[i]))), ao: arr(N, (i) => 0.7 + f[i] * 0.3), nk: 4 };
    },
    snow(rng, N = BIG()) {
      const f = fbm(N, rng, 4, 5), rip = fbm(N, rng, 3, 3), sp = fbm(N, rng, 64, 1);
      const s1 = C3(0xc9d2de), s2 = C3(0xeef2f7), blue = C3(0x9fb2cc);
      // soft drifts with faint wind ripples (strong ripples read as sand dunes at a distance)
      const h = arr(N, (i) => { const x = i % N, y = (i / N) | 0; return f[i] * 0.82 + 0.18 * (0.5 + 0.5 * Math.sin((x / N) * TAU * 9 + (y / N) * TAU * 2 + rip[i] * 7)); });
      const col = paint(N, (i, x, y, o) => { lerp3(o, s1, s2, 0.45 + f[i] * 0.55); lerp3(o, o, blue, (1 - f[i]) * 0.2); });
      return { N, col, h, rough: arr(N, (i) => (sp[i] > 0.82 ? 0.25 : 0.62 + f[i] * 0.15)), ao: arr(N, (i) => 0.88 + h[i] * 0.12), nk: 1.5 };
    },
    gravel(rng, N = BIG()) {
      const w = worley(N, 36, rng, 1), w2 = worley(N, 70, rng, 1), f = fbm(N, rng, 6, 4);
      const g1 = C3(0x55575a), g2 = C3(0x8e8c86), dk = C3(0x24221f), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        const a = sm(0.02, 0.14, w.f2[i] - w.f1[i]), b = sm(0.02, 0.12, w2.f2[i] - w2.f1[i]);
        lerp3(o, dk, lerp3(t, g1, g2, w.id[i]), a);
        if (a < 0.4) lerp3(o, o, lerp3(t, g1, g2, w2.id[i] * 0.8), b * 0.8);
        mul3(o, 0.85 + f[i] * 0.3);
      });
      const h = arr(N, (i) => Math.max(sm(0.0, 0.2, w.f2[i] - w.f1[i]) * 0.8, sm(0.0, 0.15, w2.f2[i] - w2.f1[i]) * 0.45) + f[i] * 0.1);
      return { N, col, h, rough: arr(N, (i) => 0.75 + f[i] * 0.2), ao: arr(N, (i) => 0.4 + h[i] * 0.6), nk: 6 };
    },
    cobble(rng, N = BIG()) {   // flagstones (Undervault floors, Thistledown yards, forge causeway)
      const wp = fbm(N, rng, 4, 3), w = worley(N, 7, rng, 1.0), f = fbm(N, rng, 8, 5), st = fbm(N, rng, 3, 3), ch = fbm(N, rng, 48, 2);
      const c1 = C3(0x55524c), c2 = C3(0x7c776d), gap = C3(0x221f1b), t = [0, 0, 0];
      const col = paint(N, (i, x, y, o) => {
        const e = w.f2[i] - w.f1[i];
        lerp3(t, c1, c2, w.id[i] * 0.7 + f[i] * 0.3);
        mul3(t, 0.85 + st[i] * 0.3);
        lerp3(o, gap, t, sm(0.03, 0.09, e));
        if (ch[i] > 0.8) mul3(o, 0.88);
      });
      const h = arr(N, (i) => sm(0.02, 0.16, w.f2[i] - w.f1[i]) * 0.75 + f[i] * 0.2 - (ch[i] > 0.8 ? 0.06 : 0));
      return { N, col, h, rough: arr(N, (i) => 0.72 + f[i] * 0.2 + (1 - sm(0.03, 0.09, w.f2[i] - w.f1[i])) * 0.1), ao: arr(N, (i) => 0.45 + h[i] * 0.55), nk: 6 };
    },
    stone(rng, N = 512) {   // dressed ashlar blocks (walls, pillars, buildings)
      const rows = 8, f = fbm(N, rng, 8, 5), st = fbm(N, rng, 3, 4), ch = fbm(N, rng, 40, 2, { turb: true });
      const offs = [], widths = [];
      for (let r = 0; r < rows; r++) { offs.push(rng.next()); const n = rng.int(2, 4); const ws = []; let tot = 0; for (let k = 0; k < n; k++) { const w = rng.float(0.7, 1.3); ws.push(w); tot += w; } let acc = 0; widths.push(ws.map((w) => (acc += w / tot))); }
      const shade = new Float32Array(rows * 8); for (let i = 0; i < shade.length; i++) shade[i] = rng.next();
      const c1 = C3(0x5f5a52), c2 = C3(0x8a847a), mort = C3(0x3a362f);
      const h = new Float32Array(N * N), bid = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const v = j / N * rows, r = Math.floor(v), fy = v - r;
        for (let i = 0; i < N; i++) {
          const u = fract(i / N + offs[r]);
          const ws = widths[r]; let k = 0; while (k < ws.length - 1 && u > ws[k]) k++;
          const u0 = k ? ws[k - 1] : 0, u1 = ws[k];
          const ex = Math.min(u - u0, u1 - u) * 6, ey = Math.min(fy, 1 - fy) * 0.75;
          const e = Math.min(ex, ey) + (f[j * N + i] - 0.5) * 0.04;
          const idx = j * N + i;
          h[idx] = sm(0.0, 0.06, e) * 0.8 + f[idx] * 0.15 - ch[idx] * 0.08;
          bid[idx] = shade[(r * 8 + k) % shade.length];
        }
      }
      const col = paint(N, (i, x, y, o) => { lerp3(o, c1, c2, bid[i] * 0.6 + st[i] * 0.4); mul3(o, 0.85 + f[i] * 0.25); lerp3(o, mort, o, sm(0.1, 0.4, h[i])); });
      return { N, col, h, rough: arr(N, (i) => 0.8 + f[i] * 0.15), ao: arr(N, (i) => 0.4 + sm(0.0, 0.5, h[i]) * 0.6), nk: 7 };
    },
    carving(rng, N = 512) {   // Delver relief bands: knot/zigzag friezes on dark stone
      const f = fbm(N, rng, 8, 5), st = fbm(N, rng, 3, 3);
      const h = arr(N, (i) => {
        const x = (i % N) / N, y = ((i / N) | 0) / N;
        const band = Math.floor(y * 4), fy = fract(y * 4);
        let v = 0;
        if (band === 1 || band === 3) { const zz = Math.abs(fract(x * 8 + (band === 3 ? 0.5 : 0)) - 0.5) * 2; v = sm(0.12, 0.05, Math.abs(fy - 0.2 - zz * 0.6)); }
        else { const cx = fract(x * 4) - 0.5, cy = fy - 0.5, r = Math.sqrt(cx * cx + cy * cy); v = sm(0.05, 0.02, Math.abs(r - 0.32)) + sm(0.05, 0.02, Math.abs(r - 0.18)) * 0.8 + sm(0.04, 0.0, Math.abs(cx - cy) * Math.abs(cx + cy) * 4); }
        const edge = sm(0.0, 0.03, Math.min(fy, 1 - fy));
        return cl(0.55 + v * 0.35 - (1 - edge) * 0.35 + f[i] * 0.12);
      });
      const c1 = C3(0x4c4842), c2 = C3(0x6e685e);
      const col = paint(N, (i, x, y, o) => { lerp3(o, c1, c2, st[i] * 0.6 + h[i] * 0.4); mul3(o, 0.8 + f[i] * 0.3); });
      return { N, col, h, rough: arr(N, (i) => 0.82 + f[i] * 0.1), ao: arr(N, (i) => 0.4 + h[i] * 0.6), nk: 8 };
    },
    bark(rng, N = 256) {
      const r1 = fbm(N, rng, 6, 5, { py: 1, ridged: true }), f = fbm(N, rng, 16, 3, { py: 4 }), lic = fbm(N, rng, 4, 3);
      const b1 = C3(0x1e1812), b2 = C3(0x4d4134), b3 = C3(0x6a6050), moss = C3(0x3d4a22);
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, b1, b2, sm(0.15, 0.75, r1[i]));
        lerp3(o, o, b3, sm(0.7, 0.95, r1[i] * 0.7 + f[i] * 0.3) * 0.6);
        if (lic[i] > 0.68) lerp3(o, o, moss, sm(0.68, 0.85, lic[i]) * 0.7);
      });
      const h = arr(N, (i) => r1[i] * 0.8 + f[i] * 0.2);
      return { N, col, h, rough: arr(N, (i) => 0.85 + f[i] * 0.12), ao: arr(N, (i) => 0.35 + h[i] * 0.65), nk: 9 };
    },
    wood(rng, N = 256) {   // weathered planks (bridges, wagons, boardwalks, siege timber)
      const planks = 4, g = fbm(N, rng, 2, 4, { py: 16 }), k = fbm(N, rng, 4, 3), f = fbm(N, rng, 32, 2);
      const sh = []; for (let p = 0; p < planks; p++) sh.push(rng.next());
      const w1 = C3(0x4a3a2a), w2 = C3(0x7a6248), grey = C3(0x6e675e);
      const h = arr(N, (i) => { const x = (i % N) / N; const fx = fract(x * planks); const seam = sm(0.0, 0.04, Math.min(fx, 1 - fx)); return seam * (0.6 + g[i] * 0.4) - (k[i] > 0.85 ? 0.2 : 0); });
      const col = paint(N, (i, x, y, o) => {
        const p = Math.floor(x / N * planks);
        const grain = 0.5 + 0.5 * Math.sin(g[i] * 40 + sh[p] * 20);
        lerp3(o, w1, w2, grain * 0.5 + sh[p] * 0.5);
        lerp3(o, o, grey, 0.35 + k[i] * 0.3);
        mul3(o, 0.35 + h[i] * 0.65 + f[i] * 0.1);
      });
      return { N, col, h, rough: arr(N, (i) => 0.78 + f[i] * 0.15), ao: arr(N, (i) => 0.5 + h[i] * 0.5), nk: 5 };
    },
    thatch(rng, N = 256) {
      const s = fbm(N, rng, 48, 3, { py: 3 }), f = fbm(N, rng, 4, 4), rows = 6;
      const t1 = C3(0x3a3222), t2 = C3(0x8a7650), dk = C3(0x2a241a);
      const h = arr(N, (i) => { const y = ((i / N) | 0) / N; const fy = fract(y * rows + s[i] * 0.15); return s[i] * 0.6 + sm(0.0, 0.85, fy) * 0.4; });
      const col = paint(N, (i, x, y, o) => { lerp3(o, t1, t2, s[i] * 0.7 + f[i] * 0.3); lerp3(o, dk, o, sm(0.05, 0.5, h[i])); });
      return { N, col, h, rough: arr(N, () => 0.95), ao: arr(N, (i) => 0.4 + h[i] * 0.6), nk: 6 };
    },
    plaster(rng, N = 256) {
      const f = fbm(N, rng, 6, 5), st = fbm(N, rng, 2, 4), w = worley(N, 5, rng);
      const p1 = C3(0x9a9182), p2 = C3(0xc8bea8), stain = C3(0x6a5e4a);
      const col = paint(N, (i, x, y, o) => { lerp3(o, p1, p2, f[i]); lerp3(o, o, stain, sm(0.6, 0.95, st[i]) * 0.5 * (y / N)); if (w.f2[i] - w.f1[i] < 0.015) mul3(o, 0.7); });
      const h = arr(N, (i) => f[i] * 0.7 - (w.f2[i] - w.f1[i] < 0.02 ? 0.3 : 0));
      return { N, col, h: norm(h), rough: arr(N, () => 0.92), ao: arr(N, (i) => 0.8 + f[i] * 0.2), nk: 3 };
    },
    ash(rng, N = BIG()) {
      const f = fbm(N, rng, 5, 6), d = fbm(N, rng, 3, 4), w = worley(N, 50, rng), cr = worley(N, 7, rng);
      const a1 = C3(0x1c1a19), a2 = C3(0x4a4642), char = C3(0x0e0d0d), rust = C3(0x4a2c1e);
      const col = paint(N, (i, x, y, o) => {
        lerp3(o, a1, a2, sm(0.35, 0.8, d[i]) * 0.8 + f[i] * 0.2);
        if (w.f1[i] < 0.25) lerp3(o, o, char, 0.7);
        const c = 1 - sm(0.0, 0.04, cr.f2[i] - cr.f1[i]);
        lerp3(o, o, rust, c * 0.5 * (1 - d[i]));
      });
      const h = arr(N, (i) => d[i] * 0.4 + f[i] * 0.4 + (w.f1[i] < 0.25 ? 0.15 : 0) - (1 - sm(0.0, 0.05, cr.f2[i] - cr.f1[i])) * 0.25);
      return { N, col, h: norm(h), rough: arr(N, (i) => 0.9 + f[i] * 0.08), ao: arr(N, (i) => 0.6 + h[i] * 0.4), nk: 4 };
    },
    scorched(rng, N = BIG()) {   // cracked baked earth of the Ashen March
      const w = worley(N, 9, rng, 0.9), f = fbm(N, rng, 6, 5), d = fbm(N, rng, 3, 3);
      const e1 = C3(0x2a1c16), e2 = C3(0x4e3426), crk = C3(0x0c0806), dust = C3(0x5a4c44);
      const col = paint(N, (i, x, y, o) => { const e = w.f2[i] - w.f1[i]; lerp3(o, e1, e2, f[i] * 0.6 + w.id[i] * 0.4); lerp3(o, o, dust, sm(0.6, 0.9, d[i]) * 0.5); lerp3(o, crk, o, sm(0.01, 0.06, e)); });
      const h = arr(N, (i) => sm(0.01, 0.12, w.f2[i] - w.f1[i]) * 0.7 + f[i] * 0.3);
      return { N, col, h, rough: arr(N, (i) => 0.88 + f[i] * 0.1), ao: arr(N, (i) => 0.5 + h[i] * 0.5), nk: 6 };
    },
    basalt(rng, N = BIG()) {
      const w = worley(N, 5, rng, 0.6), f = fbm(N, rng, 12, 5), s = fbm(N, rng, 3, 3, { ridged: true });
      const b1 = C3(0x1e1c1c), b2 = C3(0x464040), sheen = C3(0x5a4c48);
      const col = paint(N, (i, x, y, o) => { const e = w.f2[i] - w.f1[i]; lerp3(o, b1, b2, w.id[i] * 0.5 + f[i] * 0.5); lerp3(o, o, sheen, s[i] * 0.3); mul3(o, 0.6 + sm(0.0, 0.1, e) * 0.4); });
      const h = arr(N, (i) => sm(0.0, 0.14, w.f2[i] - w.f1[i]) * 0.6 + f[i] * 0.25 + s[i] * 0.15);
      return { N, col, h, rough: arr(N, (i) => 0.55 + f[i] * 0.3), ao: arr(N, (i) => 0.4 + h[i] * 0.6), nk: 7 };
    },
    moss(rng, N = 256) {
      const f = fbm(N, rng, 16, 5), p = fbm(N, rng, 4, 3);
      const m1 = C3(0x1e2a10), m2 = C3(0x4a5e22), y = C3(0x6e7030);
      const col = paint(N, (i, x, yy, o) => { lerp3(o, m1, m2, f[i]); lerp3(o, o, y, sm(0.6, 0.9, p[i]) * 0.4); });
      return { N, col, h: f, rough: arr(N, () => 0.95), ao: arr(N, (i) => 0.6 + f[i] * 0.4), nk: 4 };
    },
    cloth(rng, N = 256) {
      const f = fbm(N, rng, 8, 4), st = fbm(N, rng, 3, 3), W = 64;
      const h = arr(N, (i) => { const x = i % N, y = (i / N) | 0; const a = Math.sin((x / N) * TAU * W) * 0.5 + 0.5, b = Math.sin((y / N) * TAU * W) * 0.5 + 0.5; const chk = ((Math.floor(x / N * W * 2) + Math.floor(y / N * W * 2)) & 1) ? a : b; return chk * 0.7 + f[i] * 0.3; });
      const c1 = C3(0x8c8676), c2 = C3(0xb2aa98);
      const col = paint(N, (i, x, y, o) => { lerp3(o, c1, c2, h[i] * 0.5 + st[i] * 0.5); });
      return { N, col, h, rough: arr(N, () => 0.95), ao: arr(N, (i) => 0.75 + h[i] * 0.25), nk: 2.5 };
    },
    leather(rng, N = 256) {
      const w = worley(N, 36, rng), f = fbm(N, rng, 6, 4), sc = fbm(N, rng, 3, 3);
      const l1 = C3(0x6a4c34), l2 = C3(0x9a7a58);
      const h = arr(N, (i) => sm(0.0, 0.15, w.f2[i] - w.f1[i]) * 0.6 + f[i] * 0.4);
      const col = paint(N, (i, x, y, o) => { lerp3(o, l1, l2, f[i] * 0.6 + sc[i] * 0.4); mul3(o, 0.8 + h[i] * 0.25); });
      return { N, col, h, rough: arr(N, (i) => 0.55 + sc[i] * 0.3), ao: arr(N, (i) => 0.7 + h[i] * 0.3), nk: 3 };
    },
    metal(rng, N = 256) {
      const br = fbm(N, rng, 1, 4, { py: 48 }), f = fbm(N, rng, 6, 5), rust = fbm(N, rng, 4, 4);
      const scr = new Float32Array(N * N);
      for (let k = 0; k < 90; k++) { let x = rng.next() * N, y = rng.next() * N; const a = rng.next() * TAU, len = rng.float(10, 60); for (let s = 0; s < len; s++) { const xi = ((x | 0) % N + N) % N, yi = ((y | 0) % N + N) % N; scr[yi * N + xi] = 1; x += Math.cos(a); y += Math.sin(a); } }
      const m1 = C3(0x6e7074), m2 = C3(0xa4a6aa), rc = C3(0x5a3a26);
      const col = paint(N, (i, x, y, o) => { lerp3(o, m1, m2, br[i] * 0.5 + f[i] * 0.5); if (scr[i]) lerp3(o, o, m2, 0.5); lerp3(o, o, rc, sm(0.72, 0.9, rust[i]) * 0.8); });
      const h = arr(N, (i) => f[i] * 0.5 + br[i] * 0.2 - scr[i] * 0.2 - sm(0.72, 0.9, rust[i]) * 0.1 + 0.2);
      const metalA = arr(N, (i) => 1 - sm(0.72, 0.9, rust[i]));
      return { N, col, h, rough: arr(N, (i) => 0.32 + f[i] * 0.2 + br[i] * 0.1 + sm(0.72, 0.9, rust[i]) * 0.45 - scr[i] * 0.1), metalA, metal: 1, ao: arr(N, () => 1), nk: 2 };
    },
    skin(rng, N = 256) {
      const f = fbm(N, rng, 32, 3), p = fbm(N, rng, 4, 3);
      const s1 = C3(0xb88a6e), s2 = C3(0xd6aa8c), red = C3(0xc07a6a);
      const col = paint(N, (i, x, y, o) => { lerp3(o, s1, s2, p[i]); lerp3(o, o, red, sm(0.6, 0.9, f[i]) * 0.15); });
      return { N, col, h: f, rough: arr(N, (i) => 0.5 + f[i] * 0.15), ao: arr(N, () => 1), nk: 1.2 };
    },
    lava(rng, N = 256) {
      const w = worley(N, 6, rng, 0.9), f = fbm(N, rng, 6, 5), g = fbm(N, rng, 3, 3);
      const crust = C3(0x1a1210), c2 = C3(0x2e1e18);
      const emis = new Uint8Array(N * N * 4);
      const h = new Float32Array(N * N);
      const col = paint(N, (i, x, y, o) => {
        const e = w.f2[i] - w.f1[i];
        const crack = 1 - sm(0.0, 0.08 + g[i] * 0.06, e);
        h[i] = (1 - crack) * 0.7 + f[i] * 0.3;
        lerp3(o, crust, c2, f[i]);
        mul3(o, 1 - crack * 0.7);
        const k = cl(crack * 1.2 + (g[i] > 0.75 ? (g[i] - 0.75) * 2 : 0));
        emis[i * 4] = cl(k * 1.0) * 255; emis[i * 4 + 1] = cl(k * k * 0.55 + k * 0.05) * 255; emis[i * 4 + 2] = cl(k * k * k * 0.15) * 255; emis[i * 4 + 3] = 255;
      });
      return { N, col, h, rough: arr(N, (i) => 0.6 + f[i] * 0.3), ao: arr(N, () => 1), nk: 5, emis };
    }
  };
  const ALIAS = { wood: 'wood', thatch: 'thatch' };
  const NAMES = Object.keys(R);

  function build(name) {
    const fn = R[name] || R[ALIAS[name]] || R.stone;
    return finish(name, fn(AB.rng('tex:' + name)));
  }

  // ======================================================================= alpha cards (canvas drawn, dilated, DataTexture)
  function canvas(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (draw) draw(g, w, h);
    return c;
  }
  function texFrom(c, srgb = true) {
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    t.anisotropy = 4;
    t.userData.shared = true;
    return t;
  }
  // canvas -> RGBA with transparent texels filled by the nearest opaque colour (no dark fringes on alpha-tested cards)
  function cardFromCanvas(c, opts = {}) {
    const w = c.width, h = c.height;
    const src = c.getContext('2d').getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h * 4);
    const filled = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4, di = ((h - 1 - y) * w + x) * 4;   // flip rows: canvas top = v 1
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
        if (src[si + 3] > 8) filled[(h - 1 - y) * w + x] = 1;
      }
    }
    // dilate colour into empty texels (a few passes)
    for (let pass = 0; pass < (opts.dilate || 6); pass++) {
      const nf = filled.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = 0; k < 4; k++) {
          const xx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), yy = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!filled[j]) continue;
          r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; n++;
        }
        if (n) { out[i * 4] = r / n; out[i * 4 + 1] = g / n; out[i * 4 + 2] = b / n; nf[i] = 1; }
      }
      filled.set(nf);
    }
    const t = dataTex(out, w, opts.srgb !== false, h);
    if (opts.clamp) { t.wrapS = t.wrapT = T.ClampToEdgeWrapping; }
    return t;
  }
  const rgba = (r, g, b, a = 1) => 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a + ')';
  const CARDS = {
    leaves(g, w, h, rng) {   // broadleaf cluster: twigs + many overlapping leaves
      g.lineCap = 'round';
      const cx = w / 2, cy = h * 0.95;
      const tips = [];
      for (let b = 0; b < 7; b++) {
        const a = -Math.PI / 2 + rng.float(-1.0, 1.0); const len = rng.float(0.35, 0.62) * h;
        const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
        g.strokeStyle = rgba(60, 46, 32); g.lineWidth = 5; g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(cx + Math.cos(a) * len * 0.5 + rng.float(-30, 30), cy + Math.sin(a) * len * 0.5, ex, ey); g.stroke();
        for (let k = 0; k < 6; k++) { const t = rng.float(0.35, 1); tips.push([cx + (ex - cx) * t, cy + (ey - cy) * t]); }
      }
      for (let i = 0; i < 260; i++) {
        const tp = tips[i % tips.length];
        const x = tp[0] + rng.float(-46, 46), y = tp[1] + rng.float(-46, 40);
        if (Math.hypot(x - w / 2, (y - h * 0.5) * 1.1) > w * 0.49) continue;
        const a = rng.float(0, TAU), L = rng.float(18, 30), W = L * rng.float(0.38, 0.5);
        const shade = rng.float(0.65, 1.15), yellow = rng.next() < 0.12 ? rng.float(0.2, 0.5) : 0;
        const r = (64 + yellow * 90) * shade, gg = (96 + yellow * 40) * shade, b = (36 - yellow * 10) * shade;
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = rgba(r, gg, b); g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(W, L * 0.45, 0, L); g.quadraticCurveTo(-W, L * 0.45, 0, 0); g.fill();
        g.strokeStyle = rgba(r * 0.7, gg * 0.75, b * 0.7, 0.8); g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, 1); g.lineTo(0, L * 0.92); g.stroke();
        g.fillStyle = rgba(255, 255, 230, 0.07); g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(W * 0.8, L * 0.4, 0, L * 0.95); g.fill();
        g.restore();
      }
    },
    pine(g, w, h, rng) {   // fir branch seen from above: twig from left (trunk) to right (tip), needles both sides
      g.lineCap = 'round';
      const y0 = h / 2;
      const twig = (x0, yA, x1, yB, thick, dens) => {
        g.strokeStyle = rgba(58, 44, 30); g.lineWidth = thick; g.beginPath(); g.moveTo(x0, yA); g.lineTo(x1, yB); g.stroke();
        const len = Math.hypot(x1 - x0, yB - yA), ux = (x1 - x0) / len, uy = (yB - yA) / len;
        for (let s = 0; s < len; s += 2.2) {
          const t = s / len, px = x0 + ux * s, py = yA + uy * s;
          const nl = (10 + 16 * (1 - Math.abs(t - 0.45))) * dens;
          for (const side of [-1, 1]) {
            const a = Math.atan2(uy, ux) + side * rng.float(0.55, 1.05);
            const sh = rng.float(0.7, 1.15);
            g.strokeStyle = rgba(40 * sh, 68 * sh, 44 * sh, 0.95); g.lineWidth = 1.6;
            g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * nl, py + Math.sin(a) * nl); g.stroke();
          }
        }
      };
      twig(4, y0, w - 10, y0 + rng.float(-6, 6), 6, 1.25);
      for (let k = 0; k < 7; k++) {
        const x = rng.float(0.15, 0.75) * w, side = k % 2 ? 1 : -1, len = rng.float(0.18, 0.32) * w;
        twig(x, y0, x + len * 0.8, y0 + side * len * 0.55, 3, 0.85);
      }
    },
    fern(g, w, h, rng) {   // one frond: rachis bottom->top with paired pinnae
      g.lineCap = 'round';
      const cx = w / 2;
      g.strokeStyle = rgba(60, 74, 30); g.lineWidth = 3; g.beginPath(); g.moveTo(cx, h); g.quadraticCurveTo(cx + 8, h * 0.5, cx, 4); g.stroke();
      for (let y = h - 14; y > 8; y -= 7) {
        const t = 1 - y / h, L = Math.sin(Math.min(1, t * 1.15) * Math.PI) * w * 0.44 + 6;
        for (const side of [-1, 1]) {
          const sh = rng.float(0.8, 1.15);
          g.fillStyle = rgba(58 * sh, 92 * sh, 34 * sh);
          g.beginPath(); g.moveTo(cx, y); g.quadraticCurveTo(cx + side * L * 0.5, y - 9, cx + side * L, y - 4 - t * 6); g.quadraticCurveTo(cx + side * L * 0.5, y + 1, cx, y + 3); g.fill();
        }
      }
    },
    moss(g, w, h, rng) {   // hanging moss: 4 wispy clumps of tapering strands (no hard top edge, no comb)
      for (let cl = 0; cl < 4; cl++) {
        const cx = rng.float(20, 108) * (w / 128), len = rng.float(0.45, 0.95);
        for (let i = 0; i < 9; i++) {
          let x = cx + rng.float(-11, 11);
          const y0 = rng.float(0, 30) * (h / 256), L = len * rng.float(0.6, 1.0) * h, sh = rng.float(0.8, 1.1);
          const gr = g.createLinearGradient(0, y0, 0, y0 + L);
          gr.addColorStop(0, rgba(120 * sh, 128 * sh, 92 * sh, 0.95)); gr.addColorStop(0.7, rgba(110 * sh, 118 * sh, 84 * sh, 0.8)); gr.addColorStop(1, rgba(100 * sh, 108 * sh, 78 * sh, 0));
          g.strokeStyle = gr; g.lineWidth = rng.float(1, 3);
          g.beginPath(); g.moveTo(x, y0);
          for (let y = y0; y < y0 + L; y += 6) { x += rng.float(-1.5, 1.5); g.lineTo(x, y); }
          g.stroke();
        }
      }
    },
    grass(g, w, h, rng) {   // a tuft of thin tapered blades, dark root -> pale tip (crossed alpha cards in the grass patch)
      for (let i = 0; i < 26; i++) {
        const x0 = rng.float(20, 236) * (w / 256), bh = rng.float(120, 250) * (h / 256), bw = rng.float(3.5, 6.5) * (w / 256), lean = rng.float(-35, 35) * (w / 256);
        const sh = rng.float(0.86, 1.44);
        const c3 = (r, gg, b) => rgba(Math.min(255, r * sh), Math.min(255, gg * sh), Math.min(255, b * sh));
        const gr = g.createLinearGradient(0, h, 0, h - bh);
        gr.addColorStop(0, c3(48, 66, 26)); gr.addColorStop(0.5, c3(122, 140, 58)); gr.addColorStop(1, c3(206, 200, 116));
        g.fillStyle = gr; g.beginPath();
        g.moveTo(x0 - bw, h); g.quadraticCurveTo(x0 - bw * 0.6 + lean * 0.3, h - bh * 0.55, x0 + lean, h - bh);
        g.quadraticCurveTo(x0 + bw * 0.6 + lean * 0.3, h - bh * 0.55, x0 + bw, h); g.closePath(); g.fill();
      }
    },
    smoke(g, w, h, rng) {
      for (let i = 0; i < 40; i++) {
        const x = w / 2 + rng.float(-0.2, 0.2) * w, y = h / 2 + rng.float(-0.2, 0.2) * h, r = rng.float(0.12, 0.3) * w;
        const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
    },
    flame(g, w, h) {
      const gr = g.createRadialGradient(w / 2, h * 0.78, 2, w / 2, h * 0.62, w * 0.5);
      gr.addColorStop(0, 'rgba(255,250,220,1)'); gr.addColorStop(0.25, 'rgba(255,200,90,0.95)'); gr.addColorStop(0.6, 'rgba(255,110,30,0.55)'); gr.addColorStop(1, 'rgba(160,30,0,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(w / 2, 2); g.bezierCurveTo(w * 0.95, h * 0.55, w * 0.85, h, w / 2, h); g.bezierCurveTo(w * 0.15, h, w * 0.05, h * 0.55, w / 2, 2); g.fill();
    },
    mist(g, w, h, rng) {
      for (let i = 0; i < 60; i++) {
        const x = rng.float(0.15, 0.85) * w, y = rng.float(0.3, 0.7) * h, r = rng.float(0.08, 0.22) * w;
        const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
    },
    shaft(g, w, h) {
      const gx = g.createLinearGradient(0, 0, w, 0); gx.addColorStop(0, 'rgba(255,255,255,0)'); gx.addColorStop(0.5, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gx; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-in';
      const gy = g.createLinearGradient(0, 0, 0, h); gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(0.2, 'rgba(0,0,0,1)'); gy.addColorStop(0.75, 'rgba(0,0,0,0.6)'); gy.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gy; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    },
    glint(g, w, h) {
      const c = w / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,240,200,0.6)'); gr.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,250,230,0.9)';
      g.beginPath(); g.moveTo(c, 0); g.lineTo(c + 2, c - 2); g.lineTo(w, c); g.lineTo(c + 2, c + 2); g.lineTo(c, h); g.lineTo(c - 2, c + 2); g.lineTo(0, c); g.lineTo(c - 2, c - 2); g.closePath(); g.fill();
    },
    banner(g, w, h, rng) {   // tattered cloth banner (tinted by material colour), sigil left to the material
      g.fillStyle = rgba(200, 196, 186); g.beginPath(); g.moveTo(0, 0); g.lineTo(w, 0);
      const teeth = 5; for (let k = 0; k <= teeth; k++) { const x = w - (k / teeth) * w; const y = h - (k % 2 ? rng.float(0.08, 0.2) * h : 0) - rng.float(0, 0.06) * h; g.lineTo(x, y); }
      g.closePath(); g.fill();
      g.strokeStyle = rgba(120, 112, 100, 0.8); g.lineWidth = 3; g.strokeRect(6, 6, w - 12, h * 0.55);
      g.fillStyle = rgba(90, 84, 76, 0.85); g.beginPath(); g.arc(w / 2, h * 0.34, w * 0.18, 0, TAU); g.fill();
      g.fillStyle = rgba(200, 196, 186); g.beginPath(); g.arc(w / 2, h * 0.34, w * 0.1, 0, TAU); g.fill();
      for (let i = 0; i < 12; i++) { g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(rng.float(0, w), rng.float(0.5, 1) * h, rng.float(3, 9), rng.float(4, 14)); }
    }
  };
  const CARD_SIZE = { leaves: [512, 512], pine: [512, 256], fern: [128, 512], moss: [128, 256], grass: [256, 256], smoke: [128, 128], flame: [64, 128], mist: [256, 128], shaft: [64, 256], glint: [64, 64], banner: [128, 256] };

  function card(name) {
    if (cards.has(name)) return cards.get(name);
    const sz = CARD_SIZE[name] || [128, 128];
    const rng = AB.rng('card:' + name);
    const c = canvas(sz[0], sz[1], (g, w, h) => (CARDS[name] || CARDS.smoke)(g, w, h, rng));
    const t = cardFromCanvas(c, { clamp: name !== 'mist', dilate: name === 'leaves' || name === 'pine' || name === 'fern' ? 8 : 2 });
    cards.set(name, t);
    return t;
  }

  // shared helper textures
  let _noise = null, _water = null, _dot = null;
  function noiseTex() {   // RGBA linear: R fbm4, G fbm16, B worley8 F1, A fbm32 (tileable)
    if (_noise) return _noise;
    const N = 256, rng = AB.rng('tex:noise');
    const a = fbm(N, rng, 4, 4), b = fbm(N, rng, 16, 3), w = worley(N, 8, rng), d = fbm(N, rng, 32, 2);
    const out = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) { out[i * 4] = a[i] * 255; out[i * 4 + 1] = b[i] * 255; out[i * 4 + 2] = cl(w.f1[i]) * 255; out[i * 4 + 3] = d[i] * 255; }
    _noise = dataTex(out, N, false);
    return _noise;
  }
  function waterNormal() {
    if (_water) return _water;
    const N = 256, rng = AB.rng('tex:water');
    const a = fbm(N, rng, 4, 3), b = fbm(N, rng, 12, 3, { ridged: true });
    const h = arr(N, (i) => a[i] * 0.55 + b[i] * 0.45);
    _water = dataTex(normalFrom(h, N, 2.5), N, false);
    return _water;
  }

  AB.tex = {
    get SIZE() { return BIG(); },
    names: NAMES,
    // init(progress?) -> Promise. Pre-builds the sets + cards the title level (act 1) needs, yielding to the browser
    // every ~40 ms so the loading screen keeps animating and its progress bar moves (progress(0..1)). Actor-only sets
    // are warmed after the first frame (idle time). Everything stays lazy-safe: get()/card() build on demand anyway.
    async init(progress) {
      AB.bus.on('quality', onQuality);
      const jobs = [];
      for (const n of ['stone', 'bark', 'wood', 'cloth', 'metal', 'rock', 'plaster', 'thatch', 'cobble', 'carving', 'basalt', 'grass', 'forest', 'mud', 'road']) jobs.push(() => AB.tex.get(n));
      jobs.push(noiseTex);
      for (const c of ['leaves', 'pine', 'fern', 'moss', 'banner', 'grass', 'flame', 'smoke', 'glint', 'shaft', 'mist']) jobs.push(() => card(c));
      const yieldFrame = () => new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } }; requestAnimationFrame(f); setTimeout(f, 30); });
      let last = performance.now();
      for (let i = 0; i < jobs.length; i++) {
        jobs[i]();
        if (progress) progress((i + 1) / jobs.length);
        if (performance.now() - last > 40) { await yieldFrame(); last = performance.now(); }
      }
      // non-critical: actor-only sets, built when the browser is idle after the title is up
      AB.bus.on('boot:done', () => {
        const later = ['leather', 'skin'];
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
        const next = () => { const n = later.shift(); if (!n) return; AB.tex.get(n); idle(next); };
        idle(next);
      });
    },
    // get(name, repeatX = 1, repeatY = repeatX) -> { map, normalMap, roughnessMap } (shared; clones share GPU images)
    get(name, rx = 1, ry = rx) {
      if (!R[name] && !ALIAS[name]) name = 'stone';
      if (!sets.has(name)) sets.set(name, build(name));
      if (rx === 1 && ry === 1) return sets.get(name);
      const key = name + '|' + rx + '|' + ry;
      if (!clones.has(key)) {
        const b = sets.get(name), o = { size: b.size, metal: b.metal };
        for (const k of ['map', 'normalMap', 'roughnessMap']) { const t = b[k].clone(); t.repeat.set(rx, ry); t.userData.shared = true; t.needsUpdate = true; o[k] = t; }
        clones.set(key, o);
      }
      return clones.get(key);
    },
    // material(name, opts) -> shared MeshStandardMaterial. opts: { color, repeat, roughness, metalness, emissive,
    //   emissiveIntensity, vertexColors, side, transparent, opacity, flatShading, normalScale, envMapIntensity }.
    material(name, opts = {}) {
      const key = name + JSON.stringify(opts);
      if (mats.has(key)) return mats.get(key);
      const rep = opts.repeat || 1;
      const set = AB.tex.get(name, Array.isArray(rep) ? rep[0] : rep, Array.isArray(rep) ? rep[1] : rep);
      const m = new T.MeshStandardMaterial({
        map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
        metalnessMap: set.metal ? set.roughnessMap : null,
        color: opts.color != null ? opts.color : 0xffffff,
        roughness: opts.roughness != null ? opts.roughness : 1, metalness: opts.metalness != null ? opts.metalness : (set.metal ? 1 : 0),
        emissive: opts.emissive != null ? opts.emissive : 0x000000, emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : 1,
        vertexColors: !!opts.vertexColors, side: opts.side != null ? opts.side : T.FrontSide, transparent: !!opts.transparent,
        opacity: opts.opacity != null ? opts.opacity : 1, flatShading: !!opts.flatShading
      });
      const ns = opts.normalScale != null ? opts.normalScale : 1;
      m.normalScale.set(ns, ns);
      if (opts.envMapIntensity != null) m.envMapIntensity = opts.envMapIntensity;
      m.userData.shared = true;
      mats.set(key, m);
      return m;
    },
    // splat(name) -> { map: albedo rgb + roughness a (sRGB), normal: rgb + height a (linear) } for the terrain shader
    splat(name) {
      if (splats.has(name)) return splats.get(name);
      AB.tex.get(name);
      const r = raw.get(name);
      const alb = new Uint8Array(r.alb);
      for (let i = 0; i < r.N * r.N; i++) alb[i * 4 + 3] = r.orm[i * 4 + 1];
      const s = { map: dataTex(alb, r.N, true), normal: sets.get(name).normalMap, size: r.N };
      splats.set(name, s);
      return s;
    },
    emissive(name) { AB.tex.get(name); return emissives.get(name) || null; },
    card, noise: noiseTex, waterNormal,
    // dot() -> shared soft round sprite (white, alpha falloff) for PointsMaterial.map (points are squares without it)
    dot() {
      if (!_dot) {
        const c = canvas(64, 64, (g) => { const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.6)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); });
        _dot = texFrom(c, true);
      }
      return _dot;
    },
    // canvas(w, h, draw(ctx, w, h)) -> HTMLCanvasElement (helper for one-off procedural textures)
    canvas,
    // texture(canvasEl, srgb = true) -> CanvasTexture flagged shared, RepeatWrapping
    texture: texFrom,
    // low-level kit (other lanes may reuse): fbm(N, rng, period, octaves, opts) / worley(N, cells, rng) -> Float32Array(s)
    fbm, worley
  };
}
