// Geländegenerierung & Abfragen: Höhenkarte, Tile-Typen, dynamisches Wasser.
import { TILE, SEA_LEVEL, WET_DEPTH, NAVIGABLE_DEPTH, WATER_MAX_DEPTH, SNOW_LINE, SNOW_FALL_LINE, SNOW_INIT, EDGE_SEA } from './constants.js';
import { makeRng } from './rng.js';

export const TT = { LAND: 0, HILL: 1, CLIFF: 2, WATER: 3, BRIDGE: 4 };
const MAX_HEIGHT = 1.92;
const CENTER_MOUNTAIN_CORE_FRAC = 0.085;

// Einfaches, seedbares Value-Noise (mehrere Oktaven), deterministisch.
function noise2(rng, w, h, octaves = 4) {
  const out = new Float32Array(w * h);
  let amp = 1, freqDiv = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const gw = Math.max(2, Math.ceil(w / (16 / freqDiv)));
    const gh = Math.max(2, Math.ceil(h / (16 / freqDiv)));
    const grid = new Float32Array((gw + 1) * (gh + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * gw, fy = (y / h) * gh;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const g = (gx, gy) => grid[gy * (gw + 1) + gx];
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
        const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
        out[y * w + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp; amp *= 0.5; freqDiv *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function radialNorm(x, y, cx, cy, maxR) {
  return Math.min(1, Math.hypot(x - cx, y - cy) / maxR);
}

function centerMountainCoreRadius(w, h) {
  return Math.max(7, Math.min(w, h) * CENTER_MOUNTAIN_CORE_FRAC);
}

function inCenterMountainCore(w, h, x, y, radius = centerMountainCoreRadius(w, h)) {
  return Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) <= radius;
}

function protectCenterMountain(height, w, h, radius = centerMountainCoreRadius(w, h)) {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d > radius) continue;
    const rn = d / Math.max(1, radius);
    const floor = 0.92 + Math.pow(1 - rn, 1.85) * 0.86;
    const target = Math.min(MAX_HEIGHT - 0.015, floor);
    // Schutz im äußeren Viertel weich auslaufen lassen, damit am Kernrand KEINE scharfe Kante/Klippe
    // zur (abgerundeten) Umgebung entsteht — der Gipfelkern geht stattdessen sanft ins Gelände über.
    const fade = rn > 0.75 ? Math.max(0, (1 - rn) / 0.25) : 1;
    const i = y * w + x;
    if (target > height[i]) height[i] += (target - height[i]) * fade;
  }
}

function slopeAtHeight(height, w, h, i) {
  const x = i % w;
  let s = 0;
  if (x > 0) s = Math.max(s, Math.abs(height[i] - height[i - 1]));
  if (x < w - 1) s = Math.max(s, Math.abs(height[i] - height[i + 1]));
  if (i >= w) s = Math.max(s, Math.abs(height[i] - height[i - w]));
  if (i < w * (h - 1)) s = Math.max(s, Math.abs(height[i] - height[i + w]));
  return s;
}

function hashVolume(x, y, z, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453123;
  return (n - Math.floor(n)) * 2 - 1;
}

function terrainDensity(x, z, y, targetHeight, seed) {
  const shell = targetHeight - y;
  const nearSurface = Math.max(0, 1 - Math.abs(shell) / 0.22);
  const strata = Math.sin(y * 24 + x * 0.08 + z * 0.06 + seed) * 0.007;
  const cellular = hashVolume(x * 0.09, y * 0.38, z * 0.09, seed) * 0.013;
  return shell + (strata + cellular) * nearSurface;
}

// Nature/Volumetric-terrain-Prinzip: Die 2D-Noise-Formel liefert nur die Zieloberfläche.
// Die finale Höhe wird als 0-Isolinie eines signierten Volumenfeldes extrahiert. So bleiben
// Server-Heightmap, Wasser und Pathfinding kompatibel, aber die Topografie entsteht nicht mehr
// als direktes Zellraster.
function extractVolumetricSurface(x, z, targetHeight, seed) {
  const target = Math.max(0.02, Math.min(MAX_HEIGHT - 0.002, targetHeight));
  let lo = 0.02, hi = MAX_HEIGHT;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) * 0.5;
    if (terrainDensity(x, z, mid, target, seed) > 0) lo = mid;
    else hi = mid;
  }
  const surface = (lo + hi) * 0.5;
  return Math.max(0.02, Math.min(MAX_HEIGHT, target < SEA_LEVEL - 0.06 ? Math.min(surface, target + 0.01) : surface));
}

// Grundform vom Zentrum zum Rand erzwingen: entlang jeder radialen Linie darf der nächste
// Schritt nach außen nicht höher liegen als der innere Schritt. Kleine lokale Wellen bleiben,
// aber keine "zweiten Berge" am Kartenrand.
function enforceRadialDescent(height, w, h, cx, cy) {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - cx, y - cy);
    cells.push([r, x, y]);
  }
  cells.sort((a, b) => a[0] - b[0]);
  for (const [, x, y] of cells) {
    if (Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1) continue;
    const i = y * w + x;
    const px = Math.round(x + Math.sign(cx - x));
    const py = Math.round(y + Math.sign(cy - y));
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const parent = py * w + px;
    const drop = 0.0015 + 0.0015 * radialNorm(x, y, cx, cy, Math.hypot(cx, cy));
    height[i] = Math.min(height[i], height[parent] - drop);
  }
}

// Eine Flusszelle nur flach formen. Der Fluss soll der Hangneigung folgen und sichtbar nass sein,
// aber nicht als tiefer Kanal/Canyon durch das Gelände schneiden.
function softenRiverCell(height, w, h, x, y, maxDig = 0.018) {
  const center = y * w + x;
  const bed = Math.max(SEA_LEVEL - 0.015, height[center] - maxDig);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const d = Math.hypot(dx, dy);
    if (d > 1.45) continue;
    const i = ny * w + nx;
    const lim = bed + d * 0.018;              // sehr flache Ufer
    height[i] = Math.min(height[i], lim);
  }
}

// Von einer Quelle den steilsten Abstieg bis Meer/Kartenrand verfolgen und ein Flusstal graben.
function carveRiver(t, start, rng, angle = null, protectedRadius = 0) {
  const { w, h, height } = t;
  const cx = w / 2, cy = h / 2;
  const path = [], seen = new Set();
  const outX = angle == null ? Math.cos(Math.atan2((start / w | 0) - cy, (start % w) - cx)) : Math.cos(angle);
  const outY = angle == null ? Math.sin(Math.atan2((start / w | 0) - cy, (start % w) - cx)) : Math.sin(angle);
  const sideX = -outY, sideY = outX;
  const meanderPhase = rng() * Math.PI * 2;
  const meanderFreq = 0.075 + rng() * 0.045;
  const meanderAmp = 0.8 + rng() * 0.5;
  let i = start, prev = -1;
  const maxLen = w + h;
  for (let step = 0; step < maxLen; step++) {
    const x = i % w, y = (i / w) | 0;
    if (!seen.has(i)) { path.push(i); seen.add(i); }
    if (!protectedRadius || !inCenterMountainCore(w, h, x, y, protectedRadius)) {
      softenRiverCell(height, w, h, x, y, 0.012);
    }
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) break;

    let best = -1, bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (protectedRadius && inCenterMountainCore(w, h, nx, ny, protectedRadius)) continue;
      const j = ny * w + nx;
      if (j === prev || seen.has(j)) continue;
      const len = Math.hypot(dx, dy);
      const dirCost = 1 - (dx / len) * outX - (dy / len) * outY;
      const edgeGain = Math.min(x, y, w - 1 - x, h - 1 - y) - Math.min(nx, ny, w - 1 - nx, h - 1 - ny);
      const downhill = Math.max(0, height[j] - height[i] + 0.004);
      const proj = Math.max(0, (nx - cx) * outX + (ny - cy) * outY);
      const side = (nx - cx) * sideX + (ny - cy) * sideY;
      const wantedSide = Math.sin(proj * meanderFreq + meanderPhase) * Math.min(9, 2 + proj * 0.05) * meanderAmp;
      const meanderCost = Math.abs(side - wantedSide) * 0.0055;
      const score = height[j] * 3 + dirCost * 0.065 + meanderCost - edgeGain * 0.032 + downhill * 24 + rng() * 0.010;
      if (score < bestScore) { bestScore = score; best = j; }
    }
    if (best < 0) break;
    if (height[best] >= height[i] - 0.001) height[best] = Math.max(height[best] - 0.012, height[i] - 0.003);
    prev = i; i = best;
  }
  if (path.length > Math.min(w, h) * 0.18) return path;

  let fi = start, fprev = -1;
  const fallbackMaxLen = w + h;
  const fallback = [];
  const seen2 = new Set();
  for (let step = 0; step < fallbackMaxLen; step++) {
    const x = fi % w, y = (fi / w) | 0;
    fallback.push(fi);
    seen2.add(fi);
    if (!protectedRadius || !inCenterMountainCore(w, h, x, y, protectedRadius)) {
      softenRiverCell(height, w, h, x, y, 0.014);
    }
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) break;  // Karte verlassen
    // tiefsten der 8 Nachbarn wählen (kein Rückschritt).
    let best = -1, bestH = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (protectedRadius && inCenterMountainCore(w, h, x + dx, y + dy, protectedRadius)) continue;
      const j = (y + dy) * w + (x + dx);
      if (j === fprev) continue;
      if (seen2.has(j)) continue;
      if (height[j] < bestH) { bestH = height[j]; best = j; }
    }
    if (best < 0) break;
    if (bestH >= height[fi]) height[best] = Math.max(height[best] - 0.012, height[fi] - 0.003); // Senke nur sanft durchstoßen
    fprev = fi; fi = best;
  }
  return fallback;
}

