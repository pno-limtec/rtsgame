// Produktionssystem: Gebäudebau-Fortschritt + Einheiten-Warteschlangen.
import { DT } from '../constants.js';
import { spawnUnit, applyFortification, buildSpeedMult, grantEarthYield } from '../world.js';
import { tileToWorld, worldToTile, isPassable } from '../terrain.js';
import { setMoveGoal } from './movement.js';
import { activateTunnelIfReady } from './tunnel.js';

export function stepProduction(world) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead) continue;
    const p = world.players.find(pp => pp.id === e.owner);
    // Energiedefizit drosselt (stoppt nicht ganz); Fraktions-research beschleunigt Bau/Produktion.
    const ratio = (p ? (0.5 + 0.5 * p.energy.ratio) : 1) * buildSpeedMult(world, e.owner);

    // Bauphase des Gebäudes selbst — schreitet nur voran, wenn ein Bagger vor Ort
    // arbeitet (stepConstruction stempelt _builderNear im selben/vorigen Tick).
    if (e.buildProgress < 1) {
      const bt = e.def.buildTime || 1;
      const workerOnSite = !e.def.buildTime || (e._builderNear != null && world.tick - e._builderNear <= 1);
      if (workerOnSite) {
        e.buildProgress = Math.min(1, e.buildProgress + (DT / bt) * ratio);
        e.hp = Math.max(e.hp, Math.round(e.maxHp * (0.5 + e.buildProgress * 0.5)));
        if (e.buildProgress >= 1) onBuildingComplete(world, e);
      }
      continue;
    }

    // Einheiten-Warteschlange — steht still, wenn das Gebäude beim Lastabwurf abgeschaltet wurde.
    if (e.queue && e.queue.length) {
      if (e._powered === false) continue;
      const item = e.queue[0];
      // Mehrere gleichartige Produktionsgebäude beschleunigen die Fertigung (abnehmender Ertrag):
      // 1×=1.0, 2×=1.5, 3×=2.0, … gedeckelt bei 3.0 — wie in C&C, wo zusätzliche Fabriken schneller bauen.
      item.timeLeft -= DT * ratio * siblingSpeedFactor(world, e);
      if (item.timeLeft <= 0) {
        const domain = (world.data.units[item.kind] || {}).domain || 'land';
        const spot = freeSpot(world, e, domain);
        if (spot) {
          const u = spawnUnit(world, e.owner, item.kind, spot[0], spot[1]);
          if (e.rally) setMoveGoal(world, u, e.rally.x, e.rally.y);
          e.queue.shift();
          world.events.push({ type: 'produced', x: e.x, y: e.y, kind: item.kind, owner: e.owner });
        } // sonst: warten bis Platz frei wird
      }
    }
  }
}

// Anzahl betriebsbereiter Produktionsgebäude desselben Typs → Geschwindigkeitsfaktor mit
// abnehmendem Ertrag (jedes weitere Gebäude +0.5, gedeckelt bei 3.0).
function siblingSpeedFactor(world, e) {
  let count = 0;
  for (const o of world.entities.values()) {
    if (o.etype === 'building' && !o.dead && o.owner === e.owner && o.kind === e.kind
      && o.buildProgress >= 1 && o._powered !== false) count++;
  }
  return 1 + Math.min(2, Math.max(0, count - 1) * 0.5);
}

function onBuildingComplete(world, e) {
  e.hp = e.maxHp;
  world.events.push({ type: 'build', x: e.x, y: e.y, kind: e.kind, owner: e.owner });
  applyFortification(world, e); // Wall/Graben/Tunnelmündung aktivieren Deckung & Sperre/Passierbarkeit
  if (e._tunnelId != null) activateTunnelIfReady(world, e); // beide Mündungen fertig → Röhre öffnen
  // Erdaushub: Gräben/Tunnel liefern Erde als Baumaterial (Ressource „materials") —
  // wer Material für Wälle/Dämme braucht, gräbt dafür Löcher in die Landschaft.
  grantEarthYield(world, e);
  if (e.def.spawns) {
    const spot = freeSpot(world, e);
    if (spot) spawnUnit(world, e.owner, e.def.spawns, spot[0], spot[1]);
  }
}

// Freien Weltpunkt am Rand des Gebäudes finden — in der passenden Domäne der Einheit
// (Marine erscheint auf Wasser, Luft/Land neben dem Gebäude). Marine sucht weiter, da
// Werften nur am Wasser stehen und der freie Wasserpunkt mehrere Tiles entfernt liegen kann.
function freeSpot(world, e, domain = 'land') {
  const { terrain } = world;
  const placeDomain = domain === 'air' ? 'land' : domain; // Luft erscheint über Land an der Basis
  const maxR = (domain === 'water' || domain === 'amphibious') ? e.size + 9 : e.size + 4;
  for (let r = e.size; r <= maxR; r++) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const tx = e.tx + e.size / 2 + Math.cos(ang) * r;
      const ty = e.ty + e.size / 2 + Math.sin(ang) * r;
      const itx = Math.floor(tx), ity = Math.floor(ty);
      if (isPassable(terrain, placeDomain, itx, ity)) return tileToWorld(itx, ity);
    }
  }
  if (domain === 'water' || domain === 'amphibious') return null; // kein Wasser frei → warten
  return null; // Land/Luft warten ebenfalls, statt im Gebäude oder Wasser zu erscheinen
}
