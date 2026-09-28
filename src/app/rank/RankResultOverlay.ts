// NECROFALL — RANK RESULT overlay (plan §80). Shown once the server concludes a
// RANKED match: the star movement, the new ladder standing, and what happened to
// the planet (liberated + 72-hour shield, or still infested). It floats above
// the game's own end screen and is fully self-cleaning.
import { parsePlanetKey } from '../../rankmap/procedural/SeedHash';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';
import { getRankDisplayName, getRankFromStars, rankLabel, TIER_LIBERATOR } from '../../rank/RankService';
import { COLONIES } from '../../core/Config';

export interface RankResultInfo {
  matchId: number;
  /** The applied star delta (+1 / 0 / −1) from the server's rank_history row. */
  delta: number;
  oldTier: number;
  oldDivision: number;
  newStars: number;
  /** Winner colony (null = draw) and the local player's colony. */
  winnerColony: number | null;
  myColony: number;
  planetKey: string;
  universeSeed: number;
  onViewMap: () => void;
}

export function showRankResultOverlay(info: RankResultInfo): () => void {
  const parsed = parsePlanetKey(info.planetKey);
  const planet = parsed
    ? planetAt(info.universeSeed, parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId)
    : null;
  const planetName = planet?.name.toUpperCase() ?? 'THE PLANET';
  const won = info.winnerColony !== null && info.winnerColony === info.myColony;
  const draw = info.winnerColony === null;
  const myWin = won;

  const root = document.createElement('div');
  root.className = 'nf-rankresult';

  const deltaText = info.delta > 0 ? `+${info.delta}` : info.delta < 0 ? `${info.delta}` : '0';
  const deltaCls = info.delta > 0 ? 'up' : info.delta < 0 ? 'down' : 'flat';
  const newName = getRankDisplayName(info.newStars);
  const oldName = rankLabel(info.oldTier, info.oldDivision);
  const info2 = getRankFromStars(info.newStars);
  // Within-division moves keep the same LABEL — show the star position instead of
  // a pointless "BRONZE III → BRONZE III".
  const cap = info2.tier >= TIER_LIBERATOR ? 25 : info2.tier === 0 ? 3 : info2.tier === 1 ? 4 : 5;
  const moveHtml =
    oldName === newName
      ? `<span class="nf-rr-old">${oldName}</span><span class="nf-rr-arrow">·</span><span class="nf-rr-new">${Math.min(info2.stars, cap - 1)} / ${cap} ★</span>`
      : `<span class="nf-rr-old">${oldName}</span><span class="nf-rr-arrow">→</span><span class="nf-rr-new">${newName}</span>`;
  const colonyName = info.myColony < 3 ? COLONIES[info.myColony]?.name ?? '' : '';
  const colonyCss = info.myColony < 3 ? COLONIES[info.myColony]?.css ?? '#fff' : '#fff';
  const winnerName = info.winnerColony !== null && info.winnerColony < 3 ? COLONIES[info.winnerColony]?.name ?? '' : '';
  const winnerCss = info.winnerColony !== null && info.winnerColony < 3 ? COLONIES[info.winnerColony]?.css ?? '#fff' : '#aaa';

  const planetLine = draw
    ? `<div class="nf-rr-line dim">STALEMATE — THE NECROPHAGES KEEP ${planetName}</div>`
    : myWin
      ? `<div class="nf-rr-line good" style="--c:${colonyCss}">PLANET LIBERATED — ${colonyName} RAISES A 72-HOUR SHIELD OVER ${planetName}</div>`
      : `<div class="nf-rr-line bad" style="--c:${winnerCss}">${planetName} IS HELD BY ${winnerName}</div>`;

  root.innerHTML =
    `<div class="nf-rr-card ${deltaCls}">` +
    `<div class="nf-rr-kicker">RANKED RESULT</div>` +
    `<div class="nf-rr-delta ${deltaCls}">${deltaText}<span>★</span></div>` +
    `<div class="nf-rr-move">${moveHtml}</div>` +
    `<div class="nf-rr-stars">${Array.from({ length: cap }, (_, i) => `<i class="${i < info2.stars ? 'on' : ''}" style="animation-delay:${i * 55}ms">★</i>`).join('')}</div>` +
    planetLine +
    `<div class="nf-rr-btns">` +
    `<button class="nf-rr-btn primary" data-act="map">VIEW GALACTIC MAP</button>` +
    `<button class="nf-rr-btn" data-act="close">CONTINUE</button>` +
    `</div>` +
    `</div>`;

  const remove = (): void => {
    root.classList.add('closing');
    window.setTimeout(() => root.remove(), 260);
  };
  root.querySelector('[data-act="close"]')?.addEventListener('click', remove);
  root.querySelector('[data-act="map"]')?.addEventListener('click', () => {
    remove();
    info.onViewMap();
  });
  root.addEventListener('click', (e) => {
    if (e.target === root) remove();
  });

  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('playing'));
  return remove;
}
