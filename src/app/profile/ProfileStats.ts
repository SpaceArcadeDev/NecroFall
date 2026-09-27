// NECROFALL — profile statistics (plan §4/§44).
//
// All values are the SERVER's numbers (player + player_stats rows); the client
// never computes wins or currency locally.
import { ClientCache } from '../spacetimedb/cache';
import { el, formatDuration } from '../ui/dom';

export class ProfileStats {
  readonly element: HTMLElement;
  private grid: HTMLElement;

  constructor(private hex: string) {
    this.element = el('section', 'nf-profile-section');
    this.element.appendChild(el('h2', 'nf-section-title', 'STATISTICS'));
    this.grid = el('div', 'nf-stat-grid');
    this.element.appendChild(this.grid);
    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const player = cache.playerByHex(this.hex);
    const stats = cache.statsByHex(this.hex);
    while (this.grid.firstChild) this.grid.removeChild(this.grid.firstChild);

    const played = player?.matchesPlayed ?? 0;
    const wins = player?.wins ?? 0;
    const losses = player?.losses ?? 0;
    const winRate = played > 0 ? `${Math.round((wins / played) * 100)}%` : '—';
    const entries: { k: string; v: string }[] = [
      { k: 'Matches played', v: `${played}` },
      { k: 'Wins', v: `${wins}` },
      { k: 'Losses', v: `${losses}` },
      { k: 'Win rate', v: winRate },
      { k: 'Kills', v: `${stats?.kills ?? 0}` },
      { k: 'Deaths', v: `${stats?.deaths ?? 0}` },
      { k: 'Boss kills', v: `${stats?.bossKills ?? 0}` },
      { k: 'Beacons captured', v: `${stats?.beaconsCaptured ?? 0}` },
      { k: 'Nexus captures', v: `${stats?.nexusCaptures ?? 0}` },
      { k: 'Damage dealt', v: `${Math.round(stats?.damageDealt ?? 0).toLocaleString()}` },
      { k: 'Damage taken', v: `${Math.round(stats?.damageTaken ?? 0).toLocaleString()}` },
      { k: 'Play time', v: formatDuration(Number(stats?.playTimeSeconds ?? 0n)) },
      { k: 'Community (P2P)', v: `${stats?.p2pMatches ?? 0} played · ${stats?.p2pWins ?? 0} won` },
    ];
    for (const entry of entries) {
      const cell = el('div', 'nf-stat');
      cell.appendChild(el('span', 'nf-stat-k', entry.k));
      cell.appendChild(el('span', 'nf-stat-v', entry.v));
      this.grid.appendChild(cell);
    }
  }
}
