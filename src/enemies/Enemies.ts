// NECROFALL — Necrophage simulation: genome-driven archetypes, lightweight state machines,
// simulation LOD, statuses, ability behaviours and host-authoritative damage.
import * as THREE from 'three';
import type { Game, HitStatus } from '../core/Game';
import type { Player } from '../player/Player';
import { DECOY_TAUNT_RADIUS } from '../player/Decoy';
import type { QualitySettings } from '../core/Config';
import type { StatusKind } from '../necrotech/NecrotechData';
import { CONFIG } from '../core/Config';
import { SpatialHash } from '../utils/SpatialHash';
import { Rand, clamp, orientToSurface, randomUnitVector, tangentBasis } from '../utils/Utils';
import { buildCreature, CreatureRig } from './EnemyModels';
import {
  ABILITY_META,
  AbilityId,
  BehaviorTrait,
  Bestiary,
  EnemyGenome,
  HunterProfile,
  generateBestiary,
} from './EnemyGenomes';

export { generateBestiary } from './EnemyGenomes';
export type { EnemyGenome, Bestiary, BehaviorTrait } from './EnemyGenomes';
// The procedural layer (plan §16–§29): grammars produce genomes, the assembler builds their
// bodies, the animator plays their gaits. `Enemies.ts` only orchestrates.
export { assembleEnemy } from './procedural/EnemyAssembler';
export { generateEcology, factsFromSeed, factsFromDescriptor } from './procedural/EcologyGenerator';
export type { PlanetFacts, EcoRole, LocomotionId, ProcAttack } from './procedural/EnemyGenome';
import { assembleEnemy } from './procedural/EnemyAssembler';
import { animateEnemyRig } from './procedural/EnemyAnimator';
import { generateEcology as generateEcologyBestiary } from './procedural/EcologyGenerator';
import { factsFromSeed } from './procedural/EcologyGenerator';
import type { PlanetFacts } from './procedural/EnemyGenome';

/**
 * The behavioural states every Necrophage can be in. A creature only ever holds one, transitions
 * are decided on a throttle (see `Enemy.decide`), and the state feeds target choice, movement,
 * pursuit distance, grouping and attack timing — the traits say WHICH of these it can reach.
 */
export type BehaviorState =
  | 'idle'         // nothing to do, wandering
  | 'investigate'  // heading for where it was last hurt
  | 'group'        // running with the pack at a shared target
  | 'attack'       // chasing and engaging a player
  | 'flee'         // breaking off, running away
  | 'return'       // walking back to its own ground
  | 'defend';      // guardian holding station beside its kin

/** The boss state machine. Transitions happen exactly once, in order. */
export type BossState = 'normal' | 'enrage_transition' | 'enraged' | 'dead';

/** Snapshot flag bits (the host is the only writer). */
const F_ELITE = 1;
const F_BOSS = 2;
const F_ENRAGED = 4;
const F_STUNNED = 8;
const F_ENRAGING = 16;

// ---------------------------------------------------------------- boss heavies

/**
 * A boss HEAVY. Every one of them is telegraphed on the terrain before it lands, and each uses its
 * own shape so a player can read which is coming: a filled disc (leave the area), a hollow ring
 * (leave the edge), or a lane (leave the line). The set is chosen from the boss's own generated
 * kit, so two bosses fight differently without a single hand-authored encounter.
 */
export type BossMechanicId =
  | 'quake'      // big area slam — knocks players UP off the ground
  | 'dash'       // long telegraphed charge straight down a lane
  | 'nova'       // status burst: poison, burn, or chill + weakened
  | 'impact'     // aimed ground impact that leaves a burning crater
  | 'ragechain'  // ENRAGED only: three eruptions marching at the player
  | 'rageleap';  // ENRAGED only: it leaps on to the marked spot and knocks everyone up

interface BossMechanicSpec {
  /** Telegraph lead (s): how long the marker fills before the hit lands. */
  lead: number;
  /** Cooldown at the normal phase (s); scaled by `CONFIG.boss.enragedCadence` when enraged. */
  cd: number;
  /** Damage multiplier on the landing, relative to the boss's own melee hit. */
  mul: number;
  /** How far away the boss will start it from (m). */
  range: number;
}

const BOSS_MECHANICS: Record<BossMechanicId, BossMechanicSpec> = {
  quake: { lead: 1.7, cd: 13, mul: 1.5, range: 30 },
  dash: { lead: 1.25, cd: 11, mul: 1.3, range: 46 },
  nova: { lead: 1.5, cd: 15, mul: 1.1, range: 26 },
  impact: { lead: 1.6, cd: 12, mul: 1.7, range: 42 },
  ragechain: { lead: 1.3, cd: 14, mul: 1.35, range: 34 },
  rageleap: { lead: 1.4, cd: 16, mul: 1.8, range: 40 },
};

/** The two heavies a boss only unlocks by enraging. */
const ENRAGED_MECHANICS: BossMechanicId[] = ['ragechain', 'rageleap'];

/**
 * What heavies a boss owns, read off its GENERATED genome. Every boss gets the area slam and a
 * status burst — the two things a player must always be able to read — and the third slot is its
 * own flavour: a mobile genome gets the dash, everything else gets the aimed impact.
 */
