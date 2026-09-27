// NECROFALL — the OFFICIAL setup section (plan §11/§35/§72): ONE colony row,
// then the party row — [PARTY CODE][JOIN][CREATE PARTY] on one line — with
// FIND MATCH on its own row below (OPEN PARTY fills the row while a party
// exists). The party roster itself lives on the PARTY screen.
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
    this.codeInput.placeholder = 'PARTY CODE';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.autocomplete = 'off';
    this.joinBtn = button('JOIN', 'btn nf-small', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length < 4) {
        this.ctx.toast('Enter a valid party code.');
        return;
      }
      this.ctx.official.joinPartyByCode(code);
      this.ctx.goParty(); // …and the PARTY screen gathers the roster
    });
    this.primaryBtn = button('CREATE PARTY', 'btn primary nf-small', () => {
      if (this.inParty) {
        this.ctx.goParty();
        return;
      }
      this.ctx.official.createParty();
      this.ctx.goParty(); // CREATE PARTY opens the PARTY screen
    });
    partyRow.append(this.codeInput, this.joinBtn, this.primaryBtn);
    this.element.appendChild(partyRow);

    // ---- FIND MATCH — the solo queue, on its own full-width row below
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
      // In a party: the PARTY screen owns the search — leave a full-width way back in.
      this.codeInput.classList.add('hidden');
      this.joinBtn.classList.add('hidden');
      this.primaryBtn.textContent = 'OPEN PARTY';
      this.primaryBtn.style.flex = '1 1 0';
      this.soloRow.classList.add('hidden');
    } else {
      this.codeInput.classList.remove('hidden');
      this.joinBtn.classList.remove('hidden');
      this.primaryBtn.textContent = 'CREATE PARTY';
      this.primaryBtn.style.flex = '';
      this.soloRow.classList.remove('hidden');
    }
    this.findBtn.disabled = !ready;
    this.findBtn.textContent = ready ? 'FIND MATCH' : 'FINISH ONBOARDING FIRST';
  }
}
