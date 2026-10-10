import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import sharp from 'sharp';

const server = await createServer({ cacheDir: '.test-shots/vite-main', server: { port: 5199, host: '127.0.0.1', watch: null, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const profiles = await server.ssrLoadModule('/src/planet/BasePlanetProfile.ts');
const seeds = new Map();
for (let seed = 1; seed < 1000; seed++) {
  const base = profiles.basePlanetForSeed(seed);
  if (!seeds.has(base.id)) seeds.set(base.id, seed);
  assert.deepEqual(profiles.basePlanetVariant(seed), profiles.basePlanetVariant(seed));
}
assert.equal(seeds.size, 10);
const selected = process.argv.find(value => value.startsWith('--planet='))?.split('=')[1];
const classicOnly = process.argv.includes('--classic');
const variantsOnly = process.argv.includes('--variants');
const cases = classicOnly || variantsOnly ? [] : [...seeds].filter(([id]) => !selected || id === selected);
assert.ok(classicOnly || variantsOnly || cases.length, 'Unknown base planet');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const reports = [];
const directory = '.test-shots/main-planets';
await mkdir(directory, { recursive: true });

async function capture(page, name, checkScene = true) {
  await page.waitForFunction(() => {
    const game = window.necrofall, bounds = game.renderer.domElement.getBoundingClientRect();
    return Math.abs(bounds.width - innerWidth) < 1 && Math.abs(bounds.height - innerHeight) < 1
      && Math.abs(game.cam.camera.aspect - innerWidth / innerHeight) < 0.001;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const style = await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas[data-main-test] { visibility: visible !important; }' });
  try {
    const image = await page.screenshot({ path: `${directory}/${name}.png` });
    const stats = await sharp(image).stats();
    if (checkScene) assert.ok(stats.channels.slice(0, 3).some(channel => channel.stdev > 8), `${name}: blank canvas`);
    return image;
  } finally { await style.evaluate(node => node.remove()); }
}

async function surfaceTrails(page) {
  const results = [];
  for (const effect of ['grass', 'water']) {
    const state = await page.evaluate(async effect => {
      const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
      const game = window.necrofall, world = game.envWorld, camera = game.cam.camera;
      game.update = () => {};
      game.ticker.update = () => game.rendering.render(0);
      const surface = world.deps.surface, sun = world.deps.system.sunDirection;
      const points = effect === 'water' ? world.puddles.sites.map(site => site.direction.clone().multiplyScalar(surface.radiusAt(site.direction)))
        : world.grass.sectorMeshes.flatMap(sector => {
          const positions = sector.mesh.geometry.attributes.position, samples = [];
          for (let index = 0; index < positions.count; index += 3000) samples.push(new Vector3().fromBufferAttribute(positions, index));
          return samples;
        });
      const point = points.filter(point => !world.rocks.blocked(point.x, point.y, point.z))
        .sort((first, second) => second.clone().normalize().dot(sun) - first.clone().normalize().dot(sun))[0];
      if (!point) throw new Error(`No clear ${effect} site`);
      const up = point.clone().normalize(), tangent = up.clone().cross(new Vector3(0, 1, 0)).normalize();
      point.setLength(surface.radiusAt(up));
      camera.position.copy(point).addScaledVector(up, 12).addScaledVector(tangent, 3);
      camera.up.copy(tangent); camera.lookAt(point); camera.updateMatrixWorld(true);
      const owner = effect === 'grass' ? world.grass : world.puddles;
      for (let index = 3; index < owner.trailData.length; index += 4) owner.trailData[index] = -1000;
      owner.trailTexture.needsUpdate = true;
      const previous = owner.trailCursor;
      world.deps.time.value = 100;
      let focus = point.clone();
      for (let step = 0; step <= (effect === 'grass' ? 12 : 0); step++) {
        focus = point.clone().addScaledVector(tangent, effect === 'grass' ? step * 0.5 - 2 : 0).normalize();
        focus.multiplyScalar(surface.radiusAt(focus));
        world.update(focus, camera);
      }
      const distance = focus.distanceTo(point);
      focus.addScaledVector(focus.clone().normalize(), 8);
      world.deps.time.value = 100.5;
      world.update(focus, camera);
      game.lighting.update(point);
      const fresh = Array.from(owner.trailData);
      window.surfaceTrailTest = { owner, fresh };
      for (let index = 3; index < owner.trailData.length; index += 4) owner.trailData[index] = -1000;
      owner.trailTexture.needsUpdate = true;
      return { samples: owner.trailCursor - previous, distance, depth: world.puddles.waterDepthAt(up) };
    }, effect);
    assert.ok(state.samples > 0, `${effect}: world updates did not stamp a trail`);
    if (effect === 'grass') assert.ok(state.distance > 2.4, 'Grass test must leave the old player clearing');
    else assert.ok(state.depth > 0.045 && state.depth <= 0.35);
    const before = await capture(page, `${effect}-trail-expired`);
    await page.evaluate(() => {
      const { owner, fresh } = window.surfaceTrailTest;
      owner.trailData.set(fresh); owner.trailTexture.needsUpdate = true;
    });
    const after = await capture(page, `${effect}-trail-fresh`);
    const original = await sharp(before).removeAlpha().raw().toBuffer();
    const changed = await sharp(after).removeAlpha().raw().toBuffer();
    let channels = 0, total = 0;
    for (let index = 0; index < original.length; index++) {
      const delta = Math.abs(original[index] - changed[index]);
      if (delta > 4) channels++;
      total += delta;
    }
    const mean = total / original.length;
    assert.ok(channels > 200 && mean > (effect === 'water' ? 0.001 : 0.005), `${effect}: trail not visible (${channels} channels, mean ${mean})`);
    await page.evaluate(() => {
      const { owner } = window.surfaceTrailTest;
      for (let index = 3; index < owner.trailData.length; index += 4) owner.trailData[index] = -1000;
      owner.trailTexture.needsUpdate = true;
    });
    const restored = await sharp(await capture(page, `${effect}-trail-restored`)).removeAlpha().raw().toBuffer();
    let residual = 0;
    for (let index = 0; index < original.length; index++) residual += Math.abs(original[index] - restored[index]);
    assert.ok(residual / original.length < mean * 0.1, `${effect}: unrelated animation contaminated the comparison`);
    results.push({ effect, ...state, channels, mean });
    console.log(`${effect}: live-world trail changes ${channels} pixel channels and restores when expired`);
  }
  return results;
}

async function coastalWater(page, name) {
  const state = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, world = game.envWorld, water = world.puddles, camera = game.cam.camera;
    const surface = world.deps.surface, seaLevel = world.deps.generator.terrain.seaLevel;
    const points = [];
    let seaSamples = 0;
    for (let sample = 0; sample < 4096; sample++) {
      const vertical = 1 - 2 * (sample + 0.5) / 4096, radial = Math.sqrt(1 - vertical * vertical), angle = sample * 2.399963229728653;
      const direction = new Vector3(radial * Math.cos(angle), vertical, radial * Math.sin(angle));
      const floor = surface.radiusAt(direction);
      if (floor < seaLevel) seaSamples++;
      if (seaLevel - floor > 0.2 && !world.rocks.blocked(direction.x, direction.y, direction.z)) points.push(direction);
    }
    points.sort((first, second) => second.dot(world.deps.system.sunDirection) - first.dot(world.deps.system.sunDirection));
    if (!points.length) throw new Error('No clear shallow sea');
    const up = points[0], point = up.clone().multiplyScalar(seaLevel), tangent = up.clone().cross(new Vector3(0, 1, 0)).normalize();
    window.coastalState = { update: game.update, tick: game.ticker.update, time: world.deps.time.value, position: camera.position.clone(), rotation: camera.quaternion.clone(), up: camera.up.clone() };
    game.update = () => {};
    game.ticker.update = () => game.rendering.render(0);
    camera.position.copy(point).addScaledVector(up, 12).addScaledVector(tangent, 16);
    camera.position.setLength(Math.max(camera.position.length(), surface.radiusAt(camera.position.clone().normalize()) + 7));
    camera.up.copy(up); camera.lookAt(point); camera.updateMatrixWorld(true);
    for (let index = 3; index < water.trailData.length; index += 4) water.trailData[index] = -1000;
    const before = water.trailCursor;
    for (let step = 0; step < 9; step++) {
      const foot = point.clone().addScaledVector(tangent, step * 0.85 - 3.4).normalize();
      foot.multiplyScalar(surface.radiusAt(foot));
      world.deps.time.value = 100 + step * 0.08; water.trackWalkerTrail('coastal-review', foot);
    }
    world.deps.time.value = 100.9;
    world.update(point.clone().addScaledVector(up, 8), camera); game.lighting.update(point);
    window.coastalState.fresh = Array.from(water.trailData);
    for (let index = 3; index < water.trailData.length; index += 4) water.trailData[index] = -1000;
    water.trailTexture.needsUpdate = true;
    return { coverage: seaSamples / 4096, samples: water.trailCursor - before, seaLevel };
  });
  assert.ok(state.coverage < (name === 'saffron-waste' ? 0.035 : 0.11), JSON.stringify(state));
  assert.ok(state.samples >= 4, 'Coastal review needs a moving wake');
  const before = await sharp(await capture(page, `${name}-coast-calm`)).removeAlpha().raw().toBuffer();
  await page.evaluate(() => {
    const water = window.necrofall.envWorld.puddles;
    water.trailData.set(window.coastalState.fresh); water.trailTexture.needsUpdate = true;
  });
  const after = await sharp(await capture(page, `${name}-coast-walking`)).removeAlpha().raw().toBuffer();
  let changedPixels = 0, peakChange = 0;
  for (let index = 0; index < before.length; index += 3) {
    const delta = Math.max(Math.abs(after[index] - before[index]), Math.abs(after[index + 1] - before[index + 1]), Math.abs(after[index + 2] - before[index + 2]));
    if (delta > 2) changedPixels++;
    peakChange = Math.max(peakChange, delta);
  }
  assert.ok(changedPixels > 30 && peakChange < 55, `Wake must be visible but restrained: ${changedPixels} pixels, peak ${peakChange}`);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); await capture(page, `${name}-coast-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const game = window.necrofall, saved = window.coastalState, camera = game.cam.camera;
    game.update = saved.update; game.ticker.update = saved.tick; game.envWorld.deps.time.value = saved.time;
    camera.position.copy(saved.position); camera.quaternion.copy(saved.rotation); camera.up.copy(saved.up); camera.updateMatrixWorld(true);
    const water = game.envWorld.puddles;
    for (let index = 3; index < water.trailData.length; index += 4) water.trailData[index] = -1000;
    water.trailTexture.needsUpdate = true;
  });
  console.log(`${name}: ${(state.coverage * 100).toFixed(1)}% coastal area, ${changedPixels} wake pixels, peak change ${peakChange}/255`);
  return { ...state, changedPixels, peakChange };
}

async function nightStars(page, name) {
  await inspect(page, 'night');
  await page.evaluate(() => {
    const game = window.necrofall, camera = game.cam.camera;
    window.nightStarState = { update: game.ticker.update, rotation: camera.quaternion.clone() };
    game.ticker.update = () => game.rendering.render(0);
    camera.lookAt(camera.position.clone().addScaledVector(game.localPlayer.position.clone().normalize(), 100));
    camera.updateMatrixWorld(true);
    game.envWorld.sky.stars.visible = false;
  });
  const before = await sharp(await capture(page, `${name}-stars-off`, false)).removeAlpha().raw().toBuffer();
  await page.evaluate(() => { window.necrofall.envWorld.sky.stars.visible = true; });
  const after = await sharp(await capture(page, `${name}-stars-on`, false)).removeAlpha().raw().toBuffer();
  let visiblePixels = 0;
  for (let index = 0; index < before.length; index += 3) {
    if (Math.max(after[index] - before[index], after[index + 1] - before[index + 1], after[index + 2] - before[index + 2]) > 25) visiblePixels++;
  }
  assert.ok(visiblePixels > 60, `${name}: stars not visibly rendered (${visiblePixels} pixels)`);
  await page.evaluate(() => {
    const game = window.necrofall;
    game.ticker.update = window.nightStarState.update;
    game.cam.camera.quaternion.copy(window.nightStarState.rotation); game.cam.camera.updateMatrixWorld(true);
  });
  console.log(`${name}: ${visiblePixels} visible night-star pixels`);
  return visiblePixels;
}

async function hazardInteractions(page) {
  const results = [];
  for (const kind of ['quicksand', 'vortex']) {
    const result = await page.evaluate(kind => {
      const game = window.necrofall, world = game.envWorld, player = game.localPlayer, camera = game.cam.camera;
      window.hazardTick = game.ticker.update; game.ticker.update = () => game.rendering.render(0);
      const hazards = world.ecology.hazards;
      const site = hazards.sites.filter(site => site.kind === kind)
        .sort((first, second) => second.position.clone().normalize().dot(world.deps.system.sunDirection) - first.position.clone().normalize().dot(world.deps.system.sunDirection))[0];
      if (!site) throw new Error(`No ${kind} site`);
      const up = site.position.clone().normalize(), across = up.clone().cross({ x: 0, y: 1, z: 0 }).normalize();
      const reset = () => {
        player.position.copy(site.position); player.up.copy(up); player.velocity.set(0, 0, 0);
        player.grounded = true; player.momentum = 0; player.jumpLock = 0; player.recallHold = false;
      };
      let slowRatio = 1;
      if (kind === 'quicksand') {
        game.input.moveY = 1; game.input.moveX = 0;
        const originalApply = hazards.apply;
        const run = () => { reset(); for (let frame = 0; frame < 30; frame++) player.updateLocal(1 / 60); return player.position.distanceTo(site.position); };
        try {
          hazards.apply = () => 1; const normalDistance = run(); hazards.apply = originalApply;
          slowRatio = run() / normalDistance;
        } finally { hazards.apply = originalApply; game.input.moveY = 0; }
      }
      reset(); player.updateLocal(1 / 60);
      const vertical = player.velocity.dot(up), sideways = player.velocity.clone().addScaledVector(up, -vertical).length();
      camera.position.copy(site.position).addScaledVector(up, kind === 'vortex' ? 16 : 19).addScaledVector(across, kind === 'vortex' ? 42 : 20);
      camera.up.copy(up); camera.lookAt(site.position.clone().addScaledVector(up, kind === 'vortex' ? 12 : 0)); camera.updateMatrixWorld(true);
      world.update(site.position, camera); game.lighting.update(site.position);
      return { kind, radius: site.radius, height: site.height, slowRatio, vertical, sideways, grounded: player.grounded };
    }, kind);
    if (kind === 'quicksand') assert.ok(result.slowRatio > 0 && result.slowRatio < 0.7, JSON.stringify(result));
    else assert.ok(!result.grounded && result.vertical > 25 && result.sideways > 20 && result.height > 25, JSON.stringify(result));
    const before = await capture(page, `hazard-${kind}-desktop`);
    await page.evaluate(() => { window.necrofall.envWorld.deps.time.value += 1; });
    const after = await capture(page, `hazard-${kind}-animated`);
    assert.notDeepEqual(before, after, `${kind}: animation is frozen`);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); await capture(page, `hazard-${kind}-${viewport.width}`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { window.necrofall.ticker.update = window.hazardTick; });
    results.push(result);
  }
  console.log(`Player hazard interactions: ${JSON.stringify(results)}`);
  return results;
}

async function inspect(page, mode) {
  const light = await page.evaluate(async mode => {
    const { daylightAt, twilightAt } = await import('/src/rendering/Environment/Daylight.ts');
    const game = window.necrofall, world = game.envWorld, camera = game.cam.camera;
    game.cam.update = () => {};
    const direction = world.deps.system.sunDirection.clone();
    const tangent = direction.clone().cross({ x: 0, y: 1, z: 0 }).normalize();
    if (mode === 'orbit') {
      camera.position.copy(direction).multiplyScalar(game.planet.radius * 2.9).addScaledVector(tangent, game.planet.radius * 1.2);
      camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
    } else {
      const random = world.deps.generator.rand(0x3478), surface = world.deps.surface;
      let best = null, score = -Infinity;
      for (let candidate = 0; candidate < 1800; candidate++) {
        const sample = surface.randomSample(random);
        const elevation = sample.up.dot(direction), day = daylightAt(elevation);
        const suitable = mode === 'night' ? day < 0.05 : mode === 'twilight' ? Math.abs(elevation) < 0.035 : day > 0.95;
        if (!suitable || sample.radius < surface.waterLevel + 1 || world.rocks.blocked(sample.up.x, sample.up.y, sample.up.z)) continue;
        const value = sample.radiation * 2 + sample.grass - sample.slope;
        if (value > score) { score = value; best = sample.point.clone(); }
      }
      if (!best) throw new Error(`No clear ${mode} surface site`);
      const up = best.clone().normalize(), across = up.clone().cross({ x: 0, y: 1, z: 0 }).normalize();
      game.localPlayer.position.copy(best); game.localPlayer.velocity.set(0, 0, 0);
      camera.position.copy(best).addScaledVector(up, 7).addScaledVector(across, 18);
      const cameraDirection = camera.position.clone().normalize();
      const cameraFloor = surface.radiusAt(cameraDirection);
      camera.position.setLength(Math.max(camera.position.length(), cameraFloor + (world.rocks.blocked(cameraDirection.x, cameraDirection.y, cameraDirection.z) ? 38 : 12)));
      camera.up.copy(up); camera.lookAt(best.clone().addScaledVector(up, 2));
      if (mode === 'twilight') {
        const horizon = direction.clone().addScaledVector(up, -up.dot(direction)).normalize();
        camera.lookAt(camera.position.clone().addScaledVector(horizon, 80).addScaledVector(up, -8));
      }
    }
    camera.updateMatrixWorld(true);
    world.update(game.localPlayer.position, camera);
    game.lighting.update(game.localPlayer.position);
    const elevation = game.localPlayer.position.clone().normalize().dot(direction);
    return { day: world.sky.day.value, sun: game.lighting.light.intensity, elevation, twilight: twilightAt(elevation) };
  }, mode);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return light;
}

async function start(page, seed, mode, query = '') {
  await page.goto(`${url}${query}`);
  await page.waitForFunction(() => Boolean(window.necrofallShell), {}, { timeout: 60000 }).catch(async error => {
    console.error('Bootstrap failure', await page.locator('body').innerText()); throw error;
  });
  await page.evaluate(({ seed, mode }) => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    game.renderer.domElement.dataset.mainTest = 'true';
    shell.soloRunActive = mode === 'freeroam';
    if (mode === 'freeroam') shell.lastSoloMode = 'freeroam';
    shell.hideShell(true);
    if (mode === 'freeroam') {
      game.startSoloRun({ mode, planetKey: '', ring: 0, universeSeed: seed, seed, colony: 0 });
    } else {
      game.net.goSolo();
      const id = game.net.myId;
      game.roster.clear();
      game.roster.set(id, { id, name: 'Integration test', ready: true, colony: 0, nt: 0, isHost: true, me: true });
      game.hostOrder = [id];
      game.beginPlaying({ [id]: 0 }, seed);
    }
  }, { seed, mode });
  await page.waitForFunction(() => {
    const game = window.necrofall;
    return game?.phase === 'playing' && game.envWorld?.ecology && game.envWorld.deps.generator.seed === game.planet.seed;
  }, {}, { timeout: 60000 });
}

try {
  for (const [id, seed] of cases) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    page.on('console', message => { if (message.type() === 'error' && !/404|favicon|auth-proxy/.test(message.text())) errors.push(message.text()); });
    try {
      await start(page, seed, 'freeroam');
      const data = await page.evaluate(() => {
        const game = window.necrofall, world = game.envWorld;
        return { seed: game.planet.seed, base: game.planet.archetype.basePlanetId, phase: game.phase,
          features: world.ecology.features, stats: world.stats, system: world.sky.mesh.userData.system,
          enemies: game.enemies.enemies.length, frameErrors: game.frameErrors, water: world.puddles.mesh.userData,
          sun: world.deps.system.sunDirection.toArray(), direction: game.lighting.directionUniform.value.toArray(),
          player: game.localPlayer.position.toArray(), radius: game.planet.radius };
      });
      assert.equal(data.base, id);
      assert.equal(data.enemies, 0);
      assert.equal(data.frameErrors, 0);
      assert.equal(data.features.length, id === 'saffron-waste' ? 4 : 3);
      assert.ok(data.features.every(feature => feature.count > 0), `${id}: missing feature placement`);
      assert.equal(data.system.activeSeed, seed);
      assert.ok(data.sun.every((value, index) => Math.abs(value - data.direction[index]) < 1e-10));
      assert.ok(data.system.neighbours.length > 0);
      await capture(page, `${id}-freeroam`);
      await page.keyboard.down('w');
      await page.waitForFunction(previous => window.necrofall.localPlayer.position.distanceTo({ x: previous[0], y: previous[1], z: previous[2] }) > 1, data.player, { timeout: 15000 });
      await page.keyboard.up('w');
      const afterSun = await page.evaluate(() => window.necrofall.lighting.directionUniform.value.toArray());
      assert.ok(data.sun.every((value, index) => Math.abs(value - afterSun[index]) < 1e-10));
      await inspect(page, 'orbit');
      await capture(page, `${id}-whole-planet`);
      const daylight = await inspect(page, 'day');
      assert.ok(daylight.day > 0.9 && daylight.sun > 1);
      await capture(page, `${id}-day`);
      const twilight = await inspect(page, 'twilight');
      assert.ok(twilight.day > 0.3 && twilight.day < 0.5 && twilight.twilight > 0.95, JSON.stringify(twilight));
      assert.ok(twilight.sun > 0.1 && twilight.sun < daylight.sun, JSON.stringify(twilight));
      await capture(page, `${id}-twilight`);
      const night = await inspect(page, 'night');
      assert.ok(night.day < 0.1 && night.sun < 0.1);
      await capture(page, `${id}-night`);
      const starPixels = await nightStars(page, id);
      const hazards = id === 'saffron-waste' ? await hazardInteractions(page) : undefined;
      const coast = ['saffron-waste', 'glass-tide', 'cinderbloom'].includes(id) ? await coastalWater(page, id) : undefined;
      const trails = id === 'cinderbloom' ? await surfaceTrails(page) : undefined;
      reports.push({ id, seed, ...data, daylight, twilight, night, trails, starPixels, hazards, coast });
      console.log(`${id}: freeroam, movement, base recipes, fixed sun and twilight passed`);
      assert.deepEqual(errors, [], `${id}: runtime errors`);
    } catch (error) {
      await capture(page, `${id}-failure`).catch(() => {});
      console.error(JSON.stringify({ id, errors, state: await page.evaluate(() => ({ phase: window.necrofall?.phase, planetSeed: window.necrofall?.planet?.seed, worldSeed: window.necrofall?.envWorld?.deps?.generator?.seed, elapsed: window.necrofall?.matchElapsed, host: window.necrofall?.isHost, frameErrors: window.necrofall?.frameErrors, text: document.body.innerText.slice(-1200) })) }, null, 2));
      throw error;
    } finally { await page.close(); }
  }
  if (!selected && !variantsOnly) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.stack); console.error(error.stack); });
    page.on('console', message => { if (message.type() === 'error' && !/404|favicon|auth-proxy/.test(message.text())) errors.push(message.text()); });
    await start(page, 719, 'classic');
    const interactions = await page.evaluate(() => {
      const game = window.necrofall, player = game.localPlayer;
      const pads = game.pads.pads;
      const jump = pads.find(pad => pad.kind === 'jump'), blitz = pads.find(pad => pad.kind === 'blitz');
      player.position.copy(jump.position); player.grounded = true; game.pads.update(1 / 60);
      const launched = !player.grounded;
      player.position.copy(blitz.position); player.grounded = true; game.pads.update(1 / 60);
      const blitzActive = player.blitzT > 0; player.endBlitz(false);
      const base = game.bases.bases[0]; player.position.copy(base.ground);
      const healing = game.bases.healPad(player), protectedGround = game.bases.contains(player.position);
      const previous = base.center.clone(), ground = base.ground.clone();
      game.bases.update(1, game.matchElapsed + 1);
      return { launched, blitzActive, healing, protectedGround, fortressMoved: base.center.distanceTo(previous) > 0, groundStayed: base.ground.equals(ground), bases: game.bases.bases.length };
    });
    assert.ok(Object.entries(interactions).every(([key, value]) => key === 'bases' ? value === 3 : value), JSON.stringify(interactions));
    await inspect(page, 'day');
    const state = await page.evaluate(() => {
      const game = window.necrofall;
      const position = game.localPlayer.position.clone();
      const mega = game.enemies.spawnBoss(4, 'nexus', position);
      return { mega: mega.id, radius: mega.radius, hp: mega.hp, freeroam: game.freeroamMode,
        towers: game.towers.towers.map(tower => ({ kind: tower.kind, state: tower.state })),
        // Imported bodies are owned by the Nexus Overseer (parasite), the Beacon Guardians
        // (alternating parasite / crawler) and crawler-species Necrophages (crawler) — nothing
        // else may pick one up.
        otherImported: game.enemies.enemies.filter(enemy => {
          const model = enemy.imported?.root.name;
          if (!model) return false;
          const guardian = enemy.genome.tier === 'boss';
          return model === 'parasite-imported'
            ? enemy.genome.tier !== 'nexus' && !guardian
            : enemy.genome.species !== 'crawler' && !guardian;
        }).length };
    });
    assert.equal(state.freeroam, false);
    assert.equal(state.towers.length, 5);
    assert.equal(state.otherImported, 0);
    await page.waitForFunction(id => Boolean(window.necrofall.enemies.byId(id)?.imported), state.mega, { timeout: 60000 });
    const animation = await page.evaluate(async id => {
      const { Box3, Vector3, Ray, DoubleSide } = await import('/node_modules/three/build/three.webgpu.js');
      const game = window.necrofall, enemy = game.enemies.byId(id), visual = enemy.imported;
      game.enemies.update = () => {};
      const sample = () => {
        visual.root.updateWorldMatrix(true, true);
        visual.root.traverse(object => { if (object.isSkinnedMesh) object.skeleton.update(); });
        return visual.root.worldToLocal(visual.root.getObjectByName('Pelvis_72').getWorldPosition(new Vector3()));
      };
      const before = sample(), clock = visual.clock;
      for (let frame = 0; frame < 120; frame++) visual.update(1 / 60, 1, { flash: 0, frost: 0, stunned: false, enraged: false });
      const after = sample(), bounds = new Box3().setFromObject(visual.root, true), size = bounds.getSize(new Vector3());
      const up = enemy.position.clone().normalize(), across = up.clone().cross({ x: 0, y: 1, z: 0 }).normalize();
      const camera = game.cam.camera, target = bounds.getCenter(new Vector3());
      const distance = size.length() * 0.65 / Math.tan(camera.fov * Math.PI / 360);
      let clearView = false;
      for (const elevation of [0.35, 0.7, 1.2]) {
        for (let angle = 0; angle < 24; angle++) {
          const offset = across.clone().applyAxisAngle(up, angle * Math.PI / 12).addScaledVector(up, elevation).normalize();
          const candidate = target.clone().addScaledVector(offset, distance);
          const ray = new Ray(candidate, target.clone().sub(candidate).normalize());
          const hit = game.envWorld.obstacles.meshTree.raycastFirst(ray, DoubleSide, 0, distance);
          if (hit) continue;
          camera.position.copy(candidate); clearView = true; break;
        }
        if (clearView) break;
      }
      camera.up.copy(up); camera.lookAt(target); camera.updateMatrixWorld(true);
      return { moved: visual.clock > clock, rootDrift: Math.hypot(after.x - before.x, after.z - before.z), size: size.toArray(), radius: enemy.radius, clearView };
    }, state.mega);
    assert.ok(animation.moved && animation.rootDrift < 1e-4, JSON.stringify(animation));
    assert.ok(animation.clearView, 'Mega capture must have a clear line of sight');
    assert.equal(animation.radius, state.radius);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await capture(page, 'classic-mega');
    const pooled = await page.evaluate(id => {
      const game = window.necrofall, enemy = game.enemies.byId(id), visual = enemy.imported, position = enemy.position.clone();
      game.enemies.removeVisual(id);
      const next = game.enemies.spawnBoss(4, 'nexus', position);
      return next.imported === visual && next.alive && next.group.visible && next.hp > 0;
    }, state.mega);
    assert.ok(pooled);
    const replacement = await page.evaluate(async () => {
      const { ImportedVisual } = await import('/src/enemies/imported/ImportedVisual.ts');
      const { Group } = await import('/node_modules/three/build/three.webgpu.js');
      const game = window.necrofall, enemy = game.enemies.enemies.find(enemy => enemy.genome.tier === 'nexus' && enemy.alive);
      game.update = () => {};
      const original = ImportedVisual.create, pending = [];
      let staleDisposed = false;
      ImportedVisual.create = () => new Promise(resolve => pending.push(resolve));
      try {
        enemy.setGenome({ ...enemy.genome }); enemy.ensureImportedVisual();
        enemy.setGenome({ ...enemy.genome }); enemy.ensureImportedVisual();
        const fresh = { root: new Group(), dispose() {} };
        pending[0]({ root: new Group(), dispose() { staleDisposed = true; } });
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        const stillLoading = enemy.importedLoading === enemy.group;
        pending[1]?.(fresh);
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        return { requests: pending.length, staleDisposed, stillLoading, attached: enemy.imported === fresh && fresh.root.parent === enemy.group, cleared: enemy.importedLoading === null };
      } finally { ImportedVisual.create = original; }
    });
    assert.equal(replacement.requests, 2);
    assert.ok(replacement.staleDisposed && replacement.stillLoading && replacement.attached && replacement.cleared, JSON.stringify(replacement));
    const seedPaths = await page.evaluate(async () => {
      const { basePlanetIndex, classicPlanetSeed } = await import('/src/planet/BasePlanetProfile.ts');
      const game = window.necrofall, original = Math.random, seeds = [];
      game.startMatchWhenReady = (_chosen, seed) => seeds.push(seed);
      game.broadcastPhase = () => {};
      try {
        Math.random = () => 0;
        game.lastClassicPlanetSeed = classicPlanetSeed(0); game.pendingMatchSeed = -1;
        game.finalizeNecrotechPhase();
        game.pendingMatchSeed = 719; game.finalizeNecrotechPhase();
        game.soloRun = { seed: 23 }; game.finalizeNecrotechPhase();
        return { fallbackChanged: basePlanetIndex(classicPlanetSeed(seeds[0])) !== basePlanetIndex(classicPlanetSeed(0)), locked: seeds[1], solo: seeds[2] };
      } finally { Math.random = original; }
    });
    assert.ok(seedPaths.fallbackChanged); assert.equal(seedPaths.locked, 719); assert.equal(seedPaths.solo, 23);
    assert.deepEqual(errors, []);
    reports.push({ mode: 'classic', ...state, interactions, animation, pooled, replacement, seedPaths });
    console.log('classic: towers, pads, healing, shields, fortress motion, animated Mega, pool reuse, pending-load replacement and seed paths passed');
    await page.close();
  }
  if (!selected && !classicOnly) {
    for (const variant of [
      { name: 'mobile', id: 'mycelial-night', viewport: { width: 390, height: 844 }, query: '', hasTouch: true },
      { name: 'webgl', id: 'frostwound', viewport: { width: 1280, height: 800 }, query: '?backend=webgl', hasTouch: false },
    ]) {
      const page = await browser.newPage({ viewport: variant.viewport, hasTouch: variant.hasTouch });
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack));
      page.on('console', message => { if (message.type() === 'error' && !/404|favicon|auth-proxy/.test(message.text())) errors.push(message.text()); });
      await start(page, seeds.get(variant.id), 'freeroam', variant.query);
      await inspect(page, 'day'); await capture(page, `${variant.name}-day`);
      await inspect(page, 'twilight'); await capture(page, `${variant.name}-twilight`);
      await nightStars(page, variant.name);
      await inspect(page, 'orbit'); await capture(page, `${variant.name}-whole-planet`);
      if (variant.name === 'mobile') {
        await page.setViewportSize({ width: 844, height: 390 });
        await inspect(page, 'day'); await capture(page, 'mobile-landscape');
      }
      const backend = await page.evaluate(() => window.necrofall.rendering.backend);
      if (variant.name === 'webgl') assert.equal(backend, 'webgl');
      assert.deepEqual(errors, [], variant.name);
      reports.push({ variant: variant.name, base: variant.id, backend });
      console.log(`${variant.name}: nonblank surface and whole-planet views passed`);
      await page.close();
    }
  }
  await writeFile(`${directory}/report.json`, JSON.stringify(reports, null, 2));
  console.log(`PASS: ${reports.length} main-game scenarios`);
} finally {
  await browser.close();
  await server.close();
}