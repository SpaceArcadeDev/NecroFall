// NECROFALL — imported enemy base models (plan §31's "base model" slot, now shared).
//
// Two bodies in the bestiary are not built from `EnemyModels` primitives but imported:
//
//   parasite  the DM-913 insectoid rig — the Nexus Overseer's Mega Necrophage. It arrives
//             WITH a skeleton and a baked walk clip ('Prowl'), so this visual plays it through
//             an AnimationMixer and keeps the body planted on its own pelvis.
//   crawler   the cell-shaded crawler base model (`src/enemies/base_models/crawler.glb`).
//             The source is a static Tripo mesh, so the rig is DERIVED from its geometry
//             (`AutoRig.ts`) and driven procedurally — the same vocabulary `animateEnemyRig`
//             uses for every generated creature.
//
// Both go through ONE visual, so gameplay code never branches on where a body came from:
// materials are rebuilt cell-shaded (`ImportedMaterials`), hit flash / cryo frost / aggro veins
// / boss state wash ride the same uniforms, and the simulator keeps owning movement, targeting
// and damage for either body.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { autoRig, CRAWLER_RIG, type AutoRigSpec } from './AutoRig';
import { importedMaterial, type ImportedMaterial } from './ImportedMaterials';
import { readSwitches } from '../../rendering/DebugSwitches';

export type ImportedModelId = 'parasite' | 'crawler';

/**
 * Which imported base model (if any) stands in for a genome's procedural body:
 *
 *   nexus      the Nexus Overseer is ALWAYS the Mega Necrophage;
 *   boss       the four Beacon Guardians alternate between the two imported bodies (their genome
 *              indices are consecutive), so every match fields two of each — and a guardian still
 *              reads as one of the big imported monsters while it guards its Beacon;
 *   crawler    crawler-species Necrophages wear the cell-shaded crawler base model.
 *
 * Every other genome keeps its generated rig, and `?basemodels=0` disables the whole layer.
 */
