// Dynamisches Wasser (Phase 8) als Zellularautomat.
// Modell: water[i] = Wassertiefe über dem Boden (Höheneinheiten). Oberfläche S = height + water.
// Wasser fließt von hoher zu niedriger Oberfläche (4-Nachbarschaft), Dämme/Deiche (waterBlock)
// sperren den Fluss, Quellen speisen Flüsse; Wasser verschwindet sichtbar erst am Meer/Rand
// oder in Dürrephasen, nicht durch unsichtbare Versickerung in geschlossenen Senken.
//
// Performance: Es werden nur „aktive" Zellen (instabil) plus ihre Nachbarn verarbeitet; settled
// Zellen fallen aus der Menge. Determinismus: aktive Menge wird je Schritt sortiert abgearbeitet.
import {
  BUILDER_WADE_DEPTH, BUILDER_WADE_TIME, DT, WATER_STEP_TICKS, WATER_FLOW, WATER_SOURCE_RATE,
  WET_DEPTH, FLOOD_DEPTH, NAVIGABLE_DEPTH, WATER_MAX_DEPTH, FLOOD_DPS, SEA_LEVEL,
  RAIN_FRAC, RAIN_DEPTH, STORM_RAIN_MULT,
  DROUGHT_RIVER_DRAIN, FLOOD_CAP_FRAC,
  SNOW_MELT, SNOW_FALL, MELT_WATER, SNOW_LINE, SNOW_FALL_LINE, SNOW_BAND_CAP,
  BUILDING_FLOOD_GRACE, BUILDING_FLOOD_DPS, HEAVY_WATER_DPS,
  CURRENT_MIN_DEPTH, CURRENT_DRAG, CURRENT_MAX,
  TRACK_DECAY_CLEAR, TRACK_DEPRESSION, TRACK_PUDDLE_MIN, TRACK_RAIN_MULT,
  MUD_DRY_CLEAR,
  WATER_ERODE_DEPTH, WATER_ERODE_EXCESS, WATER_ERODE_RATE, WATER_ERODE_MAX_STEP,
} from '../constants.js';
import { TT, applyHeightDelta, wakeWaterAround, worldToTile, tIdx, inBounds } from '../terrain.js';
import { applyDamage } from '../world.js';
import { insanityProfile } from './environment.js';

const SETTLE_EPS = 1e-4;   // Schwelle, unter der eine Zelle als beruhigt gilt
const FLOW_EPS = 0.0015;   // minimale Oberflächenneigung, bevor Wasser sichtbar strömt
const FLOW_DEPTH_EPS = WET_DEPTH * 0.8; // dünner Regenfilm = Bodenfeuchte, kein teurer Oberflächenfluss
const SEA_DRAIN = 0.12;    // Meer nimmt überschüssiges Wasser nur LANGSAM auf (Wasser fließt sichtbar zu, statt zu verschwinden)
const EDGE_DRAIN = 0.05;   // Kartenrand-Auslass — bewusst langsam, damit Wasser nicht abrupt am Rand verschwindet
const SNOW_PATCH_EPS = 0.08; // dünne Restflecken verschwinden visuell statt als einzelne Pixel zu bleiben
const RAIN_SINK_STEPS = 20; // lokale Einzugsfläche: Regen sucht einige Zellen talwärts eine Senke
const RAIN_SINK_LOCAL_FRACTION = 0.05; // nur ein dünner Rest bleibt am Einschlag; Boden wird nicht flächig nass
const RAIN_SINK_STEP_PENALTY = 0.00055; // verhindert seitliches Wandern auf fast ebenem Boden
const RAIN_POOL_MULT = 1.38; // mehr Regenmasse sammelt sich in Senken statt als dünner Film zu verschwinden
const RAIN_LAKE_GAIN = 3.1;
const RAIN_VALLEY_GAIN = 6.2;
const SLOPE_FLOW_RELIEF = 10.5; // echtes Bodengefälle darf Becken-Dämpfung überstimmen, ohne Zellflackern zu erzeugen
const DOWNHILL_FLOW_BIAS = 125;
const UPHILL_FLOW_BIAS = 110;
const SURFACE_RELAX = 0.13;
const FLOW_MIN_MOBILITY = 0.28;
const FLOW_FULL_MOBILITY_DEPTH = WET_DEPTH * 1.05;
const UPHILL_RUNOFF_EPS = FLOW_EPS * 1.4;
const UPHILL_SPILL_DEPTH = FLOOD_DEPTH * 1.25;
const DIRECTED_RUNOFF_BOOST_MAX = 1.85;
// Wasserdruck: eine hohe Wassersäule steht unter mehr Druck und strömt schneller ab/zu
// (Torricelli, v ∝ √Tiefe). Nur die Tiefe ÜBER der Mobilitätsschwelle erzeugt Zusatzdruck —
// flaches Wasser/Regenfilm bleibt wie gehabt träge. Gedeckelt für CA-Stabilität.
const PRESSURE_REF = FLOW_FULL_MOBILITY_DEPTH; // ab dieser Tiefe beginnt der Druckbonus
const PRESSURE_GAIN = 1.8;                      // Stärke des Druckeffekts (tiefes Wasser fließt schneller)
const PRESSURE_MAX = 3.0;                       // Obergrenze des Druckfaktors
const PRESSURE_REF_SQRT = Math.sqrt(PRESSURE_REF);
function pressureFactor(depth) {
  return Math.min(PRESSURE_MAX, 1 + PRESSURE_GAIN * Math.max(0, Math.sqrt(Math.max(0, depth)) - PRESSURE_REF_SQRT));
}
const DIR_X = [-1, 1, 0, 0, -1, 1, -1, 1];
const DIR_Y = [0, 0, -1, 1, -1, -1, 1, 1];
const DIR_DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

const POOL_COMPONENT_DEPTH = WET_DEPTH * 0.22;
const POOL_FLAT_DEPTH = WET_DEPTH;
const POOL_LEVEL_EPS = 0.0025;
const OPEN_RUNOFF_DRAIN = 0.018;          // offene Rinnen trocknen wieder zu Restfeuchte ab; die sichtbare Wasserhaut rendert der Client
const OPEN_RUNOFF_MIN = WET_DEPTH * 0.003;
const DRAIN_SEARCH_LIMIT = 9000;
const STORM_SEA_CURRENT_MIN_DEPTH = Math.max(CURRENT_MIN_DEPTH, 0.075);
const STORM_SEA_CURRENT_SPEED = 1.45;
const STORM_SEA_CURRENT_SWIRL = 0.38;
const CURRENT_INFANTRY_WASH_SPEED = 0.72;
const CURRENT_WASH_DRIFT_MIN = 0.07;
const CURRENT_VEHICLE_RESIST = 0.24;
const CURRENT_HEAVY_RESIST = 0.55;
const VEHICLE_DEEP_WATER_DAMAGE_DEPTH = NAVIGABLE_DEPTH;

function flowGround(t, i) {
  return t.height[i] - ((t.tracks && t.tracks[i] > TRACK_PUDDLE_MIN) ? t.tracks[i] * TRACK_DEPRESSION : 0);
}

