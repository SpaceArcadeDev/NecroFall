// NECROFALL — PLAY (plan §9/§35; user ask 2026-10-03): the format menu, and ONLY
// the format menu. Two decisions that used to live in one two-stage flow now have
// their own pages: this grid of mode cards, and — for CLASSIC — its own setup
// menu (`ClassicPage`, #/lobby) exactly like SPEEDRUN/SURVIVAL have theirs. The
// cards fill the frame: every mode is one tap away, never a scroll.
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { ClientCache } from '../spacetimedb/cache';
import { GAME_MODES } from '../../ui/data/GameModeRegistry';
import { rankStarRow } from '../../rank/RankService';
import { createNFModeCard } from '../../ui/components/NFModeCard';
import { createPageHeader } from '../../ui/shell/PageHeader';

export class PlayPage {
  readonly element: HTMLElement;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page play-page');

    const head = createPageHeader({
      title: 'MODES',
      subtitle: 'Choose your match format',
      onBack: () => this.ctx.goBack(),
    });
    this.element.appendChild(head);

    const col = el('div', 'menu-col play-col');

    // ---- the mode cards (§13/§56; user ask 2026-10-03): rendered FROM the game-mode
    // registry so every card keeps its declared actions on every viewport. The registry
    // handlers map each mode id to its real flow; the explicit action button carries
    // `data-action` for the dev audit. Each mode opens its OWN menu — CLASSIC goes to
    // its setup page exactly like SPEEDRUN/SURVIVAL go to the solo picker.
    const modes = el('div', 'play-modes');
    // Every launch REMEMBERS the mode (user ask 2026-10-03): the bottom bar's hero button
    // becomes the one the player actually plays — its icon, its menu, RANK's golden stars.
    const handlers: Record<string, () => void> = {
      classic: () => { this.ctx.setLastMode('classic'); this.ctx.goLobby(); },
      rank: () => { this.ctx.setLastMode('rank'); this.ctx.goRank(); },
      speedrun: () => { this.ctx.setLastMode('speedrun'); this.ctx.goSolo('speedrun'); },
      survival: () => { this.ctx.setLastMode('survival'); this.ctx.goSolo('survival'); },
      custom: () => { this.ctx.setLastMode('custom'); this.ctx.goCustom(); },
      freeroam: () => { this.ctx.setLastMode('freeroam'); this.ctx.startFreeroam(); },
    };
    const myStars = rankStarRow(Number(ClientCache.shared.me(this.ctx.myHex())?.rankPoints ?? 0)).html;
    for (const mode of GAME_MODES) {
      const card = createNFModeCard({
        mode,
        handlers: { play: handlers[mode.id] },
        // RANK wears the rank menu's GOLDEN language: the animated star row under its blurb
        // (user ask 2026-10-03 — "the golden animation effect same as before the revamp").
        extraLine: mode.id === 'rank' ? myStars : undefined,
      });
      // §33: short staggered entrance, one card after another.
      card.style.setProperty('--index', String(modes.childElementCount));
      modes.appendChild(card);
    }
    col.appendChild(modes);
    this.element.appendChild(col);
  }

  update(): void {
    /* the grid is static — the setup lives on each mode's own menu now */
  }
}
