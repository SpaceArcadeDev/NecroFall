# NECROFALL

A 3D **spherical mini-planet PvPvE auto-shooter / roguelike** for the browser.
TypeScript + Three.js + Vite, with **peer-to-peer multiplayer** over WebRTC DataChannels
(PeerJS is used for signalling only — gameplay state travels peer to peer).

```bash
npm install
npm run dev      # http://localhost:5173
```

Open a second browser tab/window (or send the invite link / lobby code to another device on
your network) to play together. Up to **9 players**, **3 per colony** — a 3v3v3 match.

## Base Planets

The main spherical game draws from ten approved profiles: Cinderbloom, Glass Tide,
Saffron Waste, Mycelial Night, Frostwound, Verdant Tempest, Emberwake, Roseshard Basin,
Stormglass Reach and Aether Garden. A planet seed determines its profile, terrain,
palette variation, radiation, ecology and solar system. Fresh local classic matches
roll a new seed and avoid immediately repeating the previous base profile; joining
an existing match preserves its seed.

The system sun stays fixed in world space. Crossing the planet's terminator blends
through warm twilight into the dark hemisphere; the sun does not follow the player.
Water is limited to shallow basins (at most 0.35 m), with grounded walking wakes.
Grass trails persist behind walkers and recover. Terrain, authored rocks, spikes and
crystals provide shape-based capsule collisions and top support;
steep upward-facing slopes remain climbable while vertical walls block movement.
Only the Mega Necrophage uses the imported enemy model. Towers, bases, shields,
pads and the other enemy rigs retain their gameplay.

The preserved gallery is at [/base-planets.html](base-planets.html), with
[concepts.html](concepts.html) retained for compatibility. Both pages ship in
`npm run build`. The game's **How To Play** screen links to the gallery and
[asset credits](src/concepts/assets/ATTRIBUTION.md). The gallery can also be built
separately with `npm run build:base-planets`.

```bash
npm run test:planet-physics
npm run test:main-planets
npm run test:main-planets -- --planet=cinderbloom
npm run test:main-planets -- --classic
npm run test:main-planets -- --variants
npm run test:base-planets
npm run test:base-planets -- --visibility
```

The main browser suite uses installed Edge (`BROWSER_CHANNEL` overrides it), starts
its own local server, and writes captures to `.test-shots/main-planets/`. It covers
all ten profiles, day/twilight/night, classic structures and Mega animation,
mobile rotation, WebGL fallback, and fixed-clock grass/water trail pixel comparisons.
The physics suite covers exact rendered terrain sampling, collision support,
75-degree climbing, shallow water, trail lifetimes, twilight and classic seed rolls.
These local tests do not certify physical-phone performance or live multiplayer/auth
services. Local account login still requires the configuration described below.

---

## Online architecture — accounts, OFFICIAL (SpacetimeDB) and P2P

The game now ships two multiplayer worlds behind one interface:

* **OFFICIAL** — SpacetimeDB is the authoritative server: accounts and identity
  (SpacetimeAuth OIDC + PKCE), profile/wallet/inventory/cosmetics, follow graph,
  profile views, matchmaking (2–9 players, max 3 per colony, 5 s fill window,
  10 s confirmation, auto-requeue), a 10 Hz per-match simulation, and
  server-computed results, rewards, statistics and match history.
* **P2P** — the existing WebRTC lobbies are **unchanged** (host authority, room
  codes, host migration). P2P games never grant official rank or currency; they
  can only bump separate community counters.

The account shell (`src/app/`) shows login → onboarding (colony/name/avatar) →
MOBA-style home (profile, friends rail, PLAY). The 3D game is used by **both**
modes; official matches boot with a small bridge (`OfficialGameBridge`,
`src/app/multiplayer/OfficialTypes.ts`) that routes pose messages through
SpacetimeDB with the cost rules from the plan (input-change-driven reducers, not
per frame).

> **Damage can never be lost to throttling.** The match authority relays the P2P
> protocol (`match_msg` rows); the module's per-sender budget is two-tier so a
> busy state stream (snapshots/poses/hit feedback) can never starve the one-shot
> gameplay events — enemy damage, kills, statuses — which have a reserved
> headroom and are never silently dropped. A seat that approaches the budget warns
> in the console, and `?debug` exposes `game.netDebug()` (role, authority, per-seat
> transport, relay sends/second). See
> [`spacetimedb/README.md`](spacetimedb/README.md) → "The relay budget".

```bash
cp .env.example .env.local     # fill in SpacetimeDB + SpacetimeAuth values
cd spacetimedb && npm install  # module deps
spacetime start                # local server, or use Maincloud
spacetime publish necrofall -y
spacetime generate --lang typescript --out-dir module_bindings --module-path .
```

Without a `.env.local` (or without generated bindings) the client boots exactly
as before: straight into the legacy P2P/offline game. See
[`spacetimedb/README.md`](spacetimedb/README.md) for the module details, admin
bootstrap and cost discipline.

