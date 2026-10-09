/**
 * NECROFALL — resource loader (folio `ResourcesLoader.js` port, plan §52).
 *
 * URL ⇒ promise cache: the same GLB is fetched ONCE no matter how many tree
 * types / instances reference it. Draco decoders are vendored under /draco.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export class ResourcesLoader {
  private readonly cache = new Map<string, Promise<unknown>>();
  private draco: DRACOLoader | null = null;
  private ktx2: KTX2Loader | null = null;
  private gltf: GLTFLoader | null = null;

  /** Renderer is optional — KTX2 support detection needs it when present. */
  constructor(private renderer?: THREE.WebGPURenderer) {}

  private gltfLoader(): GLTFLoader {
    if (this.gltf) return this.gltf;

    if (!this.draco) {
      this.draco = new DRACOLoader();
      this.draco.setDecoderPath('/draco/');
      this.draco.preload();
    }
    if (!this.ktx2 && this.renderer) {
      this.ktx2 = new KTX2Loader();
      this.ktx2.setTranscoderPath('/basis/');
      this.ktx2.detectSupport(this.renderer as any);
    }

    this.gltf = new GLTFLoader();
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
    this.gltf.setDRACOLoader(this.draco);
    if (this.ktx2) this.gltf.setKTX2Loader(this.ktx2);
    return this.gltf;
  }

  loadGLTF(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
    const cached = this.cache.get(url);
    if (cached) return cached as Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>;

    const promise = new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
      this.gltfLoader().load(
        url,
        (gltf) => resolve({ scene: gltf.scene as unknown as THREE.Group, animations: gltf.animations }),
        undefined,
        (error) => reject(error),
      );
    });
    this.cache.set(url, promise);
    return promise;
  }

  loadTexture(url: string): Promise<THREE.Texture> {
    const cached = this.cache.get(url);
    if (cached) return cached as Promise<THREE.Texture>;

    const promise = new Promise<THREE.Texture>((resolve, reject) => {
      new THREE.TextureLoader().load(url, resolve, undefined, reject);
    });
    this.cache.set(url, promise);
    return promise;
  }

  async loadAll(entries: [key: string, url: string, type: 'gltf' | 'texture'][]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    await Promise.all(
      entries.map(async ([key, url, type]) => {
        results[key] = type === 'gltf' ? await this.loadGLTF(url) : await this.loadTexture(url);
      }),
    );
    return results;
  }

  dispose(): void {
    this.draco?.dispose();
    this.ktx2?.dispose();
    this.cache.clear();
  }
}
