// NECROFALL — WebGPU-safe particle billboards (plan: "WebGPU is the canonical renderer").
//
// `THREE.Points` / `PointsNodeMaterial` cannot work on the WebGPU backend: point sprites need
// `gl_PointCoord` and `gl_PointSize`, which do not exist in WGSL. One invalid pipeline poisons
// the whole frame's command buffer, so a single Points object using `pointUV` paints the entire
// screen black (observed live 2026-09-30 with `renderPipeline_PointsNodeMaterial_18`).
//
// This class replaces point sprites with instanced camera-facing quads — the portable technique:
//
//   • one 1×1 plane, `capacity` instances, per-instance `aCenter`/`aSize`/`aColor`/`aAlpha`
//   • the vertex stage builds the billboard in VIEW space (centre + plane offset, exactly the
//     semantics of a point sprite) and converts back to object space through
//     `cameraWorldMatrix · modelWorldMatrix⁻¹` — so the mesh may still be parented anywhere
//     (accessory groups) or translated into the scene;
//   • the fragment stage shapes the disc from the quad's uv (the `gl_PointCoord` replacement).
//
// Callers keep their existing CPU simulation arrays zero-copy by passing them through `arrays`.
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraWorldMatrix,
  modelViewMatrix,
  modelWorldMatrixInverse,
  positionLocal,
  uniform,
  uv,
  varying,
  vec4,
} from 'three/tsl';

export interface BillboardParticlesOptions {
  /** Hard cap on instances. */
  capacity: number;
  /** Blending mode — defaults to additive (all legacy point systems were additive). */
  blending?: THREE.Blending;
  depthWrite?: boolean;
  /**
   * Fragment alpha shape:
   *   'disc' — max(0, 1 − r²): the clamped-rim falloff of the old `1.0 − dot(c, c)` GLSL,
   *   'soft' — smoothstep(0.5, 0.05, r): the round glow of the old point-sprite systems.
   */
  shape?: 'disc' | 'soft';
  /** Life-based fade-in window in the same units as `aAlpha` (0 disables it). */
  fadeIn?: number;
  renderOrder?: number;
  /** World size (metres) = aSize × worldScale. */
  worldScale?: number;
  /** Optional vertex motion: maps (centerNode, attributeNodes) → displaced center node. */
  displace?: (center: any, attrs: Record<string, any>) => any;
  /** Extra per-instance attributes (attached to the plane and exposed to `displace`). */
  extraAttributes?: Record<string, THREE.InstancedBufferAttribute>;
  /** Reuse existing CPU arrays as the GPU buffers (zero-copy). Sizes must match `capacity`. */
  arrays?: {
    center?: Float32Array;
    size?: Float32Array;
    color?: Float32Array;
    alpha?: Float32Array;
  };
}

export class BillboardParticles {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly capacity: number;

  readonly aCenter: THREE.InstancedBufferAttribute;
  readonly aSize: THREE.InstancedBufferAttribute;
  readonly aColor: THREE.InstancedBufferAttribute;
  readonly aAlpha: THREE.InstancedBufferAttribute;

  private readonly opacity = uniform(1);
  private readonly sizeScale = uniform(1);
  private readonly worldScale: number;

  constructor(options: BillboardParticlesOptions) {
    const capacity = Math.max(1, Math.round(options.capacity));
    this.capacity = capacity;
    this.worldScale = options.worldScale ?? 1;

    const plane = new THREE.PlaneGeometry(1, 1);

    const dynamic = (attr: THREE.InstancedBufferAttribute): THREE.InstancedBufferAttribute => {
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    this.aCenter = dynamic(
      new THREE.InstancedBufferAttribute(options.arrays?.center ?? new Float32Array(capacity * 3), 3),
    );
    this.aSize = dynamic(
      new THREE.InstancedBufferAttribute(options.arrays?.size ?? new Float32Array(capacity), 1),
    );
    this.aColor = dynamic(
      new THREE.InstancedBufferAttribute(options.arrays?.color ?? new Float32Array(capacity * 3), 3),
    );
    this.aAlpha = dynamic(
      new THREE.InstancedBufferAttribute(options.arrays?.alpha ?? new Float32Array(capacity), 1),
    );
    plane.setAttribute('aCenter', this.aCenter);
    plane.setAttribute('aSize', this.aSize);
    plane.setAttribute('aColor', this.aColor);
    plane.setAttribute('aAlpha', this.aAlpha);

    // Expose the caller's extra attributes both to the shader and to `displace`.
    const extraNodes: Record<string, any> = {};
    for (const [name, attr] of Object.entries(options.extraAttributes ?? {})) {
      plane.setAttribute(name, attr);
      const type = attr.itemSize === 1 ? 'float' : attr.itemSize === 2 ? 'vec2' : attr.itemSize === 3 ? 'vec3' : 'vec4';
      extraNodes[name] = attribute(name, type);
    }

    // ------------------------------------------------------------------ fragment
    const vColor = varying(attribute('aColor', 'vec3')) as any;
    const vAlpha = varying(attribute('aAlpha', 'float')) as any;
    const shape = options.shape ?? 'disc';
    const fadeIn = options.fadeIn ?? 0;

    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: options.depthWrite ?? false,
      blending: options.blending ?? THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.material.colorNode = Fn(() => {
      const c = (uv() as any).sub(0.5).mul(2); // quad coordinate −1..1 (the gl_PointCoord replacement)
      let shapeAlpha: any;
      if (shape === 'soft') {
        shapeAlpha = c.length().mul(0.5).smoothstep(0.5, 0.05);
      } else {
        shapeAlpha = c.dot(c).oneMinus().max(0);
      }
      let alpha: any = vAlpha.mul(shapeAlpha).mul(this.opacity);
      if (fadeIn > 0) {
        alpha = alpha.mul(vAlpha.oneMinus().smoothstep(0, fadeIn));
      }
      return vec4(vColor, alpha);
    })();

    // ------------------------------------------------------------------ vertex
    const centerAttr = attribute('aCenter', 'vec3') as any;
    const sizeAttr = attribute('aSize', 'float') as any;
    const displace = options.displace;
    const worldScale = this.worldScale;

    this.material.positionNode = Fn(() => {
      let center: any = centerAttr;
      if (displace) center = displace(center, extraNodes);

      // View-space centre (a point sprite's anchor), then the quad offset in view-plane units.
      const viewCenter = (modelViewMatrix as any).mul(vec4(center, 1));
      const extent = sizeAttr.mul(worldScale).mul(this.sizeScale);
      const offset = (positionLocal as any).xy.mul(extent);
      const viewShifted = vec4(viewCenter.xy.add(offset), viewCenter.z, 1);

      // Back to object space so transform chains (accessory groups, mesh translation) still work:
      // local = modelMatrix⁻¹ · cameraWorldMatrix · view.
      return modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(viewShifted)).xyz;
    })();

    this.mesh = new THREE.InstancedMesh(plane, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // particles are simulated; baked bounds would lie
    this.mesh.renderOrder = options.renderOrder ?? 5;
    this.mesh.name = 'billboard-particles';
  }

  /** Live instance count (the draw's instance count in the WebGPU backend). */
  setCount(count: number): void {
    this.mesh.count = Math.max(0, Math.min(Math.round(count), this.capacity));
  }

  setOpacity(value: number): void {
    this.opacity.value = value;
  }

  /** Extra size multiplier on every instance (quality tiers shrink/spread the fields). */
  setSizeScale(value: number): void {
    this.sizeScale.value = value;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
