// Serialisierung des Weltzustands für das Netzwerk.
// Init-Paket (einmalig beim Beitritt) enthält das Gelände, Snapshots nur das Dynamische.
import { SEA_LEVEL, WET_DEPTH, WATER_MAX_DEPTH } from '../shared/constants.js';
import { resourceCapacity } from '../shared/world.js';
const OIL_VIS_MAX = 900;

// Dynamisches Wasser kompakt: nur Zellen, die spürbar von der statischen Seehöhe abweichen
// (geflutet oder trockengelegt). Format: flaches Array [idx, q, idx, q, …], q = Tiefe·255/max.
const WATER_DEV = WET_DEPTH * 0.5;
export function serializeWater(world) {
  const t = world.terrain;
  const out = [];
  for (let i = 0; i < t.water.length; i++) {
    if (Math.abs(t.water[i] - t.baseWater[i]) > WATER_DEV) {
      out.push(i, Math.min(255, Math.round((t.water[i] / WATER_MAX_DEPTH) * 255)));
    }
  }
  return out;
}

export function serializeInitialWater(world) {
  const t = world.terrain;
  const out = [];
  for (let i = 0; i < t.water.length; i++) {
    if (t.type[i] === 3 || t.water[i] <= WET_DEPTH) continue; // Meer rendert die große Wasserfläche
    out.push(i, Math.min(255, Math.round((t.water[i] / WATER_MAX_DEPTH) * 255)));
  }
  return out;
}

export function serializeInitialOil(world) {
  const t = world.terrain;
  const out = [];
  if (!t.oil) return out;
  for (let i = 0; i < t.oil.length; i++) {
    if (t.oil[i] > 0) out.push(i, Math.min(255, Math.round((t.oil[i] / OIL_VIS_MAX) * 255)));
  }
  return out;
}

export function serializeOil(world) {
  const t = world.terrain;
  if (!t.oil || !t.oilDirty || t.oilDirty.size === 0) return null;
  const out = [];
  for (const i of t.oilDirty) out.push(i, Math.min(255, Math.round((Math.max(0, t.oil[i]) / OIL_VIS_MAX) * 255)));
  t.oilDirty.clear();
  return out;
}

// Terraforming-Deltas: Zellen, deren Höhe durch Bauten (Wall/Graben/Deich/Damm) verändert wurde.
// Format: flaches Array [idx, h*1000, …]. Meist leer → günstig; der Client passt nur diese Vertices an.
export function serializeTerraform(world) {
  const t = world.terrain;
  if (!t.terra) return [];
  const out = [];
  for (let i = 0; i < t.terra.length; i++) {
    if (t.terra[i] !== 0) out.push(i, Math.round(t.height[i] * 1000));
  }
  return out;
}

// Schneedecke (Zentralberg): [idx, q] für Zellen mit Schnee; q = Tiefe·100 (gedeckelt).
export function serializeSnow(world) {
  const t = world.terrain;
  if (!t.snow || !t.snowIdx) return [];
  const out = [];
  for (const i of t.snowIdx) {
    if (t.snow[i] > 0.005) out.push(i, Math.min(100, Math.round(t.snow[i] * 100)));
  }
  return out;
}

// Straßennetz: Indexliste aller Straßenzellen — Union aus Auto-Netz und manuell gebauten
// Straßen (nur gesendet, wenn sich das Netz geändert hat).
export function serializeRoads(world) {
  const t = world.terrain;
  if (!t.road) return [];
  const out = [];
  for (let i = 0; i < t.road.length; i++) if (t.road[i] || (t.roadBuilt && t.roadBuilt[i])) out.push(i);
  return out;
}

// Fahrzeugspuren + Matsch: [idx, trackQ, mudQ, dir], q = 0..255. Wird komplett aus den
// dünn besetzten Layern serialisiert; bei normalen Karten bleiben das wenige Einträge.
export function serializeGroundWear(world) {
  const t = world.terrain;
  if (!t.tracks || !t.mud) return [];
  const out = [];
  for (let i = 0; i < t.tracks.length; i++) {
    const tr = t.tracks[i], md = t.mud[i];
    if (tr > 0.04 || md > 0.04) out.push(
      i,
      Math.min(255, Math.round(tr * 255)),
      Math.min(255, Math.round(md * 255)),
      t.trackDir ? t.trackDir[i] : 0,
    );
  }
  return out;
}

