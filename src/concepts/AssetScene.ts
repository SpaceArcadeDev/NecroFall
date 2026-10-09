import {
  AnimationMixer, Box3, Color, DirectionalLight, EquirectangularReflectionMapping,
  Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  MeshStandardNodeMaterial, Object3D, PlaneGeometry, RepeatWrapping, Scene, Texture,
  Vector2, Vector3, CanvasTexture, SkinnedMesh, SRGBColorSpace, type WebGPURenderer,
} from 'three/webgpu';
import { attribute, color, float, materialColor, mix, normalWorld, positionLocal, sin, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { StudyView, StudyWorld } from './world';
import type { Creature } from './enemies';
import { randomSource, STUDIES, type EnvironmentInspection, type PlanetState, type PlanetStudy } from './definitions';
import { brineBasinDistance, celestialPlanet, landscapeGrassCoverage, landscapeHeight, landscapeTerrain, landscapeWater, paintedSky } from './AssetLandscape';
import { EnvironmentMaterial } from './EnvironmentStyle';
import { patchGrass, projectTrees } from './EnvironmentVegetation';
import { EnvironmentWeather } from './EnvironmentWeather';
import { BaseSurface, boundaryEdges, crystalGeometry, mountainGeometry, spikeGeometry } from './BaseGeology';
import { BASE_FEATURES, baseFeatures } from './BaseFeatures';

const urls = {
  mushroomNear: new URL('./assets/mushroom-near.glb', import.meta.url).href,
  mushroomFar: new URL('./assets/mushroom-far.glb', import.meta.url).href,
  originalOak: new URL('./assets/original-oak.glb', import.meta.url).href,
  originalCherry: new URL('./assets/original-cherry.glb', import.meta.url).href,
  originalBirch: new URL('./assets/original-birch.glb', import.meta.url).href,
  cliffNear: new URL('./assets/cliff-near.glb', import.meta.url).href,
  cliffFar: new URL('./assets/cliff-far.glb', import.meta.url).href,
  rootsNear: new URL('./assets/roots-near.glb', import.meta.url).href,
  boulderNear: new URL('./assets/boulder-near.glb', import.meta.url).href,
  boulderFar: new URL('./assets/boulder-far.glb', import.meta.url).href,
  parasiteNear: new URL('./assets/parasite-near.glb', import.meta.url).href,
};
type AssetKey = keyof typeof urls;

class AssetLibrary {
  readonly assets = new Map<AssetKey, GLTF>();
  readonly materials = new Map<string, MeshStandardNodeMaterial | EnvironmentMaterial>();
  readonly clock = uniform(0);

  constructor(readonly study: PlanetStudy) {}

  async load(keys: readonly AssetKey[] = Object.keys(urls) as AssetKey[]): Promise<void> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    for (const key of keys) {
      const asset = await loader.loadAsync(urls[key]);
      const repaired = new Map<Mesh['geometry'], Mesh['geometry']>();
      asset.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        if (key.startsWith('cliff')) {
          const original = object.geometry;
          if (!repaired.has(original)) repaired.set(original, mountainGeometry(original));
          object.geometry = repaired.get(original)!;
        }
        const originals = Array.isArray(object.material) ? object.material : [object.material];
        const converted = originals.map((source: MeshStandardMaterial) => {
          const originalTree = key.startsWith('original');
          const materialKey = originalTree ? 'original:trunk' : source.name;
          let material = this.materials.get(materialKey);
          if (material) return material;
          if (!source.name.startsWith('parasite:')) {
            const fungus = source.name.startsWith('fungus:');
            const leaves = /leaves/.test(source.name);
            const vegetation = /leaves|grass/.test(source.name);
            const tint = originalTree ? new Color(this.study.rock).multiplyScalar(0.7) : leaves ? this.study.foliage : /grass/.test(source.name) ? this.study.highland : /canopy/.test(source.name) ? '#475769' : /roots/.test(source.name) ? this.study.foliage : this.study.rock;
            const detail = source.map && !vegetation && !originalTree ? texture(source.map).r.mul(5).floor().mul(0.025).add(0.9) : 1;
            const base = fungus && source.map ? mix(texture(source.map).rgb, color(this.study.foliage), 0.18) : color(new Color(tint)).mul(detail);
            material = new EnvironmentMaterial({ study: this.study, base,
              emission: fungus && source.emissiveMap ? texture(source.emissiveMap).rgb.mul(color(this.study.infection)).mul(0.3) : undefined,
              alpha: vegetation && source.map ? texture(source.map).a : undefined,
              alphaTest: vegetation ? 0.25 : 0, side: source.side });
            material.map = source.map;
          } else material = new MeshStandardNodeMaterial({
            color: source.color, map: source.map, normalMap: source.normalMap,
            roughnessMap: source.roughnessMap, metalnessMap: source.metalnessMap,
            aoMap: source.aoMap, aoMapIntensity: 0.8, roughness: source.roughness,
            metalness: source.metalness, alphaTest: source.alphaTest, side: source.side,
            emissive: source.emissive, emissiveMap: source.emissiveMap,
          });
          material.name = materialKey;
          if (material instanceof MeshStandardNodeMaterial) material.normalScale.copy(source.normalScale);
          if (/leaves/.test(source.name)) material.alphaTest = 0.25;
          const bands = smoothstep(-0.15, 0.05, normalWorld.dot(vec3(-0.5, 0.75, 0.4))).mul(0.12).add(0.88);
          if (material instanceof MeshStandardNodeMaterial) material.colorNode = materialColor.rgb.mul(bands);
          if (/leaves|grass/.test(source.name)) {
            material.positionNode = positionLocal.add(vec3(sin(this.clock.mul(1.1).add(positionLocal.x.mul(0.09))).mul(smoothstep(-0.8, 0.85, attribute('position', 'vec3').y)).mul(/grass/.test(source.name) ? 0.1 : 0.035), 0, 0));
          }
          this.materials.set(materialKey, material);
          return material;
        });
        object.material = Array.isArray(object.material) ? converted : converted[0];
        object.castShadow = !key.startsWith('grass');
        object.receiveShadow = true;
      });
      asset.scene.updateMatrixWorld(true);
      if (key.startsWith('cliff') || key.startsWith('boulder')) asset.scene.userData.groundOffset = new Box3().setFromObject(asset.scene).min.y;
      repaired.forEach((replacement, original) => { if (replacement !== original) original.dispose(); });
      this.assets.set(key as AssetKey, asset);
    }
  }

  place(key: AssetKey, position: Vector3, scale = 1, angle = 0): Group {
    const instance = clone(this.assets.get(key)!.scene) as Group;
    if (key.startsWith('cliff') || key.startsWith('boulder')) {
      instance.position.y -= this.assets.get(key)!.scene.userData.groundOffset;
      const placed = new Group(); placed.add(instance);
      placed.position.copy(position); placed.scale.setScalar(scale); placed.rotation.y = angle;
      return placed;
    }
    instance.position.copy(position);
    instance.scale.multiplyScalar(scale);
    instance.rotation.y = angle;
    return instance;
  }

  instances(key: AssetKey, placements: Matrix4[], parent: Group | Scene, surface?: BaseSurface, floating?: ReadonlySet<Matrix4>): void {
    if (!placements.length) return;
    const template = this.assets.get(key)!.scene;
    template.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const sourceMatrix = new Matrix4().makeTranslation(0, -(template.userData.groundOffset ?? 0), 0).multiply(object.matrixWorld);
      if (surface && (key.startsWith('cliff') || key.startsWith('boulder'))) {
        const pieces = placements.map(matrix => surface.conformGeometry(object.geometry, matrix.clone().multiply(sourceMatrix), floating?.has(matrix)));
        const geometry = mergeGeometries(pieces)!;
        const batch = new Mesh(geometry, object.material);
        batch.name = key.startsWith('cliff') ? 'base-mountains' : 'base-boulders';
        batch.castShadow = key.endsWith('Near'); batch.receiveShadow = true; parent.add(batch);
        let offset = 0;
        pieces.forEach((piece, index) => {
          const count = piece.attributes.position.count;
          surface.addRange(batch, offset, count, piece.boundingBox!, piece.userData, floating?.has(placements[index]) ? 'floating-rock' : key.startsWith('cliff') ? 'formation' : 'boulder');
          offset += count; piece.dispose();
        });
        return;
      }
      const batch = new InstancedMesh(object.geometry, object.material, placements.length);
      batch.userData.floatingInstances = [];
      placements.forEach((matrix, index) => {
        const placed = matrix.clone().multiply(sourceMatrix);
        const airborne = floating?.has(matrix);
        if (airborne) batch.userData.floatingInstances.push(index);
        batch.setMatrixAt(index, surface && !airborne && (key.startsWith('cliff') || key.startsWith('boulder')) ? surface.groundMatrix(object.geometry, placed) : placed);
      });
      batch.castShadow = key.endsWith('Near') && !key.startsWith('grass');
      batch.receiveShadow = true;
      batch.computeBoundingSphere();
      parent.add(batch);
      if (key.startsWith('cliff') || key.startsWith('boulder')) surface?.add(batch, key.startsWith('cliff') ? 'formation' : 'boulder');
    });
  }

  dispose(scene: Scene): void {
    const meshes = new Set<Mesh>(), textures = new Set<Texture>(), geometries = new Set<Mesh['geometry']>();
    for (const asset of this.assets.values()) asset.scene.traverse((object) => { if (object instanceof Mesh) meshes.add(object); });
    scene.traverse((object) => { if (object instanceof Mesh) meshes.add(object); });
    for (const mesh of meshes) {
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
        material.dispose();
      }
      if (mesh instanceof InstancedMesh) mesh.dispose();
    }
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    if (scene.environment instanceof Texture) scene.environment.dispose();
    scene.clear();
    this.assets.clear();
    this.materials.clear();
  }
}

