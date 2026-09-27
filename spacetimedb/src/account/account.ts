// NECROFALL — account + cosmetic reducers (plan §3/§7/§63/§64/§65/§66).
//
// The client never declares ownership, money or identity: it requests, and
// these reducers validate against the tables. Currency is integer-only and
// every mutation here is a single reducer call (plan §39 cost targets).
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { admin_identity, player, player_inventory, player_loadout, player_presence, player_wallet } from '../schema/player';
import { requireAdmin, requirePlayer } from '../auth/authorization';

/** Slot ids mirror `src/app/spacetimedb/rows.ts` (LOADOUT_SLOT). */
const SLOT_AVATAR = 0;
const SLOT_PROFILE_FRAME = 1;
const SLOT_PROFILE_BANNER = 2;
const SLOT_NAMEPLATE = 3;
const SLOT_CHARACTER_SKIN = 4;
const SLOT_EMOTE = 5;
const SLOT_EFFECT = 6;
const SLOT_VICTORY_EFFECT = 7;
const SLOT_BADGE = 8;
const SLOT_TITLE = 9;
const VALID_SLOTS = [
  SLOT_AVATAR, SLOT_PROFILE_FRAME, SLOT_PROFILE_BANNER, SLOT_NAMEPLATE, SLOT_CHARACTER_SKIN,
  SLOT_EMOTE, SLOT_EFFECT, SLOT_VICTORY_EFFECT, SLOT_BADGE, SLOT_TITLE,
];

/** `item_id === 0` in a loadout slot means "nothing equipped". */
const ITEM_NONE = 0;

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 3–16 chars, letters/digits/_- and single spaces (plan §64). */
function validatePlayerName(raw: string): string {
  const name = raw.trim();
  if (name.length < 3 || name.length > 16) throw new SenderError('Name must be 3–16 characters.');
  if (!/^[A-Za-z0-9_\- ]+$/.test(name)) throw new SenderError('Name may only use letters, digits, "_", "-" and spaces.');
  if (/\s{2,}/.test(name)) throw new SenderError('Name may not contain double spaces.');
  return name;
}

/**
 * The colony pick (plan §3). Required before official play; may be re-aligned
 * later from the profile at any time — matchmaking reads the CURRENT value.
 */
export const choose_colony = spacetimedb.reducer({ colony: t.u8() }, (ctx, { colony }) => {
  if (colony > 2) throw new SenderError('Unknown colony.');
  const p = requirePlayer(ctx);
  if (p.colony === colony) return; // idempotent — re-picking the same colony is a no-op
  ctx.db.player.identity.update({ ...p, colony });
});

/**
 * ONBOARDING STEP 2 — the display name (plan §64). Uniqueness is enforced by
 * the `normalized_name` unique index; casing is preserved for display.
 */
export const set_player_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = requirePlayer(ctx);
  const display = validatePlayerName(name);
  const normalized = normalizeName(display);
  const taken = ctx.db.player.normalized_name.find(normalized);
  if (taken && taken.identity.toHexString() !== ctx.sender.toHexString()) {
    throw new SenderError('That name is already taken.');
  }
  ctx.db.player.identity.update({
    ...p,
    player_name: display,
    normalized_name: normalized,
    profile_name: p.profile_name || display,
  });
});

/** The @handle shown on the profile. Display-only; no uniqueness requirement. */
export const set_profile_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = requirePlayer(ctx);
  const display = name.trim();
  if (display.length < 3 || display.length > 20) throw new SenderError('Profile name must be 3–20 characters.');
  ctx.db.player.identity.update({ ...p, profile_name: display });
});

/** Predefined profile pictures only in v1 — no image uploads (plan §65). */
export const set_profile_picture = spacetimedb.reducer({ picture: t.u32() }, (ctx, { picture }) => {
  const p = requirePlayer(ctx);
  if (picture > 63) throw new SenderError('Unknown profile picture.');
  ctx.db.player.identity.update({ ...p, profile_picture: picture });
});

/**
 * Save the caller's control remap (plan §37): a JSON blob of action → key code.
 * Validated loosely — size + JSON shape — so a malformed client cannot grow
 * the row without bound; the client re-reads the authoritative row afterwards.
 */
export const set_keybinds = spacetimedb.reducer({ binds: t.string() }, (ctx, { binds }) => {
  const p = requirePlayer(ctx);
  const trimmed = binds.trim();
  if (trimmed.length > 1024) throw new SenderError('Keybind payload too large.');
  if (trimmed) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new SenderError('Keybind payload is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SenderError('Keybind payload must be an object.');
    }
  }
  const row = ctx.db.player_settings.identity.find(p.identity);
  if (row) ctx.db.player_settings.identity.update({ ...row, keybinds: trimmed });
  else ctx.db.player_settings.insert({ identity: p.identity, keybinds: trimmed });
});

