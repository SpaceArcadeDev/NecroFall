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
import { RenderDebug, type MaterialDebugMode } from '../RenderDebug';

/** Lawn glow (see `lawnGlow`): fraction of the local vegetation colour spilled on to the
 *  surfaces around the glowing blades. Faint by design — the blades' OWN glow (Grass) stays
 *  the brightest thing in the dark lawn. */
const LAWN_GLOW_STRENGTH = 0.75;
/** Metres above the ground where the lawn glow has faded out completely (nothing in orbit
 *  should catch light from the lawn). */
const LAWN_GLOW_REACH = 7;

export interface MeshDefaultMaterialParameters {
  colorNode?: any;
  normalNode?: any;
  alphaNode?: any;
  shadowNode?: any;
  /**
   * Emission added AFTER lighting and shadows (like a lamp): it survives the dark side and is
   * scaled up where the surface sits in shade — grass uses it for glowing night-side tips.
   */
  glowNode?: any;
  /**
   * The reciprocal of `glowNode` (user ask 2026-10-02): the night-side grass glow must also read
   * as light spilled on to the area AROUND the blades — the ground under them and the props
   * standing in the lawn. Those surfaces sample the vegetation channel at the terrain under them
   * and lift by a faint fraction of that spot's palette colour (REAL darkness only, faded with
   * height above ground). Default ON for every environment surface; the grass blades themselves
   * opt OUT with `lawnGlow: false` (their own glow is already the tuned look).
   */
  lawnGlow?: boolean;
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
  /**
   * DoubleSide backface normal flip. True (default) for surfaces whose back sides should shade
   * like a solid object (props, terrain viewed from inside). Blade-style foliage sets FALSE:
   * a grass blade is a one-sided card, its normal is the surface radial, and flipping it for the
   * half of the blades that face away made entire clumps render as black core-shadow spikes.
   */
  flipBackfaceNormal?: boolean;
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
  private readonly flipBackfaceNormal: boolean;
  private readonly lawnGlow: boolean;
  /** Baked material debug mode (`?render=unlit`…, plan §10/§45) — read once, zero cost per frame. */
  private readonly debugMode: MaterialDebugMode;

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
    this.flipBackfaceNormal = parameters.flipBackfaceNormal ?? true;
    this.wireframe = parameters.wireframe ?? false;
    this.transparent = parameters.transparent ?? false;
    this.shadowSide = parameters.shadowSide ?? THREE.FrontSide;

    this.hasCoreShadows = parameters.hasCoreShadows ?? true;
    this.hasDropShadows = parameters.hasDropShadows ?? true;
    this.hasLightBounce = parameters.hasLightBounce ?? true;
    this.hasFog = parameters.hasFog ?? true;
    this.hasWater = parameters.hasWater ?? false;
    this.lawnGlow = parameters.lawnGlow ?? true;
    this.debugMode = RenderDebug.materialMode;
    // The material owns its fog through WorldGlobals.fog (plan §24). Disable the automatic
    // scene-fog hookup: a legacy THREE.FogExp2 on the scene would otherwise DOUBLE-fog every
    // folio material (three appends the scene fog to any material whose `fog` flag is true).
    this.fog = false;

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
      if (
        this.flipBackfaceNormal &&
        (this.sourceSide === THREE.DoubleSide || this.sourceSide === THREE.BackSide)
      ) {
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
        // GLSL allowed reversed-edge smoothstep; WGSL defines it only for ascending edges
        // (Tint evaluated the reversed form to 1 for lit normals — every surface went black).
        // The equivalent, portal-safe form is `1 - smoothstep(low, high, x)`.
        coreShadowMix = reorientedNormal
          .dot(directionNode)
          .smoothstep(coreShadowEdgeLow, coreShadowEdgeHigh)
          .oneMinus();
      }

      // ---- cast / drop shadow
      let dropShadowMix: any = float(0);
      if (this.hasDropShadows) {
        dropShadowMix = catchedShadow.oneMinus();
      }

      let shadowMixValue: any = null;
      let combinedShadowMix: any = null;
      if (this.hasCoreShadows || this.hasDropShadows) {
        combinedShadowMix = max(coreShadowMix, dropShadowMix, shadowNode).clamp(0, 1);
        if (this.debugMode === 'shadow') {
          // Component breakdown: R = core shadow, G = drop shadow, B = material root shade.
          shadowMixValue = vec3(coreShadowMix as any, dropShadowMix as any, shadowNode as any);
        } else if (this.debugMode !== 'lighting') {
          const shadedColor = baseColor.rgb.mul(shadowColorNode);
          outputColor.assign(mix(outputColor, shadedColor, combinedShadowMix));
        }
      }

