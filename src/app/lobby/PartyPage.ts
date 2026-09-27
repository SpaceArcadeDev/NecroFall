// NECROFALL — the OFFICIAL PARTY screen (plan §11/§72): CREATE PARTY's home.
//
// A menu page of its own, in the exact dress of the in-game P2P lobby: the
// title header with the format chip, the code-bar chrome ([SHARE][COPY][CODE]
// + caption) pinned top-right, the lit stage carrying every member's actual
// character above one rail of tinted seat cards, and the bottom action row
// (FIND MATCH / LEAVE). The lobby entry only OPENS this page — the roster is
// never embedded in another screen.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { PartyAvatarInfo, ShellContext } from '../ShellContext';
import { button, el, clear } from '../ui/dom';

/** LOBBY chrome: the share / copy glyphs, the same marks the in-game lobby uses (UI.ts). */
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4"/>' +
  '<path d="M15 5.8V5.2A2.2 2.2 0 0 0 12.8 3H5.2A2.2 2.2 0 0 0 3 5.2v7.6A2.2 2.2 0 0 0 5.2 15h.6"/></svg>';
const ICON_SHARE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="6" cy="12" r="2.7"/><circle cx="17.4" cy="5.7" r="2.7"/><circle cx="17.4" cy="18.3" r="2.7"/>' +
  '<path d="m8.4 10.7 6.6-3.7"/><path d="m8.4 13.3 6.6 3.7"/></svg>';

/** How long the page waits for party rows before declaring there is no party. */
const GATHER_GRACE_MS = 3500;

export class PartyPage {
  readonly element: HTMLElement;
  private codebar: HTMLElement;
  private codeEl: HTMLElement;
  private codeCap: HTMLElement;
  private railHost: HTMLElement;
  private seats: HTMLElement;
  private hint: HTMLElement;
  private findBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private code = '';
  private mountedAt = performance.now();
  /** One-shot re-render when the gather grace expires — with no party rows, no data tick ever comes. */
  private graceTimer = 0;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page party-page');

    // ---- header: the LOBBY title dress (wordmark gradient + format chip).
    // The chip carries the match FORMAT like the in-game lobby ("CLASSIC"),
    // never the server — every party today is a CLASSIC match.
    const head = el('div', 'lobby-head');
    head.appendChild(el('div', 'menu-title lobby-title', 'PARTY'));
    head.appendChild(el('span', 'lobby-mode', 'CLASSIC'));
    this.element.appendChild(head);

    // ---- invite chrome: [SHARE][COPY][CODE] + caption, pinned to the top-right
    // (the same gesture as the in-game lobby: SHARE sends the link, COPY the code)
    this.codebar = el('div', 'party-codebar hidden');
    const codeRow = el('div', 'lobby-coderow');
    const shareBtn = button('', 'lobby-icon', () => this.shareCode());
    shareBtn.innerHTML = ICON_SHARE;
    shareBtn.title = 'Send an invite link';
    shareBtn.setAttribute('aria-label', 'Send an invite link');
    const copyBtn = button('', 'lobby-icon', () => this.copyCode());
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.title = 'Copy the party code';
    copyBtn.setAttribute('aria-label', 'Copy the party code');
    this.codeEl = el('div', 'lobby-code', '-----');
    codeRow.append(shareBtn, copyBtn, this.codeEl);
    this.codeCap = el('div', 'lobby-codecap', '');
    this.codebar.append(codeRow, this.codeCap);
    this.element.appendChild(this.codebar);

    // ---- the line-up: the same stage the in-game lobby draws
    const panel = el('div', 'lobby-panel');
    const lineup = el('div', 'lobby-lineup');
    const track = el('div', 'lobby-track');
    const inner = el('div', 'lobby-track-inner');
    inner.style.width = '100%';
    this.railHost = el('div', 'sel-preview lobby-rail');
    this.seats = el('div', 'lobby-seats');
    inner.appendChild(this.railHost);
    inner.appendChild(this.seats);
    track.appendChild(inner);
    lineup.appendChild(track);
    panel.appendChild(lineup);

    this.hint = el('div', 'muted lobby-hint', '');
    panel.appendChild(this.hint);