function isOpenSeaCell(t, i) {
  return t.type?.[i] === TT.WATER && !(t.lakeMask && t.lakeMask[i]) && t.height[i] <= SEA_LEVEL + 0.02;
}

function isEdgeCell(t, i) {
  const x = i % t.w, y = (i / t.w) | 0;
  return x === 0 || y === 0 || x === t.w - 1 || y === t.h - 1;
}

function isMainRiverCell(t, i) {
  return t.type?.[i] === TT.WATER
    && !isOpenSeaCell(t, i)
    && !(t.lakeMask && t.lakeMask[i])
    && (t.baseWater?.[i] || 0) > WET_DEPTH * 0.8;
}

function canDrainIntoOutlet(t, i, level) {
  if (isOpenSeaCell(t, i)) return true;
  if (isMainRiverCell(t, i)) return flowGround(t, i) + (t.water[i] || 0) <= level - FLOW_EPS;
  if (isEdgeCell(t, i)) return flowGround(t, i) <= level - FLOW_EPS;
  return false;
}

function rainSinkCell(t, i) {
  let cur = i;
  for (let step = 0; step < RAIN_SINK_STEPS; step++) {
    if (t.waterBlock && t.waterBlock[cur] > 0) break;
    const x = cur % t.w, y = (cur / t.w) | 0;
    const s0 = flowGround(t, cur) + (t.water[cur] || 0);
    let best = cur, bestSurface = s0;
    for (let dir = 0; dir < 8; dir++) {
      const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
      const j = ny * t.w + nx;
      if (t.waterBlock && t.waterBlock[j] > 0) continue;
      if (t.startSafe && t.startSafe[j]) continue;
      if (t.snow && t.height[j] > SNOW_LINE) continue;
      const surface = flowGround(t, j) + (t.water[j] || 0) + dist * RAIN_SINK_STEP_PENALTY;
      if (surface < bestSurface - FLOW_EPS) { bestSurface = surface; best = j; }
    }
    if (best === cur) break;
    cur = best;
  }
  return cur;
}

function shouldSimulateWater(t, i) {
  const depth = t.water[i] || 0;
  const base = t.baseWater?.[i] || 0;
  if (isOpenSeaCell(t, i)) return depth > base + SETTLE_EPS;
  if (base > FLOW_DEPTH_EPS || depth > FLOW_DEPTH_EPS) return true;
  return depth > base + FLOW_DEPTH_EPS;
}

function hasOutflow(t, i, eps = FLOW_EPS) {
  const waterBlock = t.waterBlock;
  if (waterBlock[i] > 0) return false;
  const x = i % t.w, y = (i / t.w) | 0;
  const s0 = flowGround(t, i) + t.water[i];
  for (let dir = 0; dir < 8; dir++) {
    const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
    const j = ny * t.w + nx;
    if (waterBlock[j] > 0) continue;
    if ((s0 - (flowGround(t, j) + t.water[j])) / dist > eps) return true;
  }
  return false;
}

function hasDownhillGroundNeighbor(t, i, gi, eps = UPHILL_RUNOFF_EPS) {
  const waterBlock = t.waterBlock;
  if (waterBlock[i] > 0) return false;
  const x = i % t.w, y = (i / t.w) | 0;
  for (let dir = 0; dir < 8; dir++) {
    const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
    const j = ny * t.w + nx;
    if (waterBlock[j] > 0) continue;
    if ((gi - flowGround(t, j)) / dist > eps) return true;
  }
  return false;
}

function canFlowAcrossGround(t, i, j, gi, gj, depth, hasDownhillGround) {
  const rise = gj - gi;
  if (rise <= UPHILL_RUNOFF_EPS) return true;
  if (!hasDownhillGround) return true; // Becken dürfen weiter ansteigen/überlaufen.
  if ((t.lakeMask && (t.lakeMask[i] || t.lakeMask[j]))) return true;
  return depth >= UPHILL_SPILL_DEPTH && depth >= rise + WET_DEPTH * 0.5;
}

function stormSeaCurrentAt(t, world, i, depth) {
  if (!world?.env || world.env.weather !== 'storm') return null;
  if (depth <= STORM_SEA_CURRENT_MIN_DEPTH || !isOpenSeaCell(t, i)) return null;
  const x = i % t.w, y = (i / t.w) | 0;
  const time = world.time || world.tick * DT || 0;
  const seed = (world.seed || 1) * 0.013;
  const cx = t.w * 0.5, cy = t.h * 0.5;
  const rx = x + 0.5 - cx, ry = y + 0.5 - cy;
  const radial = Math.atan2(ry, rx);
  const band = Math.sin(x * 0.11 + y * 0.07 + seed + time * 0.055);
  const wobble = Math.sin(x * 0.047 - y * 0.063 + seed * 1.7 + time * 0.091);
  const angle = seed + time * 0.035 + band * 0.65 + wobble * 0.24 + radial * 0.28;
  const tang = radial + Math.PI / 2;
  let dx = Math.cos(angle) * (1 - STORM_SEA_CURRENT_SWIRL) + Math.cos(tang) * STORM_SEA_CURRENT_SWIRL;
  let dy = Math.sin(angle) * (1 - STORM_SEA_CURRENT_SWIRL) + Math.sin(tang) * STORM_SEA_CURRENT_SWIRL;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const shoreDist = Math.hypot(rx, ry) / Math.max(1, Math.min(t.w, t.h) * 0.42);
  const edgeBoost = Math.max(0, Math.min(1, shoreDist - 0.55)) * 0.28;
  const pulse = 0.76 + 0.24 * Math.sin(x * 0.031 + y * 0.043 + seed + time * 0.13);
  const speed = STORM_SEA_CURRENT_SPEED * pulse * (1 + edgeBoost);
  return { dx, dy, grad: speed / CURRENT_DRAG, speed, seaStorm: true };
}

function currentAt(t, i, depth, world = null) {
  const stormSea = stormSeaCurrentAt(t, world, i, depth);
  if (stormSea) return stormSea;
  const waterBlock = t.waterBlock;
  if (waterBlock[i] > 0) return { dx: 0, dy: 0, grad: 0 };
  const x = i % t.w, y = (i / t.w) | 0;
  const s0 = flowGround(t, i) + depth;
  let bestDx = 0, bestDy = 0, bestGrad = 0;
  for (let dir = 0; dir < 8; dir++) {
    const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
    const j = ny * t.w + nx;
    if (waterBlock[j] > 0) continue;
    const grad = (s0 - (flowGround(t, j) + t.water[j])) / dist;
    if (grad > bestGrad) { bestGrad = grad; bestDx = dx / dist; bestDy = dy / dist; }
  }
  if (bestGrad <= FLOW_EPS) return { dx: 0, dy: 0, grad: 0 };
  return { dx: bestDx, dy: bestDy, grad: bestGrad };
}

