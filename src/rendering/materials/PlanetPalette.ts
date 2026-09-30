/**
 * NECROFALL — radioactive planet palette (plan §10/§59/§60).
 *
 * Folio's palette approach is kept — a tiny atlas + a height gradient drive
 * every environment material — but the CONTENT is the contaminated NecroFall
 * world: dark soil, toxic vegetation, radioactive greens.
 *
 * The palette atlas replaces folio's `palette.png` 1:1 in shape (128×4): the
 * folio tree/trunk UVs land in it unchanged, so their silhouettes and mapping
 * survive while their colours become radioactive.
 */
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

type Stops = [number, string][];

/** Interpolated sample of a multi-stop ramp (linear RGB in sRGB space — canvas parity). */
export function sampleRamp(stops: Stops, t: number): THREE.Color {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [stopA, colorA] = stops[i - 1];
    const [stopB, colorB] = stops[i];
    if (clamped <= stopB || i === stops.length - 1) {
      const span = Math.max(1e-5, stopB - stopA);
      const k = Math.min(1, Math.max(0, (clamped - stopA) / span));
      return new THREE.Color(colorA).lerp(new THREE.Color(colorB), k);
    }
  }
  return new THREE.Color(stops[0][1]);
}

/**
 * The runtime palette atlas that REPLACES folio's palette.png.
 * 128×4 — x is the ramp, y picks the family:
 *   row 0  bark / soil ramps        (tree trunk UVs, props)
 *   row 1  foliage ramps            (bush cores, leaves fallback)
 *   row 2  rock / shadow ramps      (rocks, spikes)
 *   row 3  radioactive ramps        (crystals, contamination)
 */
export function createPaletteAtlas(): THREE.Texture {
  const width = 128;
  const height = 4;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;

  const rows: Stops[] = [
    [
      [0, RADIOACTIVE_PALETTE.soilDark],
      [0.35, RADIOACTIVE_PALETTE.soil],
      [0.7, RADIOACTIVE_PALETTE.soilLight],
      [1, RADIOACTIVE_PALETTE.rockLight],
    ],
    [
      [0, RADIOACTIVE_PALETTE.foliageDark],
      [0.45, RADIOACTIVE_PALETTE.foliage],
      [0.8, RADIOACTIVE_PALETTE.foliageLight],
      [1, RADIOACTIVE_PALETTE.grassLight],
    ],
    [
      [0, RADIOACTIVE_PALETTE.rockDark],
      [0.5, RADIOACTIVE_PALETTE.rock],
      [0.85, RADIOACTIVE_PALETTE.rockLight],
      [1, '#8d8492'],
    ],
    [
      [0, RADIOACTIVE_PALETTE.radioactive3],
      [0.5, RADIOACTIVE_PALETTE.radioactive],
      [0.85, RADIOACTIVE_PALETTE.radioactive2],
      [1, '#f4ffd8'],
    ],
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = sampleRamp(rows[y], x / (width - 1));
      context.fillStyle = `rgb(${(color.r * 255) | 0},${(color.g * 255) | 0},${(color.b * 255) | 0})`;
      context.fillRect(x, y, 1, 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Terrain height gradient (folio `Terrain.setGradient` port): sampled with
 * `vec2(0, 1 - height01)` so the ramp reads bottom-of-the-sea → peaks.
 * Pass the planet archetype's own stops to keep the world's identity.
 */
export function createTerrainGradient(stops?: Stops): THREE.Texture {
  const ramp: Stops = stops ?? [
    [0, RADIOACTIVE_PALETTE.shadow],
    [0.2, RADIOACTIVE_PALETTE.soilDark],
    [0.42, RADIOACTIVE_PALETTE.soil],
    [0.62, RADIOACTIVE_PALETTE.rock],
    [0.82, RADIOACTIVE_PALETTE.rockLight],
    [1, '#7d7484'],
  ];

  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = height;
  const context = canvas.getContext('2d')!;

  for (let y = 0; y < height; y++) {
    // y = 0 is the TOP of the texture — height01 1.0 samples y=0
    const color = sampleRamp(ramp, 1 - y / (height - 1));
    context.fillStyle = `rgb(${(color.r * 255) | 0},${(color.g * 255) | 0},${(color.b * 255) | 0})`;
    context.fillRect(0, y, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
