// NECROFALL — the 10 second confirmation card (plan §14/§70/§36).
//
// The whole card is the confirm affordance: no tiny checkbox, thumb-sized
// targets, urgent colour/animation under 3 seconds.
import { COLONIES } from '../../core/Config';
import { el } from '../ui/dom';

export interface CandidateSeat {
  colony: number;
  confirmed: boolean;
  me: boolean;
}

export class MatchConfirmation {
  readonly element: HTMLElement;
  private countdown: HTMLElement;
  private seatsEl: HTMLElement;
  private confirmBtn: HTMLButtonElement;

  constructor(private onConfirm: () => void, private onDecline: () => void) {
    this.element = el('div', 'nf-confirm');
    this.element.appendChild(el('div', 'nf-confirm-title', 'MATCH FOUND'));
    this.element.appendChild(el('div', 'nf-confirm-sub', 'Confirm to enter the arena'));
    this.seatsEl = el('div', 'nf-confirm-seats');
    this.element.appendChild(this.seatsEl);
    this.countdown = el('div', 'nf-confirm-countdown', '10');
    this.element.appendChild(this.countdown);

    this.confirmBtn = el('button', 'nf-confirm-btn', 'CONFIRM MATCH') as HTMLButtonElement;
    this.confirmBtn.type = 'button';
    this.confirmBtn.addEventListener('click', () => {
      if (this.confirmBtn.disabled) return;
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = 'CONFIRMED ✓';
      this.onConfirm();
    });
    this.element.appendChild(this.confirmBtn);

    const leave = el('button', 'nf-btn ghost small', 'LEAVE') as HTMLButtonElement;
    leave.type = 'button';
    leave.addEventListener('click', () => this.onDecline());
    this.element.appendChild(leave);
  }

  update(deadlineSeconds: number, seats: CandidateSeat[], myConfirmed: boolean): void {
    const shown = Math.max(0, Math.ceil(deadlineSeconds));
    this.countdown.textContent = `${shown}`;
    this.countdown.classList.toggle('urgent', shown <= 3);

    if (myConfirmed) {
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = 'CONFIRMED ✓';
    } else {
      this.confirmBtn.disabled = false;
      this.confirmBtn.textContent = 'CONFIRM MATCH';
    }

    // Group seats per colony — 3 columns, like the plan's mock.
    const byColony: CandidateSeat[][] = [[], [], []];
    for (const seat of seats) {
      if (seat.colony < 3) byColony[seat.colony].push(seat);
    }
    while (this.seatsEl.firstChild) this.seatsEl.removeChild(this.seatsEl.firstChild);
    for (let c = 0; c < 3; c++) {
      const column = el('div', 'nf-confirm-colony');
      column.style.setProperty('--nf-colony', COLONIES[c]?.css ?? '#8fd7ff');
      column.appendChild(el('span', 'nf-confirm-colony-name', COLONIES[c]?.name ?? '—'));
      for (const seat of byColony[c]) {
        const chip = el('span', 'nf-confirm-seat' + (seat.me ? ' me' : '') + (seat.confirmed ? ' ok' : ''), seat.confirmed ? '✓' : '…');
        if (seat.me) chip.title = 'You';
        column.appendChild(chip);
      }
      this.seatsEl.appendChild(column);
    }
  }
}
