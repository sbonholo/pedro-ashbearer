/* ASHBEARER content. Data only, no logic. Schema: SPEC.md section 3.
   Validate with: node tools/content/validate.mjs */
window.ASHBEARER_CONTENT = {
  version: 1,

  /* ------------------------------------------------------------------ ACTS */
  acts: [
    {
      id: 1, name: 'The Low Roads', region: 'Thistledown Vale to the Fenmarsh', bossId: 'hollow_huntsman',
      intro: "The road out of Thistledown is green and gentle for exactly one day. Beyond the vale lie the Whisperwood, where the paths change their minds, and the Fenmarsh, where the ground does. Something has already picked up your scent."
    },
    {
      id: 2, name: 'The Mountain Roads', region: 'The Greyspire passes to drowned Undervault', bossId: 'last_warden',
      intro: "The Greyspire passes climb into snow and silence, and the only way through the mountains runs beneath them, through the drowned halls of Undervault. The Delvers built those halls to last forever. Forever turned out to be shorter than they thought."
    },
    {
      id: 3, name: 'The Ashen March', region: 'The cinder plains to the gate of Mount Cindral', bossId: 'cinder_regent',
      intro: "Past the mountains the world turns to cinders. The sky over the Ashen March is red by day and by night, the wind is full of grit, and the land gives nothing back. At the end of it stands Mount Cindral, and at its gate the Sovereign's last servant is waiting."
    }
  ],

  /* ------------------------------------------------------------ COMPANIONS */
  companions: [
    {
      id: 'wren', name: 'Wren Hollowell', epithet: 'Courier of Thistledown', role: 'Bearer',
      bearer: true, maxHp: 38, hue: 32,
      blurb: "A hill-folk courier who has never lost a letter and does not mean to start with this one. Small, stubborn and far too honest for the road ahead.",
      trait: { id: 'small_and_stubborn', name: 'Small and Stubborn', text: "If Wren falls, the road ends and the run is lost. Wren cannot be stunned." },
      abilities: [
        { id: 'sling_stone', name: 'Sling Stone', text: "Deal 6 damage to one foe.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 6, target: 'foe' }] },
        { id: 'encourage', name: 'Encourage', text: "Heal one ally for 6 HP and gain 3 Hope.", cooldown: 2, select: 'friend',
          effects: [{ type: 'heal', amount: 6, target: 'friend' }, { type: 'hope', amount: 3 }] },
        { id: 'wield_emberheart', name: 'Wield the Emberheart', text: "Deal 18 damage to all foes. Corruption +12.", cooldown: 3, select: 'none',
          effects: [{ type: 'damage', amount: 18, target: 'all_foes' }, { type: 'corruption', amount: 12 }] },
        { id: 'fade_into_ash', name: 'Fade into Ash', text: "Become Hidden for 2 rounds: no single attack can reach you. Corruption +6.", cooldown: 3, select: 'none',
          effects: [{ type: 'status', status: 'hidden', turns: 2, target: 'self' }, { type: 'corruption', amount: 6 }] }
      ]
    },
    {
      id: 'ysolde', name: 'Ysolde Marr', epithet: 'the Wayfinder', role: 'Wayfinder',
      bearer: false, maxHp: 44, hue: 140,
      blurb: "A wayfinder who reads weather, moss and footprints the way scholars read books. She can tell yesterday's fox track from this morning's at a glance, and finds most roads too easy.",
      trait: { id: 'pathfinder', name: 'Pathfinder', text: "Gain 1 extra Supply after every battle won. Forage at camp gives 3 more Supplies." },
      abilities: [
        { id: 'twin_cuts', name: 'Twin Cuts', text: "Strike one foe 2 times for 4 damage each.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 4, hits: 2, target: 'foe' }] },
        { id: 'mark_quarry', name: 'Mark Quarry', text: "Mark one foe for 2 rounds (it takes 50% more damage), then deal 3 damage to it.", cooldown: 2, select: 'foe',
          effects: [{ type: 'status', status: 'mark', turns: 2, target: 'foe' }, { type: 'damage', amount: 3, target: 'foe' }] },
        { id: 'hunters_volley', name: "Hunter's Volley", text: "Loose 3 arrows at random foes for 6 damage each.", cooldown: 3, select: 'none',
          effects: [{ type: 'damage', amount: 6, hits: 3, target: 'foe', pick: 'random' }] }
      ]
    },
    {
      id: 'brakka', name: 'Brakka Ironmantle', epithet: 'the Shieldwarden', role: 'Shieldwarden',
      bearer: false, maxHp: 60, hue: 18,
      blurb: "A shieldwarden of the hill-forts, broad as a door and twice as hard to move. She speaks rarely and stands in front of everything.",
      trait: { id: 'stonehearted', name: 'Stonehearted', text: "Brakka cannot be stunned or weakened." },
      abilities: [
        { id: 'hammer_blow', name: 'Hammer Blow', text: "Deal 7 damage to one foe.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 7, target: 'foe' }] },
        { id: 'shield_wall', name: 'Shield Wall', text: "Give all allies Guard for 1 round (they take half damage).", cooldown: 3, select: 'none',
          effects: [{ type: 'status', status: 'guard', turns: 1, target: 'all_friends' }] },
        { id: 'defy', name: 'Defy', text: "Taunt for 2 rounds, so foes must aim their single attacks at Brakka, and gain Guard for 2 rounds.", cooldown: 3, select: 'none',
          effects: [{ type: 'status', status: 'taunt', turns: 2, target: 'self' }, { type: 'status', status: 'guard', turns: 2, target: 'self' }] }
      ]
    },
    {
      id: 'neve', name: 'Neve Starling', epithet: 'Archer of the Thornwood', role: 'Archer',
      bearer: false, maxHp: 34, hue: 200,
      blurb: "A poacher's daughter from the Thornwood who can split a twig at sixty paces. She shoots first and apologises never.",
      trait: { id: 'first_strike', name: 'First Strike', text: "In round 1 of every battle, Neve deals double damage." },
      abilities: [
        { id: 'swift_arrow', name: 'Swift Arrow', text: "Deal 8 damage to one foe.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 8, target: 'foe' }] },
        { id: 'pinning_shot', name: 'Pinning Shot', text: "Deal 6 damage and Stun the foe for 1 round: it loses its next action.", cooldown: 3, select: 'foe',
          effects: [{ type: 'damage', amount: 6, target: 'foe' }, { type: 'status', status: 'stun', turns: 1, target: 'foe' }] },
        { id: 'rain_of_thorns', name: 'Rain of Thorns', text: "Deal 7 damage to all foes.", cooldown: 3, select: 'none',
          effects: [{ type: 'damage', amount: 7, target: 'all_foes' }] }
      ]
    },
    {
      id: 'maddoc', name: 'Maddoc', epithet: 'the Lantern-Keeper', role: 'Lantern-Keeper',
      bearer: false, maxHp: 36, hue: 48,
      blurb: "Keeper of a lantern that has burned for three hundred years without oil. He is gentle, patient, and the only one of you not afraid of the dark.",
      trait: { id: 'steady_light', name: 'Steady Light', text: "Steady the Bearer at camp removes 10 more Corruption." },
      abilities: [
        { id: 'lantern_flare', name: 'Lantern Flare', text: "Deal 5 damage and Weaken the foe for 2 rounds.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 5, target: 'foe' }, { type: 'status', status: 'weak', turns: 2, target: 'foe' }] },
        { id: 'mend', name: 'Mend', text: "Heal one ally for 14 HP.", cooldown: 2, select: 'friend',
          effects: [{ type: 'heal', amount: 14, target: 'friend' }] },
        { id: 'kindle_old_light', name: 'Kindle the Old Light', text: "Heal all allies for 8 HP, cleanse weak, mark, stun and bleed from them, and gain 5 Hope.", cooldown: 4, select: 'none',
          effects: [{ type: 'heal', amount: 8, target: 'all_friends' }, { type: 'cleanse', target: 'all_friends' }, { type: 'hope', amount: 5 }] }
      ]
    },
    {
      id: 'rook', name: 'Rook', epithet: 'Sellsword of the Marches', role: 'Sellsword',
      bearer: false, maxHp: 42, hue: 280,
      blurb: "A sellsword with good boots, bad debts and a smile that costs extra. He says he came for the pay. He watches the Emberheart like a hungry man watches bread.",
      trait: { id: 'covetous', name: 'Covetous', text: "Battles fought with Rook yield 25% more silver. He wants the Emberheart, and one night he may ask for it." },
      abilities: [
        { id: 'dirty_blade', name: 'Dirty Blade', text: "Deal 7 damage and make the foe Bleed 2 HP a round for 3 rounds.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 7, target: 'foe' }, { type: 'status', status: 'bleed', turns: 3, amount: 2, target: 'foe' }] },
        { id: 'backstab', name: 'Backstab', text: "Deal 9 damage, or 18 if the foe is Marked or Stunned.", cooldown: 2, select: 'foe',
          effects: [{ type: 'damage', amount: 9, target: 'foe', ifTargetHas: ['mark', 'stun'], amountIf: 18 }] },
        { id: 'cut_purse', name: 'Cut Purse', text: "Deal 8 damage and pocket 6 silver.", cooldown: 3, select: 'foe',
          effects: [{ type: 'damage', amount: 8, target: 'foe' }, { type: 'silver', amount: 6 }] }
      ]
    },
    {
      id: 'tamsin', name: 'Tamsin Reed', epithet: 'the Hearth-Singer', role: 'Hearth-Singer',
      bearer: false, maxHp: 32, hue: 330,
      blurb: "A hearth-singer with a song for every road and a joke for every grave. Where she sings, people remember why they started walking.",
      trait: { id: 'kindled_spirits', name: 'Kindled Spirits', text: "All Hope loss is reduced by 30%. Tell Old Stories at camp gives 6 more Hope." },
      abilities: [
        { id: 'cutting_verse', name: 'Cutting Verse', text: "Deal 5 damage and Weaken the foe for 2 rounds.", cooldown: 0, select: 'foe',
          effects: [{ type: 'damage', amount: 5, target: 'foe' }, { type: 'status', status: 'weak', turns: 2, target: 'foe' }] },
        { id: 'marching_song', name: 'Marching Song', text: "Empower all allies for 2 rounds (25% more damage) and gain 2 Hope.", cooldown: 3, select: 'none',
          effects: [{ type: 'status', status: 'empower', turns: 2, target: 'all_friends' }, { type: 'hope', amount: 2 }] },
        { id: 'dirge_old_kings', name: 'Dirge of Old Kings', text: "Deal 5 damage to all foes and Weaken them for 2 rounds.", cooldown: 3, select: 'none',
          effects: [{ type: 'damage', amount: 5, target: 'all_foes' }, { type: 'status', status: 'weak', turns: 2, target: 'all_foes' }] }
      ]
    }
  ],

  /* --------------------------------------------------------------- ENEMIES */
  enemies: {
    /* ---- Act 1: The Low Roads ---- */
    ash_hound: {
      name: 'Ash Hound', act: 1, tier: 'normal', maxHp: 32, glyph: 'hound', pattern: 'random',
      blurb: "A lean grey hound with cinders for eyes, bred to follow one scent across a whole country.",
      intents: [
        { id: 'snap', name: 'Snap', weight: 3, effects: [{ type: 'damage', amount: 9, target: 'foe', pick: 'random' }] },
        { id: 'hamstring', name: 'Hamstring', weight: 2, effects: [{ type: 'damage', amount: 5, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'bleed', turns: 3, amount: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'scent', name: 'Catch the Scent', weight: 1, effects: [{ type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'bearer' }] }
      ]
    },
    hedge_cutthroat: {
      name: 'Hedge Cutthroat', act: 1, tier: 'normal', maxHp: 46, glyph: 'bandit', pattern: 'cycle',
      blurb: "A hedge-robber with a rusty knife and nothing left to lose but the knife.",
      intents: [
        { id: 'knife', name: 'Rusty Knife', weight: 1, effects: [{ type: 'damage', amount: 10, target: 'foe', pick: 'random' }] },
        { id: 'dust', name: 'Dust in the Eyes', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'foe', pick: 'random' }] },
        { id: 'gut', name: 'Go for the Weak', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'lowest' }] }
      ]
    },
    whisperwood_weaver: {
      name: 'Whisperwood Weaver', act: 1, tier: 'normal', maxHp: 41, glyph: 'spider', pattern: 'random',
      blurb: "A spider the size of a dog that hangs in the canopy and waits for warm things to pass beneath.",
      intents: [
        { id: 'bite', name: 'Venom Bite', weight: 3, effects: [{ type: 'damage', amount: 9, target: 'foe', pick: 'random' }] },
        { id: 'spit', name: 'Spit Venom', weight: 2, effects: [{ type: 'status', status: 'bleed', turns: 3, amount: 2, target: 'foe', pick: 'random' }] },
        { id: 'web', name: 'Bind in Silk', weight: 1, effects: [{ type: 'status', status: 'stun', turns: 2, target: 'foe', pick: 'random' }] }
      ]
    },
    fen_lurker: {
      name: 'Fen Lurker', act: 1, tier: 'normal', maxHp: 55, glyph: 'lurker', pattern: 'cycle',
      blurb: "Something long and pale that lives under the Fenmarsh mud and pulls travellers down to keep it company.",
      intents: [
        { id: 'lash', name: 'Reed Lash', weight: 1, effects: [{ type: 'damage', amount: 7, target: 'foe', pick: 'random' }] },
        { id: 'drag', name: 'Drag Under', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'lowest' }] },
        { id: 'sink', name: 'Sink Below', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }, { type: 'status', status: 'regen', turns: 3, amount: 3, target: 'self' }] }
      ]
    },
    ember_pilgrim: {
      name: 'Ember Pilgrim', act: 1, tier: 'normal', maxHp: 41, glyph: 'cultist', pattern: 'random',
      blurb: "A villager who heard the Emberheart singing in their sleep and walked out of the door to find it.",
      intents: [
        { id: 'swing', name: 'Fevered Swing', weight: 3, effects: [{ type: 'damage', amount: 9, target: 'foe', pick: 'random' }] },
        { id: 'chant', name: 'Chant of Ash', weight: 2, effects: [{ type: 'corruption', amount: 3 }] },
        { id: 'bless', name: 'Bless the Faithful', weight: 1, effects: [{ type: 'status', status: 'empower', turns: 2, target: 'all_friends' }] }
      ]
    },
    mire_ghoul: {
      name: 'Mire Ghoul', act: 1, tier: 'normal', maxHp: 51, glyph: 'ghoul', pattern: 'random',
      blurb: "A drowned thing that crawled back out of the marsh, hungry.",
      intents: [
        { id: 'claw', name: 'Grave Claw', weight: 3, effects: [{ type: 'damage', amount: 10, target: 'foe', pick: 'random' }] },
        { id: 'grip', name: 'Rotting Grip', weight: 2, effects: [{ type: 'damage', amount: 5, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'weak', turns: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'feed', name: 'Feed', weight: 1, effects: [{ type: 'heal', amount: 6, target: 'self' }] }
      ]
    },
    marsh_midges: {
      name: 'Midge Cloud', act: 1, tier: 'normal', maxHp: 32, glyph: 'swarm', pattern: 'random',
      blurb: "A whining cloud of marsh midges, thick enough to dim the light.",
      intents: [
        { id: 'stings', name: 'Thousand Stings', weight: 3, effects: [{ type: 'damage', amount: 3, hits: 3, target: 'foe', pick: 'random' }] },
        { id: 'drone', name: 'Maddening Drone', weight: 1, effects: [{ type: 'hope', amount: -6 }] }
      ]
    },
    whisperwood_shade: {
      name: 'Whisperwood Shade', act: 1, tier: 'normal', maxHp: 37, glyph: 'shade', pattern: 'cycle',
      blurb: "A thin grey shape between the trees that knows your name and likes to say it.",
      intents: [
        { id: 'murmur', name: 'Murmur Your Name', weight: 1, effects: [{ type: 'corruption', amount: 4 }] },
        { id: 'chill', name: 'Chill Touch', weight: 1, effects: [{ type: 'damage', amount: 9, target: 'foe', pick: 'bearer' }] },
        { id: 'despair', name: 'Breath of Despair', weight: 1, effects: [{ type: 'hope', amount: -6 }] }
      ]
    },
    thornback_troll: {
      name: 'Thornback Troll', act: 1, tier: 'elite', maxHp: 99, glyph: 'troll', pattern: 'cycle',
      blurb: "A troll grown over with brambles and moss. It sleeps for years at a time and always wakes up angry.",
      intents: [
        { id: 'crush', name: 'Crushing Blow', weight: 1, effects: [{ type: 'damage', amount: 18, target: 'foe', pick: 'highest' }] },
        { id: 'sweep', name: 'Bramble Sweep', weight: 1, effects: [{ type: 'damage', amount: 6, target: 'all_foes' }] },
        { id: 'bellow', name: 'Bellow', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }] },
        { id: 'hide', name: 'Thick Hide', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }, { type: 'status', status: 'regen', turns: 3, amount: 3, target: 'self' }] }
      ]
    },
    tithe_taker: {
      name: 'The Tithe-Taker', act: 1, tier: 'elite', maxHp: 94, glyph: 'bandit', pattern: 'cycle',
      blurb: "A bandit chief who calls robbery a tax and keeps very careful books.",
      intents: [
        { id: 'whistle', name: 'Whistle for the Band', weight: 1, effects: [{ type: 'summon', enemy: 'hedge_cutthroat' }] },
        { id: 'cleaver', name: 'Heavy Cleaver', weight: 1, effects: [{ type: 'damage', amount: 14, target: 'foe', pick: 'highest' }] },
        { id: 'collect', name: 'Collect the Tithe', weight: 1, effects: [{ type: 'damage', amount: 10, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'bleed', turns: 3, amount: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'rally', name: 'Rally the Band', weight: 1, effects: [{ type: 'status', status: 'empower', turns: 2, target: 'all_friends' }] }
      ]
    },
    hollow_huntsman: {
      name: 'The Hollow Huntsman', act: 1, tier: 'boss', maxHp: 171, glyph: 'wraith', pattern: 'cycle',
      blurb: "A hunter of frost and old antlers who rides out whenever the Emberheart wakes. Its horn is older than Thistledown, and its hounds are never far behind.",
      intents: [
        { id: 'hollow_call', name: 'The Hollow Call', weight: 1, effects: [{ type: 'corruption', amount: 6 }, { type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'bearer' }] },
        { id: 'rime_spear', name: 'Rime Spear', weight: 1, effects: [{ type: 'damage', amount: 18, target: 'foe', pick: 'bearer' }] },
        { id: 'horn', name: 'Sound the Horn', weight: 1, effects: [{ type: 'summon', enemy: 'ash_hound' }] },
        { id: 'reaping_sweep', name: 'Reaping Sweep', weight: 1, effects: [{ type: 'damage', amount: 9, target: 'all_foes' }, { type: 'hope', amount: -6 }] }
      ]
    },

    /* ---- Act 2: The Mountain Roads ---- */
    greyspire_wolf: {
      name: 'Greyspire Wolf', act: 2, tier: 'normal', maxHp: 59, glyph: 'beast', pattern: 'random',
      blurb: "A mountain wolf, grey as the rock and patient as the winter.",
      intents: [
        { id: 'bite', name: 'Bite', weight: 3, effects: [{ type: 'damage', amount: 14, target: 'foe', pick: 'random' }] },
        { id: 'lunge', name: 'Throat Lunge', weight: 2, effects: [{ type: 'damage', amount: 11, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'bleed', turns: 3, amount: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'howl', name: 'Howl', weight: 1, effects: [{ type: 'status', status: 'empower', turns: 2, target: 'all_friends' }] }
      ]
    },
    delver_husk: {
      name: 'Delver Husk', act: 2, tier: 'normal', maxHp: 58, glyph: 'ghoul', pattern: 'random',
      blurb: "What is left of a Delver miner, still walking the halls, still swinging at a seam of ore that ran out centuries ago.",
      intents: [
        { id: 'pick', name: 'Rusted Pick', weight: 3, effects: [{ type: 'damage', amount: 16, target: 'foe', pick: 'random' }] },
        { id: 'grasp', name: 'Drowned Grasp', weight: 2, effects: [{ type: 'damage', amount: 9, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'weak', turns: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'sigh', name: 'Sigh of the Drowned', weight: 1, effects: [{ type: 'hope', amount: -8 }] }
      ]
    },
    delver_sentinel: {
      name: 'Delver Sentinel', act: 2, tier: 'normal', maxHp: 92, glyph: 'sentinel', pattern: 'cycle',
      blurb: "A Delver guardian of carved stone and bronze joints. It does not know that its makers are gone.",
      intents: [
        { id: 'brace', name: 'Brace', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 1, target: 'self' }] },
        { id: 'stone_fist', name: 'Stone Fist', weight: 1, effects: [{ type: 'damage', amount: 20, target: 'foe', pick: 'highest' }] },
        { id: 'stride', name: 'Grinding Stride', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'random' }] }
      ]
    },
    cistern_lurker: {
      name: 'Cistern Lurker', act: 2, tier: 'normal', maxHp: 84, glyph: 'lurker', pattern: 'random',
      blurb: "A blind white eel the length of a boat, coiled in the flooded cisterns.",
      intents: [
        { id: 'lash', name: 'Tail Lash', weight: 2, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'random' }] },
        { id: 'ambush', name: 'From the Black Water', weight: 2, effects: [{ type: 'damage', amount: 21, target: 'foe', pick: 'lowest' }] },
        { id: 'coil', name: 'Coil and Hold', weight: 1, effects: [{ type: 'status', status: 'stun', turns: 2, target: 'foe', pick: 'random' }] },
        { id: 'submerge', name: 'Submerge', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }, { type: 'status', status: 'regen', turns: 3, amount: 4, target: 'self' }] }
      ]
    },
    pass_reaver: {
      name: 'Pass Reaver', act: 2, tier: 'normal', maxHp: 76, glyph: 'soldier', pattern: 'cycle',
      blurb: "A deserter turned toll-collector, armed with a halberd and a short temper.",
      intents: [
        { id: 'hook', name: 'Hook and Drag', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'halberd', name: 'Halberd Chop', weight: 1, effects: [{ type: 'damage', amount: 19, target: 'foe', pick: 'highest' }] },
        { id: 'shield', name: 'Shield Up', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }] }
      ]
    },
    deep_echo: {
      name: 'Echo of the Deep', act: 2, tier: 'normal', maxHp: 63, glyph: 'shade', pattern: 'random',
      blurb: "An echo that has wandered the deep halls so long it has learned to want things.",
      intents: [
        { id: 'voice', name: 'Your Own Voice', weight: 2, effects: [{ type: 'corruption', amount: 5 }] },
        { id: 'cold_hand', name: 'Cold Hand', weight: 2, effects: [{ type: 'damage', amount: 14, target: 'foe', pick: 'random' }] },
        { id: 'hush', name: 'The Long Hush', weight: 1, effects: [{ type: 'hope', amount: -10 }] }
      ]
    },
    blindwing_swarm: {
      name: 'Blindwing Swarm', act: 2, tier: 'normal', maxHp: 50, glyph: 'swarm', pattern: 'random',
      blurb: "A storm of pale cave bats that hunt by sound and scream to find you.",
      intents: [
        { id: 'flurry', name: 'Flurry of Wings', weight: 3, effects: [{ type: 'damage', amount: 5, hits: 3, target: 'foe', pick: 'random' }] },
        { id: 'shriek', name: 'Shriek', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }] }
      ]
    },
    ash_acolyte: {
      name: 'Acolyte of Ash', act: 2, tier: 'normal', maxHp: 63, glyph: 'cultist', pattern: 'random',
      blurb: "A climber in grey robes who followed the Emberheart's whisper up the mountain and means to take it home.",
      intents: [
        { id: 'burning_word', name: 'Burning Word', weight: 2, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'random' }] },
        { id: 'litany', name: 'Litany of Ash', weight: 2, effects: [{ type: 'corruption', amount: 4 }] },
        { id: 'anoint', name: 'Anoint', weight: 1, effects: [{ type: 'heal', amount: 8, target: 'friend', pick: 'lowest' }] }
      ]
    },
    slatehide_troll: {
      name: 'Slatehide Troll', act: 2, tier: 'elite', maxHp: 140, glyph: 'troll', pattern: 'cycle',
      blurb: "A mountain troll with skin like split slate. Arrows bounce off it, and so does reason.",
      intents: [
        { id: 'boulder', name: 'Hurl Boulder', weight: 1, effects: [{ type: 'damage', amount: 23, target: 'foe', pick: 'highest' }] },
        { id: 'stamp', name: 'Stamp', weight: 1, effects: [{ type: 'damage', amount: 10, target: 'all_foes' }] },
        { id: 'roar', name: 'Roar', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }, { type: 'hope', amount: -8 }] }
      ]
    },
    undervault_wyrm: {
      name: 'Undervault Wyrmling', act: 2, tier: 'elite', maxHp: 130, glyph: 'wyrm', pattern: 'random',
      blurb: "A young wyrm nesting in the flooded deeps, drawn up out of the dark by the smell of the Emberheart.",
      intents: [
        { id: 'breath', name: 'Scalding Breath', weight: 2, effects: [{ type: 'damage', amount: 12, target: 'all_foes' }] },
        { id: 'gnash', name: 'Gnashing Bite', weight: 2, effects: [{ type: 'damage', amount: 21, target: 'foe', pick: 'random' }] },
        { id: 'coil', name: 'Coil in the Dark', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }, { type: 'status', status: 'regen', turns: 3, amount: 5, target: 'self' }] },
        { id: 'gaze', name: 'Hungry Gaze', weight: 1, effects: [{ type: 'corruption', amount: 5 }] }
      ]
    },
    last_warden: {
      name: 'The Last Warden', act: 2, tier: 'boss', maxHp: 240, glyph: 'sentinel', pattern: 'cycle',
      blurb: "The last guardian the Delvers made, a giant of stone and bronze set to keep their halls forever. The Emberheart has been whispering to it for a long time.",
      intents: [
        { id: 'floodgates', name: 'Open the Floodgates', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'all_foes' }] },
        { id: 'deep_hammer', name: 'Hammer of the Deep', weight: 1, effects: [{ type: 'damage', amount: 24, target: 'foe', pick: 'highest' }] },
        { id: 'wake_husks', name: 'Wake the Husks', weight: 1, effects: [{ type: 'summon', enemy: 'delver_husk' }] },
        { id: 'cold_tide', name: 'The Cold Tide', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'all_foes' }] },
        { id: 'seal_halls', name: 'Seal the Halls', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 1, target: 'self' }, { type: 'status', status: 'regen', turns: 2, amount: 5, target: 'self' }] }
      ]
    },

    /* ---- Act 3: The Ashen March ---- */
    cinder_hound: {
      name: 'Cinder Hound', act: 3, tier: 'normal', maxHp: 60, glyph: 'hound', pattern: 'random',
      blurb: "A hound of the March with embers smouldering in its coat, bred in the forge-pits.",
      intents: [
        { id: 'burning_bite', name: 'Burning Bite', weight: 3, effects: [{ type: 'damage', amount: 15, target: 'foe', pick: 'random' }] },
        { id: 'run_down', name: 'Run Down', weight: 2, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'bleed', turns: 3, amount: 3, target: 'foe', pick: 'lowest' }] }
      ]
    },
    ashguard_spear: {
      name: 'Ashguard Spearman', act: 3, tier: 'normal', maxHp: 62, glyph: 'soldier', pattern: 'cycle',
      blurb: "A soldier of the Sovereign's gatewatch in ash-grey armour. It fights in step with the others and never alone.",
      intents: [
        { id: 'thrust', name: 'Spear Thrust', weight: 1, effects: [{ type: 'damage', amount: 18, target: 'foe', pick: 'random' }] },
        { id: 'pin', name: 'Pin the Weak', weight: 1, effects: [{ type: 'damage', amount: 12, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'lowest' }] },
        { id: 'lock_shields', name: 'Lock Shields', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'all_friends' }] }
      ]
    },
    kiln_priest: {
      name: 'Priest of the Kiln', act: 3, tier: 'normal', maxHp: 64, glyph: 'priest', pattern: 'random',
      blurb: "A priest of the forge-cult who preaches that all things are fuel, and means it.",
      intents: [
        { id: 'sermon', name: 'Sermon of Ash', weight: 2, effects: [{ type: 'corruption', amount: 6 }] },
        { id: 'searing_word', name: 'Searing Word', weight: 2, effects: [{ type: 'damage', amount: 13, target: 'foe', pick: 'random' }] },
        { id: 'kindle', name: 'Kindle the Faithful', weight: 1, effects: [{ type: 'heal', amount: 7, target: 'all_friends' }] }
      ]
    },
    smoke_wraith: {
      name: 'Smoke Wraith', act: 3, tier: 'normal', maxHp: 68, glyph: 'wraith', pattern: 'random',
      blurb: "A shape of smoke and old spite that leans toward the Emberheart the way a flame leans into a draught.",
      intents: [
        { id: 'old_name', name: 'Whisper the Old Name', weight: 2, effects: [{ type: 'corruption', amount: 5 }, { type: 'hope', amount: -6 }] },
        { id: 'grave_chill', name: 'Grave Chill', weight: 2, effects: [{ type: 'damage', amount: 17, target: 'foe', pick: 'bearer' }] },
        { id: 'smother', name: 'Smother', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }] }
      ]
    },
    slag_ghoul: {
      name: 'Slag Ghoul', act: 3, tier: 'normal', maxHp: 76, glyph: 'ghoul', pattern: 'random',
      blurb: "A worker who died in the slag pits and climbed out anyway, still glowing in the cracks.",
      intents: [
        { id: 'molten_claw', name: 'Molten Claw', weight: 3, effects: [{ type: 'damage', amount: 17, target: 'foe', pick: 'random' }] },
        { id: 'spatter', name: 'Slag Spatter', weight: 1, effects: [{ type: 'damage', amount: 7, target: 'all_foes' }] },
        { id: 'gorge', name: 'Gorge', weight: 1, effects: [{ type: 'heal', amount: 10, target: 'self' }] }
      ]
    },
    ember_moths: {
      name: 'Ember Moths', act: 3, tier: 'normal', maxHp: 56, glyph: 'swarm', pattern: 'random',
      blurb: "Moths with wings of live coal. Where they settle, cloth begins to smoulder.",
      intents: [
        { id: 'burning_swarm', name: 'Burning Swarm', weight: 3, effects: [{ type: 'damage', amount: 5, hits: 4, target: 'foe', pick: 'random' }] },
        { id: 'blot', name: 'Blot Out the Sky', weight: 1, effects: [{ type: 'hope', amount: -8 }] }
      ]
    },
    march_herald: {
      name: 'Herald of the March', act: 3, tier: 'normal', maxHp: 72, glyph: 'herald', pattern: 'cycle',
      blurb: "A herald of the Ashen March whose horn carries for miles and whose voice carries further.",
      intents: [
        { id: 'proclaim', name: 'Proclaim Defeat', weight: 1, effects: [{ type: 'hope', amount: -12 }] },
        { id: 'name_bearer', name: 'Name the Bearer', weight: 1, effects: [{ type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'bearer' }, { type: 'corruption', amount: 3 }] },
        { id: 'call_gatewatch', name: 'Call the Gatewatch', weight: 1, effects: [{ type: 'summon', enemy: 'ashguard_spear' }] }
      ]
    },
    cinderworm: {
      name: 'Cinderworm', act: 3, tier: 'normal', maxHp: 88, glyph: 'wyrm', pattern: 'cycle',
      blurb: "A blind worm that swims through hot ash and surfaces under your feet.",
      intents: [
        { id: 'burrow', name: 'Burrow', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }] },
        { id: 'erupt', name: 'Erupt', weight: 1, effects: [{ type: 'damage', amount: 10, target: 'all_foes' }] },
        { id: 'searing_maw', name: 'Searing Maw', weight: 1, effects: [{ type: 'damage', amount: 20, target: 'foe', pick: 'random' }] }
      ]
    },
    kiln_troll: {
      name: 'Kiln Troll', act: 3, tier: 'elite', maxHp: 170, glyph: 'troll', pattern: 'cycle',
      blurb: "A troll the forge-masters armoured in cooling slag. Every step it takes leaves a smoking print.",
      intents: [
        { id: 'slag_maul', name: 'Slag Maul', weight: 1, effects: [{ type: 'damage', amount: 24, target: 'foe', pick: 'highest' }] },
        { id: 'quake', name: 'Quake', weight: 1, effects: [{ type: 'damage', amount: 11, target: 'all_foes' }] },
        { id: 'furnace_roar', name: 'Furnace Roar', weight: 1, effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }, { type: 'hope', amount: -10 }] },
        { id: 'harden', name: 'Harden', weight: 1, effects: [{ type: 'status', status: 'guard', turns: 2, target: 'self' }] }
      ]
    },
    burnt_inquisitor: {
      name: 'The Burnt Inquisitor', act: 3, tier: 'elite', maxHp: 162, glyph: 'priest', pattern: 'cycle',
      blurb: "A high priest of the forge-cult who burned away everything soft in himself and calls what is left faith.",
      intents: [
        { id: 'confess', name: 'Demand Confession', weight: 1, effects: [{ type: 'corruption', amount: 8 }] },
        { id: 'scourge', name: 'Scourge', weight: 1, effects: [{ type: 'damage', amount: 14, target: 'foe', pick: 'lowest' }, { type: 'status', status: 'bleed', turns: 3, amount: 3, target: 'foe', pick: 'lowest' }] },
        { id: 'call_faithful', name: 'Call the Faithful', weight: 1, effects: [{ type: 'summon', enemy: 'kiln_priest' }] },
        { id: 'rite', name: 'Rite of Embers', weight: 1, effects: [{ type: 'heal', amount: 10, target: 'all_friends' }] }
      ]
    },
    cinder_regent: {
      name: 'The Cinder Regent', act: 3, tier: 'boss', maxHp: 308, glyph: 'herald', pattern: 'cycle',
      blurb: "The Sovereign's steward, crowned in living embers, who has kept the gate of Mount Cindral for a thousand years and will not step aside for a courier.",
      intents: [
        { id: 'brand', name: 'Brand the Bearer', weight: 1, effects: [{ type: 'corruption', amount: 8 }, { type: 'status', status: 'mark', turns: 2, target: 'foe', pick: 'bearer' }] },
        { id: 'decree', name: 'Decree of Ash', weight: 1, effects: [{ type: 'damage', amount: 11, target: 'all_foes' }, { type: 'hope', amount: -10 }] },
        { id: 'sunder', name: 'Sunder', weight: 1, effects: [{ type: 'damage', amount: 24, target: 'foe', pick: 'highest' }] },
        { id: 'gatewatch', name: 'Call the Gatewatch', weight: 1, effects: [{ type: 'summon', enemy: 'ashguard_spear' }] }
      ]
    }
  },

  /* ------------------------------------------------------------ ENCOUNTERS */
  /* Normal groups are listed from easier to harder. */
  encounters: {
    1: {
      normal: [
        ['ash_hound', 'ash_hound'],
        ['hedge_cutthroat', 'marsh_midges'],
        ['whisperwood_weaver', 'whisperwood_weaver'],
        ['ember_pilgrim', 'hedge_cutthroat'],
        ['fen_lurker', 'marsh_midges'],
        ['mire_ghoul', 'whisperwood_shade'],
        ['ember_pilgrim', 'whisperwood_shade', 'ember_pilgrim'],
        ['ash_hound', 'mire_ghoul', 'fen_lurker']
      ],
      elite: [
        ['thornback_troll'],
        ['tithe_taker', 'hedge_cutthroat']
      ],
      boss: [
        ['hollow_huntsman']
      ]
    },
    2: {
      normal: [
        ['greyspire_wolf', 'greyspire_wolf'],
        ['blindwing_swarm', 'delver_husk'],
        ['pass_reaver', 'ash_acolyte'],
        ['cistern_lurker', 'blindwing_swarm'],
        ['delver_sentinel', 'deep_echo'],
        ['delver_husk', 'deep_echo', 'delver_husk'],
        ['greyspire_wolf', 'pass_reaver', 'greyspire_wolf'],
        ['ash_acolyte', 'delver_sentinel', 'ash_acolyte']
      ],
      elite: [
        ['slatehide_troll'],
        ['undervault_wyrm'],
        ['slatehide_troll', 'blindwing_swarm']
      ],
      boss: [
        ['last_warden']
      ]
    },
    3: {
      normal: [
        ['cinder_hound', 'cinder_hound'],
        ['ember_moths', 'ashguard_spear'],
        ['kiln_priest', 'slag_ghoul'],
        ['smoke_wraith', 'cinder_hound'],
        ['cinderworm', 'ember_moths'],
        ['march_herald', 'ashguard_spear'],
        ['smoke_wraith', 'kiln_priest', 'cinder_hound'],
        ['slag_ghoul', 'ashguard_spear', 'kiln_priest']
      ],
      elite: [
        ['kiln_troll'],
        ['burnt_inquisitor'],
        ['kiln_troll', 'ember_moths']
      ],
      boss: [
        ['cinder_regent']
      ]
    }
  },

  /* ---------------------------------------------------------------- EVENTS */
  events: [
    /* ======== Act 1: The Low Roads ======== */
    {
      id: 'mossbridge_toll', title: 'The Toll at Mossbridge', acts: [1], once: true,
      text: "Mossbridge is three planks and a rope, and tonight it has a keeper. He is a broad man with a lantern, and his two friends hold cudgels. 'Toll's gone up,' he says, looking at your pack instead of your face. 'Ten silver for the lot of you, or the river's free.' The water below runs brown and fast with snowmelt. Behind you, the road back to Thistledown is already dark.",
      choices: [
        { label: 'Pay the toll (10 silver)', requires: { silver: 10 },
          outcome: { text: "He bites a coin, grins, and waves you across. Your purse is lighter, and somehow so are you.", effects: [{ type: 'silver', amount: -10 }] } },
        { label: 'Let Brakka stand at the front', requires: { companion: 'brakka' },
          outcome: { text: "Brakka sets her shield on the planks and says nothing at all. The keeper remembers he has somewhere else to be.", effects: [{ type: 'hope', amount: 4 }] } },
        { label: 'Wade the river downstream',
          outcome: { text: "The current takes your footing twice and a sack of food once. You climb out cold, bruised and short of bread.", effects: [{ type: 'damage', target: 'all', amount: 3 }, { type: 'supplies', amount: -2 }] } },
        { label: 'Refuse, and let them try their luck',
          outcome: { text: "The cudgels come up. So does your sling.", effects: [{ type: 'battle', tier: 'normal' }] } }
      ]
    },
    {
      id: 'beekeeper', title: "The Beekeeper's Gate", acts: [1], once: true,
      text: "At the edge of the vale a low cottage hums with bees. The beekeeper is older than her hives and twice as watchful. She passes you bread and honey over the gate, then stops, head tilted, as if listening to something under your coat. 'You carry a hot thing,' she says. 'My bees hate it. I could seal it in wax for you, if you pay in sweat. My north hives need moving before the rain.'",
      choices: [
        { label: 'Move the hives for her',
          outcome: { text: "The bees forgive no one. By dusk you are stung and sore, but she seals the Emberheart in a skin of wax that dulls its heat.", effects: [{ type: 'damage', target: 'all', amount: 4 }, { type: 'corruption', amount: -8 }] } },
        { label: 'Buy a pot of her salve (8 silver)', requires: { silver: 8 },
          outcome: { text: "She wraps a jar of green salve in a leaf and ties it with grass. It smells of summer.", effects: [{ type: 'silver', amount: -8 }, { type: 'item', id: 'silverleaf_salve' }] } },
        { label: 'Thank her and go',
          outcome: { text: "She watches you all the way to the trees. The bread was very good.", effects: [{ type: 'supplies', amount: 1 }] } }
      ]
    },
    {
      id: 'path_that_moves', title: 'The Path That Moves', acts: [1], once: true,
      text: "The Whisperwood does not like straight lines. The path you took at noon brings you back, at dusk, to the same split oak with the same crow on the same branch. Your food is not getting heavier. In your coat the Emberheart is warm and patient. It knows the way, you realise. It has always known the way, and it would be glad to show you.",
      choices: [
        { label: 'Read the moss and the light',
          outcome: { chance: 0.5, chanceBonus: { companion: 'ysolde', amount: 0.35 },
            success: { text: "You find the true path under the false one, a deer track that runs straight as a thread. You leave the trees a day early.", effects: [{ type: 'supplies', amount: 2 }, { type: 'hope', amount: 4 }] },
            fail: { text: "Two more days of circles. The crow is laughing at you now, you are sure of it.", effects: [{ type: 'supplies', amount: -3 }, { type: 'hope', amount: -4 }] } } },
        { label: 'Let the Emberheart lead',
          outcome: { text: "Your feet know where to go before you do, and the trees seem to lean aside. It is very easy, and that is the worst part.", effects: [{ type: 'corruption', amount: 8 }, { type: 'supplies', amount: 2 }] } },
        { label: 'Cut straight through the thorns',
          outcome: { text: "Nothing in this wood is straight, so you make something straight. It costs blood and cloth.", effects: [{ type: 'damage', target: 'all', amount: 4 }] } }
      ]
    },
    {
      id: 'webbed_larder', title: 'The Webbed Larder', acts: [1], once: true,
      text: "Between two birches hangs a bundle wrapped in grey silk, the size of a traveller's pack. Something inside it glints. The threads around it still tremble, though there is no wind. High in the dark of the canopy, many small lights blink and go still. Whoever owned the pack is not coming back for it. The only question is whether you want it more than its new owners do.",
      choices: [
        { label: 'Cut it down quietly',
          outcome: { chance: 0.55, chanceBonus: { companion: 'neve', amount: 0.3 },
            success: { text: "The bundle drops into your arms and you are gone before the lights begin to move. Inside are coins and something useful.", effects: [{ type: 'silver', amount: 10 }, { type: 'item', id: 'random' }] },
            fail: { text: "A thread snaps with a sound like a plucked string. The lights come down.", effects: [{ type: 'battle', tier: 'normal' }] } } },
        { label: 'Burn the web from a distance (1 supply of oil)', requires: { supplies: 1 },
          outcome: { text: "The silk goes up with a hiss and the bundle falls, scorched. Some of what was inside survives.", effects: [{ type: 'supplies', amount: -1 }, { type: 'silver', amount: 6 }] } },
        { label: 'Leave it hanging',
          outcome: { text: "You walk on. Behind you, the trembling stops.", effects: [] } }
      ]
    },
    {
      id: 'sunken_cart', title: 'The Sunken Cart', acts: [1], once: true,
      text: "In the Fenmarsh a pedlar's cart has slid off the causeway and sunk to its axles. The mule is up to its chest in black water, eyes rolling. The pedlar is nowhere to be seen. Crates of salt pork and lamp oil ride the top of the load, dry for now. The mud is in no hurry. Whatever you decide, decide it before the mule goes under.",
      choices: [
        { label: 'Haul the cart out together',
          outcome: { text: "It takes every back you have and most of the afternoon. The mule lives, and you take a fair share of the load for your trouble.", effects: [{ type: 'damage', target: 'all', amount: 4 }, { type: 'supplies', amount: 3 }, { type: 'hope', amount: 5 }] } },
        { label: 'Let Brakka take the yoke', requires: { companion: 'brakka' },
          outcome: { text: "Brakka wades in, sets her shoulder under the axle and lifts. The marsh lets go with a long sucking groan.", effects: [{ type: 'damage', target: 'brakka', amount: 6 }, { type: 'supplies', amount: 4 }, { type: 'hope', amount: 6 }] } },
        { label: 'Take what floats and go',
          outcome: { text: "You fill your packs from the top crates. You do not look back at the mule, and you hear it anyway.", effects: [{ type: 'supplies', amount: 5 }, { type: 'hope', amount: -6 }] } }
      ]
    },
    {
      id: 'wrong_road_pilgrims', title: 'Pilgrims on the Wrong Road', acts: [1], once: true,
      text: "A file of villagers walks east along the dyke, humming one low note between them. Their eyes are wet and bright. As they pass you the humming stops, and every head turns toward your coat. 'It called us,' an old man says gently. 'Let us touch it. Only once. Then we will go home.' The others hold out their hands, and some of them hold out coins.",
      choices: [
        { label: 'Let Tamsin sing them back to themselves', requires: { companion: 'tamsin' },
          outcome: { text: "Tamsin starts a harvest song from the vale, slow and silly. One by one they join in, then stop, then blink at the marsh as if waking.", effects: [{ type: 'hope', amount: 8 }, { type: 'corruption', amount: -4 }] } },
        { label: 'Let them touch it',
          outcome: { text: "Each hand that brushes your coat leaves the Emberheart warmer. They press their coins on you and walk on east, smiling.", effects: [{ type: 'silver', amount: 15 }, { type: 'corruption', amount: 6 }, { type: 'hope', amount: -4 }] } },
        { label: 'Drive them off',
          outcome: { text: "You draw steel. Some of them flee. The ones who stay are not villagers anymore.", effects: [{ type: 'battle', tier: 'normal' }] } },
        { label: 'Slip away through the reeds',
          outcome: { text: "You lose half a day and a sack of food to the bog, but you lose them too.", effects: [{ type: 'supplies', amount: -2 }] } }
      ]
    },
    {
      id: 'burning_mill', title: 'The Burning Mill', acts: [1], once: true,
      text: "Smoke rises over the vale. A watermill is burning, its wheel still turning, throwing sparks into the millpond. A woman on the bank is screaming a name toward the upper window. The fire already has the stairs. You feel the Emberheart stir against your ribs like a cat that has seen a bird. Fire is an old friend of the thing you carry. It could call this one home.",
      choices: [
        { label: 'Run in through the smoke',
          outcome: { chance: 0.6, chanceBonus: { companion: 'brakka', amount: 0.25 },
            success: { text: "You stagger out coughing with a boy over your shoulder. His mother cannot stop thanking you, and the vale will remember.", effects: [{ type: 'hope', amount: 10 }, { type: 'damage', target: 'random', amount: 4 }] },
            fail: { text: "A beam falls before you reach the stair. You drag yourself out burned, and a neighbour gets the boy out instead.", effects: [{ type: 'damage', target: 'random', amount: 10 }, { type: 'hope', amount: 3 }] } } },
        { label: 'Call the fire into the Emberheart',
          outcome: { text: "You hold out your hand. The flames lean toward you, pour across the yard and vanish into your coat. The mill smokes, black and quiet, and the Emberheart purrs.", effects: [{ type: 'corruption', amount: 10 }, { type: 'hope', amount: 12 }] } },
        { label: 'You cannot stop. Walk on.',
          outcome: { text: "You keep your eyes on the road. The screaming follows you longer than the smoke does.", effects: [{ type: 'hope', amount: -8 }] } }
      ]
    },
    {
      id: 'frost_hoofprints', title: 'Frost in Midsummer', acts: [1], once: true,
      text: "The night is warm until it is not. Frost creeps across the grass in one long straight line, and in the frost are cloven tracks the size of plates, with antler-scrapes on the bark above them. Far off a horn sounds once, low and hollow. Hounds answer it. Something on this road is hunting, and it is not hunting deer. The Emberheart has gone very still in your pocket, and that frightens you more than the horn.",
      choices: [
        { label: 'Lie flat in the barley and keep still',
          outcome: { chance: 0.6, chanceBonus: { companion: 'ysolde', amount: 0.3 },
            success: { text: "Hounds run through the rows on either side of you, close enough to touch. Then the horn calls them on, and the frost melts off the stalks.", effects: [{ type: 'hope', amount: 3 }] },
            fail: { text: "A stalk snaps under your knee. A hound stops, bays, and the rest of the pack comes running.", effects: [{ type: 'battle', tier: 'normal' }] } } },
        { label: 'Let the Emberheart throw your scent',
          outcome: { text: "You hold it up, and it flings your scent across the valley like a stone skipping on water. The horn turns north after it. Your palm smells of scorched hair for a day.", effects: [{ type: 'corruption', amount: 7 }] } },
        { label: 'Run for the river',
          outcome: { text: "You run until your lungs burn and the water takes your scent. Some of your food takes a swim too.", effects: [{ type: 'supplies', amount: -2 }, { type: 'damage', target: 'all', amount: 3 }] } }
      ]
    },
    {
      id: 'letter_home', title: 'A Letter for Thistledown', acts: [1], once: true,
      text: "At a crossroads you meet a carter heading back the way you came, toward the vale and home. He has room for a letter, he says, for a few coins. You have carried a hundred letters for other people. You have never once written your own. You think of the kitchen at home, the sound of the latch, and how little you are allowed to say about where you are going.",
      choices: [
        { label: 'Write home and pay him (4 silver)', requires: { silver: 4 },
          outcome: { text: "You write three lines and cross out two. It is enough. The carter tucks it into his hat.", effects: [{ type: 'silver', amount: -4 }, { type: 'hope', amount: 8 }] } },
        { label: 'Ask for his news instead',
          outcome: { text: "His news is of cold nights and hounds in the hills. He shares his bread anyway.", effects: [{ type: 'supplies', amount: 2 }, { type: 'hope', amount: -3 }] } },
        { label: 'Send nothing. It is safer.',
          outcome: { text: "You let him go. Safer, you tell yourself, and it is, and it does not help.", effects: [] } }
      ]
    },
    {
      id: 'quiet_lamp', title: 'The Shrine of the Quiet Lamp', acts: [1], once: true,
      text: "Where the Fenmarsh meets the woods stands a stone hut no bigger than a cupboard. Inside, an iron lamp hangs over a bowl of offerings: buttons, coins, a child's tin horse. Nobody has lit the lamp in years. The old stories say that a lamp lit here keeps the dark from following you. The old stories say a lot of things, and you are very tired of the dark.",
      choices: [
        { label: 'Light it with your own oil and keep vigil (1 supply)', requires: { supplies: 1 },
          outcome: { text: "You sit with the small flame until dawn. When you leave, the Emberheart feels further away than it has in days.", effects: [{ type: 'supplies', amount: -1 }, { type: 'corruption', amount: -8 }, { type: 'hope', amount: 2 }] } },
        { label: 'Let Maddoc tend the lamp', requires: { companion: 'maddoc' },
          outcome: { text: "Maddoc trims the wick and speaks words you do not know over it. The light is steady and clean, and some of the cold leaves your chest.", effects: [{ type: 'corruption', amount: -14 }, { type: 'hope', amount: 4 }] } },
        { label: 'Take the coins from the bowl',
          outcome: { text: "Twelve silver in old coin. The tin horse stares at you as you pocket them.", effects: [{ type: 'silver', amount: 12 }, { type: 'hope', amount: -6 }] } }
      ]
    },

    /* ======== Act 2: The Mountain Roads ======== */
    {
      id: 'snow_shelf', title: 'The Snow Shelf', acts: [2], once: true,
      text: "The Greyspire path runs under a lip of old snow that hangs over it like a wave about to break. Now and then it groans. Ice dust sifts down onto your hood. There is no other way through this pass except back, and back is two days. The Emberheart is warm against your chest. It could turn the snow to water, you think. All of it, all at once.",
      choices: [
        { label: 'Cross one at a time, quietly',
          outcome: { chance: 0.6, chanceBonus: { companion: 'ysolde', amount: 0.25 },
            success: { text: "One by one you creep under the shelf, breathing through your sleeves. Nothing falls. On the far side you all laugh too loudly.", effects: [{ type: 'hope', amount: 5 }] },
            fail: { text: "Halfway across, the shelf lets go. You dig each other out of the snow, bruised, and lose a pack to the gorge.", effects: [{ type: 'damage', target: 'all', amount: 7 }, { type: 'supplies', amount: -2 }] } } },
        { label: 'Melt it with the Emberheart',
          outcome: { text: "Heat pours out of your hand. The shelf slumps into a hissing river and runs off the mountain, and the path lies clear and steaming.", effects: [{ type: 'corruption', amount: 10 }, { type: 'hope', amount: 2 }] } },
        { label: 'Go back and around (4 supplies)', requires: { supplies: 4 },
          outcome: { text: "Two days of cold and climbing. You arrive tired and hungry, but whole.", effects: [{ type: 'supplies', amount: -4 }] } }
      ]
    },
    {
      id: 'frozen_climber', title: 'The Frozen Climber', acts: [2], once: true,
      text: "A climber sits against the rock at a bend in the pass, frozen solid, with a faint smile on his face. His pack is full. A satchel of letters hangs at his hip, sealed and addressed in a careful hand to people in valleys you have never seen. You are a courier. You know what it means to carry something for someone else, and what it means when nobody does.",
      choices: [
        { label: 'Take his pack',
          outcome: { text: "Dried meat, a flint, a good wool scarf. He will not miss them. You keep telling yourself that.", effects: [{ type: 'supplies', amount: 5 }, { type: 'hope', amount: -4 }] } },
        { label: 'Take his letters to carry on',
          outcome: { text: "You slip the letters into your own bag. They weigh almost nothing, and they make you feel like yourself again.", effects: [{ type: 'hope', amount: 5 }, { type: 'corruption', amount: -4 }] } },
        { label: 'Build him a cairn (1 supply)', requires: { supplies: 1 },
          outcome: { text: "You stack stones over him until the wind cannot find him. It takes until dark, and it was worth it.", effects: [{ type: 'supplies', amount: -1 }, { type: 'hope', amount: 9 }] } }
      ]
    },
    {
      id: 'weighing_hall', title: 'The Weighing Hall', acts: [2], once: true,
      text: "In the dry upper halls of Undervault you find a chamber with a bronze scale as tall as a house. The Delvers carved pictures around its base, and their meaning is plain: a figure lays something down, and the scale gives back something of equal weight. One pan is empty. The other holds grey dust that was once somebody's treasure. The air smells of old metal and dust.",
      choices: [
        { label: 'Lay down 15 silver', requires: { silver: 15 },
          outcome: { text: "The pan sinks. Something clicks deep in the floor, and a panel slides open beside the scale.", effects: [{ type: 'silver', amount: -15 }, { type: 'boon' }] } },
        { label: 'Lay down your own blood',
          outcome: { text: "Each of you cuts a palm over the pan. The scale dips, and you feel the mountain's stubbornness settle into your bones.", effects: [{ type: 'damage', target: 'all', amount: 6 }, { type: 'maxhp', target: 'all', amount: 4 }] } },
        { label: 'Lay down the Emberheart',
          outcome: { text: "The pan slams down so hard the floor cracks. When you snatch the Emberheart back it is hotter, and the dust in the other pan has turned to coin.", effects: [{ type: 'corruption', amount: 10 }, { type: 'silver', amount: 25 }] } },
        { label: 'Touch nothing',
          outcome: { text: "Some bargains are better left unweighed. You walk on.", effects: [] } }
      ]
    },
    {
      id: 'drowned_archive', title: 'The Drowned Archive', acts: [2], once: true,
      text: "The Delvers kept their records in stone cases along a sunken gallery. Most of the gallery is under black water now. The top shelves are dry and crusted with salt, their carvings still sharp. Below the surface, through the cold clear water, you can see sealed cases still standing, and something long and pale that drifts between them and is gone.",
      choices: [
        { label: 'Dive for a sealed case',
          outcome: { chance: 0.55,
            success: { text: "You surface gasping with a stone case in your arms. Inside, wrapped in oilcloth, are coins and something the Delvers thought worth keeping dry.", effects: [{ type: 'silver', amount: 10 }, { type: 'item', id: 'random' }] },
            fail: { text: "Something brushes your leg in the dark. You come up empty, with a long cut down your calf.", effects: [{ type: 'damage', target: 'bearer', amount: 8 }] } } },
        { label: 'Let Maddoc read the dry shelves', requires: { companion: 'maddoc' },
          outcome: { text: "Maddoc reads by lantern-light for an hour. The Delvers knew the Emberheart's kind, he says, and they cooled it by naming the things they loved. He teaches you how.", effects: [{ type: 'corruption', amount: -10 }, { type: 'hope', amount: 5 }] } },
        { label: 'Study the carvings you can reach (1 supply)', requires: { supplies: 1 },
          outcome: { text: "You make out a burning star and a forge inside a mountain. It is not comforting, but it is a map, of a kind.", effects: [{ type: 'supplies', amount: -1 }, { type: 'hope', amount: 4 }] } }
      ]
    },
    {
      id: 'long_rail', title: 'The Long Rail', acts: [2], once: true,
      text: "An iron cart sits at the top of a rail that plunges into the dark of Undervault. The Delvers used it to carry ore down to the deep forges. The wheels still turn when you push them. A painted arrow on the wall points downward, the way you need to go. You can hear water somewhere far below, and you can feel the long drop between here and there.",
      choices: [
        { label: 'Ride the cart down',
          outcome: { chance: 0.55, chanceBonus: { companion: 'brakka', amount: 0.3 },
            success: { text: "Wind and dark and shouting, and then the cart rolls to a stop in a lit hall far below. You have saved days of walking.", effects: [{ type: 'supplies', amount: 4 }, { type: 'hope', amount: 4 }] },
            fail: { text: "The cart jumps the rail at a bend. You limp the rest of the way down.", effects: [{ type: 'damage', target: 'all', amount: 6 }] } } },
        { label: 'Take the stairs (2 supplies)', requires: { supplies: 2 },
          outcome: { text: "Ten thousand steps, each one carved by hands long dead. Your legs will remember every one of them.", effects: [{ type: 'supplies', amount: -2 }] } }
      ]
    },
    {
      id: 'your_own_voice', title: 'Your Own Voice', acts: [2], once: true,
      when: { minCorruption: 40 },
      text: "In the deep halls an echo answers before you speak. It uses your voice. It says the things you have not let yourself think: that your friends slow you down, that the Forge is a grave, that you could make every road safe if you only kept what you carry. It is very reasonable. It is tired of being carried, it says, in your voice, and so are you.",
      choices: [
        { label: 'Listen to the end',
          outcome: { text: "You let it finish. When it does, your hands are steady and strong, and they do not feel like yours.", effects: [{ type: 'corruption', amount: 12 }, { type: 'maxhp', target: 'wren', amount: 6 }, { type: 'heal', target: 'bearer', amount: 12 }] } },
        { label: 'Shout it down',
          outcome: { text: "You shout until your throat is raw and the echo falls silent. Everyone stares at you for a long time afterwards.", effects: [{ type: 'hope', amount: -4 }, { type: 'corruption', amount: -6 }] } },
        { label: 'Let Tamsin sing over it', requires: { companion: 'tamsin' },
          outcome: { text: "Tamsin sings a counting song, loud and off-key. The echo cannot hold your voice and hers at once, and it stops.", effects: [{ type: 'corruption', amount: -10 }, { type: 'hope', amount: 4 }] } }
      ]
    },
    {
      id: 'high_pasture', title: 'Goatherds of the High Pasture', acts: [2], once: true,
      text: "Above the snowline you find a stone hut, a smoking chimney and a family of goatherds who have never heard of the Sovereign and do not care to. They have cheese, smoked meat and a stack of good blankets. They also have a kid goat lost somewhere on the crags, and a sky that promises snow by dark. The mother looks at your sling, then at the cliffs.",
      choices: [
        { label: 'Buy food (10 silver)', requires: { silver: 10 },
          outcome: { text: "They drive a hard bargain and a fair one. Your packs are heavier and so are your hearts, in the good way.", effects: [{ type: 'silver', amount: -10 }, { type: 'supplies', amount: 6 }] } },
        { label: 'Climb for the lost kid',
          outcome: { chance: 0.6, chanceBonus: { companion: 'ysolde', amount: 0.25 },
            success: { text: "You find it bleating on a ledge and carry it down under one arm. The family feeds you like heroes.", effects: [{ type: 'supplies', amount: 4 }, { type: 'hope', amount: 6 }, { type: 'heal', target: 'all', amount: 6 }] },
            fail: { text: "The ledge crumbles under you. You come back scraped and empty-handed, and they thank you anyway.", effects: [{ type: 'damage', target: 'random', amount: 6 }, { type: 'hope', amount: 2 }] } } },
        { label: 'Ask only for a night by their fire (1 supply)', requires: { supplies: 1 },
          outcome: { text: "They give it without a word. You sleep warm for the first time in weeks.", effects: [{ type: 'heal', target: 'all', amount: 10 }, { type: 'supplies', amount: -1 }] } }
      ]
    },
    {
      id: 'wolf_den', title: 'Bones at the Den Mouth', acts: [2], once: true,
      text: "A blizzard comes down the pass like a wall. The only shelter is a cave mouth heaped with gnawed bones. Inside, yellow eyes catch your light and a low growl fills the rock. Behind you the snow is already up to your knees, and the wind cuts through your cloaks as if they were paper. You will not last the night out here.",
      choices: [
        { label: 'Clear the den and take it',
          outcome: { text: "You draw steel and step into the dark. The growl becomes a snarl, and the yellow eyes come at you.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'heal', target: 'all', amount: 8 }] } },
        { label: 'Let Neve smoke them out', requires: { companion: 'neve' },
          outcome: { chance: 0.7,
            success: { text: "Neve feeds green pine onto a fire at the cave mouth. Thick smoke rolls in, and the wolves bolt past you into the snow and do not come back.", effects: [{ type: 'heal', target: 'all', amount: 8 }, { type: 'hope', amount: 3 }] },
            fail: { text: "The wind turns and blows the smoke back in your faces. The pack comes out snarling.", effects: [{ type: 'battle', tier: 'normal' }] } } },
        { label: 'Push on through the storm',
          outcome: { text: "You walk all night with your heads down. In the morning you are frostbitten and alive.", effects: [{ type: 'damage', target: 'all', amount: 5 }, { type: 'hope', amount: -4 }] } }
      ]
    },
    {
      id: 'quiet_tomb', title: 'The Quiet Tomb', acts: [2], once: true,
      text: "Behind a fallen door lies a Delver tomb, untouched. A stone figure sleeps on the lid with a hammer on its chest. Around it are grave gifts: a coat of fine mail, cups of dull silver, a small bronze lamp. Carved over the door, in pictures even you can read, is a hand reaching for the gifts. Beside it is the same hand, withered.",
      choices: [
        { label: 'Take the grave-silver',
          outcome: { text: "The cups are heavy and cold, and they do not warm in your hands. You feel watched for the rest of the day.", effects: [{ type: 'silver', amount: 25 }, { type: 'hope', amount: -6 }, { type: 'corruption', amount: 3 }] } },
        { label: 'Let Rook search it properly', requires: { companion: 'rook' },
          outcome: { chance: 0.7,
            success: { text: "Rook finds the pressure plate, wedges it with a knife and empties the tomb like a craftsman. 'The dead don't spend,' he says.", effects: [{ type: 'silver', amount: 30 }] },
            fail: { text: "He misses one plate. A dart of old bronze finds his arm, and he swears for an hour.", effects: [{ type: 'silver', amount: 30 }, { type: 'damage', target: 'rook', amount: 10 }] } } },
        { label: 'Take the mail coat',
          outcome: { text: "It fits better than it should. Whoever wears it walks a little taller and a little colder.", effects: [{ type: 'maxhp', target: 'random', amount: 6 }, { type: 'hope', amount: -4 }] } },
        { label: 'Leave the dead their gifts',
          outcome: { text: "You bow to the sleeper and close the door. The halls feel less hostile after.", effects: [{ type: 'hope', amount: 5 }] } }
      ]
    },
    {
      id: 'flooded_stair', title: 'The Flooded Stair', acts: [2], once: true,
      text: "The great stair down to the lower gates is flooded to the ceiling: black water, perfectly still. On the far side, you know, the stair climbs out again onto the deep road. A Delver wall beside it is cracked from top to bottom, and cold air breathes through the crack. In your coat the Emberheart ticks like a cooling stove, waiting to be asked.",
      choices: [
        { label: 'Swim it, holding your breath',
          outcome: { text: "It is long. Longer than you thought. You come up on the far side gasping and shaking, every one of you.", effects: [{ type: 'damage', target: 'all', amount: 5 }, { type: 'hope', amount: -2 }] } },
        { label: 'Let Brakka break the cracked wall', requires: { companion: 'brakka' },
          outcome: { text: "Brakka sets her shoulder and her hammer to it. It takes an hour and a bloody hand, but the wall opens on a dry passage.", effects: [{ type: 'damage', target: 'brakka', amount: 6 }, { type: 'hope', amount: 3 }] } },
        { label: 'Boil the water away',
          outcome: { text: "You hold the Emberheart over the water. Steam roars up the stair until nothing is left but wet stone and dead pale fish.", effects: [{ type: 'corruption', amount: 8 }] } },
        { label: 'Search for another way (3 supplies)', requires: { supplies: 3 },
          outcome: { text: "Three days of side passages and dead ends. You find the deep road in the end, hungry.", effects: [{ type: 'supplies', amount: -3 }] } }
      ]
    },

    /* ======== Act 3: The Ashen March ======== */
    {
      id: 'chained_column', title: 'The Chained Column', acts: [3], once: true,
      text: "A column of prisoners shuffles across the cinder plain toward the forge-works, chained neck to neck. Four guards walk beside them, bored and armed. The prisoners do not look up. One of them is a girl no older than you were when you carried your first letter. Against your ribs the shard gives one slow beat. Chains are only metal, and metal only wants to melt.",
      choices: [
        { label: 'Attack the guards',
          outcome: { text: "You come out of the ash at a run. The guards drop the chains and reach for their spears.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'hope', amount: 10 }] } },
        { label: 'Melt the chains with the Emberheart',
          outcome: { text: "You touch the first link and the whole chain runs like water. The guards flee. The prisoners stare at you with a gratitude that looks a lot like fear.", effects: [{ type: 'corruption', amount: 12 }, { type: 'hope', amount: 12 }] } },
        { label: 'Let Rook pick the locks at night', requires: { companion: 'rook' },
          outcome: { chance: 0.65,
            success: { text: "Rook moves down the line in the dark, one lock at a time. By dawn the column is gone and the guards are still asleep.", effects: [{ type: 'hope', amount: 12 }] },
            fail: { text: "A lock squeals. A guard wakes.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'hope', amount: 6 }] } } },
        { label: 'Let them pass',
          outcome: { text: "You lie flat in the ash until they are gone. You will see the girl's face for a long time.", effects: [{ type: 'hope', amount: -10 }] } }
      ]
    },
    {
      id: 'ash_spring', title: 'A Spring Under the Ash', acts: [3], once: true,
      text: "In a hollow of black rock you find water: a clear spring bubbling up through the cinders, edged with pale moss, the first green thing in days. Your skins are nearly dry and your lips are cracked. The water looks clean. But in the Ashen March, nothing is what it looks like until you touch it. The Emberheart says nothing at all, which is not like it.",
      choices: [
        { label: 'Drink deep and fill every skin',
          outcome: { chance: 0.65,
            success: { text: "It is cold and sweet and real. You drink until your bellies ache and fill every skin you own.", effects: [{ type: 'heal', target: 'all', amount: 12 }, { type: 'supplies', amount: 3 }] },
            fail: { text: "It tastes of iron and ash. By nightfall you are all sick, and the Emberheart is pleased.", effects: [{ type: 'damage', target: 'all', amount: 5 }, { type: 'corruption', amount: 4 }] } } },
        { label: 'Let Maddoc test it with lantern-light', requires: { companion: 'maddoc' },
          outcome: { text: "Maddoc holds his lantern over the water and watches the colour of the flame. 'Clean,' he says at last. 'Drink.'", effects: [{ type: 'heal', target: 'all', amount: 12 }, { type: 'supplies', amount: 3 }] } },
        { label: 'Leave it',
          outcome: { text: "You walk on with dry mouths. Better thirsty than poisoned.", effects: [] } }
      ]
    },
    {
      id: 'empty_watchpost', title: 'The Empty Watchpost', acts: [3], once: true,
      text: "A watchpost stands abandoned on a cinder ridge, its fire still warm. Grey cloaks of the Ashen March hang on pegs by the door, and a supply chest sits under the table. From the ridge you can see a patrol two miles off, coming this way. They will reach the post by nightfall, and they will want their supper and their beds.",
      choices: [
        { label: 'Wear their cloaks and march openly',
          outcome: { chance: 0.55, chanceBonus: { companion: 'rook', amount: 0.2 },
            success: { text: "The patrol waves you on as their own. You even share their fire and their rations.", effects: [{ type: 'supplies', amount: 4 }, { type: 'hope', amount: 4 }] },
            fail: { text: "A sergeant asks a question you cannot answer.", effects: [{ type: 'battle', tier: 'elite' }] } } },
        { label: 'Loot the chest and run',
          outcome: { text: "Hard bread, salt meat and a purse. You are over the ridge before the patrol arrives.", effects: [{ type: 'supplies', amount: 3 }, { type: 'silver', amount: 10 }] } },
        { label: 'Burn the post and wait for them',
          outcome: { text: "It burns well. The patrol comes running, and you are ready for it.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'hope', amount: 8 }] } }
      ]
    },
    {
      id: 'deserter', title: 'The Deserter', acts: [3], once: true,
      text: "Under a slag heap you find a soldier of the March, young, burned along one arm, hiding from his own side. He raises empty hands. 'I won't go back,' he says. 'I'd sooner you killed me. But I know the gatewatch, and I know where they don't look.' His eyes keep sliding to your coat and then away, as if looking at it hurts.",
      choices: [
        { label: 'Share your food and hear him out (2 supplies)', requires: { supplies: 2 },
          outcome: { text: "He eats like a starving dog and talks like a flood. You learn where the patrols turn and where the water hides.", effects: [{ type: 'supplies', amount: -2 }, { type: 'hope', amount: 8 }] } },
        { label: 'Let Tamsin talk with him', requires: { companion: 'tamsin' },
          outcome: { text: "Tamsin sits beside him and asks about his mother. By the end he is crying, and he gives you his officer's purse and a flask he stole.", effects: [{ type: 'silver', amount: 12 }, { type: 'item', id: 'clearwater_flask' }, { type: 'hope', amount: 4 }] } },
        { label: 'Take what he carries',
          outcome: { text: "He does not fight. He only watches you do it.", effects: [{ type: 'supplies', amount: 3 }, { type: 'silver', amount: 8 }, { type: 'hope', amount: -8 }] } },
        { label: 'Send him away',
          outcome: { text: "He goes without a word. Later you see smoke where he went, and you do not go to look.", effects: [{ type: 'hope', amount: -5 }] } }
      ]
    },
    {
      id: 'ember_storm', title: 'The Ember Storm', acts: [3], once: true,
      text: "The red sky darkens and then begins to fall. It is not rain. It is ash and burning grit, hissing where it lands, and it is coming fast across the plain. There is a slag ridge an hour behind you and nothing at all ahead. Under your coat the shard has begun to hum, like a kettle just before it sings. This is its weather.",
      choices: [
        { label: 'Turn back and shelter under the ridge (4 supplies)', requires: { supplies: 4 },
          outcome: { text: "You wait out the storm under the rock, rationing your water. It lasts a full day.", effects: [{ type: 'supplies', amount: -4 }] } },
        { label: 'Push through it',
          outcome: { text: "You walk with wet cloth over your faces. The grit finds every gap.", effects: [{ type: 'damage', target: 'all', amount: 7 }] } },
        { label: 'Hold up the Emberheart',
          outcome: { text: "The storm parts around you like a curtain. You walk through it untouched, and it is the most beautiful thing you have ever seen.", effects: [{ type: 'corruption', amount: 9 }] } }
      ]
    },
    {
      id: 'glass_field', title: 'The Glass Field', acts: [3], once: true,
      when: { minCorruption: 50 },
      text: "The plain here was melted once and set into a field of black glass, smooth as still water. In it you see yourself, but taller, crowned with embers, and the people of every village you passed are kneeling. The reflection smiles at you. It is a kind smile. It holds out a hand, palm up, and in the palm is your own heart, burning.",
      choices: [
        { label: 'Reach for it',
          outcome: { text: "Warmth floods your arms and legs, and your wounds close. You do not feel small anymore, and you are not sure that is good.", effects: [{ type: 'corruption', amount: 12 }, { type: 'maxhp', target: 'wren', amount: 8 }, { type: 'heal', target: 'bearer', amount: 20 }] } },
        { label: 'Smash the glass',
          outcome: { text: "You bring a stone down on your own crowned face. The field cracks for a mile in every direction, and the shard in your coat screams.", effects: [{ type: 'damage', target: 'bearer', amount: 6 }, { type: 'corruption', amount: -10 }] } },
        { label: 'Look away and keep walking',
          outcome: { text: "You keep your eyes on your boots. The reflection waits, as patient as ever.", effects: [{ type: 'hope', amount: -4 }] } }
      ]
    },
    {
      id: 'last_gardener', title: 'The Last Gardener', acts: [3], once: true,
      text: "In the middle of the ash an old man is watering a single apple tree from a dented can. The tree is small and twisted and alive. He does not look surprised to see you. 'Nobody walks this way,' he says, 'except toward the mountain. Sit, if you like. The shade is the only free thing left in the March.' His can is almost empty.",
      choices: [
        { label: 'Give him water for the tree (2 supplies)', requires: { supplies: 2 },
          outcome: { text: "He pours it slowly, the way you would pour for a friend. He says the tree will fruit next year, and you believe him.", effects: [{ type: 'supplies', amount: -2 }, { type: 'hope', amount: 12 }] } },
        { label: 'Rest in the shade (1 supply)', requires: { supplies: 1 },
          outcome: { text: "You sleep an hour under the tree. It is the best hour of the whole road.", effects: [{ type: 'supplies', amount: -1 }, { type: 'heal', target: 'all', amount: 12 }] } },
        { label: 'Take its fruit while he dozes',
          outcome: { text: "Three hard green apples. They taste of nothing, and you eat them anyway.", effects: [{ type: 'supplies', amount: 3 }, { type: 'hope', amount: -8 }] } }
      ]
    },
    {
      id: 'scavenger_caravan', title: 'The Scavenger Caravan', acts: [3], once: true,
      text: "A caravan of scavengers crawls across the plain, carts piled high with salvage from old battlefields. Their leader wears a scarf over her face and a set of scales at her belt. 'Everything here costs,' she says, 'and everything here is worth it. Out here there is nobody to buy from but me.' Her guards are many, and well fed, and bored.",
      choices: [
        { label: 'Buy 5 supplies (15 silver)', requires: { silver: 15 },
          outcome: { text: "She weighs out dried meat and stale bread as if it were gold dust. It is worth it.", effects: [{ type: 'silver', amount: -15 }, { type: 'supplies', amount: 5 }] } },
        { label: 'Buy a Clearwater Flask (12 silver)', requires: { silver: 12 },
          outcome: { text: "She hands over a stoppered flask of clear mountain water, the last of its kind for a hundred miles.", effects: [{ type: 'silver', amount: -12 }, { type: 'item', id: 'clearwater_flask' }] } },
        { label: 'Rob them',
          outcome: { text: "You go for the leader's purse. Her bored guards stop being bored.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'silver', amount: 20 }, { type: 'hope', amount: -6 }] } },
        { label: 'Move on',
          outcome: { text: "She shrugs. Out here, everyone comes back eventually.", effects: [] } }
      ]
    },
    {
      id: 'couriers_satchel', title: "A Courier's Satchel", acts: [3], once: true,
      text: "A rider of the March lies dead beside a dead horse, a satchel of orders still strapped across her chest. The seal is the Sovereign's: a black flame. You know courier's work. You know what an order looks like, how it is folded, where the seal sits. You also know what an order can do when it says the wrong thing to the right people.",
      choices: [
        { label: 'Forge new orders and send them on',
          outcome: { chance: 0.5, chanceBonus: { companion: 'rook', amount: 0.3 },
            success: { text: "Your letter sends half the gatewatch to the wrong ridge. The road ahead is quiet for days.", effects: [{ type: 'hope', amount: 8 }, { type: 'supplies', amount: 2 }] },
            fail: { text: "The forgery is found within the hour, and they come looking for whoever wrote it.", effects: [{ type: 'battle', tier: 'elite' }] } } },
        { label: 'Read the orders and burn them',
          outcome: { text: "The orders list patrol roads and water caches. You memorise what you can and burn the rest.", effects: [{ type: 'supplies', amount: 3 }, { type: 'hope', amount: 2 }] } },
        { label: 'Bury her with her letters',
          outcome: { text: "Whatever she carried, she was a courier too. You give her what you would want.", effects: [{ type: 'hope', amount: 5 }, { type: 'corruption', amount: -3 }] } }
      ]
    },
    {
      id: 'last_green_thing', title: 'The Last Green Thing', acts: [3], once: true,
      when: { maxCorruption: 40 },
      text: "At a dry streambed you find a thistle growing out of the ash, its purple head nodding in the hot wind. It is the same kind that grows on every wall in Thistledown. You stand looking at it longer than you meant to. The Emberheart is quiet. For once, it has nothing to say about a small thing that refuses to burn.",
      choices: [
        { label: 'Pick it and carry it',
          outcome: { text: "You tuck it into your collar. Every time you smell it, you remember the way home.", effects: [{ type: 'hope', amount: 10 }] } },
        { label: 'Leave it to grow',
          outcome: { text: "You let it be. Something in you settles, cool and still.", effects: [{ type: 'corruption', amount: -8 }, { type: 'hope', amount: 3 }] } }
      ]
    },

    /* ======== Any act ======== */
    {
      id: 'peddlers_cart', title: "The Pedlar's Cart", acts: [1, 2, 3], once: true,
      text: "A pedlar sits on the tail of a painted cart, mending a boot. Everything she sells hangs from hooks: pots, charms, bundles of herbs, little clay jars sealed with wax. 'Road goods,' she says. 'Honest prices. Mostly honest.' She has a scale, a ledger, and the steady eyes of someone who has met every kind of traveller and outlived several.",
      choices: [
        { label: 'Buy something useful (12 silver)', requires: { silver: 12 },
          outcome: { text: "She picks something off a hook without asking what you need. She is right.", effects: [{ type: 'silver', amount: -12 }, { type: 'item', id: 'random' }] } },
        { label: 'Sell her 3 supplies for 10 silver', requires: { supplies: 3 },
          outcome: { text: "She sniffs your bread, weighs your oil and pays fair.", effects: [{ type: 'supplies', amount: -3 }, { type: 'silver', amount: 10 }] } },
        { label: 'Trade gossip and move on',
          outcome: { text: "She knows three good jokes and one good road. You take both.", effects: [{ type: 'hope', amount: 2 }] } }
      ]
    },
    {
      id: 'dice_by_the_road', title: 'Dice by the Road', acts: [1, 2, 3], once: true,
      text: "A cheerful man with a broken nose sits by the road with a board and a cup of dice. 'One throw,' he says. 'Ten silver against ten more. The dice are honest, unlike me.' He laughs at his own joke. Whatever else he is, he seems bored, and lonely, and very good at dice. He has a pot of stew going, too.",
      choices: [
        { label: 'Throw for 10 silver', requires: { silver: 10 },
          outcome: { chance: 0.45, chanceBonus: { companion: 'rook', amount: 0.3 },
            success: { text: "The dice come up kind. He pays you ten with a groan and a grin.", effects: [{ type: 'silver', amount: 10 }, { type: 'hope', amount: 2 }] },
            fail: { text: "He scoops up your coins with a sigh of real sympathy.", effects: [{ type: 'silver', amount: -10 }] } } },
        { label: 'Share his stew (1 supply in return)', requires: { supplies: 1 },
          outcome: { text: "You trade bread for stew and stories. He is better company than he looks.", effects: [{ type: 'supplies', amount: -1 }, { type: 'hope', amount: 5 }, { type: 'heal', target: 'all', amount: 4 }] } },
        { label: 'Walk on',
          outcome: { text: "He shrugs and goes back to throwing against himself. He seems to be winning.", effects: [] } }
      ]
    },
    {
      id: 'hungry_children', title: 'Hungry Children', acts: [1, 2, 3], once: true,
      text: "Three children sit on a wall by the road, too thin and too quiet. Their village is a chimney and a burned barn a little way off. They do not beg. They only watch your packs the way you would watch a fire in winter. The eldest has her little brother on her knee, and she is trying very hard not to cry in front of him.",
      choices: [
        { label: 'Give them 3 supplies', requires: { supplies: 3 },
          outcome: { text: "They eat in silence, fast, as if you might change your mind. The little one falls asleep with bread in his fist.", effects: [{ type: 'supplies', amount: -3 }, { type: 'hope', amount: 8 }] } },
        { label: 'Give them 6 silver', requires: { silver: 6 },
          outcome: { text: "Silver will not feed them today, but it may tomorrow. The eldest nods once, very seriously.", effects: [{ type: 'silver', amount: -6 }, { type: 'hope', amount: 4 }] } },
        { label: 'Walk on',
          outcome: { text: "You do not look back. It does not help.", effects: [{ type: 'hope', amount: -5 }] } }
      ]
    },
    {
      id: 'hard_rain', title: 'A Night of Hard Rain', acts: [1, 2, 3], once: true,
      text: "The rain starts at dusk and does not stop. It finds every seam in your cloaks and every crack in your boots. The fire will not light, and nobody talks. By midnight you can hear someone's teeth chattering, and nobody is quite sure whose they are. Morning is a long way off, and so is the next dry roof over your heads.",
      choices: [
        { label: 'Stay put and wait it out (2 supplies)', requires: { supplies: 2 },
          outcome: { text: "You huddle under the cloaks and eat to stay warm. By the next evening the sky clears.", effects: [{ type: 'supplies', amount: -2 }, { type: 'heal', target: 'all', amount: 6 }] } },
        { label: 'Walk through the night',
          outcome: { text: "You make good distance and pay for every mile of it.", effects: [{ type: 'damage', target: 'all', amount: 4 }, { type: 'hope', amount: -3 }] } },
        { label: 'Let Tamsin sing the night away', requires: { companion: 'tamsin' },
          outcome: { text: "Tamsin starts a drinking song with no drink in it. By the third verse everyone is laughing and wet and fine.", effects: [{ type: 'hope', amount: 8 }, { type: 'supplies', amount: -1 }] } }
      ]
    },
    {
      id: 'smoke_on_the_road', title: 'Smoke on the Road', acts: [1, 2, 3], once: true,
      text: "Ahead, a caravan is under attack. Wagons burn. Guards fight back to back as figures in rags close in from the ditches. From your ridge you can see the whole thing: who is winning, and who will not last. From up here, one raised hand would end all of it. You did not think that thought. It was handed to you.",
      choices: [
        { label: 'Charge in',
          outcome: { text: "You come down off the ridge and hit the raiders from behind. Half of them turn to meet you.", effects: [{ type: 'battle', tier: 'normal' }, { type: 'silver', amount: 12 }, { type: 'hope', amount: 6 }] } },
        { label: 'End it from the ridge with the Emberheart',
          outcome: { text: "One flash, and the ditches are full of ash. The merchants pay you with wide eyes and give you a very wide berth.", effects: [{ type: 'corruption', amount: 10 }, { type: 'silver', amount: 15 }, { type: 'hope', amount: 2 }] } },
        { label: 'Wait, and scavenge after',
          outcome: { text: "When it is over you pick through what is left. Nobody is alive to object.", effects: [{ type: 'supplies', amount: 3 }, { type: 'silver', amount: 8 }, { type: 'hope', amount: -8 }] } }
      ]
    },
    {
      id: 'the_waystone', title: 'The Waystone', acts: [1, 2, 3], once: true,
      text: "A standing stone taller than three people waits where two old roads cross. It hums as you come near, a note just under hearing that makes your teeth ache. Hands have worn smooth patches into the rock at chest height. People have laid their palms here for a thousand years, and you can feel that the stone remembers every one of them.",
      choices: [
        { label: 'Lay your hands on it and give it your strength',
          outcome: { text: "The stone drinks deep, and you all stagger. Then it gives something back.", effects: [{ type: 'damage', target: 'all', amount: 6 }, { type: 'boon' }] } },
        { label: 'Leave 10 silver at its foot', requires: { silver: 10 },
          outcome: { text: "The hum softens to something like a purr. You walk on lighter.", effects: [{ type: 'silver', amount: -10 }, { type: 'hope', amount: 6 }, { type: 'corruption', amount: -4 }] } },
        { label: 'Walk on',
          outcome: { text: "The hum follows you for a mile, then fades.", effects: [] } }
      ]
    },
    {
      id: 'archery_wager', title: 'The Archery Wager', acts: [1, 2, 3], once: true,
      when: { companion: 'neve' },
      text: "In a roadside village the hunters are holding a contest: three arrows at a straw boar fifty paces off, ten silver to enter, the whole purse to the best. They take one look at Neve's bow and fall quiet. One of them, a big grinning man, holds out a hand for the entry fee. 'Unless she's scared,' he says, loud enough for everyone.",
      choices: [
        { label: 'Pay for Neve to enter (10 silver)', requires: { silver: 10, companion: 'neve' },
          outcome: { chance: 0.75,
            success: { text: "Neve puts three arrows into a space the size of a coin. The purse is yours, and so is the village's good opinion.", effects: [{ type: 'silver', amount: 20 }, { type: 'hope', amount: 5 }] },
            fail: { text: "A gust takes her last arrow a finger's width wide. The big man wins and is unbearable about it.", effects: [{ type: 'silver', amount: -10 }, { type: 'hope', amount: -2 }] } } },
        { label: 'Decline',
          outcome: { text: "The big man laughs. Neve does not even look at him, and somehow that is worse for him.", effects: [] } }
      ]
    },
    {
      id: 'throne_dream', title: 'The Throne Dream', acts: [1, 2, 3], once: true,
      when: { minCorruption: 35 },
      text: "You dream of a hall of black glass and a seat at the end of it, and a thousand people on their knees. In the dream you are not small. In the dream nobody tells you where to go. You wake with your hand closed tight around the Emberheart, and it takes you a long moment to remember how to open your fingers.",
      choices: [
        { label: 'Go back to sleep, back to the dream',
          outcome: { text: "You sleep deeply and wake rested, stronger than you have felt in weeks. You do not remember the dream, only the warmth.", effects: [{ type: 'corruption', amount: 8 }, { type: 'heal', target: 'bearer', amount: 12 }, { type: 'hope', amount: 4 }] } },
        { label: 'Get up and walk it off',
          outcome: { text: "You pace the camp until dawn, cold and shaking and yourself.", effects: [{ type: 'hope', amount: -4 }, { type: 'corruption', amount: -4 }] } },
        { label: 'Wake Maddoc and talk', requires: { companion: 'maddoc' },
          outcome: { text: "Maddoc lights his lantern and listens without a word until you run out of words. The light helps. So does he.", effects: [{ type: 'corruption', amount: -10 }, { type: 'hope', amount: 2 }] } }
      ]
    },
    {
      id: 'lantern_of_return', title: 'The Lantern of Return', acts: [1, 2, 3], once: true,
      when: { minAct: 2 },
      text: "Off the road, in a ruin nobody has named, an old lantern hangs from a chain and burns with no oil. Its light is the colour of early morning. Around it, scratched in many hands and many tongues, are the names of people who came back. The air is very still. If you listen, you can almost hear someone you lost calling to you from a long way off.",
      choices: [
        { label: 'Call back one of your fallen (Corruption +10)',
          outcome: { text: "You call, and the Emberheart pays the toll in your place. Someone stumbles out of the light, pale and shaking and alive.", effects: [{ type: 'revive', target: 'random_dead', hpPct: 50 }, { type: 'corruption', amount: 10 }] } },
        { label: 'Sit in its light a while',
          outcome: { text: "The light is warm on your faces. Old wounds ache, then ease.", effects: [{ type: 'heal', target: 'all', amount: 15 }] } },
        { label: 'Leave the dead in peace',
          outcome: { text: "You say their names once, aloud, and walk on.", effects: [{ type: 'hope', amount: 5 }] } }
      ]
    },

    /* ======== Engine-triggered (camp, see SPEC section 2) ======== */
    {
      id: 'rook_hunger', title: "Rook's Hunger", acts: [], once: true,
      text: "You wake by the dying fire to find Rook crouched over your pack, one hand on the strap. He does not pull away when you see him. His eyes are wet and bright. 'Just let me hold it,' he says quietly. 'You're tired, {wren}. I can see it eating you. Let me carry it a while. I'm used to carrying things that aren't mine.' His other hand rests on his knife.",
      choices: [
        { label: 'Talk him down', requires: { hope: 40 },
          outcome: { text: "You talk until the fire is ash: about the road, about who he was before the coin, about who he could be after. At last he lets go of the strap, and he does not meet your eyes for a day.", effects: [{ type: 'hope', amount: -5 }] } },
        { label: 'Let him carry it a while (Corruption −20, Rook loses 13 max HP)',
          outcome: { text: "For three days he walks with his jaw clenched and his face grey, and you can breathe again. When he gives it back, something in him stays burned.", effects: [{ type: 'corruption', amount: -20 }, { type: 'maxhp', target: 'rook', amount: -13 }] } },
        { label: 'Draw steel on him (Rook leaves the fellowship for good)',
          outcome: { text: "Steel comes out on both sides. In the end he backs away into the dark and does not come back. Nobody sleeps again that night.", effects: [{ type: 'lose_companion', target: 'rook' }, { type: 'hope', amount: -15 }] } }
      ]
    }
  ],

  /* ----------------------------------------------------------------- ITEMS */
  items: {
    hearthcake: { name: 'Hearthcake', price: 11, use: 'any',
      text: "Heal the most wounded ally for 15 HP.",
      effects: [{ type: 'heal', amount: 15, target: 'friend', pick: 'lowest' }] },
    silverleaf_salve: { name: 'Silverleaf Salve', price: 16, use: 'any',
      text: "Heal all allies for 8 HP.",
      effects: [{ type: 'heal', amount: 8, target: 'all_friends' }] },
    clearwater_flask: { name: 'Clearwater Flask', price: 20, use: 'any',
      text: "Lower Corruption by 10.",
      effects: [{ type: 'corruption', amount: -10 }] },
    firepot: { name: 'Firepot', price: 17, use: 'battle',
      text: "Deal 14 damage to all foes.",
      effects: [{ type: 'damage', amount: 14, target: 'all_foes' }] },
    rousing_horn: { name: 'Rousing Horn', price: 15, use: 'battle',
      text: "Empower all allies for 2 rounds and gain 5 Hope.",
      effects: [{ type: 'status', status: 'empower', turns: 2, target: 'all_friends' }, { type: 'hope', amount: 5 }] },
    smoke_pot: { name: 'Smoke Pot', price: 12, use: 'battle',
      text: "Escape a normal battle. You gain no rewards.",
      effects: [{ type: 'flee' }] },
    trail_rations: { name: 'Trail Rations', price: 10, use: 'map',
      text: "Gain 4 Supplies.",
      effects: [{ type: 'supplies', amount: 4 }] },
    ironbark_tonic: { name: 'Ironbark Tonic', price: 14, use: 'battle',
      text: "Give all allies Guard for 2 rounds.",
      effects: [{ type: 'status', status: 'guard', turns: 2, target: 'all_friends' }] },
    bitterroot_tea: { name: 'Bitterroot Tea', price: 12, use: 'any',
      text: "Cleanse weak, mark, stun and bleed from all allies and heal them for 4 HP.",
      effects: [{ type: 'cleanse', target: 'all_friends' }, { type: 'heal', amount: 4, target: 'all_friends' }] },
    throwing_knives: { name: 'Throwing Knives', price: 15, use: 'battle',
      text: "Throw 3 knives at random foes for 5 damage each.",
      effects: [{ type: 'damage', amount: 5, hits: 3, target: 'foe', pick: 'random' }] },
    blinding_dust: { name: 'Blinding Dust', price: 12, use: 'battle',
      text: "Weaken all foes for 2 rounds.",
      effects: [{ type: 'status', status: 'weak', turns: 2, target: 'all_foes' }] },
    thistle_candle: { name: 'Thistledown Candle', price: 13, use: 'any',
      text: "A candle from home that smells of hay and honey. Gain 10 Hope.",
      effects: [{ type: 'hope', amount: 10 }] }
  },

  /* ----------------------------------------------------------------- BOONS */
  boons: [
    { id: 'road_hardened', name: 'Road-Hardened', text: "Everyone still standing gains 6 max HP and heals 6.", effect: { type: 'maxhp_all', amount: 6 } },
    { id: 'mountain_blood', name: 'Mountain Blood', text: "Everyone still standing gains 10 max HP and heals 10.", effect: { type: 'maxhp_all', amount: 10 } },
    { id: 'whetted_edges', name: 'Whetted Edges', text: "Every ability that deals damage does 2 more per hit. Items and bleeding are unchanged.", effect: { type: 'damage_all', amount: 2 } },
    { id: 'shields_at_dawn', name: 'Shields at Dawn', text: "Your party begins every battle with Guard for 1 round.", effect: { type: 'start_guard', turns: 1 } },
    { id: 'cold_iron_charm', name: 'Cold Iron Charm', text: "All Corruption gains are reduced by 25%.", effect: { type: 'corruption_resist', pct: 25 } },
    { id: 'hedge_wisdom', name: 'Hedge-Wisdom', text: "Forage at camp gives 3 more Supplies.", effect: { type: 'forage_bonus', amount: 3 } },
    { id: 'sharp_bargains', name: 'Sharp Bargains', text: "All silver gains are increased by 30%.", effect: { type: 'silver_bonus', pct: 30 } },
    { id: 'field_dressings', name: 'Field Dressings', text: "After every battle won, everyone still standing heals 6 HP.", effect: { type: 'heal_after_battle', amount: 6 } },
    { id: 'victory_songs', name: 'Victory Songs', text: "Gain 3 more Hope after every battle won.", effect: { type: 'hope_on_victory', amount: 3 } },
    { id: 'laden_packs', name: 'Laden Packs', text: "Gain 10 Supplies now.", effect: { type: 'supplies', amount: 10 } },
    { id: 'road_rhythm', name: 'Road Rhythm', text: "Abilities with a cooldown of 3 or more are ready 1 round sooner.", effect: { type: 'cooldown_haste' } },
    { id: 'ash_veil', name: 'Ash Veil', text: "All Corruption gains are reduced by 40%.", effect: { type: 'corruption_resist', pct: 40 } }
  ],

  /* --------------------------------------------------------------- ENDINGS */
  endings: {
    unmade: {
      title: 'Unmade',
      text: "You open your hand over the Forge, and the Emberheart falls a long way down into the fire that made it. For one moment it shines like the star it once was. Then it is gone, and the Sovereign of Ash goes with it, and the red sky over the March cracks open on a plain grey dawn. You walk home slowly. In Thistledown they ask where you have been, and you tell them, and nobody believes a word of it, which is exactly how you wanted it."
    },
    long_fall: {
      title: 'The Long Fall',
      text: "At the edge of the Forge your hand will not open. You stand there shaking, the Emberheart blazing in your fist and telling you it loves you. Then {companion} is beside you, taking it from you as gently as you would take a knife from a child, and stepping off the edge without a word. The Sovereign is gone and the March is quiet. You walk home carrying a name instead."
    },
    new_sovereign: {
      title: 'The New Sovereign',
      text: "At the edge of the Forge you close your hand. The Emberheart is not heavy anymore, and you understand now that it never was. The fire below goes quiet, as if in respect, and the ash on the plains lifts and bows. Somewhere far behind you, Thistledown wakes under a red sky and does not yet know whose name to fear."
    },
    claimed: {
      title: 'Claimed',
      text: "One day on the road you stop hearing the Emberheart, because its voice has become your own. Voices you used to know call you back, and you do not remember their names for long. The Sovereign of Ash has a new pair of hands, small and stubborn. They will never let go of anything again."
    },
    road_dark: {
      title: 'The Road Goes Dark',
      text: "Hope does not leave all at once. It goes a step at a time: a meal skipped, a song not sung, a friend who stops talking at the fire. One morning nobody stands up. The Emberheart waits in the ash beside you, patient as stone, for the next traveller to come along and pick it up."
    },
    new_hand: {
      title: 'The Ember Finds a New Hand',
      text: "You fall, and the Emberheart rolls out of your coat into the dirt. In that one breath, something else is already crawling toward it. The relic does not mourn you. It never mourns anybody. It only waits for warm fingers and a long road."
    }
  },

  /* -------------------------------------------------------------- WHISPERS */
  whispers: [
    "Put me down, and see how cold you get.",
    "Every letter you ever carried was for someone else. Keep this one.",
    "They will leave you. I never will.",
    "The Forge is a grave. Do not climb into it.",
    "You were small. You do not have to be.",
    "Warm your hands, little courier.",
    "Every road ends at a throne.",
    "Your feet are tired. Mine are not.",
    "I remember being a star. I could teach you.",
    "Thistledown is small. You could make it great.",
    "Who would you be without me? Nobody at all.",
    "One gesture, and nobody would ever hurt you again.",
    "Your friends are counting your steps. So am I.",
    "Hold me tighter.",
    "The Sovereign was only the first. You could be the last.",
    "Why carry me, when I could carry you?",
    "Burn a little. It feels like home.",
    "A courier delivers. Deliver me to a crown."
  ],

  /* -------------------------------------------------------------------- UI */
  ui: {
    titleTagline: "A small courier, a dead star's heart, and one long road to the furnace under the mountain.",
    titleLore: "Long ago the Sovereign of Ash poured his will into a shard of a dead star and called it the Emberheart. Now it has surfaced in a quiet hill-village, in the keeping of a courier too stubborn to put it down. Only the furnace under Mount Cindral can break it, and with every step closer it whispers louder.",
    forgeIntro: "Inside Mount Cindral the air is thick enough to drink. A narrow bridge of black stone runs out over the Unmaking Forge, and far below, the fire that first woke the Emberheart turns slowly, like something asleep. The shard is so hot now that you feel it through your coat, your ribs, your teeth. It is not whispering anymore. It is begging.",
    campIntro: [
      "You make camp in a hollow out of the wind. The fire is small and the night is long.",
      "Someone finds dry wood. Someone else finds the last of the tea. For one night, the road can wait.",
      "Boots off, blades oiled, a pot on the coals. The Emberheart is quiet, or pretending to be.",
      "You camp under a sky full of strange stars and take the watch in turns."
    ],
    havenIntro: [
      "A waystation with a lit window, a barred gate and a keeper who asks no questions as long as your silver is real.",
      "Traders gather here behind a wall of wagons, selling to anyone with coin and a polite face.",
      "An old shrine turned market. The keepers sell bread, bandages and silence, all at fair prices.",
      "Smoke from a chimney, a sign shaped like a boot, and a woman who will sell you anything but directions."
    ]
  }
};
