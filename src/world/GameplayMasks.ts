// NECROFALL — GAMEPLAY MASKS (rework plan §61).
//
// Procedural environment generation must understand where the GAME lives:
//
//     spawn zones · Beacon zones · Nexus zone · boss arenas · pads · fortresses
//
// Every placement system consults these masks before committing an instance, so a tree can never
// grow out of a Beacon pad and a boulder can never block a spawn. Terrain itself is NEVER flattened
// for these locations (plan §62) — the mask only suppresses *environment objects*.
import * as THREE from 'three';

interface ClearZone {
  dir: THREE.Vector3;
  cosRadius: number;
}

export class GameplayMasks {
  private zones: ClearZone[] = [];
  private static readonly _d = new THREE.Vector3();

  constructor(private readonly radius: number) {}

  /** Registers a cleared disc around a surface direction (radius in world metres). */
  addClear(dir: THREE.Vector3, radiusWorld: number): void {
    this._tmp.copy(dir).normalize();
    this.zones.push({
      dir: this._tmp.clone(),
      cosRadius: Math.cos(Math.max(0, radiusWorld) / this.radius),
    });
  }

  private readonly _tmp = new THREE.Vector3();

  /** True when a direction is outside every cleared zone (placement allowed). */
  isClear(dir: THREE.Vector3): boolean {
    const d = GameplayMasks._d.copy(dir).normalize();
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      if (d.dot(z.dir) > z.cosRadius) return false;
    }
    return true;
  }

  /** True when inside a cleared zone (used by structures looking for "settled" ground). */
  inClearZone(dir: THREE.Vector3): boolean {
    return !this.isClear(dir);
  }

  get count(): number {
    return this.zones.length;
  }

  clear(): void {
    this.zones.length = 0;
  }
}
