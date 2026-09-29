// NECROFALL — WATER SURFACE (rework plan §14/§15/§51).
//
// Water is NOT a giant transparent plane and NOT a flat disc: it is a second sphere at the
// world's water radius, TRIMMED to the basins the terrain actually floods. Every vertex samples
// the same height field the ground uses, so the waterline is exact at the mesh resolution:
//
//     depth > 0  → submerged   (water covers the ground here)
//     depth ≈ 0  → shoreline    (foam band, wet margin)
//     depth < 0  → dry          (triangle removed)
//
// Rendering (plan §15/§51): a hand-written shader with depth-graded colour, contamination tint,
// scrolling normal distortion, sun glint and a fresnel sky reflection — all cheap, no planar
// reflection targets, no refraction, so it is safe on mobile GPUs.
import * as THREE from 'three';
import { clamp } from '../../utils/Utils';
import { nfUniforms, NF_UNIFORMS_GLSL, NF_LIGHTING_GLSL, NF_FOG_GLSL } from '../ShaderGlobals';
import type { BiomeDefinition } from '../EnvironmentPalette';
import type { PlanetTerrainProvider } from '../terrain/PlanetTerrainProvider';

const WATER_VERT = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform float uWaterLevel;
  uniform float uWaveStrength;
  attribute float aDepth;
  attribute float aContam;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vDepth;
  varying float vContam;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 radial = normalize(wp.xyz);
    // Gentle radial ripple: the surface stays a sphere, only breathes a few centimetres.
    float ripple = sin(wp.x * 0.35 + uTime * 1.1) * sin(wp.z * 0.31 - uTime * 0.9) * sin(wp.y * 0.4 + uTime * 0.7);
    wp.xyz += radial * ripple * uWaveStrength;
    vWorld = wp.xyz;
    vNormalW = radial;
    vDepth = aDepth;
    vContam = aContam;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uContamColor;
  uniform float uContamAmount;
  uniform float uDetail;   // 0 low .. 2 high (plan §45/§51)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vDepth;
  varying float vContam;
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}

  float whash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float wnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(whash(i), whash(i + vec2(1, 0)), u.x), mix(whash(i + vec2(0, 1)), whash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    if (vDepth < -0.05) discard;             // dry triangles (safety — the mesh already trims)
    vec3 up = normalize(vWorld);
    // Scrolling normal distortion (plan §15): two crossing wave fields, no vertex cost.
    vec3 n = up;
    if (uDetail > 0.5) {
      vec2 p = vec2(vWorld.x, vWorld.z) * 0.14;
      float w1 = wnoise(p + vec2(uTime * 0.11, uTime * 0.07));
      float w2 = wnoise(p * 1.7 - vec2(uTime * 0.09, uTime * 0.12));
      float dx = (wnoise(p + vec2(0.12, 0.0)) - w1) * 1.4;
      float dz = (wnoise(p + vec2(0.0, 0.12)) - w1) * 1.4;
      n = normalize(up + (vec3(dx, 0.0, dz) + vec3(w2 - 0.5, 0.0, w1 - 0.5) * 0.6) * 0.35);
    }

    // Depth grading: shallow → deep, then the contamination wash (plan §15).
    float depthK = clamp(vDepth / 6.0, 0.0, 1.0);
    vec3 col = mix(uShallow, uDeep, sqrt(depthK));
    col = mix(col, uContamColor, clamp(uContam * uContamAmount, 0.0, 0.75));

    // Fresnel sky reflection + sun glint (cheap stand-ins for real reflections — plan §51).
    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    vec3 lit = nfLight(col, n, up, vWorld, 0.05);
    lit = mix(lit, uSkyColor * 0.9, fres * 0.55);
    vec3 sunRefl = reflect(-normalize(uSunDir), n);
    float glint = pow(max(dot(sunRefl, viewDir), 0.0), uDetail > 1.5 ? 90.0 : 45.0);
    lit += uSunColor * glint * (uDetail > 0.5 ? 0.8 : 0.35);

    // Shoreline foam band (plan §16): animated, widens on the shallow side.
    float foam = 1.0 - smoothstep(0.0, 0.9, max(vDepth, 0.0));
    float foamNoise = wnoise(vec2(vWorld.x, vWorld.z) * 0.8 + vec2(uTime * 0.25, uTime * 0.18));
    foam *= smoothstep(0.35, 0.75, foamNoise + (1.0 - foam) * 0.3);
    lit += vec3(0.75, 0.85, 0.85) * foam * 0.5 * (uDetail > 0.5 ? 1.0 : 0.4);

    // Alpha: transparent enough to read the bottom near the shore, solid in the deep.
    float alpha = mix(0.55, 0.92, smoothstep(0.0, 2.5, vDepth));
    lit = mix(lit, uFogColor, nfFog(vWorld));
    gl_FragColor = vec4(lit, alpha);
  }
