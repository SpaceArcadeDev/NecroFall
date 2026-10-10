import { BackSide, BufferGeometry, CircleGeometry, CylinderGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Group, InstancedMesh, LatheGeometry, Mesh, MeshBasicNodeMaterial, Object3D, PerspectiveCamera, Shape, SphereGeometry, Vector2, Vector3, type Camera, type Matrix4 } from 'three/webgpu';
import { attribute, cameraFar, cameraNear, cameraPosition, cameraViewMatrix, color, float, Fn, Loop, max, min, mix, mx_noise_float, perspectiveDepthToViewZ, positionLocal, positionWorld, screenUV, sin, smoothstep, texture, uniform, vec2, vec3, vec4, viewportDepthTexture } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BaseSurface } from './BaseGeology';
import { landscapeHeight } from './AssetLandscape';
import { EnvironmentMaterial } from './EnvironmentStyle';
import { particleTexture } from './EnvironmentWeather';
import { BASE_CAMERA_FOV, randomSource, type PlanetStudy } from './definitions';

type FeatureKind = 'flower' | 'reed' | 'fern' | 'pod' | 'mist' | 'vortex' | 'whirlpool' | 'volcano' | 'blizzard';
export interface BaseFeature { id: string; name: string; kind: FeatureKind; size: number; shape: number }
const feature = (id: string, name: string, kind: FeatureKind, size: number, shape = 7): BaseFeature => ({ id, name, kind, size, shape });
export const BASE_FEATURES: Record<string, readonly [BaseFeature, BaseFeature, BaseFeature]> = {
  cinderbloom: [feature('cinder-lilies', 'Cinder lilies', 'flower', 1.3, 6), feature('ember-reeds', 'Ember reeds', 'reed', 1.6, 5), feature('pollen-hollows', 'Pollen hollows', 'mist', 1)],
  'glass-tide': [feature('tide-anemones', 'Tide anemones', 'flower', 0.9, 12), feature('ribbon-kelp', 'Ribbon kelp', 'reed', 1.8, 4), feature('tidal-gyres', 'Tidal gyres', 'whirlpool', 1.2)],
  'saffron-waste': [feature('solar-cups', 'Solar cups', 'flower', 0.8, 5), feature('razor-sedges', 'Razor sedges', 'reed', 1.25, 9), feature('dust-devils', 'Dust devils', 'vortex', 1)],
  'mycelial-night': [feature('lantern-pods', 'Lantern pods', 'pod', 1.3, 5), feature('spore-ferns', 'Spore ferns', 'fern', 1.2, 8), feature('spore-hollows', 'Spore hollows', 'mist', 1.2)],
  frostwound: [feature('frost-bells', 'Frost bells', 'flower', 0.85, 4), feature('ice-blades', 'Ice blades', 'reed', 1.3, 6), feature('blizzard-pockets', 'Blizzard pockets', 'blizzard', 1)],
  'verdant-tempest': [feature('rain-orchids', 'Rain orchids', 'flower', 1.4, 8), feature('giant-ferns', 'Giant ferns', 'fern', 2.2, 11), feature('mist-gullies', 'Mist gullies', 'mist', 1.1)],
  emberwake: [feature('lava-vents', 'Lava vents', 'volcano', 1), feature('ash-flowers', 'Ash flowers', 'flower', 0.75, 3), feature('fumaroles', 'Fumaroles', 'mist', 0.7)],
  'roseshard-basin': [feature('salt-rosettes', 'Salt rosettes', 'flower', 0.7, 9), feature('glass-sedges', 'Glass sedges', 'reed', 1.1, 7), feature('brine-gyres', 'Brine gyres', 'whirlpool', 0.85)],
  'stormglass-reach': [feature('storm-lilies', 'Storm lilies', 'flower', 1.1, 6), feature('conductive-reeds', 'Conductive reeds', 'reed', 1.55, 3), feature('ion-vortices', 'Ion vortices', 'vortex', 1.15)],
  'aether-garden': [feature('sky-lotus', 'Sky lotus', 'flower', 1.4, 10), feature('suspended-seedpods', 'Suspended seedpods', 'pod', 1.1, 3), feature('cloud-ribbons', 'Cloud ribbons', 'mist', 1.4)],
};

