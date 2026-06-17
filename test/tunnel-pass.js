// Tunnel-Durchfahrbarkeit (Ziel D der nightly „rtsgame-selfplay-polish"-Routine).
//
// Zweck: deterministisch BEWEISEN, dass ein Tunnel eine Klippe für Fahrzeuge nicht nur
// passierbar (isPassable), sondern auch WEGEFINDBAR macht. Die Coverage-Messung
// (test/coverage.js) zeigt seit vielen Läufen „Tunnel gebaut, 0× durchfahren": Tunnel
// entstehen, aber Einheiten routen nie hindurch.
//
// WURZEL (gemessen 2026-06-18): `isPassable` lässt eine Tunnelzelle für Land zu
// (terrain.js: `ty_ !== TT.CLIFF || inTunnel`), ABER der Pfadfinder prüft die Steigung
// separat über `slopeOk` (pathfinding.js:122) — und am Tunnelmund liegt eine große
// Höhendifferenz zur Klippe. `slopeOk` nahm bislang nur Brückenzellen von der Steigung aus,
// nicht Tunnelzellen → die Fahrzeugroute durch den Tunnel wurde verworfen. FIX: Tunnelzellen
// sind in `slopeOk` steigungsfrei (wie Brückenzellen).
//
// Dieser Harness baut ein flaches Feld mit einem durchgehenden Klippenriegel (Fahrzeuge
// kommen nicht hinüber) und stanzt EINEN Tunnel durch den Riegel. Erwartung:
//   (1) OHNE Tunnel: kein Fahrzeugpfad über den Riegel (Klippe + Steigung sperren).
//   (2) MIT Tunnel:  ein Fahrzeugpfad existiert UND führt durch die Tunnelzelle.
// Infanterie (Kletterer) quert ohnehin — wird als Gegenprobe mitgemessen.
//
// Aufruf:  node test/tunnel-pass.js
// Exit 0 = Fix wirkt (Tunnel wegefindbar), 1 = verfehlt.

import { loadData } from '../shared/data-node.js';
import { createWorld } from '../shared/sim.js';
import { findPath } from '../shared/pathfinding.js';
import { tIdx, TT } from '../shared/terrain.js';
import { SLOPE_VEHICLE } from '../shared/constants.js';

const data = loadData();

// Flaches Land 40×40, ein vertikaler Klippenriegel in der Mitte, Tunnel-Loch bei (mid, midY).
function buildArena(withTunnel) {
  const w = createWorld({
    data,
    seed: 4242,
    map: { w: 40, h: 40 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
  });
  const t = w.terrain;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const mid = 20;
  const midY = 20;
  // Klippenriegel: hohe, steile Klippe — Fahrzeuge kommen weder als CLIFF noch über die Steigung hinüber.
  for (let y = 0; y < t.h; y++) {
    const i = tIdx(t, mid, y);
    t.type[i] = TT.CLIFF;
    t.height[i] = 3.0; t.height0[i] = 3.0;
  }
  if (withTunnel) {
    const i = tIdx(t, mid, midY);
    t.tunnel[i] = 1;            // Tunnel durch genau diese Klippenzelle
  }
  return { w, t, mid, midY };
}

function vehiclePath(t, sx, sy, gx, gy) {
  // Landdomäne, finite Fahrzeug-Steigung (SLOPE_VEHICLE) → identische Gates wie eine echte
  // Fahrzeugbewegung (movement.js nutzt dieselbe findPath-Signatur).
  return findPath(t, 'land', sx, sy, gx, gy, 48000, SLOPE_VEHICLE);
}

function infantryPath(t, sx, sy, gx, gy) {
  // Echte Infanterie sind Kletterer: maxSlope = Infinity (world.js), daher kein Steigungs-Gate.
  return findPath(t, 'land', sx, sy, gx, gy, 48000, Infinity, { category: 'infantry' });
}

const checks = [];

// (1) OHNE Tunnel: Fahrzeug findet KEINEN Weg über den Klippenriegel.
{
  const { t, mid, midY } = buildArena(false);
  const p = vehiclePath(t, mid - 6, midY, mid + 6, midY);
  checks.push(['Ohne Tunnel: Fahrzeug blockiert', p === null,
    p === null ? 'kein Pfad (Riegel sperrt)' : `unerwartet Pfad (${p.length} Zellen)`]);
}

// (2) MIT Tunnel: Fahrzeug findet einen Weg, der DURCH die Tunnelzelle führt.
let mitPathLen = 0, durchTunnel = false;
{
  const { t, mid, midY } = buildArena(true);
  const p = vehiclePath(t, mid - 6, midY, mid + 6, midY);
  const exists = Array.isArray(p) && p.length > 0;
  if (exists) {
    mitPathLen = p.length;
    durchTunnel = p.some(pt => {
      const tx = pt.tx ?? pt[0] ?? pt.x;
      const ty = pt.ty ?? pt[1] ?? pt.y;
      return tx === mid && ty === midY;
    });
  }
  checks.push(['Mit Tunnel: Fahrzeug findet Pfad', exists,
    exists ? `Pfad ${p.length} Zellen` : 'kein Pfad']);
  checks.push(['Pfad führt durch die Tunnelzelle', durchTunnel,
    durchTunnel ? `quert (${mid},${midY})` : 'Pfad meidet Tunnel']);
}

// (3) Gegenprobe: Infanterie quert den Riegel ohnehin (Kletterer) — Tunnel ist Fahrzeug-Feature.
{
  const { t, mid, midY } = buildArena(false);
  const p = infantryPath(t, mid - 6, midY, mid + 6, midY);
  checks.push(['Gegenprobe: Infanterie klettert auch ohne Tunnel', Array.isArray(p) && p.length > 0,
    Array.isArray(p) && p.length > 0 ? `Pfad ${p.length} Zellen` : 'kein Pfad (unerwartet)']);
}

console.log(`\n=== Tunnel-Durchfahrbarkeit (Ziel D) · Arena 40×40 · Klippenriegel + 1 Tunnel ===`);
console.log(`  Fahrzeugpfad mit Tunnel: ${mitPathLen} Zellen, durch Tunnelzelle: ${durchTunnel ? 'JA' : 'NEIN'}`);
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, okFlag, detail] of checks) {
  console.log(`  ${okFlag ? '✓' : '✗'} ${name.padEnd(46)} ${detail}`);
  if (!okFlag) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
