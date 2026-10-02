/**
 * NECROFALL — spikes (plan §23/§78/§54).
 *
 * Contaminated terrain hazards: 2–5 chunky cones per cluster, ONE InstancedMesh
 * for the whole planet, cluster offsets in the TANGENT plane so they read as
 * planted. Dark rock base with a radioactive upper wash.
 */
import * as THREE from 'three/webgpu';
import { color, mix, normalWorld } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

export class Spikes {
  readonly mesh: THREE.InstancedMesh | null;
  readonly spikeCount: number;

  constructor(surface: PlanetSurface, generator: PlanetGenerator, clusterTarget = 74, spawnClear?: { direction: THREE.Vector3; radius: number }, obstacles?: PlanetObstacles) {
    const clusters = scatterPlacements(surface, generator, {
      count: clusterTarget,
      salt: 77,
      minRadiation: 0.22,
      maxSlope: 0.6,
      aboveWater: 0.3,
      scaleMin: 1.0,
      scaleMax: 1.9,
      sinkFactor: 0.04,
      attemptsPerInstance: 14,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
    });

    const random = generator.rand(78);
    const geometry = new THREE.ConeGeometry(0.24, 1.55, 5);
    geometry.translate(0, 0.775, 0);

    for (const cluster of clusters) obstacles?.add(cluster, 1.05 * cluster.scale, 2.0 * cluster.scale, false);

    const material = new MeshDefaultMaterial({
      colorNode: mix(
        color(RADIOACTIVE_PALETTE.spike),
        color(RADIOACTIVE_PALETTE.radioactive),
        (normalWorld as any).y.abs().pow(1.6).mul(0.45),
      ),
      hasLightBounce: false,
      hasFog: true,
    });
    (material as any).flatShading = true;

    const matrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    const local = new THREE.Matrix4();
    const tilt = new THREE.Quaternion();

    for (const cluster of clusters) {
      const perCluster = 4 + Math.floor(random() * 6); // 4–9 chunky spikes per cluster
      for (let i = 0; i < perCluster; i++) {
        const angle = random() * Math.PI * 2;
        const distance = 0.08 + random() * 0.7;
        const scale = 1.0 + random() * 1.4;

        dummy.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
        dummy.rotation.set((random() - 0.5) * 0.2, random() * Math.PI * 2, (random() - 0.5) * 0.2);
        dummy.scale.set(scale * (0.8 + random() * 0.4), scale * (0.9 + random() * 0.8), scale * (0.8 + random() * 0.4));
        dummy.updateMatrix();

        local.multiplyMatrices(cluster.matrix, dummy.matrix);
        matrices.push(local.clone());
      }
    }

    if (matrices.length === 0) {
      this.mesh = null;
      this.spikeCount = 0;
      return;
    }

    this.mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Tiny debris NEVER casts (mobile plan §11): 74 spike clusters are sub-metre needles whose
    // shadow-map work buys almost nothing visually. They keep RECEIVING light/shadow.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < matrices.length; i++) this.mesh.setMatrixAt(i, matrices[i]);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.name = 'spikes';
    this.spikeCount = matrices.length;
    void tilt;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}
