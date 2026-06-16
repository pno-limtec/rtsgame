// Wirtschafts-/Allokations-Diagnose-Harness (selfplay-polish-Routine, 2026-06-16).
//
// HINTERGRUND: Die Einheiten-Abdeckung (coverage.js Ziel C) hängt seit vielen Läufen fest, weil
// Fahrzeug-/Belagerungs-/Luft-/Marine-Typen real kaum gebaut werden. coverage.js MISST das Ergebnis
// (welche Typen vorkamen), erklärt aber nicht WARUM. Dieser Harness misst die WIRTSCHAFTS-URSACHEN
// dahinter über viele KI-vs-KI-Partien, damit der nächste Lauf den echten Engpass trifft statt blind
// an Produktions-Gates zu drehen (mehrfach als inert/regressiv gemessen).
//
// GEMESSENE BEFUNDE (seed5000, 9000 Ticks, 2026-06-16) — als Referenz für Regress-Erkennung:
//   • Es schürft IMMER nur EIN Bagger Erz (resourceRole==='ore', ~20 Erz/s; economy.js stepBuilderOre
//     heilt genau einen, manageIdleWorkers weist genau einen zu) → Einkommen ~20/s die ganze Partie.
//   • Erz hängt fast die ganze Partie nahe 0; die KI gibt ihr Erz SOFORT für INFRASTRUKTUR aus
//     (gemessen: 50–85 Gebäude/Spieler, davon bis zu 46 Pipeline-Segmente) statt für die Armee.
//   • Verdoppelt man die Förderrate (Experiment 20→40/s), steigt das Erz-Polster (Peak ~1275 statt
//     ~241), die Fahrzeugzahl bleibt aber bei ~3 — der Überschuss fließt in NOCH MEHR Gebäude bzw.
//     liegt brach. → Einkommen ist NICHT der einzige Engpass; ALLOKATION (Infrastruktur-Überbau),
//     1-Fabrik-Durchsatz und Fahrzeug-Verschleiß (Einheiten sterben einzeln marschierend) wirken
//     GESCHICHTET zusammen. Das ist die bekannte „frozen-Kohäsion"-Baustelle (rtsgamebauen-Domäne).
//
// Aufruf:  node test/econ-diag.js [matches] [maxTicks] [baseSeed]
//   z. B.  node test/econ-diag.js 4 9000 5000
//
// Deterministisch (feste Seeds, kein Math.random in der Sim) — gleiche Bauart wie coverage.js/match-sim.js.

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';

const data = loadData();
const N = parseInt(process.argv[2] || '4', 10);
const MAX_TICKS = parseInt(process.argv[3] || '9000', 10);
const BASE = parseInt(process.argv[4] || '5000', 10);
const factions = ['HLX', 'KBN', 'FLG'];

const INFRA = new Set(['pipe', 'road', 'bridge', 'tunnel', 'pontoon', 'wall', 'trench', 'dam', 'levee']);

function snapshotPlayer(world, pid) {
  let inf = 0, veh = 0, infra = 0, bld = 0, oreMiners = 0, builders = 0, factories = 0, airbases = 0, shipyards = 0;
  for (const e of world.entities.values()) {
    if (e.owner !== pid || e.dead) continue;
    if (e.etype === 'unit') {
      if (e.kind === 'builder') { builders++; if (e.resourceRole === 'ore') oreMiners++; }
      else if (e.category === 'infantry' && e.weapon && !(e.abilities || []).includes('harvest')) inf++;
      else if (e.category === 'vehicle' && e.weapon) veh++;
    } else if (e.etype === 'building') {
      bld++;
      if (INFRA.has(e.kind)) infra++;
      if (e.kind === 'factory' && e.buildProgress >= 1) factories++;
      if (e.kind === 'airbase' && e.buildProgress >= 1) airbases++;
      if (e.kind === 'shipyard' && e.buildProgress >= 1) shipyards++;
    }
  }
  const ore = Math.round(world.players.find(p => p.id === pid).resources.ore || 0);
  return { ore, inf, veh, infra, bld, oreMiners, builders, factories, airbases, shipyards };
}