// Box-Glättung aller Zellen unterhalb einer Höhenschwelle (Seebett + flache Uferzone). Mehrere
// Durchgänge mitteln die Höhe mit den 8 Nachbarn; so verschwinden zerklüftete Unterwasser-Rippen,
// und die Wasserfläche darüber wirkt homogen. Verändert nur die Höhe, nutzt KEIN RNG.
// Ganzflächiges Abrunden: ein gewichteter 3×3-Gauß-Blur (Mitte 4, Kanten 2, Ecken 1) über die
// GESAMTE Höhenkarte. Entfernt scharfe Kanten an Senken/Erhebungen/Gräben/Rändern (Hochfrequenz)
// und lässt die Großform (Berg, Becken, Insel) weitgehend stehen. `mix` = Anteil der geglätteten
// Höhe (0..1). Kein RNG — muss NACH allen rng()-Aufrufen laufen, sonst verschiebt sich der Stream.
function roundTerrain(height, w, h, passes = 2, mix = 0.85) {
  const tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const wt = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0) ? 2 : 1;
        sum += height[ny * w + nx] * wt; wsum += wt;
      }
      const blurred = sum / wsum;
      tmp[i] = height[i] * (1 - mix) + blurred * mix;
    }
    for (let i = 0; i < w * h; i++) height[i] = tmp[i];
  }
}

function smoothBelow(height, w, h, threshold, passes) {
  const tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (height[i] >= threshold) { tmp[i] = height[i]; continue; }
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        sum += height[ny * w + nx]; n++;
      }
      tmp[i] = sum / n;
    }
    for (let i = 0; i < w * h; i++) height[i] = tmp[i];
  }
}

function carveHighLake(height, w, h, x, y, r, level) {
  for (let yy = -r - 2; yy <= r + 2; yy++) for (let xx = -r - 2; xx <= r + 2; xx++) {
    const nx = x + xx, ny = y + yy;
    if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
    const d = Math.hypot(xx, yy);
    const j = ny * w + nx;
    if (d <= r) {
      const floor = level - 0.12 + (d / Math.max(1, r)) * 0.025;
      height[j] = Math.min(height[j], floor);
    } else if (d <= r + 1.7) {
      height[j] = Math.max(height[j], level + 0.035);
    }
  }
}

function carveDryValley(height, w, h, cx, cy, angle, startR, length, width, floor) {
  const ax = Math.cos(angle), ay = Math.sin(angle);
  const points = [];
  const path = [];
  const seen = new Set();
  for (let s = 0; s < length; s++) {
    const fade = s / Math.max(1, length - 1);
    const mx = cx + ax * (startR + s);
    const my = cy + ay * (startR + s);
    if (mx < 2 || my < 2 || mx >= w - 2 || my >= h - 2) continue;
    points.push({ x: mx, y: my, along: fade });
    const ix = Math.round(mx), iy = Math.round(my);
    const key = `${ix},${iy}`;
    if (!seen.has(key)) { seen.add(key); path.push(iy * w + ix); }
  }
  stampContinuousCorridor(height, w, h, points, width + 0.85, ({ i, dist, along }) => {
    const side = Math.min(1, dist / Math.max(1, width + 0.35));
    return Math.max(SEA_LEVEL + 0.04, Math.min(height[i], floor - along * 0.035 + side * 0.052));
  });
  enforceSeaSlopePath(height, w, h, path, 0.0035, SEA_LEVEL + 0.04);
  const mid = points[(points.length / 2) | 0];
  return mid ? { x: Math.round(mid.x), y: Math.round(mid.y), floor, path } : null;
}

function smoothRiverCorridors(height, w, h, paths, protectedRadius = 0) {
  for (const path of paths || []) for (const i of path) {
    const x = i % w, y = (i / w) | 0;
    if (protectedRadius && inCenterMountainCore(w, h, x, y, protectedRadius)) continue;
    const base = height[i];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (protectedRadius && inCenterMountainCore(w, h, nx, ny, protectedRadius)) continue;
      const d = Math.hypot(dx, dy);
      if (d > 2.25) continue;
      const j = ny * w + nx;
      height[j] = Math.min(height[j], base + 0.018 + d * 0.026);
    }
  }
}

function smoothDryCorridors(height, w, h, paths, protectedRadius = 0) {
  for (const path of paths || []) for (const i of path) {
    const x = i % w, y = (i / w) | 0;
    if (protectedRadius && inCenterMountainCore(w, h, x, y, protectedRadius)) continue;
    const base = Math.max(SEA_LEVEL + 0.045, height[i]);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (protectedRadius && inCenterMountainCore(w, h, nx, ny, protectedRadius)) continue;
      const d = Math.hypot(dx, dy);
      if (d > 2.10) continue;
      const j = ny * w + nx;
      height[j] = Math.min(height[j], base + 0.026 + d * 0.030);
    }
  }
}

function stampContinuousCorridor(height, w, h, points, width, targetFor) {
  if (!points || points.length < 2) return;
  const targets = new Map();
  const pad = Math.ceil(width + 1.5);
  for (let n = 1; n < points.length; n++) {
    const a = points[n - 1], b = points[n];
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-5) continue;
    const minX = Math.max(1, Math.floor(Math.min(a.x, b.x) - pad));
    const maxX = Math.min(w - 2, Math.ceil(Math.max(a.x, b.x) + pad));
    const minY = Math.max(1, Math.floor(Math.min(a.y, b.y) - pad));
    const maxY = Math.min(h - 2, Math.ceil(Math.max(a.y, b.y) + pad));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
      const px = a.x + vx * t, py = a.y + vy * t;
      const dist = Math.hypot(x - px, y - py);
      if (dist > width) continue;
      const along = (a.along ?? 0) + ((b.along ?? 1) - (a.along ?? 0)) * t;
      const i = y * w + x;
      const target = targetFor({ i, x, y, dist, along });
      if (target == null) continue;
      const prev = targets.get(i);
      if (prev == null || target < prev) targets.set(i, target);
    }
  }
  for (const [i, target] of targets) height[i] = Math.max(0.02, Math.min(height[i], target));
}

function enforceSeaSlopePath(height, w, h, path, drop = 0.0025, minFloor = SEA_LEVEL + 0.025) {
  if (!path || path.length < 2) return;
  let prev = null;
  for (const i of path) {
    if (i < 0 || i >= w * h) continue;
    if (prev != null) height[i] = Math.min(height[i], Math.max(minFloor, prev - drop));
    prev = height[i];
  }
}

function enforceSeaSlopePaths(height, w, h, paths, drop = 0.0025, minFloor = SEA_LEVEL + 0.025) {
  for (const path of paths || []) enforceSeaSlopePath(height, w, h, path, drop, minFloor);
}

export function enforceDrainageToSea(t) {
  if (!t?.height) return;
  const valleyPaths = (t.valleys || []).map(v => v.path).filter(Boolean);
  enforceSeaSlopePaths(t.height, t.w, t.h, t.furrowPaths || [], 0.0025, SEA_LEVEL + 0.025);
  enforceSeaSlopePaths(t.height, t.w, t.h, valleyPaths, 0.0035, SEA_LEVEL + 0.04);
  const dryPaths = (t.furrowPaths || []).concat(valleyPaths);
  if (t.terra && t.height0) {
    for (const path of dryPaths) for (const i of path || []) {
      if (i < 0 || i >= t.w * t.h) continue;
      t.terra[i] = Math.abs(t.height[i] - t.height0[i]) < 1e-4 ? 0 : t.height[i] - t.height0[i];
      if (t.terraDirty && t.terra[i]) t.terraDirty.add(i);
    }
  }
}

