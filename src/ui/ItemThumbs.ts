// NECROFALL — tiny offscreen portraits of the catalog items, for the squircle chips in the
// customize list: every hat / backpack / pet gets ONE real render (the same builder the game
// wears), cached as a data URL for the session.
//
// It runs on its own little WebGL context that is created the first time a category is asked for
// and then kept: the menu preview's own renderer belongs to whichever selection screen is open and
// must not be resized or have its scene swapped out from under it. Rendering is done once per item
// — 16 small models, one frame each — so the cost is a few tens of milliseconds, paid lazily on
// the first time a category is displayed.
import * as THREE from 'three';
import { AccessoryDef, AccessoryCategory } from '../customization/AccessoryTypes';
import { defsOf } from '../customization/AccessoryCatalog';
import { disposeObject } from '../customization/AvatarAccessories';

/** Logical size of a thumbnail. The squircle draws it at ~46 px; dpr brings it up on retina. */
const SIZE = 96;
const FOV = 32;
/** Untouched categories are absent from `built`; a failed category caches nulls and is not retried. */
const cache = new Map<string, string | null>();
const built = new Set<AccessoryCategory>();

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

/** A soft round falloff, drawn once — the halo every item is back-lit with. */
let glowTex: THREE.CanvasTexture | null = null;
function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.42)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/**
 * The data URL for one catalog item (`idx` < 0 = NONE, which has no model), or null while the
 * item has none (WebGL unavailable). Requesting any item generates its whole category in one go.
 */
export function itemThumb(cat: AccessoryCategory, idx: number): string | null {
  if (idx < 0) return null;
  const key = `${cat}:${idx}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  if (!built.has(cat)) buildCategory(cat);
  return cache.get(key) ?? null;
}

function buildCategory(cat: AccessoryCategory): void {
  built.add(cat);
  const defs = defsOf(cat);
  try {
    ensureStage();
    defs.forEach((def, idx) => cache.set(`${cat}:${idx}`, renderOne(def)));
  } catch (err) {
    // no WebGL (or a builder threw): the list simply shows empty squircles, never a broken screen
    console.warn('[NECROFALL] item thumbnails unavailable:', err);
    defs.forEach((_d, idx) => cache.set(`${cat}:${idx}`, null));
  }
}

function ensureStage(): void {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(SIZE, SIZE, false);

  scene = new THREE.Scene();
  // Brighter than the big preview scene ON PURPOSE: a chip is one item in a 96 px frame, and the
  // near-black bodies disappear against the dark list unless the fill, the rim and the back light
  // all pull their weight.
  scene.add(new THREE.HemisphereLight(0xc8d4ff, 0x2a2040, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3.2, 5.5, 4.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.5);
  rim.position.set(-4, 2.5, -3.5);
  scene.add(rim);
  // from BEHIND the item: the silhouette picks up a bright edge instead of a flat outline
  const back = new THREE.DirectionalLight(0xe6dcff, 1.6);
  back.position.set(0, 1.5, -5);
  scene.add(back);
  const front = new THREE.DirectionalLight(0xffffff, 0.9);
  front.position.set(0, 1, 6);
  scene.add(front);

  camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 40);
}

function renderOne(def: AccessoryDef): string | null {
  const stage = scene!;
  const cam = camera!;
  const view = renderer!;
  const build = def.build();
  const group = build.group;
  group.scale.setScalar(def.scale ?? 1);
  stage.add(group);
  let backlight: THREE.Mesh | null = null;
  try {
    // Run the idle animation for ~0.8 s: emitters (flames, motes) start from an empty pool, and a
    // still frame of a jetpack with no flame reads as a broken model.
    for (let i = 0; i < 24; i++) build.tick?.(0.4 + i / 30, 1 / 30);
    // a three-quarter view says "object", not "sticker"
    group.rotation.y = -0.55;
    stage.updateMatrixWorld(true);
    // pivots differ per item (hats are authored for a head, pets for the ground): centre whatever
    // this one actually occupies, then pull the camera back to fit it
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    group.position.sub(center);
    // ---- the back light: an additive halo panel sitting just behind the item, so even a dark
    // model is silhouetted against luminance instead of the list's own darkness
    const halo = Math.max(size.x, size.y, 0.1) * 2.1 + 0.12;
    backlight = new THREE.Mesh(
      new THREE.PlaneGeometry(halo, halo),
      new THREE.MeshBasicMaterial({
        map: glowTexture(), color: 0xcbb4ff, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    backlight.position.z = -size.z * 0.5 - 0.06;
    backlight.renderOrder = -1;
    stage.add(backlight);
    stage.updateMatrixWorld(true);
    const tan = Math.tan(((FOV * Math.PI) / 180) / 2);
    const half = Math.max(size.x, size.y, 0.08) * 0.5;
    const dist = (half / tan) * 1.18 + size.z * 0.5;
    cam.position.set(0, 0, dist);
    cam.lookAt(0, 0, 0);
    view.render(stage, cam);
    return view.domElement.toDataURL('image/png');
  } finally {
    if (backlight) {
      stage.remove(backlight);
      disposeObject(backlight);
    }
    stage.remove(group);
    disposeObject(group);
    build.dispose?.();
  }
}