`;

export interface WaterSurfaceOpts {
  /** Icosphere subdivision — water does not need the terrain's resolution (plan §14). */
  detail: number;
  /** Shader richness 0..2 (plan §45/§51). */
  shaderDetail: number;
}

export interface WaterSurface {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Submerged surface area estimate (m²) for telemetry. */
  area: number;
  dispose(): void;
}

/**
 * Builds the trimmed water sphere for one planet. Returns null when the world has no water or
 * the water level floods nothing (dry planets skip the whole system — plan §78: features that
 * cannot initialize must never break the game).
 */
export function buildWaterSurface(
  provider: PlanetTerrainProvider,
  biome: BiomeDefinition,
  opts: WaterSurfaceOpts
): WaterSurface | null {
  const level = provider.waterLevel;
  if (level <= 0) return null;

  const base = new THREE.IcosahedronGeometry(1, clamp(Math.round(opts.detail), 2, 6));
  const pos = base.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const depths = new Float32Array(count);
  const contams = new Float32Array(count);
  const dir = new THREE.Vector3();

  let anyWater = false;
  for (let i = 0; i < count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const h = provider.getHeight(dir.x, dir.y, dir.z);
    const depth = level - h;
    depths[i] = clamp(depth, -2.5, 40);
    contams[i] = provider.getContamination(dir.x, dir.y, dir.z);
    if (depth > 0.05) anyWater = true;
    // Vertices sit exactly on the water sphere; the wave ripple is shader-side.
    pos.setXYZ(i, dir.x * level, dir.y * level, dir.z * level);
  }
  if (!anyWater) {
    base.dispose();
    return null;
  }

  // Trim triangles that are fully dry (plan §14: only flooded basins get a surface).
  const index = base.index;
  if (index) {
    const keep: number[] = [];
    for (let f = 0; f < index.count; f += 3) {
      const a = index.getX(f), b = index.getX(f + 1), c = index.getX(f + 2);
      const minDepth = Math.min(depths[a], depths[b], depths[c]);
      if (minDepth > -0.55) keep.push(a, b, c);
    }
    base.setIndex(keep);
  }
  base.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  base.setAttribute('aContam', new THREE.BufferAttribute(contams, 1));
  base.computeVertexNormals();

  const material = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: nfUniforms({
      uWaterLevel: { value: level },
      uWaveStrength: { value: 0.05 },
      uShallow: { value: new THREE.Color(biome.waterShallow) },
      uDeep: { value: new THREE.Color(biome.waterDeep) },
      uContamColor: { value: new THREE.Color(biome.waterContamination) },
      uContamAmount: { value: biome.contamination },
      uDetail: { value: opts.shaderDetail },
    }),
  });

  const mesh = new THREE.Mesh(base, material);
  mesh.name = 'env-water';
  mesh.renderOrder = 1; // after opaque terrain, before additive effects

  // Rough submerged area estimate (telemetry + tuning): fraction of sampled submerged vertices
  // scaled by the sphere area.
  let submerged = 0;
  for (let i = 0; i < count; i++) if (depths[i] > 0) submerged++;
  const area = (submerged / Math.max(1, count)) * 4 * Math.PI * level * level;

  return {
    mesh,
    material,
    area,
    dispose(): void {
      base.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
