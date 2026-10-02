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
import { color, float, Fn, mix, normalWorld, screenSize, screenUV, smoothstep, uniform, vec2 } from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

/**
 * Screen-space dot SPACING (drawing-buffer pixels) of the spike see-through dissolve. The dots
 * are round, radial-distance shapes (never square cells — that read as pixelation): at the
 * player they are distinct round dots, growing with distance until they merge into solid rock.
 */
const SPIKE_DOT_SPACING = 11;

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

    // ROUND-DOT SEE-THROUGH (user ask, revised again): the spike dissolves into ROUND dots near
    // the player and the dots grow with distance until the rock merges back to solid at the
    // bubble's rim. The dot is a radial-distance shape (smooth circular edge — no square cells,
    // no pixelation); one dot per screen cell with a jittered centre and radius so the pattern
    // reads as scattered dots, never a screen-door grid. `transparent` stays false: the pattern
    // rides the alpha test (discard), no sorting.
    const seeThroughPosition = uniform(vec2(0.5, 0.5));
    const seeThroughEdgeMin = uniform(0.1);
    const seeThroughEdgeMax = uniform(0.26);
    const seeThroughAlpha = Fn(() => {
      const toPlayer = screenUV.sub(seeThroughPosition) as any;
      toPlayer.mulAssign(vec2((screenSize.x as any).div(screenSize.y), 1));
      const distanceToPlayer = toPlayer.length();
      const fade = smoothstep(seeThroughEdgeMin, seeThroughEdgeMax, distanceToPlayer);

      // one dot per cell, jittered centre + radius (so it never looks like a mechanical grid)
      const gx = (screenUV.x as any).mul(screenSize.x).div(SPIKE_DOT_SPACING);
      const gy = (screenUV.y as any).mul(screenSize.y).div(SPIKE_DOT_SPACING);
      const cx = gx.floor();
      const cy = gy.floor();
      const h1: any = cx.mul(127.1).add(cy.mul(311.7)).sin().mul(43758.5453).fract().abs();
      const h2: any = cx.mul(269.5).add(cy.mul(183.3)).sin().mul(28001.73).fract().abs();
      const localX = (gx.fract() as any).sub(0.5).add(h1.sub(0.5).mul(0.3));
      const localY = (gy.fract() as any).sub(0.5).add(h2.sub(0.5).mul(0.3));
      const d = localX.mul(localX).add(localY.mul(localY)).sqrt();

      // radius: distinct dots at the player (r ≈ 0.36 of a half-cell) → past the corners at the
      // rim (r ≥ ~1.0 fills every cell) so the material is SOLID again outside the bubble
      const radius = mix(float(0.36), float(1.1), fade).mul(h1.mul(0.3).add(0.9));
      // survive inside the round dot; smoothstep gives the circle an antialiased edge
      return (radius as any).sub(d).smoothstep(0, 0.06);
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
