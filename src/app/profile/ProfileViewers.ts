// NECROFALL — recent profile viewers (plan §4/§6).
//
// Fed by the upserted `profile_view` rows (one per viewer, throttled server
// side). Avatars resolve through the per-player subscription; a small budget
// keeps a popular profile from pulling hundreds of rows.
import { ClientCache } from '../spacetimedb/cache';
import { subscribePlayer } from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { el, clear } from '../ui/dom';
import { ProfileCard } from '../ui/ProfileCard';

const MAX_VIEWER_CARDS = 12;

export class ProfileViewers {
  readonly element: HTMLElement;
  private row: HTMLElement;

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('section', 'nf-profile-section');
    this.element.appendChild(el('h2', 'nf-section-title', 'RECENT VISITORS'));
    this.row = el('div', 'nf-viewers');
    this.element.appendChild(this.row);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    clear(this.row);
    const viewers = cache.profileViewers(this.hex).slice(0, MAX_VIEWER_CARDS);
    // A fresh profile has no visitors: hide the section instead of an empty promise.
    if (viewers.length === 0) {
      this.element.classList.add('hidden');
      return;
    }
    this.element.classList.remove('hidden');
    for (const view of viewers) {
      const viewerHex = view.viewer.toHexString();
      if (!cache.playerByHex(viewerHex)) subscribePlayer(viewerHex);
      const card = new ProfileCard(viewerHex, () => this.ctx.openProfile(viewerHex));
      card.update();
      this.row.appendChild(card.element);
    }
  }
}