function stateControls(scene: Scene, weather?: EnvironmentWeather): Pick<StudyWorld, 'setState' | 'setEffects'> {
  const materials = new Set<EnvironmentMaterial>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof EnvironmentMaterial) materials.add(material);
    }
  });
  scene.userData.radiationMaterials = materials.size;
  return {
    setState(state: PlanetState) {
      const amount = state === 'radiated' ? 1 : 0;
      materials.forEach((material) => { material.radiation.value = amount; });
      if (weather) weather.radiation.value = amount;
      scene.userData.state = state;
    },
    setEffects(enabled: boolean) {
      if (weather) weather.group.visible = enabled;
      scene.traverse(object => { if (object.userData.weatherFeature) object.visible = enabled; });
    },
  };
}

function geologicalClusters(scene: Scene, surface: BaseSurface, study: PlanetStudy, seed: number, clock: any, showcase = false): void {
  const random = randomSource(seed + 7313);
  const transform = new Object3D();
  const clusterTransform = new Object3D();
  const heightAt = (positionX: number, positionZ: number) => showcase ? 0.08 : landscapeHeight(positionX, positionZ, seed, study);
  for (const kind of ['spike', 'crystal'] as const) {
    const matrices: Matrix4[] = [];
    const geometry = kind === 'spike' ? spikeGeometry(seed) : crystalGeometry();
    const localHeight = attribute('position', 'vec3').y.div(kind === 'spike' ? 2.4 : 1.624);
    const material = new EnvironmentMaterial({ study,
      base: kind === 'spike' ? color(study.rock).mul(smoothstep(0.1, 1, localHeight).mul(0.25).add(0.75))
        : mix(color(study.rock), color(study.infection), smoothstep(0, 0.9, localHeight)),
      radiationMask: kind === 'spike' ? float(0) : undefined,
      emission: kind === 'crystal' ? color(study.infection).mul(smoothstep(0.2, 0.85, localHeight)).mul(sin(clock.mul(1.1)).mul(0.08).add(0.72)) : undefined });
    for (let cluster = 0, attempt = 0; cluster < (showcase ? 1 : kind === 'spike' ? 6 : 12) && attempt < 700; attempt++) {
      const positionX = showcase ? (kind === 'spike' ? -12 : 10) : (random() - 0.5) * 270, positionZ = showcase ? 0 : 50 - random() * 240;
      const altitude = heightAt(positionX, positionZ);
      if (!showcase && study.landform === 'saltern' && brineBasinDistance(positionX, positionZ, seed) < (kind === 'spike' ? 50 : 20)) continue;
      if (!showcase && (altitude < 0.6 || Math.hypot(positionX - 33, positionZ - 68) < 16 || Math.hypot(positionX - 15, positionZ - 5) < 10 || !surface.allowsVegetation(positionX, positionZ, kind === 'spike' ? 8 : 3))) continue;
      const groupAngle = random() * Math.PI * 2;
      const clusterScale = kind === 'crystal' ? 0.85 + random() * 0.65 : 1;
      clusterTransform.position.set(positionX, altitude, positionZ);
      clusterTransform.rotation.set(kind === 'spike' ? (random() - 0.5) * 1.1 : 0, groupAngle, kind === 'spike' ? (random() - 0.5) * 1.1 : 0);
      clusterTransform.updateMatrix();
      for (let shard = 0; shard < (kind === 'spike' ? 4 : 5); shard++) {
        const angle = shard * 2.4;
        const spread = kind === 'spike' ? 3.5 : (0.1 + random() * 0.55) * clusterScale;
        const height = kind === 'spike' ? 29 + random() * 24 : (0.6 + random()) * clusterScale;
        const width = kind === 'spike' ? height / 2.4 * (0.8 + random() * 0.4) : height;
        transform.position.set(Math.cos(angle) * spread, 0, Math.sin(angle) * spread);
        transform.rotation.set(kind === 'spike' ? 0 : (random() - 0.5) * 1.7, kind === 'spike' ? 0 : random() * Math.PI * 2, kind === 'spike' ? 0 : (random() - 0.5) * 1.7);
        transform.scale.set(width, kind === 'spike' ? height / 2.4 : height * (0.8 + random() * 0.7), kind === 'spike' ? width * (0.8 + random() * 0.3) : width);
        transform.updateMatrix();
        const matrix = clusterTransform.matrix.clone().multiply(transform.matrix);
        matrix.elements[13] = heightAt(matrix.elements[12], matrix.elements[14]) - 0.08;
        matrices.push(kind === 'spike' ? surface.buryFlatBase(geometry, matrix) : matrix);
      }
      cluster++;
    }
    const mesh = new InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.name = `base-${kind}s`;
    mesh.castShadow = kind === 'spike';
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    surface.add(mesh, kind, false);
  }
}

