// NECROFALL — the profile HERO (user ask 2026-09-29, pass 2: "make it look like a
// 100k profile website"). One identity block: a cover-lit card with the avatar (colony
// ring + gender glyph), the name in display type over a colony glow, @handle with
// colony/level tags, the bio — and a right rail with the shareable friend code and the
// EDIT / FOLLOW action.
//
// The avatar + profile-icon pickers are GONE on purpose (user ask); everything the owner
// can change lives in one EDIT sheet: name, bio, gender, colony.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { chooseColony, setBio, setGender, setPlayerName } from '../spacetimedb/reducers';
import { ShellContext } from '../ShellContext';
import { FollowButton } from '../friends/FollowButton';
import { button, el, setText } from '../ui/dom';

/** The 3-state gender glyph shown beside the avatar (0 = hidden). */
const GENDERS = ['', '♂', '♀'] as const;
const GENDER_LABELS = ['', 'MALE', 'FEMALE'] as const;

export class ProfileHero {
  readonly element: HTMLElement;
  private avatar: HTMLElement;
  private initial: HTMLElement;
  private genderBadge: HTMLElement;
  private nameEl: HTMLElement;
  private colonyChip: HTMLElement;
  private levelChip: HTMLElement;
  private genderTag: HTMLElement;
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

    // ---- identity: avatar | name / handle + tags / bio
    const id = el('div', 'nf-hero-id');
    this.avatar = el('div', 'nf-hero-avatar');
    this.initial = el('span', 'nf-hero-initial', '?');
    this.avatar.appendChild(this.initial);
    this.genderBadge = el('span', 'nf-hero-gender hidden', '');
    this.avatar.appendChild(this.genderBadge);
    id.appendChild(this.avatar);

    const who = el('div', 'nf-hero-who');
    this.nameEl = el('h1', 'nf-hero-name', '…');
    who.appendChild(this.nameEl);
    const sub = el('div', 'nf-hero-sub');
    this.handleEl = el('span', 'nf-hero-handle', '');
    sub.appendChild(this.handleEl);
    this.colonyChip = el('span', 'nf-tag colony', '');
    this.levelChip = el('span', 'nf-tag', 'LV 1');
    this.genderTag = el('span', 'nf-tag gender hidden', '');
    sub.appendChild(this.colonyChip);
    sub.appendChild(this.levelChip);
    sub.appendChild(this.genderTag);
    who.appendChild(sub);
    this.bioEl = el('p', 'nf-hero-bio', '');
    who.appendChild(this.bioEl);
    id.appendChild(who);
    this.element.appendChild(id);

    // ---- right rail: the shareable code + the primary action
    const side = el('div', 'nf-hero-side');
    const codeWrap = el('div', 'nf-hero-code');
    codeWrap.appendChild(el('span', 'nf-hero-code-label', 'FRIEND CODE'));
    const codeBtn = el('button', 'nf-hero-codebox') as HTMLButtonElement;
    codeBtn.type = 'button';
    codeBtn.title = 'Copy friend code';
    codeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>';
    this.codeEl = el('span', 'nf-hero-codeval', '——————');
    codeBtn.appendChild(this.codeEl);
    codeBtn.addEventListener('click', () => void this.copyCode());
    codeWrap.appendChild(codeBtn);
    this.shareBtn = button('', 'nf-btn small nf-hero-share', () => void this.shareCode());
    this.shareBtn.setAttribute('aria-label', 'Share friend code');
    this.shareBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="6" r="2.6"/><circle cx="17.5" cy="18" r="2.6"/>' +
      '<path d="M8.4 10.8 15.2 7.3M8.4 13.2l6.8 3.5"/></svg>';
    if (isMe) codeWrap.appendChild(this.shareBtn);
    side.appendChild(codeWrap);

    const actions = el('div', 'nf-hero-actions');
    if (isMe) {
      // A SMALL icon button (user ask 2026-09-29): the pencil opens the sheet, becomes an X.
      this.editBtn = button('', 'nf-btn nf-hero-edit-btn', () => this.toggleEditor());
      this.editBtn.title = 'Edit profile';
      this.editBtn.setAttribute('aria-label', 'Edit profile');
      this.paintEditIcon();
      actions.appendChild(this.editBtn);
    } else {
      this.editBtn = null as unknown as HTMLButtonElement;
      this.follow = new FollowButton(ctx.myHex(), hex);
      actions.appendChild(this.follow.element);
    }
    side.appendChild(actions);
    this.element.appendChild(side);

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
    this.editBtn.classList.toggle('on', this.open);
    this.editBtn.title = this.open ? 'Close the editor' : 'Edit profile';
    this.editBtn.setAttribute('aria-label', this.editBtn.title);
    this.paintEditIcon();
    this.element.classList.toggle('editing', this.open);
    if (this.open) this.refill();
  }

  /** The icon button flips between a pencil and a close cross. */
  private paintEditIcon(): void {
    this.editBtn.innerHTML = this.open
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4.2L19.4 8.8a2.1 2.1 0 0 0 0-3L18.2 4.6a2.1 2.1 0 0 0-3 0L4 15.8V20z"/></svg>';
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
    // ONE accent for the whole card: the avatar ring, the name glow and the colony chip.
    this.element.style.setProperty('--nf-colony', col?.css ?? 'var(--ui-accent)');

    const glyph = GENDERS[player.gender] ?? '';
    setText(this.genderBadge, glyph);
    this.genderBadge.classList.toggle('hidden', !glyph);
    this.genderBadge.classList.toggle('female', player.gender === 2);
    setText(this.genderTag, `${glyph} ${GENDER_LABELS[player.gender] ?? ''}`.trim());
    this.genderTag.classList.toggle('hidden', !glyph);

    const isMe = this.hex === this.ctx.myHex();
    const bio = (player.bio || '').trim();
    // Own profile: the empty bio is an invitation (EDIT). Someone else's: hide the line.
    this.bioEl.classList.toggle('hidden', !bio && !isMe);
    setText(this.bioEl, bio || 'Tap EDIT PROFILE to add a bio.');
    this.bioEl.classList.toggle('empty', !bio);

    this.follow?.update();
    // Live mirror of the editor chips (skipped while the user is typing in the sheet).
    if (this.open) return;
    this.genderChips.forEach((chip, i) => chip.classList.toggle('on', player.gender === i));
    this.colonyChips.forEach((chip, i) => chip.classList.toggle('on', player.colony === i));
  }
}
