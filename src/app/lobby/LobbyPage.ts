// NECROFALL — the CLASSIC menu (#/lobby; user ask 2026-10-03). CLASSIC has its
// OWN menu exactly like SPEEDRUN/SURVIVAL have theirs — never the mode grid with
// a setup "added on underneath". One page, one decision: run the match on the
// OFFICIAL server (colony row, LOBBY CODE + JOIN, CREATE LOBBY, FIND MATCH) or
// as a classic peer-to-peer lobby. The lobby ROOM itself is the next screen.
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { loadMultiplayerMode } from '../multiplayer/MultiplayerMode';
import { MultiplayerModeToggle } from './MultiplayerModeToggle';
import { OfficialLobby } from './OfficialLobby';
import { P2PLobby } from './P2PLobby';
import { createPageHeader } from '../../ui/shell/PageHeader';

export class LobbyPage {
  readonly element: HTMLElement;
  private toggle: MultiplayerModeToggle;
  private official: OfficialLobby;
  private p2p: P2PLobby;
  private note: HTMLElement;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page classic-page');
    this.element.appendChild(
      createPageHeader({
        title: 'CLASSIC',
        subtitle: 'Lobby up — official server or classic peer-to-peer',
        onBack: () => this.ctx.goBack(),
      })
    );

    const col = el('div', 'menu-col play-col');
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

    // ---- P2P: the classic lobby entry (name, CREATE LOBBY, JOIN) — it boots the
    // existing WebRTC game, where the P2P lobby screen lives.
    this.p2p = new P2PLobby(ctx);
    entry.appendChild(this.p2p.element);

    col.appendChild(entry);
    this.element.appendChild(col);

    // The roster lives on the LOBBY ROOM screen — the shared avatar rail is parked here.
    this.ctx.stageLobbyAvatars(null, []);
    this.applyMode(this.toggle.mode);
  }

  update(): void {
    this.official.update();
  }

  private applyMode(mode: 'official' | 'p2p'): void {
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
}
