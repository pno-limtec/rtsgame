// Transportsystem: Ein-/Ausladen von Landeinheiten durch Transporter (Phase 5).
// Transporter (amphib_transport, transport_air) haben `capacity > 0` und eine `carried`-Liste.
// Eingestiegene Einheiten werden aus `world.entities` entfernt (nicht mehr simuliert/sichtbar/angreifbar)
// und beim Ausladen an passierbaren Landzellen nahe dem Zielpunkt wieder eingesetzt — ihre HP, Veteranen-
// stufe und Munition bleiben erhalten. Wird ein voller Transporter zerstört, gehen die Insassen verloren
// (Aufräumen in sim.js cleanup). Läuft NACH stepMovement, damit Annäherung/Ankunft mit frischen Positionen
// erkannt werden (eine Tick-Latenz beim Wegpunkt-Nachführen ist unkritisch).
import { dist2, removeEntity } from '../world.js';
import { setMoveGoal, stopMove } from './movement.js';
import { worldToTile, tileToWorld, isPassable } from '../terrain.js';
import { LOAD_RANGE, UNLOAD_RANGE } from '../constants.js';

const LOAD2 = LOAD_RANGE * LOAD_RANGE;
const UNLOAD2 = UNLOAD_RANGE * UNLOAD_RANGE;

export function stepTransport(world) {
  // Schnappschuss der Werte, da wir während der Iteration Einheiten entfernen (Laden) bzw. einfügen (Ausladen).
  const ents = [...world.entities.values()];
  for (const e of ents) {
    if (e.etype !== 'unit' || e.dead || !e.order) continue;
    if (e.order.type === 'load') stepLoader(world, e);
    else if (e.order.type === 'unload') stepUnloader(world, e);
  }
}

// Eine Landeinheit nähert sich ihrem Zieltransporter und steigt im Nahbereich ein.
function stepLoader(world, u) {
  const t = world.entities.get(u.order.transportId);
  if (!t || t.dead || t.owner !== u.owner || !t.capacity) { abortOrder(u); return; }
  if (t.carried.length >= t.capacity) { abortOrder(u); return; } // Transporter voll
  if (dist2(u, t) <= LOAD2) { loadUnit(world, t, u); return; }
  // Wegpunkt dem (ggf. fahrenden) Transporter nachführen, ohne bei jedem Tick neu zu pathen.
  if (!u.moveTarget || (u.moveTarget.x - t.x) ** 2 + (u.moveTarget.y - t.y) ** 2 > 4) {
    setMoveGoal(world, u, t.x, t.y);
  }
}

// Transporter erreicht den Ausladepunkt → alle Insassen werden abgesetzt.
function stepUnloader(world, t) {
  if (!t.carried || t.carried.length === 0) { t.order = { type: 'idle' }; stopMove(t); return; }
  const tgt = t.order;
  const arrived = dist2(t, tgt) <= UNLOAD2 || (!t.moveTarget && (!t.path || !t.path.length));
  if (arrived) { unloadAll(world, t); t.order = { type: 'idle' }; stopMove(t); }
}

function abortOrder(u) { u.order = { type: 'idle' }; stopMove(u); }

// Einheit in den Transporter aufnehmen: aus der Welt nehmen, vollständiges Objekt aufbewahren.
export function loadUnit(world, t, u) {
  stopMove(u);
  u.order = { type: 'idle' }; u.target = null;
  u._loadedIn = t.id;
  removeEntity(world, u.id);
  t.carried.push(u);
}

// Alle Insassen an passierbaren Landzellen rund um den Transporter absetzen.
export function unloadAll(world, t) {
  const { terrain } = world;
  const occupied = new Set();
  while (t.carried.length) {
    const u = t.carried.shift();
    const spot = findUnloadSpot(world, t.x, t.y, u.domain || 'land', occupied);
    u.x = spot.x; u.y = spot.y;
    u._loadedIn = null;
    u.dead = false;
    u.order = { type: 'idle' }; u.target = null;
    stopMove(u);
    occupied.add(spot.tx + ',' + spot.ty);
    world.entities.set(u.id, u);
    world.events.push({ type: 'unload', x: u.x, y: u.y });
  }
}

// Nächstgelegene freie, passierbare (Land-)Zelle in einer Spirale um den Zielpunkt suchen.
function findUnloadSpot(world, wx, wy, domain, occupied) {
  const { terrain } = world;
  const [cx, cy] = worldToTile(wx, wy);
  const dom = domain === 'land' || domain === 'amphibious' ? domain : 'land';
  for (let r = 0; r <= 6; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue; // nur Ring
      const tx = cx + x, ty = cy + y;
      if (occupied.has(tx + ',' + ty)) continue;
      if (!isPassable(terrain, dom, tx, ty)) continue;
      const [px, py] = tileToWorld(tx, ty);
      return { x: px, y: py, tx, ty };
    }
  }
  return { x: wx, y: wy, tx: cx, ty: cy }; // Notnagel: direkt am Transporter
}
