/**
 * NECROFALL — dev swarm load harness (mobile plan §120).
 *
 * `?swarm=400` keeps ~400 Necrophages alive around the local player for as long as the page is
 * open, so the §121 budget checklist (`?perfcheck`) — or a manual session — can be run under the
 * exact load the plan asks about ("3 players, 100/200/400/800 enemies"), instead of judging the
 * renderer on an empty lawn. Spawns are spread over time (≤ 8 per second), so the harness itself
 * never introduces the kind of one-frame hitch it is supposed to measure.
 *
 * Host only, playing phase only, dev-only (URL-gated) — nothing here ships in a normal boot.
 */
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { readSwitches } from '../rendering/DebugSwitches';

/** Spawns per second — a burst of 400 bodies in one frame would measure the harness, not the game. */
const SPAWN_PER_SECOND = 8;
/** Ring around the player the bodies land in (metres). */
const SPAWN_RING_MIN = 16;
const SPAWN_RING_MAX = 44;

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _side2 = new THREE.Vector3();

export class PerfHarness {
  /** `?swarm=N` — the population the harness maintains (0 = off). Works in search or hash query. */
  static readTarget(): number {
    try {
      const raw = readSwitches()['swarm'];
      if (raw === undefined) return 0;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private timer = 0;

  constructor(
    private readonly game: Game,
    /** Bodies to keep alive. */
    readonly target: number,
  ) {}

  update(dt: number): void {
    const g = this.game;
    if (this.target <= 0 || !g.isHost || g.phase !== 'playing') return;
    const player = g.localPlayer;
    if (!player || !player.alive) return;
    const perSecond = SPAWN_PER_SECOND;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / perSecond;
    const alive = g.enemies.aliveCount;
    if (alive >= Math.min(this.target, g.enemies.populationCap)) return;

    const genomes = g.enemies.bestiary.genomes;
    if (!genomes.length) return;
    const genome = genomes[Math.floor(Math.random() * genomes.length)];

    // Random tangent offset from the player, then snapped on to the drawn surface.
    _axis.copy(player.up);
    _side.set(0, 1, 0).cross(_axis);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0).cross(_axis);
    _side.normalize();
    _side2.copy(_axis).cross(_side).normalize();
    const angle = Math.random() * Math.PI * 2;
    const radius = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    _dir.copy(player.position)
      .addScaledVector(_side, Math.cos(angle) * radius)
      .addScaledVector(_side2, Math.sin(angle) * radius);
    _pos.copy(_dir);
    g.planet.projectToSurface(_pos);
    g.enemies.spawn(genome.idx, _pos, {});
  }
}
