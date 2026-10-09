// NECROFALL — the three colony bases.
//
// Each colony owns a fortress SHIP that orbits the planet slowly: the hull, the walkable deck, the
// deck markings, the pylons and the colony-coloured shield bubble all ride with it, and it hovers
// `CONFIG.base.floatHeight` above whatever terrain it is over. Spawns and respawns land ON the deck
// (a rider is carried by the platform as it turns), and the ship's trail of engine sparks marks
// where it is in the sky.
//
// Below the ship's lane crossing is the colony's LANDING PAD, fixed on the ground for the whole
// match: the same cone-shaped shield skirt as before, now a HEALING spot for the owning colony —
// floating plus signs rise out of it, colony-mates mend and shed every debuff inside it, and every
// other colony is thrown off it like any hostile ward.
//
// Everything is derived from the match seed, the tower cluster's centre direction and the match
// clock, so every peer builds byte-identical bases with zero network traffic.
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { playerOcclusionNode } from '../rendering/materials/PlayerOcclusion';
import { COLONIES, CONFIG } from '../core/Config';
import type { Planet } from './Planet';
import type { Player } from '../player/Player';
import type { Game } from '../core/Game';
import { createBaseConeMaterial, createShieldMaterial } from '../towers/ShieldMaterial';
import { conformingBand, conformingCone, frameFor } from './GroundShapes';
import { Rand, clamp, hashString, orientToSurface, tangentBasis } from '../utils/Utils';

/** Small plus signs rising out of every landing pad. */
const PAD_PLUS_COUNT = 12;
/**
 * Planet spin axis — every ship orbits this, and riders on a deck are carried about it, so no two
 * ships can ever cross lanes and a carried player always turns with the platform under their feet.
 */
export const ORBIT_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * A plus-cross: the healing pad's sigil. Built from a twelve-point cross outline and extruded thin.
 * `flat` lays it into the pad's XZ plane (the small risers, read from above); otherwise it STANDS
 * UPRIGHT in the pad's XY plane, facing the approach with its normal along the pad's local +Z.
 */
function plusGeometry(size: number, thickness: number, depth: number, flat = true): THREE.BufferGeometry {
  const a = size;
  const b = thickness;
  const s = new THREE.Shape();
  s.moveTo(-b, -a);
  s.lineTo(b, -a);
  s.lineTo(b, -b);
  s.lineTo(a, -b);
  s.lineTo(a, b);
  s.lineTo(b, b);
  s.lineTo(b, a);
  s.lineTo(-b, a);
  s.lineTo(-b, b);
  s.lineTo(-a, b);
  s.lineTo(-a, -b);
  s.lineTo(-b, -b);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.center();
  if (flat) geo.rotateX(-Math.PI / 2);
  return geo;
}

export interface ColonyBase {
  colony: number;
  /** CURRENT deck centre — moves with the orbit. */
  center: THREE.Vector3;
  /** FIXED landing pad under the lane: the heal-pad centre and the enemy no-go footprint. */
  ground: THREE.Vector3;
  /** Unit direction of the lane the fortress hangs on, at THIS instant of the orbit. */
  dir: THREE.Vector3;
  up: THREE.Vector3;
  facing: THREE.Vector3;
  /** The lane direction at orbit angle 0 — the ship's orbit is this, turned about `ORBIT_AXIS`. */
  laneDir: THREE.Vector3;
  /** Current orbital angle (radians). */
  angle: number;
  /** How far the ship turned THIS frame — riders are carried by exactly this much. */
  dAngle: number;
  /** Current hover height above the terrain under the ship (see `placeShip`). */
  hover: number;
  /** Walkable deck radius (metres). */
  padRadius: number;
  /** Distance of the deck plane from the planet centre — the deck is FLAT at this radius. */
  deckRadius: number;
  /** Bubble / no-go radius (metres). */
  shieldRadius: number;
  /** How far the deck floats above the surface. */
  platformHeight: number;
  /** dot() threshold that decides whether a direction is over the deck. */
  footCos: number;
  /** The ship: hull, deck, markings, pylons and bubble all ride this group. */
  group: THREE.Group;
  /** The landing pad: cone, drop ring and heal pluses. Fixed on the ground for the match. */
  padGroup: THREE.Group;
  /** The colony shield bubble that wraps the deck. */
  dome: THREE.Mesh;
  domeMat: THREE.Material;
  /** The shield skirt rising off the landing footprint below the fortress. */
  groundConeMat: THREE.Material;
  deckMat: THREE.MeshBasicMaterial;
  /** The colony logo painted on the deck: a flat ring, three spokes and a hub. */
  emblem: THREE.Object3D;
  emblemMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
  /** Thruster flare materials, flickered in `update`. */
  flares: THREE.MeshBasicMaterial[];
  /** Counter-rotating containment rings under the hull. */
  rings: THREE.Mesh[];
  /** Edge-launch rings: flat hoops that expand OUTWARD from the deck rim (colony colour). */
  edgeRings: THREE.Mesh[];
  edgeMat: THREE.MeshBasicMaterial;
  /** Seconds of edge-launch splash throttle left (one run-off must never double-fire). */
  edgeT: number;
  /** The long engine tail: a tapered plume drawn along the path the ship has just flown. */
  tail: THREE.Mesh;
  /** Recent flight-path points, newest at `tailHead` and `TAIL_SPACING` metres apart. */
  tailPts: THREE.Vector3[];
  tailHead: number;
  /** The pad's lit rim + inlaid emblem, pulsed in `updatePlusField`. */
  padRimMat: THREE.MeshBasicMaterial;
  padEmblemMat: THREE.MeshBasicMaterial;
  /** Heal-pad sigils: one big STANDING plus, plus a column of small risers (instanced). */
  plusBig: THREE.Mesh;
  plusBigMat: THREE.MeshBasicMaterial;
  plusHover: number;
  pluses: THREE.InstancedMesh;
  plusMat: THREE.MeshBasicMaterial;
  plusX: Float64Array;
  plusZ: Float64Array;
  plusPhase: Float64Array;
  plusSpin: Float64Array;
  /** Live spawn flash: 1 on a spawn, decays. */
  flash: number;
}

/** A no-go volume hostiles must stay out of, kept in a flat reusable array. */
export interface SafeZone {
  x: number;
  y: number;
  z: number;
  r: number;
}

