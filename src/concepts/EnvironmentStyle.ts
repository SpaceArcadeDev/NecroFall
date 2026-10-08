import { MeshLambertNodeMaterial, type Side } from 'three/webgpu';
import { cameraPosition, color, float, Fn, min, mix, normalViewGeometry, normalWorldGeometry, positionWorld, sin, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import type { PlanetStudy } from './definitions';

export interface EnvironmentStyleOptions {
  study: PlanetStudy;
  base: any;
  normal?: any;
  alpha?: any;
  rootShade?: any;
  emission?: any;
  radiationMask?: any;
  side?: Side;
  fog?: boolean;
  shadows?: boolean;
  alphaTest?: number;
}

export class EnvironmentMaterial extends MeshLambertNodeMaterial {
  readonly fogStrength = uniform(1);
  readonly radiation = uniform(0);

  constructor(options: EnvironmentStyleOptions) {
    super();
    this.toneMapped = false;
    this.fog = false;
    this.side = options.side ?? this.side;
    this.alphaTest = options.alphaTest ?? 0;
    this.opacityNode = options.alpha ?? float(1);
    this.normalNode = normalViewGeometry;
    const shadow = float(1).toVar();
    if (options.shadows !== false) {
      (this as any).receivedShadowNode = Fn(([sample]: any[]) => {
        shadow.mulAssign(sample.r);
        return float(1);
      });
    }
    const normal = options.normal ?? normalWorldGeometry;
    const ramp = smoothstep(-0.22, 0.86, normal.dot(vec3(-0.5, 0.75, 0.4)));
    const bands = float(0.24).add(smoothstep(0.17, 0.20, ramp).mul(0.24))
      .add(smoothstep(0.47, 0.50, ramp).mul(0.28))
      .add(smoothstep(0.79, 0.82, ramp).mul(0.24));
    const seams = smoothstep(0.98, 0.999, sin(positionWorld.x.mul(0.32).add(sin(positionWorld.z.mul(0.27)).mul(2.5)).add(positionWorld.y.mul(0.21))))
      .mul(smoothstep(-0.3, 0.5, sin(positionWorld.x.mul(0.53).sub(positionWorld.z.mul(0.27)))));
    const radiationMask = options.radiationMask ?? seams.mul(0.48).add(0.065);
    this.outputNode = Fn(() => {
      const light = min(bands, shadow.mul(0.78).add(0.22));
      const shade = mix(color('#4d617a'), color(options.study.sun), light);
      let result: any = options.base.mul(shade);
      if (options.rootShade) result = result.mul(options.rootShade);
      if (options.emission) result = result.add(options.emission);
      result = result.add(color(options.study.infection).mul(radiationMask).mul(this.radiation).mul(0.85));
      if (options.fog !== false) {
        const distance = positionWorld.sub(cameraPosition).length();
        const haze = mix(color(options.study.horizon), color(options.study.infection), this.radiation.mul(0.1));
        result = mix(result, haze, smoothstep(115, 430, distance).mul(0.84).mul(this.fogStrength));
      }
      return vec4(result, options.alpha ?? float(1));
    })();
  }
}