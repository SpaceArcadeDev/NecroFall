// NECROFALL — the profile HERO (user ask 2026-09-29: the profile page was
// "too cluttered"; the identity block is now ONE glass card).
//
// Shows: the avatar (colony ring + gender glyph), name, colony + level badges,
// handle, bio, the shareable friend code — and, on the OWN profile, an EDIT
// sheet (name / bio / gender / colony). The avatar+icon pickers are GONE on
// purpose (user ask: "no need avatar switch or icon switching").
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { chooseColony, setBio, setGender, setPlayerName } from '../spacetimedb/reducers';
import { ShellContext } from '../ShellContext';
import { FollowButton } from '../friends/FollowButton';
import { button, el, setText } from '../ui/dom';

/** The 3-state gender glyph shown beside the avatar (0 = hidden). */
const GENDERS = ['', '♂', '♀'] as const;

export class ProfileHero {
  readonly element: HTMLElement;
  private card: HTMLElement;
  private avatar: HTMLElement;
  private initial: HTMLElement;
  private genderBadge: HTMLElement;
  private nameEl: HTMLElement;
  private colonyChip: HTMLElement;
  private levelChip: HTMLElement;
  private handleEl: HTMLElement;
  private bioEl: HTMLElement;
  private codeEl: HTMLElement;
  private shareBtn: HTMLButtonElement;
  private editBtn: HTMLButtonElement;
  private follow: FollowButton | null = null;
  private editor: HTMLElement;
  private nameInput: HTMLInputElement | null = null;
  private bioInput: HTMLTextAreaElement | null = null;
  private bioCount: HTMLElement | null = null;
  private genderChips: HTMLButtonElement[] = [];
  private colonyChips: HTMLButtonElement[] = [];
  /** The editor is OPEN — `update()` must not overwrite what the user is typing. */
  private open = false;

  constructor(private ctx: ShellContext, private hex: string) {
    const isMe = hex === ctx.myHex();
    this.element = el('section', 'nf-hero');

    // ---- one row: avatar | who | actions
    this.card = el('div', 'nf-hero-main');

    this.avatar = el('div', 'nf-hero-avatar');
    this.initial = el('span', 'nf-hero-initial', '?');
    this.avatar.appendChild(this.initial);
    this.genderBadge = el('span', 'nf-hero-gender hidden', '');
    this.avatar.appendChild(this.genderBadge);
    this.card.appendChild(this.avatar);

    const who = el('div', 'nf-hero-who');
    const nameRow = el('div', 'nf-hero-namerow');
    this.nameEl = el('h1', 'nf-hero-name', '…');
    nameRow.appendChild(this.nameEl);
    this.colonyChip = el('span', 'nf-hero-chip colony', '—');
    nameRow.appendChild(this.colonyChip);
    this.levelChip = el('span', 'nf-hero-chip level', 'LV 1');
    nameRow.appendChild(this.levelChip);
    who.appendChild(nameRow);
    this.handleEl = el('div', 'nf-hero-handle', '');
    who.appendChild(this.handleEl);
    this.bioEl = el('p', 'nf-hero-bio', '');
    who.appendChild(this.bioEl);
    this.card.appendChild(who);

    const actions = el('div', 'nf-hero-actions');
    if (isMe) {
      this.editBtn = button('EDIT', 'nf-btn small nf-hero-edit-btn', () => this.toggleEditor());
      actions.appendChild(this.editBtn);
    } else {
      this.editBtn = null as unknown as HTMLButtonElement;
      this.follow = new FollowButton(ctx.myHex(), hex);
      actions.appendChild(this.follow.element);
    }
    this.card.appendChild(actions);
    this.element.appendChild(this.card);

    // ---- code row: one tap copies the code; SHARE opens the share sheet (own profile only)
    const codeRow = el('div', 'nf-hero-code');
    codeRow.appendChild(el('span', 'nf-hero-code-label', 'FRIEND CODE'));
    const codeBtn = el('button', 'nf-hero-codebox') as HTMLButtonElement;
    codeBtn.type = 'button';
    codeBtn.title = 'Copy friend code';
    codeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>';
    this.codeEl = el('span', 'nf-hero-codeval', '——————');
    codeBtn.appendChild(this.codeEl);
    codeBtn.addEventListener('click', () => void this.copyCode());
    codeRow.appendChild(codeBtn);
    this.shareBtn = button('', 'nf-btn small nf-hero-share', () => void this.shareCode());
    this.shareBtn.setAttribute('aria-label', 'Share friend code');
    this.shareBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="6" r="2.6"/><circle cx="17.5" cy="18" r="2.6"/>' +
      '<path d="M8.4 10.8 15.2 7.3M8.4 13.2l6.8 3.5"/></svg>';
    if (isMe) codeRow.appendChild(this.shareBtn);
    else this.shareBtn.classList.add('hidden');
    this.element.appendChild(codeRow);

    // ---- the editor sheet (own profile only)
    this.editor = el('div', 'nf-hero-editor');
    this.element.appendChild(this.editor);
    if (isMe) this.buildEditor();
    else this.editor.classList.add('hidden');

    this.update();
  }

