// NECROFALL — profile MATCH HISTORY pane (user ask 2026-09-29: history now
// shows WHICH PLANET each match was fought on).
//
// The planet is regenerated from the row's `planetKey` + the active season
// seed (PlanetNames), never stored as text — classic matches have no
// persistent planet and say so. Rows rebuild only when the underlying data
// changes (a signature check), the relative time refreshes with it.
import { ClientCache } from '../spacetimedb/cache';
import { relativeTime } from '../../rankmap/DiscoveryTypes';
import { clear, el, formatDuration } from '../ui/dom';
import { activeUniverseSeed, planetLabelFromKey } from './PlaceNames';

const MAX_ROWS = 12;

export class ProfileHistory {
  readonly element: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private sig = '';

  constructor(private hex: string) {
    this.element = el('section', 'nf-p-pane');
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
        const glyph = el('i', 'nf-p-row-planet-ico', '◆');
        place.appendChild(glyph);
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
      right.appendChild(el('span', 'nf-p-row-ago', relativeTime(Number(row.endedAt.microsSinceUnixEpoch), now)));
      right.appendChild(el('span', 'nf-p-row-reward', `+${row.softCurrencyEarned}`));
      item.appendChild(right);

      this.list.appendChild(item);
    }
  }
}
