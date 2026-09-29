// NECROFALL — global configuration, colony definitions, quality settings.

export interface ColonyDef {
  id: string;
  name: string;
  color: number;
  css: string;
  /** Short glyph used on the colony cards and the minimap legend. */
  symbol: string;
  desc: string;
  bonus: string[];
}

/**
 * The four Beacon Towers are labelled A-D everywhere the player reads them — the tracker badge, the
 * radar sigil and every global notice — so a colony can call out "Beacon C" and everyone knows which
 * one is meant.
 */
export const BEACON_LETTERS = ['A', 'B', 'C', 'D'];
export const beaconName = (idx: number): string => `Beacon ${BEACON_LETTERS[idx] ?? String(idx + 1)}`;

export const COLONIES: ColonyDef[] = [
  {
    id: 'helios',
    name: 'HELIOS',
    color: 0xffa63d,
    css: '#ffa63d',
    symbol: '\u2600',
    desc: 'Offensive technology. Burn the surface.',
    bonus: ['+10% auto-attack damage', '+10% ability effectiveness', '-10% max HP'],
  },
  {
    id: 'aegis',
    name: 'AEGIS',
    color: 0x3fc6ff,
    css: '#3fc6ff',
    symbol: '\u25c8',
    desc: 'Defense and territory. Hold what is yours.',
    bonus: ['+15% max HP', '+10% defensive effects', '-10% movement speed'],
  },
  {
    id: 'vanta',
    name: 'VANTA',
    color: 0xb45cff,
    css: '#b45cff',
    symbol: '\u27e1',
    desc: 'Mobility and Necrotech. Outrun the fall.',
    bonus: ['+10% movement speed', '+10% Necromutation gain', '-10% ability damage'],
  },
];

/** Stat modifier block — every value is a multiplier (or absolute add for dashMax). */
export interface Mods {
  dmgMul: number;
  rateMul: number;
  rangeMul: number;
  spdMul: number;
  cdMul: number;
  hpMul: number;
  dashRechargeMul: number;
  regenMul: number;
  takenMul: number;
  xpMul: number;
  burstMul: number;
  abilityMul: number;
  projSpeedMul: number;
  lifesteal: number;
  crit: number;
  dashMax: number;
  /** Extra mid-air jumps granted by perks (on top of the free one). */
  jumps: number;
  /** Extra projectiles per auto-attack. */
  projCount: number;
  /** Regenerating damage shield granted by perks. */
  shieldHp: number;
  execMul: number; // damage bonus vs low-hp enemies
  /**
   * How long an Ultimate's effect lasts, as a multiple of the base duration. Class passives and
   * Necromutation perks raise it, so a defensive build can hold its strongpoint (or its berserk)
   * noticeably longer than a fresh spawn.
   */
  ultDurMul: number;
  // ---- game-changing Necromutations (0 = the perk is not taken; each stack widens the effect) ----
  /** Quakefall: shockwave on landing (stacks widen the wave and the damage). */
  landShock: number;
  /** Molten Wake: burning pools dropped while running. */
  lavaWake: number;
  /** Echo Decoy: a clone left behind by a dash that taunts the horde, then detonates. */
  decoy: number;
  /** Cadaver Bloom: slain Necrophages detonate. */
  killBoom: number;
  /** Voltaic Spine: extra targets an auto-attack's arc leaps to. */
  chainAdd: number;
}

export function defaultMods(): Mods {
  return {
    dmgMul: 1, rateMul: 1, rangeMul: 1, spdMul: 1, cdMul: 1, hpMul: 1,
    dashRechargeMul: 1, regenMul: 1, takenMul: 1, xpMul: 1, burstMul: 1,
    abilityMul: 1, projSpeedMul: 1, lifesteal: 0, crit: 0, dashMax: 0,
    jumps: 1, projCount: 0, shieldHp: 0, execMul: 1, ultDurMul: 1,
    landShock: 0, lavaWake: 0, decoy: 0, killBoom: 0, chainAdd: 0,
  };
}

/** Additive modifier keys (everything else multiplies). */
export const ADDITIVE_MODS: (keyof Mods)[] = [
  'lifesteal', 'crit', 'dashMax', 'jumps', 'projCount', 'shieldHp',
  'landShock', 'lavaWake', 'decoy', 'killBoom', 'chainAdd',
];

/** Merges a partial mod block into a full one (multiply, or add for additive keys). */
export function mergeMods(into: Mods, part: Partial<Mods>): void {
  for (const key of Object.keys(part) as (keyof Mods)[]) {
    const v = part[key];
    if (v === undefined) continue;
    if (ADDITIVE_MODS.indexOf(key) >= 0) into[key] += v;
    else into[key] *= v;
  }
}

