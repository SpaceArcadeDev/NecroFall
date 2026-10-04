// NECROFALL — the friends rail (user redesign 2026-09-29).
//
// COLLAPSED by default and shown on every menu (classic, rank, P2P and lobby — the
// shell moves the bar to <body> while a game screen owns the viewport): a slim strip
// with the drawer handle at the top and one icon per friend, each wearing a green /
// dark-grey dot. Pressing ANYWHERE on the bar expands the OVERLAY sheet:
//   · top row: ADD FRIEND · FOLLOWERS · collapse
//   · friend rows: icon, name, online status, INVITE while I stand in a lobby
//   · followers view: everyone who follows me — FOLLOW BACK registers the friendship
// New followers and incoming lobby invites raise a top-left notification + chime.
//
// There is deliberately no add button on the collapsed bar any more (user ask):
// the search lives behind ADD FRIEND in the sheet.
import { COLONIES } from '../../core/Config';
import { ClientCache } from '../spacetimedb/cache';
import { subscribePlayer } from '../spacetimedb/subscriptions';
import { followPlayer } from '../spacetimedb/reducers';
import { hexOf, PRESENCE_IN_MATCH, PRESENCE_ONLINE } from '../spacetimedb/rows';
import { presenceClass, presenceLabel } from './ProfileCard';
import { button, clear, el } from './dom';
import { playFriendNotifySound } from './notifySound';
import type { ShellContext } from '../ShellContext';

/** A lobby invite stays usable for this long (mirrors the module's 10 min TTL). */
const INVITE_TTL_US = 10n * 60n * 1_000_000n;
/** A follow only rings the chime when it is genuinely NEW (the initial replay is silent). */
const FOLLOW_NOTIFY_WINDOW_US = 180_000_000;

const ICON_DRAWER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/><path d="m14 9 3 3-3 3"/></svg>';
const ICON_COLLAPSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/><path d="m17 9-3 3 3 3"/></svg>';
const ICON_ADD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="9.5" cy="8" r="3.4"/><path d="M3.5 19.5c.7-3.2 3-5 6-5s5.3 1.8 6 5"/><path d="M18 7v6"/><path d="M15 10h6"/></svg>';
const ICON_PEOPLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="8.5" cy="8.5" r="3.1"/><path d="M2.8 19.3c.6-3 2.6-4.7 5.7-4.7s5.1 1.7 5.7 4.7"/>' +
  '<circle cx="17" cy="9.6" r="2.4"/><path d="M15.6 14.4c2.7.1 4.4 1.6 4.9 4.4"/></svg>';

interface NotifyOptions {
  title: string;
  body?: string;
  /** Leading initial. */
  initial?: string;
  status?: number;
  action?: string;
  onAction?: () => void;
  sound?: boolean;
}

export class FriendRail {
  /** The COLLAPSED bar. The shell moves it between the chrome and <body> (game screens). */
  readonly element: HTMLElement;
  /** The expanded overlay sheet (always on <body>; fixed). */
  readonly overlay: HTMLElement;
  /** The top-left notification stack (always on <body>; fixed). */
  readonly notifications: HTMLElement;

  private icons: HTMLElement;
  private listHost: HTMLElement;
  private title: HTMLElement;
  private followersBtn: HTMLButtonElement;
  private open = false;
  private view: 'friends' | 'followers' = 'friends';
  private iconsSig = '';
  private listSig = '';
  /** Followers already seen — the initial subscription replay seeds this silently. */
  private knownFollowers = new Set<string>();
  private notifiedFollowers = new Set<string>();
  /** Invite row ids already surfaced (or consumed). */
  private knownInvites = new Set<number>();

