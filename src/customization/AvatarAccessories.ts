// NECROFALL — the accessory rig: the three slots (hat / backpack / pet) on ONE avatar. The same
// class dresses the player in a match AND the figure on the customize screen, so what the menu
// shows is exactly what everyone sees in game.
import * as THREE from 'three';
import { AccessoryBuild, AccessorySelection, EMPTY_SELECTION, sameSelection } from './AccessoryTypes';
import { defAt } from './AccessoryCatalog';
import { PetController } from './PetSystem';

/** Disposes every geometry/material under `root` (each builder owns its own — never shared). */
export function disposeObject(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((mesh as THREE.SkinnedMesh).skeleton);
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const one of mat) one.dispose();
    else if (mat) mat.dispose();
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

function dropBuild(build: AccessoryBuild | null): void {
  if (!build) return;
  build.group.removeFromParent();
  disposeObject(build.group);
  build.dispose?.();
}

export class AvatarAccessories {
  /** The selection currently WORN (index into HATS/BACKPACKS/PETS, -1 = none). */
  selection: AccessorySelection = { ...EMPTY_SELECTION };

  private hat: AccessoryBuild | null = null;
  private back: AccessoryBuild | null = null;
  private pet: PetController | null = null;
  private hatIdx = -2;
  private backIdx = -2;
  private petIdx = -2;

  constructor(
    private headMount: THREE.Object3D,
    private backMount: THREE.Object3D,
    private defaultPack: THREE.Object3D | null,
    private scene: THREE.Scene
  ) {}

  /** The pet controller, or null when no pet is worn (the owner drives its update). */
  get petCtl(): PetController | null {
    return this.pet;
  }

  /** Swaps in a new selection, rebuilding only the slots that actually changed. */
  set(sel: AccessorySelection, force = false): void {
    if (!force && sameSelection(this.selection, sel)) return;
    this.selection = { ...sel };
    this.applyHat(force);
    this.applyBack(force);
    this.applyPet(force);
  }

  private applyHat(force: boolean): void {
    if (!force && this.hatIdx === this.selection.hat) return;
    this.hatIdx = this.selection.hat;
    dropBuild(this.hat);
    this.hat = null;
    const def = defAt('hat', this.hatIdx);
    if (!def) return;
    this.hat = def.build();
    this.hat.group.scale.setScalar(def.scale ?? 1);
    this.headMount.add(this.hat.group);
  }

  private applyBack(force: boolean): void {
    if (!force && this.backIdx === this.selection.backpack) return;
    this.backIdx = this.selection.backpack;
    dropBuild(this.back);
    this.back = null;
    const def = defAt('backpack', this.backIdx);
    if (def) {
      this.back = def.build();
      // big silhouettes (wings, tentacles) carry their own size — set per item, never shared
      this.back.group.scale.setScalar(def.scale ?? 1);
      this.backMount.add(this.back.group);
    }
    // the factory body ships with a plain pack box: a real backpack replaces it
    if (this.defaultPack) this.defaultPack.visible = !def;
  }

  private applyPet(force: boolean): void {
    if (!force && this.petIdx === this.selection.pet) return;
    this.petIdx = this.selection.pet;
    if (this.pet) {
      this.scene.remove(this.pet.group);
      const old = this.pet;
      this.pet = null;
      old.dispose();
      disposeObject(old.group);
    }
    const def = defAt('pet', this.petIdx);
    if (!def || !def.motion) return;
    const build = def.build();
    // pets are authored at toy size so their proportions stay exact; the scale brings them up to
    // "clearly visible beside a 1.9 m player" without touching every builder
    build.group.scale.setScalar(def.scale ?? 1);
    this.pet = new PetController(build, def.motion);
    this.scene.add(this.pet.group);
  }

  /**
   * Per-frame animation for the worn hat and backpack. `hSpeed` is the owner's horizontal speed —
   * builders that react to running (jetpack flames, a fluttering banner) read it from userData.
   */
  tick(t: number, dt: number, hSpeed: number): void {
    if (this.back) {
      this.back.group.userData.hSpeed = hSpeed;
      this.back.tick?.(t, dt);
    }
    this.hat?.tick?.(t, dt);
  }

  dispose(): void {
    dropBuild(this.hat);
    dropBuild(this.back);
    this.hat = null;
    this.back = null;
    this.hatIdx = -2;
    this.backIdx = -2;
    if (this.pet) {
      this.scene.remove(this.pet.group);
      const old = this.pet;
      this.pet = null;
      old.dispose();
      disposeObject(old.group);
    }
    this.petIdx = -2;
  }
}
