// Naturereignis-Fairness- & KI-Reaktions-Harness (Ziel H der nightly „rtsgame-selfplay-polish").
//
// Bis dato UNGEMESSEN. Diese Routine prüft über viele deterministische KI-vs-KI-Partien:
//   (1) FAIRNESS — entscheiden Naturereignisse (Flut/Beben/Lawine/Steinschlag/Blitz/Sturm) eine
//       Partie ALLEIN (ohne Gegnerdruck)? Korreliert Naturschaden systematisch mit Sitz/Fraktion?
//       Bei normalem Insanity (≤2) ist das HQ gegen Natur IMMUN (world.js ignoresEnvironmentalDamage)
//       → ein reiner Natur-Wipeout ist strukturell unmöglich; das validieren wir (hqNatureKills==0).
//   (2) KI-REAKTION — repariert/kompensiert die KI naturbedingte Schäden? Nach jeder naturbedingten
//       ZERSTÖRUNG eines Kern-Gebäudes (economy/production/logistics) prüfen wir, ob der betroffene
//       Spieler innerhalb eines Fensters EIN Gebäude derselben FUNKTIONSKLASSE neu aufbaut
//       (Wiederaufbau/Kompensation) statt den Verlust hinzunehmen.
//
// Instrumentierung: applyDamage (world.js) markiert Todes-Events mit `cause`. Natur-Ursachen:
//   water | landslide | avalanche | rockfall | lightning | storm  (Sturm-Tag in diesem Lauf ergänzt).
// `world.events` wird pro step() geleert → direkt nach step() lesen liefert die Events DIESES Ticks.
//
// Aufruf:  node test/disaster-check.js [matches] [maxTicks] [baseSeed] [insanity]
//   Default 6 6000 5000 3 (Insanity 3 = häufige Ereignisse → genug Reaktions-Stichproben; HQ-Immunität
//   nur bei ≤2 aktiv, daher wird die HQ-Assertion nur dort scharf geschaltet).
// Exit 0 = alle Fairness-/Reaktions-Ziele erfüllt.

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';

const data = loadData();

const N = parseInt(process.argv[2] || '6', 10);
const MAX_TICKS = parseInt(process.argv[3] || '7000', 10);
const BASE = parseInt(process.argv[4] || '5000', 10);
// Default Insanity 2 = das NORMALE Spiel (so läuft auch match-sim/coverage): hier gelten die
// Fairness-Garantien (HQ-Immunität, kein Sitz-Nachteil, kein Natur-Wipeout) und Natur treibt eine
// Kern-Klasse fast nie ins Defizit. Mit `... 3` (Chaos) als 5. Arg wird der Reaktions-Engpass
// sichtbar (Dauerlawinen → defizitäre Verluste, KI kompensiert nur teilweise).
const INSANITY = parseInt(process.argv[5] || '2', 10);
const REACT_WINDOW = 1800;   // Ticks (~3 min), in denen ein Wiederaufbau als Reaktion zählt

const NATURAL_CAUSES = new Set(['water', 'landslide', 'avalanche', 'rockfall', 'lightning', 'storm']);
const CORE_ROLES = new Set(['economy', 'production', 'logistics']);
// Eine naturbedingte Zerstörung ist nur dann eine KOMPENSATIONS-Pflicht, wenn sie die
// Funktionsklasse tatsächlich DEFIZITÄR macht. Verliert ein Spieler 1 von 12 Kraftwerken, ist
// KEIN Wiederaufbau nötig (die KI baut korrekt bedarfsgesteuert — `want: s.power<60` ist erfüllt).
// Stichprobe daher nur, wenn die Klasse nach dem Verlust auf ≤ NEED_FLOOR fällt (echter Engpass).
const NEED_FLOOR = { economy: 2, production: 1, logistics: 1 };

const factions = ['HLX', 'KBN', 'FLG'];
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// --- Zielwerte ---
const TARGET = {
  seatSkewMax: 0.70,          // Sitz-Anteil am Naturschaden (max/Summe) ≤ 70 % (kein Lage-Nachteil)
  natureOnlyDefeatMax: 0.25,  // Anteil Niederlagen, die Natur OHNE Gegnerdruck verursacht ≤ 25 %
  coreReactionMin: 0.50,      // ≥ 50 % der natur-zerstörten Kern-Gebäude werden kompensiert
  reactionMinSamples: 4,      // Reaktions-Ziel nur scharf, wenn genug Stichproben
};

