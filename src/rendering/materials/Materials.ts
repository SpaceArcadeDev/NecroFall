/**
 * NECROFALL — material registry (folio `Materials.js` port, trimmed to the
 * environment needs).
 *
 * Owns the palette material every GLB is remapped through, plus the small
 * family of shared environment materials. Nothing here is cloned per frame —
 * the registry is built once per world (plan §107).
 */
import * as THREE from 'three/webgpu';
import { color, float, mix, texture, uniform } from 'three/tsl';
import { MeshDefaultMaterial } from './MeshDefaultMaterial';
import { MaterialRemapper } from './MaterialRemapper';
import { createPaletteAtlas, RADIOACTIVE_PALETTE } from './PlanetPalette';

export class Materials {
  readonly list = new Map<string, THREE.Material>();
  readonly paletteTexture: THREE.Texture;
  readonly palette: MeshDefaultMaterial;
  readonly remapper: MaterialRemapper;

  constructor(options: { wireframe?: boolean } = {}) {
    this.paletteTexture = createPaletteAtlas();
    this.remapper = new MaterialRemapper(options.wireframe ?? false);

    this.palette = new MeshDefaultMaterial({
      colorNode: texture(this.paletteTexture).rgb,
    });
    this.save('palette', this.palette);
  }

  save(name: string, material: THREE.Material): THREE.Material {
    this.list.set(name, material);
    return material;
  }

  get(name: string): THREE.Material | undefined {
    return this.list.get(name);
  }

  /** Material for a loaded GLB object graph (plan §53). */
  updateObject(object: THREE.Object3D): void {
    this.remapper.remapObject(object);
  }

  /** Environment props: flat colour through the shared lighting language. */
  createPlainMaterial(
    hex: string,
    options: { hasLightBounce?: boolean; hasFog?: boolean; wireframe?: boolean } = {},
  ): MeshDefaultMaterial {
    return new MeshDefaultMaterial({
      colorNode: color(hex),
      hasLightBounce: options.hasLightBounce ?? true,
      hasFog: options.hasFog ?? true,
      wireframe: options.wireframe ?? false,
    });
  }

  /** Radioactive veins: two-tone with a pulse-ready strength uniform (plan §62). */
  createVeinMaterial(hexA: string, hexB: string, strength = 1): MeshDefaultMaterial {
    const pulseStrength = uniform(strength);
    const material = new MeshDefaultMaterial({
      colorNode: mix(color(hexA), color(hexB), float(0.5)),
      hasLightBounce: false,
    });
    (material as any).veinStrength = pulseStrength;
    return material;
  }

  get paletteGrassColor(): string {
    return RADIOACTIVE_PALETTE.grass;
  }

  /**
   * Disposes every resource this registry created for ONE world (r186 plan §1): the palette
   * atlas, the palette material, and every material created through `save()` — including the
   * per-world GLB remaps. `Materials` is constructed per world (`createPlanetWorld`), so nothing
   * here is app-lifetime shared; a later world builds its own.
   */
  dispose(): void {
    for (const material of this.list.values()) {
      try {
        material.dispose();
      } catch (err) {
        console.warn('[NECROFALL] material dispose failed', err);
      }
    }
    this.list.clear();
    this.paletteTexture.dispose();
    this.remapper.dispose();
  }
}
