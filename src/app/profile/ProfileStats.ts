// NECROFALL — profile STATISTICS pane (user ask 2026-09-29: the old flat grid
// became one compact block inside the new tabbed profile).
//
// All values are the SERVER's numbers (player + player_stats rows); the client
// never computes wins or currency locally. Values are patched in place — the
// page repaints on every data tick, and rebuilding 13 tiles each time was
// pointless churn.
import { ClientCache } from '../spacetimedb/cache';
import { ShellContext } from '../ShellContext';
import { subscribePlayer } from '../spacetimedb/subscriptions';
import { clear, el, formatDuration, setText } from '../ui/dom';
import { ProfileCard } from '../ui/ProfileCard';

interface Tile {
  key: string;
  node: HTMLElement;
}

export class ProfileStats {
  readonly element: HTMLElement;
  private socialVals: HTMLElement[] = [];
  private tiles: Tile[] = [];
  private viewers: HTMLElement;
  private viewersRow: HTMLElement;
  private viewersSig = '';

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('section', 'nf-p-pane nf-p-stats');

    // ---- the three social counters, as quiet chips above the grid
    const social = el('div', 'nf-p-social');
    for (const label of ['Followers', 'Following', 'Views']) {
      const chip = el('div', 'nf-p-soc');
      const value = el('b', 'nf-p-soc-v', '0');
      chip.appendChild(value);
      chip.appendChild(el('span', 'nf-p-soc-k', label));
      this.socialVals.push(value);
      social.appendChild(chip);
    }
    this.element.appendChild(social);

    // ---- the career grid
    const grid = el('div', 'nf-p-grid');
    const KEYS: Array<[string, string]> = [
      ['matches', 'Matches'],
      ['wins', 'Wins'],
      ['losses', 'Losses'],
      ['winrate', 'Win rate'],
      ['kills', 'Kills'],
      ['deaths', 'Deaths'],
      ['boss', 'Boss kills'],
      ['beacons', 'Beacons'],
      ['nexus', 'Nexus takes'],
      ['damage', 'Damage dealt'],
      ['taken', 'Damage taken'],
      ['time', 'Play time'],
      ['p2p', 'P2P played'],
    ];
    for (const [key, label] of KEYS) {
      const tile = el('div', 'nf-p-tile');
      tile.appendChild(el('span', 'nf-p-tile-k', label));
      const value = el('b', 'nf-p-tile-v', '—');
      tile.appendChild(value);
      this.tiles.push({ key, node: value });
      grid.appendChild(tile);
    }
    this.element.appendChild(grid);

    // ---- recent visitors (hidden while none — a fresh profile has no audience)
    this.viewers = el('section', 'nf-p-viewers hidden');
    this.viewers.appendChild(el('h3', 'nf-p-sub-title', 'RECENT VISITORS'));
    this.viewersRow = el('div', 'nf-p-viewer-row');
    this.viewers.appendChild(this.viewersRow);
    this.element.appendChild(this.viewers);

    this.update();
  }

  update(): void {
    const cache = ClientCache.shared;
    const player = cache.playerByHex(this.hex);
    const stats = cache.statsByHex(this.hex);

    const played = player?.matchesPlayed ?? 0;
    const wins = player?.wins ?? 0;
    const losses = player?.losses ?? 0;
    const values: Record<string, string> = {
      matches: `${played}`,
      wins: `${wins}`,
      losses: `${losses}`,
      winrate: played > 0 ? `${Math.round((wins / played) * 100)}%` : '—',
      kills: `${stats?.kills ?? 0}`,
      deaths: `${stats?.deaths ?? 0}`,
      boss: `${stats?.bossKills ?? 0}`,
      beacons: `${stats?.beaconsCaptured ?? 0}`,
      nexus: `${stats?.nexusCaptures ?? 0}`,
      damage: `${Math.round(stats?.damageDealt ?? 0).toLocaleString()}`,
      taken: `${Math.round(stats?.damageTaken ?? 0).toLocaleString()}`,
      time: formatDuration(Number(stats?.playTimeSeconds ?? 0n)) || '0:00',
      p2p: `${stats?.p2pMatches ?? 0}`,
    };
    for (const tile of this.tiles) setText(tile.node, values[tile.key] ?? '—');

    setText(this.socialVals[0], `${player?.followersCount ?? 0}`);
    setText(this.socialVals[1], `${player?.followingCount ?? 0}`);
    setText(this.socialVals[2], `${player?.profileViews ?? 0}`);

    this.renderViewers();
  }

  private renderViewers(): void {
    const cache = ClientCache.shared;
    const viewers = cache.profileViewers(this.hex).slice(0, 12);
    const sig = viewers.map((v) => `${v.id}:${v.viewer.toHexString()}`).join('|');
    if (sig === this.viewersSig) return;
    this.viewersSig = sig;
    this.viewers.classList.toggle('hidden', viewers.length === 0);
    clear(this.viewersRow);
    for (const view of viewers) {
      const viewerHex = view.viewer.toHexString();
      if (!cache.playerByHex(viewerHex)) subscribePlayer(viewerHex);
      const card = new ProfileCard(viewerHex, () => this.ctx.openProfile(viewerHex));
      card.update();
      this.viewersRow.appendChild(card.element);
    }
  }
}
