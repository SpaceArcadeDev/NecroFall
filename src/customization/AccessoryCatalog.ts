// NECROFALL — the accessory catalog: hats, backpacks, pets AND the three one-shot EFFECT
// categories (recall / spawn / eliminated), in the order the customize screen lists them. Indices
// are part of the wire format (peers send slot indices), but the SAVED selection is by id
// (CustomizationStore), so appending models is always safe and reordering only affects live
// sessions of the same build.
import { AccessoryCategory, AccessoryDef } from './AccessoryTypes';
import { HATS } from './HatModels';
import { BACKPACKS } from './BackpackModels';
import { PETS } from './PetModels';
import { RECALL_EFFECTS } from './RecallEffects';
import { SPAWN_EFFECTS } from './SpawnEffects';
import { ELIMINATE_EFFECTS } from './EliminateEffects';

export const CATEGORY_ORDER: AccessoryCategory[] = ['hat', 'backpack', 'pet', 'recall', 'spawn', 'eliminated'];

export const CATEGORY_LABELS: Record<AccessoryCategory, string> = {
  hat: 'HATS',
  backpack: 'BACKPACKS',
  pet: 'PETS',
  recall: 'RECALL',
  spawn: 'SPAWN',
  eliminated: 'ELIMINATED',
};

/** One-glance names for the caption under the avatar (the tabs afford the full words). */
export const CATEGORY_SHORT: Record<AccessoryCategory, string> = {
  hat: 'HAT',
  backpack: 'PACK',
  pet: 'PET',
  recall: 'RECALL',
  spawn: 'SPAWN',
  eliminated: 'FINISH',
};

export const CATEGORY_HINTS: Record<AccessoryCategory, string> = {
  hat: 'Worn on the head — some cover it completely.',
  backpack: 'Strapped to your back, with their own sparks and motion.',
  pet: 'A small companion that follows you into the fight.',
  recall: 'Plays while you channel a recall, and at both ends when it lands.',
  spawn: 'Plays when you enter the match and every time you respawn.',
  eliminated: 'Plays where you are killed — the whole match sees it.',
};

export function defsOf(cat: AccessoryCategory): AccessoryDef[] {
  switch (cat) {
    case 'hat': return HATS;
    case 'backpack': return BACKPACKS;
    case 'pet': return PETS;
    case 'recall': return RECALL_EFFECTS;
    case 'spawn': return SPAWN_EFFECTS;
    case 'eliminated': return ELIMINATE_EFFECTS;
  }
}

export function defAt(cat: AccessoryCategory, idx: number): AccessoryDef | null {
  const list = defsOf(cat);
  return idx >= 0 && idx < list.length ? list[idx] : null;
}

export function indexOfId(cat: AccessoryCategory, id: unknown): number {
  if (typeof id !== 'string' || !id) return -1;
  return defsOf(cat).findIndex(d => d.id === id);
}
