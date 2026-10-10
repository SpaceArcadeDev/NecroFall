import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { autoRig, CRAWLER_RIG, type AutoRigSpec } from './AutoRig';
import { importedMaterial, type ImportedMaterial } from './ImportedMaterials';
import { readSwitches } from '../../rendering/DebugSwitches';
import { TerrainRig, type RigMotion } from './TerrainRig';
import { applyModelModules, moduleSocket, selectMeshModule, ModuleJoin, type MeshModule } from './ModelModules';
import type { BaseGenome, EnemyAnatomy } from './EnemyAnatomy';
import { normalizeAnatomy } from './EnemyAnatomy';

export type ImportedModelId = BaseGenome;

export function importedModelFor(genome: { species: string; tier: string; idx: number; anatomy?: EnemyAnatomy }): ImportedModelId | null {
  if (!importedBaseModelsEnabled()) return null;
  if (genome.anatomy) return genome.anatomy.base;
  if (genome.tier === 'nexus' || genome.tier === 'boss') return (['parasite', 'crawler', 'behemoth'] as const)[genome.idx % 3];
  if (genome.species === 'crawler') return 'crawler';
  return null;
}

/**
 * `?basemodels=0` — the A/B control for the imported bodies (the same shape as `?cel=0`):
 * every enemy falls back to its generated rig, so the cost of the imported models can be
 * measured on one machine in one session. Read once; consulted per spawn.
 */
let importedBaseModelsCache: boolean | null = null;

export function importedBaseModelsEnabled(): boolean {
  if (importedBaseModelsCache === null) {
    try {
      importedBaseModelsCache = readSwitches()['basemodels'] !== '0';
    } catch {
      importedBaseModelsCache = true;
    }
  }
  return importedBaseModelsCache;
}

export interface ImportedVisualState extends RigMotion {
  flash: number;
  frost: number;
  stunned: boolean;
  enraged: boolean;
}

