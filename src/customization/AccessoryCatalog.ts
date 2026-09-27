// NECROFALL — the accessory catalog: hats, backpacks and pets, in the order the customize screen
// lists them. Indices are part of the wire format (peers send slot indices), but the SAVED
// selection is by id (CustomizationStore), so appending models is always safe and reordering only
// affects live sessions of the same build.
import { AccessoryCategory, AccessoryDef } from './AccessoryTypes';
import { HATS } from './HatModels';
import { BACKPACKS } from './BackpackModels';
import { PETS } from './PetModels';

export const CATEGORY_ORDER: AccessoryCategory[] = ['hat', 'backpack', 'pet'];

export const CATEGORY_LABELS: Record<AccessoryCategory, string> = {
  hat: 'HATS',
  backpack: 'BACKPACKS',
  pet: 'PETS',
};

export const CATEGORY_HINTS: Record<AccessoryCategory, string> = {
  hat: 'Worn on the head — some cover it completely.',
  backpack: 'Strapped to your back, with their own sparks and motion.',
  pet: 'A small companion that follows you into the fight.',
};

export function defsOf(cat: AccessoryCategory): AccessoryDef[] {
  switch (cat) {
    case 'hat': return HATS;
    case 'backpack': return BACKPACKS;
    case 'pet': return PETS;
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
