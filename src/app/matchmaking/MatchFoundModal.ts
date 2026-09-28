// NECROFALL — the "MATCH FOUND" modal (plan §14/§69/§70): the fill window
// ("additional players may join") and then the confirmation card.
import { CandidateSeat, MatchConfirmation } from './MatchConfirmation';
import { el } from '../ui/dom';

export class MatchFoundModal {
  /** The module's fill window (queue.ts) — the bar drains over these seconds. */
  private static readonly FILL_SECONDS = 5;
  readonly element: HTMLElement;
  private confirmation: MatchConfirmation;
  private fillNote: HTMLElement;
  private fillClock: HTMLElement;
  private fillBar: HTMLElement;
  private title: HTMLElement;

  constructor(onConfirm: () => void, onDecline: () => void) {
    this.element = el('div', 'nf-modal hidden');
    const card = el('div', 'nf-modal-card');
    this.title = el('h2', 'nf-modal-title', 'MATCH FOUND');
    card.appendChild(this.title);

    this.fillNote = el('p', 'nf-muted', 'Additional players may join — filling the colonies…');
    card.appendChild(this.fillNote);
    this.fillClock = el('div', 'nf-queue-clock', '5');
    card.appendChild(this.fillClock);
    const track = el('div', 'nf-fill-track');
    this.fillBar = el('div', 'nf-fill-bar');
    track.appendChild(this.fillBar);
    card.appendChild(track);

    this.confirmation = new MatchConfirmation(onConfirm, onDecline);
    card.appendChild(this.confirmation.element);
    this.element.appendChild(card);
  }

  show(): void {
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.element.classList.add('hidden');
  }

  /** Fill window: 5 seconds of "searching", no confirmation yet. */
  updateFilling(deadlineSeconds: number): void {
    this.title.classList.remove('hidden');
    this.title.textContent = 'MATCH FOUND';
    this.fillNote.classList.remove('hidden');
    this.fillClock.classList.remove('hidden');
    this.fillClock.textContent = `${Math.max(0, Math.ceil(deadlineSeconds))}`;
    this.fillBar.style.width = `${Math.min(100, Math.max(0, (deadlineSeconds / MatchFoundModal.FILL_SECONDS) * 100))}%`;
    this.confirmation.element.classList.add('hidden');
  }

  /**
   * Confirmation window: 10 seconds, every player confirms (plan §14). No heading and no explainer
   * — the user asked for the minimal card: the colony line-up, the countdown, the bar, the button.
   */
  updateConfirming(deadlineSeconds: number, seats: CandidateSeat[], myConfirmed: boolean): void {
    this.title.classList.add('hidden');
    this.fillNote.classList.add('hidden');
    this.fillClock.classList.add('hidden');
    this.confirmation.element.classList.remove('hidden');
    this.confirmation.update(deadlineSeconds, seats, myConfirmed);
  }
}
