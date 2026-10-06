# NECROFALL — SpacetimeDB module (official backend + game server)

This module is the **official** NecroFall backend: account identity, profile,
social graph, cosmetics, matchmaking, the authoritative match simulation and
server-computed results. The existing WebRTC/P2P multiplayer is untouched — P2P
games never touch official progression (they can report into separate community
counters via `submit_peer_result`).

Everything the plan demands lives here:

| Plan | Where |
| --- | --- |
| Player identity = SpacetimeDB Identity | `src/auth/connect.ts` (accounts created on first connect) |
| Colony fixed per account, official only | `src/account/account.ts` (`choose_colony`), `src/matchmaking/queue.ts` |
| Profile / wallet / inventory / loadout | `src/schema/player.ts`, reducers in `src/account/account.ts` |
| Follow graph (friends = mutual follow) | `src/schema/social.ts`, `src/social/follow.ts` |
| Profile views (upsert, throttled) | `src/social/profileViews.ts` |
| Matchmaking 2–9 players, 3/colony, 5 s fill, 10 s confirm | `src/matchmaking/*` |
| Auto-requeue of confirmed players | `src/matchmaking/queue.ts` (`finalizeCandidate`) |
| Lobby MODE (CLASSIC/RANK) is a property of the party, leader-set | `src/matchmaking/party.ts` (`set_party_format`), `party.format` |
| A lobby is never split across the confirmation window | `src/matchmaking/queue.ts` (`abandonForSplitLobby`); no-shows keep dropping |
| 10 Hz authoritative simulation, one schedule per match | `src/game/simulation.ts` |
| Input-change-driven movement (NOT per frame) | `sendInput` client + `submit_input` here |
| Server results → rewards → stats → history | `src/game/rewards.ts` |
| Usage summary for cost tuning (admin only) | `match_server_usage` (private) |
| Private matchmaking tables, per-player views | `src/views.ts` |
| Admin actions behind an allow-list | `claim_admin` + `*_admin` reducers |

## Prerequisites

```bash
# 1. Install the SpacetimeDB CLI (see spacetimedb.com/docs)
spacetime --version

# 2. Install module deps
cd spacetimedb
npm install
```

## Local development

```bash
spacetime start                     # local server (leave running)
cd spacetimedb

# Build the module
spacetime build

# Publish to the LOCAL server (dev database)
spacetime publish necrofall --server local -y

# Regenerate client bindings consumed by the web client
spacetime generate --lang typescript --out-dir module_bindings --module-path .
```

The web client picks the bindings up automatically from
`spacetimedb/module_bindings/index.ts` (it loads them lazily; when the folder is
missing the client stays in offline mode).

### Reverting to older module code (breaking schema)

The client in this repo and the *published* module must always be the same
revision. When the module source is rolled back past a schema change (e.g. after
reverting the ONLINE "shared world" work), the running database still holds the
newer schema and every client fails to connect — the symptom is the login wall
with "Could not reach the game server". Republish from the reverted source:

```bash
cd spacetimedb
spacetime publish necrofall-dev --server local -y --delete-data=on-conflict
# cloud databases carry the same old name; republish each one that a client uses
spacetime publish necrofall-dev    --server maincloud -y --delete-data=on-conflict
spacetime publish necrofall-35vf3  --server maincloud -y --delete-data=on-conflict
```

`--delete-data=on-conflict` clears the database **only when the schema
conflicts**, and that clear is total: every account, party and match row in that
database is destroyed. Use it deliberately, and never as a way around a real
migration.

Then point the client at the local server in `.env.local`:

```env
VITE_SPACETIMEDB_URI=http://localhost:3000
VITE_SPACETIMEDB_DB_NAME=necrofall
```

### The relay budget — why one-shot events must never be dropped

`send_match_msg` throttles each sender to a fixed messages-per-second budget
(`MSG_MAX_PER_WINDOW`, currently 140) inside a one-second window. The cap has
TWO tiers because a silent drop costs different things per message kind:

* **State streams** (`s` snapshots, `st` poses, `pshot` shot visuals, batched
  `ehits` hit feedback) are capped at the base budget — a lost sample is
  replaced by the next one ~80 ms later, so throttling them is harmless.
* **One-shot gameplay events** (`pdmg` an enemy's hit on a player, `eev`, `edie`,
  `pst`, `kill`, `phit`/`ehit` asks, …) may use a reserve on top of the base
  budget (`MSG_EVENT_RESERVE`, currently 60) — a dropped one is gone FOREVER.
  A busy stream can therefore never starve them.

That distinction is what stops the "enemies attack but the damage doesn't sync"
class of bug: with a single shared cap, a per-frame hit-feedback stream could
push the match authority over the budget, and the messages the module dropped
were exactly the ones that cannot be recovered. Clients keep their own count and
log `[NECROFALL] relay budget: sent N messages in the last second …` when a
window approaches the limit (see `countRelaySend` in the client provider). With
`?debug` in the URL, `game.netDebug()` in the console reports the same live:
role, authority seat, per-seat transport (direct vs relay) and relay sends/second.

Changing either constant is a **logic-only** module change — no schema change,
no data loss, but the module must be republished for it to take effect:

```bash
cd spacetimedb
spacetime publish necrofall-dev --server local -y     # local dev database
spacetime publish necrofall-35vf3                     # maincloud (as used by the client)
```

## Maincloud (production)

```bash
spacetime login
cd spacetimedb
spacetime publish necrofall-prod        # or necrofall / necrofall-staging
spacetime generate --lang typescript --out-dir module_bindings --module-path .
```

Environment split (`plan §81`): `necrofall-dev`, `necrofall-staging`,
`necrofall-prod` are separate databases; use separate SpacetimeAuth clients /
redirect URIs where possible so test accounts never touch production data.

## First admin bootstrap

`claim_admin` succeeds exactly once — while no admin row exists:

```
spacetime call necrofall claim_admin
```

For production, seed the private table directly instead:

```
spacetime sql necrofall "INSERT INTO admin_identity (identity) VALUES (0x...)"
```

Admin-only reducers: `grant_currency_admin`, `grant_item_admin`,
`set_ban_admin`. `match_server_usage` is a private table — read it with
`spacetime sql` (plan §28: never exposed to normal players).

## Inspecting a live match

```
spacetime sql necrofall "SELECT match_id, status, server_tick, duration_seconds FROM match"
spacetime sql necrofall "SELECT name, colony, has_pose, x, y, z, updated_at FROM match_player"
spacetime sql necrofall "SELECT * FROM match_server_usage"
```

## Cost discipline (plan §39/§77)

* One `submit_input` per input CHANGE + a 1 Hz heartbeat while moving —
  the 10 Hz tick extrapolates between updates.
* One `sync_pose` every ~2.5 s (plus spawn/dash/teleport transitions).
* One `match_tick` schedule row per RUNNING match; it is deleted at match end.
* Idle players produce zero pose writes.
* Finished matches purge `match_input` / `match_entity` / `match_objective`
  immediately and their `match_player` / `match_event` rows 10 minutes later —
  the summary `match` row and `match_history` are permanent.
