// NECROFALL — procedural universe value types (plan §7–§9/§72/§73).
// These describe GENERATED things only — nothing here is ever stored server
// side beyond a planet's key/seed/ownership.

export type StarType =
  | 'RED_DWARF'
  | 'ORANGE'
  | 'YELLOW'
  | 'BLUE'
  | 'WHITE'
  | 'BINARY'
  | 'TRINARY'
  | 'NEUTRON'
  | 'EXOTIC';

export const STAR_COLORS: Record<StarType, string> = {
  RED_DWARF: '#ff6a4d',
  ORANGE: '#ffa63d',
  YELLOW: '#ffe08a',
  BLUE: '#7fc4ff',
  WHITE: '#e8f4ff',
  BINARY: '#c9a0ff',
  TRINARY: '#9ad7ff',
  NEUTRON: '#a8fff2',
  EXOTIC: '#ff9df0',
};

export type NebulaType = 'NONE' | 'CRIMSON' | 'VIOLET' | 'TOXIC' | 'ELECTRIC' | 'DARK' | 'GOLDEN';

export const NEBULA_COLORS: Record<Exclude<NebulaType, 'NONE'>, string> = {
  CRIMSON: '#ff4d5e',
  VIOLET: '#a86bff',
  TOXIC: '#79ff6b',
  ELECTRIC: '#4dc8ff',
  DARK: '#7a6f96',
  GOLDEN: '#ffc93d',
};

export type GalaxyPoi = 'NORMAL' | 'NEBULA' | 'DEAD' | 'CORRUPTED' | 'STRONGHOLD' | 'SWARM' | 'DISCOVERY';

/**
 * GALAXY MORPHOLOGY (plan §4). Each kind is a genuinely different structure — shape,
 * star distribution and system placement all change with it, never just the colour.
 */
export type GalaxyMorphology = 'SPIRAL' | 'BARRED_SPIRAL' | 'ELLIPTICAL' | 'IRREGULAR' | 'RING' | 'FLOCCULENT';

export const MORPHOLOGY_LABELS: Record<GalaxyMorphology, string> = {
  SPIRAL: 'SPIRAL',
  BARRED_SPIRAL: 'BARRED SPIRAL',
  ELLIPTICAL: 'ELLIPTICAL',
  IRREGULAR: 'IRREGULAR',
  RING: 'RING GALAXY',
  FLOCCULENT: 'FLOCCULENT',
};

export const POI_LABELS: Record<GalaxyPoi, string> = {
  NORMAL: 'OPEN CLUSTER',
  NEBULA: 'NEBULA FIELD',
  DEAD: 'DEAD GALAXY',
  CORRUPTED: 'CORRUPTED SPIRAL',
  STRONGHOLD: 'COLONY STRONGHOLD',
  SWARM: 'NECROPHAGE SWARM',
  DISCOVERY: 'DISCOVERY CLUSTER',
};

/**
 * CANVAS GLYPH + COLOUR per POI (plan §55). ONE table: the map draws its markers
 * from it and the fullscreen info overlay (POI line + legend) reads it too — the
 * key can never drift from the map. SWARM/DEAD share the red alarm glyph;
 * STRONGHOLD is the gold flag; CORRUPTED / DISCOVERY / NEBULA wear the teal star
 * (the hover tooltip's `poiLabel` names which one); NORMAL draws nothing.
 */
export function poiVisual(poi: GalaxyPoi): { glyph: string; color: string } {
  switch (poi) {
    case 'SWARM': return { glyph: '☣', color: '#ff5d73' };
    case 'DEAD': return { glyph: '✝', color: '#ff5d73' };
    case 'STRONGHOLD': return { glyph: '⚑', color: '#ffd166' };
    case 'NORMAL': return { glyph: '', color: '#7be0c8' };
    default: return { glyph: '✦', color: '#7be0c8' };
  }
}

export interface GalaxyDescriptor {
  ring: number;
  gx: number;
  gy: number;
  galaxyId: number;
  seed: number;
  name: string;
  starType: StarType;
  starColor: string;
  systemCount: number;
  nebula: NebulaType;
  nebulaColor: string | null;
  poi: GalaxyPoi;
  poiLabel: string;
  /** Visual disc radius in world units (map space). */
  radius: number;
  // ---- morphology (plan §4): shape, star distribution and system placement read these
  morphology: GalaxyMorphology;
  /** Disc rotation (radians) — arms and ellipse axes follow it. */
  rotation: number;
  /** Number of arms (spiral / barred / flocculent kinds). */
  armCount: number;
  /** Radians of arm sweep per unit of disc radius — higher wraps tighter. */
  armTightness: number;
  /** 0..2 — how concentrated the systems are toward the core (also the sprite's core glow). */
  bulgeStrength: number;
  /** 0..1 — vertical squash of the disc (visual flattening in the sprite). */
  discThickness: number;
  /** Axis ratio for non-circular morphologies (1 = round). */
  axisRatio: number;
  /** Overall emission scale 0.6..1.35 — how brightly this galaxy reads at distance. */
  brightness: number;
}

