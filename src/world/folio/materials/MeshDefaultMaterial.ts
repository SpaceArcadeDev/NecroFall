// NECROFALL — Folio 2025's `MeshDefaultMaterial`, ported from
// folio-2025/sources/Game/Materials/MeshDefaultMaterial.js (MIT, Bruno Simon).
//
// This is NecroFall's DEFAULT WORLD MATERIAL FAMILY (plan §2). Everything environmental uses it
// or extends it: terrain, foliage, trees, bushes, flowers, scenery and water. It is a
// `MeshLambertNodeMaterial` shaded entirely by the shared Folio uniforms — three's lights are
// only present for shadow maps.
//
// Preserved Folio concepts: hasCoreShadows, hasDropShadows, hasLightBounce, hasFog, hasWater,
// hasReveal, alphaTest, receivedShadowNode, outputNode.
//
// Planet adaptations (documented per site):
//   - "reveal" is a growing spherical cap (angular distance) instead of a flat XZ circle;
//   - "water proximity" is measured along the radial, since the sea sits at a constant radius;
//   - the light bounce samples a caller-provided colour node (the terrain material passes its
//     own palette so the bounce matches the ground the world actually has).
import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  frontFacing,
  If,
  max,
  mix,
  normalWorld,
  positionWorld,
  vec3,
  vec4,
} from 'three/tsl';
import { FOLIO } from '../FolioShaderGlobals';

/** Node-typed parameters are intentionally loose: TSL's node types are enormous and structural. */
export interface MeshDefaultMaterialParameters {
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
  hasWater?: boolean;
  hasReveal?: boolean;
  /** Base albedo. Defaults to white. */
  colorNode?: any;
  /** World-space normal. Defaults to the geometry normal. */
  normalNode?: any;
  /** Visibility term `[0..1]`; faded by the `alphaTest` discard. */
  alphaNode?: any;
  /** Extra shadow amount (0 = lit, 1 = fully shadowed) added to the shadow mix. */
  shadowNode?: any;
  /** Called before the shadow mix; Foliage uses it to mask shadows out of leaf gaps. */
  maskShadowNode?: any;
  /** Where the drop-shadow is sampled (offset for thin geometry). */
  receivedShadowPositionNode?: any;
  /** Colour the light bounce mixes towards; defaults to the shared bounce colour. */
  bounceColorNode?: any;
  /** Added AFTER lighting/shadow but before fog — self-glow (veins, crystals, energy). */
  emissiveNode?: any;
  alphaTest?: number;
  /** Marks a shadow catcher that must not double-shade. */
  isShadowCatcher?: boolean;
}

export class MeshDefaultMaterial extends THREE.MeshLambertNodeMaterial {
  /** Reveal mix helper — shared so other materials (water) can reuse the exact same treatment. */
  static revealDiscardNodeBuilder(outputColor: any): any {
    return Fn(([outputColorNode]: any[]) => {
      // Angular distance from the reveal centre: a spherical cap growing over the planet.
      const centerDot = positionWorld
        .normalize()
        .dot(FOLIO.reveal.position)
        .clamp(-1, 1);
      const distanceToCenter = centerDot.acos().mul(FOLIO.planetRadius);

      distanceToCenter.greaterThan(FOLIO.reveal.distance).discard();

      const revealMix = distanceToCenter.step(FOLIO.reveal.distance.sub(FOLIO.reveal.thickness));
      const revealColor = FOLIO.reveal.color.mul(FOLIO.reveal.intensity);
      return mix(outputColorNode.rgb, revealColor, revealMix);
    })(outputColor);
  }

  hasCoreShadows: boolean;
  hasDropShadows: boolean;
  hasLightBounce: boolean;
  hasFog: boolean;
  hasWater: boolean;
  hasReveal: boolean;

  private _colorNode: any;
  private _normalNode: any;
  private _alphaNode: any;
  private _shadowNode: any;

