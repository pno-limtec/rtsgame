// Strategie-/Archetyp-Abdeckung — Mess-Harness (selfplay-polish-Routine, Ziel A "abwechslungsreich").
//
// match-sim.js zählt nur, WIE VIELE verschiedene Sieger-Archetypen über alle Partien auftreten
// (Strategie-Vielfalt ≥3). Dieser Harness misst die URSACHEN dahinter, damit die Doktrin-/Produktions-
// Arbeit in shared/ai/ai.js gezielt nachgebessert werden kann:
//   - Zusammensetzung der SIEGER-Armee (Infanterie- vs. Fahrzeug-Anteil): zeigt, ob Siege fast immer
//     vom billigen Infanterie-Schwarm getragen werden (→ Archetyp bleibt monoton "infantry").
//   - EMERGENZ der Spezialzweige: in wie vielen Partien wird je eine Airbase/Werft GEBAUT und kommen
//     Luft-/Marine-Einheiten real ins Feld. Tote Spezialzweige = fehlende Archetypen "air"/"naval".
//   - Spitzen-Heeresstärke (maxVeh/maxInf) je Spieler: deckt auf, ob Fahrzeuge zu klein bleiben.
//
// Determinismus: liest nur geseedeten Sim-Zustand (kein Math.random/Date.now im Lesepfad), gleiche
// Bauart wie match-sim.js (createWorld(seed) + step). Reproduzierbar über (matches, maxTicks, baseSeed).
//
// Aufruf:  node test/strategy-coverage.js [matches] [maxTicks] [baseSeed]
//   Default 9×12000 ab Seed 7000. WICHTIG: Partien entscheiden sich SPÄT — bei 9000 Ticks sind viele
//   noch unentschieden (Führung baut sich auf), erst ~10000–12000 fallen die meisten. Für aussagekräftige
//   Sieger-Archetypen ALSO maxTicks ≥ 12000 verwenden (kürzere Läufe nur als schneller Rauch-Check).
// Exit-Code 0 = alle Zielwerte erfüllt, 1 = ein Ziel verfehlt (Routine-Gating wie die anderen Harnesse).

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';

const data = loadData();
const factions = ['HLX', 'KBN', 'FLG'];
const N = parseInt(process.argv[2] || '9', 10);
const MAX = parseInt(process.argv[3] || '12000', 10);
const BASE = parseInt(process.argv[4] || '7000', 10);

// Zielwerte (Ziel A: abwechslungsreich — nicht nur Infanterie-Schwarm, Spezialzweige leben).
const TARGET = {
  minNonInfantryArch: 2,   // ≥ 2 NICHT-infantry Sieger-Archetypen (combined/armor/air/naval) über alle Siege
  airEmergeRate: 0.25,     // in ≥ 25 % der Partien baut mind. ein Spieler eine Airbase
  navalEmergeRate: 0.25,   // in ≥ 25 % der Partien baut mind. ein Spieler eine Werft
  swarmShareMax: 0.80,     // ≤ 80 % der Siege dürfen von einer >85%-Infanterie-Armee getragen sein
};

function cats(world, pid) {
  const c = { infantry: 0, vehicle: 0, air: 0, naval: 0 };
  for (const e of world.entities.values()) {
    if (e.owner !== pid || e.etype !== 'unit' || !e.weapon) continue;
    c[e.category] = (c[e.category] || 0) + 1;
  }
  return c;
}
// Dominanter Armee-Archetyp (gleiche Schwellen wie match-sim.js archetype()).
function archetype(c) {
  const total = c.infantry + c.vehicle + c.air + c.naval;
  if (total < 4) return 'tiny';
  const f = (x) => x / total;
  if (f(c.naval) >= 0.30) return 'naval';
  if (f(c.air) >= 0.30) return 'air';
  if (f(c.infantry) >= 0.6) return 'infantry';
  if (f(c.vehicle) >= 0.6) return 'armor';
  return 'combined';
}
function countBld(world, pid, kind) {
  let n = 0;
  for (const e of world.entities.values())
    if (e.owner === pid && e.etype === 'building' && e.kind === kind && (e.buildProgress ?? 1) >= 1) n++;
  return n;
}

