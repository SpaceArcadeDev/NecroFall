// NECROFALL — cell-shaded materials for IMPORTED enemy base models.
//
// Imported bodies (the Mega Necrophage's insectoid rig, the crawler) arrive as ordinary PBR
// glTF materials. Both live in a cel-shaded world, so every surface is rebuilt here as an
// unlit node material that shades like the procedural creatures in `EnemyModels.ts`:
//
//   • the SAME environment language — the shared NECRO_UNIFORMS (sun, ambient, rim) and
//     `nfFog`, so an imported body matches the world and the `?cel=0` A/B switch exactly;
//   • the SAME cel ramp: `celQuantize` snaps `dot(N, sun)` into the art-direction bands the
//     terrain, props and the base-planets enemy model already shade in, instead of an
//     ordinary smooth PBR falloff;
//   • the SAME creature handles every gameplay system already writes — `uFlash` (hit
//     feedback), `uFreeze` (cryo crust), `uAggro`/`uAccent` (venom veins, boss wash) — under
//     the same names as `CarapaceMaterial`/`EnergyMaterial`, so `Enemy.place()` drives an
//     imported body through ONE code path.
import * as THREE from 'three/webgpu';
import { Fn, If, color, mix, normalWorld, positionWorld, texture, uniform, vec3, vec4 } from 'three/tsl';
import { celQuantize } from '../../rendering/materials/CelShading';
import { NECRO_UNIFORMS, nfFog } from '../../rendering/materials/NecroChunks';

/** The uniform surface `Enemy.place()` animates — the twin of `CarapaceUniforms`. */
export interface ImportedUniforms {
  uTint: { value: THREE.Color };
  uTintAmount: { value: number };
  uGlow: { value: number };
  uPattern: { value: number };
  uPhase: { value: number };
  uSurfaceFrame: { value: THREE.Matrix4 };
  uPatternScale: { value: number };
  /** Venom/energy tint: chitin veins, and the emissive wash on membrane surfaces. */
  uAccent: { value: THREE.Color };
  uAggro: { value: number };
  uFlash: { value: number };
  uFreeze: { value: number };
  uIcePhase: { value: number };
  /** Boss state wash (stun yellow / enrage red) mixed over the albedo. */
  uState: { value: THREE.Color };
  uStateAmount: { value: number };
}

export type ImportedMaterial = THREE.MeshBasicNodeMaterial & ImportedUniforms;

const iceCol = (): any => vec3(0.6, 0.9, 1.0);

/**
 * Rebuilds one imported PBR material as the game's cel-shaded creature surface.
 *
 * `membrane` selects the glow branch (the insectoid rig's translucent wings): the albedo is
 * multiplied by the accent tint and lit by a fresnel, so thin surfaces read as emissive tissue
 * instead of lit cloth.
 */