function deepenRiverChannels(height, w, h, paths, protectedRadius = 0) {
  for (const path of paths || []) for (const i of path) {
    const x = i % w, y = (i / w) | 0;
    if (protectedRadius && inCenterMountainCore(w, h, x, y, protectedRadius)) continue;
    const bed = height[i];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (protectedRadius && inCenterMountainCore(w, h, nx, ny, protectedRadius)) continue;
      const d = Math.hypot(dx, dy);
      if (d > 2.25) continue;
      const j = ny * w + nx;
      const cut = d <= 0.1 ? 0.125 : d <= 1.45 ? 0.100 : 0.052;
      height[j] = Math.min(height[j], Math.max(SEA_LEVEL - 0.085, bed - cut));
    }
  }
}

export function stabilizeWaterTerrain(height, w, h, water, baseWater, height0 = null, terra = null) {
  const n = w * h;
  const waterish = (i) => (water[i] || 0) > WET_DEPTH * 0.55;
  const lowerWaterBed = (i, target) => {
    if (!waterish(i) || height[i] <= target) return false;
    const drop = height[i] - target;
    height[i] = target;
    if (height0) height0[i] = target;
    if (terra) terra[i] = 0;
    water[i] = Math.min(WATER_MAX_DEPTH, (water[i] || 0) + drop);
    baseWater[i] = Math.min(WATER_MAX_DEPTH, (baseWater[i] || 0) + drop);
    return true;
  };

  // Jede sichtbare Wasserzelle bekommt eine echte Wasserschicht über dem Boden.
  // Das verhindert Wasserflächen, die optisch nur knapp auf Spitzen/Rippen liegen.
  for (let i = 0; i < n; i++) {
    if (!waterish(i)) continue;
    const surface = height[i] + water[i];
    const minDepth = water[i] >= NAVIGABLE_DEPTH ? 0.085 : 0.045;
    lowerWaterBed(i, surface - minDepth);
  }

  // Unter Wasser dürfen benachbarte Zellen keine scharfen Höhenstufen bilden. Solche Rippen
  // schneiden sonst bei gemittelten Wasser-Mesh-Ecken durch die Oberfläche.
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!waterish(i)) continue;
      for (const [dx, dy, lim] of [[1, 0, 0.055], [0, 1, 0.055], [1, 1, 0.072], [1, -1, 0.072]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!waterish(j)) continue;
        if (height[i] > height[j] + lim) changed = lowerWaterBed(i, height[j] + lim) || changed;
        else if (height[j] > height[i] + lim) changed = lowerWaterBed(j, height[i] + lim) || changed;
      }
    }
    if (!changed) break;
  }
}

export function softenRiverBanks(t, maxBank = 0.065) {
  if (!t?.riverPaths || !t.height) return;
  for (const path of t.riverPaths) for (const i of path) {
    if (t.height[i] < SEA_LEVEL - 0.02) continue;
    const x = i % t.w, y = (i / t.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(t, nx, ny)) continue;
      const j = ny * t.w + nx;
      const lim = t.height[i] + maxBank;
      if (t.height[j] <= lim) continue;
      t.height[j] = lim;
      if (t.height0) t.height0[j] = lim;
      if (t.terra) t.terra[j] = 0;
    }
  }
}

function addLocalRelief(height, w, h, rng, cx, cy) {
  const minDim = Math.min(w, h);
  const maxR = Math.hypot(cx, cy);
  const bumps = Math.max(76, Math.round((w * h) / 500));
  for (let n = 0; n < bumps; n++) {
    const a = rng() * Math.PI * 2;
    const rr = minDim * (0.15 + rng() * 0.58);
    const bx = Math.round(cx + Math.cos(a) * rr + (rng() - 0.5) * minDim * 0.18);
    const by = Math.round(cy + Math.sin(a) * rr + (rng() - 0.5) * minDim * 0.18);
    if (bx < 4 || by < 4 || bx >= w - 4 || by >= h - 4) continue;
    const r = 3 + rng.int(Math.max(6, Math.round(minDim * 0.065)));
    const amp = 0.06 + rng() * 0.11;   // sanftere Hügel (weniger zerklüftet)
    for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) {
      const x = bx + xx, y = by + yy;
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
      const d = Math.hypot(xx, yy) / Math.max(1, r);
      if (d > 1) continue;
      const rn = Math.min(1, Math.hypot(x - cx, y - cy) / maxR);
      const ring = Math.sin((1 - d) * Math.PI);
      height[y * w + x] = Math.min(MAX_HEIGHT, height[y * w + x] + amp * (0.72 * (1 - d * d) + 0.28 * ring) * (0.42 + 0.68 * (1 - rn)));
    }
  }

  const trenches = Math.max(14, Math.round((w * h) / 2600));
  const trenchPaths = [];
  for (let n = 0; n < trenches; n++) {
    const baseA = rng() * Math.PI * 2;
    let a = baseA;
    let r0 = minDim * (0.24 + rng() * 0.34);
    let x = cx + Math.cos(baseA) * r0;
    let y = cy + Math.sin(baseA) * r0;
    const len = Math.round(minDim * (0.12 + rng() * 0.20));
    const width = 1 + rng.int(3);
    const dig = 0.03 + rng() * 0.055;   // flachere Gräben/Senken abseits des Flusses (nicht mehr zu tief)
    const points = [];
    const path = [];
    let lastR = r0;
    for (let s = 0; s < len; s++) {
      const radial = Math.atan2(y - cy, x - cx);
      a = radial + Math.sin((s + n * 7) * 0.27) * 0.18 + (rng() - 0.5) * 0.16;
      x += Math.cos(a) * 1.15;
      y += Math.sin(a) * 1.15;
      const rr = Math.hypot(x - cx, y - cy);
      if (rr < lastR + 0.38) {
        const nr = lastR + 0.38;
        const ra = Math.atan2(y - cy, x - cx);
        x = cx + Math.cos(ra) * nr;
        y = cy + Math.sin(ra) * nr;
        lastR = nr;
      } else lastR = rr;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 3 || iy < 3 || ix >= w - 3 || iy >= h - 3) break;
      points.push({ x, y, along: s / Math.max(1, len - 1) });
      const i = iy * w + ix;
      if (path[path.length - 1] !== i) path.push(i);
    }
    stampContinuousCorridor(height, w, h, points, width + 0.80, ({ i, dist, along }) => {
      const fade = Math.sin(along * Math.PI);
      const lateral = Math.max(0, 1 - dist / (width + 0.80));
      const cut = dig * fade * Math.pow(lateral, 0.72);
      const outSlope = Math.max(SEA_LEVEL + 0.025, 0.82 - along * 0.58);
      return Math.max(SEA_LEVEL + 0.025, Math.min(height[i] - cut, outSlope + dist * 0.040));
    });
    enforceSeaSlopePath(height, w, h, path, 0.003, SEA_LEVEL + 0.025);
    if (path.length > 2) trenchPaths.push(path);
  }
  return trenchPaths;
}

