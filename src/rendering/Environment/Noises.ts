/**
 * NECROFALL — generated noise textures (plan §85).
 *
 * The folio wind field samples a smooth noise texture; instead of shipping a
 * binary asset the texture is generated procedurally at startup (PreRenderer
 * style) — seeded value noise baked into an R8 canvas.
 */
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../planet/PlanetSeed';

export class Noises {
  readonly perlin: THREE.Texture;
  /**
   * SMOOTH LOW-FREQUENCY field for the grass patch mask (user ask: "larger patches, not many
   * small ones"). The general-purpose `perlin` bakes three octaves — its 1–3 m ripples shred
   * the patch boundary into small islands. This one is a single broad octave (+15% whisper of
   * the next), so a clump reads as ONE grass field ~15–30 m across with a clean soft edge.
   */
  readonly patch: THREE.Texture;
  /** 8-bit copies of the baked texels, indexed [row * size + column] — row 0 = v 0. */
  private readonly texels: Float32Array;
  private readonly patchTexels: Float32Array;
  private readonly texelSize: number;

  constructor(seed = 1337) {
    const baked = Noises.createValueNoise(seed);
    this.perlin = baked.texture;
    this.texels = baked.texels;
    this.texelSize = baked.size;

    const patch = Noises.createPatchNoise(seed ^ 0x9e3779b9);
    this.patch = patch.texture;
    this.patchTexels = patch.texels;
  }

  /**
   * CPU twin of the GPU sampling (bilinear, repeat wrap). The grass placement and the
   * terrain's grass shadow MUST agree to the texel, or blades and their shade drift apart —
   * so the whole grass field is placed through these same two functions.
   */
  sample(u: number, v: number): number {
    return Noises.sampleTexels(this.texels, this.texelSize, u, v);
  }

  /** CPU twin for the smooth patch mask (see `patch` above). */
  samplePatch(u: number, v: number): number {
    return Noises.sampleTexels(this.patchTexels, this.texelSize, u, v);
  }

  private static sampleTexels(texels: Float32Array, size: number, u: number, v: number): number {
    const x = u * size - 0.5;
    const y = v * size - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (ix: number, iy: number): number =>
      texels[(((iy % size) + size) % size) * size + (((ix % size) + size) % size)];
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  private static createValueNoise(seed: number): { texture: THREE.Texture; texels: Float32Array; size: number } {
    const size = 64;
    const random = mulberry32(seed);
    const grid = new Float32Array(size * size);
    for (let i = 0; i < grid.length; i++) grid[i] = random();

    const smooth = (x: number, y: number): number => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);

      const at = (ix: number, iy: number) => grid[((iy % size + size) % size) * size + ((ix % size + size) % size)];
      const a = at(x0, y0);
      const b = at(x0 + 1, y0);
      const c = at(x0, y0 + 1);
      const d = at(x0 + 1, y0 + 1);
      return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
    };

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // three octaves of smooth value noise
        const value =
          smooth((x / size) * 4, (y / size) * 4) * 0.55 +
          smooth((x / size) * 9, (y / size) * 9) * 0.3 +
          smooth((x / size) * 18, (y / size) * 18) * 0.15;
        const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
        const index = (y * size + x) * 4;
        image.data[index] = byte;
        image.data[index + 1] = byte;
        image.data[index + 2] = byte;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);

    const texels = new Float32Array(size * size);
    for (let i = 0; i < texels.length; i++) texels[i] = image.data[i * 4] / 255;

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // Keep the raw row order: the CPU sampler above indexes the SAME rows (an upload flip
    // would mirror one sample against the other and the grass/shadow alignment would break).
    texture.flipY = false;
    return { texture, texels, size };
  }

  /** The smooth single-octave mask for the grass patch layout (see `patch`). */
  private static createPatchNoise(seed: number): { texture: THREE.Texture; texels: Float32Array; size: number } {
    const size = 64;
    const random = mulberry32(seed);
    const grid = new Float32Array(size * size);
    for (let i = 0; i < grid.length; i++) grid[i] = random();

    const smooth = (x: number, y: number): number => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const at = (ix: number, iy: number) => grid[((iy % size + size) % size) * size + ((ix % size + size) % size)];
      const a = at(x0, y0);
      const b = at(x0 + 1, y0);
      const c = at(x0, y0 + 1);
      const d = at(x0 + 1, y0 + 1);
      return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
    };

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / size;
        const fy = y / size;
        // ---- DOMAIN WARP (user ask: patches looked "too programmatic and sharp"): two slow
        // value-noise fields push the sample point around before the mask is read, so the
        // contours meander and interlock instead of reading as round smooth blobs. The warp is
        // baked into the TEXTURE, so the CPU grass placement and the GPU terrain shade keep
        // sampling the exact same field — the shade can never drift off the blades.
        const warpX = smooth(fx * 2.0 + 11.3, fy * 2.0 + 4.7) - 0.5;
        const warpY = smooth(fx * 2.0 - 7.9, fy * 2.0 + 19.2) - 0.5;
        const warpedX = fx * 3.0 + warpX * 1.35;
        const warpedY = fy * 3.0 + warpY * 1.35;
        // ONE broad warped octave (+ a 20 % whisper of the next, also warped) — big flowing
        // fields; the second octave roughens the boundary so the fade band looks grown, not cut.
        const value =
          smooth(warpedX, warpedY) * 0.8 +
          smooth(warpedX * 2.0 + 5.5, warpedY * 2.0 - 3.1) * 0.2;
        const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
        const index = (y * size + x) * 4;
        image.data[index] = byte;
        image.data[index + 1] = byte;
        image.data[index + 2] = byte;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);

    const texels = new Float32Array(size * size);
    for (let i = 0; i < texels.length; i++) texels[i] = image.data[i * 4] / 255;

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false; // same row convention as the CPU sampler
    return { texture, texels, size };
  }
}