// module scratch — every method below re-derives these before use, never across calls
const _dir = new THREE.Vector3();
const _lt1 = new THREE.Vector3();
const _lt2 = new THREE.Vector3();
const _lax = new THREE.Vector3();
const _ctr = new THREE.Vector3();
const _up = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
/** Outward normal at a player/base-dome contact point. */
const _pushN = new THREE.Vector3();
/** Outward-at-the-rim direction for the edge-launch check (never shares with `_pushN`). */
const _edgeN = new THREE.Vector3();
/** Ship placement scratch (update-time — never shares with the build/spawn scratches). */
const _shipDir = new THREE.Vector3();
const _shipGround = new THREE.Vector3();
/** Orbit radius (distance to the axis) of a ship — used to convert path metres to orbit angle. */
const _shipR = new THREE.Vector3();
/** Heal-pad sigil scratch. */
const _plusPos = new THREE.Vector3();
const _plusQ = new THREE.Quaternion();
const _plusQ2 = new THREE.Quaternion();
const _plusS = new THREE.Vector3();
const _plusM = new THREE.Matrix4();
const _plusCol = new THREE.Color();
/** Engine-tail scratch: the row being written, its two path neighbours, the axis and the tangent. */
const _tailP = new THREE.Vector3();
const _tailN1 = new THREE.Vector3();
const _tailN2 = new THREE.Vector3();
const _tailT = new THREE.Vector3();
const _tailA = new THREE.Vector3();
const _tailCol = new THREE.Color();
/** Strand scratch: the strand's own centre point, its ribbon side vector and the eye direction. */
const _tailC = new THREE.Vector3();
const _tailS = new THREE.Vector3();
const _tailW2 = new THREE.Vector3();
/** Pad-local axes for the sigils: Y is up out of the pad, Z is the cross's own normal. */
const PLUS_UP = new THREE.Vector3(0, 1, 0);
const PLUS_NORMAL = new THREE.Vector3(0, 0, 1);
// ---- the engine WAKE. The old tail was ONE wide tube dragged along the flight path, and a single
// solid plume as wide as the whole platform read as one long drip. What a fortress leaving a trail
// of engine light actually looks like is a BUNDLE OF STREAKS: separate thin ribbons, each spiralling
// and beading along the path like a string of particles, so the wake has texture instead of a skin.
/** Rows along each streak (one more than the number of path steps it covers). */
const TAIL_SEGS = 26;
/** Distance between two recorded path samples, in metres — a streak is TAIL_SEGS * this long. */
const TAIL_SPACING = 1.9;
/**
 * Radius the streaks are shed from where they leave the hull, tapering to nothing at the far end.
 * The bundle spans the ship's own footprint — as wide as the platform is across — but every single
 * streak inside it is thin (see TAIL_STREAK_W).
 */
const TAIL_RADIUS = CONFIG.base.padRadius;
/** Vertical squash of the bundle's cross-section: an engine wash spreads sideways, not into a ball. */
const TAIL_FLAT = 0.5;
/** Half-width of one streak, as a fraction of the bundle radius, with a floor so it never vanishes. */
const TAIL_STREAK_W = 0.09;
const TAIL_STREAK_W_MIN = 0.05;
/** Separate streaks of light in the wake — the tail is a particle stream, never one solid plume. */
const TAIL_STRANDS = 10;
/**
 * How far under the deck plane the wake runs (ship-local metres): its own half height, plus enough
 * to keep the whole wash under the hull. It used to hang only just clear of the deck and the tail
 * still showed from the platform (a wake following the terrain can sit HIGHER than the deck further
 * back up the path), so it now rides down at the engine mouths instead.
 */
const TAIL_DROP = TAIL_RADIUS * TAIL_FLAT + 6.6;
/**
 * How wide (metres of flight path) the terrain under a ship is averaged over, each way, before the
 * ship's hover height is taken from it. A short spatial low-pass: it removes the bumps the fortress
 * would otherwise bob over — with no temporal filter, so the deck never lags the orbit. See
 * `BaseManager.wakeGround`.
 */
const GROUND_SPREAD = 12;
/** Samples taken on EACH side of the ship when averaging the ground along its path. */
const GROUND_SAMPLES = 3;
/**
 * The wake's rows, resampled every frame from the recorded path. Module scratch: they are written
 * and consumed inside `updateTail` and never held across a frame.
 */
const _tailRows: THREE.Vector3[] = [];
for (let i = 0; i <= TAIL_SEGS; i++) _tailRows.push(new THREE.Vector3());
/** The walk's current point along the recorded path. */
const _tailW = new THREE.Vector3();

/**
 * Outward direction of a colony's approach lane: colony 0/1/2 are 120° apart around the tower
 * cluster and each is tilted `CONFIG.base.laneAngle` off the cluster axis. Shared by the bases and
 * by `Game.spawnPointFor`, which is what keeps every spawn inside its own dome.
 */
export function colonyLaneDir(seed: number, colony: number, centerDir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const col = Math.max(0, colony);
  const lane = new Rand(hashString(`nf-lane-${seed >>> 0}-${col}`));
  tangentBasis(centerDir, _lt1, _lt2);
  const theta = col * ((Math.PI * 2) / 3) + lane.range(-0.35, 0.35);
  _lax.copy(_lt1).multiplyScalar(Math.cos(theta)).addScaledVector(_lt2, Math.sin(theta)).normalize();
  const spread = CONFIG.base.laneSpread;
  const tilt = ((CONFIG.base.laneAngle + lane.range(-spread, spread)) * Math.PI) / 180;
  return out.copy(centerDir).applyAxisAngle(_lax, tilt).normalize();
}

export class BaseManager {
  readonly bases: ColonyBase[] = [];
  /** Stable zone list for enemy avoidance, rebuilt on `build` and mutated in place. */
  readonly zones: SafeZone[] = [];
  readonly group = new THREE.Group();

  private planet: Planet | null = null;
  private scene: THREE.Scene | null = null;
  private centerDir = new THREE.Vector3();
  private seed = 0;
  private t = 0;
  /**
   * This peer's own smooth match clock, which the orbit runs on. It advances with dt and is only
   * gently pulled toward the host's `matchElapsed` (published 12x a second), so the ships glide
   * instead of lurching on every snapshot.
   */
  private shipClock = 0;
  /** Throttle for the base-shield repulsion splash, so leaning on a dome does not spam it. */
  private pushFxT = 0;
  constructor(private game: Game) {}

  /**
   * Builds (or rebuilds) the three orbiting fortresses for a match. Deterministic from the match
   * seed — and from `elapsed`, so a player dropping into a running match finds every ship at the
   * orbital angle the host's clock says it should be at instead of watching it glide into place.
   */
  build(planet: Planet, seed: number, scene: THREE.Scene, centerDir: THREE.Vector3, elapsed = 0): void {
    this.planet = planet;
    this.seed = seed;
    this.centerDir.copy(centerDir);
    if (this.scene !== scene) {
      this.scene?.remove(this.group);
      this.scene = scene;
      scene.add(this.group);
    }
    this.clear();
    const rate = (Math.PI * 2) / CONFIG.base.orbitTime;
    this.shipClock = Math.max(0, elapsed);
    for (let colony = 0; colony < COLONIES.length; colony++) {
      const base = this.buildOne(colony, centerDir);
      base.angle = rate * this.shipClock;
      this.placeShip(base);
      // the tail starts out already at full length, seeded from the path the ship has "just flown"
      this.seedTail(base);
      this.updateTail(base);
      this.bases.push(base);
      // The no-go volume sits on the GROUND under the lane crossing, so the healing pad below is
      // protected — an enemy can never camp the spot a colony-mate is trying to heal on.
      this.zones.push({ x: base.ground.x, y: base.ground.y, z: base.ground.z, r: base.shieldRadius });
    }
  }

  forColony(colony: number): ColonyBase | null {
    return this.bases[colony] ?? null;
  }

