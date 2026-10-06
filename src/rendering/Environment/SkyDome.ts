/**
 * NECROFALL — sci-fi sky dome (visual rework plan §22, palette §1).
 *
 * The shipped sky was ONE screen-space radial gradient (`Fog.skyColor`), which cannot carry
 * cloud bands, orbital dust or celestial bodies — those need a WORLD direction. This dome is a
 * single inverted sphere around the planet that shades from the fragment's own direction:
 *
 *   atmospheric gradient      horizon turquoise → desaturated teal zenith
 *   cloud bands               two-octave noise, slowly drifting with the shared time uniform
 *   faint orbital dust        fine noise specks in the upper sky
 *   distant celestial bodies  one giant's disc + rim, one moon, the far sun (barely blooming)
 *
 * It draws FIRST (renderOrder −1000, no depth write/test) and is always behind the world, so the
 * planet stays the hero (plan §22: "keep them subtle"). ONE draw call, two noise fetches per sky
 * pixel; `?sky=0` removes it entirely.
 */
import * as THREE from 'three/webgpu';
import {
  asin,
  atan,
  color,
  dot,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import type { Noises } from './Noises';
import { ART_DIRECTION, SKY_PALETTE } from '../ArtDirection';

/** Angular radius (radians) of each body, and its direction — deterministic per planet. */
const GIANT = { dir: new THREE.Vector3(0.42, 0.18, -0.58).normalize(), radius: 0.135 };
const MOON = { dir: new THREE.Vector3(-0.52, 0.34, 0.62).normalize(), radius: 0.042 };
const SUN = { dir: new THREE.Vector3(0.42, 0.72, 0.32).normalize(), radius: 0.022 };

export class SkyDome {
  readonly mesh: THREE.Mesh;

  constructor(noises: Noises, timeUniform: any, radius: number) {
    const geometry = new THREE.SphereGeometry(radius, 32, 20);
    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.BackSide;
    // Depth: the dome is the FARTHEST thing in the scene, so it must be tested against the
    // world (drawn behind everything) but never write depth. NOTE: the renderer runs with
    // `sortObjects = false`, so draw order is insertion order — the dome is added FIRST in
    // PlanetRenderer, and the depth TEST keeps it behind the planet even if that ever changes.
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;

    const direction = normalize(positionLocal) as any;
    // equirect coordinates for the atmospheric bands (pole-safe, wraps in u)
    const u = (atan(direction.z, direction.x) as any).div(Math.PI * 2).add(0.5);
    const v = (asin((direction.y as any).clamp(-1, 1)) as any).div(Math.PI).add(0.5);
    const upness = direction.y;

    material.colorNode = (() => {
      // ---- atmospheric gradient (plan §1 palette: pale cyan → desaturated turquoise/teal)
      const zenithMix = smoothstep(-0.02, 0.5, upness);
      let sky: any = mix(color(SKY_PALETTE.horizon), color(SKY_PALETTE.zenith), zenithMix);
      // the contaminated haze band hugging the horizon (the shipped fog green, lifted)
      const hazeBand = smoothstep(-0.12, 0.2, upness).oneMinus();
      sky = mix(sky, color(SKY_PALETTE.haze), hazeBand.mul(0.55));
      const horizonBand = smoothstep(-0.05, 0.24, upness).oneMinus();
      sky = mix(sky, color(SKY_PALETTE.horizon), horizonBand.mul(ART_DIRECTION.atmosphere.horizonStrength * 0.6));

      // ---- cloud bands (plan §22): stretched noise, banded and faded away from the horizon
      const drift = (timeUniform as any).mul(0.0035);
      const clouds = texture(noises.perlin, vec2(u.mul(3).add(drift), v.mul(9))).r as any;
      const bandFade = smoothstep(0.02, 0.35, upness).mul(smoothstep(0.6, 0.98, upness).oneMinus());
      const bands = smoothstep(0.46, 0.78, clouds).mul(bandFade).mul(0.16);
      sky = mix(sky, color(SKY_PALETTE.cloud), bands);

      // ---- faint orbital dust (plan §22): fine specks, brighter higher up
      const dust = texture(noises.perlin, vec2(u.mul(58), v.mul(34))).r as any;
      const specks = smoothstep(0.78, 0.97, dust).mul(smoothstep(0.05, 0.5, upness)).mul(0.22);
      sky = sky.add(color(SKY_PALETTE.dust).mul(specks));

      // ---- distant celestial bodies (plan §22/§74): a banded giant, a moon, the far sun.
      // Discs are pure direction tests — no geometry, no extra draw calls.
      const giant = disc(direction, GIANT.dir, GIANT.radius);
      const giantBody = mix(color(SKY_PALETTE.body), color(SKY_PALETTE.bodyRim), smoothstep(0.4, 0.95, giant));
      sky = mix(sky, giantBody.mul(0.9), smoothstep(0.15, 0.9, giant).mul(0.85));
      sky = sky.add(color(SKY_PALETTE.bodyRim).mul(giant.mul(giant).mul(giant).mul(0.25)));

      const moon = disc(direction, MOON.dir, MOON.radius);
      sky = mix(sky, color(SKY_PALETTE.moon), smoothstep(0.2, 0.92, moon));

      // The sun disc keeps a hot core (> 1) so only IT feeds the restrained bloom (plan §26).
      const sun = disc(direction, SUN.dir, SUN.radius);
      sky = sky.add(color(SKY_PALETTE.sun).mul(smoothstep(0.3, 0.95, sun).mul(1.6)));

      return sky;
    })() as any;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'skyDome';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Soft disc mask: 1 inside the body's angular radius, fading at the rim. */
function disc(direction: any, bodyDirection: THREE.Vector3, radius: number): any {
  const cosine = dot(direction, vec3(bodyDirection.x, bodyDirection.y, bodyDirection.z));
  const inner = Math.cos(radius);
  const outer = Math.cos(radius * 1.35);
  return smoothstep(outer, inner, cosine) as any;
}
