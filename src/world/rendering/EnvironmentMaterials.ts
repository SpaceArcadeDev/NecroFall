// NECROFALL — ENVIRONMENT MATERIALS (rework plan §7-§11/§18/§25/§30/§42/§54).
//
// ONE parametrized shader family powers every instanced environment surface: grass blades,
// tree canopies/trunks, rocks, crystals, debris and props. Features are assembled per material:
//
//   * instancing with per-instance tint / phase / state / fade / LOD bias attributes;
//   * WIND: blades bend from the root, canopies sway at the crown (plan §9/§10);
//   * PLAYER INTERACTION: grass bends away from nearby players, driven by uniforms only — no CPU
//     per-blade simulation (plan §25);
//   * GRASS TIERS: per-instance distance thinning with a random offset so density falls off
//     softly instead of in rings (plan §8);
//   * LOD BANDS: the same instance streams from the detail mesh to the cheap mesh at a distance
//     (plan §6/§17) — the two meshes carry complementary band uniforms;
//   * DITHER FADE: camera-occluding foliage dissolves with a stable screen-space dither rather
//     than expensive blended transparency (plan §27/§54).
//
// The shared wind uniforms are the SAME objects the rest of the game reads (`Vegetation.ts`), so
// grass, flowers, water and this whole system breathe as one (plan §9).
import * as THREE from 'three';
import { nfUniforms, NF_UNIFORMS_GLSL, NF_LIGHTING_GLSL, NF_FOG_GLSL } from '../ShaderGlobals';
import type { WindUniforms } from '../Vegetation';

/**
 * Player-interaction uniforms (plan §25): up to 4 nearby players bend the grass.
 * Four EXPLICIT vec4 slots (xyz = position, w = radius) instead of an array — array indexing in
 * the vertex shader compiles to a dynamic index that some mobile drivers warn about.
 */
export interface InteractUniforms {
  uInt0: { value: THREE.Vector4 };
  uInt1: { value: THREE.Vector4 };
  uInt2: { value: THREE.Vector4 };
  uInt3: { value: THREE.Vector4 };
  uIntPush: { value: THREE.Vector4 };
}

