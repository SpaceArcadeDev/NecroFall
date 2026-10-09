import { Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3, type Material } from 'three/webgpu';
import { color } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mountainGeometry } from '../../concepts/BaseGeology';
import { scatterPlacements, type Placement } from '../../planet/Placement';
import { createRenderedRadiusAt } from '../../planet/RenderedTerrain';
import { SurfaceMaterial } from '../materials/SurfaceMaterial';
import type { PlanetWorldDependencies } from './PlanetRenderer';

export const BASE_ASSETS = {
  boulder: new URL('../../concepts/assets/boulder-far.glb', import.meta.url).href,
  mountain: new URL('../../concepts/assets/cliff-far.glb', import.meta.url).href,
  mushroom: new URL('../../concepts/assets/mushroom-far.glb', import.meta.url).href,
  parasite: new URL('../../concepts/assets/parasite-near.glb', import.meta.url).href,
};

export function normalisedAsset(root: Group, mountain = false): { geometry: BufferGeometry; source: Material }[] {
  root.updateMatrixWorld(true);
  const parts: { geometry: BufferGeometry; source: Material }[] = [];
  const bounds = new Box3();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const source = mountain ? mountainGeometry(object.geometry) : object.geometry.clone();
    const position = source.attributes.position, normal = source.attributes.normal, sourceUV = source.attributes.uv;
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    for (let vertex = 0; vertex < position.count; vertex++) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      normals.push(normal?.getX(vertex) ?? 0, normal?.getY(vertex) ?? 1, normal?.getZ(vertex) ?? 0);
      uvs.push(sourceUV?.getX(vertex) ?? 0, sourceUV?.getY(vertex) ?? 0);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.userData = { ...source.userData };
    if (source.index) geometry.setIndex(source.index.clone());
    geometry.applyMatrix4(object.matrixWorld); geometry.computeBoundingBox(); bounds.union(geometry.boundingBox!);
    parts.push({ geometry, source: Array.isArray(object.material) ? object.material[0] : object.material }); source.dispose();
  });
  const center = bounds.getCenter(new Vector3()), height = Math.max(0.001, bounds.max.y - bounds.min.y);
  for (const part of parts) { part.geometry.translate(-center.x, -bounds.min.y, -center.z); part.geometry.scale(1 / height, 1 / height, 1 / height); part.geometry.computeBoundingBox(); }
  return parts;
}

