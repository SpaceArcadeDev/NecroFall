// NECROFALL — PLAY (plan §9/§35): the CLASSIC / RANK format menu in the legacy
// two-stage flow. Picking CLASSIC shrinks the cards into a compact strip and the
// setup drops in below — the OFFICIAL / P2P choice, the colony row, CREATE PARTY
// + FIND MATCH (or the classic P2P entry). `#/play` renders the full cards;
// `#/lobby` renders the same screen already picked (the shrink plays on arrival,
// so the pick reads as one motion on either route).
import { loadMultiplayerMode } from '../multiplayer/MultiplayerMode';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { MultiplayerModeToggle } from './MultiplayerModeToggle';
import { OfficialLobby } from './OfficialLobby';
import { P2PLobby } from './P2PLobby';

/** CLASSIC — crossed swords: the plain, unranked fight for the planet. */
const ICON_SWORDS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>' +
  '<path d="M13 19l6-6"/>' +
  '<path d="M16 16l4 4"/>' +
  '<path d="M19 21l2-2"/>' +
  '<path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/>' +
  '<path d="M5 14l4 4"/>' +
  '<path d="M7 17l-3 3"/>' +
  '<path d="M3 19l2 2"/></svg>';

/** RANK — a pyramid ladder: the climb up the standings, rungs and all. */
const ICON_LADDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3.4 20.2 20.6H3.8z"/>' +
  '<path d="M9 9.8h6"/>' +
  '<path d="M7.4 13.4h9.2"/>' +
  '<path d="M5.7 17h12.6"/></svg>';

export class PlayPage {
  readonly element: HTMLElement;
  private classicCard: HTMLElement;
  private toggle: MultiplayerModeToggle | null = null;
  private official: OfficialLobby | null = null;
  private p2p: P2PLobby | null = null;
  private note: HTMLElement | null = null;
  private picked: boolean;

  constructor(private ctx: ShellContext, picked = false) {
    this.picked = picked;
    this.element = el('div', 'nf-page play-page');
    // The picked screen continues the pick: a page-in fade would flash
    // mid-morph — the card shrink IS the entrance.
    if (picked) this.element.style.animation = 'none';

    const head = el('div', 'play-head');
    head.appendChild(el('div', 'menu-title', 'PLAY'));
    if (!picked) head.appendChild(el('div', 'menu-sub', 'choose your match format'));
    this.element.appendChild(head);

    const col = el('div', 'menu-col play-col');

    // ---- the format cards: exactly the in-game menu's CLASSIC / RANK choice
    const modes = el('div', 'play-modes');
    const classicCard = el('div', 'mode-card');
    this.classicCard = classicCard;
    classicCard.setAttribute('role', 'button');
    classicCard.setAttribute('tabindex', '0');
    classicCard.setAttribute('aria-label', 'Classic — the lobby: official server or peer-to-peer');
    classicCard.innerHTML =
      `<div class="mode-ico">${ICON_SWORDS}</div>` +
      '<div class="mode-name">CLASSIC</div>' +
      '<div class="mode-desc">The lobby: official server matches or peer-to-peer lobbies. Up to 9 survivors, 3v3v3.</div>' +
      '<div class="mode-tag">PLAY NOW</div>';
    const openClassic = (): void => this.openClassic();
    classicCard.addEventListener('click', openClassic);
    classicCard.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) openClassic();
    });
    modes.appendChild(classicCard);

    const rankCard = el('div', 'mode-card locked');
    rankCard.setAttribute('role', 'button');
    rankCard.setAttribute('tabindex', '0');
    rankCard.setAttribute('aria-disabled', 'true');
    rankCard.setAttribute('aria-label', 'Rank — coming soon');
    rankCard.innerHTML =
      `<div class="mode-ico">${ICON_LADDER}</div>` +
      '<div class="mode-name">RANK</div>' +
      '<div class="mode-desc">Climb the ladder against matched opponents.</div>' +
      '<div class="mode-badge">COMING SOON</div>';
    const rankNudge = (): void => {
      rankCard.classList.remove('shake');
      void rankCard.offsetWidth;
      rankCard.classList.add('shake');
      this.ctx.toast('Ranked matches are coming soon.');
    };
    rankCard.addEventListener('click', rankNudge);
    rankCard.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) rankNudge();
    });
    modes.appendChild(rankCard);
    col.appendChild(modes);

    // ---- the setup, revealed by the pick (same beat as the shrink). Only the
    // picked screen builds it — a pick on #/play swaps straight to #/lobby.
    if (picked) {
      const entry = el('div', 'nf-play-entry');

      // The server choice: OFFICIAL (SpacetimeDB) or classic P2P lobbies.
      this.toggle = new MultiplayerModeToggle(
        loadMultiplayerMode(),
        (mode) => this.applyMode(mode),
        ctx.config.p2pEnabled
      );
      entry.appendChild(this.toggle.element);

      this.note = el('div', 'muted nf-play-note', '');
      entry.appendChild(this.note);

      // ---- OFFICIAL: the colony row, CREATE PARTY + FIND MATCH, invite join
      this.official = new OfficialLobby(ctx);
      entry.appendChild(this.official.element);

      // ---- P2P: the classic lobby entry (name, create, join, solo)
      this.p2p = new P2PLobby(ctx);
      entry.appendChild(this.p2p.element);

      col.appendChild(entry);

      // The morph starts after ONE painted frame of the full cards (double rAF:
      // the first callback runs before that paint, the second after it), so the
      // shrink + drop actually animate instead of appearing already settled.
      requestAnimationFrame(() => requestAnimationFrame(() => this.playPick()));
    }

    this.element.appendChild(col);
    if (picked) this.applyMode(this.toggle?.mode ?? 'official');
  }

  /** CLASSIC: the pick swaps to the setup screen — or answers a re-press. */
  private openClassic(): void {
    if (this.picked) {
      this.flashPicked();
      return;
    }
    this.ctx.goLobby();
  }

  /** The pick morph: the cards shrink into the strip and the setup drops in. */
  private playPick(): void {
    this.element.classList.add('mode-picked');
    this.classicCard.classList.add('sel');
    this.flashPicked();
  }

  /** A short confirm pop on the chosen card (replayable, self-cleaning). */
  private flashPicked(): void {
    const card = this.classicCard;
    card.classList.remove('picked');
    void card.offsetWidth;
    card.classList.add('picked');
    const onEnd = (e: AnimationEvent): void => {
      if (e.target !== card) return;
      card.classList.remove('picked');
      card.removeEventListener('animationend', onEnd);
    };
    card.addEventListener('animationend', onEnd);
  }

  private applyMode(mode: 'official' | 'p2p'): void {
    if (!this.official || !this.p2p || !this.note) return;
    this.official.element.classList.toggle('hidden', mode !== 'official');
    this.p2p.element.classList.toggle('hidden', mode !== 'p2p');
    // The roster lives on the PARTY screen — the shared avatar rail is parked here.
    this.ctx.stagePartyAvatars(null, []);
    if (mode === 'official') this.official.update();
    this.note.textContent =
      mode === 'official'
        ? 'Official matches run on the SpacetimeDB server — your account colony, server-verified results.'
        : 'Classic WebRTC lobbies — host migration and custom rules. Community stats only, no official rewards.';
  }

  update(): void {
    if (this.picked) this.official?.update();
  }
}
