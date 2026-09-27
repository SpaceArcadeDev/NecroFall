// NECROFALL — rank badge (plan §43: the system is COMING SOON, the shape ships now).
import { el } from './dom';

const RANK_NAMES = [
  'UNRANKED',
  'BRONZE',
  'SILVER',
  'GOLD',
  'MYTHIC',
];

export class RankBadge {
  readonly element: HTMLElement;
  private label: HTMLElement;

  constructor(currentRank: number) {
    this.element = el('div', 'nf-rank');
    this.element.appendChild(el('div', 'nf-rank-medal', '★'));
    this.label = el('div', 'nf-rank-label', RANK_NAMES[currentRank] ?? 'UNRANKED');
    this.element.appendChild(this.label);
    this.element.appendChild(el('div', 'nf-rank-soon', 'RANK — COMING SOON'));
  }

  setRank(rank: number): void {
    this.label.textContent = RANK_NAMES[rank] ?? 'UNRANKED';
  }
}
