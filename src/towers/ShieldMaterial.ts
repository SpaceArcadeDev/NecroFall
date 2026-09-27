// NECROFALL — animated energy-shield shader used by Beacon / Nexus domes.
import * as THREE from 'three';
import { nfUniforms } from '../world/ShaderGlobals';

const VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vLocal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vLocal = position;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vLocal;

  void main() {
    vec3 n = normalize(vN);
    vec3 viewDir = normalize(uCamPos - vW);
    float fres = pow(1.0 - abs(dot(n, viewDir)), 2.2);

    // spherical lat/long energy lattice, scrolling over time
    vec3 l = normalize(vLocal);
    float a = atan(l.z, l.x);
    float b = asin(clamp(l.y, -1.0, 1.0));
    float lattice = sin(a * 14.0 + uTime * 0.9) * sin(b * 16.0 - uTime * 0.6);
    float grid = smoothstep(0.72, 1.0, lattice * 0.5 + 0.5);

    // rising containment bands
    float bands = smoothstep(0.18, 0.0, abs(fract(l.y * 5.0 - uTime * 0.12) - 0.5));

    float alpha = uOpacity * (0.3 + fres * 1.0 + grid * 0.55 + bands * 0.35);
    vec3 col = uColor * (0.6 + fres * 1.3 + grid * 0.7 + bands * 0.4);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
  }
`;

export function createShieldMaterial(color: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: nfUniforms({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    }),
  });
}

// ---------------------------------------------------------------------------- base shield cone
// A colony fortress is wrapped in a CONE, not a bubble: solid and unmistakably the colony's colour
// where it meets the deck, fading to nothing at the apex so it never hides the fight on the platform
// behind a tinted ball. `vUv.y` runs 0 at the base to 1 at the tip, which is the whole gradient.

const CONE_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying vec2 vUv;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CONE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vW;
  varying vec2 vUv;

  void main() {
    // 0 at the ground, 1 at the tip. The skirt has to VANISH well before the apex: every segment
    // converges on that one point, so any alpha left up there piles up additively into a bright knot
    // and the shield visibly "meets" at the top. The fade is a window that is fully closed by 0.82
    // of the height, so the top of the cone is not drawn at all — a wall at the bottom, open sky
    // above it, and nothing in between that reads as a lid.
    float h = clamp(vUv.y, 0.0, 1.0);
    float fade = 1.0 - smoothstep(0.12, 0.82, h);
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(uCamPos - vW))), 2.0);
    // containment bands climbing the cone, so it reads as energy rather than as tinted glass
    float bands = smoothstep(0.22, 0.0, abs(fract(h * 3.5 - uTime * 0.22) - 0.5));
    float a = uOpacity * fade * (0.5 + fres * 0.85 + bands * 0.55);
    vec3 col = uColor * (0.9 + fres * 0.8 + bands * 0.6);
    gl_FragColor = vec4(col, clamp(a, 0.0, 0.92));
  }
`;

export function createBaseConeMaterial(color: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: CONE_VERT,
    fragmentShader: CONE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: nfUniforms({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    }),
  });
}

// ---------------------------------------------------------------------------- light ray
// Beacons and the Nexus fire a column of light straight up out of their core, so they can be found
// from anywhere on the planet. A plain translucent cylinder reads as a glass tube, so the shader
// fades the column out as it climbs and lets the wall facing the camera carry most of the
// brightness — through the middle of the tube both walls add up, which is what a light shaft does.

const BEAM_VERT = /* glsl */ `
  varying vec2 vUvBeam;
  varying vec3 vNB;
  varying vec3 vWB;
  void main() {
    vUvBeam = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWB = wp.xyz;
    vNB = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFogDensity;
  /** 1 = the bright needle at the heart of the ray, 0 = the soft halo wrapped around it. */
  uniform float uCore;
  varying vec2 vUvBeam;
  varying vec3 vNB;
  varying vec3 vWB;

  void main() {
    vec3 viewDir = normalize(uCamPos - vWB);
    float facing = abs(dot(normalize(vNB), viewDir));

    // full strength at the emitter, and gone FAST: a slow linear taper spread the light thin over the
    // whole 150 m and left a faint streak at the top that cost brightness without being seen. A steep
    // falloff keeps the light where the tower is, which is what makes it read as a beacon.
    float rise = pow(clamp(1.0 - vUvBeam.y, 0.0, 1.0), 3.0);
    // slow breathing plus a fine shimmer, so the ray never reads as a glass tube
    float flick = 0.88 + 0.12 * sin(uTime * (1.1 + uCore * 0.6) + vUvBeam.y * 7.0);

    float d = length(uCamPos - vWB);
    float fog = clamp(1.0 - exp(-pow(d * uFogDensity, 2.0)), 0.0, 1.0);

    // ACROSS the tube: brightest down the middle of the cylinder, feathered away to nothing at the
    // silhouette. A light shaft has no edge to catch — that soft shoulder is most of what sells a
    // painted cylinder as something glowing, so the falloff is steeper than it used to be.
    float across = pow(facing, 1.7);
    float profile = mix(0.1, 1.3, across);

    float alpha = uOpacity * rise * flick * profile * (1.0 - fog * 0.9);
    if (alpha < 0.004) discard;

    // LIGHTER, not white: the ray is the banner's own colour lifted a little way toward white, so a
    // red tower throws a pale ROSE shaft and a cyan one a pale SKY shaft. Mixing it all the way to
    // white makes every tower look the same and loses the colour that says whose it is.
    vec3 tint = mix(uColor, vec3(1.0), 0.2 + uCore * 0.12);
    // and a hot spot right at the emitter, where the light leaves the crystal
    float hot = exp(-vUvBeam.y * 7.0);
    // Kept BELOW the point where the additive result clips: once every channel saturates, the shaft
    // is white no matter what it is tinted, which is exactly what the eye reads as "no colour".
    vec3 col = tint * (1.1 + across * 0.95 + hot * 1.0) * (0.85 + uCore * 0.35);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
  }
`;

export function createBeamMaterial(color: number, opacity: number, core = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: nfUniforms({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uCore: { value: core },
    }),
  });
}
