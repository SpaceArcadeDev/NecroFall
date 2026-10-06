// NECROFALL — CAVE DEBUG OVERLAY (complete rework, phase 41).
//
// `?cavedebug=1` draws the analytic cave system the game actually walks on: each cave's carve
// footprint ring, every node ring (entrance ledges → tunnels → chambers), entrance markers and
// the ACTIVE cave highlighted. The dev HUD prints the underground state (depth + cave id) so a
// tester can descend and verify the transition without guessing.
import * as THREE from 'three/webgpu';
import { PlanetSurface, createSurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';

const OUTER_COLOR = 0x36f5ff;
const NODE_COLOR = 0xffd76a;
const CHAMBER_COLOR = 0xff8a3d;
const ACTIVE_COLOR = 0x7dff46;

export class CaveDebug {
  readonly group = new THREE.Group();

  private readonly rings: { caveId: number; line: THREE.LineSegments; material: THREE.LineBasicMaterial }[] = [];
  private activeCaveId = -1;

  constructor(surface: PlanetSurface, generator: PlanetGenerator) {
    const rings = generator.terrain.caves;
    const dir = new THREE.Vector3();
    const t1 = new THREE.Vector3();
    const t2 = new THREE.Vector3();
    const sample = createSurfaceSample();

    const ringPoints = (center: THREE.Vector3, radiusRadians: number, lift: number): Float32Array => {
      const segments = 64;
      // LineSegments (LineLoop is unsupported by the WebGPU renderer) — pairs of points, closed.
      const points = new Float32Array(segments * 6);
      PlanetSurface.stableTangent(center, t1);
      t2.crossVectors(center, t1).normalize();
      const at = (i: number, offset: number): void => {
        const a = (i / segments) * Math.PI * 2;
        const sinA = Math.sin(radiusRadians);
        dir
          .copy(center)
          .multiplyScalar(Math.cos(radiusRadians))
          .addScaledVector(t1, sinA * Math.cos(a))
          .addScaledVector(t2, sinA * Math.sin(a))
          .normalize();
        surface.sample(dir, sample);
        const base = (i * 2 + offset) * 3;
        points[base] = sample.point.x + dir.x * lift;
        points[base + 1] = sample.point.y + dir.y * lift;
        points[base + 2] = sample.point.z + dir.z * lift;
      };
      for (let i = 0; i < segments; i++) {
        at(i, 0);
        at((i + 1) % segments, 1);
      }
      return points;
    };

    for (const cave of rings) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(ringPoints(cave.dir, cave.radius, 0.35), 3));
      const material = new THREE.LineBasicMaterial({ color: OUTER_COLOR });
      const line = new THREE.LineSegments(geometry, material);
      line.frustumCulled = false;
      line.name = `caveRing${cave.id}`;
      this.group.add(line);
      this.rings.push({ caveId: cave.id, line, material });

      for (const node of cave.nodes) {
        const nodeGeometry = new THREE.BufferGeometry();
        nodeGeometry.setAttribute('position', new THREE.BufferAttribute(ringPoints(node.dir, node.radius, 0.5), 3));
        const nodeMaterial = new THREE.LineBasicMaterial({ color: node.chamber ? CHAMBER_COLOR : NODE_COLOR });
        const nodeLine = new THREE.LineSegments(nodeGeometry, nodeMaterial);
        nodeLine.frustumCulled = false;
        this.group.add(nodeLine);
      }
      // entrance marker: a small upright diamond at the entrance node's surface point
      surface.sample(cave.dir, sample);
      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.6, 0),
        new THREE.MeshBasicMaterial({ color: 0xff4356 }),
      );
      marker.position.copy(sample.point).addScaledVector(sample.up, 1.2);
      marker.frustumCulled = false;
      this.group.add(marker);
    }
  }

  /** Highlight the cave the player is inside (called from the dev tick / game debug pass). */
  setActive(caveId: number): void {
    if (caveId === this.activeCaveId) return;
    this.activeCaveId = caveId;
    for (const ring of this.rings) {
      ring.material.color.setHex(ring.caveId === caveId ? ACTIVE_COLOR : OUTER_COLOR);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.traverse((object: any) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
    this.group.removeFromParent();
  }
}
