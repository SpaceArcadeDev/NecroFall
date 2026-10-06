/**
 * NECROFALL — baked planet surface data (plan §12/§63/§64).
 *
 * Two equirect RGBA8 maps EVERY environment shader reads, plus the raw height
 * grid. CPU-side placement uses the analytic generator; the GPU side reads
 * these textures — baked from the SAME estimates so both agree.
 *
 *   tex1: R height01 · G grass · B wetness · A radiation
 *   tex2: R rock    · G biome · B puddle  · A cave (plan §35)
 *
 * The bake is row-chunked and yields to the event loop, so the loading screen
 * keeps animating while the planet is measured.
 */
import * as THREE from 'three/webgpu';
import type { PlanetGenerator } from './PlanetGenerator';
import { yieldToMain } from '../utils/Yield';

export interface BakeProgress {
  (ratio: number, label: string): void;
}

/** Throttle-proof build yield (see utils/Yield.ts): a `setTimeout(0)` yield is clamped to 1 s+ in
 *  an occluded tab and stretched this bake from seconds to minutes behind the loading screen. */
const yieldToLoop = yieldToMain;

export class PlanetSurfaceData {
  static readonly WIDTH = 384;
  static readonly HEIGHT = 192;

  readonly width: number;
  readonly height: number;
  /** Unit direction per texel (3 floats). */
  readonly directions: Float32Array;
  /** Raw terrain radius per texel (metres from planet centre). */
  readonly heights: Float32Array;
  /** RGBA byte maps. */
  readonly channels1: Uint8Array;
  readonly channels2: Uint8Array;

  readonly tex1: THREE.DataTexture;
  readonly tex2: THREE.DataTexture;

  reliefMin = 0;
  reliefMax = 0;
  /** Radius of the local waterline. */
  waterLevel = 0;

  private constructor(private readonly generator: PlanetGenerator, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.directions = new Float32Array(width * height * 3);
    this.heights = new Float32Array(width * height);
    this.channels1 = new Uint8Array(width * height * 4);
    this.channels2 = new Uint8Array(width * height * 4);

    this.tex1 = new THREE.DataTexture(this.channels1, width, height, THREE.RGBAFormat);
    this.tex1.minFilter = THREE.LinearFilter;
    this.tex1.magFilter = THREE.LinearFilter;
    this.tex1.wrapS = THREE.RepeatWrapping;
    this.tex1.wrapT = THREE.ClampToEdgeWrapping;

    this.tex2 = new THREE.DataTexture(this.channels2, width, height, THREE.RGBAFormat);
    this.tex2.minFilter = THREE.LinearFilter;
    this.tex2.magFilter = THREE.LinearFilter;
    this.tex2.wrapS = THREE.RepeatWrapping;
    this.tex2.wrapT = THREE.ClampToEdgeWrapping;
  }

  static async bake(generator: PlanetGenerator, onProgress?: BakeProgress): Promise<PlanetSurfaceData> {
    const data = new PlanetSurfaceData(generator, PlanetSurfaceData.WIDTH, PlanetSurfaceData.HEIGHT);
    await data.bakeHeights(onProgress);
    await data.bakeChannels(onProgress);
    onProgress?.(1, 'planet ready');
    return data;
  }

