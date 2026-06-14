// Tunnel-System: ein Tunnel ist EINE verknüpfte Struktur (zwei zerstörbare Mündungsgebäude an
// Hängen + eine durchgehende Röhre dazwischen). Einheiten verschwinden in der Röhre (nur als
// Umriss sichtbar) und tauchen am anderen Ende wieder auf; Wasser fließt durch. Wird eine Mündung
// zerstört, ist sie versiegelt (Resteinheiten nutzen das offene Ende); sind beide zerstört,
// zerfällt der Tunnel und alle Einheiten darin sterben.
import {
  TT, inBounds, tIdx, worldToTile, stampFortification, unstampFortification,
} from '../terrain.js';
import { spawnBuilding, canAfford, pay } from '../world.js';
import { TUNNEL_MAX_LEN, TUNNEL_COST_ORE, TUNNEL_COST_MAT, TUNNEL_WATER_FLOW, WATER_MAX_DEPTH } from '../constants.js';

// Tiles entlang der geraden Linie (start..end inklusive), dedupliziert — wie der Straßen-Linienbau.
export function tunnelLineTiles(sx, sy, ex, ey) {
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

// Eine Tunnelmündung muss an einem HANG liegen: bebaubarer Boden (Land/Hügel, kein Wasser/Erz/Öl),
// der orthogonal an eine Klippe grenzt (der Tunnel bohrt sich dort in den Berg).
export function isHangMouth(t, tx, ty) {
  if (!inBounds(t, tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  const tt = t.type[i];
  if (tt !== TT.LAND && tt !== TT.HILL) return false;
  if (t.ore[i] > 0) return false;
  if (t.oil && t.oil[i] > 0) return false;
  if ((t.water[i] || 0) > 0) return false;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = tx + dx, ny = ty + dy;
    if (inBounds(t, nx, ny) && t.type[tIdx(t, nx, ny)] === TT.CLIFF) return true;
  }
  return false;
}

// Linie validieren → Tiles zurückgeben oder null. Beide Enden Hang-Mündung, das Innere quert
// mindestens eine Klippe/Hügel (echter Durchbruch), Länge im Rahmen.
export function validateTunnel(world, sx, sy, ex, ey) {
  const t = world.terrain;
  if (!inBounds(t, sx, sy) || !inBounds(t, ex, ey)) return null;
  const tiles = tunnelLineTiles(sx, sy, ex, ey);
  if (tiles.length < 3 || tiles.length > TUNNEL_MAX_LEN) return null;
  if (!isHangMouth(t, sx, sy) || !isHangMouth(t, ex, ey)) return null;
  let crosses = false;
  for (let k = 1; k < tiles.length - 1; k++) {
    const [tx, ty] = tiles[k];
    const tt = t.type[tIdx(t, tx, ty)];
    if (tt === TT.CLIFF || tt === TT.HILL) { crosses = true; break; }
  }
  return crosses ? tiles : null;
}

export function findTunnel(world, id) {
  return (world.tunnels || []).find(tn => tn.id === id) || null;
}

// Tunnel platzieren (ein Linienbefehl): validieren, bezahlen, zwei Mündungs-Baustellen erzeugen,
// Tunnel-Record anlegen. Die Bagger bauen die Mündungen wie jedes andere Gebäude; aktiviert wird
// die Röhre erst, wenn BEIDE Mündungen fertig sind (activateTunnelIfReady).
export function placeTunnel(world, player, sx, sy, ex, ey, inRadius) {
  const tiles = validateTunnel(world, sx, sy, ex, ey);
  if (!tiles) return false;
  // Mindestens eine Mündung muss im eigenen Bauradius liegen (wie andere Infrastruktur).
  if (inRadius && !inRadius(world, player.id, sx, sy, 1) && !inRadius(world, player.id, ex, ey, 1)) return false;
  const cost = { ore: TUNNEL_COST_ORE * tiles.length, materials: TUNNEL_COST_MAT * tiles.length };
  if (!canAfford(player, cost)) return false;
  pay(player, cost);
  const id = (world._tunnelSeq = (world._tunnelSeq || 0) + 1);
  const mouthA = spawnBuilding(world, player.id, 'tunnel', sx, sy);
  const mouthB = spawnBuilding(world, player.id, 'tunnel', ex, ey);
  mouthA._tunnelId = id; mouthA._tunnelEnd = 'A';
  mouthB._tunnelId = id; mouthB._tunnelEnd = 'B';
  const tn = {
    id, owner: player.id, tiles,
    mouthA: mouthA.id, mouthB: mouthB.id,
    aTile: [sx, sy], bTile: [ex, ey],
    sealedA: false, sealedB: false, inside: [], active: false, stamped: false,
  };
  (world.tunnels || (world.tunnels = [])).push(tn);
  return true;
}

const isMouthTile = (tn, tx, ty) =>
  (tx === tn.aTile[0] && ty === tn.aTile[1]) || (tx === tn.bTile[0] && ty === tn.bTile[1]);

// Wird aus onBuildingComplete aufgerufen, sobald eine Mündung fertig ist: sind BEIDE fertig,
// die Innen-Tiles begehbar stempeln und die Röhre aktiv schalten.
export function activateTunnelIfReady(world, mouth) {
  const tn = findTunnel(world, mouth._tunnelId);
  if (!tn || tn.stamped) return;
  const a = world.entities.get(tn.mouthA), b = world.entities.get(tn.mouthB);
  if (!a || !b || a.buildProgress < 1 || b.buildProgress < 1) return;
  const t = world.terrain;
  const map = world.tunnelTiles || (world.tunnelTiles = new Map());
  for (const [tx, ty] of tn.tiles) {
    if (isMouthTile(tn, tx, ty)) continue;             // Mündungs-Tiles stempelt applyFortification selbst
    stampFortification(t, tx, ty, 1, 0, false, false, 0, { tunnel: true });
    map.set(tIdx(t, tx, ty), tn);                       // Innen-Tiles → verdeckte Durchquerung
  }
  tn.stamped = true;
  tn.active = true;
}

// Eine Mündung wurde zerstört: dieses Ende versiegeln. Die Mündungszelle wird über
// removeFortification (cleanup) ohnehin entstempelt → kein Neueintritt dort, aber das Innere bleibt
// zum offenen Ende passierbar. Sind BEIDE Enden tot, kollabiert der Tunnel.
export function onTunnelMouthDestroyed(world, mouth) {
  const tn = findTunnel(world, mouth._tunnelId);
  if (!tn) return;
  const t = world.terrain;
  // Das betroffene Ende dicht machen: das INNEN-Tile direkt an der zerstörten Mündung entstempeln
  // (die Mündung selbst liegt auf flachem Hang-Boden und bleibt begehbar). Die Mündungs-Tiles sind
  // tiles[0] (A) bzw. tiles[letztes] (B); das jeweils angrenzende Innen-Tile schließt den Durchgang.
  const sealEnd = (k) => {
    const cell = tn.tiles[k];
    if (!cell) return;
    if (world.tunnelTiles) world.tunnelTiles.delete(tIdx(t, cell[0], cell[1]));
    if (t.tunnel && t.tunnel[tIdx(t, cell[0], cell[1])] > 0) {
      unstampFortification(t, cell[0], cell[1], 1, 0, false, false, 0, { tunnel: true });
    }
  };
  if (mouth._tunnelEnd === 'A') { tn.sealedA = true; sealEnd(1); }
  else { tn.sealedB = true; sealEnd(tn.tiles.length - 2); }
  const a = world.entities.get(tn.mouthA), b = world.entities.get(tn.mouthB);
  const aDead = !a || a.dead || a.hp <= 0;
  const bDead = !b || b.dead || b.hp <= 0;
  if (aDead && bDead) collapseTunnel(world, tn);
}

function collapseTunnel(world, tn) {
  const t = world.terrain;
  for (const [tx, ty] of tn.tiles) {
    if (world.tunnelTiles) world.tunnelTiles.delete(tIdx(t, tx, ty));
    if (isMouthTile(tn, tx, ty)) continue;            // Mündungs-Tiles räumt removeFortification auf
    unstampFortification(t, tx, ty, 1, 0, false, false, 0, { tunnel: true });
  }
  // Alle Einheiten in der Röhre kommen mit unter (wie Insassen eines zerstörten Transporters).
  for (const uid of tn.inside) {
    const u = world.entities.get(uid);
    if (!u || u.dead) continue;
    u.dead = true; u.hp = 0; u.inTunnel = null;
    world.events.push({ type: 'death', id: u.id, x: u.x, y: u.y, etype: 'unit', kind: u.kind, cause: 'tunnel_collapse' });
  }
  tn.inside.length = 0;
  tn.active = false;
  const idx = world.tunnels.indexOf(tn);
  if (idx >= 0) world.tunnels.splice(idx, 1);
}

// Pro Tick: Zugehörigkeit aktualisieren (welche Einheit ist gerade in welcher Röhre verborgen) und
// Wasser durch aktive Tunnel fließen lassen.
export function stepTunnels(world) {
  const list = world.tunnels;
  if (!list || !list.length) return;
  const t = world.terrain;
  for (const tn of list) tn.inside.length = 0;
  const map = world.tunnelTiles;
  if (map && map.size) {
    for (const e of world.entities.values()) {
      if (e.etype !== 'unit' || e.dead) continue;
      if (e.domain === 'air') { if (e.inTunnel) e.inTunnel = null; continue; }
      const [tx, ty] = worldToTile(e.x, e.y);
      const tn = inBounds(t, tx, ty) ? map.get(tIdx(t, tx, ty)) : null;
      if (tn && tn.active) { e.inTunnel = tn.id; tn.inside.push(e.id); }
      else if (e.inTunnel) e.inTunnel = null;
    }
  }
  stepTunnelWater(world);
}

// Wasser-Fluidsimulation durch die Röhre: zwischen den beiden Mündungszellen entlang des
// Oberflächengefälles (height+water) Wasser transferieren — der Tunnel verbindet zwei sonst durch
// den Berg getrennte Becken. Begrenzt durch TUNNEL_WATER_FLOW; nur bei offenen Enden.
function stepTunnelWater(world) {
  const t = world.terrain;
  for (const tn of world.tunnels) {
    if (!tn.active || tn.sealedA || tn.sealedB) continue;
    const ia = tIdx(t, tn.aTile[0], tn.aTile[1]);
    const ib = tIdx(t, tn.bTile[0], tn.bTile[1]);
    const sa = t.height[ia] + (t.water[ia] || 0);
    const sb = t.height[ib] + (t.water[ib] || 0);
    const diff = sa - sb;
    if (Math.abs(diff) < 0.003) continue;
    const hi = diff > 0 ? ia : ib, lo = diff > 0 ? ib : ia;
    const move = Math.min(t.water[hi] || 0, Math.abs(diff) * 0.5 * TUNNEL_WATER_FLOW);
    if (move <= 0.0005) continue;
    t.water[hi] -= move;
    t.water[lo] = Math.min(WATER_MAX_DEPTH, (t.water[lo] || 0) + move);
    if (t.waterActive) { t.waterActive.add(ia); t.waterActive.add(ib); }
  }
}
