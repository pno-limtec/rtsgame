// Headless KI-vs-KI-Match. Misst Performance, Speicher, Einheitenzahlen, Sieger.
// Aufruf:  node test/sim-test.js [ticks] [players] [seed]
import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { ownerEntities } from '../shared/world.js';

const TICKS = parseInt(process.argv[2] || '3000', 10);  // 3000 Ticks = 300s Spielzeit
const NPLAYERS = parseInt(process.argv[3] || '2', 10);
const SEED = parseInt(process.argv[4] || '12345', 10);

const data = loadData();
const factions = ['HLX', 'KBN', 'FLG'];
const players = [];
for (let i = 0; i < NPLAYERS; i++)
  players.push({ id: i, name: `KI-${i + 1}`, faction: factions[i % factions.length], controller: 'ai' });

const world = createWorld({ data, seed: SEED, players });

console.log(`\n=== Iron Frontier — Headless KI-Test ===`);
console.log(`Karte ${world.map.w}x${world.map.h} · ${NPLAYERS} KI-Spieler · Seed ${SEED} · ${TICKS} Ticks\n`);

let maxTick = 0, sumTick = 0, slowTicks = 0;
let peakProjectiles = 0, peakEntities = 0;
const t0 = process.hrtime.bigint();

let winner = null;
for (let i = 0; i < TICKS; i++) {
  const a = process.hrtime.bigint();
  step(world);
  const ms = Number(process.hrtime.bigint() - a) / 1e6;
  sumTick += ms; if (ms > maxTick) maxTick = ms; if (ms > 16.6) slowTicks++;
  peakProjectiles = Math.max(peakProjectiles, world.projectiles.length);
  peakEntities = Math.max(peakEntities, world.entities.size);

  const alive = world.players.filter(p => !p.defeated);
  if (alive.length <= 1) { winner = alive[0] || null; console.log(`Match entschieden bei Tick ${i} (${(i * 0.1).toFixed(0)}s).`); break; }

  if (i % 600 === 0 && i > 0) snapshotLine(world, i);
}
const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

console.log('\n--- Ergebnis ---');
for (const p of world.players) {
  const b = ownerEntities(world, p.id, 'building').length;
  const u = ownerEntities(world, p.id, 'unit').length;
  console.log(`  ${p.name} (${p.faction}): ${p.defeated ? 'BESIEGT' : 'aktiv'} · Gebäude ${b} · Einheiten ${u} · Credits ${Math.round(p.resources.ore)}`);
}
if (winner) console.log(`  → Sieger: ${winner.name} (${winner.faction})`);
else console.log(`  → kein Sieger innerhalb des Zeitlimits (Patt/laufend)`);

const ticksRun = Math.min(TICKS, world.tick);
console.log('\n--- Performance ---');
console.log(`  Ticks gerechnet:     ${ticksRun}`);
console.log(`  Ø Tick-Zeit:         ${(sumTick / ticksRun).toFixed(3)} ms`);
console.log(`  Max Tick-Zeit:       ${maxTick.toFixed(3)} ms`);
console.log(`  Ticks > 16.6ms:      ${slowTicks} (${(slowTicks / ticksRun * 100).toFixed(1)}%)`);
console.log(`  Echtzeit-Faktor:     ${((ticksRun * 100) / totalMs).toFixed(1)}x (>1 = schneller als Echtzeit)`);
console.log(`  Peak Entities:       ${peakEntities}`);
console.log(`  Peak Projektile:     ${peakProjectiles}`);
const mem = process.memoryUsage();
console.log(`  Heap benutzt:        ${(mem.heapUsed / 1048576).toFixed(1)} MB`);
console.log('');

function snapshotLine(world, i) {
  const parts = world.players.map(p => `${p.faction}:${ownerEntities(world, p.id, 'unit').length}E/${Math.round(p.resources.ore)}c`);
  console.log(`  t=${(i * 0.1).toFixed(0)}s  ${parts.join('  ')}`);
}