function pickBossMechanics(g: EnemyGenome): BossMechanicId[] {
  const has = (id: AbilityId): boolean => g.abilities.indexOf(id) >= 0;
  const out: BossMechanicId[] = ['quake', 'nova'];
  if (has('charge') || has('blink') || has('leap') || g.behavior.chaseSpeedMul > 1.05) out.push('dash');
  else out.push('impact');
  return out;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/** Scratch for the safe-zone guard volumes (bases + Beacon shields). */
const _zone = new THREE.Vector3();
const _zoneDir = new THREE.Vector3();
/** How far outside a guard volume a body still counts as "parked against the wall". */
const CAMP_BAND = 10;
/** Scratch position for pack spawns (`spawn` copies it immediately). */
const _spawnV = new THREE.Vector3();
/** Scratch for swarm formation slots + projectile pattern math (plan §19/§22) — never shared. */
const _sw1 = new THREE.Vector3();
const _sw2 = new THREE.Vector3();
const _sw3 = new THREE.Vector3();
/** Scratches for the visual surface lean (`Enemy.updateSkinUp`) — never shared with gameplay math. */
const _skinN = new THREE.Vector3();
const _skinT1 = new THREE.Vector3();
const _skinT2 = new THREE.Vector3();
const _skinP = new THREE.Vector3();
/**
 * Baseline (metres) of the two probes the rig's lean is measured across. WIDE on purpose: this is
 * the slope the EYE sees, not the analytic micro-noise — sampling tight made the whole rig wobble
 * on every crag-sized bump it crossed.
 */
const SKIN_SPAN = 1.1;
/** How fast the visual lean eases toward the local surface normal (per second). */
const SKIN_EASE = 5;
/**
 * How far above the analytic surface the BODY is drawn. The terrain mesh interpolates linearly
 * between icosphere vertices while gameplay stands everything on the analytic field, so the visible
 * ground sits up to ~12 cm above or below the height a body is placed at (measured p90 on the
 * default preset). This little clearance keeps the feet out of that bulge instead of flickering
 * through it; nothing gameplay-side reads it (projectiles, plates and hits all use `position`).
 */
const SKIN_LIFT = 0.06;
/** The enraged tint every tell leans towards — one constant, so particles and body match. */
const _rageCol = new THREE.Color(0xff2d2d);
/**
 * EVERY boss tell is RED.
 *
 * One colour family, so "the boss is winding something up" needs no legend: the marker on the
 * ground, the slam, the crater it leaves and the sparks off it all read as the same threat. It used
 * to be a different colour per mechanic — orange slams, element-coloured status bursts, and whatever
 * the genome's accent happened to be on a charge — which made each heavy look like it belonged to a
 * different creature, and made none of them read as "this is the boss".
 *
 * The three steps exist only to keep the depth the effects already had: the ring is the brightest,
 * the wide ground wash is the deepest, and the sparks off the impact sit between them.
 */
export const BOSS_RED = 0xff2d2d;
/** Sparks and burst cores. Lighter than the marker so an impact pops instead of flattening out. */
export const BOSS_RED_HOT = 0xff5555;
/** The wide ground disk / crater pool: a scorch, not a flash. */
export const BOSS_RED_DEEP = 0xc41f1f;
/** The STUNNED tint: the same yellow the plate's stun bar lives in, so body and plate agree. */
const _stunCol = new THREE.Color(0xffd166);
/** Scratch for a leaping/pouncing Necrophage. */
const ENEMY_GRAVITY = 32;

/** Push speed the Spinner whirl drives enemies out at (m/s). */
const SPINNER_SHOVE = 6.5;
/** Margin kept inside the whirl so the wave deposits bodies just short of its edge. */
const SPINNER_RIM = 0.05;
/** Scratch for the Spinner shove direction. */
const _shove = new THREE.Vector3();
/** Behaviour-only movement scratches (the per-frame steering code owns _v.._v3). */
const _bv = new THREE.Vector3();
const _bw = new THREE.Vector3();
/** A direction-less telegraph (a centred disc) still needs a `dir` argument. */
const _zeroDir = new THREE.Vector3(0, 0, 1);
/**
 * Match-time power curve for the Necrophages: the longer the match runs, the more health they bring,
 * and they hit harder too. Over a full 10-minute match that is roughly x2.95 health and x1.55 damage.
 *
 * Damage ramps more gently than health on purpose: an earlier pass raised it hard and the crowd became
 * lethal far too early (the mid-game was unplayable), so the curve leans on health first.
 */
export function enemyPowerScale(elapsed: number): { hp: number; dmg: number } {
  const t = Math.max(0, elapsed);
  return { hp: 1 + (t / 600) * 1.95, dmg: 1 + (t / 600) * 0.55 };
}

/** Hunters never ride the curve below this many seconds — they START at their 5:00 stats. */
const HUNTER_CURVE_FLOOR = 300;

interface Dot {
  kind: StatusKind;
  dps: number;
  t: number;
  ownerId: string | null;
  /** How many times this status has been re-applied. */
  stacks: number;
}

export interface EnemySnapshot {
  id: number;
  type: number;
  x: number; y: number; z: number;
  hp: number;
  flags: number;
  /** Mitosis generation (0 for a natural spawn) — clients scale descendants to match. */
  gen?: number;
  /** Bosses only: stun-bar fraction 0..100, so every client draws the same stun bar. */
  stn?: number;
}

export class Enemy {
  id = 0;
  genomeIdx = -1;
  genome!: EnemyGenome;
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  up = new THREE.Vector3(0, 1, 0);
  facing = new THREE.Vector3(0, 0, 1);
  /** Height above the terrain surface: 0 while walking, > 0 during leaps, pounces and falls. */
  /** Visual-only: the eased surface normal the rig leans to (see `updateSkinUp`). */
  readonly skinUp = new THREE.Vector3();
  /** Countdown to the next lean re-sample (`updateSkinUp`). */
  private skinT = 0;
  /** Triangle of the rendered terrain mesh the body last stood on (`meshHeightAtDir` hint). */
  private meshHint = -1;
  airH = 0;
  hp = 1;
  maxHp = 1;
  radius = 0.5;
  alive = true;
  isBoss = false;
  small = false;
  towerIdx = -1;
  /** Who last dealt this creature damage — feeds LAST_ATTACKER targeting (plan §21). */
  lastAttackerId: string | null = null;
  elite = false;
  xpValue = 0;
  targetId: string | null = null;
  attackCd = 0;
  slowMul = 1;
  slowT = 0;
  rootT = 0;
  dots: Dot[] = [];
  /** Damage multiplier from defensive abilities (Plating). */
  guardMul = 1;
  guardT = 0;
  stealthed = false;
  chargeT = 0;
  /** How many times this creature's ancestry has already split (mitosis). */
  splitGen = 0;
  /** Damage scale for split descendants — each generation hits softer. */
  damageMul = 1;
  /** Match-time damage scale. Left at 1: see enemyPowerScale for why damage no longer ramps. */
  powerMul = 1;
  netTarget: THREE.Vector3 | null = null;
  group = new THREE.Group();
  rig: CreatureRig | null = null;
  /** White hit-flash amount, decayed every frame. */
  flashAmt = 0;
  /**
   * Seconds this creature has been parked against a colony dome / Beacon ward with nobody to chase.
   * The manager recycles it once it passes `CONFIG.enemy.campDespawn`.
   */
  shelterT = 0;

  // ------------------------------------------------------------ behaviour
  /** Current behavioural state (see BehaviorState). Simulated by the host. */
  bState: BehaviorState = 'idle';
  /** Where this creature spawned: the anchor its territory is measured from. */
  home = new THREE.Vector3();
  /** Where it was last hurt, so a targetless creature can go and look. */
  private lastThreat = new THREE.Vector3();
  private threatT = 0;
  /** Seconds left of a break-off; while this runs the flee state wins. */
  private bFleeT = 0;
  /** Remaining time before the brain runs again (AI decisions are throttled). */
  private thinkT = 0;
  private bTarget: Player | null = null;

  // ------------------------------------------------------------ hunter
  /** Hunters run their own tiny cycle: stalk -> windup (telegraphed) -> leap -> recover -> stalk. */
  private hunterState: 'stalk' | 'windup' | 'leap' | 'recover' = 'stalk';
  private hunterT = 0;
  private hunterCd = 0;
  /** The marked landing point of a committed pounce — the centre of the telegraph disc. */
  private huntAt = new THREE.Vector3();

  // ------------------------------------------------------------ boss
  /** Stun pool: damage taken fills this down; an empty pool breaks the boss open (the STUN). */
  stun = 0;
  stunMax = 0;
  /** Seconds of quiet before the stun bar starts refilling. */
  private stunDelayT = 0;
  /** Seconds left of the STUN — the punished boss cannot act at all. */
  stunnedT = 0;
  /** The boss state machine. */
  bossState: BossState = 'normal';
  /** Seconds left of the damage-immune enrage transition. */
  immuneT = 0;
  /** True for the rest of the fight once the boss has enraged (fires exactly once). */
  enraged = false;
  /**
   * One-shot latch. `enraged` describes the CURRENT phase; this records that the transition has
   * already been used, so the enrage can never fire a second time even if something resets the
   * phase field (a pooled instance, a hand-edited state, a future mechanic).
   */
  private enrageFired = false;
  /**
   * The heavies this boss owns, in cast order. Chosen from its generated kit (see
   * `pickBossMechanics`) and EXTENDED with the two enrage-only heavies when it rages, so a fight
   * gains new patterns rather than only new numbers.
   */
  bossMechanics: BossMechanicId[] = [];
  /** One cooldown per entry of `bossMechanics`, in parallel. */
  private mechCd: number[] = [];
  /** Index into `bossMechanics` of the heavy winding up (-1 = none). */
  private mechCast = -1;
  /** Seconds until the winding-up heavy lands. */
  private mechT = 0;
  private rageT = 0;
  /** Where the boss stood when it committed, and the marker's own centre (they differ for aimed
   * heavies, which land where the target was rather than where the boss is). */
  private mechFrom = new THREE.Vector3();
  private mechAt = new THREE.Vector3();
  /** Winding-up lane: direction, length and half-width. */
  private mechDir = new THREE.Vector3();
  private mechLen = 0;
  private mechWidth = 0;
  /** Winding-up area radius (disc / ring heavies). */
  private mechRadius = 0;

  private abilityCd: number[] = [];
  private dotAccum = 0;
  private dotAccumT = 0;
  private wanderDir = new THREE.Vector3(0, 0, 1);
  private wanderT = 0;
  private animPhase = 0;
  private aggro = 0;
  private corePulse = 0;
  private regenAccum = 0;
  /** Status overlay — the toxin ooze. Built once, re-parented per rig. */
  private fxToxin: THREE.Mesh | null = null;
  private fxPhase = 0;
  /**
   * How iced the body is, 0..1, ramped rather than snapped. The frost itself (and its pulse) lives
   * in the creature's own shaders — see `uFreeze` in EnemyModels — so it covers every surface at no
   * extra draw calls, and still animates on a client that only interpolates snapshots.
   */
  private iceAmt = 0;
  /**
   * Seconds of CRYO left on the body. Set ONLY by cryo sources (the FROST weapon and its abilities),
   * never by a plain slow — see `applyStatus`. This is what the ice tell reads, so a Fortress Field
   * or a toxin trail slowing a Necrophage no longer frosts it over.
   */
  frostT = 0;
  /** Throttle for the PYRE / VENOM spread passives. */
  private spreadT = 0;
  private spreadScratch: Enemy[] = [];
  /** Particle tells for the live debuffs, throttled and scaled by body size. */
  private fxGame: Game | null = null;
  private tellT = 0;
  private tellPos = new THREE.Vector3();
  private tellDir = new THREE.Vector3();
  /** The rig's own shader colours, so the enraged wash can be applied and lifted cleanly. */
  private rigBaseGlow: THREE.Color | null = null;
  private rigBaseAccent: THREE.Color | null = null;

  /** Give the creature a Game handle so its debuff tells can reach the effect pools. */
  bindGame(game: Game): void {
    this.fxGame = game;
  }

  // ------------------------------------------------------------ setup

  setGenome(genome: EnemyGenome): void {
    if (this.rig && this.genomeIdx === genome.idx) return; // pooled instance already built
    this.genomeIdx = genome.idx;
    this.genome = genome;
    this.isBoss = genome.tier === 'boss' || genome.tier === 'nexus';
    this.small = genome.small;
    this.radius = genome.radius;
    this.xpValue = genome.xp;
    this.maxHp = genome.hp;
    this.guardMul = 1;
    this.guardT = 0;
    this.stealthed = false;
    this.flashAmt = 0;
    this.abilityCd = genome.abilities.map(() => Math.random() * 2);
    this.bState = 'idle';
    this.bTarget = null;
    this.bFleeT = 0;
    this.threatT = 0;
    this.lastAttackerId = null;
    this.thinkT = Math.random() * genome.behavior.thinkInterval;
    this.hunterState = 'stalk';
    this.hunterT = 0;
    this.hunterCd = genome.hunt ? 1.6 : 0;
    this.stun = 0;
    this.stunMax = 0;
    this.stunnedT = 0;
    this.stunDelayT = 0;
    this.bossState = 'normal';
    this.enraged = false;
    this.enrageFired = false;
    this.immuneT = 0;
    // Heavies: a boss owns a small kit derived from its own genome; the enraged pair is appended
    // when it rages. The cooldowns start spread out so the very first heavy is not immediate.
    this.bossMechanics = this.isBoss ? pickBossMechanics(genome) : [];
    this.mechCd = this.bossMechanics.map(() => 2.5 + Math.random() * 3.5);
    this.mechCast = -1;
    this.mechT = 0;
    if (this.rig) this.rig.group.removeFromParent();
    this.rig = assembleEnemy(genome, this.id);
    this.group = this.rig.group;
    // Remember the rig's base shader colours: the enraged wash is applied and removed every frame.
    this.rigBaseGlow = (this.rig.energy.uniforms.uGlow.value as THREE.Color).clone();
    this.rigBaseAccent = (this.rig.carapace.uniforms.uAccent.value as THREE.Color).clone();
    this.group.visible = false;
    this.ensureStatusFx();
  }

  /**
   * Status tells, so every debuff is legible from across the field. FROST deliberately has NO mesh:
   * the ice is a tint on the creature's own carapace and energy materials (see `uFreeze` in
   * EnemyModels), so it coats the whole body without a shell around it — an enclosing bubble reads
   * as a shield, and it was one. Burning has no body overlay either, for the same reason: the
   * flame particles are the whole read and a glowing shell only muddies it.
   */
  private ensureStatusFx(): void {
    if (!this.fxToxin) {
      const toxinMat = new THREE.MeshBasicMaterial({
        color: 0x9dff6b, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this.fxToxin = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), toxinMat);
      this.fxToxin.renderOrder = 6;
    }
    this.fxToxin.visible = false;
    this.group.add(this.fxToxin);
    // a pooled instance can come back as a different species while frozen, so clear the frost here
    this.iceAmt = 0;
    this.frostT = 0;
    if (this.rig) {
      this.rig.carapace.uniforms.uFreeze.value = 0;
      this.rig.energy.uniforms.uFreeze.value = 0;
    }
  }

  /** White flash on hit — reads as feedback even for tiny swarm creatures. */
  flash(strength: number): void {
    if (strength > this.flashAmt) this.flashAmt = Math.min(1, strength);
  }

  /** World position a floating head plate should hover above. */
  bossAnchor(out: THREE.Vector3): THREE.Vector3 {
    const s = this.genome?.scale ?? 1;
    // just above the body, so the plate stays in frame at the default camera angle
    const lift = this.isBoss ? 1.5 : this.isNamed ? 1.4 : 1.3;
    return out.copy(this.position).addScaledVector(this.up, s * lift + 0.85);
  }

  /** True for named enemies that get a boss-style plate. */
  get isNamed(): boolean {
    return this.isBoss || this.elite || this.genome?.tier === 'apex';
  }

  has(id: AbilityId): boolean {
    return this.genome.abilities.indexOf(id) >= 0;
  }

  /**
   * Attack damage after the mitosis size penalty, the behavioural profile, the match-time power
   * curve and — for a boss — the enraged phase's raised offence.
   */
  damage(mult = 1): number {
    return this.genome.damage * this.damageMul * this.powerMul * this.genome.behavior.damageMul * this.bossDamageMul() * mult;
  }

  private cd(id: AbilityId): number {
    const at = this.genome.abilities.indexOf(id);
    return at >= 0 ? this.abilityCd[at] : 0;
  }

  private setCd(id: AbilityId, value: number): void {
    const at = this.genome.abilities.indexOf(id);
    if (at >= 0) this.abilityCd[at] = value;
  }

  // ------------------------------------------------------------ statuses

  applyStatus(kind: StatusKind, power: number, ownerId: string | null, cryo = false): void {
    if (!kind) return;
    // A cryo source leaves its own mark alongside whatever it applied: the slow/root is the mechanic,
    // `frostT` is the TELL. Kept separate on purpose — sharing it with `slowMul` made every slowed
    // Necrophage look frozen, since a dozen non-frost effects in the game apply a slow.
    if (cryo) this.frostT = Math.max(this.frostT, kind === 'root' ? 1.6 : 1.3);
    if (kind === 'slow') {
      this.slowMul = Math.min(this.slowMul, 1 - clamp(power, 0, 0.85));
      this.slowT = Math.max(this.slowT, 2.6);
      return;
    }
    if (kind === 'root') {
      // frozen solid for a short window
      this.slowMul = 0.06;
      this.slowT = Math.max(this.slowT, 1.4);
      this.rootT = Math.max(this.rootT, 1.4);
      return;
    }
    // Damage over time stacks like Path of Exile: same kind adds a stack (max 5) and
    // refreshes the duration instead of replacing the existing burn/toxin.
    const existing = this.dots.find(d => d.kind === kind);
    if (existing && this.dots.length < 6) {
      existing.dps = Math.max(existing.dps, power) + power * 0.45;
      existing.t = Math.max(existing.t, kind === 'burn' ? 3.2 : 4.6);
      existing.stacks = Math.min(5, existing.stacks + 1);
      return;
    }
    this.dots.push({ kind, dps: power, t: kind === 'burn' ? 3.2 : 4.6, ownerId, stacks: 1 });
    if (this.dots.length > 6) this.dots.shift();
  }

  /** Called by the host after damage was applied (retaliation / lifesteal hooks). */
  onDamaged(attackerId: string | null, amount: number, game: Game): void {
    if (!this.alive) return;
    // Remember who hurt it and where, so the decision pass can send a targetless creature to look.
    if (attackerId) {
      this.lastAttackerId = attackerId;
      const atk = game.players.get(attackerId);
      if (atk) {
        this.lastThreat.copy(atk.position);
        this.threatT = 8;
      }
    }
    if (this.has('thorn') && this.cd('thorn') <= 0) {
      this.setCd('thorn', 0.5);
      const attacker = attackerId ? game.players.get(attackerId) : null;
      // Barbs are CONTACT spikes: they only reach someone close enough to be standing in them.
      // The old fixed 11 m reach punished a shooter at the edge of their own range ring — the
      // auto-attack fires the instant an enemy crosses the ring, the first shot landed, and the
      // barbs silently hit back from 10 m away with no swing, no projectile and no tell: "I take
      // damage for no reason the moment an enemy enters my ring". With several barbed mobs in the
      // ring (the volley hits up to `level` targets and DoTs tick too) the invisible retaliation
      // stacked into a death the player could not read. Reach now rides the creature's own melee
      // range, so a proc always has a body visibly pressed against the player.
      const reach = Math.max(3.2, this.genome.attackRange + 1.5);
      if (attacker && attacker.alive && attacker.position.distanceTo(this.position) < reach) {
        game.hitPlayer(attacker, this.damage(0.35), null, 'enemy');
        // Make the proc readable: a burst off the victim AND a short ring on the ground, so the
        // hit is attributed to the barbed body beside them instead of "damage out of nowhere".
        game.effects.burst(attacker.position, this.genome.accent, { count: 8, speed: 7, life: 0.3, size: 0.5, gravity: 6 });
        game.effects.ring(attacker.position, attacker.up, 0.9, this.genome.accent, 0.3, 1.6, 0.8);
      }
    }
    if (this.has('siphon') && amount > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + amount * 0.35);
    }
  }

  // ------------------------------------------------------------ simulation

  /** Host-authoritative AI + movement. dt is scaled by the simulation LOD step. */
  update(dt: number, game: Game): void {
    if (!this.alive) return;
    const g = this.genome;
    if (!g) return;

    for (let i = 0; i < this.abilityCd.length; i++) this.abilityCd[i] -= dt;
    this.fxPhase += dt;

    if (this.slowT > 0) {
      this.slowT -= dt;
      if (this.slowT <= 0) this.slowMul = 1;
    }
    if (this.guardT > 0) {
      this.guardT -= dt;
      if (this.guardT <= 0) this.guardMul = 1;
    }
    // The charge latch must tick EVERY frame, whatever the brain is doing. It used to be decremented
    // only inside the "has a target" branch: a charger that lost its target mid-dash (the player
    // died, took shelter, the decoy popped, or it broke off to flee) froze `chargeT > 0` for good —
    // and the locomotion treats a live charge as momentum-only, no steering. The body then coasted
    // on raw velocity until something damped it (a ward push, the target-drop decay) and stood
    // there dead still forever, unable to even wander again. "Enemies getting stuck" on slopes.
    if (this.chargeT > 0) this.chargeT -= dt;

    // --- damage over time
    if (game.isHost && this.dots.length > 0) {
      this.dotAccumT -= dt;
      for (let i = this.dots.length - 1; i >= 0; i--) {
        const d = this.dots[i];
        d.t -= dt;
        this.dotAccum += d.dps * dt;
        if (d.t <= 0) this.dots.splice(i, 1);
      }
      if (this.dotAccumT <= 0 && this.dotAccum > 1) {
        const owner = this.dots.length ? this.dots[0].ownerId : null;
        game.hitEnemy(this, this.dotAccum, owner, 'dot');
        this.dotAccum = 0;
        this.dotAccumT = 0.3;
        if (!this.alive) return;
      }
    }

    // --- passives (Regrowth)
    if (this.has('regen')) {
      this.regenAccum += dt;
      if (this.regenAccum > 1) {
        this.regenAccum = 0;
        const near = game.nearestPlayer(this.position, 34);
        if (!near) this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.03);
      }
    }

    // --- PYRE Immolate / VENOM Contagion: the owner's passive makes the status itself spread
    if (game.isHost && this.dots.length > 0) this.spreadStatuses(game, dt);

    const aggro = this.isBoss ? CONFIG.tower.bossAggro + 20 : CONFIG.enemy.aggro;

    // ---- HUNTERS run a cycle of their own — walk in, leap, land hard, recover — so they never
    // wander, never kite and never lose the scent of the player they are hunting.
    if (g.hunter && g.hunt) {
      this.updateHunter(dt, game, aggro);
      return;
    }

    // ---- the THROTTLED DECISION PASS. Only the choice of target and state is rate-limited;
    // steering, animation and terrain contact stay smooth on every single frame.
    if (this.threatT > 0) this.threatT -= dt;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = g.behavior.thinkInterval;
      this.decide(game, aggro);
    }
    if (this.bFleeT > 0) this.bFleeT = Math.max(0, this.bFleeT - dt);

    // ---- bosses additionally run the STUN + enrage machine, which overrides everything else
    if (this.isBoss) {
      this.updateBoss(dt, game);
      if (this.bossState === 'enrage_transition') {
        // Winding up: no movement, no attacks, no damage taken. The body just roars.
        this.velocity.multiplyScalar(Math.max(0, 1 - dt * 3));
        this.rideTerrain(game, dt);
        return;
      }
      if (this.stunnedT > 0) {
        // STUNNED: the punish window. It cannot act at all — the stun IS the reward (no extra
        // damage is dealt in it).
        this.velocity.multiplyScalar(Math.max(0, 1 - dt * 5));
        this.rideTerrain(game, dt);
        return;
      }
    }

    // Sheltered players (inside a colony dome or a live Beacon shield) are not valid targets at all.
    const target = this.bTarget && this.bTarget.alive ? this.bTarget : null;

    // frozen solid: no movement, no attacks (this also covers the anti-cheese case, since a
    // rooted Necrophage simply cannot reach a player who is mid-choice)
    if (this.rootT > 0) {
      this.rootT -= dt;
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 6));
      this.rideTerrain(game, dt);
      return;
    }

    // Anti-cheese: while a player is locked into a Necromutation or Necrotech choice they are
    // frozen, so nearby Necrophages back off instead of feeding the burst that follows. The
    // retreat overrides pursuit, charges and attacks alike. The pursuit itself is dropped too —
    // with the frozen player now invisible to `decide` (see `Game.nearestPlayer`), a stale target
    // or an 8 s investigate order would otherwise walk the creature straight back into the ring
    // it was just pushed out of, over and over.
    const FLEE_R = 34;
    const frozen = game.nearestFrozenPlayer(this.position, FLEE_R);
    if (frozen) {
      if (this.bTarget === frozen) {
        this.bTarget = null;
        this.targetId = null;
      }
      if (this.threatT > 0) this.threatT = 0;
      const away = this.position.distanceTo(frozen.position);
      _v2.copy(this.position).sub(frozen.position);
      _v2.addScaledVector(this.up, -_v2.dot(this.up));
      if (_v2.lengthSq() < 1e-4) _v2.copy(this.facing);
      _v2.normalize();
      const urgency = 1 - away / FLEE_R;                 // 0 at the rim, 1 right on top of them
      const speed = (this.isBoss ? 7 : 12) * (0.5 + urgency * 1.4);
      this.velocity.lerp(_v2.multiplyScalar(speed), clamp(dt * 5, 0, 1));
      this.rideTerrain(game, dt);
      this.attackCd = Math.max(this.attackCd, 0.8);
      this.stealthed = false;
      if (this.rig) this.rig.group.visible = true;
      return;
    }

    // --- Ambush: hide while unseen, then strike.
    // A fleeing coward must NOT hide: the flee state clears the target, `wantsStealth` then read as
    // true, and the creep branch ignores every steering input while hidden — the creature froze in
    // place, invisible, for the rest of the match (no target could ever trip the release). Breaking
    // stealth on 'flee' keeps the break-off visible and moving.
    if (this.has('ambush')) {
      const fleeing = this.bState === 'flee' && this.bFleeT > 0;
      const wantsStealth = !target && !fleeing;
      if (wantsStealth && this.cd('ambush') <= 0 && !this.stealthed) {
        this.stealthed = true;
        this.setCd('ambush', 8);
      }
      if (this.stealthed && (target || fleeing)) {
        this.stealthed = false;
        if (target) {
          this.setCd('ambush', ABILITY_META.ambush.cd);
          game.effects.burst(this.position, this.genome.accent, { count: 12, speed: 9, life: 0.4, size: 0.6, gravity: 4 });
        }
        if (this.rig) this.rig.group.visible = true;
      }
      if (this.rig) this.rig.group.visible = !this.stealthed;
    }

    this.attackCd -= dt;

    let moveTarget: THREE.Vector3 | null = null;
    let speedMul = 1;

    if (!target) {
      if (this.isBoss && this.towerIdx >= 0) {
        const tower = game.towers.towers[this.towerIdx];
        if (tower) {
          // A guardian holds its POST, not the tower's base: walking at the crystal buries it in
          // the monument. The Nexus is scaled 4.4x (its base alone is ~10 m wide), so its post is
          // pushed out far enough that the patrol band wraps AROUND the statue — a Mega standing at
          // its old 8 m mark was inside the tower's own geometry, which read as "stuck in the
          // shield". The band is two-sided: being pulled inward alone let a wander drift it on to
          // the crystal.
          const nexus = tower.kind === 'nexus';
          const post = nexus ? Math.max(16, tower.shieldR * 0.62) : 14;
          const d = this.position.distanceTo(tower.position);
          if (d > post) {
            moveTarget = tower.position;
          } else if (d < post * (nexus ? 0.8 : 0.6)) {
            _v2.copy(this.position).sub(tower.position).normalize().multiplyScalar(post).add(tower.position);
            moveTarget = _v2;
          }
        }
      }
      if (!moveTarget) {
        this.wanderT -= dt;
        if (this.wanderT <= 0) {
          this.wanderT = 2.5 + Math.random() * 3;
          randomUnitVector(_v);
          _v.addScaledVector(this.up, -_v.dot(this.up)).normalize();
          this.wanderDir.copy(_v);
        }
        _v2.copy(this.position).addScaledVector(this.wanderDir, 6);
        moveTarget = _v2;
        speedMul = 0.28;
      }
    } else {
      this.targetId = target.id;
      const dist = this.position.distanceTo(target.position);
      const isRanged = g.ranged || g.projKind !== 'none';

      if (isRanged) {
        // The genome's `standoff` (the ranged trait's +3.2 m and its modifiers) stretches the
        // engagement distance past touch range: spitters and volleyers hold a few metres out and
        // fire from there instead of whirling point blank.
        const hold = Math.max(2.2, g.attackRange + g.behavior.standoff);
        // Hold the station. The station is a FIXED world point on our own bearing from the player
        // at `hold` — a mark the body can walk to and then stand on. The old kiting mark was
        // `position + tangent * 5*sin(clock)`: it rode the body, flipped sign twice per cycle and
        // (via a scratch-vector aliasing bug where `_v3` was overwritten mid-expression) collapsed
        // on to the creature itself. The result sprinted sideways across the target line forever,
        // stalling whenever the mark passed through it — on slopes that read as "stuck, flickering
        // back and forth", never closing on the player.
        _bw.copy(this.position).sub(target.position).normalize().multiplyScalar(hold).add(target.position);
        if (dist > hold * 1.05 || dist < hold * 0.62) {
          moveTarget = _v3.copy(_bw);
          // ease into the station so a full-speed sprint cannot slam straight through it
          speedMul = (dist < hold ? 0.7 : 1) * clamp(Math.abs(dist - hold) / 3, 0.25, 1);
        } else {
          // on station: a slow, shallow sway around the mark, then a full settle once it is reached
          _bw.copy(this.position).sub(target.position).normalize()
            .applyAxisAngle(this.up, 0.09 * Math.sin(game.clock * 0.45 + this.id * 2.1))
            .multiplyScalar(hold).add(target.position);
          if (_bw.distanceToSquared(this.position) > 0.36) {
            moveTarget = _v3.copy(_bw);
            speedMul = 0.4;
          } else {
            moveTarget = null;                 // mark reached → stand and fire
          }
        }
        if (this.attackCd <= 0 && dist <= hold * 1.15) {
          // Frenzy shortens attack intervals as the creature bleeds
          const frenzy = this.has('frenzy') ? 1 + (1 - this.hp / this.maxHp) * 0.9 : 1;
          this.attackCd = g.attackCd / frenzy;
          this.rangedAttack(game, target);
        }
      } else {
        if (dist > g.attackRange * 0.9) {
          moveTarget = target.position;
          // swarm bodies commit to a FORMATION slot around the prey instead of piling on
          // the same point (plan §22)
          if (this.genome.swarm) moveTarget = this.formationSlot(game, target);
          // Arrive taper: charging into the stop band at full speed and relying on the 4/s
          // velocity decay slid the body ~2.5 m past the player before it stopped, where it
          // churned around the far side — the melee flavour of the same "flickers back and forth".
          speedMul = clamp((dist - g.attackRange * 0.9) / 2.5, 0.18, 1);
        }
        if (this.attackCd <= 0 && dist <= g.attackRange + 0.6) {
          const frenzy = this.has('frenzy') ? 1 + (1 - this.hp / this.maxHp) * 0.9 : 1;
          this.attackCd = g.attackCd / frenzy;
          if (this.has('slam') && dist < g.attackRange + 1.5 && this.cd('slam') <= 0) {
            this.setCd('slam', ABILITY_META.slam.cd);
            this.slam(game, target, 5.5 + g.radius * 1.6, 1.3);
          } else {
            this.melee(game, target);
          }
        }
      }

      // --- movement / control abilities. (`chargeT` is ticked by the per-frame timer block at the
      // top of `update`; here it only gates the chain so a live dash cannot retrigger.)
      if (this.chargeT <= 0 && dist > 6) {
        if (this.has('charge') && this.cd('charge') <= 0) {
          this.setCd('charge', ABILITY_META.charge.cd);
          this.chargeT = 0.8;
          _v.copy(target.position).sub(this.position).normalize();
          this.velocity.addScaledVector(_v, 17);
          game.effects.burst(this.position, this.genome.accent, { count: 10, speed: 8, life: 0.3, size: 0.6, gravity: 2 });
        } else if (this.has('blink') && this.cd('blink') <= 0) {
          this.setCd('blink', ABILITY_META.blink.cd);
          _v.copy(target.position).sub(this.position).normalize().multiplyScalar(Math.min(dist - 3, 10));
          game.effects.ring(this.position, this.up, 1.2, this.genome.accent, 0.4, 2, 0.8);
          this.position.add(_v);
          game.planet.projectToSurface(this.position);
          this.up.copy(this.position).normalize();
          game.effects.ring(this.position, this.up, 1.2, this.genome.accent, 0.4, 2, 0.8);
        } else if (this.has('leap') && this.cd('leap') <= 0) {
          this.setCd('leap', ABILITY_META.leap.cd);
          _v.copy(target.position).sub(this.position).normalize();
          this.velocity.addScaledVector(_v, 12).addScaledVector(this.up, 13);
          game.effects.burst(this.position, this.genome.accent, { count: 12, speed: 8, life: 0.35, size: 0.6, gravity: 10 });
        }
      }
      if (this.has('burrow') && this.cd('burrow') <= 0 && dist < 26) {
        this.setCd('burrow', ABILITY_META.burrow.cd);
        this.stealthed = true;
        if (this.rig) this.rig.group.visible = false;
        game.effects.ring(this.position, this.up, 1.2, this.genome.color, 0.5, 1.6, 0.7);
        setTimeoutHost(() => {
          if (!this.alive) return;
          this.stealthed = false;
          if (this.rig) this.rig.group.visible = true;
        }, 900);
      }
      if (this.has('pack') && this.cd('pack') <= 0) {
        const kin = game.enemies.query(this.position.x, this.position.y, this.position.z, 26, game.enemies.scratch());
        let called = 0;
        for (const other of kin) {
          if (other === this || !other.alive || other.genomeIdx !== this.genomeIdx) continue;
          if (++called > 4) break;
          _v.copy(target.position).sub(other.position).normalize();
          other.velocity.addScaledVector(_v, 9);
        }
        if (called > 0) this.setCd('pack', ABILITY_META.pack.cd);
      }
      if (this.has('gravPull') && this.cd('gravPull') <= 0 && dist < 15) {
        this.setCd('gravPull', ABILITY_META.gravPull.cd);
        game.effects.ring(this.position, this.up, 2, this.genome.accent, 0.6, 3, 0.9);
        for (const p of game.players.values()) {
          if (!p.alive || p.position.distanceTo(this.position) > 15) continue;
          // no tug of war through a ward
          if (game.inSafeZone(p.position, 0)) continue;
          _v.copy(this.position).sub(p.position).normalize();
          p.velocity.addScaledVector(_v, 14);
        }
      }
      if (this.has('shield') && this.cd('shield') <= 0 && this.hp < this.maxHp * 0.75) {
        this.setCd('shield', ABILITY_META.shield.cd);
        this.guardMul = 0.35;
        this.guardT = 3.2;
        game.effects.ring(this.position, this.up, 1.6, this.genome.accent, 0.7, 1.6, 0.8);
      }

      // bosses keep their heavy specials
      if (this.isBoss && this.attackCd <= 0 && dist < 12) {
        this.attackCd = g.attackCd;
      }
      if (this.isBoss && this.towerIdx >= 0) {
        const tower = game.towers.towers[this.towerIdx];
        if (tower && this.position.distanceTo(tower.position) > CONFIG.tower.leash) moveTarget = tower.position;
      }
    }

    // ---- behaviour overrides. The state machine wins over the plain "walk at the target" plan.
    const prof = g.behavior;
    if (this.bState === 'flee' && this.bFleeT > 0) {
      _bv.copy(this.position).sub(target ? target.position : this.lastThreat);
      _bv.addScaledVector(this.up, -_bv.dot(this.up));
      if (_bv.lengthSq() < 1e-4) _bv.copy(this.facing).multiplyScalar(-1);
      _bv.normalize();
      moveTarget = _bw.copy(this.position).addScaledVector(_bv, 16);
      speedMul = prof.fleeSpeedMul;
      this.attackCd = Math.max(this.attackCd, 0.7);
    } else if (this.bState === 'return' && !target) {
      moveTarget = _bw.copy(this.home);
      speedMul = 0.7;
    } else if (this.bState === 'investigate' && !target) {
      moveTarget = _bw.copy(this.lastThreat);
      speedMul = 0.75;
    } else if (target) {
      speedMul *= prof.chaseSpeedMul;
    }

    // --- locomotion
    if (this.chargeT > 0 || this.stealthed) {
      // keep current momentum (charge) or creep while burrowed
      if (this.stealthed) this.velocity.multiplyScalar(Math.max(0, 1 - dt * 2));
    } else if (moveTarget) {
      _v.copy(moveTarget).sub(this.position).normalize();
      const near = game.enemies.query(this.position.x, this.position.y, this.position.z, this.radius * 3, game.enemies.scratch());
      let sep = 0;
      for (const other of near) {
        if (other === this || !other.alive) continue;
        const d = other.position.distanceTo(this.position);
        const want = this.radius + other.radius + 0.4;
        if (d < want && d > 0.001) {
          _v.addScaledVector(_v2.copy(this.position).sub(other.position).normalize(), ((want - d) / want) * 1.4);
          if (++sep >= 4) break;
        }
      }
      _v.addScaledVector(this.up, -_v.dot(this.up)).normalize();
      const speed = g.speed * this.slowMul * speedMul * (this.stealthed ? 1.3 : 1);
      const accel = this.isBoss ? 9 : 16;
      this.velocity.lerp(_v.multiplyScalar(speed), clamp(accel * dt, 0, 1));
    } else {
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 4));
    }

    // integrate + ride the terrain
    this.rideTerrain(game, dt);

    this.animPhase += dt * (2 + this.velocity.length() * 0.8);
  }

  // ------------------------------------------------------------ behaviour

  /**
   * Drops the current chase when it can no longer be reached: the target died, or took shelter
   * inside a colony dome (or the healing pad under it) or a live Beacon ward. `EnemyManager` calls
   * this every frame, so the give-up lands the moment the bubble closes instead of on the next
   * think tick — `bTarget` is what the per-frame brain swings at.
   */
  dropShelteredTarget(game: Game): boolean {
    let dropped = false;
    if (this.bTarget && (!this.bTarget.alive || game.inSafeZone(this.bTarget.position, 1.5))) {
      this.bTarget = null;
      dropped = true;
    }
    if (this.targetId) {
      // an Echo Decoy id is a valid chase: it is not a player entry, but it is a real body until it
      // pops, and dropping it here is what would otherwise stop the swarm chasing the double
      const p = game.players.get(this.targetId) ?? game.decoyTargetById(this.targetId);
      if (!p || !p.alive || game.inSafeZone(p.position, 1.5)) {
        this.bTarget = null;
        this.targetId = null;
        dropped = true;
      }
    }
    return dropped;
  }

  /**
   * The throttled brain: one target choice and one state transition every `thinkInterval` seconds
   * (0.2-0.3 s). The old code asked `nearestPlayer` for every creature on every frame; at 150
   * Necrophages that was the single most expensive thing in a big match. Only the CHOICE is
   * rate-limited — steering, animation and terrain contact still run every frame.
   *
   * What it may choose is decided by its own traits: a pack hunter prefers whoever its kin are
   * biting, a territorial one refuses to be dragged off its ground, a coward turns and runs past
   * its own health threshold.
   */
  private decide(game: Game, aggro: number): void {
    const prof = this.genome.behavior;

    // ---- break off when badly hurt (cowardly / fleeing)
    if (prof.fleeHp > 0 && this.maxHp > 0 && this.hp <= this.maxHp * prof.fleeHp) {
      if (this.bFleeT <= 0) {
        this.bFleeT = prof.fleeTime;
        this.bState = 'flee';
        this.bTarget = null;
        this.targetId = null;
        return;
      }
    }
    if (this.bFleeT > 0) {
      this.bState = 'flee';
      return;
    }

    // ---- territorial: pulled too far from home, walk back and drop the chase on the way
    if (prof.territory > 0) {
      const homeD2 = this.position.distanceToSquared(this.home);
      if (homeD2 > prof.territory * prof.territory) {
        this.bState = 'return';
        this.bTarget = null;
        this.targetId = null;
        return;
      }
    }

    // ---- ECHO DECOY: a live double inside aggro reads as a player and WINS the choice. That is the
    // whole point of the perk — the dash leaves a body behind that the pack turns on.
    const decoy = game.decoyTarget(this.position, Math.min(aggro, DECOY_TAUNT_RADIUS));
    if (decoy) {
      this.bTarget = decoy;
      this.targetId = decoy.id;
      this.bState = 'attack';
      return;
    }

    const found = game.nearestPlayer(this.position, aggro, true);
    if (!found) {
      this.bTarget = null;
      this.targetId = null;
      if (this.threatT > 0) this.bState = 'investigate';
      else if (prof.territory > 0 && this.position.distanceToSquared(this.home) > prof.territory * prof.territory * 0.25) this.bState = 'return';
      else if (prof.guardian) this.bState = 'defend';
      else this.bState = 'idle';
      return;
    }

    // ---- pack bias: run at whoever the kin beside us are already biting
    let chosen: Player = found;
    let grouped = false;
    if (prof.groupBias > 0) {
      const kin = game.enemies.query(this.position.x, this.position.y, this.position.z, 22, game.enemies.scratch());
      let best = 0;
      for (const other of kin) {
        if (other === this || !other.alive || other.targetId === null) continue;
        const mate = game.players.get(other.targetId);
        if (!mate || !mate.alive) continue;
        // never inherit a chase on a survivor who has taken shelter (kin can still hold their id)
        if (game.inSafeZone(mate.position, 0)) continue;
        const d = this.position.distanceTo(mate.position);
        if (d > aggro) continue;
        const score = prof.groupBias + (1 - d / aggro) * 0.4;
        if (score > best) {
          best = score;
          chosen = mate;
          grouped = true;
        }
      }
    }
    // ---- TARGET PREFERENCE (plan §21): when kin have not already committed the pack to a
    // chase, the genome's own personality re-picks among the valid candidates.
    if (!grouped) chosen = this.pickByPreference(game, aggro, chosen);
    this.bTarget = chosen;
    this.targetId = chosen.id;
    // A guardian with kin in sight holds its post rather than charging off; everything else attacks.
    this.bState = grouped ? 'group' : 'attack';
  }

  /**
   * TARGET PREFERENCE (plan §21): the genome's own personality picks among every VALID
   * candidate in range. Sheltered and frozen players are never candidates — the same
   * filters the default nearest-player query applies — so a preference can never
   * re-introduce a cheese target. Data available to the sim decides the rest:
   * LOWEST_HP = most wounded, HIGHEST_DAMAGE = the player who has dealt the most damage,
   * ISOLATED = the loneliest straggler, COLONY_TARGET = the clustered pack of players,
   * OBJECTIVE_TARGET = whoever is closest to the nearest tower.
   */
  private pickByPreference(game: Game, aggro: number, fallback: Player): Player {
    const pref = this.genome.targetPreference;
    if (!pref || pref === 'NEAREST') return fallback;
    if (pref === 'LAST_ATTACKER' && this.lastAttackerId) {
      const atk = game.players.get(this.lastAttackerId);
      if (atk && atk.alive && !atk.frozen && this.position.distanceTo(atk.position) <= aggro && !game.inSafeZone(atk.position, 0)) {
        return atk;
      }
    }
    const candidates: Player[] = [];
    for (const p of game.players.values()) {
      if (!p.alive || p.frozen) continue;
      if (this.position.distanceTo(p.position) > aggro) continue;
      if (game.inSafeZone(p.position, 0)) continue;
      candidates.push(p);
    }
    if (candidates.length === 0) return fallback;
    // nearest tower for the objective defence reading (plan §21: "some defend the objective")
    let towerPos: THREE.Vector3 | null = null;
    if (pref === 'OBJECTIVE_TARGET') {
      let best = Infinity;
      for (const tower of game.towers.towers) {
        const d = this.position.distanceToSquared(tower.position);
        if (d < best) {
          best = d;
          towerPos = tower.position;
        }
      }
    }
    let bestP: Player = candidates[0];
    let bestScore = -Infinity;
    for (const p of candidates) {
      let score: number;
      switch (pref) {
        case 'LOWEST_HP':
          score = 1 - p.hp / Math.max(1, p.maxHp);
          break;
        case 'HIGHEST_DAMAGE':
          score = p.damageDealt;
          break;
        case 'ISOLATED': {
          // stalking a straggler: score by distance to the FEAREST other player
          let nearestKin = Infinity;
          for (const q of game.players.values()) {
            if (q === p || !q.alive) continue;
            nearestKin = Math.min(nearestKin, p.position.distanceTo(q.position));
          }
          score = nearestKin === Infinity ? 100 : nearestKin;
          break;
        }
        case 'COLONY_TARGET': {
          // breaking up the pack: score by how many allies stand beside them
          let mates = 0;
          for (const q of game.players.values()) {
            if (q === p || !q.alive) continue;
            if (p.position.distanceTo(q.position) < 14) mates++;
          }
          score = mates;
          break;
        }
        case 'OBJECTIVE_TARGET':
          score = towerPos ? -p.position.distanceTo(towerPos) : -this.position.distanceTo(p.position);
          break;
        case 'RANDOM':
        default:
          // deterministic per-think randomness: stable for a frame, varies over time
          score = ((Math.imul(this.id ^ 2654435761, 1) ^ Math.floor(game.clock * 7 + this.id * 13)) >>> 0) % 1000 / 1000;
          break;
      }
      if (score > bestScore) {
        bestScore = score;
        bestP = p;
      }
    }
    return bestP;
  }

  /**
   * SWARM FORMATION SLOT (plan §22): where this body commits around its prey. The
   * formation, orbit radius, cohesion and aggression from the genome's swarm profile
   * are EXECUTED here — RING/SURROUND circle, BALL/CLOUD crowd in close, WEDGE/STREAM
   * flank, ARC holds a side, SPIRAL winds inward.
   */
  private formationSlot(game: Game, target: Player): THREE.Vector3 {
    const s = this.genome.swarm;
    const out = _sw1;
    if (!s) return out.copy(target.position);
    const orbit = Math.max(0.9, this.genome.attackRange * 0.75 + s.orbitRadius * (1.25 - s.cohesion * 0.5));
    const base = (this.id * 2.399963) % (Math.PI * 2);
    let radius = orbit;
    let angle = base + game.clock * (0.2 + s.aggression * 0.4);
    switch (s.formation) {
      case 'BALL':
      case 'CLOUD':
        radius = orbit * 0.6;
        break;
      case 'WEDGE':
      case 'STREAM':
        radius = orbit * 0.8;
        angle = base * 0.3 + (this.id % 2 ? 0.45 : -0.45);
        break;
      case 'ARC':
        angle = Math.sin(base) * 0.7 + game.clock * 0.15 * s.aggression;
        break;
      case 'SPIRAL':
        radius = orbit * (0.55 + 0.45 * Math.abs(Math.sin(game.clock * 0.35 + base)));
        break;
      default:
        break; // RING / SURROUND hold the full circle
    }
    // the slot lives in the target's tangent plane (planets are spheres)
    tangentBasis(target.up, _sw2, _sw3);
    out.copy(target.position).addScaledVector(_sw2, Math.cos(angle) * radius).addScaledVector(_sw3, Math.sin(angle) * radius);
    return out;
  }

  // ------------------------------------------------------------ hunters

  /**
   * The Hunter cycle, kept deliberately plain: walk in slowly, mark the ground under the target,
   * coil, leap on to the mark, land with an impact, recover, repeat. There is no stalking, no stealth
   * and no hidden state — a player can always read exactly what the creature is about to do (the
   * telegraph disc IS the landing spot), and the two hunters differ only in the numbers in their own
   * `hunt` block.
   */
  private updateHunter(dt: number, game: Game, aggro: number): void {
    const h = this.genome.hunt!;
    const prof = this.genome.behavior;
    this.attackCd -= dt;
    this.hunterCd = Math.max(0, this.hunterCd - dt);

    if (this.slowT > 0) {
      this.slowT -= dt;
      if (this.slowT <= 0) this.slowMul = 1;
    }
    // frozen solid: even a hunter stops dead — and a wind-up that gets frozen is CANCELLED, because
    // the disc on the ground expires long before the ice lets go and a leap from an expired marker
    // would be an untelegraphed hit
    if (this.rootT > 0) {
      this.rootT -= dt;
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 6));
      if (this.hunterState === 'windup') {
        this.hunterState = 'stalk';
        this.hunterT = 0;
      }
      this.rideTerrain(game, dt);
      return;
    }
    // the anti-cheese retreat still applies: a player locked into a choice is left alone
    const frozen = game.nearestFrozenPlayer(this.position, 34);
    if (frozen) {
      _bv.copy(this.position).sub(frozen.position);
      _bv.addScaledVector(this.up, -_bv.dot(this.up));
      if (_bv.lengthSq() < 1e-4) _bv.copy(this.facing);
      _bv.normalize();
      this.velocity.lerp(_bw.copy(_bv).multiplyScalar(7), clamp(dt * 5, 0, 1));
      this.rideTerrain(game, dt);
      return;
    }

    if (this.hunterState === 'windup') {
      this.hunterT += dt;
      // it coils in place on the mark, facing it, and does NOT chase: the telegraph promised the
      // landing spot, so the body must not quietly re-aim while the disc fills
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
      _bv.copy(this.huntAt).sub(this.position);
      _bv.addScaledVector(this.up, -_bv.dot(this.up));
      if (_bv.lengthSq() > 1e-4) {
        _bv.normalize();
        this.facing.lerp(_bv, clamp(dt * 6, 0, 1));
        this.facing.addScaledVector(this.up, -this.facing.dot(this.up));
        if (this.facing.lengthSq() > 1e-5) this.facing.normalize();
      }
      this.rideTerrain(game, dt);
      this.animPhase += dt * 1.1;
      if (this.hunterT >= h.telegraph) this.launchLeap(game, h);
      return;
    }
    if (this.hunterState === 'leap') {
      this.hunterT += dt;
      this.rideTerrain(game, dt);
      // it lands when it touches the ground again (a longer fallback guards a stuck frame)
      if (this.airH <= 0 || this.hunterT > h.leapTime * 1.9) {
        this.hunterImpact(game, h);
        this.hunterState = 'recover';
        this.hunterT = 0;
      }
      this.animPhase += dt * 3;
      return;
    }
    if (this.hunterState === 'recover') {
      this.hunterT += dt;
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 3));
      this.rideTerrain(game, dt);
      if (this.hunterT >= h.recover) {
        this.hunterState = 'stalk';
        this.hunterT = 0;
      }
      this.animPhase += dt * 2;
      return;
    }

    // ---- stalk: close in SLOWLY, and commit the moment the target is inside leap range
    const target = game.nearestPlayer(this.position, aggro, true);
    this.targetId = target ? target.id : null;
    if (!target) {
      // No scent. The hunter cycle has no wander step, so this used to just FREEZE — and it only
      // ever leaves stalk through a target, so a hunter whose prey left aggro (died and respawned
      // across the planet, took shelter behind a ward) stood on the field like a statue for the
      // rest of the match: the "enemy got stuck on a slope" report. Prowl: walk back to where it
      // spawned (players were near it then) and wander there until something re-enters its range.
      _bv.copy(this.home).sub(this.position);
      _bv.addScaledVector(this.up, -_bv.dot(this.up));
      if (_bv.length() > 3) {
        if (_bv.lengthSq() > 1e-5) _bv.normalize();
        else _bv.copy(this.facing);
        this.velocity.lerp(_bw.copy(_bv).multiplyScalar(5), clamp(dt * 4, 0, 1));
      } else {
        this.wanderT -= dt;
        if (this.wanderT <= 0) {
          this.wanderT = 2.5 + Math.random() * 3;
          randomUnitVector(_v);
          _v.addScaledVector(this.up, -_v.dot(this.up)).normalize();
          this.wanderDir.copy(_v);
        }
        _v2.copy(this.wanderDir).addScaledVector(this.up, -this.wanderDir.dot(this.up));
        if (_v2.lengthSq() > 1e-5) _v2.normalize();
        else _v2.copy(this.facing);
        this.velocity.lerp(_bw.copy(_v2).multiplyScalar(2.5), clamp(dt * 4, 0, 1));
      }
      this.rideTerrain(game, dt);
      this.animPhase += dt * (2 + this.velocity.length() * 0.8);
      return;
    }
    const dist = this.position.distanceTo(target.position);
    _bv.copy(target.position).sub(this.position);
    _bv.addScaledVector(this.up, -_bv.dot(this.up));
    if (_bv.lengthSq() > 1e-5) _bv.normalize();
    else _bv.copy(this.facing);
    const speed = Math.min(6.6, this.genome.speed * prof.chaseSpeedMul * this.slowMul);
    this.velocity.lerp(_bw.copy(_bv).multiplyScalar(speed), clamp(dt * 6, 0, 1));

    if (dist <= h.leapRange && this.hunterCd <= 0 && dist > 2.2) {
      this.beginWindup(game, h, target);
    } else if (this.attackCd <= 0 && dist <= this.genome.attackRange + 0.7) {
      this.attackCd = this.genome.attackCd;
      if (this.has('slam')) {
        this.setCd('slam', ABILITY_META.slam.cd);
        this.slam(game, target, 5 + this.genome.radius * 1.4, 1.2);
      } else {
        this.melee(game, target);
      }
    }
    this.rideTerrain(game, dt);
    this.animPhase += dt * (2 + this.velocity.length() * 0.8);
  }

  /**
   * Commits to a pounce: marks the ground the target stands on with a terrain-conforming disc, then
   * coils for `telegraph` seconds. The mark is where the TARGET is at commit time (exactly like the
   * boss's rage leap) — stepping out of the circle during the wind-up is the counterplay.
   */
  private beginWindup(game: Game, h: HunterProfile, target: Player): void {
    this.hunterState = 'windup';
    this.hunterT = 0;
    this.hunterCd = h.leapCd;
    this.huntAt.copy(target.position);
    game.enemyTelegraph('disc', this.huntAt, this.up, _zeroDir, h.impactRadius, 0, h.telegraph);
    game.broadcastEnemyEvent(this.id, 'hunttl', this.huntAt, this.up, h.impactRadius, h.telegraph);
    game.effects.ring(this.position, this.up, this.radius * 1.4, this.genome.accent, 0.35, 2, 0.7);
    game.audio.sfx('alarm', 0.5);
  }

  /** Launches the committed pounce: a real ballistic arc aimed at the marked spot. */
  private launchLeap(game: Game, h: HunterProfile): void {
    this.hunterState = 'leap';
    this.hunterT = 0;
    // aim from where the body actually is, at the mark it committed to — the mark does not move
    _bv.copy(this.huntAt).sub(this.position);
    _bv.addScaledVector(this.up, -_bv.dot(this.up));
    const travel = _bv.length();
    if (travel > 1e-4) _bv.normalize();
    else _bv.copy(this.facing);
    const upSpeed = Math.max(7, ENEMY_GRAVITY * h.leapTime * 0.5);
    // Horizontal speed covers the mark in `leapTime`, so the flight lands on the disc exactly when
    // the telegraph said it would, whatever the target did during the wind-up.
    const dirSpeed = clamp(travel / Math.max(0.25, h.leapTime), 2, 34);
    this.velocity.copy(_bv).multiplyScalar(dirSpeed).addScaledVector(this.up, upSpeed);
    this.airH = 0.06;
    this.chargeT = 0;
    game.effects.ring(this.position, this.up, this.radius * 1.8, this.genome.accent, 0.4, 2.4, 0.9);
    game.effects.burst(this.position, this.genome.accent, { count: 14, speed: 9, life: 0.4, size: 0.7, gravity: 8, up: this.up, spread: 0.6 });
    game.effects.shake(0.07);
    game.audio.sfx('dash', 0.45);
    this.netEvent(game, 'huntleap');
  }

  /** The landing: an area impact that everyone nearby feels, plus Hunter 2's follow-up bite. */
  private hunterImpact(game: Game, h: HunterProfile): void {
    game.effects.ring(this.position, this.up, 1.6, this.genome.accent, 0.5, 3.4, 1);
    game.effects.disk(this.position, this.up, h.impactRadius, this.genome.accent, 0.45, 1.25, 0.4);
    game.effects.burst(this.position, this.genome.accent, { count: 26, speed: 15, life: 0.6, size: 0.85, gravity: 14 });
    game.effects.shake(0.24);
    game.audio.sfx('explode', 0.6);
    if (game.isHost) {
      for (const p of game.players.values()) {
        if (!p.alive) continue;
        if (p.position.distanceTo(this.position) > h.impactRadius + 1) continue;
        game.hitPlayer(p, this.damage(h.impactMul), null, 'enemy');
      }
      if (h.followUp) {
        // Hunter 2's identity: the slam is only the opening — a bite lands a beat later
        const target = game.nearestPlayer(this.position, this.genome.attackRange + 3.5, true);
        if (target) {
          game.scheduleHost(0.35, () => {
            if (!this.alive || !target.alive) return;
            if (target.position.distanceTo(this.position) > this.genome.attackRange + 2) return;
            game.hitPlayer(target, this.damage(0.95), null, 'enemy');
            game.effects.burst(target.position, this.genome.accent, { count: 10, speed: 8, life: 0.35, size: 0.6, gravity: 6 });
          });
        }
      }
    }
    this.netEvent(game, 'huntland');
  }

  // ------------------------------------------------------------ boss combat

  /** Outgoing damage: the traits, the match curve, and the enraged phase's raised offence. */
  private bossDamageMul(): number {
    return this.enraged ? CONFIG.boss.enragedDamageMultiplier : 1;
  }

  /**
   * Incoming damage: the guardian's flat armour, the enraged phase's raised defence, and nothing
   * else. A broken boss is a pure STUN — it cannot act for 2 s, but it takes no extra
   * damage in that window.
   */
  damageTakenMul(): number {
    // The body plan owns the flat armour (plan §18: shell = tanky) — bosses stack their own.
    const armor = this.genome.armor ?? 1;
    if (!this.isBoss) return armor;
    let mul = CONFIG.boss.damageTaken * armor;
    if (this.enraged) mul /= CONFIG.boss.enragedDefenseMultiplier;
    return mul;
  }

  /**
   * True while the boss is damage-immune — the one-second enrage transition, and nothing else.
   * The host owns the timer; a client learns the same fact from the state flag in the snapshot, so
   * both sides agree and a client never shows an optimistic hit the host is going to refuse.
   */
  get damageImmune(): boolean {
    return this.immuneT > 0 || this.bossState === 'enrage_transition';
  }

  /**
   * Damage fills the stun bar DOWN. An empty bar breaks the boss open: it is STUNNED for
   * `stunDuration` and the bar refills itself across that window. That is the entire stun
   * rule — the stun is the reward, damage taken is NOT raised while it is stunned. The CALLER
   * converts health damage into bar damage (see `Game.hostApplyEnemyDamage`, which applies
   * `CONFIG.boss.stunDamageMul` = 2, so the bar drains twice as fast as the health does).
   *
   * While the boss is already stunned, damage to the bar is REFUSED outright — the punish window is a
   * fixed 2 seconds that no amount of incoming fire can push back or extend.
   */
  addStun(amount: number, game: Game): void {
    if (!this.isBoss || this.stunMax <= 0 || this.stunnedT > 0) return;
    this.stun -= amount;
    this.stunDelayT = CONFIG.boss.stunDelay;
    if (this.stun > 0) return;
    this.stun = 0;
    this.stunnedT = CONFIG.boss.stunDuration;
    this.mechCast = -1;
    this.mechT = 0;
    game.effects.ring(this.position, this.up, this.radius * 2, 0xffe066, 0.7, 2.6, 1);
    game.effects.burst(this.position, 0xffe066, { count: 22, speed: 13, life: 0.6, size: 0.8, gravity: -3, up: this.up, spread: 1 });
    game.effects.shake(0.2);
    game.audio.sfx('shieldDown', 0.8);
    game.ui.banner(`${this.genome.name} STUNNED`, 1800);
    this.netEvent(game, 'bossstun');
  }

  /**
   * Boss state machine: NORMAL -> ENRAGE_TRANSITION -> ENRAGED -> DEAD.
   *
   * Stun recovery runs first, then the one-shot enrage at the health threshold, then the two
   * enraged mechanics. Nothing here can fire twice.
   */
  private updateBoss(dt: number, game: Game): void {
    if (this.bossState === 'dead') return;

    // ---- the enrage transition: complete immunity, no attacks, no movement
    if (this.bossState === 'enrage_transition') {
      this.immuneT = Math.max(0, this.immuneT - dt);
      if (this.immuneT <= 0) {
        this.bossState = 'enraged';
        this.enraged = true;
        this.mechCd[0] = 2.4;
        this.mechCd[1] = 4.8;
        game.audio.sfx('alarm', 0.6);
        this.netEvent(game, 'bossrage');
      }
      return;
    }

    // ---- STUN: the punish window. The boss cannot act for `stunDuration`, and the bar races back
    // to full across it so the punish window has a visible clock. Damage is refused by `addStun`
    // while this runs, so nothing the players do can extend or shorten it.
    if (this.stunnedT > 0) {
      this.stunnedT -= dt;
      this.stun = Math.min(this.stunMax, this.stun + this.stunMax * CONFIG.boss.stunBrokenRegen * dt);
      if (this.stunnedT <= 0) {
        this.stunnedT = 0;
        // the bar has already refilled across the whole stun, so the boss comes out of it with a
        // full bar rather than an empty one; the delay only governs the idle regen that follows
        this.stun = this.stunMax;
        this.stunDelayT = CONFIG.boss.stunDelay;
        this.netEvent(game, 'bossrecover');
      }
      return;
    }
    if (this.stunDelayT > 0) this.stunDelayT -= dt;
    else if (this.stun < this.stunMax) {
      this.stun = Math.min(this.stunMax, this.stun + this.stunMax * CONFIG.boss.stunRegen * dt);
    }

    // ---- the enrage fires EXACTLY ONCE, at or below the health threshold
    if (!this.enrageFired && this.maxHp > 0 && this.hp <= this.maxHp * CONFIG.boss.enrageAt) {
      this.enterEnrage(game);
      return;
    }

    // Heavies run in BOTH phases; the enraged phase simply owns two more of them and cycles faster.
    this.updateMechanics(dt, game);
  }

  /**
   * Half health: the boss goes damage-immune for one second, screams, and throws everything nearby
   * off it. The wave exists to RESET THE FIGHTING SPACE and to say, unmistakably, "this is the
   * second half of the fight".
   */
  private enterEnrage(game: Game): void {
    const B = CONFIG.boss;
    this.bossState = 'enrage_transition';
    this.enraged = false;
    this.enrageFired = true;
    this.immuneT = B.enrageImmunity;
    this.stun = this.stunMax;
    this.stunnedT = 0;
    this.mechCast = -1;
    this.velocity.set(0, 0, 0);

    // The enraged phase UNLOCKS two heavies the boss did not have before — a marching chain of
    // eruptions and a leap on to the marked ground — each with its own marker and its own pattern.
    // The point is a new fight, not the same attacks with bigger numbers.
    for (const id of ENRAGED_MECHANICS) if (this.bossMechanics.indexOf(id) < 0) this.bossMechanics.push(id);
    this.mechCd = this.bossMechanics.map(() => 3.5);

    const r = B.enrageWaveRadius;
    game.effects.ring(this.position, this.up, r * 0.2, 0xff2d2d, 0.95, 5, 1);
    game.effects.wave(this.position, this.up, r, 0xff2d2d, { dur: 0.9, rings: 4, debris: 44, alpha: 0.95 });
    game.effects.disk(this.position, this.up, r * 0.5, 0xff5a1e, 0.6, 2.4, 0.35);
    game.effects.burst(this.position, 0xff5a1e, { count: 44, speed: 21, life: 0.85, size: 1.1, gravity: 10 });
    game.effects.shake(0.55);
    game.audio.sfx('bossRoar', 1);
    // Only the MEGA NECROPHAGE's enrage is a match-wide beat worth a banner. Announcing every
    // Beacon guardian's enrage as well turned routine tower fights into a stream of global
    // call-outs that meant nothing to anyone not standing in that particular ring. The tell itself
    // is untouched — the red push wave, the particles, the ENRAGED tag on its plate.
    const tower = game.towers.towers[this.towerIdx];
    if (tower && tower.kind === 'nexus') game.ui.banner(`${this.genome.name} — ENRAGED`, 3000);
    if (game.isHost) game.pushPlayersFrom(this.position, r, B.enragePush, 0.4);
    game.broadcastEnemyEvent(this.id, 'bossenrage', this.position, this.up, r);
  }

  /**
   * The heavy ROTATION. A boss cycles its own kit — the enraged phase adds two more and shortens
   * every cooldown — and each entry is telegraphed on the terrain before it lands.
   *
   * Heavies are what make a boss fight a fight instead of a health bar: they are the moments a
   * player has to move, and every one of them is announced on the ground first.
   */
  private updateMechanics(dt: number, game: Game): void {
    if (this.bossMechanics.length === 0) return;
    // A committed heavy always finishes its telegraph: nothing may ever skip the warning.
    if (this.mechCast >= 0) {
      this.mechT -= dt;
      if (this.mechT <= 0) this.fireMechanic(game, this.mechCast);
      return;
    }
    for (let i = 0; i < this.mechCd.length; i++) this.mechCd[i] = Math.max(0, this.mechCd[i] - dt);
    const target = this.bTarget && this.bTarget.alive ? this.bTarget : null;
    if (!target) return;
    const dist = this.position.distanceTo(target.position);
    for (let i = 0; i < this.bossMechanics.length; i++) {
      if (this.mechCd[i] > 0) continue;
      if (dist > BOSS_MECHANICS[this.bossMechanics[i]].range) continue;
      this.startMechanic(game, i, target);
      return;
    }
  }

  /** Commits one heavy: pick its shape, draw the marker, arm the landing. */
  private startMechanic(game: Game, idx: number, target: Player): void {
    const id = this.bossMechanics[idx];
    const spec = BOSS_MECHANICS[id];
    this.mechCd[idx] = spec.cd * (this.enraged ? CONFIG.boss.enragedCadence : 1);
    this.mechFrom.copy(this.position);
    this.mechAt.copy(this.position);
    game.audio.sfx('alarm', 0.7);

    // Two heavies resolve on their own schedule, because they land more than once.
    if (id === 'ragechain') {
      this.castRageChain(game, spec);
      return;
    }
    if (id === 'rageleap') {
      this.castRageLeap(game, target, spec);
      return;
    }

    this.mechCast = idx;
    this.mechT = spec.lead;
    if (id === 'quake' || id === 'nova') {
      // Centred area: a disc for the slam, a hollow ring for the status burst, so the two read
      // differently at a glance even though both are "get away from the boss".
      this.mechRadius = id === 'quake' ? Math.max(13, 8 + this.radius * 3.4) : Math.max(11, 7 + this.radius * 2.6);
      const shape = id === 'nova' ? 'ring' : 'disc';
      game.enemyTelegraph(shape, this.mechFrom, this.up, _zeroDir, this.mechRadius, 0, spec.lead, BOSS_RED);
      game.broadcastBossTelegraph(this.id, shape, this.mechFrom, this.up, null, this.mechRadius, 0, spec.lead, BOSS_RED);
    } else if (id === 'dash') {
      // The lane is aimed at where the target stands NOW — stepping out of it IS the counterplay, so
      // the marker has to be honest about where the charge will go.
      _bv.copy(target.position).sub(this.position);
      _bv.addScaledVector(this.up, -_bv.dot(this.up));
      if (_bv.lengthSq() < 1e-4) _bv.copy(this.facing);
      _bv.normalize();
      this.mechDir.copy(_bv);
      this.mechLen = Math.min(36, Math.max(16, this.position.distanceTo(target.position) + 8));
      this.mechWidth = Math.max(3, this.radius * 1.6);
      game.enemyTelegraph('lane', this.mechFrom, this.up, this.mechDir, this.mechLen, this.mechWidth, spec.lead, BOSS_RED);
      game.broadcastBossTelegraph(this.id, 'lane', this.mechFrom, this.up, this.mechDir, this.mechLen, this.mechWidth, spec.lead, BOSS_RED);
    } else {
      // Aimed impact: marked where the target was at cast time, so moving out of it dodges it.
      this.mechAt.copy(target.position);
      this.mechRadius = Math.max(8, 5 + this.radius * 2.4);
      game.enemyTelegraph('disc', this.mechAt, this.up, _zeroDir, this.mechRadius, 0, spec.lead, BOSS_RED);
      game.broadcastBossTelegraph(this.id, 'disc', this.mechAt, this.up, null, this.mechRadius, 0, spec.lead, BOSS_RED);
    }
  }

  /** Resolves a committed heavy at the end of its telegraph. */
  private fireMechanic(game: Game, idx: number): void {
    const id = this.bossMechanics[idx];
    const spec = BOSS_MECHANICS[id];
    this.mechCast = -1;
    if (id === 'quake') this.landQuake(game, spec);
    else if (id === 'nova') this.landNova(game, spec);
    else if (id === 'dash') this.landDash(game, spec);
    else this.landImpact(game, spec, this.mechAt);
  }

  /**
   * Big area slam: damage everyone inside the ring and launch them straight UP off the ground. The
   * knock-up is the whole point — it is the one attack that punishes standing in the middle.
   */
  private landQuake(game: Game, spec: BossMechanicSpec): void {
    const r = this.mechRadius;
    game.effects.ring(this.mechFrom, this.up, r * 0.22, BOSS_RED, 0.6, 4.4, 1);
    game.effects.disk(this.mechFrom, this.up, r, BOSS_RED_DEEP, 0.5, 1.15, 0.4);
    game.effects.wave(this.mechFrom, this.up, r, BOSS_RED, { dur: 0.7, rings: 3, debris: 30, alpha: 0.9 });
    game.effects.burst(this.mechFrom, BOSS_RED_HOT, { count: 32, speed: 18, life: 0.7, size: 0.95, gravity: 12 });
    game.effects.shake(0.42);
    game.audio.sfx('explode', 0.85);
    if (game.isHost) {
      for (const p of game.players.values()) {
        if (!p.alive || p.position.distanceTo(this.mechFrom) > r + 1) continue;
        game.hitPlayer(p, this.damage(spec.mul), null, 'enemy', {
          dot: { kind: 'burn', dps: this.damage(0.18), dur: 3, label: 'Seismic Burn' },
        });
      }
      // the knock-up: a hard upward shove each peer applies to its own player
      game.pushPlayersFrom(this.mechFrom, r, 16, 1.7);
    }
    game.broadcastEnemyEvent(this.id, 'bossimpact', this.mechFrom, this.up, r);
  }

  /**
   * Status burst. The ELEMENT still comes off the boss's own generated kit, but it is no longer
   * painted on to the tell: every boss telegraph is red, so the marker says "a heavy is coming"
   * and the element it applies is read from the debuff it leaves (Blighted / Scorched / Chilled,
   * each with its own icon). One colour per genome made the burst look like a different creature's
   * attack and drowned out the one thing the marker is for.
   */
  private landNova(game: Game, spec: BossMechanicSpec): void {
    const flavour = this.statusFlavour();
    const r = this.mechRadius;
    game.effects.ring(this.mechFrom, this.up, r * 0.3, BOSS_RED, 0.6, 3.4, 1);
    game.effects.dome(this.mechFrom, this.up, r, BOSS_RED_DEEP, 0.75);
    game.effects.burst(this.mechFrom, BOSS_RED_HOT, { count: 30, speed: 14, life: 0.7, size: 0.85, gravity: -1.5 });
    game.effects.shake(0.3);
    game.audio.sfx('skill', 0.75);
    if (game.isHost) {
      for (const p of game.players.values()) {
        if (!p.alive || p.position.distanceTo(this.mechFrom) > r + 1) continue;
        const status: HitStatus = flavour === 'poison'
          ? {
              dot: { kind: 'toxin', dps: this.damage(0.22), dur: 5, label: 'Blighted' },
              buff: { key: 'spdMul', mul: 0.85, dur: 3, label: 'Blighted' },
            }
          : flavour === 'burn'
            ? { dot: { kind: 'burn', dps: this.damage(0.2), dur: 4, label: 'Scorched' } }
            // control: chilled to a crawl, so the next heavy is much harder to walk out of
            : { buff: { key: 'spdMul', mul: 0.55, dur: 3.4, label: 'Chilled' } };
        game.hitPlayer(p, this.damage(spec.mul), null, 'enemy', status);
      }
    }
    game.broadcastEnemyEvent(this.id, 'bossimpact', this.mechFrom, this.up, r);
  }

  /** Long charge: the boss physically throws itself down the telegraphed lane. */
  private landDash(game: Game, spec: BossMechanicSpec): void {
    game.effects.burst(this.mechFrom, BOSS_RED_HOT, { count: 26, speed: 16, life: 0.6, size: 0.9, gravity: 10 });
    game.effects.shake(0.3);
    game.audio.sfx('explode', 0.7);
    this.velocity.copy(this.mechDir).multiplyScalar(38);
    this.chargeT = 0.75;
    if (game.isHost) {
      for (const p of game.players.values()) {
        if (!p.alive) continue;
        if (this.laneDistance(p.position, this.mechFrom, this.mechDir, this.mechLen) > this.mechWidth + 1) continue;
        game.hitPlayer(p, this.damage(spec.mul), null, 'enemy', {
          buff: { key: 'spdMul', mul: 0.7, dur: 1.6, label: 'Rammed' },
        });
      }
    }
    game.broadcastEnemyEvent(this.id, 'bossimpact', this.mechFrom, this.up, this.mechLen, 0, this.mechDir);
  }

  /**
   * Aimed impact: a heavy hit, a knock-up, and a burning crater that keeps the ground dangerous
   * afterwards — so "dodge the marker" is not the same as "walk straight back in".
   */
  private landImpact(game: Game, spec: BossMechanicSpec, at: THREE.Vector3): void {
    const r = this.mechRadius;
    game.effects.ring(at, this.up, r * 0.3, BOSS_RED, 0.55, 3.6, 1);
    game.effects.disk(at, this.up, r, BOSS_RED_DEEP, 0.5, 1.15, 0.4);
    game.effects.burst(at, BOSS_RED_HOT, { count: 30, speed: 17, life: 0.65, size: 0.9, gravity: 13 });
    game.effects.shake(0.36);
    game.audio.sfx('explode', 0.8);
    if (game.isHost) {
      for (const p of game.players.values()) {
        if (!p.alive || p.position.distanceTo(at) > r + 1) continue;
        game.hitPlayer(p, this.damage(spec.mul), null, 'enemy');
      }
      game.pushPlayersFrom(at, r, 17, 1.8);
      const pool = at.clone();
      const up = this.up.clone();
      for (let i = 1; i <= 3; i++) {
        game.scheduleHost(i * 0.7, () => {
          if (!this.alive) return;
          game.effects.disk(pool, up, r, BOSS_RED_DEEP, 0.5, 1.1, 0.22);
          for (const p of game.players.values()) {
            if (!p.alive || p.position.distanceTo(pool) > r) continue;
            game.hitPlayer(p, this.damage(0.28), null, 'enemy', {
              dot: { kind: 'burn', dps: this.damage(0.1), dur: 2, label: 'Crater Fire' },
            });
          }
        });
      }
    }
    game.broadcastEnemyEvent(this.id, 'bossimpact', at, this.up, r);
  }

  /**
   * ENRAGED heavy: three eruptions marching outward at the player, each with its own marker and its
   * own landing, so the danger travels across the ground. A pattern the normal kit does not have.
   */
  private castRageChain(game: Game, spec: BossMechanicSpec): void {
    const target = this.bTarget && this.bTarget.alive ? this.bTarget : null;
    const r = Math.max(7.5, 5 + this.radius * 2.2);
    _bv.copy(target ? target.position : this.position).sub(this.position);
    _bv.addScaledVector(this.up, -_bv.dot(this.up));
    if (_bv.lengthSq() < 1e-4) _bv.copy(this.facing);
    _bv.normalize();
    const step = Math.max(6, Math.min(9, r * 0.8));
    for (let i = 1; i <= 3; i++) {
      const lead = spec.lead + (i - 1) * 0.32;
      _bw.copy(this.position).addScaledVector(_bv, step * i);
      const at = _bw.clone();
      game.enemyTelegraph('disc', at, this.up, _zeroDir, r, 0, lead);
      game.broadcastBossTelegraph(this.id, 'disc', at, this.up, null, r, 0, lead, 0xff2d2d);
      game.scheduleHost(lead, () => {
        if (!this.alive) return;
        game.effects.ring(at, this.up, r * 0.3, BOSS_RED, 0.5, 2.8, 1);
        game.effects.disk(at, this.up, r, BOSS_RED_DEEP, 0.45, 1.15, 0.38);
        game.effects.burst(at, BOSS_RED_HOT, { count: 24, speed: 16, life: 0.6, size: 0.85, gravity: 13 });
        game.effects.shake(0.26);
        game.audio.sfx('explode', 0.7);
        for (const p of game.players.values()) {
          if (!p.alive || p.position.distanceTo(at) > r + 1) continue;
          game.hitPlayer(p, this.damage(spec.mul), null, 'enemy', {
            dot: { kind: 'burn', dps: this.damage(0.16), dur: 2.6, label: 'Rupture' },
          });
        }
        game.broadcastEnemyEvent(this.id, 'bossimpact', at, this.up, r);
      });
    }
    game.effects.shake(0.2);
    game.audio.sfx('alarm', 0.8);
  }

  /** ENRAGED heavy: it marks the ground the player is standing on and leaps on to it. */
  private castRageLeap(game: Game, target: Player, spec: BossMechanicSpec): void {
    const r = Math.max(9, 6 + this.radius * 2.6);
    this.mechAt.copy(target.position);
    const at = this.mechAt.clone();
    game.enemyTelegraph('disc', at, this.up, _zeroDir, r, 0, spec.lead);
    game.broadcastBossTelegraph(this.id, 'disc', at, this.up, null, r, 0, spec.lead, 0xff2d2d);
    game.audio.sfx('alarm', 0.8);
    game.scheduleHost(spec.lead, () => {
      if (!this.alive) return;
      // launch the body at the mark, so it visibly arrives instead of teleporting
      _bv.copy(at).sub(this.position);
      const dist = _bv.length();
      if (dist > 0.5) {
        _bv.normalize();
        this.velocity.copy(_bv).multiplyScalar(Math.min(34, dist / 0.55)).addScaledVector(this.up, 9);
        this.airH = 0.05;
        this.chargeT = 0.55;
      }
      game.effects.ring(at, this.up, r * 0.28, BOSS_RED, 0.55, 3.2, 1);
      game.effects.disk(at, this.up, r, BOSS_RED_DEEP, 0.5, 1.15, 0.4);
      game.effects.burst(at, BOSS_RED_HOT, { count: 30, speed: 17, life: 0.65, size: 0.9, gravity: 12 });
      game.effects.shake(0.4);
      game.audio.sfx('explode', 0.85);
      for (const p of game.players.values()) {
        if (!p.alive || p.position.distanceTo(at) > r + 1) continue;
        game.hitPlayer(p, this.damage(spec.mul), null, 'enemy');
      }
      game.pushPlayersFrom(at, r, 15, 1.9);
      game.broadcastEnemyEvent(this.id, 'bossimpact', at, this.up, r);
    });
  }

  /** The element a boss's status burst carries, read off its own generated kit. */
  private statusFlavour(): 'poison' | 'burn' | 'slow' {
    const g = this.genome;
    const has = (id: AbilityId): boolean => g.abilities.indexOf(id) >= 0;
    if (has('venomCloud')) return 'poison';
    if (has('shield') || has('thorn')) return 'slow';
    if (has('detonate')) return 'burn';
    switch (g.species) {
      case 'slime':
      case 'spider':
        return 'poison';
      case 'worm':
      case 'crawler':
      case 'hunter':
        return 'burn';
      default:
        return 'slow';
    }
  }

  /** Colour of that burst, so the element is visible in the marker itself. */
  private statusColour(): number {
    switch (this.statusFlavour()) {
      case 'poison': return 0x9dff6b;
      case 'burn': return 0xff7a2d;
      default: return 0x8fe6ff;
    }
  }

  /** Surface distance from a point to a lane that starts at `from` and runs `len` along `dir`. */
  private laneDistance(p: THREE.Vector3, from: THREE.Vector3, dir: THREE.Vector3, len: number): number {
    _bw.copy(p).sub(from);
    _bw.addScaledVector(this.up, -_bw.dot(this.up));
    const along = _bw.dot(dir);
    if (along <= 0) return _bw.length();
    if (along >= len) return _bw.copy(from).addScaledVector(dir, len).sub(p).length();
    // perpendicular distance: keep the along-track component out of the comparison
    return Math.sqrt(Math.max(0, _bw.lengthSq() - along * along));
  }

  /**
   * The red enrage tell, emitted from `place()` so every peer sees it — the host simulated it, but
   * a client must be able to tell an enraged boss from a normal one without reading the HUD.
   * Pooled particles, throttled, and skipped entirely at range.
   */
  private emitRageTells(dt: number): void {
    const transition = this.bossState === 'enrage_transition';
    if (!this.enraged && !transition) return;
    const g = this.fxGame;
    if (!g) return;
    const local = g.localPlayer;
    if (local && this.position.distanceToSquared(local.position) > CONFIG.boss.rageRange * CONFIG.boss.rageRange) return;
    this.rageT -= dt;
    if (this.rageT > 0) return;
    this.rageT = transition ? 0.045 : CONFIG.boss.rageParticleT;
    const r = Math.max(1, this.radius);
    // Flames off the WHOLE upper body. A single emitter at the crown is swallowed by the creature's
    // own mesh — that is exactly why the first version of this tell was barely visible.
    g.effects.flameBody(this.position, this.up, r * 1.8, 0xff2d2d, {
      count: transition ? 16 : CONFIG.boss.rageParticles,
      speed: transition ? 13 : 7.5,
      life: transition ? 0.6 : 0.95,
      size: transition ? 1.15 : 0.95,
      lift: -3.8,
      hot: 0.32,
    });
    // plus a hard puff at the core, so the body reads as burning rather than merely dusty
    g.effects.burst(this.position, 0xff4a2a, {
      count: transition ? 9 : Math.max(4, Math.round(CONFIG.boss.rageParticles * 0.7)),
      speed: transition ? 14 : 8.5,
      life: transition ? 0.5 : 0.8,
      size: transition ? 1.05 : 0.9,
      gravity: -2.6,
      up: this.up,
      spread: 0.9,
    });
  }

  /** One-off event mirrored to the peers; the host already played its own copy of the FX. */
  private netEvent(game: Game, kind: string): void {
    if (!game.isHost) return;
    game.broadcastEnemyEvent(this.id, kind, this.position, this.up, this.radius);
  }

  /**
   * Moves the body along the surface and clamps it onto the terrain.
   *
   * The body is ALWAYS placed on the terrain directly under its own direction, so walking up a
   * hill can never leave it floating at the elevation it started at — the old code only snapped
   * when the enemy was moving downhill, which made climbing enemies hang in the air over every
   * rise. Leap height (`airH`) rides on top as a separate term. The snap targets the RENDERED
   * surface (see `meshHeightAtDir`) so the feet meet the ground the player can actually see.
   */
  private rideTerrain(game: Game, dt: number): void {
    _v.copy(this.position).normalize();
    const radial = this.velocity.dot(_v);
    // AIRBORNE means a real launch (a leap or a knock-up is 12-17 m/s of outward speed) or a jump
    // already in the air. A walking body is never lifted: its velocity always carries a little
    // outward component as the surface curves away, and treating THAT as a take-off made climbers
    // hover up every slope instead of following the contour — and pumped gravity through the
    // velocity every frame, which read as the body glitching on the terrain.
    if (this.airH > 0 || radial > 3) {
      this.airH = Math.min(9, this.airH + radial * dt);
      this.velocity.addScaledVector(_v, -ENEMY_GRAVITY * dt);
      if (this.airH <= 0) {
        this.airH = 0;
        const r = this.velocity.dot(_v);
        if (r < 0) this.velocity.addScaledVector(_v, -r);
      }
    } else {
      // grounded: keep the WHOLE velocity tangent, in both directions, so walking can never pump the
      // body off the surface
      this.velocity.addScaledVector(_v, -radial);
    }
    this.position.addScaledVector(this.velocity, dt);
    _v.copy(this.position).normalize();
    this.up.copy(_v);
    // Stand on the surface the player can SEE. The drawn terrain mesh interpolates between its
    // ~2-4 m vertices, and on steep ground it sits up to ~0.9 m above (and 1.8 m below) the
    // analytic field the simulation runs on: a body snapped to the field wades knee-deep through
    // hillsides and pops in and out of the ground while crossing a slope, which is exactly what
    // "enemies get stuck at slopes / do not travel over the terrain" looks like. The cached
    // triangle makes the common case a single intersection test; the analytic height is only
    // evaluated by the lookup itself if the direction somehow misses every triangle.
    const surf = game.planet.meshHeightAtDir(_v.x, _v.y, _v.z, undefined, this.meshHint);
    this.meshHint = game.planet.meshTriHint;
    this.position.copy(_v).multiplyScalar(surf + this.airH);
  }

  // ------------------------------------------------------------ attacks

  private melee(game: Game, target: Player): void {
    if (target.isInvulnerable()) return;
    const g = this.genome;
    const status: HitStatus | undefined = this.has('venomCloud')
      ? { dot: { kind: 'toxin', dps: this.damage(0.22), dur: 4.6, label: 'Venom Toxin' } }
      : undefined;
    game.hitPlayer(target, this.damage(), null, 'enemy', status);
    game.effects.burst(_v.copy(target.position).addScaledVector(target.up, 1), g.accent, { count: 6, speed: 6, life: 0.3, size: 0.5, gravity: 6 });
    if (this.has('venomCloud')) this.spawnCloud(game);
    if (this.has('siphon')) this.hp = Math.min(this.maxHp, this.hp + this.damage(0.25));
  }

  private spawnCloud(game: Game): void {
    const center = this.position.clone();
    game.effects.disk(center, this.up, 3.4, this.genome.color, 3.2, 1.2, 0.3);
    game.effects.burst(center, this.genome.color, { count: 16, speed: 4, life: 1, size: 0.8, gravity: -2 });
    const owner = this;
    game.scheduleHost(3.2, () => {
      if (!owner.alive) return;
      for (const p of game.players.values()) {
        if (!p.alive) continue;
        if (p.position.distanceTo(center) > 4) continue;
        game.hitPlayer(p, owner.damage(0.5), null, 'enemy', {
          dot: { kind: 'toxin', dps: owner.damage(0.26), dur: 4.6, label: 'Venom Toxin' },
          buff: { key: 'spdMul', mul: 0.85, dur: 2, label: 'Venomed' },
        });
      }
    });
  }

  private slam(game: Game, target: Player, radius: number, mult: number): void {
    game.effects.ring(this.position, this.up, 1.5, this.genome.accent, 0.5, 3, 0.9);
    game.effects.disk(this.position, this.up, radius, this.genome.color, 0.45, 1.2, 0.35);
    game.effects.burst(this.position, this.genome.accent, { count: 24, speed: 14, life: 0.6, size: 0.8, gravity: 16 });
    game.effects.shake(0.25);
    game.audio.sfx('explode', 0.6);
    for (const p of game.players.values()) {
      if (!p.alive) continue;
      if (p.position.distanceTo(this.position) > radius + 1) continue;
      // the shockwave leaves the ground burning and the legs heavy
      game.hitPlayer(p, this.damage(mult), null, 'enemy', {
        dot: { kind: 'burn', dps: this.damage(0.2), dur: 3.2, label: 'Wither Burn' },
        buff: { key: 'spdMul', mul: 0.7, dur: 1.6, label: 'Shocked' },
      });
    }
  }

  private rangedAttack(game: Game, target: Player): void {
    const g = this.genome;
    const kind = g.projKind === 'none' ? 'spit' : g.projKind;
    // ---- ATTACK PATTERN (plan §19): the pattern is EXECUTED, not labelled. Same ability,
    // completely different geometry — a FAN is a cone, a RING is a true ring of shots
    // around the aim, a SPIRAL advances that ring every burst, a CROSS fires four axial
    // shots, a BURST is a tight cluster.
    const pattern = g.projPattern ?? 'STRAIGHT';
    let shots = 1;
    let tilt = 0;
    let ringPattern = false;
    let spiral = false;
    switch (pattern) {
      case 'FAN': shots = 3; tilt = 0.17; break;
      case 'BURST': shots = 4; tilt = 0.06; ringPattern = true; break;
      case 'CROSS': shots = 4; tilt = 0.14; ringPattern = true; break;
      case 'RING': shots = 5; tilt = 0.16; ringPattern = true; break;
      case 'SPIRAL': shots = 3; tilt = 0.16; ringPattern = true; spiral = true; break;
      default: shots = 1; break;
    }
    if (kind === 'web' && shots > 1) shots = Math.min(2, shots);
    const dmgMul = shots > 1 ? 0.7 : 1;
    game.audio.sfx(this.isBoss ? 'bossRoar' : 'shoot', this.isBoss ? 0.35 : 0.3);
    for (let i = 0; i < shots; i++) {
      _v.copy(target.position).addScaledVector(target.up, 0.9)
        .sub(_v2.copy(this.position).addScaledVector(this.up, g.scale * 0.8))
        .normalize();
      if (shots > 1) {
        if (ringPattern) {
          // build a basis around the aim, then pick this shot's direction on the ring
          tangentBasis(_v, _sw2, _sw3);
          const phi = (i / shots) * Math.PI * 2 + (spiral ? game.clock * 1.6 : 0);
          _v.addScaledVector(_sw2, Math.cos(phi) * tilt).addScaledVector(_sw3, Math.sin(phi) * tilt).normalize();
        } else {
          // a fan in the plane the old volley used (rotation about the body's up)
          _v.applyAxisAngle(this.up, (i - (shots - 1) / 2) * tilt);
        }
      }
      game.combat.spawn({
        pos: _v3.copy(this.position).addScaledVector(this.up, g.scale * 0.8).addScaledVector(_v, this.radius + 0.4),
        dir: _v,
        speed: g.projSpeed,
        damage: kind === 'web' ? g.damage * this.damageMul * 0.6 : g.damage * this.damageMul * dmgMul,
        ownerId: null,
        colony: -1,
        color: kind === 'web' ? 0xbfe9ff : g.projColor,
        hostile: 'players',
        radius: kind === 'volley' ? 0.45 : 0.5,
        life: 2.6,
        isSkill: false,
        size: kind === 'volley' ? 1.1 : 1.25,
        web: kind === 'web',
      });
    }
  }

  // ------------------------------------------------------------ client mirror

  netUpdate(dt: number): void {
    if (!this.netTarget) return;
    const dist = this.position.distanceTo(this.netTarget);
    if (dist > 40) {
      this.position.copy(this.netTarget);
    } else {
      _v.copy(this.netTarget).sub(this.position);
      this.velocity.copy(_v).multiplyScalar(8);
      this.position.addScaledVector(_v, clamp(dt * 10, 0, 1));
    }
    _v2.copy(this.position).normalize();
    this.up.copy(_v2);
    this.animPhase += dt * (2 + this.velocity.length() * 0.6);
    this.faceMotion();
  }

  /**
   * The eased surface normal the RIG leans to.
   *
   * The body used to be oriented to the planet's radial, so on a 45° hillside it stood upright
   * while the ground did not: uphill feet buried half a metre, downhill legs hanging over the drop,
   * and the burial flicked in and out as it crossed bumps — the "stuck and flickering on uneven
   * terrain" report. Sampling wide (SKIN_SPAN) reads the slope the eye sees, and the ease keeps a
   * single crag from snapping the whole rig around. Recomputed only while the body is drawn.
   */
  private updateSkinUp(dt: number, game: Game): void {
    const snap = this.skinUp.lengthSq() < 1e-6;
    // The lean costs terrain samples: up close it re-samples every frame, mid-field every third,
    // far out every sixth. The ease covers the gaps — at that distance a frame of staleness is
    // invisible, and a 150-body crowd should not pay three samples each for it.
    if (!snap) {
      this.skinT -= dt;
      if (this.skinT > 0) return;
      const d2 = game.nearestPlayerDistanceSq(this.position);
      this.skinT = d2 < 45 * 45 ? 0 : d2 < 90 * 90 ? 0.033 : 0.083;
    }
    _skinN.copy(this.position).normalize();
    tangentBasis(_skinN, _skinT1, _skinT2);
    const eps = SKIN_SPAN / game.planet.radius;
    // The lean follows the ANALYTIC field (a wide, smoothed read of the slope the eye sees), not the
    // rendered triangle — leaning to the mesh's flat facets snapped the rig on every edge crossing.
    const h0 = game.planet.heightAtDir(_skinN.x, _skinN.y, _skinN.z);
    _skinP.copy(_skinN).addScaledVector(_skinT1, eps).normalize();
    const h1 = game.planet.heightAtDir(_skinP.x, _skinP.y, _skinP.z);
    _skinP.copy(_skinN).addScaledVector(_skinT2, eps).normalize();
    const h2 = game.planet.heightAtDir(_skinP.x, _skinP.y, _skinP.z);
    const step = eps * game.planet.radius;
    _skinP.copy(_skinN)
      .addScaledVector(_skinT1, -(h1 - h0) / step)
      .addScaledVector(_skinT2, -(h2 - h0) / step)
      .normalize();
    // A freshly spawned body starts at zero, so its first drawn frame SNAPS to the normal instead
    // of easing up from a stale life of the pooled rig.
    if (this.skinUp.lengthSq() < 1e-6) {
      this.skinUp.copy(_skinP);
      return;
    }
    // Asymmetric ease: a big change (a charge across a ridge line) is caught within a few frames,
    // while micro-wobble is smoothed hard — a flat rate either lagged metres behind a fast body or
    // let the rig twitch on every crag-sized bump.
    const dot = clamp(this.skinUp.dot(_skinP), -1, 1);
    const swift = 1 + (1 - dot) * 3;
    this.skinUp.lerp(_skinP, clamp(dt * SKIN_EASE * swift, 0, 1)).normalize();
  }

  private faceMotion(): void {
    _v3.copy(this.velocity).addScaledVector(this.up, -this.velocity.dot(this.up));
    if (_v3.lengthSq() > 0.35) {
      this.facing.lerp(_v3.normalize(), 0.18);
      this.facing.addScaledVector(this.up, -this.facing.dot(this.up));
      if (this.facing.lengthSq() > 1e-5) this.facing.normalize();
    }
  }

  // ------------------------------------------------------------ presentation

  place(dt: number, game: Game): void {
    const rig = this.rig;
    if (!rig) return;
    // Nothing off-screen is animated. The far crowd is already hidden by the distance cull, so
    // running its walk cycle and shader-uniform writes was pure cost: at 150 creatures that was the
    // largest per-frame CPU item in a big match.
    if (!this.group.visible) {
      this.flashAmt = 0;
      return;
    }
    this.faceMotion();
    // The body leans with the SURFACE it walks on, not the planet's radial (see `updateSkinUp`).
    this.updateSkinUp(dt, game);
    _skinP.copy(this.facing).addScaledVector(this.skinUp, -this.facing.dot(this.skinUp));
    if (_skinP.lengthSq() < 1e-5) _skinP.copy(this.facing);
    orientToSurface(this.group, this.position, this.skinUp, _skinP);
    // draw the body just clear of the linearly-interpolated terrain mesh (see SKIN_LIFT)
    this.group.position.addScaledVector(this.skinUp, SKIN_LIFT);

    const speed = this.velocity.length();
    const moving = clamp(speed / 7, 0, 1);
    // The gait solver owns the whole walk cycle (plan §20/§21): the locomotion class picks the
    // style, the behaviour profile still scales it, and secondary motion (breathing, sac pulse,
    // tail sway, head bearing) rides on top. Zero per-species animation data.
    animateEnemyRig(rig, this.genome, this.animPhase, moving, dt);

    const targetAggro = this.targetId ? 1 : 0;
    this.aggro += (targetAggro - this.aggro) * 0.08;
    // ENRAGED: the body itself runs RED-HOT. Particles can be thinned by the budget, hidden behind
    // the body or off-screen entirely, so the boss's own emissive glow carries the state too — and
    // because this is driven from `place()`, every peer sees it without a network message.
    //
    // STUNNED outranks it. A stunned boss is a window the player has to ACT on, so the body turns
    // the same YELLOW as its plate for exactly as long as it cannot fight back — that is
    // the whole point of the state, and it must beat the enraged red on a boss that is both.
    if (this.isBoss && this.rigBaseGlow && this.rigBaseAccent) {
      const broken = this.stunnedT > 0;
      const k = broken ? 0.9 : this.enraged ? 0.85 : this.bossState === 'enrage_transition' ? 0.6 : 0;
      const wash = broken ? _stunCol : _rageCol;
      const glow = rig.energy.uniforms.uGlow.value as THREE.Color;
      const accent = rig.carapace.uniforms.uAccent.value as THREE.Color;
      if (k > 0) {
        glow.copy(this.rigBaseGlow).lerp(wash, k);
        accent.copy(this.rigBaseAccent).lerp(wash, k * 0.75);
      } else if (glow.r !== this.rigBaseGlow.r || glow.g !== this.rigBaseGlow.g || glow.b !== this.rigBaseGlow.b) {
        glow.copy(this.rigBaseGlow);
        accent.copy(this.rigBaseAccent);
      }
    }
    // A stunned boss droops the whole body: the punish window has to be legible in the world,
    // not only on the health plate. Enraged bosses burn hotter than anything else on the field.
    const stunSag = this.stunnedT > 0 ? 1 : 0;
    rig.carapace.uniforms.uAggro.value = this.aggro + (this.guardT > 0 ? 1.2 : 0) + stunSag * 0.6 + (this.enraged ? 1.6 : 0);
    this.corePulse += 0.06;
    if (rig.core) {
      const pulse = 1 + Math.sin(this.corePulse) * 0.12 + this.aggro * 0.25 + (this.enraged ? 0.25 : 0);
      rig.core.scale.setScalar(rig.coreBase * pulse);
    }

    // white hit flash across the whole model, decays fast
    if (this.flashAmt > 0) {
      this.flashAmt = Math.max(0, this.flashAmt - 0.14);
      const f = this.flashAmt * 0.92;
      for (const m of rig.flashMats) m.uniforms.uFlash.value = f;
    } else if (rig.flashMats[0].uniforms.uFlash.value !== 0) {
      for (const m of rig.flashMats) m.uniforms.uFlash.value = 0;
    }

    this.updateStatusFx(dt);
    this.emitRageTells(dt);
  }

  /**
   * Burning / poisoned / frozen state: a body tint applied by the creature's own shaders, plus a
   * matching particle tell. Both are scaled off `this.radius`, so a Colossus wreathed in flame is
   * unmistakable from across the field while a swarm Necrophage only coughs out a wisp or two.
   */
  private updateStatusFx(dt: number): void {
    // The cryo tell is a LOCAL countdown, decayed here rather than in update(): update() is host-only,
    // and this runs from place() on every peer, so a client sees the ice thaw at the same rate
    // without any extra field in the snapshot.
    if (this.frostT > 0) this.frostT = Math.max(0, this.frostT - dt);
    const toxin = this.fxToxin;
    if (!toxin) return;

    let burnDps = 0;
    let toxinDps = 0;
    for (const d of this.dots) {
      if (d.kind === 'burn') burnDps += d.dps;
      else if (d.kind === 'poison') toxinDps += d.dps;
    }
    const frozen = this.rootT > 0;
    // ICE comes from the CRYO tag, not from the slow: a body is frosted only when something cryo
    // touched it, and reads as encased while it is also held in place.
    const iced = this.frostT > 0;
    const chilled = iced && !frozen;
    const radius = this.radius;

    // ICE. The strength ramps (no single-frame pop) and is pushed into the creature's OWN two
    // materials, so the frost coats every surface of the body and pulses (see uFreeze) — with no
    // shell, no extra draw call, and nothing for the player to mistake for a shield.
    const iceTarget = iced ? (frozen ? 1 : 0.52) : 0;
    this.iceAmt += (iceTarget - this.iceAmt) * Math.min(1, dt * 7);
    if (Math.abs(iceTarget - this.iceAmt) < 0.002) this.iceAmt = iceTarget;
    const rig = this.rig;
    if (rig) {
      rig.carapace.uniforms.uFreeze.value = this.iceAmt;
      rig.energy.uniforms.uFreeze.value = this.iceAmt;
    }

    toxin.visible = toxinDps > 0;
    if (toxin.visible) {
      const r = radius * 1.08;
      toxin.scale.set(r, r * (1 + Math.sin(this.fxPhase * 3) * 0.07), r);
      toxin.position.y = radius * 0.55;
      (toxin.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.12 * Math.sin(this.fxPhase * 4.4);
    }

    this.emitStatusTells(dt, burnDps, toxinDps, frozen, chilled);
  }

  /**
   * The particle half of the debuff read: flames licking upward, venom dripping down, and frost
   * drifting off an iced body. Count and size scale with the creature; a heavy body emits less
   * often so the cost per frame stays flat no matter how big the Necrophage is.
   */
  private emitStatusTells(dt: number, burnDps: number, toxinDps: number, frozen: boolean, chilled: boolean): void {
    const g = this.fxGame;
    const any = burnDps > 0 || toxinDps > 0 || frozen || chilled;
    if (!g || !any) {
      this.tellT = 0;
      return;
    }
    this.tellT -= dt;
    if (this.tellT > 0) return;
    const local = g.localPlayer;
    if (local && this.position.distanceToSquared(local.position) > 78 * 78) return;

    const radius = this.radius;
    const heavy = radius >= 1.5;
    this.tellT = heavy ? 0.08 : 0.11;
    const up = this.up;
    const notes = 1 + Math.round(radius * 1.5);

    if (burnDps > 0) {
      // FIRE: flames off the whole upper body, buoyant enough to climb clear of the silhouette.
      // Bigger creatures burn bigger and a heavily stacked burn burns harder, so a Colossus going
      // up is unmistakable from across the field.
      const heat = clamp(0.75 + burnDps * 0.02, 0.75, 1.8);
      g.effects.flameBody(this.position, up, radius, 0xff7a2d, {
        count: Math.round((2 + radius * 3.2) * heat),
        speed: (1.9 + radius * 0.8) * (0.75 + heat * 0.3),
        life: 0.5 + radius * 0.22,
        size: 0.19 + radius * 0.17,
      });
    }
    if (toxinDps > 0) {
      this.tellPos.copy(this.position).addScaledVector(up, radius * 0.55);
      this.tellDir.copy(up).negate();
      g.effects.burst(this.tellPos, 0x9dff6b, {
        count: notes, speed: 0.5 + radius * 0.2, life: 0.55,
        size: 0.13 + radius * 0.1, dir: this.tellDir, jitter: 0.55, gravity: 5.2, drag: 0.5,
      });
    }
    if (frozen || chilled) {
      this.tellPos.copy(this.position).addScaledVector(up, radius * 0.85);
      const n = frozen ? 1 + Math.round(radius * 0.9) : (heavy ? 1 : Math.random() < 0.55 ? 1 : 0);
      if (n > 0) {
        g.effects.burst(this.tellPos, 0xcdf2ff, {
          count: n, speed: 0.5, life: frozen ? 0.7 : 0.45,
          size: 0.12 + radius * 0.09, up, spread: 0.9, gravity: 1.4, drag: 1.4,
        });
      }
    }
  }

  /**
   * The PYRE / VENOM passives, resolved from the status's owner: burning enemies set their
   * neighbours alight (Immolate) and poisoned enemies smear venom that slows and poisons anyone
   * walking through it (Contagion). Host only — it applies damage.
   */
  private spreadStatuses(game: Game, dt: number): void {
    this.spreadT -= dt;
    if (this.spreadT > 0) return;
    this.spreadT = 0.85;

    let burn: Dot | null = null;
    let toxin: Dot | null = null;
    for (const d of this.dots) {
      if (d.kind === 'burn') burn = burn ?? d;
      else if (d.kind === 'poison') toxin = toxin ?? d;
    }
    const ownerId = (burn ?? toxin)?.ownerId ?? null;
    const stats = ownerId ? game.players.get(ownerId)?.necrotech.stats : undefined;
    const burnR = stats?.spreadBurn ?? 0;
    const venomR = stats?.spreadVenom ?? 0;
    if (burnR <= 0 && venomR <= 0) return;

    const reach = Math.max(burnR, venomR);
    const list = game.enemies.query(this.position.x, this.position.y, this.position.z, reach + 3, this.spreadScratch);

    if (burn && burnR > 0) {
      let spread = false;
      for (const other of list) {
        if (other === this || !other.alive) continue;
        const rr = burnR + other.radius;
        if (other.position.distanceToSquared(this.position) > rr * rr) continue;
        other.applyStatus('burn', Math.max(1.2, burn.dps * 0.3), burn.ownerId);
        spread = true;
      }
      if (spread && Math.random() < 0.6) {
        game.effects.burst(this.position, 0xff7a2d, { count: 3, speed: 2.6, life: 0.42, size: 0.5, gravity: -6 });
      }
    }

    if (toxin && venomR > 0) {
      // a venom smear on the ground behind the creature
      game.effects.disk(this.position, this.up, venomR, 0x9dff6b, 1.0, 1.12, 0.13);
      for (const other of list) {
        if (other === this || !other.alive) continue;
        const rr = venomR + other.radius;
        if (other.position.distanceToSquared(this.position) > rr * rr) continue;
        other.applyStatus('poison', Math.max(1, toxin.dps * 0.25), toxin.ownerId);
        other.applyStatus('slow', 0.18, toxin.ownerId);
      }
    }
  }
}

