// NECROFALL — projectile pool + 3D spherical collision resolution.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { MAX_PROJECTILES, type QualitySettings } from '../core/Config';
import type { Enemy } from '../enemies/Enemies';
import { clamp } from '../utils/Utils';

export interface ProjectileSpawn {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  damage: number;
  ownerId: string | null;
  colony: number;
  color: number;
  radius?: number;
  life?: number;
  pierce?: number;
  /** 'both' hits enemies + enemy-colony players, 'players' hits players only (enemy attacks). */
  hostile?: 'players' | 'both';
  chain?: number;
  /** Damage kept per chain hop (0.5 = VOLT's Conduction). */
  chainDecay?: number;
  /** Stretch along the flight direction — shards, fists, phase lasers. */
  elong?: number;
  /** Fire rounds leave a burning particle trail (PYRE's flamethrower). */
  ember?: boolean;
  homing?: number;
  /** Impulse pushed into whatever this projectile hits (fused BREAKER/BULWARK loadouts). */
  knock?: number;
  targetId?: number;
  crit?: boolean;
  isSkill?: boolean;
  size?: number;
  silent?: boolean;
  /** Visual-only projectile (no collisions) — used to mirror remote ability casts. */
  visual?: boolean;
  /** Web projectiles snare the player they hit. */
  web?: boolean;
}

interface Projectile {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  life: number;
  damage: number;
  ownerId: string | null;
  colony: number;
  radius: number;
  pierce: number;
  hostile: 'players' | 'both';
  chain: number;
  chainDecay: number;
  elong: number;
  ember: boolean;
  homing: number;
  knock: number;
  targetId: number;
  crit: boolean;
  isSkill: boolean;
  size: number;
  trailT: number;
  hitIds: number[];
  visual: boolean;
  web: boolean;
}

const _v = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _dummy = new THREE.Object3D();

export class CombatSystem {
  private pool: Projectile[] = [];
  private inst: THREE.InstancedMesh;
  private tmpEnemies: Enemy[] = [];
  private lastRendered = 0;
  activeCount = 0;
  /**
   * Live projectile ceiling. The pool is allocated at the top preset so the graphics option can be
   * raised at runtime; the ceiling is what actually changes.
   */
  private cap: number;

