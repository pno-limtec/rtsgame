// Weltzustand + gemeinsame Hilfsfunktionen (Spawning, Abfragen, Spatial-Hash, Schaden).
import { generateTerrain, worldToTile, tileToWorld, TT, tIdx, inBounds, stampOre, coverAt, stampFortification, unstampFortification, hasWaterNear, isNavigableWater, isFreshWater, isPassable, softenRiverBanks, stabilizeWaterTerrain, enforceDrainageToSea } from './terrain.js';
import { makeRng } from './rng.js';
import {
  TILE, DEFAULT_MAP, SUB_DETECT_RANGE, GARRISON_DAMAGE_MULT,
  SLOPE_INFANTRY, SLOPE_VEHICLE, SLOPE_HEAVY, SLOPE_BUILDER, FOG_SIGHT_MULT, WET_DEPTH, SEA_LEVEL, SNOW_LINE,
} from './constants.js';
import { initVet, awardXp, killValue, DEFAULT_VET } from './systems/veterancy.js';

let _gid = 1;
const START_RIVER_CLEARANCE = 18;
const START_SUPPORT_RIVER_CLEARANCE = 10;
const BUILD_ANCHOR_RANGE = 7;
const ANCHORED_BUILD_ROLES = new Set(['logistics', 'defense', 'production']);

export function setNextEntityId(id) {
  const n = Math.max(1, Math.floor(Number(id) || 1));
  _gid = n;
}

export function createWorld({ data, seed = 1, map = DEFAULT_MAP, players = [] }) {
  const terrain = generateTerrain({ w: map.w, h: map.h, seed });
  const world = {
    tick: 0, time: 0, data, seed, terrain,
    vet: data.veterancy || DEFAULT_VET,
    rng: makeRng(seed ^ 0x9e3779b9),
    entities: new Map(),
    players: [],
    tunnels: [],          // verknüpfte Tunnel-Strukturen (zwei Mündungen + Röhre)
    tunnelTiles: new Map(),// Tile-Index → Tunnel-Record (nur Innen-Tiles, für verdeckte Durchquerung)
    projectiles: [],
    events: [],          // flüchtige Effekt-Events für Clients (pro Snapshot geleert)
    spatial: null,
    map,
  };

  // Spieler initialisieren (Ressourcen aus data.resources).
  players.forEach((p, i) => {
    const res = {};
    for (const [k, v] of Object.entries(data.resources)) res[k] = v.start || 0;
    world.players.push({
      id: p.id ?? i, name: p.name || `Spieler ${i + 1}`,
      faction: p.faction || 'KBN',
      controller: p.controller || 'ai',
      color: (data.factions[p.faction || 'KBN'] || {}).color || '#cccccc',
      resources: res, defeated: false,
      energy: { produced: 0, consumed: 0, ratio: 1 },
      ai: null,
    });
  });

  placeStartBases(world);
  softenRiverBanks(terrain);
  ensureInterbaseBarriers(world); // Zwischen Basen liegen natürliche Sperren statt neutraler Abkürzungen.
  stabilizeWaterTerrain(terrain.height, terrain.w, terrain.h, terrain.water, terrain.baseWater, terrain.height0, terrain.terra);
  enforceDrainageToSea(terrain);
  return world;
}

// Zwischen benachbarten Startbasen soll nicht einfach glattes Fahrgelände liegen:
// die direkte Route führt durch Canyons und teils über Wasserläufe. Überquerungen bleiben
// möglich, aber erfordern Infrastruktur, Umwege, Luft/See oder Risiko bei Wetter/Lawinen.
function ensureInterbaseBarriers(world) {
  const { terrain: t } = world;
  const hqs = [];
  for (const e of world.entities.values()) if (e.kind === 'hq') hqs.push(e);
  hqs.sort((a, b) => a.owner - b.owner);
  const pairs = hqs.length === 2 ? 1 : hqs.length;
  const stamped = new Set();
  for (let i = 0; i < pairs; i++) {
    const a = hqs[i], b = hqs[(i + 1) % hqs.length];
    if (a === b) continue;
    stampInterbaseCanyon(t, hqs, a, b, i, stamped);
    if ((i % 2) === 0) stampInterbaseRiver(t, hqs, a, b, i, stamped);
  }
  // Die gestanzten Canyon-/Fluss-Korridore abrunden: ihre harten, terrassierten Wände sind sonst
  // scharfkantig. stabilizeWaterTerrain (gleich danach in createWorld) gleicht die Flusstiefe wieder an.
  smoothBarrierCorridors(t, stamped);
  t.oreList = [];
  for (let i = 0; i < t.ore.length; i++) if (t.ore[i] > 0) t.oreList.push(i);
  if (t.oil) {
    t.oilList = [];
    for (let i = 0; i < t.oil.length; i++) if (t.oil[i] > 0) t.oilList.push(i);
  }
}