/** Simple host-side delayed callback used by ability behaviours. */
function setTimeoutHost(fn: () => void, ms: number): void {
  window.setTimeout(fn, ms);
}

// ============================================================================

export class EnemyManager {
  enemies: Enemy[] = [];
  spatial = new SpatialHash<Enemy>(11);
  bestiary: Bestiary = generateBestiary(1);
  private byIdMap = new Map<number, Enemy>();
  private pools = new Map<number, Enemy[]>();
  private tmp: Enemy[] = [];
  private tmpSpread: Enemy[] = [];
  private cand: Enemy[] = [];
  /** Reused spawn-anchor list + result position (see `spawnPosNearPlayer`). */
  private spawnAnchors: Player[] = [];
  private spawnPos = new THREE.Vector3();
  private frame = 0;
  /** Squared distance beyond which a plain Necrophage is not rendered at all. */
  private visibleRangeSq = 130 * 130;
  private nextId = 1;
  private spawnT = 0;
  private packT = 30;
  private apexT = 90;
  /** Seconds until the next Hunter Necrophage is allowed on to the field. */
  private hunterT = 55;

  constructor(private game: Game, private quality: QualitySettings) {}

  scratch(): Enemy[] {
    return this.tmp;
  }

  /**
   * Hard ceiling on live Necrophages. The spawner, packs, apexes and replication (split/brood)
   * all funnel through here, so the crowd can never grow past what the renderer can draw.
   */
  get populationCap(): number {
    return Math.min(this.quality.maxEnemies, this.game.enemyBudget || this.quality.maxEnemies);
  }