/**
 * The Nexus ward radius. ONE number for two things that must never disagree: the barrier itself
 * and the capture ring players stand in. The ring IS the circle the shield draws — a player reads
 * the dome's footprint, and that is exactly where the zone is.
 */
const NEXUS_WARD_RADIUS = 26;

export const CONFIG = {
  planetRadius: 118,
  matchTime: 600,
  colonySelectTime: 5,
  necrotechSelectTime: 10,
  levelUpSelectTime: 5,
  pickupSelectTime: 10,
  respawnTime: 5,
  /** Seconds before a player may pick up another Necrotech. */
  necrotechPickupCd: 20,
  /** Dropped Necrotech fades out and despawns after this many seconds. */
  pickupLifetime: 5,
  /** Length of the fade-out at the end of a Necrotech's life. */
  pickupFade: 1.6,
  /**
   * MATCH FORMAT — 3v3v3. Three colonies, at most `maxPerColony` players each, so a full match is
   * nine players. The lobby locks a colony the moment it holds its third player.
   */
  maxPlayers: 9,
  maxPerColony: 3,
  netTickPlayers: 20, // Hz client -> host
  netTickSnapshot: 12, // Hz host -> clients
  /**
   * OFFICIAL matches (2026-09-29): the client streams its full pose+stats to the match
   * authority through the SpacetimeDB relay at this rate — one reducer call per tick, so it
   * matches what peers actually SEE in P2P (poses rebroadcast in the 12 Hz snapshots) while
   * keeping the per-player cost bounded. Idle players drop to a 1 Hz heartbeat.
   */
  netTickOfficialPose: 15,
  /**
   * Remote player motion. Poses arrive stamped with the *sender's* time (see ClockSync), so every
   * other player is drawn a little behind that timeline and the buffer is sized from what the
   * connection actually does: the base covers one snapshot interval, measured arrival unevenness
   * is added on top, and running dry pushes it further.
   */
  net: {
    /** Base playout buffer (s). Has to exceed one snapshot interval and a normal one-way delay. */
    minDelay: 0.12,
    /** Ceiling for the adaptive buffer (s) — more delay than this is worse than a light stutter. */
    maxDelay: 0.35,
    /** How much of the measured arrival spread is added to the buffer. */
    jitterMul: 1.2,
    /** A pose this far from the previous one is a respawn/blink, not movement (metres). */
    teleport: 8,
    /** A pose this far off the last one on the timeline means the stream restarted (s). */
    resync: 0.5,
    /** How long motion may coast on the last known velocity when packets run dry (s). */
    extrapolate: 0.2,
    /** Window the animation velocity is averaged over (s). */
    velWindow: 0.12,
    /** Velocity smoothing rate (1/s) and the speed above which a pose is treated as bogus (u/s). */
    velSmooth: 9,
    velCap: 60,
  },
  /** Ability cooldown scaling — keeps the base data readable while making the game faster. */
  skillCdScale: 0.5,
  ultCdScale: 0.42,
  /** Hard ceiling for Skill / Ultimate cooldowns (seconds). */
  abilityCdCap: 12,
  /**
   * Base duration (seconds) of an Ultimate's effect — every lingering ult (fields, buffs, zones,
   * auras) runs for this long, scaled by `Mods.ultDurMul` from class passives and perks.
   */
  ultDuration: 5,
  /** Hard ceiling for a scaled ultimate duration, so stacked duration perks stay sane (seconds). */
  ultDurationCap: 12,
  /** Necrotech Burst radius multiplier relative to auto-attack range. */
  burstRangeMul: 2,
  /**
   * World trigger pads, scattered over the planet at match start. Placement is drawn from the match
   * seed so every peer builds the same pads (see world/Pads.ts).
   */
  pads: {
    jumpCount: 9,
    blitzCount: 7,
    /** Minimum surface separation between two pads (metres) — keeps them spread over the planet. */
    minSeparation: 26,
    /** How close a grounded player must stand to set a pad off (metres). */
    radius: 2.8,
    /** Seconds before the same pad can fire again. A launch pad re-arms instantly (trampoline). */
    jumpCooldown: 0,
    blitzCooldown: 8,
    /** Jump pads launch √this × a normal jump's release speed — height ∝ v², so this is the HEIGHT multiple. */
    jumpHeightMul: 4.5,
    /**
     * Blitz pad: seconds as an energy cube, the speed multiplier, and the exit blast. The ride ends
     * EARLY the moment the runner stops holding a direction — the charge has to be spent moving.
     */
    blitzTime: 2,
    blitzSpeed: 2.7,
    blitzBurstPct: 3.5,
    blitzRadius: 6.5,
    /** Grace before "no longer moving" ends a blitz, so the trigger frame cannot cancel it. */
    blitzMoveGrace: 0.08,
  },
  /**
   * The three colony bases: orbiting fortress SHIPS, one per colony, each with a fixed healing pad
   * on the ground below where its lane crosses the planet. The ship keeps its hull, deck and shield
   * bubble and circles the planet slowly; the pad keeps its cone, and mends the owning colony while
   * every other colony is bounced off it (see world/Bases.ts).
   */
  base: {
    /** Colony lanes are tilted this many degrees off the tower cluster's axis. */
    laneAngle: 48,
    laneSpread: 6,
    /** Walkable deck radius — also the radius enemy no-go volumes and spawn slots are drawn from. */
    padRadius: 9,
    /**
     * How far the deck hovers above the terrain below it. The base is a SHIP now — it flies high
     * enough to read as a carrier in the sky rather than a platform just off the ground.
     */
    floatHeight: 72,
    /** Seconds for one full, slow orbit of the planet. Every ship shares the same rate. */
    orbitTime: 300,
    /** Energy bubble radius. Nothing hostile gets inside this, deck or ground. */
    shieldRadius: 14,
    /** Spawn slots are drawn between these two fractions of the deck radius. */
    spawnInner: 0.3,
    spawnOuter: 0.8,
    pylonCount: 6,
    /** Health per second gained while a colony-mate stands in its own healing pad. */
    healRate: 26,
    /**
     * The platform's outer edge is a SPRINGBOARD (user ask 2026-09-29): a colony-mate who runs at
     * the rim is flung outward along their own direction — the shield bounce's own language —
     * mirroring their outward speed by this much, adding `kick` on top, and putting `kick * lift`
     * straight up so the launch reads as a jump, not a skid. See `BaseManager.edgeLaunch`.
     */
    edgePush: { mirror: 2, kick: 26, lift: 0.5 },
  },
  /**
   * Absorbed Necrotechs a player may carry, ON TOP of their starting class — so a full loadout is
   * three Necrotechs in total. Once the slots are full a further mutation overwrites one of them at
   * random (see Player.absorbNecrotech).
   */
  necrotechMutSlots: 2,
  /** Fixed, high-angle camera rig (isometric-ish) with wheel zoom. */
  camera: {
    distance: 12.5,
    height: 18.5,
    zoomMin: 0.6,
    zoomMax: 1.75,
    zoomStep: 0.1,
  },
  /**
   * PVP BALANCE (2026-09 user report: "during PVP, players die too fast almost instantly").
   * Every point of player-vs-player damage — autos, skills, ultimates and the Necrotech Burst —
   * passes through `damageTaken`. The base stat pass above keeps class DPS inside one band, and
   * `player.hpPerLevel` keeps the health pool growing; this scalar widens the exchange window so a
   * burst combo cannot delete a full-health target before a single reaction: at 0.5 a fresh duel
   * sits near 6-7 s of sustained fire and a levelled duel near 8-9 s, with skills roughly halving
   * that when they all connect (test harness: `ttk` in Player). Enemy damage is deliberately NOT
   * scaled — the horde is tuned against the un-scaled numbers.
   */
  pvp: {
    /** Multiplier on all player-vs-player damage. */
    damageTaken: 0.5,
  },
  /**
   * RECALL — the trip back to your colony's floating base (user ask 2026-09-29: the button is
   * PRESSABLE ANYTIME; the old 5 s idle gate is gone). The press locks the body — no movement, no
   * action buttons — for `channelTime` seconds; a fresh input, any hit or death breaks the channel
   * and the next press starts the count over again.
   */
  recall: {
    channelTime: 3,
  },
  player: {
    radius: 0.55,
    height: 1.9,
    accel: 120,
    airAccel: 50,
    friction: 60,
    maxSpeed: 13.5,
    /** Base jump: ~4.4 units of height (was 11 → ~1.8). Momentum carries the rest. */
    jumpSpeed: 17.5,
    /**
     * Dash momentum: a dash raises the top speed by this much and the bonus is KEPT — chain
     * dash-jump-dash and the runner keeps getting faster. There is deliberately NO ceiling; the
     * only brake is the ground bleed-off below, so a chain has to be kept airborne to build.
     */
    dashMomentum: 2,
    /**
     * How fast the bonus bleeds off while running on the ground, as a fraction of itself per
     * second (0.6 ≈ half of it gone every 1.2 s — a gradual slide back to the normal run speed).
     * Nothing decays while airborne, which is what lets a dash-jump chain keep building speed.
     */
    dashMomentumDecay: 0.6,
    /** Mid-air leaps everyone gets for free — the double jump is part of the base kit. */
    baseJumps: 1,
    gravity: 34,
    dashSpeed: 26,
    dashDuration: 0.19,
    dashCharges: 3,
    dashRecharge: 3.4,
    maxHp: 130,
    /**
     * Health granted per Necromutation level, on top of the base pool (flat, before `hpMul`
     * modifiers). Levelling used to only offer perk choices while damage sources kept multiplying,
     * so a late-game duel collapsed into 2-3 second kills. With this, a level-25 survivor carries
     * ~2.3x the base pool and PvP time-to-kill stays inside the `pvp` window below.
     */
    hpPerLevel: 7,
    regenDelay: 2.5,
    regenRate: 30,
    respawnTime: 4.5,
    spawnInvuln: 2,
    pickRange: 3.2,
    /**
     * Extra metres of reach granted to a player the host only knows from the delayed state stream,
     * so a client walking over a drop is detected instead of running past it. Has to cover the
     * whole interpolation buffer (`net.maxDelay`, up to 0.35 s) at full sprint.
     */
    pickLagSlack: 5,
    /** Necrotic Ward: delay before recharging, and refill speed per second. */
    shieldRegenDelay: 4,
    shieldRegenRate: 12,
    /**
     * CORPSE ragdoll (lite): the shove a killing blow puts into the body (m/s), how fast that
     * slide bleeds off (per second), and how hard a living body that walks THROUGH a corpse
     * pushes it aside (m/s² of acceleration at full overlap).
     */
    corpsePush: 5.5,
    corpseFriction: 4.5,
    corpseShove: 12,
  },
  tower: {
    captureRadius: 11,
    /**
     * How far out from a NEXUS a player must stand to capture it. This is NOT its own number: it is
     * the ward's own radius (`nexusShieldRadius`), so the ring that asks you to stand somewhere is
     * the very circle the shield drew over the ground. It was a 16 m ring under a 26 m dome, which
     * read as an arbitrary smaller zone floating inside the barrier.
     */
    nexusCaptureRadius: NEXUS_WARD_RADIUS,
    /** Seconds of uncontested ownership a BEACON needs before it flips. */
    captureTime: 5,
    /** The Nexus is the match's prize: it takes twice as long to take as a Beacon. */
    nexusCaptureTime: 10,
    /** Ward radius of a BEACON. */
    shieldRadius: 12.5,
    /**
     * Ward radius of the NEXUS. Big enough to wrap the whole 4.4x monument — the spire's tip reaches
     * ~24.4 m, so a 26 m seal encloses it with room to spare. The Mega Necrophage patrols inside,
     * the barrier reads as the biggest thing on the battlefield, and the capture ring takes the
     * exact same radius (see `nexusCaptureRadius` — both read `NEXUS_WARD_RADIUS`).
     */
    nexusShieldRadius: NEXUS_WARD_RADIUS,
    /**
     * How long a Beacon's shield holds after a colony captures it. When the countdown runs out the
     * ward falls and the Beacon is exposed to any colony — being captured is a 30 s reprieve, not a
     * permanent wall. (The Nexus shield is permanent; taking it ends the match.)
     */
    shieldTime: 30,
    /** Legacy: Beacon shields are no longer restored on a timer (they stay down until captured). */
    vulnerability: 60,
    bossAggro: 48,
    leash: 62,
  },
  /**
   * How hard a hostile energy dome throws a PLAYER off it — shared by the Beacon / Nexus wards and
   * the enemy colony base domes, so every barrier on the planet repels you the same way. The speed
   * you arrive with is mirrored back at you, a flat shove is added on top of it, and part of that
   * shove is aimed straight up so contact is a launch, not a stop.
   */
  shieldPush: {
    /** 2 = a perfect mirror: you leave with the speed you arrived at. */
    mirror: 2,
    /** Hard shove on top of the mirror (m/s). */
    kick: 26,
    /** Share of the shove aimed straight up, so the bounce also puts you in the air (0..1). */
    lift: 0.5,
  },
  enemy: {
    aggro: 110,
    despawnRange: 260,
    spawnNearMin: 45,
    spawnNearMax: 70,
    /**
     * A survivor this far inside — or outside — a colony dome / live Beacon ward is not a valid
     * spawn anchor. Necrophages cannot reach them there, so spawning around one only piles bodies
     * against the wall while the whole crowd sits in the closest (most expensive) LOD band.
     */
    spawnSafeMargin: 8,
    /**
     * A targetless Necrophage that has been parked against a safe-zone wall for this long is
     * recycled. Without this the crowd the spawner built before the player sheltered stayed there
     * for the rest of the match.
     */
    campDespawn: 8,
    /**
     * The Nexus Mega Necrophage is the match's headline threat, so it gets its own multipliers on top
     * of the match-time curve and the player-count scaling.
     */
    megaHpMul: 1.6,
    megaDmgMul: 1.35,
  },
  /**
   * BOSS COMBAT — the STUN bar, the 50 %-HP enrage and its payoff.
   *
   * A boss fights in three readable beats: its stun bar builds down as it is hit (a broken
   * boss is STUNNED — the damage window), it enrages ONCE at half health behind a one-second window of
   * immunity, and the enraged phase adds two telegraphed mechanics on top of its normal kit. Every
   * number lives here so the fight can be balanced without hunting through the simulation.
   */
  boss: {
    /**
     * Multiplier on EVERY guardian's health pool (Beacon wardens and the Nexus Mega alike). They
     * were being melted by a level-1 kit, so the pool is bigger and they are armoured below.
     */
    hpMul: 1.7,
    /**
     * Incoming damage multiplier for bosses — flat armour on top of the bigger pool, so a boss's
     * effective durability is `hpMul / damageTaken` (1.7 / 0.68 ≈ 2.5x) rather than a bar that merely
     * takes a couple more seconds to run down.
     */
    damageTaken: 0.68,
    /**
     * Stun pool, as a fraction of the boss's max health — the whole bar is worth this much
     * damage. Kept SMALL (and cut from 0.55 to 0.32 alongside the health buff) so that filling the
     * bar is quick: the break is the reward, not a grind.
     */
    stunPool: 0.32,
    /**
     * How much STUN ONE point of damage to the health bar is worth. The bar reads the incoming
     * hit at 2x, so it visibly drains twice as fast as the boss's health does.
     */
    stunDamageMul: 2,
    /**
     * Stun regeneration, as a fraction of the pool per second, once the boss has been left alone
     * for `stunDelay`. This number decides whether a stun break is ACHIEVABLE at all: the
     * players' sustained damage has to beat it, so it is deliberately slow. It used to be 0.12 —
     * 6.6 % of the boss's max health per second — and chip damage between engagements was undone
     * faster than most kits could ever fill the bar.
     */
    stunRegen: 0.05,
    /** Seconds of quiet before the stun bar starts refilling. */
    stunDelay: 1.2,
    /** Seconds a broken boss stays STUNNED. It cannot move, attack or cast for this long. */
    stunDuration: 2,
    /**
     * Refill rate while STUNNED, as a fraction of the pool per second. The bar races back to full
     * across the stun no matter how hard the boss is being hit (damage cannot touch it while it is
     * stunned — see `Enemy.addStun`), so the punish window carries its own visible clock and the
     * fight resumes from a clean, full bar. 0.6 fills it in ~1.7 s, inside the 2 s window.
     */
    stunBrokenRegen: 0.6,
    /** Fraction of max health at or below which the boss enrages. Fires exactly once. */
    enrageAt: 0.5,
    /** Seconds of the enrage transition: damage-immune, wave-pushing, VFX-blasting. */
    enrageImmunity: 1,
    /** Damage / defence multipliers for the whole enraged phase. */
    enragedDamageMultiplier: 1.35,
    enragedDefenseMultiplier: 1.3,
    /** Enrage entry wave: how far it reaches (m) and how hard it throws a player off their feet. */
    enrageWaveRadius: 26,
    enragePush: 30,
    /**
     * Red particle tell while enraged. The state has to be readable from gameplay distance in the
     * WORLD, not just on the plate, so this is deliberately dense enough to read as "burning"
     * rather than "dusty". Kept in check on purpose: an enraged boss is the only thing allowed to
     * hold a few hundred particles, and even three of them at once must leave pool headroom for
     * hit sparks and damage feedback.
     */
    rageParticles: 7,
    rageParticleT: 0.065,
    /** How far away the rage tell still draws (m). */
    rageRange: 130,
    /**
     * How much FASTER the boss cycles its heavies once enraged. Every mechanic owns its own cooldown
     * and telegraph (see BOSS_MECHANICS); the phase only scales them, so adding a new heavy is a
     * data edit and can never make a boss skip its warning.
     */
    enragedCadence: 0.6,
    /** Every boss heavy is telegraphed at least this long before it lands (s). */
    telegraphLead: 1.35,
  },
};

