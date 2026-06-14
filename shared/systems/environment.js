// Umweltsystem (Phase 14): Tag/Nacht-Zyklus, Wetter (Regen/Gewitter), Blitzeinschläge,
// Erdbeben mit Hangrutschen. Deterministisch über world.rng — läuft identisch auf Server & Tests.
//
// world.env = {
//   dayT      0..1   Tagesfortschritt (0 = Mitternacht, 0.5 = Mittag)
//   daylight  0..1   Lichtanteil (0 nachts, 1 mittags; weiche Dämmerung)
//   weather   'clear' | 'fog' | 'rain' | 'storm' | 'drought'
//   weatherLeft      Sekunden bis zum nächsten Wetterwechsel
//   forecast  [{ weather, duration }] nächste Wetterphasen
//   solar     0..1   Solarertrag (Tageslicht × Wetterfaktor)
//   quake     null | { x, y, r, left }   aktives Beben (Weltkoordinaten, Tiles, Restsekunden)
//   timeMode  'auto' | 'day' | 'night'   Zuschauer-Fixierung für KI-Restspiele
// }
import {
  DT, TILE, DAY_LENGTH, LIGHTNING_MIN_GAP, LIGHTNING_DMG,
  QUAKE_INTERVAL, QUAKE_DURATION, QUAKE_RADIUS, QUAKE_SLOPE, QUAKE_SLIDE, QUAKE_BUILDING_DMG,
  RAIN_SLIDE_SLOPE, RAIN_SLIDE_CHANCE, RAIN_SLIDE_AMT,
  WAVE_DPS, STORM_AIR_DPS, SNOW_LINE, WATER_MAX_DEPTH, SEA_LEVEL,
  CLOUD_SEED_RADIUS, CLOUD_SEED_DURATION, CLOUD_SEED_RAIN_DEPTH,
  AVAL_SNOW, AVAL_SLOPE, AVAL_CHANCE, AVAL_DMG, AVAL_LEN, AVAL_ERODE, AVAL_DEPOSIT,
} from '../constants.js';
import { tIdx, inBounds, worldToTile, tileToWorld, applyHeightDelta, wakeWaterAround } from '../terrain.js';
import { applyDamage } from '../world.js';

export function initEnv(world) {
  world.env = {
    dayT: 0.35,               // Start am Vormittag — Spieler sieht erst Tag, dann erste Nacht
    daylight: 1, solar: 1,
    weather: 'clear', weatherLeft: 60 + world.rng() * 120,
    forecast: [],
    quake: null,
    _nextQuake: QUAKE_INTERVAL[0] + world.rng() * (QUAKE_INTERVAL[1] - QUAKE_INTERVAL[0]),
    _lightningCd: 0,
  };
  refillForecast(world, world.env.weather);
}

