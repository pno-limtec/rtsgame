// KI-Match-Simulator & Diagnose-Harness.
//
// Zweck (Kernauftrag der nightly „rtsgamebauen"-Routine): KI-gegen-KI-Partien massenhaft
// simulieren und MESSEN, ob sie
//   (1) IMMER entschieden werden (immer gewinnt jemand),
//   (2) NICHT stagnieren (keine Partei kommt weiter — eingefrorene Front / endlose Pattsituation),
//   (3) ABWECHSLUNGSREICH sind (verschiedene Sieger, Dauern, Armee-Archetypen).
//
// Anders als balance-check.js (nur entschieden/unentschieden) klassifiziert dieser Harness JEDES
// unentschiedene Match nach URSACHE, damit die Routine gezielt das richtige Problem behebt:
//   - frozen      : kaum Kampf in der Schlussphase (Armeen treffen nie aufeinander) → Wegfindung/
//                   Aggressivität/Routenwahl reparieren.
//   - attrition   : Dauerkampf, aber keiner setzt sich durch (Führung pendelt um 0) → Skalierung/
//                   Tech/Eskalation reparieren, damit ein Vorsprung das Spiel beendet.
//   - would-decide: klarer Trend zum Sieg, nur MAX_TICKS zu kurz → Limit erhöhen, kein Spielproblem.
//
// Aufruf:  node test/match-sim.js [matches] [maxTicks] [baseSeed]
//   z. B.  node test/match-sim.js 18 12000
// Exit-Code 0 = alle Zielwerte erfüllt, 1 = ein Ziel verfehlt (für CI/Routine-Gating).

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';

const data = loadData();

// --- Zielwerte (die Routine arbeitet darauf hin) -------------------------------------------------
const TARGET = {
  decidedRate: 0.90,   // ≥ 90 % der Partien müssen einen Sieger haben
  stagnantRate: 0.05,  // ≤ 5 % echte Stagnation (frozen + attrition); would-decide zählt NICHT
  minWinnerShare: 0.20,// jede Fraktion soll ≥ 20 % der entschiedenen Partien gewinnen (Balance/Vielfalt)
  seatSkewMax: 0.65,   // Sitz 0 darf höchstens 65 % der entschiedenen Partien gewinnen (kein Startvorteil)
  lengthCvMin: 0.20,   // Dauer-Variationskoeffizient ≥ 0.20 → Partien laufen unterschiedlich lang
  minArchetypes: 3,    // ≥ 3 verschiedene Armee-Archetypen über alle Sieger (Abwechslung)
};

// --- Kostenheuristik für „Armeewert" (identisch zu balance-check.js) -----------------------------
const costValue = (cost = {}) => (cost.ore || 0) + (cost.materials || 0) * 0.9 + (cost.fuel || 0) * 4
  + (cost.oil || 0) * 2 + (cost.water || 0) * 1.2 + (cost.ammo || 0) * 1.5;
const unitVal = {}, bldVal = {};
for (const [k, u] of Object.entries(data.units)) unitVal[k] = costValue(u.cost);
for (const [k, b] of Object.entries(data.buildings)) bldVal[k] = costValue(b.cost);

const factions = ['HLX', 'KBN', 'FLG'];
const N = parseInt(process.argv[2] || '18', 10);
const MAX_TICKS = parseInt(process.argv[3] || '12000', 10);
const BASE = parseInt(process.argv[4] || '4000', 10);
const SAMPLE = 100;                  // alle 100 Ticks (= 10 s) Zustand abtasten
const WINDOW_FRAC = 0.35;            // Schlussphase = letzte 35 % der Samples (für Stagnationsanalyse)

const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const std = (xs) => { const m = avg(xs); return Math.sqrt(avg(xs.map(x => (x - m) ** 2))); };

// Momentaufnahme eines Spielerstands.
function snapshot(world, pid) {
  let units = 0, military = 0, value = 0;
  const cats = { infantry: 0, vehicle: 0, air: 0, naval: 0 };
  const ids = new Set();
  for (const e of world.entities.values()) {
    if (e.owner !== pid) continue;
    ids.add(e.id);
    if (e.etype === 'unit') {
      units++;
      value += unitVal[e.kind] || 0;
      if (e.weapon) { military++; cats[e.category] = (cats[e.category] || 0) + 1; }
    } else if (e.etype === 'building') {
      value += bldVal[e.kind] || 0;
    }
  }
  return { units, military, value, cats, ids };
}

