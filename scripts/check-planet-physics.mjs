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
  const seaCoverage = [];
  for (let seed = 1; seed <= 32; seed++) {
    const coastal = new PlanetGenerator(makePlanetSpec(seed, 0, 118));
    let submerged = 0;
    for (let sample = 0; sample < 4096; sample++) {
      const vertical = 1 - 2 * (sample + 0.5) / 4096, radial = Math.sqrt(1 - vertical * vertical), angle = sample * 2.399963229728653;
      const floor = coastal.radiusAt(radial * Math.cos(angle), vertical, radial * Math.sin(angle));
      if (floor < coastal.terrain.seaLevel) submerged++;
      assert.ok(coastal.terrain.seaLevel - floor <= 0.291, 'Shallow sea has a deep or uneven floor');
    }
    const coverage = submerged / 4096;
    const limit = coastal.archetype.biome === 'DESERT' ? 0.035 : coastal.archetype.biome === 'OCEAN' ? 0.1 : 0.055;
    assert.ok(coverage > 0.005 && coverage < limit, `${seed}: sea covers ${(coverage * 100).toFixed(1)}%`);
    seaCoverage.push({ seed, coverage });
  }
  console.log(`Sea area: 32 seeds remain within biome-specific limits (maximum ${(Math.max(...seaCoverage.map(sample => sample.coverage)) * 100).toFixed(1)}%)`);
  const planet = new PlanetGenerator(makePlanetSpec(23, 0, 118)); globals.basePlanet = planet.archetype.art;
  const massifs = [...planet.terrain.massifs];
  let steepestMountain = 0;
  for (const massif of massifs) {
    assert.ok(Math.sqrt(massif.radiusSquared) >= 0.34);
    const tangent = massif.direction.clone().cross(new Vector3(0, 1, 0)).normalize();
    let previousHeight = massif.height;
    for (let step = 0; step <= 120; step++) {
      const direction = massif.direction.clone().applyAxisAngle(tangent, step * 0.005);
      planet.terrain.massifs.length = 0;
      const floor = planet.radiusAt(direction.x, direction.y, direction.z);
      planet.terrain.massifs.push(massif);
      const rise = planet.radiusAt(direction.x, direction.y, direction.z) - floor;
      if (step > 0) steepestMountain = Math.max(steepestMountain, Math.abs(rise - previousHeight) / (0.005 * planet.radius));
      previousHeight = rise;
    }
    assert.equal(previousHeight, 0, 'Mountain must blend back into its surrounding terrain');
  }
  planet.terrain.massifs.splice(0, planet.terrain.massifs.length, ...massifs);
  assert.ok(steepestMountain < 1.3, `Abrupt mountain flank: ${steepestMountain}`);
  console.log(`Mountain foothills: 10 profiles blend to zero, maximum rise/run ${steepestMountain.toFixed(3)}`);
  const surface = new PlanetSurface(planet, { waterLevel: planet.terrain.seaLevel, reliefMin: 90, reliefMax: 165 });
  const clock = uniform(1), map = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  const noises = { perlin: map, samplePatch: () => 0.9, sample: () => 0.5 };
  const water = new Puddles(surface, planet, noises, clock);
  assert.ok(water.sites.length > 0);
  assert.ok(water.mesh.userData.seaVertices > 100, 'Missing shallow coastline');
  assert.ok(water.mesh.userData.riverVertices > 100, 'Missing river channels');
  assert.ok(!('ocean' in water));
  const depths = water.mesh.geometry.attributes.aDepth;
  for (let vertex = 0; vertex < depths.count; vertex++) assert.ok(depths.getX(vertex) <= MAX_WATER_DEPTH + 1e-6);
  const site = water.sites[0], point = site.direction.clone().multiplyScalar(surface.radiusAt(site.direction));
  water.trackTrail(point);
  assert.equal(water.trailCursor, 1);
  assert.ok(water.waterDepthAt(site.direction) <= MAX_WATER_DEPTH);
  console.log(`Shallow basins: ${water.sites.length}, depth <= ${MAX_WATER_DEPTH} m, grounded wake sample passed`);
  const waterPositions = water.mesh.geometry.attributes.position;
  const networkStart = waterPositions.count - width * (height + 1);
  for (let vertex = networkStart; vertex < waterPositions.count; vertex++) {
    const waterPoint = new Vector3().fromBufferAttribute(waterPositions, vertex), direction = waterPoint.clone().normalize();
    const floor = water.renderedRadiusAt(direction);
    if (floor < planet.terrain.seaLevel - 0.04) {
      assert.ok(Math.abs(waterPoint.length() - planet.terrain.seaLevel) < 0.015, 'Sea surface follows the hills');
    }
  }
  let riverWake = false, seaWake = false;
  for (let vertex = waterPositions.count - 1; vertex >= 0 && !(riverWake && seaWake); vertex--) {
    const wetPoint = new Vector3().fromBufferAttribute(waterPositions, vertex), direction = wetPoint.clone().normalize();
    if (water.waterDepthAt(direction) < 0.1) continue;
    const sea = water.renderedRadiusAt(direction) < planet.terrain.seaLevel;
    if (sea ? seaWake : riverWake) continue;
    const previous = water.trailCursor;
    water.trackWalkerTrail(sea ? 'sea-walker' : 'river-walker', wetPoint);
    assert.equal(water.trailCursor, previous + 1);
    water.trackWalkerTrail('airborne', wetPoint.clone().setLength(wetPoint.length() + 3));
    assert.equal(water.trailCursor, previous + 1, 'Airborne player leaves water ripples');
    if (sea) seaWake = true; else riverWake = true;
  }
  assert.ok(riverWake && seaWake);
  console.log(`Connected water: ${water.mesh.userData.riverVertices} river vertices, ${water.mesh.userData.seaVertices} sea vertices, both support grounded wakes`);

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
  const { PlanetHazards } = await server.ssrLoadModule('/src/planet/PlanetHazards.ts');
  const hazards = new PlanetHazards(() => 118);
  const body = {
    alive: true, grounded: true, position: new Vector3(0, 118, 0), velocity: new Vector3(12, 2, 0),
    edgeBoost(direction, speed, lift) {
      this.velocity.addScaledVector(direction, speed).addScaledVector(this.position.clone().normalize(), lift);
      this.grounded = false;
    },
  };
  hazards.add('quicksand', body.position, 9, 1.1);
  assert.ok(Math.abs(hazards.apply(body, 1 / 60) - 0.3) < 1e-9);
  assert.ok(body.velocity.x < 12); assert.equal(body.velocity.y, 2);
  body.grounded = false; body.position.y = 122;
  assert.equal(hazards.apply(body, 1 / 60), 1, 'Quicksand affects airborne players');
  body.position.set(12, 118, 0).setLength(118); body.grounded = true;
  assert.equal(hazards.apply(body, 1 / 60), 1, 'Slow persists outside quicksand');
  hazards.add('vortex', new Vector3(0, 118, 0), 9, 29);
  body.position.set(0, 118, 0); body.velocity.set(0, 0, 0);
  hazards.apply(body, 1 / 60);
  assert.equal(body.grounded, false); assert.equal(body.velocity.y, 32);
  assert.ok(Math.hypot(body.velocity.x, body.velocity.z) > 25);
  const launched = body.velocity.clone();
  hazards.apply(body, 1 / 60); assert.ok(body.velocity.equals(launched), 'Vortex impulse stacks every frame');
  body.position.y = 160; hazards.apply(body, 2); assert.ok(body.velocity.equals(launched));
  body.alive = false; body.position.y = 118; hazards.apply(body, 2); assert.ok(body.velocity.equals(launched));
  console.log('Hazards: grounded quicksand drag, jump/exit recovery, radial vortex lift and outward throw, cooldown, altitude and death guards');
  console.log('PASS: planet physics and interaction regressions');
} finally { await server.close(); }
process.exit(0);