    // ---- the action row: the leader runs the search; anyone can walk out
    const actions = el('div', 'lobby-actions');
    this.findBtn = button('FIND MATCH', 'btn primary', () => this.ctx.official.findMatch());
    this.leaveBtn = button('LEAVE', 'btn ghost', () => {
      this.ctx.official.leaveParty();
      this.ctx.goLobby(); // the party is gone the moment you walk out
    });
    this.backBtn = button('BACK TO LOBBY', 'btn primary', () => this.ctx.goLobby());
    actions.append(this.findBtn, this.leaveBtn, this.backBtn);
    panel.appendChild(actions);
    this.element.appendChild(panel);
  }

  /** Copy the party invite code to the clipboard (share it with friends). */
  private copyCode(): void {
    if (!this.code) return;
    navigator.clipboard?.writeText(this.code).then(
      () => this.ctx.toast(`Party code ${this.code} copied.`),
      () => this.ctx.toast('Copy failed — select the code and copy it manually.')
    );
  }

  /** Send an invite like the in-game lobby does: the OS share sheet, or a copied link. */
  private shareCode(): void {
    if (!this.code) return;
    const url = `${location.origin}${location.pathname}?party=${this.code}`;
    const nav = navigator as Navigator & { share?: (data: { title: string; text: string; url: string }) => Promise<void> };
    if (nav.share) {
      void nav.share({ title: 'NECROFALL', text: `Join my Necrofall party: ${this.code}`, url });
    } else {
      navigator.clipboard?.writeText(url).then(
        () => this.ctx.toast('Invite link copied'),
        () => this.ctx.toast('Copy failed — share the party code manually.')
      );
    }
  }

  update(): void {
    const cache = ClientCache.shared;
    const hex = this.ctx.myHex();
    const party = hex ? cache.myParty(hex) : null;

    if (!party) {
      // Arriving from CREATE PARTY / an invite link, the rows land a beat later —
      // gather first, only then admit there is nothing to stand on. The grace
      // expiry needs its own re-render: without rows, no data tick will come.
      this.code = '';
      clear(this.seats);
      this.codebar.classList.add('hidden');
      this.ctx.stagePartyAvatars(null, []);
      const wait = GATHER_GRACE_MS - (performance.now() - this.mountedAt);
      if (wait > 0 && !this.graceTimer) {
        this.graceTimer = window.setTimeout(() => {
          this.graceTimer = 0;
          if (this.element.isConnected) this.update();
        }, wait + 60);
      }
      const gathering = wait > 0;
      this.hint.textContent = gathering
        ? 'GATHERING YOUR PARTY…'
        : 'NO PARTY FOUND — it may have been disbanded.';
      this.findBtn.classList.add('hidden');
      this.leaveBtn.classList.add('hidden');
      this.backBtn.classList.toggle('hidden', gathering);
      return;
    }

    if (this.graceTimer) {
      window.clearTimeout(this.graceTimer);
      this.graceTimer = 0;
    }

    const members = cache.partyMembers(party.partyId);
    const leader = party.leader.toHexString() === hex;
    const me = cache.playerByHex(hex);
    const ready = Boolean(me && me.playerName && me.colony < 3);

    // ---- invite chrome: the same code-bar language as the in-game lobby
    this.code = party.joinCode;
    this.codeEl.textContent = party.joinCode || '-----';
    this.codeCap.textContent = `UP TO 3 SURVIVORS · ${members.length} IN PARTY`;
    this.codebar.classList.remove('hidden');

    // ---- the line-up: every member's actual character on the lit lobby stage
    clear(this.seats);
    const avatars: PartyAvatarInfo[] = [];
    for (const m of members) {
      const memberHex = m.identity.toHexString();
      const p = cache.playerByHex(memberHex);
      const isLeader = party.leader.toHexString() === memberHex;
      const isMe = memberHex === hex;
      const col = p && p.colony < 3 ? COLONIES[p.colony] : null;

      const seat = el('div', 'seat');
      const card = el('div', `seat-card${isMe ? ' me' : ''}${isLeader ? ' host' : ''}`);
      if (col) card.style.setProperty('--seat-col', col.css);
      const name = el('div', 'seat-name', p?.playerName || 'Recruit');
      if (col) name.style.color = col.css;
      card.appendChild(name);
      const chips = el('div', 'seat-chips');
      if (col) {
        const chip = el('span', 'seat-chip colony', `${col.symbol} ${col.name}`);
        chip.style.color = col.css;
        chips.appendChild(chip);
      } else {
        chips.appendChild(el('span', 'seat-chip dim', 'NO COLONY'));
      }
      if (isLeader) chips.appendChild(el('span', 'seat-chip host', 'LEADER'));
      if (isMe) chips.appendChild(el('span', 'seat-chip you', 'YOU'));
      card.appendChild(chips);
      card.appendChild(el('div', 'seat-state', 'IN PARTY'));
      if (leader && !isMe) {
        const kick = button('✕', 'seat-kick', () => this.ctx.official.kickFromParty(m.identity));
        kick.title = `Remove ${p?.playerName ?? 'this player'} from the party`;
        kick.setAttribute('aria-label', kick.title);
        card.appendChild(kick);
      }
      seat.appendChild(card);
      this.seats.appendChild(seat);

      avatars.push({ id: memberHex, colony: col ? (p?.colony ?? 0) : 0, acc: m.acc ?? '', me: isMe, ready: true });
    }
    this.ctx.stagePartyAvatars(this.railHost, avatars);

    // ---- the run line: only the LEADER may search (the server enforces it too)
    this.findBtn.classList.remove('hidden');
    this.leaveBtn.classList.remove('hidden');
    this.backBtn.classList.add('hidden');
    if (!leader) {
      this.findBtn.disabled = true;
      this.findBtn.textContent = 'WAITING FOR LEADER…';
      this.findBtn.title = 'Only the party leader can search for a match.';
    } else if (!ready) {
      this.findBtn.disabled = true;
      this.findBtn.textContent = 'FINISH ONBOARDING FIRST';
      this.findBtn.title = '';
    } else {
      this.findBtn.disabled = false;
      this.findBtn.textContent = 'FIND MATCH';
      this.findBtn.title = 'Queues the whole party together.';
    }
    this.leaveBtn.textContent = leader ? 'DISBAND / LEAVE' : 'LEAVE';
    this.hint.textContent = leader
      ? 'You lead this party — FIND MATCH queues everyone together.'
      : 'Only the leader can search for a match.';
  }
}
