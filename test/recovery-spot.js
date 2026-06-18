// Katastrophen-Erholung: Bauplatz-Robustheit (Ziel H der nightly „rtsgame-selfplay-polish").
//
// Zweck: deterministisch BEWEISEN, dass die erschöpfende Erholungs-Suche `pickRecoverySpot`
// einen Bauplatz für ein naturbedingt verlorenes Kern-Gebäude findet, wo die normale
// Stichproben-Suche `pickBuildSpot` versagt.
//
// WURZEL (gemessen 2026-06-18, disaster-check insanity 3): Unter Chaos-Wetter zerwühlen
// Dauerlawinen das Basis-Terrain. `pickBuildSpot` zieht NUR 60 Zufalls-Stichproben im
// INNEREN halben Bauradius (r = 4 + rng·radius/2 ∈ [4, radius/2]) — ist dieser Kern verklippt,
// findet sie keinen Platz und der Wiederaufbau scheitert, OBWOHL im äußeren Bauradius noch
// flacher Boden liegt. `pickRecoverySpot` scannt deterministisch JEDE Zelle im VOLLEN
// HQ-Bauradius und erreicht so den äußeren Ring. Sie verbraucht kein world.rng (reiner Scan)
// und wird in manageBuild NUR unter insanity≥3 aufgerufen → Normalspiel bit-identisch.
//
// Dieser Harness verklippt eine Scheibe (r ≤ radius/2) rund ums HQ und lässt den äußeren Ring
// (radius/2 < r ≤ radius) flach. Erwartung für ein ankerfreies Wirtschaftsgebäude (power_plant,
// role=economy → kein BUILD_ANCHOR_RANGE-Limit):
//   (1) pickBuildSpot findet KEINEN Platz (Stichproben treffen nur den verklippten Kern).
//   (2) pickRecoverySpot findet EINEN Platz, der platzierbar ist und im äußeren Ring liegt.
//
// Aufruf:  node test/recovery-spot.js
// Exit 0 = Erholungs-Suche wirkt (findet, was die Stichprobe verfehlt), 1 = verfehlt.

import { loadData } from '../shared/data-node.js';
import { createWorld } from '../shared/sim.js';
import { canPlaceBuilding } from '../shared/world.js';
import { tIdx, TT } from '../shared/terrain.js';
import { pickBuildSpot, pickRecoverySpot } from '../shared/ai/ai.js';

const data = loadData();

const world = createWorld({
  data,
  seed: 4242,
  map: { w: 48, h: 48 },
  players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
});
const t = world.terrain;

// Komplette Arena flach und trocken setzen (wie tunnel-pass.js).
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

const hq = [...world.entities.values()].find(e => e.kind === 'hq' && e.owner === 0);
if (!hq) { console.error('Kein HQ für Spieler 0 gefunden'); process.exit(1); }

const radius = data.buildings.hq.buildRadius || 16;
const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
// pickBuildSpot würfelt r = 4 + rng·(radius/2) ∈ [4, 4+radius/2] — das ist ihre maximale Reichweite.
const inner = 4 + radius / 2;

// Lawinen-Verwüstung: die gesamte Stichproben-Reichweite rund ums HQ verklippen (Bauland weg),
// äußeren Ring (inner < r ≤ radius) flach lassen. So existiert Bauland NUR außerhalb der
// Reichweite von pickBuildSpot, aber innerhalb des vollen Bauradius (den nur pickRecoverySpot scannt).
let outerFree = 0;
for (let ty = 0; ty < t.h; ty++) for (let tx = 0; tx < t.w; tx++) {
  const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
  const i = tIdx(t, tx, ty);
  if (d <= inner + 0.5) { t.type[i] = TT.CLIFF; t.height[i] = 3.0; t.height0[i] = 3.0; }
  else if (d <= radius) outerFree++;
}

const def = data.buildings.power_plant;   // role=economy → kein Anker-Limit, voller Bauradius nutzbar
const size = def.size || 1;

const checks = [];

// (1) Stichproben-Suche scheitert: alle 60 Würfe landen im verklippten Kern.
const sample = pickBuildSpot(world, hq, size, def);
checks.push(['pickBuildSpot scheitert am verklippten Kern', sample == null,
  sample == null ? 'kein Platz (Stichprobe trifft nur Klippe)' : `unerwartet Platz (${sample[0]},${sample[1]})`]);

// (2) Erholungs-Suche findet den äußeren Ring.
const rec = pickRecoverySpot(world, hq, size, def, 0);
const recOk = Array.isArray(rec);
let recPlaceable = false, recDist = 0, recOuter = false;
if (recOk) {
  recPlaceable = canPlaceBuilding(world, rec[0], rec[1], size, def, 0);
  recDist = Math.hypot(rec[0] + size / 2 - cx, rec[1] + size / 2 - cy);
  recOuter = recDist > inner;
}
checks.push(['pickRecoverySpot findet einen Platz', recOk,
  recOk ? `Platz (${rec[0]},${rec[1]})` : 'kein Platz']);
checks.push(['Gefundener Platz ist wirklich platzierbar', recPlaceable,
  recPlaceable ? 'canPlaceBuilding == true' : 'NICHT platzierbar']);
checks.push(['Platz liegt im äußeren Bauradius (jenseits der Stichprobe)', recOuter,
  recOk ? `r=${recDist.toFixed(1)} > ${inner.toFixed(1)}` : '—']);

console.log(`\n=== Katastrophen-Erholung: Bauplatz-Robustheit (Ziel H) · Arena 48×48 ===`);
console.log(`  HQ-Zentrum (${cx},${cy}) · Bauradius ${radius} · Stichproben-Reichweite ≤ ${inner.toFixed(1)}`);
console.log(`  Verklippter Kern r ≤ ${inner.toFixed(1)} · freie äußere Ringzellen: ${outerFree}`);
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, okFlag, detail] of checks) {
  console.log(`  ${okFlag ? '✓' : '✗'} ${name.padEnd(52)} ${detail}`);
  if (!okFlag) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