/** The 3D avatar id — the client maps it to a local model (plan §66). */
export const set_avatar = spacetimedb.reducer({ avatar: t.u32() }, (ctx, { avatar }) => {
  const p = requirePlayer(ctx);
  if (avatar > 63) throw new SenderError('Unknown avatar.');
  ctx.db.player.identity.update({ ...p, avatar_id: avatar });
});

/**
 * EQUIP — the client asks, the SERVER checks ownership (plan §7). `item 0`
 * means "clear the slot". One reducer call, one transaction (plan §39).
 */
export const equip_item = spacetimedb.reducer({ slot: t.u32(), item_id: t.u32() }, (ctx, { slot, item_id }) => {
  requirePlayer(ctx);
  if (!VALID_SLOTS.includes(slot)) throw new SenderError('Unknown loadout slot.');
  if (item_id !== ITEM_NONE) {
    const owned = [...ctx.db.player_inventory.identity.filter(ctx.sender)]
      .some(row => row.item_id === item_id && row.quantity > 0);
    if (!owned) throw new SenderError('You do not own that item.');
  }
  const existing = [...ctx.db.player_loadout.identity.filter(ctx.sender)].find(row => row.slot === slot);
  if (existing) {
    ctx.db.player_loadout.id.update({ ...existing, item_id });
  } else {
    ctx.db.player_loadout.insert({ id: 0, identity: ctx.sender, slot, item_id });
  }
});

/**
 * P2P result reporting (plan §34/§75). P2P is host-authoritative and therefore
 * UNTRUSTED: this only bumps separate community counters — never official
 * wins, currency, or match history. Sanity bounds make spam useless.
 */
export const submit_peer_result = spacetimedb.reducer(
  { won: t.bool(), kills: t.u32(), deaths: t.u32(), duration_seconds: t.u32() },
  (ctx, { won, kills, deaths, duration_seconds }) => {
    requirePlayer(ctx);
    if (duration_seconds < 30 || duration_seconds > 7200) return; // discarded as implausible
    const stats = ctx.db.player_stats.identity.find(ctx.sender);
    if (!stats) return;
    ctx.db.player_stats.identity.update({
      ...stats,
      p2p_matches: stats.p2p_matches + 1,
      p2p_wins: stats.p2p_wins + (won ? 1 : 0),
    });
    void kills; void deaths; // kept in the signature for future aggregate tracking
  }
);

// ------------------------------------------------------------ admin (plan §42)

/**
 * Bootstrap the FIRST admin. Only succeeds while no admin exists (checked
 * against the private table). After bootstrap this always throws — seed
 * production admins with `spacetime sql` instead.
 */
export const claim_admin = spacetimedb.reducer((ctx) => {
  for (const _ of ctx.db.admin_identity.iter()) throw new SenderError('An admin already exists.');
  ctx.db.admin_identity.insert({ identity: ctx.sender });
});

/** Admin: grant (or claw back) currency. Integer units only. */
export const grant_currency_admin = spacetimedb.reducer(
  { target: t.identity(), soft: t.i64(), premium: t.i64() },
  (ctx, { target, soft, premium }) => {
    requireAdmin(ctx);
    const wallet = ctx.db.player_wallet.identity.find(target);
    if (!wallet) throw new SenderError('No wallet for that player.');
    const nextSoft = wallet.soft_currency + BigInt(soft);
    const nextPremium = wallet.premium_currency + BigInt(premium);
    ctx.db.player_wallet.identity.update({
      ...wallet,
      soft_currency: nextSoft < 0n ? 0n : nextSoft,
      premium_currency: nextPremium < 0n ? 0n : nextPremium,
    });
  }
);

/** Admin: grant (or remove) an inventory item. */
export const grant_item_admin = spacetimedb.reducer(
  { target: t.identity(), item_id: t.u32(), quantity: t.i32() },
  (ctx, { target, item_id, quantity }) => {
    requireAdmin(ctx);
    const rows = [...ctx.db.player_inventory.identity.filter(target)];
    const existing = rows.find(row => row.item_id === item_id);
    if (existing) {
      const next = existing.quantity + quantity;
      if (next <= 0) ctx.db.player_inventory.id.delete(existing.id);
      else ctx.db.player_inventory.id.update({ ...existing, quantity: next });
    } else if (quantity > 0) {
      ctx.db.player_inventory.insert({
        id: 0,
        identity: target,
        item_id,
        quantity,
        acquired_at: ctx.timestamp,
      });
    }
  }
);

/** Admin: ban/unban. Banned accounts are rejected by `requirePlayer`. */
export const set_ban_admin = spacetimedb.reducer({ target: t.identity(), banned: t.bool() }, (ctx, { target, banned }) => {
  requireAdmin(ctx);
  const p = ctx.db.player.identity.find(target);
  if (!p) throw new SenderError('No such player.');
  ctx.db.player.identity.update({ ...p, banned });
});

void player_presence; // presence is lifecycle-owned (auth/connect.ts); listed for schema completeness

