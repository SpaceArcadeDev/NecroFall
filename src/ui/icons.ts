// NECROFALL — the single SVG icon map (overhaul §33).
//
// One stroke language for the WHOLE menu shell: 24×24 box, 1.8 stroke,
// round caps and joins, currentColor ink. No mixed emoji, no ad-hoc glyphs
// scattered across screens — every icon in the shell comes from here.
export const ICONS = {
  play: '<path d="M8.4 5.8v12.4c0 .9 1 1.4 1.7.9l9.2-6.2c.7-.4.7-1.4 0-1.8L10.1 4.9c-.7-.5-1.7 0-1.7.9z"/>',
  rank: '<path d="M12 3.6 20 20.4H4z"/><path d="M9.2 10.2h5.6"/><path d="M7.5 13.8h9"/><path d="M5.8 17.4h12.4"/>',
  user: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 19.8c.9-3.9 3.7-5.9 7.2-5.9s6.3 2 7.2 5.9"/>',
  users:
    '<circle cx="9" cy="8.6" r="3.1"/><path d="M3.8 19.4c.7-3.3 2.8-5 5.2-5s4.5 1.7 5.2 5"/><path d="M15.6 5.9a3 3 0 0 1 0 5.5"/><path d="M16.8 14.7c1.8.5 3 2 3.4 4.7"/>',
  orbit:
    '<circle cx="12" cy="12" r="3.1"/><ellipse cx="12" cy="12" rx="9" ry="3.9" transform="rotate(-24 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.9" transform="rotate(66 12 12)"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  mail: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.4"/><path d="M4.4 7.4 12 13l7.6-5.6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="m5 12.6 4.4 4.4L19 7.4"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  'arrow-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'arrow-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  expand:
    '<path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M15 20h5v-5"/><path d="M9 20H4v-5"/>',
  collapse:
    '<path d="M4 9h5V4"/><path d="M20 9h-5V4"/><path d="M20 15h-5v5"/><path d="M4 15h5v5"/>',
  locate:
    '<circle cx="12" cy="12" r="7.2"/><path d="M12 2.8v3.4"/><path d="M12 17.8v3.4"/><path d="M2.8 12h3.4"/><path d="M17.8 12h3.4"/><circle cx="12" cy="12" r="1.4"/>',
  filter: '<path d="M4 5.6h16"/><path d="M7 12h10"/><path d="M10 18.4h4"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 4.4 4.4"/>',
  lock: '<rect x="5.2" y="10.4" width="13.6" height="9.2" rx="2.2"/><path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4"/>',
  globe:
    '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.3 2.3 3.5 5.2 3.5 8.6s-1.2 6.3-3.5 8.6c-2.3-2.3-3.5-5.2-3.5-8.6s1.2-6.3 3.5-8.6z"/>',
  server:
    '<rect x="3.8" y="4.2" width="16.4" height="6.4" rx="2"/><rect x="3.8" y="13.4" width="16.4" height="6.4" rx="2"/><path d="M7.2 7.4h.02"/><path d="M7.2 16.6h.02"/>',
  shield: '<path d="M12 3.2 19.4 6v5.6c0 4.6-3 7.7-7.4 9.2-4.4-1.5-7.4-4.6-7.4-9.2V6z"/>',
  swords:
    '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="M5 14l4 4"/><path d="M7 17l-3 3"/>',
  stopwatch:
    '<circle cx="12" cy="13.4" r="7.2"/><path d="M12 9.6v3.8l2.6 1.9"/><path d="M9.4 2.8h5.2"/><path d="M12 2.8v3.4"/>',
  horde:
    '<path d="M12 3.2a5.4 5.4 0 0 0-5.4 5.4c0 1.9 1 3 2 3.8v2.2a1.4 1.4 0 0 0 1.4 1.4h4a1.4 1.4 0 0 0 1.4-1.4v-2.2c1-.8 2-1.9 2-3.8A5.4 5.4 0 0 0 12 3.2z"/><path d="M4 19.4c2.2-1.6 4.6-1.6 6.8 0"/><path d="M13.2 19.4c2.2-1.6 4.6-1.6 6.8 0"/>',
  compass:
    '<circle cx="12" cy="12" r="8.6"/><path d="m15.4 8.6-2.1 4.7-4.7 2.1 2.1-4.7z"/><path d="M12 3.4v1.4"/><path d="M12 19.2v1.4"/><path d="M3.4 12h1.4"/><path d="M19.2 12h1.4"/>',
  code: '<path d="m9 8-4.4 4L9 16"/><path d="m15 8 4.4 4L15 16"/><path d="M13.2 5.6 10.8 18.4"/>',
  wand: '<path d="M3.6 20.4 14 10"/><path d="M12.4 8.4l3.2 3.2"/><path d="M17.8 2.6l.75 2.05 2.05.75-2.05.75-.75 2.05-.75-2.05-2.05-.75 2.05-.75z"/><path d="M7.4 3.4l.5 1.35 1.35.5-1.35.5-.5 1.35-.5-1.35-1.35-.5 1.35-.5z"/>',
  events:
    '<rect x="3.8" y="5" width="16.4" height="15" rx="2.4"/><path d="M3.8 9.6h16.4"/><path d="M8.2 3.4v3"/><path d="M15.8 3.4v3"/><path d="M12 12.4l.9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z"/>',
  home: '<path d="M4.4 10.8 12 4.2l7.6 6.6"/><path d="M6.2 9.6V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.6"/>',
  copy: '<rect x="8.6" y="8.6" width="10.8" height="10.8" rx="2.2"/><path d="M5.8 15.4h-1a1.6 1.6 0 0 1-1.6-1.6V6.2a1.6 1.6 0 0 1 1.6-1.6H13a1.6 1.6 0 0 1 1.6 1.6v1"/>',
  share: '<circle cx="6.4" cy="12" r="2.6"/><circle cx="17.6" cy="5.8" r="2.6"/><circle cx="17.6" cy="18.2" r="2.6"/><path d="m8.8 10.8 6.4-3.7"/><path d="m8.8 13.2 6.4 3.7"/>',
  star: '<path d="m12 4 2.3 4.8 5.3.7-3.9 3.7.9 5.3L12 16l-4.6 2.5.9-5.3L4.4 9.5l5.3-.7z"/>',
  more: '<circle cx="5.4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.6" cy="12" r="1.5"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  door: '<path d="M9 4.4h8.6a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H9"/><path d="M12.6 12H4.4"/><path d="m7.4 9 -3 3 3 3"/>',
  'door-in':
    '<path d="M9 4.4h8.6a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H9"/><path d="M4.4 12h8.2"/><path d="m9.6 9 3 3-3 3"/>',
  help: '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.8.4-1 .9-1 1.7v.3"/><path d="M12 16.9h.02"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** One icon as an inline SVG string (stroke language is uniform by construction). */
export function getIcon(name: IconName | string): string {
  const inner = (ICONS as Record<string, string>)[name] ?? ICONS.user;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
