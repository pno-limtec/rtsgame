// Balancing- & Datenkonsistenz-Check + Mehrfach-Seed-Statistik.
// Aufruf:  node test/balance-check.js [matches]
import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { ownerEntities } from '../shared/world.js';

const data = loadData();
let errors = 0, warns = 0;
const err = (m) => { errors++; console.log('  ✗', m); };
const warn = (m) => { warns++; console.log('  !', m); };

console.log('\n=== Datenkonsistenz ===');
// 1) Einheiten: Waffen & Kosten gültig
for (const [k, u] of Object.entries(data.units)) {
  if (u.weapon && !data.weapons[u.weapon]) err(`Einheit ${k}: unbekannte Waffe ${u.weapon}`);
  if (!u.cost || typeof u.cost.credits !== 'number') err(`Einheit ${k}: fehlende credits-Kosten`);
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

console.log('\n=== Kosteneffizienz (Heuristik: HP+DPS pro 100 Credits) ===');
for (const [k, u] of Object.entries(data.units)) {
  if (!u.weapon) continue;
  const w = data.weapons[u.weapon];
  const dps = w.damage / w.cooldown;
  const cost = u.cost.credits;
  const eff = ((u.hp + dps * 8) / cost * 100).toFixed(1);
  console.log(`  ${u.label.padEnd(18)} HP ${String(u.hp).padStart(4)} · DPS ${dps.toFixed(0).padStart(3)} · ${cost}c → Effizienz ${eff}`);
}

console.log('\n=== Mehrfach-Seed-Statistik ===');
const N = parseInt(process.argv[2] || '12', 10);
const factions = ['HLX', 'KBN', 'FLG'];
const wins = { HLX: 0, KBN: 0, FLG: 0, draw: 0 };
let totalLen = 0, decided = 0;
for (let s = 0; s < N; s++) {
  const players = [0, 1].map(i => ({ id: i, faction: factions[(s + i) % 3], controller: 'ai' }));
  const world = createWorld({ data, seed: 1000 + s * 97, players });
  let winner = null;
  for (let t = 0; t < 15000; t++) { // Lager-Ökonomie + große Karte: Matches dauern länger
    step(world);
    const alive = world.players.filter(p => !p.defeated);
    if (alive.length <= 1) { winner = alive[0]; totalLen += t; decided++; break; }
  }
  if (winner) wins[winner.faction]++; else wins.draw++;
}
console.log(`  ${N} Matches · entschieden ${decided}/${N} · Ø Dauer ${decided ? (totalLen / decided / 10).toFixed(0) : '-'}s`);
console.log(`  Siege: HLX ${wins.HLX} · KBN ${wins.KBN} · FLG ${wins.FLG} · unentschieden ${wins.draw}`);
const wr = Object.entries(wins).filter(([k]) => k !== 'draw').map(([k, v]) => `${k} ${(v / decided * 100 || 0).toFixed(0)}%`).join(' · ');
console.log(`  Win-Rate (von entschiedenen): ${wr}`);
if (decided / N < 0.7) warn('Viele unentschiedene Matches — Aggressivität/Eco der KI prüfen.');

console.log('');
process.exit(errors ? 1 : 0);
