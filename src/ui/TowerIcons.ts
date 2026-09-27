// NECROFALL — original Beacon and Nexus sigils shared by the HUD tracker and the radar.
// These are the SAME two silhouettes the radar paints on its canvas (see `drawMinimap`): a watch
// tower with a light, roof, body and base rail, and a diamond core with four cardinal rays. They
// are kept deliberately different from each other so a glance tells you which tower you are looking
// at — and deliberately identical to the radar so the tracker and the minimap never disagree.
// Solid shapes, not outlines: the radar fills them too.

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;

/** Watch tower: light, roof, body and base rail. */
export const BEACON_ICON = wrap(
  '<circle cx="12" cy="2.4" r="1.68"/>' +
  '<path d="M12 4.2 17.28 9.84 6.72 9.84Z"/>' +
  '<rect x="8.88" y="10.32" width="6.24" height="8.88"/>' +
  '<path d="M6.48 19.68H17.52" stroke="currentColor" stroke-width="1.68" stroke-linecap="round" fill="none"/>'
);

/** Diamond core with four cardinal rays — the Nexus. */
export const NEXUS_ICON = wrap(
  '<path d="M12 6.5 17.5 12 12 17.5 6.5 12Z"/>' +
  '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">' +
  '<path d="M12 4.6V2.1"/><path d="M12 19.4v2.5"/><path d="M4.6 12H2.1"/><path d="M19.4 12h2.5"/>' +
  '</g>'
);
