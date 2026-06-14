// Balancing- & Datenkonsistenz-Check + Mehrfach-Seed-Statistik.
// Aufruf:  node test/balance-check.js [matches]
import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { ownerEntities } from '../shared/world.js';

const data = loadData();
let errors = 0, warns = 0;
const err = (m) => { errors++; console.log('  ✗', m); };
const warn = (m) => { warns++; console.log('  !', m); };
const costValue = (cost = {}) => (cost.ore || 0) + (cost.materials || 0) * 0.9 + (cost.fuel || 0) * 4
  + (cost.oil || 0) * 2 + (cost.water || 0) * 1.2 + (cost.ammo || 0) * 1.5;
const avg = (xs) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;

console.log('\n=== Datenkonsistenz ===');
// 1) Einheiten: Waffen & Kosten gültig
for (const [k, u] of Object.entries(data.units)) {
  if (u.weapon && !data.weapons[u.weapon]) err(`Einheit ${k}: unbekannte Waffe ${u.weapon}`);
  if (!u.cost || typeof u.cost.ore !== 'number') err(`Einheit ${k}: fehlende Erz-Kosten`);
  if (typeof u.buildTime !== 'number') err(`Einheit ${k}: fehlende buildTime`);
  if (!u.domain) err(`Einheit ${k}: fehlende domain`);
  if (u.weapon) {
    const w = data.weapons[u.weapon];
    if (!w.vs) err(`Waffe ${u.weapon}: fehlende vs-Tabelle`);
  }
}
// 2) Gebäude
for (const [k, b] of Object.entries(data.buildings)) {
  if (b.weapon && !data.weapons[b.weapon]) err(`Gebäude ${k}: unbekannte Waffe ${b.weapon}`);
  if (b.produces_category) {
    const has = Object.values(data.units).some(u => u.category === b.produces_category);
    if (!has) warn(`Gebäude ${k}: produces_category ${b.produces_category} hat keine Einheiten`);
  }
}
// 3) Waffen: vs-Klassen vollständig
const CLASSES = ['infantry', 'vehicle', 'building', 'air', 'naval'];
for (const [k, w] of Object.entries(data.weapons)) {
  for (const c of CLASSES) if (w.vs[c] === undefined) warn(`Waffe ${k}: vs.${c} fehlt`);
  if (w.range <= 0) err(`Waffe ${k}: range <= 0`);
}
console.log(`  ${errors} Fehler, ${warns} Warnungen`);

console.log('\n=== Kosteneffizienz (Heuristik: HP+DPS pro 100 Ressourcenwert) ===');
for (const [k, u] of Object.entries(data.units)) {
  if (!u.weapon) continue;
  const w = data.weapons[u.weapon];
  const dps = w.damage / w.cooldown;
  const cost = costValue(u.cost);
  const eff = ((u.hp + dps * 8) / cost * 100).toFixed(1);
  console.log(`  ${u.label.padEnd(18)} HP ${String(u.hp).padStart(4)} · DPS ${dps.toFixed(0).padStart(3)} · Wert ${String(Math.round(cost)).padStart(4)} → Effizienz ${eff}`);
}

console.log('\n=== Domänen-Budget ===');
const armedVehicles = Object.values(data.units).filter(u => u.category === 'vehicle' && u.weapon).map(u => costValue(u.cost));
const armedAir = Object.values(data.units).filter(u => u.domain === 'air' && u.weapon).map(u => costValue(u.cost));
const allAir = Object.values(data.units).filter(u => u.domain === 'air').map(u => costValue(u.cost));
const naval = Object.values(data.units).filter(u => u.domain === 'water' || u.domain === 'amphibious').map(u => costValue(u.cost));
const vehicleAvg = avg(armedVehicles);
const armedAirAvg = avg(armedAir);
const allAirAvg = avg(allAir);
console.log(`  Fahrzeuge bewaffnet Ø ${Math.round(vehicleAvg)} · Luft bewaffnet Ø ${Math.round(armedAirAvg)} · Luft gesamt Ø ${Math.round(allAirAvg)} · Marine Ø ${Math.round(avg(naval))}`);
if (armedAirAvg < vehicleAvg * 2.0) err(`Bewaffnete Luft ist nicht teuer genug (${Math.round(armedAirAvg)} < 2× Fahrzeug-Ø ${Math.round(vehicleAvg)})`);
if (allAirAvg < vehicleAvg * 1.7) err(`Luft gesamt ist nicht teuer genug (${Math.round(allAirAvg)} < 1.7× Fahrzeug-Ø ${Math.round(vehicleAvg)})`);
if (avg(naval) > vehicleAvg * 1.25) warn('Marine ist im Schnitt sehr teuer gegenüber Fahrzeugen — KI könnte Schiffe meiden.');

console.log('\n=== Mehrfach-Seed-Statistik ===');
const N = parseInt(process.argv[2] || '0', 10);
const MAX_TICKS = parseInt(process.argv[3] || '5000', 10);
if (N <= 0) {
  console.log('  Übersprungen (für Matchstatistik: pnpm run balance -- <matches> <maxTicks>)');
  console.log('');
  process.exit(errors ? 1 : 0);
}
const factions = ['HLX', 'KBN', 'FLG'];
const wins = { HLX: 0, KBN: 0, FLG: 0, draw: 0 };
let totalLen = 0, decided = 0;
for (let s = 0; s < N; s++) {
  const players = [0, 1].map(i => ({ id: i, faction: factions[(s + i) % 3], controller: 'ai' }));
  const world = createWorld({ data, seed: 1000 + s * 97, players });
  let winner = null;
  for (let t = 0; t < MAX_TICKS; t++) { // Lager-Ökonomie + große Karte: längere Läufe per Argument
    step(world);
    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) { winner = alive[0]; totalLen += t; decided++; break; }
  }
  if (winner) wins[winner.faction]++; else wins.draw++;
}
console.log(`  ${N} Matches · max ${MAX_TICKS} Ticks · entschieden ${decided}/${N} · Ø Dauer ${decided ? (totalLen / decided / 10).toFixed(0) : '-'}s`);
console.log(`  Siege: HLX ${wins.HLX} · KBN ${wins.KBN} · FLG ${wins.FLG} · unentschieden ${wins.draw}`);
const wr = Object.entries(wins).filter(([k]) => k !== 'draw').map(([k, v]) => `${k} ${(v / decided * 100 || 0).toFixed(0)}%`).join(' · ');
console.log(`  Win-Rate (von entschiedenen): ${wr}`);
if (decided / N < 0.7) warn('Viele unentschiedene Matches — Aggressivität/Eco der KI prüfen.');

console.log('');
process.exit(errors ? 1 : 0);
