// NECROFALL — the 5 towers: 4 Beacon Towers + the central Nexus.
// Bosses -> capture -> timed shield -> Beacon ability / expiry -> exposure -> steal -> Nexus -> win.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Player } from '../player/Player';
import { COLONIES, CONFIG, beaconName } from '../core/Config';
import { Rand, clamp, dirFromAngles, randomUnitVector, tangentBasis } from '../utils/Utils';
import type { Planet } from '../world/Planet';
import { conformingBand, type GroundFrame } from '../world/GroundShapes';
import { createBeamMaterial, createShieldMaterial } from './ShieldMaterial';
import { PowerLines, SEAL_COLOR, SEAL_CSS } from './PowerLines';

/** Local +Y, the axis every surface orientation rotates from. */
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
/** Normal at a shield contact point (player collision). */
const _nb = new THREE.Vector3();
/** Normal at a shield contact point (Necrophage bounce). */
const _ns = new THREE.Vector3();

export type TowerState = 'boss' | 'open' | 'shielded' | 'vulnerable';

const STATE_CODE: Record<TowerState, number> = { boss: 0, open: 1, shielded: 2, vulnerable: 3 };
const CODE_STATE: TowerState[] = ['boss', 'open', 'shielded', 'vulnerable'];

/** How far outside the tower a guardian makes its stand (the shield keeps it out of the ring). */
const GUARDIAN_RING = 14;
/** Grace period before a missing guardian is re-summoned, in seconds. */
const GUARDIAN_RESUMMON = 3;

/**
 * How hard a live shield throws a Necrophage back off it. The contact mirrors the creature's inward
 * speed (2 = a perfect mirror, same speed out as in) and then adds a flat impulse on top, so even a
 * creature that was barely creeping forward is visibly flung clear of the ward instead of stopping
 * dead against it.
 */
const SHIELD_BOUNCE_REFLECT = 2;
/** Extra launch impulse on top of the mirror (m/s). */
const SHIELD_BOUNCE_KICK = 12;
/** Wardens and bosses are far too heavy to be launched: they only get nudged. */
const SHIELD_BOUNCE_HEAVY_MUL = 0.32;
/** Shortest gap between two bounce splashes on the same creature (s) — a dome under siege stays quiet. */
const SHIELD_BOUNCE_FX_CD = 0.35;

/**
 * The Beacon ability. Every tower grants the same one: an optional, colony-wide doubling of all
 * stats for 30s, paid for by dropping the shield and exposing the tower.
 */
export const BEACON_ABILITY = {
  name: 'COLONY OVERDRIVE',
  short: 'OVERDRIVE',
  desc: 'BOOST ALLY STATS 2x FOR 30s BY DISABLING SHIELDS & REDIRECTING BEACON ENERGY',
  dmg: 2,
  taken: 0.5,
  xp: 2,
  ability: 2,
  time: 30,
};

/** Kept for older snapshots/UI that indexed the four legacy beacon abilities. */
export const BEACON_ABILITIES = [BEACON_ABILITY, BEACON_ABILITY, BEACON_ABILITY, BEACON_ABILITY];

export interface TowerSnapshot {
  id: number;
  owner: number;
  state: number;
  capColony: number;
  cap: number;
  vuln: number;
  /** Seconds left on the capture shield (0 = no countdown / shield permanent). */
  sh: number;
  /**
   * Nexus only: 1 while the SEAL is up. This used to be host-only bookkeeping, so every client kept
   * the ward it was born with — a mid-match joiner landed next to a fully open Nexus and was still
   * walled off by a shield the host had already torn down (and saw "BEACONS LIBERATED 0/4" forever).
   */
  seal: number;
}

export class Tower {
  idx = 0;
  kind: 'beacon' | 'nexus' = 'beacon';
  /**
   * Radius of THIS tower's ward. A Beacon's is `CONFIG.tower.shieldRadius`; the Nexus is a far
   * bigger monument and carries a bigger seal, so every barrier / containment / safe-zone test reads
   * this field rather than the flat config value.
   */
  shieldR = CONFIG.tower.shieldRadius;
  position = new THREE.Vector3();
  up = new THREE.Vector3();
  dir = new THREE.Vector3();
  /** The planet this tower stands on — its ground shapes are projected on to it. */
  readonly planet: Planet;
  owner = -1;
  state: TowerState = 'boss';
  /** Nexus only: true until every Beacon has been captured, which breaks the seal. */
  nexusSeal = false;
  /** Nexus only: the Mega Necrophage has been summoned (the seal now waits on its death). */
  nexusMega = false;
  captureColony = -1;
  captureProgress = 0;
  vulnerabilityT = 0;
  /**
   * Seconds left on this tower's capture shield. A captured Beacon's ward only holds for
   * `CONFIG.tower.shieldTime`; the host ticks this down and drops the shield when it reaches 0.
   */
  shieldT = 0;
  /** Throttle for the shield-bounce splash effect, so a sliding contact does not spam it. */
  bounceT = 0;
  abilityIdx = 0;
  bossId = -1;
  /** Seconds since this tower was found without a live guardian (host self-heal timer). */
  guardianT = 0;
  group: THREE.Group;
  shield!: THREE.Mesh;
  crystal!: THREE.Mesh;
  zone!: THREE.Mesh;
  glowMat!: THREE.MeshLambertMaterial;
  /** The ray of light out of the core: a bright needle inside a wide, soft halo. */
  beamCore!: THREE.Mesh;
  beamHalo!: THREE.Mesh;
  beamCoreMat!: THREE.ShaderMaterial;
  beamHaloMat!: THREE.ShaderMaterial;

