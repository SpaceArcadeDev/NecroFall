import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import sharp from 'sharp';

/**
 * NECROFALL — imported enemy base models, exercised in the MAIN GAME.
 *
 * Both imported bodies must arrive as CELL-SHADED, RIGGED, ANIMATED enemies:
 *   • the crawler (`src/enemies/base_models/crawler.glb`) — a static Tripo mesh whose rig the
 *     engine derives on load (`AutoRig.ts`), driven by the procedural gait in `ImportedVisual`;
 *   • the parasite (`parasite-near.glb`) — the Nexus Overseer's Mega Necrophage, playing its
 *     baked walk clip through an AnimationMixer.
 *
 * The run boots a real solo match, spawns each body, and checks the whole contract: the visual
 * is skinned with a plausible skeleton whose bones actually MOVE, the surface is the cel-shaded
 * creature material with its uniforms wired, and the SIMULATION still treats the body as an
 * enemy — it hunts the player, takes damage, flashes, frosts over and dies.
 */
const server = await createServer({ cacheDir: '.test-shots/vite-enemy-models', server: { port: 5198, host: '127.0.0.1', watch: null, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const directory = '.test-shots/enemy-base-models';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });

async function capture(page, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const style = await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas[data-enemy-test] { visibility: visible !important; }' });
  try {
    const image = await page.screenshot({ path: `${directory}/${name}.png` });
    const stats = await sharp(image).stats();
    assert.ok(stats.channels.slice(0, 3).some(channel => channel.stdev > 6), `${name}: blank canvas`);
    return image;
  } finally { await style.evaluate(node => node.remove()); }
}

/** Boot a real solo match on a fixed seed (the same recipe the main-planets suite uses). */
async function start(page, seed) {
  await page.goto(`${url}/?swarm=30`);
  await page.waitForFunction(() => Boolean(window.necrofallShell), {}, { timeout: 60000 });
  await page.evaluate((matchSeed) => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    game.renderer.domElement.dataset.enemyTest = 'true';
    shell.hideShell(true);
    game.net.goSolo();
    const id = game.net.myId;
    game.roster.clear();
    game.roster.set(id, { id, name: 'Enemy model test', ready: true, colony: 0, nt: 0, isHost: true, me: true });
    game.hostOrder = [id];
    game.beginPlaying({ [id]: 0 }, matchSeed);
  }, seed);
  await page.waitForFunction(() => {
    const game = window.necrofall;
    return game?.phase === 'playing' && Boolean(game.envWorld?.ecology);
  }, {}, { timeout: 60000 });
}

/**
 * Aim the renderer at one body (or the midpoint of two) and freeze the loop, so the capture is
 * stable, close and clear of foliage.
 */
