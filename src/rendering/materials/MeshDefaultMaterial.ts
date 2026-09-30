/**
 * NECROFALL — the central material (folio `Materials/MeshDefaultMaterial.js`
 * port, plan §9).
 *
 * Every environment surface — terrain, grass, trunks, leaf cards, rocks,
 * spikes, crystal bases — shades through this class so the world shares ONE
 * light, ONE shadow language, ONE fog. It owns: direct light, core shadow,
 * drop shadow, terrain bounce, fog, alpha discard.
 *
 * The folio maths is kept; the only coordinate change is the Spherical
 * adapter: the "ground" for the bounce is the planet surface under the
 * fragment (planet centred at the origin), not a flat Y=0 plane.
 */
import * as THREE from 'three/webgpu';
import {
  color,
  float,
  frontFacing,
  Fn,
  max,
  mix,
  normalWorld,
  positionWorld,
  vec3,
  vec4,
  If,
} from 'three/tsl';
import { WorldGlobals } from '../WorldGlobals';

export interface MeshDefaultMaterialParameters {
  colorNode?: any;
  normalNode?: any;
  alphaNode?: any;
  shadowNode?: any;
  alphaTest?: number;
  depthWrite?: boolean;
  depthTest?: boolean;
  side?: THREE.Side;
  wireframe?: boolean;
  transparent?: boolean;
  shadowSide?: THREE.Side;
  hasCoreShadows?: boolean;
  hasDropShadows?: boolean;
  hasLightBounce?: boolean;
  hasFog?: boolean;
  /** Kept for API parity with folio; puddle tinting lives in the puddle shader. */
  hasWater?: boolean;
}

export class MeshDefaultMaterial extends THREE.MeshLambertNodeMaterial {
  /** Forced per-material discard threshold (plan §9 alpha handling). */
  alphaTest: number;

  private readonly hasCoreShadows: boolean;
  private readonly hasDropShadows: boolean;
  private readonly hasLightBounce: boolean;
  private readonly hasFog: boolean;
  private readonly hasWater: boolean;
  private readonly sourceSide: THREE.Side;

  constructor(parameters: MeshDefaultMaterialParameters = {}) {
    super();

    const globals = WorldGlobals.get();
    const lighting = globals.lighting;
    const fog = globals.fog;
    const terrain = globals.terrain;

    this.depthWrite = parameters.depthWrite ?? true;
    this.depthTest = parameters.depthTest ?? true;
    this.side = parameters.side ?? THREE.FrontSide;
    this.sourceSide = this.side;
    this.wireframe = parameters.wireframe ?? false;
    this.transparent = parameters.transparent ?? false;
    this.shadowSide = parameters.shadowSide ?? THREE.FrontSide;

    this.hasCoreShadows = parameters.hasCoreShadows ?? true;
    this.hasDropShadows = parameters.hasDropShadows ?? true;
    this.hasLightBounce = parameters.hasLightBounce ?? true;
    this.hasFog = parameters.hasFog ?? true;
    this.hasWater = parameters.hasWater ?? false;

    const colorNode = (parameters.colorNode ?? color(0xffffff)) as any;
    const normalNode = (parameters.normalNode ?? normalWorld) as any;
    const alphaNode = (parameters.alphaNode ?? float(1)) as any;
    const shadowNode = (parameters.shadowNode ?? float(0)) as any;
    this.alphaTest = parameters.alphaTest ?? 0.1;

    // get rid of the NodeMaterial normal warning
    (this as any).normalNode = normalNode;

    /**
     * Shadow catcher: the engine's drop shadow is caught as a float and removed
     * from the main pipeline. It is re-mixed manually below so cast shadows use
     * the SAME colour as core shadows (the folio signature).
     */
    const catchedShadow = float(1).toVar();

    if (this.hasDropShadows) {
      (this as any).receivedShadowNode = Fn(([shadow]: any[]) => {
        catchedShadow.mulAssign(shadow.r);
        return float(1);
      });
    }

    const coreShadowEdgeHigh = lighting ? lighting.coreShadowEdgeHigh : float(1);
    const coreShadowEdgeLow = lighting ? lighting.coreShadowEdgeLow : float(-0.25);
    const shadowColorNode = lighting ? lighting.shadowColor : color('#171522');
    const directionNode = lighting ? lighting.directionUniform : vec3(0, 1, 0);

    this.outputNode = (Fn(() => {
      const baseColor = colorNode.toVar();
      const outputColor = colorNode.toVar();

      const reorientedNormal = normalNode.toVar();
      if (this.sourceSide === THREE.DoubleSide || this.sourceSide === THREE.BackSide) {
        If(frontFacing.not(), () => {
          reorientedNormal.mulAssign(-1);
        });
      }

      // ---- terrain light bounce (spherical: the planet is centred at origin)
      if (this.hasLightBounce && lighting && terrain) {
        const upDirection = positionWorld.normalize();
        const bounceOrientation = reorientedNormal
          .dot(upDirection.negate())
          .smoothstep(lighting.lightBounceEdgeLow, lighting.lightBounceEdgeHigh);

        const terrainData = terrain.terrainNode(upDirection);
        const surfaceRadius = terrain.heightMeters(terrainData.x).add(globals.radius);
        const heightAboveGround = positionWorld.length().sub(surfaceRadius);
        const bounceDistance = float(1)
          .sub(heightAboveGround.max(0).div(lighting.lightBounceDistance))
          .max(0)
          .pow(2);
        const bounceColor = mix(terrain.colorNode(terrainData), lighting.bounceColor, 0.35);

        outputColor.assign(
          mix(outputColor, bounceColor, bounceOrientation.mul(bounceDistance).mul(lighting.lightBounceMultiplier)),
        );
      }

      // ---- direct light
      if (lighting) {
        outputColor.mulAssign(lighting.colorUniform.mul(lighting.intensityUniform));
      }

      // ---- core shadow (facing away from the sun)
      let coreShadowMix: any = float(0);
      if (this.hasCoreShadows) {
        coreShadowMix = reorientedNormal.dot(directionNode).smoothstep(coreShadowEdgeHigh, coreShadowEdgeLow);
      }

      // ---- cast / drop shadow
      let dropShadowMix: any = float(0);
      if (this.hasDropShadows) {
        dropShadowMix = catchedShadow.oneMinus();
      }

      if (this.hasCoreShadows || this.hasDropShadows) {
        const combinedShadowMix = max(coreShadowMix, dropShadowMix, shadowNode).clamp(0, 1);
        const shadedColor = baseColor.rgb.mul(shadowColorNode);
        outputColor.assign(mix(outputColor, shadedColor, combinedShadowMix));
      }

      // ---- fog
      if (this.hasFog && fog) {
        outputColor.assign(mix(outputColor, fog.color, fog.strength));
      }

      // ---- alpha discard
      alphaNode.lessThan(this.alphaTest).discard();

      return vec4(outputColor, alphaNode);
    })() as any);
  }
}
