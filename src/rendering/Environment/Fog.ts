/**
 * NECROFALL — fog + sky (folio `Fog.js` port, plan §35/§60).
 *
 * The background is a folio radial gradient — contaminated haze bleeding into
 * a near-black sky — and the same palette feeds the distance fog every
 * material mixes in, so silhouettes separate exactly like folio's world.
 */
import * as THREE from 'three/webgpu';
import { color, mix, rangeFogFactor, uniform, vec2, viewportUV } from 'three/tsl';
import type { FogGlobals } from '../WorldGlobals';

export interface FogOptions {
  near?: number;
  far?: number;
  /**
   * Legacy `THREE.FogExp2` mirror for the classic (non-TSL) gameplay materials. OWNED here so
   * exactly one system controls every fog in the scene (plan §24). Folio materials opt out
   * (`MeshDefaultMaterial.fog = false`) and shade through `WorldGlobals.fog` instead, so this
   * mirror can never double-fog the environment.
   */
  legacyExp2?: { color: number; density: number };
}

export class Fog implements FogGlobals {
  readonly colorA = uniform(color('#2b4f40')); // inner haze — contaminated green
  readonly colorB = uniform(color('#070d0b')); // outer sky — near black
  readonly radialCenter = uniform(vec2(0.5, 0.44));
  readonly radialStart = uniform(0.18);
  readonly radialEnd = uniform(1.05);

  /** Sky colour used as the scene background (screen-space radial mix). */
  readonly skyColor: any;
  /** Distance fog colour materials blend toward. */
  readonly color = uniform(color('#1d3a30'));

  readonly near: any;
  readonly far: any;
  /** 1 = on, 0 = `?fog=0` — multiplied into the one distance-fog factor (§24/§33). */
  private readonly enabled = uniform(1);
  /** Distance fog factor — `?fog=0` turns the whole world's fog off through this ONE node. */
  readonly strength: any;

  private readonly legacy: THREE.FogExp2 | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    options: FogOptions = {},
  ) {
    const radialFactor = (vec2(viewportUV.xy) as any).sub(this.radialCenter).length().smoothstep(this.radialStart, this.radialEnd);
    this.skyColor = mix(this.colorA, this.colorB, radialFactor);
    this.scene.backgroundNode = this.skyColor;

    this.near = uniform(options.near ?? 34);
    this.far = uniform(options.far ?? 270);
    this.strength = rangeFogFactor(this.near, this.far).mul(this.enabled);

    if (options.legacyExp2) {
      this.legacy = new THREE.FogExp2(options.legacyExp2.color, options.legacyExp2.density);
      this.scene.fog = this.legacy;
    }
  }

  /** `?fog=0` / `?render=fogoff` — the ONE fog off switch (plan §24/§44). */
  setEnabled(enabled: boolean): void {
    this.enabled.value = enabled ? 1 : 0;
  }

  /** Baseline dump (`?renderBaseline=1`). */
  get baseline(): { near: number; far: number; color: string } {
    return {
      near: this.near.value as number,
      far: this.far.value as number,
      color: `#${(this.color.value as THREE.Color).getHexString()}`,
    };
  }

  /** Quality can pull the fog wall closer on weak GPUs. */
  setDistances(near: number, far: number): void {
    this.near.value = near;
    this.far.value = far;
  }
}
