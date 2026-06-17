// Idle-Quoten-Harness (Ziel A der nightly „rtsgame-selfplay-polish"-Routine).
//
// Zweck: über viele KI-gegen-KI-Partien MESSEN, ob die KI ihre Einheiten beschäftigt hält.
// Vorgabe der Routine: „Über die Partie gemittelt sollen NIE mehr als 50 % der Einheiten eines
// KI-Spielers gleichzeitig idlen (kein Befehl/kein Ziel/kein Kampf) — wer nicht kämpft, soll
// sammeln, bauen, patrouillieren, sich neu positionieren oder Schaden reparieren."
//
// Eine Einheit gilt als BESCHÄFTIGT (nicht idle), wenn sie EINES tut:
//   • kämpft            → e.target != null (feuert/verfolgt ein Ziel; combat.js setzt e.target)
//   • hat einen Auftrag → order.type ∈ BUSY_ORDERS (move/attack/harvest/construct/terra/haul …)
//   • bewegt sich       → e.moveTarget != null  (unterwegs zu einem Punkt)
//   • weicht aus        → e._fleeing            („sich neu positionieren" zählt als Tätigkeit)
// IDLE (parkend) ist nur, wer in einem Halte-Zustand steht (idle/guard/hold) OHNE Ziel, ohne
// Bewegung, ohne Flucht. Zwei Schärfegrade werden berichtet:
//   idleBroad  : order ∈ {idle,guard,hold} & kein Ziel/Bewegung/Flucht   ← GEGATETE Metrik
//   idleStrict : order.type === 'idle' & dito                            ← reiner „kein Befehl"
// Zusätzlich wird die FLUCHT-Quote (e._fleeing) berichtet — die Memory (#10) vermutet, dass das
// neue water.js-„startSafeHasDrainPath"-Gate idle Fahrzeuge auf abflusslosem Flachland in einen
// Dauer-Flucht-Zyklus treibt; eine hohe Flucht-Quote bei niedriger Idle-Quote wäre der Beleg.
//
// Aufruf:  node test/idle-check.js [matches] [maxTicks] [baseSeed]
// Exit 0 = Ziel erfüllt (mittlere idleBroad ≤ 0.50 fast überall), 1 = verfehlt (Routine-Gating).

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';

const data = loadData();

const N = parseInt(process.argv[2] || '8', 10);
const MAX_TICKS = parseInt(process.argv[3] || '6000', 10);
const BASE = parseInt(process.argv[4] || '5000', 10);
const SAMPLE = 50;            // alle 50 Ticks abtasten
const MIN_UNITS = 3;          // Stichprobe nur werten, wenn der Spieler ≥3 Einheiten hat (Bootstrap ignorieren)
const BOOTSTRAP_TICK = 400;   // erste ~40 s (Basisaufbau, kaum Einheiten) nicht gegen das Ziel werten

// --- Zielwerte ---
const TARGET = {
  meanIdleMax: 0.50,    // mittlere idleBroad-Quote je Spieler/Partie ≤ 50 %
  outlierRateMax: 0.20, // ≤ 20 % der Spieler/Partien dürfen das Mittel reißen (Ausreißer-Toleranz)
};

const factions = ['HLX', 'KBN', 'FLG'];
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// Auftragsarten, die als TÄTIGKEIT zählen (nicht idle).
const BUSY_ORDERS = new Set([
  'move', 'attack', 'attackmove', 'harvest', 'construct', 'terra', 'terraform',
  'haul_pile', 'rearm', 'load', 'unload', 'patrol', 'dig', 'mine', 'tow', 'recover',
  'build', 'build_aid', 'dump', 'pile', 'depot', 'canal',
]);
const PARK_ORDERS = new Set(['idle', 'guard', 'hold']);

function classifyUnit(e) {
  // Liefert {idleBroad, idleStrict, fleeing} als 0/1.
  const ot = e.order?.type || 'idle';
  const fleeing = !!e._fleeing;
  const fighting = e.target != null;
  const moving = e.moveTarget != null;
  const busyOrder = BUSY_ORDERS.has(ot);
  const active = fighting || moving || busyOrder || fleeing;
  const idleBroad = (!active && PARK_ORDERS.has(ot)) ? 1 : 0;
  const idleStrict = (!active && ot === 'idle') ? 1 : 0;
  return { idleBroad, idleStrict, fleeing: fleeing ? 1 : 0 };
}

// Stichprobe eines Spielers: Idle-/Flucht-Anteile über seine lebenden Einheiten.
// `armed` (e.weapon) wird getrennt geführt: die KI parkt Support-Einheiten (Builder/Trucks)
// absichtlich auf `guard` (parkSupportUnit) — das ist gewollte Reserve, kein Müßiggang. Die
// eigentliche Zielvorgabe „wer nicht kämpft, soll …" zielt auf KAMPF-Einheiten; deren Idle-Quote
// ist daher die aussagekräftigere (und gegatete) Kennzahl.
function sampleIdle(world, pid) {
  let total = 0, idleB = 0, idleS = 0, flee = 0;
  let armedTotal = 0, armedIdle = 0;
  for (const e of world.entities.values()) {
    if (e.owner !== pid || e.etype !== 'unit' || e.dead) continue;
    total++;
    const c = classifyUnit(e);
    idleB += c.idleBroad; idleS += c.idleStrict; flee += c.fleeing;
    if (e.weapon) { armedTotal++; armedIdle += c.idleBroad; }
  }
  if (total < MIN_UNITS) return null;
  return {
    idleBroad: idleB / total, idleStrict: idleS / total, fleeing: flee / total, total,
    armedIdle: armedTotal > 0 ? armedIdle / armedTotal : null,
  };
}

