// NECROFALL — RANK MAP ICONS (plan §29/§30). Purpose-built inline SVG, ONE
// stroke system (`stroke-width` 1.9, round caps, `currentColor`), so:
//
//   * CSS owns the colour (hover / active / disabled all just work),
//   * rendering is crisp at any DPR and identical on iOS + Android,
//   * no emoji, no icon font, no external requests.
//
// Every icon is a 24×24 viewBox string so the caller can drop it into any
// button; buttons keep their 44px touch target and centre a ~20–24px glyph
// (plan §55).

const STROKE = 1.9;

function svg(body: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/**
 * BACK TO POSITION (plan §29/§52): a navigation TARGET — crosshair ring with
 * four diagonal rays — "return to my position", never a generic back arrow.
 * Concept:  ╲ / around ◎ with / ╲
 */
export function createCenterIcon(): string {
  return svg(
    `<circle cx="12" cy="12" r="5.6"/>` +
      `<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>` +
      `<path d="M7.1 7.1 5.2 5.2M16.9 7.1l1.9-1.9M7.1 16.9l-1.9 1.9M16.9 16.9l1.9 1.9"/>`
  );
}

/** EXPAND (reworked 2026-09-28): the familiar maximize arrows — two corner
 *  brackets with diagonal shafts pointing outward to the corner they open. */
export function createFullscreenIcon(): string {
  return svg(
    `<path d="M15 3h6v6"/>` +
      `<path d="M9 21H3v-6"/>` +
      `<path d="m21 3-7 7"/>` +
      `<path d="m3 21 7-7"/>`
  );
}

/** MINIMIZE (reworked 2026-09-28 — the old folded-bracket glyph read as noise):
 *  the familiar minimize arrows — the shafts point IN, to the centre. */
export function createFullscreenExitIcon(): string {
  return svg(
    `<path d="M4 14h6v6"/>` +
      `<path d="M20 10h-6V4"/>` +
      `<path d="m14 10 7-7"/>` +
      `<path d="m3 21 7-7"/>`
  );
}

/** BACK (hierarchy): a chevron — used by breadcrumbs, never for "my position". */
export function createBackIcon(): string {
  return svg(`<path d="M14.5 5.5 8 12l6.5 6.5"/>`);
}

/** GALAXY (type badge): a spiral seen face-on. */
export function createGalaxyIcon(): string {
  return svg(
    `<path d="M12 12c3.6-2.9 7-2.5 8.1.1.9 2.2-.5 4.6-3.2 5.6-3.4 1.3-7.5-.3-9-3.4C6.5 11.3 8.2 8.2 11 7.3c2.4-.7 4.9.2 6 1.9"/>` +
      `<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>`
  );
}

/** SOLAR SYSTEM (type badge): a star with an orbit. */
export function createSystemIcon(): string {
  return svg(
    `<circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>` +
      `<ellipse cx="12" cy="12" rx="8.4" ry="4.6" transform="rotate(-24 12 12)"/>` +
      `<circle cx="18.4" cy="8.6" r="1.35" fill="currentColor" stroke="none"/>`
  );
}

/** PLANET (type badge): a ringed world. */
export function createPlanetIcon(): string {
  return svg(
    `<circle cx="12" cy="12" r="5.2"/>` +
      `<ellipse cx="12" cy="12" rx="9" ry="2.6" transform="rotate(-18 12 12)"/>`
  );
}
