/**
 * NECROFALL — cheap depth-of-field pass (folio `Passes/cheapDOF.js` port).
 *
 * A screen-space hash blur driven by vertical distance from the frame centre —
 * the folio look. Level 0 only (plan §36: exactly one output chain).
 */
import { TempNode } from 'three/webgpu';
import { nodeObject, Fn, uv, uniform, convertToTexture, mix, smoothstep } from 'three/tsl';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';

class CheapDOFNode extends TempNode {
  static get type(): string {
    return 'CheapDOFNode';
  }

  textureNode: any;
  size: any;
  separation: any;
  start: any;
  end: any;
  repeats: any;
  amount: any;

  constructor(textureNode: any) {
    super('vec4' as any);
    this.textureNode = textureNode;
    this.size = uniform(2);
    this.separation = uniform(1.25);
    this.start = uniform(0.2);
    this.end = uniform(0.5);
    this.repeats = uniform(25);
    this.amount = uniform(0.003);
  }

  setup(): any {
    return Fn(() => {
      const strength = smoothstep(this.start, this.end, uv().y.sub(0.5).abs());
      const blurOutput = (hashBlur as any)(this.textureNode, strength.mul(this.amount), {
        repeats: this.repeats,
        premultipliedAlpha: true,
      });
      return mix(this.textureNode, blurOutput, strength);
    })();
  }
}

export default CheapDOFNode;

export const cheapDOF = (node: any): any => nodeObject(new CheapDOFNode(convertToTexture(node)));