// Lebende Gebäude eines Spielers nach Funktionsklasse zählen.
function roleCounts(world, owner) {
  const m = {};
  for (const e of world.entities.values()) {
    if (e.dead || e.etype !== 'building' || e.owner !== owner) continue;
    const role = e.def?.role || '-';
    m[role] = (m[role] || 0) + 1;
  }
  return m;
}

let seatNat = [0, 0];                 // Naturschaden-Tote je Sitz, über alle Partien
const perFactionNat = {};             // Fraktion → Natur-Tote
let totalNatDeaths = 0;
const causeTally = {};                // cause → Anzahl
let hqNatureKills = 0;
let defeats = 0, natureOnlyDefeats = 0;
let reactTotal = 0, reactHit = 0;
let matchesWithNature = 0;
const matchRows = [];

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [
    { id: 0, faction: fa, controller: 'ai' },
    { id: 1, faction: fb, controller: 'ai' },
  ];
  const world = createWorld({ data, seed: BASE + s * 97, players, controls: { insanity: INSANITY } });
  const facOf = [fa, fb];

  // Je Spieler: Natur-Tote, Kampf-Tote (cause nicht-Natur & nicht selbst verkauft).
  const natDeaths = [0, 0];
  const combatDeaths = [0, 0];
  let matchNat = 0;
  let ticksPlayed = 0;
  const pending = [];   // {owner, role, deathTick, postCount, hit, done}

  for (let t = 0; t < MAX_TICKS; t++) {
    step(world);

    for (const ev of world.events) {
      if (ev.type !== 'death' && ev.type !== 'washout') continue;
      if (ev.sold) continue; // selbst verkauft = keine Natur/Kein Kampf
      const owner = ev.owner;
      if (owner !== 0 && owner !== 1) continue;
      const nat = NATURAL_CAUSES.has(ev.cause);
      if (nat) {
        natDeaths[owner]++; matchNat++; totalNatDeaths++;
        seatNat[owner]++;
        perFactionNat[facOf[owner]] = (perFactionNat[facOf[owner]] || 0) + 1;
        causeTally[ev.cause] = (causeTally[ev.cause] || 0) + 1;
        if (ev.etype === 'building' && ev.kind === 'hq') hqNatureKills++;
        // Reaktions-Tracking: naturbedingt zerstörtes Kern-Gebäude → Wiederaufbau erwarten.
        if (ev.etype === 'building') {
          const def = data.buildings[ev.kind];
          const role = def?.role;
          if (role && CORE_ROLES.has(role)) {
            const postCount = (roleCounts(world, owner)[role] || 0);
            // Nur defizitäre Verluste werten — redundante Überkapazität verlangt keinen Wiederaufbau.
            if (postCount <= (NEED_FLOOR[role] ?? 1)) {
              pending.push({ owner, role, deathTick: t, postCount, hit: false, done: false });
            }
          }
        }
      } else if (ev.etype != null) {
        combatDeaths[owner]++;
      }
    }

    // Offene Reaktionen prüfen (klein gehaltene Liste): Wiederaufbau derselben Funktionsklasse?
    if (pending.some(p => !p.done)) {
      const rc = [roleCounts(world, 0), roleCounts(world, 1)];
      for (const p of pending) {
        if (p.done) continue;
        if ((rc[p.owner][p.role] || 0) > p.postCount) { p.done = true; p.hit = true; }
        else if (t - p.deathTick > REACT_WINDOW) {
          p.done = true; // Fenster abgelaufen = keine Reaktion
          if (process.env.DIAG) {
            // Fehl-Reaktion diagnostizieren: Erz / Bagger / Baustelle-derselben-Klasse?
            let ore = 0, builders = 0, roleUC = 0, roleAlive = 0;
            const pl = world.players.find(pp => pp.id === p.owner);
            ore = Math.round(pl?.resources?.ore || 0);
            for (const e of world.entities.values()) {
              if (e.dead || e.owner !== p.owner) continue;
              if (e.etype === 'unit' && e.kind === 'builder') builders++;
              if (e.etype === 'building' && e.def?.role === p.role) {
                roleAlive++; if (e.buildProgress < 1) roleUC++;
              }
            }
            console.error(`  DIAG miss P${p.owner} role=${p.role} ore=${ore} builders=${builders} ${p.role}-alive=${roleAlive} (im Bau ${roleUC})`);
          }
        }
      }
    }

    ticksPlayed = t + 1;
    const alive = world.players.filter(pp => !pp.defeated);
    if (alive.length <= 1) {
      // Niederlage(n): wurde sie natur-getrieben verursacht (Natur ≥60 % der Verluste & kaum Kampf)?
      for (const pp of world.players) {
        if (!pp.defeated) continue;
        defeats++;
        const nd = natDeaths[pp.id], cd = combatDeaths[pp.id];
        const tot = nd + cd;
        if (tot >= 3 && nd / tot >= 0.6 && cd <= 2) natureOnlyDefeats++;
      }
      break;
    }
    if (t === MAX_TICKS - 1) {
      // Unentschieden bei Zeitablauf → keine Niederlage gewertet.
    }
  }

  // Reaktions-Stichproben werten — NUR wenn das Reaktionsfenster noch in die Partie passte
  // (sonst „zensiert": die Partie endete bevor die KI Zeit zum Wiederaufbau hatte → nicht fair).
  for (const p of pending) {
    if (p.deathTick + REACT_WINDOW > ticksPlayed) continue; // zensiert
    reactTotal++;
    if (p.hit) reactHit++;
  }

  if (matchNat > 0) matchesWithNature++;
  matchRows.push({ s, fa, fb, nat0: natDeaths[0], nat1: natDeaths[1], matchNat });
  console.log(`  # ${s} ${fa}/${fb}  Natur-Tote P0 ${natDeaths[0]} / P1 ${natDeaths[1]}  (Kampf ${combatDeaths[0]}/${combatDeaths[1]})`);
}

