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
import { RenderDebug } from './RenderDebug';

export interface RenderingOptions {
  /** Force WebGL2 backend even when navigator.gpu exists. */
  forceWebGL?: boolean;
}

export class Rendering {
  renderer: THREE.WebGPURenderer;
  postProcessing!: THREE.RenderPipeline;
  ready = false;

  private scenePass!: any;
  private scenePassColor!: any;
  private bloomPass!: any;
  private cheapDOFPass: any = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewport: Viewport,
    private readonly quality: Quality,
    private readonly options: RenderingOptions = {},
  ) {
    // The renderer is created SYNCHRONOUSLY (device init still awaits in `init()`): the game
    // wiring needs its canvas/capabilities immediately (input listeners, resource loader).
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
  }

  /** 'webgpu' | 'webgl' — which backend actually came up (telemetry / debug overlay). */
  get backend(): 'webgpu' | 'webgl' {
    return (this.renderer as any)?.backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl';
  }

  /** The ONE place the render resolution is written (game DPR ladder + viewport changes). */
  setRenderScale(scale: number): void {
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(this.viewport.width, this.viewport.height);
  }

  get drawCalls(): number {
    return (this.renderer?.info as any)?.render?.drawCalls ?? 0;
  }

  async init(scene: THREE.Scene, camera: THREE.Camera): Promise<this> {
    await this.renderer.init();
    this.scene = scene;
    this.camera = camera;
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
    // HOT-CORE bloom (second playtest pass): a HIGHER threshold with a HIGHER strength — the glow
    // hugs the saturated HDR cores (shields/rays/FX push past 1) instead of lifting the whole
    // frame, which is what made the light effects read washed out with the previous soft setup.
    this.bloomPass.threshold.value = 0.9;
    this.bloomPass.strength.value = 0.7;
    this.bloomPass.smoothWidth.value = 0.65;

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
    // `?post=0` (plan §25): raw scene pass — no bloom, no DOF — so a broken post chain can never
    // be mistaken for a broken world.
    if (!RenderDebug.postEnabled && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.postProcessing.render();
    }
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
