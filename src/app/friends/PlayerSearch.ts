// NECROFALL — find-survivors sheet (plan §8/§64): search by player name OR the
// short friend code, then jump straight to that profile. The lookup is a server
// PROCEDURE (`searchPlayers`): nothing is replicated, the whole-table `player`
// subscription is gone, and the server ranks + caps the results (code exact →
// code prefix → name exact → name prefix → substring).
import { COLONIES } from '../../core/Config';
import { searchPlayers } from '../spacetimedb/reducers';
import { PlayerSearchHitRow } from '../spacetimedb/rows';
import { button, clear, el } from '../ui/dom';

/** Keystrokes are debounced into one procedure call — the server is the index. */
const DEBOUNCE_MS = 180;

export class PlayerSearch {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  /** Latest server results; only the response matching the newest query is applied. */
  private hits: PlayerSearchHitRow[] = [];
  private timer = 0;
  private reqToken = 0;

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
    this.input.addEventListener('input', () => this.onInput());
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
    this.hits = [];
    this.showMessage('Start typing a name or a friend code.');
    this.input.focus();
  }

  close(): void {
    this.overlay.classList.add('hidden');
    this.reqToken++; // ignore any in-flight response
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
  }

  /** Debounce keystrokes; the server ranks and caps the result list. */
  private onInput(): void {
    if (this.timer) window.clearTimeout(this.timer);
    const query = this.input.value.trim();
    if (!query) {
      this.reqToken++;
      this.hits = [];
      this.showMessage('Start typing a name or a friend code.');
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.runSearch(query);
    }, DEBOUNCE_MS);
  }

  private async runSearch(query: string): Promise<void> {
    const token = ++this.reqToken;
    let hits: PlayerSearchHitRow[] | null = null;
    try {
      hits = await searchPlayers(query);
    } catch (err) {
      console.warn('[NECROFALL] player search failed', err);
    }
    if (token !== this.reqToken || this.overlay.classList.contains('hidden')) return;
    if (hits === null) {
      this.hits = [];
      this.showMessage('Search is unavailable offline.');
      return;
    }
    this.hits = hits;
    this.renderResults();
  }

  private showMessage(text: string): void {
    clear(this.results);
    this.results.appendChild(el('p', 'nf-muted', text));
  }

  /** Results arrive already ranked + capped by the server (`searchPlayers`). */
  private renderResults(): void {
    clear(this.results);
    if (this.hits.length === 0) {
      this.results.appendChild(el('p', 'nf-muted', 'No survivors found.'));
      return;
    }
    const mine = this.myHex();
    for (const p of this.hits) {
      const hex = p.identity.toHexString();
      if (hex === mine) continue; // the server already skips self — belt and braces
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