function stampInterbaseCanyon(t, hqs, a, b, pairIndex, stamped = null) {
  const ax = a.tx + a.size / 2, ay = a.ty + a.size / 2;
  const bx = b.tx + b.size / 2, by = b.ty + b.size / 2;
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 24) return;
  const ux = dx / dist, uy = dy / dist, px = -uy, py = ux;
  const start = Math.max(15, dist * 0.22), end = dist - start;
  const phase = pairIndex * 1.9 + dist * 0.03;
  const valleys = t.valleys || (t.valleys = []);
  const maxR = Math.hypot(t.w / 2, t.h / 2);
  for (let s = start; s <= end; s += 1) {
    const wiggle = Math.sin(s * 0.13 + phase) * 1.4;
    const cx = ax + ux * s + px * wiggle;
    const cy = ay + uy * s + py * wiggle;
    for (let side = -4; side <= 4; side++) {
      const x = Math.round(cx + px * side);
      const y = Math.round(cy + py * side);
      if (barrierProtected(t, hqs, x, y)) continue;
      const i = tIdx(t, x, y);
      const abs = Math.abs(side);
      if (stamped) stamped.add(i);
      clearBarrierResources(t, i);
      if (abs <= 1) {
        const rn = Math.min(1, Math.hypot(x + 0.5 - t.w / 2, y + 0.5 - t.h / 2) / maxR);
        const seaSlope = Math.max(SEA_LEVEL + 0.055, SEA_LEVEL + 0.34 - rn * 0.30);
        const target = Math.max(SEA_LEVEL + 0.055, Math.min(t.height[i] - 0.075, seaSlope));
        setBaseHeight(t, i, target);
        t.type[i] = target > 0.56 ? TT.HILL : TT.LAND;
        t.water[i] = Math.min(t.water[i], WET_DEPTH * 0.35);
        t.baseWater[i] = Math.min(t.baseWater[i], WET_DEPTH * 0.25);
        if (t.lakeMask) t.lakeMask[i] = 0;
        if (t.waterActive) t.waterActive.add(i);
        if ((Math.round(s) % 13) === 0 && abs === 0) valleys.push({ x, y, level: target, floodFrom: target + 0.20 });
      } else {
        const wall = Math.min(1.05, Math.max(t.height[i], SEA_LEVEL + 0.34 + (abs - 2) * 0.075));
        setBaseHeight(t, i, wall);
        t.type[i] = abs >= 3 ? TT.CLIFF : TT.HILL;
        t.water[i] = 0;
        t.baseWater[i] = 0;
        if (t.lakeMask) t.lakeMask[i] = 0;
        if (t.snow && wall > SNOW_LINE && t.snow[i] <= 0.005) {
          t.snow[i] = (wall - SNOW_LINE) * 2.5;
          if (t.snowIdx && !t.snowIdx.includes(i)) t.snowIdx.push(i);
        }
      }
    }
  }
}

function stampInterbaseRiver(t, hqs, a, b, pairIndex, stamped = null) {
  const ax = a.tx + a.size / 2, ay = a.ty + a.size / 2;
  const bx = b.tx + b.size / 2, by = b.ty + b.size / 2;
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 24) return;
  const ux = dx / dist, uy = dy / dist, px = -uy, py = ux;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const len = Math.min(34, Math.max(16, dist * 0.34));
  const phase = pairIndex * 2.7 + dist * 0.07;
  for (let s = -len; s <= len; s += 1) {
    const wiggle = Math.sin(s * 0.18 + phase) * 0.9;
    const cx = mx + px * s + ux * wiggle;
    const cy = my + py * s + uy * wiggle;
    for (let side = -2; side <= 2; side++) {
      const x = Math.round(cx + ux * side);
      const y = Math.round(cy + uy * side);
      if (barrierProtected(t, hqs, x, y)) continue;
      const i = tIdx(t, x, y);
      if (stamped) stamped.add(i);
      clearBarrierResources(t, i);
      const abs = Math.abs(side);
      if (abs <= 1) {
        const bed = SEA_LEVEL - 0.055 + abs * 0.018;
        setBaseHeight(t, i, Math.min(t.height[i], bed));
        t.type[i] = TT.WATER;
        const depth = Math.max(WET_DEPTH * 2.4, SEA_LEVEL + 0.075 - t.height[i]);
        t.water[i] = Math.max(t.water[i], depth);
        t.baseWater[i] = Math.max(t.baseWater[i], depth * 0.92);
        if (t.waterActive) t.waterActive.add(i);
      } else {
        const bank = Math.max(t.height[i], SEA_LEVEL + 0.08);
        setBaseHeight(t, i, bank);
        if (t.type[i] !== TT.CLIFF) t.type[i] = TT.HILL;
        t.water[i] = Math.min(t.water[i], WET_DEPTH * 0.6);
        t.baseWater[i] = Math.min(t.baseWater[i], WET_DEPTH * 0.5);
      }
      if (t.lakeMask) t.lakeMask[i] = 0;
    }
  }
}

// Gestanzte Barriere-Korridore (Canyon/Fluss) abrunden: scharfe, terrassierte Wände wegglätten.
// Glättet die Korridorzellen PLUS einen 2-Zellen-Saum (damit die Bank weich ins Umland übergeht)
// per gewichtetem 3×3-Gauß; danach Geländetyp aus Höhe+Hang neu ableiten. Wasser bleibt erhalten —
// die Flusstiefe richtet das anschließende stabilizeWaterTerrain wieder ein.
function smoothBarrierCorridors(t, stamped) {
  if (!stamped || !stamped.size) return;
  const { w, h } = t;
  const region = new Set();
  for (const i of stamped) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      region.add(ny * w + nx);
    }
  }
  const list = [...region];
  for (let pass = 0; pass < 4; pass++) {
    const updates = [];
    for (const i of list) {
      const x = i % w, y = (i / w) | 0;
      let sum = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const wt = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0) ? 2 : 1;
        sum += t.height[ny * w + nx] * wt; wsum += wt;
      }
      updates.push([i, sum / wsum]);
    }
    for (const [i, v] of updates) setBaseHeight(t, i, v);
  }
  // Geländetyp neu ableiten (gleiche Schwellen wie generateTerrain); Wasserzellen bleiben Wasser.
  for (const i of list) {
    if ((t.water[i] || 0) > WET_DEPTH) { t.type[i] = TT.WATER; continue; }
    const e = t.height[i];
    const x = i % w;
    let slope = 0;
    if (x > 0) slope = Math.max(slope, Math.abs(e - t.height[i - 1]));
    if (x < w - 1) slope = Math.max(slope, Math.abs(e - t.height[i + 1]));
    if (i >= w) slope = Math.max(slope, Math.abs(e - t.height[i - w]));
    if (i < w * (h - 1)) slope = Math.max(slope, Math.abs(e - t.height[i + w]));
    t.type[i] = e < SEA_LEVEL ? TT.WATER
      : (e > 0.86 || (e > 0.66 && slope > 0.044) || slope > 0.105) ? TT.CLIFF
        : (e > 0.50 || slope > 0.036) ? TT.HILL : TT.LAND;
  }
}

