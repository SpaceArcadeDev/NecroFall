// NECROFALL — top resource bar (overhaul §9/§10/§48): avatar, name, RANK,
// currencies, utilities. Values come from the subscribed wallet/player rows —
// never from local state. The avatar is the shared NFAvatar component,
// colony-tinted, so identity reads the same here as in the lobby and profile.
import { ClientCache } from '../spacetimedb/cache';
import { COLONIES } from '../../core/Config';
import { getRankDisplayName } from '../../rank/RankService';
import { el, formatCurrency } from './dom';
import { createNFAvatar } from '../../ui/components/NFAvatar';
import { getIcon } from '../../ui/icons';

export class CurrencyBar {
  readonly element: HTMLElement;
  private nameEl: HTMLElement;
  private rankEl: HTMLElement;
  private softEl: HTMLElement;
  private premiumEl: HTMLElement;

  constructor(private myHex: () => string, private onProfile: () => void) {
    this.element = el('header', 'nf-top');
    const me = el('button', 'nf-top-me') as HTMLButtonElement;
    me.type = 'button';
    me.dataset.action = 'profile';
    me.setAttribute('aria-label', 'Open your profile');
    me.addEventListener('click', () => this.onProfile());
    this.avatarEl = createNFAvatar({ name: '?', size: 'md', status: 'online' });
    me.appendChild(this.avatarEl);
    const who = el('span', 'nf-top-who');
    this.nameEl = el('span', 'nf-top-name', '…');
    this.rankEl = el('span', 'nf-top-rank is-unranked', 'UNRANKED');
    who.appendChild(this.nameEl);
    who.appendChild(this.rankEl);
    me.appendChild(who);
    this.element.appendChild(me);

    const currencies = el('div', 'nf-top-currency');
    const soft = el('span', 'nf-currency soft');
    soft.appendChild(el('i', 'nf-coin soft', '◈'));
    this.softEl = el('b', '', '0');
    soft.appendChild(this.softEl);
    const premium = el('span', 'nf-currency premium');
    premium.appendChild(el('i', 'nf-coin premium', '✦'));
    this.premiumEl = el('b', '', '0');
    premium.appendChild(this.premiumEl);
    currencies.appendChild(soft);
    currencies.appendChild(premium);
    this.element.appendChild(currencies);

    this.settings = el('button', 'nf-top-settings', '') as HTMLButtonElement;
    this.settings.type = 'button';
    this.settings.title = 'Menu — settings, controls, how to play';
    this.settings.setAttribute('aria-label', 'Open menu');
    this.settings.dataset.action = 'settings';
    this.settings.innerHTML = getIcon('settings');
    this.element.appendChild(this.settings);
    this.update();
  }

  readonly settings: HTMLButtonElement;
  private avatarEl: HTMLElement;

  update(): void {
    const cache = ClientCache.shared;
    const hex = this.myHex();
    const player = cache.playerByHex(hex);
    const wallet = cache.walletByHex(hex);
    const name = player?.playerName || 'Recruit';
    this.nameEl.textContent = name;
    this.softEl.textContent = formatCurrency(wallet?.softCurrency);
    this.premiumEl.textContent = formatCurrency(wallet?.premiumCurrency);

    // RANK (§9): the real ladder when the player row carries points, else UNRANKED.
    const points = player?.rankPoints ?? 0;
    if (player && points > 0) {
      this.rankEl.textContent = `LV ${player.level} · ${getRankDisplayName(points)}`;
      this.rankEl.classList.remove('is-unranked');
    } else if (player) {
      this.rankEl.textContent = `LV ${player.level} · UNRANKED`;
      this.rankEl.classList.add('is-unranked');
    } else {
      this.rankEl.textContent = 'UNRANKED';
      this.rankEl.classList.add('is-unranked');
    }

    // patch the avatar in place (initial + colony accent), no churn per tick
    const initial = this.avatarEl.querySelector<HTMLElement>('.nf-avatar__initial');
    if (initial) initial.textContent = name.slice(0, 1).toUpperCase();
    const colony = player && player.colony < 3 ? COLONIES[player.colony] : null;
    if (colony) this.avatarEl.style.setProperty('--nf-avatar-accent', colony.css);
    else this.avatarEl.style.removeProperty('--nf-avatar-accent');
  }
}
