// NECROFALL — per-ring generation parameters (plan §6/§54). Each rank RING is
// its own procedural band: density, galaxy size, exotic odds and the kind of
// complexity the enemies bring all read from here. Higher rings are SPARSER
// (deep space, not "same map but harder" — plan §54).

export interface RingConfig {
  tier: number;
  name: string;
  tagline: string;
  /** CSS accent for the band and the ring rail. */
  accent: string;
  /** Odds a grid cell holds a galaxy at all (ring 0 dense → ring 7 sparse). */
  density: number;
  /** Systems per galaxy range. */
  systemsMin: number;
  systemsMax: number;
  /** Planets per system range. */
  planetsMin: number;
  planetsMax: number;
  /** Odds of an exotic star / rare nebula. */
  exotic: number;
  /** Which ability count the enemies field (plan §29 — flavour text for the panel). */
  abilityHint: string;
  /** Terrain complexity flavour for the panel. */
  worldHint: string;
}

export const RING_CONFIGS: RingConfig[] = [
  {
    tier: 0,
    name: 'BRONZE',
    tagline: 'The inner worlds — dense, damaged, and crawling.',
    accent: '#e08b52',
    density: 0.55,
    systemsMin: 180,
    systemsMax: 300,
    planetsMin: 2,
    planetsMax: 6,
    exotic: 0.02,
    abilityHint: '2–4 enemy abilities',
    worldHint: 'Simple terrain · basic movement',
  },
  {
    tier: 1,
    name: 'SILVER',
    tagline: 'Contested space — mixed biomes, coordinated packs.',
    accent: '#bfd4e8',
    density: 0.5,
    systemsMin: 220,
    systemsMax: 350,
    planetsMin: 3,
    planetsMax: 8,
    exotic: 0.05,
    abilityHint: '2–5 enemy abilities',
    worldHint: 'More terrain variation · mixed biomes',
  },
  {
    tier: 2,
    name: 'GOLD',
    tagline: 'Hazard belts — aggressive swarms and larger galaxies.',
    accent: '#ffd166',
    density: 0.46,
    systemsMin: 260,
    systemsMax: 420,
    planetsMin: 4,
    planetsMax: 10,
    exotic: 0.09,
    abilityHint: '3–6 enemy abilities',
    worldHint: 'Environmental hazards · aggressive behaviour',
  },
  {
    tier: 3,
    name: 'DIAMOND',
    tagline: 'Advanced ecologies — combination attacks, rare stars.',
    accent: '#9be8ff',
    density: 0.42,
    systemsMin: 300,
    systemsMax: 480,
    planetsMin: 5,
    planetsMax: 12,
    exotic: 0.14,
    abilityHint: '4–7 enemy abilities',
    worldHint: 'Advanced body plans · combination attacks',
  },
  {
    tier: 4,
    name: 'PLATINUM',
    tagline: 'Exotic systems — rare ecological combinations.',
    accent: '#7be0c8',
    density: 0.36,
    systemsMin: 340,
    systemsMax: 540,
    planetsMin: 5,
    planetsMax: 12,
    exotic: 0.22,
    abilityHint: 'Advanced terrain · dangerous bosses',
    worldHint: 'Rare ecological combinations',
  },
  {
    tier: 5,
    name: 'LIBERATOR',
    tagline: 'Elite ecology — environmental interactions, no mercy.',
    accent: '#b48cff',
    density: 0.3,
    systemsMin: 380,
    systemsMax: 600,
    planetsMin: 6,
    planetsMax: 12,
    exotic: 0.32,
    abilityHint: 'Elite ecology · unusual combinations',
    worldHint: 'Environmental interactions',
  },
  {
    tier: 6,
    name: 'GOD',
    tagline: 'Strange cosmic phenomena — complex genomes ahead.',
    accent: '#ff8fd6',
    density: 0.24,
    systemsMin: 420,
    systemsMax: 680,
    planetsMin: 6,
    planetsMax: 12,
    exotic: 0.45,
    abilityHint: 'Highly complex genomes · rare attacks',
    worldHint: 'Advanced boss mechanics',
  },
  {
    tier: 7,
    name: 'KING OF GODS',
    tagline: 'The deep void — maximum complexity, rarest worlds.',
    accent: '#ff5d73',
    density: 0.18,
    systemsMin: 450,
    systemsMax: 750,
    planetsMin: 7,
    planetsMax: 12,
    exotic: 0.6,
    abilityHint: 'Rare species · multi-stage bosses',
    worldHint: 'Maximum procedural complexity',
  },
];

export function ringConfig(tier: number): RingConfig {
  return RING_CONFIGS[Math.max(0, Math.min(7, Math.floor(tier)))];
}
