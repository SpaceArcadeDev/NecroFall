// NECROFALL — profile header (plan §4/§37): avatar, name, level, colony badge,
// follow action. The owner additionally gets the edit controls.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { chooseColony, setAvatar, setPlayerName, setProfilePicture } from '../spacetimedb/reducers';
import { ShellContext } from '../ShellContext';
import { FollowButton } from '../friends/FollowButton';
import { button, el } from '../ui/dom';

const AVATARS = ['survivor_01', 'survivor_02', 'survivor_03', 'survivor_04', 'necro_01', 'necro_02', 'necro_03', 'necro_04'];

export class ProfileHeader {
  readonly element: HTMLElement;
  private nameEl: HTMLElement;
  private handleEl: HTMLElement;
  private levelEl: HTMLElement;
  private colonyEl: HTMLElement;
  private codeRow: HTMLElement;
  private codeEl: HTMLElement;
  private colonyChips: HTMLButtonElement[] = [];
  private avatarChips: HTMLButtonElement[] = [];
  private picChips: HTMLButtonElement[] = [];
  private follow: FollowButton | null;
  private editor: HTMLElement;

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('div', 'nf-profile-head');

    const row = el('div', 'nf-profile-id');
    this.avatar = el('div', 'nf-profile-avatar', '');
    row.appendChild(this.avatar);
    const who = el('div', 'nf-profile-who');
    this.nameEl = el('h1', 'nf-profile-name', '…');
    this.handleEl = el('div', 'nf-profile-handle', '');
    this.levelEl = el('div', 'nf-profile-level', '');
    this.colonyEl = el('div', 'nf-profile-colony', '');
    who.appendChild(this.nameEl);
    who.appendChild(this.handleEl);
    // ---- the shareable friend code (plan §64): one tap to copy, one to share.
    this.codeRow = el('div', 'nf-profile-code-row');
    this.codeRow.appendChild(el('span', 'nf-profile-code-label', 'CODE'));
    this.codeEl = el('span', 'nf-profile-code', '——————');
    this.codeRow.appendChild(this.codeEl);
    this.codeRow.appendChild(button('COPY', 'nf-btn small nf-code-btn', () => void this.copyCode()));
    this.codeRow.appendChild(button('SHARE', 'nf-btn small nf-code-btn', () => void this.shareCode()));
    who.appendChild(this.codeRow);
    who.appendChild(this.levelEl);
    who.appendChild(this.colonyEl);
    row.appendChild(who);
    this.element.appendChild(row);

    const actions = el('div', 'nf-profile-actions');
    this.follow = hex === ctx.myHex() ? null : new FollowButton(ctx.myHex(), hex);
    if (this.follow) actions.appendChild(this.follow.element);
    this.element.appendChild(actions);