function waterDeathMeta(t, i, depth) {
  const cur = currentAt(t, i, depth);
  const speed = Math.min(CURRENT_MAX, Math.max(0.45, cur.grad * CURRENT_DRAG));
  return { vx: cur.dx * speed, vy: cur.dy * speed, depth: Math.round(depth * 1000) / 1000 };
}

function rainBiasAt(t, world, i) {
  const b = world?.env?._hazardBias;
  if (!b || !t?.w || !t?.h) return 1;
  const tx = i % t.w, ty = (i / t.w) | 0;
  const side = ((tx + 0.5 - t.w / 2) * b.sideX + (ty + 0.5 - t.h / 2) * b.sideY)
    / Math.max(1, Math.max(t.w, t.h) * 0.42);
  const sideBias = 0.72 + smooth01(side + 0.55) * 0.62;
  const local = Math.max(0, 1 - Math.hypot(tx + 0.5 - b.tx, ty + 0.5 - b.ty) / (b.radius || 34));
  return Math.max(0.65, Math.min(1.65, sideBias + local * 0.36));
}

function smooth01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

export function stepWater(world) {
  const t = world.terrain;
  if (!t.waterActive) return;

  // CA mit reduzierter Taktrate (günstig). dtW = vergangene Zeit seit letztem Schritt.
  if ((world.tick % WATER_STEP_TICKS) !== 0) { applyFloodDamage(world, false); return; }
  const dtW = DT * WATER_STEP_TICKS;

  applyFloodDamage(world, true);
  simulateCA(t, dtW, world);
}

