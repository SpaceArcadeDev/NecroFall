// NECROFALL — original inline SVG icons for the Skill and Ultimate buttons.
// Icons are picked from the ability's own wording so the two buttons always read differently,
// and Ultimates additionally get a heavier frame + a burst motif.

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

type IconFn = () => string;

const SHAPES: Record<string, IconFn> = {
  // three bolts flying out — burst / salvo / volley
  volley: () => wrap('<path d="M3 9h9M3 12h7M3 15h9"/><path d="M15 6l6 6-6 6"/>'),
  // cone / wave / arc sweep
  wave: () => wrap('<path d="M4 18c0-8 6-12 16-12"/><path d="M4 18c2 0 4-3 5-6"/><path d="M4 18h4"/>'),
  // concentric rings — slam / nova / pulse
  pulse: () => wrap('<circle cx="12" cy="12" r="2.4"/><path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5"/><path d="M12 19.5A7.5 7.5 0 0 1 4.5 12"/><path d="M12 1.5a10.5 10.5 0 0 1 10.5 10.5"/><path d="M12 22.5A10.5 10.5 0 0 1 1.5 12"/>'),
  // shield / fortify / protocol
  shield: () => wrap('<path d="M12 2.8 19 6v6c0 4.4-3.1 7.3-7 8.6-3.9-1.3-7-4.2-7-8.6V6z"/><path d="M9.5 12l1.8 1.9L15 9.6"/>'),
  // spear / lance / pierce
  lance: () => wrap('<path d="M4 20 18 6"/><path d="M14.5 4.5 19.5 9.5l-2.6 1L15 8.1z"/><path d="M6.5 15.5l2 2"/>'),
  // storm cloud with bolts
  storm: () => wrap('<path d="M6.5 14.5A3.5 3.5 0 0 1 7 7.6 4.5 4.5 0 0 1 15.6 8a3.2 3.2 0 0 1 1.9 6.5"/><path d="M11 15l-1.6 4h3l-1.6 3.5M15.5 15l-1.4 3.5"/>'),
  // swirl / rift / singularity
  rift: () => wrap('<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7a5 5 0 1 0 5 5"/><path d="M12 20.5A8.5 8.5 0 0 1 20.5 12"/>'),
  // teleport / blink / phase
  blink: () => wrap('<path d="M4 18 18 4"/><path d="M13 4h5v5"/><path d="M19 18H6l3-5h7z" opacity="0.55"/>'),
  // rocket / charge / dash
  charge: () => wrap('<path d="M14 4c3 1.5 5 4.5 5 8 0 3-2 6-5 8l-4-3-2-4z"/><path d="M6 14l4 4-3 3-3-3z"/>'),
  // reaper / execute
  reap: () => wrap('<path d="M5 21 15 7"/><path d="M15 7c2.6-2.6 6-2.8 6.4.2.4 3-3.6 5.6-7.4 5.4"/><path d="M8 15h5"/>'),
  // cloud of toxin / plague
  toxin: () => wrap('<path d="M7 16.5A3.5 3.5 0 0 1 7.5 9.6 4.6 4.6 0 0 1 16 10a3.3 3.3 0 0 1 1.4 6.5"/><circle cx="10" cy="19" r="1.4"/><circle cx="14.5" cy="20" r="1.1"/>'),
  // arrow up inside a ring — buff / overcharge
  buff: () => wrap('<circle cx="12" cy="12" r="9"/><path d="M12 17V8"/><path d="M8.5 11.5 12 8l3.5 3.5"/>'),
  // circle + devil horns — the Berserker, drawn to match its ground badge exactly
  berserk: () => wrap('<circle cx="12" cy="13.6" r="6.6"/><path d="M7.9 9.2C5.9 6.8 6.2 4 8.5 2.6"/><path d="M16.1 9.2c2-2.4 1.7-5.2-.6-6.6"/>'),
  // burst star — ultimates that do not match anything else
  nova: () => wrap('<path d="M12 2.5 14 9l6.5-1.5L15 12l5.5 4.5L14 15l-2 6.5L10 15l-6.5 1.5L9 12 3.5 10.5 10 9z"/>'),
  // generic skill sigil
  spark: () => wrap('<path d="M12 3 13.6 9l5.4 3-5.4 3L12 21l-1.6-6-5.4-3 5.4-3z"/>'),
};

/** Maps an ability name/description onto one of the shapes above. */
function pick(name: string, desc: string, isUlt: boolean): IconFn {
  const s = `${name} ${desc}`.toLowerCase();
  // The Berserker is taken FIRST, before the family matchers below: its own description mentions the
  // "auto-attack ring", so the generic ring/pulse shape used to claim it before anything berserk was
  // ever considered. It gets its own mark — the ground badge: a circle with devil horns.
  if (/berserk/.test(s)) return SHAPES.berserk;
  if (/shield|fortress|plating|aegis|barrier|protect/.test(s)) return SHAPES.shield;
  if (/storm|lightning|thunder|bolt|chain/.test(s)) return SHAPES.storm;
  if (/rift|singular|vortex|gravity|dragging|black hole/.test(s)) return SHAPES.rift;
  if (/blink|teleport|phase|shift|warp/.test(s)) return SHAPES.blink;
  if (/rocket|siege|charge|dash|dive|rush/.test(s)) return SHAPES.charge;
  if (/slam|quake|nova|pulse|ring|explos|detonat/.test(s)) return SHAPES.pulse;
  if (/lance|spear|pierc|snip|precision|shot/.test(s)) return SHAPES.lance;
  if (/salvo|volley|burst|barrage|rapid|triple/.test(s)) return SHAPES.volley;
  if (/cone|wave|arc|sweep|flame|fan/.test(s)) return SHAPES.wave;
  if (/plague|toxic|poison|venom|rot|cloud|field|bloom/.test(s)) return SHAPES.toxin;
  if (/reap|execute|scythe|harvest|decapitat/.test(s)) return SHAPES.reap;
  if (/overcharge|frenzy|buff|empower|rage|haste|fury/.test(s)) return SHAPES.buff;
  return isUlt ? SHAPES.nova : SHAPES.spark;
}

