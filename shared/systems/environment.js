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
  WAVE_DPS, STORM_AIR_DPS, SNOW_LINE, WATER_MAX_DEPTH, SEA_LEVEL, WET_DEPTH,
  CLOUD_SEED_RADIUS, CLOUD_SEED_DURATION, CLOUD_SEED_RAIN_DEPTH,
  AVAL_SNOW, AVAL_SLOPE, AVAL_CHANCE, AVAL_LEN, AVAL_ERODE, AVAL_DEPOSIT,
} from '../constants.js';
import { tIdx, inBounds, worldToTile, tileToWorld, applyHeightDelta, wakeWaterAround } from '../terrain.js';
import { applyDamage } from '../world.js';

const NATURAL_SLIDE_TICKS = 300;          // gelegentliche trockene Hangrutsche (~30 s)
const NATURAL_SLIDE_TRIES = 42;
const NATURAL_SLIDE_CHANCE = 0.010;
const NATURAL_SLIDE_SLOPE = 0.052;
const SLIDE_ENTITY_DRAG = 0.58;           // Anteil eines Tiles, den der bewegte Hang mitnimmt
const SLIDE_UNIT_DMG = 44;
const SLIDE_BUILDING_DMG = 155;
const SLIDE_SHEAR_DMG = 420;
const SLIDE_INFRA_DMG = 980;
const ROCK_ROLL_MAX_PER_QUAKE = 7;      // harte Obergrenze: gefährlich, aber kein Karten-Wipe
const ROCK_ROLL_TRIES = 64;
const ROCK_ROLL_MIN_SLOPE = 0.034;
const ROCK_ROLL_LEN = 18;
const ROCK_ROLL_DMG = 4200;
const ROCK_WAVE_STRENGTH = 0.13;
const ROCK_WAVE_SPREAD = 8;
const SLIDE_WAVE_STRENGTH = 0.085;
const SLIDE_WAVE_SPREAD = 7;
const SLIDE_WAVE_MIN_SEVERITY = 1.05;
const SLIDE_WAVE_MAX_PER_TICK = 2;
const HAZARD_BIAS_TICKS = 50;            // Stärke-Ziel nur günstig periodisch neu schätzen
const HAZARD_BIAS_RADIUS = 34;           // Tiles um den stärkeren Spieler mit höherer Event-Dichte
const SPECTATOR_EVENT_DURATION = 75;     // Sekunden für manuell ausgelöste Wetterphasen
const SPECTATOR_EVENTS = new Set(['rain', 'drought', 'landslide', 'quake', 'storm', 'fog']);
const INSANITY_DEFAULT = 2;
const INSANITY_PROFILES = {
  1: {
    weatherDuration: 1.75, rainWeather: 0.55, stormWeather: 0.24, droughtWeather: 0.45, fogWeather: 1.15,
    rain: 0.48, rainInflow: 0.45, floodCap: 0.45, sourceSurge: 0.62, startMelt: 0.60,
    cloudRadius: 0.8, cloudDuration: 0.8, slide: 0.48, slideThreshold: 1.28,
    slideMass: 0.62, slideLength: 0.62, damage: 0.64, lightningGap: 2.1, lightningDamage: 0.62,
    quakeGap: 2.7, quakeRadius: 0.62, quakeDuration: 0.55, quakeSlope: 1.42, quakeSlide: 0.38,
    eventRate: 0.36, rockRate: 0.28,
  },
  2: {
    weatherDuration: 1.18, rainWeather: 0.78, stormWeather: 0.62, droughtWeather: 1, fogWeather: 1,
    rain: 0.76, rainInflow: 0.72, floodCap: 0.68, sourceSurge: 0.82, startMelt: 0.78,
    cloudRadius: 0.92, cloudDuration: 0.92, slide: 0.82, slideThreshold: 1.12,
    slideMass: 0.86, slideLength: 0.82, damage: 0.9, lightningGap: 1.28, lightningDamage: 0.86,
    quakeGap: 1.65, quakeRadius: 0.78, quakeDuration: 0.72, quakeSlope: 1.22, quakeSlide: 0.62,
    eventRate: 0.62, rockRate: 0.55,
  },
  3: {
    weatherDuration: 0.68, rainWeather: 1.35, stormWeather: 1.85, droughtWeather: 1.35, fogWeather: 0.75,
    rain: 1.35, rainInflow: 1, floodCap: 1, sourceSurge: 1, startMelt: 1,
    cloudRadius: 1.15, cloudDuration: 1.1, slide: 1.65, slideThreshold: 0.88,
    slideMass: 1.25, slideLength: 1.25, damage: 1.3, lightningGap: 0.65, lightningDamage: 1.35,
    quakeGap: 0.62, quakeRadius: 1.16, quakeDuration: 1.15, quakeSlope: 0.9, quakeSlide: 1.25,
    eventRate: 1.65, rockRate: 1.45,
  },
  4: {
    weatherDuration: 0.42, rainWeather: 1.9, stormWeather: 3.2, droughtWeather: 1.8, fogWeather: 0.45,
    rain: 1.9, rainInflow: 1.25, floodCap: 1.25, sourceSurge: 1.18, startMelt: 1.12,
    cloudRadius: 1.35, cloudDuration: 1.25, slide: 2.6, slideThreshold: 0.76,
    slideMass: 1.65, slideLength: 1.55, damage: 1.75, lightningGap: 0.38, lightningDamage: 1.85,
    quakeGap: 0.34, quakeRadius: 1.42, quakeDuration: 1.35, quakeSlope: 0.78, quakeSlide: 1.75,
    eventRate: 2.55, rockRate: 2.1,
  },
};

export function normalizeInsanityLevel(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return INSANITY_DEFAULT;
  return Math.max(1, Math.min(4, n));
}

export function setInsanityLevel(world, value) {
  const level = normalizeInsanityLevel(value);
  if (!world) return level;
  (world.controls || (world.controls = {})).insanity = level;
  if (world.env) world.env.insanity = level;
  return level;
}

