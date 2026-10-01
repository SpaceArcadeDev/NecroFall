/**
 * NECROFALL — ONE wind field (folio `Wind.js` port, plan §18).
 *
 * Every swaying thing — grass blades, leaf cards, crystal shimmy, floating
 * contamination — reads this same node, so the whole surface moves as one
 * physical world. It is pure shader math: no per-blade CPU loop exists.
 */
import { Fn, texture, uniform, vec2 } from 'three/tsl';
import type { Ticker } from '../Ticker';
import type { WindGlobals } from '../WorldGlobals';
import type { Noises } from './Noises';

export class Wind implements WindGlobals {
  angle = Math.PI * 0.6;
  readonly direction = uniform(vec2(Math.sin(Math.PI * 0.6), Math.cos(Math.PI * 0.6)));
  readonly positionFrequency = uniform(0.5);
  readonly strength = uniform(0.55);
  readonly localTime = uniform(0);
  /** Phase speed of the one shared wind field (raised per "add more sway" — grass and trees). */
  timeFrequency = 0.14;

  readonly offsetNode: (position: any) => any;

  constructor(
    private readonly noises: Noises,
    ticker: Ticker,
  ) {
    // Folio's field: two noise lookups scrolling along the wind direction.
    this.offsetNode = Fn(([position]: any[]) => {
      const remapedPosition = position.mul(this.positionFrequency);
      const noiseUv1 = remapedPosition.xy.mul(0.2).add(this.direction.mul(this.localTime)).xy;
      const noise1 = texture(this.noises.perlin, noiseUv1 as any).r.sub(0.5);
      const noiseUv2 = remapedPosition.xy.mul(0.1).add(this.direction.mul(this.localTime.mul(0.2))).xy;
      const noise2 = texture(this.noises.perlin, noiseUv2 as any).r.sub(0.5);
      const intensity = noise2.add(noise1);
      return vec2(this.direction.mul(intensity).mul(this.strength));
    });

    ticker.on(7, () => this.update(ticker.delta));
  }

  private update(delta: number): void {
    this.localTime.value += delta * this.timeFrequency * this.strength.value;
  }
}