function barrierProtected(t, hqs, x, y) {
  if (!inBounds(t, x, y)) return true;
  const cx = t.w / 2, cy = t.h / 2;
  if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < Math.min(t.w, t.h) * 0.13) return true;
  const i = tIdx(t, x, y);
  if (t.startSafe && t.startSafe[i]) return true;
  for (const hq of hqs) {
    const hx = hq.tx + hq.size / 2, hy = hq.ty + hq.size / 2;
    if (Math.hypot(x + 0.5 - hx, y + 0.5 - hy) < 18) return true;
  }
  return false;
}

function clearBarrierResources(t, i) {
  if (t.ore) t.ore[i] = 0;
  if (t.oil) t.oil[i] = 0;
  if (t.cover) t.cover[i] = 0;
  if (t.coverBuilt) t.coverBuilt[i] = 0;
  if (t.bridge) t.bridge[i] = 0;
  if (t.tunnel) t.tunnel[i] = 0;
  if (t.roadBuilt) t.roadBuilt[i] = 0;
}

function setBaseHeight(t, i, h) {
  const v = Math.max(0.02, Math.min(1.42, h));
  t.height[i] = v;
  if (t.height0) t.height0[i] = v;
  if (t.terra) t.terra[i] = 0;
}

// Startpositionen gleichmäßig am Kartenrand verteilen, Bauhof + Startarmee setzen.
function placeStartBases(world) {
  const { terrain } = world;
  const n = world.players.length;
  const cx = terrain.w / 2, cy = terrain.h / 2;
  // Ring zwischen Zentralberg und Randmeer (Phase 15: Insel-Layout).
  const radius = Math.min(terrain.w, terrain.h) * 0.30;
  const startRiverClearance = riverClearanceForMap(terrain, START_RIVER_CLEARANCE, 6, 0.19);
  const supportRiverClearance = riverClearanceForMap(terrain, START_SUPPORT_RIVER_CLEARANCE, 4, 0.11);
  world.players.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2;
    let tx = Math.round(cx + Math.cos(ang) * radius);
    let ty = Math.round(cy + Math.sin(ang) * radius);
    [tx, ty] = tryBuildableNear(world, tx, ty, 3, { minRiverDist: startRiverClearance })
      || forceDryBuildableNear(world, tx, ty, 3, { minRiverDist: startRiverClearance });
    protectStartTerrace(terrain, tx, ty, 3);
    clearOreAround(terrain, tx + 1.5, ty + 1.5, 8);
    spawnBuilding(world, p.id, 'hq', tx, ty);
    for (const [kind, ox, oy] of [
      ['oil_depot', 6, -2],
    ]) {
      const spot = tryBuildableNear(world, tx + ox, ty + oy, world.data.buildings[kind].size || 1, { minRiverDist: supportRiverClearance });
      if (spot) {
        const dep = spawnBuilding(world, p.id, kind, spot[0], spot[1]);
        dep.buildProgress = 1;
      }
    }

    // Garantiertes Erzfeld in Basisnähe (Richtung Kartenmitte) für sofortige Wirtschaft.
    const towardCenter = Math.atan2(cy - ty, cx - tx);
    const orx = Math.round(tx + Math.cos(towardCenter) * 12);
    const ory = Math.round(ty + Math.sin(towardCenter) * 12);
    stampOre(terrain, orx, ory, 4, 1400);

    // Start-Raffinerie zwischen Basis und Erzfeld.
    const refSpot = tryBuildableNear(world, Math.round(tx + Math.cos(towardCenter) * 6), Math.round(ty + Math.sin(towardCenter) * 6), 3, { minRiverDist: supportRiverClearance });
    if (refSpot) spawnBuilding(world, p.id, 'refinery', refSpot[0], refSpot[1]);

    // kleine Startarmee + 2 Bagger + 2 LKW rund um den Bauhof
    const used = new Set();
    spawnStartUnit(world, p.id, 'truck', tx + 4, ty + 2, used);
    spawnStartUnit(world, p.id, 'truck', tx + 5, ty + 4, used);
    for (let k = 0; k < 2; k++) spawnStartUnit(world, p.id, 'rifleman', tx + 1 + k, ty + 5, used);
    spawnStartUnit(world, p.id, 'engineer', tx + 4, ty + 4, used);
    const oreBuilder = spawnStartUnit(world, p.id, 'builder', tx + 1, ty + 3, used);  // Bagger: errichtet Gebäude und übernimmt Terraforming
    oreBuilder.resourceRole = 'ore';
    const buildBuilder = spawnStartUnit(world, p.id, 'builder', tx + 3, ty + 5, used);
    buildBuilder.resourceRole = 'build';
  });
}

function spawnStartUnit(world, owner, kind, tx, ty, used) {
  const { terrain } = world;
  for (let r = 0; r <= 18; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const nx = tx + x, ny = ty + y, key = nx + ',' + ny;
      if (used.has(key) || !inBounds(terrain, nx, ny) || !isPassable(terrain, 'land', nx, ny)) continue;
      if (terrain.cover && terrain.cover[tIdx(terrain, nx, ny)] >= 0.2) continue;
      used.add(key);
      const [wx, wy] = tileToWorld(nx, ny);
      return spawnUnit(world, owner, kind, wx, wy);
    }
  }
  throw new Error(`Kein trockener Startplatz für ${kind} nahe ${tx},${ty}`);
}

