// NECROFALL — the MORE sheet (overhaul §30/§31).
//
// The right-side drawer that holds every secondary function: profile, graphics,
// controls, how-to, customize, fullscreen, sign out. Nothing is deleted from the
// product because it does not fit the five primary tabs — it lives here.
import { createNFButton, createNFIconButton } from './NFButton';
import type { MenuAction } from '../data/MenuActionRegistry';

export interface MoreSheetEntry {
  label: string;
  icon: string;
  action?: MenuAction;
  tone?: 'primary' | 'accent' | 'neutral' | 'danger';
  hint?: string;
  onClick: () => void;
}

export class NFMoreSheet {
  readonly element: HTMLElement;
  private scrim: HTMLElement;
  private rows: HTMLElement;
  private open = false;
  private onDocKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.close();
  };

  constructor(private buildEntries: () => MoreSheetEntry[], title = 'MORE') {
    this.scrim = document.createElement('div');
    this.scrim.className = 'nf-sheet-scrim';
    this.scrim.addEventListener('click', () => this.close());

    this.element = document.createElement('aside');
    this.element.className = 'nf-sheet';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.setAttribute('aria-label', title);

    const head = document.createElement('div');
    head.className = 'nf-sheet__head';
    const titleEl = document.createElement('span');
    titleEl.className = 'nf-sheet__title';
    titleEl.textContent = title;
    head.appendChild(titleEl);
    head.appendChild(
      createNFIconButton({
        icon: 'close',
        label: 'Close menu',
        sfx: 'back',
        onClick: () => this.close(),
      })
    );
    this.element.appendChild(head);

    this.rows = document.createElement('div');
    this.rows.className = 'nf-sheet__rows';
    this.element.appendChild(this.rows);

    document.body.append(this.scrim, this.element);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    // Rebuilt on every open so state-dependent entries (fullscreen label,
    // resume entry) are always current.
    this.rows.replaceChildren(
      ...this.buildEntries().map((entry) =>
        createNFButton({
          label: entry.label,
          icon: entry.icon,
          tone: entry.tone ?? 'neutral',
          action: entry.action,
          hint: entry.hint,
          extraClass: 'nf-sheet-row',
          onClick: () => {
            this.close();
            entry.onClick();
          },
        })
      )
    );
    this.open = true;
    this.scrim.classList.add('on');
    this.element.classList.add('on');
    this.element.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', this.onDocKey, true);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.scrim.classList.remove('on');
    this.element.classList.remove('on');
    this.element.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.onDocKey, true);
  }
}
