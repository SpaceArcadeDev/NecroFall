// NECROFALL — Lighting (plan §33, §34): the ONE primary directional light ("sun") plus the
// hemisphere fill and the purple rim. Folio's Ligthing.js structure: a single shadow-casting
// directional light, controlled shadow settings, and EVERYTHING else shades through the shared
// `FOLIO.lighting` uniforms (see materials/MeshDefaultMaterial.ts).
//
// Deliberately absent: point lights per crystal / tower / puddle / enemy. Radioactive lighting
// comes from emissive materials + bloom, never from dozens of dynamic lights (plan §34).
import * as THREE from 'three/webgpu';
import { FOLIO } from '../FolioShaderGlobals';

export interface LightingOptions {
  scene: THREE.Scene;
  /** Environment shadows are a quality tier; the sun only casts when on (plan §36). */
  shadows: boolean;
  /** Shadow map edge length in pixels (Quality.shadowMapSize()). */
  shadowMapSize: number;
}

export class Lighting {
  /** The sun: the one shadow caster the Folio materials catch. */
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rim: THREE.DirectionalLight;

  constructor(options: LightingOptions) {
    const scene = options.scene;

    const hemi = new THREE.HemisphereLight(0xb9a6ff, 0x2a1d3d, 1.15);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff0d8, 1.5);
    sun.position.set(1, 0.85, 0.6).multiplyScalar(400);
    sun.castShadow = options.shadows;
    sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
    sun.shadow.camera.near = 200;
    sun.shadow.camera.far = 620;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0001;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 2;
    scene.add(sun);
    // The frustum is small (±70 m) so it must FOLLOW the action: the shadow box originally sat
    // at the world origin, which left every match fought anywhere else on the 130-180 m-radius
    // planet entirely unshadowed.
    scene.add(sun.target);

    const rim = new THREE.DirectionalLight(0x7a5cff, 0.35);
    rim.position.set(-1, 0.2, -0.8).multiplyScalar(400);
    scene.add(rim);

    this.sun = sun;
    this.hemi = hemi;
    this.rim = rim;
  }

  /** The graphics preset / rescue ladder may take environment shadows away live (plan §36). */
  setEnvironmentShadows(enabled: boolean): void {
    this.sun.castShadow = enabled;
  }

  /**
   * Per-frame: keep the shadow box over the action. The focus is snapped to the shadow texel
   * grid before use — without the snap the ortho box re-rasterised the map under the camera
   * every frame the player moved, which shimmers/crawls over every receiver (verified fix).
   *
   * The light shines along the SAME direction the Folio materials shade with
   * (`FOLIO.lighting.direction`, written by `Planet.aimSunAt`); a fixed offset here meant cast
   * shadows fell on a different side than the lighting.
   */
  update(focusPosition: THREE.Vector3): void {
    const sun = this.sun;
    const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
    const fx = Math.round(focusPosition.x / texel) * texel;
    const fy = Math.round(focusPosition.y / texel) * texel;
    const fz = Math.round(focusPosition.z / texel) * texel;

    sun.target.position.set(fx, fy, fz);
    sun.position
      .set(fx, fy, fz)
      .addScaledVector(FOLIO.lighting.direction.value, 400);
  }
}
