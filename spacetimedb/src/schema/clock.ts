// NECROFALL — the SERVER CLOCK broadcast (plan §14/§46).
//
// The ranked map renders 72-hour shield countdowns. A device clock can be
// minutes off (or worse), so the client must never count down on `Date.now()`.
// The 1 Hz matchmaking scanner stamps THIS singleton row with `ctx.timestamp`;
// clients subscribe, learn the offset once and interpolate from there.
import { table, t } from 'spacetimedb/server';

export const server_clock = table(
  { name: 'server_clock', public: true },
  {
    /** Always 0 — one row for the whole database. */
    id: t.u8().primaryKey(),
    /** The server's micros-since-epoch at the last scan tick. */
    now_us: t.u64(),
  }
);
