// NECROFALL — the P2P entry (plan §34/§35/§56): the classic play controls in
// the OFFICIAL setup's dress — [LOBBY CODE][JOIN][CREATE LOBBY] on one line,
// PLAY SOLO on its own row below, and the same button colours throughout.
// (user ask 2026-09-29: restored — CLASSIC offers OFFICIAL and P2P side by
// side; P2P boots the existing WebRTC game, where its lobby lives.)
import { ClientCache } from '../spacetimedb/cache';
import { ShellContext } from '../ShellContext';
import { button, el } from '../ui/dom';

/** The in-game client stores the LIBERATOR NAME under this key — both read it. */
const NAME_KEY = 'necrofall.name';

export class P2PLobby {
  readonly element: HTMLElement;
  private nameInput: HTMLInputElement;
  private accountName = '';

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-play-enter');

    // ---- survivor name: a signed-in player already carries one, so the row is
    // only asked for accounts without a name yet.
    const me = ClientCache.shared.playerByHex(ctx.myHex());
    this.accountName = (me?.playerName ?? '').trim();
    const nameRow = el('div', 'menu-name');
    nameRow.appendChild(el('span', 'menu-name-label', 'LIBERATOR NAME'));
    this.nameInput = el('input', 'menu-input') as HTMLInputElement;
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'YOUR NAME';
    this.nameInput.spellcheck = false;
    this.nameInput.autocomplete = 'off';
    try {
      this.nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* private mode */
    }
    const remember = (): void => {
      const name = this.nameInput.value.trim().slice(0, 16) || 'Survivor';
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {
        /* ignore */
      }
    };
    this.nameInput.addEventListener('change', remember);
    nameRow.appendChild(this.nameInput);
    this.element.appendChild(nameRow);
    nameRow.classList.toggle('hidden', Boolean(this.accountName));

    /** The name every P2P launch carries: the account's, or the local stand-in. */
    const nameFor = (): string => this.accountName || this.nameInput.value;

    // ---- the lobby row: [LOBBY CODE][JOIN][CREATE LOBBY] on ONE line — the
    // official lobby row's exact arrangement
    const lobbyRow = el('div', 'nf-play-row');
    const codeInput = el('input', 'nf-input nf-code') as HTMLInputElement;
    codeInput.maxLength = 8;
    codeInput.placeholder = 'LOBBY CODE';
    codeInput.autocapitalize = 'characters';
    codeInput.autocomplete = 'off';
    lobbyRow.appendChild(codeInput);
    lobbyRow.appendChild(
      button('JOIN', 'btn nf-small', () => {
        const code = codeInput.value.trim().toUpperCase();
        if (code.length < 4) {
          this.ctx.toast('Enter a valid lobby code.');
          return;
        }
        remember();
        this.ctx.launchLegacy({ roomCode: code, name: nameFor() });
      })
    );
    lobbyRow.appendChild(
      button('CREATE LOBBY', 'btn primary nf-small', () => {
        remember();
        this.ctx.launchLegacy({ host: true, name: nameFor() });
      })
    );
    this.element.appendChild(lobbyRow);

    // ---- PLAY SOLO — its own full-width row below, matching FIND MATCH's dress
    const soloRow = el('div', 'nf-play-actions');
    soloRow.appendChild(button('PLAY SOLO / OFFLINE', 'btn primary nf-small', () => this.ctx.launchLegacy({})));
    this.element.appendChild(soloRow);
    this.element.appendChild(
      el('p', 'muted', 'P2P games never grant official rank or currency — community stats only.')
    );
  }
}