function insanityLevel(world) {
  return normalizeInsanityLevel(world?.env?.insanity ?? world?.controls?.insanity ?? INSANITY_DEFAULT);
}

export function insanityProfile(world) {
  return INSANITY_PROFILES[insanityLevel(world)] || INSANITY_PROFILES[INSANITY_DEFAULT];
}

function scaledWeatherDuration(world, duration) {
  return Math.max(8, duration * insanityProfile(world).weatherDuration);
}

function nextQuakeDelay(world) {
  const p = insanityProfile(world);
  return (QUAKE_INTERVAL[0] + world.rng() * (QUAKE_INTERVAL[1] - QUAKE_INTERVAL[0])) * p.quakeGap;
}

function scaledCount(value, factor, min = 1) {
  return Math.max(min, Math.round(value * factor));
}

export function initEnv(world) {
  const insanity = setInsanityLevel(world, world.controls?.insanity ?? INSANITY_DEFAULT);
  world.env = {
    dayT: 0.35,               // Start am Vormittag — Spieler sieht erst Tag, dann erste Nacht
    daylight: 1, solar: 1,
    weather: 'clear', weatherLeft: scaledWeatherDuration(world, 60 + world.rng() * 120),
    forecast: [],
    quake: null,
    insanity,
    _nextQuake: nextQuakeDelay(world),
    _lightningCd: 0,
  };
  refillForecast(world, world.env.weather);
}

export function triggerSpectatorEvent(world, type) {
  if (!SPECTATOR_EVENTS.has(type)) return false;
  if (!world.env) initEnv(world);
  updateHazardBias(world, true);
  switch (type) {
    case 'rain':
      forceWeather(world, 'rain', SPECTATOR_EVENT_DURATION);
      spawnBiasedRainClouds(world, 3, 1.25);
      return true;
    case 'drought':
      forceWeather(world, 'drought', SPECTATOR_EVENT_DURATION * 2.2);
      return true;
    case 'landslide':
      return triggerBiasedLandslide(world);
    case 'quake':
      startQuake(world, { target: biasedRandomTile(world, 20) });
      return true;
    case 'storm':
      forceWeather(world, 'storm', SPECTATOR_EVENT_DURATION * 0.85);
      spawnBiasedRainClouds(world, 2, 1.75);
      world.env._lightningCd = 0;
      return true;
    case 'fog':
      forceWeather(world, 'fog', SPECTATOR_EVENT_DURATION);
      return true;
    default:
      return false;
  }
}

function forceWeather(world, weather, duration) {
  const env = world.env;
  env.weather = weather;
  env.weatherLeft = Math.max(5, duration);
  env.forecast = [];
  refillForecast(world, weather);
  world.events.push({ type: 'weather', weather });
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
  setInsanityLevel(world, world.controls?.insanity ?? env.insanity ?? INSANITY_DEFAULT);
  const profile = insanityProfile(world);
  updateHazardBias(world);

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
        applyDamage(world, e, WAVE_DPS * DT * profile.damage, null);
      } else if (e.domain === 'air') {
        applyDamage(world, e, STORM_AIR_DPS * DT * profile.damage, null);
      }
    }
  }

  // Schneelawinen: bei (Neu-)Schneelast prüfen — Schneefall (Regenwetter über der Schneegrenze)
  // erhöht die Auslösewahrscheinlichkeit deutlich.
  if ((world.tick % 20) === 0) checkAvalanches(world, ((env.weather === 'clear' || env.weather === 'drought') ? 1 : 5) * profile.slide);
  if ((env.weather === 'rain' || env.weather === 'storm') && (world.tick % 10) === 0) {
    checkRainSlides(world, (env.weather === 'storm' ? 1.8 : 1) * profile.slide);
  }
  if ((world.tick % Math.max(45, Math.round(NATURAL_SLIDE_TICKS / profile.eventRate))) === 0) checkNaturalSlopeSlides(world);

  // --- Blitzeinschläge bei Gewitter: treffen bevorzugt HOCH liegende Objekte ---
  if (env.weather === 'storm') {
    env._lightningCd -= DT;
    if (env._lightningCd <= 0) {
      env._lightningCd = (LIGHTNING_MIN_GAP + world.rng() * 4) * profile.lightningGap;
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
      env._nextQuake = nextQuakeDelay(world);
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
      const amount = c.rain * (0.35 + falloff * 0.8) * hazardRainMultiplier(world, tx, ty) * insanityProfile(world).rain;
      t.water[i] = Math.min(WATER_MAX_DEPTH, t.water[i] + amount);
      if (t.waterActive) t.waterActive.add(i);
    }
    wakeWaterAround(t, cx, cy, 1, Math.max(2, tileR + 1));
    if (c.left > 0) live.push(c);
  }
  world.weatherClouds = live;
}

function spawnBiasedRainClouds(world, count, intensity = 1) {
  const t = world.terrain;
  if (!t) return;
  const profile = insanityProfile(world);
  for (let n = 0; n < count; n++) {
    const tile = biasedRandomTile(world, 18 + n * 6);
    const [wx, wy] = tileToWorld(tile.tx, tile.ty);
    addRainCloud(world, wx, wy, {
      radius: CLOUD_SEED_RADIUS * (1.15 + n * 0.16) * profile.cloudRadius,
      duration: CLOUD_SEED_DURATION * (1.2 + n * 0.12) * profile.cloudDuration,
      rain: CLOUD_SEED_RAIN_DEPTH * intensity * profile.rain,
      owner: -1,
    });
  }
}

function updateHazardBias(world, force = false) {
  const env = world.env;
  if (!env || !world.terrain) return null;
  if (!force && env._hazardBiasTick != null && world.tick - env._hazardBiasTick < HAZARD_BIAS_TICKS) return env._hazardBias || null;
  env._hazardBiasTick = world.tick;
  env._hazardBias = selectHazardBias(world);
  return env._hazardBias;
}

