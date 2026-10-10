import { MathUtils, Vector3 } from 'three/webgpu';

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
}

export class PlanetHazards {
  readonly sites: PlanetHazard[] = [];
  private readonly cooldowns = new WeakMap<HazardBody, number>();
  private readonly up = new Vector3();
  private readonly outward = new Vector3();
  private readonly tangent = new Vector3();

  constructor(private readonly radiusAt: (direction: Vector3) => number) {}

  add(kind: HazardKind, position: Vector3, radius: number, height: number): void {
    this.sites.push({ kind, position: position.clone(), radius, height });
  }

  blocksVegetation(positionX: number, positionY: number, positionZ: number): boolean {
    const length = Math.hypot(positionX, positionY, positionZ) || 1;
    return this.sites.some(site => (site.kind === 'quicksand' || site.kind === 'vortex')
      && (positionX * site.position.x + positionY * site.position.y + positionZ * site.position.z) / (length * site.position.length())
        > Math.cos(site.radius * 0.92 / site.position.length()));
  }

  apply(body: HazardBody, delta: number): number {
    const cooldown = Math.max(0, (this.cooldowns.get(body) ?? 0) - delta);
    this.cooldowns.set(body, cooldown);
    if (!body.alive || !this.sites.length) return 1;
    this.up.copy(body.position).normalize();
    const altitude = body.position.length() - this.radiusAt(this.up);
    let speed = 1;
    for (const site of this.sites) {
      if (altitude < -0.5 || altitude > site.height) continue;
      const cosine = this.up.dot(site.position) / site.position.length();
      const distance = Math.acos(MathUtils.clamp(cosine, -1, 1)) * site.position.length();
      if (distance >= site.radius) continue;
      if (site.kind === 'vortex') {
        if ((this.cooldowns.get(body) ?? 0) > 0) continue;
        this.outward.copy(body.position).sub(site.position);
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