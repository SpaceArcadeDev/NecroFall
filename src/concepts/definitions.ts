export type EnvironmentInspection = 'scene' | 'terrain' | 'grass' | 'water' | 'trees' | 'rocks' | 'geology' | 'features';
export type PlanetState = 'normal' | 'radiated';
export const BASE_CAMERA_FOV = 49;
export type PlanetWeather = 'motes' | 'rain' | 'heat' | 'spores' | 'snow' | 'embers' | 'salt' | 'charged' | 'petals';

export interface PlanetStudy {
  id: string;
  name: string;
  biome: string;
  designation: string;
  description: string;
  seed: number;
  sky: string;
  horizon: string;
  ground: string;
  highland: string;
  rock: string;
  foliage: string;
  foliageLight: string;
  water: string;
  waterSurface?: 'liquid' | 'ice' | 'lava';
  weather?: PlanetWeather;
  landform?: 'monsoon' | 'caldera' | 'saltern' | 'faults' | 'skylands';
  treeSpecies?: 'oak' | 'cherry' | 'birch';
  infection: string;
  armor: string;
  sun: string;
  flora: 'canopy' | 'coral' | 'sail' | 'fungus' | 'crystal';
  enemies: readonly [string, string, string];
}

export const STUDIES: readonly PlanetStudy[] = [
  { id: 'cinderbloom', name: 'Cinderbloom', biome: 'Irradiated garden', designation: 'NF / 01',
    description: 'Scarlet crowns. Sulfur meadows. A living infection beneath the roots.', seed: 7319,
    sky: '#1689a3', horizon: '#c5e8db', ground: '#719d3f', highland: '#bdc35a', rock: '#69868e',
    foliage: '#bd2448', foliageLight: '#ff6b65', water: '#20b9d0', infection: '#deff4b', armor: '#273641', sun: '#fff0c6',
    weather: 'motes', flora: 'canopy', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
  { id: 'glass-tide', name: 'Glass Tide', biome: 'Contaminated archipelago', designation: 'NF / 02',
    description: 'An opaline sea. Calcified coral forests. Something moves inside the glass.', seed: 24181,
    sky: '#3b88bc', horizon: '#d5edeb', ground: '#7eaa98', highland: '#dfd9ba', rock: '#657b8a',
    foliage: '#eb8067', foliageLight: '#ffbb93', water: '#36cad7', infection: '#ff4e94', armor: '#25546c', sun: '#fff6da',
    weather: 'rain', flora: 'coral', enemies: ['Shardrunner', 'Tide Impaler', 'Cathedral Leviathan'] },
  { id: 'saffron-waste', name: 'Saffron Waste', biome: 'Solar-burned badlands', designation: 'NF / 03',
    description: 'Wind-carved mesas. Solar sails. Armored parasites feeding on the last aquifers.', seed: 51097,
    sky: '#6983b4', horizon: '#ffd7ad', ground: '#c18045', highland: '#edc37b', rock: '#885d58',
    foliage: '#267b76', foliageLight: '#70c5af', water: '#548e83', infection: '#ff603a', armor: '#41394a', sun: '#ffe4b0',
    weather: 'heat', flora: 'sail', enemies: ['Duneskitter', 'Furnace Lancer', 'Sun-Eater'] },
  { id: 'mycelial-night', name: 'Mycelial Night', biome: 'Bioluminescent quarantine', designation: 'NF / 04',
    description: 'Luminous spore canopies. Blackwater. A colony that dreams as one organism.', seed: 88701,
    sky: '#253b78', horizon: '#b592b9', ground: '#315d61', highland: '#598085', rock: '#454564',
    foliage: '#635abe', foliageLight: '#bf8bea', water: '#287f88', infection: '#71ffcb', armor: '#27263f', sun: '#f8bbdc',
    weather: 'spores', flora: 'fungus', enemies: ['Spore Widow', 'Choir Mantis', 'The Bloom'] },
  { id: 'frostwound', name: 'Frostwound', biome: 'Fractured cryosphere', designation: 'NF / 05',
    description: 'Glacial cathedrals. Frozen oceans. Crimson infection sealed under ancient ice.', seed: 123457,
    sky: '#548fba', horizon: '#e7f6ef', ground: '#b7d9dc', highland: '#f1f5e6', rock: '#577588',
    foliage: '#438ea8', foliageLight: '#a4f0ed', water: '#3387a1', infection: '#ff3464', armor: '#333b53', sun: '#fff4d5',
    waterSurface: 'ice', weather: 'snow', flora: 'crystal', enemies: ['Rimecrawler', 'Bloodglass Hunter', 'Heart of Winter'] },
  { id: 'verdant-tempest', name: 'Verdant Tempest', biome: 'Monsoon jungle', designation: 'NF / 06',
    description: 'Jade groves. Rain-cut ravines. Parasites sheltered beneath a restless canopy.', seed: 178213,
    sky: '#365f76', horizon: '#afcfce', ground: '#39785a', highland: '#88bd79', rock: '#426774',
    foliage: '#287955', foliageLight: '#99d77a', water: '#269baf', infection: '#caff58', armor: '#243d43', sun: '#e5f4e3',
    weather: 'rain', landform: 'monsoon', treeSpecies: 'oak', flora: 'canopy', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
  { id: 'emberwake', name: 'Emberwake', biome: 'Volcanic caldera', designation: 'NF / 07',
    description: 'Basalt ramparts. Molten basins. New life taking root in a world of ash.', seed: 231719,
    sky: '#805a72', horizon: '#efb098', ground: '#42424a', highland: '#916457', rock: '#584753',
    foliage: '#a94747', foliageLight: '#f8a563', water: '#ed681f', infection: '#8bff73', armor: '#3c303e', sun: '#ffe8c3',
    waterSurface: 'lava', weather: 'embers', landform: 'caldera', treeSpecies: 'birch', flora: 'sail', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
  { id: 'roseshard-basin', name: 'Roseshard Basin', biome: 'Crystalline salt pans', designation: 'NF / 08',
    description: 'Porcelain flats. Rose brine. A dormant infection crystallized in the salt.', seed: 309731,
    sky: '#6fa7b9', horizon: '#e6ccd9', ground: '#d5b8c2', highland: '#f5e5cf', rock: '#92748e',
    foliage: '#8d79b1', foliageLight: '#e5b4d2', water: '#ce86ad', infection: '#53fbe5', armor: '#52435f', sun: '#fff0e2',
    weather: 'salt', landform: 'saltern', treeSpecies: 'birch', flora: 'coral', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
  { id: 'stormglass-reach', name: 'Stormglass Reach', biome: 'Electrified faultlands', designation: 'NF / 09',
    description: 'Cobalt shelves. Charged rain. Living currents crossing the fractured ground.', seed: 417193,
    sky: '#294664', horizon: '#9ab9c3', ground: '#486580', highland: '#9fb9b1', rock: '#3c5277',
    foliage: '#328e92', foliageLight: '#a9e9db', water: '#557fc2', infection: '#ffdc61', armor: '#2e3453', sun: '#e9f6ff',
    weather: 'charged', landform: 'faults', treeSpecies: 'oak', flora: 'crystal', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
  { id: 'aether-garden', name: 'Aether Garden', biome: 'High-altitude floating groves', designation: 'NF / 10',
    description: 'Golden crowns. Suspended outcrops. Petals drifting through a thinning atmosphere.', seed: 529811,
    sky: '#668cb3', horizon: '#d9d7d2', ground: '#8caaa1', highland: '#d5dfaf', rock: '#797f9c',
    foliage: '#d4a646', foliageLight: '#fff0ae', water: '#718bc6', infection: '#ff82bc', armor: '#444056', sun: '#fff4da',
    weather: 'petals', landform: 'skylands', treeSpecies: 'cherry', flora: 'canopy', enemies: ['Rootstalker', 'Pollen Reaver', 'Crownmother'] },
];

export const BASE_PLANETS = STUDIES;
export type BasePlanet = PlanetStudy;

export function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}