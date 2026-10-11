import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, normalizePath } from 'vite';
import { chromium } from '@playwright/test';

const baselinePath = normalizePath(resolve('src/enemies/imported/TerrainRig.baseline.ts'));
const server = await createServer({
  cacheDir: '.test-shots/vite-match-performance',
  plugins: [{
    name: 'match-performance-baseline', enforce: 'pre',
    resolveId(id) {
      if (id === '/match-test-three.js') return '\0match-test-three';
      if (id === '/match-test-peer.js') return '\0match-test-peer';
      if (id === '/match-baseline.ts') return baselinePath;
    },
    async load(id) {
      if (id === '\0match-test-three') return "export * from 'three/webgpu';";
      if (id === '\0match-test-peer') return "export { util } from 'peerjs';";
      if (id !== baselinePath) return;
      return (await readFile('src/enemies/imported/TerrainRig.ts', 'utf8'))
        .replace('this.point.setFromMatrixPosition(this.root.matrixWorld);', 'this.root.getWorldPosition(this.point);')
        .replace('foot.wanted.copy(foot.home).applyMatrix4(this.root.matrixWorld);', 'this.root.localToWorld(foot.wanted.copy(foot.home));')
        .replace('foot.target.position.applyMatrix4(this.targetInverse);', 'foot.target.parent!.worldToLocal(foot.target.position);');
    },
  }],
  server: { host: '127.0.0.1', port: 5216, watch: null, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const directory = '.test-shots/match-performance';
await mkdir(directory, { recursive: true });
const report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}?enemyLab=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.enemyLab?.visual?.clock > 0.1, {}, { timeout: 60000 });
  report.rigs = await page.evaluate(async () => {
    const THREE = await import('/match-test-three.js');
    const { TerrainRig: Baseline } = await import('/match-baseline.ts');
    const { ImportedVisual } = await import('/src/enemies/imported/ImportedVisual.ts');
    window.enemyLab.renderer.setAnimationLoop(null);
    const results = [];
    for (const base of ['crawler', 'parasite', 'behemoth']) {
      const anatomy = { ...window.enemyLab.anatomy, base, headBase: base, armBase: base, tailBase: base, size: 2, wings: false };
      const optimized = await ImportedVisual.create(base, 2, anatomy);
      const baseline = await ImportedVisual.create(base, 2, anatomy);
      let maxPoseError = 0, optimizedUpdates = 0, baselineUpdates = 0;
      const original = THREE.Object3D.prototype.updateWorldMatrix;
      let calls = 0;
      THREE.Object3D.prototype.updateWorldMatrix = function (...args) { calls++; return original.apply(this, args); };
      try {
        for (let frame = 0; frame < 120; frame++) {
          for (const visual of [optimized, baseline]) {
            visual.root.position.set(Math.sin(frame / 80), 100, frame * 0.06);
            visual.root.rotation.y = frame * 0.003;
          }
          const motion = { ground: (point, up, reach, out) => { out.copy(point).setY(100 + point.x * 0.05); return true; },
            attack: frame > 70 ? 'stomp' : undefined, attackPhase: frame > 70 ? (frame - 70) / 50 : 0 };
          calls = 0; optimized.locomotion.update(1 / 60, false, motion); optimizedUpdates += calls;
          calls = 0; Baseline.prototype.update.call(baseline.locomotion, 1 / 60, false, motion); baselineUpdates += calls;
          const first = [], second = [];
          optimized.root.traverse(object => { if (object.isBone) first.push(...object.matrixWorld.elements); });
          baseline.root.traverse(object => { if (object.isBone) second.push(...object.matrixWorld.elements); });
          if (first.length !== second.length) throw new Error('Bone count changed');
          for (let index = 0; index < first.length; index++) maxPoseError = Math.max(maxPoseError, Math.abs(first[index] - second[index]));
        }
      } finally { THREE.Object3D.prototype.updateWorldMatrix = original; optimized.dispose(); baseline.dispose(); }
      results.push({ base, maxPoseError, optimizedUpdates, baselineUpdates });
    }
    return results;
  });
  for (const rig of report.rigs) {
    assert.ok(rig.maxPoseError < 1e-10, `Rig pose changed: ${JSON.stringify(rig)}`);
    assert.ok(rig.optimizedUpdates < rig.baselineUpdates, `No transform saving: ${JSON.stringify(rig)}`);
  }
  report.grafts = await page.evaluate(async () => {
    const THREE = await import('/match-test-three.js');
    const lab = window.enemyLab;
    const results = [];
    for (const base of ['crawler', 'parasite', 'behemoth']) {
      const donor = base === 'parasite' ? 'crawler' : 'parasite';
      await lab.setAnatomy({ ...lab.anatomy, base, armBase: base, headBase: donor, tailBase: donor, tail: 1, size: 2 });
      let bindings = 0, samples = 0, maxPositionError = 0, maxNormalError = 0;
      const point = new THREE.Vector3(), inverse = new THREE.Matrix4();
      for (let frame = 0; frame < 60; frame++) {
        lab.tick(1 / 60);
        for (const join of lab.visual.joins) {
          bindings += join.bindings.length; samples += join.samples.length;
          inverse.copy(join.mesh.matrixWorld).invert();
          const expected = join.mesh.geometry.clone();
          for (const [index, binding] of join.bindings.entries()) {
            const { surface, vertex } = binding;
            surface.probe.bindMatrix.copy(surface.mesh.bindMatrix);
            surface.probe.bindMatrixInverse.copy(surface.mesh.bindMatrixInverse);
            surface.probe.getVertexPosition(vertex, point).applyMatrix4(surface.mesh.matrixWorld).applyMatrix4(inverse);
            expected.attributes.position.setXYZ(index, point.x, point.y, point.z);
          }
          expected.computeVertexNormals();
          for (const name of ['position', 'normal']) {
            const actual = join.mesh.geometry.attributes[name].array;
            const wanted = expected.attributes[name].array;
            for (let index = 0; index < actual.length; index++) {
              const error = Math.abs(actual[index] - wanted[index]);
              if (name === 'position') maxPositionError = Math.max(maxPositionError, error);
              else maxNormalError = Math.max(maxNormalError, error);
            }
          }
          expected.dispose();
        }
      }
      results.push({ base, bindings, samples, maxPositionError, maxNormalError });
    }
    return results;
  });
  for (const graft of report.grafts) {
    assert.equal(graft.maxPositionError, 0);
    assert.equal(graft.maxNormalError, 0);
    assert.ok(graft.samples > 0 && graft.samples < graft.bindings);
  }
  report.network = await page.evaluate(async () => {
    const { NetworkManager } = await import('/src/networking/Networking.ts');
    const { OfficialP2PLink } = await import('/src/app/multiplayer/OfficialP2PLink.ts');
    const { Game } = await import('/src/core/Game.ts');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const network = new NetworkManager({});
    const delivered = [];
    const connection = { open: true, bufferSize: 0, dataChannel: { bufferedAmount: 0 }, send: msg => delivered.push(structuredClone(msg)) };
    let serialized = 0;
    const snapshot = { t: 's', en: Array.from({ length: 150 }, (_, index) => ({ id: index + 1, type: index % 12,
      x: index / 10, y: 100, z: -index / 10, hp: index * 100, flags: index % 32, gen: index % 3, stn: 47 })) };
    const game = { net: network, players: new Map([['peer', { toNet: () => ({ id: 'peer', hp: 73, sh: 28, mut: 7, lvl: 9, alive: true }) }]]),
      enemies: { serialize: () => { serialized++; return snapshot.en; } }, towers: { serialize: () => [{ idx: 1, state: 'boss' }] },
      pickups: [], matchElapsed: 120, authorityTickMs: 0 };
    Game.prototype.publishSnapshot.call(game, 1);
    check(serialized === 0, 'Offline match serialized a snapshot');
    network.conns.set('peer', connection);
    Game.prototype.publishSnapshot.call(game, 2);
    check(serialized === 1 && delivered.length === 1 && delivered[0].en.length === 150, 'Direct snapshot missing');
    const events = ['pdmg', 'ehits', 'edie', 'st', 'cast', 'pickup', 'hostgone'].map(t => ({ t, value: 19 }));
    for (const backlog of ['native', 'peerjs']) {
      delivered.length = 0;
      connection.dataChannel.bufferedAmount = backlog === 'native' ? 65537 : 0;
      connection.bufferSize = backlog === 'peerjs' ? 1 : 0;
      for (let tick = 0; tick < 120; tick++) network.broadcast({ ...snapshot, time: tick });
      for (const event of events) network.broadcast(event);
      check(JSON.stringify(delivered) === JSON.stringify(events), `${backlog}: reliable events lost or stale snapshots queued`);
      connection.dataChannel.bufferedAmount = 0; connection.bufferSize = 0;
      network.broadcast({ ...snapshot, time: 121 });
      check(delivered.at(-1).time === 121 && delivered.at(-1).en.length === 150, 'Recovery did not send current full state');
    }
    const fast = [];
    network.conns.set('fast', { ...connection, send: msg => fast.push(msg) });
    connection.dataChannel.bufferedAmount = 65537;
    network.broadcast(snapshot);
    check(fast.length === 0, 'Shared fake channel should be blocked');
    network.conns.set('fast', { ...connection, dataChannel: { bufferedAmount: 0 }, send: msg => fast.push(msg) });
    network.broadcast(snapshot);
    check(fast.length === 1, 'Slow peer blocked healthy peer');
    network.conns.clear(); network.online = false;
    const relay = [];
    network.relay = { send() {}, broadcast: msg => relay.push(msg) };
    Game.prototype.publishSnapshot.call(game, 3);
    check(relay.length === 1 && relay[0].pl[0].hp === 73 && relay[0].en.length === 150, 'Official snapshot suppressed by offline signalling');
    const link = new OfficialP2PLink(() => {}, () => {});
    link.conns.set(1, connection);
    delivered.length = 0;
    check(link.send(1, snapshot), 'Congested direct snapshot incorrectly requested relay fallback');
    check(delivered.length === 0, 'Official direct queued stale snapshot');
    for (const event of events) check(link.send(1, event), 'Official event requested fallback');
    check(JSON.stringify(delivered) === JSON.stringify(events), 'Official reliable events changed');
    connection.dataChannel.bufferedAmount = 0;
    check(link.send(1, snapshot) && delivered.at(-1).en.length === 150, 'Official direct recovery failed');
    link.conns.delete(1);
    check(!link.send(1, snapshot), 'Disconnected peer did not request relay fallback');
    return { enemies: 150, skippedStaleSnapshots: 240, reliableEventKinds: events.length, direct: true, hybrid: true, recovery: true };
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.necrofallShell));
  await page.evaluate(() => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    shell.soloRunActive = true; shell.lastSoloMode = 'freeroam'; shell.hideShell(true);
    game.startSoloRun({ mode: 'freeroam', planetKey: '', ring: 0, universeSeed: 23, seed: 23, colony: 0 });
  });
  await page.waitForFunction(() => window.necrofall?.phase === 'playing' && window.necrofall.envWorld?.ecology, {}, { timeout: 60000 });
  await page.evaluate(async () => {
    const { Vector3 } = await import('/match-test-three.js');
    const game = window.necrofall;
    game.update = () => {}; game.ticker.update = () => {};
    game.enemies.reset();
    const up = game.envWorld.deps.system.sunDirection.clone().normalize();
    const side = new Vector3().crossVectors(up, new Vector3(0, 1, 0)).normalize();
    const forward = new Vector3().crossVectors(side, up).normalize();
    const center = up.clone().multiplyScalar(game.planet.meshHeightAtDir(up.x, up.y, up.z));
    game.localPlayer.position.copy(center); game.localPlayer.up.copy(up);
    const genomes = game.enemies.bestiary.genomes.filter(genome => genome.tier !== 'boss' && genome.tier !== 'nexus');
    for (let index = 0; index < 50; index++) {
      const angle = index * Math.PI * 2 / 50;
      game.enemies.spawn(genomes[index % genomes.length].idx, center.clone()
        .addScaledVector(side, Math.cos(angle) * (20 + index % 5 * 3))
        .addScaledVector(forward, Math.sin(angle) * (20 + index % 5 * 3)));
    }
  });
  await page.waitForFunction(() => window.necrofall.enemies.enemies.every(enemy => enemy.imported), {}, { timeout: 60000 });
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 100 });
  await session.send('Profiler.start');
  report.crowd = await page.evaluate(() => {
    const game = window.necrofall, times = [];
    for (let frame = 0; frame < 120; frame++) {
      const start = performance.now();
      game.clock += 1 / 60;
      game.enemies.update(1 / 60);
      times.push(performance.now() - start);
    }
    times.sort((first, second) => first - second);
    return { enemies: game.enemies.aliveCount, medianEnemyMs: times[60], p95EnemyMs: times[114] };
  });
  const { profile } = await session.send('Profiler.stop');
  report.hotspots = profile.nodes.filter(node => node.hitCount).sort((first, second) => second.hitCount - first.hitCount)
    .slice(0, 15).map(node => ({ name: node.callFrame.functionName, url: node.callFrame.url, samples: node.hitCount }));
  await writeFile(`${directory}/crowd.cpuprofile`, JSON.stringify(profile));
  assert.equal(report.crowd.enemies, 50);
  const receiver = await browser.newPage({ viewport: { width: 390, height: 844 } });
  receiver.on('pageerror', error => errors.push(error.message));
  await receiver.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await receiver.waitForFunction(() => Boolean(window.necrofallShell));
  await receiver.evaluate(() => {
    const shell = window.necrofallShell, game = shell.ensureGame();
    shell.soloRunActive = true; shell.lastSoloMode = 'freeroam'; shell.hideShell(true);
    game.startSoloRun({ mode: 'freeroam', planetKey: '', ring: 0, universeSeed: 23, seed: 23, colony: 0 });
  });
  await receiver.waitForFunction(() => window.necrofall?.phase === 'playing', {}, { timeout: 60000 });
  await receiver.evaluate(async () => {
    const { util } = await import('/match-test-peer.js');
    const game = window.necrofall;
    game.update = () => {}; game.ticker.update = () => {};
    game.isHost = false; game.net.isHost = false;
    game.net.myId = 'test-client'; game.localPlayer.id = 'test-client';
    game.players.clear(); game.players.set('test-client', game.localPlayer);
    window.receivedSnapshots = [];
    window.testPeer = new RTCPeerConnection({ iceServers: [] });
    window.testPeer.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = ({ data }) => {
        const message = util.unpack(data);
        game.onNetMessage('solo', message);
        if (message.t === 's') window.receivedSnapshots.push(message);
      };
    };
  });
  await page.evaluate(async () => {
    const { util } = await import('/match-test-peer.js');
    window.testPeer = new RTCPeerConnection({ iceServers: [] });
    window.testChannel = window.testPeer.createDataChannel('snapshot-test', { ordered: true });
    const channel = window.testChannel;
    window.necrofall.net.conns.set('test-client', { get open() { return channel.readyState === 'open'; },
      bufferSize: 0, dataChannel: channel, send: message => channel.send(util.pack(message)) });
    await window.testPeer.setLocalDescription(await window.testPeer.createOffer());
  });
  await page.waitForFunction(() => window.testPeer.iceGatheringState === 'complete');
  const offer = await page.evaluate(() => window.testPeer.localDescription.toJSON());
  await receiver.evaluate(async offer => {
    await window.testPeer.setRemoteDescription(offer);
    await window.testPeer.setLocalDescription(await window.testPeer.createAnswer());
  }, offer);
  await receiver.waitForFunction(() => window.testPeer.iceGatheringState === 'complete');
  const answer = await receiver.evaluate(() => window.testPeer.localDescription.toJSON());
  await page.evaluate(answer => window.testPeer.setRemoteDescription(answer), answer);
  await page.waitForFunction(() => window.testChannel.readyState === 'open');
  await page.evaluate(() => window.necrofall.publishSnapshot(performance.now() / 1000));
  await receiver.waitForFunction(() => window.receivedSnapshots.length === 1);
  const checkReplica = () => {
    const game = window.necrofall, message = window.receivedSnapshots.at(-1);
    for (const snapshot of message.en) {
      const enemy = game.enemies.byId(snapshot.id);
      if (!enemy || enemy.hp !== snapshot.hp || enemy.genomeIdx !== snapshot.type || enemy.splitGen !== snapshot.gen
        || enemy.netTarget.x !== snapshot.x || enemy.netTarget.y !== snapshot.y || enemy.netTarget.z !== snapshot.z
        || enemy.enraged !== Boolean(snapshot.flags & 4)) throw new Error(`Enemy ${snapshot.id} diverged: ${JSON.stringify({ snapshot,
          actual: enemy && { hp: enemy.hp, type: enemy.genomeIdx, gen: enemy.splitGen, target: enemy.netTarget?.toArray(), enraged: enemy.enraged } })}`);
    }
    for (const player of message.pl) if (game.players.get(player.id)?.hp !== player.hp) throw new Error('Player health diverged');
    if (game.enemies.aliveCount !== message.en.length) throw new Error('Despawn diverged');
    return { enemies: message.en.length, players: message.pl.length, snapshots: window.receivedSnapshots.length };
  };
  report.webRTC = { initial: await receiver.evaluate(checkReplica) };
  await page.evaluate(() => {
    const game = window.necrofall;
    const enemy = game.enemies.enemies[0]; enemy.hp = 17; enemy.enraged = true;
    game.enemies.removeVisual(game.enemies.enemies.at(-1).id);
    game.localPlayer.hp = 61;
    game.publishSnapshot(performance.now() / 1000);
  });
  await receiver.waitForFunction(() => window.receivedSnapshots.length === 2);
  report.webRTC.updated = await receiver.evaluate(checkReplica);
  assert.equal(report.webRTC.initial.enemies, 50);
  assert.equal(report.webRTC.updated.enemies, 49);
  await receiver.evaluate(() => window.testPeer.close());
  await page.evaluate(() => window.testPeer.close());
  await receiver.close();
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: identical rig transforms and graft vertices/normals; offline/direct/hybrid snapshots; congested peer isolation; reliable events and recovery');
} finally { await browser.close(); await server.close(); }