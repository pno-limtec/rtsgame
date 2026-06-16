// KI-Abdeckungs-Harness (Ziele C, B, D der nightly „rtsgame-selfplay-polish"-Routine).
//
// match-sim.js misst, ob Partien ENTSCHIEDEN/abwechslungsreich sind. Dieser Harness misst die bis
// dahin UNGEMESSENEN Ziele über viele KI-vs-KI-Partien:
//
//   C) Kommen ALLE Einheiten- und Gebäudetypen irgendwann zum Einsatz? (keine toten Bauoptionen)
//   B) Tragen Wasser/Überschwemmung real zu Verlusten bei? (Ertrinken/Wegspülen von Einheiten/Gebäuden)
//   D) Werden Straßen/Brücken/Tunnel nicht nur gebaut, sondern auch BEFAHREN? (Frequentierung)
//
// Mess-Prinzip: deterministisch (feste Seeds, kein Math.random in der Sim), reproduzierbar, mit
// Zielwert-Tabelle + Exit-Code (0 = alle Ziele erfüllt) — gleiche Bauart wie match-sim.js.
//
// Aufruf:  node test/coverage.js [matches] [maxTicks] [baseSeed]
//   z. B.  node test/coverage.js 8 9000

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { worldToTile, tIdx } from '../shared/terrain.js';

const data = loadData();

const N = parseInt(process.argv[2] || '8', 10);
const MAX_TICKS = parseInt(process.argv[3] || '9000', 10);
const BASE = parseInt(process.argv[4] || '5000', 10);
// Modus (4. Arg): 'organic' (Default) misst, was die KI im normalen Spiel von SELBST baut —
// das eigentliche Ziel-C-Maß (keine untergenutzten Typen). 'buildable'/'all'/'force' aktiviert
// dagegen den schon in ai.js vorhandenen Abdeckungs-Modus `world.aiCoverageTest`, der jede KI
// nacheinander JEDEN Typ bauen lässt → trennt TOTE Bauoptionen (strukturell unbaubar/kaputt)
// von bloß doktrin-bedingt seltenen Typen. 100 % im buildable-Modus = keine echte tote Option;
// die organische Lücke ist dann reines Doktrin-/Balance-Problem (ai.js-Schwellen), kein Code-Loch.
const MODE = (process.argv[5] || 'organic').toLowerCase();
const FORCE_ALL = MODE === 'buildable' || MODE === 'all' || MODE === 'force';
const SAMPLE = 50;                  // alle 50 Ticks (= 5 s) Einheiten/Infrastruktur abtasten
const factions = ['HLX', 'KBN', 'FLG'];

// --- Erwartete Typen (Nenner der Abdeckung) -----------------------------------------------------
// hq wird zu Spielbeginn gesetzt; earth_pile/ore_pile sind Gelände-/Ressourcenobjekte (role:terrain)
// und keine baubaren Optionen → aus dem Nenner ausgeschlossen.
const ALL_UNITS = Object.keys(data.units);
const BUILDABLE = Object.entries(data.buildings)
  .filter(([k, b]) => k !== 'hq' && (b.role !== 'terrain'))
  .map(([k]) => k);

// --- Akkumulatoren über alle Partien ------------------------------------------------------------
const seenUnits = new Set();        // je produziertem Einheitentyp (von irgendeiner KI)
const seenBuildings = new Set();    // je gebautem Gebäudetyp
const unitFirstMatch = {};          // Typ → erste Partie, in der er auftauchte (Diagnose)
const bldFirstMatch = {};

let waterKillsUnits = 0;            // Einheiten von Wasser getötet (washout-Event, etype unit)
let waterKillsBld = 0;             // Gebäude von Wasser zerstört (washout-Event, etype building)
let matchesWithWaterKill = 0;      // Partien mit ≥1 Wasser-Tötung (Einheit)
let matchesWithWaterBldKill = 0;   // Partien mit ≥1 von Wasser zerstörtem Gebäude
let matchesWithWaterImpact = 0;    // Partien mit ≥1 Wasser-Verlust (Einheit ODER Gebäude) = Ziel B
let floodedUnitTicks = 0;          // Stichproben: Einheiten gerade im Flutwasser (inFlood)