function findBuildableNear(world, tx, ty, size) {
  const spot = tryBuildableNear(world, tx, ty, size);
  if (spot) return spot;
  throw new Error(`Kein trockener Bauplatz nahe ${tx},${ty}`);
}

function tryBuildableNear(world, tx, ty, size, opts = {}) {
  const { terrain } = world;
  const minRiverDist = opts.minRiverDist || 0;
  const maxR = opts.maxR ?? Math.max(32, Math.ceil(Math.max(terrain.w, terrain.h) * 0.35));
  const fits = (x, y) => canPlaceBuilding(world, x, y, size)
    && (!minRiverDist || startSiteClear(terrain, x, y, size, minRiverDist));
  for (let r = 0; r < maxR; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const nx = tx + x, ny = ty + y;
      if (fits(nx, ny)) return [nx, ny];
    }
  }
  let best = null, bestD = Infinity;
  for (let y = 0; y <= terrain.h - size; y++) for (let x = 0; x <= terrain.w - size; x++) {
    if (!fits(x, y)) continue;
    const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
    if (d < bestD) { bestD = d; best = [x, y]; }
  }
  return best;
}

function forceDryBuildableNear(world, tx, ty, size, opts = {}) {
  const { terrain } = world;
  const minRiverDist = opts.minRiverDist || 0;
  let best = null, bestD = Infinity;
  for (let y = 2; y <= terrain.h - size - 2; y++) for (let x = 2; x <= terrain.w - size - 2; x++) {
    if (overlapsBuilding(world, x, y, size)) continue;
    if (minRiverDist && !startSiteClear(terrain, x, y, size, minRiverDist)) continue;
    const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
    if (d < bestD) { bestD = d; best = [x, y]; }
  }
  if (!best && minRiverDist > 0) {
    return forceDryBuildableNear(world, tx, ty, size, { ...opts, minRiverDist: Math.max(0, minRiverDist - 2) });
  }
  if (!best) throw new Error(`Kein Startplatz nahe ${tx},${ty}`);
  dryFootprint(terrain, best[0], best[1], size, 4);
  return best;
}

function riverClearanceForMap(t, maxClearance, minClearance, scale) {
  return Math.min(maxClearance, Math.max(minClearance, Math.floor(Math.min(t.w, t.h) * scale)));
}

function startSiteClear(t, tx, ty, size, minRiverDist) {
  return distanceToRiverPath(t, tx, ty, size) >= minRiverDist
    && !hasInlandWaterNear(t, tx, ty, size, Math.max(4, minRiverDist - 2));
}

function distanceToRiverPath(t, tx, ty, size) {
  const cx = tx + size / 2, cy = ty + size / 2;
  let best = Infinity;
  for (const path of t.riverPaths || []) for (const i of path) {
    const x = i % t.w, y = (i / t.w) | 0;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < best) best = d;
  }
  return best;
}

function hasInlandWaterNear(t, tx, ty, size, radius) {
  const cx = tx + size / 2, cy = ty + size / 2;
  const minX = Math.max(0, Math.floor(cx - radius)), maxX = Math.min(t.w - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius)), maxY = Math.min(t.h - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) continue;
    const i = tIdx(t, x, y);
    if (t.lakeMask && t.lakeMask[i]) return true;
    if (t.type[i] !== TT.WATER && (t.baseWater[i] > WET_DEPTH * 0.8 || t.water[i] > WET_DEPTH * 0.8)) return true;
  }
  return false;
}

function protectStartTerrace(t, tx, ty, size) {
  if (!t.startSafe) t.startSafe = new Uint8Array(t.w * t.h);
  const cx = tx + size / 2, cy = ty + size / 2;
  const core = 9;
  const outer = 17;
  // Umgebungshöhe am äußeren Ring abtasten → der Plateau-Deckel liegt IMMER klar darüber, also ein
  // echtes erhöhtes Plateau (auch bei den jetzt größeren Höhenunterschieden), nicht eine Mulde.
  let sum = 0, cnt = 0;
  for (let a = 0; a < 12; a++) {
    const ax = Math.round(cx + Math.cos(a / 12 * Math.PI * 2) * outer);
    const ay = Math.round(cy + Math.sin(a / 12 * Math.PI * 2) * outer);
    if (inBounds(t, ax, ay)) { sum += t.height[tIdx(t, ax, ay)]; cnt++; }
  }
  const surround = cnt ? sum / cnt : SEA_LEVEL + 0.3;
  const top = Math.min(1.05, Math.max(SEA_LEVEL + 0.40, surround + 0.14)); // ebener, deutlich erhöhter Deckel
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      if (!inBounds(t, x, y)) continue;
      const i = tIdx(t, x, y);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > outer) continue;
      // Ebener Deckel im Kern, sanft (smoothstep) auf die Umgebungshöhe abfallender Rand.
      let target;
      if (d <= core) target = top;
      else { const f = (d - core) / (outer - core); const s = f * f * (3 - 2 * f); target = top * (1 - s) + t.height[i] * s; }
      t.type[i] = TT.LAND;
      t.height[i] = target;
      if (t.height0) t.height0[i] = target;
      if (t.terra) t.terra[i] = 0;
      t.water[i] = 0; t.baseWater[i] = 0;
      if (t.lakeMask) t.lakeMask[i] = 0;
      if (t.waterActive) t.waterActive.delete(i);
      if (d <= core + 1.5) t.startSafe[i] = 1;
      if (t.ore) t.ore[i] = 0;
      if (t.oil) t.oil[i] = 0;
      if (t.cover) t.cover[i] = 0;
    }
  }
  if (t.sources) t.sources = t.sources.filter(i => {
    const x = i % t.w, y = (i / t.w) | 0;
    return Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > outer + 2;
  });
}