function leafGeometry(): BufferGeometry {
  const outline = new Shape();
  outline.moveTo(0, 0);
  outline.bezierCurveTo(-0.4, 0.3, -0.28, 0.8, 0, 1);
  outline.bezierCurveTo(0.3, 0.65, 0.35, 0.2, 0, 0);
  const geometry = new ExtrudeGeometry(outline, { depth: 0.035, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.018, bevelThickness: 0.015, steps: 1, curveSegments: 4 });
  const positions = geometry.attributes.position;
  for (let vertex = 0; vertex < positions.count; vertex++) positions.setZ(vertex, positions.getZ(vertex) + Math.sin(positions.getY(vertex) * Math.PI) * 0.17);
  geometry.computeVertexNormals();
  return geometry;
}

function combine(pieces: BufferGeometry[]): BufferGeometry {
  const expanded = pieces.map(piece => {
    const geometry = piece.index ? piece.toNonIndexed() : piece;
    geometry.deleteAttribute('uv');
    return geometry;
  });
  const geometry = mergeGeometries(expanded)!;
  new Set([...pieces, ...expanded]).forEach(piece => piece.dispose());
  return geometry;
}

export function floraGeometry(spec: BaseFeature): { body: BufferGeometry; accent: BufferGeometry } {
  const leaves: BufferGeometry[] = [], petals: BufferGeometry[] = [];
  const template = leafGeometry();
  const stemHeight = spec.kind === 'reed' ? 2.8 : spec.kind === 'fern' ? 1.6 : spec.kind === 'pod' ? 1.5 : spec.shape === 9 ? 0.18 : 0.9;
  const stem = new CylinderGeometry(0.028, 0.055, stemHeight, 5);
  stem.translate(0, stemHeight / 2, 0); leaves.push(stem);
  if (spec.kind === 'fern') {
    for (let frond = 0; frond < 5; frond++) for (let level = 0; level < spec.shape; level++) for (const side of [-1, 1]) {
      const leaf = template.clone();
      leaf.scale(0.16, 0.48 * (1 - level / (spec.shape + 2)), 0.6);
      leaf.rotateZ(side * 1.0); leaf.rotateX(0.45);
      leaf.translate(side * 0.06, 0.22 + level * 0.15, level * 0.045);
      leaf.rotateY(frond * Math.PI * 2 / 5); leaves.push(leaf);
    }
    const bud = new SphereGeometry(0.075, 6, 4); bud.translate(0, stemHeight, 0); petals.push(bud);
  } else if (spec.kind === 'reed') {
    for (let blade = 0; blade < spec.shape; blade++) {
      const leaf = template.clone();
      leaf.scale(0.32, 1.8 + (blade % 3) * 0.45, 0.65);
      leaf.rotateZ(0.16 + blade % 2 * 0.2); leaf.rotateY(blade * 2.4); leaves.push(leaf);
    }
    const head = new CylinderGeometry(0.075, 0.12, 0.46, 5); head.translate(0, stemHeight, 0); petals.push(head);
  } else {
    for (let leafIndex = 0; leafIndex < 3; leafIndex++) {
      const leaf = template.clone(); leaf.scale(0.75, 0.65, 0.7); leaf.rotateZ(0.9); leaf.rotateY(leafIndex * 2.1); leaf.translate(0, 0.15, 0); leaves.push(leaf);
    }
    for (let petal = 0; petal < spec.shape; petal++) {
      const leaf = template.clone();
      leaf.scale(spec.kind === 'pod' ? 0.8 : 0.65, spec.kind === 'pod' ? 0.85 : 0.68, 0.9);
      leaf.rotateX(spec.kind === 'pod' ? 0.35 : spec.shape === 4 ? 2.25 : 1.12);
      leaf.rotateY(petal * Math.PI * 2 / spec.shape); leaf.translate(0, stemHeight, 0); petals.push(leaf);
    }
    const heart = new SphereGeometry(0.14, 8, 5); heart.translate(0, stemHeight + 0.09, 0); petals.push(heart);
  }
  template.dispose();
  return { body: combine(leaves), accent: combine(petals) };
}

