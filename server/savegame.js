import { createWorld } from '../shared/sim.js';
import { makeRng } from '../shared/rng.js';
import { setNextEntityId } from '../shared/world.js';
import { setNextTerraJobId } from '../shared/systems/construction.js';
import { SLOPE_INFANTRY, SLOPE_VEHICLE, SLOPE_HEAVY } from '../shared/constants.js';

const SAVE_VERSION = 1;
const F32 = [
  'height', 'height0', 'terra', 'water', 'baseWater', 'cover', 'coverBuilt',
  'ore', 'oil', 'tracks', 'mud', 'snow',
];
const U8 = [
  'type', 'waterBlock', 'block', 'bridge', 'tunnel', 'trackDir', 'lakeMask',
  'road', 'roadBuilt', 'startSafe',
];

export function serializeSavegame(world) {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    world: {
      seed: world.seed,
      tick: world.tick,
      time: world.time,
      map: { ...world.map },
      controls: plain(world.controls || {}),
      rngState: world.rng?.state ? world.rng.state() : null,
      env: plain(world.env || null),
      players: world.players.map(packPlayer),
      terrain: packTerrain(world.terrain),
      entities: [...world.entities.values()].map(packEntity),
      projectiles: plain(world.projectiles || []),
      terraJobs: plain(world.terraJobs || []),
    },
  };
}

export function deserializeSavegame(save, data) {
  if (!save || save.version !== SAVE_VERSION || !save.world) throw new Error('Savegame-Version nicht unterstützt');
  const src = save.world;
  const players = (src.players || []).map(p => ({
    id: p.id,
    name: p.name,
    faction: p.faction,
    controller: p.controller || 'ai',
  }));
  const world = createWorld({ data, seed: src.seed || 1, map: src.map, players });
  world.seed = src.seed || 1;
  world.tick = Math.max(0, Math.floor(Number(src.tick) || 0));
  world.time = Math.max(0, Number(src.time) || 0);
  world.controls = { speed: 1, timeMode: 'auto', ...(src.controls || {}) };
  world.players = (src.players || []).map(p => ({
    id: p.id,
    name: p.name || `Spieler ${p.id + 1}`,
    faction: p.faction || 'KBN',
    controller: p.controller || 'ai',
    color: p.color || data.factions[p.faction || 'KBN']?.color || '#cccccc',
    resources: { ...(p.resources || {}) },
    defeated: !!p.defeated,
    energy: p.energy || { produced: 0, consumed: 0, ratio: 1 },
    ai: null,
  }));
  world.terrain = unpackTerrain(src.terrain);
  world.entities = new Map();
  for (const raw of src.entities || []) {
    const e = unpackEntity(raw, world, data);
    world.entities.set(e.id, e);
  }
  world.projectiles = plain(src.projectiles || []);
  world.terraJobs = plain(src.terraJobs || []);
  world.events = [];
  world.spatial = null;
  world.cmdQueue = [];
  world.env = plain(src.env || null);
  world.rng = makeRng(1);
  if (src.rngState != null) world.rng.setState(src.rngState);
  else world.rng = makeRng((world.seed || 1) ^ 0x9e3779b9);

  const nextEntity = Math.max(0, ...[...world.entities.keys()], ...carriedIds(world.entities)) + 1;
  const nextJob = Math.max(0, ...(world.terraJobs || []).map(j => j.id || 0)) + 1;
  setNextEntityId(nextEntity);
  setNextTerraJobId(nextJob);
  return world;
}

function packPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    faction: p.faction,
    controller: p.controller,
    color: p.color,
    resources: plain(p.resources || {}),
    defeated: !!p.defeated,
    energy: plain(p.energy || { produced: 0, consumed: 0, ratio: 1 }),
  };
}

function packTerrain(t) {
  const out = { w: t.w, h: t.h };
  for (const k of F32) if (t[k]) out[k] = Array.from(t[k], finiteNumber);
  for (const k of U8) if (t[k]) out[k] = Array.from(t[k]);
  out.oreList = Array.from(t.oreList || []);
  out.oilList = Array.from(t.oilList || []);
  out.sources = Array.from(t.sources || []);
  out.waterActive = Array.from(t.waterActive || []);
  out.snowIdx = Array.from(t.snowIdx || []);
  out.lakes = plain(t.lakes || []);
  out.valleys = plain(t.valleys || []);
  out.riverPaths = (t.riverPaths || []).map(p => Array.from(p));
  out.startMeltCells = Array.from(t.startMeltCells || []);
  out.startMeltLeft = t.startMeltLeft || 0;
  out.startMeltTotal = t.startMeltTotal || 0;
  return out;
}