### Deploying to Vercel

1. Add the same `VITE_*` values under **Project → Settings → Environment
   Variables**. Vite bakes them into the bundle at build time, so after changing
   any value you must **redeploy** (Deployments → ⋯ → Redeploy).
2. In the SpacetimeAuth dashboard (module dashboard → SpacetimeAuth) register
   the deployed URLs on the client: Redirect URI `https://<app>/auth/callback`
   and Post Logout Redirect URI `https://<app>/`. If the provider answers
   `redirect_uris must contain members`, the client has no redirect URIs saved
   yet — add them in the client's edit dialog and save.
3. `vercel.json` rewrites `/auth/callback` to `index.html`; without that the
   provider's redirect back lands on a Vercel 404 and sign-in can never finish.

---

## The match

```
MAIN MENU → CREATE/JOIN LOBBY → LOBBY → HOST STARTS
   → 20s COLONY SELECTION → 30s NECROTECH SELECTION → SPAWN ON THE PLANET
   → 10:00 NECRORAD → CONTROL THE 5 TOWERS → VICTORY (or the Necrophages win)
```

* **3 colonies** — HELIOS (offense), AEGIS (defense/territory), VANTA (mobility/Necrotech).
* **5 starting Necrotechs (classes)** — RAVAGER (marksman), VOLT (chain mage), PYRE (pyromancer),
  RIFT (assassin) and VENOM (plaguebearer) — plus **6 more that only drop mid-match**: BREAKER
  (vanguard), BULWARK (juggernaut), FROST (controller), REAPER (executioner), NOVA (detonator) and
  WHIPLASH (warden). Every class has an automatic basic attack, one Skill, one Ultimate and a passive.
* **4 Beacon Towers ring the Nexus** across the planet — the Nexus sits at the centre and the
  Beacons are strung **~78° out**, so they are spread far apart and taking one means a real trek.
  Every tower counts as 1 point; the colony holding the most towers when the Nexus falls claims the
  planet.
* Kill a tower's **boss** to open it, hold the zone with a **majority** to capture it. A captured
  Beacon raises a shield; every Beacon activates the **same optional ability — COLONY OVERDRIVE**
  (`F` inside a shielded Beacon): **all of your colony's stats are doubled for 30 seconds** (damage,
  ability power and Necromutation gain ×2, damage taken halved). The shield then **stays down for
  good** — Necrophages walk straight in and rival colonies can take the Beacon — so it is a real
  trade, not a free buff.
* **Your colony base is a ship.** Each colony's fortress hovers high over the planet and **orbits it
  slowly** — spawns and respawns land on its deck and riders are carried along with it. Under its
  lane crossing, fixed on the ground, is your **healing pad**: the colony-coloured cone with a giant
  floating plus and small pluses rising out of it. Colony-mates standing in it **heal and shed every
  debuff**; every other colony (and every Necrophage) is thrown off it.
* **The Nexus is sealed.** The seal holds until **every Beacon has been captured** — then the Mega
  Necrophage is summoned to defend it while the shield stays up. It is not chained inside the dome:
  it crosses its own ward freely, chases anyone who comes near and leashes back to the Nexus, so it
  can be fought in the open. Only when the Mega falls does the **Nexus shield collapse** (`Mega
  Necrophage defeated — Nexus Shield Fell`) and the Nexus become capturable.
* **Anti-cheese**: while you are picking a Necromutation perk or a Necrotech reward the match keeps
  running, but every Necrophage within ~34m of you **backs away** until you are back in control.
* **Replication is capped.** A *Fission* Necrophage splits into two on death, but only **three
generations deep** — and each generation is smaller, frailer, hits softer and is worth less XP, so
  a broke-apart Ooze line ends after 14 bodies instead of growing forever. The *Brood* ability works
the same way: it bursts into swarmlings once, and those swarmlings cannot brood again.
* **Necromutation** level-ups give a choice of 3 perks (5s — you are invulnerable while choosing;
  **airborne momentum and trajectory carry on, a grounded run brakes to a stop**) and pay off like
  a Necrotech upgrade: an **energy burst at auto-attack range** (not the doubled Necrotech Burst
  radius), a **full heal** and a **full Skill / Ultimate / dash refresh**.
  Perks include mobility and defensive picks such as **Winged Sinew** (+1 jump), **Split
  Chamber** (+1 projectile per volley), **Necrotic Ward** (a regenerating damage-soaking shield)
  and **Ward Mastery** (bigger shield).
* **Everyone gets a double jump for free.** The base kit carries one mid-air leap (`CONFIG.player
  .baseJumps`), the standard jump was raised to ~4.4 m of height, and jump perks simply **add
  another leap** (`+1 jump`) on top — the perk text no longer says "double jump", because that is
  now the default.
