import * as THREE from 'three/webgpu';
import type { EnemyAnatomy } from './EnemyAnatomy';

export type MeshModule = 'head' | 'tail';
const geometryCache = new Map<string, THREE.BufferGeometry>();

function insideDonor(object: THREE.Object3D): boolean {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (parent.userData.moduleDonor) return true;
  return false;
}

export function moduleSocket(model: THREE.Object3D, kind: MeshModule): THREE.Bone {
  const pattern = kind === 'head' ? /^Head$|^Head_/ : /^Tail1$|^AbdomenBase_/;
  let found: THREE.Bone | undefined;
  model.traverse(object => { if (!found && object instanceof THREE.Bone && !insideDonor(object) && pattern.test(object.name)) found = object; });
  if (!found) throw new Error(`Missing ${kind} module socket`);
  return found;
}

function compactSurface(source: THREE.BufferGeometry, indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices = [...new Set(indices)];
  const remap = new Map(vertices.map((vertex, index) => [vertex, index]));
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const array = name === 'skinIndex' ? new Uint16Array(vertices.length * attribute.itemSize) : new Float32Array(vertices.length * attribute.itemSize);
    vertices.forEach((vertex, index) => {
      for (let component = 0; component < attribute.itemSize; component++) array[index * attribute.itemSize + component] = attribute.getComponent(vertex, component);
    });
    geometry.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize));
  }
  geometry.setIndex(indices.map(index => remap.get(index)!));
  const position = source.attributes.position;
  const key = (vertex: number) => [position.getX(vertex), position.getY(vertex), position.getZ(vertex)].map(value => value.toPrecision(7)).join(',');
  const originalEdges = new Map<string, number>();
  const sourceCount = source.index?.count ?? position.count;
  for (let triangle = 0; triangle < sourceCount; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const first = source.index?.getX(triangle + corner) ?? triangle + corner;
      const second = source.index?.getX(triangle + (corner + 1) % 3) ?? triangle + (corner + 1) % 3;
      const edgeKey = [key(first), key(second)].sort().join('/');
      originalEdges.set(edgeKey, (originalEdges.get(edgeKey) ?? 0) + 1);
    }
  }
  const edges = new Map<string, { count: number; first: number; second: number }>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const first = indices[triangle + corner], second = indices[triangle + (corner + 1) % 3];
      const edgeKey = [key(first), key(second)].sort().join('/');
      const edge = edges.get(edgeKey);
      if (edge) edge.count++;
      else edges.set(edgeKey, { count: 1, first, second });
    }
  }
  geometry.userData.moduleEdges = [...edges.entries()].filter(([edgeKey, edge]) => edge.count === 1 && (originalEdges.get(edgeKey) ?? 0) > 1)
    .flatMap(([, edge]) => [remap.get(edge.first)!, remap.get(edge.second)!]);
  return geometry;
}

export function connectedSurface(source: THREE.BufferGeometry, indices: number[]): number[] {
  const positions = source.attributes.position;
  source.computeBoundingBox();
  const precision = 1e5 / Math.max(source.boundingBox!.getSize(new THREE.Vector3()).length(), 0.001);
  const parents = indices.map((_, index) => index);
  const owners = new Map<string, number>();
  const find = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    for (const vertex of indices.slice(triangle, triangle + 3)) {
      const key = [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)].map(value => Math.round(value * precision)).join(',');
      const owner = owners.get(key);
      if (owner !== undefined) parents[find(triangle)] = find(owner);
      else owners.set(key, triangle);
    }
  }
  const components = new Map<number, number[]>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const root = find(triangle);
    const component = components.get(root) ?? [];
    component.push(...indices.slice(triangle, triangle + 3));
    components.set(root, component);
  }
  return [...components.values()].sort((first, second) => second.length - first.length)[0] ?? [];
}

interface BoundarySurface {
  mesh: THREE.SkinnedMesh;
  probe: THREE.SkinnedMesh;
  edges: number[];
}

