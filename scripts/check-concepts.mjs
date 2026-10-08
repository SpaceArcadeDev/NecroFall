import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import sharp from 'sharp';

const output = '.test-shots/concepts';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: 'src/concepts/vite.config.ts', server: { port: 5196, host: '127.0.0.1', watch: null, hmr: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'), headless: true });
const studies = (await server.ssrLoadModule('/src/concepts/definitions.ts')).STUDIES;
const concepts = studies.slice(0, process.argv.includes('--assets') || process.argv.includes('--states') || process.argv.includes('--bases') ? studies.length : 5).map(study => study.id);
const report = [];
const errors = [];

function monitor(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
}

async function ready(page) {
  await page.waitForFunction(() => window.necrofallStudies && !window.necrofallStudies.snapshot.building && document.querySelector('.loading').hidden && window.necrofallStudies.snapshot.drawCalls > 0, null, { timeout: 90000 });
  const state = await page.evaluate(() => window.necrofallStudies.snapshot);
  if (!state.paused) await page.waitForFunction((elapsed) => window.necrofallStudies.snapshot.elapsed > elapsed + 0.08, state.elapsed);
  return page.evaluate(() => window.necrofallStudies.snapshot);
}

async function capture(page, name) {
  const state = await ready(page);
  assert.deepEqual(errors, [], `${name}: browser errors`);
  await page.locator('#hide').click();
  const screenshot = await page.locator('canvas').screenshot({ style: '.hide-toggle { visibility: hidden !important; }' });
  await page.locator('#hide').click();
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 50;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 80, 50);
    const data = context.getImageData(0, 0, 80, 50).data;
    const colors = new Set();
    let luminance = 0, darkest = 255, brightest = 0;
    for (let index = 0; index < data.length; index += 4) {
      colors.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`);
      const value = (data[index] + data[index + 1] + data[index + 2]) / 3;
      luminance += value;
      darkest = Math.min(darkest, value);
      brightest = Math.max(brightest, value);
    }
    return { colors: colors.size, luminance: luminance / 4000, contrast: brightest - darkest };
  }, screenshot.toString('base64'));
  assert(pixels.colors > (state.inspection && state.inspection !== 'scene' ? 12 : 35), `${name}: insufficient scene color variation ${pixels.colors}`);
  assert(pixels.contrast > 12, `${name}: insufficient visible shading/contrast`);
  assert(pixels.luminance > 8, `${name}: canvas is too dark or blank`);
  assert(state.drawCalls < 160, `${name}: draw-call budget exceeded (${state.drawCalls})`);
  const triangleBudget = name.startsWith('asset-') ? (state.mobile ? 750000 : 1200000) : (state.mobile ? 550000 : 900000);
  assert(state.triangles < triangleBudget, `${name}: triangle budget exceeded (${state.triangles})`);
  const layout = await page.evaluate(() => {
    const overflowing = [...document.querySelectorAll('button, h1, select')].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2;
    }).map((element) => element.textContent);
    return { overflowing, documentOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.deepEqual(layout.overflowing, [], `${name}: overflowing text`);
  assert.equal(layout.documentOverflow, false, `${name}: horizontal page overflow`);
  await writeFile(`${output}/${name}.png`, screenshot);
  if (name.includes('mobile') && name.endsWith('surface')) await page.screenshot({ path: `${output}/${name}-ui.png` });
  report.push({ name, ...state, pixels });
  console.log(`${name}: ${state.backend}, ${state.drawCalls} draws, ${state.triangles} triangles, ${pixels.colors} pixel colors`);
  return state;
}

async function writeComparisonSheets() {
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 600 } });
  const directory = '.test-shots/environment-review/sheets';
  await mkdir(directory, { recursive: true });
  for (const part of ['surface', 'terrain', 'grass', 'water', 'trees', 'rocks', 'orbit']) {
    const figures = [];
    for (const planet of concepts) {
      const image = await readFile(`${output}/asset-${planet}-${part}.png`);
      figures.push(`<figure><img src="data:image/png;base64,${image.toString('base64')}" alt="${planet} ${part}"><figcaption>${planet.replaceAll('-', ' ')}</figcaption></figure>`);
    }
    await sheet.setContent(`<style>body{margin:0;padding:18px;background:#e7eee9;color:#162b30;font:15px Bahnschrift,sans-serif}h1{font-size:21px;margin:0 0 16px}main{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}figure{margin:0}img{width:100%;aspect-ratio:1.6;object-fit:contain;background:#15272c}figcaption{padding-top:9px;text-transform:capitalize}footer{font-size:10px;margin-top:18px;color:#50676a}</style><h1>NECROFALL / ${part.toUpperCase()} / ${concepts.length}-planet comparison</h1><main>${figures.join('')}</main><footer>Rendered environment study. Source attribution: src/concepts/assets/ATTRIBUTION.md</footer>`);
    await sheet.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await sheet.screenshot({ path: `${directory}/${part}.png` });
  }
  await sheet.close();
}

async function pixelDifference(first, second, threshold = 4) {
  const before = await sharp(first).removeAlpha().raw().toBuffer();
  const after = await sharp(second).removeAlpha().raw().toBuffer();
  assert.equal(before.length, after.length);
  let difference = 0, changed = 0;
  for (let index = 0; index < before.length; index++) {
    const delta = Math.abs(before[index] - after[index]);
    difference += delta;
    if (delta > threshold) changed++;
  }
  return { mean: difference / before.length, changed };
}

async function canvasOnly(page) {
  return page.locator('canvas').screenshot({ style: '.chrome, .vignette, .hide-toggle { visibility: hidden !important; }' });
}

async function layoutCheck(page) {
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.masthead, .view-switch, .scene-actions, .hide-toggle, .asset-inspection, .climate-controls, .navigation-tools, .walk-controls, .world-caption, .selection, .archive')]
      .filter(element => element.checkVisibility()).map(element => ({ name: element.className, box: element.getBoundingClientRect() }));
    const result = [];
    for (let first = 0; first < boxes.length; first++) for (let second = first + 1; second < boxes.length; second++) {
      const left = boxes[first], right = boxes[second];
      if (Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left) > 2 && Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top) > 2) result.push(`${left.name} / ${right.name}`);
    }
    return result;
  });
  assert.deepEqual(overlaps, [], 'Visible controls/captions must not overlap');
}

