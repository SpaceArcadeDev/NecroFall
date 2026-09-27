// NECROFALL — the FLOATING navigation bar (plan §8/§36/§37): a MOBA-style pill
// that hovers above the world, with a raised PLAY button that pops OUT of the
// bar (so the bar keeps its slim height) and a glowing active state. Shown at
// every width — it is the only navigation the shell has.
import { button, el } from './dom';

export type BottomNavKey = 'events' | 'customize' | 'play';

/** Line icons, drawn inline so the bar needs no image assets. */
const ICONS: Record<BottomNavKey, string> = {
  events:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.8" y="5" width="16.4" height="15" rx="2.4"/><path d="M3.8 9.6h16.4"/><path d="M8.2 3.4v3"/><path d="M15.8 3.4v3"/><path d="M12 12.4l.9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z"/></svg>',
  customize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5c1.8-.5 3.1-1 4.2-2.1 1.4-1.4 1.6-3.3 3-4.7l7-7-2.4-2.4-7 7c-1.4 1.4-3.3 1.6-4.7 3-1.1 1.1-1.6 2.4-2.1 4.2z"/><path d="M14.5 7.5l2 2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 6.4v11.2c0 .8.9 1.3 1.6.9l8.3-5.6c.6-.4.6-1.4 0-1.8l-8.3-5.6c-.7-.4-1.6.1-1.6.9z"/></svg>',
};

export class MobileBottomNav {
  readonly element: HTMLElement;
  private buttons = new Map<BottomNavKey, HTMLButtonElement>();

  constructor(onSelect: (key: BottomNavKey) => void) {
    this.element = el('nav', 'nf-bottom');
    // EVENTS · CUSTOMIZE · PLAY — PLAY is the hero, anchored to the right end.
    const entries: { key: BottomNavKey; label: string }[] = [
      { key: 'events', label: 'Events' },
      { key: 'customize', label: 'Customize' },
      { key: 'play', label: 'PLAY' },
    ];
    for (const entry of entries) {
      const isPlay = entry.key === 'play';
      const b = button('', isPlay ? 'nf-bottom-btn nf-bottom-play' : 'nf-bottom-btn', () => onSelect(entry.key));
      b.setAttribute('aria-label', isPlay ? 'Play' : entry.label);
      const icon = el('span', 'nf-bottom-icon');
      icon.innerHTML = ICONS[entry.key];
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
