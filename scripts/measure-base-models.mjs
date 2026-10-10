import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

/**
 * NECROFALL — imported enemy base models: frame-cost A/B (`?basemodels=0`).
 *
 * Boots the same match twice with NOTHING but a fixed ring of crawler-species bodies — once with
 * the imported base model, once with the pooled procedural rig the switch falls back to — and
 * reports the frame-time distribution of each. Run it on the machine and backend you care about;
 * a headless readout is a *relative* comparison, not a ship budget.
 *
 * Usage: node scripts/measure-base-models.mjs [count]     (default 24 bodies)
 */
const count = Number(process.argv[2] ?? 24);
const server = await createServer({ cacheDir: '.test-shots/vite-enemy-perf', server: { port: 5197, host: '127.0.0.1', watch: null, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });

async function run(page, query, label) {
  await page.goto(`${url}/${query}`);
  await page.waitForFunction(() => Boolean(window.necrofallShell), {}, { timeout: 60000 });
  await page.evaluate(() => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    shell.hideShell(true);
    game.net.goSolo();
    const id = game.net.myId;
    game.roster.clear();
    game.roster.set(id, { id, name: 'perf', ready: true, colony: 0, nt: 0, isHost: true, me: true });
    game.hostOrder = [id];
    game.beginPlaying({ [id]: 0 }, 719);
  });
  await page.waitForFunction(() => window.necrofall?.phase === 'playing' && window.necrofall.envWorld?.ecology, {}, { timeout: 60000 });
  const spawned = await page.evaluate(async (bodies) => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, player = game.localPlayer;
    const up = player.position.clone().normalize();
    const side = new Vector3(0, 1, 0).cross(up).normalize();
    const genome = game.enemies.bestiary.genomes.find(candidate => candidate.species === 'crawler');
    const probes = [];
    for (let index = 0; index < bodies; index++) {
      const direction = side.clone().applyAxisAngle(up, index / bodies * Math.PI * 2);
      const position = player.position.clone().addScaledVector(direction, 14 + (index % 4) * 5);
      game.planet.projectToSurface(position);
      const enemy = game.enemies.spawn(genome.idx, position, {});
      enemy.name = 'perf-probe';
      probes.push(enemy);
    }
    window.perfProbes = probes;
    return probes.length;
  }, count);
  // Give the imported bodies a beat to attach (instant when the switch disables them).
  await new Promise(resolve => setTimeout(resolve, 2500));
  const stats = await page.evaluate(async () => {
    const game = window.necrofall;
    const frames = [], start = performance.now();
    let previous = start;
    while (performance.now() - start < 10000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    const probes = (window.perfProbes ?? []).filter(enemy => enemy.alive && game.enemies.byId(enemy.id));
    const sampled = frames.slice(5).sort((a, b) => a - b);
    return {
      samples: sampled.length,
      medianMs: +(sampled[Math.floor(sampled.length / 2)] ?? 0).toFixed(2),
      p95Ms: +(sampled[Math.floor(sampled.length * 0.95)] ?? 0).toFixed(2),
      probes: probes.length,
      imported: probes.filter(enemy => enemy.imported).length,
      visible: game.enemies.enemies.filter(enemy => enemy.alive && enemy.group.visible).length,
    };
  });
  return { label, spawned, ...stats };
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const procedural = await run(page, '?basemodels=0', 'procedural rigs');
  const imported = await run(page, '', 'imported base model');
  console.log(JSON.stringify({ count, procedural, imported }, null, 2));
  assert.equal(procedural.imported, 0, '?basemodels=0 must fall back to the generated rigs');
  assert.ok(imported.imported >= Math.min(count, imported.probes) / 2, 'the imported run must actually carry imported bodies');
} finally {
  await browser.close();
  await server.close();
}