async function focus(page, find, options = {}) {
  return page.evaluate(async ({ find, mid, padding }) => {
    const { Vector3, Ray, DoubleSide } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall;
    const enemy = new Function('game', `return (${find})(game)`)(game);
    if (!enemy) return { ok: false };
    game.enemies.update = () => {};
    game.update = () => {};
    game.ticker.update = () => game.rendering.render(0);
    const up = enemy.position.clone().normalize();
    const side = new Vector3(0, 1, 0).cross(up).normalize();
    const forward = up.clone().cross(side).normalize();
    const camera = game.cam.camera;
    const size = Math.max(3, enemy.radius * 4) + (padding ?? 0);
    let distance = size * 0.9 / Math.tan(camera.fov * Math.PI / 360);
    const centre = mid
      ? enemy.position.clone().lerp(new Function('game', `return (${mid})(game)`)(game).position, 0.5).addScaledVector(up, enemy.radius * 0.7)
      : enemy.position.clone().addScaledVector(up, enemy.radius * 0.7);
    // Pick the first orbit angle with a clear line of sight, so foliage never covers the body.
    const directions = [];
    for (const elevation of [0.4, 0.25, 0.6]) {
      for (let step = 0; step < 24; step++) {
        directions.push(forward.clone().applyAxisAngle(up, step * Math.PI / 12).addScaledVector(up, elevation).normalize());
      }
    }
    let chosen = forward.clone().multiplyScalar(-1).addScaledVector(up, 0.4).normalize();
    let clearView = false;
    for (const direction of directions) {
      const candidate = centre.clone().addScaledVector(direction, distance);
      const ray = new Ray(candidate, centre.clone().sub(candidate).normalize());
      if (!game.envWorld.obstacles.meshTree.raycastFirst(ray, DoubleSide, 0, distance)) { chosen = direction; clearView = true; break; }
    }
    // No clear line from any orbit angle (a wall, a canyon, a forest): look down from above — the
    // sky is always open, and the surface clamp below keeps the camera out of the terrain.
    if (!clearView) {
      chosen.copy(up);
      distance *= 1.25;
    }
    // Clear the combat state the probe may have picked up before the freeze, so the capture shows
    // the body itself rather than a hit flash.
    enemy.flashAmt = 0;
    enemy.frostT = 0;
    enemy.iceAmt = 0;
    enemy.imported?.update(0, 0, { flash: 0, frost: 0, stunned: false, enraged: false });
    camera.position.copy(centre).addScaledVector(chosen, distance);
    // Never leave the camera inside a hill: clamp it above the drawn surface along its own
    // direction, exactly like the main-planets suite does.
    const cameraDirection = camera.position.clone().normalize();
    const floor = game.envWorld.deps.surface.radiusAt(cameraDirection);
    camera.position.setLength(Math.max(camera.position.length(), floor + 2.5));
    camera.up.copy(up);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    return { ok: true, id: enemy.id, radius: enemy.radius, distance, clearView };
  }, { find, mid: options.mid ?? null, padding: options.padding ?? 0 });
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => {
    if (message.type() === 'error' && !/404|favicon|auth-proxy|3000|ERR_CONNECTION_REFUSED/.test(message.text())) errors.push(message.text());
  });

  // ---------------------------------------------------------------- crawler base model
  await start(page, 719);
  const crawler = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, player = game.localPlayer;
    const genome = game.enemies.bestiary.genomes.find(candidate => candidate.species === 'crawler');
    if (!genome) return { found: false };
    // A match spawns the survivor inside a safe-zone base, where Necrophages deliberately cannot
    // target them — move the player to open ground first, so the hunt can actually be observed.
    const up = player.position.clone().normalize();
    const side = new Vector3(0, 1, 0).cross(up).normalize();
    const forward = up.clone().cross(side).normalize();
    let open = null;
    for (let step = 0; step < 40 && !open; step++) {
      const point = player.position.clone().addScaledVector(forward.clone().applyAxisAngle(up, step * 0.35), 70);
      game.planet.projectToSurface(point);
      if (!game.inSafeZone(point, 0)) open = point;
    }
    if (open) { player.position.copy(open); player.velocity.set(0, 0, 0); player.grounded = true; }
    const position = (open ?? player.position).clone().addScaledVector(forward, 13);
    game.planet.projectToSurface(position);
    const enemy = game.enemies.spawn(genome.idx, position, {});
    enemy.name = 'crawler-probe';
    return { found: true, id: enemy.id, radius: enemy.radius, species: genome.species, tier: genome.tier, openGround: Boolean(open) };
  });
  assert.ok(crawler.found, 'the bestiary must contain a crawler species');
  assert.equal(crawler.species, 'crawler');
  await page.waitForFunction(id => Boolean(window.necrofall.enemies.byId(id)?.imported), crawler.id, { timeout: 60000 });

  const rig = await page.evaluate(id => {
    const game = window.necrofall, enemy = game.enemies.byId(id), visual = enemy.imported;
    const skinned = visual.root.getObjectByProperty('isSkinnedMesh', true);
    const geometry = skinned?.geometry;
    const weights = geometry?.attributes.skinWeight;
    let worstSum = 0;
    if (weights) {
      for (let vertex = 0; vertex < weights.count; vertex += 17) {
        let sum = 0;
        for (let slot = 0; slot < 4; slot++) sum += weights.getComponent(vertex, slot);
        worstSum = Math.max(worstSum, Math.abs(1 - sum));
      }
    }
    return {
      rootName: visual.root.name,
      textured: visual.textured,
      carapaceName: visual.carapace.name,
      materialType: visual.carapace.constructor.name,
      hasColorNode: Boolean(visual.carapace.colorNode),
      uniforms: ['uAccent', 'uAggro', 'uFlash', 'uFreeze', 'uIcePhase', 'uState', 'uStateAmount'].filter(name => Boolean(visual.carapace[name])),
      skinned: Boolean(skinned),
      bones: skinned ? Array.from(new Set(skinned.skeleton.bones.map(bone => bone.name))) : [],
      vertices: geometry?.attributes.position.count ?? 0,
      worstSum,
      flashMats: visual.flashMats.length,
    };
  }, crawler.id);
  assert.equal(rig.rootName, 'crawler-imported');
  assert.ok(rig.textured, 'the crawler chitin must keep its painted texture');
  assert.equal(rig.carapaceName, 'crawler:chitin');
  assert.equal(rig.materialType, 'MeshBasicNodeMaterial');
  assert.ok(rig.hasColorNode, 'the chitin must shade through a node graph');
  assert.equal(rig.uniforms.length, 7, `carapace uniforms: ${rig.uniforms}`);
  assert.ok(rig.skinned, 'the crawler base model must be a SkinnedMesh');
  assert.equal(rig.flashMats, 1);
  for (const bone of ['Root', 'Spine', 'Chest', 'Neck', 'Head', 'Jaw', 'Tail1', 'Tail6', 'LegFL', 'LegFR', 'LegBL', 'LegBR']) {
    assert.ok(rig.bones.includes(bone), `the derived rig is missing ${bone}`);
  }
  assert.ok(rig.bones.length >= 20 && rig.vertices > 5000, JSON.stringify(rig));
  assert.ok(rig.worstSum < 0.01, `skin weights must be normalised (worst ${rig.worstSum})`);

  // The skeleton must MOVE under the gait, and the whole mesh must follow it.
  const animation = await page.evaluate(async id => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, enemy = game.enemies.byId(id), visual = enemy.imported;
    const skinned = visual.root.getObjectByProperty('isSkinnedMesh', true);
    const bone = name => skinned.skeleton.bones.find(candidate => candidate.name === name);
    const sample = () => {
      visual.root.updateWorldMatrix(true, true);
      skinned.skeleton.update();
      return {
        foot: bone('FootFR').getWorldPosition(new Vector3()).clone(),
        tail: bone('Tail6').getWorldPosition(new Vector3()).clone(),
        head: bone('Head').getWorldPosition(new Vector3()).clone(),
        clock: visual.clock,
      };
    };
    const start = sample();
    let foot = 0, tail = 0, head = 0;
    for (let step = 0; step < 8; step++) {
      for (let frame = 0; frame < 15; frame++) visual.update(1 / 60, 1, { flash: 0, frost: 0, stunned: false, enraged: false });
      const now = sample();
      foot = Math.max(foot, start.foot.distanceTo(now.foot));
      tail = Math.max(tail, start.tail.distanceTo(now.tail));
      head = Math.max(head, start.head.distanceTo(now.head));
    }
    return { moved: visual.clock > start.clock, foot, tail, head };
  }, crawler.id);
  assert.ok(animation.moved, 'the gait clock must advance');
  assert.ok(animation.foot > 0.05 && animation.tail > 0.02 && animation.head > 0.005, JSON.stringify(animation));

  // The SIMULATION must still own it: it hunts, and it takes damage, flashes, frosts and dies
  // like any other Necrophage. The hunt is observed on the first probe; the hit feedback is
  // checked on a FRESH body (the player's own auto-fire may well have killed the first one).
  const combat = await page.evaluate(async id => {
    const game = window.necrofall, enemy = game.enemies.byId(id), player = game.localPlayer;
    const distance = () => enemy.position.distanceTo(player.position);
    const before = distance();
    let closest = before, locked = false;
    for (let step = 0; step < 20; step++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      closest = Math.min(closest, distance());
      locked = locked || enemy.targetId === player.id;
    }
    return { closing: closest < before - 3, locked, before, closest };
  }, crawler.id);
  assert.ok(combat.closing && combat.locked, `a spawned crawler must hunt the player ${JSON.stringify(combat)}`);

  const damage = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, player = game.localPlayer;
    const genome = game.enemies.bestiary.genomes.find(candidate => candidate.species === 'crawler');
    // IN FRONT of the camera, and ELITE: named bodies are never recycled by the spawner, so the
    // probe survives the wait for its imported body.
    const forward = game.cam.camera.getWorldDirection(new Vector3());
    const position = player.position.clone().addScaledVector(forward, 18);
    game.planet.projectToSurface(position);
    const probe = game.enemies.spawn(genome.idx, position, { elite: true });
    probe.name = 'crawler-damage-probe';
    for (let turn = 0; turn < 200 && !probe.imported; turn++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!probe.imported) return { ready: false };
    // Drive the presentation pass by hand: it is the pass that writes hit feedback and the cryo
    // crust into the creature's own materials, so the check stays deterministic instead of racing
    // the manager's simulation tiers.
    probe.stealthed = false;
    probe.group.visible = true;
    const hpBefore = probe.hp;
    game.hitEnemy(probe, probe.hp * 0.25, player.id, 'test');
    const flashed = probe.flashAmt > 0;
    probe.place(1 / 60, game);
    const flash = probe.imported.carapace.uFlash.value;
    probe.frostT = 1;
    for (let frame = 0; frame < 14; frame++) probe.place(1 / 60, game);
    const frost = probe.imported.carapace.uFreeze.value;
    game.hitEnemy(probe, probe.maxHp * 4, player.id, 'test');
    return { ready: true, hpDropped: probe.hp < hpBefore, flashed, uniforms: { flash, frost }, alive: probe.alive };
  });
  assert.ok(damage.ready, 'a fresh crawler must build its imported body');
  assert.ok(damage.hpDropped && damage.flashed, JSON.stringify(damage));
  assert.ok(damage.uniforms.flash > 0.1 && damage.uniforms.frost > 0.1, JSON.stringify(damage));
  assert.equal(damage.alive, false, 'the imported body must die like any other enemy');

  // ---------------------------------------------------------------- Beacon Guardians
  // The four Beacon Guardians must field the imported bodies: they alternate between the two
  // models, so a match shows both — and every guardian is a real boss (stun pool, plate, roar).
  const guardians = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, player = game.localPlayer;
    const up = player.position.clone().normalize();
    const side = new Vector3(0, 1, 0).cross(up).normalize();
    const forward = up.clone().cross(side).normalize();
    const spawned = [];
    for (let towerIdx = 0; towerIdx < 4; towerIdx++) {
      const direction = side.clone().applyAxisAngle(up, towerIdx * 0.9);
      const position = player.position.clone().addScaledVector(direction, 22);
      game.planet.projectToSurface(position);
      const boss = game.enemies.spawnBoss(towerIdx, 'beacon', position);
      boss.name = `guardian-${towerIdx}`;
      spawned.push({ id: boss.id, genome: boss.genome.idx, species: boss.genome.species, tier: boss.genome.tier, isBoss: boss.isBoss, stun: boss.stunMax > 0 });
    }
    return spawned;
  });
  assert.equal(guardians.length, 4);
  assert.ok(guardians.every(guardian => guardian.tier === 'boss' && guardian.isBoss && guardian.stun), JSON.stringify(guardians));
  await page.waitForFunction(ids => ids.every(id => Boolean(window.necrofall.enemies.byId(id)?.imported)), guardians.map(guardian => guardian.id), { timeout: 60000 });
  const guardianModels = await page.evaluate(ids => ids.map(id => {
    const game = window.necrofall, enemy = game.enemies.byId(id);
    return { id, model: enemy.imported.root.name, radius: +enemy.radius.toFixed(2), tier: enemy.genome.tier, bones: enemy.imported.root.getObjectByProperty('isSkinnedMesh', true)?.skeleton.bones.length ?? 0 };
  }), guardians.map(guardian => guardian.id));
  const models = new Set(guardianModels.map(guardian => guardian.model));
  assert.ok(models.has('parasite-imported') && models.has('crawler-imported'), `both imported bodies must guard beacons: ${JSON.stringify(guardianModels)}`);
  assert.ok(guardianModels.every(guardian => guardian.bones > 15), JSON.stringify(guardianModels));

  const guardianShot = await focus(page, `game => game.enemies.enemies.find(enemy => enemy.name === 'guardian-0') ?? null`, { padding: 2.5 });
  assert.ok(guardianShot.ok, JSON.stringify(guardianShot));
  await capture(page, 'beacon-guardian-imported');
  // A/B capture: the same genome, once with the imported base model and once with the pooled
  // procedural rig it replaced — both parked on open ground, same light, same frame.
  const ab = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, player = game.localPlayer;
    const up = player.position.clone().normalize();
    const side = new Vector3(0, 1, 0).cross(up).normalize();
    const forward = up.clone().cross(side).normalize();
    let open = null;
    for (let step = 0; step < 40 && !open; step++) {
      const point = player.position.clone().addScaledVector(forward.clone().applyAxisAngle(up, step * 0.35), 70);
      game.planet.projectToSurface(point);
      if (!game.inSafeZone(point, 0)) open = point;
    }
    if (open) { player.position.copy(open); player.velocity.set(0, 0, 0); player.grounded = true; }
    const genome = game.enemies.bestiary.genomes.find(candidate => candidate.species === 'crawler');
    const ids = [];
    for (const offset of [-1.5, 1.5]) {
      const position = (open ?? player.position).clone().addScaledVector(forward, 12).addScaledVector(side, offset);
      game.planet.projectToSurface(position);
      // ELITE: named bodies are never recycled by the spawner, so the pair survives to the shot.
      const probe = game.enemies.spawn(genome.idx, position, { elite: true });
      probe.name = offset < 0 ? 'ab-imported' : 'ab-procedural';
      ids.push(probe.id);
    }
    return { ok: true, ids, openGround: Boolean(open) };
  });
  assert.ok(ab.openGround);
  await page.waitForFunction(ids => ids.every(id => Boolean(window.necrofall.enemies.byId(id)?.imported)), ab.ids, { timeout: 60000 });
  const reverted = await page.evaluate((ids) => {
    const game = window.necrofall;
    const procedural = game.enemies.byId(ids[1]);
    // Revert the second body to the rig it was built with, for the comparison shot.
    procedural.imported.root.visible = false;
    procedural.imported = null;
    for (const child of procedural.group.children) child.visible = true;
    return Boolean(procedural);
  }, ab.ids);
  assert.ok(reverted);
  const abShot = await focus(page, `game => game.enemies.enemies.find(enemy => enemy.name === 'ab-imported') ?? null`,
    { mid: `game => game.enemies.enemies.find(enemy => enemy.name === 'ab-procedural') ?? null`, padding: 4.5 });
  assert.ok(abShot.ok, JSON.stringify(abShot));
  await capture(page, 'crawler-base-model-ab');

  // ---------------------------------------------------------------- Mega Necrophage (parasite)
  await start(page, 719);
  const mega = await page.evaluate(() => {
    const game = window.necrofall;
    const enemy = game.enemies.spawnBoss(4, 'nexus', game.localPlayer.position.clone());
    return { id: enemy.id };
  });
  await page.waitForFunction(id => Boolean(window.necrofall.enemies.byId(id)?.imported), mega.id, { timeout: 60000 });

  const megaState = await page.evaluate(async id => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, enemy = game.enemies.byId(id), visual = enemy.imported;
    const skinned = visual.root.getObjectByProperty('isSkinnedMesh', true);
    const pelvis = visual.root.getObjectByName('Pelvis_72');
    const sample = () => {
      visual.root.updateWorldMatrix(true, true);
      visual.root.traverse(object => { if (object.isSkinnedMesh) object.skeleton.update(); });
      return visual.root.worldToLocal(pelvis.getWorldPosition(new Vector3())).clone();
    };
    const before = pelvis ? sample() : null, clock = visual.clock;
    for (let frame = 0; frame < 120; frame++) visual.update(1 / 60, 1, { flash: 0, frost: 0, stunned: false, enraged: false });
    const after = pelvis ? sample() : null;
    return {
      rootName: visual.root.name,
      skinned: Boolean(skinned),
      pelvis: Boolean(pelvis),
      separateMembrane: visual.energy !== visual.carapace,
      carapaceName: visual.carapace.name,
      energyName: visual.energy.name,
      moved: visual.clock > clock,
      drift: before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 1,
    };
  }, mega.id);
  assert.equal(megaState.rootName, 'parasite-imported');
  assert.ok(megaState.skinned && megaState.pelvis, JSON.stringify(megaState));
  assert.ok(megaState.separateMembrane, 'the insectoid rig ships a separate membrane surface');
  assert.equal(megaState.carapaceName, 'parasite:chitin');
  assert.equal(megaState.energyName, 'parasite:membrane');
  assert.ok(megaState.moved && megaState.drift < 1e-4, JSON.stringify(megaState));

  assert.deepEqual(errors, [], 'runtime errors');
  console.log(JSON.stringify({ crawler, rig: { ...rig, bones: rig.bones.length }, animation, combat, damage, megaState }, null, 2));
  console.log('PASS: crawler + Mega Necrophage base models rigged, animated and fighting in the main game');
} finally {
  await browser.close();
  await server.close();
}