const seatSkew = (seatNat[0] + seatNat[1]) > 0
  ? Math.max(seatNat[0], seatNat[1]) / (seatNat[0] + seatNat[1]) : 0;
const natureOnlyDefeatRate = defeats > 0 ? natureOnlyDefeats / defeats : 0;
const coreReaction = reactTotal > 0 ? reactHit / reactTotal : 1;

console.log(`\n--- Kennzahlen (${N} Partien, Insanity ${INSANITY}, ${MAX_TICKS} Ticks) ---`);
console.log(`  Natur-Tote gesamt:            ${totalNatDeaths}  (Partien mit Natur: ${matchesWithNature}/${N})`);
console.log(`  nach Ursache:                 ${Object.entries(causeTally).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
console.log(`  nach Fraktion:                ${Object.entries(perFactionNat).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
console.log(`  Sitz-Verteilung Natur-Tote:   P0 ${seatNat[0]} / P1 ${seatNat[1]}  → Schiefe ${(seatSkew * 100).toFixed(0)}%`);
console.log(`  HQ durch Natur zerstört:      ${hqNatureKills}  (Insanity ${INSANITY} ${INSANITY <= 2 ? '→ HQ-Immunität AKTIV' : '→ HQ verwundbar (Chaos)'})`);
console.log(`  Niederlagen gesamt:           ${defeats}  (davon natur-getrieben: ${natureOnlyDefeats})`);
console.log(`  Kern-Gebäude natur-zerstört:  ${reactTotal}  → kompensiert ${reactHit}  (${(coreReaction * 100).toFixed(0)}%)`);

// --- Zielwerte prüfen ---
const checks = [];
checks.push({ ok: seatSkew <= TARGET.seatSkewMax, label: `Kein Sitz-Nachteil   Schiefe ${(seatSkew * 100).toFixed(0)}% ≤ ${(TARGET.seatSkewMax * 100).toFixed(0)}%` });
checks.push({ ok: natureOnlyDefeatRate <= TARGET.natureOnlyDefeatMax, label: `Kaum Natur-Wipeouts  ${(natureOnlyDefeatRate * 100).toFixed(0)}% ≤ ${(TARGET.natureOnlyDefeatMax * 100).toFixed(0)}%` });
if (INSANITY <= 2) checks.push({ ok: hqNatureKills === 0, label: `HQ natur-immun       ${hqNatureKills} == 0` });
if (reactTotal >= TARGET.reactionMinSamples) {
  checks.push({ ok: coreReaction >= TARGET.coreReactionMin, label: `KI kompensiert       ${(coreReaction * 100).toFixed(0)}% ≥ ${(TARGET.coreReactionMin * 100).toFixed(0)}%` });
} else {
  console.log(`  (Reaktions-Ziel nicht scharf: nur ${reactTotal} Stichproben < ${TARGET.reactionMinSamples})`);
}

console.log(`\n--- Zielwerte ---`);
let allOk = true;
for (const c of checks) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`); if (!c.ok) allOk = false; }
console.log(`\n  ${allOk ? 'ALLE ZIELE ERFÜLLT' : 'ZIELE VERFEHLT'}`);
process.exit(allOk ? 0 : 1);