/**
 * Resolved icon cache. The HUD asks for the skill and ultimate icon every frame, and `pick()` runs
 * up to thirteen regexes plus a lower-cased copy of the ability text — far more work than the
 * `dataset.glyph` comparison that guarded the DOM write. The description length is part of the key
 * so a fused loadout that changes an ability's text still gets a fresh icon.
 */
const iconCache = new Map<string, string>();

/** Icon for one ability button. Skill and Ultimate never resolve to the same shape family. */
export function abilityIcon(name: string, desc: string, isUlt: boolean): string {
  const key = `${isUlt ? 'u' : 's'}|${name}|${desc.length}`;
  const cached = iconCache.get(key);
  if (cached !== undefined) return cached;
  const shape = pick(name, desc, isUlt);
  // Ultimates always get an extra inner ring so the two buttons are distinguishable at a glance
  const frame = isUlt
    ? '<circle cx="12" cy="12" r="10.4" stroke-width="1"/>'
    : '';
  const out = wrap(`${frame}${shape().replace(/^<svg[^>]*>|<\/svg>$/g, '')}`);
  iconCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- status effects

/** Circular glyphs for the status icons shown above a player's head plate. */
const STATUS: Record<string, IconFn> = {
  // Necrotic Ward — a shielding hexagon
  ward: () => wrap('<path d="M12 2.6 20 6.6v6.2c0 4.3-3.4 7.4-8 8.6-4.6-1.2-8-4.3-8-8.6V6.6z"/><path d="M12 8.4v7.2M9 11.4h6"/>'),
  // Colony boon — a banner
  boon: () => wrap('<path d="M6 3v18"/><path d="M6 4h12l-2.4 3.4L18 11H6z"/><path d="M6 15h12l-2.4 3.4L18 22H6z" opacity="0.5"/>'),
  // invulnerability — a halo
  invuln: () => wrap('<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v3M12 17.4v3M3.6 12h3M17.4 12h3"/><circle cx="12" cy="12" r="3"/>'),
  // mutation — fused ring
  mutate: () => wrap('<circle cx="9" cy="12" r="5.4"/><circle cx="15" cy="12" r="5.4"/><path d="M12 7.4v9.2" opacity="0.5"/>'),
  // system recharging — hourglass
  cooldown: () => wrap('<path d="M6.5 3h11M6.5 21h11"/><path d="M8 3v3.4c0 2 4 2.8 4 5.6s-4 3.6-4 5.6V21"/><path d="M16 3v3.4c0 2-4 2.8-4 5.6s4 3.6 4 5.6V21"/>'),
  // burning
  burn: () => wrap('<path d="M12 2.5c3 4 5 6 5 9.4a5 5 0 0 1-10 0c0-2 1-3.4 2.4-4.8.4 1.2 1 2 1.9 2.4-.4-2.6.2-5 .7-7z"/><path d="M12 21.5v-2" opacity="0.5"/>'),
  // toxin
  toxin: () => wrap('<path d="M12 2.8c3.4 4.6 6 7 6 9.9a6 6 0 0 1-12 0c0-2.9 2.6-5.3 6-9.9z"/><circle cx="10.2" cy="15.4" r="1.3" opacity="0.6"/><circle cx="14" cy="16.6" r="1.1" opacity="0.6"/>'),
  // slowed / webbed
  slow: () => wrap('<path d="M12 3.2a8.8 8.8 0 1 1-6.2 15"/><path d="M12 7.4V12l3.4 2"/><path d="M3.4 14.6 5.8 18.2"/>'),
  // haste / frenzy
  haste: () => wrap('<path d="M13.6 2.5 6 13h4.6L10 21.5 18 11h-4.6z"/>'),
  // fortress / damage reduction
  fortress: () => wrap('<path d="M4 20V8l3-3 3 3 2-3 2 3 3-3 3 3v12z"/><path d="M4 20h16"/>'),
  // siegebreaker / armour break
  siege: () => wrap('<path d="M14.6 3.4 20.6 9.4 9.6 20.4H3.6v-6z"/><path d="M12.2 6.6l5.2 5.2"/>'),
  // overcharge / empowered
  overcharge: () => wrap('<path d="M11 2.5 5 13h5l-1 8.5L17 11h-5.2z"/><circle cx="12" cy="12" r="10.4" stroke-width="1"/>'),
  // generic
  spark: () => wrap('<path d="M12 3 13.6 9l5.4 3-5.4 3L12 21l-1.6-6-5.4-3 5.4-3z"/>'),
};

/** Looks a status icon up by key, falling back to a plain spark. */
export function statusIcon(key: string): string {
  const fn = STATUS[key] ?? STATUS.spark;
  return fn();
}

/**
 * The Necromutation crown: awarded at level 20 and drawn above the status row on the head plate,
 * so a maxed survivor is obvious to everyone on the field.
 */
export function crownIcon(): string {
  return wrap(
    '<path d="M3 8.5l3.6 3L12 4.5l5.4 7 3.6-3-1.6 10.5H4.6z"/>' +
    '<path d="M4.6 19h14.8" stroke-width="1.9"/>' +
    '<circle cx="3" cy="8.5" r="1.1"/><circle cx="21" cy="8.5" r="1.1"/><circle cx="12" cy="4.5" r="1.1"/>'
  );
}