function selectHazardBias(world) {
  const live = world.players.filter(p => !p.defeated);
  if (!live.length) return null;
  const scored = live.map(p => ({ player: p, score: playerHazardScore(world, p) }));
  const min = Math.min(...scored.map(s => s.score));
  let total = 0;
  for (const s of scored) {
    s.weight = Math.max(0.2, (s.score - min) + s.score * 0.24) ** 1.25;
    total += s.weight;
  }
  let pick = world.rng() * total;
  let chosen = scored[scored.length - 1];
  for (const s of scored) {
    pick -= s.weight;
    if (pick <= 0) { chosen = s; break; }
  }
  const c = playerCenter(world, chosen.player.id);
  const t = world.terrain;
  const mapCx = t.w / 2, mapCy = t.h / 2;
  let sideX = c.tx - mapCx, sideY = c.ty - mapCy;
  const len = Math.hypot(sideX, sideY) || 1;
  sideX /= len; sideY /= len;
  return { owner: chosen.player.id, score: chosen.score, tx: c.tx, ty: c.ty, x: c.x, y: c.y, sideX, sideY, radius: HAZARD_BIAS_RADIUS };
}

function playerHazardScore(world, player) {
  let score = 1;
  const r = player.resources || {};
  score += (r.ore || 0) * 0.012 + (r.materials || 0) * 0.010 + (r.oil || 0) * 0.010
    + (r.fuel || 0) * 0.006 + (r.ammo || 0) * 0.004 + (r.water || 0) * 0.003;
  if (player.energy) score += Math.max(0, player.energy.produced || 0) * 0.25;
  for (const e of world.entities.values()) {
    if (e.dead || e.owner !== player.id) continue;
    const hp = Math.max(1, e.hp || e.maxHp || 1);
    if (e.etype === 'building') score += hp * 0.13 + (e.size || 1) * 18 + ((e.buildProgress ?? 1) < 1 ? 0 : 22);
    else if (e.etype === 'unit') score += hp * 0.18 + (e.heavy ? 25 : 8) + (e.domain === 'air' ? 18 : 0);
  }
  return score;
}

function playerCenter(world, owner) {
  let sx = 0, sy = 0, sw = 0;
  for (const e of world.entities.values()) {
    if (e.dead || e.owner !== owner) continue;
    const w = e.etype === 'building' ? 3 + (e.size || 1) : 1;
    sx += e.x * w; sy += e.y * w; sw += w;
  }
  if (sw <= 0) {
    const t = world.terrain;
    return { x: t.w * TILE * 0.5, y: t.h * TILE * 0.5, tx: (t.w / 2) | 0, ty: (t.h / 2) | 0 };
  }
  const x = sx / sw, y = sy / sw;
  const [tx, ty] = worldToTile(x, y);
  return { x, y, tx, ty };
}

function hazardRainMultiplier(world, tx, ty) {
  const b = updateHazardBias(world);
  if (!b) return 1;
  const t = world.terrain;
  const side = ((tx + 0.5 - t.w / 2) * b.sideX + (ty + 0.5 - t.h / 2) * b.sideY) / Math.max(1, Math.max(t.w, t.h) * 0.42);
  const sideBias = 0.72 + smooth01(side + 0.55) * 0.62;
  const local = Math.max(0, 1 - Math.hypot(tx + 0.5 - b.tx, ty + 0.5 - b.ty) / b.radius);
  return Math.max(0.65, Math.min(1.65, sideBias + local * 0.36));
}

function slideBiasFactor(world, high, low) {
  const b = updateHazardBias(world);
  if (!b) return 1;
  const t = world.terrain;
  const hx = high % t.w, hy = (high / t.w) | 0;
  const lx = low % t.w, ly = (low / t.w) | 0;
  const d = Math.hypot(hx + 0.5 - b.tx, hy + 0.5 - b.ty);
  const local = Math.max(0, 1 - d / (b.radius * 1.25));
  const downX = lx - hx, downY = ly - hy;
  const downLen = Math.hypot(downX, downY) || 1;
  const targetX = b.tx - hx, targetY = b.ty - hy;
  const targetLen = Math.hypot(targetX, targetY) || 1;
  const toward = (downX / downLen) * (targetX / targetLen) + (downY / downLen) * (targetY / targetLen);
  return Math.max(0.55, Math.min(2.3, 0.72 + local * 0.95 + Math.max(0, toward) * local * 0.62));
}

function smooth01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

function biasedRandomTile(world, radius = HAZARD_BIAS_RADIUS) {
  const t = world.terrain;
  const b = updateHazardBias(world);
  if (!b) {
    return { tx: 8 + ((world.rng() * Math.max(1, t.w - 16)) | 0), ty: 8 + ((world.rng() * Math.max(1, t.h - 16)) | 0) };
  }
  const angle = world.rng() * Math.PI * 2;
  const dist = Math.sqrt(world.rng()) * radius;
  const tx = Math.max(1, Math.min(t.w - 2, Math.round(b.tx + Math.cos(angle) * dist)));
  const ty = Math.max(1, Math.min(t.h - 2, Math.round(b.ty + Math.sin(angle) * dist)));
  return { tx, ty };
}

function triggerBiasedLandslide(world) {
  const t = world.terrain;
  const profile = insanityProfile(world);
  let best = null, bestScore = -Infinity;
  const scan = (biased) => {
    const tile = biased ? biasedRandomTile(world, HAZARD_BIAS_RADIUS) : { tx: (world.rng() * t.w) | 0, ty: (world.rng() * t.h) | 0 };
    if (!inBounds(t, tile.tx, tile.ty)) return;
    const i = tIdx(t, tile.tx, tile.ty);
    if (t.startSafe?.[i] || t.height[i] <= SEA_LEVEL + 0.06 || t.height[i] >= SNOW_LINE) return;
    const low = lowestNeighbor(t, i, null);
    if (low < 0) return;
    const slope = t.height[i] - t.height[low];
    if (slope <= NATURAL_SLIDE_SLOPE * 0.50 * profile.slideThreshold) return;
    const score = slope * slideBiasFactor(world, i, low) + world.rng() * 0.025;
    if (score > bestScore) { bestScore = score; best = { i, low, slope }; }
  };
  for (let k = 0; k < 220; k++) scan(true);
  if (!best) for (let k = 0; k < 260; k++) scan(false);
  if (!best) return false;
  const len = scaledCount(18 + Math.min(28, Math.floor((best.slope - NATURAL_SLIDE_SLOPE * 0.50) * 170)), profile.slideLength, 4);
  return slideCell(world, best.i, best.low, NATURAL_SLIDE_SLOPE * 0.40 * profile.slideThreshold, RAIN_SLIDE_AMT * 1.35 * profile.slideMass, 0.060 * profile.slideMass, len);
}

