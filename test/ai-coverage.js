// Deterministischer KI-vs-KI-Abdeckungslauf:
// Alle definierten Gebaeude und Einheiten muessen mindestens einmal im echten Simulationspfad erscheinen.
import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { ownerEntities } from '../shared/world.js';
import { initEnv } from '../shared/systems/environment.js';
import { SEA_LEVEL, WET_DEPTH } from '../shared/constants.js';
import { TT, inBounds, tIdx } from '../shared/terrain.js';

const args = process.argv.slice(2).filter(a => a !== '--');
const MAX_TICKS = parseInt(args[0] || '24000', 10);
const SEED = parseInt(args[1] || '424242', 10);
const LOG_EVERY = parseInt(args[2] || '2000', 10);

const data = loadData();
const factions = ['HLX', 'KBN', 'FLG'];
const players = factions.map((faction, id) => ({
  id,
  name: `Coverage-KI-${id + 1}`,
  faction,
  controller: 'ai',
}));

const world = createWorld({ data, seed: SEED, players });
world.aiCoverageTest = true;
world.controls = { timeMode: 'day' };
initEnv(world);
world.env.weather = 'clear';
world.env.weatherLeft = 1e9;
world.env._nextQuake = 1e9;
world.env._lightningCd = 1e9;

prepareCoverageTerrain(world);

const targetUnits = Object.keys(data.units);
const targetBuildings = Object.keys(data.buildings);
const seenUnits = new Set();
const seenBuildings = new Set();
const producedUnits = new Set();
const completedBuildings = new Set();

console.log('\n=== Iron Frontier -- KI-Abdeckungstest ===');
console.log(`Seed ${SEED} · ${players.length} KI-Spieler · max. ${MAX_TICKS} Ticks`);
console.log(`Ziele: ${targetBuildings.length} Gebaeudetypen, ${targetUnits.length} Einheitentypen\n`);

collectCoverage();
let doneTick = null;
for (let i = 0; i < MAX_TICKS; i++) {
  topUpResources(world);
  step(world);
  collectCoverage();

  if (isComplete()) {
    doneTick = world.tick;
    break;
  }
  if (LOG_EVERY > 0 && world.tick % LOG_EVERY === 0) {
    console.log(`  t=${(world.tick / 10).toFixed(0)}s  Gebaeude ${seenBuildings.size}/${targetBuildings.length} · Einheiten ${seenUnits.size}/${targetUnits.length}`);
  }
}

const missingBuildings = targetBuildings.filter(k => !seenBuildings.has(k));
const missingUnits = targetUnits.filter(k => !seenUnits.has(k));

console.log('\n--- Abdeckung ---');
console.log(`  Gebaeude gesehen:  ${seenBuildings.size}/${targetBuildings.length}`);
console.log(`  Einheiten gesehen: ${seenUnits.size}/${targetUnits.length}`);
console.log(`  Fertigbau-Events:  ${completedBuildings.size}`);
console.log(`  Produktions-Events:${producedUnits.size}`);

for (const p of world.players) {
  const b = ownerEntities(world, p.id, 'building').length;
  const u = ownerEntities(world, p.id, 'unit').length;
  console.log(`  ${p.name} (${p.faction}): ${p.defeated ? 'besiegt' : 'aktiv'} · Gebaeude ${b} · Einheiten ${u}`);
}

if (missingBuildings.length || missingUnits.length) {
  if (missingBuildings.length) console.log(`\n  Fehlende Gebaeude: ${missingBuildings.join(', ')}`);
  if (missingUnits.length) console.log(`  Fehlende Einheiten: ${missingUnits.join(', ')}`);
  console.log('');
  process.exit(1);
}

console.log(`\n  Vollstaendig nach Tick ${doneTick} (${(doneTick / 10).toFixed(0)}s Simulationszeit).\n`);

function isComplete() {
  return targetBuildings.every(k => seenBuildings.has(k)) && targetUnits.every(k => seenUnits.has(k));
}

function collectCoverage() {
  for (const e of world.entities.values()) {
    if (e.etype === 'unit') seenUnits.add(e.kind);
    else if (e.etype === 'building' && e.buildProgress >= 1) seenBuildings.add(e.kind);
  }
  for (const ev of world.events || []) {
    if (ev.type === 'produced' && ev.kind) producedUnits.add(ev.kind);
    if (ev.type === 'build' && ev.kind) completedBuildings.add(ev.kind);
  }
}

function topUpResources(w) {
  for (const p of w.players) {
    if (p.defeated) continue;
    p.resources.ore = Math.max(p.resources.ore || 0, 80000);
    p.resources.materials = Math.max(p.resources.materials || 0, 20000);
    p.resources.fuel = Math.max(p.resources.fuel || 0, 20000);
    p.resources.ammo = Math.max(p.resources.ammo || 0, 20000);
    p.resources.water = Math.max(p.resources.water || 0, 20000);
    p.resources.oil = Math.max(p.resources.oil || 0, 20000);
  }
  // Der Coverage-Lauf erzwingt alle Produktions- und Versorgungsgebaeude in einer Basis.
  // Strom soll hier nicht der limitierende Faktor sein; getestet wird, ob jede Einheit erreichbar ist.
  for (const e of w.entities.values()) {
    if (e.etype === 'building' && e.kind === 'power_plant' && e.buildProgress >= 1) {
      e.power = Math.max(e.power || 0, 5000);
    }
  }
}

