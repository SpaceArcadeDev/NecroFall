/**
 * NECROFALL — shared TSL shader chunks (migration Phase 1).
 *
 * TSL ports of the legacy GLSL chunks — formula-for-formula, per the migration
 * plan (docs in repo memory):
 *   • `world/ShaderGlobals.ts`  → NECRO_UNIFORMS + nfLight() + nfFog()
 *   • `world/Vegetation.ts`     → windOffset() + groundDirt()
 *
 * Every ported gameplay material (Phase 2) imports these so the whole game
 * keeps ONE lighting/fog/wind language after it moves to the WebGPU pipeline.
 * While both stacks coexist, `syncNecroChunks()` mirrors the legacy
 * SHADER_GLOBALS values into the TSL uniforms (single source of truth).
 */
import * as THREE from 'three/webgpu';
import { float, Fn, max, mix, normalize, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { SHADER_GLOBALS } from '../../world/ShaderGlobals';
import { WorldGlobals } from '../WorldGlobals';

// ---------------------------------------------------------------- uniforms

/** TSL uniforms mirroring the environment (the legacy store is only the pre-world fallback). */
export const NECRO_UNIFORMS = {
  uTime: uniform(0),
  uCamPos: uniform(new THREE.Vector3()),
  uSunDir: uniform(new THREE.Vector3(1, 0.85, 0.6).normalize()),
  uSunColor: uniform(new THREE.Color(0xfff0d8).multiplyScalar(0.95)),
  // Ambient family — warm sky / vegetation bounce / soft teal rim, matching the world's palette
  // (the old purple set made every gameplay object read as washed grey against the warm world).
  uSkyColor: uniform(new THREE.Color(0xd8e6c8).multiplyScalar(0.55)),
  uGroundColor: uniform(new THREE.Color(0x2f6b4f).multiplyScalar(0.85)),
  uRimColor: uniform(new THREE.Color(0x9fd6c9)),
  uFogColor: uniform(new THREE.Color(0x1d3a30)),
  /** Range-fog bounds — kept equal to the world's Fog (near 34 / far 270). */
  uFogNear: uniform(34),
  uFogFar: uniform(270),
  /** Legacy exp² density (kept for compatibility; nfFog uses the range form). */
  uFogDensity: uniform(0.00125),
  uWindDir: uniform(new THREE.Vector2(0.82, 0.57)),
  uWindStrength: uniform(1),
  uWindGust: uniform(0),
} as const;

/**
 * How much of the world's `sun color × intensity` the gameplay lighting model takes.
 * `nfLight` adds its ambient on top, and the world's own materials shade at the full
 * `color × intensity` — 0.9 puts gameplay objects within a few percent of world surfaces.
 */
const GAMEPLAY_SUN_SCALE = 0.9;

/**
 * Mirrors the frame state into the TSL uniforms.
 *
 * THE environment owner rule (plan §4/§23): while a world exists, EVERY gameplay material
 * shades with the SAME sun, ambient and fog the folio environment uses — `WorldGlobals` is the
 * single source of truth. `SHADER_GLOBALS` remains only as the pre-world (menu/loading)
 * fallback for time and camera position.
 */
export function syncNecroChunks(wind?: {
  dir: { x: number; y: number };
  strength: number;
  gust: number;
}): void {
  const g = SHADER_GLOBALS;
  NECRO_UNIFORMS.uTime.value = g.uTime.value as number;
  NECRO_UNIFORMS.uCamPos.value.copy(g.uCamPos.value as THREE.Vector3);

  const globals = WorldGlobals.current;
  const lighting = globals?.lighting ?? null;
  const fog = globals?.fog ?? null;
  if (lighting) {
    const direction = lighting.directionUniform.value as THREE.Vector3;
    NECRO_UNIFORMS.uSunDir.value.copy(direction).normalize();
    const color = lighting.colorUniform.value as THREE.Color;
    const intensity = lighting.intensityUniform.value as number;
    NECRO_UNIFORMS.uSunColor.value.copy(color).multiplyScalar(intensity * GAMEPLAY_SUN_SCALE);
  } else {
    NECRO_UNIFORMS.uSunDir.value.copy(g.uSunDir.value as THREE.Vector3);
    NECRO_UNIFORMS.uSunColor.value.copy(g.uSunColor.value as THREE.Color);
  }
  if (fog) {
    NECRO_UNIFORMS.uFogColor.value.copy(fog.color.value as THREE.Color);
    NECRO_UNIFORMS.uFogNear.value = fog.near.value as number;
    NECRO_UNIFORMS.uFogFar.value = fog.far.value as number;
  } else {
    NECRO_UNIFORMS.uFogColor.value.copy(g.uFogColor.value as THREE.Color);
    NECRO_UNIFORMS.uFogDensity.value = g.uFogDensity.value as number;
  }
  if (wind) {
    NECRO_UNIFORMS.uWindDir.value.set(wind.dir.x, wind.dir.y);
    NECRO_UNIFORMS.uWindStrength.value = wind.strength;
    NECRO_UNIFORMS.uWindGust.value = wind.gust;
  }
}

// ---------------------------------------------------------------- lighting / fog

/** GLSL `nfLight`: hemisphere + sun lighting with slope shading and a rim term. */
export const nfLight = Fn(([albedo, n, radialUp, wp, rimStrength]: any[]) => {
  const ndl = max(n.dot(normalize(NECRO_UNIFORMS.uSunDir)), 0.0);
  const hemi = n.dot(radialUp).mul(0.5).add(0.5).clamp(0.0, 1.0);
  const ambient = mix(NECRO_UNIFORMS.uGroundColor, NECRO_UNIFORMS.uSkyColor, hemi);
  let lit = albedo.mul(ambient.add(NECRO_UNIFORMS.uSunColor.mul(ndl)));

  const slope = float(1).sub(radialUp.dot(n).clamp(0.0, 1.0));
  lit = lit.mul(mix(1.0, 0.78, slope));

  const viewDir = normalize(NECRO_UNIFORMS.uCamPos.sub(wp));
  const rim = float(1).sub(n.dot(viewDir).clamp(0.0, 1.0));
  lit = lit.add(NECRO_UNIFORMS.uRimColor.mul(rim.pow(3.0)).mul(rimStrength));
  return lit;
});

/**
 * Distance fog matching the WORLD's fog exactly: `smoothstep(near, far, distance)` — the same
 * curve three's `rangeFogFactor(near, far)` (which the world materials use) applies, with the
 * folio fog colour. Gameplay objects fade into the same haze as the terrain behind them.
 */
export const nfFog = Fn(([wp]: any[]) => {
  const d = NECRO_UNIFORMS.uCamPos.sub(wp).length();
  return smoothstep(NECRO_UNIFORMS.uFogNear, NECRO_UNIFORMS.uFogFar, d).clamp(0.0, 1.0);
});

// ---------------------------------------------------------------- wind / dirt

/**
 * GLSL `windOffset` (Vegetation): two crossing waves + a travelling gust front,
 * driven by world position so neighbouring blades share the phase.
 * `h` = 0 root .. 1 tip; root stays planted (quadratic-plus falloff).
 */
export const windOffset = Fn(([world, h, phase]: any[]) => {
  const travel = world.x.mul(NECRO_UNIFORMS.uWindDir.x).add(world.z.mul(NECRO_UNIFORMS.uWindDir.y));
  const w1 = sin(NECRO_UNIFORMS.uTime.mul(1.35).sub(travel.mul(0.35)).add(phase));
  const w2 = sin(NECRO_UNIFORMS.uTime.mul(2.9).sub(travel.mul(0.9)).add(phase.mul(1.7))).mul(0.42);
  const gust = float(1).add(
    NECRO_UNIFORMS.uWindGust.mul(0.9).mul(sin(NECRO_UNIFORMS.uTime.mul(0.31).sub(travel.mul(0.06)))),
  );
  const bend = w1.add(w2).mul(gust).mul(NECRO_UNIFORMS.uWindStrength);
  const k = h.mul(h).mul(h.mul(0.4).add(0.6));
  return vec3(NECRO_UNIFORMS.uWindDir.x, 0.0, NECRO_UNIFORMS.uWindDir.y).mul(bend).mul(k).mul(0.32);
});

const dirtHash = Fn(([p]: any[]) =>
  p.x.mul(127.1).add(p.y.mul(311.7)).sin().mul(43758.5453123).fract(),
);

const dirtNoise = Fn(([p]: any[]) => {
  const i = p.floor();
  const f = p.fract();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  const a = dirtHash(i);
  const b = dirtHash(i.add(vec2(1.0, 0.0)));
  const c = dirtHash(i.add(vec2(0.0, 1.0)));
  const d = dirtHash(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/**
 * GLSL `groundDirt` (Vegetation): 0 = lush grass, 1 = bare dirt.
 * The legacy `world/Vegetation.ts` CPU mirror was decommissioned in the migration's final phase;
 * the folio stack's own grass placement owns ground variation now.
 */
export const groundDirt = Fn(([worldXZ]: any[]) => {
  const n = dirtNoise(worldXZ.mul(0.055)).mul(0.65).add(dirtNoise(worldXZ.mul(0.19)).mul(0.35));
  return smoothstep(0.42, 0.72, n);
});
