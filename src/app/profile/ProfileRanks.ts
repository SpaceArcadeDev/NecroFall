// NECROFALL — the profile RANK plates (user ask 2026-09-29, pass 2): CURRENT RANK and
// HIGHEST RANK as two badge plates — a band-coloured emblem, the rank in display type,
// a gold star row for the division's progress and a hairline meter.
//
// Current = `player.rankPoints` (the ladder is one integer, see RankService).
// Highest = `player.peakRankPoints`, the max the server has ever recorded — with a
// legacy fallback to `max(peak, current)` so accounts predating the column still read
// their true standing.
import { ClientCache } from '../spacetimedb/cache';
import { ringConfig } from '../../rankmap/procedural/RankRingConfig';
import { getRankDisplayName, getRankFromStars, TIER_LIBERATOR, type RankInfo } from '../../rank/RankService';
import { el, setText } from '../ui/dom';

interface Plate {
  card: HTMLElement;
  name: HTMLElement;
  starRow: HTMLElement;
  stars: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  sub: HTMLElement;
}

/** The lit/unlit star row of the current division ('' for the high personal-star tiers). */
function starGlyphs(info: RankInfo): string {
  if (info.tier >= TIER_LIBERATOR) return '';
  const per = Math.max(1, Math.min(7, info.stars + info.toNext));
  return '★'.repeat(Math.min(info.stars, per)) + '☆'.repeat(Math.max(0, per - info.stars));
}

export class ProfileRanks {
  readonly element: HTMLElement;
  private current: Plate;
  private best: Plate;

  constructor(private hex: string) {
    this.element = el('div', 'nf-ranks');
    this.current = this.buildPlate('CURRENT');
    this.best = this.buildPlate('HIGHEST');
    this.update();
  }

  private buildPlate(label: string): Plate {
    const card = el('div', 'nf-rank-card');
    const top = el('div', 'nf-rank-top');
    top.appendChild(el('span', 'nf-rank-emblem', '★'));
    top.appendChild(el('span', 'nf-rank-k', label));
    card.appendChild(top);
    const name = el('b', 'nf-rank-v', '—');
    card.appendChild(name);

    const row = el('div', 'nf-rank-row');
    const starRow = el('span', 'nf-rank-starrow', '');
    row.appendChild(starRow);
    const stars = el('span', 'nf-rank-stars', '');
    row.appendChild(stars);
    card.appendChild(row);

    const bar = el('div', 'nf-rank-bar');
    const fill = el('i', 'nf-rank-fill', '');
    bar.appendChild(fill);
    card.appendChild(bar);

    const sub = el('span', 'nf-rank-sub', '');
    card.appendChild(sub);

    this.element.appendChild(card);
    return { card, name, starRow, stars, bar, fill, sub };
  }

  update(): void {
    const player = ClientCache.shared.playerByHex(this.hex);
    if (!player) return;

    // ---- CURRENT RANK
    const stars = Math.max(0, player.rankPoints ?? 0);
    const placed = player.rankStatus !== 0 || stars > 0;
    this.paint(this.current, placed, stars, getRankFromStars(stars), true);

    // ---- HIGHEST RANK (the server's peak; legacy rows fall back to the current value)
    const best = Math.max(player.peakRankPoints ?? 0, stars);
    const bestPlaced = best > 0 || player.rankStatus !== 0;
    this.paint(this.best, bestPlaced, best, getRankFromStars(best), false);
    this.best.card.classList.toggle('is-peak', bestPlaced && best > stars);
    setText(
      this.best.sub,
      !bestPlaced ? 'Not placed yet' : best > stars ? `${best - stars}★ above your current rank` : 'Matching your peak'
    );
  }

  private paint(plate: Plate, placed: boolean, stars: number, info: RankInfo, current: boolean): void {
    plate.card.style.setProperty('--rk', placed ? ringConfig(info.tier).accent : 'var(--ui-text-muted)');
    plate.card.classList.toggle('unplaced', !placed);
    setText(plate.name, placed ? getRankDisplayName(stars) : 'UNRANKED');

    const glyphs = placed ? starGlyphs(info) : '';
    setText(plate.starRow, glyphs);
    plate.starRow.classList.toggle('hidden', glyphs === '');
    setText(plate.stars, placed ? `${info.stars}★` : '');
    plate.bar.classList.toggle('hidden', !placed);
    plate.fill.style.width = placed ? `${Math.round(Math.max(0, Math.min(1, info.progress)) * 100)}%` : '0%';

    // Only the CURRENT plate carries a sub line (the peak's is set by `update`).
    if (current) {
      setText(
        plate.sub,
        !placed
          ? 'Play a ranked match to place'
          : info.toNext > 0
            ? `${info.toNext}★ to ${getRankDisplayName(stars + info.toNext)}`
            : 'Apex of the ladder'
      );
    }
  }
}
