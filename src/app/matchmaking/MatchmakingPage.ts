// NECROFALL — the matchmaking screen (plan §69/§70): queue status while
// searching, then the fill window / confirmation modal, then LOADING.
//
// The countdown shown here TICKS LOCALLY but never decides anything: every
// transition is driven by the server rows the provider mirrors (plan §15).
import { ClientCache } from '../spacetimedb/cache';
import { COLONIES } from '../../core/Config';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { MatchFoundModal } from './MatchFoundModal';
import { QueueStatus } from './QueueStatus';

export class MatchmakingPage {
  readonly element: HTMLElement;
  private queueStatus: QueueStatus;
  private modal: MatchFoundModal;
  private timer = 0;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page queue-page');
    const head = el('div', 'nf-page-head');
    head.appendChild(el('h1', 'nf-page-title', 'MATCHMAKING'));
    this.element.appendChild(head);

    this.queueStatus = new QueueStatus(() => this.ctx.official.cancelFindMatch());
    this.element.appendChild(this.queueStatus.element);
    this.modal = new MatchFoundModal(
      () => this.ctx.official.confirmMatch(),
      () => {
        this.ctx.official.declineMatch();
        this.ctx.returnFromQueue();
      }
    );
    this.element.appendChild(this.modal.element);

    // Keep the countdown fresh between row updates (display only).
    this.timer = window.setInterval(() => {
      if (!this.element.isConnected) return;
      this.tick();
    }, 300);
  }

  dispose(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private tick(): void {
    const info = this.ctx.official.currentCandidateInfo();
    if (!info) {
      this.modal.hide();
      // Still queued? Show which colony we are searching with.
      const me = ClientCache.shared.playerByHex(this.ctx.myHex());
      const colony = me && me.colony < 3 ? COLONIES[me.colony]?.name ?? '' : '';
      this.queueStatus.setMessage(colony ? `Searching as ${colony}…` : 'Searching for players…');
      return;
    }
    this.modal.show();
    if (info.filling) this.modal.updateFilling(info.deadlineSeconds);
    else this.modal.updateConfirming(info.deadlineSeconds, info.seats, info.myConfirmed);
  }
}
