// NECROFALL — inline SVG weapon/class icons for the Necrotech roster.
// Original simple line art, one per Necrotech, plus a fusion icon for mutations.
import type { NecrotechDef } from './NecrotechData';

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Indexed by Necrotech idx — 0 / 2-4 / 7 are the starters, 1 / 5-6 / 8-10 the drop-only classes. */
export const NECROTECH_ICONS: string[] = [
  // 0 RAVAGER (Marksman) — assault rifle
  wrap('<path d="M3 12h5l2.5-3.5H18l3 2v3h-5l-2 2.5H9.5L8 12H3z"/><path d="M10 16.5 9 21h3l1-4.5"/><path d="M6 12v3"/>'),
  // 1 BREAKER (Vanguard, drop) — power gauntlet / air fist
  wrap('<path d="M6.5 9.5V7a1.6 1.6 0 0 1 3.2 0v2.5"/><path d="M9.7 9.5V6a1.6 1.6 0 0 1 3.2 0v3.5"/><path d="M12.9 9.5V7a1.6 1.6 0 0 1 3.2 0v6.4c0 3.6-2.4 6.1-6 6.1s-6-2.3-6-5.6v-2.6a1.6 1.6 0 0 1 3.2 0"/><path d="M3 20.5h11" opacity="0.6"/>'),
  // 2 VOLT (Chain Mage) — lightning coil
  wrap('<path d="M13.5 2 5.5 13.5H11l-1.5 8.5 8-11.5H12z"/><path d="M17 4.5c1.6 1 2 2.5 1 3.5"/><path d="M19 9c1.5 1.2 1.6 2.8.4 3.7"/>'),
  // 3 PYRE (Pyromancer) — flame
  wrap('<path d="M12 2.5c2.8 4.6 5.5 6.8 5.5 11a5.5 5.5 0 0 1-11 0c0-2.2 1-3.6 2.3-5.6.6 1.7 1.7 2.4 1.7 2.4S9.4 6.6 12 2.5z"/><path d="M12 20.5a2.4 2.4 0 0 0 2.4-2.4c0-1.3-1-2.2-2.4-3.6-1.4 1.4-2.4 2.3-2.4 3.6a2.4 2.4 0 0 0 2.4 2.4z"/>'),
  // 4 RIFT (Assassin) — phase laser emitter
  wrap('<path d="M3 12h11"/><path d="M17 12h4"/><path d="M10.5 9.6 14 12l-3.5 2.4z"/><ellipse cx="12" cy="12" rx="8.6" ry="4.4" opacity="0.55"/><path d="M12 3.5v3M12 17.5v3" opacity="0.6"/>'),
  // 5 BULWARK (Juggernaut, drop) — tower shield
  wrap('<path d="M12 2.5 19.5 6v6.5c0 4.7-3.4 7.7-7.5 9-4.1-1.3-7.5-4.3-7.5-9V6z"/><path d="M12 7v10"/><path d="M8 11h8"/>'),
  // 6 FROST (Controller) — cryo shard
  wrap('<path d="M12 2v20"/><path d="M3.5 7l17 10"/><path d="M20.5 7l-17 10"/><path d="M12 6.5 9.5 4M12 6.5 14.5 4M12 17.5 9.5 20M12 17.5l2.5 2.5"/>'),
  // 7 VENOM (Plaguebearer) — toxin flask
  wrap('<path d="M10 2.5h4v3.2l3.2 5.1a6 6 0 0 1-10.4 0L10 5.7z"/><path d="M9.4 13h5.2"/><path d="M12 16.5c.9-.9 1.6-1.5 1.6-2.4a1.6 1.6 0 0 0-3.2 0c0 .9.7 1.5 1.6 2.4z"/>'),
  // 8 REAPER (Executioner, drop) — scythe
  wrap('<path d="M4.5 21 15 6.5"/><path d="M15 6.5c2.6-2.6 6-2.8 6.4.2.4 3-3.6 5.6-7.4 5.4"/><path d="M7 15.5h5"/>'),
  // 9 NOVA (Detonator, drop) — pulse emitter
  wrap('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22"/><path d="M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>'),
  // 10 WHIPLASH (Warden, drop) — chain whip
  wrap('<path d="M4 20c3.5 0 5-2.5 4-4.5S4.5 12 6 9.5s5-1 5.5-3.5"/><path d="M11.5 6c.6-1.6 2.4-2.3 3.8-1.4 1.5.9 1.7 2.7.7 4"/><path d="M16 8.6l3.4 1.2"/><circle cx="20.4" cy="10.2" r="1.4"/>'),
];

export const MUTATION_ICON = wrap(
  '<path d="M12 2.5v5M12 16.5v5M4.5 7.5l3.5 3.5M16 13l3.5 3.5M19.5 7.5 16 11M8 13l-3.5 3.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1.4"/>'
);

export function iconFor(def: NecrotechDef): string {
  if (def.mutated) return MUTATION_ICON;
  return NECROTECH_ICONS[def.idx] ?? NECROTECH_ICONS[0];
}