function unpackTerrain(src) {
  if (!src || !src.w || !src.h) throw new Error('Savegame enthält kein gültiges Terrain');
  const size = src.w * src.h;
  const t = { w: src.w, h: src.h };
  for (const k of F32) t[k] = Float32Array.from(fillArray(src[k], size, 0));
  for (const k of U8) t[k] = Uint8Array.from(fillArray(src[k], size, 0));
  t.oreList = Array.from(src.oreList || indexesWhere(t.ore, v => v > 0));
  t.oilList = Array.from(src.oilList || indexesWhere(t.oil, v => v > 0));
  t.sources = Array.from(src.sources || []);
  t.waterActive = new Set(src.waterActive || t.sources || []);
  t.terraDirty = new Set();
  t.oilDirty = new Set(indexesWhere(t.oil, v => v > 0));
  t.snowIdx = Array.from(src.snowIdx || indexesWhere(t.snow, v => v > 0.005));
  t.lakes = plain(src.lakes || []);
  t.valleys = plain(src.valleys || []);
  t.riverPaths = (src.riverPaths || []).map(p => Array.from(p));
  t.startMeltCells = Array.from(src.startMeltCells || []);
  t.startMeltLeft = src.startMeltLeft || 0;
  t.startMeltTotal = src.startMeltTotal || 0;
  t.roadDirty = true;
  return t;
}

function packEntity(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'def' || k === 'weapon' || k === 'abilities' || k === 'maxSlope' || k === 'dmgTakenMult') continue;
    if (k === '_sonarBy') out[k] = Array.from(v || []);
    else if (k === 'carried') out[k] = Array.isArray(v) ? v.map(packEntity) : v;
    else if (k === 'target' && v != null && typeof v === 'object') continue;
    else out[k] = plain(v);
  }
  if (e.weapon) out.weaponName = e.weapon.name;
  return out;
}

function unpackEntity(raw, world, data) {
  const e = plain(raw);
  if (e.etype === 'unit') hydrateUnit(e, world, data);
  else hydrateBuilding(e, data);
  if (Array.isArray(raw.carried)) e.carried = raw.carried.map(c => unpackEntity(c, world, data));
  if (Array.isArray(raw._sonarBy)) e._sonarBy = new Set(raw._sonarBy);
  delete e.weaponName;
  return e;
}

function hydrateUnit(e, world, data) {
  const def = data.units[e.kind];
  if (!def) throw new Error(`Unbekannte Einheit im Savegame: ${e.kind}`);
  const p = world.players.find(pp => pp.id === e.owner);
  const fac = data.factions[p?.faction || e.faction] || { modifiers: {} };
  const armorMult = fac.modifiers?.armorMult || 1;
  e.domain = e.domain || def.domain;
  e.category = e.category || def.category;
  e.armor = e.armor || def.armor;
  e.speed = e.speed || def.speed;
  e.sight = e.sight || def.sight;
  e.weapon = e.weaponName ? { ...data.weapons[e.weaponName], name: e.weaponName }
    : def.weapon ? { ...data.weapons[def.weapon], name: def.weapon } : null;
  e.order = e.order || { type: 'idle' };
  e.path = Array.isArray(e.path) ? e.path : [];
  e.pathGoal = e.pathGoal || null;
  e.target = Number.isFinite(Number(e.target)) ? e.target : null;
  e.abilities = Array.isArray(e.abilities) ? e.abilities : (def.abilities || []);
  e.resourceRole = e.resourceRole ?? (e.kind === 'builder' ? 'materials' : null);
  e.harvestRate = e.harvestRate || def.harvestRate || 0;
  e.harvestCap = e.harvestCap || def.harvestCap || 0;
  e.facing = e.facing || 0;
  e.muni = e.muni ?? (def.muni || 0);
  e.muniMax = e.muniMax ?? (def.muni || 0);
  e.capacity = e.capacity ?? (def.capacity || 0);
  e.carried = e.capacity ? (Array.isArray(e.carried) ? e.carried : []) : null;
  e.heavy = !!(e.heavy ?? def.heavy);
  e.submerged = !!(e.submerged ?? def.submerged);
  e.maxSlope = def.domain !== 'land' ? Infinity
    : def.category === 'infantry' ? SLOPE_INFANTRY
    : def.heavy ? SLOPE_HEAVY : SLOPE_VEHICLE;
  e.dmgTakenMult = Number.isFinite(e.dmgTakenMult) ? e.dmgTakenMult : (armorMult === 1 ? 1 : 1 / armorMult);
}

function hydrateBuilding(e, data) {
  const def = data.buildings[e.kind];
  if (!def) throw new Error(`Unbekanntes Gebäude im Savegame: ${e.kind}`);
  e.def = def;
  e.size = e.size || def.size || 1;
  e.power = e.power ?? (def.power || 0);
  e.sight = e.sight || def.sight || 4;
  e.weapon = e.weaponName ? { ...data.weapons[e.weaponName], name: e.weaponName }
    : def.weapon ? { ...data.weapons[def.weapon], name: def.weapon } : null;
  e.queue = Array.isArray(e.queue) ? e.queue : [];
  e.rally = e.rally || null;
  e.buildProgress = e.buildProgress ?? (def.buildTime ? 0 : 1);
}

function carriedIds(entities) {
  const ids = [];
  const walk = (e) => {
    if (!e?.carried) return;
    for (const c of e.carried) {
      ids.push(c.id || 0);
      walk(c);
    }
  };
  for (const e of entities.values()) walk(e);
  return ids;
}

function fillArray(arr, size, value) {
  if (Array.isArray(arr) && arr.length === size) return arr;
  return new Array(size).fill(value);
}

function indexesWhere(arr, pred) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (pred(arr[i])) out.push(i);
  return out;
}

function finiteNumber(v) {
  return Number.isFinite(v) ? v : 0;
}

function plain(value) {
  if (value == null || typeof value !== 'object') return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Set) return Array.from(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plain(v);
  return out;
}