function simulateCA(t, dtW, world) {
  const { w, h, water, height, baseWater, waterBlock, sources, waterActive } = t;

  // Regen (Phase 14): Niederschlag verteilt Wasser über die Karte → Pegel steigt sichtbar an,
  // Senken/Gräben füllen sich, Flüsse schwellen. Nach dem Regen fließt Wasser sichtbar talwärts
  // ab; geschlossene Senken behalten ihren Pegel. Deterministisch über world.rng gesampelt.
  const weather = world && world.env ? world.env.weather : 'clear';
  const drought = weather === 'drought';
  const precip = weather === 'rain' || weather === 'storm' || weather === 'fog';
  const solar = world && world.env ? (world.env.solar || 0) : 0;
  const profile = insanityProfile(world);
  const rainInflow = profile.rainInflow ?? profile.rain ?? 1;
  const floodCapFrac = FLOOD_CAP_FRAC * (profile.floodCap ?? 1);
  const sourceSurge = profile.sourceSurge ?? 1;
  const startMelt = profile.startMelt ?? 1;

  // GLOBALER FLUT-DECKEL: profilabhängig darf nur ein Teil der Karte ÜBER Normalpegel
  // geflutet sein. Darüber stoppt zusätzlicher Regenzufluss; vorhandenes Wasser läuft nur
  // sichtbar über die CA weiter. Zählt nur überflutetes LAND (nass, obwohl der
  // Normalpegel trocken ist) — Meer/Flüsse/Seen im Normalzustand zählen nicht.
  // Der volle Scan ist teuer → nur jeder 3. Wasser-Schritt; der Schwellenwert hat genug Puffer.
  if (t._wetCheck == null) t._wetCheck = 0;
  if ((t._wetCheck++ % 3) === 0) {
    let flooded = 0;
    for (let i = 0; i < water.length; i++) if (water[i] > WET_DEPTH && baseWater[i] <= WET_DEPTH) flooded++;
    t._wetFrac = flooded / (w * h);
  }
  const floodCap = (t._wetFrac || 0) > floodCapFrac;
  if (precip && !floodCap) {
    const mult = (weather === 'storm' ? STORM_RAIN_MULT : 1) * rainInflow;
    const drops = (w * h * RAIN_FRAC) | 0;   // skaliert mit der Kartengröße
    for (let k = 0; k < drops; k++) {
      const i = (world.rng() * w * h) | 0;
      if (t.startSafe && t.startSafe[i]) continue; // erhöhte Startterrassen entwässern Regen statt ihn als Flut stehen zu lassen
      if (t.snow && height[i] > SNOW_LINE) continue; // über der Schneegrenze fällt Schnee statt Regen
      const amount = RAIN_DEPTH * mult * RAIN_POOL_MULT * rainBiasAt(t, world, i);
      const sink = rainSinkCell(t, i);
      if (sink !== i) {
        water[i] = Math.min(WATER_MAX_DEPTH, water[i] + amount * RAIN_SINK_LOCAL_FRACTION);
        water[sink] = Math.min(WATER_MAX_DEPTH, water[sink] + amount * (1 - RAIN_SINK_LOCAL_FRACTION));
        waterActive.add(sink);
      } else {
        water[i] = Math.min(WATER_MAX_DEPTH, water[i] + amount);
      }
      waterActive.add(i);
    }
    // Echte Hochseen sammeln Regen über ihre Einzugsfläche: Pegel steigen sichtbar und laufen
    // erst ab, wenn ein natürlicher/gebauter Abfluss tief genug ist.
    if (t.lakeMask) {
      const lakeGain = RAIN_DEPTH * mult * RAIN_LAKE_GAIN;
      for (let i = 0; i < t.lakeMask.length; i++) {
        if (!t.lakeMask[i]) continue;
        water[i] = Math.min(WATER_MAX_DEPTH, water[i] + lakeGain * rainBiasAt(t, world, i));
        waterActive.add(i);
      }
    }
    // Trockentäler und Senken reagieren sichtbar: Regen sammelt sich dort früh, bevor der
    // normale Wasserfluss entscheidet, ob ein Abfluss reicht oder die Fläche flutet.
    if (t.valleys) {
      const valleyGain = RAIN_DEPTH * mult * RAIN_VALLEY_GAIN;
      for (const V of t.valleys) {
        const r = Math.max(2, V.width || 2);
        for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) {
          const nx = V.x + xx, ny = V.y + yy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (Math.hypot(xx, yy) > r + 0.3) continue;
          const i = ny * w + nx;
          if (height[i] <= SEA_LEVEL || height[i] > SNOW_LINE || waterBlock[i] > 0) continue;
          water[i] = Math.min(WATER_MAX_DEPTH, water[i] + valleyGain * rainBiasAt(t, world, i));
          waterActive.add(i);
        }
      }
    }
    // Spurrillen wirken wie kleine Gräben: Regen bleibt dort zuerst stehen und bildet Pfützen.
    if (t.tracks) {
      for (let i = 0; i < t.tracks.length; i++) {
        if (t.startSafe && t.startSafe[i]) continue;
        const tr = t.tracks[i];
        if (tr <= TRACK_PUDDLE_MIN) continue;
        if (t.snow && height[i] > SNOW_LINE) continue;
        water[i] = Math.min(WATER_MAX_DEPTH, water[i] + RAIN_DEPTH * TRACK_RAIN_MULT * mult * tr * rainBiasAt(t, world, i));
        waterActive.add(i);
      }
    }
  } else {
    // Bei trockenem Wetter heilen Spuren und Matsch langsam aus. Nur relevante Zellen anfassen,
    // damit alte Pfützen nach dem Glätten wieder normal ablaufen.
    if (t.tracks || t.mud) {
      const dryMult = (1 + solar * 5) * (drought ? 2.4 : 1);
      for (let i = 0; i < water.length; i++) {
        let changed = false;
        if (t.tracks && t.tracks[i] > 0) {
          const old = t.tracks[i];
          t.tracks[i] = Math.max(0, old - TRACK_DECAY_CLEAR * dryMult);
          changed = old !== t.tracks[i];
        }
        if (t.mud && t.mud[i] > 0) {
          const old = t.mud[i];
          t.mud[i] = Math.max(0, old - MUD_DRY_CLEAR * dryMult);
          changed = changed || old !== t.mud[i];
        }
        if (changed && water[i] > WET_DEPTH) waterActive.add(i);
      }
    }
  }

  if (drought) dryRiverBeds(t, DROUGHT_RIVER_DRAIN * (0.7 + solar * 0.8), waterActive, world);

  // Schneedecke des Zentralbergs (Phase 15): Sonne schmilzt Schnee → Schmelzwasser speist die
  // Bergflüsse (sichtbarer Tageszyklus der Pegel); bei Regen/Gewitter fällt oben Neuschnee.
  const snowCells = t.snowFallIdx || t.snowIdx;
  if (t.snow && snowCells && world && world.env) {
    if ((weather === 'clear' || drought) && solar > 0.25 && !floodCap) {
      // Langsame, gleichmäßige Schmelze: die Kappe braucht MEHRERE Tage Sonne, bis sie abgeräumt
      // ist. Der Rand (tiefe/exponierte Bandzellen unter der Schneegrenze) schmilzt zuerst, das
      // Gipfelzentrum zuletzt — so weicht die weiße Decke sichtbar nach oben zurück. Das
      // Schmelzbudget ist gegen die aktive Schneefläche normiert, damit ein im Sturm gewachsenes
      // Band nicht plötzlich die halbe Karte flutet.
      let factorSum = 0, activeSnow = 0;
      const factors = [];
      for (const i of snowCells) {
        if (t.snow[i] <= 0) continue;
        const f = snowMeltFactor(t, i);
        factors.push([i, f]);
        factorSum += f;
        activeSnow++;
      }
      const budget = Math.min(1, 2400 / Math.max(1, activeSnow));
      const melt = SNOW_MELT * solar * budget;
      const scale = factorSum > 0 ? (activeSnow / factorSum) : 1;
      for (const [i, f] of factors) {
        const m = Math.min(t.snow[i], Math.max(melt * 0.35, melt * f * scale));
        t.snow[i] = t.snow[i] - m < SNOW_PATCH_EPS ? 0 : t.snow[i] - m;
        const waterGain = m * MELT_WATER * (drought ? 0.12 : 1);
        if (waterGain <= 0.00001) continue;
        // Schmelzwasser sammelt sich kurz auf der Zelle; die Schnee-Entwässerung am Ende des
        // Schritts kaskadiert es zum Schneerand hinab (Schnee bleibt nie unter Wasser).
        water[i] = Math.min(WATER_MAX_DEPTH, water[i] + waterGain);
        waterActive.add(i);
      }
    } else if (precip) {
      // Niederschlag oberhalb der Schneefallgrenze fällt als Schnee: die Gipfelkappe wächst und
      // die Schneedecke breitet sich über das Einzugsband talwärts aus (Schneegrenze sinkt). Die
      // Deckelhöhe je Zelle steigt mit der Höhe über SNOW_FALL_LINE — Bandzellen tragen nur dünn,
      // der Gipfel baut die tiefste Decke auf.
      const snowGain = SNOW_FALL * (weather === 'storm' ? 3.0 : 1.8) * rainInflow;
      for (const i of snowCells) {
        const cap = (height[i] - SNOW_FALL_LINE) * SNOW_BAND_CAP;
        if (cap <= 0) continue;
        t.snow[i] = Math.min(cap, t.snow[i] + snowGain);
      }
    }
  }

  // Spielstart: große Schneeschmelze am Zentralberg. Sie beginnt an den unteren Rändern
  // der Schneekappe und den Quellbereichen; der CA verteilt das Wasser danach talwärts in
  // Flüsse, Gräben und geschlossene Senken.
  if (world?.env && !floodCap && !drought && t.startMeltLeft > 0 && t.startMeltCells && t.startMeltCells.length) {
    const fade = Math.max(0.25, t.startMeltLeft / Math.max(1, t.startMeltTotal || 300));
    const meltRate = 0.007 * fade * startMelt;   // gedrosselt: Start-Schmelze füllt Flüsse, flutet aber nicht die Ebenen
    for (const i of t.startMeltCells) {
      const snow = t.snow ? t.snow[i] || 0 : 0;
      const m = Math.min(Math.max(0.0015, snow * 0.08), meltRate);
      if (t.snow && snow > 0) t.snow[i] = Math.max(0, snow - m);
      water[i] = Math.min(WATER_MAX_DEPTH, water[i] + m * MELT_WATER * 1.45);
      waterActive.add(i);
    }
    for (const si of sources) {
      water[si] = Math.min(WATER_MAX_DEPTH, water[si] + WATER_SOURCE_RATE * (0.65 + fade) * startMelt);
      waterActive.add(si);
    }
    t.startMeltLeft--;
  }

  // PERMANENTE FLÜSSE: Die Quellen speisen IMMER — auch bei Flut-Deckel und Trockenheit. Die
  // beiden Hauptflüsse versiegen also nie und entwässern dauerhaft zum Meer. Bei Regen kräftiger
  // (Flüsse schwellen), bei Trockenheit gedrosselt, aber nie null.
  {
    const sourceWeather = weather === 'storm' ? 1 + (2.2 - 1) * sourceSurge
      : weather === 'rain' ? 1 + (1.6 - 1) * sourceSurge
        : drought ? 0.75 : 1;
    const srcRate = WATER_SOURCE_RATE * sourceWeather;
    for (const si of sources) {
      water[si] = Math.min(WATER_MAX_DEPTH, water[si] + srcRate);
      waterActive.add(si);
    }
  }

  if (waterActive.size === 0) return;

  // Angelehnt an die Stable-Fluids-Pipeline aus fluid-three: Zufluss/Advektion zuerst,
  // dann ein lokaler Druck-/Oberflächenausgleich. Hier bewusst als deterministische
  // Skalar-Grid-Simulation statt als WebGL-FBO, damit Server, Tests und Clients gleich laufen.
  // Deterministische, stabile Abarbeitung über Doppelpuffer (Delta).
  // Hydraulisches Flachwassermodell: Oberfläche = Boden + Wassertiefe. Wasser fließt
  // masseerhaltend zu allen tieferen 8-Nachbarn; Diagonalen zählen länger. Überschuss
  // verschwindet erst, wenn er offenes Meer/Rand erreicht oder sehr langsam versickert.
  const active = Int32Array.from(waterActive).sort();
  const delta = new Map();        // idx -> Tiefenänderung
  const bump = (i, d) => delta.set(i, (delta.get(i) || 0) + d);
  const lowerIdx = new Int32Array(8);
  const lowerWeight = new Float64Array(8);

  for (let k = 0; k < active.length; k++) {
    const i = active[k];
    if (!shouldSimulateWater(t, i)) continue;
    const protectedDepth = (isOpenSeaCell(t, i) || (t.lakeMask && t.lakeMask[i])) ? baseWater[i] : 0;
    let avail = Math.max(0, water[i] - protectedDepth);
    if (avail <= 0) continue;
    const gi = flowGround(t, i);
    const si = gi + water[i]; // eigene Oberfläche über gerilltem Boden
    const hasDownhillGround = hasDownhillGroundNeighbor(t, i, gi);
    // Tiefer liegende, nicht gesperrte Nachbarn sammeln.
    const blockedI = waterBlock[i] > 0;
    let lowerCount = 0, headSum = 0, maxGroundDrop = 0, blockedUphill = false;
    let surfaceSum = si, surfaceCount = 1;
    const x = i % w, y = (i / w) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (blockedI || waterBlock[j] > 0) continue; // Damm/Deich sperrt diese Kante
      const gj = flowGround(t, j);
      const sj = gj + water[j];
      const head = (si - sj) / dist;
      if (head > FLOW_EPS) {
        const groundDrop = (gi - gj) / dist;
        if (!canFlowAcrossGround(t, i, j, gi, gj, water[i], hasDownhillGround)) {
          blockedUphill = true;
          continue;
        }
        const gravityBias = groundDrop >= 0
          ? 1 + Math.min(1.8, groundDrop * DOWNHILL_FLOW_BIAS)
          : Math.max(0.35, 1 + groundDrop * UPHILL_FLOW_BIAS);
        const weight = (head / dist) * gravityBias;
        lowerIdx[lowerCount] = j;
        lowerWeight[lowerCount] = weight;
        lowerCount++;
        headSum += weight;
        maxGroundDrop = Math.max(maxGroundDrop, groundDrop);
        surfaceSum += sj;
        surfaceCount++;
      }
    }
    if (lowerCount > 0) {
      // Flaches Wasser fließt träger; hohe Gefälle/mehr Tiefe laufen spürbar schneller.
      const mobility = Math.min(1, Math.max(FLOW_MIN_MOBILITY, avail / Math.max(FLOW_FULL_MOBILITY_DEPTH, 0.026)));
      // Wasserdruck: tiefe Säule (avail) → höherer Druck → schnellerer ABFLUSS bergab. Nur bei
      // echtem Bodengefälle (talwärts) angewandt — reine Oberflächen-Angleichung/Überlauf über einen
      // Rücken (kein/negatives Gefälle) bleibt unbeschleunigt, damit Stau-/Umleitungs-Mechanik stabil
      // bleibt. out ist weiter durch flowCap/avail gedeckelt → masseerhaltend.
      const pressure = maxGroundDrop > 0.004 ? pressureFactor(avail) : 1;
      const basinDamping = (t.lakeMask && t.lakeMask[i]) ? 0.18 : 1;
      const equalizeCap = Math.max(0, si - surfaceSum / surfaceCount) * 0.82;
      const flowCap = Math.min(avail, equalizeCap + maxGroundDrop * SLOPE_FLOW_RELIEF);
      const directedBoost = blockedUphill && maxGroundDrop > 0
        ? Math.min(DIRECTED_RUNOFF_BOOST_MAX, 1.12 + maxGroundDrop * 22)
        : 1;
      const out = Math.min(avail, flowCap, headSum * 0.72 * WATER_FLOW * mobility * pressure * basinDamping * directedBoost);
      if (out > SETTLE_EPS) {
        for (let n = 0; n < lowerCount; n++) {
          const j = lowerIdx[n];
          const q = out * (lowerWeight[n] / headSum);
          bump(i, -q);
          bump(j, q);
        }
      }
    }
  }

  // Delta anwenden, Meer-/Randabfluss, extrem langsame Versickerung, neue aktive Menge bestimmen.
  const next = new Set();
  const touched = new Set(active);
  const changed = new Set();
  for (const [i, d] of delta) {
    touched.add(i);
    water[i] = Math.min(WATER_MAX_DEPTH, Math.max(0, water[i] + d));
    if (Math.abs(d) > SETTLE_EPS && shouldSimulateWater(t, i)) {
      changed.add(i);
      markActive(t, next, i);
    }
  }
  const relaxed = relaxWaterSurface(t, changed, touched);
  if (relaxed.size) relaxWaterSurface(t, relaxed, touched);
  for (const i of touched) {
    const excess = water[i] - baseWater[i];
    if (t.startSafe && t.startSafe[i] && excess > SETTLE_EPS) {
      water[i] = Math.max(baseWater[i], water[i] - excess * 0.72);
      if (water[i] > baseWater[i] + WET_DEPTH * 0.25) markActive(t, next, i);
    } else if (isOpenSeaCell(t, i) && excess > SETTLE_EPS) {
      water[i] = Math.max(baseWater[i], water[i] - excess * SEA_DRAIN);
      if (water[i] > baseWater[i] + SETTLE_EPS) markActive(t, next, i);
    } else if (isEdgeCell(t, i) && excess > SETTLE_EPS && flowGround(t, i) + water[i] > SEA_LEVEL) {
      water[i] = Math.max(baseWater[i], water[i] - excess * EDGE_DRAIN);
      if (water[i] > baseWater[i] + SETTLE_EPS) markActive(t, next, i);
    } else if (excess > SETTLE_EPS) {
      // KEINE Versickerung: stehendes Wasser nimmt nie unsichtbar ab. Es bleibt liegen, bis es
      // über die CA talwärts abfließt (Gefälle) oder am Meer/Rand austritt. Eine VOLLE Senke läuft
      // damit zwangsläufig über — der Pegel kann nicht sinken, also steigt er weiter, bis er die
      // niedrigste Kante übersteigt und das Wasser über die CA in die Nachbarzelle (und weiter zum
      // Meer) fließt. Nur dünne, unsichtbare Restfeuchte (unter der Fließschwelle) auf
      // meeresverbundenem Boden läuft über settleWaterComponents/drainOutletComponent als
      // Oberflächenabfluss ab — sichtbares Wasser bleibt davon unberührt.
      const lake = t.lakeMask && t.lakeMask[i];
      const outflow = hasOutflow(t, i, FLOW_EPS);
      const thinMoisture = !lake && baseWater[i] <= FLOW_DEPTH_EPS && water[i] <= FLOW_DEPTH_EPS;
      if (lake || (!thinMoisture && outflow)) markActive(t, next, i);
    } else if (water[i] < baseWater[i] - SETTLE_EPS) {
      // Unter Seehöhe (trockengelegt): nur aktiv bleiben, wenn ein Nachbar tatsächlich höher
      // steht (Zufluss möglich) — sonst schlafen legen; jede Nachbar-Änderung weckt die Zelle
      // ohnehin über markActive. Ohne diese Prüfung blieb fast die GANZE Karte dauerhaft im
      // CA aktiv (34k Zellen → Sortier-/Delta-Kosten in jedem Wasser-Schritt).
      const si = height[i] + water[i];
      const x = i % w, y = (i / w) | 0;
      let inflow = false;
      for (let dir = 0; dir < 8; dir++) {
        const dx = DIR_X[dir], dy = DIR_Y[dir];
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (height[j] + water[j] > si + SETTLE_EPS) { inflow = true; break; }
      }
      if (inflow) markActive(t, next, i);
    }
  }
  settleWaterComponents(t, next);
  erodePooledWater(t, active, dtW, next);
  drainSnowCaps(t, next);
  // Quellen bleiben wach; Meer- und Randabfluss passieren oben beim Wasserbilanz-Schritt.
  for (const si of sources) markActive(t, next, si);

  t.waterActive = next;
}