  /**
   * Moves the ship part of a base to its current orbital angle: the lane direction turned about the
   * planet's axis, the terrain under it looked up fresh (the ship holds its height over whatever it
   * is flying across), then the group transform. Everything that reads `center` / `up` / `dir` /
   * `deckRadius` / `footCos` — spawns, the deck support, the dome, the plates — follows from here.
   *
   * The ship rides a SPATIALLY smoothed height field: the terrain is averaged over a short stretch
   * of the ship's own path (`wakeGround`) instead of being sampled at one point, so the fortress
   * glides on a smooth arc rather than mirroring every bump it crosses. The position is exact for
   * the CURRENT angle — there is no temporal filter, so no lag, no catch-up and no frame-rate
   * dependence: the deck a rider stands on always moves with the angle the sim says it does, which
   * is what keeps the ride (and the deck under a walking player) free of jitter.
   */
  private placeShip(b: ColonyBase): void {
    const planet = this.planet;
    if (!planet) return;
    _shipDir.copy(b.laneDir).applyAxisAngle(ORBIT_AXIS, b.angle).normalize();
    b.dir.copy(_shipDir);
    b.up.copy(_shipDir);
    b.hover = CONFIG.base.floatHeight;
    this.wakeGround(b, _shipGround);
    b.center.copy(_shipGround).addScaledVector(_shipDir, b.hover);
    b.deckRadius = b.center.length();
    b.footCos = Math.cos(b.padRadius / Math.max(1, b.deckRadius));
    // nose towards the battlefield so the deck markings keep pointing at the fight
    b.facing.copy(this.centerDir).addScaledVector(b.up, -this.centerDir.dot(b.up));
    if (b.facing.lengthSq() < 1e-5) tangentBasis(b.up, b.facing, _t2);
    b.facing.normalize();
    orientToSurface(b.group, b.center, b.up, b.facing);
  }

  /**
   * The ground under a ship, AVERAGED along the ship's own flight path (a spatial low-pass whose
   * width is fixed in metres of the orbit, so it cannot depend on frame timing). A pure function of
   * the orbit angle: every peer re-derives the same value every frame, so it can never introduce
   * drift, lag or a disagreement between peers.
   */
  private wakeGround(b: ColonyBase, out: THREE.Vector3): THREE.Vector3 {
    const planet = this.planet!;
    // metres along the path -> angle about the planet's AXIS (a circle around that axis)
    const orbitR = Math.max(1, _shipR.copy(b.center).projectOnPlane(ORBIT_AXIS).length());
    const dA = GROUND_SPREAD / orbitR;
    let h = 0;
    let wsum = 0;
    for (let i = -GROUND_SAMPLES; i <= GROUND_SAMPLES; i++) {
      const wi = GROUND_SAMPLES + 1 - Math.abs(i);
      _ctr.copy(b.laneDir).applyAxisAngle(ORBIT_AXIS, b.angle + i * dA).normalize();
      h += planet.heightAtDir(_ctr.x, _ctr.y, _ctr.z) * wi;
      wsum += wi;
    }
    return out.copy(_shipDir).multiplyScalar(h / wsum);
  }

  /**
   * The fortress deck a surface direction points at, if any — the live base, so read what you need
   * straight away. The deck is a FLAT plane at `deckRadius`, exactly matching the mesh: the player's
   * ground solver stands on that plane rather than on a terrain-relative height, which is what keeps
   * the feet from sinking through the platform as it flies across the hills below.
   */
  deckUnder(dir: THREE.Vector3): ColonyBase | null {
    for (const b of this.bases) {
      if (dir.dot(b.dir) >= b.footCos) return b;
    }
    return null;
  }

  /**
   * Where a player of this colony starts and respawns: a stable personal slot ON its fortress deck,
   * at wherever the ship currently is on its orbit. Depends on nothing but the seed, the planet, the
   * id and the ship's angle, so it is valid before (and independently of) `build` — the world
   * rebuild repositions players before the fortresses are made.
   *
   * The slot is PROJECTED on to the deck's own flat plane (`deckRadius`), never left at "terrain
   * height + floatHeight": the deck is flat while the hills below are not, so a slot whose ground
   * sat a couple of metres low landed outside the deck's support band and the player dropped the
   * instant they spawned.
   */
  spawnPoint(planet: Planet, colony: number, id: string, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.max(0, colony);
    const ship = this.bases[c] ?? null;
    colonyLaneDir(this.seed, c, this.centerDir, _dir);
    if (ship) _dir.copy(ship.dir);              // the ship's CURRENT spot on its orbit
    planet.surfacePointFromDir(_dir, _ctr);
    _up.copy(ship ? ship.up : _ctr).normalize();
    const deckRadius = ship ? ship.deckRadius : _ctr.length() + CONFIG.base.floatHeight;
    tangentBasis(_up, _t1, _t2);
    const slot = new Rand(hashString(`nf-baseslot-${this.seed >>> 0}-${id || 'solo'}`));
    const ang = slot.range(0, Math.PI * 2);
    const frac = slot.range(CONFIG.base.spawnInner, CONFIG.base.spawnOuter);
    // The slot's angular offset is measured against the DECK's radius, never the planet's: the deck's
    // own footprint test is `padRadius / deckRadius`, and a slot laid out against the much smaller
    // planet radius could land outside that test — which is what dropped a freshly spawned player
    // straight off the edge of the (now much higher) ship instead of leaving them standing on it.
    const away = (CONFIG.base.padRadius * frac) / deckRadius;
    _dir.copy(_up).addScaledVector(_t1, Math.cos(ang) * away).addScaledVector(_t2, Math.sin(ang) * away).normalize();
    // stand ON the deck: exactly on the deck's flat plane, `deckRadius` from the planet centre
    return out.copy(_dir).multiplyScalar(deckRadius);
  }

  /**
   * True while `p` stands in its own colony's healing pad — the fixed landing spot under the lane.
   * The pad is a plain distance test because only the SHIP orbits; the pad never moves.
   */
  healPad(p: Player): boolean {
    if (p.colony < 0) return false;
    const b = this.bases[p.colony];
    if (!b) return false;
    const r = b.shieldRadius;
    return p.position.distanceToSquared(b.ground) < r * r;
  }

  /** True when `pos` is inside a fortress bubble or the protected footprint under it. */
  contains(pos: THREE.Vector3, margin = 0): boolean {
    for (const b of this.bases) {
      const r = b.shieldRadius + margin;
      if (pos.distanceToSquared(b.center) < r * r) return true;
      if (pos.distanceToSquared(b.ground) < r * r) return true;
    }
    return false;
  }

  /**
   * An enemy fortress dome is a wall, not a doorway. It throws a player off the same way the tower
   * wards do — the body is set down outside the bubble, the inward half of its momentum is mirrored
   * and a heavy shove (part of it straight up) is added on top, so walking into a hostile base punts
   * you off your feet instead of letting you stroll in. Your own base never touches you.
   */
  collidePlayer(p: Player, game: Game): void {
    for (const b of this.bases) {
      if (b.colony === p.colony) continue;
      // the bubble around the deck, then the no-go footprint on the ground below it
      const deck = this.pushPlayerOut(p, b.center, b.shieldRadius);
      const ground = this.pushPlayerOut(p, b.ground, b.shieldRadius);
      if (!deck && !ground) continue;
      if (this.pushFxT > 0) continue;
      this.pushFxT = 0.35;
      const col = COLONIES[b.colony]?.color ?? 0xffffff;
      game.effects.ring(p.position, _pushN, 1.7, col, 0.5, 4.2, 1);
      game.effects.burst(p.position, col, { count: 26, speed: 15, life: 0.45, size: 0.7, gravity: 0 });
      game.effects.shake(0.35);
      game.audio.sfx('hit', 0.6);
      game.ui.toast(`${COLONIES[b.colony]?.name ?? 'ENEMY'} BASE SHIELD REPELS YOU`, 1400);
    }
  }