export const PALETTE = {
  xp: 0x9b7bff,
  heal: 0x4dffa6,
  crit: 0xffd166,
  enemyHit: 0xff6b6b,
  shield: 0x63d2ff,
};

/** Colony-wide Beacon ability buffs (one block per colony). */
export interface ColonyBuffState {
  dmg: number;
  taken: number;
  xp: number;
  ability: number;
  time: number;
  label: string;
}

export function COLONY_BUFF_DEFAULTS(): ColonyBuffState[] {
  return [0, 1, 2].map(() => ({ dmg: 1, taken: 1, xp: 1, ability: 1, time: 0, label: '' }));
}

// ---------------------------------------------------------------- quality

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  name: QualityName;
  planetDetail: number;
  particles: number;
  maxEnemies: number;
  decorations: number;
  pixelRatio: number;
  maxProjectiles: number;
  damageNumbers: boolean;
  /**
   * Dense grass around the tower zones, relative to the full field: 1 / 0.6 / 0.3 for high / medium
   * / low. The blade count is huge (tens of thousands, one instanced draw), so this is the single
   * biggest vertex-shading knob the preset owns — on a phone it is the difference between a warm
   * and a hot back glass.
   */
  grassDensity: number;

  // ---- Folio environment axes (plan §92). The environment is instanced and shader-driven, so
  // every one of these is a uniform/budget change — never a rebuild during play.
  /** Master multiplier for tree/bush/rock/scenery placement budgets. */
  environmentDensity: number;
  /** How many trees the forest budget grows (relative). */
  treeDensity: number;
  /** Flower clusters; 0 disables them entirely (plan §16: LOW ships none). */
  flowerDensity: number;
  /** Metres: longest distance foliage (leaves/canopies) is drawn at. */
  foliageDistance: number;
  /** 0..1 water surface treatment quality (0 hides the surface). */
  waterQuality: number;
  /** Allow the environment to cast shadow-map shadows (plan §36). */
  environmentShadows: boolean;
  /** Environmental particle budget: spores, dust, corrupted motes (plan §75). */
  environmentParticles: number;
  /** Metres: the distance objects get real Rapier bodies (plan §14/§88). */
  objectPhysicsDistance: number;
  /** 0..1 strength of the camera→player look-through fade (0 = off, plan §23). */
  occlusionQuality: number;
}