function settleWaterComponents(t, next) {
  const { w, h, water, waterBlock } = t;
  if (!w || !h || !water) return;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  const cells = [];
  const poolCells = [];

  for (let start = 0; start < n; start++) {
    if (seen[start] || (water[start] || 0) <= POOL_COMPONENT_DEPTH || isOpenSeaCell(t, start)) continue;
    seen[start] = 1;
    stack.length = 0;
    cells.length = 0;
    poolCells.length = 0;
    stack.push(start);
    let minSurface = flowGround(t, start) + water[start];
    let poolMaxSurface = -Infinity;
    let poolMinSurface = Infinity;
    let outlet = isEdgeCell(t, start) || isMainRiverCell(t, start);
    let touchesBlock = (waterBlock?.[start] || 0) > 0;

    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const s = flowGround(t, cur) + water[cur];
      minSurface = Math.min(minSurface, s);
      if (water[cur] > POOL_FLAT_DEPTH) {
        poolCells.push(cur);
        poolMaxSurface = Math.max(poolMaxSurface, s);
        poolMinSurface = Math.min(poolMinSurface, s);
      }
      outlet = outlet || isEdgeCell(t, cur) || isMainRiverCell(t, cur);
      touchesBlock = touchesBlock || (waterBlock?.[cur] || 0) > 0;
      const x = cur % w, y = (cur / w) | 0;
      for (let dir = 0; dir < 8; dir++) {
        const dx = DIR_X[dir], dy = DIR_Y[dir];
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if ((waterBlock?.[cur] || 0) > 0 || (waterBlock?.[j] || 0) > 0) {
          touchesBlock = true;
          continue;
        }
        if (isOpenSeaCell(t, j)) continue;
        if (seen[j] || (water[j] || 0) <= POOL_COMPONENT_DEPTH) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }

    if (!cells.length) continue;
    if (!outlet && !touchesBlock) outlet = componentHasDrainPathToSea(t, cells, minSurface);
    if (outlet) drainOutletComponent(t, cells, next);
    else if (poolCells.length > 1 && poolMaxSurface - poolMinSurface > POOL_LEVEL_EPS) {
      equalizeStandingComponent(t, poolCells, next);
    }
  }
}

