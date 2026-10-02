// NECROFALL — the core button system (overhaul §7/§16/§23/§32).
//
// ONE factory pair every shell screen uses: `createNFButton` (icon + label +
// optional hint line) and `createNFIconButton` (square, icon-only with an
// accessible label). Both carry `data-action`, so the dev audit can prove a
// screen exposes its contracted actions, and both get the global press sound +
// haptic from `installUIFeedback()` with no per-call wiring.
import { getIcon, type IconName } from '../icons';
import type { MenuAction } from '../data/MenuActionRegistry';

export type NFButtonTone = 'primary' | 'accent' | 'neutral' | 'danger';

export interface NFButtonOptions {
  label: string;
  icon?: IconName | string;
  tone?: NFButtonTone;
  active?: boolean;
  disabled?: boolean;
  /** A small second line under the label — the §32 "why is this disabled" explainer. */
  hint?: string;
  /** The registry action this button performs (stamped as `data-action`). */
  action?: MenuAction;
  /** Sound override (defaults to the global tone mapping). */
  sfx?: string;
  /** Extra class names (layout belongs to the call site). */
  extraClass?: string;
  onClick?: () => void;
}

export function createNFButton(options: NFButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['nf-btn', `nf-btn--${options.tone ?? 'neutral'}`, options.active ? 'is-active' : '', options.extraClass ?? '']
    .filter(Boolean)
    .join(' ');
  button.disabled = Boolean(options.disabled);
  if (options.action) button.dataset.action = options.action;
  if (options.sfx) button.dataset.sfx = options.sfx;
  if (options.hint) button.title = options.hint;
  if (options.disabled && options.hint) button.setAttribute('aria-description', options.hint);

  if (options.icon) {
    const icon = document.createElement('span');
    icon.className = 'nf-btn__icon';
    icon.innerHTML = getIcon(options.icon);
    button.appendChild(icon);
  }

  const body = document.createElement('span');
  body.className = 'nf-btn__body';
  const label = document.createElement('span');
  label.className = 'nf-btn__label';
  label.textContent = options.label;
  body.appendChild(label);
  if (options.hint) {
    const hint = document.createElement('span');
    hint.className = 'nf-btn__hint';
    hint.textContent = options.hint;
    body.appendChild(hint);
  }
  button.appendChild(body);

  if (options.onClick && !options.disabled) {
    button.addEventListener('click', () => options.onClick?.());
  }
  return button;
}

export interface NFIconButtonOptions {
  icon: IconName | string;
  label: string;
  action?: MenuAction;
  active?: boolean;
  disabled?: boolean;
  sfx?: string;
  extraClass?: string;
  onClick?: () => void;
}

/** §16: min 48×48, visible glyph, accessible label, pressed state, press sound. */
export function createNFIconButton(options: NFIconButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['nf-icon-btn', options.active ? 'is-active' : '', options.extraClass ?? ''].filter(Boolean).join(' ');
  button.setAttribute('aria-label', options.label);
  button.title = options.label;
  button.disabled = Boolean(options.disabled);
  if (options.action) button.dataset.action = options.action;
  if (options.sfx) button.dataset.sfx = options.sfx;
  button.innerHTML = getIcon(options.icon);
  if (options.onClick && !options.disabled) {
    button.addEventListener('click', () => options.onClick?.());
  }
  return button;
}

/** Set the pressed/active state of any NF control without re-creating it. */
export function setNFActive(node: HTMLElement, active: boolean): void {
  node.classList.toggle('is-active', active);
  if (node instanceof HTMLButtonElement) node.setAttribute('aria-pressed', active ? 'true' : 'false');
}
