// NECROFALL — bootstrap.
//
// DEFAULT: the folio-style WebGPU PLANET WORLD boots directly — the new
// environment + architecture stack, generated fully procedurally per seed/ring
// through the game's planet pipeline (`planetAt` + `makePlanetSpec`).
//   • `#/dev` / `?devworld` — aliases of the default (kept for scripts/tests).
//   • `?legacy` / `#/legacy` — the previous account shell + WebGL game, exactly
//     as it was (SpacetimeDB login/onboarding → MOBA shell → matches).
import { AppShell } from './app/AppShell';
import { SpacetimeConnection } from './app/spacetimedb/connection';
import { maybeMountGenomeLab } from './enemies/procedural/GenomeLab';

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing');

const legacyRoute =
  new URLSearchParams(window.location.search).has('legacy') ||
  /^#\/?(legacy|shell)\b/i.test(window.location.hash);

if (legacyRoute) {
  const shell = new AppShell(app);
  void shell.boot();

  // Developer genome inspector (plan §40): `?enemyDebug=1` opens the Enemy Genome Lab.
  maybeMountGenomeLab();

  // Exposed for console debugging — the shell at `necrofallShell`, the DB
  // connection at `necrofallDb`, and the game instance (once booted) at the
  // familiar `necrofall`.
  (window as unknown as { necrofallShell: AppShell }).necrofallShell = shell;
  (window as unknown as { necrofallDb: SpacetimeConnection }).necrofallDb = SpacetimeConnection.shared;
} else {
  // THE PLANET WORLD — the new default environment + architecture.
  void import('./dev/DevWorld').then((module) => module.startDevWorld());
}