    this.editor = el('div', 'nf-profile-editor');
    this.element.appendChild(this.editor);
    this.buildEditor();
    this.update();
  }

  private avatar: HTMLElement;

  /** Copy the friend code to the clipboard (the share-sheet falls back here too). */
  private async copyCode(): Promise<void> {
    const code = this.codeEl.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      this.ctx.toast(`Friend code ${code} copied.`);
    } catch {
      this.ctx.toast('Copy failed — select the code and copy it manually.');
    }
  }

  /** Native share sheet where available; everything else falls back to copying. */
  private async shareCode(): Promise<void> {
    const code = this.codeEl.textContent ?? '';
    const shareFn = (navigator as Navigator & {
      share?: (data: { title?: string; text?: string }) => Promise<void>;
    }).share;
    if (shareFn) {
      try {
        await shareFn.call(navigator, { title: 'NECROFALL', text: `Add me on NECROFALL — my friend code is ${code}` });
        return;
      } catch {
        /* sheet dismissed — fall through to copying */
      }
    }
    await this.copyCode();
  }

  private buildEditor(): void {
    const isMe = this.hex === this.ctx.myHex();
    if (!isMe) {
      this.editor.classList.add('hidden');
      return;
    }
    this.editor.classList.remove('hidden');

    // Rename (server validates length/charset/uniqueness — plan §64).
    const nameRow = el('div', 'nf-edit-row');
    nameRow.appendChild(el('span', 'nf-edit-label', 'NAME'));
    const input = el('input', 'nf-input') as HTMLInputElement;
    input.maxLength = 16;
    input.placeholder = '3–16 characters';
    nameRow.appendChild(input);
    nameRow.appendChild(button('SAVE', 'nf-btn small', () => {
      const value = input.value.trim();
      if (value.length < 3) {
        this.ctx.toast('Names are 3–16 characters.');
        return;
      }
      setPlayerName(value);
    }));
    this.editor.appendChild(nameRow);

    // Colony re-alignment: the server allows switching at any time (plan §3 revision).
    const colonyRow = el('div', 'nf-edit-row');
    colonyRow.appendChild(el('span', 'nf-edit-label', 'COLONY'));
    const colonyGrid = el('div', 'nf-avatar-grid');
    COLONIES.forEach((colony, index) => {
      const chip = button(`${colony.symbol} ${colony.name}`, 'nf-chip nf-chip-colony', () => chooseColony(index));
      chip.style.setProperty('--nf-colony', colony.css);
      this.colonyChips.push(chip);
      colonyGrid.appendChild(chip);
    });
    colonyRow.appendChild(colonyGrid);
    this.editor.appendChild(colonyRow);

    // Avatar picker (data-only ids; the game maps them to models).
    const avatarRow = el('div', 'nf-edit-row');
    avatarRow.appendChild(el('span', 'nf-edit-label', 'AVATAR'));
    const grid = el('div', 'nf-avatar-grid');
    AVATARS.forEach((id, index) => {
      const b = button(String(index + 1).padStart(2, '0'), 'nf-chip', () => setAvatar(index));
      b.title = id;
      this.avatarChips.push(b);
      grid.appendChild(b);
    });
    avatarRow.appendChild(grid);
    this.editor.appendChild(avatarRow);

    // Profile picture picker (predefined set only — no uploads in v1, plan §65).
    const picRow = el('div', 'nf-edit-row');
    picRow.appendChild(el('span', 'nf-edit-label', 'ICON'));
    const picGrid = el('div', 'nf-avatar-grid');
    for (let i = 0; i < 8; i++) {
      const chip = button(String(i + 1), 'nf-chip', () => setProfilePicture(i));
      this.picChips.push(chip);
      picGrid.appendChild(chip);
    }
    picRow.appendChild(picGrid);
    this.editor.appendChild(picRow);
  }

  update(): void {
    const cache = ClientCache.shared;
    const player = cache.playerByHex(this.hex);
    if (!player) {
      this.nameEl.textContent = '…';
      return;
    }
    this.nameEl.textContent = player.playerName || 'Recruit';
    this.handleEl.textContent = `@${player.profileName || player.playerName || 'unknown'}`;
    this.codeEl.textContent = player.playerCode || '——————';
    this.levelEl.textContent = `Level ${player.level}`;
    // The editor chips mirror the live rows: the current pick glows.
    this.colonyChips.forEach((chip, i) => chip.classList.toggle('on', player.colony === i));
    this.avatarChips.forEach((chip, i) => chip.classList.toggle('on', player.avatarId === i));
    this.picChips.forEach((chip, i) => chip.classList.toggle('on', player.profilePicture === i));
    if (player.colony < 3) {
      const col = COLONIES[player.colony];
      this.colonyEl.textContent = col?.name ?? '—';
      this.colonyEl.style.setProperty('--nf-colony', col?.css ?? '#8fd7ff');
    } else {
      this.colonyEl.textContent = 'NO COLONY';
      this.colonyEl.style.setProperty('--nf-colony', '#8fd7ff');
    }
    this.avatar.textContent = (player.playerName || 'R').slice(0, 1).toUpperCase();
    this.follow?.update();
  }
}