async function statePair(page, name) {
  let normal = await ready(page);
  if (!normal.paused) await page.locator('#motion').click();
  await page.locator('button[data-state="normal"]').click();
  normal = await capture(page, `${name}-normal`);
  const before = await canvasOnly(page);
  await page.locator('button[data-state="radiated"]').click();
  const radiated = await capture(page, `${name}-radiated`);
  const after = await canvasOnly(page);
  assert.equal(radiated.sceneState, 'radiated');
  assert(radiated.radiationMaterials > 0);
  for (const key of ['sceneId', 'seed', 'geometries', 'grassBlades', 'camera', 'elapsed']) assert.deepEqual(radiated[key], normal[key], `${name}: state switch changed ${key}`);
  const difference = await pixelDifference(before, after);
  assert(difference.mean > 0.35 && difference.changed > 500, `${name}: radiation must visibly affect the actual canvas (${JSON.stringify(difference)})`);
  assert(new URL(page.url()).searchParams.get('state') === 'radiated');
  await page.locator('button[data-state="normal"]').click();
  assert((await pixelDifference(before, await canvasOnly(page))).mean < 0.01, `${name}: Normal must restore exactly`);
  await layoutCheck(page);
  return normal;
}

async function checkStates() {
  const smoke = process.argv.includes('--smoke');
  const weatherOnly = process.argv.includes('--weather');
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  monitor(desktop);
  const selected = weatherOnly ? ['glass-tide', 'saffron-waste', 'mycelial-night', 'verdant-tempest', 'frostwound', 'aether-garden'] : smoke ? ['cinderbloom', 'frostwound', 'emberwake'] : concepts;
  for (const planet of selected) {
    for (const view of smoke || weatherOnly ? ['surface'] : ['surface', 'orbit']) {
      await desktop.goto(`${base}concepts.html?assets=1&planet=${planet}&view=${view}`);
      const state = await statePair(desktop, `asset-state-${planet}-${view}`);
      if (view === 'surface') {
        assert.equal(state.weather.kind, studies.find(study => study.id === planet).weather);
        assert(state.weather.count > 0 && state.weather.visible);
        if (weatherOnly) {
          const layers = state.weather.layers.map(layer => layer.kind);
          if (state.weather.kind === 'rain') assert(layers.includes('rain-impacts'));
          if (state.weather.kind === 'heat') assert(layers.includes('heat-refraction') && !layers.includes('heat'));
          if (planet === 'mycelial-night' || planet === 'verdant-tempest') assert(layers.includes('spores'));
        }
        const weatherOn = await canvasOnly(desktop);
        await desktop.locator('#effects').uncheck();
        const weatherOff = await canvasOnly(desktop);
        assert((await pixelDifference(weatherOn, weatherOff)).changed > 20, `${planet}: weather must contribute visible pixels`);
        await desktop.locator('#effects').check();
        await desktop.locator('#motion').click();
        await desktop.waitForFunction(elapsed => window.necrofallStudies.snapshot.elapsed > elapsed + 0.6, state.elapsed);
        await desktop.locator('#motion').click();
        const movedOn = await canvasOnly(desktop);
        await desktop.locator('#effects').uncheck();
        const movedOff = await canvasOnly(desktop);
        const beforeOn = await sharp(weatherOn).removeAlpha().raw().toBuffer(), beforeOff = await sharp(weatherOff).removeAlpha().raw().toBuffer();
        const afterOn = await sharp(movedOn).removeAlpha().raw().toBuffer(), afterOff = await sharp(movedOff).removeAlpha().raw().toBuffer();
        let movingChannels = 0;
        for (let index = 0; index < beforeOn.length; index++) if (Math.abs((beforeOn[index] - beforeOff[index]) - (afterOn[index] - afterOff[index])) > 6) movingChannels++;
        assert(movingChannels > 20, `${planet}: particle contribution must move over time`);
        await desktop.locator('#effects').check();
        const frozenTime = await desktop.evaluate(() => window.necrofallStudies.snapshot.weather.time);
        await desktop.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await desktop.evaluate(() => window.necrofallStudies.snapshot.weather.time), frozenTime);
      } else assert.equal(state.weather, null);
    }
  }
  await desktop.goto(`${base}concepts.html?assets=1&planet=frostwound&inspect=water`);
  const ice = await ready(desktop);
  assert.equal(ice.water.surfaceType, 'ice');
  assert.equal(ice.water.flowing, false);
  const frozen = await canvasOnly(desktop);
  await desktop.waitForFunction(elapsed => window.necrofallStudies.snapshot.elapsed > elapsed + 0.5, ice.elapsed);
  assert((await pixelDifference(frozen, await canvasOnly(desktop))).mean < 0.01, 'Frozen water must remain visually static as time advances');
  await statePair(desktop, 'asset-state-frostwound-ice');
  assert.equal((await desktop.evaluate(() => window.necrofallStudies.snapshot)).water.flowing, false);
  if (!smoke && !weatherOnly) {
    for (const inspection of ['grass', 'trees', 'rocks']) {
      await desktop.goto(`${base}concepts.html?assets=1&planet=cinderbloom&inspect=${inspection}`);
      await statePair(desktop, `asset-state-cinderbloom-${inspection}`);
    }
  }
  await desktop.close();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  monitor(mobile);
  for (const planet of weatherOnly ? selected : smoke ? ['frostwound'] : concepts) {
    await mobile.goto(`${base}concepts.html?assets=1&planet=${planet}`);
    const state = await statePair(mobile, `asset-state-mobile-${planet}-surface`);
    assert(state.mobile);
    assert.equal(state.canvas.width, 390);
    await mobile.screenshot({ path: `${output}/asset-state-mobile-${planet}-ui.png` });
  }
  for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) {
    await mobile.setViewportSize(viewport);
    await ready(mobile);
    await layoutCheck(mobile);
    await mobile.screenshot({ path: `${output}/asset-state-ui-${viewport.width}.png` });
  }
  await mobile.close();
  const fallback = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  monitor(fallback);
  for (const planet of weatherOnly ? ['glass-tide', 'saffron-waste', 'mycelial-night'] : smoke ? ['frostwound'] : ['frostwound', 'emberwake', 'stormglass-reach']) {
    await fallback.goto(`${base}concepts.html?assets=1&backend=webgl&quality=mobile&planet=${planet}`);
    const state = await statePair(fallback, `asset-state-webgl-${planet}-surface`);
    assert.equal(state.backend, 'WEBGL 2');
    assert.equal(state.elapsed, 0, 'Reduced motion must freeze shader animation from startup');
  }
  await fallback.close();
  assert.deepEqual(errors, [], 'Browser console errors');
  await writeFile(`${output}/state-report${weatherOnly ? '-weather' : smoke ? '-smoke' : ''}.json`, JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.length} state views; actual canvas changes, unchanged layouts/seeds/cameras, particle motion/pause, static ice, mobile, reduced motion, and WebGL.`);
}

async function checkBases() {
  const { BaseSurface, boundaryEdges, spikeGeometry, crystalGeometry } = await server.ssrLoadModule('/src/concepts/BaseGeology.ts');
  const { BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } = await import('three/webgpu');
  assert.equal(boundaryEdges(spikeGeometry(7)).length, 0);
  assert.equal(boundaryEdges(crystalGeometry()).length, 0);
  const fixture = new BaseSurface(() => 0);
  const small = new Mesh(new BoxGeometry(2, 1, 2), new MeshBasicMaterial()); small.position.set(0, 0.5, 0); fixture.add(small, 'boulder');
  assert.equal(fixture.step(new Vector3(-2, 0, 0), 2, 0).y, 1);
  assert.equal(fixture.allowsVegetation(0, 0), false);
  const ramp = new Mesh(new BoxGeometry(8, 0.4, 4), new MeshBasicMaterial()); ramp.rotation.z = 0.4; ramp.position.set(12, 1.8, 0); fixture.add(ramp, 'formation');
  const climbed = fixture.step(new Vector3(7, 0, 0), 8, 0);
  assert(climbed.x > 14 && climbed.y > 2, 'A rendered gentle ramp must be climbable');
  const wall = new Mesh(new BoxGeometry(2, 6, 2), new MeshBasicMaterial()); wall.position.set(22, 3, 0); fixture.add(wall, 'formation');
  assert(fixture.step(new Vector3(20, 0, 0), 2, 0).x < 21, 'Tall vertical ledges must block walking');
  const steep = new BaseSurface(positionX => positionX * 2);
  assert.equal(steep.step(new Vector3(0, 0, 0), 1, 0).x, 0);
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } }); monitor(desktop);
  for (const planet of concepts) {
    await desktop.goto(`${base}base-planets.html?planet=${planet}&focus=off`);
    const state = await statePair(desktop, `asset-base-${planet}-surface`);
    assert(state.spikes >= 4 && state.crystals >= 5, `${planet}: spikes and crystals must exist`);
    assert.equal(state.features.length, 3, `${planet}: exactly three feature recipes`);
    assert(state.features.every(feature => feature.count > 0), `${planet}: every feature must be placed (${JSON.stringify(state.features)})`);
    assert.equal(new Set(state.features.map(feature => feature.id)).size, 3);
    const audit = await desktop.evaluate(() => window.necrofallStudies.geometryAudit());
    assert(audit.openEdges.every(count => count === 0), `${planet}: geological meshes must be closed`);
    assert(audit.formationAspect.every(ratio => ratio > 0.4), `${planet}: mountains must be substantial volumes, not capped sheets`);
    assert(audit.formationSources.length > 0 && audit.formationSources.every(source => source === 'authored cliff front with sculpted back and rounded sides'), `${planet}: retain the authored mountain family`);
    assert(audit.boulderCount > 0, `${planet}: retain separate ordinary boulders`);
    assert(audit.grounding.gaps.every(gap => gap <= 0.01), `${planet}: ordinary rocks must contact the rendered terrain`);
    assert(audit.grounding.attachmentGaps.every(gap => gap <= 0.01), `${planet}: broad rock bases must conform to the terrain`);
    assert(audit.spikeBaseGaps.every(gap => gap <= 0.01), `${planet}: tilted spike feet must be fully planted`);
    assert.equal(audit.grounding.floating, planet === 'aether-garden' ? 6 : 0, `${planet}: only Aether Garden may have intentional floating outcrops`);
    assert.equal(audit.crystalShape.type, 'OctahedronGeometry');
    assert(Math.abs(audit.crystalShape.size[0] - 0.46) < 0.00001 && Math.abs(audit.crystalShape.size[1] - 1.748) < 0.00001, `${planet}: crystal geometry must match the original implementation`);
    assert(audit.crystalSlenderness.every(ratio => ratio >= 3 && ratio < 5.8), `${planet}: crystal scale must stay within the original range`);
    assert.equal(audit.grassOverlaps, 0, `${planet}: grass under geology`);
    assert.equal(audit.treeOverlaps, 0, `${planet}: trees under geology`);
    assert.equal(audit.spikeShape.radialSegments, 5);
    assert.equal(audit.spikeShape.radius, 0.34);
    assert.equal(audit.spikeShape.height, 2.4);
    for (let cluster = 0; cluster < audit.spikeAxes.length; cluster += 4) for (let shard = 1; shard < 4; shard++) {
      const difference = audit.spikeAxes[cluster].map((value, axis) => value - audit.spikeAxes[cluster + shard][axis]);
      assert(Math.hypot(...difference) < 0.00001, `${planet}: a spike cluster must share its tilt`);
    }
    assert(new Set(audit.crystalAxes.map(axis => axis.map(value => value.toFixed(3)).join(','))).size > 3, `${planet}: crystals need independent tilts`);
    await desktop.locator('#walk').click();
    assert((await desktop.evaluate(() => window.necrofallStudies.snapshot)).walking);
    const before = await desktop.evaluate(() => window.necrofallStudies.snapshot.feet);
    await desktop.keyboard.down('KeyW');
    await desktop.waitForFunction(before => {
      const feet = window.necrofallStudies.snapshot.feet;
      return Math.hypot(feet[0] - before[0], feet[2] - before[2]) > 0.08;
    }, before, { timeout: 5000 });
    await desktop.keyboard.up('KeyW');
    const walked = await desktop.evaluate(() => window.necrofallStudies.snapshot);
    assert(Math.abs(walked.camera[1] - walked.feet[1] - 1.65) < 0.001);
    await desktop.locator('#reset').click();
    await desktop.selectOption('#inspection', 'geology');
    await capture(desktop, `asset-base-${planet}-geology-front`);
    await desktop.locator('#hide').click();
    await desktop.mouse.move(650, 420); await desktop.mouse.down(); await desktop.mouse.move(1100, 420, { steps: 20 }); await desktop.mouse.up();
    await desktop.locator('#hide').click();
    await capture(desktop, `asset-base-${planet}-geology-back`);
    await desktop.selectOption('#inspection', 'features');
    await capture(desktop, `asset-base-${planet}-features`);
  }
  await desktop.goto(`${base}base-planets.html?planet=cinderbloom&focus=off&effects=off`);
  await ready(desktop); await desktop.locator('#motion').click();
  const sharpFrame = await canvasOnly(desktop);
  await desktop.locator('#focus-blur').check();
  const blurredFrame = await canvasOnly(desktop);
  assert((await pixelDifference(sharpFrame, blurredFrame)).mean > 0.01, 'Focus blur must affect pixels');
  const center = { left: 660, top: 390, width: 120, height: 120 };
  const sharpCenter = await sharp(sharpFrame).extract(center).png().toBuffer();
  const blurredCenter = await sharp(blurredFrame).extract(center).png().toBuffer();
  assert((await pixelDifference(sharpCenter, blurredCenter)).mean < 0.01, 'The center of focus must stay sharp');
  await desktop.selectOption('#inspection', 'rocks');
  for (const angle of ['front', 'back', 'underside']) {
    if (angle !== 'front') {
      await desktop.locator('#hide').click();
      await desktop.mouse.move(650, 420); await desktop.mouse.down(); await desktop.mouse.move(angle === 'back' ? 1100 : 850, angle === 'underside' ? 300 : 420, { steps: 20 }); await desktop.mouse.up();
      await desktop.locator('#hide').click();
    }
    await capture(desktop, `asset-base-rock-closure-${angle}`);
  }
  await desktop.close();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); monitor(mobile);
  for (const planet of concepts) {
    await mobile.goto(`${base}base-planets.html?planet=${planet}`);
    await capture(mobile, `asset-base-mobile-${planet}-surface`); await layoutCheck(mobile);
    await mobile.locator('#walk').click();
    await layoutCheck(mobile);
    const before = await mobile.evaluate(() => window.necrofallStudies.snapshot.feet);
    await mobile.locator('[data-move="KeyW"]').dispatchEvent('pointerdown', { pointerId: 1 });
    await mobile.waitForFunction(before => Math.hypot(window.necrofallStudies.snapshot.feet[0] - before[0], window.necrofallStudies.snapshot.feet[2] - before[2]) > 0.08, before, { timeout: 5000 });
    await mobile.locator('[data-move="KeyW"]').dispatchEvent('pointerup', { pointerId: 1 });
    await mobile.locator('#reset').click();
  }
  for (const size of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) { await mobile.setViewportSize(size); await ready(mobile); await layoutCheck(mobile); }
  await mobile.close();
  const fallback = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }); monitor(fallback);
  for (const planet of ['cinderbloom', 'glass-tide', 'emberwake', 'frostwound']) {
    await fallback.goto(`${base}base-planets.html?planet=${planet}&backend=webgl&quality=mobile`);
    assert.equal((await capture(fallback, `asset-base-webgl-${planet}`)).backend, 'WEBGL 2');
  }
  await fallback.close();
  assert.deepEqual(errors, []);
  await writeFile(`${output}/base-report.json`, JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.length} base-planet views; closed formations, original spike shape, cluster/shard angles, clearance, three features per base, walking, center-preserving blur, and fallback.`);
}

