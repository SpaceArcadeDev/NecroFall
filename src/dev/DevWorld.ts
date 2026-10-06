/**
 * NECROFALL — PLANET WORLD (plan §91/§92 + user request).
 *
 * THE DEFAULT WORLD of NECROFALL: a folio-style WebGPU planet scene generated
 * fully procedurally per seed/ring through the game's planet pipeline
 * (`planetAt` + `makePlanetSpec`).
 *   • the player SPAWNS ON THE GROUND
 *   • one walker + a chase/free camera with the full environment stack
 *     (terrain, grass patches, foliage, water, contamination)
 *
 * Boot: default route. `#/dev` / `?devworld` and `?legacy` variants retained.
 */
import * as THREE from 'three/webgpu';
import { Viewport } from '../rendering/Viewport';
import { Quality, type QualityLevel } from '../rendering/Quality';
import { Ticker } from '../rendering/Ticker';
import { Time } from '../rendering/Time';
import { Rendering } from '../rendering/Rendering';
import { DebugSwitches, StatsOverlay } from '../rendering/DebugSwitches';
import { RenderDebug, printRenderBaseline } from '../rendering/RenderDebug';
import { Materials } from '../rendering/materials/Materials';
import { ResourcesLoader } from '../rendering/Assets/ResourcesLoader';
import { Fog } from '../rendering/Environment/Fog';
import { Lighting } from '../rendering/Environment/Lighting';
import { createPlanetWorld } from '../rendering/Environment/PlanetWorld';
import { CaveDebug } from '../rendering/Environment/CaveDebug';
import { caveApproachAzimuth, caveChamberNode } from '../world/caves/CaveGenerator';
import { generateSciFiSites } from '../world/formations/FormationGenerator';
import type { PlanetGenerator } from '../planet/PlanetGenerator';
import { PlanetSurface, createSurfaceSample } from '../planet/PlanetSurface';
import { Physics } from '../rendering/Physics/Physics';
import { PlanetCollider } from '../rendering/Physics/PlanetCollider';
import { PhysicsSurface } from '../rendering/Physics/PhysicsSurface';
import { planetAt } from '../rankmap/procedural/PlanetGenerator';
import { CONFIG } from '../core/Config';
import {
  detectRendererCapabilities,
  describeRendererCapabilities,
  enrichRendererCapabilities,
} from '../rendering/RendererCapabilities';
import { PerformanceManager } from '../performance/PerformanceManager';
import { precompileEnabled, precompilePipelines } from '../rendering/PipelinePrecompiler';

const FOOT_OFFSET = 0.05;

