// NECROFALL — the selection screens' live 3D preview.
//
// Two jobs, one little scene:
//  - COLONY select: the player figure, once per colony, each in ITS colony's colours doing its own
//    pose and idle animation (HELIOS surges, AEGIS braces behind crossed arms, VANTA coils to
//    spring), so the choice is a choice between silhouettes and not between three paragraphs.
//  - NECROTECH select: a weapon model for the highlighted class, built to match what that class
//    actually does (the rifle fires bolts, VOLT's coil discharges, PYRE's lance sprays, REAPER's
//    scythe is what carves the 240° arc, ...).
//
// The preview is deliberately self-contained: its own renderer/canvas/scene, its own rAF loop that
// only runs while a selection screen is open, no shadows and flat-shaded primitives, so it costs a
// couple of dozen draw calls while a menu is up and nothing at all during a match.
import * as THREE from 'three/webgpu';
import { COLONIES, IS_TOUCH } from '../core/Config';
import { NecrotechDef } from '../necrotech/NecrotechData';
import { buildWeaponModel } from '../necrotech/WeaponModels';
import { buildPlayerModel, ModelParts } from '../player/Player';
import { AvatarAccessories, disposeObject } from '../customization/AvatarAccessories';
import { AccessoryCategory, AccessorySelection, EffectCategory, EMPTY_SELECTION } from '../customization/AccessoryTypes';
import { selectionFromWire } from '../customization/CustomizationStore';
import { CosmeticFxRunner } from '../customization/CosmeticFx';

export type PreviewMode = 'colony' | 'necrotech' | 'customize' | 'lobby';

/** One seat of the lobby line-up, as the lobby screen knows it (ids are the roster's). */
export interface LobbyAvatarInfo {
  id: string;
  /** Colony index, or -1 while the player has not picked one. */
  colony: number;
  ready: boolean;
  me: boolean;
  /** Accessory wire form ("hat,backpack,pet"); empty/unknown falls back to nothing worn. */
  acc: string;
  /** An OPEN seat: only its lit platform is drawn — no figure, no outfit (user ask). */
  empty?: boolean;
}

/** A lobby avatar: a real player model + its outfit rig, plus the pad it stands on. */
interface LobbyAvatarFig {
  data: LobbyAvatarInfo;
  parts: ModelParts;
  acc: AvatarAccessories;
  ringMat: THREE.MeshBasicMaterial;
  /** The lit stage under the avatar (disc + rim + light pool + its own point light). */
  pad: THREE.Group;
  /** Which seat SLOT of the row this figure occupies (empty seats keep their slot). */
  slot: number;
  anchor: THREE.Vector3;
}

/**
 * A soft round falloff, drawn once and reused by every avatar's light pool. The scene's lighting is
 * deliberately dim (the menu backdrop is near-black), which left the near-black player bodies hard
 * to read in the lobby — the pool plus each avatar's own point light is what makes them legible.
 */
let glowTex: THREE.CanvasTexture | null = null;
function lightPoolTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.34)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

interface FigureParts {
  group: THREE.Group;
  torso: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** Forearms rotate inside the shoulder groups, so a guard or a punch has a real elbow bend. */
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** Knees bend inside the hip groups — the difference between footwork and a stiff mannequin. */
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  handR: THREE.Group;
  accentMats: THREE.MeshLambertMaterial[];
  ringMat: THREE.MeshBasicMaterial;
  /** Eased focus (0..1): how much this champion is currently in the spotlight. */
  focusAmt: number;
}

const TAU = Math.PI * 2;
/** The customize screen's floor is radius zero, and the avatar stands on the origin. */
const ORIGIN = new THREE.Vector3(0, 0, 0);
const UP_AXIS = new THREE.Vector3(0, 1, 0);

// COLONY preview framing: the box is wide and short, so the champion's own height decides the
// scale. The figures used to be framed far too small (~53 % of the frame filled), so they are
// scaled up to a FILL fraction of the visible height — CAPPED, so "fill the space" can never turn
// into a cropped torso. The fill is DEVICE-AWARE: a desktop stage is tall already and a full row of
// champions at a high fill looked oversized there (user review), while a phone's stage is a shallow
// strip above the cards, so the same champion should use much more of it.
const COLONY_CAM_DIST = 5.1;
const COLONY_FILL = 0.78;
const COLONY_FILL_TOUCH = 0.88;
const COLONY_SCALE_MAX = 1.5;
const COLONY_SCALE_MAX_TOUCH = 1.65;
/**
 * Horizontal distance between two champion figures at their authored scale. What actually reads as
 * "a gap" is the space between the lit rings under the champions (~2.3 m across at the default
 * scale): at the old 1.85 the rings very nearly touched, so the line-up crowded itself even though
 * the bodies were separated. 3.4 leaves ~1 m of visible ground between neighbouring rings (and
 * ~0.9 m even while one of them is popped up by the focus zoom). The box shows 13–21 m of visible
 * world at the figures' plane, so this spread still keeps clear air at the frame edges.
 */
const COLONY_SLOT = 3.4;

/**
 * The menu's pet leash (surface metres): on the shell home the pet circles close to its standing
 * owner so the tight stage frame can always hold it (a gameplay ring of 1.1–3.4 m walked the pet
 * straight off the side of the board). In a real line-up pets keep their authored ring.
 */
const MENU_PET_ROAM = { min: 0.55, max: 0.75 };
/** Below this stage height (px) a TOUCH device is a phone-style strip, not a desktop stage. */
const COLONY_SHALLOW = 160;
/** A calm breath: one full inhale/exhale every ~3.4 s. The base layer of every champion's idle. */
function breath(t: number, phase: number, period = 3.4): number {
  return Math.sin((t / period) * TAU + phase);
}

/**
 * Smooth 0..1 bump centred on phase `at` of a 0..1 cycle, with half-width `w`. Accent beats (a
 * punch, a brace, a spring) ride on the continuous motion with these, so a beat ARRIVES and eases
 * away instead of snapping — the whole difference between "alive" and "flailing".
 */
function bump(c: number, at: number, w: number): number {
  const x = Math.abs(c - at) / w;
  if (x >= 1) return 0;
  const s = 1 - x;
  return s * s * (3 - 2 * s);
}

