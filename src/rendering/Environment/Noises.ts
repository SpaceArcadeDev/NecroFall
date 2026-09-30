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

  constructor(seed = 1337) {
    this.perlin = Noises.createValueNoise(seed);
  }

  private static createValueNoise(seed: number): THREE.Texture {
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

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }
}
