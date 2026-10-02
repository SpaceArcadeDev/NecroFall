// NECROFALL — the FLOATING navigation bar (overhaul §17/§30): the primary
// MOBA loop — PLAY · GALAXY · FRIENDS · PROFILE · MORE. PLAY is the hero tab;
// MORE opens the secondary drawer (§31) so nothing has to be deleted to fit.
// Shown at every width — it is the only navigation the shell has.
import { button, el } from './dom';
import { getIcon } from '../../ui/icons';

export type BottomNavKey = 'play' | 'galaxy' | 'friends' | 'profile' | 'more';

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
      { key: 'profile', label: 'PROFILE', icon: 'user' },
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