function nextWeather(world, from) {
  if (from === 'clear') {
    const weather = pickWeather(world, [['drought', 0.10], ['fog', 0.22], ['storm', 0.27], ['rain', 0.41]]);
    return weatherPhase(world, weather, weather === 'drought' ? 180 : weather === 'fog' ? 35 : 30, weather === 'drought' ? 180 : weather === 'fog' ? 45 : 50);
  }
  if (from === 'drought') {
    const weather = pickWeather(world, [['rain', 0.55], ['storm', 0.23], ['clear', 0.22]]);
    return weatherPhase(world, weather, weather === 'rain' ? 45 : weather === 'storm' ? 25 : 60, weather === 'rain' ? 70 : weather === 'storm' ? 45 : 90);
  }
  if (from === 'rain') {
    const weather = pickWeather(world, [['storm', 0.3], ['clear', 0.7]]);
    return weatherPhase(world, weather, weather === 'storm' ? 20 : 90, weather === 'storm' ? 30 : 150);
  }
  if (from === 'fog') {
    const weather = pickWeather(world, [['rain', 0.25], ['clear', 0.75]]);
    return weatherPhase(world, weather, weather === 'rain' ? 25 : 90, weather === 'rain' ? 35 : 150);
  }
  const weather = pickWeather(world, [['rain', 0.4], ['clear', 0.6]]);
  return weatherPhase(world, weather, weather === 'rain' ? 20 : 90, weather === 'rain' ? 40 : 150);
}

function pickWeather(world, entries) {
  const profile = insanityProfile(world);
  const weighted = entries.map(([weather, weight]) => [weather, weight * weatherWeight(profile, weather)]);
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let r = world.rng() * total;
  for (const [weather, weight] of weighted) {
    r -= weight;
    if (r <= 0) return weather;
  }
  return weighted[weighted.length - 1][0];
}

function weatherWeight(profile, weather) {
  if (weather === 'rain') return profile.rainWeather;
  if (weather === 'storm') return profile.stormWeather;
  if (weather === 'drought') return profile.droughtWeather;
  if (weather === 'fog') return profile.fogWeather;
  return 1;
}

