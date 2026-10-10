// NECROFALL — ability execution: the class Skills + Ultimates + Necrotech Burst.
//
// Every ability reads its footprint from the SAME `aim` descriptor the on-ground marker uses
// (necrotech/AimPreview.ts), so the shape a player sees while aiming is exactly what gets hit.
// Damage authority is the P2P host; the casting peer owns its own projectiles and visuals.
// modes: 'caster' (this peer owns the caster) | 'host' (host applying a remote client's cast) | 'remote' (visuals only)
import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Player } from '../player/Player';
import type { Enemy } from '../enemies/Enemies';
import { AbilityAim, ResolvedAim, StatusKind, aimDefault, aimRange, resolveAim } from '../necrotech/NecrotechData';
import { CONFIG } from '../core/Config';
import { clamp, tangentBasis } from '../utils/Utils';

export type CastMode = 'caster' | 'host' | 'remote';

interface Task {
  t: number;
  fn: () => void;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** The aura Fortress Protocol hands to everyone standing in its field (caster included). */
const FORTRESS_AURA = {
  key: 'takenMul',
  mul: 0.4,
  label: 'Fortress Field',
  desc: '−60% damage taken and a steady mend while you hold the strongpoint.',
} as const;

/** How fast Fortress Protocol hauls a Necrophage body on to the strongpoint (m/s). */
const FORTRESS_DRAG_SPEED = 8;
/** Bosses and named creatures are far too heavy to be towed at full speed. */
const FORTRESS_DRAG_BOSS_MUL = 0.3;
const FORTRESS_DRAG_NAMED_MUL = 0.6;

export class AbilitySystem {
  static nextEventId = 1;
  private tasks: Task[] = [];
  private tmpE: Enemy[] = [];
  /** Scratches used by run() only — never shared with the geometry helpers below. */
  private s1 = new THREE.Vector3();
  private s2 = new THREE.Vector3();
  private s3 = new THREE.Vector3();
  /**
   * Direction scratch for shoot(). MUST be separate from s1/s2/s3: callers pass a muzzle position
   * that lives in one of those, and writing the direction into the same vector teleported the
   * projectile to the world origin (Salvo looked like it had no effect at all).
   */
  private projDir = new THREE.Vector3();
  /** Long-lived centre for multi-strike zones (Thunder Zone), which no emitter may clobber. */
  private zone = new THREE.Vector3();
  /** Rotation axis used when stepping a blast forward along the aim. */
  private axisV = new THREE.Vector3();
  /** How far along the aim the caster committed this cast (travelled over the wire). */
  private castDist = 0;
  /** Damage / arc carried by an auto-attack event (the whip lash) so the host applies the owner's roll. */
  private castDmg = 0;
  private castArc = 0;
  /** Flattened lash directions a whip event carries (x,y,z per lash) — see `Player.updateAutoAttack`. */
  private castDirs: number[] = [];

  constructor(private game: Game) {}

  clear(): void {
    this.tasks.length = 0;
  }

