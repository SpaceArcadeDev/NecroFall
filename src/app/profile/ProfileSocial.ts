// NECROFALL — profile social block (plan §4/§5): followers, following and the
// friendship state. Friendship = mutual follow; nothing is stored.
import { ClientCache } from '../spacetimedb/cache';
import { el } from '../ui/dom';

export class ProfileSocial {
  readonly element: HTMLElement;
  private body: HTMLElement;

  constructor(private myHex: string, private hex: string) {
    this.element = el('section', 'nf-profile-section');
    this.element.appendChild(el('h2', 'nf-section-title', 'SOCIAL'));
    this.body = el('div', 'nf-social-row');
    this.element.appendChild(this.body);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const player = cache.playerByHex(this.hex);
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    const chip = (label: string, value: string): HTMLElement => {
      const c = el('div', 'nf-social-chip');
      c.appendChild(el('span', 'nf-social-v', value));
      c.appendChild(el('span', 'nf-social-k', label));
      return c;
    };
    this.body.appendChild(chip('Followers', `${player?.followersCount ?? 0}`));
    this.body.appendChild(chip('Following', `${player?.followingCount ?? 0}`));
    this.body.appendChild(chip('Profile views', `${player?.profileViews ?? 0}`));
    if (this.hex !== this.myHex) {
      const isFriend = cache.friends(this.myHex).includes(this.hex);
      const iFollow = cache.isFollowing(this.myHex, this.hex);
      const theyFollow = cache.followers(this.myHex).some(r => r.follower.toHexString() === this.hex);
      const state = isFriend ? 'FRIENDS' : iFollow && !theyFollow ? 'FOLLOWING' : !iFollow && theyFollow ? 'FOLLOWS YOU' : 'NOT CONNECTED';
      this.body.appendChild(chip('Status', state));
    }
  }
}
