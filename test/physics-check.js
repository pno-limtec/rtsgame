// Physik-Harness (Ziel G der nightly „rtsgame-selfplay-polish"-Routine).
//
// match-sim/coverage messen Balance/Abdeckung. Dieser Harness misst die bis dahin UNGEMESSENE
// Physik-LESBARKEIT headless & deterministisch — konkret die Separation stehender Einheiten:
//
//   G1) Separations-JITTER: Einheiten, die sich aus einem dichten Pulk auseinanderdrücken und
//       danach IDLE stehen, müssen zur RUHE kommen. Dauerhaftes Mikro-Zittern (Positions-
//       Oszillation) sieht „schwebend"/unruhig aus → wir messen die mittlere Restbewegung pro
//       Tick im eingeschwungenen Zustand. Niedrig = ruhig/lesbar.
//   G2) AUSEINANDERRÜCKEN: der Pulk darf nicht dauerhaft ineinanderstecken — am Ende soll der
//       kleinste Paarabstand nahe dem Soll-Abstand liegen (kein „Ineinanderrutschen").
//
// Mess-Prinzip: feste Seeds, kein Math.random, stabiles Wetter (clear/day) → reproduzierbar, mit
// Zielwert-Tabelle + Exit-Code (0 = alle Ziele erfüllt). Gleiche Bauart wie coverage.js.
//
// Aufruf:  node test/physics-check.js [seeds] [baseSeed]
//   z. B.  node test/physics-check.js 6 9000

import { loadData } from '../shared/data-node.js';
import { createWorld, step, applyCommand } from '../shared/sim.js';
import { spawnUnit } from '../shared/world.js';
import { worldToTile, tileToWorld, tIdx, inBounds, TT } from '../shared/terrain.js';
import { desiredSpacing } from '../shared/systems/movement.js';

const data = loadData();

const N = parseInt(process.argv[2] || '6', 10);
const BASE = parseInt(process.argv[3] || '9000', 10);

const SETTLE = 300;   // Ticks, in denen sich der Pulk auseinanderschiebt und zur Ruhe kommt (= 30 s)
const WINDOW = 150;   // Mess-Fenster danach: Restbewegung pro Tick (= 15 s)
// Pulk: dicht überlappend gespawnt, gemischt Infanterie + Fahrzeuge (verschiedene Soll-Abstände →
// realistisches Separations-Gedränge).
const CLUSTER = [
  'rifleman', 'rifleman', 'rifleman', 'rifleman', 'rifleman', 'rifleman',
  'tank', 'tank', 'tank', 'tank', 'at_soldier', 'at_soldier',
];

// stabiles Wetter/Mittag jeden Tick festhalten (sonst flutet Regen die Mess-Fläche / Tag-Nacht
// verändert nichts an der Physik, aber wir halten alles konstant für Reproduzierbarkeit).
function freezeEnv(world) {
  world.controls = { ...(world.controls || {}), timeMode: 'day' };
  if (!world.env) return;
  world.env.weather = 'clear';
  world.env.weatherLeft = 1e9;
  world.env.forecast = [];
}

// Eine möglichst FLACHE, trockene Land-Fläche nahe der Kartenmitte finden (eine 5×5-Kachel-Insel
// gleicher Höhe), damit Hangneigung/Wasser die Jitter-Messung nicht verfälschen.
function findFlatPatch(world) {
  const t = world.terrain;
  const cx = (t.w / 2) | 0, cy = (t.h / 2) | 0;
  let best = null, bestVar = Infinity;
  for (let r = 0; r < Math.min(t.w, t.h) / 2 - 4; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // nur Ring r (von innen nach außen)
      const tx = cx + dx, ty = cy + dy;
      let ok = true, hMin = Infinity, hMax = -Infinity;
      for (let yy = -2; yy <= 2 && ok; yy++) for (let xx = -2; xx <= 2; xx++) {
        const ax = tx + xx, ay = ty + yy;
        if (!inBounds(t, ax, ay)) { ok = false; break; }
        const i = tIdx(t, ax, ay);
        if (t.type[i] !== TT.LAND || t.water[i] > 0.02) { ok = false; break; }
        const h = t.height[i];
        if (h < hMin) hMin = h; if (h > hMax) hMax = h;
      }
      if (!ok) continue;
      const v = hMax - hMin;
      if (v < bestVar) { bestVar = v; best = [tx, ty]; }
    }
    if (best && bestVar < 0.01) break; // flach genug → nicht weiter suchen
  }
  return best;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

const rows = [];
let worstMeanJitter = 0, worstMaxJitter = 0, worstOverlap = 0;
let validSeeds = 0;