let tunnelBuilds = 0, bridgeBuilds = 0, roadBuilds = 0;   // gebaute Infrastruktur (Endbestand)
let tunnelTraverseTicks = 0;       // Stichproben: Einheit in einer Tunnelröhre (inTunnel)
let bridgeTraverseTicks = 0;       // Stichproben: Landeinheit auf einer Brückenkachel
let roadTraverseTicks = 0;         // Stichproben: Einheit auf gebauter Straße (roadBuilt)
let matchesWithTunnelUse = 0, matchesWithBridgeUse = 0;

const rows = [];

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [
    { id: 0, faction: fa, controller: 'ai' },
    { id: 1, faction: fb, controller: 'ai' },
  ];
  const world = createWorld({ data, seed: BASE + s * 131, players });
  if (FORCE_ALL) world.aiCoverageTest = true;   // KI baut/produziert jeden Typ → Baubarkeits-Abdeckung
  const t = world.terrain;

  let mWaterUnit = 0, mWaterBld = 0, mTunnelUse = 0, mBridgeUse = 0;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    step(world);

    // (B) Wasser-Tötungen: washout-Events leben nur diesen Tick (world.events wird je step geleert).
    for (const ev of world.events) {
      if (ev.type !== 'washout') continue;
      if (ev.etype === 'building') { waterKillsBld++; mWaterBld++; }
      else { waterKillsUnits++; mWaterUnit++; }
    }

    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) break;

    if (tick % SAMPLE === 0) {
      for (const e of world.entities.values()) {
        if (e.dead) continue;
        if (e.etype === 'unit') {
          seenUnits.add(e.kind);
          if (unitFirstMatch[e.kind] == null) unitFirstMatch[e.kind] = s;
          if (e.inFlood && world.tick - e.inFlood <= 2) floodedUnitTicks++;
          if (e.inTunnel) { tunnelTraverseTicks++; mTunnelUse++; }
          else {
            const [tx, ty] = worldToTile(e.x, e.y);
            if (tx >= 0 && ty >= 0 && tx < t.w && ty < t.h) {
              const i = tIdx(t, tx, ty);
              if (e.domain === 'land' && t.bridge && t.bridge[i] > 0) { bridgeTraverseTicks++; mBridgeUse++; }
              if (t.roadBuilt && t.roadBuilt[i] > 0) roadTraverseTicks++;
            }
          }
        } else if (e.etype === 'building') {
          seenBuildings.add(e.kind);
          if (bldFirstMatch[e.kind] == null) bldFirstMatch[e.kind] = s;
        }
      }
    }
  }

  // Endbestand Infrastruktur dieser Partie.
  let tn = 0, br = 0, rd = 0;
  for (const e of world.entities.values()) {
    if (e.dead || e.etype !== 'building') continue;
    if (e.kind === 'tunnel') tn++; else if (e.kind === 'bridge') br++; else if (e.kind === 'road') rd++;
  }
  tunnelBuilds += tn; bridgeBuilds += br; roadBuilds += rd;
  if (mWaterUnit > 0) matchesWithWaterKill++;
  if (mWaterBld > 0) matchesWithWaterBldKill++;
  if (mWaterUnit > 0 || mWaterBld > 0) matchesWithWaterImpact++;
  if (mTunnelUse > 0) { matchesWithTunnelUse++; }
  if (mBridgeUse > 0) { matchesWithBridgeUse++; }

  rows.push(`  #${String(s).padStart(2)} ${fa}/${fb}  Wasser-Kills U${mWaterUnit}/B${mWaterBld}  Infra T${tn}/Br${br}/R${rd}  befahren tun${mTunnelUse} br${mBridgeUse}`);
}

// --- Auswertung ----------------------------------------------------------------------------------
const unitCov = seenUnits.size / ALL_UNITS.length;
const bldCov = seenBuildings.size / BUILDABLE.length;
const missingUnits = ALL_UNITS.filter(u => !seenUnits.has(u));
const missingBld = BUILDABLE.filter(b => !seenBuildings.has(b));

console.log(`\n=== KI-Abdeckung: ${N} Partien · max ${MAX_TICKS} Ticks · Seeds ${BASE}+ · Modus ${FORCE_ALL ? 'BAUBARKEIT (aiCoverageTest)' : 'organisch'} ===`);
if (FORCE_ALL) console.log('  (Baubarkeits-Modus: KI versucht jeden Typ zu bauen → 100 % = keine tote Option; <100 % = strukturell unbaubarer/kaputter Typ)');
for (const r of rows) console.log(r);

