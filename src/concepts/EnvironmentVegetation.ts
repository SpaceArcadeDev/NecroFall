import {
  BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Group,
  InstancedMesh, Matrix4, Mesh, Object3D, PlaneGeometry, Vector3,
} from 'three/webgpu';
import { attribute, cameraPosition, color, float, mix, normalWorldGeometry, positionLocal, sin, smoothstep, texture, uv, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRASS_ACCEPTANCE_POWER } from '../rendering/Environment/GrassField';
import { randomSource, type PlanetStudy } from './definitions';
import { landscapeGrassCoverage, landscapeHeight } from './AssetLandscape';
import { EnvironmentMaterial } from './EnvironmentStyle';

export function patchGrass(study: PlanetStudy, seed: number, mobile: boolean, clock: any, allowsPlacement: (positionX: number, positionZ: number) => boolean = () => true): Group {
  const root = new Group();
  root.name = 'study-grass';
  const sectors = new Map<string, { positions: number[]; sides: number[]; tips: number[]; heights: number[]; variations: number[]; indices: number[] }>();
  const random = randomSource(seed + 2281);
  const spacing = 0.39;
  let blades = 0;
  for (let row = 0; row < 539; row++) for (let column = 0; column < 539; column++) {
    const jitterX = random(), jitterZ = random(), keep = random(), variation = random();
    const positionX = -105 + (column + jitterX * 0.8) * spacing;
    const positionZ = -119 + (row + jitterZ * 0.8) * spacing;
    if (mobile && variation > 0.58) continue;
    if (!allowsPlacement(positionX, positionZ)) continue;
    const coverage = landscapeGrassCoverage(positionX, positionZ, seed, study);
    if (keep > Math.pow(coverage, GRASS_ACCEPTANCE_POWER)) continue;
    const height = landscapeHeight(positionX, positionZ, seed, study);
    if (height < 0.85) continue;
    const waterTaper = Math.min(1, (height - 0.65) / 1.8);
    const size = (1 + variation * 0.84) * waterTaper * (study.flora === 'crystal' ? 0.65 : 1);
    const key = `${Math.floor(positionX / 32)}:${Math.floor(positionZ / 32)}`;
    let sector = sectors.get(key);
    if (!sector) {
      sector = { positions: [], sides: [], tips: [], heights: [], variations: [], indices: [] };
      sectors.set(key, sector);
    }
    const offset = sector.positions.length / 3;
    const sides = [-0.5, 0.5, -0.3, 0.3, 0];
    const tips = [0, 0, 0.58, 0.58, 1];
    for (let vertex = 0; vertex < 5; vertex++) {
      sector.positions.push(positionX, height - 0.03, positionZ);
      sector.sides.push(sides[vertex]);
      sector.tips.push(tips[vertex]);
      sector.heights.push(size);
      sector.variations.push(variation);
    }
    sector.indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2, offset + 2, offset + 3, offset + 4);
    blades++;
  }
  const tip = attribute('bladeTip', 'float');
  const variation = attribute('bladeVariation', 'float');
  const bottom = new Color(study.ground).multiplyScalar(0.7);
  const top = new Color(study.highland).lerp(new Color(study.flora === 'fungus' ? study.infection : '#d8e45f'), study.flora === 'crystal' ? 0.05 : 0.2);
  const material = new EnvironmentMaterial({
    study, base: mix(color(bottom), color(top), tip.mul(0.78).add(variation.mul(0.15))),
    normal: vec3(0, 1, 0), rootShade: mix(float(0.6), float(1), tip),
    emission: study.flora === 'fungus' ? color(study.infection).mul(tip.pow(3)).mul(0.06) : undefined,
    radiationMask: smoothstep(0.74, 0.97, tip).mul(smoothstep(0.62, 0.78, sin(variation.mul(79)).mul(0.5).add(0.5))).mul(2.4).add(tip.pow(4).mul(0.1)),
    side: DoubleSide, shadows: false,
  });
  const anchor = attribute('position', 'vec3');
  const toCamera = cameraPosition.sub(anchor);
  const right = vec3(toCamera.z.add(0.0001), 0, toCamera.x.negate().add(0.0001)).normalize();
  const width = variation.mul(0.08).add(0.14);
  const wind = sin(anchor.x.mul(0.12).add(anchor.z.mul(0.085)).add(clock.mul(1.25))).mul(tip.pow(2));
  material.positionNode = positionLocal.add(right.mul(attribute('bladeSide', 'float')).mul(width))
    .add(vec3(wind.mul(0.42).add(variation.sub(0.5).mul(tip.pow(2)).mul(0.5)), tip.mul(attribute('bladeHeight', 'float')), wind.mul(0.17)));
  for (const [key, sector] of sectors) {
    const geometry = new BufferGeometry();
    geometry.setIndex(sector.indices);
    geometry.setAttribute('position', new Float32BufferAttribute(sector.positions, 3));
    geometry.setAttribute('bladeSide', new Float32BufferAttribute(sector.sides, 1));
    geometry.setAttribute('bladeTip', new Float32BufferAttribute(sector.tips, 1));
    geometry.setAttribute('bladeHeight', new Float32BufferAttribute(sector.heights, 1));
    geometry.setAttribute('bladeVariation', new Float32BufferAttribute(sector.variations, 1));
    const normals = new Float32Array(sector.positions.length);
    for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.computeBoundingBox();
    geometry.boundingBox!.max.y += 2;
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius += 2.5;
    const mesh = new Mesh(geometry, material);
    mesh.name = `patch-grass:${key}`;
    root.add(mesh);
  }
  root.userData.blades = blades;
  root.userData.source = 'Original GrassField coverage and Grass shader-blade approach';
  return root;
}

