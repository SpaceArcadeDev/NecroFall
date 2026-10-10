// NECROFALL — player: spherical movement with momentum, dash i-frames, auto-attacks,
// health + delayed regeneration, Necromutation levels, Necrotech state and netcode.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { Game } from '../core/Game';
import { ADDITIVE_MODS, COLONIES, CONFIG, Mods, PALETTE, defaultMods, mergeMods } from '../core/Config';
import { createShieldMaterial } from '../towers/ShieldMaterial';
import { NECROTECHS, NecrotechDef, mutateDefs, applyMutation } from '../necrotech/NecrotechData';
import { buildHeldWeapon } from '../necrotech/WeaponModels';
import { MutationDef, resolveMutation, resolveTripleMutation } from '../necrotech/Mutations';
import type { Perk } from '../necromutation/Perks';
import type { Enemy } from '../enemies/Enemies';
import { ORBIT_AXIS } from '../world/Bases';
import { clamp, nowSec, orientToSurface, rotateTowards, tangentBasis } from '../utils/Utils';
import { AvatarAccessories, disposeObject } from '../customization/AvatarAccessories';
import { AccessorySelection, EMPTY_SELECTION } from '../customization/AccessoryTypes';
import { selectionFromWire, selectionToWire } from '../customization/CustomizationStore';
import { PlayerRig } from './PlayerRig';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
/** White, for tinting aura motes away from a flame palette. */
const _white = new THREE.Color(0xffffff);
/** Reused enemy list for the whip lash and the Madmen passive scans. */
const _whipList: Enemy[] = [];
/** Most lashes ONE whip swing may deal — its count is engaged targets + extra-projectile perks. */
const MAX_LASHES = 8;
/** Lash directions of the swing being fired (up to `MAX_LASHES`) — reused, never held. */
const _whipDirs: THREE.Vector3[] = Array.from({ length: MAX_LASHES }, () => new THREE.Vector3());
/** Reused multi-target list + its scores (see `Player.selectTargets`) — never held across calls. */
const _targets: (Enemy | Player)[] = [];
const _targetScores: number[] = [];
/** Molten Wake's speed probe — a scratch of its own so it can never alias the movement math. */
const _wake = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _blitzScratch = new THREE.Vector3();
const _tmpEnemies: Enemy[] = [];

/**
 * The ground footprint of the auto-attack reach, as an angular radius around the player's up axis.
 *
 * The reach is a SPHERE of radius `range` around the player; the range ring draws where that sphere
 * CUTS the surface it lands on (a fortress deck while standing on one, the terrain otherwise).
 * Standing on the ground it is the full circle, jumping pulls it in
 * (`cos(phi) = (Rp² + |C|² − R²) / (2·Rp·|C|)`, one acos), and jumping clear of `range` there is no
 * footprint at all. The ring (Game.updateIndicators), `Player.selectTargets`, `Player.whipHits` and
 * the host half of the whip event all read THIS — the old 3D-distance-only test let a jump put hits
 * metres OUTSIDE the drawn circle, which read as enemies dying under a jump with nothing visibly
 * shooting them.
 */
export function autoFootprint(surfR: number, height: number, range: number): { reach: boolean; theta: number } {
  const h = Math.max(0, height);
  const cLen = surfR + h;
  const cosPhi = (surfR * surfR + cLen * cLen - range * range) / (2 * surfR * cLen);
  if (cosPhi >= 1) return { reach: false, theta: 0 };
  return { reach: true, theta: Math.acos(Math.max(-1, cosPhi)) };
}

export interface PlayerNet {
  id: string;
  x: number; y: number; z: number;
  fx: number; fy: number; fz: number;
  hp: number;
  col: number;
  alive: number;
  lvl: number;
  ntn: string;
  ntc: number;
  mut: number;
  xp: number;
  xpn: number;
  /** 1 while this player is locked into a perk / Necrotech choice. */
  frz?: number;
  /** 1 while this player is a Blitz energy ball. */
  bl?: number;
  /**
   * When this pose was true, on the clock of whoever sent it. Positions are interpolated on that
   * timeline rather than on the moment the packet showed up, so network delay cannot distort the
   * speed of the motion (see ClockSync).
   */
  pt?: number;
  /** Accessory selection as "hat,backpack,pet" (catalog indices, -1 = none). Optional on the wire. */
  acc?: string;
  /**
   * The defensive state a client owns but the HOST's copy needs to make the same damage decisions
   * with: shield (+max), invulnerability and dash i-frame time REMAINING. Without these a shielded
   * or dashing client survived locally while the host's copy died — the phantom kill whose corpse
   * "kept walking around regenerating".
   */
  sh?: number;
  shm?: number;
  inv?: number;
  dsh?: number;
  gnd?: number;
  vsp?: number;
}

/** A pose a remote player reported: where it is and where it looks. */
interface NetPose {
  x: number; y: number; z: number;
  fx: number; fy: number; fz: number;
  gnd?: number;
  vsp?: number;
}

interface NetSample extends NetPose {
  /** Arrival time on the local clock (seconds). */
  t: number;
}

interface Buff {
  key: keyof Mods;
  mul: number;
  t: number;
  /** Original duration, so the UI can draw a countdown ring. */
  max: number;
  label: string;
  /** Icon key resolved by the UI (src/necrotech/AbilityIcons.ts). */
  icon: string;
  /** Human readable effect line for the status tooltip. */
  desc: string;
  debuff: boolean;
}

/** A stacking damage-over-time debuff (burn / toxin), Path-of-Exile style. */
interface PlayerDot {
  kind: 'burn' | 'toxin';
  dps: number;
  t: number;
  max: number;
  stacks: number;
  label: string;
}

/** One status icon for the head plate above the player. */
export interface PlayerStatus {
  key: string;
  label: string;
  desc: string;
  kind: 'buff' | 'debuff';
  icon: string;
  remain: number;
  total: number;
  stacks: number;
  /** False for permanent / resource statuses (ward, fusion) that have no countdown text. */
  timed: boolean;
}

/** A buff that makes the player weaker is drawn as a debuff. */
function buffIsDebuff(key: keyof Mods, mul: number): boolean {
  if (key === 'takenMul') return mul > 1;
  return mul < 1;
}

/** Picks a status glyph from the buff's own name (see AbilityIcons.statusIcon). */
function iconForLabel(label: string, debuff: boolean): string {
  const s = label.toLowerCase();
  if (/venom|toxic|poison|rot|plague/.test(s)) return 'toxin';
  if (/burn|flame|fire|wither|cinder|immolate/.test(s)) return 'burn';
  if (/web|snare|slow|chill|frost|root/.test(s)) return 'slow';
  if (/overcharge|frenzy|rage|fury|surge|berserk/.test(s)) return 'overcharge';
  if (/fortress|aegis|shield|guard|plating/.test(s)) return 'fortress';
  if (/siege|sunder|shatter|break|slam/.test(s)) return 'siege';
  if (/haste|swift|speed|blink|phase/.test(s)) return 'haste';
  if (/ward|barrier/.test(s)) return 'ward';
  return debuff ? 'slow' : 'spark';
}

/** Human readable wording for the modifier a buff applies. */
function describeMod(key: keyof Mods, mul: number): string {
  switch (key) {
    case 'spdMul': return `Movement speed ×${mul.toFixed(2)}`;
    case 'dmgMul': return `Damage ×${mul.toFixed(2)}`;
    case 'takenMul': return `Damage taken ×${mul.toFixed(2)}`;
    case 'rateMul': return `Attack speed ×${mul.toFixed(2)}`;
    case 'abilityMul': return `Ability power ×${mul.toFixed(2)}`;
    case 'hpMul': return `Max health ×${mul.toFixed(2)}`;
    case 'xpMul': return `Necromutation gain ×${mul.toFixed(2)}`;
    case 'regenMul': return `Regeneration ×${mul.toFixed(2)}`;
    case 'lifesteal': return `+${mul.toFixed(2)} lifesteal`;
    case 'crit': return `+${Math.round(mul * 100)}% crit chance`;
    case 'dashMax': return `+${Math.round(mul)} dash charge`;
    case 'projCount': return `+${Math.round(mul)} projectile${mul === 1 ? '' : 's'}`;
    case 'jumps': return `+${Math.round(mul)} mid-air jump${mul === 1 ? '' : 's'}`;
    case 'shieldHp': return `+${Math.round(mul)} shield`;
    case 'execMul': return `Execution bonus ×${mul.toFixed(2)}`;
    case 'burstMul': return `Burst size ×${mul.toFixed(2)}`;
    case 'cdMul': return `Cooldowns ×${mul.toFixed(2)}`;
    case 'rangeMul': return `Range ×${mul.toFixed(2)}`;
    case 'projSpeedMul': return `Projectile speed ×${mul.toFixed(2)}`;
    case 'dashRechargeMul': return `Dash recharge ×${mul.toFixed(2)}`;
    default: return `Effect ×${mul.toFixed(2)}`;
  }
}

export interface ModelParts {
  group: THREE.Group;
  rig: PlayerRig;
  legL: THREE.Bone;
  legR: THREE.Bone;
  armL: THREE.Bone;
  armR: THREE.Bone;
  /** Right-hand socket: the player's Necrotech weapon is mounted here (see refreshWeaponModel). */
  weaponMount: THREE.Group;
  torso: THREE.Bone;
  /** The factory backpack, hidden while a customizable backpack is worn. */
  pack: THREE.Mesh;
  /** Head socket: hats follow the helmet's centre (rest y 1.68). */
  headMount: THREE.Group;
  /** Back socket: backpacks follow the chest (rest y 1.15, z −0.28). */
  backMount: THREE.Group;
  invuln: THREE.Mesh;
  ringFx: THREE.Mesh;
  muzzle: THREE.Mesh;
  /** Necrotic Ward: a light-blue energy bubble shown while the shield has charge. */
  shieldBubble: THREE.Mesh;
  /** Necromutation aura: the pool of colony light under the feet (levels 10 / 15 / 20). */
  auraGlow: THREE.Mesh;
  auraGlowMat: THREE.MeshBasicMaterial;
  /** Level 20 only: the hovering crown that marks a fully crowned veteran. */
  auraCrown: THREE.Group;
  auraCrownMat: THREE.MeshBasicMaterial;
  /** Spinner: the chain whip, a child of the model so it is fixed to the body. */
  whipSpin: THREE.Group;
  whipMat: THREE.MeshBasicMaterial;
}

export function buildPlayerModel(color: number): ModelParts {
  const group = new THREE.Group();
  const rig = new PlayerRig(color);
  const { legL, legR, armL, armR, weaponMount, pack, headMount, backMount } = rig;
  const torso = rig.chest;
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), rig.accent);
  muzzle.visible = false;
  rig.handR.add(muzzle);

  const invulnMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const invuln = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 1), invulnMat);
  invuln.position.y = 1.0;
  invuln.visible = false;

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ringFx = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.045, 5, 28), ringMat);
  ringFx.rotation.x = Math.PI / 2;
  ringFx.position.y = 0.5;
  ringFx.visible = false;

  // ---- Necrotic Ward bubble: the same animated energy dome the towers use, in light blue
  const shieldMat = createShieldMaterial(0x7fe0ff, 0.32);
  const shieldBubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1.28, 3), shieldMat);
  shieldBubble.name = 'shieldBubble';
  shieldBubble.position.y = 0.98;
  shieldBubble.visible = false;
  shieldBubble.renderOrder = 6;

  // ---- Necromutation aura: a flat pool of light under the feet. Flat and on the ground, so it can
  // never be mistaken for a shield bubble around the body.
  const auraGlowMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const auraGlowGeo = new THREE.RingGeometry(0.42, 1, 48);
  auraGlowGeo.rotateX(-Math.PI / 2);
  const auraGlow = new THREE.Mesh(auraGlowGeo, auraGlowMat);
  auraGlow.name = 'auraGlow';
  auraGlow.position.y = 0.04;
  auraGlow.visible = false;
  auraGlow.renderOrder = 5;

  // ---- level 20 only: a small crown hovering above the head
  const auraCrownMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const auraCrown = new THREE.Group();
  auraCrown.name = 'auraCrown';
  const crownBandGeo = new THREE.TorusGeometry(0.19, 0.026, 5, 20);
  crownBandGeo.rotateX(Math.PI / 2);
  auraCrown.add(new THREE.Mesh(crownBandGeo, auraCrownMat));
  for (let i = 0; i < 5; i++) {
    const spikeGeo = new THREE.ConeGeometry(0.032, i === 2 ? 0.16 : 0.1, 4);
    const spike = new THREE.Mesh(spikeGeo, auraCrownMat);
    const a = (i / 5) * Math.PI * 2;
    spike.position.set(Math.cos(a) * 0.19, i === 2 ? 0.08 : 0.05, Math.sin(a) * 0.19);
    auraCrown.add(spike);
  }
  auraCrown.position.y = 2.42;
  auraCrown.visible = false;
  auraCrown.renderOrder = 6;

  // ---- Spinner: the chain whip itself, PARENTED TO THE MODEL. Nothing tracks the player — the arms
  // are children of the body, so they are simply where the player is, always, by construction.
  const whipMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const whipSpin = new THREE.Group();
  whipSpin.name = 'whipSpin';
  const WHIP_ARMS = 2;
  for (let i = 0; i < WHIP_ARMS; i++) {
    // a real curved lash: the chain bends outward and droops as it travels away from the body
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 1.15, 0.24),
      new THREE.Vector3(0.85, 1.05, 0.72),
      new THREE.Vector3(1.72, 0.86, 1.05),
      new THREE.Vector3(2.55, 0.6, 1.12),
      new THREE.Vector3(3.2, 0.32, 0.92),
    ]);
    const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.055, 5, false), whipMat);
    arm.renderOrder = 6;
    const holder = new THREE.Group();
    holder.rotation.y = (i / WHIP_ARMS) * Math.PI * 2;
    holder.add(arm);
    whipSpin.add(holder);
  }
  whipSpin.visible = false;
  group.add(whipSpin);

  group.add(rig.root, invuln, ringFx, shieldBubble, auraGlow, auraCrown);
  return { group, rig, legL, legR, armL, armR, weaponMount, torso, pack, headMount, backMount, invuln, ringFx, muzzle, shieldBubble, auraGlow, auraGlowMat, auraCrown, auraCrownMat, whipSpin, whipMat };
}

export class Player {
  id: string;
  name: string;
  isLocal: boolean;
  colony = 0;
  targetKey = '';

  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  up = new THREE.Vector3(0, 1, 0);
  facing = new THREE.Vector3(0, 0, 1);
  aimDir = new THREE.Vector3(0, 0, 1);
  grounded = false;
  alive = true;
  frozen = false; // level-up / pickup / results

  // ------------------------------------------------------------ terrain support
  /** Safety net (plan §25/§39): the last position the body stood on real terrain. */
  private readonly lastValidGroundPosition = new THREE.Vector3();
  private hasValidGround = false;
  /**
   * RECALL channel lock (user ask 2026-09-29): while the local player's recall runs, the body may
   * neither move nor fire anything. Set/cleared by `Game.requestRecall` / `cancelRecall`; a FRESH
   * input edge during the channel is what BREAKS it (Game.watchRecallInput runs before this update),
   * so this flag only ever swallows stale input and holds the body still.
   */
  recallHold = false;

  hp = CONFIG.player.maxHp;
  maxHp = CONFIG.player.maxHp;
  level = 1;
  xp = 0;
  xpNeed = 100;
  kills = 0;
  bossKills = 0;
  /** Nexus Mega Necrophages put down (the colony objective counts only these). */
  megaKills = 0;
  deaths = 0;
  damageDealt = 0;