export function createInteractUniforms(): InteractUniforms {
  return {
    uInt0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uInt1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uInt2: { value: new THREE.Vector4(0, 0, 0, 0) },
    uInt3: { value: new THREE.Vector4(0, 0, 0, 0) },
    uIntPush: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

export interface EnvMaterialOpts {
  /** Wind mode: none, blade (root-pinned bend), canopy (crown sway). */
  wind?: 'none' | 'blade' | 'canopy';
  /** Read the player-interaction uniforms and bend (plan §25). */
  interact?: boolean;
  /** Occlusion dither fade via the per-instance aFade attribute (plan §54). */
  dither?: boolean;
  /** Emissive strength (crystals, contaminated growth). */
  emissive?: number;
  /** Fresnel rim strength. */
  fresnel?: number;
  /** Low-poly facet reconstruction from screen-space derivatives. */
  facet?: number;
  /** Per-instance colour noise on the albedo. */
  noise?: number;
  /** Constant alpha (< 1 needs transparent: true). */
  alpha?: number;
  transparent?: boolean;
  doubleSide?: boolean;
  /** Grass hue-preserving lighting (a field of green must not turn blue under the nebula). */
  huePreserve?: boolean;
  /** Discard entire instances beyond the tier distances (grass tiers, plan §8). */
  tiers?: boolean;
  /** Keep instances below `uLodSwitch` (detail mesh) — or above it (`lodHigh` for the LOD1 mesh). */
  lodBand?: 'keep-near' | 'keep-far' | 'none';
  /** Soft band (metres) around the LOD switch where the instance scales down instead of popping. */
  lodSoft?: number;
}

/** Attribute + uniform GLSL shared by every environment vertex shader. */
const ENV_VERT_COMMON = /* glsl */ `
  attribute float aTint;
  attribute float aPhase;
  attribute float aHeight;
  attribute float aState;   // 1 = active, 0 = collapsed (cell unloaded / destroyed)
  attribute float aFade;    // 0..1 dither visibility (occlusion)
  attribute float aRand;    // stable per-instance random for tiers / LOD stagger
  attribute float aLod;     // LOD distance bias (0.85..1.15)

  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vH;         // 0 root .. 1 tip
  varying float vFade;
  varying float vGrain;
`;

const ENV_WIND_GLSL = /* glsl */ `
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uWindGust;

  vec3 envWindOffset(vec3 world, float h, float phase) {
    float travel = world.x * uWindDir.x + world.z * uWindDir.y;
    float w1 = sin(uTime * 1.35 - travel * 0.35 + phase);
    float w2 = sin(uTime * 2.9 - travel * 0.9 + phase * 1.7) * 0.42;
    float gust = 1.0 + uWindGust * 0.9 * sin(uTime * 0.31 - travel * 0.06);
    float bend = (w1 + w2) * gust * uWindStrength;
    float k = h * h * (0.6 + 0.4 * h);
    return vec3(uWindDir.x, 0.0, uWindDir.y) * bend * k;
  }
`;

const ENV_INTERACT_GLSL = /* glsl */ `
  uniform vec4 uInt0;   // xyz = position, w = radius (0 = unused slot)
  uniform vec4 uInt1;
  uniform vec4 uInt2;
  uniform vec4 uInt3;
  uniform vec4 uIntPush;

  /** Bends a vertex away from one player; caller scales by the root→tip factor. */
  vec3 envInteractOne(vec3 world, vec4 p, float push, float h) {
    if (p.w <= 0.0 || push <= 0.0) return vec3(0.0);
    vec3 to = world - p.xyz;
    to.y = 0.0;
    float dist = length(to) + 1e-4;
    if (dist >= p.w) return vec3(0.0);
    float infl = 1.0 - smoothstep(p.w * 0.35, p.w, dist);
    vec3 acc = (to / dist) * (infl * push * (0.35 + 0.65 * h));
    acc.y -= infl * 0.12 * h; // press the tips down a little as well
    return acc;
  }

  vec3 envInteractPush(vec3 world, float h) {
    return envInteractOne(world, uInt0, uIntPush.x, h)
         + envInteractOne(world, uInt1, uIntPush.y, h)
         + envInteractOne(world, uInt2, uIntPush.z, h)
         + envInteractOne(world, uInt3, uIntPush.w, h);
  }
`;

const ENV_TIER_GLSL = /* glsl */ `
  uniform vec4 uTierDists;    // tier 0/1/2 distances, tier 3 = always off
  uniform vec4 uTierFracs;    // kept fraction per tier (1, .45, .12, 0)

  /** 1 = keep, 0 = drop. Random per instance + a soft band so fields thin out, not pop. */
  float envTierKeep(float dist, float rnd) {
    float d = dist + (rnd - 0.5) * 9.0;
    float frac = uTierFracs.x;
    if (d > uTierDists.x) frac = uTierFracs.y;
    if (d > uTierDists.y) frac = uTierFracs.z;
    if (d > uTierDists.z) frac = uTierFracs.w;
    return step(rnd, frac);
  }
`;

const ENV_LOD_GLSL = /* glsl */ `
  uniform float uLodSwitch;   // metres
  uniform float uLodSoft;     // fade band width
  uniform float uLodSign;     // +1: keep near mesh; -1: keep far mesh

  /** 0..1 scale for this instance under the band rules (1 = fully present). */
  float envLodScale(float dist, float bias) {
    float sw = uLodSwitch * bias;
    if (uLodSign > 0.0) {
      // detail mesh: full below sw, fades out across the soft band
      return 1.0 - smoothstep(sw - uLodSoft, sw + uLodSoft, dist);
    }
    // cheap mesh: inverse
    return smoothstep(sw - uLodSoft, sw + uLodSoft, dist);
  }
`;

const ENV_DITHER_GLSL = /* glsl */ `
  float envDitherHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  /** Screen-space ordered dither: stable, no blending, no sorting (plan §54). */
  void envDitherDiscard() {
    if (vFade >= 0.999) return;
    if (vFade <= 0.001) discard;
    if (envDitherHash(gl_FragCoord.xy) > vFade) discard;
  }
`;

function vertexSource(o: EnvMaterialOpts): string {
  const band = o.lodBand ?? 'none';
  return /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  ${ENV_VERT_COMMON}
  ${o.wind !== 'none' ? ENV_WIND_GLSL : ''}
  ${o.interact ? ENV_INTERACT_GLSL : ''}
  ${o.tiers ? ENV_TIER_GLSL : ''}
  ${band !== 'none' ? ENV_LOD_GLSL : ''}

  void main() {
    #ifdef USE_INSTANCING
      vec4 local = instanceMatrix * vec4(position, 1.0);
      mat3 nrmM = mat3(modelMatrix * instanceMatrix);
    #else
      vec4 local = vec4(position, 1.0);
      mat3 nrmM = mat3(modelMatrix);
    #endif
    vec4 wp = modelMatrix * local;

    // Collapsed instances (unloaded cell / destroyed object / budget) are pushed off-screen so
    // they cost nothing after the vertex stage.
    float lodScale = 1.0;
    ${band !== 'none' ? `
    float lodDist = distance(uCamPos, wp.xyz);
    lodScale = envLodScale(lodDist, aLod);` : ''}
    ${o.tiers ? `
    if (envTierKeep(distance(uCamPos, wp.xyz), aRand) < 0.5) lodScale = 0.0;` : ''}
    if (aState < 0.5 || lodScale <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vH = 0.0; vWorld = wp.xyz; vNormalW = vec3(0.0, 1.0, 0.0); vColor = vec3(1.0);
      vFade = 0.0; vGrain = aRand;
      return;
    }

    float h = clamp(position.y / max(0.001, aHeight), 0.0, 1.0);
    ${o.wind === 'blade' ? `
    // root pinned, tip swings (quadratic falloff)
    wp.xyz += envWindOffset(wp.xyz, h, aPhase) * 0.32;` : ''}
    ${o.wind === 'canopy' ? `
    // crown sway: the whole canopy layer moves, scaled by local height
    float crown = smoothstep(0.15, 1.0, h);
    wp.xyz += vec3(uWindDir.x, 0.0, uWindDir.y) * envWindOffset(wp.xyz, 1.0, aPhase).x * crown * 0.22;
    wp.xyz += vec3(0.0, envWindOffset(wp.xyz, 1.0, aPhase + 1.7).y * 0.5, 0.0) * crown;` : ''}
    ${o.interact ? `
    wp.xyz += envInteractPush(wp.xyz, h) * (0.55 + 0.45 * h);` : ''}

    // LOD cross-fade: once an instance is mostly faded out, hard-collapse it (dither handles the
    // intermediate band, so there is no popping and no blended transparency).
    if (lodScale <= 0.15) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vH = 0.0; vWorld = wp.xyz; vNormalW = vec3(0.0, 1.0, 0.0); vColor = vec3(1.0);
      vFade = 0.0; vGrain = aRand;
      return;
    }

    vH = h;
    vWorld = wp.xyz;
    vNormalW = normalize(nrmM * normal);
    vec3 col = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      col *= instanceColor;
    #endif
    vColor = col * aTint;
    vFade = aFade * (lodScale < 0.999 ? smoothstep(0.12, 0.5, lodScale) : 1.0);
    vGrain = aRand;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
}

function fragmentSource(o: EnvMaterialOpts): string {
  const lighting = o.huePreserve
    ? /* glsl */ `
    float ndl = max(dot(n, normalize(uSunDir)), 0.0);
    float hemi = clamp(dot(n, up) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(uGroundColor, uSkyColor, hemi);
    vec3 light = amb + uSunColor * ndl;
    float lum = dot(light, vec3(0.299, 0.587, 0.114));
    vec3 lit = albedo * (lum * 1.05 + 0.12) + light * 0.06;`
    : /* glsl */ `
    vec3 lit = nfLight(albedo, n, up, vWorld, 0.3);`;
  return /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform float uFacet;
  uniform float uEnvNoise;
  uniform float uEmissive;
  uniform float uFresnel;
  uniform float uAlpha;
  uniform float uFloor;
  uniform vec3 uTagColor;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vH;
  varying float vFade;
  varying float vGrain;
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}
  ${o.dither ? ENV_DITHER_GLSL : ''}

  float envHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  void main() {
    ${o.dither ? 'envDitherDiscard();' : ''}
    vec3 n = normalize(vNormalW);
    ${(o.facet ?? 0) > 0 ? `
    vec3 facetN = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(facetN, facetN) > 0.001) n = normalize(mix(n, facetN * sign(dot(facetN, n)), uFacet));` : ''}
    if (!gl_FrontFacing) n = -n;
    vec3 up = normalize(vWorld);
    n = normalize(mix(n, up, ${o.wind !== 'none' ? '0.45' : '0.2'}));

    float grit = mix(0.5, envHash(floor(vWorld * 3.1)) * 0.5 + envHash(floor(vWorld * 11.3)) * 0.5, uEnvNoise);
    vec3 albedo = vColor * (0.72 + 0.5 * grit);

    ${lighting}
    // thin vegetation picks up back-light when looking into the sun
    ${o.wind !== 'none' ? `
    float toward = max(dot(normalize(-uSunDir), normalize(uCamPos - vWorld)), 0.0);
    lit += uSunColor * pow(toward, 2.2) * vH * 0.4;
    lit += uSkyColor * vH * 0.18;` : ''}
    lit += albedo * uFloor;

    ${(o.emissive ?? 0) > 0 ? `
    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 2.2);
    lit += vColor * uEmissive * (0.45 + fres * (0.6 + uFresnel));
    lit += uTagColor * uEmissive * fres * 0.4;` : `
    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    lit += uRimColor * fres * uFresnel;`}

    lit = mix(lit, uFogColor, nfFog(vWorld));
    gl_FragColor = vec4(lit, uAlpha);
  }
`;
}

/**
 * Builds one environment material. Every grass/rock/tree instance in the world uses one of the
 * handful of materials this factory returns, so the scene has a small, fixed material set
 * (plan §42) and the shader compiler sees only a few program variants.
 */
export function createEnvironmentMaterial(wind: WindUniforms, o: EnvMaterialOpts = {}): THREE.ShaderMaterial {
  const windMode = o.wind ?? 'none';
  const uniforms = nfUniforms({
    uFacet: { value: o.facet ?? 0 },
    uEnvNoise: { value: o.noise ?? 0.35 },
    uEmissive: { value: o.emissive ?? 0 },
    uFresnel: { value: o.fresnel ?? 0.12 },
    uAlpha: { value: o.alpha ?? 1 },
    uFloor: { value: o.huePreserve ? 0.0 : 0.12 },
    uTagColor: { value: new THREE.Color(0xffffff) },
  });
  if (windMode !== 'none') {
    Object.assign(uniforms, {
      uWindDir: wind.uWindDir,
      uWindStrength: wind.uWindStrength,
      uWindGust: wind.uWindGust,
    });
  }
  if (o.interact) {
    const interact = createInteractUniforms();
    Object.assign(uniforms, interact as unknown as Record<string, THREE.IUniform>);
  }
  if (o.tiers) {
    Object.assign(uniforms, {
      uTierDists: { value: new THREE.Vector4(24, 55, 100, 999) },
      uTierFracs: { value: new THREE.Vector4(1, 0.45, 0.12, 0) },
    });
  }
  if (o.lodBand && o.lodBand !== 'none') {
    Object.assign(uniforms, {
      uLodSwitch: { value: 60 },
      uLodSoft: { value: o.lodSoft ?? 8 },
      uLodSign: { value: o.lodBand === 'keep-near' ? 1 : -1 },
    });
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertexSource(o),
    fragmentShader: fragmentSource(o),
    uniforms,
    side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: o.transparent ?? (o.alpha ?? 1) < 1,
    depthWrite: (o.alpha ?? 1) > 0.95,
  });
  return mat;
}

/** Convenience: the standard shared materials for the foliage systems (created once per planet). */
export interface EnvironmentMaterials {
  grass: THREE.ShaderMaterial;
  grassTierUniforms: { dists: THREE.IUniform; fracs: THREE.IUniform };
  treeDetail: THREE.ShaderMaterial;
  treeFar: THREE.ShaderMaterial;
  rockDetail: THREE.ShaderMaterial;
  rockFar: THREE.ShaderMaterial;
  canopy: THREE.ShaderMaterial;
  prop: THREE.ShaderMaterial;
  propFar: THREE.ShaderMaterial;
  crystal: THREE.ShaderMaterial;
  interact: InteractUniforms;
  dispose(): void;
}

export function createEnvironmentMaterials(wind: WindUniforms): EnvironmentMaterials {
  const interact = createInteractUniforms();
  const grass = createEnvironmentMaterial(wind, {
    wind: 'blade', interact: true, dither: true, tiers: true, huePreserve: true, noise: 0.25,
  });
  Object.assign(grass.uniforms, interact as unknown as Record<string, THREE.IUniform>);

  const canopy = createEnvironmentMaterial(wind, { wind: 'canopy', dither: true, noise: 0.4, fresnel: 0.16 });
  const treeDetail = createEnvironmentMaterial(wind, {
    wind: 'canopy', dither: true, noise: 0.4, fresnel: 0.08, lodBand: 'keep-near', lodSoft: 7,
  });
  const treeFar = createEnvironmentMaterial(wind, {
    wind: 'canopy', dither: true, noise: 0.3, fresnel: 0.06, lodBand: 'keep-far', lodSoft: 7,
  });
  const rockDetail = createEnvironmentMaterial(wind, { facet: 0.85, noise: 0.55, fresnel: 0.1, lodBand: 'keep-near', lodSoft: 6 });
  const rockFar = createEnvironmentMaterial(wind, { facet: 0.85, noise: 0.5, fresnel: 0.08, lodBand: 'keep-far', lodSoft: 6 });
  const prop = createEnvironmentMaterial(wind, { dither: true, facet: 0.4, noise: 0.4, fresnel: 0.1, lodBand: 'keep-near', lodSoft: 5 });
  const propFar = createEnvironmentMaterial(wind, { dither: true, facet: 0.4, noise: 0.35, fresnel: 0.08, lodBand: 'keep-far', lodSoft: 5 });
  const crystal = createEnvironmentMaterial(wind, {
    facet: 0.6, noise: 0.25, emissive: 0.6, fresnel: 0.5, alpha: 0.9, transparent: true, dither: true,
  });

  for (const m of [grass, treeDetail, treeFar, rockDetail, rockFar, prop, propFar, crystal]) {
    m.uniforms.uTagColor.value = new THREE.Color(0xffffff);
  }

  return {
    grass,
    grassTierUniforms: { dists: grass.uniforms.uTierDists, fracs: grass.uniforms.uTierFracs },
    treeDetail,
    treeFar,
    rockDetail,
    rockFar,
    canopy,
    prop,
    propFar,
    crystal,
    interact,
    dispose(): void {
      for (const m of [grass, treeDetail, treeFar, rockDetail, rockFar, prop, propFar, crystal, canopy]) m.dispose();
    },
  };
}

/** Per-instance attribute name list shared between the group class and the systems. */
export const ENV_INSTANCE_ATTRS = ['aTint', 'aPhase', 'aHeight', 'aState', 'aFade', 'aRand', 'aLod'] as const;
export type EnvInstanceAttr = (typeof ENV_INSTANCE_ATTRS)[number];