  private async bakeHeights(onProgress?: BakeProgress): Promise<void> {
    const { width, height, directions, heights } = this;
    const generator = this.generator;
    let reliefMin = Infinity;
    let reliefMax = -Infinity;

    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const u = (ix + 0.5) / width;
        const v = (iy + 0.5) / height;
        const y = Math.cos(v * Math.PI);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const lon = (u - 0.5) * Math.PI * 2;
        const x = r * Math.cos(lon);
        const z = r * Math.sin(lon);

        const index = iy * width + ix;
        directions[index * 3] = x;
        directions[index * 3 + 1] = y;
        directions[index * 3 + 2] = z;

        const radius = generator.radiusAt(x, y, z);
        heights[index] = radius;
        // The WATERLINE is a surface law: measure relief on the un-carved surface (the carve is
        // added back), so caves deepen underground WITHOUT draining every surface lake — cave
        // floors below the line still read wet (underground pools), which is the wanted look.
        const surfaceRadius = radius + generator.caveDepthAt(x, y, z);
        if (surfaceRadius < reliefMin) reliefMin = surfaceRadius;
        if (surfaceRadius > reliefMax) reliefMax = surfaceRadius;
      }
      if (iy % 12 === 11) {
        await yieldToLoop();
        onProgress?.((iy / height) * 0.55, 'measuring terrain');
      }
    }

    this.reliefMin = reliefMin;
    this.reliefMax = reliefMax;
    this.waterLevel = reliefMin + (reliefMax - reliefMin) * 0.24;
  }

  private async bakeChannels(onProgress?: BakeProgress): Promise<void> {
    const { width, directions, heights, channels1, channels2 } = this;
    const rows = this.height;
    const generator = this.generator;
    const span = Math.max(1e-4, this.reliefMax - this.reliefMin);
    const dLon = (Math.PI * 2) / width;
    const dLat = Math.PI / rows;

    for (let iy = 0; iy < rows; iy++) {
      const lat = Math.PI * 0.5 - (iy + 0.5) / rows * Math.PI;
      // metres per texel along the east/west axis at this latitude
      const dx = Math.max(0.05, generator.radius * Math.cos(lat) * dLon);
      const dy = Math.max(0.05, generator.radius * dLat);

      for (let ix = 0; ix < width; ix++) {
        const index = iy * width + ix;
        const ixE = (ix + 1) % width;
        const ixW = (ix - 1 + width) % width;
        const iyN = Math.min(rows - 1, iy + 1);
        const iyS = Math.max(0, iy - 1);

        const gx = (heights[iy * width + ixE] - heights[iy * width + ixW]) / (2 * dx);
        const gy = (heights[iyS * width + ix] - heights[iyN * width + ix]) / (2 * dy);
        const tan = Math.hypot(gx, gy);
        const slope = tan / Math.sqrt(1 + tan * tan);

        const x = directions[index * 3];
        const y = directions[index * 3 + 1];
        const z = directions[index * 3 + 2];
        const height = heights[index] - generator.radius;

        const cave = generator.caveDepthAt(x, y, z);
        const grass = generator.grassEstimate(x, y, z, slope);
        const wetness = generator.wetnessEstimate(x, y, z, height, this.waterLevel);
        const radiation = generator.radiationEstimate(x, y, z, height, this.waterLevel);
        const rock = Math.max(generator.rockEstimate(slope), Math.min(1, cave / 5));
        const biome = generator.biomeWeightEstimate(x, y, z);
        const puddle = Math.max(0, wetness - 0.55) / 0.45 * (1 - Math.min(1, Math.max(0, (slope - 0.2) / 0.3)));

        const height01 = (heights[index] - this.reliefMin) / span;

        const i4 = index * 4;
        channels1[i4] = Math.round(Math.min(1, Math.max(0, height01)) * 255);
        channels1[i4 + 1] = Math.round(Math.min(1, grass) * 255);
        channels1[i4 + 2] = Math.round(Math.min(1, wetness) * 255);
        channels1[i4 + 3] = Math.round(Math.min(1, radiation) * 255);

        channels2[i4] = Math.round(Math.min(1, rock) * 255);
        channels2[i4 + 1] = Math.round(Math.min(1, biome) * 255);
        channels2[i4 + 2] = Math.round(Math.min(1, puddle) * 255);
        // A — cave mask (plan §35): how far below the local surface the carved underground is,
        // saturated at 6 m, so the terrain shader can darken strata + drop the vegetation wash.
        channels2[i4 + 3] = Math.round(Math.min(1, cave / 6) * 255);
      }

      if (iy % 48 === 47) onProgress?.(0.55 + (iy / rows) * 0.45, 'classifying biomes');
      // Yield between row groups — every estimate here is analytic terrain maths and a full
      // synchronous sweep blocked the frame for a noticeable beat on slower machines.
      if (iy % 24 === 23) await yieldToLoop();
    }

    this.tex1.needsUpdate = true;
    this.tex2.needsUpdate = true;
  }

  /**
   * Releases the baked terrain textures (r186 plan §1). Every environment material samples these
   * through `TerrainNodeBundle`, so they are world-owned: disposed with the planet that baked
   * them, exactly once.
   */
  dispose(): void {
    this.tex1.dispose();
    this.tex2.dispose();
  }

  /** Bilinear height lookup from the baked grid (used by CPU scatter checks). */
  heightAt(direction: THREE.Vector3): number {
    const u = 0.5 + Math.atan2(direction.z, direction.x) / (Math.PI * 2);
    const v = Math.acos(Math.min(1, Math.max(-1, direction.y))) / Math.PI;
    const x = u * this.width - 0.5;
    const y = v * this.height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    const sample = (ix: number, iy: number): number => {
      const cx = ((ix % this.width) + this.width) % this.width;
      const cy = Math.min(this.height - 1, Math.max(0, iy));
      return this.heights[cy * this.width + cx];
    };

    const a = sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx;
    const b = sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx;
    return a * (1 - fy) + b * fy;
  }
}
