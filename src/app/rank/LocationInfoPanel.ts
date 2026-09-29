// NECROFALL — LOCATION INFO PANEL (plan §8–§11/§33–§37/§41/§44/§45). The DOM
// half of the ranked map: when a galaxy / system / planet is SELECTED (or the
// camera is parked in one), the centre column answers ONE question —
//
//     "What is important about the place I'm looking at?"
//
// Every block here reads the SAME aggregation the canvas uses
// (`calculateDominance`, plan §45) and the SAME server clock as the shield arc
// (`serverNowUs`, plan §46) — the panel and the map can never disagree.
//
// Discovery lists are rendered ONLY here (plan §40): the canvas never shows
// names, so the map stays clean at every zoom.
import { el } from '../ui/dom';
import { COLONIES } from '../../core/Config';
import { RING_CONFIGS, ringConfig } from '../../rankmap/procedural/RankRingConfig';
import type { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from '../../rankmap/procedural/GalaxyTypes';
import type { PlanetRowData } from '../../rankmap/GalacticMap';
import { calculateDominance, RANKED_PLANET_CONTROLLED, sharePercentages, type LocationControlSummary } from '../../rankmap/LocationControlSummary';
import { relativeTime, type DiscoveryEntry } from '../../rankmap/DiscoveryTypes';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';
import { getRankDisplayName, getRankFromStars } from '../../rank/RankService';
import type { RankedPlanetRow } from '../spacetimedb/rows';

/** Everything the panel needs from the page — data + actions (plan §71). */
export interface LocationPanelHost {
  universeSeed(): number;
  myRing(): number;
  myStars(): number;
  serverNowUs(): number;
  rowsForGalaxy(galaxyId: number): PlanetRowData[];
  planetRow(key: string): RankedPlanetRow | null | undefined;
  reservedKeys(): Set<string>;
  discoveriesForGalaxy(galaxyId: number): DiscoveryEntry[];
  discoveriesForSystem(galaxyId: number, systemId: number): DiscoveryEntry[];
  discoveriesForPlanet(planetKey: string): DiscoveryEntry[];
  planetAvailable(p: PlanetDescriptor): boolean;
  planetsOf(sys: SystemDescriptor): PlanetDescriptor[];
  /** Resolve the hierarchy descriptors for panel context. */
  currentGalaxyFor(loc: { galaxyId: number }): GalaxyDescriptor | null;
  systemFor(p: PlanetDescriptor): SystemDescriptor | null;
  /** The caller's live matchmaking row ('' planetKey when none). */
  myQueue(): { ranked: boolean } | null;
  /** Actions. */
  selectPlanet(p: PlanetDescriptor): void;
  startRanked(p: PlanetDescriptor): void;
  jumpTo(p: PlanetDescriptor): void;
  findAnother(p: PlanetDescriptor): PlanetDescriptor | null;
  goQueue(): void;
  flyToRing(ring: number): void;
}

export interface PanelFocus {
  galaxy: GalaxyDescriptor | null;
  system: SystemDescriptor | null;
}

// ------------------------------------------------------------ shared blocks

/**
 * SHIELD COUNTDOWN (plan §14/§15/§46). Server time only; the format follows
 * the plan — `71:42:18` (H:MM:SS), `23:14:09`, `59:32` (MM:SS), `00:42`, and
 * once the shield has fallen: `PLANETARY SHIELD FALLEN` (never a negative).
 */
export function shieldCountdownText(expiresUs: number, nowUs: number): string {
  const remain = expiresUs - nowUs;
  if (remain <= 0) return 'PLANETARY SHIELD FALLEN';
  const s = Math.ceil(remain / 1e6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function colonyColor(colony: number): string {
  return colony < COLONIES.length ? COLONIES[colony].css : '#8a8f9c';
}

function colonyName(colony: number): string {
  return colony < COLONIES.length ? COLONIES[colony].name : 'UNALIGNED';
}

/**
 * CONTROL SUMMARY block (plan §44/§45): DOMINANT party + share, or CONTESTED
 * with every party's slice. Percentages are the shared largest-remainder
 * rounding, so they sum to exactly 100.
 */
export function controlBlock(summary: LocationControlSummary, opts: { kicker?: string; compact?: boolean } = {}): HTMLElement {
  const box = el('div', 'rk-control');
  if (opts.kicker) box.appendChild(el('div', 'rk-control-kicker', opts.kicker));
  if (!summary.dominantOwner) {
    box.appendChild(el('div', 'rk-control-none', 'UNCLAIMED'));
    return box;
  }
  const pct = sharePercentages(summary.ownerShares);
  const head = el('div', 'rk-control-head');
  if (summary.contested) {
    head.innerHTML = `<b class="contested">CONTESTED</b>`;
  } else {
    head.innerHTML =
      `<span class="rk-control-by">CONTROLLED BY</span>` +
      `<b style="color:${summary.dominantOwner.color}">${summary.dominantOwner.name}</b>` +
      `<em>${pct[0]}%</em>`;
  }
  box.appendChild(head);
  // COMPACT (the fullscreen map overlay, user 2026-09-29): the headline only —
  // the influence bars stay a side-panel detail.
  if (opts.compact) return box;
  const bars = el('div', 'rk-influence-bars');
  summary.ownerShares.forEach((share, i) => {
    const row = el('div', 'rk-ibar');
    row.innerHTML =
      `<span class="rk-ibar-name" style="color:${share.owner.color}">${share.owner.name}</span>` +
      `<span class="rk-ibar-track"><span class="rk-ibar-fill" style="width:${pct[i]}%;background:${share.owner.color}"></span></span>` +
      `<span class="rk-ibar-pct">${pct[i]}%</span>`;
    bars.appendChild(row);
  });
  box.appendChild(bars);
  return box;
}

/**
 * DISCOVERED BY (plan §41/§42): a compact numbered list — 01..09, the player's
 * display name, a colony colour chip (colony AT DISCOVERY TIME) and a relative
 * "4h ago". Never player ids, never wall-clock timestamps.
 */
export function discoveryBlock(
  entries: DiscoveryEntry[],
  opts: { fallback?: 'historical' | 'none'; nowUs: number; highlights?: string[]; max?: number }
): HTMLElement {
  const box = el('div', 'rk-discoverers');
  const head = el('div', 'rk-discoverers-head');
  if (entries.length) {
    head.innerHTML = `<span>DISCOVERED BY</span><b>${entries.length} ${entries.length === 1 ? 'EXPLORER' : 'EXPLORERS'}</b>`;
  } else {
    head.innerHTML = `<span>DISCOVERED BY</span><b>${opts.fallback === 'historical' ? 'HISTORICAL DATA UNAVAILABLE' : 'UNDISCOVERED'}</b>`;
  }
  box.appendChild(head);
  // `max` caps the ROWS only (the header still counts them all) — the fullscreen
  // overlay stays minimal (user ask 2026-09-29).
  for (const entry of (opts.max ? entries.slice(0, opts.max) : entries)) {
    const line = el('div', 'rk-discoverer');
    const mine = opts.highlights?.includes(entry.playerId) ?? false;
    line.innerHTML =
      `<b class="rk-disc-index">${String(entry.index).padStart(2, '0')}</b>` +
      `<span class="rk-disc-dot" style="background:${colonyColor(entry.colony)}"></span>` +
      `<span class="rk-disc-name">${escapeHtml(entry.playerName)}${mine ? ' <i>(YOU)</i>' : ''}</span>` +
      `<span class="rk-disc-colony" style="color:${colonyColor(entry.colony)}">${colonyName(entry.colony)}</span>` +
      `<span class="rk-disc-when">${relativeTime(entry.discoveredAt, opts.nowUs)}</span>`;
    box.appendChild(line);
  }
  return box;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

// ------------------------------------------------------------ panels

/** The root panel (plan §37): what matters when NOTHING is selected. */
export function buildRootPanel(host: LocationPanelHost, focus: PanelFocus): HTMLElement {
  const box = el('div', 'rk-card');
  box.appendChild(el('div', 'rk-card-title', 'YOUR STANDING'));
  const stars = host.myStars();
  const info = getRankFromStars(stars);
  const cfg = ringConfig(host.myRing());
  const grid = el('div', 'rk-stat-grid');
  grid.innerHTML =
    `<div class="rk-stat"><span>YOUR RANK</span><b style="color:${cfg.accent}">${getRankDisplayName(stars)}</b></div>` +
    `<div class="rk-stat"><span>STARS</span><b>${stars} ★</b></div>` +
    `<div class="rk-stat"><span>CURRENT RING</span><b style="color:${cfg.accent}">${cfg.name}</b></div>` +
    `<div class="rk-stat"><span>CURRENT GALAXY</span><b>${focus.galaxy ? focus.galaxy.name.toUpperCase() : 'GALACTIC CORE'}</b></div>`;
  box.appendChild(grid);

  // DOMINANT FACTION IN YOUR AREA (plan §37) — the same aggregation as the canvas.
  const galaxy = focus.galaxy;
  if (galaxy) {
    const summary = calculateDominance(host.rowsForGalaxy(galaxy.galaxyId), {
      colonyColors: COLONIES.map((c) => c.css),
      colonyNames: COLONIES.map((c) => c.name),
      nowUs: host.serverNowUs(),
    });
    if (summary.dominantOwner) {
      box.appendChild(controlBlock(summary, { kicker: `DOMINANT FACTION IN ${galaxy.name.toUpperCase()}` }));
    } else {
      box.appendChild(
        el('p', 'rk-card-note', `No colony has charted ${galaxy.name.toUpperCase()} yet — be the first to raise a banner here.`)
      );
    }
    // RECENT + NEAREST DISCOVERY (plan §37) come from the subscribed rows only.
    const rows = host.rowsForGalaxy(galaxy.galaxyId).filter((r) => r.discovered);
    if (rows.length) {
      let newest: { row: PlanetRowData; at: number } | null = null;
      let nearest: { row: PlanetRowData; d: number } | null = null;
      const fromSystem = focus.system?.systemId ?? 0;
      for (const r of rows) {
        const full = host.planetRow(r.planetKey);
        const at = Number(full?.firstDiscoveredAt ?? 0);
        if (!newest || at > newest.at) newest = { row: r, at };
        const d = Math.abs(r.systemId - fromSystem) * 64 + r.planetId;
        if (!nearest || d < nearest.d) nearest = { row: r, d };
      }
      const now = host.serverNowUs();
      const bits: string[] = [];
      if (nearest) {
        const p = planetAt(host.universeSeed(), nearest.row.ring, nearest.row.galaxyId, nearest.row.systemId, nearest.row.planetId);
        if (p) bits.push(`NEAREST DISCOVERED<span class="rk-highlight-sub">${p.name.toUpperCase()}</span>`);
      }
      if (newest && newest.at > 0) {
        const p = planetAt(host.universeSeed(), newest.row.ring, newest.row.galaxyId, newest.row.systemId, newest.row.planetId);
        if (p) bits.push(`RECENT DISCOVERY<span class="rk-highlight-sub">${p.name.toUpperCase()} · ${relativeTime(newest.at, now).toUpperCase()}</span>`);
      }
      if (bits.length) {
        const hl = el('div', 'rk-highlight');
        hl.innerHTML = `<div class="rk-highlight-body">${bits.join('')}</div>`;
        box.appendChild(hl);
      }
    }
  }
  const go = el('button', 'rk-btn primary wide', `BACK TO ${cfg.name} BAND`) as HTMLButtonElement;
  go.type = 'button';
  go.addEventListener('click', () => host.flyToRing(host.myRing()));
  box.appendChild(go);
  box.appendChild(
    el('p', 'rk-card-note', 'Tap any galaxy, system or planet to inspect it — the expanded view holds its control and discovery history.')
  );
  return box;
}

/** GALAXY expanded view (plan §9/§34). */
export function buildGalaxyPanel(g: GalaxyDescriptor, host: LocationPanelHost): HTMLElement {
  const box = el('div', 'rk-card');
  const cfg = RING_CONFIGS[g.ring] ?? RING_CONFIGS[0];
  box.appendChild(el('div', 'rk-card-kicker', `${g.morphology.replace(/_/g, ' ')} · ${cfg.name} BAND`));
  box.appendChild(el('div', 'rk-card-title', g.name.toUpperCase()));

  const rows = host.rowsForGalaxy(g.galaxyId);
  const summary = calculateDominance(rows, {
    colonyColors: COLONIES.map((c) => c.css),
    colonyNames: COLONIES.map((c) => c.name),
    nowUs: host.serverNowUs(),
  });
  box.appendChild(controlBlock(summary, { kicker: 'TERRITORY' }));

  const discoveries = host.discoveriesForGalaxy(g.galaxyId);
  const grid = el('div', 'rk-stat-grid');
  grid.innerHTML =
    `<div class="rk-stat"><span>SOLAR SYSTEMS</span><b>${g.systemCount}</b></div>` +
    `<div class="rk-stat"><span>DISCOVERED</span><b>${discoveries.length ? `${discoveries.length} ${discoveries.length === 1 ? 'EXPLORER' : 'EXPLORERS'}` : 'UNDISCOVERED'}</b></div>` +
    `<div class="rk-stat"><span>RANK BAND</span><b style="color:${cfg.accent}">${cfg.name}</b></div>` +
    `<div class="rk-stat"><span>STAR</span><b style="color:${g.starColor}">${g.starType.replace('_', ' ')}</b></div>`;
  box.appendChild(grid);

  box.appendChild(discoveryBlock(discoveries, { fallback: 'none', nowUs: host.serverNowUs() }));
  box.appendChild(el('p', 'rk-card-note', 'Tap a solar system in the cluster to inspect its planets.'));
  return box;
}

/** SOLAR SYSTEM expanded view (plan §10/§35). */
export function buildSystemPanel(sys: SystemDescriptor, host: LocationPanelHost): HTMLElement {
  const galaxy = host.currentGalaxyFor(sys);
  const box = el('div', 'rk-card');
  box.appendChild(el('div', 'rk-card-kicker', galaxy ? galaxy.name.toUpperCase() : 'SOLAR SYSTEM'));
  box.appendChild(el('div', 'rk-card-title', sys.name.toUpperCase()));

  const rows = host.rowsForGalaxy(sys.galaxyId);
  const summary = calculateDominance(rows, {
    colonyColors: COLONIES.map((c) => c.css),
    colonyNames: COLONIES.map((c) => c.name),
    systemId: sys.systemId,
    nowUs: host.serverNowUs(),
  });
  box.appendChild(controlBlock(summary, { kicker: 'CONTROL' }));

  const planets = host.planetsOf(sys);
  const discoveries = host.discoveriesForSystem(sys.galaxyId, sys.systemId);
  const grid = el('div', 'rk-stat-grid');
  grid.innerHTML =
    `<div class="rk-stat"><span>PLANETS</span><b>${planets.length}</b></div>` +
    `<div class="rk-stat"><span>HELD PLANETS</span><b>${summary.controlledPlanetCount}</b></div>` +
    `<div class="rk-stat"><span>DISCOVERED BY</span><b>${discoveries.length ? `${discoveries.length} EXPLORERS` : 'UNDISCOVERED'}</b></div>` +
    `<div class="rk-stat"><span>GALAXY</span><b>${galaxy ? galaxy.name.toUpperCase() : '—'}</b></div>`;
  box.appendChild(grid);

  box.appendChild(discoveryBlock(discoveries, { fallback: 'none', nowUs: host.serverNowUs() }));

  // The planet picker: tap a row to SELECT the planet (plan §19/§47).
  const list = el('div', 'rk-planetlist');
  for (const p of planets) {
    const row = host.planetRow(p.key);
    // a FALLEN shield is already Necrophage-held (user 2026-09-29) — the sweep only
    // clears the row later
    const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.controllingColony < 3 && Number(row.controlExpiresAt) > host.serverNowUs();
    const reserved = host.reservedKeys().has(p.key);
    const line = el('button', `rk-planetrow${controlled ? ' controlled' : ''}${reserved ? ' reserved' : ''}`) as HTMLButtonElement;
    line.type = 'button';
    // EVERY uncontrolled world reads NECROPHAGES (user 2026-09-29: "all planets that
    // are undiscovered should be under the control of necrophages") — a filling match
    // still reads CONTESTED, which is live information.
    const tag = controlled
      ? colonyName(row!.controllingColony)
      : reserved
        ? 'CONTESTED'
        : 'NECROPHAGES';
    const tagColor = controlled ? colonyColor(row!.controllingColony) : reserved ? '' : '#ff3b30';
    if (tagColor) line.style.setProperty('--rk-colony', tagColor);
    line.innerHTML =
      `<span class="rk-planetrow-orb" style="background:${p.biomeColor}"></span>` +
      `<span class="rk-planetrow-name">${p.name.toUpperCase()}</span>` +
      `<span class="rk-planetrow-tag"${tagColor ? ` style="color:${tagColor}"` : ''}>${tag}</span>`;
    line.addEventListener('click', () => host.selectPlanet(p));
    list.appendChild(line);
  }
  box.appendChild(list);
  return box;
}

/** PLANET expanded view (plan §11/§36) — the most actionable panel. */
export function buildPlanetPanel(p: PlanetDescriptor, host: LocationPanelHost): HTMLElement {
  const row = host.planetRow(p.key);
  // a FALLEN shield is already Necrophage-held (user 2026-09-29) — the sweep only
  // clears the row later
  const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.controllingColony < 3 && Number(row.controlExpiresAt) > host.serverNowUs();
  const reserved = host.reservedKeys().has(p.key);
  const discovered = Boolean(row?.discovered);
  const mine = p.ring === host.myRing();
  const galaxy = host.currentGalaxyFor(p);
  const system = host.systemFor(p);

  const box = el('div', 'rk-card rk-planet-card');
  box.style.setProperty('--rk-biome', p.biomeColor);
  box.appendChild(el('div', 'rk-card-kicker', `${p.biomeLabel} · ${RING_CONFIGS[p.ring]?.name ?? '?'} RING`));
  box.appendChild(el('div', 'rk-card-title big', p.name.toUpperCase()));
  const orb = el('div', 'rk-orb');
  orb.style.setProperty('--rk-orb', p.biomeColor);
  orb.style.setProperty('--rk-corruption', `${Math.round(p.corruption * 100)}%`);
  box.appendChild(orb);

  // CURRENT CONTROL + DOMINANCE (plan §36) — planet level is exactly one owner.
  const controlRow = row
    ? {
        systemId: row.systemId,
        state: row.state,
        colony: row.controllingColony,
        discovered: row.discovered,
        controlExpiresAt: Number(row.controlExpiresAt),
      }
    : null;
  const summary = calculateDominance(controlRow ? [controlRow] : [], {
    colonyColors: COLONIES.map((c) => c.css),
    colonyNames: COLONIES.map((c) => c.name),
    nowUs: host.serverNowUs(),
  });
  const status = el('div', 'rk-status');
  if (controlled) {
    status.innerHTML =
      `<div class="rk-status-line" style="color:${colonyColor(row!.controllingColony)}">⬢ CONTROLLED BY ${colonyName(row!.controllingColony)}</div>` +
      `<div class="rk-shield"><span class="rk-shield-label">PLANETARY SHIELD FALLS IN</span><span class="rk-shield-clock" data-countdown>${shieldCountdownText(Number(row!.controlExpiresAt), host.serverNowUs())}</span></div>`;
  } else if (reserved) {
    status.innerHTML = `<div class="rk-status-line amber">▲ CONTESTED — A MATCH IS FILLING FOR THIS WORLD</div>`;
  } else if (discovered) {
    status.innerHTML = `<div class="rk-status-line" style="color:#ff3b30">⬢ CONTROLLED BY NECROPHAGES</div><div class="rk-status-line dim">INFESTED — OPEN FOR LIBERATION</div>`;
  } else {
    // EVERY uncharted world belongs to the Necrophages (user 2026-09-29: "all planets
    // that are undiscovered should be under the control of necrophages"); the first
    // liberation is what records it.
    status.innerHTML = `<div class="rk-status-line" style="color:#ff3b30">⬢ CONTROLLED BY NECROPHAGES</div><div class="rk-status-line dim">UNCHARTED — FIRST CONTACT WILL BE RECORDED</div>`;
  }
  box.appendChild(status);
  if (summary.dominantOwner) box.appendChild(controlBlock(summary, { kicker: 'DOMINANCE' }));

  const grid = el('div', 'rk-stat-grid');
  grid.innerHTML =
    `<div class="rk-stat"><span>SYSTEM</span><b>${system ? system.name.toUpperCase() : '—'}</b></div>` +
    `<div class="rk-stat"><span>GALAXY</span><b>${galaxy ? galaxy.name.toUpperCase() : '—'}</b></div>` +
    `<div class="rk-stat"><span>GRAVITY</span><b>${p.gravity.toFixed(2)} g</b></div>` +
    `<div class="rk-stat"><span>CORRUPTION</span><b>${Math.round(p.corruption * 100)}%</b></div>`;
  box.appendChild(grid);

  const discoveries = host.discoveriesForPlanet(p.key);
  box.appendChild(
    discoveryBlock(discoveries, {
      fallback: discovered ? 'historical' : 'none',
      nowUs: host.serverNowUs(),
    })
  );

  const eco = el('div', 'rk-eco');
  eco.innerHTML =
    `<div class="rk-eco-row"><span>THREAT</span><b>${Math.round(p.difficulty * 100)}%</b></div>` +
    `<div class="rk-eco-row"><span>ECOLOGY</span><b>${p.ecologyLabel}</b></div>` +
    `<div class="rk-eco-row"><span>APEX</span><b>${p.boss}</b></div>`;
  box.appendChild(eco);

  // ---- match action (plan §49/§50)
  const queue = host.myQueue();
  if (queue?.ranked) {
    const searching = el('button', 'rk-btn primary wide searching', `SEARCHING — ${p.name.toUpperCase()}…`) as HTMLButtonElement;
    searching.type = 'button';
    searching.addEventListener('click', () => host.goQueue());
    box.appendChild(searching);
  } else if (queue) {
    box.appendChild(el('p', 'rk-card-note', 'You are already in a matchmaking queue — cancel it first.'));
  } else if (!mine) {
    box.appendChild(el('p', 'rk-card-note', `This world fights at ${RING_CONFIGS[p.ring]?.name ?? 'another'} — reach that ring to battle here.`));
  } else if (controlled || reserved) {
    const other = host.findAnother(p);
    const b = el('button', 'rk-btn primary wide', other ? `FIND ANOTHER PLANET — ${other.name.toUpperCase()}` : 'SEARCH THE NEXT GALAXY') as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', () => {
      if (other) host.jumpTo(other);
      else host.flyToRing(host.myRing());
    });
    box.appendChild(b);
  } else {
    const b = el('button', 'rk-btn primary wide', `FIND MATCH — LIBERATE ${p.name.toUpperCase()}`) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', () => host.startRanked(p));
    box.appendChild(b);
    box.appendChild(el('p', 'rk-card-note', "Win the match to raise your colony's 72-hour shield over this planet."));
  }
  return box;
}
