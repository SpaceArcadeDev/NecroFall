/**
 * NECROFALL — the rendering/gameplay boundary (plan §1).
 *
 * Rendering NEVER owns authoritative gameplay state: gameplay systems push
 * their state through this interface, the world reads it. The dev world only
 * fills `player`; the full match integration (enemies, effects) plugs in at
 * cutover without touching the renderer.
 */
import * as THREE from 'three/webgpu';

export interface RenderState {
  player: {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    /** Surface "up" at the player (radial direction). */
    up: THREE.Vector3;
  };

  enemies: readonly {
    id: string;
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: number;
    type: string;
    visible: boolean;
  }[];

  effects: readonly {
    type: string;
    position: THREE.Vector3;
    intensity: number;
    lifetime: number;
  }[];
}

export function createRenderState(): RenderState {
  return {
    player: {
      position: new THREE.Vector3(0, 1, 0),
      velocity: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
    },
    enemies: [],
    effects: [],
  };
}
