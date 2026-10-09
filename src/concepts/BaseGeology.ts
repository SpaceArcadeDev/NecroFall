import { Box3, BufferGeometry, ConeGeometry, Float32BufferAttribute, InstancedMesh, Matrix3, Matrix4, Mesh, OctahedronGeometry, Raycaster, Sphere, Vector3 } from 'three/webgpu';

function positionKey(point: Vector3): string {
  return `${Math.round(point.x * 100000)},${Math.round(point.y * 100000)},${Math.round(point.z * 100000)}`;
}

export function boundaryEdges(geometry: BufferGeometry): { start: Vector3; end: Vector3; startKey: string; endKey: string }[] {
  const positions = geometry.getAttribute('position');
  const indices = geometry.index;
  const edges = new Map<string, { start: Vector3; end: Vector3; startKey: string; endKey: string; count: number }>();
  const limit = Math.min(indices?.count ?? positions.count, geometry.drawRange.start + geometry.drawRange.count);
  for (let triangle = geometry.drawRange.start; triangle < limit; triangle += 3) {
    for (let side = 0; side < 3; side++) {
      const start = new Vector3().fromBufferAttribute(positions, indices ? indices.getX(triangle + side) : triangle + side);
      const end = new Vector3().fromBufferAttribute(positions, indices ? indices.getX(triangle + (side + 1) % 3) : triangle + (side + 1) % 3);
      const startKey = positionKey(start), endKey = positionKey(end);
      if (startKey === endKey) continue;
      const key = [startKey, endKey].sort().join('|');
      const edge = edges.get(key);
      if (edge) edge.count++; else edges.set(key, { start, end, startKey, endKey, count: 1 });
    }
  }
  return [...edges.values()].filter(edge => edge.count === 1);
}

export function mountainGeometry(source: BufferGeometry): BufferGeometry {
  source.computeBoundingBox();
  const bounds = source.boundingBox!, center = bounds.getCenter(new Vector3()), size = bounds.getSize(new Vector3());
  const boundary = boundaryEdges(source);
  if (!boundary.length) return source.clone();
  const flat = source.index ? source.toNonIndexed() : source.clone();
  const original = flat.getAttribute('position'), originalNormals = flat.getAttribute('normal'), originalUVs = flat.getAttribute('uv');
  const points = Array.from({ length: original.count }, (_, vertex) => new Vector3().fromBufferAttribute(original, vertex));
  const outward = new Vector3();
  for (let vertex = 0; vertex < points.length; vertex += 3) outward.add(new Vector3().subVectors(points[vertex + 1], points[vertex]).cross(new Vector3().subVectors(points[vertex + 2], points[vertex])));
  if (outward.lengthSq() < 1e-12) outward.set(0, 0, 1);
  outward.normalize();
  const depth = Math.max(size.x, size.y, size.z) * 0.55;
  const lowest = Math.min(...points.map(point => point.clone().sub(center).dot(outward)));
  const mirrorPlane = lowest - depth * 0.5;
  const shellPoint = (point: Vector3, fraction: number): Vector3 => {
    const relative = point.clone().sub(center);
    const axial = relative.dot(outward);
    const tangent = relative.addScaledVector(outward, -axial);
    const breadth = 1 + Math.sin(fraction * Math.PI) * 0.1 - fraction * 0.06;
    return center.clone().addScaledVector(tangent, breadth).addScaledVector(outward, axial + (2 * mirrorPlane - 2 * axial) * fraction);
  };
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const append = (point: Vector3, normal: Vector3, textureX = 0, textureY = 0) => {
    positions.push(...point.toArray()); normals.push(...normal.toArray()); uvs.push(textureX, textureY);
  };
  for (let vertex = 0; vertex < points.length; vertex++) {
    const normal = originalNormals ? new Vector3().fromBufferAttribute(originalNormals, vertex) : outward;
    append(points[vertex], normal, originalUVs?.getX(vertex), originalUVs?.getY(vertex));
  }
  for (let vertex = 0; vertex < points.length; vertex += 3) {
    for (const offset of [0, 2, 1]) {
      const index = vertex + offset;
      const normal = originalNormals ? new Vector3().fromBufferAttribute(originalNormals, index) : outward.clone();
      const axial = normal.dot(outward);
      normal.addScaledVector(outward, -axial).divideScalar(0.94).addScaledVector(outward, -axial).normalize();
      append(shellPoint(points[index], 1), normal, originalUVs?.getX(index), originalUVs?.getY(index));
    }
  }
  for (const edge of boundary) for (let ring = 0; ring < 4; ring++) {
    const start = shellPoint(edge.start, ring / 4), end = shellPoint(edge.end, ring / 4);
    const nextStart = shellPoint(edge.start, (ring + 1) / 4), nextEnd = shellPoint(edge.end, (ring + 1) / 4);
    for (const triangle of [[[start, ring / 4], [nextStart, (ring + 1) / 4], [end, ring / 4]], [[end, ring / 4], [nextStart, (ring + 1) / 4], [nextEnd, (ring + 1) / 4]]] as [Vector3, number][][]) {
      for (const [point, fraction] of triangle) {
        const radial = point.clone().sub(center);
        radial.addScaledVector(outward, -radial.dot(outward)).normalize();
        const normal = radial.multiplyScalar(Math.sin(fraction * Math.PI)).addScaledVector(outward, Math.cos(fraction * Math.PI)).normalize();
        append(point, normal, point.x * 0.02, point.y * 0.02);
      }
    }
  }
  flat.dispose();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.volumeSource = 'authored cliff front with sculpted back and rounded sides';
  geometry.userData.frontVertices = points.length;
  geometry.userData.backThickness = depth;
  return geometry;
}

