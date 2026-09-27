// NECROFALL — one player summary card (friend rail, party seats, viewers).
// Shows ONLY public data: name, level, colony, presence (plan §4).
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { hexOf, PRESENCE_IN_MATCH, PRESENCE_ONLINE } from '../spacetimedb/rows';
import { el } from './dom';

export function presenceLabel(status: number): string {
  if (status === PRESENCE_IN_MATCH) return 'In match';
  if (status === PRESENCE_ONLINE) return 'Online';
  return 'Offline';
}

export function presenceClass(status: number): string {
  return status === PRESENCE_IN_MATCH ? 'in-match' : status === PRESENCE_ONLINE ? 'online' : 'offline';
}

export class ProfileCard {
  readonly element: HTMLElement;
  private statusDot: HTMLElement;

  constructor(private hex: string, onClick?: () => void) {
    this.element = el('button', 'nf-card') as HTMLButtonElement;
    (this.element as HTMLButtonElement).type = 'button';
    const avatar = el('div', 'nf-avatar', '');
    this.statusDot = el('span', 'nf-dot offline', '');
    avatar.appendChild(this.statusDot);
    this.element.appendChild(avatar);
    const col = el('div', 'nf-card-col');
    this.element.appendChild(col);
    this.nameEl = el('span', 'nf-card-name', '…');
    col.appendChild(this.nameEl);
    this.metaEl = el('span', 'nf-card-meta', '');
    col.appendChild(this.metaEl);
    if (onClick) this.element.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    this.update();
  }

  private nameEl: HTMLElement;
  private metaEl: HTMLElement;

  update(): void {
    const cache = ClientCache.shared;
    const player = cache.playerByHex(this.hex);
    const row = cache.presenceByHex(this.hex);
    const status = row?.status ?? 0;
    this.statusDot.className = `nf-dot ${presenceClass(status)}`;
    if (!player) {
      this.nameEl.textContent = '…';
      this.metaEl.textContent = '';
      return;
    }
    this.nameEl.textContent = player.playerName || 'Recruit';
    const colony = player.colony < 3 ? COLONIES[player.colony]?.name ?? '' : '';
    this.metaEl.textContent = `Lv ${player.level}${colony ? ` · ${colony}` : ''} · ${presenceLabel(status)}`;
    const color = player.colony < 3 ? COLONIES[player.colony]?.css : undefined;
    this.element.style.setProperty('--nf-card-accent', color ?? '#8fd7ff');
  }

  get identityHex(): string {
    return this.hex;
  }
}

export function playerNameOf(hex: string): string {
  return ClientCache.shared.playerByHex(hex)?.playerName || 'Recruit';
}

void hexOf;