export function bakeRadialGeometry(source: BufferGeometry, placement: Placement, radiusAt: (direction: Vector3) => number): BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  const local = geometry.attributes.position;
  source.computeBoundingBox();
  const height = Math.max(0.001, source.boundingBox!.max.y - source.boundingBox!.min.y);
  const heights = Array.from({ length: local.count }, (_, vertex) => (local.getY(vertex) - source.boundingBox!.min.y) / height);
  geometry.applyMatrix4(placement.matrix);
  const positions = geometry.attributes.position;
  const originalNormals = geometry.attributes.normal.clone();
  const changed = new Uint8Array(positions.count);
  const underside = new Set<string>();
  const key = (vertex: number) => `${positions.getX(vertex).toFixed(5)},${positions.getY(vertex).toFixed(5)},${positions.getZ(vertex).toFixed(5)}`;
  const first = new Vector3(), second = new Vector3(), third = new Vector3();
  const up = placement.position.clone().normalize();
  for (let vertex = 0; vertex < positions.count; vertex += 3) {
    first.fromBufferAttribute(positions, vertex); second.fromBufferAttribute(positions, vertex + 1); third.fromBufferAttribute(positions, vertex + 2);
    if (second.sub(first).cross(third.sub(first)).normalize().dot(up) < -0.03) {
      for (let corner = 0; corner < 3; corner++) underside.add(key(vertex + corner));
    }
  }
  const point = new Vector3(), direction = new Vector3();
  for (let vertex = 0; vertex < positions.count; vertex++) {
    if (heights[vertex] >= 0.18 && !underside.has(key(vertex))) continue;
    point.fromBufferAttribute(positions, vertex); direction.copy(point).normalize();
    const target = radiusAt(direction) - 0.08;
    const blend = Math.max(0, Math.min(1, (0.8 - heights[vertex]) / 0.2));
    if (point.length() > target && blend > 0) { point.lerp(direction.multiplyScalar(target), blend); changed[vertex] = 1; }
    positions.setXYZ(vertex, point.x, point.y, point.z);
  }
  geometry.computeVertexNormals();
  for (let vertex = 0; vertex < positions.count; vertex++) if (!changed[vertex]) geometry.attributes.normal.setXYZ(vertex, originalNormals.getX(vertex), originalNormals.getY(vertex), originalNormals.getZ(vertex));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export class BaseRocks {
  readonly group = new Group();
  count = 0;
  readonly mountainCount: number;
  private readonly excluded = new Uint8Array(128 * 256);
  private constructor(private readonly deps: PlanetWorldDependencies, mountains: number) { this.mountainCount = mountains; this.group.name = 'base-planet-geology'; }

  static async create(deps: PlanetWorldDependencies): Promise<BaseRocks> {
    const plans = [
      { kind: 'boulder', url: BASE_ASSETS.boulder, count: 110, minimum: 0.6, maximum: 3.2, salt: 5101 },
      { kind: 'mountain', url: BASE_ASSETS.mountain, count: 14, minimum: 13, maximum: 25, salt: 5119 },
    ];
    const result = new BaseRocks(deps, plans[1].count);
    const radiusAt = createRenderedRadiusAt(deps.generator);
    const footprints: { direction: Vector3; cosine: number }[] = [];
    for (const plan of plans) {
      const asset = await deps.loader.loadGLTF(plan.url);
      const parts = normalisedAsset(asset.scene, plan.kind === 'mountain');
      const bounds = new Box3(); parts.forEach(part => bounds.union(part.geometry.boundingBox!));
      const extent = Math.hypot(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)), Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)));
      const placements = scatterPlacements(deps.surface, deps.generator, { count: plan.count, salt: plan.salt,
        scaleMin: plan.minimum, scaleMax: plan.maximum, maxSlope: plan.kind === 'mountain' ? 0.5 : 0.6,
        aboveWater: -0.1, attemptsPerInstance: 30, excludeDirection: deps.spawnDirection, excludeRadius: 12 + plan.maximum * extent });
      for (const placement of placements) {
        const footprint = placement.scale * extent;
        footprints.push({ direction: placement.position.clone().normalize(), cosine: Math.cos((footprint + 2) / deps.surface.radius) });
      }
      for (const part of parts) {
        const material = new SurfaceMaterial({ colorNode: color(deps.generator.archetype.art!.rock), playerOcclusion: true, hasLightBounce: false });
        const sectors = new Map<number, BufferGeometry[]>();
        for (const placement of placements) {
          const direction = placement.position.clone().normalize();
          const sector = (direction.y > 0 ? 4 : 0) + Math.min(3, Math.floor((Math.atan2(direction.z, direction.x) + Math.PI) / (Math.PI * 0.5)));
          if (!sectors.has(sector)) sectors.set(sector, []);
          sectors.get(sector)!.push(bakeRadialGeometry(part.geometry, placement, radiusAt));
        }
        for (const pieces of sectors.values()) {
          const geometry = mergeGeometries(pieces)!; pieces.forEach(piece => piece.dispose());
          const mesh = new Mesh(geometry, material); mesh.name = `base-${plan.kind}`;
          mesh.castShadow = plan.kind === 'mountain'; mesh.receiveShadow = true; result.group.add(mesh);
        }
        part.geometry.dispose();
      }
      result.count += placements.length;
    }
    for (let latitude = 0; latitude < 128; latitude++) for (let longitude = 0; longitude < 256; longitude++) {
      const polar = (latitude + 0.5) / 128 * Math.PI, angle = (longitude + 0.5) / 256 * Math.PI * 2 - Math.PI;
      const position = new Vector3(Math.sin(polar) * Math.cos(angle), Math.cos(polar), Math.sin(polar) * Math.sin(angle));
      if (footprints.some(footprint => position.dot(footprint.direction) > footprint.cosine)) result.excluded[latitude * 256 + longitude] = 1;
    }
    result.group.userData.basePlanet = deps.generator.archetype.basePlanetId;
    return result;
  }

  blocked(positionX: number, positionY: number, positionZ: number): boolean {
    const length = Math.hypot(positionX, positionY, positionZ) || 1;
    const latitude = Math.min(127, Math.floor(Math.acos(Math.max(-1, Math.min(1, positionY / length))) / Math.PI * 128));
    const longitude = Math.min(255, Math.floor((Math.atan2(positionZ, positionX) + Math.PI) / (Math.PI * 2) * 256));
    return this.excluded[latitude * 256 + longitude] !== 0;
  }
  setVisible(visible: boolean): void { this.group.visible = visible; }
  dispose(): void {
    const materials = new Set<Material>();
    this.group.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); materials.add(object.material as Material); } });
    materials.forEach(material => material.dispose()); this.group.clear();
  }
}