function dryFootprint(t, tx, ty, size, pad = 0, minHeight = SEA_LEVEL + 0.14) {
  const minX = Math.max(0, tx - pad), maxX = Math.min(t.w - 1, tx + size - 1 + pad);
  const minY = Math.max(0, ty - pad), maxY = Math.min(t.h - 1, ty + size - 1 + pad);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const i = tIdx(t, x, y);
    t.type[i] = TT.LAND;
    t.height[i] = Math.max(t.height[i], minHeight);
    if (t.height0) t.height0[i] = Math.max(t.height0[i], t.height[i]);
    t.water[i] = 0; t.baseWater[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
    if (t.waterActive) t.waterActive.delete(i);
    if (t.ore) t.ore[i] = 0;
    if (t.oil) t.oil[i] = 0;
    if (t.cover) t.cover[i] = 0;
  }
  if (t.sources) t.sources = t.sources.filter(i => {
    const x = i % t.w, y = (i / t.w) | 0;
    return x < minX || x > maxX || y < minY || y > maxY;
  });
}

function clearOreAround(t, cx, cy, radius) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (!inBounds(t, x, y)) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) t.ore[tIdx(t, x, y)] = 0;
    }
  }
}

function infrastructureCanOverlap(newDef, oldDef) {
  if (!newDef || !oldDef) return false;
  const newPass = !!(newDef.roadBuilt || newDef.bridges || newDef.tunnels);
  const oldPass = !!(oldDef.roadBuilt || oldDef.bridges || oldDef.tunnels);
  return (!!newDef.pipe && oldPass) || (!!oldDef.pipe && newPass);
}

function overlapsBuilding(world, tx, ty, size, def = null) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'building') continue;
    if (!(tx < e.tx + e.size && tx + size > e.tx && ty < e.ty + e.size && ty + size > e.ty)) continue;
    if (infrastructureCanOverlap(def, e.def || world.data.buildings[e.kind])) continue;
    return true;
  }
  return false;
}

export function requiresBuildingAnchor(def) {
  return !!def && (ANCHORED_BUILD_ROLES.has(def.role) || !!def.resourceDepot);
}

function isBuildAnchor(e) {
  if (!e || e.etype !== 'building' || e.dead || e.buildProgress < 1) return false;
  const def = e.def || {};
  if (def.pipe || def.bridges || def.tunnels || def.roadBuilt) return false;
  return !['terrain', 'infrastructure', 'fortification', 'hydro'].includes(def.role);
}

export function hasNearbyBuildingAnchor(world, owner, tx, ty, size) {
  const cx = tx + size / 2, cy = ty + size / 2;
  for (const e of world.entities.values()) {
    if (e.owner !== owner || !isBuildAnchor(e)) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    if (Math.hypot(cx - ecx, cy - ecy) <= BUILD_ANCHOR_RANGE) return true;
  }
  return false;
}

export function canPlaceBuilding(world, tx, ty, size, def, owner = null) {
  const { terrain } = world;
  const onWater = def && def.buildOnWater; // echte Wasserbau-Ausnahmen, z.B. Pumpwerk und Werften
  const waterOptional = def && def.waterOptional; // darf auf Land ODER Wasser (Pipeline, Straße)
  const bridges = def && def.bridges; // Brücke überspannt JEDES Wasser (auch flache Furten)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = tx + x, ny = ty + y;
    if (!inBounds(terrain, nx, ny)) return false;
    const i = tIdx(terrain, nx, ny);
    const tt = terrain.type[i];
    const realWater = isNavigableWater(terrain, nx, ny);
    const wetCell = tt === TT.WATER || terrain.water[i] > WET_DEPTH;
    const pipeOnBridge = !!(def && def.pipe && terrain.bridge && terrain.bridge[i] > 0);
    if (tt === TT.CLIFF && !(def && def.buildOnCliff)) return false; // Tunnel dürfen in den Berg
    if (tt === TT.WATER && !onWater && !waterOptional && !pipeOnBridge) return false;
    if (!onWater && !waterOptional && !pipeOnBridge && terrain.water[i] > WET_DEPTH) return false;
    // Reine Wasserbauten (Pumpe/Werft) brauchen schiffbares Wasser; Brücken überspannen jedes Wasser.
    if (onWater && !waterOptional && !bridges && !realWater) return false;
    if (bridges && !wetCell) return false; // Brücke nur übers Wasser, nicht auf Trockenland
    if (def && def.mustStandInWater && !realWater) return false;
    // Pumpwerk nur in Süßwasser (Fluss/See), nicht im Meer.
    if (def && def.freshWater && !isFreshWater(terrain, nx, ny)) return false;
    if (terrain.ore[i] > 0) return false;
    if (terrain.oil && terrain.oil[i] > 0 && !(def && def.requiresOil)) return false;
  }
  if (def && def.requiresOil) {
    let oil = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = tx + x, ny = ty + y;
      if (inBounds(terrain, nx, ny)) oil += terrain.oil ? terrain.oil[tIdx(terrain, nx, ny)] || 0 : 0;
    }
    if (oil <= 0) return false;
  }
  // keine Überlappung mit bestehenden Gebäuden
  if (overlapsBuilding(world, tx, ty, size, def)) return false;
  // Werften & andere Wasser-Gebäude müssen an segelbares Wasser grenzen.
  if (def && def.requiresWater && !hasWaterNear(terrain, tx, ty, size + 2)) return false;
  if (owner != null && requiresBuildingAnchor(def) && !hasNearbyBuildingAnchor(world, owner, tx, ty, size)) return false;
  return true;
}