export function serializeInit(world) {
  const t = world.terrain;
  return {
    type: 'init',
    tick: world.tick,
    map: { w: t.w, h: t.h, tile: 2 },
    terrain: {
      // als reguläre Arrays (einmalige Übertragung; klein genug für Prototyp).
      // WICHTIG: height0 (Ausgangshöhen) statt height — laufende Terraforming-/Bebendeltas kommen
      // über snap.terra; so kann der Client Höhen exakt zurücksetzen, wenn ein Delta verschwindet.
      height: Array.from(t.height0, v => Math.round(v * 1000) / 1000),
      type: Array.from(t.type),
      ore: Array.from(t.ore, v => (v > 0 ? 1 : 0)), // nur Vorkommen-Maske für Rendering
      oil: serializeInitialOil(world), // sichtbare Öl-Sickerflecken [idx, menge]
      water: Array.from(t.water, v => (v > WET_DEPTH ? 1 : 0)), // statische Nässe-Maske (Rendering-Basis)
      // Volle Basistiefen: der Client baut daraus das Wasser-Oberflächenmesh (Meer, Flüsse,
      // HOCHSEEN über Meeresspiegel) — Snapshot-Abweichungen kommen via snap.water obendrauf.
      baseWater: Array.from(t.baseWater, v => Math.round(v * 1000) / 1000),
      waterDepth: serializeInitialWater(world), // sichtbare Binnengewässer (Hochseen/Flüsse) mit Tiefe
      cover: Array.from(t.cover, v => Math.round(v * 100) / 100), // natürliche Deckung (Wald/Hügel)
      seaLevel: SEA_LEVEL,
      snow: serializeSnow(world),   // Schneedecke (Berg) — danach via snap.snow aktualisiert
      roads: serializeRoads(world), // Straßennetz — danach via snap.roads bei Änderung
      ground: serializeGroundWear(world), // Fahrzeugspuren/Matsch für Join-in-Progress
      bridge: Array.from(t.bridge), // neutrale Furten/Brücken aus der Weltgenerierung
    },
    players: world.players.map(playerView),
    controls: serializeControls(world),
    snapshot: serializeSnapshot(world),
  };
}

export function serializeSnapshot(world) {
  const ents = [];
  for (const e of world.entities.values()) {
    if (e.etype === 'unit') {
      // Index 9 = Ladung: bei Transportern die Insassenzahl, sonst die Erz-Ladung des Harvesters.
      const load = e.carried ? e.carried.length : Math.round(e.cargo || 0);
      const working = e.order && (e.order.type === 'construct' || e.order.type === 'terra'
        || (e.kind === 'builder' && e.order.type === 'harvest' && !e.moveTarget));
      ents.push([e.id, 0, kindId(e.kind), e.owner, r1(e.x), r1(e.y),
        Math.max(0, Math.round(e.hp)), e.maxHp, r2(e.facing), load, e.vet || 0, roleId(e.resourceRole),
        working ? 1 : 0,
        e.abandoned ? 1 : 0,
        unitFlags(world, e), ownerMask(e._sonarBy)]);
    } else {
      // Index 11 = Strom-Flag: 0 wenn das Gebäude beim Lastabwurf abgeschaltet wurde (Licht aus).
      ents.push([e.id, 1, kindId(e.kind), e.owner, r1(e.x), r1(e.y),
        Math.max(0, Math.round(e.hp)), e.maxHp, e.size, Math.round(e.buildProgress * 100),
        (e.kind === 'earth_pile' || e.kind === 'ore_pile') ? Math.round(e.amount || 0) : e.queue.length,
        e._powered === false ? 0 : 1, e.earthPileId || 0]);
    }
  }
  const t = world.terrain;
  const snap = {
    type: 'snap',
    tick: world.tick,
    ents,
    proj: world.projectiles.map(p => [r1(p.x), r1(p.y)]),
    water: serializeWater(world),  // geflutete/trockengelegte Zellen (meist leer → günstig)
    ground: serializeGroundWear(world), // Fahrzeugspuren, Pfützenrillen, Matsch
    terra: serializeTerraform(world), // terraformte Zellen (Höhenänderung durch Bauten/Beben)
    // Umwelt: Tageszeit, Licht, Wetter, Beben — Client steuert damit Sonne, Regen, Kamera-Shake.
    env: world.env ? {
      t: Math.round(world.env.dayT * 1000) / 1000,
      d: Math.round(world.env.daylight * 1000) / 1000,
      w: world.env.weather,
      wl: Math.max(0, Math.round(world.env.weatherLeft)),
      f: (world.env.forecast || []).slice(0, 3).map(x => [x.weather, Math.max(0, Math.round(x.duration))]),
      q: world.env.quake ? [r1(world.env.quake.x), r1(world.env.quake.y)] : 0,
    } : null,
    controls: serializeControls(world),
    events: world.events,
    jobs: (world.terraJobs || []).map(j => [j.id, j.owner, j.tx, j.ty, j.dir, j.pileTx ?? -1, j.pileTy ?? -1, Math.round((j.applied || 0) * 1000)]),
    players: world.players.map(p => ({
      id: p.id, defeated: p.defeated, controller: p.controller,
      res: roundRes(p.resources), energy: { p: Math.round(p.energy.produced), c: Math.round(p.energy.consumed) },
      cap: roundCaps(world, p.id, p.resources),
    })),
  };
  const oil = serializeOil(world);
  if (oil) snap.oil = oil;
  // Schnee ändert sich langsam → nur jeden 10. Tick mitsenden (1 Hz).
  if (world.tick % 10 === 0) snap.snow = serializeSnow(world);
  // Straßennetz nur senden, wenn es sich geändert hat (roads.js setzt roadDirty).
  if (t.roadDirty) { snap.roads = serializeRoads(world); t.roadDirty = false; }
  return snap;
}

