/**
 * NECROFALL — the ONE art-direction document (visual rework plan §1/§2/§77).
 *
 * Every stylisation value the environment shades with lives here instead of inside
 * `PlanetTerrain`/`PlanetRenderer`/the material constructors, so the whole planet's look can be
 * re-tuned from one file (plan §2: "This allows the art style to be tuned globally").
 *
 * The visual contract (plan §1/§74): 80 % muted terrain, 15 % saturated vegetation/rock, 5 %
 * emissive (radiation, crystals, tech, objectives). Emissive accents communicate DANGER,
 * OBJECTIVES, RADIATION, ABILITIES and LANDMARKS — everything else stays muted.
 *
 *   80 / 15 / 5 rule          ART_DIRECTION palette + emission tiers
 *   cel-shaded lighting       `cel` (CelShading.ts quantises the shared diffuse ramp)
 *   terrain masks             `terrain` (band multipliers) + TerrainMaterial.ts
 *   atmospheric planet        `atmosphere` + SkyDome.ts + Fog.ts
 *   readable VFX              `radiation` + EmissiveMaterial.ts (bloom tiers)
 *   selective outlines        `outlines` + OutlineMaterial.ts
 *
 * The sun intensity keeps the value the world was tuned to (`2.35` — the frozen dev-world
 * baseline); the plan's `2.0` suggestion assumed a from-scratch lighting rig, and re-exposing
 * the shipped rig would darken every tuned surface for no visual gain.
 */
import { readSwitches } from './DebugSwitches';

/** The sky/atmosphere palette of the planet (plan §1: pale cyan / desaturated turquoise). */
export const SKY_PALETTE = {
  /** Horizon band — the pale turquoise a low camera reads against the terrain. */
  horizon: '#7fc9c4',
  /** Mid-sky haze — the contaminated green the shipped fog colour already speaks. */
  haze: '#2b4f40',
  /** Zenith — deep desaturated teal; space never reads as pure black. */
  zenith: '#08161d',
  /** Cloud bands — faint, cool, barely above the sky gradient. */
  cloud: '#b9e6e2',
  /** Orbital dust motes in the upper sky. */
  dust: '#9fe8d8',
  /** Distant celestial body colours (the giant's rim glow and the moon). */
  body: '#c8b08a',
  bodyRim: '#7fc9c4',
  moon: '#dfe8ea',
  /** The far sun disc (kept just over the bloom threshold so the sky gains a hot core). */
  sun: '#fff4d6',
} as const;

export const ART_DIRECTION = {
  terrain: {
    /** Cel band multipliers (plan §2 example): the shade → mid → light ladder the terrain's
     *  albedo rides ON TOP of the quantised lighting ramp. */
    shadow: 0.72,
    mid: 0.88,
    light: 1.08,
    /** Colour grade applied to the terrain albedo (plan §2): mildly desaturated, contrast up.
     *  Raised toward the concept sheet's richer planetary colour (user ask 2026-10-06). */
    saturation: 0.98,
    contrast: 1.16,
  },

  cel: {
    /** Discrete lighting bands (plan §3): shadow → dark → mid → bright. */
    bands: 4,
    /** NdotL-derived thresholds, one per band edge (the ramp is quantised here). */
    thresholds: [0.25, 0.6, 0.82] as const,
    /** Band-edge smoothing (plan §3: "Do NOT make the transitions completely hard"). */
    softness: 0.04,
  },

  atmosphere: {
    /** Multiplier on the horizon tint every distant surface mixes in (plan §2/§21). */
    density: 0.035,
    /** Peak strength of the horizon band on the sky dome (plan §2). */
    horizonStrength: 0.75,
    /** Power of the view-dependent atmospheric rim (plan §20). */
    horizonFalloff: 2.2,
    /** Distance (m) where the distance colour compression fades in / saturates. */
    hazeStart: 50,
    hazeEnd: 140,
    /** Fraction of the terrain colour the horizon tint claims at full distance (plan §21). */
    hazeStrength: 0.45,
    /** Strength of the silhouette rim light on terrain (plan §20 — subtle, not neon). */
    rimStrength: 0.28,
  },

  vegetation: {
    /** Grass saturation (the shipped tuned pop — plan §8/§9 keep the existing grass style). */
    saturation: 1.32,
    /** Per-blade brightness variation ceiling (plan §10: "keep variation subtle"). */
    variation: 0.12,
  },

  radiation: {
    /** Global emissive intensity for radioactive materials (plan §25). */
    intensity: 3.0,
    /** Bloom contribution of crystal/radiation emissives (plan §26: medium tier). */
    bloom: 0.45,
    /** Emissive lift on radioactive GROUND (the terrain glow term, plan §4/§66). */
    terrainGlow: 0.22,
  },

  outlines: {
    enabled: true,
    /** Inverted-hull thickness as a fraction of instance scale (plan §59). */
    strength: 0.55,
    /** Hull offset in local units (plan §2 example). */
    distance: 0.012,
  },

  lighting: {
    /** Sun intensity — the shipped tuned key light (see the header note). */
    sunIntensity: 2.35,
    /** Ambient floor expressed through the shadow-colour mix (informational, plan §2). */
    ambientIntensity: 0.55,
  },
} as const;

/** `?cel=0` — the A/B switch that renders the shared material with the pre-cel smooth ramp. */
let celEnabledCache: boolean | null = null;

export function celEnabled(): boolean {
  if (celEnabledCache === null) {
    try {
      celEnabledCache = readSwitches()['cel'] !== '0';
    } catch {
      celEnabledCache = true;
    }
  }
  return celEnabledCache;
}

/** `?outlines=0` — selective object outlines off (diagnostics / A-B). */
let outlinesEnabledCache: boolean | null = null;

export function outlinesEnabled(): boolean {
  if (outlinesEnabledCache === null) {
    if (!ART_DIRECTION.outlines.enabled) {
      outlinesEnabledCache = false;
    } else {
      try {
        outlinesEnabledCache = readSwitches()['outlines'] !== '0';
      } catch {
        outlinesEnabledCache = true;
      }
    }
  }
  return outlinesEnabledCache;
}
