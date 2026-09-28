// NECROFALL — PLAY (plan §9/§35): the CLASSIC / RANK format menu in the legacy
// two-stage flow. Picking CLASSIC shrinks the cards into a compact strip and the
// setup drops in below — the colony row, LOBBY CODE + JOIN, CREATE LOBBY and
// FIND MATCH. `#/play` renders the full cards; `#/lobby` renders the same screen
// already picked (the shrink plays on arrival, so the pick reads as one motion on
// either route). The official LOBBY ROOM itself is the next screen (its own page).
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { OfficialLobby } from './OfficialLobby';

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
  private official: OfficialLobby | null = null;
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
    classicCard.setAttribute('aria-label', 'Classic — create or join an official lobby');
    classicCard.innerHTML =
      `<div class="mode-ico">${ICON_SWORDS}</div>` +
      '<div class="mode-name">CLASSIC</div>' +
      '<div class="mode-desc">Create a lobby, invite survivors or join with a code — official server matches, 3v3v3.</div>' +
      '<div class="mode-tag">PLAY NOW</div>';
    const openClassic = (): void => this.openClassic();
    classicCard.addEventListener('click', openClassic);
    classicCard.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) openClassic();
    });
    modes.appendChild(classicCard);

    const rankCard = el('div', 'mode-card rank-mode-card');
    rankCard.setAttribute('role', 'button');
    rankCard.setAttribute('tabindex', '0');
    rankCard.setAttribute('aria-label', 'Rank — the intergalactic map');
    rankCard.innerHTML =
      `<div class="mode-ico">${ICON_LADDER}</div>` +
      '<div class="mode-name">RANK</div>' +
      '<div class="mode-desc">Climb the ladder — liberate planets in your rank ring.</div>' +
      '<div class="mode-tag">ENTER MAP</div>';
    const openRank = (): void => this.ctx.goRank();
    rankCard.addEventListener('click', openRank);
    rankCard.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) openRank();
    });
    modes.appendChild(rankCard);
    col.appendChild(modes);

    // ---- the setup, revealed by the pick (same beat as the shrink). Only the
    // picked screen builds it — a pick on #/play swaps straight to #/lobby.
    if (picked) {
      const entry = el('div', 'nf-play-entry');

      // (P2P lobby creation is GONE — user ask 2026-09-29: the OFFICIAL lobby IS the
      // whole flow. The legacy P2P world is still reachable through its own in-game
      // entry and `?lobby=CODE` invites; the shell no longer hosts one.)
      entry.appendChild(
        el(
          'div',
          'muted nf-play-note',
          'Official matches run on the SpacetimeDB server — your account colony, server-verified results.'
        )
      );

      // ---- the colony row, LOBBY CODE + JOIN, CREATE LOBBY and FIND MATCH
      this.official = new OfficialLobby(ctx);
      entry.appendChild(this.official.element);

      col.appendChild(entry);

      // The morph starts after ONE painted frame of the full cards (double rAF:
      // the first callback runs before that paint, the second after it), so the
      // shrink + drop actually animate instead of appearing already settled.
      requestAnimationFrame(() => requestAnimationFrame(() => this.playPick()));
    }

    this.element.appendChild(col);
    if (picked) {
      // The roster lives on the LOBBY ROOM screen — the shared avatar rail is parked here.
      this.ctx.stageLobbyAvatars(null, []);
      this.official?.update();
    }
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

  private applyMode(): void {
    // The roster lives on the LOBBY ROOM screen — the shared avatar rail is parked here.
    this.ctx.stageLobbyAvatars(null, []);
    this.official?.update();
  }

  update(): void {
    if (this.picked) this.official?.update();
  }
}
