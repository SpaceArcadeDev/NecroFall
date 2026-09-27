// NECROFALL — the FIXED friends rail (plan §8): always docked on the right — a
// slim avatar strip on narrow screens, a full panel (names + status) on wide
// ones. Both read from the same live friend list.
import { FriendsPanel } from '../friends/FriendsPanel';
import { el } from './dom';

export class FriendRail {
  readonly element: HTMLElement;
  readonly panel: FriendsPanel;

  constructor(myHex: () => string, openProfile: (hex: string) => void, onFind?: () => void) {
    this.element = el('aside', 'nf-rail');
    this.panel = new FriendsPanel(myHex, openProfile, undefined, onFind);
    this.element.appendChild(this.panel.element);
  }

  update(): void {
    this.panel.update();
  }
}
