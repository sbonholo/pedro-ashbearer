'use strict';
/* ASHBEARER v3 :: combat.js
   OWNER: GAMEPLAY lane, COMBAT + AI designer (this file only; game.js has its own owner).
   Real-time combat SIMULATION (SPEC_V3 section 4). Runs as a STEP system (order 30, paused while a modal is open);
   all randomness from AB.rand, never wall-clock time. actors.js / vfx.js / ui.js / audio.js read the unit, threat and
   projectile state and listen to the bus. API, unit shape and bus events follow INTERFACES.md section 8.
   One small cosmetic FRAME system lives here too: loot pickups on the ground + the camera lock-on assist.

   Contents
     1 tuning tables (TUNE, KIT/WEAPON per hero, GLYPH per enemy body, intent overrides)
     2 state, unit factory, placement, control
     3 encounters (engage, alert, leash, finish, telemetry)
     4 rules: damage, heal, statuses, poise/stagger, knockback, hit-stop, downed/revive/fall, boss phases
     5 effects (abilities, intents, items)
     6 hero abilities: 3-hit combos, arcs, multi-hit frames, gap closers, projectiles, volleys
     7 projectiles + telegraphs
     8 enemy AI: aggro, intents by weight/pattern, attack tokens, spacing/flanking/kiting, lunges, pounces,
       charges, hooks, eruptions, cones, rings, lobbed rocks, summons, phases, enrage
     9 hero movement: acceleration, dodge roll + i-frames + perfect dodge riposte, lock-on, player input
    10 companion AI per role (+ the bot pilot that fights for the controlled hero when __ab.bot is on)
    11 loot drops (sim) + their tiny renderer (frame)
    12 per-step bookkeeping, queries, API */
{
  const C = AB.C;
  const U = AB.util;
  const V3 = AB.THREE.Vector3;
  const CMP = {}; C.companions.forEach((c) => { CMP[c.id] = c; });
  const BEARER_ID = (C.companions.find((c) => c.bearer) || C.companions[0]).id;
  const emit = (n, p) => AB.bus.emit(n, p);
  const FF = () => !!AB.loop.fastForwarding;
  const clamp = U.clamp;
  const PI = Math.PI;

  // =====================================================================================================
  // 1. TUNING
  // =====================================================================================================
  const TUNE = {
    // hero movement
    heroSpeed: 5.4, bearerSpeed: 5.0, sprintMul: 1.3, accel: 40, decel: 30, actionSlow: 0.32,
    catchup: 7.5, teleportDist: 36,
    // dodge roll
    dodgeDur: 0.42, dodgeDist: 5.2, iframes: 0.35, dodgeRecover: 0.3, perfectWindow: 0.2, riposteT: 1.6,
    // hero actions
    attackDur: 0.8, attackHit: 0.3, skillDur: 0.9, skillHit: 0.42, comboWindow: 0.65, inputBuffer: 0.45,
    hitStop: 0.07, hitStopHeavy: 0.09, hitStopGap: 0.35, magnet: 4.2, lungeSpeed: 7, gapCloser: 7.5,
    // rules (SPEC_V3 section 4)
    downT: 20, reviveT: 2, reviveR: 1.6, revivePct: 0.3, controlHandoff: 1.2,
    statusSec: 3, tickSec: 3, stunSec: 1.5, cdScale: 4, firstStrikeSec: 6,
    allFoesR: 7, emberR: 9, friendR: 16, partyR: 15, resourceAbilityCd: 24,
    // encounters / aggro
    leash: 40, aggroSee: 11, calmAfterFlee: 10, postLeash: 34, retarget: 1.2,
    // enemy attacks
    aimLock: 0.68, meleeThreatR: 1.6, aoeThreatR: 5, projSpeedFoe: 15, projThreatR: 1.2, maxFoesPerEnc: 4, corpseSec: 4,
    tokens: 2, tokensWithLeader: 1,
    atkCd: { normal: [0.7, 1.7], elite: [0.8, 1.6], boss: [1.0, 1.8] },
    recover: { normal: [0.4, 0.65], elite: [0.4, 0.65], boss: [0.4, 0.65] },
    resourceIntentCd: { normal: 14, elite: 22, boss: 32 },   // one Hope/Corruption intent per foe per N s (real time gives foes many more actions than v1 rounds)
    encResourceCd: 6,          // and one per ENCOUNTER every 6 s, so packs of chanters do not stack their drain
    interruptK: 0.05, interruptStagger: 0.55,   // a normal foe's cast breaks on any heavy hit or on 5% of its HP in damage during the chant
    summonCd: 20, maxSummons: 2, summonHp: 0.6,   // a summoner keeps at most 2 of its calls alive, calls again after 20 s; called kin are weaker
    summonTotal: { normal: 2, elite: 3, boss: 6 }, // ... and calls at most this many in one fight (phase calls included): no endless reinforcements
    encHealCd: 7,                                  // one foe heal cast per encounter every 7 s (several healers no longer out-heal the party)
    poise: { normal: 0.3, elite: 0.18, boss: 0.1 }, staggerSec: 0.8, poiseRegen: 2.6, staggerImmune: 3.2,   // poise = share of max HP
    phaseAt: { elite: 0.5, boss: 0.6 }, enrageAt: 0.3, enrageSpeed: 1.2, enrageWind: 0.82, enrageCd: 0.6, enrageDmg: 1.2,
    // companion AI
    aiDodgeChance: 0.45, aiAoeChance: 0.7, aiReact: 0.45, botDodgeChance: 0.85, botEmberCorr: 22,
    pilot: true,                   // __ab.bot on: the combat brain fights for the controlled hero (false: it reads AB.input like a human; tools)
    // balance multipliers (tools/botrun.mjs --foe-dmg / --foe-hp override foeDmg / foeHp + bossHp)
    foeDmg: 1,
    tierDmg: { normal: 1, elite: 1.1, boss: 1.1 },   // per-tier damage multipliers on top of foeDmg (bosses should cost a few downs)
    foeHp: 6,                      // REAL-TIME HP SCALE for normal foes: content HP was balanced for turns
    actDmg: { 1: 1.6 },            // act 1 foes hit harder in real time (content act 1 numbers were sized for v1 rounds)
    bossHp: 13,                    // the same for bosses
    eliteHp: 1.5,                  // elites: foeHp x eliteHp
    actHp: { 1: 1, 2: 0.86, 3: 0.76 },   // later acts have bigger content HP already
    foeHealK: 0.35,                // foe heals/regen scale with HP x this (fights last more 'rounds' than v1)
    // loot
    loot: { normal: [0.4, 0.16], elite: [1, 1], boss: [3, 2] }   // [silver piles (chance <1 = chance), remedies]
  };

  // hero kit: ranged = range (m) of foe-targeted abilities fired as projectiles; reach = melee reach (m); arc = swing arc
  // (rad); combo = [duration, hit time] of the 3 attack steps; kb = knockback (m/s) of the finisher; prefer = AI distance
  const KIT = {
    wren: { style: 'sling', ranged: 15, proj: 'stone', speed: 30, reach: 1.8, arc: 1.4, kb: 3, prefer: 9, combo: [[0.7, 0.3], [0.7, 0.3], [0.95, 0.42]] },
    ysolde: { style: 'blades', reach: 2.2, arc: 2.0, kb: 3.2, prefer: 1.7, frames: 0.13, combo: [[0.62, 0.22], [0.62, 0.22], [0.9, 0.34]] },
    brakka: { style: 'hammer', reach: 2.6, arc: 2.3, kb: 6, prefer: 1.9, combo: [[0.8, 0.33], [0.8, 0.33], [1.1, 0.5]] },
    neve: { style: 'bow', ranged: 21, proj: 'arrow', speed: 44, reach: 1.9, arc: 1.4, kb: 2.4, prefer: 13, combo: [[0.75, 0.34], [0.75, 0.34], [1.0, 0.48]] },
    maddoc: { style: 'staff', ranged: 12, proj: 'bolt', speed: 21, reach: 2.3, arc: 1.8, kb: 3.4, prefer: 8, combo: [[0.78, 0.34], [0.78, 0.34], [1.0, 0.44]] },
    rook: { style: 'sword', reach: 2.3, arc: 1.9, kb: 3.6, prefer: 1.6, combo: [[0.6, 0.22], [0.6, 0.22], [0.85, 0.32]] },
    tamsin: { style: 'spear', ranged: 11, proj: 'bolt', speed: 21, reach: 2.8, arc: 1.1, kb: 3.2, prefer: 7, combo: [[0.66, 0.27], [0.66, 0.27], [0.9, 0.36]] }
  };
  const WEAPON = KIT;   // INTERFACES name
  const ROLE = { wren: 'bearer', ysolde: 'melee', brakka: 'tank', neve: 'archer', maddoc: 'healer', rook: 'rogue', tamsin: 'support' };
  const HEIGHT = { wren: 1.32, ysolde: 1.74, brakka: 1.8, neve: 1.68, maddoc: 1.76, rook: 1.8, tamsin: 1.64 };
  // enemy body by content glyph: speed m/s, reach m, radius m, height m, ranged (m) = default to projectiles,
  // float = hovers, pack = flanks from behind, mass = knockback resistance
  const GLYPH = {
    hound: { speed: 6.4, reach: 1.8, r: 0.55, h: 1.0, pack: true, mass: 0.8 }, beast: { speed: 5.8, reach: 2.0, r: 0.7, h: 1.3, pack: true, mass: 1.1 },
    bandit: { speed: 4.4, reach: 2.0, r: 0.4, h: 1.75, mass: 1 }, soldier: { speed: 4.0, reach: 2.7, r: 0.45, h: 1.85, mass: 1.3 },
    cultist: { speed: 3.8, reach: 2.0, r: 0.4, h: 1.75, ranged: 12, mass: 0.9 }, priest: { speed: 3.4, reach: 2.0, r: 0.45, h: 1.8, ranged: 13, mass: 1 },
    herald: { speed: 3.6, reach: 2.6, r: 0.5, h: 2.0, ranged: 13, mass: 1.2 }, ghoul: { speed: 4.6, reach: 1.9, r: 0.45, h: 1.5, mass: 0.9 },
    troll: { speed: 3.4, reach: 3.1, r: 0.9, h: 3.0, mass: 4 }, spider: { speed: 5.3, reach: 2.0, r: 0.7, h: 0.9, ranged: 10, pack: true, mass: 0.9 },
    lurker: { speed: 3.3, reach: 3.3, r: 0.7, h: 1.6, mass: 2 }, wyrm: { speed: 4.0, reach: 3.4, r: 1.0, h: 1.6, mass: 3 },
    sentinel: { speed: 3.0, reach: 2.9, r: 0.7, h: 2.4, mass: 4 }, wraith: { speed: 4.2, reach: 2.2, r: 0.45, h: 2.0, ranged: 12, float: true, mass: 0.7 },
    shade: { speed: 4.4, reach: 2.0, r: 0.4, h: 1.9, ranged: 12, float: true, mass: 0.6 }, swarm: { speed: 4.9, reach: 2.4, r: 0.9, h: 1.6, float: true, mass: 0.5 }
  };
  const TIER_SCALE = { normal: 1, elite: 1.25, boss: 1.9 };

  // Intent overrides by 'enemyId:intentId' (the rest is derived from the content effects + glyph, see intentSpec).
  //   s shape melee|aoe|proj|cast (threat kind for vfx) · mv lunge|pounce|charge|hook|cone|emerge|swarm|self|each|ring|lob
  //   r threat radius · w windup (s) · dash lunge length · reach start distance · hv heavy (armoured wind-up) · kb knockback
  //   pk projectile kind · spd projectile speed
  const IN = {
    // act 1
    'ash_hound:snap': { mv: 'lunge', dash: 3, w: 0.62, r: 1.35 },
    'ash_hound:hamstring': { mv: 'pounce', reach: 7, w: 0.85, r: 1.7 },
    'hedge_cutthroat:knife': { w: 0.66 },
    'hedge_cutthroat:gut': { mv: 'lunge', dash: 4, w: 0.8 },
    'whisperwood_weaver:bite': { s: 'melee', mv: 'lunge', dash: 2.6, w: 0.66 },
    'whisperwood_weaver:web': { spd: 11 },
    'fen_lurker:lash': { r: 2.1, reach: 3.3 },
    'fen_lurker:drag': { mv: 'hook', reach: 5, w: 0.9, r: 1.4 },
    'ember_pilgrim:swing': { s: 'melee', w: 0.78 },
    'mire_ghoul:grip': { mv: 'lunge', dash: 3, w: 0.75 },
    'marsh_midges:stings': { s: 'aoe', mv: 'swarm', r: 2.3, w: 0.95 },
    'thornback_troll:crush': { hv: true, r: 2.1, w: 1.2, kb: 7 },
    'thornback_troll:sweep': { mv: 'self', r: 5.2, w: 1.1, kb: 5 },
    'thornback_troll:bellow': { r: 10 },
    'tithe_taker:cleaver': { hv: true, r: 1.9, w: 1.05, kb: 5 },
    'tithe_taker:collect': { mv: 'lunge', dash: 4.5, w: 0.85 },
    'hollow_huntsman:rime_spear': { s: 'proj', pk: 'arrow', spd: 27, w: 1.0, r: 1.5, hv: true },
    'hollow_huntsman:reaping_sweep': { mv: 'self', r: 6.4, w: 1.25, kb: 6 },
    // act 2
    'greyspire_wolf:bite': { mv: 'lunge', dash: 3, w: 0.62 },
    'greyspire_wolf:lunge': { mv: 'pounce', reach: 8, w: 0.85, r: 1.8 },
    'delver_husk:pick': { hv: true, w: 0.95, r: 1.7 },
    'delver_husk:grasp': { mv: 'lunge', dash: 3, w: 0.75 },
    'delver_sentinel:stone_fist': { hv: true, r: 2.0, w: 1.1, kb: 6 },
    'delver_sentinel:stride': { mv: 'charge', reach: 9, w: 0.95, r: 1.4, kb: 6 },
    'cistern_lurker:lash': { r: 2.2, reach: 3.4 },
    'cistern_lurker:ambush': { mv: 'emerge', reach: 14, w: 1.2, r: 2.0, kb: 6 },
    'cistern_lurker:coil': { mv: 'hook', reach: 4.6, w: 0.9, r: 1.4 },
    'pass_reaver:hook': { mv: 'hook', reach: 5, w: 0.85, r: 1.4 },
    'pass_reaver:halberd': { hv: true, r: 2.0, reach: 3.2, w: 1.05, kb: 5 },
    'blindwing_swarm:flurry': { s: 'aoe', mv: 'swarm', r: 2.5, w: 0.95 },
    'blindwing_swarm:shriek': { r: 8 },
    'slatehide_troll:boulder': { s: 'proj', mv: 'lob', pk: 'stone', r: 2.5, w: 1.1, hv: true, kb: 6 },
    'slatehide_troll:stamp': { mv: 'self', r: 5.6, w: 1.1, kb: 5 },
    'slatehide_troll:roar': { r: 10 },
    'undervault_wyrm:breath': { s: 'aoe', mv: 'cone', r: 2.3, w: 1.15 },
    'undervault_wyrm:gnash': { mv: 'lunge', dash: 3.6, w: 0.85, r: 1.6 },
    'last_warden:floodgates': { mv: 'each', r: 2.6, w: 1.45 },
    'last_warden:deep_hammer': { hv: true, r: 2.7, reach: 3.6, w: 1.3, kb: 8 },
    'last_warden:cold_tide': { mv: 'self', r: 7.5, w: 1.5, kb: 6 },
    // act 3
    'cinder_hound:burning_bite': { mv: 'lunge', dash: 3, w: 0.6 },
    'cinder_hound:run_down': { mv: 'pounce', reach: 8, w: 0.8, r: 1.8 },
    'ashguard_spear:thrust': { mv: 'lunge', dash: 2.6, w: 0.78, reach: 3.0 },
    'ashguard_spear:pin': { mv: 'lunge', dash: 2.2, w: 0.72, reach: 3.0 },
    'smoke_wraith:smother': { r: 8 },
    'slag_ghoul:spatter': { mv: 'self', r: 4.4, w: 0.95 },
    'ember_moths:burning_swarm': { s: 'aoe', mv: 'swarm', r: 2.5, w: 0.95 },
    'cinderworm:erupt': { mv: 'each', r: 2.4, w: 1.25 },
    'cinderworm:searing_maw': { mv: 'lunge', dash: 3.6, w: 0.85, r: 1.6 },
    'kiln_troll:slag_maul': { hv: true, r: 2.2, w: 1.2, kb: 7 },
    'kiln_troll:quake': { mv: 'self', r: 6.2, w: 1.15, kb: 5 },
    'kiln_troll:furnace_roar': { r: 10 },
    'burnt_inquisitor:scourge': { s: 'melee', mv: 'hook', reach: 4.6, w: 0.85, r: 1.5 },
    'cinder_regent:decree': { mv: 'each', r: 2.8, w: 1.4 },
    'cinder_regent:sunder': { s: 'melee', hv: true, r: 2.6, reach: 3.5, w: 1.25, kb: 8 }
  };

  // =====================================================================================================
  // 2. STATE, UNITS, PLACEMENT, CONTROL
  // =====================================================================================================
  const units = [];             // spawned units (heroes, foes, display); other modules read it, never mutate it
  let encs = [];                // encounters of the current level
  const projs = [];             // live projectiles
  const threats = [];           // live telegraphs
  const drops = [];             // loot on the ground
  const heroes = [];            // cache: active heroes (rebuilt every step)
  let controlled = null, frozen = false, time = 0, inCombat = false, combatT0 = -99, lockUid = 0, softUid = 0;
  let uidSeq = 1, encSeq = 1, projSeq = 1, thrSeq = 1, dropSeq = 1;
  const inBuf = { slot: null, t: 0 };
  const history = [];           // finished encounters (telemetry for tools: tools/combat-stats.mjs)
  const party = () => (AB.state && AB.state.run ? AB.state.run.party : []);
  const isActive = (u) => !!u && u.spawned && u.alive && !u.downed && !u.left;
  const isFoe = (u) => !!u && u.side === 'foe' && u.alive && u.spawned && u.kind === 'enemy';
  const dist = (a, b) => U.dist2(a.pos.x, a.pos.z, b.pos.x, b.pos.z);
  const byUid = (uid) => { if (!uid) return null; for (let i = 0; i < units.length; i++) if (units[i].uid === uid) return units[i]; return null; };
  const traitId = (u) => (u.def && u.def.trait ? u.def.trait.id : null);
  const game = () => AB.game || {};
  const kitOf = (u) => KIT[u.id] || KIT.rook;
  const bot = () => !!(AB.state && AB.state.bot);
  const hpFrac = (u) => (u.maxHp > 0 ? u.hp / u.maxHp : 0);
  const fwdX = (yaw) => Math.sin(yaw), fwdZ = (yaw) => Math.cos(yaw);
  const tmpV = new V3(), tmpV2 = new V3();
  const scratch = [];           // reusable victim list

  function slotsOf(def) {
    const abs = def.abilities || [];
    const attack = abs.find((a) => a.cooldown === 0) || abs[0] || null;
    const rest = abs.filter((a) => a !== attack);
    const ember = rest.find((a) => a.effects.some((e) => e.type === 'corruption' && e.amount > 0) && a.effects.some((e) => e.type === 'damage')) || null;
    const others = rest.filter((a) => a !== ember);
    return { attack, skill1: others[0] || null, skill2: others[1] || null, ember };
  }
  function baseUnit(o) {
    return Object.assign({
      uid: uidSeq++, id: '', name: '', side: 'party', kind: 'hero', def: null, glyph: null, tier: null, role: null,
      pos: new V3(), vel: new V3(), facing: 0, radius: 0.4, height: 1.7, scale: 1, hue: 30, float: false,
      hp: 1, maxHp: 1, alive: true, downed: false, downT: 0, reviveT: 0, downCtlT: 0, left: false, fell: null, deadT: 0,
      status: {}, cds: { attack: 0, skill1: 0, skill2: 0, ember: 0 }, slots: null, action: null, atk: null, recover: 0, next: null, cycle: 0,
      iframes: 0, dodgeT: 0, dodgeCd: 0, dodgeDir: new V3(), dodgeAge: 9, flash: 0, hitT: 0, combo: 0, comboT: 0, tgt: 0,
      kb: new V3(), hitStop: 0, hsGap: 0, staggerT: 0, poise: 0, poiseMax: 0, poiseT: 0, poiseImm: 0, phase: 0, enraged: false, invuln: 0, spawnT: 0, sub: false,
      hpK: 1, resT: -1e9, riposte: 0, cd: 0, mass: 1, aggro: null, by: 0, sumT: -1e9,
      anim: { state: 'idle', t: 0, speed: 0, variant: 0 }, spawned: false, view: null, enc: null, post: null,
      ai: { th: 0, react: false, mode: 'idle', kiteT: 1.4, orbit: 1, orbitT: 0, slot: 0, commit: false, commitT: 0, atkTgt: 0, retT: 0, alertT: 0, wanderT: 0, wx: 0, wz: 0, strafeT: 0, emberUses: 0 },
      _cdv: null
    }, o);
  }
  function makeHero(id) {
    const d = CMP[id]; if (!d) throw new Error('unknown companion ' + id);
    return baseUnit({ id, name: d.name, side: 'party', kind: 'hero', def: d, role: ROLE[id] || 'melee', hue: d.hue, hp: d.maxHp, maxHp: d.maxHp,
      height: HEIGHT[id] || 1.72, radius: id === 'brakka' ? 0.48 : 0.4, slots: slotsOf(d), mass: id === 'brakka' ? 2 : 1 });
  }
  function hpScaleOf(d) {
    const a = TUNE.actHp[d.act] || 1;
    if (d.tier === 'boss') return TUNE.bossHp * a;
    return TUNE.foeHp * (d.tier === 'elite' ? TUNE.eliteHp : 1) * a;
  }
  function makeEnemy(id) {
    const d = C.enemies[id]; if (!d) throw new Error('unknown enemy ' + id);
    const g = GLYPH[d.glyph] || GLYPH.bandit, s = TIER_SCALE[d.tier] || 1;
    const k = hpScaleOf(d);
    const hp = Math.max(1, Math.round(d.maxHp * k));
    const pm = Math.max(20, Math.round(hp * (TUNE.poise[d.tier] || TUNE.poise.normal)));
    return baseUnit({ id, name: d.name, side: 'foe', kind: 'enemy', def: d, glyph: d.glyph, tier: d.tier, hp, maxHp: hp, hpK: k,
      scale: s, radius: g.r * s, height: g.h * s, float: !!g.float, speedBase: g.speed, reach: g.reach * Math.sqrt(s), ranged: g.ranged || 0,
      drainer: (d.intents || []).some((it) => (it.effects || []).some((e) => e.type === 'summon' || ((e.type === 'hope' || e.type === 'corruption') && e.amount !== 0))) && d.tier === 'normal',
      whisper: (d.intents || []).some((it) => (it.effects || []).some((e) => e.type === 'corruption' && e.amount > 0)),
      pack: !!g.pack, mass: (g.mass || 1) * s * s * (d.tier === 'boss' ? 4 : 1), poise: pm, poiseMax: pm, post: new V3(), aggro: {} });
  }
  function spawnUnit(u) { if (u.spawned) return; u.spawned = true; units.push(u); emit('unit:spawn', { unit: u }); }
  function despawnUnit(u) {
    if (!u || !u.spawned) return;
    u.spawned = false;
    const i = units.indexOf(u); if (i >= 0) units.splice(i, 1);
    for (let k = threats.length - 1; k >= 0; k--) if (threats[k].src === u.uid) threats.splice(k, 1);
    if (u.uid === lockUid) lockUid = 0;
    emit('unit:despawn', { unit: u });
  }
  function resetTransient(u) {
    u.downed = false; u.downT = 0; u.reviveT = 0; u.downCtlT = 0; u.deadT = 0; u.status = {}; u.action = null; u.atk = null;
    u.cds.attack = u.cds.skill1 = u.cds.skill2 = u.cds.ember = 0; u.dodgeT = 0; u.dodgeCd = 0; u.iframes = 0; u.vel.set(0, 0, 0);
    u.flash = 0; u.hitT = 0; u.recover = 0; u.next = null; u.tgt = 0; u.kb.set(0, 0, 0); u.hitStop = 0; u.staggerT = 0; u.riposte = 0;
    u.combo = 0; u.comboT = 0; u.ai.th = 0; u.ai.emberUses = 0;
  }
  const groundY = (u) => AB.world.heightAt(u.pos.x, u.pos.z) + (u.float ? 0.35 : 0);

  // formation slots (right, forward) relative to the leader: flanking, nobody on the camera axis behind the leader
  const FORM = [[0, 0], [-1.8, -1.4], [1.8, -1.6], [-2.8, -3.2]];
  function formationPoint(i, x, z, yaw, out) {
    const f = FORM[i % FORM.length];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    out.x = x + f[0] * c + f[1] * s; out.z = z - f[0] * s + f[1] * c;
    return out;
  }
  function placeParty(x, z, yaw) {
    const list = party().filter((m) => m.alive && !m.left);
    list.forEach((m, i) => {
      resetTransient(m);
      formationPoint(i, x, z, yaw, m.pos);
      AB.world.constrain(m.pos, m.radius);
      m.pos.y = groundY(m); m.facing = yaw;
      spawnUnit(m);
    });
  }
  function teleportParty(x, z) {
    const yaw = controlled ? controlled.facing : 0;
    let i = 0;
    for (const m of party()) {
      if (!m.spawned || !m.alive) continue;
      formationPoint(i++, x, z, yaw, m.pos);
      AB.world.constrain(m.pos, m.radius);
      m.pos.y = groundY(m); m.vel.set(0, 0, 0); m.kb.set(0, 0, 0);
    }
  }
  function setControlled(u) { if (!u) return; controlled = u; lockUid = 0; softUid = 0; inBuf.t = 0; emit('controlled', { unit: u }); }

  // =====================================================================================================
  // 3. ENCOUNTERS
  // =====================================================================================================
  function spawnEncounter(spec) {
    const e = { id: spec.id || 'enc' + encSeq++, poiId: spec.poiId || null, kind: spec.kind || 'battle', x: spec.x, z: spec.z, yaw: spec.yaw || 0,
      radius: spec.radius || 12, foes: [], engaged: false, done: false, calmT: 0, spoils: spec.spoils || null, t0: 0,
      act: AB.state && AB.state.run ? AB.state.run.act : 0, tel: null };
    const ids = spec.enemyIds || [];
    ids.forEach((id, i) => {
      const f = makeEnemy(id);
      const a = e.yaw + (i === 0 ? 0 : (i % 2 ? 1 : -1) * (0.9 + 0.5 * Math.floor((i - 1) / 2)));
      const R = i === 0 ? 0 : 2.6 + f.radius;
      f.pos.set(e.x + Math.sin(a) * R, 0, e.z + Math.cos(a) * R);
      AB.world.constrain(f.pos, f.radius);
      f.pos.y = groundY(f); f.post.copy(f.pos); f.facing = e.yaw; f.enc = e;
      f.ai.wanderT = AB.rand.float(0.5, 4);
      e.foes.push(f);
      spawnUnit(f);
    });
    encs.push(e);
    if (spec.engageNow) engage(e);
    return e;
  }
  function engage(e) {
    if (e.engaged || e.done) return;
    e.engaged = true; e.t0 = time;
    e.tel = { id: e.id, kind: e.kind, act: e.act, t0: time, dur: 0, dmgIn: 0, dmgOut: 0, downs: 0, falls: 0, dodged: 0, perfect: 0, hitsIn: 0, foes: e.foes.map((f) => f.id), result: null };
    if (!inCombat) { inCombat = true; combatT0 = time; }
    for (const f of e.foes) {
      if (!f.alive) continue;
      f.ai.alertT = f.tier === 'boss' ? 0.9 : AB.rand.float(0.2, 0.75);
      f.ai.commit = false; f.cd = AB.rand.float(0.3, 1.4) + f.ai.alertT; f.next = null;
      emit('combat:alert', { unit: f });
    }
    for (const u of heroes) u.ai.emberUses = 0;
    const g = game();
    const st = g.boonSum ? g.boonSum('start_guard', 'turns') : 0;
    if (st) for (const u of heroes) addStatus(u, 'guard', st, 0, null);
    emit('combat:start', { enc: e });
  }
  function logEnc(e, result) {
    if (!e.tel) return;
    e.tel.dur = Math.round((time - e.tel.t0) * 10) / 10; e.tel.result = result;
    history.push(e.tel); if (history.length > 1000) history.shift();
    e.tel = null;
  }
  function disengage(e, result) {
    if (!e.engaged) return;
    e.engaged = false; e.calmT = TUNE.calmAfterFlee;
    for (const f of e.foes) {
      if (!f.alive) continue;
      cancelAtk(f); f.hp = f.maxHp; f.status = {}; f.tgt = 0; f.aggro = {}; f.ai.commit = false; f.phase = 0; f.enraged = false; f.poise = f.poiseMax; f.sumN = 0;
    }
    logEnc(e, result);
    emit('combat:end', { enc: e, result });
    refreshCombatFlag();
  }
  function finish(e) {
    e.done = true; e.engaged = false;
    logEnc(e, 'won');
    emit('combat:end', { enc: e, result: 'won' });
    refreshCombatFlag();
  }
  function refreshCombatFlag() { inCombat = encs.some((x) => x.engaged); if (!inCombat) lockUid = 0; }
  function encStep(e, dt) {
    if (e.done) return;
    if (e.calmT > 0) e.calmT -= dt;
    if (!e.engaged && e.calmT <= 0) {
      for (let i = 0; i < heroes.length && !e.engaged; i++) {
        const u = heroes[i];
        if (u.status.hidden) continue;
        if (U.dist2(u.pos.x, u.pos.z, e.x, e.z) < e.radius) { engage(e); break; }
        for (const f of e.foes) if (f.alive && dist(u, f) < TUNE.aggroSee) { engage(e); break; }
      }
    }
    let alive = 0;
    for (let i = 0; i < e.foes.length; i++) if (e.foes[i].alive) alive++;
    // all foes dead -> won (also when the last one died while the fight was disengaged, e.g. to a stray bleed)
    if (alive === 0) { if (e.foes.length) { if (!e.engaged) { e.engaged = true; if (!e.tel) e.tel = { id: e.id, kind: e.kind, act: e.act, t0: time, dur: 0, dmgIn: 0, dmgOut: 0, downs: 0, falls: 0, dodged: 0, perfect: 0, hitsIn: 0, foes: [], result: null }; } finish(e); } return; }
    if (e.engaged) {
      // leash: every living hero (downed ones count: nobody abandons them) more than TUNE.leash from every living foe
      let near = 1e9;
      for (const u of units) { if (u.kind !== 'hero' || !u.spawned || !u.alive || u.left) continue; for (const f of e.foes) if (f.alive) near = Math.min(near, dist(u, f)); }
      if (near > TUNE.leash) disengage(e, 'fled');
      if (e.tel) for (const u of heroes) { const d = U.dist2(u.pos.x, u.pos.z, e.x, e.z); if (d > (e.tel.far || 0)) e.tel.far = Math.round(d); }
    }
    for (let i = 0; i < e.foes.length; i++) { const f = e.foes[i]; if (f.spawned) foeStep(f, e, dt); }
  }

  // =====================================================================================================
  // 4. RULES: damage, heal, statuses, poise, knockback, hit-stop, downed/revive/fall, phases
  // =====================================================================================================
  function immune(u, s) {
    const t = traitId(u);
    if (s === 'stun') return t === 'small_and_stubborn' || t === 'stonehearted';
    if (s === 'weak') return t === 'stonehearted';
    return false;
  }
  function addStatus(t, name, turns, amount, src) {
    if (!t || !t.alive || t.downed || immune(t, name)) return;
    const sec = name === 'stun' ? TUNE.stunSec : Math.max(1, Number(turns) || 1) * TUNE.statusSec;
    let amt = Number(amount) || 0;
    if (t.side === 'foe' && name === 'regen') amt = Math.round(amt * t.hpK * TUNE.foeHealK);   // foe heals scale with their real-time HP
    const s = t.status[name];
    if (s) { s.t = Math.max(s.t, sec); if (amt) s.amount = Math.max(s.amount || 0, amt); }
    else { t.status[name] = { t: sec, amount: amt, tick: TUNE.tickSec }; emit('unit:status', { unit: t, status: name, on: true, src: src || null }); }
    if (name === 'stun') { t.action = null; if (t.side === 'foe') { cancelAtk(t); t.ai.commit = false; } }
    if (name === 'hidden' && t.side === 'party') for (const f of units) if (f.side === 'foe') { if (f.tgt === t.uid) f.tgt = 0; if (f.ai.atkTgt === t.uid) f.ai.commit = false; }
    if (name === 'taunt' && t.side === 'party') for (const f of units) if (isFoe(f) && dist(f, t) < 14) { f.tgt = t.uid; f.ai.retT = 2; }
  }
  function removeStatus(t, name) { if (t.status[name]) { delete t.status[name]; emit('unit:status', { unit: t, status: name, on: false }); } }
  function cleanse(t) { for (const s of ['weak', 'mark', 'stun', 'bleed']) removeStatus(t, s); }
  function calcDamage(ctx, t, e) {
    const src = ctx.src;
    let base = Number(e.amount) || 0;
    if (e.ifTargetHas && e.amountIf != null) {
      let has = e.ifTargetHas.some((s) => t.status[s]);
      // real-time reading of "Stunned": a staggered foe counts, and so does a blade in the back (Backstab)
      if (!has && e.ifTargetHas.includes('stun') && (t.staggerT > 0 || (src && src.pos && behind(src, t)))) has = true;
      if (has) base = Number(e.amountIf);
    }
    let m = 1;
    if (src && src.side === 'party') {
      const g = game();
      if (g.hopeMult) m *= g.hopeMult();
      if (src.id === BEARER_ID && g.corruptionMult) m *= g.corruptionMult();
      if (ctx.kind === 'ability' && g.boonSum) base += g.boonSum('damage_all', 'amount');
      if (traitId(src) === 'first_strike' && inCombat && time - combatT0 < TUNE.firstStrikeSec) m *= 2;
    }
    if (src && src.side === 'foe') {
      const ad = (TUNE.actDmg && AB.state && AB.state.run && TUNE.actDmg[AB.state.run.act]) || 1;
      m *= TUNE.foeDmg * (TUNE.tierDmg[src.tier] || 1) * (src.tier === 'boss' ? 1 + (ad - 1) * 0.5 : ad);   // bosses take half the act boost
      if (src.enraged) m *= TUNE.enrageDmg;
    }
    if (src && src.status && src.status.empower) m *= 1.25;
    if (src && src.status && src.status.weak) m *= 0.75;
    if (t.status.guard) m *= 0.5;
    if (t.status.mark) m *= 1.5;
    return Math.max(1, Math.round(base * m));
  }
  function behind(src, t) {
    const dx = src.pos.x - t.pos.x, dz = src.pos.z - t.pos.z, l = Math.hypot(dx, dz) || 1;
    return (dx * fwdX(t.facing) + dz * fwdZ(t.facing)) / l < -0.35;
  }
  // knockback impulse (m/s) away from (fx, fz); mass resists
  function knock(u, fx, fz, speed) {
    if (!speed || !u.alive || u.downed) return;
    if (u.tier === 'boss') speed *= 0.12; else if (u.atk && u.atk.sp && u.atk.sp.hv) speed *= 0.3;
    let dx = u.pos.x - fx, dz = u.pos.z - fz; const l = Math.hypot(dx, dz);
    if (l < 1e-3) { dx = fwdX(u.facing + PI); dz = fwdZ(u.facing + PI); } else { dx /= l; dz /= l; }
    const s = speed / Math.max(0.6, Math.sqrt(u.mass || 1));
    u.kb.x += dx * s; u.kb.z += dz * s;
  }
  // hit-stop: freeze a unit for a beat on impact; a unit can be frozen again only after TUNE.hitStopGap
  function hitStop(u, sec) {
    if (u.hsGap > 0 && u.side === 'foe') return;
    u.hitStop = Math.max(u.hitStop, sec);
    if (u.side === 'foe') u.hsGap = sec + TUNE.hitStopGap;
  }
  function stagger(f, sec) {
    if (!f.alive || f.side !== 'foe') return;
    if (f.atk && f.atk.sp && f.atk.sp.hv && f.atk.phase === 'wind' && f.tier !== 'normal') return;   // armoured wind-up
    f.staggerT = Math.max(f.staggerT, sec * (f.tier === 'boss' ? 0.55 : f.tier === 'elite' ? 0.75 : 1));
    if (f.atk) cancelAtk(f);
    f.ai.commit = false; f.cd = Math.max(f.cd, 0.4);
    f.poise = f.poiseMax; f.poiseImm = TUNE.staggerImmune;   // a staggered foe braces itself for a while
    emit('combat:stagger', { unit: f });
  }
  function dealDamage(t, amount, info = {}) {
    if (!t || !t.alive || t.downed) return 0;
    amount = Math.max(0, Math.round(Number(amount) || 0));
    const src = info.src || null;
    if (t.side === 'foe' && (t.invuln > 0 || t.spawnT > 0)) { emit('unit:hit', { unit: t, src, amount: 0, kind: 'immune', ability: info.ability || null, heavy: false, pos: t.pos }); return 0; }
    if (t.side === 'party' && AB.state && AB.state.god) amount = Math.max(0, Math.min(amount, t.hp - 1));
    if (info.nonlethal) amount = Math.max(0, Math.min(amount, t.hp - 1));
    t.hp -= amount;
    let heavy = !!info.heavy || amount >= Math.max(10, t.maxHp * 0.18);
    // hit flash: heroes always; foes only for the player's own hits and heavy blows (companion chip damage stays quiet)
    if (t.side === 'party' || heavy || (src && src === controlled)) t.flash = 0.18;
    const enc = t.side === 'foe' ? t.enc : null;
    if (t.kind === 'hero') {
      if (amount >= t.maxHp * 0.22) {
        heavy = true; t.hitT = 0.3; t.staggerT = Math.max(t.staggerT, 0.3); if (t.action && !t.action.fired) t.action = null; t.hitStop = Math.max(t.hitStop, 0.04);
        // a heavy blow on someone kneeling by a downed friend knocks half the revive progress out of them
        for (const h of units) if (h.downed && h.reviveT > 0 && h !== t && dist(h, t) < TUNE.reviveR + h.radius + t.radius + 0.3) h.reviveT *= 0.5;
      }
      else t.hitT = 0.16;
      const e = encOfFoe(src); if (e && e.tel) { e.tel.dmgIn += amount; e.tel.hitsIn++; }
    } else if (t.kind === 'enemy' && amount > 0) {
      t.hitT = 0.15;
      if (src && src.side === 'party') {
        t.aggro[src.uid] = (t.aggro[src.uid] || 0) + amount * (src.role === 'tank' ? 1.8 : 1);
        if (enc && enc.tel) enc.tel.dmgOut += amount;
        // poise: hits wear it down; a broken guard staggers (finishers, skills and ripostes hit poise harder)
        if (t.poiseImm <= 0) { t.poise -= amount * (info.poise || 0.6); t.poiseT = TUNE.poiseRegen; if (t.poise <= 0) stagger(t, TUNE.staggerSec); }
        // interrupt: a chanting normal foe loses its cast to a heavy hit (skill, finisher, riposte) or enough damage
        const a = t.atk;
        if (a && a.phase === 'wind' && a.sp.s === 'cast' && t.tier === 'normal' && t.alive) {
          a.dmg = (a.dmg || 0) + amount;
          if (heavy || a.dmg >= t.maxHp * TUNE.interruptK) {
            cancelAtk(t); t.ai.commit = false; t.staggerT = Math.max(t.staggerT, TUNE.interruptStagger); t.cd = Math.max(t.cd, 0.8);
            if (enc && enc.tel) enc.tel.interrupts = (enc.tel.interrupts || 0) + 1;
            emit('combat:interrupt', { unit: t, src });
          }
        }
      }
    }
    emit('unit:hit', { unit: t, src, amount, kind: info.kind || 'hit', ability: info.ability || null, heavy, pos: t.pos });
    if (enc && !enc.engaged && !enc.done) engage(enc);
    if (t.hp <= 0) { if (t.side === 'party') downUnit(t); else killUnit(t, src); }
    else if (t.side === 'foe' && (t.tier === 'boss' || t.tier === 'elite')) checkPhase(t);
    return amount;
  }
  function encOfFoe(f) { return f && f.side === 'foe' && f.enc ? f.enc : null; }
  function healUnit(u, amount, info = {}) {
    if (!u || !u.alive || u.downed) return 0;
    const b = u.hp;
    u.hp = Math.min(u.maxHp, u.hp + Math.max(0, Math.round(Number(amount) || 0)));
    const d = u.hp - b;
    if (d > 0 && !info.silent) emit('unit:heal', { unit: u, amount: d, kind: info.kind || 'heal', src: info.src || null });
    // healing draws the attention of nearby foes to the healer
    if (d > 0 && info.src && info.src.side === 'party' && info.src !== u && inCombat) for (const f of units) if (isFoe(f) && f.enc && f.enc.engaged && dist(f, info.src) < 18) f.aggro[info.src.uid] = (f.aggro[info.src.uid] || 0) + d * 0.5;
    return d;
  }
  function downUnit(u) {
    u.hp = 0; u.downed = true; u.downT = TUNE.downT; u.reviveT = 0; u.downCtlT = 0;
    u.action = null; u.dodgeT = 0; u.vel.set(0, 0, 0); u.staggerT = 0;
    for (const k in u.status) removeStatus(u, k);
    for (const e of encs) if (e.tel) e.tel.downs++;
    for (const f of units) if (f.side === 'foe' && f.tgt === u.uid) f.tgt = 0;
    emit('unit:downed', { unit: u });
  }
  function reviveUnit(u) {
    u.downed = false; u.hp = Math.max(1, Math.round(u.maxHp * TUNE.revivePct)); u.reviveT = 0; u.downCtlT = 0;
    u.iframes = 1.0;   // a breath to get up
    emit('unit:revived', { unit: u });
  }
  function fallUnit(u) {
    u.downed = false; u.alive = false; u.hp = 0; u.deadT = 0;
    for (const e of encs) if (e.tel) e.tel.falls++;
    emit('unit:death', { unit: u });
    emit('hero:fallen', { unit: u });
  }
  function killUnit(f, src) {
    f.alive = false; f.hp = 0; f.deadT = 0; cancelAtk(f); f.vel.set(0, 0, 0); f.ai.commit = false; f.staggerT = 0;
    if (f.uid === lockUid) lockUid = 0;
    emit('unit:death', { unit: f });
    dropLoot(f);
  }
  // elite/boss phases: boss at 60% (elite 50%) roars, throws everyone back and calls its kin (content summon intent);
  // bosses enrage at 30% (faster, harder, shorter wind-ups)
  function checkPhase(f) {
    const p = hpFrac(f);
    if (f.phase === 0 && p <= (TUNE.phaseAt[f.tier] || 0.5)) {
      f.phase = 1;
      cancelAtk(f); f.ai.commit = false;
      f.invuln = f.tier === 'boss' ? 1.4 : 0.9; f.recover = f.invuln; f.staggerT = 0;
      const roar = { id: 'roar', name: 'Roar', effects: [] };
      emit('unit:action', { unit: f, slot: 'intent', ability: 'roar', intent: roar, shape: 'cast', target: null, phase: 'start', windup: f.invuln * 0.7 });
      emit('unit:action', { unit: f, slot: 'intent', ability: 'roar', intent: roar, shape: 'cast', target: null, phase: 'release' });
      for (const u of heroes) if (dist(u, f) < 6.5 + f.radius) knock(u, f.pos.x, f.pos.z, 8);
      const sm = (f.def.intents || []).find((it) => (it.effects || []).some((x) => x.type === 'summon'));
      if (sm) { const id = sm.effects.find((x) => x.type === 'summon').enemy; summon(f, id, true); if (f.tier === 'boss') summon(f, id, true); }
      emit('combat:phase', { unit: f, phase: 1 });
    }
    if (f.tier === 'boss' && !f.enraged && p <= TUNE.enrageAt) {
      f.enraged = true;
      for (const u of heroes) if (dist(u, f) < 5.5 + f.radius) knock(u, f.pos.x, f.pos.z, 6);
      emit('combat:enrage', { unit: f });
    }
  }

  // =====================================================================================================
  // 5. EFFECTS (abilities, intents, items)
  // =====================================================================================================
  function lowestAlly(u, r) {
    let best = null, bp = 2;
    for (const h of heroes) {
      if (u && dist(u, h) > r) continue;
      const p = hpFrac(h); if (p < bp) { bp = p; best = h; }
    }
    return best;
  }
  function foesNear(x, z, r) {
    const out = [];
    for (const f of units) if (isFoe(f) && !f.sub && U.dist2(x, z, f.pos.x, f.pos.z) <= r + f.radius) out.push(f);
    return out;
  }
  // centre of the other standing heroes (false when alone)
  function partyCentre(u, out) {
    let n = 0; out.x = 0; out.z = 0;
    for (const h of heroes) if (h !== u) { out.x += h.pos.x; out.z += h.pos.z; n++; }
    if (!n) return false;
    out.x /= n; out.z /= n; return true;
  }
  // may a ranged hero back off to (tx, tz)? not into a dormant group, not far out of the fight's arena, not more than
  // 15 m from the rest of the party (a kiting bearer once dragged a whole boss fight 90 m down the road)
  function kiteOK(u, foe, tx, tz) {
    if (nearDormant(tx, tz)) return false;
    const e = foe && foe.enc;
    if (e) { const dn = U.dist2(tx, tz, e.x, e.z); if (dn > e.radius + 8 && dn > U.dist2(u.pos.x, u.pos.z, e.x, e.z)) return false; }
    if (partyCentre(u, tmpV)) { const dn = U.dist2(tx, tz, tmpV.x, tmpV.z); if (dn > 15 && dn > U.dist2(u.pos.x, u.pos.z, tmpV.x, tmpV.z)) return false; }
    return true;
  }
  // a calm encounter whose aggro range (x, z) touches: kiting heroes must not wake it
  function nearDormant(x, z) {
    for (const e of encs) {
      if (e.engaged || e.done) continue;
      if (U.dist2(x, z, e.x, e.z) < e.radius + 4) return true;
      for (const f of e.foes) if (f.alive && U.dist2(x, z, f.pos.x, f.pos.z) < TUNE.aggroSee + 2.5) return true;
    }
    return false;
  }
  function countFoesNear(x, z, r) {
    let n = 0;
    for (const f of units) if (isFoe(f) && !f.sub && f.enc && f.enc.engaged && U.dist2(x, z, f.pos.x, f.pos.z) <= r + f.radius) n++;
    return n;
  }
  function resolveTargets(e, ctx) {
    const src = ctx.src, side = ctx.side, tg = e.target;
    if (tg === 'self') return src && src.alive ? [src] : [];
    if (tg === 'friend') {
      if (side === 'party') {
        if (e.pick === 'lowest' || !ctx.target || ctx.target.side !== 'party') { const l = lowestAlly(src, ctx.kind === 'item' ? 1e9 : TUNE.friendR * 2); return l ? [l] : []; }
        return isActive(ctx.target) ? [ctx.target] : [];
      }
      let best = null; for (const f of (src.enc ? src.enc.foes : [])) if (f.alive && (!best || hpFrac(f) < hpFrac(best))) best = f;
      return best ? [best] : [src];
    }
    if (tg === 'all_friends') {
      if (side === 'party') return ctx.kind === 'item' || !src ? heroes.slice() : heroes.filter((h) => h === src || dist(h, src) <= TUNE.partyR);
      return src.enc ? src.enc.foes.filter((f) => f.alive && !f.sub) : [src];
    }
    if (tg === 'foe') {
      if (side === 'party') {
        if (e.pick === 'random' && !ctx.single) { const c = ctx.target || src; const pool = foesNear(c.pos.x, c.pos.z, ctx.kind === 'item' ? 30 : 12); return pool.length ? [AB.rand.pick(pool)] : []; }
        return ctx.target && ctx.target.side === 'foe' && ctx.target.alive ? [ctx.target] : [];
      }
      const v = ctx.victims || [];
      if (e.pick === 'random' && (e.hits || 1) > 1 && v.length > 1) return [AB.rand.pick(v)];
      return v;
    }
    if (tg === 'all_foes') {
      if (side === 'party') {
        const c = ctx.center || (ctx.target && ctx.target !== src ? ctx.target.pos : src.pos);
        return foesNear(c.x, c.z, ctx.radius || TUNE.allFoesR);
      }
      return ctx.allVictims || ctx.victims || [];
    }
    return [];
  }
  function bearerNear(src, r) { for (const u of heroes) if (u.id === BEARER_ID) return !!(src && dist(u, src) <= r); return false; }
  function applyEffects(effects, ctx) {
    ctx = Object.assign({ side: 'party', kind: 'item' }, ctx || {});
    if (!ctx.src && ctx.source) ctx.src = ctx.source;
    if (ctx.kind === 'item') {
      const u = ctx.src || controlled;
      ctx.src = u;
      if (!ctx.target && u) { const f = lockTarget() || nearestFoe(u, 22); ctx.target = f; ctx.radius = f ? 8 : 22; ctx.center = f ? f.pos : u.pos; }
    }
    const g = game();
    const why = ctx.kind === 'item' ? 'item' : ctx.kind === 'intent' ? (ctx.src ? ctx.src.name : 'foe') : (ctx.ab ? ctx.ab.name : 'ability');
    // a foe's attack that hit nobody also loses its rider effects (statuses, Hope, Corruption): dodging pays
    const missed = ctx.side === 'foe' && ctx.attack && !(ctx.victims && ctx.victims.length) && !(ctx.allVictims && ctx.allVictims.length);
    // party abilities: Hope and silver riders pay out in a fight, once per hero per TUNE.resourceAbilityCd
    let resOk = true;
    if (ctx.side === 'party' && ctx.kind === 'ability' && ctx.src) {
      resOk = inCombat && time - ctx.src.resT >= TUNE.resourceAbilityCd;
      if (resOk && effects.some((e) => e.type === 'hope' || e.type === 'silver')) ctx.src.resT = time;
    }
    const onlyDamage = ctx.frame > 0 || ctx.cleave;
    for (const e of effects || []) {
      if (onlyDamage && e.type !== 'damage') continue;
      switch (e.type) {
        case 'damage': {
          if (missed) break;
          let hits = Math.max(1, e.hits || 1);
          if (ctx.frames > 1 || ctx.single) hits = 1;
          // party "random foe" volleys (Hunter's Volley, Throwing Knives) fly as real projectiles, one per hit
          if (ctx.side === 'party' && e.pick === 'random' && e.target === 'foe' && !ctx.single && ctx.src && ctx.src.pos) { volley(ctx, e, hits); break; }
          for (let h = 0; h < hits; h++) for (const t of resolveTargets(e, ctx)) {
            if (ctx.side === 'foe' && t.iframes > 0) continue;
            dealDamage(t, calcDamage(ctx, t, e), { src: ctx.src, kind: ctx.kind, ability: ctx.ab ? ctx.ab.id : (ctx.intent ? ctx.intent.id : null), heavy: ctx.heavy, poise: ctx.poise });
          }
          break;
        }
        case 'heal': {
          const amt = ctx.side === 'foe' && ctx.src ? Math.round((Number(e.amount) || 0) * (ctx.src.hpK || 1) * TUNE.foeHealK) : e.amount;
          for (const t of resolveTargets(e, ctx)) healUnit(t, amt, { kind: ctx.kind, src: ctx.src });
          break;
        }
        case 'status': if (!missed) for (const t of resolveTargets(e, ctx)) { if (ctx.side === 'foe' && t.side === 'party' && t.iframes > 0) continue; addStatus(t, e.status, e.turns, e.amount, ctx.src); } break;
        case 'cleanse': for (const t of resolveTargets(e, ctx)) cleanse(t); break;
        case 'corruption':
          if (missed) break;
          if (ctx.side === 'foe' && Number(e.amount) > 0 && !bearerNear(ctx.src, 12)) break;   // whispers need the bearer within 12 m
          if (g.gainCorruption) g.gainCorruption(e.amount, why); break;
        case 'hope': if (missed || !resOk) break; if (g.gainHope) g.gainHope(e.amount, why); break;
        case 'silver': if (!resOk) break; if (g.gainSilver) g.gainSilver(e.amount, why); break;
        case 'supplies': if (g.gainSupplies) g.gainSupplies(e.amount, why); break;
        case 'summon': summon(ctx.src, e.enemy); break;
        case 'flee': fleeNormal(); break;
        default: break;
      }
    }
  }
  const summonCap = (f) => TUNE.summonTotal[f.tier] || 2;
  function summon(src, id, phase) {
    if (!src || !src.enc || !C.enemies[id]) return null;
    const e = src.enc;
    let alive = 0, mine = 0; for (const f of e.foes) if (f.alive) { alive++; if (f.by === src.uid) mine++; }
    if (alive >= TUNE.maxFoesPerEnc || mine >= TUNE.maxSummons || (!phase && (src.sumN || 0) >= summonCap(src))) return null;
    const f = makeEnemy(id);
    f.by = src.uid; src.sumT = time; src.sumN = (src.sumN || 0) + 1;
    f.maxHp = f.hp = Math.max(1, Math.round(f.maxHp * TUNE.summonHp)); f.poiseMax = f.poise = Math.max(16, Math.round(f.poiseMax * TUNE.summonHp));
    const a = src.facing + AB.rand.float(-1.6, 1.6);
    f.pos.set(src.pos.x + Math.sin(a) * (3 + src.radius), 0, src.pos.z + Math.cos(a) * (3 + src.radius));
    AB.world.constrain(f.pos, f.radius); f.pos.y = groundY(f); f.post.copy(src.post || f.pos); f.enc = e; f.facing = src.facing;
    f.spawnT = 0.9; f.cd = 0.6 + AB.rand.float(0, 0.8); f.tgt = src.tgt;
    e.foes.push(f); spawnUnit(f);
    emit('unit:summoned', { unit: f, by: src });
    return f;
  }
  function canFlee() { let any = false; for (const e of encs) if (e.engaged) { any = true; if (e.kind !== 'battle') return false; } return any; }
  function fleeNormal() { for (const e of encs) if (e.engaged && e.kind === 'battle') { disengage(e, 'fled'); e.calmT = 15; } }

  // =====================================================================================================
  // 6. HERO ABILITIES
  // =====================================================================================================
  function cdSec(ab, slot) {
    if (slot === 'attack' || !ab.cooldown) return 0;
    let cd = ab.cooldown;
    const g = game();
    if (cd >= 3 && g.boonHas && g.boonHas('cooldown_haste')) cd -= 1;
    return cd * TUNE.cdScale;
  }
  function rangeOf(u, slot = 'attack') {
    const ab = u.slots ? u.slots[slot] : null;
    const w = kitOf(u);
    if (ab && ab.select === 'foe' && w.ranged) return w.ranged;
    return w.reach + 0.5;
  }
  const isRangedHero = (u) => !!kitOf(u).ranged && (u.id === 'wren' || u.id === 'neve');
  // auto-target: the hard lock if close enough, else the best foe in front (distance + angle), engaged foes first
  function chooseFoeTarget(u, range) {
    const lk = byUid(lockUid);
    if (u === controlled && lk && lk.alive && dist(u, lk) <= range + 4) return lk;
    let best = null, bs = 1e9;
    const fx = fwdX(u.facing), fz = fwdZ(u.facing);
    for (const f of units) {
      if (!isFoe(f) || f.sub || f.spawnT > 0) continue;
      const d = dist(u, f); if (d > range + f.radius) continue;
      const dx = (f.pos.x - u.pos.x) / (d || 1), dz = (f.pos.z - u.pos.z) / (d || 1);
      const score = d + (1 - (dx * fx + dz * fz)) * 3.2 + (f.enc && f.enc.engaged ? 0 : 6) + (u === controlled && f.uid === softUid ? -1.2 : 0);
      if (score < bs) { bs = score; best = f; }
    }
    return best;
  }
  function abilityKind(ab) {
    const eff = ab.effects || [];
    return {
      dmgFoe: eff.some((e) => e.type === 'damage' && e.target === 'foe' && e.pick !== 'random'),
      volley: eff.some((e) => e.type === 'damage' && e.target === 'foe' && e.pick === 'random'),
      allFoes: eff.some((e) => (e.type === 'damage' || e.type === 'status') && e.target === 'all_foes'),
      frames: Math.max(1, ...eff.filter((e) => e.type === 'damage' && e.target === 'foe' && e.pick !== 'random').map((e) => e.hits || 1))
    };
  }
  const abKinds = new WeakMap();
  const kindOf = (ab) => { let k = abKinds.get(ab); if (!k) { k = abilityKind(ab); abKinds.set(ab, k); } return k; };
  function tryAbility(u, slot, target) {
    const ab = u.slots ? u.slots[slot] : null;
    if (!ab || !isActive(u) || u.status.stun || u.staggerT > 0 || u.dodgeT > 0 || u.cds[slot] > 0 || u.hitStop > 0) return false;
    if (u.action) {
      // a skill may cancel the recovery of an attack swing once its blow has landed (combo flow)
      const a = u.action;
      if (!(a.fired && a.slot === 'attack' && slot !== 'attack' && a.t > a.hitAt + 0.06)) return false;
      u.action = null;
    }
    const kit = kitOf(u), kd = kindOf(ab);
    let t = target || null;
    if (!t) {
      if (ab.select === 'foe') {
        t = chooseFoeTarget(u, (kit.ranged || kit.reach) + (kit.ranged ? 3 : TUNE.gapCloser * (slot === 'attack' ? 0.6 : 1)));
        if (!t && slot !== 'attack') return false;
      } else if (ab.select === 'friend') t = lowestAlly(u, TUNE.friendR) || u;
      else if (slot !== 'ember' && (kd.allFoes || kd.volley)) {
        t = chooseFoeTarget(u, Math.max(kit.ranged || 0, 12) + 3);   // area skills centre on a foe
        if (!t) return false;
      } else t = u;
    }
    const isAtk = slot === 'attack';
    let dur = TUNE.skillDur, hitAt = TUNE.skillHit, combo = 0;
    if (isAtk) {
      combo = u.comboT > 0 ? (u.combo + 1) % 3 : 0;
      const c = kit.combo[combo]; dur = c[0]; hitAt = c[1];
    }
    const frames = ab.select === 'foe' && kd.dmgFoe && !kit.ranged ? kd.frames : (ab.select === 'foe' && kd.dmgFoe && kd.frames > 1 ? kd.frames : 1);
    u.combo = combo; u.comboT = 0;
    const lunge = !!(t && t !== u && ab.select === 'foe' && (!kit.ranged || dist(u, t) < kit.reach + 2) && dist(u, t) > kit.reach + t.radius);
    u.action = { slot, ab, target: t && t !== u ? t.uid : 0, t: 0, dur, hitAt, fired: false, combo, frames, fi: 0, lunge, riposte: u.riposte > 0 && ab.select === 'foe' };
    if (u.action.riposte) u.riposte = 0;
    u.cds[slot] = cdSec(ab, slot);
    if (t && t !== u) u.facing = U.yawTo(t.pos.x - u.pos.x, t.pos.z - u.pos.z);
    emit('unit:action', { unit: u, slot, ability: ab.id, target: t, phase: 'start' });
    return true;
  }
  function actionStep(u, dt) {
    const a = u.action;
    a.t += dt;
    const kit = kitOf(u);
    if (!a.fired) {
      // turn toward the target and close the gap (melee magnetism / gap closers)
      const t = byUid(a.target);
      if (t && t.alive && t.side === 'foe') {
        u.facing = U.dampAngle(u.facing, U.yawTo(t.pos.x - u.pos.x, t.pos.z - u.pos.z), 18, dt);
        const d = dist(u, t), want = kit.reach * 0.8 + t.radius;
        const maxR = a.slot === 'attack' ? TUNE.magnet : TUNE.gapCloser + 1;
        if ((a.lunge || (!kit.ranged && d < maxR)) && d > want && d < maxR + 2) {
          const sp = Math.min(TUNE.lungeSpeed * (a.slot === 'attack' ? 1 : 1.6), (d - want) / Math.max(0.05, a.hitAt - a.t + 0.02));
          u.vel.x = (t.pos.x - u.pos.x) / d * sp; u.vel.z = (t.pos.z - u.pos.z) / d * sp;
        }
      }
    }
    if (!a.fired && a.t >= a.hitAt) { a.fired = true; a.fi = 1; releaseAbility(u, a, 0); }
    else if (a.fired && a.fi < a.frames && a.t >= a.hitAt + a.fi * (kit.frames || 0.12)) { releaseAbility(u, a, a.fi); a.fi++; }
    if (u.action === a && a.t >= a.dur) { u.action = null; if (a.slot === 'attack') u.comboT = TUNE.comboWindow; }
  }
  // melee arc test: the target (if in reach) + whatever stands in the swing; finishers cleave everything in the arc
  function meleeVictims(u, t, a, kit, out) {
    out.length = 0;
    const fin = a.slot === 'attack' && a.combo === 2;
    const reach = kit.reach + (fin ? 0.35 : 0) + (a.slot !== 'attack' ? 0.3 : 0);
    const half = kit.arc * 0.5 * (fin ? 1.3 : 1);
    const fx = fwdX(u.facing), fz = fwdZ(u.facing);
    let primary = null;
    for (const f of units) {
      if (!isFoe(f) || f.sub) continue;
      const dx = f.pos.x - u.pos.x, dz = f.pos.z - u.pos.z, d = Math.hypot(dx, dz);
      if (d > reach + f.radius + 0.25) continue;
      const inArc = d < f.radius + 0.7 || Math.acos(clamp((dx * fx + dz * fz) / (d || 1), -1, 1)) <= half + Math.atan2(f.radius, Math.max(0.5, d));
      if (!inArc && f !== t) continue;
      out.push(f);
      if (f === t) primary = f;
    }
    if (!out.length) return out;
    if (!primary) { let bd = 1e9; for (const f of out) { const d = dist(u, f); if (d < bd) { bd = d; primary = f; } } }
    const cleave = fin || u.id === 'brakka' && a.slot === 'attack' && a.combo > 0;
    if (!cleave) { out.length = 0; out.push(primary); }
    else { const i = out.indexOf(primary); if (i > 0) { out[i] = out[0]; out[0] = primary; } if (out.length > 4) out.length = 4; }
    return out;
  }
  function releaseAbility(u, a, frame) {
    const ab = a.ab, kd = kindOf(ab), kit = kitOf(u);
    let t = byUid(a.target);
    if (t && !t.alive) t = null;
    if (ab.select === 'foe') {
      if (frame === 0 && kit.ranged && (!t || dist(u, t) > kit.reach + t.radius + 0.6)) {
        if (!t && a.slot !== 'attack') { emit('unit:action', { unit: u, slot: a.slot, ability: ab.id, target: null, phase: 'release', whiff: true }); return; }
        fireProjectile(u, t, ab, a.slot, a);
        emit('unit:action', { unit: u, slot: a.slot, ability: ab.id, target: t, phase: 'release' });
        return;
      }
      if (kit.ranged && frame > 0 && (!t || dist(u, t) > kit.reach + t.radius + 0.6)) return;
      const vs = meleeVictims(u, t, a, kit, scratch);
      if (frame === 0) emit('unit:action', { unit: u, slot: a.slot, ability: ab.id, target: vs[0] || t, phase: 'release', whiff: !vs.length });
      if (!vs.length) return;
      const fin = a.slot === 'attack' && a.combo === 2;
      const list = vs.slice();
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        resolveAbility(u, ab, v, a.slot, { frame, frames: a.frames, cleave: i > 0, finisher: fin, riposte: a.riposte });
        const hs = fin || a.riposte || a.slot !== 'attack' ? TUNE.hitStopHeavy : TUNE.hitStop;
        u.hitStop = Math.max(u.hitStop, hs); hitStop(v, hs);
        knock(v, u.pos.x, u.pos.z, fin || a.riposte ? kit.kb : a.slot === 'attack' ? 1.1 : kit.kb * 0.7);
      }
      return;
    }
    emit('unit:action', { unit: u, slot: a.slot, ability: ab.id, target: t, phase: 'release' });
    resolveAbility(u, ab, t, a.slot, { frame: 0 });
  }
  function resolveAbility(u, ab, t, slot, o = {}) {
    const fin = !!o.finisher, rip = !!o.riposte;
    const ctx = { src: u, side: 'party', kind: 'ability', ab, slot, target: t, frame: o.frame || 0, frames: o.frames || 1, cleave: !!o.cleave, single: !!o.single,
      heavy: fin || rip || slot !== 'attack', poise: rip ? 3 : fin ? 2.2 : slot !== 'attack' ? 1.4 : 0.6 };
    const kd = kindOf(ab), kit = kitOf(u);
    if (slot === 'ember') {
      ctx.center = u.pos; ctx.radius = TUNE.emberR;
      emit('ember', { unit: u, x: u.pos.x, y: u.pos.y, z: u.pos.z, radius: TUNE.emberR });
      for (const f of foesNear(u.pos.x, u.pos.z, TUNE.emberR)) { knock(f, u.pos.x, u.pos.z, 9); hitStop(f, 0.12); }
      u.hitStop = Math.max(u.hitStop, 0.1);
    } else if (kd.allFoes && ab.select !== 'foe') {
      // area skills: archers drop it on the foe they aim at, singers and casters sing around themselves
      const self = !(kit.ranged && u.id === 'neve') || !t || t === u;
      ctx.center = self ? u.pos : t.pos; ctx.radius = TUNE.allFoesR;
      if (!o.frame) emit('combat:area', { unit: u, x: ctx.center.x, z: ctx.center.z, radius: ctx.radius, ability: ab.id });
    }
    applyEffects(ab.effects, ctx);
  }
  // one projectile per hit, at random foes near the target (Hunter's Volley, Throwing Knives)
  function volley(ctx, e, hits) {
    const src = ctx.src, c = ctx.target && ctx.target.pos ? ctx.target.pos : src.pos;
    const pool = foesNear(c.x, c.z, ctx.kind === 'item' ? 22 : 14);
    if (!pool.length) return;
    for (let h = 0; h < hits; h++) {
      const t = AB.rand.pick(pool);
      const ab = ctx.ab || { id: ctx.itemId || 'item', name: 'item', select: 'foe', effects: [e] };
      const p = fireProjectile(src, t, { id: ab.id, name: ab.name, select: 'foe', effects: [e] }, ctx.slot || 'item', null, src.id === 'neve' ? 'arrow' : 'knife');
      if (p) { p.single = true; p.kindCtx = ctx.kind; p.delay = h * 0.09; p.pos.x += (h - 1) * 0.15; }
    }
  }

  // =====================================================================================================
  // 7. PROJECTILES + TELEGRAPHS
  // =====================================================================================================
  const projPool = [];
  function newProj() {
    return projPool.pop() || { id: 0, kind: '', side: '', pos: new V3(), vel: new V3(), from: new V3(), target: 0, homing: false, speed: 0, life: 0, radius: 0.3,
      src: 0, ab: null, slot: null, intent: null, threat: null, aimX: 0, aimZ: 0, single: false, kindCtx: null, delay: 0, lob: false, aoe: 0, sp: null, riposte: false, fin: false, hitSet: null };
  }
  function fireProjectile(u, t, ab, slot, a, kindOverride) {
    const w = kitOf(u);
    const p = newProj();
    p.id = projSeq++; p.kind = kindOverride || w.proj || 'stone'; p.side = 'party'; p.src = u.uid; p.target = t ? t.uid : 0; p.homing = !!t;
    p.speed = kindOverride === 'knife' ? 30 : (w.speed || 26);
    p.life = (w.ranged || 16) / p.speed + 0.5; p.radius = 0.3; p.ab = ab; p.slot = slot; p.intent = null; p.threat = null; p.single = false; p.kindCtx = 'ability';
    p.delay = 0; p.lob = false; p.aoe = 0; p.sp = null; p.riposte = !!(a && a.riposte); p.fin = !!(a && a.slot === 'attack' && a.combo === 2);
    p.pos.set(u.pos.x + fwdX(u.facing) * 0.45, u.pos.y + u.height * 0.72, u.pos.z + fwdZ(u.facing) * 0.45);
    p.from.copy(p.pos);
    if (t) p.vel.set(t.pos.x - p.pos.x, t.pos.y + t.height * 0.55 - p.pos.y, t.pos.z - p.pos.z);
    else p.vel.set(fwdX(u.facing), 0, fwdZ(u.facing));
    p.vel.normalize().multiplyScalar(p.speed);
    projs.push(p);
    emit('projectile', { proj: p });
    return p;
  }
  function fireFoeProjectile(f, a) {
    const t = byUid(a.target), sp = a.sp;
    const p = newProj();
    let ax = a.x, az = a.z;
    p.id = projSeq++; p.kind = sp.pk || (f.glyph === 'spider' ? 'spit' : 'curse'); p.side = 'foe'; p.src = f.uid; p.target = 0; p.homing = false;
    p.speed = sp.spd || (sp.mv === 'lob' ? 13 : TUNE.projSpeedFoe);
    p.radius = sp.mv === 'lob' ? 0.6 : 0.45; p.ab = null; p.slot = null; p.intent = a.intent; p.sp = sp; p.single = false; p.delay = 0; p.riposte = false; p.fin = false;
    p.lob = sp.mv === 'lob'; p.aoe = p.lob ? (sp.r || 2.4) * (f.tier === 'boss' ? 1.2 : 1) : 0;
    p.pos.set(f.pos.x + fwdX(f.facing) * f.radius, f.pos.y + f.height * 0.72, f.pos.z + fwdZ(f.facing) * f.radius); p.from.copy(p.pos);
    // lead a moving target a little (half the flight time): strafing still beats it, running straight does not
    if (t && isActive(t) && !p.lob) { const fl = U.dist2(p.pos.x, p.pos.z, t.pos.x, t.pos.z) / p.speed; ax = t.pos.x + t.vel.x * fl * 0.5; az = t.pos.z + t.vel.z * fl * 0.5; }
    const ty = AB.world.heightAt(ax, az) + (p.lob ? 0 : 1.0);
    const L = Math.max(1, Math.hypot(ax - p.pos.x, az - p.pos.z));
    if (p.lob) {
      const T = clamp(L / p.speed, 0.7, 1.5);
      p.vel.set((ax - p.pos.x) / T, (ty - p.pos.y) / T + 0.5 * 18 * T, (az - p.pos.z) / T);
      p.life = T + 0.4;
      p.threat = addThreat(f, 'proj', ax, az, p.aoe, T);
    } else {
      // fly THROUGH the aim point (towards the target's height), so a hero who sidesteps lets it pass
      p.vel.set(ax - p.pos.x, ty - p.pos.y, az - p.pos.z);
      const l3 = p.vel.length() || 1;
      p.vel.multiplyScalar(p.speed / l3);
      p.life = l3 / p.speed + 0.7;
      p.threat = addThreat(f, 'proj', ax, az, sp.r || TUNE.projThreatR, l3 / p.speed);
    }
    p.aimX = ax; p.aimZ = az;
    projs.push(p);
    emit('projectile', { proj: p });
  }
  function removeProj(i, hitUnit) {
    const p = projs[i];
    projs.splice(i, 1);
    if (p.threat) removeThreat(p.threat);
    emit('projectile:end', { proj: p, unit: hitUnit || null });
    p.threat = null; p.ab = null; p.intent = null; p.sp = null;
    projPool.push(p);
  }
  function foeHitBy(p) {
    for (const f of units) {
      if (!isFoe(f) || f.sub || f.spawnT > 0) continue;
      const dx = f.pos.x - p.pos.x, dz = f.pos.z - p.pos.z;
      const rr = f.radius + p.radius + 0.15;
      if (dx * dx + dz * dz < rr * rr && p.pos.y > f.pos.y - 0.3 && p.pos.y < f.pos.y + f.height + 0.4) return f;
    }
    return null;
  }
  function projStep(dt) {
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.life -= dt;
      if (p.side === 'party') {
        let t = byUid(p.target);
        if (t && !t.alive) { t = nearestFoeTo(p.pos.x, p.pos.z, 6); p.target = t ? t.uid : 0; }
        if (t && p.homing) {
          // gentle homing: arrows and stones curve onto their mark
          tmpV.set(t.pos.x - p.pos.x, t.pos.y + t.height * 0.55 - p.pos.y, t.pos.z - p.pos.z).normalize().multiplyScalar(p.speed);
          const k = 1 - Math.exp(-9 * dt);
          p.vel.lerp(tmpV, k); p.vel.setLength(p.speed);
        }
        let hit = null;
        const n = p.speed * dt > 0.5 ? 2 : 1;
        for (let s = 0; s < n && !hit; s++) { p.pos.addScaledVector(p.vel, dt / n); hit = foeHitBy(p); }
        if (hit) {
          const src = byUid(p.src) || { uid: p.src, side: 'party', status: {}, pos: p.from.clone(), id: '', role: '', facing: 0 };
          const ab = p.ab, slot = p.slot, single = p.single, kc = p.kindCtx, rip = p.riposte, fin = p.fin;
          removeProj(i, hit);
          if (kc === 'item') applyEffects(ab.effects, { src, side: 'party', kind: 'item', target: hit, single: true });
          else resolveAbility(src, ab, hit, slot, { single, finisher: fin, riposte: rip });
          hitStop(hit, fin || rip ? 0.085 : 0.06);
          if (fin || rip) knock(hit, p.from.x, p.from.z, kitOf(src).kb || 2.5);
          continue;
        }
      } else {
        if (p.lob) p.vel.y -= 18 * dt;
        p.pos.addScaledVector(p.vel, dt);
        if (p.threat) p.threat.left = Math.max(0, p.threat.left - dt);
        if (p.lob) {
          if (p.pos.y <= AB.world.heightAt(p.pos.x, p.pos.z) + 0.2 || p.life <= 0) {
            const f = byUid(p.src), it = p.intent, sp = p.sp, ax = p.pos.x, az = p.pos.z, r = p.aoe;
            removeProj(i, null);
            if (f && it) impactArea(f, it, sp, ax, az, r);
            continue;
          }
        } else {
          let hit = null;
          for (const u of heroes) {
            if (U.dist2(u.pos.x, u.pos.z, p.pos.x, p.pos.z) < u.radius + p.radius && p.pos.y > u.pos.y - 0.3 && p.pos.y < u.pos.y + u.height + 0.3) {
              if (u.iframes > 0) { dodged(u, byUid(p.src)); continue; }
              hit = u; break;
            }
          }
          if (hit) {
            const f = byUid(p.src), intent = p.intent;
            removeProj(i, hit);
            if (f && intent) { const ctx = { src: f, side: 'foe', kind: 'intent', intent, target: hit, victims: [hit], allVictims: [hit], attack: true }; applyEffects(intent.effects, ctx); }
            continue;
          }
        }
      }
      if (p.life <= 0 || p.pos.y < AB.world.heightAt(p.pos.x, p.pos.z) - 0.3) removeProj(i, null);
    }
  }
  function addThreat(f, kind, x, z, r, dur) {
    const th = { id: thrSeq++, side: f.side, shape: 'circle', kind, x, z, radius: r, left: dur, total: dur, src: f.uid, yaw: f.facing };
    threats.push(th);
    emit('telegraph', { threat: th });
    return th;
  }
  function removeThreat(th) { const i = threats.indexOf(th); if (i >= 0) threats.splice(i, 1); }
  function cancelAtk(f) {
    if (!f.atk) return;
    if (f.atk.threat) removeThreat(f.atk.threat);
    if (f.atk.threats) for (const th of f.atk.threats) removeThreat(th);
    f.atk = null;
  }
  function dodged(u, src) {
    emit('unit:hit', { unit: u, src: src || null, amount: 0, kind: 'dodged', heavy: false, pos: u.pos });
    const e = encOfFoe(src); if (e && e.tel) e.tel.dodged++;
    // perfect dodge: rolled just before the blow landed -> brief slow motion and a riposte on the next strike
    if (u.dodgeAge < TUNE.perfectWindow && u.riposte <= 0) {
      u.riposte = TUNE.riposteT;
      if (e && e.tel) e.tel.perfect++;
      emit('combat:perfect', { unit: u, src: src || null });
      if (u === controlled && !FF() && !bot()) AB.loop.slowmo(0.35, 0.22);
    }
  }

  // =====================================================================================================
  // 8. ENEMY AI
  // =====================================================================================================
  const isResourceIntent = (it) => (it.effects || []).some((e) => e.type === 'hope' || e.type === 'corruption');
  const specCache = new Map();
  function intentSpec(f, it) {
    const key = f.id + ':' + it.id;
    let s = specCache.get(key); if (s) return s;
    const effs = it.effects || [];
    const dmg = effs.find((e) => e.type === 'damage');
    const st = effs.find((e) => e.type === 'status' && (e.target === 'foe' || e.target === 'all_foes'));
    let b;
    if (dmg) b = dmg.target === 'all_foes' ? { s: 'aoe', mv: 'self', r: 4.6 } : (f.ranged ? { s: 'proj' } : { s: 'melee' });
    else if (st) b = st.target === 'all_foes' ? { s: 'aoe', mv: 'ring', r: 9 } : st.pick === 'bearer' ? { s: 'cast' } : (f.ranged ? { s: 'proj' } : { s: 'melee', mv: 'cone', r: 2.3 });
    else b = { s: 'cast' };
    s = Object.assign({ s: 'cast', mv: null, r: 0, w: 0, dash: 0, reach: 0, hv: false, kb: 0, pk: null, spd: 0 }, b, IN[key] || {});
    s.dmg = dmg ? (Number(dmg.amount) || 0) * (dmg.hits || 1) : 0;
    s.rAbs = !!(IN[key] && IN[key].r);   // radii in the override table are final; derived ones scale with the body
    s.offensive = s.s !== 'cast';
    s.res = isResourceIntent(it);
    s.summon = effs.some((e) => e.type === 'summon');
    s.heal = effs.some((e) => e.type === 'heal');
    const pk = effs.find((e) => e.pick); s.pick = pk ? pk.pick : null;
    s.single = s.offensive && !(dmg && dmg.target === 'all_foes') && !(st && st.target === 'all_foes' && !dmg);
    if (!s.kb) s.kb = s.hv ? 5 : s.dmg >= 15 ? 3 : 1.5;
    specCache.set(key, s);
    return s;
  }
  function chooseIntent(f) {
    const ints = f.def.intents || [];
    if (!ints.length) return null;
    const blocked = (it) => {
      const rcd = typeof TUNE.resourceIntentCd === 'number' ? TUNE.resourceIntentCd : (TUNE.resourceIntentCd[f.tier] || 14);
      if (isResourceIntent(it) && (time - f.resT < rcd * (f.by ? 1.5 : 1) || time - (f.enc.resT || -1e9) < TUNE.encResourceCd) && ints.some((x) => !isResourceIntent(x))) return true;
      const sp = intentSpec(f, it);
      if (sp.summon) {
        let n = 0, mine = 0; for (const x of f.enc.foes) if (x.alive) { n++; if (x.by === f.uid) mine++; }
        if (n >= TUNE.maxFoesPerEnc || mine >= TUNE.maxSummons || time - f.sumT < TUNE.summonCd || (f.sumN || 0) >= summonCap(f)) return true;
      }
      if (sp.heal && !sp.offensive && (f.enc.foes.every((x) => !x.alive || hpFrac(x) > 0.85) || time - (f.enc.healT || -1e9) < TUNE.encHealCd)) return true;   // nobody to heal yet / a heal just went out
      return false;
    };
    let it = null;
    if (f.def.pattern === 'cycle') {
      // the cycle waits on a blocked step only if nothing else is ready (then the foe just manoeuvres)
      for (let k = 0; k < ints.length; k++) { const x = ints[(f.cycle + k) % ints.length]; if (!blocked(x)) { it = x; f.cycle += k + 1; break; } }
    } else { const pool = ints.filter((x) => !blocked(x)); if (pool.length) it = AB.rand.weighted(pool, (x) => Number(x.weight) || 1); }
    if (it && isResourceIntent(it)) { f.resT = time; f.enc.resT = time; }
    if (it && intentSpec(f, it).heal && !intentSpec(f, it).offensive) f.enc.healT = time;
    return it;
  }
  function tauntTarget(f) {
    for (const u of heroes) if (u.status.taunt && dist(f, u) < 30) return u;
    return null;
  }
  // content pick rules on top of aggro: taunt forces single attacks; hidden heroes cannot be singled out
  function pickFor(f, pick) {
    const tt = tauntTarget(f); if (tt) return tt;
    let best = null, bv = 0;
    if (pick === 'lowest' || pick === 'highest') {
      for (const u of heroes) {
        if (u.status.hidden || dist(f, u) > 24) continue;
        const v = pick === 'lowest' ? -u.hp : u.hp;
        if (!best || v > bv) { best = u; bv = v; }
      }
      if (best) return best;
    }
    if (pick === 'bearer') for (const u of heroes) if (u.id === BEARER_ID && !u.status.hidden) return u;
    const cur = byUid(f.tgt);
    return isActive(cur) && !cur.status.hidden ? cur : aggroTarget(f);
  }
  function aggroTarget(f) {
    const tt = tauntTarget(f); if (tt) return tt;
    let best = null, bs = -1e9;
    const cur = f.tgt;
    for (const u of heroes) {
      if (u.status.hidden) continue;
      const d = dist(f, u);
      if (d > 40) continue;
      let s = (f.aggro[u.uid] || 0) + 40 / (1 + d) + (u === controlled ? 3 : 0) + (u.role === 'tank' ? 4 : 0);
      if (u.uid === cur) s *= 1.25;
      if (s > bs) { bs = s; best = u; }
    }
    return best;
  }
  function tokenFree(e, f) {
    if (f.tier !== 'normal') return true;
    let leader = false, used = 0;
    for (const x of e.foes) { if (!x.alive) continue; if (x.tier !== 'normal') leader = true; if (x !== f && (x.ai.commit || x.atk) && x.tier === 'normal') used++; }
    return used < (leader ? TUNE.tokensWithLeader : TUNE.tokens);
  }
  function engageRange(f, sp, t) {
    const base = f.reach + t.radius + f.radius * 0.4;
    switch (sp.mv) {
      case 'lunge': return base + (sp.dash || 2.5) * 0.85;
      case 'pounce': return sp.reach || 7;
      case 'charge': return sp.reach || 9;
      case 'hook': return sp.reach || 4.6;
      case 'cone': return (sp.r || 2.3) * 2 + f.radius;
      case 'emerge': return sp.reach || 14;
      case 'swarm': return 6.5;
      case 'self': return (sp.r || 4.6) * 0.75 + f.radius;
      case 'ring': return (sp.r || 9) * 0.8;
      case 'each': return 16;
      case 'lob': return 18;
      default: break;
    }
    if (sp.s === 'proj') return f.ranged || 12;
    if (sp.s === 'melee') return Math.max(base, (sp.reach || 0) + t.radius);
    return 14;
  }
  function windupOf(f, sp) {
    let w = sp.w || (sp.s === 'melee' ? clamp(0.68 + sp.dmg / 60, 0.68, 1.05) + (sp.hv ? 0.2 : 0)
      : sp.s === 'aoe' ? (sp.mv === 'each' ? 1.3 : sp.mv === 'ring' ? 1.05 : 1.1) : sp.s === 'proj' ? 0.78 : 0.9);
    if (f.tier === 'boss') w += 0.06;
    if (f.enraged) w *= TUNE.enrageWind;
    return w;
  }
  function foeSteer(f, vx, vz, dt) { const k = 1 - Math.exp(-10 * dt); f.vel.x += (vx - f.vel.x) * k; f.vel.z += (vz - f.vel.z) * k; }
  function foeMove(f, tx, tz, speed, dt, faceX, faceZ) {
    const dx = tx - f.pos.x, dz = tz - f.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.15) foeSteer(f, 0, 0, dt);
    else { const s = Math.min(speed, l * 4); foeSteer(f, dx / l * s, dz / l * s, dt); }
    if (faceX != null) f.facing = U.dampAngle(f.facing, U.yawTo(faceX - f.pos.x, faceZ - f.pos.z), 8, dt);
    else if (l > 0.3) f.facing = U.dampAngle(f.facing, Math.atan2(dx, dz), 8, dt);
  }
  const speedOfFoe = (f) => f.speedBase * (f.status.weak ? 0.88 : 1) * (f.enraged ? TUNE.enrageSpeed : 1) * (f.tier === 'boss' ? 1.05 : 1);
  function idleStep(f, e, dt) {
    const ai = f.ai;
    const d = U.dist2(f.pos.x, f.pos.z, f.post.x, f.post.z);
    if (d > 6) { foeMove(f, f.post.x, f.post.z, speedOfFoe(f) * 0.7, dt); return; }
    // living idle: beasts sniff about, the rest shift their weight and look around
    ai.wanderT -= dt;
    if (ai.wanderT <= 0) {
      ai.wanderT = AB.rand.float(2.5, 6);
      const r = f.pack || f.float ? AB.rand.float(0.5, 3.2) : AB.rand.float(0, 1.2);
      const a = AB.rand.float(0, U.TAU);
      ai.wx = f.post.x + Math.sin(a) * r; ai.wz = f.post.z + Math.cos(a) * r;
    }
    const wd = U.dist2(f.pos.x, f.pos.z, ai.wx, ai.wz);
    if (wd > 0.3) foeMove(f, ai.wx, ai.wz, speedOfFoe(f) * (f.pack ? 0.35 : 0.22), dt);
    else { foeSteer(f, 0, 0, dt); f.facing = U.dampAngle(f.facing, e.yaw + Math.sin(time * 0.3 + f.uid) * 0.6, 1.5, dt); }
  }
  // waiting for a token / cooldown: melee circle their target at a slot, packs drift behind it, ranged keep their distance
  function positionStep(f, e, t, sp, dt) {
    const ai = f.ai, spd = speedOfFoe(f);
    const d = dist(f, t);
    ai.orbitT -= dt;
    if (ai.orbitT <= 0) { ai.orbitT = AB.rand.float(1.4, 3.2); ai.orbit = AB.rand.chance(0.5) ? 1 : -1; }
    if (f.ranged && !(sp.s === 'melee')) {
      const want = clamp(f.ranged * 0.7, 6.5, 10);
      let nx = 1e9, nh = null;
      for (const u of heroes) { const du = dist(f, u); if (du < nx) { nx = du; nh = u; } }
      // kite: back away from the closest hero for a short burst (budgeted, bending toward the post), then stand
      if (ai.kiteT > 0) ai.kiteT -= dt; else if (ai.kiteT > -3) ai.kiteT -= dt; else ai.kiteT = 1.4;
      if (nh && nx < 4.5 && ai.kiteT > 0) {
        let ax = f.pos.x - nh.pos.x, az = f.pos.z - nh.pos.z; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
        const px = f.post.x - f.pos.x, pz = f.post.z - f.pos.z, pl = Math.hypot(px, pz);
        if (pl > 8) { ax += px / pl * 0.8; az += pz / pl * 0.8; }
        foeMove(f, f.pos.x + (ax + az * 0.5 * ai.orbit) * 3, f.pos.z + (az - ax * 0.5 * ai.orbit) * 3, spd * 0.9, dt, t.pos.x, t.pos.z);
        return;
      }
      if (nh && nx < 4.5) { foeSteer(f, 0, 0, dt); f.facing = U.dampAngle(f.facing, U.yawTo(nh.pos.x - f.pos.x, nh.pos.z - f.pos.z), 8, dt); return; }
      const ang = U.yawTo(f.pos.x - t.pos.x, f.pos.z - t.pos.z) + ai.orbit * 0.35;
      foeMove(f, t.pos.x + Math.sin(ang) * want, t.pos.z + Math.cos(ang) * want, d > want + 3 ? spd : spd * 0.45, dt, t.pos.x, t.pos.z);
      return;
    }
    const R = Math.max(f.reach + t.radius + 1.6, 3.2 + f.radius);
    let ang;
    if (f.pack) ang = t.facing + PI + ai.slot * 0.95 + Math.sin(time * 0.7 + f.uid) * 0.25;   // flank from behind the hero
    else ang = U.yawTo(f.pos.x - t.pos.x, f.pos.z - t.pos.z) + ai.orbit * 0.55;
    const tx = t.pos.x + Math.sin(ang) * R, tz = t.pos.z + Math.cos(ang) * R;
    foeMove(f, tx, tz, d > R + 4 ? spd : spd * 0.55, dt, t.pos.x, t.pos.z);
  }
  const IDLE_SPEC = { s: 'cast', mv: null, offensive: false };
  function foeStep(f, e, dt) {
    if (!f.alive) { f.vel.set(0, 0, 0); return; }
    if (frozen) return;
    if (f.spawnT > 0) { f.spawnT -= dt; f.vel.set(0, 0, 0); f.pos.y = groundY(f); return; }
    if (f.invuln > 0) f.invuln -= dt;
    if (f.hitStop > 0) { f.hitStop -= dt; return; }
    const ai = f.ai;
    if (f.status.stun || f.staggerT > 0) { if (f.staggerT > 0) f.staggerT -= dt; foeSteer(f, 0, 0, dt); integrate(f, dt); return; }
    if (!e.engaged) { idleStep(f, e, dt); integrate(f, dt); return; }
    if (ai.alertT > 0) {
      ai.alertT -= dt; foeSteer(f, 0, 0, dt);
      const h = nearestHero(f, 60); if (h) f.facing = U.dampAngle(f.facing, U.yawTo(h.pos.x - f.pos.x, h.pos.z - f.pos.z), 6, dt);
      integrate(f, dt); return;
    }
    if (f.atk) { atkStep(f, e, dt); integrate(f, dt); return; }
    if (f.recover > 0) {
      f.recover -= dt;
      const t = byUid(f.tgt);
      if (t && !f.ranged && dist(f, t) < f.reach + 1.2) { const ax = f.pos.x - t.pos.x, az = f.pos.z - t.pos.z, l = Math.hypot(ax, az) || 1; foeSteer(f, ax / l * 1.6, az / l * 1.6, dt); }
      else foeSteer(f, 0, 0, dt);
      integrate(f, dt); return;
    }
    if (f.cd > 0) f.cd -= dt;
    // aggro: re-evaluate the target now and then (taunt forces it)
    ai.retT -= dt;
    let t = byUid(f.tgt);
    if (!isActive(t) || t.status.hidden || ai.retT <= 0 || (t && !t.status.taunt && tauntTarget(f))) {
      ai.retT = TUNE.retarget + AB.rand.float(0, 0.6);
      for (const k in f.aggro) f.aggro[k] *= 0.85;
      const n = aggroTarget(f); f.tgt = n ? n.uid : 0; t = n;
    }
    // leash to the post: wandered too far and nobody near -> walk back
    if (!t || (U.dist2(f.pos.x, f.pos.z, f.post.x, f.post.z) > TUNE.postLeash && dist(f, t) > 14)) {
      foeMove(f, f.post.x, f.post.z, speedOfFoe(f) * 0.8, dt); ai.commit = false; integrate(f, dt); return;
    }
    if (!f.next) {
      f.next = chooseIntent(f);
      if (!f.next) { f.cd = Math.max(f.cd, 0.6); positionStep(f, e, t, IDLE_SPEC, dt); integrate(f, dt); return; }
    }
    const it = f.next, sp = intentSpec(f, it);
    if (sp.offensive) {
      if (!ai.commit && f.cd <= 0 && tokenFree(e, f)) {
        const at = sp.single ? pickFor(f, sp.pick) : t;
        if (at) { ai.commit = true; ai.commitT = 0; ai.atkTgt = at.uid; }
      }
      if (ai.commit) {
        ai.commitT += dt;
        let at = byUid(ai.atkTgt);
        if (!isActive(at) || (sp.single && at.status.hidden)) { at = sp.single ? pickFor(f, sp.pick) : t; ai.atkTgt = at ? at.uid : 0; }
        if (!at) { ai.commit = false; integrate(f, dt); return; }
        let want = engageRange(f, sp, at), d = dist(f, at);
        // the chosen prey keeps running: settle for whoever is closer (taunt still binds)
        if (ai.commitT > 1.6 && d > want + 4 && !at.status.taunt) {
          const n = nearestHero(f, d - 3);
          if (n && !n.status.hidden) { at = n; ai.atkTgt = n.uid; want = engageRange(f, sp, at); d = dist(f, at); }
        }
        if (d <= want && (sp.mv !== 'pounce' || d > 2.5)) startIntent(f, it, sp, at);
        else if (ai.commitT > 3.5) { ai.commit = false; f.cd = 0.3; f.next = null; }   // give up: next intent in the cycle
        else if (sp.mv === 'pounce' && d <= 2.5) foeMove(f, f.pos.x * 2 - at.pos.x, f.pos.z * 2 - at.pos.z, speedOfFoe(f), dt, at.pos.x, at.pos.z);
        else foeMove(f, at.pos.x, at.pos.z, speedOfFoe(f) * (f.tier === 'normal' ? 1.05 : d > 7 ? 1.4 : 1.1), dt);   // big ones lumber faster when prey runs
      } else positionStep(f, e, t, sp, dt);
    } else {
      // casts (summons, whispers, heals, guards): any time a hero is within reach of the voice
      if (f.cd <= 0 && dist(f, t) < 16) startIntent(f, it, sp, (sp.pick ? pickFor(f, sp.pick) : null) || t);
      else positionStep(f, e, t, sp, dt);
    }
    integrate(f, dt);
  }
  function startIntent(f, intent, sp, t) {
    const w = windupOf(f, sp);
    const tierR = f.tier === 'boss' ? 1.3 : f.tier === 'elite' ? 1.15 : 1;
    const a = { intent, shape: sp.s, sp, t: 0, windup: w, target: t.uid, x: t.pos.x, z: t.pos.z, radius: 0, threat: null, threats: null,
      phase: 'wind', st: 0, sdur: 0, sx: 0, sz: 0, hitSet: null };
    f.atk = a; f.next = null; f.tgt = t.uid; f.ai.commit = true;
    const mv = sp.mv;
    let strike = 0;
    if (mv === 'lunge') strike = 0.22; else if (mv === 'pounce') strike = 0.42; else if (mv === 'charge') strike = (sp.reach || 9) / 15;
    a.sdur = strike;
    if (sp.s === 'melee' || mv === 'swarm' || mv === 'emerge') {
      a.radius = sp.rAbs ? sp.r : (sp.r || (mv === 'cone' ? 2.3 : TUNE.meleeThreatR)) * tierR;
      if (mv === 'cone') a.threats = coneThreats(f, a, t);
      else if (mv === 'charge') a.threats = chargeThreats(f, a, t);
      else a.threat = addThreat(f, 'melee', a.x, a.z, a.radius, w + strike);
      if (mv === 'emerge' || mv === 'swarm') a.threat.kind = 'aoe';
      if (mv === 'emerge') f.sub = true;
    } else if (sp.s === 'aoe') {
      a.radius = sp.rAbs ? sp.r : (sp.r || TUNE.aoeThreatR) * (mv === 'each' ? 1 : tierR) * (mv === 'self' ? Math.sqrt(f.scale) : 1);
      if (mv === 'each') { a.threats = []; for (const u of heroes) a.threats.push(addThreat(f, 'aoe', u.pos.x, u.pos.z, a.radius, w)); }
      else if (mv === 'cone') a.threats = coneThreats(f, a, t);
      else { a.x = f.pos.x; a.z = f.pos.z; a.threat = addThreat(f, 'aoe', a.x, a.z, a.radius, w); }
    }
    emit('unit:action', { unit: f, slot: 'intent', ability: intent.id, intent, shape: sp.s === 'aoe' && mv === 'swarm' ? 'aoe' : sp.s, target: t, phase: 'start', windup: w });
  }
  function coneThreats(f, a, t) {
    const yaw = U.yawTo(t.pos.x - f.pos.x, t.pos.z - f.pos.z), out = [];
    f.facing = yaw;
    for (let k = 1; k <= 3; k++) { const r = a.radius * (0.75 + k * 0.2), dd = f.radius + r * 0.9 + (k - 1) * r * 1.3; out.push(addThreat(f, 'melee', f.pos.x + Math.sin(yaw) * dd, f.pos.z + Math.cos(yaw) * dd, r, a.windup)); }
    a.yaw = yaw;
    return out;
  }
  function chargeThreats(f, a, t) {
    const yaw = U.yawTo(t.pos.x - f.pos.x, t.pos.z - f.pos.z), out = [], L = a.sp.reach || 9;
    a.yaw = yaw; a.sx = f.pos.x; a.sz = f.pos.z;
    for (let k = 1; k <= 4; k++) { const dd = L * k / 4; out.push(addThreat(f, 'melee', f.pos.x + Math.sin(yaw) * dd, f.pos.z + Math.cos(yaw) * dd, a.radius, a.windup + a.sdur * k / 4)); }
    return out;
  }
  function atkStep(f, e, dt) {
    const a = f.atk, sp = a.sp, mv = sp.mv;
    if (a.phase === 'wind') {
      a.t += dt;
      const t = byUid(a.target);
      const tracks = sp.s === 'melee' || mv === 'swarm' || mv === 'emerge' || mv === 'pounce';
      if (tracks && mv !== 'cone' && mv !== 'charge' && a.t < a.windup * TUNE.aimLock && isActive(t) && !(sp.single && t.status.hidden)) {
        // melee marks follow the hero until the last 40% of the wind-up, then commit (that is the dodge window)
        let tx = t.pos.x, tz = t.pos.z;
        if (sp.s === 'melee' && !mv) { const d = dist(f, t), mx = f.reach + (sp.reach || 0) * 0.3 + t.radius + 0.6; if (d > mx) { tx = f.pos.x + (t.pos.x - f.pos.x) / d * mx; tz = f.pos.z + (t.pos.z - f.pos.z) / d * mx; } }
        a.x = tx; a.z = tz; if (a.threat) { a.threat.x = a.x; a.threat.z = a.z; }
      }
      if (mv === 'each' && a.threats && a.t < a.windup * 0.4) { let i = 0; for (const u of heroes) { const th = a.threats[i++]; if (th) { th.x = u.pos.x; th.z = u.pos.z; } } }
      if (mv !== 'cone' && mv !== 'charge') f.facing = U.dampAngle(f.facing, U.yawTo(a.x - f.pos.x, a.z - f.pos.z), 10, dt);
      if (mv === 'swarm') foeMove(f, a.x, a.z, speedOfFoe(f) * 0.9, dt);   // the cloud drifts onto its prey
      else foeSteer(f, 0, 0, dt);
      const left = Math.max(0, a.windup - a.t);
      if (a.threat) a.threat.left = left + a.sdur;
      if (a.threats) for (const th of a.threats) th.left = Math.max(0, th.total - a.t);
      if (a.t >= a.windup) release(f, a);
      return;
    }
    // strike phase (lunge, pounce, charge)
    a.st += dt;
    const k = Math.min(1, a.st / Math.max(0.01, a.sdur));
    if (mv === 'charge') {
      const L = sp.reach || 9, v = L / Math.max(0.05, a.sdur);
      f.vel.set(Math.sin(a.yaw) * v, 0, Math.cos(a.yaw) * v);
      for (const u of heroes) {
        if (a.hitSet && a.hitSet.includes(u.uid)) continue;
        if (dist(f, u) < a.radius + u.radius) {
          (a.hitSet || (a.hitSet = [])).push(u.uid);
          if (u.iframes > 0) { dodged(u, f); continue; }
          strikeVictims(f, a, [u]);
        }
      }
      if (a.threats) for (const th of a.threats) th.left = Math.max(0, th.total - a.windup - a.st);
    } else {
      // lunge / pounce: travel from the start point to the mark
      const ex = a.sx + (a.x - a.sx) * k, ez = a.sz + (a.z - a.sz) * k;
      f.vel.set((ex - f.pos.x) / Math.max(dt, 1e-3), 0, (ez - f.pos.z) / Math.max(dt, 1e-3));
      if (a.threat) a.threat.left = Math.max(0, a.sdur - a.st);
    }
    if (a.st >= a.sdur) {
      f.vel.set(0, 0, 0);
      if (mv !== 'charge') impact(f, a);
      endAttack(f, a);
    }
  }
  function release(f, a) {
    const sp = a.sp, mv = sp.mv;
    if (sp.offensive && f.enc && f.enc.tel) f.enc.tel.atks = (f.enc.tel.atks || 0) + 1;
    emit('unit:action', { unit: f, slot: 'intent', ability: a.intent.id, intent: a.intent, shape: sp.s, target: byUid(a.target), phase: 'release' });
    if (sp.s === 'proj') { fireFoeProjectile(f, a); endAttack(f, a); return; }
    if (mv === 'lunge' || mv === 'pounce' || mv === 'charge') {
      a.phase = 'strike'; a.st = 0;
      if (mv !== 'charge') {
        a.sx = f.pos.x; a.sz = f.pos.z;
        // the lunge stops a body-length short of the mark centre
        const dx = a.x - f.pos.x, dz = a.z - f.pos.z, d = Math.hypot(dx, dz) || 1;
        const stop = mv === 'pounce' ? f.radius * 0.5 : f.radius + 0.5;
        const L = Math.max(0, Math.min(d - stop, mv === 'lunge' ? (sp.dash || 2.5) + f.reach : 12));
        a.x = f.pos.x + dx / d * L; a.z = f.pos.z + dz / d * L;
        // the threat ring stays where it was drawn (that is where the bite lands)
        a.hx = f.pos.x + dx / d * Math.min(d, L + stop); a.hz = f.pos.z + dz / d * Math.min(d, L + stop);
        if (a.threat) { a.threat.x = a.hx; a.threat.z = a.hz; }
      } else { a.sx = f.pos.x; a.sz = f.pos.z; }
      return;
    }
    if (mv === 'emerge') { f.pos.x = a.x; f.pos.z = a.z; f.sub = false; }
    impact(f, a);
    endAttack(f, a);
  }
  // resolve a melee/aoe blow: who stands in the marks when it lands
  function impact(f, a) {
    const sp = a.sp, mv = sp.mv;
    scratch.length = 0;
    const list = a.threats || (a.threat ? [a.threat] : null);
    if (!list && sp.s === 'cast') {
      const ctx = { src: f, side: 'foe', kind: 'intent', intent: a.intent, target: byUid(a.target), victims: [], allVictims: null };
      const t = ctx.target;
      if (isActive(t) && dist(f, t) < 24) ctx.victims.push(t);
      ctx.allVictims = heroes.filter((u) => dist(f, u) < 16);
      applyEffects(a.intent.effects, ctx);
      return;
    }
    for (const u of heroes) {
      let inside = false;
      if (list) { for (const th of list) if (U.dist2(u.pos.x, u.pos.z, th.x, th.z) <= th.radius + u.radius) { inside = true; break; } }
      if (!inside) continue;
      if (sp.single && u.status.hidden) continue;
      if (u.iframes > 0) { dodged(u, f); continue; }
      scratch.push(u);
    }
    strikeVictims(f, a, scratch.slice());
  }
  function strikeVictims(f, a, victims) {
    const sp = a.sp;
    const ctx = { src: f, side: 'foe', kind: 'intent', intent: a.intent, target: byUid(a.target), victims, allVictims: victims, attack: true };
    applyEffects(a.intent.effects, ctx);
    for (const v of victims) {
      if (!v.alive || v.downed) continue;
      if (sp.mv === 'hook') { knock(v, v.pos.x * 2 - f.pos.x, v.pos.z * 2 - f.pos.z, Math.min(9, Math.max(0, dist(f, v) - f.reach) * 3.5)); }
      else knock(v, f.pos.x, f.pos.z, sp.kb);
      f.hitStop = Math.max(f.hitStop, 0.05);
    }
  }
  function impactArea(f, it, sp, x, z, r) {
    scratch.length = 0;
    for (const u of heroes) { if (U.dist2(u.pos.x, u.pos.z, x, z) > r + u.radius) continue; if (u.iframes > 0) { dodged(u, f); continue; } scratch.push(u); }
    const victims = scratch.slice();
    applyEffects(it.effects, { src: f, side: 'foe', kind: 'intent', intent: it, target: victims[0] || null, victims, allVictims: victims, attack: true });
    for (const v of victims) knock(v, x, z, sp.kb || 5);
    emit('combat:area', { unit: f, x, z, radius: r, ability: it.id });
  }
  function endAttack(f, a) {
    if (a.threat) removeThreat(a.threat);
    if (a.threats) for (const th of a.threats) removeThreat(th);
    a.threat = null; a.threats = null;
    if (f.atk === a) f.atk = null;
    f.sub = false;
    const tier = f.tier || 'normal';
    const R = TUNE.recover[tier] || TUNE.recover.normal, D = TUNE.atkCd[tier] || TUNE.atkCd.normal;
    f.recover = AB.rand.float(R[0], R[1]) * (a.sp.hv ? 1.3 : 1);   // heavy swings leave a longer opening
    f.cd = AB.rand.float(D[0], D[1]) * (f.enraged ? TUNE.enrageCd : f.phase > 0 ? 0.8 : 1);
    f.ai.commit = false;
  }

  // =====================================================================================================
  // 9. HERO MOVEMENT, DODGE, LOCK-ON, PLAYER INPUT
  // =====================================================================================================
  function steerAccel(u, vx, vz, dt) {
    const dx = vx - u.vel.x, dz = vz - u.vel.z, l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const speeding = vx * vx + vz * vz > u.vel.x * u.vel.x + u.vel.z * u.vel.z;
    const m = (speeding ? TUNE.accel : TUNE.decel) * dt;
    if (l <= m) { u.vel.x = vx; u.vel.z = vz; } else { u.vel.x += dx / l * m; u.vel.z += dz / l * m; }
  }
  function integrate(u, dt) {
    let kx = 0, kz = 0;
    if (u.kb.x !== 0 || u.kb.z !== 0) {
      kx = u.kb.x; kz = u.kb.z;
      const k = Math.exp(-7 * dt);
      u.kb.x *= k; u.kb.z *= k;
      if (u.kb.x * u.kb.x + u.kb.z * u.kb.z < 0.01) u.kb.set(0, 0, 0);
    }
    u.pos.x += (u.vel.x + kx) * dt; u.pos.z += (u.vel.z + kz) * dt;
    AB.world.constrain(u.pos, u.radius);
    u.pos.y = groundY(u);
  }
  const speedOf = (u) => (u.id === BEARER_ID ? TUNE.bearerSpeed : TUNE.heroSpeed) * (u.status.weak ? 0.92 : 1);
  function startDodge(u, dx, dz) {
    const l = Math.hypot(dx, dz) || 1;
    u.dodgeDir.set(dx / l, 0, dz / l);
    u.dodgeT = TUNE.dodgeDur; u.iframes = Math.max(u.iframes, TUNE.iframes); u.dodgeCd = TUNE.dodgeDur + TUNE.dodgeRecover; u.dodgeAge = 0;
    if (u.action && (!u.action.fired || u.action.t > u.action.hitAt)) u.action = null;   // rolls cancel wind-ups and recoveries
    u.staggerT = 0;
    u.facing = Math.atan2(u.dodgeDir.x, u.dodgeDir.z);
    emit('dodge', { unit: u });
  }
  function dodgeStep(u, dt) {
    const tau = 1 - u.dodgeT / TUNE.dodgeDur;
    const v = TUNE.dodgeDist / TUNE.dodgeDur * 1.5 * Math.sqrt(Math.max(0, 1 - tau));   // fast out, ease in; integrates to dodgeDist
    u.dodgeT -= dt;
    u.vel.set(u.dodgeDir.x * v, 0, u.dodgeDir.z * v);
    if (u.dodgeT <= 0) { u.vel.multiplyScalar(0.35); u.dodgeT = 0; }
  }
  function updateSoftTarget(u) {
    const lk = byUid(lockUid);
    if (lk && (!lk.alive || dist(u, lk) > 32)) { lockUid = 0; emit('lock', { unit: null }); }
    if (!inCombat) { softUid = 0; return; }
    const kit = kitOf(u);
    const f = chooseFoeTarget(u, Math.max(kit.ranged || 0, 9));
    softUid = f ? f.uid : 0;
  }
  function playerControl(u, dt) {
    const inp = AB.input;
    updateSoftTarget(u);
    const mx = inp.moveWorld.x, mz = inp.moveWorld.z, mag = Math.hypot(mx, mz);
    const stunned = !!u.status.stun || u.staggerT > 0;
    if (!stunned && inp.pressed('dodge') && u.dodgeCd <= 0) {
      if (mag > 0.1) startDodge(u, mx, mz);
      else if (inCombat) startDodge(u, -fwdX(u.facing), -fwdZ(u.facing));   // no direction in a fight: hop back
      else startDodge(u, fwdX(u.facing), fwdZ(u.facing));
      return;
    }
    const sprint = !inCombat && inp.held('sprint') && !u.action ? TUNE.sprintMul : 1;
    const sp = stunned ? 0 : speedOf(u) * sprint * (u.action ? TUNE.actionSlow : 1);
    const lunging = u.action && !u.action.fired && u.action.target && (Math.abs(u.vel.x) + Math.abs(u.vel.z) > 0.1);
    if (!lunging) steerAccel(u, mx * sp, mz * sp, dt);
    if (mag > 0.1 && !stunned && (!u.action || (!u.action.fired && !u.action.target))) u.facing = U.dampAngle(u.facing, Math.atan2(mx, mz), u.action ? 10 : 14, dt);
    if (stunned) return;
    if (inp.pressed('target')) cycleLock(u);
    // input buffer: a press during another action fires as soon as it can (within TUNE.inputBuffer s)
    for (let i = 0; i < 4; i++) { const slot = IN_SLOTS[i]; if (inp.pressed(slot)) { inBuf.slot = slot; inBuf.t = TUNE.inputBuffer; } }
    if (inBuf.t > 0) {
      inBuf.t -= dt;
      const slot = inBuf.slot;
      if (slot === 'ember' && !(u.slots && u.slots.ember)) { inBuf.t = 0; if (game().quickItem) game().quickItem(); }
      else if (tryAbility(u, slot)) inBuf.t = 0;
    } else if (inp.held('attack')) tryAbility(u, 'attack');
  }
  function cycleLock(u) {
    const list = units.filter((f) => isFoe(f) && dist(u, f) < 30).sort((a, b) => dist(u, a) - dist(u, b));
    if (!list.length) { lockUid = 0; emit('lock', { unit: null }); return; }
    const i = list.findIndex((f) => f.uid === lockUid);
    lockUid = i === list.length - 1 ? 0 : list[i + 1].uid;   // the cycle ends on "no lock"
    emit('lock', { unit: byUid(lockUid) });
  }

  // =====================================================================================================
  // 10. COMPANION AI (per role) + THE BOT PILOT
  // =====================================================================================================
  function nearestHero(f, r) { let best = null, bd = r; for (const u of heroes) { const d = dist(f, u); if (d < bd) { bd = d; best = u; } } return best; }
  function engagedFoeNear(u, r) {
    let best = null, bd = r;
    for (const f of units) { if (!isFoe(f) || f.sub || !f.enc || !f.enc.engaged) continue; const d = dist(u, f); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  function moveTo(u, x, z, stop, dt, speed) {
    const dx = x - u.pos.x, dz = z - u.pos.z, l = Math.hypot(dx, dz);
    if (l <= stop) { steerAccel(u, 0, 0, dt); return true; }
    const sp = Math.min(speed || speedOf(u), Math.max(1.4, (l - stop) * 3));
    let vx = dx / l * sp, vz = dz / l * sp;
    // steer around active danger marks on the way
    for (const th of threats) {
      if (th.side !== 'foe') continue;
      const ex = u.pos.x + vx * 0.4 - th.x, ez = u.pos.z + vz * 0.4 - th.z, el = Math.hypot(ex, ez), rr = th.radius + u.radius + 0.4;
      if (el < rr && el > 1e-3 && U.dist2(x, z, th.x, th.z) > th.radius) { vx += ex / el * sp * 0.9; vz += ez / el * sp * 0.9; }
    }
    steerAccel(u, vx, vz, dt);
    if (!u.action) u.facing = U.dampAngle(u.facing, Math.atan2(vx, vz), 10, dt);
    return false;
  }
  // a mark (or an incoming bolt) about to land on u: roll or walk out
  function avoidThreats(u, dt, pilot) {
    // a mark is noticed when walking out is still just possible (big rings early, small marks late)
    const sp0 = speedOf(u);
    let th = null, best = 9;
    for (const t of threats) {
      if (t.side !== 'foe') continue;
      const d = U.dist2(u.pos.x, u.pos.z, t.x, t.z), out = t.radius + u.radius + 0.3 - d;
      if (out <= 0) continue;
      const notice = t.kind === 'melee' ? (pilot ? 0.6 : TUNE.aiReact) : Math.min(1.6, out / sp0 + (pilot ? 0.45 : 0.3));
      if (t.left > notice) continue;
      if (t.left < best) { best = t.left; th = t; }
    }
    if (!th) return false;
    if (u.ai.th !== th.id) {
      u.ai.th = th.id;
      const base = th.kind === 'melee' ? TUNE.aiDodgeChance : TUNE.aiAoeChance;
      const ch = pilot ? TUNE.botDodgeChance : u.role === 'tank' ? base * 0.75 : base;
      u.ai.react = AB.rand.chance(ch);
    }
    if (!u.ai.react || (u.action && u.action.fired === false && u.action.slot !== 'attack' && th.left > 0.25)) return false;
    let dx = u.pos.x - th.x, dz = u.pos.z - th.z, l = Math.hypot(dx, dz);
    const src = byUid(th.src);
    if (l < 0.3) { // centred on us: roll sideways relative to the attacker
      const yaw = src ? U.yawTo(u.pos.x - src.pos.x, u.pos.z - src.pos.z) : u.facing;
      const side = (u.uid & 1) ? 1 : -1;
      dx = Math.cos(yaw) * side; dz = -Math.sin(yaw) * side; l = 1;
    }
    if (th.left < 0.34 && u.dodgeCd <= 0 && !u.status.stun) { startDodge(u, dx / l, dz / l); return true; }
    const sp = speedOf(u);
    steerAccel(u, dx / l * sp, dz / l * sp, dt);
    if (!u.action) u.facing = U.dampAngle(u.facing, Math.atan2(dx, dz), 12, dt);
    return true;
  }
  function reviveTarget(u) {
    let down = null, dd = 30;
    for (const h of units) if (h.kind === 'hero' && h.spawned && h.alive && h.downed && h !== u) { const d = dist(u, h); if (d < dd) { dd = d; down = h; } }
    if (!down) return null;
    if (u.role === 'healer' || down.id === BEARER_ID) return down;
    // the closest standing companion goes; others keep fighting unless the spot is quiet
    let closer = 0;
    for (const h of heroes) if (h !== u && h !== controlled && dist(h, down) < dd - 0.5) closer++;
    if (closer === 0) return down;
    return countFoesNear(down.pos.x, down.pos.z, 3) === 0 && closer < 2 ? down : null;
  }
  function roleTarget(u) {
    const w = heroByID(BEARER_ID);
    let best = null, bs = 1e9;
    for (const f of units) {
      if (!isFoe(f) || f.sub || f.spawnT > 0 || !f.enc || !f.enc.engaged) continue;
      const d = dist(u, f); if (d > 34) continue;
      let s = d;
      switch (u.role) {
        case 'tank': s = (w ? dist(w, f) : d) * 0.8 + d * 0.4 - (f.tgt && f.tgt !== u.uid ? 4 : 0) - (f.tier !== 'normal' ? 2 : 0); break;
        case 'rogue': s = d * 0.7 - (f.tgt !== u.uid ? 3 : 0) - (f.status.mark || f.status.stun || f.staggerT > 0 ? 5 : 0) - (1 - hpFrac(f)) * 4; break;
        case 'archer': s = d * 0.4 - (f.atk ? 4 : 0) - (1 - hpFrac(f)) * 6 - (w && f.tgt === w.uid ? 3 : 0); break;
        case 'melee': s = d - (f.uid === lockUid || f.uid === softUid ? 4 : 0) - (f.status.mark ? 3 : 0); break;
        default: s = d - (w && f.tgt === w.uid ? 3 : 0); break;
      }
      if (u.role !== 'tank' && f.drainer) s -= 4;               // voices that drain Hope / feed the Emberheart / call kin go first
      if (f.atk && f.atk.phase === 'wind' && f.atk.sp.res && f.tier === 'normal') s -= 3;   // break the chant
      if (u.ai.mode === 'fight' && f.uid === u.tgt) s -= 2.5;   // stick with a target for a while
      if (s < bs) { bs = s; best = f; }
    }
    return best;
  }
  function heroByID(id) { for (const h of heroes) if (h.id === id) return h; return null; }
  function foesTargeting(u) { let n = 0; for (const f of units) if (isFoe(f) && f.enc && f.enc.engaged && (f.tgt === u.uid || (f.atk && f.atk.target === u.uid))) n++; return n; }
  function emberWanted(u) {
    const r = AB.state && AB.state.run; if (!r) return false;
    if (r.corruption >= TUNE.botEmberCorr) return false;
    const boss = encs.some((e) => e.engaged && e.kind === 'boss');
    const n = countFoesNear(u.pos.x, u.pos.z, TUNE.emberR - 1);
    if (u.ai.emberUses >= 1) return false;
    let down = false; for (const h of units) if (h.kind === 'hero' && h.downed && h.spawned) down = true;
    return (boss && n >= 2 && r.corruption < TUNE.botEmberCorr - 6) || (n >= 3 && (hpFrac(u) < 0.5 || down));
  }
  // returns [slot, target] or null: role-aware use of skill1/skill2 (and the Emberheart for the bot pilot)
  const AI_SLOTS = ['skill1', 'skill2', 'ember'], IN_SLOTS = ['attack', 'skill1', 'skill2', 'ember'];
  const aiFlagCache = new WeakMap();
  function aiFlags(ab) {   // what an ability is good for (cached per content ability: no per-step closures)
    let f = aiFlagCache.get(ab); if (f) return f;
    const eff = ab.effects || [];
    const has = (type, tgt, status) => eff.some((e) => e.type === type && (!tgt || e.target === tgt) && (!status || e.status === status));
    f = { healFriend: has('heal', 'friend'), healAll: has('heal', 'all_friends') || has('cleanse'), hidden: has('status', 'self', 'hidden'), taunt: has('status', 'self', 'taunt'),
      guardAll: has('status', 'all_friends', 'guard'), empowerAll: has('status', 'all_friends', 'empower'), stun: has('status', 'foe', 'stun'), mark: has('status', 'foe', 'mark'),
      cond: eff.some((e) => e.ifTargetHas) };
    aiFlagCache.set(ab, f);
    return f;
  }
  const aiPick = [null, null];
  const pickOf = (slot, t) => { aiPick[0] = slot; aiPick[1] = t; return aiPick; };
  function aiSkill(u, foe, pilot) {
    const k = AI_SLOTS;
    for (let i = 0; i < k.length; i++) {
      const slot = k[i], ab = u.slots[slot];
      if (!ab || u.cds[slot] > 0) continue;
      if (slot === 'ember') { if (pilot && emberWanted(u)) { u.ai.emberUses++; return pickOf(slot, u); } continue; }
      const fl = aiFlags(ab);
      if (fl.healFriend) { const hurt = lowestAlly(u, TUNE.friendR); if (hurt && hpFrac(hurt) < (u.role === 'healer' ? 0.65 : 0.5)) return pickOf(slot, hurt); continue; }
      if (fl.healAll) {
        let hurt = 0, low = false, deb = 0;
        for (const h of heroes) { if (dist(u, h) > TUNE.partyR) continue; const p = hpFrac(h); if (p < 0.7) hurt++; if (p < 0.35) low = true; if (h.status.weak || h.status.mark || h.status.bleed || h.status.stun) deb++; }
        if (hurt >= 2 || deb >= 2 || (low && u.cds.skill1 > 0)) return pickOf(slot, u);
        continue;
      }
      if (fl.hidden) { if (hpFrac(u) < 0.35 && foesTargeting(u) > 0) return pickOf(slot, u); continue; }
      if (fl.taunt) {
        let pressed = 0;
        for (const f of units) if (isFoe(f) && f.enc && f.enc.engaged && f.tgt && f.tgt !== u.uid && dist(f, u) < 14) pressed++;
        if (pressed >= 1 && (pressed >= 2 || foe.tier !== 'normal' || hpFrac(u) > 0.5)) return pickOf(slot, u);
        continue;
      }
      if (fl.guardAll) {
        let inc = 0;
        for (const th of threats) if (th.side === 'foe' && th.left < 1.1) for (const h of heroes) if (U.dist2(h.pos.x, h.pos.z, th.x, th.z) < th.radius + 0.5) { inc++; break; }
        if (inc >= 2 || (inc >= 1 && encs.some((e) => e.engaged && e.kind !== 'battle'))) return pickOf(slot, u);
        continue;
      }
      if (fl.empowerAll) {
        let n = 0; for (const h of heroes) if (dist(u, h) < TUNE.partyR && !h.status.empower) n++;
        if (n >= 2 && countFoesNear(u.pos.x, u.pos.z, 20) >= 1) return pickOf(slot, u);
        continue;
      }
      const kd = kindOf(ab);
      if (kd.allFoes && ab.select !== 'foe') {
        const kit = kitOf(u);
        if (u.id === 'neve' || (kit.ranged && isRangedHero(u))) { if (foe && countFoesNear(foe.pos.x, foe.pos.z, TUNE.allFoesR) >= 2 && dist(u, foe) < (kit.ranged || 12) + 2) return pickOf(slot, foe); }
        else if (countFoesNear(u.pos.x, u.pos.z, TUNE.allFoesR - 1) >= 2) return pickOf(slot, foe);
        continue;
      }
      if (kd.volley) { if (countFoesNear(u.pos.x, u.pos.z, 14) >= 1) return pickOf(slot, foe || u); continue; }
      if (ab.select === 'foe') {
        let t = foe;
        if (fl.stun) { // interrupt: pin the foe that is winding up the biggest blow
          let bw = null, bv = 0;
          for (const f of units) if (isFoe(f) && f.atk && f.atk.phase === 'wind' && dist(u, f) < rangeOf(u, slot) + 2) { const v = (f.atk.sp.dmg || 5) + (f.atk.sp.hv ? 10 : 0) + (f.tier === 'normal' ? 0 : 6) + (f.atk.sp.res ? 12 : 0); if (v > bv) { bv = v; bw = f; } }
          if (bw) t = bw; else if (!(foe && foe.tier !== 'normal')) continue;
        }
        if (fl.mark) { // mark the biggest threat that is not marked yet
          let bm = null, bv = -1;
          for (const f of units) if (isFoe(f) && f.enc && f.enc.engaged && !f.status.mark && dist(u, f) < 14) { const v = f.hp + (f.tier === 'normal' ? 0 : 1e4); if (v > bv) { bv = v; bm = f; } }
          if (!bm) continue; t = bm;
        }
        if (fl.cond) { if (!t || !(t.status.mark || t.status.stun || t.staggerT > 0 || behind(u, t))) continue; }
        if (!t) continue;
        const kit = kitOf(u), r = kit.ranged ? kit.ranged : kit.reach + TUNE.gapCloser;
        if (dist(u, t) <= r + t.radius) return pickOf(slot, t);
        continue;
      }
      if (ab.select === 'none') return pickOf(slot, u);
    }
    return null;
  }
  function fightRole(u, foe, dt, pilot) {
    u.ai.mode = 'fight'; u.tgt = foe.uid;
    if (!u.action) { const sk = aiSkill(u, foe, pilot); if (sk && tryAbility(u, sk[0], sk[1])) return; }
    const kit = kitOf(u);
    const d = dist(u, foe);
    const range = rangeOf(u, 'attack');
    const ranged = !!kit.ranged && (u.role === 'archer' || u.role === 'bearer' || u.role === 'healer' || (u.role === 'support' && hpFrac(u) < 0.75));
    let tx = foe.pos.x, tz = foe.pos.z, stop = range * 0.75;
    if (ranged) {
      // keep the preferred distance from the CLOSEST foe, stay near the party, strafe a little
      let near = foe, nd = d, want = kit.prefer, slack = 2.5;
      for (const f of units) if (isFoe(f) && f.enc && f.enc.engaged && !f.sub) { const df = dist(u, f); if (df < nd) { nd = df; near = f; } }
      // the bearer stays out of a whisperer's 12 m reach (its Corruption needs her close) and slings from the edge
      if (u.id === BEARER_ID) {
        let wd = 13.5, wf = null;
        for (const f of units) if (isFoe(f) && f.whisper && f.enc && f.enc.engaged && !f.sub) { const df = dist(u, f); if (df < wd) { wd = df; wf = f; } }
        if (wf && (nd > 4 || wf === near)) { near = wf; nd = wd; want = 14; slack = 1.2; }
      }
      const anchor = heroByID('brakka') || (u === controlled ? null : controlled);
      if (nd < want - slack) {
        let ax = u.pos.x - near.pos.x, az = u.pos.z - near.pos.z; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
        if (anchor && anchor !== u && dist(u, anchor) > 6) { ax += (anchor.pos.x - u.pos.x) * 0.06; az += (anchor.pos.z - u.pos.z) * 0.06; }
        tx = u.pos.x + ax * 4 + az * 1.5 * u.ai.orbit; tz = u.pos.z + az * 4 - ax * 1.5 * u.ai.orbit; stop = 0.2;
        // never back off into the next group on the road, out of the fight's arena or away from the party: fall back
        // toward the party instead (circling the threat), or stand
        if (!kiteOK(u, foe, tx, tz)) {
          if (partyCentre(u, tmpV2)) { tx = tmpV2.x + az * 3 * u.ai.orbit; tz = tmpV2.z - ax * 3 * u.ai.orbit; stop = 2.5; } else { tx = u.pos.x; tz = u.pos.z; }
        }
      } else if (d > Math.min(range, want + 3)) { stop = Math.min(range, want + 2) * 0.9; }
      else {
        u.ai.strafeT -= dt;
        if (u.ai.strafeT <= 0) { u.ai.strafeT = AB.rand.float(1.2, 2.6); u.ai.orbit = AB.rand.chance(0.5) ? 1 : -1; }
        const ang = U.yawTo(u.pos.x - foe.pos.x, u.pos.z - foe.pos.z) + u.ai.orbit * 0.25;
        tx = foe.pos.x + Math.sin(ang) * d; tz = foe.pos.z + Math.cos(ang) * d; stop = 0.3;
      }
    } else if (u.role === 'tank') {
      // stand between the bearer and the foe that threatens her
      const w = heroByID(BEARER_ID);
      if (w && w !== u && dist(w, foe) < 12) { const ax = w.pos.x - foe.pos.x, az = w.pos.z - foe.pos.z, l = Math.hypot(ax, az) || 1; tx = foe.pos.x + ax / l * (kit.reach * 0.8 + foe.radius); tz = foe.pos.z + az / l * (kit.reach * 0.8 + foe.radius); stop = 0.4; }
    } else if (u.role === 'rogue' && foe.tgt !== u.uid) {
      // flank: get behind the foe while it is busy with someone else
      const bx = foe.pos.x - fwdX(foe.facing) * (kit.reach * 0.7 + foe.radius), bz = foe.pos.z - fwdZ(foe.facing) * (kit.reach * 0.7 + foe.radius);
      if (U.dist2(u.pos.x, u.pos.z, bx, bz) > 1.0 && d < 8) { tx = bx; tz = bz; stop = 0.35; }
    } else if (u.role === 'melee' || u.role === 'support') {
      const side = (u.uid & 1) ? 1 : -1, ang = U.yawTo(u.pos.x - foe.pos.x, u.pos.z - foe.pos.z) + side * 0.4;
      if (d < range + 1.5) { tx = foe.pos.x + Math.sin(ang) * (kit.reach * 0.8 + foe.radius); tz = foe.pos.z + Math.cos(ang) * (kit.reach * 0.8 + foe.radius); stop = 0.3; }
    }
    if (!u.action || u.action.fired) moveTo(u, tx, tz, stop, dt, speedOf(u) * (pilot ? 1 : 0.95));
    else steerAccel(u, 0, 0, dt);
    if (!u.action) u.facing = U.dampAngle(u.facing, U.yawTo(foe.pos.x - u.pos.x, foe.pos.z - u.pos.z), 12, dt);
    if (!u.action && d <= range + foe.radius) tryAbility(u, 'attack', foe);
  }
  function followStep(u, dt) {
    u.ai.mode = 'follow';
    const lead = controlled && controlled !== u && isActive(controlled) ? controlled : null;
    if (!lead) { steerAccel(u, 0, 0, dt); return; }
    let idx = 1;
    for (const m of party()) { if (m === u) break; if (m.spawned && m.alive && !m.left && m !== lead) idx++; }
    const p = formationPoint(idx, lead.pos.x, lead.pos.z, lead.facing, tmpV2);
    const d = U.dist2(u.pos.x, u.pos.z, p.x, p.z);
    if (d > TUNE.teleportDist && !inCombat) { u.pos.set(p.x, 0, p.z); AB.world.constrain(u.pos, u.radius); u.pos.y = groundY(u); u.vel.set(0, 0, 0); return; }
    // never block the player: step aside when standing in the lead's path
    const lv = Math.hypot(lead.vel.x, lead.vel.z);
    if (lv > 1) {
      const rx = u.pos.x - lead.pos.x, rz = u.pos.z - lead.pos.z, along = (rx * lead.vel.x + rz * lead.vel.z) / lv;
      if (along > 0 && along < 2.4) { const side = (rx * lead.vel.z - rz * lead.vel.x) / lv; if (Math.abs(side) < 1.1) { const s = side >= 0 ? 1 : -1; steerAccel(u, lead.vel.z / lv * s * speedOf(u), -lead.vel.x / lv * s * speedOf(u), dt); return; } }
    }
    moveTo(u, p.x, p.z, 0.5, dt, d > 6 ? TUNE.catchup : Math.max(speedOf(u), lv * 1.05));
  }
  function companionAI(u, dt, pilot) {
    if (u.status.stun || u.staggerT > 0) { steerAccel(u, 0, 0, dt); return; }
    if (inCombat && avoidThreats(u, dt, pilot)) return;
    const down = reviveTarget(u);
    if (down && (!pilot || dist(u, down) < 20)) {
      u.ai.mode = 'revive';
      if (!moveTo(u, down.pos.x, down.pos.z, 0.8, dt, TUNE.catchup)) return;
      // while kneeling by them, strike anything in reach
      const f = engagedFoeNear(u, rangeOf(u, 'attack') + 0.5);
      if (f && !u.action) { u.facing = U.yawTo(f.pos.x - u.pos.x, f.pos.z - u.pos.z); tryAbility(u, 'attack', f); }
      return;
    }
    if (inCombat) {
      // pilot: patch up when hurt and Fade when cornered
      const foe = roleTarget(u);
      if (foe) { fightRole(u, foe, dt, pilot); return; }
      const f = engagedFoeNear(u, 60);
      if (f) { u.ai.mode = 'close'; moveTo(u, f.pos.x, f.pos.z, rangeOf(u, 'attack') * 0.8, dt); return; }
    }
    if (pilot) { steerAccel(u, AB.input.moveWorld.x * speedOf(u), AB.input.moveWorld.z * speedOf(u), dt); return; }
    followStep(u, dt);
  }
  // the bot pilot (window.__ab.bot): in a fight the controlled hero thinks like a companion of its role, dodges better,
  // and Wren uses the Emberheart sparingly; out of a fight game.js steers it with AB.input.driveWorld
  function botPilot(u, dt) {
    updateSoftTarget(u);
    companionAI(u, dt, true);
  }

  function heroStep(u, dt) {
    if (!u.alive) { u.vel.set(0, 0, 0); return; }
    if (u.downed) {
      u.vel.set(0, 0, 0); u.kb.set(0, 0, 0);
      u.downT -= dt;
      let rev = false;
      for (const h of heroes) if (h !== u && dist(h, u) < TUNE.reviveR + h.radius + u.radius) { rev = true; break; }
      if (rev) { u.reviveT += dt; if (u.reviveT >= TUNE.reviveT) { reviveUnit(u); return; } }
      else u.reviveT = Math.max(0, u.reviveT - dt * 0.5);
      if (u === controlled) {
        u.downCtlT += dt;
        if (u.downCtlT > TUNE.controlHandoff) { const a = heroes[0]; if (a && game().switchTo) game().switchTo(a); }
      }
      if (u.downT <= 0) fallUnit(u);
      return;
    }
    if (u.dodgeAge < 9) u.dodgeAge += dt;
    if (u.hitStop > 0) { u.hitStop -= dt; return; }
    if (u.staggerT > 0) u.staggerT -= dt;
    if (u.dodgeT > 0) { dodgeStep(u, dt); integrate(u, dt); return; }
    if (u.action) actionStep(u, dt);
    if (u === controlled) { if (bot() && inCombat && TUNE.pilot) botPilot(u, dt); else playerControl(u, dt); }
    else companionAI(u, dt, false);
    integrate(u, dt);
  }

  // =====================================================================================================
  // 11. LOOT DROPS (sim) + renderer (frame, cosmetic)
  // =====================================================================================================
  function dropLoot(f) {
    const L = TUNE.loot[f.tier] || TUNE.loot.normal;
    const rr = AB.rand;
    const piles = L[0] >= 1 ? L[0] : rr.chance(L[0]) ? 1 : 0;
    const rem = L[1] >= 1 ? L[1] : rr.chance(L[1]) ? 1 : 0;
    const big = f.tier === 'boss' ? 3 : f.tier === 'elite' ? 2 : 1;
    for (let i = 0; i < piles + rem; i++) {
      const a = rr.float(0, U.TAU), r = rr.float(0.4, 1.4) + f.radius * 0.5;
      const d = { id: dropSeq++, kind: i < piles ? 'silver' : 'remedy', amount: i < piles ? rr.int(1, 3) * big : 8, x: f.pos.x + Math.sin(a) * r, y: 0, z: f.pos.z + Math.cos(a) * r, t: 0, life: 90, vx: Math.sin(a) * 2.2, vz: Math.cos(a) * 2.2 };
      tmpV.set(d.x, 0, d.z); AB.world.constrain(tmpV, 0.2); d.x = tmpV.x; d.z = tmpV.z; d.y = AB.world.heightAt(d.x, d.z);
      drops.push(d);
      emit('loot:drop', { drop: d });
    }
  }
  function dropStep(dt) {
    if (!drops.length) return;
    const c = isActive(controlled) ? controlled : null;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.t += dt; d.life -= dt;
      if (d.t < 0.5) { d.x += d.vx * dt; d.z += d.vz * dt; d.vx *= 0.9; d.vz *= 0.9; d.y = AB.world.heightAt(d.x, d.z); }
      // out of a fight the loot drifts to the controlled hero (no backtracking chores)
      if (c && !inCombat && d.t > 0.6) {
        const dd = U.dist2(c.pos.x, c.pos.z, d.x, d.z);
        if (dd < 8 && dd > 0.05) { const s = Math.min(dd, 9 * dt); d.x += (c.pos.x - d.x) / dd * s; d.z += (c.pos.z - d.z) / dd * s; d.y = AB.world.heightAt(d.x, d.z); }
      }
      let taker = null;
      if (d.t > 0.4) for (const h of heroes) if (U.dist2(h.pos.x, h.pos.z, d.x, d.z) < h.radius + 0.9 && (h === controlled || d.kind === 'remedy' || !inCombat)) { taker = h; break; }
      if (taker) {
        drops.splice(i, 1);
        const g = game();
        if (d.kind === 'silver') { if (g.gainSilver) g.gainSilver(d.amount, 'loot'); emit('sfx', { name: 'coin', pos: taker.pos }); }
        else { const t = hpFrac(taker) < 1 ? taker : lowestAlly(taker, 10) || taker; healUnit(t, d.amount, { kind: 'loot', src: taker }); emit('sfx', { name: 'chest', pos: taker.pos }); }
        emit('loot:pickup', { drop: d, unit: taker });
        continue;
      }
      if (d.life <= 0) drops.splice(i, 1);
    }
  }
  // tiny cosmetic renderer: glinting coin piles and green hearth-moss bundles (2 instanced draw calls)
  const loot = { coin: null, herb: null, ready: false };
  const _lm = new AB.THREE.Matrix4(), _lq = new AB.THREE.Quaternion(), _lp = new V3(), _ls = new V3(), _le = new AB.THREE.Euler();
  function lootFrame() {
    if (!AB.renderer || !AB.scene) return;
    const T = AB.THREE;
    if (!loot.ready) {
      loot.ready = true;
      const cg = new T.CylinderGeometry(0.11, 0.13, 0.07, 9); cg.userData.shared = true;
      const cm = new T.MeshStandardMaterial({ color: 0xc9a046, metalness: 0.85, roughness: 0.32, emissive: 0x6a4a10, emissiveIntensity: 0.55 }); cm.userData.shared = true;
      const hg = new T.OctahedronGeometry(0.13, 0); hg.userData.shared = true;
      const hm = new T.MeshStandardMaterial({ color: 0x5f9a5a, roughness: 0.6, emissive: 0x2f7a3a, emissiveIntensity: 0.9 }); hm.userData.shared = true;
      loot.coin = new T.InstancedMesh(cg, cm, 48); loot.herb = new T.InstancedMesh(hg, hm, 24);
      for (const m of [loot.coin, loot.herb]) { m.frustumCulled = false; m.count = 0; m.castShadow = false; m.userData.shared = true; m.name = 'combat-loot'; AB.scene.add(m); }
    }
    if (!loot.coin.parent) { AB.scene.add(loot.coin); AB.scene.add(loot.herb); }
    const now = AB.loop.time;
    let nc = 0, nh = 0;
    for (const d of drops) {
      const pop = Math.min(1, d.t / 0.25) * Math.min(1, d.life / 1.5);
      const bob = Math.sin(now * 2.4 + d.id) * 0.05;
      if (d.kind === 'silver' && nc < 48) {
        for (let k = 0; k < Math.min(3, 1 + (d.amount > 2 ? 1 : 0) + (d.amount > 5 ? 1 : 0)) && nc < 48; k++) {
          _lp.set(d.x + (k - 1) * 0.1, d.y + 0.05 + k * 0.06 + (d.t < 0.5 ? Math.sin(d.t / 0.5 * PI) * 0.5 : 0), d.z + (k & 1) * 0.08);
          _le.set(0.25 * Math.sin(d.id + k), now * 1.2 + k, 0.2); _lq.setFromEuler(_le); _ls.setScalar(Math.max(0.001, pop));
          _lm.compose(_lp, _lq, _ls); loot.coin.setMatrixAt(nc++, _lm);
        }
      } else if (d.kind === 'remedy' && nh < 24) {
        _lp.set(d.x, d.y + 0.35 + bob + (d.t < 0.5 ? Math.sin(d.t / 0.5 * PI) * 0.5 : 0), d.z);
        _le.set(0, now * 1.6 + d.id, 0); _lq.setFromEuler(_le); _ls.set(pop, pop * 1.5, pop);
        _lm.compose(_lp, _lq, _ls); loot.herb.setMatrixAt(nh++, _lm);
      }
    }
    loot.coin.count = nc; loot.herb.count = nh;
    // an InstancedMesh with count 0 still costs a draw call: hide the empty ones (integrator, perf)
    loot.coin.visible = nc > 0; loot.herb.visible = nh > 0;
    if (nc) loot.coin.instanceMatrix.needsUpdate = true;
    if (nh) loot.herb.instanceMatrix.needsUpdate = true;
  }
  // camera lock-on assist: frame the hard-locked foe (cosmetic; core camera reads AB.cam.lockOn)
  // Without a hard lock: a boss fight frames the boss (within 30 m), and the bot pilot frames its soft target so
  // demos/recordings show the fight. The core camera only applies it after 1 s without manual camera input.
  function camFrame() {
    if (!AB.cam) return;
    let lk = byUid(lockUid), soft = false;
    if (!(lk && lk.alive)) {
      lk = null;
      const c = controlled;
      if (inCombat && c && c.alive) {
        for (const e of encs) {
          if (!e.engaged || e.kind !== 'boss') continue;
          for (const f of e.foes) if (f.alive && f.tier === 'boss' && !f.sub && dist(c, f) < 30) lk = f;
        }
        if (!lk) { const s = byUid(softUid); if (s && s.alive && dist(c, s) > 2 && dist(c, s) < 24) { lk = s; soft = true; } }
      }
    }
    AB.cam.lockOn = lk && lk.alive && AB.state && AB.state.screen === 'play' ? lk : null;
    AB.cam.lockSoft = soft;
  }

  // =====================================================================================================
  // 12. PER-STEP BOOKKEEPING, QUERIES, API
  // =====================================================================================================
  function tickUnit(u, dt) {
    if (u.cds.attack > 0) u.cds.attack = Math.max(0, u.cds.attack - dt);
    if (u.cds.skill1 > 0) u.cds.skill1 = Math.max(0, u.cds.skill1 - dt);
    if (u.cds.skill2 > 0) u.cds.skill2 = Math.max(0, u.cds.skill2 - dt);
    if (u.cds.ember > 0) u.cds.ember = Math.max(0, u.cds.ember - dt);
    if (u.iframes > 0) u.iframes = Math.max(0, u.iframes - dt);
    if (u.dodgeCd > 0) u.dodgeCd = Math.max(0, u.dodgeCd - dt);
    if (u.flash > 0) u.flash = Math.max(0, u.flash - dt);
    if (u.hitT > 0) u.hitT = Math.max(0, u.hitT - dt);
    if (u.comboT > 0) u.comboT = Math.max(0, u.comboT - dt);
    if (u.riposte > 0) u.riposte = Math.max(0, u.riposte - dt);
    if (u.poiseT > 0) { u.poiseT -= dt; if (u.poiseT <= 0) u.poise = u.poiseMax; }
    if (u.poiseImm > 0) u.poiseImm -= dt;
    if (u.hsGap > 0) u.hsGap -= dt;
    if (!u.alive || u.downed) return;
    for (const k in u.status) {
      const s = u.status[k];
      s.t -= dt;
      if (k === 'bleed' || k === 'regen') {
        s.tick -= dt;
        if (s.tick <= 0) { s.tick += TUNE.tickSec; if (k === 'bleed') dealDamage(u, s.amount, { kind: 'bleed' }); else healUnit(u, s.amount, { kind: 'regen' }); }
        if (!u.alive || u.downed) return;
      }
      if (s.t <= 0) removeStatus(u, k);
    }
  }
  function updateAnim(u, dt) {
    const a = u.anim;
    let st;
    if (!u.alive) st = 'dead';
    else if (u.downed) st = 'downed';
    else if (u.dodgeT > 0) st = 'dodge';
    else if (u.status.stun || u.staggerT > 0) st = 'stagger';
    else if (u.hitT > 0 && !u.action && !u.atk) st = 'hit';
    else if (u.action) st = u.action.slot === 'attack' ? 'attack' : 'skill';
    else if (u.atk) st = 'windup';
    else st = Math.hypot(u.vel.x, u.vel.z) > 0.3 ? 'move' : 'idle';
    if (st !== a.state || (u.action && a.variant !== u.action.combo && st === 'attack')) { a.state = st; a.t = 0; a.variant = u.action ? u.action.combo : 0; } else a.t += dt;
    a.speed = Math.hypot(u.vel.x, u.vel.z);
  }
  // body separation: the controlled hero is never shoved by companions (they make way), foes are pushed by mass
  function separate() {
    for (let i = 0; i < units.length; i++) {
      const a = units[i]; if (!a.alive || a.downed || a.kind === 'display' || a.sub || a.spawnT > 0) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]; if (!b.alive || b.downed || b.kind === 'display' || b.sub || b.spawnT > 0) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, rr = a.radius + b.radius, d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = rr - d;
        let ma = a.mass || 1, mb = b.mass || 1;
        if (a === controlled && b.side === 'party') ma = 1e6; else if (b === controlled && a.side === 'party') mb = 1e6;
        if (a.dodgeT > 0) ma *= 0.3; if (b.dodgeT > 0) mb *= 0.3;   // a roll slips past bodies
        const ka = mb / (ma + mb), kb = ma / (ma + mb);
        a.pos.x -= dx / d * push * ka; a.pos.z -= dz / d * push * ka;
        b.pos.x += dx / d * push * kb; b.pos.z += dz / d * push * kb;
      }
    }
  }
  function step(dt) {
    time += dt;
    heroes.length = 0;
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.kind === 'hero' && isActive(u)) heroes.push(u); }
    for (let i = 0; i < units.length; i++) tickUnit(units[i], dt);
    if (!frozen) {
      // pack slots: spread the beasts of each encounter around their prey
      for (const e of encs) { if (!e.engaged) continue; let k = 0; for (const f of e.foes) if (f.alive && f.pack) { f.ai.slot = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.9 + (k === 0 ? 0 : 0); k++; } }
      for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.kind === 'hero') heroStep(u, dt); }
      for (let i = 0; i < encs.length; i++) encStep(encs[i], dt);
      projStep(dt);
      separate();
      dropStep(dt);
    }
    for (let i = units.length - 1; i >= 0; i--) {
      const u = units[i];
      if (!u) continue;
      updateAnim(u, dt);
      if (!u.alive && u.kind !== 'display' && (u.deadT += dt) > TUNE.corpseSec && !(u.kind === 'hero' && u.id === BEARER_ID)) despawnUnit(u);
    }
  }

  function nearestFoeTo(x, z, r) {
    let best = null, bd = r;
    for (const f of units) { if (!isFoe(f) || f.sub) continue; const d = U.dist2(x, z, f.pos.x, f.pos.z); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  function nearestFoe(u, range = 60) {
    if (!u) return null;
    return engagedFoeNear(u, range) || nearestFoeTo(u.pos.x, u.pos.z, range);
  }
  function lockTarget() {
    const lk = byUid(lockUid); if (lk && lk.alive) return lk;
    const s = byUid(softUid); return s && s.alive && inCombat ? s : null;
  }
  function cooldowns(u) {
    if (!u || !u.slots) return {};
    if (!u._cdv) u._cdv = {};
    const v = u._cdv;
    for (let i = 0; i < 4; i++) {
      const slot = IN_SLOTS[i];
      const ab = u.slots[slot];
      if (!ab) { v[slot] = null; continue; }
      const o = v[slot] || (v[slot] = {});
      o.id = ab.id; o.name = ab.name; o.left = u.cds[slot]; o.total = cdSec(ab, slot) || TUNE.attackDur;
      o.ready = u.cds[slot] <= 0 && isActive(u) && !u.status.stun;   // a press during another action is buffered
    }
    return v;
  }
  function clear() {
    for (let i = units.length - 1; i >= 0; i--) despawnUnit(units[i]);
    encs = []; projs.length = 0; threats.length = 0; drops.length = 0; heroes.length = 0;
    controlled = null; frozen = false; inCombat = false; lockUid = 0; softUid = 0;
  }

  AB.combat = {
    TUNE, WEAPON, KIT, GLYPH, ROLE, IN,
    // calmNear(x, z, r, sec): encounters within r m that are not engaged ignore proximity for sec seconds (a grace
    // period after waking at a fire: a rewind or Continue never drops the party straight into a fight)
    calmNear(x, z, r, sec) { for (const e of encs) if (!e.engaged && !e.done && U.dist2(e.x, e.z, x, z) < r) e.calmT = Math.max(e.calmT, sec); },
    init() {
      AB.loop.add('combat', step, { phase: 'step', order: AB.loop.ORDER.combat });
      AB.loop.add('combat-fx', (dt) => { lootFrame(); camFrame(); }, { phase: 'frame', order: 65 });
    },
    // construction / placement
    makeHero, makeEnemy, placeParty, teleportParty, setControlled, controlled: () => controlled,
    spawnEncounter, spawnDisplay(cid, x, z, yaw) {
      const u = makeHero(cid); u.kind = 'display';
      u.pos.set(x, 0, z); u.pos.y = AB.world.heightAt(x, z); u.facing = yaw || 0;
      spawnUnit(u); return u;
    },
    despawn: despawnUnit,
    rejoin(m) {
      if (!m || m.spawned) return;
      resetTransient(m);
      const c = controlled || m;
      m.pos.set(c.pos.x - Math.sin(c.facing) * 2, 0, c.pos.z - Math.cos(c.facing) * 2);
      AB.world.constrain(m.pos, m.radius); m.pos.y = groundY(m);
      spawnUnit(m);
    },
    clear, stopAll() { frozen = true; for (const u of units) { cancelAtk(u); u.action = null; u.vel.set(0, 0, 0); u.kb.set(0, 0, 0); } projs.length = 0; threats.length = 0; },
    // rules
    heal: healUnit, damage: dealDamage, addStatus, removeStatus, applyEffects, tryAbility, canFlee, flee: fleeNormal,
    // the bot's fighting brain for the controlled hero (combat calls it itself while __ab.bot is on; game may call it too)
    botFight(u, dt) { if (u && u === controlled && isActive(u)) { botPilot(u, dt || AB.loop.STEP); return true; } return false; },
    // queries (read-only results; arrays are live or fresh as noted in INTERFACES.md)
    units: () => units, threats: () => threats, projectiles: () => projs, encounters: () => encs, drops: () => drops,
    activeEncounters: () => encs.filter((e) => e.engaged),
    foes: () => units.filter((u) => u.side === 'foe' && u.alive),
    unit: byUid, nearestFoe, foesNear, rangeOf, cooldowns,
    lockTarget, lockInfo: () => ({ unit: lockTarget(), hard: !!byUid(lockUid) }),
    intentSpec: (f, it) => intentSpec(f, it),
    history: () => history,
    get inCombat() { return inCombat; },
    get time() { return time; }
  };
}
