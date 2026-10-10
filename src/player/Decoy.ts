// NECROFALL — the Echo Decoy (Necromutation) clone.
//
// The perk drops a copy of the runner where they dashed FROM: a static, translucent double the horde
// reads as a player. Three small seams make it real without touching the swarm's design:
//   - `Game.decoyTarget` is consulted by `Enemy.decide`, so a live clone inside aggro wins the
//     target choice outright (the taunt);
//   - `Enemy.dropShelteredTarget` accepts a decoy id, so the chase is not dropped every frame;
//   - `Game.hostPlayerDamage` hands hits on a decoy to `Decoy.takeDamage` instead of a real
//     player — melee, slams and boss heavies all ride the normal `Game.hitPlayer` path.
// When its short life runs out — or the swarm chews through the shell — it detonates in a burst of
// necrotic force, so the clone is never wasted.
//
// Authority: only the HOST runs the swarm, so only the host's decoys matter for the taunt; but every
// peer spawns its own ghost from the same cast event, so the double is visible everywhere.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { orientToSurface } from '../utils/Utils';
import type { Player } from './Player';
import type { Game } from '../core/Game';

/** How far a clone's pull reaches: an enemy this close reads the double as its target. */
export const DECOY_TAUNT_RADIUS = 24;
/**
 * How long a clone stands (seconds). FLAT time — extra stacks of the perk buy a tougher shell and a
 * bigger detonation, not a longer stand (the double is a taunt + a burst, not a second body).
 */
const LIFE = 2;
/** Base shell: the swarm can chew through it, but under normal pressure it survives to its timer. */
const HP = 260;
const HP_PER_STACK = 90;
/** Detonation: metres, and the share of the owner's auto-damage it pays. */
const BLAST = 5.4;
const BLAST_PER_STACK = 0.8;
const BLAST_DMG = 1.2;
const BLAST_DMG_PER_STACK = 0.35;

const _d = new THREE.Vector3();

/**
 * One echo double. Enemy AI reads `.alive` / `.position` / `.up` through the `Player` type it
 * already targets — the fields below are exactly the surface it touches, so a decoy can be handed
 * to `nearestPlayer`-shaped code without a single change on the swarm side.
 */
export class Decoy {
  readonly id: string;
  /** `false` the moment its shell breaks; the system detonates it on the next update. */
  alive = true;
  /** Set so damage routing and enemy AI can tell a clone from a survivor. */
  readonly isDecoy = true;
  readonly isLocal = false;
  /** Never matches a real colony, so the friendly-fire grace never applies to it. */
  readonly colony = -1;
  readonly position = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  lastAttackerId: string | null = null;
  readonly name = 'Echo Decoy';
  hp: number;
  maxHp: number;
  /** Seconds left before it detonates on its own. */
  life: number;
  readonly ownerId: string;
  /** Taunt reach, read by `Enemy.decide` via `Game.decoyTarget`. */
  readonly tauntRadius = DECOY_TAUNT_RADIUS;
  /** Detonation size and the damage it pays (both scale with the perk's stacks). */
  readonly blast: number;
  readonly blastDmg: number;
  readonly color: number;
  private ghost: THREE.Object3D | null = null;
  private ghostMat: THREE.MeshBasicMaterial | null = null;
  private bob = Math.random() * Math.PI * 2;
  private flash = 0;

