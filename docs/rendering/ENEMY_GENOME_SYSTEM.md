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
- Independent torso width/length, head size, limb proportions, total size, chitin and accent colors.
- Stalker, Bulwark and Spire forms vary length, width, head, limbs and tail together, with small
	seeded deviations. Original remains available for comparison and older JSON presets.
- Textured head and tail grafts selected from the three source meshes. Cut surfaces discard
	disconnected islands while respecting UV-split vertices. Grafts align at their cut boundaries,
	with connecting tissue that follows both skins during locomotion and attacks.
- Donor hierarchies are excluded from later cuts/socket searches. The primary torso's texture
	is selected explicitly, rather than relying on scene traversal order.
- Texture-preserving palette remapping and animated Veins, Bands and Cells emission. Patterns
	share the game's shader clock, stay in body-relative coordinates and respond to aggro.
	Glow intensity is adjustable, including zero; hit flash and frost retain their existing priority.
	The anatomy tint blends at 25%, preserving most of the painted color. Emission brightens
	the textured, lit surface with bounded highlight headroom instead of adding a flat color wash.
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

Attack poses are calculated from the current attack phase and anatomy, not played from clips.
Stomps now articulate the torso and lift one support foot before planting it again, including
crawler Guardians; the remaining feet stay under terrain IK. Stun freezes the generated pose.

Beacon Guardian base scale, radius and attack reach are 1.5 times their previous values.
Nexus Mega Necrophages use 2.25 times their previous values, with no parasite-only height
reduction. Health, damage and speed are unchanged. Seeded size variation remains; the lab
accepts sizes up to 16 and expands camera distance/clipping for giant previews.

## Lab And Tests

Open `/?enemyLab=1` for the live modeling lab. It shares the game loader, anatomy rules and
rig controller. It supports seed/roster selection, compatible source-part choices, proportions,
palette, terrain courses, speed, attacks, skeleton/contact inspection and JSON import/export.
Exported JSON is a reusable lab preset, not a server-side content deployment.

- `npm run test:enemy-rigs`: 1,260 seeded anatomies, nine real-model terrain courses, idle
	contact locking, stun, 18 donor/part combinations with animated attachment checks,
	nine moving forms with measured silhouette differences, desktop/mobile model pixels,
	three shader-only glow animation checks with a glow-disabled control, 11 legal procedural
	attack poses, and source-texture contrast at maximum glow. Giant Guardian/Nexus tests check
	terrain contact, visible pixels and framing clear of the controls on desktop and mobile.
- The reported seed 774 crawler/Behemoth-tail combination is replayed with its original
	proportions; its capture is `seed-774-repaired.png` in the lab screenshot directory.
- `npm run test:enemy-models`: real match spawns, all three Guardian bases, pursuit, damage,
	frost, death, attack delay/dodging, off-screen recovery and grounded Behemoth enrage.
	Checks also require larger Guardian collision/visual sizes and a still-larger unclamped Nexus.
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

Mutation repair verification (2026-10-10): the expanded `test:enemy-rigs`, `test:enemy-models`,
`test:main-planets` (13 scenarios), and production `build` including TypeScript passed.
The main-game check caught and now protects the torso-vs-donor texture ownership regression.
Runtime graft connections are presentation geometry, not a watertight mesh-export/authoring
pipeline. Weight-bearing limbs remain torso-matched. Physical-device performance and
full multiplayer swarm load remain outside the current verification.