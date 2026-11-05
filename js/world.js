'use strict';
/* ASHBEARER v3 :: world.js
   OWNER: WORLD lane (world.js + textures.js).
   The three act levels + the Forge: seeded road spline, sculpted heightfield (valley walls, cliffs, fen pools, stream,
   Undervault halls with a ceiling heightfield, lava fissures), splatted PBR terrain, sky/fog/lighting presets blended
   per zone, instanced vegetation with wind, displaced rocks, water and lava shaders, landmarks and architecture,
   POI beacons, ambient life (particles, birds, bats, mist, light shafts), a pooled set of point lights, camera
   collision and minimap data.
   CONTRACT (INTERFACES.md section 5): level shape, POI shape, heightAt/normalAt/roadPoint/roadYaw/roadInfo/guide/
   constrain/surfaceAt/poi/prop, uniforms. Gameplay and the bot depend on them; layout is quality-independent.
   Coordinates: meters, Y up, yaw 0 faces +Z. The main road starts near (0,0) and runs roughly toward +Z.
   Simulation-facing code (layout, colliders, queries) is deterministic and allocation-free in hot paths; everything
   in the frame system is cosmetic. Source parts live in progress/world-src (concatenated by the world lane). */
{
  const T = AB.THREE;
  const U = AB.util;
  const V3 = T.Vector3;
  const CELL = 2;                       // terrain grid cell (m)
  const ROAD_HALF = 3;                  // road half width (m)
  const TAU = Math.PI * 2;
  const sm = (a, b, v) => { const t = U.clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ----------------------------------------------------------------------------- act definitions (layout side)
  const ACTS = {
    1: { length: 450, corridor: 30, wiggle: 20,
      zones: [['Thistledown Vale', 0, 0.3], ['the Whisperwood', 0.3, 0.65], ['the Fenmarsh', 0.65, 1.01]] },
    2: { length: 450, corridor: 28, wiggle: 22, hall: 0.56,
      zones: [['the Greyspire Pass', 0, 0.5], ['the Gate of Undervault', 0.5, 0.58], ['the Drowned Halls of Undervault', 0.58, 1.01]] },
    3: { length: 450, corridor: 30, wiggle: 18,
      zones: [['the Cinder Plains', 0, 0.4], ['the Broken Siegeworks', 0.4, 0.75], ['the Gate of Mount Cindral', 0.75, 1.01]] },
    forge: { length: 80, corridor: 3.2, wiggle: 0,
      zones: [['the Unmaking Forge', 0, 1.01]] }
  };
  // main-road POI layout: [fraction of road length, type, lateral offset (m)]
  const MAIN_LAYOUT = [
    [0.10, 'event', 9], [0.20, 'battle', 0], [0.27, 'chest', 6], [0.32, 'battle', 0], [0.37, 'event', 9], [0.42, 'camp', 10],
    [0.48, 'battle', 0], [0.53, 'haven', 11], [0.58, 'event', 9], [0.62, 'battle', 0], [0.70, 'event', 9], [0.78, 'battle', 0],
    [0.84, 'chest', 6], [0.90, 'camp', 10]
  ];
  // Act 2 keeps the gate funnel (s 0.51-0.60) clear of roadside POIs: the Gate of Undervault narrows the pass to 14 m.
  const MAIN_LAYOUT_2 = [
    [0.09, 'event', 9], [0.18, 'battle', 0], [0.27, 'chest', 6], [0.31, 'battle', 0], [0.36, 'event', 9], [0.41, 'camp', 10],
    [0.47, 'haven', 11], [0.515, 'battle', 0], [0.64, 'event', 9], [0.68, 'battle', 0], [0.73, 'event', 9], [0.80, 'battle', 0],
    [0.85, 'chest', 6], [0.91, 'camp', 10]
  ];
  // branches: [fraction where it leaves the road, length (m), contents [[bs from start, type, lateral]]]
  const BRANCH_LAYOUT = [
    [0.24, 52, [[40, 'elite', 0], [50, 'chest', 0]]],
    [0.50, 40, [[38, 'shrine', 0]]],
    [0.74, 46, [[44, 'event', 0], [36, 'chest', 4]]]
  ];
  const BRANCH_LAYOUT_2 = [
    [0.24, 52, [[40, 'elite', 0], [50, 'chest', 0]]],
    [0.44, 40, [[38, 'shrine', 0]]],
    [0.77, 44, [[42, 'event', 0], [34, 'chest', 4]]]
  ];
  const RADIUS = { battle: 13, elite: 14, boss: 18 };

  // ----------------------------------------------------------------------------- layout state
  let level = null;
  let actKey = 1;
  let def = ACTS[1];
  let grid = null;                // { x0, z0, nx, nz, H (walk height), R (render height), D, DM, N, C (ceiling or NaN) }
  let samples = null;             // { x, z, s, br, bs, corr } per path sample (1 m apart)
  let mainN = 0;                  // count of main-road samples (first in `samples`)
  let branches = [];              // [{ id, index, s0, side, len, start, items }]
  let feat = null;                // per-level terrain features (stream, pools, hall, fissures...)
  let hall = null;                // act 2 halls / forge cavern: { s0, floor, ceil(x,z) } or null
  const props = new Map();        // poiId -> Object3D
  const scratch = { s: 0, d: 0, branch: null, bs: 0, x: 0, z: 0 };
  const riTmp = { s: 0, d: 0, branch: null, bs: 0, x: 0, z: 0 };
  const guideOut = { x: 0, z: 0, dist: 0 };
  const tmpV = new V3();
  const uniforms = { uTime: { value: 0 }, uWind: { value: new T.Vector2(1, 0.3) } };

  // ----------------------------------------------------------------------------- road + branches
  function buildRoad(act, rng) {
    def = ACTS[act];
    const L = def.length;
    const pts = [];
    if (act === 'forge') { for (let i = 0; i <= 3; i++) pts.push(new V3(0, 0, i * (L + 4) / 3)); }
    else {
      let x = 0;
      const hallS = def.hall ? def.hall * L : 1e9;
      for (let i = 0; i * 40 <= L + 80; i++) {
        const z = i * 40;
        if (i > 1 && z < hallS - 20) x = U.clamp(x + rng.float(-def.wiggle, def.wiggle), -60, 60);
        else if (i > 1 && z > hallS + 120 && z < L - 60) x = U.clamp(x + rng.float(-8, 8), -60, 60);   // halls run straight, one gentle bend
        pts.push(new V3(x, 0, z));
      }
    }
    const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
    const n = Math.round(curve.getLength());
    const sp = curve.getSpacedPoints(n);
    const xs = [sp[0].x], zs = [sp[0].z];
    let acc = 0;
    for (let i = 1; i < sp.length && xs.length <= L; i++) {
      const seg = Math.hypot(sp[i].x - sp[i - 1].x, sp[i].z - sp[i - 1].z);
      acc += seg;
      while (acc >= 1 && xs.length <= L) { acc -= 1; const k = 1 - acc / seg; xs.push(sp[i - 1].x + (sp[i].x - sp[i - 1].x) * k); zs.push(sp[i - 1].z + (sp[i].z - sp[i - 1].z) * k); }
    }
    const list = [];
    for (let i = 0; i < xs.length; i++) list.push([xs[i], zs[i], i, -1, 0]);
    mainN = list.length;
    branches = [];
    if (act !== 'forge') {
      (act === 2 ? BRANCH_LAYOUT_2 : BRANCH_LAYOUT).forEach((b, bi) => {
        const s0 = Math.round(b[0] * L + rng.float(-6, 6));
        const side = rng.chance(0.5) ? 1 : -1;
        const i0 = U.clamp(s0, 1, mainN - 2);
        const tx = xs[i0 + 1] - xs[i0 - 1], tz = zs[i0 + 1] - zs[i0 - 1];
        let yaw = Math.atan2(tx, tz) + side * 1.35;
        let bx = xs[i0], bz = zs[i0];
        const start = list.length;
        for (let k = 0; k <= b[1]; k++) {
          list.push([bx, bz, s0, bi, k]);
          yaw -= side * 0.012;
          bx += Math.sin(yaw); bz += Math.cos(yaw);
        }
        branches.push({ id: 'b' + (bi + 1), index: bi, s0, side, len: b[1], start, items: b[2] });
      });
    }
    const N = list.length;
    samples = { x: new Float32Array(N), z: new Float32Array(N), s: new Float32Array(N), br: new Int16Array(N), bs: new Float32Array(N), corr: new Float32Array(N), n: N };
    list.forEach((p, i) => { samples.x[i] = p[0]; samples.z[i] = p[1]; samples.s[i] = p[2]; samples.br[i] = p[3]; samples.bs[i] = p[4]; samples.corr[i] = corrAt(p[2]); });
  }
  // walkable half-width of the corridor around the road at arc length s (act 2 narrows to the Gate of Undervault)
  function corrAt(s) {
    if (!def.hall || actKey !== 2) return def.corridor;
    const hs = def.hall * def.length, c = def.corridor;
    if (s < hs - 24) return c;
    if (s < hs - 5) return U.lerp(c, 7, sm(hs - 24, hs - 5, s));
    if (s < hs + 5) return 7;
    return U.lerp(7, c, sm(hs + 5, hs + 22, s));
  }
  const mainYaw = (i) => { i = U.clamp(Math.round(i), 1, mainN - 2); return Math.atan2(samples.x[i + 1] - samples.x[i - 1], samples.z[i + 1] - samples.z[i - 1]); };

  // ----------------------------------------------------------------------------- terrain features (planned before heights)
  function planFeatures(act, rng) {
    const L = def.length;
    const f = { act, stream: null, pools: null, fissures: [], fenBase: -1.2, waterY: null, hallS: null, floor: 0 };
    if (act === 1) {
      // a stream crossing Thistledown under a stone bridge
      const s = 66 + rng.float(-3, 3);
      const i = Math.round(s), yaw = mainYaw(i);
      const pts = [];
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      for (let k = -14; k <= 14; k++) {
        const t = k * 7;
        const wob = Math.sin(k * 0.55 + rng.float(0, 0.3)) * 6 + Math.sin(k * 0.21) * 9;
        pts.push(new V3(samples.x[i] + rx * t + Math.sin(yaw) * wob, 0, samples.z[i] + rz * t + Math.cos(yaw) * wob));
      }
      const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
      const sp = curve.getSpacedPoints(160);
      f.stream = { s, pts: sp, xs: new Float32Array(sp.map((p) => p.x)), zs: new Float32Array(sp.map((p) => p.z)), width: 2.4, depth: 1.5 };
      f.pools = { from: 0.66 * L, noise: AB.rng('pools' + rng.next()) };
    } else if (act === 2) {
      f.hallS = def.hall * L;
    } else if (act === 3) {
      // lava fissures off the road, kept clear of paths and POIs (they carry colliders)
      const n = 7;
      for (let q = 0; q < n * 6 && f.fissures.length < n; q++) {
        const s = rng.float(30, L - 60), side = rng.chance(0.5) ? 1 : -1, lat = rng.float(11, 26) * side;
        const i = Math.round(s), yaw = mainYaw(i) + rng.float(-0.9, 0.9);
        const cx = samples.x[i] + Math.cos(mainYaw(i)) * lat, cz = samples.z[i] - Math.sin(mainYaw(i)) * lat;
        const len = rng.float(14, 34);
        const pts = [];
        let ok = true;
        for (let k = 0; k <= 12; k++) {
          const t = (k / 12 - 0.5) * len;
          const w = Math.sin(k * 0.9 + q) * 1.6;
          const x = cx + Math.sin(yaw) * t + Math.cos(yaw) * w, z = cz + Math.cos(yaw) * t - Math.sin(yaw) * w;
          if (nearestPathDist(x, z) < 7) { ok = false; break; }
          pts.push(new V3(x, 0, z));
        }
        if (!ok) continue;
        const curve = new T.CatmullRomCurve3(pts);
        const sp = curve.getSpacedPoints(Math.max(8, Math.round(len / 1.5)));
        f.fissures.push({ pts: sp, width: rng.float(1.1, 1.8), s, xs: new Float32Array(sp.map((p) => p.x)), zs: new Float32Array(sp.map((p) => p.z)) });
      }
    } else if (act === 'forge') {
      f.hallS = -20;
    }
    return f;
  }
  function nearestPathDist(x, z) {
    let best = 1e18;
    for (let k = 0; k < samples.n; k++) { const dx = samples.x[k] - x, dz = samples.z[k] - z, d = dx * dx + dz * dz; if (d < best) best = d; }
    return Math.sqrt(best);
  }
  // distance from (x,z) to a polyline given as xs/zs arrays (+ the parameter t 0..1 of the nearest point)
  const plOut = { d: 0, t: 0, i: 0 };
  function polyDist(xs, zs, x, z) {
    let best = 1e18, bi = 0, bt = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t - x, pz = az + vz * t - z, d = px * px + pz * pz;
      if (d < best) { best = d; bi = i; bt = t; }
    }
    plOut.d = Math.sqrt(best); plOut.i = bi; plOut.t = (bi + bt) / Math.max(1, xs.length - 1);
    return plOut;
  }

  // ----------------------------------------------------------------------------- base profiles
  function baseAt(s) {
    const L = def.length;
    if (actKey === 1) {
      const hill = 2.5 * Math.sin(s / 70) + 1.5 * Math.sin(s / 31 + 1);
      return U.lerp(hill, feat.fenBase, sm(0.6 * L, 0.68 * L, s));
    }
    if (actKey === 2) {
      const hs = def.hall * L;
      const climb = (t) => t * 0.052 + 1.8 * Math.sin(t / 37) * sm(20, 60, t);
      return climb(Math.min(s, hs - 8)) + (s > hs - 8 ? 0 : 0);
    }
    if (actKey === 3) return 1.4 * Math.sin(s / 90) + 0.8 * Math.sin(s / 33) + sm(0.72 * L, L, s) * 7;
    return 0;
  }

  // ----------------------------------------------------------------------------- grid + heights
  function buildGrid(act, seed) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < samples.n; i++) { minX = Math.min(minX, samples.x[i]); maxX = Math.max(maxX, samples.x[i]); minZ = Math.min(minZ, samples.z[i]); maxZ = Math.max(maxZ, samples.z[i]); }
    const pad = act === 'forge' ? 46 : 80;
    const x0 = Math.floor((minX - pad) / CELL) * CELL, z0 = Math.floor((minZ - pad) / CELL) * CELL;
    const nx = Math.ceil((maxX + pad - x0) / CELL) + 1, nz = Math.ceil((maxZ + pad - z0) / CELL) + 1;
    const cnt = nx * nz;
    const H = new Float32Array(cnt), Rh = new Float32Array(cnt).fill(NaN), D = new Float32Array(cnt), DM = new Float32Array(cnt), Nn = new Int32Array(cnt), AH = new Float32Array(cnt);
    const C = (act === 2 || act === 'forge') ? new Float32Array(cnt).fill(NaN) : null;
    const nr = AB.rng('terrain' + seed + ':' + act);
    const noise = new AB.addons.SimplexNoise({ random: () => nr.next() });
    grid = { x0, z0, nx, nz, H, R: Rh, D, DM, N: Nn, AH, C, noise };
    const endX = samples.x[mainN - 1], endZ = samples.z[mainN - 1], endYaw = mainYaw(mainN - 2);
    const stX = samples.x[0], stZ = samples.z[0], stYaw = mainYaw(1);
    for (let j = 0; j < nz; j++) {
      const z = z0 + j * CELL;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * CELL;
        let best = 1e18, bi = 0, bm = 1e18;
        for (let k = 0; k < samples.n; k += 2) { const dx = samples.x[k] - x, dz = samples.z[k] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } if (k < mainN && d < bm) bm = d; }
        for (let k = Math.max(0, bi - 2); k <= Math.min(samples.n - 1, bi + 2); k++) { const dx = samples.x[k] - x, dz = samples.z[k] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } if (k < mainN && d < bm) bm = d; }
        const idx = j * nx + i;
        D[idx] = Math.sqrt(best); DM[idx] = Math.sqrt(bm); Nn[idx] = bi;
        // "ahead" distance past the end of the main road (and behind its start)
        const ahead = Math.max((x - endX) * Math.sin(endYaw) + (z - endZ) * Math.cos(endYaw), -((x - stX) * Math.sin(stYaw) + (z - stZ) * Math.cos(stYaw)));
        AH[idx] = ahead;
        const hh = terrainHeight(x, z, D[idx], DM[idx], samples.s[bi], samples.br[bi], samples.corr[bi], ahead, noise, idx);
        H[idx] = hh;
        if (Rh[idx] !== Rh[idx]) Rh[idx] = hh;
      }
    }
    // render height == walk height except where a bridge spans a channel (set in terrainHeight via Rh)
    return { minX: x0, maxX: x0 + (nx - 1) * CELL, minZ: z0, maxZ: z0 + (nz - 1) * CELL };
  }
  // walk height of the ground at a grid vertex; may write grid.R[idx] (render height under bridges) and grid.C (ceiling)
  function terrainHeight(x, z, d, dm, s, br, corr, ahead, noise, idx) {
    const L = def.length;
    const base = baseAt(s);
    const n1 = noise.noise(x * 0.018, z * 0.018), n2 = noise.noise(x * 0.07, z * 0.07), n3 = noise.noise(x * 0.0045 + 7.1, z * 0.0045);
    const n4 = noise.noise(x * 0.16, z * 0.16);
    let h;
    if (actKey === 1) {
      const fen = sm(0.6 * L, 0.68 * L, s), wood = sm(0.27 * L, 0.33 * L, s) * (1 - fen);
      const vale = 1 - wood - fen;
      const amp = 0.25 + sm(4, 30, d) * 2.4;
      let hv = base + (n1 * 0.75 + n2 * 0.25) * amp + sm(12, 75, d) * (9 + n3 * 9) + Math.max(0, d - 34) * 0.35;
      let hw = base + (n1 * 0.7 + n2 * 0.3) * (0.3 + sm(4, 24, d) * 2.0) + sm(10, 60, d) * (11 + n3 * 8) + Math.max(0, d - 30) * 0.45 + n4 * 0.15 * sm(3, 8, d);
      let hf = base + n2 * 0.12 + n4 * 0.06 + sm(30, 70, d) * (4 + n3 * 6) + Math.max(0, d - 40) * 0.2;
      h = hv * vale + hw * wood + hf * fen;
      if (d < ROAD_HALF + 1.4) h = U.lerp(base + n2 * 0.08, h, sm(ROAD_HALF - 0.5, ROAD_HALF + 1.4, d));
      // fen pools (shallow black water; the causeway road stays dry)
      if (fen > 0.01 && feat.pools) {
        const pm = noise.noise(x * 0.045 + 3.3, z * 0.045 - 1.7) * 0.7 + noise.noise(x * 0.11, z * 0.11) * 0.3;
        const k = sm(0.05, 0.3, pm) * sm(ROAD_HALF + 1.5, ROAD_HALF + 4.5, d) * fen * (1 - sm(32, 40, d) * 0.5);
        h = U.lerp(h, feat.fenBase - 0.75 + n4 * 0.1, k * poolKeep(x, z));
      }
      // the Thistledown stream (bridge deck keeps the road walkable; render height carves under it)
      if (feat.stream) {
        const st = feat.stream, pd = polyDist(st.xs, st.zs, x, z).d;
        if (pd < st.width + 4) {
          const bed = Math.min(h, base) - st.depth;
          const k = 1 - sm(st.width * 0.5, st.width + 3.5, pd);
          const carved = U.lerp(h, bed + n4 * 0.12, k);
          if (d < ROAD_HALF + 1.2) {
            const hump = Math.max(0, 1 - (pd / 7)) * 0.55;
            grid.R[idx] = carved - 0.02;
            return base + hump;
          }
          h = carved;
        }
      }
      if (ahead > 0) h += ahead * ahead * 0.004;
      return h;
    }
    if (actKey === 2) {
      const hs = def.hall * L;
      const floor = baseAt(hs);
      if (s < hs - 2 || (br >= 0 && s < hs)) {
        // the Greyspire pass: snow valley climbing between steep walls, mountains beyond
        const wallStart = Math.max(ROAD_HALF + 2, Math.min(corr - 3, 12));
        h = base + (n1 * 0.7 + n2 * 0.3) * (0.3 + sm(4, 20, d) * 2.2) + n4 * 0.12;
        h += Math.max(0, d - wallStart) * (corr < 20 ? 1.6 : 0.55) + Math.max(0, d - corr) * (corr < 20 ? 2.4 : 1.0);
        h += sm(corr, corr + 50, d) * (22 + n3 * 26) + Math.abs(n3) * sm(30, 80, d) * 30;
        if (d < ROAD_HALF + 1.4) h = U.lerp(base + n2 * 0.05, h, sm(ROAD_HALF - 0.5, ROAD_HALF + 1.4, d));
        if (ahead > 0) h += ahead * 2;
        return h;
      }
      // the halls: flagstone floor, near-vertical carved walls, water channels, vaulted ceiling (grid.C)
      h = floor + n4 * 0.02;
      const wallAt = corr - 1.5;
      if (d > wallAt) h = floor + Math.min(48, (d - wallAt) * 9);
      if (s > hs + 14 && s < L - 36 && dm > 14 && dm < 18.5 && !nearBranch(x, z, 4.5) && d < wallAt - 1) {
        const k = sm(14, 15, dm) * (1 - sm(17.5, 18.5, dm));
        h = floor - 1.3 * k;
      }
      if (ahead > 8) h = Math.max(h, floor + Math.min(48, (ahead - 8) * 9));
      const ceil = floor + 9 + 11 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.min(d, corr + 4) / (corr + 4), 2))) + (s > L - 36 ? 6 * sm(L - 36, L - 26, s) : 0);
      if (s >= hs - 0.5 || (br >= 0 && s >= hs)) grid.C[idx] = ceil + n2 * 0.4;
      return h;
    }
    if (actKey === 3) {
      const gate = sm(0.74 * L, 0.84 * L, s);
      h = base + (n1 * 0.7 + n2 * 0.3) * (0.4 + sm(4, 26, d) * 2.6) + n4 * 0.1;
      h += sm(10, 60, d) * (7 + n3 * 10) + Math.max(0, d - 32) * 0.6 + Math.abs(n2) * sm(26, 60, d) * 8;
      h += gate * sm(14, 40, d) * 14;
      if (d < ROAD_HALF + 1.4) h = U.lerp(base + n2 * 0.06, h, sm(ROAD_HALF - 0.5, ROAD_HALF + 1.4, d));
      for (const fi of feat.fissures) {
        const xs = fi.xs || (fi.xs = new Float32Array(fi.pts.map((p) => p.x))), zs = fi.zs || (fi.zs = new Float32Array(fi.pts.map((p) => p.z)));
        const pd = polyDist(xs, zs, x, z);
        if (pd.d < fi.width + 2.5) {
          const taper = Math.sin(Math.PI * U.clamp(pd.t, 0, 1));
          h = U.lerp(h, h - 2.2 * taper, 1 - sm(fi.width * 0.4 * taper, fi.width * taper + 2.0, pd.d));
        }
      }
      if (ahead > 7.5) h += (ahead - 7.5) * 6;   // the cliff of Mount Cindral behind the gate
      return h;
    }
    // forge: a causeway over the abyss inside the mountain
    h = d < corr ? 0 : d < corr + 2.5 ? -sm(corr, corr + 2.5, d) * 30 : -30 + Math.max(0, d - 26) * 4.5;
    if (ahead > 0.5) h = Math.min(h, -30);
    grid.C[idx] = 38 + n1 * 4 - Math.max(0, d - 30) * 1.2;
    return h;
  }
  function poolKeep(x, z) {   // keep POIs and the boss ring dry
    if (!level || !level.pois) return 1;
    let k = 1;
    for (const p of level.pois) { const r = (p.radius || 4) + 4, dd = Math.hypot(p.x - x, p.z - z); if (dd < r + 4) k = Math.min(k, sm(r, r + 4, dd)); }
    return k;
  }
  function nearBranch(x, z, r) {
    for (let k = mainN; k < samples.n; k++) { const dx = samples.x[k] - x, dz = samples.z[k] - z; if (dx * dx + dz * dz < r * r) return true; }
    return false;
  }
  function cellOf(x, z) {
    const g = grid;
    const i = U.clamp(Math.round((x - g.x0) / CELL), 0, g.nx - 1), j = U.clamp(Math.round((z - g.z0) / CELL), 0, g.nz - 1);
    return j * g.nx + i;
  }
  function sampleGrid(A, x, z) {
    const g = grid;
    let fx = (x - g.x0) / CELL, fz = (z - g.z0) / CELL;
    fx = U.clamp(fx, 0, g.nx - 1.001); fz = U.clamp(fz, 0, g.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = A[j * g.nx + i], b = A[j * g.nx + i + 1], c = A[(j + 1) * g.nx + i], d = A[(j + 1) * g.nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  function heightAt(x, z) { return grid ? sampleGrid(grid.H, x, z) : 0; }
  // ceiling height above (x,z) in the halls / forge cavern, or Infinity in the open
  function ceilingAt(x, z) {
    const g = grid;
    if (!g || !g.C) return Infinity;
    const v = g.C[cellOf(x, z)];
    if (v !== v) return Infinity;
    return sampleGridC(x, z, v);
  }
  function sampleGridC(x, z, fallback) {
    const g = grid;
    let fx = (x - g.x0) / CELL, fz = (z - g.z0) / CELL;
    fx = U.clamp(fx, 0, g.nx - 1.001); fz = U.clamp(fz, 0, g.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    let a = g.C[j * g.nx + i], b = g.C[j * g.nx + i + 1], c = g.C[(j + 1) * g.nx + i], d = g.C[(j + 1) * g.nx + i + 1];
    if (a !== a) a = fallback; if (b !== b) b = fallback; if (c !== c) c = fallback; if (d !== d) d = fallback;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  // nearest road/branch sample index for (x,z), refined along its polyline
  function nearestSample(x, z) {
    const k0 = grid.N[cellOf(x, z)];
    const br = samples.br[k0];
    let lo, hi;
    if (br < 0) { lo = 0; hi = mainN - 1; } else { const b = branches[br]; lo = b.start; hi = b.start + b.len; }
    let best = 1e18, bk = k0;
    for (let k = Math.max(lo, k0 - 6); k <= Math.min(hi, k0 + 6); k++) { const dx = samples.x[k] - x, dz = samples.z[k] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bk = k; } }
    return bk;
  }
  function roadInfo(x, z, out) {
    out = out || scratch;
    if (!samples || !grid) { out.s = 0; out.d = 0; out.branch = null; out.bs = 0; out.x = x; out.z = z; return out; }
    const k = nearestSample(x, z);
    out.x = samples.x[k]; out.z = samples.z[k];
    out.d = Math.hypot(x - out.x, z - out.z);
    out.s = samples.s[k];
    const br = samples.br[k];
    out.branch = br < 0 ? null : branches[br].id;
    out.bs = br < 0 ? 0 : samples.bs[k];
    return out;
  }
  function roadPoint(s, out) {
    out = out || new V3();
    if (!samples) return out.set(0, 0, 0);
    s = U.clamp(s, 0, mainN - 1);
    const i = Math.min(mainN - 2, Math.floor(s)), t = s - i;
    out.x = samples.x[i] + (samples.x[i + 1] - samples.x[i]) * t;
    out.z = samples.z[i] + (samples.z[i + 1] - samples.z[i]) * t;
    out.y = heightAt(out.x, out.z);
    return out;
  }
  function branchPoint(b, bs, out) {
    bs = U.clamp(bs, 0, b.len);
    const i = Math.min(b.len - 1, Math.floor(bs)), t = bs - i, k = b.start + i;
    out.x = samples.x[k] + (samples.x[k + 1] - samples.x[k]) * t;
    out.z = samples.z[k] + (samples.z[k + 1] - samples.z[k]) * t;
    out.y = heightAt(out.x, out.z);
    return out;
  }
  function roadYaw(s) {
    if (!samples) return 0;
    const i = U.clamp(Math.round(s), 1, mainN - 2);
    return Math.atan2(samples.x[i + 1] - samples.x[i - 1], samples.z[i + 1] - samples.z[i - 1]);
  }
  // Next waypoint toward a POI following the road and its branches. Returns a SHARED object {x, z, dist}.
  function guide(x, z, poiId) {
    const lv = level; const poi = lv && lv.pois.find((p) => p.id === poiId);
    const o = guideOut;
    if (!poi || !samples) { o.x = x; o.z = z; o.dist = 0; return o; }
    const ri = roadInfo(x, z, riTmp);
    const LOOK = 7;
    const direct = Math.hypot(poi.x - x, poi.z - z);
    if (direct < 12) { o.x = poi.x; o.z = poi.z; o.dist = direct; return o; }
    const p = tmpV;
    let dist;
    const brOf = (id) => { for (const b of branches) if (b.id === id) return b; return null; };
    if (ri.branch && ri.branch !== poi.branch) {
      const b = brOf(ri.branch);
      if (ri.bs > 3) branchPoint(b, ri.bs - LOOK, p); else roadPoint(b.s0 + (poi.s > b.s0 ? 4 : -4), p);
      dist = ri.bs + Math.abs(poi.s - b.s0) + (poi.bs || 0);
    } else if (poi.branch) {
      const b = brOf(poi.branch);
      if (ri.branch === poi.branch) {
        if (poi.bs - ri.bs > LOOK + 2) branchPoint(b, ri.bs + LOOK, p); else p.set(poi.x, 0, poi.z);
        dist = Math.abs(poi.bs - ri.bs) + 2;
      } else if (Math.abs(b.s0 - ri.s) > 5 || ri.d > 8) {
        if (ri.d > 8) roadPoint(ri.s + Math.sign(b.s0 - ri.s) * 3, p); else roadPoint(ri.s + U.clamp(b.s0 - ri.s, -LOOK, LOOK), p);
        dist = Math.abs(b.s0 - ri.s) + ri.d + poi.bs;
      } else { branchPoint(b, 6, p); dist = poi.bs + 6; }
    } else {
      const ds = poi.s - ri.s;
      if (ri.d > 10 && Math.abs(ds) > 12) roadPoint(ri.s + Math.sign(ds) * 3, p);
      else if (Math.abs(ds) > 10) roadPoint(ri.s + U.clamp(ds, -LOOK, LOOK), p);
      else p.set(poi.x, 0, poi.z);
      dist = Math.abs(ds) + Math.hypot(poi.x - x, poi.z - z) * (Math.abs(ds) > 10 ? 0 : 1);
    }
    o.x = p.x; o.z = p.z; o.dist = dist;
    return o;
  }

  // ----------------------------------------------------------------------------- colliders (spatial hash)
  const HC = 8;                          // hash cell (m)
  let hash = null;                       // { x0, z0, nx, nz, cells: Int32Array offsets, items: Int32Array }
  function buildHash() {
    const cs = level.colliders, g = grid;
    const x0 = g.x0, z0 = g.z0, nx = Math.ceil(((g.nx - 1) * CELL) / HC) + 1, nz = Math.ceil(((g.nz - 1) * CELL) / HC) + 1;
    const lists = new Array(nx * nz);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], r = c.r + 1.5;
      const i0 = U.clamp(Math.floor((c.x - r - x0) / HC), 0, nx - 1), i1 = U.clamp(Math.floor((c.x + r - x0) / HC), 0, nx - 1);
      const j0 = U.clamp(Math.floor((c.z - r - z0) / HC), 0, nz - 1), j1 = U.clamp(Math.floor((c.z + r - z0) / HC), 0, nz - 1);
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) { const k = j * nx + ii; (lists[k] || (lists[k] = [])).push(i); }
    }
    const cells = new Int32Array(nx * nz + 1);
    let tot = 0;
    for (let k = 0; k < nx * nz; k++) { cells[k] = tot; tot += lists[k] ? lists[k].length : 0; }
    cells[nx * nz] = tot;
    const items = new Int32Array(tot);
    for (let k = 0; k < nx * nz; k++) if (lists[k]) items.set(lists[k], cells[k]);
    hash = { x0, z0, nx, nz, cells, items };
  }
  // Keep a moving body inside the walkable corridor, behind the road's end caps and out of solid props. Mutates pos.
  function constrain(pos, radius = 0.4) {
    if (!grid || !samples) return pos;
    let k = nearestSample(pos.x, pos.z);
    let sx = samples.x[k], sz = samples.z[k];
    let dx = pos.x - sx, dz = pos.z - sz, d = Math.hypot(dx, dz);
    const maxD = samples.corr[k] - radius;
    if (d > maxD && d > 1e-6) { pos.x = sx + dx / d * maxD; pos.z = sz + dz / d * maxD; }
    // end caps (only when the nearest path sample IS the end: the body is past the start/end of the road or a branch)
    if (k === 0) capAt(pos, 0, mainYaw(1) + Math.PI, actKey === 'forge' ? 2 : 10, radius);
    else if (k === mainN - 1) capAt(pos, mainN - 1, mainYaw(mainN - 2), actKey === 'forge' ? 1.2 : actKey === 1 ? 10 : 7, radius);
    else if (samples.br[k] >= 0) { const b = branches[samples.br[k]], e = b.start + b.len; if (k === e) capAt(pos, e, Math.atan2(samples.x[e] - samples.x[e - 1], samples.z[e] - samples.z[e - 1]), 9, radius); }
    if (level && hash) {
      const cs = level.colliders;
      const ci = Math.floor((pos.x - hash.x0) / HC), cj = Math.floor((pos.z - hash.z0) / HC);
      if (ci >= 0 && cj >= 0 && ci < hash.nx && cj < hash.nz) {
        const c0 = hash.cells[cj * hash.nx + ci], c1 = hash.cells[cj * hash.nx + ci + 1];
        for (let q = c0; q < c1; q++) {
          const c = cs[hash.items[q]];
          const ex = pos.x - c.x, ez = pos.z - c.z, rr = c.r + radius;
          const dd = ex * ex + ez * ez;
          if (dd < rr * rr && dd > 1e-6) { const l = Math.sqrt(dd); pos.x = c.x + ex / l * rr; pos.z = c.z + ez / l * rr; }
        }
      }
    }
    return pos;
  }
  function capAt(pos, k, yaw, pad, radius) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const a = (pos.x - samples.x[k]) * fx + (pos.z - samples.z[k]) * fz;
    const lim = pad - radius;
    if (a > lim) { pos.x -= fx * (a - lim); pos.z -= fz * (a - lim); }
  }
  function surfaceAt(x, z) {
    if (!level || !grid) return 'dirt';
    const ri = roadInfo(x, z, riTmp);
    if (level.act === 'forge') return 'stone';
    const h = heightAt(x, z);
    if (feat && feat.waterY != null && h < feat.waterY - 0.05 && ri.s > 0.62 * def.length) return 'water';
    if (level.act === 2) {
      if (ri.s > def.hall * def.length - 2) return h < baseAt(def.hall * def.length) - 0.4 ? 'water' : 'stone';
      return ri.d < ROAD_HALF ? 'stone' : 'snow';
    }
    if (ri.d < ROAD_HALF) return level.act === 3 ? 'ash' : 'dirt';
    if (level.act === 1) {
      if (feat && feat.stream && Math.abs(ri.s - feat.stream.s) < 90 && polyDist(feat.stream.xs, feat.stream.zs, x, z).d < feat.stream.width * 0.6) return 'water';
      return ri.s > 0.66 * def.length ? 'dirt' : 'grass';
    }
    return 'ash';
  }

  // ----------------------------------------------------------------------------- POIs
  function makePois(act, rng) {
    const L = def.length;
    const pois = [];
    const count = {};
    const zoneAt = (s) => { const z = def.zones.find((q) => s >= q[1] * L && s < q[2] * L); return z ? z[0] : def.zones[0][0]; };
    const add = (type, x, z, yaw, s, extra) => {
      count[type] = (count[type] || 0) + 1;
      const p = Object.assign({ id: 'a' + act + '-' + type + '-' + count[type], type, x, y: 0, z, yaw, radius: RADIUS[type] || 0,
        order: s, s, branch: null, bs: 0, zone: zoneAt(s), side: 0, state: 'hidden', interactR: 0, content: null }, extra || {});
      pois.push(p);
      return p;
    };
    if (act === 'forge') {
      const p = roadPoint(L - 6, new V3());
      add('forge', p.x, p.z, Math.PI, L - 6);
      return pois;
    }
    for (const [f, type, lat] of (act === 2 ? MAIN_LAYOUT_2 : MAIN_LAYOUT)) {
      const s = U.clamp(Math.round(f * L + rng.float(-6, 6)), 10, L - 30);
      const yaw = roadYaw(s);
      let side = lat ? (rng.chance(0.5) ? 1 : -1) : 0;
      for (const b of branches) if (side && Math.abs(b.s0 - s) < 25 && b.side === side) side = -side;
      const x = samples.x[s] + Math.cos(yaw) * lat * side, z = samples.z[s] - Math.sin(yaw) * lat * side;
      const face = side ? U.yawTo(samples.x[s] - x, samples.z[s] - z) : yaw + Math.PI;
      add(type, x, z, face, s, { side });
    }
    for (const b of branches) {
      for (const [bs, type, lat] of b.items) {
        const k = b.start + Math.min(bs, b.len);
        const yaw = Math.atan2(samples.x[k] - samples.x[k - 1], samples.z[k] - samples.z[k - 1]);
        const x = samples.x[k] + Math.cos(yaw) * lat, z = samples.z[k] - Math.sin(yaw) * lat;
        add(type, x, z, yaw + Math.PI, b.s0, { branch: b.id, bs, order: b.s0 + 0.01 + bs / 1000 });
      }
    }
    const sb = L - 14;
    const yb = roadYaw(sb);
    add('boss', samples.x[sb], samples.z[sb], yb + Math.PI, sb, {});
    pois.sort((a, b) => a.order - b.order);
    return pois;
  }

  // =============================================================================== SHADERS & MATERIALS
  // Height-aware exponential fog for every material (patched once into three's shader chunks at init):
  // denser below the eye (valley mist, fen haze), thinner above it (peaks stand out), never under 30% of the base.
  let fogPatched = false;
  function patchFogChunks() {
    if (fogPatched) return;
    fogPatched = true;
    const SC = T.ShaderChunk;
    SC.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying float vFogY;\n#endif';
    SC.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogY = dot( viewMatrix[1].xyz, mvPosition.xyz - viewMatrix[3].xyz );\n#endif';
    SC.fog_pars_fragment = '#ifdef USE_FOG\n\tuniform vec3 fogColor;\n\tvarying float vFogDepth;\n\tvarying float vFogY;\n\t#ifdef FOG_EXP2\n\t\tuniform float fogDensity;\n\t#else\n\t\tuniform float fogNear;\n\t\tuniform float fogFar;\n\t#endif\n#endif';
    SC.fog_fragment = [
      '#ifdef USE_FOG',
      '\t#ifdef FOG_EXP2',
      '\t\tfloat fogH = vFogY - cameraPosition.y;',
      '\t\tfloat fogK = abs( fogH ) > 0.05 ? ( 1.0 - exp( -0.032 * fogH ) ) / ( 0.032 * fogH ) : 1.0;',
      '\t\tfogK = clamp( fogK, 0.3, 2.6 );',
      '\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * fogK );',
      '\t#else',
      '\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
      '\t#endif',
      '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
      '#endif'
    ].join('\n');
  }

  const shared = (o) => { o.userData.shared = true; return o; };
  // fog uniforms (cloned: the renderer refreshes them per material) + our own uniforms BY REFERENCE (UniformsUtils.merge
  // would clone textures into new GPU textures that a material dispose never frees)
  function fogU(extra) { const u = T.UniformsUtils.clone(T.UniformsLib.fog); for (const k in extra) u[k] = extra[k]; return u; }
  // view-space sun dir + colour, and the ambient lift for Lambert foliage (it gets no environment map) (frame)
  const sunU = { uSunDirV: { value: new V3(0, 0, -1) }, uSunCol: { value: new T.Color(1, 1, 1) }, uAmb: { value: new T.Color(0, 0, 0) } };
  const matCache = new Map();
  // Patch a MeshStandardMaterial with optional wind sway and top cover (snow / moss / ash on upward faces).
  //   wind: { amp (trunk sway per m^2 of local height), flutter (leaf flutter), ref (height normaliser) }
  //   cover: { color, lo, hi, rough }
  function patchStd(mat, o = {}) {
    const key = JSON.stringify(o);
    mat.customProgramCacheKey = () => 'ab:' + key;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uniforms.uWind;
      if (o.noFlip) {
        sh.uniforms.uAmb = sunU.uAmb;
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
          .replace('#include <common>', '#include <common>\nuniform vec3 uAmb;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uAmb;');
      }
      if (o.transl) { sh.uniforms.uSunDirV = sunU.uSunDirV; sh.uniforms.uSunCol = sunU.uSunCol; sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSunDirV; uniform vec3 uSunCol;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uSunCol * pow(max(dot(normalize(-vViewPosition), uSunDirV), 0.0), 4.0) * ' + o.transl.toFixed(2) + ';'); }
      if (o.cover) { sh.uniforms.uCover = { value: new T.Color(o.cover.color) }; sh.uniforms.uNoise = { value: AB.tex.noise() }; }
      let vh = '#include <common>\nuniform float uTime; uniform vec2 uWind;\n';
      if (o.cover) vh += 'varying vec3 vCovN; varying vec3 vCovP;\n';
      sh.vertexShader = sh.vertexShader.replace('#include <common>', vh);
      if (o.wind) {
        const w = o.wind;
        sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '{',
          '#ifdef USE_INSTANCING',
          '  vec3 ip = instanceMatrix[3].xyz;',
          '#else',
          '  vec3 ip = vec3(0.0);',
          '#endif',
          '  vec3 wp = (modelMatrix * vec4(ip, 1.0)).xyz;',
          '  float hg = max(position.y, 0.0) / ' + (w.ref || 1).toFixed(2) + ';',
          '  float ph = dot(wp.xz, vec2(0.13, 0.17));',
          '  float gust = 0.55 + 0.45 * sin(uTime * 0.37 + wp.x * 0.021 + wp.z * 0.017) * sin(uTime * 0.23 + wp.z * 0.011);',
          '  vec2 sway = uWind * gust * (0.65 + 0.35 * sin(uTime * 1.25 + ph)) * ' + (w.amp || 0).toFixed(4) + ' * hg * hg;',
          '  float fl = sin(uTime * 6.3 + dot(position, vec3(2.1, 1.7, 2.9)) + ph * 3.0) * ' + (w.flutter || 0).toFixed(4) + ' * hg * gust;',
          '  vec3 off = vec3(sway.x + fl * 0.6, fl * 0.7 - (sway.x * sway.x + sway.y * sway.y) * 0.15, sway.y + fl * 0.4);',
          '#ifdef USE_INSTANCING',
          '  vec3 c0 = instanceMatrix[0].xyz, c1 = instanceMatrix[1].xyz, c2 = instanceMatrix[2].xyz;',
          '  transformed += vec3(dot(off, c0) / dot(c0, c0), dot(off, c1) / dot(c1, c1), dot(off, c2) / dot(c2, c2));',
          '#else',
          '  transformed += off;',
          '#endif',
          '}'
        ].join('\n'));
      }
      if (o.cover) {
        sh.vertexShader = sh.vertexShader.replace('#include <defaultnormal_vertex>', [
          '#include <defaultnormal_vertex>',
          '{ vec3 cn = objectNormal; vec4 cp = vec4(position, 1.0);',
          '#ifdef USE_INSTANCING',
          '  cn = mat3(instanceMatrix) * cn; cp = instanceMatrix * cp;',
          '#endif',
          '  vCovN = normalize(mat3(modelMatrix) * cn); vCovP = (modelMatrix * cp).xyz; }'
        ].join('\n'));
        const c = o.cover;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uCover; uniform sampler2D uNoise; varying vec3 vCovN; varying vec3 vCovP;\n')
          .replace('#include <map_fragment>', [
            '#include <map_fragment>',
            'float covN = texture2D(uNoise, vCovP.xz * 0.11 + vCovP.y * 0.05).g;',
            'float cov = smoothstep(' + c.lo.toFixed(3) + ', ' + c.hi.toFixed(3) + ', vCovN.y + (covN - 0.5) * 0.45);',
            'diffuseColor.rgb = mix(diffuseColor.rgb, uCover * (0.85 + covN * 0.3), cov);'
          ].join('\n'))
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, ' + (c.rough != null ? c.rough : 0.8).toFixed(2) + ', cov);');
      }
    };
    return mat;
  }
  // depth material for shadow casting of alpha-tested, wind-swayed foliage
  function depthFor(mat, o) {
    const key = 'depth:' + mat.uuid;
    if (matCache.has(key)) return matCache.get(key);
    const d = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: mat.map || null, alphaTest: mat.alphaTest || 0, side: T.DoubleSide });
    if (o && o.wind) patchStd(d, { wind: o.wind });
    matCache.set(key, shared(d));
    return d;
  }
  // cached materials shared by all levels (vegetation, rocks, props)
  function M(key, make) { if (!matCache.has(key)) matCache.set(key, shared(make())); return matCache.get(key); }

  // ------------------------------------------------------------------------------- terrain splat material
  // Layers per act: L0..L2 ground (blended by the per-vertex zone weights), L3 road, L4 rock (slope, biplanar).
  // The low tier (TLOW) drops normal maps, tiling breakers and the biplanar rock projection (6 texture reads).
  const LAYERS = {
    1: { names: ['grass', 'forest', 'mud', 'road', 'rock'], scale: [0.30, 0.28, 0.26, 0.33, 0.12], tint: [0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xe8e4dc], rock: [0.22, 0.42] },
    2: { names: ['snow', 'gravel', 'cobble', 'gravel', 'rock'], scale: [0.16, 0.3, 0.3, 0.36, 0.1], tint: [0xffffff, 0xd8dce4, 0xffffff, 0xc8ccd4, 0xb8bcc6], rock: [0.32, 0.52] },
    3: { names: ['ash', 'scorched', 'basalt', 'gravel', 'rock'], scale: [0.26, 0.2, 0.18, 0.34, 0.11], tint: [0xffffff, 0xffffff, 0xffffff, 0x6e625c, 0x6a5c56], rock: [0.24, 0.44] },
    forge: { names: ['basalt', 'ash', 'scorched', 'cobble', 'basalt'], scale: [0.2, 0.25, 0.2, 0.3, 0.1], tint: [0xffffff, 0xffffff, 0xffffff, 0x9a8a80, 0x8a7a76], rock: [0.2, 0.4] }
  };
  function terrainMaterial(act, low) {
    const cfg = LAYERS[act];
    const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    if (low) mat.defines = { TLOW: '' };
    const tA = cfg.names.map((n) => AB.tex.splat(n).map), tN = cfg.names.map((n) => AB.tex.splat(n).normal);
    const tints = cfg.tint.map((c) => new T.Color(c));
    mat.customProgramCacheKey = () => 'terrain:' + act + (low ? ':low' : '');
    mat.userData.heat = { value: act === 3 || act === 'forge' ? 1 : 0 };
    const gmask = gridTex ? gridTex.mask : null, ggrid = gridTex ? gridTex.uGrid.clone() : new T.Vector4(0, 0, 1, 1);
    mat.onBeforeCompile = (sh) => {
      for (let i = 0; i < 5; i++) { sh.uniforms['tA' + i] = { value: tA[i] }; sh.uniforms['tN' + i] = { value: tN[i] }; sh.uniforms['uTint' + i] = { value: tints[i] }; }
      sh.uniforms.uSc0 = { value: new T.Vector4(cfg.scale[0], cfg.scale[1], cfg.scale[2], cfg.scale[3]) };
      sh.uniforms.uSc1 = { value: new T.Vector4(cfg.scale[4], cfg.rock[0], cfg.rock[1], ROAD_HALF) };
      sh.uniforms.uNoise = { value: AB.tex.noise() };
      sh.uniforms.uTime = uniforms.uTime;
      sh.uniforms.uHeat = mat.userData.heat;
      sh.uniforms.uCrown = { value: act === 1 ? 1 : 0 };
      sh.uniforms.tGMask = { value: gmask }; sh.uniforms.uGGrid = { value: ggrid };
      sh.uniforms.uGrassK = { value: act === 1 && gmask ? 0.6 : 0 }; sh.uniforms.uGRoot = { value: new T.Color(0x4a5a26) }; sh.uniforms.uGDry = { value: new T.Color(0x6a5a30) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRoad; attribute vec3 aZone; attribute vec3 aMisc;\nvarying float vRoad; varying vec3 vZone; varying vec3 vMisc; varying vec3 vTW; varying vec3 vTN;\n')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vZone = aZone; vMisc = aMisc; vTW = (modelMatrix * vec4(transformed, 1.0)).xyz; vTN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform sampler2D tA0, tA1, tA2, tA3, tA4, tN0, tN1, tN2, tN3, tN4, uNoise;',
          'uniform vec3 uTint0, uTint1, uTint2, uTint3, uTint4;',
          'uniform vec4 uSc0, uSc1; uniform float uTime, uHeat, uCrown, uGrassK; uniform sampler2D tGMask; uniform vec4 uGGrid; uniform vec3 uGRoot, uGDry;',
          'varying float vRoad; varying vec3 vZone; varying vec3 vMisc; varying vec3 vTW; varying vec3 vTN;',
          'vec3 tNorm(vec4 t){ return t.xyz * 2.0 - 1.0; }',
          ''
        ].join('\n'))
        .replace('#include <map_fragment>', [
          'vec2 uvG = vec2(vTW.x, -vTW.z);',
          'vec3 Nw = normalize(vTN);',
          'vec4 mc = texture2D(uNoise, uvG * 0.0071);',
          '#ifdef TLOW',
          'vec4 mc2 = mc;',
          'vec4 a0 = texture2D(tA0, uvG * uSc0.x);',
          'vec4 n0 = vec4(0.5, 0.5, 1.0, 0.5), n1 = n0, n2 = n0, n3 = n0, n4 = n0;',
          'vec4 a4 = texture2D(tA4, uvG * uSc1.x);',
          '#else',
          'vec4 mc2 = texture2D(uNoise, uvG * 0.031 + 0.37);',
          'vec2 uvR = mat2(0.8, -0.6, 0.6, 0.8) * uvG;',
          'vec4 a0 = mix(texture2D(tA0, uvG * uSc0.x), texture2D(tA0, uvR * uSc0.x * 0.37), 0.35);',
          'vec4 n0 = texture2D(tN0, uvG * uSc0.x), n1 = texture2D(tN1, uvG * uSc0.y), n2 = texture2D(tN2, uvG * uSc0.z), n3 = texture2D(tN3, uvG * uSc0.w);',
          'vec3 an = abs(Nw);',
          'vec2 uvS = an.x > an.z ? vec2(vTW.z, vTW.y) : vec2(vTW.x, vTW.y);',
          'vec4 a4t = texture2D(tA4, uvG * uSc1.x), a4s = texture2D(tA4, uvS * uSc1.x);',
          'vec4 n4t = texture2D(tN4, uvG * uSc1.x), n4s = texture2D(tN4, uvS * uSc1.x);',
          'float sideK = smoothstep(0.45, 0.8, 1.0 - an.y);',
          'vec4 a4 = mix(a4t, a4s, sideK), n4 = mix(n4t, n4s, sideK);',
          '#endif',
          'vec4 a1 = texture2D(tA1, uvG * uSc0.y), a2 = texture2D(tA2, uvG * uSc0.z), a3 = texture2D(tA3, uvG * uSc0.w);',
          // weights: zone ground with height blending, road by distance, rock by slope
          'vec3 zw = max(vZone, 0.0) + 0.0001;',
          'zw *= vec3(0.6 + n0.a, 0.6 + n1.a, 0.6 + n2.a);',
          'zw = pow(zw, vec3(4.0)); zw /= (zw.x + zw.y + zw.z);',
          'float edgeN = (mc2.g - 0.5) * 1.7 + (n3.a - 0.5) * 0.7;',
          'float wRoad = 1.0 - smoothstep(uSc1.w - 0.9, uSc1.w + 0.5, vRoad + edgeN);',
          'float slope = 1.0 - Nw.y;',
          'float wRock = smoothstep(uSc1.y, uSc1.z, slope + (mc.r - 0.5) * 0.18 + (n4.a - 0.5) * 0.1);',
          'wRock = max(wRock, vMisc.y);',
          'vec4 ground = a0 * zw.x * vec4(uTint0, 1.0) + a1 * zw.y * vec4(uTint1, 1.0) + a2 * zw.z * vec4(uTint2, 1.0);',
          'vec3 gN = tNorm(n0) * zw.x + tNorm(n1) * zw.y + tNorm(n2) * zw.z;',
          'float gH = n0.a * zw.x + n1.a * zw.y + n2.a * zw.z;',
          // cart ruts either side of the centre line and (Low Roads) a grassy crown between them
          'float rut = exp(-pow((vRoad - 1.05) * 3.0, 2.0)) * (0.7 + mc2.b * 0.6);',
          'vec4 roadC = a3 * vec4(uTint3, 1.0);',
          'roadC.rgb *= 1.0 - rut * 0.24;',
          'roadC = mix(roadC, ground, clamp(exp(-pow(vRoad * 2.6, 2.0)) * uCrown * (0.55 + mc2.r * 0.6), 0.0, 1.0));',
          'vec4 col = mix(ground, roadC, wRoad);',
          'vec3 tn = mix(gN, tNorm(n3), wRoad);',
          'float hh = mix(gH, n3.a, wRoad);',
          'col = mix(col, a4 * vec4(uTint4, 1.0), wRock);',
          'if (uGrassK > 0.0) { vec4 gmk = texture2D(tGMask, (vTW.xz - uGGrid.xy) / uGGrid.zw); col.rgb = mix(col.rgb, mix(uGRoot, uGDry, gmk.g * 0.7), gmk.r * uGrassK * (1.0 - wRoad) * (1.0 - wRock)); }',
          'tn = mix(tn, tNorm(n4), wRock);',
          'hh = mix(hh, n4.a, wRock);',
          '#ifdef TLOW',
          'hh = 0.35 + (col.r + col.g) * 0.4;',
          '#endif',
          // macro variation, cavity, wetness
          'col.rgb *= 0.82 + mc.r * 0.3 + (mc.a - 0.5) * 0.12;',
          'col.rgb *= mix(0.72, 1.06, smoothstep(0.0, 0.7, hh));',
          'float wet = clamp(vMisc.x, 0.0, 1.0);',
          'col.rgb *= mix(1.0, 0.55, wet);',
          'diffuseColor.rgb *= col.rgb;',
          'float tRough = mix(col.a, 0.18, wet * 0.85) - rut * wRoad * 0.15;'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * tRough;')
        .replace('#include <normal_fragment_maps>', [
          '#ifndef TLOW',
          '{',
          '  vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);',
          '  vec3 Bw = cross(Nw, Tw);',
          '  vec3 nn = normalize(vec3(tn.xy * 1.15, max(tn.z, 0.2)));',
          '  vec3 nW = normalize(Tw * nn.x + Bw * nn.y + Nw * nn.z);',
          '  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);',
          '}',
          '#endif'
        ].join('\n'))
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          'if (uHeat > 0.0) {',
          '#ifdef TLOW',
          '  float crack = smoothstep(0.5, 0.72, texture2D(uNoise, uvG * 0.11).b);',
          '#else',
          '  float crack = 1.0 - smoothstep(0.08, 0.32, hh);',
          '#endif',
          '  float pulse = 0.75 + 0.25 * sin(uTime * 1.7 + vTW.x * 0.3 + vTW.z * 0.21);',
          '  float heat = clamp(vMisc.z, 0.0, 1.0) * (1.0 - wRoad);',
          '  totalEmissiveRadiance += vec3(4.0, 1.1, 0.25) * crack * heat * pulse * uHeat;',
          '}'
        ].join('\n'));
    };
    return mat;
  }

  // ------------------------------------------------------------------------------- water (fen pools, stream, hall channels)
  function waterMaterial(o) {
    const u = fogU({
      uTime: uniforms.uTime, tNormal: { value: AB.tex.waterNormal() }, tDepth: { value: o.depthTex || null }, uUseDepth: { value: o.depthTex ? 1 : 0 },
      uGrid: { value: new T.Vector4(0, 0, 1, 1) }, uDeep: { value: new T.Color(o.deep || 0x05080a) }, uShallow: { value: new T.Color(o.shallow || 0x1a1c14) },
      uSkyC: { value: new T.Color(o.sky || 0x8090a0) }, uHorizon: { value: new T.Color(o.horizon || 0xb0a090) }, uSunDir: { value: new V3(0, 1, 0) },
      uSunColor: { value: new T.Color(0xffffff) }, uFlow: { value: new T.Vector2(o.flow ? o.flow[0] : 0, o.flow ? o.flow[1] : 0) }, uRough: { value: o.rough || 0.35 },
      uAlpha: { value: o.alpha != null ? o.alpha : 0.92 }, uGlow: { value: new T.Color(o.glow || 0x000000) }
    });
    u.uTime = uniforms.uTime;
    const m = new T.ShaderMaterial({
      uniforms: u, fog: true, transparent: true, depthWrite: false,
      vertexShader: [
        '#include <common>', '#include <fog_pars_vertex>',
        'varying vec3 vW; varying vec2 vUv2;',
        'void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv2 = uv; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;',
        '#include <fog_vertex>',
        '}'
      ].join('\n'),
      fragmentShader: [
        '#include <common>', '#include <fog_pars_fragment>',
        'uniform float uTime, uUseDepth, uRough, uAlpha; uniform sampler2D tNormal, tDepth; uniform vec4 uGrid;',
        'uniform vec3 uDeep, uShallow, uSkyC, uHorizon, uSunDir, uSunColor, uGlow; uniform vec2 uFlow;',
        'varying vec3 vW; varying vec2 vUv2;',
        'void main(){',
        '  vec2 p = vW.xz;',
        '  vec2 fl = uFlow * uTime;',
        '  vec3 a = texture2D(tNormal, p * 0.09 + fl * 0.09 + vec2(uTime * 0.011, uTime * 0.004)).xyz * 2.0 - 1.0;',
        '  vec3 b = texture2D(tNormal, p * 0.23 + fl * 0.21 - vec2(uTime * 0.007, -uTime * 0.013)).xyz * 2.0 - 1.0;',
        '  vec3 c = texture2D(tNormal, p * 0.61 + fl * 0.5 + vec2(uTime * 0.02, 0.0)).xyz * 2.0 - 1.0;',
        '  vec2 nxy = (a.xy + b.xy * 0.7 + c.xy * 0.35) * uRough;',
        '  vec3 N = normalize(vec3(nxy.x, 1.0, -nxy.y));',
        '  vec3 V = normalize(cameraPosition - vW);',
        '  float ndv = max(dot(N, V), 0.0);',
        '  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);',
        '  vec3 R = reflect(-V, N);',
        '  vec3 sky = mix(uHorizon, uSkyC, smoothstep(-0.05, 0.55, R.y));',
        '  float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 380.0) * 2.2 + pow(max(dot(R, normalize(uSunDir)), 0.0), 30.0) * 0.035;',
        '  float depth = 1.0;',
        '  if (uUseDepth > 0.5) { vec2 g = (vW.xz - uGrid.xy) / uGrid.zw; depth = texture2D(tDepth, g).r; }',
        '  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 0.8, depth));',
        '  vec3 col = mix(body, sky * 0.55, fres) + min(uSunColor * spec, vec3(3.0)) + uGlow;',
        '  float alpha = mix(0.0, uAlpha, smoothstep(0.0, 0.18, depth));',
        '  alpha = max(alpha, fres * smoothstep(0.0, 0.06, depth));',
        '  gl_FragColor = vec4(col, alpha);',
        '#include <fog_fragment>',
        '}'
      ].join('\n')
    });
    return m;
  }

  // ------------------------------------------------------------------------------- lava (fissures, forge lake, Cindral streams)
  function lavaMaterial(o = {}) {
    const u = fogU({ uTime: { value: 0 }, tLava: { value: AB.tex.emissive('lava') }, tNoise: { value: AB.tex.noise() }, uGain: { value: o.gain || 3.2 }, uScale: { value: o.scale || 0.12 }, uFlow: { value: new T.Vector2(o.flow ? o.flow[0] : 0.02, o.flow ? o.flow[1] : 0.01) } });
    u.uTime = uniforms.uTime;
    return new T.ShaderMaterial({
      uniforms: u, fog: true,
      vertexShader: [
        '#include <common>', '#include <fog_pars_vertex>', 'varying vec3 vW; varying vec2 vUv2;',
        'void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv2 = uv; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;',
        '#include <fog_vertex>', '}'
      ].join('\n'),
      fragmentShader: [
        '#include <common>', '#include <fog_pars_fragment>',
        'uniform float uTime, uGain, uScale; uniform vec2 uFlow; uniform sampler2D tLava, tNoise; varying vec3 vW; varying vec2 vUv2;',
        'void main(){',
        '  vec2 p = vW.xz * uScale;',
        '  vec4 nz = texture2D(tNoise, p * 0.35 + uTime * 0.004);',
        '  vec2 w = (nz.rg - 0.5) * 0.25;',
        '  vec3 e1 = texture2D(tLava, p + w + uFlow * uTime).rgb;',
        '  vec3 e2 = texture2D(tLava, p * 1.7 - w + uFlow * uTime * 1.6 + 0.31).rgb;',
        '  float glow = 0.55 + 0.45 * sin(uTime * 0.9 + nz.b * 6.2831);',
        '  vec3 hot = vec3(1.0, 0.36, 0.06) * (0.35 + 0.65 * glow);',
        '  vec3 col = hot * 0.55 + (e1 * 0.7 + e2 * 0.5) * 1.4;',
        '  col += vec3(1.0, 0.75, 0.35) * pow(max(e1.r, e2.r), 4.0) * 1.5;',
        '  gl_FragColor = vec4(col * uGain, 1.0);',
        '#include <fog_fragment>',
        '}'
      ].join('\n')
    });
  }

  // ------------------------------------------------------------------------------- sky
  function skyMaterial() {
    return new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uZenith: { value: new T.Color() }, uHorizon: { value: new T.Color() }, uGround: { value: new T.Color() },
        uSunDir: { value: new V3(0, 0.2, 1).normalize() }, uSunColor: { value: new T.Color() }, uSunSize: { value: 0.9995 },
        uGlow: { value: new T.Vector3(0.5, 0.2, 2.0) }, uCloud: { value: new T.Vector4(0.45, 0.04, 0.9, 0.002) },
        uCloudLit: { value: new T.Color() }, uCloudDark: { value: new T.Color() }, uStars: { value: 0 }, uCurve: { value: 0.55 },
        uUnder: { value: new T.Color(0x000000) }, uUnderDir: { value: new V3(0, 0, 1) }, uTime: uniforms.uTime, tNoise: { value: AB.tex.noise() },
        uFogCol: { value: new T.Color(0x808080) }, uHaze: { value: 0 }
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
      fragmentShader: [
        'uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor, uCloudLit, uCloudDark, uUnder, uUnderDir, uGlow;',
        'uniform float uSunSize, uStars, uCurve, uTime, uHaze; uniform vec4 uCloud; uniform sampler2D tNoise; uniform vec3 uFogCol;',
        'varying vec3 vDir;',
        'float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }',
        'void main(){',
        '  vec3 d = normalize(vDir);',
        '  vec3 sd = normalize(uSunDir);',
        '  float y = d.y;',
        '  vec3 col = y > 0.0 ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), uCurve)) : mix(uHorizon, uGround, pow(clamp(-y * 4.0, 0.0, 1.0), 0.6));',
        '  float s = max(dot(d, sd), 0.0);',
        '  float hz = 1.0 - abs(y);',
        '  col += uSunColor * (pow(s, 5.0) * uGlow.x * (0.4 + hz * 0.6) + pow(s, 40.0) * uGlow.y);',
        '  col += uSunColor * smoothstep(uSunSize, uSunSize + 0.0003, s) * uGlow.z;',
        '  vec3 ud = normalize(uUnderDir);',
        '  float u = max(dot(d, ud), 0.0);',
        // the glow from below (volcano, forge) rises through billowing smoke, never a flat wash of colour
        '  vec3 up = normalize(cross(ud, vec3(0.0, 1.0, 0.0)));',
        '  vec2 suv = vec2(atan(dot(d, up), dot(d, ud)) * 0.55, y * 1.3 - uTime * 0.004);',
        '  float sn = texture2D(tNoise, suv).r * 0.6 + texture2D(tNoise, suv * 2.4 + vec2(0.37, uTime * -0.003)).g * 0.4;',
        '  float smoke = smoothstep(0.28, 0.8, sn);',
        '  col += uUnder * pow(u, 3.0) * smoothstep(0.35, -0.02, y) * (0.3 + 1.0 * smoke);',
        '  float cl = 0.0;',
        '  if (y > -0.02) {',
        '    vec2 cuv = d.xz / (max(y, 0.0) + 0.09) * uCloud.y + vec2(uTime * uCloud.w, uTime * uCloud.w * 0.4);',
        '    float n = texture2D(tNoise, cuv).r * 0.55 + texture2D(tNoise, cuv * 2.7 + 0.13).g * 0.3 + texture2D(tNoise, cuv * 6.3 + 0.71).a * 0.15;',
        '    cl = smoothstep(1.0 - uCloud.x, 1.0 - uCloud.x + 0.32, n) * smoothstep(-0.02, 0.12, y);',
        '    float lit = clamp(pow(s, 2.5) * 0.9 + (0.62 - n) * 0.9 + 0.25, 0.0, 1.4);',
        '    vec3 cc = mix(uCloudDark, uCloudLit, lit);',
        '    cc += uUnder * pow(u, 2.0) * 0.6;',
        '    col = mix(col, cc, cl * uCloud.z);',
        '  }',
        '  if (uStars > 0.0 && y > 0.0) {',
        '    vec3 q = d * 420.0; vec3 c = floor(q); float h = h31(c);',
        '    float st = step(0.9965, h) * smoothstep(0.55, 0.0, length(fract(q) - 0.5));',
        '    st *= 0.6 + 0.4 * sin(uTime * (1.0 + h * 4.0) + h * 40.0);',
        '    col += vec3(0.9, 0.95, 1.0) * st * uStars * smoothstep(0.02, 0.3, y) * (1.0 - cl);',
        '  }',
        '  col = mix(col, uFogCol, uHaze * (1.0 - smoothstep(0.0, 0.5, y)));',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
  }

  // =============================================================================== GEOMETRY KIT
  const BGU = AB.addons.BufferGeometryUtils;
  const geoCache = new Map();
  function G(key, make) { if (!geoCache.has(key)) { const g = make(); markShared(g); geoCache.set(key, g); } return geoCache.get(key); }
  function markShared(o) { if (!o) return; if (o.isBufferGeometry) { o.userData.shared = true; return; } for (const k in o) if (o[k] && o[k].isBufferGeometry) o[k].userData.shared = true; }
  // simple mesh builder: positions / normals / uvs / indices (+ optional colours)
  class GB {
    constructor(withColor) { this.p = []; this.n = []; this.u = []; this.i = []; this.c = withColor ? [] : null; }
    get count() { return this.p.length / 3; }
    v(x, y, z, nx, ny, nz, u, w, r = 1, g = 1, b = 1) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, w); if (this.c) this.c.push(r, g, b); return this.count - 1; }
    tri(a, b, c) { this.i.push(a, b, c); }
    quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    geo() {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(this.u, 2));
      if (this.c) g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
      g.setIndex(this.i);
      return g;
    }
  }
  const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _q = new T.Quaternion(), _m4 = new T.Matrix4(), _s3 = new V3(), _eu = new T.Euler();
  // tube along a polyline: radii per point, `seg` sides; u wraps around (circumference / texScale), v along length / texScale
  function tube(b, pts, radii, seg, texScale = 1.2, cap = false) {
    const n = pts.length;
    let ref = new V3(1, 0, 0);
    let len = 0;
    const base = b.count;
    for (let i = 0; i < n; i++) {
      const tg = _a.copy(pts[Math.min(n - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
      if (Math.abs(tg.dot(ref)) > 0.95) ref = Math.abs(tg.y) < 0.9 ? new V3(0, 1, 0) : new V3(0, 0, 1);
      const N = _b.copy(ref).addScaledVector(tg, -ref.dot(tg)).normalize();
      ref = N.clone();
      const B = _c.crossVectors(tg, N);
      if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
      const r = radii[i], circ = TAU * Math.max(r, 0.05);
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const dx = N.x * ca + B.x * sa, dy = N.y * ca + B.y * sa, dz = N.z * ca + B.z * sa;
        b.v(pts[i].x + dx * r, pts[i].y + dy * r, pts[i].z + dz * r, dx, dy, dz, (k / seg) * circ / texScale, len / texScale);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * (seg + 1) + k, c = a + seg + 1;
      b.quad(a, c, c + 1, a + 1);
    }
    if (cap) {
      const e = pts[n - 1], tg = _a.copy(pts[n - 1]).sub(pts[n - 2]).normalize();
      const ci = b.v(e.x, e.y, e.z, tg.x, tg.y, tg.z, 0.5, 0.5);
      const r0 = base + (n - 1) * (seg + 1);
      for (let k = 0; k < seg; k++) b.tri(r0 + k, r0 + k + 1, ci);
    }
  }
  // quad card: centre c, half-vectors r (right) and u (up), uv 0..1, vertex normals pointing away from `from` blended with `up`
  function cardQuad(b, c, r, u, from, upBlend = 0.35, uv = null) {
    const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    const ids = [];
    for (const [sx, sy, uu, vv] of corners) {
      const x = c.x + r.x * sx + u.x * sy, y = c.y + r.y * sx + u.y * sy, z = c.z + r.z * sx + u.z * sy;
      _d.set(x - from.x, (y - from.y) * 0.8, z - from.z).normalize();
      _d.y += upBlend; _d.normalize();
      ids.push(b.v(x, y, z, _d.x, _d.y, _d.z, uv ? uv[0] + uu * uv[2] : uu, uv ? uv[1] + vv * uv[3] : vv));
    }
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  function curvePts(p0, dir, len, n, bendUp, rng, jitter = 0.15) {
    const pts = [p0.clone()];
    const d = dir.clone().normalize();
    const step = len / n;
    const p = p0.clone();
    for (let i = 1; i <= n; i++) {
      d.y += bendUp / n; d.x += rng.float(-jitter, jitter); d.z += rng.float(-jitter, jitter); d.normalize();
      p.addScaledVector(d, step); pts.push(p.clone());
    }
    return pts;
  }

  // ------------------------------------------------------------------------------- trees
  // broadleaf: flared trunk, 4-6 limbs with sub-branches, layered canopy of leaf-cluster cards. lod: far scenery version.
  function broadleafGeo(v, lod) {
    return G('broad' + v + (lod ? 'L' : ''), () => {
      const rng = AB.rng('broad:' + v);
      const bark = new GB(), leaf = new GB();
      const H = rng.float(3.2, 4.6);
      const trunk = curvePts(new V3(0, -0.4, 0), new V3(rng.float(-0.1, 0.1), 1, rng.float(-0.1, 0.1)), H + 0.4, lod ? 3 : 4, 0, rng, 0.07);
      const tn = trunk.length - 1;
      tube(bark, trunk, trunk.map((p, i) => U.lerp(0.42, 0.24, i / tn) + (i === 0 ? 0.18 : 0)), lod ? 5 : 6, 1.4);
      const top = trunk[tn];
      const clusters = [];
      const nl = rng.int(4, 5);
      for (let l = 0; l < nl; l++) {
        const a = (l / nl) * TAU + rng.float(-0.4, 0.4), y0 = U.lerp(0.62, 1, rng.next());
        const start = trunk[Math.round(y0 * tn)].clone();
        const dir = new V3(Math.cos(a), rng.float(0.7, 1.4), Math.sin(a));
        const len = rng.float(2.4, 4.0);
        const limb = curvePts(start, dir, len, 2, 0.35, rng, 0.2);
        tube(bark, limb, limb.map((p, i) => U.lerp(0.17, 0.05, i / (limb.length - 1))), lod ? 3 : 4, 1.0);
        const end = limb[limb.length - 1];
        clusters.push([end.clone().add(new V3(0, 0.5, 0)), rng.float(1.6, 2.3)]);
        for (let sb = 0; sb < 2; sb++) {
          const sp = limb[1];
          const sd = new V3(Math.cos(a + rng.float(-1, 1)), rng.float(0.4, 1.1), Math.sin(a + rng.float(-1, 1)));
          const sbr = curvePts(sp, sd, rng.float(1.2, 2.0), 2, 0.25, rng, 0.25);
          if (!lod && sb === 0) tube(bark, sbr, [0.07, 0.045, 0.02], 3, 0.8);
          clusters.push([sbr[2].clone().add(new V3(0, 0.3, 0)), rng.float(1.1, 1.6)]);
        }
      }
      clusters.push([top.clone().add(new V3(0, 1.6, 0)), 2.4]);
      clusters.push([top.clone().add(new V3(rng.float(-0.8, 0.8), 3.0, rng.float(-0.8, 0.8))), 1.9]);
      const cc = new V3(); clusters.forEach(([p]) => cc.add(p)); cc.divideScalar(clusters.length);
      for (const [p, r] of clusters) {
        const nc = lod ? Math.round(1 + r * 1.1) : Math.round(2 + r * 2.4);
        for (let k = 0; k < nc; k++) {
          const c = p.clone().add(new V3(rng.float(-1, 1), rng.float(-0.6, 0.8), rng.float(-1, 1)).multiplyScalar(r * 0.55));
          const sz = rng.float(1.2, 1.7) * (0.75 + r * 0.2) * (lod ? 1.35 : 1);
          _eu.set(rng.float(-0.9, 0.9), rng.float(0, TAU), rng.float(-0.5, 0.5));
          _q.setFromEuler(_eu);
          const rr = new V3(sz, 0, 0).applyQuaternion(_q), uu = new V3(0, sz, 0).applyQuaternion(_q);
          cardQuad(leaf, c, rr, uu, cc, 0.45);
        }
      }
      return { trunk: bark.geo(), leaves: leaf.geo(), height: top.y + 4 };
    });
  }
  // conifer: straight tapering trunk + whorls of drooping branch cards
  function pineGeo(v, lod) {
    return G('pine' + v + (lod ? 'L' : ''), () => {
      const rng = AB.rng('pine:' + v);
      const bark = new GB(), nd = new GB();
      const H = rng.float(9, 14);
      const trunk = [];
      const ts = lod ? 2 : 4;
      for (let i = 0; i <= ts; i++) trunk.push(new V3(rng.float(-0.05, 0.05), -0.4 + (H + 0.4) * i / ts, rng.float(-0.05, 0.05)));
      tube(bark, trunk, trunk.map((p, i) => U.lerp(0.3, 0.03, i / ts) + (i === 0 ? 0.08 : 0)), lod ? 4 : 6, 1.2);
      const cc = new V3(0, H * 0.55, 0);
      let y = H * rng.float(0.18, 0.26);
      while (y < H - 0.4) {
        const t = y / H;
        const L = U.lerp(3.0, 0.5, Math.pow(t, 0.9)) * rng.float(0.85, 1.1) * (lod ? 1.15 : 1);
        const n = lod ? 3 : Math.max(3, Math.round(U.lerp(6, 4, t)));
        const off = rng.float(0, TAU);
        for (let k = 0; k < n; k++) {
          const a = off + (k / n) * TAU + rng.float(-0.25, 0.25);
          const droop = rng.float(0.15, 0.45) + t * 0.1;
          const dir = new V3(Math.cos(a) * Math.cos(droop), -Math.sin(droop), Math.sin(a) * Math.cos(droop));
          const across = new V3(-Math.sin(a), rng.float(-0.25, 0.25), Math.cos(a)).normalize();
          const c = new V3(0, y, 0).addScaledVector(dir, L * 0.5);
          cardQuad(nd, c, dir.clone().multiplyScalar(L * 0.5), across.multiplyScalar(L * (lod ? 0.36 : 0.28)), cc, 0.9);
        }
        y += U.lerp(0.8, 0.45, t) * rng.float(0.85, 1.15) * (lod ? 1.7 : 1);
      }
      const tip = new V3(0, H - 0.2, 0);
      for (let k = 0; k < (lod ? 1 : 2); k++) { const a = k * 1.6; cardQuad(nd, tip.clone().add(new V3(0, 0.4, 0)), new V3(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14), new V3(0, 0.6, 0), cc, 0.5, [0, 0.35, 1, 0.3]); }
      return { trunk: bark.geo(), leaves: nd.geo(), height: H };
    });
  }
  // dead tree: crooked trunk, bare limbs (2 levels); fen variant with hanging moss cards
  function deadGeo(v, moss, lod) {
    return G('dead' + v + (moss ? 'm' : '') + (lod ? 'L' : ''), () => {
      const rng = AB.rng('dead:' + v);
      const bark = new GB(), ms = new GB();
      const H = rng.float(4, 7);
      const trunk = curvePts(new V3(0, -0.4, 0), new V3(rng.float(-0.2, 0.2), 1, rng.float(-0.2, 0.2)), H, lod ? 3 : 5, 0, rng, 0.12);
      tube(bark, trunk, trunk.map((p, i) => U.lerp(0.34, 0.06, i / (trunk.length - 1)) + (i === 0 ? 0.12 : 0)), lod ? 4 : 6, 1.2, true);
      const nl = rng.int(3, 5);
      for (let l = 0; l < nl; l++) {
        const a = rng.float(0, TAU), st = trunk[rng.int(Math.floor(trunk.length / 2), trunk.length - 1)];
        const limb = curvePts(st, new V3(Math.cos(a), rng.float(0.2, 0.9), Math.sin(a)), rng.float(1.6, 3.2), 3, rng.float(-0.2, 0.5), rng, 0.3);
        tube(bark, limb, [0.12, 0.08, 0.05, 0.015], lod ? 3 : 4, 0.8);
        for (let k = 0; k < 2; k++) {
          const sp = limb[rng.int(1, 3)];
          const sb = curvePts(sp, new V3(Math.cos(a + rng.float(-1.2, 1.2)), rng.float(0, 1), Math.sin(a + rng.float(-1.2, 1.2))), rng.float(0.6, 1.4), 2, 0.2, rng, 0.35);
          if (!lod) tube(bark, sb, [0.045, 0.025, 0.008], 3, 0.6);
          if (moss && rng.chance(0.6)) { const m = sb[1]; cardQuad(ms, m.clone().add(new V3(0, -0.7, 0)), new V3(rng.float(0.25, 0.4), 0, rng.float(-0.2, 0.2)), new V3(0, 0.75, 0), m, 0.0); }
        }
        if (moss) { const m = limb[2]; cardQuad(ms, m.clone().add(new V3(0, -0.9, 0)), new V3(0.4, 0, 0.15), new V3(0, 0.95, 0), m, 0.0); }
      }
      return { trunk: bark.geo(), leaves: moss ? ms.geo() : null, height: H };
    });
  }
  function bushGeo(v) {
    return G('bush' + v, () => {
      const rng = AB.rng('bush:' + v);
      const b = new GB();
      const c0 = new V3(0, 0.55, 0);
      const n = rng.int(11, 15);
      for (let k = 0; k < n; k++) {
        const c = new V3(rng.float(-0.7, 0.7), rng.float(0.25, 1.0), rng.float(-0.7, 0.7));
        const sz = rng.float(0.55, 0.85);
        _eu.set(rng.float(-0.8, 0.8), rng.float(0, TAU), rng.float(-0.4, 0.4)); _q.setFromEuler(_eu);
        cardQuad(b, c, new V3(sz, 0, 0).applyQuaternion(_q), new V3(0, sz, 0).applyQuaternion(_q), c0, 0.5);
      }
      return b.geo();
    });
  }
  function fernGeo() {
    return G('fern', () => {
      const rng = AB.rng('fern');
      const b = new GB();
      const n = 7;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + rng.float(-0.2, 0.2), L = rng.float(0.8, 1.25), W = 0.32 * L;
        const dir = new V3(Math.cos(a), 0, Math.sin(a)), side = new V3(-Math.sin(a), 0, Math.cos(a));
        let prev = null;
        for (let s = 0; s <= 2; s++) {
          const t = s / 2;
          const p = dir.clone().multiplyScalar(L * t);
          p.y = Math.sin(t * 1.9) * L * 0.55 - t * t * 0.15;
          const nUp = new V3(0, 1, 0).addScaledVector(dir, 0.25).normalize();
          const i0 = b.v(p.x - side.x * W, p.y, p.z - side.z * W, nUp.x, nUp.y, nUp.z, 0, t);
          const i1 = b.v(p.x + side.x * W, p.y, p.z + side.z * W, nUp.x, nUp.y, nUp.z, 1, t);
          if (prev) b.quad(prev[0], prev[1], i1, i0);
          prev = [i0, i1];
        }
      }
      return b.geo();
    });
  }
  // reed clump: thin tall blades (vertex coloured root->tip) + a few seed heads
  function reedGeo() {
    return G('reeds', () => {
      const rng = AB.rng('reeds');
      const b = new GB(true);
      for (let k = 0; k < 16; k++) {
        const a = rng.float(0, TAU), r = rng.float(0, 0.35), h = rng.float(1.2, 2.2), w = rng.float(0.025, 0.045);
        const bx = Math.cos(a) * r, bz = Math.sin(a) * r, lean = rng.float(0.05, 0.3), la = rng.float(0, TAU);
        const sx = -Math.sin(la), sz = Math.cos(la);
        let prev = null;
        for (let s = 0; s <= 3; s++) {
          const t = s / 3, ww = w * (1 - t * 0.85);
          const x = bx + Math.cos(la) * lean * t * t * h, z = bz + Math.sin(la) * lean * t * t * h, y = t * h;
          const g1 = U.lerp(0.07, 0.5, t), g2 = U.lerp(0.1, 0.42, t), g3 = U.lerp(0.02, 0.12, t);
          const i0 = b.v(x - sx * ww, y, z - sz * ww, 0, 1, 0, 0, t, g1, g2, g3), i1 = b.v(x + sx * ww, y, z + sz * ww, 0, 1, 0, 1, t, g1, g2, g3);
          if (prev) b.quad(prev[0], prev[1], i1, i0);
          prev = [i0, i1];
        }
        if (k < 4) {
          const x = bx + Math.cos(la) * lean * h, z = bz + Math.sin(la) * lean * h;
          const pts = [new V3(x, h * 0.86, z), new V3(x, h * 1.0, z)];
          const s0 = b.count;
          tube(b, pts, [0.035, 0.03], 5, 1);
          for (let q = s0; q < b.count; q++) { b.c[q * 3] = 0.22; b.c[q * 3 + 1] = 0.13; b.c[q * 3 + 2] = 0.07; }
        }
      }
      return b.geo();
    });
  }
  // displaced rock: icosphere + 3D noise, bottom flattened, box-projected UVs
  function rockGeo(v, kind, small) {
    return G('rock' + kind + v + (small ? 'S' : ''), () => {
      const rng = AB.rng('rock:' + kind + v);
      const nz = new AB.addons.SimplexNoise({ random: () => rng.next() });
      let g = new T.IcosahedronGeometry(1, small || kind === 'chunk' ? 1 : 2);
      g.deleteAttribute('normal'); g.deleteAttribute('uv');
      g = BGU.mergeVertices(g);
      const p = g.attributes.position;
      const sc = kind === 'slab' ? [1.5, 0.5, 1.1] : kind === 'spire' ? [0.55, 1.9, 0.6] : kind === 'chunk' ? [1.2, 0.85, 1.0] : [1, 0.78, 1];
      for (let i = 0; i < p.count; i++) {
        _a.fromBufferAttribute(p, i);
        const k = 1 + 0.26 * nz.noise3d(_a.x * 1.1, _a.y * 1.1, _a.z * 1.1) + 0.11 * nz.noise3d(_a.x * 2.9, _a.y * 2.9, _a.z * 2.9) + (kind === 'chunk' ? 0.1 : 0.04) * nz.noise3d(_a.x * 6, _a.y * 6, _a.z * 6);
        _a.multiplyScalar(k);
        _a.x *= sc[0]; _a.y *= sc[1]; _a.z *= sc[2];
        if (kind === 'chunk') { _a.x = Math.round(_a.x * 3) / 3 * 0.35 + _a.x * 0.65; _a.z = Math.round(_a.z * 3) / 3 * 0.35 + _a.z * 0.65; }
        const fl = -0.35 * sc[1];
        if (_a.y < fl) _a.y = fl + (_a.y - fl) * 0.25;
        p.setXYZ(i, _a.x, _a.y, _a.z);
      }
      g.computeVertexNormals();
      const nrm = g.attributes.normal, uv = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) {
        const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nzz = Math.abs(nrm.getZ(i));
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        if (ny > nx && ny > nzz) { uv[i * 2] = x * 0.5; uv[i * 2 + 1] = z * 0.5; } else if (nx > nzz) { uv[i * 2] = z * 0.5; uv[i * 2 + 1] = y * 0.5; } else { uv[i * 2] = x * 0.5; uv[i * 2 + 1] = y * 0.5; }
      }
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      return g;
    });
  }
  function logGeo() {
    return G('log', () => {
      const rng = AB.rng('log');
      const b = new GB();
      const pts = []; for (let i = 0; i <= 5; i++) pts.push(new V3(-3 + i * 1.2, Math.sin(i * 0.7) * 0.06, rng.float(-0.08, 0.08)));
      tube(b, pts, pts.map((p, i) => U.lerp(0.42, 0.3, i / 5)), 8, 1.3, true);
      const br = curvePts(pts[3], new V3(0.3, 0.9, 0.4), 1.4, 2, 0.1, rng, 0.2);
      tube(b, br, [0.12, 0.07, 0.02], 4, 0.8);
      return b.geo();
    });
  }
  function stumpGeo() {
    return G('stump', () => {
      const b = new GB();
      tube(b, [new V3(0, -0.3, 0), new V3(0, 0.3, 0), new V3(0.02, 0.62, 0)], [0.55, 0.42, 0.38], 9, 1.2, true);
      return b.geo();
    });
  }

  // ------------------------------------------------------------------------------- box / prism helpers with world-scaled UVs
  function boxGeo(w, h, d, ts = 2) {
    const g = new T.BoxGeometry(w, h, d);
    const uv = g.attributes.uv;
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / ts, uv.getY(i) * dims[f][1] / ts); }
    return g;
  }
  function cylGeo(r0, r1, h, seg, ts = 2, open = false) {
    const g = new T.CylinderGeometry(r1, r0, h, seg, 1, open);
    const uv = g.attributes.uv, circ = TAU * Math.max(r0, r1);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / ts, uv.getY(i) * h / ts);
    return g;
  }
  // gabled roof (thatch/slate): ridge along Z, width w (X), length l (Z), rise h, overhang o, thickness t
  function roofGeo(w, l, h, o, t = 0.3, ts = 2) {
    const b = new GB();
    const hw = w / 2 + o, hl = l / 2 + o;
    const slope = Math.atan2(h, w / 2);
    for (const sgn of [-1, 1]) {
      const nx = Math.sin(slope) * sgn, ny = Math.cos(slope);
      const xe = sgn * hw, ye = -o * Math.tan(slope);
      const sl = Math.hypot(hw, h - ye);
      const a = b.v(xe, ye, -hl, nx, ny, 0, 0, 0), c = b.v(xe, ye, hl, nx, ny, 0, l / ts, 0);
      const d = b.v(0, h, hl, nx, ny, 0, l / ts, sl / ts), e = b.v(0, h, -hl, nx, ny, 0, 0, sl / ts);
      if (sgn > 0) b.quad(a, e, d, c); else b.quad(a, c, d, e);
      // underside
      const a2 = b.v(xe, ye - t, -hl, -nx, -ny, 0, 0, 0), c2 = b.v(xe, ye - t, hl, -nx, -ny, 0, l / ts, 0);
      const d2 = b.v(0, h - t, hl, -nx, -ny, 0, l / ts, sl / ts), e2 = b.v(0, h - t, -hl, -nx, -ny, 0, 0, sl / ts);
      if (sgn > 0) b.quad(a2, c2, d2, e2); else b.quad(a2, e2, d2, c2);
      // eave edge
      const f0 = b.v(xe, ye, -hl, sgn, 0, 0, 0, 0), f1 = b.v(xe, ye, hl, sgn, 0, 0, l / ts, 0), f2 = b.v(xe, ye - t, hl, sgn, 0, 0, l / ts, t / ts), f3 = b.v(xe, ye - t, -hl, sgn, 0, 0, 0, t / ts);
      if (sgn > 0) b.quad(f0, f3, f2, f1); else b.quad(f0, f1, f2, f3);
    }
    return b.geo();
  }
  function gableGeo(w, h, ts = 2) {   // triangle wall filling a gable end, facing +Z
    const b = new GB();
    const a = b.v(-w / 2, 0, 0, 0, 0, 1, 0, 0), c = b.v(w / 2, 0, 0, 0, 0, 1, w / ts, 0), d = b.v(0, h, 0, 0, 0, 1, w / 2 / ts, h / ts);
    b.tri(a, c, d);
    const a2 = b.v(-w / 2, 0, 0, 0, 0, -1, 0, 0), c2 = b.v(w / 2, 0, 0, 0, 0, -1, w / ts, 0), d2 = b.v(0, h, 0, 0, 0, -1, w / 2 / ts, h / ts);
    b.tri(a2, d2, c2);
    return b.geo();
  }
  // a wall slab with an arched opening (gates, bridges): width w, height h, depth d, opening ow x oh (+ semicircle)
  function archWallGeo(w, h, d, ow, oh, ts = 3, topCurve = 0) {
    const s = new T.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h);
    if (topCurve) s.quadraticCurveTo(0, h + topCurve * 2, -w / 2, h); else s.lineTo(-w / 2, h);
    s.lineTo(-w / 2, 0);
    if (ow > 0) {
      const hole = new T.Path();
      const r = ow / 2;
      hole.moveTo(-r, 0); hole.lineTo(-r, oh); hole.absarc(0, oh, r, Math.PI, 0, true); hole.lineTo(r, 0); hole.lineTo(-r, 0);
      s.holes.push(hole);
    }
    const g = new T.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 14 });
    g.translate(0, 0, -d / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / ts, uv.getY(i) / ts);
    return g;
  }

  // ------------------------------------------------------------------------------- static batcher (merged per material+chunk)
  let statics = null;                    // Map key -> { mat, list, cast, receive }
  const CHUNK_S = 100;
  function addStatic(geo, mat, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, opts = {}) {
    _eu.set(opts.rx || 0, ry, opts.rz || 0); _q.setFromEuler(_eu);
    _m4.compose(_a.set(x, y, z), _q, _s3.set(sx, sy, sz));
    addStaticM(geo, mat, _m4, opts, x, z);
  }
  function addStaticM(geo, mat, m4, opts = {}, cx, cz) {
    if (!statics) return;
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(m4);
    if (cx == null) { cx = m4.elements[12]; cz = m4.elements[14]; }
    const ch = opts.chunk != null ? 0 : 0;
    const key = mat.uuid + '#' + ch + (opts.cast === false ? 'n' : '');
    if (!statics.has(key)) statics.set(key, { mat, list: [], cast: opts.cast !== false, receive: opts.receive !== false });
    statics.get(key).list.push(g);
  }
  // static part placed in a POI's local frame (lx right, lz toward the approach), like a child of a group rotated by poi.yaw
  const _mp = new T.Matrix4(), _ml = new T.Matrix4(), _qp = new T.Quaternion();
  function addLocal(poi, geo, mat, lx, ly, lz, ry = 0, s = null, rx = 0, rz = 0, opts = {}) {
    _qp.setFromAxisAngle(_b.set(0, 1, 0), poi.yaw);
    _mp.compose(_a.set(poi.x, poi.y, poi.z), _qp, _s3.set(1, 1, 1));
    _eu.set(rx, ry, rz); _q.setFromEuler(_eu);
    _ml.compose(_c.set(lx, ly, lz), _q, _s3.set(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1));
    _mp.multiply(_ml);
    addStaticM(geo, mat, _mp, opts);
  }
  function chunkOfXZ(x, z) { if (!samples || !grid) return 0; return Math.floor(roadInfo(x, z, riTmp).s / CHUNK_S); }
  function flushStatics(group) {
    if (!statics) return;
    for (const [, e] of statics) {
      if (!e.list.length) continue;
      const merged = BGU.mergeGeometries(e.list, false);
      for (const g of e.list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const m = new T.Mesh(merged, e.mat);
      m.castShadow = e.cast && AB.quality.settings.shadows; m.receiveShadow = e.receive;
      m.userData.cull = { r: merged.boundingSphere.radius, c: merged.boundingSphere.center.clone() };
      group.add(m);
      cullList.push(m);
    }
    statics = null;
  }

  // ------------------------------------------------------------------------------- chunked instancing
  const cullList = [];                   // meshes hidden beyond draw distance (frame)
  // Shadow proxies (integrator, perf): shadow-casting vegetation is drawn into the sun's shadow map by a separate
  // InstancedMesh per chunk that lives ONLY on SHADOW_LAYER (the sun's shadow camera sees it, the main camera does not),
  // uses the cheaper far-scenery geometry and holds only the instances within SHADOW_R of the focus (refilled as the
  // focus moves). Before, every instance of every chunk touching the 96 m shadow box was drawn at full detail.
  const SHADOW_LAYER = 7, SHADOW_R = 60;
  const shadowProxies = [];
  // items: [{x, y, z, ry, s (uniform) | sx/sy/sz, rx, rz, color}] ; returns the meshes
  // opts: cast, receive, depth (custom depth material), far (cull distance), colors, oneChunk,
  //       lodGeo (drawn instead of geo for chunks away from the camera's stretch of road; shares the instance buffer),
  //       shadowGeo (geometry of the shadow proxy; with cast, the main mesh itself casts no shadow)
  function instance(group, geo, mat, items, opts = {}) {
    const out = [];
    if (!items.length) return out;
    const byChunk = new Map();
    // instances bucket into 200 m chunks of road (half the draw calls of 100 m chunks; per-instance LOD and the shadow
    // proxies keep the triangle count in check, and draw submission is the main CPU cost)
    const cmul = 2;
    for (const it of items) { const c = opts.oneChunk ? 0 : Math.floor(chunkOfXZ(it.x, it.z) / cmul); if (!byChunk.has(c)) byChunk.set(c, []); byChunk.get(c).push(it); }
    const proxyGeo = opts.cast && opts.shadowGeo ? opts.shadowGeo : null;
    for (const [ck, list] of byChunk) {
      const im = new T.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        _eu.set(it.rx || 0, it.ry || 0, it.rz || 0); _q.setFromEuler(_eu);
        const s = it.s || 1;
        _m4.compose(_a.set(it.x, it.y, it.z), _q, _s3.set(it.sx || s, it.sy || s, it.sz || s));
        im.setMatrixAt(i, _m4);
        if (opts.colors && it.color) im.setColorAt(i, it.color);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = !!opts.cast && !proxyGeo; im.receiveShadow = opts.receive !== false;
      if (opts.depth) im.customDepthMaterial = opts.depth;
      im.userData.cull = { r: im.boundingSphere.radius, c: im.boundingSphere.center.clone(), far: opts.far || 0, cast: im.castShadow, chunk: opts.oneChunk ? -1 : ck, cs: CHUNK_S * cmul, lo: null };
      if (opts.lodGeo && opts.lodGeo !== geo && !opts.oneChunk && !opts.colors) {
        // per-instance LOD: in a chunk near the camera, the instances within the LOD radius go to `im` (full detail)
        // and the rest to `lo` (far-scenery geometry); chunks away from the camera draw everything with `lo`
        const lo = new T.InstancedMesh(opts.lodGeo, mat, list.length);
        lo.instanceMatrix.array.set(im.instanceMatrix.array);
        lo.instanceMatrix.setUsage(T.DynamicDrawUsage); im.instanceMatrix.setUsage(T.DynamicDrawUsage);
        lo.boundingSphere = im.boundingSphere.clone();
        lo.castShadow = false; lo.receiveShadow = im.receiveShadow; lo.visible = false;
        if (opts.depth) lo.customDepthMaterial = opts.depth;
        group.add(lo);
        const px = new Float32Array(list.length), pz = new Float32Array(list.length);
        list.forEach((it, i) => { px[i] = it.x; pz[i] = it.z; });
        im.userData.cull.lo = lo;
        im.userData.cull.lod = { all: new Float32Array(im.instanceMatrix.array), px, pz, mode: '' };
      }
      group.add(im);
      cullList.push(im);
      out.push(im);
      if (proxyGeo) {
        const sp = new T.InstancedMesh(proxyGeo, mat, list.length);
        const px = new Float32Array(list.length), pz = new Float32Array(list.length);
        list.forEach((it, i) => { px[i] = it.x; pz[i] = it.z; });
        sp.userData.shadow = { all: new Float32Array(im.instanceMatrix.array), px, pz };
        sp.instanceMatrix.setUsage(T.DynamicDrawUsage);
        sp.layers.set(SHADOW_LAYER);
        sp.castShadow = true; sp.receiveShadow = false; sp.count = 0; sp.visible = false;
        if (opts.depth) sp.customDepthMaterial = opts.depth;
        group.add(sp);
        shadowProxies.push(sp);
      }
    }
    return out;
  }
  // split a chunk's instances between its full-detail mesh (within r of (x, z)) and its LOD mesh; near = false puts
  // every instance in the LOD mesh. Allocation-free; uploads only the used ranges.
  function splitLod(m, near, x, z, r) {
    const c = m.userData.cull, L = c.lod, lo = c.lo, all = L.all, px = L.px, pz = L.pz, n = px.length;
    const ha = m.instanceMatrix.array, la = lo.instanceMatrix.array, r2 = r * r;
    let nh = 0, nl = 0;
    for (let i = 0; i < n; i++) {
      const dx = px[i] - x, dz = pz[i] - z, src = i * 16;
      if (near && dx * dx + dz * dz < r2) { const o = nh * 16; for (let j = 0; j < 16; j++) ha[o + j] = all[src + j]; nh++; }
      else { const o = nl * 16; for (let j = 0; j < 16; j++) la[o + j] = all[src + j]; nl++; }
    }
    m.count = nh; lo.count = nl;
    if (nh) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, nh * 16); m.instanceMatrix.needsUpdate = true; }
    if (nl) { lo.instanceMatrix.clearUpdateRanges(); lo.instanceMatrix.addUpdateRange(0, nl * 16); lo.instanceMatrix.needsUpdate = true; }
  }
  // refill every shadow proxy with the instances within r of (fx, fz); allocation-free
  function updateShadowProxies(fx, fz, r) {
    const r2 = r * r;
    for (let k = 0; k < shadowProxies.length; k++) {
      const sp = shadowProxies[k], S = sp.userData.shadow, a = sp.instanceMatrix.array, all = S.all, px = S.px, pz = S.pz;
      let n = 0;
      for (let i = 0; i < px.length; i++) {
        const dx = px[i] - fx, dz = pz[i] - fz;
        if (dx * dx + dz * dz >= r2) continue;
        const o = n * 16, src = i * 16;
        for (let j = 0; j < 16; j++) a[o + j] = all[src + j];
        n++;
      }
      if (n === sp.count && n === 0) continue;
      sp.count = n; sp.visible = n > 0;
      if (n) { sp.instanceMatrix.clearUpdateRanges(); sp.instanceMatrix.addUpdateRange(0, n * 16); sp.instanceMatrix.needsUpdate = true; sp.boundingSphere = null; }
    }
  }

  // =============================================================================== MATERIALS (shared across levels)
  const WIND_TREE = { amp: 0.0011, flutter: 0.03, ref: 1 };
  const WIND_BUSH = { amp: 0.012, flutter: 0.03, ref: 1 };
  const A2C = () => !!(AB.quality && AB.quality.settings && AB.quality.settings.msaa > 0);
  const MAT = {
    bark: (act) => M('bark' + act, () => { const s = AB.tex.get('bark'); return patchStd(new T.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, color: act === 3 ? 0x3a302a : act === 2 ? 0x8a8078 : 0xb4a898 }), { wind: WIND_TREE }); }),
    dead: (act) => M('deadbark' + act, () => { const s = AB.tex.get('bark'); return patchStd(new T.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, color: act === 3 ? 0x2a2420 : 0x8a8478 }), { wind: { amp: 0.0006, ref: 1 }, cover: act === 3 ? { color: 0x141110, lo: 0.2, hi: 0.7, rough: 0.95 } : null }); }),
    leaves: (tint) => M('leaves' + tint, () => patchStd(new T.MeshLambertMaterial({ map: AB.tex.card('leaves'), alphaTest: 0.42, alphaToCoverage: A2C(), side: T.DoubleSide, color: tint }), { wind: WIND_TREE, transl: 0.55, noFlip: true })),
    pine: (snow) => M('pine' + snow, () => patchStd(new T.MeshLambertMaterial({ map: AB.tex.card('pine'), alphaTest: 0.4, alphaToCoverage: A2C(), side: T.DoubleSide, color: snow ? 0x9aa8a0 : 0xc8d0c0 }), { wind: WIND_TREE, cover: snow ? { color: 0xe4ecf4, lo: 0.55, hi: 0.85, rough: 0.6 } : null, transl: 0.4, noFlip: true })),
    moss: () => M('mosscard', () => patchStd(new T.MeshLambertMaterial({ map: AB.tex.card('moss'), alphaTest: 0.3, alphaToCoverage: A2C(), side: T.DoubleSide, color: 0xb8b89a }), { wind: { amp: 0.004, flutter: 0.05, ref: 1 }, noFlip: true })),
    bush: (tint) => M('bush' + tint, () => patchStd(new T.MeshLambertMaterial({ map: AB.tex.card('leaves'), alphaTest: 0.42, alphaToCoverage: A2C(), side: T.DoubleSide, color: tint }), { wind: WIND_BUSH, transl: 0.45, noFlip: true })),
    fern: () => M('fern', () => patchStd(new T.MeshLambertMaterial({ map: AB.tex.card('fern'), alphaTest: 0.4, alphaToCoverage: A2C(), side: T.DoubleSide, color: 0xb8c8a0 }), { wind: { amp: 0.05, flutter: 0.02, ref: 1 }, transl: 0.45, noFlip: true })),
    reeds: () => M('reeds', () => patchStd(new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }), { wind: { amp: 0.03, flutter: 0.01, ref: 1 }, transl: 0.7, noFlip: true })),
    rock: (act) => M('rock' + act, () => {
      const s = AB.tex.get('rock');
      const tint = act === 1 ? 0xb4ae9e : act === 2 ? 0xa8aeb8 : act === 3 ? 0x5e504a : 0x4a403c;
      const cover = act === 1 ? { color: 0x3c4a1e, lo: 0.5, hi: 0.85, rough: 0.95 } : act === 2 ? { color: 0xe6edf5, lo: 0.42, hi: 0.72, rough: 0.6 } : act === 3 ? { color: 0x2a2624, lo: 0.55, hi: 0.9, rough: 0.95 } : null;
      return patchStd(new T.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, color: tint }), { cover });
    }),
    log: () => M('log', () => { const s = AB.tex.get('bark'); return patchStd(new T.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, color: 0x9a9080 }), { cover: { color: 0x3a4a1c, lo: 0.4, hi: 0.8, rough: 0.95 } }); }),
    tex: (name, color = 0xffffff, rough = 1, extra) => { color = quant(name, color); if (name === 'cloth') extra = Object.assign({ side: T.DoubleSide }, extra || {}); return M('t:' + name + ':' + color + ':' + rough + (extra ? JSON.stringify(extra) : ''), () => {
      const s = AB.tex.get(name);
      const m = new T.MeshStandardMaterial(Object.assign({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, metalnessMap: s.metal ? s.roughnessMap : null, metalness: s.metal ? 1 : 0, color, roughness: rough }, extra || {}));
      return m;
    }); },
    glow: (color, i = 4) => M('glow' + color + ':' + i, () => new T.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: i, roughness: 1 })),
    plain: (color, rough = 0.9, metal = 0) => M('plain' + color + ':' + rough + ':' + metal, () => new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal }))
  };

  // a small palette per texture keeps the number of distinct (batched) materials, and so draw calls, low
  const PALETTE = {
    wood: [0xb0a090, 0x6a5a48, 0x3a2c24], cloth: [0xd8ccb0, 0x8a7a5a, 0x9a4a32], stone: [0xc8c0b0, 0xa8aab0, 0x6a6460, 0x5a4a44],
    metal: [0x6a6460, 0x3a3230], plaster: [0xc8bea8, 0xb4a890], bark: [0x9a8a78], rock: [0x9a968a], carving: [0xb8b0a4], basalt: [0x8a8080], cobble: [0xc0b8a8, 0xb0b0b4]
  };
  function quant(name, c) {
    const p = PALETTE[name]; if (!p) return c;
    let best = p[0], bd = 1e9;
    for (const q of p) { const dr = ((q >> 16) & 255) - ((c >> 16) & 255), dg = ((q >> 8) & 255) - ((c >> 8) & 255), db = (q & 255) - (c & 255), d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; best = q; } }
    return best;
  }
  // =============================================================================== TERRAIN MESH
  function zoneW(s) {   // weights of the act's zones at arc length s (smooth 24 m blends)
    const L = def.length, zs = def.zones, w = [];
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i][1] * L, b = zs[i][2] * L;
      w.push(sm(a - 12, a + 12, s) * (1 - sm(b - 12, b + 12, s)) + (i === 0 && s < a ? 1 : 0));
    }
    const t = w.reduce((x, y) => x + y, 0) || 1;
    return w.map((x) => x / t);
  }
  let waterDepth = null;                  // Uint8 grid texture data: water depth (m, 0..2.55 / 2.55)
  function buildTerrainMesh(act) {
    const g = grid;
    const n = g.nx * g.nz;
    const pos = new Float32Array(n * 3), road = new Float32Array(n), zone = new Float32Array(n * 3), misc = new Float32Array(n * 3);
    const L = def.length, noise = g.noise;
    const hs = def.hall ? def.hall * L : 1e9;
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
      const idx = j * g.nx + i, x = g.x0 + i * CELL, z = g.z0 + j * CELL;
      const h = g.R[idx];
      pos[idx * 3] = x; pos[idx * 3 + 1] = h; pos[idx * 3 + 2] = z;
      const d = g.D[idx], k = g.N[idx], s = samples.s[k];
      road[idx] = d;
      const nn = noise.noise(x * 0.05 + 11, z * 0.05) * 0.5 + 0.5, nb = noise.noise(x * 0.013 - 4, z * 0.013 + 9) * 0.5 + 0.5;
      let z0 = 1, z1 = 0, z2 = 0, wet = 0, rk = 0, heat = 0, ao = 1;
      if (act === 1) {
        const zw = zoneW(s);
        z0 = zw[0] + zw[1] * 0.25 * nn; z1 = zw[1] * (0.75 + 0.25 * (1 - nn)) + zw[0] * sm(0.7, 0.9, nb) * 0.5; z2 = zw[2];
        if (feat.waterY != null) wet = Math.max(wet, sm(feat.waterY + 0.35, feat.waterY - 0.05, h)) * zw[2];
        if (feat.stream) { const pd = polyDist(feat.stream.xs, feat.stream.zs, x, z).d; if (pd < 5) { wet = Math.max(wet, 1 - sm(1.5, 4.5, pd)); z2 = Math.max(z2, 1 - sm(2, 5, pd)); } }
        if (zw[2] > 0.5 && nb > 0.6) z0 += 0.35;
        if (s >= 0.66 * L && s <= L - 34 && d < ROAD_HALF + 2.5) { wet = Math.max(wet, 0.95); z0 = 0; z1 = 0; z2 = 1; road[idx] = 99; }
      } else if (act === 2) {
        const inHall = s >= hs - 1 && !(samples.br[k] >= 0 && s < hs);
        if (inHall) { z0 = 0; z1 = 0.15 * nn; z2 = 1; road[idx] = 99; if (d > samples.corr[k] - 2.2) rk = 1; if (h < baseAt(hs) - 0.2) wet = 0.9; }
        else { z0 = 1; z1 = sm(0.55, 0.85, nn) * 0.8 + sm(ROAD_HALF + 2, ROAD_HALF + 0.5, d) * 0.6; z2 = 0; }
      } else if (act === 3) {
        const zw = zoneW(s);
        z0 = 0.6 + zw[0] * 0.4 + zw[2] * 0.3; z1 = sm(0.45, 0.75, nb) * 0.9 + zw[1] * 0.3 + zw[2] * 0.4; z2 = zw[2] * 0.35 * sm(0.4, 0.7, nn) + sm(0.8, 0.95, nn) * 0.3;
        for (const fi of feat.fissures) { const pd = polyDist(fi.xs, fi.zs, x, z); if (pd.d < fi.width + 6) heat = Math.max(heat, (1 - sm(fi.width * 0.5, fi.width + 6, pd.d)) * Math.sin(Math.PI * U.clamp(pd.t, 0, 1))); }
        heat = Math.max(heat, sm(0.8, 0.95, nn) * sm(14, 30, d) * 0.6);
      } else {
        z0 = 1; z1 = 0.3 * nn; z2 = 0;
        if (d > 22) { rk = 1; heat = sm(0.55, 0.85, nn) * 0.9; }
      }
      zone[idx * 3] = z0; zone[idx * 3 + 1] = z1; zone[idx * 3 + 2] = z2;
      misc[idx * 3] = wet; misc[idx * 3 + 1] = rk; misc[idx * 3 + 2] = heat;
    }
    // normals from the full grid (central differences) so tiles join without seams
    const nor = new Float32Array(n * 3);
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
      const hx = g.R[j * g.nx + Math.min(g.nx - 1, i + 1)] - g.R[j * g.nx + Math.max(0, i - 1)];
      const hz = g.R[Math.min(g.nz - 1, j + 1) * g.nx + i] - g.R[Math.max(0, j - 1) * g.nx + i];
      const k = 1 / Math.sqrt(hx * hx + hz * hz + 4 * CELL * CELL), idx = (j * g.nx + i) * 3;
      nor[idx] = -hx * k; nor[idx + 1] = 2 * CELL * k; nor[idx + 2] = -hz * k;
    }
    const mat = terrainMaterial(act, AB.quality.settings.tier !== 'high');
    mat.vertexColors = true;
    const root = new T.Group(); root.name = 'terrain';
    const TS = 48;
    const tiles = [];
    for (let tj = 0; tj < g.nz - 1; tj += TS) for (let ti = 0; ti < g.nx - 1; ti += TS) {
      const i1 = Math.min(g.nx - 1, ti + TS), j1 = Math.min(g.nz - 1, tj + TS);
      // far tiles (outside the walkable corridor) use half resolution; skirts hide the seams
      let minD = 1e9; for (let j = tj; j <= j1; j += 2) for (let i = ti; i <= i1; i += 2) minD = Math.min(minD, g.D[j * g.nx + i]);
      const st = minD > 40 ? 2 : 1;
      const tm = makeTile(ti, tj, i1, j1, st);
      // corridor tiles also get the half-resolution mesh, drawn when the camera is away from the tile (integrator, perf)
      if (st === 1) {
        const lo = makeTile(ti, tj, i1, j1, 2);
        lo.visible = false; lo.userData.cull = null;
        cullList.splice(cullList.indexOf(lo), 1);
        tm.userData.cull.lo = lo;
        tm.userData.cull.rect = [g.x0 + ti * CELL, g.z0 + tj * CELL, g.x0 + i1 * CELL, g.z0 + j1 * CELL];
      }
    }
    function makeTile(ti, tj, i1, j1, st) {
      const cols = [], rows = [];
      for (let i = ti; i < i1; i += st) cols.push(i); cols.push(i1);
      for (let j = tj; j < j1; j += st) rows.push(j); rows.push(j1);
      const w = cols.length, hgt = rows.length;
      const edge = 2 * (w + hgt);
      const m = w * hgt + edge;
      const P = new Float32Array(m * 3), NN = new Float32Array(m * 3), RR = new Float32Array(m), ZZ = new Float32Array(m * 3), MM = new Float32Array(m * 3), CC = new Float32Array(m * 3), UV = new Float32Array(m * 2);
      const map = new Int32Array(m);
      const put = (li, gi, dy) => {
        map[li] = gi;
        P[li * 3] = pos[gi * 3]; P[li * 3 + 1] = pos[gi * 3 + 1] - dy; P[li * 3 + 2] = pos[gi * 3 + 2];
        NN.set(nor.subarray(gi * 3, gi * 3 + 3), li * 3);
        RR[li] = road[gi]; ZZ.set(zone.subarray(gi * 3, gi * 3 + 3), li * 3); MM.set(misc.subarray(gi * 3, gi * 3 + 3), li * 3);
      };
      for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) put(j * w + i, rows[j] * g.nx + cols[i], 0);
      const ix = [];
      for (let j = 0; j < hgt - 1; j++) for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        if (Math.abs(g.R[map[a]] - g.R[map[d]]) < Math.abs(g.R[map[b]] - g.R[map[c]])) ix.push(a, c, d, a, d, b); else ix.push(a, c, b, b, c, d);
      }
      // skirts: a 3 m curtain under each edge, drawn both ways
      let k = w * hgt;
      const skirt = (list) => { const base = k; for (const li of list) put(k++, map[li], 3); for (let q = 0; q < list.length - 1; q++) { const a = list[q], b = list[q + 1], c = base + q, d = base + q + 1; ix.push(a, b, d, a, d, c, a, d, b, a, c, d); } };
      skirt(Array.from({ length: w }, (_, i) => i));
      skirt(Array.from({ length: w }, (_, i) => (hgt - 1) * w + i));
      skirt(Array.from({ length: hgt }, (_, j) => j * w));
      skirt(Array.from({ length: hgt }, (_, j) => j * w + w - 1));
      const geom = new T.BufferGeometry();
      geom.setAttribute('position', new T.BufferAttribute(P.subarray(0, k * 3), 3)); geom.setAttribute('normal', new T.BufferAttribute(NN.subarray(0, k * 3), 3));
      geom.setAttribute('aRoad', new T.BufferAttribute(RR.subarray(0, k), 1)); geom.setAttribute('aZone', new T.BufferAttribute(ZZ.subarray(0, k * 3), 3));
      geom.setAttribute('aMisc', new T.BufferAttribute(MM.subarray(0, k * 3), 3)); geom.setAttribute('color', new T.BufferAttribute(CC.subarray(0, k * 3), 3)); geom.setAttribute('uv', new T.BufferAttribute(UV.subarray(0, k * 2), 2));
      geom.setIndex(new T.BufferAttribute(new Uint32Array(ix), 1));
      geom.computeBoundingSphere();
      const tm = new T.Mesh(geom, mat);
      tm.receiveShadow = true; tm.castShadow = AB.quality.settings.shadows && AB.quality.settings.tier === 'high';
      tm.userData.map = map.subarray(0, k);
      tm.userData.cull = { r: geom.boundingSphere.radius, c: geom.boundingSphere.center.clone(), far: 2000, cast: tm.castShadow, lo: null, rect: null };
      cullList.push(tm);
      root.add(tm); tiles.push(tm);
      return tm;
    }
    root.userData.tiles = tiles;
    return root;
  }
  // copy the baked contact-shadow colours into the terrain tiles
  function applyTerrainAO(root) {
    for (const tm of root.userData.tiles) {
      const map = tm.userData.map, c = tm.geometry.attributes.color.array;
      for (let i = 0; i < map.length; i++) { c[i * 3] = terrainAO[map[i] * 3]; c[i * 3 + 1] = terrainAO[map[i] * 3 + 1]; c[i * 3 + 2] = terrainAO[map[i] * 3 + 2]; }
      tm.geometry.attributes.color.needsUpdate = true;
    }
  }
  let terrainAO = null;
  // darken terrain vertex colours around a point (tree trunks, walls, buildings) for grounded contact shadows
  function aoSplat(x, z, r, k) {
    if (!terrainAO || !grid) return;
    const g = grid, i0 = Math.max(0, Math.floor((x - r - g.x0) / CELL)), i1 = Math.min(g.nx - 1, Math.ceil((x + r - g.x0) / CELL));
    const j0 = Math.max(0, Math.floor((z - r - g.z0) / CELL)), j1 = Math.min(g.nz - 1, Math.ceil((z + r - g.z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = g.x0 + i * CELL - x, dz = g.z0 + j * CELL - z, d = Math.sqrt(dx * dx + dz * dz);
      if (d > r) continue;
      const idx = (j * g.nx + i) * 3, f = 1 - k * (1 - d / r);
      terrainAO[idx] *= f; terrainAO[idx + 1] *= f; terrainAO[idx + 2] *= f;
    }
  }

  // ------------------------------------------------------------------------------- per-level grid textures (height, masks, water depth)
  let gridTex = null;                     // { height, mask, depth, uGrid: Vector4 }
  function buildGridTextures(act) {
    const g = grid, n = g.nx * g.nz;
    const hd = new Uint16Array(n);
    for (let i = 0; i < n; i++) hd[i] = T.DataUtils.toHalfFloat(g.R[i]);
    const height = new T.DataTexture(hd, g.nx, g.nz, T.RedFormat, T.HalfFloatType);
    height.magFilter = height.minFilter = T.LinearFilter; height.needsUpdate = true;
    const md = new Uint8Array(n * 4), dd = new Uint8Array(n * 4);
    const L = def.length, noise = g.noise, hs = def.hall ? def.hall * L : 1e9;
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
      const idx = j * g.nx + i, x = g.x0 + i * CELL, z = g.z0 + j * CELL;
      const d = g.D[idx], k = g.N[idx], s = samples.s[k], h = g.R[idx];
      const nn = noise.noise(x * 0.08 + 5, z * 0.08) * 0.5 + 0.5, nb = noise.noise(x * 0.021 + 3, z * 0.021 - 6) * 0.5 + 0.5;
      // slope from neighbours
      const hx = g.R[j * g.nx + Math.min(g.nx - 1, i + 1)] - g.R[j * g.nx + Math.max(0, i - 1)], hz = g.R[Math.min(g.nz - 1, j + 1) * g.nx + i] - g.R[Math.max(0, j - 1) * g.nx + i];
      const slope = Math.hypot(hx, hz) / (2 * CELL);
      let dens = 0, dry = 0, hgt = 0.6, flw = 0;
      const offRoad = sm(ROAD_HALF - 0.4 + nn * 0.8, ROAD_HALF + 1.2 + nn, d);
      const flat = 1 - sm(0.45, 0.8, slope);
      let wl = -1e9;
      if (act === 1) {
        const zw = zoneW(s);
        dens = (zw[0] * (0.75 + 0.25 * nn) + zw[1] * (0.25 + 0.35 * sm(0.5, 0.8, nb)) + zw[2] * 0.7) * offRoad * flat;
        dry = zw[0] * sm(0.55, 0.85, nb) * 0.6 + zw[2] * 0.75 + zw[1] * 0.2;
        hgt = 0.45 + zw[0] * 0.25 * nb + zw[2] * 0.75 + zw[1] * 0.1;
        flw = zw[0] * sm(0.55, 0.8, nn) * offRoad * flat;
        if (feat.waterY != null && zw[2] > 0.3) { wl = feat.waterY; if (h < wl + 0.05) dens = 0; }
        if (feat.stream) { const pd = polyDist(feat.stream.xs, feat.stream.zs, x, z); if (pd.d < feat.stream.width + 1.5) { dens *= sm(feat.stream.width * 0.5, feat.stream.width + 1.5, pd.d); } if (pd.d < 6) wl = Math.max(wl, streamLevel(pd.t)); }
      } else if (act === 2) {
        if (s < hs - 2) { dens = sm(0.55, 0.8, nb) * 0.35 * offRoad * flat; dry = 1; hgt = 0.7; }
        else wl = baseAt(hs) - 0.4;
      } else if (act === 3) {
        dens = sm(0.6, 0.85, nb) * 0.25 * offRoad * flat; dry = 1; hgt = 0.35;
        for (const fi of feat.fissures) { const pd = polyDist(fi.xs, fi.zs, x, z); if (pd.d < fi.width + 3) dens = 0; }
      }
      if (level && level.pois) for (const p of level.pois) { const dd2 = Math.hypot(p.x - x, p.z - z); if (dd2 < 3.2) { dens *= sm(1.6, 3.2, dd2); flw *= sm(2.5, 4, dd2); } }
      md[idx * 4] = U.clamp(dens, 0, 1) * 255; md[idx * 4 + 1] = U.clamp(dry, 0, 1) * 255; md[idx * 4 + 2] = U.clamp(hgt / 1.6, 0, 1) * 255; md[idx * 4 + 3] = U.clamp(flw, 0, 1) * 255;
      const depth = wl > -1e8 ? U.clamp((wl - h) / 2.55, 0, 1) : 0;
      dd[idx * 4] = depth * 255; dd[idx * 4 + 1] = dd[idx * 4 + 2] = 0; dd[idx * 4 + 3] = 255;
    }
    const mask = new T.DataTexture(md, g.nx, g.nz); mask.magFilter = mask.minFilter = T.LinearFilter; mask.needsUpdate = true;
    const depthT = new T.DataTexture(dd, g.nx, g.nz); depthT.magFilter = depthT.minFilter = T.LinearFilter; depthT.needsUpdate = true;
    waterDepth = dd;
    gridTex = { height, mask, depth: depthT, uGrid: new T.Vector4(g.x0, g.z0, (g.nx - 1) * CELL, (g.nz - 1) * CELL) };
    // half-texel correction: texel centres sit on grid vertices
    gridTex.uGrid.x -= CELL * 0.5; gridTex.uGrid.y -= CELL * 0.5; gridTex.uGrid.z += CELL; gridTex.uGrid.w += CELL;
    levelDisposables.push(height, mask, depthT);
  }
  function streamLevel(t) {   // water surface of the Thistledown stream at parameter t along it
    const st = feat.stream, i = Math.round(U.clamp(t, 0, 1) * (st.pts.length - 1)), p = st.pts[i];
    const k = nearestSampleIdx(p.x, p.z);
    return baseAt(samples.s[k]) - st.depth + 0.62;
  }
  function nearestSampleIdx(x, z) { return grid ? nearestSample(x, z) : 0; }

  // ------------------------------------------------------------------------------- water and lava meshes
  function ribbon(pts, widthFn, yFn, step = 1) {   // flat strip along a polyline (uv: u across, v along metres)
    const b = new GB();
    let len = 0, prev = null;
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const tx = q.x - o.x, tz = q.z - o.z, tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      if (i > 0) len += Math.hypot(p.x - pts[i - step].x, p.z - pts[i - step].z);
      const w = widthFn(i / (pts.length - 1)), y = yFn(i / (pts.length - 1), p);
      const a = b.v(p.x + nx * w, y, p.z + nz * w, 0, 1, 0, 0, len), c = b.v(p.x - nx * w, y, p.z - nz * w, 0, 1, 0, 1, len);
      if (prev) b.quad(prev[0], a, c, prev[1]);
      prev = [a, c];
    }
    return b.geo();
  }
  function buildWater(act, group) {
    const sky = presetFor(0).sky;
    const common = { depthTex: gridTex.depth };
    if (act === 1) {
      const L = def.length;
      // fen plane over the fen region
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (let k = Math.floor(0.6 * L); k < mainN; k++) { minX = Math.min(minX, samples.x[k]); maxX = Math.max(maxX, samples.x[k]); minZ = Math.min(minZ, samples.z[k]); maxZ = Math.max(maxZ, samples.z[k]); }
      const pad = 60;
      const geo = new T.PlaneGeometry(maxX - minX + pad * 2, maxZ - minZ + pad * 2, 1, 1).rotateX(-Math.PI / 2);
      const wm = waterMaterial(Object.assign({ deep: 0x030506, shallow: 0x1a1810, sky: sky.zenith, horizon: sky.horizon, rough: 0.22, alpha: 0.94 }, common));
      wm.uniforms.uGrid.value.copy(gridTex.uGrid);
      const m = new T.Mesh(geo, wm); m.position.set((minX + maxX) / 2, feat.waterY, (minZ + maxZ) / 2); m.renderOrder = 2;
      group.add(m); waterMats.push(wm);
      // the stream
      const st = feat.stream;
      const sg = ribbon(st.pts, () => 2.6, (t) => streamLevel(t) - 0.05);
      const sm2 = waterMaterial(Object.assign({ deep: 0x0a1210, shallow: 0x1e2016, sky: sky.zenith, horizon: sky.horizon, rough: 0.22, flow: [0.25, 0.0], alpha: 0.9 }, common));
      sm2.uniforms.uGrid.value.copy(gridTex.uGrid);
      const sm3 = new T.Mesh(sg, sm2); sm3.renderOrder = 2; group.add(sm3); waterMats.push(sm2);
    }
    if (act === 2) {
      const hs = def.hall * def.length, fl = baseAt(hs) - 0.42;
      for (const side of [-1, 1]) {
        const pts = [];
        for (let s = Math.ceil(hs + 12); s <= def.length - 34; s += 2) { const yaw = roadYaw(s); pts.push(new V3(samples.x[s] + Math.cos(yaw) * 16.25 * side, 0, samples.z[s] - Math.sin(yaw) * 16.25 * side)); }
        const geo = ribbon(pts, () => 2.6, () => fl);
        const wm = waterMaterial(Object.assign({ deep: 0x020608, shallow: 0x10201e, sky: 0x2a2420, horizon: 0x3a2a1c, rough: 0.3, flow: [0, 0.18 * side], alpha: 0.93, glow: 0x020302 }, common));
        wm.uniforms.uGrid.value.copy(gridTex.uGrid);
        const m = new T.Mesh(geo, wm); m.renderOrder = 2; group.add(m); waterMats.push(wm);
      }
    }
    if (act === 3) {
      const lm = lavaMaterial({ gain: 3.4, scale: 0.16 });
      for (const fi of feat.fissures) {
        const g = ribbon(fi.pts, (t) => fi.width * 0.75 * Math.max(0.25, Math.sin(Math.PI * t)), (t, p) => heightAt(p.x, p.z) + 0.25);
        const m = new T.Mesh(g, lm); group.add(m);
        // glow light at the fissure middle
        const mid = fi.pts[Math.floor(fi.pts.length / 2)];
        lightSources.push({ x: mid.x, y: heightAt(mid.x, mid.z) + 1.2, z: mid.z, color: new T.Color(0xff5a1a), i: 26, range: 16, flick: 0.25, seed: mid.x });
      }
    }
    if (act === 'forge') {
      const geo = new T.PlaneGeometry((grid.nx - 1) * CELL + 200, (grid.nz - 1) * CELL + 200, 1, 1).rotateX(-Math.PI / 2);
      const m = new T.Mesh(geo, lavaMaterial({ gain: 3.0, scale: 0.05, flow: [0.006, 0.004] }));
      m.position.set(grid.x0 + (grid.nx - 1) * CELL / 2, -24, grid.z0 + (grid.nz - 1) * CELL / 2);
      group.add(m);
    }
  }
  const waterMats = [];

  // =============================================================================== SCATTER (layout-stable: counts never depend on quality)
  let keepouts = [];                      // [{x, z, r}] areas trees/rocks avoid (POIs, set pieces, approaches)
  function blocked(x, z, r) {
    for (let i = 0; i < keepouts.length; i++) { const k = keepouts[i]; const dx = k.x - x, dz = k.z - z, rr = k.r + r; if (dx * dx + dz * dz < rr * rr) return true; }
    return false;
  }
  function addPoiKeepouts() {
    // the fellowship-pick camera looks at the first camp from +Z (game.openPick): keep that sight line clear
    const camp = level.pois.find((p) => p.type === 'camp');
    if (camp) for (const dz of [5, 9, 13]) keepouts.push({ x: camp.x, z: camp.z + dz, r: 5.5 });
    for (const p of level.pois) {
      keepouts.push({ x: p.x, z: p.z, r: Math.max(p.radius || 0, 5) + 3 });
      // the walk between the road and a roadside POI stays open
      if (p.side) { const k = nearestSampleIdx(p.x, p.z); for (let t = 0.2; t < 1; t += 0.2) keepouts.push({ x: U.lerp(p.x, samples.x[k], t), z: U.lerp(p.z, samples.z[k], t), r: 3 }); }
    }
  }
  function gridSlope(x, z) { const e = 1.2; return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e); }
  function isWater(x, z) { return feat.waterY != null && heightAt(x, z) < feat.waterY - 0.02 && samples.s[grid.N[cellOf(x, z)]] > 0.62 * def.length; }
  function nearFissure(x, z, r) { for (const fi of feat.fissures) if (polyDist(fi.xs, fi.zs, x, z).d < fi.width + r) return true; return false; }
  // place `n` items: candidate generator picks a random path sample + offset; accept(x, z, d, s, k) -> bool
  function placeMany(rng, n, maxD, accept, tries = 10) {
    const out = [];
    for (let t = 0; t < n * tries && out.length < n; t++) {
      const k = rng.int(0, samples.n - 1);
      const a = rng.float(0, TAU), r = Math.sqrt(rng.next()) * maxD;
      const x = samples.x[k] + Math.cos(a) * r, z = samples.z[k] + Math.sin(a) * r;
      if (x < grid.x0 + 2 || z < grid.z0 + 2 || x > grid.x0 + (grid.nx - 3) * CELL || z > grid.z0 + (grid.nz - 3) * CELL) continue;
      const ci = cellOf(x, z);
      const d = grid.D[ci], s = samples.s[grid.N[ci]];
      const res = accept(x, z, d, s, grid.N[ci]);
      if (res) out.push(Object.assign({ x, z, d, s }, res === true ? {} : res));
    }
    return out;
  }
  function addTreeCollider(x, z, r, d, k) { if (d < samples.corr[k] + 2) level.colliders.push({ x, z, r }); }

  let aoList = [];                        // [x, z, r, k] contact-shadow splats from the layout (applied per visual build)
  function scatterVegetation(act, rng) {
    const L = def.length, hs = def.hall ? def.hall * L : 1e9;
    const C = new T.Color();
    const items = { broad: [[], []], pine: [[], []], dead: [[], []], deadMoss: [[], []], broadL: [], pineL: [], deadL: [], bush: [[], []], fern: [], reeds: [], rock: { boulder: [[], []], slab: [[], []], spire: [[], []], chunk: [[], []] }, log: [], stump: [] };
    const treeOk = (x, z, d, minD, r = 2) => d > minD && !blocked(x, z, r) && gridSlope(x, z) < 0.9 && !isWater(x, z) && !nearFissure(x, z, 2.5);
    const pushTree = (list, x, z, d, k, s, r0 = 0.32) => {
      const sc = rng.float(0.8, 1.3);
      list.push({ x, y: heightAt(x, z) - 0.05, z, ry: rng.float(0, TAU), s: sc, rx: rng.float(-0.04, 0.04), rz: rng.float(-0.04, 0.04) });
      addTreeCollider(x, z, r0 * sc + 0.12, d, k);
      aoList.push([x, z, 3.6 * sc, 0.32]);
      keepouts.push({ x, z, r: 1.4 * sc });
    };
    if (act === 1) {
      // Thistledown: scattered broadleaf + hedge bushes; Whisperwood: dense broadleaf + pines + ferns + logs; Fen: dead trees
      placeMany(rng, 70, 60, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[0] < 0.5 || !treeOk(x, z, d, 9, 2.5)) return false; pushTree(items.broad[rng.int(0, 1)], x, z, d, k, s); return true; });
      placeMany(rng, 300, 50, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[1] < 0.5 || !treeOk(x, z, d, 4.8, 2.0)) return false; if (rng.chance(0.28)) pushTree(items.pine[rng.int(0, 1)], x, z, d, k, s, 0.25); else pushTree(items.broad[rng.int(0, 1)], x, z, d, k, s); return true; });
      placeMany(rng, 60, 50, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[2] < 0.5 || !treeOk(x, z, d, 6, 1.5)) return false; pushTree(items.deadMoss[rng.int(0, 1)], x, z, d, k, s, 0.22); return true; });
      placeMany(rng, 26, 40, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[2] < 0.5 || d < 7 || blocked(x, z, 1.5) || !isWater(x, z)) return false; pushTree(items.dead[rng.int(0, 1)], x, z, d, k, s, 0.22); return true; });
      placeMany(rng, 90, 34, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[2] > 0.5 || !treeOk(x, z, d, ROAD_HALF + 2, 1)) return false; items.bush[rng.int(0, 1)].push({ x, y: heightAt(x, z) - 0.1, z, ry: rng.float(0, TAU), s: rng.float(0.8, 1.5) }); return true; });
      placeMany(rng, 240, 30, (x, z, d, s) => { const zw = zoneW(s); if (zw[1] < 0.5 || d < ROAD_HALF + 1.2 || blocked(x, z, 0.4) || gridSlope(x, z) > 0.7) return false; items.fern.push({ x, y: heightAt(x, z) - 0.05, z, ry: rng.float(0, TAU), s: rng.float(0.7, 1.3) }); return true; });
      placeMany(rng, 16, 30, (x, z, d, s, k) => { const zw = zoneW(s); if (zw[1] < 0.5 || !treeOk(x, z, d, 6, 3.2)) return false; const ry = rng.float(0, TAU); items.log.push({ x, y: heightAt(x, z) + 0.15, z, ry, s: rng.float(0.8, 1.2) }); if (d < samples.corr[k] + 2) for (const t of [-2, 0, 2]) level.colliders.push({ x: x + Math.cos(ry) * t, z: z - Math.sin(ry) * t, r: 0.5 }); keepouts.push({ x, z, r: 3.2 }); return true; });
      placeMany(rng, 150, 32, (x, z, d, s) => { const zw = zoneW(s); if (zw[2] < 0.5 || d < ROAD_HALF + 1.5 || blocked(x, z, 0.6)) return false; const h = heightAt(x, z); if (h > feat.waterY + 0.25) return false; items.reeds.push({ x, y: h - 0.1, z, ry: rng.float(0, TAU), s: rng.float(0.7, 1.25) }); return true; });
      placeMany(rng, 24, 34, (x, z, d, s) => { if (d < ROAD_HALF + 1.5 || blocked(x, z, 1)) return false; items.stump.push({ x, y: heightAt(x, z), z, ry: rng.float(0, TAU), s: rng.float(0.6, 1.1) }); return true; });
    } else if (act === 2) {
      placeMany(rng, 260, 62, (x, z, d, s, k) => { if (s > hs - 6 || !treeOk(x, z, d, 6.5, 2) || gridSlope(x, z) > 1.1) return false; pushTree(items.pine[rng.int(0, 1)], x, z, d, k, s, 0.24); return true; });
      placeMany(rng, 18, 40, (x, z, d, s, k) => { if (s > hs - 6 || !treeOk(x, z, d, 6, 1.5)) return false; pushTree(items.dead[rng.int(0, 1)], x, z, d, k, s, 0.2); return true; });
    } else if (act === 3) {
      placeMany(rng, 60, 50, (x, z, d, s, k) => { if (!treeOk(x, z, d, 6, 1.6) || s > 0.82 * L) return false; pushTree(items.dead[rng.int(0, 1)], x, z, d, k, s, 0.22); return true; });
    }
    // rocks everywhere (counts fixed); big ones carry colliders
    const rockN = act === 'forge' ? 40 : 150;
    const kinds = act === 3 ? ['chunk', 'spire', 'boulder', 'slab'] : act === 2 ? ['boulder', 'slab', 'chunk', 'spire'] : ['boulder', 'slab', 'boulder', 'chunk'];
    placeMany(rng, rockN, act === 'forge' ? 30 : 58, (x, z, d, s, k) => {
      if (act === 2 && s > hs - 2) return false;
      if (d < ROAD_HALF + 1.8 || blocked(x, z, 1.2) || isWater(x, z) || nearFissure(x, z, 1.5)) return false;
      const big = d > samples.corr[k] - 3 ? rng.float(1.5, 4.5) : rng.chance(0.25) ? rng.float(0.9, 1.8) : rng.float(0.3, 0.8);
      const kind = kinds[rng.int(0, kinds.length - 1)];
      const it = { x, y: heightAt(x, z) - big * 0.15, z, ry: rng.float(0, TAU), rx: rng.float(-0.2, 0.2), rz: rng.float(-0.2, 0.2), s: big };
      items.rock[kind][big < 1.0 ? 1 : 0].push(it);
      if (big > 0.7 && d < samples.corr[k] + 2) level.colliders.push({ x, z, r: big * (kind === 'slab' ? 1.1 : kind === 'spire' ? 0.55 : 0.85) });
      if (big > 1.2) aoList.push([x, z, big * 2, 0.35]);
      keepouts.push({ x, z, r: big * 0.9 });
      return true;
    });
    // far scenery beyond the walkable corridor (no colliders): quality scales the count
    const farN = act === 1 ? 200 : act === 2 ? 230 : act === 3 ? 70 : 0;
    placeMany(rng, farN, 95, (x, z, d, s, k) => {
      if (d < samples.corr[k] + 3 || gridSlope(x, z) > 1.3 || isWater(x, z)) return false;
      if (act === 2 && s > hs - 6) return false;
      const it = { x, y: heightAt(x, z) - 0.1, z, ry: rng.float(0, TAU), s: rng.float(0.9, 1.4) };
      if (act === 1) { const zw = zoneW(s); if (zw[2] > 0.5) items.deadL.push(it); else if (zw[1] > 0.5 && rng.chance(0.35)) items.pineL.push(it); else items.broadL.push(it); }
      else if (act === 2) items.pineL.push(it);
      else items.deadL.push(it);
      return true;
    });
    return items;
  }
  // meshes for the placed vegetation; the tier decides geometry detail and how many of the small/far items are drawn
  function buildVegetation(act, items, group) {
    const q = AB.quality.settings, low = q.tier === 'low';
    const sub = (list, k) => (k >= 1 ? list : list.filter((_, i) => (i * 0.6180339) % 1 < k));
    for (const a of aoList) aoSplat(a[0], a[1], a[2], a[3]);
    const fs = q.foliageShadows && !lean();
    const leafTint = act === 1 ? 0xb8c49c : 0x9aa080;
    const lm = MAT.leaves(leafTint), ld = depthFor(lm, { wind: WIND_TREE });
    const pm = MAT.pine(act === 2), pd = depthFor(pm, { wind: WIND_TREE });
    // near trees: full detail on the camera's stretch of road, the far-scenery mesh beyond it (lodGeo, same instances),
    // and the far-scenery mesh for the shadow map (shadowGeo: shadow proxies, see instance())
    for (let v = 0; v < 2; v++) {
      const g = broadleafGeo(low ? 0 : v, low), gL = broadleafGeo(low ? 0 : v, true);
      instance(group, g.trunk, MAT.bark(act), items.broad[v], { cast: q.shadows, lodGeo: gL.trunk, shadowGeo: gL.trunk });
      instance(group, g.leaves, lm, items.broad[v], { cast: fs, depth: ld, lodGeo: gL.leaves, shadowGeo: gL.leaves });
      const p = pineGeo(low ? 0 : v, low), pL = pineGeo(low ? 0 : v, true);
      instance(group, p.trunk, MAT.bark(act), items.pine[v], { cast: q.shadows, lodGeo: pL.trunk, shadowGeo: pL.trunk });
      instance(group, p.leaves, pm, items.pine[v], { cast: fs, depth: pd, lodGeo: pL.leaves, shadowGeo: pL.leaves });
      const dL = deadGeo(v, false, true);
      instance(group, deadGeo(v, false).trunk, MAT.dead(act), items.dead[v], { cast: q.shadows, lodGeo: dL.trunk, shadowGeo: dL.trunk });
      const dm = deadGeo(v, true), dmL = deadGeo(v, true, true);
      instance(group, dm.trunk, MAT.dead(act), items.deadMoss[v], { cast: q.shadows, lodGeo: dmL.trunk, shadowGeo: dmL.trunk });
      if (items.deadMoss[v].length) instance(group, dm.leaves, MAT.moss(), items.deadMoss[v], { cast: false, lodGeo: dmL.leaves });
      const bm = MAT.bush(v ? 0xb4c494 : 0xccd4a4);
      instance(group, bushGeo(v), bm, sub(items.bush[v], 0.5 + q.detail * 0.5), { cast: fs, depth: depthFor(bm, { wind: WIND_BUSH }), far: 110, shadowGeo: bushGeo(v) });
      for (const kind of Object.keys(items.rock)) {
        const rg = rockGeo(0, kind, v === 1 || low), rL = rockGeo(0, kind, true);
        instance(group, rg, MAT.rock(act), v === 1 ? sub(items.rock[kind][v], q.detail) : items.rock[kind][v], { cast: q.shadows && v === 0, far: v === 1 ? 90 : 0, lodGeo: rL, shadowGeo: rL });
      }
    }
    // far scenery: low-poly versions, no shadows
    const bl = broadleafGeo(0, true), pl = pineGeo(0, true), dl = deadGeo(1, false, true);
    const fk = (0.35 + q.detail * 0.65) * (lean() ? 0.6 : 1);
    instance(group, bl.trunk, MAT.bark(act), sub(items.broadL, fk), { cast: false });
    instance(group, bl.leaves, lm, sub(items.broadL, fk), { cast: false });
    instance(group, pl.trunk, MAT.bark(act), sub(items.pineL, fk), { cast: false });
    instance(group, pl.leaves, pm, sub(items.pineL, fk), { cast: false });
    instance(group, dl.trunk, MAT.dead(act), sub(items.deadL, fk), { cast: false });
    instance(group, fernGeo(), MAT.fern(), sub(items.fern, 0.4 + q.detail * 0.6), { cast: false, far: 70 });
    instance(group, reedGeo(), MAT.reeds(), sub(items.reeds, 0.5 + q.detail * 0.5), { cast: false, far: 100 });
    instance(group, logGeo(), MAT.log(), items.log, { cast: q.shadows, shadowGeo: logGeo() });
    instance(group, stumpGeo(), MAT.log(), sub(items.stump, q.detail), { cast: false, far: 90 });
  }

  // =============================================================================== GPU GRASS + FLOWERS (camera-centred toroidal patch)
  let grassMesh = null, flowerMesh = null;
  const grassU = { uCenter: { value: new T.Vector2() }, uPatch: { value: 50 }, uPush: { value: [new T.Vector3(0, -99, 0), new T.Vector3(0, -99, 0), new T.Vector3(0, -99, 0), new T.Vector3(0, -99, 0)] } };
  function bladeGeo() {
    return G('bladecards', () => {
      const b = new GB(true);
      const W = 0.42, H = 1.05;
      for (let k = 0; k < 2; k++) {
        const ax = k ? 0 : 1, az = k ? 1 : 0;
        const i0 = b.v(-W * ax, 0, -W * az, 0, 1, 0, 0, 0, 0.75, 0.75, 0.75), i1 = b.v(W * ax, 0, W * az, 0, 1, 0, 1, 0, 0.75, 0.75, 0.75);
        const i2 = b.v(W * ax, H, W * az, 0, 1, 0, 1, 1, 1, 1, 1), i3 = b.v(-W * ax, H, -W * az, 0, 1, 0, 0, 1, 1, 1, 1);
        b.quad(i0, i1, i2, i3);
      }
      return b.geo();
    });
  }
  function flowerGeo() {
    return G('flower', () => {
      const b = new GB(true);
      const h = 0.42;
      const s0 = b.v(-0.008, 0, 0, 0, 1, 0, 0, 0, 0.2, 0.3, 0.1), s1 = b.v(0.008, 0, 0, 0, 1, 0, 1, 0, 0.2, 0.3, 0.1), s2 = b.v(0.008, h, 0, 0, 1, 0, 1, 0.9, 0.25, 0.35, 0.12), s3 = b.v(-0.008, h, 0, 0, 1, 0, 0, 0.9, 0.25, 0.35, 0.12);
      b.quad(s0, s1, s2, s3);
      const c = b.v(0, h + 0.01, 0, 0, 1, 0, 0.5, 1, 1.0, 0.85, 0.4);
      const n = 5, ids = [];
      for (let k = 0; k <= n; k++) { const a = (k / n) * TAU; ids.push(b.v(Math.cos(a) * 0.05, h, Math.sin(a) * 0.05, 0, 1, 0, 0.5, 1, 1, 1, 1)); }
      for (let k = 0; k < n; k++) b.tri(c, ids[k + 1], ids[k]);
      return b.geo();
    });
  }
  function patchMaterial(kind) {
    const card = kind === 'grass';
    const straw = card && patchAct === 2;   // Greyspire: sparse, short, dry straw poking out of the snow
    const m = new T.MeshLambertMaterial(card ? { vertexColors: true, side: T.DoubleSide, map: AB.tex.card('grass'), alphaTest: 0.5, alphaToCoverage: A2C() } : { vertexColors: true, side: T.DoubleSide });
    m.customProgramCacheKey = () => 'patch:' + kind + (straw ? ':straw' : '');
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uniforms.uWind;
      sh.uniforms.uCenter = grassU.uCenter; sh.uniforms.uPatch = grassU.uPatch; sh.uniforms.uPush = grassU.uPush;
      sh.uniforms.tHeight = { value: gridTex.height }; sh.uniforms.tMask = { value: gridTex.mask }; sh.uniforms.uGrid = { value: gridTex.uGrid };
      sh.uniforms.uDry = { value: new T.Color(act3Dry(kind)) };
      sh.uniforms.uSunDirV = sunU.uSunDirV; sh.uniforms.uSunCol = sunU.uSunCol;
      m.userData.shader = sh;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec4 aOff; uniform float uTime, uPatch; uniform vec2 uWind, uCenter; uniform vec3 uPush[4]; uniform vec3 uDry;',
          'uniform sampler2D tHeight, tMask; uniform vec4 uGrid; varying float vFade; varying vec3 vTint;'
        ].join('\n'))
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + normal * 0.25);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif')
        .replace('#include <begin_vertex>', [
          'vec2 rel = mod(aOff.xy * uPatch - uCenter + uPatch * 0.5, uPatch) - uPatch * 0.5;',
          'vec2 wxz = uCenter + rel;',
          'vec2 guv = (wxz - uGrid.xy) / uGrid.zw;',
          'vec4 mk = texture2D(tMask, guv);',
          'float gy = texture2D(tHeight, guv).r;',
          'float dist = length(rel);',
          'float keep = step(aOff.z, ' + (kind === 'flower' ? 'mk.a * 0.55' : straw ? 'mk.r * 0.3' : 'mk.r') + ') * (1.0 - smoothstep(uPatch * 0.34, uPatch * 0.49, dist));',
          'float hgt = (0.55 + aOff.w * 0.7) * mk.b * 1.6 * keep' + (straw ? ' * 0.45' : '') + ';',
          'float ang = aOff.w * 31.4 + aOff.z * 17.0;',
          'float ca = cos(ang), sa = sin(ang);',
          'vec3 transformed = vec3(position.x * ca - position.z * sa, position.y * hgt, position.x * sa + position.z * ca);',
          'transformed.xz *= keep * (0.8 + aOff.z * 0.5);',
          'float v2 = uv.y * uv.y;',
          'float gust = 0.55 + 0.45 * sin(uTime * 0.6 + wxz.x * 0.05 + wxz.y * 0.04) * sin(uTime * 0.31 + wxz.y * 0.03);',
          'vec2 bend = uWind * (0.18 + 0.22 * gust) * (0.6 + 0.4 * sin(uTime * 2.1 + dot(wxz, vec2(0.7, 0.9))));',
          'transformed.xz += bend * v2 * hgt;',
          'for (int i = 0; i < 4; i++) { vec2 dp = wxz - uPush[i].xz; float dd = length(dp); float pk = (1.0 - smoothstep(0.2, 1.1, dd)) * step(abs(gy - uPush[i].y), 2.0); transformed.xz += normalize(dp + 0.0001) * pk * 0.45 * v2 * hgt; transformed.y -= pk * 0.4 * v2 * hgt; }',
          'transformed.xz += wxz; transformed.y += gy - 0.02;',
          'vFade = keep;',
          kind === 'flower'
            ? 'float pc = fract(aOff.w * 7.13); vTint = pc < 0.3 ? vec3(0.95, 0.92, 0.82) : pc < 0.55 ? vec3(0.95, 0.78, 0.25) : pc < 0.8 ? vec3(0.55, 0.42, 0.85) : vec3(0.85, 0.28, 0.22);'
            : straw ? 'vTint = vec3(0.8 + aOff.w * 0.4);' : 'vTint = mix(vec3(1.0), uDry, mk.g) * (0.8 + aOff.w * 0.4);',
          // NOTE: color_vertex runs BEFORE begin_vertex in three's shaders, so the tint is applied here (reading vTint
          // in color_vertex would read an unwritten varying: black grass on some GPUs)
          kind === 'flower' ? 'vColor.rgb = mix(vColor.rgb, vColor.rgb * vTint, step(0.95, uv.y));' : 'vColor.rgb *= vTint;'
        ].join('\n'));
      if (straw) sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))) * vec3(1.3, 1.05, 0.62);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade; uniform vec3 uSunDirV; uniform vec3 uSunCol;').replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '')).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (uSunCol * pow(max(dot(normalize(-vViewPosition), uSunDirV), 0.0), 4.0) * 0.6 + 0.14);').replace('#include <clipping_planes_fragment>', 'if (vFade < 0.01) discard;\n#include <clipping_planes_fragment>');
    };
    return m;
  }
  let patchAct = 1;
  function act3Dry(kind) { return patchAct === 3 ? 0x2a2018 : patchAct === 2 ? 0xa89870 : 0xc0a860; }
  function buildGrassPatch(act, group) {
    const q = AB.quality.settings;
    patchAct = act;
    if (act === 'forge') return;
    // HIGH patch 42 m (was 46; integrator perf trim, same blade density): the corners of the square patch are always faded out
    const P = q.tier === 'high' ? 42 : q.tier === 'medium' ? 38 : 28;
    grassU.uPatch.value = P;
    const mk = (geoBase, count, kind) => {
      const g = G('patchGeo:' + kind + ':' + count, () => {
        const gg = new T.InstancedBufferGeometry();
        gg.index = geoBase.index;
        for (const k of Object.keys(geoBase.attributes)) gg.setAttribute(k, geoBase.attributes[k]);
        const off = new Float32Array(count * 4);
        const rng = AB.rng('patch:' + kind);
        for (let i = 0; i < count; i++) { off[i * 4] = rng.next(); off[i * 4 + 1] = rng.next(); off[i * 4 + 2] = rng.next(); off[i * 4 + 3] = rng.next(); }
        gg.setAttribute('aOff', new T.InstancedBufferAttribute(off, 4));
        gg.instanceCount = count;
        return gg;
      });
      const mesh = new T.Mesh(g, patchMaterial(kind));
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.userData.patchGeo = g;
      group.add(mesh);
      return mesh;
    };
    // one clump = 2 crossed cards of ~26 blades (4 tris): the same clump count shows ~15x more blades than the old 3-blade clumps
    const clumps = Math.round(q.grass / 3.4 * (lean() ? 0.6 : 1) * (q.tier === 'high' ? (42 * 42) / (46 * 46) : 1));
    grassMesh = mk(bladeGeo(), clumps, 'grass');
    flowerMesh = act === 1 ? mk(flowerGeo(), Math.round(clumps / 5), 'flower') : null;
  }

  // =============================================================================== SET PIECES (planned with the layout: colliders are quality-independent)
  let pieces = [];
  let lightSources = [];                  // {x, y, z, color, i, range, flick, seed, poiId?, k (0..1 live scale)}
  let emit = null;                        // { flames, smoke, embers, glints, shafts, mist } emitter lists (cosmetic)
  const lat = (s, l) => { const i = U.clamp(Math.round(s), 1, mainN - 2), yaw = mainYaw(i); return { x: samples.x[i] + Math.cos(yaw) * l, z: samples.z[i] - Math.sin(yaw) * l, yaw }; };
  const lw = (p, lx, lz) => ({ x: p.x + Math.cos(p.yaw) * lx + Math.sin(p.yaw) * lz, z: p.z - Math.sin(p.yaw) * lx + Math.cos(p.yaw) * lz });
  function pathDist(x, z) { const k = nearestSample(x, z); return Math.hypot(samples.x[k] - x, samples.z[k] - z); }
  function spotFree(x, z, r, roadGap = ROAD_HALF + 1.5) { return pathDist(x, z) > r + roadGap && !blocked(x, z, r) && !isWater(x, z); }
  function col(x, z, r) { level.colliders.push({ x, z, r }); }
  function colLine(x0, z0, x1, z1, r, step = 1.1) { const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / step)); for (let i = 0; i <= n; i++) col(U.lerp(x0, x1, i / n), U.lerp(z0, z1, i / n), r); }

  function planPieces(act, rng) {
    pieces = [];
    const L = def.length;
    const P = (o) => { pieces.push(o); if (o.keep) keepouts.push({ x: o.x, z: o.z, r: o.keep }); return o; };
    // signposts / markers at every branch mouth
    for (const b of branches) {
      const p = lat(b.s0 - 4.5, b.side * 4.4);
      if (!blocked(p.x, p.z, 0.8)) P({ kind: 'signpost', x: p.x, z: p.z, yaw: p.yaw + (b.side > 0 ? -0.4 : 0.4), side: b.side, keep: 1.2 });
    }
    if (act === 1) {
      const st = feat.stream;
      const bp = lat(st.s, 0);
      P({ kind: 'bridge', x: bp.x, z: bp.z, yaw: bp.yaw, s: st.s, keep: 7 });
      for (const side of [-1, 1]) { const a = lat(st.s - 5.2, side * 3.35), b = lat(st.s + 5.2, side * 3.35); colLine(a.x, a.z, b.x, b.z, 0.32, 1.0); }
      // Thistledown cottages, facing the road
      let n = 0;
      for (let t = 0; t < 60 && n < 6; t++) {
        const s = rng.float(12, 0.27 * L), side = rng.chance(0.5) ? 1 : -1, l = side * rng.float(15, 23);
        const p = lat(s, l);
        if (!spotFree(p.x, p.z, 5.2, 7) || polyDist(st.xs, st.zs, p.x, p.z).d < 9) continue;
        const yaw = p.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + rng.float(-0.25, 0.25);
        P({ kind: 'cottage', x: p.x, z: p.z, yaw, s, w: rng.float(6, 7.4), d: rng.float(4.4, 5.2), keep: 6.5, v: n });
        // solid footprint
        for (const o of [-2, 0, 2]) { const q = lw({ x: p.x, z: p.z, yaw }, o, 0); col(q.x, q.z, 2.5); }
        n++;
      }
      // a well and a cart near the hamlet road, haystacks
      for (let t = 0; t < 20; t++) { const p = lat(rng.float(20, 110), (rng.chance(0.5) ? 1 : -1) * rng.float(7.5, 10)); if (spotFree(p.x, p.z, 1.6, 3.5)) { P({ kind: 'well', x: p.x, z: p.z, yaw: p.yaw, keep: 2.4 }); col(p.x, p.z, 1.1); break; } }
      for (let k = 0; k < 4; k++) for (let t = 0; t < 12; t++) { const p = lat(rng.float(15, 0.28 * L), (rng.chance(0.5) ? 1 : -1) * rng.float(11, 22)); if (spotFree(p.x, p.z, 1.8, 5)) { P({ kind: 'haystack', x: p.x, z: p.z, yaw: rng.float(0, TAU), keep: 2.2 }); col(p.x, p.z, 1.3); break; } }
      for (let t = 0; t < 20; t++) { const p = lat(rng.float(25, 120), (rng.chance(0.5) ? 1 : -1) * rng.float(6.5, 9)); if (spotFree(p.x, p.z, 1.8, 3)) { P({ kind: 'cart', x: p.x, z: p.z, yaw: p.yaw + rng.float(-0.6, 0.6), keep: 2.4 }); col(p.x, p.z, 1.3); break; } }
      // dry-stone field walls along the vale (patchy, gaps at POIs, branches and the stream)
      for (const side of [-1, 1]) {
        const base = rng.float(13, 16);
        for (let s = 8; s < 0.29 * L; s += 2.6) {
          const ln = noiseAt(s * 0.05 + side * 10);
          if (ln < -0.15 || Math.floor(s / 2.6) % 4 === 3) continue;   // short runs with gaps: nothing gets fenced in
          const l = side * (base + Math.sin(s / 37 + side) * 2.2);
          const p = lat(s, l);
          if (blocked(p.x, p.z, 1.6) || polyDist(st.xs, st.zs, p.x, p.z).d < 5 || branchDist(p.x, p.z) < 6) continue;
          P({ kind: 'drywall', x: p.x, z: p.z, yaw: p.yaw, len: 2.75, h: 0.95 + ln * 0.25 });
          colLine(lw({ x: p.x, z: p.z, yaw: p.yaw }, 0, -1.2).x, lw({ x: p.x, z: p.z, yaw: p.yaw }, 0, -1.2).z, lw({ x: p.x, z: p.z, yaw: p.yaw }, 0, 1.2).x, lw({ x: p.x, z: p.z, yaw: p.yaw }, 0, 1.2).z, 0.45, 1.2);
        }
      }
      // the ruined watchtower in the Whisperwood
      for (let t = 0; t < 40; t++) {
        const s = rng.float(0.36 * L, 0.6 * L), side = rng.chance(0.5) ? 1 : -1, p = lat(s, side * rng.float(15, 21));
        if (!spotFree(p.x, p.z, 5.5, 6)) continue;
        P({ kind: 'tower', x: p.x, z: p.z, yaw: p.yaw + side * Math.PI / 2, keep: 8 }); col(p.x, p.z, 4.0);
        break;
      }
      // the Fenmarsh boardwalk and its posts, and the boss ring of standing stones
      P({ kind: 'boardwalk', s0: 0.66 * L, s1: L - 34 });
      const boss = level.pois.find((p) => p.type === 'boss');
      if (boss) P({ kind: 'stonering', x: boss.x, z: boss.z, yaw: boss.yaw, R: 19 });
      if (boss) ringColliders(boss, 19, 13, 0.95, 0.38);
    } else if (act === 2) {
      const hs = def.hall * L;
      // cairns along the pass
      for (let s = 20, k = 0; s < hs - 30; s += rng.float(30, 44), k++) { const p = lat(s, (k % 2 ? 1 : -1) * 4.8); if (spotFree(p.x, p.z, 0.9, 0.4)) { P({ kind: 'cairn', x: p.x, z: p.z, yaw: rng.float(0, TAU), keep: 1.4 }); col(p.x, p.z, 0.7); } }
      // a ruined waystation of the Delvers
      for (let t = 0; t < 40; t++) { const s = rng.float(0.12 * L, 0.36 * L), side = rng.chance(0.5) ? 1 : -1, p = lat(s, side * rng.float(14, 19)); if (!spotFree(p.x, p.z, 4.5, 6)) continue; P({ kind: 'waystation', x: p.x, z: p.z, yaw: p.yaw + side * Math.PI / 2, keep: 6 }); col(p.x, p.z, 3.2); break; }
      // the Gate of Undervault
      const g = lat(hs, 0);
      P({ kind: 'gate2', x: g.x, z: g.z, yaw: g.yaw, s: hs });
      for (const side of [-1, 1]) { const a = lat(hs, side * 6.9), b = lat(hs, side * 10); colLine(a.x, a.z, b.x, b.z, 0.5, 0.8); }
      for (const side of [-1, 1]) { const b = lat(hs - 4, side * 5.2); P({ kind: 'brazier', x: b.x, z: b.z, yaw: 0, tall: true }); col(b.x, b.z, 0.55); }
      // halls: pillar rows with torches, ribs, channels' curbs
      for (let s = hs + 12, k = 0; s < L - 38; s += 12, k++) {
        for (const side of [-1, 1]) {
          const p = lat(s, side * 12);
          if (blocked(p.x, p.z, 1.6) || branchDist(p.x, p.z) < 4.5) continue;
          P({ kind: 'pillar', x: p.x, z: p.z, yaw: p.yaw, torch: (k % 2 === 0) ? side : 0, s });
          col(p.x, p.z, 1.2);
        }
        P({ kind: 'rib', s });
      }
      P({ kind: 'channels', s0: hs + 14, s1: L - 36 });
      for (let t = 0, n = 0; t < 40 && n < 8; t++) { const s = rng.float(hs + 16, L - 40), side = rng.chance(0.5) ? 1 : -1, p = lat(s, side * rng.float(20, 24)); if (blocked(p.x, p.z, 1.2) || branchDist(p.x, p.z) < 5) continue; P({ kind: 'rubble', x: p.x, z: p.z, yaw: rng.float(0, TAU), keep: 2 }); col(p.x, p.z, 1.4); n++; }
      const boss = level.pois.find((p) => p.type === 'boss');
      if (boss) { P({ kind: 'greathall', x: boss.x, z: boss.z, yaw: boss.yaw, R: 23.5 }); ringColliders(boss, 23.5, 10, 1.5, 0.45); }
    } else if (act === 3) {
      // the bones of something vast on the cinder plains
      for (let t = 0; t < 40; t++) { const s = rng.float(0.08 * L, 0.34 * L), side = rng.chance(0.5) ? 1 : -1, p = lat(s, side * rng.float(15, 22)); if (!spotFree(p.x, p.z, 7, 6)) continue; const yaw = p.yaw + rng.float(-0.5, 0.5); P({ kind: 'ribcage', x: p.x, z: p.z, yaw, keep: 8 }); for (let r = -3; r <= 3; r++) { for (const sd of [-1, 1]) { const q = lw({ x: p.x, z: p.z, yaw }, sd * 2.6, r * 1.6); col(q.x, q.z, 0.45); } } break; }
      // siegeworks: palisades, wrecks, broken walls, banners
      for (const side of [-1, 1]) {
        const base = rng.float(12, 15);
        for (let s = 0.4 * L; s < 0.75 * L; s += 2.2) {
          if (noiseAt(s * 0.06 + side * 7) < -0.05 || Math.floor(s / 2.2) % 4 === 3) continue;
          const p = lat(s, side * (base + Math.sin(s / 29) * 1.5));
          if (blocked(p.x, p.z, 1.2) || branchDist(p.x, p.z) < 5 || nearFissure(p.x, p.z, 1)) continue;
          P({ kind: 'palisade', x: p.x, z: p.z, yaw: p.yaw, side }); col(p.x, p.z, 0.6);
        }
      }
      const wrecks = ['siegetower', 'trebuchet', 'ruinwall', 'ruinwall', 'siegetower', 'wagon'];
      for (const kind of wrecks) for (let t = 0; t < 30; t++) {
        const s = rng.float(0.36 * L, 0.8 * L), side = rng.chance(0.5) ? 1 : -1, p = lat(s, side * rng.float(17, 26));
        if (!spotFree(p.x, p.z, 4, 5) || nearFissure(p.x, p.z, 3)) continue;
        P({ kind, x: p.x, z: p.z, yaw: p.yaw + rng.float(-0.8, 0.8), keep: 5 }); col(p.x, p.z, kind === 'ruinwall' ? 2.2 : 2.8);
        break;
      }
      for (let t = 0, n = 0; t < 30 && n < 6; t++) { const p = lat(rng.float(0.3 * L, 0.9 * L), (rng.chance(0.5) ? 1 : -1) * rng.float(6, 10)); if (!spotFree(p.x, p.z, 0.8, 2.5)) continue; P({ kind: 'warbanner', x: p.x, z: p.z, yaw: p.yaw + rng.float(-0.4, 0.4), keep: 1.2 }); col(p.x, p.z, 0.3); n++; }
      // the Gate of Mount Cindral (beyond the road's end cap) and its pylons
      const end = lat(mainN - 1, 0);
      P({ kind: 'gate3', x: end.x + Math.sin(end.yaw) * 9.5, z: end.z + Math.cos(end.yaw) * 9.5, yaw: end.yaw });
      for (const side of [-1, 1]) { const p = lat(mainN - 3, side * 10.5); P({ kind: 'pylon', x: p.x, z: p.z, yaw: p.yaw }); col(p.x, p.z, 1.6); }
      const boss3 = level.pois.find((p) => p.type === 'boss');
      if (boss3) for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + 0.52; if (Math.abs(U.wrapAngle(a - Math.PI)) < 0.6) continue; const q = lw(boss3, Math.sin(a) * 20.5, Math.cos(a) * 20.5); P({ kind: 'brazier', x: q.x, z: q.z, yaw: 0, tall: true }); col(q.x, q.z, 0.55); }
      P({ kind: 'volcano', x: end.x + Math.sin(end.yaw) * 420, z: end.z + Math.cos(end.yaw) * 420 });
    } else if (act === 'forge') {
      P({ kind: 'causeway', s0: 0, s1: L });
      const end = lat(L - 6, 0);
      P({ kind: 'forgemouth', x: end.x, z: end.z, yaw: end.yaw });
    }
  }
  function ringColliders(poi, R, n, r, gapA) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.15;
      if (Math.abs(U.wrapAngle(a)) < gapA || Math.abs(U.wrapAngle(a - Math.PI)) < gapA) continue;
      const q = lw(poi, Math.sin(a) * R, Math.cos(a) * R);
      col(q.x, q.z, r);
    }
  }
  let noiseL = null;
  function noiseAt(t) { if (!noiseL) noiseL = new AB.addons.SimplexNoise({ random: AB.rng('noiseL').next.bind(AB.rng('noiseL')) }); return noiseL.noise(t, 0.37); }
  function branchDist(x, z) { let best = 1e9; for (let k = mainN; k < samples.n; k++) { const d = Math.hypot(samples.x[k] - x, samples.z[k] - z); if (d < best) best = d; } return best; }

  // ------------------------------------------------------------------------------- piece builders (visual only)
  function buildPieces(act, group) {
    const stone = MAT.tex('stone', act === 2 ? 0xa8aab0 : act === 3 ? 0x5a4a44 : 0xc8c0b0);
    const darkStone = MAT.tex('stone', 0x6a6460);
    const wood = MAT.tex('wood', act === 3 ? 0x4a3a30 : 0xb0a090);
    const plaster = MAT.tex('plaster');
    const thatch = MAT.tex('thatch');
    const cobble = MAT.tex('cobble', act === 2 ? 0xb0b0b4 : 0xc0b8a8);
    const carving = MAT.tex('carving', 0xb8b0a4);
    const basalt = MAT.tex('basalt', 0x8a8080, 0.8);
    const metal = MAT.tex('metal', 0x6a6460, 1);
    const cloth = MAT.tex('cloth', 0x8a7a64);
    const rockM = MAT.rock(act);
    const windowGlow = MAT.glow(0xffa04a, 2.2);
    for (const pc of pieces) {
      const y0 = heightAt(pc.x || 0, pc.z || 0);
      switch (pc.kind) {
        case 'signpost': {
          addStatic(cylGeo(0.09, 0.08, 2.2, 6, 1), act === 2 ? stone : wood, pc.x, y0 + 1.0, pc.z);
          if (act === 2) { addStatic(boxGeo(0.5, 1.6, 0.35, 1), stone, pc.x, y0 + 0.8, pc.z, pc.yaw); addStatic(boxGeo(0.62, 0.2, 0.45, 1), stone, pc.x, y0 + 1.7, pc.z, pc.yaw); }
          else if (act === 3) addBanner(group, pc.x, y0, pc.z, pc.yaw, 0x5a1a12, 2.8);
          else for (const k of [0, 1]) addStatic(boxGeo(1.1, 0.22, 0.05, 1), wood, pc.x + Math.sin(pc.yaw + k * 0.9) * 0.35, y0 + 1.75 - k * 0.32, pc.z + Math.cos(pc.yaw + k * 0.9) * 0.35, pc.yaw + k * 0.9 + Math.PI / 2);
          break;
        }
        case 'bridge': {
          const st = feat.stream;
          const w = 6.6, len = 12.5;
          const deckY = baseAt(st.s);
          const g = archWallGeo(len, 0.5, w, 0, 0, 2.5, 0.55);
          addStatic(g, stone, pc.x, deckY - 0.5, pc.z, pc.yaw + Math.PI / 2);
          const arch = archWallGeo(len, 1.6, w - 0.4, 5.2, 0.1, 2.5);
          addStatic(arch, stone, pc.x, deckY - 2.1, pc.z, pc.yaw + Math.PI / 2);
          for (const side of [-1, 1]) {
            const pg = archWallGeo(len, 0.7, 0.42, 0, 0, 2, 0.55);
            const q = lw(pc, side * (w / 2 - 0.15), 0);
            addStatic(pg, stone, q.x, deckY + 0.02, q.z, pc.yaw + Math.PI / 2);
            for (const e of [-1, 1]) { const qq = lw(pc, side * (w / 2 - 0.1), e * len / 2); addStatic(boxGeo(0.7, 1.1, 0.7, 1), stone, qq.x, deckY + 0.3, qq.z, pc.yaw); }
          }
          break;
        }
        case 'cottage': buildCottage(pc, stone, plaster, thatch, wood, windowGlow); break;
        case 'well': {
          addStatic(cylGeo(1.0, 1.0, 0.9, 14, 1.5, true), stone, pc.x, y0 + 0.4, pc.z);
          addStatic(cylGeo(0.82, 0.82, 0.9, 14, 1.5, true), stone, pc.x, y0 + 0.4, pc.z);
          addStatic(cylGeo(0.85, 0.85, 0.06, 14), MAT.plain(0x060808, 0.1), pc.x, y0 + 0.2, pc.z);
          for (const sd of [-1, 1]) { const q = lw(pc, sd * 0.9, 0); addStatic(boxGeo(0.14, 2.3, 0.14, 1), wood, q.x, y0 + 1.15, q.z, pc.yaw); }
          addStatic(roofGeo(1.6, 1.2, 0.6, 0.15, 0.08), thatch, pc.x, y0 + 2.3, pc.z, pc.yaw + Math.PI / 2);
          addStatic(cylGeo(0.07, 0.07, 1.8, 6), wood, pc.x, y0 + 1.7, pc.z, pc.yaw, 1, 1, 1, { rz: Math.PI / 2 });
          break;
        }
        case 'haystack': {
          const g = new T.SphereGeometry(1.4, 12, 8, 0, TAU, 0, Math.PI / 2); scaleUV(g, 3);
          addStatic(g, thatch, pc.x, y0 - 0.1, pc.z, pc.yaw, 1, 1.15, 1);
          break;
        }
        case 'cart': buildCart(pc, y0, wood, metal); break;
        case 'drywall': {
          const rngW = AB.rng('dw' + pc.x.toFixed(1));
          addStatic(boxGeo(0.75, pc.h, pc.len, 1.2), stone, pc.x, y0 + pc.h / 2 - 0.1, pc.z, pc.yaw + rngW.float(-0.03, 0.03), 1, 1, 1, { rz: rngW.float(-0.03, 0.03) });
          for (let k = 0; k < 3; k++) { const q = lw(pc, rngW.float(-0.1, 0.1), -0.9 + k * 0.9); addStatic(rockGeo(0, 'chunk', true), rockM, q.x, y0 + pc.h - 0.05, q.z, rngW.float(0, TAU), 0.32, 0.18, 0.32); }
          aoSplat(pc.x, pc.z, 1.8, 0.25);
          break;
        }
        case 'tower': buildTower(pc, y0, stone, wood, rockM); break;
        case 'boardwalk': {
          const rngB = AB.rng('boardwalk');
          for (let s = pc.s0; s < pc.s1; s += 0.62) {
            const p = lat(s, 0);
            if (level.pois.some((q) => q.type === 'boss' && Math.hypot(q.x - p.x, q.z - p.z) < 21)) continue;
            const y = heightAt(p.x, p.z);
            addStatic(boxGeo(0.52, 0.09, 3.6 + rngB.float(-0.3, 0.4), 0.8), wood, p.x + rngB.float(-0.08, 0.08), y + 0.05, p.z, p.yaw + Math.PI / 2 + rngB.float(-0.05, 0.05), 1, 1, 1, { cast: false });
            if (Math.round(s / 0.62) % 5 === 0) for (const sd of [-1, 1]) { const q = lat(s, sd * 1.95); addStatic(cylGeo(0.07, 0.08, 1.1, 5, 1), wood, q.x, heightAt(q.x, q.z) + 0.25, q.z, 0, 1, 1, 1, { rx: rngB.float(-0.15, 0.15) }); }
          }
          break;
        }
        case 'stonering': buildStoneRing(pc, rockM); break;
        case 'cairn': {
          const rngC = AB.rng('cairn' + pc.x.toFixed(1));
          let y = y0 - 0.1;
          for (let k = 0; k < 5; k++) { const s = 0.62 - k * 0.1; addStatic(rockGeo(0, 'boulder', true), rockM, pc.x + rngC.float(-0.06, 0.06), y + s * 0.6, pc.z + rngC.float(-0.06, 0.06), rngC.float(0, TAU), s, s * 0.8, s); y += s * 0.85; }
          break;
        }
        case 'waystation': buildWaystation(pc, y0, stone, carving, rockM); break;
        case 'gate2': buildGate2(pc, stone, carving, darkStone, metal, group); break;
        case 'brazier': addBrazier(pc.x, y0, pc.z, metal, stone, pc.tall); break;
        case 'pillar': buildPillar(pc, stone, carving, metal); break;
        case 'rib': buildRib(pc, stone); break;
        case 'channels': buildChannels(pc, stone); break;
        case 'rubble': {
          const rngR = AB.rng('rub' + pc.x.toFixed(1));
          for (let k = 0; k < 6; k++) { const q = lw(pc, rngR.float(-1.6, 1.6), rngR.float(-1.6, 1.6)); addStatic(rockGeo(0, 'chunk', true), rockM, q.x, heightAt(q.x, q.z) + 0.1, q.z, rngR.float(0, TAU), rngR.float(0.35, 0.9)); }
          const q = lw(pc, 0.5, 0.2);
          addStatic(cylGeo(0.95, 0.95, 1.6, 8, 2), stone, q.x, heightAt(q.x, q.z) + 0.85, q.z, pc.yaw, 1, 1, 1, { rz: Math.PI / 2 });
          break;
        }
        case 'greathall': buildGreatHall(pc, stone, carving, metal, rockM); break;
        case 'ribcage': buildRibcage(pc, y0); break;
        case 'palisade': {
          const rngP = AB.rng('pal' + pc.x.toFixed(1));
          for (let k = -1; k <= 1; k++) {
            const q = lw(pc, rngP.float(-0.1, 0.1), k * 0.7);
            const h = rngP.float(1.8, 2.8), lean = -pc.side * rngP.float(0.15, 0.35);
            addStatic(cylGeo(0.13, 0.13, h, 6, 1), wood, q.x, heightAt(q.x, q.z) + h / 2 - 0.3, q.z, pc.yaw, 1, 1, 1, { rz: lean });
            addStatic(new T.ConeGeometry(0.13, 0.4, 6), wood, q.x - Math.cos(pc.yaw) * Math.sin(lean) * h * 0.5, heightAt(q.x, q.z) + h - 0.1, q.z + Math.sin(pc.yaw) * Math.sin(lean) * h * 0.5, pc.yaw, 1, 1, 1, { rz: lean });
          }
          addStatic(cylGeo(0.08, 0.08, 2.4, 5, 1), wood, pc.x, heightAt(pc.x, pc.z) + 0.8, pc.z, pc.yaw, 1, 1, 1, { rx: Math.PI / 2 });
          break;
        }
        case 'siegetower': buildSiegeTower(pc, y0, wood, metal); break;
        case 'trebuchet': buildTrebuchet(pc, y0, wood, metal); break;
        case 'ruinwall': buildRuinWall(pc, y0, stone, rockM); break;
        case 'wagon': buildCart(pc, y0, wood, metal, true); break;
        case 'warbanner': addBanner(group, pc.x, y0, pc.z, pc.yaw, 0x4a1410, 4.2); break;
        case 'gate3': buildGate3(pc, basalt, metal, group); break;
        case 'pylon': buildPylon(pc, y0, basalt, metal); break;
        case 'volcano': buildVolcano(pc, group); break;
        case 'causeway': buildCauseway(pc, cobble, basalt, metal); break;
        case 'forgemouth': buildForgeMouth(pc, basalt, metal, group); break;
        default: break;
      }
    }
  }
  function scaleUV(g, k) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k); return g; }

  function buildCottage(pc, stone, plaster, thatch, wood, glow) {
    const y0 = Math.min(heightAt(pc.x, pc.z), ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const q = lw(pc, a * pc.w / 2, b * pc.d / 2); return heightAt(q.x, q.z); }));
    const wallH = 2.7, rise = 2.5;
    // plinth + walls (stone lower course, limewashed upper)
    addStatic(boxGeo(pc.w + 0.3, 0.9, pc.d + 0.3, 1.5), stone, pc.x, y0 + 0.3, pc.z, pc.yaw);
    addStatic(boxGeo(pc.w, wallH - 0.9, pc.d, 2.2), pc.v % 2 ? plaster : stone, pc.x, y0 + 0.75 + (wallH - 0.9) / 2, pc.z, pc.yaw);
    // gables (along local X ends) and roof (ridge along local X)
    for (const sd of [-1, 1]) { const q = lw(pc, sd * pc.w / 2, 0); addStatic(gableGeo(pc.d, rise, 2), pc.v % 2 ? plaster : stone, q.x, y0 + wallH, q.z, pc.yaw + Math.PI / 2); }
    addStatic(roofGeo(pc.d, pc.w, rise, 0.55, 0.35, 1.6), thatch, pc.x, y0 + wallH, pc.z, pc.yaw + Math.PI / 2);
    // chimney
    const ch = lw(pc, pc.w / 2 - 0.9, 0.2);
    addStatic(boxGeo(0.9, wallH + rise + 0.9, 0.9, 1.2), stone, ch.x, y0 + (wallH + rise + 0.9) / 2, ch.z, pc.yaw);
    emit.smoke.push({ x: ch.x, y: y0 + wallH + rise + 1.0, z: ch.z, size: 1.1, height: 9, rate: 0.35, color: 0x8a8a88 });
    // door + windows facing the road (+Z local)
    const door = lw(pc, -0.8, pc.d / 2 + 0.02);
    addStatic(boxGeo(1.0, 1.9, 0.12, 1), wood, door.x, y0 + 0.95 + 0.3, door.z, pc.yaw);
    for (const wx of [0.9, 2.2]) {
      if (wx > pc.w / 2 - 0.6) continue;
      const q = lw(pc, wx, pc.d / 2 + 0.03);
      addStatic(boxGeo(0.75, 0.7, 0.06, 1), glow, q.x, y0 + 1.6, q.z, pc.yaw, 1, 1, 1, { cast: false });
      addStatic(boxGeo(0.95, 0.12, 0.2, 1), wood, q.x, y0 + 1.22, q.z, pc.yaw);
      lightSources.push({ x: lw(pc, wx, pc.d / 2 + 1.0).x, y: y0 + 1.6, z: lw(pc, wx, pc.d / 2 + 1.0).z, color: new T.Color(0xff9a40), i: 5, range: 7, flick: 0.08, seed: q.x });
    }
    const bw = lw(pc, -pc.w / 2 - 0.02, 0);
    addStatic(boxGeo(0.06, 0.6, 0.6, 1), glow, bw.x, y0 + 1.6, bw.z, pc.yaw, 1, 1, 1, { cast: false });
    // garden fence
    const rngF = AB.rng('fence' + pc.v);
    if (rngF.chance(0.7)) {
      const fz = pc.d / 2 + 3.2;
      for (let k = -3; k <= 3; k++) {
        if (k === -1) continue;
        const q = lw(pc, k * 1.4, fz);
        addStatic(boxGeo(0.12, 1.0, 0.12, 1), MAT.tex('wood', 0x8a7a68), q.x, heightAt(q.x, q.z) + 0.45, q.z, pc.yaw + rngF.float(-0.08, 0.08));
        if (k < 3 && k !== -2) { const r = lw(pc, k * 1.4 + 0.7, fz); addStatic(boxGeo(1.5, 0.08, 0.06, 1), MAT.tex('wood', 0x8a7a68), r.x, heightAt(r.x, r.z) + 0.7, r.z, pc.yaw); addStatic(boxGeo(1.5, 0.08, 0.06, 1), MAT.tex('wood', 0x8a7a68), r.x, heightAt(r.x, r.z) + 0.35, r.z, pc.yaw); }
      }
    }
    // barrels by the door
    const bq = lw(pc, -2.0, pc.d / 2 + 0.7);
    addBarrel(bq.x, heightAt(bq.x, bq.z), bq.z, wood);
    aoSplat(pc.x, pc.z, Math.max(pc.w, pc.d) * 0.9, 0.35);
  }
  function addBarrel(x, y, z, wood) {
    addStatic(cylGeo(0.36, 0.4, 0.95, 10, 1), wood, x, y + 0.47, z);
    for (const hy of [0.18, 0.78]) addStatic(cylGeo(0.42, 0.42, 0.06, 10, 1, true), MAT.tex('metal', 0x5a5450, 1), x, y + hy, z);
  }
  function buildCart(pc, y0, wood, metal, burnt) {
    const w = burnt ? MAT.tex('wood', 0x2a221e) : wood;
    addStatic(boxGeo(1.5, 0.12, 2.8, 1), w, pc.x, y0 + 0.75, pc.z, pc.yaw, 1, 1, 1, { rz: burnt ? 0.18 : 0 });
    for (const sd of [-1, 1]) { const q = lw(pc, sd * 0.72, 0); addStatic(boxGeo(0.08, 0.45, 2.8, 1), w, q.x, y0 + 1.0, q.z, pc.yaw); }
    for (const [sx, sz] of [[-0.85, 0.8], [0.85, 0.8], [-0.85, -0.8], [0.85, -0.8]]) {
      if (burnt && sx > 0 && sz > 0) continue;
      const q = lw(pc, sx, sz);
      const g = new T.TorusGeometry(0.48, 0.06, 5, 12); scaleUV(g, 1);
      addStatic(g, w, q.x, y0 + 0.5, q.z, pc.yaw + Math.PI / 2);
      addStatic(cylGeo(0.04, 0.04, 0.9, 4), w, q.x, y0 + 0.5, q.z, pc.yaw, 1, 1, 1, { rx: Math.PI / 2 });
    }
    const sh = lw(pc, 0, 2.1);
    addStatic(boxGeo(0.08, 0.08, 1.8, 1), w, sh.x, y0 + 0.45, sh.z, pc.yaw, 1, 1, 1, { rx: 0.25 });
    if (!burnt) { const q = lw(pc, 0.2, -0.4); addStatic(boxGeo(0.7, 0.55, 0.7, 1), wood, q.x, y0 + 1.1, q.z, pc.yaw + 0.3); }
  }
  function buildTower(pc, y0, stone, wood, rockM) {
    const R = 3.4, H = 11;
    const g = new T.CylinderGeometry(R, R + 0.4, H, 20, 6, true, 0.5, TAU - 0.9);
    // jagged, broken top
    const p = g.attributes.position, rngT = AB.rng('tower');
    for (let i = 0; i < p.count; i++) { if (p.getY(i) > H / 2 - 0.1) { const a = Math.atan2(p.getX(i), p.getZ(i)); p.setY(i, H / 2 - (Math.sin(a * 3) * 0.5 + 0.5) * 3.5 - rngT.float(0, 0.8)); } }
    g.computeVertexNormals(); scaleUV(g, 0.5);
    addStatic(g, stone, pc.x, y0 + H / 2 - 0.5, pc.z, pc.yaw);
    const gi = new T.CylinderGeometry(R - 0.5, R - 0.1, H - 1, 18, 1, true, 0.5, TAU - 0.9); gi.scale(-1, 1, 1); scaleUV(gi, 0.5);
    addStatic(gi, stone, pc.x, y0 + H / 2 - 1, pc.z, pc.yaw);
    for (let k = 0; k < 10; k++) { const q = lw(pc, rngT.float(-6, 6), rngT.float(-6, 6)); if (Math.hypot(q.x - pc.x, q.z - pc.z) < R + 0.5) continue; addStatic(rockGeo(0, 'chunk', true), rockM, q.x, heightAt(q.x, q.z), q.z, rngT.float(0, TAU), rngT.float(0.3, 0.8)); }
    for (let k = 0; k < 3; k++) addStatic(boxGeo(0.25, 0.25, R * 1.8, 1), wood, pc.x, y0 + 3.4 + k * 2.4, pc.z, pc.yaw + k * 1.1);
    aoSplat(pc.x, pc.z, R + 2, 0.4);
  }
  function buildStoneRing(pc, rockM) {
    const rngS = AB.rng('ring');
    const n = 13;
    const stoneM = MAT.tex('rock', 0x9a968a);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.15;
      if (Math.abs(U.wrapAngle(a)) < 0.38 || Math.abs(U.wrapAngle(a - Math.PI)) < 0.38) continue;
      const q = lw(pc, Math.sin(a) * pc.R, Math.cos(a) * pc.R);
      const y = heightAt(q.x, q.z);
      const h = rngS.float(3.4, 5.2);
      const fallen = i === 4;
      const g = rockGeo(i % 2, 'spire');
      addStatic(g, stoneM, q.x, fallen ? y + 0.5 : y + h * 0.42, q.z, pc.yaw + a + rngS.float(-0.2, 0.2), 1.0, fallen ? 1.1 : h / 3.2, 0.75, { rx: fallen ? 1.45 : rngS.float(-0.06, 0.06), rz: rngS.float(-0.06, 0.06) });
      if (i % 3 === 1 && !fallen) { const b = (i + 1) / n * TAU + 0.15; const q2 = lw(pc, Math.sin((a + b) / 2) * pc.R, Math.cos((a + b) / 2) * pc.R); addStatic(boxGeo(1.0, 0.8, 4.4, 1.5), stoneM, q2.x, y + h * 0.84 + 0.35, q2.z, pc.yaw + (a + b) / 2 + Math.PI / 2); }
      aoSplat(q.x, q.z, 2.4, 0.3);
    }
    // the low altar stone at the centre (flat, walkable over)
    addStatic(rockGeo(0, 'slab'), stoneM, pc.x + Math.sin(pc.yaw) * -6, heightAt(pc.x, pc.z) - 0.2, pc.z + Math.cos(pc.yaw) * -6, pc.yaw, 1.4, 0.5, 1.0);
    emit.mist.push({ x: pc.x, z: pc.z, r: 16, n: 10 });
  }
  function buildWaystation(pc, y0, stone, carving, rockM) {
    const archG = archWallGeo(5, 4.4, 0.9, 2.6, 2.2, 2);
    addStatic(archG, stone, pc.x, y0 - 0.3, pc.z, pc.yaw);
    const rngW = AB.rng('ways');
    for (const [lx, lz, w, h, ry] of [[-3.4, -2.5, 0.8, 2.6, Math.PI / 2], [3.3, -2.0, 0.8, 1.6, Math.PI / 2], [0, -4.6, 5.6, 1.2, 0]]) {
      const q = lw(pc, lx, lz);
      addStatic(boxGeo(w, h, 3.8, 1.5), stone, q.x, heightAt(q.x, q.z) + h / 2 - 0.3, q.z, pc.yaw + ry);
    }
    for (let k = 0; k < 7; k++) { const q = lw(pc, rngW.float(-4, 4), rngW.float(-5, 2)); addStatic(rockGeo(0, 'chunk', true), rockM, q.x, heightAt(q.x, q.z), q.z, rngW.float(0, TAU), rngW.float(0.3, 0.7)); }
    const q = lw(pc, 0, -1.2);
    addStatic(boxGeo(1.4, 0.9, 0.9, 1), carving, q.x, heightAt(q.x, q.z) + 0.3, q.z, pc.yaw);
  }
  function buildGate2(pc, stone, carving, darkStone, metal, group) {
    const fl = baseAt(def.hall * def.length);
    // facade across the pass with the great arched door
    const g = archWallGeo(64, 44, 4, 13, 12, 3);
    addStatic(g, stone, pc.x, fl - 4, pc.z, pc.yaw);
    // carved bands, lintel and buttresses
    for (const y of [17.5, 24]) addStatic(boxGeo(30, 2.2, 0.6, 2.2), carving, pc.x - Math.sin(pc.yaw) * 2.2, fl + y, pc.z - Math.cos(pc.yaw) * 2.2, pc.yaw);
    for (const sd of [-1, 1]) {
      for (const k of [1, 2]) { const q = lw(pc, sd * (7.5 + k * 5.5), -2.6); addStatic(boxGeo(2.6, 34, 2.4, 3), darkStone, q.x, fl + 13, q.z, pc.yaw); }
      // the guardians: hooded Delver wardens leaning on great hammers
      const q = lw(pc, sd * 9.8, -7.5);
      const by = heightAt(q.x, q.z);
      addStatic(boxGeo(4.4, 2.0, 4.4, 2), stone, q.x, by + 0.6, q.z, pc.yaw);
      addStatic(cylGeo(2.0, 1.4, 7.5, 8, 3), stone, q.x, by + 5.3, q.z, pc.yaw);
      addStatic(boxGeo(4.6, 1.6, 2.6, 2), stone, q.x, by + 9.3, q.z, pc.yaw);
      const hg = new T.SphereGeometry(1.25, 10, 8, 0, TAU, 0, Math.PI * 0.62); scaleUV(hg, 2);
      addStatic(hg, stone, q.x, by + 10.0, q.z, pc.yaw, 1, 1.25, 1);
      addStatic(boxGeo(1.1, 1.0, 0.4, 1), MAT.plain(0x0a0a0c, 1), lw(pc, sd * 9.8, -6.6).x, by + 10.3, lw(pc, sd * 9.8, -6.6).z, pc.yaw);
      const hm = lw(pc, sd * 9.8, -5.6);
      addStatic(cylGeo(0.3, 0.3, 8.5, 6, 2), darkStone, hm.x, by + 4.4, hm.z, pc.yaw);
      addStatic(boxGeo(2.6, 1.5, 1.5, 1.5), darkStone, hm.x, by + 0.85, hm.z, pc.yaw);
    }
    // the fallen door slab and stairs
    const ds = lw(pc, 7.4, 6);
    addStatic(boxGeo(5.2, 0.7, 9, 2), MAT.tex('metal', 0x4a4440, 1), ds.x, heightAt(ds.x, ds.z) + 0.2, ds.z, pc.yaw + 0.25, 1, 1, 1, { rz: 0.08 });
    for (let k = 0; k < 4; k++) { const q = lw(pc, 0, 1.0 + k * 0.9); addStatic(boxGeo(11, 0.25, 0.9, 1.5), stone, q.x, heightAt(q.x, q.z) - 0.12, q.z, pc.yaw, 1, 1, 1, { cast: false }); }
    emit.shafts.push({ x: pc.x, y: fl + 9, z: pc.z, yaw: pc.yaw, w: 8, h: 18, tilt: -0.5, color: 0x9ab0d8, a: 0.5 });
  }
  function addBrazier(x, y, z, metal, stone, tall) {
    const h = tall ? 1.4 : 0.9;
    addStatic(cylGeo(0.12, 0.2, h, 6, 1), metal, x, y + h / 2, z);
    const bowl = new T.CylinderGeometry(0.55, 0.3, 0.45, 10, 1, true); scaleUV(bowl, 1);
    addStatic(bowl, metal, x, y + h + 0.1, z);
    addStatic(cylGeo(0.5, 0.5, 0.06, 10), MAT.glow(0xff6a1a, 3), x, y + h + 0.25, z, 0, 1, 1, 1, { cast: false });
    emit.flames.push({ x, y: y + h + 0.32, z, w: 0.9, h: 1.5, seed: x * 3.1 + z, k: 1 });
    emit.embers.push({ x, y: y + h + 0.6, z, r: 0.4, n: 10 });
    lightSources.push({ x, y: y + h + 1.0, z, color: new T.Color(0xff8a3a), i: 45, range: 18, flick: 0.22, seed: x + z });
  }
  function buildPillar(pc, stone, carving, metal) {
    const fl = heightAt(pc.x, pc.z), top = Math.min(ceilingAt(pc.x, pc.z), fl + 24) + 0.6;
    const H = top - fl;
    addStatic(boxGeo(2.6, 1.1, 2.6, 1.3), stone, pc.x, fl + 0.5, pc.z, pc.yaw);
    addStatic(cylGeo(1.0, 0.92, H - 3, 8, 2), stone, pc.x, fl + 1 + (H - 3) / 2, pc.z, pc.yaw + Math.PI / 8);
    addStatic(boxGeo(2.1, 1.0, 2.1, 1.5), carving, pc.x, fl + 3.2, pc.z, pc.yaw);
    addStatic(boxGeo(2.8, 2.0, 2.8, 2), stone, pc.x, top - 1.2, pc.z, pc.yaw);
    aoSplat(pc.x, pc.z, 2.6, 0.35);
    if (pc.torch) {
      const t = lw(pc, -pc.torch * 1.15, 0);
      const y = fl + 3.6;
      addStatic(boxGeo(0.18, 0.5, 0.18, 1), metal, t.x, y, t.z, pc.yaw, 1, 1, 1, { rz: pc.torch * 0.4 });
      const ft = lw(pc, -pc.torch * 1.35, 0);
      addStatic(cylGeo(0.09, 0.06, 0.5, 6, 1), MAT.tex('wood', 0x4a3a2a), ft.x, y + 0.3, ft.z);
      emit.flames.push({ x: ft.x, y: y + 0.62, z: ft.z, w: 0.55, h: 0.95, seed: pc.s + pc.torch, k: 1 });
      emit.embers.push({ x: ft.x, y: y + 0.8, z: ft.z, r: 0.15, n: 5 });
      lightSources.push({ x: lw(pc, -pc.torch * 2.2, 0).x, y: y + 0.8, z: lw(pc, -pc.torch * 2.2, 0).z, color: new T.Color(0xff8a3a), i: 32, range: 16, flick: 0.2, seed: pc.s * 3 + pc.torch });
    }
  }
  function buildRib(pc, stone) {
    // an arch rib across the hall following the vault, from pillar row to pillar row
    const pts = [];
    for (let l = -12; l <= 12; l += 2) { const p = lat(pc.s, l); pts.push(new V3(p.x, Math.min(ceilingAt(p.x, p.z), heightAt(p.x, p.z) + 24) - 0.25, p.z)); }
    const b = new GB();
    tube(b, pts, pts.map(() => 0.55), 4, 2);
    addStatic(b.geo(), stone, 0, 0, 0, 0, 1, 1, 1, { chunk: Math.floor(pc.s / CHUNK_S), cast: false });
  }
  function buildChannels(pc, stone) {
    for (let s = Math.ceil(pc.s0); s < pc.s1; s += 4) {
      for (const side of [-1, 1]) for (const l of [13.8, 18.7]) {
        const p = lat(s, side * l);
        if (branchDist(p.x, p.z) < 4.5) continue;
        addStatic(boxGeo(0.5, 0.45, 4.05, 1.2), stone, p.x, baseAt(def.hall * def.length) + 0.1, p.z, p.yaw, 1, 1, 1, { cast: false });
      }
    }
  }
  function buildGreatHall(pc, stone, carving, metal, rockM) {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.15;
      if (Math.abs(U.wrapAngle(a)) < 0.45 || Math.abs(U.wrapAngle(a - Math.PI)) < 0.45) continue;
      const q = lw(pc, Math.sin(a) * pc.R, Math.cos(a) * pc.R);
      buildPillar({ x: q.x, z: q.z, yaw: pc.yaw + a, torch: 0, s: 0 }, stone, carving, metal);
      if (i % 2 === 0) { const b = lw(pc, Math.sin(a) * (pc.R - 3.2), Math.cos(a) * (pc.R - 3.2)); addBrazier(b.x, heightAt(b.x, b.z), b.z, metal, stone, false); }
    }
    // floor ring inlay
    const ring = new T.RingGeometry(9, 10.2, 48, 1).rotateX(-Math.PI / 2);
    addStatic(ring, MAT.tex('metal', 0x5a4a38, 1), pc.x, heightAt(pc.x, pc.z) + 0.03, pc.z, 0, 1, 1, 1, { cast: false });
    // the seated king, carved into the end wall
    const k = lw(pc, 0, -23.5);
    const by = heightAt(pc.x, pc.z);
    addStatic(boxGeo(9, 3, 6, 2), stone, k.x, by + 1.5, k.z, pc.yaw);
    addStatic(boxGeo(7, 9, 4.5, 3), stone, k.x, by + 7.5, k.z, pc.yaw);
    addStatic(boxGeo(9.5, 3.2, 4.8, 2), carving, k.x, by + 12.5, k.z, pc.yaw);
    const hd = lw(pc, 0, -22.8);
    const hg = new T.SphereGeometry(2.1, 12, 10); scaleUV(hg, 2);
    addStatic(hg, stone, hd.x, by + 16, hd.z, pc.yaw, 1, 1.2, 1);
    addStatic(boxGeo(3.2, 3.4, 1.6, 2), stone, lw(pc, 0, -21.6).x, by + 13.8, lw(pc, 0, -21.6).z, pc.yaw);
    for (const sd of [-1, 1]) { const q = lw(pc, sd * 3.8, -21.4); addStatic(boxGeo(1.6, 1.4, 5.5, 2), stone, q.x, by + 7.5, q.z, pc.yaw); }
    emit.shafts.push({ x: pc.x, y: by + 14, z: pc.z, yaw: pc.yaw, w: 7, h: 26, tilt: 0.12, color: 0xa8c0e0, a: 0.55 });
  }
  function buildRibcage(pc, y0) {
    const bone = MAT.tex('plaster', 0xb8ac98, 0.8);
    const b = new GB();
    const spine = [];
    for (let k = -6; k <= 6; k++) { const q = lw(pc, 0, k * 1.6); spine.push(new V3(q.x, heightAt(q.x, q.z) + 4.6 - Math.abs(k) * 0.15, q.z)); }
    tube(b, spine, spine.map(() => 0.42), 6, 1);
    for (let k = -3; k <= 3; k++) for (const sd of [-1, 1]) {
      const pts = [];
      for (let t = 0; t <= 6; t++) {
        const a = (t / 6) * Math.PI * 0.62;
        const q = lw(pc, sd * Math.sin(a) * 3.1, k * 1.6 + Math.sin(a) * 0.3);
        pts.push(new V3(q.x, spine[k + 6].y - (1 - Math.cos(a)) * 5.2, q.z));
      }
      tube(b, pts, pts.map((p, i) => U.lerp(0.32, 0.12, i / 6)), 5, 1);
    }
    const skull = lw(pc, 0, 11.5);
    const sg = rockGeo(1, 'boulder');
    addStatic(b.geo(), bone, 0, 0, 0, 0, 1, 1, 1, { chunk: chunkOfXZ(pc.x, pc.z) });
    addStatic(sg, bone, skull.x, heightAt(skull.x, skull.z) + 0.6, skull.z, pc.yaw, 1.6, 1.0, 2.4);
  }
  function buildSiegeTower(pc, y0, wood, metal) {
    const w = MAT.tex('wood', 0x3a2c24);
    const H = 9, lean = 0.22;
    for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) { const q = lw(pc, lx, lz); addStatic(boxGeo(0.35, H, 0.35, 1), w, q.x, y0 + H / 2 - 0.4, q.z, pc.yaw, 1, 1, 1, { rz: lean }); }
    for (let y = 1.5; y < H; y += 2.4) for (const lz of [-1.6, 1.6]) { const q = lw(pc, y * Math.sin(lean) * 0.5, lz); addStatic(boxGeo(3.5, 0.25, 0.25, 1), w, q.x, y0 + y, q.z, pc.yaw, 1, 1, 1, { rz: lean * 0.2 }); }
    for (let y = 2.5; y < H; y += 3) { const q = lw(pc, y * Math.sin(lean) * 0.5, 0); addStatic(boxGeo(3.4, 0.12, 3.4, 1), w, q.x, y0 + y, q.z, pc.yaw + 0.05, 1, 1, 1, { rz: lean + 0.1 }); }
    for (const sd of [-1, 1]) { const q = lw(pc, sd * 1.9, 1.5); const g = new T.TorusGeometry(0.7, 0.12, 5, 10); addStatic(g, w, q.x, y0 + 0.5, q.z, pc.yaw + Math.PI / 2, 1, 1, 1, { rx: 0.3 }); }
    emit.smoke.push({ x: pc.x, y: y0 + 3, z: pc.z, size: 1.4, height: 12, rate: 0.25, color: 0x3a3230 });
    emit.embers.push({ x: pc.x, y: y0 + 1.5, z: pc.z, r: 1.5, n: 8 });
  }
  function buildTrebuchet(pc, y0, wood, metal) {
    const w = MAT.tex('wood', 0x3a2c24);
    for (const sd of [-1, 1]) {
      const a = lw(pc, sd * 1.4, -2), b = lw(pc, sd * 1.4, 2);
      addStatic(boxGeo(0.4, 0.4, 5, 1), w, (a.x + b.x) / 2, y0 + 0.2, (a.z + b.z) / 2, pc.yaw);
      for (const e of [-1, 1]) { const q = lw(pc, sd * 1.4, e * 1.0); addStatic(boxGeo(0.3, 5, 0.3, 1), w, q.x, y0 + 2.4, q.z, pc.yaw, 1, 1, 1, { rx: -e * 0.22 }); }
    }
    addStatic(cylGeo(0.15, 0.15, 3.4, 6), metal, pc.x, y0 + 4.6, pc.z, pc.yaw, 1, 1, 1, { rz: Math.PI / 2 });
    const arm = lw(pc, 0, 1.2);
    addStatic(boxGeo(0.3, 0.3, 9, 1), w, arm.x, y0 + 3.4, arm.z, pc.yaw, 1, 1, 1, { rx: 0.42 });
    const cw = lw(pc, 0, -1.4);
    addStatic(boxGeo(1.6, 1.4, 1.4, 1), w, cw.x, y0 + 0.7, cw.z, pc.yaw + 0.3);
  }
  function buildRuinWall(pc, y0, stone, rockM) {
    const rngR = AB.rng('ruin' + pc.x.toFixed(1));
    for (let k = -3; k <= 3; k++) {
      const q = lw(pc, 0, k * 1.9);
      const h = Math.max(0.6, 4.5 - Math.abs(k) * 0.9 + rngR.float(-0.8, 0.8));
      addStatic(boxGeo(1.4, h, 1.95, 1.6), stone, q.x, heightAt(q.x, q.z) + h / 2 - 0.3, q.z, pc.yaw, 1, 1, 1, { rx: rngR.float(-0.03, 0.03) });
    }
    for (let k = 0; k < 8; k++) { const q = lw(pc, rngR.float(-3, 3), rngR.float(-6, 6)); addStatic(rockGeo(0, 'chunk', true), rockM, q.x, heightAt(q.x, q.z), q.z, rngR.float(0, TAU), rngR.float(0.3, 0.7)); }
  }
  function buildGate3(pc, basalt, metal, group) {
    const y0 = baseAt(def.length) - 1;
    const g = archWallGeo(80, 60, 6, 13, 16, 4);
    addStatic(g, basalt, pc.x, y0 - 2, pc.z, pc.yaw);
    // the great doors, sealed, with a burning seam
    for (const sd of [-1, 1]) { const q = lw(pc, sd * 3.3, 0.8); addStatic(boxGeo(6.4, 21, 1.2, 3), MAT.tex('metal', 0x3a3230, 1), q.x, y0 + 10.5, q.z, pc.yaw); }
    const seamM = new T.MeshStandardMaterial({ color: 0x000000, emissive: 0xff4a10, emissiveIntensity: 0, roughness: 1 });
    const barM = new T.MeshStandardMaterial({ color: 0x000000, emissive: 0xff3a0a, emissiveIntensity: 0, roughness: 1 });
    gateGlow.push({ mat: seamM, base: 3, x: pc.x, z: pc.z }, { mat: barM, base: 1.2, x: pc.x, z: pc.z });
    levelDisposables.push(seamM, barM);
    addStatic(boxGeo(0.25, 20, 1.3), seamM, pc.x, y0 + 10.4, pc.z, pc.yaw, 1, 1, 1, { cast: false });
    for (const sd of [-1, 1]) for (const k of [0, 1, 2]) {
      const q = lw(pc, sd * (9.5 + k * 6), -0.8);
      addStatic(boxGeo(3.2, 46 - k * 6, 3.0, 3), basalt, q.x, y0 + 20 - k * 3, q.z, pc.yaw);
    }
    for (const y of [24, 34]) addStatic(boxGeo(40, 1.6, 1.0), barM, pc.x - Math.sin(pc.yaw) * 3.2, y0 + y, pc.z - Math.cos(pc.yaw) * 3.2, pc.yaw, 1, 1, 1, { cast: false });
    lightSources.push({ x: pc.x - Math.sin(pc.yaw) * 4, y: y0 + 4, z: pc.z - Math.cos(pc.yaw) * 4, color: new T.Color(0xff4a14), i: 70, range: 30, flick: 0.12, seed: 7 });
    // lava falls down the cliff either side
    const lm = lavaMaterial({ gain: 3.4, scale: 0.08, flow: [0, -0.12] });
    for (const sd of [-1, 1]) {
      const q = lw(pc, sd * 24, 3);
      const fall = new T.PlaneGeometry(4, 34, 1, 8);
      const m = new T.Mesh(fall, lm); m.position.set(q.x, y0 + 17, q.z); m.rotation.y = pc.yaw; group.add(m);
      lightSources.push({ x: q.x, y: y0 + 3, z: q.z, color: new T.Color(0xff5a1a), i: 60, range: 28, flick: 0.18, seed: sd * 11 });
      emit.smoke.push({ x: q.x, y: y0 + 1, z: q.z, size: 3, height: 26, rate: 0.3, color: 0x2a1c18 });
    }
  }
  function buildPylon(pc, y0, basalt, metal) {
    addStatic(boxGeo(3.4, 1.4, 3.4, 2), basalt, pc.x, y0 + 0.5, pc.z, pc.yaw);
    const g = new T.CylinderGeometry(0.6, 1.4, 13, 4, 1); scaleUV(g, 0.4);
    addStatic(g, basalt, pc.x, y0 + 7.4, pc.z, pc.yaw + Math.PI / 4);
    addBrazier(pc.x, y0 + 13.6, pc.z, metal, basalt, false);
    for (const sd of [-1, 1]) { const pts = []; for (let t = 0; t <= 8; t++) { const q = lw(pc, sd * 1.2 * (1 - t / 8) + sd * t * 0.9, t * 0.3); pts.push(new V3(q.x, y0 + 12 - Math.sin((t / 8) * Math.PI) * 2.5 - t * 1.2, q.z)); } const b = new GB(); tube(b, pts, pts.map(() => 0.08), 4, 0.5); addStatic(b.geo(), metal, 0, 0, 0, 0, 1, 1, 1, { chunk: chunkOfXZ(pc.x, pc.z) }); }
  }
  function buildVolcano(pc, group) {
    const g = new T.CylinderGeometry(46, 360, 280, 48, 14, true);
    const p = g.attributes.position, nz = new AB.addons.SimplexNoise({ random: AB.rng('volc').next.bind(AB.rng('volc')) });
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + nz.noise(x * 0.012, z * 0.012) * 0.1 + nz.noise(x * 0.05 + y * 0.03, z * 0.05) * 0.04;
      p.setXYZ(i, x * k, y + nz.noise(x * 0.02, z * 0.02) * 6, z * k);
    }
    g.computeVertexNormals();
    // emissive = haze in-scattered over hundreds of metres + the glow of its own lava (a pitch-black cone looked cut out)
    const m = new T.Mesh(g, new T.MeshStandardMaterial({ color: 0x2a1e1a, roughness: 0.95, emissive: 0x4a1a0c, emissiveIntensity: 0.55 }));
    m.position.set(pc.x, 60, pc.z); group.add(m);
    const lm = lavaMaterial({ gain: 4, scale: 0.03, flow: [0, -0.03] });
    const rngV = AB.rng('rivers');
    for (let k = 0; k < 7; k++) {
      const a = rngV.float(-1.2, 1.2) + Math.PI + Math.atan2(pc.x - samples.x[mainN - 1], pc.z - samples.z[mainN - 1]) * 0, pts = [];
      for (let t = 0; t <= 16; t++) { const r = 46 + t * 18; const aa = a + Math.sin(t * 0.6 + k) * 0.05; pts.push(new V3(pc.x + Math.sin(aa) * r, 0, pc.z + Math.cos(aa) * r)); }
      const rg = ribbon(pts, (t) => 3 + t * 7, (t) => 60 + 140 - (t * 288) * (280 / 314) + 4);
      group.add(new T.Mesh(rg, lm));
    }
    const cm = new T.Mesh(new T.CircleGeometry(44, 24).rotateX(-Math.PI / 2), lm); cm.position.set(pc.x, 60 + 132, pc.z); group.add(cm);
    lightSources.push({ x: pc.x, y: 230, z: pc.z, color: new T.Color(0xff4a10), i: 0, range: 1, flick: 0, seed: 1 });
    emit.smoke.push({ x: pc.x, y: 205, z: pc.z, size: 60, height: 260, rate: 0.12, color: 0x1a1210, big: true });
  }
  function buildCauseway(pc, cobble, basalt, metal) {
    const rngC = AB.rng('cause');
    for (let s = 2; s < def.length - 2; s += 2) {
      const p = lat(s, 0);
      addStatic(boxGeo(6.4, 1.4, 2.05, 1.6), basalt, p.x, -0.72, p.z, p.yaw, 1, 1, 1, { cast: false });
      for (const sd of [-1, 1]) {
        if (rngC.chance(0.25)) continue;
        const q = lat(s, sd * 3.55);
        const h = rngC.float(0.5, 1.1);
        addStatic(boxGeo(0.6, h, 1.9, 1), basalt, q.x, h / 2 - 0.05, q.z, p.yaw, 1, 1, 1, { rz: rngC.float(-0.05, 0.05) });
      }
      if (s % 16 === 0) for (const sd of [-1, 1]) { const q = lat(s, sd * 4.4); addBrazier(q.x, 0, q.z, metal, basalt, true); }
    }
    // the arches overhead and the support piers into the abyss
    for (let s = 10; s < def.length - 10; s += 22) { const p = lat(s, 0); const g = archWallGeo(14, 16, 2, 9, 9, 3); addStatic(g, basalt, p.x, -0.2, p.z, p.yaw); addStatic(boxGeo(5, 30, 2.2, 3), basalt, p.x, -16, p.z, p.yaw); }
  }
  // flat rune strokes around a circle: n cells, each a tangential stroke of random length, some with a radial cross-bar
  function runeRingGeo(R, w, n, rng) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU, cell = TAU / n;
      const len = R * cell * rng.float(0.35, 0.8), a = a0 + cell * rng.float(0.1, 0.25) + (len / R) / 2;
      const b = new T.BoxGeometry(len, 0.06, w * rng.float(0.45, 1)).rotateY(a).translate(Math.sin(a) * R, 0, Math.cos(a) * R);
      parts.push(b);
      if (rng.chance(0.45)) { const t = new T.BoxGeometry(w * 0.35, 0.06, w * rng.float(1.6, 2.6)).rotateY(a).translate(Math.sin(a) * R, 0, Math.cos(a) * R); parts.push(t); }
    }
    for (const p of parts) p.deleteAttribute('uv');
    const g = BGU.mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return g;
  }
  function buildForgeMouth(pc, basalt, metal, group) {
    // the edge: a ring of colossal basalt teeth around the end of the causeway, chains to the dark, a rune ring
    const rngF = AB.rng('forgemouth');
    for (let i = 0; i < 11; i++) {
      const a = -Math.PI * 0.62 + (i / 10) * Math.PI * 1.24;
      const r = 13 + rngF.float(-1, 1.5);
      const q = lw(pc, Math.sin(a) * r, -7 + Math.cos(a) * r * 0.8);
      const h = rngF.float(22, 34);
      const g = new T.CylinderGeometry(0.7, 2.2, h, 5, 1); scaleUV(g, 0.35);
      addStatic(g, basalt, q.x, -18 + h / 2, q.z, rngF.float(0, TAU), 1, 1, 1, { rx: rngF.float(-0.08, 0.08), rz: rngF.float(-0.08, 0.08) });
      const pts = [new V3(q.x, 37, q.z), new V3(U.lerp(q.x, pc.x, 0.45), 21 + rngF.float(-2, 2), U.lerp(q.z, pc.z, 0.45))];
      const b = new GB(); tube(b, pts, [0.11, 0.11], 4, 0.5); addStatic(b.geo(), metal, 0, 0, 0, 0, 1, 1, 1, { cast: false });
    }
    // two rings of glowing runes cut into the floor (broken strokes and cross-bars, not a smooth neon torus)
    addStatic(runeRingGeo(5.2, 0.3, 46, AB.rng('runes:a')), MAT.glow(0xff4a10, 0.85), pc.x, 0, pc.z, 0, 1, 1, 1, { cast: false });
    addStatic(runeRingGeo(3.6, 0.2, 32, AB.rng('runes:b')), MAT.glow(0xff7020, 0.75), pc.x, 0, pc.z, 0, 1, 1, 1, { cast: false });
    // the last arch before the edge: two great piers and a lintel with a burning seam
    for (const sd of [-1, 1]) { const q = lw(pc, sd * 6.2, 4.5); addStatic(boxGeo(2.4, 30, 2.6, 3), basalt, q.x, -10 + 15, q.z, pc.yaw); }
    const li = lw(pc, 0, 4.5);
    addStatic(boxGeo(15, 2.6, 2.8, 3), basalt, li.x, 19.5, li.z, pc.yaw);
    addStatic(boxGeo(11, 0.25, 2.9), MAT.glow(0xff5a14, 3), li.x, 18.4, li.z, pc.yaw, 1, 1, 1, { cast: false });
    // the pit of the Forge itself: a deep bright well beyond the edge
    const pit = new T.CircleGeometry(13, 32).rotateX(-Math.PI / 2);
    const pm = new T.Mesh(pit, lavaMaterial({ gain: 3.2, scale: 0.09, flow: [0.01, 0.02] }));   // gain 6 burnt out to a flat yellow
    const pp = lw(pc, 0, -15);
    pm.position.set(pp.x, -20, pp.z); group.add(pm);
    lightSources.push({ x: pp.x, y: -12, z: pp.z, color: new T.Color(0xff5a14), i: 90, range: 45, flick: 0.15, seed: 3 });
    emit.embers.push({ x: pp.x, y: -14, z: pp.z, r: 10, n: 60, rise: 34 });
    emit.smoke.push({ x: pp.x, y: -8, z: pp.z, size: 7, height: 44, rate: 0.3, color: 0x2a1410 });
  }
  // cloth banner on a pole (merged static cloth, swayed in the vertex shader by its uv: v = 1 at the top)
  function addBanner(group, x, y, z, yaw, color, h) {
    addStatic(cylGeo(0.06, 0.07, h + 0.4, 6, 1), MAT.tex('wood', 0x4a3a2c), x, y + h / 2, z);
    addStatic(cylGeo(0.035, 0.035, 1.3, 4), MAT.tex('wood', 0x4a3a2c), x, y + h - 0.05, z, yaw, 1, 1, 1, { rz: Math.PI / 2 });
    addStatic(G('bannerCloth', () => new T.PlaneGeometry(1.2, 2.2, 3, 6).translate(0, -1.1, 0)), bannerMat(color), x, y + h - 0.1, z, yaw, 1, 1, 1, { cast: AB.quality.settings.foliageShadows });
  }
  function bannerMat(color) {
    return M('banner' + color, () => {
      const m = new T.MeshStandardMaterial({ map: AB.tex.card('banner'), alphaTest: 0.5, side: T.DoubleSide, color, roughness: 0.95 });
      m.customProgramCacheKey = () => 'banner';
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uniforms.uWind;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWind;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nfloat hang = 1.0 - uv.y; float ph = dot(position.xz, vec2(0.7, 0.5));\nvec3 sway = vec3(uWind.x, 0.0, uWind.y) * (0.22 + 0.12 * sin(uTime * 1.3 + ph)) + objectNormal * sin(uTime * 2.6 + ph * 1.7 + hang * 3.0) * 0.16;\ntransformed += sway * hang;');
      };
      return m;
    });
  }

  // =============================================================================== POI PROPS (beacons)
  function poiColliders(act) {
    for (const poi of level.pois) {
      switch (poi.type) {
        case 'camp': { const q = lw(poi, 3.2, -1.6); col(q.x, q.z, 1.3); break; }
        case 'haven': { col(poi.x, poi.z, 2.0); const q = lw(poi, -2.6, -1.4); col(q.x, q.z, 0.7); break; }
        case 'chest': col(poi.x, poi.z, 0.6); break;
        case 'shrine': col(poi.x, poi.z, 0.75); break;
        case 'event': col(poi.x, poi.z, 0.35); break;
        case 'boss': if (act === 2 || act === 1 || act === 3) { /* arena colliders come with the set piece */ } break;
        default: break;
      }
    }
  }
  function buildProp(poi, act, group) {
    const g = new T.Group();
    g.position.set(poi.x, poi.y, poi.z); g.rotation.y = poi.yaw;
    g.name = 'poi:' + poi.id;
    const wood = MAT.tex('wood', act === 3 ? 0x5a4a40 : 0xb0a090), metal = MAT.tex('metal', 0x6a6460, 1), cloth = MAT.tex('cloth', 0x9a8a70);
    const stone = MAT.tex('stone', act === 2 ? 0xa8aab0 : act === 3 ? 0x5a4a44 : 0xb8b0a0);
    const add = (geo, mat, x, y, z, ry = 0, s = [1, 1, 1], rx = 0, rz = 0) => addLocal(poi, geo, mat, x, y, z, ry, s, rx, rz);
    const addM = (geo, mat, x, y, z, ry = 0, s = [1, 1, 1], rx = 0, rz = 0) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(s[0], s[1], s[2]); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const W = (lx, lz) => lw(poi, lx, lz);
    const hy = (lx, lz) => { const q = W(lx, lz); return heightAt(q.x, q.z) - poi.y; };
    // a lantern is warm glass in a dark iron frame (corner posts, cap, base), never a bare glowing brick
    const lanternFrame = (x, y, z) => {
      const fm = MAT.tex('metal', 0x2a2622, 0.6);
      for (const [dx, dz] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) add(G('lampPost', () => boxGeo(0.028, 0.32, 0.028, 1)), fm, x + dx, y, z + dz);
      add(G('lampCap', () => new T.ConeGeometry(0.17, 0.14, 4, 1).rotateY(Math.PI / 4)), fm, x, y + 0.23, z);
      add(G('lampBase', () => boxGeo(0.24, 0.035, 0.24, 1)), fm, x, y - 0.16, z);
    };
    switch (poi.type) {
      case 'camp': {
        for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU; add(G('campstone', () => rockGeo(0, 'boulder')), MAT.rock(act), Math.cos(a) * 0.85, hy(Math.cos(a) * 0.85, Math.sin(a) * 0.85) + 0.05, Math.sin(a) * 0.85, a, [0.2, 0.16, 0.18]); }
        for (let i = 0; i < 4; i++) add(G('campLog', () => cylGeo(0.09, 0.09, 1.2, 6, 0.6)), MAT.tex('bark', 0x8a7a68), Math.cos(i * 1.6) * 0.25, 0.15, Math.sin(i * 1.6) * 0.25, i * 1.6, [1, 1, 1], Math.PI / 2 - 0.35, 0);
        add(G('emberbed', () => new T.CircleGeometry(0.55, 12).rotateX(-Math.PI / 2)), MAT.glow(0xff5010, 2.5), 0, 0.04, 0);
        // seats: logs around
        for (const [lx, lz, ry] of [[-2.2, 0.6, 0.3], [1.9, 1.4, -0.6], [0.2, -2.3, 1.5]]) add(G('seatLog', () => { const b = new GB(); tube(b, [new V3(-0.9, 0, 0), new V3(0.9, 0, 0)], [0.24, 0.22], 7, 1, false); return b.geo(); }), MAT.tex('bark', 0x9a8a78), lx, hy(lx, lz) + 0.2, lz, ry);
        // A-frame tent and bedrolls
        const tx = 3.2, tz = -1.6;
        add(G('tent', () => { const gg = roofGeo(2.4, 2.6, 1.6, 0.05, 0.04, 1.2); return gg; }), MAT.tex('cloth', 0x8a7a5a), tx, hy(tx, tz) + 0.05, tz, 0.6);
        for (const [lx, lz, ry] of [[-1.6, -1.4, 0.8], [1.6, -0.5, -0.9]]) add(G('bedroll', () => cylGeo(0.22, 0.22, 1.8, 8, 0.8)), MAT.tex('cloth', 0x6a5a48), lx, hy(lx, lz) + 0.16, lz, ry, [1, 1, 1], 0, Math.PI / 2);
        // tripod + pot
        for (let i = 0; i < 3; i++) { const a = i * TAU / 3; add(G('tripodLeg', () => cylGeo(0.03, 0.03, 1.7, 4)), MAT.tex('wood', 0x5a4a3a), Math.cos(a) * 0.45, 0.8, Math.sin(a) * 0.45, 0, [1, 1, 1], Math.sin(a) * 0.3, -Math.cos(a) * 0.3); }
        add(G('pot', () => new T.SphereGeometry(0.22, 10, 8, 0, TAU, Math.PI * 0.3, Math.PI * 0.7)), metal, 0, 0.75, 0);
        poiFx(poi, 'campfire', W(0, 0), poi.y + 0.15);
        break;
      }
      case 'haven': {
        add(G('wagonBed', () => boxGeo(2.0, 0.25, 3.6, 1)), wood, 0, 0.85, 0);
        for (const sd of [-1, 1]) add(G('wagonSide', () => boxGeo(0.08, 0.6, 3.6, 1)), wood, sd * 0.96, 1.25, 0);
        for (const [sx, sz] of [[-1.1, 1.1], [1.1, 1.1], [-1.1, -1.1], [1.1, -1.1]]) add(G('wheel', () => new T.TorusGeometry(0.55, 0.07, 5, 14)), wood, sx, 0.55, sz, Math.PI / 2);
        add(G('cover', () => { const gg = new T.CylinderGeometry(1.1, 1.1, 3.4, 14, 1, true, -Math.PI / 2, Math.PI); gg.rotateX(Math.PI / 2); scaleUV(gg, 2); return gg; }), MAT.tex('cloth', 0xd8ccb0), 0, 1.45, 0, 0);
        // awning on poles toward the road
        for (const sx of [-1.6, 1.6]) add(G('pole', () => cylGeo(0.05, 0.05, 2.6, 5)), wood, sx, 1.3, 3.2);
        add(G('awning', () => new T.PlaneGeometry(3.6, 2.2, 3, 2)), MAT.tex('cloth', 0x9a4a32, 1, { side: T.DoubleSide }), 0, 2.45, 2.4, 0, [1, 1, 1], -Math.PI / 2 + 0.25, 0);
        for (const [lx, lz] of [[-2.6, -1.4], [-2.2, 0.2], [2.4, 1.6]]) add(G('crate', () => boxGeo(0.8, 0.7, 0.8, 0.8)), wood, lx, hy(lx, lz) + 0.35, lz, lx * 0.7);
        for (const [lx, lz] of [[2.5, -0.8], [2.9, 0.1]]) { add(G('barrelM', () => cylGeo(0.36, 0.4, 0.95, 10, 1)), wood, lx, hy(lx, lz) + 0.47, lz); }
        for (const [lx, lz] of [[-1.6, 3.4], [1.6, 3.4]]) { add(G('lanternBox', () => boxGeo(0.18, 0.26, 0.18, 1)), MAT.glow(0xffa040, 1.8), lx, 2.25, lz, 0, [1, 1, 1], 0, 0); lanternFrame(lx, 2.25, lz); lightSources.push(Object.assign({ x: W(lx, lz).x, y: poi.y + 2.2, z: W(lx, lz).z, color: new T.Color(0xffa850), i: 16, range: 12, flick: 0.1, seed: lx * 7 + poi.x, poiId: poi.id })); }
        poiFx(poi, 'haven', W(0, 0), poi.y);
        break;
      }
      case 'chest': {
        // body + bands batch with the level statics (they never move); the lid stays separate (it opens) and is drawn
        // only within 70 m (cullList) (integrator, perf: was 6 draws per chest at any distance)
        add(G('chestBase', () => boxGeo(1.0, 0.55, 0.62, 0.8)), wood, 0, 0.3, 0);
        for (const bx of [-0.32, 0.32]) add(G('band', () => boxGeo(0.07, 0.58, 0.66, 1)), metal, bx, 0.3, 0);
        const lid = new T.Group(); lid.position.set(0, 0.58, -0.31); lid.name = 'lid'; g.add(lid);
        const lm = new T.Mesh(G('chestLid', () => { const gg = new T.CylinderGeometry(0.31, 0.31, 1.0, 10, 1, false, 0, Math.PI); gg.rotateZ(Math.PI / 2); gg.translate(0, 0, 0.31); return gg; }), wood);
        lm.castShadow = false; lid.add(lm);
        const lb = new T.Mesh(G('lidBand', () => { const gg = new T.CylinderGeometry(0.325, 0.325, 0.07, 10, 1, false, 0, Math.PI); gg.rotateZ(Math.PI / 2); gg.translate(0, 0, 0.31); return gg; }), metal);
        lb.position.x = 0.32; lid.add(lb); const lb2 = lb.clone(); lb2.position.x = -0.32; lid.add(lb2);
        { const wc = W(0, 0); for (const m of [lm, lb, lb2]) { m.castShadow = false; m.userData.cull = { r: 1, c: new T.Vector3(wc.x, poi.y + 0.6, wc.z), far: 70, cast: false }; cullList.push(m); } }
        // a grave-like cairn or broken stones beside it
        add(G('chestRock', () => rockGeo(1, 'chunk')), MAT.rock(act), 0.9, hy(0.9, -0.4) + 0.1, -0.4, 0.4, [0.35, 0.3, 0.35]);
        poiFx(poi, 'chest', W(0, 0), poi.y);
        break;
      }
      case 'shrine': {
        if (act === 2) {
          add(G('altar', () => boxGeo(1.6, 1.0, 1.0, 1)), stone, 0, 0.5, 0);
          add(G('altarTop', () => boxGeo(1.9, 0.2, 1.2, 1)), MAT.tex('carving', 0xb8b0a4), 0, 1.1, 0);
          add(G('backstone', () => boxGeo(1.3, 3.0, 0.5, 1.5)), MAT.tex('carving', 0x9a9690), 0, 1.5, -0.8);
        } else {
          add(G('monolith', () => { const gg = boxGeo(1.0, 2.8, 0.55, 1.4); return gg; }), act === 3 ? MAT.tex('basalt', 0x8a7a76) : stone, 0, 1.3, 0, 0, [1, 1, 1], 0.03, 0.02);
          add(G('niche', () => boxGeo(0.45, 0.6, 0.1, 1)), MAT.plain(0x0a0806, 1), 0, 1.7, 0.28);
        }
        for (const [lx, lz] of [[-0.45, 0.45], [0.3, 0.55], [0.55, 0.3]]) { add(G('candle', () => cylGeo(0.04, 0.04, 0.22, 6)), MAT.plain(0xd8d0b8, 0.7), lx, 0.11, lz); }
        poiFx(poi, 'shrine', W(0, 0), poi.y);
        break;
      }
      case 'event': {
        add(G('evPost', () => cylGeo(0.09, 0.11, 2.6, 6, 1)), wood, 0, 1.25, 0);
        add(G('evArm', () => boxGeo(0.06, 0.06, 0.7, 1)), wood, 0, 2.45, 0.3);
        addM(G('evLamp', () => boxGeo(0.18, 0.28, 0.18, 1)), MAT.glow(0xffa040, 1.8), 0, 2.2, 0.62).name = 'lantern';
        lanternFrame(0, 2.2, 0.62);
        const variant = (Math.abs(Math.round(poi.s)) % 3);
        if (act === 1) {
          if (variant === 0) { add(G('evCart', () => boxGeo(1.5, 0.12, 2.6, 1)), wood, -1.8, 0.35, -1.0, 0.5, [1, 1, 1], 0, 0.5); add(G('wheel', () => new T.TorusGeometry(0.55, 0.07, 5, 14)), wood, -2.5, 0.2, -0.2, 1.2, [1, 1, 1], Math.PI / 2 - 0.1, 0); }
          else if (variant === 1) { for (let k = 0; k < 3; k++) add(G('grave', () => boxGeo(0.5, 0.9, 0.14, 0.6)), stone, -1.5 + k * 0.9, 0.35, -1.4, 0.1 * k, [1, 1, 1], 0.08 * (k - 1), 0); }
          else { add(G('evTent', () => roofGeo(2.2, 2.4, 1.5, 0.05, 0.04, 1.2)), MAT.tex('cloth', 0x7a6a50), -2.0, hy(-2, -1) + 0.05, -1.0, 0.4); }
        } else if (act === 2) { for (let k = 0; k < 4; k++) add(G('evCairn', () => rockGeo(0, 'boulder')), MAT.rock(2), -1.4, 0.25 + k * 0.42, -1.0, k, [0.6 - k * 0.12, 0.42, 0.55 - k * 0.1]); }
        else if (act === 3) { add(G('evBones', () => rockGeo(1, 'slab')), MAT.tex('plaster', 0xb0a490, 0.8), -1.6, 0.1, -1.0, 0.3, [0.6, 0.25, 0.4]); add(G('evSpear', () => cylGeo(0.03, 0.03, 2.6, 4)), wood, -1.0, 1.0, -1.4, 0, [1, 1, 1], 0.3, 0.2); }
        poiFx(poi, 'event', W(0, 0.62), poi.y + 2.2);
        break;
      }
      case 'battle': case 'elite': {
        const tint = act === 1 ? 0x4a3a2a : act === 2 ? 0x2a3040 : 0x5a1a12;
        for (const sd of [-1, 1]) {
          const lx = sd * 6.5, lz = -3.5;
          if (pathDist(W(lx, lz).x, W(lx, lz).z) < ROAD_HALF + 0.8) continue;
          const q = W(lx, lz);
          addBanner(group, q.x, heightAt(q.x, q.z), q.z, poi.yaw + sd * 0.3, poi.type === 'elite' ? 0x6a1810 : tint, poi.type === 'elite' ? 4.2 : 3.4);
        }
        const fx = W(4.5, -6);
        poiFx(poi, poi.type === 'elite' ? 'bonfire' : 'embers', fx, heightAt(fx.x, fx.z));
        break;
      }
      case 'forge': {
        add(G('forgeRune', () => new T.RingGeometry(1.6, 1.9, 32).rotateX(-Math.PI / 2)), MAT.glow(0xff7a2a, 4), 0, 0.05, 0);
        break;
      }
      default: break;
    }
    group.add(g);
    return g;
  }
  // POI beacons: fire, smoke, glints, light columns, lamp lights (registered so poi:update can dim/brighten them)
  const poiFxMap = new Map();             // poiId -> { flames: [idx], lights: [src], glints: [idx], shafts: [idx], smoke: [idx] }
  function poiFx(poi, kind, at, y) {
    const rec = { flames: [], lights: [], glints: [], shafts: [], smoke: [], embers: [], kind };
    const L = (o) => { const s = Object.assign({ x: at.x, y, z: at.z, seed: at.x + at.z, poiId: poi.id, k: 1 }, o); lightSources.push(s); rec.lights.push(s); };
    if (kind === 'campfire' || kind === 'bonfire') {
      const big = kind === 'bonfire';
      rec.flames.push(emit.flames.push({ x: at.x, y: y + 0.05, z: at.z, w: big ? 1.6 : 1.0, h: big ? 2.6 : 1.6, seed: at.x, k: 1 }) - 1);
      rec.flames.push(emit.flames.push({ x: at.x + 0.15, y: y + 0.02, z: at.z - 0.1, w: big ? 1.2 : 0.75, h: big ? 1.9 : 1.1, seed: at.z + 3, k: 1 }) - 1);
      rec.embers.push(emit.embers.push({ x: at.x, y: y + 0.4, z: at.z, r: big ? 0.8 : 0.45, n: big ? 22 : 14 }) - 1);
      rec.smoke.push(emit.smoke.push({ x: at.x, y: y + 1.4, z: at.z, size: big ? 1.6 : 1.1, height: big ? 16 : 13, rate: 0.4, color: 0x7a7a78 }) - 1);
      L({ y: y + 1.1, color: new T.Color(0xff8a3a), i: big ? 60 : 38, range: big ? 22 : 17, flick: 0.28 });
    } else if (kind === 'embers') {
      rec.flames.push(emit.flames.push({ x: at.x, y: y + 0.02, z: at.z, w: 0.6, h: 0.7, seed: at.x, k: 0.8 }) - 1);
      rec.smoke.push(emit.smoke.push({ x: at.x, y: y + 0.8, z: at.z, size: 1.0, height: 12, rate: 0.3, color: 0x6a6a68 }) - 1);
      L({ y: y + 0.7, color: new T.Color(0xff7a2a), i: 14, range: 10, flick: 0.3 });
    } else if (kind === 'haven') {
      rec.smoke.push(emit.smoke.push({ x: at.x - 1.4, y: y + 2.6, z: at.z, size: 0.7, height: 7, rate: 0.3, color: 0x8a8a88 }) - 1);
    } else if (kind === 'chest') {
      rec.glints.push(emit.glints.push({ x: at.x, y: y + 0.8, z: at.z, k: 1, seed: at.x }) - 1);
      L({ y: y + 1.0, color: new T.Color(0xffd890), i: 3, range: 4, flick: 0.05 });
    } else if (kind === 'shrine') {
      const c = act3c(poi) ;
      rec.shafts.push(emit.shafts.push({ x: at.x, y: y + 3.5, z: at.z, yaw: poi.yaw, w: 1.6, h: 9, tilt: 0, color: c, a: 0.75, k: 1, beacon: true }) - 1);
      rec.flames.push(emit.flames.push({ x: lw(poi, -0.45, 0.45).x, y: y + 0.28, z: lw(poi, -0.45, 0.45).z, w: 0.12, h: 0.22, seed: at.x + 1, k: 1 }) - 1);
      rec.flames.push(emit.flames.push({ x: lw(poi, 0.3, 0.55).x, y: y + 0.28, z: lw(poi, 0.3, 0.55).z, w: 0.12, h: 0.2, seed: at.x + 2, k: 1 }) - 1);
      L({ y: y + 2.2, color: new T.Color(c), i: 14, range: 12, flick: 0.04 });
    } else if (kind === 'event') {
      L({ y, color: new T.Color(0xffa850), i: 10, range: 10, flick: 0.12 });
      rec.glints.push(emit.glints.push({ x: at.x, y, z: at.z, k: 0.6, seed: at.z, lamp: true }) - 1);
    }
    poiFxMap.set(poi.id, rec);
  }
  function act3c(poi) { return actKey === 3 ? 0xffc8a0 : actKey === 2 ? 0x9ec8ff : 0xfff0c8; }

  // =============================================================================== FX (GPU-animated, one draw call per kind; cosmetic only)
  const fxU = { uPx: { value: 600 }, uCenter: { value: new V3() }, uCamRight: { value: new V3(1, 0, 0) } };
  let fx = null;                          // { flames, smoke, embers, glints, shafts, mist, ambient: [], birds: [] }
  const FOGU = () => T.UniformsLib.fog;
  const quadGeo = () => G('quad', () => new T.PlaneGeometry(1, 1));
  function instGeo(base, n, attrs) {
    const g = new T.InstancedBufferGeometry();
    g.index = base.index;
    for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
    for (const [name, size, data] of attrs) g.setAttribute(name, new T.InstancedBufferAttribute(data, size));
    g.instanceCount = n;
    return g;
  }
  const FOG_ATT = 'float fogAtt(float d){ float f = fogDensity * d; return exp(-f * f * 0.85); }';
  function fxMat(vs, fs, extra, opts = {}) {
    const u = fogU(extra || {});
    u.uTime = uniforms.uTime; u.uWind = uniforms.uWind; u.uPx = fxU.uPx; u.uCenter = fxU.uCenter;
    u.tNoise = { value: AB.tex.noise() };
    return new T.ShaderMaterial(Object.assign({ uniforms: u, vertexShader: vs, fragmentShader: fs, transparent: true, depthWrite: false, fog: true, blending: T.AdditiveBlending }, opts));
  }
  const BILL = [
    'vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);',
    'vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);'
  ].join('\n');
  function buildFx(act, group) {
    fx = { ambient: [], birds: [] };
    const q = AB.quality.settings;
    // ---- flames (camera-facing, upright)
    if (emit.flames.length) {
      const n = emit.flames.length, pos = new Float32Array(n * 3), size = new Float32Array(n * 2), seed = new Float32Array(n), k = new Float32Array(n);
      emit.flames.forEach((f, i) => { pos.set([f.x, f.y, f.z], i * 3); size.set([f.w, f.h], i * 2); seed[i] = f.seed % 97; k[i] = f.k; });
      const g = instGeo(quadGeo(), n, [['aPos', 3, pos], ['aSize', 2, size], ['aSeed', 1, seed], ['aK', 1, k]]);
      const m = fxMat([
        'attribute vec3 aPos; attribute vec2 aSize; attribute float aSeed; attribute float aK; uniform float uTime; varying vec2 vUv; varying float vK; varying float vD; varying float vSeed;',
        'void main(){', BILL,
        '  vec3 camF = normalize(cross(camR, vec3(0.0, 1.0, 0.0)));',
        '  float fl = 1.0 + 0.1 * sin(uTime * 11.0 + aSeed * 7.0) + 0.07 * sin(uTime * 19.0 + aSeed * 3.0);',
        '  vec3 p = aPos + normalize(camR) * position.x * aSize.x * aK + vec3(0.0, 1.0, 0.0) * (position.y + 0.5) * aSize.y * fl * aK;',
        '  vUv = uv; vK = aK; vSeed = aSeed;',
        '  vec4 mv = viewMatrix * vec4(p, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'), [
        'uniform sampler2D tFlame, tNoise; uniform float uTime, fogDensity; varying vec2 vUv; varying float vK; varying float vD; varying float vSeed;', FOG_ATT,
        'void main(){',
        '  vec2 uv = vUv;',
        '  float n = texture2D(tNoise, vec2(uv.x * 0.5 + vSeed * 0.13, uv.y * 0.45 - uTime * 0.9)).g;',
        '  float n2 = texture2D(tNoise, vec2(uv.x * 1.1 - vSeed * 0.07, uv.y * 0.9 - uTime * 1.7)).a;',
        '  uv.x += (n - 0.5) * 0.35 * uv.y; uv.y += (n2 - 0.5) * 0.18 * uv.y;',
        '  vec4 f = texture2D(tFlame, uv);',
        '  float a = f.a * smoothstep(0.0, 0.15, 1.0 - uv.y) * (0.7 + n2 * 0.6);',
        '  vec3 c = f.rgb * vec3(1.6, 1.0, 0.6) * a * 3.2 * vK;',
        '  gl_FragColor = vec4(c * fogAtt(vD), 1.0);',
        '}'
      ].join('\n'), { tFlame: { value: AB.tex.card('flame') } });
      const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 7; group.add(mesh);
      fx.flames = { mesh, k };
    }
    // ---- embers rising from fires (points)
    if (emit.embers.length) {
      let n = 0; for (const e of emit.embers) n += Math.max(2, Math.round(e.n * (0.5 + q.particles * 0.5)));
      const pos = new Float32Array(n * 3), sd = new Float32Array(n * 4);
      let i = 0; const rng = AB.rng('embers');
      for (const e of emit.embers) { const c = Math.max(2, Math.round(e.n * (0.5 + q.particles * 0.5))); for (let k = 0; k < c; k++, i++) { pos.set([e.x, e.y, e.z], i * 3); sd.set([rng.next(), rng.next(), e.r || 0.4, e.rise || 5], i * 4); } }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new T.BufferAttribute(sd, 4));
      const m = fxMat([
        'attribute vec4 aSeed; uniform float uTime, uPx; uniform vec2 uWind; varying float vA; varying float vD;',
        'void main(){',
        '  float t = fract(uTime * (0.25 + aSeed.x * 0.35) + aSeed.y);',
        '  float a = aSeed.y * 6.2831 + uTime * (1.0 + aSeed.x);',
        '  vec3 p = position + vec3(cos(a) * aSeed.z * (0.3 + t), t * aSeed.w * (0.6 + aSeed.x * 0.6), sin(a) * aSeed.z * (0.3 + t));',
        '  p.xz += uWind * t * t * 1.5;',
        '  vA = (1.0 - t) * smoothstep(0.0, 0.08, t) * (0.6 + 0.4 * sin(uTime * 20.0 + aSeed.x * 50.0));',
        '  vec4 mv = viewMatrix * vec4(p, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv;',
        '  gl_PointSize = clamp(0.06 * uPx / max(vD, 0.1), 1.0, 24.0);',
        '}'
      ].join('\n'), [
        'uniform float fogDensity; varying float vA; varying float vD;', FOG_ATT,
        'void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); float a = smoothstep(0.5, 0.0, d) * vA; gl_FragColor = vec4(vec3(2.6, 0.9, 0.25) * a * fogAtt(vD), 1.0); }'
      ].join('\n'));
      const pts = new T.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 8; group.add(pts);
    }
    // ---- smoke columns (camera-facing puffs with a life cycle)
    if (emit.smoke.length) {
      let n = 0; const per = (e) => (e.big ? 10 : 7);
      for (const e of emit.smoke) n += per(e);
      const pos = new Float32Array(n * 3), par = new Float32Array(n * 4), colr = new Float32Array(n * 3);
      let i = 0; const c = new T.Color();
      for (const e of emit.smoke) { c.set(e.color || 0x808080); for (let k = 0; k < per(e); k++, i++) { pos.set([e.x, e.y, e.z], i * 3); par.set([k / per(e), e.size, e.height, e.rate], i * 4); colr.set([c.r, c.g, c.b], i * 3); } }
      const g = instGeo(quadGeo(), n, [['aPos', 3, pos], ['aPar', 4, par], ['aCol', 3, colr]]);
      const m = fxMat([
        'attribute vec3 aPos; attribute vec4 aPar; attribute vec3 aCol; uniform float uTime; uniform vec2 uWind; varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vD;',
        '#include <fog_pars_vertex>',
        'void main(){', BILL,
        '  float t = fract(uTime * aPar.w * 0.18 + aPar.x);',
        '  vec3 c = aPos + vec3(uWind.x, 0.0, uWind.y) * t * t * aPar.z * 0.35 + vec3(sin(aPar.x * 40.0 + uTime * 0.3), 0.0, cos(aPar.x * 31.0)) * t * aPar.y * 0.4;',
        '  c.y += t * aPar.z;',
        '  float s = aPar.y * (0.5 + t * 2.4);',
        '  float rot = aPar.x * 6.0 + t * 1.5; float cr = cos(rot), sr = sin(rot);',
        '  vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);',
        '  vec3 p = c + camR * q.x * s + camU * q.y * s;',
        '  vUv = uv; vA = smoothstep(0.0, 0.15, t) * (1.0 - t) * 0.55; vCol = aCol;',
        '  vec4 mvPosition = viewMatrix * vec4(p, 1.0); vD = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}'
      ].join('\n'), [
        'uniform sampler2D tSmoke; varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vD;',
        '#include <fog_pars_fragment>',
        'void main(){ vec4 t = texture2D(tSmoke, vUv); float a = t.a * vA * smoothstep(0.5, 3.0, vD); gl_FragColor = vec4(vCol, a);',
        '#include <fog_fragment>',
        '}'
      ].join('\n'), { tSmoke: { value: AB.tex.card('smoke') } }, { blending: T.NormalBlending });
      const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 6; group.add(mesh);
    }
    // ---- glints (chests) and lamp halos
    if (emit.glints.length) {
      const n = emit.glints.length, pos = new Float32Array(n * 3), k = new Float32Array(n), sd = new Float32Array(n);
      emit.glints.forEach((e, i) => { pos.set([e.x, e.y, e.z], i * 3); k[i] = e.k; sd[i] = e.lamp ? -1 - (Math.abs(e.seed) % 7) : Math.abs(e.seed) % 13; });
      const g = instGeo(quadGeo(), n, [['aPos', 3, pos], ['aK', 1, k], ['aSeed', 1, sd]]);
      const m = fxMat([
        'attribute vec3 aPos; attribute float aK; attribute float aSeed; uniform float uTime; varying vec2 vUv; varying float vA; varying float vD; varying float vLamp;',
        'void main(){', BILL,
        '  float lamp = step(aSeed, -0.5); vLamp = lamp;',
        '  float tw = lamp > 0.5 ? 0.85 + 0.15 * sin(uTime * 7.0 + aSeed) : pow(max(sin(uTime * 1.6 + aSeed), 0.0), 6.0);',
        '  vec4 mv0 = viewMatrix * vec4(aPos, 1.0); float d = -mv0.z;',
        '  float s = (lamp > 0.5 ? 0.55 : 0.35 + 0.5 * tw) * clamp(d * 0.04, 1.0, lamp > 0.5 ? 2.2 : 4.0);',
        '  vec3 p = aPos + camR * position.x * s + camU * position.y * s;',
        '  vUv = uv; vA = aK * (lamp > 0.5 ? 0.6 : 0.3 + tw); vD = d;',
        '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
        '}'
      ].join('\n'), [
        'uniform sampler2D tGlint; uniform float fogDensity; varying vec2 vUv; varying float vA; varying float vD; varying float vLamp;', FOG_ATT,
        'void main(){ vec4 t = texture2D(tGlint, vUv); float a = vLamp > 0.5 ? smoothstep(0.5, 0.0, length(vUv - 0.5)) * 0.5 : t.a; vec3 c = vLamp > 0.5 ? vec3(0.9, 0.5, 0.22) : vec3(2.0, 1.7, 1.1); gl_FragColor = vec4(c * a * vA * max(fogAtt(vD), 0.25), 1.0); }'
      ].join('\n'), { tGlint: { value: AB.tex.card('glint') } });
      const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 8; group.add(mesh);
      fx.glints = { mesh, k };
    }
    // ---- light shafts (crossed additive quads)
    if (emit.shafts.length) {
      const n = emit.shafts.length * 2, pos = new Float32Array(n * 3), par = new Float32Array(n * 4), colr = new Float32Array(n * 3), k = new Float32Array(n);
      const c = new T.Color();
      // both crossed quads share the shaft axis (yaw + tilt toward the light); the second one is turned 90 deg about it
      const rot = new Float32Array(n);
      emit.shafts.forEach((e, i) => { c.set(e.color); for (let j = 0; j < 2; j++) { const ii = i * 2 + j; pos.set([e.x, e.y, e.z], ii * 3); par.set([e.yaw, e.tilt || 0, e.w, e.h], ii * 4); rot[ii] = (e.spin || 0) + j * Math.PI / 2; colr.set([c.r * (e.a || 0.5), c.g * (e.a || 0.5), c.b * (e.a || 0.5)], ii * 3); k[ii] = e.k != null ? e.k : 1; } });
      const g = instGeo(quadGeo(), n, [['aPos', 3, pos], ['aPar', 4, par], ['aCol', 3, colr], ['aK', 1, k], ['aRot', 1, rot]]);
      const m = fxMat([
        'attribute vec3 aPos; attribute vec4 aPar; attribute vec3 aCol; attribute float aK; attribute float aRot; uniform float uTime; varying vec2 vUv; varying vec3 vCol; varying float vD; varying float vFace;',
        'void main(){',
        '  float cy = cos(aPar.x), sy = sin(aPar.x), ct = cos(aPar.y), st = sin(aPar.y);',
        '  vec3 ax = vec3(st * sy, ct, st * cy);',
        '  vec3 w0 = vec3(cy, 0.0, -sy), w1 = cross(ax, w0);',
        '  vec3 wd = w0 * cos(aRot) + w1 * sin(aRot);',
        '  vec3 p = aPos + wd * position.x * aPar.z + ax * position.y * aPar.w;',
        '  vec3 nrm = cross(ax, wd);',
        '  vec4 mv = viewMatrix * vec4(p, 1.0); vD = -mv.z;',
        '  vec3 vdir = normalize(cameraPosition - p);',
        '  vFace = abs(dot(vdir, nrm));',
        '  vUv = uv; vCol = aCol * aK;',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'), [
        'uniform sampler2D tShaft, tNoise; uniform float uTime, fogDensity, uShaftK; varying vec2 vUv; varying vec3 vCol; varying float vD; varying float vFace;', FOG_ATT,
        'void main(){',
        '  float a = texture2D(tShaft, vUv).a;',
        '  float dust = 0.65 + 0.35 * texture2D(tNoise, vec2(vUv.x * 0.7, vUv.y * 0.35 - uTime * 0.02)).g;',
        '  float near = smoothstep(2.0, 9.0, vD);',
        '  gl_FragColor = vec4(vCol * a * dust * near * (0.35 + 0.65 * vFace) * uShaftK * fogAtt(vD * 0.6), 1.0);',
        '}'
      ].join('\n'), { tShaft: { value: AB.tex.card('shaft') }, uShaftK: { value: 1 } }, { side: T.DoubleSide });
      const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 9; group.add(mesh);
      fx.shafts = { mesh, k, mat: m };
    }
    // ---- mist banks (upright billboards, faded at top/bottom and near the camera)
    if (emit.mist.length) {
      const list = [];
      const rng = AB.rng('mist' + actKey);
      // each sheet stands on the ground (bottom just below it) and fades out toward the ground line: no hard edge where
      // the upright quad cuts into the terrain
      for (const e of emit.mist) for (let i = 0; i < e.n; i++) { const a = rng.float(0, TAU), r = Math.sqrt(rng.next()) * e.r; const x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r; const gy = heightAt(x, z), lift = rng.float(0.0, 0.7), w = Math.min(actKey === 2 ? 6 : 14, rng.float(6, 14)), hh = rng.float(1.8, 3.4); list.push([x, gy + hh * 0.42 + lift, z, w, hh, rng.next(), gy - 0.15]); }
      const n = list.length, pos = new Float32Array(n * 3), par = new Float32Array(n * 3), gnd = new Float32Array(n);
      list.forEach((l, i) => { pos.set([l[0], l[1], l[2]], i * 3); par.set([l[3], l[4], l[5]], i * 3); gnd[i] = l[6]; });
      const g = instGeo(quadGeo(), n, [['aPos', 3, pos], ['aPar', 3, par], ['aG', 1, gnd]]);
      const m = fxMat([
        'attribute vec3 aPos; attribute vec3 aPar; attribute float aG; uniform float uTime; uniform vec2 uWind; varying vec2 vUv; varying float vA; varying float vD; varying float vSeed; varying float vAbove;',
        '#include <fog_pars_vertex>',
        'void main(){',
        '  vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));',
        '  vec3 c = aPos + vec3(uWind.x, 0.0, uWind.y) * sin(uTime * 0.05 + aPar.z * 6.0) * 2.0;',
        '  vec3 p = c + camR * position.x * aPar.x + vec3(0.0, 1.0, 0.0) * position.y * aPar.y;',
        '  vec4 mvPosition = viewMatrix * vec4(p, 1.0); vD = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;',
        '  vAbove = p.y - aG;',
        '  vUv = uv; vSeed = aPar.z; vA = smoothstep(6.0, 22.0, vD) * (1.0 - smoothstep(45.0, 95.0, vD)) * (0.35 + 0.65 * fract(aPar.z * 7.31));',
        '  #include <fog_vertex>',
        '}'
      ].join('\n'), [
        'uniform sampler2D tMist; uniform float uTime, uMistK; uniform vec3 uMistCol; varying vec2 vUv; varying float vA; varying float vD; varying float vSeed; varying float vAbove;',
        '#include <fog_pars_fragment>',
        'void main(){',
        '  vec2 uv = vec2(vUv.x * 0.8 + 0.1 + sin(uTime * 0.04 + vSeed * 9.0) * 0.08, vUv.y);',
        '  float a = texture2D(tMist, uv).a * smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.55, vUv.y) * smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x) * smoothstep(0.0, 1.1, vAbove);',
        '  gl_FragColor = vec4(uMistCol, a * vA * uMistK * 0.6);',
        '  #include <fog_fragment>',
        '}'
      ].join('\n'), { tMist: { value: AB.tex.card('mist') }, uMistK: { value: 1 }, uMistCol: { value: new T.Color(0xb0b8c0) } }, { blending: T.NormalBlending });
      const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 5; group.add(mesh);
      fx.mist = { mesh, mat: m };
    }
    // ---- ambient particles around the camera
    const AMB = {
      1: [['fireflies', 260], ['motes', 340]],
      2: [['snow', 1600], ['dust', 360]],
      3: [['ash', 1300], ['sparks', 320]],
      forge: [['sparks', 520], ['ash', 300]]
    };
    for (const [kind, base] of AMB[act] || []) fx.ambient.push(ambientPoints(kind, Math.round(base * (0.4 + q.particles * 0.6)), group));
    // ---- birds and bats
    if (act === 1) { fx.birds.push(birdFlock('crow', 12, roadAt(0.3), 42, 48, group)); fx.birds.push(birdFlock('bat', 10, roadAt(0.8), 14, 7, group)); }
    else if (act === 2) { fx.birds.push(birdFlock('crow', 7, roadAt(0.25), 40, 45, group)); fx.birds.push(birdFlock('bat', 18, roadAt(0.75), 12, 14, group)); }
    else if (act === 3) { fx.birds.push(birdFlock('vulture', 9, roadAt(0.55), 48, 42, group)); }
  }
  const roadAt = (f) => { const p = roadPoint(f * def.length, new V3()); return p; };
  function ambientPoints(kind, n, group) {
    const rng = AB.rng('amb:' + kind);
    const sd = new Float32Array(n * 4), pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 4; i++) sd[i] = rng.next();
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new T.BufferAttribute(sd, 4));
    const cfg = {
      fireflies: { box: 46, add: true, size: 0.09, col: '1.4, 2.2, 0.6' },
      motes: { box: 30, add: false, size: 0.035, col: '1.0, 0.9, 0.7' },
      snow: { box: 36, add: false, size: 0.07, col: '0.95, 0.97, 1.0' },
      dust: { box: 30, add: false, size: 0.03, col: '0.9, 0.75, 0.55' },
      ash: { box: 40, add: false, size: 0.075, col: '0.42, 0.4, 0.38' },
      sparks: { box: 40, add: true, size: 0.05, col: '2.4, 0.8, 0.2' }
    }[kind];
    const motion = {
      fireflies: 'vec2 xz = aSeed.xz * B + vec2(sin(uTime * 0.27 + aSeed.w * 20.0), cos(uTime * 0.23 + aSeed.w * 13.0)) * 2.2; xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; float gy = ground(xz); vec3 p = vec3(xz.x, gy + 0.35 + aSeed.y * 2.6 + sin(uTime * 0.6 + aSeed.w * 9.0) * 0.35, xz.y); vA = pow(max(sin(uTime * (0.8 + aSeed.w * 1.6) + aSeed.w * 40.0), 0.0), 3.0);',
      motes: 'vec2 xz = aSeed.xz * B + uWind * uTime * 0.25 + vec2(sin(uTime * 0.2 + aSeed.w * 30.0), cos(uTime * 0.17 + aSeed.y * 20.0)); xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; float gy = ground(xz); vec3 p = vec3(xz.x, gy + 0.3 + aSeed.y * 6.0 + sin(uTime * 0.3 + aSeed.w * 7.0) * 0.4, xz.y); vA = 0.55 + 0.45 * sin(uTime * 2.0 + aSeed.w * 30.0);',
      snow: 'float H = 22.0; vec2 xz = aSeed.xz * B + uWind * uTime * (1.6 + aSeed.w) + vec2(sin(uTime * 1.3 + aSeed.w * 30.0), cos(uTime * 1.1 + aSeed.y * 20.0)) * 0.35; xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; float y = uCenter.y + 14.0 - mod(aSeed.y * H + uTime * (1.1 + aSeed.w * 0.9), H); vec3 p = vec3(xz.x, y, xz.y); vA = step(ground(xz) - 0.2, y);',
      dust: 'vec2 xz = aSeed.xz * B + vec2(sin(uTime * 0.1 + aSeed.w * 30.0), cos(uTime * 0.09 + aSeed.y * 20.0)) * 1.5; xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; vec3 p = vec3(xz.x, ground(xz) + 0.2 + aSeed.y * 9.0 + sin(uTime * 0.2 + aSeed.w * 6.0) * 0.5, xz.y); vA = 0.5 + 0.5 * sin(uTime * 1.3 + aSeed.w * 20.0);',
      ash: 'float H = 24.0; vec2 xz = aSeed.xz * B + uWind * uTime * (0.9 + aSeed.w * 0.6) + vec2(sin(uTime * 0.7 + aSeed.w * 30.0), cos(uTime * 0.6 + aSeed.y * 20.0)) * 0.8; xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; float y = uCenter.y + 15.0 - mod(aSeed.y * H + uTime * (0.45 + aSeed.w * 0.4), H); vec3 p = vec3(xz.x, y, xz.y); vA = step(ground(xz) - 0.2, y) * 0.85;',
      sparks: 'float H = 16.0; vec2 xz = aSeed.xz * B + uWind * uTime * 0.6 + vec2(sin(uTime * 0.9 + aSeed.w * 30.0), cos(uTime * 0.8 + aSeed.y * 20.0)) * 0.6; xz = uCenter.xz + mod(xz - uCenter.xz + B * 0.5, B) - B * 0.5; float gy = ground(xz); float t = mod(aSeed.y * H + uTime * (0.8 + aSeed.w * 0.9), H); vec3 p = vec3(xz.x, gy + t, xz.y); vA = (1.0 - t / H) * (0.5 + 0.5 * sin(uTime * 14.0 + aSeed.w * 60.0));'
    }[kind];
    const m = new T.ShaderMaterial({
      uniforms: fogU({ uK: { value: 1 }, tHeight: { value: gridTex.height }, uGrid: { value: gridTex.uGrid } }),
      transparent: true, depthWrite: false, fog: true, blending: cfg.add ? T.AdditiveBlending : T.NormalBlending,
      vertexShader: [
        'attribute vec4 aSeed; uniform float uTime, uPx, uK; uniform vec2 uWind; uniform vec3 uCenter; uniform sampler2D tHeight; uniform vec4 uGrid; varying float vA; varying float vD;',
        'float ground(vec2 xz){ return texture2D(tHeight, (xz - uGrid.xy) / uGrid.zw).r; }',
        'void main(){ float B = ' + cfg.box.toFixed(1) + ';',
        '  ' + motion,
        '  vec4 mv = viewMatrix * vec4(p, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv;',
        '  vA *= uK * smoothstep(0.3, 2.0, vD) * (1.0 - smoothstep(B * 0.35, B * 0.5, length(p.xz - uCenter.xz)));',
        '  gl_PointSize = clamp(' + cfg.size.toFixed(3) + ' * uPx / max(vD, 0.1), 1.0, 40.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float fogDensity; varying float vA; varying float vD;', FOG_ATT,
        'void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vA * fogAtt(vD); if (a < 0.003) discard;',
        cfg.add ? '  gl_FragColor = vec4(vec3(' + cfg.col + ') * a, 1.0); }' : '  gl_FragColor = vec4(vec3(' + cfg.col + '), a); }'
      ].join('\n')
    });
    m.uniforms.uTime = uniforms.uTime; m.uniforms.uWind = uniforms.uWind; m.uniforms.uPx = fxU.uPx; m.uniforms.uCenter = fxU.uCenter;
    const pts = new T.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 4; group.add(pts);
    return { kind, mesh: pts, mat: m };
  }
  // flocks circling over a point: wings flap in the vertex shader
  function birdGeo(kind) {
    return G('bird' + kind, () => {
      const b = new GB();
      const span = kind === 'bat' ? 0.45 : kind === 'vulture' ? 1.6 : 0.9, len = kind === 'bat' ? 0.25 : kind === 'vulture' ? 0.9 : 0.5;
      // body
      const a = b.v(0, 0, len * 0.6, 0, 1, 0, 0, 0), c = b.v(-0.06, 0, -len * 0.4, 0, 1, 0, 0, 0), d = b.v(0.06, 0, -len * 0.4, 0, 1, 0, 0, 0), t = b.v(0, 0, -len * 0.8, 0, 1, 0, 0, 0);
      b.tri(a, c, d); b.tri(c, t, d);
      for (const sd of [-1, 1]) {
        const r0 = b.v(0, 0, len * 0.25, 0, 1, 0, 0, 0), r1 = b.v(0, 0, -len * 0.15, 0, 1, 0, 0, 0);
        const m0 = b.v(sd * span * 0.5, 0, len * 0.1, 0, 1, 0, 0.5, 0), m1 = b.v(sd * span * 0.5, 0, -len * 0.25, 0, 1, 0, 0.5, 0);
        const tip = b.v(sd * span, 0, kind === 'bat' ? -len * 0.1 : -len * 0.2, 0, 1, 0, 1, 0);
        if (sd > 0) { b.quad(r0, m0, m1, r1); b.tri(m0, tip, m1); } else { b.quad(r0, r1, m1, m0); b.tri(m0, m1, tip); }
      }
      return b.geo();
    });
  }
  function birdFlock(kind, n, center, radius, height, group) {
    const rng = AB.rng('flock:' + kind);
    const par = new Float32Array(n * 4), par2 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      par.set([center.x + rng.float(-12, 12), center.y + height + rng.float(-4, 6), center.z + rng.float(-12, 12), radius * rng.float(0.6, 1.3)], i * 4);
      par2.set([rng.float(0.5, 1.0) * (kind === 'bat' ? 5 : kind === 'vulture' ? 5 : 8) * (rng.chance(0.5) ? 1 : -1), rng.float(0, TAU), kind === 'bat' ? rng.float(14, 18) : kind === 'vulture' ? rng.float(1.2, 2) : rng.float(4, 7), rng.next()], i * 4);
    }
    const g = instGeo(birdGeo(kind), n, [['aP', 4, par], ['aQ', 4, par2]]);
    const m = new T.ShaderMaterial({
      uniforms: fogU({ uCol: { value: new T.Color(kind === 'bat' ? 0x0a0808 : 0x0c0c0e) } }), fog: true, side: T.DoubleSide,
      vertexShader: [
        'attribute vec4 aP; attribute vec4 aQ; uniform float uTime; varying float vD;',
        '#include <fog_pars_vertex>',
        'void main(){',
        '  float ang = aQ.y + uTime * aQ.x / aP.w;',
        '  float erratic = ' + (kind === 'bat' ? '1.0' : '0.0') + ';',
        '  vec3 c = aP.xyz + vec3(sin(ang) * aP.w, sin(uTime * 0.4 + aQ.y) * 2.5 + erratic * sin(uTime * 3.1 + aQ.w * 20.0) * 1.2, cos(ang) * aP.w);',
        '  c.x += erratic * sin(uTime * 2.3 + aQ.w * 9.0) * 2.0;',
        '  float yaw = ang + (aQ.x > 0.0 ? 1.5708 : -1.5708);',
        '  float flap = sin(uTime * aQ.z + aQ.w * 30.0);',
        '  float glide = ' + (kind === 'vulture' ? '0.35' : '1.0') + ';',
        '  vec3 lp = position; float w = abs(lp.x);',
        '  lp.y += flap * w * 0.55 * glide;',
        '  float cy = cos(yaw), sy = sin(yaw);',
        '  vec3 p = c + vec3(lp.x * cy + lp.z * sy, lp.y, -lp.x * sy + lp.z * cy);',
        '  vec4 mvPosition = viewMatrix * vec4(p, 1.0); vD = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}'
      ].join('\n'),
      fragmentShader: ['uniform vec3 uCol; varying float vD;', '#include <fog_pars_fragment>', 'void main(){ gl_FragColor = vec4(uCol, 1.0);', '#include <fog_fragment>', '}'].join('\n')
    });
    m.uniforms.uTime = uniforms.uTime;
    const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; group.add(mesh);
    return { kind, mesh };
  }
  // cosmetic placement of shafts and mist for each act (no gameplay effect)
  function planAmbientFx(act) {
    const rng = AB.rng('fxplan' + act + ':' + level.seed);
    const L = def.length;
    if (act === 1) {
      // Whisperwood: parallel shafts leaning toward the low sun, topping out at the canopy (not standing in open sky)
      const ld = ZONES[1][1].lightDir, sunYaw = Math.atan2(ld[0], ld[2]);
      for (let i = 0; i < 12; i++) { const s = rng.float(0.32 * L, 0.63 * L), p = lat(s, rng.float(-14, 14)); emit.shafts.push({ x: p.x, y: heightAt(p.x, p.z) + 4.6, z: p.z, yaw: sunYaw, spin: rng.float(-0.4, 0.4), w: rng.float(1.4, 3.0), h: 11, tilt: rng.float(0.42, 0.6), color: 0xffd8a0, a: 0.17 }); }
      for (let i = 0; i < 9; i++) { const p = lat(rng.float(0.68 * L, L - 10), rng.float(-20, 20)); emit.mist.push({ x: p.x, z: p.z, r: 16, n: 6 }); }
      for (let i = 0; i < 4; i++) { const p = lat(rng.float(0.33 * L, 0.62 * L), rng.float(-16, 16)); emit.mist.push({ x: p.x, z: p.z, r: 12, n: 3 }); }
    } else if (act === 2) {
      const hs = def.hall * L;
      for (let i = 0; i < 7; i++) { const s = rng.float(hs + 20, L - 40), p = lat(s, rng.float(-9, 9)); emit.shafts.push({ x: p.x, y: heightAt(p.x, p.z) + 9, z: p.z, yaw: rng.float(0, TAU), spin: rng.float(0, TAU), w: rng.float(1.2, 2.4), h: 22, tilt: rng.float(0, 0.18), color: 0x9ab4e0, a: 0.17 }); }
      for (let i = 0; i < 6; i++) { const p = lat(rng.float(20, hs - 20), rng.float(-14, 14)); emit.mist.push({ x: p.x, z: p.z, r: 14, n: 4 }); }
    } else if (act === 3) {
      for (let i = 0; i < 8; i++) { const p = lat(rng.float(20, L - 30), rng.float(-18, 18)); emit.mist.push({ x: p.x, z: p.z, r: 16, n: 4 }); }
    } else if (act === 'forge') {
      for (let i = 0; i < 4; i++) { const p = lat(rng.float(10, L - 10), rng.float(-14, 14)); emit.mist.push({ x: p.x, z: p.z, r: 14, n: 4 }); }
    }
  }

  // =============================================================================== LIGHT POOL (nearest N sources get a real point light)
  let pool = [];
  const poolPick = [];
  function buildLightPool(group) {
    const n = AB.quality.settings.tier === 'high' ? 6 : lean() ? 1 : AB.quality.settings.tier === 'medium' ? 3 : 1;
    pool = [];
    for (let i = 0; i < n; i++) { const l = new T.PointLight(0xffffff, 0, 10, 2); l.position.set(0, -500, 0); group.add(l); pool.push(l); }
  }
  function updateLightPool(t) {
    const f = AB.cam.focus;
    poolPick.length = 0;
    for (let i = 0; i < lightSources.length; i++) {
      const s = lightSources[i];
      const dx = s.x - f.x, dy = s.y - f.y, dz = s.z - f.z;
      s._d = dx * dx + dy * dy * 0.5 + dz * dz;
      if (s._d < (s.range * 3.2) * (s.range * 3.2) && (s.k == null || s.k > 0.01)) poolPick.push(s);
    }
    poolPick.sort((a, b) => a._d - b._d);
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i], s = poolPick[i];
      if (!s) { l.intensity = 0; l.position.y = -500; continue; }
      const d = Math.sqrt(s._d);
      const fade = 1 - sm(s.range * 1.8, s.range * 3.1, d);
      const fl = 1 + s.flick * (Math.sin(t * 9.1 + s.seed) * 0.5 + Math.sin(t * 15.3 + s.seed * 1.7) * 0.3 + Math.sin(t * 3.7 + s.seed * 0.3) * 0.2);
      l.position.set(s.x, s.y, s.z);
      l.color.copy(s.color);
      l.distance = s.range * 1.6;
      l.intensity = s.i * (s.k == null ? 1 : s.k) * fl * fade;
    }
  }

  // =============================================================================== PRESETS (sky per act, light/fog/grade per zone, blended by camera position)
  const SKY = {
    1: { zenith: 0x34557f, horizon: 0xf2a565, ground: 0x2e2a22, sunDir: [-0.7, 0.16, 0.7], sunColor: 0xffa860, glow: [1.1, 0.45, 9.0], size: 0.99955, cloud: [0.44, 0.032, 0.92, 0.0016], lit: 0xffc29a, dark: 0x5a5872, stars: 0, curve: 0.5, under: 0x000000 },
    2: { zenith: 0x0b1428, horizon: 0x4f6390, ground: 0x161c2a, sunDir: [-0.62, -0.03, 0.78], sunColor: 0xff9268, glow: [0.85, 0.0, 0.0], size: 0.9999, cloud: [0.26, 0.03, 0.85, 0.001], lit: 0x55628a, dark: 0x161c2c, stars: 1.1, curve: 0.45, under: 0x000000 },
    3: { zenith: 0x170605, horizon: 0x8c3214, ground: 0x120806, sunDir: [0.3, 0.07, 0.95], sunColor: 0xff4a18, glow: [0.9, 0.6, 2.2], size: 0.9993, cloud: [0.78, 0.024, 0.96, 0.004], lit: 0x7a2c14, dark: 0x170c0a, stars: 0, curve: 0.6, under: 0xff3a08 },
    forge: { zenith: 0x080202, horizon: 0x3a0c04, ground: 0x200604, sunDir: [0, 0.5, 0.8], sunColor: 0xff5a20, glow: [0.4, 0, 0], size: 0.9999, cloud: [0.7, 0.03, 0.9, 0.003], lit: 0x5a1a08, dark: 0x0c0404, stars: 0, curve: 0.6, under: 0xff3a08 }
  };
  const Z = (o) => Object.assign({ lightDir: null, sunC: 0xffffff, sunI: 2, hemi: [0xffffff, 0x444444, 0.5], envI: 0.5, fog: [0x888888, 0.01], exp: 1, vig: 0.38, grain: 0.05, sat: 1, con: 1.05, tint: [1, 1, 1], bloom: [0.5, 0.6, 0.85], fx: {} }, o);
  const ZONES = {
    1: [
      Z({ lightDir: [-0.7, 0.2, 0.69], sunC: 0xffb07a, sunI: 3.3, hemi: [0xa4b8d8, 0x6a5636, 0.95], envI: 0.55, fog: [0xcf9f74, 0.0058], exp: 1.12, vig: 0.3, grain: 0.04, sat: 1.06, con: 1.05, tint: [1.03, 1.0, 0.95], bloom: [0.42, 0.55, 0.88], fx: { fireflies: 0.15, motes: 0.9, shafts: 0.3, mist: 0.12 } }),
      Z({ lightDir: [-0.62, 0.28, 0.73], sunC: 0xffb070, sunI: 2.7, hemi: [0x96ac90, 0x3e3824, 0.8], envI: 0.38, fog: [0x76825c, 0.0105], exp: 1.18, vig: 0.38, sat: 1.0, con: 1.06, tint: [0.98, 1.02, 0.94], bloom: [0.5, 0.6, 0.85], fx: { fireflies: 0.75, motes: 0.6, shafts: 1, mist: 0.25 } }),
      Z({ lightDir: [-0.66, 0.18, 0.73], sunC: 0xdca27c, sunI: 1.9, hemi: [0x94a2b0, 0x323028, 0.85], envI: 0.45, fog: [0x84908f, 0.0165], exp: 1.14, vig: 0.4, sat: 0.84, con: 1.05, tint: [0.95, 0.99, 1.03], bloom: [0.5, 0.6, 0.85], fx: { fireflies: 1, motes: 0.2, shafts: 0, mist: 0.75 } })
    ],
    2: [
      Z({ lightDir: [0.45, 0.5, -0.74], sunC: 0xb0c8f4, sunI: 1.9, hemi: [0x7a94c8, 0x2e3648, 1.0], envI: 0.85, fog: [0x4e6086, 0.0088], exp: 1.32, vig: 0.36, grain: 0.05, sat: 0.9, con: 1.07, tint: [0.95, 0.98, 1.06], bloom: [0.45, 0.55, 0.86], fx: { snow: 1, dust: 0, shafts: 0.4, mist: 0.45 } }),
      Z({ lightDir: [0.45, 0.5, -0.74], sunC: 0xb0c8f4, sunI: 1.7, hemi: [0x7a94c8, 0x2e3648, 0.95], envI: 0.8, fog: [0x4a5a7e, 0.0105], exp: 1.34, vig: 0.38, grain: 0.05, sat: 0.9, con: 1.07, tint: [0.95, 0.98, 1.06], bloom: [0.5, 0.55, 0.85], fx: { snow: 1, dust: 0, shafts: 1, mist: 0.15 } }),
      Z({ lightDir: [0.3, 0.8, -0.5], sunC: 0x8090b0, sunI: 0.0, hemi: [0x7a6450, 0x1c1610, 0.62], envI: 0.12, fog: [0x2a2018, 0.0145], exp: 1.6, vig: 0.46, grain: 0.06, sat: 0.95, con: 1.08, tint: [1.05, 0.98, 0.9], bloom: [0.7, 0.6, 0.78], fx: { snow: 0, dust: 1, shafts: 1, mist: 0.15 } })
    ],
    3: [
      Z({ lightDir: [0.32, 0.26, 0.91], sunC: 0xff8a58, sunI: 2.4, hemi: [0xc87a58, 0x3c1c12, 0.95], envI: 0.55, fog: [0x8a5038, 0.0088], exp: 1.15, vig: 0.38, grain: 0.05, sat: 0.95, con: 1.07, tint: [1.05, 0.97, 0.9], bloom: [0.6, 0.6, 0.82], fx: { ash: 1, sparks: 0.45, mist: 0.2 } }),
      Z({ lightDir: [0.32, 0.26, 0.91], sunC: 0xff7a48, sunI: 2.1, hemi: [0xb86a48, 0x34160e, 0.9], envI: 0.5, fog: [0x784230, 0.0102], exp: 1.16, vig: 0.4, grain: 0.05, sat: 0.95, con: 1.08, tint: [1.06, 0.96, 0.9], bloom: [0.65, 0.6, 0.8], fx: { ash: 1, sparks: 0.75, mist: 0.2 } }),
      // the gate zone: light from the side so the 60 m gate wall does not throw the arena into its shadow
      Z({ lightDir: [0.72, 0.52, -0.3], sunC: 0xff7040, sunI: 2.6, hemi: [0xd8784a, 0x6a2410, 1.3], envI: 0.6, fog: [0x8c3e20, 0.0098], exp: 1.42, vig: 0.4, grain: 0.05, sat: 1.0, con: 1.09, tint: [1.08, 0.95, 0.88], bloom: [0.75, 0.6, 0.8], fx: { ash: 0.9, sparks: 1, mist: 0.15 } })
    ],
    forge: [
      Z({ lightDir: [0.1, 0.7, 0.7], sunC: 0xff6a3a, sunI: 0.6, hemi: [0x4a2418, 0xd85a24, 0.6], envI: 0.2, fog: [0x3e140a, 0.012], exp: 1.15, vig: 0.46, grain: 0.06, sat: 1.0, con: 1.08, tint: [1.08, 0.95, 0.88], bloom: [0.85, 0.6, 0.78], fx: { sparks: 1, ash: 0.5, mist: 0.4 } })
    ]
  };
  function presetFor(i) { const z = ZONES[actKey] || ZONES[1]; return { sky: Object.assign({}, SKY[actKey] || SKY[1], { zenith: (SKY[actKey] || SKY[1]).zenith, horizon: (SKY[actKey] || SKY[1]).horizon }), zone: z[Math.min(i, z.length - 1)] }; }
  // zone weights for lighting (act 2 switches to the halls right at the gate)
  function lightW(s) {
    if (actKey === 'forge') return [1];
    if (actKey === 2) { const hs = def.hall * def.length; const hall = sm(hs - 3, hs + 9, s); const gate = sm(hs - 40, hs - 18, s) * (1 - hall); return [Math.max(0, 1 - gate - hall), gate, hall]; }
    return zoneW(s);
  }
  const cur = { fog: new T.Color(), sunC: new T.Color(), hs: new T.Color(), hg: new T.Color(), dir: new V3(), tint: [1, 1, 1], fx: {} };
  const _c1 = new T.Color(), _c2 = new T.Color(), _v1 = new V3();
  function blendZones(s) {
    const zs = ZONES[actKey] || ZONES[1], w = lightW(s);
    const o = { sunI: 0, hemiI: 0, envI: 0, dens: 0, exp: 0, vig: 0, grain: 0, sat: 0, con: 0, b0: 0, b1: 0, b2: 0 };
    cur.fog.setRGB(0, 0, 0); cur.sunC.setRGB(0, 0, 0); cur.hs.setRGB(0, 0, 0); cur.hg.setRGB(0, 0, 0); cur.dir.set(0, 0, 0); cur.tint[0] = cur.tint[1] = cur.tint[2] = 0;
    for (const k in cur.fx) cur.fx[k] = 0;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i], k = w[i] || 0; if (k <= 0) continue;
      cur.fog.add(_c1.set(z.fog[0]).multiplyScalar(k)); o.dens += z.fog[1] * k;
      cur.sunC.add(_c1.set(z.sunC).multiplyScalar(k)); o.sunI += z.sunI * k;
      cur.hs.add(_c1.set(z.hemi[0]).multiplyScalar(k)); cur.hg.add(_c2.set(z.hemi[1]).multiplyScalar(k)); o.hemiI += z.hemi[2] * k;
      cur.dir.add(_v1.fromArray(z.lightDir || SKY[actKey].sunDir).normalize().multiplyScalar(k));
      o.envI += z.envI * k; o.exp += z.exp * k; o.vig += z.vig * k; o.grain += z.grain * k; o.sat += z.sat * k; o.con += z.con * k;
      o.b0 += z.bloom[0] * k; o.b1 += z.bloom[1] * k; o.b2 += z.bloom[2] * k;
      for (let j = 0; j < 3; j++) cur.tint[j] += z.tint[j] * k;
      for (const f in z.fx) cur.fx[f] = (cur.fx[f] || 0) + z.fx[f] * k;
    }
    cur.dir.normalize();
    return o;
  }

  // =============================================================================== LEVEL STATE (visual)
  let group = null, sun = null, hemi = null, sky = null, skyMat = null, envRT = null, ceilingMesh = null, terrainMesh = null, backdrop = null;
  let levelDisposables = [];
  let blendS = 0, cullTick = 0;
  const proxyAt = new T.Vector3(1e9, 0, 1e9);
  // trees drawn at full detail within this many metres of road (arc length) from the focus; beyond: far-scenery mesh
  const LOD_S = { high: 60, medium: 45, low: 0 };       // chunks within this arc length get per-instance LOD
  const LOD_R = { high: 42, medium: 30, low: 0 };       // full-detail radius (m) around the camera
  const lodAt = new T.Vector3(1e9, 0, 1e9);
  const TERRAIN_LOD = 60;   // terrain tiles nearer than this (m, XZ distance to the tile) use full resolution

  function buildSky(act, grp) {
    skyMat = skyMaterial();
    const s = SKY[act];
    const u = skyMat.uniforms;
    u.uZenith.value.set(s.zenith); u.uHorizon.value.set(s.horizon); u.uGround.value.set(s.ground);
    u.uSunDir.value.fromArray(s.sunDir).normalize(); u.uSunColor.value.set(s.sunColor); u.uSunSize.value = s.size;
    u.uGlow.value.fromArray(s.glow); u.uCloud.value.fromArray(s.cloud); u.uCloudLit.value.set(s.lit); u.uCloudDark.value.set(s.dark);
    u.uStars.value = s.stars; u.uCurve.value = s.curve; u.uUnder.value.set(s.under);
    if (AB.scene && AB.scene.fog) u.uFogCol.value = AB.scene.fog.color;   // live reference: the per-zone fog blend drives it
    u.uHaze.value = act === 3 || act === 'forge' ? 0.85 : act === 2 ? 0.4 : 0.35;
    if (samples) { const e = lat(mainN - 1, 0); u.uUnderDir.value.set(Math.sin(e.yaw), 0.05, Math.cos(e.yaw)).normalize(); }
    sky = new T.Mesh(G('skydome', () => new T.SphereGeometry(1000, 48, 24)), skyMat);
    sky.frustumCulled = false; sky.renderOrder = -10;
    grp.add(sky);
  }
  function buildEnv() {
    if (!AB.renderer || !skyMat) return;
    try {
      const pm = new T.PMREMGenerator(AB.renderer);
      const scn = new T.Scene();
      const m = new T.Mesh(G('envdome', () => new T.SphereGeometry(100, 32, 16)), skyMat);
      scn.add(m);
      const prev = skyMat.uniforms.uStars.value; skyMat.uniforms.uStars.value = 0;
      envRT = pm.fromScene(scn, 0.02, 0.1, 500);
      skyMat.uniforms.uStars.value = prev;
      pm.dispose();
      AB.scene.environment = envRT.texture;
    } catch (e) { console.warn('[world] environment map failed', e && e.message); }
  }
  // the vaulted ceiling of the halls / the forge cavern: a heightfield facing down
  function buildCeiling(act, grp) {
    const g = grid; if (!g.C) return;
    let i0 = g.nx, i1 = 0, j0 = g.nz, j1 = 0;
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) { const v = g.C[j * g.nx + i]; if (v === v) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; } }
    if (i1 <= i0) return;
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1); i1 = Math.min(g.nx - 1, i1 + 1); j1 = Math.min(g.nz - 1, j1 + 1);
    const ST = 2;
    const nx = Math.floor((i1 - i0) / ST) + 1, nz = Math.floor((j1 - j0) / ST) + 1;
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const gi = (j0 + j * ST) * g.nx + (i0 + i * ST), x = g.x0 + (i0 + i * ST) * CELL, z = g.z0 + (j0 + j * ST) * CELL;
      let c = g.C[gi];
      if (c !== c) c = g.H[gi] + 6;
      c = Math.max(c, g.H[gi] + 0.5);
      const k = j * nx + i;
      pos[k * 3] = x; pos[k * 3 + 1] = c; pos[k * 3 + 2] = z; uv[k * 2] = x * 0.12; uv[k * 2 + 1] = z * 0.12;
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, b, d, a, d, c); }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.BufferAttribute(pos, 3)); geom.setAttribute('uv', new T.BufferAttribute(uv, 2)); geom.setIndex(idx);
    geom.computeVertexNormals();
    const s = AB.tex.get('rock');
    const m = new T.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, color: act === 'forge' ? 0x4a3430 : 0x8a8680, side: T.DoubleSide });
    ceilingMesh = new T.Mesh(geom, m);
    ceilingMesh.castShadow = true; ceilingMesh.receiveShadow = true;
    grp.add(ceilingMesh);
  }
  // distant ridge silhouettes beyond the level (aerial perspective, no fog cut-off)
  function buildBackdrop(act, grp) {
    if (act === 'forge') return;
    const g = grid, cx = g.x0 + (g.nx - 1) * CELL / 2, cz = g.z0 + (g.nz - 1) * CELL / 2;
    const R = Math.max((g.nx - 1) * CELL, (g.nz - 1) * CELL) * 0.75 + 140;
    const segs = 96, rows = 3;
    const nz = new AB.addons.SimplexNoise({ random: AB.rng('backdrop' + act).next.bind(AB.rng('backdrop' + act)) });
    const pos = [], col = [], idx = [];
    const hBase = act === 2 ? 170 : act === 3 ? 90 : 60, hVar = act === 2 ? 190 : act === 3 ? 110 : 70;
    for (let r = 0; r <= rows; r++) for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * TAU, rr = R + r * 120;
      const ridge = Math.abs(nz.noise(Math.cos(a) * 2.2 + r, Math.sin(a) * 2.2)) * 0.7 + nz.noise(Math.cos(a) * 6 + r * 3, Math.sin(a) * 6) * 0.3;
      const h = r === 0 ? -20 : hBase * (0.4 + r * 0.25) + ridge * hVar * (0.6 + r * 0.25);
      pos.push(cx + Math.cos(a) * rr, h, cz + Math.sin(a) * rr);
      const snow = act === 2 && h > 160 ? 1 : 0;
      col.push(r / rows, snow, 0);
    }
    for (let r = 0; r < rows; r++) for (let i = 0; i < segs; i++) { const a = r * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1; idx.push(a, c, d, a, d, b); }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geom.setAttribute('aRow', new T.Float32BufferAttribute(col, 3)); geom.setIndex(idx);
    const base = act === 1 ? 0x2a3428 : act === 2 ? 0x3a4458 : 0x1a1210;
    const m = new T.ShaderMaterial({
      uniforms: { uBase: { value: new T.Color(base) }, uHaze: { value: new T.Color() }, uSnow: { value: new T.Color(0xc8d4e8) }, uK: { value: act === 2 ? 0.55 : 0.68 } },
      vertexShader: 'attribute vec3 aRow; varying vec3 vRow; varying float vH; void main(){ vRow = aRow; vH = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uBase, uHaze, uSnow; uniform float uK; varying vec3 vRow; varying float vH; void main(){ vec3 c = mix(uBase, uSnow, vRow.y * smoothstep(150.0, 230.0, vH)); float k = clamp(uK + vRow.x * 0.18 - smoothstep(60.0, 300.0, vH) * 0.12, 0.0, 0.97); gl_FragColor = vec4(mix(c, uHaze, k), 1.0); }'
    });
    backdrop = new T.Mesh(geom, m); backdrop.frustumCulled = false; backdrop.renderOrder = -5;
    grp.add(backdrop);
  }

  // =============================================================================== BUILD / DISPOSE
  // Layout (road, heights, POIs, colliders, vegetation placement) is deterministic and quality-independent; visuals are
  // rebuilt in place when the quality tier changes (same layout, same POI objects).
  let vegItems = null, builtTier = null;
  // software rasteriser (SwiftShader / llvmpipe: headless tests, machines without a GPU): extra cosmetic cuts at low/medium
  let softGL = null;
  function isSoftGL() {
    if (softGL != null) return softGL;
    softGL = false;
    try { const gl = AB.renderer && AB.renderer.getContext(); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''; softGL = /swiftshader|llvmpipe|software/i.test(r); } catch (e) { /* ignore */ }
    return softGL;
  }
  const lean = () => isSoftGL() && AB.quality.tier !== 'high';
  function disposeVisuals() {
    if (group) { AB.util.disposeObject(group); group = null; }
    for (const d of levelDisposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    levelDisposables = [];
    if (envRT) { envRT.dispose(); envRT = null; }
    if (AB.scene) AB.scene.environment = null;
    props.clear(); poiFxMap.clear();
    sun = hemi = sky = skyMat = ceilingMesh = terrainMesh = backdrop = null;
    grassMesh = flowerMesh = null; fx = null; pool = []; cullList.length = 0; shadowProxies.length = 0; proxyAt.set(1e9, 0, 1e9); lodAt.set(1e9, 0, 1e9); waterMats.length = 0;
    lightSources = []; emit = null; terrainAO = null; gridTex = null; statics = null;
    if (level) level.group = null;
  }
  function dispose() {
    disposeVisuals();
    pieces = []; keepouts = []; hash = null; vegItems = null; aoList = []; mapCache = null;
    if (level) AB.bus.emit('level:disposed', { act: level.act });
    level = null;
    AB.world.level = null;
  }
  function build(act, seed) {
    act = act === 'forge' || act === 4 ? 'forge' : U.clamp(Number(act) || 1, 1, 3);
    seed = Number(seed) >>> 0;
    dispose();
    actKey = act; def = ACTS[act];
    const rng = AB.rng('world:' + seed + ':' + act);
    buildRoad(act, rng);
    feat = planFeatures(act, AB.rng('feat:' + seed + ':' + act));
    if (act === 1) feat.waterY = feat.fenBase - 0.22;
    const L = mainN - 1;
    const zones = def.zones.map((z) => ({ name: z[0], from: z[1] * def.length, to: z[2] * def.length }));
    level = { act, seed, name: act === 'forge' ? 'The Unmaking Forge' : ((AB.C && AB.C.acts[act - 1]) || {}).name, road: { length: L, ds: 1 },
      branches: branches.map((b) => ({ id: b.id, s0: b.s0, side: b.side, length: b.len })), pois: [], spawn: null, zones, bounds: null, colliders: [], group: null };
    AB.world.level = level;
    level.pois = makePois(act, rng);
    level.bounds = buildGrid(act, seed);
    for (const p of level.pois) p.y = heightAt(p.x, p.z);
    const sp = roadPoint(4, new V3());
    level.spawn = { x: sp.x, y: sp.y, z: sp.z, yaw: roadYaw(4) };
    // layout-stable solids: POI props, set pieces, fissures, vegetation and rocks (identical with or without rendering, at any tier)
    keepouts = []; aoList = [];
    addPoiKeepouts();
    poiColliders(act);
    planPieces(act, AB.rng('pieces:' + seed + ':' + act));
    if (act === 3) for (const fi of feat.fissures) for (let i = 0; i < fi.pts.length; i += 1) { const p = fi.pts[i], t = i / (fi.pts.length - 1); const w = fi.width * Math.sin(Math.PI * t); if (w > 0.4) level.colliders.push({ x: p.x, z: p.z, r: w + 0.35, top: 0.01 }); }
    vegItems = scatterVegetation(act, AB.rng('veg:' + seed + ':' + act));
    buildHash();
    buildVisuals();
    AB.cam.collide = camCollide;
    AB.bus.emit('level:built', { level });
    return level;
  }
  function buildVisuals() {
    const act = actKey;
    group = new T.Group(); group.name = 'level';
    level.group = group;
    builtTier = AB.quality.tier;
    lightSources = []; emit = { flames: [], smoke: [], embers: [], glints: [], shafts: [], mist: [] }; gateGlow = [];
    if (!AB.scene) { for (const poi of level.pois) props.set(poi.id, new T.Group()); return; }
    const q = AB.quality.settings;
    statics = new Map();
    terrainAO = new Float32Array(grid.nx * grid.nz * 3).fill(1);
    patchFogChunks();
    const z0 = (ZONES[act] || ZONES[1])[0];
    AB.scene.background = new T.Color(z0.fog[0]);
    AB.scene.fog = new T.FogExp2(z0.fog[0], z0.fog[1]);
    buildSky(act, group);
    hemi = new T.HemisphereLight(z0.hemi[0], z0.hemi[1], z0.hemi[2]); group.add(hemi);
    sun = new T.DirectionalLight(z0.sunC, z0.sunI);
    sun.castShadow = q.shadows;
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    const sc = sun.shadow.camera; sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 420;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
    group.add(sun); group.add(sun.target);
    buildGridTextures(act);
    buildVegetation(act, vegItems, group);
    buildPieces(act, group);
    for (const poi of level.pois) props.set(poi.id, buildProp(poi, act, group));
    planAmbientFx(act);
    terrainMesh = buildTerrainMesh(act);
    applyTerrainAO(terrainMesh);
    group.add(terrainMesh);
    buildCeiling(act, group);
    buildWater(act, group);
    buildBackdrop(act, group);
    flushStatics(group);
    buildGrassPatch(act, group);
    buildFx(act, group);
    buildLightPool(group);
    group.traverse((o) => { if (!o.isLight && (o.isInstancedMesh || (o.userData && o.userData.cull))) { o.updateMatrix(); o.matrixAutoUpdate = false; } });
    AB.scene.add(group);
    if (q.tier === 'high') buildEnv();
    blendS = 0; cullTick = 0; shadowTick = 0;
    applyPreset(0, true);
    for (const poi of level.pois) if (poi.state && poi.state !== 'hidden') onPoiUpdate({ poi });
  }
  function onQuality() {
    if (!level || !AB.scene || builtTier === AB.quality.tier) return;
    const keep = blendS;
    disposeVisuals();
    buildVisuals();
    blendS = keep;
  }

  // =============================================================================== FRAME (cosmetic)
  const _f = new V3();
  function applyPreset(s, snap) {
    if (!sun) return;
    const o = blendZones(s);
    const sc = AB.scene;
    if (sc.fog) { sc.fog.color.copy(cur.fog); sc.fog.density = o.dens * (AB.world.debugFog != null ? AB.world.debugFog : 1); }
    if (sc.background && sc.background.isColor) sc.background.copy(cur.fog);
    sun.color.copy(cur.sunC); sun.intensity = o.sunI;
    sun.userData.dir = (sun.userData.dir || new V3()).copy(cur.dir);
    hemi.color.copy(cur.hs); hemi.groundColor.copy(cur.hg); hemi.intensity = o.hemiI;
    sc.environmentIntensity = envRT ? o.envI : 0;
    if (!envRT) hemi.intensity *= 1.35;
    if (AB.renderer) AB.renderer.toneMappingExposure = o.exp;
    const pp = AB.post && AB.post.params;
    if (pp) {
      pp.vignette = o.vig; pp.grain = o.grain; pp.saturation = o.sat; pp.contrast = o.con;
      if (pp.tint && pp.tint.setRGB) pp.tint.setRGB(cur.tint[0], cur.tint[1], cur.tint[2]);
      const bp = AB.post.bloomParams; if (bp) { bp.strength = o.b0; bp.radius = o.b1; bp.threshold = o.b2; }
    }
    if (backdrop) backdrop.material.uniforms.uHaze.value.copy(cur.fog).lerp(skyMat.uniforms.uHorizon.value, 0.35);
    if (fx) {
      for (const a of fx.ambient) a.mat.uniforms.uK.value = cur.fx[a.kind] || 0;
      if (fx.shafts) fx.shafts.mat.uniforms.uShaftK.value = cur.fx.shafts != null ? Math.max(0.15, cur.fx.shafts) : 1;
      if (fx.mist) { fx.mist.mat.uniforms.uMistK.value = cur.fx.mist || 0; fx.mist.mat.uniforms.uMistCol.value.copy(cur.fog).lerp(_c1.setRGB(1, 1, 1), 0.25 * U.clamp(o.sunI / 2, 0, 1)); }
    }
    if (AB.camera) { sunU.uSunDirV.value.copy(cur.dir).transformDirection(AB.camera.matrixWorldInverse); sunU.uSunCol.value.copy(cur.sunC).multiplyScalar(Math.min(1.2, o.sunI * 0.35)); }
    sunU.uAmb.value.copy(cur.hs).multiplyScalar(o.hemiI * (envRT ? 0.12 + o.envI * 0.25 : 0.12));
    for (const wm of waterMats) { wm.uniforms.uSunDir.value.copy(cur.dir); wm.uniforms.uSunColor.value.copy(cur.sunC).multiplyScalar(Math.min(1.5, o.sunI * 0.5)); }
  }
  let lastT = 0, shadowTick = 0, gateGlow = [];
  function frame(dt) {
    const t = (uniforms.uTime.value += dt);
    // wind: slowly veering, gusting; stronger on the mountain
    const ws = actKey === 2 ? 1.5 : actKey === 3 ? 1.2 : 1.0;
    uniforms.uWind.value.set(Math.cos(t * 0.031 + 0.6) * 0.9 * ws, Math.sin(t * 0.027 + 1.1) * 0.55 * ws);
    if (!level || !sun || !AB.cam) return;
    const f = AB.cam.focus;
    const ri = roadInfo(f.x, f.z, riTmp);
    const sFocus = ri.s;
    blendS = Math.abs(ri.s - blendS) > 60 ? ri.s : U.damp(blendS, ri.s, 3, dt || 0.016);
    applyPreset(blendS);
    // sun + shadow camera follow the focus (snapped to shadow texels against shimmer)
    const d = sun.userData.dir;
    const texel = (96 / sun.shadow.mapSize.x);
    _f.set(Math.round(f.x / texel) * texel, Math.round(f.y / texel) * texel, Math.round(f.z / texel) * texel);
    sun.position.set(_f.x + d.x * 160, _f.y + d.y * 160, _f.z + d.z * 160);
    sun.target.position.copy(_f); sun.target.updateMatrixWorld();
    if (sun.castShadow) {
      const alt = AB.quality.tier !== 'high';
      sun.shadow.autoUpdate = !alt;
      if (alt && ((++shadowTick & 1) === 0 || shadowTick < 3)) sun.shadow.needsUpdate = true;
    }
    if (sky && AB.camera) sky.position.copy(AB.camera.position);
    for (let i = 0; i < gateGlow.length; i++) {
      const gg = gateGlow[i], cp = AB.camera ? AB.camera.position : f;
      let k = U.clamp((170 - Math.hypot(cp.x - gg.x, cp.z - gg.z)) / 70, 0, 1); k = k * k * (3 - 2 * k);
      gg.mat.emissiveIntensity = gg.base * k;
    }
    if (backdrop && AB.camera) { backdrop.position.x = 0; }
    // grass patch + trample
    grassU.uCenter.value.set(f.x, f.z);
    const party = AB.state && AB.state.run && AB.state.run.party;
    for (let i = 0; i < 4; i++) {
      const u = party && party[i];
      if (u && u.pos && u.alive !== false) grassU.uPush.value[i].copy(u.pos); else grassU.uPush.value[i].set(0, -999, 0);
    }
    fxU.uCenter.value.copy(f);
    if (AB.camera && AB.core) fxU.uPx.value = AB.core.height * (AB.renderer ? AB.renderer.getPixelRatio() : 1) * 0.5 / Math.tan(AB.camera.fov * Math.PI / 360);
    updateLightPool(t);
    // shadow proxies follow the focus (refilled every 3 m)
    if (shadowProxies.length) {
      const pdx = f.x - proxyAt.x, pdz = f.z - proxyAt.z;
      if (pdx * pdx + pdz * pdz > 9) { proxyAt.set(f.x, 0, f.z); updateShadowProxies(f.x, f.z, SHADOW_R); }
    }
    // distance culling of chunked meshes (cheap; a few times a second) + tree LOD by chunk (road arc length)
    if ((++cullTick % 8 === 0 || cullTick < 3) && AB.camera) {
      const cp = AB.camera.position, dd = AB.quality.settings.drawDistance;
      const sF = sFocus, lodS = LOD_S[AB.quality.tier] || 0, lodR = LOD_R[AB.quality.tier] || 0;
      const ldx = cp.x - lodAt.x, ldz = cp.z - lodAt.z, lodMoved = ldx * ldx + ldz * ldz > 16;
      if (lodMoved) lodAt.set(cp.x, 0, cp.z);
      for (let i = 0; i < cullList.length; i++) {
        const m = cullList[i], c = m.userData.cull; if (!c) continue;
        const lim = (c.far || dd) + c.r, d2 = c.c.distanceToSquared(cp);
        const vis = d2 < lim * lim;
        if (c.cast) m.castShadow = d2 < (55 + c.r) * (55 + c.r);
        if (c.lod) {      // trees/rocks: per-instance LOD inside chunks near the camera's stretch of road
          const cs = c.cs || CHUNK_S;
          const near = vis && lodR > 0 && Math.max(0, c.chunk * cs - sF, sF - (c.chunk + 1) * cs) < lodS;
          const mode = near ? 'near' : 'far';
          if (vis && (mode !== c.lod.mode || (near && lodMoved))) { splitLod(m, near, cp.x, cp.z, lodR); c.lod.mode = mode; }
          m.visible = vis && near && m.count > 0; c.lo.visible = vis && c.lo.count > 0;
        } else if (c.lo) {   // terrain tile: full resolution within TERRAIN_LOD m of the camera
          const R = c.rect, tx = Math.max(R[0] - cp.x, 0, cp.x - R[2]), tz = Math.max(R[1] - cp.z, 0, cp.z - R[3]);
          const near = tx * tx + tz * tz < TERRAIN_LOD * TERRAIN_LOD;
          c.lo.castShadow = m.castShadow;
          m.visible = vis && near; c.lo.visible = vis && !near;
        } else m.visible = vis;
      }
    }
  }

  // =============================================================================== POI reactions
  function setFlameK(idx, k) { if (fx && fx.flames && idx != null) { fx.flames.k[idx] = k; fx.flames.mesh.geometry.attributes.aK.needsUpdate = true; } }
  function setGlintK(idx, k) { if (fx && fx.glints && idx != null) { fx.glints.k[idx] = k; fx.glints.mesh.geometry.attributes.aK.needsUpdate = true; } }
  function setShaftK(idx, k) { if (fx && fx.shafts && idx != null) { fx.shafts.k[idx * 2] = k; fx.shafts.k[idx * 2 + 1] = k; fx.shafts.mesh.geometry.attributes.aK.needsUpdate = true; } }
  function onPoiUpdate({ poi }) {
    if (!poi) return;
    const g = props.get(poi.id), rec = poiFxMap.get(poi.id);
    const st = poi.state;
    if (poi.type === 'chest') {
      const open = st === 'opened';
      const lid = g && g.getObjectByName('lid'); if (lid) lid.rotation.x = open ? -1.9 : 0;
      if (rec) { for (const i of rec.glints) setGlintK(i, open ? 0 : 1); for (const s of rec.lights) s.k = open ? 0 : 1; }
    } else if (poi.type === 'camp') {
      const lit = st === 'lit' || st === 'used' || st === 'active';
      if (rec) { rec.flames.forEach((i) => setFlameK(i, lit ? 1.2 : 0.75)); for (const s of rec.lights) s.k = lit ? 1.25 : 0.8; }
    } else if (poi.type === 'event') {
      const done = st === 'cleared' || st === 'used';
      const lan = g && g.getObjectByName('lantern'); if (lan) lan.material = done ? MAT.glow(0x6a4020, 0.6) : MAT.glow(0xffa040, 1.8);
      if (rec) { for (const s of rec.lights) s.k = done ? 0.15 : 1; for (const i of rec.glints) setGlintK(i, done ? 0 : 0.6); }
    } else if (poi.type === 'shrine') {
      const used = st === 'used' || st === 'cleared';
      if (rec) { for (const i of rec.shafts) setShaftK(i, used ? 0.25 : 1); for (const s of rec.lights) s.k = used ? 0.35 : 1; }
    } else if (poi.type === 'battle' || poi.type === 'elite') {
      if (rec) { const done = st === 'cleared'; rec.flames.forEach((i) => setFlameK(i, done ? 0.35 : 1)); for (const s of rec.lights) s.k = done ? 0.3 : 1; }
    }
  }

  // =============================================================================== CAMERA COLLISION (ceilings, pillars, buildings, standing stones)
  const _cp = new V3();
  function camCollide(from, to) {
    if (!grid) return null;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz); if (L < 0.01) return null;
    const n = Math.ceil(L / 0.4);
    const cs = level ? level.colliders : null;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      _cp.set(from.x + dx * f, from.y + dy * f, from.z + dz * f);
      if (grid.C) { const c = ceilingAt(_cp.x, _cp.z); if (_cp.y > c - 0.7) return L * (i - 1) / n; }
      if (cs && hash) {
        const ci = Math.floor((_cp.x - hash.x0) / HC), cj = Math.floor((_cp.z - hash.z0) / HC);
        if (ci >= 0 && cj >= 0 && ci < hash.nx && cj < hash.nz) {
          const c0 = hash.cells[cj * hash.nx + ci], c1 = hash.cells[cj * hash.nx + ci + 1];
          for (let q = c0; q < c1; q++) {
            const c = cs[hash.items[q]];
            if (c.r < 0.9) continue;
            const ex = _cp.x - c.x, ez = _cp.z - c.z, rr = c.r * 0.85;
            if (ex * ex + ez * ez < rr * rr && _cp.y < heightAt(c.x, c.z) + (c.top || c.r * 2.2)) return L * (i - 1) / n;
          }
        }
      }
    }
    return null;
  }

  // =============================================================================== MINIMAP DATA
  let mapCache = null;
  function minimap() {
    if (!level || !samples) return null;
    if (mapCache && mapCache.level === level) return mapCache;
    const road = new Float32Array(Math.ceil(mainN / 3) * 2);
    for (let i = 0, k = 0; i < mainN; i += 3, k++) { road[k * 2] = samples.x[i]; road[k * 2 + 1] = samples.z[i]; }
    const brs = branches.map((b) => { const a = new Float32Array((b.len + 1) * 2); for (let i = 0; i <= b.len; i++) { a[i * 2] = samples.x[b.start + i]; a[i * 2 + 1] = samples.z[b.start + i]; } return { id: b.id, side: b.side, s0: b.s0, pts: a }; });
    mapCache = { level, bounds: level.bounds, road, branches: brs, canvas: null };
    return mapCache;
  }
  // top-down painted map of the level (lazy, cached per level): returns { canvas, bounds }
  function mapImage(size = 256) {
    const mm = minimap(); if (!mm || typeof document === 'undefined') return null;
    if (mm.canvas && mm.canvas.width === size) return { canvas: mm.canvas, bounds: mm.bounds };
    const b = mm.bounds, w = size, h = Math.max(32, Math.round(size * (b.maxZ - b.minZ) / (b.maxX - b.minX)));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    const pal = { 1: [[70, 84, 48], [52, 60, 38], [44, 48, 40]], 2: [[200, 208, 220], [150, 156, 168], [72, 70, 66]], 3: [[56, 46, 42], [70, 50, 40], [40, 32, 30]], forge: [[40, 30, 28], [40, 30, 28], [40, 30, 28]] }[actKey];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const wx = b.minX + (x + 0.5) / w * (b.maxX - b.minX), wz = b.minZ + (y + 0.5) / h * (b.maxZ - b.minZ);
      const ci = cellOf(wx, wz), d = grid.D[ci], s = samples.s[grid.N[ci]], hh = grid.R[ci];
      const zw = zoneW(s); let r = 0, gg = 0, bb = 0;
      for (let k = 0; k < 3; k++) { const p = pal[Math.min(k, pal.length - 1)]; const kk = zw[k] || 0; r += p[0] * kk; gg += p[1] * kk; bb += p[2] * kk; }
      const shade = U.clamp(0.75 + (hh - heightAt(wx + 3, wz + 3)) * 0.12, 0.45, 1.25);
      let k = d > samples.corr[grid.N[ci]] ? 0.55 : 1;
      if (feat.waterY != null && hh < feat.waterY) { r = 20; gg = 26; bb = 30; }
      const o = (y * w + x) * 4;
      img.data[o] = r * shade * k; img.data[o + 1] = gg * shade * k; img.data[o + 2] = bb * shade * k; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    mm.canvas = c;
    return { canvas: c, bounds: b };
  }

  // =============================================================================== API
  AB.world = {
    ACTS,
    level: null,
    uniforms,                       // { uTime, uWind } shared shader uniforms (wind for foliage/cloth)
    init() {
      patchFogChunks();
      // three's shadow pass tests object layers against the MAIN camera, so the vegetation shadow proxies (layer
      // SHADOW_LAYER only, invisible to the main pass) are let in by enabling that layer on the camera just for the
      // shadow-map render (integrator, perf)
      if (AB.renderer && !AB.renderer.shadowMap.__abProxy) {
        const sm = AB.renderer.shadowMap, base = sm.render;
        sm.render = function (lights, scene, camera) {
          const on = camera.layers.isEnabled(SHADOW_LAYER);
          if (!on) camera.layers.enable(SHADOW_LAYER);
          try { base.call(this, lights, scene, camera); } finally { if (!on) camera.layers.disable(SHADOW_LAYER); }
        };
        sm.__abProxy = true;
      }
      AB.bus.on('poi:update', onPoiUpdate);
      AB.bus.on('quality', () => {
        const a2c = AB.quality.settings.msaa > 0;
        for (const m of matCache.values()) if (m && m.alphaTest > 0 && m.map && !m.isMeshDepthMaterial && m.alphaToCoverage !== a2c) { m.alphaToCoverage = a2c; m.needsUpdate = true; }
        if (!AB.loop.fastForwarding) onQuality();
      });
      AB.loop.add('world', frame, { phase: 'frame', order: AB.loop.ORDER.world });
    },
    build, dispose,
    heightAt,
    normalAt(x, z, out) { out = out || new V3(); const e = 0.5; return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize(); },
    // isWalkable(x, z, radius): inside the corridor, not inside a solid prop
    isWalkable(x, z, radius = 0.4) { if (!grid) return true; _cp.set(x, 0, z); constrain(_cp, radius); return Math.abs(_cp.x - x) < 0.01 && Math.abs(_cp.z - z) < 0.01; },
    // clamp(pos, radius): alias of constrain (keeps a body in the walkable area)
    clamp: (pos, radius) => constrain(pos, radius),
    roadPoint, roadInfo, roadYaw, guide, constrain, surfaceAt,
    ceilingAt,                      // (x, z) -> ceiling height in halls / forge cavern, Infinity outdoors
    camCollide,                     // the hook installed as AB.cam.collide
    minimap,                        // () -> { bounds, road: Float32Array xz pairs, branches: [{id, side, s0, pts}] }
    mapImage,                       // (size) -> { canvas (painted top-down map), bounds }
    zoneAt(s) { const L = def.length; const z = def.zones.find((q) => s >= q[1] * L && s < q[2] * L); return z ? z[0] : def.zones[0][0]; },
    poi(id) { return level ? level.pois.find((p) => p.id === id) || null : null; },
    prop(id) { return props.get(id) || null; },
    stats() { return { colliders: level ? level.colliders.length : 0, lights: lightSources.length, pool: pool.length, statics: cullList.length, pieces: pieces.length }; },
    get sun() { return sun; }
  };
}