export function addRainCloud(world, x, y, opts = {}) {
  if (!world?.terrain || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const radius = Math.max(4, Number(opts.radius) || CLOUD_SEED_RADIUS);
  const duration = Math.max(2, Number(opts.duration) || CLOUD_SEED_DURATION);
  const rain = Math.max(0.0002, Number(opts.rain) || CLOUD_SEED_RAIN_DEPTH);
  const cloud = { x, y, r: radius, left: duration, rain, owner: opts.owner ?? null };
  (world.weatherClouds || (world.weatherClouds = [])).push(cloud);
  world.events.push({ type: 'rain_cloud', x, y, r: radius, duration, owner: cloud.owner });
  return true;
}

export function stepEnvironment(world) {
  if (!world.env) initEnv(world);
  const env = world.env;

  // --- Tag/Nacht ---
  const timeMode = world.controls?.timeMode || env.timeMode || 'auto';
  env.timeMode = timeMode;
  if (timeMode === 'day') env.dayT = 0.5;
  else if (timeMode === 'night') env.dayT = 0;
  else env.dayT = (env.dayT + DT / DAY_LENGTH) % 1;
  // Breite Dämmerung: nicht sprunghaft von hell auf dunkel, sondern über mehrere Spielstunden.
  const s = Math.sin(env.dayT * Math.PI * 2 - Math.PI / 2); // -1 Mitternacht … +1 Mittag
  const tw = Math.max(0, Math.min(1, (s + 0.62) / 1.20));
  env.daylight = tw * tw * (3 - 2 * tw);

  // --- Wetter-Zustandsautomat (clear / fog / rain / storm / drought) ---
  env.weatherLeft -= DT;
  if (env.weatherLeft <= 0) {
    refillForecast(world, env.weather);
    const next = env.forecast.shift();
    env.weather = next.weather;
    env.weatherLeft = next.duration;
    refillForecast(world, env.weather);
    world.events.push({ type: 'weather', weather: env.weather });
  }

  // Solarertrag: nachts 0; Nebel/Regen/Gewitter drosseln zunehmend.
  const wf = (env.weather === 'clear' || env.weather === 'drought') ? 1 : env.weather === 'fog' ? 0.45 : env.weather === 'rain' ? 0.2 : 0.08;
  env.solar = env.daylight * wf;

  stepRainClouds(world);

  // Gewitter-Risiken je Domäne: Wellengang beschädigt Überwasserschiffe (getauchte U-Boote
  // sind sicher!), Sturmböen zerren an Luftfahrzeugen — Wetter bestimmt die Einheitenwahl.
  if (env.weather === 'storm') {
    for (const e of world.entities.values()) {
      if (e.etype !== 'unit' || e.dead) continue;
      if ((e.domain === 'water' || e.domain === 'amphibious') && !e.submerged) {
        applyDamage(world, e, WAVE_DPS * DT, null);
      } else if (e.domain === 'air') {
        applyDamage(world, e, STORM_AIR_DPS * DT, null);
      }
    }
  }

  // Schneelawinen: bei (Neu-)Schneelast prüfen — Schneefall (Regenwetter über der Schneegrenze)
  // erhöht die Auslösewahrscheinlichkeit deutlich.
  if ((world.tick % 20) === 0) checkAvalanches(world, (env.weather === 'clear' || env.weather === 'drought') ? 1 : 5);
  if ((env.weather === 'rain' || env.weather === 'storm') && (world.tick % 10) === 0) {
    checkRainSlides(world, env.weather === 'storm' ? 1.8 : 1);
  }

  // --- Blitzeinschläge bei Gewitter: treffen bevorzugt HOCH liegende Objekte ---
  if (env.weather === 'storm') {
    env._lightningCd -= DT;
    if (env._lightningCd <= 0) {
      env._lightningCd = LIGHTNING_MIN_GAP + world.rng() * 4;
      strikeLightning(world);
    }
  }

  // --- Erdbeben ---
  if (env.quake) {
    env.quake.left -= DT;
    quakeTick(world, env.quake);
    if (env.quake.left <= 0) env.quake = null;
  } else {
    env._nextQuake -= DT;
    if (env._nextQuake <= 0) {
      env._nextQuake = QUAKE_INTERVAL[0] + world.rng() * (QUAKE_INTERVAL[1] - QUAKE_INTERVAL[0]);
      startQuake(world);
    }
  }
}

function stepRainClouds(world) {
  const clouds = world.weatherClouds;
  const t = world.terrain;
  if (!clouds || !clouds.length || !t?.water) return;
  const live = [];
  for (const c of clouds) {
    c.left -= DT;
    const [cx, cy] = worldToTile(c.x, c.y);
    const tileR = Math.ceil(c.r / TILE);
    for (let dy = -tileR; dy <= tileR; dy++) for (let dx = -tileR; dx <= tileR; dx++) {
      const tx = cx + dx, ty = cy + dy;
      if (!inBounds(t, tx, ty)) continue;
      const wx = (tx + 0.5) * TILE, wy = (ty + 0.5) * TILE;
      const d = Math.hypot(wx - c.x, wy - c.y);
      if (d > c.r) continue;
      const i = tIdx(t, tx, ty);
      if (t.waterBlock?.[i] > 0 || t.height[i] <= SEA_LEVEL) continue;
      const falloff = 1 - d / c.r;
      const amount = c.rain * (0.35 + falloff * 0.8);
      t.water[i] = Math.min(WATER_MAX_DEPTH, t.water[i] + amount);
      if (t.waterActive) t.waterActive.add(i);
    }
    wakeWaterAround(t, cx, cy, 1, Math.max(2, tileR + 1));
    if (c.left > 0) live.push(c);
  }
  world.weatherClouds = live;
}

function nextWeather(world, from) {
  const r = world.rng();
  if (from === 'clear') {
    if (r < 0.10) return { weather: 'drought', duration: 180 + world.rng() * 180 };
    const weather = r < 0.32 ? 'fog' : r < 0.59 ? 'storm' : 'rain';
    const duration = weather === 'fog' ? 35 + world.rng() * 45 : 30 + world.rng() * 50;
    return { weather, duration };
  }
  if (from === 'drought') {
    const weather = r < 0.55 ? 'rain' : r < 0.78 ? 'storm' : 'clear';
    const duration = weather === 'rain' ? 45 + world.rng() * 70 : weather === 'storm' ? 25 + world.rng() * 45 : 60 + world.rng() * 90;
    return { weather, duration };
  }
  if (from === 'rain') {
    const weather = r < 0.3 ? 'storm' : 'clear';
    const duration = weather === 'storm' ? 20 + world.rng() * 30 : 90 + world.rng() * 150;
    return { weather, duration };
  }
  if (from === 'fog') {
    const weather = r < 0.25 ? 'rain' : 'clear';
    const duration = weather === 'rain' ? 25 + world.rng() * 35 : 90 + world.rng() * 150;
    return { weather, duration };
  }
  const weather = r < 0.4 ? 'rain' : 'clear';
  const duration = weather === 'rain' ? 20 + world.rng() * 40 : 90 + world.rng() * 150;
  return { weather, duration };
}

function refillForecast(world, current) {
  const f = world.env.forecast || (world.env.forecast = []);
  let from = f.length ? f[f.length - 1].weather : current;
  while (f.length < 3) {
    const next = nextWeather(world, from);
    f.push(next);
    from = next.weather;
  }
}

// Blitz: aus einer deterministischen Stichprobe der Entities das am höchsten gelegene Ziel wählen
// (Geländehöhe + Objekthöhe; Luftfahrzeuge sind extrem exponiert). Ohne Treffer schlägt der Blitz
// in eine zufällige hohe Geländezelle ein (nur Effekt).
function strikeLightning(world) {
  const t = world.terrain;
  const ents = [...world.entities.values()].filter(e => !e.dead && e.hp > 0);
  let best = null, bestH = -Infinity;
  const sample = Math.min(16, ents.length);
  for (let k = 0; k < sample; k++) {
    const e = ents[(world.rng() * ents.length) | 0];
    const [tx, ty] = worldToTile(e.x, e.y);
    if (!inBounds(t, tx, ty)) continue;
    let hgt = t.height[tIdx(t, tx, ty)] * 14;
    if (e.etype === 'building') hgt += 2 + (e.size || 1) * 1.6;     // Gebäudehöhe
    else if (e.domain === 'air') hgt += 9;                          // Flughöhe — Blitzfänger
    else hgt += 1;
    if (hgt > bestH) { bestH = hgt; best = e; }
  }
  if (best) {
    applyDamage(world, best, LIGHTNING_DMG, null);
    world.events.push({ type: 'lightning', x: best.x, y: best.y, hit: true });
  } else {
    // Kein Ziel: Einschlag in zufälliger Geländezelle (visueller Effekt).
    const i = (world.rng() * t.w * t.h) | 0;
    const [wx, wy] = tileToWorld(i % t.w, (i / t.w) | 0);
    world.events.push({ type: 'lightning', x: wx, y: wy, hit: false });
  }
}

// Lawinenprüfung: zufällige Schneezellen — liegt genug Schnee an einem steilen Hang, geht
// eine Lawine ab: Schneemasse rauscht den steilsten Abstieg hinunter, beschädigt alles im
// Pfad und lagert unten Schmelzwasser ab. `boost` erhöht die Chance (Schneefall/Erdbeben).
export function checkAvalanches(world, boost = 1) {
  const t = world.terrain;
  if (!t.snow || !t.snowIdx || !t.snowIdx.length) return;
  const tries = 32;
  for (let k = 0; k < tries; k++) {
    const i = t.snowIdx[(world.rng() * t.snowIdx.length) | 0];
    if (t.snow[i] < AVAL_SNOW) continue;
    if (world.rng() > AVAL_CHANCE * boost) continue;
    const low = lowestNeighbor(t, i, null);
    if (low < 0 || t.height[i] - t.height[low] < AVAL_SLOPE) continue;
    triggerAvalanche(world, i);
  }
}

function triggerAvalanche(world, start) {
  const t = world.terrain;
  let mass = t.snow[start];
  t.snow[start] = 0;
  applyHeightDelta(t, start, Math.min(AVAL_ERODE * mass, 0.04), false);
  // Pfad: steilster 8er-Abstieg bis zu AVAL_LEN Zellen oder bis der Hang ausläuft.
  const path = [start];
  let cur = start;
  for (let s = 0; s < AVAL_LEN; s++) {
    const low = lowestNeighbor(t, cur, path);
    if (low < 0 || t.height[cur] - t.height[low] < 0.008) break;
    cur = low;
    path.push(cur);
    if (t.snow[cur] > 0) {
      mass += t.snow[cur] * 0.35;
      t.snow[cur] *= 0.35;                         // reißt Schnee unterwegs mit
    }
    if (s < AVAL_LEN * 0.58) applyHeightDelta(t, cur, Math.min(AVAL_ERODE * mass * 0.35, 0.018), false);
  }
  // Schaden an allem im Pfad + Schmelzwasser am Auslauf; Wasser-CA wecken.
  const coords = [];
  for (let p = 0; p < path.length; p++) {
    const i = path[p];
    const px = (i % t.w), py = (i / t.w) | 0;
    coords.push(Math.round((px + 0.5) * TILE), Math.round((py + 0.5) * TILE));
    for (const e of world.entities.values()) {
      if (e.dead || e.domain === 'air') continue;
      const [etx, ety] = worldToTile(e.x, e.y);
      if (etx === px && ety === py) applyDamage(world, e, AVAL_DMG * (e.etype === 'building' ? 0.7 : 1), null);
    }
    if (p >= path.length - 5) {                    // Auslaufzone: Schnee/Schutt lagert an
      applyHeightDelta(t, i, Math.min(AVAL_DEPOSIT * mass, 0.035), true);
      t.water[i] = Math.min(WATER_MAX_DEPTH, t.water[i] + mass * 0.15);
      if (t.waterActive) t.waterActive.add(i);
    }
  }
  wakeWaterAround(t, start % t.w, (start / t.w) | 0, 1, AVAL_LEN);
  world.events.push({ type: 'avalanche', x: coords[0], y: coords[1], path: coords });
}

export function checkRainSlides(world, boost = 1) {
  const t = world.terrain;
  const tries = 56;
  let slid = 0, ev = null;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (i) => {
    if (i < 0 || i >= t.w * t.h || seen.has(i)) return;
    seen.add(i);
    candidates.push(i);
  };
  if (t.waterActive) {
    for (const i of t.waterActive) {
      addCandidate(i);
      const x = i % t.w, y = (i / t.w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (inBounds(t, nx, ny)) addCandidate(tIdx(t, nx, ny));
      }
      if (candidates.length >= 180) break;
    }
  }
  for (let k = 0; k < tries; k++) addCandidate((world.rng() * t.w * t.h) | 0);
  for (const i of candidates) {
    if (t.height[i] > SNOW_LINE) continue; // Schneehänge werden über Lawinen behandelt
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    const bias = waterSlideBias(t, i, low);
    const slope = t.height[i] - t.height[low];
    const threshold = RAIN_SLIDE_SLOPE * (bias.flowing ? 0.78 : 1);
    if (slope <= threshold) continue;
    if (!bias.wet && world.rng() > 0.30) continue;
    const chance = RAIN_SLIDE_CHANCE * boost
      * Math.min(6.0, (1 + slope * 8) * (bias.wet ? 1.35 : 0.45) + bias.flow * 30);
    if (world.rng() > chance) continue;
    const len = bias.wet ? 3 + Math.min(5, Math.floor(bias.flow * 34)) : 2;
    if (slideCell(world, i, low, threshold, RAIN_SLIDE_AMT, 0.04, len)) {
      slid++;
      if (!ev) {
        const [wx, wy] = tileToWorld(i % t.w, (i / t.w) | 0);
        ev = { type: 'rockfall', x: wx, y: wy, count: 1 };
      } else ev.count++;
    }
  }
  if (slid && ev) world.events.push(ev);
}

function waterSlideBias(t, high, low) {
  const d0 = t.water?.[high] || 0;
  const d1 = t.water?.[low] || 0;
  const surfaceDrop = Math.max(0, (t.height[high] + d0) - (t.height[low] + d1));
  const wet = d0 > 0.012 || d1 > 0.012 || !!(t.waterActive && (t.waterActive.has(high) || t.waterActive.has(low)));
  return {
    wet,
    flowing: wet && surfaceDrop > 0.018,
    flow: wet ? Math.min(0.18, surfaceDrop) : 0,
  };
}

function lowestNeighbor(t, i, seen) {
  const x = i % t.w, y = (i / t.w) | 0;
  let low = -1, lowH = t.height[i];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (!inBounds(t, nx, ny)) continue;
    const j = ny * t.w + nx;
    if (seen && seen.includes(j)) continue;
    if (t.height[j] < lowH) { lowH = t.height[j]; low = j; }
  }
  return low;
}