  constructor(parameters: MeshDefaultMaterialParameters = {}) {
    super();

    this.depthWrite = parameters.depthWrite ?? true;
    this.depthTest = parameters.depthTest ?? true;
    this.side = parameters.side ?? THREE.FrontSide;
    this.wireframe = parameters.wireframe ?? false;
    this.transparent = parameters.transparent ?? false;
    this.shadowSide = parameters.shadowSide ?? THREE.FrontSide;

    this.hasCoreShadows = parameters.hasCoreShadows ?? true;
    this.hasDropShadows = parameters.hasDropShadows ?? true;
    this.hasLightBounce = parameters.hasLightBounce ?? true;
    this.hasFog = parameters.hasFog ?? true;
    this.hasWater = parameters.hasWater ?? true;
    this.hasReveal = parameters.hasReveal ?? true;

    this._colorNode = parameters.colorNode ?? color(0xffffff);
    this._normalNode = parameters.normalNode ?? normalWorld;
    this._alphaNode = parameters.alphaNode ?? float(1);
    this._shadowNode = parameters.shadowNode ?? float(0);
    this.alphaTest = parameters.alphaTest ?? 0.1;

    // Get rid of three's "Material.normalNode conflict" warning.
    this.normalNode = this._normalNode;

    if (typeof parameters.receivedShadowPositionNode !== 'undefined') {
      (this as any).receivedShadowPositionNode = parameters.receivedShadowPositionNode;
    }

    /**
     * Shadow catcher: Folio catches the received shadow as a float and removes it from the
     * initial pipeline, so the shadow colour can be controlled by the shared lighting state.
     */
    const catchedShadow = float(1).toVar();

    if (this.hasDropShadows) {
      (this as any).receivedShadowNode = Fn(([shadow]: any[]) => {
        catchedShadow.mulAssign(shadow.r);
        return float(1);
      });
    }

    const bounceColorNode = parameters.bounceColorNode ?? FOLIO.lighting.bounceColor;

    /**
     * Output node — the whole shading model, exactly like Folio's.
     */
    this.outputNode = Fn(() => {
      const baseColor = (this._colorNode as any).toVar();
      const outputColor = (this._colorNode as any).toVar();

      // Normal orientation
      const reorientedNormal = this._normalNode.toVar();
      if (this.side === THREE.DoubleSide || this.side === THREE.BackSide) {
        If(frontFacing.not(), () => {
          reorientedNormal.mulAssign(-1);
        });
      }

      // Light bounce: undersides pick up the colour of the ground below them.
      if (this.hasLightBounce) {
        const radialUp = positionWorld.normalize();
        const bounceOrientation = reorientedNormal
          .dot(radialUp.negate())
          .smoothstep(FOLIO.lighting.lightBounceEdgeLow, FOLIO.lighting.lightBounceEdgeHigh);
        // Distance above the planet's surface, mapped like Folio's flat-world height falloff.
        const aboveSurface = positionWorld
          .length()
          .sub(FOLIO.planetRadius)
          .max(0);
        const bounceDistance = FOLIO.lighting.lightBounceDistance
          .sub(aboveSurface)
          .div(FOLIO.lighting.lightBounceDistance)
          .max(0)
          .pow(2);
        outputColor.assign(
          mix(
            outputColor,
            bounceColorNode,
            bounceOrientation.mul(bounceDistance).mul(FOLIO.lighting.lightBounceMultiplier),
          ),
        );
      }

      // Water: geometry close to the sea level gets Folio's "wet/foam" wash.
      if (this.hasWater) {
        const radialDistance = positionWorld.length();
        const nearWaterSurface = radialDistance
          .sub(FOLIO.planetRadius.add(FOLIO.water.surfaceElevation))
          .abs()
          .greaterThan(FOLIO.water.surfaceThickness);
        outputColor.assign(nearWaterSurface.select(outputColor, color('#ffffff')));
        baseColor.assign(nearWaterSurface.select(baseColor, color('#ffffff')));
      }

      // Sun light (colour × intensity; directional falloff is the core-shadow term below).
      outputColor.mulAssign(FOLIO.lighting.color.mul(FOLIO.lighting.intensity));

      // Core shadow: the terminator between lit and unlit faces.
      let coreShadowMix: any = float(0);
      if (this.hasCoreShadows) {
        coreShadowMix = reorientedNormal
          .dot(FOLIO.lighting.direction)
          .smoothstep(FOLIO.lighting.coreShadowEdgeHigh, FOLIO.lighting.coreShadowEdgeLow);
      }

      // Cast shadow from the shadow map.
      let dropShadowMix: any = float(0);
      if (this.hasDropShadows) {
        dropShadowMix = catchedShadow.oneMinus();
      }

      // Combined shadows — raised into the shadow colour, never to pure black.
      if (this.hasCoreShadows || this.hasDropShadows) {
        let combinedShadowMix: any = max(coreShadowMix, dropShadowMix, this._shadowNode).clamp(0, 1);
        if (parameters.maskShadowNode) {
          combinedShadowMix = combinedShadowMix.mul(parameters.maskShadowNode);
        }

        const shadowColor = baseColor.rgb.mul(FOLIO.lighting.shadowColor).rgb;
        outputColor.assign(mix(outputColor, shadowColor, combinedShadowMix));
      }

      // Emissive: NecroFall's extension — veins/crystals/energy add light of their own. Sits
      // after the lighting term (it is not shaded) but before fog (distance still damps it).
      if (parameters.emissiveNode) {
        outputColor.addAssign(parameters.emissiveNode);
      }

      // Distance fog, exponential-squared like NecroFall's GLSL atmosphere.
      if (this.hasFog) {
        const distance = positionWorld.sub(FOLIO.cameraPosition).length();
        const fogStrength = distance
          .mul(FOLIO.fog.density)
          .pow(2)
          .negate()
          .exp()
          .oneMinus()
          .clamp(0, 1);
        outputColor.assign(fogStrength.mix(outputColor, FOLIO.fog.color));
      }

      // Alpha test discard.
      this._alphaNode.lessThan(this.alphaTest).discard();

      // Reveal (intro wash).
      if (this.hasReveal) {
        outputColor.assign(MeshDefaultMaterial.revealDiscardNodeBuilder(outputColor));
      }

      return vec4(outputColor, this._alphaNode);
    })();
  }

  /** Swap the albedo after construction (used by LOD/quality switches). */
  set colorNode(node: any) {
    this._colorNode = node;
    this.needsUpdate = true;
  }

  get colorNode(): any {
    return this._colorNode;
  }

  /** The alpha node as constructed (water reads it to build its blurred output). */
  get alphaNodeRef(): any {
    return this._alphaNode;
  }
}