function plateauNoise(x, y, seed) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function addOuterPlateaus(height, w, h, rng, cx, cy) {
  const minDim = Math.min(w, h);
  const maxR = Math.hypot(cx, cy);
  const count = Math.max(5, Math.round(minDim / 17));
  const placed = [];
  for (let n = 0; n < count; n++) {
    let px = 0, py = 0, ok = false;
    for (let tries = 0; tries < 36 && !ok; tries++) {
      const a = rng() * Math.PI * 2;
      const rr = minDim * (0.28 + rng() * 0.24);
      px = Math.round(cx + Math.cos(a) * rr + (rng() - 0.5) * minDim * 0.08);
      py = Math.round(cy + Math.sin(a) * rr + (rng() - 0.5) * minDim * 0.08);
      const edge = Math.min(px, py, w - 1 - px, h - 1 - py);
      if (px < 6 || py < 6 || px >= w - 6 || py >= h - 6 || edge < minDim * 0.10) continue;
      if (height[py * w + px] < SEA_LEVEL + 0.13) continue;
      ok = placed.every((p) => Math.hypot(px - p.x, py - p.y) > minDim * 0.14);
    }
    if (!ok) continue;
    placed.push({ x: px, y: py });
    const rx = 4 + rng.int(Math.max(5, Math.round(minDim * 0.050)));
    const rz = 4 + rng.int(Math.max(5, Math.round(minDim * 0.045)));
    const angle = rng() * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const rn = Math.min(1, Math.hypot(px - cx, py - cy) / maxR);
    const baseLevel = Math.max(height[py * w + px] + 0.09, 0.70 - rn * 0.16 + rng() * 0.22);
    const level = Math.min(MAX_HEIGHT - 0.22, baseLevel);
    const top = 0.43 + rng() * 0.12;
    for (let yy = -rz - 2; yy <= rz + 2; yy++) for (let xx = -rx - 2; xx <= rx + 2; xx++) {
      const x = px + xx, y = py + yy;
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
      const lx = (xx * ca + yy * sa) / rx;
      const ly = (-xx * sa + yy * ca) / rz;
      const d = Math.hypot(lx, ly);
      if (d > 1.24) continue;
      const j = y * w + x;
      const rim = d <= top ? 1 : Math.max(0, (1.24 - d) / (1.24 - top));
      const blend = d <= top ? 0.86 : rim * 0.58;
      const rough = (plateauNoise(x, y, n + 19) - 0.5) * 0.018;
      const shoulderDrop = Math.max(0, d - top) * 0.14;
      const target = Math.max(SEA_LEVEL + 0.12, level + rough - shoulderDrop);
      const shaped = height[j] * (1 - blend) + target * blend;
      height[j] = Math.min(MAX_HEIGHT, Math.max(height[j], shaped));
    }
  }
}

// NUTZBARE PLATEAUS: flachgedeckelte Mesas mit ebener, bebaubarer Oberfläche und sanft abfallenden
// Rändern. Läuft NACH der Endrundung (damit die Flächen eben bleiben) und nutzt eine SEPARATE rng,
// um den deterministischen Hauptstrom (carveRiver etc. → Tests) nicht zu verschieben.
function stampUsablePlateaus(height, w, h, rngP, cx, cy, avoid = []) {
  const minDim = Math.min(w, h), maxR = Math.hypot(cx, cy);
  const count = Math.max(5, Math.round(minDim / 22));
  const placed = [];
  for (let n = 0; n < count; n++) {
    let px = 0, py = 0, ok = false;
    for (let tries = 0; tries < 44 && !ok; tries++) {
      const a = rngP() * Math.PI * 2;
      const rr = minDim * (0.18 + rngP() * 0.30);
      px = Math.round(cx + Math.cos(a) * rr + (rngP() - 0.5) * minDim * 0.10);
      py = Math.round(cy + Math.sin(a) * rr + (rngP() - 0.5) * minDim * 0.10);
      if (px < 8 || py < 8 || px >= w - 8 || py >= h - 8) continue;
      if (Math.min(px, py, w - 1 - px, h - 1 - py) < minDim * 0.11) continue;
      if (height[py * w + px] < SEA_LEVEL + 0.10) continue; // nicht ins Meer/an die Küste
      // Trockentäler/Flutziele freihalten — ein Plateau dort würde die Senke zuschütten.
      if (avoid.some(V => Math.hypot(px - V.x, py - V.y) < minDim * 0.10)) continue;
      ok = placed.every((p) => Math.hypot(px - p.x, py - p.y) > minDim * 0.13);
    }
    if (!ok) continue;
    placed.push({ x: px, y: py });
    const rad = 5 + rngP.int(5);          // ebener Deckel-Radius 5..9
    const skirt = 3 + rngP.int(3);        // abfallender Rand 3..5
    const rn = Math.min(1, Math.hypot(px - cx, py - cy) / maxR);
    // Klar erhöhter, ebener Deckel — innen näher am Berg höher gelegen.
    const level = Math.min(MAX_HEIGHT - 0.20, Math.max(height[py * w + px] + 0.14, 0.58 + (1 - rn) * 0.26 + rngP() * 0.12));
    for (let yy = -rad - skirt; yy <= rad + skirt; yy++) for (let xx = -rad - skirt; xx <= rad + skirt; xx++) {
      const x = px + xx, y = py + yy;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const d = Math.hypot(xx, yy);
      if (d > rad + skirt) continue;
      const j = y * w + x;
      let target;
      if (d <= rad) target = level;        // EBENER Deckel (bebaubar)
      else { const f = (d - rad) / skirt; const s = f * f * (3 - 2 * f); target = level * (1 - s) + height[j] * s; }
      height[j] = Math.max(height[j], target); // Mesa hebt sich übers Umland
    }
  }
}

