/**
 * NECROFALL — pre-rendered textures (plan §85).
 *
 * Static data that folio ships as PNGs is GENERATED here instead: the foliage
 * alpha SDF (leaf card cutout) and any future lookup maps. One owner, built
 * once per world, disposed with it.
 */
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../planet/PlanetSeed';

export class PreRenderer {
  readonly foliageTexture: THREE.Texture;

  constructor(seed: number) {
    this.foliageTexture = PreRenderer.createFoliageSDF(seed);
  }

  /**
   * Leaf-card alpha SDF: soft white lobes clustered into three canopies on a
   * black field. The material keeps everything above the threshold, so the
   * lobes merge into a broken, leafy silhouette (the folio look).
   */
  private static createFoliageSDF(seed: number): THREE.Texture {
    const size = 256;
    const random = mulberry32(seed);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d')!;

    context.fillStyle = '#000000';
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = 'lighter';

    const clusters = 4;
    for (let c = 0; c < clusters; c++) {
      const cx = size * (0.28 + random() * 0.44);
      const cy = size * (0.28 + random() * 0.44);
      const lobeCount = 26 + Math.floor(random() * 18);
      for (let i = 0; i < lobeCount; i++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.pow(random(), 0.65) * size * 0.21;
        const x = cx + Math.cos(angle) * distance;
        const y = cy + Math.sin(angle) * distance * 0.9;
        const radius = size * (0.028 + random() * 0.062);
        const alpha = 0.28 + random() * 0.35;

        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(0.62, `rgba(255,255,255,${alpha * 0.72})`);
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    context.globalCompositeOperation = 'source-over';

    const texture = new THREE.CanvasTexture(canvas);
    // folio law: nearest, no mipmaps — mipmaps average the lobes away
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return texture;
  }
}
