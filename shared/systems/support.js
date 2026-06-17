import { WET_DEPTH } from '../constants.js';
import { inBounds, isPassable, tIdx, tileToWorld } from '../terrain.js';
import { ownerEntities, spawnUnit } from '../world.js';

const BUILD_AID_MAX_INSANITY = 2;
const BUILD_AID_RESOURCES = ['ore', 'oil'];
const RESOURCE_EPS = 1;
const SUPPORT_UNITS = new Set(['builder', 'truck']);

export function markSupportUnitLoss(world, unit) {
  if (!world || !unit || !SUPPORT_UNITS.has(unit.kind)) return;
  const pending = world._supportUnitLosses || (world._supportUnitLosses = new Map());
  pending.set(`${unit.owner}:${unit.kind}`, world.tick);
}

export function stepSupport(world) {
  spawnPendingSupportUnits(world);
  if (supportInsanityLevel(world) <= BUILD_AID_MAX_INSANITY) stepBuildAid(world);
}

function supportInsanityLevel(world) {
  const raw = world?.env?.insanity ?? world?.controls?.insanity ?? 2;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 2;
}

function spawnPendingSupportUnits(world) {
  const pending = world._supportUnitLosses;
  if (!pending || pending.size === 0) return;
  const next = new Map();
  for (const [key, tick] of pending) {
    const [ownerText, kind] = key.split(':');
    const owner = Number(ownerText);
    if (!Number.isFinite(owner) || !SUPPORT_UNITS.has(kind)) continue;
    const player = world.players.find(p => p.id === owner && !p.defeated);
    if (!player) continue;
    if (ownerEntities(world, owner, 'unit').some(u => u.kind === kind && !u.dead)) continue;
    const hq = ownerEntities(world, owner, 'building').find(b => b.kind === 'hq' && b.buildProgress >= 1 && !b.dead);
    if (!hq) continue;
    const spot = supportSpawnSpot(world, hq);
    if (!spot) {
      next.set(key, tick);
      continue;
    }
    const unit = spawnUnit(world, owner, kind, spot[0], spot[1]);
    if (kind === 'builder') unit.resourceRole = 'build';
    world.events.push({ type: 'produced', x: unit.x, y: unit.y, kind, owner, support: 1 });
  }
  world._supportUnitLosses = next;
}

function supportSpawnSpot(world, hq) {
  const t = world.terrain;
  const cx = Math.round(hq.tx + hq.size / 2);
  const cy = Math.round(hq.ty + hq.size / 2);
  for (let r = hq.size; r <= hq.size + 8; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!supportSpawnCell(t, tx, ty)) continue;
      const [wx, wy] = tileToWorld(tx, ty);
      if (unitTooClose(world, wx, wy)) continue;
      return [wx, wy];
    }
  }
  return null;
}

function supportSpawnCell(t, tx, ty) {
  if (!inBounds(t, tx, ty) || !isPassable(t, 'land', tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  return (t.water?.[i] || 0) <= WET_DEPTH * 0.8;
}

function unitTooClose(world, x, y) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead) continue;
    if (Math.hypot(e.x - x, e.y - y) < 0.7) return true;
  }
  return false;
}

function stepBuildAid(world) {
  const active = world.players.filter(p => !p.defeated);
  if (active.length < 2) return;
  const armed = world._buildAidArmed || (world._buildAidArmed = Object.create(null));
  for (const resource of BUILD_AID_RESOURCES) {
    const depleted = isResourceDepletedForAll(world, active, resource);
    if (!depleted) {
      armed[resource] = true;
      continue;
    }
    if (armed[resource] === false) continue;
    const drops = refillResourceToHalf(world, active, resource);
    armed[resource] = false;
    if (drops.length) {
      const center = drops.reduce((a, d) => {
        a.x += d[0]; a.y += d[1];
        return a;
      }, { x: 0, y: 0 });
      center.x /= drops.length;
      center.y /= drops.length;
      world.events.push({ type: 'build_aid', resource, x: center.x, y: center.y, drops });
    }
  }
}

function isResourceDepletedForAll(world, players, resource) {
  if (!players.every(p => (p.resources?.[resource] || 0) <= RESOURCE_EPS)) return false;
  return !resourceNodesRemain(world.terrain, resource);
}

function resourceNodesRemain(t, resource) {
  const arr = resource === 'ore' ? t.ore : t.oil;
  if (!arr) return false;
  const list = resource === 'ore' ? t.oreList : t.oilList;
  if (list?.some(i => (arr[i] || 0) > RESOURCE_EPS)) return true;
  for (let i = 0; i < arr.length; i++) if ((arr[i] || 0) > RESOURCE_EPS) return true;
  return false;
}

function refillResourceToHalf(world, players, resource) {
  const drops = [];
  for (const p of players) {
    const stores = storageBuildings(world, p.id, resource);
    const cap = stores.reduce((sum, s) => sum + s.cap, 0);
    if (cap <= 0) continue;
    const target = Math.floor(cap * 0.5);
    if ((p.resources[resource] || 0) < target) p.resources[resource] = target;
    for (const s of stores) drops.push([s.e.x, s.e.y, p.id, resource]);
  }
  return drops;
}

function storageBuildings(world, owner, resource) {
  const out = [];
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead || e.buildProgress < 1) continue;
    const cap = (e.def?.integratedStorage?.[resource] || 0) + (e.def?.storage?.[resource] || 0);
    if (cap > 0) out.push({ e, cap });
  }
  return out;
}
