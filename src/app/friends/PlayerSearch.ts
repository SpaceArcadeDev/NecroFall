// NECROFALL — find-survivors sheet (plan §8/§64): search the roster by player
// name OR the short friend code, then jump straight to that profile. The roster
// (whole `player` table) is subscribed with the account scope, so results are
// live — a player who renames or onboards shows up without a refresh.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { hexOf, PlayerRow } from '../spacetimedb/rows';
import { button, clear, el } from '../ui/dom';

export class PlayerSearch {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private unsub: (() => void) | null = null;

  constructor(private myHex: () => string, private openProfile: (hex: string) => void) {
    this.overlay = el('div', 'nf-modal hidden');
    const card = el('div', 'nf-modal-card nf-search-card');

    const head = el('div', 'nf-search-head');
    head.appendChild(el('h2', 'nf-search-title', 'FIND SURVIVORS'));
    const closeBtn = button('✕', 'nf-btn ghost small', () => this.close());
    closeBtn.setAttribute('aria-label', 'Close search');
    head.appendChild(closeBtn);
    card.appendChild(head);

    this.input = el('input', 'nf-input') as HTMLInputElement;
    this.input.placeholder = 'Player name or friend code';
    this.input.maxLength = 24;
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.close();
    });
    card.appendChild(this.input);

    card.appendChild(
      el('p', 'nf-muted nf-search-hint', 'Every survivor has a short code — copy yours from your profile and share it.')
    );

    this.results = el('div', 'nf-search-results');
    card.appendChild(this.results);

    this.overlay.appendChild(card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  open(host: HTMLElement): void {
    if (!this.overlay.isConnected) host.appendChild(this.overlay);
    this.overlay.classList.remove('hidden');
    this.input.value = '';
    if (!this.unsub) this.unsub = ClientCache.shared.onChange(() => this.render());
    this.render();
    this.input.focus();
  }

  close(): void {
    this.overlay.classList.add('hidden');
    this.unsub?.();
    this.unsub = null;
  }

  /** Ranked matches: exact code, code prefix, exact name, name prefix, then substring. */
  private matches(query: string): PlayerRow[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const mine = this.myHex();
    const scored: { p: PlayerRow; s: number }[] = [];
    for (const p of ClientCache.shared.allPlayers()) {
      if (!p.playerName || !p.playerName.trim()) continue; // not onboarded yet
      if (hexOf(p.identity) === mine) continue;
      const code = (p.playerCode || '').toLowerCase();
      const name = p.playerName.toLowerCase();
      let s = -1;
      if (code === needle) s = 0;
      else if (code.startsWith(needle)) s = 1;
      else if (name === needle) s = 2;
      else if (name.startsWith(needle)) s = 3;
      else if (name.includes(needle)) s = 4;
      if (s >= 0) scored.push({ p, s });
    }
    return scored
      .sort((a, b) => a.s - b.s || a.p.playerName.localeCompare(b.p.playerName))
      .slice(0, 24)
      .map(x => x.p);
  }

  private render(): void {
    clear(this.results);
    if (!this.input.value.trim()) {
      this.results.appendChild(el('p', 'nf-muted', 'Start typing a name or a friend code.'));
      return;
    }
    const rows = this.matches(this.input.value);
    if (rows.length === 0) {
      this.results.appendChild(el('p', 'nf-muted', 'No survivors found.'));
      return;
    }
    for (const p of rows) {
      const hex = hexOf(p.identity);
      const row = button('', 'nf-search-row', () => this.openProfile(hex));
      row.appendChild(el('span', 'nf-search-avatar', (p.playerName[0] || '?').toUpperCase()));
      const col = el('span', 'nf-search-col');
      col.appendChild(el('span', 'nf-search-name', p.playerName));
      const colony = p.colony < COLONIES.length ? COLONIES[p.colony] : null;
      col.appendChild(
        el('span', 'nf-search-meta', `${p.playerCode || '——————'} · ${colony ? colony.name : 'NO COLONY'} · LV ${p.level}`)
      );
      row.appendChild(col);
      this.results.appendChild(row);
    }
  }
}
