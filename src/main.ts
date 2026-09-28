// NECROFALL — bootstrap.
//
// The account shell decides what boots:
//   • SpacetimeDB configured + signed in → login/onboarding → MOBA shell →
//     official (SpacetimeDB-authoritative) or P2P (existing WebRTC) play.
//   • Anything else → the existing game boots exactly as it always has.
import { AppShell } from './app/AppShell';
import { SpacetimeConnection } from './app/spacetimedb/connection';
import { maybeMountGenomeLab } from './enemies/procedural/GenomeLab';

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing');

const shell = new AppShell(app);
void shell.boot();

// Developer genome inspector (plan §40): `?enemyDebug=1` opens the Enemy Genome Lab.
maybeMountGenomeLab();

// Exposed for console debugging — the shell at `necrofallShell`, the DB
// connection at `necrofallDb`, and the game instance (once booted) at the
// familiar `necrofall`.
(window as unknown as { necrofallShell: AppShell }).necrofallShell = shell;
(window as unknown as { necrofallDb: SpacetimeConnection }).necrofallDb = SpacetimeConnection.shared;