export function generateTerrain({ w, h, seed = 1 }) {
  const rng = makeRng(seed * 2654435761 >>> 0);
  const base = noise2(rng, w, h, 5);
  // Separates Grat-Rauschen für Gebirgsketten (ridged: Bergrücken statt Kuppen).
  const rng2 = makeRng((seed * 40503 + 0x9e3779b9) >>> 0);
  const ridge = noise2(rng2, w, h, 3);
  // Eigener rng-Strom für nutzbare Plateaus — verschiebt den Haupt-rng-Strom NICHT (Determinismus/Tests).
  const rngP = makeRng((seed * 2246822519 + 0x165667b1) >>> 0);
  const height = new Float32Array(w * h);
  const type = new Uint8Array(w * h);
  const water = new Float32Array(w * h);     // dynamische Wassertiefe pro Zelle (Höheneinheiten über Boden)
  const baseWater = new Float32Array(w * h); // Gleichgewichts-Seefüllung (statisch); Versickerung wirkt nur darüber
  const waterBlock = new Uint8Array(w * h);  // Dämme/Deiche sperren den Wasserfluss (CA-Barriere)
  const cover = new Float32Array(w * h);     // natürlicher Deckungswert pro Zelle (0..1), z. B. Wald
  const coverBuilt = new Float32Array(w * h); // Deckung aus Befestigungen (Wall/Graben)
  const block = new Uint8Array(w * h);        // Anzahl blockierender Befestigungen pro Zelle
  const ore = new Float32Array(w * h);        // Erzvorkommen
  const oil = new Float32Array(w * h);        // Ölquellen (sichtbare schwarze Flecken, erschöpfbar)
  const bridge = new Uint8Array(w * h);       // Brückenzellen: Land läuft über Wasser
  const tunnel = new Uint8Array(w * h);       // Tunnelzellen: Land quert Klippen/Berge
  const tracks = new Float32Array(w * h);     // Fahrzeugspuren/Spurrillen (0..1)
  const mud = new Float32Array(w * h);        // aufgeweichter, festgefahrener Matsch (0..1)
  const trackDir = new Uint8Array(w * h);     // 0..7 Fahrtrichtung der dominanten Spur
  const lakeMask = new Uint8Array(w * h);      // echte Hochsee-Zellen (Pegel steigt/sinkt als See)

  // Höhenrelief formen (Phase 15: Insel-Layout):
  //  • Kontrast-Spreizung um 0.5 → ausgeprägte Senken UND Höhen statt flacher Ebene.
  //  • schmale Gebirgsketten aus Grat-Rauschen (nur auf erhöhtem Untergrund).
  //  • ZENTRALBERG: markanter Gipfel in der Kartenmitte (Schneekappe, Flussquelle).
  //  • RANDMEER: die Karte ist vollständig von Meer umgeben (Höhen fallen zum Rand ab).
  const cx0 = w / 2, cy0 = h / 2;
  // Imposantes Massiv: scharfer Hauptgipfel + breiter Bergfuß + radiale Grate/Rinnen.
  const minDim = Math.min(w, h);
  const centerProtectRadius = centerMountainCoreRadius(w, h);
  const sigma = minDim * 0.034;                    // Hauptgipfel (steil)
  const sigma2 = minDim * 0.18;                    // Bergfuß (weit auslaufend)
  const sigma3 = minDim * 0.074;                   // felsige Schulter unterhalb des Gipfels
  const spurPhase = rng() * Math.PI * 2;
  const edge = Math.max(5, Math.round(minDim * EDGE_SEA));
  const maxR = Math.hypot(cx0, cy0);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    const dx = x - cx0, dy = y - cy0;
    const r2 = dx * dx + dy * dy;
    const r = Math.sqrt(r2);
    const rn = Math.min(1, r / maxR);
    const fall = rn * rn * (3 - 2 * rn);
    // Dominantes Inselprofil: mittig hoch, zum Meer hin zuverlässig niedriger.
    let e = SEA_LEVEL - 0.055 + (0.74 - (SEA_LEVEL - 0.055)) * Math.pow(1 - fall, 0.82);
    // Etwas GRÖSSERE Höhenunterschiede (mehr Relief), aber NICHT zerklüftet: die Amplitude der
    // Grundwellen/Grate steigt moderat — die roundTerrain-Pässe glätten nur die kleinskaligen scharfen
    // Kanten weg, die großen Hügel/Senken (niederfrequent) bleiben erhalten.
    e += (base[i] - 0.5) * (0.48 * (1 - fall) + 0.125);
    const ridged = Math.pow(1 - Math.abs(2 * ridge[i] - 1), 7);
    const flankMask = Math.min(1, r / Math.max(1, minDim * 0.09));
    e += ridged * 0.56 * Math.max(0, base[i] - 0.5) * 2.0 * (1 - rn * 0.48) * flankMask;
    // Zentralmassiv: spitzer Gipfel auf breitem Sockel; Grate und Rinnen brechen die Rundform.
    const summit = Math.exp(-r2 / (2 * sigma * sigma));
    const shoulder = Math.exp(-r2 / (2 * sigma3 * sigma3));
    const foot = Math.exp(-r2 / (2 * sigma2 * sigma2));
    const angle = Math.atan2(dy, dx);
    const spur = Math.pow(Math.max(0, Math.sin(angle * 7 + spurPhase) * 0.5 + 0.5), 2.15) * foot * flankMask;
    const couloir = Math.pow(Math.max(0, Math.cos(angle * 6 - spurPhase) * 0.5 + 0.5), 3.0) * shoulder * flankMask;
    const crag = hashVolume(x * 0.16, y * 0.16, 3.0, seed) * (summit * 0.55 + shoulder * 0.80);
    // weichere Grate/Rinnen und gedämpfte Felsrauheit → der Berg bleibt markant, wirkt aber weniger zerklüftet
    e += 0.88 * summit + 0.42 * shoulder + 0.32 * foot + 0.24 * spur + 0.040 * crag;
    e -= 0.110 * couloir;
    if (e > 0.78) e += (e - 0.78) * 0.72;
    e -= 0.08 * fall;
    // Randmeer: weicher Abfall in die See an allen vier Kanten.
    const dEdge = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (dEdge < edge) { const f = dEdge / edge; e = e * f * f + Math.max(0.02, SEA_LEVEL - 0.22) * (1 - f * f); }
    height[i] = extractVolumetricSurface(x, y, e, seed);
  }
  enforceRadialDescent(height, w, h, cx0, cy0);
  const reliefTrenchPaths = addLocalRelief(height, w, h, rng, cx0, cy0);
  addOuterPlateaus(height, w, h, rng, cx0, cy0);
  enforceRadialDescent(height, w, h, cx0, cy0);
  protectCenterMountain(height, w, h, centerProtectRadius);

  // Flussquellen: ZWEI Quellen an gegenüberliegenden Flanken des Zentralbergs — der Fluss
  // entsteht am Berg und fließt zu zwei Seiten Richtung Meer (Karte ist von Meer umgeben).
  // WICHTIG: Quellen unterhalb des Gipfelgrats platzieren; ganz oben fehlt sonst Gefälle und
  // carveRiver würde sich quer durch den Berg fressen.
  const sources = [];
  const sourceAngles = [];
  const a0 = rng() * Math.PI * 2;
  for (const a of [a0, a0 + Math.PI]) {
    let sx = cx0, sy = cy0;
    for (let r = Math.ceil(centerProtectRadius) + 2; r < Math.min(w, h) / 2; r++) {
      sx = Math.round(cx0 + Math.cos(a) * r);
      sy = Math.round(cy0 + Math.sin(a) * r);
      if (height[sy * w + sx] < 1.16) break;
    }
    sources.push(sy * w + sx);
    sourceAngles.push(a);
  }
  // Flusstäler einkerben: vom Berg radial mit leichter Mäanderung bis ins Randmeer führen.
  const riverPaths = [];
  for (let n = 0; n < sources.length; n++) {
    riverPaths.push(carveRiver({ w, h, height }, sources[n], rng, sourceAngles[n], centerProtectRadius)
      .filter(i => !inCenterMountainCore(w, h, i % w, (i / w) | 0, centerProtectRadius)));
  }

  // ZUSÄTZLICHE ENTWÄSSERUNGS-FURCHEN/CANYONS: viele radiale Trockenrinnen von der Bergschulter
  // bis ins Meer. Sie führen normalerweise kein Wasser, geben Regen-/Schmelz-/Flutwasser aber
  // einen klaren Weg zum Meer (verhindert großflächige stehende Fluten). Keine Quellen → trocken.
  const furrowPaths = [];
  const furrowCount = Math.max(10, Math.round(Math.min(w, h) / 12));
  const fBase = rng() * Math.PI * 2;
  for (let f = 0; f < furrowCount; f++) {
    const a = fBase + (f / furrowCount) * Math.PI * 2 + (rng() - 0.5) * 0.18;
    // Startpunkt auf einem Ring um den Berg (hoch genug für Gefälle, unterhalb des Gipfelgrats).
    let sx = cx0, sy = cy0;
    for (let r = Math.ceil(centerProtectRadius) + 3; r < Math.min(w, h) / 2; r++) {
      sx = Math.round(cx0 + Math.cos(a) * r);
      sy = Math.round(cy0 + Math.sin(a) * r);
      if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) break;
      if (height[sy * w + sx] < SEA_LEVEL + 0.42) break;   // ab mittlerer Höhe starten
    }
    if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
    furrowPaths.push(carveRiver({ w, h, height }, sy * w + sx, rng, a, centerProtectRadius)
      .filter(i => !inCenterMountainCore(w, h, i % w, (i / w) | 0, centerProtectRadius)));
  }
  const dryDrainPaths = furrowPaths.concat(reliefTrenchPaths || []);
  enforceSeaSlopePaths(height, w, h, dryDrainPaths, 0.0025, SEA_LEVEL + 0.025);

  // Strategische Hochseen: mindestens 3 höher gelegene, vom Geländerand eingefasste Becken
  // um den Zentralberg. Wer den Rand anbohrt, lässt Wasser in die tieferen Täler ablaufen.
  const lakes = [];
  const valleys = [];
  const wantLakes = Math.max(4, Math.round(Math.min(w, h) / 42));  // große Karte → mehr Hochseen
  const featureBase = rng() * Math.PI * 2;
  for (let l = 0; l < wantLakes; l++) {
    const a = featureBase + (l / wantLakes) * Math.PI * 2;
    const rr = Math.min(w, h) * (0.18 + (l % 2) * 0.035);
    const lx = Math.round(cx0 + Math.cos(a) * rr);
    const ly = Math.round(cy0 + Math.sin(a) * rr);
    const li = ly * w + lx;
    // Bergseen liegen auf der Bergflanke und damit DEUTLICH höher als Basis (~0.49–0.60) und Fluss:
    // Deckel von 0.72 auf 0.95 angehoben, Mindestniveau über die Basishöhe gelegt. Ihr Überlauf
    // speist über das Gefälle die Flüsse; tiefer liegende Mulden/Täler bleiben darunter.
    const level = Math.max(SEA_LEVEL + 0.26, Math.min(0.95, height[li] + 0.04));
    const r = 3 + (l % 2);
    carveHighLake(height, w, h, lx, ly, r, level);
    lakes.push({ x: lx, y: ly, r, level });

    if (valleys.length < 3) {
      const valleyFloor = Math.max(SEA_LEVEL + 0.055, level - 0.18);
      const v = carveDryValley(height, w, h, cx0, cy0, a, rr + r + 3, Math.round(Math.min(w, h) * 0.10), 2, valleyFloor);
      if (v) valleys.push({ ...v, level: valleyFloor, floodFrom: lakes[l].level });
    }
  }
  const valleyPaths = valleys.map(v => v.path).filter(Boolean);
  // ALLES abrunden: nach dem Stanzen aller Features (Becken, Hochseen, Täler, Gräben, Hügel) die
  // gesamte Karte glätten, damit keine scharfkantigen Geländeabschnitte bleiben. Läuft NACH dem
  // letzten rng()-Aufruf (Determinismus) und VOR den Korridor-/Berg-/Drainage-Passes, die danach
  // Flussbetten wieder vertiefen und den Gipfelkern schützen.
  roundTerrain(height, w, h, 2, 0.85);
  enforceSeaSlopePaths(height, w, h, valleyPaths, 0.0035, SEA_LEVEL + 0.04);
  smoothRiverCorridors(height, w, h, riverPaths, centerProtectRadius);
  smoothDryCorridors(height, w, h, dryDrainPaths, centerProtectRadius);
  smoothDryCorridors(height, w, h, valleyPaths, centerProtectRadius);
  enforceSeaSlopePaths(height, w, h, dryDrainPaths, 0.0025, SEA_LEVEL + 0.025);
  enforceSeaSlopePaths(height, w, h, valleyPaths, 0.0035, SEA_LEVEL + 0.04);

  // Küstenglättung: Seebett und flache Uferzone mehrfach mitteln, damit unter der Wasserfläche
  // keine zerklüfteten Rippen durch das (flache) Wasser stoßen. Das ergibt eine homogene
  // Wasserfläche statt eines „Labyrinths" aus halb herausragenden Geländekanten. Kein RNG.
  smoothBelow(height, w, h, SEA_LEVEL + 0.06, 3);
  smoothRiverCorridors(height, w, h, riverPaths, centerProtectRadius);
  smoothDryCorridors(height, w, h, dryDrainPaths, centerProtectRadius);
  smoothDryCorridors(height, w, h, valleyPaths, centerProtectRadius);
  deepenRiverChannels(height, w, h, riverPaths, centerProtectRadius);
  enforceSeaSlopePaths(height, w, h, dryDrainPaths, 0.0025, SEA_LEVEL + 0.025);
  enforceSeaSlopePaths(height, w, h, valleyPaths, 0.0035, SEA_LEVEL + 0.04);
  protectCenterMountain(height, w, h, centerProtectRadius);
  // Abschluss-Rundung: glättet die Kanten, die das Fluss-Vertiefen und der Gipfelschutz gerade
  // wieder erzeugt haben (Flussufer, Kernrand). Mild gehalten, damit Flüsse/Berg erhalten bleiben;
  // die schiffbaren Fluss-Kerne werden direkt danach ohnehin neu gesetzt.
  roundTerrain(height, w, h, 1, 0.5);
  // Nutzbare, ebene Plateaus NACH der Rundung stempeln (sonst würden die Deckel weggeglättet).
  stampUsablePlateaus(height, w, h, rngP, cx0, cy0, valleys);

  for (let i = 0; i < w * h; i++) {
    const e = height[i];
    const slope = slopeAtHeight(height, w, h, i);
    let t = TT.LAND;
    if (e < SEA_LEVEL) t = TT.WATER;
    else if (e > 0.86 || (e > 0.66 && slope > 0.044) || slope > 0.105) t = TT.CLIFF;
    else if (e > 0.50 || slope > 0.036) t = TT.HILL;
    type[i] = t;
    // Becken bis zur Seehöhe füllen: Wassertiefe = Seehöhe − Boden (Oberfläche flach → Gleichgewicht).
    const w0 = Math.max(0, SEA_LEVEL - e);
    water[i] = w0;
    baseWater[i] = w0;
    // Hügel geben leichte natürliche Deckung (höher = schwerer zu treffen).
    if (t === TT.HILL) cover[i] = 0.15;
  }

  // Hochseen initial nur flach füllen: die Becken sind sichtbar nass, aber nicht voll.
  // Die Start-Schneeschmelze und Regen heben den Pegel dynamisch.
  for (const L of lakes) {
    for (let yy = -L.r; yy <= L.r; yy++) for (let xx = -L.r; xx <= L.r; xx++) {
      const nx = L.x + xx, ny = L.y + yy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (Math.hypot(xx, yy) > L.r) continue;
      const j = ny * w + nx;
      const d0 = Math.max(0, L.level - height[j]);
      if (d0 > 0) {
        const shallow = Math.min(d0, Math.max(WET_DEPTH * 1.15, d0 * 0.34));
        water[j] = Math.max(water[j], shallow);
        baseWater[j] = Math.max(baseWater[j], shallow);
        lakeMask[j] = 1;
      }
    }
  }

  // Bergflüsse initialisieren: breite Kerne sind echtes, beschiffbares Fahrwasser; die äußeren
  // Randzellen bleiben nur feucht/matschig und zählen nicht als Wasserstraße.
  for (const path of riverPaths) for (const i of path) {
    const x = i % w, y = (i / w) | 0;
    if (inCenterMountainCore(w, h, x, y, centerProtectRadius)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (inCenterMountainCore(w, h, nx, ny, centerProtectRadius)) continue;
      const d = Math.hypot(dx, dy);
      if (d > 2.25) continue;
      const j = ny * w + nx;
      const core = d <= 1.55;
      const localDepth = core
        ? Math.max(NAVIGABLE_DEPTH * 1.22, SEA_LEVEL + 0.13 - height[j])
        : Math.max(WET_DEPTH * 0.66, NAVIGABLE_DEPTH * 0.38);
      water[j] = Math.max(water[j], localDepth);
      baseWater[j] = Math.max(baseWater[j], core ? localDepth * 0.96 : Math.min(localDepth, WET_DEPTH * 0.82));
      if (core) type[j] = TT.WATER;
    }
  }

  stabilizeWaterTerrain(height, w, h, water, baseWater);
  enforceSeaSlopePaths(height, w, h, dryDrainPaths, 0.0025, SEA_LEVEL + 0.025);
  enforceSeaSlopePaths(height, w, h, valleyPaths, 0.0035, SEA_LEVEL + 0.04);

  // Schnee auf dem Zentralberg (und hohen Graten): schmilzt bei Sonne → Schmelzwasser speist Flüsse.
  // snowIdx   = dauerhafte Gipfelkappe (über SNOW_LINE), startet mit Schnee.
  // snowFallIdx = größeres Einzugsband (über SNOW_FALL_LINE): hier kann sich bei Niederschlag
  //   Neuschnee ablagern, sodass die Schneedecke im Sturm sichtbar talwärts wächst und bei Sonne
  //   wieder nach oben zurückweicht. Bandzellen starten ohne Schnee (snow[i] = 0).
  const snow = new Float32Array(w * h);
  const snowIdx = [];
  const snowFallIdx = [];
  for (let i = 0; i < w * h; i++) {
    if (height[i] > SNOW_LINE) { snow[i] = (height[i] - SNOW_LINE) * SNOW_INIT; snowIdx.push(i); }
    if (height[i] > SNOW_FALL_LINE) snowFallIdx.push(i);
  }
  const startMeltCells = [];
  for (const i of snowIdx) {
    const x = i % w, y = (i / w) | 0;
    let edgeSnow = false;
    for (let dy = -1; dy <= 1 && !edgeSnow; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || height[ny * w + nx] <= SNOW_LINE) {
        edgeSnow = true;
        break;
      }
    }
    if (edgeSnow) startMeltCells.push(i);
  }
  if (!startMeltCells.length && snowIdx.length) startMeltCells.push(snowIdx[0]);

  // Straßennetz: automatisch zwischen nahen Gebäuden (systems/roads.js) + manuell gebaute
  // Straßen (road-Gebäude, auch außerhalb der Basis — überwinden größere Steigungen).
  const road = new Uint8Array(w * h);
  const roadBuilt = new Uint8Array(w * h);

  const slopeAt = (i) => {
    const x = i % w;
    let s = 0;
    if (x > 0) s = Math.max(s, Math.abs(height[i] - height[i - 1]));
    if (x < w - 1) s = Math.max(s, Math.abs(height[i] - height[i + 1]));
    if (i >= w) s = Math.max(s, Math.abs(height[i] - height[i - w]));
    if (i < w * (h - 1)) s = Math.max(s, Math.abs(height[i] - height[i + w]));
    return s;
  };

  // Ölquellen: dunkle Sickerflecken in niedrigerem, trockenem Gelände. Bohrtürme können nur
  // auf diesen Flecken stehen; Förderung schrumpft das Feld bis zur Erschöpfung.
  const oilClusters = Math.max(4, Math.round((w * h) / 7000));
  for (let c = 0, tries = 0; c < oilClusters && tries < 3000; tries++) {
    const cx = 5 + rng.int(w - 10), cy = 5 + rng.int(h - 10);
    const ci = cy * w + cx;
    if (type[ci] !== TT.LAND && type[ci] !== TT.HILL) continue;
    if (water[ci] > WET_DEPTH || lakeMask[ci] || height[ci] <= SEA_LEVEL + 0.035 || height[ci] > 0.62) continue;
    if (slopeAt(ci) > 0.04) continue;
    const r = 3 + rng.int(4);
    let stamped = 0;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const tx = cx + x, ty = cy + y;
      if (tx < 2 || ty < 2 || tx >= w - 2 || ty >= h - 2) continue;
      const d = Math.hypot(x, y);
      if (d > r || rng() < d * 0.12) continue;
      const i = ty * w + tx;
      if (type[i] !== TT.LAND && type[i] !== TT.HILL) continue;
      if (water[i] > WET_DEPTH || lakeMask[i] || height[i] <= SEA_LEVEL + 0.035 || slopeAt(i) > 0.055) continue;
      oil[i] = Math.max(oil[i], (1 - d / r) * (420 + rng.int(420)) + 120);
      stamped++;
    }
    if (stamped >= 5) c++;
  }

  // Waldflächen: organische, zufällige Cluster, bevorzugt an Hängen. Nur trockene Land-/Hügelzellen
  // bekommen echte Walddeckung (>=0.2); Wasser, Hochseen und Flussläufe bleiben frei.
  const forestClusters = Math.max(14, Math.round((w * h) / 1150));
  for (let f = 0, tries = 0; f < forestClusters && tries < forestClusters * 80; tries++) {
    const cx = 4 + rng.int(w - 8), cy = 4 + rng.int(h - 8);
    const ci = cy * w + cx;
    const onSlope = slopeAt(ci) >= 0.014;
    if ((type[ci] !== TT.LAND && type[ci] !== TT.HILL) || water[ci] > WET_DEPTH || oil[ci] > 0 || height[ci] <= SEA_LEVEL + 0.05) continue;
    if (!onSlope && rng() < 0.9) continue;
    const rx = 3 + rng.int(5), ry = 2 + rng.int(4);
    const ang = rng() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = -ry - 1; y <= ry + 1; y++) for (let x = -rx - 1; x <= rx + 1; x++) {
      const tx = cx + x, ty = cy + y;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const i = ty * w + tx;
      if (type[i] !== TT.LAND && type[i] !== TT.HILL) continue;
      if (water[i] > WET_DEPTH || lakeMask[i] || oil[i] > 0 || height[i] <= SEA_LEVEL + 0.05) continue;
      const localSlope = slopeAt(i);
      if (localSlope < 0.006 && rng() < 0.75) continue;
      const lx = (x * ca + y * sa) / rx;
      const ly = (-x * sa + y * ca) / ry;
      const d = Math.hypot(lx, ly);
      if (d > 1 || rng() < d * 0.18) continue;
      const slopeBoost = Math.min(0.18, localSlope * 2.4);
      cover[i] = Math.max(cover[i], (1 - d) * 0.42 + 0.2 + slopeBoost);
    }
    f++;
  }

  // Erzfelder (Phase 17): Erz steht an HÄNGEN an — Zellen mit deutlicher Neigung (Bergflanken,
  // Hügelkanten). Der Erzbagger trägt den Hang beim Fördern ab (Erosion/Steinschlag, economy.js).
  const clusters = Math.max(6, Math.round((w * h) / 1500));
  for (let c = 0, tries = 0; c < clusters && tries < 4000; tries++) {
    const cx = 4 + rng.int(w - 8), cy = 4 + rng.int(h - 8);
    const ci = cy * w + cx;
    if (!isDryOreCell({ type, water, baseWater, lakeMask, oil }, ci)) continue;
    if (slopeAt(ci) < 0.045) continue;                       // nur an Hängen
    const r = 3 + rng.int(3);
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const tx = cx + x, ty = cy + y;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const d = Math.hypot(x, y);
        if (d > r) continue;
        const i = ty * w + tx;
        if (isDryOreCell({ type, water, baseWater, lakeMask, oil }, i) && slopeAt(i) >= 0.035)
          ore[i] = Math.max(ore[i], (1 - d / r) * (800 + rng.int(800)));
      }
    c++;
  }

  // Liste aller Erz-Tiles (für schnelle Nächste-Suche der Harvester).
  const oreList = [];
  for (let i = 0; i < w * h; i++) if (ore[i] > 0) oreList.push(i);
  const oilList = [];
  for (let i = 0; i < w * h; i++) if (oil[i] > 0) oilList.push(i);

  // Aktive Zellen des Wasser-CA (instabil = änderungswürdig). Quellen sind immer aktiv.
  const waterActive = new Set(sources);
  for (const path of riverPaths) for (const i of path) waterActive.add(i);
  for (const i of startMeltCells) waterActive.add(i);

  // Schnappschuss der Ausgangshöhen (inkl. Flüsse/Berge) — Referenz für Laufzeit-Terraforming-Deltas.
  const height0 = Float32Array.from(height);
  const terra = new Float32Array(w * h);   // aktuelles Terraforming-Delta je Zelle (height − height0)
  const terraDirty = new Set();            // Zellen mit geänderter Höhe seit letztem Snapshot (Streaming)

  return {
    w, h, height, height0, terra, terraDirty, type, water, baseWater, waterBlock,
    cover, coverBuilt, block, ore, oreList, oil, oilList, oilDirty: new Set(), sources, waterActive, bridge, tunnel,
    tracks, mud, trackDir, lakeMask,
    snow, snowIdx, snowFallIdx, road, roadBuilt, lakes, valleys, riverPaths, furrowPaths: dryDrainPaths,
    startMeltCells, startMeltLeft: 300, startMeltTotal: 300,
  };
}