/**
 * Buffers are always allocated at the TOP preset's capacity (ULTRA), so the graphics option can be
 * raised at any time (and the watchdog can hand budget back) without a reallocation. Only the
 * *effective* ceilings move — see `Effects.setCap` / `CombatSystem.setCap`. The extra memory is a
 * few dozen KB.
 */
export const MAX_PARTICLES = 1600;
export const MAX_PROJECTILES = 320;

export function qualitySettings(name: QualityName): QualitySettings {
  switch (name) {
    case 'ultra':
      // The top rung is about POPULATION and budget, not another terrain subdivision: `planetDetail`
      // stays at HIGH's 6 (7 quadruples the icosphere build/triangles for a silhouette gain nobody
      // sees at gameplay range), and the resolution is already at the device cap for both classes.
      return { name, planetDetail: 6, particles: 1500, maxEnemies: 180, decorations: 620, pixelRatio: 2, maxProjectiles: 320, damageNumbers: true, grassDensity: 1, environmentDensity: 1.35, treeDensity: 1.3, flowerDensity: 1.35, foliageDistance: 165, waterQuality: 1, environmentShadows: true, environmentParticles: 2200, objectPhysicsDistance: 34, occlusionQuality: 1 };
    case 'high':
      return { name, planetDetail: 6, particles: 1100, maxEnemies: 150, decorations: 420, pixelRatio: 2, maxProjectiles: 260, damageNumbers: true, grassDensity: 1, environmentDensity: 1, treeDensity: 1, flowerDensity: 1, foliageDistance: 135, waterQuality: 0.85, environmentShadows: true, environmentParticles: 1150, objectPhysicsDistance: 28, occlusionQuality: 1 };
    case 'medium':
      return { name, planetDetail: 5, particles: 650, maxEnemies: 110, decorations: 260, pixelRatio: 1.5, maxProjectiles: 190, damageNumbers: true, grassDensity: 0.6, environmentDensity: 0.65, treeDensity: 0.7, flowerDensity: 0.55, foliageDistance: 95, waterQuality: 0.55, environmentShadows: false, environmentParticles: 560, objectPhysicsDistance: 20, occlusionQuality: 0.6 };
    default:
      return { name, planetDetail: 4, particles: 320, maxEnemies: 72, decorations: 110, pixelRatio: 1.25, maxProjectiles: 130, damageNumbers: false, grassDensity: 0.3, environmentDensity: 0.4, treeDensity: 0.45, flowerDensity: 0, foliageDistance: 62, waterQuality: 0.3, environmentShadows: false, environmentParticles: 240, objectPhysicsDistance: 14, occlusionQuality: 0 };
  }
}

