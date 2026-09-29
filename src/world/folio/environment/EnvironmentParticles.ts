// NECROFALL — environment particles (plan §74/§75): ONE GPU particle field for the whole
// atmosphere — drifting spores, dust motes and corrupted glints — replacing the old GLSL
// Ambience system. The field is a single Points object whose positions wrap in a box around the
// camera; every particle is two vertex reads, no CPU simulation.
import * as THREE from 'three/webgpu';
import { Fn, attribute, mix, positionLocal, uniform, vec3 } from 'three/tsl';
import { Rand, clamp } from '../../../utils/Utils';
import { FOLIO } from '../FolioShaderGlobals';

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
  readonly points: THREE.Points;
  private readonly material: THREE.PointsNodeMaterial;
  private readonly basePositions: Float32Array;
  private readonly phases: Float32Array;
  private readonly extent: number;
  private readonly sizes: THREE.InstancedBufferAttribute;

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
    this.phases = phases;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(0), 1);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.extent * 3);

    const tintA = uniform(new THREE.Color(options.tintA ?? 0xbfd8ff));
    const tintB = uniform(new THREE.Color(options.tintB ?? 0x8d6bff));
    const camera = FOLIO.cameraPosition;

    this.material = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      size: 1.35,
      sizeAttenuation: true,
    });
    this.material.colorNode = Fn(() => {
      const phase = attribute('aPhase', 'float') as any;
      const mixT = phase.mul(0.5).add(0.5);
      const alpha = phase.mul(0.6).add(0.4);
      return mix(tintA, tintB, mixT).mul(alpha);
    })();

    // The whole box follows the camera; inside it, particles drift and wrap so the field never
    // runs out (no CPU simulation — two vertex reads per particle).
    const extent = this.extent;
    this.material.positionNode = Fn(() => {
      const p = positionLocal as any;
      const phase = attribute('aPhase', 'float') as any;
      const y = p.y.add(FOLIO.time.mul(1.1)).add(phase.mul(extent)).mod(extent).sub(extent * 0.25);
      const wobbleX = FOLIO.time.mul(0.4).add(phase.mul(6.2831)).sin().mul(1.2);
      const wobbleZ = FOLIO.time.mul(0.33).add(phase.mul(6.2831).add(1.7)).sin().mul(1.2);
      return vec3(p.x.add(wobbleX), y, p.z.add(wobbleZ));
    })();

    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'environment-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 900;
  }

  /** Follow the camera: the whole field recentres with it (particles are ambient, not world-fixed). */
  update(cameraPosition: THREE.Vector3): void {
    this.points.position.copy(cameraPosition);
  }

  setBudget(multiplier: number): void {
    this.points.visible = multiplier > 0.02;
    this.material.size = 1.35 * clamp(multiplier, 0.4, 1.4);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }

  /** Particle count (telemetry). */
  get count(): number {
    return this.basePositions.length / 3;
  }
}