      // ---- glow (tonal freedom after the shadow stack): the term rides on TOP of lighting, and
      // shade multiplies it UP — a dark-side surface glows at full strength while lit lawn keeps
      // its own colours (the 0.10 floor).
      if (parameters.glowNode) {
        // Keyed to REAL shadow only (sun-facing shade + cast shadow — NOT the decorative root
        // shade), squared for contrast: lit/twilight lawn stays exactly as before and the glow
        // fades in only through genuine darkness. The first pass added light across dim lawn and
        // washed it out (user report 2026-10-01).
        const shade = max(coreShadowMix, dropShadowMix).clamp(0, 1);
        const darkness = mix(float(0.1), float(1.0), (shade as any).mul(shade));
        outputColor.addAssign((parameters.glowNode as any).mul(darkness));
      }

      // ---- lawn glow bounce (user ask 2026-10-02): the night-side grass tips glow (the material
      // `glowNode` above), and this is their reciprocal — the light those tips would spill on to
      // the ground around them and the props standing in the lawn. There is no real light to
      // bounce (the blades are emissive cards), so every receiving surface samples the vegetation
      // channel at the terrain UNDER it and lifts by a faint fraction of that spot's palette
      // colour. Gated to REAL darkness exactly like the blade glow (a lit lawn stays untouched),
      // squared for the same contrast, and faded out with height above ground.
      if (this.lawnGlow && terrain) {
        const upDirection = positionWorld.normalize();
        const lawnData = terrain.terrainNode(upDirection) as any;
        const lawnRadius = terrain.heightMeters((lawnData as any).x).add(globals.radius);
        const aboveGround = positionWorld.length().sub(lawnRadius);
        const reach = float(1)
          .sub(aboveGround.max(0).div(LAWN_GLOW_REACH))
          .max(0)
          .pow(2);
        const shade = max(coreShadowMix, dropShadowMix).clamp(0, 1);
        const darkness = mix(float(0.1), float(1.0), (shade as any).mul(shade));
        outputColor.addAssign(
          (terrain.colorNode(lawnData) as any)
            .mul((lawnData as any).y)
            .mul(LAWN_GLOW_STRENGTH)
            .mul((reach as any).mul(darkness)),
        );
      }

      // ---- fog (skipped in every isolated debug mode; the `fog` mode renders the factor itself)
      const fogVisible =
        this.debugMode === 'normal' || this.debugMode === 'lighting';
      if (this.hasFog && fog && fogVisible) {
        outputColor.assign(mix(outputColor, fog.color, fog.strength));
      }

      // ---- material debug override (plan §10) — built once, no per-frame cost
      switch (this.debugMode) {
        case 'unlit':
          outputColor.assign(baseColor);
          break;
        case 'normals':
          outputColor.assign(reorientedNormal.mul(0.5).add(0.5));
          break;
        case 'lighting':
          break; // direct light with the shadow mix already skipped above
        case 'shadow': {
          const value = (shadowMixValue ?? vec3(0, 0, 0)) as any;
          outputColor.assign(value);
          break;
        }
        case 'dot': {
          // Raw `dot(surface normal, sun)` — 0.5 gray is perpendicular, white toward the sun.
          const value = ((reorientedNormal.dot(directionNode) as any).mul(0.5).add(0.5)) as any;
          outputColor.assign(vec3(value, value, value));
          break;
        }
        case 'core': {
          const value = coreShadowMix as any;
          outputColor.assign(vec3(value, value, value));
          break;
        }
        case 'dir': {
          // The fragment direction from the planet centre — blades must match the ground under them.
          const value = ((positionWorld.normalize() as any).mul(0.5).add(0.5)) as any;
          outputColor.assign(vec3(value.x, value.y, value.z));
          break;
        }
        case 'terrain': {
          // Raw baked data: R height01 · G grass · B wetness · A radiation (A shown as red here).
          if (terrain) {
            const data = terrain.terrainNode(positionWorld) as any;
            outputColor.assign(vec3(data.x, data.y, data.z));
          } else {
            outputColor.assign(vec3(0.1, 0.1, 0.1));
          }
          break;
        }
        case 'biome': {
          if (terrain) {
            const channel = terrain.terrainNode(positionWorld).y;
            outputColor.assign(vec3(channel, channel, channel));
          } else {
            outputColor.assign(vec3(0.5, 0, 0.5));
          }
          break;
        }
        case 'slope': {
          const slope = float(1).sub(reorientedNormal.dot(positionWorld.normalize() as any)).clamp(0, 1);
          outputColor.assign(vec3(slope, slope, slope));
          break;
        }
        case 'height': {
          if (terrain) {
            const channel = terrain.terrainNode(positionWorld).x;
            outputColor.assign(vec3(channel, channel, channel));
          } else {
            outputColor.assign(vec3(0.2, 0.2, 0.2));
          }
          break;
        }
        case 'fog': {
          const strength = (fog ? fog.strength : float(0)) as any;
          outputColor.assign(vec3(strength, strength, strength));
          break;
        }
        default:
          break;
      }

      // ---- alpha discard
      alphaNode.lessThan(this.alphaTest).discard();

      return vec4(outputColor, alphaNode);
    })() as any);
  }
}
