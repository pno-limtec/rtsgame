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
  attribute float aAlpha;      // lokale Deckkraft: dünn + steil = transparenter
  attribute vec3 color;        // tiefenabhängige Grundfarbe (vom Renderer)
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSea;
  varying float vFlow;
  varying float vDepth;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vCrest;        // normierte Wellenhöhe (für Schaumkronen)
  varying vec2 vUv;

  // Summe gerichteter Gerstner-Wellen → Höhe + horizontaler Gradient (für die Normale).
  // Meer und Binnengewässer laufen durch denselben Shader-Pfad, bekommen aber eigene Wellenprofile.
  float waveSum(vec2 p, float t, float sea, out vec2 grad) {
    vec2 gradSea = vec2(0.0);
    float hSea = 0.0;
    vec2 d1 = normalize(vec2(0.86, 0.36)); float k1 = 0.075, s1 = 1.25, a1 = 0.72;
    float p1 = dot(p, d1) * k1 + t * s1; hSea += sin(p1) * a1; gradSea += d1 * cos(p1) * a1 * k1;
    vec2 d2 = normalize(vec2(-0.30, 0.92)); float k2 = 0.125, s2 = 0.95, a2 = 0.38;
    float p2 = dot(p, d2) * k2 + t * s2; hSea += sin(p2) * a2; gradSea += d2 * cos(p2) * a2 * k2;
    vec2 d3 = normalize(vec2(0.55, -0.55)); float k3 = 0.235, s3 = 1.7, a3 = 0.22;
    float p3 = dot(p, d3) * k3 + t * s3; hSea += sin(p3) * a3; gradSea += d3 * cos(p3) * a3 * k3;

    vec2 gradInland = vec2(0.0);
    float hInland = 0.0;
    vec2 i1 = normalize(vec2(0.72, 0.69)); float ik1 = 0.135, is1 = 0.58, ia1 = 0.30;
    float ip1 = dot(p, i1) * ik1 + t * is1; hInland += sin(ip1) * ia1; gradInland += i1 * cos(ip1) * ia1 * ik1;
    vec2 i2 = normalize(vec2(-0.38, 0.93)); float ik2 = 0.180, is2 = 0.82, ia2 = 0.12;
    float ip2 = dot(p, i2) * ik2 + t * is2; hInland += sin(ip2) * ia2; gradInland += i2 * cos(ip2) * ia2 * ik2;
    vec2 i3 = normalize(vec2(0.95, -0.30)); float ik3 = 0.320, is3 = 1.10, ia3 = 0.03;
    float ip3 = dot(p, i3) * ik3 + t * is3; hInland += sin(ip3) * ia3; gradInland += i3 * cos(ip3) * ia3 * ik3;

    float seaMix = smoothstep(0.0, 0.65, sea);
    grad = mix(gradInland, gradSea, seaMix);
    return mix(hInland, hSea, seaMix); // Bereich ~[-1, 1]
  }

  void main() {
    vColor = color;
    vSea = aSea;
    vFlow = aFlow;
    vDepth = aDepth;
    vAlpha = aAlpha;
    vUv = uv;
    vec4 wpos = modelMatrix * vec4(position, 1.0);
    float seaMix = smoothstep(0.0, 0.65, clamp(aSea, 0.0, 1.0));
    float flowWave = smoothstep(0.04, 0.55, clamp(aFlow, 0.0, 1.0)) * (1.0 - seaMix);
    float filmWave = (1.0 - smoothstep(0.018, 0.11, aDepth)) * smoothstep(0.004, 0.05, aDepth) * (1.0 - seaMix);
    float seaFlowWave = smoothstep(0.18, 0.85, clamp(aFlow, 0.0, 1.0)) * seaMix * 0.10;
    float amp = uWaveAmp * mix(0.115 + flowWave * 0.22 + filmWave * 0.11, 1.0 + seaFlowWave, seaMix); // dünner Abfluss kräuselt sichtbar
    vec2 grad;
    float hh = waveSum(wpos.xz, uTime, aSea, grad);
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
  varying float vAlpha;
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
    float flowRipple = smoothstep(0.04, 0.60, clamp(vFlow, 0.0, 1.0)) * (1.0 - smoothstep(0.15, 0.70, sea));
    vec3 nd = detailNormal(vWorld.xz, uTime, 0.026 + sea * 0.230 + flowRipple * 0.125);
    vec3 N = normalize(vNormalW * (0.78 - sea * 0.20) + nd * (0.22 + sea * 0.40 + flowRipple * 0.34));
    vec2 micro = vec2(
      noise2(vWorld.xz * 0.74 + vec2(uTime * 0.17, -2.0)),
      noise2(vWorld.xz * 0.68 + vec2(5.0, -uTime * 0.15))
    ) - 0.5;
    N = normalize(N + vec3(micro.x, 0.0, micro.y) * (0.010 + sea * 0.060 + flowRipple * 0.035));
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    // Grundfarbe: klar bläulich, ohne flaches Wasser milchig-grau auszuwaschen.
    float shallowTint = (1.0 - depthF) * (0.45 + 0.35 * smoothstep(0.30, 0.68, luma(vColor)));
    vec3 waterBlue = mix(vec3(0.055, 0.28, 0.54), vec3(0.18, 0.70, 1.0), 1.0 - depthF);
    vec3 col = mix(vColor, waterBlue, 0.36 + shallowTint * 0.34);
    vec3 nightBlue = mix(vec3(0.030, 0.145, 0.300), vec3(0.090, 0.330, 0.560), 1.0 - depthF);
    col = mix(col, max(col, nightBlue), (1.0 - uDaylight) * 0.55);

    // Sichtbare Kräuselung: dezente diffuse Helligkeitsmodulation nach Sonnenstand — geneigte
    // Wellenflanken fangen Licht, sodass die Oberfläche strukturiert wirkt, ohne auszubleichen.
    float diff = dot(N, normalize(uSunDir + vec3(0.0, 0.6, 0.0))) * 0.5 + 0.5;
    float waveShade = (diff - 0.5) * (0.36 + sea * 0.14 + flowRipple * 0.22);
    col *= 1.0 + waveShade * (0.58 + 0.42 * uDaylight);

    // Fresnel-Himmelsspiegelung mit Horizont-Verlauf (am Streifwinkel heller/horizontnah).
    vec3 skyRefl = mix(uSky, uSkyHorizon, clamp(fres, 0.0, 1.0));
    float skyAmt = (0.12 + sea * 0.28) * (0.55 + 0.45 * uDaylight);
    col = mix(col, skyRefl, clamp(fres, 0.0, 1.0) * skyAmt);

    // Sonnen-Specular: scharfer Kern (Glitzern) + breiter Schein.
    vec3 Hh = normalize(uSunDir + V);
    float ndh = max(dot(N, Hh), 0.0);
    float spec = pow(ndh, 220.0) * 4.2 + pow(ndh, 28.0) * 0.52;
    float glitterMask = smoothstep(0.38, 0.92, fbm(vWorld.xz * (0.24 + sea * 0.26) + vec2(uTime * 0.08, -uTime * 0.06)));
    spec *= mix(0.38, 1.85, glitterMask);
    spec *= mix(0.30, 1.22, sea) + flowRipple * 0.55;
    col += uSunColor * spec * uDaylight;
    float lowLightSpec = (pow(ndh, 52.0) * 0.26 + pow(ndh, 16.0) * 0.05)
      * (1.0 - uDaylight) * (0.20 + sea * 0.50 + flowRipple * 0.55);
    col += vec3(0.22, 0.55, 0.95) * lowLightSpec;

    // STRÖMUNG (Flow-Sim-Visualisierung): die UVs sind strömungsausgerichtet (uv.y = Fließrichtung).
    // Wo das Sim-Flussfeld stark ist (vFlow), wandern helle Schaum-/Strömungslinien sichtbar mit der
    // Strömung talwärts — Tempo und Stärke skalieren mit der Strömungsstärke. So sieht man, WO und
    // WIE SCHNELL Wasser fließt (abläuft/zuläuft).
    float flowStr = clamp(vFlow, 0.0, 1.0);
    // Offene See bekommt nur bei starkem Sturm-Flow weichere Strömungsbänder.
    // Flüsse, Kanäle und Abflusskanten behalten die deutlichere gerichtete Zeichnung.
    float inlandFlowMask = 1.0 - smoothstep(0.20, 0.70, sea);
    float seaCurrentMask = smoothstep(0.35, 0.95, sea) * smoothstep(0.12, 0.70, flowStr) * 0.42;
    float visibleFlow = smoothstep(0.08, 0.55, flowStr) * max(inlandFlowMask, seaCurrentMask);
    float flowNoise = fbm(vec2(vUv.x * 2.2, vUv.y * 0.85) + vWorld.xz * 0.018 + vec2(0.0, uTime * 0.18));
    float scroll = vUv.y * 22.0 - uTime * (1.6 + visibleFlow * 3.5) + (flowNoise - 0.5) * 5.5;
    float streak = sin(scroll) * 0.5 + 0.5;
    streak = smoothstep(0.62, 1.0, streak) * pow(visibleFlow, 0.6) * smoothstep(0.18, 0.95, flowNoise);
    // feinere zweite Lage gegen Regelmäßigkeit
    float streak2 = smoothstep(0.7, 1.0, sin(vUv.y * 41.0 - uTime * (2.4 + visibleFlow * 4.0) + vUv.x * 6.0 + flowNoise * 4.0) * 0.5 + 0.5);
    float rippleBands = smoothstep(0.58, 1.0, sin(vUv.y * 30.0 - uTime * (2.2 + visibleFlow * 3.8) + flowNoise * 4.0) * 0.5 + 0.5) * visibleFlow;
    float crossRipple = smoothstep(0.68, 1.0, sin(vUv.x * 24.0 + vUv.y * 5.0 + uTime * (1.1 + visibleFlow * 2.0)) * 0.5 + 0.5) * visibleFlow * 0.45;
    float current = clamp(streak * 0.55 + streak2 * 0.25 + rippleBands * 0.16 + crossRipple * 0.04, 0.0, 1.0) * visibleFlow;
    float trough = smoothstep(0.20, 0.85, flowStr) * (1.0 - current) * visibleFlow;
    col *= 1.0 - trough * 0.08;
    col = mix(col, vec3(0.62, 0.88, 1.0), current * 0.42);

    // Uferschaum: NUR an der echten Wasserlinie (dünnstes/hellstes Wasser) + Meereskämme. Sonst
    // würde flaches Wasser (Flüsse) flächig weiß ausbleichen.
    float shoreEdge = (1.0 - smoothstep(0.035, 0.16, vDepth)) * smoothstep(0.52, 0.68, luma(vColor));
    float crestFoam = smoothstep(0.38, 0.95, vCrest);
    float foam = max(shoreEdge * (0.18 + 0.34 * crestFoam),
                     smoothstep(0.72, 1.0, vCrest) * smoothstep(0.55, 0.92, sea) * 0.44);
    col = mix(col, vec3(0.92, 0.97, 1.0), clamp(foam, 0.0, 0.66));

    float baseAlpha = mix(0.28, uOpacity, depthF);
    float a = clamp((baseAlpha + fres * 0.08 + foam * 0.14 + current * 0.12) * clamp(vAlpha, 0.0, 1.0), 0.0, 0.84);
    gl_FragColor = vec4(col, a);
  }
`;

export function createWaterV2() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaveAmp: { value: 0.42 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2dd) },
      uSky: { value: new THREE.Color(0x9ec8e8) },
      uSkyHorizon: { value: new THREE.Color(0xcfe3f2) },
      uOpacity: { value: 0.54 },
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
