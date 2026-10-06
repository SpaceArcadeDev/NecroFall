// NECROFALL — shared prop composer (complete rework §57/§58/§60).
//
// ONE way to build terrain-contoured instanced compositions: geological formations, cave
// dressing and sci-fi structures all push props through this composer, so ground contact
// (`sampleTerrainSurface` semantics — point/normal from the shared surface), the plan §58
// imperfection jitter, shadow flags and obstacle registration behave identically everywhere.
import * as THREE from 'three/webgpu';
import type { SurfaceSample } from '../../planet/PlanetSurface';
import type { Placement } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';

interface Bucket {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: THREE.Matrix4[];
  placements: { placement: Placement; radius: number; height: number; steppable: boolean }[];
  castsShadow: boolean;
}

export interface PropOptions {
  yaw?: number;
  /** Uniform or per-axis scale. */
  scale?: number | THREE.Vector3;
  /** Sink fraction of the scale (roots/burial below the surface). */
  sink?: number;
  tiltX?: number;
  tiltZ?: number;
  /** Lift above the ground (ceiling slabs, lintels). */
  lift?: number;
  /** Flip so local +Y points away from the surface (stalactites). */
  pointDown?: boolean;
  /** Register as a collider of `radius` metres (defaults to a steppable 0.8·scale). */
  collide?: { radius: number; height: number; steppable: boolean };
}

export class PropComposer {
  private readonly buckets: Bucket[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly alignQuat = new THREE.Quaternion();
  private readonly yawQuat = new THREE.Quaternion();
  private readonly flipQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  bucket(key: string, geometry: THREE.BufferGeometry, material: THREE.Material, castsShadow: boolean): void {
    this.buckets.push({ key, geometry, material, matrices: [], placements: [], castsShadow });
  }

  /** Terrain-contoured placement with the plan §58 imperfection jitter already applied. */
  place(key: string, sample: SurfaceSample, options: PropOptions = {}): void {
    const bucket = this.buckets.find((b) => b.key === key);
    if (!bucket) return;
    const { yaw = 0, sink = 0, tiltX = 0, tiltZ = 0, lift = 0, pointDown = false } = options;
    const scale = options.scale ?? 1;
    const scaleVec = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale;

    this.dummy.position.copy(sample.point).addScaledVector(sample.up, lift - sink);
    this.dummy.scale.copy(scaleVec);
    this.alignQuat.setFromUnitVectors(this.worldUp, sample.up);
    this.yawQuat.setFromAxisAngle(sample.up, yaw);
    this.dummy.quaternion.copy(this.yawQuat).multiply(this.alignQuat);
    if (tiltX !== 0) this.dummy.rotateX(tiltX);
    if (tiltZ !== 0) this.dummy.rotateZ(tiltZ);
    if (pointDown) this.dummy.quaternion.multiply(this.flipQuat);
    this.dummy.updateMatrix();

    bucket.matrices.push(this.dummy.matrix.clone());
    if (options.collide) {
      bucket.placements.push({
        placement: {
          matrix: this.dummy.matrix.clone(),
          position: sample.point.clone(),
          normal: sample.normal.clone(),
          scale: Math.max(scaleVec.x, scaleVec.y, scaleVec.z),
          yaw,
          grass: sample.grass,
          slope: sample.slope,
          radiation: sample.radiation,
          wetness: sample.wetness,
          height: sample.height,
        },
        radius: options.collide.radius,
        height: options.collide.height,
        steppable: options.collide.steppable,
      });
    }
  }

  /** Commit every bucket into `group` (one InstancedMesh per bucket) and register obstacles. */
  commit(group: THREE.Group, obstacles?: PlanetObstacles): number {
    let total = 0;
    for (const bucket of this.buckets) {
      if (bucket.matrices.length === 0) continue;
      const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = bucket.castsShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < bucket.matrices.length; i++) mesh.setMatrixAt(i, bucket.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = bucket.key;
      group.add(mesh);
      if (obstacles) {
        for (const entry of bucket.placements) obstacles.add(entry.placement, entry.radius, entry.height, entry.steppable);
      }
      total += bucket.matrices.length;
    }
    return total;
  }

  get propCount(): number {
    return this.buckets.reduce((total, bucket) => total + bucket.matrices.length, 0);
  }
}
