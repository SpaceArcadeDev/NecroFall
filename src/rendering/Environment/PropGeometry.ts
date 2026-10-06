// NECROFALL — shared low-poly prop geometry (complete visual + terrain + underground rework,
// plan §59/§60). ONE source for the stylised silhouettes every environment composition reuses:
// geological formations, cave dressing and sci-fi structures all build from these, so the
// planet's asset language stays coherent (plan §60: large colour blocks, sharp silhouettes).
//
// Every factory takes a deterministic seed and jitters POSITION-HASHED vertices so shared
// vertices deform identically (no cracks), the same rule `Rocks.ts` established.
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../planet/PlanetSeed';

/** Jittered icosahedron. `stretch` flattens (0.6) or erects (1.4) the silhouette. */
export function boulderGeometry(seed: number, stretch = 0.75): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    const h = mulberry32(
      seed ^
        Math.imul(Math.round(x * 1000) | 0, 374761393) ^
        Math.imul(Math.round(y * 1000) | 0, 668265263) ^
        Math.imul(Math.round(z * 1000) | 0, 1442695041),
    )();
    const scale = 1 + (h - 0.5) * 0.55;
    array[i] = x * scale;
    array[i + 1] = y * scale * stretch;
    array[i + 2] = z * scale;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Flattened, corner-broken box — ceiling slabs, cliff blocks, ruin panels, ship plating. */
export function slabGeometry(seed: number, jitterAmount = 0.34): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(2, 2, 2, 2, 1, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const jitter = (mulberry32(seed ^ Math.imul(i, 2654435761))() - 0.5) * jitterAmount;
    array[i] += jitter;
    array[i + 1] += jitter * 0.5;
    array[i + 2] -= jitter;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Unit-height rock cone, base at y=0, tip +Y — stalactites, stalagmites, spires. */
export function coneGeometry(seed: number, sides = 6): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(0.5, 1, sides, 1);
  geometry.translate(0, 0.5, 0);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const jitter = (mulberry32(seed ^ Math.imul(i, 40503))() - 0.5) * 0.18;
    array[i] += jitter;
    array[i + 2] += jitter * 0.7;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Stretched octahedron rooted at y=0 — crystal shards, spires, energy veins. */
export function shardGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(0.4, 0);
  geometry.scale(0.5, 1.6, 0.5);
  geometry.translate(0, 0.62, 0);
  return geometry;
}

/** Squat light-frond bush — cave glow fans, crystal flowers (plan §18 sci-fi vegetation). */
export function fanGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(0.5, 0);
  geometry.scale(1, 0.5, 0.4);
  geometry.translate(0, 0.2, 0);
  return geometry;
}

/** Thin broken panel — ruins, debris plating, ship fragments. */
export function panelGeometry(seed: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(2, 2, 0.24, 2, 2, 1);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const jitter = (mulberry32(seed ^ Math.imul(i, 97))() - 0.5) * 0.2;
    array[i] += jitter;
    array[i + 1] += jitter * 0.4;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Wedge hull: a long tapered box (nose at +Z) — crashed-ship fuselage segments. */
export function hullGeometry(seed: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.62, 0.34, 2, 7, 1);
  geometry.rotateX(Math.PI / 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const jitter = (mulberry32(seed ^ Math.imul(i, 8191))() - 0.5) * 0.09;
    array[i] += jitter;
    array[i + 1] += jitter * 0.6;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Flat disc (hex) — landing pads, dish antennas, energy rings. */
export function padGeometry(radius: number, thickness: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, thickness, 6, 1);
}

/**
 * Cave roof dome (user ask 2026-10-06): a partial sphere with a wedge REMOVED — the wedge is the
 * cave mouth. The gap is centred on local −X (SphereGeometry's phi=0 direction), so the instance
 * basis maps −X to the cave's approach azimuth. Unit radius (scale x/z by the dome spread, y by
 * its height) with hashed vertex jitter so the rock reads organic, never a smooth ball.
 */
export function domeGeometry(seed: number, wedge = 1.15, segments = 36, rings = 14): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, segments, rings, wedge / 2, Math.PI * 2 - wedge, 0, Math.PI * 0.54);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    const h = mulberry32(
      seed ^
        Math.imul(Math.round(x * 1000) | 0, 374761393) ^
        Math.imul(Math.round(y * 1000) | 0, 668265263) ^
        Math.imul(Math.round(z * 1000) | 0, 1442695041),
    )();
    const scale = 1 + (h - 0.5) * 0.14;
    array[i] = x * scale;
    array[i + 1] = y * scale;
    array[i + 2] = z * scale;
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Unit box the caller scales — mast segments, posts, beams. */
export function beamGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

export function ringGeometry(radius: number, tube: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, tube, 6, 16);
}