function slideCell(world, high, low, threshold, mult, cap, maxLen = 1) {
  const t = world.terrain;
  const path = [high];
  let moved = false;
  let curHigh = high, curLow = low;
  const steps = Math.max(1, maxLen | 0);
  for (let step = 0; step < steps; step++) {
    if (curLow < 0) break;
    const localThreshold = threshold * (step === 0 ? 1 : 0.72);
    const slope = t.height[curHigh] - t.height[curLow];
    if (slope <= localThreshold) break;
    const falloff = Math.max(0.35, 1 - step * 0.13);
    const a = Math.min(cap * falloff, (slope - localThreshold) * mult * falloff);
    if (a <= 0) break;
    applyHeightDelta(t, curHigh, a, false);
    applyHeightDelta(t, curLow, a * (step === steps - 1 ? 0.90 : 0.64), true);
    if (t.water[curHigh] > 0) {
      const wash = Math.min(t.water[curHigh] * (0.44 - Math.min(0.18, step * 0.04)), WATER_MAX_DEPTH - t.water[curLow]);
      if (wash > 0) { t.water[curHigh] -= wash; t.water[curLow] += wash; }
    }
    if (t.waterActive) { t.waterActive.add(curHigh); t.waterActive.add(curLow); }
    path.push(curLow);
    moved = true;
    curHigh = curLow;
    curLow = lowestNeighbor(t, curHigh, path);
  }
  if (!moved) return false;
  damageSlidePath(world, path);
  let minX = t.w, minY = t.h, maxX = 0, maxY = 0;
  for (const i of path) {
    const x = i % t.w, y = (i / t.w) | 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  wakeWaterAround(t, minX, minY, Math.max(1, maxX - minX + 1), Math.max(2, maxY - minY + 2));
  pushSlideEvent(world, path);
  return true;
}

function damageSlidePath(world, path) {
  const t = world.terrain;
  const impacted = new Set();
  for (const e of world.entities.values()) {
    if (e.dead || e.domain === 'air') continue;
    const [etx, ety] = worldToTile(e.x, e.y);
    for (const i of path) {
      const x = i % t.w, y = (i / t.w) | 0;
      if ((etx === x && ety === y)
        || (e.etype === 'building' && etx >= x - 1 && etx <= x + 1 && ety >= y - 1 && ety <= y + 1)) {
        if (!impacted.has(e.id)) {
          impacted.add(e.id);
          applyDamage(world, e, QUAKE_BUILDING_DMG * DT * (e.etype === 'building' ? 1 : 0.6), null);
        }
        break;
      }
    }
  }
}

function pushSlideEvent(world, path) {
  if (world._slideFxTick !== world.tick) {
    world._slideFxTick = world.tick;
    world._slideFxCount = 0;
  }
  if (world._slideFxCount >= 6) return;
  const t = world.terrain;
  const coords = [];
  for (const i of path) {
    const [wx, wy] = tileToWorld(i % t.w, (i / t.w) | 0);
    coords.push(wx, wy);
  }
  world._slideFxCount++;
  world.events.push({ type: 'landslide', x: coords[0], y: coords[1], path: coords });
}

function startQuake(world) {
  const t = world.terrain;
  const tx = 8 + ((world.rng() * (t.w - 16)) | 0);
  const ty = 8 + ((world.rng() * (t.h - 16)) | 0);
  const [wx, wy] = tileToWorld(tx, ty);
  world.env.quake = { x: wx, y: wy, tx, ty, r: QUAKE_RADIUS, left: QUAKE_DURATION, fissureDone: false, burstDone: false };
  world.events.push({ type: 'quake', x: wx, y: wy, r: QUAKE_RADIUS * TILE, start: true });
}

// Ein Beben-Tick: Hangrutsche im Radius — Material rutscht von steilen Zellen zum tiefsten Nachbarn.
// Höhenänderungen laufen über applyHeightDelta → terra[]/terraDirty → Client-Streaming; Wasser-CA
// wird geweckt (Rutsche können Flüsse umleiten oder Becken anstechen).
function quakeTick(world, q) {
  const t = world.terrain;
  const { w, h } = t;
  if (!q.fissureDone) {
    q.fissureDone = true;
    carveQuakeFissure(world, q);
  }
  if (!q.burstDone) {
    q.burstDone = true;
    triggerQuakeSlideBurst(world, q, Math.max(4, Math.round(q.r / 4)));
  }
  let slid = 0;
  // Deterministische Stichprobe von Zellen im Radius prüfen (nicht alle — Beben "rüttelt" über Zeit).
  const tries = 90;
  for (let k = -1; k < tries; k++) {
    const dx = k < 0 ? 0 : ((world.rng() * 2 - 1) * q.r) | 0;
    const dy = k < 0 ? 0 : ((world.rng() * 2 - 1) * q.r) | 0;
    if (k >= 0 && dx * dx + dy * dy > q.r * q.r) continue;
    const cx = q.tx + dx, cy = q.ty + dy;
    if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) continue;
    const i = cy * w + cx;
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    if (slideCell(world, i, low, QUAKE_SLOPE, QUAKE_SLIDE, 0.05)) slid++;
  }
  if (slid) wakeWaterAround(t, q.tx - q.r, q.ty - q.r, q.r * 2);
  // Beben in Bergnähe lösen Schneelawinen aus (neben den normalen Hangrutschen).
  if (t.snow && (world.tick % 5) === 0) checkAvalanches(world, 40);
  world.events.push({ type: 'quake', x: q.x, y: q.y, r: q.r * TILE, left: Math.max(0, q.left) });
}

