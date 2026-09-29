// NECROFALL — stylized vegetation: wind-blown instanced grass, flowers and plants.
//
// Technique notes: this is an original implementation of the layered "stylized field" approach
// popularised by Christian Ortiz's MIT-licensed `cortiz2894/stylized-components` (GrassField):
//
//   * one shared procedural "ground dirt" mask, evaluated by the terrain, the blades and the
//     flowers, so the grass thins into bare earth instead of ending at a hard line;
//   * a single global wind (direction + strength + gusting) shared by grass, flowers, plants
//     and the water surface, so the whole world breathes together;
//   * blades that keep their root pinned, bend more towards the tip, take a root→tip colour
//     gradient and pick up a subsurface glow when the camera looks into the sun;
//   * per-instance trampling: blades that grew next to a rock are pressed flatter.
//
// Everything is instanced and driven from custom GLSL — no textures, no baked assets.
import * as THREE from 'three';
import { nfUniforms, NF_UNIFORMS_GLSL, NF_LIGHTING_GLSL, NF_FOG_GLSL } from './ShaderGlobals';

/** Shared wind state. Every shader that should sway reads the same uniform objects. */
export interface WindUniforms {
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
  uWindGust: { value: number };
}

export function createWindUniforms(): WindUniforms {
  return {
    uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
    uWindStrength: { value: 1 },
    uWindGust: { value: 0 },
  };
}

/** Shared GLSL: the wind offset applied to a point at height `h` (0 root .. 1 tip). */
const WIND_GLSL = /* glsl */ `
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uWindGust;

  // Two crossing waves plus a slowly travelling gust front: cheap, and reads as real wind because
  // neighbouring blades share the phase (it is driven by world position, not per-instance random).
  vec3 windOffset(vec3 world, float h, float phase) {
    float travel = world.x * uWindDir.x + world.z * uWindDir.y;
    float w1 = sin(uTime * 1.35 - travel * 0.35 + phase);
    float w2 = sin(uTime * 2.9 - travel * 0.9 + phase * 1.7) * 0.42;
    float gust = 1.0 + uWindGust * 0.9 * sin(uTime * 0.31 - travel * 0.06);
    float bend = (w1 + w2) * gust * uWindStrength;
    // root stays planted, tip swings: the quadratic falloff is what makes grass look rooted.
    // The amplitude is deliberately small — a dense field with a big sway reads as flickering
    // noise, because neighbouring blades sweep through each other.
    float k = h * h * (0.6 + 0.4 * h);
    return vec3(uWindDir.x, 0.0, uWindDir.y) * bend * k * 0.32;
  }
`;

/** Shared GLSL: the ground dirt mask. Mirrored on the CPU for placement decisions. */
export const DIRT_GLSL = /* glsl */ `
  // Two octaves of value noise in world XZ — the single source of truth for "bare earth".
  float dirtHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float dirtNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = dirtHash(i);
    float b = dirtHash(i + vec2(1.0, 0.0));
    float c = dirtHash(i + vec2(0.0, 1.0));
    float d = dirtHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  /** 0 = lush grass, 1 = bare dirt. */
  float groundDirt(vec2 worldXZ) {
    float n = dirtNoise(worldXZ * 0.055) * 0.65 + dirtNoise(worldXZ * 0.19) * 0.35;
    return smoothstep(0.42, 0.72, n);
  }
`;

/** Matching CPU-side dirt test, so placement agrees with the shader. */
export function dirtAmount(x: number, z: number): number {
  const hash = (px: number, pz: number): number => {
    const s = Math.sin(px * 127.1 + pz * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };
  const noise = (px: number, pz: number): number => {
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    const fx = px - ix;
    const fz = pz - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
  };
  const n = noise(x * 0.055, z * 0.055) * 0.65 + noise(x * 0.19, z * 0.19) * 0.35;
  const t = Math.min(1, Math.max(0, (n - 0.42) / 0.3));
  return t * t * (3 - 2 * t);
}

/** True when this spot is open ground (no dirt) — used to decide where plants may grow. */
export function isLush(x: number, z: number): boolean {
  return dirtAmount(x, z) < 0.55;
}

// ---------------------------------------------------------------- geometry

/** A single grass blade: a tapered strip, curved forward, rooted at y = 0. */
export function bladeGeometry(segments = 5): THREE.BufferGeometry {
  const w = 0.13;
  const h = 0.85;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = w * (1 - t * 0.92);            // taper to a point
    const y = t * h;
    const z = t * t * h * 0.22;                   // baked forward curve
    positions.push(-width, y, z, width, y, z);
    uvs.push(t, 0, t, 1);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** A cross-billboard flower: two quads at 90°, the petal shape cut out in the shader. */
export function flowerGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(0.3, 0.42, 1, 1);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const merged = mergeSimple([a, b]);
  a.dispose();
  b.dispose();
  merged.translate(0, 0.21, 0);
  return merged;
}

/** A leafy plant: a fan of broad blades, used for ferns and undergrowth. */
export function plantGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const blade = bladeGeometry(4);
    blade.scale(2.2, 1.15, 1);
    blade.rotateZ((i / 5) * Math.PI * 2);
    blade.rotateX(-0.55 - (i % 2) * 0.25);
    parts.push(blade);
  }
  return mergeSimple(parts);
}