  // ------------------------------------------------------------ code actions

  private async copyCode(): Promise<void> {
    const code = this.codeEl.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      this.ctx.toast(`Friend code ${code} copied.`);
    } catch {
      this.ctx.toast('Copy failed — select the code and copy it manually.');
    }
  }

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

  // ------------------------------------------------------------ editor

  /** The pencil toggles ONE sheet — name, bio, gender and colony live inside it. */
  private toggleEditor(): void {
    this.open = !this.open;
    this.editor.classList.toggle('open', this.open);
    this.editBtn.textContent = this.open ? 'CLOSE' : 'EDIT';
    this.editBtn.classList.toggle('on', this.open);
    if (this.open) this.refill();
  }

  private refill(): void {
    const player = ClientCache.shared.playerByHex(this.hex);
    if (!player) return;
    if (this.nameInput) this.nameInput.value = player.playerName || '';
    if (this.bioInput) {
      this.bioInput.value = player.bio || '';
      this.paintBioCount();
    }
    this.genderChips.forEach((chip, i) => chip.classList.toggle('on', player.gender === i));
    this.colonyChips.forEach((chip, i) => chip.classList.toggle('on', player.colony === i));
  }

  private paintBioCount(): void {
    if (!this.bioCount || !this.bioInput) return;
    const n = this.bioInput.value.length;
    this.bioCount.textContent = `${n}/160`;
    this.bioCount.classList.toggle('near', n >= 140);
  }

  private saveName(): void {
    const value = (this.nameInput?.value ?? '').trim();
    if (value.length < 3) {
      this.ctx.toast('Names are 3–30 characters.');
      return;
    }
    setPlayerName(value);
    this.ctx.toast('Name saved.');
  }

  private saveBio(): void {
    if (!this.bioInput) return;
    setBio(this.bioInput.value);
    this.ctx.toast(this.bioInput.value.trim() ? 'Bio saved.' : 'Bio cleared.');
  }

  private buildEditor(): void {
    // ---- NAME
    const nameRow = el('div', 'nf-edit-row');
    nameRow.appendChild(el('span', 'nf-edit-label', 'NAME'));
    this.nameInput = el('input', 'nf-input') as HTMLInputElement;
    this.nameInput.maxLength = 30;
    this.nameInput.placeholder = '3–30 characters';
    this.nameInput.spellcheck = false;
    nameRow.appendChild(this.nameInput);
    nameRow.appendChild(button('SAVE', 'nf-btn small', () => this.saveName()));
    this.editor.appendChild(nameRow);

    // ---- BIO (160 chars, counted live)
    const bioRow = el('div', 'nf-edit-row nf-edit-bio');
    bioRow.appendChild(el('span', 'nf-edit-label', 'BIO'));
    const bioWrap = el('div', 'nf-bio-wrap');
    this.bioInput = el('textarea', 'nf-input nf-bio-input') as HTMLTextAreaElement;
    this.bioInput.maxLength = 160;
    this.bioInput.rows = 2;
    this.bioInput.placeholder = 'Say something survivors should know.';
    this.bioInput.addEventListener('input', () => this.paintBioCount());
    bioWrap.appendChild(this.bioInput);
    this.bioCount = el('span', 'nf-bio-count', '0/160');
    bioWrap.appendChild(this.bioCount);
    bioRow.appendChild(bioWrap);
    bioRow.appendChild(button('SAVE', 'nf-btn small', () => this.saveBio()));
    this.editor.appendChild(bioRow);

    // ---- GENDER (the glyph beside the avatar)
    const genderRow = el('div', 'nf-edit-row');
    genderRow.appendChild(el('span', 'nf-edit-label', 'GENDER'));
    const genderGrid = el('div', 'nf-chip-grid');
    (['NONE', 'MALE', 'FEMALE'] as const).forEach((label, i) => {
      const chip = button(i === 0 ? '—' : `${GENDERS[i]} ${label}`, 'nf-chip nf-chip-gender', () => {
        setGender(i);
        this.genderChips.forEach((c, j) => c.classList.toggle('on', i === j));
      });
      chip.title = label;
      this.genderChips.push(chip);
      genderGrid.appendChild(chip);
    });
    genderRow.appendChild(genderGrid);
    this.editor.appendChild(genderRow);

    // ---- COLONY (the server allows re-aligning at any time, plan §3 revision)
    const colonyRow = el('div', 'nf-edit-row');
    colonyRow.appendChild(el('span', 'nf-edit-label', 'COLONY'));
    const colonyGrid = el('div', 'nf-chip-grid');
    COLONIES.forEach((colony, index) => {
      const chip = button(`${colony.symbol} ${colony.name}`, 'nf-chip nf-chip-colony', () => {
        chooseColony(index);
        this.colonyChips.forEach((c, j) => c.classList.toggle('on', index === j));
      });
      chip.style.setProperty('--nf-colony', colony.css);
      this.colonyChips.push(chip);
      colonyGrid.appendChild(chip);
    });
    colonyRow.appendChild(colonyGrid);
    this.editor.appendChild(colonyRow);
  }

  // ------------------------------------------------------------ paint

  update(): void {
    const player = ClientCache.shared.playerByHex(this.hex);
    if (!player) {
      setText(this.nameEl, '…');
      return;
    }
    setText(this.nameEl, player.playerName || 'Recruit');
    setText(this.handleEl, `@${player.profileName || player.playerName || 'unknown'}`);
    setText(this.levelChip, `LV ${player.level}`);
    setText(this.initial, (player.playerName || 'R').slice(0, 1).toUpperCase());
    setText(this.codeEl, player.playerCode || '——————');

    const hasColony = player.colony < COLONIES.length;
    const col = hasColony ? COLONIES[player.colony] : null;
    setText(this.colonyChip, col ? `${col.symbol} ${col.name}` : 'UNALIGNED');
    this.colonyChip.style.setProperty('--nf-colony', col?.css ?? 'var(--ui-text-muted)');
    this.avatar.style.setProperty('--nf-colony', col?.css ?? 'var(--ui-accent)');

    const glyph = GENDERS[player.gender] ?? '';
    setText(this.genderBadge, glyph);
    this.genderBadge.classList.toggle('hidden', !glyph);
    this.genderBadge.classList.toggle('female', player.gender === 2);

    const isMe = this.hex === this.ctx.myHex();
    const bio = (player.bio || '').trim();
    // Own profile: the empty bio is an invitation (EDIT). Someone else's: hide the line.
    this.bioEl.classList.toggle('hidden', !bio && !isMe);
    setText(this.bioEl, bio || 'Tap EDIT to add a bio.');
    this.bioEl.classList.toggle('empty', !bio);

    this.follow?.update();
    // Live mirror of the editor chips (skipped into fields being typed in).
    if (this.open) return;
    this.genderChips.forEach((chip, i) => chip.classList.toggle('on', player.gender === i));
    this.colonyChips.forEach((chip, i) => chip.classList.toggle('on', player.colony === i));
  }
}