  constructor(id: string, owner: Player, power: number, at: THREE.Vector3, up: THREE.Vector3, facing: THREE.Vector3) {
    this.id = id;
    this.ownerId = owner.id;
    this.color = owner.necrotechColor;
    this.hp = this.maxHp = HP + HP_PER_STACK * (power - 1);
    this.life = LIFE;
    this.blast = BLAST + BLAST_PER_STACK * (power - 1);
    this.blastDmg = owner.autoDamage * (BLAST_DMG + BLAST_DMG_PER_STACK * (power - 1));
    this.position.copy(at);
    this.up.copy(up).normalize();

    // ---- the ghost: a copy of the runner's own body, flattened to one additive holo-material so it
    // reads as "echo" from any angle. Geometries are SHARED with the real model — only the material
    // and the clone's own transform are ours, which is what keeps a dash-spawned clone cheap.
    const mat = new THREE.MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ghostMat = mat;
    const ghost = cloneSkeleton(owner.model);
    ghost.traverse(o => {
      const mesh = o as THREE.Mesh;
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        mesh.material = mat;
        mesh.renderOrder = 7;
      }
      // the living kit's tell meshes have no business on a double
      if (o.name === 'shieldBubble' || o.name === 'auraGlow') o.visible = false;
    });
    this.ghost = ghost;
  }

  /** Enemy AI compatibility: a clone is always fair game. */
  isInvulnerable(): boolean {
    return false;
  }

  /** Hit routing from `Game.hostPlayerDamage` — the shell takes it, the runner does not. */
  takeDamage(amount: number, _srcId?: string | null, _kind?: string): void {
    if (!this.alive) return;
    this.hp -= amount;
    this.flash = 0.25;
    if (this.hp <= 0) this.alive = false;
  }

  /** Puts the ghost into the scene at the dash's start point. */
  attach(scene: THREE.Scene, facing: THREE.Vector3): void {
    if (!this.ghost) return;
    orientToSurface(this.ghost, this.position, this.up, facing);
    scene.add(this.ghost);
  }

  /** Per-frame holo breathing: a slow bob off the ground and a pulse, brighter while it is hit. */
  tick(dt: number): void {
    if (!this.ghost || !this.ghostMat) return;
    this.bob += dt * 1.6;
    this.flash = Math.max(0, this.flash - dt);
    this.ghost.position.copy(this.position).addScaledVector(this.up, 0.06 + Math.sin(this.bob) * 0.05);
    this.ghostMat.opacity = 0.32 + Math.sin(this.bob * 0.9 + 1.3) * 0.06 + this.flash;
  }

  dispose(scene: THREE.Scene): void {
    if (this.ghost) scene.remove(this.ghost);
    this.ghost?.traverse(object => {
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    this.ghost = null;
    this.ghostMat?.dispose();
    this.ghostMat = null;
  }
}

/**
 * The pool of live clones. Tiny by construction (one per dash, 2 s of life), so it is a plain array
 * with no recycling.
 */
export class DecoySystem {
  private list: Decoy[] = [];
  private nextId = 1;

  constructor(private scene: THREE.Scene) {}

  spawn(owner: Player, power: number, at: THREE.Vector3, up: THREE.Vector3, facing: THREE.Vector3): Decoy {
    const d = new Decoy(`decoy${this.nextId++}`, owner, Math.max(1, power), at, up, facing);
    d.attach(this.scene, facing);
    this.list.push(d);
    return d;
  }

  update(dt: number, game: Game): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.life -= dt;
      d.tick(dt);
      if (!d.alive || d.life <= 0) {
        this.detonate(d, game);
        d.dispose(this.scene);
        this.list.splice(i, 1);
      }
    }
  }

  /** Nearest live clone within `maxDist` — the swarm's taunt check. */
  nearest(pos: THREE.Vector3, maxDist: number): Decoy | null {
    let best: Decoy | null = null;
    let bestD2 = maxDist * maxDist;
    for (const d of this.list) {
      if (!d.alive) continue;
      const d2 = d.position.distanceToSquared(pos);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = d;
      }
    }
    return best;
  }

  byId(id: string): Decoy | null {
    for (const d of this.list) if (d.id === id && d.alive) return d;
    return null;
  }

  clear(): void {
    for (const d of this.list) d.dispose(this.scene);
    this.list.length = 0;
  }

  /**
   * The end of a clone: a hard necrotic burst. The VISUALS play on every peer (they all own a copy
   * of the double); the damage is the host's, exactly like every other horde-facing effect.
   */
  private detonate(d: Decoy, game: Game): void {
    game.effects.ring(d.position, d.up, 0.9, d.color, 0.5, 3.4, 0.95);
    game.effects.burst(d.position, 0xc94dff, { count: 30, speed: 16, life: 0.65, size: 0.85, gravity: 6 });
    game.effects.shake(0.2);
    game.audio.sfx('explode', 0.55);
    if (!game.isHost) return;
    const list = game.enemies.query(d.position.x, d.position.y, d.position.z, d.blast + 3, game.enemies.scratch());
    for (const e of list) {
      if (!e.alive) continue;
      const rr = d.blast + e.radius;
      if (e.position.distanceToSquared(d.position) > rr * rr) continue;
      game.hitEnemy(e, d.blastDmg, d.ownerId, 'burst');
      _d.copy(e.position).sub(d.position);
      if (_d.lengthSq() > 1e-4) e.velocity.addScaledVector(_d.normalize(), 9);
    }
  }
}
