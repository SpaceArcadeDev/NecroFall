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
  await page.goto(`${server.resolvedUrls.local[0]}?enemyLab=1`);
  await page.waitForFunction(() => window.enemyLab?.visual?.clock > 0.3, {}, { timeout: 60000 });
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
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify(results, null, 2));
  console.log(`PASS: ${rules.count} genomes; 9 terrain courses; 18 graft combinations; 9 distinct moving forms; desktop/mobile pixels; 3 animated glow patterns`);
} finally { await browser.close(); await server.close(); }