/**
 * NECROFALL — renderer + post pipeline (folio `Rendering.js` port, plan §6).
 *
 * ONE WebGPURenderer, ONE RenderPipeline:
 *
 *     scene pass → bloom (threshold 1 / strength 0.25) → cheap DOF (level 0)
 *
 * Never call `renderer.render(scene, camera)` — everything goes through
 * `postProcessing.render()`.
 */
import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { cheapDOF } from './Passes/cheapDOF';
import type { Quality } from './Quality';
import type { Viewport } from './Viewport';
import type { StatsOverlay } from './DebugSwitches';

export interface RenderingOptions {
  /** Force WebGL2 backend even when navigator.gpu exists. */
  forceWebGL?: boolean;
}

export class Rendering {
  renderer!: THREE.WebGPURenderer;
  postProcessing!: THREE.RenderPipeline;
  ready = false;

  private scenePass!: any;
  private scenePassColor!: any;
  private bloomPass!: any;
  private cheapDOFPass: any = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewport: Viewport,
    private readonly quality: Quality,
    private readonly options: RenderingOptions = {},
  ) {}

  get drawCalls(): number {
    return (this.renderer?.info as any)?.render?.drawCalls ?? 0;
  }

  async init(scene: THREE.Scene, camera: THREE.Camera): Promise<this> {
    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

    this.renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      powerPreference: 'high-performance',
      forceWebGL: this.options.forceWebGL ?? !webgpu,
      antialias: this.viewport.pixelRatio < 2,
    });
    this.renderer.setSize(this.viewport.width, this.viewport.height);
    this.renderer.setPixelRatio(this.viewport.pixelRatio);
    this.renderer.sortObjects = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.setOpaqueSort((a, b) => (a?.renderOrder ?? 0) - (b?.renderOrder ?? 0));
    this.renderer.setTransparentSort((a, b) => (a?.renderOrder ?? 0) - (b?.renderOrder ?? 0));

    await this.renderer.init();

    this.createPostProcessing(scene, camera);
    this.ready = true;
    return this;
  }

  private createPostProcessing(scene: THREE.Scene, camera: THREE.Camera): void {
    this.postProcessing = new THREE.RenderPipeline(this.renderer);

    this.scenePass = pass(scene, camera);
    this.scenePassColor = this.scenePass.getTextureNode('output');

    this.bloomPass = bloom(this.scenePassColor);
    this.bloomPass._nMips = this.quality.bloomMips();
    // Folio's exact relationship — do not raise bloom to hide bad materials.
    this.bloomPass.threshold.value = 1.0;
    this.bloomPass.strength.value = 0.25;
    this.bloomPass.smoothWidth.value = 1.0;

    this.cheapDOFPass = cheapDOF(renderOutput(this.scenePass));

    this.applyOutputChain();
    this.quality.events.on('change', () => {
      this.bloomPass._nMips = this.quality.bloomMips();
      this.applyOutputChain();
      // level also clamps the pixel ratio (§81/§88)
      this.viewport.setPixelRatioMax(this.quality.pixelRatioMax());
      this.resize();
    });
  }

  private applyOutputChain(): void {
    if (this.quality.dofEnabled()) {
      this.postProcessing.outputNode = this.cheapDOFPass.add(this.bloomPass);
    } else {
      this.postProcessing.outputNode = this.scenePassColor.add(this.bloomPass);
    }
    this.postProcessing.needsUpdate = true;
  }

  render(delta: number, stats: StatsOverlay | null = null): void {
    if (!this.ready) return;
    this.postProcessing.render();
    if (stats) stats.update(delta, this.renderer as any);
  }

  resize(): void {
    if (!this.renderer) return;
    this.renderer.setSize(this.viewport.width, this.viewport.height);
    this.renderer.setPixelRatio(this.viewport.pixelRatio);
  }

  setWireframeAll(scene: THREE.Scene, enabled: boolean): void {
    scene.traverse((object: any) => {
      const material = object.material;
      if (!material) return;
      if (Array.isArray(material)) for (const entry of material) entry.wireframe = enabled;
      else material.wireframe = enabled;
    });
  }
}
