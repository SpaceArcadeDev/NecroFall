import { LinearSRGBColorSpace, NoToneMapping, RenderPipeline, SRGBColorSpace, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { context, convertToTexture, mix, pass, renderOutput, screenUV, smoothstep, uniform, vec2 } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export function baseFocus(renderer: WebGPURenderer, scene: Scene, camera: Camera, mobile: boolean) {
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.contextNode = context({ toneMapping: renderer.toneMapping, outputColorSpace: LinearSRGBColorSpace });
  const display = convertToTexture(renderOutput(scenePass.getTextureNode(), NoToneMapping, SRGBColorSpace));
  const antialias = convertToTexture(fxaa(display));
  const blurred = gaussianBlur(antialias, vec2(mobile ? 1 : 1.4), 2, { resolutionScale: 0.5 });
  const enabled = uniform(0);
  const falloff = smoothstep(0.16, 0.62, screenUV.sub(0.5).length()).mul(enabled).mul(0.65);
  const pipeline = new RenderPipeline(renderer, mix(antialias, blurred, falloff));
  pipeline.outputColorTransform = false;
  return {
    setEnabled(value: boolean) { enabled.value = value ? 1 : 0; },
    render() { pipeline.render(); },
    dispose() {
      pipeline.dispose(); blurred.dispose(); scenePass.dispose();
      (display as any).passNode?.dispose(); (antialias as any).passNode?.dispose();
    },
  };
}