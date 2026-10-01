// NECROFALL — animated energy-shield materials (tower domes, fortress cones, beacon light rays).
//
// These used to be GLSL ShaderMaterials; they are now TSL MeshBasicNodeMaterials so the whole game
// renders on the WebGPU backend (plan §1/§54). The maths is a 1:1 port — fresnel rim, scrolling
// energy lattice, rising containment bands, cone-height fade and the beam's core/halo profile —
// with the shared time/camera/fog state read from NECRO_UNIFORMS (the TSL mirror of
// SHADER_GLOBALS that `Planet.update()` keeps in sync every frame).
import * as THREE from 'three/webgpu';
import {
  Fn,
  asin,
  atan,
  exp,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { NECRO_UNIFORMS } from '../rendering/materials/NecroChunks';

/** Shared helpers (kept as plain functions so each material reads like the GLSL did). */
const viewDirNode = () => (NECRO_UNIFORMS.uCamPos as any).sub(positionWorld).normalize();
const fresnelNode = (power: number) =>
  (normalWorld as any).dot(viewDirNode()).abs().oneMinus().pow(power);

/** The uniform handles callers use to animate a shield (attached to the material object). */
export interface ShieldUniforms {
  uColor: { value: THREE.Color };
  uOpacity: { value: number };
  uCore?: { value: number };
}

function attachUniforms(material: THREE.MeshBasicNodeMaterial, uniforms: ShieldUniforms): THREE.MeshBasicNodeMaterial {
  (material as unknown as ShieldUniforms).uColor = uniforms.uColor;
  (material as unknown as ShieldUniforms).uOpacity = uniforms.uOpacity;
  if (uniforms.uCore) (material as unknown as ShieldUniforms).uCore = uniforms.uCore;
  return material;
}

// ---------------------------------------------------------------------------- node dome

export function createShieldMaterial(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const uColor = uniform(new THREE.Color(color));
  const uOpacity = uniform(opacity);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  material.colorNode = Fn(() => {
    const fres = fresnelNode(2.6);
    // LIT shell: the sun-facing side carries more of the energy colour (plan §42) — the dome
    // reads as a lit glass bubble with a shaded side, instead of a flat additive wash.
    const sunLit = (normalWorld as any).dot(NECRO_UNIFORMS.uSunDir).clamp(0, 1).mul(0.6).add(0.4);

    // spherical lat/long energy lattice, scrolling over time
    const l = (positionLocal as any).normalize();
    const a = atan(l.z, l.x);
    const b = asin(l.y.clamp(-1, 1));
    const lattice = a.mul(14).add(NECRO_UNIFORMS.uTime.mul(0.9)).sin().mul(b.mul(16).sub(NECRO_UNIFORMS.uTime.mul(0.6)).sin());
    const grid = lattice.mul(0.5).add(0.5).smoothstep(0.72, 1);

    // rising containment bands
    const bands = l.y.mul(5).sub(NECRO_UNIFORMS.uTime.mul(0.12)).fract().sub(0.5).abs().smoothstep(0.0, 0.18).oneMinus();

    // Edge-weighted bubble: the rim carries the glow, the face stays sheer so the world is
    // never tinted flat through the dome.
    const alpha = uOpacity.mul(fres.add(grid.mul(0.5)).add(bands.mul(0.3)).mul(sunLit)).clamp(0, 0.85);
    // HDR boost: the shell's energy rides ABOVE 1 so the bloom pass catches it (glowing dome).
    const col = uColor.mul(fres.mul(1.5).add(grid.mul(0.6)).add(bands.mul(0.35)).add(0.15).mul(sunLit)).mul(1.6);
    return vec4(col, alpha);
  })();
  // The material owns its look — never the scene's legacy fog mirror (plan §24).
  material.fog = false;
  return attachUniforms(material, { uColor, uOpacity });
}

// ---------------------------------------------------------------------------- base shield cone

export function createBaseConeMaterial(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const uColor = uniform(new THREE.Color(color));
  const uOpacity = uniform(opacity);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.colorNode = Fn(() => {
    // 0 at the ground, 1 at the tip: the skirt VANISHES well before the apex so the additive
    // segments never pile into a bright knot where the cone converges.
    const h = (uv() as any).y.clamp(0, 1);
    const fade = h.smoothstep(0.12, 0.82).oneMinus();
    const fres = fresnelNode(2.4);
    // Lit cone: sun-facing facets carry the colour, the back reads as shade.
    const sunLit = (normalWorld as any).dot(NECRO_UNIFORMS.uSunDir).clamp(0, 1).mul(0.6).add(0.4);
    // containment bands climbing the cone
    const bands = h.mul(3.5).sub(NECRO_UNIFORMS.uTime.mul(0.22)).fract().sub(0.5).abs().smoothstep(0.0, 0.22).oneMinus();
    const a = uOpacity.mul(fade).mul(fres.mul(0.9).add(bands.mul(0.5)).add(0.12).mul(sunLit)).clamp(0, 0.85);
    // HDR boost (bloom): the rim facets carry the glow.
    const col = uColor.mul(fres.mul(1.1).add(bands.mul(0.5)).add(0.25).mul(sunLit)).mul(1.35);
    return vec4(col, a);
  })();
  material.fog = false;
  return attachUniforms(material, { uColor, uOpacity });
}

// ---------------------------------------------------------------------------- light ray

export function createBeamMaterial(color: number, opacity: number, core = 1): THREE.MeshBasicNodeMaterial {
  const uColor = uniform(new THREE.Color(color));
  const uOpacity = uniform(opacity);
  const uCore = uniform(core);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    alphaTest: 0.004,
  });
  material.colorNode = Fn(() => {
    const viewDir = viewDirNode();
    const facing = (normalWorld as any).dot(viewDir).abs();

    // full strength at the emitter, gone fast (a beacon, not a glass tube)
    const rise = (uv() as any).y.oneMinus().clamp(0, 1).pow(3);
    const flick = NECRO_UNIFORMS.uTime.mul(uCore.mul(0.6).add(1.1)).add((uv() as any).y.mul(7)).sin().mul(0.12).add(0.88);

    const d = (NECRO_UNIFORMS.uCamPos as any).sub(positionWorld).length();
    // WORLD fog (the same range curve + colour the terrain fades with) — the ray dissolves
    // into the same haze as everything else.
    const fog = smoothstep(NECRO_UNIFORMS.uFogNear, NECRO_UNIFORMS.uFogFar, d).clamp(0, 1);

    // Richer edge contrast: the silhouette is bright, the middle sheer (a light ray, not a
    // flat additive sheet).
    const across = facing.pow(2.1);
    const profile = mix(0.1, 1.35, across);

    const alpha = uOpacity.mul(rise).mul(flick).mul(profile).mul(fog.mul(0.9).oneMinus());
    // The ray keeps its banner colour; only the core tip whitens.
    const tint = mix(uColor, vec3(1, 1, 1), uCore.mul(0.12).add(0.1));
    const hot = (uv() as any).y.mul(-7).exp();
    // HDR boost (bloom): silhouette and core tip push past 1 so the ray reads as LIGHT.
    const col = tint.mul(across.mul(1.05).add(hot).add(0.62)).mul(uCore.mul(0.35).add(0.85)).mul(1.7);
    return vec4(col, alpha);
  })();
  material.fog = false;
  return attachUniforms(material, { uColor, uOpacity, uCore });
}
