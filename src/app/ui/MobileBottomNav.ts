// NECROFALL — the FLOATING navigation bar (overhaul §4/§17/§25/§37; user ask
// 2026-10-03): EVENTS · CUSTOMIZE · MAP · MODES · [last-played mode]. MODES opens
// the format menu; the hero button IS the mode the player last launched — its own
// icon and label, and for RANK the golden star row from the rank menu. The shell
// repaints it through `setMode()` on every data tick.
import { button, el } from './dom';
import { getIcon } from '../../ui/icons';

export type BottomNavKey = 'events' | 'customize' | 'map' | 'modes' | 'mode';

export class MobileBottomNav {
  readonly element: HTMLElement;
  private buttons = new Map<BottomNavKey, HTMLButtonElement>();
  /** The hero button's star row (RANK only) — swapped by `setMode`. */
  private stars!: HTMLElement;

  constructor(onSelect: (key: BottomNavKey) => void) {
    this.element = el('nav', 'nf-bottom');
    this.element.setAttribute('aria-label', 'Primary navigation');

    const entries: { key: BottomNavKey; label: string; icon: string; action: string }[] = [
      { key: 'events', label: 'EVENTS', icon: 'events', action: 'events' },
      { key: 'customize', label: 'CUSTOMIZE', icon: 'wand', action: 'customize' },
      { key: 'map', label: 'MAP', icon: 'orbit', action: 'map' },
      { key: 'modes', label: 'MODES', icon: 'grid', action: 'modes' },
      { key: 'mode', label: 'CLASSIC', icon: 'swords', action: 'play' },
    ];

    for (const entry of entries) {
      const isMode = entry.key === 'mode';
      const b = button('', isMode ? 'nf-bottom-btn nf-bottom-play' : 'nf-bottom-btn', () => onSelect(entry.key));
      b.setAttribute('aria-label', entry.label);
      b.dataset.action = entry.action;
      const icon = el('span', 'nf-bottom-icon');
      icon.innerHTML = getIcon(entry.icon);
      b.appendChild(icon);
      b.appendChild(el('span', 'nf-bottom-label', entry.label));
      if (isMode) {
        // the golden star row rides under the label when the mode is RANK (user ask)
        this.stars = el('span', 'nf-bottom-stars rk-stars-row hidden');
        b.appendChild(this.stars);
      }
      this.element.appendChild(b);
      this.buttons.set(entry.key, b);
    }
  }

  /** The hero button follows the LAST-PLAYED mode (user ask 2026-10-03). */
  setMode(mode: { id: string; title: string; icon: string }, starsHtml: string | null): void {
    const b = this.buttons.get('mode');
    if (!b) return;
    b.dataset.mode = mode.id;
    b.setAttribute('aria-label', `Play ${mode.title}`);
    const icon = b.querySelector('.nf-bottom-icon');
    if (icon) icon.innerHTML = getIcon(mode.icon);
    const label = b.querySelector('.nf-bottom-label');
    if (label) label.textContent = mode.title;
    this.stars.innerHTML = starsHtml ?? '';
    this.stars.classList.toggle('hidden', !starsHtml);
  }

  setActive(key: BottomNavKey | null): void {
    for (const [k, b] of this.buttons) b.classList.toggle('on', k === key);
  }
}
