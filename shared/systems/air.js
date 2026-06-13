// Luftkampf-Logistik (Phase 4): Bordmunition & Nachladen an der Luftbasis.
// Luftfahrzeuge tragen begrenzte Munition (`muni`). Ist sie leer, kehren sie zur
// nächsten eigenen Luftbasis zurück (RTB), laden dort nach und sammeln sich (guard),
// bis die KI sie mit der nächsten Welle wieder einsetzt. Macht Luftbasen strategisch
// und gibt Bodentruppen ein Zeitfenster gegen Luftüberlegenheit.
import { DT, AIR_REARM_RANGE, AIR_REARM_RATE, AIR_RTB_THRESHOLD } from '../constants.js';
import { setMoveGoal, stopMove } from './movement.js';
import { dist } from '../world.js';

export function stepAir(world) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead || e.domain !== 'air' || !e.muniMax) continue;

    // Munition leer → Rückkehr zur Basis einleiten (laufende Befehle werden unterbrochen).
    if (e.order.type !== 'rearm' && e.muni <= AIR_RTB_THRESHOLD) {
      e.order = { type: 'rearm' }; e.target = null; stopMove(e); e._rearmBase = null;
    }
    if (e.order.type !== 'rearm') continue;

    const base = nearestAirbase(world, e);
    if (!base) {
      // Keine Basis mehr vorhanden → Notbehelf: langsam in der Luft aufmunitionieren,
      // damit die Einheit nicht dauerhaft nutzlos kreist.
      e.muni = Math.min(e.muniMax, e.muni + AIR_REARM_RATE * 0.3 * DT);
      if (e.muni >= e.muniMax) e.order = { type: 'guard' };
      continue;
    }
    if (dist(e, base) > AIR_REARM_RANGE) {
      if (!e.moveTarget || e._rearmBase !== base.id) { setMoveGoal(world, e, base.x, base.y); e._rearmBase = base.id; }
    } else {
      stopMove(e); e._rearmBase = null;
      e.muni = Math.min(e.muniMax, e.muni + AIR_REARM_RATE * DT);
      if (e.muni >= e.muniMax) e.order = { type: 'guard' }; // aufmunitioniert → sammeln, nächste Welle nimmt sie mit
    }
  }
}

function nearestAirbase(world, e) {
  let best = null, bestD = Infinity;
  for (const o of world.entities.values()) {
    if (o.etype !== 'building' || o.owner !== e.owner || o.dead || o.buildProgress < 1) continue;
    if (o.kind !== 'airbase') continue;
    const d = (o.x - e.x) ** 2 + (o.y - e.y) ** 2;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
