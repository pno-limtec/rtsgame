// Kanal-Bau: ein Wasserbau-Schiff (sea_builder, ability 'canal') hebt entlang einer Linie einen
// schiffbaren Kanal aus — es senkt jede Landzelle unter den Meeresspiegel und flutet sie, sodass
// die Flotte neue Wege durch Landengen bekommt. Gegraben wird vom Wasser aus eine Zelle nach der
// anderen (Schiff rückt in den frisch gefluteten Kanal nach).
import { SEA_LEVEL, NAVIGABLE_DEPTH } from '../constants.js';
import { TT, tIdx, inBounds, tileToWorld, applyHeightDelta, wakeWaterAround } from '../terrain.js';
import { setMoveGoal, stopMove } from './movement.js';

const CANAL_DEPTH = NAVIGABLE_DEPTH * 1.4;  // Zieltiefe des Kanals (klar schiffbar)
const CANAL_BED = SEA_LEVEL - 0.07;         // Kanalsohle deutlich unter Meeresspiegel
const DIG_RANGE = 3.4;                       // Weltmeter: Reichweite, um die nächste Zelle auszuheben

// Gerade Linie (start..end inkl.), dedupliziert.
export function canalLineTiles(sx, sy, ex, ey) {
  const n = Math.max(Math.abs(ex - sx), Math.abs(ey - sy));
  const out = [];
  let last = null;
  for (let k = 0; k <= n; k++) {
    const tx = Math.round(sx + (ex - sx) * (n ? k / n : 0));
    const ty = Math.round(sy + (ey - sy) * (n ? k / n : 0));
    if (last && last[0] === tx && last[1] === ty) continue;
    out.push([tx, ty]); last = [tx, ty];
  }
  return out;
}

// Eine Zelle zum Kanal ausheben: Sohle absenken, fluten, als Wasser markieren.
function digCanalCell(world, cx, cy) {
  const t = world.terrain;
  if (!inBounds(t, cx, cy)) return;
  const i = tIdx(t, cx, cy);
  if (t.height[i] > CANAL_BED) applyHeightDelta(t, i, CANAL_BED - t.height[i], true); // negatives Delta → senken
  t.type[i] = TT.WATER;
  t.water[i] = Math.max(t.water[i] || 0, CANAL_DEPTH);
  t.baseWater[i] = Math.max(t.baseWater[i] || 0, CANAL_DEPTH);
  if (t.lakeMask) t.lakeMask[i] = 0;
  wakeWaterAround(t, cx, cy, 1);
}

const cellIsNavigable = (t, i) => (t.water[i] || 0) > NAVIGABLE_DEPTH * 0.8;

// Schiffbare Nachbarzelle des Zielfeldes, die dem Schiff am nächsten liegt (Aushub-Standplatz —
// ein Wasserschiff kann nicht auf das noch trockene Zielfeld fahren).
function nearestNavigableNeighbor(t, cx, cy, e) {
  let best = null, bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = cx + dx, ny = cy + dy;
    if (!inBounds(t, nx, ny) || !cellIsNavigable(t, tIdx(t, nx, ny))) continue;
    const [wx, wy] = tileToWorld(nx, ny);
    const d = (e.x - wx) ** 2 + (e.y - wy) ** 2;
    if (d < bestD) { bestD = d; best = [wx, wy]; }
  }
  return best;
}

export function stepCanal(world) {
  for (const e of world.entities.values()) {
    if (e.dead || e.etype !== 'unit' || !e.order || e.order.type !== 'canal') continue;
    const path = e.order.path;
    let step = e.order.step || 0;
    const t = world.terrain;
    // Bereits schiffbare Zellen am Anfang überspringen (Kanalabschnitt schon fertig).
    while (path && step < path.length && inBounds(t, path[step][0], path[step][1])
      && cellIsNavigable(t, tIdx(t, path[step][0], path[step][1]))) step++;
    e.order.step = step;
    if (!path || step >= path.length) { e.order = { type: 'idle' }; stopMove(e); continue; }
    const [cx, cy] = path[step];
    if (!inBounds(t, cx, cy)) { e.order.step = step + 1; continue; }
    const [wx, wy] = tileToWorld(cx, cy);
    const dist = Math.hypot(e.x - wx, e.y - wy);
    if (dist <= DIG_RANGE) {                     // nah genug → diese Zelle ausheben (wird nächste Runde übersprungen)
      digCanalCell(world, cx, cy);
      world.events.push({ type: 'dig', x: wx, y: wy, owner: e.owner });
      stopMove(e);
    } else if (!e.moveTarget) {                  // an eine schiffbare Nachbarzelle des Ziels heranfahren
      const stage = nearestNavigableNeighbor(t, cx, cy, e) || [wx, wy];
      setMoveGoal(world, e, stage[0], stage[1]);
    }
  }
}
