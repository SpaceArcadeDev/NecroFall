import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { BoxGeometry, BufferAttribute, BufferGeometry, DataTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Ray, Vector3 } from 'three/webgpu';
import { color, uniform, vec2, vec4 } from 'three/tsl';
import { MeshBVH } from 'three-mesh-bvh';

const server = await createServer({ cacheDir: '.test-shots/vite-physics', server: { middlewareMode: true, watch: null, hmr: false } });
globalThis.window = { location: { search: '', hash: '' } };
try {
  const { daylightAt, twilightAt } = await server.ssrLoadModule('/src/rendering/Environment/Daylight.ts');
  let previousDaylight = 0;
  for (let index = 0; index <= 2000; index++) {
    const elevation = index / 1000 - 1, daylight = daylightAt(elevation);
    assert.ok(daylight >= previousDaylight && daylight - previousDaylight < 0.002);
    assert.ok(twilightAt(elevation) >= 0 && twilightAt(elevation) <= 1);
    previousDaylight = daylight;
  }
  assert.equal(daylightAt(-0.38), 0); assert.equal(daylightAt(0.48), 1);
  assert.ok(daylightAt(0) > 0.3 && daylightAt(0) < 0.5 && twilightAt(0) > 0.95);
  console.log('Daylight: 2001 monotonic samples with broad warm twilight and continuous transitions');
  const { classicPlanetSeed, rollClassicMatchSeed, basePlanetIndex } = await server.ssrLoadModule('/src/planet/BasePlanetProfile.ts');
  let randomState = 317, previousSeed;
  const profiles = new Set();
  for (let match = 0; match < 200; match++) {
    const seed = rollClassicMatchSeed(previousSeed, () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; });
    const planetSeed = classicPlanetSeed(seed);
    assert.equal(planetSeed, Number((BigInt(seed) * 2654435761n) & 0xffffffffn));
    if (previousSeed !== undefined) assert.notEqual(basePlanetIndex(planetSeed), basePlanetIndex(previousSeed));
    profiles.add(basePlanetIndex(planetSeed)); previousSeed = planetSeed;
  }
  assert.equal(profiles.size, 10);
  console.log('Classic: exact 32-bit seeds, 200 fresh matches, all ten bases, no consecutive base repeats');
  const { createRenderedRadiusAt, createTerrainIndices, TERRAIN_RES_X: width, TERRAIN_RES_Y: height } = await server.ssrLoadModule('/src/planet/RenderedTerrain.ts');
  const generator = { radiusAt: (axisX, axisY, axisZ) => 118 + Math.sin(axisX * 23) * 12 + Math.cos(axisZ * 19) * 7 + axisY * 5 };
  const sample = createRenderedRadiusAt(generator);
  const positions = new Float32Array(width * (height + 1) * 3);
  for (let row = 0; row <= height; row++) for (let column = 0; column < width; column++) {
    const axisY = Math.cos(row / height * Math.PI), ring = Math.sqrt(Math.max(0, 1 - axisY * axisY));
    const angle = (column / width - 0.5) * Math.PI * 2, axisX = ring * Math.cos(angle), axisZ = ring * Math.sin(angle);
    const radius = generator.radiusAt(axisX, axisY, axisZ), offset = (row * width + column) * 3;
    positions.set([axisX * radius, axisY * radius, axisZ * radius], offset);
  }
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new BufferAttribute(positions, 3)); geometry.setIndex(new BufferAttribute(createTerrainIndices(width, height), 1));
  const tree = new MeshBVH(geometry), ray = new Ray();
  let worst = 0;
  for (let index = 0; index < 1600; index++) {
    const axisY = index / 1599 * 2 - 1, angle = index * 2.399963229728653, ring = Math.sqrt(Math.max(0, 1 - axisY * axisY));
    ray.direction.set(ring * Math.cos(angle), axisY, ring * Math.sin(angle));
    const expected = tree.raycastFirst(ray, DoubleSide);
    assert.ok(expected, `Missing reference triangle at ${index}`);
    worst = Math.max(worst, Math.abs(sample(ray.direction) - expected.distance));
  }
  assert.ok(worst < 0.0001, `Triangle height mismatch: ${worst}`);
  console.log(`Triangle sampler: 1600 directions including poles, max error ${worst.toExponential(2)} m`);

  const { PlanetObstacles } = await server.ssrLoadModule('/src/planet/PlanetObstacles.ts');
  const obstacles = new PlanetObstacles(100);
  const floor = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2).translate(0, 100, 0), new MeshBasicMaterial());
  const wall = new Mesh(new BoxGeometry(0.2, 5, 6).translate(0, 102.5, 0), new MeshBasicMaterial());
  obstacles.addMesh(floor); obstacles.addMesh(wall); obstacles.build();
  assert.ok(Math.abs(obstacles.supportRadius(new Vector3(0, 105.1, 0), 0.1) - 105) < 0.001);
  const feet = new Vector3(-4, 100, 0), velocity = new Vector3(100, 0, 0);
  obstacles.move(feet, velocity, 0.1, 0.4, false);
  assert.ok(feet.x < -0.45, `Tunneled through wall: ${feet.toArray()}`);
  assert.ok(feet.y >= 99.99);
  console.log('Mesh collisions: roof support, capsule contact and thin-wall dash passed');
  obstacles.dispose(); geometry.dispose(); floor.geometry.dispose(); wall.geometry.dispose();

  const climbing = new PlanetObstacles(100);
  const angle = 75 * Math.PI / 180;
  const slope = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2).rotateZ(angle).translate(0, 100, 0), new MeshBasicMaterial());
  climbing.addMesh(slope); climbing.build();
  const climber = new Vector3(-0.8, 100 - Math.tan(angle) * 0.8, 0);
  const startHeight = climber.y;
  const support = climbing.supportRadius(climber, 1.5, 0.4);
  assert.ok(support !== null, 'Steep upward face rejected as support');
  climber.setLength(support);
  for (let frame = 0; frame < 60; frame++) climbing.move(climber, new Vector3(1, 0, 0), 1 / 60, 0.4, true);
  assert.ok(climber.x > 0.15 && climber.y > startHeight + 3, `Failed to walk up 75-degree slope: ${climber.toArray()}`);
  const supported = climbing.supportRadius(climber, 1.5, 0.4);
  assert.ok(supported !== null && Math.abs(climber.length() - supported) < 0.01, 'Lost support on steep face');
  climbing.dispose(); slope.geometry.dispose(); slope.material.dispose();
  console.log('Steep slopes: continuous uphill walking and capsule support on a 75-degree face');

  const { WorldGlobals } = await server.ssrLoadModule('/src/rendering/WorldGlobals.ts');
  const { PlanetGenerator } = await server.ssrLoadModule('/src/planet/PlanetGenerator.ts');
  const { makePlanetSpec } = await server.ssrLoadModule('/src/planet/PlanetSeed.ts');
  const { PlanetSurface } = await server.ssrLoadModule('/src/planet/PlanetSurface.ts');
  const { Puddles, MAX_WATER_DEPTH } = await server.ssrLoadModule('/src/rendering/Environment/Puddles.ts');
  const { Grass } = await server.ssrLoadModule('/src/rendering/Environment/Grass.ts');
  const globals = new WorldGlobals(); WorldGlobals.current = globals;
  const planet = new PlanetGenerator(makePlanetSpec(23, 0, 118)); globals.basePlanet = planet.archetype.art;
  const surface = new PlanetSurface(planet, { waterLevel: 117, reliefMin: 90, reliefMax: 165 });
  const clock = uniform(1), map = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  const noises = { perlin: map, samplePatch: () => 0.9, sample: () => 0.5 };
  const water = new Puddles(surface, planet, noises, clock);
  assert.ok(water.sites.length > 0);
  assert.ok(!('ocean' in water));
  const depths = water.mesh.geometry.attributes.aDepth;
  for (let vertex = 0; vertex < depths.count; vertex++) assert.ok(depths.getX(vertex) <= MAX_WATER_DEPTH + 1e-6);
  const site = water.sites[0], point = site.direction.clone().multiplyScalar(surface.radiusAt(site.direction));
  water.trackTrail(point);
  assert.equal(water.trailCursor, 1);
  assert.ok(water.waterDepthAt(site.direction) <= MAX_WATER_DEPTH);
  console.log(`Shallow basins: ${water.sites.length}, depth <= ${MAX_WATER_DEPTH} m, grounded wake sample passed`);

  const quality = { level: 0, grassSubdivisions: () => 4, events: { on() {} } };
  const nodes = { terrainNode: () => vec4(0.5, 0.8, 0.2, 0.6), colorNode: () => color('#739c52') };
  const grass = new Grass(surface, nodes, quality, { offsetNode: () => vec2(0) }, noises, undefined, clock);
  await grass.ready;
  const start = new Vector3(0, 1, 0); start.multiplyScalar(surface.radiusAt(start)); grass.update(start);
  clock.value = 2;
  const end = new Vector3(0.1, 1, 0).normalize(); end.multiplyScalar(surface.radiusAt(end)); grass.update(end);
  assert.ok(start.distanceTo(end) > 2.4);
  assert.ok(['x', 'y', 'z'].every(axis => start[axis] > grass.trailMin.value[axis] && start[axis] < grass.trailMax.value[axis]));
  const samples = grass.trailCursor;
  grass.update(end.clone().setLength(end.length() + 10)); assert.equal(grass.trailCursor, samples);
  clock.value = 10; grass.update(end.clone().setLength(end.length() + 10));
  assert.ok(grass.trailMin.value.x > grass.trailMax.value.x);
  grass.dispose(); water.dispose(); map.dispose();
  console.log('Grass trails: persist behind walker, reject airborne samples, recover after expiry');
  console.log('PASS: planet physics and interaction regressions');
} finally { await server.close(); }
process.exit(0);