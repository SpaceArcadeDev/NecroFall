// NECROFALL — shared shader VALUES (migration phase 6: the GLSL chunks are gone).
//
// The uniform OBJECTS below are the game's single value store: `Planet.update()` writes the
// per-frame time/camera/sun state here, and `NecroChunks.syncNecroChunks()` mirrors it into the
// TSL `NECRO_UNIFORMS` every ported gameplay material reads. No GLSL code lives in this file
// anymore — every material in the game is a TSL node material (WebGPU).
import * as THREE from 'three';

export const SHADER_GLOBALS = {
  uTime: { value: 0 },
  uCamPos: { value: new THREE.Vector3() },
  uSunDir: { value: new THREE.Vector3(1, 0.85, 0.6).normalize() },
  uSunColor: { value: new THREE.Color(0xfff0d8).multiplyScalar(0.95) },
  uSkyColor: { value: new THREE.Color(0x9f8ce0).multiplyScalar(0.72) },
  uGroundColor: { value: new THREE.Color(0x2a1d3d).multiplyScalar(0.8) },
  uRimColor: { value: new THREE.Color(0xb9a6ff) },
  uFogColor: { value: new THREE.Color(0x171029) },
  uFogDensity: { value: 0.00125 },
};

/** Per-frame updates for every shader-driven material. */
export function updateShaderGlobals(dt: number, cameraPos: THREE.Vector3): void {
  SHADER_GLOBALS.uTime.value += dt;
  SHADER_GLOBALS.uCamPos.value.copy(cameraPos);
}
