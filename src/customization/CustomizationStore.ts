// NECROFALL — accessory persistence. The selection is stored in the browser (localStorage), keyed
// by accessory ID rather than index, so reordering or adding models never re-dresses the player.
import { AccessoryCategory, AccessorySelection, EMPTY_SELECTION } from './AccessoryTypes';
import { defsOf, indexOfId, defAt } from './AccessoryCatalog';

const KEY = 'necrofall.accessories';

type StoredSlot = string | null | undefined;

/** Loads the saved selection (unknown/removed ids resolve to "none"). */
export function loadSelection(): AccessorySelection {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_SELECTION };
    const data = JSON.parse(raw) as Partial<Record<AccessoryCategory, StoredSlot>>;
    return {
      hat: indexOfId('hat', data.hat),
      backpack: indexOfId('backpack', data.backpack),
      pet: indexOfId('pet', data.pet),
    };
  } catch {
    return { ...EMPTY_SELECTION };
  }
}

export function saveSelection(sel: AccessorySelection): void {
  try {
    const out: Record<AccessoryCategory, StoredSlot> = {
      hat: defAt('hat', sel.hat)?.id ?? null,
      backpack: defAt('backpack', sel.backpack)?.id ?? null,
      pet: defAt('pet', sel.pet)?.id ?? null,
    };
    window.localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* storage disabled (private mode) — the session still works, it just will not persist */
  }
}

/** Compact wire form: "hatIdx,backpackIdx,petIdx" (comma-separated, -1 = none). */
export function selectionToWire(sel: AccessorySelection): string {
  return `${sel.hat},${sel.backpack},${sel.pet}`;
}

/** Parses a wire selection, clamping to the catalogs of THIS build. Null when malformed. */
export function selectionFromWire(raw: unknown): AccessorySelection | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 24) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  const idx: number[] = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    idx.push(n);
  }
  if (idx[0] < -1 || idx[1] < -1 || idx[2] < -1) return null;
  return {
    hat: idx[0] < defsOf('hat').length ? idx[0] : -1,
    backpack: idx[1] < defsOf('backpack').length ? idx[1] : -1,
    pet: idx[2] < defsOf('pet').length ? idx[2] : -1,
  };
}
