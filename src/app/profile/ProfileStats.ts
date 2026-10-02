// NECROFALL — profile STATISTICS pane (reworked 2026-09-29, pass 2: the flat tile grid
// became a profile-website layout — headline numbers, then a clean key/value table).
//
// All values are the SERVER's numbers (player + player_stats rows); the client never
// computes wins or currency locally. Every value is patched in place — the page repaints
// on every data tick and rebuilding the DOM each time was pointless churn.
import { ClientCache } from '../spacetimedb/cache';
import { ShellContext } from '../ShellContext';
import { subscribePlayer } from '../spacetimedb/subscriptions';
import { clear, el, formatDuration, setText } from '../ui/dom';
import { ProfileCard } from '../ui/ProfileCard';

export class ProfileStats {
  readonly element: HTMLElement;
  private countEl: HTMLElement;
  private headline: Array<{ key: string; node: HTMLElement }> = [];
  private rows: Array<{ key: string; node: HTMLElement }> = [];
  private socialVals: HTMLElement[] = [];
  private viewers: HTMLElement;
  private viewersRow: HTMLElement;
  private viewersSig = '';

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('section', 'nf-p-pane nf-p-stats');

    // the pane title is gone (user ask 2026-10-03): the tab rail already says CAREER —
    // the count span keeps updating, it just has no title bar to sit in any more.
    this.countEl = el('span', 'nf-p-pane-count', '');

    // ---- headline numbers: the four figures a profile site puts on top
    const hero = el('div', 'nf-p-hstats');
    const HEADLINE: Array<[string, string]> = [
      ['matches', 'Matches'],
      ['wins', 'Wins'],
      ['winrate', 'Win rate'],
      ['kills', 'Kills'],
    ];
    for (const [key, label] of HEADLINE) {
      const cell = el('div', 'nf-p-hstat');
      const value = el('b', 'nf-p-hstat-v', '—');
      cell.appendChild(value);
      cell.appendChild(el('span', 'nf-p-hstat-k', label));
      this.headline.push({ key, node: value });
      hero.appendChild(cell);
    }
    this.element.appendChild(hero);

    // ---- the detail table: label … value, two columns of hairlines
    const kv = el('div', 'nf-p-kv');
    const DETAIL: Array<[string, string]> = [
      ['losses', 'Losses'],
      ['deaths', 'Deaths'],
      ['boss', 'Boss kills'],
      ['beacons', 'Beacons taken'],
      ['nexus', 'Nexus captures'],
      ['damage', 'Damage dealt'],
      ['taken', 'Damage taken'],
      ['time', 'Play time'],
      ['p2p', 'P2P matches'],
    ];
    for (const [key, label] of DETAIL) {
      const item = el('div', 'nf-p-kvi');
      item.appendChild(el('span', 'nf-p-kvi-k', label));
      const value = el('b', 'nf-p-kvi-v', '—');
      item.appendChild(value);
      this.rows.push({ key, node: value });
      kv.appendChild(item);
    }
    this.element.appendChild(kv);

    // ---- social counters (followers / following / views)
    const socialTitle = el('div', 'nf-p-sub');
    socialTitle.appendChild(el('span', '', 'SOCIAL'));
    this.element.appendChild(socialTitle);
    const social = el('div', 'nf-p-social');
    for (const label of ['Followers', 'Following', 'Views']) {
      const cell = el('div', 'nf-p-soc');
      const value = el('b', 'nf-p-soc-v', '0');
      cell.appendChild(value);
      cell.appendChild(el('span', 'nf-p-soc-k', label));
      this.socialVals.push(value);
      social.appendChild(cell);
    }
    this.element.appendChild(social);

    // ---- recent visitors (hidden while none — a fresh profile has no audience)
    this.viewers = el('section', 'nf-p-viewers hidden');
    const visTitle = el('div', 'nf-p-sub');
    visTitle.appendChild(el('span', '', 'RECENT VISITORS'));
    this.viewers.appendChild(visTitle);
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
      winrate: played > 0 ? `${Math.round((wins / played) * 100)}%` : '—',
      kills: `${stats?.kills ?? 0}`,
      losses: `${losses}`,
      deaths: `${stats?.deaths ?? 0}`,
      boss: `${stats?.bossKills ?? 0}`,
      beacons: `${stats?.beaconsCaptured ?? 0}`,
      nexus: `${stats?.nexusCaptures ?? 0}`,
      damage: `${Math.round(stats?.damageDealt ?? 0).toLocaleString()}`,
      taken: `${Math.round(stats?.damageTaken ?? 0).toLocaleString()}`,
      time: formatDuration(Number(stats?.playTimeSeconds ?? 0n)) || '0:00',
      p2p: `${stats?.p2pMatches ?? 0}`,
    };
    for (const cell of this.headline) setText(cell.node, values[cell.key] ?? '—');
    for (const row of this.rows) setText(row.node, values[row.key] ?? '—');
    setText(this.countEl, `${played} ${played === 1 ? 'match' : 'matches'} played`);

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
