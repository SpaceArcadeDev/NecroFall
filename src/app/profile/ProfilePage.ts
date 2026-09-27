// NECROFALL — the full profile page (plan §4/§26/§48).
//
// Subscribes ONLY to the viewed profile while it is open (plan §23/§48) and
// records the visit through a single throttled reducer call. Own profile gains
// the edit affordances and the friends list; another player's profile shows
// the public views only.
import { ClientCache } from '../spacetimedb/cache';
import { recordProfileView } from '../spacetimedb/reducers';
import { releaseProfile, subscribePlayer, subscribeProfile } from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { clear, el, formatDuration } from '../ui/dom';
import { ProfileCard } from '../ui/ProfileCard';
import { ProfileHeader } from './ProfileHeader';
import { ProfileSocial } from './ProfileSocial';
import { ProfileStats } from './ProfileStats';
import { ProfileViewers } from './ProfileViewers';

export class ProfilePage {
  readonly element: HTMLElement;
  private header: ProfileHeader;
  private stats: ProfileStats;
  private social: ProfileSocial;
  private viewers: ProfileViewers;
  private history: HTMLElement;
  private friends: HTMLElement;
  private friendsBody: HTMLElement;

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('div', 'nf-page profile-page');
    this.header = new ProfileHeader(ctx, hex);
    this.element.appendChild(this.header.element);
    this.stats = new ProfileStats(hex);
    this.element.appendChild(this.stats.element);

    // Own profile: the friends list lives here (friendship = mutual follow, plan §5).
    this.friends = el('section', 'nf-profile-section');
    this.friends.appendChild(el('h2', 'nf-section-title', 'FRIENDS'));
    this.friendsBody = el('div', 'nf-friends-grid');
    this.friends.appendChild(this.friendsBody);
    if (hex === ctx.myHex()) this.element.appendChild(this.friends);

    this.history = el('section', 'nf-profile-section');
    this.history.appendChild(el('h2', 'nf-section-title', 'MATCH HISTORY'));
    this.element.appendChild(this.history);

    this.social = new ProfileSocial(ctx.myHex(), hex);
    this.element.appendChild(this.social.element);
    this.viewers = new ProfileViewers(ctx, hex);
    this.element.appendChild(this.viewers.element);

    this.onShow();
  }

  /** Called when the page becomes visible. */
  onShow(): void {
    subscribeProfile(this.hex);
    const cache = ClientCache.shared;
    if (this.hex !== this.ctx.myHex()) {
      const target = cache.playerByHex(this.hex)?.identity;
      if (target) recordProfileView(target);
    }
    this.update();
  }

  onHide(): void {
    releaseProfile(this.hex);
  }

  update(): void {
    this.header.update();
    this.stats.update();
    this.social.update();
    this.viewers.update();
    this.renderFriends();
    this.renderHistory();
  }

  /** The friends list (own profile only): mutual follows, live from the cache. */
  private renderFriends(): void {
    if (!this.friends.isConnected) return;
    clear(this.friendsBody);
    const cache = ClientCache.shared;
    const friendHexes = cache.friends(this.hex);
    if (friendHexes.length === 0) {
      this.friendsBody.appendChild(
        el('p', 'nf-muted', 'No friends yet — tap + in the Friends rail to find survivors by name or code.')
      );
      return;
    }
    for (const h of friendHexes) {
      if (!cache.playerByHex(h)) subscribePlayer(h);
      const card = new ProfileCard(h, () => this.ctx.openProfile(h));
      card.update();
      this.friendsBody.appendChild(card.element);
    }
  }

  private renderHistory(): void {
    const rows = ClientCache.shared.historyFor(this.hex).slice(0, 8);
    // Keep the title, rebuild the body.
    while (this.history.children.length > 1) this.history.removeChild(this.history.lastChild as Node);
    if (rows.length === 0) {
      this.history.appendChild(el('p', 'nf-muted', 'No official matches yet.'));
      return;
    }
    for (const row of rows) {
      const item = el('div', 'nf-history-row' + (row.won ? ' win' : ' loss'));
      item.appendChild(el('span', 'nf-history-result', row.won ? 'WIN' : 'LOSS'));
      item.appendChild(el('span', 'nf-history-time', formatDuration(row.durationSeconds)));
      item.appendChild(
        el('span', 'nf-history-stats', `${row.kills} kills · ${row.deaths} deaths · ${row.objectives} objectives`)
      );
      item.appendChild(el('span', 'nf-history-reward', `+${row.softCurrencyEarned}`));
      this.history.appendChild(item);
    }
  }
}