const winnerArch = {};                  // Archetyp → Anzahl Siege
let decided = 0, swarmWins = 0;         // swarmWins = Siege mit >85% Infanterie-Armee
let airMatches = 0, navalMatches = 0;   // Partien mit gebauter Airbase / Werft (egal welcher Spieler)
let airUnitMatches = 0, navalUnitMatches = 0; // … und mit real gefeldeten Luft-/Marine-Einheiten
const rows = [];

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [{ id: 0, faction: fa, controller: 'ai' }, { id: 1, faction: fb, controller: 'ai' }];
  const world = createWorld({ data, seed: BASE + s * 97, players });
  const everAir = [0, 0], everShip = [0, 0], everAirU = [0, 0], everNavU = [0, 0];
  const maxVeh = [0, 0], maxInf = [0, 0];
  let winner = null;
  for (let t = 0; t < MAX; t++) {
    step(world);
    if (t % 100 === 0) {
      for (let p = 0; p < 2; p++) {
        everAir[p] = Math.max(everAir[p], countBld(world, p, 'airbase'));
        everShip[p] = Math.max(everShip[p], countBld(world, p, 'shipyard'));
        const c = cats(world, p);
        maxVeh[p] = Math.max(maxVeh[p], c.vehicle);
        maxInf[p] = Math.max(maxInf[p], c.infantry);
        if (c.air > 0) everAirU[p] = 1;
        if (c.naval > 0) everNavU[p] = 1;
      }
    }
    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) { winner = alive[0] || null; break; }
  }
  if (everAir[0] || everAir[1]) airMatches++;
  if (everShip[0] || everShip[1]) navalMatches++;
  if (everAirU[0] || everAirU[1]) airUnitMatches++;
  if (everNavU[0] || everNavU[1]) navalUnitMatches++;

  if (winner) {
    decided++;
    const c = cats(world, winner.id);
    const tot = c.infantry + c.vehicle + c.air + c.naval || 1;
    const infPct = c.infantry / tot;
    const arch = archetype(c);
    winnerArch[arch] = (winnerArch[arch] || 0) + 1;
    if (infPct > 0.85) swarmWins++;
    rows.push(`  #${String(s).padStart(2)} ${fa}/${fb} → SIEG ${winner.faction}  [${arch}]  inf=${c.infantry} veh=${c.vehicle} air=${c.air} nav=${c.naval} (inf ${(infPct * 100).toFixed(0)}%)`);
  } else {
    rows.push(`  #${String(s).padStart(2)} ${fa}/${fb} → UNENTSCHIEDEN  maxVeh=[${maxVeh}] maxInf=[${maxInf}] airbase=[${everAir}] werft=[${everShip}]`);
  }
}

console.log(`\n=== Strategie-/Archetyp-Abdeckung: ${N} Partien · max ${MAX} Ticks · Seeds ${BASE}+ ===`);
for (const r of rows) console.log(r);

const nonInfArch = Object.keys(winnerArch).filter(a => a !== 'tiny' && a !== 'infantry').length;
const airRate = airMatches / N, navalRate = navalMatches / N;
const swarmShare = decided ? swarmWins / decided : 0;

console.log(`\n--- Sieger-Archetypen ---`);
console.log(`  ${JSON.stringify(winnerArch)}  (entschieden ${decided}/${N})`);
console.log(`  nicht-infantry Archetypen: ${nonInfArch}`);
console.log(`\n--- Spezialzweig-Emergenz ---`);
console.log(`  Airbase gebaut in ${airMatches}/${N} (${(airRate * 100).toFixed(0)}%) · Luft gefeldet in ${airUnitMatches}/${N}`);
console.log(`  Werft gebaut in   ${navalMatches}/${N} (${(navalRate * 100).toFixed(0)}%) · Marine gefeldet in ${navalUnitMatches}/${N}`);
console.log(`  Infanterie-Schwarm-Siege (>85% Inf): ${swarmWins}/${decided} (${(swarmShare * 100).toFixed(0)}%)`);

const checks = [
  ['Nicht-Infanterie-Vielfalt', nonInfArch >= TARGET.minNonInfantryArch, `${nonInfArch} ≥ ${TARGET.minNonInfantryArch}`],
  ['Luft-Emergenz', airRate >= TARGET.airEmergeRate, `${(airRate * 100).toFixed(0)}% ≥ ${TARGET.airEmergeRate * 100}%`],
  ['Marine-Emergenz', navalRate >= TARGET.navalEmergeRate, `${(navalRate * 100).toFixed(0)}% ≥ ${TARGET.navalEmergeRate * 100}%`],
  ['Kein reiner Schwarm', swarmShare <= TARGET.swarmShareMax, `${(swarmShare * 100).toFixed(0)}% ≤ ${TARGET.swarmShareMax * 100}%`],
];
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(26)} ${detail}`);
  if (!ok) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
