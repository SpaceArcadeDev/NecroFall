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
  // the MAGIC WAND: a tilted shaft with a collar, a four-point star at the tip and two sparks
  customize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 20.4L14 10"/><path d="M12.4 8.4l3.2 3.2"/><path d="M17.8 2.6l.75 2.05 2.05.75-2.05.75-.75 2.05-.75-2.05-2.05-.75 2.05-.75z"/><path d="M7.4 3.4l.5 1.35 1.35.5-1.35.5-.5 1.35-.5-1.35-1.35-.5 1.35-.5z"/><path d="M19.6 13.4l.45 1.2 1.2.45-1.2.45-.45 1.2-.45-1.2-1.2-.45 1.2-.45z"/></svg>',
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
