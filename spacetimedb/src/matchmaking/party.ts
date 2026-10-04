// NECROFALL — parties (plan §72).
//
// Max 3 players for OFFICIAL play. A party queues as one atomic group: the
// matchmaker never splits it, and the group only joins a candidate when every
// member fits under the colony caps. (P2P lobbies keep their own rules and do
// not use this table.)
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { party, party_member } from '../schema/matchmaking';
import { requirePlayer } from '../auth/authorization';

export const MAX_PARTY = 3;

/** Invite-code alphabet: uppercase, minus the lookalikes (I/O/0/1/B/8). */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';

/** Mint a short unique party invite code (same shape as player friend codes). */
function allocatePartyCode(ctx: any): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(ctx.random() * CODE_ALPHABET.length)];
    }
    let taken = false;
    for (const row of ctx.db.party.iter()) {
      if (row.join_code === code) {
        taken = true;
        break;
      }
    }
    if (!taken) return code;
  }
  return ctx.sender.toHexString().replace(/^0x/, '').slice(-6).toUpperCase();
}

function myMembership(ctx: any): any | undefined {
  return ctx.db.party_member.identity.find(ctx.sender);
}

/** One join path shared by direct ids and invite codes. */
function joinTarget(ctx: any, target: any, acc: string): void {
  if (target.state !== 0) throw new SenderError('That party is in a match.');
  const members = [...ctx.db.party_member.party_id.filter(target.party_id)];
  if (members.length >= MAX_PARTY) throw new SenderError(`Parties hold at most ${MAX_PARTY} players.`);
  ctx.db.party_member.insert({
    id: 0,
    party_id: target.party_id,
    identity: ctx.sender,
    joined_at: ctx.timestamp,
    acc: clampAcc(acc),
    connected: true,
    disconnected_at: undefined,
  });
  // The joiner is in — every pending invite addressed to them is consumed.
  clearInvitesForTarget(ctx, ctx.sender);
}

/** How long a lobby invite stays live without an answer (swept by the 1 Hz scan). */
export const PARTY_INVITE_TTL_US = 10n * 60n * 1_000_000n;

/**
 * How long a DISCONNECTED member keeps their lobby seat (user report 2026-10-03: sharing an
 * invite on mobile — i.e. switching apps — killed the socket and instantly removed the player
 * from their own lobby). Transient drops keep the seat; the 1 Hz sweep reclaims it only when
 * the connection never comes back.
 */
export const PARTY_DISCONNECT_GRACE_US = 2n * 60n * 1_000_000n;

/** The invitee joined (or declined): drop their invite rows. */
export function clearInvitesForTarget(ctx: any, identity: any): void {
  const hex = identity.toHexString();
  for (const row of [...ctx.db.party_invite.to_identity.filter(identity)]) {
    if (row.to_identity.toHexString() === hex) ctx.db.party_invite.id.delete(row.id);
  }
}

/** The party is gone (or its code changed): its invites are dead too. */
export function clearInvitesForParty(ctx: any, partyId: number): void {
  for (const row of [...ctx.db.party_invite.party_id.filter(partyId)]) {
    if (row.party_id === partyId) ctx.db.party_invite.id.delete(row.id);
  }
}

/** 1 Hz sweep: unanswered invites expire after PARTY_INVITE_TTL_US. */
export function sweepPartyInvites(ctx: any, now: bigint): void {
  for (const row of [...ctx.db.party_invite.iter()]) {
    const age = now - row.created_at.microsSinceUnixEpoch;
    if (age > PARTY_INVITE_TTL_US) ctx.db.party_invite.id.delete(row.id);
  }
}

/**
 * 1 Hz sweep: a member whose connection dropped for the WHOLE grace loses their seat (the
 * shared removal hands leadership over / dissolves an emptied party). Runs alongside the
 * invite sweep in the matchmaking scan.
 */
export function sweepPartyMembers(ctx: any, now: bigint): void {
  for (const member of [...ctx.db.party_member.iter()]) {
    if (member.connected !== false) continue;
    const since = member.disconnected_at
      ? (member.disconnected_at.microsSinceUnixEpoch as bigint)
      : now;
    if (now - since > PARTY_DISCONNECT_GRACE_US) removeFromParty(ctx, member);
  }
}

/**
 * INVITE (friends rail): any member of an open party may invite a player who is not
 * already in one. One live invite per (party, target) — resending refreshes it.
 */
export const invite_to_party = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  requirePlayer(ctx);
  const member = myMembership(ctx);
  if (!member) throw new SenderError('You are not in a lobby.');
  const partyRow = ctx.db.party.party_id.find(member.party_id);
  if (!partyRow || partyRow.state !== 0) throw new SenderError('Your lobby is not open.');
  if (target.toHexString() === ctx.sender.toHexString()) throw new SenderError('You are already in this lobby.');
  const them = ctx.db.player.identity.find(target);
  if (!them) throw new SenderError('No such player.');
  if (ctx.db.party_member.identity.find(target)) throw new SenderError('That survivor is already in a lobby.');
  for (const row of [...ctx.db.party_invite.party_id.filter(member.party_id)]) {
    if (row.to_identity.toHexString() === target.toHexString()) ctx.db.party_invite.id.delete(row.id);
  }
  ctx.db.party_invite.insert({
    id: 0,
    party_id: member.party_id,
    from_identity: ctx.sender,
    to_identity: target,
    code: partyRow.join_code,
    created_at: ctx.timestamp,
  });
});

