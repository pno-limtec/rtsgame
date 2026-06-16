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
  attribute float aFlow;       // 0..1 Strömungsstärke (für gerichtete Strömungslinien)
  attribute float aDepth;      // echte Wassertiefe (Sim-Einheiten)
  attribute vec3 color;        // tiefenabhängige Grundfarbe (vom Renderer)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying float vFlow;
  varying float vDepth;
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
    vFlow = aFlow;
    vDepth = aDepth;
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
  varying float vFlow;
  varying float vDepth;
  varying vec3 vColor;
  varying float vCrest;
  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.62, 1.18, -1.18, 1.62);
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = m * p + vec2(11.7, -7.3);
      a *= 0.5;
    }
    return v;
  }

  // Feine Detail-Normale aus mehreren hochfrequenten Wellen (analytische Ableitung) → sichtbare
  // Kräuselung + Glitzern. Domain-Warping (eine langsame Welle versetzt die Abtastposition) bricht
  // die Regelmäßigkeit auf, sodass kein gitterartiges Muster entsteht. Frequenzen nicht-harmonisch.
  vec3 detailNormal(vec2 p, float t, float strength) {
    // langsamer Versatz → organischeres, weniger regelmäßiges Muster. Der Noise-Warp bricht
    // besonders die langen, gleichmäßigen Glitzerketten auf offener See.
    vec2 warp = vec2(
      noise2(p * 0.19 + vec2(t * 0.07, 4.1)),
      noise2(p * 0.23 + vec2(-3.4, -t * 0.06))
    ) - 0.5;
    p += 0.7 * vec2(sin(p.y * 0.21 + t * 0.5), cos(p.x * 0.19 - t * 0.4)) + warp * 3.1;
    vec2 g = vec2(0.0);
    vec2 e1 = normalize(vec2(0.92, 0.18));  float k1 = 1.07, s1 = 2.3, a1 = 1.0;
    g += e1 * cos(dot(p, e1) * k1 + t * s1) * a1 * k1;
    vec2 e2 = normalize(vec2(-0.27, 0.96)); float k2 = 1.73, s2 = 3.05, a2 = 0.7;
    g += e2 * cos(dot(p, e2) * k2 + t * s2) * a2 * k2;
    vec2 e3 = normalize(vec2(0.61, -0.79)); float k3 = 2.91, s3 = 4.1, a3 = 0.45;
    g += e3 * cos(dot(p, e3) * k3 + t * s3) * a3 * k3;
    vec2 e4 = normalize(vec2(-0.83, -0.52)); float k4 = 4.67, s4 = 5.5, a4 = 0.25;
    g += e4 * cos(dot(p, e4) * k4 - t * s4) * a4 * k4;
    return normalize(vec3(-g.x * strength, 1.0, -g.y * strength));
  }

  void main() {
    float sea = clamp(vSea, 0.0, 1.0);
    float depthF = smoothstep(0.025, 0.42, vDepth);
    // Basis-Normale (Grundwellen) mit kräftiger Detail-Normale mischen — Detail beim Meer stärker.
    vec3 nd = detailNormal(vWorld.xz, uTime, 0.09 + sea * 0.13);
    vec3 N = normalize(vNormalW * 0.68 + nd * 0.32);
    vec2 micro = vec2(
      noise2(vWorld.xz * 0.74 + vec2(uTime * 0.17, -2.0)),
      noise2(vWorld.xz * 0.68 + vec2(5.0, -uTime * 0.15))
    ) - 0.5;
    N = normalize(N + vec3(micro.x, 0.0, micro.y) * (0.015 + sea * 0.035));
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    // Grundfarbe; ganz flaches Wasser nur SEHR dezent aufhellen (Untergrund schimmert durch).
    float shallowTint = (1.0 - depthF) * smoothstep(0.42, 0.62, luma(vColor));
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
    float glitterMask = smoothstep(0.38, 0.92, fbm(vWorld.xz * (0.24 + sea * 0.26) + vec2(uTime * 0.08, -uTime * 0.06)));
    spec *= mix(0.38, 1.55, glitterMask);
    col += uSunColor * spec * uDaylight;

    // STRÖMUNG (Flow-Sim-Visualisierung): die UVs sind strömungsausgerichtet (uv.y = Fließrichtung).
    // Wo das Sim-Flussfeld stark ist (vFlow), wandern helle Schaum-/Strömungslinien sichtbar mit der
    // Strömung talwärts — Tempo und Stärke skalieren mit der Strömungsstärke. So sieht man, WO und
    // WIE SCHNELL Wasser fließt (abläuft/zuläuft).
    float flowStr = clamp(vFlow, 0.0, 1.0);
    // Offene See bekommt keine harten Flow-Streifen; dort lebt die Oberfläche durch Wellen/Glitzern.
    // Flüsse, Kanäle und Abflusskanten behalten die gerichtete Strömungszeichnung.
    float visibleFlow = smoothstep(0.10, 0.55, flowStr) * (1.0 - smoothstep(0.35, 0.90, sea));
    float flowNoise = fbm(vec2(vUv.x * 2.2, vUv.y * 0.85) + vWorld.xz * 0.018 + vec2(0.0, uTime * 0.18));
    float scroll = vUv.y * 22.0 - uTime * (1.6 + visibleFlow * 3.5) + (flowNoise - 0.5) * 5.5;
    float streak = sin(scroll) * 0.5 + 0.5;
    streak = smoothstep(0.62, 1.0, streak) * pow(visibleFlow, 0.6) * smoothstep(0.18, 0.95, flowNoise);
    // feinere zweite Lage gegen Regelmäßigkeit
    float streak2 = smoothstep(0.7, 1.0, sin(vUv.y * 41.0 - uTime * (2.4 + visibleFlow * 4.0) + vUv.x * 6.0 + flowNoise * 4.0) * 0.5 + 0.5);
    float current = clamp(streak * 0.7 + streak2 * 0.3, 0.0, 1.0) * visibleFlow;
    col = mix(col, vec3(0.86, 0.93, 0.98), current * 0.32);

    // Uferschaum: NUR an der echten Wasserlinie (dünnstes/hellstes Wasser) + Meereskämme. Sonst
    // würde flaches Wasser (Flüsse) flächig weiß ausbleichen.
    float shoreEdge = (1.0 - smoothstep(0.035, 0.16, vDepth)) * smoothstep(0.52, 0.68, luma(vColor));
    float crestFoam = smoothstep(0.5, 1.0, vCrest);
    float foam = max(shoreEdge * (0.18 + 0.34 * crestFoam),
                     smoothstep(0.80, 1.0, vCrest) * smoothstep(0.55, 0.92, sea) * 0.28);
    col = mix(col, vec3(0.92, 0.97, 1.0), clamp(foam, 0.0, 0.55));

    float baseAlpha = mix(0.56, uOpacity, depthF);
    float a = clamp(baseAlpha + fres * 0.16 + foam * 0.22 + current * 0.12, 0.0, 0.99);
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
