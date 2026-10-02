// NECROFALL — profile DISCOVERIES pane (reworked 2026-09-29, pass 2): the player's own
// first-footfall log (galaxies, systems and planets they charted first in the ranked
// universe), newest first, as a clean profile-website list.
//
// The server keeps only the coordinates; names are regenerated from the season seed
// (PlaceNames) exactly like the galactic map does.
import { ClientCache } from '../spacetimedb/cache';
import { relativeTime } from '../../rankmap/DiscoveryTypes';
import { clear, el, setText } from '../ui/dom';
import { activeUniverseSeed, discoveryPlace } from './PlaceNames';

const MAX_ROWS = 40;

function ordinal(n: number): string {
  if (n === 1) return '1ST';
  if (n === 2) return '2ND';
  if (n === 3) return '3RD';
  return `${n}TH`;
}

export class ProfileDiscoveries {
  readonly element: HTMLElement;
  private countEl: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private sig = '';

  constructor(private hex: string, private self: boolean) {
    this.element = el('section', 'nf-p-pane');

    // pane title removed (user ask 2026-10-03) — the rail names the section; the count
    // span keeps updating in the background.
    this.countEl = el('span', 'nf-p-pane-count', '');

    this.list = el('div', 'nf-p-rows');
    this.element.appendChild(this.list);
    this.empty = el(
      'p',
      'nf-p-empty',
      this.self
        ? 'Nothing charted yet — finish a ranked match to claim worlds.'
        : 'No worlds charted yet.'
    );
    this.element.appendChild(this.empty);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const all = cache.discoveriesByPlayer(this.hex);
    const rows = all.slice(0, MAX_ROWS);
    const sig = rows.map((r) => `${r.id}:${r.discoveryIndex}:${r.locationKey}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.list);
    this.empty.classList.toggle('hidden', rows.length > 0);

    const firsts = all.filter((r) => r.discoveryIndex === 1).length;
    setText(this.countEl, `${all.length} charted · ${firsts} first`);
    if (rows.length === 0) return;

    const seed = activeUniverseSeed();
    const now = cache.serverNowUs();
    for (const row of rows) {
      const place = discoveryPlace(seed, row);
      const item = el('div', `nf-p-row disc${row.discoveryIndex === 1 ? ' first' : ''}`);
      item.appendChild(el('span', 'nf-p-disc-ix', ordinal(row.discoveryIndex)));

      const mid = el('div', 'nf-p-row-mid');
      const nameLine = el('span', 'nf-p-row-place');
      nameLine.appendChild(el('i', 'nf-p-row-planet-ico', row.discoveryIndex === 1 ? '★' : '◆'));
      nameLine.appendChild(el('b', 'nf-p-row-planet', place.name.toUpperCase()));
      mid.appendChild(nameLine);
      mid.appendChild(el('span', 'nf-p-row-meta', `${place.kind} · RING ${place.ring}`));
      item.appendChild(mid);

      const right = el('div', 'nf-p-row-right');
      right.appendChild(el('span', 'nf-p-row-ago', relativeTime(Number(row.discoveredAt), now)));
      item.appendChild(right);

      this.list.appendChild(item);
    }
  }
}
