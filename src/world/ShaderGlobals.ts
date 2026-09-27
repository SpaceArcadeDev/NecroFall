// NECROFALL — shared shader uniforms + GLSL lighting/fog chunks.
// Every custom shader in the game (terrain, sky, creature carapace, tower shields)
// shares these uniform objects by reference, so one write per frame updates them all.
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

/** GLSL: hemisphere + sun lighting with slope shading and a rim term. */
export const NF_LIGHTING_GLSL = /* glsl */ `
  vec3 nfLight(vec3 albedo, vec3 n, vec3 radialUp, vec3 wp, float rimStrength) {
    float ndl = max(dot(n, normalize(uSunDir)), 0.0);
    float hemi = clamp(dot(n, radialUp) * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = mix(uGroundColor, uSkyColor, hemi);
    vec3 lit = albedo * (ambient + uSunColor * ndl);
    float slope = 1.0 - clamp(dot(radialUp, n), 0.0, 1.0);
    lit *= mix(1.0, 0.78, slope);
    vec3 viewDir = normalize(uCamPos - wp);
    float rim = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    lit += uRimColor * rim * rimStrength;
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