  /** Throws a player out of one dome volume. Returns true when the contact actually pushed them. */
  private pushPlayerOut(p: Player, centre: THREE.Vector3, radius: number): boolean {
    const limit = radius + CONFIG.player.radius;
    _pushN.copy(p.position).sub(centre);
    const d = _pushN.length();
    if (d >= limit || d < 0.001) return false;
    _pushN.multiplyScalar(1 / d);
    p.position.addScaledVector(_pushN, limit - d);
    const vn = p.velocity.dot(_pushN);
    if (vn >= 0) return true;                  // already on the way out
    const push = CONFIG.shieldPush;
    p.velocity.addScaledVector(_pushN, -vn * push.mirror + push.kick);
    p.velocity.addScaledVector(p.up, push.kick * push.lift);
    return true;
  }

  /**
   * The platform's outer edge is a SPRINGBOARD (user ask 2026-09-29): a colony-mate who runs at the
   * rim is flung outward ALONG THEIR OWN DIRECTION — the shield bounce's numbers, spent on the
   * player instead of against them. Movement is owner-simulated, so this runs for the local player
   * only; the trigger is a band just inside the walkable footprint's edge (the deck, not the ground
   * under it) plus real outward momentum, and a short per-base throttle keeps one run-off from
   * double-firing while the body is still crossing the band.
   */
  edgeLaunch(p: Player, game: Game): void {
    if (!p.alive || !p.grounded || p.colony < 0) return;
    const b = this.bases[p.colony];
    if (!b || b.edgeT > 0) return;
    // standing ON the deck itself: the same footprint test the support solver uses — a body on the
    // terrain below the ship (or through a hostile dome) reads `overDeck` far under and never fires
    if (this.deckUnder(p.up) !== b) return;
    _edgeN.copy(p.position).addScaledVector(b.up, -p.position.dot(b.up));
    const r = _edgeN.length();
    if (r < b.padRadius - 0.9) return;          // not at the rim yet
    _edgeN.multiplyScalar(1 / Math.max(0.001, r));
    const vn = p.velocity.dot(_edgeN);
    if (vn < 0.8) return;                       // it has to be a RUN at the edge, not a drift
    const push = CONFIG.base.edgePush;
    p.edgeBoost(_edgeN, vn * push.mirror + push.kick, push.kick * push.lift);
    b.edgeT = 0.5;
    const col = COLONIES[b.colony]?.color ?? 0xffffff;
    game.effects.ring(p.position, _edgeN, 1.7, col, 0.5, 4.2, 1);
    game.effects.burst(p.position, col, { count: 22, speed: 14, life: 0.5, size: 0.7, gravity: 0 });
    game.audio.sfx('jump', 0.8);
  }

  /** Called when somebody spawns, so the pad lights up briefly. */
  flashSpawn(colony: number): void {
    const b = this.forColony(colony);
    if (b) b.flash = 1;
  }

  /**
   * Per-frame base tick: the orbit, the ship's lights and the healing pad's sigils. `elapsed` is the
   * host-synced match clock — the ships converge on `rate * elapsed` rather than integrating their
   * own dt, so two peers can never drift the orbit apart no matter how jittery one of them runs.
   */
  update(dt: number, elapsed: number): void {
    this.t += dt;
    if (this.pushFxT > 0) this.pushFxT = Math.max(0, this.pushFxT - dt);
    // The orbit rides this peer's OWN smooth clock, only slowly corrected toward the host's match
    // clock. Driving the angle straight off `elapsed` made the fortress LURCH: `el` arrives twelve
    // times a second, so every snapshot kicked the ship forward and the chase that followed read as
    // stuttering. This way the ship glides on every peer and the snapshots only fix slow drift.
    this.shipClock += dt;
    const err = elapsed - this.shipClock;
    if (Number.isFinite(err) && Math.abs(err) > 0.002) {
      this.shipClock += err * clamp(dt * 0.5, 0, 1);
    }
    const rate = (Math.PI * 2) / CONFIG.base.orbitTime;
    for (const b of this.bases) {
      const prev = b.angle;
      b.angle = rate * this.shipClock;
      b.dAngle = b.angle - prev;
      this.placeShip(b);

      // the bubble and the shield skirt both breathe, so they read as energy and not as painted glass
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.3 + b.colony * 2.1);
      (b.domeMat as unknown as { uOpacity: { value: number } }).uOpacity.value = 0.28 + pulse * 0.08 + b.flash * 0.4;
      // The skirt carries a little more weight than it used to: the shader now drops the top third
      // of the cone entirely, so the part that IS drawn has to read as a wall on its own.
      (b.groundConeMat as unknown as { uOpacity: { value: number } }).uOpacity.value = 0.62 + pulse * 0.16 + b.flash * 0.45;
      b.rimMat.opacity = 0.34 + pulse * 0.14 + b.flash * 0.5;
      b.deckMat.opacity = 0.24 + pulse * 0.1 + b.flash * 0.35;
      b.emblem.rotation.y += dt * 0.35;
      // hover hardware: the thrusters flicker, the containment rings counter-rotate
      for (let i = 0; i < b.flares.length; i++) {
        b.flares[i].opacity = 0.34 + 0.3 * Math.sin(this.t * (5.4 + i * 1.3)) + b.flash * 0.3;
      }
      b.rings[0].rotation.y += dt * 0.5;
      b.rings[1].rotation.y -= dt * 0.34;
      // the edge-launch hoops: each sweeps outward from the rim on its own cycle, staggered per
      // ring and per colony — skipped (like the wake) when nobody is near this half of the planet
      if (b.edgeT > 0) b.edgeT = Math.max(0, b.edgeT - dt);
      const localP = this.game.localPlayer;
      const edgeNear = !localP || b.center.distanceToSquared(localP.position) <= 280 * 280;
      for (let i = 0; i < b.edgeRings.length; i++) {
        const ring = b.edgeRings[i];
        ring.visible = edgeNear;
        if (!edgeNear) continue;
        const cyc = (this.t * 0.34 + i / b.edgeRings.length + b.colony * 0.11) % 1;
        // from the rim to slightly PAST the shield bubble (user ask): the hoops are the dome's own
        // pulse, not a field-wide marker, so their outermost radius is the shield's own + a hair
        const r0 = b.padRadius * 0.98;
        const r1 = b.shieldRadius * 1.1;
        ring.scale.setScalar(r0 + (r1 - r0) * cyc);
      }
      b.edgeMat.opacity = edgeNear ? 0.16 + 0.1 * Math.sin(this.t * 2.2 + b.colony * 2.1) : 0;
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 1.6);

