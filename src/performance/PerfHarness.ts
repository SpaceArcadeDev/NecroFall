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
import { CONFIG } from '../core/Config';
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

/**
 * DETERMINISTIC BENCHMARK SCENARIOS (r186 plan §40).
 *
 * `?bench=<name>` pins a named load so two runs on two machines (or two builds) measure the same
 * thing — the plan's TEST A–H, mapped onto the load hooks this game actually has. `?swarm=N`
 * remains the free-form override and wins over the scenario's own population.
 *
 *   empty       TEST A — nothing spawned, decorations hidden: pure terrain/grass baseline
 *   swarm50     TEST B — player + 50 enemies
 *   swarm100    TEST C — player + 100 enemies
 *   colonies    TEST D — towers + 100 enemies (the tower/warden VFX ride along)
 *   boss        TEST E — boss + swarm (the harness summons a full boss body on a 75 s cadence)
 *   vfx         TEST F — maximum combat VFX (250 enemies + bosses, decorations on)
 *   vegetation  TEST G — maximum vegetation (decorations on, grass LOD0 pinned)
 *   full        TEST H — everything at once
 *
 * Scenarios only touch knobs the game already exposes (spawn target, decoration visibility, LOD
 * pin); nothing here changes gameplay rules, so a scenario run stays comparable to a real match.
 */
export interface BenchScenario {
  name: string;
  swarm: number;
  /** null = leave the user's visibility switches alone. */
  decorations: boolean | null;
  /** true = pin grass to LOD0 (maximum vegetation load). */
  grassLodFull: boolean;
  /** true = summon a full boss body on a cadence (TEST E). */
  boss: boolean;
  /** Name for the perfcheck report. */
  label: string;
}

const BENCH_SCENARIOS: Record<string, Omit<BenchScenario, 'name'>> = {
  empty: { swarm: 0, decorations: false, grassLodFull: false, boss: false, label: 'TEST A — empty planet' },
  swarm50: { swarm: 50, decorations: true, grassLodFull: false, boss: false, label: 'TEST B — player + 50 enemies' },
  swarm100: { swarm: 100, decorations: true, grassLodFull: false, boss: false, label: 'TEST C — player + 100 enemies' },
  colonies: { swarm: 100, decorations: true, grassLodFull: false, boss: false, label: 'TEST D — colonies + 100 enemies' },
  boss: { swarm: 60, decorations: true, grassLodFull: false, boss: true, label: 'TEST E — boss + swarm' },
  vfx: { swarm: 250, decorations: true, grassLodFull: false, boss: true, label: 'TEST F — maximum VFX' },
  vegetation: { swarm: 0, decorations: true, grassLodFull: true, boss: false, label: 'TEST G — maximum vegetation' },
  full: { swarm: 250, decorations: true, grassLodFull: false, boss: true, label: 'TEST H — full match' },
};

export function readBenchScenario(): BenchScenario | null {
  try {
    const raw = readSwitches()['bench'];
    if (!raw) return null;
    const spec = BENCH_SCENARIOS[raw.toLowerCase()];
    if (!spec) return null;
    return { name: raw.toLowerCase(), ...spec };
  } catch {
    return null;
  }
}

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
  /** `?bench=boss` — seconds until the next full BOSS body lands (the survival-boss recipe). */
  private bossT = 8;

  constructor(
    private readonly game: Game,
    /** Bodies to keep alive. */
    readonly target: number,
    /** Summon a full boss body on a cadence (TEST E). */
    private readonly summonBoss = false,
  ) {}

  /** A random tangent offset from the player, snapped on to the drawn surface. */
  private nextSpawnPos(player: { up: THREE.Vector3; position: THREE.Vector3 }): THREE.Vector3 {
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
    this.game.planet.projectToSurface(_pos);
    return _pos;
  }

  /**
   * One full BOSS body near the player — the same recipe the survival cadence uses (boss genome
   * index, stun pool, roar), so TEST E loads the boss encounter's real cost.
   */
  private spawnBossBody(): void {
    const g = this.game;
    const player = g.localPlayer;
    if (!player) return;
    const guards = g.enemies.bestiary.bossIdxes;
    const idx = guards.length > 0 ? guards[Math.floor(Math.random() * guards.length)] : g.enemies.bestiary.apexIdx;
    if (idx === undefined || idx < 0) return;
    const e = g.enemies.spawn(idx, this.nextSpawnPos(player), {});
    e.stunMax = e.maxHp * CONFIG.boss.stunPool;
    e.stun = e.stunMax;
  }

  update(dt: number): void {
    const g = this.game;
    if (!g.isHost || g.phase !== 'playing') return;
    const player = g.localPlayer;
    if (!player || !player.alive) return;
    if (this.summonBoss) {
      this.bossT -= dt;
      if (this.bossT <= 0) {
        this.bossT = 75;
        this.spawnBossBody();
      }
    }
    if (this.target <= 0) return;
    const perSecond = SPAWN_PER_SECOND;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / perSecond;
    const alive = g.enemies.aliveCount;
    if (alive >= Math.min(this.target, g.enemies.populationCap)) return;

    const genomes = g.enemies.bestiary.genomes;
    if (!genomes.length) return;
    const genome = genomes[Math.floor(Math.random() * genomes.length)];
    g.enemies.spawn(genome.idx, this.nextSpawnPos(player), {});
  }
}
