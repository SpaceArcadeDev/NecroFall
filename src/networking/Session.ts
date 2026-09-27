// NECROFALL — room sessions.
//
// A room is identified by its code, and the code lives in the URL (`?lobby=CODE`), so opening or
// refreshing the link is all it takes to get back in. Two things are kept locally to make that
// work:
//
//   • IDENTITY — `myId` is the *player* id the room keys everything by. It is minted once per tab
//     (`sessionStorage`, so a reload keeps it, while a second tab in the same browser gets its
//     own) and remembered per room for the browser as a whole (`localStorage`), so a tab that was
//     closed and reopened on the same link takes the same seat — as long as no other live tab in
//     this browser already holds it (a BroadcastChannel handshake answers that question).
//
//   • RUN — the player's own progress (colony, Necrotech loadout, level, perks, stats) written
//     every few seconds while playing. A reload hands it back to the host, which re-admits the
//     player exactly as they were instead of rolling a new kit.
//
// Nothing here is authoritative: the host still validates every claim (match seed, colony
// capacity, Necrotech index). A save only counts inside the match it was written in.
import type { NecrotechDef } from '../necrotech/NecrotechData';

/** One absorbed Necrotech in a saved run: which class it was, and whether it was a super mutation. */
export interface MutationSource {
  idx: number;
  superMut: number;
}

/** Everything needed to put a player back exactly where they were. */
export interface SavedRun {
  /** Save format version — a mismatch is simply ignored. */
  v: number;
  code: string;
  pid: string;
  name: string;
  /** When it was written (ms). Old runs are dropped. */
  at: number;
  /** Match seed: a run only applies to the match it was played in. */
  seed: number;
  colony: number;
  /** Full serialised loadout — handles mutations, which have no index in the class table. */
  nt: NecrotechDef | null;
  /**
   * Index of the STARTING class, so a mutated loadout can be rebuilt from base + stack
   * (refolding exactly once). Absent on runs written before this existed.
   */
  ntBase?: number;
  mutated: number;
  /**
   * The absorbed Necrotech stack (class indices + which were super mutations), so the 3-slot cap
   * still applies after a refresh. Optional: runs written before this existed simply have none.
   */
  muts?: MutationSource[];
  level: number;
  xp: number;
  xpNeed: number;
  /** Perk ids (see Perks.ts) — perks live on the client only, so they travel by name. */
  perks: string[];
  pendingLevels: number;
  kills: number;
  bossKills: number;
  megaKills: number;
  deaths: number;
  damageDealt: number;
  hp: number;
}

const ID_KEY = 'nf.pid';const ROOM_KEY = 'nf.room.'; // + CODE        → last identity used in that room by this browser
const RUN_KEY = 'nf.run.'; //   + CODE.PID    → the saved run of that seat
const HOST_KEY = 'nf.host.'; // + CODE        → identity that last hosted that room here
/** + CODE → how many players the room last held (written by its host), so a reload knows if it was alone. */
const SIZE_KEY = 'nf.size.';
/**
 * Save-format version. Bumped when the shape of a run changes: a mismatched run is ignored, which
 * is what retires v1 saves whose `nt` was the FUSED def (restoring them re-folded the loadout).
 */
const SAVE_VERSION = 2;
/** How long a closed-tab run stays resumable. */
const SAVE_TTL = 12 * 60 * 60 * 1000;
const MAX_SAVES = 12;
/** URL query parameter that carries the room code. */
const ROOM_QUERY = 'lobby';
const CODE_RE = /^[A-Z0-9]{4,6}$/;
/** How long another tab gets to answer "I am in that room" before we take a seat of our own. */
const HANDSHAKE_MS = 180;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function readText(store: Storage | null, key: string): string {
  try {
    return store ? store.getItem(key) ?? '' : '';
  } catch {
    return '';
  }
}

