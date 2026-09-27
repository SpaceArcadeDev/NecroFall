// NECROFALL — the OFFICIAL / P2P toggle (plan §9/§35). The choice is remembered
// locally; it is the ONLY place the two multiplayer worlds meet.
import { MultiplayerMode, saveMultiplayerMode } from '../multiplayer/MultiplayerMode';
import { el } from '../ui/dom';

export class MultiplayerModeToggle {
  readonly element: HTMLElement;
  private opts = new Map<MultiplayerMode, HTMLButtonElement>();
  private value: MultiplayerMode;

  constructor(initial: MultiplayerMode, private onChange: (mode: MultiplayerMode) => void, p2pEnabled: boolean) {
    this.value = initial;
    // A segmented control in the in-game settings language — one glance, one tap.
    this.element = el('div', 'nf-toggle');
    const entries: { mode: MultiplayerMode; label: string; sub: string }[] = [
      { mode: 'official', label: 'OFFICIAL', sub: 'spacetimedb server' },
      { mode: 'p2p', label: 'P2P', sub: 'host your lobby' },
    ];
    for (const entry of entries) {
      const b = el('button', 'nf-toggle-opt') as HTMLButtonElement;
      b.type = 'button';
      b.appendChild(el('span', 'nf-toggle-name', entry.label));
      b.appendChild(el('span', 'nf-toggle-sub', entry.sub));
      const disabled = entry.mode === 'p2p' && !p2pEnabled;
      if (disabled) {
        b.disabled = true;
        b.classList.add('disabled');
      }
      b.addEventListener('click', () => this.select(entry.mode));
      this.element.appendChild(b);
      this.opts.set(entry.mode, b);
    }
    this.paint();
  }

  get mode(): MultiplayerMode {
    return this.value;
  }

  select(mode: MultiplayerMode): void {
    if (this.value === mode) return;
    this.value = mode;
    saveMultiplayerMode(mode);
    this.paint();
    this.onChange(mode);
  }

  private paint(): void {
    for (const [mode, b] of this.opts) b.classList.toggle('on', mode === this.value);
  }
}
