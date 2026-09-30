// NECROFALL — bootstrap.
//
// The account shell decides what boots:
//   • SpacetimeDB configured + signed in → login/onboarding → MOBA shell →
//     official (SpacetimeDB-authoritative) or P2P (existing WebRTC) play —
//     classic and rank matches run exactly as they always have.
//   • Anything else → the existing game boots exactly as it always has.
//
// PLANET WORLD (the new folio-style environment + architecture stack):
//   • `#/world` (or `#/dev`, `?world`, `?devworld`) boots the planet scene —
//     fully procedurally generated per seed/ring through the game's planet
//     pipeline (planetAt + makePlanetSpec).
//   • The gameplay migration (classic/rank matches running ON the planet
//     world) lands as a staged port: world adapter → entity bridge → mode
//     wiring → netcode — the routes above are where it will become default.
import { AppShell } from './app/AppShell';
import { SpacetimeConnection } from './app/spacetimedb/connection';
import { maybeMountGenomeLab } from './enemies/procedural/GenomeLab';

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing');

const params = new URLSearchParams(window.location.search);
const planetWorldRoute =
  /^#\/?(dev-world|dev|world)\b/i.test(window.location.hash) ||
  params.has('world') ||
  params.has('devworld');

if (planetWorldRoute) {
  void import('./dev/DevWorld').then((module) => module.startDevWorld());
} else {
  const shell = new AppShell(app);
  void shell.boot();

  // Developer genome inspector (plan §40): `?enemyDebug=1` opens the Enemy Genome Lab.
  maybeMountGenomeLab();

  // Exposed for console debugging — the shell at `necrofallShell`, the DB
  // connection at `necrofallDb`, and the game instance (once booted) at the
  // familiar `necrofall`.
  (window as unknown as { necrofallShell: AppShell }).necrofallShell = shell;
  (window as unknown as { necrofallDb: SpacetimeConnection }).necrofallDb = SpacetimeConnection.shared;
}
