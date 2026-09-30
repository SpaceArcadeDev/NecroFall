// NECROFALL — Wind (plan §18): ONE wind field for the whole world.
//
// Folio's Wind.js, ported: a constant direction (their `angle = Math.PI * 0.6` — the island's
// wind never wanders, only the strength moves), a local clock that scrolls with the strength,
// and one `offset(position)` node every wind-driven system reads: grass, tree leaves, bushes,
// flowers, crystals and the floating radioactive particles.
//
// The point of the module is that NOTHING loops over blades or leaves on the CPU: the wind is a
// pure function of `(position, localTime)` evaluated in the vertex shader, so the whole world
// breathes as one system.
import * as THREE from 'three/webgpu';
import { mx_noise_float, uniform, vec2, vec3 } from 'three/tsl';

export class Wind {
  /** Folio's constant wind angle. */
  static readonly ANGLE = Math.PI * 0.6;

  /**
   * Unit-sized 2D direction the gust fronts travel along. Folio's `angle = Math.PI * 0.6`
   * expressed as a vector — a CONSTANT, so the fronts scroll along one axis.
   */
  readonly direction = uniform(new THREE.Vector2(Math.sin(Wind.ANGLE), Math.cos(Wind.ANGLE)));
  /**
   * Folio drives this from the weather (`remapClamp(wind, 0, 1, 0.1, 1)`); NecroFall runs at the
   * top of that range so the travel waves clearly read at gameplay camera heights.
   */
  readonly strength = uniform(1);
  /** Folio's constant angle (kept for debug UI). */
  readonly angle = Wind.ANGLE;
  /** The wind's own clock — advances with dt × timeFrequency × strength (Folio's drive). */
  readonly localTime = uniform(0);
  /** Folio's Wind.js `timeFrequency = 0.1`, nudged to 0.15 for more prominent travel. */
  readonly timeFrequency = 0.15;
  readonly positionFrequency = uniform(0.5);

  /** Advance the wind clock by `dt` seconds — call once per frame. */
  advance(dt: number): void {
    this.localTime.value += dt * this.timeFrequency * this.strength.value;
  }

  /**
   * Folio's `offsetNode`: a 2D wind displacement for a point, driven by two scrolling noise
   * octaves. Used in LOCAL (tangent) space by foliage, and in tangent space by the grass.
   */
  readonly offset = (position: unknown): any => {
    const p = position as any;
    const remapped = p.mul(this.positionFrequency);
    const t = this.localTime;
    const dir = this.direction;

    const noise1 = mx_noise_float(vec3(remapped.xy.mul(0.2).add(dir.mul(t)), 0)).mul(0.5);
    const noise2 = mx_noise_float(vec3(remapped.xy.mul(0.1).add(dir.mul(t.mul(0.2))), 0)).mul(0.5);

    return vec2(dir.mul(noise1.add(noise2)).mul(this.strength));
  };

  /** The plan's name for `offset` (§18). */
  readonly offsetNode = this.offset;

  /** Magnitude-only helper: how far the wind pushes a point (for UV wobble etc.). */
  readonly offsetLength = (position: unknown): any => (this.offset(position) as any).length();
}
