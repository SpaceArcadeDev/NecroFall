/**
 * NECROFALL — world-space triangle BVH for capsule collisions and radial top
 * support on terrain and solid scenery. Legacy decorative obstacles retain
 * their surface-anchored circle resolver.
 */
import * as THREE from 'three/webgpu';
import type { Placement } from './Placement';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Obstacle {
  /** Surface point (planet space). */
  position: THREE.Vector3;
  /** |position| — the surface radius under the object. */
  positionRadius: number;
  /** Unit surface direction (for the angular prefilter). */
  direction: THREE.Vector3;
  /** Horizontal collision radius in metres. */
  radius: number;
  /** Object height in metres (drives the step-over cap). */
  height: number;
  /** Low objects (rocks, bushes) are climbed over; tall/pointed ones block. */
  steppable: boolean;
  /** dot(direction, obstacleDirection) prefilter threshold. */
  reachCos: number;
}

/** Objects at most this tall are stepped onto automatically (all rock sizes). */
const STEP_HEIGHT = 1.5;
const MIN_SUPPORT_DOT = 0.12;

export class PlanetObstacles {
  private meshTree: MeshBVH | null = null;
  private readonly meshes: THREE.Mesh[] = [];
  private meshCount = 0;
  private readonly capsule = new THREE.Line3();
  private readonly capsuleBounds = new THREE.Box3();
  private readonly trianglePoint = new THREE.Vector3();
  private readonly capsulePoint = new THREE.Vector3();
  private readonly collisionNormal = new THREE.Vector3();
  private readonly collisionUp = new THREE.Vector3();
  private readonly supportRay = new THREE.Ray();
  private readonly list: Obstacle[] = [];
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchTo = new THREE.Vector3();
  private readonly scratchPush = new THREE.Vector3();

  constructor(private readonly planetRadius: number) {}

  get count(): number {
    return this.list.length + this.meshCount;
  }

  addMesh(mesh: THREE.Mesh): void { this.meshes.push(mesh); }

