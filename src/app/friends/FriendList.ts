// NECROFALL — friend list (plan §5/§67).
//
// Friends are MUTUAL follows — computed from the two follow subscriptions, so
// there is no friend table to drift out of sync. Online status rides presence.
import { ClientCache } from '../spacetimedb/cache';
import { subscribePlayer } from '../spacetimedb/subscriptions';
import { el, clear } from '../ui/dom';
import { ProfileCard, presenceLabel } from '../ui/ProfileCard';
import { hexOf } from '../spacetimedb/rows';

export class FriendList {
  readonly element: HTMLElement;
  private empty: HTMLElement;

  constructor(private myHex: () => string, private openProfile: (hex: string) => void) {
    this.element = el('div', 'nf-friend-list');
    this.empty = el('p', 'nf-muted', 'Follow each other to become friends.');
    this.element.appendChild(this.empty);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const me = this.myHex();
    clear(this.element);
    if (!me) return;

    const friends = cache.friends(me);
    // Names + presence for the cards ride per-player scopes; the whole-roster
    // subscription was removed (it made every client scan the `player` table).
    for (const hex of friends) subscribePlayer(hex);
    // Show online friends first (in match > online > offline), then by name.
    const rank = (hex: string): number => {
      const status = cache.presenceByHex(hex)?.status ?? 0;
      return status === 2 ? 0 : status === 1 ? 1 : 2;
    };
    friends.sort((a, b) => rank(a) - rank(b) || (cache.playerByHex(a)?.playerName ?? '').localeCompare(cache.playerByHex(b)?.playerName ?? ''));

    if (friends.length === 0) {
      this.element.appendChild(this.empty);
      return;
    }

    let currentSection = -1;
    const labels = ['IN MATCH', 'ONLINE', 'OFFLINE'];
    for (const hex of friends) {
      const section = rank(hex);
      if (section !== currentSection) {
        currentSection = section;
        this.element.appendChild(el('div', 'nf-friend-section', labels[section]));
      }
      const card = new ProfileCard(hex, () => this.openProfile(hex));
      card.update();
      this.element.appendChild(card.element);
      const status = cache.presenceByHex(hex)?.status ?? 0;
      card.element.title = presenceLabel(status);
    }
  }
}

/** Section heading used by both the rail and the full friends panel. */
export function friendCountLabel(myHex: string): string {
  const cache = ClientCache.shared;
  return `${cache.friends(myHex).length}`;
}

void hexOf;
