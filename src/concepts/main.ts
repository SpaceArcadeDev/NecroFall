import { ACESFilmicToneMapping, Color, PerspectiveCamera, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BASE_CAMERA_FOV, STUDIES, type EnvironmentInspection, type PlanetState, type PlanetStudy } from './definitions';
import { fbm, noise } from './procedural';
import { buildWorld, type StudyView, type StudyWorld } from './world';
import { baseFocus } from './BaseFocus';
import { BaseWalk } from './BaseWalk';
import { BASE_FEATURES } from './BaseFeatures';
import './studies.css';

function thumbnail(study: PlanetStudy): string {
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 112;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(180, 112);
  const ocean = new Color(study.water), land = new Color(study.ground), bloom = new Color(study.foliageLight);
  const tint = new Color();
  for (let row = 0; row < 112; row++) {
    for (let column = 0; column < 180; column++) {
      const x = (column - 90) / 47, y = (row - 56) / 47;
      const depth = 1 - x * x - y * y;
      if (depth < 0) continue;
      const z = Math.sqrt(depth);
      const continent = fbm(x * 3.8 + study.seed % 611, y * 3.8, z * 3.8);
      tint.copy(continent > 0.49 ? land : ocean);
      if (continent > 0.55) tint.lerp(bloom, Math.min(1, (continent - 0.55) * 5));
      tint.multiplyScalar((0.28 + Math.max(0, -x * 0.4 - y * 0.6 + z * 0.65) * 0.7) * (0.85 + noise(x * 36, y * 36) * 0.15));
      tint.convertLinearToSRGB();
      const index = (row * 180 + column) * 4;
      image.data[index] = Math.min(255, tint.r * 255);
      image.data[index + 1] = Math.min(255, tint.g * 255);
      image.data[index + 2] = Math.min(255, tint.b * 255);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#concepts')!;
  const params = new URLSearchParams(location.search);
  const assetMode = params.get('assets') === '1' || location.pathname.endsWith('/base-planets.html');
  let focusBlur = params.get('focus') !== 'off';
  let featureFocus = params.get('feature') ?? '';
  let planetState: PlanetState = params.get('state') === 'radiated' ? 'radiated' : 'normal';
  let effects = params.get('effects') !== 'off';
  let studyIndex = Math.max(0, STUDIES.findIndex((study) => study.id === params.get('planet')));
  let seed = params.has('seed') && Number.isFinite(Number(params.get('seed'))) ? Number(params.get('seed')) >>> 0 : STUDIES[studyIndex].seed;
  let view: StudyView = ['surface', 'orbit', 'fauna'].includes(params.get('view') ?? '') ? params.get('view') as StudyView : 'surface';
  let inspection: EnvironmentInspection = ['terrain', 'grass', 'water', 'trees', 'rocks', 'geology', 'features'].includes(params.get('inspect') ?? '') ? params.get('inspect') as EnvironmentInspection : 'scene';
  let selected = '';
  try { selected = localStorage.getItem('necrofall.concepts.selection') ?? ''; } catch {}
  let focusCreature = 2;
  let quality = ['auto', 'mobile', 'high'].includes(params.get('quality') ?? '') ? params.get('quality')! : 'auto';
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motionPreference.matches;
  let hiddenUI = false;
  root.innerHTML = `
    <div class="viewport" aria-label="Interactive procedural planet" role="img"></div>
    <div class="vignette" aria-hidden="true"></div>
    <header class="masthead chrome">
      <a class="wordmark" href="/base-planets.html" aria-label="NECROFALL base planets">NECR<span>O</span>FALL</a>
      <div class="masthead-label">BASE PLANETS <span> / </span> FIELD ARCHIVE</div>
      <div class="header-controls">
        <label class="quality-label">Quality <select id="quality" aria-label="Rendering quality"><option value="auto">Adaptive</option><option value="mobile">Mobile</option><option value="high">High</option></select></label>
        <span id="backend" class="backend">INITIALIZING</span>
      </div>
    </header>
    <nav class="view-switch chrome" aria-label="Study view"><div role="tablist" aria-label="World views">
      <button role="tab" data-view="surface">Surface</button><button role="tab" data-view="orbit">Orbit</button><button role="tab" data-view="fauna">Parasites</button>
    </div></nav>
    <div class="climate-controls chrome"><div role="group" aria-label="Planet state"><button data-state="normal">Normal</button><button data-state="radiated">Radiated</button></div><label class="weather-control"><input id="effects" type="checkbox" /> Weather</label></div>
    <div class="scene-meta chrome"><span id="designation"></span><span id="biome"></span></div>
    <label class="asset-inspection chrome" for="inspection">Inspect <select id="inspection" aria-label="Environment asset"><option value="scene">Full scene</option><option value="terrain">Terrain</option><option value="grass">Grass patches</option><option value="water">Water</option><option value="trees">Trees / flora</option><option value="rocks">Rock formations</option><option value="geology">Spikes / crystals</option><option value="features">Base features</option></select></label>
    <div class="scene-actions chrome"><button id="reset">Reset view</button><button id="motion">Pause motion</button><button id="capture">Capture</button></div>
    <div class="navigation-tools chrome"><label class="focus-control"><input id="focus-blur" type="checkbox" /> Focus blur</label><button id="walk" title="Walk with WASD or the arrow controls; drag to look">Walk</button></div>
    <div class="walk-controls chrome" aria-label="Walking controls"><button data-move="KeyW" aria-label="Move forward" title="Move forward">&#8593;</button><button data-move="KeyA" aria-label="Move left" title="Move left">&#8592;</button><button data-move="KeyS" aria-label="Move backward" title="Move backward">&#8595;</button><button data-move="KeyD" aria-label="Move right" title="Move right">&#8594;</button></div>
    <button id="hide" class="hide-toggle" aria-label="Hide interface">Hide UI</button>
    <section class="world-caption chrome" aria-labelledby="world-name"><div class="eyebrow">RADIATED WORLDS / PARASITIC LIFE</div><h1 id="world-name"></h1><p id="description"></p></section>
    <div id="creature-labels" class="creature-labels chrome"></div>
    <div id="creature-switch" class="creature-switch chrome" role="tablist" aria-label="Parasite specimen"></div>
    <div class="selection chrome"><span id="selection-status" role="status"></span><button id="choose">Choose base planet</button></div>
    <footer class="archive chrome">
      <div class="archive-top"><span>BASE PLANETS <b id="study-count"></b></span><div class="seed-controls"><label for="seed">SEED</label><input id="seed" type="number" min="0" max="4294967295" step="1" aria-label="Procedural seed" /><button id="regenerate">New seed</button></div></div>
      <div class="planet-tabs" role="tablist" aria-label="Base planets">
        ${STUDIES.map((study, index) => `<button class="planet-tab" role="tab" data-study="${index}" style="--planet-accent:${study.foliageLight}"><img src="${thumbnail(study)}" alt="" width="90" height="56" /><div><small>${String(index + 1).padStart(2, '0')} / ${study.landform?.toUpperCase() ?? (study.flora === 'fungus' ? 'NOCTURNAL' : study.flora === 'crystal' ? 'GLACIAL' : study.flora === 'coral' ? 'OCEANIC' : study.flora === 'sail' ? 'ARID' : 'VERDANT')}</small><strong>${study.name}</strong></div><span class="chosen-mark" aria-hidden="true"></span></button>`).join('')}
      </div>
      <div class="archive-bottom"><span>NECROFALL <span class="muted">/ VISUAL DEVELOPMENT</span></span><span id="performance">Compiling world</span></div>
    </footer>
    <div class="loading" role="status"><span class="loading-orbit"></span><span id="loading-label">Forming Cinderbloom</span></div>`;
  const element = <ElementType extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as ElementType;
  const viewport = root.querySelector<HTMLElement>('.viewport')!;
  const loading = root.querySelector<HTMLElement>('.loading')!;
  const qualityControl = element<HTMLSelectElement>('quality');
  const seedControl = element<HTMLInputElement>('seed');
  const inspectionControl = element<HTMLSelectElement>('inspection');
  const effectsControl = element<HTMLInputElement>('effects');
  const focusControl = element<HTMLInputElement>('focus-blur');
  (root.querySelector('.asset-inspection') as HTMLElement).hidden = !assetMode;
  (root.querySelector('.climate-controls') as HTMLElement).hidden = !assetMode;
  (root.querySelector('.navigation-tools') as HTMLElement).hidden = !assetMode;
  qualityControl.value = quality;
  const mobileBudget = () => quality === 'mobile' || (quality === 'auto' && (innerWidth < 760 || matchMedia('(pointer: coarse)').matches));
  const compact = () => innerWidth < 700;
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: params.get('backend') === 'webgl', powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobileBudget() ? 1 : 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.setAttribute('aria-label', 'Procedural world viewport');
  renderer.domElement.setAttribute('tabindex', '0');
  viewport.append(renderer.domElement);
  await renderer.init();
  if (assetMode) { renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1; }
  const backend = renderer.backend.constructor.name.includes('WebGPU') ? 'WEBGPU' : 'WEBGL 2';
  element('backend').textContent = backend;
  const camera = new PerspectiveCamera(BASE_CAMERA_FOV, innerWidth / innerHeight, 0.2, 1800);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  const walking = new BaseWalk(camera, renderer.domElement, root.querySelector<HTMLElement>('.walk-controls')!);
  let world: StudyWorld | undefined;
  let focus: ReturnType<typeof baseFocus> | undefined;
  let building = false, requested = false, disposed = false, serial = 0;
  let last = performance.now(), elapsed = 0, frameCount = 0, intervalStart = performance.now();

  function syncUI(): void {
    const study = STUDIES[studyIndex];
    root.style.setProperty('--accent', study.infection);
    root.dataset.view = view;
    root.dataset.assets = String(assetMode);
    root.dataset.inspection = inspection;
    root.dataset.state = planetState;
    root.dataset.walking = String(walking.active);
    focusControl.checked = focusBlur;
    element('walk').textContent = walking.active ? 'Orbit view' : 'Walk';
    element('walk').setAttribute('aria-pressed', String(walking.active));
    focus?.setEnabled(focusBlur && inspection === 'scene' && view !== 'fauna');
    effectsControl.checked = effects;
    root.querySelectorAll<HTMLButtonElement>('[data-state]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.state === planetState)));
    element('study-count').textContent = `${String(studyIndex + 1).padStart(2, '0')} / ${STUDIES.length}`;
    const featureOptions = assetMode ? BASE_FEATURES[study.id] : [];
    inspectionControl.querySelector('optgroup')?.remove();
    if (featureOptions.length) {
      const options = document.createElement('optgroup'); options.label = 'This base';
      for (const feature of featureOptions) {
        const option = document.createElement('option'); option.value = `feature:${feature.id}`; option.textContent = feature.name; options.append(option);
      }
      inspectionControl.append(options);
    }
    inspectionControl.value = inspection === 'features' && featureFocus ? `feature:${featureFocus}` : inspection;
    root.dataset.study = study.id;
    element('designation').textContent = study.designation;
    element('biome').textContent = study.biome.toUpperCase();
    element('world-name').textContent = study.name;
    element('description').textContent = study.description;
    seedControl.value = String(seed);
    element('motion').textContent = paused ? 'Resume motion' : 'Pause motion';
    element('motion').setAttribute('aria-pressed', String(paused));
    element('choose').textContent = selected === study.id ? 'Base selected' : 'Choose base planet';
    element('choose').setAttribute('aria-pressed', String(selected === study.id));
    element('selection-status').textContent = selected ? `Selected: ${STUDIES.find((entry) => entry.id === selected)?.name ?? ''}` : 'No base selected';
    root.querySelectorAll<HTMLButtonElement>('[data-study]').forEach((button) => {
      const active = Number(button.dataset.study) === studyIndex;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle('is-chosen', STUDIES[Number(button.dataset.study)].id === selected);
    });
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.view === view));
      button.tabIndex = button.dataset.view === view ? 0 : -1;
    });
    root.querySelector<HTMLButtonElement>(`button[data-study="${studyIndex}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    element('creature-labels').innerHTML = study.enemies.map((name, index) => `<div><small>${['SWARMER / CLASS I', 'HUNTER / CLASS II', 'APEX / CLASS III'][index]}</small><strong>${name}</strong></div>`).join('');
    element('creature-switch').innerHTML = study.enemies.map((name, index) => `<button role="tab" data-creature="${index}" aria-selected="${focusCreature === index}" tabindex="${focusCreature === index ? 0 : -1}"><small>${['SWARMER', 'HUNTER', 'APEX'][index]}</small>${name}</button>`).join('');
    if (assetMode) {
      root.querySelector('.wordmark')!.setAttribute('href', '/base-planets.html');
      element('creature-labels').innerHTML = '<div><small>WINGED HUNTER / MUTATION 01</small><strong>Pollen Reaver</strong></div>';
      element('creature-switch').innerHTML = '';
      root.querySelector('.masthead-label')!.textContent = `${study.name.toUpperCase()} / BASE PLANET`;
      root.querySelector('.archive-bottom > span')!.innerHTML = `<a href="${new URL('./assets/ATTRIBUTION.md', import.meta.url).href}" target="_blank" rel="noopener">ASSET CREDITS</a>`;
    }
    const url = new URL(location.href);
    url.searchParams.set('planet', study.id);
    url.searchParams.set('seed', String(seed));
    url.searchParams.set('view', view);
    url.searchParams.set('quality', quality);
    if (assetMode) {
      url.pathname = '/base-planets.html';
      url.searchParams.set('assets', '1');
      url.searchParams.set('inspect', inspection);
      url.searchParams.set('state', planetState);
      url.searchParams.set('effects', effects ? 'on' : 'off');
      url.searchParams.set('focus', focusBlur ? 'on' : 'off');
      if (featureFocus && inspection === 'features') url.searchParams.set('feature', featureFocus); else url.searchParams.delete('feature');
    }
    history.replaceState(null, '', url);
  }

  function resetCamera(): void {
    if (!world) return;
    walking.setActive(false); controls.enabled = true;
    camera.position.copy(world.camera);
    if (assetMode && inspection !== 'scene' && view === 'surface') camera.position.sub(world.target).multiplyScalar(Math.max(1, 0.85 / camera.aspect)).add(world.target);
    if (view === 'orbit') camera.position.sub(world.target).multiplyScalar(Math.max(1, 1.12 / camera.aspect)).add(world.target);
    if (view === 'fauna' && compact()) camera.position.sub(world.target).multiplyScalar(Math.max(1, 0.65 / camera.aspect)).add(world.target);
    controls.target.copy(world.target);
    controls.minDistance = world.minDistance;
    controls.maxDistance = Math.max(world.maxDistance, camera.position.distanceTo(world.target) * 1.35);
    controls.minPolarAngle = view === 'surface' ? 0.72 : 0.1;
    controls.maxPolarAngle = view === 'surface' ? (assetMode && inspection !== 'scene' ? Math.PI - 0.1 : 1.71) : view === 'fauna' ? 1.5 : Math.PI - 0.1;
    controls.minAzimuthAngle = view === 'surface' && !assetMode ? -0.15 : -Infinity;
    controls.maxAzimuthAngle = view === 'surface' && !assetMode ? 0.85 : Infinity;
    camera.lookAt(controls.target);
    controls.update();
    controls.saveState();
    syncUI();
  }

  async function rebuild(): Promise<void> {
    requested = true;
    serial++;
    syncUI();
    if (building) return;
    building = true;
    loading.hidden = false;
    try {
      while (requested && !disposed) {
        requested = false;
        const ticket = serial;
        element('loading-label').textContent = `Forming ${STUDIES[studyIndex].name}`;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const next = assetMode
          ? await (await import('./AssetScene')).buildAssetWorld(view, mobileBudget(), renderer, seed, STUDIES[studyIndex], inspection, featureFocus)
          : buildWorld(STUDIES[studyIndex], seed, view, mobileBudget(), compact() && view === 'fauna' ? focusCreature : -1);
        renderer.setPixelRatio(Math.min(devicePixelRatio, mobileBudget() ? 1 : 1.5));
        camera.position.copy(next.camera);
        camera.lookAt(next.target);
        try { await renderer.compileAsync(next.scene, camera); } catch (error) { next.dispose(); throw error; }
        if (ticket !== serial || disposed) { next.dispose(); continue; }
        world?.dispose();
        focus?.dispose();
        world = next;
        focus = assetMode ? baseFocus(renderer, world.scene, camera, mobileBudget()) : undefined;
        walking.setSurface(world.surface);
        world.setState?.(planetState);
        world.setEffects?.(effects);
        resetCamera();
        camera.updateMatrixWorld();
        world.update(elapsed, camera);
        if (focus) focus.render(); else renderer.render(world.scene, camera);
        element('performance').textContent = `${backend} / ${renderer.info.render.drawCalls} DRAWS / ${mobileBudget() ? 'MOBILE' : 'HIGH'}`;
        intervalStart = performance.now();
        frameCount = 0;
      }
      loading.hidden = true;
    } catch (error) {
      element('loading-label').textContent = `Unable to render this study. ${error instanceof Error ? error.message : String(error)}`;
      console.error(error);
    } finally { building = false; }
  }

  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.study !== undefined) {
      studyIndex = Number(button.dataset.study);
      featureFocus = '';
      seed = STUDIES[studyIndex].seed;
      void rebuild();
      button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: paused ? 'instant' : 'smooth' });
    } else if (button.dataset.view) {
      view = button.dataset.view as StudyView;
      inspection = 'scene';
      void rebuild();
    } else if (button.dataset.state) {
      planetState = button.dataset.state as PlanetState;
      world?.setState?.(planetState);
      syncUI();
    } else if (button.dataset.creature) {
      focusCreature = Number(button.dataset.creature);
      void rebuild();
    }
  });
  root.addEventListener('keydown', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const siblings = Array.from(button.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = siblings.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? siblings.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + siblings.length) % siblings.length;
    siblings[next].focus();
    siblings[next].click();
  });
  element('regenerate').onclick = () => { seed = crypto.getRandomValues(new Uint32Array(1))[0]; void rebuild(); };
  seedControl.onchange = () => {
    if (!seedControl.validity.valid || seedControl.value === '') { seedControl.value = String(seed); return; }
    seed = Number(seedControl.value) >>> 0;
    void rebuild();
  };
  qualityControl.onchange = () => { quality = qualityControl.value; void rebuild(); };
  inspectionControl.onchange = () => {
    const selection = inspectionControl.value;
    featureFocus = selection.startsWith('feature:') ? selection.slice(8) : '';
    inspection = featureFocus ? 'features' : selection as EnvironmentInspection;
    view = 'surface'; void rebuild();
  };
  element('reset').onclick = resetCamera;
  element('motion').onclick = () => { paused = !paused; syncUI(); };
  focusControl.onchange = () => { focusBlur = focusControl.checked; syncUI(); };
  element('walk').onclick = () => {
    if (walking.active) resetCamera(); else { walking.setActive(true); controls.enabled = !walking.active; }
    syncUI();
  };
  motionPreference.addEventListener('change', (event) => { if (event.matches) { paused = true; syncUI(); } });
  effectsControl.onchange = () => { effects = effectsControl.checked; world?.setEffects?.(effects); syncUI(); };
  element('choose').onclick = () => {
    selected = STUDIES[studyIndex].id;
    try { localStorage.setItem('necrofall.concepts.selection', selected); } catch {}
    syncUI();
  };
  element('hide').onclick = () => {
    hiddenUI = !hiddenUI;
    root.classList.toggle('ui-hidden', hiddenUI);
    element('hide').textContent = hiddenUI ? 'Show UI' : 'Hide UI';
    element('hide').setAttribute('aria-label', hiddenUI ? 'Show interface' : 'Hide interface');
  };
  element('capture').onclick = () => {
    if (!world) return;
    if (focus) focus.render(); else renderer.render(world.scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url;
      link.download = `necrofall-base-${STUDIES[studyIndex].id}-${seed}-${view}-${planetState}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  };
  let wasCompact = compact(), wasMobile = mobileBudget();
  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    if (compact() !== wasCompact || mobileBudget() !== wasMobile) {
      wasCompact = compact();
      wasMobile = mobileBudget();
      void rebuild();
    } else if (view !== 'surface') resetCamera();
  });
  renderer.setAnimationLoop(() => {
    const now = performance.now(), delta = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!world || disposed || document.hidden || building) return;
    if (!paused) elapsed += delta;
    if (walking.active) walking.update(delta); else controls.update();
    camera.updateMatrixWorld();
    world.update(elapsed, camera);
    if (focus) focus.render(); else renderer.render(world.scene, camera);
    frameCount++;
    if (now - intervalStart > 1000) {
      const fps = Math.round(frameCount * 1000 / (now - intervalStart));
      element('performance').textContent = `${backend} / ${fps} FPS / ${renderer.info.render.drawCalls} DRAWS / ${mobileBudget() ? 'MOBILE' : 'HIGH'}`;
      frameCount = 0;
      intervalStart = now;
    }
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    controls.dispose();
    walking.dispose();
    focus?.dispose();
    world?.dispose();
    renderer.dispose();
  }, { once: true });
  const debug = {
    setFeatureVisibility(id: string, visible: boolean) {
      world?.scene.getObjectByName('base-features')?.traverse(object => {
        if (object.name === id || object.name.startsWith(`${id}:`)) object.visible = visible && (!object.userData.weatherFeature || effects);
      });
    },
    setWeatherLayerVisibility(id: string, visible: boolean) {
      const layer = world?.scene.getObjectByName(`weather-${id}`); if (layer) layer.visible = visible;
    },
    geometryAudit() { return world?.scene.userData.geometryAudit?.(); },
    surfaceAt(positionX: number, positionZ: number) { return world?.surface?.sample(positionX, positionZ); },
    get snapshot() {
      const weather = world?.scene.getObjectByName('study-weather');
      const water = world?.scene.getObjectByName('study-water');
      return { study: STUDIES[studyIndex].id, seed, view, inspection, backend, mobile: mobileBudget(), building, selected, elapsed, assets: assetMode, paused,
        focusBlur, featureFocus, walking: walking.active, feet: walking.position.toArray(), surfaceCount: world?.surface?.solids.length ?? 0,
        features: world?.scene.getObjectByName('base-features')?.userData.features ?? [],
        spikes: (world?.scene.getObjectByName('base-spikes') as any)?.count ?? 0, crystals: (world?.scene.getObjectByName('base-crystals') as any)?.count ?? 0,
        state: planetState, sceneState: world?.scene.userData.state, effects, sceneId: world?.scene.uuid, radiationMaterials: world?.scene.userData.radiationMaterials,
        weather: weather ? { ...weather.userData, visible: weather.visible } : null, water: water ? { ...water.userData } : null,
        drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries,
        camera: camera.position.toArray(), creatures: world?.creatures.length ?? 0, grassBlades: world?.scene.getObjectByName('study-grass')?.userData.blades ?? 0, specimenBounds: world?.scene.userData.specimenBounds?.(), canvas: { width: renderer.domElement.width, height: renderer.domElement.height } };
    },
  };
  Object.defineProperty(window, 'necrofallStudies', { value: debug, configurable: true });
  await rebuild();
}

void boot().catch((error: unknown) => {
  const root = document.querySelector('#concepts')!;
  root.replaceChildren();
  const message = document.createElement('p');
  message.className = 'boot-error';
  message.textContent = `Planet studies could not start: ${String(error)}`;
  const retry = document.createElement('a');
  const url = new URL(location.href);
  url.searchParams.set('backend', 'webgl');
  retry.href = url.toString();
  retry.textContent = 'Try WebGL 2';
  root.append(message, retry);
  console.error(error);
});