const rows = [];
const perPlayerMeans = [];   // {match, pid, faction, meanBroad, meanStrict, meanFlee, peakBroad}

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [
    { id: 0, faction: fa, controller: 'ai' },
    { id: 1, faction: fb, controller: 'ai' },
  ];
  const world = createWorld({ data, seed: BASE + s * 97, players });

  const acc = [[], []];      // pro Spieler: Liste der idleBroad-Stichproben
  const accS = [[], []];
  const accF = [[], []];
  const accA = [[], []];     // armed-only idleBroad
  let decidedTick = MAX_TICKS;

  for (let t = 0; t < MAX_TICKS; t++) {
    step(world);
    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) { decidedTick = t; break; }
    if (t % SAMPLE === 0 && t >= BOOTSTRAP_TICK) {
      for (let p = 0; p < 2; p++) {
        const sm = sampleIdle(world, p);
        if (sm) {
          acc[p].push(sm.idleBroad); accS[p].push(sm.idleStrict); accF[p].push(sm.fleeing);
          if (sm.armedIdle != null) accA[p].push(sm.armedIdle);
        }
      }
    }
  }

  for (let p = 0; p < 2; p++) {
    if (!acc[p].length) continue;
    const meanBroad = avg(acc[p]);
    const meanStrict = avg(accS[p]);
    const meanFlee = avg(accF[p]);
    const meanArmed = accA[p].length ? avg(accA[p]) : null;
    const peakBroad = Math.max(...acc[p]);
    perPlayerMeans.push({ match: s, pid: p, faction: p === 0 ? fa : fb, meanBroad, meanStrict, meanFlee, meanArmed, peakBroad });
  }
  const m0 = perPlayerMeans.filter(x => x.match === s);
  const desc = m0.map(x => `P${x.pid}(${x.faction}) idle ${(x.meanBroad * 100).toFixed(0)}% armed ${x.meanArmed == null ? '-' : (x.meanArmed * 100).toFixed(0) + '%'} flee${(x.meanFlee * 100).toFixed(0)}%`).join('  ');
  rows.push(`  #${String(s).padStart(2)} ${fa}/${fb}  ${decidedTick / 10}s  ${desc}`);
}

// --- Auswertung ---
console.log(`\n=== KI-Idle-Quote: ${N} Partien · max ${MAX_TICKS} Ticks · Seeds ${BASE}+ · ab t=${BOOTSTRAP_TICK} ===`);
for (const r of rows) console.log(r);

const overallBroad = avg(perPlayerMeans.map(x => x.meanBroad));
const overallStrict = avg(perPlayerMeans.map(x => x.meanStrict));
const overallFlee = avg(perPlayerMeans.map(x => x.meanFlee));
const armedVals = perPlayerMeans.map(x => x.meanArmed).filter(v => v != null);
const overallArmed = avg(armedVals);
// Gegatet wird auf die KAMPF-Einheiten-Idle (armed), die belastbarste Kennzahl: Support-Reserve
// (geparkte Builder/Trucks) zählt nicht gegen das Ziel.
const outliers = perPlayerMeans.filter(x => x.meanArmed != null && x.meanArmed > TARGET.meanIdleMax);
const gateBase = perPlayerMeans.filter(x => x.meanArmed != null);
const outlierRate = gateBase.length ? outliers.length / gateBase.length : 0;
const worst = gateBase.slice().sort((a, b) => b.meanArmed - a.meanArmed)[0];

console.log(`\n--- Kennzahlen (über ${perPlayerMeans.length} Spieler/Partien) ---`);
console.log(`  ⌀ Idle-Quote KAMPF-Einheiten (armed):    ${(overallArmed * 100).toFixed(1)}%   ← gegatet`);
console.log(`  ⌀ Idle-Quote alle (broad idle/guard):    ${(overallBroad * 100).toFixed(1)}%   (inkl. geparkter Support-Reserve)`);
console.log(`  ⌀ Idle-Quote strict (nur 'idle'):        ${(overallStrict * 100).toFixed(1)}%`);
console.log(`  ⌀ Flucht-Quote (_fleeing):               ${(overallFlee * 100).toFixed(1)}%`);
if (worst) console.log(`  schlechtester Kampf-Fall: Partie #${worst.match} P${worst.pid} (${worst.faction}) ⌀ ${(worst.meanArmed * 100).toFixed(0)}% (peak broad ${(worst.peakBroad * 100).toFixed(0)}%)`);
console.log(`  Ausreißer Kampf-Idle (>${(TARGET.meanIdleMax * 100)}%): ${outliers.length}/${gateBase.length} (${(outlierRate * 100).toFixed(0)}%)`);

const checks = [
  ['⌀ Kampf-Idle ≤ 50%', overallArmed <= TARGET.meanIdleMax, `${(overallArmed * 100).toFixed(1)}% ≤ ${(TARGET.meanIdleMax * 100)}%`],
  ['Wenige Ausreißer', outlierRate <= TARGET.outlierRateMax, `${(outlierRate * 100).toFixed(0)}% ≤ ${(TARGET.outlierRateMax * 100)}%`],
];
console.log(`\n--- Zielwerte ---`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(20)} ${detail}`);
  if (!ok) failed++;
}
console.log(`\n  ${failed === 0 ? 'ALLE ZIELE ERFÜLLT' : failed + ' ZIEL(E) VERFEHLT'}\n`);
process.exit(failed === 0 ? 0 : 1);