  constructor(idx: number, kind: 'beacon' | 'nexus', position: THREE.Vector3, planet: Planet) {
    this.idx = idx;
    this.kind = kind;
    this.planet = planet;
    this.shieldR = kind === 'nexus' ? CONFIG.tower.nexusShieldRadius : CONFIG.tower.shieldRadius;
    this.position.copy(position);
    this.up.copy(position).normalize();
    this.dir.copy(this.up);
    this.group = new THREE.Group();
    this.buildModel();
  }

  private buildModel(): void {
    const isNexus = this.kind === 'nexus';
    // The Nexus is the match's landmark: it dwarfs the Beacons, so the middle of the battlefield
    // reads as the middle from across the planet.
    const scale = isNexus ? 4.4 : 1.6;
    const stone = new THREE.MeshLambertMaterial({ color: 0x3a3050, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x211a33, flatShading: true });
    this.glowMat = new THREE.MeshLambertMaterial({
      color: isNexus ? 0xff2d6b : 0x9a6bff,
      emissive: isNexus ? 0xff2d6b : 0x7a3bff,
      flatShading: true,
    });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5 * scale, 2.2 * scale, 1.1 * scale, 6), stone);
    base.position.y = 0.55 * scale;
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.8 * scale, 1.3 * scale, 2.2 * scale, 6), dark);
    mid.position.y = 2.1 * scale;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(1.1 * scale, 0.7 * scale, 0.7 * scale, 6), stone);
    crown.position.y = 3.5 * scale;
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.75 * scale, 0), this.glowMat);
    crystal.position.y = 4.8 * scale;
    this.crystal = crystal;

    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.3 * scale, 2.6 * scale, 0.3 * scale), dark);
      pillar.position.set(Math.cos(a) * 1.5 * scale, 1.4 * scale, Math.sin(a) * 1.5 * scale);
      this.group.add(pillar);
    }
    this.group.add(base, mid, crown, crystal);

    const shieldMat = createShieldMaterial(0x63d2ff, 0.5);
    this.shield = new THREE.Mesh(new THREE.IcosahedronGeometry(this.shieldR, 3), shieldMat);
    this.shield.visible = false;
    this.shield.renderOrder = 2;
    this.group.add(this.shield);

    const zoneMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // The capture ring is laid ON THE TERRAIN, not on the tangent plane through the tower's base: a
    // flat ring hovers over a hillside and slices into it on a slope, and this is the ring that tells
    // a player exactly where they have to stand to take the tower — it has to be the real ground.
    this.zone = new THREE.Mesh(
      conformingBand(this.groundFrame(), this.captureR * 0.94, this.captureR, 56, 0.25),
      zoneMat
    );
    this.group.add(this.zone);

    this.buildBeam(scale, isNexus);
  }

  /**
   * The tower's own local frame. `addTower` orients the group with
   * `setFromUnitVectors((0,1,0), up)`, so the two tangent axes are that same rotation applied to
   * local +X and +Z — derived here rather than read off the group, which is still un-oriented while
   * the model is being built.
   */
  private groundFrame(): GroundFrame {
    const q = new THREE.Quaternion().setFromUnitVectors(_Y_AXIS, this.up);
    return {
      planet: this.planet,
      up: this.up,
      axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
      originRadius: this.position.length(),
    };
  }

  /**
   * The ray of light out of the tower's core. Both parts are open-ended, additive tubes with an
   * alpha gradient baked into the shader, so they climb out of the crystal and die away in the sky
   * instead of ending in a hard edge. The tower's local +Y is the planet's up, so the ray is always
   * fired straight out of the ground.
   */
  private buildBeam(scale: number, isNexus: boolean): void {
    const coreY = 4.8 * scale;                       // the crystal, where the ray starts
    const len = isNexus ? 210 : 150;

    this.beamCoreMat = createBeamMaterial(0xffffff, 0.42, 1);
    this.beamCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46 * scale, 0.3 * scale, len, 12, 1, true),
      this.beamCoreMat
    );
    this.beamCore.position.y = coreY + len * 0.5;
    this.beamCore.renderOrder = 3;

    this.beamHaloMat = createBeamMaterial(0xffffff, 0.16, 0);
    this.beamHalo = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2 * scale, 1 * scale, len * 0.8, 20, 1, true),
      this.beamHaloMat
    );
    this.beamHalo.position.y = coreY + len * 0.4;
    this.beamHalo.renderOrder = 3;

    this.group.add(this.beamCore, this.beamHalo);
  }

  /** Colour of the ray: the owner's banner, or the SEAL red while nobody holds the tower. */
  beamColor(): number {
    if (this.owner >= 0) return this.ownerColor();
    return SEAL_COLOR;
  }

  get shieldUp(): boolean {
    // A Beacon's ward is UP while its guardian still lives: the tower is sealed property until the
    // Warden is killed, and the dome turns the colour of nobody's banner to say so. (It is a real
    // wall too — the same barrier every other ward is — so the ring cannot be entered early.)
    // NOTE: this is deliberately Beacon-only. The Nexus is a 'boss' tower while its Overseer lives,
    // but its ward is the SEAL, and the seal breaking is what lets the Mega Necrophage leave its post.
    if (this.kind === 'beacon' && this.state === 'boss') return true;
    // The Nexus is sealed by the Beacons until every one of them has been captured.
    if (this.kind === 'nexus' && this.nexusSeal) return true;
    if (this.state === 'shielded') return true;
    return false;
  }

  /**
   * Colour of the ward. An unclaimed seal is RED — it belongs to no colony and is powered by the
   * Beacons — while a captured tower's shield flies its owner's banner.
   */
  shieldColor(): number {
    if ((this.kind === 'beacon' && this.state === 'boss') || (this.kind === 'nexus' && this.nexusSeal)) {
      return SEAL_COLOR;
    }
    return this.owner >= 0 ? this.ownerColor() : SEAL_COLOR;
  }

  /**
   * Radius of the tower's capture band — the ground ring players stand in to take it. The Nexus
   * model is 4.4x a Beacon's, so its ring is drawn wider than the shared Beacon value.
   */
  get captureR(): number {
    return this.kind === 'nexus' ? CONFIG.tower.nexusCaptureRadius : CONFIG.tower.captureRadius;
  }

  /**
   * Seconds of uncontested ownership this tower needs before it flips. The Nexus is the match's
   * prize, so it takes twice as long as a Beacon.
   */
  get captureTime(): number {
    return this.kind === 'nexus' ? CONFIG.tower.nexusCaptureTime : CONFIG.tower.captureTime;
  }

  ownerColor(): number {
    // An UNCLAIMED tower is SEAL RED, full stop: before a colony takes it, the structure itself is
    // telling you the Necrophages hold it (its warden is standing right there either way).
    if (this.owner >= 0) return COLONIES[this.owner].color;
    return SEAL_COLOR;
  }
}