export interface SystemDescriptor {
  ring: number;
  galaxyId: number;
  systemId: number;
  seed: number;
  name: string;
  planetCount: number;
  /** Unit-disc position of the system inside its galaxy (0..1 space). */
  ux: number;
  uy: number;
}

export type Biome =
  | 'TOXIC'
  | 'OCEAN'
  | 'DESERT'
  | 'FUNGAL'
  | 'VOLCANIC'
  | 'FROZEN'
  | 'CRYSTAL'
  | 'SWAMP'
  | 'CORRUPTED'
  | 'DEAD'
  | 'JUNGLE'
  | 'ABYSSAL';

export const BIOME_LABELS: Record<Biome, string> = {
  TOXIC: 'TOXIC',
  OCEAN: 'OCEANIC',
  DESERT: 'DESERT',
  FUNGAL: 'FUNGAL',
  VOLCANIC: 'VOLCANIC',
  FROZEN: 'FROZEN',
  CRYSTAL: 'CRYSTAL',
  SWAMP: 'SWAMP',
  CORRUPTED: 'CORRUPTED',
  DEAD: 'DEAD',
  JUNGLE: 'JUNGLE',
  ABYSSAL: 'ABYSSAL',
};

export const BIOME_COLORS: Record<Biome, string> = {
  TOXIC: '#a4e34a',
  OCEAN: '#4da3ff',
  DESERT: '#e0b060',
  FUNGAL: '#c86bff',
  VOLCANIC: '#ff6a3d',
  FROZEN: '#bfe8ff',
  CRYSTAL: '#8fe6ff',
  SWAMP: '#6f9c4a',
  CORRUPTED: '#ff4d6d',
  DEAD: '#8a8f9c',
  JUNGLE: '#58c46b',
  ABYSSAL: '#3d5a99',
};

export type Ecology = 'AMBUSH_PACK' | 'BURROW_COLONY' | 'TOXIC_SWARM' | 'FERAL_HERD' | 'CRYSTAL_GRAZERS' | 'VOID_STALKERS';

export const ECOLOGY_LABELS: Record<Ecology, string> = {
  AMBUSH_PACK: 'AMBUSH PACK',
  BURROW_COLONY: 'BURROW COLONY',
  TOXIC_SWARM: 'TOXIC SWARM',
  FERAL_HERD: 'FERAL HERD',
  CRYSTAL_GRAZERS: 'CRYSTAL GRAZERS',
  VOID_STALKERS: 'VOID STALKERS',
};

export interface PlanetDescriptor {
  ring: number;
  galaxyId: number;
  systemId: number;
  planetId: number;
  /** `ring:galaxyId:systemId:planetId` — the DB key. */
  key: string;
  seed: number;
  name: string;
  biome: Biome;
  biomeLabel: string;
  biomeColor: string;
  radius: number;
  temperature: number;
  gravity: number;
  corruption: number;
  ecology: Ecology;
  ecologyLabel: string;
  boss: string;
  difficulty: number;
  /** 0..1 orbit position of the planet inside its system. */
  orbit: number;
  orbitRadius: number;
}

/** Deterministic name vocabulary (plan §71–§73). Names are NEVER stored. */
export const GALAXY_PREFIXES = [
  'Xen', 'Vel', 'Orth', 'Nyx', 'Kae', 'Vor', 'Zar', 'Thal', 'Mer', 'Cyg',
  'Aur', 'Dra', 'Hel', 'Pho', 'Lyr', 'Ith', 'Sar', 'Omb', 'Rho', 'Ery',
];

export const GALAXY_SUFFIXES = [
  'ora', 'aris', 'eon', 'ara', 'ith', 'ane', 'ys', 'ion', 'elle', 'ura', 'ax', 'os', 'eth', 'yn',
];

export const SYSTEM_DESIGNATIONS = ['PRIME', 'MAJOR', 'MINOR', 'ALPHA', 'BETA', 'GAMMA', 'DELTA', 'OMEGA'];

export const BOSS_ARCHETYPES = [
  'BURROWING SIEGE ORGANISM',
  'PLANETARY POUNCER',
  'THE HOLLOW MAW',
  'ROT-WINGED TYRANT',
  'CRYSTAL COLOSSUS',
  'ABYSSAL LEVIATHAN',
  'ASHEN COIL MOTHER',
  'GRAVITY-STALKER ALPHA',
];
