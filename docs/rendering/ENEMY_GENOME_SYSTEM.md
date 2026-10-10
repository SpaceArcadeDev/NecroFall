# Modular Enemy Implementation Plan

## Scope

Use crawler, parasite and Behemoth as the three detailed source genomes. Preserve source
mesh detail and the game's cel-shaded materials. Runtime movement must use terrain contacts,
planted feet and joint solving, not a looping walk clip or a time-only leg oscillator.
This is an original terrain-adaptive system inspired by Rain World's movement principles,
not a claim to reproduce its proprietary implementation.

## Action Plan

- [x] Inspect the three assets, skinning, spawn pools and spherical-world collision queries.
- [x] Repair skin weights and prepare a normalized, skinned Behemoth GLB with cel materials.
- [x] Define deterministic modular anatomy, part sockets, proportions, palette and capabilities.
- [x] Assemble detailed source-mesh modules with compatible attachment and skeleton rules.
- [x] Implement grounded foot placement, stepping, joint limits and adaptive body support.
- [x] Couple attacks and telegraphs to anatomy; prohibit giant leaps and wingless flight.
- [x] Add a live model/rig lab with terrain, anatomy controls, attack preview and seed replay.
- [x] Integrate generated bodies into normal enemies, Beacon Guardians and Nexus Overseers.
- [x] Test deterministic generation, skin weights, terrain contacts, attacks and main-game combat.
- [x] Inspect desktop/mobile captures and run the production build before committing/pushing main.

## Verification Gates

All three bases must retain detailed geometry, normalized skin weights and moving joints.
Procedural animation must respond to actual displacement and sampled terrain, plant idle feet,
respect reachable steps and freeze on stun. Generated capabilities must derive from assembled
parts, including size restrictions; boss mechanics cannot bypass them. Screenshots must show
nonblank, correctly framed models without primitive stand-ins. Tests must exercise real game
spawns as well as isolated rigs. Keep user changes; do not push until required checks pass.

## Initial Findings

- The crawler has lower-leg bones but only upper-leg skin envelopes, preventing proper knee flex.
- Crawler motion is currently time-driven; the parasite plays a baked Prowl clip.
- Imported selection has two bases and always assigns the parasite to Nexus Overseers.
- The existing genome lab is text-only; it does not provide model or terrain inspection.

## Progress

The main game now uses the three imported bases for its generated roster. All three appear
in Beacon Guardian pools, and the Nexus base varies deterministically with the match seed.
`?basemodels=0` retains the legacy procedural models as an explicit comparison mode.

The Behemoth delivery asset has 26,185 vertices, 24 embedded joints, normalized weights and
1024-pixel textures, at approximately 940 KB. Its original is preserved locally under
`.asset-sources/behemoth/source.glb`; `npm run prepare:behemoth` reproduces the prepared asset.
The crawler is rigged at load time; the parasite retains its authored skeleton. Prowl is
sampled once to obtain a usable rest pose, never played as a locomotion loop.

## Supported Modules

- Three complete torso/support skeleton families: crawler, parasite and Behemoth.
- Independent torso width, head size, limb proportions, total size, chitin and accent colors.
- Textured head and tail grafts selected from the three source meshes, attached at rig sockets.
- Removable tails; removable parasite wings. Only a winged, sufficiently light parasite can fly.
- Forelimbs and weight-bearing legs stay within their torso family. Cross-family arm cuts
	exposed open boundaries in the monolithic source mesh during visual review, so those swaps
	are deliberately rejected by normalization and are not offered by the lab or generator.
	Full cross-family limb exchange needs authored, closed attachment boundaries first.

## Movement And Combat

`TerrainRig` uses Three.js CCD IK with bounded joints. Feet plant in world space, take turns
stepping when displacement exceeds stride reach, and sample the rendered ground. Idle feet
do not cycle; stun freezes motion. The existing slope-aligned body frame follows terrain;
the collision system provides walkable rock support and blocks taller obstacles. Invalid
ground contacts do not pull a leg toward an uninitialized target. Tail/head secondary motion
is procedural; no fixed walk clips are used.

Anatomy controls bite, claw, tail sweep, stomp and spit eligibility. Melee wind-ups resolve
damage later and recheck range; claw and tail strikes have directional coverage. Existing
generated traits, projectile patterns and boss telegraphs remain active. Attack pose events
are mirrored to clients. Giant bodies cannot acquire leaps through either ordinary abilities
or the boss enrage path.

## Lab And Tests

Open `/?enemyLab=1` for the live modeling lab. It shares the game loader, anatomy rules and
rig controller. It supports seed/roster selection, compatible source-part choices, proportions,
palette, terrain courses, speed, attacks, skeleton/contact inspection and JSON import/export.
Exported JSON is a reusable lab preset, not a server-side content deployment.

- `npm run test:enemy-rigs`: 1,260 seeded anatomies, nine real-model terrain courses, idle
	contact locking, stun, modular grafts and desktop/mobile screenshots.
- `npm run test:enemy-models`: real match spawns, all three Guardian bases, pursuit, damage,
	frost, death, attack delay/dodging, off-screen recovery and grounded Behemoth enrage.
- `npm run test:planet-physics`: triangle sampling, rock support, capsule contact, thin walls,
	steep slopes and existing planetary interaction regressions.
- `npm run build` and `npm run test:main-planets`: final integration gates.

Screenshots and the rig report are in the ignored `.test-shots/enemy-lab/` directory.
Emulated mobile screenshots are not physical-phone performance certification. The procedural
controller is an original terrain-contact implementation, not Rain World's engine or a claim
of equivalent full-body physics. Cross-client attack events are wired, but live multi-device
network latency has not been certified by these solo-match checks.

Final verification (2026-10-10): `test:enemy-rigs`, `test:enemy-models`,
`test:planet-physics`, `test:main-planets` (13 scenarios), `typecheck` and the production
`build` passed. Desktop/mobile source-model and supported hybrid captures were inspected.