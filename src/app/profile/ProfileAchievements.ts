// NECROFALL — profile achievents/medals row (plan §4).
//
// Achievements are a LATER feature: the row ships now with locked medals so
// the profile has its final shape, and the unlock logic can land without a
// layout change. Nothing here claims a player earned anything.
import { el } from '../ui/dom';

const MEDALS = ['First Blood', 'Fortress Breaker', 'Nexus Taker', 'Swarm Ender', 'Colony Hero'];

export class ProfileAchievements {
  readonly element: HTMLElement;

  constructor() {
    this.element = el('section', 'nf-profile-section');
    this.element.appendChild(el('h2', 'nf-section-title', 'ACHIEVEMENTS'));
    const row = el('div', 'nf-medals');
    for (const name of MEDALS) {
      const medal = el('div', 'nf-medal locked');
      medal.appendChild(el('span', 'nf-medal-icon', '✪'));
      medal.appendChild(el('span', 'nf-medal-name', name));
      medal.appendChild(el('span', 'nf-medal-soon', 'LOCKED'));
      row.appendChild(medal);
    }
    this.element.appendChild(row);
    this.element.appendChild(el('p', 'nf-muted', 'Achievements unlock in a later season.'));
  }
}
