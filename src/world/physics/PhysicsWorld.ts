// NECROFALL — PHYSICS WORLD (rework plan §21/§22/§23/§58).
//
// A deliberately small physics layer for the ENVIRONMENT (gameplay bodies — players, enemies,
// projectiles — keep their specialised integrators; this world exists for props and debris).
//
// Three categories, exactly as the plan asks (§21):
//
//     STATIC   terrain (the collider) · large rocks · trees · structures   — never stepped
//     SENSOR   interaction zones · water · triggers                        — queried, never stepped
//     DYNAMIC  loose crates · debris · objects pushed by explosions        — stepped with LOD
//
// Physics LOD (§23) comes from the focus distance: full contact inside `physicsRadius`, coarse
// cadence out to twice that, and total sleep beyond it. Nothing the player cannot reach ever
// costs a step.
import * as THREE from 'three';
import { SurfaceCollider } from './SurfaceCollider';
import type { EnvironmentProfile } from '../EnvironmentConfig';

export const PHYS_STATIC = 0;
export const PHYS_SENSOR = 1;
export const PHYS_DYNAMIC = 2;
export type PhysicsLayers = typeof PHYS_STATIC | typeof PHYS_SENSOR | typeof PHYS_DYNAMIC;

export interface PhysicsBody {
  id: number;
  layer: PhysicsLayers;
  kind: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Collision radius (sphere approximation — props are chunky, this reads fine). */
  radius: number;
  /** Visual scale multiplier applied by the renderer. */
  scale: number;
  mass: number;
  restitution: number;
  friction: number;
  /** Resting bodies skip integration until something wakes them. */
  sleeping: boolean;
  /** Lifespan for debris (-1 = permanent until removed). */
  life: number;
  /** Room to attach renderer slots (debris instance index etc.). */
  userData: number;
}

const _down = new THREE.Vector3();
const _contact = new THREE.Vector3();

export class PhysicsWorld {
  readonly collider: SurfaceCollider;
  private readonly bodies = new Map<number, PhysicsBody>();
  private nextId = 1;
  private profile: EnvironmentProfile;
  private focus: THREE.Vector3 | null = null;
  /** Statistical counters for telemetry (plan §65). */
  stepped = 0;
  sleeping = 0;

  constructor(collider: SurfaceCollider, profile: EnvironmentProfile) {
    this.collider = collider;
    this.profile = profile;
  }

  setProfile(profile: EnvironmentProfile): void {
    this.profile = profile;
    this.collider.setProfile(profile);
  }

  /** The nearest gameplay focus (usually the local player) drives physics LOD (§23). */
  setFocus(pos: THREE.Vector3 | null): void {
    this.focus = pos;
  }

  addBody(spec: Omit<PhysicsBody, 'id' | 'sleeping'>): PhysicsBody {
    const body: PhysicsBody = { ...spec, id: this.nextId++, sleeping: false };
    this.bodies.set(body.id, body);
    return body;
  }

  removeBody(id: number): void {
    this.bodies.delete(id);
  }

  get(id: number): PhysicsBody | undefined {
    return this.bodies.get(id);
  }

  /** Applies a radial impulse (explosion) to every DYNAMIC body within the radius (plan §24). */
  impulse(pos: THREE.Vector3, radius: number, strength: number): void {
    this.bodies.forEach(body => {
      if (body.layer !== PHYS_DYNAMIC) return;
      _down.copy(body.position).sub(pos);
      const dist = _down.length();
      if (dist > radius + body.radius || dist < 1e-4) return;
      _down.multiplyScalar(1 / dist);
      const falloff = 1 - Math.min(1, dist / radius);
      body.velocity.addScaledVector(_down, strength * falloff);
      // pop upward a touch so debris arcs instead of sliding
      body.velocity.addScaledVector(body.position, 0.25 * falloff);
      body.sleeping = false;
      if (body.life > 0 && body.life < 2) body.life = 2 + falloff * 1.5;
    });
  }

  /** Sphere query over SENSOR + DYNAMIC bodies (interaction zones — plan §21). */
  queryNearby(pos: THREE.Vector3, radius: number, cb: (body: PhysicsBody) => void): void {
    const r2 = radius * radius;
    this.bodies.forEach(body => {
      if (body.layer === PHYS_STATIC) return;
      if (body.position.distanceToSquared(pos) <= r2) cb(body);
    });
  }

  /**
   * Steps DYNAMIC bodies at the cadence their distance allows. `frame` lets coarse bodies update
   * every other call without a timer (plan §23).
   */
  step(dt: number, frame: number): void {
    this.stepped = 0;
    this.sleeping = 0;
    this.bodies.forEach(body => {
      if (body.layer !== PHYS_DYNAMIC) return;
      if (body.life > 0) {
        body.life -= dt;
        if (body.life <= 0) {
          this.bodies.delete(body.id);
          if (body.userData >= 0) this.onDespawn?.(body);
          return;
        }
      }
      const dist = this.collider.distanceToFocus(body.position, this.focus);
      const cadence = this.collider.cadence(dist);
      if (cadence === 2) {
        body.sleeping = true;
        this.sleeping++;
        return;
      }
      if (cadence === 1 && (frame & 1) === 1) {
        this.sleeping++;
        return;
      }
      if (body.sleeping) {
        // wake when the player gets near — the body may need to be kicked again
        if (dist < this.profile.physicsRadius * 0.9) body.sleeping = false;
        else {
          this.sleeping++;
          return;
        }
      }
      this.integrate(body, dt, cadence === 0);
    });
  }

  private integrate(body: PhysicsBody, dt: number, full: boolean): void {
    this.stepped++;
    // gravity toward the planet centre
    _down.copy(body.position).normalize().multiplyScalar(-1);
    body.velocity.addScaledVector(_down, 22 * dt);
    body.position.addScaledVector(body.velocity, dt);

    // ground contact
    const h = this.collider.heightAt(body.position) + body.radius;
    const len = body.position.length();
    if (len < h) {
      body.position.multiplyScalar(h / Math.max(1e-5, len));
      // contact normal ≈ radial
      _contact.copy(body.position).normalize();
      const vn = body.velocity.dot(_contact);
      if (vn < 0) {
        body.velocity.addScaledVector(_contact, -vn * (1 + body.restitution));
      }
      if (full) {
        // friction + rolling resistance
        const damp = Math.max(0, 1 - body.friction * dt * 4);
        body.velocity.multiplyScalar(damp);
        if (body.velocity.lengthSq() < 0.05) {
          body.velocity.set(0, 0, 0);
          body.sleeping = true;
        }
      }
    }
    // hard cap so nothing escapes the planet
    if (body.position.length() > this.collider.heightAt(body.position) + 60) {
      body.sleeping = true;
      body.velocity.set(0, 0, 0);
    }
  }

  /** Renderer hook: called when a temporary body expires. */
  onDespawn: ((body: PhysicsBody) => void) | null = null;

  stats(): { bodies: number; stepped: number; sleeping: number } {
    return { bodies: this.bodies.size, stepped: this.stepped, sleeping: this.sleeping };
  }

  clear(): void {
    this.bodies.clear();
  }

  get bodyCount(): number {
    return this.bodies.size;
  }
}