  perks: Perk[] = [];
  necrotech: NecrotechDef = NECROTECHS[0];
  necrotechName = NECROTECHS[0].name;
  necrotechColor = NECROTECHS[0].stats.color;
  mutated = 0; // 0 none, 1 mutation, 2 super mutation
  /** The class picked in the colony phase — the root every mutation is folded on to. */
  baseNecrotech: NecrotechDef = NECROTECHS[0];
  /**
   * Absorbed Necrotechs, oldest first. Capped at `CONFIG.necrotechMutSlots`; a further mutation
   * randomly overwrites one of the existing entries, so a loadout never grows without limit.
   */
  mutSources: { def: NecrotechDef; superMut: boolean }[] = [];

  /**
   * HARD LIMIT: three Necrotechs in total — the starting class plus the absorbed ones. Absorbing a
   * fourth is impossible: `absorbNecrotech` overwrites an existing slot instead of growing the
   * stack, so a player can never hold a fourth active mutation.
   */
  readonly mutationLimit = 3;

  /**
   * The loadout's headline mutation, resolved from the RAW class names it holds.
   *
   * Two Necrotechs form a PAIR permutation; a FULL loadout (all three slots) forms a TRIPLE
   * permutation with its own name, ability picks and effects. The registries normalise the class
   * list, so the same loadout always resolves to the same mutation however it was collected.
   */
  get mutation(): MutationDef | null {
    const names = [this.baseNecrotech.name, ...this.mutSources.map(s => s.def.name)];
    if (names.length >= 3) {
      // Three Necrotechs = the loadout's identity is the TRIPLE permutation, not one lucky pair.
      return resolveTripleMutation(names[0], names[1], names[2]);
    }
    if (names.length === 2) return resolveMutation(names[0], names[1]);
    return null;
  }

  /** How many Necrotechs are active right now — the `[n / 3]` the HUD shows. */
  get activeMutations(): number {
    return Math.min(this.mutationLimit, this.mutSources.length + 1);
  }

  dashCharges = CONFIG.player.dashCharges;
  dashTimer = 0;
  dashRechargeT = 0;
  /** Molten Wake: metres travelled since the last pool, and the time gate that throttles them. */
  private lavaDist = 0;
  private lavaT = 0;
  /**
   * Dash momentum: the extra top speed a dash leaves behind. Each dash adds `dashMomentum`
   * (uncapped), it is KEPT while airborne — so dash-jump-dash-jump keeps building speed — and it
   * bleeds off gradually while running on the ground, back toward the normal run speed.
   */
  momentum = 0;
  private trailT = 0;
  private ghostPool: { obj: THREE.Object3D; mat: THREE.MeshBasicMaterial; life: number; max: number }[] = [];
  private ghostIdx = 0;
  private remoteGhostT = 0;
  private ghostSpawnT = 0;
  private coyote = 0;
  private jumpLock = 0;
  /** Mid-air leaps still available (shown on the mobile jump button). */
  jumpsLeft = 0;

  /**
   * Leaps the HUD counts. `jumpsLeft` only tracks the mid-air leaps, but the ground (or coyote)
   * leap is free, so a standing player really has two jumps — the mobile button reads 2, not 1.
   */
  get jumpsAvailable(): number {
    return this.jumpsLeft + (this.grounded || this.coyote > 0 ? 1 : 0);
  }

  /** Every leap the kit can chain in one hop: the base jump plus any perk-granted mid-air leaps. */
  get jumpsTotal(): number {
    return CONFIG.player.baseJumps + this.mods.jumps;
  }
  private airTime = 0;
  private remoteAnimVertical = 0;

  /** Necrotic Ward: absorbs damage before health and recharges while out of combat. */
  shield = 0;
  shieldMax = 0;
  private shieldRegenT = 0;

  skillCd = 0;
  ultCd = 0;
  skillCdMax = 6;
  ultCdMax = 40;
  /**
   * SKILL CHARGES (RIFT's Blink Strike carries 3). The skill casts while any charge remains; `skillCd`
   * is the per-charge recharge clock — when it completes, ONE charge returns and the clock restarts
   * until the pool is full, so three blinks come back one at a time instead of all at once.
   */
  skillCharges = 1;
  skillChargeMax = 1;
  attackCd = 0;
  targetId = 0;
  targetIsPlayer = false;