console.log(`\n--- (C) Typen-Abdeckung ---`);
console.log(`  Einheiten ${seenUnits.size}/${ALL_UNITS.length} (${(unitCov * 100).toFixed(0)}%)  fehlen: ${missingUnits.join(', ') || '—'}`);
console.log(`  Gebäude   ${seenBuildings.size}/${BUILDABLE.length} (${(bldCov * 100).toFixed(0)}%)  fehlen: ${missingBld.join(', ') || '—'}`);

console.log(`\n--- (B) Wasser-Beitrag ---`);
console.log(`  Einheiten ertränkt/weggespült: ${waterKillsUnits}  ·  Gebäude zerstört: ${waterKillsBld}`);
console.log(`  Partien mit Wasser-Tötung: ${matchesWithWaterKill}/${N} (${(matchesWithWaterKill / N * 100).toFixed(0)}%)  ·  mit Gebäude-Verlust: ${matchesWithWaterBldKill}/${N}`);
console.log(`  Partien mit Wasser-Beitrag (Einheit ODER Gebäude): ${matchesWithWaterImpact}/${N} (${(matchesWithWaterImpact / N * 100).toFixed(0)}%)`);
console.log(`  Stichproben Einheiten im Flutwasser: ${floodedUnitTicks}`);

console.log(`\n--- (D) Infrastruktur-Nutzung ---`);
console.log(`  Gebaut (Summe): Straße ${roadBuilds} · Brücke ${bridgeBuilds} · Tunnel ${tunnelBuilds}`);
console.log(`  Befahren (Stichproben): Straße ${roadTraverseTicks} · Brücke ${bridgeTraverseTicks} · Tunnel ${tunnelTraverseTicks}`);
console.log(`  Partien mit Tunnel-Durchfahrt: ${matchesWithTunnelUse}/${N}  ·  mit Brücken-Querung: ${matchesWithBridgeUse}/${N}`);

// --- Zielwerte (Gating) --------------------------------------------------------------------------
// Bewusst konservativ angesetzt; ein neu eingeführter Harness deckt zuerst Lücken auf. Die Routine
// hebt die Schwellen, sobald die Realität sie überholt (siehe Memory).
const TARGET = {
  unitCov: 0.60,        // ≥ 60 % der Einheitentypen kommen vor
  bldCov: 0.75,         // ≥ 75 % der baubaren Gebäudetypen
  waterMatchRate: 0.20, // Wasser fordert in ≥ 20 % der Partien Verluste (Einheit ODER Gebäude — Ziel B
                        // umfasst ausdrücklich „Fluten zerstören Gebäude"; reine Einheiten-Ertrinkung
                        // ist auf 4 Partien ein 1-Match-Messer und kippt bei jeder KI-Störung)
  bridgeOrTunnelUse: 1, // Brücken/Tunnel werden in ≥ 1 Partie tatsächlich befahren
};
const bridgeTunnelUseMatches = matchesWithTunnelUse + matchesWithBridgeUse;
const checks = [
  ['Einheiten-Abdeckung', unitCov >= TARGET.unitCov, `${(unitCov * 100).toFixed(0)}% ≥ ${(TARGET.unitCov * 100)}%`],
  ['Gebäude-Abdeckung', bldCov >= TARGET.bldCov, `${(bldCov * 100).toFixed(0)}% ≥ ${(TARGET.bldCov * 100)}%`],
  ['Wasser-Beitrag', matchesWithWaterImpact / N >= TARGET.waterMatchRate, `${(matchesWithWaterImpact / N * 100).toFixed(0)}% ≥ ${(TARGET.waterMatchRate * 100)}%`],
  ['Infra befahren', bridgeTunnelUseMatches >= TARGET.bridgeOrTunnelUse, `${bridgeTunnelUseMatches} Partien ≥ ${TARGET.bridgeOrTunnelUse}`],
];
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, okFlag, detail] of checks) {
  console.log(`  ${okFlag ? '✓' : '✗'} ${name.padEnd(22)} ${detail}`);
  if (!okFlag) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