/** The invitee dismissed the notification (or already joined elsewhere). */
export const decline_invite = spacetimedb.reducer({ id: t.u32() }, (ctx, { id }) => {
  const row = ctx.db.party_invite.id.find(id);
  if (!row) return;
  if (row.to_identity.toHexString() !== ctx.sender.toHexString()) return;
  ctx.db.party_invite.id.delete(row.id);
});

/** The outfit wire is tiny ("hat,backpack,pet") — cap it so a client cannot stuff the row. */
function clampAcc(acc: string): string {
  return acc.slice(0, 96);
}

export const create_party = spacetimedb.reducer({ acc: t.string() }, (ctx, { acc }) => {
  requirePlayer(ctx);
  if (myMembership(ctx)) throw new SenderError('You are already in a party.');
  const p = ctx.db.party.insert({
    party_id: 0,
    leader: ctx.sender,
    state: 0,
    created_at: ctx.timestamp,
    join_code: allocatePartyCode(ctx),
    // Tagged by the LEADER's client right after create (set_party_format): a lobby opened
    // from the RANK menu becomes RANK for every member; CLASSIC is the safe default.
    format: 'CLASSIC',
  });
  ctx.db.party_member.insert({
    id: 0,
    party_id: p.party_id,
    identity: ctx.sender,
    joined_at: ctx.timestamp,
    acc: clampAcc(acc),
    connected: true,
    disconnected_at: undefined,
  });
});

/**
 * SET LOBBY FORMAT (user report 2026-10-04): the room's MODE is a property of the LOBBY, not
 * of each client — persisted here so joiners (invite code, invite link, reload) render the
 * same lobby the creator opened. Leader-only; clamps to the two official formats.
 */
export const set_party_format = spacetimedb.reducer({ format: t.string() }, (ctx, { format }) => {
  const member = myMembership(ctx);
  if (!member) throw new SenderError('You are not in a lobby.');
  const partyRow = ctx.db.party.party_id.find(member.party_id);
  if (!partyRow) throw new SenderError('That lobby no longer exists.');
  if (partyRow.leader.toHexString() !== ctx.sender.toHexString()) {
    throw new SenderError('Only the leader can change the lobby mode.');
  }
  const next = format.trim().toUpperCase() === 'RANK' ? 'RANK' : 'CLASSIC';
  if (partyRow.format === next) return;
  ctx.db.party.party_id.update({ ...partyRow, format: next });
});

export const join_party = spacetimedb.reducer({ party_id: t.u32(), acc: t.string() }, (ctx, { party_id, acc }) => {
  requirePlayer(ctx);
  if (myMembership(ctx)) throw new SenderError('Leave your current party first.');
  const target = ctx.db.party.party_id.find(party_id);
  if (!target) throw new SenderError('That party no longer exists.');
  joinTarget(ctx, target, acc);
});

/** Invite-code join — the same flow as the P2P lobby's JOIN, for parties. */
export const join_party_by_code = spacetimedb.reducer({ code: t.string(), acc: t.string() }, (ctx, { code, acc }) => {
  requirePlayer(ctx);
  if (myMembership(ctx)) throw new SenderError('Leave your current party first.');
  const needle = code.trim().toUpperCase();
  if (needle.length < 4) throw new SenderError('Enter a valid party code.');
  let target: any | undefined;
  for (const row of ctx.db.party.iter()) {
    if (row.join_code && row.join_code === needle) {
      target = row;
      break;
    }
  }
  if (!target) throw new SenderError('No party with that code.');
  joinTarget(ctx, target, acc);
});

/** Keep the member's outfit current while they stand in the party (lobby-style avatars). */
export const set_party_loadout = spacetimedb.reducer({ acc: t.string() }, (ctx, { acc }) => {
  const member = myMembership(ctx);
  if (!member) return;
  ctx.db.party_member.id.update({ ...member, acc: clampAcc(acc) });
});

export const leave_party = spacetimedb.reducer((ctx) => {
  const member = myMembership(ctx);
  if (!member) return;
  removeFromParty(ctx, member);
});

/** Leader-only removal. */
export const kick_from_party = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const leaderMembership = myMembership(ctx);
  if (!leaderMembership) throw new SenderError('You are not in a party.');
  const partyRow = ctx.db.party.party_id.find(leaderMembership.party_id);
  if (!partyRow || partyRow.leader.toHexString() !== ctx.sender.toHexString()) throw new SenderError('Only the leader can remove members.');
  const victim = ctx.db.party_member.identity.find(target);
  if (!victim || victim.party_id !== leaderMembership.party_id) return;
  removeFromParty(ctx, victim);
});

/**
 * Shared removal: keeps the leader seat filled. Also exported for the
 * disconnect lifecycle so a dropped leader never orphans a party (plan §73).
 */
export function removeFromParty(ctx: any, member: any): void {
  const partyId = member.party_id;
  ctx.db.party_member.identity.delete(member.identity);
  const remaining = [...ctx.db.party_member.party_id.filter(partyId)];
  if (remaining.length === 0) {
    ctx.db.party.party_id.delete(partyId);
    // The lobby is gone — its standing invites die with it.
    clearInvitesForParty(ctx, partyId);
    return;
  }
  const partyRow = ctx.db.party.party_id.find(partyId);
  if (partyRow && partyRow.leader.toHexString() === member.identity.toHexString()) {
    remaining.sort((a, b) => Number(a.joined_at.microsSinceUnixEpoch - b.joined_at.microsSinceUnixEpoch));
    ctx.db.party.party_id.update({ ...partyRow, leader: remaining[0].identity });
  }
}