/**
 * Render-resolution caps. A phone panel runs at 2.5-3.5 CSS device pixels per point, and WebGL was
 * drawing every one of them: at DPR 1.5 an S25 Ultra shades ~3.1 M pixels a frame for a 1080p-ish
 * view, and at DPR 3 it would shade 12 M. Capping the WebGL buffer at 1.25 cuts that by a third
 * with no visible loss at arm's length; the CSS/UI resolution is never touched (that stays at the
 * device DPR, so text and HUD icons stay razor sharp). Raise the mobile number and the adaptive
 * ladder below scales with it.
 */
export const DPR_CAP = { mobile: 1.25, desktop: 2 };

/**
 * Phones and tablets. Used for the DPR cap, the audio voice budget and the mobile defaults. The
 * user agent is the primary signal; a multi-touch screen with a phone-sized short edge catches
 * tablets and UA-masking browsers (iPadOS pretends to be a Mac).
 */
export const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent || '') ||
  (navigator.maxTouchPoints > 2 && Math.min(window.screen.width, window.screen.height) < 830);

/**
 * Adaptive render scale (the "DPR ladder"). The watchdog walks DOWN when the frame rate stays
 * below `badFps` and back UP once it stays above `goodFps`; each step is a fraction of the capped
 * DPR, so the mobile ladder is [1.25, 1.00, 0.85, 0.75] and the desktop one [2, 1.6, 1.36, 1.2].
 * Hysteresis is the point: 1.5 s of sustained bad frames before stepping down (a phone that is
 * already thermally throttling must be caught early), 8 s of good frames before stepping back up
 * (quality must never oscillate), plus a cooldown that applies to both directions.
 */