export function spikeGeometry(_seed: number): BufferGeometry {
  const geometry = new ConeGeometry(0.34, 2.4, 5);
  geometry.translate(0, 1.2, 0);
  return geometry;
}

export function crystalGeometry(): BufferGeometry {
  const geometry = new OctahedronGeometry(0.46, 0);
  geometry.scale(0.5, 1.9, 0.5);
  geometry.translate(0, 0.75, 0);
  return geometry;
}

export interface SurfaceSample {
  height: number;
  slope: number;
  kind: string;
  walkable: boolean;
}

export class BaseSurface {
  readonly solids: { mesh: Mesh; bounds: Box3; kind: string; walkable: boolean }[] = [];
  readonly maxSlope = Math.PI / 4;
  readonly stepHeight = 1.5;
  private readonly ray = new Raycaster();
  private readonly down = new Vector3(0, -1, 0);
  private readonly normalMatrix = new Matrix3();
  private readonly normal = new Vector3();
  private readonly heightAt: (positionX: number, positionZ: number) => number;

  constructor(heightAt: (positionX: number, positionZ: number) => number) { this.heightAt = heightAt; }

  private lowerClearances(geometry: BufferGeometry, matrix: Matrix4): { gaps: number[]; height: number } {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!.clone().applyMatrix4(matrix);
    const height = bounds.max.y - bounds.min.y;
    const positions = geometry.attributes.position;
    const point = new Vector3();
    const gaps: number[] = [];
    const limit = Math.min(geometry.index?.count ?? positions.count, geometry.drawRange.start + geometry.drawRange.count);
    for (let cursor = geometry.drawRange.start; cursor < limit; cursor++) {
      const vertex = geometry.index ? geometry.index.getX(cursor) : cursor;
      point.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
      if (point.y <= bounds.min.y + height * 0.25 + 0.00001) gaps.push(point.y - this.heightAt(point.x, point.z));
    }
    gaps.sort((first, second) => first - second);
    return { gaps, height };
  }

  groundMatrix(geometry: BufferGeometry, matrix: Matrix4): Matrix4 {
    const { gaps, height } = this.lowerClearances(geometry, matrix);
    const grounded = matrix.clone();
    if (gaps.length) grounded.elements[13] -= gaps[Math.floor((gaps.length - 1) * 0.2)] + Math.min(0.25, height * 0.04);
    return grounded;
  }

