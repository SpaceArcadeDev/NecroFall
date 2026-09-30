// NECROFALL — cheap DOF (plan §6, §36): Folio's cheapDOF.js ported 1:1 to TypeScript.
//
// A screen-space "cinematic edge" blur: the blur strength grows towards the top and bottom of the
// frame (a smoothstep on UV.y), using a hash blur at a fixed repeat count. It is the second (and
// only other) pass of the post chain, next to bloom — Folio's exact look.
import { TempNode } from 'three/webgpu';
import { nodeObject, Fn, uv, uniform, convertToTexture, mix } from 'three/tsl';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';

class CheapDOFNode extends TempNode {
  static get type(): string {
    return 'CheapDOFNode';
  }

  readonly textureNode: any;
  readonly size = uniform(2);
  readonly separation = uniform(1.25);
  readonly start = uniform(0.2);
  readonly end = uniform(0.5);
  readonly repeats = uniform(25);
  readonly amount = uniform(0.003);

  constructor(textureNode: any) {
    super('vec4');
    this.textureNode = textureNode;
  }

  setup(): any {
    const outputNode = Fn(() => {
      // Strength: 0 across the middle band of the screen, rising towards top and bottom edges.
      const strength = (uv().y.sub(0.5) as any).abs().smoothstep(this.start, this.end);

      const blurOutput = hashBlur(this.textureNode, strength.mul(this.amount), {
        repeats: this.repeats,
        premultipliedAlpha: true,
      } as any);

      return mix(this.textureNode, blurOutput, strength);
    })();

    return outputNode;
  }
}

export default CheapDOFNode;

export const cheapDOF = (node: any): any => nodeObject(new CheapDOFNode(convertToTexture(node)));