export const PERF = {
  dprLadder: [1, 0.8, 0.68, 0.6],
  badFps: 55,
  goodFps: 58,
  /**
   * Content-rescue thresholds (the watchdog's own ladder: crowd cull → scenery trim → effects
   * trim). Like the DPR ladder, they are RELATIVE to the render-pacing target — a 60 fps-capped
   * match measured against raw 60 fps numbers misreads a healthy capped device. At a 60 target:
   * bad ≈ 28 fps, good ≈ 39 fps. Uncapped phases (desktop matches) keep absolute numbers.
   */
  rescueBadMul: 0.47,
  rescueGoodMul: 0.65,
  rescueBadFps: 28,
  rescueGoodFps: 50,
  /**
   * Seconds without ANY slow window before a rescue level decays back on its own. The old rule
   * demanded 5 straight seconds ABOVE the good line, so a phone sitting between the two
   * thresholds (≈28-39 fps — exactly a hot phone on the LOW preset) could never climb out once
   * the scenery had been trimmed, and played the rest of the match with rocks / grass / trees
   * missing. The decay turns every rescue step into a self-healing trim.
   */
  rescueDecay: 20,
  /**
   * A level that is re-applied within this many seconds of decaying away is a level the device
   * provably needs: the decay floor is pinned at it, so the scenery cannot flicker on and off.
   */
  rescueRegret: 12,
  /** Seconds of sustained bad frames before the scale steps DOWN. */
  downAfter: 1.5,
  /** Seconds of sustained good frames before the scale steps back UP. */
  upAfter: 8,
  /** Seconds after any change before the next one may happen. */
  cooldown: 2,
  /**
   * Render pacing (2026-09 thermal pass): the main loop renders at most this many frames per
   * second, per phase. Matches keep the gameplay budget; menus/lobbies/shells get the cheap one;
   * an untouched menu drops to `idleMenuFps` after `idleAfter` seconds. 0 = uncapped (desktop
   * matches keep the display's refresh rate). Phones cap the match at 60 fps, but only on
   * 120 Hz-class panels: `Game` checks the raw rAF cadence first, because a 60 fps target on a
   * 90 Hz panel lands on 45 fps (every second frame), which is worse than leaving it alone.
   */
  matchFps: IS_MOBILE ? 60 : 0,
  menuFps: IS_MOBILE ? 30 : 60,
  idleMenuFps: IS_MOBILE ? 15 : 30,
  idleAfter: 12,
};

