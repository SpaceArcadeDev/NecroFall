// NECROFALL — the FLOATING navigation bar (overhaul §4/§17/§25/§37): the primary
// MOBA loop — PLAY · GALAXY · FRIENDS · MORE. PROFILE is deliberately NOT here:
// the player identity card (top-left) is its permanent entry point, and
// SETTINGS lives on the top-right gear + the MORE drawer — one entry point per
// destination, and nothing is removed (overhaul §36/§37: consolidate, never cut).
import { button, el } from './dom';
import { getIcon } from '../../ui/icons';

export type BottomNavKey = 'play' | 'galaxy' | 'friends' | 'more';

export class MobileBottomNav {
  readonly element: HTMLElement;
  private buttons = new Map<BottomNavKey, HTMLButtonElement>();

  constructor(onSelect: (key: BottomNavKey) => void) {
    this.element = el('nav', 'nf-bottom');
    this.element.setAttribute('aria-label', 'Primary navigation');

    const entries: { key: BottomNavKey; label: string; icon: string }[] = [
      { key: 'play', label: 'PLAY', icon: 'play' },
      { key: 'galaxy', label: 'GALAXY', icon: 'orbit' },
      { key: 'friends', label: 'FRIENDS', icon: 'users' },
      { key: 'more', label: 'MORE', icon: 'more' },
    ];

    for (const entry of entries) {
      const isPlay = entry.key === 'play';
      const b = button('', isPlay ? 'nf-bottom-btn nf-bottom-play' : 'nf-bottom-btn', () => onSelect(entry.key));
      b.setAttribute('aria-label', entry.label === 'MORE' ? 'More — settings and account' : entry.label);
      b.dataset.action = entry.key;
      const icon = el('span', 'nf-bottom-icon');
      icon.innerHTML = getIcon(entry.icon);
      b.appendChild(icon);
      b.appendChild(el('span', 'nf-bottom-label', entry.label));
      this.element.appendChild(b);
      this.buttons.set(entry.key, b);
    }
  }

  setActive(key: BottomNavKey | null): void {
    for (const [k, b] of this.buttons) b.classList.toggle('on', k === key);
  }
}
