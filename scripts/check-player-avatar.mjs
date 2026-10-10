import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const runtimeModule = '/avatar-test-three.js';
const server = await createServer({ cacheDir: '.test-shots/vite-avatar',
  plugins: [{ name: 'avatar-test-runtime', resolveId: id => id === runtimeModule ? id : undefined,
    load: id => id === runtimeModule ? 'export * from "three";' : undefined }],
  server: { host: '127.0.0.1', port: 5205, watch: null, hmr: false } });
await server.listen();
const directory = '.test-shots/player-avatar';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const report = {};
async function difference(before, after) {
  const first = await sharp(before).removeAlpha().raw().toBuffer();
  const second = await sharp(after).removeAlpha().raw().toBuffer();
  let pixels = 0;
  for (let offset = 0; offset < first.length; offset += 3) {
    if (Math.abs(first[offset] - second[offset]) + Math.abs(first[offset + 1] - second[offset + 1]) + Math.abs(first[offset + 2] - second[offset + 2]) > 25) pixels++;
  }
  return pixels;
}
async function verifyAvatar() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => {
    if (message.type() !== 'error' || /404|favicon|auth-proxy/.test(message.text())) return;
    if (/THREE\.|WebGPU|shader|GPUValidation/i.test(message.text())) errors.push(message.text());
    else (report.consoleMessages ??= []).push(message.text());
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.necrofallShell), {}, { timeout: 60000 });
  report.rig = await page.evaluate(async () => {
    const THREE = await import('/avatar-test-three.js');
    const { PlayerRig } = await import('/src/player/PlayerRig.ts');
    const { buildPlayerModel } = await import('/src/player/Player.ts');
    const { AvatarAccessories, disposeObject } = await import('/src/customization/AvatarAccessories.ts');
    const { defsOf } = await import('/src/customization/AccessoryCatalog.ts');
    const { COLONIES } = await import('/src/core/Config.ts');
    const { NECROTECHS } = await import('/src/necrotech/NecrotechData.ts');
    const { buildHeldWeapon } = await import('/src/necrotech/WeaponModels.ts');
    const { CosmeticFxRunner } = await import('/src/customization/CosmeticFx.ts');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const rig = new PlayerRig(COLONIES[0].color);
    check(rig.skeleton.bones.length === 19, 'Missing player bones');
    check(rig.root.userData.avatarRevision === 'classic-rounded-rig-v1', 'Incorrect classic avatar');
    const attributes = rig.mesh.geometry.attributes;
    const originalParts = [
      [[0.66, 0.72, 0.42], [0, 1.08, 0], 0],
      [[0.44, 0.42, 0.44], [0, 1.68, 0], 0],
      [[0.26, 0.72, 0.28], [-0.19, 0.36, 0], 1],
      [[0.26, 0.72, 0.28], [0.19, 0.36, 0], 1],
      [[0.18, 0.62, 0.2], [-0.45, 1.07, 0], 1],
      [[0.18, 0.62, 0.2], [0.45, 1.07, 0], 1],
      [[0.5, 0.3, 0.1], [0, 1.16, 0.22], 2],
      [[0.36, 0.14, 0.08], [0, 1.7, 0.22], 2],
      [[0.22, 0.22, 0.3], [-0.45, 1.35, 0], 2],
      [[0.22, 0.22, 0.3], [0.45, 1.35, 0], 2],
    ];
    check(rig.mesh.geometry.groups.length === originalParts.length, 'Original body parts changed');
    rig.mesh.geometry.groups.forEach((group, index) => {
      const bounds = new THREE.Box3();
      for (let offset = group.start; offset < group.start + group.count; offset++) {
        bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(attributes.position, rig.mesh.geometry.index.getX(offset)));
      }
      const [size, center, material] = originalParts[index];
      check(bounds.getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(...size)) < 0.0001, `Original part ${index} resized`);
      check(bounds.getCenter(new THREE.Vector3()).distanceTo(new THREE.Vector3(...center)) < 0.0001, `Original part ${index} moved`);
      check(group.materialIndex === material, `Original part ${index} recolored`);
      if (index === 0 || index >= 6) check(group.count === 36, `Original block ${index} remodeled`);
      else check(group.count > 100, `Part ${index} not rounded`);
    });
    check(rig.mesh.material[0].color.getHex() === 0x2a1f42 && rig.mesh.material[1].color.getHex() === 0x171126, 'Original dark colors changed');
    check(rig.accent.color.getHex() === COLONIES[0].color && rig.accent.emissiveIntensity === 0.45, 'Original accent changed');
    check(rig.pack.geometry.type === 'BoxGeometry' && rig.pack.geometry.parameters.width === 0.4 && rig.pack.geometry.parameters.height === 0.44 && rig.pack.geometry.parameters.depth === 0.2, 'Original backpack remodeled');
    for (const [socket, center] of [[rig.headMount, [0, 1.68, 0]], [rig.backMount, [0, 1.15, -0.28]], [rig.weaponMount, [0.45, 0.83, 0.22]]]) {
      check(socket.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...center)) < 0.0001 && socket.scale.equals(new THREE.Vector3(1, 1, 1)), 'Original accessory fit changed');
    }
    let blendedVertices = 0;
    for (let vertex = 0; vertex < attributes.position.count; vertex++) {
      let sum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const weight = attributes.skinWeight.getComponent(vertex, influence);
        check(attributes.skinIndex.getComponent(vertex, influence) < 19 && weight >= 0 && Number.isFinite(weight), 'Invalid skin binding');
        sum += weight;
      }
      check(Math.abs(sum - 1) < 0.0001, 'Unnormalized skin weights');
      if (attributes.skinWeight.getY(vertex) > 0) blendedVertices++;
    }
    check(blendedVertices > 100, 'Avatar has no smooth joint weights');
    const triangles = rig.mesh.geometry.index.array;
    const bodyIndices = triangles.length;
    const restPoints = Array.from({ length: attributes.position.count }, (_, vertex) => new THREE.Vector3().fromBufferAttribute(attributes.position, vertex));
    const posedPoints = restPoints.map(point => point.clone());
    const motion = { speed: 0, grounded: true, verticalSpeed: 0 };
    for (let frame = 0; frame < 90; frame++) rig.update(1 / 60, motion);
    rig.root.updateMatrixWorld(true);
    const feet = [rig.footL, rig.footR].map(foot => foot.getWorldPosition(new THREE.Vector3()));
    for (let frame = 0; frame < 120; frame++) rig.update(1 / 60, motion);
    rig.root.updateMatrixWorld(true);
    const idleDrift = Math.max(...[rig.footL, rig.footR].map((foot, index) => foot.getWorldPosition(new THREE.Vector3()).distanceTo(feet[index])));
    check(idleDrift < 0.001, `Idle foot drift ${idleDrift}`);
    const poses = {};
    for (const [state, sample] of Object.entries({ idle: motion, run: { ...motion, speed: 8 }, jump: { speed: 5, grounded: false, verticalSpeed: 8 }, fall: { speed: 5, grounded: false, verticalSpeed: -12 } })) {
      const knees = [], thighs = [], points = [];
      let maxStretch = 0;
      for (let frame = 0; frame < 120; frame++) {
        rig.update(1 / 60, sample);
        rig.root.updateMatrixWorld(true);
        knees.push(rig.kneeL.rotation.x);
        thighs.push(rig.legL.rotation.x);
        if (frame % 30 === 0) {
          points.push(rig.mesh.getVertexPosition(Math.floor(attributes.position.count / 2), new THREE.Vector3()).toArray());
          posedPoints.forEach((point, vertex) => rig.mesh.getVertexPosition(vertex, point));
          for (let offset = 0; offset < bodyIndices; offset += 3) for (let corner = 0; corner < 3; corner++) {
            const first = triangles[offset + corner], second = triangles[offset + (corner + 1) % 3];
            const rest = restPoints[first].distanceTo(restPoints[second]);
            if (rest > 0.003) maxStretch = Math.max(maxStretch, posedPoints[first].distanceTo(posedPoints[second]) / rest);
          }
        }
        check(rig.skeleton.bones.every(bone => bone.matrixWorld.elements.every(Number.isFinite)), `${state}: non-finite pose`);
      }
      check(rig.state === state, `Incorrect state ${state}`);
      check(maxStretch < 3.5, `${state}: stretched skin triangles (${maxStretch})`);
      poses[state] = { kneeRange: Math.max(...knees) - Math.min(...knees), thighRange: Math.max(...thighs) - Math.min(...thighs), maxStretch, points };
    }
    check(poses.run.kneeRange > 0.4, 'Run has no knee articulation');
    check(poses.fall.thighRange > 1, 'Fall has no panicking kicks');
    check(rig.handL.getWorldPosition(new THREE.Vector3()).x < -0.6 && rig.handR.getWorldPosition(new THREE.Vector3()).x > 0.6, 'Panic arms fold into the chest');
    const frozen = rig.skeleton.bones.map(bone => bone.quaternion.toArray());
    rig.update(1, { ...motion, frozen: true });
    check(JSON.stringify(frozen) === JSON.stringify(rig.skeleton.bones.map(bone => bone.quaternion.toArray())), 'Frozen pose changed');
    const scene = new THREE.Scene();
    const parts = buildPlayerModel(COLONIES[0].color);
    scene.add(parts.group);
    const accessories = new AvatarAccessories(parts.headMount, parts.backMount, parts.pack, scene);
    const catalog = {};
    for (const category of ['hat', 'backpack', 'pet']) {
      catalog[category] = defsOf(category).map(def => def.id);
      for (let index = 0; index < catalog[category].length; index++) {
        accessories.set({ hat: -1, backpack: -1, pet: -1, [category]: index });
        for (let frame = 0; frame < 12; frame++) {
          parts.rig.update(1 / 60, { speed: 8, grounded: false, verticalSpeed: -8 });
          accessories.tick(frame / 60, 1 / 60, 8);
          accessories.petCtl?.update(1 / 60, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), frame / 60, null);
        }
        check(parts.headMount.parent === parts.rig.head && parts.backMount.parent === parts.rig.chest, 'Detached accessory socket');
        check(parts.pack.visible === (category !== 'backpack'), 'Default pack not replaced');
        scene.updateMatrixWorld(true);
        scene.traverse(object => check(object.matrixWorld.elements.every(Number.isFinite), `${category}/${index}: invalid transform`));
      }
    }
    for (const weapon of NECROTECHS) {
      const model = buildHeldWeapon(weapon, weapon.stats.color);
      parts.weaponMount.add(model);
      parts.rig.update(1 / 60, { speed: 8, grounded: true, verticalSpeed: 0 });
      scene.updateMatrixWorld(true);
      check(parts.weaponMount.parent === parts.rig.handR && model.matrixWorld.elements.every(Number.isFinite), 'Detached weapon');
      model.removeFromParent(); disposeObject(model);
    }
    const fx = new CosmeticFxRunner(scene);
    for (const category of ['recall', 'spawn', 'eliminated']) {
      catalog[category] = defsOf(category).map(def => def.id);
      for (let index = 0; index < catalog[category].length; index++) {
        check(fx.play(category, index, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)), `Missing ${category}/${index}`);
        fx.update(0.2); fx.clear();
      }
    }
    accessories.dispose(); disposeObject(parts.group); disposeObject(rig.root);
    const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') });
    await renderer.init();
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x1c2429);
    renderer.domElement.id = 'avatar-test-canvas';
    renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:999999;width:100%;height:100%';
    document.body.append(renderer.domElement);
    const stage = new THREE.Scene();
    stage.add(new THREE.HemisphereLight(0xe1f4ff, 0x46413d, 2));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(3, 5, 4); stage.add(key);
    const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 30);
    camera.position.set(2.2, 2, 5.8); camera.lookAt(0, 1, 0);
    const avatar = buildPlayerModel(COLONIES[0].color);
    stage.add(avatar.group);
    const outfit = new AvatarAccessories(avatar.headMount, avatar.backMount, avatar.pack, stage);
    window.avatarTest = { THREE, renderer, stage, camera, avatar, outfit, defsOf, COLONIES, disposeObject };
    return { bones: 19, vertices: attributes.position.count, blendedVertices, idleDrift, poses, catalog, weapons: NECROTECHS.length };
  });
  for (const state of ['idle', 'run', 'jump', 'fall']) {
    await page.evaluate(state => {
      const { avatar, renderer, stage, camera } = window.avatarTest;
      const motion = { speed: state === 'idle' ? 0 : 8, grounded: state === 'idle' || state === 'run', verticalSpeed: state === 'jump' ? 8 : state === 'fall' ? -12 : 0 };
      for (let frame = 0; frame < 100; frame++) avatar.rig.update(1 / 60, motion);
      renderer.render(stage, camera);
    }, state);
    const visible = await page.screenshot({ path: `${directory}/${state}.png` });
    await page.evaluate(() => { const test = window.avatarTest; test.avatar.group.visible = false; test.renderer.render(test.stage, test.camera); });
    const hidden = await page.screenshot();
    assert.ok(await difference(visible, hidden) > 10000, `${state}: avatar missing`);
    await page.evaluate(state => {
      const test = window.avatarTest; test.avatar.group.visible = true;
      for (let frame = 0; frame < 10; frame++) test.avatar.rig.update(1 / 60, { speed: state === 'idle' ? 0 : 8, grounded: ['idle', 'run'].includes(state), verticalSpeed: state === 'jump' ? 8 : -12 });
      test.renderer.render(test.stage, test.camera);
    }, state);
    assert.ok(await difference(visible, await page.screenshot()) > 30, `${state}: animation not visible`);
  }
  if (process.argv.includes('--rig-only')) {
    assert.deepEqual(errors, [], 'Browser runtime errors');
    await writeFile(`${directory}/rig-report.json`, JSON.stringify(report.rig, null, 2));
    console.log(JSON.stringify({ bones: report.rig.bones, vertices: report.rig.vertices, blendedVertices: report.rig.blendedVertices, poses: report.rig.poses }, null, 2));
    return;
  }
  for (const category of ['hat', 'backpack', 'pet']) {
    for (let index = 0; index < report.rig.catalog[category].length; index++) {
      await page.evaluate(({ category, index }) => {
        const test = window.avatarTest;
        test.outfit.set({ hat: -1, backpack: -1, pet: -1, [category]: index });
        for (let frame = 0; frame < 90; frame++) {
          test.avatar.rig.update(1 / 60, { speed: 0, grounded: true, verticalSpeed: 0 });
          test.outfit.tick(frame / 60, 1 / 60, 0);
          test.outfit.petCtl?.update(1 / 60, new test.THREE.Vector3(), new test.THREE.Vector3(0, 1, 0), frame / 60, null);
        }
        test.camera.position.set(category === 'backpack' ? 2.8 : 2.2, 2, category === 'backpack' ? -5.8 : 5.8);
        test.camera.lookAt(0, 1.1, 0); test.renderer.render(test.stage, test.camera);
      }, { category, index });
      await page.screenshot({ path: `${directory}/${category}-${index}.png` });
    }
  }
  report.colors = [];
  for (let colony = 0; colony < 3; colony++) {
    await page.evaluate(colony => {
      const test = window.avatarTest;
      test.outfit.set({ hat: -1, backpack: -1, pet: -1 });
      const color = test.COLONIES[colony].color;
      test.avatar.rig.accent.color.setHex(color); test.avatar.rig.accent.emissive.setHex(color);
      test.camera.position.set(2.2, 2, 5.8); test.camera.lookAt(0, 1, 0);
      test.renderer.render(test.stage, test.camera);
    }, colony);
    const glowing = await page.screenshot({ path: `${directory}/colony-glow-${colony}.png` });
    await page.evaluate(() => { const test = window.avatarTest; test.avatar.rig.accent.emissiveIntensity = 0; test.renderer.render(test.stage, test.camera); });
    const pixels = await difference(glowing, await page.screenshot());
    assert.ok(pixels > 200, `Colony ${colony}: emissive pads not visible`);
    report.colors.push({ colony, pixels });
    await page.evaluate(() => { window.avatarTest.avatar.rig.accent.emissiveIntensity = 0.45; });
  }
  await page.evaluate(async () => {
    const test = window.avatarTest;
    test.renderer.dispose(); test.renderer.domElement.remove();
    test.renderer = new test.THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
    await test.renderer.init(); test.renderer.setSize(innerWidth, innerHeight); test.renderer.setClearColor(0x1c2429);
    test.renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:999999;width:100%;height:100%';
    document.body.append(test.renderer.domElement); test.renderer.render(test.stage, test.camera);
  });
  const fallback = await page.screenshot({ path: `${directory}/webgl.png` });
  await page.evaluate(() => { const test = window.avatarTest; test.avatar.group.visible = false; test.renderer.render(test.stage, test.camera); });
  report.webglPixels = await difference(fallback, await page.screenshot());
  assert.ok(report.webglPixels > 10000, 'WebGL avatar missing');
  await page.evaluate(() => {
    const test = window.avatarTest;
    test.outfit.dispose(); test.disposeObject(test.avatar.group); test.renderer.dispose(); test.renderer.domElement.remove();
    window.necrofallShell.ensureGame();
  });
  report.menus = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const mode of ['home', 'customize', 'colony', 'lobby']) {
      await page.evaluate(mode => {
        const shell = window.necrofallShell, game = window.necrofall;
        if (mode === 'home') shell.showShell('home');
        else {
          shell.hideShell(true); game.ui.hideShellAvatar();
          if (mode === 'lobby') {
            game.roster.clear();
            for (let index = 0; index < 3; index++) game.roster.set(`avatar-${index}`, { id: `avatar-${index}`, name: `Player ${index + 1}`, ready: true, colony: index, nt: 0, isHost: index === 0, me: index === 0, acc: `${index},${index},${index}` });
            game.ui.updateLobby('AVATAR', [...game.roster.values()], true, '', true, { official: true });
          }
          game.ui.show(mode);
        }
      }, mode);
      await page.waitForFunction(() => {
        const preview = window.necrofall?.ui.preview;
        return preview?.rendererReady && preview.t > 0.15 && preview.canvas.getBoundingClientRect().width > 0;
      }, {}, { timeout: 60000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const portrait = page.getByRole('button', { name: 'PLAY IN PORTRAIT ANYWAY' });
      if (await portrait.isVisible()) await portrait.click();
      const result = await page.evaluate(() => {
        const preview = window.necrofall.ui.preview;
        preview.stop(); preview.update(1 / 60);
        const rigs = [];
        preview.scene.traverse(object => { if (object.name === 'PlayerRig') rigs.push(object.userData.avatarRevision); });
        const camera = preview.mode === 'lobby' ? preview.lobbyCam : preview.camera;
        preview.scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
        let extent = 0;
        preview.scene.traverse(object => {
          if (object.name !== 'ClassicPlayerBody') return;
          const point = object.position.clone();
          for (let vertex = 0; vertex < object.geometry.attributes.position.count; vertex++) {
            object.getVertexPosition(vertex, point).applyMatrix4(object.matrixWorld).project(camera);
            extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
          }
        });
        return { rigs, extent, width: preview.canvas.width, height: preview.canvas.height };
      });
      assert.equal(result.rigs.length, ['colony', 'lobby'].includes(mode) ? 3 : 1, `${mode}: missing shared avatars`);
      assert.ok(result.rigs.every(revision => revision === 'classic-rounded-rig-v1'));
      assert.ok(result.extent < 1, `${mode}/${viewport.width}: clipped body (${result.extent})`);
      const canvas = page.locator('.sel-preview-canvas');
      const visible = await canvas.screenshot();
      await page.screenshot({ path: `${directory}/${mode}-${viewport.width}.png` });
      await page.evaluate(() => {
        const preview = window.necrofall.ui.preview;
        preview.scene.traverse(object => { if (object.name === 'PlayerRig') object.visible = false; });
        preview.renderer.render(preview.scene, preview.mode === 'lobby' ? preview.lobbyCam : preview.camera);
      });
      const pixels = await difference(visible, await canvas.screenshot());
      assert.ok(pixels > 100, `${mode}/${viewport.width}: blank avatar canvas (${pixels})`);
      report.menus.push({ mode, viewport, pixels, ...result });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const shell = window.necrofallShell, game = window.necrofall;
    game.ui.hideShellAvatar(); shell.hideShell(true); shell.soloRunActive = true;
    game.startSoloRun({ mode: 'freeroam', planetKey: '', ring: 0, universeSeed: 1, seed: 1, colony: 0 });
  });
  await page.waitForFunction(() => {
    const game = window.necrofall;
    return game.phase === 'playing' && game.envWorld?.ecology && game.localPlayer?.grounded && !game.localPlayer.frozen;
  }, {}, { timeout: 60000 });
  await page.evaluate(() => { const game = window.necrofall; game.localPlayer.invulnUntil = game.now + 100; });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.necrofall.localPlayer.parts.rig.state === 'run', {}, { timeout: 15000 });
  await page.screenshot({ path: `${directory}/gameplay-run.png` });
  await page.keyboard.up('KeyW');
  await page.evaluate(() => {
    window.avatarJumpStates = new Set();
    const rig = window.necrofall.localPlayer.parts.rig, update = rig.update.bind(rig);
    rig.update = (dt, motion) => { update(dt, motion); window.avatarJumpStates.add(rig.state); };
  });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.avatarJumpStates.has('jump') && window.avatarJumpStates.has('fall') && window.necrofall.localPlayer.grounded, {}, { timeout: 15000 });
  report.gameplay = await page.evaluate(async () => {
    const game = window.necrofall, player = game.localPlayer;
    game.update = () => {};
    const { Player } = await import('/src/player/Player.ts');
    const { Decoy } = await import('/src/player/Decoy.ts');
    const { COLONIES } = await import('/src/core/Config.ts');
    const { nowSec } = await import('/src/utils/Utils.ts');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    player.setAccessories({ ...player.accessorySelection, hat: 1, backpack: 0, pet: 3 });
    const remote = new Player(game, 'avatar-remote', 'Remote test', false);
    const states = [];
    for (const [gnd, vsp, expected] of [[1, 0, 'idle'], [0, 9, 'jump'], [0, -14, 'fall']]) {
      const snapshot = { ...player.toNet(nowSec()), id: remote.id, col: states.length, gnd, vsp };
      remote.resetNet(); remote.applyNet(snapshot, nowSec() - 0.1);
      for (let frame = 0; frame < 60; frame++) remote.update(1 / 60);
      check(remote.parts.rig.state === expected, `Remote did not enter ${expected}`);
      const forwarded = remote.toNet(nowSec());
      check(forwarded.gnd === gnd && forwarded.vsp === vsp, 'Relay lost motion state');
      check(forwarded.acc === snapshot.acc, 'Relay lost customization');
      check(remote.parts.rig.accent.emissive.getHex() === COLONIES[snapshot.col].color, 'Remote armor has wrong colony color');
      states.push(expected);
    }
    remote.resetNet();
    const legacy = player.toNet(nowSec()); delete legacy.gnd; delete legacy.vsp;
    remote.applyNet({ ...legacy, id: remote.id }, nowSec() - 0.1); remote.update(1 / 60);
    check(Number.isFinite(remote.parts.rig.legL.rotation.x), 'Legacy snapshot broke rig');
    const rig = player.parts.rig;
    player.spawnGhost(0.3, 0.3);
    const ghost = player.ghostPool[0].obj.getObjectByName('ClassicPlayerBody');
    check(ghost.skeleton !== rig.skeleton && ghost.skeleton.bones[0] !== rig.skeleton.bones[0], 'Dash ghost shares live bones');
    const frozenGhost = ghost.skeleton.bones.map(bone => bone.quaternion.toArray());
    const decoy = new Decoy('avatar-decoy', player, 1, player.position, player.up, player.facing);
    decoy.attach(game.scene, player.facing);
    const echo = decoy.ghost.getObjectByName('ClassicPlayerBody');
    check(echo.skeleton !== rig.skeleton, 'Decoy shares skeleton');
    rig.update(1 / 60, { speed: 8, grounded: false, verticalSpeed: -14 });
    check(JSON.stringify(frozenGhost) === JSON.stringify(ghost.skeleton.bones.map(bone => bone.quaternion.toArray())), 'Dash pose follows live animation');
    decoy.dispose(game.scene);
    for (let colony = 0; colony < 3; colony++) {
      player.setColony(colony);
      check(player.parts.rig.accent.emissive.getHex() === COLONIES[colony].color, 'Wrong colony pad color');
      check(player.parts.headMount.children.length > 0 && !player.parts.pack.visible && player.parts.weaponMount.children.length > 0, 'Colony swap lost equipped items');
    }
    player.alive = false; player.animate(1 / 60);
    check(player.model.visible && !player.parts.shieldBubble.visible, 'Corpse visibility failed');
    player.alive = true; player.frozen = false; player.grounded = true; player.animate(1 / 60);
    remote.dispose();
    return { jumpStates: [...window.avatarJumpStates], remoteStates: states, cloneIsolation: true, colonySwaps: 3 };
  });
  assert.deepEqual(errors, [], 'Browser runtime errors');
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ bones: report.rig.bones, catalog: Object.fromEntries(Object.entries(report.rig.catalog).map(([key, value]) => [key, value.length])), weapons: report.rig.weapons, menus: report.menus.length, gameplay: report.gameplay, webglPixels: report.webglPixels, consoleMessages: report.consoleMessages ?? [] }, null, 2));
}
try {
  await verifyAvatar();
} finally {
  await browser.close();
  await server.close();
}