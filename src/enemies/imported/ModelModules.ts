import * as THREE from 'three/webgpu';
import type { EnemyAnatomy } from './EnemyAnatomy';

export type MeshModule = 'head' | 'tail';
const geometryCache = new Map<string, THREE.BufferGeometry>();

export function moduleSocket(model: THREE.Object3D, kind: MeshModule): THREE.Bone {
  const pattern = kind === 'head' ? /^Head$|^Head_/ : /^Tail1$|^AbdomenBase_/;
  let found: THREE.Bone | undefined;
  model.traverse(object => { if (!found && object instanceof THREE.Bone && pattern.test(object.name)) found = object; });
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
  return geometry;
}

export function selectMeshModule(model: THREE.Object3D, kind: MeshModule, keep: boolean): void {
  model.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const source = object.geometry;
    const key = `${source.uuid}:${kind}:${keep}`;
    const cached = geometryCache.get(key);
    if (cached) { object.geometry = cached; return; }
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
    const geometry = compactSurface(source, kept);
    geometryCache.set(key, geometry);
    object.geometry = geometry;
  });
}

export function applyModelModules(model: THREE.Object3D, anatomy: EnemyAnatomy): THREE.BufferGeometry[] {
  const owned: THREE.BufferGeometry[] = [];
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
      if (/^Head$|^Head_/.test(bone.name)) bone.scale.multiplyScalar(anatomy.head);
      if (/^Leg[FB][LR]$|^Thigh[lr]|^Bicep[lr]/.test(bone.name)) bone.scale.multiplyScalar(anatomy.limbs);
      if (/^Spine$|^Spine_/.test(bone.name)) bone.scale.x *= anatomy.body;
      if (/^Tail1$|^AbdomenBase_/.test(bone.name) && anatomy.tail > 0) bone.scale.multiplyScalar(anatomy.tail);
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