  constructor(private game: Game, quality: QualitySettings) {
    const geo = new THREE.SphereGeometry(1, 7, 5);
    const mat = new THREE.MeshBasicMaterial();
    this.inst = new THREE.InstancedMesh(geo, mat, MAX_PROJECTILES);
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.inst.frustumCulled = false;
    this.cap = clamp(quality.maxProjectiles, 0, MAX_PROJECTILES);
    this.inst.count = this.cap;
    const black = new THREE.Color(0, 0, 0);
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.inst.setColorAt(i, black);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      this.inst.setMatrixAt(i, _dummy.matrix);
      this.pool.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        color: new THREE.Color(),
        life: 0, damage: 0, ownerId: null, colony: -1, radius: 0.45, pierce: 0,
        hostile: 'both', chain: 0, chainDecay: 0.7, elong: 1, ember: false, homing: 0, knock: 0, targetId: 0,
        crit: false, isSkill: false,
        size: 1, trailT: 0, hitIds: [], visual: false, web: false,
      });
    }
    this.inst.instanceColor!.needsUpdate = true;
    game.scene.add(this.inst);
  }

  spawn(o: ProjectileSpawn): void {
    // A preset that allows fewer live rounds simply refuses the extra ones (and the renderer is
    // already bounded by `inst.count`), instead of growing the pool.
    if (this.activeCount >= this.cap) return;
    let p: Projectile | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].active) {
        p = this.pool[i];
        break;
      }
    }
    if (!p) return;
    p.active = true;
    p.pos.copy(o.pos);
    p.vel.copy(o.dir).multiplyScalar(o.speed);
    p.color.setHex(o.color);
    p.life = o.life ?? 2.4;
    p.damage = o.damage;
    p.ownerId = o.ownerId;
    p.colony = o.colony;
    p.radius = o.radius ?? 0.45;
    p.pierce = o.pierce ?? 0;
    p.hostile = o.hostile ?? 'both';
    p.chain = o.chain ?? 0;
    p.chainDecay = o.chainDecay ?? 0.7;
    p.elong = o.elong ?? 1;
    p.ember = o.ember ?? false;
    p.homing = o.homing ?? 0;
    p.knock = o.knock ?? 0;
    p.targetId = o.targetId ?? 0;
    p.crit = o.crit ?? false;
    p.isSkill = o.isSkill ?? false;
    p.size = o.size ?? 1;
    p.visual = o.visual ?? false;
    p.web = o.web ?? false;
    p.trailT = 0;
    p.hitIds.length = 0;
    if (!o.silent) {
      this.game.effects.trail(o.pos, o.color, 0.5 * p.size, 0.2);
    }
  }

  private kill(p: Projectile): void {
    p.active = false;
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
    this.activeCount = 0;
  }

  /**
   * Removes every live round owned by `ownerId` — called when the owner dies or a menu freezes
   * them. Their shooting stops COMPLETELY, including what is already in the air: leaving the
   * rounds flying let a corpse (or a player reading a picker) keep landing silent kills.
   * `activeCount` is recomputed at the end of `update`, so clearing here needs no bookkeeping.
   */
  clearOwner(ownerId: string): void {
    for (const p of this.pool) {
      if (p.active && p.ownerId === ownerId) p.active = false;
    }
  }

  /** Graphics-preset hook: how many rounds may be in flight at once. */
  setCap(cap: number): void {
    this.cap = clamp(cap, 0, this.pool.length);
    this.inst.count = this.cap;
    if (this.lastRendered > this.cap) {
      for (let i = this.cap; i < this.lastRendered; i++) {
        _dummy.position.set(0, 0, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        this.inst.setMatrixAt(i, _dummy.matrix);
      }
      this.inst.instanceMatrix.needsUpdate = true;
      this.lastRendered = this.cap;
    }
  }

  update(dt: number): void {
    const game = this.game;
    let rendered = 0;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.kill(p);
        continue;
      }

      // homing
      if (p.homing > 0 && p.targetId) {
        const target = game.enemies.byId(p.targetId);
        if (target && target.alive) {
          _v.copy(target.position).addScaledVector(target.up, target.radius * 0.6).sub(p.pos);
          const dist = _v.length();
          if (dist > 0.01) {
            _v.multiplyScalar(1 / dist);
            p.vel.lerp(_v.multiplyScalar(p.vel.length()), clamp(p.homing * dt * 6, 0, 1));
          }
        }
      }

      p.pos.addScaledVector(p.vel, dt);

      // terrain collision
      const terrainH = game.planet.heightAt(p.pos);
      if (p.pos.lengthSq() <= terrainH * terrainH) {
        game.effects.hitSpark(p.pos, p.color.getHex(), 5);
        if (p.isSkill) game.effects.burst(p.pos, p.color.getHex(), { count: 6, speed: 5, life: 0.35, size: 0.5 });
        this.kill(p);
        continue;
      }

      const speed = p.vel.length();
      const broad = p.radius + speed * dt * 0.8 + 1.5;
      let dead = false;

      // enemies
      if (!dead && !p.visual && p.hostile === 'both') {
        const list = game.enemies.query(p.pos.x, p.pos.y, p.pos.z, broad, this.tmpEnemies);
        for (const e of list) {
          if (!e.alive) continue;
          if (p.hitIds.indexOf(e.id) >= 0) continue;
          const rr = p.radius + e.radius + 1.1;
          if (e.position.distanceToSquared(p.pos) > rr * rr) continue;
          p.hitIds.push(e.id);
          game.hitEnemy(e, p.damage, p.ownerId, p.isSkill ? 'skill' : 'auto', p.crit);
          // weapon status effects (burn / slow / poison) from auto attacks
          if (!p.isSkill) {
            const owner = p.ownerId ? game.players.get(p.ownerId) : null;
            const status = owner ? owner.necrotech.stats.status : null;
            // `cryo` is the ONLY thing that puts the ice tell on a body — a slow on its own must not,
            // or every class with a slowing effect frosts the whole horde (see NecrotechStats.cryo).
            if (owner && status) e.applyStatus(status, owner.necrotech.stats.statusPower, owner.id, owner.necrotech.stats.cryo === true);
            // fused loadouts punch what they hit: shove it along the shot direction
            if (p.knock > 0 && !e.isBoss) {
              _v.copy(p.vel).normalize().addScaledVector(e.up, -_v.dot(e.up));
              if (_v.lengthSq() > 1e-4) e.velocity.addScaledVector(_v.normalize(), p.knock);
            }
          }
          game.effects.hitSpark(p.pos, p.color.getHex(), 6);
          this.chainZap(p, e);
          if (p.pierce > 0) {
            p.pierce--;
          } else {
            this.kill(p);
            dead = true;
            break;
          }
        }
      }

      // players (a `visual` round is a mirror of someone else's simulation: it never collides)
      if (!dead && !p.visual) {
        for (const pl of game.players.values()) {
          if (!pl.alive) continue;
          if (pl.id === p.ownerId) continue;
          if (p.colony >= 0 && pl.colony === p.colony) continue; // no friendly fire
          const rr = p.radius + 1.2;
          if (pl.position.distanceToSquared(p.pos) > rr * rr) continue;
          // The ward is a wall for the horde: enemy rounds (`ownerId === null`) stop at it — no
          // damage AND no web — since a sheltered survivor is untargetable anyway.
          if (!p.ownerId && game.inSafeZone(pl.position, 0)) {
            game.effects.hitSpark(p.pos, 0xffffff, 4);
            this.kill(p);
            dead = true;
            break;
          }
          if (pl.isInvulnerable()) {
            game.effects.hitSpark(p.pos, 0xffffff, 4);
            this.kill(p);
            dead = true;
            break;
          }
          game.hitPlayer(pl, p.damage, p.ownerId, p.hostile === 'players' ? 'enemy' : p.isSkill ? 'skill' : 'auto');
          if (p.web) {
            pl.addBuff('spdMul', 0.45, 1.8, 'Webbed');
            game.effects.burst(pl.position, 0xbfe9ff, { count: 10, speed: 5, life: 0.5, size: 0.6, gravity: 3 });
          }
          game.effects.hitSpark(p.pos, p.color.getHex(), 8);
          this.kill(p);
          dead = true;
          break;
        }
      }

      if (dead) continue;

      // trails
      p.trailT -= dt;
      if (p.ember) {
        // flamethrower rounds dribble fire as they fly
        if (p.trailT <= 0) {
          p.trailT = 0.02;
          game.effects.burst(p.pos, p.color.getHex(), { count: 1, speed: 1.6, life: 0.34, size: 0.55 * p.size, gravity: -8 });
        }
      } else if (p.trailT <= 0 && p.size > 0.8) {
        p.trailT = 0.045;
        game.effects.trail(p.pos, p.color.getHex(), 0.45 * p.size, 0.16);
      }

      // write instance
      if (rendered < this.inst.count) {
        _dummy.position.copy(p.pos);
        const r = p.radius * p.size;
        _dummy.scale.set(r, r * p.elong, r);
        if (p.elong !== 1) {
          // stretch along the flight direction: shards, fists and lasers read as shapes, not dots
          _v.copy(p.vel).normalize();
          _dummy.quaternion.setFromUnitVectors(_UP, _v);
        } else {
          _dummy.quaternion.identity();
        }
        _dummy.updateMatrix();
        this.inst.setMatrixAt(rendered, _dummy.matrix);
        this.inst.setColorAt(rendered, p.color);
        rendered++;
      }
    }

    // hide leftovers
    for (let i = rendered; i < this.lastRendered; i++) {
      _dummy.position.set(0, 0, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      this.inst.setMatrixAt(i, _dummy.matrix);
    }
    this.lastRendered = rendered;
    this.activeCount = rendered;
    this.inst.instanceMatrix.needsUpdate = true;
    if (this.inst.instanceColor) this.inst.instanceColor.needsUpdate = true;
  }

  /** Chain lightning style follow-up hits. */
  private chainZap(p: Projectile, from: Enemy): void {
    if (p.chain <= 0) return;
    const list = this.game.enemies.query(from.position.x, from.position.y, from.position.z, 9, this.tmpEnemies);
    let best: Enemy | null = null;
    let bestD = 81;
    for (const e of list) {
      if (!e.alive || e === from) continue;
      if (p.hitIds.indexOf(e.id) >= 0) continue;
      const d = e.position.distanceToSquared(from.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return;
    p.hitIds.push(best.id);
    // The discharge IS the passive, so it is drawn the way every other Volt arc is drawn: a
    // white-cored bolt with offshoots, thick enough to read over a crowded field and alive long
    // enough for the eye to catch it walking from one body to the next. It used to be a 0.22-wide,
    // 0.16 s hairline that was gone before anyone saw it, which made the Conduction bounce look like
    // the shot had simply hit twice.
    _v.copy(from.position).addScaledVector(from.up, from.radius * 0.9);
    _v2.copy(best.position).addScaledVector(best.up, best.radius * 0.9);
    this.game.effects.bolt(_v, _v2, 0x9fe8ff, {
      width: 0.5, life: 0.3, jitter: 0.26, segments: 10, branches: 3,
    });
    // and where it lands: a splash of sparks plus a short ground ring, so a bounce stays legible
    // even when both victims are buried in a swarm
    this.game.effects.burst(_v2, 0xd8f4ff, { count: 12, speed: 11, life: 0.32, size: 0.5, gravity: 2 });
    this.game.effects.ring(best.position, best.up, 1.1, 0x7fd4ff, 0.32, 2.8, 0.75);
    this.game.hitEnemy(best, p.damage * p.chainDecay, p.ownerId, 'skill');
    p.chain--;
    this.chainZap(p, best);
  }
}

const _v2 = new THREE.Vector3();