interface ImportedModelDefinition {
  url: string;
  /** Provenance shown on the root's userData (mirrors `src/enemies/base_models/crawler.json`). */
  source: string;
  clip?: RegExp;
  /** Static sources get a geometry-derived rig from this table. */
  rig?: AutoRigSpec;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const MODELS: Record<ImportedModelId, ImportedModelDefinition> = {
  parasite: {
    url: new URL('../../concepts/assets/parasite-near.glb', import.meta.url).href,
    source: 'DM-913 Insectoid Monster Rig (CC BY 4.0)',
    clip: /prowl/i,
  },
  crawler: {
    url: new URL('../base_models/crawler.glb', import.meta.url).href,
    source: 'Tripo fantasy dragon, adapted for NECROFALL (see crawler.json)',
    rig: CRAWLER_RIG,
  },
  behemoth: {
    url: new URL('../base_models/behemoth.glb', import.meta.url).href,
    source: 'User-provided Tripo Behemoth, adapted for NECROFALL (see behemoth.json)',
  },
};

interface ImportedTemplate {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  height: number;
  center: THREE.Vector3;
  floor: number;
}

const templates = new Map<ImportedModelId, Promise<ImportedTemplate>>();

/** Rest-pose bounds — for skinned sources, measured with the walk clip parked at t = 0. */
function measurePose(root: THREE.Object3D, animations: THREE.AnimationClip[], definition: ImportedModelDefinition): { height: number; center: THREE.Vector3; floor: number } {
  const probe = animations.length > 0 ? new THREE.AnimationMixer(root) : null;
  if (probe) {
    const clip = animations.find((candidate) => definition.clip?.test(candidate.name)) ?? animations[0];
    probe.clipAction(clip).play();
    probe.setTime(0);
  }
  root.updateMatrixWorld(true);
  root.traverse((object) => { if (object instanceof THREE.SkinnedMesh) object.skeleton.update(); });
  const bounds = new THREE.Box3().setFromObject(root, true);
  if (probe) {
    const pose: { object: THREE.Object3D; position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3 }[] = [];
    root.traverse(object => pose.push({ object, position: object.position.clone(), rotation: object.quaternion.clone(), scale: object.scale.clone() }));
    probe.stopAllAction(); probe.uncacheRoot(root);
    for (const part of pose) {
      part.object.position.copy(part.position);
      part.object.quaternion.copy(part.rotation);
      part.object.scale.copy(part.scale);
    }
    root.updateMatrixWorld(true);
  }
  return { height: Math.max(0.001, bounds.max.y - bounds.min.y), center: bounds.getCenter(new THREE.Vector3()), floor: bounds.min.y };
}

/**
 * One loader pass per model per session. Static sources grow their skeleton HERE, on the
 * template geometry — every clone shares the vertex buffer, the skin weights and the source
 * material properties.
 */
function loadTemplate(id: ImportedModelId): Promise<ImportedTemplate> {
  const pending = templates.get(id);
  if (pending) return pending;
  const definition = MODELS[id];
  const loading = (async () => {
    const asset = await loader.loadAsync(definition.url);
    const scene = asset.scene as THREE.Group;
    if (definition.rig) rigStaticSurfaces(scene, definition.rig);
    return { root: scene, animations: asset.animations, ...measurePose(scene, asset.animations, definition) };
  })().catch((error) => { templates.delete(id); throw error; });
  templates.set(id, loading);
  return loading;
}

/**
 * The crawler source is ONE static surface: swap it for a SkinnedMesh bound to the derived rig.
 * The joint hierarchy lives INSIDE the mesh so `SkeletonUtils.clone` can rebind every instance.
 *
 * The meshopt pipeline quantises positions (KHR_mesh_quantization) and keeps the de-quantising
 * scale/offset on the NODE, so the geometry's own space is NOT the model space the joint table
 * is authored in. The transform is baked into a float copy of the surface first — after that the
 * geometry, the bones and the rig envelopes all live in the same space.
 */
function rigStaticSurfaces(scene: THREE.Group, rig: AutoRigSpec): void {
  scene.updateMatrixWorld(true);
  const surfaces: THREE.Mesh[] = [];
  scene.traverse((object) => { if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) surfaces.push(object); });
  for (const surface of surfaces) {
    const geometry = bakeSurfaceGeometry(surface.geometry, surface.matrixWorld);
    const skeleton = autoRig(geometry, rig);
    const skinned = new THREE.SkinnedMesh(geometry, surface.material);
    skinned.name = 'crawler-skin';
    skinned.add(skeleton.bones[0]);
    skinned.bind(skeleton);
    // Identity transform: the baked geometry already carries the source's placement.
    scene.add(skinned);
  }
  for (const surface of surfaces) {
    surface.removeFromParent();
    surface.geometry.dispose();
  }
}

