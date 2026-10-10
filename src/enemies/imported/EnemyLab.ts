import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ImportedVisual } from './ImportedVisual';
import { bodyForm, capabilities, legalAttacks, normalizeAnatomy, type BaseGenome, type BodyForm, type EnemyAnatomy, type GlowPattern } from './EnemyAnatomy';
import { generateEcology, factsFromSeed } from '../procedural/EcologyGenerator';
import { NECRO_UNIFORMS } from '../../rendering/materials/NecroChunks';

export async function startEnemyLab(): Promise<void> {
  const host = document.createElement('main');
  host.className = 'enemy-lab';
  host.innerHTML = `
    <style>
      .enemy-lab{position:fixed;inset:0;z-index:500;background:#d4e1dd;color:#182b2d;font-family:Rajdhani,sans-serif;letter-spacing:0}
      .enemy-lab canvas{display:block;width:100%;height:100%;touch-action:none}
      .enemy-lab header{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;background:#f2f5efe8;border-bottom:1px solid #9caaa4}
      .enemy-lab h1{font-size:21px;margin:0;font-weight:700;letter-spacing:0}
      .enemy-lab a{color:#265952;font-size:14px}
      .enemy-lab aside{position:absolute;top:64px;left:16px;width:248px;bottom:44px;overflow:auto;padding:12px;background:#f2f5efe8;border:1px solid #a4b3ac}
      .enemy-lab fieldset{border:0;border-bottom:1px solid #bccac3;margin:0 0 12px;padding:0 0 12px;min-width:0}
      .enemy-lab legend{font-size:14px;font-weight:700;margin-bottom:8px}
      .enemy-lab label{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:14px;margin:7px 0}
      .enemy-lab input[type=range]{width:124px;accent-color:#297569}
      .enemy-lab input[type=number]{width:118px}
      .enemy-lab select{max-width:145px;min-width:0}
      .enemy-lab select,.enemy-lab input[type=number],.enemy-lab button{font:inherit;color:#183c36;border:1px solid #819a8f;border-radius:3px;background:#fbfdf8;padding:5px 8px}
      .enemy-lab button{cursor:pointer;font-weight:600}.enemy-lab button:disabled{opacity:.45;cursor:default}
      .enemy-lab input[type=color]{width:45px;height:27px;padding:0;border:0}
      .enemy-lab .commands{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      .enemy-lab footer{position:absolute;bottom:0;left:0;right:0;background:#f2f5efe8;padding:9px 18px;font-size:13px;min-height:32px;box-sizing:border-box}
      .enemy-lab output{font-variant-numeric:tabular-nums}
      @media(max-width:700px){.enemy-lab header{padding:10px 12px}.enemy-lab h1{font-size:17px}.enemy-lab aside{top:auto;bottom:32px;left:0;right:0;width:auto;height:30%;display:flex;gap:16px;padding:10px;overflow:auto}.enemy-lab fieldset{min-width:205px;margin:0;border-bottom:0;border-right:1px solid #bccac3;padding-right:14px}.enemy-lab footer{font-size:11px}.enemy-lab label{margin:5px 0}}
    </style>
    <header><h1>NECROFALL / ENEMY FOUNDRY</h1><a href="/">Main Game</a></header>
    <aside aria-label="Enemy modeling controls">
      <fieldset><legend>Genome</legend>
        <label>Seed<input id="el-seed" type="number" min="1" max="4294967295" value="719"></label>
        <label>Roster<select id="el-roster"></select></label>
        <label>Body<select id="el-base"><option>crawler</option><option>parasite</option><option>behemoth</option></select></label>
        <div class="commands"><button id="el-roll">Regenerate</button><button id="el-export">Export</button><button id="el-import">Import</button></div>
        <input id="el-file" type="file" accept="application/json" hidden>
      </fieldset>
      <fieldset><legend>Anatomy</legend>
        <label>Form<select id="el-form"><option value="original">Original</option><option value="stalker">Stalker</option><option value="bulwark">Bulwark</option><option value="spire">Spire</option></select></label>
        <label>Torso<input id="el-body" type="range" min="0.6" max="1.8" step="0.01"></label>
        <label>Length<input id="el-length" type="range" min="0.65" max="1.8" step="0.01"></label>
        <label>Head<input id="el-head" type="range" min="0.6" max="1.8" step="0.01"></label>
        <label>Head Model<select id="el-headBase"><option>crawler</option><option>parasite</option><option>behemoth</option></select></label>
        <label>Limbs<input id="el-limbs" type="range" min="0.7" max="1.5" step="0.01"></label>
        <label>Tail<input id="el-tail-on" type="checkbox"></label>
        <label>Tail Length<input id="el-tail" type="range" min="0.75" max="2" step="0.01"></label>
        <label>Tail Model<select id="el-tailBase"><option>crawler</option><option>parasite</option><option>behemoth</option></select></label>
        <label>Wings<input id="el-wings" type="checkbox"></label>
        <label>Size<input id="el-size" type="range" min="0.5" max="6" step="0.1"></label>
        <label>Chitin<input id="el-color" type="color"></label>
        <label>Accent<input id="el-accent" type="color"></label>
        <label>Glow<input id="el-glow" type="range" min="0" max="2.5" step="0.05"></label>
        <label>Pattern<select id="el-pattern"><option value="veins">Veins</option><option value="bands">Bands</option><option value="cells">Cells</option></select></label>
      </fieldset>
      <fieldset><legend>Motion</legend>
        <label>Terrain<select id="el-terrain"><option value="hills">Hills</option><option value="boulders">Boulders</option><option value="flat">Flat</option></select></label>
        <label>Speed<input id="el-speed" type="range" min="0" max="3" step="0.1" value="0.7"></label>
        <label>Attack<select id="el-attack"></select></label>
        <label>Skeleton<input id="el-skeleton" type="checkbox"></label>
        <label>Contacts<input id="el-contacts" type="checkbox"></label>
        <label>Stunned<input id="el-stunned" type="checkbox"></label>
        <div class="commands"><button id="el-strike">Attack</button><button id="el-frame">Frame Model</button></div>
      </fieldset>
    </aside><footer><output id="el-status">Loading model</output></footer>`;
  document.body.appendChild(host);
  const input = (id: string) => host.querySelector<HTMLInputElement>(`#el-${id}`)!;
  const select = (id: string) => host.querySelector<HTMLSelectElement>(`#el-${id}`)!;
  const status = host.querySelector<HTMLOutputElement>('#el-status')!;
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).get('backend') === 'webgl' });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
  await renderer.init();
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd4e1dd);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 250);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 1;
  controls.maxDistance = 60;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5e786b, 2));
  const sun = new THREE.DirectionalLight(0xffefdb, 2.5);
  sun.position.set(4, 108, 5); scene.add(sun);
  const geometry = new THREE.PlaneGeometry(30, 30, 100, 100).rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x8fa69a, roughness: 1, flatShading: true });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.position.y = 100;
  scene.add(terrain);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const scratch = new THREE.Vector3();
  const slope = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const side = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const heightAt = (horizontal: number, forward: number) => {
    if (select('terrain').value === 'flat') return 0;
    const hills = Math.sin(horizontal * 0.55) * Math.cos(forward * 0.45) * 0.3;
    if (select('terrain').value === 'hills') return hills;
    let height = hills;
    for (const [centreX, centreZ, radius] of [[2.7, 1, 1.1], [-2.5, -0.9, 0.9], [0.5, -2.8, 0.7]]) {
      const distance = Math.hypot(horizontal - centreX, forward - centreZ) / radius;
      height += Math.max(0, 1 - distance * distance) ** 2 * radius * 0.6;
    }
    return height;
  };
  function rebuildTerrain() {
    const positions = geometry.attributes.position;
    for (let vertex = 0; vertex < positions.count; vertex++) positions.setY(vertex, heightAt(positions.getX(vertex), positions.getZ(vertex)));
    positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere(); terrain.updateMatrixWorld(true);
  }
  rebuildTerrain();
  const ground = (point: THREE.Vector3, normal: THREE.Vector3, reach: number, out: THREE.Vector3) => {
    raycaster.set(scratch.copy(point).setY(110), down);
    const hit = raycaster.intersectObject(terrain, false)[0];
    if (!hit) return false;
    out.copy(hit.point); return true;
  };
  let seed = 719;
  let anatomy = generateEcology(seed, factsFromSeed(seed, 2)).genomes[0].anatomy!;
  let visual: ImportedVisual | null = null;
  let skeleton: THREE.SkeletonHelper | null = null;
  let request = 0;
  let travel = 0;
  let attackTime = 0;
  let elapsed = 0;
  const contactGeometry = new THREE.BufferGeometry();
  const contactMaterial = new THREE.PointsMaterial({ color: 0xed4d35, size: 0.085, depthTest: false });
  const contactMarkers = new THREE.Points(contactGeometry, contactMaterial);
  contactMarkers.frustumCulled = false; contactMarkers.renderOrder = 10; scene.add(contactMarkers);

  function syncControls() {
    select('base').value = anatomy.base;
    for (const key of ['headBase', 'tailBase'] as const) select(key).value = anatomy[key] ?? anatomy.base;
    for (const key of ['body', 'head', 'limbs', 'size', 'length', 'glow'] as const) input(key).value = String(anatomy[key]);
    select('form').value = anatomy.form ?? 'original';
    select('pattern').value = anatomy.pattern ?? 'veins';
    input('tail').value = String(anatomy.tail || 1);
    input('tail-on').checked = anatomy.tail > 0;
    input('tail').disabled = anatomy.tail === 0;
    input('wings').checked = anatomy.wings;
    input('wings').disabled = anatomy.base !== 'parasite';
    for (const key of ['color', 'accent'] as const) input(key).value = `#${anatomy[key].toString(16).padStart(6, '0')}`;
    select('attack').replaceChildren(...legalAttacks(anatomy).map(attack => new Option(attack, attack)));
    select('attack').value = anatomy.attack;
  }
  function frame() {
    if (!visual) return;
    scene.updateMatrixWorld(true);
    visual.root.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.update(); });
    const bounds = new THREE.Box3().setFromObject(visual.root, true);
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()).length();
    const mobile = innerWidth < 700;
    const panel = host.querySelector('aside')!.getBoundingClientRect();
    const availableWidth = mobile ? innerWidth : innerWidth - panel.right - 24;
    const availableHeight = mobile ? panel.top - 70 : innerHeight - 130;
    const field = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(availableHeight / innerHeight, availableWidth / innerHeight));
    const distance = size * 0.55 / Math.sin(field);
    camera.setViewOffset(innerWidth, innerHeight, mobile ? 0 : -(panel.right + 24) / 2, mobile ? (innerHeight - panel.top - 60) / 2 : 0, innerWidth, innerHeight);
    controls.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(0.8, 0.45, 1).normalize().multiplyScalar(distance));
    controls.update();
  }
  async function rebuild() {
    const ticket = ++request;
    status.value = 'Loading model';
    anatomy = normalizeAnatomy(anatomy);
    syncControls();
    try {
      const next = await ImportedVisual.create(anatomy.base, anatomy.size, anatomy);
      if (ticket !== request) { next.dispose(); return; }
      visual?.dispose();
      if (skeleton) { skeleton.removeFromParent(); skeleton.dispose(); }
      visual = next; scene.add(visual.root);
      visual.root.position.set(0, 100, 0); travel = 0;
      skeleton = new THREE.SkeletonHelper(visual.root); skeleton.visible = input('skeleton').checked; scene.add(skeleton);
      frame();
    } catch (error) { status.value = String(error); throw error; }
  }
  function regenerate() {
    seed = Number(input('seed').value) >>> 0 || 1;
    const roster = generateEcology(seed, factsFromSeed(seed, 2));
    const selected = Number(select('roster').value) || 0;
    select('roster').replaceChildren(...roster.genomes.map(genome => new Option(`${genome.idx} / ${genome.anatomy!.base} / ${genome.tier}`, String(genome.idx))));
    select('roster').value = String(selected);
    anatomy = { ...roster.genomes[selected].anatomy! };
    void rebuild();
  }
  for (const key of ['body', 'head', 'limbs', 'size', 'length', 'glow'] as const) input(key).addEventListener('change', () => { anatomy[key] = Number(input(key).value); void rebuild(); });
  select('form').addEventListener('change', () => { anatomy = { ...anatomy, ...bodyForm(select('form').value as BodyForm) }; void rebuild(); });
  select('pattern').addEventListener('change', () => { anatomy.pattern = select('pattern').value as GlowPattern; void rebuild(); });
  for (const key of ['headBase', 'tailBase'] as const) select(key).addEventListener('change', () => { anatomy[key] = select(key).value as BaseGenome; void rebuild(); });
  for (const key of ['color', 'accent'] as const) input(key).addEventListener('change', () => { anatomy[key] = Number.parseInt(input(key).value.slice(1), 16); void rebuild(); });
  input('tail').addEventListener('change', () => { anatomy.tail = Number(input('tail').value); void rebuild(); });
  input('tail-on').addEventListener('change', () => { anatomy.tail = input('tail-on').checked ? 1 : 0; void rebuild(); });
  input('wings').addEventListener('change', () => { anatomy.wings = input('wings').checked; void rebuild(); });
  select('base').addEventListener('change', () => { anatomy.base = select('base').value as BaseGenome; void rebuild(); });
  select('roster').addEventListener('change', regenerate);
  input('seed').addEventListener('change', regenerate);
  select('terrain').addEventListener('change', rebuildTerrain);
  select('attack').addEventListener('change', () => { anatomy.attack = select('attack').value as EnemyAnatomy['attack']; });
  host.querySelector('#el-roll')!.addEventListener('click', () => { input('seed').value = String((seed + 1) >>> 0); regenerate(); });
  host.querySelector('#el-strike')!.addEventListener('click', () => { attackTime = 0.95; });
  host.querySelector('#el-frame')!.addEventListener('click', frame);
  host.querySelector('#el-export')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, seed, anatomy }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `necrofall-genome-${seed}.json`; link.click(); URL.revokeObjectURL(url);
  });
  host.querySelector('#el-import')!.addEventListener('click', () => input('file').click());
  input('file').addEventListener('change', async () => {
    try {
      const file = input('file').files?.[0]; if (!file) return;
      if (file.size > 10000) throw new Error('Genome file exceeds 10 KB');
      const parsed = JSON.parse(await file.text());
      if (parsed.version !== 1 || !['crawler', 'parasite', 'behemoth'].includes(parsed.anatomy?.base)) throw new Error('Invalid genome');
      anatomy = normalizeAnatomy(parsed.anatomy); seed = Number(parsed.seed) >>> 0; input('seed').value = String(seed);
      await rebuild();
    } catch (error) { status.value = String(error); }
  });
  const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); frame(); };
  addEventListener('resize', resize); resize();
  function tick(dt: number) {
    elapsed += dt;
    if (!visual) return;
    const stunned = input('stunned').checked;
    const speed = Number(input('speed').value);
    if (!stunned) { travel += dt * speed / 3; attackTime = Math.max(0, attackTime - dt); }
    const previous = visual.root.position.clone();
    visual.root.position.set(Math.sin(travel) * 3, 100, Math.cos(travel) * 3 - 3);
    visual.root.position.y += heightAt(visual.root.position.x, visual.root.position.z);
    const horizontal = visual.root.position.x, depth = visual.root.position.z;
    slope.set(-(heightAt(horizontal + 0.15, depth) - heightAt(horizontal - 0.15, depth)) / 0.3, 1,
      -(heightAt(horizontal, depth + 0.15) - heightAt(horizontal, depth - 0.15)) / 0.3).normalize();
    forward.set(Math.cos(travel), 0, -Math.sin(travel)).addScaledVector(slope, -forward.dot(slope)).normalize();
    side.crossVectors(slope, forward).normalize();
    visual.root.quaternion.setFromRotationMatrix(basis.makeBasis(side, slope, forward));
    camera.position.add(scratch.copy(visual.root.position).sub(previous)); controls.target.add(scratch);
    visual.update(dt, speed, { flash: 0, frost: 0, stunned, enraged: false, ground, up,
      attack: anatomy.attack, attackPhase: attackTime > 0 ? 1 - attackTime / 0.95 : 0 });
    if (skeleton) skeleton.visible = input('skeleton').checked;
    contactMarkers.visible = input('contacts').checked;
    if (contactMarkers.visible) contactGeometry.setAttribute('position', new THREE.Float32BufferAttribute(visual.locomotion.contacts.flatMap(foot => foot.planted.toArray()), 3));
    const cap = capabilities(anatomy);
    status.value = `${anatomy.base.toUpperCase()} / ${cap.supportLegs} support limbs / ${cap.heavy ? 'heavy' : 'agile'} / ${cap.canFly ? 'flight capable' : 'grounded'} / ${visual.locomotion.steps} steps`;
    NECRO_UNIFORMS.uTime.value = elapsed;
    NECRO_UNIFORMS.uCamPos.value.copy(camera.position);
    controls.update(); renderer.render(scene, camera);
  }
  let previousTime = performance.now();
  renderer.setAnimationLoop(() => { const now = performance.now(); tick(Math.min(0.05, (now - previousTime) / 1000)); previousTime = now; });
  (window as unknown as { enemyLab: unknown }).enemyLab = {
    get visual() { return visual; }, get anatomy() { return anatomy; }, renderer, scene, camera, ground, tick,
    setAnatomy: async (next: EnemyAnatomy) => { anatomy = next; await rebuild(); },
  };
  regenerate();
}