export function detectQuality(): QualityName {
  const ua = navigator.userAgent || '';
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) ||
    (navigator.maxTouchPoints > 2 && Math.min(window.screen.width, window.screen.height) < 830);
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile) return (mem !== undefined && mem >= 6) || cores >= 8 ? 'medium' : 'low';
  if (cores >= 8 && (mem === undefined || mem >= 8)) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

export const IS_TOUCH =
  'ontouchstart' in window || navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// ---------------------------------------------------------------- graphics preference

/** The player's graphics choice: a fixed preset, or `auto` (the device is probed at boot). */
export type QualityPref = QualityName | 'auto';

export const QUALITY_PREFS: QualityPref[] = ['auto', 'low', 'medium', 'high', 'ultra'];

const QUALITY_STORE_KEY = 'nf.graphics';

/** Reads the saved graphics choice, falling back to `auto`. Storage can be unavailable (webviews). */
export function loadQualityPref(): QualityPref {
  try {
    const raw = window.localStorage.getItem(QUALITY_STORE_KEY);
    if (raw && (QUALITY_PREFS as string[]).indexOf(raw) >= 0) return raw as QualityPref;
  } catch {
    /* private mode / sandboxed webview — the default is fine */
  }
  return 'auto';
}

export function saveQualityPref(pref: QualityPref): void {
  try {
    window.localStorage.setItem(QUALITY_STORE_KEY, pref);
  } catch {
    /* ignore: the choice then only lasts for the session */
  }
}