  lastDamageAt = -99;
  regenActive = false;
  /** Healing-pad feedback: accumulated hp and the throttle for its floating number. */
  private healNumT = 0;
  private healAccum = 0;
  /** Scripted Siegebreaker arc (see startSlam) — null when not diving. */
  private slam: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; maxH: number } | null = null;
  /** Seconds left as a Blitz energy cube (0 when not blitzing). */
  blitzT = 0;
  /** Time since the blitz began — the grace before "stopped moving" can cancel it. */
  private blitzGrace = 0;
  /** Throttle for the Necromutation aura motes. */
  private auraT = 0;
  /** Throttle for the movement wake the aura leaves behind. */
  private auraWakeT = 0;
  /** Angle of the level-20 revolving corona. */
  private auraHalo = 0;
  /** Throttle for the level-20 ground shockwaves. */
  private auraRingT = 0;
  /** Throttle for the level-20 shaft of light. */
  private auraBeamT = 0;
  /** Reused colour for the whitened aura motes. */
  private auraTint = new THREE.Color();
  /** Throttle for the Madmen passive's shield scan. */
  private madmenT = 0;
  /** Seconds left of the Spinner whirl (0 when not spinning). */
  private whipSpinT = 0;
  private whipSpinMax = 1;
  /** Reach of the whirl while it runs, so the world can shove enemies out of it. */
  private whipSpinR = 0;
  /** How many foes were inside the ring at the last Madmen scan. */
  private madmenFoes = 0;
  /** Reused list for the whip lash / Madmen scans. */
  private ball: THREE.Mesh | null = null;
  private ballWire: THREE.Mesh | null = null;
  private ballMat: THREE.MeshBasicMaterial | null = null;
  /** Game-clock time until which this player cannot take another Necrotech. */
  necrotechCdUntil = 0;
  invulnUntil = 0;
  respawnTimer = 0;
  /** True once this player has asked to be revived, so the ask is sent exactly once per death. */
  respawnAsked = false;
  lastAttackerId: string | null = null;
  pendingLevels = 0;

  mods: Mods = defaultMods();
  autoDamage = 10;
  autoRange = 12;
  autoRate = 2;
  projSpeed = 60;
  moveSpeed = CONFIG.player.maxSpeed;
  dashMax = CONFIG.player.dashCharges;

  buffs: Buff[] = [];
  /** Stacking burn / toxin effects taken from Necrophages. */
  dots: PlayerDot[] = [];
  private dotNumT = 0;
  private dotAccum = 0;
  /** Acquisition order for the status row, so icons keep the order they were picked up in. */
  private statusOrder = new Map<string, number>();
  private statusSeq = 0;

  model: THREE.Group;
  private parts: ModelParts;
  /** What this player wears (catalog indices, -1 = none). Saved locally, mirrored on the net. */
  accessorySelection: AccessorySelection = { ...EMPTY_SELECTION };
  /** Hat / backpack / pet rig. Rebuilt with the body (setColony) and re-dressed from the selection. */
  private accessories: AvatarAccessories;
  /** Terrain probe handed to the pet — reads the CURRENT planet, which is rebuilt every match. */
  private petTerrain: (p: THREE.Vector3) => number;
  /** Wire form of the last received accessory selection (remote players), so ticks are no-ops. */
  private accKey = '';
  /** The loaded class weapon currently mounted in the right hand (see refreshWeaponModel). */
  private weaponModel: THREE.Group | null = null;
  /** Identity of the mounted weapon — shape, tint and colony, so a refresh only runs on a change. */
  private weaponKey = '';
  private netSamples: NetSample[] = [];
  /** Smoothed velocity of a remote player (u/s) — drives its animation and its packet-loss coast. */
  private netVel = new THREE.Vector3();
  /** Adaptive playout buffer (s): how far behind the newest pose a remote player is drawn. */
  private netDelay = CONFIG.net.minDelay;
  /** Recent `arrival - pose time` readings — the delay wobble the buffer has to cover. */
  private netLags: { at: number; lag: number }[] = [];
  /**
   * The raw pose a remote player last reported, plus when it was true. The host relays *these*
   * rather than the copy it interpolates for its own screen, so motion coming from another client
   * is resampled once instead of twice — that double smoothing is what made remote players lag.
   */
  private netLatest: NetPose | null = null;
  private netLatestT = 0;

  /**
   * CORPSE state (ragdoll-lite): a dead body keeps the shove of the killing blow and slides to a
   * stop along the ground, and any living body that walks through it nudges it aside. The owner
   * peer simulates this (the resulting pose rides the normal state stream); `corpseFacing` is the
   * feet→head axis of the lying pose.
   */
  private corpseV = new THREE.Vector3();
  private corpseFacing = new THREE.Vector3(1, 0, 0);

  constructor(
    public readonly game: Game,
    id: string,
    name: string,
    isLocal: boolean
  ) {
    this.id = id;
    this.name = name;
    this.isLocal = isLocal;
    this.parts = buildPlayerModel(COLONIES[0].color);
    this.model = this.parts.group;
    this.model.visible = false;
    game.scene.add(this.model);
    this.recompute();
    this.refreshWeaponModel();
    this.accessories = new AvatarAccessories(this.parts.headMount, this.parts.backMount, this.parts.pack, game.scene);
    this.petTerrain = (p: THREE.Vector3): number => game.planet.heightAt(p);
  }

  // ------------------------------------------------------------ state

  setColony(idx: number): void {
    this.colony = idx;
    this.game.scene.remove(this.model);
    // the old builds are children of the OLD body — they go with it
    this.accessories.dispose();
    this.clearGhosts();
    disposeObject(this.model);
    this.weaponModel = null;
    this.parts = buildPlayerModel(COLONIES[idx].color);
    this.model = this.parts.group;
    this.game.scene.add(this.model);
    this.recompute();
    this.refreshWeaponModel();
    this.accessories = new AvatarAccessories(this.parts.headMount, this.parts.backMount, this.parts.pack, this.game.scene);
    this.accessories.set(this.accessorySelection, true);
  }

  /**
   * Wears a new hat / backpack / pet. The rig rebuilds only what changed, and the selection rides
   * the next net tick (`toNet`), so other players see the swap within a frame or two.
   */
  setAccessories(sel: AccessorySelection): void {
    this.accessorySelection = { ...sel };
    this.accessories.set(this.accessorySelection);
  }

  setNecrotech(def: NecrotechDef): void {
    this.necrotech = def;
    this.necrotechName = def.name;
    this.necrotechColor = def.stats.color;
    this.recompute();
    this.refreshWeaponModel();
  }

  /**
   * Puts this player's Necrotech weapon in their right hand: the SAME model the selection screen
   * shows (necrotech/WeaponModels), scaled to a person and mounted grip-first in the arm's socket.
   *
   * The SHAPE follows the class the run started with (the chassis — a fusion keeps the weapon it
   * was born with) and the TINT follows the live loadout, so a mutation visibly repaints the gun.
   * Only rebuilt when the loadout or the colony actually changes; the difference between the two
   * Necrotechs is what the weapon is FOR, so this is the one place a class is visible on the body.
   */
  private refreshWeaponModel(): void {
    const mount = this.parts.weaponMount;
    const colour = this.necrotech.stats.color;
    const key = `${this.baseNecrotech.name}|${colour}|${this.colony}`;
    // a rebuilt body (setColony) gets a fresh, EMPTY socket, so the mounted-model check matters as
    // much as the loadout key: the same class must still be re-mounted on to the new arm
    const mounted = this.weaponModel !== null && this.weaponModel.parent === mount;
    if (key === this.weaponKey && mounted) return;
    this.weaponKey = key;
    if (this.weaponModel) {
      mount.remove(this.weaponModel);
      // the weapon owns its own geometries and materials (built per class), so it can be disposed
      this.weaponModel.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) for (const one of mat) one.dispose();
        else if (mat) mat.dispose();
      });
      this.weaponModel = null;
    }
    const held = buildHeldWeapon(this.baseNecrotech, colour);
    this.weaponModel = held;
    mount.add(held);
    // the muzzle tell (drawn on your own weapon only) rides the weapon's own tip
    const muzzle = this.parts.muzzle;
    muzzle.position.set(0, 0, (held.userData.tipZ as number) ?? 0.5);
    mount.add(muzzle);
  }

  /** How many absorbed Necrotechs this player may carry before one has to be given up. */
  get mutSlots(): number {
    return CONFIG.necrotechMutSlots;
  }

  /** Necrotechs held in total: the starting class plus everything absorbed (3 when the stack is full). */
  get mutTotal(): number {
    return this.mutSources.length + 1;
  }

  /** True when any absorbed Necrotech was a super mutation. */
  get mutIsSuper(): boolean {
    return this.mutSources.some(s => s.superMut);
  }

  /** Chooses the starting class: clears whatever was absorbed before it. */
  setBaseNecrotech(def: NecrotechDef): void {
    this.baseNecrotech = def;
    this.mutSources.length = 0;
    this.refoldMutations();
  }

  /**
   * Absorbs a Necrotech. While a slot is free it joins the stack; once all `mutSlots` are taken it
   * randomly overwrites one of them, which is what keeps a long match from snowballing into an
   * unreadable ten-way fusion. Returns the class that was lost, or null when a slot was free.
   */
  absorbNecrotech(def: NecrotechDef, superMut: boolean): NecrotechDef | null {
    let lost: NecrotechDef | null = null;
    if (this.mutSources.length >= this.mutSlots) {
      const i = Math.floor(Math.random() * this.mutSources.length);
      lost = this.mutSources[i].def;
      this.mutSources[i] = { def, superMut };
    } else {
      this.mutSources.push({ def, superMut });
    }
    // The cap is enforced here and nowhere else, so no code path can grow the stack past it.
    if (this.mutSources.length > this.mutSlots) this.mutSources.length = this.mutSlots;
    this.refoldMutations();
    return lost;
  }

  /**
   * Rebuilds the live loadout: the generic fusion maths folds the base class through every
   * absorbed Necrotech in order, and then the loadout's resolved PERMUTATION — a pair for two
   * Necrotechs, a triple for three — is applied ONCE on top (its mods, weapon behaviour, ability
   * picks, traits and single drawback). The result keeps its own stats, mods and abilities, but
   * its name, role and super flag are restated from the whole stack so the HUD describes what the
   * player actually ended up with.
   */
  refoldMutations(): void {
    if (this.mutSources.length === 0) {
      this.mutated = 0;
      this.setNecrotech(this.baseNecrotech);
      return;
    }
    let fused = this.baseNecrotech;
    let anySuper = false;
    for (const s of this.mutSources) {
      fused = mutateDefs(fused, s.def, s.superMut);
      anySuper = anySuper || s.superMut;
    }
    const parents = [this.baseNecrotech, ...this.mutSources.map(s => s.def)];
    // The mutation identity is resolved from the RAW class list (see `get mutation`), and applied
    // exactly once — folding three classes produces intermediate pseudo-classes whose names are
    // not in the registry, so resolving per fold used to lose the third class's identity entirely.
    const m = this.mutation;
    if (m) fused = applyMutation(fused, m, parents, anySuper);
    const sep = anySuper ? '✷' : '·';
    fused.name = parents.map(d => d.name).join(sep);
    if (m) {
      fused.mutationId = m.id;
      fused.mutationName = m.name;
      fused.desc = `${m.name} — ${m.desc}`;
      const triple = m.requires.length > 2;
      fused.role = m.rarity === 'mythic'
        ? (triple ? 'MYTHIC TRIPLE' : 'MYTHIC MUTATION')
        : m.rarity === 'rare'
          ? (triple ? 'RARE TRIPLE' : 'RARE MUTATION')
          : (triple ? 'TRIPLE MUTATION' : 'MUTATION');
    } else {
      fused.role = anySuper ? 'SUPER MUTATION' : 'MUTATION';
    }
    fused.superMut = anySuper;
    this.mutated = anySuper ? 2 : 1;
    this.setNecrotech(fused);
  }

  applyPerk(perk: Perk): void {
    this.perks.push(perk);
    this.recompute();
    this.hp = this.maxHp;
  }

  addBuff(key: keyof Mods, mul: number, dur: number, label: string, icon = '', desc = ''): void {
    const debuff = buffIsDebuff(key, mul);
    this.buffs.push({
      key, mul, t: dur, max: dur, label,
      icon: icon || iconForLabel(label, debuff),
      desc: desc || `${describeMod(key, mul)} for ${dur.toFixed(1)}s`,
      debuff,
    });
    this.recompute();
  }

  /**
   * Adds a buff, or REFRESHES the existing entry with the same label. Non-additive mods multiply per
   * buff entry, so an aura that re-applies itself every tick (Fortress Protocol's field) must extend
   * its own entry — pushing a new one each tick would compound the effect into a hard immunity.
   */
  refreshBuff(key: keyof Mods, mul: number, dur: number, label: string, icon = '', desc = ''): void {
    const existing = this.buffs.find(b => b.label === label);
    if (!existing) {
      this.addBuff(key, mul, dur, label, icon, desc);
      return;
    }
    existing.mul = mul;
    existing.t = Math.max(existing.t, dur);
    existing.max = Math.max(existing.max, dur);
    if (desc) existing.desc = desc;
    this.recompute();
  }

  hasBuff(label: string): number {
    let t = 0;
    for (const b of this.buffs) if (b.label === label) t = Math.max(t, b.t);
    return t;
  }

  /** Drops a status early — a Blitz charge that was cut short must not keep its speed boost. */
  removeBuff(label: string): void {
    let changed = false;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (this.buffs[i].label !== label) continue;
      this.buffs.splice(i, 1);
      changed = true;
    }
    if (changed) this.recompute();
  }

  /**
   * Adds a stacking burn / toxin. Re-applying the same kind refreshes the duration and adds a
   * stack (max 5) worth 45% of the new effect — the same rule the Necrophages use.
   */
  addDot(kind: 'burn' | 'toxin', dps: number, dur: number, label = ''): void {
    const total = kind === 'burn' ? 3.2 : 4.6;
    const life = Math.max(dur, total * 0.6);
    const name = label || (kind === 'burn' ? 'Burning' : 'Toxin');
    const existing = this.dots.find(d => d.kind === kind);
    if (existing && this.dots.length < 5) {
      existing.dps = Math.max(existing.dps, dps) + dps * 0.45;
      existing.t = Math.max(existing.t, life);
      existing.max = Math.max(existing.max, life);
      existing.stacks = Math.min(5, existing.stacks + 1);
      return;
    }
    this.dots.push({ kind, dps, t: life, max: life, stacks: 1, label: name });
    if (this.dots.length > 5) this.dots.shift();
  }

  /**
   * Drops every damaging status: the burn / toxin DoTs and any negative buff (a slow, a shock). Used
   * by the colony healing pads — stepping into your own pad is a hard reset, not just a top-up.
   */
  cleanseDebuffs(): boolean {
    let removed = this.dots.length > 0;
    this.dots.length = 0;
    this.dotAccum = 0;
    this.dotNumT = 0;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (!this.buffs[i].debuff) continue;
      this.buffs.splice(i, 1);
      removed = true;
    }
    if (removed) this.recompute();
    return removed;
  }

  /** Everything the head-plate status row needs to draw (buff and debuff alike). */
  statuses(): PlayerStatus[] {
    const now = this.game.now;
    const out: PlayerStatus[] = [];
    for (const b of this.buffs) {
      out.push({
        key: `b:${b.label}`,
        label: b.label,
        desc: b.desc,
        kind: b.debuff ? 'debuff' : 'buff',
        icon: b.icon,
        remain: Math.max(0, b.t),
        total: b.max,
        stacks: 0,
        timed: true,
      });
    }
    for (const d of this.dots) {
      out.push({
        key: `d:${d.kind}`,
        label: d.stacks > 1 ? `${d.label} ×${d.stacks}` : d.label,
        desc: `${d.kind === 'burn' ? 'Burning' : 'Toxin'} — ${d.dps.toFixed(1)} damage/s${d.stacks > 1 ? ` (${d.stacks} stacks)` : ''}`,
        kind: 'debuff',
        icon: d.kind,
        remain: Math.max(0, d.t),
        total: d.max,
        stacks: d.stacks,
        timed: true,
      });
    }
    if (this.shield > 0) {
      out.push({
        key: 'ward',
        label: 'Necrotic Ward',
        desc: `Absorbs ${Math.round(this.shield)} damage before health. Recharges ${CONFIG.player.shieldRegenDelay}s after taking a hit.`,
        kind: 'buff',
        icon: 'ward',
        // the ring doubles as the remaining absorb, so no countdown text is shown
        remain: this.shield,
        total: Math.max(1, this.shieldMax),
        stacks: 0,
        timed: false,
      });
    }
    if (now < this.invulnUntil) {
      out.push({
        key: 'invuln',
        label: 'Invulnerable',
        desc: 'Immune to all damage.',
        kind: 'buff',
        icon: 'invuln',
        remain: this.invulnUntil - now,
        total: CONFIG.player.spawnInvuln,
        stacks: 0,
        timed: true,
      });
    }
    const boon = this.game.colonyBuffs[this.colony];
    if (boon && boon.time > 0) {
      out.push({
        key: 'boon',
        label: 'Colony Overdrive',
        desc: 'ALL COLONY STATS ×2 — damage, ability power and Necromutation gain doubled, damage taken halved.',
        kind: 'buff',
        icon: 'boon',
        remain: boon.time,
        total: 30,
        stacks: 0,
        timed: true,
      });
    }
    if (this.mutated) {
      const n = this.mutSources.length;
      const superMut = this.mutIsSuper;
      out.push({
        key: 'mut',
        label: superMut
          ? 'Super Necrotech Mutation'
          : this.mutTotal > 2
            ? 'Triple Necrotech Mutation'
            : 'Necrotech Mutation',
        desc: n === 0
          ? 'A fused Necrotech loadout.'
          : `${this.mutTotal}/${this.mutSlots + 1} Necrotechs fused into one loadout: ${this.necrotechName}. Further mutations replace one at random.`,
        kind: 'buff',
        icon: 'mutate',
        remain: 1,
        total: 1,
        // the badge counts the WHOLE loadout (base + absorbed), so a full stack reads ×3 — it used
        // to count only the absorbed ones and a three-Necrotech loadout showed "×2"
        stacks: this.activeMutations,
        timed: false,
      });
    }
    if (now < this.necrotechCdUntil) {
      out.push({
        key: 'ntcd',
        label: 'System Recharging',
        desc: 'Cannot absorb another Necrotech until this finishes.',
        kind: 'debuff',
        icon: 'cooldown',
        remain: this.necrotechCdUntil - now,
        total: CONFIG.necrotechPickupCd,
        stacks: 0,
        timed: true,
      });
    }

    // Order by when each status was first picked up (not alphabetically, not by category), and
    // forget the keys that are gone so a re-applied effect counts as newly obtained.
    const live = new Set<string>();
    for (const s of out) {
      live.add(s.key);
      if (!this.statusOrder.has(s.key)) this.statusOrder.set(s.key, this.statusSeq++);
    }
    for (const key of [...this.statusOrder.keys()]) {
      if (!live.has(key)) this.statusOrder.delete(key);
    }
    out.sort((a, b) => (this.statusOrder.get(a.key) ?? 0) - (this.statusOrder.get(b.key) ?? 0));
    return out;
  }

  recompute(): void {
    const m = defaultMods();
    // colony identity
    if (this.colony === 0) {
      m.dmgMul *= 1.1; m.abilityMul *= 1.1; m.hpMul *= 0.9;
    } else if (this.colony === 1) {
      m.hpMul *= 1.15; m.takenMul *= 0.9; m.spdMul *= 0.9;
    } else {
      m.spdMul *= 1.1; m.xpMul *= 1.1; m.abilityMul *= 0.9;
    }
    mergeMods(m, this.necrotech.mods);
    for (const p of this.perks) p.apply(m, this);
    // beacon colony buffs (Boon of the towers)
    const buff = this.game.colonyBuffs[this.colony];
    if (buff && buff.time > 0) {
      m.dmgMul *= buff.dmg;
      m.takenMul *= buff.taken;
      m.xpMul *= buff.xp;
      m.abilityMul *= buff.ability;
    }
    for (const b of this.buffs) {
      // additive buffs (extra projectiles, jumps, dash charges, shield, crit…) stack by sum
      if (ADDITIVE_MODS.indexOf(b.key) >= 0) m[b.key] += b.mul;
      else m[b.key] *= b.mul;
    }
    this.mods = m;

    const prevMax = this.maxHp;
    // HEALTH SCALING: the level pool is part of the base, so levelling keeps a survivor's health
    // growing alongside the damage multipliers the perks hand out (see CONFIG.player.hpPerLevel and
    // the PvP window in CONFIG.pvp).
    this.maxHp = Math.round((CONFIG.player.maxHp + CONFIG.player.hpPerLevel * (this.level - 1)) * m.hpMul);
    if (this.maxHp > prevMax) this.hp += this.maxHp - prevMax;
    this.hp = clamp(this.hp, 0, this.maxHp);

    // skill charges: the max rides the SKILL def (so a fusion that inherits Blink keeps its 3),
    // and only a POOL GROWTH tops the charges up — a mid-fight swap must not gift free casts
    const prevChargeMax = this.skillChargeMax;
    this.skillChargeMax = Math.max(1, Math.round(this.necrotech.skill.charges ?? 1));
    if (this.skillChargeMax > prevChargeMax) this.skillCharges += this.skillChargeMax - prevChargeMax;
    this.skillCharges = clamp(this.skillCharges, 0, this.skillChargeMax);

    this.autoDamage = this.necrotech.stats.damage * m.dmgMul;
    this.autoRange = this.necrotech.stats.range * m.rangeMul;
    this.autoRate = this.necrotech.stats.rate * m.rateMul;
    this.projSpeed = this.necrotech.stats.projSpeed * m.projSpeedMul;
    this.moveSpeed = CONFIG.player.maxSpeed * m.spdMul;
    this.dashMax = Math.min(3, CONFIG.player.dashCharges + m.dashMax);
    this.dashCharges = Math.min(this.dashCharges, this.dashMax);
    // ability cooldowns are capped at 12s so the fight always stays active
    this.skillCdMax = Math.min(CONFIG.abilityCdCap, this.necrotech.skill.cd * CONFIG.skillCdScale * m.cdMul);
    this.ultCdMax = Math.min(CONFIG.abilityCdCap, this.necrotech.ult.cd * CONFIG.ultCdScale * m.cdMul);

    // Necrotic Ward scales with perk picks and refills when it grows
    const prevShield = this.shieldMax;
    this.shieldMax = Math.round(m.shieldHp);
    if (this.shieldMax > prevShield) this.shield += this.shieldMax - prevShield;
    this.shield = Math.min(this.shield, this.shieldMax);
  }

  /**
   * How long this player's Ultimate effects last: `CONFIG.ultDuration` scaled by everything that
   * feeds `mods.ultDurMul` — the class passive and any duration Necromutation perk picked up. Every
   * lingering ultimate (Berserker's burn, Thunder Zone, Black Hole, Fortress Protocol …) reads this,
   * so upgrading one number lengthens the whole roster consistently.
   */
  get ultDuration(): number {
    return Math.min(CONFIG.ultDurationCap, CONFIG.ultDuration * this.mods.ultDurMul);
  }

  isInvulnerable(): boolean {
    return !this.alive || this.frozen || this.dashTimer > 0 || this.game.now < this.invulnUntil;
  }

  headPos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).addScaledVector(this.up, 1.85);
  }

  // ------------------------------------------------------------ lifecycle

  spawnAt(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.up.copy(pos).normalize();
    this.velocity.set(0, 0, 0);
    this.alive = true;
    this.hp = this.maxHp;
    this.frozen = false;
    this.recallHold = false;
    this.respawnTimer = 0;
    this.respawnAsked = false;
    // the corpse is gone the moment the player is: no carried slide, no facing from the fall
    this.corpseV.set(0, 0, 0);
    this.invulnUntil = this.game.now + CONFIG.player.spawnInvuln;
    this.model.visible = true;
    this.dashCharges = this.dashMax;
    // A respawn is a clean slate: no carried dash momentum and no lingering cast state — the skill
    // and ultimate come back READY (dying should not also cost you your buttons), and nothing from
    // the death moment (a diving Siegebreaker, a Blitz ride, a running Spinner whirl) plays on from
    // beyond the grave.
    this.momentum = 0;
    this.dashTimer = 0;
    this.dashRechargeT = 0;
    // the wake starts clean: no pool owed from whatever the double did before it died
    this.lavaDist = 0;
    this.lavaT = 0;
    this.skillCd = 0;
    this.ultCd = 0;
    this.skillCharges = this.skillChargeMax;
    this.attackCd = 0;
    this.slam = null;
    this.whipSpinT = 0;
    this.whipSpinR = 0;
    this.parts.whipSpin.visible = false;
    if (this.blitzT > 0) {
      this.blitzT = 0;
      this.blitzGrace = 0;
      this.hideBlitzVisual();
      this.removeBuff('Blitz');
    }
    // burn / toxin does not follow you through death
    this.dots.length = 0;
    this.dotAccum = 0;
    this.dotNumT = 0;
    if (this.isLocal) {
      this.game.cam.snap();
      this.game.cam.forward.copy(this.facing);
    }
  }

  teleport(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.up.copy(pos).normalize();
    this.game.planet.projectToSurface(this.position);
    // keep a teleported player on their fortress deck instead of dropping them through it
    const deck = this.game.bases.deckUnder(this.up);
    if (deck) this.position.multiplyScalar(deck.deckRadius / Math.max(1, this.position.dot(deck.up)));
    this.velocity.set(0, 0, 0);
  }

  /**
   * RECALL arrival: re-seat the body on its colony deck WITHOUT the death reset — health, cooldowns
   * and buffs stay exactly as they were (a recall is a reposition, not a free heal), but every bit
   * of carried motion (dash momentum, a dive, a riding Blitz) dies with the channel.
   */
  recallTo(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.up.copy(pos).normalize();
    this.velocity.set(0, 0, 0);
    this.recallHold = false;
    this.momentum = 0;
    this.dashTimer = 0;
    this.slam = null;
    if (this.blitzT > 0) this.endBlitz(false);
    // A short arrival grace only — not the full spawn immunity: long enough that stepping back
    // into the fight is deliberate, short enough that it cannot be banked.
    this.invulnUntil = Math.max(this.invulnUntil, this.game.now + 0.6);
  }

  /**
   * The match authority says this player is down (the `kill` message): death WITHOUT a damage
   * roll — no invulnerability check, no shield, no minimum. Used when the host has already
   * registered the kill but this copy never felt the blow (an i-frame or a shield gap), so both
   * sides agree on the corpse instead of one side walking around regenerating.
   */
  forceDeath(srcId: string | null = null): void {
    if (!this.alive) return;
    if (srcId && srcId !== this.id) this.lastAttackerId = srcId;
    this.hp = 0;
    this.die(srcId);
  }

  takeDamage(amount: number, srcId: string | null, kind: string): void {
    if (!this.alive || this.isInvulnerable()) return;
    // A recall is a committed, vulnerable channel: the first real hit breaks it.
    this.game.cancelRecall(this, 'interrupted');
    let dmg = Math.max(1, amount * this.mods.takenMul);
    // the Necrotic Ward soaks damage before health and starts recharging
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, dmg);
      this.shield -= soaked;
      dmg -= soaked;
      this.shieldRegenT = CONFIG.player.shieldRegenDelay;
      this.game.effects.ring(this.position, this.up, 1, 0x7fe6ff, 0.35, 1.2, 0.7);
      if (this.isLocal) this.game.effects.damageNumber(_tmp.copy(this.position).addScaledVector(this.up, 1.9), `WARD -${Math.round(soaked)}`, 0x7fe6ff, 1);
      if (dmg <= 0) return;
    }
    this.hp -= dmg;
    this.lastDamageAt = this.game.now;
    this.regenActive = false;
    if (srcId && srcId !== this.id) this.lastAttackerId = srcId;
    this.game.effects.damageNumber(_tmp.copy(this.position).addScaledVector(this.up, 1.6), `-${Math.round(dmg)}`, 0xff5577, 1);
    this.game.effects.blood(this.headPos(_tmp2), 0xff4466);
    this.game.audio.sfx('hit', 0.8);
    if (this.game.isLocalPlayer(this)) this.game.effects.shake(0.16);
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(srcId);
    }
  }

  private die(srcId: string | null = null): void {
    this.alive = false;
    this.deaths++;
    this.respawnTimer = CONFIG.player.respawnTime;
    this.velocity.set(0, 0, 0);
    // RAGDOLL-LITE: the body stays where it fell, shoved away from whoever struck it down, and
    // slides to a stop (see `corpseStep`). It remains a corpse — no health, no bar, no regen — for
    // the whole respawn clock; only `spawnAt` puts the player back on their feet.
    this.beginCorpse(srcId);
    // Nothing the player was running keeps playing from beyond the grave — and nothing FIRES from
    // it either: a Blitz ride is put away without its exit blast, a Spinner whirl stops, a queued
    // cast is dropped and the rounds already in the air are cleared, so a corpse can no longer land
    // one last silent kill while the death overlay is up.
    if (this.blitzT > 0) this.endBlitz(false);
    this.whipSpinT = 0;
    this.whipSpinR = 0;
    this.parts.whipSpin.visible = false;
    this.slam = null;
    this.game.combat.clearOwner(this.id);
    if (this.isLocal) this.game.input.clearActions();
    this.game.effects.burst(this.position, this.necrotechColor, { count: 26, speed: 12, life: 0.7, size: 0.7, gravity: 18 });
    this.game.effects.ring(this.position, this.up, 1.5, this.necrotechColor, 0.6, 2.2, 0.8);
    this.game.audio.sfx('enemyDeath');
    if (this.isLocal) this.game.effects.shake(0.4);
    this.game.onPlayerDied(this);
  }

  /** Arms the corpse: fall direction (away from the killer when there is one) + slide speed. */
  private beginCorpse(srcId: string | null): void {
    const src = srcId ? this.game.players.get(srcId) : null;
    if (src) _tmp.copy(this.position).sub(src.position);
    else _tmp.copy(this.facing);
    _tmp.addScaledVector(this.up, -_tmp.dot(this.up));
    if (_tmp.lengthSq() < 1e-4) _tmp.copy(this.facing);
    this.corpseFacing.copy(_tmp.normalize());
    this.corpseV.copy(this.corpseFacing).multiplyScalar(src ? CONFIG.player.corpsePush : 1.2);
  }

  /**
   * Corpse physics, run by the peer that owns the dead player: the slide bleeds off against the
   * ground (and follows it — terrain or fortress deck), and a living body walking through the
   * corpse shoves it aside. No health is ever touched here, and the body is only cleared by
   * `spawnAt` when the respawn clock runs out.
   */
  private corpseStep(dt: number): void {
    const g = this.game;
    const cfg = CONFIG.player;
    for (const other of g.players.values()) {
      if (!other.alive || other === this) continue;
      _tmp.copy(this.position).sub(other.position);
      const d = _tmp.length();
      if (d > 1.5 || d < 1e-3) continue;
      _tmp.multiplyScalar(1 / d);
      _tmp.addScaledVector(this.up, -_tmp.dot(this.up));
      if (_tmp.lengthSq() < 1e-4) continue;
      // walked over: the closer the body is to the corpse's centre, the harder the nudge
      this.corpseV.addScaledVector(_tmp.normalize(), cfg.corpseShove * (1 - d / 1.5) * dt);
    }
    const sp = this.corpseV.length();
    if (sp < 0.05) {
      this.corpseV.set(0, 0, 0);
      return;
    }
    if (sp > 4.5) this.corpseV.multiplyScalar(4.5 / sp);
    this.position.addScaledVector(this.corpseV, dt);
    this.up.copy(this.position).normalize();
    g.planet.projectToSurface(this.position);
    // a corpse died ON its deck stays ON it instead of dropping to the terrain below
    const deck = g.bases.deckUnder(this.up);
    if (deck) this.position.multiplyScalar(deck.deckRadius / Math.max(1, this.position.dot(deck.up)));
    // a body does not bounce: the radial component dies the moment it touches down
    this.corpseV.addScaledVector(this.up, -this.corpseV.dot(this.up));
    this.corpseV.multiplyScalar(Math.max(0, 1 - cfg.corpseFriction * dt));
  }

  gainXp(amount: number): void {
    if (!this.alive || this.frozen) return;
    const gain = amount * this.mods.xpMul;
    this.xp += gain;
    while (this.xp >= this.xpNeed) {
      this.xp -= this.xpNeed;
      this.level++;
      this.xpNeed = Math.round(100 * Math.pow(1.28, this.level - 1));
      this.pendingLevels++;
      // the level itself grows the pool (CONFIG.player.hpPerLevel) — recompute also heals by the gain
      this.recompute();
      this.game.audio.sfx('levelup');
      this.game.onPlayerLevelUp(this);
    }
  }

  heal(amount: number): void {
    if (!this.alive) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /**
   * Starts the Siegebreaker leap: a ballistic arc from where the caster stands to the marked ground.
   * The owner peer animates it, while the host has the impact damage scheduled for `dur` seconds.
   */
  startSlam(from: THREE.Vector3, to: THREE.Vector3, dur: number, maxH: number): void {
    this.slam = { from: from.clone(), to: to.clone(), t: 0, dur: Math.max(0.2, dur), maxH };
  }

  /** True while the Siegebreaker dive is running. */
  get slamming(): boolean {
    return this.slam !== null;
  }

  /** True while this player is an energy ball (Blitz pad). */
  get blitzing(): boolean {
    return this.blitzT > 0;
  }

  /** Catapults the player straight off the surface — jump pads. */
  launch(speed: number): void {
    if (!this.alive) return;
    this.up.copy(this.position).normalize();
    this.velocity.addScaledVector(this.up, speed);
    this.grounded = false;
    this.jumpsLeft = this.mods.jumps;
    this.coyote = 0;
    this.jumpLock = 0.2;
  }

  /**
   * Springboarded off a platform's outer edge (a colony fortress deck): the same pinning `launch`
   * does — airborne, jumps refilled, no snap-back — but the shove points OUT along `dir` instead
   * of straight up, so the body leaves the platform along its own run. See `BaseManager.edgeLaunch`.
   */
  edgeBoost(dir: THREE.Vector3, speed: number, lift: number): void {
    if (!this.alive) return;
    this.up.copy(this.position).normalize();
    this.velocity.addScaledVector(dir, speed);
    this.velocity.addScaledVector(this.up, lift);
    this.grounded = false;
    this.jumpsLeft = this.mods.jumps;
    this.coyote = 0;
    this.jumpLock = 0.2;
  }

  /**
   * Blitz pad: become an energy CUBE. Invulnerable, much faster, and the exit blast is fired through
   * the ability event channel so the host applies the damage (see AbilitySystem 'blitz'). The ride
   * ends early the instant the runner stops holding a direction — the charge is spent by moving.
   */
  startBlitz(dur: number): void {
    if (!this.alive) return;
    this.blitzT = dur;
    this.blitzGrace = 0;
    this.slam = null;
    this.invulnUntil = Math.max(this.invulnUntil, this.game.now + dur);
    this.addBuff('spdMul', CONFIG.pads.blitzSpeed, dur, 'Blitz');
    this.ensureBall();
  }

  /**
   * True while the runner is still committing to the charge. Movement INTENT only (sticks / WASD) —
   * a velocity fallback would keep the charge alive for half a second after the player let go.
   */
  private movingForBlitz(): boolean {
    const i = this.game.input;
    return Math.hypot(i.moveX, i.moveY) > 0.2;
  }

  /**
   * Ends the charge: hide the cube and — unless this is a shutdown (`blast = false`: a death or a
   * menu) — fire the exit blast. A corpse or a frozen picker must never detonate one.
   */
  private endBlitz(blast = true): void {
    this.blitzT = 0;
    this.blitzGrace = 0;
    this.hideBlitzVisual();
    // the speed boost belongs to the RIDE, not to a timer: cutting the charge short (stopping, or the
    // burst itself) has to kill the boost on the same frame, or the runner keeps sprinting for the
    // rest of the 2 s the buff was granted for.
    this.removeBuff('Blitz');
    if (blast && this.isLocal) {
      // routed like any other cast, so the host owns the damage
      this.game.abilities.fireEvent(this, 'blitz');
    }
  }

  private hideBlitzVisual(): void {
    if (this.ball) this.ball.visible = false;
    if (this.ballWire) this.ballWire.visible = false;
  }

  // ------------------------------------------------------------ update

  update(dt: number): void {
    if (this.isLocal) {
      this.updateLocal(dt);
    } else {
      this.updateNet(dt);
      // A remote copy only carries statuses so the head plate can draw them (the effects and all
      // their damage belong to the owner); their clocks still have to tick, or every icon above
      // another player sat frozen at whatever it was when the status landed.
      this.tickStatusTimers(dt);
    }
    this.updateBlitz(dt);
    this.animate(dt);
    this.updateGhosts(dt);
  }

  /**
   * Counts a REMOTE copy's status timers down and drops what expired. Purely display-side: buffs
   * and DoTs on someone else's copy never apply damage or modify gameplay (the owner peer runs
   * the real ones and its health rides the state stream).
   */
  private tickStatusTimers(dt: number): void {
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      this.buffs[i].t -= dt;
      if (this.buffs[i].t <= 0) this.buffs.splice(i, 1);
    }
    for (let i = this.dots.length - 1; i >= 0; i--) {
      this.dots[i].t -= dt;
      if (this.dots[i].t <= 0) this.dots.splice(i, 1);
    }
  }

  // ------------------------------------------------------------ blitz (energy cube)

  private ensureBall(): void {
    if (this.ball) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffc24d,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ball = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), mat);
    ball.visible = false;
    ball.renderOrder = 7;
    // a bright wireframe cage around the core: reads clearly as an energy CUBE, not a blob
    const wire = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 2.5, 2.5),
      new THREE.MeshBasicMaterial({
        color: 0xffe6a8, wireframe: true, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    wire.visible = false;
    wire.renderOrder = 7;
    this.game.scene.add(ball, wire);
    this.ball = ball;
    this.ballWire = wire;
    this.ballMat = mat;
  }

  private updateBlitz(dt: number): void {
    if (this.blitzT <= 0) {
      this.hideBlitzVisual();
      return;
    }
    // Death or a menu ends the ride FIRST, and ends it SILENTLY: the exit blast is an attack, and
    // neither a corpse nor a player locked in a picker may fire one.
    if (!this.alive || this.frozen) {
      this.endBlitz(false);
      return;
    }
    this.blitzT = Math.max(0, this.blitzT - dt);
    this.blitzGrace += dt;
    const g = this.game;
    const t = g.clock;
    this.ensureBall();

    const ball = this.ball;
    const wire = this.ballWire;
    if (ball && wire) {
      const pulse = 1 + 0.12 * Math.sin(t * 16);
      ball.visible = true;
      wire.visible = true;
      ball.position.copy(this.position).addScaledVector(this.up, 0.95);
      wire.position.copy(ball.position);
      ball.scale.setScalar(pulse * 0.66);
      wire.scale.setScalar(pulse);
      // the core and the cage counter-rotate, which makes the spin obvious
      ball.rotation.y += dt * 3.6;
      ball.rotation.x += dt * 2.4;
      wire.rotation.y -= dt * 2.8;
      wire.rotation.x += dt * 1.5;
      if (this.ballMat) this.ballMat.opacity = 0.45 + 0.2 * Math.sin(t * 15);
    }

    // the streak: a dense particle tail so the cube reads as something tearing across the field
    if (Math.random() < dt * 70) {
      g.effects.burst(this.position, 0xffc24d, { count: 2, speed: 3.6, life: 0.38, size: 0.6, gravity: 0 });
    }
    if (Math.random() < dt * 26) {
      g.effects.trail(_blitzScratch.copy(this.position).addScaledVector(this.up, 0.95), 0xffe6a8, 0.85, 0.3);
    }

    // a charge is spent the moment the runner stops — it bursts right there
    const stopped = this.isLocal
      && this.blitzGrace > CONFIG.pads.blitzMoveGrace
      && !this.movingForBlitz();
    if (this.blitzT <= 0 || stopped) this.endBlitz();
  }

  // ------------------------------------------------------------ dash afterimages

  private ensureGhosts(): void {
    if (this.ghostPool.length > 0) return;
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: this.necrotechColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const obj = cloneSkeleton(this.model);
      obj.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = mat;
      });
      obj.visible = false;
      obj.renderOrder = 6;
      this.game.scene.add(obj);
      this.ghostPool.push({ obj, mat, life: 0, max: 1 });
    }
  }

  private spawnGhost(opacity: number, life: number): void {
    this.ensureGhosts();
    if (this.ghostPool.length === 0) return;
    const ghost = this.ghostPool[this.ghostIdx];
    this.ghostIdx = (this.ghostIdx + 1) % this.ghostPool.length;
    ghost.mat.color.setHex(this.necrotechColor);
    ghost.obj.position.copy(this.position);
    ghost.obj.quaternion.copy(this.model.quaternion);
    ghost.obj.scale.copy(this.model.scale);
    ghost.obj.traverse(object => {
      if (!(object instanceof THREE.Bone)) return;
      const source = this.model.getObjectByName(object.name);
      if (!source) return;
      object.position.copy(source.position);
      object.quaternion.copy(source.quaternion);
    });
    ghost.obj.visible = true;
    ghost.life = life;
    ghost.max = life;
    ghost.mat.opacity = opacity;
  }

  private updateGhosts(dt: number): void {
    for (const ghost of this.ghostPool) {
      if (ghost.life <= 0) continue;
      ghost.life -= dt;
      const t = Math.max(0, ghost.life / ghost.max);
      ghost.mat.opacity = t * 0.5;
      if (ghost.life <= 0) ghost.obj.visible = false;
    }
    // remote peers: infer their dash from a velocity spike so their dash reads too
    if (!this.isLocal && this.alive) {
      this.remoteGhostT -= dt;
      if (this.remoteGhostT <= 0 && this.velocity.length() > 19) {
        this.remoteGhostT = 0.1;
        this.spawnGhost(0.35, 0.26);
      }
    }
  }

  private updateLocal(dt: number): void {
    const g = this.game;
    this.aimDir.copy(g.input.aimDir);

    if (!this.alive) {
      // Respawning is decided by the match authority, never by the dead client alone: we keep the
      // countdown running for the death overlay and ask to be revived when it runs out. The host
      // places us and tells everybody, so no two peers ever disagree about where we came back.
      // A corpse takes no input with it either: anything queued on the way down is dropped, so the
      // player cannot fire an ability the moment they are handed control back after a respawn.
      g.input.clearActions();
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.respawnTimer = 0;
        g.requestRespawn(this);
      }
      // the body is still on the field: keep its slide/being walked over alive until the respawn
      this.corpseStep(dt);
      return;
    }

    if (this.frozen) {
      // Invulnerable selection state (Necromutation perk picker / Necrotech offer). The picker
      // eats gameplay INPUT while it is up — a click aimed at a card must not still be sitting in
      // the queue when the menu closes — and the GROUND rule stays the old one: a run that is on
      // the ground brakes to a stop (the old 1 - dt*5 bleed). ONLY an AIRBORNE body keeps its
      // momentum (user ask 2026-09-30): there the velocity is left untouched and gravity keeps
      // running, so a jump carries its arc through the whole choice instead of hovering and then
      // dropping. Steering, dashes, jumps and attacks stay suspended either way.
      g.input.clearActions();
      // A committed Siegebreaker arc is the one exception that still runs (the slam block below):
      // its impact is already scheduled, so the dive flies on to its own landing.
      if (!this.slam) {
        if (this.grounded) this.velocity.multiplyScalar(Math.max(0, 1 - dt * 5));
        this.velocity.addScaledVector(this.up, -CONFIG.player.gravity * dt);
        this.integrate(dt);
        this.tickSkillCharges(dt);
        this.ultCd = Math.max(0, this.ultCd - dt);
        this.tickBuffs(dt);
        return;
      }
    }

    // RECALL lock (user ask 2026-09-29): anything queued while the channel holds is STALE — the
    // frame that a fresh press lands, Game.watchRecallInput has already broken the channel before
    // this method runs, so surviving flags here are only same-frame leftovers and are swallowed.
    if (this.recallHold) {
      g.input.consumeDash();
      g.input.consumeJump();
      g.input.consumeSkill();
      g.input.consumeUlt();
      g.input.consumeBeacon();
    }

    // Siegebreaker: a scripted arc from the takeoff point to the slam. Driven by the peer that owns
    // this player, so it is a visible fast descent rather than a snap teleport. The apex sits early
    // and the tail of the curve is steep, so the second half of the flight is a plunge.
    if (this.slam) {
      const s = this.slam;
      s.t += dt;
      const u = clamp(s.t / s.dur, 0, 1);
      const ease = u * u * (3 - 2 * u);
      // 0.68 of the flight is the RISE and the remaining third is the plunge, with an accelerating
      // tail — a heavy descent, not a floaty one.
      const apex = 0.68;
      const arc = u <= apex
        ? Math.sin((u / apex) * Math.PI * 0.5)
        : Math.pow(1 - (u - apex) / (1 - apex), 2.2);
      this.up.copy(s.from).lerp(s.to, ease).normalize();
      const surface = g.planet.heightAtDir(this.up.x, this.up.y, this.up.z);
      this.position.copy(this.up).multiplyScalar(surface + s.maxH * arc);
      this.velocity.set(0, 0, 0);
      this.grounded = u >= 1;
      // a hot streak once the dive starts, so the slam reads as a plunge and not a float
      if (this.isLocal && u > apex && Math.random() < 0.9) {
        g.effects.trail(this.position, this.necrotechColor, 0.85, 0.24);
      }
      if (u >= 1) this.slam = null;
      this.tickSkillCharges(dt);
      this.ultCd = Math.max(0, this.ultCd - dt);
      this.tickDots(dt);
      this.tickBuffs(dt);
      return;
    }

    const planet = g.planet;
    // the recall lock pins the body: the stick and the direction keys are ignored while it holds
    const hold = this.recallHold;
    g.cam.moveBasis(this.up, _f, _r);
    _wish.set(0, 0, 0);
    if (!hold) _wish.addScaledVector(_f, g.input.moveY).addScaledVector(_r, g.input.moveX);
    const wishLen = _wish.length();
    if (wishLen > 0.001) _wish.multiplyScalar(1 / wishLen);

    const environmentSpeed = g.envWorld?.ecology.hazards.apply(this, dt) ?? 1;
    const slope = planet.slopeAt(this.position);
    const slopeMul = 1 / (1 + Math.max(0, slope - 0.3) * 1.1);
    // dash momentum raises the target speed itself, so the body is driven to hold the extra pace
    // instead of only being shoved to it for a frame
    const maxSpeed = (this.moveSpeed + this.momentum) * (this.grounded ? slopeMul : 0.92) * environmentSpeed;

    // tangential velocity drive (momentum preserving)
    _tmp.copy(this.velocity).addScaledVector(this.up, -this.velocity.dot(this.up));
    if (hold) {
      // the lock bleeds off all drift (radial is untouched: falling still falls)
      _tmp.multiplyScalar(Math.max(0, 1 - dt * 9));
      if (_tmp.lengthSq() < 0.02) _tmp.set(0, 0, 0);
    } else if (wishLen > 0.001) {
      _tgt.copy(_wish).multiplyScalar(maxSpeed);
      const accel = (this.grounded ? CONFIG.player.accel : CONFIG.player.airAccel) * dt;
      _tmp.lerp(_tgt, clamp(accel / Math.max(1, maxSpeed), 0, 1));
    } else if (this.grounded) {
      const sp = _tmp.length();
      const ns = Math.max(0, sp - CONFIG.player.friction * dt);
      if (sp > 0.001) _tmp.multiplyScalar(ns / sp);
    }
    const radial = this.velocity.dot(this.up);
    this.velocity.copy(_tmp).addScaledVector(this.up, radial);

    // dash
    if (!hold && g.input.consumeDash() && this.dashCharges > 0 && this.dashTimer <= 0) {
      this.dashCharges--;
      this.dashTimer = CONFIG.player.dashDuration;
      // Every dash compounds the momentum: the burst is the same, but what the runner SETTLES at
      // afterwards is higher. There is no ceiling — only the ground bleed-off pushes it back down.
      this.momentum += CONFIG.player.dashMomentum;
      _tgt.copy(wishLen > 0.001 ? _wish : this.facing);
      this.velocity.addScaledVector(_tgt, CONFIG.player.dashSpeed);
      const cap = CONFIG.player.dashSpeed + this.moveSpeed + this.momentum;
      if (this.velocity.length() > cap) this.velocity.multiplyScalar(cap / this.velocity.length());
      g.effects.ring(this.position, this.up, 1.1, this.necrotechColor, 0.32, 2.0, 0.55);
      g.effects.dashBurst(this.position, this.up, _tgt, this.necrotechColor);
      this.spawnGhost(0.5, 0.34);
      this.ghostSpawnT = 0.09;
      g.audio.sfx('dash', 0.9);
      // ECHO DECOY (Necromutation): leave a double exactly where the dash STARTED — the impulse
      // above only wrote velocity, so the body has not moved from that spot yet.
      if (this.isLocal && this.mods.decoy > 0) g.abilities.fireEvent(this, 'echo');
    }
    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.024;
        g.effects.trail(_tmp.copy(this.position).addScaledVector(this.up, 0.9), this.necrotechColor, 0.6, 0.3);
      }
      if (this.ghostSpawnT > 0) {
        this.ghostSpawnT -= dt;
        if (this.ghostSpawnT <= 0) this.spawnGhost(0.32, 0.26);
      }
    }
    if (this.dashCharges < this.dashMax) {
      this.dashRechargeT += dt * this.mods.dashRechargeMul;
      if (this.dashRechargeT >= CONFIG.player.dashRecharge) {
        this.dashRechargeT = 0;
        this.dashCharges++;
      }
    } else {
      this.dashRechargeT = 0;
    }
    // Momentum only survives in the air. Running on the ground bleeds it off — proportionally, so
    // it slides away instead of stopping dead — back toward the normal run speed unless the chain
    // is kept alive with another dash or a jump.
    if (this.grounded && this.dashTimer <= 0 && this.momentum > 0) {
      this.momentum *= Math.max(0, 1 - CONFIG.player.dashMomentumDecay * dt);
      if (this.momentum < 0.05) this.momentum = 0;
    }

    // MOLTEN WAKE (Necromutation): a running body leaves burning ground behind it. Pools are spaced
    // by DISTANCE — so the trail is an even line of fire rather than a frame-rate smear — and
    // throttled by TIME, so a dash does not carpet the field. Both gates are tuned against the pool
    // RADIUS (2.2 m): at a full run the time gate sets the spacing (speed x 0.16 s ≈ 2.2 m), so
    // consecutive pools touch and the wake reads as one continuous river instead of dotted patches.
    // (Measured with the old 0.34 s gate: pools landed 4.7 m apart, more than two radii of bare
    // ground between them.)
    if (this.mods.lavaWake > 0 && this.grounded && this.alive && !this.frozen) {
      _wake.copy(this.velocity).addScaledVector(this.up, -this.velocity.dot(this.up));
      const hSpeed = _wake.length();
      this.lavaT -= dt;
      if (hSpeed > 4.5) this.lavaDist += hSpeed * dt;
      if (this.lavaDist >= 1.3 && this.lavaT <= 0) {
        this.lavaDist = 0;
        this.lavaT = 0.16;
        g.abilities.fireEvent(this, 'lavapool');
      }
    } else {
      this.lavaDist = 0;
    }

    // jump (perks can grant extra leaps mid-air)
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    if (this.jumpLock > 0) this.jumpLock -= dt;
    if (!hold && this.jumpLock <= 0 && g.input.consumeJump()) {
      if (this.coyote > 0) {
        this.velocity.addScaledVector(this.up, CONFIG.player.jumpSpeed);
        this.jumpsLeft = this.mods.jumps;
      } else if (this.jumpsLeft > 0) {
        this.jumpsLeft--;
        // mid-air leap: cancel downward momentum first so it feels like a real double jump
        const along = this.velocity.dot(this.up);
        if (along < 0) this.velocity.addScaledVector(this.up, -along);
        this.velocity.addScaledVector(this.up, CONFIG.player.jumpSpeed * 0.92);
        if (this.isLocal) {
          this.game.effects.ring(this.position, this.up, 0.8, 0xc9e8ff, 0.35, 1.4, 0.7);
        }
      } else {
        this.grounded = false;
      }
      this.grounded = false;
      this.coyote = 0;
      this.jumpLock = 0.22;
      g.audio.sfx('jump', 0.8);
      g.effects.burst(this.position, 0xc9b8ee, { count: 7, speed: 5, life: 0.35, size: 0.4, gravity: 14 });
    }

    // spherical gravity
    this.velocity.addScaledVector(this.up, -CONFIG.player.gravity * dt);
    this.integrate(dt);

    // facing: rotates toward auto-attack target, otherwise drifts toward motion
    const target = this.currentTarget();
    if (target) {
      const isEnemy = 'radius' in target;
      const lift = isEnemy ? (target as Enemy).radius * 0.6 : 0.85;
      _tmp.copy(target.position).addScaledVector(target.up, lift).sub(this.position);
      _tmp.addScaledVector(this.up, -_tmp.dot(this.up));
      if (_tmp.lengthSq() > 1e-5) rotateTowards(this.facing, _tmp.normalize(), this.up, 10 * dt);
    } else {
      _tmp.copy(this.velocity).addScaledVector(this.up, -this.velocity.dot(this.up));
      if (_tmp.lengthSq() > 1) rotateTowards(this.facing, _tmp.normalize(), this.up, 2.4 * dt);
    }

    // regeneration
    const sinceDmg = g.now - this.lastDamageAt;
    if (sinceDmg > CONFIG.player.regenDelay && this.hp < this.maxHp) {
      const wasActive = this.regenActive;
      this.regenActive = true;
      this.hp = Math.min(this.maxHp, this.hp + CONFIG.player.regenRate * this.mods.regenMul * dt);
      if (!wasActive) {
        g.audio.sfx('regen', 0.7);
        g.effects.ring(this.position, this.up, 1.0, PALETTE.heal, 0.6, 1.5, 0.4);
      } else if (Math.random() < dt * 5) {
        g.effects.trail(_tmp.copy(this.position).addScaledVector(this.up, 1.2 + Math.random()), PALETTE.heal, 0.35, 0.5);
      }
    } else {
      this.regenActive = false;
    }

    // ---- the colony HEALING PAD: standing in the cone under your fortress's lane crossing mends
    // you and strips every debuff off you. Applied owner-side, exactly like the DoTs — each peer
    // mends its own player and the result rides the next state tick, so nothing has to be networked.
    if (g.bases.healPad(this)) {
      const before = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + CONFIG.base.healRate * this.mods.regenMul * dt);
      this.healAccum += this.hp - before;
      if (this.cleanseDebuffs()) {
        g.effects.ring(this.position, this.up, 1.1, 0x8dffb0, 0.4, 2.0, 0.7);
      }
      this.healNumT -= dt;
      if (this.healNumT <= 0 && this.healAccum > 0.5) {
        this.healNumT = 0.7;
        g.effects.damageNumber(_tmp.copy(this.position).addScaledVector(this.up, 1.9), `+${Math.round(this.healAccum)}`, 0x8dffb0, 1);
        this.healAccum = 0;
      }
    } else {
      this.healAccum = 0;
    }

    // Necrotic Ward recharges once the shield has been out of trouble for a moment
    if (this.shieldMax > 0 && this.shield < this.shieldMax) {
      if (this.shieldRegenT > 0) this.shieldRegenT -= dt;
      else {
        this.shield = Math.min(this.shieldMax, this.shield + CONFIG.player.shieldRegenRate * this.mods.regenMul * dt);
      }
    }

    // combat (a blitz ball cannot shoot or cast — it just runs things over)
    if (!this.blitzing) this.updateAutoAttack(dt);
    this.updateMadmen(dt);
    this.tickSkillCharges(dt);
    this.ultCd = Math.max(0, this.ultCd - dt);
    if (!this.blitzing && !hold) {
      if (g.input.consumeSkill()) g.abilities.castSkill(this);
      if (g.input.consumeUlt()) g.abilities.castUlt(this);
    } else {
      g.input.consumeSkill();
      g.input.consumeUlt();
    }
    if (!hold && g.input.consumeBeacon()) g.towers.tryActivate(this);

    this.tickDots(dt);
    this.tickBuffs(dt);
  }

  /**
   * The Skill's recharge clock plus charge refills. `skillCd` is the PER-CHARGE clock (see the field
   * docs): when it completes, ONE charge returns — and while the pool is still short the clock
   * restarts immediately, so three blinks come back one at a time instead of all at once.
   */
  private tickSkillCharges(dt: number): void {
    this.skillCd = Math.max(0, this.skillCd - dt);
    if (this.skillCd > 0 || this.skillCharges >= this.skillChargeMax) return;
    this.skillCharges++;
    if (this.skillCharges < this.skillChargeMax) this.skillCd = this.skillCdMax;
  }

  /** Burn / toxin ticks. Only the owner of the player runs these. */
  private tickDots(dt: number): void {
    if (this.dots.length === 0) return;    let total = 0;
    for (let i = this.dots.length - 1; i >= 0; i--) {
      const d = this.dots[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.dots.splice(i, 1);
        continue;
      }
      total += d.dps;
    }
    if (total <= 0 || !this.alive) return;
    this.applyDotDamage(total * dt, dt);
  }

  /** DoT damage bypasses the per-hit minimum so a tick of a fraction still stings fairly. */
  private applyDotDamage(amount: number, dt: number): void {
    if (!this.alive || this.isInvulnerable() || amount <= 0) return;
    this.game.cancelRecall(this, 'interrupted');
    let dmg = amount * this.mods.takenMul;
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, dmg);
      this.shield -= soaked;
      dmg -= soaked;
      this.shieldRegenT = CONFIG.player.shieldRegenDelay;
      if (dmg <= 0) return;
    }
    this.hp -= dmg;
    this.lastDamageAt = this.game.now;
    this.regenActive = false;
    this.dotAccum += dmg;
    this.dotNumT -= dt;
    if (this.dotNumT <= 0) {
      this.dotNumT = 0.7;
      this.game.effects.damageNumber(_tmp.copy(this.position).addScaledVector(this.up, 1.7), `${Math.round(this.dotAccum)}`, 0xff9a4d, 0.85);
      this.dotAccum = 0;
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.die();
    }
  }

  private tickBuffs(dt: number): void {
    let changed = false;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      this.buffs[i].t -= dt;
      if (this.buffs[i].t <= 0) {
        this.buffs.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.recompute();
  }

  /**
   * Madmen (WHIPLASH): enemies inside the whip ring feed the ward, but only slowly — the shield RAMPS
   * toward `foes * shieldPerFoe` (capped by the class's own ward) and bleeds away the moment the ring
   * thins out, so a big crowd cannot hand out a full shield instantly.
   */
  private updateMadmen(dt: number): void {
    const per = this.necrotech.stats.shieldPerFoe;
    if (!per || this.shieldMax <= 0) return;
    this.madmenT -= dt;
    if (this.madmenT <= 0) {
      this.madmenT = 0.25;
      const g = this.game;
      const range = this.autoRange + 1.5;
      const list = g.enemies.query(this.position.x, this.position.y, this.position.z, range + 4, _whipList);
      let foes = 0;
      for (const e of list) {
        if (!e.alive) continue;
        const rr = range + e.radius;
        if (e.position.distanceToSquared(this.position) <= rr * rr) foes++;
      }
      this.madmenFoes = foes;
    }
    const want = Math.min(this.shieldMax, this.madmenFoes * per);
    if (this.shield < want) this.shield = Math.min(want, this.shield + 20 * dt);
    else if (this.shield > want) this.shield = Math.max(want, this.shield - 18 * dt);
  }

  /**
   * Spinner: switch the model's own chain whip on for `dur` seconds, scaled so its reach matches the
   * damage ring. The arms are children of the body, so there is no follow logic at all.
   */
  startWhipSpin(dur: number, radius: number): void {
    this.whipSpinT = dur;
    this.whipSpinMax = Math.max(0.01, dur);
    this.whipSpinR = radius;
    // The lash reaches ~3.2 local units, so it is scaled by radius / 3.2 to match the damage ring.
    // That scale is applied in the GROUND PLANE ONLY: the arms carry their own height (chest down to
    // the knees), and a uniform scale multiplied that height too — a wide whirl lifted the whole
    // chain above the player's head. Scaling x/z alone keeps the lash at body level at any radius.
    const s = Math.max(0.4, radius / 3.2);
    this.parts.whipSpin.scale.set(s, 1, s);
    this.parts.whipSpin.visible = true;
  }

  /** Radius of the Spinner whirl while it is running (0 when not spinning) — the shove uses this. */
  get whipSpinRadius(): number {
    return this.whipSpinT > 0 ? this.whipSpinR : 0;
  }

  private updateWhipSpin(dt: number): void {
    const spin = this.parts.whipSpin;
    if (this.whipSpinT <= 0) {
      if (spin.visible) spin.visible = false;
      return;
    }
    this.whipSpinT -= dt;
    spin.visible = this.alive && !this.blitzing && !this.frozen;
    // whirl it: fast, and the other way round from the Scythe's right-to-left stroke
    spin.rotation.y -= dt * 23;
    const t = clamp(this.whipSpinT / this.whipSpinMax, 0, 1);
    this.parts.whipMat.color.setHex(this.necrotechColor);
    this.parts.whipMat.opacity = 0.45 + 0.45 * t;
    if (this.whipSpinT <= 0) {
      spin.visible = false;
      this.whipSpinR = 0;
    }
  }

  private integrate(dt: number): void {
    const g = this.game;
    if (g.envWorld) g.envWorld.obstacles.move(this.position, this.velocity, dt, CONFIG.player.radius, this.grounded && this.jumpLock <= 0 && this.velocity.dot(this.up) <= 2);
    else this.position.addScaledVector(this.velocity, dt);
    _up.copy(this.position).normalize();
    // Safety net (plan §25/§39): a body that escaped the terrain field snaps back to the last
    // real ground BEFORE any support maths reads the corrupted position.
    this.safetyNet();
    // A colony SHIP is a platform that MOVES: whoever is standing on it rides along — rotate the
    // rider by the ship's own turn before the support test below, or the deck slides out from under
    // them a couple of metres a second.
    const deck = g.bases.deckUnder(_up);
    if (deck && deck.dAngle !== 0 && this.grounded
      && this.position.dot(deck.up) - deck.deckRadius > -1.6) {
      this.position.applyAxisAngle(ORBIT_AXIS, deck.dAngle);
      _up.copy(this.position).normalize();
    }
    this.up.copy(_up);
    const terrainHeight = g.planet.meshHeightAtDir(_up.x, _up.y, _up.z);
    const h = Math.max(terrainHeight, g.envWorld?.obstacles.supportRadius(this.position, this.grounded && this.jumpLock <= 0 ? 1.5 : 0.05, CONFIG.player.radius) ?? -Infinity);
    const dist = this.position.length();
    // A floating colony fortress is a support only from ABOVE: over its deck the ground is the deck's
    // own flat plane (exactly the plane the mesh is drawn in, so the feet never sink through it as the
    // platform crosses the hills below), while walking UNDER one leaves the player on the terrain, and
    // rising into a deck from below never snaps anyone up through it.
    const overDeck = deck !== null ? this.position.dot(deck.up) - deck.deckRadius : -Infinity;
    const onDeck = deck !== null && overDeck > -1.6;
    const near = onDeck ? overDeck : dist - h;
    const wasGrounded = this.grounded;
    const canStand = near <= 0.02 && near > -1.6 && (!onDeck || this.velocity.dot(_up) <= 2);

    if (canStand) {
      if (onDeck && deck) this.position.multiplyScalar(deck.deckRadius / Math.max(1, this.position.dot(deck.up)));
      else {
        this.position.copy(_up).multiplyScalar(h);
        this.noteGround();
      }
      const vr = this.velocity.dot(_up);
      if (vr < 0) this.velocity.addScaledVector(_up, -vr);
      this.grounded = true;
      if (!wasGrounded && this.airTime > 0.32) {
        g.audio.sfx('land', 0.6);
        g.effects.burst(this.position, 0xb9a8d8, { count: 8, speed: 5, life: 0.35, size: 0.45, gravity: 16 });
        if (this.isLocal && this.airTime > 0.9) g.effects.shake(0.12);
        // QUAKEFALL (Necromutation): a genuine leap ends in a shockwave, not just a puff of dust.
        // Fired from the OWNING peer, so a client's landing still takes the normal
        // host-authoritative damage route (see AbilitySystem 'quakefall'). A frozen picker never
        // borrows the passive: the arc may LAND while a choice is open (the body keeps flying),
        // but the landing itself deals no damage.
        if (this.isLocal && !this.frozen && this.mods.landShock > 0 && this.airTime > 0.45) {
          g.abilities.fireEvent(this, 'quakefall');
        }
      }
      this.jumpsLeft = this.mods.jumps;   // double jump refills on landing
      this.airTime = 0;
    } else if (this.grounded && this.jumpLock <= 0 && near < 1.5 && near > -1.6 && this.velocity.dot(_up) <= 2) {
      // stick to the surface (or the deck) while running across bumps
      if (onDeck && deck) this.position.multiplyScalar(deck.deckRadius / Math.max(1, this.position.dot(deck.up)));
      else {
        this.position.copy(_up).multiplyScalar(h);
        this.noteGround();
      }
      const vr = this.velocity.dot(_up);
      if (vr < 0) this.velocity.addScaledVector(_up, -vr);
      this.grounded = true;
      this.airTime = 0;
    } else {
      this.grounded = false;
      this.airTime += dt;
    }
  }

  /**
   * Plan §25/§39 safety net: the only two ways a body may leave the terrain field are (a) a
   * position outside the generator's clamp band (bad query, NaN, teleport mismatch) or (b) a
   * sustained fall that never lands (fall-through somewhere in the visual/collision seam). Both
   * restore the last position the body legitimately stood on — never an infinite fall.
   */
  private safetyNet(): void {
    const g = this.game;
    const floorRadius = g.planet.radius - 49.5; // generator clamp is radius − 48; 1.5 m margin
    const len = this.position.length();
    const sustainedFall = !this.grounded && this.airTime > 6 && this.velocity.dot(_up) < -0.5;
    if (Number.isFinite(len) && len >= floorRadius && !sustainedFall) return;
    if (this.hasValidGround) {
      this.position.copy(this.lastValidGroundPosition);
      this.velocity.set(0, 0, 0);
      _up.copy(this.position).normalize();
      this.up.copy(_up);
      this.grounded = true;
      this.airTime = 0;
      return;
    }
    // No ground reference yet (first frames after spawn): snap to the analytic surface.
    const h = g.planet.heightAtDir(_up.x, _up.y, _up.z);
    this.position.copy(_up).multiplyScalar(h + 0.4);
    this.velocity.set(0, 0, 0);
  }

  /** Remember the last terrain (never deck) position the body stood on (plan §25). */
  private noteGround(): void {
    this.lastValidGroundPosition.copy(this.position);
    this.hasValidGround = true;
  }

  // ------------------------------------------------------------ combat

  /**
   * How many bodies ONE auto-attack event engages at once: it follows the level EXACTLY — level 1
   * targets one enemy, level 2 targets two, level 3 targets three, and so on. Every target takes a
   * full, unmodified basic attack (see `selectTargets` / `updateAutoAttack`); only perks and
   * abilities add projectiles on top of that, per target. The whip is exempt: its lash is a cone
   * that already cuts everything in the front arc.
   */
  get autoTargets(): number {
    return this.level;
  }

  currentTarget(): (Enemy | Player) | null {
    if (this.targetIsPlayer) {
      const p = this.game.players.get(this.targetKey);
      if (p && p.alive) return p;
      return null;
    }
    const e = this.game.enemies.byId(this.targetId);
    return e && e.alive ? e : null;
  }

  /**
   * The reach footprint the range ring is drawing right now, measured against the SAME surface the
   * ring lands on: the fortress DECK while standing on one (a ring drawn 30 m below on the terrain
   * is a ring nobody sees), the terrain otherwise. `Game.updateIndicators` draws its circle from
   * this result and the auto-attack clamps to it, so the marker is exactly what can be shot.
   * KEEP IN SYNC with the deck/surface choice in `Game.updateIndicators`.
   */
  ringFootprint(range = this.autoRange): { reach: boolean; theta: number } {
    const g = this.game;
    const deck = g.bases.deckUnder(this.up);
    const overDeck = deck ? this.position.dot(deck.up) - deck.deckRadius : -Infinity;
    const onDeck = deck !== null && overDeck > -1.6;
    const surfR = onDeck && deck ? deck.deckRadius : g.planet.heightAtDir(this.up.x, this.up.y, this.up.z);
    const h = Math.max(0, onDeck ? overDeck : this.position.length() - surfR);
    return autoFootprint(surfR, h, range);
  }

  /**
   * The bodies ONE auto-attack event engages, nearest-first. How many is decided by `autoTargets`:
   * the count grows with the player's level, so a veteran fires several basic attacks into several
   * different enemies at once. Bosses keep the small priority nudge and hostile survivors the small
   * penalty the single-target pick used (enemy wins a near tie; a survivor still enters the volley).
   * The RING RULE applies to every one of them — only targets inside the drawn range ring qualify.
   */
  private selectTargets(): (Enemy | Player)[] {
    const out = _targets;
    out.length = 0;
    _targetScores.length = 0;
    const g = this.game;
    const r = this.autoRange;
    const r2 = r * r;
    // RING RULE: a target has to sit INSIDE the drawn range ring. That circle pulls in while the
    // player is airborne, and the old 3D-distance-only test kept shooting the whole sphere — bodies
    // beyond the ring died with nothing visibly shooting them. High in a jump the ring is gone
    // entirely; then nothing is in reach and the auto-attack simply holds fire.
    const foot = this.ringFootprint(r);
    if (!foot.reach) return out;
    const cosFoot = Math.cos(foot.theta);
    const list = g.enemies.query(this.position.x, this.position.y, this.position.z, r + 3, _tmpEnemies);
    for (const e of list) {
      if (!e.alive) continue;
      const d2 = e.position.distanceToSquared(this.position);
      if (d2 > r2) continue;
      if (_tmp2.copy(e.position).normalize().dot(this.up) < cosFoot) continue;
      out.push(e);
      _targetScores.push(d2 * (e.isBoss ? 0.8 : 1));
    }
    for (const p of g.players.values()) {
      if (p === this || !p.alive || p.colony === this.colony) continue;
      const d2 = p.position.distanceToSquared(this.position);
      if (d2 > r2) continue;
      if (_tmp2.copy(p.position).normalize().dot(this.up) < cosFoot) continue;
      out.push(p);
      _targetScores.push(d2 / 1.15);
    }
    // Partial selection sort down to the level's target count — bounded by `autoTargets`, so a
    // dense swarm costs a handful of swaps, not a sort of the whole list.
    const limit = Math.min(this.autoTargets, out.length);
    for (let i = 0; i < limit; i++) {
      let best = i;
      for (let j = i + 1; j < out.length; j++) if (_targetScores[j] < _targetScores[best]) best = j;
      if (best !== i) {
        const t = out[i]; out[i] = out[best]; out[best] = t;
        const s = _targetScores[i]; _targetScores[i] = _targetScores[best]; _targetScores[best] = s;
      }
    }
    out.length = limit;
    return out;
  }

  private updateAutoAttack(dt: number): void {
    const g = this.game;
    // Belt and braces: `updateLocal` already turns dead players and players locked in a menu away
    // before it gets here, and this is the last line of defence — no state, however it was reached,
    // may keep a corpse or a frozen picker shooting.
    if (!this.alive || this.frozen) return;
    this.attackCd -= dt;
    const targets = this.selectTargets();
    const target = targets[0] ?? null;
    if (target && 'radius' in target) {
      this.targetIsPlayer = false;
      this.targetId = (target as Enemy).id;
      this.targetKey = '';
    } else if (target) {
      this.targetIsPlayer = true;
      this.targetKey = (target as Player).id;
      this.targetId = 0;
    } else {
      this.targetIsPlayer = false;
      this.targetId = 0;
      this.targetKey = '';
    }
    if (!target || this.attackCd > 0) return;

    const st = this.necrotech.stats;
    this.attackCd = 1 / this.autoRate;
    const isEnemy = 'radius' in target;
    const tPos = target.position;
    const tUp = target.up;
    const tRadius = isEnemy ? (target as Enemy).radius : 0.8;
    _tmp.copy(tPos).addScaledVector(tUp, tRadius * 0.6).sub(_muzzle.copy(this.position).addScaledVector(this.up, 1.15)).normalize();

    const crit = Math.random() < this.mods.crit;
    const execMult = isEnemy && (target as Enemy).hp < (target as Enemy).maxHp * 0.5 ? this.mods.execMul : 1;
    const dmg = this.autoDamage * (crit ? 2 : 1) * execMult;

    // ---- WHIP: no projectile at all — every strike is one or more lashes swept across the front.
    // The lash COUNT follows the same rule the projectile styles follow for shots: the engaged
    // target list (level-scaled, see `autoTargets`) decides how many bodies one swing reaches, and
    // every extra "projectile" from a perk adds one MORE lash on top (user ask 2026-09-30). A
    // veteran cracks at the engaged crowd at once; +1 projectile perk = +1 visible slash.
    if (st.style === 'whip') {
      const halfAngle = st.whipArc ?? 0.7;
      const arc = halfAngle * 2;
      const range = this.autoRange;
      const lashCount = Math.min(MAX_LASHES, targets.length + this.mods.projCount);
      for (let j = 0; j < lashCount; j++) {
        const t = targets[j % targets.length];
        const tIsEnemyJ = 'radius' in t;
        const d = _whipDirs[j];
        d.copy(t.position).addScaledVector(t.up, tIsEnemyJ ? (t as Enemy).radius * 0.5 : 0.9)
          .sub(_muzzle.copy(this.position).addScaledVector(this.up, 1.1)).normalize();
        if (j >= targets.length) {
          // an extra-perk lash: its target's cut again, flared to the side so it reads as its own
          const wrap = Math.floor(j / targets.length);
          d.applyAxisAngle(this.up, (j % 2 === 0 ? 1 : -1) * 0.35 * wrap);
        }
      }
      // a whip CRACK: one flat crescent of light per lash (not the layered sweep the Scythe Arc and
      // Spinner use — those are different moves and must look different). The cut rides at CHEST
      // height, never on the ground: laid at ankle height the ribbon was swallowed by the first
      // terrain bump it crossed and the basic attack read as nothing at all.
      for (let j = 0; j < lashCount; j++) {
        g.effects.slashArc(this.position, this.up, _whipDirs[j], range, arc, st.color, {
          dur: 0.18, spin: 1, inner: 0.55, lift: 1.15,
        });
      }
      if (this.isLocal) g.audio.sfx('hit', 0.4);
      // the host applies the lashes itself; a client hands the host its roll AND the exact spread
      // it drew, so every peer lands the same cuts in the same places
      const dirs: number[] = [];
      for (let j = 0; j < lashCount; j++) {
        dirs.push(
          Math.round(_whipDirs[j].x * 1000) / 1000,
          Math.round(_whipDirs[j].y * 1000) / 1000,
          Math.round(_whipDirs[j].z * 1000) / 1000
        );
      }
      if (g.isHost) this.whipHits(_whipDirs, lashCount, halfAngle, range, dmg, crit);
      else g.abilities.fireEvent(this, 'whip', 0, dmg, arc, dirs);
      // and every OTHER peer draws the same crescents: a remote whip used to cut bodies with
      // nothing visibly swinging (bullets had the same hole — see `mirrorShot`)
      if (this.isLocal) {
        for (let j = 0; j < lashCount; j++) g.mirrorWhip(this.id, _whipDirs[j], arc, st.color);
      }
      return;
    }

    // Berserker / Overcharge: extra rounds, piercing and a burning ring (see Game.updateIndicators)
    const berserk = this.hasBuff('Berserker') > 0 || this.hasBuff('Overcharge') > 0;
    const count = (st.style === 'spread' ? st.count : 1) + this.mods.projCount;
    // fused loadouts combine their parents' auto-attack behaviour (chain / pierce / knockback)
    const nd = this.necrotech;
    // a fusion writes BOTH stats.chain and autoChain, so take the greater rather than summing
    const pierce = Math.max(st.style === 'pierce' ? 2 : 0, nd.autoPierce ?? 0) + (berserk ? 1 : 0);
    const chain = Math.min(6, Math.max(st.chain ?? 0, nd.autoChain ?? 0) + this.mods.chainAdd);
    // each weapon shape gets its own feel: a flamethrower sprays, a laser is a needle
    const spread = st.style === 'flame' ? 0.17 : st.style === 'spread' ? 0.1 : count > 1 ? 0.06 : 0.015;
    const radius =
      st.style === 'heavy' ? 0.62 :
      st.style === 'laser' ? 0.24 :
      st.style === 'fist' ? 0.5 :
      st.style === 'shard' ? 0.34 :
      st.style === 'flame' ? 0.3 : 0.4;
    const life = st.life ?? 2.4;
    // ONE volley per engaged target: `targets` is the level-scaled list (see `autoTargets`), its
    // primary first. Every body gets its own direction, damage roll and homing id, so four
    // simultaneous attacks really are four separate attacks — not one shot spread thin.
    for (const t of targets) {
      const tIsEnemy = 'radius' in t;
      const tRadius = tIsEnemy ? (t as Enemy).radius : 0.8;
      _tmp.copy(t.position).addScaledVector(t.up, tRadius * 0.6).sub(_muzzle.copy(this.position).addScaledVector(this.up, 1.15)).normalize();
      const tCrit = Math.random() < this.mods.crit;
      const tExec = tIsEnemy && (t as Enemy).hp < (t as Enemy).maxHp * 0.5 ? this.mods.execMul : 1;
      const tDmg = this.autoDamage * (tCrit ? 2 : 1) * tExec;
      for (let i = 0; i < count; i++) {
        if (count > 1) {
          _tmp2.copy(_tmp).applyAxisAngle(this.up, (i - (count - 1) / 2) * spread * 2);
        } else {
          _tmp2.copy(_tmp).applyAxisAngle(this.up, (Math.random() - 0.5) * spread);
        }
        const from = _muzzle.copy(this.position).addScaledVector(this.up, 1.15).addScaledVector(_tmp2, 0.7);
        const shotSpeed = this.projSpeed * (0.94 + Math.random() * 0.12);
        g.combat.spawn({
          pos: from,
          dir: _tmp2,
          speed: shotSpeed,
          damage: tDmg,
          ownerId: this.id,
          colony: this.colony,
          color: st.color,
          pierce,
          chain,
          chainDecay: st.chainDecay ?? 0.7,
          elong: st.elong ?? 1,
          ember: st.style === 'flame',
          knock: nd.autoKnock ?? 0,
          crit: tCrit,
          radius,
          size: st.style === 'laser' ? 0.85 : 1,
          life,
          targetId: tIsEnemy ? (t as Enemy).id : 0,
          homing: st.style === 'heavy' ? 1.2 : st.style === 'fist' ? 0.5 : 0,
          isSkill: false,
        });
        // Every OTHER peer draws this round too (visual-only, no collisions). Auto-attacks used to
        // be simulated per-peer only, so an enemy survivor could be hosed by rounds that existed
        // on the shooter's screen alone.
        if (this.isLocal) {
          g.mirrorShot(this.id, from, _tmp2, shotSpeed, st.color, {
            radius, elong: st.elong ?? 1, ember: st.style === 'flame',
            size: st.style === 'laser' ? 0.85 : 1, life,
          });
        }
        if (st.style === 'laser') {
          // a phase laser leaves a full-length tracer, so the beam is visible for one frame
          _tmp3.copy(from).addScaledVector(_tmp2, this.autoRange * 0.95);
          g.effects.tracer(from, _tmp3, st.color, 0.07);
        }
      }
    }
    if (this.isLocal) g.audio.sfx('shoot', 0.55);
  }

  /**
   * Everything caught in the swing's LASHES: one cone per lash direction, a body hit at most once
   * per swing however many cones overlap it. Only the host applies the damage, so the lash is
   * broadcast like any other auto-attack.
   *
   * PLAYERS are cut by the same swing — the lash is the weapon's whole hit volume, so skipping them
   * made every whip class (WHIPLASH and any fusion carrying its arc) unable to touch another
   * survivor at all, while its enemies-only cone still mowed down Necrophages.
   */
  private whipHits(dirs: THREE.Vector3[], dirCount: number, halfAngle: number, range: number, dmg: number, crit: boolean): void {
    const g = this.game;
    if (!g.isHost || !this.alive || this.frozen) return;
    // The lashes obey the range ring like everything else: the cone test measures sphere distance,
    // so an airborne lash could cut bodies the drawn footprint no longer covered.
    const foot = this.ringFootprint(range);
    if (!foot.reach) return;
    const cosFoot = Math.cos(foot.theta);
    const cos = Math.cos(halfAngle);
    const list = g.enemies.query(this.position.x, this.position.y, this.position.z, range + 4, _whipList);
    for (const e of list) {
      if (!e.alive) continue;
      if (_tmp3.copy(e.position).normalize().dot(this.up) < cosFoot) continue;
      _tmp2.copy(e.position).addScaledVector(e.up, e.radius * 0.5).sub(_muzzle.copy(this.position).addScaledVector(this.up, 1.1));
      const dist = _tmp2.length();
      if (dist > range + e.radius) continue;
      // each lash cuts its own cone; overlapping cones still land ONE hit on a body per swing
      let hit = dist <= 1e-3;
      if (!hit) {
        _tmp2.multiplyScalar(1 / dist);
        for (let j = 0; j < dirCount && !hit; j++) hit = _tmp2.dot(dirs[j]) >= cos;
      }
      if (hit) g.hitEnemy(e, dmg, this.id, 'auto', crit);
    }
    for (const pl of g.players.values()) {
      if (pl === this || !pl.alive) continue;
      if (pl.colony === this.colony) continue; // no friendly fire, same rule as every other attack
      if (_tmp3.copy(pl.position).normalize().dot(this.up) < cosFoot) continue;
      _tmp2.copy(pl.position).addScaledVector(pl.up, 0.9).sub(_muzzle.copy(this.position).addScaledVector(this.up, 1.1));
      const dist = _tmp2.length();
      if (dist > range + 1.3) continue;
      let hit = dist <= 1e-3;
      if (!hit) {
        _tmp2.multiplyScalar(1 / dist);
        for (let j = 0; j < dirCount && !hit; j++) hit = _tmp2.dot(dirs[j]) >= cos;
      }
      if (!hit) continue;
      // Host authority: hitPlayer applies it here AND relays the pdmg every peer sees.
      g.hitPlayer(pl, dmg, this.id, 'auto');
    }
  }

  // ------------------------------------------------------------ netcode

  toNet(now: number): PlayerNet {
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    // A remote player is forwarded from the raw pose it last reported, never from the interpolated
    // copy this machine draws: relaying our playout-delayed view would stack this machine's buffer
    // on top of everyone else's and resample the motion a second time. `pt` is when that pose was
    // true on *our* clock, so the next hop can keep interpolating on the same even timeline.
    const forwarded = !this.isLocal && this.netLatest ? this.netLatest : null;
    const src: NetPose = forwarded ?? this.pose();
    return {
      id: this.id,
      // Not rounded: this is aligned against the receiver's clock, where a centimetre of a second
      // is already a visible step in the interpolation.
      pt: forwarded ? this.netLatestT : now,
      x: r2(src.x), y: r2(src.y), z: r2(src.z),
      fx: r2(src.fx), fy: r2(src.fy), fz: r2(src.fz),
      gnd: src.gnd,
      vsp: src.vsp === undefined ? undefined : r2(src.vsp),
      hp: Math.round(this.hp),
      col: this.colony,
      alive: this.alive ? 1 : 0,
      lvl: this.level,
      ntn: this.necrotechName,
      ntc: this.necrotechColor,
      mut: this.mutated,
      bl: this.blitzT > 0 ? 1 : 0,
      xp: Math.round(this.xp),
      xpn: this.xpNeed,
      frz: this.frozen ? 1 : 0,
      acc: selectionToWire(this.accessorySelection),
      // defensive state the host's copy needs (see PlayerNet): remaining seconds, not deadlines
      sh: Math.round(this.shield),
      shm: Math.round(this.shieldMax),
      inv: Math.round(Math.max(0, this.invulnUntil - this.game.now) * 20) / 20,
      dsh: Math.round(Math.max(0, this.dashTimer) * 20) / 20,
    };
  }

  /** Where this player currently is, as a plain pose the net layer can copy. */
  private pose(): NetPose {
    return {
      x: this.position.x, y: this.position.y, z: this.position.z,
      fx: this.facing.x, fy: this.facing.y, fz: this.facing.z,
      gnd: this.grounded ? 1 : 0,
      vsp: this.velocity.dot(this.up),
    };
  }

  /**
   * Drop everything the stream told us about this player. Called when the sender's clock changes
   * identity — the host role moved to another machine and its timestamps have nothing to do with
   * the ones we were interpolating on.
   */
  resetNet(): void {
    this.netSamples.length = 0;
    this.netLags.length = 0;
    this.netVel.set(0, 0, 0);
    this.netLatest = null;
    this.netLatestT = 0;
    this.netDelay = CONFIG.net.minDelay;
  }

  /** `poseTime` is when this pose was true, already translated onto the local clock. */
  applyNet(n: PlayerNet, poseTime = nowSec()): void {
    // the peer that owns a player decides when a Blitz starts; everyone else just mirrors the ball
    if (!this.isLocal && this.blitzT <= 0 && n.bl) this.blitzT = 0.25;
    else if (!this.isLocal && !n.bl) this.blitzT = 0;

    // Only remote players are driven by the stream — the local one is simulated here, so nothing
    // in a snapshot is allowed to touch its samples or its velocity.
    if (!this.isLocal) {
      const arrival = nowSec();
      const pose: NetSample = { t: poseTime, x: n.x, y: n.y, z: n.z, fx: n.fx, fy: n.fy, fz: n.fz, gnd: n.gnd, vsp: n.vsp };
      const samples = this.netSamples;
      const newest = samples.length > 0 ? samples[samples.length - 1] : null;
      // The stream restarted — a sender whose tab was frozen, or a host migration that swapped the
      // clock underneath us: the new timeline has nothing to do with the old one, so start over
      // instead of interpolating across the gap.
      if (newest && Math.abs(pose.t - newest.t) > CONFIG.net.resync) {
        samples.length = 0;
        this.netLags.length = 0;
        this.netVel.set(0, 0, 0);
        this.netLatestT = 0;
      }
      const last = samples.length > 0 ? samples[samples.length - 1] : null;
      // A respawn (or a blink) is a jump, not movement: dropping the old samples keeps it from
      // being smeared back across the interpolation window and dragging the player off the
      // spawn point.
      if (last && Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z) > CONFIG.net.teleport) {
        samples.length = 0;
        this.netVel.set(0, 0, 0);
      }
      if (!samples.length || pose.t >= this.netLatestT) {
        // New information: how late did it show up? The spread of these readings is how much buffer
        // the connection needs on top of the base delay.
        this.netLags.push({ at: arrival, lag: arrival - pose.t });
        while (this.netLags.length > 1 && arrival - this.netLags[0].at > 3) this.netLags.shift();
      }
      // Keep the buffer ordered. A packet can turn up behind one we already have (a retransmit, or
      // a step of the clock estimate); collapsing it onto the newest pose would make the player
      // lunge, so it goes back where it belongs on the timeline.
      let at = samples.length;
      while (at > 0 && samples[at - 1].t > pose.t) at--;
      samples.splice(at, 0, pose);
      // Keep a little more history than the buffer can ever ask for.
      const oldest = arrival - (CONFIG.net.maxDelay + 0.35);
      while (samples.length > 3 && samples[0].t < oldest) samples.shift();
      if (pose.t >= this.netLatestT) {
        this.netLatest = { x: pose.x, y: pose.y, z: pose.z, fx: pose.fx, fy: pose.fy, fz: pose.fz, gnd: pose.gnd, vsp: pose.vsp };
        this.netLatestT = pose.t;
      }
    }

    // A death the HOST applied is final while its respawn clock runs: pose packets that were
    // already in flight when the victim learned about it must not stand the corpse back up and
    // refill its health (that WAS the "killed player keeps walking around regenerating" report).
    // `spawnAt` — a real respawn — is the only thing that clears this state.
    const wasAlive = this.alive;
    const holdCorpse = !this.isLocal && !this.alive && this.respawnTimer > 0;
    // The host says WE are down and we never felt it (a race, or a shield/iframe difference):
    // take the death properly — overlay, respawn clock and all — instead of a silent state flip.
    if (this.isLocal && this.alive && n.alive === 0) {
      this.hp = 0;
      this.die();
    }
    if (!holdCorpse) {
      this.hp = n.hp;
      this.alive = n.alive === 1;
      if (!this.isLocal) {
        // Defensive state a client owns but the host needs to make the same call with: without it
        // a shielded or dashing client survived locally while the host's copy died.
        if (typeof n.sh === 'number') this.shield = n.sh;
        if (typeof n.shm === 'number') this.shieldMax = n.shm;
        if (typeof n.inv === 'number') this.invulnUntil = this.game.now + n.inv;
        if (typeof n.dsh === 'number') this.dashTimer = n.dsh;
      }
    }
    if (!this.isLocal && n.col !== this.colony && COLONIES[n.col]) this.setColony(n.col);
    else this.colony = n.col;
    // The LOCAL player's growth is owned LOCALLY. A snapshot computed a moment earlier must never
    // roll it back: a rollback re-crosses the XP threshold and fires ANOTHER level-up, which
    // reopened the (Necro)mutation picker and toggled the mutation headline in a loop — the
    // "mutation UI flickers appear/disappear" report. Remote copies take the host's values
    // verbatim; our own only ever move forward (gainXp / absorbNecrotech), and resets go through
    // the explicit spawn/reset paths instead of the wire.
    if (!this.isLocal) {
      this.level = n.lvl;
      this.necrotechName = n.ntn;
      this.necrotechColor = n.ntc;
      this.mutated = n.mut;
      if (typeof n.xp === 'number') this.xp = n.xp;
      if (typeof n.xpn === 'number' && n.xpn > 0) this.xpNeed = n.xpn;
    }
    // Only remote players take their frozen state from the network: the local player owns theirs
    // (and reports it upward) so a menu can never be cancelled by a stale snapshot.
    if (!this.isLocal) this.frozen = n.frz === 1;
    // Accessories ride the stream too (a tiny "h,b,p" string). Comparing the wire form first keeps
    // the rig's rebuild a true no-op on every tick but the one that changed.
    if (!this.isLocal && typeof n.acc === 'string' && n.acc !== this.accKey) {
      const sel = selectionFromWire(n.acc);
      if (sel) {
        this.accKey = n.acc;
        this.setAccessories(sel);
      }
    }
    // a remote body that just went down becomes a corpse here too (our copy only needs the pose)
    if (!this.isLocal && wasAlive && !this.alive) this.beginCorpse(null);
  }

  private updateNet(dt: number): void {
    const n = this.netSamples.length;
    if (n === 0) return;
    const rt = nowSec() - this.netDelay;

    // ---- pick the pair of samples the render clock sits between
    let a: NetSample | null = null;
    let b: NetSample | null = null;
    for (let i = 0; i < n - 1; i++) {
      if (this.netSamples[i].t <= rt && this.netSamples[i + 1].t >= rt) {
        a = this.netSamples[i];
        b = this.netSamples[i + 1];
        break;
      }
    }
    const last = this.netSamples[n - 1];
    const starved = rt > last.t;

    if (a && b) {
      const span = Math.max(0.0001, b.t - a.t);
      const f = clamp((rt - a.t) / span, 0, 1);
      this.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
      _tmp.set(a.fx + (b.fx - a.fx) * f, a.fy + (b.fy - a.fy) * f, a.fz + (b.fz - a.fz) * f);
    } else {
      // Before the first sample (a fresh spawn or a teleport) hold the newest pose; past it, the
      // packets are late, so coast along the last known velocity instead of freezing on the spot
      // and snapping when the next one lands — that stall-and-jump is what reads as jitter.
      const over = clamp(rt - last.t, 0, CONFIG.net.extrapolate);
      // Fade the coast out, so a player that really vanished glides to a stop instead of running on.
      const decay = 1 - (over / CONFIG.net.extrapolate) * 0.45;
      this.position.set(
        last.x + this.netVel.x * over * decay,
        last.y + this.netVel.y * over * decay,
        last.z + this.netVel.z * over * decay
      );
      _tmp.set(last.fx, last.fy, last.fz);
    }
    _up.copy(this.position).normalize();
    this.up.copy(_up);
    // project facing into the tangent plane
    _tmp.addScaledVector(this.up, -_tmp.dot(this.up));
    if (_tmp.lengthSq() > 1e-5) this.facing.copy(_tmp.normalize());

    // ---- smoothed velocity: averaged over a window rather than taken from the last two packets,
    // so one late or bunched packet cannot spike the animation (or the coast) for a frame.
    if (a) {
      const from = this.sampleBefore(rt - CONFIG.net.velWindow) ?? this.netSamples[0];
      const span = rt - from.t;
      if (span > 0.02) {
        _tmp2.set((this.position.x - from.x) / span, (this.position.y - from.y) / span, (this.position.z - from.z) / span);
        const speed = _tmp2.length();
        if (speed > CONFIG.net.velCap) _tmp2.multiplyScalar(CONFIG.net.velCap / speed);
        this.netVel.lerp(_tmp2, clamp(dt * CONFIG.net.velSmooth, 0, 1));
      }
    }
    this.velocity.copy(this.netVel);
    const motion = a ?? last;
    this.grounded = motion.gnd === undefined
      ? this.position.length() - this.game.planet.heightAt(this.up) < 0.12
      : motion.gnd === 1;
    this.remoteAnimVertical = motion.vsp ?? this.velocity.dot(this.up);

    // ---- adapt the playout buffer: it has to be at least the base delay plus however unevenly
    // this stream arrives. A dry buffer is an emergency (grow now), otherwise creep back toward
    // what the connection actually needs so a bad spell does not cost latency forever.
    let lo = Infinity;
    let hi = 0;
    for (const s of this.netLags) {
      if (s.lag < lo) lo = s.lag;
      if (s.lag > hi) hi = s.lag;
    }
    const needed = Math.min(
      CONFIG.net.maxDelay,
      Math.max(CONFIG.net.minDelay, CONFIG.net.minDelay + (hi - lo) * CONFIG.net.jitterMul)
    );
    if (starved) this.netDelay = Math.min(CONFIG.net.maxDelay, Math.max(this.netDelay + dt, needed));
    else this.netDelay += (needed - this.netDelay) * clamp(dt * 0.7, 0, 1);

    if (this.alive) this.model.visible = true;
  }

  /** Newest sample at or before `t` (null when the buffer does not reach back that far). */
  private sampleBefore(t: number): NetSample | null {
    for (let i = this.netSamples.length - 1; i >= 0; i--) {
      if (this.netSamples[i].t <= t) return this.netSamples[i];
    }
    return null;
  }

  // ------------------------------------------------------------ animation

  private animate(dt: number): void {
    const p = this.parts;
    if (this.blitzing) {
      // the ball replaces the body while a Blitz is running
      this.model.visible = false;
      this.accessories.petCtl?.setVisible(false);
      return;
    }
    if (!this.alive) {
      // CORPSE: the body stays on the field, lying along `corpseFacing` (feet → head) with a
      // little roll while its momentum lasts. Deliberately NOT hidden and NOT respawned early —
      // the respawn clock is the only way back up, and a dead body has no health to regain.
      orientToSurface(this.model, this.position, this.up, this.corpseFacing);
      this.model.rotateX(-Math.PI / 2);
      const sp = this.corpseV.length();
      if (sp > 0.25) this.model.rotateZ(Math.sin(this.game.clock * 9) * Math.min(0.18, sp * 0.05));
      this.model.position.addScaledVector(this.corpseFacing, 0.82).addScaledVector(this.up, 0.26);
      this.model.visible = true;
      this.accessories.petCtl?.setVisible(false);
      // none of the LIVE fx may linger on a corpse: invuln rings, the ward bubble, the aura pool
      this.updateAura(dt);
      p.invuln.visible = false;
      p.ringFx.visible = false;
      p.shieldBubble.visible = false;
      return;
    }
    orientToSurface(this.model, this.position, this.up, this.facing);
    this.model.visible = true;

    const hSpeed = Math.sqrt(Math.max(0, this.velocity.lengthSq() - Math.pow(this.velocity.dot(this.up), 2)));
    _r.crossVectors(this.up, this.facing).normalize();
    p.rig.update(dt, {
      speed: hSpeed,
      verticalSpeed: this.isLocal ? this.velocity.dot(this.up) : this.remoteAnimVertical,
      grounded: this.grounded,
      forward: hSpeed > 0.1 ? clamp(this.velocity.dot(this.facing) / hSpeed, -1, 1) : 1,
      strafe: hSpeed > 0.1 ? clamp(this.velocity.dot(_r) / hSpeed, -1, 1) : 0,
      frozen: this.frozen || this.recallHold,
    });

    const inv = this.isInvulnerable();
    p.invuln.visible = inv && !this.blitzing;
    p.ringFx.visible = inv && !this.blitzing;
    if (inv) {
      p.ringFx.rotation.z += dt * 3.4;
      const pulse = 0.5 + Math.sin(this.game.clock * 6) * 0.25;
      (p.invuln.material as THREE.MeshBasicMaterial).opacity = 0.12 + pulse * 0.18;
      (p.ringFx.material as THREE.MeshBasicMaterial).opacity = 0.35 + pulse * 0.4;
    }

    // Necrotic Ward bubble + the Necromutation aura. The aura is a rising mote stream, never a
    // bubble, so it can never be mistaken for a shield.
    this.updateAura(dt);
    this.updateWhipSpin(dt);
    const bubble = p.shieldBubble;
    const shieldOn = this.shield > 0;
    bubble.visible = shieldOn && !this.blitzing;
    if (shieldOn) {
      const frac = clamp(this.shield / Math.max(1, this.shieldMax), 0, 1);
      const mat = bubble.material as unknown as { uOpacity: { value: number }; uColor: { value: THREE.Color } };
      const pulse = 0.5 + 0.5 * Math.sin(this.game.clock * 3.4);
      mat.uOpacity.value = (0.1 + frac * 0.3) * (0.85 + pulse * 0.15);
      mat.uColor.value.setHex(0x7fe0ff);
      bubble.scale.setScalar(1 + pulse * 0.03);
    }

    // team colour accent follows necrotech tint lightly
    p.muzzle.visible = this.isLocal;
    this.updateAccessories(dt, hSpeed);
  }

  /**
   * The accessory layer: hat + backpack animation, and the pet follower. Skipped while the body is
   * hidden (death, Blitz) and — for remote players — once they are off the camera's horizon, where
   * a steering pet earns nobody anything. `hSpeed` lets the jetpack and the banner react to a run.
   */
  private updateAccessories(dt: number, hSpeed: number): void {
    this.accessories.tick(this.game.clock, dt, hSpeed);
    const pet = this.accessories.petCtl;
    if (!pet) return;
    pet.setVisible(true);
    if (!this.isLocal && this.game.cam.camera.position.distanceToSquared(this.position) > 120 * 120) return;
    pet.update(dt, this.position, this.up, this.game.clock, this.petTerrain);
  }

  /**
   * Necromutation aura. Nothing here flies upward fast enough to read as flame:
   *   • a flat pool of colony light under the feet, breathing with rank;
   *   • soul-dust motes that hang around the body and slowly drift;
   *   • a wake of the same motes left behind while running — the trail is the part that sells it;
   *   • RANK PARADE: level 10 orbits ONE spark, level 15 orbits TWO, and level 20 keeps the pair,
   *     adds ground shockwaves, a rare shaft of light and a crown above the head.
   * Emission is throttled and gated to players the local camera can actually see, so a 15-player
   * match never floods the particle budget.
   */
  private updateAura(dt: number): void {
    const tier = this.level >= 20 ? 3 : this.level >= 15 ? 2 : this.level >= 10 ? 1 : 0;
    const glow = this.parts.auraGlow;
    const glowMat = this.parts.auraGlowMat;
    const crown = this.parts.auraCrown;
    if (tier === 0 || !this.alive || this.blitzing) {
      this.auraT = 0;
      this.auraRingT = 0;
      this.auraBeamT = 0;
      glow.visible = false;
      crown.visible = false;
      return;
    }
    const g = this.game;
    const local = g.localPlayer;
    const far = local && this.position.distanceToSquared(local.position) > 60 * 60;
    if (far) {
      glow.visible = false;
      crown.visible = false;
      return;
    }
    const col = COLONIES[this.colony]?.color ?? 0xffffff;
    const t = g.clock;
    // motes lean white so even a furnace-coloured colony reads as glowing dust, not fire
    const mote = this.auraTint.setHex(col).lerp(_white, 0.38).getHex();

    // ---- the pool of light: always on, breathing, wider and brighter with rank
    glow.visible = true;
    const base = tier === 3 ? 2.1 : tier === 2 ? 1.75 : 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(t * (tier >= 3 ? 2.6 : 1.7));
    glowMat.color.setHex(col);
    glowMat.opacity = (tier >= 3 ? 0.3 : tier === 2 ? 0.22 : 0.17) + pulse * (tier >= 3 ? 0.2 : 0.1);
    glow.scale.setScalar(base * (1 + pulse * (tier >= 3 ? 0.09 : 0.05)));
    glow.rotation.y += dt * (tier >= 3 ? 0.5 : 0.28);

    // ---- level 20: the crown floats above the head and turns slowly
    crown.visible = tier >= 3;
    if (crown.visible) {
      this.parts.auraCrownMat.color.setHex(col);
      this.parts.auraCrownMat.opacity = 0.6 + pulse * 0.3;
      crown.position.y = 2.42 + Math.sin(t * 1.9) * 0.06;
      crown.rotation.y += dt * 0.8;
    }

    tangentBasis(this.up, _f, _r);
    const speed = this.velocity.length();

    // ---- soul-dust: slow, long-lived motes that hang and drift rather than jet upward
    this.auraT -= dt;
    if (this.auraT <= 0) {
      this.auraT = tier >= 3 ? 0.085 : tier === 2 ? 0.1 : 0.13;
      const count = tier >= 2 ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = 0.3 + Math.random() * (tier >= 2 ? 0.75 : 0.5);
        _tmp.copy(this.position)
          .addScaledVector(this.up, 0.2 + Math.random() * (tier >= 2 ? 1.7 : 1.2))
          .addScaledVector(_f, Math.cos(a) * rad)
          .addScaledVector(_r, Math.sin(a) * rad);
        g.effects.burst(_tmp, mote, {
          count: 1,
          speed: 0.28 + Math.random() * 0.3,
          life: tier >= 2 ? 1.75 : 1.35,
          size: tier >= 3 ? 0.5 : 0.4,
          up: this.up,
          spread: 0.12,
          gravity: 0,
          drag: 2.6,
        });
      }
    }

    // ---- the wake: while moving, leave a ribbon of the same dust behind
    if (speed > 2.4) {
      this.auraWakeT -= dt;
      if (this.auraWakeT <= 0) {
        this.auraWakeT = tier >= 2 ? 0.045 : 0.085;
        const n = tier >= 2 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const rad = Math.random() * 0.5;
          _tmp.copy(this.position)
            .addScaledVector(this.up, 0.15 + Math.random() * 1.3)
            .addScaledVector(_f, Math.cos(a) * rad)
            .addScaledVector(_r, Math.sin(a) * rad);
          g.effects.trail(_tmp, mote, tier >= 2 ? 0.5 : 0.38, tier >= 2 ? 0.5 : 0.36);
        }
      }
    }

    // ---- the orbiting corona: ONE spark from level 10, TWO from level 15
    this.auraHalo += dt * 1.9;
    const sparks = tier >= 2 ? 2 : 1;
    for (let i = 0; i < sparks; i++) {
      const a = this.auraHalo + i * Math.PI;
      // they rise and fall out of phase, so a pair reads as two particles and not one blurred ring
      const lift = 0.8 + Math.sin(this.auraHalo * 1.6 + i * Math.PI) * 0.38;
      _tmp.copy(this.position)
        .addScaledVector(this.up, lift)
        .addScaledVector(_f, Math.cos(a) * 1.2)
        .addScaledVector(_r, Math.sin(a) * 1.2);
      g.effects.burst(_tmp, mote, {
        count: 1,
        speed: 0.2 + i * 0.05,
        life: 1.5,
        size: 0.52 - i * 0.07,
        gravity: 0,
        drag: 2.4,
      });
    }

    if (tier < 3) return;
    this.auraRingT -= dt;
    if (this.auraRingT <= 0) {
      this.auraRingT = 1.1 + Math.random() * 0.5;
      g.effects.ring(this.position, this.up, 1.15, col, 0.6, 2.7, 0.55);
    }
    this.auraBeamT -= dt;
    if (this.auraBeamT <= 0) {
      this.auraBeamT = 3;
      _tmp.copy(this.position).addScaledVector(this.up, 0.1);
      _tmp2.copy(this.position).addScaledVector(this.up, 8);
      g.effects.beam(_tmp, _tmp2, mote, 0.42, 0.34, 0.36);
    }
  }

  dispose(): void {
    // Mark it dead on the way out: creatures and abilities hold target REFERENCES across frames
    // (see Enemy.bTarget), and a departed player must stop being a valid target immediately rather
    // than whenever the next decision pass happens to run.
    this.alive = false;
    this.accessories.dispose();
    this.game.scene.remove(this.model);
    disposeObject(this.model);
    this.clearGhosts();
  }

  private clearGhosts(): void {
    for (const ghost of this.ghostPool) {
      this.game.scene.remove(ghost.obj);
      ghost.obj.traverse(object => {
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      });
      ghost.mat.dispose();
    }
    this.ghostPool.length = 0;
    this.ghostIdx = 0;
  }
}