function clearTerrainView(camera: Vector3, target: Vector3, seed: number, study: PlanetStudy, margin = 5): void {
  for (let step = 1; step < 18; step++) {
    const progress = step / 20;
    const positionX = camera.x + (target.x - camera.x) * progress;
    const positionZ = camera.z + (target.z - camera.z) * progress;
    const clearance = landscapeHeight(positionX, positionZ, seed, study) + margin;
    camera.y = Math.max(camera.y, (clearance - target.y * progress) / (1 - progress));
  }
}

function lighting(scene: Scene, mobile: boolean, seed: number, study: PlanetStudy): void {
  const environment = paintedSky(seed, study);
  environment.mapping = EquirectangularReflectionMapping;
  scene.environment = environment;
  scene.background = environment;
  scene.environmentIntensity = 0.7;
  scene.add(new HemisphereLight('#c4e7f1', '#53633b', 1.8));
  const sun = new DirectionalLight('#ffe9c2', 3.4);
  sun.position.set(-75, 100, 65);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
  sun.shadow.camera.left = -65;
  sun.shadow.camera.right = 65;
  sun.shadow.camera.top = 65;
  sun.shadow.camera.bottom = -65;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 270;
  sun.shadow.normalBias = 0.045;
  sun.shadow.bias = -0.0001;
  scene.add(sun, sun.target);
}

