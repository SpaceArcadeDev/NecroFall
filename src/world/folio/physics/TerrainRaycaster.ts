// NECROFALL — TerrainRaycaster (plan §26): analytic terrain raycasts against the SAME field the
// simulation and the render mesh agree on. Cheaper than any collider mesh and works everywhere
// on the planet, including for objects that never get a physics body (vegetation placement, aim,
// projectile impacts, water queries).
import * as THREE from 'three/webgpu';
import type { TerrainSurface } from '../../TerrainSurface';

export interface TerrainHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export class TerrainRaycaster {
  private readonly probe = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  constructor(private readonly surface: TerrainSurface) {}

  /**
   * March the ray and bisect the first sign change of (|p| − terrainHeight). Returns null when
   * the ray never meets the ground inside `maxT`.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxT = 420, steps = 72, out?: TerrainHit): TerrainHit | null {
    const sample = (t: number): number => {
      this.probe.copy(origin).addScaledVector(direction, t);
      const len = this.probe.length();
      if (len < 1e-4) return -1;
      const inv = 1 / len;
      return len - this.surface.heightAtDir(this.probe.x * inv, this.probe.y * inv, this.probe.z * inv);
    };

    let above = sample(0) > 0;
    let tPrev = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxT;
      const aboveNow = sample(t) > 0;
      if (aboveNow !== above) {
        let a = tPrev;
        let b = t;
        for (let k = 0; k < 14; k++) {
          const m = (a + b) * 0.5;
          if ((sample(m) > 0) === above) a = m;
          else b = m;
        }
        const hitT = (a + b) * 0.5;
        const point = (out?.point ?? new THREE.Vector3()).copy(origin).addScaledVector(direction, hitT);
        const dir = this.probe.copy(point).normalize();
        const hit: TerrainHit = out ?? { point, normal: new THREE.Vector3(), distance: 0 };
        this.surface.normalAtDir(dir.x, dir.y, dir.z, hit.normal);
        hit.distance = hitT;
        return hit;
      }
      above = aboveNow;
      tPrev = t;
    }
    return null;
  }

  /** Ground point below a world position (radial projection, with the terrain normal). */
  groundAt(position: THREE.Vector3, out: TerrainHit): TerrainHit {
    const len = Math.max(1e-4, position.length());
    const dir = this.probe.copy(position).multiplyScalar(1 / len);
    const h = this.surface.heightAtDir(dir.x, dir.y, dir.z);
    out.point.copy(dir).multiplyScalar(h);
    out.distance = len - h;
    this.surface.normalAtDir(dir.x, dir.y, dir.z, out.normal);
    return out;
  }

  /** Squared distance from a point to the terrain surface (negative = below ground). */
  signedElevation(position: THREE.Vector3): number {
    const len = Math.max(1e-4, position.length());
    const inv = 1 / len;
    const h = this.surface.heightAtDir(position.x * inv, position.y * inv, position.z * inv);
    return len - h;
  }

  get normalScratch(): THREE.Vector3 {
    return this.normal;
  }
}