export function spawnUnit(world, owner, kind, x, y) {
  const def = world.data.units[kind];
  if (!def) throw new Error('Unbekannte Einheit: ' + kind);
  if (def.domain === 'land' && kind === 'builder') [x, y] = safeLandSpawnPoint(world, x, y);
  const player = world.players.find(p => p.id === owner);
  const fac = world.data.factions[player?.faction] || { modifiers: {} };
  const mod = (fac.modifiers || {})[def.category] || {};
  const hpMult = mod.hpMult || 1;
  // armorMult ist eine fraktionsweite Eigenschaft (z. B. HLX dünne Panzerung <1 → nimmt mehr Schaden).
  const armorMult = (fac.modifiers || {}).armorMult || 1;
  const w = def.weapon ? { ...world.data.weapons[def.weapon], name: def.weapon } : null;
  const e = {
    id: _gid++, etype: 'unit', kind, owner, faction: player?.faction,
    domain: def.domain, category: def.category, armor: def.armor,
    x, y, hp: Math.round(def.hp * hpMult), maxHp: Math.round(def.hp * hpMult),
    speed: def.speed, sight: def.sight, weapon: w, cd: 0,
    order: { type: 'idle' }, path: [], pathGoal: null, target: null, repathCd: 0,
    abilities: def.abilities || [],
    resourceRole: kind === 'builder' ? 'build' : null,
    cargo: 0, harvestRate: def.harvestRate || 0, harvestCap: def.harvestCap || 0, harvestState: 'seek',
    facing: 0,
    // Luft: Bordmunition (Phase 4). 0/undefiniert = unbegrenzt (z. B. Bodeneinheiten).
    muni: def.muni || 0, muniMax: def.muni || 0,
    submerged: !!def.submerged,
    // Transport: Transportkapazität + Ladeliste (eingestiegene Landeinheiten). Nicht-Transporter: capacity 0.
    capacity: def.capacity || 0, carried: def.capacity ? [] : null,
    // Schwere Fahrzeuge: Straßenbonus, Matsch bei Regen, gehen im Wasser kaputt.
    heavy: !!def.heavy,
    // Steigungslimit je Klasse: Infanterie klettert fast überall, schwere Fahrzeuge brauchen
    // flaches Gelände oder Straßen (Serpentinen). Luft/Marine: kein Limit (Wasser regelt).
    maxSlope: def.domain !== 'land' ? Infinity
      : def.category === 'infantry' ? Infinity   // Fußsoldaten klettern über unwegsames Gelände (Klippen/Berge/Schnee)
      : kind === 'builder' ? SLOPE_BUILDER
      : def.heavy ? SLOPE_HEAVY : SLOPE_VEHICLE,
    // Schadensaufnahme-Faktor: <1 Rüstung der Fraktion → nimmt mehr Schaden (1/armorMult).
    dmgTakenMult: armorMult === 1 ? 1 : 1 / armorMult,
  };
  initVet(e); // Veteranenfelder + Basiswerte (XP, Rang, Boni)
  world.entities.set(e.id, e);
  return e;
}

function safeLandSpawnPoint(world, x, y) {
  const t = world.terrain;
  let [tx, ty] = worldToTile(x, y);
  if (inBounds(t, tx, ty) && t.water[tIdx(t, tx, ty)] <= WET_DEPTH * 0.8) return [x, y];
  const dry = (cx, cy) => {
    if (!inBounds(t, cx, cy)) return false;
    const i = tIdx(t, cx, cy);
    return t.water[i] <= WET_DEPTH * 0.8 && isPassable(t, 'land', cx, cy);
  };
  if (dry(tx, ty)) return [x, y];
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = tx + dx, ny = ty + dy;
      if (dry(nx, ny)) return tileToWorld(nx, ny);
    }
  }
  return [x, y];
}

export function spawnBuilding(world, owner, kind, tx, ty) {
  const def = world.data.buildings[kind];
  if (!def) throw new Error('Unbekanntes Gebäude: ' + kind);
  const size = def.size || 1;
  const [x, y] = tileToWorld(tx + (size - 1) / 2, ty + (size - 1) / 2);
  const player = world.players.find(p => p.id === owner);
  const w = def.weapon ? { ...world.data.weapons[def.weapon], name: def.weapon } : null;
  const e = {
    id: _gid++, etype: 'building', kind, owner, faction: player?.faction,
    tx, ty, size, x, y, hp: def.hp, maxHp: def.hp, power: def.power || 0,
    sight: def.sight || 4, weapon: w, cd: 0,
    queue: [], rally: null, buildProgress: def.buildTime ? 0 : 1,
    def,
  };
  world.entities.set(e.id, e);
  clearNaturalCover(world.terrain, tx, ty, size);
  // Kollision: massive Gebäude blockieren Bodenbewegung auf ihrem Footprint (Pfadfindung
  // weicht aus). Begehbare Infrastruktur (Straße/Leitung/Brücke/Tunnel/Befestigung) nicht —
  // Wall/Graben stempeln ihre Sperre selbst über applyFortification.
  if (!def.pipe && !def.bridges && !def.tunnels && !def.roadBuilt && def.role !== 'fortification') {
    const t = world.terrain;
    for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
      if (inBounds(t, tx + xx, ty + yy)) t.block[tIdx(t, tx + xx, ty + yy)]++;
    }
    e._solid = true;
  }
  return e;
}

function clearNaturalCover(t, tx, ty, size) {
  if (!t.cover) return;
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const x = tx + xx, y = ty + yy;
    if (inBounds(t, x, y)) t.cover[tIdx(t, x, y)] = 0;
  }
}

// Gebäude-Kollisionssperre wieder freigeben (Zerstörung).
export function removeSolidBlock(world, e) {
  if (!e._solid) return;
  const t = world.terrain;
  for (let yy = 0; yy < e.size; yy++) for (let xx = 0; xx < e.size; xx++) {
    const i = tIdx(t, e.tx + xx, e.ty + yy);
    if (inBounds(t, e.tx + xx, e.ty + yy) && t.block[i] > 0) t.block[i]--;
  }
  e._solid = false;
}