// Wassertiefe / Nässe-Abfragen.
export function waterDepthAt(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return 0;
  return t.water[tIdx(t, tx, ty)];
}
export function isWet(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return false;
  return t.water[tIdx(t, tx, ty)] > WET_DEPTH;
}

export function waterBlocksLand(t, i) {
  return (t.water?.[i] || 0) > WET_DEPTH;
}

export function isNavigableWater(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return false;
  return (t.water?.[tIdx(t, tx, ty)] || 0) >= NAVIGABLE_DEPTH;
}

function isNavigableWaterIdx(t, i) {
  return (t.water?.[i] || 0) >= NAVIGABLE_DEPTH;
}

function isDryOreCell(t, i) {
  return (t.type[i] === TT.LAND || t.type[i] === TT.HILL)
    && !waterBlocksLand(t, i)
    && !(t.lakeMask && t.lakeMask[i])
    && !(t.oil && t.oil[i] > 0);
}

// Liegt segelbares Wasser (See/Fluss) innerhalb von `radius` Tiles? (für Werften & Marine-Wegfindung)
export function hasWaterNear(t, tx, ty, radius = 4) {
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const nx = tx + x, ny = ty + y;
    if (inBounds(t, nx, ny) && isNavigableWaterIdx(t, tIdx(t, nx, ny))) return true;
  }
  return false;
}

