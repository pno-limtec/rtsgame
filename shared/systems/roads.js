// Automatisches Straßennetz (Phase 15): Zwischen nahe beieinanderstehenden, fertigen Gebäuden
// eines Spielers entstehen automatisch Straßen (jedes Gebäude verbindet sich mit bis zu zwei
// nächsten Nachbarn). Straßen beschleunigen Fahrzeuge (schwere am meisten) und halten sie bei
// Regen aus dem Matsch. Das Netz wird periodisch neu berechnet — zerstörte Gebäude verlieren
// ihre Anbindung von selbst.
import { ROAD_RECALC_TICKS, ROAD_MAX_DIST, WET_DEPTH } from '../constants.js';
import { TT } from '../terrain.js';

export function stepRoads(world) {
  if (world.tick % ROAD_RECALC_TICKS !== 0) return;
  const t = world.terrain;
  if (!t.road) return;
  const next = new Uint8Array(t.w * t.h);

  // „Echte" Gebäude je Spieler (keine Leitungen, Befestigungen, Brücken/Tunnel — die sind selbst Wege).
  const byOwner = new Map();
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    const role = e.def.role;
    if (role === 'fortification' || role === 'hydro' || role === 'infrastructure' || e.def.pipe) continue;
    let l = byOwner.get(e.owner); if (!l) byOwner.set(e.owner, l = []);
    l.push(e);
  }
  for (const list of byOwner.values()) {
    for (const b of list) {
      const near = list
        .filter(o => o !== b)
        .map(o => ({ o, d: Math.max(Math.abs(o.tx - b.tx), Math.abs(o.ty - b.ty)) }))
        .filter(x => x.d <= ROAD_MAX_DIST)
        .sort((a, c) => a.d - c.d || a.o.id - c.o.id)
        .slice(0, 2);
      for (const { o } of near) drawRoad(t, next, b, o);
    }
  }

  // Nur bei Änderung übernehmen + fürs Streaming markieren (Snapshot schickt das Netz dann einmal).
  const old = t.road;
  let changed = old.length !== next.length;
  if (!changed) for (let i = 0; i < next.length; i++) if (next[i] !== old[i]) { changed = true; break; }
  if (changed) { t.road = next; t.roadDirty = true; }
}

// Gerade Trasse zwischen den Gebäudemitten; Wasser und Klippen unterbrechen die Straße
// (außer dort, wo Brücken/Tunnel stehen).
function drawRoad(t, road, a, b) {
  const x0 = a.tx + (a.size >> 1), y0 = a.ty + (a.size >> 1);
  const x1 = b.tx + (b.size >> 1), y1 = b.ty + (b.size >> 1);
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + (x1 - x0) * (k / (n || 1)));
    const y = Math.round(y0 + (y1 - y0) * (k / (n || 1)));
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
    const i = y * t.w + x;
    if (t.type[i] === TT.CLIFF && !(t.tunnel && t.tunnel[i])) continue;
    if (t.water[i] > WET_DEPTH && !(t.bridge && t.bridge[i])) continue;
    road[i] = 1;
  }
}