  flatBaseGap(geometry: BufferGeometry, matrix: Matrix4): number {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const positions = geometry.attributes.position;
    const baseY = geometry.boundingBox!.min.y;
    const unique = new Map<string, Vector3>();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const point = new Vector3().fromBufferAttribute(positions, vertex);
      if (Math.abs(point.y - baseY) < 0.00001 && Math.hypot(point.x, point.z) > 0.0001) unique.set(positionKey(point), point);
    }
    const rim = [...unique.values()].sort((first, second) => Math.atan2(first.z, first.x) - Math.atan2(second.z, second.x));
    let gap = -Infinity;
    for (let side = 0; side < rim.length; side++) for (let along = 0; along <= 6; along++) {
      const edge = rim[side].clone().lerp(rim[(side + 1) % rim.length], along / 6);
      for (let radial = 0; radial <= 6; radial++) {
        const point = edge.clone().multiplyScalar(radial / 6); point.y = baseY; point.applyMatrix4(matrix);
        gap = Math.max(gap, point.y - this.heightAt(point.x, point.z));
      }
    }
    return gap;
  }

  buryFlatBase(geometry: BufferGeometry, matrix: Matrix4): Matrix4 {
    const grounded = matrix.clone();
    grounded.elements[13] -= Math.max(0, this.flatBaseGap(geometry, matrix) + 0.12);
    return grounded;
  }

  conformGeometry(source: BufferGeometry, matrix: Matrix4, airborne = false): BufferGeometry {
    const transform = airborne ? matrix : this.groundMatrix(source, matrix);
    const flat = source.index ? source.toNonIndexed() : source.clone();
    const position = flat.attributes.position, normal = flat.attributes.normal, uv = flat.attributes.uv;
    const normalMatrix = new Matrix3().getNormalMatrix(transform);
    const points = Array.from({ length: position.count }, (_, index) => new Vector3().fromBufferAttribute(position, index).applyMatrix4(transform));
    const bounds = new Box3().setFromPoints(points);
    const height = Math.max(0.001, bounds.max.y - bounds.min.y);
    const underside = new Set<string>();
    for (let vertex = 0; vertex < points.length; vertex += 3) {
      const face = new Vector3().subVectors(points[vertex + 1], points[vertex]).cross(new Vector3().subVectors(points[vertex + 2], points[vertex])).normalize();
      if (face.y < -0.03) for (let corner = 0; corner < 3; corner++) underside.add(positionKey(points[vertex + corner]));
    }
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], changed: boolean[] = [];
    let attachmentGap = -Infinity;
    for (let vertex = 0; vertex < points.length; vertex++) {
      const point = points[vertex].clone();
      const relativeHeight = (point.y - bounds.min.y) / height;
      const isBase = relativeHeight < 0.18 || underside.has(positionKey(point));
      const blend = !airborne && isBase ? Math.max(0, Math.min(1, (0.8 - relativeHeight) / 0.2)) : 0;
      const bed = this.heightAt(point.x, point.z) - Math.min(0.2, height * 0.025);
      const previousY = point.y;
      point.y += (Math.min(point.y, bed) - point.y) * blend;
      changed.push(Math.abs(point.y - previousY) > 0.00001);
      if (blend === 1) attachmentGap = Math.max(attachmentGap, point.y - this.heightAt(point.x, point.z));
      positions.push(...point.toArray());
      normals.push(...(normal ? new Vector3().fromBufferAttribute(normal, vertex).applyNormalMatrix(normalMatrix) : new Vector3(0, 1, 0)).toArray());
      uvs.push(uv?.getX(vertex) ?? 0, uv?.getY(vertex) ?? 0);
    }
    flat.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    changed.forEach((deformed, vertex) => { if (!deformed) geometry.attributes.normal.setXYZ(vertex, normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]); });
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData = { ...source.userData, baseAttachmentGap: attachmentGap };
    return geometry;
  }

  addRange(mesh: Mesh, start: number, count: number, bounds: Box3, data: Record<string, any>, kind: string): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', mesh.geometry.attributes.position);
    geometry.setIndex(mesh.geometry.index);
    geometry.setDrawRange(start, count);
    geometry.boundingBox = bounds.clone(); geometry.boundingSphere = bounds.getBoundingSphere(new Sphere());
    geometry.userData = data;
    this.add(new Mesh(geometry, mesh.material), kind);
  }

  groundingAudit(): { floating: number; gaps: number[]; attachmentGaps: number[] } {
    return { floating: this.solids.filter(solid => solid.kind === 'floating-rock').length,
      gaps: this.solids.filter(solid => ['formation', 'boulder'].includes(solid.kind)).map(solid => this.lowerClearances(solid.mesh.geometry, solid.mesh.matrixWorld).gaps[0] ?? Infinity),
      attachmentGaps: this.solids.filter(solid => ['formation', 'boulder'].includes(solid.kind)).map(solid => solid.mesh.geometry.userData.baseAttachmentGap ?? Infinity) };
  }

  add(mesh: Mesh, kind: string, walkable = true): void {
    mesh.updateMatrixWorld(true);
    const matrices: Matrix4[] = [];
    if (mesh instanceof InstancedMesh) {
      for (let index = 0; index < mesh.count; index++) {
        const matrix = new Matrix4();
        mesh.getMatrixAt(index, matrix);
        matrices.push(matrix.premultiply(mesh.matrixWorld));
      }
    } else matrices.push(mesh.matrixWorld.clone());
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    for (const [index, matrix] of matrices.entries()) {
      const proxy = new Mesh(mesh.geometry, mesh.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(matrix);
      proxy.matrixWorld.copy(matrix);
      this.solids.push({ mesh: proxy, bounds: mesh.geometry.boundingBox!.clone().applyMatrix4(matrix), kind: mesh.userData.floatingInstances?.includes(index) ? 'floating-rock' : kind, walkable });
    }
  }

  allowsVegetation(positionX: number, positionZ: number, padding = 0): boolean {
    return !this.solids.some(({ bounds }) => positionX > bounds.min.x - padding && positionX < bounds.max.x + padding && positionZ > bounds.min.z - padding && positionZ < bounds.max.z + padding);
  }

  visibleFrom(viewer: Vector3, point: Vector3): boolean {
    const direction = point.clone().sub(viewer);
    const distance = direction.length();
    direction.normalize();
    const samples = Math.max(2, Math.ceil(distance / 2));
    for (let sample = 1; sample < samples; sample++) {
      const position = viewer.clone().addScaledVector(direction, distance * sample / samples);
      if (position.y < this.heightAt(position.x, position.z) + 0.1) return false;
    }
    const ray = new Raycaster(viewer, direction, 0.2, Math.max(0.2, distance - 0.2));
    for (const solid of this.solids) if (ray.ray.intersectsBox(solid.bounds) && ray.intersectObject(solid.mesh, false).length) return false;
    return true;
  }

  sample(positionX: number, positionZ: number, referenceHeight?: number): SurfaceSample {
    const height = this.heightAt(positionX, positionZ);
    const gradientX = (this.heightAt(positionX + 0.2, positionZ) - this.heightAt(positionX - 0.2, positionZ)) / 0.4;
    const gradientZ = (this.heightAt(positionX, positionZ + 0.2) - this.heightAt(positionX, positionZ - 0.2)) / 0.4;
    let result: SurfaceSample = { height, slope: Math.atan(Math.hypot(gradientX, gradientZ)), kind: 'terrain', walkable: true };
    for (const solid of this.solids) {
      const { bounds } = solid;
      if (solid.kind === 'floating-rock' && referenceHeight !== undefined && bounds.min.y > referenceHeight + 1.65) continue;
      if (positionX < bounds.min.x || positionX > bounds.max.x || positionZ < bounds.min.z || positionZ > bounds.max.z || bounds.max.y < result.height) continue;
      this.ray.set(new Vector3(positionX, bounds.max.y + 2, positionZ), this.down);
      const hit = this.ray.intersectObject(solid.mesh, false)[0];
      if (!hit?.face || hit.point.y < result.height) continue;
      this.normalMatrix.getNormalMatrix(solid.mesh.matrixWorld);
      this.normal.copy(hit.face.normal).applyNormalMatrix(this.normalMatrix);
      const slope = Math.acos(Math.min(1, Math.max(-1, this.normal.y)));
      result = { height: hit.point.y, slope: hit.point.y - height <= this.stepHeight && solid.walkable ? 0 : slope, kind: solid.kind, walkable: solid.walkable };
    }
    return result;
  }

  step(from: Vector3, deltaX: number, deltaZ: number, radius = 0.35): Vector3 {
    const target = from.clone();
    const segments = Math.max(1, Math.ceil(Math.hypot(deltaX, deltaZ) / 0.2));
    const advance = (moveX: number, moveZ: number): boolean => {
      const positionX = target.x + moveX, positionZ = target.z + moveZ;
      if (Math.abs(positionX) > 170 || positionZ < -270 || positionZ > 86) return false;
      let support = this.sample(positionX, positionZ, target.y);
      for (const [offsetX, offsetZ] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
        const sample = this.sample(positionX + offsetX, positionZ + offsetZ, target.y);
        if (!sample.walkable || sample.slope > this.maxSlope || sample.height - target.y > this.stepHeight) return false;
        if (sample.height > support.height) support = sample;
      }
      if (!support.walkable || support.slope > this.maxSlope || support.height - target.y > this.stepHeight) return false;
      target.set(positionX, support.height, positionZ);
      return true;
    };
    for (let segment = 0; segment < segments; segment++) {
      if (!advance(deltaX / segments, deltaZ / segments)) {
        advance(deltaX / segments, 0);
        advance(0, deltaZ / segments);
      }
    }
    return target;
  }

  spawn(positionX = 33, positionZ = 68): Vector3 {
    for (let radius = 0; radius < 70; radius += 3) for (let side = 0; side < 16; side++) {
      const candidateX = positionX + Math.cos(side * Math.PI / 8) * radius;
      const candidateZ = positionZ + Math.sin(side * Math.PI / 8) * radius;
      if (Math.abs(candidateX) > 160 || candidateZ > 80 || !this.allowsVegetation(candidateX, candidateZ, 2)) continue;
      const sample = this.sample(candidateX, candidateZ);
      if (sample.height <= 0.8 || sample.slope > 0.55) continue;
      const candidate = new Vector3(candidateX, sample.height, candidateZ);
      const clear = Array.from({ length: 8 }, (_, direction) => {
        const target = this.step(candidate, Math.cos(direction * Math.PI / 4), Math.sin(direction * Math.PI / 4));
        return Math.hypot(target.x - candidateX, target.z - candidateZ) > 0.9;
      }).every(Boolean);
      if (clear) return candidate;
    }
    return new Vector3(positionX, this.sample(positionX, positionZ).height, positionZ);
  }
}