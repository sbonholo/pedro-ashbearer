'use strict';
/* ASHBEARER v3 :: main.js
   OWNER: foundation architect. FROZEN after the foundation phase.
   Boot sequence, host hot-reload hook, and the window.__ab test/debug hooks (all delegate to AB.*).
   Init order: core -> ui -> tex -> world -> actors -> vfx -> combat -> audio -> game, then loop.start(),
   then AB.game.boot(hotData). Every module init() may return a Promise. */
{
  const loadingEl = () => document.getElementById('ab-loading');
  const say = (t) => { const el = loadingEl(); const tx = el && el.querySelector('.ab-loading-text'); if (tx) tx.textContent = t; };
  const nextFrame = () => new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } }; requestAnimationFrame(f); setTimeout(f, 50); });
  // [module, label, weight] - weights shape the progress bar (textures and the title level are the heavy parts)
  const STEPS = [
    ['ui', 'Lighting the lamps', 1],
    ['tex', 'Weaving bark, stone and cloth', 10],
    ['world', 'Raising the hills', 1],
    ['actors', 'Waking the travellers', 2],
    ['vfx', 'Gathering embers', 1],
    ['combat', 'Sharpening blades', 1],
    ['audio', 'Tuning the wind', 1],
    ['game', 'Opening the road-book', 1]
  ];
  const TITLE_W = 6;   // building the title level + first-frame shader compile
  const TOTAL_W = STEPS.reduce((a, s) => a + s[2], 0) + TITLE_W;
  let booted = false;
  async function start(data) {
    if (booted) return;
    booted = true;
    try {
      if (!AB.C) throw new Error('content data is missing');
      const boot = window.ABBoot, times = AB.bootTimes = { start: Math.round(performance.now()) };
      let t = performance.now();
      const mark = (k) => { const n = performance.now(); times[k] = Math.round(n - t); t = n; };
      AB.core.init();
      mark('core');
      let w = 0;
      for (let i = 0; i < STEPS.length; i++) {
        const [name, label, wt] = STEPS[i];
        say(label + '...');
        const m = AB[name];
        const sub = (f) => { if (boot) boot.step(w + wt * Math.min(1, Math.max(0, f)), TOTAL_W); };
        if (m && typeof m.init === 'function') await m.init(sub);
        mark(name);
        w += wt;
        AB.bus.emit('boot:progress', { module: name, label });
        if (boot) boot.step(w, TOTAL_W);
        await nextFrame();
      }
      AB.loop.start();
      AB.game.boot(data || {});
      mark('title');
      if (boot) boot.step(w + TITLE_W * 0.5, TOTAL_W);
      // keep the veil up until the title has actually rendered (first frame compiles shaders and can stall),
      // so the player never sees a frozen title screen
      await new Promise((res) => { const t0 = performance.now(); const chk = () => (AB.loop.frame >= 2 || performance.now() - t0 > 10000 ? res() : requestAnimationFrame(chk)); chk(); });
      mark('firstFrame');
      times.ready = Math.round(performance.now());
      if (boot) boot.done();
      AB.bus.emit('boot:done', {});
    } catch (e) {
      console.error('[AB.main] boot failed:', e);
      say('The road is blocked: ' + (e && e.message ? e.message : e));
      if (window.ABBoot) window.ABBoot.toast();
    }
  }

  // ---------------------------------------------------------------- debug / test hooks
  const summary = () => (AB.game && AB.game.debugState ? AB.game.debugState() : {});
  window.__ab = {
    state: () => summary(),
    newRun: (seed, partyIds) => { AB.game.newRun(seed, partyIds); return summary(); },
    goto: (act, poiId) => { AB.game.goto(act, poiId); return summary(); },
    teleport: (x, z) => { AB.game.teleport(x, z); return summary(); },
    god: (on) => { AB.state.god = on !== false; return AB.state.god; },
    fastForward: (seconds) => { const r = AB.loop.fastForward(Number(seconds) || 0); return Object.assign(summary(), { ff: r }); },
    bot: (on) => { AB.game.setBot(on !== false); return AB.state.bot; },
    screens: () => (AB.game.screens ? AB.game.screens() : { current: AB.state && AB.state.screen, history: [] }),
    fps: () => ({ fps: AB.loop.fps, tier: AB.quality.tier, auto: AB.quality.auto, measured: AB.quality.lastMeasured, calls: AB.core.stats.calls, triangles: AB.core.stats.triangles, geometries: AB.core.stats.geometries, textures: AB.core.stats.textures }),
    setQuality: (t) => { AB.quality.set(t, { auto: false, force: true }); return AB.quality.tier; },
    // extras for tools
    render: (on) => { AB.loop.render = on !== false; return AB.loop.render; },
    renderNow: () => { AB.core.renderNow(); return true; },
    errors: () => AB.loop.errors,
    bootTimes: () => AB.bootTimes || null,
    ready: () => !!(AB.core && AB.core.ready && AB.state && AB.state.screen && AB.state.screen !== 'boot'),
    // level(): the current level's POIs (copies) for tools: [{id, type, x, y, z, s, order, branch, state, radius}]
    level: () => {
      const lv = AB.world && AB.world.level;
      if (!lv) return null;
      return { act: lv.act, seed: lv.seed, length: lv.road.length, spawn: Object.assign({}, lv.spawn),
        pois: lv.pois.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y, z: p.z, s: p.s, order: p.order, branch: p.branch, state: p.state, radius: p.radius, zone: p.zone })) };
    },
    // call(path, ...args): invoke AB.<module>.<fn>(...args) by dotted path, e.g. call('game.interactNearest'). Tools only.
    call: (path, ...args) => { const parts = String(path).split('.'); const fn = parts.pop(); let o = AB; for (const k of parts) o = o && o[k]; return o && typeof o[fn] === 'function' ? o[fn](...args) : undefined; }
  };

  // ---------------------------------------------------------------- host hot reload
  try { window.claude?.hot?.snapshot?.(() => (AB.game && AB.game.snapshot ? AB.game.snapshot() : {})); } catch (e) { /* ignore */ }
  window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {});
}
