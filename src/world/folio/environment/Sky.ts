// NECROFALL — the sky dome (plan §116): the old GLSL SKY_FRAG (nebula bands + procedural stars)
// ported to TSL so the whole scene lives in one material family on the WebGPU renderer.
import * as THREE from 'three/webgpu';
import { Fn, mix, positionLocal, uniform, vec3 } from 'three/tsl';
import { FOLIO } from '../FolioShaderGlobals';

export interface SkyOptions {
  zenith: number;
  horizon: number;
  nebula: number;
  radius?: number;
}

export class Sky {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.MeshBasicNodeMaterial;

  constructor(options: SkyOptions) {
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.side = THREE.BackSide;
    this.material.depthWrite = false;
    this.material.fog = false;

    const zenith = uniform(new THREE.Color(options.zenith));
    const horizon = uniform(new THREE.Color(options.horizon));
    const nebula = uniform(new THREE.Color(options.nebula));

    this.material.colorNode = Fn(() => {
      const d = (positionLocal as any).normalize();
      const h = d.y.mul(0.5).add(0.5).clamp(0, 1);
      const base = mix(horizon, zenith, h.pow(0.75));

      // Slow nebula bands.
      const band = d.x.mul(2.6).add(FOLIO.time.mul(0.02)).sin()
        .mul(d.z.mul(3.1).sub(FOLIO.time.mul(0.015)).sin())
        .mul(d.y.mul(1.7).sin());
      const nebulaGlow = band.max(0).pow(3).mul(0.55);
      let col: any = base.add(nebula.mul(nebulaGlow));

      // Procedural stars: hash the quantised direction.
      const cell = d.mul(260).floor();
      const rnd = cell.dot(vec3(12.9898, 78.233, 45.164)).sin().mul(43758.5453).fract();
      const star = rnd.smoothstep(0.9975, 1);
      col = col.add(vec3(star).mul(FOLIO.time.mul(1.4).add(rnd.mul(40)).sin().mul(0.45).add(0.55)));

      return vec3(col);
    })();

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(options.radius ?? 1700, 32, 20), this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // last: the depth buffer paints over the covered area first
    this.mesh.matrixAutoUpdate = false;
  }

  update(cameraPosition: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition);
    this.mesh.updateMatrix();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