  get hasRoom(): boolean {
    return this.enemies.length < this.populationCap;
  }

  /** Drops the Necrophages furthest from any player until the crowd is back inside the budget. */
  cullTo(limit: number): number {
    if (this.enemies.length <= limit) return 0;
    const scored = this.enemies.map(e => ({ e, d: this.game.nearestPlayerDistanceSq(e.position) }));
    scored.sort((a, b) => b.d - a.d);
    let removed = 0;
    for (const s of scored) {
      if (this.enemies.length <= limit) break;
      const e = s.e;
      if (!e.alive) continue;
      if (e.isBoss || e.isNamed) continue;   // never cull named creatures
      if (s.d < 60 * 60) continue;           // keep whatever the player can actually see
      this.removeVisual(e.id);
      removed++;
    }
    return removed;
  }

  /**
   * Called at match start: builds the match's own bestiary from the seed. The PROCEDURAL
   * ECOLOGY (plan §26) is the one true generator; `facts` carries the ranked planet's
   * descriptor (ring, biome, ecology kind, landmark biases) when the caller has it, and is
   * derived from the seed itself otherwise — all peers compute identical rosters either way.
   */
  generate(seed: number): Bestiary {
    this.bestiary = generateEcologyBestiary(seed, factsFromSeed(seed));
    return this.bestiary;
  }