/** Builds one player-shaped figure in a colony's colours. Bodies are near-black so the accent reads. */
function buildFigure(color: number): FigureParts {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x241d3a, flatShading: true });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x151024, flatShading: true });
  const accentMats: THREE.MeshLambertMaterial[] = [];
  const accent = (emissive: number): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: emissive, flatShading: true });
    accentMats.push(m);
    return m;
  };
  const visorMat = accent(0.7);
  const trimMat = accent(0.4);

  // ---- legs (pivot at the hip so a pose can swing them); every joint is a SPHERE, which closes the
  // gap that opens between two boxes the moment a limb swings — the single biggest reason a rig
  // reads as janky instead of jointed
  const legGeo = new THREE.BoxGeometry(0.24, 0.46, 0.26);
  const shinGeo = new THREE.BoxGeometry(0.22, 0.44, 0.24);
  const jointMat = new THREE.MeshLambertMaterial({ color: 0x2c2348, flatShading: true });
  const mkLeg = (x: number): { hip: THREE.Group; knee: THREE.Group } => {
    const hip = new THREE.Group();
    hip.position.set(x, 0.94, 0);
    const hipBall = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), jointMat);
    const thigh = new THREE.Mesh(legGeo, bodyMat);
    thigh.position.y = -0.24;
    hip.add(hipBall, thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.48;
    const shin = new THREE.Mesh(shinGeo, darkMat);
    shin.position.y = -0.22;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.36), darkMat);
    foot.position.set(0, -0.46, 0.06);
    const kneeBall = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 8), jointMat);
    knee.add(kneeBall, shin, foot);
    hip.add(knee);
    group.add(hip);
    return { hip, knee };
  };
  const legR = mkLeg(0.17);
  const legL = mkLeg(-0.17);

  // ---- torso: everything above the hips, so the whole upper body can lean as one
  const torso = new THREE.Group();
  torso.position.y = 0.94;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.5, 0.34), bodyMat);
  chest.position.y = 0.25;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.38), trimMat);
  belt.position.y = 0.02;
  const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.08), visorMat);
  chestPlate.position.set(0, 0.3, 0.18);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.34, 0.36), bodyMat);
  head.position.y = 0.68;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.11, 0.06), visorMat);
  visor.position.set(0, 0.7, 0.19);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.4, 0.16), darkMat);
  pack.position.set(0, 0.28, -0.24);
  torso.add(chest, belt, chestPlate, head, visor, pack);

  // ---- arms (pivot at the shoulder, elbow inside it); the right hand is a weapon attach point
  const armGeo = new THREE.BoxGeometry(0.16, 0.42, 0.18);
  const mkArm = (x: number): { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 0.42, 0);
    const shoulderPad = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.26), trimMat);
    const upper = new THREE.Mesh(armGeo, bodyMat);
    upper.position.y = -0.22;
    const elbow = new THREE.Group();
    elbow.position.y = -0.44;
    const elbowBall = new THREE.Mesh(new THREE.SphereGeometry(0.105, 9, 7), jointMat);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, 0.16), darkMat);
    fore.position.y = -0.2;
    const hand = new THREE.Group();
    hand.position.y = -0.42;
    hand.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.18), trimMat));
    elbow.add(elbowBall, fore, hand);
    shoulder.add(shoulderPad, upper, elbow);
    torso.add(shoulder);
    return { shoulder, elbow, hand };
  };
  const armR = mkArm(0.38);
  const armL = mkArm(-0.38);
  group.add(torso);

  // ---- a flat ring of colony light under the feet: which champion is in focus is read from here
  const ringMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.78, 40), ringMat);
  ring.geometry.rotateX(-Math.PI / 2);
  ring.position.y = 0.02;
  group.add(ring);

  return {
    group, torso,
    armL: armL.shoulder, armR: armR.shoulder,
    elbowL: armL.elbow, elbowR: armR.elbow,
    legL: legL.hip, legR: legR.hip,
    kneeL: legL.knee, kneeR: legR.knee,
    handR: armR.hand, accentMats, ringMat,
    focusAmt: 0,
  };
}

/**
 * HELIOS — the brawler at rest. A boxer's guard: lead fist up, weight forward, springing just
 * enough on the balls of the feet to read as ready. Every ~7 s he snaps off a smooth one-two and
 * settles back into the guard; the rest of the time he only breathes.
 */
function animateHelios(f: FigureParts, t: number, phase: number): void {
  const br = breath(t, phase);
  const spring = Math.sin((t / 2.3) * TAU + phase);      // light footwork, low amplitude
  const c = (t / 7.2 + phase * 0.17) % 1;
  const jab = Math.max(bump(c, 0.10, 0.06) * 0.8, bump(c, 0.28, 0.07));
  const reset = bump(c, 0.55, 0.22);

  f.torso.rotation.x = 0.24 + br * 0.012 + jab * 0.1;
  f.torso.rotation.y = -jab * 0.22;
  f.torso.rotation.z = spring * 0.012 + reset * 0.02;
  f.armR.rotation.x = -1.02 - br * 0.015 - jab * 0.72;
  f.armR.rotation.z = -0.42;
  f.elbowR.rotation.x = -1.35 + br * 0.03 + jab * 0.95;
  f.armL.rotation.x = 0.32 + br * 0.02 + jab * 0.22;
  f.armL.rotation.z = 0.46;
  f.elbowL.rotation.x = -1.15 + br * 0.03;
  f.legR.rotation.x = 0.42 + spring * 0.015;
  f.legL.rotation.x = -0.5 - spring * 0.015 - reset * 0.03;
  f.kneeR.rotation.x = -0.3 - spring * 0.04 - jab * 0.12;
  f.kneeL.rotation.x = -0.12 + spring * 0.03;
  f.group.position.y = 0.06 + br * 0.008 + Math.abs(spring) * 0.006 + jab * 0.015;
  // three-quarter stance, turning slowly: a showcase sway, never a twitch
  f.group.rotation.y = -0.85 + Math.sin((t / 9) * TAU + phase) * 0.07 - jab * 0.06;
}

/**
 * AEGIS — the wall. A LIVING guard, not a statue: the weight rolls from foot to foot under a
 * breathing guard, the helm sweeps the field, and every few seconds he either presses the guard
 * out at whatever is in front of him or settles heavily in behind it — two different accents, so
 * the loop never reads as a single repeated twitch.
 */
function animateAegis(f: FigureParts, t: number, phase: number): void {
  const br = breath(t, phase, 3.1);
  const roll = Math.sin((t / 5) * TAU + phase);            // weight rocking foot to foot
  const scan = Math.sin((t / 9.5) * TAU + phase * 0.6);    // slow sweep of the field
  const c = (t / 5.6 + phase * 0.19) % 1;
  const press = bump(c, 0.2, 0.22);                        // shove the guard forward
  const settle = bump(c, 0.68, 0.24);                      // drop in behind it

  // hips ride the roll and the knees answer it, so he looks PLANTED rather than glued in place
  f.torso.position.x = roll * 0.035;
  f.torso.rotation.x = 0.12 + br * 0.02 + press * 0.09 + settle * 0.05;
  f.torso.rotation.y = scan * 0.11 + press * 0.05;
  f.torso.rotation.z = roll * 0.05;
  // the crossed guard: compresses on the breath, drives OUT on the press, tucks in on the settle
  const guardX = -1.28 - br * 0.05 - press * 0.28 + settle * 0.1;
  const guardZ = 0.58 + press * 0.16 - settle * 0.06;
  f.armR.rotation.x = guardX;
  f.armR.rotation.z = -guardZ;
  f.elbowR.rotation.x = -1.6 + br * 0.07 + press * 0.52 - settle * 0.14;
  f.armL.rotation.x = guardX - 0.08;
  f.armL.rotation.z = guardZ;
  f.elbowL.rotation.x = -1.6 + br * 0.07 + press * 0.52 - settle * 0.14;
  // the loaded knee takes the weight as the body rolls on to it
  f.legR.rotation.x = 0.3 + roll * 0.05;
  f.legL.rotation.x = -0.34 - roll * 0.05;
  f.kneeR.rotation.x = -0.5 - br * 0.04 - press * 0.16 - settle * 0.26 - Math.max(0, roll) * 0.14;
  f.kneeL.rotation.x = -0.48 - br * 0.04 - press * 0.16 - settle * 0.26 - Math.max(0, -roll) * 0.14;
  f.group.position.y = 0.06 + br * 0.012 - press * 0.02 - settle * 0.05;
  f.group.rotation.y = roll * 0.06 + scan * 0.05;
}

/**
 * VANTA — the runner, never quite still. A light, springy footwork cycle under the coiled stance
 * with the arms counter-swinging, and every few seconds a gather-then-spring: the half-step before
 * a sprint. Amplitudes stay small and slow ON PURPOSE — an avatar sprinting on the spot reads as
 * jank; a runner shifting his weight from foot to foot reads as ready to go.
 */
