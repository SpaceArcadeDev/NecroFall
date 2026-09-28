// NECROFALL — accessory persistence. The selection is stored in the browser (localStorage), keyed
// by accessory ID rather than index, so reordering or adding models never re-dresses the player.
// It covers the three WORN slots plus the three TRIGGERED effect slots (recall / spawn /
// eliminated) — one blob, one wire string, one save path.
import { AccessoryCategory, AccessorySelection, EMPTY_SELECTION } from './AccessoryTypes';
import { defsOf, indexOfId, defAt } from './AccessoryCatalog';

const KEY = 'necrofall.accessories';

type StoredSlot = string | null | undefined;

/** Every saved slot, in wire order. */
const SLOT_KEYS: AccessoryCategory[] = ['hat', 'backpack', 'pet', 'recall', 'spawn', 'eliminated'];

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
      recall: indexOfId('recall', data.recall),
      spawn: indexOfId('spawn', data.spawn),
      eliminated: indexOfId('eliminated', data.eliminated),
    };
  } catch {
    return { ...EMPTY_SELECTION };
  }
}

export function saveSelection(sel: AccessorySelection): void {
  try {
    const out: Partial<Record<AccessoryCategory, StoredSlot>> = {};
    for (const cat of SLOT_KEYS) out[cat] = defAt(cat, sel[cat])?.id ?? null;
    window.localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* storage disabled (private mode) — the session still works, it just will not persist */
  }
}

/** Compact wire form: "hatIdx,backpackIdx,petIdx,recallIdx,spawnIdx,elimIdx" (-1 = none). */
export function selectionToWire(sel: AccessorySelection): string {
  return `${sel.hat},${sel.backpack},${sel.pet},${sel.recall},${sel.spawn},${sel.eliminated}`;
}

/** Parses a wire selection, clamping to the catalogs of THIS build. Null when malformed. */
export function selectionFromWire(raw: unknown): AccessorySelection | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 48) return null;
  const parts = raw.split(',');
  // 6 parts = the full form this build sends. 3 parts = a legacy worn-only wire (an older build
  // in the same room): the effect slots simply resolve to "none" instead of dropping the outfit.
  if (parts.length !== 3 && parts.length !== 6) return null;
  const idx: number[] = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    idx.push(n);
  }
  const one = (cat: AccessoryCategory, v: number | undefined): number =>
    v !== undefined && v >= -1 && v < defsOf(cat).length ? v : -1;
  return {
    hat: one('hat', idx[0]),
    backpack: one('backpack', idx[1]),
    pet: one('pet', idx[2]),
    recall: one('recall', idx[3]),
    spawn: one('spawn', idx[4]),
    eliminated: one('eliminated', idx[5]),
  };
}