  /** Ranked / planet-aware generation (plan §29/§32): the ring and biome shape the roster. */
  generateEcology(seed: number, facts?: PlanetFacts): Bestiary {
    this.bestiary = generateEcologyBestiary(seed, facts ?? factsFromSeed(seed));
    return this.bestiary;
  }

  reset(): void {
    for (const e of this.enemies) this.release(e);
    this.enemies.length = 0;
    this.byIdMap.clear();
    this.nextId = 1;
    this.spawnT = 0;
    this.packT = 30;
    this.apexT = 90;
    this.hunterT = 55;
    this.spatial.clear();
  }

  private release(e: Enemy): void {
    e.alive = false;
    e.group.visible = false;
    e.group.removeFromParent();
    let pool = this.pools.get(e.genomeIdx);
    if (!pool) {
      pool = [];
      this.pools.set(e.genomeIdx, pool);
    }
    if (pool.length < 90) pool.push(e);
  }

  byId(id: number): Enemy | null {
    const e = this.byIdMap.get(id);
    return e && e.alive ? e : null;
  }

  query(x: number, y: number, z: number, r: number, out: Enemy[]): Enemy[] {
    this.spatial.query(x, y, z, r, this.cand);
    out.length = 0;
    for (const e of this.cand) if (e.alive) out.push(e);
    return out;
  }