function animateVanta(f: FigureParts, t: number, phase: number): void {
  const c = (t / 5.2 + phase * 0.19) % 1;
  const gather = bump(c, 0.3, 0.22);                       // sinks, arms drawn back
  const spring = bump(c, 0.66, 0.16);                      // rises, lead arm drives out
  const br = breath(t, phase, 4.4);
  // the footwork fades out while he gathers and comes back as he springs — anticipation, then burst
  const step = Math.sin((t / 1.35) * TAU + phase) * (1 - 0.75 * gather);
  const bounce = Math.abs(step);

  f.torso.position.x = step * 0.012;
  f.torso.rotation.x = 0.45 + br * 0.02 + gather * 0.14 - spring * 0.12;
  f.torso.rotation.z = step * 0.035 + (gather - spring) * 0.02;
  // trailing and lead arms pump in counter-phase, then both load up for the spring
  f.armR.rotation.x = 0.3 - step * 0.22 + gather * 0.22 - spring * 0.18;
  f.armR.rotation.z = -0.28;
  f.elbowR.rotation.x = -0.5 - gather * 0.35 + spring * 0.15;
  f.armL.rotation.x = -0.62 + step * 0.24 + gather * 0.18 - spring * 0.42;
  f.armL.rotation.z = 0.3;
  f.elbowL.rotation.x = -0.95 + spring * 0.25;
  // the legs pedal just enough to read as footwork; the gather sinks him, the spring lifts him
  f.legR.rotation.x = 0.58 + step * 0.2 - gather * 0.3 + spring * 0.12;
  f.legL.rotation.x = -0.3 - step * 0.2 + gather * 0.18 - spring * 0.08;
  f.kneeR.rotation.x = -0.5 - bounce * 0.12 - gather * 0.5 + spring * 0.2;
  f.kneeL.rotation.x = -0.28 - bounce * 0.1 - gather * 0.35 + spring * 0.15;
  f.group.position.y = 0.05 + bounce * 0.018 + br * 0.006 - gather * 0.06 + spring * 0.03;
  f.group.rotation.y = 0.95 + Math.sin((t / 7.5) * TAU + phase) * 0.05 + (spring - gather) * 0.06;
}

/** Runs the colony's own animation, eases the focus and paints the spotlight treatment. */
function poseFigure(parts: FigureParts, colony: number, t: number, focus: number, dt: number, baseScale = 1): void {
  const phase = colony * 2.1;
  if (colony === 0) animateHelios(parts, t, phase);
  else if (colony === 1) animateAegis(parts, t, phase);
  else animateVanta(parts, t, phase);

  // focus EASES in and out: popping a champion to a new scale in one frame was half of why the
  // line-up read as janky. `baseScale` is the frame-filling factor the preview solved for the box.
  parts.focusAmt += (focus - parts.focusAmt) * Math.min(1, dt * 7);
  const f = parts.focusAmt;
  parts.group.scale.setScalar(baseScale * (1 + f * 0.12));
  parts.ringMat.opacity = 0.2 + f * 0.55 + 0.04 * Math.sin(t * 1.4 + colony);
  for (const m of parts.accentMats) {
    m.emissiveIntensity = 0.3 + f * 0.45 + 0.05 * Math.sin(t * 1.1 + colony * 1.3);
  }
}

// The weapon models themselves live in necrotech/WeaponModels.ts: the same builders dress this
// turntable AND are mounted in the players' hands during a match.




// ---------------------------------------------------------------------------- the preview scene

/**
 * A small self-contained renderer that lives inside a selection screen. `setMode` moves its canvas
 * into whichever screen is open and (re)builds that mode's models; while no mode is active the rAF
 * loop is parked and the canvas detached, so a running match pays nothing for it.
 */