/** Real height of a geometry's own vertices — the sway shader normalises the blade against it. */
export function geometryHeight(g: THREE.BufferGeometry): number {
  g.computeBoundingBox();
  return g.boundingBox ? g.boundingBox.max.y : 1;
}

/** Minimal merge for our own single-attribute geometries (indexed, position + uv + normal). */
export function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const u = g.getAttribute('uv');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
      nrm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
    }
    const ind = g.getIndex();
    if (ind) for (let i = 0; i < ind.count; i++) idx.push(ind.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}

// ---------------------------------------------------------------- materials

function swayVert(extra = ''): string {
  return /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  ${WIND_GLSL}
  attribute float aTint;
  attribute float aHeight;
  attribute float aTrample;
  attribute float aPhase;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vH;
  varying vec2 vUv;
  ${extra}
  void main() {
    #ifdef USE_INSTANCING
      vec4 local = instanceMatrix * vec4(position, 1.0);
      mat3 nrmM = mat3(modelMatrix * instanceMatrix);
    #else
      vec4 local = vec4(position, 1.0);
      mat3 nrmM = mat3(modelMatrix);
    #endif
    vec4 wp = modelMatrix * local;
    float h = clamp(position.y / max(0.001, aHeight), 0.0, 1.0);
    // trampled blades (ones that grew beside a rock) are pressed down and splayed
    float stand = mix(1.0, 0.35, aTrample);
    wp.xyz += vec3(position.x, 0.0, position.z) * aTrample * 1.4;
    wp.xyz += windOffset(wp.xyz, h * stand, aPhase);
    vH = h;
    vUv = uv;
    vWorld = wp.xyz;
    vNormalW = normalize(nrmM * normal);
    vec3 col = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      col *= instanceColor;
    #endif
    vColor = col * aTint;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
}

// Superseded by swayFrag() above (which bakes the palette in). Kept only as a reference copy of
// the uniform-driven version; nothing uses it.
const LEGACY_SWAY_FRAG = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform vec3 uRoot;
  uniform vec3 uTip;
  uniform float uIsFlower;
  uniform float uDirtTint;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vH;
  varying vec2 vUv;
  ${DIRT_GLSL}
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}

  void main() {
    // flowers: cut a petal/heart shape out of the quad from UVs alone — no texture needed
    if (uIsFlower > 0.5) {
      vec2 p = vUv * 2.0 - 1.0;
      float petal = 1.0 - length(p * vec2(1.0, 1.35));
      if (petal < 0.02) discard;
      float heart = smoothstep(0.0, 0.22, petal);
      if (heart < 0.5) discard;
    }

    vec2 xz = vec2(vWorld.x, vWorld.z);
    float dirt = groundDirt(xz);
    // thin the blades out over bare earth and tint them towards the soil colour
    if (dirt > 0.62 && vH < 0.35) discard;

    vec3 n = normalize(vNormalW);
    vec3 up = normalize(vWorld);
    // Double-sided ribbons: flip the normal on back faces (custom shaders get no automatic flip).
    if (!gl_FrontFacing) n = -n;
    // Bias the normal towards the ground normal so blades pick up the light of the terrain they
    // grow on instead of going black whenever the thin ribbon faces away from the sun.
    n = normalize(mix(n, up, 0.55));
    vec3 albedo = mix(uRoot, uTip, pow(vH, 0.45)) * vColor;
    albedo = mix(albedo, uTip * uDirtTint, dirt * 0.45);
    vec3 lit = nfLight(albedo, n, up, vWorld, 0.3);
    // subsurface back-light: thin vegetation glows when the sun is behind it
    float toward = max(dot(normalize(-uSunDir), normalize(uCamPos - vWorld)), 0.0);
    lit += uSunColor * pow(toward, 2.2) * vH * 0.5;
    lit += uSkyColor * vH * 0.25;
    // Foliage never goes fully black: a small self-lit floor keeps grass readable on the night
    // side of the planet, where the sun contributes nothing to a thin ribbon's normal.
    lit += albedo * 0.5;
    lit = mix(lit, uFogColor, nfFog(vWorld));
    gl_FragColor = vec4(lit, 1.0);
  }