export function volumeMaterial(study: PlanetStudy, center: Vector3, size: Vector3, clock: any, inverseFrame?: Matrix4, smoke = false): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: BackSide, fog: false, toneMapped: false });
  material.outputNode = Fn(() => {
    const direction = positionWorld.sub(cameraPosition).normalize();
    const origin = inverseFrame ? uniform(inverseFrame).mul(vec4(cameraPosition, 1)).xyz : cameraPosition.sub(vec3(center)).div(vec3(size));
    const ray = inverseFrame ? uniform(inverseFrame).mul(vec4(direction, 0)).xyz : direction.div(vec3(size));
    const coefficient = ray.dot(ray), projection = origin.dot(ray);
    const root = max(projection.mul(projection).sub(coefficient.mul(origin.dot(origin).sub(1))), 0).sqrt();
    const start = max(projection.negate().sub(root).div(coefficient), 0);
    const viewDepth = perspectiveDepthToViewZ(viewportDepthTexture(screenUV), cameraNear, cameraFar);
    const sceneDistance = viewDepth.div(cameraViewMatrix.mul(vec4(direction, 0)).z);
    const end = min(projection.negate().add(root).div(coefficient), sceneDistance);
    const samples = smoke ? 18 : 8;
    const stride = max(end.sub(start), 0).div(samples);
    const density = float(0).toVar();
    const scattering = vec3(0).toVar();
    const transmission = float(1).toVar();
    Loop(samples, ({ i: sampleIndex }) => {
      const point = origin.add(ray.mul(start.add(float(sampleIndex).add(0.5).mul(stride))));
      if (smoke) {
        const height = point.y.mul(0.5).add(0.5);
        const drift = vec2(height.pow(2).mul(0.28), sin(height.mul(7).add(clock.mul(0.18))).mul(height).mul(0.09));
        const width = mix(0.13, 0.8, smoothstep(0, 0.85, height));
        const plume = smoothstep(0.55, 1, point.xz.sub(drift).length().div(width)).oneMinus()
          .mul(smoothstep(0, 0.04, height)).mul(smoothstep(0.65, 1, height).oneMinus());
        const noise = mx_noise_float(point.mul(vec3(6, 10, 6)).sub(vec3(clock.mul(0.12), clock.mul(0.85), 0))).mul(0.5).add(0.5);
        const opacity = plume.mul(smoothstep(0.15, 0.8, noise)).mul(stride).mul(-0.36).exp().oneMinus();
        const shade = mix(color('#282b30'), color('#a0a1a3'), noise.mul(0.65).add(height.mul(0.25)));
        scattering.addAssign(shade.mul(opacity).mul(transmission));
        transmission.mulAssign(opacity.oneMinus());
      } else {
        const noise = sin(point.x.mul(9).add(clock.mul(0.18))).mul(sin(point.z.mul(7).sub(clock.mul(0.12)))).mul(0.25).add(0.6);
        density.addAssign(max(float(1).sub(point.dot(point)), 0).mul(noise).mul(stride));
      }
    });
    if (smoke) return vec4(scattering.div(max(transmission.oneMinus(), 0.0001)), transmission.oneMinus());
    const alpha = min(float(1).sub(density.mul(-0.018).exp()), 0.14);
    return vec4(mix(color(study.horizon), color(study.foliageLight), 0.12), alpha);
  })();
  return material;
}

