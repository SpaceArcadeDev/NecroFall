// NECROFALL — the renderer (plan §2, §5, §6, §36, §83, §90): Folio's Rendering.js ported to
// TypeScript and targeted at the game's loop.
//
// ONE renderer, ONE output chain:
//
//   WebGPURenderer (WebGL2 backend fallback)
//         │
//   RenderPipeline
//         ├── scene pass (the world)
//         ├── bloom        (folio: threshold 1 · strength 0.25 · smoothWidth 1)
//         └── cheapDOF     (level 0 only — the cinematic edge blur)
//
// There is no `renderer.render(scene, camera)` path in the game any more: everything goes through
// the pipeline, including gameplay VFX, so bloom sees one coherent HDR-ish image.
//
// The game's thermal systems keep ownership of pacing and the adaptive DPR ladder; they write
// INTO this module (`setRenderScale`), never around it.
import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { cheapDOF } from './Passes/cheapDOF';
import { Quality } from './Quality';
import { Viewport } from './Viewport';
import { detectRendererCapabilities, resolveActiveBackend } from './RendererCapabilities';

export interface RenderingOptions {
  scene: THREE.Scene;
  viewport: Viewport;
  quality: Quality;
  /** Optional pre-made canvas; when omitted the renderer creates its own. */
  canvas?: HTMLCanvasElement;
}

type SortFn = (a: { renderOrder: number | null }, b: { renderOrder: number | null }) => number;

export class Rendering {
  readonly renderer: THREE.WebGPURenderer;
  /** Which backend actually came up (filled in when `init()` resolves). */
  backend: 'webgpu' | 'webgl';
  /** The one final output chain (plan §36). Null until `init()` completes. */
  postProcessing: THREE.RenderPipeline | null = null;

  private camera: THREE.Camera | null = null;
  private scenePass: any = null;
  private bloomPass: any = null;
  private cheapDOFPass: any = null;
  private ready = false;

  /** Last render scale the game ladder requested (0 = follow the viewport's own recommendation). */
  private renderScale = 0;

  // `?renderstats` overlay (plan §90) — zero cost when off.
  private statsElement: HTMLElement | null = null;
  private statsFrames = 0;
  private statsTimer = 0;
  private statsFps = 0;

  constructor(private readonly options: RenderingOptions) {
    const capabilities = detectRendererCapabilities();

    this.renderer = new THREE.WebGPURenderer({
      canvas: options.canvas,
      powerPreference: 'high-performance',
      forceWebGL: capabilities.forceWebGL,
      antialias: options.viewport.pixelRatio < 2,
    });
    this.backend = capabilities.forceWebGL ? 'webgl' : 'webgpu';

    // The game's art direction was authored with no tone mapping; the TSL materials match the
    // folio look 1:1, so keep the pipeline neutral.
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Folio's renderer contract: draw order is fully controlled by `renderOrder`, never sorted
    // by three (sorting giant instanced draws is pure CPU cost with no visual gain).
    this.renderer.sortObjects = false;
    const byRenderOrder: SortFn = (a, b) => (a.renderOrder ?? 0) - (b.renderOrder ?? 0);
    this.renderer.setOpaqueSort(byRenderOrder);
    this.renderer.setTransparentSort(byRenderOrder);

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.applySize();
    this.setupStats();
  }

