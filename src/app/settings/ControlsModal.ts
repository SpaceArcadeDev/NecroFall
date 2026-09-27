// NECROFALL — CONTROLS sheet (plan §37): the full key list with live REMAP.
// Remaps are saved to the player's account (`player_settings` row) so they
// follow them across devices. Mouse aim and the mobile touch pad are fixed.
import { BIND_LABELS, BIND_ORDER, keyLabel, Keybinds, type BindAction } from '../../input/Keybinds';
import { setKeybinds } from '../spacetimedb/reducers';
import { ShellContext } from '../ShellContext';
import { button, clear, el } from '../ui/dom';

export class ControlsModal {
  private overlay: HTMLElement;
  private list: HTMLElement;
  private listening: BindAction | null = null;

  constructor(private ctx: ShellContext) {
    this.overlay = el('div', 'nf-modal hidden');
    const card = el('div', 'nf-modal-card nf-controls-card');

    const head = el('div', 'nf-search-head');
    head.appendChild(el('h2', 'nf-search-title', 'CONTROLS'));
    const closeBtn = button('✕', 'nf-btn ghost small', () => this.close());
    closeBtn.setAttribute('aria-label', 'Close controls');
    head.appendChild(closeBtn);
    card.appendChild(head);

    card.appendChild(
      el('p', 'nf-muted nf-search-hint', 'Click REMAP, then press the key you want. Changes save to your account.')
    );

    this.list = el('div', 'nf-controls-list');
    card.appendChild(this.list);

    card.appendChild(
      button('RESET TO DEFAULTS', 'nf-btn nf-small', () => {
        Keybinds.reset();
        this.persist('Controls reset to defaults.');
        this.render();
      })
    );
    card.appendChild(el('p', 'nf-muted nf-search-hint', 'Mouse aim and the mobile touch controls are fixed.'));

    this.overlay.appendChild(card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    // any change (here or from a sync) repaints the rows
    Keybinds.onChange(() => this.render());
  }

  open(host: HTMLElement): void {
    if (!this.overlay.isConnected) host.appendChild(this.overlay);
    this.overlay.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.listening = null;
    this.overlay.classList.add('hidden');
  }

  /** Push the current table to the account and confirm with a toast. */
  private persist(message: string): void {
    setKeybinds(Keybinds.serialize());
    this.ctx.toast(message);
  }

  private beginRemap(action: BindAction): void {
    this.listening = action;
    this.render();
    const capture = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.removeEventListener('keydown', capture, true);
      const target = this.listening;
      this.listening = null;
      if (!target) {
        this.render();
        return;
      }
      if (e.code === 'Escape') {
        this.render(); // cancel — Escape stays the pause key
        return;
      }
      const owner = Keybinds.owner(e.code);
      if (owner && owner !== target) {
        this.ctx.toast(`${keyLabel(e.code)} is already bound to ${BIND_LABELS[owner]}.`);
        this.render();
        return;
      }
      Keybinds.set(target, e.code);
      this.persist(`${BIND_LABELS[target]} → ${keyLabel(e.code)}`);
      this.render();
    };
    window.addEventListener('keydown', capture, true);
  }

  private render(): void {
    clear(this.list);
    for (const action of BIND_ORDER) {
      const row = el('div', 'nf-control-row');
      row.appendChild(el('span', 'nf-control-name', BIND_LABELS[action]));
      const listening = this.listening === action;
      row.appendChild(
        el('span', 'nf-control-key' + (listening ? ' listening' : ''), listening ? 'PRESS A KEY…' : keyLabel(Keybinds.get(action)))
      );
      const remap = button('REMAP', 'nf-btn small nf-code-btn', () => this.beginRemap(action));
      if (listening) remap.classList.add('on');
      row.appendChild(remap);
      this.list.appendChild(row);
    }
  }
}