export function importedMaterial(source: THREE.MeshStandardMaterial, membrane: boolean): ImportedMaterial {
  const uTint = uniform(new THREE.Color(0xffffff));
  const uTintAmount = uniform(0);
  const uGlow = uniform(0.9);
  const uPattern = uniform(0);
  const uPhase = uniform(0);
  const uSurfaceFrame = uniform(new THREE.Matrix4());
  const uPatternScale = uniform(5);
  const uAccent = uniform(new THREE.Color(membrane ? 0x8fe3c8 : 0xb6ff5a));
  const uAggro = uniform(0);
  const uFlash = uniform(0);
  const uFreeze = uniform(0);
  const uIcePhase = uniform(0);
  const uState = uniform(new THREE.Color(0xffffff));
  const uStateAmount = uniform(0);

  const material = new THREE.MeshBasicNodeMaterial();
  // The creature shaders roll their own fog (`nfFog`); three's scene fog stays off for them.
  material.fog = false;
  material.name = source.name;
  material.alphaTest = source.alphaTest;
  material.side = source.side;
  material.transparent = source.transparent;
  material.depthWrite = source.depthWrite;
  material.opacity = source.opacity;

  const map = source.map;
  const albedoUniform = color(source.color);
  const painted = map ? texture(map).rgb.mul(albedoUniform) : albedoUniform.rgb;
  const detail = painted.dot(vec3(0.32, 0.56, 0.12)).mul(0.85).add(0.12);
  const base = mix(painted, uTint.rgb.mul(detail), uTintAmount);
  const alpha = map ? texture(map).a : 1;

  material.colorNode = Fn(() => {
    const n = normalWorld.normalize();
    const wp = positionWorld;
    const radialUp = wp.normalize();
    const viewDir = (NECRO_UNIFORMS.uCamPos as any).sub(wp).normalize();

    // Cel lighting: the sun term rides the QUANTISED ramp, but with a FLOOR — the darkest band
    // keeps half the sun instead of going black (the same reason the terrain's ladder bottoms out
    // at 0.72 and the base-planets enemy model at 0.37: a stepped look, never a dead silhouette).
    // The hemisphere ambient, slope shading and rim tint are the world's own reads.
    const ramp = celQuantize(n.dot(NECRO_UNIFORMS.uSunDir as any).clamp(0, 1));
    const banded = ramp.mul(0.5).add(0.5);
    const hemi = n.dot(radialUp).mul(0.5).add(0.5).clamp(0, 1);
    const ambient = mix(NECRO_UNIFORMS.uGroundColor, NECRO_UNIFORMS.uSkyColor, hemi);
    const tinted = mix(base, uState, uStateAmount.mul(0.75));
    const lit = tinted.mul(ambient.add(NECRO_UNIFORMS.uSunColor.mul(banded))).toVar();
    const slope = radialUp.dot(n).clamp(0, 1).oneMinus();
    lit.assign(lit.mul(mix(1.0, 0.82, slope)));
    const rim = n.dot(viewDir).clamp(0, 1).oneMinus().pow(3);
    lit.assign(lit.add(NECRO_UNIFORMS.uRimColor.mul(rim).mul(0.3)));

    // The two families are chosen when the material is built, so the branch is plain JS.
    if (membrane) {
      // Thin glowing tissue: the fresnel IS the light, and the accent tint carries the colour.
      const inner = n.dot(viewDir).abs().clamp(0, 1).oneMinus().pow(1.5);
      const pulse = NECRO_UNIFORMS.uTime.mul(2).add(uPhase).sin().mul(0.2).add(0.8);
      const emission = lit.mul(uAccent.mul(0.7).add(0.3)).mul(inner.mul(0.4).add(0.15)).mul(uGlow).mul(pulse).clamp(0, 0.4);
      lit.addAssign(vec3(1).sub(lit.clamp(0, 1)).mul(emission));
    } else {
      const tissue = uSurfaceFrame.mul(vec4(wp, 1)).xyz.mul(uPatternScale);
      const clock = NECRO_UNIFORMS.uTime.add(uPhase);
      const wave = tissue.x.mul(1.7).sin().mul(tissue.y.mul(1.35).add(clock.mul(0.6)).sin()).mul(tissue.z.mul(1.55).sin());
      const veins = wave.mul(0.5).add(0.5).smoothstep(0.55, 0.9);
      const bands = tissue.y.mul(2.8).add(tissue.x.mul(2.2).sin()).sub(clock.mul(1.8)).sin().smoothstep(0.55, 0.85);
      const cells = wave.abs().smoothstep(0.025, 0.15).oneMinus();
      const pattern = uPattern.lessThan(0.5).select(veins, uPattern.lessThan(1.5).select(bands, cells));
      const excitation = pattern.pow(2).mul(uGlow).mul(uAggro.mul(0.4).add(0.65)).clamp(0, 0.8);
      const emission = lit.mul(uAccent.mul(0.7).add(0.3)).mul(excitation).clamp(0, 0.4);
      lit.addAssign(vec3(1).sub(lit.clamp(0, 1)).mul(emission));
    }

    // FROST: the whole body crusts over in pale blue, throbbing off the shared shader clock.
    If(uFreeze.greaterThan(0.001), () => {
      const crust = wp.x.mul(2.3).sin().mul(wp.y.mul(2.9).sin()).mul(wp.z.mul(2.1).sin()).smoothstep(-0.1, 0.85);
      const throb = NECRO_UNIFORMS.uTime.mul(3.6).add(uIcePhase).sin().mul(0.22).add(0.78);
      const iceRim = n.dot(viewDir).abs().clamp(0, 1).oneMinus().pow(1.35);
      const k = uFreeze.mul(throb).mul(crust.mul(0.2).add(iceRim.mul(0.24)).add(0.62)).clamp(0, 0.86);
      lit.assign(mix(lit, iceCol(), k).add(iceCol().mul(iceRim).mul(uFreeze).mul(throb).mul(0.35)));
    });

    // Short white flash on every hit, so damage reads instantly.
    lit.assign(mix(lit, vec3(1.0), uFlash.clamp(0, 1)));
    lit.assign(mix(lit, NECRO_UNIFORMS.uFogColor, nfFog(wp)));
    return vec4(lit, alpha);
  })();

  const attached = material as unknown as ImportedMaterial;
  attached.uTint = uTint;
  attached.uTintAmount = uTintAmount;
  attached.uGlow = uGlow;
  attached.uPattern = uPattern;
  attached.uPhase = uPhase;
  attached.uSurfaceFrame = uSurfaceFrame;
  attached.uPatternScale = uPatternScale;
  attached.uAccent = uAccent;
  attached.uAggro = uAggro;
  attached.uFlash = uFlash;
  attached.uFreeze = uFreeze;
  attached.uIcePhase = uIcePhase;
  attached.uState = uState;
  attached.uStateAmount = uStateAmount;
  return attached;
}
