// NECROFALL — LOCATION CONTROL SUMMARY (plan §12/§44/§45). ONE shared
// aggregation for "who holds this place, and how strongly", used by:
//
//   * the canvas      → territory halos, segmented rings, necrophage red
//   * the DOM panels  → DOMINANT / CONTESTED / TERRITORY blocks
//   * planet panels   → CURRENT CONTROL + DOMINANCE
//
// THE RULE (plan §12/§13): a planet CONTROLLED by a colony counts for that
// colony; a DISCOVERED-but-infested planet counts for the NECROPHAGES (a real
// owner category — never `colony = 255` leaking into the UI). Whoever holds
// ≥ half of the held planets DOMINATES; otherwise the location is CONTESTED
// and every party is shown with its share. Percentages always sum to 100%.
//
// Phase 45 exists because two different aggregations once disagreed (canvas
// 62% vs panel 61%) — nothing in the UI may compute control any other way.

export const COLONY_NONE = 255;
export const COLONY_CAP = 3;
/** The Necrophages' pseudo-colony id (never stored on a planet row). */
export const OWNER_NECROPHAGES = -1;

export const NECROPHAGE_CONTROL_COLOR = '#ff3b30';
export const NECROPHAGE_DEEP = '#8f1020';
export const NECROPHAGE_EMISSION = '#ff5548';
export const NECROPHAGE_HALO = '#ff1f3d';

/** A party that can hold ranked territory (plan §13). */
export type OwnerType = 'COLONY' | 'NECROPHAGES';

export interface OwnerRef {
  type: OwnerType;
  /** Colony index (0..2) for COLONY owners; OWNER_NECROPHAGES otherwise. */
  colony: number;
  /** Display name — colony name, or `NECROPHAGES`. */
  name: string;
  color: string;
}

export interface OwnerShare {
  owner: OwnerRef;
  /** Planets held by this party. */
  count: number;
  /** count / heldCount, 0..1 — the ownerShares sum to exactly 1. */
  share: number;
}

/** The one control model every surface reads (plan §44). */
export interface LocationControlSummary {
  dominantOwner: OwnerRef | null;
  /** 0..1 — the dominant party's share (0 when nothing is held). */
  dominantShare: number;
  /** Every party, strongest first (empty when nothing is held). */
  ownerShares: OwnerShare[];
  /** Rows that count toward control (controlled + discovered-infested). */
  controlledPlanetCount: number;
  /** Rows of the location in scope (server rows, any state). */
  totalPlanetCount: number;
  /** No party holds ≥ DOMINANCE_THRESHOLD (or nothing is held). */
  contested: boolean;
  /** Planet level only: the controlling colony's shield expiry (micros), 0 none. */
  shieldExpiresAt: number;
}

/** A party holding ≥ this share DOMINATES the location (plan §12). */
export const DOMINANCE_THRESHOLD = 0.5;

/** Minimal server-row shape (mirrors `PlanetRowData` — structural on purpose). */
export interface ControlRow {
  systemId: number;
  state: number;
  colony: number;
  discovered: boolean;
  controlExpiresAt?: number;
}

export const RANKED_PLANET_INFESTED = 0;
export const RANKED_PLANET_CONTROLLED = 1;

export interface DominanceOptions {
  colonyColors: readonly string[];
  colonyNames?: readonly string[];
  /** Narrow to one solar system (the system panel + star ring). */
  systemId?: number;
  /** Planet level: the row's control expiry. */
  shieldExpiresAt?: number;
  /**
   * Server clock (micros). When provided, a CONTROLLED row only counts while its
   * shield is UP — a fallen shield is Necrophage-held (user 2026-09-29: "even after
   * colony shield falls, it should be taken over by necrophages"), no matter whether
   * the 1 Hz sweep has cleared the row yet.
   */
  nowUs?: number;
}

export function necrophagesOwner(): OwnerRef {
  return { type: 'NECROPHAGES', colony: OWNER_NECROPHAGES, name: 'NECROPHAGES', color: NECROPHAGE_CONTROL_COLOR };
}

export function colonyOwner(colony: number, colors: readonly string[], names?: readonly string[]): OwnerRef {
  return {
    type: 'COLONY',
    colony,
    name: names?.[colony] ?? `COLONY ${colony + 1}`,
    color: colors[colony] ?? '#8a8f9c',
  };
}

/**
 * SHIELD-FALLEN = NECROPHAGES (user 2026-09-29). A colony row HOLDS a planet only
 * while its 72 h shield is up; an expired shield reads exactly like an infested
 * world (Necrophage-held) on every surface, independent of the server sweep.
 */
export function isHeldNow(row: ControlRow, nowUs: number): boolean {
  return row.state === RANKED_PLANET_CONTROLLED && row.colony < COLONY_CAP && (row.controlExpiresAt ?? 0) > nowUs;
}

/**
 * THE control aggregation (plan §12/§45). `rows` are the server rows of the
 * galaxy (pass `systemId` to narrow); never generated data.
 */
export function calculateDominance(rows: readonly ControlRow[], opts: DominanceOptions): LocationControlSummary {
  const counts = new Map<number, number>(); // colony index, or OWNER_NECROPHAGES
  let total = 0;
  let held = 0;
  let shield = opts.shieldExpiresAt ?? 0;
  for (const row of rows) {
    if (opts.systemId !== undefined && row.systemId !== opts.systemId) continue;
    total++;
    let owner = Number.NaN;
    const controlled = row.state === RANKED_PLANET_CONTROLLED && row.colony < COLONY_CAP;
    const heldNow = controlled && (opts.nowUs === undefined || (row.controlExpiresAt ?? 0) > opts.nowUs);
    if (heldNow) {
      owner = row.colony;
      if ((row.controlExpiresAt ?? 0) > shield) shield = row.controlExpiresAt ?? 0;
    } else if ((row.discovered && row.colony === COLONY_NONE) || (controlled && !heldNow)) {
      // infested — or a FALLEN shield before the 1 Hz sweep clears the row — is
      // Necrophage-held (user 2026-09-29)
      owner = OWNER_NECROPHAGES;
    }
    if (Number.isNaN(owner)) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    held++;
  }
  const ownerShares: OwnerShare[] = [...counts.entries()]
    .map(([colony, count]) => ({
      owner: colony === OWNER_NECROPHAGES ? necrophagesOwner() : colonyOwner(colony, opts.colonyColors, opts.colonyNames),
      count,
      share: count / held,
    }))
    .sort((a, b) => b.count - a.count);
  const dominant = ownerShares[0] ?? null;
  const dominantShare = dominant ? dominant.share : 0;
  return {
    dominantOwner: dominant ? dominant.owner : null,
    dominantShare,
    ownerShares,
    controlledPlanetCount: held,
    totalPlanetCount: total,
    contested: ownerShares.length > 1 && dominantShare < DOMINANCE_THRESHOLD,
    shieldExpiresAt: shield,
  };
}

/** Percentage label that always sums to 100 across the shown shares. */
export function sharePct(share: number): number {
  return Math.round(share * 100);
}

/**
 * Round shares to whole percents that SUM to 100 (largest-remainder): the
 * checklist demands it and naive rounding drifts (33.3×3 → 99).
 */
export function sharePercentages(shares: readonly { share: number }[]): number[] {
  const scaled = shares.map((s) => s.share * 100);
  const floors = scaled.map((s) => Math.floor(s));
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}