function prepareCoverageTerrain(w) {
  const reserved = new Set();
  const hqs = [...w.entities.values()].filter(e => e.kind === 'hq').sort((a, b) => a.owner - b.owner);
  for (const hq of hqs) {
    const water = findEmptyArea(w, hq, 8, reserved);
    paintWater(w.terrain, water[0], water[1], 8);
    reserveArea(reserved, water[0], water[1], 8);

    const oil = findEmptyArea(w, hq, 4, reserved);
    paintLand(w.terrain, oil[0], oil[1], 4, SEA_LEVEL + 0.34);
    paintOil(w.terrain, oil[0], oil[1], 4);
    reserveArea(reserved, oil[0], oil[1], 4);

    const cliff = findEmptyArea(w, hq, 3, reserved);
    paintCliff(w.terrain, cliff[0], cliff[1], 3);
    reserveArea(reserved, cliff[0], cliff[1], 3);
  }
  rebuildResourceLists(w.terrain);
}

function findEmptyArea(w, hq, size, reserved) {
  const t = w.terrain;
  const cx = Math.round(hq.tx + hq.size / 2);
  const cy = Math.round(hq.ty + hq.size / 2);
  const radius = Math.max(8, (hq.def.buildRadius || 18) + hq.size - 1);
  for (let r = 5; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = cx + dx - Math.floor(size / 2);
      const ty = cy + dy - Math.floor(size / 2);
      if (areaFree(w, tx, ty, size, reserved)) return [tx, ty];
    }
  }
  throw new Error(`Kein freier Testbereich nahe HQ ${hq.id}`);
}

function areaFree(w, tx, ty, size, reserved) {
  const t = w.terrain;
  for (let y = -1; y <= size; y++) for (let x = -1; x <= size; x++) {
    const nx = tx + x, ny = ty + y;
    if (!inBounds(t, nx, ny)) return false;
    if (reserved.has(`${nx},${ny}`)) return false;
  }
  for (const e of w.entities.values()) {
    if (e.etype !== 'building') continue;
    if (tx < e.tx + e.size + 1 && tx + size + 1 > e.tx && ty < e.ty + e.size + 1 && ty + size + 1 > e.ty) return false;
  }
  return true;
}

function reserveArea(reserved, tx, ty, size) {
  for (let y = -1; y <= size; y++) for (let x = -1; x <= size; x++) reserved.add(`${tx + x},${ty + y}`);
}

function paintWater(t, tx, ty, size) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = tIdx(t, tx + x, ty + y);
    clearCell(t, i);
    t.type[i] = TT.WATER;
    t.height[i] = SEA_LEVEL - 0.08;
    if (t.height0) t.height0[i] = t.height[i];
    t.water[i] = Math.max(t.water[i], WET_DEPTH * 8);
    t.baseWater[i] = Math.max(t.baseWater[i], WET_DEPTH * 8);
    if (t.waterActive) t.waterActive.add(i);
  }
}

function paintLand(t, tx, ty, size, height) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = tIdx(t, tx + x, ty + y);
    clearCell(t, i);
    t.type[i] = TT.LAND;
    t.height[i] = height;
    if (t.height0) t.height0[i] = height;
  }
}

function paintCliff(t, tx, ty, size) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = tIdx(t, tx + x, ty + y);
    clearCell(t, i);
    t.type[i] = TT.CLIFF;
    t.height[i] = 1.02;
    if (t.height0) t.height0[i] = t.height[i];
  }
}

function paintOil(t, tx, ty, size) {
  if (!t.oil) return;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    t.oil[tIdx(t, tx + x, ty + y)] = 3;
  }
}

function clearCell(t, i) {
  t.water[i] = 0;
  t.baseWater[i] = 0;
  if (t.block) t.block[i] = 0;
  if (t.cover) t.cover[i] = 0;
  if (t.coverBuilt) t.coverBuilt[i] = 0;
  if (t.ore) t.ore[i] = 0;
  if (t.oil) t.oil[i] = 0;
  if (t.bridge) t.bridge[i] = 0;
  if (t.tunnel) t.tunnel[i] = 0;
  if (t.roadBuilt) t.roadBuilt[i] = 0;
  if (t.lakeMask) t.lakeMask[i] = 0;
  if (t.startSafe) t.startSafe[i] = 0;
}

function rebuildResourceLists(t) {
  t.oreList = [];
  for (let i = 0; i < t.ore.length; i++) if (t.ore[i] > 0) t.oreList.push(i);
  if (t.oil) {
    t.oilList = [];
    for (let i = 0; i < t.oil.length; i++) if (t.oil[i] > 0) t.oilList.push(i);
  }
}