* **Necrotech** drops come from Beacon guardians, the Nexus overseer, **apex minibosses, elites and
  rare large Necrophages** alike: **KEEP / SWAP or MUTATE** — mutation fuses loadouts and always
  carries a real drawback. Rare drops can roll a **SUPER MUTATION**. Drops draw from **all eleven
  classes**, so the six drop-only kits are how a build escapes its starting archetype. Elite/apex
  drop rates were lowered and **picking up any Necrotech puts the whole system on a 20s cooldown**
  (a status icon on your head plate plus a `NECROTECH SYSTEM RECHARGING` toast), so upgrades can't
  be chained back to back. A drop nobody grabs **fades out and despawns after 5 seconds**.
* **Mutations COMBINE kits, they do not just pick one.** A fusion keeps one parent's Skill and the
  other's Ultimate, then inherits **both** parents' auto-attack behaviour on top: RAVAGER·VOLT hurls
  a wider volley that **zaps everything around what it hits**, PYRE·BREAKER **ignites on hit and
  bursts corpses into fire**, BULWARK adds **knockback**, FROST adds **chill**, VENOM adds **toxin**
  and RIFT adds **piercing** — and every fusion throws an **extra projectile (two for a SUPER
  MUTATION)**. The combined trait list is printed on the pickup card and in the `ESC` panel.
* **A full loadout is a TRIPLE PERMUTATION.** Hold three Necrotechs at once (the starting class
  plus two absorbed — the head-plate chip counts your whole stack, **×2 → ×3**). Two form a named
  **pair permutation** (`VOLT + RIFT` → **VOIDSTORM**); fill all three slots and the loadout
  resolves into a **TRIPLE** with its **own name, its own Skill / Ultimate picks** (each triple
  says which parents provide them, so the third class is never dead weight) **and its own effects**
  — `VOLT + BULWARK + RAVAGER` → **IRONSTORM**, `PYRE + RAVAGER + VENOM` → **CINDERPLAGUE**,
  `FROST + PYRE + VOLT` → **THUNDERFROST**, and so on. Every spawn-class triple and the headline
  drop hybrids are hand-authored; **any other triple still resolves**, deterministically named from
  the three classes' own vocabulary (`NOVA + REAPER + VOLT` → **STARREAPSTORM**). A full stack
  carries **exactly one** drawback, and further mutations overwrite a random slot — the loadout
  never grows past three.
* **Abilities are written like a MOBA kit, and now look like one.** Every Skill and Ultimate is
  either aimed (a line, a cone, a ground-targeted drop) or an instant self-cast, and each one
  telegraphs itself the way a MOBA does: a **marked area fills before an AoE lands**, cones throw a
  **visible fan of fire**, beams and slashes leave tracers, dashes leave afterimages, and lingering
  zones (meteor fire, plague, frost fields, singularities) keep ticking while they burn.
* **Status effects stack — and they hurt you too.** Toxin, flame and slow effects stack up to 5
  times (refreshing a stack adds 45% of a new one), and a corpse **spreads its remaining
  damage-over-time to nearby kin**. Necrophages give as good as they get: venom clouds and melee
  from venomous species leave **stacking toxin**, a shockwave **slam** leaves a **burning ground**
  (`Wither Burn`) and briefly **shocks** your legs, and web shots **slow** you — all of which appear
  as status icons above your name with a live countdown ring.
* **Status icons are ordered by when you picked them up**, not alphabetically, and a re-applied
  effect moves to the end of the row like a fresh buff.
* **Skill and Ultimate cooldowns are capped at 12s**, so a fight never stalls.
* Dying is not the end: you respawn **on your colony fortress deck** after a few seconds — abilities,
  dashes and dash momentum come back reset and ready.

## Controls

| Desktop | |
| --- | --- |
| `W` `A` `S` `D` | Move (momentum based, camera-relative) |
| `SPACE` | Jump |
| `SHIFT` | Dash — 3 charges, i-frames, recharges over time. Each dash leaves **momentum**: +2 top speed, **uncapped**, kept in the air, bled off gradually while running on the ground — chain dash-jump-dash-jump to keep accelerating |
| `LEFT CLICK` / `Q` | Skill |
| `RIGHT CLICK` / `E` | Ultimate |
| Arrow keys | Aim with the keyboard (replaces the cursor; screen-up is forward) |
| `F` | Activate COLONY OVERDRIVE (inside a shielded Beacon of your colony) |
| Mouse cursor | Aim direction (shown by the ground arrow) |
| `F1`–`F8` | Development debug tools |

**The camera is fixed.** It never rotates from mouse movement, arrow keys or player movement —
it keeps a constant heading and pitch, and follows the planet's curvature using parallel transport.
Aiming is done with the cursor, completely independently of the camera.