/**
 * Deterministic centre of the battlefield (the Nexus) for a match seed.
 * Exported so the planet can be built around the contested region before towers exist.
 */
export function battlefieldCenterDir(seed: number, out: THREE.Vector3): THREE.Vector3 {
  const rand = new Rand(seed ^ 0x7ea2);
  const seedRot = rand.range(0, Math.PI * 2);
  const centerLat = 26 + rand.range(-8, 8);
  return dirFromAngles(centerLat, (seedRot * 180) / Math.PI, out);
}

export class TowerManager {
  towers: Tower[] = [];
  /** Centre of the tower cluster — the Nexus — also used for spawn orientation. */
  readonly centerDir = new THREE.Vector3(0, 1, 0);
  /** The ground conduits that feed the Nexus shield, one per Beacon. */
  private readonly powerLines: PowerLines;
  /** The Nexus tower, kept so the conduits can read the seal without a lookup per frame. */
  private nexus: Tower | null = null;
  private seedRot = 0;
  /** Enemy id → game clock of its last shield-bounce splash, so one creature cannot spam it. */
  private readonly bounceFx = new Map<number, number>();
  /** Scratch: conduit owners, filled per frame (one entry per Beacon). */
  private readonly lineOwners: number[] = [];
  /** Colonies already given the "dominating" call-out this match (one banner each, never repeats). */
  private readonly dominating = new Set<number>();

  constructor(private game: Game) {
    this.powerLines = new PowerLines();
  }