// Dominanten Armee-Archetyp eines Spielers aus der Kategorie-Verteilung ableiten.
function archetype(cats) {
  const total = cats.infantry + cats.vehicle + cats.air + cats.naval;
  if (total < 4) return 'tiny';
  const frac = (c) => c / total;
  if (frac(cats.naval) >= 0.30) return 'naval';
  if (frac(cats.air) >= 0.30) return 'air';
  const inf = frac(cats.infantry), veh = frac(cats.vehicle);
  if (inf >= 0.6) return 'infantry';
  if (veh >= 0.6) return 'armor';
  return 'combined';
}

const wins = { HLX: 0, KBN: 0, FLG: 0 };
const seatWins = [0, 0];
const draws = { frozen: 0, attrition: 0, wouldDecide: 0 };
const lengths = [];                  // entschiedene Dauern (Sekunden)
const winnerArchetypes = {};         // Archetyp → Anzahl Siege
const rows = [];

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [
    { id: 0, faction: fa, controller: 'ai' },
    { id: 1, faction: fb, controller: 'ai' },
  ];
  const world = createWorld({ data, seed: BASE + s * 97, players });

  const series = [[], []];           // pro Spieler Zeitreihe von snapshots
  let lossPair = [0, 0];             // kumulative Einheiten-/Gebäudeverluste (verschwundene IDs)
  let prevIds = [new Set(), new Set()];
  const lossSeries = [];             // kombinierte Verluste je Sample-Intervall (Kampfintensität)
  let winner = null, decidedTick = 0;

  for (let t = 0; t < MAX_TICKS; t++) {
    step(world);
    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) { winner = alive[0] || null; decidedTick = t; break; }
    if (t % SAMPLE === 0) {
      let intervalLoss = 0;
      for (let p = 0; p < 2; p++) {
        const snap = snapshot(world, p);
        series[p].push(snap);
        let gone = 0; for (const id of prevIds[p]) if (!snap.ids.has(id)) gone++;
        lossPair[p] += gone; intervalLoss += gone;
        prevIds[p] = snap.ids;
      }
      lossSeries.push(intervalLoss);
    }
  }

  if (winner) {
    wins[winner.faction]++;
    seatWins[winner.id]++;
    lengths.push(decidedTick / 10);
    // Archetyp des Siegers im letzten gemessenen Zustand.
    const last = series[winner.id][series[winner.id].length - 1];
    const arch = last ? archetype(last.cats) : 'tiny';
    winnerArchetypes[arch] = (winnerArchetypes[arch] || 0) + 1;
    rows.push(`  #${String(s).padStart(2)} ${fa}/${fb}  → SIEG ${winner.faction} (Sitz ${winner.id}, ${arch})  ${(decidedTick / 10).toFixed(0)}s`);
  } else {
    // Unentschieden klassifizieren.
    const k = Math.max(1, Math.round(series[0].length * WINDOW_FRAC));
    const tailLoss = lossSeries.slice(-k);
    const combatTail = avg(tailLoss);                          // Verlustrate Schlussphase
    const v0 = series[0].map(x => x.value), v1 = series[1].map(x => x.value);
    const leadTail = [];
    for (let i = series[0].length - k; i < series[0].length; i++) {
      if (i < 0) continue; leadTail.push((v0[i] - v1[i]));
    }
    const leadNow = leadTail.length ? leadTail[leadTail.length - 1] : 0;
    const leadStart = leadTail.length ? leadTail[0] : 0;
    const totalNow = (v0[v0.length - 1] || 0) + (v1[v1.length - 1] || 0);
    const leadTrend = Math.abs(leadNow - leadStart);           // wandert die Führung?
    const leadFrac = totalNow > 0 ? Math.abs(leadNow) / totalNow : 0;

    let cls;
    if (leadFrac >= 0.45 && leadTrend > totalNow * 0.08) { cls = 'wouldDecide'; draws.wouldDecide++; }
    else if (combatTail < 1.5) { cls = 'frozen'; draws.frozen++; }
    else { cls = 'attrition'; draws.attrition++; }
    rows.push(`  #${String(s).padStart(2)} ${fa}/${fb}  → UNENTSCHIEDEN [${cls}]  Kampf/Intervall ${combatTail.toFixed(1)} · Führung ${(leadFrac * 100).toFixed(0)}%`);
  }
}

