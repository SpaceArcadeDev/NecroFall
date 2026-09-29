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
import { parsePlanetKey, DEFAULT_UNIVERSE_SEED } from '../../rankmap/procedural/SeedHash';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';

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
    // One callback only: CONFIRM. There is no LEAVE in the confirmation window (user ask
    // 2026-09-29) — a seat must answer the prompt; the server's deadline handles no-shows.
    this.modal = new MatchFoundModal(() => {
      this.ctx.official.confirmMatch();
      // Render the optimistic ✓ in the SAME frame as the click — the 300 ms poll would leave
      // the button flipped while its slot still read '?'.
      this.tick();
    });
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
      // Still queued? Show which colony we are searching with, and — for a RANKED search —
      // the world the match will be fought on (plan §5/§53).
      const me = ClientCache.shared.playerByHex(this.ctx.myHex());
      const colony = me && me.colony < 3 ? COLONIES[me.colony]?.name ?? '' : '';
      this.queueStatus.setMessage(colony ? `Searching as ${colony}…` : 'Searching for players…');
      const queue = ClientCache.shared.myQueue();
      const target = queue?.ranked && queue.planetKey ? this.targetInfo(queue.planetKey) : { name: '', isNew: false };
      this.queueStatus.setTarget(target.name);
      this.modal.setTarget(target.name, target.isNew);
      return;
    }
    const q = ClientCache.shared.myQueue();
    const modalTarget = q?.ranked && q.planetKey ? this.targetInfo(q.planetKey) : { name: '', isNew: false };
    this.modal.setTarget(modalTarget.name, modalTarget.isNew);
    this.modal.show();
    if (info.filling) this.modal.updateFilling(info.deadlineSeconds);
    else this.modal.updateConfirming(info.deadlineSeconds, info.seats, info.myConfirmed, info.allConfirmed);
  }

  /**
   * The ranked target's display name + whether it is NEW to this account. "New" = a planet the
   * player has never fought on: their own rank history holds one row per ranked match (the account
   * scope keeps it subscribed), so an absent planet_key is first contact (user ask 2026-09-29).
   */
  private targetInfo(planetKey: string): { name: string; isNew: boolean } {
    const parsed = parsePlanetKey(planetKey);
    if (!parsed) return { name: '', isNew: false };
    const season = ClientCache.shared.rankedSeason();
    const seed = season ? Number(season.universeSeed % 4294967296n) >>> 0 : DEFAULT_UNIVERSE_SEED;
    const name = planetAt(seed, parsed.ring, parsed.galaxyId, parsed.systemId, parsed.planetId).name.toUpperCase();
    const played = ClientCache.shared.myRankHistory(this.ctx.myHex()).some(r => r.planetKey === planetKey);
    return { name, isNew: !played };
  }
}