**Mobile** — landscape only (see below). The right thumb gets a big **DASH** button that mirrors the
movement stick — same size, same inset from the corner, with the dash-charge counter on it. Jump,
Skill and Ultimate fan up its **top-left quadrant**, bottom to top: **JUMP → SKILL → ULTIMATE**,
each labelled like the desktop rail (the tag lives inside the button, the ability name is printed
below the glyph, and the jump button shows how many leaps are left exactly like the dash counter).
A **BEACON** button appears directly to the left of Jump whenever you are standing in one of your
colony's shielded Beacons, so the ability can be fired without reaching into the HUD. **Aiming is
done by dragging the Skill/Ultimate button itself**, MOBA-style: press the button and drag up to
`54 px` in any direction to sweep the ground aim chevron, then release to cast. A tap without a drag
casts straight ahead using the current aim, so a quick poke never loses your direction, and there is
deliberately **no second joystick or aim pad** — one movement stick, one drag-to-aim button per
ability. The left thumb keeps the movement stick; all buttons are multi-touch, sized from the
viewport (`clamp()`) and offset by `env(safe-area-inset-*)` so nothing hides under a notch or a home
bar. The **end screen collapses to a single scrollable column** on a phone (two stat tiles per row,
tower chips in a grid, full-width button) and the **top-left settings cog** opens the same panel
`Esc` does. Phones and tablets **must be held in landscape**: in
portrait a blocking panel asks for the rotation and the page requests a landscape orientation lock
(fullscreen + Screen Orientation API where available, falling back to a "rotate your device" prompt
on iOS). Local control is suspended while the panel is up.

**Fullscreen and the Apple devices.** Fullscreen is asked for automatically on the first tap (a user
gesture is the only legal moment to request it) and can be toggled from the `Esc` / settings-cog
menu at any time. The request walks **every spelling of the API** — `requestFullscreen({navigationUI})`,
`requestFullscreen()`, `webkitRequestFullscreen()`, and the oldest `webkitRequestFullScreen()` — because
an older Safari only has the prefixed ones and a newer one can still refuse the unprefixed call with
options it does not implement; the refusal of each attempt is recorded and the first one that works
wins. Where *nothing* works the toggle falls back to an **immersive** mode rather than hiding (the old
behaviour hid the button, which is how "there is no fullscreen toggle" started): `html.nf-immersive`
(styles.css) gives the document one extra pixel of scroll, the only page-level lever that makes Safari
collapse its address/tool bars — the game itself is `position: fixed`, so nothing but the browser
chrome moves. **iPhone Safari has no Element Fullscreen API at all** (and neither has any in-app
WebView on iOS — MDN lists them as "no support", which is what a Stremio-style player is), so the Esc
panel prints the exact reason under the button, points at Share → *Add to Home Screen*
(`apple-mobile-web-app-capable` in `index.html` makes that a real chrome-free app), and tells you when
the page is only on plain `http://` (the Fullscreen API is exposed on `https://`/localhost).

**Zooming on iOS.** iOS ignores `user-scalable=no`, and — this is the part that made the first fix
fail — **zoom cannot be suppressed from JavaScript at all**: the Pointer Events spec (§8) states that
viewport panning/zooming "cannot be suppressed by canceling a pointer event", and authors "must
instead use `touch-action`". WebKit then only implements the *double-tap* opt-out for the
`manipulation` value; with `none` (the stricter value on paper) it still zooms when the same control is
tapped twice. So the controls and **every child under them** (a finger lands on `.m-ico` / `svg` /
`.m-tag`, not on `.mbtn`) are `touch-action: manipulation`, while the `.mobile` / `#app` containers are
`none` so a stray pinch still cannot zoom (`zooming must conform to every element from the hit target
up to the document`). Mobile controls (`.mobile` in `UI.buildMobile`) are **real `<button>` elements** — dash, jump, skill,
ultimate, beacon and even the movement stick. iOS refuses double-tap-to-zoom on an *interactive*
control (which is why a double tap in the main menu, where the controls have always been `<button>`s,
never zoomed while the in-game `<div>` buttons did); their user-agent styling is stripped with
`appearance: none`. Two more layers sit on top: every control and every child of it is
`touch-action: manipulation` (the only value WebKit honours for the double-tap opt-out) while the
`.mobile` / `#app` containers are `none` so a stray pinch cannot zoom, and `src/ui/TouchGuard.ts`
watches `visualViewport` while a match is on screen and rewrites the viewport meta to snap the scale
back if WebKit zooms anyway. The pause panel carries a tiny `.diag` block (touch devices) with the
zoom scale, the last tapped element, its computed `touch-action` and the fullscreen state — so a
device report can name the cause instead of guessing (and its presence proves the new bundle is the
one running).

## Procedural planet + Necrophage bestiary

Every match is generated from a seed the host rolls when the match starts:

* **The planet is rebuilt for the match.** A fresh icosphere heightfield, biome colouring and
  decoration field (rocks, crystals, peaks, fungal trunks + canopies, a stylized grass/flower/plant
  field, and a dense grass field around every tower) is generated from `seed *
  2654435761`, with the scenery concentrated around the battlefield so the contested region is
  always dressed. The ground shader adds multi-octave grain, vegetation and rock blending by
  slope/altitude, damp basins and a narrow glowing vein network; the sun is aimed at the play area.
  The previous planet is disposed of (geometry + materials).