  constructor(private ctx: ShellContext) {
    // ---- the collapsed bar
    this.element = el('div', 'nf-rail');
    const drawer = button('', 'nf-rail-drawer', () => this.openSheet());
    // (user ask 2026-10-03: the friends rail IS the FRIENDS entry point now that the nav bar
    // carries EVENTS/CUSTOMIZE/MAP/PLAY — the action id keeps the dev audit true.)
    drawer.dataset.action = 'friends';
    // (user ask 2026-09-29: the two drawer glyphs were swapped — the EXPAND control on the
    // collapsed bar wears the left-facing drawer mark; the sheet's control wears the right one.)
    drawer.innerHTML = ICON_COLLAPSE;
    drawer.title = 'Open friends';
    drawer.setAttribute('aria-label', 'Open friends');
    this.element.appendChild(drawer);
    this.icons = el('div', 'nf-rail-icons');
    this.element.appendChild(this.icons);
    // "…or anywhere in the collapsed friends menu bar" (user spec): every press expands.
    this.element.addEventListener('click', () => this.openSheet());

    // ---- the overlay sheet
    this.overlay = el('div', 'nf-friends-sheet hidden');
    const card = el('div', 'nf-friends-card');
    const head = el('div', 'nf-sheet-head');

    const addBtn = button('', 'nf-sheet-btn', () => this.ctx.openPlayerSearch());
    addBtn.innerHTML = `<i>${ICON_ADD}</i><span>ADD FRIEND</span>`;
    addBtn.title = 'Search for a survivor by name or player id';
    head.appendChild(addBtn);

    this.followersBtn = button('', 'nf-sheet-btn', () => this.setView(this.view === 'followers' ? 'friends' : 'followers'));
    this.followersBtn.innerHTML = `<i>${ICON_PEOPLE}</i><span>FOLLOWERS</span>`;
    this.followersBtn.title = 'Everyone who follows you';
    head.appendChild(this.followersBtn);

    const collapse = button('', 'nf-sheet-btn nf-sheet-close', () => this.closeSheet());
    collapse.innerHTML = ICON_DRAWER;
    collapse.title = 'Collapse the friends menu';
    collapse.setAttribute('aria-label', 'Collapse the friends menu');
    head.appendChild(collapse);
    card.appendChild(head);

    this.title = el('div', 'nf-sheet-title', 'FRIENDS');
    card.appendChild(this.title);
    this.listHost = el('div', 'nf-sheet-list');
    card.appendChild(this.listHost);
    this.overlay.appendChild(card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.closeSheet();
    });

