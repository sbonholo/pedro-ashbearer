'use strict';
/* ASHBEARER v3 :: ui.js
   OWNER: UI lane (game flow + ui + audio: game.js ui.js audio.js main.js shell.html style.css).
   The DOM layer over the 3D view: HUD (party portraits, Hope, the Emberheart meter + Corruption vignette, supplies,
   silver, round minimap, objective, prompt, boss bar, enemy bars, lock reticle, damage numbers, whispers, banners),
   the desktop ability bar and the touch thumb cluster (both with cooldown sweeps), and every screen (title, pick,
   act card, pause + settings + controls, pack, party, map, event, camp, haven, shrine, boon, forge, ending).
   Drives the game ONLY through AB.game.* actions and AB.input.press/release/tap. Renders lazily: bus events mark
   things dirty; the FRAME system (order 80) touches the DOM (frames never run during fastForward). */
{
  const C = AB.C;
  const U = AB.util;
  const V3 = AB.THREE.Vector3;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CMP = {}; C.companions.forEach((c) => { CMP[c.id] = c; });
  const BOONS = {}; C.boons.forEach((b) => { BOONS[b.id] = b; });
  const first = (n) => String(n || '').split(' ')[0];
  const ROMAN = ['', 'I', 'II', 'III', 'IV'];

  // =====================================================================================================
  // ICONS (inline SVG, 24 px grid, stroke = currentColor; no emoji, no files)
  // =====================================================================================================
  const ICON = {
    sling: '<path d="M6 21c1-5 3.5-9 7.5-11.5"/><path d="M13.5 9.5c1.6-3 4.6-4.6 6.5-3.4 1.9 1.2.9 4.6-2.2 6.3-1.8 1-3.5 1-4.3-.2"/><circle cx="17.2" cy="9.4" r="1.5" fill="currentColor" stroke="none"/>',
    blades: '<path d="M4 20L15.5 8.5M15.5 8.5l3.5-4.5 1 1-4.5 3.5M7 14l3 3"/><path d="M20 20L8.5 8.5M8.5 8.5L5 4 4 5l4.5 3.5M17 14l-3 3"/>',
    hammer: '<path d="M5 4h10l2.5 3.5L15 11H5z"/><path d="M10 11v10"/>',
    bow: '<path d="M7 3c7 3 7 15 0 18"/><path d="M7 3v18"/><path d="M3 12h15"/><path d="M15 9l3 3-3 3"/>',
    staff: '<path d="M12 10v11"/><path d="M9 3h6l1 2.5v3L15 10H9L8 8.5v-3z"/><path d="M12 5.2v2.6"/>',
    sword: '<path d="M19 3h2v2L9.5 16.5l-2-2z"/><path d="M6 13l5 5"/><path d="M4 21l3.5-3.5"/>',
    spear: '<path d="M3.5 20.5L15 9"/><path d="M15 9l1-5.5L21 3l-.5 5L15 9z"/><path d="M11.5 9.5l3 3"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.8-3.2 8-7.5 9.5-4.3-1.5-7.5-4.7-7.5-9.5V6z"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
    leaf: '<path d="M5 19C5 10 10 5 19 5c0 9-5 14-14 14z"/><path d="M5 19l8-8"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    burst: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M18.4 5.6l-3.5 3.5M9.1 14.9l-3.5 3.5"/>',
    target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    song: '<path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    cloak: '<path d="M12 3C8 3 6 6.5 6 10.5V21l2-1.5L10 21l2-1.5 2 1.5 2-1.5 2 1.5V10.5C18 6.5 16 3 12 3z"/><path d="M10 10h.01M14 10h.01"/>',
    shard: '<path d="M12 2.5l5.5 6.5-2.5 12.5H9L6.5 9z"/><path d="M12 2.5L10.5 9l1.5 12.5M6.5 9h11"/>',
    coin: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.4"/>',
    bread: '<path d="M4 11c0-3.5 3.6-6 8-6s8 2.5 8 6c0 1.4-.8 2-1.8 2.2V19H5.8v-5.8C4.8 13 4 12.4 4 11z"/><path d="M9 8.8l1 2M13 8.5l1 2"/>',
    roll: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M18 2.5v4.2h-4.2"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7S5 18.5 5 15l-1.2-3a1.4 1.4 0 0 1 2.4-1.4L8 13"/>',
    bag: '<path d="M5 9h14l-1 12H6z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/>',
    map: '<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
    pause: '<path d="M8.5 5v14M15.5 5v14"/>',
    flask: '<path d="M9.5 3h5M10.5 3v5.5L5.5 17a2.5 2.5 0 0 0 2.2 3.8h8.6a2.5 2.5 0 0 0 2.2-3.8l-5-8.5V3"/><path d="M7.5 14h9"/>',
    fire: '<path d="M12 21c-3.9 0-6.5-2.5-6.5-6 0-4 3.5-6 4-10 2.5 1.5 4.2 3.6 4.7 6 .8-.8 1.3-2 1.4-3 1.8 1.6 2.9 4.2 2.9 7 0 3.5-2.6 6-6.5 6z"/>',
    star: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"/>',
    crown: '<path d="M4 18h16M5 18L4 7l5 4 3-6 3 6 5-4-1 11"/>',
    swords: '<path d="M5 5l14 14M19 5L5 19M3 9l6-6M15 21l6-6M3 15l6 6M15 3l6 6"/>',
    chest: '<path d="M4 10h16v9H4zM4 10c0-3 2-5 8-5s8 2 8 5"/><path d="M11 12.5h2v2h-2z"/>',
    eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    tent: '<path d="M3 20L12 4l9 16z"/><path d="M9 20l3-6 3 6"/>',
    shrine: '<path d="M7 21V9l5-5 5 5v12z"/><path d="M10 21v-6h4v6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    book: '<path d="M4 5.5C6.5 4 9.5 4 12 5.5 14.5 4 17.5 4 20 5.5V19c-2.5-1.5-5.5-1.5-8 0-2.5-1.5-5.5-1.5-8 0z"/><path d="M12 5.5V19"/>',
    sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    weak: '<path d="M6 6l6 5 6-5M6 13l6 5 6-5"/>',
    up: '<path d="M6 18l6-5 6 5M6 11l6-5 6 5"/>',
    stun: '<path d="M12 12.5a1 1 0 1 1 1-1 3 3 0 1 1-3-3 5 5 0 1 1-5 5 7 7 0 0 1 7-7"/>',
    drop: '<path d="M12 3c3.5 5 6 8.2 6 11.2A6 6 0 0 1 6 14.2C6 11.2 8.5 8 12 3z"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
    cairn: '<path d="M8 20h8M9 20l-1-3.5h8L15 20M9.5 16.5L10 13h4l.5 3.5M10.5 13l.5-3h2l.5 3"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    arrow: '<path d="M12 4l6 8h-4v8h-4v-8H6z"/>'
  };
  const icon = (name, cls) => '<svg class="ab-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[name] || ICON.star) + '</svg>';
  const WEAPON_ICON = { wren: 'sling', ysolde: 'blades', brakka: 'hammer', neve: 'bow', maddoc: 'staff', rook: 'sword', tamsin: 'spear' };
  const STATUS = {
    guard: { i: 'shield', c: 'star', n: 'Guarded' }, taunt: { i: 'flag', c: 'gilt', n: 'Taunting' }, hidden: { i: 'cloak', c: 'dim', n: 'Hidden' },
    mark: { i: 'target', c: 'blood', n: 'Marked' }, weak: { i: 'weak', c: 'dim', n: 'Weakened' }, stun: { i: 'stun', c: 'gilt', n: 'Stunned' },
    bleed: { i: 'drop', c: 'blood', n: 'Bleeding' }, empower: { i: 'up', c: 'gilt', n: 'Empowered' }, regen: { i: 'leaf', c: 'moss', n: 'Mending' }
  };
  function abilityIcon(heroId, ab) {
    if (!ab) return 'star';
    const ef = ab.effects || [];
    const has = (t, k, v) => ef.some((e) => e.type === t && (k == null || e[k] === v));
    if (has('corruption') && has('damage')) return 'shard';
    if (ab.cooldown === 0) return WEAPON_ICON[heroId] || 'sword';
    if (has('status', 'status', 'hidden')) return 'cloak';
    if (has('heal')) return 'leaf';
    if (has('status', 'status', 'guard') || has('status', 'status', 'taunt')) return 'shield';
    if (has('status', 'status', 'empower')) return 'song';
    if (has('damage', 'target', 'all_foes')) return 'burst';
    if (has('status', 'status', 'mark') || has('status', 'status', 'stun')) return 'target';
    if (has('silver')) return 'coin';
    if (ef.some((e) => e.hits > 1)) return 'blades';
    return WEAPON_ICON[heroId] || 'sword';
  }
  function itemIcon(id) {
    const it = C.items[id]; if (!it) return 'flask';
    const ef = it.effects || [];
    if (ef.some((e) => e.type === 'flee')) return 'cloak';
    if (ef.some((e) => e.type === 'supplies')) return 'bread';
    if (ef.some((e) => e.type === 'corruption')) return 'drop';
    if (ef.some((e) => e.type === 'damage')) return ef.some((e) => e.hits > 1) ? 'blades' : 'burst';
    if (ef.some((e) => e.type === 'status' && e.status === 'guard')) return 'shield';
    if (ef.some((e) => e.type === 'status' && e.status === 'empower')) return 'song';
    if (ef.some((e) => e.type === 'status' && e.status === 'weak')) return 'weak';
    if (ef.some((e) => e.type === 'hope')) return 'star';
    return 'flask';
  }
  const BOON_ICON = { maxhp_all: 'heart', damage_all: 'sword', start_guard: 'shield', corruption_resist: 'shard', forage_bonus: 'leaf', silver_bonus: 'coin', heal_after_battle: 'flask', hope_on_victory: 'star', supplies: 'bread', cooldown_haste: 'hourglass' };
  const POI_ICON = { battle: 'swords', elite: 'crown', boss: 'crown', event: 'eye', camp: 'fire', haven: 'tent', chest: 'chest', shrine: 'shrine', forge: 'fire' };
  const POI_NAME = { battle: 'Foes on the road', elite: 'A guarded hoard', boss: 'The end of the road', event: 'Something to investigate', camp: 'Campfire', haven: 'Haven', chest: 'Chest', shrine: 'Wayside shrine', forge: 'The edge of the Forge' };

  // The Emberheart shard (the one bold element). fill = 0..1 (Corruption); the glow is CSS (--glow) on the wrapper.
  let shardN = 0;
  function shardSvg(cls, fill) {
    const id = 'abShard' + (++shardN);
    const y = (56 * (1 - U.clamp(fill, 0, 1))).toFixed(1);
    return '<svg class="ab-shard-svg ' + (cls || '') + '" viewBox="0 0 40 56" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="' + id + 'g" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#ffe2a8"/><stop offset="0.35" stop-color="#ffc06a"/><stop offset="0.7" stop-color="#ff7b2e"/><stop offset="1" stop-color="#8a2a0a"/></linearGradient>' +
      '<clipPath id="' + id + 'c"><rect data-fill x="0" y="' + y + '" width="40" height="56"/></clipPath></defs>' +
      '<path d="M20 1L35 18 28 55H12L5 18z" fill="#1f1512" stroke="rgba(255,192,106,0.45)" stroke-width="1"/>' +
      '<path d="M20 1L35 18 28 55H12L5 18z" fill="url(#' + id + 'g)" clip-path="url(#' + id + 'c)"/>' +
      '<path d="M20 1L17 20 12 55M17 20L35 18M17 20L5 18M17 20l7 14 4 21M24 34L35 18" fill="none" stroke="rgba(255,236,200,0.28)" stroke-width="0.8"/>' +
      '</svg>';
  }

  // =====================================================================================================
  // DOM helpers
  // =====================================================================================================
  let uiEl = null, scr = null, hud = null, touchEl = null, worldEl = null, nums = null, toastsEl = null, whisperEl = null, bannerEl = null, flashEl = null;
  let dirty = true, lastScreen = '', lastModal = null;
  const cache = new WeakMap();
  const set = (el, prop, val) => {
    if (!el) return;
    let m = cache.get(el); if (!m) { m = {}; cache.set(el, m); }
    if (m[prop] === val) return; m[prop] = val;
    if (prop === 'text') el.textContent = val;
    else if (prop === 'html') el.innerHTML = val;
    else if (prop === 'hidden') el.hidden = !!val;
    else if (prop.charAt(0) === '@') el.setAttribute(prop.slice(1), val);
    else if (prop.charAt(0) === '.') el.classList.toggle(prop.slice(1), !!val);
    else el.style.setProperty(prop, val);
  };
  const btn = (label, act, arg, o = {}) => '<button type="button" class="ab-btn' + (o.primary ? ' is-primary' : '') + (o.on ? ' is-on' : '') + (o.cls ? ' ' + o.cls : '') + '" data-act="' + act + '"' +
    (arg != null ? ' data-arg="' + esc(arg) + '"' : '') + (o.num ? ' data-num="' + o.num + '"' : '') + (o.disabled ? ' disabled' : '') + (o.aria ? ' aria-label="' + esc(o.aria) + '"' : '') + '>' +
    (o.icon ? icon(o.icon) : '') + '<span class="ab-btn-l">' + label + '</span>' + (o.why ? '<span class="ab-why">' + esc(o.why) + '</span>' : '') + '</button>';
  // content texts were written for v1 rounds: say real-time durations instead (statuses last turns x 3 s, cooldowns x 4 s)
  const rt = (s) => String(s == null ? '' : s)
    .replace(/In round 1 of every battle/g, () => 'For the first ' + ((AB.combat && AB.combat.TUNE && AB.combat.TUNE.firstStrikeSec) || 6) + ' s of every fight')
    .replace(/cooldown of (\d+) or more/g, (m, n) => 'cooldown of ' + n * 4 + ' s or more')
    .replace(/(\d+) rounds? sooner/g, (m, n) => n * 4 + ' s sooner')
    .replace(/for 1 round: it loses its next action/g, ': it reels for 1.5 s')
    .replace(/(\d+) HP a round/g, '$1 HP every 3 s')
    .replace(/(\d+) rounds?/g, (m, n) => n * 3 + ' s');
  const chipsHtml = (list) => (list && list.length ? '<div class="ab-chips">' + list.map((c) => '<span class="ab-chip" data-kind="' + esc(c.kind) + '">' + esc(c.text) + '</span>').join('') + '</div>' : '');
  const orn = '<div class="ab-orn" aria-hidden="true"><i></i><b></b><i></i></div>';
  const folio = (inner, cls, label) => '<div class="ab-folio ' + (cls || '') + '"><div class="ab-folio-card" role="dialog" aria-modal="true"' + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' + inner + '</div></div>';
  const kicker = (t) => '<p class="ab-kicker">' + t + '</p>';
  const isTouch = () => AB.input.device === 'touch';

  // party portraits rendered by the actors lane (cached data URLs), with a sigil fallback
  const portraitCache = {};
  function portraitUrl(id) {
    if (portraitCache[id] !== undefined) return portraitCache[id];
    let url = null;
    try { url = AB.actors && AB.actors.portrait ? AB.actors.portrait(id, 128) : null; } catch (e) { url = null; }
    portraitCache[id] = url || null;
    return portraitCache[id];
  }
  function face(id, cls) {
    const c = CMP[id] || {}; const url = portraitUrl(id);
    return '<span class="ab-face ' + (cls || '') + '" style="--hue:' + (c.hue != null ? c.hue : 30) + '">' + (url ? '<img src="' + url + '" alt="" draggable="false">' : '<b class="ab-display">' + esc((c.name || '?')[0]) + '</b>') + '</span>';
  }
  function resStrip() {
    const r = AB.state.run; if (!r) return '';
    return '<div class="ab-resstrip ab-label" aria-label="Your state">' +
      '<span class="is-hope">' + icon('star') + 'Hope <b>' + r.hope + '</b></span>' +
      '<span class="is-corr">' + icon('shard') + 'Corruption <b>' + r.corruption + '</b></span>' +
      '<span class="is-silver">' + icon('coin') + 'Silver <b>' + r.silver + '</b></span>' +
      '<span class="is-sup">' + icon('bread') + 'Supplies <b>' + r.supplies + '</b></span>' +
      '<span class="is-pack">' + icon('bag') + 'Pack <b>' + r.items.length + '/5</b></span></div>';
  }
  const secs = (ab) => (ab && ab.cooldown ? (AB.combat.TUNE ? ab.cooldown * (AB.combat.TUNE.cdScale || 4) : ab.cooldown * 4) : 0);

  // =====================================================================================================
  // SETTINGS + HELP panels (title and pause)
  // =====================================================================================================
  let panel = null;          // 'settings' | 'help' | null
  function settingsHtml() {
    const s = AB.settings;
    const seg = ['auto', 'low', 'medium', 'high'].map((q) => '<button type="button" class="ab-seg' + (s.quality === q ? ' is-on' : '') + '" data-act="quality" data-arg="' + q + '" aria-pressed="' + (s.quality === q) + '">' + q[0].toUpperCase() + q.slice(1) + '</button>').join('');
    const tog = (key, label) => '<div class="ab-set-row"><span class="ab-set-k">' + label + '</span><button type="button" class="ab-toggle' + (s[key] ? ' is-on' : '') + '" data-act="toggleset" data-arg="' + key + '" role="switch" aria-checked="' + !!s[key] + '"><i></i><span>' + (s[key] ? 'On' : 'Off') + '</span></button></div>';
    const range = (key, label, min, max, val, fmt) => '<div class="ab-set-row"><label class="ab-set-k" for="ab-r-' + key + '">' + label + '</label><span class="ab-range"><input id="ab-r-' + key + '" type="range" min="' + min + '" max="' + max + '" step="1" value="' + Math.round(val) + '" data-set="' + key + '" class="ab-hit"><b data-out="' + key + '">' + fmt(val) + '</b></span></div>';
    return '<div class="ab-settings"><h3 class="ab-h3">' + icon('gear') + 'Settings</h3>' +
      '<div class="ab-set-row"><span class="ab-set-k">Quality</span><span class="ab-segs" role="group" aria-label="Quality">' + seg + '</span></div>' +
      '<p class="ab-set-note">Now drawing at ' + esc(AB.quality.tier) + (AB.quality.auto ? ' (chosen for this device)' : '') + '.</p>' +
      tog('sound', 'Sound') +
      range('volume', 'Volume', 0, 100, s.volume * 100, (v) => Math.round(v) + '%') +
      range('music', 'Music', 0, 100, s.music * 100, (v) => Math.round(v) + '%') +
      range('sensitivity', 'Camera speed', 25, 250, s.sensitivity * 100, (v) => (v / 100).toFixed(2) + 'x') +
      tog('invertY', 'Invert camera') + tog('shake', 'Screen shake') + tog('reducedMotion', 'Reduced motion') + '</div>';
  }
  function helpHtml() {
    const key = (k) => '<kbd>' + k + '</kbd>';
    const row = (k, t) => '<li><span class="ab-keys">' + k + '</span><span>' + t + '</span></li>';
    const touch = isTouch();
    const kb = '<ul class="ab-help-list">' +
      row(key('W') + key('A') + key('S') + key('D'), 'Walk (relative to the camera); hold ' + key('Shift') + ' to run on the road') +
      row('Drag', 'Look around; wheel to zoom') +
      row(key('J') + ' or click', 'Attack. Keep pressing for a three-blow combo') +
      row(key('K') + ' ' + key('L'), 'First and second skill (right click is the first skill)') +
      row(key('Q'), 'Wren: Wield the Emberheart. Others: use an item from the pack') +
      row(key('Space'), 'Dodge roll. Roll just before a blow lands for a perfect dodge') +
      row(key('E'), 'Interact: open chests, make camp, trade, investigate') +
      row(key('F'), 'Lock on to a foe and cycle targets') +
      row(key('1') + '-' + key('4'), 'Take control of another member of the fellowship') +
      row(key('I') + ' ' + key('Tab') + ' ' + key('M'), 'Pack, fellowship, map') +
      row(key('Esc'), 'Pause') + '</ul>';
    const tc = '<ul class="ab-help-list">' +
      row('Left thumb', 'Touch anywhere on the left half and drag to walk') +
      row('Right thumb', 'Drag on the right half to turn the camera') +
      row(icon('sword'), 'Strike. Tap again and again for a combo') +
      row(icon('roll'), 'Roll out of the way of marked ground and blows') +
      row(icon('blades') + icon('shield'), 'Skills. The ring fills while they recover') +
      row(icon('shard'), 'Wren: Wield the Emberheart. Others: use an item') +
      row(icon('hand'), 'Appears near chests, camps, havens and strangers') +
      row('Portraits', 'Tap a face to take control of that hero') + '</ul>';
    return '<div class="ab-help"><h3 class="ab-h3">' + icon('book') + 'How to play</h3>' +
      '<p class="ab-help-lead">Walk the road to the end of each land. Fights start when foes see you; marked ground shows where a blow will fall. Downed friends can be revived by standing beside them. Corruption makes Wren strong and the road dark: at 100 the Emberheart claims her bearer. Hope keeps the fellowship together: at 0 the road goes dark.</p>' +
      (touch ? '<h4 class="ab-h4">Touch</h4>' + tc + '<h4 class="ab-h4">Keyboard and mouse</h4>' + kb : '<h4 class="ab-h4">Keyboard and mouse</h4>' + kb + '<h4 class="ab-h4">Touch</h4>' + tc) + '</div>';
  }

  // =====================================================================================================
  // SCREENS
  // =====================================================================================================
  let pickFocus = null, memorialNote = null, saveInfo = null;
  function titleHtml(m) {
    saveInfo = AB.game.saveInfo ? AB.game.saveInfo() : null;
    const cont = m.hasSave ? btn('Continue the road' + (saveInfo ? '<small>' + esc(saveInfo.label) + '</small>' : ''), 'continue', null, { icon: 'play', num: 2 }) : '';
    const snd = AB.settings.sound;
    return '<div class="ab-title">' +
      '<div class="ab-title-col">' +
      '<div class="ab-title-mark">' + shardSvg('is-title', 1) + '</div>' +
      kicker('A journey in three acts') +
      '<h1 class="ab-display ab-title-h">Ashbearer</h1>' +
      '<p class="ab-tagline">' + esc(m.tagline) + '</p>' +
      '<p class="ab-lore">' + esc(m.lore) + '</p>' +
      '<div class="ab-title-actions">' +
      btn('Begin a new journey', 'pick', null, { primary: true, icon: 'fire', num: 1 }) + cont +
      '<div class="ab-title-row">' + btn('Settings', 'panel', 'settings', { icon: 'gear', on: panel === 'settings' }) + btn('How to play', 'panel', 'help', { icon: 'book', on: panel === 'help' }) +
      btn('', 'sound', null, { icon: snd ? 'sound' : 'mute', cls: 'ab-iconly ab-sndbtn', aria: snd ? 'Sound is on. Turn it off' : 'Sound is off. Turn it on' }) + '</div>' +
      '</div>' +
      '<p class="ab-title-foot ab-label">' + (isTouch() ? 'Left thumb walks, right thumb looks' : 'WASD to walk, mouse to look, J or click to strike') + '</p>' +
      '</div>' +
      (panel ? '<div class="ab-side ab-hit" role="dialog" aria-label="' + (panel === 'settings' ? 'Settings' : 'How to play') + '">' + btn('Close', 'panel', '', { icon: 'close', cls: 'ab-close ab-iconly', aria: 'Close' }) + (panel === 'settings' ? settingsHtml() : helpHtml()) + '</div>' : '') +
      '</div>';
  }
  function pickHtml(m) {
    const f = pickFocus === m.bearer.id ? null : m.recruits.find((r) => r.id === pickFocus) || null;
    const bearer = CMP[m.bearer.id];
    const card = (r) => {
      const on = m.chosen.includes(r.id), n = m.chosen.indexOf(r.id) + 1;
      return '<button type="button" class="ab-rcard' + (on ? ' is-on' : '') + (pickFocus === r.id ? ' is-focus' : '') + '" data-act="toggle" data-arg="' + r.id + '" aria-pressed="' + on + '">' +
        face(r.id, 'is-card') + '<span class="ab-rcard-t"><b>' + esc(first(r.name)) + '</b><small>' + esc(r.role) + ' &middot; ' + r.maxHp + ' HP</small></span>' +
        (on ? '<i class="ab-rnum">' + n + '</i>' : '') + '</button>';
    };
    const focus = f || bearer;
    const abil = (focus.abilities || []).map((a) => {
      const s = secs(a);
      return '<li>' + icon(abilityIcon(focus.id, a)) + '<span><b>' + esc(a.name) + '</b> <small class="ab-dim">' + (s ? 'every ' + s + ' s' : 'at will') + '</small><br>' + esc(rt(a.text)) + '</span></li>';
    }).join('');
    const isOn = f && m.chosen.includes(f.id);
    return '<div class="ab-pick ab-hit">' +
      '<header class="ab-pick-h">' + kicker('Road No. ' + m.seed) + '<h2 class="ab-display">Choose your fellowship</h2>' +
      '<p class="ab-dim">' + esc(first(m.bearer.name)) + ' carries the Emberheart. Choose three to walk the road with ' + esc(first(m.bearer.name)) + ' <b class="ab-count">' + m.chosen.length + ' of 3</b></p></header>' +
      '<div class="ab-pick-grid">' + m.recruits.map(card).join('') + '</div>' +
      '<section class="ab-inspect" aria-live="polite">' +
      '<div class="ab-inspect-h">' + face(focus.id, 'is-big') + '<div><h3 class="ab-display">' + esc(focus.name) + '</h3><p class="ab-label ab-dim">' + esc(focus.epithet) + (String(focus.epithet).toLowerCase().includes(String(focus.role).toLowerCase()) ? '' : ' &middot; ' + esc(focus.role)) + ' &middot; ' + focus.maxHp + ' HP</p></div>' +
      (f ? btn(isOn ? 'Leave behind' : 'Take ' + esc(first(f.name)), 'toggle', f.id, { cls: 'ab-take' + (isOn ? '' : ' is-primary'), disabled: !isOn && m.chosen.length >= 3, icon: isOn ? 'close' : 'hand' }) : '<span class="ab-badge">The Bearer</span>') + '</div>' +
      '<p class="ab-inspect-blurb">' + esc(focus.blurb) + '</p>' +
      '<p class="ab-inspect-trait"><b>' + esc(focus.trait.name) + '.</b> ' + esc(rt(focus.trait.text)) + '</p>' +
      '<ul class="ab-abil">' + abil + '</ul></section>' +
      '<div class="ab-pick-actions">' + btn('Set out with these three', 'confirm', null, { primary: true, disabled: m.chosen.length !== 3, icon: 'play' }) +
      btn('Choose for me', 'random', null, { icon: 'star' }) + btn('Back', 'title', null, { cls: 'ab-quiet' }) + '</div>' +
      '</div>';
  }
  function eventHtml(m) {
    const zone = AB.state.zone ? esc(AB.state.zone) : 'On the road';
    if (m.phase === 'outcome') {
      const ch = m.choices[m.choice] || {};
      const verdict = m.ok === true ? '<p class="ab-verdict is-ok">It goes your way.</p>' : m.ok === false ? '<p class="ab-verdict is-bad">It goes badly.</p>' : '';
      return folio(kicker(zone) + '<h2 class="ab-display">' + esc(m.title) + '</h2>' + orn +
        '<p class="ab-chosen">' + icon('arrow') + esc(ch.label || '') + '</p>' + verdict +
        '<p class="ab-prose">' + esc(m.outcome) + '</p>' + chipsHtml(m.chips) +
        '<div class="ab-choices">' + btn((m.follow || []).some((f) => f.t === 'battle') ? 'Draw steel' : 'Continue', 'evcont', null, { primary: true, num: 1 }) + '</div>' + resStrip(), 'is-event', m.title);
    }
    return folio(kicker(m.src === 'camp' ? 'By the fire' : zone) + '<h2 class="ab-display">' + esc(m.title) + '</h2>' + orn +
      '<p class="ab-prose">' + esc(m.text) + '</p>' +
      '<ol class="ab-choices ab-choice-list">' + m.choices.map((c, i) => '<li><button type="button" class="ab-choice" data-act="choose" data-arg="' + i + '" data-num="' + (i + 1) + '"' + (c.disabled ? ' disabled' : '') + '>' +
        '<span class="ab-choice-n">' + (i + 1) + '</span><span class="ab-choice-l">' + esc(c.label) + (c.why ? '<span class="ab-why">' + esc(c.why) + '</span>' : '') + '</span>' +
        (c.odds != null ? '<span class="ab-odds" title="Chance">' + c.odds + '%</span>' : '') + '</button></li>').join('') + '</ol>' + resStrip(), 'is-event', m.title);
  }
  function campHtml(m) {
    const r = AB.state.run;
    const live = r.party.filter((u) => u.alive && !u.left);
    const hp = live.reduce((a, u) => a + u.hp, 0), mhp = live.reduce((a, u) => a + u.maxHp, 0);
    const ctx = { rest: 'Fellowship ' + hp + ' / ' + mhp + ' HP', forage: 'Supplies ' + r.supplies, steady: 'Corruption ' + r.corruption, stories: 'Hope ' + r.hope };
    const ic = { rest: 'heart', forage: 'leaf', steady: 'shard', stories: 'star' };
    const mem = memorialNote ? '<p class="ab-memorial">' + icon('cairn') + esc(memorialNote) + '</p>' : '';
    if (m.done) {
      const o = m.options.find((x) => x.id === m.pick) || {};
      return folio(kicker('Checkpoint &middot; the fire is lit') + '<h2 class="ab-display">The Campfire</h2>' + orn + mem +
        '<p class="ab-chosen">' + icon(ic[m.pick] || 'fire') + esc(o.name || '') + '</p>' + chipsHtml(m.chips) +
        '<p class="ab-dim ab-small">The road will rewind to this fire if Wren falls.</p>' +
        '<div class="ab-choices">' + btn('Break camp', 'leavecamp', null, { primary: true, num: 1, icon: 'play' }) + '</div>' + resStrip(), 'is-camp', 'Camp');
    }
    return folio(kicker('Checkpoint &middot; the fire is lit') + '<h2 class="ab-display">The Campfire</h2>' + orn + mem +
      '<p class="ab-prose">' + esc(m.intro) + '</p><p class="ab-dim ab-small">Choose one thing to do before you sleep.</p>' +
      '<div class="ab-opts">' + m.options.map((o, i) => '<button type="button" class="ab-opt" data-act="camp" data-arg="' + o.id + '" data-num="' + (i + 1) + '">' + icon(ic[o.id] || 'fire') +
        '<span class="ab-opt-t"><b>' + esc(o.name) + '</b><span>' + esc(o.text) + '</span><small>' + esc(ctx[o.id] || '') + '</small></span><span class="ab-choice-n">' + (i + 1) + '</span></button>').join('') + '</div>' +
      '<div class="ab-choices">' + btn('Leave without resting', 'leavecamp', null, { cls: 'ab-quiet' }) + '</div>' + resStrip(), 'is-camp', 'Camp');
  }
  function havenHtml(m) {
    const r = AB.state.run;
    const offer = (o, n) => '<button type="button" class="ab-offer" data-act="buy" data-arg="' + o.kind + ':' + o.idx + '" data-num="' + n + '"' + (o.disabled ? ' disabled' : '') + '>' +
      icon(o.kind === 'item' ? itemIcon(o.id) : o.kind === 'supplies' ? 'bread' : o.kind === 'heal' ? 'heart' : 'drop') +
      '<span class="ab-offer-t"><b>' + esc(o.name) + '</b><span>' + esc(rt(o.text)) + '</span>' + (o.why ? '<span class="ab-why">' + esc(o.why) + '</span>' : '') + '</span>' +
      '<span class="ab-price">' + icon('coin') + o.price + '</span></button>';
    const services = m.offers.filter((o) => o.kind !== 'item'), wares = m.offers.filter((o) => o.kind === 'item');
    let n = 0;
    return folio(kicker('Haven') + '<h2 class="ab-display">A Place to Trade</h2>' + orn + '<p class="ab-prose">' + esc(m.intro) + '</p>' +
      '<div class="ab-purse"><span class="ab-gilt">' + icon('coin') + '<b>' + r.silver + '</b> silver</span><span>' + icon('bag') + 'Pack ' + r.items.length + ' / 5</span><span>' + icon('bread') + r.supplies + ' supplies</span></div>' + chipsHtml(m.chips) +
      '<h4 class="ab-h4">Services</h4><div class="ab-offers">' + services.map((o) => offer(o, ++n)).join('') + '</div>' +
      '<h4 class="ab-h4">Wares</h4><div class="ab-offers">' + wares.map((o) => offer(o, ++n)).join('') + '</div>' +
      '<div class="ab-choices ab-sticky">' + btn('Leave the haven', 'leavehaven', null, { primary: true, icon: 'play' }) + '</div>', 'is-haven', 'Haven');
  }
  function shrineHtml(m) {
    if (m.done) return folio(kicker('Wayside shrine') + '<h2 class="ab-display">' + esc(m.title) + '</h2>' + orn + '<p class="ab-prose">The stone is warm under your hand, and for a while the Emberheart is only a weight.</p>' + chipsHtml(m.chips) + '<div class="ab-choices">' + btn('Walk on', 'shrine', 'leave', { primary: true, num: 1, icon: 'play' }) + '</div>' + resStrip(), 'is-shrine', m.title);
    return folio(kicker('Wayside shrine') + '<h2 class="ab-display">' + esc(m.title) + '</h2>' + orn + '<p class="ab-prose">' + esc(m.text) + '</p>' +
      '<ol class="ab-choices ab-choice-list">' + m.options.map((o, i) => '<li><button type="button" class="ab-choice" data-act="shrine" data-arg="' + o.id + '" data-num="' + (i + 1) + '"' + (o.disabled ? ' disabled' : '') + '><span class="ab-choice-n">' + (i + 1) + '</span><span class="ab-choice-l">' + esc(o.label) + (o.why ? '<span class="ab-why">' + esc(o.why) + '</span>' : '') + '</span></button></li>').join('') + '</ol>' + resStrip(), 'is-shrine', m.title);
  }
  function boonHtml(m) {
    return folio(kicker(m.src === 'boss' ? 'The way is open' : 'A gift on the road') + '<h2 class="ab-display">A Boon for the Road</h2>' + orn +
      '<p class="ab-dim ab-center">Choose one. It stays with the fellowship until the end.</p>' +
      '<div class="ab-boons">' + m.options.map((o, i) => { const b = BOONS[o.id] || { effect: {} }; return '<button type="button" class="ab-boon" data-act="boon" data-arg="' + o.id + '" data-num="' + (i + 1) + '"><span class="ab-boon-sigil">' + icon(BOON_ICON[b.effect.type] || 'star') + '</span><b class="ab-display">' + esc(o.name) + '</b><span>' + esc(rt(o.text)) + '</span><span class="ab-choice-n">' + (i + 1) + '</span></button>'; }).join('') + '</div>', 'is-boon', 'Boon');
  }
  function forgeHtml(m) {
    const r = AB.state.run;
    const line = { cast: 'Your hand is still your own.', falter: 'Your fingers will not open.', will: 'There is no one left to take it from you.', refuse: 'The Emberheart has your hand now. It does not want to fall.' }[m.mode] || '';
    return folio(kicker('Inside Mount Cindral') + '<h2 class="ab-display">The Unmaking Forge</h2>' + orn + '<p class="ab-prose">' + esc(m.text) + '</p>' +
      '<p class="ab-forge-state">' + shardSvg('is-inline', r.corruption / 100) + '<span><b>Corruption ' + r.corruption + '</b> &middot; Hope ' + r.hope + '<br><i>' + esc(line) + '</i></span></p>' +
      '<div class="ab-choices">' + m.options.map((o, i) => btn(esc(o.label), 'forge', o.id, { primary: i === 0, num: i + 1, icon: o.id === 'cast' ? 'fire' : o.id === 'yield' ? 'shard' : 'hand' })).join('') + '</div>', 'is-forge', 'The Unmaking Forge');
  }
  function pauseHtml() {
    const r = AB.state.run;
    const side = panel === 'help' ? helpHtml() : settingsHtml();
    return folio('<div class="ab-pause">' +
      '<div class="ab-pause-main">' + kicker(r ? 'Road No. ' + r.seed + ' &middot; Act ' + ROMAN[Math.min(3, r.act)] : '') + '<h2 class="ab-display">Paused</h2>' +
      (r ? '<p class="ab-dim ab-small">' + esc(AB.state.objective || '') + '</p>' : '') +
      '<div class="ab-choices">' + btn('Resume', 'resume', null, { primary: true, icon: 'play' }) +
      btn('Settings', 'panel', 'settings', { icon: 'gear', on: panel !== 'help' }) + btn('How to play', 'panel', 'help', { icon: 'book', on: panel === 'help' }) +
      btn(AB.combat.inCombat || (AB.state.run && AB.state.run.party.some((m) => m.downed)) ? 'Return to the title (resume at the last fire)' : 'Save and return to the title', 'quit', null, { cls: 'ab-quiet', icon: 'close' }) + '</div></div>' +
      '<div class="ab-pause-side">' + side + '</div></div>', 'is-pause', 'Paused');
  }
  function inventoryHtml(m) {
    const slots = [];
    for (let i = 0; i < 5; i++) {
      const it = m.items[i];
      if (!it) { slots.push('<div class="ab-slotcard is-empty"><span>' + icon('bag') + '</span><small>Empty</small></div>'); continue; }
      slots.push('<div class="ab-slotcard">' + icon(itemIcon(it.id), 'ab-item-ic') + '<div class="ab-slot-t"><b>' + esc(it.name) + '</b><span>' + esc(rt(it.text)) + '</span>' + (it.why ? '<span class="ab-why">' + esc(it.why) + '</span>' : '') + '</div>' +
        '<div class="ab-slot-b">' + btn('Use', 'use', it.idx, { primary: !it.why, disabled: !!it.why, num: i + 1 }) + btn('Drop', 'drop', it.idx, { cls: 'ab-quiet' }) + '</div></div>');
    }
    return folio(kicker('Carried on the road') + '<h2 class="ab-display">The Pack</h2>' + orn + '<div class="ab-slots">' + slots.join('') + '</div>' +
      '<p class="ab-dim ab-small">' + (isTouch() ? 'The item button by the strike button uses the first item that can be used now.' : 'Q uses the first item that can be used now (for heroes other than Wren).') + '</p>' + resStrip() +
      '<div class="ab-choices ab-sticky">' + btn('Close', 'resume', null, { primary: true, icon: 'close' }) + '</div>', 'is-pack', 'Pack');
  }
  function partyHtmlScreen() {
    const r = AB.state.run;
    const card = (u) => {
      const c = CMP[u.id];
      const st = Object.keys(u.status || {}).filter((k) => STATUS[k]).map((k) => '<span class="ab-pip is-' + STATUS[k].c + '">' + icon(STATUS[k].i) + STATUS[k].n + '</span>').join('');
      return '<div class="ab-member' + (u.alive ? '' : ' is-dead') + '">' + face(u.id, 'is-big') + '<div class="ab-member-t"><h3 class="ab-display">' + esc(u.name) + '</h3>' +
        '<p class="ab-label ab-dim">' + esc(c.role) + ' &middot; ' + (u.alive ? u.hp + ' / ' + u.maxHp + ' HP' : esc(u.fell || 'Fallen')) + '</p>' +
        (u.alive ? '<span class="ab-bar is-hp"><i style="width:' + (u.hp / u.maxHp * 100).toFixed(0) + '%"></i></span>' : '') + (st ? '<div class="ab-pips">' + st + '</div>' : '') +
        '<p class="ab-small"><b>' + esc(c.trait.name) + '.</b> ' + esc(rt(c.trait.text)) + '</p>' +
        '<ul class="ab-abil is-compact">' + c.abilities.map((a) => '<li>' + icon(abilityIcon(u.id, a)) + '<span><b>' + esc(a.name) + '</b> <small class="ab-dim">' + (secs(a) ? 'every ' + secs(a) + ' s' : 'at will') + '</small></span></li>').join('') + '</ul></div></div>';
    };
    const boons = r.boons.map((id) => BOONS[id]).filter(Boolean);
    return folio(kicker('Road No. ' + r.seed) + '<h2 class="ab-display">Your fellowship</h2>' + orn + '<div class="ab-members">' + r.party.map(card).join('') + '</div>' +
      '<h4 class="ab-h4">Boons</h4>' + (boons.length ? '<ul class="ab-boonlist">' + boons.map((b) => '<li>' + icon(BOON_ICON[b.effect.type] || 'star') + '<span><b>' + esc(b.name) + '.</b> ' + esc(rt(b.text)) + '</span></li>').join('') + '</ul>' : '<p class="ab-dim ab-small">None yet. A boon is offered after each great foe falls.</p>') +
      '<div class="ab-choices ab-sticky">' + btn('Close', 'resume', null, { primary: true, icon: 'close' }) + '</div>', 'is-party', 'Fellowship');
  }
  function mapHtml() {
    const lv = AB.world.level;
    const legend = ['battle', 'elite', 'boss', 'event', 'camp', 'haven', 'chest', 'shrine'].map((t) => '<li><i class="ab-lg" data-type="' + t + '"></i>' + esc(POI_NAME[t]) + '</li>').join('');
    return folio(kicker(lv && lv.name ? esc(lv.name) : 'The road') + '<h2 class="ab-display">The Road So Far</h2>' + orn +
      '<div class="ab-mapwrap"><canvas class="ab-bigmap" width="600" height="600" aria-label="Map of the road"></canvas></div>' +
      '<ul class="ab-legend ab-label">' + legend + '</ul>' +
      '<div class="ab-choices ab-sticky">' + btn('Close', 'resume', null, { primary: true, icon: 'close' }) + '</div>', 'is-map', 'Map');
  }
  function endingHtml(m) {
    const ch = m.chronicle || {};
    const r = AB.state.run;
    const roster = r ? r.party.map((u) => '<span class="ab-roster' + (u.alive ? '' : ' is-dead') + '">' + face(u.id) + '<small>' + esc(first(u.name)) + '</small></span>').join('') : '';
    const row = (k, v) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>';
    return folio(kicker(m.win ? 'The end of the road' : 'The road ends here') + '<h2 class="ab-display ab-ending-title' + (m.win ? ' is-win' : ' is-loss') + '">' + esc(m.title) + '</h2>' + orn +
      '<p class="ab-prose">' + esc(m.text) + '</p>' +
      '<div class="ab-roster-row">' + roster + '</div>' +
      '<h4 class="ab-h4">The Chronicle of ' + esc(ch.road || '') + '</h4><dl class="ab-chron ab-label">' +
      row('Time on the road', U.fmtTime(ch.timeSec || 0)) + row('Distance walked', (ch.distance || 0) + ' m') +
      row('Battles won', (ch.battles || 0) + (ch.elites ? ' &middot; ' + ch.elites + ' elite' : '') + (ch.bosses ? ' &middot; ' + ch.bosses + ' great foe' + (ch.bosses > 1 ? 's' : '') : '')) +
      row('Chests opened', ch.chests || 0) + row('Strangers met', ch.events || 0) + row('Rewinds', ch.rewinds || 0) +
      row('Peak Corruption', ch.peak || 0) + row('Companions lost', ch.lost && ch.lost.length ? esc(ch.lost.join(', ')) : 'none') +
      row('Boons', ch.boons && ch.boons.length ? esc(ch.boons.join(', ')) : 'none') + '</dl>' +
      '<div class="ab-choices ab-sticky">' + btn('Walk again', 'again', null, { primary: true, icon: 'fire', num: 1 }) + '</div>', 'is-ending' + (m.win ? ' is-win' : ' is-loss'), m.title);
  }
  function screenHtml(name, m) {
    switch (name) {
      case 'title': return titleHtml(m);
      case 'pick': return pickHtml(m);
      case 'actcard':
        return '<div class="ab-actcard"><div class="ab-letter is-top"></div><div class="ab-letter is-bot"></div><div class="ab-actcard-t ab-passthru">' +
          '<p class="ab-act-n ab-label">Act ' + esc(m.numeral) + '</p><h1 class="ab-display">' + esc(m.name) + '</h1><p class="ab-act-r ab-label">' + esc(m.region) + '</p>' + orn +
          '<p class="ab-act-intro">' + esc(m.intro) + '</p></div><div class="ab-actcard-b">' + btn('Begin', 'skipcard', null, { primary: true, icon: 'play' }) + '<span class="ab-hintkey ab-label">' + (isTouch() ? '' : 'or press E') + '</span></div></div>';
      case 'event': return eventHtml(m);
      case 'camp': return campHtml(m);
      case 'haven': return havenHtml(m);
      case 'shrine': return shrineHtml(m);
      case 'boon': return boonHtml(m);
      case 'forge': return forgeHtml(m);
      case 'pause': return pauseHtml();
      case 'inventory': return inventoryHtml(m);
      case 'party': return partyHtmlScreen();
      case 'map': return mapHtml();
      case 'endingcine': return '<div class="ab-endingcine' + (m.win ? ' is-win' : ' is-loss') + '"><div class="ab-letter is-top"></div><div class="ab-letter is-bot"></div><h1 class="ab-display">' + esc(m.title) + '</h1></div>';
      case 'ending': return endingHtml(m);
      default: return '';
    }
  }
  function renderScreen() {
    const st = AB.state;
    const name = st.screen, m = st.modal || {};
    const loading = document.getElementById('ab-loading');
    if (loading) {
      const show = name === 'boot' || name === 'loading';
      loading.classList.toggle('is-done', !show);
      if (name === 'loading') {
        const act = m.act === 'forge' ? 4 : m.act;
        const t = loading.querySelector('.ab-loading-text'); if (t) t.textContent = m.rewind ? 'The road rewinds to the last fire. Hope falters.' : act === 4 ? 'Down into the mountain' : 'The road to ' + (m.label || 'the next land');
        const n = loading.querySelector('.ab-loading-act'); if (n) n.textContent = act === 4 ? 'The last stair' : act ? 'Act ' + ROMAN[act] : '';
        const h = loading.querySelector('.ab-loading-title'); if (h) h.textContent = act === 4 ? 'The Unmaking Forge' : (m.label || 'Ashbearer');
      }
    }
    const prevName = scr.dataset.screen;
    scr.dataset.screen = name;
    scr.innerHTML = screenHtml(name, m);
    if (name !== prevName) { scr.classList.remove('is-enter'); void scr.offsetWidth; scr.classList.add('is-enter'); }
    hud.hidden = name !== 'play';
    touchEl.hidden = name !== 'play';
    if (name === 'map') drawBigMap(scr.querySelector('.ab-bigmap'));
    // keyboard focus: the primary action (never steal focus on touch devices)
    if (!isTouch() && name !== 'play' && name !== 'actcard' && name !== 'endingcine') {
      const keep = document.activeElement && scr.contains(document.activeElement);
      if (!keep || name !== prevName) {
        const f = scr.querySelector('.ab-btn.is-primary:not(:disabled), .ab-choice:not(:disabled), .ab-opt, .ab-boon, .ab-btn:not(:disabled)');
        if (f) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
    }
  }

  // =====================================================================================================
  // INPUT FROM THE DOM (clicks, sliders, menu keys)
  // =====================================================================================================
  let screenAt = 0;
  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    // second ghost-click guard: no folio button fires from a touch within 350 ms of its folio opening
    if (e.pointerType === 'touch' && performance.now() - screenAt < 350 && b.closest('.ab-screen')) return;
    const a = b.dataset.act, arg = b.dataset.arg;
    const g = AB.game;
    AB.bus.emit('ui:click', { act: a });
    switch (a) {
      case 'pick': panel = null; g.openPick(); break;
      case 'continue': panel = null; g.continueRun(); break;
      case 'panel': panel = !arg ? null : AB.state.screen === 'pause' ? arg : (panel === arg ? null : arg); dirty = true; break;
      case 'quality': AB.setSetting('quality', arg); dirty = true; break;
      case 'toggleset': AB.setSetting(arg, !AB.settings[arg]); dirty = true; break;
      case 'sound': AB.setSetting('sound', !AB.settings.sound); dirty = true; break;
      case 'toggle': pickFocus = arg; g.togglePick(arg); if (g.inspectPick) g.inspectPick(arg); break;
      case 'inspect': pickFocus = arg; if (g.inspectPick) g.inspectPick(arg); dirty = true; break;
      case 'confirm': g.confirmPick(); break;
      case 'random': { const m = AB.state.modal; const ids = AB.rng(Date.now()).shuffle(m.recruits.map((r) => r.id)).slice(0, 3); g.confirmPick(ids); break; }
      case 'title': g.toTitle(); break;
      case 'skipcard': g.skipCard(); break;
      case 'choose': g.chooseEvent(Number(arg)); break;
      case 'evcont': g.continueEvent(); break;
      case 'camp': g.campChoose(arg); break;
      case 'leavecamp': memorialNote = null; g.leaveCamp(); break;
      case 'buy': { const [k, i] = String(arg).split(':'); g.havenBuy(k, Number(i)); break; }
      case 'leavehaven': g.leaveHaven(); break;
      case 'shrine': g.shrineChoose(arg); break;
      case 'boon': g.takeBoon(arg); break;
      case 'forge': g.forgeAct(arg); break;
      case 'resume': panel = null; g.resume(); break;
      case 'quit': panel = null; g.quitToTitle(); break;
      case 'use': g.useItem(Number(arg)); break;
      case 'drop': g.dropItem(Number(arg)); break;
      case 'again': g.walkAgain(); break;
      case 'hero': g.switchHero(Number(arg)); break;
      case 'pause': g.pause(); break;
      case 'pack': g.openInventory(); break;
      case 'party': g.openParty(); break;
      case 'map': g.openMap(); break;
      case 'interact': g.interactNearest(); break;
      default: break;
    }
  }
  function onInput(e) {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.set) return;
    const key = el.dataset.set, v = Number(el.value);
    AB.setSetting(key, v / 100);
    const out = uiEl.querySelector('[data-out="' + key + '"]');
    if (out) out.textContent = key === 'sensitivity' ? (v / 100).toFixed(2) + 'x' : Math.round(v) + '%';
  }
  function onKeyMenu(e) {
    const st = AB.state; if (!st || st.screen === 'play' || st.screen === 'boot' || st.screen === 'loading') return;
    if (e.target && e.target.tagName === 'INPUT') return;
    const m = /^(Digit|Numpad)([1-9])$/.exec(e.code);
    if (m && !e.repeat) {
      const b = scr.querySelector('[data-num="' + m[2] + '"]:not(:disabled)');
      if (b) { e.preventDefault(); b.click(); }
      return;
    }
    if (e.code === 'Escape' && panel && (st.screen === 'title')) { panel = null; dirty = true; }
    if (e.code === 'Enter' && st.screen === 'actcard') AB.game.skipCard();
  }

  // =====================================================================================================
  // HUD
  // =====================================================================================================
  const refs = {};
  const ref = (n) => refs[n];
  function buildHud() {
    hud.innerHTML =
      '<div class="hud-party" data-ref="party"></div>' +
      '<div class="hud-res">' +
        '<div class="hud-ember" data-ref="ember">' + shardSvg('is-hud', 0) + '<div class="hud-ember-t"><span class="ab-label hud-k">Corruption</span><b class="hud-corr" data-ref="corr">0</b><span class="hud-state" data-ref="corrstate">Quiet</span></div></div>' +
        '<div class="hud-hope"><span class="ab-label hud-k">Hope</span><span class="ab-bar is-hope"><i data-ref="hopebar"></i><em style="left:10%"></em><em style="left:30%"></em><em style="left:70%"></em></span><b data-ref="hope">60</b><span class="hud-state" data-ref="hopestate">Steady</span></div>' +
        '<div class="hud-purse ab-label"><span class="hud-sup" data-ref="supw">' + icon('bread') + '<b data-ref="sup">0</b><i class="hud-supm"><i data-ref="supm"></i></i></span><span class="hud-sil">' + icon('coin') + '<b data-ref="silver">0</b></span></div>' +
      '</div>' +
      '<div class="hud-top"><div class="hud-obj" data-ref="obj"></div><div class="hud-zone ab-label" data-ref="zone"></div></div>' +
      '<div class="hud-map"><canvas class="hud-mini" data-ref="mini" width="300" height="300" aria-hidden="true"></canvas><span class="hud-dist ab-label" data-ref="dist"></span></div>' +
      '<div class="hud-menu">' + btn('', 'pack', null, { icon: 'bag', cls: 'ab-iconly hud-mb', aria: 'Pack' }) + btn('', 'map', null, { icon: 'map', cls: 'ab-iconly hud-mb', aria: 'Map' }) + btn('', 'party', null, { icon: 'book', cls: 'ab-iconly hud-mb', aria: 'Fellowship' }) + btn('', 'pause', null, { icon: 'pause', cls: 'ab-iconly hud-mb', aria: 'Pause' }) + '</div>' +
      '<div class="hud-boss" data-ref="boss" hidden><div class="hud-boss-n ab-display" data-ref="bossname"></div><div class="hud-boss-bar"><i class="is-trail" data-ref="bosstrail"></i><i data-ref="bossbar"></i><em style="left:60%"></em><em style="left:30%"></em></div><div class="hud-boss-s ab-label" data-ref="bossstate"></div></div>' +
      '<button type="button" class="hud-prompt" data-act="interact" data-ref="prompt" hidden><kbd data-ref="pkey">E</kbd><span data-ref="ptext"></span></button>' +
      '<div class="hud-abil" data-ref="abil"></div>';
    for (const el of hud.querySelectorAll('[data-ref]')) refs[el.dataset.ref] = el;
    refs.shardFill = hud.querySelector('.hud-ember [data-fill]');
  }
  let partyKey = '';
  function partyRows() {
    const r = AB.state.run; if (!r) return '';
    const list = r.party.filter((m) => !m.left);
    return list.map((m, i) => '<button type="button" class="hud-pm" data-act="hero" data-arg="' + i + '" data-uid="' + m.uid + '" aria-label="' + esc(m.name) + '">' +
      face(m.id, 'is-hud') + '<span class="hud-pm-t"><span class="hud-pm-n ab-label">' + esc(first(m.name)) + '</span><span class="ab-bar is-hp"><i class="is-lag"></i><i class="is-now"></i></span><span class="hud-pm-s"></span></span>' +
      '<span class="hud-pm-down ab-label"></span><kbd class="hud-pm-k">' + (i + 1) + '</kbd></button>').join('');
  }
  const pmState = new Map();   // uid -> {lag}
  function statusPips(u) {
    let h = '';
    for (const k in u.status) { const s = STATUS[k]; if (s) h += '<i class="ab-pip is-' + s.c + '" title="' + s.n + '">' + icon(s.i) + '</i>'; }
    return h;
  }
  let lastBossHp = 1, bossTrail = 1, bossTrailT = 0;
  function updateHud(dt) {
    const r = AB.state.run; if (!r) return;
    const key = r.party.map((m) => m.uid + (m.left ? 'L' : '')).join(',');
    if (key !== partyKey) { partyKey = key; ref('party').innerHTML = partyRows(); pmState.clear(); }
    const ctl = AB.combat.controlled();
    for (const el of ref('party').children) {
      const uid = Number(el.dataset.uid);
      const u = r.party.find((m) => m.uid === uid); if (!u) continue;
      let ps = pmState.get(uid); if (!ps) { ps = { lag: u.hp / u.maxHp, els: { now: el.querySelector('.is-now'), lag: el.querySelector('.is-lag'), s: el.querySelector('.hud-pm-s'), d: el.querySelector('.hud-pm-down') } }; pmState.set(uid, ps); }
      const f = u.alive ? U.clamp(u.hp / u.maxHp, 0, 1) : 0;
      ps.lag = f > ps.lag ? f : U.damp(ps.lag, f, 3, dt);
      set(el, '.is-ctl', u === ctl); set(el, '.is-down', !!u.downed); set(el, '.is-dead', !u.alive); set(el, '.is-low', u.alive && f < 0.3);
      set(ps.els.now, 'transform', 'scaleX(' + f.toFixed(3) + ')');
      set(ps.els.lag, 'transform', 'scaleX(' + ps.lag.toFixed(3) + ')');
      set(ps.els.s, 'html', u.alive && !u.downed ? statusPips(u) : '');
      set(ps.els.d, 'text', u.downed ? Math.ceil(u.downT) + 's' : !u.alive ? 'Fallen' : '');
    }
    set(ref('obj'), 'text', AB.state.objective || '');
    set(ref('zone'), 'text', AB.state.zone || '');
    // Hope
    set(ref('hope'), 'text', String(r.hope));
    set(ref('hopebar'), 'width', r.hope + '%');
    const hs = AB.game.hopeState(r.hope);
    set(ref('hopestate'), 'text', hs);
    set(ref('hopebar').parentNode, '@data-state', hs);
    // Corruption: the Emberheart fills with fire; glow and the screen-edge ember grow with it
    const c = r.corruption;
    set(ref('corr'), 'text', String(c));
    set(ref('corrstate'), 'text', AB.game.corrState(c));
    set(refs.shardFill, '@y', (56 * (1 - c / 100)).toFixed(1));
    set(ref('ember'), '--glow', (c / 100).toFixed(2));
    set(ref('ember'), '@data-band', c >= 70 ? 'bound' : c >= 40 ? 'touched' : 'quiet');
    // supplies (+ travel meter toward the next one) and silver
    set(ref('sup'), 'text', String(r.supplies));
    set(ref('supm'), 'width', ((r.supplyMeter || 0) / 60 * 100).toFixed(0) + '%');
    set(ref('supw'), '.is-starving', r.supplies <= 0);
    set(ref('silver'), 'text', String(r.silver));
    // prompt
    const p = AB.state.prompt;
    set(ref('prompt'), 'hidden', !p || isTouch());
    if (p) { set(ref('ptext'), 'text', p.text); set(ref('pkey'), 'text', p.key || 'E'); }
    // abilities (desktop bar)
    if (ctl && ctl.slots && !isTouch()) updateAbilityBar(ctl);
    // boss bar
    const b = boss && boss.spawned && boss.alive ? boss : null;
    set(ref('boss'), 'hidden', !b);
    if (b) {
      const f = U.clamp(b.hp / b.maxHp, 0, 1);
      if (f < lastBossHp - 1e-4) bossTrailT = 0.6;
      lastBossHp = f;
      bossTrailT -= dt; if (bossTrailT <= 0) bossTrail = U.damp(bossTrail, f, 4, dt);
      if (bossTrail < f) bossTrail = f;
      set(ref('bossname'), 'text', b.name);
      set(ref('bossbar'), 'transform', 'scaleX(' + f.toFixed(4) + ')');
      set(ref('bosstrail'), 'transform', 'scaleX(' + bossTrail.toFixed(4) + ')');
      set(ref('bossstate'), 'text', bossState || (b.def && b.def.blurb ? '' : ''));
    }
    // Corruption vignette (v1 behaviour: grows from 40, pulses past 70 in the grade shader)
    AB.post.params.ember = U.clamp((c - 25) / 75, 0, 1) * 0.9;
  }
  let bossState = '';

  // ---------------------------------------------------------------------------------- ability bar (desktop)
  const SLOT_KEYS = { attack: 'J', skill1: 'K', skill2: 'L', ember: 'Q', dodge: 'Space' };
  let abilKey = '';
  function quickItemInfo() {
    const r = AB.state.run; if (!r) return null;
    for (let i = 0; i < r.items.length; i++) if (!AB.game.itemUsable(r.items[i])) return { idx: i, id: r.items[i], name: C.items[r.items[i]].name };
    return null;
  }
  function slotList(u) {
    const cd = AB.combat.cooldowns(u);
    const out = [];
    for (const s of ['attack', 'skill1', 'skill2']) if (cd[s]) out.push({ s, name: cd[s].name, icon: abilityIcon(u.id, u.slots[s]), c: cd[s] });
    if (cd.ember) out.push({ s: 'ember', name: cd.ember.name.replace('Wield the ', ''), icon: 'shard', c: cd.ember, ember: true });
    else { const q = quickItemInfo(); out.push({ s: 'ember', name: q ? q.name : 'No item', icon: q ? itemIcon(q.id) : 'bag', c: null, item: true, none: !q }); }
    out.push({ s: 'dodge', name: 'Roll', icon: 'roll', c: null, dodge: true });
    return out;
  }
  function updateAbilityBar(u) {
    const list = slotList(u);
    const k = u.uid + ':' + list.map((x) => x.s + x.name).join('|');
    const ab = ref('abil');
    if (k !== abilKey) {
      abilKey = k;
      ab.innerHTML = list.map((x) => '<div class="hud-slot' + (x.ember ? ' is-ember' : '') + (x.item ? ' is-item' : '') + (x.none ? ' is-none' : '') + '" data-slot="' + x.s + '">' +
        '<span class="hud-slot-i">' + icon(x.icon) + '<i class="hud-sweep"></i><b class="hud-cdn"></b></span><kbd>' + SLOT_KEYS[x.s] + '</kbd><span class="hud-slot-n ab-label">' + esc(x.name) + '</span></div>').join('');
      ab._slots = Array.from(ab.children).map((el) => ({ el, sweep: el.querySelector('.hud-sweep'), n: el.querySelector('.hud-cdn') }));
    }
    const cd = AB.combat.cooldowns(u);
    const T = AB.combat.TUNE || {};
    for (const o of ab._slots) {
      const s = o.el.dataset.slot;
      let left = 0, total = 1, ready = true;
      if (s === 'dodge') { left = Math.max(0, u.dodgeCd || 0); total = (T.dodgeDur || 0.42) + (T.dodgeRecover || 0.3); ready = left <= 0; }
      else if (cd[s]) { left = Math.max(0, cd[s].left); total = cd[s].total || 1; ready = cd[s].ready; }
      const f = left > 0 ? U.clamp(left / total, 0, 1) : 0;
      set(o.sweep, '--p', f.toFixed(3));
      set(o.n, 'text', left > 0.95 && s !== 'attack' && s !== 'dodge' ? String(Math.ceil(left)) : '');
      set(o.el, '.is-ready', ready && f === 0);
    }
  }

  // ---------------------------------------------------------------------------------- touch thumb cluster
  const TB = ['attack', 'dodge', 'skill1', 'skill2', 'ember', 'interact'];
  let touchSlots = null, touchKey = '';
  function buildTouch() {
    touchEl.innerHTML = TB.map((a) => '<button type="button" class="ab-tb" data-t="' + a + '" aria-label="' + a + '"><span class="ab-tb-i"></span><i class="ab-tb-sweep"></i><b class="ab-tb-n"></b><span class="ab-tb-l ab-label"></span></button>').join('') +
      '';
    touchSlots = {};
    for (const b of touchEl.querySelectorAll('[data-t]')) touchSlots[b.dataset.t] = { el: b, i: b.querySelector('.ab-tb-i'), sw: b.querySelector('.ab-tb-sweep'), n: b.querySelector('.ab-tb-n'), l: b.querySelector('.ab-tb-l') };
    const down = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      AB.input.press(b.dataset.t); b.classList.add('is-down');
      if (navigator.vibrate && b.dataset.t === 'dodge') { try { navigator.vibrate(8); } catch (err) { /* ignore */ } }
    };
    const up = (e) => { const b = e.target.closest('[data-t]'); if (!b || !b.classList.contains('is-down')) return; AB.input.release(b.dataset.t); b.classList.remove('is-down'); };
    touchEl.addEventListener('pointerdown', down);
    touchEl.addEventListener('pointerup', up); touchEl.addEventListener('pointercancel', up);
    touchEl.addEventListener('contextmenu', (e) => e.preventDefault());
    // a tap on a thumb button must never turn into a click on the folio that this same tap just opened (ghost click)
    touchEl.addEventListener('touchend', (e) => { if (e.cancelable && e.target && e.target.closest && e.target.closest('[data-t]')) e.preventDefault(); }, { passive: false });
  }
  function updateTouch(u) {
    if (!touchSlots || !u) return;
    const cd = AB.combat.cooldowns(u);
    const q = cd.ember ? null : quickItemInfo();
    const p = AB.state.prompt;
    const k = u.uid + ':' + (cd.skill1 ? cd.skill1.id : '') + (cd.skill2 ? cd.skill2.id : '') + (cd.ember ? 'E' : q ? q.id : '-') + ':' + (p ? p.text : '');
    if (k !== touchKey) {
      touchKey = k;
      const setI = (a, ic, label) => { const s = touchSlots[a]; s.i.innerHTML = icon(ic); s.l.textContent = label || ''; };
      setI('attack', abilityIcon(u.id, u.slots.attack), '');
      setI('dodge', 'roll', '');
      setI('skill1', cd.skill1 ? abilityIcon(u.id, u.slots.skill1) : 'star', '');
      setI('skill2', cd.skill2 ? abilityIcon(u.id, u.slots.skill2) : 'star', '');
      if (cd.ember) setI('ember', 'shard', ''); else setI('ember', q ? itemIcon(q.id) : 'bag', '');
      setI('interact', 'hand', p ? p.text : '');
      touchSlots.ember.el.classList.toggle('is-ember', !!cd.ember);
      touchSlots.ember.el.classList.toggle('is-item', !cd.ember);
      touchSlots.ember.el.classList.toggle('is-none', !cd.ember && !q);
      touchSlots.skill1.el.hidden = !cd.skill1; touchSlots.skill2.el.hidden = !cd.skill2;
      touchSlots.attack.el.setAttribute('aria-label', cd.attack ? cd.attack.name : 'Attack');
      if (cd.skill1) touchSlots.skill1.el.setAttribute('aria-label', cd.skill1.name);
      if (cd.skill2) touchSlots.skill2.el.setAttribute('aria-label', cd.skill2.name);
      touchSlots.ember.el.setAttribute('aria-label', cd.ember ? cd.ember.name : q ? 'Use ' + q.name : 'No item to use');
    }
    set(touchSlots.interact.el, 'hidden', !p);
    const T = AB.combat.TUNE || {};
    for (const a of ['attack', 'skill1', 'skill2', 'ember', 'dodge']) {
      const s = touchSlots[a];
      let left = 0, total = 1;
      if (a === 'dodge') { left = Math.max(0, u.dodgeCd || 0); total = (T.dodgeDur || 0.42) + (T.dodgeRecover || 0.3); }
      else if (cd[a]) { left = Math.max(0, cd[a].left); total = cd[a].total || 1; }
      const f = left > 0 ? U.clamp(left / total, 0, 1) : 0;
      set(s.sw, '--p', f.toFixed(3));
      set(s.n, 'text', left > 0.95 && a !== 'attack' && a !== 'dodge' ? String(Math.ceil(left)) : '');
      set(s.el, '.is-cool', f > 0);
    }
  }

  // ---------------------------------------------------------------------------------- minimap
  const mini = { ctx: null, img: null, level: null, roadPath: null, branchPath: null, explored: -1, expPath: null, frame: 0 };
  const POI_COL = { battle: '#d4574f', elite: '#d4574f', boss: '#ff6a55', event: '#9ec2e6', camp: '#ff9b4a', haven: '#d6b25e', chest: '#d6b25e', shrine: '#b9d6f0', forge: '#ff7b2e' };
  function miniLevel() {
    const lv = AB.world.level;
    if (mini.level === lv) return !!mini.img;
    mini.level = lv; mini.img = null; mini.roadPath = null; mini.branchPath = null; mini.explored = -1;
    if (!lv || !AB.world.mapImage) return false;
    try {
      const im = AB.world.mapImage(256); mini.img = im ? im.canvas : null;
      const mm = AB.world.minimap ? AB.world.minimap() : null;
      if (mm && typeof Path2D !== 'undefined') {
        const rp = new Path2D(); for (let i = 0; i < mm.road.length; i += 2) (i ? rp.lineTo(mm.road[i], mm.road[i + 1]) : rp.moveTo(mm.road[i], mm.road[i + 1]));
        mini.roadPath = rp;
        const bp = new Path2D();
        for (const b of mm.branches) for (let i = 0; i < b.pts.length; i += 2) (i ? bp.lineTo(b.pts[i], b.pts[i + 1]) : bp.moveTo(b.pts[i], b.pts[i + 1]));
        mini.branchPath = bp;
      }
    } catch (e) { mini.img = null; }
    return !!mini.img;
  }
  const tmpV = new V3();
  function exploredPath(r) {
    let n = 0; const ex = r.explored; if (ex) for (let i = 0; i < ex.length; i++) if (ex[i]) n++;   // no per-draw array allocation
    if (n === mini.explored && mini.expPath) return mini.expPath;
    mini.explored = n;
    const p = new Path2D();
    const L = AB.world.level.road.length;
    for (let seg = 0; seg < (r.explored || []).length; seg++) {
      if (!r.explored[seg]) continue;
      const s0 = seg * 10, s1 = Math.min(L, s0 + 10.5);
      for (let s = s0, k = 0; s <= s1 + 0.01; s += 2.5, k++) { AB.world.roadPoint(Math.min(s, L), tmpV); if (k) p.lineTo(tmpV.x, tmpV.z); else p.moveTo(tmpV.x, tmpV.z); }
    }
    mini.expPath = p;
    return p;
  }
  function poiGlyph(g, type, x, y, s, done) {
    g.save(); g.translate(x, y);
    g.globalAlpha = done ? 0.4 : 1;
    g.fillStyle = POI_COL[type] || '#e8e2cf'; g.strokeStyle = 'rgba(10,12,16,0.85)'; g.lineWidth = s * 0.35;
    g.beginPath();
    if (type === 'battle') { g.moveTo(0, -s); g.lineTo(s, 0); g.lineTo(0, s); g.lineTo(-s, 0); g.closePath(); }
    else if (type === 'elite' || type === 'boss') { const k = type === 'boss' ? 1.6 : 1.3; g.moveTo(0, -s * k); g.lineTo(s * k, 0); g.lineTo(0, s * k); g.lineTo(-s * k, 0); g.closePath(); }
    else if (type === 'camp' || type === 'forge') { g.moveTo(0, -s * 1.2); g.lineTo(s, s * 0.8); g.lineTo(-s, s * 0.8); g.closePath(); }
    else if (type === 'haven' || type === 'chest') { const k = type === 'chest' ? 0.75 : 1; g.rect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
    else { g.arc(0, 0, s * 0.9, 0, Math.PI * 2); }
    g.stroke(); g.fill();
    if (type === 'boss' && !done) { g.beginPath(); g.arc(0, 0, s * 2.4, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,106,85,0.7)'; g.lineWidth = s * 0.3; g.stroke(); }
    g.restore();
  }
  let objectivePoi = null;
  function drawMinimap() {
    const cv = ref('mini'); if (!cv) return;
    const lv = AB.world.level, r = AB.state.run, u = AB.combat.controlled();
    if (!lv || !r || !u) return;
    const W = cv.width, R = W / 2;
    if (!mini.ctx) mini.ctx = cv.getContext('2d');
    const g = mini.ctx; if (!g) return;
    const has = miniLevel();
    const range = 60;                         // metres from the centre to the rim
    const k = R / range;
    const th = AB.cam.yaw;
    const cs = Math.cos(th), sn = Math.sin(th);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#10161d'; g.fillRect(0, 0, W, W);
    g.translate(R, R); g.rotate(th); g.scale(k, k); g.translate(-u.pos.x, -u.pos.z);
    if (has) {
      const b = lv.bounds;
      g.globalAlpha = 0.95;
      g.drawImage(mini.img, b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
      g.globalAlpha = 1;
    }
    if (mini.branchPath) { g.strokeStyle = 'rgba(232,226,207,0.28)'; g.lineWidth = 2.2 / k * 1.6; g.setLineDash([4 / k * 1.5, 4 / k * 1.5]); g.stroke(mini.branchPath); g.setLineDash([]); }
    if (mini.roadPath) { g.strokeStyle = 'rgba(232,226,207,0.22)'; g.lineWidth = 3 / k * 1.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(mini.roadPath); }
    if (lv.act !== 'forge') { g.strokeStyle = 'rgba(240,226,190,0.75)'; g.lineWidth = 2.6 / k * 1.6; g.stroke(exploredPath(r)); }
    g.restore();
    // POIs (upright glyphs), objective pointer on the rim
    const gs = W / 52;
    for (const p of lv.pois) {
      if (p.state === 'hidden') continue;
      const dx = (p.x - u.pos.x) * k, dz = (p.z - u.pos.z) * k;
      const x = dx * cs - dz * sn, y = dx * sn + dz * cs;
      const d = Math.hypot(x, y);
      if (d < R - gs * 2) poiGlyph(g, p.type, R + x, R + y, gs, AB.game.poiDone(p));
    }
    const op = objectivePoi ? AB.world.poi(objectivePoi) : null;
    if (op) {
      const dx = (op.x - u.pos.x) * k, dz = (op.z - u.pos.z) * k;
      const x = dx * cs - dz * sn, y = dx * sn + dz * cs; const d = Math.hypot(x, y) || 1;
      if (d > R - gs * 2.5) {
        const a = Math.atan2(y, x), rr = R - gs * 1.6;
        g.save(); g.translate(R + Math.cos(a) * rr, R + Math.sin(a) * rr); g.rotate(a + Math.PI / 2);
        g.fillStyle = '#d6b25e'; g.strokeStyle = 'rgba(10,12,16,0.9)'; g.lineWidth = gs * 0.35;
        g.beginPath(); g.moveTo(0, -gs * 1.5); g.lineTo(gs * 1.1, gs * 0.9); g.lineTo(0, gs * 0.3); g.lineTo(-gs * 1.1, gs * 0.9); g.closePath(); g.stroke(); g.fill();
        g.restore();
      } else { g.save(); g.strokeStyle = '#d6b25e'; g.lineWidth = gs * 0.35; g.beginPath(); g.arc(R + x, R + y, gs * 2.1, 0, Math.PI * 2); g.stroke(); g.restore(); }
    }
    // party
    for (const m of r.party) {
      if (!m.alive || m.left || !m.spawned || m === u) continue;
      const dx = (m.pos.x - u.pos.x) * k, dz = (m.pos.z - u.pos.z) * k;
      const x = dx * cs - dz * sn, y = dx * sn + dz * cs;
      g.fillStyle = m.downed ? '#d4574f' : 'hsl(' + (CMP[m.id] ? CMP[m.id].hue : 40) + ',55%,62%)';
      g.beginPath(); g.arc(R + x, R + y, gs * 0.7, 0, Math.PI * 2); g.fill();
    }
    // foes in a fight
    if (AB.combat.inCombat) {
      g.fillStyle = '#ff5a4a';
      for (const f of AB.combat.units()) {
        if (f.side !== 'foe' || !f.alive || !f.enc || !f.enc.engaged) continue;
        const dx = (f.pos.x - u.pos.x) * k, dz = (f.pos.z - u.pos.z) * k;
        const x = dx * cs - dz * sn, y = dx * sn + dz * cs;
        if (Math.hypot(x, y) < R - 4) { g.beginPath(); g.arc(R + x, R + y, gs * 0.55, 0, Math.PI * 2); g.fill(); }
      }
    }
    const fa = Math.PI - (u.facing - th);
    g.save(); g.translate(R, R); g.rotate(fa);
    g.fillStyle = '#f4ecd4'; g.strokeStyle = 'rgba(10,12,16,0.95)'; g.lineWidth = gs * 0.4;
    g.beginPath(); g.moveTo(0, -gs * 1.7); g.lineTo(gs * 1.15, gs * 1.1); g.lineTo(0, gs * 0.45); g.lineTo(-gs * 1.15, gs * 1.1); g.closePath(); g.stroke(); g.fill();
    g.restore();
    // rim + north (the mountain lies "north", along +Z)
    g.strokeStyle = 'rgba(214,178,94,0.55)'; g.lineWidth = W / 90; g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.stroke();
    const nx = -sn, ny = cs;
    g.fillStyle = '#d6b25e'; g.font = '700 ' + Math.round(W / 11) + 'px "Alegreya Sans SC", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', R + nx * (R - W / 14), R + ny * (R - W / 14));
    // distance to the objective
    set(ref('dist'), 'text', op ? Math.round(U.dist2(op.x, op.z, u.pos.x, u.pos.z)) + ' m' : '');
  }
  function drawBigMap(cv) {
    if (!cv) return;
    const lv = AB.world.level, r = AB.state.run; if (!lv || !r) return;
    const g = cv.getContext('2d'); if (!g) return;
    miniLevel();
    const b = lv.bounds, bw = b.maxX - b.minX, bh = b.maxZ - b.minZ;
    cv.height = 640; cv.width = Math.round(U.clamp(640 * bw / bh, 320, 900));
    const W = cv.width, H = cv.height;
    const k = Math.min(W / bw, H / bh) * 0.94;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    g.fillStyle = '#0e1319'; g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2); g.rotate(Math.PI); g.scale(k, k); g.translate(-cx, -cz);   // +Z (the way ahead) points up
    if (mini.img) { g.globalAlpha = 0.9; g.drawImage(mini.img, b.minX, b.minZ, bw, bh); g.globalAlpha = 1; }
    if (mini.branchPath) { g.strokeStyle = 'rgba(232,226,207,0.35)'; g.lineWidth = 2 / k; g.setLineDash([5 / k, 4 / k]); g.stroke(mini.branchPath); g.setLineDash([]); }
    if (mini.roadPath) { g.strokeStyle = 'rgba(232,226,207,0.3)'; g.lineWidth = 3 / k; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(mini.roadPath); }
    if (lv.act !== 'forge') { g.strokeStyle = 'rgba(240,226,190,0.9)'; g.lineWidth = 3.2 / k; mini.explored = -1; g.stroke(exploredPath(r)); }
    g.restore();
    const P = (x, z) => [W / 2 - (x - cx) * k, H / 2 - (z - cz) * k];
    for (const p of lv.pois) { if (p.state === 'hidden') continue; const [x, y] = P(p.x, p.z); poiGlyph(g, p.type, x, y, 7, AB.game.poiDone(p)); }
    const u = AB.combat.controlled();
    if (u) {
      const [x, y] = P(u.pos.x, u.pos.z);
      g.fillStyle = '#f4ecd4'; g.strokeStyle = '#0a0c10'; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke(); g.fill();
      g.strokeStyle = 'rgba(244,236,212,0.5)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
    }
    const op = objectivePoi ? AB.world.poi(objectivePoi) : null;
    if (op) { const [x, y] = P(op.x, op.z); g.strokeStyle = '#d6b25e'; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.stroke(); }
  }

  // ---------------------------------------------------------------------------------- world-anchored layer
  // enemy bars over engaged foes, lock reticle, the objective marker, and the 3D lineup labels on the pick screen
  const barPool = [], labelPool = [];
  let reticle = null, objMark = null;
  const sp = { x: 0, y: 0, visible: false, depth: 0 };
  function barEl(i) {
    let o = barPool[i];
    if (!o) {
      const el = document.createElement('div'); el.className = 'ab-ebar'; el.hidden = true;
      el.innerHTML = '<span class="ab-ebar-n ab-label"></span><span class="ab-ebar-b"><i class="is-lag"></i><i class="is-now"></i></span><span class="ab-ebar-s"></span>';
      worldEl.appendChild(el);
      o = barPool[i] = { el, n: el.firstChild, now: el.querySelector('.is-now'), lag: el.querySelector('.is-lag'), s: el.querySelector('.ab-ebar-s'), uid: 0, lagv: 1 };
    }
    return o;
  }
  // world-anchored bars and numbers never draw over the objective line or the boss title (cached; re-read every 20 frames)
  let topY = 0, topYAt = -99;
  function hudTopY() {
    if (AB.loop.frame - topYAt < 20 && AB.loop.frame >= topYAt) return topY;
    topYAt = AB.loop.frame;
    const el = boss && refs.boss && !refs.boss.hidden ? refs.boss : hud.querySelector('.hud-top');
    const v = AB.core.view;
    topY = el && !hud.hidden ? el.getBoundingClientRect().bottom - (v ? v.getBoundingClientRect().top : 0) + 6 : 0;
    return topY;
  }
  function updateWorldLayer(dt) {
    const st = AB.state;
    let nb = 0;
    const top = st.screen === 'play' ? hudTopY() : 0;
    if (st.screen === 'play') {
      const units = AB.combat.units();
      for (let i = 0; i < units.length && nb < 14; i++) {
        const f = units[i];
        if (f.side !== 'foe' || !f.alive || f === boss || !f.enc) continue;
        if (!f.enc.engaged && f.hp >= f.maxHp) continue;
        tmpV.set(f.pos.x, f.pos.y + (f.height || 1.7) + 0.45, f.pos.z);
        U.toScreen(tmpV, sp);
        if (!sp.visible || sp.depth > 48 || sp.y < top) continue;
        const o = barEl(nb++);
        if (o.uid !== f.uid) { o.uid = f.uid; o.lagv = f.hp / f.maxHp; o.n.textContent = f.tier === 'elite' ? f.name : ''; o.el.classList.toggle('is-elite', f.tier === 'elite'); }
        const fr = U.clamp(f.hp / f.maxHp, 0, 1);
        o.lagv = fr > o.lagv ? fr : U.damp(o.lagv, fr, 3, dt);
        o.el.hidden = false;
        o.el.style.transform = 'translate(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px)';
        set(o.now, 'transform', 'scaleX(' + fr.toFixed(3) + ')');
        set(o.lag, 'transform', 'scaleX(' + o.lagv.toFixed(3) + ')');
        set(o.s, 'html', statusPips(f));
        set(o.el, '.is-far', sp.depth > 30);
      }
      // lock-on reticle (hard lock in gilt; the soft target only in a fight)
      const li = AB.combat.lockInfo ? AB.combat.lockInfo() : { unit: AB.combat.lockTarget(), hard: false };
      const t = li.unit;
      let show = false;
      if (t && t.alive && (li.hard || AB.combat.inCombat)) {
        tmpV.set(t.pos.x, t.pos.y + (t.height || 1.7) * 0.55, t.pos.z);
        U.toScreen(tmpV, sp);
        if (sp.visible) {
          show = true;
          const sz = U.clamp(900 / Math.max(4, sp.depth) * (t.radius || 0.5), 34, 150);
          reticle.style.transform = 'translate(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px)';
          set(reticle, '--s', sz.toFixed(0) + 'px');
          set(reticle, '.is-hard', !!li.hard);
        }
      }
      set(reticle, 'hidden', !show);
      // objective marker (out of a fight, when it is on screen and not too close)
      const op = objectivePoi ? AB.world.poi(objectivePoi) : null;
      const u = AB.combat.controlled();
      let showO = false;
      if (op && u && !AB.combat.inCombat) {
        const d = U.dist2(op.x, op.z, u.pos.x, u.pos.z);
        if (d > 14) {
          tmpV.set(op.x, (op.y || AB.world.heightAt(op.x, op.z)) + 3.2, op.z);
          U.toScreen(tmpV, sp);
          if (sp.visible) { showO = true; objMark.style.transform = 'translate(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px)'; set(objMark.lastChild, 'text', Math.round(d) + ' m'); set(objMark, '@data-type', op.type); }
        }
      }
      set(objMark, 'hidden', !showO);
    } else { set(reticle, 'hidden', true); set(objMark, 'hidden', true); }
    for (let i = nb; i < barPool.length; i++) if (!barPool[i].el.hidden) { barPool[i].el.hidden = true; barPool[i].uid = 0; }
    // pick screen: name labels over the 3D lineup (tap to inspect)
    let nl = 0;
    if (st.screen === 'pick' && st.modal) {
      const m = st.modal;
      const list = [{ id: m.bearer.id, uid: m.bearer.uid, name: m.bearer.name, bearer: true }].concat(m.recruits);
      for (const r of list) {
        const u = AB.combat.unit ? AB.combat.unit(r.uid) : null; if (!u) continue;
        tmpV.set(u.pos.x, u.pos.y + (u.height || 1.7) + 0.35, u.pos.z);
        U.toScreen(tmpV, sp);
        let o = labelPool[nl];
        if (!o) {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'ab-plabel'; el.dataset.act = 'inspect';
          worldEl.appendChild(el); o = labelPool[nl] = { el, key: '' };
        }
        nl++;
        const on = m.chosen.includes(r.id), n = m.chosen.indexOf(r.id) + 1;
        const key = r.id + on + n + (pickFocus === r.id);
        if (o.key !== key) {
          o.key = key; o.el.dataset.arg = r.id;
          o.el.innerHTML = (on ? '<i>' + n + '</i>' : r.bearer ? '<i class="is-b">' + icon('shard') + '</i>' : '') + '<span>' + esc(first(r.name)) + '</span>';
          o.el.classList.toggle('is-on', on); o.el.classList.toggle('is-focus', pickFocus === r.id); o.el.classList.toggle('is-bearer', !!r.bearer);
        }
        o.el.hidden = !sp.visible;
        o.el.style.transform = 'translate(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px) translate(-50%,-100%)';
      }
    }
    for (let i = nl; i < labelPool.length; i++) labelPool[i].el.hidden = true;
  }

  // ---------------------------------------------------------------------------------- numbers, toasts, banners, whispers
  const numQ = [], numPool = [];
  function pushNum(unit, text, kind, big) {
    if (AB.loop.fastForwarding || !unit || !unit.pos || AB.state.screen !== 'play') return;
    numQ.push({ x: unit.pos.x, y: unit.pos.y + (unit.height || 1.7) + 0.25, z: unit.pos.z, text, kind, big });
    if (numQ.length > 24) numQ.shift();
  }
  function flushNumbers() {
    while (numQ.length) {
      const n = numQ.shift();
      let el = null;
      for (let i = 0; i < numPool.length; i++) if (!numPool[i]._busy) { el = numPool[i]; break; }
      if (!el) { if (numPool.length >= 40) continue; el = document.createElement('span'); el.className = 'ab-num'; nums.appendChild(el); numPool.push(el); }
      el._busy = true; el._t = 0; el._x = n.x; el._y = n.y; el._z = n.z; el._jx = (Math.random() - 0.5) * 34; el._big = !!n.big;
      el.textContent = n.text; el.dataset.kind = n.kind; el.classList.toggle('is-big', !!n.big); el.style.opacity = '0';
    }
  }
  function updateNumbers(dt) {
    for (const el of numPool) {
      if (!el._busy) continue;
      el._t += dt;
      const life = el._big ? 1.3 : 1.0;
      if (el._t > life) { el._busy = false; el.style.opacity = '0'; continue; }
      tmpV.set(el._x, el._y + el._t * 0.9, el._z);
      U.toScreen(tmpV, sp);
      if (AB.state.screen === 'play') sp.y = Math.max(sp.y, hudTopY() + el._t * 26 + 14);
      const pop = el._t < 0.12 ? 1 + (0.12 - el._t) * 4 : 1;
      el.style.transform = 'translate(' + (sp.x + el._jx * Math.min(1, el._t * 4)).toFixed(0) + 'px,' + (sp.y - el._t * 26).toFixed(0) + 'px) scale(' + pop.toFixed(2) + ')';
      el.style.opacity = sp.visible ? String(Math.min(1, (life - el._t) * 3)) : '0';
    }
  }
  const toastQ = [];
  function flushToasts() {
    while (toastQ.length) {
      const t = toastQ.shift();
      const el = document.createElement('div');
      el.className = 'ab-toast'; el.dataset.kind = t.kind || 'info'; el.textContent = t.text;
      toastsEl.appendChild(el);
      el._t = 4.4;
      while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
    }
  }
  function updateToasts(dt) {
    for (const el of Array.from(toastsEl.children)) { el._t -= dt; if (el._t < 0.4) el.classList.add('is-out'); if (el._t <= 0) el.remove(); }
  }
  let bannerT = 0;
  function banner(title, sub, kind) {
    if (AB.loop.fastForwarding) return;
    bannerEl.dataset.kind = kind || 'zone';
    bannerEl.innerHTML = (sub ? '<span class="ab-label">' + esc(sub) + '</span>' : '') + '<b class="ab-display">' + esc(title) + '</b>';
    bannerEl.classList.remove('is-on'); void bannerEl.offsetWidth; bannerEl.classList.add('is-on');
    bannerT = kind === 'victory' ? 3.2 : 3.6;
  }
  let whisperT = 0;
  let flashT = 0;

  // ---------------------------------------------------------------------------------- first-time hints (once per device)
  const HINT_KEY = 'ashbearer_v3_hints';
  const hintSeen = Object.assign({}, AB.store.get(HINT_KEY, {}) || {});
  const hintQ = [];
  let hintEl = null, hintT = 0;
  const HINTS = {
    move: { kbm: 'WASD to walk, Shift to run. Drag the mouse to look around.', touch: 'Drag on the left half to walk. Drag on the right half to look around.' },
    fight: { kbm: 'J or click to strike again and again. K and L for skills. Space to roll.', touch: 'Tap the big button to strike, again and again. The arrow rolls you clear.' },
    telegraph: { kbm: 'Glowing ground shows where a blow will land. Roll out of it with Space.', touch: 'Glowing ground shows where a blow will land. Roll out of it.' },
    ember: { kbm: 'Q wields the Emberheart: a blast of fire around Wren. Every use adds Corruption.', touch: 'The ember button wields the Emberheart: a blast of fire around Wren. Every use adds Corruption.' },
    downed: { kbm: 'A friend is down. Stand beside them for two seconds to help them up.', touch: 'A friend is down. Stand beside them for two seconds to help them up.' },
    interact: { kbm: 'Press E (or click the prompt) to interact.', touch: 'Tap the hand button to interact.' },
    switch: { kbm: 'Keys 1 to 4, or a click on a portrait, take control of another hero.', touch: 'Tap a face at the top to take control of another hero.' },
    corruption: { kbm: 'Corruption 40: Wren hits harder, but at 100 the Emberheart claims her. Camps and shrines steady her.', touch: 'Corruption 40: Wren hits harder, but at 100 the Emberheart claims her. Camps and shrines steady her.' },
    supplies: { kbm: 'Every 60 m of road eats a ration. At 0 supplies the fellowship starves and Hope fades.', touch: 'Every 60 m of road eats a ration. At 0 supplies the fellowship starves and Hope fades.' },
    camp: { kbm: 'Campfires are checkpoints: if Wren falls, the road rewinds to the last one.', touch: 'Campfires are checkpoints: if Wren falls, the road rewinds to the last one.' }
  };
  function hint(id) {
    if (hintSeen[id] || AB.loop.fastForwarding || (AB.state && AB.state.bot) || hintQ.includes(id)) return;
    hintQ.push(id);
  }
  function updateHints(dt) {
    if (!hintEl) return;
    if (hintT > 0) { hintT -= dt; if (hintT <= 0) hintEl.classList.remove('is-on'); return; }
    if (!hintQ.length || AB.state.screen !== 'play') return;
    const id = hintQ.shift();
    if (hintSeen[id]) return;
    hintSeen[id] = 1; AB.store.set(HINT_KEY, hintSeen);
    const h = HINTS[id]; if (!h) return;
    hintEl.innerHTML = '<span class="ab-hint-k ab-label">Hint</span>' + esc(isTouch() ? h.touch : h.kbm);
    hintEl.classList.remove('is-on'); void hintEl.offsetWidth; hintEl.classList.add('is-on');
    hintT = 7;
  }

  // =====================================================================================================
  // INIT
  // =====================================================================================================
  let boss = null;
  AB.ui = {
    damageNumbers: true,
    init() {
      uiEl = document.getElementById('ab-ui');
      touchEl = document.getElementById('ab-touch');
      if (!uiEl) throw new Error('#ab-ui missing');
      uiEl.innerHTML = '<div class="ab-world ab-passthru" aria-hidden="false"></div><div class="ab-hud" hidden></div><div class="ab-nums ab-passthru" aria-hidden="true"></div>' +
        '<div class="ab-flash ab-passthru" aria-hidden="true"></div><div class="ab-banner ab-passthru" aria-live="polite"></div>' +
        '<div class="ab-toasts ab-passthru" role="status" aria-live="polite"></div><div class="ab-whisper ab-passthru" aria-live="polite"></div><div class="ab-hint ab-passthru" role="status" aria-live="polite"></div><div class="ab-screen"></div>';
      worldEl = uiEl.querySelector('.ab-world'); hud = uiEl.querySelector('.ab-hud'); scr = uiEl.querySelector('.ab-screen'); nums = uiEl.querySelector('.ab-nums');
      toastsEl = uiEl.querySelector('.ab-toasts'); whisperEl = uiEl.querySelector('.ab-whisper'); bannerEl = uiEl.querySelector('.ab-banner'); flashEl = uiEl.querySelector('.ab-flash'); hintEl = uiEl.querySelector('.ab-hint');
      reticle = document.createElement('div'); reticle.className = 'ab-reticle'; reticle.hidden = true; reticle.innerHTML = '<i></i><i></i><i></i><i></i>'; worldEl.appendChild(reticle);
      objMark = document.createElement('div'); objMark.className = 'ab-objmark'; objMark.hidden = true; objMark.innerHTML = '<i></i><span class="ab-label"></span>'; worldEl.appendChild(objMark);
      touchEl.hidden = true;
      buildHud(); buildTouch();
      uiEl.addEventListener('click', onClick);
      uiEl.addEventListener('input', onInput);
      window.addEventListener('keydown', onKeyMenu);
      const B = AB.bus;
      B.on('screen', ({ name, prev }) => {
        dirty = true;
        if (name !== prev) screenAt = performance.now();
        if (name === 'pick' && prev !== 'pick') pickFocus = null;
        if (name === 'pause' && prev !== 'pause') panel = 'settings';
        if (name !== 'pause' && name !== 'title') panel = null;
      });
      B.on('settings', ({ key }) => { if (key !== 'volume' && key !== 'music' && key !== 'sensitivity') dirty = true; });
      B.on('quality', () => { if (AB.state.screen === 'pause' || AB.state.screen === 'title') dirty = true; });
      B.on('input:device', () => { dirty = true; abilKey = ''; touchKey = ''; });
      B.on('objective', ({ poiId }) => { objectivePoi = poiId; });
      B.on('toast', (t) => {
        if (!t || !t.text || /^Victory: /.test(t.text)) return;   // victories get a banner instead
        toastQ.push(t); if (toastQ.length > 6) toastQ.shift();
      });
      B.on('victory', ({ kind, chips }) => {
        banner(kind === 'boss' ? 'The great foe falls' : kind === 'elite' ? 'The guardian falls' : 'The way is clear', (chips || []).map((c) => c.text).join('  ·  '), 'victory');
      });
      B.on('zone', ({ name }) => { if (name && AB.state.screen === 'play') banner(name, AB.state.run ? 'Act ' + ROMAN[Math.min(3, AB.state.run.act)] : '', 'zone'); });
      B.on('checkpoint', () => { toastQ.push({ text: 'Checkpoint: the road will rewind to this fire', kind: 'info' }); });
      B.on('memorial', ({ ids }) => { memorialNote = 'A cairn of stones for ' + (ids || []).map((id) => first((CMP[id] || {}).name || id)).join(' and ') + '.'; });
      B.on('whisper', ({ text }) => { if (AB.loop.fastForwarding) return; whisperEl.textContent = text; whisperT = 6; whisperEl.classList.remove('is-on'); void whisperEl.offsetWidth; whisperEl.classList.add('is-on'); });
      B.on('boss:start', ({ unit }) => { boss = unit; lastBossHp = 1; bossTrail = 1; bossState = ''; });
      B.on('boss:end', () => { boss = null; });
      B.on('combat:phase', ({ unit }) => { if (unit === boss) bossState = 'It changes. Watch the ground.'; });
      B.on('combat:enrage', ({ unit }) => { if (unit === boss) bossState = 'Enraged'; });
      B.on('level:disposed', () => { boss = null; mini.level = null; });
      B.on('run:new', () => { memorialNote = null; });
      B.on('unit:hit', ({ unit, amount, kind, heavy, src }) => {
        if (AB.loop.fastForwarding || !unit) return;
        if (kind === 'dodged') { if (unit.side === 'party') pushNum(unit, 'Dodged', 'dodge'); return; }
        if (kind === 'immune') { pushNum(unit, 'Immune', 'info'); return; }
        if (!amount) return;
        const ctl = AB.combat.controlled();
        if (unit.side === 'party') { pushNum(unit, '-' + amount, 'hurt', heavy); if (unit === ctl && amount >= 4) { flashT = Math.min(0.5, 0.18 + amount / 60); } }
        else if ((src && src === ctl) || heavy) pushNum(unit, String(amount), src && src === ctl ? 'mine' : 'dmg', heavy);   // companion chip damage stays silent
      });
      B.on('unit:heal', ({ unit, amount, kind }) => { if (AB.loop.fastForwarding || !unit || kind === 'regen' || amount < 1) return; pushNum(unit, '+' + amount, 'heal'); });
      B.on('combat:interrupt', ({ unit }) => pushNum(unit, 'Interrupted', 'info', true));
      B.on('combat:perfect', ({ unit }) => pushNum(unit, 'Perfect', 'perfect', true));
      B.on('combat:stagger', ({ unit }) => { if (unit && unit.side === 'foe') pushNum(unit, 'Staggered', 'info'); });
      B.on('unit:downed', ({ unit }) => { if (unit && unit.side === 'party') toastQ.push({ text: first(unit.name) + ' is down. Stand beside ' + (unit.id === 'wren' ? 'Wren' : 'them') + ' to help them up.', kind: 'loss' }); });
      B.on('level:built', () => { abilKey = ''; touchKey = ''; });
      // first-time hints and auto-pause when the page is hidden
      B.on('screen', ({ name }) => { if (name === 'play' && AB.state.run) hint('move'); });
      B.on('combat:start', () => { hint('fight'); });
      B.on('combat:end', ({ result }) => { if (result === 'won') { hint('switch'); } });
      B.on('telegraph', ({ threat }) => { if (threat && threat.side !== 'party') hint('telegraph'); });
      B.on('unit:downed', ({ unit }) => { if (unit && unit.side === 'party') hint('downed'); });
      B.on('prompt', ({ prompt }) => { if (prompt) { hint('interact'); const p = AB.world.poi(prompt.poiId); if (p && p.type === 'camp') hint('camp'); } });
      B.on('resource', ({ key, value, delta }) => {
        if (key === 'corruption' && value >= 40) hint('corruption');
        if (key === 'supplies' && delta < 0) hint('supplies');
      });
      B.on('combat:start', ({ enc }) => { const c = AB.combat.controlled(); if (c && c.id === 'wren' && enc && (enc.kind === 'boss' || (enc.foes && enc.foes.length >= 3))) hint('ember'); });
      document.addEventListener('visibilitychange', () => { if (document.hidden && AB.state && AB.state.screen === 'play' && !AB.state.bot) AB.game.pause(); });
      AB.loop.add('ui', (dt, realDt) => {
        const st = AB.state; if (!st) return;
        const rdt = Math.min(0.1, realDt || dt || 0.016);
        if (dirty || st.screen !== lastScreen || st.modal !== lastModal) { dirty = false; lastScreen = st.screen; lastModal = st.modal; renderScreen(); }
        if (st.screen === 'play') {
          updateHud(rdt);
          const u = AB.combat.controlled();
          if (isTouch()) updateTouch(u);
          mini.frame++;
          if (mini.frame % 2 === 0) drawMinimap();
        } else if (st.screen === 'title' || st.screen === 'pick' || st.screen === 'ending' || st.screen === 'endingcine' || !st.run) {
          AB.post.params.ember = 0;
        }
        updateWorldLayer(rdt);
        flushNumbers(); updateNumbers(rdt); flushToasts(); updateToasts(rdt);
        if (whisperT > 0) { whisperT -= rdt; if (whisperT <= 0) whisperEl.classList.remove('is-on'); }
        if (bannerT > 0) { bannerT -= rdt; if (bannerT <= 0) bannerEl.classList.remove('is-on'); }
        if (flashT > 0) { flashT = Math.max(0, flashT - rdt); flashEl.style.opacity = (flashT * 1.6).toFixed(2); }
        updateHints(rdt);
      }, { phase: 'frame', order: AB.loop.ORDER.ui });
    },
    refresh() { dirty = true; },
    toast(text, kind) { AB.bus.emit('toast', { text, kind: kind || 'info' }); },
    portrait: portraitUrl,
    icon
  };
}