function componentHasDrainPathToSea(t, cells, level) {
  const { w, h, waterBlock } = t;
  if (!cells.length || level <= SEA_LEVEL + FLOW_EPS) return false;
  const seen = new Uint8Array(w * h);
  const queue = [];
  for (const i of cells) {
    seen[i] = 1;
    queue.push(i);
  }
  let head = 0;
  while (head < queue.length && queue.length < DRAIN_SEARCH_LIMIT) {
    const cur = queue[head++];
    const x = cur % w, y = (cur / w) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const dx = DIR_X[dir], dy = DIR_Y[dir];
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true;
      const j = ny * w + nx;
      if (seen[j]) continue;
      if ((waterBlock?.[cur] || 0) > 0 || (waterBlock?.[j] || 0) > 0) return false;
      if (canDrainIntoOutlet(t, j, level)) return true;
      if (flowGround(t, j) > level - FLOW_EPS) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return false;
}

// Meeresverbundene Komponente: SICHTBAR fließendes Wasser (über der CA-Schwelle mit Gefälle) wird
// NICHT angetastet — das transportiert die normale CA talwärts zum Meer. Nur die dünne, nicht mehr
// CA-fließfähige Restfeuchte wird abgegeben, jetzt aber SEHR langsam (OPEN_RUNOFF_DRAIN stark
// gesenkt), damit Wasser kaum noch „verschwindet" und stattdessen über die CA Richtung Meer wandert.
// (Greedy-Steepest-Descent-Routing wurde verworfen: es leitet Wasser an Senken VORBEI und brach die
// „Graben → Becken umleiten"-Mechanik; die sichtbare Bach-bis-zum-Meer-Optik macht der Client.)
function drainOutletComponent(t, cells, next) {
  const { water, baseWater } = t;
  for (const i of cells) {
    if (isMainRiverCell(t, i) || isOpenSeaCell(t, i)) continue;
    if ((water[i] || 0) > POOL_FLAT_DEPTH) continue;
    const base = baseWater?.[i] || 0;
    const excess = (water[i] || 0) - base;
    if (excess <= SETTLE_EPS) continue;
    if ((water[i] || 0) > FLOW_DEPTH_EPS && hasOutflow(t, i, FLOW_EPS)) { markActive(t, next, i); continue; }
    const drain = Math.min(excess, Math.max(excess * OPEN_RUNOFF_DRAIN, OPEN_RUNOFF_MIN));
    if (drain <= SETTLE_EPS) continue;
    water[i] = Math.max(base, water[i] - drain);
    markActive(t, next, i);
  }
}

function equalizeStandingComponent(t, cells, next) {
  const { water, baseWater } = t;
  let mass = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of cells) {
    const base = baseWater?.[i] || 0;
    const ground = flowGround(t, i);
    mass += water[i] || 0;
    lo = Math.min(lo, ground + base);
    hi = Math.max(hi, ground + (water[i] || 0));
  }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo + POOL_LEVEL_EPS) return;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) * 0.5;
    let volume = 0;
    for (const i of cells) volume += Math.max(baseWater?.[i] || 0, mid - flowGround(t, i));
    if (volume > mass) hi = mid; else lo = mid;
  }
  const level = (lo + hi) * 0.5;
  for (const i of cells) {
    const base = baseWater?.[i] || 0;
    const target = Math.min(WATER_MAX_DEPTH, Math.max(base, level - flowGround(t, i)));
    if (Math.abs((water[i] || 0) - target) <= POOL_LEVEL_EPS) continue;
    water[i] = target;
    markActive(t, next, i);
  }
}

