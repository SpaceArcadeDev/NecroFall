/**
 * NECROFALL — GLB material remapper (plan §53).
 *
 * No GLB material ever survives directly: every environment mesh is walked and
 * its material converted into the shared MeshDefaultMaterial language, while
 * geometry / skinning / animations are preserved untouched.
 */
import * as THREE from 'three/webgpu';
import { color, float, texture } from 'three/tsl';
import { MeshDefaultMaterial } from './MeshDefaultMaterial';

export class MaterialRemapper {
  private readonly cache = new Map<THREE.Material, THREE.Material>();

  constructor(private readonly wireframe = false) {}

  /** Converts one source material (usually MeshStandardMaterial from a GLB). */
  convert(source: THREE.Material): THREE.Material {
    const cached = this.cache.get(source);
    if (cached) return cached;
    if (source instanceof MeshDefaultMaterial) {
      this.cache.set(source, source);
      return source;
    }

    const standard = source as THREE.MeshStandardMaterial;
    const baseColor = standard.map ? texture(standard.map).rgb : color(standard.color ? standard.color.getHex() : 0xffffff);

    const alphaNode = standard.alphaMap
      ? texture(standard.alphaMap).r
      : float(standard.transparent ? Math.max(0.02, standard.opacity) : 1);

    const material = new MeshDefaultMaterial({
      colorNode: baseColor,
      alphaNode,
      transparent: standard.transparent ?? false,
      side: standard.side ?? THREE.FrontSide,
      wireframe: this.wireframe,
      hasCoreShadows: true,
      hasDropShadows: true,
      hasLightBounce: false, // static props: keep the shading budget for vegetation
    });

    this.cache.set(source, material);
    return material;
  }

  /** Walks a loaded object and swaps every mesh material (plan §53). */
  remapObject(root: THREE.Object3D): void {
    root.traverse((object: any) => {
      if (!object.isMesh && !object.isSkinnedMesh) return;

      const material = object.material;
      if (Array.isArray(material)) {
        object.material = material.map((entry: THREE.Material) => this.convert(entry));
      } else if (material) {
        object.material = this.convert(material);
      }

      object.castShadow = true;
      object.receiveShadow = true;
    });
  }
}
