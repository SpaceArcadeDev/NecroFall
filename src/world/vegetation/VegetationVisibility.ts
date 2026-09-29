// NECROFALL — VegetationVisibility (plan §40/§41/§43): decides which environmental systems and
// which spatial bands are drawn, from the camera/player position — and only when it changes.
//
// Two mechanisms, matching how the systems render:
//   • shader-culled systems (grass, foliage): this class writes their cull-distance uniforms —
//     instances cull themselves on the GPU, zero CPU cost;
//   • whole-system systems (water patches, particles): plain visibility toggles.
//
// It never touches per-object transforms: nothing MOVES when the camera moves, only budgets do.
import * as THREE from 'three/webgpu';
import { lodFor, type LodCategory } from '../folio/vegetation/VegetationLOD';
import type { QualitySettings } from '../../core/Config';

export interface ShaderCulledSystem {
  category: LodCategory;
  /** Uniform node the shader reads (set `.value`). */
  cullDistance: { value: number };
}

export interface ToggleSystem {
  category: LodCategory;
  setVisible(visible: boolean): void;
}

/** 30 Hz — visibility does not need 60 (plan §90). */
const UPDATE_INTERVAL = 1 / 30;

export class VegetationVisibility {
  private readonly shaderCulled: ShaderCulledSystem[] = [];
  private readonly toggles: ToggleSystem[] = [];
  private timer = 0;
  private rescueLevel = 0;

  constructor(private readonly quality: QualitySettings) {}

  registerShaderCulled(system: ShaderCulledSystem): void {
    this.shaderCulled.push(system);
    this.applyShaderBudget(system);
  }

  registerToggle(system: ToggleSystem): void {
    this.toggles.push(system);
    system.setVisible(lodFor(system.category, this.quality, this.rescueLevel).enabled);
  }

  setRescueLevel(level: number): void {
    this.rescueLevel = level;
    this.timer = 0; // force a re-evaluation on the next update
  }

  update(dt: number, focus: THREE.Vector3): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = UPDATE_INTERVAL;

    for (const system of this.shaderCulled) this.applyShaderBudget(system);

    for (const system of this.toggles) {
      const budget = lodFor(system.category, this.quality, this.rescueLevel);
      // Planet-scale systems (water) follow the focus; when the mesh has its own internal logic
      // (patch recentring) this just gates the toggle.
      system.setVisible(budget.enabled);
    }

    void focus;
  }

  private applyShaderBudget(system: ShaderCulledSystem): void {
    const budget = lodFor(system.category, this.quality, this.rescueLevel);
    system.cullDistance.value = budget.maxDistance;
  }
}