function relaxWaterSurface(t, seeds, touched) {
  const { w, h, water, baseWater, waterBlock } = t;
  const active = Array.from(seeds).sort((a, b) => a - b);
  const delta = new Map();
  const relaxed = new Set();
  const bump = (i, d) => delta.set(i, (delta.get(i) || 0) + d);
  for (const i of active) {
    if (!shouldSimulateWater(t, i)) continue;
    if (waterBlock[i] > 0) continue;
    const protectedDepth = (isOpenSeaCell(t, i) || (t.lakeMask && t.lakeMask[i])) ? baseWater[i] : 0;
    const avail = Math.max(0, water[i] - protectedDepth);
    if (avail <= SETTLE_EPS) continue;
    const gi = flowGround(t, i);
    const si = gi + water[i];
    const hasDownhillGround = hasDownhillGroundNeighbor(t, i, gi);
    const x = i % w, y = (i / w) | 0;
    let spent = 0;
    for (let dir = 0; dir < 8; dir++) {
      const dx = DIR_X[dir], dy = DIR_Y[dir], dist = DIR_DIST[dir];
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (waterBlock[j] > 0) continue;
      const gj = flowGround(t, j);
      if (!canFlowAcrossGround(t, i, j, gi, gj, water[i], hasDownhillGround)) continue;
      const sj = gj + water[j];
      const gap = si - sj;
      if (gap <= FLOW_EPS * 2) continue;
      const q = Math.min(avail - spent, (gap * SURFACE_RELAX) / dist);
      if (q <= SETTLE_EPS) continue;
      bump(i, -q);
      bump(j, q);
      relaxed.add(i);
      relaxed.add(j);
      spent += q;
      if (avail - spent <= SETTLE_EPS) break;
    }
  }
  for (const [i, d] of delta) {
    water[i] = Math.min(WATER_MAX_DEPTH, Math.max(0, water[i] + d));
    touched.add(i);
  }
  return relaxed;
}

function dryRiverBeds(t, amount, waterActive, world) {
  if (!t.riverPaths || amount <= 0) return;
  const seen = new Set();
  for (const path of t.riverPaths) for (const pi of path) {
    const x = pi % t.w, y = (pi / t.w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(t, nx, ny) || Math.hypot(dx, dy) > 2.25) continue;
      const i = tIdx(t, nx, ny);
      if (seen.has(i)) continue;
      seen.add(i);
      if (t.height[i] <= SEA_LEVEL + 0.015 || (t.lakeMask && t.lakeMask[i])) continue;
      const before = t.water[i] || 0;
      if (before <= 0) continue;
      // Nur ÜBERSCHUSS über dem Grundpegel abtragen: die beiden Hauptflüsse (baseWater>0 entlang
      // der Rinne) schrumpfen in der Trockenphase, versiegen aber nie — sie führen dauerhaft Wasser.
      t.water[i] = Math.max(t.baseWater[i] || 0, before - amount * rainBiasAt(t, world, i));
      if (Math.abs(t.water[i] - before) > SETTLE_EPS) markActive(t, waterActive, i);
    }
  }
}

function groundSlope(t, i) {
  const x = i % t.w;
  let s = 0;
  if (x > 0) s = Math.max(s, Math.abs(t.height[i] - t.height[i - 1]));
  if (x < t.w - 1) s = Math.max(s, Math.abs(t.height[i] - t.height[i + 1]));
  if (i >= t.w) s = Math.max(s, Math.abs(t.height[i] - t.height[i - t.w]));
  if (i < t.w * (t.h - 1)) s = Math.max(s, Math.abs(t.height[i] - t.height[i + t.w]));
  return s;
}

function erodePooledWater(t, active, dtW, next) {
  if (!active.length || !t.height || !t.water) return;
  const maxCells = 96;
  const start = (t._erosionCursor || 0) % active.length;
  let changed = 0;
  for (let n = 0; n < active.length && changed < maxCells; n++) {
    const i = active[(start + n) % active.length];
    if (t.startSafe && t.startSafe[i]) continue;
    if (t.waterBlock && t.waterBlock[i] > 0) continue;
    const depth = t.water[i] || 0;
    const excess = depth - (t.baseWater?.[i] || 0);
    if (depth < WATER_ERODE_DEPTH || excess < WATER_ERODE_EXCESS) continue;
    if (t.height[i] <= SEA_LEVEL - 0.02 && (t.baseWater?.[i] || 0) > WET_DEPTH) continue; // offenes Meer nicht vertiefen
    const cur = currentAt(t, i, depth);
    const stalled = cur.grad < 0.010;
    if (stalled && !hasErosionOutlet(t, i, flowGround(t, i) + depth)) continue;
    if (!stalled && depth < WATER_ERODE_DEPTH * 1.55) continue;
    const slopeBoost = 1 + Math.min(2, groundSlope(t, i) * 10);
    const amt = Math.min(WATER_ERODE_MAX_STEP, (depth - WATER_ERODE_DEPTH) * WATER_ERODE_RATE * dtW * slopeBoost * (stalled ? 1.25 : 0.6));
    if (amt <= 0.00003) continue;
    applyHeightDelta(t, i, amt, false);
    t.water[i] = Math.min(WATER_MAX_DEPTH, depth + amt * 0.65);
    markActive(t, next, i);
    wakeWaterAround(t, i % t.w, (i / t.w) | 0, 1, 2);
    changed++;
  }
  t._erosionCursor = (start + Math.max(1, Math.floor(active.length / 5))) % active.length;
}

function hasErosionOutlet(t, i, level) {
  if (isOpenSeaCell(t, i) || isMainRiverCell(t, i) || isEdgeCell(t, i)) return true;
  return componentHasDrainPathToSea(t, [i], level);
}

// Schnee bleibt trocken: am Ende jedes Wasser-Schritts kaskadiert sämtliches Wasser, das auf
// verschneiten Gipfelzellen liegt, zum tiefsten Nachbarn hinab. Die Schneezellen werden dabei
// von hoch nach tief abgearbeitet, sodass Schmelzwasser in EINEM Schritt bis an den Schneerand
// (und von dort als normaler Fluss weiter ins Tal) läuft. Das ist die Terrain-Variante der
// fluid-three-Advektion: Masse wird talwärts getragen, ohne Schnee als Wasserfläche zu zeichnen.
function drainSnowCaps(t, next) {
  if (!t.snow || !t.snowIdx || !t.snowIdx.length) return;
  if (!t._snowDrainOrder) {
    t._snowDrainOrder = Array.from(t.snowIdx).sort((a, b) => t.height[b] - t.height[a]);
  }
  const { w, h, water, height } = t;
  for (const i of t._snowDrainOrder) {
    if (height[i] <= SNOW_LINE || t.snow[i] <= 0.02 || water[i] <= 0) continue;
    // Tiefster Nachbar nach GELÄNDEHÖHE (nicht Oberfläche). Da die Schneezellen von hoch nach
    // tief abgearbeitet werden und Wasser immer in eine niedrigere Höhe wandert, kaskadiert das
    // Schmelzwasser in EINEM Durchlauf bis zum Schneerand und von dort als normaler Fluss weiter.
    const x = i % w, y = (i / w) | 0;
    let low = -1, lowH = height[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (height[j] < lowH) { lowH = height[j]; low = j; }
    }
    if (low < 0) { water[i] = 0; continue; } // echte Gipfelsenke: Schmelzwasser verdunstet, Schnee bleibt trocken
    water[low] = Math.min(WATER_MAX_DEPTH, water[low] + water[i]);
    water[i] = 0;
    markActive(t, next, low);
  }
}