export function removeEntity(world, id) { world.entities.delete(id); }

// Befestigungen (Wall/Graben) wirken über die Geländekarten: Deckung + Bewegungssperre.
export function applyFortification(world, e) {
  const def = e.def;
  if (!def || (!def.cover && !def.blocks && !def.waterBlocks && !def.terraform && !def.bridges && !def.tunnels && !def.roadBuilt) || e._fortified) return;
  stampFortification(world.terrain, e.tx, e.ty, e.size, def.cover || 0, !!def.blocks, !!def.waterBlocks, def.terraform || 0,
    { bridge: !!def.bridges, tunnel: !!def.tunnels, road: !!def.roadBuilt });
  e._fortified = true;
  grantEarthYield(world, e);
}
export function removeFortification(world, e) {
  if (!e._fortified) return;
  const def = e.def || world.data.buildings[e.kind];
  unstampFortification(world.terrain, e.tx, e.ty, e.size, def.cover || 0, !!def.blocks, !!def.waterBlocks, def.terraform || 0,
    { bridge: !!def.bridges, tunnel: !!def.tunnels, road: !!def.roadBuilt });
  e._fortified = false;
}

export function grantEarthYield(world, e) {
  if (!e || e._earthYielded || !e.def || !e.def.earthYield) return;
  const pile = e.earthPileId ? world.entities.get(e.earthPileId) : null;
  if (pile && pile.kind === 'earth_pile') pile.amount = (pile.amount || 0) + e.def.earthYield;
  else {
    const p = world.players.find(pp => pp.id === e.owner);
    if (p && hasResourceDepot(world, e.owner, 'materials')) addResource(world, p, 'materials', e.def.earthYield);
  }
  e._earthYielded = true;
}

export function hasResourceDepot(world, owner, resource) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead || e.buildProgress < 1) continue;
    if (e.def.resourceDepot === resource) return true;
    if (e.def.integratedStorage && e.def.integratedStorage[resource]) return true;
  }
  return false;
}

export function resourceCapacity(world, owner, resource) {
  let cap = 0;
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead || e.buildProgress < 1) continue;
    if (e.def.integratedStorage && e.def.integratedStorage[resource]) cap += e.def.integratedStorage[resource];
    if (e.def.storage && e.def.storage[resource]) cap += e.def.storage[resource];
    if (resource === 'ammo') {
      if (e.kind === 'hq') cap += 500;
      else if (e.kind === 'depot') cap += 600;
      else if (e.def.role === 'production') cap += 150;
    } else if (resource === 'fuel') {
      if (e.kind === 'hq') cap += 600;
      else if (e.kind === 'depot') cap += 500;
    }
  }
  return cap || Infinity;
}

export function addResource(world, playerOrOwner, resource, amount) {
  const p = typeof playerOrOwner === 'object' ? playerOrOwner : world.players.find(pp => pp.id === playerOrOwner);
  if (!p || !amount) return 0;
  const before = p.resources[resource] || 0;
  const cap = resourceCapacity(world, p.id, resource);
  p.resources[resource] = Math.min(cap, before + amount);
  return p.resources[resource] - before;
}

// --- Abfragen & Geometrie ---
export const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
export const dist = (a, b) => Math.sqrt(dist2(a, b));

export function ownerEntities(world, owner, etype) {
  const out = [];
  for (const e of world.entities.values())
    if (e.owner === owner && (!etype || e.etype === etype)) out.push(e);
  return out;
}

// --- Spatial-Hash für schnelle Zielerfassung in großen Schlachten ---
export function buildSpatial(world, cell = 8) {
  const grid = new Map();
  for (const e of world.entities.values()) {
    if (e.etype === 'unit' && e.dead) continue;
    const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell);
    const key = cx + ',' + cy;
    let b = grid.get(key); if (!b) grid.set(key, b = []);
    b.push(e);
  }
  world.spatial = { grid, cell };
}

export function nearestEnemy(world, ent, range, opts = {}) {
  const { spatial } = world;
  if (!spatial) return null;
  const { cell, grid } = spatial;
  // Nebel drückt die Zielerfassungs-Reichweite aller Einheiten (Schiffe/Flieger besonders riskant).
  if (world.env && world.env.weather === 'fog') range *= FOG_SIGHT_MULT;
  const r = Math.ceil(range / cell);
  const cx = Math.floor(ent.x / cell), cy = Math.floor(ent.y / cell);
  const range2 = range * range;
  // Zielpriorität: Bewaffnete Einheiten bevorzugen das Ziel, gegen das ihre Waffe am wirksamsten
  // ist (vs-Tabelle), nicht stur das nächste. So feuert Flak/SAM auf Luftziele statt auf den
  // nächstbesten Panzer, und Panzer fokussieren feindliche Fahrzeuge. Distanz bleibt sekundär:
  // Score = Wirksamkeit / (1 + Abstand/Reichweite) — naheliegende Bedrohungen gewinnen bei
  // gleicher Wirksamkeit, weit entfernte Hochwertziele werden abgewertet. Ohne Waffe (z. B.
  // reine Sichtabfragen) zählt nur die Distanz. Mit opts.prioritize=false rein nach Distanz.
  const weighted = ent.weapon && opts.prioritize !== false;
  let best = null, bestD = range2, bestScore = -Infinity;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    const b = grid.get((cx + x) + ',' + (cy + y));
    if (!b) continue;
    for (const o of b) {
      if (o.owner === ent.owner || o.dead) continue;
      if (o.abandoned) continue;
      if (o.hp <= 0) continue;
      if (o.inTunnel) continue; // Einheiten in der Tunnelröhre sind verborgen → nicht anvisierbar
      if (o.submerged && !isDetectable(world, ent, o)) continue; // getauchtes U-Boot unsichtbar
      if (opts.groundOnly && o.domain === 'air') continue;
      const d = dist2(ent, o);
      if (d > range2) continue;
      // Kann diese Waffe das Ziel überhaupt treffen? (vs-Tabelle, Domäne)
      let eff = 1;
      if (ent.weapon) {
        const cls = o.etype === 'building' ? 'building' : o.domain === 'air' ? 'air' : o.domain === 'water' || o.domain === 'amphibious' ? 'naval' : o.category === 'infantry' ? 'infantry' : 'vehicle';
        eff = ent.weapon.vs[cls] || 0;
        if (eff <= 0) continue;
      }
      if (weighted) {
        const score = eff / (1 + Math.sqrt(d) / range);
        if (score > bestScore) { bestScore = score; best = o; }
      } else if (d < bestD) { bestD = d; best = o; }
    }
  }
  return best;
}