  build(): void {
    this.meshTree?.geometry.dispose();
    const pieces: THREE.BufferGeometry[] = [];
    const matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
    this.meshCount = 0;
    for (const mesh of this.meshes) {
      mesh.updateWorldMatrix(true, false);
      const count = mesh instanceof THREE.InstancedMesh ? mesh.count : 1;
      for (let index = 0; index < count; index++) {
        matrix.copy(mesh.matrixWorld);
        if (mesh instanceof THREE.InstancedMesh) { mesh.getMatrixAt(index, instance); matrix.multiply(instance); }
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name);
        geometry.clearGroups(); geometry.applyMatrix4(matrix); pieces.push(geometry);
      }
      this.meshCount += count;
    }
    if (!pieces.length) { this.meshTree = null; return; }
    const geometry = mergeGeometries(pieces)!; pieces.forEach(piece => piece.dispose());
    this.meshTree = new MeshBVH(geometry, { targetLeafSize: 12 });
  }

  supportRadius(position: THREE.Vector3, stepHeight = STEP_HEIGHT, bodyRadius = 0): number | null {
    if (!this.meshTree) return null;
    this.collisionUp.copy(position).normalize();
    this.supportRay.origin.copy(position).addScaledVector(this.collisionUp, stepHeight);
    this.supportRay.direction.copy(this.collisionUp).negate();
    const hits = this.meshTree.raycast(this.supportRay, THREE.DoubleSide, 0, stepHeight + 3);
    let distance = Infinity, radius: number | null = null;
    for (const hit of hits) {
      if (!hit.face || hit.distance >= distance) continue;
      const alignment = hit.face.normal.dot(this.collisionUp);
      if (alignment < MIN_SUPPORT_DOT) continue;
      distance = hit.distance;
      radius = hit.point.length() + bodyRadius * (1 / alignment - 1);
    }
    return radius;
  }

  move(position: THREE.Vector3, velocity: THREE.Vector3, delta: number, bodyRadius: number, stepUp: boolean, stepHeight = STEP_HEIGHT): void {
    const steps = Math.max(1, Math.min(48, Math.ceil(velocity.length() * delta / Math.max(0.1, bodyRadius * 0.5))));
    for (let step = 0; step < steps; step++) {
      position.addScaledVector(velocity, delta / steps);
      if (stepUp) {
        const support = this.supportRadius(position, stepHeight, bodyRadius);
        if (support !== null && support > position.length()) position.setLength(support);
      }
      this.resolve(position, bodyRadius, velocity);
    }
  }

  private resolveMesh(position: THREE.Vector3, bodyRadius: number, velocity?: THREE.Vector3): boolean {
    if (!this.meshTree) return false;
    let moved = false;
    for (let iteration = 0; iteration < 4; iteration++) {
      this.collisionUp.copy(position).normalize();
      this.capsule.start.copy(position).addScaledVector(this.collisionUp, bodyRadius);
      this.capsule.end.copy(position).addScaledVector(this.collisionUp, Math.max(bodyRadius, 1.7 - bodyRadius));
      this.capsuleBounds.makeEmpty().expandByPoint(this.capsule.start).expandByPoint(this.capsule.end).expandByScalar(bodyRadius * 1.5);
      let corrected = false;
      this.meshTree.shapecast({
        intersectsBounds: bounds => bounds.intersectsBox(this.capsuleBounds),
        intersectsTriangle: triangle => {
          const distance = triangle.closestPointToSegment(this.capsule, this.trianglePoint, this.capsulePoint);
          if (distance >= bodyRadius - 0.0001) return false;
          this.collisionNormal.subVectors(this.capsulePoint, this.trianglePoint);
          if (distance > 1e-7) this.collisionNormal.multiplyScalar(1 / distance);
          else triangle.getNormal(this.collisionNormal);
          const depth = bodyRadius - distance + 0.0001;
          position.addScaledVector(this.collisionNormal, depth);
          this.capsule.start.addScaledVector(this.collisionNormal, depth); this.capsule.end.addScaledVector(this.collisionNormal, depth);
          if (velocity) { const inward = velocity.dot(this.collisionNormal); if (inward < 0) velocity.addScaledVector(this.collisionNormal, -inward); }
          corrected = true; moved = true; return false;
        },
      });
      if (!corrected) break;
    }
    return moved;
  }

  dispose(): void { this.meshTree?.geometry.dispose(); this.meshTree = null; this.meshes.length = 0; this.list.length = 0; }

  /** Registers a placed object as a solid circle of `radius` metres. */
  add(placement: Placement, radius: number, height = radius, steppable = false): void {
    if (radius <= 0.02) return;
    const position = placement.position.clone();
    this.list.push({
      position,
      positionRadius: position.length(),
      direction: position.clone().normalize(),
      radius,
      height,
      steppable,
      // prefilter for a generous body radius (0.8 m) — the exact overlap is
      // resolved in the tangent plane after this reject
      reachCos: Math.cos((radius + 0.8) / this.planetRadius),
    });
  }

  /**
   * Pushes `position` out of every overlapping obstacle. Cancels the inward
   * component of `velocity` when supplied so the body slides around instead of
   * grinding. Returns true when anything was adjusted.
   */
  resolve(position: THREE.Vector3, bodyRadius: number, velocity?: THREE.Vector3): boolean {
    const up = this.scratchUp.copy(position).normalize();
    let adjusted = false;

    for (const obstacle of this.list) {
      if (up.dot(obstacle.direction) < obstacle.reachCos) continue;

      const to = this.scratchTo.subVectors(obstacle.position, position);
      const vertical = to.dot(up);
      if (Math.abs(vertical) > 4) continue; // far above/below — let it be

      // tangent-plane offset from the body to the obstacle centre
      const tx = to.x - up.x * vertical;
      const ty = to.y - up.y * vertical;
      const tz = to.z - up.z * vertical;
      const distanceSq = tx * tx + ty * ty + tz * tz;
      const minDistance = obstacle.radius + bodyRadius;
      if (distanceSq >= minDistance * minDistance) continue;

      const distance = Math.sqrt(distanceSq);

      // steppable objects (small rocks, bushes) are climbed OVER, never blocked:
      // stand on the ellipsoid cap — smoothly ramps up as the body crosses the
      // footprint, so walking over a knee-high rock just works
      if (obstacle.steppable && obstacle.height <= STEP_HEIGHT) {
        const t = Math.min(1, distance / obstacle.radius);
        const standRadius = obstacle.positionRadius + obstacle.height * Math.sqrt(Math.max(0, 1 - t * t));
        if (position.length() < standRadius) {
          position.multiplyScalar(standRadius / Math.max(1e-6, position.length()));
          adjusted = true;
        }
        continue;
      }
      let nx: number;
      let ny: number;
      let nz: number;
      if (distance > 1e-4) {
        // push AWAY from the obstacle centre (note the flip: `to` points from
        // the body TO the obstacle — a missing sign here sucks the player in
        // and cancels any escape velocity, i.e. “stuck inside objects”)
        nx = -tx / distance;
        ny = -ty / distance;
        nz = -tz / distance;
      } else {
        // dead centre — pick a stable push direction perpendicular to up
        const push = this.scratchPush.set(1, 0, 0);
        if (Math.abs(up.x) > 0.9) push.set(0, 0, 1);
        push.addScaledVector(up, -push.dot(up)).normalize();
        nx = push.x;
        ny = push.y;
        nz = push.z;
      }

      const pushDistance = minDistance - distance;
      position.x += nx * pushDistance;
      position.y += ny * pushDistance;
      position.z += nz * pushDistance;

      if (velocity) {
        const inward = velocity.x * nx + velocity.y * ny + velocity.z * nz;
        if (inward < 0) {
          velocity.x -= nx * inward;
          velocity.y -= ny * inward;
          velocity.z -= nz * inward;
        }
      }
      adjusted = true;
    }

    return this.resolveMesh(position, bodyRadius, velocity) || adjusted;
  }
}