function serializeControls(world) {
  const controls = world.controls || {};
  const active = world.players.filter(p => !p.defeated);
  const aiOnly = active.length > 0 && active.every(p => p.controller === 'ai');
  const speed = Number.isFinite(Number(controls.speed)) ? Number(controls.speed) : 1;
  const timeMode = ['auto', 'day', 'night'].includes(controls.timeMode) ? controls.timeMode : 'auto';
  return { speed: Math.max(1, Math.round(speed * 10) / 10), timeMode, aiOnly };
}

function playerView(p) {
  return { id: p.id, name: p.name, faction: p.faction, color: p.color, controller: p.controller, defeated: p.defeated };
}

// Kompakte Kind-IDs (stabile Reihenfolge); Client hält dieselbe Tabelle in data.
const KINDS = [
  'hq', 'power_plant', 'refinery', 'oil_derrick', 'barracks', 'factory', 'airbase', 'shipyard',
  'depot', 'turret', 'sam_site', 'wall', 'trench', 'builder', 'dam',
  'engineer', 'rifleman', 'at_soldier', 'scout', 'tank', 'artillery', 'flak_track', 'harvester',
  'recon_drone', 'gunship', 'bomber', 'transport_air', 'patrol_boat', 'destroyer', 'submarine',
  'amphib_transport', 'sea_builder', 'sonar',
  'solar_plant', 'water_pump', 'pipe', 'bridge', 'tunnel', 'road',
  'ore_depot', 'material_depot', 'water_tower', 'oil_depot', 'truck', 'earth_pile', 'tractor', 'ore_pile',
  'aa_soldier', 'rocket_launcher', 'underwater_drone', 'mg_turret', 'flak_turret',
];
const KIND_INDEX = Object.fromEntries(KINDS.map((k, i) => [k, i]));
export function kindId(k) { return KIND_INDEX[k] ?? -1; }
export function kindName(i) { return KINDS[i]; }
export const KIND_TABLE = KINDS;
const ROLES = [null, 'ore', 'materials', 'earth'];
const ROLE_INDEX = new Map(ROLES.map((r, i) => [r, i]));
function roleId(r) { return ROLE_INDEX.get(r) || 0; }
function unitFlags(world, e) {
  return (e.submerged ? 1 : 0)
    | (e._exposeUntil != null && world.time < e._exposeUntil ? 2 : 0);
}
function ownerMask(owners) {
  let mask = 0;
  if (owners) for (const owner of owners) if (owner >= 0 && owner < 30) mask |= (1 << owner);
  return mask;
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
function roundRes(res) { const o = {}; for (const k in res) o[k] = Math.round(res[k]); return o; }
function roundCaps(world, owner, res) {
  const o = {};
  for (const k in res) {
    const cap = resourceCapacity(world, owner, k);
    o[k] = Number.isFinite(cap) ? Math.round(cap) : null;
  }
  return o;
}
