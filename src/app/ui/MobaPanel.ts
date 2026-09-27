// NECROFALL — the floating glass panel every shell screen is built from
// (plan §37: dark translucent panels, glass gradients, large readable type).
import { el } from './dom';

export class MobaPanel {
  readonly element: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(title: string, subtitle = '', extraClass = '') {
    this.element = el('section', `nf-panel ${extraClass}`.trim());
    const head = el('div', 'nf-panel-head');
    if (title) head.appendChild(el('h2', 'nf-panel-title', title));
    if (subtitle) head.appendChild(el('p', 'nf-panel-sub', subtitle));
    if (title || subtitle) this.element.appendChild(head);
    this.bodyEl = el('div', 'nf-panel-body');
    this.element.appendChild(this.bodyEl);
  }

  get body(): HTMLElement {
    return this.bodyEl;
  }

  append(...nodes: (HTMLElement | string)[]): this {
    for (const n of nodes) this.bodyEl.appendChild(typeof n === 'string' ? el('p', '', n) : n);
    return this;
  }
}