export interface ModuleBoundary {
  surfaces: BoundarySurface[];
  centre: THREE.Vector3;
  radius: number;
}

function sampleBoundary(surface: BoundarySurface, vertex: number, point: THREE.Vector3): THREE.Vector3 {
  surface.probe.bindMatrix.copy(surface.mesh.bindMatrix);
  surface.probe.bindMatrixInverse.copy(surface.mesh.bindMatrixInverse);
  return surface.probe.getVertexPosition(vertex, point).applyMatrix4(surface.mesh.matrixWorld);
}

export function selectMeshModule(model: THREE.Object3D, kind: MeshModule, keep: boolean): ModuleBoundary {
  const surfaces: BoundarySurface[] = [];
  model.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh) || insideDonor(object)) return;
    const source = object.geometry;
    const key = `${source.uuid}:${kind}:${keep}`;
    const cached = geometryCache.get(key);
    if (cached) object.geometry = cached;
    else {
    const member = (bone: THREE.Bone): boolean => {
      let current: THREE.Object3D | null = bone;
      while (current instanceof THREE.Bone) {
        if (kind === 'head' && /^Head$|^Head_/.test(current.name)) return true;
        if (kind === 'tail' && /^Tail1$|^AbdomenBase_/.test(current.name)) return true;
        current = current.parent;
      }
      return false;
    };
    const members = object.skeleton.bones.map(member);
    const joints = source.attributes.skinIndex, weights = source.attributes.skinWeight;
    const kept: number[] = [];
    const count = source.index?.count ?? source.attributes.position.count;
    for (let triangle = 0; triangle < count; triangle += 3) {
      const vertices = [0, 1, 2].map(corner => source.index ? source.index.getX(triangle + corner) : triangle + corner);
      let ownership = 0;
      for (const vertex of vertices) for (let slot = 0; slot < 4; slot++) if (members[joints.getComponent(vertex, slot)]) ownership += weights.getComponent(vertex, slot);
      if (keep ? ownership > 0.9 : ownership < 1.8) kept.push(...vertices);
    }
    const geometry = compactSurface(source, connectedSurface(source, kept));
    geometryCache.set(key, geometry);
    object.geometry = geometry;
    }
    const edges = object.geometry.userData.moduleEdges as number[];
    const probe = new THREE.SkinnedMesh(object.geometry, object.material);
    probe.skeleton = object.skeleton;
    surfaces.push({ mesh: object, probe, edges });
  });
  model.updateMatrixWorld(true);
  const points = surfaces.flatMap(surface => [...new Set(surface.edges)].map(vertex => sampleBoundary(surface, vertex, new THREE.Vector3())));
  const centre = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(Math.max(1, points.length));
  const radius = Math.sqrt(points.reduce((sum, point) => sum + point.distanceToSquared(centre), 0) / Math.max(1, points.length));
  return { surfaces, centre, radius };
}

export class ModuleJoin {
  readonly mesh: THREE.Mesh;
  private readonly bindings: { surface: BoundarySurface; vertex: number }[] = [];
  private readonly point = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();

