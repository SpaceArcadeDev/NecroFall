import { AnimationMixer, Box3, Color, Group, Mesh, MeshStandardNodeMaterial, SkinnedMesh, Vector3, type Object3D, type MeshStandardMaterial } from 'three/webgpu';
import { color, mix, texture, uniform } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let template: ReturnType<GLTFLoader['loadAsync']> | null = null;

export class MegaVisual {
  readonly root = new Group();
  private readonly normalizer = new Group();
  private readonly materials: MeshStandardNodeMaterial[] = [];
  private readonly flash = uniform(0);
  private readonly frost = uniform(0);
  private readonly stateAmount = uniform(0);
  private readonly stateColor = uniform(new Color());
  private readonly anchor = new Vector3();
  private readonly current = new Vector3();
  private readonly offset = new Vector3();
  private readonly mixer: AnimationMixer;
  private readonly pelvis: Object3D;

  private constructor(private readonly model: Group, animations: Awaited<NonNullable<typeof template>>['animations'], height: number) {
    this.root.name = 'mega-necrophage-imported';
    this.root.userData.source = 'DM-913 Insectoid Monster Rig (CC BY 4.0)';
    this.normalizer.add(model); this.root.add(this.normalizer);
    model.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const convert = (source: MeshStandardMaterial) => {
        const material = new MeshStandardNodeMaterial({ color: source.color, map: source.map, normalMap: source.normalMap,
          roughnessMap: source.roughnessMap, metalnessMap: source.metalnessMap, aoMap: source.aoMap,
          roughness: source.roughness, metalness: source.metalness, emissive: source.emissive,
          emissiveMap: source.emissiveMap, alphaTest: source.alphaTest, side: source.side });
        material.normalScale.copy(source.normalScale);
        const base = source.map ? texture(source.map).rgb.mul(color(source.color)) : color(source.color);
        material.colorNode = mix(mix(mix(base, this.stateColor, this.stateAmount), color('#9fddf5'), this.frost.mul(0.75)), color('#ffffff'), this.flash);
        this.materials.push(material); return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(source => convert(source as MeshStandardMaterial)) : convert(object.material as MeshStandardMaterial);
      object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false;
    });
    this.mixer = new AnimationMixer(model);
    const animation = animations.find(clip => /prowl/i.test(clip.name)) ?? animations[0];
    if (animation) this.mixer.clipAction(animation).play();
    this.mixer.setTime(0);
    this.root.updateMatrixWorld(true);
    model.traverse(object => { if (object instanceof SkinnedMesh) object.skeleton.update(); });
    const bounds = new Box3().setFromObject(model, true);
    const center = bounds.getCenter(new Vector3());
    this.root.scale.setScalar(height / Math.max(0.001, bounds.getSize(new Vector3()).y));
    this.offset.set(-center.x, -bounds.min.y, -center.z);
    this.normalizer.position.copy(this.offset);
    this.pelvis = model.getObjectByName('Pelvis_72')!;
    if (!this.pelvis) throw new Error('Mega Necrophage asset is missing its pelvis anchor');
    this.root.updateMatrixWorld(true);
    this.normalizer.worldToLocal(this.pelvis.getWorldPosition(this.anchor));
  }

  static async create(height: number): Promise<MegaVisual> {
    template ??= loader.loadAsync(new URL('../concepts/assets/parasite-near.glb', import.meta.url).href).catch(error => { template = null; throw error; });
    const asset = await template;
    return new MegaVisual(clone(asset.scene) as Group, asset.animations, height);
  }

  update(dt: number, moving: number, state: { flash: number; frost: number; stunned: boolean; enraged: boolean }): void {
    this.mixer.update(dt * (state.stunned ? 0 : 0.25 + moving * 1.1));
    this.root.updateWorldMatrix(true, true);
    this.normalizer.worldToLocal(this.pelvis.getWorldPosition(this.current));
    this.normalizer.position.set(this.offset.x + this.anchor.x - this.current.x, this.offset.y, this.offset.z + this.anchor.z - this.current.z);
    this.flash.value = state.flash; this.frost.value = state.frost;
    this.stateColor.value.set(state.stunned ? '#ffdf45' : '#ff3028');
    this.stateAmount.value = state.stunned ? 0.65 : state.enraged ? 0.42 : 0;
  }

  dispose(): void {
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    this.materials.forEach(material => material.dispose());
    const skeletons = new Set<SkinnedMesh['skeleton']>();
    this.model.traverse(object => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
    skeletons.forEach(skeleton => skeleton.dispose()); this.root.removeFromParent();
  }
}