// Getauchte U-Boote sind nur in Nahbereich (oder kurz nach eigenem Feuern) entdeckbar.
const SUB_DETECT2 = SUB_DETECT_RANGE * SUB_DETECT_RANGE;
export function isDetectable(world, viewer, target) {
  if (!target.submerged) return true;
  if (target._exposeUntil != null && world.time < target._exposeUntil) return true;
  if (target._sonarBy && target._sonarBy.has(viewer.owner)) return true; // von eigener Sonarstation geortet
  return dist2(viewer, target) <= SUB_DETECT2;
}

// Zielklasse für vs-Tabelle bestimmen.
export function targetClass(o) {
  if (o.etype === 'building') return 'building';
  if (o.domain === 'air') return 'air';
  if (o.domain === 'water' || o.domain === 'amphibious') return 'naval';
  return o.category === 'infantry' ? 'infantry' : 'vehicle';
}

function entityTerrainHeight(world, e) {
  if (!world?.terrain || !e) return 0;
  const [tx, ty] = worldToTile(e.x, e.y);
  return inBounds(world.terrain, tx, ty) ? world.terrain.height[tIdx(world.terrain, tx, ty)] : 0;
}

function highGroundDamageMult(world, attacker, target) {
  if (!attacker || !target || attacker.domain === 'air' || target.domain === 'air') return 1;
  const dh = entityTerrainHeight(world, attacker) - entityTerrainHeight(world, target);
  return Math.max(0.82, Math.min(1.28, 1 + dh * 0.9));
}

export function applyDamage(world, target, dmg, attacker, cause = null, meta = null) {
  if (target.dead || target.hp <= 0) return;
  // Deckung mindert Schaden — nur Einheiten profitieren (Infanterie am stärksten).
  let mult = 1;
  if (target.etype === 'unit') {
    const { terrain } = world;
    const [tx, ty] = worldToTile(target.x, target.y);
    mult -= coverAt(terrain, tx, ty) * (target.category === 'infantry' ? 1 : 0.4);
    // Eingegrabene Infanterie (in eigenem Graben, dieser Tick markiert) ist zusätzlich geschützt.
    if (target._garr === world.tick) mult *= GARRISON_DAMAGE_MULT;
    mult *= target.dmgTakenMult || 1; // Fraktions-Panzerung (HLX dünn → >1)
  }
  if (attacker && attacker.owner !== target.owner) mult *= highGroundDamageMult(world, attacker, target);
  target.hp -= dmg * Math.max(0.2, mult);
  target._lastHit = world.time; // für Helden-Selbstheilung (erst nach Ruhephase)
  if (target.hp <= 0) {
    target.dead = true;
    target._deathCause = cause;
    target._deathMeta = meta || null;
    world.events.push({
      type: cause === 'water' ? 'washout' : 'death',
      id: target.id,
      x: target.x,
      y: target.y,
      etype: target.etype,
      kind: target.kind,
      size: target.size || 1,
      ...(meta || {}),
    });
    // Veteranen-XP an den (lebenden) Angreifer, sofern es ein gegnerischer Abschuss war.
    if (attacker && !attacker.dead && attacker.etype === 'unit' && attacker.owner !== target.owner) {
      awardXp(attacker, killValue(target, world.vet), world.vet);
    }
  }
}

// --- Fraktions-Modifikatoren ---
// Die in data/factions.json definierten Boni werden hier zentral angewandt, damit
// Simulation, KI und Tests dieselben effektiven Werte sehen (keine toten Modifikatoren).
export function factionModifiers(world, owner) {
  const player = world.players.find(p => p.id === owner);
  const fac = world.data.factions[player?.faction];
  return (fac && fac.modifiers) || {};
}
// Effektive Kosten einer Einheit/Gebäudes inkl. kategoriespezifischem costMult.
export function effectiveCost(world, owner, def) {
  if (!def || !def.cost) return def?.cost || {};
  const m = (factionModifiers(world, owner)[def.category] || {}).costMult || 1;
  if (m === 1) return def.cost;
  const out = {};
  for (const [k, v] of Object.entries(def.cost)) out[k] = Math.round(v * m);
  return out;
}
// Produktions-/Baugeschwindigkeit (research>1 = schneller). Fortschritt wird damit multipliziert.
export function buildSpeedMult(world, owner) {
  return factionModifiers(world, owner).research || 1;
}

// --- Ressourcen ---
export function canAfford(player, cost) {
  for (const [k, v] of Object.entries(cost || {})) if ((player.resources[k] || 0) < v) return false;
  return true;
}
export function pay(player, cost) {
  for (const [k, v] of Object.entries(cost || {})) player.resources[k] = (player.resources[k] || 0) - v;
}
