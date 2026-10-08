import { Vector2 } from 'three/webgpu';
import { cameraPosition, float, positionWorld, screenSize, screenUV, uniform, vec2 } from 'three/tsl';
import { dotDissolve } from '../Environment/DotDissolve';

export const playerScreen = uniform(new Vector2(0.5, 0.5));
export const playerDistance = uniform(0);

export function playerOcclusionNode(): any {
  const offset = screenUV.sub(playerScreen).mul(vec2(screenSize.x.div(screenSize.y), 1));
  const dots = dotDissolve(offset.length().smoothstep(0.055, 0.19));
  return positionWorld.sub(cameraPosition).length().lessThan(playerDistance.sub(0.25)).select(dots, float(1));
}