  init(seed: number): void {
    for (const t of this.towers) this.game.scene.remove(t.group);
    this.towers.length = 0;
    this.bounceFx.clear();
    const rand = new Rand(seed ^ 0x7ea2);
    this.seedRot = rand.range(0, Math.PI * 2);
    rand.range(-8, 8); // keeps the random stream aligned with battlefieldCenterDir()

    // The Nexus anchors the middle of the battlefield; the 4 Beacons ring it much further out,
    // spread across the planet so each one is its own front instead of one tight cluster.
    battlefieldCenterDir(seed, this.centerDir);

    const t1 = new THREE.Vector3();
    const t2 = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const pos = new THREE.Vector3();
    tangentBasis(this.centerDir, t1, t2);

    // Beacons sit far out from the Nexus so each one is its own front on the planet.
    const ringDeg = 78 + rand.range(-4, 6);
    const baseAngle = rand.range(0, Math.PI * 2);
    for (let i = 0; i < 4; i++) {
      const theta = baseAngle + i * (Math.PI / 2) + rand.range(-0.12, 0.12);
      axis.copy(t1).multiplyScalar(Math.cos(theta)).addScaledVector(t2, Math.sin(theta)).normalize();
      dir.copy(this.centerDir).applyAxisAngle(axis, (ringDeg * Math.PI) / 180).normalize();
      this.game.planet.surfacePointFromDir(dir, pos);
      const tower = new Tower(i, 'beacon', pos, this.game.planet);
      tower.abilityIdx = i;
      this.addTower(tower);
    }

    // Nexus in the centre of the ring — sealed until the Beacons fall to one colony.
    this.game.planet.surfacePointFromDir(this.centerDir, pos);
    const nexus = new Tower(4, 'nexus', pos, this.game.planet);
    nexus.nexusSeal = true;
    nexus.bossId = -1;
    this.addTower(nexus);

    // The conduits: one ground line per Beacon running to the Nexus, red while it feeds the seal.
    this.nexus = nexus;
    const beaconPos: THREE.Vector3[] = [];
    for (const t of this.towers) if (t.kind === 'beacon') beaconPos.push(t.position);
    this.powerLines.build(this.game.scene, this.game.planet, beaconPos, nexus.position);

    if (this.game.isHost) {
      for (const t of this.towers) {
        // the Nexus guardian is summoned later, once its shield is broken
        if (t.kind === 'nexus') continue;
        const boss = this.game.enemies.spawnBoss(t.idx, 'beacon', this.guardianPos(t, GUARDIAN_RING));
        t.bossId = boss.id;
      }
    }
  }