function snowMeltFactor(t, i) {
  const { w, h, height, snow } = t;
  const x = i % w, y = (i / w) | 0;
  let edgeWeight = 0, totalWeight = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const diag = dx !== 0 && dy !== 0;
    const ww = diag ? 0.7 : 1;
    totalWeight += ww;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) { edgeWeight += ww; continue; }
    const j = ny * w + nx;
    if (height[j] <= SNOW_LINE || snow[j] <= 0.005) edgeWeight += ww;
  }
  const exposed = totalWeight > 0 ? edgeWeight / totalWeight : 0;
  const elevation = Math.max(0, Math.min(1, (height[i] - SNOW_LINE) / Math.max(0.001, 1 - SNOW_LINE)));
  return 0.75 + exposed * 2.0 + (1 - elevation) * 0.9;
}

function markActive(t, set, i) {
  const { w, h } = t;
  set.add(i);
  const x = i % w;
  if (x > 0) set.add(i - 1);
  if (x < w - 1) set.add(i + 1);
  if (i - w >= 0) set.add(i - w);
  if (i + w < w * h) set.add(i + w);
}

// Landeinheiten in gefluteten Zellen ertrinken; starke Strömung reißt Fußtruppen tödlich mit.
// Fahrzeuge werden langsamer verdriftet und gehen erst in echtem Tiefwasser kaputt.
// Dauerhaft überflutete Gebäude verfallen nach und nach. Luft/See/Amphibien sicher.
function applyFloodDamage(world, didStep) {
  if (!didStep) return;
  const t = world.terrain;
  const dtW = DT * WATER_STEP_TICKS;
  for (const e of world.entities.values()) {
    if (e.dead) continue;
    if (e.etype === 'building') {
      // Gebäude im Wasser: nach Schonfrist kontinuierlicher Verfall — ABER Infrastruktur ist immun:
      // Brücken, Pipelines, Straßen und Tunnel werden vom Wasser NICHT weggespült/zerstört
      // (eine überflutete Straße/Leitung bleibt bestehen; Wasserbauten ohnehin).
      const def = e.def || {};
      if (def.buildOnWater || def.requiresWater || def.bridges || def.pipe || def.roadBuilt
        || def.tunnels || def.waterOptional || def.role === 'infrastructure') { e._wetSince = null; continue; }
      const ci = tIdx(t, e.tx + ((e.size / 2) | 0), e.ty + ((e.size / 2) | 0));
      const depth = t.water[ci] || 0;
      if (depth > WET_DEPTH) {
        if (e._wetSince == null) e._wetSince = world.time;
        else if (world.time - e._wetSince > BUILDING_FLOOD_GRACE) {
          applyDamage(world, e, BUILDING_FLOOD_DPS * dtW, null, 'water', waterDeathMeta(t, ci, depth));
        }
      } else e._wetSince = null;
      continue;
    }
    if (e.etype !== 'unit') continue;
    if (e.domain === 'air') continue;
    const [tx, ty] = worldToTile(e.x, e.y);
    if (!inBounds(t, tx, ty)) continue;
    const ci = tIdx(t, tx, ty);
    const depth = t.water[ci];
    // Strömung: fließendes Wasser (Oberflächengefälle) reißt Einheiten flussabwärts —
    // Fußtruppen voll, Fahrzeuge gedämpft, Schiffe abgeschwächt (Motorkraft hält dagegen).
    let currentSpeed = 0;
    let infantryWashedAway = false;
    if (depth > CURRENT_MIN_DEPTH) {
      const cur = currentAt(t, ci, depth, world);
      if (cur.grad > 0) {
        const floatingSurfaceShip = cur.seaStorm && (e.domain === 'water' || e.domain === 'amphibious') && !e.submerged;
        const landVehicle = e.domain === 'land' && e.category !== 'infantry';
        const resistance = e.heavy ? CURRENT_HEAVY_RESIST : landVehicle ? CURRENT_VEHICLE_RESIST : 0;
        const domainMult = floatingSurfaceShip ? 0.95
          : e.domain === 'water' || e.domain === 'amphibious' ? 0.35
          : builderWaterWork(e, depth) ? 0.28
            : e.heavy ? 0.24
              : landVehicle ? 0.55
                : (depth > FLOOD_DEPTH ? 1.35 : 1.15);
        currentSpeed = cur.speed ?? cur.grad * CURRENT_DRAG;
        const driftSpeed = Math.max(0, Math.min(CURRENT_MAX, currentSpeed) - resistance);
        const drift = driftSpeed * dtW * domainMult;
        const nx = e.x + cur.dx * drift, ny = e.y + cur.dy * drift;
        let canDrift = true;
        if (e.domain === 'water' || e.domain === 'amphibious') {
          const [ntx, nty] = worldToTile(nx, ny);
          canDrift = false;
          if (inBounds(t, ntx, nty)) {
            const ni = tIdx(t, ntx, nty);
            canDrift = t.type?.[ni] === TT.WATER || (t.water[ni] || 0) > CURRENT_MIN_DEPTH;
          }
        }
        if (canDrift) {
          e.x = nx; e.y = ny;
          e.inFlood = world.tick;
          infantryWashedAway = e.domain === 'land'
            && e.category === 'infantry'
            && currentSpeed >= CURRENT_INFANTRY_WASH_SPEED
            && drift >= CURRENT_WASH_DRIFT_MIN;
        }
      }
    }
    if (infantryWashedAway) {
      applyDamage(world, e, e.hp + 9999, null, 'water', waterDeathMeta(t, ci, depth));
      continue;
    }
    if (e.domain === 'water' || e.domain === 'amphibious') continue;
    if (e.category !== 'infantry' && depth > VEHICLE_DEEP_WATER_DAMAGE_DEPTH && !builderWaterWork(e, depth)) {
      const sev = Math.min(1, (depth - VEHICLE_DEEP_WATER_DAMAGE_DEPTH) / (WATER_MAX_DEPTH - VEHICLE_DEEP_WATER_DAMAGE_DEPTH));
      applyDamage(world, e, HEAVY_WATER_DPS * dtW * (0.45 + sev), null, 'water', waterDeathMeta(t, ci, depth));
      e.inFlood = world.tick;
      continue;
    }
    if (e.category === 'infantry' && depth > FLOOD_DEPTH) {
      // Schaden skaliert mit Tiefe; markiert Einheit als „im Wasser" für Verlangsamung.
      const sev = Math.min(1, (depth - FLOOD_DEPTH) / (WATER_MAX_DEPTH - FLOOD_DEPTH));
      applyDamage(world, e, FLOOD_DPS * dtW * (0.4 + sev), null, 'water', waterDeathMeta(t, ci, depth));
      e.inFlood = world.tick;
    }
  }
}

function builderWaterWork(e, depth) {
  if (e.kind !== 'builder' || e.domain !== 'land' || depth > BUILDER_WADE_DEPTH) return false;
  const workOrder = e.order?.type === 'construct' || e.order?.type === 'terra';
  return e._fleeing || (workOrder && (e._wadeTime || 0) <= BUILDER_WADE_TIME);
}