  spawn(genomeIdx: number, pos: THREE.Vector3, opts: { towerIdx?: number; elite?: boolean; hpMul?: number; powerMul?: number; splitGen?: number } = {}): Enemy {
    const genome = this.bestiary.genomes[genomeIdx] ?? this.bestiary.genomes[0];
    let pool = this.pools.get(genome.idx);
    if (!pool) {
      pool = [];
      this.pools.set(genome.idx, pool);
    }
    let e = pool.pop();
    if (!e) e = new Enemy();
    e.id = this.nextId++;
    e.setGenome(genome);
    e.bindGame(this.game);
    // mitosis: every split generation is smaller, softer and worth less XP
    e.splitGen = opts.splitGen ?? 0;
    const shrink = Math.pow(0.72, e.splitGen);
    e.damageMul = shrink;
    // Time-based power applies by DEFAULT, so every path (spawner, packs, apexes, replication from a
    // snapshot, mitosis children) gets the same curve — a caller can still override it for bosses.
    // HUNTERS ride the curve at its FIVE-MINUTE value from the very start: a fresh match hands them
    // the stats they would have at 5:00 (they are the apex of the bestiary — never an early free
    // kill), and past 5:00 they scale exactly like everything else.
    const curveElapsed = genome.hunter ? Math.max(HUNTER_CURVE_FLOOR, this.game.matchElapsed) : this.game.matchElapsed;
    const power = enemyPowerScale(curveElapsed);
    e.powerMul = opts.powerMul ?? power.dmg;
    const hpScale = opts.hpMul ?? power.hp;
    e.radius = genome.radius * shrink;
    e.xpValue = Math.round(genome.xp * (e.splitGen > 0 ? shrink : 1));
    this.game.scene.add(e.group);
    e.position.copy(pos);
    e.up.copy(pos).normalize();
    e.velocity.set(0, 0, 0);
    e.airH = 0;
    // Stand on the drawn surface from the very first frame (the spawn point comes from the analytic
    // field; `rideTerrain` would snap it on the next update, one frame later).
    const surf = this.game.planet.meshHeightAtDir(e.up.x, e.up.y, e.up.z);
    if (surf > 0) e.position.setLength(surf);
    e.facing.set(0, 0, 1);
    // Always re-derive health from the genome: a pooled instance can be reused with the same genome
    // (exactly what a mitosis child does), and the old code would then compound the multiplier.
    e.maxHp = genome.hp;
    e.hp = genome.hp * hpScale * shrink;
    e.maxHp = e.hp;
    e.alive = true;
    e.dots.length = 0;
    e.slowMul = 1;
    e.slowT = 0;
    e.frostT = 0;
    e.guardMul = 1;
    e.guardT = 0;
    e.targetId = null;
    e.attackCd = Math.random() * 0.8;
    e.chargeT = 0;
    e.shelterT = 0;
    e.elite = opts.elite ?? false;
    e.towerIdx = opts.towerIdx ?? -1;
    if (e.elite) {
      e.maxHp *= 2.2;
      e.hp = e.maxHp;
      e.xpValue = Math.round(genome.xp * 2.5);
      e.group.scale.setScalar(1.3 * shrink);
    } else {
      e.group.scale.setScalar(shrink);
    }
    e.group.visible = true;
    e.skinUp.set(0, 0, 0);
    e.place(1 / 60, this.game);
    // The behaviour machine needs an anchor: "its own ground" is wherever it appeared.
    e.home.copy(pos);
    this.enemies.push(e);
    this.byIdMap.set(e.id, e);
    return e;
  }

