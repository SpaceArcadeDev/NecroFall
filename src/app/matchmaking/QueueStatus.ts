// NECROFALL — live queue status (plan §69). The countdown is cosmetic; the
// SERVER decides every transition, this component just displays the mirror.
import { el, formatDuration } from '../ui/dom';

export class QueueStatus {
  readonly element: HTMLElement;
  private clock: HTMLElement;
  private message: HTMLElement;
  private started = 0;

  constructor(private onCancel: () => void) {
    this.element = el('div', 'nf-queue');
    this.element.appendChild(el('div', 'nf-queue-title', 'FINDING MATCH'));
    this.clock = el('div', 'nf-queue-clock', '0:00');
    this.element.appendChild(this.clock);
    this.message = el('div', 'nf-queue-message', 'Searching for players…');
    this.element.appendChild(this.message);
    const cancel = el('button', 'nf-btn ghost', 'CANCEL') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.onCancel());
    this.element.appendChild(cancel);

    // Local elapsed clock — visibility only.
    this.started = performance.now();
    const tick = (): void => {
      if (!this.element.isConnected) return;
      this.clock.textContent = formatDuration((performance.now() - this.started) / 1000);
      window.setTimeout(tick, 500);
    };
    window.setTimeout(tick, 500);
  }

  setMessage(text: string): void {
    this.message.textContent = text;
  }
}