export class SelectionPreview {
  private canvas: HTMLCanvasElement;
  /** The box the canvas is mounted in while its screen is open — also the size source. */
  private host: HTMLElement | null = null;
  /** Created on first use: a menu that never opens a selection screen never makes a GPU context. */
  private renderer: THREE.WebGPURenderer | null = null;
  /** True once `renderer.init()` has resolved — `render()` before that throws (WebGPU backend). */
  private rendererReady = false;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 4, 0.1, 60);
  private mode: PreviewMode | null = null;
  private t = 0;
  private raf = 0;
  private last = 0;
  private width = 0;
  private height = 0;

  /** COLONY mode: one figure per colony, in COLONIES order. */
  private figures: FigureParts[] = [];
  /** COLONY mode: tallest champion measured at build time — the frame-filling scale reads it. */
  private colonyTop = 1.85;
  /** COLONY mode: the scale the figures are drawn at so they fill the box (1 = authored size). */
  private colonyScale = 1;
  private focus = 0;
  private selected = -1;

  /** NECROTECH mode: the weapon stand, one cached model per class index. */
  private weaponPivot = new THREE.Group();
  private weapons = new Map<number, THREE.Group>();
  private weaponDefs: NecrotechDef[] = [];
  private weaponIdx = 0;
  private standRing: THREE.MeshBasicMaterial | null = null;
  /** The back light behind the weapon stand: a halo panel (class-tinted) + a white point light. */
  private standGlow: THREE.Mesh | null = null;
  private standGlowMat: THREE.MeshBasicMaterial | null = null;
  private standLight: THREE.PointLight | null = null;

  /** CUSTOMIZE mode: one real player model (the same builder the match uses) plus its outfit. */
  private avatarParts: ModelParts | null = null;
  private avatarAcc: AvatarAccessories | null = null;
  private avatarSel: AccessorySelection = { ...EMPTY_SELECTION };
  /** CUSTOMIZE mode: the effect showcase — the equipped one-shot replayed on a loop on the pad. */
  private fxRunner: CosmeticFxRunner | null = null;
  private fxCat: EffectCategory | null = null;
  private fxIdx = -1;
  private fxTimer = 0;
  /**
   * Colony accent the customize avatar (and its pad) is built with — the account colony, set by
   * the shell (user ask: "the avatar follows the colony color scheme"). 0x9a7bff is the lobby's
   * own no-colony fallback, so a colony-less player sees the same body on both stages.
   */
  private avatarTint = 0x9a7bff;
  /** The customize stage's lit pad (the same build the lobby line-up stands on). */
  private avatarPad: THREE.Group | null = null;
  /** CUSTOMIZE mode turntable: the player drags the avatar itself to turn it. */
  private avatarYaw = 0;
  private avatarYawTarget = 0;
  private avatarYawVel = 0;
  private dragging = false;
  private dragX = 0;
  private lastDragAt = -99;
  private dragHost: HTMLElement | null = null;

  /**
   * LOBBY mode: one avatar per seat in a horizontal line-up, each wearing its player's own outfit
   * (pets included). An ORTHOGRAPHIC camera is the point here: the seat cards below the rail are
   * equal-width flex items, so seat i sits at (i + 0.5)/n of the row — and an ortho projection maps
   * world x to rail x linearly, which lets every avatar stand EXACTLY above its own card whatever
   * the player count, with accessories free to spill across the slot borders.
   */
  private lobbyCam = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 40);
  private lobbyAvatars: LobbyAvatarFig[] = [];
  /** OPEN seats: a lit platform with nobody on it (lobby line-up, user ask). */
  private lobbyEmptyPads: { slot: number; pad: THREE.Group }[] = [];
  /** The shared lobby lights — boosted when per-pad lights are skipped (crowded lobbies). */
  private lobbyFill: THREE.DirectionalLight | null = null;
  private lobbyBounce: THREE.HemisphereLight | null = null;
  private lobbyData: LobbyAvatarInfo[] = [];
  private lobbySig = '';
  private lobbyDirty = false;
  /**
   * Shell home: ONE champion staged alone. The standard line-up frustum (min 3.0 world tall) is
   * sized for a row of figures in a shallow rail, so a lone avatar only filled ~55% of the stage
   * (user review: "the avatar should be bigger, scaled to fit"). With this set, a single-figure
   * line-up gets a tighter frustum and the body fills ~75% of whatever stage it is given.
   */
  private lobbySoloFill = false;
  /** Lobby-only lights, added with the line-up and removed with it (other modes stay as they were). */
  private lobbyLights: THREE.Object3D[] = [];
  /** Lobby turntable: the player drags the rail to turn the whole line-up (pets follow their own). */
  private lobbyYaw = 0;
  private lobbyYawTarget = 0;
  private lobbyYawVel = 0;
  private lobbyLastDragAt = -99;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sel-preview-canvas';

    // lighting: a cool sky, a warm key and a coloured rim so the emissive accents pop
    this.scene.add(new THREE.HemisphereLight(0x9fb6ff, 0x1a1630, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3.2, 5.5, 4.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb0ff, 0.9);
    rim.position.set(-4, 2.5, -3.5);
    this.scene.add(rim);

    this.camera.position.set(0, 1.5, 6.4);
    this.camera.lookAt(0, 1, 0);
  }

  private ensureRenderer(): THREE.WebGPURenderer {
    if (!this.renderer) {
      // The game's canonical renderer family (three/webgpu). `render()` must NOT be called before
      // `init()` has resolved: the WebGPU backend throws and the preview loop spams page errors
      // (observed 2026-09-30), so the ready flag gates every frame until then.
      this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, alpha: true, antialias: true });
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.rendererReady = false;
      this.renderer
        .init()
        .then(() => {
          this.rendererReady = true;
        })
        .catch(() => undefined);
    }
    return this.renderer;
  }

  /**
   * Switches the preview to a selection screen (or parks it). `container` is where the canvas is
   * mounted while that screen is open — moving the SAME canvas is what keeps this to one context.
   */
  setMode(mode: PreviewMode | null, container: HTMLElement | null, defs: NecrotechDef[] = []): void {
    if (mode === null) {
      this.mode = null;
      this.canvas.remove();
      this.host = null;
      this.detachDrag();
      this.stop();
      return;
    }
    if (container) {
      this.host = container;
      if (this.canvas.parentElement !== container) container.appendChild(this.canvas);
      // A fresh mount starts unpositioned: the solo home's oversized box (see `soloBox`) writes its
      // own inline geometry every frame, and every OTHER screen keeps the plain 100% layout.
      this.canvas.style.cssText = '';
      // the customize avatar AND the lobby line-up are turntables: dragging the box turns the body
      if (mode === 'customize' || mode === 'lobby') this.attachDrag(container);
      else this.detachDrag();
    }
    this.weaponDefs = defs;
    this.ensureRenderer();
    if (this.mode === mode) {
      // Re-entering a mode: the lobby line-up is rebuilt so a joining player appears at once.
      if (mode === 'lobby') this.lobbyDirty = true;
      this.start();
      return;
    }
    this.mode = mode;
    this.t = 0;
    this.buildScene();
    this.start();
  }

  /** COLONY mode: 0/1/2 = which champion the pointer is on (also used for the picked one). */
  setFocus(idx: number): void {
    this.focus = idx;
  }

  /** COLONY mode: the colony this player has actually picked (-1 = none). */
  setSelected(idx: number): void {
    this.selected = idx;
  }

  /** NECROTECH mode: show the weapon of class `idx` (index into what was passed to `setMode`). */
  showWeapon(idx: number): void {
    this.weaponIdx = Math.max(0, idx);
    this.updateWeaponVisibility();
  }

  /**
   * LOBBY mode: the current roster. The line-up rebuilds itself only when the SET of seats or
   * their outfits change; a ready toggle just repaints the ring, so nobody's avatar (or pet) is
   * yanked out from under the lobby while people are readying up. `soloFill` is the shell home's
   * one-figure framing — see `lobbySoloFill`.
   */
  setLobbyAvatars(list: LobbyAvatarInfo[], soloFill = false): void {
    this.lobbyData = list.map(p => ({ ...p }));
    this.lobbySoloFill = soloFill;
    this.lobbyDirty = true;
    // The solo home's canvas spills past the stage box, so its turntable drag belongs to the whole
    // page (nothing on the home page competes for a press); a line-up keeps the rail host.
    if (this.mode === 'lobby' && this.host) {
      this.attachDrag(soloFill ? this.host.closest('.nf-page') ?? this.host : this.host);
    }
  }

  /**
   * CUSTOMIZE mode: dress the avatar in the player's SAVED selection. There is deliberately no
   * hover override any more — the body only ever wears what has actually been equipped (user
   * request), so this is a plain apply.
   */
  showAccessories(sel: AccessorySelection): void {
    this.avatarSel = { ...sel };
    if (!this.avatarAcc) return;
    this.avatarAcc.set({ ...sel });
  }

  /**
   * CUSTOMIZE mode: showcase one of the TRIGGERED effect categories on the stage. The equipped
   * effect is replayed in a loop while its tab is open, and every new pick restarts it so the
   * choice has an immediate answer on the pad. `null` stops the showcase.
   */
  showEffect(cat: EffectCategory | null, idx: number): void {
    if (this.fxCat === cat && this.fxIdx === idx) return;
    this.fxCat = cat;
    this.fxIdx = idx;
    this.fxTimer = 0;
  }

  /**
   * CUSTOMIZE mode: sets the colony accent the avatar is built with (the account's colony colour,
   * resolved by the caller). A customize screen that is already open rebuilds its avatar at once,
   * so a colony that arrives while the menu is up still lands on the body.
   */
  setAvatarTint(tint: number): void {
    if (this.avatarTint === tint) return;
    this.avatarTint = tint;
    if (this.mode === 'customize') this.buildScene();
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * The stage renders at 30 fps (2026-09 thermal pass). It is a slow idle pose and a drag
   * turntable, not gameplay — and on a 120 Hz phone this halves the second WebGL context's cost.
   * Every frame that IS drawn is pixel-identical to before; only the number of frames changes.
   */
  private static readonly FRAME_MS = 1000 / 30;

  private start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      const elapsed = now - this.last;
      if (elapsed + 1.5 < SelectionPreview.FRAME_MS) return;
      this.last = now;
      const dt = Math.min(0.05, elapsed / 1000);
      this.update(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private buildScene(): void {
    // every model this scene has ever held is discarded on a mode switch: the two modes share
    // nothing, and a selection screen is not a place to grow a model cache across matches
    this.disposeLobbyAvatars();
    this.fxRunner?.clear();
    this.fxRunner = null;
    for (const child of [...this.scene.children]) {
      if (child instanceof THREE.Light) continue;
      this.scene.remove(child);
    }
    this.figures.length = 0;
    this.weapons.clear();
    this.weaponPivot = new THREE.Group();
    this.standRing = null;
    // the weapon stand's back light belongs to the necrotech mode alone — drop its buffers with it
    if (this.standGlow) {
      this.standGlow.removeFromParent();
      disposeObject(this.standGlow);
      this.standGlow = null;
    }
    this.standGlowMat = null;
    this.standLight = null;
    if (this.avatarAcc) {
      this.avatarAcc.dispose();
      this.avatarAcc = null;
      this.avatarParts = null;
    }
    if (this.avatarPad) {
      this.avatarPad.removeFromParent();
      disposeObject(this.avatarPad);
      this.avatarPad = null;
    }

    if (this.mode === 'colony') {
      this.camera.position.set(0, 1.35, COLONY_CAM_DIST);
      this.camera.lookAt(0, 0.95, 0);
      this.colonyTop = 0;
      COLONIES.forEach((c, idx) => {
        const fig = buildFigure(c.color);
        fig.group.position.x = (idx - 1) * COLONY_SLOT;
        this.figures.push(fig);
        this.scene.add(fig.group);
        // measure the REAL height of each champion: the frame-filling scale below is solved from
        // it, so the figures can never end up either tiny or cropped
        const bb = new THREE.Box3().setFromObject(fig.group);
        this.colonyTop = Math.max(this.colonyTop, bb.max.y);
      });
      if (this.colonyTop < 0.5) this.colonyTop = 1.85;
    } else if (this.mode === 'necrotech') {      // Framed so NOTHING in the stage is sliced. Two opposite edges to respect: the pad's front
      // rim used to be chopped by the frustum's bottom edge (aimed too high), and once the stage
      // grew the backdrop ring / halo sat right ON the top edge — a circle with its crown flat
      // against the frame reads as "cut off at the top". Raised the whole view ~0.15 so the ring
      // keeps a band of air above it and the halo's soft top stays inside; the pad's rim ends just
      // inside the bottom edge, and the strip below still overlaps the canvas's last pixels
      // (see `.nt-screen .nt-grid`) so the base tucks behind the class list.
      this.camera.position.set(0, 0.95, 3.9);
      this.camera.lookAt(0, 0.75, 0);
      // a hex pedestal + a ring of the CURRENT class colour, so the swap is visible even before the
      // weapon itself is recognised
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.95, 1.1, 0.14, 6),
        new THREE.MeshLambertMaterial({ color: 0x241d3a, flatShading: true })
      );
      plate.position.y = -0.07;
      const plateRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.96, 0.032, 6, 6),
        new THREE.MeshLambertMaterial({ color: 0x4a4066, flatShading: true })
      );
      plateRing.rotation.x = Math.PI / 2;
      plateRing.rotation.z = Math.PI / 6;
      plateRing.position.y = 0.02;
      const backdropMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      this.standRing = backdropMat;
      const backdrop = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.024, 6, 48), backdropMat);
      backdrop.position.y = 1.0;
      // ---- the back light: a soft halo right behind the weapon, plus a white point light lifting
      // the model off the backdrop. The guns are deliberately dark primitives whose accents ARE the
      // read, which against the menu's near-black screen left some classes as little more than a
      // silhouette — the same treatment the item chips and the avatar pads get.
      this.standGlowMat = new THREE.MeshBasicMaterial({
        map: lightPoolTexture(), color: 0xffffff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      // 2.1 keeps the soft top of the halo clear of the frame's top edge (2.4 reached NDC 1.04 and
      // was sliced flat when the stage expanded); the glow still spills well past the backdrop ring
      this.standGlow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), this.standGlowMat);
      this.standGlow.position.set(0, 1.0, -0.75);
      this.standLight = new THREE.PointLight(0xffffff, 8, 4.5, 2);
      this.standLight.position.set(0, 1.3, 1.1);
      this.scene.add(plate, plateRing, backdrop, this.standGlow, this.standLight);
      this.weaponPivot.position.y = 1.0;
      this.scene.add(this.weaponPivot);
      // build every class's weapon lazily-but-eagerly: at most 11 small primitive groups, so the
      // swap on hover is instant and never allocates mid-interaction
      this.weaponDefs.forEach((def, idx) => {
        const model = buildWeaponModel(def);
        model.visible = false;
        this.weapons.set(idx, model);
        this.weaponPivot.add(model);
      });
      this.updateWeaponVisibility();
    } else if (this.mode === 'customize') {
      // ---- CUSTOMIZE: the player's own model, dressed with everything at once and wearing the
      // account colony's colours (user ask). Using the MATCH builder here is the whole trick —
      // the menu cannot drift from the game.
      this.camera.position.set(0, 1.78, 4.4);
      this.camera.lookAt(0, 1.08, 0);
      // the avatar's own lit pad — the same stage the lobby's line-up stands on, tinted like the
      // body so the pad light never fights the colony accent
      this.avatarPad = this.buildPad(this.avatarTint, 1.35);
      this.scene.add(this.avatarPad);
      this.avatarParts = buildPlayerModel(this.avatarTint);
      this.avatarParts.group.position.y = 0.02;
      this.scene.add(this.avatarParts.group);
      this.avatarAcc = new AvatarAccessories(
        this.avatarParts.headMount,
        this.avatarParts.backMount,
        this.avatarParts.pack,
        this.scene
      );
      this.avatarAcc.set(this.avatarSel, true);
      // the effect showcase: its own small runner, looping whatever the open tab has equipped
      this.fxRunner = new CosmeticFxRunner(this.scene, 3);
    }
  }

  private updateWeaponVisibility(): void {
    for (const [idx, model] of this.weapons) model.visible = idx === this.weaponIdx;
    const def = this.weaponDefs[this.weaponIdx];
    if (def && this.standRing) this.standRing.color.setHex(def.stats.color);
    // the back light follows the class too: hovering a card repaints the whole stage, not just the
    // gun. The point light stays WHITE — its job is legibility, the halo's is identity.
    if (def && this.standGlowMat) this.standGlowMat.color.setHex(def.stats.color);
  }

  /**
   * Keeps the avatar filling the customize preview box at any shape: the distance is solved for
   * both the vertical (head to toes) and the horizontal (wingtip to wingtip) extent, and the wider
   * of the two wins — a tall phone column and a wide desktop panel both get the biggest body that
   * still fits, wings included.
   */
  private frameAvatar(): void {
    const H = 2.7;   // head, big hats and a little air
    const W = 3.5;   // wingtip to wingtip (plus the pet's roam ring)
    const vFov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.3, this.camera.aspect || 1);
    const tan = Math.tan(vFov / 2);
    const dist = Math.max(H / 2 / tan, W / 2 / (tan * aspect));
    // stand a little high and aim a little low: the lit pad under the avatar is part of the look,
    // and a dead-level camera would show it edge-on as a line
    this.camera.position.set(0, 1.78, dist);
    this.camera.lookAt(0, 1.08, 0);
  }

  // ------------------------------------------------------------ avatar turntable (customize)

  private attachDrag(el: HTMLElement): void {
    if (this.dragHost === el) return;
    this.detachDrag();
    this.dragHost = el;
    el.addEventListener('pointerdown', this.onDragDown);
    el.addEventListener('pointermove', this.onDragMove);
    el.addEventListener('pointerup', this.onDragUp);
    el.addEventListener('pointercancel', this.onDragUp);
  }

  private detachDrag(): void {
    const el = this.dragHost;
    if (!el) return;
    el.removeEventListener('pointerdown', this.onDragDown);
    el.removeEventListener('pointermove', this.onDragMove);
    el.removeEventListener('pointerup', this.onDragUp);
    el.removeEventListener('pointercancel', this.onDragUp);
    this.dragHost = null;
    this.dragging = false;
  }

  private onDragDown = (e: PointerEvent): void => {
    // The drag surface must not STEAL presses aimed at UI controls: pointer
    // capture retargets the following click to the capture element, so a button
    // inside the surface (the home PLAY module lives in it) would never fire.
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    this.dragging = true;
    this.dragX = e.clientX;
    if (this.mode === 'lobby') {
      this.lobbyYawVel = 0;
      this.lobbyLastDragAt = this.t;
    } else {
      this.avatarYawVel = 0;
      this.lastDragAt = this.t;
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (older WebKit) — dragging still works without it */
    }
    e.preventDefault();
  };

  private onDragMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragX;
    this.dragX = e.clientX;
    // the model TURNS WITH the pointer: drag right and the front follows
    const yaw = dx * 0.012;
    if (this.mode === 'lobby') {
      this.lobbyYawTarget += yaw;
      // a flick keeps coasting for roughly 0.6× the drag distance (decayed in update())
      this.lobbyYawVel = yaw * 2.2;
      this.lobbyLastDragAt = this.t;
    } else {
      this.avatarYawTarget += yaw;
      this.avatarYawVel = yaw * 2.2;
      this.lastDragAt = this.t;
    }
    e.preventDefault();
  };

  private onDragUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.mode === 'lobby') this.lobbyLastDragAt = this.t;
    else this.lastDragAt = this.t;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* released with the pointer already gone */
    }
  };

  private update(dt: number): void {
    this.t += dt;
    const el = this.host;
    const hostW = el ? el.clientWidth : 0;
    const hostH = el ? el.clientHeight : 0;
    if (!el || hostW < 8 || hostH < 8) return;
    // The shell home's lone champion renders into an oversized box around the stage (see
    // `soloBox`); every other mode renders straight into its host box.
    const box = this.mode === 'lobby' && this.lobbySoloFill ? this.soloBox(el) : null;
    const w = box ? box.w : hostW;
    const h = box ? box.h : hostH;
    if (box) this.placeCanvas(box, w, h);
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.renderer?.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // The line-up's frustum is solved from the render size — a reflow must re-layout it.
      if (this.mode === 'lobby') this.layoutLobby();
    }

    if (this.mode === 'colony') {
      // Frame the champions to fill the box: solve the scale from the measured height against the
      // visible world height at the figures' plane, clamp it (never shrink below the authored size,
      // never blow the line-up up past the cap), then re-aim the camera on the scaled body so the
      // leftover space is split evenly above the head and below the feet instead of pooling at the
      // bottom of the frame (the "extra space at the bottom" report).
      // A phone's stage is a SHALLOW strip (it shares the screen with three colony cards), so it
      // may use most of its box; a desktop stage is tall already and keeps the calmer fill.
      const touchStage = IS_TOUCH && this.height < COLONY_SHALLOW;
      const fill = touchStage ? COLONY_FILL_TOUCH : COLONY_FILL;
      const cap = touchStage ? COLONY_SCALE_MAX_TOUCH : COLONY_SCALE_MAX;
      const visH = 2 * COLONY_CAM_DIST * Math.tan((this.camera.fov * Math.PI) / 360);
      const scale = Math.min(cap, Math.max(1, (fill * visH) / this.colonyTop));
      if (Math.abs(scale - this.colonyScale) > 0.001) this.colonyScale = scale;
      const mid = (this.colonyScale * this.colonyTop) * 0.5;
      this.camera.position.set(0, mid + 0.38, COLONY_CAM_DIST);
      this.camera.lookAt(0, mid, 0);
      // …but never let the spread push the outer rings off a narrow stage: a short/portrait-ish
      // window is the one case where the authored slot can exceed the frame, so measure the room
      // the visible world width actually has at the figures' plane and shrink the slot to fit.
      const spread = Math.max(1, this.colonyScale / COLONY_SCALE_MAX);
      const reach = 0.78 * this.colonyScale + 0.45; // ring radius + pose-swing headroom
      const room = Math.max(1.6, (visH * this.camera.aspect) * 0.5 - reach);
      const slot = Math.min(COLONY_SLOT * spread, room);
      this.figures.forEach((fig, idx) => {
        // the pointer's champion takes the spotlight; the picked colony keeps a base glow.
        // The SLOT only spreads once a figure grows past the authored size — the desktop line-up
        // keeps its reviewed spacing and only a phone's slightly larger champions move apart.
        fig.group.position.x = (idx - 1) * slot;
        const focus = idx === this.focus ? 1 : idx === this.selected ? 0.5 : 0.1;
        poseFigure(fig, idx, this.t, focus, dt, this.colonyScale);
      });
    } else if (this.mode === 'lobby') {
      if (this.lobbyDirty) this.rebuildLobby();
      this.tickLobby(dt);
    } else if (this.mode === 'necrotech') {
      // a slow showcase turn with a small bob, so the silhouette is readable from every side
      this.weaponPivot.rotation.y = this.t * 0.55;
      this.weaponPivot.rotation.z = Math.sin(this.t * 0.8) * 0.06;
      this.weaponPivot.position.y = 1.0 + Math.sin(this.t * 1.1) * 0.05;
      // the halo breathes with the model, so the stage feels lit rather than painted
      if (this.standGlowMat) this.standGlowMat.opacity = 0.46 + Math.sin(this.t * 1.3) * 0.07;
    } else {
      // CUSTOMIZE: a breathing idle with a slow three-quarter sway (never a full turntable — you
      // are meeting your character, not inspecting a product). The camera re-frames on every
      // update so the avatar fills whatever box the layout gives it.
      this.frameAvatar();
      const parts = this.avatarParts;
      if (parts) {
        const t = this.t;
        // the turntable: drag sets the target, a flick coasts, and after a pause the avatar
        // drifts gently on its own again
        if (!this.dragging) {
          this.avatarYawTarget += this.avatarYawVel * dt;
          this.avatarYawVel *= Math.max(0, 1 - 3.5 * dt);
        }
        this.avatarYaw += (this.avatarYawTarget - this.avatarYaw) * Math.min(1, dt * 12);
        const idle = this.dragging ? 0 : Math.min(1, Math.max(0, (t - this.lastDragAt - 1.2) / 1.6));
        const breathe = Math.sin(t * 1.35);
        parts.group.position.y = 0.02 + breathe * 0.012;
        parts.group.rotation.y = this.avatarYaw + Math.sin(t * 0.32) * 0.1 * idle;
        parts.torso.rotation.x = breathe * 0.014;
        parts.armL.rotation.x = Math.sin(t * 0.9) * 0.05 - breathe * 0.01;
        parts.armR.rotation.x = -Math.sin(t * 0.9) * 0.05 - breathe * 0.01;
        this.avatarAcc?.tick(t, dt, 0);
        const pet = this.avatarAcc?.petCtl;
        if (pet) {
          pet.setVisible(true);
          pet.update(dt, ORIGIN, UP_AXIS, t, null);
        }
      }
      // the equipped effect loops on the pad while its tab is open (restarting on every pick)
      const fxr = this.fxRunner;
      if (fxr) {
        fxr.update(dt);
        if (this.fxCat && this.fxIdx >= 0) {
          this.fxTimer -= dt;
          if (this.fxTimer <= 0) {
            fxr.play(this.fxCat, this.fxIdx, ORIGIN, UP_AXIS);
            this.fxTimer = 3.2;
          }
        }
      }
    }
    // Never render before the backend exists — `render()` on an uninitialised WebGPURenderer throws.
    if (this.renderer && this.rendererReady) {
      this.renderer.render(this.scene, this.mode === 'lobby' ? this.lobbyCam : this.camera);
    }
  }

  // ------------------------------------------------------------ lobby line-up

  /** Rebuilds the avatar row when the seats or the outfits changed; flags alone do not. */
  private rebuildLobby(): void {
    this.lobbyDirty = false;
    const sig = this.lobbyData.map(p => `${p.id}|${p.colony}|${p.acc}|${p.empty ? 'e' : ''}`).join(';');
    if (sig === this.lobbySig) {
      this.lobbyAvatars.forEach((fig) => {
        const next = this.lobbyData[fig.slot];
        if (next) fig.data = next;
      });
      return;
    }
    // dispose FIRST — it clears `lobbySig` (the mode switches rely on that) — and only then
    // record the new signature. Writing it before the dispose silently reset it to '' and
    // EVERY data tick disposed + rebuilt the whole line-up (user report 2026-09-29: "avatars
    // keep resetting every few seconds", exactly on the seat-DOM rebuild cadence).
    this.disposeLobbyAvatars();
    this.lobbySig = sig;
    if (this.lobbyData.length > 0) this.ensureLobbyLights();
    // one figure per OCCUPIED seat, one bare lit pad per OPEN seat — the row keeps its
    // slot rhythm either way, so a partially filled lobby still shows its full shape
    this.lobbyData.forEach((p, slot) => {
      if (p.empty) this.buildEmptyPad(slot);
      else this.buildLobbyFigure(p, slot);
    });
    this.applyLobbyLighting();
    this.layoutLobby();
  }

  /**
   * Per-pad point lights are skipped in CROWDED lobbies (more than four occupied seats):
   * nine of those lights over ~200 avatar materials is exactly the 9-slot lag the user hit.
   * The shared fill/bounce take over, boosted so the bodies stay legible.
   */
  private applyLobbyLighting(): void {
    if (!this.lobbyFill || !this.lobbyBounce) return;
    const crowded = this.lobbyAvatars.length > 4;
    this.lobbyFill.intensity = crowded ? 1.95 : 1.35;
    this.lobbyBounce.intensity = crowded ? 1.15 : 0.85;
  }

  /**
   * The lit pad an avatar stands on, shared by the lobby line-up and the customize stage: a dark
   * disc whose TOP face is y = 0 (the avatar's feet), a lit rim in the accent colour, a pool of
   * simulated light spilling over the feet and a real point light washing the body. The menu
   * backdrop is near-black and the player bodies are near-black too — the pad is what makes a
   * survivor legible instead of a silhouette.
   */
  private buildPad(color: number, radius = 0.66, alpha = 1, lit = true, poolScale = 3.7): THREE.Group {
    const pad = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 1.15, 0.09, 28),
      new THREE.MeshLambertMaterial({ color: 0x2a2044, flatShading: true })
    );
    disc.position.y = -0.045;
    const rimMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.75 * alpha, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.01, 0.028, 8, 44), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.005;
    const poolMat = new THREE.MeshBasicMaterial({
      map: lightPoolTexture(), color, transparent: true, opacity: 0.5 * alpha,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(radius * poolScale, radius * poolScale), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.012;
    pad.add(disc, rim, pool);
    // A real point light per pad is what makes the near-black bodies legible — but LIGHTS
    // are the shader's most expensive uniform loop, and a 9-seat P2P lobby would add nine
    // of them (+ the two fill lights) over ~200 avatar materials. Open seats ride the
    // additive rim/pool alone, and crowded lobbies (more than 4 seats) skip the per-pad
    // lights entirely — the boosted fill light below carries them instead (user report:
    // "creating 9 avatar slots. becoming too laggy").
    if (lit) {
      const light = new THREE.PointLight(color, radius > 1 ? 9 : 6, radius * 4.2, 2);
      light.position.set(0, 0.55, 0.25);
      pad.add(light);
    }
    return pad;
  }

  /** AN OPEN SEAT (user ask): the lit platform of the line-up with nobody standing on it. */
  private buildEmptyPad(slot: number): void {
    const pad = this.buildPad(0x8a79d8, 0.6, 0.34, false, 2.9);
    this.scene.add(pad);
    this.lobbyEmptyPads.push({ slot, pad });
  }

  /**
   * One seat = the REAL player model (the same builder the match uses) dressed with that player's
   * own hat, backpack and pet — the customize screen's avatar, once per survivor — standing on a
   * lit pad so the near-black body reads against the menu's dark backdrop.
   */
  private buildLobbyFigure(p: LobbyAvatarInfo, slot: number): void {
    const colony = p.colony >= 0 ? COLONIES[p.colony] : undefined;
    const color = colony ? colony.color : 0x9a7bff;
    const parts = buildPlayerModel(color);
    parts.group.position.y = 0.02;
    const sel = selectionFromWire(p.acc) ?? { ...EMPTY_SELECTION };
    const acc = new AvatarAccessories(parts.headMount, parts.backMount, parts.pack, this.scene);
    acc.set(sel, true);
    // the avatar's own pad — the same lit stage the customize screen stands on;
    // its POINT LIGHT only exists while the lobby is not crowded (see applyLobbyLighting)
    const litPad = this.lobbyData.filter((x) => !x.empty).length <= 4;
    const pad = this.buildPad(color, 0.66, 1, litPad);
    this.scene.add(pad);
    // a flat ring ON the pad: it is what tells ready from waiting at a glance
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.63, 40), ringMat);
    ring.geometry.rotateX(-Math.PI / 2);
    ring.position.y = 0.02;
    parts.group.add(ring);
    this.scene.add(parts.group);
    this.lobbyAvatars.push({ data: p, parts, acc, ringMat, pad, slot, anchor: new THREE.Vector3() });
  }

  /** A front fill and a brighter bounce for the lobby only — removed again with the line-up. */
  private ensureLobbyLights(): void {
    if (this.lobbyLights.length > 0) return;
    const fill = new THREE.DirectionalLight(0xe4dcff, 1.35);
    fill.position.set(0.4, 2.6, 7);
    const bounce = new THREE.HemisphereLight(0xc9d4ff, 0x4a3568, 0.85);
    this.lobbyFill = fill;
    this.lobbyBounce = bounce;
    this.scene.add(fill, bounce);
    this.lobbyLights.push(fill, bounce);
  }

  /**
   * The shell home's solitary champion stage: the render box the avatar may GROW into. The stage
   * itself is a shallow layout strip between the wordmark and the colony caption, and framing the
   * camera to that strip sliced tall hats off the top and cut the pet off at the sides. The canvas
   * is therefore allowed to spill past the stage — up towards the wordmark, sideways to the pane's
   * edges — while always staying INSIDE the pane that clips it: the avatar can slide behind the
   * shell's own text and bars (all of them painted above the canvas), never off the screen.
   */
  private soloBox(host: HTMLElement): { x: number; y: number; w: number; h: number } {
    const rect = host.getBoundingClientRect();
    const pane = host.closest('.nf-main')?.getBoundingClientRect() ?? null;
    const nav = document.querySelector('.nf-bottom')?.getBoundingClientRect() ?? null;
    const vw = window.innerWidth;
    const left = Math.max(pane ? pane.left + 4 : 4, rect.left - 280);
    const right = Math.min(pane ? pane.right - 4 : vw - 4, rect.right + 280);
    const top = Math.max(pane ? pane.top + 4 : 4, rect.top - 340);
    // Below the stage the avatar only needs room for its floor pad: 24px of spill keeps the feet
    // just past the caption line without reaching the floating bar (which is z-raised above it).
    const bottom = Math.min(
      nav && nav.height > 0 ? nav.top - 6 : Infinity,
      pane ? pane.bottom - 4 : Infinity,
      rect.bottom + 24
    );
    return {
      x: left - rect.left,
      y: top - rect.top,
      w: Math.max(rect.width, right - left),
      h: Math.max(rect.height, bottom - top),
    };
  }

  /** Writes the oversized canvas geometry (inline px beats the stylesheet's 100% defaults). */
  private placeCanvas(box: { x: number; y: number }, w: number, h: number): void {
    const cs = this.canvas.style;
    const px = (v: number): string => `${Math.round(v)}px`;
    if (cs.left !== px(box.x) || cs.top !== px(box.y) || cs.width !== px(w) || cs.height !== px(h)) {
      cs.position = 'absolute';
      cs.left = px(box.x);
      cs.top = px(box.y);
      cs.width = px(w);
      cs.height = px(h);
    }
  }

  /**
   * Places the line-up and frames it. The ortho frustum is sized so that one world "slot" is
   * exactly one seat card wide, then every figure is centred on the middle of its own slot — the
   * same (i + 0.5)/n the seat row uses in CSS.
   */
  private layoutLobby(): void {
    const n = this.lobbyAvatars.length;
    const aspect = Math.max(0.3, this.width / Math.max(1, this.height));
    const solo = n === 1 && this.lobbySoloFill && this.lobbyData.length === 1;
    const cam = this.lobbyCam;
    if (solo) {
      // ONE champion, staged alone on the shell home. The frame is solved from what the avatar
      // actually IS — body, ground pad and HAT — plus the pet's menu ring (see the roam clamp
      // in `tickLobby`), never from the stage's own shallow strip. The `fill` term keeps the body
      // as large as the board allows (0.8 of the canvas height — user ask: "the avatar can be
      // bigger to fit the center space") and the two fit terms stop it from ever growing past
      // the pieces that must stay visible.
      const AV = 2.0;          // the standing body the player reads
      const GROUND_PAD = 0.32; // floor left under the feet for the lit pad's front rim
      const MIN_W = 2.52;      // the pet's menu ring, both bodies included, either side of the owner
      const HAT_AIR = 0.3;     // clear sky above whatever is worn on the head
      const FRAME_DOWN = 0.12; // the whole frame sits a touch lower so tall hats clear the title
      // THE FIGURE'S REAL HEIGHT (user report 2026-10-03: "avatar hat gets cut off at the
      // top"): solve the frame from the figure's OWN bounds — body + whatever hat is worn —
      // never from a guessed air gap. A tall hat shrinks the frame to fit instead of
      // slicing at the canvas top.
      let frameH = 2.62;
      const corner = new THREE.Vector3();
      for (const fig of this.lobbyAvatars) {
        const group = fig.parts.group;
        group.updateWorldMatrix(true, true);
        let topY = AV;
        group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.geometry) return;
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox;
          if (!bb) return;
          for (let ci = 0; ci < 8; ci++) {
            corner.set(ci & 1 ? bb.max.x : bb.min.x, ci & 2 ? bb.max.y : bb.min.y, ci & 4 ? bb.max.z : bb.min.z);
            mesh.localToWorld(corner);
            if (corner.y > topY) topY = corner.y;
          }
        });
        frameH = Math.max(frameH, topY + HAT_AIR + GROUND_PAD);
      }
      // a (pathologically tall) accessory must not shrink the champion into a dot
      const MIN_H = Math.min(frameH, 3.5);
      const dens = Math.min((this.height * 0.8) / AV, this.width / MIN_W, this.height / MIN_H);
      const visW = this.width / Math.max(1, dens);
      const visH = this.height / Math.max(1, dens);
      cam.left = -visW / 2;
      cam.right = visW / 2;
      cam.top = visH / 2;
      cam.bottom = -visH / 2;
      const midY = -GROUND_PAD + visH / 2 + FRAME_DOWN;
      cam.position.set(0, midY + 1.5, 7.6);
      cam.lookAt(0, midY - 0.08, 0);
      cam.updateProjectionMatrix();
      for (const fig of this.lobbyAvatars) {
        fig.parts.group.position.x = 0;
        fig.pad.position.x = 0;
      }
      return;
    }
    const SLOT = 1.85;                                  // world width budget per player
    // The row is laid out over its SEAT COUNT (empty seats hold their slot), so a line-up
    // always reads as the party's full shape. A 3.0 guard never crops a standing avatar
    // (the solo home was branched out above).
    const slots = Math.max(1, this.lobbyData.length);
    const visH = Math.max(3.0, (SLOT * slots) / aspect);
    const visW = visH * aspect;
    cam.left = -visW / 2;
    cam.right = visW / 2;
    cam.top = visH / 2;
    cam.bottom = -visH / 2;
    // Feet a fixed slice above the bottom edge whatever the line-up's size, and the camera sits a
    // little HIGH and aims a little low: the pads under the avatars are what stop the near-black
    // bodies dissolving into the backdrop, and a dead-level view would show them edge-on.
    const groundY = -0.35;
    const midY = groundY + visH / 2;
    cam.position.set(0, midY + 1.5, 7.6);
    cam.lookAt(0, midY - 0.08, 0);
    cam.updateProjectionMatrix();
    this.lobbyAvatars.forEach((fig) => {
      const x = ((fig.slot + 0.5) / slots - 0.5) * visW;
      fig.parts.group.position.x = x;
      fig.pad.position.x = x;
    });
    for (const open of this.lobbyEmptyPads) {
      open.pad.position.x = ((open.slot + 0.5) / slots - 0.5) * visW;
    }
  }

  /**
   * The lobby idle: a breathing stance with a slow sway, outfit and pet ticking exactly like they
   * do on the customize screen (menu == game == lobby). Pets roam around their OWN owner, and are
   * left free to cross into the neighbouring slot — that overlap is what makes the row read as
   * one scene instead of a strip of clipped icons.
   */
  private tickLobby(dt: number): void {
    const t = this.t;
    const solo = this.lobbyAvatars.length === 1 && this.lobbySoloFill;
    // the turntable: drag sets the target, a flick coasts, and a pause lets the idle sway return
    if (!this.dragging) {
      this.lobbyYawTarget += this.lobbyYawVel * dt;
      this.lobbyYawVel *= Math.max(0, 1 - 3.5 * dt);
    }
    this.lobbyYaw += (this.lobbyYawTarget - this.lobbyYaw) * Math.min(1, dt * 12);
    const idle = this.dragging ? 0 : Math.min(1, Math.max(0, (t - this.lobbyLastDragAt - 1.2) / 1.6));
    for (let i = 0; i < this.lobbyAvatars.length; i++) {
      const fig = this.lobbyAvatars[i];
      const ph = i * 1.37;
      const parts = fig.parts;
      const breathe = Math.sin(t * 1.2 + ph);
      parts.group.position.y = 0.02 + breathe * 0.012;
      parts.group.rotation.y = this.lobbyYaw - 0.22 + Math.sin(t * 0.31 + ph * 0.7) * 0.26 * idle;
      parts.torso.rotation.x = breathe * 0.014;
      parts.armL.rotation.x = Math.sin(t * 0.8 + ph) * 0.06 - breathe * 0.012;
      parts.armR.rotation.x = -Math.sin(t * 0.86 + ph) * 0.06 - breathe * 0.012;
      fig.acc.tick(t, dt, 0);
      const pet = fig.acc.petCtl;
      if (pet) {
        fig.anchor.set(parts.group.position.x, 0, 0);
        pet.setVisible(true);
        pet.update(dt, fig.anchor, UP_AXIS, t, null, solo ? MENU_PET_ROAM : undefined);
      }
      const want = fig.data.me ? 0.6 : fig.data.ready ? 0.46 : 0.16;
      fig.ringMat.opacity += (want + Math.sin(t * 1.5 + ph) * 0.05 - fig.ringMat.opacity) * Math.min(1, dt * 5);
    }
  }

  private disposeLobbyAvatars(): void {
    for (const fig of this.lobbyAvatars) {
      fig.acc.dispose();
      fig.parts.group.removeFromParent();
      disposeObject(fig.parts.group);
      fig.pad.removeFromParent();
      disposeObject(fig.pad);
    }
    this.lobbyAvatars.length = 0;
    for (const open of this.lobbyEmptyPads) {
      open.pad.removeFromParent();
      disposeObject(open.pad);
    }
    this.lobbyEmptyPads.length = 0;
    this.lobbySig = '';
    for (const light of this.lobbyLights) light.removeFromParent();
    this.lobbyLights.length = 0;
  }

  dispose(): void {
    this.stop();
    if (this.avatarAcc) {
      this.avatarAcc.dispose();
      this.avatarAcc = null;
      this.avatarParts = null;
    }
    if (this.avatarPad) {
      this.avatarPad.removeFromParent();
      disposeObject(this.avatarPad);
      this.avatarPad = null;
    }
    this.buildScene();       // drops every child (lights survive, which is all we need to keep)
    this.renderer?.dispose();
    this.renderer = null;
    this.rendererReady = false;
  }
}
