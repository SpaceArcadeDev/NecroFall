// NECROFALL — PLAY (plan §9/§35): the CLASSIC / RANK format menu in the legacy
// two-stage flow. Picking CLASSIC shrinks the cards into a compact strip and the
// setup drops in below — the OFFICIAL / P2P server choice, the colony row,
// LOBBY CODE + JOIN, CREATE LOBBY and FIND MATCH. `#/play` renders the full
// cards; `#/lobby` renders the same screen already picked (the shrink plays on
// arrival, so the pick reads as one motion on either route). The lobby ROOM
// itself is the next screen (its own page).
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { loadMultiplayerMode } from '../multiplayer/MultiplayerMode';
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

/** SPEEDRUN — a stopwatch: the clock IS the mode. */
const ICON_STOPWATCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="13.4" r="7.2"/>' +
  '<path d="M12 9.6v3.8l2.6 1.9"/>' +
  '<path d="M9.4 2.8h5.2"/>' +
  '<path d="M12 2.8v3.4"/></svg>';

/** SURVIVAL — a wave that never ends under a lone skull. */
const ICON_HORDE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3.2a5.4 5.4 0 0 0-5.4 5.4c0 1.9 1 3 2 3.8v2.2a1.4 1.4 0 0 0 1.4 1.4h4a1.4 1.4 0 0 0 1.4-1.4v-2.2c1-.8 2-1.9 2-3.8A5.4 5.4 0 0 0 12 3.2z"/>' +
  '<circle cx="10.1" cy="8.9" r="0.9" fill="currentColor" stroke="none"/>' +
  '<circle cx="13.9" cy="8.9" r="0.9" fill="currentColor" stroke="none"/>' +
  '<path d="M4 19.4c2.2-1.6 4.6-1.6 6.8 0"/>' +
  '<path d="M13.2 19.4c2.2-1.6 4.6-1.6 6.8 0"/></svg>';

/** CUSTOM — two figures plus a code tag: the invite-only lobby. */
const ICON_CUSTOM =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="9" cy="8.4" r="3"/>' +
  '<path d="M3.6 19.4c.6-3 2.8-4.6 5.4-4.6s4.8 1.6 5.4 4.6"/>' +
  '<path d="M16.4 5.6a3 3 0 0 1 0 5.9"/>' +
  '<path d="M17.4 14.6c1.7.5 2.8 2.1 3.2 4.5"/></svg>';

/** FREEROAM — a compass: the roam-the-world sandbox, kept for wandering the environment. */
const ICON_COMPASS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="8.6"/>' +
  '<path d="M15.4 8.6l-2.1 4.7-4.7 2.1 2.1-4.7z"/>' +
  '<path d="M12 3.4v1.4M12 19.2v1.4M3.4 12h1.4M19.2 12h1.4"/></svg>';

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

    // ---- SOLO + CUSTOM (user ask 2026-09-30): three new formats beside CLASSIC / RANK.
    const mkCard = (cls: string, icon: string, name: string, desc: string, tag: string, aria: string, go: () => void): void => {
      const card = el('div', `mode-card ${cls}`);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', aria);
      card.innerHTML =
        `<div class="mode-ico">${icon}</div>` +
        `<div class="mode-name">${name}</div>` +
        `<div class="mode-desc">${desc}</div>` +
        `<div class="mode-tag">${tag}</div>`;
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        const k = e as KeyboardEvent;
        if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) go();
      });
      modes.appendChild(card);
    };
    mkCard(
      'solo-mode-card speedrun-card',
      ICON_STOPWATCH,
      'SPEEDRUN',
      'A planet from your band, classic objectives, one clock — take the Nexus as fast as you can.',
      'SOLO',
      'Speedrun — race a planet for the fastest time',
      () => this.ctx.goSolo('speedrun')
    );
    mkCard(
      'solo-mode-card survival-card',
      ICON_HORDE,
      'SURVIVAL',
      'Endless swarm, no beacons, no Nexus. Enemies grow without mercy — survive as long as you can.',
      'SOLO',
      'Survival — hold out against the endless swarm',
      () => this.ctx.goSolo('survival')
    );
    mkCard(
      'custom-mode-card',
      ICON_CUSTOM,
      'CUSTOM',
      'Lobby up with a code — P2P rules on the hybrid server. Everyone readies, the host starts.',
      'INVITE',
      'Custom — a lobby on the hybrid server',
      () => this.ctx.goCustom()
    );
    // FREEROAM (user ask): the sandbox world — CLASSIC's procedural planet, alone, on the ground,
    // no class picker (RIFT by default), no enemies and no clock. Pure roaming.
    mkCard(
      'freeroam-mode-card',
      ICON_COMPASS,
      'FREEROAM',
      'Roam a procedural world alone — no enemies, no clock, no setup. Just wander the planet.',
      'EXPLORE',
      'Freeroam — roam a procedural planet alone, no enemies and no clock',
      () => this.ctx.startFreeroam()
    );
    col.appendChild(modes);

    // ---- the setup, revealed by the pick (same beat as the shrink). Only the
    // picked screen builds it — a pick on #/play swaps straight to #/lobby.
    if (picked) {
      const entry = el('div', 'nf-play-entry');

      // The SERVER choice (user ask 2026-09-29): CLASSIC runs on the OFFICIAL server or as a
      // classic peer-to-peer lobby — the same segmented control the in-game settings use.
      this.toggle = new MultiplayerModeToggle(
        loadMultiplayerMode(),
        (mode) => this.applyMode(mode),
        ctx.config.p2pEnabled
      );
      entry.appendChild(this.toggle.element);

      // The line under the toggle explains the SELECTED network (official: server-verified
      // results; p2p: WebRTC lobbies, community stats only).
      this.note = el('div', 'muted nf-play-note', '');
      entry.appendChild(this.note);

      // ---- OFFICIAL: the colony row, LOBBY CODE + JOIN, CREATE LOBBY and FIND MATCH
      this.official = new OfficialLobby(ctx);
      entry.appendChild(this.official.element);

      // ---- P2P: the classic lobby entry (name, CREATE LOBBY, JOIN, PLAY SOLO) — it boots the
      // existing WebRTC game, where the P2P lobby screen lives.
      this.p2p = new P2PLobby(ctx);
      entry.appendChild(this.p2p.element);

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
      this.applyMode(this.toggle?.mode ?? 'official');
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

  private applyMode(mode: 'official' | 'p2p'): void {
    if (!this.official || !this.p2p || !this.note) return;
    this.official.element.classList.toggle('hidden', mode !== 'official');
    this.p2p.element.classList.toggle('hidden', mode !== 'p2p');
    // The roster lives on the LOBBY ROOM screen — the shared avatar rail is parked here.
    this.ctx.stageLobbyAvatars(null, []);
    if (mode === 'official') this.official.update();
    this.note.textContent =
      mode === 'official'
        ? 'Official server matches — your account colony, server-verified results.'
        : 'Classic peer-to-peer lobbies — host migration and custom rules. Community stats only, no official rewards.';
  }

  update(): void {
    if (this.picked) this.official?.update();
  }
}
