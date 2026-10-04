// NECROFALL — the OFFICIAL setup section (plan §11/§35/§72): ONE colony row,
// then the party row — [PARTY CODE][JOIN][CREATE PARTY] on one line — with
// FIND MATCH on its own row below (OPEN PARTY fills the row while a party
// exists). The lobby roster itself lives on the LOBBY ROOM screen.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { ShellContext } from '../ShellContext';
import { button, el } from '../ui/dom';

export class OfficialLobby {
  readonly element: HTMLElement;
  private colonyLine: HTMLElement;
  private codeInput: HTMLInputElement;
  private joinBtn: HTMLButtonElement;
  private primaryBtn: HTMLButtonElement;
  private findBtn: HTMLButtonElement;
  private soloRow: HTMLElement;
  private inParty = false;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-lobby official');

    // ---- the account colony, ONE row (official matches always use it)
    const colonyRow = el('div', 'nf-colony-row');
    colonyRow.appendChild(el('span', 'nf-colony-row-label', 'COLONY'));
    this.colonyLine = el('span', 'nf-colony-row-name', '—');
    colonyRow.appendChild(this.colonyLine);
    this.element.appendChild(colonyRow);

    // ---- the party row: [PARTY CODE][JOIN][CREATE PARTY] on ONE line
    const partyRow = el('div', 'nf-play-row');
    this.codeInput = el('input', 'nf-input nf-code') as HTMLInputElement;
    this.codeInput.maxLength = 8;
    this.codeInput.placeholder = 'LOBBY CODE';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.autocomplete = 'off';
    this.joinBtn = button('JOIN', 'btn nf-small', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length < 4) {
        this.ctx.toast('Enter a valid lobby code.');
        return;
      }
      // JOIN NEVER OPENS A NEW-LOBBY PAGE (user ask 2026-09-29): the join fires, and
      // the LOBBY ROOM opens only once the server's rows actually land — a bad code
      // toasts instead of dropping the player on a page they did not ask for.
      this.ctx.setLobbyFormat('CLASSIC');
      this.ctx.joinLobbyByCode(code);
    });
    this.primaryBtn = button('CREATE LOBBY', 'btn primary nf-small', () => {
      // a lobby opened from the CLASSIC menu is a CLASSIC lobby — the LEADER tags it on the
      // SERVER so every member's room renders CLASSIC (user report 2026-10-04)
      this.ctx.setLobbyFormat('CLASSIC');
      const hex = this.ctx.myHex();
      const party = hex ? ClientCache.shared.myParty(hex) : null;
      if (this.inParty) {
        if (party && party.leader.toHexString() === hex) this.ctx.official.setPartyFormat('CLASSIC');
        this.ctx.goLobbyRoom();
        return;
      }
      this.ctx.official.createParty();
      this.ctx.official.setPartyFormat('CLASSIC');
      this.ctx.goLobbyRoom(); // CREATE LOBBY opens the room
    });
    partyRow.append(this.codeInput, this.joinBtn, this.primaryBtn);
    this.element.appendChild(partyRow);

    // ---- FIND MATCH — the solo queue, on its own full-width row below. There is
    // deliberately NO "PLAY SOLO / OFFLINE" entry (user ask 2026-09-29): classic
    // play goes through a lobby or the match finder, never a roomless world.
    this.soloRow = el('div', 'nf-play-actions');
    this.findBtn = button('FIND MATCH', 'btn primary nf-small', () => this.ctx.official.findMatch());
    this.soloRow.appendChild(this.findBtn);
    this.element.appendChild(this.soloRow);

    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const hex = this.ctx.myHex();
    const me = cache.playerByHex(hex);

    if (me && me.colony < 3) {
      const col = COLONIES[me.colony];
      this.colonyLine.textContent = col ? `${col.symbol} ${col.name}` : '—';
      this.colonyLine.style.setProperty('--nf-colony', col?.css ?? '#8fd7ff');
    } else {
      this.colonyLine.textContent = 'NOT CHOSEN';
      this.colonyLine.style.setProperty('--nf-colony', '#8fd7ff');
    }

    const ready = Boolean(me && me.playerName && me.colony < 3);
    const party = hex ? cache.myParty(hex) : null;
    this.inParty = Boolean(party);

    if (party) {
      // In a lobby: the LOBBY ROOM owns the search — leave a full-width way back in.
      this.codeInput.classList.add('hidden');
      this.joinBtn.classList.add('hidden');
      this.primaryBtn.textContent = 'OPEN LOBBY';
      this.primaryBtn.style.flex = '1 1 0';
      this.soloRow.classList.add('hidden');
    } else {
      this.codeInput.classList.remove('hidden');
      this.joinBtn.classList.remove('hidden');
      this.primaryBtn.textContent = 'CREATE LOBBY';
      this.primaryBtn.style.flex = '';
      this.soloRow.classList.remove('hidden');
    }
    this.findBtn.disabled = !ready;
    this.findBtn.textContent = ready ? 'FIND MATCH' : 'FINISH ONBOARDING FIRST';
  }
}