export function baseFeatures(study: PlanetStudy, seed: number, mobile: boolean, clock: any, surface: BaseSurface, arrival?: { camera: Vector3; target: Vector3; aspect: number }) {
  const group = new Group(); group.name = 'base-features';
  const cutouts: Vector3[] = [];
  const right = uniform(new Vector3(1, 0, 0)), up = uniform(new Vector3(0, 1, 0));
  const records: { id: string; name: string; kind: FeatureKind; count: number; sites: number[][]; visibleAtArrival: boolean }[] = [];
  for (const [featureIndex, spec] of BASE_FEATURES[study.id].entries()) {
    const random = randomSource(seed + 9109 + featureIndex * 379);
    const flora = ['flower', 'reed', 'fern', 'pod'].includes(spec.kind);
    const count = flora ? (mobile ? 22 : 42) : spec.kind === 'volcano' ? 3 : spec.kind === 'whirlpool' ? 1 : 2;
    const sites: Vector3[] = [];
    const candidates: { point: Vector3; score: number; visible: boolean }[] = [];
    const viewer = arrival?.camera ?? new Vector3(33, landscapeHeight(33, 68, seed, study) + 7, 68);
    const viewCamera = new PerspectiveCamera(BASE_CAMERA_FOV, arrival?.aspect ?? (mobile ? 390 / 844 : 1.6), 0.2, 1800);
    viewCamera.position.copy(viewer); viewCamera.lookAt(arrival?.target ?? new Vector3(-20, 18, -90)); viewCamera.updateMatrixWorld();
    const corridor = (arrival?.target ?? new Vector3(-20, 18, -90)).clone().sub(viewer); corridor.y = 0; corridor.normalize();
    const across = new Vector3(-corridor.z, 0, corridor.x);
    for (let attempt = 0; candidates.length < Math.max(100, count * 5) && attempt < 4000; attempt++) {
      const first = random(), second = random();
      const foreground = !!arrival && attempt % 2 === 0;
      const positionX = foreground ? viewer.x + corridor.x * (25 + first * 65) + across.x * (second - 0.5) * 26 : (first - 0.5) * (flora ? 150 : spec.kind === 'whirlpool' ? 280 : 110);
      const positionZ = foreground ? viewer.z + corridor.z * (25 + first * 65) + across.z * (second - 0.5) * 26 : 28 - second * (flora ? 155 : spec.kind === 'whirlpool' ? 275 : 110);
      if (!surface.allowsVegetation(positionX, positionZ, flora ? 0.6 : 6)) continue;
      const height = surface.sample(positionX, positionZ).height;
      if (spec.kind === 'whirlpool' ? height > -0.8 : height < 0.6) continue;
      if (spec.kind === 'whirlpool' && Array.from({ length: 12 }, (_, sample) => landscapeHeight(positionX + Math.cos(sample * Math.PI / 6) * 5 * spec.size, positionZ + Math.sin(sample * Math.PI / 6) * 5 * spec.size, seed, study)).some(height => height > 0.18)) continue;
      const point = new Vector3(positionX, spec.kind === 'whirlpool' ? 0.43 : height, positionZ);
      const focusHeight = spec.kind === 'vortex' ? 8 * spec.size : spec.kind === 'blizzard' ? 5 : flora ? spec.size : 1.5;
      const focus = point.clone().add(new Vector3(0, focusHeight, 0));
      const distance = focus.distanceTo(viewer);
      const projected = focus.clone().project(viewCamera);
      const visible = distance > 12 && distance < 125 && Math.abs(projected.x) < 0.72 && Math.abs(projected.y) < 0.78 && projected.z > -1 && projected.z < 1 && surface.visibleFrom(viewer, focus);
      candidates.push({ point, visible, score: (visible ? 10000 : 0) - Math.abs(distance - (flora ? 38 : 58)) * 10 });
    }
    candidates.sort((first, second) => second.score - first.score);
    for (const candidate of candidates) {
      if (sites.length >= count) break;
      if (sites.some(site => site.distanceTo(candidate.point) < (flora ? 2 : 18))) continue;
      sites.push(candidate.point);
    }
    if (!sites.length) {
      const site = surface.spawn(-35 + featureIndex * 30, -25);
      if (spec.kind !== 'whirlpool') sites.push(site);
    }
    const record = { id: spec.id, name: spec.name, kind: spec.kind, count: sites.length, sites: sites.map(site => site.toArray()), visibleAtArrival: candidates[0]?.visible ?? false };
    records.push(record);
    if (flora) {
      const geometries = floraGeometry(spec);
      for (const part of ['body', 'accent'] as const) {
        const base = part === 'body' ? color(study.foliage).mul(0.75) : mix(color(study.foliageLight), color(study.infection), spec.kind === 'pod' ? 0.55 : 0.18);
        const material = new EnvironmentMaterial({ study, base,
          emission: part === 'accent' ? color(study.infection).mul(spec.kind === 'pod' ? 0.32 : 0.04) : undefined,
          radiationMask: part === 'accent' ? float(1.1) : smoothstep(0.4, 2, attribute('position', 'vec3').y).mul(0.45) });
        material.positionNode = positionLocal.add(vec3(sin(clock.mul(0.8).add(positionLocal.x.mul(0.2))).mul(attribute('position', 'vec3').y.pow(2)).mul(0.025), 0, 0));
        const mesh = new InstancedMesh(geometries[part], material, sites.length);
        const transform = new Object3D();
        sites.forEach((site, index) => {
          transform.position.copy(site); transform.rotation.y = index * 2.4;
          transform.scale.setScalar(spec.size * (index < 5 ? 1.2 : 0.75 + (index % 7) / 14)); transform.updateMatrix(); mesh.setMatrixAt(index, transform.matrix);
        });
        mesh.name = `${spec.id}:${part}`; mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh);
      }
      continue;
    }
    for (const site of sites) {
      if (spec.kind === 'volcano') {
        const profile = [[0, 0], [4.8, 0], [3.7, 0.7], [2.5, 2.6], [1.9, 2.9], [1.45, 1.4], [0, 1.4]].map(([radius, height]) => new Vector2(radius, height));
        const geometry = new LatheGeometry(profile, 14).toNonIndexed(); geometry.computeVertexNormals();
        const rock = new Mesh(geometry, new EnvironmentMaterial({ study, base: color(study.rock) }));
        rock.position.copy(site); rock.name = spec.id; rock.castShadow = true; rock.receiveShadow = true; group.add(rock);
        group.updateMatrixWorld(true); surface.add(rock, 'volcano');
        const lava = new Mesh(new CircleGeometry(1.7, 32), new EnvironmentMaterial({ study, base: mix(color('#992b2c'), color('#ffbf46'), sin(positionWorld.x.mul(2).add(clock)).mul(0.5).add(0.5)), emission: color('#ff832b').mul(0.5), shadows: false }));
        lava.rotation.x = -Math.PI / 2; lava.position.copy(site).add(new Vector3(0, 2.52, 0)); lava.name = `${spec.id}:lava`; group.add(lava); group.updateMatrixWorld(true); surface.add(lava, 'lava', false);
      } else if (spec.kind === 'whirlpool') {
        const radius = 5 * spec.size;
        let depth = 2.1;
        for (const [spread, fraction] of [[0, 1], [0.4, 0.71], [1.5, 0.33], [3, 0.1]]) for (let sample = 0; sample < 12; sample++) {
          const bed = surface.sample(site.x + Math.cos(sample * Math.PI / 6) * spread * spec.size, site.z + Math.sin(sample * Math.PI / 6) * spread * spec.size).height;
          depth = Math.min(depth, (site.y - bed - 0.15) / fraction);
        }
        depth = Math.max(0.15, depth);
        const profile = [[5, 0.015], [3, -depth * 0.1], [1.5, -depth * 0.33], [0.4, -depth * 0.71], [0, -depth]].map(([spread, height]) => new Vector2(spread * spec.size, height));
        const material = new EnvironmentMaterial({ study, base: mix(color(study.water).mul(0.55), color(study.horizon), smoothstep(0.7, 0.98, sin(positionLocal.x.atan(positionLocal.z).mul(4).add(positionLocal.xz.length().mul(3)).sub(clock.mul(1.7))))), shadows: false });
        const mesh = new Mesh(new LatheGeometry(profile, 64), material); mesh.position.copy(site); mesh.name = spec.id; mesh.renderOrder = 21; group.add(mesh); group.updateMatrixWorld(true); surface.add(mesh, 'whirlpool', false);
        cutouts.push(new Vector3(site.x, site.z, radius));
      } else if (spec.kind === 'vortex') {
        const profile = Array.from({ length: 18 }, (_, index) => new Vector2((0.35 + (index / 17) ** 1.5 * 3.7) * spec.size, index / 17 * 16 * spec.size));
        const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: false, toneMapped: false });
        const height = attribute('position', 'vec3').y.div(16 * spec.size);
        const swirl = sin(positionLocal.x.atan(positionLocal.z).mul(7).sub(height.mul(28)).add(clock.mul(2.4)));
        material.colorNode = mix(color(study.rock), color(study.landform === 'faults' ? study.infection : study.highland), study.landform === 'faults' ? 0.3 : 0.35);
        material.opacityNode = smoothstep(-0.4, 0.9, swirl).mul(0.6).add(0.12).mul(smoothstep(0, 0.06, height)).mul(smoothstep(0.75, 1, height).oneMinus()).mul(0.46);
        material.positionNode = positionLocal.add(vec3(sin(height.mul(5).add(clock.mul(0.25))).mul(height).mul(1.5), 0, 0));
        const mesh = new Mesh(new LatheGeometry(profile, 36), material); mesh.position.copy(site); mesh.name = spec.id; mesh.renderOrder = 28; group.add(mesh);
      } else {
        const size = new Vector3(13 * spec.size, spec.id === 'fumaroles' ? 6 : 2.8, 9 * spec.size);
        const center = site.clone().add(new Vector3(0, size.y * 0.7, 0));
        const cloud = new Mesh(new SphereGeometry(1, 24, 12), volumeMaterial(study, center, size, clock)); cloud.position.copy(center); cloud.scale.copy(size); cloud.name = spec.id; cloud.renderOrder = 27; group.add(cloud);
        if (spec.kind === 'blizzard') {
          const positions: number[] = [], corners: number[] = [], phases: number[] = [];
          for (let index = 0; index < (mobile ? 260 : 520); index++) {
            const positionX = site.x + (random() - 0.5) * 24, positionZ = site.z + (random() - 0.5) * 18, phase = random();
            for (const [cornerX, cornerY] of [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]]) {
              positions.push(positionX, landscapeHeight(positionX, positionZ, seed, study), positionZ); corners.push(cornerX, cornerY); phases.push(phase);
            }
          }
          const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('corner', new Float32BufferAttribute(corners, 2)); geometry.setAttribute('phase', new Float32BufferAttribute(phases, 1));
          const corner = attribute('corner', 'vec2'), phase = attribute('phase', 'float').add(clock.mul(0.22)).fract();
          const map = particleTexture('snow');
          const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false }); material.map = map; material.colorNode = color('#e8f5ff');
          material.positionNode = positionLocal.add(vec3(sin(clock.mul(0.7).add(attribute('phase', 'float').mul(37))).mul(3), phase.oneMinus().mul(13), 0)).add(right.mul(corner.x.mul(0.14))).add(up.mul(corner.y.mul(0.14)));
          material.opacityNode = texture(map, corner.mul(0.5).add(0.5)).a.mul(smoothstep(0, 0.1, phase)).mul(smoothstep(0, 0.1, phase.oneMinus())).mul(0.65);
          const snow = new Mesh(geometry, material); snow.frustumCulled = false; snow.renderOrder = 30; snow.name = `${spec.id}:snow`; group.add(snow);
        }
      }
    }
  }
  group.userData.features = records;
  group.traverse(object => {
    if (records.some(record => ['mist', 'vortex', 'blizzard'].includes(record.kind) && object.name.startsWith(record.id))) object.userData.weatherFeature = true;
  });
  return { group, cutouts, update(camera?: Camera) {
    if (!camera) return;
    right.value.setFromMatrixColumn(camera.matrixWorld, 0); up.value.setFromMatrixColumn(camera.matrixWorld, 1);
  } };
}