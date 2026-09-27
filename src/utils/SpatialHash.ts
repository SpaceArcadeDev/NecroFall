// NECROFALL — spherical spatial hash (uniform 3D grid, rebuilt per frame).
import * as THREE from 'three';

export interface HasPosition {
  position: THREE.Vector3;
}

export class SpatialHash<T extends HasPosition> {
  private cell: number;
  private map = new Map<number, T[]>();
  private scratch: T[] = [];

  constructor(cellSize = 10) {
    this.cell = cellSize;
  }

  private static key(cx: number, cy: number, cz: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0;
  }

  clear(): void {
    // Reuse the bucket arrays to avoid per-frame allocations.
    for (const arr of this.map.values()) arr.length = 0;
  }

  insert(item: T): void {
    const p = item.position;
    const c = this.cell;
    const k = SpatialHash.key(Math.floor(p.x / c), Math.floor(p.y / c), Math.floor(p.z / c));
    let arr = this.map.get(k);
    if (!arr) {
      arr = [];
      this.map.set(k, arr);
    }
    arr.push(item);
  }

  /** Collects candidate items in the bounding cube around the query point. Callers must do exact distance checks. */
  query(x: number, y: number, z: number, r: number, out: T[]): T[] {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const arr = this.map.get(SpatialHash.key(cx, cy, cz));
          if (arr) for (let i = 0; i < arr.length; i++) out.push(arr[i]);
        }
      }
    }
    return out;
  }

  /** Scratch array usable as query output (not reentrant). */
  tmp(): T[] {
    return this.scratch;
  }
}