function triggerQuakeSlideBurst(world, q, wanted) {
  const t = world.terrain;
  const candidates = [];
  const minX = Math.max(1, q.tx - q.r), maxX = Math.min(t.w - 2, q.tx + q.r);
  const minY = Math.max(1, q.ty - q.r), maxY = Math.min(t.h - 2, q.ty + q.r);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const dx = x - q.tx, dy = y - q.ty;
    if (dx * dx + dy * dy > q.r * q.r) continue;
    const i = y * t.w + x;
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    const slope = t.height[i] - t.height[low];
    if (slope > QUAKE_SLOPE * 0.72) candidates.push([slope, i, low]);
  }
  candidates.sort((a, b) => b[0] - a[0]);
  let done = 0;
  for (const [, i, low] of candidates) {
    if (done >= wanted) break;
    if (slideCell(world, i, low, QUAKE_SLOPE * 0.62, QUAKE_SLIDE * 1.45, 0.065)) done++;
  }
}

function carveQuakeFissure(world, q) {
  const t = world.terrain;
  const len = Math.max(6, Math.round(Math.max(t.w, t.h) * 0.10));
  const angle = Math.atan2(q.ty + 0.5 - t.h / 2, q.tx + 0.5 - t.w / 2) + (world.rng() - 0.5) * 0.55;
  const ax = Math.cos(angle), ay = Math.sin(angle);
  const sx = -ay, sy = ax;
  const phase = world.rng() * Math.PI * 2;
  const coords = [];
  let touchedWater = false;
  const maxR = Math.hypot(t.w / 2, t.h / 2);
  for (let s = 0; s <= len; s++) {
    const wobble = Math.sin(s * 0.55 + phase) * 1.2 + (world.rng() - 0.5) * 0.55;
    const cx = Math.round(q.tx + ax * s + sx * wobble);
    const cy = Math.round(q.ty + ay * s + sy * wobble);
    if (!inBounds(t, cx, cy)) continue;
    for (let side = -1; side <= 1; side++) {
      const x = Math.round(cx + sx * side), y = Math.round(cy + sy * side);
      if (!inBounds(t, x, y)) continue;
      const i = tIdx(t, x, y);
      const rn = Math.min(1, Math.hypot(x + 0.5 - t.w / 2, y + 0.5 - t.h / 2) / maxR);
      const floor = Math.max(SEA_LEVEL + 0.025, 0.82 - rn * 0.58 + Math.abs(side) * 0.025);
      const depth = Math.max(side === 0 ? 0.105 : 0.045, t.height[i] - floor);
      applyHeightDelta(t, i, depth, false);
      if (t.water[i] > 0.01 || t.height[i] < SEA_LEVEL) touchedWater = true;
      if (t.waterActive) t.waterActive.add(i);
    }
    const i = tIdx(t, cx, cy);
    coords.push(Math.round((cx + 0.5) * TILE), Math.round((cy + 0.5) * TILE));
  }
  for (let n = 0; n < coords.length; n += 2) wakeWaterAround(t, Math.floor(coords[n] / TILE), Math.floor(coords[n + 1] / TILE), 1, 2);
  if (touchedWater) {
    for (let n = 0; n < coords.length; n += 2) {
      const tx = Math.floor(coords[n] / TILE), ty = Math.floor(coords[n + 1] / TILE);
      const i = tIdx(t, tx, ty);
      if (inBounds(t, tx, ty) && t.height[i] < SEA_LEVEL) {
        t.water[i] = Math.min(WATER_MAX_DEPTH, Math.max(t.water[i], Math.min(0.12, SEA_LEVEL - t.height[i])));
        if (t.waterActive) t.waterActive.add(i);
      }
    }
  }
  if (coords.length >= 4) world.events.push({ type: 'landslide', x: coords[0], y: coords[1], path: coords });
}
