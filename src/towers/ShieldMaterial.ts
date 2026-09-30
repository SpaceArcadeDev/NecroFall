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
    const fres = fresnelNode(2.2);

    // spherical lat/long energy lattice, scrolling over time
    const l = (positionLocal as any).normalize();
    const a = atan(l.z, l.x);
    const b = asin(l.y.clamp(-1, 1));
    const lattice = a.mul(14).add(NECRO_UNIFORMS.uTime.mul(0.9)).sin().mul(b.mul(16).sub(NECRO_UNIFORMS.uTime.mul(0.6)).sin());
    const grid = lattice.mul(0.5).add(0.5).smoothstep(0.72, 1);

    // rising containment bands
    const bands = l.y.mul(5).sub(NECRO_UNIFORMS.uTime.mul(0.12)).fract().sub(0.5).abs().smoothstep(0.18, 0.0);

    const alpha = uOpacity.mul(fres.add(grid.mul(0.55)).add(bands.mul(0.35)).add(0.3)).clamp(0, 0.95);
    const col = uColor.mul(fres.mul(1.3).add(grid.mul(0.7)).add(bands.mul(0.4)).add(0.6));
    return vec4(col, alpha);
  })();
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
    const fres = fresnelNode(2.0);
    // containment bands climbing the cone
    const bands = h.mul(3.5).sub(NECRO_UNIFORMS.uTime.mul(0.22)).fract().sub(0.5).abs().smoothstep(0.22, 0.0);
    const a = uOpacity.mul(fade).mul(fres.mul(0.85).add(bands.mul(0.55)).add(0.5)).clamp(0, 0.92);
    const col = uColor.mul(fres.mul(0.8).add(bands.mul(0.6)).add(0.9));
    return vec4(col, a);
  })();
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
    const fog = d.mul(NECRO_UNIFORMS.uFogDensity).pow(2).negate().exp().oneMinus().clamp(0, 1);

    const across = facing.pow(1.7);
    const profile = mix(0.1, 1.3, across);

    const alpha = uOpacity.mul(rise).mul(flick).mul(profile).mul(fog.mul(0.9).oneMinus());
    // LIGHTER, not white: the ray keeps its banner's colour.
    const tint = mix(uColor, vec3(1, 1, 1), uCore.mul(0.12).add(0.2));
    const hot = (uv() as any).y.mul(-7).exp();
    const col = tint.mul(across.mul(0.95).add(hot).add(1.1)).mul(uCore.mul(0.35).add(0.85));
    return vec4(col, alpha);
  })();
  return attachUniforms(material, { uColor, uOpacity, uCore });
}
