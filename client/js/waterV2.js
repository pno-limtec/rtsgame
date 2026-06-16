// Wasser V2 — eigenständiges Wasser-Rendering ohne Altlasten.
// Ozean-artiger Shader im Stil der three.js-Beispiele (Water / webgl_shaders_ocean):
//  - Gerstner-Grundwellen (Vertex-Displacement) + analytische Normale; Meer kräftig, Binnen ruhig.
//  - feine prozedurale Detailnormalen (mehrere Oktaven) → realistisches Glitzern/Funkeln im Sonnenlicht.
//  - Sonnen-Specular (scharf + breit) und Fresnel-Himmelsspiegelung mit Horizont-Verlauf.
//  - tiefenabhängige Farbe (aus der Geometrie) + aufgehelltes Flachwasser.
//  - Uferschaum (aus der Wassertiefe abgeleitet) und strömungsgerichtete Kräuselung (entlang der UVs).
// Die Geometrie (geglättete Wasserfläche, Tiefenfarbe in `color`, Meeresanteil in `aSea`,
// strömungsausgerichtete `uv`) kommt vom Renderer; dieses Modul liefert nur das Material + Uniform-Helfer.
import * as THREE from 'three';

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uWaveAmp;      // Wellen-Amplitude (Welt-Einheiten) für offenes Meer
  attribute float aSea;        // 0..1 Meeresanteil (steuert Wellenstärke)
  attribute vec3 color;        // tiefenabhängige Grundfarbe (vom Renderer)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying vec3 vColor;
  varying float vCrest;        // normierte Wellenhöhe (für Schaumkronen)
  varying vec2 vUv;

  // Summe gerichteter Gerstner-Wellen → Höhe + horizontaler Gradient (für die Normale).
  float waveSum(vec2 p, float t, out vec2 grad) {
    grad = vec2(0.0);
    float h = 0.0;
    vec2 d1 = normalize(vec2(0.86, 0.36)); float k1 = 0.075, s1 = 1.25, a1 = 0.58;
    float p1 = dot(p, d1) * k1 + t * s1; h += sin(p1) * a1; grad += d1 * cos(p1) * a1 * k1;
    vec2 d2 = normalize(vec2(-0.30, 0.92)); float k2 = 0.125, s2 = 0.95, a2 = 0.30;
    float p2 = dot(p, d2) * k2 + t * s2; h += sin(p2) * a2; grad += d2 * cos(p2) * a2 * k2;
    vec2 d3 = normalize(vec2(0.55, -0.55)); float k3 = 0.235, s3 = 1.7, a3 = 0.16;
    float p3 = dot(p, d3) * k3 + t * s3; h += sin(p3) * a3; grad += d3 * cos(p3) * a3 * k3;
    return h; // Bereich ~[-1, 1]
  }

  void main() {
    vColor = color;
    vSea = aSea;
    vUv = uv;
    vec4 wpos = modelMatrix * vec4(position, 1.0);
    float amp = uWaveAmp * mix(0.12, 1.0, clamp(aSea, 0.0, 1.0)); // Binnenwasser ruhiger
    vec2 grad;
    float hh = waveSum(wpos.xz, uTime, grad);
    vCrest = hh;
    wpos.y += hh * amp;
    vNormalW = normalize(vec3(-grad.x * amp, 1.0, -grad.y * amp));
    vWorld = wpos.xyz;
    gl_Position = projectionMatrix * viewMatrix * wpos;
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uSunDir;     // normiert, Richtung zur Sonne
  uniform vec3 uSunColor;
  uniform vec3 uSky;        // Himmelsfarbe (Fresnel-Spiegelung, zenitnah)
  uniform vec3 uSkyHorizon; // hellere Horizontfarbe für den Spiegelungs-Verlauf
  uniform float uOpacity;   // Grund-Deckkraft
  uniform float uDaylight;  // 0 Nacht .. 1 Tag
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying vec3 vColor;
  varying float vCrest;
  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // Feine Detail-Normale aus mehreren hochfrequenten Wellen (analytische Ableitung) → sichtbare
  // Kräuselung + Glitzern. Zwei Geschwindigkeiten, damit das Muster nicht starr wirkt.
  vec3 detailNormal(vec2 p, float t, float strength) {
    vec2 g = vec2(0.0);
    vec2 e1 = normalize(vec2(0.9, 0.2));  float k1 = 1.1, s1 = 2.4, a1 = 1.0;
    g += e1 * cos(dot(p, e1) * k1 + t * s1) * a1 * k1;
    vec2 e2 = normalize(vec2(-0.2, 1.0)); float k2 = 1.8, s2 = 3.1, a2 = 0.7;
    g += e2 * cos(dot(p, e2) * k2 + t * s2) * a2 * k2;
    vec2 e3 = normalize(vec2(0.6, -0.7)); float k3 = 3.1, s3 = 4.2, a3 = 0.45;
    g += e3 * cos(dot(p, e3) * k3 + t * s3) * a3 * k3;
    vec2 e4 = normalize(vec2(-0.8, -0.5)); float k4 = 5.0, s4 = 5.6, a4 = 0.25;
    g += e4 * cos(dot(p, e4) * k4 - t * s4) * a4 * k4;
    return normalize(vec3(-g.x * strength, 1.0, -g.y * strength));
  }

  void main() {
    float sea = clamp(vSea, 0.0, 1.0);
    // Basis-Normale (Grundwellen) mit kräftiger Detail-Normale mischen — Detail beim Meer stärker.
    vec3 nd = detailNormal(vWorld.xz, uTime, 0.16 + sea * 0.22);
    vec3 N = normalize(vNormalW * 0.5 + nd * 0.5);
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    // Grundfarbe; ganz flaches Wasser nur SEHR dezent aufhellen (Untergrund schimmert durch).
    float shallowTint = smoothstep(0.40, 0.60, luma(vColor));
    vec3 col = vColor + shallowTint * vec3(0.01, 0.025, 0.03);

    // Sichtbare Kräuselung: dezente diffuse Helligkeitsmodulation nach Sonnenstand — geneigte
    // Wellenflanken fangen Licht, sodass die Oberfläche strukturiert wirkt, ohne auszubleichen.
    float diff = dot(N, normalize(uSunDir + vec3(0.0, 0.6, 0.0))) * 0.5 + 0.5;
    col *= 0.90 + diff * 0.22 * (0.5 + 0.5 * uDaylight);

    // Fresnel-Himmelsspiegelung mit Horizont-Verlauf (am Streifwinkel heller/horizontnah).
    vec3 skyRefl = mix(uSky, uSkyHorizon, clamp(fres, 0.0, 1.0));
    col = mix(col, skyRefl, clamp(fres, 0.0, 1.0) * (0.40 + sea * 0.18));

    // Sonnen-Specular: scharfer Kern (Glitzern) + breiter Schein.
    vec3 Hh = normalize(uSunDir + V);
    float ndh = max(dot(N, Hh), 0.0);
    float spec = pow(ndh, 240.0) * 3.4 + pow(ndh, 30.0) * 0.40;
    col += uSunColor * spec * uDaylight;

    // Strömungs-Kräuselung: dezente helle Linien wandern entlang der (strömungsausgerichteten) UV.
    float flow = sin(vUv.y * 26.0 - uTime * 2.2) * 0.5 + 0.5;
    col += smoothstep(0.86, 1.0, flow) * (1.0 - sea) * 0.05 * uDaylight;

    // Uferschaum: NUR an der echten Wasserlinie (dünnstes/hellstes Wasser) + Meereskämme. Sonst
    // würde flaches Wasser (Flüsse) flächig weiß ausbleichen.
    float shoreEdge = smoothstep(0.52, 0.66, luma(vColor));
    float crestFoam = smoothstep(0.5, 1.0, vCrest);
    float foam = max(shoreEdge * (0.4 + 0.6 * crestFoam) * 0.8,
                     smoothstep(0.80, 1.0, vCrest) * smoothstep(0.55, 0.92, sea) * 0.45);
    col = mix(col, vec3(0.92, 0.97, 1.0), clamp(foam, 0.0, 0.8));

    float a = clamp(uOpacity + fres * 0.18 + foam * 0.3, 0.0, 0.99);
    gl_FragColor = vec4(col, a);
  }
`;

export function createWaterV2() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaveAmp: { value: 0.30 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2dd) },
      uSky: { value: new THREE.Color(0x9ec8e8) },
      uSkyHorizon: { value: new THREE.Color(0xcfe3f2) },
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

const _hz = new THREE.Color();

// Per-Frame-Uniforms nachführen. sunDir = Welt-Richtung zur Sonne; sky/sun aus updateEnvironment.
export function updateWaterV2(material, { dt = 0, sunDir, sunColor, sky, opacity, daylight }) {
  if (!material) return;
  const u = material.uniforms;
  u.uTime.value += dt;
  if (sunDir) u.uSunDir.value.copy(sunDir).normalize();
  if (sunColor) u.uSunColor.value.copy(sunColor);
  if (sky) {
    u.uSky.value.copy(sky);
    // Horizontfarbe = Himmel etwas aufgehellt/entsättigt (heller Saum am Streifwinkel).
    _hz.copy(sky).lerp(new THREE.Color(0xffffff), 0.35);
    u.uSkyHorizon.value.copy(_hz);
  }
  if (opacity != null) u.uOpacity.value = opacity;
  if (daylight != null) u.uDaylight.value = daylight;
}