function writeText(store: Storage | null, key: string, value: string): void {
  try {
    if (!store) return;
    if (value) store.setItem(key, value);
    else store.removeItem(key);
  } catch {
    /* private mode / quota — sessions simply do not persist */
  }
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** A fresh, stable-looking player id. The `pl-` prefix never collides with a peer id (`nf-…`). */
function mintId(): string {
  let s = 'pl-';
  for (let i = 0; i < 8; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

export function normaliseCode(raw: string | null | undefined): string {
  const code = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(code) ? code : '';
}

export class SessionStore {
  private channel: BroadcastChannel | null = null;
  /** The room this tab is currently sitting in, so other tabs can be told it is taken. */
  private ownedCode = '';
  /** The player id this tab currently plays as (echoes the last `own` call). */
  private ownedPid = '';

  /** Room code carried by the current URL (`?lobby=CODE`, `?room=CODE` or `#CODE`). */
  roomCodeFromUrl(): string {
    try {
      const url = new URL(window.location.href);
      const query = url.searchParams.get(ROOM_QUERY) ?? url.searchParams.get('room');
      const rawHash = decodeURIComponent(url.hash.replace(/^#/, ''));
      // `#/play`, `#/home`, ... are the ACCOUNT SHELL's routes — never room codes.
      const hash = rawHash.startsWith('/') ? '' : rawHash.replace(/^(lobby|room)=/i, '');
      return normaliseCode(query || hash);
    } catch {
      return '';
    }
  }

  /** Publishes the room in the URL, so a refresh (or a copied address) rejoins it. */
  setRoomInUrl(code: string): void {
    const room = normaliseCode(code);
    if (!room) return;
    try {
      const url = new URL(window.location.href);
      if ((url.searchParams.get(ROOM_QUERY) ?? '') === room && !url.hash) return;
      url.searchParams.set(ROOM_QUERY, room);
      if (normaliseCode(url.hash.replace(/^#/, ''))) url.hash = '';
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* history is unavailable (file://, sandboxed frame) — the session still works in-memory */
    }
  }

  /** Drops the room from the URL: leaving the room means the link is no longer a seat in it. */
  clearRoomFromUrl(): void {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(ROOM_QUERY) && !normaliseCode(url.hash.replace(/^#/, ''))) return;
      url.searchParams.delete(ROOM_QUERY);
      if (normaliseCode(url.hash.replace(/^#/, ''))) url.hash = '';
      const tail = `${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, '', `${url.pathname}${tail}`);
    } catch {
      /* ignore */
    }
  }

  /**
   * The player id this tab plays as in `code`. A reload keeps the tab's id; a brand new tab takes
   * over the id this browser last used in that room *unless* another live tab still holds it.
   */
  async identityFor(code: string): Promise<string> {
    // Embedded frames share one sessionStorage (it is scoped to the tab, not the frame), which
    // would make a two-frame test harness look like a single player joining twice.
    const framed = this.frameIdentity();
    if (framed) return framed;
    const tab = readText(storage('session'), ID_KEY);
    if (tab) return tab;
    const room = normaliseCode(code);
    if (room) {
      const remembered = readText(storage('local'), ROOM_KEY + room);
      if (remembered && !(await this.claimedElsewhere(room, remembered))) {
        writeText(storage('session'), ID_KEY, remembered);
        return remembered;
      }
    }
    const fresh = mintId();
    writeText(storage('session'), ID_KEY, fresh);
    return fresh;
  }

  /**
   * A frame keeps its identity in `window.name`: it is per frame (siblings do not share it) and
   * survives a reload. Only ever taken over when it is empty, so a foreign use is left alone.
   */
  private frameIdentity(): string {
    let framed = false;
    try {
      framed = window.self !== window.top;
    } catch {
      framed = true; // cross-origin parent: definitely framed, just not inspectable
    }
    if (!framed) return '';
    let held = '';
    try {
      held = window.name || '';
    } catch {
      return '';
    }
    if (/^pl-[a-z0-9]{8}$/.test(held)) return held;
    if (held) return '';
    const fresh = mintId();
    try {
      window.name = fresh;
    } catch {
      /* ignore */
    }
    return fresh;
  }

  /** Announces that this tab plays `code` as `pid`, and answers other tabs asking the same. */
  own(code: string, pid: string): void {
    const room = normaliseCode(code);
    if (!room || !pid) return;
    this.ownedCode = room;
    this.ownedPid = pid;
    // The seat is only *claimed* when it is free or already ours: a second tab of this browser
    // plays its own survivor and must not overwrite the seat the first one is still sitting in.
    const held = readText(storage('local'), ROOM_KEY + room);
    if (!held || held === pid) writeText(storage('local'), ROOM_KEY + room, pid);
    // Listening starts here, not only when a tab happens to ask somebody else: a tab that holds a
    // seat must be able to answer the next tab that asks for it.
    this.bus()?.postMessage({ t: 'mine', code: room, pid });
  }

  /** Gives the seat up (leaving the room) so another tab may take it. */
  disown(code: string, pid?: string): void {
    const room = normaliseCode(code);
    if (!room) return;
    const held = readText(storage('local'), ROOM_KEY + room);
    if (!pid || held === pid) writeText(storage('local'), ROOM_KEY + room, '');
    if (this.ownedCode === room) {
      this.ownedCode = '';
      this.ownedPid = '';
    }
  }

  /** Remembers that this browser hosted `code` — a host that reloads can reopen its own room. */
  noteHost(code: string, pid: string): void {
    const room = normaliseCode(code);
    if (!room || !pid) return;
    writeText(storage('local'), HOST_KEY + room, pid);
  }

  /**
   * How many players the room last held, as seen by its host. A host that reloads uses this to
   * tell a room that can elect a successor (wait for it to come back) from one it was alone in
   * (nobody can take the code, so reopening it is the only way in).
   */
  noteRoomSize(code: string, count: number): void {
    const room = normaliseCode(code);
    if (!room) return;
    writeText(storage('local'), SIZE_KEY + room, String(Math.max(0, Math.round(count))));
  }

  roomSize(code: string): number {
    const n = Number(readText(storage('local'), SIZE_KEY + normaliseCode(code)));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  wasHost(code: string, pid?: string): boolean {
    const room = normaliseCode(code);
    if (!room) return false;
    const held = readText(storage('local'), HOST_KEY + room);
    return !!held && (!pid || held === pid);
  }

  /** Stores the run and hands back the exact record that was written (version + timestamp added). */
  saveRun(run: Omit<SavedRun, 'v' | 'at'>): SavedRun {
    const out: SavedRun = { ...run, v: SAVE_VERSION, at: Date.now() };
    writeText(storage('local'), `${RUN_KEY}${out.code}.${out.pid}`, JSON.stringify(out));
    this.pruneRuns();
    return out;
  }

  loadRun(code: string, pid: string): SavedRun | null {
    const raw = readText(storage('local'), `${RUN_KEY}${code}.${pid}`);
    if (!raw) return null;
    try {
      const run = JSON.parse(raw) as SavedRun;
      if (!run || run.v !== SAVE_VERSION || run.code !== code || run.pid !== pid) return null;
      if (Date.now() - (run.at || 0) > SAVE_TTL) {
        writeText(storage('local'), `${RUN_KEY}${code}.${pid}`, '');
        return null;
      }
      return run;
    } catch {
      return null;
    }
  }

  /** Keeps the last few runs around and forgets the rest — saves are small but not free. */
  private pruneRuns(): void {
    const store = storage('local');
    if (!store) return;
    const found: { key: string; at: number }[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key || !key.startsWith(RUN_KEY)) continue;
        let at = 0;
        try {
          at = Number((JSON.parse(store.getItem(key) ?? '{}') as { at?: number }).at) || 0;
        } catch {
          at = 0;
        }
        found.push({ key, at });
      }
    } catch {
      return;
    }
    found.sort((a, b) => b.at - a.at);
    for (let i = 0; i < found.length; i++) {
      const expired = Date.now() - found[i].at > SAVE_TTL;
      if (expired || i >= MAX_SAVES) writeText(store, found[i].key, '');
    }
  }

  /** The message bus shared by the tabs of this browser (created on first use). */
  private bus(): BroadcastChannel | null {
    if (this.channel) return this.channel;
    if (typeof BroadcastChannel !== 'function') return null;
    try {
      this.channel = new BroadcastChannel('nf-rooms');
      this.channel.addEventListener('message', (e: MessageEvent) => {
        const msg = e.data as { t?: string; code?: string } | null;
        if (msg?.t === 'who' && msg.code && msg.code === this.ownedCode && this.ownedPid) {
          this.channel?.postMessage({ t: 'mine', code: this.ownedCode, pid: this.ownedPid });
        }
      });
      return this.channel;
    } catch {
      return null;
    }
  }

  /** Asks the other tabs of this browser whether `pid` is already sitting in `code`. */
  private async claimedElsewhere(code: string, pid: string): Promise<boolean> {
    const bus = this.bus();
    if (!bus) return false;
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (claimed: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        bus.removeEventListener('message', onReply);
        resolve(claimed);
      };
      const onReply = (e: MessageEvent): void => {
        const msg = e.data as { t?: string; code?: string; pid?: string } | null;
        if (msg?.t === 'mine' && msg.code === code && msg.pid === pid) finish(true);
      };
      const timer = window.setTimeout(() => finish(false), HANDSHAKE_MS);
      bus.addEventListener('message', onReply);
      bus.postMessage({ t: 'who', code, pid });
    });
  }
}
