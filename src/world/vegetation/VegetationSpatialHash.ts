// NECROFALL — the vegetation spatial hash (plan §42): a lat/lon cell grid over the sphere so the
// world can answer "what is near this direction / between these two points" without walking every
// object. Used by the generator (minimum separation), the visibility system (cell streaming) and
// the occlusion system (candidate shortlists).
import * as THREE from 'three/webgpu';

export interface SpatialItem {
  /** Unit surface direction of the item. */
  dir: THREE.Vector3;
}

const LAT_BINS = 64;
const LON_BINS = 128;

function binOf(dir: THREE.Vector3, out: { lat: number; lon: number }): void {
  const inv = 1 / Math.max(1e-9, dir.length());
  const y = dir.y * inv;
  out.lat = Math.min(LAT_BINS - 1, Math.max(0, Math.floor(((y + 1) * 0.5) * LAT_BINS)));
  const lon = Math.atan2(dir.z * inv, dir.x * inv);
  out.lon = Math.min(LON_BINS - 1, Math.max(0, Math.floor((lon / (Math.PI * 2) + 0.5) * LON_BINS)));
}

export class VegetationSpatialHash<T extends SpatialItem> {
  private readonly cells = new Map<number, T[]>();
  private readonly bin = { lat: 0, lon: 0 };

  insert(item: T): void {
    binOf(item.dir, this.bin);
    const key = this.bin.lat * LON_BINS + this.bin.lon;
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(item);
  }

  /**
   * Collect every item whose cell is within `angularRadius` of `dir`. The cell window is
   * conservative — callers should still verify the exact angle when it matters (the generator
   * does; occlusion does not care about a few extra candidates).
   */
  query(dir: THREE.Vector3, angularRadius: number, out: T[]): T[] {
    out.length = 0;
    binOf(dir, this.bin);

    // Cell size in radians: ~π/LAT_BINS vertical, 2π/LON_BINS horizontal (at the equator).
    const latSpan = Math.PI / LAT_BINS;
    const lonSpan = (Math.PI * 2) / LON_BINS;
    const latRadius = Math.ceil(angularRadius / latSpan) + 1;
    const latCenter = Math.acos(Math.max(-1, Math.min(1, dir.clone().normalize().y)));

    for (let di = -latRadius; di <= latRadius; di++) {
      const lat = this.bin.lat + di;
      if (lat < 0 || lat >= LAT_BINS) continue;
      // Longitude window widens towards the poles (cells shrink there).
      const latAngle = (lat + 0.5) / LAT_BINS * Math.PI;
      const shrink = Math.max(0.15, Math.sin(Math.max(0.15, Math.min(Math.PI - 0.15, latAngle))));
      const lonRadius = Math.ceil(angularRadius / (lonSpan * shrink)) + 1;
      for (let dj = -lonRadius; dj <= lonRadius; dj++) {
        const lon = ((this.bin.lon + dj) % LON_BINS + LON_BINS) % LON_BINS;
        const bucket = this.cells.get(lat * LON_BINS + lon);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  /** Number of registered items (telemetry). */
  get size(): number {
    let n = 0;
    for (const bucket of this.cells.values()) n += bucket.length;
    return n;
  }

  clear(): void {
    this.cells.clear();
  }
}

/** Angular distance helper (radians) between two unit directions. */
export function angularDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
}
