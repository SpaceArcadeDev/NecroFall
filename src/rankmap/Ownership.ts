// NECROFALL — THE OWNERSHIP COLOUR PIPELINE (plan §13/§14/§33/§34/§35).
//
// ONE shared decision for "who colours this place": every galaxy, every system and
// every planet asks this module, so the whole hierarchy speaks the same language:
//
//     NECROPHAGES = RED
//     HELIOS / AEGIS / VANTA = their own colony colour
//     mixed control = a blended, multi-colour treatment (NEVER one forced owner)
//
// Ownership colour propagates galaxy → solar system → planet, and each tier renders it
// as an EMISSION tint (glow / haze / atmosphere) — the procedural shape underneath
// (spiral arms, nebula, star colour) is never replaced.
//
// The input is always SERVER ROWS (plan §0): nothing here is random or generated.

export const NECROPHAGE_CONTROL_COLOR = '#ff3b30';
export const NECROPHAGE_DEEP = '#8f1020';
export const NECROPHAGE_EMISSION = '#ff5548';
export const NECROPHAGE_HALO = '#ff1f3d';

export const COLONY_NONE = 255;

/** Minimal row shape (mirrors `PlanetRowData` — kept structural to avoid a cycle). */
export interface TerritoryRow {
  systemId: number;
  colony: number;
  state: number;
  discovered: boolean;
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
}

const EMPTY: TerritoryVisual = { kind: 'NONE', color: null, colors: [], share: [] };

export const RANKED_PLANET_INFESTED = 0;
export const RANKED_PLANET_CONTROLLED = 1;

/** One party's share must reach this to claim the territory outright (plan §35). */
const DOMINANCE_THRESHOLD = 0.6;

/**
 * THE shared ownership function (plan §13). `rows` are the server rows of a galaxy (or
 * a system — pass `systemId` to narrow); controlled planets count for their colony,
 * discovered-but-infested planets count for the NECROPHAGES. A single party holding
 * ≥ 60% of the held planets owns the territory; otherwise it is CONTESTED and carries
 * every party's colour with its weight.
 */
export function getTerritoryVisual(
  rows: readonly TerritoryRow[],
  colonyColors: readonly string[],
  systemId?: number
): TerritoryVisual {
  const weights = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (systemId !== undefined && row.systemId !== systemId) continue;
    let color: string | null = null;
    if (row.state === RANKED_PLANET_CONTROLLED && row.colony < 3) {
      color = colonyColors[row.colony] ?? null;
    } else if (row.discovered && row.colony === COLONY_NONE) {
      color = NECROPHAGE_CONTROL_COLOR; // infested, held by the Necrophages
    }
    if (!color) continue;
    weights.set(color, (weights.get(color) ?? 0) + 1);
    total++;
  }
  if (!total) return EMPTY;
  const entries = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const colors = entries.map(([c]) => c);
  const share = entries.map(([, n]) => n / total);
  if (entries.length === 1 || share[0] >= DOMINANCE_THRESHOLD) {
    const color = colors[0];
    const kind: TerritoryKind = color === NECROPHAGE_CONTROL_COLOR ? 'NECROPHAGE' : 'SINGLE';
    return { kind, color, colors, share };
  }
  return { kind: 'CONTESTED', color: null, colors, share };
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