  spawnBoss(towerIdx: number, kind: 'beacon' | 'nexus', pos: THREE.Vector3): Enemy {
    const genomeIdx = kind === 'nexus' ? this.bestiary.nexusIdx : this.bestiary.bossIdx;
    const playerScale = 1 + Math.max(0, this.game.playerCount - 1) * 0.35;
    // Bosses ride the same match-time curve as the crowd (they used to keep a flat health pool while
    // their damage ramped), and the Nexus Mega Necrophage gets its own multiplier on top.
    const power = enemyPowerScale(this.game.matchElapsed);
    const megaHp = kind === 'nexus' ? CONFIG.enemy.megaHpMul : 1;
    const megaDmg = kind === 'nexus' ? CONFIG.enemy.megaDmgMul : 1;
    const e = this.spawn(genomeIdx, pos, {
      towerIdx,
      hpMul: playerScale * megaHp * power.hp * CONFIG.boss.hpMul,
      powerMul: megaDmg * power.dmg,
    });
    e.group.scale.setScalar(1);
    // Bosses get a second bar: the STUN pool, sized off their own (scaled) health.
    e.stunMax = e.maxHp * CONFIG.boss.stunPool;
    e.stun = e.stunMax;
    this.game.audio.sfx('bossRoar');
    this.game.ui.toast(`${e.genome.name} guards the ${kind === 'nexus' ? 'Nexus' : `Beacon ${towerIdx + 1}`} — ${e.genome.abilities.length} abilities`, 4200);
    return e;
  }