/** The preset a preference means right now. */
export function resolveQuality(pref: QualityPref): QualityName {
  return pref === 'auto' ? detectQuality() : pref;
}

/** Font/label for the graphics row. */
export const QUALITY_LABELS: Record<QualityPref, string> = {
  auto: 'AUTO',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  ultra: 'ULTRA',
};

export const QUALITY_BLURBS: Record<QualityPref, string> = {
  auto: 'Picks a preset from this device.',
  low: 'Fewest effects, sharpest framerate.',
  medium: 'Balanced detail and performance.',
  high: 'Full detail. Desktop or fast tablets.',
  ultra: 'Biggest crowds and effects. Gaming desktops.',
};

// ---------------------------------------------------------------- max frame rate

/**
 * The player's frame-rate ceiling: `auto` keeps the device-aware pacing PERF describes, a number
 * pins matches AND menus to at most that many rendered frames per second (a 30 cap on a 60 Hz panel
 * simply draws every second frame). Persisted like the graphics preset.
 */
export type FpsPref = 'auto' | 30 | 60 | 90 | 120;

export const FPS_PREFS: FpsPref[] = ['auto', 30, 60, 90, 120];

const FPS_STORE_KEY = 'nf.maxfps';

/** Reads the saved frame-rate cap, falling back to `auto`. Storage can be unavailable (webviews). */
export function loadFpsPref(): FpsPref {
  try {
    const raw = window.localStorage.getItem(FPS_STORE_KEY);
    const num = Number(raw);
    if ((FPS_PREFS as (string | number)[]).indexOf(num) >= 0) return num as FpsPref;
  } catch {
    /* private mode / sandboxed webview — the default is fine */
  }
  return 'auto';
}

export function saveFpsPref(pref: FpsPref): void {
  try {
    window.localStorage.setItem(FPS_STORE_KEY, String(pref));
  } catch {
    /* ignore: the choice then only lasts for the session */
  }
}

/** Short label for the frame-rate chips. */
export const FPS_LABELS: Record<string, string> = {
  auto: 'AUTO',
  '30': '30',
  '60': '60',
  '90': '90',
  '120': '120',
};

/** What a frame-rate cap means, in one line. */
export function fpsBlurb(pref: FpsPref): string {
  if (pref === 'auto') {
    return IS_MOBILE
      ? 'AUTO: 60 in matches, 30 in menus, 15 while idle — tuned for battery and heat.'
      : 'AUTO: uncapped in matches, 60 in menus, 30 while idle.';
  }
  return `Renders at most ${pref} frames per second, in matches and menus alike.`;
}
