// NECROFALL — the one loader/cache for Folio world assets (plan §30, §53).
//
// All Folio 2025 models are shipped compressed (KTX2/ETC1S textures + Draco edgebreaker meshes —
// see scripts/compress-world-assets.mjs) and loaded through GLTFLoader with the matching
// decoders. Everything is cached per URL and every consumer clones GEOMETRY REFERENCES, never
// GPU resources: one tree visual = one geometry + one material for hundreds of instances.
import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/** Where the vendored Folio assets live (public/environment/folio). */
const ASSET_BASE = `${import.meta.env.BASE_URL ?? '/'}environment/folio/`;

/** A visual model + its reference transforms, Folio's tree contract. */
export interface FolioTreeAsset {
  /** Contains `treeBody` / `treeLeaves*` meshes (see Trees.ts). */
  visual: THREE.Object3D;
  /** Children carry the per-tree transforms (position + scale) the forest is built from. */
  references: THREE.Object3D;
}

export interface FolioEnvironmentAssets {
  birch: FolioTreeAsset;
  oak: FolioTreeAsset;
  cherry: FolioTreeAsset;
  /** Bush placeholder transforms (Foliage consumes each child as a cluster). */
  bushes: THREE.Object3D;
  /** Flower cluster transforms. */
  flowers: THREE.Object3D;
  /** Folio scenery kit: bricks, fences, benches, crates, lanterns, pole lights. */
  scenery: THREE.Object3D;
  bricks: THREE.Object3D;
  fences: THREE.Object3D;
  benches: THREE.Object3D;
  crates: THREE.Object3D;
  lanterns: THREE.Object3D;
  poleLights: THREE.Object3D;
  /** Foliage SDF alpha texture (Folio's foliage/foliageSDF). */
  foliageTexture: THREE.Texture;
}

/** Progress: (loaded, total) for the loading screen. */
type ProgressFn = (loaded: number, total: number) => void;

export class FolioResources {
  private readonly gltfLoader: GLTFLoader;
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly cache = new Map<string, Promise<unknown>>();
  /** Cloned GLTF scenes must not double-dispose their shared geometry. */
  private readonly ownedPaths = new Set<string>();

  constructor(renderer: THREE.WebGPURenderer) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${ASSET_BASE}draco/`);
    draco.preload();

    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath(`${ASSET_BASE}basis/`);
    try {
      ktx2.detectSupport(renderer);
    } catch {
      // KTX2 support detection is best-effort; our Folio models carry no KTX2 textures today.
    }

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(draco);
    this.gltfLoader.setKTX2Loader(ktx2);
  }

  loadGLTF(file: string): Promise<GLTF> {
    return this.cached(`gltf:${file}`, () => this.gltfLoader.loadAsync(`${ASSET_BASE}${file}`));
  }

  loadTexture(file: string): Promise<THREE.Texture> {
    return this.cached(`tex:${file}`, async () => {
      const texture = await this.textureLoader.loadAsync(`${ASSET_BASE}${file}`);
      // Data textures (SDF/shape masks) are never colour-managed.
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      // Folio loads its foliage SDF with NEAREST filtering and NO mipmaps (Game.js resources
      // list). Mipmapped linear filtering averages the soft leaf blobs down to the texture mean
      // (~0.35) at canopy distances, and the foliage alpha chain (`- 0.3`, discard `< 0.1`)
      // then erases almost every leaf pixel — the "trees have no canopy" bug. Nearest keeps
      // each leaf's own value at every distance (and is folio's actual look: crisp cutouts).
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      return texture;
    });
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let entry = this.cache.get(key) as Promise<T> | undefined;
    if (!entry) {
      entry = load();
      this.cache.set(key, entry);
    }
    return entry;
  }

  /**
   * Load everything the Folio world needs. One concurrent batch, one progress readout — the
   * game's loading UI already drives this.
   */
  async loadEnvironment(onProgress?: ProgressFn): Promise<FolioEnvironmentAssets> {
    const files: Array<[string, string]> = [
      ['birchVisual', 'trees/birchTreesVisual.glb'],
      ['birchRefs', 'trees/birchTreesReferences.glb'],
      ['oakVisual', 'trees/oakTreesVisual.glb'],
      ['oakRefs', 'trees/oakTreesReferences.glb'],
      ['cherryVisual', 'trees/cherryTreesVisual.glb'],
      ['cherryRefs', 'trees/cherryTreesReferences.glb'],
      ['bushes', 'bushes/bushesReferences.glb'],
      ['flowers', 'flowers/flowersReferences.glb'],
      ['scenery', 'scenery/scenery.glb'],
      ['bricks', 'scenery/bricks.glb'],
      ['fences', 'scenery/fences.glb'],
      ['benches', 'scenery/benches.glb'],
      ['crates', 'scenery/explosiveCrates.glb'],
      ['lanterns', 'scenery/lanterns.glb'],
      ['poleLights', 'scenery/poleLights.glb'],
    ];

    let loaded = 0;
    const total = files.length + 1;
    const tick = () => onProgress?.(++loaded, total);

    const loadedGltfs = await Promise.all(
      files.map(async ([key, file]) => {
        const gltf = await this.loadGLTF(file);
        tick();
        return [key, gltf] as const;
      }),
    );

    const gltfs = Object.fromEntries(loadedGltfs) as Record<string, GLTF>;
    const foliageTexture = await this.loadTexture('foliageSDF.png');
    tick();

    const sceneOf = (key: string): THREE.Object3D => gltfs[key].scene;

    return {
      birch: { visual: sceneOf('birchVisual'), references: sceneOf('birchRefs') },
      oak: { visual: sceneOf('oakVisual'), references: sceneOf('oakRefs') },
      cherry: { visual: sceneOf('cherryVisual'), references: sceneOf('cherryRefs') },
      bushes: sceneOf('bushes'),
      flowers: sceneOf('flowers'),
      scenery: sceneOf('scenery'),
      bricks: sceneOf('bricks'),
      fences: sceneOf('fences'),
      benches: sceneOf('benches'),
      crates: sceneOf('crates'),
      lanterns: sceneOf('lanterns'),
      poleLights: sceneOf('poleLights'),
      foliageTexture,
    };
  }
}