function weatherPhase(world, weather, minDuration, extraDuration) {
  return { weather, duration: scaledWeatherDuration(world, minDuration + world.rng() * extraDuration) };
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
  const bias = updateHazardBias(world);
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
    if (bias) {
      if (e.owner === bias.owner) hgt += 7;
      const d = Math.hypot(tx + 0.5 - bias.tx, ty + 0.5 - bias.ty);
      hgt += Math.max(0, 1 - d / bias.radius) * 8;
    }
    if (hgt > bestH) { bestH = hgt; best = e; }
  }
  if (best) {
    applyDamage(world, best, LIGHTNING_DMG * insanityProfile(world).lightningDamage, null);
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
  const profile = insanityProfile(world);
  const tries = scaledCount(32, profile.eventRate, 8);
  for (let k = 0; k < tries; k++) {
    const i = t.snowIdx[(world.rng() * t.snowIdx.length) | 0];
    if (t.snow[i] < AVAL_SNOW) continue;
    if (world.rng() > AVAL_CHANCE * boost * profile.slide) continue;
    const low = lowestNeighbor(t, i, null);
    if (low < 0 || t.height[i] - t.height[low] < AVAL_SLOPE * profile.slideThreshold) continue;
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
  // Schmelzwasser/Schutt im Auslauf; der eigentliche Mitreiß-/Scherschaden kommt danach als
  // kohärenter Massestrom (siehe applySlideForces).
  const coords = [];
  for (let p = 0; p < path.length; p++) {
    const i = path[p];
    const px = (i % t.w), py = (i / t.w) | 0;
    coords.push(Math.round((px + 0.5) * TILE), Math.round((py + 0.5) * TILE));
    if (p >= path.length - 5) {                    // Auslaufzone: Schnee/Schutt lagert an
      applyHeightDelta(t, i, Math.min(AVAL_DEPOSIT * mass, 0.035), true);
      t.water[i] = Math.min(WATER_MAX_DEPTH, t.water[i] + mass * 0.15);
      if (t.waterActive) t.waterActive.add(i);
    }
  }
  applySlideForces(world, path, { severity: Math.min(2.6, 1 + mass * 0.9), avalanche: true });
  triggerSlideWaterWave(world, path, Math.min(2.1, 0.7 + mass * 0.35));
  wakeWaterAround(t, start % t.w, (start / t.w) | 0, 1, AVAL_LEN);
  world.events.push({ type: 'avalanche', x: coords[0], y: coords[1], path: coords });
}

function checkNaturalSlopeSlides(world) {
  const t = world.terrain;
  const profile = insanityProfile(world);
  const tries = scaledCount(NATURAL_SLIDE_TRIES, profile.eventRate, 10);
  const threshold = NATURAL_SLIDE_SLOPE * profile.slideThreshold;
  let slid = 0;
  for (let k = 0; k < tries; k++) {
    const tile = k < tries * 0.55 ? biasedRandomTile(world, HAZARD_BIAS_RADIUS) : null;
    const i = tile ? tIdx(t, tile.tx, tile.ty) : (world.rng() * t.w * t.h) | 0;
    if (t.startSafe?.[i] || t.height[i] <= SEA_LEVEL + 0.08 || t.height[i] >= SNOW_LINE) continue;
    if ((t.water?.[i] || 0) > 0.03) continue; // nasse Hänge prüft checkRainSlides dichter
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    const slope = t.height[i] - t.height[low];
    if (slope <= threshold) continue;
    const chance = NATURAL_SLIDE_CHANCE * profile.slide * slideBiasFactor(world, i, low)
      * Math.min(4.0, 1 + (slope - threshold) * 34);
    if (world.rng() > chance) continue;
    const len = scaledCount(7 + Math.min(16, Math.floor((slope - threshold) * 120)), profile.slideLength, 3);
    if (slideCell(world, i, low, threshold * 0.62, RAIN_SLIDE_AMT * 0.62 * profile.slideMass, 0.030 * profile.slideMass, len)) slid++;
    if (slid >= Math.max(1, Math.round(2 * profile.eventRate))) break;
  }
}

export function checkRainSlides(world, boost = 1) {
  const t = world.terrain;
  const profile = insanityProfile(world);
  const tries = scaledCount(56, profile.eventRate, 12);
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
  for (let k = 0; k < scaledCount(24, profile.eventRate, 8); k++) {
    const tile = biasedRandomTile(world, HAZARD_BIAS_RADIUS);
    addCandidate(tIdx(t, tile.tx, tile.ty));
  }
  for (let k = 0; k < tries; k++) addCandidate((world.rng() * t.w * t.h) | 0);
  for (const i of candidates) {
    if (t.height[i] > SNOW_LINE) continue; // Schneehänge werden über Lawinen behandelt
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    const bias = waterSlideBias(t, i, low);
    const slope = t.height[i] - t.height[low];
    const threshold = RAIN_SLIDE_SLOPE * profile.slideThreshold * (bias.flowing ? 0.78 : 1);
    if (slope <= threshold) continue;
    if (!bias.wet && world.rng() > 0.30) continue;
    const chance = RAIN_SLIDE_CHANCE * boost
      * slideBiasFactor(world, i, low)
      * Math.min(6.0, (1 + slope * 8) * (bias.wet ? 1.35 : 0.45) + bias.flow * 30);
    if (world.rng() > chance) continue;
    const len = scaledCount(bias.wet ? 9 + Math.min(16, Math.floor(bias.flow * 80)) : 5, profile.slideLength, 3);
    if (slideCell(world, i, low, threshold, RAIN_SLIDE_AMT * profile.slideMass, 0.04 * profile.slideMass, len)) {
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

function nextSlideNeighbor(t, i, seen, dir) {
  const x = i % t.w, y = (i / t.w) | 0;
  let best = -1, bestScore = -Infinity;
  const curH = t.height[i];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (!inBounds(t, nx, ny)) continue;
    const j = ny * t.w + nx;
    if (seen && seen.includes(j)) continue;
    const dist = Math.hypot(dx, dy) || 1;
    const drop = curH - t.height[j];
    if (drop < -0.010) continue; // Momentum ja, aber keine sichtbaren Hügel hochklettern.
    const forward = dir ? (dx * dir.dx + dy * dir.dy) / dist : 0;
    const score = drop * 3.2 + Math.max(0, forward) * 0.024 - dist * 0.002;
    if (score > bestScore) { bestScore = score; best = j; }
  }
  return best;
}

function slideCell(world, high, low, threshold, mult, cap, maxLen = 1) {
  const t = world.terrain;
  const path = [high];
  let moved = false;
  let movedMass = 0;
  let curHigh = high, curLow = low;
  const hx = high % t.w, hy = (high / t.w) | 0;
  const lx = low % t.w, ly = (low / t.w) | 0;
  const dLen = Math.hypot(lx - hx, ly - hy) || 1;
  const dir = low >= 0 ? { dx: (lx - hx) / dLen, dy: (ly - hy) / dLen } : null;
  const steps = Math.max(1, maxLen | 0);
  for (let step = 0; step < steps; step++) {
    if (curLow < 0) break;
    const localThreshold = step === 0 ? threshold : Math.max(0.004, threshold * Math.max(0.16, 0.46 - step * 0.025));
    const slope = t.height[curHigh] - t.height[curLow];
    const coast = step > 0 && slope > -0.006;
    if (slope <= localThreshold && !coast) break;
    const falloff = Math.max(0.22, 1 - step * 0.055);
    const drive = slope > localThreshold
      ? (slope - localThreshold)
      : Math.max(0.0035, localThreshold * 0.18 + Math.max(0, slope) * 0.25);
    const coastMult = slope > localThreshold ? 1 : 0.34;
    const a = Math.min(cap * falloff * coastMult, drive * mult * falloff * coastMult);
    if (a <= 0) break;
    movedMass += a;
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
    curLow = step < 1 ? lowestNeighbor(t, curHigh, path) : nextSlideNeighbor(t, curHigh, path, dir);
  }
  if (!moved) return false;
  const severity = Math.min(2.0, 0.65 + movedMass * 18);
  damageSlidePath(world, path, severity);
  let minX = t.w, minY = t.h, maxX = 0, maxY = 0;
  for (const i of path) {
    const x = i % t.w, y = (i / t.w) | 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  wakeWaterAround(t, minX, minY, Math.max(1, maxX - minX + 1), Math.max(2, maxY - minY + 2));
  triggerSlideWaterWave(world, path, severity);
  pushSlideEvent(world, path);
  return true;
}

function damageSlidePath(world, path, severity = 1) {
  applySlideForces(world, path, { severity });
}

function applySlideForces(world, path, opts = {}) {
  const t = world.terrain;
  if (!path || path.length < 2) return;
  const severity = Math.max(0.35, opts.severity || 1);
  const cells = new Set(path);
  const shear = new Set();
  for (const i of path) {
    const x = i % t.w, y = (i / t.w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!inBounds(t, nx, ny)) continue;
      const j = tIdx(t, nx, ny);
      if (!cells.has(j)) shear.add(j);
    }
  }
  tearLinearTerrain(t, cells, shear);
  const dir = slideDirection(t, path);
  const impacted = new Set();
  for (const e of world.entities.values()) {
    if (e.dead || e.domain === 'air') continue;
    const hit = footprintSlideHit(t, e, cells, shear);
    if (!hit) continue;
    if (impacted.has(e.id)) continue;
    impacted.add(e.id);
    if (isLinearInfrastructure(e)) {
      applyDamage(world, e, SLIDE_INFRA_DMG * severity * (hit.direct ? 1 : 0.62), null, opts.avalanche ? 'avalanche' : 'landslide');
      continue;
    }
    if (isTerrainAnchoredBuilding(e)) {
      const dmg = (hit.direct ? SLIDE_BUILDING_DMG : SLIDE_SHEAR_DMG) * severity * (opts.avalanche ? 1.25 : 1);
      applyDamage(world, e, dmg, null, opts.avalanche ? 'avalanche' : 'landslide');
      continue;
    }
    const drag = TILE * SLIDE_ENTITY_DRAG * Math.min(1.7, severity) * (hit.direct ? 1 : 0.45);
    e.x = Math.max(TILE * 0.5, Math.min((t.w - 0.5) * TILE, e.x + dir.dx * drag));
    e.y = Math.max(TILE * 0.5, Math.min((t.h - 0.5) * TILE, e.y + dir.dy * drag));
    if (e.etype === 'building') {
      maybeMoveBuildingFootprint(world, e);
      const dmg = (hit.direct ? SLIDE_BUILDING_DMG : SLIDE_SHEAR_DMG) * severity * (opts.avalanche ? 1.25 : 1);
      applyDamage(world, e, dmg, null, opts.avalanche ? 'avalanche' : 'landslide');
    } else {
      applyDamage(world, e, SLIDE_UNIT_DMG * severity * (opts.avalanche ? 1.8 : 1), null, opts.avalanche ? 'avalanche' : 'landslide');
    }
  }
}

function tearLinearTerrain(t, cells, shear) {
  let roadChanged = false;
  for (const i of cells) {
    if (t.road?.[i]) { t.road[i] = 0; roadChanged = true; }
    if (t.roadBuilt?.[i]) { t.roadBuilt[i] = 0; roadChanged = true; }
    if (t.bridge?.[i]) t.bridge[i] = 0;
    if (t.pontoon?.[i]) t.pontoon[i] = 0;
  }
  for (const i of shear) {
    if (t.roadBuilt?.[i] && t.roadBuilt[i] > 0) { t.roadBuilt[i] = 0; roadChanged = true; }
    if (t.pontoon?.[i]) t.pontoon[i] = 0;
  }
  if (roadChanged) t.roadDirty = true;
}

function slideDirection(t, path) {
  const a = path[0], b = path[path.length - 1];
  const ax = a % t.w, ay = (a / t.w) | 0;
  const bx = b % t.w, by = (b / t.w) | 0;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { dx: dx / len, dy: dy / len };
}

function segmentDirection(t, path, at = path.length - 1) {
  const b = Math.max(1, Math.min(path.length - 1, at));
  const a = path[b - 1], c = path[b];
  const ax = a % t.w, ay = (a / t.w) | 0;
  const bx = c % t.w, by = (c / t.w) | 0;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { dx: dx / len, dy: dy / len };
}

function isWaterCell(t, i) {
  return (t.water?.[i] || 0) > WET_DEPTH || t.height[i] <= SEA_LEVEL + 0.002;
}

function triggerSlideWaterWave(world, path, severity = 1) {
  if (!path || path.length < 3 || severity < SLIDE_WAVE_MIN_SEVERITY) return false;
  const t = world.terrain;
  const dir = slideDirection(t, path);
  const water = findWaterNearSlideEnd(t, path, dir);
  if (water < 0) return false;
  if (world._slideWaveTick !== world.tick) {
    world._slideWaveTick = world.tick;
    world._slideWaveCount = 0;
  }
  if (world._slideWaveCount >= SLIDE_WAVE_MAX_PER_TICK) return false;
  const strength = Math.min(0.18, SLIDE_WAVE_STRENGTH * Math.max(0.65, Math.min(2.1, severity)));
  const didWave = triggerDirectedWaterWave(world, water, dir, strength, SLIDE_WAVE_SPREAD);
  if (didWave) world._slideWaveCount++;
  return didWave;
}

function findWaterNearSlideEnd(t, path, dir) {
  const start = Math.max(0, path.length - 5);
  for (let p = path.length - 1; p >= start; p--) {
    const i = path[p];
    if (isWaterCell(t, i)) return i;
  }
  const end = path[path.length - 1];
  const ex = end % t.w, ey = (end / t.w) | 0;
  let best = -1, bestScore = -Infinity;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const tx = ex + dx, ty = ey + dy;
    if (!inBounds(t, tx, ty)) continue;
    const d = Math.hypot(dx, dy);
    if (d <= 0 || d > 3.25) continue;
    const dot = (dx * dir.dx + dy * dir.dy) / d;
    if (dot < -0.25) continue;
    const i = tIdx(t, tx, ty);
    if (!isWaterCell(t, i)) continue;
    const score = dot * 2 - d;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function triggerDirectedWaterWave(world, source, dir, strength, spread) {
  const t = world.terrain;
  if (!t.water || source < 0 || !Number.isFinite(strength) || strength <= 0) return false;
  let dx = dir.dx || 0, dy = dir.dy || 0;
  let len = Math.hypot(dx, dy);
  if (len < 0.001) { dx = 1; dy = 0; len = 1; }
  dx /= len; dy /= len;
  const px = -dy, py = dx;
  const sx = source % t.w, sy = (source / t.w) | 0;
  const sourceSurface = Math.max(SEA_LEVEL, t.height[source] + (t.water[source] || 0));
  let touched = false;
  for (let step = 0; step <= spread; step++) {
    const width = Math.max(1, Math.round(1 + step * 0.42));
    for (let side = -width; side <= width; side++) {
      const tx = Math.round(sx + dx * step + px * side);
      const ty = Math.round(sy + dy * step + py * side);
      if (!inBounds(t, tx, ty)) continue;
      const i = tIdx(t, tx, ty);
      if (t.waterBlock?.[i] > 0) continue;
      const shoreLimit = sourceSurface + 0.035 + strength * 0.75;
      if (!isWaterCell(t, i) && t.height[i] > shoreLimit) continue;
      const forward = 1 - step / Math.max(1, spread + 1);
      const lateral = 1 - Math.abs(side) / (width + 1);
      const add = strength * (0.26 + forward * 0.74) * (0.25 + lateral * 0.75);
      if (add <= 0) continue;
      t.water[i] = Math.min(WATER_MAX_DEPTH, (t.water[i] || 0) + add);
      if (t.waterActive) t.waterActive.add(i);
      touched = true;
    }
  }
  if (touched) {
    wakeWaterAround(t, sx - spread, sy - spread, spread * 2 + 1, 2);
    const [wx, wy] = tileToWorld(sx, sy);
    world.events.push({ type: 'water_wave', x: wx, y: wy, dx, dy, strength });
  }
  return touched;
}

function buildRockRollPath(t, start, firstLow, maxLen = ROCK_ROLL_LEN) {
  if (isWaterCell(t, start)) return [];
  const path = [start];
  let cur = start;
  let low = firstLow >= 0 ? firstLow : lowestNeighbor(t, cur, path);
  for (let step = 0; step < maxLen; step++) {
    if (low < 0 || path.includes(low)) break;
    const drop = t.height[cur] - t.height[low];
    const water = isWaterCell(t, low);
    const minSlope = ROCK_ROLL_MIN_SLOPE * (step === 0 ? 1 : 0.42);
    if (!water && drop < minSlope) break;
    path.push(low);
    if (water) break;
    cur = low;
    low = lowestNeighbor(t, cur, path);
  }
  return path;
}

function rollQuakeRock(world, start, firstLow = -1) {
  const t = world.terrain;
  const path = buildRockRollPath(t, start, firstLow);
  if (path.length < 2) return false;
  damageRockRollPath(world, path);
  const waterAt = path.findIndex((i, n) => n > 0 && isWaterCell(t, i));
  if (waterAt > 0) {
    triggerDirectedWaterWave(world, path[waterAt], segmentDirection(t, path, waterAt), ROCK_WAVE_STRENGTH, ROCK_WAVE_SPREAD);
  }
  pushRockRollEvent(world, path);
  return true;
}

function damageRockRollPath(world, path) {
  const t = world.terrain;
  const cells = new Set(path);
  tearLinearTerrain(t, cells, new Set());
  const hit = new Set();
  for (const e of world.entities.values()) {
    if (e.dead || e.domain === 'air') continue;
    if (!rockRollHitsEntity(t, e, cells)) continue;
    if (hit.has(e.id)) continue;
    hit.add(e.id);
    const lethal = Math.max(ROCK_ROLL_DMG, (e.maxHp || e.hp || 1) * (e.etype === 'unit' ? 6 : 2.2));
    applyDamage(world, e, lethal, null, 'rockfall', { rockfall: 1 });
  }
}

function rockRollHitsEntity(t, e, cells) {
  if (e.etype === 'building') {
    const size = e.size || 1;
    for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
      const tx = e.tx + xx, ty = e.ty + yy;
      if (inBounds(t, tx, ty) && cells.has(tIdx(t, tx, ty))) return true;
    }
    return false;
  }
  const [tx, ty] = worldToTile(e.x, e.y);
  if (!inBounds(t, tx, ty)) return false;
  if (cells.has(tIdx(t, tx, ty))) return true;
  for (const i of cells) {
    const [wx, wy] = tileToWorld(i % t.w, (i / t.w) | 0);
    if (Math.hypot(e.x - wx, e.y - wy) <= TILE * 0.54) return true;
  }
  return false;
}

function footprintSlideHit(t, e, cells, shear) {
  if (e.etype !== 'building') {
    const [tx, ty] = worldToTile(e.x, e.y);
    if (!inBounds(t, tx, ty)) return null;
    const i = tIdx(t, tx, ty);
    return cells.has(i) ? { direct: true } : shear.has(i) ? { direct: false } : null;
  }
  let edge = false;
  const size = e.size || 1;
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const x = e.tx + xx, y = e.ty + yy;
    if (!inBounds(t, x, y)) continue;
    const i = tIdx(t, x, y);
    if (cells.has(i)) return { direct: true };
    if (shear.has(i)) edge = true;
  }
  return edge ? { direct: false } : null;
}

function isLinearInfrastructure(e) {
  const d = e.def || {};
  return !!(d.pipe || d.roadBuilt || d.bridges || d.tunnels || e.kind === 'pipe' || e.kind === 'road' || e.kind === 'bridge');
}

function isTerrainAnchoredBuilding(e) {
  if (e.etype !== 'building') return false;
  const d = e.def || {};
  return !!(e._fortified || d.terraform || d.waterBlocks || d.role === 'fortification' || d.role === 'hydro' || d.role === 'terrain');
}

function maybeMoveBuildingFootprint(world, e) {
  const t = world.terrain;
  if (isLinearInfrastructure(e) || isTerrainAnchoredBuilding(e)) return;
  const size = e.size || 1;
  const tx = Math.max(0, Math.min(t.w - size, Math.round(e.x / TILE - size / 2)));
  const ty = Math.max(0, Math.min(t.h - size, Math.round(e.y / TILE - size / 2)));
  if (tx === e.tx && ty === e.ty) return;
  if (e._solid) {
    for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
      const ox = e.tx + xx, oy = e.ty + yy;
      if (inBounds(t, ox, oy)) {
        const i = tIdx(t, ox, oy);
        if (t.block?.[i] > 0) t.block[i]--;
      }
    }
  }
  e.tx = tx; e.ty = ty;
  if (e._solid) {
    for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
      const nx = tx + xx, ny = ty + yy;
      if (inBounds(t, nx, ny) && t.block) t.block[tIdx(t, nx, ny)]++;
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

function pushRockRollEvent(world, path) {
  if (world._rockFxTick !== world.tick) {
    world._rockFxTick = world.tick;
    world._rockFxCount = 0;
  }
  if (world._rockFxCount >= 4) return;
  const t = world.terrain;
  const coords = [];
  for (const i of path) {
    const [wx, wy] = tileToWorld(i % t.w, (i / t.w) | 0);
    coords.push(wx, wy);
  }
  world._rockFxCount++;
  world.events.push({ type: 'landslide', x: coords[0], y: coords[1], path: coords, rock: 1 });
}

function startQuake(world, opts = {}) {
  const t = world.terrain;
  const profile = insanityProfile(world);
  const radius = Math.max(6, Math.round(QUAKE_RADIUS * profile.quakeRadius));
  const duration = Math.max(1, QUAKE_DURATION * profile.quakeDuration);
  const target = opts.target || biasedRandomTile(world, Math.max(18, radius));
  const tx = Math.max(1, Math.min(t.w - 2, target.tx | 0));
  const ty = Math.max(1, Math.min(t.h - 2, target.ty | 0));
  const [wx, wy] = tileToWorld(tx, ty);
  world.env.quake = { x: wx, y: wy, tx, ty, r: radius, left: duration, fissureDone: false, burstDone: false };
  world.events.push({ type: 'quake', x: wx, y: wy, r: radius * TILE, start: true });
}

// Ein Beben-Tick: Hangrutsche im Radius — Material rutscht von steilen Zellen zum tiefsten Nachbarn.
// Höhenänderungen laufen über applyHeightDelta → terra[]/terraDirty → Client-Streaming; Wasser-CA
// wird geweckt (Rutsche können Flüsse umleiten oder Becken anstechen).
function quakeTick(world, q) {
  const t = world.terrain;
  const { w, h } = t;
  const profile = insanityProfile(world);
  const rockCap = scaledCount(ROCK_ROLL_MAX_PER_QUAKE, profile.rockRate, 1);
  if (!q.fissureDone) {
    q.fissureDone = true;
    carveQuakeFissure(world, q);
  }
  if (!q.burstDone) {
    q.burstDone = true;
    triggerQuakeSlideBurst(world, q, Math.max(4, Math.round(q.r / 4 * profile.eventRate)));
    q.rocksDone = triggerQuakeRockRolls(world, q, Math.min(rockCap, Math.max(3, Math.round(q.r / 4 * profile.rockRate))));
  }
  if (q.rocksDone == null) q.rocksDone = 0;
  if ((world.tick % 3) === 0 && q.rocksDone < rockCap) {
    q.rocksDone += triggerQuakeRockRolls(world, q, Math.min(2, rockCap - q.rocksDone));
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
    if (slideCell(world, i, low, QUAKE_SLOPE * profile.quakeSlope, QUAKE_SLIDE * profile.quakeSlide, 0.05 * profile.quakeSlide, scaledCount(6, profile.slideLength, 3))) slid++;
  }
  if (slid) wakeWaterAround(t, q.tx - q.r, q.ty - q.r, q.r * 2);
  // Beben in Bergnähe lösen Schneelawinen aus (neben den normalen Hangrutschen).
  if (t.snow && (world.tick % 5) === 0) checkAvalanches(world, 40 * profile.slide);
  world.events.push({ type: 'quake', x: q.x, y: q.y, r: q.r * TILE, left: Math.max(0, q.left) });
}

function triggerQuakeRockRolls(world, q, wanted) {
  const t = world.terrain;
  if (!wanted || wanted <= 0) return 0;
  const profile = insanityProfile(world);
  if (!q.rockStarts) q.rockStarts = [];
  const candidates = [];
  const used = new Set(q.rockStarts);
  const tries = ROCK_ROLL_TRIES + wanted * 12;
  for (let k = 0; k < tries; k++) {
    const dx = ((world.rng() * 2 - 1) * q.r) | 0;
    const dy = ((world.rng() * 2 - 1) * q.r) | 0;
    if (dx * dx + dy * dy > q.r * q.r) continue;
    const tx = q.tx + dx, ty = q.ty + dy;
    if (tx < 1 || ty < 1 || tx >= t.w - 1 || ty >= t.h - 1) continue;
    const i = tIdx(t, tx, ty);
    if (used.has(i) || isWaterCell(t, i)) continue;
    const low = lowestNeighbor(t, i, null);
    if (low < 0) continue;
    const slope = t.height[i] - t.height[low];
    if (slope < ROCK_ROLL_MIN_SLOPE * profile.quakeSlope) continue;
    const score = slope + (world.rng() * 0.018);
    candidates.push([score, i, low]);
  }
  candidates.sort((a, b) => b[0] - a[0]);
  let done = 0;
  for (const [, i, low] of candidates) {
    if (done >= wanted) break;
    if (rollQuakeRock(world, i, low)) {
      q.rockStarts.push(i);
      used.add(i);
      done++;
    }
  }
  return done;
}

function triggerQuakeSlideBurst(world, q, wanted) {
  const t = world.terrain;
  const profile = insanityProfile(world);
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
    if (slope > QUAKE_SLOPE * 0.58 * profile.quakeSlope) candidates.push([slope, i, low]);
  }
  candidates.sort((a, b) => b[0] - a[0]);
  let done = 0;
  for (const [, i, low] of candidates) {
    if (done >= wanted) break;
    const len = scaledCount(10 + Math.min(12, Math.floor((t.height[i] - t.height[low] - QUAKE_SLOPE * 0.58 * profile.quakeSlope) * 120)), profile.slideLength, 4);
    if (slideCell(world, i, low, QUAKE_SLOPE * 0.50 * profile.quakeSlope, QUAKE_SLIDE * 1.45 * profile.quakeSlide, 0.065 * profile.quakeSlide, len)) done++;
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