    // ---- notifications (top-left; the shell keeps this on <body>)
    this.notifications = el('div', 'nf-notify-stack');
  }

  // ------------------------------------------------------------ collapsed bar

  update(): void {
    this.renderIcons();
    if (this.open) this.renderSheet();
    this.pollNotifications();
  }

  /** One icon per friend; the dot carries presence (green online, blue in match, grey offline). */
  private renderIcons(): void {
    const cache = ClientCache.shared;
    const me = this.ctx.myHex();
    const friends = this.sorted(cache.friends(me));
    for (const hex of friends) subscribePlayer(hex);
    const sig = friends.map((hex) => `${hex}:${cache.presenceByHex(hex)?.status ?? 0}`).join(';');
    if (sig === this.iconsSig) return;
    this.iconsSig = sig;
    clear(this.icons);
    for (const hex of friends) {
      const p = cache.playerByHex(hex);
      const status = cache.presenceByHex(hex)?.status ?? 0;
      const name = p?.playerName || 'Recruit';
      const ico = el('button', 'nf-rail-ico') as HTMLButtonElement;
      ico.type = 'button';
      ico.title = `${name} · ${presenceLabel(status)}`;
      ico.setAttribute('aria-label', ico.title);
      const av = el('span', 'nf-avatar nf-avatar-sm');
      av.appendChild(el('span', 'nf-avatar-letter', name.charAt(0).toUpperCase() || '?'));
      const colony = p && p.colony >= 0 && p.colony < COLONIES.length ? COLONIES[p.colony] : null;
      av.style.setProperty('--nf-avatar-accent', colony?.css ?? '#8fd7ff');
      av.appendChild(el('span', `nf-dot ${presenceClass(status)}`));
      ico.appendChild(av);
      this.icons.appendChild(ico);
    }
  }

  // ------------------------------------------------------------ overlay sheet

  private openSheet(): void {
    if (this.open) return;
    this.open = true;
    this.view = 'friends';
    this.listSig = '';
    this.overlay.classList.remove('hidden');
    this.element.classList.add('open');
    this.renderSheet();
  }

  private closeSheet(): void {
    if (!this.open) return;
    this.open = false;
    this.overlay.classList.add('hidden');
    this.element.classList.remove('open');
  }

  /** Collapse the overlay (the shell hides the whole bar on immersive screens). */
  collapse(): void {
    this.closeSheet();
  }

  /** Open/close the friends sheet — the FRIENDS nav tab's entry (overhaul §30). */
  toggleSheet(): void {
    if (this.open) this.closeSheet();
    else this.openSheet();
  }

  private setView(view: 'friends' | 'followers'): void {
    this.view = view;
    this.listSig = '';
    this.renderSheet();
  }

  private syncHead(): void {
    const followers = this.view === 'followers';
    this.followersBtn.classList.toggle('on', followers);
    const cache = ClientCache.shared;
    const me = this.ctx.myHex();
    const count = followers
      ? cache.followers(me).filter((r) => hexOf(r.follower) !== me).length
      : cache.friends(me).length;
    this.title.textContent = followers ? `FOLLOWERS · ${count}` : `FRIENDS · ${count}`;
  }

  private renderSheet(): void {
    const cache = ClientCache.shared;
    const me = this.ctx.myHex();
    this.syncHead();
    const hexes =
      this.view === 'friends'
        ? this.sorted(cache.friends(me))
        : this.sorted(
            cache
              .followers(me)
              .map((r) => hexOf(r.follower))
              .filter((hex) => hex !== me)
          );
    for (const hex of hexes) subscribePlayer(hex);

    const party = me ? cache.myParty(me) : null;
    const members = party ? cache.partyMembers(party.partyId) : [];
    const inviteState = party ? `p${party.partyId}:${members.length}` : 'solo';
    const sig =
      `${this.view}|${inviteState}|` +
      hexes
        .map((hex) => {
          const p = cache.playerByHex(hex);
          const status = cache.presenceByHex(hex)?.status ?? 0;
          const inParty = members.some((m) => hexOf(m.identity) === hex);
          // The follow state is part of the signature — a FOLLOW BACK press must flip
          // its own row to FRIENDS ✓ without waiting for some unrelated row change.
          const edge = cache.friends(me).includes(hex) ? 2 : cache.isFollowing(me, hex) ? 1 : 0;
          return `${hex}:${p?.playerName ?? '?'}:${status}:${p?.colony ?? -1}:${inParty ? 1 : 0}:${edge}`;
        })
        .join(';');
    if (sig === this.listSig) return;
    this.listSig = sig;

    clear(this.listHost);
    if (hexes.length === 0) {
      this.listHost.appendChild(
        el(
          'p',
          'nf-muted nf-sheet-empty',
          this.view === 'followers'
            ? 'Nobody follows you yet — share your player id from your profile.'
            : 'Follow each other to become friends.'
        )
      );
      return;
    }
    for (const hex of hexes) this.listHost.appendChild(this.buildRow(hex, party !== null, members));
  }

  /** One friend / follower row: icon, name, status, and the contextual action. */
  private buildRow(hex: string, inLobby: boolean, members: { identity: { toHexString(): string } }[]): HTMLElement {
    const cache = ClientCache.shared;
    const me = this.ctx.myHex();
    const p = cache.playerByHex(hex);
    const status = cache.presenceByHex(hex)?.status ?? 0;
    const name = p?.playerName || '…';

    const row = el('div', 'nf-fr-row');
    const av = el('span', 'nf-avatar nf-avatar-sm');
    av.appendChild(el('span', 'nf-avatar-letter', name.charAt(0).toUpperCase() || '?'));
    const colony = p && p.colony >= 0 && p.colony < COLONIES.length ? COLONIES[p.colony] : null;
    av.style.setProperty('--nf-avatar-accent', colony?.css ?? '#8fd7ff');
    av.appendChild(el('span', `nf-dot ${presenceClass(status)}`));
    row.appendChild(av);

    const col = el('div', 'nf-fr-col');
    col.appendChild(el('span', 'nf-fr-name', name));
    col.appendChild(el('span', 'nf-fr-status', presenceLabel(status)));
    row.appendChild(col);

    const act = el('div', 'nf-fr-act');
    const alreadyInParty = members.some((m) => m.identity.toHexString() === hex);
    if (this.view === 'friends' && inLobby) {
      if (alreadyInParty) act.appendChild(el('span', 'nf-fr-chip', 'IN LOBBY'));
      else {
        const invite = button('INVITE', 'nf-btn small nf-fr-invite', () => {
          this.ctx.official.inviteToParty(hex);
          this.ctx.toast(`Lobby invite sent to ${name}.`);
        });
        invite.title = `Invite ${name} into your lobby`;
        act.appendChild(invite);
      }
    } else if (this.view === 'followers') {
      if (cache.friends(me).includes(hex)) act.appendChild(el('span', 'nf-fr-chip', 'FRIENDS ✓'));
      else {
        const following = cache.isFollowing(me, hex);
        const back = button(following ? 'FOLLOWING ✓' : 'FOLLOW BACK', 'nf-btn small', () => {
          if (!following) void this.followBack(hex);
        });
        back.disabled = following;
        act.appendChild(back);
      }
    }
    row.appendChild(act);

    // The row opens the profile; the action buttons keep their own clicks.
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.closeSheet();
      this.ctx.openProfile(hex);
    });
    return row;
  }

  /** FOLLOW through the row's own Identity object (the cache owns it). */
  private async followBack(hex: string): Promise<void> {
    const target = ClientCache.shared.playerByHex(hex)?.identity;
    if (!target) return;
    followPlayer(target);
  }

  /** Presence first (in match → online → offline), then by name. */
  private sorted(hexes: string[]): string[] {
    const cache = ClientCache.shared;
    const rank = (hex: string): number => {
      const status = cache.presenceByHex(hex)?.status ?? 0;
      return status === PRESENCE_IN_MATCH ? 0 : status === PRESENCE_ONLINE ? 1 : 2;
    };
    return [...hexes].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (cache.playerByHex(a)?.playerName ?? '').localeCompare(cache.playerByHex(b)?.playerName ?? '')
    );
  }

  // ------------------------------------------------------------ notifications

  /**
   * New followers + lobby invites. Timing is read from the ROWS' own timestamps, so the
   * subscriptions' initial replay (old rows) seeds the known-sets silently while a live
   * follow/invite rings — even if it arrives during the first data settle.
   */
  private pollNotifications(): void {
    const me = this.ctx.myHex();
    if (!me) return;
    const cache = ClientCache.shared;
    const nowUs = cache.serverNowUs();

    for (const row of cache.followers(me)) {
      const hex = hexOf(row.follower);
      if (!hex || hex === me || this.knownFollowers.has(hex)) continue;
      const ageUs = nowUs - Number(row.createdAt.microsSinceUnixEpoch);
      // Old rows (the subscription replay) seed silently — and a fresh follow waits a beat
      // for its player row so the notification carries the real name, not a placeholder.
      if (ageUs > FOLLOW_NOTIFY_WINDOW_US || this.notifiedFollowers.has(hex)) {
        this.knownFollowers.add(hex);
        continue;
      }
      subscribePlayer(hex); // pull the follower's row BEFORE waiting on it
      const player = cache.playerByHex(hex);
      if (!player) continue; // try again on the next data settle
      this.knownFollowers.add(hex);
      this.notifiedFollowers.add(hex);
      const name = player.playerName || 'A survivor';
      this.pushNotification({
        title: `${name} followed you`,
        body: 'Follow back to become friends.',
        initial: name.charAt(0).toUpperCase() || '?',
        status: cache.presenceByHex(hex)?.status ?? 0,
        action: 'FOLLOW BACK',
        onAction: () => void this.followBack(hex),
        sound: true,
      });
    }

    const party = cache.myParty(me);
    for (const invite of cache.partyInvites(me)) {
      if (this.knownInvites.has(invite.id)) continue;
      // Already standing in THAT lobby (the inviter is a lobby-mate): consume it silently.
      if (party && party.partyId === invite.partyId) {
        this.knownInvites.add(invite.id);
        this.ctx.official.declineInvite(invite.id);
        continue;
      }
      const ageUs = nowUs - Number(invite.createdAt.microsSinceUnixEpoch);
      if (ageUs > Number(INVITE_TTL_US)) {
        this.knownInvites.add(invite.id);
        this.ctx.official.declineInvite(invite.id); // stale — never resurrect it
        continue;
      }
      const fromHex = hexOf(invite.fromIdentity);
      subscribePlayer(fromHex); // pull the inviter's row BEFORE waiting on it
      const player = cache.playerByHex(fromHex);
      if (!player) continue; // wait for the inviter's row (name in the notification)
      this.knownInvites.add(invite.id);
      const name = player.playerName || 'A survivor';
      this.pushNotification({
        title: `${name} invited you to their lobby`,
        body: 'Join to stand in the same line-up.',
        initial: name.charAt(0).toUpperCase() || '?',
        status: cache.presenceByHex(fromHex)?.status ?? 0,
        action: 'JOIN',
        onAction: () => {
          this.ctx.official.declineInvite(invite.id);
          // The ROOM adopts the lobby's own format from the server row (user report
          // 2026-10-04) — never assume CLASSIC here: the invite may be a RANK lobby.
          this.ctx.joinLobbyByCode(invite.code);
        },
        sound: true,
      });
    }
  }

  private pushNotification(o: NotifyOptions): void {
    const node = el('div', 'nf-notify');
    const av = el('span', 'nf-avatar nf-avatar-sm');
    av.appendChild(el('span', 'nf-avatar-letter', o.initial ?? '?'));
    av.appendChild(el('span', `nf-dot ${presenceClass(o.status ?? 0)}`));
    node.appendChild(av);
    const col = el('div', 'nf-notify-col');
    col.appendChild(el('b', 'nf-notify-title', o.title));
    if (o.body) col.appendChild(el('span', 'nf-notify-body', o.body));
    node.appendChild(col);
    if (o.action && o.onAction) {
      node.appendChild(
        button(o.action, 'nf-btn small', () => {
          o.onAction?.();
          node.remove();
        })
      );
    }
    node.appendChild(
      button('✕', 'nf-notify-x', () => {
        node.remove();
      })
    );
    this.notifications.appendChild(node);
    // Keep the stack short: the oldest card yields.
    while (this.notifications.children.length > 4) this.notifications.firstElementChild?.remove();
    if (o.sound) playFriendNotifySound();
    window.setTimeout(() => {
      node.classList.add('out');
      window.setTimeout(() => node.remove(), 450);
    }, 7000);
  }
}