  /** Host-authoritative kill: FX, drops and removal are coordinated by the Game. */
  hostKill(e: Enemy, killerId: string | null): void {
    if (!e.alive) return;
    e.alive = false;
    this.byIdMap.delete(e.id);
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    // Path-of-Exile style contagion: a burning or poisoned corpse passes the status to its kin
    if (e.dots.length > 0) {
      this.query(e.position.x, e.position.y, e.position.z, 9, this.tmpSpread);
      for (const other of this.tmpSpread) {
        if (other === e || !other.alive) continue;
        for (const d of e.dots) other.applyStatus(d.kind, d.dps * 0.5, d.ownerId);
      }
    }
    this.game.onEnemyKilled(e, killerId);
    this.release(e);
  }

  removeVisual(id: number): void {
    const e = this.byIdMap.get(id);
    if (!e) return;
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    this.byIdMap.delete(id);
    this.release(e);
  }

  update(dt: number): void {
    const g = this.game;
    this.frame++;
    this.spatial.clear();
    for (const e of this.enemies) if (e.alive) this.spatial.insert(e);

    if (g.isHost && g.phase === 'playing') this.runSpawner(dt);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) continue;
      // Distance culling is shared by host and clients: beyond the visible range a plain
      // Necrophage costs nothing to draw (named creatures always stay visible).
      const d2 = this.game.nearestPlayerDistanceSq(e.position);
      e.group.visible = d2 < this.visibleRangeSq || e.isBoss || e.isNamed;
      if (g.isHost) {
        let step = 1;
        if (d2 > 140 * 140) step = 4;
        else if (d2 > 78 * 78) step = 2;
        if (step > 1 && this.frame % step !== e.id % step) continue;
        e.update(dt * step, g);
        this.keepOutOfSafeZones(g, e, dt * step);
        // Wall-campers: nothing to chase, cannot reach the sheltered player, so recycle the body
        // instead of leaving the whole crowd parked at the wall in the closest LOD band.
        if (
          e.shelterT > CONFIG.enemy.campDespawn &&
          !e.isBoss && !e.isNamed
        ) {
          this.removeVisual(e.id);
          continue;
        }
        // Range cull: far-away plain Necrophages are recycled. Named creatures (tower wardens,
        // apexes, elites) are never deleted — a warden removed this way would leave its Beacon
        // locked in the 'boss' state forever, which read as "the guardian never spawned".
        if (!e.isBoss && !e.isNamed && d2 > CONFIG.enemy.despawnRange * CONFIG.enemy.despawnRange) {
          this.removeVisual(e.id);
          continue;
        }
      } else {
        e.netUpdate(dt);
      }
      e.place(dt, g);
    }

    // Spinner whirl: while a whip player is spinning, everything inside the whirl is driven steadily
    // outward for the whole duration — a continuous shove, not a single knockback on cast. A dead or
    // menu-frozen player drives nothing: the whirl itself is gated on `whipSpinRadius`, and neither
    // a corpse nor a player reading a picker may keep shoving the horde around.
    if (g.isHost) {
      for (const pl of g.players.values()) {
        const whirl = pl.whipSpinRadius;
        if (whirl <= 0 || !pl.alive || pl.frozen) continue;
        for (const e of this.enemies) {
          if (!e.alive) continue;
          _shove.copy(e.position).sub(pl.position);
          _shove.addScaledVector(e.up, -_shove.dot(e.up));      // stay on the surface
          const d = _shove.length();
          if (d > whirl + e.radius || d < 1e-3) continue;
          _shove.multiplyScalar(1 / d);
          const radial = e.velocity.dot(_shove);
          // The wave stops AT the ring: the drive is clipped to the distance left to the boundary, so
          // a creature is carried out to the edge of the whirl and left standing there — never flung
          // past it (the wave's reach and the whirl are the same circle).
          const room = whirl - SPINNER_RIM - d;
          if (room <= 0) {
            if (radial !== 0) e.velocity.addScaledVector(_shove, -radial);   // at the rim: hold position
            continue;
          }
          // A velocity shove alone loses: the creature's own steering pulls it straight back in, so
          // the whirl moves the BODY outward each frame AND forces the radial velocity to match, which
          // means a creature cannot walk against the wave while it is inside.
          const move = Math.min(SPINNER_SHOVE * dt, room);
          const want = move / Math.max(dt, 1e-4);
          e.position.addScaledVector(_shove, move);
          g.planet.projectToSurface(e.position);
          e.up.copy(e.position).normalize();
          if (radial !== want) e.velocity.addScaledVector(_shove, want - radial);
        }
      }
    }
  }

  // ------------------------------------------------------------ spawner

  /**
   * Necrophages refuse to walk into a colony base dome or a live Beacon shield. Two things happen:
   * the body is pushed back outside the boundary (then reprojected on to the surface so it keeps its
   * footing) with any inward momentum removed, and a creature whose target is sheltering inside
   * gives that target up — so instead of grinding against the wall it turns away and hunts again.
   */
  private keepOutOfSafeZones(g: Game, e: Enemy, dt: number): void {
    // Colony domes live in a flat, preallocated list; Beacon shields are read straight off the state.
    const zones = g.bases.zones;
    let near = 0;
    for (const z of zones) {
      _zone.set(z.x, z.y, z.z);
      const d = this.pushOutOfZone(g, e, _zone, z.r);
      if (d < z.r + CAMP_BAND) near = 1;
    }
    for (const t of g.towers.towers) {
      if (!t.shieldUp) continue;
      // A tower's OWN guardian belongs to its ward: it is summoned inside it, crosses the wall on
      // its way to a fight and comes back to its post. Pushing it out every frame pinned the body
      // to the boundary — that was the "the Mega Necrophage is stuck in the shield" report.
      // (Towers.update already exempts it from the shield bounce for exactly the same reason.)
      if (e.isBoss && e.towerIdx === t.idx) continue;
      const d = this.pushOutOfZone(g, e, t.position, t.shieldR);
      if (d < t.shieldR + CAMP_BAND) near = 1;
    }
    // A creature with nobody to chase, sitting against a wall it can never get through, is what the
    // spawner used to pile up for the rest of the match. Track how long it has been there — the
    // timer DECAYS rather than resets, because a targetless creature wanders and a single step out
    // of the band must not wipe out the seconds it has already spent parked against the wall.
    if (near && !e.targetId) e.shelterT += dt;
    else if (e.shelterT > 0) e.shelterT = Math.max(0, e.shelterT - dt * 2);
    // a sheltered player is not a target: this is what makes a base read as safe. The drop is
    // INSTANT — `bTarget` is what the per-frame brain swings at, so waiting for the next think
    // tick let the chase (and a committed pounce) play on for up to ~0.3 s after the bubble closed.
    if (e.dropShelteredTarget(g)) e.velocity.multiplyScalar(0.2);
  }

  /**
   * Pushes one enemy body out of a single circular guard volume and reports how far its surface
   * position is from the centre (`Infinity` when it is clearly outside).
   */
  private pushOutOfZone(g: Game, e: Enemy, centre: THREE.Vector3, zoneR: number): number {
    const up = e.up;
    _zoneDir.copy(e.position).sub(centre);
    // solve it on the surface: drop the radial component so the push slides the creature sideways
    _zoneDir.addScaledVector(up, -_zoneDir.dot(up));
    let len = _zoneDir.length();
    const limit = zoneR + e.radius * 0.7;
    if (len >= limit + CAMP_BAND) return Infinity;
    if (len >= limit) return len;
    if (len < 1e-3) {
      // dead centre: pick any tangent so the creature always ends up moving outward
      tangentBasis(up, _zoneDir, _v2);
      len = 1;
    }
    _zoneDir.multiplyScalar(1 / len);
    e.position.addScaledVector(_zoneDir, limit - len + 0.05);
    g.planet.projectToSurface(e.position);
    e.up.copy(e.position).normalize();
    // kill the inward half of the velocity; keep the tangential half so the wall does not stop them
    const inward = e.velocity.dot(_zoneDir);
    if (inward < 0) e.velocity.addScaledVector(_zoneDir, -inward);
    return len;
  }

  private spawnPosNearPlayer(): THREE.Vector3 | null {
    // Reused list + reused result: this runs on the spawner tick for every spawn path, and the
    // caller always copies the position into the creature immediately.
    const list = this.spawnAnchors;
    list.length = 0;
    const margin = CONFIG.enemy.spawnSafeMargin;
    for (const p of this.game.players.values()) {
      if (!p.alive) continue;
      // Somebody sheltering behind a dome or a live ward is not a spawn anchor — the Necrophages
      // cannot reach them there, so spawning around them just feeds the wall.
      if (this.game.inSafeZone(p.position, margin)) continue;
      list.push(p);
    }
    if (list.length === 0) return null;
    const anchor = list[Math.floor(Math.random() * list.length)];
    randomUnitVector(_v);
    _v2.copy(_v).cross(_v3.copy(anchor.up)).normalize();
    const dir = _v3.copy(anchor.position).normalize().addScaledVector(_v2, Math.random() * 0.6 - 0.3).normalize();
    const pos = this.spawnPos;
    this.game.planet.surfacePointFromDir(dir, pos);
    if (pos.distanceTo(anchor.position) < CONFIG.enemy.spawnNearMin * 0.6) return null;
    // never hand the world a spawn INSIDE a shelter: a body materialising under a dome (or in a
    // live ward) would only be shoved straight back out, and "it spawned in my shield" is worse
    if (this.game.inSafeZone(pos, 0)) return null;
    return pos;
  }

  private pickGenome(elapsed: number): number {
    const b = this.bestiary;
    const r = Math.random();
    // early game leans on the swarm species, later the large ones dominate
    const t = clamp(elapsed / 420, 0, 1.2);
    if (r < 0.62 - t * 0.25) return b.smallIdx[Math.floor(Math.random() * b.smallIdx.length)] ?? 0;
    return b.largeIdx[Math.floor(Math.random() * b.largeIdx.length)] ?? 0;
  }

  private runSpawner(dt: number): void {
    const g = this.game;
    const elapsed = g.matchElapsed;
    if (elapsed < 3) return;
    const power = enemyPowerScale(elapsed);
    const cap = this.populationCap;
    const target = Math.min(cap, Math.floor(14 + elapsed * 0.17 + g.playerCount * 8));
    this.spawnT -= dt;
    if (this.enemies.length < target && this.spawnT <= 0) {
      this.spawnT = Math.max(0.14, 1.15 - elapsed / 260);
      for (let k = 0; k < 1 + Math.floor(elapsed / 150); k++) {
        const pos = this.spawnPosNearPlayer();
        if (pos) this.spawn(this.pickGenome(elapsed), pos, { hpMul: power.hp, powerMul: power.dmg });
        if (this.enemies.length >= target) break;
      }
    }

    this.packT -= dt;
    if (this.packT <= 0) {
      this.packT = 42;
      const pos = this.spawnPosNearPlayer();
      if (pos && this.hasRoom) {
        const count = 6 + Math.floor(elapsed / 75);
        const genomeIdx = this.bestiary.smallIdx[Math.floor(Math.random() * this.bestiary.smallIdx.length)] ?? 0;
        for (let i = 0; i < count; i++) {
          if (!this.hasRoom) break;
          _v.copy(pos).addScaledVector(_v2.copy(pos).normalize().cross(_v3.set(0, 1, 0)).normalize(), (Math.random() - 0.5) * 14);
          this.spawn(genomeIdx, _spawnV.copy(_v), { hpMul: power.hp, powerMul: power.dmg });
        }
      }
    }

    this.apexT -= dt;
    if (this.apexT <= 0) {
      this.apexT = 110;
      const pos = this.spawnPosNearPlayer();
      if (pos && this.hasRoom) {
        const elite = Math.random() < 0.16;
        const e = this.spawn(this.bestiary.apexIdx, pos, { elite, hpMul: power.hp, powerMul: power.dmg });
        g.ui.toast(`${e.genome.name.toUpperCase()} EMERGES — ${e.genome.abilities.map(a => ABILITY_META[a].name).join(', ')}`, 4200);
        g.audio.sfx('bossRoar', 0.7);
      }
    }

    // ---- the two Hunter Necrophages. They are predators, not swarm: at most TWO are ever on the
    // field at once, they arrive a while into the match, and the spawner alternates between the
    // heavy Ripper and the long-stride Pouncer so both identities actually get seen.
    this.hunterT -= dt;
    if (this.hunterT <= 0) {
      this.hunterT = 78 + Math.random() * 24;
      let alive = 0;
      for (const e of this.enemies) if (e.alive && e.genome.hunter) alive++;
      if (alive < 2 && this.hasRoom) {
        const pos = this.spawnPosNearPlayer();
        if (pos) {
          const kinds = this.bestiary.hunterIdx;
          let idx = kinds[0] ?? 0;
          for (const k of kinds) {
            let out = false;
            for (const e of this.enemies) if (e.alive && e.genomeIdx === k) out = true;
            if (!out) {
              idx = k;
              break;
            }
          }
          const h = this.spawn(idx, _spawnV.copy(pos), { hpMul: power.hp, powerMul: power.dmg });
          g.ui.banner(`${h.genome.name.toUpperCase()} HAS YOUR SCENT`, 3000);
          g.audio.sfx('bossRoar', 0.8);
        }
      }
    }
  }

  // ------------------------------------------------------------ networking

  serialize(): EnemySnapshot[] {
    const out: EnemySnapshot[] = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const flags = (e.elite ? F_ELITE : 0)
        | (e.isBoss ? F_BOSS : 0)
        | (e.enraged ? F_ENRAGED : 0)
        | (e.stunnedT > 0 ? F_STUNNED : 0)
        | (e.bossState === 'enrage_transition' ? F_ENRAGING : 0);
      out.push({
        id: e.id,
        type: e.genomeIdx,
        x: Math.round(e.position.x * 10) / 10,
        y: Math.round(e.position.y * 10) / 10,
        z: Math.round(e.position.z * 10) / 10,
        hp: Math.round(e.hp),
        flags,
        gen: e.splitGen,
        // Bosses only: the stun bar is a fraction, so it means the same thing on every peer no
        // matter how the two machines scaled that boss's health pool.
        stn: e.isBoss && e.stunMax > 0 ? Math.round((e.stun / e.stunMax) * 100) : undefined,
      });
    }
    return out;
  }

  applySnapshot(list: EnemySnapshot[]): void {
    const seen = new Set<number>();
    for (const s of list) {
      seen.add(s.id);
      let e = this.byIdMap.get(s.id);
      if (!e || !e.alive) {
        const gen = s.gen ?? 0;
        // the same time-based scale the host used, so the health bar matches the host's numbers
        const power = enemyPowerScale(this.game.matchElapsed);
        e = this.spawn(s.type, _v3.set(s.x, s.y, s.z), { splitGen: gen, hpMul: power.hp, powerMul: power.dmg });
        this.byIdMap.delete(e.id);
        e.id = s.id;
        this.byIdMap.set(s.id, e);
        e.elite = (s.flags & 1) !== 0;
        e.group.scale.setScalar((e.elite ? 1.3 : 1) * Math.pow(0.72, gen));
      }
      e.hp = s.hp;
      // Boss state rides the snapshot: a client replays the enraged / stunned / transition look
      // from these four bits, so nothing about the fight needs its own message stream.
      e.enraged = (s.flags & F_ENRAGED) !== 0;
      e.bossState = (s.flags & F_ENRAGING) !== 0 ? 'enrage_transition' : e.enraged ? 'enraged' : 'normal';
      e.stunnedT = (s.flags & F_STUNNED) !== 0 ? 0.4 : 0;
      if (s.stn !== undefined) {
        e.stunMax = 100;
        e.stun = s.stn;
      }
      if (!e.netTarget) e.netTarget = new THREE.Vector3();
      e.netTarget.set(s.x, s.y, s.z);
      if (e.isBoss && e.towerIdx < 0) {
        let bestIdx = -1;
        let bestD = Infinity;
        for (const t of this.game.towers.towers) {
          const d = t.position.distanceToSquared(e.position);
          if (d < bestD) {
            bestD = d;
            bestIdx = t.idx;
          }
        }
        e.towerIdx = bestIdx;
      }
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!seen.has(e.id)) this.removeVisual(e.id);
    }
  }

  get aliveCount(): number {
    return this.enemies.length;
  }

  /** Live bosses/named enemies, used by the 2D nameplate overlay. */
  bosses(out: Enemy[]): Enemy[] {
    out.length = 0;
    for (const e of this.enemies) if (e.alive && e.isBoss) out.push(e);
    return out;
  }

  /** Bosses, apex minibosses and elites — everything that carries a floating plate. */
  plateList(out: Enemy[]): Enemy[] {
    out.length = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.isBoss || e.elite || e.genome.tier === 'apex') out.push(e);
    }
    return out;
  }
}
