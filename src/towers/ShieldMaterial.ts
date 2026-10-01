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
  dot,
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

/**
 * Saturation-only step (its luma share pulled back through the mix() identity). Pair it with a
 * BRILLIANCE field multiplied well past 1 — "vibrant light" is saturated colour that blazes,
 * not a flat bright fill and not a white stack.
 */
const saturate = (node: any, sat: number): any => {
  const luma: any = dot(node, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luma, luma, luma) as any, node as any, sat);
};

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
    // LIT shell: the sun-facing side carries more of the energy colour and the far side falls
    // into real shade (0.3..1.0).
    const sunLit = (normalWorld as any).dot(NECRO_UNIFORMS.uSunDir).clamp(0, 1).mul(0.7).add(0.3);

    // spherical lat/long energy lattice, scrolling over time
    const l = (positionLocal as any).normalize();
    const a = atan(l.z, l.x);
    const b = asin(l.y.clamp(-1, 1));
    const lattice = a.mul(14).add(NECRO_UNIFORMS.uTime.mul(0.9)).sin().mul(b.mul(16).sub(NECRO_UNIFORMS.uTime.mul(0.6)).sin());
    const grid = lattice.mul(0.5).add(0.5).smoothstep(0.72, 1);

    // rising containment bands
    const bands = l.y.mul(5).sub(NECRO_UNIFORMS.uTime.mul(0.12)).fract().sub(0.5).abs().smoothstep(0.0, 0.18).oneMinus();

    // VIBRANT LIGHT (user ask): a BRILLIANCE field — rim + energy cells + bands — multiplies the
    // saturated banner colour well past 1, so the hot structures carry a real glare (col × alpha
    // ≈ 1.2+ on the rim) while the face stays sheer enough to read the world through.
    const brilliance = fres.mul(2.4).add(grid.mul(1.1)).add(bands.mul(0.7)).add(0.05);
    const col = saturate(uColor, 1.45).mul(brilliance.mul(sunLit));
    const alpha = uOpacity.mul(fres.mul(1.0).add(grid.mul(0.55)).add(bands.mul(0.35)).add(0.04).mul(sunLit)).clamp(0, 0.9);
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
    // Lit cone: sun-facing facets carry the colour, the back falls into real shade.
    const sunLit = (normalWorld as any).dot(NECRO_UNIFORMS.uSunDir).clamp(0, 1).mul(0.7).add(0.3);
    // containment bands climbing the cone
    const bands = h.mul(3.5).sub(NECRO_UNIFORMS.uTime.mul(0.22)).fract().sub(0.5).abs().smoothstep(0.0, 0.22).oneMinus();
    // Same brilliance recipe as the dome: the rim facets and bands carry the glare.
    const brilliance = fres.mul(2.6).add(bands.mul(1.0)).add(0.06);
    const col = saturate(uColor, 1.45).mul(brilliance.mul(sunLit));
    const a = uOpacity.mul(fade).mul(fres.mul(0.95).add(bands.mul(0.55)).add(0.05).mul(sunLit)).clamp(0, 0.9);
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
    // flat additive sheet). `facing` ≈ 1 on the centre column of the ray, 0 at the silhouette.
    const core = facing.pow(1.5);
    const rim = core.oneMinus().pow(0.7);

    const hot = (uv() as any).y.mul(-7).exp();

    // VIBRANT LIGHT: a white-HOT core down the centre inside a saturated banner-coloured body —
    // the classic ray look (blown column, coloured mid/edges, brightest at the emitter tip).
    const energy = core.mul(2.6).add(rim.mul(1.5)).add(hot.mul(1.8));
    const glow = saturate(uColor, 1.5).mul(energy.mul(uCore.mul(0.3).add(0.85)));
    const whiteHot = vec3(1, 1, 1).mul(core.pow(3).mul(1.3).add(hot.mul(0.5)));
    const col = glow.add(whiteHot);

    const alpha = uOpacity.mul(rise).mul(flick).mul(core.mul(0.75).add(rim.mul(0.5)).add(0.05)).mul(fog.mul(0.9).oneMinus());
    return vec4(col, alpha);
  })();
  material.fog = false;
  return attachUniforms(material, { uColor, uOpacity, uCore });
}