`;

// The palette is baked straight into the shader source. Per-material colour uniforms on these
// meshes were not reaching the GPU (shared ones upload fine), and constants are cheaper anyway —
// each material is compiled once at planet build time.
const constVec3 = (hex: number): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

function swayFrag(rootHex: number, tipHex: number, isFlower: boolean, floor = 0.5, huePreserve = false): string {
  // Dense grass covers the screen, so it may not be tinted by the planet's blue-violet ambient —
  // that turns a field of green blades visually blue. The hue-preserving variant scales the blade's
  // OWN colour by the light's luminance (plus a little scene tint) and keeps green green.
  const lighting = huePreserve
    ? /* glsl */ `
    float ndl = max(dot(n, normalize(uSunDir)), 0.0);
    float hemi = clamp(dot(n, up) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(uGroundColor, uSkyColor, hemi);
    vec3 light = amb + uSunColor * ndl;
    float lum = dot(light, vec3(0.299, 0.587, 0.114));
    // keep a real sun highlight so blades still pop out of the ground they grow on
    vec3 lit = albedo * (lum * 1.05 + 0.12) + light * 0.06;
    lit += uSunColor * pow(toward, 2.2) * vH * 0.35;`
    : /* glsl */ `
    vec3 lit = nfLight(albedo, n, up, vWorld, 0.3);
    lit += uSunColor * pow(toward, 2.2) * vH * 0.5;
    lit += uSkyColor * vH * 0.25;
    lit += albedo * FLOOR;`;
  return /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform float uIsFlower;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vH;
  varying vec2 vUv;
  ${DIRT_GLSL}
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}

  const vec3 ROOT = ${constVec3(rootHex)};
  const vec3 TIP = ${constVec3(tipHex)};
  const vec3 DIRT_TINT = ${constVec3(0x6b6350)};
  const float FLOWER = ${isFlower ? '1.0' : '0.0'};
  // Self-lit floor: how much of the blade's own colour it keeps regardless of the sun. Dense
  // fields want a low value (roots stay dark, tips catch the light) so they sit in the same
  // palette as the terrain and the sparse scatter.
  const float FLOOR = ${floor.toFixed(3)};

  void main() {
    // flowers: cut a petal/heart shape out of the quad from UVs alone — no texture needed
    if (FLOWER > 0.5) {
      vec2 p = vUv * 2.0 - 1.0;
      float petal = 1.0 - length(p * vec2(1.0, 1.35));
      if (petal < 0.02) discard;
      float heart = smoothstep(0.0, 0.22, petal);
      if (heart < 0.5) discard;
    }

    vec2 xz = vec2(vWorld.x, vWorld.z);
    float dirt = groundDirt(xz);
    // thin the blades out over bare earth and tint them towards the soil colour
    if (dirt > 0.62 && vH < 0.35) discard;

    vec3 n = normalize(vNormalW);
    vec3 up = normalize(vWorld);
    // Double-sided ribbons: flip the normal on back faces (custom shaders get no automatic flip).
    if (!gl_FrontFacing) n = -n;
    // Bias the normal towards the ground normal so blades pick up the light of the terrain they
    // grow on instead of going black whenever the thin ribbon faces away from the sun.
    n = normalize(mix(n, up, 0.55));
    vec3 albedo = mix(ROOT, TIP, pow(vH, 0.45)) * vColor;
    albedo = mix(albedo, TIP * DIRT_TINT, dirt * 0.45);
    // subsurface back-light: thin vegetation glows when the sun is behind it
    float toward = max(dot(normalize(-uSunDir), normalize(uCamPos - vWorld)), 0.0);
    ${lighting}
    lit = mix(lit, uFogColor, nfFog(vWorld));
    gl_FragColor = vec4(lit, 1.0);
  }
`;
}

