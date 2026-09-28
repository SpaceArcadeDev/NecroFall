// NECROFALL — THE OWNERSHIP COLOUR PIPELINE (plan §13/§14/§33/§34/§35).
//
// ONE shared decision for "who colours this place": every galaxy, every system and
// every planet asks this module, so the whole hierarchy speaks the same language:
//
//     NECROPHAGES = RED                      (a REAL owner — plan §13)
//     HELIOS / AEGIS / VANTA = their own colony colour
//     contested = every party's colour, weighted (NEVER one forced owner)
//
// Ownership colour propagates galaxy → solar system → planet, and each tier renders it
// as an EMISSION tint (glow / haze / atmosphere) — the procedural shape underneath
// (spiral arms, nebula, star colour) is never replaced.
//
// The input is always SERVER ROWS (plan §0): nothing here is random or generated.
// The aggregation itself lives in `LocationControlSummary.ts` — the ONE function
// every surface shares (plan §45) — and `TerritoryVisual` is its rendering shape.
import {
  calculateDominance,
  COLONY_NONE,
  DOMINANCE_THRESHOLD,
  NECROPHAGE_CONTROL_COLOR,
  NECROPHAGE_DEEP,
  NECROPHAGE_EMISSION,
  NECROPHAGE_HALO,
  OWNER_NECROPHAGES,
  RANKED_PLANET_CONTROLLED,
  RANKED_PLANET_INFESTED,
  type ControlRow,
} from './LocationControlSummary';

export {
  COLONY_NONE,
  DOMINANCE_THRESHOLD,
  NECROPHAGE_CONTROL_COLOR,
  NECROPHAGE_DEEP,
  NECROPHAGE_EMISSION,
  NECROPHAGE_HALO,
  OWNER_NECROPHAGES,
  RANKED_PLANET_CONTROLLED,
  RANKED_PLANET_INFESTED,
};

/** Minimal row shape (mirrors `PlanetRowData` — kept structural to avoid a cycle). */
export interface TerritoryRow extends ControlRow {
  controlExpiresAt?: number;
}

export type TerritoryKind = 'NONE' | 'SINGLE' | 'NECROPHAGE' | 'CONTESTED';

export interface TerritoryVisual {
  kind: TerritoryKind;
  /** The single owner's colour (SINGLE / NECROPHAGE). null for NONE / CONTESTED. */
  color: string | null;
  /** All parties' colours, weight-aligned with `share` (CONTESTED uses these). */
  colors: string[];
  /** Per-colour weights (sums to 1) — how much of the territory each party holds. */
  share: number[];
  /** The dominant party's share (0..1) — the SAME number the DOM panel shows. */
  dominantShare: number;
  /** True when the Necrophages are the single owner (plan §18: red halo). */
  necrophage: boolean;
}

const EMPTY: TerritoryVisual = {
  kind: 'NONE',
  color: null,
  colors: [],
  share: [],
  dominantShare: 0,
  necrophage: false,
};

/**
 * THE shared territory visual (plan §13/§45): derived from `calculateDominance`,
 * so the canvas and the panels can never disagree about who dominates.
 * A single party holding ≥ 50% of the held planets owns the territory; otherwise
 * it is CONTESTED and carries every party's colour with its weight.
 */
export function getTerritoryVisual(
  rows: readonly TerritoryRow[],
  colonyColors: readonly string[],
  systemId?: number
): TerritoryVisual {
  const summary = calculateDominance(rows, { colonyColors, systemId });
  if (!summary.dominantOwner) return EMPTY;
  const colors = summary.ownerShares.map((s) => s.owner.color);
  const share = summary.ownerShares.map((s) => s.share);
  if (summary.contested) {
    return {
      kind: 'CONTESTED',
      color: null,
      colors,
      share,
      dominantShare: summary.dominantShare,
      necrophage: false,
    };
  }
  const necrophage = summary.dominantOwner.type === 'NECROPHAGES';
  return {
    kind: necrophage ? 'NECROPHAGE' : 'SINGLE',
    color: summary.dominantOwner.color,
    colors,
    share,
    dominantShare: summary.dominantShare,
    necrophage,
  };
}

/** Galaxy-level aggregate (plan §35): all rows of the galaxy. */
export function getGalaxyOwnership(rows: readonly TerritoryRow[], colonyColors: readonly string[]): TerritoryVisual {
  return getTerritoryVisual(rows, colonyColors);
}

/** System-level aggregate (plan §35): rows narrowed to one system. */
export function getSystemOwnership(rows: readonly TerritoryRow[], colonyColors: readonly string[], systemId: number): TerritoryVisual {
  return getTerritoryVisual(rows, colonyColors, systemId);
}

/** Planet-level glow colour (plan §13): controller colour, or Necrophage red. */
export function planetOwnershipColor(
  row: TerritoryRow | undefined,
  colonyColors: readonly string[]
): string | null {
  if (!row) return null;
  if (row.state === RANKED_PLANET_CONTROLLED && row.colony < 3) return colonyColors[row.colony] ?? null;
  if (row.discovered && row.colony === COLONY_NONE) return NECROPHAGE_CONTROL_COLOR;
  return null;
}

/** The planet's normalized owner visual (plan §13) — NECROPHAGES is a real owner. */
export function planetOwnershipVisual(
  row: TerritoryRow | undefined,
  colonyColors: readonly string[]
): TerritoryVisual {
  return getTerritoryVisual(row ? [row] : [], colonyColors);
}
