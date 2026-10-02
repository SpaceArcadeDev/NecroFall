/**
 * NECROFALL — spikes (plan §23/§78/§54).
 *
 * Contaminated terrain hazards: 2–5 chunky cones per cluster, ONE InstancedMesh
 * for the whole planet, cluster offsets in the TANGENT plane so they read as
 * planted. Dark rock base with a radioactive upper wash.
 *
 * User ask (2026-10-02): "a lot more bigger", groups at RANDOM angles (no more
 * perfectly vertical cones), and a see-through dissolve near the player exactly
 * like the tree canopies (screen-space fade + stipple, no transparency sorting).
 */
import * as THREE from 'three/webgpu';
import { color, Fn, mix, normalWorld, screenSize, screenUV, smoothstep, uniform, vec2 } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';
import { dotDissolve } from './DotDissolve';

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
      // Bigger groups (user ask: "a lot more bigger").
      scaleMin: 1.5,
      scaleMax: 2.6,
      sinkFactor: 0.12,
      attemptsPerInstance: 14,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
    });

    const random = generator.rand(78);
    // Chunky cones, grown to hazard scale (was 0.24 × 1.55).
    const geometry = new THREE.ConeGeometry(0.34, 2.4, 5);
    geometry.translate(0, 1.2, 0);

    // Solid hazards (user ask): the cluster's footprint blocks players. Radius covers the
    // scaled spike spread (+ the lean), so no cone can be walked through.
    for (const cluster of clusters) obstacles?.add(cluster, 1.3 * cluster.scale, 2.6 * cluster.scale, false);

    // ROUND-DOT SEE-THROUGH (user ask): the spike dissolves into the SHARED round-dot pattern
    // (DotDissolve.ts — the tree canopies use the very same one), growing from distinct dots at
    // the player back into solid rock at the bubble's rim. `transparent` stays false: the
    // pattern rides the alpha test (discard), no sorting.
    const seeThroughPosition = uniform(vec2(0.5, 0.5));
    const seeThroughEdgeMin = uniform(0.1);
    const seeThroughEdgeMax = uniform(0.26);
    const seeThroughAlpha = Fn(() => {
      const toPlayer = screenUV.sub(seeThroughPosition) as any;
      toPlayer.mulAssign(vec2((screenSize.x as any).div(screenSize.y), 1));
      const distanceToPlayer = toPlayer.length();
      const fade = smoothstep(seeThroughEdgeMin, seeThroughEdgeMax, distanceToPlayer);
      return dotDissolve(fade);
    })();

    const material = new MeshDefaultMaterial({
      colorNode: mix(
        color(RADIOACTIVE_PALETTE.spike),
        color(RADIOACTIVE_PALETTE.radioactive),
        (normalWorld as any).y.abs().pow(1.6).mul(0.45),
      ),
      alphaNode: seeThroughAlpha,
      hasLightBounce: false,
      hasFog: true,
    });
    (material as any).flatShading = true;

    const matrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    const local = new THREE.Matrix4();
    const tiltMatrix = new THREE.Matrix4();
    const tiltEuler = new THREE.Euler();

    for (const cluster of clusters) {
      // RANDOM GROUP LEAN (user ask: "random angles, not always 90 degrees vertical"): the
      // whole cluster tilts in its local tangent plane before its spikes spawn.
      tiltEuler.set((random() - 0.5) * 0.8, 0, (random() - 0.5) * 0.8);
      tiltMatrix.makeRotationFromEuler(tiltEuler);
      cluster.matrix.multiply(tiltMatrix);

      const perCluster = 4 + Math.floor(random() * 6); // 4–9 chunky spikes per cluster
      for (let i = 0; i < perCluster; i++) {
        const angle = random() * Math.PI * 2;
        const distance = 0.08 + random() * 0.9;
        const scale = 1.1 + random() * 1.9;

        dummy.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
        // each spike leans on its own — up to ±46° off the group's axis
        dummy.rotation.set((random() - 0.5) * 1.6, random() * Math.PI * 2, (random() - 0.5) * 1.6);
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
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}