export function importedModelFor(genome: { species: string; tier: string; idx: number }): ImportedModelId | null {
  if (!importedBaseModelsEnabled()) return null;
  if (genome.tier === 'nexus') return 'parasite';
  if (genome.tier === 'boss') return genome.idx % 2 === 0 ? 'parasite' : 'crawler';
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

export interface ImportedVisualState {
  flash: number;
  frost: number;
  stunned: boolean;
  enraged: boolean;
}

interface ImportedModelDefinition {
  url: string;
  /** Provenance shown on the root's userData (mirrors `src/enemies/base_models/crawler.json`). */
  source: string;
  /** Looping clip for skinned sources ('Prowl' on the insectoid rig). */
  clip?: RegExp;
  /** Bone the body is kept planted by (the insectoid rig's pelvis). */
  anchor?: string;
  /** Static sources get a geometry-derived rig from this table. */
  rig?: AutoRigSpec;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const MODELS: Record<ImportedModelId, ImportedModelDefinition> = {
  parasite: {
    url: new URL('../../concepts/assets/parasite-near.glb', import.meta.url).href,
    source: 'DM-913 Insectoid Monster Rig (CC BY 4.0)',
    clip: /prowl/i,
    anchor: 'Pelvis_72',
  },
  crawler: {
    url: new URL('../base_models/crawler.glb', import.meta.url).href,
    source: 'Tripo fantasy dragon, adapted for NECROFALL (see crawler.json)',
    rig: CRAWLER_RIG,
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
  if (probe) { probe.stopAllAction(); probe.uncacheRoot(root); }
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

interface CrawlerJoints {
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  spineRestY: number;
  tail: THREE.Bone[];
  legs: { upper: THREE.Bone; lower: THREE.Bone; phase: number }[];
}

/** The enemy visual for an imported body — Mega Necrophage or crawler. */
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
  private readonly anchorPoint = new THREE.Vector3();
  private readonly current = new THREE.Vector3();
  private readonly anchor: THREE.Object3D | null = null;
  private readonly mixer: THREE.AnimationMixer | null = null;
  private readonly joints: CrawlerJoints | null = null;
  private gaitClock = 0;

  private constructor(private readonly model: THREE.Object3D, template: ImportedTemplate, height: number, id: ImportedModelId) {
    this.root.name = `${id}-imported`;
    this.root.userData.source = MODELS[id].source;
    this.root.scale.setScalar(height / template.height);
    this.normalizer.position.copy(this.offset.set(-template.center.x, -template.floor, -template.center.z));
    this.normalizer.add(model);
    this.root.add(this.normalizer);

    // ONE opaque surface per imported model (`{id}:chitin`) plus, on the insectoid rig, the
    // translucent wings (`parasite:membrane`) — mapped onto the same carapace/energy pair the
    // procedural creatures expose, so every gameplay system writes the same uniforms.
    this.carapace = importedMaterial(surfaceMaterials(model, false)[0], false);
    this.textured = Boolean(surfaceMaterials(model, false)[0].map);
    const membrane = surfaceMaterials(model, true)[0] ?? null;
    this.energy = membrane ? importedMaterial(membrane, true) : this.carapace;
    this.materials.push(this.carapace);
    if (this.energy !== this.carapace) this.materials.push(this.energy);
    this.flashMats = this.materials;

    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const sources = Array.isArray(object.material) ? object.material : [object.material];
      const converted = sources.map((source) => ((source as THREE.Material).name.endsWith(':membrane') ? this.energy : this.carapace));
      object.material = Array.isArray(object.material) ? converted : converted[0];
      object.castShadow = true;
      object.receiveShadow = true;
      // The body is a single skinned shell whose rest bounds lag the animated pose, and the
      // enemy system already owns visibility (distance culling hides whole bodies).
      object.frustumCulled = false;
    });

    if (template.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(model);
      const animation = template.animations.find((clip) => MODELS[id].clip?.test(clip.name)) ?? template.animations[0];
      if (animation) this.mixer.clipAction(animation).play();
      this.mixer.setTime(0);
    }
    if (MODELS[id].anchor) {
      const anchor = model.getObjectByName(MODELS[id].anchor!);
      if (!anchor) throw new Error(`Imported model '${id}' is missing its ${MODELS[id].anchor} anchor`);
      this.anchor = anchor;
      this.root.updateMatrixWorld(true);
      this.normalizer.worldToLocal(anchor.getWorldPosition(this.anchorPoint));
    }
    if (MODELS[id].rig) this.joints = collectCrawlerJoints(model);
  }

  static async create(id: ImportedModelId, height: number): Promise<ImportedVisual> {
    const template = await loadTemplate(id);
    return new ImportedVisual(clone(template.root), template, height, id);
  }

  /** Animation clock: mixer time on skinned sources, the gait clock on driven rigs. */
  get clock(): number {
    return this.mixer ? this.mixer.time : this.gaitClock;
  }

  /**
   * One frame of locomotion + status. `moving` is the 0..1 speed blend the simulator already
   * computes; a stunned body freezes mid-step (the punish window must read), an enraged one
   * pushes harder, and every state rides the material uniforms for hit flash and cryo.
   */
  update(dt: number, moving: number, state: ImportedVisualState): void {
    if (this.mixer) this.mixer.update(dt * (state.stunned ? 0 : 0.25 + moving * 1.1));
    if (this.joints) this.driveCrawler(dt, moving, state);

    if (this.anchor) {
      // Keep the walk cycle planted: the pelvis drives the body, the anchor pins it in place.
      this.root.updateWorldMatrix(true, true);
      this.normalizer.worldToLocal(this.anchor.getWorldPosition(this.current));
      this.normalizer.position.set(
        this.offset.x + this.anchorPoint.x - this.current.x,
        this.offset.y,
        this.offset.z + this.anchorPoint.z - this.current.z,
      );
    }

    const broken = state.stunned;
    this.carapace.uState.value.set(broken ? '#ffdf45' : '#ff3028');
    this.carapace.uStateAmount.value = broken ? 0.65 : state.enraged ? 0.42 : 0;
    if (this.energy !== this.carapace) {
      this.energy.uState.value.copy(this.carapace.uState.value);
      this.energy.uStateAmount.value = this.carapace.uStateAmount.value;
    }
    for (const material of this.flashMats) {
      material.uFlash.value = state.flash;
      material.uFreeze.value = state.frost;
    }
  }

  /**
   * The crawler gait. The model's rest pose is already mid-stride, so the solver rides the pose
   * it was given: legs swing in diagonal pairs from the hip, the spine bobs and rolls, the neck
   * pumps, and a travelling wave runs down the curled tail. Nothing is baked — idling, charging,
   * a stunned body and an enraged one all read differently off the same inputs.
   */
  private driveCrawler(dt: number, moving: number, state: ImportedVisualState): void {
    const joints = this.joints!;
    const effort = state.stunned ? 0 : 0.35 + moving * 1.15;
    this.gaitClock += dt * effort;
    const p = this.gaitClock * 2.4;
    const amp = (0.25 + moving * 0.75) * (state.enraged ? 1.25 : 1) * (state.stunned ? 0.15 : 1);

    for (const leg of joints.legs) {
      const phase = p + leg.phase;
      leg.upper.rotation.x = Math.sin(phase) * 0.3 * amp;
      leg.upper.rotation.z = Math.sin(phase + 0.4) * 0.05 * amp;
      leg.lower.rotation.x = Math.max(0, -Math.sin(phase + 0.75)) * 0.38 * amp;
    }

    joints.spine.position.y = joints.spineRestY + Math.sin(p * 2) * 0.016 * amp;
    joints.spine.rotation.x = Math.sin(p * 2 + 0.6) * 0.02 * amp + (state.stunned ? 0.1 : 0);
    joints.spine.rotation.y = Math.sin(p) * 0.05 * amp;
    // Enraged bodies tremble; a stunned one goes slack instead.
    joints.spine.rotation.z = Math.sin(p + 0.8) * 0.045 * amp + (state.enraged ? Math.sin(this.gaitClock * 26) * 0.012 : 0);
    joints.chest.rotation.y = -Math.sin(p) * 0.045 * amp;
    joints.chest.rotation.x = Math.sin(p * 2 + 1.4) * 0.02 * amp;
    joints.neck.rotation.x = Math.sin(p * 2 + 1.1) * 0.05 * amp + Math.sin(this.gaitClock * 0.9) * 0.02;
    joints.neck.rotation.y = Math.sin(p * 0.5) * 0.05;
    joints.head.rotation.x = Math.sin(p * 2 + 1.9) * 0.045 * amp;
    joints.head.rotation.y = Math.sin(p * 0.5 + 0.9) * 0.07;

    for (let index = 0; index < joints.tail.length; index++) {
      const tail = joints.tail[index];
      const wave = p * 1.15 - index * 0.55;
      tail.rotation.x = Math.sin(wave) * (0.05 + index * 0.012) * (0.4 + moving) * 2;
      tail.rotation.y = Math.sin(wave * 0.8 - 0.4) * (0.06 + index * 0.02) * (0.5 + moving) * 2;
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    if (this.mixer) this.mixer.uncacheRoot(this.model);
    this.materials.forEach((material) => material.dispose());
    const skeletons = new Set<THREE.Skeleton>();
    this.model.traverse((object) => { if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton); });
    skeletons.forEach((skeleton) => skeleton.dispose());
    this.root.removeFromParent();
  }
}

/** The template's surface materials of one family (membrane when `true`, chitin otherwise). */
function surfaceMaterials(root: THREE.Object3D, membrane: boolean): THREE.MeshStandardMaterial[] {
  const found: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const typed = material as THREE.MeshStandardMaterial;
      if (typed.name.endsWith(':membrane') === membrane) found.push(typed);
    }
  });
  if (found.length === 0 && !membrane) throw new Error('Imported model has no surfaces');
  return found;
}

/**
 * Pulls the gait bones out of a cloned crawler. Leg phases make a diagonal trot: the lifted
 * left-rear leg pairs with the planted right-front one, exactly how the source pose reads.
 */
function collectCrawlerJoints(root: THREE.Object3D): CrawlerJoints {
  const bone = (name: string): THREE.Bone => {
    const found = root.getObjectByName(name);
    if (!(found instanceof THREE.Bone)) throw new Error(`Crawler rig is missing its ${name} bone`);
    return found;
  };
  const leg = (suffix: string, phase: number) => ({ upper: bone(`Leg${suffix}`), lower: bone(`Shin${suffix}`), phase });
  const spine = bone('Spine');
  return {
    spine,
    chest: bone('Chest'),
    neck: bone('Neck'),
    head: bone('Head'),
    spineRestY: spine.position.y,
    tail: [bone('Tail1'), bone('Tail2'), bone('Tail3'), bone('Tail4'), bone('Tail5'), bone('Tail6')],
    legs: [leg('FL', Math.PI), leg('FR', 0), leg('BL', 0), leg('BR', Math.PI)],
  };
}
