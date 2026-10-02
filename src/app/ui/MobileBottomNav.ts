// NECROFALL — the FLOATING navigation bar (overhaul §4/§17/§25/§37; user ask
// 2026-10-03): the four destinations of the MOBA loop — EVENTS · CUSTOMIZE ·
// MAP · PLAY. MAP opens the intergalactic map, CUSTOMIZE steps into the
// character customizer, PLAY is the format menu. Profile stays on the identity
// chip (top-left) and settings on the gear — one entry point per destination.
import { button, el } from './dom';
import { getIcon } from '../../ui/icons';

export type BottomNavKey = 'events' | 'customize' | 'map' | 'play';

export class MobileBottomNav {
  readonly element: HTMLElement;
  private buttons = new Map<BottomNavKey, HTMLButtonElement>();

  constructor(onSelect: (key: BottomNavKey) => void) {
    this.element = el('nav', 'nf-bottom');
    this.element.setAttribute('aria-label', 'Primary navigation');

    const entries: { key: BottomNavKey; label: string; icon: string }[] = [
      { key: 'events', label: 'EVENTS', icon: 'events' },
      { key: 'customize', label: 'CUSTOMIZE', icon: 'wand' },
      { key: 'map', label: 'MAP', icon: 'orbit' },
      { key: 'play', label: 'PLAY', icon: 'play' },
    ];

    for (const entry of entries) {
      const isPlay = entry.key === 'play';
      const b = button('', isPlay ? 'nf-bottom-btn nf-bottom-play' : 'nf-bottom-btn', () => onSelect(entry.key));
      b.setAttribute('aria-label', entry.label);
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
