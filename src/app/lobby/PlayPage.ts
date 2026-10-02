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
import { GAME_MODES } from '../../ui/data/GameModeRegistry';
import { createNFModeCard } from '../../ui/components/NFModeCard';

export class PlayPage {
  readonly element: HTMLElement;
  private classicCard!: HTMLElement;
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

    // ---- the mode cards (§13/§56): rendered FROM the game-mode registry so
    // every card keeps its declared actions on every viewport. The registry
    // handlers map each mode id to its real flow; the explicit action button
    // carries `data-action` for the dev audit.
    const modes = el('div', 'play-modes');
    const handlers: Record<string, () => void> = {
      classic: () => this.openClassic(),
      rank: () => this.ctx.goRank(),
      speedrun: () => this.ctx.goSolo('speedrun'),
      survival: () => this.ctx.goSolo('survival'),
      custom: () => this.ctx.goCustom(),
      freeroam: () => this.ctx.startFreeroam(),
    };
    for (const mode of GAME_MODES) {
      const card = createNFModeCard({
        mode,
        handlers: { play: handlers[mode.id] },
        picked: mode.id === 'classic' && this.picked,
      });
      if (mode.id === 'classic') this.classicCard = card;
      modes.appendChild(card);
    }
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