/** Shared wind uniforms; the palette lives in the shader source (see swayFrag). */
const swayShared = (wind: WindUniforms): Record<string, THREE.IUniform> => ({
  ...nfUniforms({ uIsFlower: { value: 0 } }),
  uWindDir: wind.uWindDir,
  uWindStrength: wind.uWindStrength,
  uWindGust: wind.uWindGust,
});

export function createBladeMaterial(wind: WindUniforms, root: number, tip: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: swayVert(),
    fragmentShader: swayFrag(root, tip, false),
    side: THREE.DoubleSide,
    uniforms: swayShared(wind),
  });
}

export function createFlowerMaterial(wind: WindUniforms, tip: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: swayVert(),
    fragmentShader: swayFrag(0x2f4a2c, tip, true),
    side: THREE.DoubleSide,
    uniforms: swayShared(wind),
  });
  (mat.uniforms.uIsFlower.value as number) = 1;
  return mat;
}

export function createPlantMaterial(wind: WindUniforms, root: number, tip: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: swayVert(),
    fragmentShader: swayFrag(root, tip, false),
    side: THREE.DoubleSide,
    uniforms: swayShared(wind),
  });
}

/**
 * The dense, hand-placed grass field. It is deliberately its own material: the field is walked
 * through at close range, so it uses the game's necrotic green palette (dark roots, muted mid-green
 * tips, the same family as the terrain's `uGrassColor`) with a much lower self-lit floor. Pale,
 * high-floor grass that looks fine as a sparse distant scatter reads as flat mint when it fills the
 * screen, which is exactly the mismatch this avoids.
 */
export function createFieldGrassMaterial(wind: WindUniforms, root: number, tip: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: swayVert(),
    fragmentShader: swayFrag(root, tip, false, 0, true),
    side: THREE.DoubleSide,
    uniforms: swayShared(wind),
  });
}

/** Per-instance attribute bundles, filled during the scatter pass then uploaded once. */
export interface SwayScatter {
  tint: Float32Array;
  height: Float32Array;
  trample: Float32Array;
  phase: Float32Array;
}

const _m4v = new THREE.Matrix4();
const _qv = new THREE.Quaternion();
const _ev = new THREE.Euler();
const _pv = new THREE.Vector3();
const _sv = new THREE.Vector3();

export function createSwayScatter(count: number): SwayScatter {
  return {
    tint: new Float32Array(count),
    height: new Float32Array(count),
    trample: new Float32Array(count),
    phase: new Float32Array(count),
  };
}

/**
 * Places one instance and records the per-instance sway data.
 * `geomHeight` is the geometry's own height, so the shader can normalise 0 (root) .. 1 (tip).
 */
export function setSwayInstance(
  mesh: THREE.InstancedMesh,
  scatter: SwayScatter,
  i: number,
  opts: { x: number; y: number; z: number; scale: number; rotY: number; tint: number; geomHeight: number; trample: number; phase: number }
): void {
  _ev.set(0, opts.rotY, 0);
  _qv.setFromEuler(_ev);
  _pv.set(opts.x, opts.y, opts.z);
  _sv.set(opts.scale, opts.scale, opts.scale);
  _m4v.compose(_pv, _qv, _sv);
  mesh.setMatrixAt(i, _m4v);
  scatter.tint[i] = opts.tint;
  scatter.height[i] = opts.geomHeight * opts.scale;
  scatter.trample[i] = opts.trample;
  scatter.phase[i] = opts.phase;
}

export function applySwayAttributes(mesh: THREE.InstancedMesh, scatter: SwayScatter, count: number): void {
  const slice = (a: Float32Array): Float32Array => a.slice(0, count);
  mesh.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(slice(scatter.tint), 1));
  mesh.geometry.setAttribute('aHeight', new THREE.InstancedBufferAttribute(slice(scatter.height), 1));
  mesh.geometry.setAttribute('aTrample', new THREE.InstancedBufferAttribute(slice(scatter.trample), 1));
  mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(slice(scatter.phase), 1));
}

/** Every blade-style geometry's own height, for the sway normalisation above. */
export const BLADE_HEIGHT = 0.85;
export const FLOWER_HEIGHT = 0.42;
export const PLANT_HEIGHT = 0.9;
