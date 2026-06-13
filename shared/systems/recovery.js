// Bergungssystem: Traktoren ziehen verlassene Fahrzeuge aus Matsch/Wasser heraus.
import { MUD_IMPASSABLE, WET_DEPTH } from '../constants.js';
import { dist2 } from '../world.js';
import { inBounds, isPassable, tIdx, tileToWorld, worldToTile } from '../terrain.js';
import { setMoveGoal, stopMove } from './movement.js';

const TOW_RANGE = 4.2;
const TOW_RANGE2 = TOW_RANGE * TOW_RANGE;

export function stepRecovery(world) {
  for (const t of world.entities.values()) {
    if (t.etype !== 'unit' || t.dead || t.abandoned || !t.abilities?.includes('tow')) continue;
    if (t.order?.type !== 'tow') continue;
    const target = world.entities.get(t.order.targetId);
    if (!target || target.dead || !target.abandoned || target.domain !== 'land') { idle(t); continue; }
    const safe = findSafeSpot(world, target.x, target.y);
    if (!safe) { idle(t); continue; }
    if (dist2(t, target) > TOW_RANGE2) {
      if (!t.moveTarget || Math.hypot(t.moveTarget.x - safe.x, t.moveTarget.y - safe.y) > 1.5) setMoveGoal(world, t, safe.x, safe.y);
      continue;
    }
    stopMove(t);
    target.x = safe.x; target.y = safe.y;
    stabilizeRecoveredCell(world, target);
    target.owner = t.owner;
    target.abandoned = false;
    target._stuckTime = 0;
    target._v = 0;
    target.order = { type: 'idle' };
    target.target = null;
    target.hp = Math.max(target.hp || 1, Math.ceil(target.maxHp * 0.25));
    stopMove(target);
    idle(t);
    world.events.push({ type: 'recover', x: target.x, y: target.y, owner: t.owner, kind: target.kind });
  }
}

function idle(u) {
  u.order = { type: 'idle' };
  u.target = null;
  stopMove(u);
}

function stabilizeRecoveredCell(world, target) {
  const t = world.terrain;
  const [tx, ty] = worldToTile(target.x, target.y);
  if (!inBounds(t, tx, ty)) return;
  const i = tIdx(t, tx, ty);
  t.water[i] = Math.min(t.water[i] || 0, WET_DEPTH * 0.35);
  if (t.mud) t.mud[i] = 0;
  if (t.waterActive) t.waterActive.add(i);
}

function findSafeSpot(world, wx, wy) {
  const t = world.terrain;
  const [cx, cy] = worldToTile(wx, wy);
  let best = null, bestD = Infinity;
  for (let r = 1; r <= 9; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
      const tx = cx + x, ty = cy + y;
      if (!isSafeVehicleCell(t, tx, ty)) continue;
      const d = x * x + y * y;
      if (d < bestD) {
        const [sx, sy] = tileToWorld(tx, ty);
        best = { x: sx, y: sy }; bestD = d;
      }
    }
    if (best) return best;
  }
  return null;
}

function isSafeVehicleCell(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return false;
  if (!isPassable(t, 'land', tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  if (t.water[i] > WET_DEPTH) return false;
  if (t.mud && t.mud[i] >= MUD_IMPASSABLE * 0.45) return false;
  return true;
}
