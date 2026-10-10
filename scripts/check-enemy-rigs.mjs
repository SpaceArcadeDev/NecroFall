import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const server = await createServer({ cacheDir: '.test-shots/vite-rigs', server: { host: '127.0.0.1', port: 5203, watch: null, hmr: false } });
await server.listen();
const directory = '.test-shots/enemy-lab';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const results = [];
const changedPixels = async (first, second) => {
  const before = await sharp(first).removeAlpha().raw().toBuffer();
  const after = await sharp(second).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let offset = 0; offset < before.length; offset += 3) if (Math.abs(before[offset] - after[offset]) + Math.abs(before[offset + 1] - after[offset + 1]) + Math.abs(before[offset + 2] - after[offset + 2]) > 25) changed++;
  return changed;
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}?enemyLab=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.enemyLab?.visual?.clock > 0.3, {}, { timeout: 60000 });
  const slopeMovement = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.webgpu.js');
    const { Enemy } = await import('/src/enemies/Enemies.ts');
    const { PlanetObstacles } = await import('/src/planet/PlanetObstacles.ts');
    const { generateEcology, factsFromSeed } = await import('/src/enemies/procedural/EcologyGenerator.ts');
    const obstacles = new PlanetObstacles(100);
    const gradient = Math.tan(Math.PI / 3);
    const slope = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2)
      .rotateZ(Math.PI / 3).translate(0, 100, 0), new THREE.MeshBasicMaterial());
    obstacles.addMesh(slope); obstacles.build();
    const enemy = Object.create(Enemy.prototype);
    Object.assign(enemy, { position: new THREE.Vector3(-2, 100 - gradient * 2, 0), velocity: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0), airH: 0, flyAlt: 0, radius: 0.6, meshHint: -1,
      genome: generateEcology(774, factsFromSeed(774, 2)).genomes[1] });
    const game = { envWorld: { obstacles }, planet: { meshTriHint: -1,
      meshHeightAtDir: (axisX, axisY) => 100 / (axisY - gradient * axisX) } };
    let worstSupportGap = 0;
    for (let frame = 0; frame < 120; frame++) {
      enemy.velocity.set(1, 0, 0);
      enemy.rideTerrain(game, 1 / 60);
      const supported = obstacles.supportRadius(enemy.position, 1.5, enemy.radius * 0.65);
      worstSupportGap = Math.max(worstSupportGap, Math.abs(supported - enemy.position.length()));
    }
    const result = { worstSupportGap, progress: enemy.position.x + 2, airHeight: enemy.airH };
    obstacles.dispose(); slope.geometry.dispose(); slope.material.dispose();
    return result;
  });
  assert.ok(slopeMovement.worstSupportGap < 0.02, `Enemy repeatedly loses capsule support: ${JSON.stringify(slopeMovement)}`);
  assert.ok(slopeMovement.progress > 1.5 && slopeMovement.airHeight === 0, `Enemy stuck climbing: ${JSON.stringify(slopeMovement)}`);
  results.push({ slopeMovement });
  const obstacleMovement = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.webgpu.js');
    const { Enemy } = await import('/src/enemies/Enemies.ts');
    const { PlanetObstacles } = await import('/src/planet/PlanetObstacles.ts');
    const { generateEcology, factsFromSeed } = await import('/src/enemies/procedural/EcologyGenerator.ts');
    const obstacles = new PlanetObstacles(100);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 6).translate(0, 102.5, 0), new THREE.MeshBasicMaterial());
    obstacles.addMesh(wall); obstacles.build();
    const genome = generateEcology(774, factsFromSeed(774, 2)).genomes[1];
    const runs = [];
    for (const hunter of [false, true]) for (const rate of [30, 60, 120]) {
      const enemy = new Enemy();
      enemy.genome = { ...genome, abilities: [], hunter, hunt: hunter ? { leapRange: 0 } : undefined, swarm: undefined,
        ranged: false, projKind: 'none', attackRange: 0.5, speed: 5,
        behavior: { ...genome.behavior, chaseSpeedMul: 1 } };
      enemy.position.set(-7, 100, 0); enemy.up.copy(enemy.position).normalize();
      enemy.radius = 0.6; enemy.thinkT = 1000; enemy.attackCd = 1000;
      enemy.bTarget = { alive: true, id: 'pursuit-target', position: new THREE.Vector3(7, 100, 0) };
      const game = { clock: 0, isHost: false, nearestFrozenPlayer: () => null,
        nearestPlayer: () => enemy.bTarget,
        enemies: { query: () => [], scratch: () => [] }, envWorld: { obstacles },
        planet: { meshTriHint: -1, meshHeightAtDir: (axisX, axisY) => 100 / axisY } };
      let maxSide = 0, maxPenetration = 0;
      for (let frame = 0; frame < rate * 12 && enemy.position.x < 4; frame++) {
        game.clock += 1 / rate; enemy.update(1 / rate, game);
        maxSide = Math.max(maxSide, Math.abs(enemy.position.z));
        const resolved = enemy.position.clone(); obstacles.resolve(resolved, enemy.radius * 0.65);
        maxPenetration = Math.max(maxPenetration, resolved.distanceTo(enemy.position));
      }
      runs.push({ hunter, rate, forward: enemy.position.x, maxSide, maxPenetration });
    }
    obstacles.dispose(); wall.geometry.dispose(); wall.material.dispose();
    return runs;
  });
  for (const run of obstacleMovement) {
    assert.ok(run.forward > 4 && run.maxSide > 3, `Enemy stuck against obstacle: ${JSON.stringify(run)}`);
    assert.ok(run.maxPenetration < 0.02, `Enemy clips through obstacle: ${JSON.stringify(run)}`);
  }
  results.push({ obstacleMovement });
  const runningContacts = await page.evaluate(async () => {
    const lab = window.enemyLab;
    lab.renderer.setAnimationLoop(null);
    const runs = [];
    for (const base of ['crawler', 'parasite', 'behemoth']) for (const rate of [30, 60, 120]) {
      await lab.setAnatomy({ ...lab.anatomy, base, headBase: base, armBase: base, tailBase: base,
        body: 1, head: 1, limbs: 1, tail: 1, size: 2, wings: false });
      const root = lab.visual.root;
      root.position.set(0, 100, 0); root.quaternion.identity();
      const motion = { ground: (point, up, reach, out) => { out.copy(point).setY(100); return true; } };
      let maxError = 0;
      for (let frame = 0; frame < rate * 3; frame++) {
        root.position.z += 7 / rate;
        lab.visual.locomotion.update(1 / rate, false, motion);
        if (frame > rate / 2) maxError = Math.max(maxError, ...lab.visual.locomotion.diagnostics().feet.map(foot => foot.error));
      }
      runs.push({ base, rate, maxError, steps: lab.visual.locomotion.steps });
    }
    return runs;
  });
  for (const run of runningContacts) assert.ok(run.maxError < 0.6, `Running feet lag behind body: ${JSON.stringify(run)}`);
  results.push({ runningContacts });
  const rules = await page.evaluate(async () => {
    const { generateEcology, factsFromSeed } = await import('/src/enemies/procedural/EcologyGenerator.ts');
    const { capabilities, legalAttacks } = await import('/src/enemies/imported/EnemyAnatomy.ts');
    let count = 0;
    const overseers = new Set();
    for (let seed = 1; seed <= 90; seed++) {
      const world = generateEcology(seed, factsFromSeed(seed, seed % 8));
      if (JSON.stringify(world) !== JSON.stringify(generateEcology(seed, factsFromSeed(seed, seed % 8)))) throw new Error('Nondeterministic genome');
      overseers.add(world.genomes[world.nexusIdx].anatomy.base);
      for (const genome of world.genomes) {
        const body = capabilities(genome.anatomy, ['boss', 'nexus'].includes(genome.tier));
        if (!body.canLeap && (genome.abilities.includes('leap') || genome.hunt || genome.bossHeavy?.includes('rageleap'))) throw new Error('Illegal leap');
        if (!body.canFly && genome.locomotion === 'FLYER') throw new Error('Wingless flight');
        if (!body.canSpit && genome.ranged) throw new Error('Missing ranged organ');
        if (!legalAttacks(genome.anatomy, body.heavy).includes(genome.anatomy.attack)) throw new Error('Illegal anatomical attack');
        count++;
      }
    }
    return { count, overseers: [...overseers] };
  });
  assert.equal(rules.overseers.length, 3);
  results.push(rules);

  for (const base of ['crawler', 'parasite', 'behemoth']) {
    for (const course of ['flat', 'hills', 'boulders']) {
      await page.selectOption('#el-terrain', course);
      const result = await page.evaluate(async ({ base, course }) => {
        const lab = window.enemyLab;
        lab.renderer.setAnimationLoop(null);
        document.querySelector('#el-speed').value = '0.7';
        await lab.setAnatomy({ base, headBase: base, armBase: base, tailBase: base,
          body: 1, head: 1, limbs: 1, tail: 1, wings: base === 'parasite', size: 2,
          color: 0xa7c397, accent: 0xcced72, attack: base === 'crawler' ? 'bite' : 'claw' });
        for (let frame = 0; frame < 360; frame++) lab.tick(1 / 60);
        const moving = lab.visual.locomotion.diagnostics();
        document.querySelector('#el-speed').value = '0';
        for (let frame = 0; frame < 90; frame++) lab.tick(1 / 60);
        const idle = lab.visual.locomotion.diagnostics();
        for (let frame = 0; frame < 90; frame++) lab.tick(1 / 60);
        const settled = lab.visual.locomotion.diagnostics();
        document.querySelector('#el-stunned').checked = true;
        const clock = lab.visual.clock;
        for (let frame = 0; frame < 30; frame++) lab.tick(1 / 60);
        const frozen = lab.visual.clock === clock;
        document.querySelector('#el-stunned').checked = false;
        lab.tick(1 / 60);
        return { base, course, moving, settled, idleSteps: idle.steps, frozen,
          drift: Math.max(...idle.feet.map((foot, index) => Math.hypot(...foot.contact.map((value, axis) => value - settled.feet[index].contact[axis])))) };
      }, { base, course });
      assert.ok(result.moving.steps > 4, `${base}/${course}: no steps`);
      assert.ok(result.moving.feet.every(foot => Number.isFinite(foot.error) && foot.error < 0.6), `${base}/${course}: unreachable contacts ${JSON.stringify(result.moving)}`);
      assert.equal(result.settled.steps, result.idleSteps, `${base}/${course}: idle stepping`);
      assert.ok(result.drift < 1e-5, `${base}/${course}: foot sliding at rest`);
      assert.ok(result.frozen, `${base}: stun did not freeze rig`);
      results.push(result);
    }
    await page.click('#el-frame');
    await page.evaluate(() => { document.querySelector('.enemy-lab aside').scrollTop = 0; document.querySelector('.enemy-lab aside').scrollLeft = 0; });
    await page.evaluate(() => window.enemyLab.renderer.render(window.enemyLab.scene, window.enemyLab.camera));
    await page.screenshot({ path: `${directory}/${base}-desktop.png` });
    const visible = await page.screenshot();
    await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = false; lab.renderer.render(lab.scene, lab.camera); });
    const hidden = await page.screenshot();
    const first = await sharp(visible).removeAlpha().raw().toBuffer();
    const second = await sharp(hidden).removeAlpha().raw().toBuffer();
    let pixels = 0;
    for (let offset = 0; offset < first.length; offset += 3) if (Math.abs(first[offset] - second[offset]) + Math.abs(first[offset + 1] - second[offset + 1]) + Math.abs(first[offset + 2] - second[offset + 2]) > 25) pixels++;
    assert.ok(pixels > 1500, `${base}: missing or occluded model (${pixels} pixels)`);
    await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = true; lab.renderer.render(lab.scene, lab.camera); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#el-frame');
    await page.evaluate(() => { document.querySelector('.enemy-lab aside').scrollTop = 0; document.querySelector('.enemy-lab aside').scrollLeft = 0; });
    await page.evaluate(() => window.enemyLab.renderer.render(window.enemyLab.scene, window.enemyLab.camera));
    await page.screenshot({ path: `${directory}/${base}-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  const hybrids = await page.evaluate(async () => {
    const lab = window.enemyLab;
    const output = [];
    for (const base of ['crawler', 'parasite', 'behemoth']) {
      await lab.setAnatomy({ ...lab.anatomy, base, headBase: base === 'behemoth' ? 'crawler' : 'behemoth',
        armBase: base === 'crawler' ? 'crawler' : base === 'parasite' ? 'behemoth' : 'parasite', tailBase: 'crawler', tail: 1, size: 2 });
      for (let frame = 0; frame < 60; frame++) lab.tick(1 / 60);
      const parts = [];
      lab.visual.root.traverse(object => { if (object.name.includes('-module:')) parts.push(object.name); });
      const materials = lab.visual.flashMats.length;
      output.push({ base, parts, materials });
      if (!parts.some(name => name.startsWith('head-module:')) || materials < 2) throw new Error('Missing graft or source material');
    }
    return output;
  });
  results.push({ hybrids });
  await page.click('#el-frame');
  await page.evaluate(() => window.enemyLab.renderer.render(window.enemyLab.scene, window.enemyLab.camera));
  await page.screenshot({ path: `${directory}/hybrid-desktop.png` });
  const joints = await page.evaluate(async () => {
    const { connectedSurface } = await import('/src/enemies/imported/ModelModules.ts');
    const { generateEcology, factsFromSeed } = await import('/src/enemies/procedural/EcologyGenerator.ts');
    const lab = window.enemyLab;
    const output = [];
    for (const base of ['crawler', 'parasite', 'behemoth']) for (const donor of ['crawler', 'parasite', 'behemoth']) {
      if (base === donor) continue;
      for (const kind of ['head', 'tail', 'both']) {
        await lab.setAnatomy({ ...lab.anatomy, base, headBase: kind === 'tail' ? base : donor,
          tailBase: kind === 'head' ? base : donor, tail: 1, wings: false });
        for (let frame = 0; frame < 45; frame++) {
          lab.tick(1 / 60);
          lab.visual.update(1 / 60, 0, { flash: 0, frost: 0, stunned: false, enraged: false,
            ground: lab.ground, attack: kind === 'tail' ? 'tail' : 'bite', attackPhase: frame / 45 });
        }
        const joins = lab.visual.moduleDiagnostics();
        if (joins.length !== (kind === 'both' ? 2 : 1) || joins.some(join => join.vertices === 0 || join.gap > 1e-4)) throw new Error(`Detached join: ${base}/${donor}/${kind} ${JSON.stringify(joins)}`);
        lab.visual.root.traverse(object => {
          if (!object.isSkinnedMesh || object.userData.primaryRig || !object.geometry.index?.count) return;
          const indices = Array.from(object.geometry.index.array);
          if (connectedSurface(object.geometry, indices).length !== indices.length) throw new Error(`Disconnected donor islands: ${base}/${donor}/${kind}`);
        });
        output.push({ base, donor, kind, joins });
      }
    }
    await lab.setAnatomy({ ...generateEcology(774, factsFromSeed(774, 2)).genomes[1].anatomy,
      base: 'crawler', headBase: 'crawler', tailBase: 'behemoth', tail: 1.142,
      form: 'original', length: 1, body: 0.9235137851, head: 1.0608489395, limbs: 1.1252229363, size: 1.3378038778 });
    lab.tick(1 / 60);
    return output;
  });
  results.push({ joints });
  await page.click('#el-frame');
  await page.evaluate(() => window.enemyLab.renderer.render(window.enemyLab.scene, window.enemyLab.camera));
  await page.screenshot({ path: `${directory}/seed-774-repaired.png` });
  for (const base of ['crawler', 'parasite', 'behemoth']) {
    const proportions = [];
    for (const form of ['stalker', 'bulwark', 'spire']) {
      const result = await page.evaluate(async ({ base, form }) => {
        const { bodyForm } = await import('/src/enemies/imported/EnemyAnatomy.ts');
        const lab = window.enemyLab;
        await lab.setAnatomy({ ...lab.anatomy, ...bodyForm(form), base, size: 2,
          headBase: form === 'bulwark' ? 'behemoth' : 'parasite', tailBase: form === 'spire' ? 'behemoth' : 'crawler',
          color: form === 'stalker' ? 0x275f79 : form === 'bulwark' ? 0xb93560 : 0x573b75,
          accent: form === 'stalker' ? 0x60ffcd : form === 'bulwark' ? 0xffcd65 : 0xf594ff,
          glow: 1.1, pattern: form === 'stalker' ? 'bands' : form === 'bulwark' ? 'veins' : 'cells' });
        document.querySelector('#el-speed').value = '0.7';
        for (let frame = 0; frame < 240; frame++) lab.tick(1 / 60);
        document.querySelector('#el-speed').value = '0';
        for (let frame = 0; frame < 60; frame++) lab.tick(1 / 60);
        const minimum = lab.visual.root.position.clone().setScalar(Infinity), maximum = minimum.clone().setScalar(-Infinity), point = minimum.clone();
        lab.scene.updateMatrixWorld(true);
        lab.visual.root.traverse(object => {
          if (!object.isSkinnedMesh || !object.visible) return;
          for (let vertex = 0; vertex < object.geometry.attributes.position.count; vertex++) {
            object.getVertexPosition(vertex, point).applyMatrix4(object.matrixWorld);
            lab.visual.root.worldToLocal(point); minimum.min(point); maximum.max(point);
          }
        });
        return { base, form, dimensions: maximum.sub(minimum).toArray(), motion: lab.visual.locomotion.diagnostics(), joins: lab.visual.moduleDiagnostics() };
      }, { base, form });
      assert.ok(result.motion.steps > 4, `${base}/${form}: no adaptive motion`);
      assert.ok(result.motion.feet.every(foot => Number.isFinite(foot.error) && foot.error < 0.65), `${base}/${form}: unreachable feet ${JSON.stringify(result.motion)}`);
      assert.ok(result.joins.every(join => join.vertices > 0 && join.gap < 1e-4), `${base}/${form}: open join`);
      proportions.push(result.dimensions[0] / result.dimensions[2]);
      results.push(result);
      for (const [view, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.click('#el-frame');
        await page.evaluate(() => { document.querySelector('.enemy-lab aside').scrollTop = 0; document.querySelector('.enemy-lab aside').scrollLeft = 0; const lab = window.enemyLab; lab.renderer.render(lab.scene, lab.camera); });
        const visible = await page.screenshot({ path: `${directory}/${base}-${form}-${view}.png` });
        await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = false; lab.renderer.render(lab.scene, lab.camera); });
        assert.ok(await changedPixels(visible, await page.screenshot()) > (view === 'mobile' ? 500 : 1500), `${base}/${form}/${view}: missing model`);
        await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = true; lab.renderer.render(lab.scene, lab.camera); });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    assert.ok(Math.max(...proportions) / Math.min(...proportions) > 1.35, `${base}: silhouettes too similar ${proportions}`);
  }
  for (const [pattern, name] of ['veins', 'bands', 'cells'].entries()) {
    const renderGlow = async (time, glow) => {
      await page.evaluate(async ({ time, glow, pattern }) => {
        const { NECRO_UNIFORMS } = await import('/src/rendering/materials/NecroChunks.ts');
        const lab = window.enemyLab;
        NECRO_UNIFORMS.uTime.value = time;
        for (const material of lab.visual.flashMats) { material.uGlow.value = glow; material.uPattern.value = pattern; }
        lab.renderer.render(lab.scene, lab.camera);
      }, { time, glow, pattern });
      return page.screenshot();
    };
    const animated = await changedPixels(await renderGlow(0, 1.4), await renderGlow(2, 1.4));
    const disabled = await changedPixels(await renderGlow(0, 0), await renderGlow(2, 0));
    assert.ok(animated > 300, `${name}: no animated body glow (${animated})`);
    assert.equal(disabled, 0, `${name}: pose/camera moved during shader-only check`);
    results.push({ pattern: name, animatedPixels: animated });
  }
  const attacks = await page.evaluate(async () => {
    const { legalAttacks } = await import('/src/enemies/imported/EnemyAnatomy.ts');
    const lab = window.enemyLab;
    const results = [];
    document.querySelector('#el-speed').value = '0';
    for (const base of ['crawler', 'parasite', 'behemoth']) {
      await lab.setAnatomy({ ...lab.anatomy, base, headBase: base, tailBase: base, body: 1, head: 1, limbs: 1, tail: 1, length: 1, size: 2 });
      lab.tick(1 / 60);
      const bones = [];
      lab.visual.root.traverse(object => { if (object.isBone) bones.push(object); });
      const sample = (attack, phase) => {
        lab.visual.locomotion.clock = 1;
        lab.visual.update(1 / 60, 0, { flash: 0, frost: 0, stunned: false, enraged: false, ground: lab.ground, attack, attackPhase: phase });
        return bones.map(bone => bone.quaternion.clone().normalize());
      };
      for (const attack of legalAttacks(lab.anatomy, true)) {
        const neutral = sample(attack, 0);
        const posed = sample(attack, 0.5);
        const changed = Math.max(...posed.map((rotation, index) => rotation.angleTo(neutral[index])));
        if (changed < 0.05) throw new Error(`${base}/${attack}: no procedural attack pose`);
        const repeat = sample(attack, 0.5);
        if (Math.max(...repeat.map((rotation, index) => rotation.angleTo(posed[index]))) > 1e-4) throw new Error(`${base}/${attack}: pose depends on playback history`);
        const beforeStun = bones.map(bone => bone.quaternion.clone().normalize());
        lab.visual.update(1 / 60, 0, { flash: 0, frost: 0, stunned: true, enraged: false, ground: lab.ground, attack, attackPhase: 0.8 });
        if (bones.some((bone, index) => bone.quaternion.clone().normalize().angleTo(beforeStun[index]) > 1e-4)) throw new Error(`${base}/${attack}: stun did not freeze pose`);
        results.push({ base, attack, changed });
      }
    }
    return results;
  });
  results.push({ proceduralAttacks: attacks });
  for (const base of ['crawler', 'parasite', 'behemoth']) {
    await page.evaluate(async base => {
      const lab = window.enemyLab;
      await lab.setAnatomy({ ...lab.anatomy, base, headBase: base, tailBase: base, body: 1, head: 1, limbs: 1, tail: 1, length: 1, size: 2,
        color: 0xe82779, accent: 0x5cffcc, pattern: 'cells' });
      lab.tick(1 / 60);
    }, base);
    await page.click('#el-frame');
    const renderSurface = async (tint, glow, visible = true) => {
      await page.evaluate(({ tint, glow, visible }) => {
        const lab = window.enemyLab;
        lab.visual.root.visible = visible;
        for (const material of lab.visual.flashMats) { material.uTintAmount.value = tint; material.uGlow.value = glow; material.uAggro.value = 1; }
        lab.renderer.render(lab.scene, lab.camera);
      }, { tint, glow, visible });
      return page.screenshot();
    };
    const source = await sharp(await renderSurface(0, 0)).removeAlpha().raw().toBuffer();
    const background = await sharp(await renderSurface(0, 0, false)).removeAlpha().raw().toBuffer();
    const glowing = await renderSurface(0.25, 2.5);
    await writeFile(`${directory}/${base}-texture-glow.png`, glowing);
    const actual = await sharp(glowing).removeAlpha().raw().toBuffer();
    let pixels = 0, originalWhite = 0, glowingWhite = 0, sourceSum = 0, actualSum = 0, sourceSquared = 0, actualSquared = 0, product = 0;
    for (let offset = 0; offset < source.length; offset += 3) {
      if (Math.abs(source[offset] - background[offset]) + Math.abs(source[offset + 1] - background[offset + 1]) + Math.abs(source[offset + 2] - background[offset + 2]) < 30) continue;
      pixels++;
      if (Math.min(...source.subarray(offset, offset + 3)) > 245) originalWhite++;
      if (Math.min(...actual.subarray(offset, offset + 3)) > 245) glowingWhite++;
      const before = source[offset] * 0.32 + source[offset + 1] * 0.56 + source[offset + 2] * 0.12;
      const after = actual[offset] * 0.32 + actual[offset + 1] * 0.56 + actual[offset + 2] * 0.12;
      sourceSum += before; actualSum += after; sourceSquared += before * before; actualSquared += after * after; product += before * after;
    }
    const correlation = (product - sourceSum * actualSum / pixels) / Math.sqrt((sourceSquared - sourceSum * sourceSum / pixels) * (actualSquared - actualSum * actualSum / pixels));
    assert.ok(pixels > 1500 && correlation > 0.8, `${base}: texture contrast lost under glow (${correlation})`);
    assert.ok(glowingWhite <= originalWhite + pixels * 0.005, `${base}: glow washed out the body`);
    results.push({ base, textureCorrelation: correlation, pixels, originalWhite, glowingWhite });
  }
  for (const tier of ['boss', 'nexus']) {
    const giant = await page.evaluate(async tier => {
      const { generateEcology, factsFromSeed } = await import('/src/enemies/procedural/EcologyGenerator.ts');
      const lab = window.enemyLab;
      const genome = generateEcology(719, factsFromSeed(719, 2)).genomes.find(genome => genome.tier === tier);
      await lab.setAnatomy(genome.anatomy);
      document.querySelector('#el-speed').value = '1.5';
      for (let frame = 0; frame < 360; frame++) lab.tick(1 / 60);
      document.querySelector('#el-speed').value = '0';
      for (let frame = 0; frame < 60; frame++) lab.tick(1 / 60);
      return { tier, size: lab.anatomy.size, motion: lab.visual.locomotion.diagnostics() };
    }, tier);
    assert.ok(giant.motion.steps > 0 && giant.motion.feet.every(foot => Number.isFinite(foot.error) && foot.error < giant.size * 0.3), `${tier}: giant lost terrain contact ${JSON.stringify(giant)}`);
    results.push(giant);
    for (const [view, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.click('#el-frame');
      const framing = await page.evaluate(() => {
        const lab = window.enemyLab;
        const panel = document.querySelector('.enemy-lab aside');
        panel.scrollTop = 0; panel.scrollLeft = 0;
        lab.scene.updateMatrixWorld(true);
        lab.renderer.render(lab.scene, lab.camera);
        const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
        const point = lab.visual.root.position.clone();
        lab.visual.root.traverse(object => {
          if (!object.isSkinnedMesh || !object.visible) return;
          for (let vertex = 0; vertex < object.geometry.attributes.position.count; vertex++) {
            object.getVertexPosition(vertex, point).applyMatrix4(object.matrixWorld).project(lab.camera);
            const horizontal = (point.x + 1) * innerWidth / 2, vertical = (1 - point.y) * innerHeight / 2;
            bounds.left = Math.min(bounds.left, horizontal); bounds.right = Math.max(bounds.right, horizontal);
            bounds.top = Math.min(bounds.top, vertical); bounds.bottom = Math.max(bounds.bottom, vertical);
          }
        });
        const mobile = innerWidth < 700;
        return { bounds, area: { left: mobile ? 0 : panel.getBoundingClientRect().right, right: innerWidth,
          top: document.querySelector('.enemy-lab header').getBoundingClientRect().bottom,
          bottom: mobile ? panel.getBoundingClientRect().top : innerHeight - 32 } };
      });
      assert.ok(framing.bounds.left > framing.area.left && framing.bounds.right < framing.area.right && framing.bounds.top > framing.area.top && framing.bounds.bottom < framing.area.bottom,
        `${tier}/${view}: giant clipped or covered by controls ${JSON.stringify(framing)}`);
      const visible = await page.screenshot({ path: `${directory}/${tier}-giant-${view}.png` });
      await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = false; lab.renderer.render(lab.scene, lab.camera); });
      assert.ok(await changedPixels(visible, await page.screenshot()) > (view === 'mobile' ? 500 : 1500), `${tier}/${view}: missing giant model`);
      await page.evaluate(() => { const lab = window.enemyLab; lab.visual.root.visible = true; lab.renderer.render(lab.scene, lab.camera); });
    }
  }
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.necrofallShell));
  await page.evaluate(() => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    shell.soloRunActive = true; shell.lastSoloMode = 'freeroam'; shell.hideShell(true);
    game.startSoloRun({ mode: 'freeroam', planetKey: '', ring: 0, universeSeed: 23, seed: 23, colony: 0 });
  });
  await page.waitForFunction(() => window.necrofall?.phase === 'playing' && window.necrofall.envWorld?.ecology, {}, { timeout: 60000 });
  const walkers = await page.evaluate(async () => {
    const { Vector3 } = await import('/node_modules/three/build/three.webgpu.js');
    const game = window.necrofall, world = game.envWorld;
    game.update = () => {}; game.ticker.update = () => game.rendering.render(0);
    const up = world.deps.system.sunDirection.clone().normalize();
    const across = new Vector3().crossVectors(up, new Vector3(0, 1, 0)).normalize();
    const forward = new Vector3().crossVectors(across, up).normalize();
    const ground = point => { point.normalize(); return point.multiplyScalar(game.planet.meshHeightAtDir(point.x, point.y, point.z)); };
    const center = ground(up.clone().multiplyScalar(game.planet.radius));
    const ids = [];
    for (const [index, base] of ['crawler', 'parasite', 'behemoth'].entries()) {
      const genome = game.enemies.bestiary.genomes.find(candidate => candidate.anatomy?.base === base);
      if (!genome) throw new Error(`Missing gameplay body: ${base}`);
      const start = ground(center.clone().addScaledVector(across, (index - 1) * 5));
      const enemy = game.enemies.spawn(genome.idx, start);
      enemy.genome = { ...enemy.genome, abilities: [], hunter: false, hunt: undefined, swarm: undefined,
        ranged: false, projKind: 'none', attackRange: 0.5, speed: 5,
        behavior: { ...enemy.genome.behavior, chaseSpeedMul: 1 } };
      enemy.isBoss = false; enemy.flyAlt = 0; enemy.airH = 0; enemy.attackCd = 1000; enemy.thinkT = 1000;
      enemy.bTarget = { alive: true, id: `walk-${base}`, position: ground(start.clone().addScaledVector(forward, 32)) };
      enemy.walkStart = enemy.position.clone();
      ids.push(enemy.id);
    }
    game.localPlayer.position.copy(center); game.localPlayer.up.copy(up);
    window.walkingTest = { ids, up, across, forward, center };
    return ids;
  });
  await page.waitForFunction(ids => ids.every(id => window.necrofall.enemies.byId(id)?.imported), walkers, { timeout: 60000 });
  const gameplay = await page.evaluate(() => {
    const game = window.necrofall, world = game.envWorld;
    return window.walkingTest.ids.map(id => {
      const enemy = game.enemies.byId(id);
      let maxStep = 0, maxPenetration = 0;
      for (let frame = 0; frame < 240; frame++) {
        const before = enemy.position.clone();
        game.clock += 1 / 60; enemy.update(1 / 60, game); enemy.place(1 / 60, game);
        const resolved = enemy.position.clone(); world.obstacles.resolve(resolved, enemy.radius * 0.65);
        if (frame > 5) {
          maxStep = Math.max(maxStep, before.distanceTo(enemy.position));
          maxPenetration = Math.max(maxPenetration, resolved.distanceTo(enemy.position));
        }
      }
      return { base: enemy.genome.anatomy.base, distance: enemy.position.distanceTo(enemy.walkStart),
        steps: enemy.imported.locomotion.steps, maxStep, maxPenetration };
    });
  });
  for (const walker of gameplay) {
    assert.ok(walker.distance > 8 && walker.steps > 8, `Gameplay walker stalled: ${JSON.stringify(walker)}`);
    assert.ok(walker.maxStep < 0.65 && walker.maxPenetration < 0.08, `Gameplay terrain jitter: ${JSON.stringify(walker)}`);
  }
  results.push({ gameplay });
  for (const [view, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      const game = window.necrofall, test = window.walkingTest, camera = game.cam.camera;
      const focus = test.center.clone().setScalar(0);
      for (const id of test.ids) focus.add(game.enemies.byId(id).position);
      focus.divideScalar(test.ids.length);
      camera.position.copy(focus).addScaledVector(test.up, 22).addScaledVector(test.forward, -18);
      camera.up.copy(test.up); camera.lookAt(focus); camera.updateMatrixWorld(true);
      game.envWorld.update(focus, camera); game.lighting.update(focus); game.rendering.render(0);
    });
    const visible = await page.screenshot({ path: `${directory}/gameplay-walking-${view}.png` });
    await page.evaluate(() => { const game = window.necrofall; for (const id of window.walkingTest.ids) game.enemies.byId(id).group.visible = false; game.rendering.render(0); });
    assert.ok(await changedPixels(visible, await page.screenshot()) > 300, `${view}: gameplay walkers not visible`);
    await page.evaluate(() => { const game = window.necrofall; for (const id of window.walkingTest.ids) game.enemies.byId(id).group.visible = true; game.rendering.render(0); });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify(results, null, 2));
  console.log(`PASS: slope support; 6 obstacle pursuits; 9 running gaits; 3 gameplay walkers; ${rules.count} genomes; 9 terrain courses; 18 graft combinations; 9 moving forms; desktop/mobile pixels; 3 glow patterns; ${attacks.length} procedural attacks; texture retention at maximum glow`);
} finally { await browser.close(); await server.close(); }