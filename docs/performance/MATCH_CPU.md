# Match CPU and Snapshot Backpressure

The October 2026 match investigation found substantial per-enemy CPU work in
terrain rig transforms and CPU-skinned mutation joins. A 50-enemy trace of the
actual game placed boundary skinning among the largest sampled costs. Freeroam
does not pay this crowd cost. The hybrid relay already fans out one shared row;
it did not need a new serialization format.

Changes preserve mesh topology, normals, materials, animation cadence, enemy
population, AI, collision rules, and the snapshot schema:

- Terrain rigs reuse current world matrices and a shared target-space inverse.
- Mutation joins sample each distinct boundary vertex once, cache static skin
  weights, and compute each referenced bone matrix once per join update.
- Matches with no remote recipients do not construct unused world snapshots.
  Official matches still publish when P2P signalling is offline.
- Direct P2P and hybrid links skip new full snapshots while PeerJS has queued
  data or the native channel has more than 64 KiB pending. Already-queued packets
  remain ordered. Once the queue drains, the next full snapshot reconciles the
  complete world. Reliable events and player pose messages are not dropped or
  diverted into a duplicate relay backlog.

## Verification

`npm run test:match-performance` checks old/new bone matrices and join positions
and normals, offline/direct/hybrid delivery, slow-peer isolation, reliable events,
and recovery. It also profiles 50 real enemies and replays actual game snapshots
between two browser clients over a local ordered WebRTC channel, checking enemy
state, player health, and despawns. Reports are in `.test-shots/match-performance`.

The three tested body families produced zero geometry/normal/pose differences.
Distinct boundary sampling removed 63-67% of repeated skinning evaluations;
terrain-rig hierarchy updates fell 10-25%. These are operation counts, not FPS
or thermal claims. Run `npm run test:enemy-rigs` for the broader movement,
mutation, texture, attack, and desktop/mobile visual regressions.

Dense, fully visible crowds still have significant rig and collision costs.
CPU-profiler timings include profiling overhead and are not a device budget.
Emulated mobile/browser tests do not certify physical-phone temperatures,
sustained frame rates, production relay latency, or adverse WAN conditions.