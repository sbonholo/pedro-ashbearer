'use strict';
/* ASHBEARER v3 :: game.js
   OWNER: UI lane (game flow + ui + audio). Initial version by the foundation architect.
   Run state, screen flow, POI rules, events/camps/havens/shrines/boons/forge/endings, save/load,
   hot-reload snapshot, debug helpers for window.__ab, and the bot autopilot.
   Talks to other modules ONLY through AB.* and AB.bus (see INTERFACES.md). */
{
  const C = AB.C;
  const U = AB.util;
  const V3 = AB.THREE.Vector3;
  const SAVE_KEY = 'ashbearer_v3_save';
  const MAX_ITEMS = 5;
  const CMP = {}; C.companions.forEach((c) => { CMP[c.id] = c; });
  const BEARER = C.companions.find((c) => c.bearer) || C.companions[0];
  const RECRUITS = C.companions.filter((c) => !c.bearer);
  const EVENTS = {}; C.events.forEach((e) => { EVENTS[e.id] = e; });
  const BOONS = {}; C.boons.forEach((b) => { BOONS[b.id] = b; });
  const ITEM_IDS = Object.keys(C.items);
  const ACT_NAMES = { 1: C.acts[0], 2: C.acts[1], 3: C.acts[2] };
  const INTERACT = { event: 4.5, camp: 5.5, haven: 5.5, chest: 2.8, shrine: 3.5, forge: 4.5 };
  const MODALS = ['event', 'camp', 'haven', 'boon', 'shrine', 'forge', 'pause', 'inventory', 'party', 'map'];

  // =====================================================================================
  // STATE
  // =====================================================================================
  const state = AB.state = {
    screen: 'boot', prev: null, history: [],
    modal: null,          // data for the current modal/screen (see INTERFACES.md §State)
    prompt: null,         // {text, key, poiId} interaction prompt, or null
    objective: '',
    zone: '',
    run: null,
    bot: false,
    god: false,
    hasSave: false,
    timers: {}
  };
  let pendingLoad = null;   // {act, at, fresh, rewind, wait}
  let cine = null;          // {t, dur, next}
  let snapshotJSON = null;  // run snapshot at the last checkpoint (for rewinds)
  const bot = { stuckT: 0, lastDist: 1e9, targetId: null, stuck: 0, teleports: 0, picks: 0, detourT: 0, detourSide: 1, detourN: 0, detours: 0 };

  const SCENE_MODALS = ['event', 'camp', 'haven', 'shrine', 'boon'];
  const setScreen = (name, modal) => {
    const prev = state.screen;
    if (name === 'play' && SCENE_MODALS.includes(prev) && AB.cam.mode === 'cinematic') AB.cam.stop();
    state.prev = prev;
    state.screen = name;
    state.modal = modal || null;
    if (!state.history.includes(name)) state.history.push(name);
    AB.loop.simPaused = name !== 'play';
    AB.input.gameplay = name === 'play';
    AB.input.clear();
    const root = document.getElementById('ab-root');
    if (root) root.dataset.screen = name;
    AB.bus.emit('screen', { name, prev, modal: state.modal });
  };

  // =====================================================================================
  // RUN RESOURCES (single source of truth; emit 'resource')
  // =====================================================================================
  const run = () => state.run;
  const party = () => (state.run ? state.run.party : []);
  const living = () => party().filter((m) => m.alive && !m.left);
  const companionsAlive = () => living().filter((m) => m.id !== BEARER.id);
  const hasAlive = (id) => living().some((m) => m.id === id);
  const traitOf = (id) => (CMP[id] && CMP[id].trait ? CMP[id].trait.id : null);
  const traitAlive = (t) => living().some((m) => traitOf(m.id) === t);
  const member = (id) => party().find((m) => m.id === id) || null;
  const boonSum = (type, field) => { const r = run(); if (!r) return 0; let s = 0; r.boons.forEach((id) => { const b = BOONS[id]; if (b && b.effect.type === type) s += Number(b.effect[field] || 0); }); return s; };
  const boonHas = (type) => { const r = run(); return !!r && r.boons.some((id) => BOONS[id] && BOONS[id].effect.type === type); };
  const mName = (id) => (CMP[id] ? CMP[id].name.split(' ')[0] : id);
  const chip = (text, kind) => ({ text, kind });
  const emitRes = (key, delta, reason) => { if (delta) AB.bus.emit('resource', { key, value: run()[key], delta, reason: reason || '' }); };
  const toast = (text, kind) => AB.bus.emit('toast', { text, kind: kind || 'info' });

  function gainHope(n, reason) {
    const r = run(); if (!r) return [];
    n = Math.round(Number(n) || 0); if (!n) return [];
    if (n < 0 && traitAlive('kindled_spirits')) n = -Math.round(-n * 0.7);
    // soft cap: above 70 Hope, gains (except the camp's stories) count a third, so Hope keeps some tension
    if (n > 0 && reason !== 'camp') { const room = Math.max(0, 70 - r.hope); n = Math.min(n, room) + Math.round(Math.max(0, n - room) / 3); if (!n) return []; }
    const b = r.hope; r.hope = U.clamp(r.hope + n, 0, 100); const d = r.hope - b;
    emitRes('hope', d, reason);
    return d ? [chip((d > 0 ? '+' : '') + d + ' Hope', d > 0 ? 'hope' : 'hope-loss')] : [];
  }
  function gainCorruption(n, reason) {
    const r = run(); if (!r) return [];
    n = Math.round(Number(n) || 0); if (!n) return [];
    if (n > 0) { const pct = U.clamp(boonSum('corruption_resist', 'pct'), 0, 90); if (pct) n = Math.floor(n * (1 - pct / 100)); }
    const b = r.corruption; r.corruption = U.clamp(r.corruption + n, 0, 100); r.peak = Math.max(r.peak, r.corruption);
    const d = r.corruption - b;
    emitRes('corruption', d, reason);
    return d ? [chip((d > 0 ? '+' : '') + d + ' Corruption', d > 0 ? 'corr' : 'corr-down')] : [];
  }
  function gainSilver(n, reason, noBonus) {
    const r = run(); if (!r) return [];
    n = Math.round(Number(n) || 0);
    if (n > 0 && !noBonus) { const pct = boonSum('silver_bonus', 'pct'); if (pct) n = Math.round(n * (1 + pct / 100)); }
    const b = r.silver; r.silver = U.clamp(r.silver + n, 0, 999); const d = r.silver - b;
    emitRes('silver', d, reason);
    return d ? [chip((d > 0 ? '+' : '') + d + ' Silver', 'silver')] : [];
  }
  function gainSupplies(n, reason) {
    const r = run(); if (!r) return [];
    n = Math.round(Number(n) || 0);
    const b = r.supplies; r.supplies = U.clamp(r.supplies + n, 0, 99); const d = r.supplies - b;
    emitRes('supplies', d, reason);
    return d ? [chip((d > 0 ? '+' : '') + d + ' Supplies', 'sup')] : [];
  }
  function giveItem(id) {
    const r = run(); const it = C.items[id]; if (!r || !it) return [];
    if (r.items.length >= MAX_ITEMS) return [chip('Pack full: ' + it.name + ' left behind', 'info')];
    r.items.push(id);
    AB.bus.emit('item:gained', { id });
    return [chip('Gained ' + it.name, 'item')];
  }
  const hopeMult = () => { const h = run() ? run().hope : 60; return h >= 70 ? 1.2 : h >= 30 ? 1 : h >= 10 ? 0.8 : 0.65; };
  const hopeState = (h) => (h >= 70 ? 'Inspired' : h >= 30 ? 'Steady' : h >= 10 ? 'Weary' : 'Despairing');
  const corruptionMult = () => { const c = run() ? run().corruption : 0; return c >= 70 ? 1.5 : c >= 40 ? 1.25 : 1; };
  const corrState = (c) => (c >= 70 ? 'Ember-bound' : c >= 40 ? 'Ember-touched' : 'Quiet');

  // =====================================================================================
  // NEW RUN / SAVE / LOAD
  // =====================================================================================
  function newRunObj(seed, partyIds) {
    seed = Math.floor(Math.abs(Number(seed)));
    if (!isFinite(seed) || seed <= 0) seed = 10000 + Math.floor(Math.random() * 90000);
    let ids = Array.isArray(partyIds) ? partyIds.filter((id) => RECRUITS.some((r) => r.id === id)) : [];
    ids = Array.from(new Set(ids)).slice(0, 3);
    const pr = AB.rng('pick' + seed);
    const pool = RECRUITS.map((r) => r.id).filter((id) => !ids.includes(id));
    while (ids.length < 3 && pool.length) ids.push(pool.splice(Math.floor(pr.next() * pool.length), 1)[0]);
    AB.rand = AB.rng('road' + seed);
    return {
      v: 3, seed, act: 1,
      hope: 60, corruption: 0, peak: 0, silver: 15, supplies: 12,
      party: [BEARER.id].concat(ids).map((id) => AB.combat.makeHero(id)),
      controlled: BEARER.id,
      items: [], boons: [], seen: [], rookDone: false,
      poi: {}, havens: {}, explored: [],
      checkpoint: { act: 1, poiId: null },
      lost: [], memorialsPending: [],
      supplyMeter: 0, timers: { regen: 0, starve: 0, ash: 0, whisper: 0, bound: 0, weary: 0 },
      stats: { distance: 0, battles: 0, elites: 0, bosses: 0, chests: 0, events: 0, timeSec: 0, rewinds: 0, discoveries: 0 },
      ending: null
    };
  }
  function serializeRun(r) {
    r = r || run(); if (!r) return null;
    const o = {};
    for (const k in r) { if (k !== 'party') o[k] = r[k]; }
    o.party = r.party.map((m) => ({ id: m.id, hp: m.hp, maxHp: m.maxHp, alive: m.alive, left: !!m.left, fell: m.fell || null }));
    o.rng = AB.rand.state;
    return JSON.parse(JSON.stringify(o));
  }
  function deserializeRun(o) {
    const r = JSON.parse(JSON.stringify(o));
    r.party = o.party.map((p) => { const u = AB.combat.makeHero(p.id); u.hp = p.hp; u.maxHp = p.maxHp; u.alive = p.alive; u.left = p.left; u.fell = p.fell; if (u.alive && !(u.hp > 0)) u.hp = 1; return u; });
    AB.rand = AB.rng(1); AB.rand.state = o.rng >>> 0;
    delete r.rng;
    return r;
  }
  function save() {
    const r = run(); if (!r || r.ending) return false;
    const ok = AB.store.set(SAVE_KEY, { v: 3, run: serializeRun(r), at: Date.now() });
    state.hasSave = ok || state.hasSave;
    AB.bus.emit('save', { ok });
    return ok;
  }
  function loadSave() { const s = AB.store.get(SAVE_KEY, null); return s && s.v === 3 && s.run ? s : null; }
  function saveInfo() {
    const s = loadSave(); if (!s) return null;
    const a = s.run.act;
    return { act: a, seed: s.run.seed, at: s.at || 0, label: (a >= 4 ? 'The Forge' : 'Act ' + ['', 'I', 'II', 'III'][a] + ', ' + ((ACT_NAMES[a] || {}).name || '')) + ' \u00b7 Road No. ' + s.run.seed };
  }
  function clearSave() { AB.store.remove(SAVE_KEY); state.hasSave = false; }

  // =====================================================================================
  // LEVELS
  // =====================================================================================
  function encounterGroup(act, poi, battleIndex, nBattles) {
    const enc = C.encounters[act] || C.encounters[1];
    const r = AB.rng('enc:' + run().seed + ':' + act + ':' + poi.id);
    if (poi.type === 'boss') return enc.boss[0].slice();
    if (poi.type === 'elite') return r.pick(enc.elite).slice();
    const g = enc.normal;
    const base = nBattles > 1 ? Math.round((battleIndex * (g.length - 1)) / (nBattles - 1)) : 0;
    const grp = g[U.clamp(base + r.int(-1, 0), 0, g.length - 1)].slice();
    if (grp.length < 4) grp.push(grp[0]);   // real-time fights: one more of the leader's kind (max 4 foes)
    return grp;
  }
  function startLevel(act, opts = {}) {
    pendingLoad = { act, at: opts.at || null, fresh: !!opts.fresh, rewind: !!opts.rewind, card: opts.card !== false && !!opts.fresh, wait: 2, near: opts.near || null };
    setScreen('loading', { act, rewind: !!opts.rewind, label: act === 'forge' ? 'The Unmaking Forge' : (ACT_NAMES[act] ? ACT_NAMES[act].name : '') });
  }
  function doLoad() {
    const p = pendingLoad; pendingLoad = null;
    const r = run();
    const act = p.act;
    AB.combat.clear();
    const level = AB.world.build(act, r.seed);
    r.act = act === 'forge' ? 4 : act;
    // POI content + encounters
    const battles = level.pois.filter((q) => q.type === 'battle').sort((a, b) => a.order - b.order);
    level.pois.forEach((poi) => {
      poi.state = r.poi[poi.id] || 'hidden';
      poi.interactR = INTERACT[poi.type] || 0;
      if (poi.type === 'battle' || poi.type === 'elite' || poi.type === 'boss') {
        poi.content = { group: encounterGroup(act, poi, battles.indexOf(poi), battles.length) };
        if (poi.state !== 'cleared') AB.combat.spawnEncounter({ id: poi.id, poiId: poi.id, kind: poi.type, enemyIds: poi.content.group, x: poi.x, z: poi.z, yaw: poi.yaw, radius: poi.radius });
      }
      AB.bus.emit('poi:update', { poi });
    });
    // place the party
    let sx = level.spawn.x, sz = level.spawn.z, syaw = level.spawn.yaw;
    const at = p.at ? level.pois.find((q) => q.id === p.at) : null;
    if (at) {
      // POI yaw faces the direction the player approaches from: stand in front of it, within reach if interactable
      const back = at.interactR ? Math.max(2, at.interactR * 0.55) : at.type === 'boss' ? 12 : 9;
      const pp = new V3(at.x + Math.sin(at.yaw) * back, 0, at.z + Math.cos(at.yaw) * back);
      AB.world.constrain(pp, 0.5);
      sx = pp.x; sz = pp.z;
      syaw = U.yawTo(at.x - sx, at.z - sz);
    }
    if (p.near) { sx = p.near.x; sz = p.near.z; }
    AB.combat.placeParty(sx, sz, syaw);
    if (at && at.type === 'camp' && AB.combat.calmNear) AB.combat.calmNear(sx, sz, 45, 6);
    const ctl = member(r.controlled);
    AB.combat.setControlled(ctl && ctl.alive && !ctl.left ? ctl : member(BEARER.id));
    AB.cam.follow(AB.combat.controlled(), { yaw: syaw + Math.PI, pitch: 0.32, dist: 7.5, snap: true });
    AB.quality.measure();
    state.zone = '';
    state.farS = 0;
    updateObjective(true);
    if (act === 'forge') {
      AB.bus.emit('music', { mode: 'forge' });
      setScreen('play');
      toast('The heat of the Forge rolls up the stair.', 'corr');
      return;
    }
    if (p.fresh) {
      r.checkpoint = { act, poiId: null };
      snapshotJSON = JSON.stringify(serializeRun(r));
      save();
      AB.bus.emit('act:start', { act, level });
    }
    AB.bus.emit('music', { mode: 'explore', act });
    if (p.card) {
      const a = ACT_NAMES[act];
      cine = { t: 0, dur: 14, next: 'play' };
      setScreen('actcard', { act, name: a.name, region: a.region, intro: a.intro, numeral: ['', 'I', 'II', 'III'][act] });
      flyover(level);
    } else setScreen('play');
  }
  function flyover(level) {
    // cosmetic camera sweep over the first stretch of road (never gates flow)
    const a = AB.world.roadPoint(0, new V3()), b = AB.world.roadPoint(Math.min(level.road.length, 120), new V3());
    const ha = AB.world.heightAt(a.x, a.z), hb = AB.world.heightAt(b.x, b.z);
    AB.cam.play([
      { from: [b.x + 34, hb + 30, b.z + 14], to: [a.x + 12, ha + 8, a.z - 15], lookFrom: [b.x, hb + 2, b.z], lookTo: [a.x, ha + 1.5, a.z], dur: 13.5 }
    ], { onDone: () => { if (AB.combat.controlled()) AB.cam.follow(AB.combat.controlled(), { snap: true }); } });
  }

  // =====================================================================================
  // OBJECTIVE / PROMPT / DISCOVERY
  // =====================================================================================
  const poiDone = (poi) => {
    const s = poi.state;
    if (poi.type === 'battle' || poi.type === 'elite' || poi.type === 'boss') return s === 'cleared';
    if (poi.type === 'chest') return s === 'opened';
    if (poi.type === 'event' || poi.type === 'shrine') return s === 'cleared' || s === 'used';
    if (poi.type === 'camp') return s === 'used';
    if (poi.type === 'haven') return s === 'used';
    return false;
  };
  function setPoiState(poi, s) {
    if (!poi || poi.state === s) return;
    poi.state = s;
    run().poi[poi.id] = s;
    AB.bus.emit('poi:update', { poi });
  }
  function nextMainPoi() {
    const lv = AB.world.level; if (!lv) return null;
    // progress floor: optional roadside stops the player has already walked past stop being the objective
    const u = AB.combat.controlled();
    if (u && lv.act !== 'forge') state.farS = Math.max(state.farS || 0, AB.world.roadInfo(u.pos.x, u.pos.z).s);
    const far = (state.farS || 0) - 12;
    // (a battle stays the objective until the player is well past it: fleeing one by 30+ m moves the objective on)
    return lv.pois.filter((p) => !p.branch && !poiDone(p) && p.type !== 'chest' && (p.type === 'boss' || p.s > far - (p.type === 'battle' ? 30 : 0))).sort((a, b) => a.order - b.order)[0] || null;
  }
  const DISCOVER = { chest: 'Something glints off the road.', shrine: 'A wayside shrine stands nearby.', haven: 'Lamplight ahead: a haven.', elite: 'Something big is guarding a hoard down that path.', event: 'Someone is waiting down that path.' };
  const OBJ = {
    battle: (p) => 'Follow the road through ' + (state.zone || p.zone || 'the wilds'),
    event: (p) => 'Follow the road through ' + (state.zone || p.zone || 'the wilds'),
    camp: () => 'Make camp by the fire ahead',
    haven: () => 'Reach the haven on the road',
    boss: () => { const b = C.enemies[(C.encounters[run().act] || {}).boss ? C.encounters[run().act].boss[0][0] : ''] || {}; return 'Face ' + (b.name || 'what waits at the end of the road'); },
    forge: () => 'Walk to the edge of the Forge'
  };
  function updateObjective(force) {
    const r = run(); if (!r || !AB.world.level) return;
    const p = nextMainPoi();
    let text = '';
    if (AB.world.level.act === 'forge') text = OBJ.forge();
    else if (p) text = (OBJ[p.type] || OBJ.battle)(p);
    else text = 'The road ends here';
    if (force || text !== state.objective) { state.objective = text; AB.bus.emit('objective', { text, poiId: p ? p.id : null }); }
  }
  function updatePrompt(u) {
    const lv = AB.world.level; let best = null, bd = 1e9;
    if (lv && u && !AB.combat.inCombat) {
      for (const p of lv.pois) {
        const R = p.interactR || 0; if (!R) continue;
        if (poiDone(p) && p.type !== 'haven' && p.type !== 'camp') continue;
        if (p.type === 'camp' && p.state === 'used') continue;
        const d = U.dist2(u.pos.x, u.pos.z, p.x, p.z);
        if (d < R && d < bd) { bd = d; best = p; }
      }
    }
    const PT = { event: 'Investigate', camp: 'Make camp', haven: 'Trade', chest: 'Open the chest', shrine: 'Kneel at the shrine', forge: 'Approach the edge' };
    const np = best ? { text: PT[best.type] || 'Interact', key: 'E', poiId: best.id } : null;
    if ((np && (!state.prompt || state.prompt.poiId !== np.poiId)) || (!np && state.prompt)) { state.prompt = np; AB.bus.emit('prompt', { prompt: np }); }
    return best;
  }

  // =====================================================================================
  // INTERACTIONS
  // =====================================================================================
  // Cosmetic: while a camp, haven, shrine or stranger is open, the camera drifts slowly around that place, framed
  // clear of the folio (left side on wide screens, top on portrait phones). Never gates flow.
  function poiShot(poi) {
    const u = AB.combat.controlled(); if (!u || !AB.camera || !poi || poi.type === 'forge') return;
    const W = AB.core.width || 800, H = AB.core.height || 500, asp = W / H;
    const tv = Math.tan((AB.cam.baseFov || 52) * Math.PI / 360), th = tv * asp;
    const nx = asp >= 1.15 && W >= 1000 ? -0.42 : 0, ny = asp < 1 ? 0.42 : 0;
    const py = AB.world.heightAt(poi.x, poi.z);
    const T = new V3(poi.x, py + 1.1, poi.z);
    const a0 = U.yawTo(u.pos.x - poi.x, u.pos.z - poi.z) + 0.45, D = poi.type === 'chest' ? 5 : 7.2;
    const cam = (a, d) => { const c = new V3(T.x + Math.sin(a) * d, T.y + d * 0.3, T.z + Math.cos(a) * d); c.y = Math.max(c.y, AB.world.heightAt(c.x, c.z) + 1.2); return c; };
    const look = (c) => { const fx = T.x - c.x, fz = T.z - c.z, fl = Math.hypot(fx, fz) || 1, rx = -fz / fl, rz = fx / fl, d = fl; return new V3(T.x + rx * (-nx) * d * th, T.y - ny * d * tv, T.z + rz * (-nx) * d * th); };
    const c0 = cam(a0, D), c1 = cam(a0 - 0.35, D * 0.88);
    AB.cam.play([{ from: AB.cam.position.clone(), to: c0, lookFrom: AB.cam.focus.clone(), lookTo: look(c0), dur: 1.1 }, { from: c0, to: c1, lookFrom: look(c0), lookTo: look(c1), dur: 26, ease: 'inOut' }, { from: c1, to: c1, lookFrom: look(c1), lookTo: look(c1), dur: 1e5 }]);
  }
  function interact(poi) {
    const r = run(); if (!r || !poi || state.screen !== 'play') return false;
    if (AB.combat.inCombat) { toast('Not while blades are out.', 'info'); return false; }
    AB.bus.emit('poi:interact', { poi });
    if (poi.type === 'event' || poi.type === 'camp' || poi.type === 'haven' || poi.type === 'shrine') { if (!(poi.type === 'event' && poiDone(poi)) && !(poi.type === 'shrine' && poiDone(poi))) poiShot(poi); }
    switch (poi.type) {
      case 'event': if (poiDone(poi)) return false; openEvent(poi); return true;
      case 'camp': openCamp(poi); return true;
      case 'haven': openHaven(poi); return true;
      case 'chest': openChest(poi); return true;
      case 'shrine': if (poiDone(poi)) return false; setScreen('shrine', shrineModal(poi)); return true;
      case 'forge': setScreen('forge', forgeModal()); return true;
      default: return false;
    }
  }
  function openChest(poi) {
    if (poi.state === 'opened') return;
    const r = run(); const rr = AB.rng('chest:' + r.seed + ':' + poi.id);
    let chips = gainSilver(rr.int(6, 16), 'chest');
    if (rr.chance(0.45)) chips = chips.concat(giveItem(rr.pick(ITEM_IDS)));
    else chips = chips.concat(gainSupplies(rr.int(1, 3), 'chest'));
    setPoiState(poi, 'opened');
    r.stats.chests++;
    AB.bus.emit('sfx', { name: 'chest', pos: { x: poi.x, y: poi.y, z: poi.z } });
    toast('Chest: ' + chips.map((c) => c.text).join(', '), 'loot');
  }

  // ---------------- events
  const QUIET = {
    id: '__quiet', title: 'A Quiet Stretch', acts: [1, 2, 3], once: false,
    text: 'The road runs empty for a while. Wind in the grass, a crow on a post, nothing that wants you dead. You walk, and for an hour the Emberheart is only a weight.',
    choices: [
      { label: 'Walk on in silence', outcome: { text: 'You make good time and spend nothing.', effects: [{ type: 'hope', amount: 3 }] } },
      { label: 'Search the ditches for anything useful', outcome: { chance: 0.5, success: { text: 'A dropped satchel, still half full.', effects: [{ type: 'supplies', amount: 2 }] }, fail: { text: 'Nettles, and nothing else.', effects: [] } } }
    ]
  };
  const eventDef = (id) => (id === QUIET.id ? QUIET : EVENTS[id]);
  const revivable = () => party().filter((m) => !m.alive && m.id !== BEARER.id && !m.left);
  const choiceEffects = (ch) => { const o = (ch && ch.outcome) || {}; return [].concat(o.effects || [], (o.success || {}).effects || [], (o.fail || {}).effects || []); };
  function whenOk(w) {
    if (!w) return true; const r = run();
    if (w.minCorruption != null && r.corruption < w.minCorruption) return false;
    if (w.maxCorruption != null && r.corruption > w.maxCorruption) return false;
    if (w.companion && !hasAlive(w.companion)) return false;
    if (w.minAct != null && r.act < w.minAct) return false;
    return true;
  }
  function pickEvent() {
    const r = run();
    const needsFallen = (e) => (e.choices || []).some((c) => choiceEffects(c).some((x) => x.type === 'revive'));
    const ok = (e) => e.id !== 'rook_hunger' && Array.isArray(e.acts) && e.acts.includes(r.act) && whenOk(e.when) && !r.seen.includes(e.id) && (!needsFallen(e) || revivable().length > 0);
    const pool = C.events.filter(ok);
    if (!pool.length) return QUIET;
    return AB.rand.weighted(pool, (e) => (e.acts.length === 1 ? 3 : 2));
  }
  function unmetReason(req) {
    if (!req) return null; const r = run();
    if (req.silver != null && r.silver < req.silver) return 'Needs ' + req.silver + ' silver';
    if (req.supplies != null && r.supplies < req.supplies) return 'Needs ' + req.supplies + (req.supplies === 1 ? ' supply' : ' supplies');
    if (req.hope != null && r.hope < req.hope) return 'Needs Hope ' + req.hope;
    if (req.companion && !hasAlive(req.companion)) return 'Needs ' + mName(req.companion);
    if (req.item && !r.items.includes(req.item)) return 'Needs ' + ((C.items[req.item] || {}).name || 'an item');
    return null;
  }
  function choiceWhy(ch) {
    const why = unmetReason(ch && ch.requires); if (why) return why;
    if (choiceEffects(ch).some((e) => e.type === 'revive') && !revivable().length) return 'No one has fallen';
    return null;
  }
  function choiceChance(ch) {
    const o = ch.outcome || {}; let p = Number(o.chance != null ? o.chance : 1);
    const b = o.chanceBonus; if (b && b.companion && hasAlive(b.companion)) p += Number(b.amount || 0);
    return U.clamp(p, 0, 1);
  }
  function fillTokens(t, extra) {
    const comp = (extra && extra.companion) || (companionsAlive()[0] || {}).id;
    return String(t || '').replace(/\{wren\}/g, mName(BEARER.id)).replace(/\{companion\}/g, comp ? mName(comp) : 'a friend');
  }
  function eventTargets(t) {
    const live = living();
    if (t === 'all') return live;
    if (t === 'random') return live.length ? [AB.rand.pick(live)] : [];
    if (t === 'bearer') return live.filter((m) => m.id === BEARER.id);
    if (t === 'lowest') return live.length ? [live.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]] : [];
    const m = member(t); return m && m.alive && !m.left ? [m] : [];
  }
  function applyEventEffects(effects, follow) {
    const chips = [];
    const hasBattle = (effects || []).some((e) => e.type === 'battle');
    (effects || []).forEach((e) => {
      if (hasBattle && e.type !== 'battle') return;   // spoils of that fight (applied on victory)
      switch (e.type) {
        case 'supplies': chips.push(...gainSupplies(e.amount, 'event')); break;
        case 'silver': chips.push(...gainSilver(e.amount, 'event')); break;
        case 'hope': chips.push(...gainHope(e.amount, 'event')); break;
        case 'corruption': chips.push(...gainCorruption(e.amount, 'event')); break;
        case 'heal': { const ts = eventTargets(e.target); let tot = 0; ts.forEach((m) => { tot += AB.combat.heal(m, Number(e.amount) || 0, { kind: 'event' }); }); if (tot > 0) chips.push(chip('+' + tot + ' HP', 'heal')); break; }
        case 'damage': { const ts = eventTargets(e.target); ts.forEach((m) => { const a = Math.min(Number(e.amount) || 0, m.hp - 1); if (a > 0) AB.combat.damage(m, a, { kind: 'event', nonlethal: true }); }); if (ts.length) chips.push(chip('-' + e.amount + ' HP', 'hurt')); break; }
        case 'maxhp': {
          const ts = eventTargets(e.target); const a = Math.round(Number(e.amount) || 0);
          ts.forEach((m) => { m.maxHp = Math.max(1, m.maxHp + a); m.hp = a > 0 ? Math.min(m.maxHp, m.hp + a) : Math.min(m.hp, m.maxHp); });
          if (ts.length) chips.push(chip((a > 0 ? '+' : '') + a + ' max HP', a >= 0 ? 'heal' : 'hurt')); break;
        }
        case 'item': { const id = e.id === 'random' ? AB.rand.pick(ITEM_IDS) : e.id; if (id) chips.push(...giveItem(id)); break; }
        case 'battle': {
          const spoils = (effects || []).filter((x) => x.type !== 'battle');
          follow.push({ t: 'battle', tier: e.tier === 'elite' ? 'elite' : 'normal', spoils });
          chips.push(chip(e.tier === 'elite' ? 'A hard fight ahead' : 'A fight ahead', 'battle'));
          break;
        }
        case 'lose_companion': {
          const pool = companionsAlive(); const m = e.target === 'random' ? AB.rand.pick(pool) : pool.find((x) => x.id === e.target);
          if (m) { m.alive = false; m.left = true; m.fell = 'Left the fellowship'; if (!run().lost.includes(m.id)) run().lost.push(m.id); AB.combat.despawn(m); chips.push(chip(mName(m.id) + ' is gone', 'loss')); AB.bus.emit('hero:left', { unit: m }); }
          break;
        }
        case 'revive': {
          const m = AB.rand.pick(revivable());
          if (m) { m.alive = true; m.fell = null; m.hp = Math.max(1, Math.round(m.maxHp * (Number(e.hpPct) || 50) / 100)); run().lost = run().lost.filter((x) => x !== m.id); AB.combat.rejoin(m); chips.push(chip(mName(m.id) + ' returns', 'heal')); }
          break;
        }
        case 'boon': follow.push({ t: 'boon' }); chips.push(chip('A boon is offered', 'boon')); break;
        default: break;
      }
    });
    return chips;
  }
  function eventModal(ev, poi, src) {
    return {
      kind: 'event', src: src || 'poi', poiId: poi ? poi.id : null, id: ev.id, title: ev.title, text: fillTokens(ev.text), phase: 'choose',
      choices: ev.choices.map((ch) => {
        const why = choiceWhy(ch);
        const o = ch.outcome || {};
        return { label: ch.label, disabled: !!why, why: why || '', odds: typeof o.chance === 'number' ? Math.round(choiceChance(ch) * 100) : null };
      }),
      outcome: null, chips: [], follow: []
    };
  }
  function openEvent(poi) {
    const r = run();
    let ev = poi.content && poi.content.eventId ? eventDef(poi.content.eventId) : null;
    if (!ev) { ev = pickEvent(); poi.content = Object.assign(poi.content || {}, { eventId: ev.id }); }
    if (ev.id !== QUIET.id && !r.seen.includes(ev.id)) r.seen.push(ev.id);
    setPoiState(poi, 'active');
    setScreen('event', eventModal(ev, poi, 'poi'));
  }
  function chooseEvent(i) {
    const m = state.modal; const r = run();
    if (state.screen !== 'event' || !m || m.phase !== 'choose') return false;
    const ev = eventDef(m.id); const ch = ev && ev.choices[i];
    if (!ch || choiceWhy(ch)) return false;
    const pre = [];
    if (ch.requires && ch.requires.item) { const k = r.items.indexOf(ch.requires.item); if (k >= 0) { r.items.splice(k, 1); pre.push(chip('Used ' + C.items[ch.requires.item].name, 'item')); } }
    let out = ch.outcome || { text: '', effects: [] }; let ok = null;
    if (typeof out.chance === 'number') { ok = AB.rand.next() < choiceChance(ch); out = (ok ? out.success : out.fail) || { text: '', effects: [] }; }
    const follow = [];
    const chips = pre.concat(applyEventEffects(out.effects, follow));
    m.phase = 'outcome'; m.choice = i; m.ok = ok; m.outcome = fillTokens(out.text || ''); m.chips = chips; m.follow = follow;
    if (ev.id === 'rook_hunger') r.rookDone = true;
    r.stats.events++;
    AB.bus.emit('event:choice', { id: ev.id, choice: i, ok });
    AB.bus.emit('screen', { name: 'event', prev: 'event', modal: m });
    return true;
  }
  function continueEvent() {
    const m = state.modal; if (state.screen !== 'event' || !m || m.phase !== 'outcome') return false;
    const lv = AB.world.level; const poi = lv && m.poiId ? lv.pois.find((p) => p.id === m.poiId) : null;
    if (poi && poi.type === 'event') setPoiState(poi, 'cleared');
    save();
    if (checkLoss()) return true;
    const follow = m.follow || [];
    if (m.src === 'camp') { setScreen('camp', campModal(poi)); return true; }
    setScreen('play');
    for (const f of follow) {
      if (f.t === 'battle') eventBattle(f.tier, f.spoils, poi);
      if (f.t === 'boon') { openBoon('event'); break; }
    }
    return true;
  }
  function eventBattle(tier, spoils, poi) {
    const r = run(); const act = r.act;
    const enc = C.encounters[act];
    const g = tier === 'elite' ? AB.rand.pick(enc.elite) : AB.rand.pick(enc.normal.slice(0, 5));
    const u = AB.combat.controlled();
    const yaw = u ? u.facing : 0;
    const x = (u ? u.pos.x : poi.x) + Math.sin(yaw) * 9, z = (u ? u.pos.z : poi.z) + Math.cos(yaw) * 9;
    AB.combat.spawnEncounter({ id: 'ev-' + (poi ? poi.id : 'x') + '-' + Math.floor(AB.loop.time), poiId: null, kind: tier === 'elite' ? 'elite' : 'battle', enemyIds: g.slice(), x, z, yaw: yaw + Math.PI, radius: 12, engageNow: true, spoils });
  }

  // ---------------- camp
  function campOptions() {
    const forage = 4 + (traitAlive('pathfinder') ? 3 : 0) + boonSum('forage_bonus', 'amount');
    const steady = 12 + (traitAlive('steady_light') ? 10 : 0);
    const stories = 12 + (traitAlive('kindled_spirits') ? 6 : 0);
    return [
      { id: 'rest', name: 'Rest', text: 'Everyone still standing heals to full.' },
      { id: 'forage', name: 'Forage', text: 'Gain ' + forage + ' supplies.', amount: forage },
      { id: 'steady', name: 'Steady the Bearer', text: 'Corruption -' + steady + '.', amount: steady },
      { id: 'stories', name: 'Tell Old Stories', text: 'Hope +' + stories + '.', amount: stories }
    ];
  }
  function campModal(poi) {
    const lines = C.ui.campIntro || [''];
    return { kind: 'camp', poiId: poi ? poi.id : null, intro: lines[(AB.util.hash32(poi ? poi.id : 'c') + run().act) % lines.length], options: campOptions(), done: poi ? poi.state === 'used' : false, pick: null, chips: [] };
  }
  function arriveCamp(poi) {
    const r = run();
    if (r.checkpoint.poiId === poi.id && r.checkpoint.act === r.act) return;
    r.checkpoint = { act: r.act, poiId: poi.id };
    if (poi.state === 'hidden' || poi.state === 'discovered') setPoiState(poi, 'lit');
    if (r.memorialsPending.length) { AB.bus.emit('memorial', { poi, ids: r.memorialsPending.slice() }); toast('A cairn for ' + r.memorialsPending.map(mName).join(', '), 'loss'); r.memorialsPending = []; }
    snapshotJSON = JSON.stringify(serializeRun(r));
    save();
    AB.bus.emit('checkpoint', { act: r.act, poiId: poi.id });
  }
  function openCamp(poi) {
    const r = run();
    arriveCamp(poi);
    AB.bus.emit('music', { mode: 'camp' });
    if (!r.rookDone && hasAlive('rook') && (r.corruption >= 60 || r.hope < 25) && EVENTS.rook_hunger) {
      r.rookDone = true;
      setScreen('event', eventModal(EVENTS.rook_hunger, poi, 'camp'));
      return;
    }
    setScreen('camp', campModal(poi));
  }
  function campChoose(id) {
    const m = state.modal; const r = run();
    if (state.screen !== 'camp' || !m || m.done) return false;
    const o = campOptions().find((x) => x.id === id); if (!o) return false;
    let chips = [];
    if (id === 'rest') { let tot = 0; living().forEach((u) => { tot += AB.combat.heal(u, u.maxHp, { kind: 'rest' }); }); chips.push(chip('Healed ' + tot + ' HP in all', 'heal')); }
    else if (id === 'forage') chips = gainSupplies(o.amount, 'camp');
    else if (id === 'steady') chips = gainCorruption(-o.amount, 'camp');
    else if (id === 'stories') chips = gainHope(o.amount, 'camp');
    if (!chips.length) chips.push(chip('Nothing changes', 'info'));
    m.done = true; m.pick = id; m.chips = chips;
    const lv = AB.world.level; const poi = lv && m.poiId ? lv.pois.find((p) => p.id === m.poiId) : null;
    if (poi) setPoiState(poi, 'used');
    save();
    AB.bus.emit('camp:choice', { id });
    AB.bus.emit('screen', { name: 'camp', prev: 'camp', modal: m });
    return true;
  }
  function leaveCamp() { if (state.screen !== 'camp') return false; AB.bus.emit('music', { mode: 'explore', act: run().act }); setScreen('play'); return true; }

  // ---------------- haven
  function havenModal(poi) {
    const r = run();
    let h = r.havens[poi.id];
    if (!h) { const rr = AB.rng('haven:' + r.seed + ':' + poi.id); h = r.havens[poi.id] = { stock: rr.shuffle(ITEM_IDS).slice(0, 3), sold: [false, false, false], healed: false, cleansed: false }; }
    const lines = C.ui.havenIntro || [''];
    return { kind: 'haven', poiId: poi.id, intro: lines[AB.util.hash32(poi.id) % lines.length], h, chips: [], offers: havenOffers(h) };
  }
  const HAVEN_PRICE = { supplies: 8, heal: 15, rite: 20 };
  const havenPrice = (kind, id) => { const a = U.clamp((run().act | 0) - 1, 0, 2); return Math.round((kind === 'item' ? Number((C.items[id] || {}).price || 0) : HAVEN_PRICE[kind] || 0) * [1, 1.5, 2][a]); };
  function havenWhy(h, kind, idx) {
    const r = run();
    if (kind === 'supplies') return r.silver < havenPrice('supplies') ? 'Not enough silver' : r.supplies >= 99 ? 'Pack is full' : null;
    if (kind === 'heal') return h.healed ? 'Done' : r.silver < havenPrice('heal') ? 'Not enough silver' : !living().some((m) => m.hp < m.maxHp) ? 'No one is hurt' : null;
    if (kind === 'rite') return h.cleansed ? 'Done' : r.silver < havenPrice('rite') ? 'Not enough silver' : r.corruption <= 0 ? 'No corruption' : null;
    if (kind === 'item') { const id = h.stock[idx]; if (!id || h.sold[idx]) return 'Sold'; if (r.silver < havenPrice('item', id)) return 'Not enough silver'; if (r.items.length >= MAX_ITEMS) return 'Pack full'; return null; }
    return 'Unknown';
  }
  function havenOffers(h) {
    const list = [
      { kind: 'supplies', idx: 0, name: '3 Supplies', price: havenPrice('supplies'), text: 'Bread, oil and dried meat.' },
      { kind: 'heal', idx: 0, name: 'A Night Indoors', price: havenPrice('heal'), text: 'Everyone still standing heals to full.' },
      { kind: 'rite', idx: 0, name: 'Rite of Cleansing', price: havenPrice('rite'), text: 'Corruption -15.' }
    ];
    h.stock.forEach((id, i) => list.push({ kind: 'item', idx: i, id, name: C.items[id].name, price: havenPrice('item', id), text: C.items[id].text }));
    list.forEach((o) => { o.why = havenWhy(h, o.kind, o.idx) || ''; o.disabled = !!o.why; });
    return list;
  }
  function openHaven(poi) { setScreen('haven', havenModal(poi)); }
  function havenBuy(kind, idx) {
    const m = state.modal; const r = run(); if (state.screen !== 'haven' || !m) return false;
    const h = m.h; if (havenWhy(h, kind, idx)) return false;
    let chips = [];
    const cost = havenPrice(kind, kind === 'item' ? h.stock[idx] : null);
    if (kind === 'supplies') { r.silver -= cost; emitRes('silver', -cost, 'haven'); chips = gainSupplies(3, 'haven'); }
    else if (kind === 'heal') { r.silver -= cost; emitRes('silver', -cost, 'haven'); h.healed = true; living().forEach((u) => AB.combat.heal(u, u.maxHp, { kind: 'haven' })); chips = [chip('Everyone fully healed', 'heal')]; }
    else if (kind === 'rite') { r.silver -= cost; emitRes('silver', -cost, 'haven'); h.cleansed = true; chips = gainCorruption(-15, 'haven'); }
    else if (kind === 'item') { const id = h.stock[idx]; r.silver -= cost; emitRes('silver', -cost, 'haven'); h.sold[idx] = true; chips = giveItem(id); }
    m.chips = chips; m.offers = havenOffers(h);
    AB.bus.emit('sfx', { name: 'coin' });
    AB.bus.emit('screen', { name: 'haven', prev: 'haven', modal: m });
    return true;
  }
  function leaveHaven() {
    if (state.screen !== 'haven') return false;
    const lv = AB.world.level; const poi = lv && state.modal ? lv.pois.find((p) => p.id === state.modal.poiId) : null;
    if (poi) setPoiState(poi, 'used');
    save(); setScreen('play'); return true;
  }

  // ---------------- shrine (v3-only feature; text is original)
  function shrineModal(poi) {
    const r = run();
    return {
      kind: 'shrine', poiId: poi.id, title: 'A Wayside Shrine',
      text: 'A lichen-grey stone stands where two paths meet, its face worn smooth by hands. Someone has left a candle stub in the niche. When you come near, the Emberheart goes quiet, the way a dog goes quiet near a bigger dog.',
      options: [
        { id: 'offer', label: 'Leave an offering (10 silver): Corruption -15', disabled: r.silver < 10, why: r.silver < 10 ? 'Needs 10 silver' : '' },
        { id: 'bleed', label: 'Press your palm to the stone (everyone loses 5 HP): Corruption -10', disabled: false, why: '' },
        { id: 'leave', label: 'Walk on', disabled: false, why: '' }
      ],
      done: false, chips: []
    };
  }
  function shrineChoose(id) {
    const m = state.modal;
    // "Walk on" after an offering (m.done) must still leave: the done folio's only button sends 'leave' (integrator
    // fix: a human was stuck on the shrine screen; the bot left through setScreen directly)
    if (state.screen === 'shrine' && m && m.done && id === 'leave') { setScreen('play'); return true; }
    if (state.screen !== 'shrine' || !m || m.done) return false;
    const o = m.options.find((x) => x.id === id); if (!o || o.disabled) return false;
    let chips = [];
    if (id === 'offer') { run().silver -= 10; emitRes('silver', -10, 'shrine'); chips = gainCorruption(-15, 'shrine'); }
    if (id === 'bleed') { living().forEach((u) => { const a = Math.min(5, u.hp - 1); if (a > 0) AB.combat.damage(u, a, { kind: 'event', nonlethal: true }); }); chips = gainCorruption(-10, 'shrine'); }
    const lv = AB.world.level; const poi = lv ? lv.pois.find((p) => p.id === m.poiId) : null;
    if (id !== 'leave' && poi) setPoiState(poi, 'used');
    if (id === 'leave') { setScreen('play'); return true; }
    m.done = true; m.chips = chips;
    AB.bus.emit('screen', { name: 'shrine', prev: 'shrine', modal: m });
    return true;
  }

  // ---------------- boons
  function boonOptions() {
    const r = run();
    const ok = (b) => !(b.effect.type === 'cooldown_haste' && boonHas('cooldown_haste'));
    let pool = C.boons.filter((b) => ok(b) && !r.boons.includes(b.id));
    if (pool.length < 3) pool = pool.concat(C.boons.filter((b) => ok(b) && r.boons.includes(b.id)));
    return AB.rand.shuffle(pool).slice(0, 3).map((b) => b.id);
  }
  function openBoon(src) {
    const opts = boonOptions();
    if (!opts.length) { afterBoon(src); return; }
    setScreen('boon', { kind: 'boon', src, options: opts.map((id) => ({ id, name: BOONS[id].name, text: BOONS[id].text })) });
  }
  function takeBoon(id) {
    const m = state.modal; const r = run();
    if (state.screen !== 'boon' || !m || !m.options.some((o) => o.id === id)) return false;
    const b = BOONS[id]; r.boons.push(id);
    const e = b.effect;
    if (e.type === 'maxhp_all') living().forEach((u) => { u.maxHp += Number(e.amount || 0); u.hp += Number(e.amount || 0); });
    if (e.type === 'supplies') gainSupplies(Number(e.amount || 0), 'boon');
    AB.bus.emit('boon', { id });
    afterBoon(m.src);
    return true;
  }
  function afterBoon(src) {
    const r = run();
    if (src === 'boss') {
      if (r.act < 3) { r.act += 1; startLevel(r.act, { fresh: true }); }
      else startLevel('forge', {});
    } else setScreen('play');
  }

  // ---------------- forge + endings
  function forgeState() {
    const r = run(); const c = r.corruption, h = r.hope; const alive = companionsAlive();
    if (c < 50) return { mode: 'cast' };
    if (c < 85) { if (alive.length) return { mode: 'falter', carrier: alive.slice().sort((a, b) => b.hp - a.hp)[0].id }; return { mode: 'will', p: U.clamp((100 - c) / 100, 0, 1) }; }
    return { mode: 'refuse', canRemember: h >= 70, p: 0.35 };
  }
  function forgeModal() {
    const f = forgeState();
    const opts = [];
    if (f.mode === 'cast') opts.push({ id: 'cast', label: 'Cast the Emberheart into the Forge' });
    if (f.mode === 'falter') opts.push({ id: 'carry', label: 'Let ' + mName(f.carrier) + ' take it from your hand' });
    if (f.mode === 'will') opts.push({ id: 'will', label: 'Force your hand open (' + Math.round(f.p * 100) + '%)' });
    if (f.mode === 'refuse') { if (f.canRemember) opts.push({ id: 'remember', label: 'Remember Thistledown (35%)' }); opts.push({ id: 'yield', label: 'Close your hand' }); }
    return { kind: 'forge', text: C.ui.forgeIntro, mode: f.mode, carrier: f.carrier || null, options: opts };
  }
  function forgeAct(kind) {
    if (state.screen !== 'forge') return false;
    const f = forgeState();
    if (kind === 'cast' && f.mode === 'cast') endRun('unmade');
    else if (kind === 'carry' && f.mode === 'falter') { const m = member(f.carrier); if (m) { m.alive = false; m.fell = 'Carried the Emberheart into the Forge'; } endRun('long_fall', { companion: f.carrier }); }
    else if (kind === 'will' && f.mode === 'will') endRun(AB.rand.next() < f.p ? 'unmade' : 'new_sovereign');
    else if (kind === 'remember' && f.mode === 'refuse' && f.canRemember) endRun(AB.rand.next() < f.p ? 'unmade' : 'new_sovereign');
    else if (kind === 'yield' && f.mode === 'refuse') endRun('new_sovereign');
    else return false;
    return true;
  }
  function chronicle() {
    const r = run();
    return {
      seed: r.seed, road: 'Road No. ' + r.seed, act: Math.min(3, r.act), timeSec: Math.round(r.stats.timeSec), distance: Math.round(r.stats.distance),
      battles: r.stats.battles, elites: r.stats.elites, bosses: r.stats.bosses, chests: r.stats.chests, events: r.stats.events, rewinds: r.stats.rewinds,
      peak: r.peak, lost: r.lost.map((id) => (CMP[id] || {}).name || id), boons: r.boons.map((id) => (BOONS[id] || {}).name || id), ending: r.ending ? r.ending.id : null
    };
  }
  function endRun(id, extra) {
    const r = run(); if (!r || r.ending) return;
    let comp = extra && extra.companion;
    if (!comp) { const a = companionsAlive()[0]; comp = a ? a.id : (r.lost[r.lost.length - 1] || null); }
    r.ending = { id, companion: comp, win: id === 'unmade' || id === 'long_fall' };
    clearSave();
    AB.combat.stopAll();
    const e = C.endings[id] || { title: id, text: '' };
    state.lastEnding = { id, title: e.title, text: fillTokens(e.text, { companion: comp }), win: r.ending.win, chronicle: chronicle() };
    AB.bus.emit('ending', { id, companion: comp, win: r.ending.win });
    AB.bus.emit('music', { mode: r.ending.win ? 'ending_win' : 'ending_loss' });
    cine = { t: 0, dur: 5, next: 'ending', events: [] };
    setScreen('endingcine', { id, title: e.title, win: r.ending.win });
    stageEnding(id, comp);
  }
  // A short camera sequence for each ending (cosmetic: shots + effects; the cine timer alone moves the flow on).
  function stageEnding(id, comp) {
    const u = member(BEARER.id); if (!u || !u.pos) return;
    const p = u.pos, ev = cine.events;
    const fx = (name, o) => { if (AB.vfx && AB.vfx.spawn) AB.vfx.spawn(name, o); };
    const lv = AB.world.level;
    const atForge = lv && lv.act === 'forge';
    if (atForge) {
      cine.dur = 7.5;
      // the pit lies ahead along the road from the forge edge
      const fp = lv.pois.find((q) => q.type === 'forge') || { x: p.x, z: p.z, yaw: 0 };
      const ay = U.yawTo(p.x - fp.x, p.z - fp.z) + Math.PI;           // from the edge toward the pit
      const fwx = Math.sin(ay), fwz = Math.cos(ay), rx = Math.cos(ay), rz = -Math.sin(ay);
      const pit = [p.x + fwx * 12, p.y - 6, p.z + fwz * 12];
      const over = { from: [p.x - fwx * 3.2 + rx * 1.4, p.y + 2.1, p.z - fwz * 3.2 + rz * 1.4], to: [p.x - fwx * 1.6 + rx * 0.9, p.y + 1.8, p.z - fwz * 1.6 + rz * 0.9], lookFrom: [p.x + fwx * 6, p.y + 0.6, p.z + fwz * 6], lookTo: pit, dur: 2.6 };
      const front = { from: [p.x + fwx * 4 + rx * 1.5, p.y + 0.9, p.z + fwz * 4 + rz * 1.5], to: [p.x + fwx * 3 + rx * 0.6, p.y + 1.3, p.z + fwz * 3 + rz * 0.6], lookFrom: [p.x, p.y + 1.3, p.z], lookTo: [p.x, p.y + 1.45, p.z], dur: 2.6 };
      const rise = { from: [p.x - fwx * 2 + rx * 3, p.y + 3, p.z - fwz * 2 + rz * 3], to: [p.x - fwx * 10 + rx * 8, p.y + 12, p.z - fwz * 10 + rz * 8], lookFrom: [p.x + fwx * 4, p.y, p.z + fwz * 4], lookTo: pit, dur: 3.2 };
      if (id === 'unmade') {
        AB.cam.play([over, rise]);
        ev.push({ t: 1.4, fn: () => { fx('motes', { x: p.x + fwx * 0.8, y: p.y + 1.2, z: p.z + fwz * 0.8, n: 24, color: 0xffc06a }); } });
        ev.push({ t: 2.6, fn: () => { fx('flash', { x: pit[0], y: pit[1] + 4, z: pit[2], color: 0xffe2a8, intensity: 40, dur: 1.4 }); fx('burst', { x: pit[0], y: pit[1] + 3, z: pit[2], n: 60, color: 0xffc06a, speed: 9, life: 1.6 }); AB.cam.shake(0.25, 1.2); } });
        ev.push({ t: 3.2, fn: () => { fx('wave', { x: pit[0], y: pit[1] + 2, z: pit[2], radius: 16 }); if (AB.post.fadeTo) AB.post.fadeTo(0.25, 2.5); } });
      } else if (id === 'long_fall') {
        const m = comp ? member(comp) : null;
        const mp = m && m.pos ? m.pos : p;
        AB.cam.play([front, { from: [mp.x - fwx * 3 + rx * 2, mp.y + 2, mp.z - fwz * 3 + rz * 2], to: [mp.x - fwx * 2 + rx * 1, mp.y + 2.4, mp.z - fwz * 2 + rz * 1], lookFrom: [mp.x, mp.y + 1.3, mp.z], lookTo: pit, dur: 2.2 }, rise]);
        ev.push({ t: 3.6, fn: () => { if (m && m.spawned) { fx('motes', { x: mp.x, y: mp.y + 1, z: mp.z, n: 30, color: 0xffc06a }); fx('puff', { x: mp.x, y: mp.y + 0.6, z: mp.z, n: 10, color: 0x2a1a14 }); AB.combat.despawn(m); } } });
        ev.push({ t: 5.2, fn: () => { fx('flash', { x: pit[0], y: pit[1] + 4, z: pit[2], color: 0xffe2a8, intensity: 32, dur: 1.2 }); fx('burst', { x: pit[0], y: pit[1] + 3, z: pit[2], n: 50, color: 0xffc06a, speed: 8, life: 1.5 }); AB.cam.shake(0.2, 1); } });
      } else {
        // new_sovereign: Wren turns away from the edge and the shard answers
        AB.cam.play([over, { from: [p.x + fwx * 2.6 + rx * 0.4, p.y + 0.5, p.z + fwz * 2.6 + rz * 0.4], to: [p.x + fwx * 2.0, p.y + 0.35, p.z + fwz * 2.0], lookFrom: [p.x, p.y + 1.6, p.z], lookTo: [p.x, p.y + 2, p.z], dur: 4.9 }]);
        ev.push({ t: 2.8, fn: () => { fx('flash', { x: p.x, y: p.y + 1.2, z: p.z, color: 0xff7b2e, intensity: 30, dur: 2.5 }); fx('wave', { unit: u, x: p.x, y: p.y + 0.2, z: p.z, radius: 12 }); fx('burst', { x: p.x, y: p.y + 1.2, z: p.z, n: 50, color: 0xff7b2e, speed: 6, life: 1.8 }); AB.cam.shake(0.3, 1.6); } });
        ev.push({ t: 4.4, fn: () => { if (AB.post.fadeTo) AB.post.fadeTo(0.35, 3); } });
      }
      return;
    }
    // losses on the road
    const yw = u.facing || 0, fx0 = Math.sin(yw), fz0 = Math.cos(yw);
    if (id === 'claimed') {
      AB.cam.play([{ from: [p.x + fx0 * 3.4, p.y + 1.2, p.z + fz0 * 3.4], to: [p.x + fx0 * 2.2, p.y + 1.5, p.z + fz0 * 2.2], lookFrom: [p.x, p.y + 1.1, p.z], lookTo: [p.x, p.y + 1.3, p.z], dur: 2.4 },
        { from: [p.x + fx0 * 2.2, p.y + 1.5, p.z + fz0 * 2.2], to: [p.x + fx0 * 8 + 3, p.y + 9, p.z + fz0 * 8], lookFrom: [p.x, p.y + 1.3, p.z], lookTo: [p.x, p.y + 1, p.z], dur: 2.6 }]);
      ev.push({ t: 1.6, fn: () => { fx('flash', { x: p.x, y: p.y + 1.2, z: p.z, color: 0xff7b2e, intensity: 30, dur: 2 }); fx('wave', { unit: u, x: p.x, y: p.y + 0.2, z: p.z, radius: 10 }); fx('burst', { x: p.x, y: p.y + 1.2, z: p.z, n: 40, color: 0xff7b2e, speed: 6, life: 1.4 }); } });
    } else {
      AB.cam.play([{ from: [p.x + 4, p.y + 2.2, p.z + 5], to: [p.x + 9, p.y + 7, p.z + 11], lookFrom: [p.x, p.y + 1.3, p.z], lookTo: [p.x, p.y + 1, p.z], dur: 5 }]);
      if (id === 'road_dark') ev.push({ t: 0.5, fn: () => { if (AB.post.fadeTo) AB.post.fadeTo(0.55, 4); } });
    }
  }
  function lossId() {
    const r = run(); if (!r || r.ending) return null;
    if (r.corruption >= 100) return 'claimed';
    if (r.hope <= 0) return 'road_dark';
    return null;
  }
  function checkLoss() { const id = lossId(); if (id) { endRun(id); return true; } return false; }

  // ---------------- falls / rewinds
  AB.bus.on('hero:fallen', ({ unit }) => {
    const r = run(); if (!r || r.ending || !unit) return;
    if (unit.id === BEARER.id) {
      r.stats.rewinds++;
      const before = r.hope;
      const hopeAfter = before - (traitAlive('kindled_spirits') ? Math.round(20 * 0.7) : 20);
      if (hopeAfter <= 0) { r.hope = 0; endRun('new_hand'); return; }
      toast(mName(BEARER.id) + ' falls. The road rewinds to the last fire.', 'loss');
      const snap = snapshotJSON ? JSON.parse(snapshotJSON) : serializeRun(r);
      const nr = deserializeRun(snap);
      nr.stats = Object.assign({}, r.stats);
      nr.peak = Math.max(nr.peak, r.peak);
      state.run = nr;
      gainHope(-20, 'rewind');
      if (checkLoss()) return;
      snapshotJSON = JSON.stringify(serializeRun(nr));
      AB.bus.emit('rewind', { act: nr.act, poiId: nr.checkpoint.poiId });
      startLevel(nr.act === 4 ? 'forge' : nr.act, { at: nr.checkpoint.poiId, rewind: true });
      return;
    }
    unit.alive = false;
    unit.fell = 'Fell in ' + (state.zone || 'the wilds');
    if (!r.lost.includes(unit.id)) r.lost.push(unit.id);
    r.memorialsPending.push(unit.id);
    toast(mName(unit.id) + ' has fallen.', 'loss');
    gainHope(-15, 'fallen');
    if (r.controlled === unit.id) switchTo(member(BEARER.id));
    checkLoss();
  });

  // ---------------- combat results
  AB.bus.on('combat:start', ({ enc }) => {
    if (!run()) return;
    AB.bus.emit('music', { mode: enc.kind === 'boss' ? 'boss' : 'combat' });
    if (enc.kind === 'boss') { const b = enc.foes[0]; AB.bus.emit('boss:start', { unit: b, name: b ? b.name : '' }); }
  });
  AB.bus.on('combat:end', ({ enc, result }) => {
    const r = run(); if (!r || r.ending) return;
    AB.bus.emit('music', { mode: 'explore', act: r.act });
    if (enc.kind === 'boss') AB.bus.emit('boss:end', { unit: enc.foes[0], result });
    if (result !== 'won') { if (result === 'fled') toast('You break away. They will be waiting.', 'info'); return; }
    const rr = AB.rand;
    const kind = enc.kind;
    let silver = kind === 'boss' ? 40 : kind === 'elite' ? rr.int(20, 30) : rr.int(6, 14);
    if (traitAlive('covetous')) silver = Math.round(silver * 1.25);
    let chips = gainSilver(silver, 'victory');
    let sup = kind === 'elite' ? rr.int(2, 3) : kind === 'battle' ? rr.int(0, 2) : 0;
    if (traitAlive('pathfinder')) sup += 1;
    chips = chips.concat(gainSupplies(sup, 'victory'));
    if (rr.next() < (kind === 'battle' ? 0.3 : 1)) chips = chips.concat(giveItem(rr.pick(ITEM_IDS)));
    chips = chips.concat(gainHope((kind === 'boss' ? 10 : kind === 'elite' ? 6 : 3) + boonSum('hope_on_victory', 'amount'), 'victory'));
    const heal = boonSum('heal_after_battle', 'amount'); if (heal) living().forEach((u) => AB.combat.heal(u, heal, { kind: 'boon' }));
    if (enc.spoils && enc.spoils.length) chips = chips.concat(applyEventEffects(enc.spoils, []));
    if (kind === 'boss') r.stats.bosses++; else if (kind === 'elite') r.stats.elites++; else r.stats.battles++;
    const lv = AB.world.level; const poi = lv && enc.poiId ? lv.pois.find((p) => p.id === enc.poiId) : null;
    if (poi) setPoiState(poi, 'cleared');
    toast('Victory: ' + chips.map((c) => c.text).join(', '), 'loot');
    AB.bus.emit('victory', { kind, chips });
    if (kind === 'boss') {
      AB.loop.slowmo(0.3, 0.3);
      state.timers.bossDown = 3.5;
    }
    checkLoss();
  });

  // =====================================================================================
  // ITEMS / HERO SWITCH
  // =====================================================================================
  function itemUsable(id) {
    const it = C.items[id]; if (!it) return 'Unknown';
    const inC = AB.combat.inCombat;
    if (it.use === 'battle' && !inC) return 'Only in a fight';
    if (it.use === 'map' && inC) return 'Not in a fight';
    if (it.effects.some((e) => e.type === 'flee') && !AB.combat.canFlee()) return 'Cannot flee this fight';
    return null;
  }
  function useItem(idx) {
    const r = run(); if (!r) return false;
    const id = r.items[idx]; if (!id || itemUsable(id)) return false;
    r.items.splice(idx, 1);
    AB.combat.applyEffects(C.items[id].effects, { source: AB.combat.controlled(), kind: 'item', itemId: id });
    AB.bus.emit('item:used', { id });
    toast('Used ' + C.items[id].name, 'item');
    if (state.screen === 'inventory') setScreen('inventory', inventoryModal());
    return true;
  }
  function dropItem(idx) { const r = run(); if (!r || !r.items[idx]) return false; r.items.splice(idx, 1); if (state.screen === 'inventory') setScreen('inventory', inventoryModal()); return true; }
  function quickItem() {
    const r = run(); if (!r) return false;
    for (let i = 0; i < r.items.length; i++) if (!itemUsable(r.items[i])) return useItem(i);
    toast('Nothing in the pack to use', 'info');
    return false;
  }
  function inventoryModal() {
    const r = run();
    return { kind: 'inventory', items: r.items.map((id, i) => ({ idx: i, id, name: C.items[id].name, text: C.items[id].text, why: itemUsable(id) || '' })) };
  }
  function switchTo(u) {
    if (!u || !u.alive || u.left || u.downed) return false;
    run().controlled = u.id;
    AB.combat.setControlled(u);
    AB.cam.follow(u, { snap: false });
    return true;
  }
  function switchHero(i) { const p = party().filter((m) => !m.left); return switchTo(p[i]); }

  // =====================================================================================
  // PER-STEP RULES (order 20, always)
  // =====================================================================================
  const lastPos = new V3();
  let objT = 0;
  function step(dt) {
    const sc = state.screen;
    if (pendingLoad) { if (--pendingLoad.wait <= 0) doLoad(); return; }
    if (cine) {
      cine.t += dt;
      if (cine.events) for (const ev of cine.events) { if (!ev.done && cine.t >= ev.t) { ev.done = true; try { ev.fn(); } catch (e) { console.error('[game] cine event', e); } } }
      if (cine.t >= cine.dur || (sc === 'actcard' && (AB.input.pressed('interact') || AB.input.pressed('attack') || AB.input.pressed('pause')))) {
        const n = cine.next; cine = null;
        if (n === 'ending') { setScreen('ending', state.lastEnding); AB.cam.stop({ snap: false }); }
        else { AB.cam.stop(); setScreen(n); }
      }
      return;
    }
    if (state.timers.bossDown > 0 && sc === 'play') {
      state.timers.bossDown -= dt;
      if (state.timers.bossDown <= 0) { const r = run(); if (r && !r.ending) openBoon('boss'); }
    }
    if (sc === 'pause' && AB.input.pressed('pause')) { resume(); return; }
    if ((sc === 'inventory' && AB.input.pressed('inventory')) || (sc === 'party' && AB.input.pressed('party')) || (sc === 'map' && AB.input.pressed('map'))) { resume(); return; }
    if ((sc === 'inventory' || sc === 'party' || sc === 'map') && AB.input.pressed('pause')) { resume(); return; }
    if (sc !== 'play') return;
    const r = run(); if (!r) return;
    const u = AB.combat.controlled();
    if (AB.input.pressed('pause')) { setScreen('pause', { kind: 'pause' }); return; }
    if (AB.input.pressed('inventory')) { setScreen('inventory', inventoryModal()); return; }
    if (AB.input.pressed('party')) { setScreen('party', { kind: 'party' }); return; }
    if (AB.input.pressed('map')) { setScreen('map', { kind: 'map' }); return; }
    for (let i = 0; i < 4; i++) if (AB.input.pressed('switch' + (i + 1))) switchHero(i);
    const near = updatePrompt(u);
    if (near && AB.input.pressed('interact')) { interact(near); return; }
    if (!u) return;
    r.stats.timeSec += dt;
    // distance + supplies
    const moved = U.dist2(u.pos.x, u.pos.z, lastPos.x, lastPos.z);
    lastPos.copy(u.pos);
    if (moved < 3) { r.stats.distance += moved; r.supplyMeter += moved; }
    if (r.supplyMeter >= 60) { r.supplyMeter -= 60; if (r.supplies > 0) gainSupplies(-1, 'travel'); }
    const starving = r.supplies <= 0;
    const tm = r.timers;
    if (starving) { tm.starve += dt; if (tm.starve >= 30) { tm.starve = 0; gainHope(-1, 'starving'); toast('Starving: Hope fades', 'hope-loss'); } }
    if (!AB.combat.inCombat && !starving) {
      tm.regen += dt;
      if (tm.regen >= 2) { tm.regen = 0; living().forEach((m) => { if (!m.downed && m.hp < m.maxHp) AB.combat.heal(m, 1, { kind: 'regen', silent: true }); }); }
    }
    if (r.act === 3 && AB.world.level && AB.world.level.act === 3) {
      const shelter = AB.world.level.pois.some((p) => (p.type === 'camp' || p.type === 'haven') && U.dist2(u.pos.x, u.pos.z, p.x, p.z) < 12);
      if (!shelter) { tm.ash += dt; if (tm.ash >= 30) { tm.ash = 0; gainCorruption(1, 'ash wind'); } }
    }
    // the road wears on high spirits: above 60 Hope, out of combat, -1 Hope per 20 s
    if (r.hope > 60 && !AB.combat.inCombat) { tm.weary = (tm.weary || 0) + dt; if (tm.weary >= 20) { tm.weary = 0; gainHope(-1, 'weariness'); } }
    if (r.corruption >= 70) {
      tm.whisper += dt; tm.bound += dt;
      if (tm.whisper >= 24) { tm.whisper = 0; AB.bus.emit('whisper', { text: AB.rand.pick(C.whispers) }); }
      if (tm.bound >= 40) { tm.bound = 0; gainHope(-1, 'ember-bound'); }
    }
    // discovery, camps, explored road
    const lv = AB.world.level;
    if (lv) {
      for (const p of lv.pois) {
        const d = U.dist2(u.pos.x, u.pos.z, p.x, p.z);
        if (p.state === 'hidden' && d < (p.type === 'chest' ? 22 : 45)) {
          setPoiState(p, 'discovered'); r.stats.discoveries++; AB.bus.emit('poi:discovered', { poi: p });
          const say = DISCOVER[p.type]; if (say && p.branch) toast(say, 'discover'); else if (say && (p.type === 'chest' || p.type === 'shrine' || p.type === 'haven')) toast(say, 'discover');
        }
        if (p.type === 'camp' && d < 7) arriveCamp(p);
      }
      const ri = AB.world.roadInfo(u.pos.x, u.pos.z);
      if (ri.d < 18 && !ri.branch) { const seg = Math.floor(ri.s / 10); if (!r.explored[seg]) r.explored[seg] = 1; }
      if (lv.zones) { const z = lv.zones.find((q) => ri.s >= q.from && ri.s < q.to); if (z && z.name !== state.zone) { state.zone = z.name; AB.bus.emit('zone', { name: z.name }); } }
    }
    objT += dt; if (objT > 0.5) { objT = 0; updateObjective(false); }
    checkLoss();
  }
  function resume() { if (MODALS.includes(state.screen) && ['pause', 'inventory', 'party', 'map'].includes(state.screen)) { setScreen('play'); return true; } return false; }

  // =====================================================================================
  // BOT (order 10, always): drives the controlled hero with AB.input exactly like a player
  // =====================================================================================
  function botModal() {
    const sc = state.screen; const m = state.modal; const r = run();
    bot.picks++;
    switch (sc) {
      case 'title': if (state.hasSave && state.botContinue) continueRun(); else openPick(); return;
      case 'pick': confirmPick(null); return;
      case 'actcard': AB.input.tap('interact'); return;
      case 'event': {
        if (m.phase === 'outcome') { continueEvent(); return; }
        const ev = eventDef(m.id);
        const score = (ch, i) => {
          if (m.choices[i].disabled) return -1e9;
          const effs = choiceEffects(ch);
          let s = 0;
          for (const e of effs) {
            if (e.type === 'lose_companion') s -= 100;
            if (e.type === 'corruption') s -= (Number(e.amount) || 0) * (r.corruption > 40 ? 2 : 1);
            if (e.type === 'hope') s += (Number(e.amount) || 0) * (r.hope < 30 ? 2 : 1);
            if (e.type === 'supplies') s += (Number(e.amount) || 0) * (r.supplies < 5 ? 2 : 0.7);
            if (e.type === 'silver') s += (Number(e.amount) || 0) * 0.3;
            if (e.type === 'battle') s -= 2;
            if (e.type === 'item' || e.type === 'boon' || e.type === 'revive') s += 5;
            if (e.type === 'damage') s -= 2;
          }
          return s;
        };
        let best = -1, bs = -1e9;
        ev.choices.forEach((ch, i) => { const s = score(ch, i); if (s > bs) { bs = s; best = i; } });
        if (best < 0 || !chooseEvent(best)) { const i = m.choices.findIndex((c) => !c.disabled); chooseEvent(Math.max(0, i)); }
        return;
      }
      case 'camp': {
        if (m.done) { leaveCamp(); return; }
        const hurt = living().some((u) => u.hp < u.maxHp * 0.6);
        const pick = r.corruption >= 40 ? 'steady' : hurt ? 'rest' : r.supplies < 6 ? 'forage' : r.hope < 50 ? 'stories' : r.corruption >= 15 ? 'steady' : 'rest';
        campChoose(pick); return;
      }
      case 'haven': {
        const offers = m.offers.filter((o) => !o.disabled);
        const want = (k) => offers.find((o) => o.kind === k);
        if (want('heal') && living().some((u) => u.hp < u.maxHp * 0.7)) { havenBuy('heal', 0); return; }
        if (want('rite') && r.corruption >= 30) { havenBuy('rite', 0); return; }
        if (want('supplies') && r.supplies < 8) { havenBuy('supplies', 0); return; }
        const it = offers.find((o) => o.kind === 'item' && r.silver - o.price >= 20);
        if (it) { havenBuy('item', it.idx); return; }
        leaveHaven(); return;
      }
      case 'boon': {
        const val = (o) => {
          const e = (BOONS[o.id] || {}).effect || {};
          switch (e.type) {
            case 'corruption_resist': return 6 + r.corruption / 8;
            case 'maxhp_all': return 7;
            case 'damage_all': return 7.5;
            case 'heal_after_battle': return 6;
            case 'hope_on_victory': return r.hope < 60 ? 7 : 3;
            case 'start_guard': return 5;
            case 'cooldown_haste': return 5.5;
            case 'supplies': return r.supplies < 8 ? 6 : 2;
            case 'forage_bonus': return 3;
            case 'silver_bonus': return 3;
            default: return 1;
          }
        };
        const best = m.options.slice().sort((a, b) => val(b) - val(a))[0];
        takeBoon(best.id); return;
      }
      case 'shrine': if (m.done) { setScreen('play'); return; } shrineChoose(m.options.find((o) => !o.disabled && o.id !== 'leave') ? m.options.find((o) => !o.disabled && o.id !== 'leave').id : 'leave'); return;
      case 'forge': { const pref = ['cast', 'carry', 'will', 'remember', 'yield']; const o = pref.map((id) => m.options.find((x) => x.id === id)).find(Boolean); forgeAct(o ? o.id : m.options[0].id); return; }
      case 'pause': case 'inventory': case 'party': case 'map': resume(); return;
      case 'ending': if (state.botLoop) walkAgain(); return;
      default: return;
    }
  }
  function botStep(dt) {
    if (!state.bot) return;
    const sc = state.screen;
    if (sc !== 'play') {
      if (pendingLoad || cine || sc === 'loading' || sc === 'endingcine' || sc === 'boot') return;
      state.timers.botWait = (state.timers.botWait || 0) + dt;
      if (state.timers.botWait < 0.25) return;
      state.timers.botWait = 0;
      botModal();
      return;
    }
    const u = AB.combat.controlled(); if (!u) return;
    const r = run();
    if (u.downed) { const a = living().find((m) => !m.downed && m.id !== u.id); if (a) switchTo(a); return; }
    if (r.items.length && living().some((m) => m.hp < m.maxHp * 0.35 && !m.downed)) {
      const i = r.items.findIndex((id) => !itemUsable(id) && C.items[id].effects.some((e) => e.type === 'heal'));
      if (i >= 0) { useItem(i); return; }
    }
    if (r.corruption >= 55 && r.items.includes('clearwater_flask')) { useItem(r.items.indexOf('clearwater_flask')); return; }
    if (AB.combat.inCombat) { if (!(AB.combat.TUNE && AB.combat.TUNE.pilot)) botFight(u, dt); return; }
    // revive downed allies first
    const down = party().find((m) => m.alive && m.downed);
    if (down) { botGo(u, down.pos.x, down.pos.z, 0.8); return; }
    if (u.id !== BEARER.id) { const w = member(BEARER.id); if (w && w.alive && !w.downed) switchTo(w); }
    const lv = AB.world.level; if (!lv) return;
    const todo = lv.pois.filter((p) => !poiDone(p) && (p.type !== 'camp' || p.state !== 'used') && p.type !== 'haven' || (p.type === 'haven' && p.state !== 'used'))
      .sort((a, b) => a.order - b.order);
    const target = todo[0];
    if (!target) return;
    if (bot.targetId !== target.id) { bot.targetId = target.id; bot.stuckT = 0; bot.lastDist = 1e9; bot.detourT = 0; }
    const g = AB.world.guide(u.pos.x, u.pos.z, target.id);
    const d = U.dist2(u.pos.x, u.pos.z, target.x, target.z);
    if (target.interactR && d < target.interactR * 0.8) { AB.input.tap('interact'); return; }
    // the guide walks straight at the next waypoint; a prop between (a rib, a wall, a wagon) can pin the bot after a
    // fight pushed it off the road. Like a player, it then side-steps around the obstacle (alternating sides, a little
    // backward) before trying straight again; the teleport below stays the last resort.
    if (bot.detourT > 0) {
      bot.detourT -= dt;
      const gx = g.x - u.pos.x, gz = g.z - u.pos.z, gl = Math.hypot(gx, gz) || 1, sd = bot.detourSide;
      AB.input.driveWorld((-gz * sd - gx * 0.35) / gl, (gx * sd - gz * 0.35) / gl);
    } else AB.input.driveWorld(g.x - u.pos.x, g.z - u.pos.z);
    // stuck detection (counts as a warning in botrun)
    bot.stuckT += dt;
    if (g.dist < bot.lastDist - 1) { bot.lastDist = g.dist; bot.stuckT = 0; bot.detourN = 0; }
    else if (bot.stuckT > 3 && bot.detourT <= 0 && Math.floor(bot.stuckT / 3) !== bot.detourN) {
      bot.detourN = Math.floor(bot.stuckT / 3); bot.detourSide = bot.detourN % 2 ? 1 : -1; bot.detourT = 0.8 + bot.detourN * 0.5; bot.detours++;
    }
    if (bot.stuckT > 20) {
      bot.stuckT = 0; bot.teleports++; bot.lastDist = 1e9;
      AB.bus.emit('bot:stuck', { poiId: target.id, x: u.pos.x, z: u.pos.z });
      const nx = u.pos.x + (g.x - u.pos.x) * 1.5, nz = u.pos.z + (g.z - u.pos.z) * 1.5;
      teleport(nx, nz);
    }
  }
  function botGo(u, x, z, stop) {
    const d = U.dist2(u.pos.x, u.pos.z, x, z);
    if (d > stop) AB.input.driveWorld(x - u.pos.x, z - u.pos.z);
  }
  function botFight(u, dt) {
    // dodge telegraphs
    for (const t of AB.combat.threats()) {
      if (t.side === 'party') continue;
      const d = U.dist2(u.pos.x, u.pos.z, t.x, t.z);
      if (d < t.radius + u.radius && t.left < 0.45 && !u.dodgeCd) {
        const ax = u.pos.x - t.x, az = u.pos.z - t.z; const l = Math.hypot(ax, az) || 1;
        AB.input.driveWorld(ax / l, az / l); AB.input.tap('dodge'); return;
      }
    }
    const down = party().find((m) => m.alive && m.downed && U.dist2(m.pos.x, m.pos.z, u.pos.x, u.pos.z) < 18);
    if (down) { botGo(u, down.pos.x, down.pos.z, 0.8); return; }
    const foe = AB.combat.nearestFoe(u, 60);
    if (!foe) { const enc = AB.combat.activeEncounters()[0]; if (enc) botGo(u, enc.x, enc.z, 3); return; }
    const range = AB.combat.rangeOf(u, 'attack');
    const d = U.dist2(u.pos.x, u.pos.z, foe.pos.x, foe.pos.z);
    if (d > range * 0.85) { botGo(u, foe.pos.x, foe.pos.z, range * 0.6); }
    else if (range > 6 && d < 4) { AB.input.driveWorld(u.pos.x - foe.pos.x, u.pos.z - foe.pos.z); }
    if (d <= range) {
      const cd = AB.combat.cooldowns(u);
      const foes = AB.combat.foesNear(foe.pos.x, foe.pos.z, 7).length;
      const r = run();
      const bossFight = AB.combat.activeEncounters().some((e) => e.kind === 'boss');
      if (u.id === BEARER.id && cd.ember && cd.ember.ready && (foes >= 3 || bossFight) && r.corruption < 25) AB.input.tap('ember');
      else if (cd.skill1 && cd.skill1.ready) AB.input.tap('skill1');
      else if (cd.skill2 && cd.skill2.ready && u.id !== BEARER.id) AB.input.tap('skill2');
      else AB.input.tap('attack');
    }
  }

  // =====================================================================================
  // TITLE / PICK / FLOW API
  // =====================================================================================
  let titleUnits = [];
  function boot(data) {
    state.hasSave = !!loadSave();
    if (data && data.state && data.state.run) {
      try { state.run = deserializeRun(data.state.run); snapshotJSON = JSON.stringify(data.state.run); const r = run(); startLevel(r.act === 4 ? 'forge' : r.act, { at: r.checkpoint.poiId }); return; } catch (e) { console.error('[game] hot resume failed', e); }
    }
    toTitle();
  }
  function toTitle() {
    clearDisplay();
    AB.combat.clear();
    state.run = null;
    state.lastEnding = null;
    AB.world.build(1, 4242);
    const lv = AB.world.level;
    const a = AB.world.roadPoint(30, new V3()), b = AB.world.roadPoint(Math.min(lv.road.length - 10, 200), new V3());
    const ha = AB.world.heightAt(a.x, a.z), hb = AB.world.heightAt(b.x, b.z);
    AB.cam.play([
      { from: [a.x - 20, ha + 14, a.z - 8], to: [b.x - 16, hb + 10, b.z - 12], lookFrom: [a.x + 10, ha + 2, a.z + 30], lookTo: [b.x + 10, hb + 2, b.z + 30], dur: 40, ease: 'linear' },
      { from: [b.x - 16, hb + 10, b.z - 12], to: [a.x - 20, ha + 14, a.z - 8], lookFrom: [b.x + 10, hb + 2, b.z + 30], lookTo: [a.x + 10, ha + 2, a.z + 30], dur: 40, ease: 'linear' }
    ], { loop: true });
    AB.bus.emit('music', { mode: 'title' });
    setScreen('title', { kind: 'title', hasSave: state.hasSave, tagline: C.ui.titleTagline, lore: C.ui.titleLore });
  }
  function clearDisplay() { titleUnits.forEach((u) => AB.combat.despawn(u)); titleUnits = []; pickCamp = null; }
  // Pick screen framing (cosmetic): keep the lineup clear of the panel (right side on wide screens, bottom sheet on
  // portrait phones); inspecting a recruit glides the camera to them.
  let pickCamp = null, pickFocusId = null;
  function pickShot(focusId, snap) {
    if (!pickCamp || !AB.camera) return;
    pickFocusId = focusId || null;
    const W = AB.core.width || 800, H = AB.core.height || 500, asp = W / H;
    const tv = Math.tan((AB.cam.baseFov || 52) * Math.PI / 360), th = tv * asp;
    let nx = 0, ny = 0, uw = 1;
    if (asp < 1) { ny = 0.52; uw = 0.95; }            // portrait: the sheet covers the lower ~58%
    else if (W < 640 || H < 520) { nx = -0.5; uw = 0.5; }
    else { nx = -0.4; uw = 0.56; }
    const cy = AB.world.heightAt(pickCamp.x, pickCamp.z);
    const u = focusId ? titleUnits.find((q) => q.id === focusId) : null;
    let T, Cp, D;
    if (u) {
      const f = u.facing || 0, hh = u.height || 1.7; D = asp < 1 ? 5.6 : 4.2;
      T = new V3(u.pos.x, u.pos.y + hh * 0.62, u.pos.z);
      Cp = new V3(u.pos.x + Math.sin(f) * D, u.pos.y + hh * 0.85 + D * 0.08, u.pos.z + Math.cos(f) * D);
    } else {
      D = asp < 1 ? 14 : Math.max(8, 5.2 / (th * uw));
      const k = pickCamp.R * 0.82;
      T = new V3(pickCamp.x - pickCamp.dx * k, cy + 1.0, pickCamp.z - pickCamp.dz * k);
      Cp = new V3(T.x + pickCamp.dx * D, T.y + D * (asp < 1 ? 0.2 : 0.11) + 0.45, T.z + pickCamp.dz * D);
    }
    Cp.y = Math.max(Cp.y, AB.world.heightAt(Cp.x, Cp.z) + 1.2);
    const fx = T.x - Cp.x, fz = T.z - Cp.z, fl = Math.hypot(fx, fz) || 1;
    const rx = -fz / fl, rz = fx / fl;
    const L = new V3(T.x + rx * (-nx) * D * th, T.y - ny * D * tv, T.z + rz * (-nx) * D * th);
    if (snap) { AB.cam.set(Cp, L); return; }
    const from = AB.cam.position.clone(), look = AB.cam.focus.clone();
    AB.cam.play([{ from, to: Cp, lookFrom: look, lookTo: L, dur: 0.9 }, { from: Cp, to: Cp, lookFrom: L, lookTo: L, dur: 1e6 }]);
  }
  function inspectPick(id) { if (state.screen !== 'pick') return false; pickShot(id === BEARER.id || RECRUITS.some((r) => r.id === id) ? id : null, false); return true; }
  AB.bus.on('resize', () => { if (state.screen === 'pick') pickShot(pickFocusId, true); });
  function openPick() {
    if (state.screen !== 'title') return false;
    const lv = AB.world.level;
    const camp = lv.pois.find((p) => p.type === 'camp') || { x: lv.spawn.x, z: lv.spawn.z };
    clearDisplay();
    // the fellowship gathers on the far side of the fire, faces lit by it; the camera stands on the road side
    // the bearer stands in the middle, flanked by the six recruits; portrait screens get a tighter arc
    const list = RECRUITS.slice(0, 3).concat([BEARER], RECRUITS.slice(3));
    const portrait = (AB.core.width || 800) < (AB.core.height || 500);
    const R = portrait ? 4.2 : 4.6, SPREAD = portrait ? 0.72 : 0.95, D0 = 10;
    const spots = (yaw) => {
      const dx = Math.sin(yaw), dz = Math.cos(yaw), px = Math.cos(yaw), pz = -Math.sin(yaw);
      return list.map((c, i) => { const a = -SPREAD + (i / (list.length - 1)) * 2 * SPREAD; return [camp.x - dx * R * Math.cos(a) + px * R * Math.sin(a), camp.z - dz * R * Math.cos(a) + pz * R * Math.sin(a)]; });
    };
    // choose the side of the fire with clear ground and a clear view (tents, carts and hillsides get in the way)
    const cols = (lv.colliders || []).filter((c) => U.dist2(c.x, c.z, camp.x, camp.z) < 22);
    const h0 = AB.world.heightAt(camp.x, camp.z);
    const blocked = (x, z, pad) => cols.some((c) => U.dist2(c.x, c.z, x, z) < c.r + pad);
    let best = null;
    for (let k = 0; k < 8; k++) {
      const yaw = (camp.yaw || 0) + k * Math.PI / 4;
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      const cx = camp.x - dx * R * 0.8 + dx * D0, cz = camp.z - dz * R * 0.8 + dz * D0;
      let pen = Math.min(k, 8 - k) * 0.4;
      if (AB.world.heightAt(cx, cz) > h0 + 3) pen += 6;
      for (const [x, z] of spots(yaw)) {
        if ((AB.world.isWalkable && !AB.world.isWalkable(x, z, 0.4)) || blocked(x, z, 0.5)) pen += 3;
        if (Math.abs(AB.world.heightAt(x, z) - h0) > 1.3) pen += 1;
        for (let f = 0.15; f < 0.95; f += 0.1) if (blocked(x + (cx - x) * f, z + (cz - z) * f, 0.2)) { pen += 2; break; }
      }
      if (!best || pen < best.pen) best = { pen, yaw };
    }
    const dx = Math.sin(best.yaw), dz = Math.cos(best.yaw);
    spots(best.yaw).forEach(([x, z], i) => { titleUnits.push(AB.combat.spawnDisplay(list[i].id, x, z, U.yawTo(camp.x - x, camp.z - z))); });
    pickCamp = { x: camp.x, z: camp.z, dx, dz, R };
    pickShot(null, true);
    setScreen('pick', { kind: 'pick', recruits: RECRUITS.map((c) => ({ id: c.id, name: c.name, epithet: c.epithet, role: c.role, maxHp: c.maxHp, blurb: c.blurb, trait: c.trait, abilities: c.abilities, uid: (titleUnits.find((u) => u.id === c.id) || {}).uid })), bearer: { id: BEARER.id, name: BEARER.name, epithet: BEARER.epithet, uid: (titleUnits.find((u) => u.id === BEARER.id) || {}).uid }, chosen: [], seed: 10000 + Math.floor(Math.random() * 90000) });
    return true;
  }
  function confirmPick(ids) {
    if (state.screen !== 'pick') return false;
    const m = state.modal;
    const chosen = ids || m.chosen;
    newRun(m.seed, chosen && chosen.length === 3 ? chosen : null);
    return true;
  }
  function newRun(seed, partyIds) {
    clearDisplay();
    AB.cam.stop({ snap: false });
    AB.combat.clear();
    state.run = newRunObj(seed, partyIds);
    snapshotJSON = null;
    AB.bus.emit('run:new', { run: state.run });
    startLevel(1, { fresh: true });
  }
  function continueRun() {
    const s = loadSave(); if (!s) return false;
    clearDisplay();
    AB.cam.stop({ snap: false });
    state.run = deserializeRun(s.run);
    snapshotJSON = JSON.stringify(s.run);
    AB.bus.emit('run:loaded', { run: state.run });
    const r = run();
    startLevel(r.act === 4 ? 'forge' : r.act, { at: r.checkpoint.poiId });
    return true;
  }
  function walkAgain() { toTitle(); return true; }
  function teleport(x, z) {
    const u = AB.combat.controlled(); if (!u) return false;
    AB.combat.teleportParty(x, z);
    lastPos.copy(u.pos);
    AB.cam.snap();
    return true;
  }
  function goto(act, poiId) {
    if (!run()) { state.run = newRunObj(4242, null); snapshotJSON = null; }
    const r = run();
    r.act = act === 'forge' || act === 4 ? 4 : Number(act) || 1;
    pendingLoad = null; cine = null;
    startLevel(r.act === 4 ? 'forge' : r.act, { at: poiId || null, fresh: false, card: false });
    pendingLoad.wait = 0;
    doLoad();
  }
  function setBot(on) { state.bot = !!on; bot.stuckT = 0; bot.lastDist = 1e9; }

  // =====================================================================================
  // DEBUG / SNAPSHOT
  // =====================================================================================
  function debugState() {
    const r = run(); const u = AB.combat.controlled();
    const lv = AB.world.level;
    return {
      screen: state.screen, act: r ? r.act : 0, seed: r ? r.seed : 0,
      hope: r ? r.hope : 0, corruption: r ? r.corruption : 0, silver: r ? r.silver : 0, supplies: r ? r.supplies : 0,
      party: r ? r.party.map((m) => ({ id: m.id, hp: m.hp, maxHp: m.maxHp, alive: m.alive, downed: !!m.downed, left: !!m.left })) : [],
      controlled: r ? r.controlled : null, items: r ? r.items.slice() : [], boons: r ? r.boons.slice() : [],
      inCombat: AB.combat.inCombat, foes: AB.combat.foes().length,
      pos: u ? { x: Math.round(u.pos.x * 10) / 10, y: Math.round(u.pos.y * 10) / 10, z: Math.round(u.pos.z * 10) / 10 } : null,
      pois: lv ? { total: lv.pois.length, done: lv.pois.filter(poiDone).length } : null,
      objective: state.objective, zone: state.zone, ending: r && r.ending ? r.ending.id : (state.lastEnding ? state.lastEnding.id : null),
      stats: r ? Object.assign({}, r.stats) : null, time: Math.round(AB.loop.time * 10) / 10,
      bot: { on: state.bot, teleports: bot.teleports, detours: bot.detours }, errors: AB.loop.errors
    };
  }
  function screens() { return { current: state.screen, history: state.history.slice() }; }
  function snapshot() { return { state: { run: run() && !run().ending ? serializeRun() : null } }; }

  AB.game = {
    state, BEARER, RECRUITS,
    init() {
      AB.loop.add('bot', botStep, { phase: 'step', order: AB.loop.ORDER.bot, always: true });
      AB.loop.add('game', step, { phase: 'step', order: AB.loop.ORDER.game, always: true });
    },
    boot, toTitle, openPick, confirmPick, newRun, continueRun, walkAgain, inspectPick, saveInfo,
    openBoon(src) { if (state.screen !== 'play' || !run()) return false; openBoon(src || 'event'); return true; },
    togglePick(id) { const m = state.modal; if (state.screen !== 'pick' || !m) return false; const i = m.chosen.indexOf(id); if (i >= 0) m.chosen.splice(i, 1); else if (m.chosen.length < 3) m.chosen.push(id); AB.bus.emit('screen', { name: 'pick', prev: 'pick', modal: m }); return true; },
    skipCard() { if (state.screen === 'actcard' && cine) { cine.t = cine.dur; return true; } return false; },
    interact, interactNearest() { const p = updatePrompt(AB.combat.controlled()); return p ? interact(p) : false; },
    chooseEvent, continueEvent, campChoose, leaveCamp, havenBuy, leaveHaven, shrineChoose, takeBoon, forgeAct,
    pause() { if (state.screen === 'play') { setScreen('pause', { kind: 'pause' }); return true; } return false; },
    resume, openInventory() { if (state.screen === 'play') { setScreen('inventory', inventoryModal()); return true; } return false; },
    openParty() { if (state.screen === 'play') { setScreen('party', { kind: 'party' }); return true; } return false; },
    openMap() { if (state.screen === 'play') { setScreen('map', { kind: 'map' }); return true; } return false; },
    quitToTitle() { if (!AB.combat.inCombat && !party().some((m) => m.downed)) save(); toTitle(); return true; },
    useItem, dropItem, quickItem, itemUsable, switchHero, switchTo,
    gainHope, gainCorruption, gainSilver, gainSupplies, giveItem,
    hopeMult, hopeState, corruptionMult, corrState, boonSum, boonHas, traitAlive, hasAlive,
    poiDone, setPoiState, save, clearSave, hasSave: () => state.hasSave,
    serializeRun, snapshot, debugState, screens, goto, teleport, setBot,
    get run() { return state.run; },
    get bot() { return bot; }
  };
}
