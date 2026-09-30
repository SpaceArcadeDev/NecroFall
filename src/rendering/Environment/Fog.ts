// NECROFALL — Fog (plan §35): Folio-style fog architecture.
//
// Folio's Fog.js owns the atmosphere as SHADER STATE (not a three fog object): materials mix
// towards `color` with a distance curve driven by `density` (see MeshDefaultMaterial), and the
// planet's own palette writes the values per planet. This module owns the shared instance and
// mirrors it into a legacy `THREE.FogExp2` for the materials that are not TSL yet, so both
// halves can never disagree.
//
// That relationship is the radioactive look: near distances stay readable, the medium band
// fades into the planet's contaminated haze colour, and the far band dissolves into it.
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';

export class Fog {
  /** Haze colour the materials fade towards (dark contaminated by default). */
  readonly color = uniform(color('#171029'));
  /** Exponential-squared density — the same curve the legacy FogExp2 used. */
  readonly density = uniform(0.0011);

  /**
   * Mirror the shared values into `scene.fog` for non-TSL materials. Called once per frame
   * (cheap — two copies), so a planet palette change applies to both material halves at once.
   */
  syncLegacy(scene: THREE.Scene): void {
    let legacy = scene.fog as THREE.FogExp2 | null;
    if (!legacy || !(legacy as THREE.FogExp2).isFogExp2) {
      legacy = new THREE.FogExp2(0x171029, 0.0011);
      scene.fog = legacy;
    }
    legacy.color.copy(this.color.value);
    legacy.density = this.density.value;
  }
}
