// NECROFALL — CUSTOM LOBBY SETUP (user ask 2026-09-30).
//
// CUSTOM is the P2P loop — create a lobby, hand out the code, ready up, the
// host starts — running on the HYBRID server architecture (the same one
// official matches use: server-owned lifecycle, WebRTC gameplay, verification).
// This screen is the entry: [LOBBY CODE][JOIN][CREATE LOBBY]; the ROOM itself
// is the SAME lobby screen the P2P and official-party flows use (the shell maps
// the custom match's seats onto it).
import { ShellContext } from '../ShellContext';
import { button, el } from '../ui/dom';

export class CustomPage {
  readonly element: HTMLElement;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page custom-page');

    const head = el('div', 'play-head');
    head.appendChild(el('div', 'menu-title', 'CUSTOM'));
    head.appendChild(el('div', 'menu-sub', 'lobby up with a code — P2P rules on the official hybrid server'));
    this.element.appendChild(head);

    const col = el('div', 'menu-col play-col');
    const card = el('div', 'nf-custom-card');

    // ---- join by code
    const joinRow = el('div', 'nf-play-row');
    const codeInput = el('input', 'nf-input nf-code') as HTMLInputElement;
    codeInput.maxLength = 8;
    codeInput.placeholder = 'LOBBY CODE';
    codeInput.autocapitalize = 'characters';
    codeInput.autocomplete = 'off';
    const join = button('JOIN', 'btn nf-small', () => {
      const code = codeInput.value.trim().toUpperCase();
      if (code.length < 4) {
        this.ctx.toast('Enter a valid lobby code.');
        return;
      }
      this.ctx.joinCustomLobbyByCode(code);
    });
    join.dataset.action = 'select';
    joinRow.append(codeInput, join);

    // ---- create
    const createRow = el('div', 'nf-play-actions');
    const create = button('CREATE LOBBY', 'btn primary nf-small', () => this.ctx.createCustomLobby());
    create.dataset.action = 'play';
    createRow.appendChild(create);

    card.append(joinRow, createRow);
    card.appendChild(
      el(
        'p',
        'muted nf-custom-note',
        'Up to 9 survivors. Everyone readies up, the host starts the match. Custom matches never grant official currency or rank — community rules, server-verified streams.'
      )
    );
    col.appendChild(card);
    this.element.appendChild(col);
  }
}
