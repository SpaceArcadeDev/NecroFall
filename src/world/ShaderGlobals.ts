// NECROFALL — shared shader uniforms + GLSL lighting/fog chunks.
// Every custom shader in the game (terrain, sky, creature carapace, tower shields)
// shares these uniform objects by reference, so one write per frame updates them all.
import * as THREE from 'three';

export const SHADER_GLOBALS = {
  uTime: { value: 0 },
  uCamPos: { value: new THREE.Vector3() },
  uSunDir: { value: new THREE.Vector3(1, 0.85, 0.6).normalize() },
  // Stylised, sun-led lighting (2026-09-30 art pass): warm strong sun, clear sky fill and a
  // brighter ground bounce so albedo reads at full saturation. Planets override these per-biome
  // through `EnvironmentLighting`; these defaults cover menus and pre-world frames.
  uSunColor: { value: new THREE.Color(0xfff1d6).multiplyScalar(1.35) },
  uSkyColor: { value: new THREE.Color(0x9fc0f0).multiplyScalar(0.95) },
  uGroundColor: { value: new THREE.Color(0x6a5a78).multiplyScalar(0.85) },
  uRimColor: { value: new THREE.Color(0xc9b6ff) },
  uFogColor: { value: new THREE.Color(0x6a7a96) },
  uFogDensity: { value: 0.0009 },
};

/** Per-frame updates for every shader-driven material. */
export function updateShaderGlobals(dt: number, cameraPos: THREE.Vector3): void {
  SHADER_GLOBALS.uTime.value += dt;
  SHADER_GLOBALS.uCamPos.value.copy(cameraPos);
}

/** GLSL: uniform declarations every custom material needs. */
export const NF_UNIFORMS_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uRimColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
`;

/** GLSL: hemisphere + sun lighting with slope shading, a rim term and a gentle vibrance pass. */
export const NF_LIGHTING_GLSL = /* glsl */ `
  vec3 nfLight(vec3 albedo, vec3 n, vec3 radialUp, vec3 wp, float rimStrength) {
    float ndl = max(dot(n, normalize(uSunDir)), 0.0);
    float hemi = clamp(dot(n, radialUp) * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = mix(uGroundColor, uSkyColor, hemi);
    vec3 lit = albedo * (ambient + uSunColor * ndl);
    float slope = 1.0 - clamp(dot(radialUp, n), 0.0, 1.0);
    lit *= mix(1.0, 0.86, slope);
    vec3 viewDir = normalize(uCamPos - wp);
    float rim = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    lit += uRimColor * rim * rimStrength;
    // Vibrance: push saturation a touch so stylised colours stay vivid under the atmosphere
    // instead of washing toward the fog/sky tints (reference: Folio's saturated readability).
    float lum = dot(lit, vec3(0.299, 0.587, 0.114));
    lit += (lit - vec3(lum)) * 0.18;
    return lit;
  }
`;

/** GLSL: exponential-squared distance fog. */
export const NF_FOG_GLSL = /* glsl */ `
  float nfFog(vec3 wp) {
    float d = length(uCamPos - wp);
    return clamp(1.0 - exp(-pow(d * uFogDensity, 2.0)), 0.0, 1.0);
  }
`;

/** Uniform block used when constructing custom materials. */
export function nfUniforms(extra: Record<string, THREE.IUniform> = {}): Record<string, THREE.IUniform> {
  return { ...SHADER_GLOBALS, ...extra };
}