// Akkumulatoren über alle Spieler/Partien
let sumPeakOre = 0, sumPeakVeh = 0, sumPeakInf = 0, sumPeakInfra = 0, sumPeakBld = 0;
let sumMaxOreMiners = 0, sumEndFactories = 0;
let nPlayers = 0;
let starvedPlayers = 0;          // Spieler, deren Erz NIE über 600 (≈ 1 Erz-LKW / 1 Belagerungswaffe) kam
let infraHeavyPlayers = 0;       // Spieler mit mehr Infrastruktur-Segmenten als 5× Fahrzeugen am Ende

console.log(`=== Wirtschafts-Diagnose: ${N} Partien · max ${MAX_TICKS} Ticks · Seeds ${BASE}+ ===`);

for (let s = 0; s < N; s++) {
  const fa = factions[s % 3], fb = factions[(s + 1) % 3];
  const players = [
    { id: 0, faction: fa, controller: 'ai' },
    { id: 1, faction: fb, controller: 'ai' },
  ];
  const world = createWorld({ data, seed: BASE + s * 131, players });
  const peak = world.players.map(() => ({ ore: 0, veh: 0, inf: 0, infra: 0, bld: 0, oreMiners: 0 }));

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    step(world);
    if (tick % 250 === 0) {
      for (let i = 0; i < world.players.length; i++) {
        const sn = snapshotPlayer(world, world.players[i].id);
        const pk = peak[i];
        pk.ore = Math.max(pk.ore, sn.ore);
        pk.veh = Math.max(pk.veh, sn.veh);
        pk.inf = Math.max(pk.inf, sn.inf);
        pk.infra = Math.max(pk.infra, sn.infra);
        pk.bld = Math.max(pk.bld, sn.bld);
        pk.oreMiners = Math.max(pk.oreMiners, sn.oreMiners);
      }
    }
    if (world.players.filter(p => !p.defeated).length <= 1) break;
  }

  const ends = world.players.map(p => snapshotPlayer(world, p.id));
  for (let i = 0; i < world.players.length; i++) {
    const pk = peak[i], en = ends[i];
    nPlayers++;
    sumPeakOre += pk.ore; sumPeakVeh += pk.veh; sumPeakInf += pk.inf;
    sumPeakInfra += pk.infra; sumPeakBld += pk.bld; sumMaxOreMiners += pk.oreMiners;
    sumEndFactories += en.factories;
    if (pk.ore < 600) starvedPlayers++;
    if (en.infra > 5 * en.veh) infraHeavyPlayers++;
    console.log(`  #${s} ${world.players[i].faction}  peakOre ${pk.ore}  peakVeh ${pk.veh}  peakInf ${pk.inf}`
      + `  peakInfra ${pk.infra}  peakBld ${pk.bld}  maxMiner ${pk.oreMiners}`
      + `  END veh${en.veh}/ab${en.airbases}/sy${en.shipyards}`);
  }
}

const avg = (x) => (x / nPlayers).toFixed(1);
console.log('\n--- Mittelwerte je Spieler ---');
console.log(`  Erz-Peak        ${avg(sumPeakOre)}`);
console.log(`  Fahrzeug-Peak   ${avg(sumPeakVeh)}`);
console.log(`  Infanterie-Peak ${avg(sumPeakInf)}`);
console.log(`  Infra-Peak      ${avg(sumPeakInfra)}  (Pipe/Straße/Brücke/Tunnel/Wall/…)`);
console.log(`  Gebäude-Peak    ${avg(sumPeakBld)}`);
console.log(`  Max Erz-Bagger  ${avg(sumMaxOreMiners)}  (Einkommens-Engpass: fast immer 1)`);
console.log(`  Fabriken (Ende) ${avg(sumEndFactories)}  (Fahrzeug-Durchsatz-Engpass)`);
console.log('\n--- Diagnose-Flags ---');
console.log(`  Erz-ausgehungert (Peak<600):     ${starvedPlayers}/${nPlayers}`);
console.log(`  Infrastruktur-lastig (infra>5×veh): ${infraHeavyPlayers}/${nPlayers}`);
console.log('\nHINWEIS: Dieser Harness DIAGNOSTIZIERT nur (kein Gate/Exit-Code). Die Einheiten-Abdeckung');
console.log('hängt an geschichteten Ursachen (Einkommen=1 Bagger, Infra-Überbau, 1-Fabrik-Durchsatz,');
console.log('Fahrzeug-Verschleiß durch frozen-Kohäsion) — siehe Kopfkommentar + Projekt-Memory.');
