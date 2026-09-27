// NECROFALL — original inline SVG icons for the HOW TO PLAY cards.
// Same 24x24 stroke style as ui/TowerIcons.ts and necrotech/AbilityIcons.ts, so the
// tutorial screen reads as part of the same icon language as the HUD.

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Raised flag — win condition. */
export const WIN_ICON = wrap(
  '<path d="M6.5 21V3.2"/><path d="M6.5 4.4h11l-2.1 3.6 2.1 3.6h-11z"/><path d="M3.6 21h6.8"/>'
);

/** Horned skull — the tower bosses. */
export const BOSS_ICON = wrap(
  '<path d="M4.6 7.6 2.6 4.2l4.2-1"/><path d="M19.4 7.6l2-3.4-4.2-1"/>' +
  '<path d="M12 3.8c4 0 6.8 2.8 6.8 6.5 0 2.5-1.3 4.3-3 5.2V19h-7.6v-3.5c-1.7-.9-3-2.7-3-5.2 0-3.7 2.8-6.5 6.8-6.5z"/>' +
  '<circle cx="9.7" cy="10.6" r="1.5"/><circle cx="14.3" cy="10.6" r="1.5"/><path d="M10.6 15h2.8"/>'
);

/** Dashed capture ring with players inside — how a tower is taken. */
export const CAPTURE_ICON = wrap(
  '<circle cx="12" cy="12" r="10.4" stroke-dasharray="2 2.8" opacity="0.5"/>' +
  '<circle cx="12" cy="12" r="7.4"/>' +
  '<circle cx="12" cy="8.9" r="1.5"/><circle cx="8.8" cy="14" r="1.5"/><circle cx="15.2" cy="14" r="1.5"/>'
);

/** Shield with an up-arrow — COLONY OVERDRIVE on an owned Beacon. */
export const OVERDRIVE_ICON = wrap(
  '<path d="M12 2.8 20 6.2v6.2c0 4.3-3.4 7.5-8 8.8-4.6-1.3-8-4.5-8-8.8V6.2z"/>' +
  '<path d="M12 16.8V9.2"/><path d="M8.9 11.9 12 8.6l3.1 3.3"/>'
);

/** Crosshair — the automatic basic attack. */
export const AUTO_ATTACK_ICON = wrap(
  '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.2"/>' +
  '<path d="M12 1.8v4.2M12 18v4.2M1.8 12h4.2M18 12h4.2"/>'
);

/** Rising chevrons with a spark — level up / perks. */
export const LEVEL_ICON = wrap(
  '<path d="M12 2.8 13.5 8.4 19.1 10 13.5 11.6 12 17.2 10.5 11.6 4.9 10 10.5 8.4z"/>' +
  '<path d="M6.6 18.4 12 21.2l5.4-2.8"/>'
);

/** Floating chip — Necrotech drops. */
export const NECROTECH_ICON = wrap(
  '<path d="M12 2.8 20.4 7v10L12 21.2 3.6 17V7z"/>' +
  '<path d="M12 12 20.4 7M12 12v9.2M12 12 3.6 7"/>'
);