export async function startDevWorld(): Promise<void> {
  const switches = new DebugSwitches();
  // `?foliageDebug=1` arms the PlanetSurface counters before the world build starts.
  PlanetSurface.debugCounters = RenderDebug.foliageDebug;

  // ---------------------------------------------------------------- DOM
  const root = document.createElement('div');
  root.setAttribute('data-necrofall-dev', '');
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    background: '#050a08',
    overflow: 'hidden',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  } satisfies Partial<CSSStyleDeclaration>);

  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  root.appendChild(canvas);

  const hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', bottom: '10px', left: '10px', zIndex: '40',
    color: '#cfe9c0', font: '11px/1.5 ui-monospace, monospace', whiteSpace: 'pre',
    textShadow: '0 1px 2px rgba(0,0,0,0.8)', pointerEvents: 'none',
  });
  root.appendChild(hud);

  const loading = document.createElement('div');
  Object.assign(loading.style, {
    position: 'fixed', inset: '0', zIndex: '60', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '14px',
    background: 'radial-gradient(circle at 50% 42%, #12241c 0%, #050a08 70%)',
    color: '#b6ff54', font: '13px/1.6 ui-monospace, monospace', letterSpacing: '0.08em',
  });
  const loadingTitle = document.createElement('div');
  loadingTitle.textContent = 'NECROFALL';
  loadingTitle.style.fontSize = '17px';
  const loadingStatus = document.createElement('div');
  loadingStatus.textContent = 'booting renderer…';
  const bar = document.createElement('div');
  Object.assign(bar.style, { width: '280px', height: '4px', background: '#122015', borderRadius: '2px', overflow: 'hidden' });
  const barFill = document.createElement('div');
  Object.assign(barFill.style, { width: '0%', height: '100%', background: '#78ff3d', transition: 'width 0.15s linear' });
  bar.appendChild(barFill);
  const loadingNote = document.createElement('div');
  loadingNote.textContent = 'no enemies · unlimited time · ground spawn';
  loadingNote.style.opacity = '0.55';
  loading.append(loadingTitle, loadingStatus, bar, loadingNote);

  document.body.appendChild(root);
  document.body.appendChild(loading);

  const setProgress = (ratio: number, label: string) => {
    barFill.style.width = `${Math.round(ratio * 100)}%`;
    loadingStatus.textContent = label;
  };

  // ---------------------------------------------------------------- core
  const viewport = new Viewport();
  const quality = new Quality();
  const forcedQuality = switches.bag['quality'];
  if (forcedQuality !== undefined) {
    quality.changeLevel(Number(forcedQuality) as QualityLevel);
    quality.adaptive = false; // an explicitly chosen level is never auto-downgraded
  } else {
    quality.adaptive = switches.enabled('adaptive', true);
  }
  quality.forceNoDof = !switches.enabled('dof', true);
  viewport.setPixelRatioMax(quality.pixelRatioMax());

  const ticker = new Ticker();
  const time = new Time(ticker);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, viewport.ratio, 0.1, 2000);

  // r186 plan §38/§48: the SAME backend choice the match honours, so the WebGL2 fallback can be
  // exercised (and profiled) in the dev world instead of only on a device without WebGPU.
  const rendering = new Rendering(canvas, viewport, quality, {
    forceWebGL: switches.bag['backend'] === 'webgl',
  });
  setProgress(0.02, 'starting renderer (webgpu)');
  await rendering.init(scene, camera);

  viewport.events.on('change', () => {
    camera.aspect = viewport.ratio;
    camera.updateProjectionMatrix();
    rendering.resize();
  });

  // ---------------------------------------------------------------- planet
  const ring = switches.number('ring', 0);
  const planetIndex = switches.number('planet', 2); // 0:0:0:2 = SWAMP (lush + water for terrain tests)
  const descriptor = planetAt(0, ring, 0, 0, planetIndex);
  // Plan §72: five deterministic VISUAL seeds for the visual-quality sweep — every checklist
  // capture uses one of these (or a URL `?seed=`), so two runs are always comparable.
  const VISUAL_SEEDS: Record<string, number> = {
    VISUAL_001: 0x5eed001,
    VISUAL_002: 0x5eed002,
    VISUAL_003: 0x5eed003,
    VISUAL_004: 0x5eed004,
    VISUAL_005: 0x5eed005,
  };
  const visualKey = switches.bag['visualSeed'] ?? switches.bag['visualseed'] ?? '';
  const seed = VISUAL_SEEDS[visualKey.toUpperCase()] ?? switches.number('seed', descriptor.seed);
  // spec/title come from the shared world factory below (plan §30).

  // ---------------------------------------------------------------- environment owners
  // The ONE lighting + fog rig (plan §4/§23/§24) — the world's systems consume these.
  const lighting = new Lighting(scene, quality, CONFIG.planetRadius, { shadowAmplitude: 46 });
  const fog = new Fog(scene, { near: 34, far: 270 });
  const loader = new ResourcesLoader(rendering.renderer);

  // Sunlit spawn ON THE GROUND, chosen from the SAME baked surface the world renders (plan §1).
  const spawnSelector = ({ surface, generator }: { surface: PlanetSurface; generator: PlanetGenerator }) => {
    const random = generator.rand(1);
    const spawnSample = createSurfaceSample();
    const direction = new THREE.Vector3(0.55, 0.52, 0.65).normalize();
    // Plan §41/§72 dev hooks: `?at=caveN` spawns at cave N's rim (approach side), `?at=caveinN`
    // spawns on its chamber floor — deterministic cave captures without flying the camera.
    const at = (switches.bag['at'] ?? '').toLowerCase();
    if (at === 'ship') {
      // `?at=ship` — the crashed colony ship site (plan §62 capture hook).
      const sites = generateSciFiSites(generator.seed, generator.radius, generator.terrain.landmarks, null);
      const ship = sites.find((site) => site.type === 'CRASHED_SHIP');
      if (ship) return ship.dir.clone();
    }
    const caveMatch = /^cave(in)?(\d+)$/.exec(at);
    if (caveMatch) {
      const caves = generator.terrain.caves;
      const index = Number(caveMatch[2]) % Math.max(1, caves.length);
      const cave = caves[index];
      if (cave) {
        if (caveMatch[1]) {
          // inside: the chamber node's centre direction, dropped on the carve floor
          const chamber = [...cave.nodes].reverse().find((node) => node.chamber) ?? cave.nodes[cave.nodes.length - 1];
          return chamber.dir.clone();
        }
        // rim: a step outside the footprint on the tangent side, so the bowl opens in front
        const tangent = new THREE.Vector3(-cave.dir.z, 0.15, cave.dir.x).normalize();
        const axis = new THREE.Vector3().crossVectors(tangent, cave.dir).normalize();
        return cave.dir.clone().applyAxisAngle(axis, cave.radius * 1.18).normalize();
      }
    }
    const sunDirection = lighting.sunDirection.clone().normalize();
    for (let i = 0; i < 800; i++) {
      surface.randomSample(random, spawnSample);
      const lit = spawnSample.up.dot(sunDirection) > 0.45;
      if (
        lit &&
        spawnSample.grass > 0.3 &&
        spawnSample.slope < 0.12 &&
        spawnSample.height > surface.waterLevel - surface.radius + 0.6
      ) {
        direction.copy(spawnSample.up);
        break;
      }
    }
    return direction;
  };

  // ---------------------------------------------------------------- planet world
  // THE shared factory (plan §30): the Dev World and a production match build the identical
  // world — terrain, grass, foliage, water, particles, physics queries, visibility rules.
  setProgress(0.05, 'building planet world');
  const result = await createPlanetWorld({
    scene,
    ticker,
    quality,
    loader,
    fog,
    lighting,
    materialsOptions: { wireframe: switches.wireframe },
    seed,
    ring,
    radius: CONFIG.planetRadius,
    label: `${descriptor.name} · ${descriptor.biomeLabel}`,
    spawnSelector,
    time: time.uTime,
    onProgress: (ratio, label) => setProgress(0.05 + ratio * 0.9, label),
  });
  const { world, spec, surface, surfaceData, generator, nodes, materials, noises, wind, preRenderer } = result;
  document.title = `NECROFALL — ${spec.label} (seed ${seed})`;

  // Plan §41: `?cavedebug=1` overlays the analytic cave system (footprint rings, node rings,
  // entrance markers) the game actually walks on.
  const caveDebugEnabled = switches.enabled('cavedebug', false);
  const caveDebug = caveDebugEnabled ? new CaveDebug(surface, generator) : null;
  if (caveDebug) scene.add(caveDebug.group);

  // r186 plan §0.2/§0.3/§15/§49: the Dev World is where acceptance runs happen, so it gets the
  // SAME capability probe, telemetry snapshot and async precompilation the match does.
  const capabilities = detectRendererCapabilities(rendering.renderer);
  console.info('[caps]', describeRendererCapabilities(capabilities));
  void enrichRendererCapabilities(capabilities).then((enriched) => {
    if (enriched.gpu) console.info('[caps] adapter', enriched.gpu);
  });
  PerformanceManager.init();
  PerformanceManager.attachRenderer(rendering.renderer, rendering.backend);
  PerformanceManager.register('world', () => world.counters());
  if (precompileEnabled()) {
    const report = await precompilePipelines({
      renderer: rendering.renderer,
      scene,
      camera,
      onStep: (label, ratio) => setProgress(0.95 + ratio * 0.04, label),
    });
    console.info('[precompile]', report);
  }
  const spawnDirection = result.spawnDirection;
  const spawnPoint = new THREE.Vector3().copy(spawnDirection).multiplyScalar(surface.radiusAt(spawnDirection) + FOOT_OFFSET);

  // ---------------------------------------------------------------- dev player
  const physics = new Physics();
  const collider = new PlanetCollider(surface);
  const physicsSurface = new PhysicsSurface(collider, surface);

  const playerMaterial = materials.createPlainMaterial('#9fd6c9', { hasLightBounce: false });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.0, 6, 12), playerMaterial);
  body.position.y = 0.84;
  body.castShadow = true;
  const accentMaterial = materials.createPlainMaterial('#78ff3d', { hasLightBounce: false });
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.16), accentMaterial);
  visor.position.set(0, 1.32, 0.28);
  const player = new THREE.Group();
  player.add(body, visor);
  player.position.copy(spawnPoint);
  scene.add(player);

  const playerState = {
    position: spawnPoint.clone(),
    velocity: new THREE.Vector3(),
    up: spawnDirection.clone(),
    grounded: true,
    facing: Math.PI,
  };

  // ---------------------------------------------------------------- input + camera
  const keys = new Set<string>();
  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if (event.code === 'Space') event.preventDefault();
    if (event.code === 'KeyH') hud.style.display = hud.style.display === 'none' ? '' : 'none';
    if (event.code === 'KeyV') freeCamera = !freeCamera;
    if (event.code === 'Digit1') quality.changeLevel(0);
    if (event.code === 'Digit2') quality.changeLevel(1);
    if (event.code === 'Digit3') quality.changeLevel(2);
    if (event.code === 'KeyR') respawn();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));

  const cameraRig = {
    yaw: Math.PI * 0.9,
    pitch: 0.62,
    distance: 12,
    target: new THREE.Vector3(),
  };
  let freeCamera = switches.freeCamera;
  const freeState = { position: spawnPoint.clone().addScaledVector(spawnDirection, 6), yaw: 0.6, pitch: 0.35, velocity: new THREE.Vector3() };
  {
    // aim the free camera along the horizon at spawn (world-Y yaw/pitch)
    const look = new THREE.Vector3().crossVectors(spawnDirection, new THREE.Vector3(0, 1, 0));
    if (look.lengthSq() < 1e-6) look.set(1, 0, 0);
    look.normalize().multiplyScalar(0.9).addScaledVector(spawnDirection, 0.25).normalize();
    freeState.yaw = Math.atan2(look.x, look.z);
    freeState.pitch = Math.asin(look.y);
  }
  {
    // `?view=<landmarkIndex>` (visual rework plan §70): hover the FREE camera beside that
    // landmark at `?viewAlt=<m>` (default 14) and aim it at the landmark centre, so a
    // deterministic capture script can photograph spawn / landmark / horizon without steering.
    // `?view=cave:N` (underground rework, user ask 2026-10-06) frames cave N's MOUTH from
    // outside; `?view=vista&viewAlt=<m>` hovers and looks along the horizon for range captures.
    const viewSwitch = switches.bag['view'];
    if (viewSwitch !== undefined && freeCamera) {
      const caveView = /^cave:?(\d+)$/i.exec(viewSwitch);
      if (caveView) {
        const caves = generator.terrain.caves;
        const cave = caves[Number(caveView[1]) % caves.length];
        const height = cave.depth + 5;
        const chamber = caveChamberNode(cave);
        const approachAzimuth = caveApproachAzimuth(cave);
        // Mouth direction in the SAME frame the Caves layer builds: tangent basis of cave.dir.
        const t1 = PlanetSurface.stableTangent(cave.dir.clone(), new THREE.Vector3());
        const t2 = new THREE.Vector3().crossVectors(cave.dir, t1).normalize();
        const atAzimuth = (radial: number): THREE.Vector3 =>
          cave.dir
            .clone()
            .multiplyScalar(Math.cos(radial * cave.radius))
            .addScaledVector(t1, Math.sin(radial * cave.radius) * Math.cos(approachAzimuth))
            .addScaledVector(t2, Math.sin(radial * cave.radius) * Math.sin(approachAzimuth))
            .normalize();
        // Stand well outside the mouth and aim at the LIP so the rocky dome + dark opening frame
        // the shot (looking straight at the floor buries the frame in darkness).
        const mouthDir = atAzimuth(1.85);
        const lipDir = atAzimuth(0.8);
        const eye = mouthDir.clone().multiplyScalar(surface.radiusAt(mouthDir) + height * 0.6);
        const target = lipDir.clone().multiplyScalar(surface.radiusAt(lipDir) + height * 0.25);
        const forward = target.clone().sub(eye).normalize();
        freeState.position.copy(eye);
        freeState.yaw = Math.atan2(forward.x, forward.z);
        freeState.pitch = clampNumber(Math.asin(forward.y), -1.5, 1.5);
        void chamber;
      } else if (viewSwitch.toLowerCase() === 'vista') {
        const altitude = Number.parseFloat(switches.bag['viewAlt'] ?? '') || 42;
        const eye = spawnDirection.clone().multiplyScalar(surface.radiusAt(spawnDirection) + altitude);
        const tangent = PlanetSurface.stableTangent(spawnDirection.clone(), new THREE.Vector3());
        const forward = tangent.clone().addScaledVector(spawnDirection, -0.24).normalize();
        freeState.position.copy(eye);
        freeState.yaw = Math.atan2(forward.x, forward.z);
        freeState.pitch = clampNumber(Math.asin(forward.y), -1.5, 1.5);
      } else {
        const index = Math.max(0, Math.min(generator.terrain.landmarks.length - 1, Number.parseInt(viewSwitch, 10) || 0));
        const targetDirection = generator.terrain.landmarks[index]?.dir ?? spawnDirection;
        const altitude = Number.parseFloat(switches.bag['viewAlt'] ?? '') || 14;
        const target = targetDirection.clone().multiplyScalar(surface.radiusAt(targetDirection));
        const tangent = PlanetSurface.stableTangent(targetDirection.clone(), new THREE.Vector3());
        const eye = target
          .clone()
          .addScaledVector(targetDirection, altitude)
          .addScaledVector(tangent, -altitude * 1.4);
        const forward = target.clone().sub(eye).normalize();
        freeState.position.copy(eye);
        freeState.yaw = Math.atan2(forward.x, forward.z);
        freeState.pitch = clampNumber(Math.asin(forward.y), -1.5, 1.5);
      }
    }
  }

  let dragging = false;
  canvas.addEventListener('pointerdown', () => (dragging = true));
  window.addEventListener('pointerup', () => (dragging = false));
  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (freeCamera) {
      freeState.yaw -= event.movementX * 0.0026;
      freeState.pitch = clampNumber(freeState.pitch - event.movementY * 0.0026, -1.5, 1.5);
    } else {
      cameraRig.yaw -= event.movementX * 0.0035;
      cameraRig.pitch = clampNumber(cameraRig.pitch + event.movementY * 0.0035, -0.15, 1.35);
    }
  });
  canvas.addEventListener('wheel', (event) => {
    cameraRig.distance = clampNumber(cameraRig.distance + event.deltaY * 0.01, 3, 34);
  }, { passive: true });

  function respawn(): void {
    playerState.position.copy(spawnPoint);
    playerState.velocity.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- physics step (fixed)
  const scratchMove = new THREE.Vector3();
  const scratchForward = new THREE.Vector3();
  const scratchRight = new THREE.Vector3();
  const scratchUp = new THREE.Vector3();
  const scratchTangent = new THREE.Vector3();
  const scratchOffset = new THREE.Vector3();
  const scratchVertical = new THREE.Vector3();
  const scratchTangentVel = new THREE.Vector3();
  const scratchDirection = new THREE.Vector3();

  physics.onStep((delta) => {
    scratchUp.copy(playerState.position).normalize();
    playerState.up.copy(scratchUp);

    // camera-relative move axes projected on the tangent plane:
    // the camera sits at `offsetDir` from the player, so screen-forward is -offsetDir
    PlanetSurface.stableTangent(scratchUp, scratchTangent);
    scratchForward.crossVectors(scratchUp, scratchTangent).normalize();
    const yaw = freeCamera ? freeState.yaw : cameraRig.yaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    scratchOffset.copy(scratchTangent).multiplyScalar(cos).addScaledVector(scratchForward, sin).normalize();
    const moveForward = scratchOffset.negate();
    const moveRight = scratchRight.crossVectors(moveForward, scratchUp).normalize();

    scratchMove.set(0, 0, 0);
    if (keys.has('KeyW')) scratchMove.add(moveForward);
    if (keys.has('KeyS')) scratchMove.sub(moveForward);
    if (keys.has('KeyD')) scratchMove.add(moveRight);
    if (keys.has('KeyA')) scratchMove.sub(moveRight);
    const moving = scratchMove.lengthSq() > 1e-6;
    if (moving) scratchMove.normalize();

    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 11.5 : 6.4;
    const grounded = physicsSurface.isGrounded(playerState.position, FOOT_OFFSET, 0.16);
    playerState.grounded = grounded;

    if (moving) {
      playerState.velocity.addScaledVector(scratchMove, (grounded ? 30 : 9) * delta);
    }

    // split into vertical + tangential, damp, recombine
    const alongUp = playerState.velocity.dot(scratchUp);
    scratchVertical.copy(scratchUp).multiplyScalar(alongUp);
    scratchTangentVel.copy(playerState.velocity).sub(scratchVertical);
    scratchTangentVel.multiplyScalar(grounded ? Math.max(0, 1 - delta * 7) : Math.max(0, 1 - delta * 1.2));
    const horizontalSpeed = scratchTangentVel.length();
    if (horizontalSpeed > speed) scratchTangentVel.multiplyScalar(speed / horizontalSpeed);

    if (!grounded) {
      scratchVertical.addScaledVector(scratchUp, -9.4 * delta);
    } else if (keys.has('Space') && playerState.velocity.dot(scratchUp) < 6) {
      scratchVertical.addScaledVector(scratchUp, 7.2);
    }

    playerState.velocity.copy(scratchTangentVel).add(scratchVertical);
    playerState.position.addScaledVector(playerState.velocity, delta);

    // surface clamp — the analytic collider (plan §41)
    scratchDirection.copy(playerState.position).normalize();
    const radius = surface.radiusAt(scratchDirection);
    if (playerState.position.length() < radius + FOOT_OFFSET) {
      playerState.position.copy(scratchDirection).multiplyScalar(radius + FOOT_OFFSET);
      const verticalComponent = playerState.velocity.dot(scratchDirection);
      if (verticalComponent < 0) playerState.velocity.addScaledVector(scratchDirection, -verticalComponent);
    }

    // environmental objects are solid — trees, bushes, rocks, spikes, crystals
    world.obstacles.resolve(playerState.position, 0.42, playerState.velocity);

    // keep the resolved position on the collision surface (a push along a
    // slope must never leave the body under the terrain)
    scratchDirection.copy(playerState.position).normalize();
    const resolvedRadius = surface.radiusAt(scratchDirection) + FOOT_OFFSET;
    if (playerState.position.length() < resolvedRadius) {
      playerState.position.copy(scratchDirection).multiplyScalar(resolvedRadius);
    }

    if (moving && grounded) {
      playerState.facing = Math.atan2(scratchMove.dot(moveRight), scratchMove.dot(moveForward));
    }
  });

  // free-fly camera physics-free movement
  const freeStep = (delta: number) => {
    if (!freeCamera) return;
    const forward = new THREE.Vector3(
      Math.sin(freeState.yaw) * Math.cos(freeState.pitch),
      Math.sin(freeState.pitch),
      Math.cos(freeState.yaw) * Math.cos(freeState.pitch),
    );
    const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
    const speed = keys.has('ShiftLeft') ? 60 : 22;
    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.add(forward);
    if (keys.has('KeyS')) move.sub(forward);
    if (keys.has('KeyD')) move.add(right);
    if (keys.has('KeyA')) move.sub(right);
    if (keys.has('Space')) move.y += 1;
    if (keys.has('ControlLeft')) move.y -= 1;
    if (move.lengthSq() > 0) freeState.position.addScaledVector(move.normalize(), speed * delta);
  };

  // ---------------------------------------------------------------- ticker wiring (plan §43 order)
  const focusScratch = new THREE.Vector3();
  const stageScratch = new THREE.Vector3();
  const stageTangent = new THREE.Vector3();
  const stageForward = new THREE.Vector3();
  const stageOffset = new THREE.Vector3();
  const stageTarget = new THREE.Vector3();
  const stageQuat = new THREE.Quaternion();

  ticker.on(4, () => {
    // player visual + world focus
    player.position.copy(playerState.position);
    stageScratch.copy(playerState.position).normalize();
    stageQuat.setFromUnitVectors(UP, stageScratch);
    player.quaternion.copy(stageQuat);
    player.rotateY(playerState.facing);
  });

  ticker.on(5, () => {
    // camera
    const up = playerState.up;
    if (freeCamera) {
      camera.position.copy(freeState.position);
      stageScratch.set(
        Math.sin(freeState.yaw) * Math.cos(freeState.pitch),
        Math.sin(freeState.pitch),
        Math.cos(freeState.yaw) * Math.cos(freeState.pitch),
      );
      camera.lookAt(camera.position.clone().add(stageScratch));
    } else {
      const target = stageTarget.copy(playerState.position).addScaledVector(up, 1.5);
      PlanetSurface.stableTangent(up, stageTangent);
      stageForward.crossVectors(up, stageTangent).normalize();
      const offset = stageOffset
        .set(0, 0, 0)
        .addScaledVector(stageForward, Math.sin(cameraRig.yaw) * Math.cos(cameraRig.pitch))
        .addScaledVector(stageTangent, Math.cos(cameraRig.yaw) * Math.cos(cameraRig.pitch))
        .addScaledVector(up, Math.sin(cameraRig.pitch))
        .normalize();
      // clearance: pull the camera in when terrain blocks the sight line
      let distance = cameraRig.distance;
      for (let attempt = 0; attempt < 8; attempt++) {
        let blocked = false;
        for (let k = 0.35; k <= 1.001; k += 0.22) {
          stageScratch.copy(target).addScaledVector(offset, distance * k);
          const alongRadius = stageScratch.length();
          const ground = surface.radiusAt(stageScratch.multiplyScalar(1 / Math.max(1e-5, alongRadius)));
          if (alongRadius < ground + 0.9) {
            blocked = true;
            break;
          }
        }
        if (!blocked) break;
        distance *= 0.72;
      }
      camera.position.copy(target).addScaledVector(offset, distance);
      camera.lookAt(target);
    }
  });

  ticker.on(8, () => {
    lighting.update(playerState.position);
  });

  ticker.on(9, () => {
    focusScratch.set(playerState.position.x, playerState.position.y, playerState.position.z);
    // Underground blend (plan §33/§34): read the ONE analytic carve at the body's direction.
    const dirLen = focusScratch.length();
    if (dirLen > 0.001) {
      stageScratch.copy(focusScratch).multiplyScalar(1 / dirLen);
      const depth = surface.generator.caveDepthAt(stageScratch.x, stageScratch.y, stageScratch.z);
      const cave = depth > 0.5 ? surface.generator.caveAt(stageScratch.x, stageScratch.y, stageScratch.z) : null;
      world.setUnderground(depth, cave, ticker.delta);
      caveDebug?.setActive(cave && depth > 2.4 ? cave.id : -1);
      if (caveDebug && stats) {
        stats.set(
          'cave',
          cave
            ? `${cave.label} (${cave.size}) · depth ${depth.toFixed(1)} m${depth > 2.4 ? ' · UNDERGROUND' : ''} · blend ${world.undergroundBlendValue.toFixed(2)}`
            : `surface · no cave here · blend ${world.undergroundBlendValue.toFixed(2)}`,
        );
      }
    }
    world.update(focusScratch, camera, undefined, ticker.delta);
  });

  ticker.on(10, () => {
    freeStep(ticker.delta);
  });

  const stats = switches.stats || caveDebugEnabled || RenderDebug.baseline || RenderDebug.foliageDebug ? new StatsOverlay() : null;
  /** r186 plan §49: refresh the telemetry lines twice a second on the same overlay. */
  let telemetryT = 0;
  ticker.on(998, () => {
    rendering.render(ticker.delta, stats);
    // Read the counters AFTER the draw: three resets `info` when a render starts, so a snapshot
    // taken before it would report last frame's reset state (draws/triangles = 0).
    if (stats && PerformanceManager.enabled) {
      telemetryT += ticker.delta;
      if (telemetryT >= 0.5) {
        telemetryT = 0;
        PerformanceManager.attachRenderer(rendering.renderer, rendering.backend);
        for (const [label, value] of PerformanceManager.overlayLines()) stats.set(label, value);
      }
    }
  });

  // ---------------------------------------------------------------- visibility / switches
  world.applyVisibility({
    grass: switches.enabled('grass', true),
    foliage: switches.enabled('foliage', true),
    rocks: switches.enabled('rocks', true),
    spikes: switches.enabled('spikes', true),
    crystals: switches.enabled('crystals', true),
    water: switches.enabled('water', true),
    particles: switches.enabled('particles', true),
    caves: switches.enabled('caves', true),
  });
  if (!switches.enabled('shadows', true)) {
    rendering.renderer.shadowMap.enabled = false;
    lighting.setShadowsEnabled(false);
  }
  if (!switches.enabled('fog', true)) fog.setEnabled(false);
  if (switches.wireframe) rendering.setWireframeAll(scene, true);

  // Debug overlays (plan §1/§33): the SAME dump the game produces — diff the two to verify the
  // golden rule that both worlds share one rendering system (§30/§31).
  if (stats) {
    for (const [label, value] of Object.entries(world.stats)) stats.set(label, value);
    stats.set('quality', `${quality.level}`);
  }
  if (RenderDebug.baseline) {
    printRenderBaseline({
      world: 'dev',
      renderer: {
        version: 'three r186 (webgpu)',
        backend: rendering.backend,
        pixelRatio: viewport.pixelRatio,
        toneMapping: (rendering.renderer as any)?.toneMapping ?? -1,
        exposure: (rendering.renderer as any)?.toneMappingExposure ?? 1,
        size: { x: viewport.width, y: viewport.height },
      },
      quality: `level ${quality.level}`,
      camera: { fov: camera.fov, near: camera.near, far: camera.far },
      planet: { radius: spec.radius, seed: spec.seed, ring: spec.ring },
      lighting: lighting.baseline,
      fog: fog.baseline,
      foliage: world.stats,
    }, stats ?? undefined);
  }

  quality.events.on('change', (level) => {
    lighting.setQuality(quality);
    hud.textContent = hudText();
    void level;
  });

  // ---------------------------------------------------------------- HUD + loop
  function hudText(): string {
    return [
      `NECROFALL — ${spec.label} · seed ${spec.seed} · ring ${spec.ring}`,
      'no enemies · unlimited time · ground spawn',
      'WASD move · SHIFT run · SPACE jump · drag orbit · wheel zoom',
      'V free camera · 1/2/3 quality · R respawn · H hide UI',
      caveDebugEnabled ? `caves ${generator.terrain.caves.length} · ${generator.terrain.caves.map((c) => c.label).join(' / ')}` : '',
      switches.stats ? '' : '(add ?stats for render statistics)',
    ].filter(Boolean).join('\n');
  }
  hud.textContent = hudText();

  // `?foliageDebug=1`: live counters next to the render stats (plan §33).
  let foliageDebugAccum = 0;
  ticker.on(999, () => {
    if (!stats || !RenderDebug.foliageDebug) return;
    foliageDebugAccum += ticker.delta;
    if (foliageDebugAccum < 0.5) return;
    foliageDebugAccum = 0;
    const blades = quality.grassSubdivisions();
    stats.set('fol.field', `planet-wide ${(blades * blades).toLocaleString()} blades`);
    stats.set('terrainSamples', `${PlanetSurface.debugSamples}`);
    stats.set('surfaceQueries', `${PlanetSurface.debugQueries}`);
    PlanetSurface.debugSamples = 0;
    PlanetSurface.debugQueries = 0;
  });

  loading.style.display = 'none';
  setProgress(1, 'ready');

  let last = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    // fixed-step physics (plan §42), then the ordered tick
    physics.advance(delta);
    ticker.update(delta);
    // r186 plan §0.3: feed the telemetry's frame section the SAME pacing the loop just measured.
    PerformanceManager.sample(delta * 1000, delta * 1000);
    // throttled background tabs produce meaningless deltas — never degrade on them
    if (!document.hidden) quality.monitor(delta);
  };
  requestAnimationFrame(frame);

  // debug handle (plan §41: cave probes use `devWorld.lighting`/`devWorld.fog` directly)
  (window as unknown as Record<string, unknown>).devWorld = {
    scene, camera, rendering, world, generator, surface, surfaceData, quality, ticker, physics, playerState, spec, lighting, fog,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const UP = new THREE.Vector3(0, 1, 0);
