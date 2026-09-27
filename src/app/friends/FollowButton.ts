// NECROFALL — follow button (plan §4/§5). One reducer per press; the state it
// renders comes back through the subscribed follow rows.
import { ClientCache } from '../spacetimedb/cache';
import { followPlayer, unfollowPlayer } from '../spacetimedb/reducers';
import { button } from '../ui/dom';

export class FollowButton {
  readonly element: HTMLButtonElement;

  constructor(private myHex: string, private targetHex: string) {
    this.element = button('FOLLOW', 'nf-btn ghost small', () => this.toggle());
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const following = cache.isFollowing(this.myHex, this.targetHex);
    const isFriend = cache.friends(this.myHex).includes(this.targetHex);
    this.element.textContent = isFriend ? 'FRIENDS ✓' : following ? 'FOLLOWING ✓' : 'FOLLOW';
    this.element.classList.toggle('on', following);
    this.element.disabled = this.myHex === this.targetHex || !this.myHex;
  }

  private toggle(): void {
    const cache = ClientCache.shared;
    const target = cache.playerByHex(this.targetHex)?.identity;
    if (!target) return;
    if (cache.isFollowing(this.myHex, this.targetHex)) unfollowPlayer(target);
    else followPlayer(target);
  }
}
