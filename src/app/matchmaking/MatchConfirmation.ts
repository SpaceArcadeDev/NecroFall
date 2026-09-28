// NECROFALL — the confirmation card (plan §14/§70/§36).
//
// Minimal on purpose: the MATCH FOUND heading already fired in the fill window, so the confirm
// phase is just the colony line-up, the countdown and one button. The DOM is BUILT ONCE and then
// PATCHED — the old version rebuilt the columns on every 300 ms display tick, which replayed the
// entrance animations and read as a flicker/reset (the same disease the pause panel had).
import { COLONIES } from '../../core/Config';
import { el } from '../ui/dom';

export interface CandidateSeat {
  colony: number;
  confirmed: boolean;
  me: boolean;
}

/** Slots per colony column — a colony seats three, filled left to right. */
const SLOTS_PER_COLONY = 3;

export class MatchConfirmation {
  /** The module's confirmation window (queue.ts) — the bar drains over these seconds. */
  private static readonly CONFIRM_SECONDS = 10;
  readonly element: HTMLElement;
  private countdown: HTMLElement;
  private bar: HTMLElement;
  private slots: HTMLElement[][] = [[], [], []];
  private confirmBtn: HTMLButtonElement;
  private lastBtnState = '';

  constructor(private onConfirm: () => void, private onDecline: () => void) {
    this.element = el('div', 'nf-confirm');

    // The colony line-up: three columns, each with three slots. A seat fills the next open slot;
    // slots turn from '?' to '✓' as their players confirm.
    const seats = el('div', 'nf-confirm-seats');
    for (let c = 0; c < 3; c++) {
      const column = el('div', 'nf-confirm-colony');
      column.style.setProperty('--nf-colony', COLONIES[c]?.css ?? '#8fd7ff');
      column.appendChild(el('span', 'nf-confirm-colony-name', COLONIES[c]?.name ?? '—'));
      const row = el('div', 'nf-confirm-slots');
      for (let i = 0; i < SLOTS_PER_COLONY; i++) {
        const slot = el('span', 'nf-confirm-slot dim', '?');
        row.appendChild(slot);
        this.slots[c].push(slot);
      }
      column.appendChild(row);
      seats.appendChild(column);
    }
    this.element.appendChild(seats);

    // Countdown + bar wear the MATCH FOUND dress (same classes) — one visual language.
    this.countdown = el('div', 'nf-queue-clock', '10');
    this.element.appendChild(this.countdown);
    const track = el('div', 'nf-fill-track');
    this.bar = el('div', 'nf-fill-bar');
    track.appendChild(this.bar);
    this.element.appendChild(track);

    this.confirmBtn = el('button', 'nf-confirm-btn', 'CONFIRM') as HTMLButtonElement;
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
    if (this.countdown.textContent !== `${shown}`) this.countdown.textContent = `${shown}`;
    this.countdown.classList.toggle('urgent', shown <= 3);
    this.bar.style.width = `${Math.min(100, Math.max(0, (deadlineSeconds / MatchConfirmation.CONFIRM_SECONDS) * 100))}%`;

    const btnState = myConfirmed ? 'ok' : 'wait';
    if (btnState !== this.lastBtnState) {
      this.lastBtnState = btnState;
      this.confirmBtn.disabled = myConfirmed;
      this.confirmBtn.textContent = myConfirmed ? 'CONFIRMED ✓' : 'CONFIRM';
    }

    // Group seats per colony — each seat takes the first open slot; every colony keeps its three
    // slots visible, so the summary always reads as a three-wide line-up.
    const byColony: CandidateSeat[][] = [[], [], []];
    for (const seat of seats) {
      if (seat.colony < 3) byColony[seat.colony].push(seat);
    }
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < SLOTS_PER_COLONY; i++) {
        const seat = byColony[c][i];
        const slot = this.slots[c][i];
        const cls = seat
          ? `nf-confirm-slot${seat.confirmed ? ' on' : ' live'}${seat.me ? ' me' : ''}`
          : 'nf-confirm-slot dim';
        const txt = seat && seat.confirmed ? '✓' : '?';
        if (slot.className !== cls) slot.className = cls;
        if (slot.textContent !== txt) slot.textContent = txt;
        if (seat?.me && slot.title !== 'You') slot.title = 'You';
      }
    }
  }
}
