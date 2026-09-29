// NECROFALL — the orchestrator: match flow, world sim, damage authority, P2P messaging,
// host migration, HUD assembly and debug tooling.
import * as THREE from 'three';
import {
  COLONIES,
  CONFIG,
  COLONY_BUFF_DEFAULTS,
  DPR_CAP,
  IS_MOBILE,
  IS_TOUCH,
  PALETTE,
  PERF,
  QualitySettings,
  ColonyBuffState,
  Mods,
  QualityPref,
  FpsPref,
  detectQuality,
  loadQualityPref,
  loadFpsPref,
  qualitySettings,
  resolveQuality,
  saveQualityPref,
  saveFpsPref,
  beaconName,
} from './Config';
import { GameCamera, CameraTarget } from '../camera/GameCamera';
import { InputManager } from '../input/InputManager';
import { Planet } from '../world/Planet';
import { Effects } from '../effects/Effects';
import { TelegraphSystem } from '../effects/Telegraphs';
import { CombatSystem } from '../combat/Combat';
import { EnemyManager, Enemy } from '../enemies/Enemies';
import { ABILITY_META } from '../enemies/EnemyGenomes';
import { factsFromDescriptor } from '../enemies/procedural/EcologyGenerator';
import { parsePlanetKey, DEFAULT_UNIVERSE_SEED } from '../rankmap/procedural/SeedHash';
import { planetAt } from '../rankmap/procedural/PlanetGenerator';
import { TowerManager, battlefieldCenterDir, BEACON_ABILITY } from '../towers/Towers';
import { AbilitySystem } from '../necrotech/AbilitySystem';
import { AimPreview } from '../necrotech/AimPreview';
import { PadManager } from '../world/Pads';
import { BaseManager } from '../world/Bases';
import { AudioManager } from '../audio/AudioManager';
import { NetworkManager, NetMessage } from '../networking/Networking';
// Type-only: the official multiplayer seam. No SpacetimeDB code is bundled into the game.
import type {
  OfficialGameBridge,
  OfficialGamePlayerInfo,
  OfficialMatchPayload,
  OfficialMatchResult,
  OfficialNetMessage,
  OfficialStateMessage,
} from '../app/multiplayer/OfficialTypes';
import { ClockSync } from '../networking/ClockSync';
import { SavedRun, SessionStore, normaliseCode } from '../networking/Session';
import { UI, ScreenName } from '../ui/UI';
import type { BossPlate, TowerPlate, HudData, MiniData } from '../ui/UI';
import { Player, PlayerNet } from '../player/Player';
import { DecoySystem } from '../player/Decoy';
import { AccessorySelection, EffectCategory } from '../customization/AccessoryTypes';
import { loadSelection, saveSelection, selectionFromWire, selectionToWire } from '../customization/CustomizationStore';
import { CosmeticFxRunner } from '../customization/CosmeticFx';
import { NECROTECHS, NecrotechDef, defForDrop, ALL_NECROTECHS, ensureAim, aimDefault } from '../necrotech/NecrotechData';
import { PERKS, Perk, rollPerks } from '../necromutation/Perks';
import { Rand, clamp, dirFromAngles, formatTime, hashString, nowSec, orientToSurface, randomUnitVector, tangentBasis } from '../utils/Utils';
import { PerformanceMonitor } from '../performance/PerformanceMonitor';

export type Phase = 'menu' | 'lobby' | 'colony' | 'necrotech' | 'playing' | 'ended';

/** Everything the account shell hands the game when it boots an OFFICIAL match. */
export interface GameOptions {
  official?: {
    bridge: OfficialGameBridge;
    match: import('../app/multiplayer/OfficialTypes').OfficialMatchPayload;
  };
}

interface RosterEntry {
  id: string;
  name: string;
  ready: boolean;
  colony: number;
  nt: number;
  isHost: boolean;
  me: boolean;
  /** Accessory wire form ("hat,backpack,pet") — what the lobby draws on this player's avatar. */
  acc?: string;
}

interface Pickup {
  id: number;
  pos: THREE.Vector3;
  nt: number;
  rare: boolean;
  taken: boolean;
  /** Player the current claim belongs to ('' while the drop is free for the taking). */
  claimedBy: string;
  /** Match time the claim was handed out — an unanswered claim is released again. */
  claimAt: number;
  /** Seconds since the drop appeared — used for the 5s despawn + fade. */
  age: number;
  mesh: THREE.Group;
}

/**
 * A saved loadout is only trusted if it still looks like a Necrotech definition. A class that
 * exists in the table is taken from the table (so a rebalance reaches returning players); only a
 * mutation — which has no entry there — is rebuilt from the save itself.
 */
function defFromSave(raw: NecrotechDef | null | undefined): NecrotechDef | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.stats || typeof raw.stats.damage !== 'number' || typeof raw.stats.range !== 'number') return null;
  if (!raw.name || !raw.skill?.id || !raw.ult?.id) return null;
  // a loadout saved before the aiming rework has no footprint descriptions — put them back
  ensureAim(raw.skill);
  ensureAim(raw.ult);
  if (!raw.stats.chainDecay && raw.stats.chain) raw.stats.chainDecay = 0.7;
  if (raw.stats.elong === undefined) raw.stats.elong = 1;
  if (raw.mutated || raw.idx >= ALL_NECROTECHS.length + 100) return raw;
  return ALL_NECROTECHS.find(n => n.idx === raw.idx) ?? raw;
}

/** A burn / toxin / slow carried with a player hit over the network. */
export interface HitStatus {
  dot?: { kind: 'burn' | 'toxin'; dps: number; dur: number; label: string };
  buff?: { key: keyof Mods; mul: number; dur: number; label: string };
}

/** Compact wire form: [dotKind, dps, dur, label, buffKey, mul, buffDur, buffLabel]. */
type WireStatus = (string | number)[];

function serialiseStatus(s: HitStatus): WireStatus {
  const d = s.dot;
  const b = s.buff;
  return [
    d ? d.kind : '', d ? Math.round(d.dps * 100) / 100 : 0, d ? d.dur : 0, d ? d.label : '',
    b ? String(b.key) : '', b ? Math.round(b.mul * 100) / 100 : 0, b ? b.dur : 0, b ? b.label : '',
  ];
}

function readStatus(raw: unknown): HitStatus | null {
  if (!Array.isArray(raw) || raw.length < 8) return null;
  const out: HitStatus = {};
  if (raw[0] === 'burn' || raw[0] === 'toxin') {
    out.dot = { kind: raw[0], dps: Number(raw[1]) || 0, dur: Number(raw[2]) || 0, label: String(raw[3] || '') };
  }
  if (raw[4]) {
    out.buff = { key: String(raw[4]) as keyof Mods, mul: Number(raw[5]) || 1, dur: Number(raw[6]) || 0, label: String(raw[7] || '') };
  }
  return out.dot || out.buff ? out : null;
}

/** Applies a wire status to the player it was sent to. */
function applyHitStatus(p: Player, s: HitStatus): void {
  if (!p.alive) return;
  if (s.dot) p.addDot(s.dot.kind, s.dot.dps, s.dot.dur, s.dot.label);
  if (s.buff) p.addBuff(s.buff.key, s.buff.mul, s.buff.dur, s.buff.label);
}

interface PendingLevelUp {
  player: Player;
  perks: Perk[];
  time: number;
}

interface PendingPickup {
  pickupId: number;
  nt: number;
  rare: boolean;
  time: number;
}

const PLANET_SEED = 1337;
/** How many times one ancestry line of a fission Necrophage may split (each split doubles it). */
const MAX_SPLIT_GEN = 3;
/** How deep a Brood line may nest — the first generation may burst into swarmlings, no further. */
const MAX_BROOD_GEN = 1;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
/** Local +Y — the axis every ground decal is built around. */
const _UP = new THREE.Vector3(0, 1, 0);
const _qAlign = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
/** How far above the surface the Berserker badge floats, so terrain roughness cannot poke through. */
const BERSERK_LIFT = 0.14;
/** How fast the badge turns on the spot (radians per second). */
const BERSERK_SPIN = 0.55;
/** Reused viewport size for the world→screen plate projection (allocated once, not per frame). */
const _plateSize = new THREE.Vector2();

// ---------------------------------------------------------------------------------------------
// Per-frame HUD/radar snapshots. `hudData()` and `minimapData()` run once every frame and used to
// allocate a fresh object graph each time — the radar alone built one object per visible
// Necrophage. They now refill pools that grow to their high-water mark and then never allocate
// again; the UI only ever reads the snapshot, so reusing it is safe.
const gameBuffRow = (): HudData['buffs'][number] => ({ text: '', cls: '' });
const gameTowerRow = (): HudData['towers'][number] => ({
  kind: '', owner: -1, state: '', capture: 0, captureColony: -1,
  shieldUp: false, shieldT: 0, shieldFrac: 0, bossAlive: false,
});
const gamePerkRow = (): HudData['perks'][number] => ({ name: '', desc: '' });
const gameTaskRow = (): HudData['tasks'][number] => ({ label: '', progress: '', done: false });
const miniPlayerRow = (): MiniData['players'][number] => ({ x: 0, y: 0, z: 0, colony: -1, isLocal: false, alive: false });
const miniTowerRow = (): MiniData['towers'][number] => ({
  x: 0, y: 0, z: 0, idx: 0, owner: -1, kind: '', state: '',
  shieldUp: false, shieldFrac: 0, guarded: false, capture: 0, captureColony: -1,
});
const miniEnemyRow = (): MiniData['enemies'][number] => ({ x: 0, y: 0, z: 0, boss: false });
/** Ring/segment resolution of the Berserker ground badge, and how far it reaches (metres). */
const BERSERK_SEGS = 30;
const BERSERK_RINGS = 5;
const BERSERK_RADIUS = 2.2;
const _tmpEnemies: Enemy[] = [];

export class Game {
  scene = new THREE.Scene();
  renderer: THREE.WebGLRenderer;
  cam: GameCamera;
  planet: Planet;
  effects: Effects;
  /** One-shot cosmetic effects (recall / spawn / eliminated) — owned here, ticked every frame. */
  cosmeticFx: CosmeticFxRunner;
  /**
   * Terrain-conforming danger decals. Every boss telegraph is projected on to the planet through
   * this system, so a warning area always hugs the ground it will actually hit.
   */
  telegraphs: TelegraphSystem;
  /** Echo Decoy doubles (Necromutation): the swarm's alternate target, and a burst on expiry. */
  decoys: DecoySystem;
  combat: CombatSystem;
  enemies: EnemyManager;
  towers: TowerManager;
  abilities: AbilitySystem;
  input: InputManager;
  audio = new AudioManager();
  ui: UI;
  net: NetworkManager;
  settings: QualitySettings;

  phase: Phase = 'menu';
  clock = 0;
  now = 0;
  matchElapsed = 0;
  paused = false;
  /** The player currently locked into a Necromutation / Necrotech choice, if any. */
  frozenPlayer: Player | null = null;
  /** Every player currently locked into a choice — Necrophages back away from all of them. */
  frozenPlayers: Player[] = [];