async function checkFeatureVisibility() {
  const visibilityReport = [];
  const requested = process.argv.find(argument => argument.startsWith('--planet='))?.slice(9);
  const selected = requested ? concepts.filter(planet => planet === requested) : concepts;
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    monitor(page);
    for (const planet of selected) {
      await page.goto(`${base}base-planets.html?planet=${planet}&focus=off`);
      const state = await ready(page);
      await page.locator('#motion').click();
      const all = await canvasOnly(page);
      for (const feature of state.features) {
        await page.evaluate(id => window.necrofallStudies.setFeatureVisibility(id, false), feature.id);
        const hidden = await canvasOnly(page);
        const difference = await pixelDifference(all, hidden, 1);
        visibilityReport.push({ planet, mobile, feature: feature.id, ...difference, visibleAtArrival: feature.visibleAtArrival });
        console.log(`${mobile ? 'mobile' : 'desktop'} ${planet} / ${feature.id}: ${difference.changed} visible channels, mean ${difference.mean.toFixed(4)}`);
        await page.evaluate(id => window.necrofallStudies.setFeatureVisibility(id, true), feature.id);
        assert(difference.changed > 50 && difference.mean > 0.001, `${planet}/${feature.id}: feature is not meaningfully visible in the composed ${mobile ? 'mobile' : 'desktop'} view`);
      }
      if (planet === 'saffron-waste') {
        await page.evaluate(() => window.necrofallStudies.setWeatherLayerVisibility('heat-refraction', false));
        const withoutHeat = await canvasOnly(page);
        const heat = await pixelDifference(all, withoutHeat, 1);
        assert(heat.changed > 100, 'Rising heat trails must be visible independently of dust and the tornado');
        await page.evaluate(() => window.necrofallStudies.setWeatherLayerVisibility('heat-refraction', true));
        await page.locator('#motion').click();
        await page.waitForFunction(elapsed => window.necrofallStudies.snapshot.elapsed > elapsed + 0.7, state.elapsed);
        await page.locator('#motion').click();
        const later = await canvasOnly(page);
        await page.evaluate(() => window.necrofallStudies.setWeatherLayerVisibility('heat-refraction', false));
        const laterWithoutHeat = await canvasOnly(page);
        const initialOn = await sharp(all).removeAlpha().raw().toBuffer(), initialOff = await sharp(withoutHeat).removeAlpha().raw().toBuffer();
        const laterOn = await sharp(later).removeAlpha().raw().toBuffer(), laterOff = await sharp(laterWithoutHeat).removeAlpha().raw().toBuffer();
        let moving = 0;
        for (let index = 0; index < initialOn.length; index++) if (Math.abs(initialOn[index] - initialOff[index] - laterOn[index] + laterOff[index]) > 2) moving++;
        assert(moving > 100, 'Heat-refraction trails must animate');
        await page.evaluate(() => window.necrofallStudies.setWeatherLayerVisibility('heat-refraction', true));
        await writeFile(`${output}/base-rising-heat-${mobile ? 'mobile' : 'desktop'}.png`, later);
      }
      await writeFile(`${output}/base-visible-${planet}-${mobile ? 'mobile' : 'desktop'}.png`, all);
      for (const feature of state.features) {
        await page.selectOption('#inspection', `feature:${feature.id}`);
        const inspected = await capture(page, `asset-feature-${planet}-${feature.id}-${mobile ? 'mobile' : 'desktop'}`);
        assert.equal(inspected.featureFocus, feature.id);
        const focused = await canvasOnly(page);
        await page.evaluate(id => window.necrofallStudies.setFeatureVisibility(id, false), feature.id);
        const contribution = await pixelDifference(focused, await canvasOnly(page), 1);
        await page.evaluate(id => window.necrofallStudies.setFeatureVisibility(id, true), feature.id);
        assert(contribution.changed > 50, `${planet}/${feature.id}: the selected feature must be visible in its inspection view`);
        await layoutCheck(page);
      }
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/feature-visibility-report.json`, JSON.stringify(visibilityReport, null, 2));
  console.log(`PASS: ${visibilityReport.length} composed feature contributions and ${report.length} individual feature views${selected.includes('saffron-waste') ? ', plus independent rising heat motion' : ''}.`);
}

try {
  if (process.argv.includes('--visibility')) {
    await checkFeatureVisibility();
  } else if (process.argv.includes('--bases')) {
    await checkBases();
  } else if (process.argv.includes('--states')) {
    await checkStates();
  } else if (!process.argv.includes('--assets')) {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  monitor(desktop);
  await desktop.goto(`${base}concepts.html`);
  for (let index = 0; index < concepts.length; index++) {
    await desktop.locator(`[data-study="${index}"]`).click();
    await ready(desktop);
    for (const view of ['surface', 'fauna', 'orbit']) {
      await desktop.locator(`button[data-view="${view}"]`).click();
      const state = await capture(desktop, `desktop-${concepts[index]}-${view}`);
      assert.equal(state.study, concepts[index]);
      assert.equal(state.view, view);
      if (view === 'fauna') assert.equal(state.creatures, 3);
    }
  }
  const before = await desktop.evaluate(() => window.necrofallStudies.snapshot);
  await desktop.mouse.move(750, 380);
  await desktop.mouse.down();
  await desktop.mouse.move(910, 410, { steps: 12 });
  await desktop.mouse.up();
  const moved = await ready(desktop);
  assert.notDeepEqual(moved.camera, before.camera, 'Orbit controls must move the camera');
  await desktop.locator('#reset').click();
  await desktop.locator('#choose').click();
  await desktop.reload();
  assert.equal((await ready(desktop)).selected, 'frostwound', 'Selection must survive reload');
  await desktop.locator('#regenerate').click();
  const regenerated = await ready(desktop);
  assert.notEqual(regenerated.seed, before.seed, 'New seed must change the world seed');
  await desktop.locator('#seed').fill('0');
  await desktop.locator('#seed').press('Tab');
  assert.equal((await ready(desktop)).seed, 0, 'Seed zero must be accepted');
  const deterministic = await desktop.evaluate(async () => {
    const { heightAt } = await import('/src/concepts/procedural.ts');
    const { randomSource, STUDIES } = await import('/src/concepts/definitions.ts');
    const first = randomSource(0), second = randomSource(0);
    return { repeat: Array.from({ length: 30 }, () => first() === second()).every(Boolean),
      heights: STUDIES.map((study) => [heightAt(17, -63, study, 0), heightAt(17, -63, study, 0), heightAt(17, -63, study, 991)]) };
  });
  assert(deterministic.repeat);
  for (const heights of deterministic.heights) { assert.equal(heights[0], heights[1]); assert.notEqual(heights[0], heights[2]); }
  await desktop.locator('#motion').click();
  const paused = await desktop.evaluate(() => window.necrofallStudies.snapshot.elapsed);
  await desktop.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await desktop.evaluate(() => window.necrofallStudies.snapshot.elapsed), paused, 'Pause must stop procedural animation time');
  const download = desktop.waitForEvent('download');
  await desktop.locator('#capture').click();
  assert((await download).suggestedFilename().endsWith('.png'));
  await desktop.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  monitor(mobile);
  for (let index = 0; index < concepts.length; index++) {
    await mobile.goto(`${base}concepts.html?planet=${concepts[index]}`);
    const state = await capture(mobile, `mobile-${concepts[index]}-surface`);
    assert.equal(state.mobile, true);
    assert.equal(state.canvas.width, 390, 'Mobile DPR cap must apply');
  }
  await mobile.locator('button[data-view="fauna"]').click();
  assert.equal((await capture(mobile, 'mobile-frostwound-fauna')).creatures, 1);
  await mobile.locator('[data-creature="0"]').click();
  await capture(mobile, 'mobile-frostwound-swarmer');
  await mobile.locator('button[data-view="orbit"]').click();
  await capture(mobile, 'mobile-frostwound-orbit');
  await mobile.setViewportSize({ width: 844, height: 390 });
  await mobile.locator('button[data-view="surface"]').click();
  await capture(mobile, 'landscape-frostwound-surface');
  await mobile.locator('button[data-view="fauna"]').click();
  await capture(mobile, 'landscape-frostwound-fauna');
  await mobile.close();

  const fallback = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  monitor(fallback);
  await fallback.goto(`${base}concepts.html?backend=webgl&quality=mobile`);
  assert.equal((await capture(fallback, 'webgl-cinderbloom-surface')).backend, 'WEBGL 2');
  await fallback.locator('button[data-view="orbit"]').click();
  await capture(fallback, 'webgl-cinderbloom-orbit');
  await fallback.close();
  assert.deepEqual(errors, [], 'Browser console errors');
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.length} rendered views; pixel, layout, budget, deterministic seed, selection, camera, pause, capture, and fallback checks.`);
  } else {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    monitor(desktop);
    await desktop.goto(`${base}concepts.html?assets=1`);
    for (let index = 0; index < concepts.length; index++) {
      await desktop.locator(`button[data-study="${index}"]`).click();
      await ready(desktop);
      for (const view of ['surface', 'orbit']) {
        await desktop.locator(`button[data-view="${view}"]`).click();
        const state = await capture(desktop, `asset-${concepts[index]}-${view}`);
        assert.equal(state.study, concepts[index]);
        if (view === 'surface') assert(state.grassBlades > 0, 'Each biome must retain its intended patch grass');
      }
      await desktop.locator('button[data-view="surface"]').click();
      await ready(desktop);
      for (const inspection of ['terrain', 'grass', 'water', 'trees', 'rocks']) {
        await desktop.selectOption('#inspection', inspection);
        const state = await capture(desktop, `asset-${concepts[index]}-${inspection}`);
        assert.equal(state.inspection, inspection);
        assert.equal(state.creatures, 0, 'Asset inspection must isolate the environment');
      }
    }
    await desktop.locator('button[data-study="0"]').click();
    await ready(desktop);
    for (const view of ['surface', 'fauna', 'orbit']) {
      await desktop.locator(`button[data-view="${view}"]`).click();
      const state = await capture(desktop, `asset-desktop-${view}`);
      assert.equal(state.assets, true);
      assert.equal(state.creatures, view === 'orbit' ? 0 : 1);
      if (view === 'fauna') {
        const bounds = state.specimenBounds;
        assert(bounds.min[0] > -5 && bounds.max[0] < 5 && bounds.min[2] > -5 && bounds.max[2] < 5, 'The imported rig must remain near its inspection anchor');
        assert(bounds.max[1] > 2 && bounds.min[1] > -0.6, 'The posed model must remain above the inspection floor');
        await desktop.waitForFunction((elapsed) => window.necrofallStudies.snapshot.elapsed > elapsed + 0.45, state.elapsed);
        assert.notDeepEqual((await desktop.evaluate(() => window.necrofallStudies.snapshot)).specimenBounds, bounds, 'The imported skeleton must animate');
      }
    }
    assert.equal(await desktop.locator('button[data-study]:disabled').count(), 0, 'All planet concepts must be available');
    const forms = await desktop.evaluate(async () => {
      const { landscapeHeight } = await import('/src/concepts/AssetLandscape.ts');
      const { STUDIES } = await import('/src/concepts/definitions.ts');
      return STUDIES.map((study) => [-55, 0, 55].map((positionX) => landscapeHeight(positionX, -65, 7319, study)));
    });
    assert.equal(new Set(forms.map((form) => JSON.stringify(form))).size, concepts.length, 'Planets must change landforms, not only colors');
    const credits = await desktop.locator('.archive-bottom a').getAttribute('href');
    const response = await desktop.request.get(new URL(credits, base).href);
    assert(response.ok());
    assert((await response.text()).includes('DM-913'));
    assert((await response.text()).includes('QumoDone'));
    const before = await desktop.evaluate(() => window.necrofallStudies.snapshot);
    await desktop.mouse.move(750, 380);
    await desktop.mouse.down();
    await desktop.mouse.move(910, 410, { steps: 12 });
    await desktop.mouse.up();
    assert.notDeepEqual((await ready(desktop)).camera, before.camera);
    await desktop.locator('#regenerate').click();
    assert.notEqual((await ready(desktop)).seed, before.seed);
    await desktop.locator('#choose').click();
    await desktop.reload();
    assert.equal((await ready(desktop)).selected, 'cinderbloom');
    await desktop.locator('#motion').click();
    const paused = await desktop.evaluate(() => window.necrofallStudies.snapshot.elapsed);
    await desktop.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await desktop.evaluate(() => window.necrofallStudies.snapshot.elapsed), paused);
    await desktop.close();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    monitor(mobile);
    await mobile.goto(`${base}concepts.html?assets=1`);
    for (let index = 0; index < concepts.length; index++) {
      await mobile.locator(`button[data-study="${index}"]`).click();
      await ready(mobile);
      await mobile.locator('button[data-view="surface"]').click();
      await capture(mobile, `asset-mobile-${concepts[index]}-surface`);
      for (const inspection of ['grass', 'water', 'trees']) {
        await mobile.selectOption('#inspection', inspection);
        await capture(mobile, `asset-mobile-${concepts[index]}-${inspection}`);
      }
    }
    for (const view of ['surface', 'fauna', 'orbit']) {
      await mobile.locator(`button[data-view="${view}"]`).click();
      const state = await capture(mobile, `asset-mobile-${view}`);
      assert.equal(state.canvas.width, 390);
    }
    await mobile.setViewportSize({ width: 844, height: 390 });
    await mobile.locator('button[data-view="surface"]').click();
    await capture(mobile, 'asset-landscape-surface');
    await mobile.close();

    const fallback = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    monitor(fallback);
    await fallback.goto(`${base}concepts.html?assets=1&backend=webgl&quality=mobile`);
    assert.equal((await capture(fallback, 'asset-webgl-surface')).backend, 'WEBGL 2');
    await fallback.locator('button[data-view="fauna"]').click();
    await capture(fallback, 'asset-webgl-fauna');
    await fallback.locator('button[data-view="surface"]').click();
    await ready(fallback);
    await fallback.selectOption('#inspection', 'water');
    await capture(fallback, 'asset-webgl-water');
    await fallback.locator('button[data-study="3"]').click();
    await ready(fallback);
    await fallback.selectOption('#inspection', 'trees');
    await capture(fallback, 'asset-webgl-fungi');
    await fallback.close();
    assert.deepEqual(errors, [], 'Browser console errors');
    await writeFile(`${output}/asset-report.json`, JSON.stringify(report, null, 2));
    await writeComparisonSheets();
    console.log(`PASS: ${report.length} environment views; ${concepts.length} landforms, isolated asset views, original-style grass, enemy regression, pixels, layouts, budgets, camera, selection, credits and WebGL fallback.`);
  }
} finally {
  await browser.close();
  await server.close();
}