export function leafTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  for (const [translateX, translateY, angle, scale] of [[52, 71, -0.9, 1], [76, 69, 0.35, 0.75], [56, 90, -1.7, 0.55]]) {
    context.save();
    context.translate(translateX, translateY);
    context.rotate(angle);
    context.scale(scale, scale);
    context.beginPath();
    context.moveTo(-7, 27);
    context.bezierCurveTo(-37, 3, -21, -29, 17, -51);
    context.bezierCurveTo(36, -12, 23, 14, -7, 27);
    context.fill();
    context.restore();
  }
  return new CanvasTexture(canvas);
}

function foliageCloud(study: PlanetStudy, count: number): BufferGeometry {
  const random = randomSource(8141);
  const pieces: BufferGeometry[] = [];
  const shape = study.flora === 'sail' ? [0.78, 1.3, 0.78] : study.flora === 'coral' ? [1.15, 0.72, 1.15] : study.flora === 'crystal' ? [0.9, 0.55, 0.9] : [1.25, 0.72, 1.25];
  for (let index = 0; index < count; index++) {
    const azimuth = random() * Math.PI * 2, elevation = Math.acos(random() * 2 - 1);
    const radius = 1 - Math.pow(random(), 3);
    const point = new Vector3(Math.cos(azimuth) * Math.sin(elevation) * radius * shape[0], Math.cos(elevation) * radius * shape[1], Math.sin(azimuth) * Math.sin(elevation) * radius * shape[2]);
    for (let twin = 0; twin < 2; twin++) {
      const card = new PlaneGeometry(0.95, 0.95);
      card.rotateZ(random() * Math.PI * 2);
      if (twin) card.rotateX(Math.PI / 2);
      card.translate(point.x, point.y, point.z);
      const normal = new Vector3(point.x * 0.6, point.y * 1.6 + 0.6, point.z * 0.6).normalize();
      const normals: number[] = [];
      for (let vertex = 0; vertex < 4; vertex++) normals.push(normal.x, normal.y, normal.z);
      card.setAttribute('normal', new Float32BufferAttribute(normals, 3));
      pieces.push(card);
    }
  }
  const result = mergeGeometries(pieces)!;
  pieces.forEach((piece) => piece.dispose());
  return result;
}

export function projectTrees(template: Object3D, placements: Matrix4[], study: PlanetStudy, mobile: boolean, clock: any): Group {
  const root = new Group();
  root.name = 'study-trees';
  const markers: Matrix4[] = [];
  template.updateMatrixWorld(true);
  template.traverse((object) => {
    if (object.name.startsWith('treeLeaves')) markers.push(object.matrixWorld.clone());
    if (!(object instanceof Mesh) || !object.name.startsWith('treeBody')) return;
    const trunks = new InstancedMesh(object.geometry, object.material, placements.length);
    placements.forEach((matrix, index) => trunks.setMatrixAt(index, matrix.clone().multiply(object.matrixWorld)));
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    trunks.computeBoundingSphere();
    root.add(trunks);
  });
  const map = leafTexture();
  const base = mix(color(study.foliage), color(study.foliageLight), smoothstep(-0.2, 0.9, normalWorldGeometry.y));
  const material = new EnvironmentMaterial({ study, base, alpha: texture(map, uv()).a, alphaTest: 0.25, side: DoubleSide,
    radiationMask: smoothstep(0.2, 0.9, uv().y).mul(0.6).add(smoothstep(0.02, 0.005, uv().x.sub(0.5).abs()).mul(0.25)) });
  material.map = map;
  material.positionNode = positionLocal.add(vec3(sin(positionLocal.x.mul(0.16).add(positionLocal.z.mul(0.11)).add(clock)).mul(0.12), 0, sin(positionLocal.x.mul(0.1).add(clock.mul(0.8))).mul(0.08)));
  const leaves = new InstancedMesh(foliageCloud(study, mobile ? 62 : 90), material, placements.length * markers.length);
  let cursor = 0;
  for (const placement of placements) for (const marker of markers) leaves.setMatrixAt(cursor++, placement.clone().multiply(marker));
  leaves.castShadow = !mobile;
  leaves.receiveShadow = true;
  leaves.computeBoundingSphere();
  root.add(leaves);
  root.userData.source = 'Original Trees trunk/marker assets and crossed-card Foliage approach';
  return root;
}