// NECROFALL — pre-renderer (plan §85): Folio's PreRenderer.js ported to TypeScript.
//
// A ONE-SHOT capture pass: temporarily make every hidden object visible, render the scene into a
// cube render target once, then restore visibility. Folio uses it for environment reflections;
// NecroFall keeps the same contract so water/reflection work can hook it later without inventing
// another mechanism. Never call this per frame.
import * as THREE from 'three/webgpu';

export class PreRenderer {
  /**
   * Render one cube capture of `scene` at `size` resolution. Objects mark themselves
   * `userData.preventPreRender = true` to stay hidden during the capture.
   */
  static render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, size = 32): void {
    const renderTarget = new THREE.CubeRenderTarget(size);
    const cubeCamera = new THREE.CubeCamera(1, 100000, renderTarget);
    scene.add(cubeCamera);

    const restored: Array<{ object: THREE.Object3D; visible: boolean }> = [];
    scene.traverse((child) => {
      if (child.visible === false && child.userData.preventPreRender === undefined) {
        child.visible = true;
        restored.push({ object: child, visible: false });
      }
    });

    cubeCamera.update(renderer, scene);

    for (const entry of restored) entry.object.visible = entry.visible;
    scene.remove(cubeCamera);
    renderTarget.dispose();
  }
}