  /** Somewhere on the surface just outside the tower's shield — where a guardian makes its stand. */
  private guardianPos(t: Tower, dist: number): THREE.Vector3 {
    tangentBasis(t.up, _t1, _t2);
    const a = Math.random() * Math.PI * 2;
    const offset = _t1.multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a)).multiplyScalar(dist);
    const pos = new THREE.Vector3().copy(t.position).add(offset);
    this.game.planet.projectToSurface(pos);
    return pos;
  }

  /**
   * A tower only leaves the 'boss' state when its guardian dies, so a tower whose warden went
   * missing would stay locked for the rest of the match. The host re-summons one instead.
   * The Nexus is skipped while it is still sealed — it has no guardian until the shield collapses.
   */
  private ensureGuardian(t: Tower, dt: number): void {
    if (t.kind === 'nexus' && t.nexusSeal) return;
    if (t.bossId >= 0 && this.game.enemies.byId(t.bossId)) {
      t.guardianT = 0;
      return;
    }
    t.guardianT += dt;
    if (t.guardianT < GUARDIAN_RESUMMON) return;
    t.guardianT = 0;
    const pos = this.guardianPos(t, t.kind === 'nexus' ? 16 : GUARDIAN_RING);
    const boss = this.game.enemies.spawnBoss(t.idx, t.kind === 'nexus' ? 'nexus' : 'beacon', pos);
    t.bossId = boss.id;
  }

  /**
   * Nexus seal, in TWO stages. Once all four Beacons belong to a colony (any mix, no majority
   * needed) the Mega Necrophage is summoned to defend the Nexus — but the SEAL HOLDS: the shield is
   * only torn down when the thing defending it is dead. Before that, four Beacons bought you a boss
   * fight, not an open goal.
   */
  private updateNexusSeal(): void {
    const nexus = this.towers.find(t => t.kind === 'nexus');
    if (!nexus) return;
    if (nexus.nexusSeal) {
      for (const t of this.towers) {
        if (t.kind === 'beacon' && t.owner < 0) return;   // a Beacon still held by nobody
      }
      if (!nexus.nexusMega) {
        nexus.nexusMega = true;
        const boss = this.game.enemies.spawnBoss(4, 'nexus', this.guardianPos(nexus, 16));
        nexus.bossId = boss.id;
        this.game.ui.banner('Mega Necrophage spawned', 3200);
        this.game.audio.sfx('bossRoar');
        this.game.effects.ring(nexus.position, nexus.up, 6, 0xff3d7a, 1.6, 5, 1);
        return;
      }
      // still sealed while its defender stands
      if (this.game.enemies.byId(nexus.bossId)) return;
      nexus.nexusSeal = false;
      nexus.bossId = -1;
      this.game.ui.banner('Mega Necrophage defeated — Nexus Shield Fell', 3200);
      this.game.audio.sfx('shieldDown');
      this.game.effects.ring(nexus.position, nexus.up, 4, 0xff3d7a, 1.4, 6, 1);
      this.game.net.broadcast({ t: 'ev', id: 'nexusopen', src: this.game.net.myId });
    }
  }

  private addTower(tower: Tower): void {
    tower.group.position.copy(tower.position);
    tower.group.quaternion.setFromUnitVectors(_Y_AXIS, tower.up);
    this.game.scene.add(tower.group);
    this.towers.push(tower);
  }

  reset(): void {
    this.bounceFx.clear();
    this.powerLines.reset();
    for (const t of this.towers) {
      t.owner = -1;
      t.state = 'boss';
      t.captureColony = -1;
      t.captureProgress = 0;
      t.vulnerabilityT = 0;
      t.shieldT = 0;
      t.bossId = -1;
      t.guardianT = 0;
      if (t.kind === 'nexus') {
        t.nexusSeal = true;
        t.nexusMega = false;
      }
    }
    this.dominating.clear();
  }

  counts(): number[] {
    const c = [0, 0, 0];
    for (const t of this.towers) if (t.owner >= 0) c[t.owner]++;
    return c;
  }

  victoryColony(): number | null {
    const c = this.counts();
    let best = -1;
    let bestCount = 0;
    let tie = false;
    for (let i = 0; i < 3; i++) {
      if (c[i] > bestCount) {
        bestCount = c[i];
        best = i;
        tie = false;
      } else if (c[i] === bestCount && c[i] > 0) {
        tie = true;
      }
    }
    if (best < 0 || tie) return null;
    return best;
  }

  towerAt(idx: number): Tower | null {
    return this.towers[idx] ?? null;
  }

  /** Tower the local player can currently activate (owned + shielded Beacon). */
  activateCandidate(p: Player): Tower | null {
    if (p.colony < 0) return null;
    for (const t of this.towers) {
      if (t.kind !== 'beacon' || t.state !== 'shielded' || t.owner !== p.colony) continue;
      if (p.position.distanceTo(t.position) < t.shieldR + 3) return t;
    }
    return null;
  }

  tryActivate(p: Player): void {
    if (!p.alive || p.frozen) return;
    const t = this.activateCandidate(p);
    if (!t) return;
    this.game.broadcastAbility(t);
  }

  /**
   * Runs on the host (authority): buffs the owning colony, then drops the Beacon's shield for good.
   * The Beacon stays exposed until somebody captures it — using the ability is a real trade.
   */
  useAbility(t: Tower): void {
    if (t.state !== 'shielded' || t.owner < 0) return;
    const ability = BEACON_ABILITY;
    const buff = this.game.colonyBuffs[t.owner];
    buff.dmg = ability.dmg;
    buff.taken = ability.taken;
    buff.xp = ability.xp;
    buff.ability = ability.ability;
    buff.time = ability.time;
    buff.label = ability.short;
    t.state = 'vulnerable';
    t.vulnerabilityT = 0;          // no countdown: the shield does not come back on its own
    t.shieldT = 0;                 // the ward is already down, so its countdown is over
    t.captureProgress = 0;
    t.captureColony = -1;
    // The colony that spent the Beacon's charge is named in ITS OWN colour — the same ink the capture
    // notices use, so "who did that" is one glance everywhere a colony is named in a global notice.
    this.game.ui.bannerParts([
      { text: COLONIES[t.owner].name, color: COLONIES[t.owner].css },
      { text: ` activated ${ability.name}` },
    ], 2600);
    this.game.ui.toast(`${ability.desc} • SHIELD DOWN — ANY COLONY CAN TAKE THIS BEACON`, 5200);
    this.game.audio.sfx('shieldDown');
    this.game.audio.sfx('beacon');
    this.abilityFx(t);
  }

  /** Visual + local buff application on every peer. */
  onAbilityEvent(t: Tower, colony: number): void {
    const ability = BEACON_ABILITY;
    const buff = this.game.colonyBuffs[colony];
    buff.dmg = ability.dmg;
    buff.taken = ability.taken;
    buff.xp = ability.xp;
    buff.ability = ability.ability;
    buff.time = ability.time;
    buff.label = ability.short;
    this.abilityFx(t);
  }

  private abilityFx(t: Tower): void {
    const g = this.game;
    g.effects.ring(t.position, t.up, 3, COLONIES[Math.max(0, t.owner)].color, 1, 3, 0.9);
    g.effects.burst(t.position, COLONIES[Math.max(0, t.owner)].color, { count: 46, speed: 16, life: 0.9, size: 0.9, gravity: 8 });
    g.effects.shake(0.3);
  }

  update(dt: number): void {
    const g = this.game;
    // ---- power conduits: every Beacon feeds the Nexus, and the line says whether it is still
    // feeding the seal (red, pulsing hard) or a colony (the colony's colour).
    let nb = 0;
    for (const t of this.towers) if (t.kind === 'beacon') this.lineOwners[nb++] = t.owner;
    this.lineOwners.length = nb;
    this.powerLines.update(dt, this.lineOwners, !!this.nexus?.nexusSeal);
    for (const t of this.towers) {
      if (t.bounceT > 0) t.bounceT = Math.max(0, t.bounceT - dt);
      // visual flourish
      t.crystal.rotation.y += dt * (t.state === 'vulnerable' ? 2.4 : 0.8);
      t.crystal.rotation.x += dt * 0.4;
      (t.zone.material as THREE.MeshBasicMaterial).color.setHex(t.ownerColor());
      const shieldMat = t.shield.material as THREE.ShaderMaterial;
      const shieldTaken = t.shieldUp;
      t.shield.visible = shieldTaken;
      if (shieldTaken) {
        (shieldMat.uniforms.uColor.value as THREE.Color).setHex(t.shieldColor());
        // A ward nobody owns (a guarded Beacon, the sealed Nexus) breathes harder: it is the tell
        // that the tower is not just occupied, it is untouchable for now.
        const guarded = t.state === 'boss' || (t.kind === 'nexus' && t.nexusSeal && t.owner < 0);
        shieldMat.uniforms.uOpacity.value = (guarded ? 0.5 : 0.42) + Math.sin(g.clock * (guarded ? 3.4 : 2.4) + t.idx) * (guarded ? 0.12 : 0.08);
        t.shield.rotation.y += dt * 0.08;
      }

      // The ray of light out of the core carries the owner's colours and flares while the tower is
      // exposed and up for grabs.
      const beamCol = t.beamColor();
      (t.beamCoreMat.uniforms.uColor.value as THREE.Color).setHex(beamCol);
      (t.beamHaloMat.uniforms.uColor.value as THREE.Color).setHex(beamCol);
      const flare = t.state === 'vulnerable' ? 1.5 : 1;
      // The needle carries most of the light and the halo is the soft glow wrapped around it. Both
      // were raised alongside the much steeper falloff in the shader: a fast fade spreads far less
      // light up the column, so the light is concentrated where the tower is and reads brighter from
      // the ground — which is the whole point of it.
      // The Nexus is scaled 4.4x, so its column is both wider and taller than a Beacon's and piles up
      // more additive light; it is trimmed so the two kinds read at the same strength. Keep this in
      // step with the model scale — a wider tube adds more light per unit of opacity, and an
      // over-bright additive result clips to white, which is what makes every tower look identical.
      const beamMul = (t.kind === 'nexus' ? 0.52 : 1) * flare;
      t.beamCoreMat.uniforms.uOpacity.value = (0.62 + Math.sin(g.clock * 1.7 + t.idx) * 0.08) * beamMul;
      t.beamHaloMat.uniforms.uOpacity.value = (0.4 + Math.sin(g.clock * 1.1 + t.idx * 2.3) * 0.06) * beamMul;
      const pulse = t.state === 'vulnerable' ? 0.5 + Math.sin(g.clock * 6) * 0.4 : 0.12;
      // The core glow tracks the SAME colour as the ward: the owner's banner, or seal red while the
      // tower is still nobody's. (The crystal's base colour is set here too — leaving it at the
      // constructor's violet made an unclaimed Beacon read as purple no matter what the emissive did.)
      const coreCol = t.ownerColor();
      (t.glowMat as THREE.MeshLambertMaterial).emissive.setHex(coreCol);
      (t.glowMat as THREE.MeshLambertMaterial).color.setHex(coreCol);
      (t.zone.material as THREE.MeshBasicMaterial).opacity = 0.14 + pulse * 0.4;

      if (!g.isHost || g.phase !== 'playing') continue;

      this.updateNexusSeal();

      // A captured Beacon's ward is a 30 s reprieve, not a permanent wall. The host owns the clock;
      // the remaining seconds ride the snapshot so every peer draws the same ring in the tracker.
      if (t.shieldT > 0) {
        t.shieldT = Math.max(0, t.shieldT - dt);
        if (t.shieldT === 0 && t.kind === 'beacon' && t.state === 'shielded' && t.owner >= 0) {
          t.state = 'vulnerable';
          t.vulnerabilityT = 0;
          t.captureProgress = 0;
          t.captureColony = -1;
          // The tower's name flies the ink of the colony that HELD it — `t.owner` still points at
          // them while the beacon goes vulnerable, so "whose ward just fell" is readable at a
          // glance. Same `towerInk` rule as every other notice that names a tower (the capture and
          // takeover banners, the tracker, the minimap landmark).
          g.ui.bannerParts([
            { text: beaconName(t.idx), color: this.towerInk(t) },
            { text: ' Shield Fell' },
          ], 2600);
          g.ui.toast(`${beaconName(t.idx).toUpperCase()} shield expired — any colony can take it`, 4200);
          g.audio.sfx('shieldDown');
          g.effects.ring(t.position, t.up, 3, 0x63d2ff, 1.1, 3.2, 1);
          g.net.broadcast({ t: 'ev', id: 'shielddown', src: g.net.myId });
        }
      }

      if (t.vulnerabilityT > 0) {
        t.vulnerabilityT -= dt;
        if (t.vulnerabilityT <= 0) {
          t.vulnerabilityT = 0;
          if (t.owner >= 0) {
            t.state = 'shielded';
            t.captureProgress = 0;
            t.captureColony = -1;
            g.ui.bannerParts([
              { text: t.kind === 'nexus' ? 'Nexus' : beaconName(t.idx), color: this.towerInk(t) },
              { text: ' Shield Restored' },
            ], 2000);
            g.audio.sfx('capture', 0.7);
          } else {
            t.state = 'open';
          }
        }
      }

      if (t.state === 'boss') {
        this.ensureGuardian(t, dt);
        continue;
      }

      if (t.state === 'open' || t.state === 'vulnerable') {
        const counts = [0, 0, 0];
        for (const p of g.players.values()) {
          if (!p.alive) continue;
          if (p.position.distanceTo(t.position) < t.captureR) counts[p.colony]++;
        }
        let leader = -1;
        let best = 0;
        let tie = false;
        for (let c = 0; c < 3; c++) {
          if (counts[c] > best) {
            best = counts[c];
            leader = c;
            tie = false;
          } else if (counts[c] === best && counts[c] > 0) {
            tie = true;
          }
        }
        if (best === 0 || tie) {
          t.captureProgress = Math.max(0, t.captureProgress - dt * 0.6);
          continue;
        }
        if (t.captureColony !== leader) {
          const started = t.captureColony < 0;
          t.captureColony = leader;
          t.captureProgress = 0;
          // The global call-out. Only a FRESH start (nobody -> somebody) announces, so two colonies
          // trading the ring back and forth cannot spam the banner. The taking colony's name flies
          // its own banner colour and the tower flies the ink of whoever holds it RIGHT NOW — still
          // the defender's here, which is what makes "who is losing this" readable at a glance.
          if (started) {
            g.ui.bannerParts([
              { text: COLONIES[leader].name, color: COLONIES[leader].css },
              { text: ' is taking over ' },
              { text: t.kind === 'nexus' ? 'the Nexus' : beaconName(t.idx), color: this.towerInk(t) },
            ], 2400);
          }
        }
        t.captureProgress += dt;
        if (t.captureProgress >= t.captureTime) {
          this.completeCapture(t, leader);
        }
      }
    }

    // Shields are walls to the Necrophages too — and hard walls. A creature that runs into a live
    // ward is thrown back off it: the body is set down on the boundary, the inward half of its
    // momentum is mirrored and a flat launch impulse is added on top, so even a creature that was
    // barely creeping forward is flung clear of the dome (and off the ground, since a radial speed
    // is exactly what lifts a Necrophage into the air).
    if (g.isHost) {
      for (const t of this.towers) {
        if (!t.shieldUp) continue;
        for (const e of g.enemies.enemies) {
          if (!e.alive) continue;
          // A tower's own guardian lives inside its ward — never bounce it out of its post.
          if (e.towerIdx === t.idx) continue;
          const edge = t.shieldR + e.radius;
          _ns.copy(e.position).sub(t.position);
          const d = _ns.length();
          if (d >= edge || d < 0.001) continue;
          _ns.multiplyScalar(1 / d);              // outward surface normal at the contact point
          e.position.addScaledVector(_ns, edge - d);
          const vn = e.velocity.dot(_ns);
          if (vn >= 0) continue;                  // already on its way out
          const weight = e.isBoss || e.isNamed ? SHIELD_BOUNCE_HEAVY_MUL : 1;
          e.velocity.addScaledVector(_ns, (-vn * SHIELD_BOUNCE_REFLECT + SHIELD_BOUNCE_KICK) * weight);
          const last = this.bounceFx.get(e.id) ?? -99;
          if (g.clock - last < SHIELD_BOUNCE_FX_CD) continue;
          this.bounceFx.set(e.id, g.clock);
          if (this.bounceFx.size > 256) this.bounceFx.clear();
          g.effects.ring(e.position, _ns, e.radius + 0.7, 0x63d2ff, 0.34, 3.4, 0.9);
          g.effects.burst(e.position, 0xbfe9ff, { count: 10, speed: 8, life: 0.35, size: 0.55, gravity: 0 });
          g.audio.sfx('hit', 0.35);
        }
      }
    }
  }

  /**
   * The ink a tower's name carries in a global notice: the owning colony's banner, or the Necrophage
   * seal red while the tower is still held by its guardian. One rule, so every notice that names a
   * tower agrees with the tracker, the minimap landmark and the tower's own glow.
   */
  private towerInk(t: Tower): string {
    return t.owner >= 0 ? COLONIES[t.owner].css : SEAL_CSS;
  }

  private completeCapture(t: Tower, colony: number): void {
    const g = this.game;
    const previousOwner = t.owner;
    t.owner = colony;
    t.state = 'shielded';
    t.captureProgress = 0;
    t.captureColony = -1;
    t.vulnerabilityT = 0;
    // A Beacon's ward only holds for a while — the countdown is drawn as a ring in the tracker.
    t.shieldT = t.kind === 'beacon' ? CONFIG.tower.shieldTime : 0;
    g.audio.sfx('capture');
    g.effects.ring(t.position, t.up, 4, COLONIES[colony].color, 1.1, 2.4, 1);
    g.effects.burst(t.position, COLONIES[colony].color, { count: 40, speed: 14, life: 0.8, size: 0.9, gravity: 6 });
    const label = t.kind === 'nexus' ? 'the Nexus' : beaconName(t.idx);
    // The tower has CHANGED HANDS, so its name flies the NEW owner's colour. `t.owner` was written
    // just above, which is exactly what `towerInk` reads — so this needs no special case, and the
    // other half of the rule falls out of the same helper: "X is taking over <tower>" is built while
    // the capture is still in flight, so there the tower has NOT changed hands and flies the
    // defence's colour. On a first capture from the Necrophage both names end up in the winner's
    // colour, which is the point — the beacon IS theirs now.
    g.ui.bannerParts([
      { text: label, color: this.towerInk(t) },
      { text: ' taken over by ' },
      { text: COLONIES[colony].name, color: COLONIES[colony].css },
    ], previousOwner >= 0 && previousOwner !== colony ? 2600 : 2400);
    // a colony holding most of the map gets a call-out, once
    let mine = 0;
    for (const other of this.towers) if (other.owner === colony) mine++;
    if (mine >= 3 && !this.dominating.has(colony)) {
      this.dominating.add(colony);
      g.ui.banner(`${COLONIES[colony].name} dominating`, 2600);
    }
    g.ui.toast(
      t.kind === 'beacon'
        ? `${label.toUpperCase()} controlled by ${COLONIES[colony].name} — shield online for ${CONFIG.tower.shieldTime}s`
        : `${label.toUpperCase()} controlled by ${COLONIES[colony].name}`, 4000
    );
    if (t.kind === 'nexus') g.onNexusCaptured(colony);
  }

  serialize(): TowerSnapshot[] {
    return this.towers.map(t => ({
      id: t.idx,
      owner: t.owner,
      state: STATE_CODE[t.state],
      capColony: t.captureColony,
      cap: Math.round(t.captureProgress * 100) / 100,
      vuln: Math.round(t.vulnerabilityT),
      sh: Math.round(t.shieldT * 10) / 10,
      seal: t.nexusSeal ? 1 : 0,
    }));
  }

  applySnapshot(list: TowerSnapshot[]): void {
    for (const s of list) {
      const t = this.towers[s.id];
      if (!t) continue;
      const wasState = t.state;
      t.owner = s.owner;
      t.state = CODE_STATE[s.state] ?? t.state;
      // The seal is authority state like any other: mirror it, so the ward, the conduits and the
      // capture ring all agree with the host the moment this peer hears from it — including the
      // late joiner that never saw the Mega die.
      if (t.kind === 'nexus') t.nexusSeal = s.seal === 1;
      t.captureColony = s.capColony;
      t.captureProgress = s.cap;
      t.vulnerabilityT = s.vuln;
      t.shieldT = Number(s.sh) || 0;
      if (wasState !== t.state) {
        if (t.state === 'open' && wasState === 'boss') {
          this.game.ui.banner(t.kind === 'nexus' ? 'NEXUS SHIELD DOWN' : `${beaconName(t.idx).toUpperCase()} UNSEALED`, 2400);
          this.game.audio.sfx('shieldDown', 0.8);
        }
        if (t.state === 'vulnerable') this.game.ui.banner('BEACON EXPOSED — CAPTURE IT', 2200);
      }
    }
  }

  /**
   * A live shield is a wall, not a trap — and a hard one. The body is moved back out to the boundary,
   * the inward half of its momentum is mirrored, and a heavy shove (part of it straight up) is added
   * on top: running into a hostile ward punts you off your feet and well clear of the dome instead of
   * simply stopping you.
   */
  collidePlayer(p: Player): void {
    const push = CONFIG.shieldPush;
    for (const t of this.towers) {
      if (!t.shieldUp) continue;
      const isOwner = t.owner >= 0 && p.colony === t.owner;
      if (isOwner) continue;
      const limit = t.shieldR + CONFIG.player.radius;
      _nb.copy(p.position).sub(t.position);
      const d = _nb.length();
      if (d >= limit || d < 0.001) continue;
      _nb.multiplyScalar(1 / d);              // outward surface normal at the contact point
      p.position.addScaledVector(_nb, limit - d);
      const vn = p.velocity.dot(_nb);
      if (vn >= 0) continue;                  // already on the way out
      // 2× the inward component = a perfect mirror, then the kick buys the push-back its weight
      p.velocity.addScaledVector(_nb, -vn * push.mirror + push.kick);
      p.velocity.addScaledVector(p.up, push.kick * push.lift);
      if (p.isLocal && t.bounceT <= 0) {
        t.bounceT = 0.35;
        const splash = this.game.effects;
        splash.ring(p.position, _nb, 1.7, 0x63d2ff, 0.5, 4.2, 1);
        splash.burst(p.position, 0x9fdcff, { count: 26, speed: 15, life: 0.45, size: 0.7, gravity: 0 });
        splash.shake(0.35);
        this.game.audio.sfx('hit', 0.6);
        this.game.ui.toast('Shield repels you', 1200);
      }
    }
  }

  /** Player capture-zone participation (for HUD hints). */
  /**
   * Tower whose capture ring the player is standing in, plus the per-colony head count written
   * into `outCounts` (the HUD calls this every frame, so it takes a caller-owned array instead of
   * building a fresh one).
   */
  zoneInfo(p: Player, outCounts: number[]): Tower | null {
    for (const t of this.towers) {
      if (p.position.distanceTo(t.position) > t.captureR + 2) continue;
      outCounts[0] = 0;
      outCounts[1] = 0;
      outCounts[2] = 0;
      for (const other of this.game.players.values()) {
        if (!other.alive) continue;
        if (other.position.distanceTo(t.position) < t.captureR) outCounts[other.colony]++;
      }
      return t;
    }
    return null;
  }
}
