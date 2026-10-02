// NECROFALL — THE shared page header (overhaul §2/§15/§44).
//
// One title anchor for every non-gameplay page: same height, same centring,
// same gradient typography, same left/right slots — so PROFILE, PLAY, GRAPHICS,
// CUSTOM and the solo pickers all begin at the same coordinate. The back
// control, when a page needs its own, is part of this header and carries
// `data-action="back"` (the shell then hides its floating chevron for that
// screen — never two backs).
import { getIcon } from '../icons';

export interface PageHeaderOptions {
  title: string;
  /** Small second line under the title. */
  subtitle?: string;
  /** Right-hand slot content (a chip, an icon button …). */
  right?: HTMLElement;
  /** Draw the back chevron INTO the header (left slot). */
  onBack?: () => void;
}

export function createPageHeader(options: PageHeaderOptions): HTMLElement {
  const header = document.createElement('header');
  header.className = 'nf-page-header';

  const left = document.createElement('div');
  left.className = 'nf-page-header__left';
  if (options.onBack) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'nf-icon-btn nf-page-back';
    back.dataset.action = 'back';
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = getIcon('arrow-left');
    back.addEventListener('click', () => options.onBack?.());
    left.appendChild(back);
  }
  header.appendChild(left);

  const mid = document.createElement('div');
  mid.className = 'nf-page-header__mid';
  const title = document.createElement('h1');
  title.className = 'nf-page-title';
  title.textContent = options.title;
  mid.appendChild(title);
  if (options.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'nf-page-subtitle';
    sub.textContent = options.subtitle;
    mid.appendChild(sub);
  }
  header.appendChild(mid);

  const right = document.createElement('div');
  right.className = 'nf-page-header__right';
  if (options.right) right.appendChild(options.right);
  header.appendChild(right);

  return header;
}