  /** Closest player who is currently mid-choice and therefore protected from the swarm. */
  nearestFrozenPlayer(pos: THREE.Vector3, range: number): Player | null {
    let best: Player | null = null;
    let bestD = range * range;
    for (const p of this.frozenPlayers) {
      if (!p.alive || !p.frozen) continue;
      const d = p.position.distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private refreshFrozenPlayers(): void {
    this.frozenPlayers.length = 0;
    for (const p of this.players.values()) {
      if (p.frozen && p.alive) this.frozenPlayers.push(p);
    }
    this.frozenPlayer = this.localPlayer?.frozen ? this.localPlayer : (this.frozenPlayers[0] ?? null);
  }
  seed = PLANET_SEED;
  rng = new Rand(PLANET_SEED);
  isHost = true;

  /**
   * OFFICIAL (SpacetimeDB) match mode: when set, every pose this client produces
   * goes to the official bridge (throttled, change-driven) and remote players
   * arrive through the same `st` message path P2P uses. See app/multiplayer.
   */
  private officialMatch: GameOptions['official'] | null = null;
  /** Server usage summary of the last OFFICIAL match (plan §28) — printed on the results screen. */
  private officialUsage: NonNullable<OfficialMatchResult['usage']> | null = null;
  /**
   * The last settled result, kept so a LATE server verdict (the authoritative finish of a match
   * this client already concluded locally — e.g. after a Nexus capture) can repaint the SAME
   * results screen with the finalized usage summary instead of dropping the numbers on the floor.
   */
  private lastEnd: { winner: number | null; tiles: { label: string; owner: number }[]; reason?: string } | null = null;
  /**
   * Starter-class pick bookkeeping for OFFICIAL matches: the selection phase runs while the match
   * is already live server-side, so the world boots with the payload's seed and a clock read NOW
   * (base + however long the loading screen and the pick actually took).
   */
  private officialElapsedBase = 0;
  private officialBootAt = 0;

  players = new Map<string, Player>();
  localPlayer: Player | null = null;
  /** What the player wears (customize screen). Loaded from the browser, re-applied to every body. */
  customization: AccessorySelection = loadSelection();
  colonyBuffs: ColonyBuffState[] = COLONY_BUFF_DEFAULTS();
  private roster = new Map<string, RosterEntry>();
  /**
   * Shuffled host-election order: this host first, then every survivor in random order. It travels
   * with the lobby messages so all clients agree on who takes over if the host disappears.
   */
  private hostOrder: string[] = [];
  private pickups: Pickup[] = [];
  private nextPickupId = 1;

  private phaseTimer = 0;
  private pendingLevelUp: PendingLevelUp | null = null;
  private pendingPickup: PendingPickup | null = null;
  private queuedLevels = 0;
  /**
   * When the picker last closed after a pick. A level-up that lands inside `PICKER_GRACE` of this
   * is a CONTINUATION of the same burst (a DoT tick or a round still in the air finishing the
   * fight), not a fresh choice: it reopens with the cards swapping in place and no stinger, so the
   * panel cannot flash its pop-in animation every time one kill triggers two levels.
   */
  private levelUpClosedAt = -Infinity;
  /**
   * Seconds left before the picker's post-pick close actually runs. The panel lingers a beat after
   * the last pick so a kill landing a few frames later swaps its cards in place instead of making
   * the panel blink out and back in — the "necromutation UI flickering" report.
   */
  private pendingLevelHideT = 0;

  /** Room session: the code in the URL, this tab's player identity and the local save of a run. */
  private session = new SessionStore();
  /** The room this client currently holds a seat in (URL + BroadcastChannel bookkeeping). */
  private trackedRoom = '';
  /** Save loaded for the room in the URL — offered to the host so it can rebuild the run. */
  private resumeRun: SavedRun | null = null;
  /**
   * A brand-new player who dropped into a running match picks a colony and a Necrotech on their
   * own screens; this holds that little state (and drives its countdown).
   */
  private lateSelect: { step: 'colony' | 'necrotech'; colony: number; timer: number } | null = null;
  /** Seconds until the next local save of this player's run. */
  private saveT = 3;

  private camTarget: CameraTarget = {
    position: new THREE.Vector3(0, CONFIG.planetRadius + 10, 0),
    up: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(),
    alive: true,
    frozen: false,
  };
  private menuOrbit = 0;

  private rangeRing!: THREE.LineLoop;
  private rangeRingSegments = 96;
  /** Flat "BERSERK" sigil (burning ring + bull's head) painted over the ground under the runner. */
  private berserkSigil!: THREE.Mesh;
  /** Where the sigil's vertices were last sampled — drives the rebuild-on-move gate. */
  private readonly berserkSigilAt = new THREE.Vector3(1e9, 1e9, 1e9);
  private berserkSpin = 0;
  /** Range-ring rebuild bookkeeping: alternate frames, plus an immediate rebuild when it reappears. */
  private ringHalf = false;
  private ringVisible = false;
  private ringRadius = -1;
  /** Altitude the current ring was built for — the reach depends on it, so it is part of the key. */
  private ringAir = -1;
  private aimArrow!: THREE.Mesh;
  private aimArrowPts: [number, number][] = [];
  /** MOBA-style ground footprint of the ability currently being aimed. */
  private aimPreview!: AimPreview;
  /** Jump / blitz pads scattered over the planet. */
  readonly pads = new PadManager(this);
  /** The three colony bases (landing pads + permanent energy domes). */
  readonly bases = new BaseManager(this);
  /** Throttle for the Berserker ring embers. */
  private berserkFxT = 0;

  private snapshotT = 0;
  private cooldownNudgeT = 0;
  /**
   * Peer clocks: state packets carry the sender's own time, and these map it onto ours. `hostSync`
   * is what a client uses on the host's snapshots; `peerSync` is what the host uses on each
   * client's own reports so it can forward a pose stamped with the time it was actually true.
   */
  private hostSync = new ClockSync();
  private peerSync = new Map<string, ClockSync>();
  /** Minimum gap between two pickup grabs a client asks the host for. */
  private pickupAskT = 0;
  private stateT = 0;
  /** Official matches: cadence of the server-record feed (submit_input/sync_pose, throttled). */
  private stateT2 = 0;
  /** Official client: signature + time of the last relayed pose, so idle players go quiet. */
  private relaySig = '';
  private relaySentAt = 0;
  private enemyHitBatch: { eid: number; amt: number; src: string; aoe: number }[] = [];
  private killBatch: number[] = [];
  private bossScratch: Enemy[] = [];
  /**
   * Mutation ids this client has already been shown the reveal for. The panel is for DISCOVERY:
   * fusing the same pair again reports it in the banner instead of replaying the whole reveal.
   */
  private discoveredMutations = new Set<string>();

  // ---- reused HUD/radar snapshot containers (see the row factories at the top of the file)
  private hudBuffs: HudData['buffs'] = [];
  private hudTowers: HudData['towers'] = [];
  private hudPerks: HudData['perks'] = [];
  private hudTasks: HudData['tasks'] = [];
  private hudCounts: number[] = [0, 0, 0];
  private hudZoneCounts: number[] = [0, 0, 0];
  private hudZone = { label: '', progress: 0, colony: -1 };
  private hudZoneSig = '';
  private hudNtColor = -1;
  private hudNtCss = '#9a6bff';
  /** Signature-cached mutation tint (only rebuilt when the headline mutation colour changes). */
  private hudMutColor = -1;
  private hudMutCss = '#9a6bff';
  /** Signature of the headline mutation's id, so its text block is rebuilt only on change. */
  private hudMutSig = '';
  private boonSecs = -1;
  private boonText = '';
  private connSig = '';
  private connText = '';
  private hudScratch: HudData = {
    remaining: 0, matchTime: CONFIG.matchTime, hp: 0, maxHp: CONFIG.player.maxHp, level: 1,
    xp: 0, xpNeed: 100, skillName: '—', skillDesc: '', skillCd: 0, skillMax: 1,
    skillCharges: 0, skillChargeMax: 1,
    recallReady: false, recallActive: false, recallFrac: 0, recallSeconds: 0,
    ultName: '—', ultDesc: '', ultCd: 0, ultMax: 1, dashCharges: 0, dashMax: 3, dashRecharge: 0,
    dashRechargeNeed: CONFIG.player.dashRecharge, jumpsLeft: 0, jumpsMax: CONFIG.player.baseJumps,
    autoTargets: 1,
    beaconReady: false, colonyIdx: 0, necrotechName: '—', necrotechColor: '#9a6bff', mutated: 0,
    mutationCount: 0, mutationLimit: 3, mutationColor: '#9a6bff',
    mutationName: '', mutationSources: '', mutationDesc: '', mutationTags: '', mutationRarity: '',
    passiveName: '—', passiveDesc: '',
    buffs: this.hudBuffs, prompt: '', promptKey: '', conn: '', roomCode: '',
    towers: this.hudTowers, counts: this.hudCounts, zone: null, perks: this.hudPerks, tasks: this.hudTasks,
  };
  /**
   * The local player's RECALL channel (null = none). Recall is a committed, vulnerable channel:
   * the button is PRESSABLE ANYTIME (user ask 2026-09-29 — the old idle gate is gone), pressing
   * it locks the body in place (`Player.recallHold`) so it can neither move nor fire, and a FRESH
   * input edge, any hit or death breaks it — the next press starts the count all over. See
   * `requestRecall` / `watchRecallInput` / `cancelRecall` / `updateRecall`.
   */
  private recall: { p: Player; t: number; total: number; since: number } | null = null;
  private miniPlayers: MiniData['players'] = [];
  private miniTowers: MiniData['towers'] = [];
  private miniEnemies: MiniData['enemies'] = [];
  private mini: MiniData = {
    origin: { x: 0, y: 0, z: 0 },
    fwd: { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 },
    range: 150,
    players: this.miniPlayers,
    towers: this.miniTowers,
    enemies: this.miniEnemies,
  };

  private frames = 0;
  private fpsT = 0;
  private fps = 60;
  private frameMs = 16;
  /** Smoothed CPU cost of the match simulation and of `renderer.render` (F1 diagnostics). */
  private simMs = 0;
  private renderMs = 0;
  /**
   * Adaptive render scale: the ladder step (0 = the device-capped DPR) plus the hysteresis clocks
   * that decide when it may move — see `updateRenderScale`.
   */
  private dprStep = 0;
  private dprBadT = 0;
  private dprGoodT = 0;
  private dprCooldown = 0;
  /**
   * Render pacing (2026-09 thermal pass). `rafGapMs` is an EMA of the RAW rAF cadence, which
   * describes the display even while frames are being skipped; `lastInteractionAt` drives the
   * idle-menu drop. See `frameTargetFps`.
   */
  private rafGapMs = 16.7;
  /**
   * Fastest raw frame gap seen in the last `RAF_MIN_WINDOW` ms — a load-independent estimate of
   * the PANEL's refresh rate (the EMA above melts under load, this does not). The DPR ladder uses
   * it so an explicit 120 fps cap on a 60 Hz screen cannot read every frame as "missed".
   */
  private rafGapMin = 64;
  private rafGapMinT = 0;
  private static readonly RAF_MIN_WINDOW = 3000;
  /**
   * How long after the picker closes a new level-up still counts as the same burst (continuation).
   * Covers DoT ticks and rounds already in the air finishing the fight right after a pick.
   */
  private static readonly PICKER_GRACE = 1.5;
  /** How long the picker lingers after its last pick before it actually closes (a burst window). */
  private static readonly PICKER_LINGER = 0.15;
  private lastRawTick = 0;
  private lastInteractionAt = performance.now();
  /** Seconds of warm-up during which the DPR ladder ignores samples (boot / match-start jank). */
  private dprWarmup = 0;
  /** Last pacing target the ladder saw, so a target change (idle wake, menu→match) is noticed. */
  private pacedTarget = -1;
  /** Performance watchdog: consecutive slow samples and how many rescue steps have been applied. */
  private slowSamples = 0;
  private goodSamples = 0;
  private rescueLevel = 0;
  /** Seconds without a slow sample — the clock the rescue decay walks back down on. */
  private rescueIdleT = 0;
  /** Age of the last decay (only counted once a decay has armed it) — the "regret" window. */
  private rescueDecayT = 0;
  /** Lowest level the decay may walk back to: a level re-applied after decaying is pinned. */
  private rescueFloor = 0;
  /** Live crowd budget — the watchdog lowers it under load and raises it back when frames recover. */
  enemyBudget = 0;
  /** Worst frame time seen recently (diagnostics). */
  private worstMs = 0;
  private worstDecayT = 0;
  private ctxLost = false;  private lastCrashAt = -1e9;
  private frameErrors = 0;
  private toastCooldown: Record<string, number> = {};
  private debugTeleportIdx = 0;
  /** The player's graphics choice (`auto` = probe the device). Persisted; applied live. */
  private qualityPref: QualityPref = 'auto';
  /** The player's frame-rate ceiling (`auto` = the device-aware PERF pacing). Persisted; live. */
  private fpsPref: FpsPref = 'auto';

  constructor(private app: HTMLElement, options: GameOptions = {}) {
    this.officialMatch = options.official ?? null;
    this.qualityPref = loadQualityPref();
    this.fpsPref = loadFpsPref();
    this.settings = qualitySettings(resolveQuality(this.qualityPref));
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.settings.name !== 'low',
      powerPreference: 'high-performance',
    });
    // NEVER the raw devicePixelRatio on a phone: a 3x panel would triple the shaded pixels for no
    // visible gain at arm's length. See `baseDpr` / `currentDpr` and DPR_CAP in Config.ts.
    this.renderer.setPixelRatio(this.currentDpr());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x09060f);
    this.app.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.FogExp2(0x171029, 0.0012);
    const hemi = new THREE.HemisphereLight(0xb9a6ff, 0x2a1d3d, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.5);
    sun.position.set(1, 0.85, 0.6).multiplyScalar(400);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x7a5cff, 0.35);
    rim.position.set(-1, 0.2, -0.8).multiplyScalar(400);
    this.scene.add(rim);
    this.buildStarfield();

    this.cam = new GameCamera(window.innerWidth / window.innerHeight);
    this.planet = new Planet(this.scene, this.settings, PLANET_SEED);
    this.effects = new Effects(this.scene, this.settings);
    this.cosmeticFx = new CosmeticFxRunner(this.scene);
    this.telegraphs = new TelegraphSystem(this.scene);
    this.telegraphs.setPlanet(this.planet);
    this.decoys = new DecoySystem(this.scene);
    this.effects.setPlanet(this.planet);
    this.combat = new CombatSystem(this, this.settings);
    this.enemies = new EnemyManager(this, this.settings);
    this.towers = new TowerManager(this);
    this.abilities = new AbilitySystem(this);
    this.input = new InputManager(this.renderer.domElement);
    this.input.setEnabled(false);

    this.ui = new UI({
      createLobby: name => void this.createLobby(name),
      joinLobby: (code, name) => void this.joinLobby(code, name),
      startMatch: () => this.startMatch(),
      kickPlayer: id => this.kickPlayer(id),
      leaveRoom: () => this.leaveRoom(),
      returnToMenu: () => this.returnToMenu(),
      perkPick: idx => this.pickPerk(idx),
      pickupChoice: choice => this.resolvePickup(choice),
      recall: () => this.requestRecall(),
      toggleReady: () => this.toggleReady(),
      resume: () => this.togglePauseMenu(),
      leaveMatch: () => this.leaveMatch(),
      openMenu: () => this.togglePauseMenu(),
      closeMenu: () => this.closePauseMenu(),
      setGraphics: pref => this.setGraphicsPref(pref),
      setFps: pref => this.setFpsPref(pref),
      setAccessories: sel => this.applyAccessorySelection(sel),
    });
    this.ui.onColonyClick = idx => this.selectColony(idx);
    this.ui.onNecrotechClick = idx => this.selectNecrotech(idx);
    this.ui.bindMobile(this.input);

    this.net = new NetworkManager({
      onOpen: () => this.onNetOpen(),
      onJoin: (id, name, resume, run, rejoin) => this.onPeerJoin(id, name, resume, run, rejoin),
      onLeave: id => this.onPeerLeave(id),
      onMessage: (from, msg) => this.onNetMessage(from, msg),
      onHostLost: reason => this.onHostLost(reason),
      onPromoted: () => this.onPromoted(),
      onMigrated: id => this.onMigrated(id),
      onCodeChanged: code => this.onCodeChanged(code),
      onMigrateFailed: () => this.onMigrateFailed(),
      onFatal: reason => this.onFatal(reason),
    });

    this.buildIndicators();
    this.bindMetaEvents();

    this.ui.show('menu');

    // The room code in the URL *is* the session: opening — or refreshing — that link walks back
    // into the room with no menus in the way. The room restores a returning player's run, and a
    // newcomer is asked to pick a colony and a Necrotech. Official matches never join rooms.
    const room = this.officialMatch ? '' : this.session.roomCodeFromUrl();
    if (room) void this.autoJoinRoom(room);
  }

  // ------------------------------------------------------------ setup helpers

  /**
   * The Berserker state sigil: ONE flat decal under the local runner — a burning ring around a
   * horned disc — so "I am berserk" is readable from the ground itself instead of only from the HUD.
   *
   * It is a FIXED shape (see `updateBerserkSigil`): a flat disc in LOCAL space that is simply placed
   * and tilted at the runner each frame, like the aim chevron. It used to be a 180-vertex mesh with
   * every vertex resampled from the height field whenever the runner had moved 0.2 m — which cost a
   * height sample per vertex and made the badge visibly SNAP/flicker as it re-seated itself.
   */
  private buildBerserkSigil(): void {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d');
    if (c) {
      const cx = size / 2;
      const cy = size / 2;
      // dark disc so the gold stays legible over bright terrain, then the burning ring
      c.fillStyle = 'rgba(20, 9, 3, 0.62)';
      c.beginPath();
      c.arc(cx, cy, 120, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(10, 4, 2, 0.85)';
      c.lineWidth = 21;
      c.beginPath();
      c.arc(cx, cy, 104, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = '#ff8a3d';
      c.lineWidth = 17;
      c.beginPath();
      c.arc(cx, cy, 106, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = 'rgba(255, 240, 210, 0.98)';
      c.lineWidth = 5;
      c.beginPath();
      c.arc(cx, cy, 94, 0, Math.PI * 2);
      c.stroke();

      // THE MARK: one circle with two DEVIL HORNS, and nothing else. A detailed animal head read as
      // a pig and then a deer, so the badge is now the simplest shape that still says "rage".
      const hy = cy + 14;                       // the head sits a touch below centre
      const hr = 60;                             // head radius
      const gold = '#ffd08a';
      const deep = '#c2601c';
      // Horns FIRST (their roots sit under the head, so they look grown out of it): a thick root on
      // the head's shoulder sweeping out and up to a sharp tip, then down the inside back to the rim.
      for (const side of [-1, 1] as const) {
        c.beginPath();
        c.moveTo(cx + side * 30, hy - hr * 0.74);
        c.bezierCurveTo(
          cx + side * 92, hy - hr * 1.16,
          cx + side * 96, hy - hr * 2.02,
          cx + side * 44, hy - hr * 2.30
        );
        c.bezierCurveTo(
          cx + side * 60, hy - hr * 1.62,
          cx + side * 46, hy - hr * 1.14,
          cx + side * 6, hy - hr * 0.95
        );
        c.closePath();
        const hornGrad = c.createLinearGradient(cx, hy - hr * 2.3, cx, hy - hr * 0.7);
        hornGrad.addColorStop(0, '#fff3d6');
        hornGrad.addColorStop(1, deep);
        c.fillStyle = hornGrad;
        c.fill();
        c.strokeStyle = 'rgba(38, 12, 2, 0.85)';
        c.lineWidth = 6;
        c.stroke();
      }
      // the head: a ringed disc, lit from the top-left so it reads as a solid shape
      const grad = c.createRadialGradient(cx - hr * 0.35, hy - hr * 0.45, hr * 0.15, cx, hy, hr);
      grad.addColorStop(0, '#fff6e2');
      grad.addColorStop(0.55, gold);
      grad.addColorStop(1, deep);
      c.fillStyle = grad;
      c.beginPath();
      c.arc(cx, hy, hr, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(38, 12, 2, 0.9)';
      c.lineWidth = 9;
      c.stroke();
      c.strokeStyle = 'rgba(255, 214, 150, 0.55)';
      c.lineWidth = 4;
      c.beginPath();
      c.arc(cx, hy, hr - 15, 0, Math.PI * 2);
      c.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;

    // A FLAT disc lying in the local XZ plane (local +Y is its normal), so the whole badge is one
    // `position` + `quaternion` write per frame.
    const verts = (BERSERK_RINGS + 1) * BERSERK_SEGS;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    for (let i = 0; i <= BERSERK_RINGS; i++) {
      const fi = i / BERSERK_RINGS;
      for (let j = 0; j < BERSERK_SEGS; j++) {
        const a = (j / BERSERK_SEGS) * Math.PI * 2;
        const o = (i * BERSERK_SEGS + j) * 3;
        pos[o] = Math.cos(a) * fi * BERSERK_RADIUS;
        pos[o + 1] = 0;
        pos[o + 2] = Math.sin(a) * fi * BERSERK_RADIUS;
        const u = (i * BERSERK_SEGS + j) * 2;
        uv[u] = 0.5 + 0.5 * fi * Math.cos(a);
        uv[u + 1] = 0.5 + 0.5 * fi * Math.sin(a);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx: number[] = [];
    for (let i = 0; i < BERSERK_RINGS; i++) {
      for (let j = 0; j < BERSERK_SEGS; j++) {
        const a = i * BERSERK_SEGS + j;
        const b = i * BERSERK_SEGS + ((j + 1) % BERSERK_SEGS);
        const c2 = (i + 1) * BERSERK_SEGS + j;
        const d = (i + 1) * BERSERK_SEGS + ((j + 1) % BERSERK_SEGS);
        idx.push(a, c2, b, b, c2, d);
      }
    }
    geo.setIndex(idx);
    this.berserkSigil = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0.95,
        // DOUBLE SIDED is load-bearing: the disc is a flat fan and its triangles wind to face local
        // -Y, so with front-face culling the badge is invisible from the camera above it.
        side: THREE.DoubleSide,
      })
    );
    this.berserkSigil.frustumCulled = false;
    this.berserkSigil.renderOrder = 3;
    this.berserkSigil.visible = false;
    this.scene.add(this.berserkSigil);
  }

  /**
   * Places the badge under the runner: local +Y is turned on to the GROUND NORMAL under their feet
   * and the badge is spun about its own axis, so the whole decal costs a handful of writes per frame
   * — no vertex resampling, nothing to snap to (which is what used to make it flicker).
   *
   * The normal is fitted for the decal, not taken from the player: on a slope the runner's own up is
   * the surface normal AT their feet, and a flat disc laid on that tangent plane cuts into the rise
   * a couple of metres out. Two finite-difference gradient samples over the disc's own footprint put
   * the plane flush with the ground instead, and a small lift covers the remaining curvature.
   */
  private updateBerserkSigil(p: Player): void {
    const sig = this.berserkSigil;
    const e = BERSERK_RADIUS * 0.5;
    const slope = (t: THREE.Vector3): number => {
      _v4.copy(p.position).addScaledVector(t, e).normalize();
      const hi = this.planet.heightAtDir(_v4.x, _v4.y, _v4.z);
      _v4.copy(p.position).addScaledVector(t, -e).normalize();
      const lo = this.planet.heightAtDir(_v4.x, _v4.y, _v4.z);
      return (hi - lo) / (2 * e);
    };
    tangentBasis(p.up, _v, _v2);
    const gx = slope(_v);
    const gz = slope(_v2);
    _v3.copy(p.up).addScaledVector(_v, -gx).addScaledVector(_v2, -gz).normalize();
    _qAlign.setFromUnitVectors(_UP, _v3);
    _qSpin.setFromAxisAngle(_UP, this.berserkSpin);
    sig.quaternion.copy(_qAlign).multiply(_qSpin);
    sig.position.copy(p.position).addScaledVector(p.up, BERSERK_LIFT);
  }

  /** Starfield + nebula are rendered by the sky shader inside Planet. */
  private buildStarfield(): void {
    /* intentionally empty — see world/Planet.ts sky dome shader */
  }

  private buildIndicators(): void {
    // Auto-attack range indicator: a line loop that follows the planet surface
    // (geodesic circle at exactly `autoRange` metres), so it always reads as "on the ground".
    this.rangeRingSegments = 96;
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.rangeRingSegments * 3), 3));
    this.rangeRing = new THREE.LineLoop(
      ringGeo,
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.rangeRing.frustumCulled = false;
    this.rangeRing.renderOrder = 3;
    this.scene.add(this.rangeRing);

    this.buildBerserkSigil();

    // Aim marker: a solid chevron painted on the ground, sampled onto the terrain exactly like
    // the range ring. Built from two thick arms so the shape is filled, not an outline.
    const arm = (x0: number, y0: number, x1: number, y1: number, w: number, flip: number): [number, number][] => {
      const dx = (x1 - x0) * flip;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (dy / len) * w;
      const ny = (-dx / len) * w;
      const ax = x0 * flip;
      const bx = x1 * flip;
      // quad corners: a+n, b+n, b-n, a-n -> two triangles
      const px = [ax + nx, bx + nx, bx - nx, ax - nx];
      const py = [y0 + ny, y1 + ny, y1 - ny, y0 - ny];
      return [
        [px[0], py[0]], [px[1], py[1]], [px[2], py[2]],
        [px[0], py[0]], [px[2], py[2]], [px[3], py[3]],
      ];
    };
    // Both arms sweep inwards to the apex, leaning a little tighter than they used to, and each one
    // runs a HAIR past the centre line (CHEV_TIP) so the two overlap and the tip closes into a point —
    // butted exactly edge to edge it left a notched nose. The overshoot has to stay small: push the
    // arms far past each other (0.4+) and the tip opens out into an X instead of a chevron. The
    // knobs are CHEV_BACK — how far apart the trailing ends sit, i.e. the size of the gap at the back
    // of the chevron — and CHEV_NEAR, how far IN FRONT of the runner the shape starts: a direction
    // reticle reads better pushed a little way out than pinned under the feet. The arm ANGLE is
    // derived, not set: with CHEV_LEN - CHEV_NEAR == CHEV_TIP + CHEV_BACK the arms are 45 deg off the
    // centre line each, so the chevron is a clean right angle — move CHEV_NEAR and CHEV_LEN follows.
    const CHEV_BACK = 1.35, CHEV_TIP = 0.2, CHEV_W = 0.25, CHEV_NEAR = 0.9;
    const CHEV_LEN = CHEV_NEAR + CHEV_TIP + CHEV_BACK;
    const outline: [number, number][] = [
      ...arm(-CHEV_BACK, CHEV_NEAR, CHEV_TIP, CHEV_LEN, CHEV_W, 1),
      ...arm(-CHEV_BACK, CHEV_NEAR, CHEV_TIP, CHEV_LEN, CHEV_W, -1),
    ];
    this.aimArrowPts = outline;
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outline.length * 3), 3));
    this.aimArrow = new THREE.Mesh(
      arrowGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    this.aimArrow.frustumCulled = false;
    this.aimArrow.renderOrder = 3;
    this.scene.add(this.aimArrow);
    this.aimArrow.visible = false;

    // Ability aiming footprint (lane / cone / blast disc), painted on the terrain.
    this.aimPreview = new AimPreview(this.scene);
  }

  private bindMetaEvents(): void {
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', e => this.onDebugKey(e));
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    this.renderer.domElement.addEventListener('touchstart', () => this.audio.unlock(), { passive: true });
    // A refresh can arrive at any moment and a throttled tab stops ticking (see the save ticker in
    // update), so the run is also flushed on the way out — that is what makes a reload seamless.
    const flush = (): void => {
      if (this.phase === 'playing') this.saveRun();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        flush();
        // Nothing is drawn while the tab is hidden (the render loop pauses itself), and the sim /
        // network ticks live inside that loop — so the one thing still burning battery would be
        // the WebAudio graph. Suspending it stops the audio thread outright; the match state is
        // untouched and the graph resumes exactly where it was. Connections stay up: PeerJS keeps
        // them alive in the background, and a hidden tab is throttled to ~1 fps either way.
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });
  }

  onResize(): void {
    this.applyRenderScale();
    this.cam.resize(window.innerWidth / window.innerHeight);
  }

  // ------------------------------------------------------------ render scale (DPR)

  /**
   * The render resolution this device is allowed to reach: the smaller of the panel's DPR, the
   * device-class cap (mobile 1.25 / desktop 2) and the graphics preset's own ceiling. The preset
   * is a ceiling, not a target — a phone preset can never out-rank the 1.25 cap.
   */
  private baseDpr(): number {
    const cap = IS_MOBILE ? DPR_CAP.mobile : DPR_CAP.desktop;
    return Math.min(window.devicePixelRatio || 1, cap, this.settings.pixelRatio);
  }

  /** The live render resolution: the capped DPR times the current adaptive ladder step. */
  private currentDpr(): number {
    const base = this.baseDpr();
    return Math.max(0.5, Math.round(base * PERF.dprLadder[this.dprStep] * 100) / 100);
  }

  /** Applies the render scale. Only the WebGL buffer changes — the CSS/UI keeps the device DPR. */
  private applyRenderScale(): void {
    this.renderer.setPixelRatio(this.currentDpr());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * Adaptive render scale — the ONLY thing in the game that moves the resolution. It shares the
   * watchdog's half-second FPS windows (there is exactly one performance monitor), and walks the
   * ladder one step at a time with hysteresis on both sides plus a cooldown, so quality can never
   * oscillate: down after `PERF.downAfter` seconds under the bad threshold, up after `PERF.upAfter`
   * seconds over the good one, never twice within `PERF.cooldown`. A phone that is already
   * thermally throttling is caught in two windows, not after several seconds of jank.
   *
   * Runs in every phase (2026-09 thermal pass): menus used to be exempt, which is exactly where a
   * phone could bake. The thresholds are RELATIVE to the pacing target (the plan's own rule:
   * trouble starts when a frame budget is missed by ~20 %) — a menu capped at 30 fps would
   * otherwise read as "always slow" by construction, and a 60 fps cap that a busy machine merely
   * approaches must not tank the resolution of a machine that is otherwise fine. Uncapped phases
   * (desktop matches) keep the original absolute numbers.
   */
  private updateRenderScale(fps: number): void {
    // A backgrounded tab throttles rAF to ~1 fps and a restored tab produces one enormous frame —
    // neither says anything about how the machine performs (same guard as the watchdog).
    if (document.hidden || this.frameMs > 400) return;
    const SAMPLE = 0.5; // length of an fps window (see `fpsT > 0.5` in update)
    const target = this.frameTargetFps();
    if (target !== this.pacedTarget) {
      // The pacing target just moved (idle wake, menu → match): the next window measures a mix of
      // the old and the new rate, so it gets the same clean slate as a boot.
      this.pacedTarget = target;
      this.dprWarmup = Math.max(this.dprWarmup, 1);
      this.dprBadT = 0;
      this.dprGoodT = 0;
    }
    if (this.dprWarmup > 0) {
      // Boot / match start / target change: shader compilation, world building and rate ramps
      // produce a few slow windows that say nothing about sustained performance. Keep the clocks
      // clean while they pass.
      this.dprWarmup -= SAMPLE;
      this.dprBadT = 0;
      this.dprGoodT = 0;
      return;
    }
    const last = PERF.dprLadder.length - 1;
    // Explicit fps caps are compared against the DISPLAY, not the raw cap: a 120 target on a 60 Hz
    // panel is "hitting 60" — without this the ladder read every frame as a miss and ground the
    // render scale down for a cap the hardware cannot even express. AUTO keeps its own rules.
    const panelHz = this.rafGapMin > 1 ? 1000 / this.rafGapMin : 0;
    const ref = this.fpsPref !== 'auto' && panelHz > 0 ? Math.min(target, panelHz) : target;
    const bad = ref > 0 ? ref * 0.8 : PERF.badFps;
    const good = ref > 0 ? ref * 0.93 : PERF.goodFps;
    if (this.dprCooldown > 0) this.dprCooldown -= SAMPLE;
    if (fps < bad) {
      this.dprBadT += SAMPLE;
      this.dprGoodT = 0;
    } else if (fps >= good) {
      this.dprGoodT += SAMPLE;
      this.dprBadT = 0;
    } else {
      this.dprBadT = 0;
      this.dprGoodT = 0;
    }
    if (this.dprBadT >= PERF.downAfter && this.dprStep < last && this.dprCooldown <= 0) {
      this.dprStep++;
      this.dprBadT = 0;
      this.dprCooldown = PERF.cooldown;
      this.applyRenderScale();
    } else if (this.dprGoodT >= PERF.upAfter && this.dprStep > 0 && this.dprCooldown <= 0) {
      this.dprStep--;
      this.dprGoodT = 0;
      this.dprCooldown = PERF.cooldown;
      this.applyRenderScale();
    }
  }

  /**
   * Render pacing target for the current phase (0 = uncapped):
   *   • matches and the colony/necrotech selections keep the gameplay budget — on phones that is
   *     `PERF.matchFps`, but only on 120 Hz-class panels (`rafGapMs`): a 60 fps target on a 90 Hz
   *     panel lands on 45 fps, which is worse than leaving it native.
   *   • menus/lobbies/end screens render at `PERF.menuFps`, dropping to `PERF.idleMenuFps` once the
   *     player has not touched anything for `PERF.idleAfter` seconds (plan §38).
   */
  private frameTargetFps(): number {
    // An explicit cap from the settings owns EVERY phase: the player asked for a ceiling, not for
    // the device-aware curve (which would be a suggestion). `auto` keeps the pacing below.
    if (this.fpsPref !== 'auto') return this.fpsPref;
    if (this.phase === 'playing' || this.phase === 'colony' || this.phase === 'necrotech') {
      return this.rafGapMs < 9.5 ? PERF.matchFps : 0;
    }
    if (this.phase === 'menu' && performance.now() - this.lastInteractionAt > PERF.idleAfter * 1000) {
      return PERF.idleMenuFps;
    }
    return PERF.menuFps;
  }

  // ------------------------------------------------------------ graphics preset

  /**
   * The player picked a graphics level (the game's own menu row or the account shell's GRAPHICS
   * page). The choice is remembered across sessions and applied immediately: everything the preset
   * changes at runtime (render scale, crowd cap, particle and projectile ceilings, damage numbers)
   * moves at once, and the parts that live in the world mesh (terrain vertex density, decoration
   * field) are rebuilt with the next match — the planet is already recreated per match, so nothing
   * has to be disposed just to change a setting.
   */
  setGraphicsPref(pref: QualityPref): void {
    this.qualityPref = pref;
    saveQualityPref(pref);
    const name = resolveQuality(pref);
    this.applyGraphics(name);
    this.ui.setGraphicsPref(pref, name);
    this.ui.toast(
      pref === 'auto'
        ? `GRAPHICS: AUTO — using the ${name.toUpperCase()} preset on this device`
        : `GRAPHICS: ${name.toUpperCase()}`,
      2600
    );
  }

  /** The graphics choice right now (the account shell's GRAPHICS page reads this). */
  get graphicsChoice(): QualityPref {
    return this.qualityPref;
  }

  /** The frame-rate ceiling right now (the account shell's GRAPHICS page reads this). */
  get fpsChoice(): FpsPref {
    return this.fpsPref;
  }

  /**
   * The player picked a frame-rate ceiling. Remembered across sessions and honoured from the very
   * next frame (`frameTargetFps` is read every tick), so the choice is immediately visible in the
   * F1 diagnostics too. A change is a pacing-target change: `updateRenderScale` notices it and
   * restarts its clocks, so no stale window is ever blamed on the new cap.
   */
  setFpsPref(pref: FpsPref): void {
    this.fpsPref = pref;
    saveFpsPref(pref);
    this.ui.setFpsPref(pref);
    this.ui.toast(pref === 'auto' ? 'FRAME RATE: AUTO' : `FRAME RATE: MAX ${pref} FPS`, 2400);
  }

  // ------------------------------------------------------------ customization

  /**
   * The customize screen changed the outfit: remember it, persist it in the browser (so a reload
   * keeps it) and re-dress the local player immediately — in a running match the rig swaps the
   * model instantly and the next net tick tells everyone else.
   */
  private applyAccessorySelection(sel: AccessorySelection): void {
    this.customization = sel;
    saveSelection(sel);
    this.localPlayer?.setAccessories(sel);
    // In a lobby the outfit is on display, so the roster copy travels with it (in a match the
    // PlayerNet tick already carries it).
    const entry = this.roster.get(this.net.myId);
    if (entry && this.phase === 'lobby') {
      entry.acc = selectionToWire(sel);
      if (this.isHost) this.pushLobby();
      else this.net.sendToHost({ t: 'sel', acc: entry.acc });
    }
  }

  /**
   * Plays one of `p`'s equipped ONE-SHOT effects at a world point — a no-op when the slot is
   * empty. `pos`/`up` are copied by the runner, so callers may hand it their scratch vectors.
   */
  private playPlayerFx(cat: EffectCategory, p: Player, pos: THREE.Vector3, up: THREE.Vector3): void {
    const idx = p.accessorySelection[cat];
    if (idx >= 0) this.cosmeticFx.play(cat, idx, pos, up);
  }

  /** Pushes a preset into every system that can honour it live. */
  private applyGraphics(name: QualitySettings['name']): void {
    const next = qualitySettings(name);
    // Mutate the SAME object: `this.settings` is shared by reference with the enemy manager, the
    // planet and the debug overlay, so a replacement would leave stale copies behind.
    Object.assign(this.settings, next);

    this.effects.setCap(next.particles);
    this.combat.setCap(next.maxProjectiles);

    // a new preset starts from a clean slate: undo any watchdog rescue AND the DPR ladder, then
    // apply the new budget. (`dprStep` is reset before the scale is applied, so the new preset
    // starts at its full capped resolution — `applyRenderScale` reads `baseDpr()`, which already
    // includes this preset's own pixelRatio ceiling.)
    this.dprStep = 0;
    this.dprBadT = 0;
    this.dprGoodT = 0;
    this.dprCooldown = 0;
    this.dprWarmup = 4;
    this.applyRenderScale();
    this.resetRescue();
    this.enemyBudget = next.maxEnemies;
    this.enemies.cullTo(this.enemyBudget);

    // Menu world: rebuild it so the terrain detail / decoration change is visible right away.
    // In a match the rebuild already happens per match inside `beginPlaying`.
    if (this.phase === 'menu') {
      const old = this.planet;
      this.planet = new Planet(this.scene, this.settings, PLANET_SEED);
      this.telegraphs.setPlanet(this.planet);
      this.effects.setPlanet(this.planet);
      old.dispose();
    }
  }

  start(): void {
    // Boot takes a few seconds (shaders compile, the planet builds): have the DPR ladder ignore
    // those frames so start-up jank can never lower the render scale.
    this.dprWarmup = 4;
    // Mobile: ask for landscape on the first gesture (fullscreen + orientation lock).
    this.ui.orientation.armAutoLock();
    // A lost GPU context freezes the picture completely. Tell the player instead of leaving them
    // staring at a stopped frame, and let the browser restore it.
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ctxLost = true;
      this.ui.banner('GRAPHICS CONTEXT LOST — RECOVERING', 4000);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.ctxLost = false;
      this.ui.banner('GRAPHICS RESTORED', 2600);
    });
    PerformanceMonitor.init();
    // Idle power saving (plan §38): any input at all restores the full menu frame rate.
    const wake = (): void => { this.lastInteractionAt = performance.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, wake, { passive: true });
    }
    let last = performance.now();
    const loop = (t: number): void => {
      // Schedule the next frame FIRST: if anything below throws, the game must keep running instead
      // of freezing on the last painted frame (an uncaught throw used to kill the loop outright).
      requestAnimationFrame(loop);
      // ONE loop drives everything: sim, effects, HUD updates and the render. A hidden tab is left
      // exactly as the browser left it — no sim, no render, no debug sampling — which is what the
      // visibilitychange handler assumes when it suspends the audio graph (see bindMetaEvents).
      if (document.hidden) {
        last = t;
        this.lastRawTick = t;
        return;
      }
      // Display-refresh estimate from the RAW rAF cadence — sampled before any pacing skips, and
      // the only thing that decides whether a 60 fps match target is worthwhile (see
      // `frameTargetFps`). The minimum over a 3 s window is the PANEL's own cadence: the EMA
      // slides up whenever the machine is slow, the minimum only moves when the display does.
      if (this.lastRawTick > 0) {
        const gap = Math.min(64, t - this.lastRawTick);
        this.rafGapMs += (gap - this.rafGapMs) * 0.05;
        this.rafGapMin = Math.min(this.rafGapMin, gap);
        this.rafGapMinT += gap;
        if (this.rafGapMinT > Game.RAF_MIN_WINDOW) {
          this.rafGapMinT = 0;
          this.rafGapMin = 64;
        }
      }
      this.lastRawTick = t;

      // Render pacing (2026-09 thermal pass): matches keep the gameplay budget, menus/shells only
      // the cheap one, and an untouched menu drops further. A skipped frame skips the WHOLE frame —
      // no sim, no HUD work, no draw — so a 120 Hz phone no longer renders the menu 120×/s.
      const target = this.frameTargetFps();
      const minGap = target > 0 ? 1000 / target : 0;
      const elapsed = t - last;
      if (elapsed + 1.5 < minGap) return;   // not due yet
      const dt = clamp(elapsed / 1000, 0, 0.05);
      last = t;
      try {
        PerformanceMonitor.beginFrame(elapsed);
        PerformanceMonitor.beginUpdate();
        this.update(dt);
        // Render cost, smoothed — the F1 overlay prints it next to the sim cost, so a hot phone can
        // be attributed to the GPU draw or the CPU simulation instead of guessed at.
        PerformanceMonitor.beginRender();
        const r0 = performance.now();
        this.renderer.render(this.scene, this.cam.camera);
        this.renderMs += (performance.now() - r0 - this.renderMs) * 0.1;
        PerformanceMonitor.endRender(this.renderer, this.phase, this.settings.name);
      } catch (err) {
        this.reportCrash(err);
      }
    };
    requestAnimationFrame(loop);

    // Official matches skip every lobby screen: the server already decided the
    // seed, the colonies and the roster (plan §54).
    if (this.officialMatch) this.beginOfficialMatch();
  }

  /** Rate-limited crash reporting: a transient fault must never lock the game up. */
  private reportCrash(err: unknown): void {
    const now = performance.now();
    this.frameErrors++;
    if (now - this.lastCrashAt > 4000) {
      this.lastCrashAt = now;
      const msg = err instanceof Error ? `${err.message}` : String(err);
      console.error('[NECROFALL] frame error (recovered):', err);
      this.ui.toast(`FRAME ERROR RECOVERED — ${msg.slice(0, 90)}`, 6000);
    }
  }

  // ------------------------------------------------------------ official (SpacetimeDB) matches

  /**
   * Boot straight into a server-created OFFICIAL match: seed, elapsed clock and every seat's
   * colony come from the SpacetimeDB rows.
   *
   * THE PROTOCOL (2026-09-29 rework): an official match runs the SAME authority protocol as a
   * P2P room — one seat is the match AUTHORITY and behaves exactly like a P2P host (it runs the
   * world sim and broadcasts `s` snapshots + one-shot events), every other seat behaves exactly
   * like a P2P client (15 Hz pose+stats reports into the authority, single asks for hits, drops
   * and casts). Only the wire differs: `net.relay` routes every P2P send through the
   * SpacetimeDB relay (`match_msg` rows) instead of DataChannels, and incoming rows are fed
   * into the same `onNetMessage` switch — so beacons, the Nexus, enemies, pickups, hits,
   * statuses, kills and everyone's health/level/mutations sync exactly the way they do in P2P.
   * The server still owns the match lifecycle, the roster, the clock and the results.
   */
  private beginOfficialMatch(): void {
    const official = this.officialMatch;
    if (!official) return;
    const { match, bridge } = official;
    this.officialUsage = null;

    // The P2P transport stays idle; every gameplay send is routed through the relay instead.
    this.net.setIdentity(match.meId);
    this.net.goSolo();
    this.net.relay = {
      send: (toId, msg) => bridge.sendNetTo(toId, msg as OfficialNetMessage),
      broadcast: (msg, exceptId) => bridge.broadcastNet(msg as OfficialNetMessage, exceptId),
    };
    this.applyOfficialAuthority(match.authorityId || match.meId);

    this.roster.clear();
    this.players.clear();
    for (const p of match.players) {
      this.roster.set(p.id, {
        id: p.id,
        name: p.name,
        ready: true,
        colony: p.colony,
        // The LOCAL seat's class belongs to the starter picker below: start it UNPICKED (-1) so
        // nothing is highlighted and the timeout fallback fills it in. Remote seats keep the
        // class the server knows.
        nt: p.id === match.meId ? -1 : p.necrotech,
        isHost: false,
        me: p.id === match.meId,
      });
    }
    this.hostOrder = [match.meId, ...match.players.map(p => p.id).filter(id => id !== match.meId)];

    bridge.attachGame({
      applyNetMessage: (id, msg) => this.applyOfficialNetMessage(id, msg),
      setAuthority: id => this.applyOfficialAuthority(id),
      setRoster: players => this.applyOfficialRoster(players),
      matchEnded: result => this.officialMatchEnded(result),
    });

    this.officialElapsedBase = match.elapsed;
    this.officialBootAt = nowSec();

    // REJOIN RESTORE (user ask 2026-09-29): a seat that comes BACK to this match resumes its run
    // — level, perks, mutations and the fused Necrotech — instead of being reset at the starter
    // picker. The run lives in the local save (perks and mutations are client-only, exactly like
    // P2P), keyed by the official match id and validated against the match seed; a genuinely new
    // seat has none and still gets the picker. Covers a reload, a revived tab and a rejoin from
    // the shared `#/match/<id>` link on this browser.
    const saved = this.session.loadRun(`official:${match.matchId}`, match.meId);
    const restore =
      saved && Number(saved.seed) === match.seed && Number(saved.colony) >= 0 && Number(saved.colony) < COLONIES.length
        ? saved
        : null;
    if (restore) {
      // The roster's class picks the base kit `beginPlaying` builds; the saved loadout (including
      // its absorbed stack) is refolded on top the moment the world exists.
      const me = this.roster.get(match.meId);
      if (me && Number.isFinite(Number(restore.ntBase))) me.nt = Math.round(Number(restore.ntBase));
      this.finalizeOfficialNecrotechPhase();
      if (this.localPlayer) {
        this.applySavedRun(this.localPlayer, restore);
        this.maybeOpenQueued();
        this.ui.toast('Survivor restored — Necrotech, level and mutations are back.', 4200);
      }
      return;
    }

    // STARTER NECROTECH SELECTION (user ask 2026-09-28): official matches used to drop every
    // player straight into the fight on the default class with no pick at all. They now open the
    // SAME SELECT NECROTECH screen the P2P flow uses — a LOCAL phase (the server match is already
    // live), so when the countdown ends the world boots from the payload's seed and clock.
    this.beginOfficialNecrotechPhase();
  }

  /** The current relay authority's game id ('' until the provider names one). */
  private officialAuthorityId = '';

  /**
   * Adopt the P2P role the authority implies: authority = host (simulates + broadcasts),
   * anyone else = client (reports to the authority). Runs on every provider push, so a
   * mid-match authority move (the old authority dropped) flips the roles exactly like a P2P
   * host migration: clocks reset, the new authority starts snapshotting immediately.
   */
  private applyOfficialAuthority(id: string): void {
    if (!this.officialMatch) return;
    const authority = id || this.net.myId;
    const amAuthority = authority === this.net.myId;
    const changed = this.officialAuthorityId !== '' && (this.officialAuthorityId !== authority || this.isHost !== amAuthority);
    this.officialAuthorityId = authority;
    this.isHost = amAuthority;
    this.net.isHost = amAuthority;
    this.net.hostId = authority;
    if (changed) {
      this.resetClocks();
      this.snapshotT = 0; // became the authority: push a full snapshot at once
      this.relaySig = ''; // became a client: the next pose goes out immediately
      if (this.phase === 'playing') {
        if (amAuthority) {
          this.ui.banner('YOU ARE NOW THE AUTHORITY', 2600);
          this.ui.toast('The other survivor dropped — you carry this match now.', 4200);
        } else {
          this.ui.banner('AUTHORITY MOVED — MATCH CONTINUES', 2400);
        }
      }
    }
  }

  /**
   * Keep the game roster in step with the match_player rows: names, colonies and classes for
   * everyone (a mid-match joiner gets its real name on every screen), and a seat that LEFT is
   * dropped exactly like a P2P `bye` — body, roster entry and pending pickups.
   */
  private applyOfficialRoster(players: OfficialGamePlayerInfo[]): void {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      if (p.left) continue; // handled below — never (re)add a tombstone
      const r = this.roster.get(p.id);
      if (r) {
        r.name = p.name;
        r.colony = p.colony;
        if (p.id !== this.net.myId && p.necrotech >= 0) r.nt = p.necrotech;
        r.isHost = p.id === this.officialAuthorityId;
      } else {
        this.roster.set(p.id, {
          id: p.id,
          name: p.name,
          ready: true,
          colony: p.colony,
          nt: p.id === this.net.myId ? -1 : p.necrotech,
          isHost: p.id === this.officialAuthorityId,
          me: p.id === this.net.myId,
        });
      }
      const body = this.players.get(p.id);
      if (body) body.name = p.name; // head plates and the kill feed read this
    }
    for (const p of players) {
      if (!p.left) continue;
      if (p.id === this.net.myId) continue; // my own tombstone is the shell's business
      const entry = this.roster.get(p.id);
      if (entry && this.phase === 'playing') {
        this.ui.killFeed(`${entry.name} left the planet`, COLONIES[Math.max(0, entry.colony)].css);
      }
      for (const pk of this.pickups) {
        if (pk.claimedBy === p.id) {
          pk.taken = false;
          pk.claimedBy = '';
        }
      }
      this.roster.delete(p.id);
      const body = this.players.get(p.id);
      if (body) {
        body.dispose();
        this.players.delete(p.id);
      }
      this.peerSync.delete(p.id);
    }
  }

  /**
   * A relayed P2P message from another seat. It rides the SAME `onNetMessage` paths a P2P
   * packet does — poses, snapshots, hits, drops, casts, kills — so the game cannot tell the
   * two worlds apart, which is exactly the point (plan §10).
   */
  applyOfficialNetMessage(id: string, msg: OfficialNetMessage): void {
    this.onNetMessage(id, msg as NetMessage);
  }

  /** The official match's starter-class pick — the P2P SELECT NECROTECH screen, locally authoritative. */
  private beginOfficialNecrotechPhase(): void {
    this.phase = 'necrotech';
    this.phaseTimer = CONFIG.necrotechSelectTime;
    this.onPhaseChanged('necrotech');
    this.ui.banner('NECROTECH SELECTION', 2200);
  }

  /**
   * The starter pick is in (or its clock ran out): build the world and drop into the running
   * match. An UNPICKED local seat rolls a random class (the lobby flow's own timeout rule —
   * nobody is ever left class-less); remote seats keep what the server knows.
   */
  private finalizeOfficialNecrotechPhase(): void {
    const official = this.officialMatch;
    if (!official) return;
    const chosen: Record<string, number> = {};
    for (const r of this.roster.values()) {
      const nt =
        r.nt >= 0 ? r.nt : r.id === this.net.myId ? Math.floor(Math.random() * NECROTECHS.length) : 0;
      r.nt = nt;
      chosen[`nt:${r.id}`] = nt;
      chosen[`colony:${r.id}`] = r.colony;
    }
    // The match is already running server-side: pick the clock up where it is NOW — the payload's
    // elapsed was read before the loading screen and the selection wait, both real match time.
    const elapsed = this.officialElapsedBase + (nowSec() - this.officialBootAt);
    this.beginPlaying(chosen, official.match.seed, elapsed);
    this.ui.banner(COLONIES[this.localPlayer?.colony ?? 0]?.name + ' DEPLOYED', 2200);
  }

  /** True while this instance is an official (server-hosted) match. */
  get isOfficialMatch(): boolean {
    return this.officialMatch !== null;
  }

  /**
   * Account shell: start an OFFICIAL match on this instance. The game usually
   * runs as the shell's planet backdrop (menu phase) when this is called;
   * a P2P session owning the instance throws and the shell reloads instead
   * (the match is server-side, so the reload walks straight back in).
   */
  startOfficialMatch(bridge: OfficialGameBridge, match: OfficialMatchPayload): void {
    if (this.phase === 'playing' || this.phase === 'lobby' || this.phase === 'colony' || this.phase === 'necrotech') {
      throw new Error('This instance is already in a session.');
    }
    this.officialMatch = { bridge, match };
    if (this.phase === 'ended') this.returnToMenu();
    this.beginOfficialMatch();
  }

  /** Account shell shortcut: create a P2P lobby directly (the existing lobby flow, one click). */
  hostP2PLobby(name?: string): void {
    if (this.phase !== 'menu') return;
    void this.createLobby((name ?? '').trim() || this.ui.playerName);
  }

  /** Account shell shortcut: join a P2P lobby by code (the existing join flow). */
  joinP2PLobby(code: string, name?: string): void {
    if (this.phase !== 'menu') return;
    const room = (code ?? '').trim().toUpperCase();
    if (room.length < 4) return;
    void this.joinLobby(room, (name ?? '').trim() || this.ui.playerName);
  }

  /** The official server finished the match: show its authoritative result. */
  officialMatchEnded(result: OfficialMatchResult): void {
    // A LATE server verdict for a match this client already concluded locally (the Nexus capture
    // ends the fight before the server's finish transaction lands): keep the results screen that
    // is already up, but stamp the finalized SpacetimeDB usage summary onto it — that is the
    // number sheet the end screen prints.
    if (this.phase === 'ended') {
      if (result.usage && this.lastEnd) {
        this.officialUsage = result.usage;
        this.showResults(this.lastEnd.winner, this.lastEnd.tiles, this.lastEnd.reason);
      }
      return;
    }
    // 'necrotech' is allowed too: a server finish that lands while the starter picker is open must
    // still show the results — otherwise the countdown would boot a match that is already over
    // (the provider's matchEndEmitted is spent by then, so the verdict would never come again).
    if (this.phase !== 'playing' && this.phase !== 'necrotech') return;
    this.officialUsage = result.usage ?? null;
    this.endMatch(result.winnerColony, result.reason, true);
  }

  // ------------------------------------------------------------ roles

  get playerCount(): number {
    return this.players.size;
  }

  isLocalPlayer(p: Player): boolean {
    return p === this.localPlayer;
  }

  // ------------------------------------------------------------ lobby flow

  private async createLobby(name: string, preferredCode = ''): Promise<void> {
    this.ui.setPlayStatus('Creating lobby…');
    this.audio.unlock();
    this.roster.clear();
    // Hosting is a seat in a room too: take this tab's identity and put the code in the URL so a
    // refresh comes back as the same survivor (and, alone in the room, reopens the same code).
    const wanted = normaliseCode(preferredCode);
    const pid = await this.session.identityFor(wanted);
    this.net.setIdentity(pid);
    this.resumeRun = null;
    this.net.lastRun = null;
    try {
      const code = await this.net.hostLobby(name, wanted);
      this.ui.setPlayStatus('');
      if (!this.net.online) this.ui.setPlayStatus('Signalling offline — you can still play solo. Invite links will not work.');
    } catch {
      this.ui.setPlayStatus('Could not create lobby (signalling unreachable). Try again.', true);
    }
  }

  /**
   * Returns whether the room was reached (the caller decides what to do when it was not).
   * `auto` marks the join that comes from the room code in the URL rather than from the PLAY menu.
   */
  private async joinLobby(code: string, name: string, auto = false): Promise<boolean> {
    const room = normaliseCode(code);
    if (!room) {
      this.ui.setPlayStatus('Enter a valid lobby code.', true);
      return false;
    }
    this.ui.setPlayStatus('Connecting…');
    this.audio.unlock();
    this.roster.clear();
    // Step into this room's seat: the id it already knows us by, plus whatever run we left there.
    // A save from another match (same room, new game) is ignored — see usableRun().
    const pid = await this.session.identityFor(room);
    this.net.setIdentity(pid);
    this.resumeRun = this.session.loadRun(room, pid);
    this.net.lastRun = this.resumeRun;
    try {
      await this.net.joinLobby(room, name, this.resumeRun);
      this.ui.setPlayStatus('');
      return true;
    } catch {
      const reason = this.net.joinError;
      this.net.leave();
      this.net.setIdentity(pid);
      if (!auto) {
        this.ui.setPlayStatus(
          reason === 'unavailable' ? `Room ${room} does not exist (any more).` : 'Could not reach that lobby.',
          true
        );
      }
      return false;
    }
  }

  /**
   * The page was opened (or refreshed) on a room link: there is nothing to decide, so join it and
   * let the room sort the rest out.
   *
   * A host that just reloaded must NOT take its room code back at the first silence. The survivors
   * are electing a new host at that very moment, and that host needs the code to keep the room
   * reachable; snatching it back early left the reloaded host alone in its own lobby while the
   * match carried on somewhere it was never told about. So an ex-host keeps knocking long enough
   * for the election to hand the code to its successor — and takes the code back only when the
   * room really does not come back.
   */
  private async autoJoinRoom(code: string): Promise<void> {
    this.ui.show('play');
    const wasHost = this.session.wasHost(code);
    // A host that had company waits for the whole election; a host that was alone has nobody to
    // wait for, and a guest just retries a few times before giving up.
    const patient = wasHost && this.session.roomSize(code) > 1;
    let patienceUntil = performance.now() + (patient ? 14000 : wasHost ? 4500 : 7000);
    for (let attempt = 1; attempt <= 40; attempt++) {
      this.ui.setPlayStatus(attempt === 1 ? `Rejoining room ${code}…` : `Rejoining room ${code}… (${attempt})`);
      if (await this.joinLobby(code, this.ui.playerName, true)) return;
      if (performance.now() < patienceUntil) {
        await new Promise(resolve => window.setTimeout(resolve, 900));
        continue;
      }
      // The room is gone entirely (nobody holds the code). If this browser hosted it, reopening it
      // is the only way back in — and it is the code everybody already has.
      if (wasHost && this.net.joinError === 'unavailable') {
        this.ui.setPlayStatus(`Room ${code} had ended — reopening it…`);
        const outcome = await this.reopenRoom(code);
        if (outcome === 'hosted') return;
        if (outcome === 'taken') {
          // The code came back into somebody else's hands while we knocked: keep knocking for it.
          patienceUntil = performance.now() + 10000;
          continue;
        }
      }
      break;
    }
    this.ui.prefillLobby(code);
    this.ui.setPlayStatus(`Room ${code} is not answering — it may have finished. Try again, or create your own.`, true);
  }

  /**
   * Tries to take a room code back after a reload. `taken` means somebody else owns it now — the
   * caller must go back to JOINING, because inventing a new code is how a reloaded host ends up
   * in a room of its own while everybody else plays on in the old one.
   */
  private async reopenRoom(code: string): Promise<'hosted' | 'taken' | 'failed'> {
    this.audio.unlock();
    this.roster.clear();
    const room = normaliseCode(code);
    const pid = await this.session.identityFor(room);
    this.net.setIdentity(pid);
    this.resumeRun = null;
    this.net.lastRun = null;
    try {
      await this.net.hostLobby(this.ui.playerName, room, true);
      this.ui.setPlayStatus('');
      if (!this.net.online) this.ui.setPlayStatus('Signalling offline — you can still play solo. Invite links will not work.');
      return 'hosted';
    } catch (err) {
      const type = (err as { type?: string })?.type;
      return type === 'unavailable-id' ? 'taken' : 'failed';
    }
  }

  /** Publishes the room code in the URL and keeps this tab's seat claimed in the browser. */
  private trackRoom(): void {
    const code = this.net.code;
    if (!code || code === 'SOLO') return;
    if (this.trackedRoom && this.trackedRoom !== code) this.session.disown(this.trackedRoom, this.net.myId);
    this.trackedRoom = code;
    this.session.own(code, this.net.myId);
    this.session.setRoomInUrl(code);
    if (this.isHost) this.session.noteHost(code, this.net.myId);
  }

  /** Leaving the room also leaves the link: the URL stops pointing at a match we walked out of. */
  private untrackRoom(): void {
    if (this.trackedRoom) this.session.disown(this.trackedRoom, this.net.myId);
    this.trackedRoom = '';
    this.session.clearRoomFromUrl();
  }

  /**
   * Writes this player's run into the room session. The *local* copy is what matters: perks and
   * mutation state live on the client, so a refresh restores them from here and not from the host.
   */
  private saveRun(): void {
    this.saveT = 5;
    const p = this.localPlayer;
    // OFFICIAL matches persist under the match id (there is no room code there): a rejoin reads
    // this back to hand the survivor to its player — the starter picker is only for new seats.
    const code = this.officialMatch ? `official:${this.officialMatch.match.matchId}` : this.net.code;
    if (!p || !code || code === 'SOLO' || this.phase !== 'playing') return;
    const run = this.session.saveRun({
      code,
      pid: p.id,
      name: p.name,
      seed: this.seed,
      colony: p.colony,
      nt: p.necrotech,
      ntBase: p.baseNecrotech.idx,
      mutated: p.mutated,
      muts: p.mutSources.map(s => ({ idx: s.def.idx, superMut: s.superMut ? 1 : 0 })),
      level: p.level,
      xp: p.xp,
      xpNeed: p.xpNeed,
      perks: p.perks.map(perk => perk.id),
      pendingLevels: p.pendingLevels,
      kills: p.kills,
      bossKills: p.bossKills,
      megaKills: p.megaKills,
      deaths: p.deaths,
      damageDealt: Math.round(p.damageDealt),
      hp: Math.round(p.hp),
    });
    // The freshest copy also travels with a host-migration re-announcement.
    this.net.lastRun = run;
  }

  private onNetOpen(): void {
    this.isHost = this.net.isHost;
    this.trackRoom();
    if (this.isHost) {
      this.ensureRosterSelf();
      this.phase = 'lobby';
      this.ui.show('lobby');
      this.pushLobby();
    } else {
      this.phase = 'lobby';
      this.ui.show('lobby');
      this.ui.updateLobby(
        this.net.code,
        [],
        false,
        this.resumeRun ? 'Connected — restoring your survivor…' : 'Connected — waiting for host…'
      );
      // The lobby shows what everyone is wearing, so the host gets our outfit up front. The hello
      // was sent first on this same channel, so the host's roster already has our seat.
      this.net.sendToHost({ t: 'sel', acc: selectionToWire(this.customization) });
    }
    this.net.setRoster([...this.roster.keys()]);
  }

  private ensureRosterSelf(): void {
    const id = this.net.myId;
    if (!this.roster.has(id)) {
      this.roster.set(id, {
        id,
        name: this.ui.playerName,
        ready: true,
        colony: -1,
        nt: -1,
        isHost: true,
        me: true,
        acc: selectionToWire(this.customization),
      });
    }
    for (const entry of this.roster.values()) {
      entry.isHost = entry.id === this.net.myId;
      entry.me = entry.id === this.net.myId;
      // Our own seat carries our live outfit: the lobby is where everyone's avatar is on display.
      if (entry.me) entry.acc = selectionToWire(this.customization);
    }
  }

  private onPeerJoin(id: string, name: string, resume: boolean, run?: SavedRun | null, rejoin = false): void {
    if (!this.isHost) return;
    if (this.phase === 'ended') {
      this.net.sendTo(id, { t: 'reject', reason: 'This match is already over.' });
      return;
    }
    const known = this.roster.get(id);
    if (!known && this.roster.size >= CONFIG.maxPlayers) {
      this.net.sendTo(id, { t: 'reject', reason: `Match is full (${CONFIG.maxPlayers} players — 3 per colony).` });
      return;
    }
    let entry = known;
    if (!entry) {
      entry = { id, name, ready: resume, colony: -1, nt: -1, isHost: false, me: false };
      this.roster.set(id, entry);
    } else {
      entry.name = name;
    }
    this.net.setRoster([...this.roster.keys()]);
    this.pushLobby();
    // Players can drop into a running match — the room code in the Esc menu is all they need.
    if (this.phase === 'playing') {
      const saved = this.usableRun(run);
      const present = rejoin && this.players.has(id);
      const existing = present ? this.players.get(id) : undefined;
      if (present && existing) {
        // Back after a host migration: the client never stopped playing and rebuilds nothing, so
        // the only thing to fix is this host's copy of the survivor.
        entry.ready = true;
        if (saved) this.applySavedRun(existing, saved, false);
        this.pushLobby();
      } else if (saved) {
        // A survivor this room has seen before: rebuild exactly what they had.
        this.admitResumedPlayer(entry, saved);
      } else {
        // Genuinely new (or the run belongs to another match): ask for a colony and a Necrotech.
        this.askLateSelection(entry);
      }
    } else if (this.phase === 'colony' || this.phase === 'necrotech') {
      // Selections are already open: they need the current phase to leave the lobby screen.
      this.net.sendTo(id, { t: 'phase', p: this.phase, timer: Math.max(0, this.phaseTimer), ord: this.hostOrder });
    }
    this.ui.toast(resume ? `${name} re-joined` : `${name} joined`, 2200);
  }

  /**
   * A save only counts inside the match it was written in: the same room code can host a second
   * game, and rolling an old run into it would hand out someone else's progress.
   */
  private usableRun(run?: SavedRun | null): SavedRun | null {
    if (!run || typeof run !== 'object') return null;
    if (Number(run.seed) !== this.seed) return null;
    if (!(Number(run.colony) >= 0 && Number(run.colony) < COLONIES.length)) return null;
    return run;
  }

  /**
   * Rebuilds a player from their own save — colony, loadout, level, perks and statistics.
   * `resurrect` is false when the player never actually left the match (host migration): there, a
   * corpse has to stay a corpse and the host's copy of the health is the live one.
   */
  private applySavedRun(p: Player, run: SavedRun, resurrect = true): void {
    p.setColony(clamp(Math.round(Number(run.colony) || 0), 0, COLONIES.length - 1));
    // Rebuild the loadout from its STARTING CLASS whenever the save knows it, and let the absorbed
    // stack refold on top. Writing the saved FUSED def straight in as the base made the restore
    // fold it through its own sources a second time — doubled maths and a mangled name. A save
    // without `ntBase` (older format) falls back to the saved def, which is still an exact kit.
    const baseIdx = Math.round(Number(run.ntBase));
    const baseDef = Number.isFinite(baseIdx) ? ALL_NECROTECHS.find(n => n.idx === baseIdx) ?? null : null;
    const saved = defFromSave(run.nt);
    p.setBaseNecrotech(baseDef ?? saved ?? NECROTECHS[0]);
    p.mutated = clamp(Math.round(Number(run.mutated) || 0), 0, 2);
    // Restore the absorbed stack too, so the 3-slot cap keeps behaving after a refresh (and so the
    // next mutation knows which classes it is choosing between). Older saves simply have none.
    if (Array.isArray(run.muts) && run.muts.length > 0) {
      const stack = run.muts
        .map(m => {
          const def = ALL_NECROTECHS.find(n => n.idx === Math.round(Number(m.idx)));
          return def ? { def, superMut: Number(m.superMut) > 0 } : null;
        })
        .filter((s): s is { def: NecrotechDef; superMut: boolean } => s !== null)
        .slice(0, p.mutSlots);
      if (stack.length > 0) {
        p.mutSources = stack;
        p.refoldMutations();
      }
    }
    p.perks.length = 0;
    for (const id of Array.isArray(run.perks) ? run.perks : []) {
      const perk = PERKS.find(k => k.id === id);
      if (perk) p.perks.push(perk);
    }
    p.level = Math.max(1, Math.round(Number(run.level) || 1));
    p.xp = Math.max(0, Math.round(Number(run.xp) || 0));
    p.xpNeed = Math.max(1, Math.round(Number(run.xpNeed) || 100 * Math.pow(1.28, p.level - 1)));
    p.pendingLevels = Math.max(0, Math.round(Number(run.pendingLevels) || 0));
    p.kills = Math.max(0, Math.round(Number(run.kills) || 0));
    p.bossKills = Math.max(0, Math.round(Number(run.bossKills) || 0));
    p.megaKills = Math.max(0, Math.round(Number(run.megaKills) || 0));
    p.deaths = Math.max(0, Math.round(Number(run.deaths) || 0));
    p.damageDealt = Math.max(0, Number(run.damageDealt) || 0);
    // recompute() derives every stat from colony + Necrotech + perks, so it must run before hp.
    p.recompute();
    if (!resurrect) return;
    p.hp = clamp(Math.round(Number(run.hp)) || p.maxHp, 1, p.maxHp);
    p.alive = true;
    p.respawnAsked = false;
    p.dashCharges = p.dashMax;
  }

  /**
   * A player whose run was saved comes back exactly as they were: same colony, loadout, level and
   * perks, dropped back into their colony's landing zone. Only a genuinely new arrival is asked to
   * pick anything — and only an arrival gets a fresh `play` phase (see the migration path in
   * onPeerJoin, where the client keeps the match it already has).
   */
  private admitResumedPlayer(entry: RosterEntry, run: SavedRun): void {
    entry.ready = true;
    entry.colony = clamp(Math.round(Number(run.colony) || 0), 0, COLONIES.length - 1);
    entry.nt = defFromSave(run.nt)?.idx ?? 0;
    let p = this.players.get(entry.id);
    if (!p) {
      p = new Player(this, entry.id, entry.name, false);
      this.players.set(entry.id, p);
    }
    this.applySavedRun(p, run);
    p.spawnAt(this.spawnPointFor(p.colony, p.id));
    this.orientTowardsCluster(p);
    this.net.sendTo(entry.id, {
      t: 'phase',
      p: 'play',
      timer: 0,
      late: 1,
      res: 1,
      seed: this.seed,
      el: Math.round(this.matchElapsed * 100) / 100,
      ord: this.hostOrder,
      assign: { [`colony:${entry.id}`]: entry.colony, [`nt:${entry.id}`]: entry.nt },
    });
    this.ui.killFeed(`${entry.name} is back in the fight`, COLONIES[entry.colony]?.css ?? '#fff');
    this.ui.banner(`${entry.name.toUpperCase()} REJOINED THE BATTLE`, 2600);
    // The roster was pushed before the restored colony/kit existed: refresh it so peers agree.
    this.pushLobby();
  }

  /** Tells a new arrival to pick their colony and Necrotech before they drop in. */
  private askLateSelection(entry: RosterEntry): void {
    entry.ready = true;
    this.net.sendTo(entry.id, {
      t: 'late',
      seed: this.seed,
      hint: this.openColony(),
      el: Math.round(this.matchElapsed * 100) / 100,
      ord: this.hostOrder,
    });
  }

  /** True while a colony still has a free seat — a late arrival must not break the 5-per-colony rule. */
  private colonyHasRoom(colony: number, skipId = ''): boolean {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.colony === colony && p.id !== skipId) n++;
    }
    return n < CONFIG.maxPerColony;
  }

  /**
   * Drops a mid-match arrival into the running battle. The colony and Necrotech are whatever the
   * player picked on their own selection screens (the host only validates them).
   */
  private admitLatePlayer(entry: RosterEntry, colonyHint = NaN, ntHint = NaN): void {
    entry.ready = true;
    const wanted = Number.isFinite(colonyHint) ? clamp(Math.round(colonyHint), 0, COLONIES.length - 1) : this.openColony();
    entry.colony = this.colonyHasRoom(wanted) ? wanted : this.openColony();
    const pool = NECROTECHS.length;
    entry.nt = Number.isFinite(ntHint)
      ? ((Math.round(ntHint) % pool) + pool) % pool
      : Math.floor(Math.random() * pool);
    const def = NECROTECHS[entry.nt];
    let p = this.players.get(entry.id);
    if (!p) {
      p = new Player(this, entry.id, entry.name, false);
      this.players.set(entry.id, p);
    }
    p.setColony(entry.colony);
    p.setBaseNecrotech(def);
    p.perks.length = 0;
    p.recompute();
    p.spawnAt(this.spawnPointFor(entry.colony, entry.id));
    this.orientTowardsCluster(p);
    this.net.sendTo(entry.id, {
      t: 'phase',
      p: 'play',
      timer: 0,
      late: 1,
      seed: this.seed,
      el: Math.round(this.matchElapsed * 100) / 100,
      ord: this.hostOrder,
      assign: { [`colony:${entry.id}`]: entry.colony, [`nt:${entry.id}`]: entry.nt },
    });
    this.ui.killFeed(`${entry.name} dropped in`, COLONIES[entry.colony]?.css ?? '#fff');
    this.ui.banner(`${entry.name.toUpperCase()} JOINED THE BATTLE`, 2600);
    // The roster was pushed before the colony/kit existed: refresh it so every peer agrees.
    this.pushLobby();
  }

  /** The colony with the fewest players — where a late arrival is dropped. */
  private openColony(): number {
    const counts = [0, 0, 0];
    for (const p of this.players.values()) {
      if (p.colony >= 0) counts[p.colony]++;
    }
    let best = 0;
    for (let c = 1; c < counts.length; c++) if (counts[c] < counts[best]) best = c;
    return best;
  }

  private onPeerLeave(id: string): void {
    const entry = this.roster.get(id);
    if (entry && this.phase === 'playing') {
      this.ui.killFeed(`${entry.name} left the planet`, COLONIES[Math.max(0, entry.colony)].css);
    }
    // a drop the departing player was choosing over goes back into the world
    for (const pk of this.pickups) {
      if (pk.claimedBy === id) {
        pk.taken = false;
        pk.claimedBy = '';
      }
    }
    this.roster.delete(id);
    this.players.delete(id);
    this.peerSync.delete(id);
    this.net.setRoster([...this.roster.keys()]);
    if (this.isHost) this.pushLobby();
  }

  private pushLobby(): void {
    if (!this.isHost) return;
    // The election order follows the roster: re-roll it whenever somebody joins or leaves.
    const ids = [...this.roster.keys()];
    if (this.hostOrder.length !== ids.length || ids.some(id => !this.hostOrder.includes(id))) {
      this.refreshHostOrder();
    }
    // Remember how big the room was: a host that reloads uses this to tell a room that can elect
    // a successor (wait for it) from one it was alone in (reopen it at once). See autoJoinRoom.
    this.session.noteRoomSize(this.net.code, ids.length);
    const players = [...this.roster.values()].map(r => ({
      id: r.id, name: r.name, ready: r.ready, colony: r.colony, nt: r.nt,
      isHost: r.id === this.net.hostId, me: r.id === this.net.myId, acc: r.acc,
    }));
    this.net.broadcast({ t: 'lobby', code: this.net.code, players, hostId: this.net.myId, order: this.hostOrder });
    this.updateLobbyUI();
  }

  /**
   * Publishes who takes over if this host disappears: the host first, then every survivor in a
   * random order. The shuffle is what makes the successor random — but the same for everyone.
   */
  private refreshHostOrder(): void {
    const others = [...this.roster.keys()].filter(id => id !== this.net.myId);
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = others[i];
      others[i] = others[j];
      others[j] = tmp;
    }
    this.hostOrder = [this.net.myId, ...others];
    this.net.setHostOrder(this.hostOrder);
  }

  private updateLobbyUI(): void {
    const players = [...this.roster.values()].map(r => ({
      id: r.id,
      name: r.name,
      ready: r.ready,
      colony: r.colony,
      nt: r.nt,
      isHost: r.id === this.net.hostId,
      me: r.id === this.net.myId,
      acc: r.acc,
    }));
    // The gate: the host's own seat counts as ready, every other seat has to say so first.
    const waiting = players.filter(p => p.id !== this.net.myId && !p.ready).length;
    const readyCount = players.length - waiting;
    const canStart = waiting === 0;
    const status = this.isHost
      ? canStart
        ? `${players.length} / ${CONFIG.maxPlayers} connected — everyone is ready, press START`
        : `${players.length} / ${CONFIG.maxPlayers} connected — waiting for ${waiting} player${waiting === 1 ? '' : 's'} to ready up`
      : `${players.length} / ${CONFIG.maxPlayers} connected — ${readyCount} ready — the host starts the match`;
    this.ui.updateLobby(this.net.code, players, this.isHost, status, canStart);
  }

  private toggleReady(): void {
    const me = this.roster.get(this.net.myId);
    if (!me) return;
    me.ready = !me.ready;
    if (this.isHost) {
      this.pushLobby();
    } else {
      this.net.sendToHost({ t: 'sel', ready: me.ready });
    }
  }

  /**
   * Host only: removes one player from the lobby. The seat is dropped here and now (the channel
   * close would do it a moment later, and START must never run against a seat that is already
   * gone), and the peer is told why before its channel is closed.
   */
  private kickPlayer(id: string): void {
    if (!this.isHost || id === this.net.myId) return;
    const entry = this.roster.get(id);
    if (!entry) return;
    this.net.kickPlayer(id, 'You were removed from the lobby by the host.');
    this.onPeerLeave(id);
    this.ui.toast(`${entry.name.toUpperCase()} REMOVED FROM THE LOBBY`, 2400);
  }

  private leaveRoom(): void {
    this.net.leave();
    this.untrackRoom();
    this.isHost = true;
    this.phase = 'menu';
    this.roster.clear();
    this.ui.show('menu');
  }

  private onFatal(reason: string): void {
    this.ui.show('menu');
    this.ui.toast(reason, 6000);
    this.net.leave();
    this.untrackRoom();
    this.phase = 'menu';
  }

  // ------------------------------------------------------------ match flow

  private startMatch(): void {
    if (!this.isHost) return;
    if (this.roster.size === 0) return;
    // EVERY player has to be ready first — the host cannot start over somebody who is still
    // picking a name, reading the cards or half-connected.
    const waiting = [...this.roster.values()].filter(r => r.id !== this.net.myId && !r.ready);
    if (waiting.length > 0) {
      this.ui.toast(
        waiting.length === 1
          ? `${waiting[0].name.toUpperCase()} IS NOT READY YET`
          : `${waiting.length} PLAYERS ARE NOT READY YET`,
        2400
      );
      this.updateLobbyUI();
      return;
    }
    this.beginColonyPhase();
  }

  private beginColonyPhase(): void {
    this.phase = 'colony';
    this.phaseTimer = CONFIG.colonySelectTime;
    // a recall channel from the previous round dies with it
    if (this.recall) this.recall.p.recallHold = false;
    this.recall = null;
    for (const r of this.roster.values()) {
      r.colony = -1;
      r.nt = -1;
    }
    this.broadcastPhase({ p: 'colony', timer: CONFIG.colonySelectTime });
    this.onPhaseChanged('colony');
    this.ui.banner('COLONY SELECTION', 2200);
  }

  private beginNecrotechPhase(assignments: Record<string, number>): void {
    this.phase = 'necrotech';
    this.phaseTimer = CONFIG.necrotechSelectTime;
    for (const [id, colony] of Object.entries(assignments)) {
      const r = this.roster.get(id);
      if (r) {
        r.colony = colony;
        r.nt = -1;
      }
    }
    this.broadcastPhase({ p: 'necrotech', timer: CONFIG.necrotechSelectTime, assign: assignments });
    this.onPhaseChanged('necrotech');
    this.ui.banner('NECROTECH SELECTION', 2200);
  }

  private beginPlaying(assignments: Record<string, number>, seed: number, elapsed = 0): void {
    this.phase = 'playing';
    this.seed = seed;
    this.rng = new Rand(seed ^ 0x5eed);
    // The battlefield centre is a pure function of the seed: pinning it here means the spawn
    // points below (and every peer's copy of them) are already computed from this match's world.
    battlefieldCenterDir(seed, this.towers.centerDir);
    // Late arrivals pick the match clock up from the host instead of restarting it at zero.
    this.matchElapsed = elapsed;
    // fresh performance budget for the match
    this.enemyBudget = this.settings.maxEnemies;
    this.dprStep = 0;
    this.dprBadT = 0;
    this.dprGoodT = 0;
    this.dprCooldown = 0;
    this.dprWarmup = 4;
    this.applyRenderScale();
    // A fresh match starts from a clean rescue slate — the previous match's trim (particle and
    // ambience budgets, hidden scenery) must never bleed into the new world.
    this.resetRescue();
    // …and no cosmetic one-shot from the old match plays on into the new one.
    this.cosmeticFx.clear();
    this.worstMs = 0;
    this.frameErrors = 0;
    this.buildPlayers(assignments);
    this.enemies.reset();
    // Every match rolls its own world and its own Necrophage bestiary from the seed.
    //
    // RANKED matches (plan §32): the server's `map_seed` IS the planet seed, so the world uses it
    // DIRECTLY — that is what makes the planet on the galactic map byte-identical to the planet
    // you land on. Classic matches keep the decorrelating hash. The rank ring tunes the terrain
    // archetype and the ecology's complexity (plan §6/§29).
    const official = this.officialMatch?.match;
    const rankedPlanet = Boolean(official?.ranked && official.planetKey);
    const rankRing = rankedPlanet && (official?.rankRing ?? 255) < 8 ? official!.rankRing! : 0;
    const planetSeed = (official ? seed >>> 0 : (seed * 2654435761 % 4294967296) >>> 0);
    const centerDir = battlefieldCenterDir(seed, new THREE.Vector3());
    const oldPlanet = this.planet;
    this.planet = new Planet(this.scene, this.settings, planetSeed, centerDir, rankRing);
    // Every telegraph is projected on to the CURRENT planet — a system still holding last match's
    // height field would lay its warnings metres off the ground.
    this.telegraphs.setPlanet(this.planet);
    this.telegraphs.clear();
    // clones belong to the old match's world — nothing may survive a reseed
    this.decoys.clear();
    // ground-hugging effects read the same height field, so they move with it
    this.effects.setPlanet(this.planet);
    // Colony bases: one orbiting fortress ship per colony, plus the fixed healing pad under each
    // lane crossing. Built here — before anything is placed on the new planet — because the spawn
    // points below are derived from the same lanes, and `matchElapsed` seats every ship at the
    // orbital angle the match clock says it should already be at.
    this.bases.build(this.planet, seed, this.scene, this.towers.centerDir, this.matchElapsed);
    for (const p of this.players.values()) {
      p.position.copy(this.spawnPointFor(p.colony, p.id));
      p.up.copy(p.position).normalize();
      p.velocity.set(0, 0, 0);
      p.recompute();
    }
    // match-start SPAWN effects: every seat's chosen arrival plays from the first frame (slots
    // with nothing equipped simply stay quiet). Later respawns go through `placeRespawned`.
    for (const p of this.players.values()) this.playPlayerFx('spawn', p, p.position, p.up);
    oldPlanet.dispose();
    const bestiary = (() => {
      // The ranked planet's descriptor regenerates the EXACT world the map showed (plan §32):
      // biome, ecology kind, corruption and the landmark biases that bend the local ecology.
      if (rankedPlanet && official?.planetKey) {
        const parsed = parsePlanetKey(official.planetKey);
        if (parsed) {
          const universeSeed = official.universeSeed ?? DEFAULT_UNIVERSE_SEED;
          const descriptor = planetAt(universeSeed, parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId);
          const biases = Array.from(new Set(this.planet.landmarks.map((l) => l.bias)));
          return this.enemies.generateEcology(seed, factsFromDescriptor(seed, parsed.ring, descriptor, biases));
        }
      }
      return this.enemies.generate(seed);
    })();
    // eslint-disable-next-line no-console
    console.log(
      `[NECROFALL] planet ${this.planet.archetype.biome}${rankedPlanet ? ` (ring ${rankRing})` : ''} · planet seed ${planetSeed} · bestiary seed ${seed}\n` +
      bestiary.genomes.map(g => `  #${g.idx} ${g.name} [${g.tier}${g.role ? `/${g.role}` : ''}${g.locomotion ? `/${g.locomotion}` : ''}${g.visual.rig ? `/${g.visual.rig}` : ''}] hp ${Math.round(g.hp)} spd ${g.speed.toFixed(1)} — ${g.attacks?.map(a => a.name).join(', ') || g.abilities.map(a => ABILITY_META[a].name).join(', ') || 'no abilities'}`).join('\n')
    );
    // Four wardens, four different creatures — the names go to the console log above; the banner
    // states the fact (one name would play favourites with Beacons 2-4).
    this.ui.banner('FOUR GUARDIANS AWAKEN — ONE GUARDS EACH BEACON', 3200);
    this.combat.clear();
    this.abilities.clear();
    this.entityResetPickups();
    for (const buff of this.colonyBuffs) buff.time = 0;
    this.towers.reset();
    this.towers.init(seed);
    // Launch / blitz pads: placed from the same seed, so every peer sees them in the same spots.
    this.pads.build(this.planet, seed);
    this.planet.aimSunAt(this.towers.centerDir);
    // Dense grass is grown once, around the tower zones where the fighting happens, and then left
    // alone for the whole match — generated at match start, never re-grown while you move.
    this.planet.growGrass(this.towers.towers.map(t => t.position));
    this.ui.show('game');
    this.input.setEnabled(true);
    this.cam.snap();
    this.audio.sfx('bossRoar', 0.5);
  }

  private broadcastPhase(msg: Record<string, unknown>): void {
    if (!this.isHost) return;
    if (this.hostOrder.length === 0) this.refreshHostOrder();
    this.net.broadcast({ t: 'phase', ord: this.hostOrder, ...msg });
  }

  private onPhaseChanged(phase: Phase): void {
    if (phase === 'colony') {
      this.ui.show('colony');
      this.refreshColonyUI();
    } else if (phase === 'necrotech') {
      this.input.setEnabled(false);
      this.ui.show('necrotech');
      this.refreshNecrotechUI();
    }
  }

  private refreshColonyUI(): void {
    const counts = [0, 0, 0];
    let selected = 0;
    for (const r of this.roster.values()) {
      if (r.colony >= 0 && counts[r.colony] !== undefined) {
        counts[r.colony]++;
        selected++;
      }
    }
    const me = this.roster.get(this.net.myId);
    // While dropping into a running match the pick is ours alone, so it is never in the roster.
    const mine = this.lateSelect ? this.lateSelect.colony : me ? me.colony : -1;
    this.ui.updateColonySelect(Math.max(0, this.phaseTimer), counts, mine, selected, this.roster.size, !!this.lateSelect);
  }

  private refreshNecrotechUI(): void {
    let selected = 0;
    for (const r of this.roster.values()) if (r.nt >= 0) selected++;
    const me = this.roster.get(this.net.myId);
    const mine = this.lateSelect ? -1 : me ? me.nt : -1;
    // The official variant swaps the "players locked in" line for the starter-pick wording — the
    // picks of the other seats happened before this client ever saw them (user ask 2026-09-28).
    this.ui.updateNecrotechSelect(Math.max(0, this.phaseTimer), mine, selected, this.roster.size, !!this.lateSelect, this.officialMatch !== null);
  }

  private selectColony(idx: number): void {
    if (this.phase !== 'colony') return;
    // Dropping into a running match: this is our own picker, not the lobby's colony phase.
    if (this.lateSelect) {
      if (!this.colonyHasRoomClient(idx)) {
        this.ui.toast(`${COLONIES[idx].name} is full (${CONFIG.maxPerColony} players)`, 2600);
        return;
      }
      this.lateSelect.colony = idx;
      this.lateSelect.step = 'necrotech';
      this.lateSelect.timer = CONFIG.necrotechSelectTime;
      this.phase = 'necrotech';
      this.phaseTimer = this.lateSelect.timer;
      this.onPhaseChanged('necrotech');
      this.audio.sfx('ui');
      return;
    }
    const me = this.roster.get(this.net.myId);
    if (!me) return;
    if (this.isHost) {
      this.hostSetSelection(this.net.myId, { colony: idx });
    } else {
      this.net.sendToHost({ t: 'sel', colony: idx });
    }
    this.audio.sfx('ui');
  }

  private selectNecrotech(idx: number): void {
    if (this.phase !== 'necrotech') return;
    if (this.lateSelect) {
      const colony = Math.max(0, this.lateSelect.colony);
      this.lateSelect = null;
      this.net.sendToHost({ t: 'latepick', colony, nt: idx });
      this.ui.toast('Dropping in…', 2200);
      this.audio.sfx('ui');
      return;
    }
    if (this.isHost || this.officialMatch) {
      // OFFICIAL: the starter pick is a LOCAL phase (the server match is already live), so it
      // is applied to our own roster entry directly on every seat, authority or not.
      this.hostSetSelection(this.net.myId, { nt: idx });
    } else {
      this.net.sendToHost({ t: 'sel', nt: idx });
    }
    this.audio.sfx('ui');
  }

  /** Colony occupancy as this client sees it (the roster carries everyone's colony). */
  private colonyHasRoomClient(colony: number): boolean {
    let n = 0;
    for (const r of this.roster.values()) if (r.colony === colony) n++;
    return n < CONFIG.maxPerColony;
  }

  /** The colony with the fewest players as this client sees it. */
  private openColonyClient(): number {
    const counts = [0, 0, 0];
    for (const r of this.roster.values()) {
      if (r.colony >= 0 && counts[r.colony] !== undefined) counts[r.colony]++;
    }
    let best = 0;
    for (let c = 1; c < counts.length; c++) if (counts[c] < counts[best]) best = c;
    return best;
  }

  /**
   * The drop-in picker runs on the client (there is no host phase for it), so its countdown is
   * ticked here. Nobody is ever left staring at a selection screen: it decides for them.
   */
  private updateLateSelect(dt: number): void {
    const sel = this.lateSelect;
    if (!sel) return;
    sel.timer -= dt;
    this.phaseTimer = Math.max(0, sel.timer);
    if (sel.timer > 0) return;
    if (sel.step === 'colony') {
      this.selectColony(this.openColonyClient());
      return;
    }
    this.selectNecrotech(Math.floor(Math.random() * NECROTECHS.length));
  }

  private hostSetSelection(id: string, patch: { colony?: number; nt?: number; ready?: boolean; acc?: string }): void {
    const entry = this.roster.get(id);
    if (!entry) return;
    if (patch.ready !== undefined) entry.ready = patch.ready;
    if (patch.acc !== undefined) {
      // Normalised against THIS build's catalogs, so a peer with a different build can never make
      // the lobby reference an accessory that does not exist here.
      const sel = selectionFromWire(patch.acc);
      if (sel) entry.acc = selectionToWire(sel);
    }
    if (patch.colony !== undefined) {
      const counts = [0, 0, 0];
      for (const r of this.roster.values()) if (r.colony >= 0) counts[r.colony]++;
      if (counts[patch.colony] >= CONFIG.maxPerColony && entry.colony !== patch.colony) {
        this.net.sendTo(id, { t: 'toast', text: `${COLONIES[patch.colony].name} is full (${CONFIG.maxPerColony} players)` });
        return;
      }
      entry.colony = patch.colony;
    }
    if (patch.nt !== undefined) entry.nt = patch.nt;
    this.pushLobby();
    // A pick only refreshes the screen for the others — the phase countdown runs
    // its full length regardless, so the last picker never ends it early.
    if (this.phase === 'colony') {
      this.refreshColonyUI();
    } else if (this.phase === 'necrotech') {
      this.refreshNecrotechUI();
    }
  }

  private finalizeColonyPhase(): void {
    const assignments: Record<string, number> = {};
    const counts = [0, 0, 0];
    for (const r of this.roster.values()) if (r.colony >= 0) counts[r.colony]++;
    for (const r of this.roster.values()) {
      if (r.colony >= 0) {
        assignments[r.id] = r.colony;
        continue;
      }
      // Random assignment into colonies with capacity. If — somehow — every colony is already at
      // the cap, the player goes to the SMALLEST one rather than a random one, so the format can
      // never drift past 3v3v3 even if a roster is forced in by other means.
      const open: number[] = [];
      for (let c = 0; c < 3; c++) if (counts[c] < CONFIG.maxPerColony) open.push(c);
      let pick: number;
      if (open.length > 0) {
        pick = open[Math.floor(Math.random() * open.length)];
      } else {
        pick = 0;
        for (let c = 1; c < 3; c++) if (counts[c] < counts[pick]) pick = c;
      }
      counts[pick]++;
      r.colony = pick;
      assignments[r.id] = pick;
    }
    this.beginNecrotechPhase(assignments);
  }

  private finalizeNecrotechPhase(): void {
    const chosen: Record<string, number> = {};
    for (const r of this.roster.values()) {
      const nt = r.nt >= 0 ? r.nt : Math.floor(Math.random() * NECROTECHS.length);
      r.nt = nt;
      chosen[`nt:${r.id}`] = nt;
      chosen[`colony:${r.id}`] = r.colony;
    }
    const seed = (Math.random() * 0xffffffff) >>> 0;
    if (this.isHost) {
      this.net.broadcast({ t: 'phase', p: 'play', timer: 0, assign: chosen, seed });
    }
    this.beginPlaying(chosen, seed);
  }

  private buildPlayers(assignments: Record<string, number>): void {
    // remove departed players
    for (const id of [...this.players.keys()]) {
      if (!this.roster.has(id)) {
        this.players.get(id)?.dispose();
        this.players.delete(id);
      }
    }
    for (const r of this.roster.values()) {
      let p = this.players.get(r.id);
      if (!p) {
        p = new Player(this, r.id, r.name, r.id === this.net.myId);
        this.players.set(r.id, p);
      }
      const colony = assignments[`colony:${r.id}`] ?? r.colony;
      const nt = assignments[`nt:${r.id}`] ?? r.nt;
      p.setColony(colony >= 0 ? colony : 0);
      p.setBaseNecrotech(NECROTECHS[nt >= 0 ? nt % NECROTECHS.length : 0]);
      p.perks.length = 0;
      p.recompute();
      p.hp = p.maxHp;
      p.level = 1;
      p.xp = 0;
      p.kills = 0;
      p.bossKills = 0;
      p.megaKills = 0;
      p.deaths = 0;
      p.pendingLevels = 0;
      if (p.isLocal) {
        this.localPlayer = p;
        // The customize screen's choices always dress a freshly-built body.
        p.setAccessories(this.customization);
        p.spawnAt(this.spawnPointFor(p.colony, p.id));
      } else {
        p.spawnAt(this.spawnPointFor(p.colony, p.id));
      }
      this.orientTowardsCluster(p);
    }
    for (const id of [...this.players.keys()]) {
      if (!this.roster.has(id)) this.players.delete(id);
    }
  }

  /**
   * Where a player of `colony` stands: a stable personal slot on its colony fortress deck. The lane
   * depends only on the match seed and the colony, and the slot inside the pad only on the player id
   * — so every peer computes exactly the same spot, spawns and respawns land on the platform, and a
   * whole colony always starts together instead of strung out along 60 m of lane.
   */
  private spawnPointFor(colony: number, id = ''): THREE.Vector3 {
    return this.bases.spawnPoint(this.planet, colony, id, new THREE.Vector3());
  }

  /**
   * True when a point lies inside a friendly no-go volume: a colony base dome (which also covers
   * the healing pad on the ground below it) or a live Beacon shield. Enemies use this to refuse
   * entry, to give up on a player who has taken shelter, to refuse to spawn there, and to block
   * every hit they land on a sheltered survivor (`hitPlayer` with no attacker id).
   */
  inSafeZone(pos: THREE.Vector3, margin = 0): boolean {
    if (this.bases.contains(pos, margin)) return true;
    for (const t of this.towers.towers) {
      if (!t.shieldUp) continue;
      const r = t.shieldR + margin;
      if (pos.distanceToSquared(t.position) < r * r) return true;
    }
    return false;
  }

  /** Points a player (and the local camera rig) at the central tower cluster. */
  private orientTowardsCluster(p: Player): void {
    const center = this.towers.centerDir;
    _v.copy(center).addScaledVector(p.up, -center.dot(p.up));
    if (_v.lengthSq() < 1e-5) tangentBasis(p.up, _v, _v2);
    _v.normalize();
    p.facing.copy(_v);
    if (p.isLocal) this.cam.faceTowards(_v);
  }

  /**
   * A dead player asks to be put back in the fight. Only the host decides when and where that
   * happens — this is the one half of a respawn that must never run on the dying client alone.
   */
  requestRespawn(p: Player): void {
    if (!p || p.respawnAsked) return;
    p.respawnAsked = true;
    if (this.isHost) this.respawnPlayer(p);
    else this.net.sendToHost({ t: 'revive', pid: p.id });
  }

  /** Revives a player at its colony's landing zone and tells every peer where it came back. */
  respawnPlayer(p: Player): void {
    if (!this.isHost || !p) return;
    this.placeRespawned(p, this.spawnPointFor(p.colony, p.id));
    this.net.broadcast({
      t: 'respawn', pid: p.id,
      x: p.position.x, y: p.position.y, z: p.position.z,
      fx: p.facing.x, fy: p.facing.y, fz: p.facing.z,
    });
  }

  /** Shared placement half of a respawn: health, facing, effects and the local overlay. */
  private placeRespawned(p: Player, pos: THREE.Vector3): void {
    p.spawnAt(pos);
    this.orientTowardsCluster(p);
    if (p.isLocal) this.ui.hideRespawn();
    if (p.colony >= 0) this.bases.flashSpawn(p.colony);
    // RESPAWN ARRIVAL (user ask 2026-09-29): the same satisfying pop a recall landing gets — a
    // white flash ring inside the colony colour, a spread disc, sparks and an upward fountain.
    const col = this.playerColor(p);
    this.effects.ring(p.position, p.up, 1.2, col, 0.6, 2.4, 0.8);
    this.effects.ring(p.position, p.up, 0.85, 0xffffff, 0.32, 2.2, 0.9);
    this.effects.disk(p.position, p.up, 1.9, col, 0.5, 1.3, 0.3);
    this.effects.burst(p.position, col, { count: 30, speed: 11, life: 0.7, size: 0.65, gravity: 0 });
    this.effects.burst(p.position, 0xffffff, { count: 14, speed: 11, life: 0.5, size: 0.5, gravity: 0, dir: p.up, jitter: 0.5 });
    // the seat's SPAWN EFFECT: every respawn plays it here (host and clients both run this path)
    this.playPlayerFx('spawn', p, p.position, p.up);
    this.audio.sfx('respawn');
    if (p.isLocal) this.cam.snap();
  }

  /**
   * Host-side respawn clock for everyone else. Clients run their own copy of the timer for the
   * death overlay (and ask the moment it runs out), but a tab that was throttled to a stop must
   * still come back — so the host keeps its own countdown for every player it is not running.
   */
  private updateRespawns(dt: number): void {
    for (const p of this.players.values()) {
      if (p.alive || p.isLocal) continue;
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) this.respawnPlayer(p);
    }
  }

  playerColor(p: Player): number {
    return p.necrotechColor ?? COLONIES[Math.max(0, p.colony)].color;
  }

  /**
   * RECALL — the universal escape hatch (HUD home button, under the minimap). Pressable ANYTIME
   * while alive and in control (user ask 2026-09-29 — the old "stand still for 5 s" idle gate is
   * gone): the press STARTS the channel and LOCKS the body — no movement, no action buttons — for
   * `CONFIG.recall.channelTime`. Any fresh input edge (see `watchRecallInput`), any hit or death
   * breaks it, and the next press starts the count all over again.
   */
  requestRecall(): void {
    const p = this.localPlayer;
    if (!p || this.recall || this.phase !== 'playing' || this.paused) return;
    // dead, mid-picker, or riding a Blitz cube: not recallable (the corpse respawns normally)
    if (!p.alive || p.frozen || p.blitzT > 0) return;
    this.recall = { p, t: CONFIG.recall.channelTime, total: CONFIG.recall.channelTime, since: this.input.lastEdge };
    // the LOCK: while the channel runs the body stands exactly here (Player.update reads this)
    p.recallHold = true;
    p.velocity.set(0, 0, 0);
    this.effects.ring(p.position, p.up, 1.6, 0x8fd7ff, 0.55, 2.6, 0.8);
    // the channel opens on the player's own RECALL EFFECT — local only (peers have no event for
    // a channel starting); they get the arrival/departure plays when it actually lands.
    this.playPlayerFx('recall', p, p.position, p.up);
    this.audio.sfx('ui');
  }

  /**
   * The channel's input watch — runs BEFORE the players simulate (see the playing block) so the
   * very frame that breaks the channel is also the frame control comes back. A recall pressed
   * mid-run survives the run key that was ALREADY held (that is not an edge); a new press, a new
   * queued action, or re-engaging the stick cancels.
   */
  private watchRecallInput(): void {
    const r = this.recall;
    if (!r || this.paused) return;
    if (this.input.lastEdge > r.since) this.cancelRecall(r.p, 'input');
  }

  /**
   * Ends a running recall. Called by the input watch above and directly from
   * `Player.takeDamage` / `applyDotDamage` — taking a hit breaks the channel. Returns true when a
   * recall was actually cut short.
   */
  cancelRecall(p: Player, why: 'input' | 'damage' | 'interrupted' | 'death' = 'input'): boolean {
    const r = this.recall;
    if (!r || r.p !== p) return false;
    this.recall = null;
    p.recallHold = false;
    // A broken channel pops in red at the point it had reached: readable as "that failed" without
    // a wall of text (the banner is reserved for hits, which are the surprising case).
    this.effects.ring(p.position, p.up, 1.8, 0xff6b6b, 0.4, 3.0, 0.7);
    if (p.isLocal && (why === 'damage' || why === 'interrupted')) this.ui.banner('RECALL INTERRUPTED', 1100);
    return true;
  }

  /** Per-frame recall channel: the countdown, the anchor column FX and the completion. */
  private updateRecall(dt: number): void {
    const r = this.recall;
    if (!r || this.paused) return;
    const p = r.p;
    if (!p.alive) { this.cancelRecall(p, 'death'); return; }
    // a picker must never open under a channel: it is an interruption, not an input break
    if (p.frozen) { this.cancelRecall(p, 'interrupted'); return; }
    r.t -= dt;
    // The recall COLUMN (user ask 2026-09-29): a cylinder around the body with streaks sprinting
    // up it and a breathing base ring — fed every frame, so it lives exactly as long as the
    // channel and fades out on its own the moment the calls stop (cancel, death, completion).
    this.effects.recallColumn(p.position, p.up, 0x8fd7ff, dt);
    if (r.t > 0) return;
    // COMPLETE — land on the colony's fortress deck, the same spot a respawn uses. Deliberately
    // NOT `spawnAt`: no free heal, no cooldown wipe (see Player.recallTo).
    const dest = this.spawnPointFor(p.colony, p.id);
    _v3.copy(p.position);
    this.recall = null;
    p.recallHold = false;
    p.recallTo(dest);
    this.recallFx(p.id, _v3, p.position);
    if (p.colony >= 0) this.bases.flashSpawn(p.colony);
    this.audio.sfx('respawn', 0.8);
    const evMsg = {
      t: 'ev', id: 'recall', src: p.id,
      fx: _v3.x, fy: _v3.y, fz: _v3.z,
      tx: p.position.x, ty: p.position.y, tz: p.position.z,
    };
    if (this.isHost) this.net.broadcast(evMsg);
    else this.net.sendToHost(evMsg);
  }

  /**
   * The two-ended recall flash: a departure pop where the body left, a full arrival burst where
   * it lands. Runs for the local completion and for every remote `ev: recall` event.
   */
  private recallFx(srcId: string, from: THREE.Vector3, to: THREE.Vector3): void {
    const p = this.players.get(srcId);
    const color = p ? this.playerColor(p) : 0x8fd7ff;
    const upFrom = _v.copy(from).normalize();
    const upTo = _v2.copy(to).normalize();
    // the seat's RECALL EFFECT runs at both ends of the jump — departure where the body left,
    // arrival where it lands. `recallFx` fires once per machine per recall (local completion, or
    // the relayed `ev`), so each end plays exactly once everywhere.
    if (p) {
      this.playPlayerFx('recall', p, from, upFrom);
      this.playPlayerFx('recall', p, to, upTo);
    }
    this.effects.ring(from, upFrom, 1.4, color, 0.45, 3.0, 0.8);
    this.effects.burst(from, color, { count: 18, speed: 9, life: 0.5, size: 0.5, gravity: 0 });
    // ARRIVAL (user ask 2026-09-29: "satisfying burst"): a white flash ring under the colony
    // colour, a spread disc, two shells of sparks and a fountain straight up — the trip ends with
    // a pop you can feel, not a body quietly fading in.
    this.effects.ring(to, upTo, 1.2, 0xffffff, 0.35, 2.4, 0.9);
    this.effects.ring(to, upTo, 1.7, color, 0.6, 2.6, 0.9);
    this.effects.disk(to, upTo, 2.1, color, 0.5, 1.25, 0.3);
    this.effects.burst(to, color, { count: 40, speed: 13, life: 0.7, size: 0.65, gravity: 0 });
    this.effects.burst(to, 0xffffff, { count: 16, speed: 12, life: 0.5, size: 0.5, gravity: 0, dir: upTo, jitter: 0.5 });
    if (p?.isLocal) this.cam.snap();
  }
  endMatch(winner: number | null, reason?: string, fromServer = false): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.lateSelect = null;
    if (this.recall) this.recall.p.recallHold = false;
    this.recall = null;
    this.paused = false;
    this.ui.hidePauseMenu();
    this.ui.hideRespawn();
    this.input.setEnabled(false);
    for (const p of this.players.values()) {
      p.frozen = true;
      p.velocity.set(0, 0, 0);
      this.combat.clearOwner(p.id);
    }
    this.ui.hideLevelUp();
    this.ui.hidePickup();
    this.pendingLevelUp = null;
    this.pendingPickup = null;
    this.pendingLevelHideT = 0;
    // OFFICIAL: a LOCAL conclusion must not let the still-RUNNING server row pull this player
    // back in while the authoritative finish lands, and the result is reported so the server
    // ends the match for EVERY seat at once — a Nexus capture with its winner, a Necrophage
    // victory (null) as a no-winner finish (user report: the row kept saying "already in a
    // match" after the end screen, and a reload dragged the player back in). A server-projected
    // end (`fromServer`) reports nothing: it IS the finish landing.
    if (this.officialMatch && !fromServer) this.officialMatch.bridge.reportVictory(winner);
    const tiles = this.towers.towers.map((t, i) => ({
      label: t.kind === 'nexus' ? 'Nexus' : `Beacon ${i + 1}`,
      owner: t.owner,
    }));
    this.lastEnd = { winner, tiles, reason };
    if (this.isHost) {
      this.net.broadcast({ t: 'end', winner, tiles, reason: reason ?? '' });
    }
    this.showResults(winner, tiles, reason);
    this.audio.sfx(winner !== null && this.localPlayer && winner === this.localPlayer.colony ? 'victory' : 'defeat');
  }

  private showResults(winner: number | null, tiles: { label: string; owner: number }[], reason?: string): void {
    const me = this.localPlayer;
    const victory = winner !== null && me !== null && winner === me.colony;
    const stats: { k: string; v: string }[] = [];
    const hero: { label: string; value: string; accent?: string }[] = [];
    const matchTime = formatTime(Math.min(this.matchElapsed, CONFIG.matchTime));
    stats.push({ k: 'Match time', v: matchTime });
    if (me) {
      const nt = `${me.necrotechName}${me.mutated ? (me.mutated === 2 ? ' (SUPER MUTATION)' : ' (MUTATED)') : ''}`;
      stats.push({ k: 'Your colony', v: COLONIES[me.colony]?.name ?? '—' });
      stats.push({ k: 'Necromutation level', v: `${me.level}` });
      stats.push({ k: 'Necrotech', v: nt });
      if (me.necrotech.traitLabels?.length) stats.push({ k: 'Combined traits', v: me.necrotech.traitLabels.join(' • ') });
      stats.push({ k: 'Enemies defeated', v: `${me.kills}` });
      stats.push({ k: 'Beacon Guardians slain', v: `${me.bossKills}` });
      stats.push({ k: 'Mega Necrophages slain', v: `${me.megaKills}` });
      stats.push({ k: 'Deaths', v: `${me.deaths}` });
      stats.push({ k: 'Damage dealt', v: `${Math.round(me.damageDealt)}` });
      hero.push({ label: 'ENEMIES DEFEATED', value: `${me.kills}`, accent: '#c94dff' });
      hero.push({ label: 'DAMAGE DEALT', value: `${Math.round(me.damageDealt).toLocaleString()}`, accent: '#ffd166' });
      hero.push({ label: 'LEVEL', value: `${me.level}`, accent: '#7ef0b0' });
      hero.push({ label: 'DEATHS', value: `${me.deaths}`, accent: '#ff6b8a' });
    }
    const c = this.towers.counts();
    const standings = COLONIES.map((col, i) => ({ name: col.name, color: col.css, towers: c[i] }));
    hero.push({ label: 'TOWERS HELD', value: `${me ? c[me.colony] ?? 0 : Math.max(...c)}`, accent: '#8fd7ff' });
    stats.push({ k: 'HELIOS towers', v: `${c[0]}` });
    stats.push({ k: 'AEGIS towers', v: `${c[1]}` });
    stats.push({ k: 'VANTA towers', v: `${c[2]}` });
    // OFFICIAL matches add the SpacetimeDB usage summary (plan §28) — the debug numbers the
    // server keeps per match: ticks, inputs, updates, events and the estimated wire/storage cost.
    const usage = this.officialUsage;
    if (usage) {
      const bytes = (n: number): string =>
        n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
      stats.push({ k: 'SPACETIMEDB match', v: `#${usage.matchId} · ${usage.playerCount} players` });
      stats.push({ k: 'Server ticks', v: usage.serverTicks.toLocaleString() });
      stats.push({ k: 'Input commands', v: usage.inputCommands.toLocaleString() });
      stats.push({ k: 'State updates', v: usage.stateUpdates.toLocaleString() });
      stats.push({ k: 'Server events', v: usage.events.toLocaleString() });
      stats.push({ k: 'Egress (estimated)', v: bytes(usage.egressBytes) });
      stats.push({ k: 'Storage', v: bytes(usage.storageBytes) });
    }
    this.ui.showResults({ victory, winnerColony: winner, tiles, stats, reason, hero, standings, matchTime });
  }

  private returnToMenu(): void {
    this.net.leave();
    this.untrackRoom();
    this.lateSelect = null;
    this.isHost = true;
    this.phase = 'menu';
    this.lastEnd = null;
    this.officialUsage = null;
    this.roster.clear();
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
    this.localPlayer = null;
    this.enemies.reset();
    this.combat.clear();
    this.effects.reset();
    this.cosmeticFx.clear();
    this.entityResetPickups();
    this.input.setEnabled(false);
    this.ui.show('menu');
  }

  // ------------------------------------------------------------ network messaging

  private onNetMessage(from: string, msg: NetMessage): void {
    switch (msg.t) {
      case 'hello': {
        if (!this.isHost) return;
        // The connection already introduced this peer (see onPeerJoin) — just refresh its name.
        const entry = this.roster.get(from);
        if (entry && msg.name) entry.name = String(msg.name).slice(0, 16) || entry.name;
        return;
      }
      case 'lobby': {
        if (this.isHost) return;
        // The lobby carries the room's current code too: a peer that reconnected after a migration
        // may have missed the one-off `code` broadcast, and this is the cheapest place to catch up.
        if (msg.code) this.net.setCode(String(msg.code));
        this.roster.clear();
        for (const p of msg.players as RosterEntry[]) {
          this.roster.set(p.id, {
            id: p.id,
            name: p.name,
            ready: p.ready,
            colony: p.colony,
            nt: p.nt,
            isHost: p.id === msg.hostId,
            me: p.id === this.net.myId,
            acc: typeof p.acc === 'string' ? p.acc : undefined,
          });
        }
        this.net.setRoster([...this.roster.keys()]);
        if (msg.hostId) this.net.setHostIdentity(String(msg.hostId));
        if (Array.isArray(msg.order)) this.net.setHostOrder(msg.order as string[]);
        this.updateLobbyUI();
        if (this.phase === 'colony') this.refreshColonyUI();
        if (this.phase === 'necrotech') this.refreshNecrotechUI();
        return;
      }
      case 'reject': {
        this.ui.setPlayStatus(String(msg.reason ?? 'Unable to join.'), true);
        this.net.leave();
        this.phase = 'menu';
        this.ui.show('play');
        return;
      }
      case 'kick': {
        // The host removed us from the lobby: leave the room for real and say why.
        const reason = String(msg.reason ?? 'You were removed from the lobby.');
        this.net.leave();
        this.untrackRoom();
        this.roster.clear();
        this.phase = 'menu';
        this.ui.show('play');
        this.ui.setPlayStatus(reason, true);
        this.ui.toast(reason, 5000);
        return;
      }
      case 'bye': {
        if (!this.isHost) return;
        this.onPeerLeave(from);
        return;
      }
      case 'sel': {
        if (!this.isHost) return;
        this.hostSetSelection(from, {
          colony: msg.colony !== undefined ? Number(msg.colony) : undefined,
          nt: msg.nt !== undefined ? Number(msg.nt) : undefined,
          ready: msg.ready !== undefined ? Boolean(msg.ready) : undefined,
          acc: typeof msg.acc === 'string' ? msg.acc : undefined,
        });
        return;
      }
      case 'latepick': {
        // A mid-match arrival finished its own colony / Necrotech selection.
        if (!this.isHost || this.phase !== 'playing') return;
        const entry = this.roster.get(from);
        if (!entry) return;
        this.admitLatePlayer(entry, Number(msg.colony), Number(msg.nt));
        return;
      }
      case 'phase': {
        if (this.isHost) return;
        if (Array.isArray(msg.ord)) this.net.setHostOrder(msg.ord as string[]);
        const p = msg.p as string;
        // The room's own phase always wins over a drop-in picker left over from the last match.
        if (p === 'colony') {
          this.lateSelect = null;
          this.phase = 'colony';
          this.phaseTimer = Number(msg.timer ?? CONFIG.colonySelectTime);
          this.onPhaseChanged('colony');
        } else if (p === 'necrotech') {
          this.lateSelect = null;
          this.phase = 'necrotech';
          this.phaseTimer = Number(msg.timer ?? CONFIG.necrotechSelectTime);
          const assign = (msg.assign ?? {}) as Record<string, number>;
          for (const [id, colony] of Object.entries(assign)) {
            const r = this.roster.get(id);
            if (r) r.colony = colony;
          }
          this.onPhaseChanged('necrotech');
        } else if (p === 'play') {
          // `el` is only sent to a late arrival: it is the match clock it joins in progress.
          this.lateSelect = null;
          this.beginPlaying((msg.assign ?? {}) as Record<string, number>, Number(msg.seed ?? 1), Number(msg.el) || 0);
          // `res` says the host rebuilt us from our own save: perks and mutations live on this
          // client only, so the restored run is applied here, on top of the fresh world.
          if (msg.res === 1 && this.localPlayer && this.resumeRun && this.resumeRun.seed === this.seed) {
            this.applySavedRun(this.localPlayer, this.resumeRun);
            // A level that was owed when the page went away is still owed now.
            this.maybeOpenQueued();
            this.ui.toast('Survivor restored — level, perks and loadout are back.', 4200);
          }
        }
        return;
      }
      case 'hostgone': {
        // The host announced it is leaving: start the election now instead of waiting for a timeout.
        this.net.hostGone(msg.reason ? String(msg.reason) : undefined);
        return;
      }
      case 'late': {
        // The room is mid-match and this survivor is new: pick a colony and a Necrotech first.
        if (this.isHost || this.phase === 'ended') return;
        this.resumeRun = null;
        this.lateSelect = { step: 'colony', colony: -1, timer: CONFIG.colonySelectTime };
        this.phase = 'colony';
        this.phaseTimer = CONFIG.colonySelectTime;
        this.onPhaseChanged('colony');
        this.ui.banner('CHOOSE YOUR COLONY', 2200);
        return;
      }
      case 'code': {
        // The new host had to pick a fresh room code — keep the Esc menu honest.
        if (this.isHost) return;
        this.net.setCode(String(msg.code ?? ''));
        return;
      }
      case 'st': {
        if (!this.isHost) return;
        const net = msg.state as PlayerNet;
        if (!net) return;
        let p = this.players.get(net.id);
        if (!p) {
          const r = this.roster.get(net.id);
          p = new Player(this, net.id, r?.name ?? 'Peer', false);
          this.players.set(net.id, p);
        }
        // The client stamped this pose with its own clock: put it on ours before it is stored, so
        // the position we forward (and validate against) is timed by when it happened rather than
        // by when it turned up here.
        const arrival = nowSec();
        let sync = this.peerSync.get(String(net.id));
        if (!sync) {
          sync = new ClockSync();
          this.peerSync.set(String(net.id), sync);
        }
        const sender = Number(msg.time);
        if (Number.isFinite(sender)) sync.observe(sender, arrival);
        const pose = Number(net.pt);
        p.applyNet(net, sync.synced && Number.isFinite(pose) ? sync.toLocal(pose) : arrival);
        return;
      }
      case 'ehit': {
        if (!this.isHost) return;
        const e = this.enemies.byId(Number(msg.eid));
        if (!e || !e.alive) return;
        const src = this.players.get(from);
        if (!src) return;
        const amt = clamp(Number(msg.amt) || 0, 0, 4000);
        // sanity: attacker must be vaguely nearby (or it is a skill cast)
        if (msg.skill !== 1 && src.position.distanceTo(e.position) > src.autoRange + e.radius + 12) return;
        this.hostApplyEnemyDamage(e, amt, from, false);
        return;
      }
      case 'ehits': {
        const list = (msg.list ?? []) as { eid: number; amt: number; src: string; aoe: number }[];
        for (const entry of list) {
          if (!this.isHost && entry.src === this.net.myId && !entry.aoe) continue; // already applied locally
          const e = this.enemies.byId(entry.eid);
          if (!e || !e.alive) continue;
          if (this.isHost) {
            // authority already applied hp — display only
            e.flash(0.85);
            this.showDamageNumber(e, entry.amt, entry.src === this.net.myId);
            continue;
          }
          e.hp -= entry.amt;
          e.flash(0.85);
          this.showDamageNumber(e, entry.amt, entry.src === this.net.myId || entry.aoe === 1);
          if (e.hp <= 0) e.group.visible = false;
        }
        return;
      }
      case 'eev': {
        // A one-off creature event mirrored from the host — a hunter's leap, a boss stun, an
        // enrage, an enraged mechanic winding up. Only meaningful beats cross the wire; AI state
        // and per-frame decisions never do.
        const e = this.enemies.byId(Number(msg.eid));
        const pos = _v.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
        const up = _v2.set(Number(msg.ux) || 0, Number(msg.uy) || 0, Number(msg.uz) || 1).normalize();
        const dir = _v3.set(Number(msg.dx) || 0, Number(msg.dy) || 0, Number(msg.dz) || 0);
        const kind = String(msg.k);
        const radius = Number(msg.r) || 0;
        const lead = Number(msg.lead) || 0;
        const width = Number(msg.w) || 0;
        const accent = e ? e.genome.accent : 0xff2d2d;
        switch (kind) {
          case 'hunttl': {
            // A hunter has committed its pounce: the same terrain-conforming disc the host drew, at
            // the same landing spot, with the same lead — the fill reaching the edge IS the launch.
            this.enemyTelegraph('disc', pos, up, _v3.set(0, 0, 1), radius, 0, lead);
            this.audio.sfx('alarm', 0.45);
            break;
          }
          case 'huntleap':
            this.effects.ring(pos, up, radius * 1.8, accent, 0.4, 2.4, 0.9);
            this.effects.burst(pos, accent, { count: 14, speed: 9, life: 0.4, size: 0.7, gravity: 8, up, spread: 0.6 });
            this.audio.sfx('dash', 0.4);
            break;
          case 'huntland':
            this.effects.ring(pos, up, 1.6, accent, 0.5, 3.4, 1);
            this.effects.disk(pos, up, 4.5, accent, 0.45, 1.25, 0.4);
            this.effects.burst(pos, accent, { count: 22, speed: 14, life: 0.55, size: 0.8, gravity: 14 });
            this.audio.sfx('explode', 0.5);
            break;
          case 'bossstun':
            this.effects.ring(pos, up, radius * 2, 0xffe066, 0.7, 2.6, 1);
            this.audio.sfx('shieldDown', 0.7);
            this.ui.banner(`${e ? e.genome.name : 'BOSS'} STUNNED`, 1800);
            break;
          case 'bossrecover':
            this.effects.ring(pos, up, radius * 1.6, 0xffe066, 0.45, 2, 0.6);
            break;
          case 'bossenrage':
            // the entry wave is replayed on every peer: it is the loudest beat in a boss fight
            this.effects.ring(pos, up, radius * 0.2, 0xff2d2d, 0.95, 5, 1);
            this.effects.wave(pos, up, radius, 0xff2d2d, { dur: 0.9, rings: 4, debris: 40, alpha: 0.95 });
            this.effects.burst(pos, 0xff5a1e, { count: 34, speed: 19, life: 0.8, size: 1, gravity: 10 });
            this.effects.shake(0.5);
            this.audio.sfx('bossRoar', 1);
            // Only the Mega Necrophage announces — see `Enemy.enterEnrage` for why.
            if (e && this.towers.towers[e.towerIdx]?.kind === 'nexus') {
              this.ui.banner(`${e.genome.name} — ENRAGED`, 3000);
            }
            break;
          case 'bossrage':
            this.audio.sfx('alarm', 0.6);
            break;
          case 'bosstl': {
            // One boss danger marker, resolved from the same numbers the host used for the damage.
            const shape = String(msg.shape) as 'disc' | 'ring' | 'lane';
            const colour = Number(msg.c) || 0xff2d2d;
            if (shape === 'lane') {
              if (dir.lengthSq() > 1e-6) this.enemyTelegraph('lane', pos, up, dir.normalize(), radius, width, lead, colour);
            } else {
              this.enemyTelegraph(shape, pos, up, _v3.set(0, 0, 1), radius, 0, lead, colour);
            }
            this.audio.sfx('alarm', 0.6);
            break;
          }
          case 'bossimpact':
            this.effects.burst(pos, 0xff5a1e, { count: 26, speed: 16, life: 0.6, size: 0.9, gravity: 12 });
            this.effects.shake(0.28);
            this.audio.sfx('explode', 0.7);
            break;
        }
        return;
      }
      case 'push': {
        // A peer owns its own movement, so the host cannot move another player's body: it asks,
        // and we apply the shove to our own copy.
        if (!this.localPlayer || !this.localPlayer.alive) return;
        this.localPlayer.velocity.x += Number(msg.vx) || 0;
        this.localPlayer.velocity.y += Number(msg.vy) || 0;
        this.localPlayer.velocity.z += Number(msg.vz) || 0;
        return;
      }
      case 'edie': {
        const ids = (msg.ids ?? []) as number[];
        for (const id of ids) {
          const e = this.enemies.byId(id);
          if (!e) continue;
          const isNear = this.localPlayer ? e.position.distanceTo(this.localPlayer.position) < 60 : false;
          this.effects.burst(e.position, COLONIES[0].color, { count: e.isBoss ? 40 : 14, speed: e.isBoss ? 20 : 9, life: e.isBoss ? 1 : 0.5, size: e.isBoss ? 0.9 : 0.55, gravity: 12 });
          if (isNear) this.audio.sfx(e.isBoss ? 'bossDeath' : 'enemyDeath', 0.6);
          this.enemies.removeVisual(id);
        }
        return;
      }
      case 'pdmg': {
        const pid = String(msg.pid);
        const amt = Number(msg.amt) || 0;
        const pos = _v.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
        this.effects.hitSpark(pos, 0xff5577, 5);
        // The host's copy already took this damage; only the victim's own copy still needs it.
        // (The status that came with the hit rides the separate `pst` message — see below.)
        if (pid === this.net.myId && this.localPlayer) {
          this.localPlayer.takeDamage(amt, msg.src ? String(msg.src) : null, String(msg.kind ?? 'enemy'));
        }
        return;
      }
      case 'pst': {
        // A status the host applied to a player (burn, toxin, a slow…). EVERY peer keeps its own
        // copy's timers for it so the icons above that player count down everywhere, not only on
        // the victim's screen — and so a proxy's icons are not frozen at the value they landed on.
        // The effects themselves stay owner-side; this is the display half.
        const pid = String(msg.pid);
        const p = pid === this.net.myId ? this.localPlayer : this.players.get(pid);
        if (!p) return;
        const st = readStatus(msg.st);
        if (st) applyHitStatus(p, st);
        return;
      }
      case 'pshot': {
        // A remote player's auto-attack round, drawn ici as a visual-only projectile (the owner
        // simulates the real one, hits included). A client's rounds reach the other clients
        // through the host, which is the hub every other relay uses.
        const shooter = this.players.get(String(msg.src));
        if (!shooter) return;
        this.spawnMirrorShot(shooter, msg);
        if (this.isHost && from !== this.net.myId) this.net.broadcast(msg, from);
        return;
      }
      case 'kill': {
        // Host-authoritative death, sent straight to the victim: its own copy may not have felt
        // the blow (a dash i-frame or a shield the host had not seen yet, a lost packet) while
        // the authority has already registered the kill. Without this the client kept walking
        // and its state stream stood the host's corpse back up.
        if (this.isHost) return;
        const pid = String(msg.pid);
        const p = pid === this.net.myId ? this.localPlayer : this.players.get(pid);
        if (!p || !p.alive) return;
        p.forceDeath(msg.src ? String(msg.src) : null);
        return;
      }
      case 'phit': {
        if (!this.isHost) return;
        const target = this.players.get(String(msg.pid));
        const src = this.players.get(from);
        if (!target || !src || !target.alive || !src.alive) return;
        if (target.colony === src.colony) return; // friendly fire never travels
        const amt = clamp(Number(msg.amt) || 0, 0, 400);
        const dist = src.position.distanceTo(target.position);
        if (msg.kind !== 'skill' && msg.kind !== 'burst' && dist > src.autoRange + 14) return;
        // Same delivery as the host's own hits: relay to the peers AND apply it when we are the victim.
        this.hostPlayerDamage(target, amt, src.id, String(msg.kind ?? 'auto'));
        return;
      }
      case 'died': {
        if (!this.isHost) return;
        const victim = this.players.get(String(msg.pid));
        if (!victim) return;
        // The host now kills its own copy the moment damage lands (hostPlayerDamage), so this report
        // usually arrives for a player that is already down — re-applying it would credit the killer
        // twice. Only the first of the two paths registers the death.
        if (!victim.alive) return;
        // Apply the death here instead of waiting for the next state packet: the host's copy is
        // what every snapshot is built from, so this is what kills the body everywhere at once.
        // `forceDeath` arms the corpse too (pose + slide) and registers the kill.
        victim.forceDeath(null);
        return;
      }
      case 'revive': {
        // Host authority: put this player back and let everyone draw the same return. The ask is not
        // gated on our own idea of "dead" — a host that took the match over mid-air may never have
        // seen the death, and leaving a player stuck on the death screen is far worse than a revive.
        if (!this.isHost) return;
        const p = this.players.get(String(msg.pid));
        if (!p) return;
        this.respawnPlayer(p);
        return;
      }
      case 'respawn': {
        const p = this.players.get(String(msg.pid));
        if (!p) return;
        _v3.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
        this.placeRespawned(p, _v3);
        _v4.set(Number(msg.fx) || 0, Number(msg.fy) || 0, Number(msg.fz) || 1).normalize();
        if (_v4.lengthSq() > 1e-5) {
          p.facing.copy(_v4);
          if (p.isLocal) this.cam.faceTowards(_v4);
        }
        return;
      }
      case 'xp': {
        const pid = String(msg.pid);
        if (pid !== this.net.myId || !this.localPlayer) return;
        this.localPlayer.gainXp(Number(msg.amt) || 0);
        if (msg.heal) this.localPlayer.heal(Number(msg.heal));
        return;
      }
      case 'pheal': {
        // the host mends a colony-mate's Siegebreaker field; every peer applies its OWN health
        const pid = String(msg.pid);
        if (pid !== this.net.myId || !this.localPlayer) return;
        this.localPlayer.heal(Number(msg.amt) || 0);
        return;
      }
      case 'pbuff': {
        // the host hands out a Fortress Protocol field aura; again, the peer that owns the player
        // applies it, so buffs are never written across the wire on somebody else's behalf
        const pid = String(msg.pid);
        if (pid !== this.net.myId || !this.localPlayer) return;
        const key = String(msg.key ?? 'takenMul') as keyof Mods;
        this.localPlayer.refreshBuff(
          key, Number(msg.mul) || 1, Number(msg.dur) || 1,
          String(msg.label ?? 'Fortress Field'), '', String(msg.desc ?? '')
        );
        return;
      }
      case 'ev': {
        const id = String(msg.id);
        if (id === 'beaconability') {
          const t = this.towers.towerAt(Number(msg.tx));
          if (!t) return;
          if (this.isHost) {
            const sender = this.players.get(from);
            if (!sender || t.owner !== sender.colony || t.state !== 'shielded') return;
            this.towers.useAbility(t);
            this.net.broadcast({ t: 'ev', id: 'beaconability', tx: t.idx, col: t.owner, src: from }, from);
          } else {
            this.towers.onAbilityEvent(t, Number(msg.col));
          }
          return;
        }
        if (id === 'bossdown') {
          if (this.localPlayer) this.audio.sfx('bossDeath');
          this.ui.banner(String(msg.label ?? 'BOSS DEFEATED'), 2400);
          return;
        }
        if (id === 'shielddown') {
          // The state change itself rides the next snapshot; this is just the audio cue.
          if (this.localPlayer) this.audio.sfx('shieldDown', 0.8);
          return;
        }
        if (id === 'died') {
          // A player was killed elsewhere: play the VICTIM's ELIMINATED effect where the host
          // says the body fell. Host relays for third peers (same pattern as `recall`).
          const victim = this.players.get(String(msg.pid));
          if (victim) {
            _v3.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
            this.playPlayerFx('eliminated', victim, _v3, _v3);
          }
          if (this.isHost && from !== this.net.myId) this.net.broadcast(msg, from);
          return;
        }
        if (id === 'recall') {
          // A remote recall: the body itself arrives with the next pose update, this draws the two
          // ends of the jump — who left where, and who just appeared back at their base.
          this.recallFx(
            String(msg.src),
            _v.set(Number(msg.fx) || 0, Number(msg.fy) || 0, Number(msg.fz) || 0),
            _v2.set(Number(msg.tx) || 0, Number(msg.ty) || 0, Number(msg.tz) || 0)
          );
          if (this.isHost && from !== this.net.myId) this.net.broadcast(msg, from);
          return;
        }
        // regular ability / burst event
        const caster = this.players.get(String(msg.src));
        if (!caster) return;
        const dir = _v2.set(Number(msg.dx) || 0, Number(msg.dy) || 0, Number(msg.dz) || 1).normalize();
        if (id === 'whipfx') {
          // a remote whip crack: exactly the crescent the caster drew on its own screen
          this.abilities.whipVisual(caster, dir, Number(msg.arc) || 2, Number(msg.c) || caster.necrotechColor);
          if (this.isHost && from !== this.net.myId) this.net.broadcast(msg, from);
          return;
        }
        if (id === 'burst') {
          this.abilities.burst(caster, this.isHost ? 'host' : 'remote', Number(msg.rm) || CONFIG.burstRangeMul);
        } else {
          this.abilities.runExternal(id, caster, dir, Number(msg.dist) || 0, Number(msg.dmg) || 0, Number(msg.arc) || 0);
        }
        if (this.isHost && from !== this.net.myId) {
          this.net.broadcast(msg, from);
        }
        return;
      }
      case 'kf': {
        this.ui.killFeed(String(msg.text), String(msg.color ?? '#ffffff'));
        return;
      }
      case 'toast': {
        this.ui.toast(String(msg.text), 3200);
        return;
      }
      case 'offer': {
        if (String(msg.pid) !== this.net.myId) return;
        // Busy (another choice on screen): hand the drop straight back instead of parking it for the
        // whole release window, so somebody else can take it.
        if (!this.openPickupOffer(Number(msg.pk), Number(msg.nt), msg.rare === 1)) {
          this.net.sendToHost({ t: 'release', pid: this.net.myId, pk: Number(msg.pk) });
        }
        return;
      }
      case 'release': {
        // The offered player could not take the drop: free it again for whoever is standing on it.
        if (!this.isHost) return;
        const pk = this.pickups.find(k => k.id === Number(msg.pk));
        if (!pk) return;
        if (pk.claimedBy && pk.claimedBy !== String(msg.pid)) return;
        pk.taken = false;
        pk.claimedBy = '';
        return;
      }
      case 'grab': {
        // A client walked onto a drop and asked for it before our copy of its position caught up.
        if (!this.isHost) return;
        const p = this.players.get(String(msg.pid));
        if (!p || !p.alive || p.frozen) return;
        if (this.now < p.necrotechCdUntil) return;
        const pk = this.pickups.find(k => k.id === Number(msg.pk));
        if (!pk || pk.taken) return;
        // Loose check only: the asking client is always ahead of the copy we can see.
        if (p.position.distanceTo(pk.pos) > CONFIG.player.pickRange + CONFIG.player.pickLagSlack) return;
        this.claimPickup(pk, p);
        return;
      }
      case 'pickres': {
        if (!this.isHost) return;
        const pk = this.pickups.find(p => p.id === Number(msg.pk));
        if (!pk) return;
        const pid = String(msg.pid);
        // somebody else already answered for this drop (an offer that was released may be re-claimed)
        if (pk.claimedBy && pk.claimedBy !== pid) return;
        pk.taken = true;
        pk.claimedBy = pid;
        const choice = String(msg.choice ?? 'keep');
        const superChance = pk.rare ? 0.35 : 0.15;
        const isSuper = choice === 'mutate' && Math.random() < superChance;
        this.net.broadcast({ t: 'ntgot', pid: String(msg.pid), nt: pk.nt, choice, super: isSuper ? 1 : 0, pk: pk.id });
        this.applyNecrotechResult(String(msg.pid), pk.nt, choice, isSuper);
        this.removePickup(pk.id);
        return;
      }
      case 'ntgot': {
        const pid = String(msg.pid);
        if (pid !== this.net.myId) {
          const proxy = this.players.get(pid);
          if (proxy) this.toastNear(proxy.position, `${proxy.name} ${msg.choice === 'mutate' ? (msg.super ? 'SUPER MUTATED' : 'mutated') : msg.choice === 'swap' ? 'swapped Necrotech' : 'kept their Necrotech'}`);
          return;
        }
        if (this.isHost) return; // host already applied
        this.applyNecrotechResult(pid, Number(msg.nt), String(msg.choice), msg.super === 1);
        return;
      }
      case 's': {
        if (this.isHost) return;
        this.matchElapsed = Number(msg.el) || 0;
        // `time` is the host's clock at the moment it sent this; everything in the packet is timed
        // against it, so one observation is enough to align the whole snapshot.
        const arrival = nowSec();
        const sent = Number(msg.time);
        if (Number.isFinite(sent)) this.hostSync.observe(sent, arrival);
        const list = (msg.pl ?? []) as PlayerNet[];
        for (const net of list) {
          let p = this.players.get(net.id);
          if (!p) {
            const r = this.roster.get(net.id);
            p = new Player(this, net.id, r?.name ?? 'Peer', net.id === this.net.myId);
            p.position.set(net.x, net.y, net.z);
            p.up.copy(p.position).normalize();
            this.players.set(net.id, p);
            if (p.isLocal) this.localPlayer = p;
          }
          const pose = Number(net.pt);
          p.applyNet(net, this.hostSync.synced && Number.isFinite(pose) ? this.hostSync.toLocal(pose) : arrival);
        }
        this.enemies.applySnapshot((msg.en ?? []) as never);
        this.towers.applySnapshot((msg.tw ?? []) as never);
        this.applyPickupSnapshot((msg.pk ?? []) as { id: number; x: number; y: number; z: number; nt: number; rare: number; tk: number }[]);
        return;
      }
      case 'end': {
        if (this.isHost) return;
        this.phase = 'ended';
        this.lateSelect = null;
        this.paused = false;
        this.ui.hidePauseMenu();
        this.ui.hideRespawn();
        this.input.setEnabled(false);
        this.ui.hideLevelUp();
        this.ui.hidePickup();
        this.pendingLevelHideT = 0;
        const tiles = (msg.tiles ?? []) as { label: string; owner: number }[];
        this.showResults(msg.winner === null ? null : Number(msg.winner), tiles, msg.reason ? String(msg.reason) : undefined);
        this.audio.sfx('defeat');
        return;
      }
      default:
        return;
    }
  }

  private toastNear(pos: THREE.Vector3, text: string): void {
    if (!this.localPlayer) return;
    if (this.localPlayer.position.distanceTo(pos) > 80) return;
    this.ui.toast(text, 2600);
  }

  // ------------------------------------------------------------ necrotech application

  private applyNecrotechResult(pid: string, nt: number, choice: string, isSuper: boolean): void {
    const p = this.players.get(pid);
    if (!p) return;
    // host-authoritative upgrade cooldown (covers keep / swap / mutate alike)
    p.necrotechCdUntil = this.now + CONFIG.necrotechPickupCd;
    const newDef = defForDrop(nt);
    if (choice === 'swap') {
      p.setBaseNecrotech(newDef);
      if (p.isLocal) this.ui.toast(`SWAPPED → ${newDef.name}`, 3000);
      this.necrotechBurst(p);
    } else if (choice === 'mutate') {
      // HARD LIMIT: at most CONFIG.necrotechMutSlots absorbed Necrotechs on top of the starting
      // class, so the loadout holds three and can never hold a fourth. Once the slots are full the
      // new Necrotech takes an existing one's place — the limit is never silently exceeded.
      const lost = p.absorbNecrotech(newDef, isSuper);
      const fused = p.necrotech;
      const mutation = p.mutation;
      if (p.isLocal) {
        const slots = `MUTATIONS [${p.activeMutations}/${p.mutationLimit}]`;
        if (mutation && !this.discoveredMutations.has(mutation.id)) {
          // A permutation nobody has built yet: the full reveal, name first.
          this.discoveredMutations.add(mutation.id);
          this.ui.showMutationDiscovery(mutation);
        } else if (mutation) {
          this.ui.banner(`${mutation.name} — ${p.activeMutations}/${p.mutationLimit}`, 2400);
        } else {
          this.ui.banner(isSuper ? 'SUPER MUTATION!' : 'MUTATION', 2600);
        }
        const head = lost ? `${lost.name} LOST → ${newDef.name}` : `${newDef.name} ABSORBED`;
        this.ui.toast(
          `${head} ${slots} — ${fused.name} — Skill: ${fused.skill.name}, Ultimate: ${fused.ult.name}${fused.debuffDesc ? ` • Drawback: ${fused.debuffDesc}` : ''}`,
          6000
        );
      }
      this.audio.sfx(isSuper ? 'super' : 'mutation');
      this.necrotechBurst(p);
    } else if (p.isLocal) {
      this.ui.toast('Kept current Necrotech', 2000);
    }
    // Swapping or fusing changes the loadout, so persist it straight away.
    this.saveT = 0;
  }

  // ------------------------------------------------------------ entity helpers

  private entityResetPickups(): void {
    for (const p of this.pickups) {
      p.mesh.removeFromParent();
    }
    this.pickups.length = 0;
  }

  private spawnPickup(pos: THREE.Vector3, nt: number, rare: boolean): void {
    if (!this.isHost) return;
    const id = this.nextPickupId++;
    const mesh = new THREE.Group();
    const stone = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.7, 0),
      new THREE.MeshLambertMaterial({ color: rare ? 0xff4df0 : 0xc94dff, emissive: rare ? 0xff4df0 : 0x8a2bff, flatShading: true, transparent: true })
    );
    const ringGeo = new THREE.RingGeometry(1.1, 1.35, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: rare ? 0xff4df0 : 0xc94dff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.add(stone, ring);
    const position = pos.clone();
    this.planet.projectToSurface(position);
    position.addScaledVector(position.clone().normalize(), 1.4);
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.pickups.push({ id, pos: position, nt, rare, taken: false, claimedBy: '', claimAt: 0, age: 0, mesh });
    this.net.broadcast({ t: 'toast', text: 'NECROTECH DROPPED NEARBY', });
    this.audio.sfx('pickup');
  }

  private removePickup(id: number, fx = true): void {
    const idx = this.pickups.findIndex(p => p.id === id);
    if (idx < 0) return;
    const pk = this.pickups[idx];
    if (fx) this.effects.burst(pk.pos, pk.rare ? 0xff4df0 : 0xc94dff, { count: 18, speed: 9, life: 0.6, size: 0.6, gravity: 0 });
    pk.mesh.removeFromParent();
    this.pickups.splice(idx, 1);
  }

  /** Client-side reconciliation of dropped Necrotech. */
  private applyPickupSnapshot(list: { id: number; x: number; y: number; z: number; nt: number; rare: number; tk: number }[]): void {
    const seen = new Set<number>();
    for (const entry of list) {
      seen.add(entry.id);
      let pk = this.pickups.find(p => p.id === entry.id);
      if (!pk) {
        const mesh = new THREE.Group();
        const stone = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.7, 0),
          new THREE.MeshLambertMaterial({ color: entry.rare ? 0xff4df0 : 0xc94dff, emissive: entry.rare ? 0xff4df0 : 0x8a2bff, flatShading: true, transparent: true })
        );
        const ringGeo = new THREE.RingGeometry(1.1, 1.35, 24);
        ringGeo.rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(
          ringGeo,
          new THREE.MeshBasicMaterial({ color: entry.rare ? 0xff4df0 : 0xc94dff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        mesh.add(stone, ring);
        mesh.position.set(entry.x, entry.y, entry.z);
        this.scene.add(mesh);
        pk = { id: entry.id, pos: mesh.position.clone(), nt: entry.nt, rare: entry.rare === 1, taken: entry.tk === 1, claimedBy: '', claimAt: 0, age: 0, mesh };
        this.pickups.push(pk);
      }
      // the claim state is mirrored so a drop somebody is choosing over stops counting down here too
      pk.taken = entry.tk === 1;
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      if (!seen.has(pk.id)) {
        pk.mesh.removeFromParent();
        this.pickups.splice(i, 1);
      }
    }
  }

  private updatePickups(dt: number): void {
    this.cooldownNudgeT = Math.max(0, this.cooldownNudgeT - dt);
    const expired: number[] = [];
    for (const pk of this.pickups) {
      pk.mesh.rotation.y += dt * 1.4;
      pk.mesh.children[0].rotation.x += dt * 0.8;
      const bob = Math.sin(this.clock * 2 + pk.id) * 0.25;
      pk.mesh.children[0].position.y = bob;
      // A drop nobody grabbed fades away and despawns after CONFIG.pickupLifetime seconds.
      if (!pk.taken) {
        pk.age += dt;
        const left = CONFIG.pickupLifetime - pk.age;
        const k = clamp(left / CONFIG.pickupFade, 0, 1);
        const fade = 0.25 + 0.75 * k;
        pk.mesh.scale.setScalar(0.45 + 0.55 * k);
        pk.mesh.visible = k > 0.02;
        const stone = pk.mesh.children[0] as THREE.Mesh;
        const ring = pk.mesh.children[1] as THREE.Mesh;
        (stone.material as THREE.Material).opacity = fade;
        (ring.material as THREE.Material).opacity = 0.5 * fade;
        if (left <= 0) expired.push(pk.id);
      }
    }
    for (const id of expired) this.removePickup(id, false);
    if (this.phase !== 'playing') return;
    if (!this.isHost) {
      // A client can never see its own position the way the host does: the host only knows where we
      // were ~150 ms ago, which is enough to walk straight past a crystal that despawns in 5s. So we
      // walk up to it locally and ask — the host still authorises the pickup.
      this.requestLocalPickup(dt);
      return;
    }
    for (const pk of this.pickups) {
      if (pk.taken) {
        // an offer nobody answered must not turn the drop into dead weight for the rest of the match
        if (pk.claimedBy && this.now - pk.claimAt > CONFIG.pickupSelectTime + 2) {
          pk.taken = false;
          pk.claimedBy = '';
        } else continue;
      }
      for (const p of this.players.values()) {
        if (!p.alive || p.frozen) continue;
        // Necrotech has a per-player cooldown so upgrades cannot be chained back to back
        if (this.now < p.necrotechCdUntil) {
          if (p.isLocal && this.cooldownNudgeT <= 0 && p.position.distanceTo(pk.pos) <= CONFIG.player.pickRange) {
            this.cooldownNudgeT = 2.5;
            this.ui.toast(`NECROTECH SYSTEM RECHARGING — ${Math.ceil(p.necrotechCdUntil - this.now)}s`, 2000);
          }
          continue;
        }
        // A remote player is drawn from a delayed state stream, so allow for where it really is.
        const reach = CONFIG.player.pickRange + (p.isLocal ? 0 : CONFIG.player.pickLagSlack);
        if (p.position.distanceTo(pk.pos) > reach) continue;
        this.claimPickup(pk, p);
        break;
      }
    }
  }

  /** Hands a drop to one player and asks it to choose — the only way a Necrotech is ever collected. */
  private claimPickup(pk: Pickup, p: Player): void {
    pk.taken = true;
    pk.claimedBy = p.id;
    pk.claimAt = this.now;
    if (p.isLocal) {
      // Already choosing something else? Release it again instead of freezing the drop for 12s.
      if (!this.openPickupOffer(pk.id, pk.nt, pk.rare)) {
        pk.taken = false;
        pk.claimedBy = '';
      }
    } else {
      this.net.sendTo(p.id, { t: 'offer', pid: p.id, pk: pk.id, nt: pk.nt, rare: pk.rare ? 1 : 0 });
    }
  }

  /** Client half of the handshake: notice the crystal under our own feet and ask the host for it. */
  private requestLocalPickup(dt: number): void {
    this.pickupAskT = Math.max(0, this.pickupAskT - dt);
    const p = this.localPlayer;
    if (!p || this.pendingPickup || !p.alive || p.frozen) return;
    if (this.now < p.necrotechCdUntil) {
      for (const pk of this.pickups) {
        if (pk.taken || p.position.distanceTo(pk.pos) > CONFIG.player.pickRange) continue;
        if (this.cooldownNudgeT <= 0) {
          this.cooldownNudgeT = 2.5;
          this.ui.toast(`NECROTECH SYSTEM RECHARGING — ${Math.ceil(p.necrotechCdUntil - this.now)}s`, 2000);
        }
        break;
      }
      return;
    }
    if (this.pickupAskT > 0) return;
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      // Our own view is the truth for our own feet: ask the moment the crystal is in reach.
      if (p.position.distanceTo(pk.pos) > CONFIG.player.pickRange) continue;
      this.pickupAskT = 0.4;
      this.net.sendToHost({ t: 'grab', pid: p.id, pk: pk.id });
      return;
    }
  }

  private openPickupOffer(pk: number, nt: number, rare: boolean): boolean {
    const p = this.localPlayer;
    if (!p || this.pendingPickup) return false;
    const def = defForDrop(nt);
    p.frozen = true;
    // Same rule as the perk picker: while the offer owns the screen the player deals no damage,
    // including the rounds already in the air.
    this.combat.clearOwner(p.id);
    this.pendingPickup = { pickupId: pk, nt, rare, time: CONFIG.pickupSelectTime };
    const rows = (d: NecrotechDef): string[] => {
      const out = [
        `Skill — ${d.skill.name}`,
        `Ultimate — ${d.ult.name}`,
        `Passive — ${d.passiveName}`,
      ];
      if (d.traitLabels?.length) out.push(`Combined — ${d.traitLabels.join(' • ')}`);
      return out;
    };
    this.ui.showPickup(
      { name: p.necrotech.name, role: p.necrotech.role, rows: rows(p.necrotech) },
      { name: def.name, role: def.role, rows: rows(def) },
      // Only the RARE case needs a line: the default "MUTATE fuses both…" explainer was noise on a
      // card whose buttons already say everything (an empty note hides itself in the CSS).
      rare ? 'Rare drop — much higher Super Mutation chance.' : '',
      CONFIG.pickupSelectTime
    );
    return true;
  }

  private resolvePickup(choice: 'keep' | 'swap' | 'mutate'): void {
    const pending = this.pendingPickup;
    if (!pending) return;
    this.pendingPickup = null;
    this.ui.hidePickup();
    if (this.localPlayer) {
      this.localPlayer.frozen = false;
      // starts the 20s Necrotech cooldown whatever the player chose
      this.localPlayer.necrotechCdUntil = this.now + CONFIG.necrotechPickupCd;
    }
    if (this.isHost) {
      const pk = this.pickups.find(p => p.id === pending.pickupId);
      if (!pk) return;
      pk.taken = true;
      const superChance = pending.rare ? 0.35 : 0.15;
      const isSuper = choice === 'mutate' && Math.random() < superChance;
      this.net.broadcast({ t: 'ntgot', pid: this.net.myId, nt: pk.nt, choice, super: isSuper ? 1 : 0, pk: pk.id });
      this.applyNecrotechResult(this.net.myId, pk.nt, choice, isSuper);
      this.removePickup(pk.id);
    } else {
      this.net.sendToHost({ t: 'pickres', pid: this.net.myId, pk: pending.pickupId, choice });
    }
    // A level-up that was granted while the offer owned the screen (or an XP race on a client)
    // must not be stranded now that nothing is pending: open the picker for it.
    this.maybeOpenQueued();
  }

  // ------------------------------------------------------------ damage routing

  /** Runs a host-only delayed callback (ability shaders, venom clouds, delayed blasts). */
  scheduleHost(delay: number, fn: () => void): void {
    if (!this.isHost) return;
    this.abilities.schedule(delay, fn);
  }

  // ------------------------------------------------------------ telegraphs & creature events

  /**
   * Draws a terrain-conforming danger marker.
   *
   * `kind` picks the shape and what `radius` means: a filled `disc` or a hollow `ring` (radius =
   * the danger radius about `centre`), or a `lane` (radius = its LENGTH along `dir`, `width` = its
   * half-width). Both the host that resolves the attack and the clients that only watch call this
   * with the SAME numbers, so what the players see is exactly what gets hit.
   */
  enemyTelegraph(
    kind: 'disc' | 'ring' | 'lane',
    centre: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    width: number,
    dur: number,
    color = 0xff2d2d
  ): void {
    this.telegraphs.emit(kind, centre, up, dir, radius, width, dur, color);
  }

  /**
   * Mirrors one meaningful creature event (a hunter's leap, a boss stun, an enrage, a mechanic
   * landing) to the other peers. Only events cross the wire — never per-frame AI state — and the
   * receiving peer replays the matching VFX locally.
   */
  broadcastEnemyEvent(
    eid: number,
    kind: string,
    pos: THREE.Vector3,
    up: THREE.Vector3,
    radius = 0,
    lead = 0,
    dir?: THREE.Vector3,
    width = 0
  ): void {
    if (!this.isHost) return;
    this.net.broadcast({
      t: 'eev', eid, k: kind,
      x: pos.x, y: pos.y, z: pos.z,
      ux: up.x, uy: up.y, uz: up.z,
      r: radius, lead,
      dx: dir ? dir.x : 0, dy: dir ? dir.y : 0, dz: dir ? dir.z : 0,
      w: width,
    });
  }

  /**
   * Mirrors ONE boss danger marker to the peers. The shape, centre, direction, size and lead all
   * travel, so a client draws exactly the marker the host resolved the damage against — the same
   * contract `enemyTelegraph` has on the host.
   */
  broadcastBossTelegraph(
    eid: number,
    shape: 'disc' | 'ring' | 'lane',
    centre: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3 | null,
    radius: number,
    width: number,
    lead: number,
    color: number
  ): void {
    if (!this.isHost) return;
    this.net.broadcast({
      t: 'eev', eid, k: 'bosstl', shape,
      x: centre.x, y: centre.y, z: centre.z,
      ux: up.x, uy: up.y, uz: up.z,
      dx: dir ? dir.x : 0, dy: dir ? dir.y : 0, dz: dir ? dir.z : 0,
      r: radius, w: width, lead, c: color,
    });
  }

  /**
   * Host-authoritative shove: everyone inside `radius` of `centre` is thrown outward and lifted.
   *
   * Each peer owns its own movement, so the host cannot simply write another player's velocity —
   * exactly like `pheal`, it tells that client to apply the impulse to its OWN player. The host
   * applies its own copy directly.
   */
  pushPlayersFrom(centre: THREE.Vector3, radius: number, speed: number, lift = 0.35): void {
    if (!this.isHost) return;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // a sheltered survivor is not shoved either — the wall stops the shockwave too
      if (this.inSafeZone(p.position, 0)) continue;
      const d = p.position.distanceTo(centre);
      if (d > radius) continue;
      const falloff = 0.45 + (1 - d / radius) * 0.55;
      _v.copy(p.position).sub(centre);
      _v.addScaledVector(p.up, -_v.dot(p.up));
      if (_v.lengthSq() < 1e-4) _v.copy(p.up);
      _v.normalize().multiplyScalar(speed * falloff);
      _v.addScaledVector(p.up, speed * lift * falloff);
      if (p.isLocal) {
        p.velocity.add(_v);
      } else {
        this.net.sendTo(p.id, { t: 'push', vx: _v.x, vy: _v.y, vz: _v.z });
      }
    }
  }

  hostApplyEnemyDamage(e: Enemy, amount: number, ownerId: string | null, aoe: boolean): void {
    if (!e.alive) return;
    // The enrage transition is a one-second window of COMPLETE immunity, so the boss can never be
    // deleted during it. It is the only immunity in the game: after it the boss takes normal damage
    // (raised defence, yes — immunity, no).
    if (e.damageImmune) {
      e.flash(0.4);
      return;
    }
    const dealt = amount * e.guardMul * e.damageTakenMul();
    e.hp -= dealt;
    e.flash(0.85);
    const owner = ownerId ? this.players.get(ownerId) : null;
    if (owner) owner.damageDealt += dealt;
    this.enemyHitBatch.push({ eid: e.id, amt: Math.round(dealt * 10) / 10, src: ownerId ?? '', aoe: aoe ? 1 : 0 });
    // Damage fills the boss's stun bar down at `stunDamageMul` (2x) the health damage dealt,
    // so the bar visibly races the health down; an empty bar is the STUN window.
    if (e.isBoss) e.addStun(dealt * CONFIG.boss.stunDamageMul, this);
    if (e.hp > 0) {
      e.onDamaged(ownerId, dealt, this); // genome reactions: thorn, siphon
      return;
    }
    this.enemies.hostKill(e, ownerId);
  }

  hitEnemy(e: Enemy, amount: number, ownerId: string | null, kind: string, crit = false): void {
    if (!e.alive || amount <= 0) return;
    const aoe = kind === 'skill' || kind === 'ult' || kind === 'burst' || kind === 'dot';
    if (this.isHost) {
      this.hostApplyEnemyDamage(e, amount, ownerId, aoe);
      return;
    }
    const owner = ownerId ? this.players.get(ownerId) : null;
    const mine = ownerId === this.net.myId;
    // A boss in its enrage transition absorbs everything: do not paint a hit the host will refuse.
    if (e.damageImmune) return;
    if (mine) {
      e.hp -= amount;
      this.showDamageNumber(e, amount, true, crit);
      this.net.sendToHost({ t: 'ehit', eid: e.id, amt: amount, skill: aoe ? 1 : 0 });
      if (e.hp <= 0) e.group.visible = false;
    } else if (owner && owner.isLocal) {
      e.hp -= amount;
      this.showDamageNumber(e, amount, true, crit);
    }
  }

  private showDamageNumber(e: Enemy, amount: number, mine: boolean, crit = false): void {
    if (!this.settings.damageNumbers) return;
    if (!this.localPlayer) return;
    if (e.position.distanceTo(this.localPlayer.position) > 70) return;
    this.effects.damageNumber(
      _v.copy(e.position).addScaledVector(e.up, e.radius * 1.1 + 0.5),
      crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`,
      crit ? PALETTE.crit : mine ? 0xffffff : PALETTE.enemyHit,
      crit ? 1.25 : e.isBoss ? 1.1 : 0.92
    );
  }

  hitPlayer(target: Player, amount: number, srcId: string | null, kind: string, status?: HitStatus): void {
    if (!target.alive || amount <= 0) return;
    // Shelter is a REAL wall for the horde: `srcId === null` is every Necrophage source (melee,
    // slams, venom clouds, hunter leaps, boss heavies, enemy rounds), and none of it can reach a
    // survivor standing inside a colony dome (or the healing pad under it) or a live Beacon ward —
    // they are already untargetable there (see `inSafeZone` / `nearestPlayer`). Player-vs-player
    // damage still travels; this check only drops the horde's.
    if (!srcId && this.inSafeZone(target.position, 0)) return;
    const src = srcId ? this.players.get(srcId) : null;
    if (src && src !== target && src.colony === target.colony) return; // no friendly fire
    // PvP pacing (CONFIG.pvp.damageTaken — see the balance note there): every PLAYER-sourced hit is
    // scaled exactly once, here, at the single funnel autos, skills, ults and Necrotech Burst all
    // pass through. `src` is null for the entire horde, so enemy damage is untouched; client-cast
    // hits arrive via `phit`, which calls `hostPlayerDamage` directly, so they are not re-scaled.
    if (src && src !== target) {
      amount *= CONFIG.pvp.damageTaken;
      // A burn / toxin that rides the same hit ticks on the VICTIM's client from this dps, so it is
      // scaled with the hit — otherwise the DoT smuggled the full un-scaled damage past the cap.
      if (status?.dot) status = { ...status, dot: { ...status.dot, dps: status.dot.dps * CONFIG.pvp.damageTaken } };
    }
    if (this.isHost) {
      this.hostPlayerDamage(target, amount, srcId, kind, status);
      return;
    }
    if (srcId === this.net.myId && !target.isLocal) {
      this.net.sendToHost({ t: 'phit', pid: target.id, amt: amount, kind });
    }
  }

  /**
   * Host authority for one player hit: broadcast it to the peers, and apply it HERE to the host's
   * own copy of the victim. The host's copy of every player is what every snapshot is built from, so
   * skipping the local application made the damage vanish: the victim's client took the `pdmg`, then
   * the next snapshot (`applyNet` overwrites `hp` wholesale) put it straight back to full. That was
   * "host cannot damage joined players" — client→host hits worked because the host was the victim
   * and the old code only ever applied damage when `target.isLocal`.
   */
  private hostPlayerDamage(target: Player, amount: number, srcId: string | null, kind: string, status?: HitStatus): void {
    if (!this.isHost) return;
    // Echo Decoy: a hit on a clone drains the clone, never a survivor. There is no health bar to
    // replicate for a double, so it stops right here instead of going over the wire.
    if ((target as unknown as { isDecoy?: boolean }).isDecoy) {
      target.takeDamage(amount, srcId, kind);
      return;
    }
    this.net.broadcast({
      t: 'pdmg', pid: target.id, amt: Math.round(amount * 10) / 10, src: srcId ?? '',
      kind,
      x: target.position.x, y: target.position.y, z: target.position.z,
    });
    // `sendTo`/`broadcast` never loop back to this peer, so this is applied exactly once per hit.
    target.takeDamage(amount, srcId, kind);
    if (status) {
      // The status rides its OWN broadcast so every peer can draw it above the victim's head: the
      // old st-on-pdmg form only ever reached the victim, so the icons other peers saw had frozen
      // timers and a third player saw nothing at all.
      applyHitStatus(target, status);
      this.net.broadcast({ t: 'pst', pid: target.id, st: serialiseStatus(status) });
    }
  }

  /**
   * Mirrors one of the LOCAL player's auto-attack rounds to every other peer as a
   * visual-only projectile. Player shots are simulated by their owner (hit registration included),
   * so without this an enemy survivor was hosed by rounds only the shooter could see. The host
   * broadcasts; a client hands the round up and the host relays it to the rest.
   */
  mirrorShot(
    srcId: string,
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    color: number,
    o: { radius: number; elong: number; ember: boolean; size: number; life: number }
  ): void {
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const msg: NetMessage = {
      t: 'pshot', src: srcId,
      x: r2(pos.x), y: r2(pos.y), z: r2(pos.z),
      dx: r2(dir.x), dy: r2(dir.y), dz: r2(dir.z),
      v: Math.round(speed * 10) / 10,
      c: color,
      r: r2(o.radius), e: r2(o.elong), s: r2(o.size), l: r2(o.life),
      k: o.ember ? 1 : 0,
    };
    if (this.isHost) this.net.broadcast(msg);
    else this.net.sendToHost(msg);
  }

  /** Mirrors a local whip crack to the other peers (the `whipfx` branch of the `ev` handler). */
  mirrorWhip(srcId: string, aim: THREE.Vector3, arc: number, color: number): void {
    const msg: NetMessage = {
      t: 'ev', id: 'whipfx', src: srcId,
      dx: aim.x, dy: aim.y, dz: aim.z,
      arc: Math.round(arc * 100) / 100, c: color,
    };
    if (this.isHost) this.net.broadcast(msg);
    else this.net.sendToHost(msg);
  }

  /** Spawns the visual half of a mirrored player round (see `mirrorShot`). */
  private spawnMirrorShot(shooter: Player, msg: NetMessage): void {
    const dir = _v.set(Number(msg.dx) || 0, Number(msg.dy) || 0, Number(msg.dz) || 1);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    this.combat.spawn({
      pos: _v2.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0),
      dir,
      speed: clamp(Number(msg.v) || 60, 1, 300),
      damage: 0,
      ownerId: shooter.id,
      colony: shooter.colony,
      color: Number(msg.c) || shooter.necrotechColor,
      radius: clamp(Number(msg.r) || 0.4, 0.1, 3),
      elong: clamp(Number(msg.e) || 1, 1, 6),
      ember: msg.k === 1,
      size: clamp(Number(msg.s) || 1, 0.2, 4),
      life: clamp(Number(msg.l) || 2.4, 0.1, 6),
      visual: true,
    });
  }

  registerPlayerKill(victim: Player): void {
    if (!this.isHost) return;
    const killer = victim.lastAttackerId ? this.players.get(victim.lastAttackerId) : null;
    if (killer && killer !== victim) {
      killer.kills++;
      const xp = 70 + victim.level * 30;
      this.awardXp(killer.id, xp, killer.mods.lifesteal);
      this.broadcastKillFeed(`${killer.name} eliminated ${victim.name}`, COLONIES[killer.colony]?.css ?? '#fff');
    } else {
      this.broadcastKillFeed(`${victim.name} fell to the Necrophages`, '#8a7ba8');
    }
    victim.lastAttackerId = null;
  }

  onPlayerDied(p: Player): void {
    // Resolve the killer BEFORE anything else runs: `registerPlayerKill` consumes (and nulls) the
    // attribution, and the local death overlay that follows still needs the name. Reading
    // `lastAttackerId` after the host's own kill registration made every HOST death by a player
    // read "The Necrophages took you." — the one death that happens on the authoritative machine.
    const killer = p.lastAttackerId ? this.players.get(p.lastAttackerId) : null;
    if (this.isHost) {
      this.registerPlayerKill(p);
      // The host's copy is the authority: tell the victim it is down even when its own copy
      // swallowed the blow (a dash i-frame or a shield the host had not seen yet). Without this
      // the client kept walking and its state stream stood the host's corpse back up.
      if (!p.isLocal) this.net.sendTo(p.id, { t: 'kill', pid: p.id, src: killer ? killer.id : '' });
      // ELIMINATED effect: the host is the one machine that sees EVERY death (its own, and its
      // authoritative copy of everyone else's), so it is the single broadcaster for this event.
      // Each peer then plays the VICTIM's equipped effect at the reported spot.
      if (p.accessorySelection.eliminated >= 0) {
        this.playPlayerFx('eliminated', p, p.position, p.up);
        this.net.broadcast({ t: 'ev', id: 'died', pid: p.id, x: p.position.x, y: p.position.y, z: p.position.z });
      }
    } else if (p.isLocal) {
      this.net.sendToHost({ t: 'died', pid: p.id });
    }
    if (p.isLocal) {
      this.ui.showRespawn(CONFIG.player.respawnTime, killer && killer !== p ? killer.name : null);
    }
  }

  broadcastKillFeed(text: string, color: string): void {
    if (!this.isHost) return;
    this.net.broadcast({ t: 'kf', text, color });
    this.ui.killFeed(text, color);
  }

  awardXp(pid: string, amount: number, heal = 0): void {
    if (!this.isHost) return;
    const p = this.players.get(pid);
    if (!p) return;
    if (p.isLocal) {
      p.gainXp(amount);
      if (heal) p.heal(heal);
      return;
    }
    this.net.sendTo(pid, { t: 'xp', pid, amt: amount, heal });
  }

  onEnemyKilled(e: Enemy, killerId: string | null): void {
    // FX for everyone
    this.effects.burst(e.position, e.isBoss ? 0xff2d6b : 0x9a6bff, {
      count: e.isBoss ? 60 : 16,
      speed: e.isBoss ? 22 : 10,
      life: e.isBoss ? 1.1 : 0.6,
      size: e.isBoss ? 1 : 0.6,
      gravity: 12,
    });
    this.killBatch.push(e.id);
    const killer = killerId ? this.players.get(killerId) : null;
    if (killer) {
      killer.kills++;
      const xp = e.xpValue;
      this.awardXp(killer.id, xp, killer.mods.lifesteal);
      // ALLY XP SHARE (user ask 2026-09-29): a same-colony ally standing inside the KILLER'S
      // auto-attack ring earns the kill's XP too — the ring is the squad's footprint, so a
      // colony pushing together levels together. The killer keeps its own award (and lifesteal);
      // a share needs the ally ALIVE, in the same colony and within `autoRange` of the killer.
      const ring = killer.autoRange * killer.autoRange;
      for (const ally of this.players.values()) {
        if (ally === killer || !ally.alive || ally.colony !== killer.colony) continue;
        if (ally.position.distanceToSquared(killer.position) > ring) continue;
        this.awardXp(ally.id, xp);
      }
      // Fused loadout trait: the killer's rounds leave a corpse burst — fire, toxin or raw force —
      // that catches whatever was standing next to the kill. Cadaver Bloom (Necromutation) stacks
      // its own blast on top, so the perk and a detonating fusion add up instead of replacing.
      const nova = (killer.necrotech.explodeOnKill ?? 0)
        + (killer.mods.killBoom > 0 ? 2.4 + 1.1 * (killer.mods.killBoom - 1) : 0);
      if (nova > 0 && this.isHost) {
        const fire = killer.necrotech.stats.status === 'burn';
        const toxic = killer.necrotech.stats.status === 'poison';
        const color = fire ? 0xff7a2d : toxic ? 0x9dff6b : 0xc94dff;
        const center = e.position.clone();
        const up = e.up.clone();
        this.effects.ring(center, up, 0.8, color, 0.45, nova * 1.2, 0.9);
        this.effects.disk(center, up, nova, color, 0.4, 1.6, 0.3);
        this.effects.burst(center, color, { count: 22, speed: 13, life: 0.5, size: 0.7, gravity: fire ? -6 : 8 });
        this.effects.shake(0.12);
        this.audio.sfx('explode', 0.35);
        const hit = this.enemies.query(center.x, center.y, center.z, nova + 3, []);
        for (const other of hit) {
          if (other === e || !other.alive) continue;
          const rr = nova + other.radius;
          if (other.position.distanceToSquared(center) > rr * rr) continue;
          this.hitEnemy(other, killer.autoDamage * 1.5, killer.id, 'burst');
          if (fire) other.applyStatus('burn', killer.necrotech.stats.statusPower, killer.id);
          else if (toxic) other.applyStatus('poison', killer.necrotech.stats.statusPower, killer.id);
        }
      }
    }
    if (e.isBoss) {
      if (killer) killer.bossKills++;
      const tower = this.towers.towerAt(e.towerIdx);
      // The colony objective tracks the Nexus Mega Necrophage only — beacon Wardens are their own
      // step (the tower flipping to 'open'), and ticking the Mega objective for them was a bug.
      if (killer && tower && tower.kind === 'nexus') killer.megaKills++;
      if (tower) {
        tower.state = 'open';
        tower.bossId = -1;
        tower.captureProgress = 0;
        const label = tower.kind === 'nexus' ? 'MEGA NECROPHAGE DEFEATED' : `${beaconName(tower.idx).toUpperCase()} GUARDIAN SLAIN — TOWER OPEN`;
        this.net.broadcast({ t: 'ev', id: 'bossdown', label, src: this.net.myId });
        this.ui.banner(label, 2800);
        this.audio.sfx('bossDeath');
        this.effects.ring(tower.position, tower.up, 4, 0xff2d6b, 1.2, 3, 1);
      }
      const nt = Math.floor(Math.random() * ALL_NECROTECHS.length);
      this.spawnPickup(e.position, nt, false);
    } else {
      // A Hunter Necrophage is the apex of the bestiary — the one creature in the match built to
      // hunt PLAYERS — so its death is a beat worth telling the whole match about. It rides the same
      // call-out channel a guardian's death does, which gets the identical words and the same sting
      // to every peer without adding a message kind.
      if (e.genome?.hunter) {
        const hunterLabel = `${e.genome.name.toUpperCase()} DEFEATED`;
        this.net.broadcast({ t: 'ev', id: 'bossdown', label: hunterLabel, src: this.net.myId });
        this.ui.banner(hunterLabel, 2800);
        this.audio.sfx('bossDeath', 0.8);
      }
      // genome death abilities
      const abilities = e.genome?.abilities ?? [];
      // Volatile: the `detonate` ability and the `explosive` behaviour trait are the SAME blast.
      // The trait only widens it, which is what lets a genome be volatile without also carrying
      // the ability — the body grew the sacs, so the body goes up.
      const blastR = Math.max(abilities.indexOf('detonate') >= 0 ? 6.5 : 0, e.genome.behavior.deathBlast);
      if (blastR > 0) {
        this.effects.ring(e.position, e.up, blastR * 0.22, e.genome.accent, 0.55, 3, 1);
        this.effects.burst(e.position, e.genome.accent, { count: 26, speed: 15, life: 0.6, size: 0.8, gravity: 12 });
        this.effects.shake(0.18);
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (p.position.distanceTo(e.position) > blastR) continue;
          this.hitPlayer(p, e.genome.damage * 1.3, null, 'enemy');
        }
      }
      // Mitosis is limited: a creature can split at most MAX_SPLIT_GEN times down its ancestry,
      // and every generation is smaller, softer and worth less XP — so a pack can never replicate
      // endlessly. Once the line is exhausted the creature simply dies.
      if (this.isHost && abilities.indexOf('split') >= 0) {
        if (e.splitGen < MAX_SPLIT_GEN && this.enemies.hasRoom) {
          const gen = e.splitGen + 1;
          for (let i = 0; i < 2; i++) {
            _v.copy(e.facing).multiplyScalar(i === 0 ? 2.4 : -2.4).add(e.position);
            this.planet.projectToSurface(_v);
            const child = this.enemies.spawn(e.genomeIdx, _v, { hpMul: 0.62, splitGen: gen });
            this.effects.burst(child.position, e.genome.accent, { count: 10, speed: 8, life: 0.45, size: 0.5, gravity: 4 });
          }
        } else {
          // the final generation cannot split again
          this.effects.disk(e.position, e.up, 2, e.genome.accent, 0.4, 1.2, 0.25);
        }
      }
      // Brood is limited the same way — otherwise brood-mothers would chain into a swarm that
      // never ends. The first generation may brood once; its children cannot.
      if (this.isHost && abilities.indexOf('spawnlings') >= 0 && e.splitGen < MAX_BROOD_GEN && this.enemies.hasRoom) {
        const gen = e.splitGen + 1;
        const small = this.enemies.bestiary.smallIdx;
        const kinIdx = small[Math.floor(Math.random() * small.length)] ?? 0;
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2;
          _v.copy(e.position).addScaledVector(e.up, 0).normalize();
          _v2.copy(e.up).cross(_v3.set(0, 1, 0)).normalize();
          _v3.copy(e.up).cross(_v2).normalize();
          _v4.copy(e.position)
            .addScaledVector(_v2, Math.cos(ang) * 2.2)
            .addScaledVector(_v3, Math.sin(ang) * 2.2);
          this.planet.projectToSurface(_v4);
          const k = this.enemies.spawn(kinIdx, _v4, { hpMul: 0.8, splitGen: gen });
          this.effects.burst(k.position, k.genome.accent, { count: 8, speed: 6, life: 0.4, size: 0.5, gravity: 6 });
        }
      }
      // Named enemies are worth a Necrotech: apex minibosses and elite/rare spawns drop too,
      // not just the Beacon guardians. Miniboss drops are deliberately uncommon.
      if (e.genome.hunter) {
        // HUNTERS always pay out. At most two are ever on the field, one arrives every 1-1.5 min,
        // and putting one down is a set-piece fight — the trophy for it must never be a dice roll.
        // (This branch also swears off the apex 20% below: `makeHunter` builds them at tier 'apex',
        // so without it here a hunter would roll that low chance instead.)
        const nt = Math.floor(Math.random() * ALL_NECROTECHS.length);
        this.spawnPickup(e.position, nt, false);
      } else if (e.elite) {
        if (Math.random() < 0.5) {
          const nt = Math.floor(Math.random() * ALL_NECROTECHS.length);
          this.spawnPickup(e.position, nt, true);
        }
      } else if (e.genome.tier === 'apex') {
        if (Math.random() < 0.2) {
          const nt = Math.floor(Math.random() * ALL_NECROTECHS.length);
          this.spawnPickup(e.position, nt, false);
        }
      } else if (Math.random() < 0.02) {
        // rare drop from any large Necrophage keeps the mid-game flowing
        const nt = Math.floor(Math.random() * ALL_NECROTECHS.length);
        this.spawnPickup(e.position, nt, false);
      }
    }
  }

  /**
   * The Nexus is the win condition: whoever controls it takes the match, full stop. There is no
   * majority to count — holding the Nexus IS the victory.
   */
  onNexusCaptured(colony: number): void {
    this.endMatch(colony, `${COLONIES[colony]?.name ?? 'A COLONY'} CONTROLS THE NEXUS`);
  }

  onPlayerLevelUp(p: Player): void {
    if (p.isLocal) {
      if (this.pendingLevelUp || this.pendingPickup) {
        this.queuedLevels++;
        return;
      }
      this.openLevelUp(p);
    } else if (this.isHost) {
      // already tracked; proxies just level up visually
    }
  }

  private openLevelUp(p: Player): void {
    const exclude = new Set(p.perks.map(perk => perk.id));
    const perks = rollPerks(this.rng, 3, exclude);
    if (perks.length === 0) {
      // Every perk in the pool is owned: there is nothing left to offer. CONSUME the level instead
      // of leaving it pending — a wedged counter kept `maybeOpenQueued` fed and the picker could
      // re-enter in a loop (the "mutation UI flickers" family of reports).
      p.pendingLevels = 0;
      if (p.isLocal) this.queuedLevels = 0;
      p.heal(p.maxHp);
      return;
    }
    // Shuffle the three seats: a fixed order let players read a ranking into the row ("the left
    // one is the good one"), and the choice is theirs to make — every level-up deals a different
    // arrangement (user request). Fisher-Yates, so every permutation is equally likely.
    for (let i = perks.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      const swap = perks[i];
      perks[i] = perks[j];
      perks[j] = swap;
    }
    p.pendingLevels = Math.max(0, p.pendingLevels - 1);
    p.frozen = true;
    // A picker takes the player out of the fight completely: nothing they fired keeps flying while
    // a menu owns the screen (the auto-attack itself is already blocked by the frozen state).
    this.combat.clearOwner(p.id);
    this.pendingLevelUp = { player: p, perks, time: CONFIG.levelUpSelectTime };
    /**
     * A level-up arriving moments after the previous pick is the same fight still resolving — the
     * panel reopens as a continuation: the cards SWAP in place instead of replaying their entrance
     * animation (see UI.showLevelUp's `continuation`), and the stinger does not re-fire. Without
     * this a multi-kill wave made the picker blink out and pop back in between picks.
     */
    this.pendingLevelHideT = 0;   // a queued offer landed while the close was still pending
    const continuation = this.now - this.levelUpClosedAt < Game.PICKER_GRACE;
    this.ui.showLevelUp(perks.map(perk => ({ name: perk.name, desc: perk.desc, pills: perk.pills, tier: perk.tier })), CONFIG.levelUpSelectTime, continuation);
    if (!continuation) this.audio.sfx('levelup');
  }

  private pickPerk(index: number): void {
    const pending = this.pendingLevelUp;
    if (!pending) return;
    const perk = pending.perks[index] ?? pending.perks[0];
    pending.player.applyPerk(perk);
    pending.player.frozen = false;
    pending.player.invulnUntil = this.now + 0.6;
    this.pendingLevelUp = null;
    // A queued level re-deals IMMEDIATELY: hiding the picker only to show it again in the same
    // frame replayed the card pop-in and read as flickering (user report). The panel stays up and
    // the cards swap in place — UI.showLevelUp skips the entrance animation when it is re-dealing
    // into an already-open modal. When nothing is queued the close LINGERS a beat instead of
    // running now: a kill landing a few frames later (the same burst, a DoT tick) then swaps the
    // cards in place and the panel never blinks at all.
    const chained = this.queuedLevels > 0 || pending.player.pendingLevels > 0;
    this.levelUpClosedAt = this.now;   // the burst window starts at the PICK, not at the close
    if (chained) {
      this.pendingLevelHideT = 0;
    } else {
      this.pendingLevelHideT = Game.PICKER_LINGER;
    }
    // A picked perk is part of the run: never lose it to a refresh a second later.
    this.saveT = 0;
    this.mutationBurst(pending.player);
    this.ui.toast(`MUTATION: ${perk.name} — ${perk.desc} • HEALTH + ABILITIES RESTORED`, 3800);
    this.audio.sfx('ui');
    this.maybeOpenQueued();
  }

  private maybeOpenQueued(): void {
    if (!this.localPlayer || this.pendingLevelUp || this.pendingPickup) return;
    if (this.queuedLevels > 0) {
      this.queuedLevels--;
      this.openLevelUp(this.localPlayer);
      return;
    }
    if (this.localPlayer.pendingLevels > 0) {
      this.openLevelUp(this.localPlayer);
    }
  }

  necrotechBurst(p: Player, rangeMul = CONFIG.burstRangeMul): void {
    const mode = p.isLocal ? 'caster' : this.isHost ? 'host' : 'remote';
    this.abilities.burst(p, mode, rangeMul);
    if (this.isHost) {
      if (!p.isLocal) return;
      this.net.broadcast({ t: 'ev', id: 'burst', src: p.id, rm: rangeMul, px: p.position.x, py: p.position.y, pz: p.position.z, dx: 0, dy: 0, dz: 1 });
    } else if (p.isLocal) {
      this.net.sendToHost({ t: 'ev', id: 'burst', src: p.id, rm: rangeMul, px: p.position.x, py: p.position.y, pz: p.position.z, dx: 0, dy: 0, dz: 1 });
    }
  }

  /**
   * Necromutation (perk) payoff: an energy burst at auto-attack range (not the double-range
   * Necrotech Burst), a full heal and a full ability/dash cooldown refresh.
   */
  private mutationBurst(p: Player): void {
    p.heal(p.maxHp);
    p.skillCd = 0;
    p.ultCd = 0;
    p.dashCharges = p.dashMax;
    p.dashRechargeT = 0;
    p.invulnUntil = Math.max(p.invulnUntil, this.now + 0.8);
    this.necrotechBurst(p, 1);
  }

  broadcastAbility(tower: { idx: number; owner: number }): void {
    if (this.isHost) {
      const t = this.towers.towerAt(tower.idx);
      if (!t) return;
      this.towers.useAbility(t);
      this.net.broadcast({ t: 'ev', id: 'beaconability', tx: t.idx, col: t.owner, src: this.net.myId });
    } else {
      this.net.sendToHost({ t: 'ev', id: 'beaconability', tx: tower.idx, src: this.net.myId });
    }
  }

  // ------------------------------------------------------------ queries

  /**
   * Nearest living player. `skipSheltered` is what the Necrophage AI uses: a survivor standing inside
   * a colony dome or a live Beacon shield is not a valid target, so nothing camps the wall waiting —
   * they simply are not seen until they step back out. The same flag hides players locked into a
   * Necromutation / Necrotech choice: the anti-cheese retreat already pushes Necrophages out of the
   * 34 m ring, but while the frozen player stayed a valid target the swarm simply turned around and
   * walked back in, was pushed out again — an endless in/out bounce that read as "stuck, flickering
   * back and forth" exactly where the choice had been opened.
   */
  nearestPlayer(pos: THREE.Vector3, maxDist: number, skipSheltered = false): Player | null {
    let best: Player | null = null;
    let bestD = maxDist * maxDist;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = p.position.distanceToSquared(pos);
      if (d >= bestD) continue;
      if (skipSheltered && (p.frozen || this.inSafeZone(p.position, 0))) continue;
      bestD = d;
      best = p;
    }
    return best;
  }

  nearestPlayerDistanceSq(pos: THREE.Vector3): number {
    let best = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = p.position.distanceToSquared(pos);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Echo Decoy: a live clone reads as a player to the swarm's target choice. Returning it typed as a
   * `Player` is deliberate — `Enemy.bTarget` IS a `Player`, and the decoy implements the small
   * surface the AI actually touches (`alive` / `position` / `up` / `isInvulnerable` / `takeDamage`).
   */
  decoyTarget(pos: THREE.Vector3, maxDist: number): Player | null {
    const d = this.decoys.nearest(pos, maxDist);
    return d ? (d as unknown as Player) : null;
  }

  /** The same lookup by id — the AI's per-frame "is my chase still valid" test. */
  decoyTargetById(id: string): Player | null {
    const d = this.decoys.byId(id);
    return d ? (d as unknown as Player) : null;
  }

  // ------------------------------------------------------------ leaving / host loss

  /** Esc menu overlay. It never pauses the world — other players keep playing. */
  private togglePauseMenu(): void {
    if (this.phase !== 'playing') return;
    this.paused = !this.paused;
    if (this.paused) this.ui.showPauseMenu();
    else this.ui.hidePauseMenu();
  }

  /**
   * Unconditional close for the tap-outside dismissal: the world may be under the panel and the
   * player has just touched it, so this must never be able to toggle anything back open.
   */
  private closePauseMenu(): void {
    this.paused = false;
    this.ui.hidePauseMenu();
  }

  /** Leaving mid-match is not the end of the match: P2P elects a new host, OFFICIAL tombstones the seat. */
  private leaveMatch(): void {
    this.paused = false;
    this.ui.hidePauseMenu();
    this.ui.hideRespawn();
    const official = this.officialMatch;
    if (official) {
      // OFFICIAL: abandon the seat server-side and detach — the shell takes the screen back and
      // the match can never pull this client back in (the old "leave not working" bug).
      this.officialMatch = null;
      official.bridge.leaveMatch();
      this.returnToMenu();
      return;
    }
    this.net.sendLeave();
    setTimeout(() => this.returnToMenu(), 260);
  }

  // ------------------------------------------------------------ host migration

  /**
   * The host connection dropped. The room never loses the match over this: the survivors elect the
   * next player from the host's published order. Here we only tell the player what is happening —
   * the world keeps simulating while the election runs.
   */
  private onHostLost(reason: string): void {
    if (this.phase === 'ended') return;
    this.ui.banner('HOST LOST — ELECTING A NEW HOST', 3000);
    this.ui.toast(`${reason} — the match continues, electing a new host…`, 4600);
  }

  /** This client won the election: it becomes the match authority and keeps the sim running. */
  private onPromoted(): void {
    this.isHost = true;
    this.resetClocks();
    this.ensureRosterSelf();
    this.refreshHostOrder();
    this.net.setRoster([...this.roster.keys()]);
    if (this.phase === 'playing') {
      this.snapshotT = 0; // push the full state at once so everyone resyncs to us
      this.ui.banner('YOU ARE NOW THE HOST', 3000);
      this.ui.toast('Host migrated — you run this match now.', 4200);
      this.pushLobby();
    } else if (this.phase === 'lobby') {
      this.ui.show('lobby');
      this.pushLobby();
    } else if (this.phase === 'colony' || this.phase === 'necrotech') {
      // Selections are cheap to redo and the old timers died with the previous host.
      this.beginColonyPhase();
    }
  }

  /** We reconnected to the newly elected host: gameplay simply carries on. */
  private onMigrated(hostId: string): void {
    this.isHost = false;
    this.resetClocks();
    const name = this.roster.get(hostId)?.name ?? 'A survivor';
    if (this.phase === 'playing') this.ui.banner('HOST MIGRATED — MATCH CONTINUES', 2400);
    this.ui.toast(`${name} is the new host`, 3200);
  }

  /** The room code changed because the old one could not be reclaimed — the UI and URL follow it. */
  private onCodeChanged(code: string): void {
    this.trackRoom();
    this.ui.toast(`ROOM CODE IS NOW ${code} — share it to let friends drop in`, 5000);
    if (this.isHost) this.ui.killFeed(`Room code ${code}`, '#8fd7ff');
    if (this.phase === 'lobby') this.updateLobbyUI();
  }

  /**
   * Last resort: no candidate answered. Instead of showing a defeat screen the client keeps the
   * match alive under local authority, so the player is never kicked out by someone else's bad line.
   */
  private onMigrateFailed(): void {
    this.net.goSolo();
    this.isHost = true;
    this.resetClocks();
    if (this.phase === 'playing') {
      this.ui.banner('CONNECTION LOST — PLAYING OFFLINE', 3200);
      this.ui.toast('No host answered — this client runs the match now.', 5000);
    }
  }

  /**
   * The authority moved: every timestamp we hold belongs to the previous host's clock, so throw the
   * clock estimates and the interpolated motion away and pick the new host's timeline up from its
   * next packet.
   */
  private resetClocks(): void {
    this.hostSync = new ClockSync();
    this.peerSync.clear();
    for (const p of this.players.values()) p.resetNet();
  }

  /**
   * Frame-time watchdog. A match can end up with far more creatures on screen than a given GPU can
   * draw, so instead of degrading into a frozen frame the game measures its own framerate and steps
   * the world down when it can't keep up: the crowd is culled, particles and decorations are
   * trimmed, and (if it is still struggling) the render resolution drops.
   *
   * It is deliberately conservative and fully reversible — two bad half-second windows in a row
   * before it acts (a phone that is already thermally throttling must be caught early, not after
   * several seconds of jank), and it climbs back up (restoring decorations and the crowd budget)
   * after ten good ones, so a single hitch or a tab switch can never permanently degrade the match.
   */
  private watchdog(fps: number): void {
    if (this.phase !== 'playing') return;
    // A backgrounded tab throttles rAF to ~1 fps and a restored tab produces one enormous frame —
    // neither says anything about how the machine performs while playing, so ignore both.
    if (typeof document !== 'undefined' && document.hidden) {
      this.slowSamples = 0;
      this.goodSamples = 0;
      return;
    }
    if (this.frameMs > 400) {
      this.slowSamples = 0;
      this.goodSamples = 0;
      return;
    }
    // Match start, preset changes and pacing-target changes produce a burst of slow windows while
    // shaders compile and rate ramps settle. `updateRenderScale` runs immediately before this and
    // owns that warm-up clock; without sharing it, the first seconds of a match on a slow device
    // could trim the world before a single fair frame had been measured.
    if (this.dprWarmup > 0) {
      this.slowSamples = 0;
      this.goodSamples = 0;
      return;
    }

    // Thresholds are RELATIVE to the pace target, exactly like the DPR ladder's: a match paced at
    // 60 fps must not be judged against raw numbers, and a machine merely approaching its cap is
    // not in trouble. Uncapped phases keep the original absolute values.
    const target = this.frameTargetFps();
    const bad = target > 0 ? target * PERF.rescueBadMul : PERF.rescueBadFps;
    const good = target > 0 ? target * PERF.rescueGoodMul : PERF.rescueGoodFps;

    if (fps < bad) {
      this.slowSamples++;
      this.goodSamples = 0;
      this.rescueIdleT = 0;
    } else {
      if (fps >= good) this.goodSamples++;
      else this.goodSamples = 0;
      this.slowSamples = 0;
      this.rescueIdleT += 0.5;
    }
    if (this.rescueDecayT > 0) this.rescueDecayT += 0.5;

    // Resolution is owned by the DPR ladder (one controller, its own hysteresis, called from
    // `update` for EVERY phase); the rescue levels below never touch the pixel ratio.
    if (this.slowSamples >= 2 && this.rescueLevel < 3) {
      this.slowSamples = 0;
      this.rescueLevel++;
      // A level re-applied within the regret window of a decay is one this device provably needs:
      // pin the floor at it so the decay can never take it away again this match (no flicker).
      if (this.rescueDecayT > 0 && this.rescueDecayT < PERF.rescueRegret) {
        this.rescueFloor = Math.max(this.rescueFloor, this.rescueLevel);
        this.rescueDecayT = 0;
      }
      this.rescueIdleT = 0;
      this.enemyBudget = Math.max(24, Math.round(this.enemyBudget * 0.7));
      const culled = this.enemies.cullTo(this.enemyBudget);
      this.applyRescueLevel();
      this.ui.toast(`PERFORMANCE RESCUE ${this.rescueLevel}/3 — ${culled} distant Necrophages culled`, 3200);
      return;
    }

    // Climb back on ten good windows (5 s) — OR, once a level has simply stopped being needed for
    // `PERF.rescueDecay` seconds, on its own. That second path is the fix for "the scenery never
    // came back": the old rule demanded five straight seconds ABOVE the good line, so a phone
    // sitting between the two thresholds (a throttling phone on LOW) could never recover and kept
    // the trimmed world — no rocks, spikes, grass or trees — for the rest of the match.
    const decayed = this.rescueLevel > this.rescueFloor && this.rescueIdleT >= PERF.rescueDecay;
    if (this.rescueLevel > 0 && (this.goodSamples >= 10 || decayed)) {
      this.goodSamples = 0;
      this.rescueLevel--;
      if (decayed) {
        this.rescueDecayT = 0.5;   // arm the regret window
        this.rescueIdleT = 0;
      }
      this.enemyBudget = Math.min(this.settings.maxEnemies, Math.round(this.enemyBudget * 1.4));
      this.applyRescueLevel();
    }
  }

  /**
   * Applies every knob of the current rescue level from ONE table. The old inline version drifted
   * (the 3 → 2 step left the particle budget at level 3's value) and the mapping lived in three
   * separate branches a decay could never safely reuse.
   */
  private applyRescueLevel(): void {
    const level = Math.min(this.rescueLevel, 3);
    this.effects.setBudget([1, 0.65, 0.65, 0.4][level]);
    this.planet.setAmbienceBudget([1, 0.6, 0.35, 0.35][level]);
    // Scenery (rocks, crystals, trees, grass, flowers, ambience points) is the level-2 trim — and
    // the one players actually see, which is why every path back up must restore it.
    this.planet.setDecorationsVisible(this.rescueLevel < 2);
  }

  /** Clears every rescue clock and restores the level-0 budgets (match start, preset change). */
  private resetRescue(): void {
    this.rescueLevel = 0;
    this.slowSamples = 0;
    this.goodSamples = 0;
    this.rescueIdleT = 0;
    this.rescueDecayT = 0;
    this.rescueFloor = 0;
    this.applyRescueLevel();
  }

  private update(dt: number): void {
    this.clock += dt;
    this.now = this.clock;
    this.frames++;
    this.fpsT += dt;
    this.frameMs = dt * 1000;
    if (this.frameMs > this.worstMs) this.worstMs = this.frameMs;
    // the worst-frame figure describes the last ~8 seconds, not the whole match
    this.worstDecayT += dt;
    if (this.worstDecayT >= 8) {
      this.worstDecayT = 0;
      this.worstMs = this.frameMs;
    }
    if (this.fpsT > 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
      // The DPR ladder runs in EVERY phase (menus used to be exempt — exactly where a phone could
      // bake); the rescue steps below stay match-only.
      this.updateRenderScale(this.fps);
      this.watchdog(this.fps);
    }

    const target = this.localPlayer ?? this.camTarget;
    if (!this.localPlayer) {
      // orbit spectate around the planet while in menus
      this.menuOrbit += dt * 0.06;
      const dir = dirFromAngles(-12, this.menuOrbit * 57.3, _v);
      this.planet.surfacePointFromDir(dir, this.camTarget.position);
      this.camTarget.position.addScaledVector(dir, 9);
      this.camTarget.up.copy(dir);
      this.camTarget.velocity.set(0, 0, 0);
    }

    if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'ended') {
      if (this.ui.orientation.blocked) {
        // portrait phone: hold the player still until the device is turned
        this.input.clearQueued();
      } else {
        this.input.update(
          this.cam, this.planet,
          this.localPlayer?.position ?? this.camTarget.position,
          this.localPlayer?.autoRange ?? 0
        );
      }
    }

    // Esc pause menu (works even while gameplay input is disabled)
    if (this.input.consumeMenu()) this.togglePauseMenu();
    // mouse-wheel camera zoom
    const wheel = this.input.consumeWheel();
    if (wheel !== 0 && this.phase === 'playing') this.cam.zoomBy(wheel);

    // phase timers (host authoritative) -------------------------------
    // OFFICIAL clients run their OWN necrotech countdown: the starter picker is a local phase
    // (the server match is already live), so every seat must finalize it locally — the
    // authority broadcasts nothing for it.
    if (this.isHost || (this.officialMatch && this.phase === 'necrotech')) {
      if (this.phase === 'colony') {
        this.phaseTimer -= dt;
        // The countdown always runs its full length — nobody picking, or everyone
        // having picked, never cuts it short.
        if (this.phaseTimer <= 0) this.finalizeColonyPhase();
      } else if (this.phase === 'necrotech') {
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          // Official matches wear the same screen but finalize LOCALLY: the seed and the clock
          // are the server's (see finalizeOfficialNecrotechPhase), never the lobby's random ones.
          if (this.officialMatch) this.finalizeOfficialNecrotechPhase();
          else this.finalizeNecrotechPhase();
        }
      }
    } else if (this.lateSelect) {
      // Drop-in selection is this client's own: nobody else runs a timer for it.
      this.updateLateSelect(dt);
    }

    if (this.phase === 'colony') this.refreshColonyUI();
    if (this.phase === 'necrotech') this.refreshNecrotechUI();

    // match simulation -------------------------------------------------
    // Timed as a block: this is the CPU cost of the match (players, enemies, combat, abilities,
    // network ticks, serialisation), reported by F1 next to the render cost.
    const simStart = performance.now();
    if (this.phase === 'playing') {
      if (this.isHost) {
        this.matchElapsed += dt;
        if (this.matchElapsed >= CONFIG.matchTime) {
          this.endMatch(null);
        }
        this.updateRespawns(dt);
      }

      // the recall channel's input watch runs BEFORE anyone simulates, so the frame that breaks
      // the channel is also the frame the player gets control back (they can move/act at once)
      this.watchRecallInput();
      for (const p of this.players.values()) p.update(dt);

      // Keep this player's own run on disk — a refresh hands it straight back to the room.
      this.saveT -= dt;
      if (this.saveT <= 0) this.saveRun();

      this.refreshFrozenPlayers();
      if (this.localPlayer) this.towers.collidePlayer(this.localPlayer);
      if (this.localPlayer) this.bases.collidePlayer(this.localPlayer, this);
      // the fortress deck's outer edge is a springboard: running off the rim flings you outward
      if (this.localPlayer) this.bases.edgeLaunch(this.localPlayer, this);
      this.towers.update(dt);
      this.pads.update(dt);
      this.bases.update(dt, this.matchElapsed);
      this.enemies.update(dt);
      this.combat.update(dt);
      this.abilities.update(dt);
      this.updatePickups(dt);
      this.updateRecall(dt);

      for (const buff of this.colonyBuffs) {
        if (buff.time > 0) buff.time = Math.max(0, buff.time - dt);
      }

      this.flushEnemyBatches();
      this.networkTick(dt);
    } else {
      // keep visuals alive in menus (planet spin is static; effects still update)
      if (this.phase === 'ended') {
        for (const p of this.players.values()) p.update(dt);
      }
    }
    this.simMs += (performance.now() - simStart - this.simMs) * 0.1;

    this.effects.update(dt);
    this.cosmeticFx.update(dt);
    this.telegraphs.update(dt);
    this.decoys.update(dt, this);
    this.planet.update(dt, this.cam.camera.position);
    this.cam.update(dt, target, this.planet, this.effects.consumeShake());
    this.updateIndicators(dt);
    this.updateModalTimers(dt);
    this.ui.updateHud(this.hudData());
    if (this.phase === 'playing') {
      this.ui.drawMinimap(this.minimapData());
      this.updateBossPlates();
    }
    this.updateDebug();
    this.net.update(dt);
  }

  private flushEnemyBatches(): void {
    if (!this.isHost) return;
    if (this.enemyHitBatch.length > 0) {
      const list = this.enemyHitBatch;
      this.enemyHitBatch = [];
      this.net.broadcast({ t: 'ehits', list });
      this.onNetMessage(this.net.myId, { t: 'ehits', list });
    }
    if (this.killBatch.length > 0) {
      const ids = this.killBatch;
      this.killBatch = [];
      this.net.broadcast({ t: 'edie', ids });
      this.onNetMessage(this.net.myId, { t: 'edie', ids });
    }
  }

  private networkTick(dt: number): void {
    // Every state packet carries the sender's clock, so the other side can place the poses on a
    // timeline that network delay does not distort.
    const now = nowSec();
    if (this.officialMatch) {
      // OFFICIAL (2026-09-29): the transport is the SpacetimeDB relay but the ROLES are P2P's.
      // The authority broadcasts the same `s` snapshot a P2P host does (through `net.broadcast`
      // → relay); clients stream their full pose+stats (`toNet` — hp, level, mutations, shields
      // included) into the authority at CONFIG.netTickOfficialPose, skipping unchanged frames
      // and falling back to a 1 Hz heartbeat. `sendLocalState` keeps feeding the server's own
      // record (input validation + the seat's liveness) at its throttled cadence.
      if (this.isHost) {
        this.snapshotT -= dt;
        if (this.snapshotT <= 0) {
          this.snapshotT = 1 / CONFIG.netTickSnapshot;
          const players: PlayerNet[] = [];
          for (const p of this.players.values()) players.push(p.toNet(now));
          this.net.broadcast({
            t: 's',
            time: now,
            el: Math.round(this.matchElapsed * 100) / 100,
            pl: players,
            en: this.enemies.serialize(),
            tw: this.towers.serialize(),
            pk: this.pickups.map(pk => ({ id: pk.id, x: pk.mesh.position.x, y: pk.mesh.position.y, z: pk.mesh.position.z, nt: pk.nt, rare: pk.rare ? 1 : 0, tk: pk.taken ? 1 : 0 })),
          });
        }
      } else {
        this.stateT -= dt;
        if (this.stateT <= 0 && this.localPlayer) {
          this.stateT = 1 / CONFIG.netTickOfficialPose;
          const state = this.localPlayer.toNet(now);
          // Sends when anything the other side renders CHANGED — pose, hp, level, mutations,
          // shields, frozen/blitz — plus a 1 Hz idle heartbeat. That is what keeps hp/level/
          // mutation live on every other screen the frame they change.
          const sig = `${state.x},${state.y},${state.z},${state.fx},${state.fy},${state.fz},${state.hp},${state.alive},${state.lvl},${state.mut},${state.ntc},${state.ntn},${state.bl ?? 0},${state.frz ?? 0},${state.sh ?? 0},${state.shm ?? 0},${state.inv ?? 0},${state.dsh ?? 0},${state.acc ?? ''}`;
          if (sig !== this.relaySig || now - this.relaySentAt > 1) {
            this.relaySig = sig;
            this.relaySentAt = now;
            this.net.sendToHost({ t: 'st', time: now, state });
          }
        }
      }
      // Server-side record / liveness feed (the bridge throttles `submitInput` + `syncPose`).
      if (this.localPlayer) {
        this.stateT2 -= dt;
        if (this.stateT2 <= 0) {
          this.stateT2 = 1 / CONFIG.netTickPlayers;
          this.officialMatch.bridge.sendLocalState({
            t: 'st',
            time: now,
            state: this.localPlayer.toNet(now) as unknown as Record<string, unknown>,
          });
        }
      }
      return;
    }
    if (this.isHost) {
      this.snapshotT -= dt;
      if (this.snapshotT <= 0) {
        this.snapshotT = 1 / CONFIG.netTickSnapshot;
        const players: PlayerNet[] = [];
        for (const p of this.players.values()) players.push(p.toNet(now));
        this.net.broadcast({
          t: 's',
          time: now,
          el: Math.round(this.matchElapsed * 100) / 100,
          pl: players,
          en: this.enemies.serialize(),
          tw: this.towers.serialize(),
          pk: this.pickups.map(pk => ({ id: pk.id, x: pk.mesh.position.x, y: pk.mesh.position.y, z: pk.mesh.position.z, nt: pk.nt, rare: pk.rare ? 1 : 0, tk: pk.taken ? 1 : 0 })),
        });
      }
    } else {
      this.stateT -= dt;
      if (this.stateT <= 0 && this.localPlayer) {
        this.stateT = 1 / CONFIG.netTickPlayers;
        this.net.sendToHost({ t: 'st', time: now, state: this.localPlayer.toNet(now) });
      }
    }
  }

  private updateModalTimers(dt: number): void {
    // death overlay countdown
    if (this.localPlayer && !this.localPlayer.alive && this.phase === 'playing') {
      this.ui.tickRespawn(Math.max(0, this.localPlayer.respawnTimer));
    }
    if (this.pendingLevelUp) {
      this.pendingLevelUp.time -= dt;
      this.ui.tickLevelUpTimer(this.pendingLevelUp.time);
      if (this.pendingLevelUp.time <= 0) {
        // auto pick the first card (the row was already shuffled, so this is an arbitrary one)
        this.pickPerk(0);
      }
    } else if (this.pendingLevelHideT > 0) {
      // The picker lingers after its last pick (see PICKER_LINGER): anything that arrives inside
      // the window swaps cards in place; nothing arrives and it closes, calmly.
      this.pendingLevelHideT -= dt;
      if (this.pendingLevelHideT <= 0) this.ui.hideLevelUp();
    }
    if (this.pendingPickup) {
      this.pendingPickup.time -= dt;
      this.ui.tickPickupTimer(this.pendingPickup.time);
      if (this.pendingPickup.time <= 0) this.resolvePickup('keep');
    }
  }

  private updateIndicators(dt: number): void {
    const p = this.localPlayer;
    if (!p || this.phase !== 'playing') {
      this.rangeRing.visible = false;
      this.ringVisible = false;
      this.aimArrow.visible = false;
      this.berserkSigil.visible = false;
      this.aimPreview.hide(dt);
      return;
    }
    // Berserker burns along the auto-attack ring for its whole duration
    const berserk = p.hasBuff('Berserker') > 0;
    this.rangeRing.visible = p.alive;
    if (!p.alive) this.ringVisible = false;
    if (p.alive) {
      const radius = p.autoRange;
      // ---- the reach is a SPHERE, not a disc: Player.selectTarget tests the true 3D distance, so what
      // belongs on the ground is where that sphere CUTS the surface — a circle of radius
      // sqrt(R^2 - h^2) around the point under the player's feet. Standing on the ground (h = 0) that
      // is the full reach; jump and it pulls in; jump clear of R and there is no circle at all.
      // Solved on the planet's own curvature rather than a flat plane — |P| = Rp meets |P - C| = R, so
      // cos(phi) = (Rp^2 + |C|^2 - R^2) / (2 * Rp * |C|). One acos, and it is exactly right.
      //
      // The surface is the FORTRESS DECK while the player is on one: a ring drawn on the terrain 30 m
      // below the platform is a ring nobody ever sees.
      const deck = this.bases.deckUnder(p.up);
      const overDeck = deck ? p.position.dot(deck.up) - deck.deckRadius : -Infinity;
      const onDeck = deck !== null && overDeck > -1.6;
      // Measure everything against the surface the ring lands on, not the planet's nominal radius:
      // a deck sits 30 m above the terrain, and mixing the two makes the sphere enormous.
      const surfR = onDeck && deck ? deck.deckRadius : this.planet.heightAtDir(p.up.x, p.up.y, p.up.z);
      const airH = Math.max(0, onDeck ? overDeck : p.position.length() - surfR);
      const deckPlane = onDeck && deck ? deck.deckRadius : 0;
      // ONE source of truth for the cut (Player.ringFootprint): the auto-attack clamps to the same
      // footprint, so the circle can never show a reach the shots do not honour.
      const { reach, theta } = p.ringFootprint(radius);
      // Rebuilding the ring costs one full terrain sample per segment (~96 noise evaluations).
      // It is a ground decal that follows the player, so it is refreshed on alternate frames and
      // immediately whenever it appears or its reach changes — the staleness is 16 ms and invisible.
      this.ringHalf = !this.ringHalf;
      // 25 cm of quantisation on the altitude, so a jump does not rebuild on every millimetre
      const airQ = Math.round(airH * 4) / 4;
      const attr = this.rangeRing.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      if (!reach) {
        // the sphere is entirely clear of the ground: there is no circle to show
        this.rangeRing.visible = false;
        this.ringVisible = false;
      } else {
        if (!this.ringVisible || this.ringRadius !== radius || this.ringAir !== airQ || this.ringHalf) {
          this.ringVisible = true;
          this.ringRadius = radius;
          this.ringAir = airQ;
          tangentBasis(p.up, _v, _v2);
          const segs = this.rangeRingSegments;
          for (let i = 0; i < segs; i++) {
            const a = (i / segs) * Math.PI * 2;
            // rotate "up" around a tangent axis -> the direction where the range sphere meets the
            // surface, which is `theta` radians away (less than the full reach while airborne)
            _v3.copy(_v).multiplyScalar(Math.cos(a)).addScaledVector(_v2, Math.sin(a)).normalize();
            const dir = _v4.copy(p.up).applyAxisAngle(_v3, theta).normalize();
            const h = (deckPlane > 0 ? deckPlane : this.planet.heightAtDir(dir.x, dir.y, dir.z)) + 0.3;
            arr[i * 3] = dir.x * h;
            arr[i * 3 + 1] = dir.y * h;
            arr[i * 3 + 2] = dir.z * h;
          }
          attr.needsUpdate = true;
        }
        (this.rangeRing.material as THREE.LineBasicMaterial).color.setHex(berserk ? 0xff8a3d : p.necrotechColor);
        (this.rangeRing.material as THREE.LineBasicMaterial).opacity = (berserk ? 0.62 : 0.45) + Math.sin(this.clock * (berserk ? 7 : 3)) * 0.1;
      }

      // Berserker: embers all the way around the ring, at fresh angles every tick — never a
      // handful of fixed points — plus the horned badge laid over the ground under the runner.
      const sig = this.berserkSigil;
      sig.visible = berserk;
      if (berserk) {
        this.berserkSpin += dt * BERSERK_SPIN;
        this.updateBerserkSigil(p);
        (sig.material as THREE.MeshBasicMaterial).opacity = 0.9 + Math.sin(this.clock * 7.5) * 0.1;

        // embers ride the SAME circle the ring is drawn on, so they move in when it does (and there
        // is nothing to burn along while the sphere is clear of the ground)
        this.berserkFxT -= dt;
        if (this.berserkFxT <= 0 && reach) {
          this.berserkFxT = 0.028;
          for (let k = 0; k < 2; k++) {
            const a = Math.random() * Math.PI * 2;
            _v3.copy(_v).multiplyScalar(Math.cos(a)).addScaledVector(_v2, Math.sin(a)).normalize();
            const d = _v4.copy(p.up).applyAxisAngle(_v3, theta).normalize();
            const hh = (deckPlane > 0 ? deckPlane : this.planet.heightAtDir(d.x, d.y, d.z)) + 0.22;
            this.effects.burst(_v4.copy(d).multiplyScalar(hh), Math.random() < 0.5 ? 0xff8a3d : 0xffc46b, {
              count: 2, speed: 2.6, life: 0.5, size: 0.4, gravity: -8, drag: 1.4,
            });
          }
        }
      }
    }

    const showArrow = p.alive && this.input.hasAim;
    this.aimArrow.visible = showArrow;
    if (showArrow) {
      const dir = this.input.aimDir.lengthSq() > 0.01 ? this.input.aimDir : p.facing;
      // right = dir x up gives the lateral axis of the arrow on the tangent plane
      _v3.copy(dir).cross(p.up).normalize();
      const attr = this.aimArrow.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < this.aimArrowPts.length; i++) {
        const [lateral, forward] = this.aimArrowPts[i];
        _v4.copy(p.up).multiplyScalar(this.planet.radius)
          .addScaledVector(dir, forward)
          .addScaledVector(_v3, lateral)
          .normalize();
        const h = this.planet.heightAtDir(_v4.x, _v4.y, _v4.z) + 0.32;
        arr[i * 3] = _v4.x * h;
        arr[i * 3 + 1] = _v4.y * h;
        arr[i * 3 + 2] = _v4.z * h;
      }
      attr.needsUpdate = true;
      (this.aimArrow.material as THREE.MeshBasicMaterial).color.setHex(p.necrotechColor);
      (this.aimArrow.material as THREE.MeshBasicMaterial).opacity = 0.28 + Math.sin(this.clock * 5) * 0.06;
    }

    this.updateAimFootprint(p, dt);
  }

  /**
   * The MOBA aiming tell: the ground footprint of the ability the player is aiming, so the reach,
   * the lane and the blast radius are all readable before committing to the cast. The Skill's
   * shape is always shown (dim while it is cooling); holding the Skill / Ultimate button — the
   * mouse button, or a drag on the touch button — emphasises that ability's marker instead.
   */
  private updateAimFootprint(p: Player, dt: number): void {
    // the footprint only appears while a button is held — nothing is drawn the rest of the time
    const hold = this.input.aimHold;
    if (!p.alive || !hold) {
      this.aimPreview.hide(dt);
      return;
    }
    const isUlt = hold === 'ult';
    const ability = isUlt ? p.necrotech.ult : p.necrotech.skill;
    const cd = isUlt ? p.ultCd : p.skillCd;
    const cdMax = isUlt ? p.ultCdMax : p.skillCdMax;
    const dir = this.input.aimDir.lengthSq() > 0.01 ? this.input.aimDir : p.facing;
    // No pointer on the ground (keyboard cast): the marker falls back to the SAME default spot the
    // blast will use, so it never lies about where an unaimed cast lands.
    const point = this.input.hasAim
      ? this.input.aimPoint
      : _v.copy(p.position).addScaledVector(dir, aimDefault(ability.aim, p.autoRange));
    this.aimPreview.show(p.position, p.up, dir, this.planet, {
      aim: ability.aim,
      color: p.necrotechColor,
      hold: hold ? 1 : 0,
      point,
      cdFrac: cdMax > 0 ? cd / cdMax : 0,
      autoRange: p.autoRange,
    }, dt);
  }

  // ------------------------------------------------------------ HUD data

  private hudData(): HudData {
    const p = this.localPlayer;
    const d = this.hudScratch;
    const counts = this.towers.counts();
    this.hudCounts[0] = counts[0];
    this.hudCounts[1] = counts[1];
    this.hudCounts[2] = counts[2];
    let prompt = '';
    let promptKey = '';
    let beaconReady = false;
    d.zone = null;

    if (p && this.phase === 'playing') {
      const beacon = this.towers.activateCandidate(p);
      if (beacon) {
        beaconReady = true;
        promptKey = IS_TOUCH ? 'BEACON' : 'F';
        prompt = `ACTIVATE ${BEACON_ABILITY.name} - ${BEACON_ABILITY.desc}`;
      } else {
        const t = this.towers.zoneInfo(p, this.hudZoneCounts);
        if (t) {
          const label = t.kind === 'nexus' ? 'NEXUS' : `BEACON ${t.idx + 1}`;
          if (t.state === 'open' || t.state === 'vulnerable') {
            // The capture label carries a 0.1 s countdown, so it is rebuilt at most ten times a
            // second instead of every frame — the string work (and the head count behind it) is
            // the only part of the HUD that is not a fixed cost.
            const shown = Math.round(t.captureProgress * 10) / 10;
            const c = this.hudZoneCounts;
            const sig = `${t.idx}|${c[0]}|${c[1]}|${c[2]}|${shown}`;
            if (sig !== this.hudZoneSig) {
              this.hudZoneSig = sig;
              let head = '';
              for (let i = 0; i < 3; i++) {
                if (c[i] > 0) head += (head ? '  •  ' : '') + `${COLONIES[i].name} ${c[i]}`;
              }
              this.hudZone.label = `CAPTURING ${label}  —  ${head || 'NO CONTEST'}  (${shown}s / ${t.captureTime}s)`;
            }
            this.hudZone.progress = t.captureProgress / t.captureTime;
            this.hudZone.colony = t.captureColony;
            d.zone = this.hudZone;
          } else if (t.state === 'boss') {
            promptKey = '!';
            prompt = `${label} IS GUARDED — KILL THE BOSS TO OPEN IT`;
          } else if (t.state === 'shielded') {
            promptKey = t.owner === p.colony ? '◇' : '✕';
            prompt = t.owner === p.colony
              ? `${label} IS YOURS — SHIELD ACTIVE`
              : `${label} IS SHIELDED BY ${COLONIES[t.owner]?.name ?? '?'} — CANNOT ENTER`;
          }
        }
      }
    }

    // ---- buffs (pooled rows — this list is rebuilt every frame)
    let nb = 0;
    const myBuff = p ? this.colonyBuffs[p.colony] : null;
    if (myBuff && myBuff.time > 0) {
      const secs = Math.ceil(myBuff.time);
      if (secs !== this.boonSecs) {
        this.boonSecs = secs;
        // The ability is called COLONY OVERDRIVE everywhere else (the Beacon prompt, HOW TO PLAY,
        // the perk text) — the HUD chip said "COLONY BOON" and named it something else entirely.
        this.boonText = `COLONY OVERDRIVE ${secs}s`;
      }
      const row = Game.grow(this.hudBuffs, nb++, gameBuffRow);
      row.text = this.boonText;
      row.cls = 'boon';
    }
    this.hudBuffs.length = nb;
    // The mutation itself is not announced down here — it lives on the head plate as a status icon.

    d.remaining = this.phase === 'playing' ? Math.max(0, CONFIG.matchTime - this.matchElapsed) : CONFIG.matchTime;
    d.matchTime = CONFIG.matchTime;
    d.hp = p?.hp ?? 0;
    d.maxHp = p?.maxHp ?? CONFIG.player.maxHp;
    d.level = p?.level ?? 1;
    d.xp = p?.xp ?? 0;
    d.xpNeed = p?.xpNeed ?? 100;
    d.skillName = p?.necrotech.skill.name ?? '—';
    d.skillDesc = p?.necrotech.skill.desc ?? '';
    d.skillCd = p?.skillCd ?? 0;
    d.skillMax = p?.skillCdMax ?? 1;
    d.skillCharges = p?.skillCharges ?? 0;
    d.skillChargeMax = p?.skillChargeMax ?? 1;
    d.ultName = p?.necrotech.ult.name ?? '—';
    d.ultDesc = p?.necrotech.ult.desc ?? '';
    d.ultCd = p?.ultCd ?? 0;
    d.ultMax = p?.ultCdMax ?? 1;
    d.dashCharges = p?.dashCharges ?? 0;
    d.dashMax = p?.dashMax ?? 3;
    d.dashRecharge = p?.dashRechargeT ?? 0;
    d.dashRechargeNeed = CONFIG.player.dashRecharge;
    d.jumpsLeft = p?.jumpsAvailable ?? 0;
    d.jumpsMax = p?.jumpsTotal ?? CONFIG.player.baseJumps;
    d.autoTargets = p?.autoTargets ?? 1;
    d.beaconReady = beaconReady;
    // RECALL: the button is pressable ANYTIME while alive and in control (user ask 2026-09-29), so
    // it reads ready the moment there is nothing else in the way; the channel bar reads its
    // countdown straight off the running recall.
    const rc = this.recall;
    d.recallActive = !!rc && this.phase === 'playing';
    d.recallReady = !d.recallActive && this.phase === 'playing' && !this.paused
      && !!p && p.alive && !p.frozen && p.blitzT <= 0;
    d.recallSeconds = rc ? Math.max(0, rc.t) : 0;
    d.recallFrac = rc ? clamp(1 - rc.t / rc.total, 0, 1) : 0;
    d.colonyIdx = p?.colony ?? 0;
    d.necrotechName = p?.necrotechName ?? '—';
    const ntColor = p?.necrotechColor ?? 0x9a6bff;
    if (ntColor !== this.hudNtColor) {
      this.hudNtColor = ntColor;
      this.hudNtCss = `#${ntColor.toString(16).padStart(6, '0')}`;
    }
    d.necrotechColor = this.hudNtCss;
    d.passiveName = p?.necrotech.passiveName ?? '—';
    d.passiveDesc = p?.necrotech.passiveDesc ?? '';
    d.mutated = p?.mutated ?? 0;
    // The mutation cap: how many Necrotechs are held, and the hard limit of three.
    const mutation = p?.mutation ?? null;
    d.mutationCount = p?.activeMutations ?? 0;
    d.mutationLimit = p?.mutationLimit ?? 3;
    const mutColor = mutation?.color ?? ntColor;
    if (mutColor !== this.hudMutColor) {
      this.hudMutColor = mutColor;
      this.hudMutCss = `#${mutColor.toString(16).padStart(6, '0')}`;
    }
    d.mutationColor = this.hudMutCss;
    // The name / sources / description are strings, so they are rebuilt only when the mutation
    // itself changes — never per frame.
    const mutSig = mutation?.id ?? '';
    if (mutSig !== this.hudMutSig) {
      this.hudMutSig = mutSig;
      d.mutationName = mutation?.name ?? '';
      d.mutationSources = mutation ? mutation.requires.join(' + ') : '';
      d.mutationDesc = mutation?.desc ?? '';
      d.mutationTags = mutation ? mutation.tags.join(' · ') : '';
      // a FULL loadout reads as a TRIPLE, so the Esc panel's mutation block says which it is
      d.mutationRarity = mutation
        ? `${mutation.rarity.toUpperCase()}${mutation.requires.length > 2 ? ' TRIPLE' : ''}`
        : '';
    }
    d.buffs = this.hudBuffs;
    d.prompt = prompt;
    d.promptKey = promptKey;
    d.conn = this.connectionText();
    // The Esc menu shows this so friends can drop into a match that is already running. An
    // OFFICIAL match is not hosted by anyone — there is no room code to share, so the same row
    // shows the server match's id and its join link instead ("it says offline game" report:
    // an official match is ALWAYS server-synced and must never read as offline).
    const officialId = this.officialMatch ? this.officialMatch.match.matchId : 0;
    if (officialId > 0) {
      d.roomCode = '';
      d.roomLabel = `MATCH #${officialId}`;
      d.roomHint = 'Official server match — synced live via SpacetimeDB. Share the link.';
      d.roomCopy = `${location.origin}${location.pathname}#/match/${officialId}`;
    } else {
      d.roomCode = this.net.online && this.net.code && this.net.code !== 'SOLO' ? this.net.code : '';
      d.roomLabel = '';
      d.roomHint = '';
      d.roomCopy = '';
    }

    let nt = 0;
    for (const t of this.towers.towers) {
      const row = Game.grow(this.hudTowers, nt++, gameTowerRow);
      row.kind = t.kind;
      row.owner = t.owner;
      row.state = t.state;
      row.capture = t.captureProgress / t.captureTime;
      row.captureColony = t.captureColony;
      row.shieldUp = t.shieldUp;
      // A captured Beacon's ward countdown, drawn as a ring in the tower tracker (0 = none).
      row.shieldT = t.shieldT;
      row.shieldFrac = t.kind === 'beacon' ? clamp(t.shieldT / CONFIG.tower.shieldTime, 0, 1) : 0;
      row.bossAlive = t.state === 'boss';
    }
    this.hudTowers.length = nt;

    d.counts = this.hudCounts;
    d.towers = this.hudTowers;

    let np = 0;
    if (p) {
      for (const pk of p.perks) {
        const row = Game.grow(this.hudPerks, np++, gamePerkRow);
        row.name = pk.name;
        row.desc = pk.desc;
      }
    }
    this.hudPerks.length = np;
    d.perks = this.hudPerks;

    this.fillObjectives();
    d.tasks = this.hudTasks;
    return d;
  }

  /** Fills a pool slot, growing the pool to its high-water mark. */
  private static grow<T>(arr: T[], i: number, make: () => T): T {
    while (arr.length <= i) arr.push(make());
    return arr[i];
  }

  /** The three colony objectives shown under the tower tracker, with live progress. */
  private fillObjectives(): void {
    const myColony = this.localPlayer?.colony ?? -1;
    let held = 0;
    let nexusMine = false;
    for (const t of this.towers.towers) {
      if (t.kind === 'beacon') {
        if (myColony >= 0 && t.owner === myColony) held++;
      } else if (t.kind === 'nexus' && myColony >= 0 && t.owner === myColony) {
        nexusMine = true;
      }
    }
    const mega = Math.min(1, this.localPlayer?.megaKills ?? 0);

    const t0 = Game.grow(this.hudTasks, 0, gameTaskRow);
    t0.label = 'LIBERATE BEACON TOWERS';
    t0.progress = `${held}/4`;
    t0.done = held >= 4;

    const t1 = Game.grow(this.hudTasks, 1, gameTaskRow);
    t1.label = 'DEFEAT MEGA NECROPHAGE';
    t1.progress = `${mega}/1`;
    t1.done = mega >= 1;

    const t2 = Game.grow(this.hudTasks, 2, gameTaskRow);
    t2.label = 'RECLAIM THE NEXUS TOWER';
    t2.progress = nexusMine ? '1/1' : '0/1';
    t2.done = nexusMine;

    this.hudTasks.length = 3;
  }

  private connectionText(): string {
    if (this.net.code === '' || this.net.code === 'SOLO') return 'SOLO — NO SIGNALLING';
    const role = this.isHost ? 'HOST' : 'PEER';
    const peers = this.net.peerCount();
    const ms = this.net.latencyHint >= 0 ? Math.round(this.net.latencyHint) : -1;
    // The connection line changes at most a few times a second; rebuilding the template every
    // frame was a free string allocation per frame.
    const sig = `${this.net.code}|${role}|${peers}|${this.net.online ? 1 : 0}|${ms}`;
    if (sig !== this.connSig) {
      this.connSig = sig;
      const ping = ms >= 0 ? ` • ${ms}ms` : '';
      this.connText = this.net.online
        ? `${role} ${this.net.code} • ${peers} PEER${peers === 1 ? '' : 'S'}${ping}`
        : `${role} ${this.net.code} • OFFLINE${ping}`;
    }
    return this.connText;
  }

  private minimapData(): MiniData {
    const p = this.localPlayer;
    const origin = p ? p.position : this.camTarget.position;
    const up = p ? p.up : this.camTarget.up;
    // The radar must match what the player sees: take the axes straight off the camera and
    // flatten them onto the local tangent plane (screen-right -> radar-right).
    const cam = this.cam.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    // A camera looks down its local -Z, so the *backwards* axis is column 3 (indices 8..10).
    // Negate it to get the true view direction, then flatten both axes onto the tangent plane.
    _v.set(-e[8], -e[9], -e[10]).normalize();                    // forward
    _v.addScaledVector(up, -_v.dot(up));
    if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
    _v.normalize();
    _v3.copy(_v);
    _v2.set(e[0], e[1], e[2]).normalize();                       // screen-right
    _v2.addScaledVector(up, -_v2.dot(up));
    const rightOk = _v2.lengthSq() >= 1e-4;
    if (!rightOk) _v2.copy(_v3).cross(up).normalize().negate();
    else _v2.normalize();

    const d = this.mini;
    d.origin.x = origin.x; d.origin.y = origin.y; d.origin.z = origin.z;
    d.fwd.x = _v3.x; d.fwd.y = _v3.y; d.fwd.z = _v3.z;
    d.right.x = _v2.x; d.right.y = _v2.y; d.right.z = _v2.z;
    d.range = 150;

    const myColony = this.localPlayer?.colony ?? -1;
    let n = 0;
    for (const p2 of this.players.values()) {
      if (!p2.isLocal && p2.colony !== myColony) continue;
      const row = Game.grow(this.miniPlayers, n++, miniPlayerRow);
      row.x = p2.position.x; row.y = p2.position.y; row.z = p2.position.z;
      row.colony = p2.colony; row.isLocal = p2.isLocal; row.alive = p2.alive;
    }
    this.miniPlayers.length = n;

    let nt = 0;
    for (const t of this.towers.towers) {
      const row = Game.grow(this.miniTowers, nt++, miniTowerRow);
      row.x = t.position.x; row.y = t.position.y; row.z = t.position.z;
      row.idx = t.idx;
      row.owner = t.owner; row.kind = t.kind; row.state = t.state;
      // ward state, so the radar can ring a shielded tower with its own countdown
      row.shieldUp = t.shieldUp;
      row.guarded = t.state === 'boss';
      row.shieldFrac = t.state === 'boss' ? 1 : t.kind === 'beacon' ? clamp(t.shieldT / CONFIG.tower.shieldTime, 0, 1) : 0;
      // a capture in flight takes the same ring over: it grows in the taker's colour
      row.capture = t.captureProgress / t.captureTime;
      row.captureColony = t.captureColony;
    }
    this.miniTowers.length = nt;

    // Only what is inside radar range is plotted — the distance test is the same one the old
    // filter/map pair ran, it just writes into a pooled row instead of allocating one per enemy.
    //
    // Bosses used to be pinned on the radar at ANY distance, so a Beacon whose Warden was still
    // alive sat on the map for the entire match as a permanent "there is a guardian here" marker.
    // They are range-gated like everything else now: a boss is a bigger, brighter dot when it is
    // actually near, and nothing at all when it is on the far side of the planet.
    let ne = 0;
    const local = this.localPlayer;
    if (local) {
      const rangeSq = 150 * 150;
      for (const en of this.enemies.enemies) {
        if (en.position.distanceToSquared(local.position) >= rangeSq) continue;
        const row = Game.grow(this.miniEnemies, ne++, miniEnemyRow);
        row.x = en.position.x; row.y = en.position.y; row.z = en.position.z; row.boss = en.isBoss;
      }
    }
    this.miniEnemies.length = ne;

    d.players = this.miniPlayers;
    d.towers = this.miniTowers;
    d.enemies = this.miniEnemies;
    return d;
  }

  /** Projects named enemies and every player into screen space for the floating plates. */
  private updateBossPlates(): void {
    // While a full-screen overlay is up (Necromutation, Necrotech pickup, respawn) the plates are
    // cleared so they can never show through the panel.
    if (this.ui.overlayOpen) {
      this.ui.updateBossPlates([]);
      this.ui.updateTowerPlates([]);
      return;
    }
    const list: BossPlate[] = [];
    const cam = this.cam.camera;
    const size = _plateSize;
    this.renderer.getSize(size);

    /**
     * World → screen with MOBA-style clamping. The plate follows its anchor, but visibility is
     * decided by the creature's *body*: while any part of a huge enemy is on screen the bar is
     * pulled back inside the frame instead of being pushed off the top with its head.
     */
    const project = (anchor: THREE.Vector3, body: THREE.Vector3, halfW: number): { x: number; y: number; visible: boolean } => {
      const inFront = _v2.copy(anchor).sub(cam.position).dot(cam.getWorldDirection(_v)) > 0;
      const dist = anchor.distanceTo(cam.position);
      _v3.copy(anchor).project(cam);
      let x = (_v3.x * 0.5 + 0.5) * size.x;
      let y = (-_v3.y * 0.5 + 0.5) * size.y;

      // where the body itself lands on screen
      _v3.copy(body).project(cam);
      const bx = (_v3.x * 0.5 + 0.5) * size.x;
      const by = (-_v3.y * 0.5 + 0.5) * size.y;
      const bodyVisible = _v3.z < 1 && dist < 170
        && bx > -30 && bx < size.x + 30 && by > -30 && by < size.y + 30;

      const visible = inFront && bodyVisible;
      // keep the plate fully readable: inset by half its width, never above the timer row
      x = Math.min(Math.max(x, halfW + 6), size.x - halfW - 6);
      y = Math.min(Math.max(y, 46), size.y - 18);
      return { x, y, visible };
    };

    /**
     * Anchor-only projection for the tower plates: a tower is far too large to gate on its body,
     * so only the anchor (its crystal) decides visibility, and the plate stays readable from
     * across the battlefield — a capture in progress is information you want at a glance.
     */
    const projectPoint = (anchor: THREE.Vector3, halfW: number, maxDist: number): { x: number; y: number; visible: boolean } => {
      const inFront = _v2.copy(anchor).sub(cam.position).dot(cam.getWorldDirection(_v)) > 0;
      const dist = anchor.distanceTo(cam.position);
      _v3.copy(anchor).project(cam);
      let x = (_v3.x * 0.5 + 0.5) * size.x;
      let y = (-_v3.y * 0.5 + 0.5) * size.y;
      const visible = inFront && dist < maxDist && _v3.z < 1
        && x > -80 && x < size.x + 80 && y > -80 && y < size.y + 80;
      x = Math.min(Math.max(x, halfW + 6), size.x - halfW - 6);
      y = Math.min(Math.max(y, 46), size.y - 18);
      return { x, y, visible };
    };

    // ---- towers that are being flipped: capture percentage + countdown, pinned above the crystal
    const towerList: TowerPlate[] = [];
    for (const t of this.towers.towers) {
      // only while somebody is actually pushing the capture (or the progress is bleeding off)
      if (t.captureProgress <= 0.05) continue;
      _v4.copy(t.position).addScaledVector(t.up, t.kind === 'nexus' ? 24 : 9);
      const tp = projectPoint(_v4, 66, 300);
      const colony = t.captureColony >= 0 ? COLONIES[t.captureColony] : null;
      towerList.push({
        idx: t.idx,
        x: tp.x,
        y: tp.y,
        visible: tp.visible,
        label: t.kind === 'nexus' ? 'NEXUS' : beaconName(t.idx).toUpperCase(),
        colonyName: colony?.name ?? 'CONTESTED',
        color: colony?.css ?? '#b9aed2',
        frac: clamp(t.captureProgress / t.captureTime, 0, 1),
        remain: t.captureTime - t.captureProgress,
      });
    }
    this.ui.updateTowerPlates(towerList);

    // ---- tower wards: the same plate family as the boss health bars — a Beacon's shield while its
    // Warden lives (or its countdown after capture) and the sealed Nexus. They are emitted HERE, not
    // with the capture plates, so they inherit the boss bars' visibility rules: a ward is only drawn
    // when the tower itself is on screen and in range, never clamped in from off-stage.
    let liberated = 0;
    for (const t of this.towers.towers) if (t.kind === 'beacon' && t.owner >= 0) liberated++;
    for (const t of this.towers.towers) {
      if (!t.shieldUp) continue;
      const nexus = t.kind === 'nexus';
      if (nexus && !t.nexusSeal) continue;
      const guarded = t.state === 'boss';
      // The Nexus shield only falls to the Mega Necrophage's death, so once the Beacons are all
      // liberated the plate says what is actually holding the seal up.
      const caption = nexus
        ? liberated >= 4
          ? 'DEFEAT MEGA NECROPHAGE'
          : `BEACONS LIBERATED ${liberated}/4`
        : guarded
          ? 'DEFEAT THE GUARDIAN'
          : `SHIELD FALLS IN ${Math.max(0, Math.ceil(t.shieldT))}S`;
      _v4.copy(t.position).addScaledVector(t.up, nexus ? 24 : 9);
      const p = project(_v4, t.position, nexus ? 124 : 116);
      list.push({
        key: `ward${t.idx}`,
        x: p.x,
        y: p.y,
        visible: p.visible,
        kind: 'ward',
        name: nexus ? 'NEXUS' : beaconName(t.idx).toUpperCase(),
        hp: 1,
        maxHp: 1,
        color: nexus || guarded ? '#ff2d4a' : t.owner >= 0 ? COLONIES[t.owner].css : '#ff2d4a',
        caption,
        level: 0,
        xpFrac: 0,
        dashCharges: 0,
        dashMax: 0,
        dashFrac: 0,
        self: false,
      });
    }

    // ---- bosses, apex minibosses and elites
    const named = this.enemies.plateList(this.bossScratch);
    for (const e of named) {
      e.bossAnchor(_v4);
      const halfW = e.isBoss ? 118 : 76;
      const p = project(_v4, e.position, halfW);
      const css = `#${e.genome.accent.toString(16).padStart(6, '0')}`;
      list.push({
        key: `e${e.id}`,
        x: p.x,
        y: p.y,
        visible: p.visible && !e.stealthed,
        kind: e.isBoss ? 'boss' : 'mini',
        // Bosses AND Hunters read in full caps: the hunter plate is where a player first names the
        // thing that is tracking them, and its lower-case name read like an ordinary minion's.
        name: e.isBoss || e.genome.hunter !== 0 ? e.genome.name.toUpperCase() : e.genome.name,
        hp: e.hp,
        maxHp: e.maxHp,
        color: css,
        // Bosses carry the second bar. Its value is authoritative on the host and arrives as a
        // fraction on clients (see EnemySnapshot.stn), so both sides draw the same thing.
        stun: e.isBoss ? e.stun : undefined,
        stunMax: e.isBoss ? e.stunMax : undefined,
        enraged: e.enraged,
        stunned: e.stunnedT > 0,
        level: 0,
        xpFrac: 0,
        dashCharges: 0,
        dashMax: 0,
        dashFrac: 0,
        self: false,
      });
    }

    // ---- colony fortresses: labelled, but deliberately hatched grey — a base cannot be hurt
    for (const b of this.bases.bases) {
      _v4.copy(b.center).addScaledVector(b.up, 7);
      const proj = project(_v4, b.center, 108);
      list.push({
        key: `base${b.colony}`,
        x: proj.x,
        y: proj.y,
        visible: proj.visible,
        kind: 'base',
        name: `${COLONIES[b.colony]?.name ?? 'COLONY'} BASE`,
        hp: 1,
        maxHp: 1,
        color: '#b6b6c2',
        level: 0,
        xpFrac: 0,
        dashCharges: 0,
        dashMax: 0,
        dashFrac: 0,
        self: false,
      });
    }

    // ---- every survivor (including the local one): level + health + Necromutation + dashes
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      _v4.copy(p.position).addScaledVector(p.up, 2.35);
      const proj = project(_v4, p.position, 74);
      const colony = COLONIES[p.colony];
      list.push({
        key: `p${p.id}`,
        x: proj.x,
        y: proj.y,
        visible: proj.visible,
        kind: 'player',
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp,
        color: colony?.css ?? '#ffffff',
        level: p.level,
        xpFrac: p.xp / Math.max(1, p.xpNeed),
        dashCharges: p.dashCharges,
        dashMax: p.dashMax,
        dashFrac: p.dashCharges >= p.dashMax ? 1 : p.dashRechargeT / Math.max(0.001, CONFIG.player.dashRecharge),
        self: p.isLocal,
        shield: p.shield,
        shieldMax: p.shieldMax,
        statuses: p.statuses(),
      });
    }

    this.ui.updateBossPlates(list);
  }

  // ------------------------------------------------------------ debug
  private onDebugKey(e: KeyboardEvent): void {
    if (!e.code.startsWith('F') || e.code.length > 3) return;
    const num = Number(e.code.slice(1));
    if (Number.isNaN(num)) return;
    e.preventDefault();
    switch (num) {
      case 1:
        this.ui.setDebugVisible(!this.ui.isDebugVisible);
        break;
      case 2:
        this.debugSpawnEnemy();
        break;
      case 3:
        this.debugSpawnPickup();
        break;
      case 4:
        this.debugTeleportTower();
        break;
      case 5:
        this.debugKillBoss();
        break;
      case 6:
        this.debugCaptureTower();
        break;
      case 7:
        this.debugSpawnNexusBoss();
        break;
      case 8:
        this.debugClaimPlanet();
        break;
      default:
        break;
    }
  }

  private debugRequireHost(): boolean {
    if (this.isHost) return true;
    this.ui.toast('Debug action requires host', 1800);
    return false;
  }

  private debugSpawnEnemy(): void {
    if (!this.debugRequireHost() || !this.localPlayer) return;
    const p = this.localPlayer;
    randomUnitVector(_v);
    _v.cross(p.up).normalize().multiplyScalar(10).add(p.position);
    this.planet.projectToSurface(_v);
    const list = this.enemies.bestiary.genomes;
    const genome = list[Math.floor(Math.random() * list.length)];
    this.enemies.spawn(genome.idx, _v, {});
    const abil = genome.abilities.map(a => ABILITY_META[a].name).join(', ') || 'none';
    this.ui.toast(`${genome.name} [${genome.tier}] — ${abil}`, 3200);
    // eslint-disable-next-line no-console
    console.log('[NECROFALL] spawned genome', genome.idx, genome.name, genome.abilities);
  }

  private debugSpawnPickup(): void {
    if (!this.debugRequireHost() || !this.localPlayer) return;
    const p = this.localPlayer;
    const pos = _v.copy(p.position).addScaledVector(p.facing, 3);
    this.spawnPickup(pos, Math.floor(Math.random() * ALL_NECROTECHS.length), Math.random() < 0.3);
    this.ui.toast('Spawned Necrotech pickup', 1400);
  }

  private debugTeleportTower(): void {
    if (!this.localPlayer) return;
    const t = this.towers.towers[this.debugTeleportIdx % this.towers.towers.length];
    this.debugTeleportIdx++;
    _v.copy(t.position).addScaledVector(t.up, 1);
    this.localPlayer.teleport(_v);
    this.cam.snap();
    this.ui.toast(`Teleported to ${t.kind === 'nexus' ? 'Nexus' : `Beacon ${t.idx + 1}`}`, 1600);
  }

  private debugKillBoss(): void {
    if (!this.debugRequireHost()) return;
    const near = this.towers.towers.find(t => t.state === 'boss' && t.bossId >= 0 && this.localPlayer && t.position.distanceTo(this.localPlayer.position) < 60);
    const target = near ?? this.towers.towers.find(t => t.state === 'boss' && t.bossId >= 0);
    if (!target) {
      this.ui.toast('No boss nearby', 1400);
      return;
    }
    const boss = this.enemies.byId(target.bossId);
    if (boss) this.hostApplyEnemyDamage(boss, 999999, this.net.myId, true);
    this.ui.toast('Boss deleted', 1400);
  }

  private debugCaptureTower(): void {
    if (!this.debugRequireHost() || !this.localPlayer) return;
    const p = this.localPlayer;
    const t = p ? this.towers.towers.find(tt => tt.position.distanceTo(p.position) < CONFIG.tower.captureRadius + 6) : null;
    const target = t ?? this.towers.towers[this.debugTeleportIdx % 4];
    if (!target) return;
    if (target.state === 'boss') {
      const boss = this.enemies.byId(target.bossId);
      if (boss) this.hostApplyEnemyDamage(boss, 999999, this.net.myId, true);
    }
    target.owner = p.colony;
    target.state = 'shielded';
    target.captureProgress = 0;
    this.ui.toast(`Captured by ${COLONIES[p.colony].name}`, 1600);
  }

  private debugSpawnNexusBoss(): void {
    if (!this.debugRequireHost()) return;
    const nexus = this.towers.towers[4];
    if (!nexus) return;
    const pos = _v.copy(nexus.position).addScaledVector(nexus.up, 14);
    const boss = this.enemies.spawnBoss(4, 'nexus', pos);
    nexus.bossId = boss.id;
    nexus.state = 'boss';
    this.ui.toast('Nexus Overseer spawned', 1600);
  }

  private debugClaimPlanet(): void {
    if (!this.debugRequireHost() || !this.localPlayer) return;
    for (const t of this.towers.towers) {
      t.owner = this.localPlayer.colony;
      t.state = 'shielded';
    }
    this.endMatch(this.localPlayer.colony);
  }

  private updateDebug(): void {
    // The network counters cost a JSON size estimate per message, so they only run while this
    // overlay is actually open — and they are what tells a hot phone apart from a busy link.
    if (!this.ui.isDebugVisible) {
      this.net.setStats(false);
      return;
    }
    this.net.setStats(true);
    const p = this.localPlayer;
    const info = this.renderer.info;
    const canvas = this.renderer.domElement;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const lines = [
      `FPS ${this.fps.toFixed(0)}  frame ${(this.frameMs).toFixed(1)}ms  worst ${this.worstMs.toFixed(0)}ms  heap ${heap ? `${(heap.usedJSHeapSize / 1048576).toFixed(1)}MB` : '—'}`,
      `sim ${this.simMs.toFixed(2)}ms  render ${this.renderMs.toFixed(2)}ms  quality ${this.settings.name}  rescue ${this.rescueLevel}/3  dpr ${this.renderer.getPixelRatio().toFixed(2)}  pace ${this.frameTargetFps() || 'max'}`,
      `canvas ${canvas.width}x${canvas.height}  draws ${info.render.calls}  tris ${Math.round(info.render.triangles / 1000)}k  geo ${info.memory.geometries}  tex ${info.memory.textures}`,
      `ctx ${this.ctxLost ? 'LOST' : 'ok'}  phase ${this.phase}  t ${formatTime(this.matchElapsed)}  paused ${this.paused ? 'YES' : 'no'}`,
      `net ${this.net.roleLabel()}  peers ${this.net.peerCount()}  ${this.net.msgsPerSec.toFixed(1)} msg/s  ${(this.net.bytesPerSec / 1024).toFixed(1)} KB/s  tick ${CONFIG.netTickSnapshot}Hz↓/${CONFIG.netTickPlayers}Hz↑`,
      `host ${this.isHost ? 'YES' : 'NO'} (${this.net.myId})  lat ${this.net.latencyHint >= 0 ? Math.round(this.net.latencyHint) : '—'}`,
      `players ${this.players.size}  enemies ${this.enemies.aliveCount}/${this.settings.maxEnemies}  particles ${this.effects.activeCount}/${this.effects.cap}  proj ${this.combat.activeCount}  pickups ${this.pickups.length}`,
      p ? `pos ${p.position.x.toFixed(1)} ${p.position.y.toFixed(1)} ${p.position.z.toFixed(1)}` : 'pos —',
      p ? `lat/lon ${((Math.asin(p.position.clone().normalize().y) * 57.3).toFixed(1))} / ${((Math.atan2(p.position.z, p.position.x) * 57.3).toFixed(1))}` : '',
      p ? `hp ${Math.round(p.hp)}/${p.maxHp} lvl ${p.level} xp ${Math.round(p.xp)}/${p.xpNeed}` : '',
      p ? `nt ${p.necrotechName}${p.mutated ? ` mut${p.mutated}` : ''}` : '',
      p ? `dash ${p.dashCharges}/${p.dashMax} sCd ${p.skillCd.toFixed(1)} uCd ${p.ultCd.toFixed(1)}` : '',
      `towers ${this.towers.towers.map(t => `${t.kind === 'nexus' ? 'N' : t.idx + 1}:${t.owner >= 0 ? COLONIES[t.owner].name[0] : '-'}:${t.state[0]}`).join(' ')}`,
      `buffs ${this.colonyBuffs.map((b, i) => (b.time > 0 ? `${COLONIES[i].name[0]}${Math.ceil(b.time)}s` : null)).filter(Boolean).join(' ') || '—'}`,
    ];
    this.ui.setDebug(lines.filter(Boolean));
  }

  // ------------------------------------------------------------ misc

  get isPlaying(): boolean {
    return this.phase === 'playing';
  }
}