// --- Auswertung ----------------------------------------------------------------------------------
const decided = wins.HLX + wins.KBN + wins.FLG;
const drawTotal = draws.frozen + draws.attrition + draws.wouldDecide;
const stagnant = draws.frozen + draws.attrition;        // echte Stagnation (would-decide ausgenommen)
const decidedRate = decided / N;
const stagnantRate = stagnant / N;
const archetypes = Object.keys(winnerArchetypes).filter(a => a !== 'tiny').length;
const lenAvg = avg(lengths), lenStd = std(lengths), lenCv = lenAvg ? lenStd / lenAvg : 0;
const minShare = decided ? Math.min(...factions.map(f => wins[f] / decided)) : 0;
const seatSkew = decided ? Math.max(seatWins[0], seatWins[1]) / decided : 0;

console.log(`\n=== KI-Match-Simulation: ${N} Partien · max ${MAX_TICKS} Ticks · Seeds ${BASE}+ ===`);
for (const r of rows) console.log(r);

console.log(`\n--- Entscheidung ---`);
console.log(`  entschieden ${decided}/${N} (${(decidedRate * 100).toFixed(0)}%)  ·  Siege HLX ${wins.HLX} · KBN ${wins.KBN} · FLG ${wins.FLG}`);
console.log(`  unentschieden ${drawTotal}: frozen ${draws.frozen} · attrition ${draws.attrition} · wouldDecide ${draws.wouldDecide}`);
console.log(`  Sitz-Siege: Sitz0 ${seatWins[0]} · Sitz1 ${seatWins[1]} (Schiefe ${(seatSkew * 100).toFixed(0)}%)`);

console.log(`\n--- Abwechslung ---`);
console.log(`  Dauer: Ø ${lenAvg.toFixed(0)}s · σ ${lenStd.toFixed(0)}s · CV ${lenCv.toFixed(2)} · min ${lengths.length ? Math.min(...lengths).toFixed(0) : '-'}s · max ${lengths.length ? Math.max(...lengths).toFixed(0) : '-'}s`);
console.log(`  Sieger-Archetypen (${archetypes}): ${JSON.stringify(winnerArchetypes)}`);
console.log(`  Fraktions-Mindestanteil ${(minShare * 100).toFixed(0)}%`);

// --- Zielprüfung (Gating) ------------------------------------------------------------------------
const checks = [
  ['Immer ein Sieger', decidedRate >= TARGET.decidedRate, `${(decidedRate * 100).toFixed(0)}% ≥ ${(TARGET.decidedRate * 100)}%`],
  ['Keine Stagnation', stagnantRate <= TARGET.stagnantRate, `${(stagnantRate * 100).toFixed(0)}% ≤ ${(TARGET.stagnantRate * 100)}%`],
  ['Fraktionsbalance', minShare >= TARGET.minWinnerShare || decided < 6, `min ${(minShare * 100).toFixed(0)}% ≥ ${(TARGET.minWinnerShare * 100)}%`],
  ['Kein Startvorteil', seatSkew <= TARGET.seatSkewMax || decided < 6, `Sitz-Schiefe ${(seatSkew * 100).toFixed(0)}% ≤ ${(TARGET.seatSkewMax * 100)}%`],
  ['Dauer-Vielfalt', lenCv >= TARGET.lengthCvMin || decided < 6, `CV ${lenCv.toFixed(2)} ≥ ${TARGET.lengthCvMin}`],
  ['Strategie-Vielfalt', archetypes >= TARGET.minArchetypes || decided < 6, `${archetypes} ≥ ${TARGET.minArchetypes} Archetypen`],
];
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(20)} ${detail}`);
  if (!ok) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