/** Float copy of a (possibly quantised) surface, with `matrix` applied to positions/normals. */
function bakeSurfaceGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const position = source.attributes.position;
  const normal = source.attributes.normal;
  const uv = source.attributes.uv;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex++) {
    positions[vertex * 3] = position.getX(vertex);
    positions[vertex * 3 + 1] = position.getY(vertex);
    positions[vertex * 3 + 2] = position.getZ(vertex);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normal) {
    const normals = new Float32Array(normal.count * 3);
    for (let vertex = 0; vertex < normal.count; vertex++) {
      normals[vertex * 3] = normal.getX(vertex);
      normals[vertex * 3 + 1] = normal.getY(vertex);
      normals[vertex * 3 + 2] = normal.getZ(vertex);
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  }
  if (uv) {
    const uvs = new Float32Array(uv.count * 2);
    for (let vertex = 0; vertex < uv.count; vertex++) {
      uvs[vertex * 2] = uv.getX(vertex);
      uvs[vertex * 2 + 1] = uv.getY(vertex);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (source.index) geometry.setIndex(source.index.clone());
  geometry.applyMatrix4(matrix);
  geometry.normalizeNormals();
  return geometry;
}

export class ImportedVisual {
  readonly root = new THREE.Group();
  /** Chitin: the opaque surface carrying aggro veins, frost and hit flash. */
  readonly carapace: ImportedMaterial;
  /** Membrane: emissive tissue when the source ships one, otherwise the chitin material again. */
  readonly energy: ImportedMaterial;
  readonly flashMats: ImportedMaterial[];
  readonly core: null = null;
  /** True when the chitin surface carries a base colour map (the painted detail survived). */
  readonly textured: boolean;

  private readonly normalizer = new THREE.Group();
  private readonly materials: ImportedMaterial[] = [];
  private readonly offset = new THREE.Vector3();
  readonly locomotion: TerrainRig;
  private readonly moduleGeometries: THREE.BufferGeometry[];

  private constructor(private readonly model: THREE.Object3D, template: ImportedTemplate, height: number, id: ImportedModelId, anatomy?: EnemyAnatomy, private readonly joins: ModuleJoin[] = [], geometries: THREE.BufferGeometry[] = []) {
    this.root.name = `${id}-imported`;
    this.root.userData.source = MODELS[id].source;
    this.root.scale.setScalar(height / template.height);
    this.normalizer.position.copy(this.offset.set(-template.center.x, -template.floor, -template.center.z));
    this.normalizer.add(model);
    this.root.add(this.normalizer);
    this.moduleGeometries = geometries;

    // ONE opaque surface per imported model (`{id}:chitin`) plus, on the insectoid rig, the
    // translucent wings (`parasite:membrane`) — mapped onto the same carapace/energy pair the
    // procedural creatures expose, so every gameplay system writes the same uniforms.
    const carapaceSource = surfaceMaterials(model, false, true)[0];
    this.carapace = importedMaterial(carapaceSource, false);
    if (anatomy) {
      this.carapace.uTint.value.setHex(anatomy.color);
      this.carapace.uAccent.value.setHex(anatomy.accent);
    }
    this.textured = Boolean(carapaceSource.map);
    const membrane = surfaceMaterials(model, true, true)[0] ?? null;
    this.energy = membrane ? importedMaterial(membrane, true) : this.carapace;
    this.materials.push(this.carapace);
    if (this.energy !== this.carapace) this.materials.push(this.energy);
    this.flashMats = this.materials;

    const graftMaterials = new Map<string, ImportedMaterial>();
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const sources = Array.isArray(object.material) ? object.material : [object.material];
      const converted = sources.map(source => {
        if (source.name.startsWith(`${id}:`)) return source.name.endsWith(':membrane') ? this.energy : this.carapace;
        let material = graftMaterials.get(source.uuid);
        if (!material) {
          material = importedMaterial(source as THREE.MeshStandardMaterial, source.name.endsWith(':membrane'));
          material.uTint.value.copy(this.carapace.uTint.value);
          material.uAccent.value.copy(this.carapace.uAccent.value);
          graftMaterials.set(source.uuid, material);
          this.materials.push(material);
        }
        return material;
      });
      object.material = Array.isArray(object.material) ? converted : converted[0];
      if (object.geometry.index?.count === 0) object.visible = false;
      object.castShadow = true;
      object.receiveShadow = true;
      // The body is a single skinned shell whose rest bounds lag the animated pose, and the
      // enemy system already owns visibility (distance culling hides whole bodies).
      object.frustumCulled = false;
    });

    this.root.updateMatrixWorld(true);
    this.joins.forEach(join => join.update());
    this.locomotion = new TerrainRig(this.root, model, id, height);
    for (const material of this.materials) {
      material.uPatternScale.value = 5 / template.height;
      if (!anatomy) continue;
      material.uTint.value.setHex(anatomy.color);
      material.uTintAmount.value = 0.9;
      material.uAccent.value.setHex(anatomy.accent);
      material.uGlow.value = anatomy.glow ?? 0.9;
      material.uPattern.value = ['veins', 'bands', 'cells'].indexOf(anatomy.pattern ?? 'veins');
      material.uPhase.value = anatomy.accent % 101 / 16;
    }
  }

  static async create(id: ImportedModelId, height: number, anatomy?: EnemyAnatomy): Promise<ImportedVisual> {
    if (anatomy) anatomy = normalizeAnatomy({ ...anatomy, base: id });
    const template = await loadTemplate(id);
    const model = clone(template.root);
    model.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.userData.primaryRig = true; });
    const geometries = anatomy ? applyModelModules(model, anatomy) : [];
    const joins: ModuleJoin[] = [];
    if (anatomy) {
      const parts: [MeshModule, ImportedModelId | undefined][] = [['head', anatomy.headBase], ['tail', anatomy.tail > 0 ? anatomy.tailBase : id]];
      for (const [kind, donorId] of parts) {
        if (!donorId || donorId === id) continue;
        const donorTemplate = await loadTemplate(donorId);
        const donor = clone(donorTemplate.root);
        model.updateMatrixWorld(true); donor.updateMatrixWorld(true);
        const target = moduleSocket(model, kind), origin = moduleSocket(donor, kind);
        const hostBoundary = selectMeshModule(model, kind, false);
        const donorBoundary = selectMeshModule(donor, kind, true);
        const targetPoint = hostBoundary.radius > 0 ? hostBoundary.centre : target.getWorldPosition(new THREE.Vector3());
        const originPoint = donorBoundary.radius > 0 ? donorBoundary.centre : origin.getWorldPosition(new THREE.Vector3());
        const ratio = template.height / donorTemplate.height * (kind === 'head' ? anatomy.head : anatomy.tail);
        const transform = new THREE.Matrix4().copy(target.matrixWorld).invert()
          .multiply(new THREE.Matrix4().makeTranslation(targetPoint))
          .multiply(new THREE.Matrix4().makeScale(ratio, ratio, ratio))
          .multiply(new THREE.Matrix4().makeTranslation(originPoint.negate()));
        const socket = new THREE.Group();
        socket.name = `${kind}-module:${donorId}`;
        donor.userData.moduleDonor = true;
        socket.applyMatrix4(transform); socket.add(donor); target.add(socket);
        model.updateMatrixWorld(true);
        const join = new ModuleJoin(hostBoundary, donorBoundary, surfaceMaterials(model, false, true)[0], kind);
        model.add(join.mesh);
        joins.push(join);
      }
    }
    return new ImportedVisual(model, template, height, id, anatomy, joins, geometries);
  }

  get clock(): number {
    return this.locomotion.clock;
  }

  moduleDiagnostics() { return this.joins.map(join => join.diagnostics()); }

  /**
   * One frame of locomotion + status. `moving` is the 0..1 speed blend the simulator already
   * computes; a stunned body freezes mid-step (the punish window must read), an enraged one
   * pushes harder, and every state rides the material uniforms for hit flash and cryo.
   */
  update(dt: number, moving: number, state: ImportedVisualState): void {
    this.locomotion.update(dt, state.stunned, state);
    if (this.joins.length) {
      this.root.updateMatrixWorld(true);
      this.joins.forEach(join => join.update());
    }

    const broken = state.stunned;
    this.carapace.uState.value.set(broken ? '#ffdf45' : '#ff3028');
    this.carapace.uStateAmount.value = broken ? 0.65 : state.enraged ? 0.42 : 0;
    if (this.energy !== this.carapace) {
      this.energy.uState.value.copy(this.carapace.uState.value);
      this.energy.uStateAmount.value = this.carapace.uStateAmount.value;
    }
    for (const material of this.flashMats) {
      material.uSurfaceFrame.value.copy(this.root.matrixWorld).invert();
      material.uState.value.copy(this.carapace.uState.value);
      material.uStateAmount.value = this.carapace.uStateAmount.value;
      material.uAggro.value = this.carapace.uAggro.value;
      material.uFlash.value = state.flash;
      material.uFreeze.value = state.frost;
    }
  }

  dispose(): void {
    this.joins.forEach(join => join.dispose());
    this.moduleGeometries.forEach(geometry => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    const skeletons = new Set<THREE.Skeleton>();
    this.model.traverse((object) => { if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton); });
    skeletons.forEach((skeleton) => skeleton.dispose());
    this.root.removeFromParent();
  }
}

/** The template's surface materials of one family (membrane when `true`, chitin otherwise). */
function surfaceMaterials(root: THREE.Object3D, membrane: boolean, primaryOnly = false): THREE.MeshStandardMaterial[] {
  const found: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (primaryOnly && !object.userData.primaryRig) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const typed = material as THREE.MeshStandardMaterial;
      if (typed.name.endsWith(':membrane') === membrane) found.push(typed);
    }
  });
  if (found.length === 0 && !membrane) throw new Error('Imported model has no surfaces');
  return found;
}
