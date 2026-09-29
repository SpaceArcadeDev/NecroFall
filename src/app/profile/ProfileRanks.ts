// NECROFALL — the profile RANK strip (user ask 2026-09-29): CURRENT RANK and
// HIGHEST RANK as two compact cards, wearing the rank band's own colour.
//
// Current = `player.rankPoints` (the ladder is one integer, see RankService).
// Highest = `player.peakRankPoints`, the max the server has ever recorded —
// with a legacy fallback to `max(peak, current)` so accounts predating the
// column still read their true standing.
import { ClientCache } from '../spacetimedb/cache';
import { ringConfig } from '../../rankmap/procedural/RankRingConfig';
import { getRankDisplayName, getRankFromStars } from '../../rank/RankService';
import { el, setText } from '../ui/dom';

export class ProfileRanks {
  readonly element: HTMLElement;

  private curCard: HTMLElement;
  private curName: HTMLElement;
  private curStars: HTMLElement;
  private curBar: HTMLElement;
  private curSub: HTMLElement;

  private bestCard: HTMLElement;
  private bestName: HTMLElement;
  private bestStars: HTMLElement;
  private bestSub: HTMLElement;

  constructor(private hex: string) {
    this.element = el('div', 'nf-ranks');

    // ---- CURRENT RANK
    this.curCard = el('div', 'nf-rank-card nf-rc-cur');
    this.curCard.appendChild(el('span', 'nf-rank-k', 'CURRENT RANK'));
    const curMain = el('div', 'nf-rank-main');
    this.curName = el('b', 'nf-rank-v', '—');
    this.curStars = el('span', 'nf-rank-stars', '');
    curMain.appendChild(this.curName);
    curMain.appendChild(this.curStars);
    this.curCard.appendChild(curMain);
    const bar = el('div', 'nf-rank-bar');
    this.curBar = el('i', 'nf-rank-fill', '');
    bar.appendChild(this.curBar);
    this.curCard.appendChild(bar);
    this.curSub = el('span', 'nf-rank-sub', '');
    this.curCard.appendChild(this.curSub);
    this.element.appendChild(this.curCard);

    // ---- HIGHEST RANK
    this.bestCard = el('div', 'nf-rank-card nf-rc-best');
    this.bestCard.appendChild(el('span', 'nf-rank-k', 'HIGHEST RANK'));
    const bestMain = el('div', 'nf-rank-main');
    this.bestName = el('b', 'nf-rank-v', '—');
    this.bestStars = el('span', 'nf-rank-stars', '');
    bestMain.appendChild(this.bestName);
    bestMain.appendChild(this.bestStars);
    this.bestCard.appendChild(bestMain);
    this.bestSub = el('span', 'nf-rank-sub', '');
    this.bestCard.appendChild(this.bestSub);
    this.element.appendChild(this.bestCard);

    this.update();
  }

  update(): void {
    const player = ClientCache.shared.playerByHex(this.hex);
    if (!player) return;
    const stars = Math.max(0, player.rankPoints ?? 0);
    const placed = player.rankStatus !== 0 || stars > 0;

    // ---- current
    const info = getRankFromStars(stars);
    setText(this.curName, placed ? getRankDisplayName(stars) : 'UNRANKED');
    setText(this.curStars, placed ? `${info.stars}★` : '');
    this.curCard.classList.toggle('unplaced', !placed);
    this.curCard.style.setProperty('--rk', placed ? ringConfig(info.tier).accent : 'var(--ui-text-muted)');
    this.curBar.style.width = placed ? `${Math.round(Math.max(0, Math.min(1, info.progress)) * 100)}%` : '0%';
    setText(
      this.curSub,
      !placed
        ? 'Play a ranked match to place'
        : info.toNext > 0
          ? `${info.toNext}★ to ${getRankDisplayName(stars + info.toNext)}`
          : 'Apex of the ladder'
    );

    // ---- highest (the server's peak; legacy rows fall back to the current value)
    const best = Math.max(player.peakRankPoints ?? 0, stars);
    const bestInfo = getRankFromStars(best);
    const bestPlaced = best > 0 || player.rankStatus !== 0;
    setText(this.bestName, bestPlaced ? getRankDisplayName(best) : 'UNRANKED');
    setText(this.bestStars, bestPlaced ? `${bestInfo.stars}★` : '');
    this.bestCard.classList.toggle('unplaced', !bestPlaced);
    this.bestCard.style.setProperty('--rk', bestPlaced ? ringConfig(bestInfo.tier).accent : 'var(--ui-text-muted)');
    setText(
      this.bestSub,
      !bestPlaced ? 'Not placed yet' : best > stars ? `${best - stars}★ above current` : 'Matching your peak'
    );
  }
}