  constructor(host: ModuleBoundary, donor: ModuleBoundary, source: THREE.MeshStandardMaterial, kind: MeshModule) {
    const anchors = host.surfaces.flatMap(surface => [...new Set(surface.edges)].map(vertex => ({ surface, vertex, point: sampleBoundary(surface, vertex, new THREE.Vector3()) })));
    const indices: number[] = [];
    for (const surface of donor.surfaces) {
      for (let edge = 0; edge < surface.edges.length && anchors.length > 0; edge += 2) {
        const ends = surface.edges.slice(edge, edge + 2).map(vertex => ({ surface, vertex }));
        const nearest = ends.map(end => {
          sampleBoundary(end.surface, end.vertex, this.point);
          return anchors.reduce((best, anchor) => anchor.point.distanceToSquared(this.point) < best.point.distanceToSquared(this.point) ? anchor : best);
        });
        const start = this.bindings.length;
        this.bindings.push(ends[0], ends[1], nearest[1], nearest[0]);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.bindings.length * 3), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.bindings.flatMap(binding => {
      const uv = binding.surface.probe.geometry.attributes.uv;
      return uv ? [uv.getX(binding.vertex), uv.getY(binding.vertex)] : [0, 0];
    }), 2));
    geometry.setIndex(indices);
    const material = source.clone();
    material.name = `suture:${kind}`;
    material.side = THREE.DoubleSide;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `${kind}-suture`;
    this.mesh.frustumCulled = false;
    this.mesh.userData.moduleJoin = true;
    this.update();
  }

  update(): void {
    this.inverse.copy(this.mesh.matrixWorld).invert();
    const positions = this.mesh.geometry.attributes.position;
    this.bindings.forEach((binding, index) => {
      sampleBoundary(binding.surface, binding.vertex, this.point).applyMatrix4(this.inverse);
      positions.setXYZ(index, this.point.x, this.point.y, this.point.z);
    });
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  diagnostics() {
    const actual = new THREE.Vector3();
    let gap = 0;
    this.bindings.forEach((binding, index) => {
      actual.fromBufferAttribute(this.mesh.geometry.attributes.position, index).applyMatrix4(this.mesh.matrixWorld);
      gap = Math.max(gap, actual.distanceTo(sampleBoundary(binding.surface, binding.vertex, this.point)));
    });
    return { vertices: this.bindings.length, gap };
  }

  dispose(): void { this.mesh.geometry.dispose(); }
}

export function applyModelModules(model: THREE.Object3D, anatomy: EnemyAnatomy): THREE.BufferGeometry[] {
  const owned: THREE.BufferGeometry[] = [];
  model.scale.z *= anatomy.length ?? 1;
  const seen = new Set<THREE.Bone>();
  model.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const removed = new Set<number>();
    object.skeleton.bones.forEach((bone, index) => {
      const tail = /^Tail\d|^AbdomenBase_|^abdomen_|^stinger_/.test(bone.name);
      const wing = /^wing/.test(bone.name);
      if (tail && anatomy.tail === 0 || wing && !anatomy.wings) removed.add(index);
      if (seen.has(bone)) return;
      seen.add(bone);
      if (/^Head$|^Head_/.test(bone.name)) bone.scale.multiplyScalar((anatomy.headBase ?? anatomy.base) === anatomy.base ? anatomy.head : 1);
      if (/^Leg[FB][LR]$|^Thigh[lr]|^Bicep[lr]/.test(bone.name)) bone.scale.multiplyScalar(anatomy.limbs);
      if (/^Spine$|^Spine_/.test(bone.name)) bone.scale.x *= anatomy.body;
      if (/^Tail1$|^AbdomenBase_/.test(bone.name) && anatomy.tail > 0 && (anatomy.tailBase ?? anatomy.base) === anatomy.base) bone.scale.multiplyScalar(anatomy.tail);
    });
    if (removed.size === 0) return;
    const geometry = object.geometry;
    const indices = geometry.index;
    const joints = geometry.attributes.skinIndex;
    const weights = geometry.attributes.skinWeight;
    const kept: number[] = [];
    const count = indices?.count ?? geometry.attributes.position.count;
    for (let triangle = 0; triangle < count; triangle += 3) {
      let removedWeight = 0;
      const vertices = [0, 1, 2].map(corner => indices ? indices.getX(triangle + corner) : triangle + corner);
      for (const vertex of vertices) for (let slot = 0; slot < 4; slot++) {
        if (removed.has(joints.getComponent(vertex, slot))) removedWeight += weights.getComponent(vertex, slot);
      }
      if (removedWeight < 1.25) kept.push(...vertices);
    }
    const key = `${geometry.uuid}:${[...removed].join(',')}`;
    let moduleGeometry = geometryCache.get(key);
    if (!moduleGeometry) { moduleGeometry = compactSurface(geometry, kept); geometryCache.set(key, moduleGeometry); }
    object.geometry = moduleGeometry;
  });
  model.updateMatrixWorld(true);
  return owned;
}