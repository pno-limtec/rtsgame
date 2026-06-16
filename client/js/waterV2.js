// Wasser V2 — eigenständiges Wasser-Rendering ohne Altlasten.
// Eine Ozean-artige ShaderMaterial im Stil der three.js-Beispiele (Water / webgl_shaders_ocean):
// Gerstner-Wellen (Vertex-Displacement + analytische Normale), Sonnen-Specular, Fresnel-
// Himmelsspiegelung, tiefenabhängige Farbe/Deckkraft und Schaumkronen. Wellen sind beim Meer
// kräftig, bei Binnengewässern (aSea→0) deutlich ruhiger. Die Geometrie (geglättete Wasserfläche
// inkl. Tiefenfarbe in `color` und Meeresanteil in `aSea`) kommt vom Renderer; dieses Modul liefert
// nur das neue Material und einen Per-Frame-Uniform-Update-Helfer.
import * as THREE from 'three';

const VERT = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform float uWaveAmp;      // Wellen-Amplitude (Welt-Einheiten) für offenes Meer
  attribute float aSea;        // 0..1 Meeresanteil (steuert Wellenstärke)
  attribute vec3 color;        // tiefenabhängige Grundfarbe (vom Renderer)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying vec3 vColor;
  varying float vCrest;        // normierte Wellenhöhe (für Schaumkronen)

  // Summe gerichteter Wellen → Höhe + horizontaler Gradient (für die Normale).
  float waveSum(vec2 p, float t, out vec2 grad) {
    grad = vec2(0.0);
    float h = 0.0;
    vec2 d1 = normalize(vec2(0.86, 0.36)); float k1 = 0.085, s1 = 1.35, a1 = 0.55;
    float p1 = dot(p, d1) * k1 + t * s1; h += sin(p1) * a1; grad += d1 * cos(p1) * a1 * k1;
    vec2 d2 = normalize(vec2(-0.30, 0.92)); float k2 = 0.135, s2 = 1.02, a2 = 0.30;
    float p2 = dot(p, d2) * k2 + t * s2; h += sin(p2) * a2; grad += d2 * cos(p2) * a2 * k2;
    vec2 d3 = normalize(vec2(0.55, -0.55)); float k3 = 0.27, s3 = 1.85, a3 = 0.15;
    float p3 = dot(p, d3) * k3 + t * s3; h += sin(p3) * a3; grad += d3 * cos(p3) * a3 * k3;
    return h; // Bereich ~[-1, 1]
  }

  void main() {
    vColor = color;
    vSea = aSea;
    vec4 wpos = modelMatrix * vec4(position, 1.0);
    float amp = uWaveAmp * mix(0.14, 1.0, clamp(aSea, 0.0, 1.0)); // Binnenwasser ruhiger
    vec2 grad;
    float h = waveSum(wpos.xz, uTime, grad);
    vCrest = h;
    wpos.y += h * amp;
    // Analytische Normale aus dem Höhengradienten.
    vNormalW = normalize(vec3(-grad.x * amp, 1.0, -grad.y * amp));
    vWorld = wpos.xyz;
    gl_Position = projectionMatrix * viewMatrix * wpos;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uSunDir;     // normiert, Richtung zur Sonne
  uniform vec3 uSunColor;
  uniform vec3 uSky;        // Himmelsfarbe (Fresnel-Spiegelung)
  uniform float uOpacity;   // Grund-Deckkraft
  uniform float uDaylight;  // 0 Nacht .. 1 Tag (dämpft Sonnenglanz nachts)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying vec3 vColor;
  varying float vCrest;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    vec3 col = vColor;
    // Himmelsspiegelung am Streifwinkel (Fresnel) — dezent, damit tiefes Wasser dunkel bleibt.
    col = mix(col, uSky, clamp(fres, 0.0, 1.0) * 0.5);
    // Sonnen-Specular (Blinn-Phong) → helle Glanzlichter auf den Wellenkämmen.
    vec3 Hh = normalize(uSunDir + V);
    float spec = pow(max(dot(N, Hh), 0.0), 110.0);
    col += uSunColor * spec * 2.0 * uDaylight;
    // weicher Himmelsschimmer an geneigten Flächen
    col += uSky * (1.0 - clamp(N.y, 0.0, 1.0)) * 0.05;
    // Schaumkronen: nur auf dem Meer (vSea hoch) an den obersten Wellenkämmen.
    float foam = smoothstep(0.72, 1.0, vCrest) * smoothstep(0.45, 0.9, vSea);
    col = mix(col, vec3(0.92, 0.97, 1.0), foam * 0.6);

    float a = clamp(uOpacity + fres * 0.22 + foam * 0.3, 0.0, 0.99);
    gl_FragColor = vec4(col, a);
  }
`;

export function createWaterV2() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaveAmp: { value: 0.26 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2dd) },
      uSky: { value: new THREE.Color(0x9ec8e8) },
      uOpacity: { value: 0.82 },
      uDaylight: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return material;
}

// Per-Frame-Uniforms nachführen. sunDir = Welt-Richtung zur Sonne; sky/sun aus updateEnvironment.
export function updateWaterV2(material, { dt = 0, sunDir, sunColor, sky, opacity, daylight }) {
  if (!material) return;
  const u = material.uniforms;
  u.uTime.value += dt;
  if (sunDir) u.uSunDir.value.copy(sunDir).normalize();
  if (sunColor) u.uSunColor.value.copy(sunColor);
  if (sky) u.uSky.value.copy(sky);
  if (opacity != null) u.uOpacity.value = opacity;
  if (daylight != null) u.uDaylight.value = daylight;
}