async function buildInspection(scene: Scene, library: AssetLibrary, treeKey: AssetKey, study: PlanetStudy, seed: number, mobile: boolean, inspection: EnvironmentInspection, featureId = ''): Promise<StudyWorld> {
  let camera = new Vector3(22, 13, 30), target = new Vector3(0, 7, 0);
  let water: ReturnType<typeof landscapeWater> | undefined;
  let features: ReturnType<typeof baseFeatures> | undefined;
  let surface: BaseSurface | undefined;
  if (inspection === 'geology') {
    const ground = new Mesh(new PlaneGeometry(180, 180), new EnvironmentMaterial({ study, base: color(study.ground) }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    surface = new BaseSurface(() => 0);
    geologicalClusters(scene, surface, study, seed, library.clock, true);
    camera.set(50, 32, 75); target.set(-3, 18, 0);
  } else if (inspection === 'features') {
    const terrain = await landscapeTerrain(seed, mobile, study);
    surface = new BaseSurface(terrain.userData.heightAt);
    features = baseFeatures(study, seed, mobile, library.clock, surface);
    water = landscapeWater(seed, study); water.setCutouts(features.cutouts);
    scene.add(terrain, water.mesh, features.group);
    const focal = features.group.userData.features.find((feature: { id: string; sites: number[][] }) => feature.id === featureId && feature.sites.length)
      ?? features.group.userData.features.find((feature: { kind: string; sites: number[][] }) => ['volcano', 'whirlpool', 'vortex', 'blizzard', 'mist'].includes(feature.kind) && feature.sites.length);
    const recipe = BASE_FEATURES[study.id].find(feature => feature.id === focal?.id);
    const extent = recipe ? (recipe.kind === 'vortex' ? 18 : ['mist', 'blizzard'].includes(recipe.kind) ? 16 : recipe.kind === 'whirlpool' ? 9 : recipe.kind === 'volcano' ? 7 : 3) * recipe.size : 10;
    target.fromArray(focal?.sites[0] ?? [-5, 8, -35]); target.y += recipe?.kind === 'vortex' ? extent * 0.4 : Math.min(2.5, extent * 0.3);
    camera.copy(target).add(new Vector3(extent * 1.1, extent * 0.9, extent * 1.5));
    clearTerrainView(camera, target, seed, study, 0.35);
  } else if (inspection === 'trees' || inspection === 'rocks') {
    const ground = new Mesh(new PlaneGeometry(140, 140), new EnvironmentMaterial({ study, base: color(study.ground) }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    if (inspection === 'trees') {
      if (treeKey.startsWith('original')) scene.add(projectTrees(library.assets.get(treeKey)!.scene, [new Matrix4().makeScale(2.2, 2.2, 2.2)], study, mobile, library.clock));
      else scene.add(library.place('mushroomNear', new Vector3(), 1));
      target.set(0, 10, 0);
      camera.set(26, 17, 34);
    } else {
      surface = new BaseSurface(() => 0);
      const placement = new Object3D();
      placement.position.set(3, 0, 3); placement.rotation.y = -0.4; placement.scale.setScalar(2.1); placement.updateMatrix();
      library.instances('boulderNear', [placement.matrix.clone()], scene, surface);
      placement.position.set(-6, -1, -6); placement.rotation.y = 0.3; placement.scale.setScalar(0.5); placement.updateMatrix();
      library.instances('cliffNear', [placement.matrix.clone()], scene, surface);
      target.set(0, 4, 0);
    }
  } else if (inspection === 'water') {
    const basin = (positionX: number, positionZ: number) => Math.min(2.4, Math.pow(Math.hypot(positionX, positionZ) / 23, 4) * 7 - 5);
    const geometry = new PlaneGeometry(110, 110, 96, 96);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    for (let index = 0; index < positions.count; index++) positions.setY(index, basin(positions.getX(index), positions.getZ(index)));
    geometry.computeVertexNormals();
    const ground = new Mesh(geometry, new EnvironmentMaterial({ study, base: color(study.highland) }));
    ground.receiveShadow = true;
    water = landscapeWater(seed, study, basin);
    scene.add(ground, water.mesh);
    camera.set(22, 15, 27);
    target.set(0, 0.5, 0);
  } else {
    scene.add(await landscapeTerrain(seed, mobile, study));
    if (inspection === 'grass') {
      scene.add(patchGrass(study, seed, mobile, library.clock));
      let best = -1;
      for (let positionX = -70; positionX < 70; positionX += 5) for (let positionZ = -60; positionZ < 60; positionZ += 5) {
        const height = landscapeHeight(positionX, positionZ, seed, study);
        const coverage = landscapeGrassCoverage(positionX, positionZ, seed, study);
        if (height > 2 && coverage > best) { best = coverage; target.set(positionX, height + 0.8, positionZ); }
      }
      camera.copy(target).add(new Vector3(4, 3.5, 8));
    } else {
      camera.set(100, 100, 145);
      target.set(0, 12, -65);
      water = landscapeWater(seed, study);
      scene.add(water.mesh);
    }
  }
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof EnvironmentMaterial) material.fogStrength.value = 0;
    }
  });
  scene.userData.inspection = inspection;
  return { scene, camera, target, surface, minDistance: inspection === 'grass' ? 3 : 8, maxDistance: 600, creatures: [], ...stateControls(scene),
    update(elapsed, activeCamera) { library.clock.value = elapsed; water?.update(elapsed); features?.update(activeCamera); }, dispose() { library.dispose(scene); } };
}

