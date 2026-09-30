// NECROFALL — PlanetPalette (plan §10): the radioactive palette that controls the world's base
// colours. Folio's palette approach is kept exactly — what changes is the CONTENT: instead of
// the portfolio island's blues and greens, the planet reads as a contaminated Necrophage world.
//
// These are the FALLBACK values: a planet's own archetype palette (world/PlanetArchetypes.ts)
// overrides them wherever the game's per-planet art direction provides a colour. Realistic PBR
// textures that fight this palette must not be introduced (plan §10/§61).
import * as THREE from 'three/webgpu';

export const RADIOACTIVE_PALETTE = {
  grassDark: '#233b24',
  grass: '#58733a',
  grassLight: '#8fa34e',

  soilDark: '#241d29',
  soil: '#463344',
  soilLight: '#684c52',

  rockDark: '#202027',
  rock: '#3d3a42',
  rockLight: '#6a6267',

  foliageDark: '#183421',
  foliage: '#35643a',
  foliageLight: '#699342',

  waterDark: '#152936',
  water: '#1f5960',
  waterLight: '#5bc8b7',

  radioactive: '#78ff3d',
  radioactive2: '#d6ff62',
  radioactive3: '#32f59a',

  spike: '#656d52',

  shadow: '#171522',
  fog: '#253b35',
} as const;

export type RadioactivePalette = typeof RADIOACTIVE_PALETTE;
export type RadioactivePaletteKey = keyof RadioactivePalette;

/** Parse a palette entry into a fresh THREE.Color (callers own the instance). */
export function paletteColor(key: RadioactivePaletteKey): THREE.Color {
  return new THREE.Color(RADIOACTIVE_PALETTE[key]);
}

/** Shared scratch for per-frame palette reads — never allocate in a hot path. */
export const PALETTE_SCRATCH = new THREE.Color();