for (let s = 0; s < N; s++) {
  const players = [{ id: 0, faction: 'HLX', controller: 'human' }]; // human → kein stepAi, Einheiten bleiben idle
  const world = createWorld({ data, seed: BASE + s * 131, players });
  freezeEnv(world);
  const patch = findFlatPatch(world);
  if (!patch) { rows.push(`  #${s}  (keine flache Fläche gefunden — übersprungen)`); continue; }
  const [ptx, pty] = patch;
  const [wx, wy] = tileToWorld(ptx, pty);

  // Szenario-Variante über die Seed-Parität: gerade Seeds = IDLE-Pulk (dicht überlappend gespawnt,
  // statisch auseinanderdrücken), ungerade Seeds = BEWEGTER Pulk (locker im Umkreis gespawnt, alle
  // auf EINEN gemeinsamen Zielpunkt → Gedränge am Ziel, der klassische „Verhaken/Zittern"-Fall).
  // Beide müssen am Ende zur Ruhe kommen.
  const moving = (s % 2) === 1;
  const spawnSpread = moving ? 4.0 : 0.18; // bewegt: locker (konvergieren erst); idle: überlappend
  const units = [];
  for (let k = 0; k < CLUSTER.length; k++) {
    const ang = k * 2.39996;              // goldener Winkel → gleichmäßige, deterministische Streuung
    const rad = spawnSpread * Math.sqrt(k / CLUSTER.length);
    const u = spawnUnit(world, 0, CLUSTER[k], wx + Math.cos(ang) * rad, wy + Math.sin(ang) * rad);
    units.push(u);
  }

  if (moving) {
    const ids = units.map(u => u.id);
    applyCommand(world, { type: 'move', units: ids, x: wx, y: wy }, 0);
  }

  freezeEnv(world);
  for (let i = 0; i < SETTLE; i++) { step(world); freezeEnv(world); }

  // Mess-Fenster: pro Einheit die gesamte Restbewegung (Summe der Tick-Verschiebungen) aufsummieren.
  const moved = units.map(() => 0);
  let prev = units.map(u => ({ x: u.x, y: u.y }));
  for (let i = 0; i < WINDOW; i++) {
    step(world); freezeEnv(world);
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.dead) continue;
      moved[k] += Math.hypot(u.x - prev[k].x, u.y - prev[k].y);
      prev[k] = { x: u.x, y: u.y };
    }
  }
  const alive = units.filter(u => !u.dead);
  if (!alive.length) { rows.push(`  #${s}  (alle Einheiten tot — übersprungen)`); continue; }

  // Jitter = mittlere Bewegung pro Tick (Weltmeter). 1 Kachel = 2 m.
  const perUnitJitter = moved.map(m => m / WINDOW);
  const meanJitter = perUnitJitter.reduce((a, b) => a + b, 0) / units.length;
  const maxJitter = Math.max(...perUnitJitter);

  // Mindest-Paarabstand am Ende UND Overlap-Quote — beides gegen den PAAR-SPEZIFISCHEN Soll-Abstand
  // aus movement.js (`desiredSpacing`, Single Source of Truth: Infanterie↔Infanterie 0.18 m, mit
  // Fahrzeug 2.1, Wasser 2.4, sonst 1.35). Overlap = wie weit der am stärksten verletzte Paarabstand
  // UNTER seinem eigenen Soll liegt (0 = jedes Paar ≥ Soll, 1 = exakt aufeinander). So wird eng
  // gepackte Infanterie, die ABSICHTLICH dicht steht, nicht fälschlich als „Ineinanderrutschen"
  // gewertet — gemessen wird nur echtes Unterschreiten des jeweiligen Soll-Abstands.
  let minPair = Infinity, overlap = 0;
  for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) {
    const d = dist(alive[a], alive[b]);
    if (d < minPair) minPair = d;
    const want = desiredSpacing(alive[a], alive[b]);
    overlap = Math.max(overlap, Math.max(0, (want - d) / want));
  }

  validSeeds++;
  worstMeanJitter = Math.max(worstMeanJitter, meanJitter);
  worstMaxJitter = Math.max(worstMaxJitter, maxJitter);
  worstOverlap = Math.max(worstOverlap, overlap);
  rows.push(`  #${s} ${moving ? 'bewegt' : 'idle  '}  Jitter ⌀${meanJitter.toFixed(4)} max${maxJitter.toFixed(4)} m/Tick  ·  minAbstand ${minPair.toFixed(2)} m  Überlapp ${(overlap * 100).toFixed(0)}%`);
}

console.log(`\n=== Physik: Separations-Jitter · ${N} Seeds · Settle ${SETTLE}t + Fenster ${WINDOW}t · Seeds ${BASE}+ ===`);
for (const r of rows) console.log(r);

console.log(`\n--- Kennzahlen (Worst-Case über alle Seeds) ---`);
console.log(`  ⌀ Jitter/Tick (worst):   ${worstMeanJitter.toFixed(4)} m`);
console.log(`  max Jitter/Tick (worst): ${worstMaxJitter.toFixed(4)} m`);
console.log(`  Überlapp (worst):        ${(worstOverlap * 100).toFixed(0)}%`);

// Zielwerte: eingeschwungene Idle-Einheiten sollen praktisch stehen. 1 Kachel = 2 m; 0.02 m/Tick
// mittlerer Restweg = 1 % einer Kachel pro Tick = visuell ruhig. Einzelausreißer (max) etwas lockerer.
const TARGET = { meanJitter: 0.02, maxJitter: 0.05, overlap: 0.20 };
const checks = [
  ['⌀ Jitter ruhig', worstMeanJitter <= TARGET.meanJitter, `${worstMeanJitter.toFixed(4)} ≤ ${TARGET.meanJitter} m/Tick`],
  ['max Jitter ruhig', worstMaxJitter <= TARGET.maxJitter, `${worstMaxJitter.toFixed(4)} ≤ ${TARGET.maxJitter} m/Tick`],
  ['Pulk rückt auseinander', worstOverlap <= TARGET.overlap, `Überlapp ${(worstOverlap * 100).toFixed(0)}% ≤ ${(TARGET.overlap * 100)}%`],
];
console.log(`\n--- Zielwerte ---`);
let allOk = validSeeds > 0;
for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(24)} ${detail}`); if (!ok) allOk = false; }
console.log(`\n  ${allOk ? 'ALLE ZIELE ERFÜLLT' : 'ZIELE VERFEHLT'}\n`);
process.exit(allOk ? 0 : 1);