      this.updateTail(b);
      this.updatePlusField(b, dt);
    }
  }

  /**
   * Seeds the tail with the flight path the ship "has just flown", so a fortress that joins a
   * running match is already trailing a full-length plume instead of growing one over the next
   * fifteen seconds. Pure geometry — the angle is known, so the path can simply be walked back.
   */
  private seedTail(b: ColonyBase): void {
    const n = b.tailPts.length;
    // Arc length -> angle on the ORBIT. The path is a circle about the planet's AXIS, so its radius
    // is the distance to that axis (what the ship actually turns around) — using its distance to the
    // planet's centre instead measured the samples short and packed the whole tail into half its span.
    const orbitR = Math.max(1, _tailN2.copy(b.center).projectOnPlane(ORBIT_AXIS).length());
    const dA = TAIL_SPACING / orbitR;
    b.tailHead = 0;
    for (let k = 0; k < n; k++) {
      this.pathPoint(b, k * dA, b.tailPts[(n - k) % n]);
    }
  }

  /** The tail origin on the flight path, `back` radians behind the ship's current angle. */
  private pathPoint(b: ColonyBase, back: number, out: THREE.Vector3): THREE.Vector3 {
    const planet = this.planet;
    if (!planet) return out.copy(b.center);
    _shipDir.copy(b.laneDir).applyAxisAngle(ORBIT_AXIS, b.angle - back).normalize();
    planet.surfacePointFromDir(_shipDir, _shipGround);
    return out.copy(_shipGround).addScaledVector(_shipDir, b.hover - TAIL_DROP);
  }

  /**
   * The engine WAKE: a bundle of thin light streaks dragged off the hull and left hanging along the
   * flight path. A fresh path sample is recorded every `TAIL_SPACING` metres — distance, not time,
   * so every streak is the same length whatever the orbit is doing — and the streak rows are rebuilt
   * around those samples, each spiralling and beading so the bundle reads as streaming particles
   * rather than as one solid plume. Skipped when the local player is nowhere near that half of the
   * planet: a wake nobody can see is just geometry in the budget.
   */
  private updateTail(b: ColonyBase): void {
    const local = this.game.localPlayer;
    const near = !local || b.center.distanceToSquared(local.position) <= 280 * 280;
    b.tail.visible = near;
    if (!near) return;
    // head of the wake: a little under the deck plane, so it leaves the belly and not the deck
    _tailP.copy(b.center).addScaledVector(b.up, -TAIL_DROP);
    const n = b.tailPts.length;
    if (b.tailPts[b.tailHead].distanceToSquared(_tailP) >= TAIL_SPACING * TAIL_SPACING) {
      b.tailHead = (b.tailHead + 1) % n;
      b.tailPts[b.tailHead].copy(_tailP);
    }
    // Rows sit at FIXED distances behind the ship, interpolated ALONG the recorded path. Snapping a
    // row on to a stored sample instead made the whole taper step one notch further back every
    // `TAIL_SPACING` metres of flight, which read as the plume twitching (user: "very jittery").
    _tailRows[0].copy(_tailP);
    let row = 1;
    let need = TAIL_SPACING;
    let acc = 0;
    _tailW.copy(_tailP);
    for (let k = 0; k < n && row <= TAIL_SEGS; k++) {
      _tailN1.copy(b.tailPts[(b.tailHead - k + n) % n]);
      const seg = _tailW.distanceTo(_tailN1);
      if (seg > 1e-6) {
        while (need <= acc + seg && row <= TAIL_SEGS) {
          _tailRows[row].lerpVectors(_tailW, _tailN1, (need - acc) / seg);
          row++;
          need += TAIL_SPACING;
        }
      }
      acc += seg;
      _tailW.copy(_tailN1);
    }
    // out of recorded path (a ship that has just been built): hold the last point, nothing to draw
    while (row <= TAIL_SEGS) { _tailRows[row].copy(_tailW); row++; }
    const pos = b.tail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cols = b.tail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = cols.array as Float32Array;
    _tailCol.setHex(COLONIES[b.colony]?.color ?? 0xffffff);
    // every streak's ribbon is turned to face the camera, which is what makes it read as a light
    // trail rather than as a strip of tape seen edge-on
    const eye = this.game.cam.camera.position;
    for (let i = 0; i <= TAIL_SEGS; i++) {
      _tailP.copy(_tailRows[i]);
      _tailN1.copy(_tailRows[Math.max(0, i - 1)]);
      _tailN2.copy(_tailRows[Math.min(TAIL_SEGS, i + 1)]);
      // the bundle runs ALONG the path, so its cross-section is the plane across the path's tangent
      _tailT.copy(_tailN1).sub(_tailN2);
      if (_tailT.lengthSq() < 1e-8) continue;
      _tailT.normalize();
      _tailA.crossVectors(_tailT, ORBIT_AXIS);
      if (_tailA.lengthSq() < 1e-8) _tailA.crossVectors(_tailT, PLUS_UP);
      _tailA.normalize();
      const u = i / TAIL_SEGS;
      // the bundle spans the ship's own footprint where it leaves the hull, then CONTRACTS hard —
      // everything past the head is a trail, not another platform
      const w = TAIL_RADIUS * Math.pow(1 - u, 1.6);
      // BRIGHTNESS is the fade: dim over the hull (or the wide head swallows the ship), full a
      // little way behind it, nothing at all at the far end
      const fade = Math.pow(1 - u, 1.35) * (0.25 + 0.75 * Math.min(1, u * 4));
      const hw = Math.max(TAIL_STREAK_W_MIN, w * TAIL_STREAK_W);
      for (let j = 0; j < TAIL_STRANDS; j++) {
        // each streak keeps its own lane in the bundle (its own radius and phase), spirals as it
        // streams away and wobbles on the way, so the bundle never reads as a machined tube
        const lane = ((j * 7) % TAIL_STRANDS) / (TAIL_STRANDS - 1);
        const rad = w * (0.45 + 0.55 * lane);
        const ang = (j / TAIL_STRANDS) * Math.PI * 2 + i * 0.24
          + Math.sin(i * 0.5 - this.t * 2.1 + j * 2.4) * 0.35;
        _tailC.copy(_tailP)
          .addScaledVector(_tailA, Math.cos(ang) * rad)
          .addScaledVector(ORBIT_AXIS, Math.sin(ang) * rad * TAIL_FLAT);
        // flat ribbon facing the eye: the classic light-streak read, from any viewing angle
        _tailS.copy(eye).sub(_tailC);
        _tailS.crossVectors(_tailT, _tailS);
        if (_tailS.lengthSq() < 1e-8) _tailS.copy(_tailA);
        _tailS.normalize();
        // the BEADING is what makes it particles: bright dashes travel down every streak, so the
        // wake is a stream of light motes rather than an unbroken line
        const bead = 0.22 + 0.78 * Math.pow(
          0.5 + 0.5 * Math.sin(i * 0.95 - this.t * 8.5 + j * 1.7 + lane * 3), 2.4);
        const k = Math.min(1.2, fade * bead * (0.55 + 0.45 * lane));
        const o = (j * (TAIL_SEGS + 1) + i) * 2 * 3;
        pa[o] = _tailC.x + _tailS.x * hw;
        pa[o + 1] = _tailC.y + _tailS.y * hw;
        pa[o + 2] = _tailC.z + _tailS.z * hw;
        pa[o + 3] = _tailC.x - _tailS.x * hw;
        pa[o + 4] = _tailC.y - _tailS.y * hw;
        pa[o + 5] = _tailC.z - _tailS.z * hw;
        ca[o] = _tailCol.r * k;
        ca[o + 1] = _tailCol.g * k;
        ca[o + 2] = _tailCol.b * k;
        ca[o + 3] = ca[o];
        ca[o + 4] = ca[o + 1];
        ca[o + 5] = ca[o + 2];
      }
    }
    pos.needsUpdate = true;
    cols.needsUpdate = true;
  }

  /**
   * The healing pad's sigils: a giant plus STANDING over the middle — animated like the jump pad's
   * arrow (it bobs, turns and breathes) — and a ring of small pluses climbing out of the ground and
   * fading as they rise. EVERY plus stands UPRIGHT: a cross lying flat on the ground reads as a
   * painted cross, not as a sign, and the fold of ground it lies on can hide it entirely. The rise
   * IS the heal tell, and the pluses are colony-coloured so the pad reads as somebody's ground.
   */
  private updatePlusField(b: ColonyBase, dt: number): void {
    // the giant plus: same idle motion as the launch pad's arrow — bob, slow TURN ABOUT THE VERTICAL
    // (Y), scale pulse. It is a standing sign, so turning about Y is what makes it read as one.
    const bob = Math.sin(this.t * 2 + b.colony);
    b.plusBig.position.y = b.plusHover + bob * 0.22;
    b.plusBig.rotation.y += dt * 0.9;
    b.plusBig.scale.setScalar(1 + 0.06 * Math.sin(this.t * 3.4 + b.colony));
    b.plusBigMat.opacity = 0.5 + 0.16 * Math.sin(this.t * 2.4 + b.colony);
    // the physical pad breathes with it: the rim and the inlaid emblem are the ground half of the
    // same tell, and a spawn flashes them like every other base light
    const rimPulse = 0.5 + 0.5 * Math.sin(this.t * 2.6 + b.colony * 1.3);
    b.padRimMat.opacity = 0.35 + rimPulse * 0.25 + b.flash * 0.5;
    b.padEmblemMat.opacity = 0.4 + rimPulse * 0.25 + b.flash * 0.5;
    const col = COLONIES[b.colony]?.color ?? 0xffffff;
    for (let i = 0; i < PAD_PLUS_COUNT; i++) {
      b.plusPhase[i] += dt * (0.26 + (i % 3) * 0.035);
      const t = b.plusPhase[i] - Math.floor(b.plusPhase[i]);
      const fadeIn = Math.min(1, t / 0.16);
      const fadeOut = Math.min(1, (1 - t) / 0.34);
      const bright = fadeIn * fadeOut;
      const s = 0.55 + 0.45 * bright;
      const y = 0.8 + t * 9.5;
      _plusPos.set(b.plusX[i], y, b.plusZ[i]);
      // stand it upright, turned to face OUT from the middle of the pad, then spin it in its own
      // plane — the same read as the giant cross, at a fraction of the size
      _plusQ.setFromAxisAngle(PLUS_UP, b.plusSpin[i]);
      _plusQ2.setFromAxisAngle(PLUS_NORMAL, this.t * 0.7 + b.plusSpin[i] * 1.7);
      _plusQ.multiply(_plusQ2);
      _plusS.set(s, s, s);
      _plusM.compose(_plusPos, _plusQ, _plusS);
      b.pluses.setMatrixAt(i, _plusM);
      // additive material: brightness IS the fade
      _plusCol.setHex(col).multiplyScalar(0.22 + bright * 0.78);
      b.pluses.setColorAt(i, _plusCol);
    }
    b.pluses.instanceMatrix.needsUpdate = true;
    if (b.pluses.instanceColor) b.pluses.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ internals

  private buildOne(colony: number, centerDir: THREE.Vector3): ColonyBase {
    const col = COLONIES[colony];
    const laneDir = colonyLaneDir(this.seed, colony, centerDir, _dir).clone();
    // The lane crossing is FIXED: the ship orbits over it once per cycle, and the landing pad below
    // — the cone, the ring and the healing sigils — stays there for the whole match.
    const ground = new THREE.Vector3();
    this.planet!.surfacePointFromDir(laneDir, ground);
    const up = ground.clone().normalize();
    const center = ground.clone().addScaledVector(up, CONFIG.base.floatHeight);

    const padR = CONFIG.base.padRadius;
    const shieldR = CONFIG.base.shieldRadius;
    const H = CONFIG.base.floatHeight;
    const facing = new THREE.Vector3().copy(centerDir).addScaledVector(up, -centerDir.dot(up));
    if (facing.lengthSq() < 1e-5) tangentBasis(up, facing, _t2);
    facing.normalize();

    // ---- the SHIP: everything that flies. `placeShip` re-seats this group every frame; orienting
    // it here as well means the very first frame is already correct.
    const group = new THREE.Group();
    orientToSurface(group, center, up, facing);
    // local +Y is up, local y = 0 is the deck the player stands on, local y = -H is the surface

    // ---- the LANDING PAD: fixed on the ground under the lane crossing, and now a healing spot.
    const padGroup = new THREE.Group();
    orientToSurface(padGroup, ground, up, facing);

    // ---- deck: hull slab whose TOP face is the walkable plane, so the physics and the mesh agree
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(padR, padR * 1.03, 1.3, 28, 1),
      new MeshLambertNodeMaterial({ color: 0x1c1b26, alphaTest: 0.1 })
    );
    deck.position.y = -0.65;
    deck.material.opacityNode = playerOcclusionNode();
    group.add(deck);

    // ---- under-hull: an inverted frustum, so the fortress reads as built and not as a cut-out
    const belly = new THREE.Mesh(
      new THREE.CylinderGeometry(padR * 0.98, 3.4, 5.2, 14, 1),
      new MeshLambertNodeMaterial({ color: 0x14131c, alphaTest: 0.1 })
    );
    belly.position.y = -3.9;
    belly.material.opacityNode = playerOcclusionNode();
    group.add(belly);

    // ---- hover hardware: a lit core, three thruster flares, two containment rings
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 16, 12),
      new THREE.MeshBasicMaterial({
        color: col.color, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    core.position.y = -6.9;
    group.add(core);

    const flares: THREE.MeshBasicMaterial[] = [];
    const flareGeo = new THREE.ConeGeometry(1.25, 4.4, 10, 1, true);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.7;
      const mat = new THREE.MeshBasicMaterial({
        color: col.color, transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const flare = new THREE.Mesh(flareGeo, mat);
      flare.position.set(Math.cos(a) * 4.6, -8.9, Math.sin(a) * 4.6);
      flare.rotation.x = Math.PI;   // the cone points straight down
      group.add(flare);
      flares.push(mat);
    }

    const rings: THREE.Mesh[] = [];
    const hoverMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 2; i++) {
      // the flat orientation is baked into the geometry, so animating rotation.y spins the ring in
      // its own plane — rotating the mesh instead would tumble it out of the deck
      const geo = new THREE.TorusGeometry(5.4 + i * 2.6, 0.16, 5, 40);
      geo.rotateX(Math.PI / 2);
      const ring = new THREE.Mesh(geo, hoverMat);
      ring.position.y = -5.4 - i * 1.1;
      group.add(ring);
      rings.push(ring);
    }

    // ---- EDGE-LAUNCH RINGS (user ask 2026-09-29): three flat hoops that rise at the deck's outer
    // edge and swell AWAY from the platform in the colony's colour — the jump pad's ring cycle
    // rotated 90 degrees: it climbs nowhere and expands instead. They are the readable tell for
    // the springboard edge: a colony-mate who runs at the rim is thrown off (see `edgeLaunch`).
    const edgeMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.2,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const edgeRings: THREE.Mesh[] = [];
    // one unit torus, scaled per ring: radius = deck edge .. just past the shield bubble (user
    // ask 2026-09-29: the hoops used to swell to ~2.7x the rim, reading as a field-wide ring —
    // they now stop slightly OUTSIDE the base's own shield, so they read as its pulse)
    const edgeGeo = new THREE.TorusGeometry(1, 0.03, 6, 64);
    edgeGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(edgeGeo, edgeMat);
      ring.position.y = 0.06;   // same level as the deck plane — right on the platform
      ring.renderOrder = 4;
      group.add(ring);
      edgeRings.push(ring);
    }

    // ---- deck markings: spray rail, painted ring, colony emblem
    const rimMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const rail = new THREE.Mesh(new THREE.TorusGeometry(padR, 0.2, 6, 56), rimMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = -0.08;
    rail.renderOrder = 4;
    group.add(rail);

    const deckMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const paint = new THREE.Mesh(new THREE.RingGeometry(padR * 0.74, padR * 0.96, 44), deckMat);
    paint.rotation.x = -Math.PI / 2;
    paint.position.y = 0.04;
    paint.renderOrder = 3;
    group.add(paint);

    // ---- the colony logo, built from the SAME symbol the colony card and minimap use:
    // HELIOS is a sun (hub + eight rays), AEGIS a hollow diamond, VANTA a four-point star. Every part
    // is laid flat in its own geometry and the spin below is a plain Y turn, so the logo can only ever
    // rotate within the deck plane — never tip out of it.
    const emblemMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const emblem = new THREE.Group();
    const flat = (geo: THREE.BufferGeometry): THREE.BufferGeometry => geo.rotateX(-Math.PI / 2);
    const addFlat = (geo: THREE.BufferGeometry): void => {
      emblem.add(new THREE.Mesh(flat(geo), emblemMat));
    };
    if (colony === 0) {
      // HELIOS — a sun: solid hub, inner ring, and eight rays
      addFlat(new THREE.CircleGeometry(padR * 0.11, 20));
      addFlat(new THREE.RingGeometry(padR * 0.17, padR * 0.22, 32));
      for (let k = 0; k < 8; k++) {
        const ray = new THREE.PlaneGeometry(padR * 0.2, padR * 0.055);
        ray.rotateX(-Math.PI / 2);
        ray.translate(padR * 0.33, 0, 0);
        const mesh = new THREE.Mesh(ray, emblemMat);
        mesh.rotation.y = (k / 8) * Math.PI * 2;
        emblem.add(mesh);
      }
    } else if (colony === 1) {
      // AEGIS — a hollow diamond, with a smaller solid diamond at its core
      const outer = new THREE.Shape();
      outer.moveTo(0, padR * 0.42);
      outer.lineTo(padR * 0.42, 0);
      outer.lineTo(0, -padR * 0.42);
      outer.lineTo(-padR * 0.42, 0);
      outer.closePath();
      const inner = new THREE.Path();
      inner.moveTo(0, padR * 0.3);
      inner.lineTo(padR * 0.3, 0);
      inner.lineTo(0, -padR * 0.3);
      inner.lineTo(-padR * 0.3, 0);
      inner.closePath();
      outer.holes.push(inner);
      addFlat(new THREE.ShapeGeometry(outer));
      const core = new THREE.Shape();
      core.moveTo(0, padR * 0.12);
      core.lineTo(padR * 0.12, 0);
      core.lineTo(0, -padR * 0.12);
      core.lineTo(-padR * 0.12, 0);
      core.closePath();
      addFlat(new THREE.ShapeGeometry(core));
    } else {
      // VANTA — a four-point star (two long points, two short, like the ⟡ on the cards)
      const star = new THREE.Shape();
      const tip = padR * 0.46;
      const waist = padR * 0.13;
      star.moveTo(0, tip);
      star.lineTo(waist, waist);
      star.lineTo(tip, 0);
      star.lineTo(waist, -waist);
      star.lineTo(0, -tip);
      star.lineTo(-waist, -waist);
      star.lineTo(-tip, 0);
      star.lineTo(-waist, waist);
      star.closePath();
      const hole = new THREE.Path();
      const ht = padR * 0.3;
      const hw = padR * 0.07;
      hole.moveTo(0, ht);
      hole.lineTo(hw, hw);
      hole.lineTo(ht, 0);
      hole.lineTo(hw, -hw);
      hole.lineTo(0, -ht);
      hole.lineTo(-hw, -hw);
      hole.lineTo(-ht, 0);
      hole.lineTo(-hw, hw);
      hole.closePath();
      star.holes.push(hole);
      addFlat(new THREE.ShapeGeometry(star));
    }
    emblem.position.y = 0.05;
    for (const part of emblem.children) part.renderOrder = 3;
    group.add(emblem);

    // ---- pylons: six struts around the deck edge, each capped with a colony light
    const pylonMat = new THREE.MeshLambertMaterial({ color: 0x2b2938 });
    const capMat = new THREE.MeshBasicMaterial({ color: col.color });
    const shaftGeo = new THREE.CylinderGeometry(0.22, 0.3, 2.8, 6);
    const capGeo = new THREE.BoxGeometry(0.44, 0.44, 0.44);
    const count = CONFIG.base.pylonCount;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.45;
      const px = Math.cos(a) * padR * 0.98;
      const pz = Math.sin(a) * padR * 0.98;
      const shaft = new THREE.Mesh(shaftGeo, pylonMat);
      shaft.position.set(px, 1.4, pz);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(px, 2.95, pz);
      group.add(shaft, cap);
    }

    // ---- the COLONY SHIELD: the sphere bubble that wraps the fortress, unchanged. It is the base's
    // own envelope — a player inside it is safe, a hostile running into it is thrown off.
    const domeMat = createShieldMaterial(col.color, 0.3);
    const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(shieldR, 3), domeMat);
    dome.renderOrder = 5;
    group.add(dome);

    // ---- the SHIELD SKIRT, on the ground below the lane crossing: the protected landing footprint,
    // drawn as a cone of colony-coloured energy rising from the drop ring. It stays exactly where it
    // always was and keeps its shape — but it is no longer a dead no-go wall: this cone is the
    // colony's HEALING PAD. A colony-mate inside it mends and sheds every debuff; every other colony
    // is thrown off it exactly as before. The base ring is projected on to the terrain, so the skirt
    // stands ON the ground instead of hovering over a hillside, and the shader fades it to nothing
    // before the apex: a wall at the foot, open sky at the top.
    const frame = frameFor(padGroup, up, this.planet!);
    const skirtH = Math.min(H * 0.72, shieldR * 1.6);
    const groundConeMat = createBaseConeMaterial(col.color, 0.6);
    const groundCone = new THREE.Mesh(conformingCone(frame, shieldR, skirtH, 56, 0.25), groundConeMat);
    groundCone.renderOrder = 5;
    padGroup.add(groundCone);

    // ---- the PHYSICAL pad under the cone, sized to its WHOLE bottom: the same hardware language as
    // the jump / blitz pads (plate, raised deck, lit rim, inlaid emblem, four bolts), but built from
    // CONFORMING shapes rather than a flat slab. A flat 28 m plate would float nearly a metre over
    // the terrain at its rim — on the inside of a sphere the ground drops away from the tangent
    // plane — and it would also fight the terrain mesh, which is coarser than the height field the
    // shapes are placed against. So the plate is a shallow cone whose foot lands just above the
    // terrain, a second cone inside it is the raised deck, and the ring between them is the rim.
    const padPlateMat = new THREE.MeshLambertMaterial({ color: 0x241d36, flatShading: true });
    const padDeckMat = new THREE.MeshLambertMaterial({ color: 0x151024, flatShading: true });
    const padPlate = new THREE.Mesh(conformingCone(frame, shieldR * 0.98, 0.12, 56, 0.10), padPlateMat);
    padPlate.renderOrder = 2;
    const padDeck = new THREE.Mesh(conformingCone(frame, shieldR * 0.78, 0.24, 56, 0.11), padDeckMat);
    padDeck.renderOrder = 3;

    // ---- landing marker / LIT RIM: the painted ring on the surface, showing where the drop puts
    // you — now also the pad's glowing edge, laid just over the plate between it and the deck. It
    // follows the terrain for the same reason the skirt does: a flat ring laid on a slope cuts
    // through the ground on one side and floats on the other.
    const padRimMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const padRim = new THREE.Mesh(conformingBand(frame, shieldR * 0.8, shieldR * 0.96, 56, 0.15), padRimMat);
    padRim.renderOrder = 4;
    padGroup.add(padPlate, padDeck, padRim);

    // inlaid emblem: a flat plus on the deck plate — the ground version of the floating sigil
    const padEmblemMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const padEmblem = new THREE.Mesh(plusGeometry(shieldR * 0.26, shieldR * 0.07, 0.03), padEmblemMat);
    padEmblem.position.y = 0.38;
    padEmblem.renderOrder = 4;
    padGroup.add(padEmblem);

    // four bolts sunk into the deck plate, at the height the shallow cone is at their radius
    const padBoltGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.14, 6);
    const padBoltMat = new THREE.MeshLambertMaterial({ color: 0x4a4062, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bR = shieldR * 0.6;
      const bolt = new THREE.Mesh(padBoltGeo, padBoltMat);
      bolt.position.set(Math.cos(a) * bR, 0.20, Math.sin(a) * bR);
      padGroup.add(bolt);
    }

    // ---- the HEALING SIGILS: one big plus hanging over the middle of the pad, and a ring of small
    // pluses climbing out of the ground. Additive, colony-coloured, and unmistakably "stand here".
    const plusBigMat = new THREE.MeshBasicMaterial({
      color: col.color, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const plusHover = Math.max(5, skirtH * 0.42);
    const plusBig = new THREE.Mesh(plusGeometry(2.6, 0.72, 0.42, false), plusBigMat);
    plusBig.position.y = plusHover;
    plusBig.renderOrder = 6;
    padGroup.add(plusBig);

    const plusMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const pluses = new THREE.InstancedMesh(plusGeometry(0.62, 0.19, 0.16, false), plusMat, PAD_PLUS_COUNT);
    pluses.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pluses.frustumCulled = false;
    pluses.renderOrder = 6;
    padGroup.add(pluses);

    // each riser gets its own spot on the pad and its own clock so the column never marches in step
    const plusX = new Float64Array(PAD_PLUS_COUNT);
    const plusZ = new Float64Array(PAD_PLUS_COUNT);
    const plusPhase = new Float64Array(PAD_PLUS_COUNT);
    const plusSpin = new Float64Array(PAD_PLUS_COUNT);
    for (let i = 0; i < PAD_PLUS_COUNT; i++) {
      const a = (i / PAD_PLUS_COUNT) * Math.PI * 2 + 0.6;
      const r = shieldR * (i % 2 === 0 ? 0.34 : 0.62);
      plusX[i] = Math.cos(a) * r;
      plusZ[i] = Math.sin(a) * r;
      plusPhase[i] = i / PAD_PLUS_COUNT;
      plusSpin[i] = a;
      pluses.setColorAt(i, _plusCol.setHex(col.color));
    }
    if (pluses.instanceColor) pluses.instanceColor.needsUpdate = true;

    this.group.add(group, padGroup);

    // ---- the engine WAKE mesh, in WORLD space: it is rewritten every frame from the flight path
    // samples, so it may NOT be a child of `group` (which `placeShip` re-seats every frame). Every
    // streak is its own flat two-vertex ribbon, so one draw call carries the whole bundle.
    const tailRows = TAIL_SEGS + 1;
    const strandVerts = tailRows * 2;
    const tailGeo = new THREE.BufferGeometry();
    const tailPos = new THREE.BufferAttribute(new Float32Array(strandVerts * TAIL_STRANDS * 3), 3);
    tailPos.setUsage(THREE.DynamicDrawUsage);
    const tailColAttr = new THREE.BufferAttribute(new Float32Array(strandVerts * TAIL_STRANDS * 3), 3);
    tailColAttr.setUsage(THREE.DynamicDrawUsage);
    tailGeo.setAttribute('position', tailPos);
    tailGeo.setAttribute('color', tailColAttr);
    const tailIdx: number[] = [];
    for (let s = 0; s < TAIL_STRANDS; s++) {
      const base = s * strandVerts;
      for (let i = 0; i < TAIL_SEGS; i++) {
        const a = base + i * 2;
        const b2 = a + 1;
        const c = a + 2;
        const d = a + 3;
        tailIdx.push(a, b2, d, a, d, c);
      }
    }
    tailGeo.setIndex(tailIdx);
    const tail = new THREE.Mesh(tailGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    tail.frustumCulled = false;   // the vertices move with the ship, so the bounds are stale
    tail.renderOrder = 3;
    this.group.add(tail);
    const tailPts: THREE.Vector3[] = [];
    for (let i = 0; i < tailRows; i++) tailPts.push(new THREE.Vector3());

    return {
      colony, center, ground, dir: laneDir.clone(), up, facing,
      laneDir,
      angle: 0, dAngle: 0, hover: CONFIG.base.floatHeight,
      padRadius: padR, deckRadius: center.length(), shieldRadius: shieldR, platformHeight: H,
      footCos: Math.cos(padR / Math.max(1, center.length())),
      group, padGroup, dome, domeMat, groundConeMat, deckMat, emblem, emblemMat, rimMat, flares, rings,
      edgeRings, edgeMat, edgeT: 0,
      tail, tailPts, tailHead: 0,
      padRimMat, padEmblemMat,
      plusBig, plusBigMat, plusHover, pluses, plusMat, plusX, plusZ, plusPhase, plusSpin,
      flash: 0,
    };
  }

  private clear(): void {
    for (const b of this.bases) {
      this.group.remove(b.group, b.padGroup, b.tail);
      // the tail is a lone world-space mesh and owns its buffers outright
      b.tail.geometry.dispose();
      (b.tail.material as THREE.Material).dispose();
      // every material in these two groups is created per base in `buildOne`, so the whole subtree
      // can be disposed as one — geometries and materials alike
      const dispose = (root: THREE.Object3D): void => {
        root.traverse(o => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) for (const one of mat) one.dispose();
          else if (mat) mat.dispose();
        });
      };
      dispose(b.group);
      dispose(b.padGroup);
    }
    this.bases.length = 0;
    this.zones.length = 0;
  }
}
