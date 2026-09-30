/**
 * NECROFALL — radioactive crystals (plan §24/§25/§77/§79/§96).
 *
 * Opaque low-poly shards, emissive beyond 1.0 so only the crystal cores catch
 * the restrained bloom — no dynamic point lights, no transparency tricks. The
 * pulse is GPU-side: zero CPU material updates per frame.
 */
import * as THREE from 'three/webgpu';
import { color, mix, normalWorld, uv } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';

export class RadioactiveCrystals {
  readonly mesh: THREE.InstancedMesh | null;
  readonly shardCount: number;

  constructor(surface: PlanetSurface, generator: PlanetGenerator, timeUniform: any, clusterTarget = 48, spawnClear?: { direction: THREE.Vector3; radius: number }, obstacles?: PlanetObstacles) {
    const clusters = scatterPlacements(surface, generator, {
      count: clusterTarget,
      salt: 55,
      minRadiation: 0.22,
      maxSlope: 0.55,
      aboveWater: 0.35,
      scaleMin: 0.85,
      scaleMax: 1.5,
      sinkFactor: 0.12,
      attemptsPerInstance: 16,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
    });

    const random = generator.rand(56);
    for (const cluster of clusters) obstacles?.add(cluster, 0.75 * cluster.scale, 1.5 * cluster.scale, false);
    const geometry = new THREE.OctahedronGeometry(0.46, 0);
    geometry.scale(0.5, 1.9, 0.5);
    geometry.translate(0, 0.75, 0);

    // ---- emissive radioactive material (values > 1 feed the bloom)
    const core = color('#b6ff54');
    const edge = color('#36ff9b');
    const pulse = (timeUniform as any).mul(1.35).sin().mul(0.22).add(0.92);
    const facet = (normalWorld as any).y.mul(0.25).add(0.78);

    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = mix(core, edge, (uv() as any).y).mul(1.9).mul(pulse).mul(facet) as any;
    material.transparent = false;

    const matrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    const local = new THREE.Matrix4();

    for (const cluster of clusters) {
      const perCluster = 3 + Math.floor(random() * 5);
      for (let i = 0; i < perCluster; i++) {
        const angle = random() * Math.PI * 2;
        const distance = 0.1 + random() * 0.55;
        const scale = 0.6 + random() * 1.0;

        // random BURIAL DEPTH + leaning shards in any direction — some barely
        // poke out of the ground, none is a manicured vertical bed
        const bury = random() * 0.75 * scale;
        const tiltX = (random() - 0.5) * 1.7; // up to ~±49°
        const tiltZ = (random() - 0.5) * 1.7;
        dummy.position.set(Math.cos(angle) * distance, -bury, Math.sin(angle) * distance);
        dummy.rotation.set(tiltX, random() * Math.PI * 2, tiltZ, 'YXZ');
        dummy.scale.set(scale, scale * (0.8 + random() * 0.7), scale);
        dummy.updateMatrix();

        local.multiplyMatrices(cluster.matrix, dummy.matrix);
        matrices.push(local.clone());
      }
    }

    if (matrices.length === 0) {
      this.mesh = null;
      this.shardCount = 0;
      return;
    }

    this.mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < matrices.length; i++) this.mesh.setMatrixAt(i, matrices[i]);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.name = 'radioactiveCrystals';
    this.shardCount = matrices.length;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}