// Nächste segelbare Wasserzelle zu einem Punkt (für Marine-Spawn & Angriffsziele am Wasser).
export function nearestWaterTile(t, tx, ty, radius = 8) {
  let best = null, bestD = Infinity;
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const nx = tx + x, ny = ty + y;
    if (!inBounds(t, nx, ny)) continue;
    if (!isNavigableWaterIdx(t, tIdx(t, nx, ny))) continue;
    const d = x * x + y * y;
    if (d < bestD) { bestD = d; best = [nx, ny]; }
  }
  return best;
}

// Effektive Deckung einer Zelle (natürlich oder gebaut), gedeckelt für Balance.
export function coverAt(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return 0;
  const i = tIdx(t, tx, ty);
  return Math.min(0.6, Math.max(t.cover[i], t.coverBuilt ? t.coverBuilt[i] : 0));
}

export function forestBlocks(t, domain, tx, ty, opts = null) {
  if ((domain !== 'land' && domain !== 'amphibious') || (opts && opts.category === 'infantry')) return false;
  if (!inBounds(t, tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  const inTunnel = t.tunnel && t.tunnel[i] > 0;
  return !inTunnel && t.cover && t.cover[i] >= 0.2;
}

// Ist die Zelle durch eine Befestigung (Wall) für Bodenbewegung blockiert?
export function isBlocked(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return false;
  return t.block && t.block[tIdx(t, tx, ty)] > 0;
}

// Befestigung in die Geländekarten stempeln (Deckung, Bewegungssperre, ggf. Wassersperre + Terraforming).
// terraform = Höhenänderung pro Zelle (Wall hebt > 0 / Graben senkt < 0). Verändert den Wasserlauf,
// da der Wasser-CA nach Oberflächenhöhe (height+water) fließt. Tatsächlich angewandtes Delta wird in
// terra[] kumuliert (für exaktes Rückgängigmachen trotz Clamping + Streaming an den Client).
export function stampFortification(t, tx, ty, size, cover, blocks, waterBlocks, terraform = 0, extra = {}) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = tx + x, ny = ty + y;
    if (!inBounds(t, nx, ny)) continue;
    const i = tIdx(t, nx, ny);
    if (cover) t.coverBuilt[i] = Math.max(t.coverBuilt[i], cover);
    if (blocks && t.block[i] < 255) t.block[i]++;
    if (waterBlocks && t.waterBlock[i] < 255) t.waterBlock[i]++;
    if (extra.bridge && t.bridge && t.bridge[i] < 255) t.bridge[i]++;
    if (extra.tunnel && t.tunnel && t.tunnel[i] < 255) t.tunnel[i]++;
    if (extra.road && t.roadBuilt && t.roadBuilt[i] < 255) { t.roadBuilt[i]++; t.roadDirty = true; }
    if (terraform) applyHeightDelta(t, i, terraform, true);
  }
  if (waterBlocks || terraform) wakeWaterAround(t, tx, ty, size); // Oberfläche/Stau geändert → Fluss neu berechnen
}

