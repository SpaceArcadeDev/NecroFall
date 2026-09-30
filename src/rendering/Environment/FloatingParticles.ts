// NECROFALL — environment particles (plan §74/§75): ONE GPU particle field for the whole
// atmosphere — drifting spores, dust motes and corrupted glints — replacing the old GLSL
// Ambience system. The field is a single instanced-quad billboard object whose positions wrap in
// a box around the camera; every particle is two vertex reads, no CPU simulation.
//
// (Was THREE.Points — migrated to BillboardParticles because point sprites cannot exist on the
// WebGPU backend: gl_PointCoord invalidates the frame. See BillboardParticles.ts.)
import * as THREE from 'three/webgpu';
import { instanceIndex, vec3 } from 'three/tsl';
import { Rand, clamp } from '../../utils/Utils';
import { FOLIO } from '../FolioShaderGlobals';
import { BillboardParticles } from '../../effects/BillboardParticles';

export interface EnvironmentParticlesOptions {
  seed: number;
  /** Total active particles (plan §75 budget). */
  budget: number;
  /** Box half-size around the camera (metres). */
  extent?: number;
  /** Tint for corrupt motes. */
  tintA?: number;
  tintB?: number;
}

export class EnvironmentParticles {
  readonly points: THREE.InstancedMesh;
  private readonly bb: BillboardParticles;
  private readonly basePositions: Float32Array;
  private readonly extent: number;

  constructor(options: EnvironmentParticlesOptions) {
    const count = clamp(Math.round(options.budget), 0, 4000);
    this.extent = options.extent ?? 46;

    const rng = new Rand((options.seed ^ 0x90210) >>> 0);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rng.range(-1, 1) * this.extent;
      positions[i * 3 + 1] = rng.range(0, 1) * this.extent * 0.5;
      positions[i * 3 + 2] = rng.range(-1, 1) * this.extent;
      phases[i] = rng.next();
    }
    this.basePositions = positions;

    // Per-particle constants baked on the CPU: colour pair mix, brightness and size jitter.
    const colors = new Float32Array(count * 3);
    const alphas = new Float32Array(count);
    const sizes = new Float32Array(count);
    const tintA = new THREE.Color(options.tintA ?? 0xbfd8ff);
    const tintB = new THREE.Color(options.tintB ?? 0x8d6bff);
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const phase = phases[i];
      tint.copy(tintA).lerp(tintB, phase * 0.5 + 0.5);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      alphas[i] = phase * 0.6 + 0.4;
      sizes[i] = 0.8 + phase * 0.6;
    }

    // The whole box follows the camera; inside it, particles drift and wrap so the field never
    // runs out (no CPU simulation — two vertex reads per particle). The per-particle phase comes
    // from `instanceIndex` (a golden-ratio hash): a vertex attribute for it would push the draw
    // past WebGPU's 8-vertex-buffer ceiling and invalidate the pipeline.
    const extent = this.extent;
    this.bb = new BillboardParticles({
      capacity: count,
      shape: 'soft',
      worldScale: 0.05, // a mote is a few centimetres across
      renderOrder: 900,
      arrays: { center: positions, color: colors, alpha: alphas, size: sizes },
      displace: (p: any) => {
        const phase = (instanceIndex as any).toFloat().mul(0.6180339887498949).fract();
        const y = p.y.add(FOLIO.time.mul(1.1)).add(phase.mul(extent)).mod(extent).sub(extent * 0.25);
        const wobbleX = FOLIO.time.mul(0.4).add(phase.mul(6.2831)).sin().mul(1.2);
        const wobbleZ = FOLIO.time.mul(0.33).add(phase.mul(6.2831).add(1.7)).sin().mul(1.2);
        return vec3(p.x.add(wobbleX), y, p.z.add(wobbleZ));
      },
    });
    this.bb.setCount(count);
    this.bb.aColor.needsUpdate = true;
    this.bb.aAlpha.needsUpdate = true;
    this.bb.aSize.needsUpdate = true;

    this.points = this.bb.mesh;
    this.points.name = 'environment-particles';
  }

  /** Follow the camera: the whole field recentres with it (particles are ambient, not world-fixed). */
  update(cameraPosition: THREE.Vector3): void {
    this.points.position.copy(cameraPosition);
  }

  setBudget(multiplier: number): void {
    this.points.visible = multiplier > 0.02;
    this.bb.setSizeScale(clamp(multiplier, 0.4, 1.4));
  }

  dispose(): void {
    this.bb.dispose();
  }

  /** Particle count (telemetry). */
  get count(): number {
    return this.basePositions.length / 3;
  }
}
