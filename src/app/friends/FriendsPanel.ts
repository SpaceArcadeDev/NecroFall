// NECROFALL — friends panel (plan §8/§67): the body of the desktop rail (and a
// full-screen sheet on phones, where it is NOT allowed to sit permanently over
// 25 % of the viewport — see the styles).
import { FriendList } from './FriendList';
import { button, el } from '../ui/dom';

export class FriendsPanel {
  readonly element: HTMLElement;
  private list: FriendList;
  private title: HTMLElement;

  constructor(
    myHex: () => string,
    openProfile: (hex: string) => void,
    onClose?: () => void,
    onFind?: () => void
  ) {
    this.element = el('div', 'nf-friends-panel');
    const head = el('div', 'nf-friends-head');
    this.title = el('span', 'nf-friends-title', 'FRIENDS');
    head.appendChild(this.title);
    if (onClose) {
      const close = button('✕', 'nf-btn ghost small', onClose);
      close.setAttribute('aria-label', 'Close friends');
      head.appendChild(close);
    }
    this.element.appendChild(head);
    this.list = new FriendList(myHex, openProfile);
    this.element.appendChild(this.list.element);
    // The find-players entry sits at the BOTTOM of the rail.
    if (onFind) {
      const foot = el('div', 'nf-friends-foot');
      const find = button('+', 'nf-btn ghost small nf-friends-add', onFind);
      find.setAttribute('aria-label', 'Find players by name or friend code');
      foot.appendChild(find);
      this.element.appendChild(foot);
    }
  }

  update(): void {
    this.list.update();
  }
}