// Befestigung wieder entfernen (Zerstörung/Verkauf).
export function unstampFortification(t, tx, ty, size, cover, blocks, waterBlocks, terraform = 0, extra = {}) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = tx + x, ny = ty + y;
    if (!inBounds(t, nx, ny)) continue;
    const i = tIdx(t, nx, ny);
    if (cover) t.coverBuilt[i] = 0;
    if (blocks && t.block[i] > 0) t.block[i]--;
    if (waterBlocks && t.waterBlock[i] > 0) t.waterBlock[i]--;
    if (extra.bridge && t.bridge && t.bridge[i] > 0) t.bridge[i]--;
    if (extra.tunnel && t.tunnel && t.tunnel[i] > 0) t.tunnel[i]--;
    if (extra.road && t.roadBuilt && t.roadBuilt[i] > 0) { t.roadBuilt[i]--; t.roadDirty = true; }
    if (terraform) applyHeightDelta(t, i, terraform, false);
  }
  if (waterBlocks || terraform) wakeWaterAround(t, tx, ty, size); // Damm/Wall fällt → aufgestautes Wasser bricht durch
}

// Höhenänderung anwenden (add=true beim Bau, false beim Entfernen). t.terra[i] hält das aktuelle
// Gesamt-Delta gegenüber der Ausgangshöhe height0 — für Rückgängigmachen und Streaming an den Client.
// Exportiert: auch Erdbeben-Hangrutsche nutzen diesen Pfad (gleiches Tracking/Streaming).
export function applyHeightDelta(t, i, delta, add) {
  if (!t.terra) t.terra = new Float32Array(t.w * t.h);
  const hNew = Math.max(0.02, Math.min(MAX_HEIGHT, t.height[i] + (add ? delta : -delta)));
  t.height[i] = hNew;
  t.terra[i] = Math.abs(hNew - t.height0[i]) < 1e-4 ? 0 : hNew - t.height0[i];
  if (t.terraDirty) t.terraDirty.add(i);  // für Snapshot-Streaming markieren
}

// Wasser-CA in einem Umkreis reaktivieren (nach Bau/Zerstörung einer Wassersperre).
export function wakeWaterAround(t, tx, ty, size, pad = 2) {
  if (!t.waterActive) return;
  for (let y = -pad; y < size + pad; y++) for (let x = -pad; x < size + pad; x++) {
    const nx = tx + x, ny = ty + y;
    if (inBounds(t, nx, ny)) t.waterActive.add(tIdx(t, nx, ny));
  }
}

// Erzvorkommen zur Laufzeit stempeln (garantiertes Feld an jeder Startbasis). Bevorzugt
// Hangzellen (Erz steht am Hang an); auf völlig flachem Gelände wird normal gestempelt,
// damit die Startwirtschaft nie verhungert.
export function stampOre(t, cx, cy, r, amount = 1200) {
  const slope = (i) => {
    const x = i % t.w;
    let s = 0;
    if (x > 0) s = Math.max(s, Math.abs(t.height[i] - t.height[i - 1]));
    if (x < t.w - 1) s = Math.max(s, Math.abs(t.height[i] - t.height[i + 1]));
    if (i >= t.w) s = Math.max(s, Math.abs(t.height[i] - t.height[i - t.w]));
    if (i < t.w * (t.h - 1)) s = Math.max(s, Math.abs(t.height[i] - t.height[i + t.w]));
    return s;
  };
  let stamped = 0;
  for (const wantSlope of [true, false]) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const tx = cx + x, ty = cy + y;
      if (!inBounds(t, tx, ty)) continue;
      const d = Math.hypot(x, y);
      if (d > r) continue;
      const tt = t.type[tIdx(t, tx, ty)];
      if (tt !== TT.LAND && tt !== TT.HILL) continue;
      const i = tIdx(t, tx, ty);
      if (!isDryOreCell(t, i)) continue;
      if (wantSlope && slope(i) < 0.03) continue;
      if (t.ore[i] <= 0) t.oreList.push(i);
      t.ore[i] = Math.max(t.ore[i], (1 - d / r) * amount + 200);
      stamped++;
    }
    if (stamped >= 8) break;  // genug Hang-Erz gefunden → kein Flach-Fallback nötig
  }
}

export const tIdx = (t, tx, ty) => ty * t.w + tx;
export const inBounds = (t, tx, ty) => tx >= 0 && ty >= 0 && tx < t.w && ty < t.h;

// Liegt (irgendeine) Straße auf der Zelle? Auto-Netz ODER manuell gebaute Straße.
export const roadAtIdx = (t, i) => (t.road && t.road[i] > 0) || (t.roadBuilt && t.roadBuilt[i] > 0);

// Steigungsprüfung für einen Zellenübergang: Fahrzeuge schaffen nur begrenzte Hangneigung,
// auf Straßen (Serpentinen) deutlich mehr. maxSlope=Infinity (Infanterie hoch, Luft egal).
export function slopeOk(t, fromI, toI, maxSlope, roadLimit, terraformLimit) {
  if (maxSlope === Infinity) return true;
  const dh = Math.abs(t.height[toI] - t.height[fromI]);
  if (dh <= maxSlope) return true;
  if (terraformLimit != null
    && (Math.abs(t.terra?.[fromI] || 0) > 1e-5 || Math.abs(t.terra?.[toI] || 0) > 1e-5)
    && dh <= terraformLimit) return true;
  return roadLimit != null && roadAtIdx(t, toI) && roadAtIdx(t, fromI) && dh <= roadLimit;
}

export function tileType(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return TT.CLIFF;
  return t.type[tIdx(t, tx, ty)];
}

export function heightAt(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return 1;
  return t.height[tIdx(t, tx, ty)];
}

// Ist eine Zelle für eine Domäne passierbar?  domain: land|air|water|amphibious
// Nässe ist dynamisch (Wassertiefe): geflutetes Land sperrt Boden, trockengelegte Becken werden begehbar.
export function isPassable(t, domain, tx, ty, category) {
  if (!inBounds(t, tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  const ty_ = t.type[i];
  const wet = waterBlocksLand(t, i);
  const blocked = t.block && t.block[i] > 0; // Wall/Damm sperrt Boden, nicht aber Luft
  const onBridge = t.bridge && t.bridge[i] > 0;   // Brücke: Land quert Wasser (Schiffe fahren darunter durch)
  const inTunnel = t.tunnel && t.tunnel[i] > 0;   // Tunnel: Land quert Klippen
  // Fußsoldaten sind Kletterer: sie kommen auch über unwegsames Gelände (Klippen/Berge, verschneite
  // Gipfel) — nur nicht durch tiefes Wasser oder Sperren. Das gibt der Infanterie eine eigene Mobilität.
  const climber = category === 'infantry';
  switch (domain) {
    case 'air': return true;
    case 'water': return isNavigableWaterIdx(t, i) || ty_ === TT.BRIDGE || inTunnel; // Schiffe queren durch den Tunnel
    case 'amphibious': return (ty_ !== TT.CLIFF || inTunnel) && !blocked;
    case 'land':
    default: return (ty_ !== TT.CLIFF || inTunnel || climber) && (!wet || onBridge) && !blocked;
  }
}

export const worldToTile = (wx, wy) => [Math.floor(wx / TILE), Math.floor(wy / TILE)];
export const tileToWorld = (tx, ty) => [(tx + 0.5) * TILE, (ty + 0.5) * TILE];
