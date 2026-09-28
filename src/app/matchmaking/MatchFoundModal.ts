// NECROFALL — the "MATCH FOUND" modal (plan §14/§69/§70): the fill window
// ("additional players may join") and then the CONFIRM MATCH card.
import { CandidateSeat, MatchConfirmation } from './MatchConfirmation';
import { el } from '../ui/dom';

export class MatchFoundModal {
  /** The module's fill window (queue.ts) — the bar drains over these seconds. */
  private static readonly FILL_SECONDS = 5;
  readonly element: HTMLElement;
  private confirmation: MatchConfirmation;
  private fillNote: HTMLElement;
  private fillClock: HTMLElement;
  private fillTrack: HTMLElement;
  private fillBar: HTMLElement;
  private title: HTMLElement;
  private target: HTMLElement;

  constructor(onConfirm: () => void) {
    this.element = el('div', 'nf-modal hidden');
    const card = el('div', 'nf-modal-card');
    this.title = el('h2', 'nf-modal-title', 'MATCH FOUND');
    card.appendChild(this.title);
    // RANKED matches fight over a WORLD — name it right on the card (plan §32/§49).
    this.target = el('div', 'nf-queue-target hidden', '');
    card.appendChild(this.target);

    this.fillNote = el('p', 'nf-muted', 'Additional players may join — filling the colonies…');
    card.appendChild(this.fillNote);
    this.fillClock = el('div', 'nf-queue-clock', '5');
    card.appendChild(this.fillClock);
    this.fillTrack = el('div', 'nf-fill-track');
    this.fillBar = el('div', 'nf-fill-bar');
    this.fillTrack.appendChild(this.fillBar);
    card.appendChild(this.fillTrack);

    this.confirmation = new MatchConfirmation(onConfirm);
    card.appendChild(this.confirmation.element);
    this.element.appendChild(card);
  }

  show(): void {
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.element.classList.add('hidden');
  }

  /** The ranked target world ('' hides the line). */
  setTarget(name: string): void {
    this.target.classList.toggle('hidden', !name);
    if (name) this.target.innerHTML = `<span>TARGETING</span>${name}`;
  }

  /** Fill window: 5 seconds of "searching", no confirmation yet. */
  updateFilling(deadlineSeconds: number): void {
    this.title.classList.remove('hidden');
    if (this.title.textContent !== 'MATCH FOUND') this.title.textContent = 'MATCH FOUND';
    this.fillNote.classList.remove('hidden');
    this.fillClock.classList.remove('hidden');
    this.fillTrack.classList.remove('hidden');
    this.fillClock.textContent = `${Math.max(0, Math.ceil(deadlineSeconds))}`;
    this.fillBar.style.width = `${Math.min(100, Math.max(0, (deadlineSeconds / MatchFoundModal.FILL_SECONDS) * 100))}%`;
    this.confirmation.element.classList.add('hidden');
  }

  /**
   * Confirmation window: 10 seconds, every player confirms (plan §14). The card reads
   * CONFIRM MATCH at the top and the confirmation block (line-up → countdown → bar → CONFIRM at
   * the bottom) takes over. The FILL track is hidden here: it is a drained, stale strip once the
   * fill window is over, and the confirmation block carries the live countdown bar itself (user
   * ask 2026-09-29: "remove the 1st empty progress bar — only keep the bottom one that works").
   * `allConfirmed` is the final beat: the bar fills and the clock turns into a ✓ so the last
   * confirmation is SEEN before the loading screen takes over (user ask 2026-09-28).
   */
  updateConfirming(deadlineSeconds: number, seats: CandidateSeat[], myConfirmed: boolean, allConfirmed = false): void {
    this.title.classList.remove('hidden');
    if (this.title.textContent !== 'CONFIRM MATCH') this.title.textContent = 'CONFIRM MATCH';
    this.fillNote.classList.add('hidden');
    this.fillClock.classList.add('hidden');
    this.fillTrack.classList.add('hidden');
    this.confirmation.element.classList.remove('hidden');
    this.confirmation.update(deadlineSeconds, seats, myConfirmed, allConfirmed);
  }
}