* **Stylized field + grass system** (`src/world/Vegetation.ts`, `src/world/GrassField.ts`) —
  worked out from the techniques documented in Christian Ortiz's MIT-licensed
  [`cortiz2894/stylized-components`](https://github.com/cortiz2894/stylized-components)
  (GrassField); every line here is original, no assets or code were copied:
  * **One shared wind.** `createWindUniforms()` holds direction, strength and gusting; the planet
    drifts them slowly each frame, so the whole world breathes together. The sway amplitude is kept
    deliberately small — a dense field with a big sway reads as flickering noise.
  * **Dense grass is generated once per match, then never moves.** Density is bought where it
    matters: `buildGrassField()` grows thick clumps around all five tower zones (where the fighting
    happens) as well as the thin planet-wide scatter, and because nothing is re-grown as you travel
    there is no pop-in at all.
  * **Blades follow the contour of the land.** Each clump takes a surface sample plus two probes to
    derive the *local terrain normal*; every blade then projects its own tangent offset onto the
    sphere and re-samples the height, so it sits exactly on the ground and leans with the hillside
    rather than hovering over it.
  * **The dense field has its own palette and lighting.** Continuous grass covers the whole screen,
    so this material keeps the blade's own green instead of tinting it with the planet's blue-violet
    ambient (which turned a full field visually blue) — it scales the blade colour by the light's
    luminance, adds a little scene tint and keeps a real sun highlight. Roots stay dark
    (`0x2c5238`) and tips carry the mid-green (`0x86cc92`) that matches the terrain's `uGrassColor`,
    so the field reads as *this* planet's grass rather than a pale lawn. The sparse scatter keeps the
    original colour-tinted shading, which is what it was tuned for.
  * **Far-field scatter** keeps the rest of the planet dressed (blades, flowers, and leafy plants
    built from a fan of blades, with cross-billboard flowers whose petals are cut from UVs — no
    textures).
  * **One shared ground-dirt mask.** `DIRT_GLSL` (and its CPU mirror `dirtAmount`) thins blades into
    bare earth, tints them towards soil, and doubles as the trample value — trodden tufts are pressed
    down and splayed. Placement uses the same mask, so vegetation only grows on open ground.
  * Each instance carries `aTint / aHeight / aTrample / aPhase`; the vertex shader keeps the root
    planted while the tip swings quadratically, with the normal biased towards the ground so thin
    ribbons never go black. Tips pick up a subsurface glow when the sun is behind them.
  * Density scales with the quality tier, and everything sits in the decoration group, which the
    performance watchdog hides first when frames get tight.
* **Ambience** (`src/world/Ambience.ts`) — two GPU-animated point clouds, one draw call each, both
  trimmed by the same watchdog particle budget: drifting **motes** that wrap inside a box around the
  camera (so they never pop — a mote leaving the box reappears on the opposite face) and twinkling
  **ground glints**, static sparks that sit just above the terrain around the arena and glint on
  their own phase.
* **Necrophages ride the terrain.** Every frame each creature is placed at the terrain height under
  its own direction, with leaps, pounces and gravity carried as a separate air height. Walking up a
  hill therefore can never leave one floating at the elevation it started at (which is what the old
  "only snap when moving downhill" code did — measured up to ~4 m of drift on a slope).
* **The Necrophage bestiary is generated from the same seed** (`src/enemies/EnemyGenomes.ts`):
  9 genomes per match — 3 small, 3 large, 1 apex miniboss, 1 Beacon boss and 1 Nexus overseer.
  Each genome rolls a body plan (legged chassis, jelly slime, segmented burrower), colour, plating,
  spikes, horns, head/eye/maw/leg counts, stats (HP, speed, damage, attack range, projectile kind)
  and **2–5 abilities out of 20** (spit, volley, web shot, slam, venom cloud, charge, pounce, blink,
  burrow, ambush, pack, barbed hide, siphon, frenzy, regrowth, plating, gravitic pull, brooding,
  fission and detonation). Names are generated from species + prefix + tier, so each match fights a
  different roster — e.g. *Pale Weaver* (Blink, Web Shot), *Rust Hulk* (Barbed Hide, Regrowth,
  Gravitic Pull), *Ash Writhe Warden* (Beacon boss), *Cinder Colossus Overseer* (Nexus boss).
  Press `F1` for the debug overlay or check the console at match start for the full roster.

## HUD

The in-match UI is deliberately minimal:

* **Circular radar** top-left, centred on the player and **aligned with the fixed camera** (what is
  to the right on screen is to the right on the radar). Beacons and the Nexus are drawn as **large**
  colour-coded landmarks (watch-tower sigil / rayed diamond core, scaled to the radar's real pixel
  size and glowing in their owner's colour), and out-of-range towers are pinned to the rim so you
  always know which way to run. The top-right tracker uses the same two sigils.
* **Match timer** top-centre.
* **Tower tracker** top-right: one legend tile per tower (4 Beacons + the round Nexus) showing
  owner colour, a capture arc, and a single status marker (warden alive / shield up / exposed /
  capturing).
* **Objectives** under the tracker: Liberate Beacon Towers (x/4), Defeat Mega Necrophage (x/1),
  **Reclaim the Nexus Tower** (x/1) — struck through as they complete.
* **Vitals on your head**: level badge, name, health, Necromutation and dash circles above your
  character (MOBA style), with a green → orange → red health gradient and a **blue Necromutation
  bar**. Dashes are plain circles — lit when available, dim when spent. The only bottom-centre
  readout is the current Necrotech name.
* **Skill / Ultimate** bottom-right: round icons with a cooldown sweep, remaining seconds and the
  ability name. Each button draws its own icon derived from the ability's wording (volley, wave,
  shield, storm, rift, lance, pulse, toxin, reap, buff…), so Skill and Ultimate never look alike.
  Abilities are always labelled *Skill* and *Ultimate*, with the `Q` / `E` quick-cast keys shown on
the icon.
* **Status icons above the name plate**: one circle per active buff or debuff (colony boon, the
  Necrotic Ward, invulnerability, a fusion, the Necrotech cooldown, burn / toxin stacks, webbed or
  shocked slows…) with a **countdown ring** that drains as it expires, a stack badge, and a tooltip
  that explains the effect on hover (mouse) or press-and-hold (touch).
* **Notifications** (toasts + kill feed) stack on the **left edge, vertically centred**, small and
  unobtrusive so they never cover the fight or the bottom HUD.
* **Floating head plates** for bosses, apex minibosses and elites; a huge enemy keeps its bar on
  screen (clamped inside the frame) while any part of its body is visible. Plates are cleared while
  a full-screen overlay is up (Necromutation, Necrotech pickup, respawn) so nothing shows through it.
* **Aim marker**: a minimalist ground chevron whose vertex points along the skill direction,
  painted onto the terrain like the auto-attack range ring.
* `ESC` opens a slim left-hand panel that **never pauses the match** — it lists your live stats,
  abilities and picked perks while the fight stays visible and running. If the host leaves, the
  match ends immediately as a Necrophage win for the remaining players.

## Graphics

Custom shaders drive the look (see `src/world/ShaderGlobals.ts`):

* **Terrain** — hand-built indexed icosphere heightfield (continents, plateaus, ridged mountain
  belts, canyons, basins) shaded by a custom GLSL material with hemisphere + sun lighting, slope
  darkening, rim light, animated necrotic veins and exponential-squared fog.
* **Sky** — gradient dome shader with nebula bands and procedural twinkling stars.
* **Creatures** — procedurally assembled Necrophages (carapace segments, plating, spikes, horns,
  mandibled heads, hexapod legs with knees, tails, glowing cores) shaded with two custom shaders:
  a veined *carapace* material and an emissive *energy* material that pulses and flares on aggro.
  Both materials take a `uFlash` uniform, so a hit whitens the entire model.
* **Tower shields** — animated lat/long energy lattice with fresnel falloff.

## Audio

Nothing is downloaded — every sound is synthesised with WebAudio (`src/audio/AudioManager.ts`).
Voices are short oscillator + filtered-noise layers with pitch and amplitude envelopes, sent through
a shared bus into a **generated convolution reverb** and a compressor so stacked hits stay clean.
The weapon is a layered shot — a bright snap transient, a pitch-dropping body and a low thump
underneath, each shot slightly detuned so sustained fire never sounds mechanical. The dash is an
instant burst of air (hard punch in, band-passed whoosh sweeping up, low thump out) and the jump is
a springy lift with a small air puff. Impacts are deliberately dark, while ults, boss roars and
captures carry the reverb tail.

## Performance

Object pools for enemies, projectiles, particles, rings, beams and damage numbers; instanced
meshes for projectiles and decorations; a spherical spatial hash for target acquisition, collision
and zone queries; enemy **simulation LOD** (full / half / quarter tick rate by distance);
quality tiers (low / medium / high) chosen automatically from device capabilities.

On top of that, the game is built so it **cannot lock up**:

* **Creature rigs are merged.** A Necrophage is assembled from 20–45 little meshes, which at 150
  creatures meant 3,260 draw calls and a 106 ms frame (a hard freeze). Every rig now collapses its
  static parts — including each whole leg — into a handful of meshes, which measured **1,154 draw
  calls** for the same crowd (slime rigs went from ~15 meshes to 3, spiders from ~45 to ~13).
* **The crowd is capped.** Base spawns, packs, apexes and replication (split / brood) all share one
  population budget, and `cullTo()` trims the creatures furthest from any player when it is exceeded.
* **Distance culling.** Beyond ~130 m a plain Necrophage is not drawn at all (named creatures always
  are), so scenery and creatures the player cannot see cost nothing.
* **A performance watchdog** samples the framerate: four consecutive bad half-seconds cull the crowd,
  cut the particle budget, hide the instanced scenery and drop the render resolution, and it restores
  all of that after five good seconds. It ignores backgrounded tabs and one-off stalls, so it can not
  be triggered by switching windows.
* **The frame loop is crash-proof.** The next frame is scheduled *before* the update runs, and any
  thrown error is caught, logged and surfaced as a `FRAME ERROR RECOVERED` toast — a single fault can
  no longer freeze the picture forever. A lost WebGL context reports itself the same way.
* Press `F1` for live diagnostics: FPS, worst frame, draw calls, triangles, geometries, textures,
  JS heap, crowd size and the current rescue level.

### Mobile performance overhaul (2026-10)

The full mobile plan pass is recorded in [`docs/performance/MOBILE_OVERHAUL.md`](docs/performance/MOBILE_OVERHAUL.md)
(phase-by-phase status, measurements, deviations). In short:

* **Device tier + DPR cap** (`src/performance/DeviceTier.ts`) — one ladder (1.25 / 1.4 / 1.5 by
  viewport, capped by cores+m memory) picks the boot quality level and the render-resolution
  ceiling; the adaptive ladder and heat watchdog still own everything after that.
* **Grass sector LOD** (`GrassLOD.ts`) — the static field is split into 128 fixed sectors (was 32)
  and each sector draws 100 % / 50 % / 25 % of its blades by camera distance with hysteresis. Blade
  transforms never move; decimation is a `drawRange` prefix. `?grasslod=0` A/Bs it.
* **SwarmDirector** (`src/enemies/SwarmDirector.ts`) — owns the enemy simulation tiers (full / ½ /
  ¼ / ⅙ by distance, id-staggered, hysteretic) and the population target.
* **Budget checklist** — `?perfcheck=30` (live match only) prints a PASS/FAIL line against the
  plan's §121 budgets; `?swarm=200` keeps a crowd of that size alive while it runs. `?debug=true`
  also exposes the running game as `window.game` for console measurements.

### Three.js r186 pass (2026-10)

The r186 performance/rendering pass is recorded in
[`docs/performance/R186_UPGRADE.md`](docs/performance/R186_UPGRADE.md) (all 50 phases, the
verification runs, and the deviations with their reasons). In short:

* **Three r186.1** (pinned) — `Object3D.dispose()` / `compileAsync` / `compileComputeAsync` are now
  the real APIs the renderer code uses.
* **Capability probe + telemetry** — `[caps]` boot line (backend / compute / limits / tier / GPU)
  and `PerformanceManager.snapshot()` (frame, world, combat, network, server) feeding the `?stats`
  overlay in both the game and the dev world.
* **Memory ownership** — `ResourceRegistry` + `PlanetRoot`: SHARED vs PLANET-OWNED GPU resources,
  so a planet replacement disposes what it owns (baked textures, gradient, remapped materials,
  foliage SDF) and never what it borrows.
* **Dithered grass LOD** — the sector keep fraction now dissolves over ~1.1 s from a stable
  per-blade seed instead of snapping; transforms still never move.
* **Async precompilation** — world pipelines compile behind the loading screen (`?precompile=0`),
  with per-step timeouts and lazy-compilation fallback.
* **Benchmarks + flags** — `?bench=empty|swarm50|swarm100|colonies|boss|vfx|vegetation|full`
  (plan TEST A–H) and `?backend=webgl|webgpu`, `?spatialhash=0`, `?enemytiers=0` A/B switches;
  `?perfcheck` now also reports 1 % low, peak frame, heap delta and the telemetry line.

### Art-direction / visual rework (2026-10)

The stylised visual pass is recorded in
[`docs/rendering/ART_DIRECTION_REWORK.md`](docs/rendering/ART_DIRECTION_REWORK.md) (phase-by-phase
status, captures, deviations). In short:

* **ONE tuning document** — `src/rendering/ArtDirection.ts` holds the cel/atmosphere/vegetation/
  radiation/outline values and the sky palette, so the planet's look is re-tuned from one file.
* **Cel shading** — `CelShading.ts` quantises the shared `MeshDefaultMaterial` lighting ramp into
  4 soft bands (plan §3) and the terrain adds the shadow→mid→light ladder; `?cel=0` restores the
  pre-rework smooth ramp for A/B.
* **Hand-painted terrain** — `TerrainMaterial.ts` layers the baked masks (height/grass/wetness/
  radiation/rock/biome) with large+medium+fine noise, noise-blended elevation bands, slope-based
  rock, wet-ground cooling, radiation tint + glow, distance colour compression and an atmospheric
  rim — one material, no per-region variants.
* **Sci-fi sky** — `SkyDome.ts`: horizon gradient, drifting cloud bands, orbital dust, a banded
  giant, a moon and a sun disc whose core alone feeds the (restrained) bloom. `?sky=0` removes it.
* **Landmark composition** — `Landmarks.ts` grows a prop composition around every carved landmark
  (crystal grove, dead forest, bone valley, ruined colony, nest, fungal forest, floating rocks)
  plus ONE hero formation per planet for long-range navigation; instanced, terrain-aligned,
  deterministic from the planet seed. `?landmarks=0` removes the layer.
* **Emissive accents** — `EmissiveMaterial.ts` (pulse + high/medium/low bloom tiers) is the one
  factory for crystals, landmark cores and hero energy beams; `OutlineMaterial.ts` gives the hero
  formation its selective inverted-hull outline.
* **Capture aids** — `?view=<landmarkIndex>&viewAlt=<m>` (dev world, free camera) frames a landmark
  deterministically for the visual-regression captures; the `?stats` overlay now reports quality
  level, live DPR, interpolation spread and the landmark/hero identity.

### Terrain + formations rework (2026-10)

The follow-up pass — *complete visual + terrain + underground rework* — is recorded in the same
document. Its cave/underground half and the giant-mountain calibration were removed by a later
user ask (2026-10-09); the current world:

* **Normalized mountains** — the giant-mountain pass (22 m amplitude, ×5.5 chain reinforcement)
  read as too steep in play-testing, so ridge amplitude and chain reinforcement return to the
  earlier calibration (12.5 m / ×3.4): ranges stay readable on the horizon while the body-scale
  faces the player crosses come back inside the plan §69 budget. Basins, valleys and the
  `[−48,+64]` m collision band are unchanged.
* **Fall safety net** — `Player` tracks the last valid ground position and restores it if a body
  ever leaves the generator's collision band or falls for more than six seconds; ordinary terrain
  can never collapse into an infinite fall.
* **Geological formations** — `FormationGenerator.ts` + `Formations.ts` compose 12 authored sites
  per planet (rock clusters, boulder fields, stone rings with an altar shard, spire fields, cliff
  lines, crystal beds) from the shared `PropGeometry` asset library.
* **Sci-fi structures** — `SciFiStructures.ts` places the crashed colony ship (hull segments,
  fins, wing, debris field, running lights, torn reactor glow, ember motes, selective outline) at
  the planet's colony-wreck landmark, plus a landing pad, ruined antenna mast and energy relay.
  The satellite dish that once crowned the mast is gone (user ask 2026-10-09).
* **Visual sweep seeds** — `?visualSeed=VISUAL_001…005` pins the five deterministic captures every
  check runs against; `?at=ship` spawns at the crashed colony ship.

## Architecture

```
src/
  core/       Game.ts (orchestrator, phases, damage authority, messaging, debug)   Config.ts
  networking/ Networking.ts (P2P host/client, lobby codes, session lifecycle)
  world/      Planet.ts (terrain + shaders + decorations), ShaderGlobals.ts
  player/     Player.ts (movement, dash, health, perks, netcode, model)
  enemies/    EnemyGenomes.ts (procedural bestiary), EnemyModels.ts (creature rigs), Enemies.ts
              (AI, abilities, spawner, LOD, damage/boss plates data)
  necrotech/  NecrotechData.ts (10 classes + fusion rules), AbilitySystem.ts (abilities + burst),
              AbilityIcons.ts (per-ability SVG glyphs)
  necromutation/ Perks.ts
  towers/     Towers.ts, ShieldMaterial.ts
  combat/     Combat.ts (projectile pool, collisions, chains)
  effects/    Effects.ts (particles, rings, beams, damage numbers, shake)
  input/      InputManager.ts      camera/ GameCamera.ts
  ui/         UI.ts (menus, lobby, HUD, radar, modals, touch cluster), Orientation.ts
              (landscape gate), TowerIcons.ts, audio/ AudioManager.ts
```

Styles: `styles.css` (HUD + menus) → `styles.ui.css` (plates, gradient bars, tower tiles) →
`styles.rotate.css` (landscape gate) → `styles.mobile.css` (touch controls), loaded in that order
so later files win.

### Multiplayer notes

* The **lobby host is the P2P host** and the gameplay authority (timer, enemies, bosses, towers,
  shields, victory). Clients own their own movement/health and report state at 20 Hz; the host
  broadcasts world snapshots at 12 Hz and validates damage events (range/rate checks).
* Clients locally predict hits and visual effects, then reconcile with authoritative snapshots.
* **No host migration.** The host is the authority for the whole match, so a host that leaves or
  disconnects ends the match immediately (`{t:'end', winner:null, reason:'THE HOST LEFT THE PLANET'}`)
  and the remaining players see the defeat screen. Esc / leaving mid-match is handled the same way
  and never freezes anyone else's game.
* If the signalling service is unreachable you can still host and play solo.
* The protocol is deliberately structured so authoritative systems can later move to a dedicated
  server (e.g. SpacetimeDB) without touching gameplay code.
