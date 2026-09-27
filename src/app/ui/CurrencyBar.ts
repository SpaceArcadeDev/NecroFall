// NECROFALL — top resource bar (plan §8/§37): avatar, name, currencies.
// Values come from the subscribed wallet/player rows — never from local state.
import { ClientCache } from '../spacetimedb/cache';
import { el, formatCurrency } from './dom';

export class CurrencyBar {
  readonly element: HTMLElement;
  private nameEl: HTMLElement;
  private levelEl: HTMLElement;
  private softEl: HTMLElement;
  private premiumEl: HTMLElement;

  constructor(private myHex: () => string, private onProfile: () => void) {
    this.element = el('header', 'nf-top');
    const me = el('button', 'nf-top-me') as HTMLButtonElement;
    me.type = 'button';
    me.addEventListener('click', () => this.onProfile());
    this.avatarEl = el('span', 'nf-top-avatar', '');
    me.appendChild(this.avatarEl);
    const who = el('span', 'nf-top-who');
    this.nameEl = el('span', 'nf-top-name', '…');
    this.levelEl = el('span', 'nf-top-level', '');
    who.appendChild(this.nameEl);
    who.appendChild(this.levelEl);
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

    this.settings = el('button', 'nf-top-settings', '⚙') as HTMLButtonElement;
    this.settings.type = 'button';
    this.settings.title = 'Settings';
    this.element.appendChild(this.settings);
    // "?" — the how-to-play entry, to the LEFT of the settings gear.
    this.howto = el('button', 'nf-top-settings nf-top-howto', '?') as HTMLButtonElement;
    this.howto.type = 'button';
    this.howto.title = 'How to play';
    this.howto.setAttribute('aria-label', 'How to play');
    this.element.insertBefore(this.howto, this.settings);
    this.update();
  }

  readonly settings: HTMLButtonElement;
  readonly howto: HTMLButtonElement;
  private avatarEl: HTMLElement;

  update(): void {
    const cache = ClientCache.shared;
    const hex = this.myHex();
    const player = cache.playerByHex(hex);
    const wallet = cache.walletByHex(hex);
    this.nameEl.textContent = player?.playerName || 'Recruit';
    this.levelEl.textContent = player ? `Lv ${player.level}` : '';
    this.softEl.textContent = formatCurrency(wallet?.softCurrency);
    this.premiumEl.textContent = formatCurrency(wallet?.premiumCurrency);
    if (player) this.avatarEl.textContent = player.playerName.slice(0, 1).toUpperCase();
  }
}
