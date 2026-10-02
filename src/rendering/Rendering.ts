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
  /** The (width, height, pixel ratio) triple last written to the renderer. */
  private readonly lastSize = { w: -1, h: -1, pr: -1 };

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
    this.applySize(this.viewport.pixelRatio);
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
    this.applySize(scale);
  }

  /**
   * Every reconfigure reallocates the WebGPU swap chain, and on Android each reallocation can
   * flash the frame black. The mobile URL bar animates its collapse/expand with a burst of resize
   * events — one per animation frame — so an identical (size, ratio) pair is a hard no-op: a burst
   * that ends where it started reconfigures nothing at all.
   */
  private applySize(pixelRatio: number): void {
    const { width: w, height: h } = this.viewport;
    // Sub-pixel deadband: Android reports 1-2 px clientHeight jitter (gesture bar, rounded
    // corners, URL-bar settling) and a devicePixelRatio that can wobble in its last decimals —
    // every one of those used to reconfigure the swap chain and flash the frame black. Changes
    // this small are invisible, so they never reach the renderer.
    const sameSize = Math.abs(w - this.lastSize.w) <= 2 && Math.abs(h - this.lastSize.h) <= 2;
    const sameRatio = Math.abs(pixelRatio - this.lastSize.pr) < 0.02;
    if (sameSize && sameRatio) {
      return;
    }
    this.lastSize.w = w;
    this.lastSize.h = h;
    this.lastSize.pr = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h);
  }

  get drawCalls(): number {
    return (this.renderer?.info as any)?.render?.drawCalls ?? 0;
  }

  async init(scene: THREE.Scene, camera: THREE.Camera): Promise<this> {
    await this.renderer.init();
    // EXPLICIT backend diagnostics (mobile plan §51): a device that can run WebGPU must never
    // silently ride the WebGL compatibility path. One line at boot makes the choice visible.
    const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
    console.info('[render]', {
      renderer: this.renderer.constructor.name,
      backend: this.backend,
      webgpuAvailable,
      forcedWebGL: this.options.forceWebGL ?? false,
      chosen: this.backend === 'webgpu' ? 'WebGPU + TSL' : 'WebGL compatibility',
    });
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
    // VIBRANT hot-core bloom: the emissive materials push their brilliant areas to 2-3, so the
    // halo keys hard on them (real glare) while ordinary lit geometry (≤1) stays out of it —
    // a strong, saturated glow instead of a broad soft wash over the whole frame.
    this.bloomPass.threshold.value = 0.9;
    this.bloomPass.strength.value = 0.85;
    this.bloomPass.smoothWidth.value = 0.5;

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
    this.applySize(this.viewport.pixelRatio);
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
