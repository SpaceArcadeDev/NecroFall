import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export const VORTEX = { height: 16, baseRadius: 1.2, flare: 3.7, exponent: 1.5, sway: 1.5, bend: 5, frequency: 0.25 } as const;

export function vortexRadiusAt(height: number): number {
  return VORTEX.baseRadius + MathUtils.clamp(height / VORTEX.height, 0, 1) ** VORTEX.exponent * VORTEX.flare;
}

export function vortexSwayAt(height: number, time: number): number {
  const fraction = MathUtils.clamp(height / VORTEX.height, 0, 1);
  return Math.sin(fraction * VORTEX.bend + time * VORTEX.frequency) * fraction * VORTEX.sway;
}

type HazardKind = 'quicksand' | 'vortex' | 'whirlpool' | 'blizzard';

interface HazardBody {
  alive: boolean;
  grounded: boolean;
  position: Vector3;
  velocity: Vector3;
  edgeBoost(direction: Vector3, speed: number, lift: number): void;
}

export interface PlanetHazard {
  kind: HazardKind;
  position: Vector3;
  radius: number;
  height: number;
  frame?: Matrix4;
  inverseFrame?: Matrix4;
}

export class PlanetHazards {
  readonly sites: PlanetHazard[] = [];
  private readonly cooldowns = new WeakMap<HazardBody, number>();
  private readonly up = new Vector3();
  private readonly outward = new Vector3();
  private readonly tangent = new Vector3();
  private readonly local = new Vector3();

  constructor(private readonly radiusAt: (direction: Vector3) => number, private readonly time: () => number = () => 0) {}

  add(kind: HazardKind, position: Vector3, radius: number, height: number, frame?: Matrix4): void {
    const transform = kind === 'vortex' ? frame?.clone() ?? new Matrix4().compose(position,
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), position.clone().normalize()),
      new Vector3().setScalar(height / VORTEX.height)) : undefined;
    this.sites.push({ kind, position: position.clone(), radius, height, frame: transform, inverseFrame: transform?.clone().invert() });
  }

  private touchesVortex(site: PlanetHazard, position: Vector3): boolean {
    const bodyRadius = 0.3 / site.frame!.getMaxScaleOnAxis();
    for (const height of [0.25, 0.95, 1.65]) {
      this.local.copy(position).addScaledVector(this.up, height).applyMatrix4(site.inverseFrame!);
      if (this.local.y < 0 || this.local.y > VORTEX.height) continue;
      const radius = vortexRadiusAt(this.local.y) + bodyRadius;
      this.local.x -= vortexSwayAt(this.local.y, this.time());
      if (this.local.x * this.local.x + this.local.z * this.local.z > radius * radius) continue;
      this.outward.set(this.local.x, 0, this.local.z).transformDirection(site.frame!);
      return true;
    }
    return false;
  }

  blocksVegetation(positionX: number, positionY: number, positionZ: number): boolean {
    const length = Math.hypot(positionX, positionY, positionZ) || 1;
    return this.sites.some(site => {
      if (site.kind !== 'quicksand' && site.kind !== 'vortex') return false;
      const radius = site.kind === 'vortex' ? VORTEX.baseRadius * site.frame!.getMaxScaleOnAxis() : site.radius;
      return (positionX * site.position.x + positionY * site.position.y + positionZ * site.position.z) / (length * site.position.length())
        > Math.cos(radius * 0.92 / site.position.length());
    });
  }

  apply(body: HazardBody, delta: number): number {
    const cooldown = Math.max(0, (this.cooldowns.get(body) ?? 0) - delta);
    this.cooldowns.set(body, cooldown);
    if (!body.alive || !this.sites.length) return 1;
    this.up.copy(body.position).normalize();
    const altitude = body.position.length() - this.radiusAt(this.up);
    let speed = 1;
    for (const site of this.sites) {
      if (site.kind === 'vortex') {
        if ((this.cooldowns.get(body) ?? 0) > 0 || !this.touchesVortex(site, body.position)) continue;
        this.outward.addScaledVector(this.up, -this.outward.dot(this.up));
        if (this.outward.lengthSq() < 0.01) {
          this.outward.set(Math.abs(this.up.y) > 0.9 ? 1 : 0, Math.abs(this.up.y) > 0.9 ? 0 : 1, 0).cross(this.up);
        }
        this.outward.normalize();
        this.tangent.crossVectors(this.up, this.outward).normalize();
        this.outward.addScaledVector(this.tangent, 0.45).normalize();
        body.edgeBoost(this.outward, 26, 32);
        this.cooldowns.set(body, 1.8);
      } else if (body.grounded) {
        if (altitude < -0.5 || altitude > site.height) continue;
        const cosine = this.up.dot(site.position) / site.position.length();
        const distance = Math.acos(MathUtils.clamp(cosine, -1, 1)) * site.position.length();
        if (distance >= site.radius) continue;
        const strength = 1 - MathUtils.smoothstep(distance / site.radius, 0.65, 1);
        const minimum = site.kind === 'quicksand' ? 0.3 : site.kind === 'whirlpool' ? 0.5 : 0.65;
        speed = Math.min(speed, 1 - (1 - minimum) * strength);
      }
    }
    if (!body.grounded) return 1;
    if (speed < 1) {
      this.tangent.copy(body.velocity).addScaledVector(this.up, -body.velocity.dot(this.up));
      body.velocity.addScaledVector(this.tangent, Math.exp(-delta * 9 * (1 - speed)) - 1);
    }
    return speed;
  }
}