  update(dt: number): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i];
      task.t -= dt;
      if (task.t <= 0) {
        this.tasks.splice(i, 1);
        task.fn();
      }
    }
  }

  schedule(delay: number, fn: () => void): void {
    if (this.tasks.length > 220) return;
    this.tasks.push({ t: delay, fn });
  }

  // ------------------------------------------------------------ entry points

  castSkill(p: Player): void {
    // CHARGES (Blink Strike carries 3): the skill fires while any charge stands, and the recharge
    // clock is started by the first cast — one charge returns per completed clock (see
    // Player.tickSkillCharges). A skill without charges keeps the classic 1-charge behaviour.
    if (!p.alive || p.frozen || p.skillCharges <= 0) return;
    p.skillCharges--;
    if (p.skillCd <= 0) p.skillCd = p.skillCdMax;
    this.beginCast(p, p.necrotech.skill.id, 'skill');
  }

  castUlt(p: Player): void {
    if (p.ultCd > 0 || !p.alive || p.frozen) return;
    p.ultCd = p.ultCdMax;
    this.beginCast(p, p.necrotech.ult.id, 'ult');
  }

  private beginCast(p: Player, id: string, kind: 'skill' | 'ult'): void {
    const g = this.game;
    const aim = new THREE.Vector3().copy(p.aimDir.lengthSq() > 0.01 ? p.aimDir : p.facing).normalize();
    const desc = kind === 'skill' ? p.necrotech.skill.aim : p.necrotech.ult.aim;
    // How far down the aim the player committed — aimed blasts land on exactly this point on every
    // peer, so the marker and the damage agree no matter who is hosting.
    const dist = this.castDistance(p, desc);
    g.audio.sfx(kind === 'skill' ? 'skill' : 'ult');
    g.effects.shake(kind === 'skill' ? 0.12 : 0.3);
    const eid = AbilitySystem.nextEventId++;
    const msg = {
      t: 'ev', id, src: p.id, eid,
      px: Math.round(p.position.x * 100) / 100,
      py: Math.round(p.position.y * 100) / 100,
      pz: Math.round(p.position.z * 100) / 100,
      dx: Math.round(aim.x * 1000) / 1000,
      dy: Math.round(aim.y * 1000) / 1000,
      dz: Math.round(aim.z * 1000) / 1000,
      dist: Math.round(dist * 100) / 100,
    };
    if (g.isHost) {
      this.run(id, p, aim, 'caster', dist);
      if (g.net.connected) g.net.broadcast(msg);
    } else {
      this.run(id, p, aim, 'caster', dist);
      g.net.sendToHost(msg);
    }
  }

  /** External casts (events received over the network). */
  runExternal(id: string, caster: Player, aim: THREE.Vector3, dist = 0, evDmg = 0, evArc = 0, evDirs: number[] = []): void {
    this.run(id, caster, aim, this.game.isHost ? 'host' : 'remote', dist, evDmg, evArc, evDirs);
  }

  /**
   * Fires a standalone ability event that is not tied to the Skill / Ultimate slots — used by world
   * triggers such as the Blitz pad, so its blast takes the normal host-authoritative damage route.
   */
  fireEvent(p: Player, id: string, dist = 0, evDmg = 0, evArc = 0, evDirs: number[] = []): void {
    const g = this.game;
    const aim = new THREE.Vector3().copy(p.aimDir.lengthSq() > 0.01 ? p.aimDir : p.facing).normalize();
    const eid = AbilitySystem.nextEventId++;
    const msg = {
      t: 'ev', id, src: p.id, eid,
      px: Math.round(p.position.x * 100) / 100,
      py: Math.round(p.position.y * 100) / 100,
      pz: Math.round(p.position.z * 100) / 100,
      dx: Math.round(aim.x * 1000) / 1000,
      dy: Math.round(aim.y * 1000) / 1000,
      dz: Math.round(aim.z * 1000) / 1000,
      dist,
      // only the whip uses these: the owner rolls the lash damage and sends the exact lash spread
      // it drew, so the host lands those numbers along those very directions
      dmg: evDmg > 0 ? evDmg : undefined,
      arc: evArc > 0 ? evArc : undefined,
      dirs: evDirs.length >= 3 ? evDirs : undefined,
    };
    if (g.isHost) {
      this.run(id, p, aim, 'caster', dist, evDmg, evArc, evDirs);
      if (g.net.connected) g.net.broadcast(msg);
    } else {
      this.run(id, p, aim, 'caster', dist, evDmg, evArc, evDirs);
      g.net.sendToHost(msg);
    }
  }

  /** Clamps the looked-at point to the ability's reach: this is where an aimed blast lands. */
  private castDistance(p: Player, aim: AbilityAim): number {
    const range = resolveAim(aim, p.autoRange).range;
    // An unaimed cast (keyboard Q/E, or a touch drag that never left the button) lands on the
    // ability's own default spot — NOT on the far edge of the ring, now that an aimed blast may be
    // placed there.
    const fallback = Math.min(range, aimDefault(aim, p.autoRange));
    if (!p.isLocal) return fallback;
    const input = this.game.input;
    if (!input.hasAim) return fallback;
    _v.copy(input.aimPoint).sub(p.position);
    _v.addScaledVector(p.up, -_v.dot(p.up));
    const len = _v.length();
    if (!(len > 1.5)) return fallback;
    // identical to AimPreview.aimCentre: the marker and the blast land on the same point
    return Math.min(len, range);
  }

  // ------------------------------------------------------------ helpers

  private abilityDamage(caster: Player, pct: number): number {
    return caster.autoDamage * pct * caster.mods.abilityMul * (caster.necrotech.superMut ? 1.1 : 1);
  }

  private aoe(
    caster: Player,
    center: THREE.Vector3,
    radius: number,
    pct: number,
    opts: { status?: StatusKind; statusPower?: number; instantKillSmall?: boolean; knockback?: number; knockUp?: number; pull?: number; frost?: boolean } = {}
  ): number {
    const g = this.game;
    const dmg = this.abilityDamage(caster, pct);
    let kills = 0;
    const list = g.enemies.query(center.x, center.y, center.z, radius + 3, this.tmpE);
    for (const e of list) {
      if (!e.alive) continue;
      const rr = radius + e.radius;
      if (e.position.distanceToSquared(center) > rr * rr) continue;
      if (opts.instantKillSmall && e.small) g.hitEnemy(e, 999999, caster.id, 'skill');
      else g.hitEnemy(e, dmg, caster.id, 'skill');
      if (!e.alive) kills++;
      if (opts.status) e.applyStatus(opts.status, opts.statusPower ?? 0, caster.id, opts.frost);
      if (opts.knockback || opts.knockUp) {
        _v.copy(e.position).sub(center);
        if (_v.lengthSq() < 1e-4) _v.copy(caster.facing);
        _v.normalize();
        if (opts.knockback) e.velocity.addScaledVector(_v, opts.knockback);
        // knockUp rides the body's own normal, so landing quakes pop the pack off the ground too
        if (opts.knockUp) e.velocity.addScaledVector(e.up, opts.knockUp);
      }
      if (opts.pull) {
        _v.copy(center).sub(e.position);
        if (_v.lengthSq() > 1e-4) e.velocity.addScaledVector(_v.normalize(), 14);
      }
    }
    for (const pl of g.players.values()) {
      if (pl === caster || !pl.alive || pl.colony === caster.colony) continue;
      const rr = radius + 1.3;
      if (pl.position.distanceToSquared(center) > rr * rr) continue;
      g.hitPlayer(pl, dmg * 0.9, caster.id, 'skill');
    }
    return kills;
  }

  private cone(
    caster: Player,
    dir: THREE.Vector3,
    halfAngleCos: number,
    range: number,
    pct: number,
    opts: { status?: StatusKind; statusPower?: number; knockback?: number; frost?: boolean } = {}
  ): void {
    const g = this.game;
    const dmg = this.abilityDamage(caster, pct);
    const list = g.enemies.query(caster.position.x, caster.position.y, caster.position.z, range + 3, this.tmpE);
    for (const e of list) {
      if (!e.alive) continue;
      _v.copy(e.position).sub(caster.position);
      const dist = _v.length();
      if (dist > range + e.radius) continue;
      if (dist > 0.01) {
        _v.multiplyScalar(1 / dist);
        if (_v.dot(dir) < halfAngleCos) continue;
      }
      g.hitEnemy(e, dmg, caster.id, 'skill');
      if (opts.status) e.applyStatus(opts.status, opts.statusPower ?? 0, caster.id, opts.frost);
      if (opts.knockback) e.velocity.addScaledVector(dir, opts.knockback);
    }
    for (const pl of g.players.values()) {
      if (pl === caster || !pl.alive || pl.colony === caster.colony) continue;
      _v.copy(pl.position).sub(caster.position);
      const dist = _v.length();
      if (dist > range + 1.3 || dist < 0.01) continue;
      _v.multiplyScalar(1 / dist);
      if (_v.dot(dir) < halfAngleCos) continue;
      g.hitPlayer(pl, dmg * 0.9, caster.id, 'skill');
    }
  }

  private line(caster: Player, from: THREE.Vector3, dir: THREE.Vector3, length: number, width: number, pct: number): void {
    const g = this.game;
    const dmg = this.abilityDamage(caster, pct);
    const center = _v3.copy(from).addScaledVector(dir, length * 0.5);
    const list = g.enemies.query(center.x, center.y, center.z, length * 0.5 + width + 3, this.tmpE);
    for (const e of list) {
      if (!e.alive) continue;
      _v2.copy(e.position).sub(from);
      const t = clamp(_v2.dot(dir), 0, length);
      _v.copy(from).addScaledVector(dir, t).sub(e.position);
      if (_v.length() > width + e.radius) continue;
      g.hitEnemy(e, dmg, caster.id, 'skill');
    }
    for (const pl of g.players.values()) {
      if (pl === caster || !pl.alive || pl.colony === caster.colony) continue;
      _v2.copy(pl.position).sub(from);
      const t = clamp(_v2.dot(dir), 0, length);
      _v.copy(from).addScaledVector(dir, t).sub(pl.position);
      if (_v.length() > width + 1.3) continue;
      g.hitPlayer(pl, dmg * 0.9, caster.id, 'skill');
    }
  }

  private shoot(
    caster: Player,
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    opts: {
      pct: number; speed?: number; color?: number; radius?: number; pierce?: number;
      visual: boolean; chain?: number; chainDecay?: number; homing?: number; elong?: number;
      life?: number; spread?: number;
    }
  ): void {
    const st = caster.necrotech.stats;
    // Berserker (and every fusion) throws extra rounds: stats say so, the skill obeys
    const extra = Math.max(0, caster.mods.projCount);
    const total = 1 + extra;
    const spread = opts.spread ?? (total > 1 ? 0.055 : 0);
    const pierce = (opts.pierce ?? 0) + (caster.hasBuff('Berserker') > 0 ? 1 : 0);
    for (let i = 0; i < total; i++) {
      const d = this.projDir.copy(dir);
      if (total > 1) d.applyAxisAngle(caster.up, (i - (total - 1) / 2) * spread * 2);
      this.game.combat.spawn({
        pos,
        dir: d,
        speed: opts.speed ?? caster.projSpeed * 1.25,
        damage: opts.visual ? 0 : this.abilityDamage(caster, opts.pct),
        ownerId: caster.id,
        colony: caster.colony,
        color: opts.color ?? caster.necrotechColor,
        radius: opts.radius ?? 0.7,
        pierce,
        chain: opts.chain ?? 0,
        chainDecay: opts.chainDecay ?? st.chainDecay ?? 0.7,
        elong: opts.elong ?? Math.max(1, st.elong ?? 1),
        homing: opts.homing ?? 0,
        ember: st.style === 'flame',
        isSkill: true,
        visual: opts.visual,
        life: opts.life ?? 1.4,
        size: 1.5,
      });
    }
  }

  private muzzlePos(caster: Player, dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(caster.position).addScaledVector(caster.up, 1.2).addScaledVector(dir, 0.9);
  }

  /** The whip crack drawn for a caster we are only WATCHING (see the `whipfx` net event). */
  whipVisual(caster: Player, aim: THREE.Vector3, arc: number, color: number): void {
    this.game.effects.slashArc(caster.position, caster.up, aim, caster.autoRange, Math.max(0.2, arc), color, {
      dur: 0.18, spin: 1, inner: 0.55, lift: 1.15,
    });
  }

  /**
   * Lands an aimed blast honouring the distance the caster committed to.
   *
   * The step forward is a rotation of `up` about `up × dir` — the SAME step the aiming marker takes.
   * (Rotating about `dir × up` walks the point backwards, which parked every aimed blast behind the
   * player instead of on the circle being shown.)
   */
  private landing(caster: Player, aim: THREE.Vector3, desc: AbilityAim, out: THREE.Vector3): THREE.Vector3 {
    const g = this.game;
    const range = resolveAim(desc, caster.autoRange).range;
    const use = this.castDist > 0 ? Math.min(this.castDist, range) : range;
    this.s3.copy(aim).addScaledVector(caster.up, -aim.dot(caster.up));
    if (this.s3.lengthSq() < 1e-5) this.s3.copy(caster.facing);
    this.s3.normalize();
    this.axisV.copy(caster.up).cross(this.s3).normalize();
    out.copy(caster.up).applyAxisAngle(this.axisV, use / g.planet.radius).normalize();
    const h = g.planet.heightAtDir(out.x, out.y, out.z) + 0.05;
    return out.multiplyScalar(h);
  }

  // ------------------------------------------------------------ MOBA-style effect shapes
  //
  // Ground telegraphs, cone fans and lingering fields give every ability a readable footprint —
  // the same language a MOBA uses: a marked area, a wind-up, then an impact you can see coming.

  /** Ground indicator that fades in during the wind-up, then a ping where the effect lands. */
  private telegraph(center: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, delay: number, ring = true): void {
    const g = this.game;
    g.effects.disk(center, up, radius, color, delay, 1, 0.18);
    g.effects.disk(center, up, radius * 0.55, color, delay, 1, 0.12);
    if (ring) g.effects.ring(center, up, radius, color, Math.max(0.18, delay * 0.9), 1.05, 0.5);
    // a final bright pulse exactly when it detonates
    g.effects.ring(center, up, radius * 0.35, color, 0.35, 2.6, 0.95, delay);
  }

  /** A cone/skillshot fan: arc of bursts and shells out to `range` across ±halfAngle. */
  private fan(caster: Player, dir: THREE.Vector3, range: number, halfAngle: number, color: number, steps = 7): void {
    const g = this.game;
    const spot = new THREE.Vector3();
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : (i / (steps - 1)) * 2 - 1;
      const ang = t * halfAngle;
      spot.copy(dir).applyAxisAngle(caster.up, ang).normalize();
      const reach = range * (0.55 + 0.45 * (1 - Math.abs(t) * 0.55));
      const tip = _v3.copy(caster.position).addScaledVector(spot, reach);
      g.effects.burst(tip, color, { count: 9, speed: 11, life: 0.42, size: 0.75, gravity: -3 });
      if (i % 2 === 0) g.effects.ring(tip, caster.up, 0.6, color, 0.35, 3.2, 0.55);
    }
    // leading edge of the wave, plus a ring at the caster's feet
    const lead = _v2.copy(caster.position).addScaledVector(dir, range * 0.75);
    g.effects.disk(lead, caster.up, range * 0.45, color, 0.4, 1.0, 0.16);
    g.effects.ring(caster.position, caster.up, 1.1, color, 0.45, 3.4, 0.8);
  }

  /** Lingering damage zone that ticks on the host while the visuals loop. */
  /**
   * Absolute Zero's crater, Plaguewake's jet and Supernova's molten ground all want a patch of
   * ground that looks like a THING rather than a decal, so the two helpers below own those looks.
   */
  private venomSpring(centre: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, dur: number, interval: number): void {
    const g = this.game;
    // the lit pool the spring stands in: a small bright puddle inside the damage patch
    g.effects.disk(centre, up, radius * 0.55, color, dur, 1.03, 0.34);
    g.effects.ring(centre, up, radius * 0.42, color, dur, 1.25, 0.6);
    // The spout itself is dense: a jet every ~0.1 s, thrown high and hard so it visibly climbs well
    // above the patch and rains back down over it. This is what separates Plaguewake from Toxic
    // Bloom's flat bubbling field, so it must never be subtle.
    const jets = Math.max(1, Math.round(dur / interval));
    const perJet = Math.max(1, Math.round(interval / 0.1));
    for (let i = 0; i < jets; i++) {
      this.schedule(i * interval, () => {
        for (let k = 0; k < perJet; k++) {
          const boost = 1 + k * 0.12;
          _v.copy(centre).addScaledVector(up, 0.4);
          // the jet: a tight column of venom fired straight up, arcing out and falling back
          g.effects.burst(_v, color, {
            count: 4, speed: 19 * boost, life: 1.3, size: 0.7,
            dir: up, jitter: 0.3, gravity: 11, drag: 0.45,
          });
          // the splash: a slower spray around the mouth of the spring
          g.effects.burst(_v, 0x7dff3d, {
            count: 3, speed: 8 * boost, life: 1.0, size: 0.5,
            up, spread: 0.95, gravity: 12, drag: 0.9,
          });
        }
        // a standing column of light marks the spout from across the field
        _v.copy(centre).addScaledVector(up, 0.3);
        _v2.copy(centre).addScaledVector(up, 6.5 + Math.random() * 2.5);
        g.effects.beam(_v, _v2, color, 0.55, 0.24, 0.5);
        g.effects.ring(centre, up, radius * 0.18, color, 0.42, radius * 0.7, 0.55);
        if (i % 2 === 0) g.audio.sfx('regen', 0.09);
      });
    }
  }

  /**
   * Ground that has been turned to lava: layered discs heating from crust to white-hot, a glowing
   * rim, and ember bubbles rising off the surface for `dur` seconds. Purely visual.
   */
  private lavaFloor(centre: THREE.Vector3, up: THREE.Vector3, radius: number, dur: number): void {
    const g = this.game;
    g.effects.disk(centre, up, radius, 0x8a2a06, dur, 1.02, 0.42);
    g.effects.disk(centre, up, radius * 0.86, 0xff5a10, dur * 0.92, 1.02, 0.4);
    g.effects.disk(centre, up, radius * 0.5, 0xffd257, dur * 0.75, 1.05, 0.32);
    g.effects.ring(centre, up, radius, 0xff7a1e, dur, 1.0, 0.7);
    const ticks = Math.max(1, Math.round(dur / 0.14));
    for (let i = 0; i < ticks; i++) {
      this.schedule(i * 0.14, () => {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * radius * 0.85;
        tangentBasis(up, _v2, _v3);
        _v.copy(centre).addScaledVector(up, 0.1)
          .addScaledVector(_v2, Math.cos(ang) * r)
          .addScaledVector(_v3, Math.sin(ang) * r);
        g.effects.burst(_v, Math.random() < 0.5 ? 0xff6a1e : 0xffc24d, {
          count: 2, speed: 2.4, life: 0.7, size: 0.42, up, spread: 0.55, gravity: 1.4, drag: 1.6,
        });
      });
    }
  }

  /** Lingering damage zone that ticks on the host while the visuals loop. */
  private field(
    caster: Player,
    center: THREE.Vector3,
    up: THREE.Vector3,
    radius: number,
    color: number,
    duration: number,
    interval: number,
    pct: number,
    opts: { status?: StatusKind; statusPower?: number; knockback?: number; pull?: boolean } = {}
  ): void {
    const g = this.game;
    const applyDmg = g.isHost;
    g.effects.disk(center, up, radius, color, duration, 1.05, 0.26);
    g.effects.ring(center, up, radius * 0.8, color, duration, 1.15, 0.7);
    const ticks = Math.max(1, Math.round(duration / interval));
    for (let i = 0; i < ticks; i++) {
      this.schedule(i * interval, () => {
        g.effects.burst(_v3.copy(center).addScaledVector(up, Math.random() * 1.6), color, {
          count: 7, speed: 7, life: 0.5, size: 0.7, gravity: -3,
        });
        if (i % 2 === 0) {
          // `expand` is a MULTIPLIER of the start radius, so base 0.2R × expand 5 runs the wave from
          // the centre out to the zone's edge and STOPS there — the marker is the ground it covers.
          g.effects.ring(center, up, radius * 0.2, color, 0.4, 5, 0.5);
        }
        if (!applyDmg) return;
        const patch = g.enemies.query(center.x, center.y, center.z, radius + 3, this.tmpE);
        const dmg = this.abilityDamage(caster, pct / ticks);
        for (const e of patch) {
          if (!e.alive) continue;
          const rr = radius + e.radius;
          if (e.position.distanceToSquared(center) > rr * rr) continue;
          g.hitEnemy(e, dmg, caster.id, 'skill');
          if (opts.status) e.applyStatus(opts.status, opts.statusPower ?? 0, caster.id);
          if (opts.knockback) {
            _v2.copy(e.position).sub(center);
            if (_v2.lengthSq() < 1e-4) _v2.copy(caster.facing);
            e.velocity.addScaledVector(_v2.normalize(), opts.knockback);
          }
          if (opts.pull) {
            _v2.copy(center).sub(e.position);
            if (_v2.lengthSq() > 1e-4) e.velocity.addScaledVector(_v2.normalize(), 13);
          }
        }
      });
    }
  }

  /** Bright slash arcs — the readable "melee sweep" tell. */
  private slash(caster: Player, dir: THREE.Vector3, range: number, halfAngle: number, color: number, steps = 5): void {
    const g = this.game;
    const a = new THREE.Vector3();
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : (i / (steps - 1)) * 2 - 1;
      a.copy(dir).applyAxisAngle(caster.up, t * halfAngle).normalize();
      const tip = _v3.copy(caster.position).addScaledVector(a, range);
      g.effects.beam(_v2.copy(caster.position).addScaledVector(caster.up, 1.1), tip, color, 0.3, 0.2, 0.9);
    }
  }

  /** Lightning that leaps onward, losing `decay` damage per hop — VOLT's whole identity. */
  private chainSpread(
    caster: Player,
    from: THREE.Vector3,
    hops: number,
    jump: number,
    pct: number,
    color: number,
    decay = 0.7
  ): void {
    if (hops <= 0) return;
    const g = this.game;
    const list = g.enemies.query(from.x, from.y, from.z, jump + 3, this.tmpE);
    let best: Enemy | null = null;
    let bestD = jump * jump;
    for (const e of list) {
      if (!e.alive) continue;
      const dd = e.position.distanceToSquared(from);
      if (dd < 0.09 || dd > bestD) continue;
      bestD = dd;
      best = e;
    }
    if (!best) return;
    // A bolt, not a beam: the spread is the same electricity the arc weapon fires, so it is drawn
    // with the same white-cored, many-branched discharge. A hairlike beam made the leaps read as a
    // glitch in the damage numbers rather than as lightning walking from body to body.
    g.effects.bolt(from, _v3.copy(best.position).addScaledVector(best.up, best.radius * 0.8), color, {
      width: 0.46, life: 0.26, jitter: 0.26, segments: 9, branches: 2,
    });
    g.effects.burst(best.position, color, { count: 10, speed: 9, life: 0.3, size: 0.5, gravity: 2 });
    g.effects.ring(best.position, best.up, 1.0, color, 0.3, 2.6, 0.7);
    g.hitEnemy(best, this.abilityDamage(caster, pct), caster.id, 'skill');
    this.chainSpread(caster, best.position, hops - 1, jump, pct * decay, color, decay);
  }

  /**
   * A green restoration field — Siegebreaker's landing. Each peer mends its OWN player, so the
   * host broadcasts the heal instead of writing another player's health.
   */
  private healField(caster: Player, center: THREE.Vector3, radius: number, dur: number, perSec: number): void {
    if (!this.game.isHost) return;
    const g = this.game;
    const per = caster.maxHp * perSec * 0.5;
    const ticks = Math.max(1, Math.round(dur / 0.5));
    g.effects.disk(center, caster.up, radius, 0x9fe8b0, dur, 1.06, 0.24);
    g.effects.ring(center, caster.up, radius * 0.75, 0x6bff9d, dur, 1.2, 0.55);
    for (let i = 0; i < ticks; i++) {
      this.schedule(i * 0.5, () => {
        g.effects.burst(_v3.copy(center).addScaledVector(caster.up, 0.5 + Math.random()), 0x9fe8b0, {
          count: 5, speed: 4, life: 0.5, size: 0.5, gravity: -8,
        });
        for (const pl of g.players.values()) {
          if (!pl.alive || pl.colony !== caster.colony) continue;
          const rr = radius + 1.4;
          if (pl.position.distanceToSquared(center) > rr * rr) continue;
          if (pl.isLocal) pl.heal(per);
          else g.net.sendTo(pl.id, { t: 'pheal', pid: pl.id, amt: per });
        }
      });
    }
  }

  /**
   * Fortress Protocol's claimed ground. The strongpoint is a FIXED anchor: it keeps hauling the horde
   * onto itself, and hands its aura to whoever holds the ground — the caster AND every colony-mate
   * standing in it. The retaliation fires from the strongpoint too, never from the caster's body.
   *
   * Aura grants go through the same route the Siegebreaker heal field uses: each peer edits its OWN
   * player (the host sends `pheal` / `pbuff` to the players it does not own), so no client ever writes
   * another client's health or buffs.
   */
  private fortressField(caster: Player, centre: THREE.Vector3, up: THREE.Vector3, radius: number, dur: number): void {
    const g = this.game;
    const applyDmg = g.isHost;
    const tick = 0.5;
    const ticks = Math.max(1, Math.round(dur / tick));
    // The drag reaches further than the aura: the horde is hauled IN from outside the field, while the
    // protection only covers the ground the allies actually hold.
    const reach = radius * 1.6;
    // the ground the strongpoint claims: a wide disc, a brighter inner ring the allies stand in, and
    // a rim that marks the reach of the drag
    g.effects.disk(centre, up, radius, 0x9fe8b0, dur, 1.05, 0.22);
    g.effects.disk(centre, up, radius * 0.5, 0x6bff9d, dur, 1.02, 0.16);
    g.effects.ring(centre, up, radius, 0x9fe8b0, dur, 0.98, 0.6);
    g.effects.ring(centre, up, reach, 0x6bff9d, dur, 1.0, 0.3);
    const per = caster.maxHp * 0.03;
    for (let i = 0; i < ticks; i++) {
      this.schedule(i * tick, () => {
        // the field stays alive for its whole duration, not just at cast
        g.effects.burst(_v3.copy(centre).addScaledVector(up, 0.4 + Math.random() * 1.4), 0x9fe8b0, {
          count: 6, speed: 5, life: 0.6, size: 0.55, gravity: -6,
        });
        if (i % 3 === 0) {
          // the pulse is the picture of the ground the strongpoint holds: it runs out to the aura
          // radius and stops dead there, exactly like the disc that marks it (see the `expand` trap:
          // it is a MULTIPLIER of the start radius, so 0.2R x 5 == radius).
          g.effects.ring(centre, up, radius * 0.2, 0x6bff9d, 0.5, 5, 0.5);
          g.effects.burst(centre, 0xc9ffd6, { count: 14, speed: 9, life: 0.5, size: 0.6, gravity: -2 });
        }
        if (!applyDmg) return;
        // 1 — the drag: the horde is carried on to the strongpoint, body and all. Moving the POSITION
        // (and cancelling any outward momentum) is what makes the fortress the anchor instead of the
        // player — a velocity impulse alone loses to the creature's own steering within a few frames,
        // which is the same reason the Spinner whirl moves the body rather than only shoving it.
        const list = g.enemies.query(centre.x, centre.y, centre.z, reach + 3, this.tmpE);
        for (const e of list) {
          if (!e.alive) continue;
          const rr = reach + e.radius;
          if (e.position.distanceToSquared(centre) > rr * rr) continue;
          e.applyStatus('slow', 0.4, caster.id);
          _v.copy(centre).sub(e.position);
          const left = _v.length();
          if (left < 0.4) continue;                  // already piled on the strongpoint
          _v.multiplyScalar(1 / left);               // inward unit
          const weight = e.isBoss ? FORTRESS_DRAG_BOSS_MUL : e.isNamed ? FORTRESS_DRAG_NAMED_MUL : 1;
          e.position.addScaledVector(_v, Math.min(FORTRESS_DRAG_SPEED * weight * tick, left));
          g.planet.projectToSurface(e.position);
          e.up.copy(e.position).normalize();
          // facing the wrong way (moving out of the drag) is nulled, so it cannot walk back out
          const radial = e.velocity.dot(_v);
          if (radial < 0) e.velocity.addScaledVector(_v, -radial);
        }
        // 2 — the aura: the damage cut and the mend, for the caster and every ally in the area
        for (const pl of g.players.values()) {
          if (!pl.alive || pl.colony !== caster.colony) continue;
          const rr = radius + 1.4;
          if (pl.position.distanceToSquared(centre) > rr * rr) continue;
          if (pl.isLocal) {
            pl.refreshBuff(FORTRESS_AURA.key, FORTRESS_AURA.mul, tick + 0.35, FORTRESS_AURA.label, '', FORTRESS_AURA.desc);
            pl.heal(per);
          } else {
            g.net.sendTo(pl.id, {
              t: 'pbuff', pid: pl.id, key: FORTRESS_AURA.key, mul: FORTRESS_AURA.mul,
              dur: tick + 0.35, label: FORTRESS_AURA.label, desc: FORTRESS_AURA.desc,
            });
            g.net.sendTo(pl.id, { t: 'pheal', pid: pl.id, amt: per });
          }
        }
      });
    }
    // 3 — retaliation: the strongpoint slams the pile it just collected, three times over the field
    if (!applyDmg) return;
    for (const at of [dur * 0.1, dur * 0.5, dur * 0.9]) {
      this.schedule(at, () => {
        this.aoe(caster, centre, radius, 1.1, { knockback: 11 });
      });
      this.schedule(at, () => {
        // retaliation shockwave: a hard wave across the claimed ground, stopping at its edge
        g.effects.wave(centre, up, radius, 0x9fe8b0, { dur: 0.55, rings: 3, debris: 44, alpha: 0.9 });
        g.effects.burst(centre, 0xc9ffd6, { count: 30, speed: 15, life: 0.6, size: 0.7, gravity: 8 });
        g.effects.shake(0.3);
      });
    }
  }

  // ------------------------------------------------------------ ability switch

  run(id: string, caster: Player, aim: THREE.Vector3, mode: CastMode, dist = 0, evDmg = 0, evArc = 0, evDirs: number[] = []): void {
    const g = this.game;
    const fx = true; // every peer plays visuals
    this.castDmg = evDmg;
    this.castArc = evArc;
    this.castDirs = evDirs;
    const applyDmg = g.isHost; // damage authority
    const ownerSim = mode === 'caster'; // this peer owns the caster's projectiles
    const visualProj = !ownerSim;
    const col = caster.necrotechColor;
    this.castDist = dist;
    // every footprint is clamped inside the auto-attack ring, exactly like the ground marker
    const R = caster.autoRange;
    const fit = (a: AbilityAim): ResolvedAim => resolveAim(a, R);
    const d = (a: AbilityAim): number => fit(a).range;
    const rad = (a: AbilityAim): number => fit(a).radius;
    const laneW = (a: AbilityAim): number => fit(a).width;

    switch (id) {
      // ------------------------------------------------ RAVAGER (Marksman)
      case 'salvo': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        // the host is the damage authority for a client's cast: hit the same lane it drew
        if (applyDmg && !ownerSim) this.line(caster, caster.position, aim, range, laneW(a), 1.4);
        // a barrage of rounds straight down the lane — muzzle flash, tracer and a real projectile each
        const shots = 3;
        for (let i = 0; i < shots; i++) {
          this.schedule(i * 0.09, () => {
            if (!fx) return;
            const m = this.muzzlePos(caster, aim, this.s1);
            g.effects.burst(m, col, { count: 8, speed: 9, life: 0.24, size: 0.55, gravity: 0 });
            g.effects.ring(m, caster.up, 0.32, col, 0.2, 2.4, 0.8);
            this.shoot(caster, m, aim, { pct: 1.8, visual: visualProj, radius: 0.42, spread: 0.012 });
            g.effects.tracer(m, this.s2.copy(caster.position).addScaledVector(aim, range), col, 0.06);
          });
        }
        break;
      }
      // 'overcharge' / 'storm' / 'singularity' are the retired ids their replacements grew out of;
      // a mutation saved before the rework still resolves here.
      case 'overcharge':
      case 'berserker': {
        // ONE duration drives the whole ultimate: the base 5 s, scaled by the class passive and any
        // Ultimate-duration Necromutation perk the caster has taken (see Player.ultDuration).
        const dur = caster.ultDuration;
        // +2 projectiles on EVERYTHING (auto attacks and Skills) while it burns
        if (mode === 'caster') {
          caster.addBuff('dmgMul', 1.55, dur, 'Berserker');
          caster.addBuff('rateMul', 1.35, dur, 'Berserker');
          caster.addBuff('projCount', 2, dur, 'Berserker');
        }
        if (fx) {
          // IGNITION: the ground is scorched for the whole burn, a shockwheel blows outward and a
          // column of flame erupts out of the runner.
          g.effects.disk(caster.position, caster.up, 3.4, 0xff5a10, dur, 1.05, 0.16);
          g.effects.ring(caster.position, caster.up, 0.5, 0xffd9a1, 0.7, 6.5, 0.95);
          g.effects.ring(caster.position, caster.up, 0.4, 0xff8a3d, 0.9, 5.5, 0.7);
          _v3.copy(caster.position).addScaledVector(caster.up, 0.3);
          _v.copy(caster.position).addScaledVector(caster.up, 9);
          g.effects.beam(_v3, _v, 0xff8a3d, 1.5, 0.4, 0.7);
          g.effects.burst(caster.position, col, { count: 54, speed: 14, life: 0.9, size: 0.7, gravity: -2 });
          g.effects.burst(caster.position, 0xffd9a1, {
            count: 30, speed: 9, life: 1.1, size: 0.6, up: caster.up, spread: 0.7, gravity: -7, drag: 0.9,
          });
          g.effects.shake(0.45);
          // For the rest of the burn: a fresh shockwheel, a spray of sparks and flame tongues
          // climbing off the body, so the ult keeps READING as "on fire" instead of decaying into
          // a buff icon.
          const pulses = 6;
          for (let i = 1; i <= pulses; i++) {
            this.schedule(i * (dur / (pulses + 1)), () => {
              const p = g.players.get(caster.id);
              if (!p || p.hasBuff('Berserker') <= 0) return;
              g.effects.ring(p.position, p.up, 0.35, 0xffd9a1, 0.55, 4.6, 0.55);
              g.effects.burst(p.position, 0xff8a3d, { count: 12, speed: 7, life: 0.6, size: 0.5, gravity: -4 });
              g.effects.burst(p.position, 0xffc46b, {
                count: 10, speed: 6, life: 0.9, size: 0.45, up: p.up, spread: 0.55, gravity: -6, drag: 1.1,
              });
            });
          }
        }
        break;
      }
      // ------------------------------------------------ VOLT (Chain Mage)
      case 'lance': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        const end = this.s2.copy(caster.position).addScaledVector(aim, range);
        if (fx) {
          // a genuine discharge: a jagged bolt down the lane, crackling at both ends
          const start = this.muzzlePos(caster, aim, this.s1);
          g.effects.bolt(start, end, 0xd8f4ff, { width: 0.5, life: 0.3, jitter: 0.17, segments: 11, branches: 3 });
          g.effects.burst(end, 0x9fe8ff, { count: 22, speed: 12, life: 0.4, size: 0.65, gravity: 6 });
          for (let i = 1; i <= 4; i++) {
            const at = this.s1.copy(caster.position).addScaledVector(aim, (range * i) / 5);
            g.effects.burst(at, 0xbff0ff, { count: 5, speed: 7, life: 0.3, size: 0.5, gravity: 0 });
          }
        }
        if (applyDmg) this.line(caster, caster.position, aim, range, laneW(a), 3.4);
        // The lance arcs onward to nearby prey (up to 2 extra hits). The arc springs from the last
        // point the discharge REACHED, not from the far end every time, so the crackle visibly walks
        // prey to prey — and it is drawn thick and long enough to read over a crowded field.
        if (applyDmg) {
          const hopFrom = this.s3.copy(end);
          const arcs = g.enemies.query(end.x, end.y, end.z, 8, this.tmpE);
          let chained = 0;
          for (const e of arcs) {
            if (!e.alive || chained >= 2) continue;
            chained++;
            const hit = new THREE.Vector3().copy(e.position).addScaledVector(e.up, e.radius * 0.6);
            g.effects.bolt(hopFrom, hit, 0x9fe8ff, { width: 0.55, life: 0.3, jitter: 0.24, segments: 10, branches: 3 });
            g.effects.burst(hit, 0xbff0ff, { count: 12, speed: 10, life: 0.34, size: 0.55, gravity: 2 });
            g.effects.ring(e.position, e.up, 1.1, 0x7fd4ff, 0.32, 2.6, 0.7);
            g.hitEnemy(e, this.abilityDamage(caster, 1.5), caster.id, 'skill');
            hopFrom.copy(hit);
          }
        }
        break;
      }
      case 'storm':
      case 'thunderzone': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.zone);
        // the storm cell sits over the zone for the whole ultimate duration
        const dur = caster.ultDuration;
        if (fx) {
          this.telegraph(centre, caster.up, radius, 0xbff0ff, 0.45);
          g.effects.disk(centre, caster.up, radius, 0x7fd4ff, dur, 1.02, 0.14, 0.45);
        }
        const strikes = 10;
        // the wander and the strike disc are sized so the whole zone stays inside the ring
        const wander = radius * 0.45;
        const strikeR = radius * 0.8;
        for (let i = 0; i < strikes; i++) {
          this.schedule(0.45 + i * (dur / strikes), () => {
            const target = this.s1.copy(centre);
            if (i > 0) {
              const ang = Math.random() * Math.PI * 2;
              const rr = Math.random() * wander;
              tangentBasis(caster.up, _v, _v2);
              target.addScaledVector(_v, Math.cos(ang) * rr).addScaledVector(_v2, Math.sin(ang) * rr);
              g.planet.projectToSurface(target);
            }
            this.telegraph(target, caster.up, strikeR, 0xbff0ff, 0.3, false);
            const strike = this.s2.copy(target);
            this.schedule(0.3, () => {
              if (fx) {
                // The bolt arrives on a RANDOM DIAGONAL, like a storm cell overhead, instead of
                // dropping straight down — that is what makes the zone read as lightning.
                const tilt = 0.3 + Math.random() * 0.55;              // radians off vertical
                const heading = Math.random() * Math.PI * 2;
                tangentBasis(caster.up, _v, _v2);
                const from = this.s3.copy(strike)
                  .addScaledVector(caster.up, Math.cos(tilt) * 34)
                  .addScaledVector(_v, Math.cos(heading) * Math.sin(tilt) * 34)
                  .addScaledVector(_v2, Math.sin(heading) * Math.sin(tilt) * 34);
                g.effects.bolt(from, strike, 0xd8f4ff, { width: 0.62, life: 0.3, jitter: 0.2, segments: 12, branches: 3 });
                g.effects.ring(strike, caster.up, 1, 0xbff0ff, 0.5, 6, 0.95);
                g.effects.burst(strike, 0xbff0ff, { count: 26, speed: 14, life: 0.5, size: 0.7, gravity: 8 });
                g.effects.shake(0.22);
                g.audio.sfx('skill', 0.6);
              }
              if (!applyDmg) return;
              this.aoe(caster, strike, strikeR, 1.5, { status: 'slow', statusPower: 0.25 });
              // the strike leaps on, shedding 30% of its damage per bounce
              this.chainSpread(caster, strike, 3, 9, 1.05, 0xbff0ff, 0.7);
            });
          });
        }
        break;
      }
      // ------------------------------------------------ WHIPLASH (Warden)
      case 'whip': {
        // Host half of a swing: no visuals (the owner already drew the lashes), just the damage the
        // owner rolled, applied to everything inside the transmitted lash spread — creatures AND
        // survivors. The owner sends one direction per lash (`dirs`); an older sender's event falls
        // back to its single aim vector. A body inside several cones is still hit once per swing.
        if (!applyDmg) break;
        const half = this.castArc > 0.05 ? this.castArc * 0.5 : (caster.necrotech.stats.whipArc ?? 0.7);
        const range = Math.max(1.5, caster.autoRange);
        // The lashes obey the caster's range ring exactly like a locally-run whip (see
        // Player.autoFootprint): a body outside the drawn footprint — shrunken by a jump — is out.
        const foot = caster.ringFootprint(range);
        if (!foot.reach) break;
        const cosFoot = Math.cos(foot.theta);
        const cos = Math.cos(Math.min(2.6, half));
        const dmg = this.castDmg > 0 ? this.castDmg : caster.autoDamage;
        const dirs = this.castDirs.length >= 3 ? this.castDirs : null;
        const dirCount = dirs ? Math.floor(dirs.length / 3) : 1;
        const inLashes = (x: number, y: number, z: number, inv: number): boolean => {
          for (let j = 0; j < dirCount; j++) {
            const bx = dirs ? dirs[j * 3] : aim.x;
            const by = dirs ? dirs[j * 3 + 1] : aim.y;
            const bz = dirs ? dirs[j * 3 + 2] : aim.z;
            if ((x * bx + y * by + z * bz) * inv >= cos) return true;
          }
          return false;
        };
        const list = g.enemies.query(caster.position.x, caster.position.y, caster.position.z, range + 4, this.tmpE);
        for (const e of list) {
          if (!e.alive) continue;
          if (_v3.copy(e.position).normalize().dot(caster.up) < cosFoot) continue;
          _v.copy(e.position).addScaledVector(e.up, e.radius * 0.5).sub(_v2.copy(caster.position).addScaledVector(caster.up, 1.1));
          const dist = _v.length();
          if (dist > range + e.radius) continue;
          if (dist > 1e-3 && !inLashes(_v.x, _v.y, _v.z, 1 / dist)) continue;
          g.hitEnemy(e, dmg, caster.id, 'auto');
        }
        for (const pl of g.players.values()) {
          if (pl === caster || !pl.alive || pl.colony === caster.colony) continue;
          if (_v3.copy(pl.position).normalize().dot(caster.up) < cosFoot) continue;
          _v.copy(pl.position).addScaledVector(pl.up, 0.9).sub(_v2.copy(caster.position).addScaledVector(caster.up, 1.1));
          const dist = _v.length();
          if (dist > range + 1.3) continue;
          if (dist > 1e-3 && !inLashes(_v.x, _v.y, _v.z, 1 / dist)) continue;
          g.hitPlayer(pl, dmg, caster.id, 'auto');
        }
        break;
      }
      case 'spinner': {
        const a = caster.necrotech.skill.aim;
        const radius = rad(a);
        const dur = 2.6;
        const ticks = 7;
        if (fx) {
          // The chain whirl is part of the MODEL (see Player.startWhipSpin), so it is fixed to the
          // body and needs no follow logic here. This side only adds the ground feedback, and every
          // wave stays INSIDE the spin's reach — nothing may pulse past the damage ring.
          caster.startWhipSpin(dur, radius);
          g.effects.disk(caster.position, caster.up, radius, col, dur, 1, 0.2);
          // The wave starts at the player's body and travels out to the whirl's edge, then STOPS —
          // it is the picture of the shove rule (nothing inside that circle may stay there).
          // `expand` is a multiplier of the start radius, so base 0.2 x expand 5 ends at `radius`.
          g.effects.ring(caster.position, caster.up, radius * 0.2, col, 0.5, 5, 0.85);
          g.effects.burst(caster.position, col, { count: 30, speed: 16, life: 0.5, size: 0.7, gravity: 6 });
          g.effects.shake(0.22);
          g.audio.sfx('skill', 0.75);
        }
        // The whirl itself keeps them out (see EnemyManager: a spinning whip player drives
        // everything inside the ring away CONTINUOUSLY, and never past the ring).
        if (applyDmg) this.aoe(caster, caster.position, radius, 0.5, {});
        for (let i = 1; i <= ticks; i++) {
          this.schedule((dur * i) / ticks, () => {
            if (fx && i % 2 === 1) {
              // a ripple that runs body -> spin's edge and stops exactly there (see above)
              g.effects.ring(caster.position, caster.up, radius * 0.2, col, 0.4, 5, 0.7);
            }
            if (applyDmg) this.aoe(caster, caster.position, radius, 2.1 / ticks, {});
          });
        }
        break;
      }
      case 'judgement': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.s2).clone();
        // the cage stands for the whole ultimate duration
        const chainDur = caster.ultDuration;
        if (fx) {
          this.telegraph(centre, caster.up, radius, col, 0.5);
          this.schedule(0.5, () => {
            // the cross-spike eruption the ability always had — except every spike is now a BLACK
            // CHAIN that ends in a point, and the colour comes from the burst around it
            g.effects.chains(centre, caster.up, radius, {
              dur: chainDur + 0.7, height: 7.6, count: 15, layout: 'spikes',
            });
            g.effects.disk(centre, caster.up, radius, 0x1a0b16, chainDur + 0.5, 1.05, 0.5);
            g.effects.eruption(centre, caster.up, radius * 0.32, col, chainDur, 3.2);
            g.effects.ring(centre, caster.up, radius * 0.45, col, 0.8, radius * 1.35, 0.9);
            g.effects.ring(centre, caster.up, 1.1, 0xd9c8ff, 0.5, radius * 1.1, 0.65);
            g.effects.burst(centre, col, { count: 30, speed: 19, life: 0.7, size: 0.55, gravity: 20, up: caster.up, spread: 0.3 });
            g.effects.burst(centre, 0xd9c8ff, { count: 40, speed: 27, life: 1.15, size: 0.42, gravity: 26, up: caster.up, spread: 0.75 });
            g.effects.shake(0.45);
            g.audio.sfx('explode', 0.6);
          });
        }
        this.schedule(0.5, () => {
          // impaled and pinned: a hard root (stun) plus the damage
          if (applyDmg) this.aoe(caster, centre, radius, 3.8, { status: 'root', statusPower: 0 });
        });
        break;
      }
      // ------------------------------------------------ PYRE (Pyromancer)
      case 'flamewave': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        const halfAngle = a.halfAngle ?? 0.8;
        if (fx) {
          this.fan(caster, aim, range, halfAngle, 0xff7a3d, 11);
          g.effects.ring(caster.position, caster.up, 1.2, 0xff5b3d, 0.5, 3.2, 0.8);
        }
        // the wave leaves the ground burning just behind the arc it swept, still inside the ring
        this.field(
          caster,
          this.s2.copy(caster.position).addScaledVector(aim, range * 0.5),
          caster.up,
          range * 0.45,
          0xff5b3d,
          2.4,
          0.6,
          1.1,
          { status: 'burn', statusPower: 8 }
        );
        if (applyDmg) this.cone(caster, aim, Math.cos(halfAngle), range, 2.0, { status: 'burn', statusPower: 9 });
        break;
      }
      case 'meteor': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const target = this.landing(caster, aim, a, this.s2);
        if (fx) {
          // a full MOBA combo tell: marked ground during the flight, a real meteor, then the impact
          this.telegraph(target, caster.up, radius, 0xff5b3d, 0.75);
          g.effects.orb(this.s1.copy(target).addScaledVector(caster.up, 34), target, 1.5, 0xff8a3d, 0.75, {
            up: caster.up, trail: 1.1,
          });
        }
        this.schedule(0.75, () => {
          if (fx) {
            g.effects.burst(target, 0xff9a3d, { count: 84, speed: 26, life: 1, size: 1.15, gravity: 20 });
            // the shockwave reaches the edge of the (now wider) blast
            g.effects.ring(target, caster.up, 2.2, 0xff7a3d, 0.95, radius * 1.08, 1);
            g.effects.disk(target, caster.up, radius, 0xff5b3d, 0.6, 1.1, 0.4);
            g.effects.shake(0.68);
            g.audio.sfx('explode');
          }
          if (applyDmg) this.aoe(caster, target, radius, 5.0, { status: 'burn', statusPower: 16, knockback: 12 });
        });
        // lingering fire where it landed — it burns for the full ultimate duration
        this.field(caster, target, caster.up, radius * 0.75, 0xff5b3d, caster.ultDuration, 0.8, 2.4, { status: 'burn', statusPower: 12 });
        break;
      }
      // ------------------------------------------------ RIFT (Assassin)
      case 'blink': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        // the arrival slash is part of the footprint, so the dash stops short by its radius and the
        // whole move stays inside the ring
        const arrivalR = Math.max(1.6, rad(a) || R * 0.22);
        const travel = Math.max(2, range - arrivalR);
        const start = this.s1.copy(caster.position);
        const end = this.s2.copy(start);
        if (g.envWorld) {
          g.envWorld.obstacles.move(end, this.s3.copy(aim).multiplyScalar(travel), 1, CONFIG.player.radius, caster.grounded);
        } else {
          end.addScaledVector(aim, travel);
          g.planet.projectToSurface(end);
        }
        const distance = end.distanceTo(start);
        // the corridor is cut from the ORIGINAL position, before the caster moves
        if (applyDmg && distance > 0.001) this.line(caster, start, this.s3.subVectors(end, start).normalize(), distance, laneW(a), 2.2);
        if (fx) {
          for (let i = 1; i <= 6; i++) {
            const from = start.clone();
            const to = end.clone();
            const u = i / 7;
            this.schedule(i * 0.02, () => {
              const at = this.s3.copy(from).lerp(to, u);
              g.effects.burst(at, col, { count: 10, speed: 6, life: 0.45, size: 0.5, gravity: 0 });
              g.effects.trail(at, col, 0.6, 0.3);
            });
          }
          g.effects.ring(start, caster.up, 1.2, col, 0.5, 2.6, 0.9);
          g.effects.burst(start, col, { count: 22, speed: 11, life: 0.5, size: 0.6, gravity: 0 });
          g.effects.beam(start, end, col, 0.22, 0.22, 0.8);
        }
        if (mode === 'caster') {
          caster.position.copy(end);
          caster.up.copy(end).normalize();
          caster.velocity.multiplyScalar(0.4);
          // UNTOUCHABLE mid-strike (user ask): a real invulnerability window, not just damage
          // reduction — blink through the burst. `inv` rides the state stream (PlayerNet.inv), so
          // the host's authoritative copy sees the i-frames too.
          caster.invulnUntil = Math.max(caster.invulnUntil, g.now + 0.55);
          caster.addBuff('takenMul', 0.75, 0.6, 'Blink');
          if (caster.isLocal) g.cam.snap();
        }
        if (fx) {
          // arrival: a bright double slash that reads as the strike
          this.slash(caster, aim, 4.4, 0.9, col, 5);
          this.slash(caster, aim, 3.2, 1.3, 0xd8c4ff, 4);
          g.effects.ring(end, caster.up, 1.2, col, 0.5, 3.2, 0.95);
          g.effects.burst(end, col, { count: 26, speed: 12, life: 0.55, size: 0.65, gravity: 0 });
        }
        if (applyDmg) this.aoe(caster, end, arrivalR, 1.1);
        break;
      }
      case 'singularity':
      case 'blackhole': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.s2);
        // The well holds for the WHOLE ultimate duration, pulling and damaging on a steady tick; the
        // slow is what keeps prey from simply walking out of it.
        const dur = caster.ultDuration;
        const ticks = 10;
        const step = dur / ticks;
        if (fx) {
          this.telegraph(centre, caster.up, radius, col, 0.3);
          // a real horizon: dark core, accretion rings spiralling in, debris dragged off the rim
          g.effects.vortex(centre, caster.up, radius, col, dur);
          g.effects.shake(0.35);
        }
        for (let i = 0; i < ticks; i++) {
          this.schedule(0.14 + i * step, () => {
            if (!fx) return;
            for (const e of g.enemies.query(centre.x, centre.y, centre.z, radius, this.tmpE)) {
              if (!e.alive) continue;
              g.effects.beam(e.position, centre, col, 0.1, 0.1, 0.45);
            }
            // The PULL pulse: a shockwave off the well's own rim every OTHER tick, with debris torn
            // off the edge and thrown inward. Without it the hole was a dark disc that quietly did
            // damage; the wave is what says "this thing is dragging the field in".
            if (i % 2 === 0) {
              g.effects.wave(centre, caster.up, radius, col, { dur: 0.9, rings: 3, debris: 18, alpha: 0.5 });
              tangentBasis(caster.up, _v, _v2);
              for (let k = 0; k < 3; k++) {
                const ang = (k / 3) * Math.PI * 2 + i * 1.7;
                const rim = new THREE.Vector3()
                  .copy(centre)
                  .addScaledVector(_v, Math.cos(ang) * radius * 0.92)
                  .addScaledVector(_v2, Math.sin(ang) * radius * 0.92);
                g.effects.burst(rim, col, {
                  count: 7, speed: 9, life: 0.55, size: 0.5,
                  dir: _v3.copy(centre).sub(rim).normalize(), jitter: 0.35, drag: 0.7,
                });
              }
            }
          });
          this.schedule(0.3 + i * step, () => {
            if (applyDmg) this.aoe(caster, centre, radius, 0.42, { pull: 1, status: 'slow', statusPower: 0.5 });
          });
        }
        break;
      }
      // ------------------------------------------------ FROST (Controller)
      case 'frostnova': {
        const a = caster.necrotech.skill.aim;
        const radius = rad(a);
        if (fx) {
          const up = caster.up;
          g.effects.ring(caster.position, up, 1.1, 0xd8f4ff, 0.65, 4.6, 0.95);
          g.effects.ring(caster.position, up, 0.6, 0xa8e6ff, 0.45, 3.2, 0.8);
          g.effects.disk(caster.position, up, radius, 0xa8e6ff, 0.6, 1.05, 0.24);
          g.effects.burst(caster.position, 0xd8f4ff, { count: 46, speed: 15, life: 0.7, size: 0.7, gravity: 8 });
          g.effects.shake(0.2);
        }
        if (applyDmg) {
          this.aoe(caster, caster.position, radius, 2.6, { status: 'slow', statusPower: 0.6, frost: true });
          // anything standing in your face is frozen solid — and visibly encased in ice
          this.aoe(caster, caster.position, radius * 0.5, 0, { status: 'root', statusPower: 0, frost: true });
        }
        break;
      }
      case 'absolutezero': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.s2);
        // the glacier holds for the whole ultimate duration
        const dur = caster.ultDuration;
        const ticks = Math.max(1, Math.round(dur / 0.5));
        if (fx) {
          this.telegraph(centre, caster.up, radius, 0xa8e6ff, 0.45);
          this.schedule(0.45, () => {
            // the ice mountain: spikes tear out of the ground and stay for the whole field
            g.effects.eruption(centre, caster.up, radius, 0xd8f4ff, dur, 3.4);
            g.effects.disk(centre, caster.up, radius, 0x7fd4ff, dur, 1.05, 0.24);
            g.effects.ring(centre, caster.up, 1.5, 0xd8f4ff, 0.9, radius * 1.4, 0.95);
            g.effects.burst(centre, 0xd8f4ff, { count: 46, speed: 18, life: 0.8, size: 0.75, gravity: 8 });
            // frost thrown up the flanks of the peak
            for (let k = 0; k < 4; k++) {
              g.effects.burst(_v3.copy(centre).addScaledVector(caster.up, 1.4 + k * 0.7), 0xa8e6ff, {
                count: 8, speed: 6, life: 0.7, size: 0.6, up: caster.up, spread: 0.7, gravity: 3, drag: 1.6,
              });
            }
            g.effects.shake(0.25);
          });
        }
        for (let i = 0; i < ticks; i++) {
          this.schedule(0.45 + i * 0.5, () => {
            if (fx) {
              g.effects.burst(centre, 0xa8e6ff, { count: 10, speed: 9, life: 0.45, size: 0.65, gravity: 4 });
              if (i % 2 === 0) g.effects.ring(centre, caster.up, radius * 0.5, 0xa8e6ff, 0.5, radius, 0.6);
            }
            // first tick freezes targets solid (visible ice block), the rest keep them crawling
            if (applyDmg) {
              this.aoe(caster, centre, radius, 0.72, i === 0
                ? { status: 'root', statusPower: 0, frost: true }
                : { status: 'slow', statusPower: 0.65, frost: true });
            }
          });
        }
        break;
      }
      // ------------------------------------------------ VENOM (Plaguebearer)
      case 'toxicbloom': {
        const a = caster.necrotech.skill.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.s2);
        if (fx) this.telegraph(centre, caster.up, radius, 0x9dff6b, 0.3);
        this.field(caster, centre, caster.up, radius, 0x9dff6b, 4, 0.5, 2.4, { status: 'poison', statusPower: 9 });
        break;
      }
      case 'plaguewake': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.landing(caster, aim, a, this.s2);
        const dur = caster.ultDuration;
        if (fx) {
          this.telegraph(centre, caster.up, radius, 0x7dff3d, 0.5);
          this.schedule(0.5, () => {
            g.effects.ring(centre, caster.up, 2, 0x9dff6b, 1.2, radius * 1.5, 0.95);
            g.effects.shake(0.3);
          });
          // A VENOM WELLSPRING, not another toxic puddle: a bright spring of green that keeps
          // jetting straight up out of the middle and raining back down over the whole patch.
          this.venomSpring(centre, caster.up, radius, 0x9dff6b, dur + 0.2, 0.5);
        }
        // the plague runs for the whole ultimate duration; every corpse inside bursts and spreads it
        this.field(caster, centre, caster.up, radius, 0x9dff6b, dur, 0.5, 4.2, { status: 'poison', statusPower: 15 });
        break;
      }
      // ------------------------------------------------ BREAKER (Vanguard)
      case 'shockcone': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        const halfAngle = a.halfAngle ?? 0.62;
        if (fx) {
          this.fan(caster, aim, range, halfAngle, col, 9);
          g.effects.ring(caster.position, caster.up, 1.3, col, 0.45, 3.6, 0.9);
          g.effects.shake(0.24);
        }
        // the whole point of the kit: everything caught is thrown
        if (applyDmg) this.cone(caster, aim, Math.cos(halfAngle), range, 2.3, { knockback: 30, status: 'slow', statusPower: 0.35 });
        break;
      }
      case 'siegebreaker': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const impactAt = this.landing(caster, aim, a, this.s2).clone();
        // A full second of flight: twice the apex of the old leap, and the descent takes well under
        // half of it, so the ult reads as a plunge rather than a float.
        const dur = 0.78;
        if (mode === 'caster') {
          // a real leap: the owner peer flies the arc, the host has the impact scheduled below
          const p = g.players.get(caster.id);
          if (p) p.startSlam(p.position, impactAt, dur, 15);
          caster.addBuff('takenMul', 0.4, 1.6, 'Siegebreaker');
          g.audio.sfx('jump', 1);
        }
        if (fx) {
          this.telegraph(impactAt, caster.up, radius, col, dur);
          for (let i = 0; i < 10; i++) {
            this.schedule(i * (dur / 10), () => {
              const p = g.players.get(caster.id);
              if (!p) return;
              g.effects.burst(p.position, col, { count: 8, speed: 7, life: 0.32, size: 0.55, gravity: 4 });
              g.effects.trail(this.s1.copy(p.position).addScaledVector(p.up, 0.8), col, 0.55, 0.28);
            });
          }
        }
        this.schedule(dur, () => {
          if (fx) {
            g.effects.ring(impactAt, caster.up, 1.6, col, 0.7, 4.4, 1);
            g.effects.disk(impactAt, caster.up, radius, col, 0.6, 1.15, 0.42);
            g.effects.burst(impactAt, 0xffe6a8, { count: 54, speed: 20, life: 0.8, size: 0.9, gravity: 18 });
            g.effects.shake(0.55);
            g.audio.sfx('explode', 0.7);
          }
          // knock-up: a hard root plus the shove, then the green restoration field
          if (applyDmg) this.aoe(caster, impactAt, radius, 4.2, { knockback: 16, status: 'root', statusPower: 0 });
          this.healField(caster, impactAt, caster.autoRange, caster.ultDuration, 0.06);
        });
        break;
      }
      // ------------------------------------------------ BULWARK (Juggernaut)
      case 'quake': {
        const a = caster.necrotech.skill.aim;
        const radius = rad(a);
        if (fx) {
          this.telegraph(caster.position, caster.up, radius, col, 0.12, false);
          g.effects.disk(caster.position, caster.up, radius, col, 0.55, 1.2, 0.3, 0.12);
          g.effects.burst(caster.position, 0xbba26a, { count: 34, speed: 14, life: 0.65, size: 0.75, gravity: 26 });
          g.effects.shake(0.45);
          g.audio.sfx('explode', 0.55);
        }
        this.schedule(0.12, () => {
          if (applyDmg) this.aoe(caster, caster.position, radius, 2.5, { knockback: 12, status: 'slow', statusPower: 0.5 });
        });
        break;
      }
      case 'fortress': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        // the strongpoint stands for the full ultimate duration (5 s base, longer with duration perks)
        const dur = caster.ultDuration;
        // FORTRESS PROTOCOL: an AIMED strongpoint tears out of the ground where the player marked it
        // and STAYS there — the horde is dragged on to the FORTRESS, not on to the player, so the
        // tank can be shoved out of position without the taunt (and the field) walking off with them.
        const anchor = this.landing(caster, aim, a, this.s2).clone();
        const up = anchor.clone().normalize();
        if (fx) {
          g.effects.pillar(anchor, up, Math.max(1.1, radius * 0.26), Math.min(7.5, radius * 0.9), dur, 0x9fe8b0);
          // the bastion itself: a hexagonal energy curtain raised exactly on the ground the aura
          // protects, so the field's edge is a WALL the player can read from across the fight
          g.effects.dome(anchor, up, radius, 0x9fe8b0, dur);
          g.effects.wave(anchor, up, radius, 0x9fe8b0, { dur: 0.7, rings: 3, debris: 44 });
          g.effects.burst(anchor, 0xb9a8d8, { count: 40, speed: 16, life: 0.8, size: 0.9, gravity: 22, drag: 1.2 });
          g.effects.ring(anchor, up, 1.6, 0x9fe8b0, 1.0, 3.2, 0.95);
        }
        // the opening yank: tether everything in reach and haul it in, so the pile is already
        // arriving when the field starts ticking
        if (applyDmg) this.aoe(caster, anchor, radius, 0.6, { pull: 1, status: 'slow', statusPower: 0.45 });
        if (fx) {
          for (const e of g.enemies.query(anchor.x, anchor.y, anchor.z, radius, this.tmpE)) {
            if (!e.alive) continue;
            g.effects.beam(anchor, e.position, 0x9fe8b0, 0.4, 0.5, 0.8);
          }
        }
        // the ground it claims: the drag, the ally aura and the retaliation all live in here
        this.fortressField(caster, anchor, up, radius, dur);
        break;
      }
      // ------------------------------------------------ REAPER (Executioner)
      case 'scythe': {
        const a = caster.necrotech.skill.aim;
        const range = d(a);
        const halfAngle = a.halfAngle ?? 2.094;
        const arc = halfAngle * 2;
        if (fx) {
          // TWO scythes, one per side of the arc, sweeping inwards and overlapping across the
          // centre lane. They converge on the aim direction, which is exactly where the cut groups
          // everything it touches — the picture and the damage tell the same story.
          // `lift` is what makes them visible at all: slashArc draws a FLAT crescent in the plane
          // square to `up`, so cutting from the caster's feet means cutting along the ground and the
          // blades vanish into the terrain. Body height is where a scythe sweep belongs anyway.
          // `lift` is the height the cut passes at above the GROUND (slashArc projects the crescent
          // on to the terrain), so this is where the blade actually sweeps on the sweep's own arc —
          // chest height, and it stays there across a hillside instead of being swallowed by it.
          const SCYTHE_LIFT = 2.0;
          const half = arc * 0.5;
          const bladeArc = half + 0.5;                 // 0.5 rad of overlap across the middle
          // (slashArc copies the direction it is given, so one scratch vector serves both blades)
          const left = _v2.copy(aim).applyAxisAngle(caster.up, -half * 0.5).normalize();
          g.effects.slashArc(caster.position, caster.up, left, range, bladeArc, 0xffb3d1, {
            dur: 0.34, spin: -1, inner: 0.42, lift: SCYTHE_LIFT,
          });
          g.effects.slashArc(caster.position, caster.up, left, range, bladeArc * 0.72, 0xffffff, {
            dur: 0.34, spin: -1, inner: 0.74, lift: SCYTHE_LIFT + 0.2,
          });
          const right = _v2.copy(aim).applyAxisAngle(caster.up, half * 0.5).normalize();
          g.effects.slashArc(caster.position, caster.up, right, range, bladeArc, 0xffb3d1, {
            dur: 0.34, spin: 1, inner: 0.42, lift: SCYTHE_LIFT,
          });
          g.effects.slashArc(caster.position, caster.up, right, range, bladeArc * 0.72, 0xffffff, {
            dur: 0.34, spin: 1, inner: 0.74, lift: SCYTHE_LIFT + 0.2,
          });
          // sparks thrown off the point of each blade as it runs in to the middle, at the same height
          for (let i = 0; i < 9; i++) {
            this.schedule(i * 0.032, () => {
              const side = i < 5 ? -1 : 1;
              const ang = side * (0.5 - (i % 5) / 4) * half;
              const dir = _v.copy(aim).applyAxisAngle(caster.up, ang).normalize();
              _v2.copy(caster.position).addScaledVector(dir, range * 0.88).addScaledVector(caster.up, SCYTHE_LIFT);
              g.effects.burst(_v2, i % 3 === 0 ? 0xffffff : 0xffb3d1, {
                count: 5, speed: 8, life: 0.32, size: 0.5, gravity: 5, drag: 1.3,
              });
            });
          }
          g.effects.shake(0.16);
          g.audio.sfx('skill', 0.8);
        }
        // the sweep leaves a bleeding wound (burn DoT) on everything it touches
        if (applyDmg) this.cone(caster, aim, Math.cos(halfAngle), range, 2.6, { status: 'burn', statusPower: 6 });
        // ...and DRAGS what it caught on to the centre lane, so the two blades genuinely pile the
        // survivors into one line to be finished off.
        //
        // The lane is the aim line (`aim x up`), which is exactly where the two blades overlap. The
        // BODY is carried on to it, tick by tick — a one-shot velocity impulse is scrubbed away by the
        // creature's own steering within a few frames (measured on the Fortress drag and the Spinner
        // whirl, which move the body for the same reason), so shoving alone moved nothing.
        if (applyDmg) {
          const lane = _v3.copy(aim).cross(caster.up).normalize();
          const cosCone = Math.cos(halfAngle);
          const victims: Enemy[] = [];
          for (const e of g.enemies.query(caster.position.x, caster.position.y, caster.position.z, range + 4, this.tmpE)) {
            if (!e.alive) continue;
            const reach = range + e.radius;
            if (e.position.distanceToSquared(caster.position) > reach * reach) continue;
            _v.copy(e.position).sub(caster.position).normalize();
            if (_v.dot(aim) < cosCone) continue;         // outside the arc: the blades never touched it
            victims.push(e);
          }
          // own copy of the lane: the callbacks below outlive this frame, and _v3 is shared scratch
          const laneDir = lane.clone();
          for (let i = 0; i < 10; i++) {
            this.schedule(i * 0.045, () => {
              for (const e of victims) {
                if (!e.alive) continue;
                // lateral offset of the body from the lane, measured on the surface plane
                _v.copy(e.position).sub(caster.position);
                _v.addScaledVector(caster.up, -_v.dot(caster.up));
                const off = _v.dot(laneDir);
                if (Math.abs(off) < 0.6) continue;       // already in the lane
                const weight = e.isBoss ? 0.35 : e.isNamed ? 0.6 : 1;
                const step = Math.min(Math.abs(off) * 0.34, 0.85) * weight;
                e.position.addScaledVector(laneDir, -Math.sign(off) * step);
                g.planet.projectToSurface(e.position);
                e.up.copy(e.position).normalize();
                // and its sideways momentum is cancelled, or its own steering walks it straight back out
                const lateral = e.velocity.dot(laneDir);
                if (lateral !== 0) e.velocity.addScaledVector(laneDir, -lateral);
              }
            });
          }
        }
        break;
      }
      case 'reap': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        const centre = this.s2.copy(caster.position).clone();
        if (fx) {
          this.telegraph(centre, caster.up, radius, 0xff6b9d, 0.2, false);
          g.effects.ring(centre, caster.up, 1.2, 0xff6b9d, 0.9, 4.2, 1);
          g.effects.disk(centre, caster.up, radius, 0xff6b9d, 0.7, 1.1, 0.3);
          g.effects.burst(centre, 0xff6b9d, { count: 50, speed: 14, life: 0.9, size: 0.85, gravity: 0 });
          g.effects.shake(0.4);
        }
        if (applyDmg) {
          // execute low-hp targets; bosses take heavy damage. Every execution refunds the ult.
          let executed = 0;
          const list = g.enemies.query(centre.x, centre.y, centre.z, radius + 3, this.tmpE);
          for (const e of list) {
            if (!e.alive) continue;
            const rr = radius + e.radius;
            if (e.position.distanceToSquared(centre) > rr * rr) continue;
            if (e.isBoss) g.hitEnemy(e, this.abilityDamage(caster, 4.0), caster.id, 'ult');
            else if (e.hp < e.maxHp * 0.25) {
              g.hitEnemy(e, 999999, caster.id, 'ult');
              executed++;
              if (fx) {
                g.effects.burst(e.position, 0xff6b9d, { count: 26, speed: 16, life: 0.6, size: 0.9, gravity: 6 });
                g.effects.beam(centre, e.position, 0xffb3d1, 0.3, 0.3, 0.9);
              }
            } else g.hitEnemy(e, this.abilityDamage(caster, 1.4), caster.id, 'ult');
          }
          if (executed > 0) {
            caster.heal(executed * 14);
            caster.ultCd = Math.max(0, caster.ultCd - caster.ultCdMax * 0.4 * executed);
            if (fx) g.effects.ring(centre, caster.up, 1, 0x4dffa6, 0.7, 3.4, 0.9);
            if (caster.isLocal) g.ui.toast(`${executed} EXECUTED — REAP REFUNDED`, 2200);
          }
        }
        // The strike is instant, but the HARVEST LINGERS: the ground it claimed stays marked and
        // keeps giving up souls for the full ultimate duration, so Reap has a presence on the field
        // like every other ultimate instead of a single frame of pink.
        if (fx) {
          const dur = caster.ultDuration;
          g.effects.disk(centre, caster.up, radius, 0xff6b9d, dur, 1.0, 0.1);
          g.effects.ring(centre, caster.up, radius * 0.2, 0xff6b9d, dur, 5, 0.35);
          for (let i = 0; i < Math.max(1, Math.round(dur / 0.45)); i++) {
            this.schedule(i * 0.45, () => {
              tangentBasis(caster.up, _v, _v2);
              const ang = Math.random() * Math.PI * 2;
              const rr = radius * (0.2 + Math.random() * 0.72);
              _v3.copy(centre)
                .addScaledVector(_v, Math.cos(ang) * rr)
                .addScaledVector(_v2, Math.sin(ang) * rr)
                .addScaledVector(caster.up, 0.2);
              g.effects.burst(_v3, 0xffb3d1, {
                count: 4, speed: 3.4, life: 1.1, size: 0.42,
                up: caster.up, spread: 0.35, gravity: -6, drag: 1.1,
              });
            });
          }
        }
        break;
      }
      // ------------------------------------------------ Necromutation perks (movement powers)
      case 'quakefall': {
        // Quakefall: the LANDING is the attack. The wave walks out to exactly the radius the damage
        // covers (see Effects.wave) and the knockback is what clears the ground that was just won —
        // a leap into a pack is now an entrance, not a mistake.
        // The radius is deliberately generous (9 m base, +1.4 m per extra stack — widened from
        // 6.2 / 1.1 per the 2026-09 request): this fires on EVERY leap landing, so it has to
        // visibly clear a pack, and the knock is the payoff.
        const stacks = Math.max(1, caster.mods.landShock);
        const radius = 9 + 1.4 * (stacks - 1);
        if (fx) {
          g.effects.disk(caster.position, caster.up, radius, 0x8a5a2b, 0.42, 1.05, 0.3);
          g.effects.ring(caster.position, caster.up, 0.9, col, 0.5, 3.4, 0.95);
          g.effects.wave(caster.position, caster.up, radius, 0xd9b07a, { dur: 0.6, rings: 3, debris: 46 });
          g.effects.burst(caster.position, 0xd9b07a, { count: 34, speed: 16, life: 0.6, size: 0.8, gravity: 11 });
          g.effects.shake(0.26);
          g.audio.sfx('explode', 0.5);
        }
        if (applyDmg) this.aoe(caster, caster.position, radius, 1.1 + 0.4 * (stacks - 1), { knockback: 26, knockUp: 6.5 });
        break;
      }
      case 'lavapool': {
        // Molten Wake: one burning pool dropped where the runner passed. The pool is FIXED in the
        // world — the caster keeps running — so its centre and normal are captured here, and the
        // visual is the same lava floor Supernova turns the ground into, scaled down. Pools are
        // dropped every ~2.2 m (see Player.updateLocal) and live 1.5 s, so the tail still overlaps
        // the new ones: the perk reads as a river of fire instead of a dotted line. The per-tick
        // damage is scaled down with the density, so what a body standing in the trail takes per
        // second stays in the same band — more pools, not more damage per pool.
        const stacks = Math.max(1, caster.mods.lavaWake);
        const centre = caster.position.clone();
        const up = caster.up.clone();
        const radius = 2.2 + 0.3 * (stacks - 1);
        const dur = 1.5;
        const pct = 0.15 + 0.055 * (stacks - 1);
        if (fx) this.lavaFloor(centre, up, radius, dur);
        const tick = 0.5;
        const ticks = Math.max(1, Math.round(dur / tick));
        for (let i = 1; i <= ticks; i++) {
          this.schedule(i * tick, () => {
            if (!applyDmg) return;
            const dmg = this.abilityDamage(caster, pct);
            const list = g.enemies.query(centre.x, centre.y, centre.z, radius + 3, this.tmpE);
            for (const e of list) {
              if (!e.alive) continue;
              const rr = radius + e.radius;
              if (e.position.distanceToSquared(centre) > rr * rr) continue;
              g.hitEnemy(e, dmg, caster.id, 'dot');
              e.applyStatus('burn', 5 + stacks * 2, caster.id);
            }
          });
        }
        break;
      }
      case 'echo': {
        // Echo Decoy: the double lands where the dash BEGAN, so the horde is pulled back off the
        // runner. Every peer spawns its own ghost (that is what gets seen); the taunt and the
        // detonation are the host's, because the host is the machine that runs the swarm.
        if (!caster.alive) break;
        const at = caster.position.clone();
        const up = caster.up.clone();
        const facing = caster.facing.clone();
        g.decoys.spawn(caster, Math.max(1, caster.mods.decoy), at, up, facing);
        if (fx) {
          g.effects.ring(at, up, 0.9, col, 0.4, 2.4, 0.8);
          g.effects.burst(at, col, { count: 16, speed: 8, life: 0.5, size: 0.6, gravity: 2 });
        }
        break;
      }
      // ------------------------------------------------ map pad: BLITZ
      case 'blitz': {
        // the energy cube bursts: everything around the runner is thrown back and set alight
        const radius = CONFIG.pads.blitzRadius;
        if (fx) {
          g.effects.disk(caster.position, caster.up, radius, 0xffc24d, 0.55, 1.2, 0.42);
          g.effects.ring(caster.position, caster.up, 1.2, 0xffe6a8, 0.6, 4.6, 1);
          g.effects.burst(caster.position, 0xffc24d, { count: 60, speed: 22, life: 0.8, size: 0.8, gravity: 6 });
          g.effects.shake(0.4);
          g.audio.sfx('explode', 0.75);
        }
        if (applyDmg) {
          this.aoe(caster, caster.position, radius, CONFIG.pads.blitzBurstPct, {
            knockback: 18, status: 'burn', statusPower: 8,
          });
        }
        break;
      }
      // ------------------------------------------------ NOVA (Detonator)
      case 'pulsering': {
        const a = caster.necrotech.skill.aim;
        const radius = rad(a);
        if (fx) {
          // The wave IS the ability: a full-field disc under it, a white-hot core flash, then a real
          // shock front that walks out to EXACTLY the ring it damages — the pulses stop dead there
          // (see Effects.wave), so the picture can never overstate the hit area.
          g.effects.disk(caster.position, caster.up, radius, col, 0.5, 1.05, 0.24);
          g.effects.ring(caster.position, caster.up, 1, 0xd8fff4, 0.4, 3.4, 0.95);
          g.effects.wave(caster.position, caster.up, radius, col, { dur: 0.58, rings: 3, debris: 46 });
          g.effects.burst(caster.position, 0xd8fff4, { count: 30, speed: 15, life: 0.5, size: 0.7, gravity: 0 });
          // the shell: a spray thrown UP and outward off the front, so the nova has height
          g.effects.burst(caster.position, col, {
            count: 22, speed: 11, life: 0.6, size: 0.6, up: caster.up, spread: 0.8, gravity: 6, drag: 1.2,
          });
          g.effects.shake(0.24);
        }
        if (applyDmg) this.aoe(caster, caster.position, radius, 2.0, { knockback: 8 });
        // Resonance passive: the ring pulses a second time for half
        this.schedule(0.45, () => {
          if (fx) {
            g.effects.wave(caster.position, caster.up, radius * 0.88, col, { dur: 0.5, rings: 2, debris: 30, alpha: 0.75 });
            g.effects.burst(caster.position, 0x9dfff0, { count: 18, speed: 12, life: 0.45, size: 0.6, gravity: 0 });
          }
          if (applyDmg) this.aoe(caster, caster.position, radius * 0.88, 1.0);
        });
        break;
      }
      case 'supernova': {
        const a = caster.necrotech.ult.aim;
        const radius = rad(a);
        // the ground stays molten for the whole ultimate duration
        const dur = caster.ultDuration;
        // The star is the whole visual: it hangs over the pool, implodes for ~0.55 s and then goes
        // off. The damage and the explosion land on ITS burst, so the hit always matches the picture.
        const starDur = 1.22;
        const burstAt = starDur * 0.45;
        if (fx) {
          // First the ground goes molten — crust, orange flow, white-hot core — and it stays molten
          // through the blast, so the burst reads as the star going off INSIDE a lava pool.
          this.lavaFloor(caster.position, caster.up, radius, dur);
          this.telegraph(caster.position, caster.up, radius, col, 0.4);
          g.effects.supernovaStar(caster.position, caster.up, radius, col, starDur);
          this.schedule(burstAt, () => {
            g.effects.shake(0.85);
            g.audio.sfx('explode');
          });
        }
        if (mode === 'caster') caster.heal(caster.maxHp * 0.2);
        this.schedule(burstAt, () => {
          if (applyDmg) this.aoe(caster, caster.position, radius, 5.4, { knockback: 14, status: 'burn', statusPower: 12 });
        });
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ Necrotech Burst

  /**
   * Necrotech Burst. `rangeMul` is a multiple of the caster's auto-attack range — 2 for a
   * Necrotech upgrade, 1 for a Necromutation (perk) burst.
   */
  burst(p: Player, mode: CastMode, rangeMul = CONFIG.burstRangeMul): void {
    const g = this.game;
    const radius = p.autoRange * rangeMul * p.mods.burstMul;
    const col = p.necrotechColor;
    g.effects.ring(p.position, p.up, 1.5, col, 0.7, radius / 1.5, 1);
    g.effects.disk(p.position, p.up, radius, col, 0.5, 1.1, 0.3);
    g.effects.burst(p.position, col, { count: rangeMul > 1 ? 44 : 30, speed: 20, life: 0.8, size: 0.85, gravity: 6 });
    g.effects.shake(rangeMul > 1 ? 0.42 : 0.3);
    g.audio.sfx('mutation', 0.9);

    const dmgSource = g.isHost && mode !== 'remote';
    if (!dmgSource) return;

    const list = g.enemies.query(p.position.x, p.position.y, p.position.z, radius + 4, this.tmpE);
    for (const e of list) {
      if (!e.alive) continue;
      const rr = radius + e.radius;
      if (e.position.distanceToSquared(p.position) > rr * rr) continue;
      if (e.small) {
        g.hitEnemy(e, 999999, p.id, 'burst');
      } else if (e.isBoss) {
        g.hitEnemy(e, p.autoDamage * 12 * p.mods.burstMul, p.id, 'burst');
      } else {
        g.hitEnemy(e, p.autoDamage * 7 * p.mods.burstMul, p.id, 'burst');
      }
    }
    // enemy colony players take exactly 2x the caster's normal auto-attack damage
    const pvpDamage = p.autoDamage * 2;
    for (const pl of g.players.values()) {
      if (pl === p || !pl.alive || pl.colony === p.colony) continue;
      const rr = radius + 1.3;
      if (pl.position.distanceToSquared(p.position) > rr * rr) continue;
      g.hitPlayer(pl, pvpDamage, p.id, 'burst');
    }
  }
}
