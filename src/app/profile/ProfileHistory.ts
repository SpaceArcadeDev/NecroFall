// NECROFALL — profile MATCH HISTORY pane (reworked 2026-09-29, pass 2: a clean results
// list in the profile-website language; the planet each ranked match was fought on is
// shown by name).
//
// The planet is regenerated from the row's `planetKey` + the active season seed
// (PlaceNames), never stored as text — classic matches have no persistent planet and say
// so. Rows rebuild only when the underlying data changes (a signature check).
import { ClientCache } from '../spacetimedb/cache';
import { relativeTime } from '../../rankmap/DiscoveryTypes';
import { clear, el, formatDuration, setText } from '../ui/dom';
import { activeUniverseSeed, planetLabelFromKey } from './PlaceNames';

const MAX_ROWS = 12;

export class ProfileHistory {
  readonly element: HTMLElement;
  private countEl: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private sig = '';

  constructor(private hex: string) {
    this.element = el('section', 'nf-p-pane');

    // pane title removed (user ask 2026-10-03) — the rail names the section; the count
    // span keeps updating in the background.
    this.countEl = el('span', 'nf-p-pane-count', '');

    this.list = el('div', 'nf-p-rows');
    this.element.appendChild(this.list);
    this.empty = el('p', 'nf-p-empty', 'No matches yet — the arena awaits.');
    this.element.appendChild(this.empty);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const rows = cache.historyFor(this.hex).slice(0, MAX_ROWS);
    const sig = rows
      .map((r) =>
        [r.id, r.won ? 1 : 0, r.kills, r.deaths, r.objectives, r.durationSeconds, Number(r.softCurrencyEarned), r.planetKey].join(':')
      )
      .join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.list);
    this.empty.classList.toggle('hidden', rows.length > 0);

    const all = cache.historyFor(this.hex);
    const wins = all.filter((r) => r.won).length;
    setText(this.countEl, `${all.length} played · ${wins} won`);
    if (rows.length === 0) return;

    const seed = activeUniverseSeed();
    const now = cache.serverNowUs();
    for (const row of rows) {
      const item = el('div', `nf-p-row ${row.won ? 'win' : 'loss'}`);
      item.appendChild(el('span', 'nf-p-row-res', row.won ? 'WIN' : 'LOSS'));

      const mid = el('div', 'nf-p-row-mid');
      const place = el('span', 'nf-p-row-place');
      const planet = row.planetKey ? planetLabelFromKey(seed, row.planetKey) : null;
      if (planet) {
        place.appendChild(el('i', 'nf-p-row-planet-ico', '◆'));
        place.appendChild(el('b', 'nf-p-row-planet', planet.name.toUpperCase()));
        place.appendChild(el('em', 'nf-p-row-ring', `R${planet.ring}`));
      } else {
        place.appendChild(el('span', 'nf-p-row-classic', 'CLASSIC ARENA'));
      }
      mid.appendChild(place);
      mid.appendChild(
        el(
          'span',
          'nf-p-row-meta',
          `${formatDuration(row.durationSeconds)} · ${row.kills}K · ${row.deaths}D · ${row.objectives}O`
        )
      );
      item.appendChild(mid);

      const right = el('div', 'nf-p-row-right');
      right.appendChild(el('span', 'nf-p-row-reward', `+${row.softCurrencyEarned}`));
      right.appendChild(el('span', 'nf-p-row-ago', relativeTime(Number(row.endedAt.microsSinceUnixEpoch), now)));
      item.appendChild(right);

      this.list.appendChild(item);
    }
  }
}