export async function buildAssetWorld(view: StudyView, mobile: boolean, renderer: WebGPURenderer, seed = 7319, study: PlanetStudy = STUDIES[0], inspection: EnvironmentInspection = 'scene', featureId = ''): Promise<StudyWorld> {
  renderer.shadowMap.enabled = true;
  const library = new AssetLibrary(study);
  const scene = new Scene();
  const camera = view === 'fauna' ? new Vector3(9, 5, 13) : new Vector3(33, Math.max(study.landform === 'caldera' ? 65 : 7, landscapeHeight(33, 68, seed, study) + 7), 68);
  const target = view === 'fauna' ? new Vector3(0, 3, 0) : new Vector3(-20, study.landform ? Math.max(18, landscapeHeight(-20, -90, seed, study) + 12) : 18, -90);
  if (view === 'surface' && study.landform) clearTerrainView(camera, target, seed, study);
  lighting(scene, mobile, seed, view === 'fauna' ? STUDIES[0] : study);
  if (view === 'orbit') {
    scene.background = new Color('#061420');
    const planet = celestialPlanet(seed, 12, study);
    scene.add(planet);
    return { scene, camera: new Vector3(27, 13, 35), target: new Vector3(), minDistance: 27, maxDistance: 90, creatures: [], ...stateControls(scene),
      update(elapsed) { planet.rotation.y = elapsed * 0.025; }, dispose() { library.dispose(scene); } };
  }
  const treeKey: AssetKey = study.treeSpecies === 'oak' ? 'originalOak' : study.treeSpecies === 'cherry' ? 'originalCherry' : study.treeSpecies === 'birch' ? 'originalBirch'
    : study.flora === 'fungus' ? 'mushroomFar' : study.flora === 'canopy' ? 'originalCherry' : study.flora === 'coral' ? 'originalOak' : 'originalBirch';
  const environmentKeys: AssetKey[] = [treeKey, 'cliffNear', 'cliffFar', 'boulderNear', 'boulderFar', 'rootsNear', 'parasiteNear'];
  if (study.flora === 'fungus') environmentKeys.push('mushroomNear');
  const keys = view === 'fauna' ? ['parasiteNear'] as AssetKey[] : inspection === 'trees' ? (study.flora === 'fungus' ? ['mushroomNear'] : [treeKey]) as AssetKey[]
    : inspection === 'rocks' ? ['cliffNear', 'boulderNear'] as AssetKey[] : inspection === 'scene' ? environmentKeys : [];
  await library.load(keys);
  scene.fog = new Fog(study.horizon, 195, 590);
  if (view === 'surface' && inspection !== 'scene') return buildInspection(scene, library, treeKey, study, seed, mobile, inspection, featureId);
  const water = view === 'surface' ? landscapeWater(seed, study) : undefined;
  let weather: EnvironmentWeather | undefined;
  let surface: BaseSurface | undefined;
  let features: ReturnType<typeof baseFeatures> | undefined;
  if (view === 'surface') {
    const terrain = await landscapeTerrain(seed, mobile, study);
    surface = new BaseSurface(terrain.userData.heightAt);
    scene.add(terrain, water!.mesh);
    const height = (positionX: number, positionZ: number) => landscapeHeight(positionX, positionZ, seed, study);
    let random = randomSource(seed + 991);
    const transform = new Object3D();
    const batches = new Map<AssetKey, Matrix4[]>();
    const floating = new Set<Matrix4>();
    const scatter = (key: AssetKey, positionX: number, positionZ: number, scale: number, angle: number, altitude = height(positionX, positionZ), airborne = false) => {
      transform.position.set(positionX, altitude, positionZ);
      transform.rotation.set(0, angle, 0);
      transform.scale.setScalar(scale);
      transform.updateMatrix();
      if (study.landform === 'saltern' && (key.startsWith('cliff') || key.startsWith('boulder'))) {
        const bounds = new Box3().setFromObject(library.assets.get(key)!.scene).applyMatrix4(transform.matrix);
        const center = bounds.getCenter(new Vector3()), size = bounds.getSize(new Vector3());
        if (brineBasinDistance(center.x, center.z, seed) < Math.hypot(size.x, size.z) / 2 + 16) return;
      }
      if (!batches.has(key)) batches.set(key, []);
      const matrix = transform.matrix.clone();
      batches.get(key)!.push(matrix);
      if (airborne) floating.add(matrix);
    };
    const treeScale = study.flora === 'fungus' ? 1.1 : study.flora === 'sail' ? 1.45 : study.flora === 'crystal' ? 2.1 : 2.5;
    const heroTree: AssetKey = study.flora === 'fungus' ? 'mushroomNear' : treeKey;
    const placeHero = (desiredX: number, desiredZ: number, scale: number, angle: number) => {
      for (let radius = 0; radius <= 32; radius += 4) for (let step = 0; step < 12; step++) {
        const positionX = desiredX + Math.cos(step * Math.PI / 6) * radius;
        const positionZ = desiredZ + Math.sin(step * Math.PI / 6) * radius;
        if (height(positionX, positionZ) > 2) { scatter(heroTree, positionX, positionZ, scale, angle); return; }
      }
    };
    placeHero(-32, 20, treeScale * 1.2, 0.4);
    placeHero(71, 7, treeScale * 1.1, -0.8);
    const treeCount = study.flora === 'sail' ? (mobile ? 10 : 18) : (mobile ? 24 : 44);
    for (let index = 0; index < treeCount; index++) {
      const positionX = (random() - 0.5) * 250, positionZ = -25 - random() * 190;
      if (height(positionX, positionZ) < 2 || (positionX > -36 && positionX < 26 && positionZ > -105)) continue;
      scatter(treeKey, positionX, positionZ, treeScale * (0.55 + random() * 0.6), random() * 6.28);
    }
    random = randomSource(seed + 1021);
    for (let index = 0; index < (mobile ? 11 : 16); index++) {
      const side = index % 2 ? -1 : 1;
      const positionX = side * (42 + random() * 83), positionZ = -65 - random() * 160;
      scatter(index < 3 ? 'cliffNear' : 'cliffFar', positionX, positionZ, 0.75 + random() * 1.25, side * 0.5 + (random() - 0.5) * 0.5, height(positionX, positionZ) - 0.15);
    }
    random = randomSource(seed + 1049);
    for (let index = 0; index < (mobile ? 35 : 75); index++) {
      const positionX = (random() - 0.5) * 210, positionZ = 65 - random() * 220;
      scatter(index < 4 ? 'boulderNear' : 'boulderFar', positionX, positionZ, 0.25 + random() * 1.45, random() * 6.28, height(positionX, positionZ) - 0.35);
    }
    random = randomSource(seed + 1091);
    for (const [positionX, positionZ] of [[-33, 26], [16, 10], [35, -20], [-44, -40], [65, 12]]) {
      scatter('rootsNear', positionX, positionZ, 0.65, random() * 6.28, height(positionX, positionZ) - 0.4);
    }
    if (study.landform === 'skylands') {
      for (let index = 0; index < 6; index++) {
        const positionX = -120 + index * 42, positionZ = -170 - index % 3 * 22, altitude = 62 + index % 3 * 11;
        scatter('boulderFar', positionX, positionZ, 3.4, index * 0.9, altitude, true);
      }
    }
    for (const [key, placements] of batches) {
      if (key.startsWith('cliff') || key.startsWith('boulder')) library.instances(key, placements, scene, surface, floating);
    }
    geologicalClusters(scene, surface, study, seed, library.clock);
    const viewportSize = renderer.getSize(new Vector2());
    features = baseFeatures(study, seed, mobile, library.clock, surface, { camera, target, aspect: viewportSize.x / viewportSize.y });
    scene.add(features.group);
    water!.setCutouts(features.cutouts);
    weather = new EnvironmentWeather(study, seed, mobile, library.clock, terrain.userData.heightAt, (positionX, positionZ) => surface!.allowsVegetation(positionX, positionZ, 1));
    scene.add(weather.group);
    for (const [key, placements] of batches) {
      if (key.startsWith('cliff') || key.startsWith('boulder')) continue;
      const clear = placements.filter(matrix => surface!.allowsVegetation(matrix.elements[12], matrix.elements[14], key === 'rootsNear' ? 0 : 3));
      if (!clear.length) continue;
      if (key !== 'rootsNear') (scene.userData.treeRoots ??= []).push(...clear.map(matrix => [matrix.elements[12], matrix.elements[14]]));
      if (key.startsWith('original')) scene.add(projectTrees(library.assets.get(key)!.scene, clear, study, mobile, library.clock));
      else library.instances(key, clear, scene);
    }
    scene.add(patchGrass(study, seed, mobile, library.clock, (positionX, positionZ) => surface!.allowsVegetation(positionX, positionZ, 0.5)));
    const planet = celestialPlanet(seed, 68, study);
    planet.position.set(-101, 128, -340);
    planet.rotation.set(0.1, 0.5, -0.2);
    scene.add(planet);
  } else {
    scene.background = new Color('#10262e');
    scene.fog = new Fog('#10262e', 30, 100);
    const ground = new Mesh(new PlaneGeometry(160, 160), new MeshStandardNodeMaterial({ color: '#344c51', roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  const parasite = new Group();
  const rig = library.place('parasiteNear', new Vector3());
  parasite.add(rig);
  scene.add(parasite);
  const mixer = new AnimationMixer(rig);
  for (const animation of library.assets.get('parasiteNear')!.animations) mixer.clipAction(animation).play();
  mixer.setTime(0);
  parasite.updateMatrixWorld(true);
  parasite.traverse((object) => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
  const posed = new Box3().setFromObject(parasite, true);
  parasite.scale.setScalar((view === 'fauna' ? 6 : 8) / posed.getSize(new Vector3()).y);
  parasite.updateMatrixWorld(true);
  parasite.traverse((object) => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
  posed.setFromObject(parasite, true);
  const center = posed.getCenter(new Vector3());
  const creatureX = view === 'fauna' ? 0 : 15, creatureZ = view === 'fauna' ? 0 : 5;
  const creatureFloor = view === 'fauna' ? 0 : Math.max(0.6, landscapeHeight(creatureX, creatureZ, seed, study));
  parasite.position.set(creatureX - center.x, creatureFloor - posed.min.y, creatureZ - center.z);
  parasite.updateMatrixWorld(true);
  parasite.traverse((object) => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
  const pelvis = rig.getObjectByName('Pelvis_72');
  if (!pelvis) throw new Error('The imported parasite is missing its pelvis anchor');
  const pelvisAnchor = pelvis.getWorldPosition(new Vector3());
  const currentPelvis = new Vector3();
  scene.userData.specimenBounds = () => {
    const bounds = new Box3().setFromObject(parasite, true);
    return { min: bounds.min.toArray(), max: bounds.max.toArray() };
  };
  const creatures: Creature[] = [{ root: parasite, limbs: [], originY: 0, phase: 0, kind: 1 }];
  scene.userData.assetStudy = true;
  scene.userData.geometryAudit = () => {
    const field = surface!;
    if (!field) return null;
    const geometries = new Set(field.solids.filter(solid => !['lava', 'whirlpool'].includes(solid.kind)).map(solid => solid.mesh.geometry));
    let grassOverlaps = 0;
    scene.getObjectByName('study-grass')?.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const positions = object.geometry.attributes.position;
      for (let vertex = 0; vertex < positions.count; vertex += 5) if (!field.allowsVegetation(positions.getX(vertex), positions.getZ(vertex))) grassOverlaps++;
    });
    const axes = (name: string) => {
      const mesh = scene.getObjectByName(name) as InstancedMesh | undefined;
      return mesh ? Array.from({ length: mesh.count }, (_, index) => {
        const matrix = new Matrix4(); mesh.getMatrixAt(index, matrix);
        return new Vector3().setFromMatrixColumn(matrix, 1).normalize().toArray();
      }) : [];
    };
    const crystalMesh = scene.getObjectByName('base-crystals') as InstancedMesh;
    crystalMesh.geometry.computeBoundingBox();
    const crystalSize = crystalMesh.geometry.boundingBox!.getSize(new Vector3());
    const crystalSlenderness = Array.from({ length: crystalMesh.count }, (_, index) => {
      const matrix = new Matrix4(); crystalMesh.getMatrixAt(index, matrix);
      const scale = new Vector3().setFromMatrixScale(matrix);
      return crystalSize.y * scale.y / Math.min(crystalSize.x * scale.x, crystalSize.z * scale.z);
    });
    return { openEdges: [...geometries].map(geometry => boundaryEdges(geometry).length), grassOverlaps,
      grounding: field.groundingAudit(),
      spikeBaseGaps: field.solids.filter(solid => solid.kind === 'spike').map(solid => field.flatBaseGap(solid.mesh.geometry, solid.mesh.matrixWorld)),
      formationSources: field.solids.filter(solid => solid.kind === 'formation').map(solid => solid.mesh.geometry.userData.volumeSource),
      boulderCount: field.solids.filter(solid => solid.kind === 'boulder').length,
      formationAspect: field.solids.filter(solid => solid.kind === 'formation').map(solid => {
        const size = solid.mesh.geometry.boundingBox!.getSize(new Vector3()).toArray();
        return Math.min(...size) / Math.max(...size);
      }), crystalSlenderness,
      spikeShape: (scene.getObjectByName('base-spikes') as any)?.geometry.parameters,
      crystalShape: { type: crystalMesh.geometry.type, size: crystalSize.toArray() },
      treeOverlaps: (scene.userData.treeRoots ?? []).filter(([positionX, positionZ]: number[]) => !field.allowsVegetation(positionX, positionZ)).length,
      spikeAxes: axes('base-spikes'), crystalAxes: axes('base-crystals') };
  };
  return {
    scene, camera, target, surface, minDistance: view === 'fauna' ? 7 : 90, maxDistance: 230, creatures, ...stateControls(scene, weather),
    update(elapsed, activeCamera) {
      library.clock.value = elapsed;
      water?.update(elapsed);
      weather?.update(elapsed, activeCamera);
      features?.update(activeCamera);
      mixer.setTime(elapsed * 0.6);
      parasite.updateMatrixWorld(true);
      pelvis.getWorldPosition(currentPelvis);
      parasite.position.add(pelvisAnchor.clone().sub(currentPelvis));
      parasite.updateMatrixWorld(true);
    },
    dispose() { mixer.stopAllAction(); mixer.uncacheRoot(rig); library.dispose(scene); },
  };
}