  /** The environment layer is constructed before the camera exists — attach it before `init()`. */
  attachCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  async init(): Promise<this> {
    await this.renderer.init();

    // Correct the claim if the WebGPU attempt fell back internally.
    this.backend = resolveActiveBackend(this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } });
    console.info(`[NECROFALL] renderer: ${this.backend === 'webgpu' ? 'WebGPU' : 'WebGL2 (fallback)'}`);

    this.createPostProcessing();
    this.ready = true;
    return this;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private createPostProcessing(): void {
    const camera = this.camera;
    if (!camera) throw new Error('[NECROFALL] Rendering.init() ran before attachCamera()');

    const scene = this.options.scene;

    this.postProcessing = new THREE.RenderPipeline(this.renderer);

    this.scenePass = pass(scene, camera);
    const sceneColor = this.scenePass.getTextureNode('output');

    this.bloomPass = bloom(sceneColor);
    /*
     * Folio's visual relationship — do NOT start raising these to hide bad materials:
     *
     *   threshold    ≈ 1     (only genuinely bright pixels bloom)
     *   strength     ≈ 0.25  (a restrained glow)
     *   smoothWidth  = 1
     *
     * Radioactive crystals/spikes read as "hot" because their emissive nodes push pixels over
     * the threshold, not because the bloom is cranked.
     */
    this.bloomPass.threshold.value = 1;
    this.bloomPass.strength.value = 0.25;
    this.bloomPass.smoothWidth.value = 1;
    // Mip count is a construction-time choice in three's BloomNode (its setup() reads `_nMips`
    // on first use): pick it once from the quality level, before the first frame.
    this.bloomPass._nMips = this.options.quality.bloomMipCount();

    this.cheapDOFPass = cheapDOF(renderOutput(this.scenePass));

    const applyQuality = (level: number): void => {
      if (!this.postProcessing) return;
      if (level === 0) {
        // High: cheapDOF on the scene, bloom added on top (folio's exact chain).
        this.postProcessing.outputNode = this.cheapDOFPass.add(this.bloomPass);
      } else {
        // Lower: DOF removed — fewer full-screen taps — bloom still present.
        this.postProcessing.outputNode = sceneColor.add(this.bloomPass);
      }
      this.postProcessing.needsUpdate = true;
    };
    this.options.quality.onChange(applyQuality);
    applyQuality(this.options.quality.level);
  }

  /** The one render call. Used by the game loop at stage 998. */
  render(): void {
    if (!this.ready || !this.postProcessing) return;
    this.postProcessing.render();
    this.updateStats();
  }

  /**
   * The adaptive DPR ladder's write path. `pixelRatio` is the final value the lidar chose —
   * `currentDpr()` in the game — this module never second-guesses it.
   */
  setRenderScale(pixelRatio: number): void {
    this.renderScale = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.applySize();
  }

  /** Window resized: re-apply the size (and the last render scale, if the ladder set one). */
  resize(): void {
    this.applySize();
    this.renderer.setPixelRatio(this.renderScale || this.options.viewport.pixelRatio);
  }

  private applySize(): void {
    const viewport = this.options.viewport;
    this.renderer.setSize(viewport.width, viewport.height);
  }

  // ------------------------------------------------------------------ `?renderstats`

  private setupStats(): void {
    if (typeof location === 'undefined' || !location.search.match(/renderstats/i)) return;
    if (typeof document === 'undefined') return;

    this.statsElement = document.createElement('div');
    this.statsElement.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:99999;font:11px/1.45 ui-monospace,monospace;' +
      'color:#9f9;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:4px;' +
      'pointer-events:none;white-space:pre';
    document.body.appendChild(this.statsElement);
    this.statsTimer = performance.now();
  }

  private updateStats(): void {
    if (!this.statsElement) return;

    this.statsFrames++;
    const now = performance.now();
    const elapsed = now - this.statsTimer;
    if (elapsed < 500) return;

    this.statsFps = Math.round((this.statsFrames * 1000) / elapsed);
    this.statsFrames = 0;
    this.statsTimer = now;

    const info = this.renderer.info as unknown as {
      render: { drawCalls: number; triangles: number; points: number; lines: number };
      memory: { geometries: number; textures: number };
    };
    this.statsElement.textContent =
      `fps         ${this.statsFps}\n` +
      `draw calls  ${info.render.drawCalls}\n` +
      `triangles   ${info.render.triangles.toLocaleString()}\n` +
      `points      ${info.render.points.toLocaleString()}\n` +
      `geometries  ${info.memory.geometries.toLocaleString()}\n` +
      `textures    ${info.memory.textures.toLocaleString()}\n` +
      `pixel ratio ${this.renderer.getPixelRatio().toFixed(2)}\n` +
      `backend     ${this.backend}`;
  }
}
