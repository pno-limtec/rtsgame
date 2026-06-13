// Computergegner: Wirtschaft hochfahren, Bauen, Produzieren, Angreifen, Verteidigen.
// Dieselbe KI treibt die automatisierten Tests. Zustandsbasiert, datengetrieben.
import { AI_REPLAN_TICKS, PIPE_LINK_RANGE } from '../constants.js';
import { ownerEntities, canAfford, effectiveCost, dist, canPlaceBuilding } from '../world.js';
import { worldToTile, tileToWorld, hasWaterNear, nearestWaterTile, waterBlocksLand, inBounds, tIdx, isPassable, TT } from '../terrain.js';

// Grobe Build-Order (Priorität von oben nach unten).
const BUILD_ORDER = [
  // 1) Wirtschafts- & Militärkern
  { kind: 'power_plant', want: (s) => s.power < 60 },
  { kind: 'ore_depot',   want: (s) => s.oreDepots < 1 },
  { kind: 'shipyard',    reserve: true, want: (s) => s.faction === 'FLG' && s.coastal && s.shipyards < 1 },
  { kind: 'material_depot', want: (s) => s.materialDepots < 1 },
  { kind: 'water_tower', want: (s) => s.waterTowers < 1 },
  { kind: 'refinery',    want: (s) => s.refineries < 1 },
  // Kühlwasser fürs Ölkraftwerk sichern, bevor der Vorrat zur Neige geht.
  { kind: 'water_pump',  want: (s) => s.pumps < 1 && s.powerPlants >= 1 },
  { kind: 'barracks',    want: (s) => s.barracks < 1 },
  { kind: 'airbase',     reserve: true, want: (s) => s.faction !== 'FLG' && s.airbases < 1 && s.army.length >= 2 },
  { kind: 'shipyard',    reserve: true, want: (s) => s.faction !== 'FLG' && s.coastal && s.shipyards < 1 && s.airbases >= 1 },
  { kind: 'power_plant', want: (s) => s.energyRatio < 1 },
  { kind: 'factory',     reserve: true, want: (s) => s.factories < 1 },
  // 2) Hochtechen: Luftbasis & (an der Küste) Werft, sobald Fabrik + kleine Armee stehen.
  //    Bewusst VOR optionalen Verteidigungs-Füllern, damit Luft/See in normalen Matches erscheint.
  { kind: 'airbase',     reserve: true, want: (s) => s.airbases < 1 && s.factories >= 1 && s.army.length >= 2 },
  { kind: 'shipyard',    reserve: true, want: (s) => s.coastal && s.shipyards < 1 && s.factories >= 1 && s.army.length >= 2 },
  { kind: 'mg_turret',   want: (s) => s.turrets < 1 && s.barracks >= 1 },
  { kind: 'trench',      want: (s) => s.trenches < 1 && s.barracks >= 1 && s.credits > 280 },
  { kind: 'wall',        want: (s) => s.walls < 3 && s.barracks >= 1 && s.credits > 360 },
  { kind: 'refinery',    want: (s) => s.refineries < 2 },
  // 3) Verteidigung & Logistik ausbauen
  { kind: 'oil_depot',   want: (s) => s.oilDepots < 1 && s.credits > 400 },
  { kind: 'oil_derrick', want: (s) => s.oilDerricks < 1 && s.oilDepots >= 1 && s.credits > 400 },
  { kind: 'turret',      want: (s) => s.turrets < 2 && s.barracks >= 1 },
  { kind: 'flak_turret', want: (s) => s.flakTurrets < 1 && (s.enemyAir || s.army.length >= 8) },
  { kind: 'sam_site',    want: (s) => s.samSites < 1 && s.enemyAir },
  { kind: 'sonar',       want: (s) => s.coastal && s.sonars < 1 && s.shipyards >= 1 && s.enemySubs },
  { kind: 'depot',       want: (s) => s.depots < 1 && s.army.length >= 8 },
  { kind: 'trench',      want: (s) => s.trenches < 4 && s.barracks >= 1 && s.credits > 500 },
  { kind: 'factory',     want: (s) => s.factories < 2 && s.credits > 1500 },
  { kind: 'power_plant', want: (s) => s.energyRatio < 1 },
  { kind: 'oil_derrick', want: (s) => s.oilDerricks < 2 && s.oilDepots >= 1 && s.credits > 1200 },
  { kind: 'solar_plant', want: (s) => s.solars < 1 && s.credits > 1000 },        // Tagstrom-Puffer
  { kind: 'water_pump',  want: (s) => s.pumps < 2 && s.powerPlants >= 2 },
  { kind: 'sam_site',    want: (s) => s.samSites < 2 && s.enemyAir && s.credits > 1400 },
  { kind: 'wall',        want: (s) => s.walls < 10 && s.army.length >= 6 && s.credits > 600 },
];

const COVERAGE_BUILD_ORDER = [
  'power_plant', 'ore_depot', 'material_depot', 'water_tower', 'oil_depot', 'refinery',
  'barracks', 'factory', 'airbase', 'shipyard', 'depot',
  'water_pump', 'pipe', 'oil_derrick', 'solar_plant',
  'mg_turret', 'turret', 'flak_turret', 'sam_site', 'sonar',
  'road', 'bridge', 'tunnel', 'wall', 'trench', 'dam',
];
const COVERAGE_UNIT_ORDER = [
  'builder', 'engineer', 'rifleman', 'at_soldier', 'aa_soldier',
  'truck', 'harvester', 'tractor', 'scout', 'tank', 'flak_track', 'rocket_launcher', 'artillery',
  'recon_drone', 'gunship', 'bomber', 'transport_air',
  'patrol_boat', 'destroyer', 'submarine', 'underwater_drone', 'amphib_transport', 'sea_builder',
];
const COVERAGE_SKIP_BUILDINGS = new Set(['hq', 'earth_pile', 'ore_pile']);

export function initAi(player) {
  player.ai = { phase: 'expand', attackTimer: 0, airTimer: 0, lastBuild: 0, waveSize: 5, airWave: 2, navyTimer: 0, navyWave: 2 };
}

export function stepAi(world, player, applyCommand) {
  if (player.defeated || player.controller !== 'ai') return;
  if (!player.ai) initAi(player);
  if (world.tick % AI_REPLAN_TICKS !== (player.id % AI_REPLAN_TICKS)) return;

  const s = surveyEconomy(world, player);
  const builtCoverage = manageCoverageBuild(world, player, s, applyCommand);
  const builtInfra = !builtCoverage && managePipelines(world, player, s, applyCommand);
  const builtBridge = !builtCoverage && !builtInfra && manageBridges(world, player, s, applyCommand);
  if (!builtCoverage && !builtInfra && !builtBridge) manageBuild(world, player, s, applyCommand);
  if (!manageCoverageProduction(world, player, s, applyCommand) && !world.aiCoverageTest) manageProduction(world, player, s, applyCommand);
  manageArmy(world, player, s, applyCommand);
  manageHarvesters(world, player, applyCommand);
}

function manageCoverageBuild(world, player, s, applyCommand) {
  if (!world.aiCoverageTest || !s.hq || constructionBusy(s)) return false;
  const existing = new Set(s.buildings.map(b => b.kind));
  for (const kind of coverageBuildingTargets(world)) {
    if (existing.has(kind)) continue;
    const def = world.data.buildings[kind];
    if (!def || !canAfford(player, effectiveCost(world, player.id, def))) continue;
    const spot = pickCoverageBuildSpot(world, player, s, kind, def);
    if (!spot) continue;
    applyCommand(world, { type: 'build', building: kind, tx: spot[0], ty: spot[1] }, player.id);
    return true;
  }
  return false;
}

function manageCoverageProduction(world, player, s, applyCommand) {
  if (!world.aiCoverageTest) return false;
  const have = new Set(s.units.map(u => u.kind));
  for (const b of s.buildings) for (const q of b.queue || []) have.add(q.kind);
  for (const kind of coverageUnitTargets(world)) {
    if (have.has(kind)) continue;
    const def = world.data.units[kind];
    if (!def || !canAfford(player, effectiveCost(world, player.id, def))) continue;
    const prod = s.buildings.find(b => b.buildProgress >= 1 && b.queue.length < 1 && canProduceKind(b.def, kind, def));
    if (!prod) continue;
    applyCommand(world, { type: 'produce', building: prod.id, kind }, player.id);
    return true;
  }
  return false;
}

function coverageBuildingTargets(world) {
  const out = COVERAGE_BUILD_ORDER.filter(k => world.data.buildings[k] && !COVERAGE_SKIP_BUILDINGS.has(k));
  for (const k of Object.keys(world.data.buildings)) {
    const def = world.data.buildings[k];
    if (!COVERAGE_SKIP_BUILDINGS.has(k) && def.role !== 'terrain' && !out.includes(k)) out.push(k);
  }
  return out;
}

function coverageUnitTargets(world) {
  const out = COVERAGE_UNIT_ORDER.filter(k => world.data.units[k]);
  for (const k of Object.keys(world.data.units)) if (!out.includes(k)) out.push(k);
  return out;
}

function canProduceKind(buildingDef, unitKind, unitDef) {
  const list = buildingDef.produces_units || [];
  if (list.includes(unitKind)) return true;
  return !!buildingDef.produces_category && unitDef.category === buildingDef.produces_category;
}

function pickCoverageBuildSpot(world, player, s, kind, def) {
  const size = def.size || 1;
  if (def.bridges) return pickCoverageWaterSpot(world, player.id, def);
  if (def.tunnels) return pickTunnelSpot(world, player.id, def);
  if (def.requiresWater) return pickCoastalSpot(world, player, s, size, def);
  if (def.requiresOil) return pickOilSpot(world, s, size, def);
  if (def.role === 'fortification') return pickDefensiveSpot(world, player, s, def);
  return pickBuildSpot(world, s.hq, size, def);
}

function surveyEconomy(world, player) {
  const b = ownerEntities(world, player.id, 'building');
  const u = ownerEntities(world, player.id, 'unit');
  const count = (kind) => b.filter(e => e.kind === kind).length;
  const hq = b.find(e => e.kind === 'hq');
  // Küstenlage: findet die KI im aktuellen Bauradius einen Werftplatz? → Marine möglich.
  let coastal = false;
  if (hq) {
    const shipyardDef = world.data.buildings.shipyard;
    coastal = !!findCoastalBuildSpot(world, player.id, hq, shipyardDef.size || 1, shipyardDef);
  }
  // Bedrohungslage: hat ein lebender Gegner Luftstreitkräfte oder U-Boote im Feld?
  let enemyAir = false, enemySubs = false;
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead || e.owner === player.id) continue;
    if (e.domain !== 'air' && !e.submerged) continue;
    const o = world.players.find(p => p.id === e.owner);
    if (!o || o.defeated) continue;
    if (e.domain === 'air') enemyAir = true; else if (e.submerged) enemySubs = true;
    if (enemyAir && enemySubs) break;
  }
  return {
    credits: player.resources.ore,
    faction: player.faction,
    power: player.energy.produced - player.energy.consumed,
    energyRatio: player.energy.ratio,
    refineries: count('refinery'), barracks: count('barracks'),
    factories: count('factory'), airbases: count('airbase'),
    shipyards: count('shipyard'), samSites: count('sam_site'), oilDerricks: count('oil_derrick'),
    turrets: count('turret') + count('mg_turret') + count('flak_turret'), flakTurrets: count('flak_turret'),
    depots: count('depot'), sonars: count('sonar'),
    oreDepots: count('ore_depot'), materialDepots: count('material_depot'), waterTowers: count('water_tower'), oilDepots: count('oil_depot'),
    pumps: count('water_pump'), powerPlants: count('power_plant'), solars: count('solar_plant'),
    walls: count('wall'), trenches: count('trench'), bridges: count('bridge'), pipes: count('pipe'),
    coastal, enemyAir, enemySubs,
    harvesters: u.filter(e => e.abilities.includes('harvest')).length,
    army: u.filter(e => e.weapon),
    units: u, buildings: b, hq,
  };
}

function manageBuild(world, player, s, applyCommand) {
  if (!s.hq) return false;
  // Bauthrottling: höchstens 2 Baustellen gleichzeitig und nie dasselbe Gebäude doppelt im Bau.
  // Verhindert Überbau (z. B. 7 Kraftwerke auf einmal, weil im Bau befindliche Gebäude noch
  // keine Energie liefern) und sichert geordnetes Hochtechen bis zu Luftbasis/Werft.
  const underConstruction = s.buildings.filter(b => b.buildProgress < 1);
  if (underConstruction.length >= 2) return true;
  const buildingNow = new Set(underConstruction.map(b => b.kind));
  for (const step of BUILD_ORDER) {
    if (buildingNow.has(step.kind)) continue;
    const def = world.data.buildings[step.kind];
    if (step.want(s)) {
      if (!canAfford(player, effectiveCost(world, player.id, def))) {
        if (step.reserve) return true;
        continue;
      }
      let spot;
      if (def.role === 'fortification') spot = pickDefensiveSpot(world, player, s, def);
      else if (def.requiresWater) spot = pickCoastalSpot(world, player, s, def.size || 1, def);
      else if (def.requiresOil) spot = pickOilSpot(world, s, def.size || 1, def);
      // Pumpwerke möglichst ans Gewässer stellen (volle Förderrate), sonst Grundwasser in der Basis.
      else if (def.pump && s.coastal) spot = pickCoastalSpot(world, player, s, def.size || 1, def) || pickBuildSpot(world, s.hq, def.size || 1, def);
      else spot = pickBuildSpot(world, s.hq, def.size || 1, def);
      if (spot) {
        applyCommand(world, { type: 'build', building: step.kind, tx: spot[0], ty: spot[1] }, player.id);
        return true; // ein Gebäude pro Planungsrunde
      }
    }
  }
  return false;
}

function managePipelines(world, player, s, applyCommand) {
  if (!s.hq || constructionBusy(s) || buildingInProgress(s, 'pipe')) return false;
  const def = world.data.buildings.pipe;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  const producers = s.buildings.filter(b => b.buildProgress >= 1 && producerResource(b));
  for (const prod of producers) {
    if (prod._pipelineConnected === true) continue;
    const resource = producerResource(prod);
    const sinks = s.buildings.filter(b => b.buildProgress >= 1 && depotResources(b).includes(resource));
    if (!sinks.length) continue;
    if (pipelineConnected(world, player.id, prod, sinks)) continue;
    const spot = pickPipelineSpot(world, player, prod, sinks, def);
    if (spot) {
      applyCommand(world, { type: 'build', building: 'pipe', tx: spot[0], ty: spot[1] }, player.id);
      return true;
    }
  }
  return false;
}

function manageBridges(world, player, s, applyCommand) {
  if (!s.hq || constructionBusy(s) || buildingInProgress(s, 'bridge')) return false;
  if (s.bridges >= 18) return false;
  const landArmy = s.army.filter(u => u.domain === 'land');
  if (landArmy.length < 4 && s.factories < 1) return false;
  const def = world.data.buildings.bridge;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  const spot = pickBridgeSpot(world, player, s, def);
  if (!spot) return false;
  applyCommand(world, { type: 'build', building: 'bridge', tx: spot[0], ty: spot[1] }, player.id);
  return true;
}

function constructionBusy(s) {
  return s.buildings.filter(b => b.buildProgress < 1).length >= 2;
}

function buildingInProgress(s, kind) {
  return s.buildings.some(b => b.kind === kind && b.buildProgress < 1);
}

function producerResource(e) {
  if (e?.def?.pump) return 'water';
  return e?.def?.pipelineResource || null;
}

function depotResources(e) {
  return e?.def?.resourceDepot ? [e.def.resourceDepot] : [];
}

function pipeDist(a, b) {
  return Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
}

function pipelineConnected(world, owner, producer, sinks) {
  const pipes = [...world.entities.values()].filter(e => e.owner === owner && e.kind === 'pipe' && !e.dead && e.buildProgress >= 1);
  const frontier = pipes.filter(p => pipeDist(producer, p) <= PIPE_LINK_RANGE + 1);
  const seen = new Set(frontier.map(p => p.id));
  while (frontier.length) {
    const cur = frontier.pop();
    if (sinks.some(s => pipeDist(cur, s) <= PIPE_LINK_RANGE + 1)) return true;
    for (const nxt of pipes) {
      if (seen.has(nxt.id) || pipeDist(cur, nxt) > PIPE_LINK_RANGE) continue;
      seen.add(nxt.id);
      frontier.push(nxt);
    }
  }
  return false;
}

function pickPipelineSpot(world, player, producer, sinks, def) {
  const anchors = connectedPipelineAnchors(world, player.id, sinks);
  anchors.sort((a, b) => pipeDist(a, producer) - pipeDist(b, producer));
  for (const anchor of anchors) {
    const anchorIsPipe = anchor.kind === 'pipe';
    const link = anchorIsPipe ? PIPE_LINK_RANGE : PIPE_LINK_RANGE + 1;
    if (anchorIsPipe && pipeDist(anchor, producer) <= PIPE_LINK_RANGE + 1) return null;
    if (!anchorIsPipe && pipeDist(anchor, producer) <= PIPE_LINK_RANGE + 1) {
      const mx = Math.round((anchor.tx + producer.tx) / 2);
      const my = Math.round((anchor.ty + producer.ty) / 2);
      const nearSpot = bestInfrastructureSpot(world, player.id, mx, my, 3, def, (x, y) => {
        const cand = { tx: x, ty: y };
        return pipeDist(anchor, cand) <= PIPE_LINK_RANGE + 1 && pipeDist(cand, producer) <= PIPE_LINK_RANGE + 1;
      }, producer);
      if (nearSpot) return nearSpot;
      continue;
    }
    const dx = producer.tx - anchor.tx, dy = producer.ty - anchor.ty;
    const tx = anchor.tx + Math.max(-link, Math.min(link, dx));
    const ty = anchor.ty + Math.max(-link, Math.min(link, dy));
    const spot = bestInfrastructureSpot(world, player.id, tx, ty, 1, def, (x, y) => {
      const cand = { tx: x, ty: y };
      return pipeDist(anchor, cand) <= link && pipeDist(cand, producer) < pipeDist(anchor, producer);
    }, producer);
    if (spot) return spot;
  }
  return null;
}

function connectedPipelineAnchors(world, owner, sinks) {
  const pipes = [...world.entities.values()].filter(e => e.owner === owner && e.kind === 'pipe' && !e.dead && e.buildProgress >= 1);
  const anchors = [...sinks];
  const frontier = pipes.filter(p => sinks.some(s => pipeDist(p, s) <= PIPE_LINK_RANGE + 1));
  const seen = new Set(frontier.map(p => p.id));
  while (frontier.length) {
    const cur = frontier.pop();
    anchors.push(cur);
    for (const nxt of pipes) {
      if (seen.has(nxt.id) || pipeDist(cur, nxt) > PIPE_LINK_RANGE) continue;
      seen.add(nxt.id);
      frontier.push(nxt);
    }
  }
  return anchors;
}

function pickBridgeSpot(world, player, s, def) {
  const enemy = pickEnemyTarget(world, player);
  if (!enemy) return null;
  const from = { tx: Math.round(s.hq.tx + s.hq.size / 2), ty: Math.round(s.hq.ty + s.hq.size / 2) };
  const [ex, ey] = worldToTile(enemy.x, enemy.y);
  for (const [tx, ty] of lineTiles(from.tx, from.ty, ex, ey)) {
    if (!isBridgeCandidateCell(world, tx, ty)) continue;
    const spot = bestInfrastructureSpot(world, player.id, tx, ty, 2, def, (x, y) => isBridgeCandidateCell(world, x, y) && hasBridgeShore(world, x, y), from);
    if (spot) return spot;
  }
  return fallbackBridgeSpot(world, player.id, from, { tx: ex, ty: ey }, def);
}

function isBridgeCandidateCell(world, tx, ty) {
  const t = world.terrain;
  if (!inBounds(t, tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  return waterBlocksLand(t, i) && !(t.bridge && t.bridge[i] > 0);
}

function hasBridgeShore(world, tx, ty) {
  const t = world.terrain;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = tx + dx, ny = ty + dy;
    if (!inBounds(t, nx, ny)) continue;
    const i = tIdx(t, nx, ny);
    if (t.bridge && t.bridge[i] > 0) return true;
    if (!waterBlocksLand(t, i) && isPassable(t, 'land', nx, ny)) return true;
  }
  return false;
}

function fallbackBridgeSpot(world, owner, from, to, def) {
  const t = world.terrain;
  let best = null, bestScore = Infinity;
  const dir = Math.atan2(to.ty - from.ty, to.tx - from.tx);
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead) continue;
    const radius = (e.def.buildRadius || 0) + e.size;
    if (radius <= 0) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    const minX = Math.max(0, Math.floor(ecx - radius - 1));
    const maxX = Math.min(t.w - 1, Math.ceil(ecx + radius));
    const minY = Math.max(0, Math.floor(ecy - radius - 1));
    const maxY = Math.min(t.h - 1, Math.ceil(ecy + radius));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (Math.hypot(x + 0.5 - ecx, y + 0.5 - ecy) > radius) continue;
      if (!isBridgeCandidateCell(world, x, y) || !hasBridgeShore(world, x, y)) continue;
      if (!placeable(world, x, y, 1, def)) continue;
      const a = Math.atan2(y - from.ty, x - from.tx);
      const angleCost = Math.abs(Math.atan2(Math.sin(a - dir), Math.cos(a - dir))) * 8;
      const distCost = Math.hypot(x - from.tx, y - from.ty);
      const score = distCost + angleCost;
      if (score < bestScore) { bestScore = score; best = [x, y]; }
    }
  }
  return best;
}

function bestInfrastructureSpot(world, owner, cx, cy, radius, def, predicate, target = null) {
  let best = null, bestScore = Infinity;
  for (let r = 0; r <= radius; r++) for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
    const tx = cx + x, ty = cy + y;
    if (!predicate(tx, ty)) continue;
    if (!placeable(world, tx, ty, def.size || 1, def)) continue;
    if (!inAiBuildRadius(world, owner, tx, ty, def.size || 1)) continue;
    const score = (target ? Math.hypot(tx - target.tx, ty - target.ty) : 0) + r * 0.2;
    if (score < bestScore) { bestScore = score; best = [tx, ty]; }
  }
  return best;
}

function lineTiles(ax, ay, bx, by) {
  const out = [];
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  let last = '';
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    const key = x + ',' + y;
    if (key !== last) { out.push([x, y]); last = key; }
  }
  return out;
}

function manageProduction(world, player, s, applyCommand) {
  // Spar-Reserve: genug Credits zurückhalten, um das nächste Schlüsselgebäude (Luftbasis/Werft)
  // tatsächlich zu erreichen — sonst verbraucht die laufende Einheitenproduktion jeden Überschuss
  // und die KI techt nie auf Luft/See hoch. Sobald das Gebäude (an)gebaut ist, entfällt die Reserve.
  let reserve = 0;
  if (s.airbases < 1 && s.faction !== 'FLG' && s.army.length >= 2) reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.airbase).ore || 0);
  if (s.coastal && s.shipyards < 1 && (s.faction === 'FLG' || s.airbases >= 1)) reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.shipyard).ore || 0);
  if (s.factories < 1 && (s.airbases >= 1 || s.shipyards >= 1)) reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.factory).ore || 0);
  const afford = (kind, keepReserve = true) => {
    const cost = effectiveCost(world, player.id, world.data.units[kind]);
    if (!canAfford(player, cost)) return false;
    return !keepReserve || (player.resources.ore - (cost.ore || 0)) >= reserve;
  };

  // Bautrupp sicherstellen: ohne Bagger wird KEIN Gebäude mehr fertig → höchste Priorität.
  const constructors = s.units.filter(u => u.kind === 'builder').length;
  if (constructors < 1) {
    const prod = s.buildings.find(b => b.kind === 'factory' && b.buildProgress >= 1)
      || s.buildings.find(b => b.kind === 'hq' && b.buildProgress >= 1);
    if (prod && prod.queue.length === 0 && canAfford(player, effectiveCost(world, player.id, world.data.units.builder)))
      applyCommand(world, { type: 'produce', building: prod.id, kind: 'builder' }, player.id);
    return; // Baunotstand: alles andere wartet
  }

  // Erz-LKW sicherstellen — bei kritischem Mangel hat Wiederaufbau Vorrang vor Armee (ohne Reserve).
  const wantHarv = Math.min(4, 2 + s.refineries);
  if (s.harvesters < wantHarv && s.refineries >= 1) {
    const fac = s.buildings.find(b => b.kind === 'factory' && b.buildProgress >= 1);
    if (fac && fac.queue.length === 0 && canAfford(player, effectiveCost(world, player.id, world.data.units.harvester)))
      applyCommand(world, { type: 'produce', building: fac.id, kind: 'harvester' }, player.id);
    if (s.harvesters < 2 && s.airbases < 1 && s.shipyards < 1) return; // Wirtschaftsnotstand: bis Spezialproduktion steht, Credits sparen
  }
  const trucks = s.units.filter(u => u.kind === 'truck').length;
  if (trucks < 2 && s.factories >= 1) {
    const fac = s.buildings.find(b => b.kind === 'factory' && b.buildProgress >= 1);
    if (fac && fac.queue.length === 0 && canAfford(player, effectiveCost(world, player.id, world.data.units.truck)))
      applyCommand(world, { type: 'produce', building: fac.id, kind: 'truck' }, player.id);
  }
  // Kampfeinheiten produzieren, wenn Wirtschaft steht
  const barracks = s.buildings.filter(b => b.kind === 'barracks' && b.buildProgress >= 1);
  const factories = s.buildings.filter(b => b.kind === 'factory' && b.buildProgress >= 1);
  const airbases = s.buildings.filter(b => b.kind === 'airbase' && b.buildProgress >= 1);
  const shipyards = s.buildings.filter(b => b.kind === 'shipyard' && b.buildProgress >= 1);

  // Flottengrößen deckeln, damit die teuren Domänen Luft/See nicht das ganze Budget binden
  // und gegenseitig aushungern — und Luft/See VOR Land produzieren (höhere Priorität aufs Budget).
  const airUnits = s.units.filter(u => u.domain === 'air').length;
  const navalUnits = s.units.filter(u => u.domain === 'water' || u.domain === 'amphibious').length;
  const AIR_TARGET = player.faction === 'HLX' ? 6 : 4;
  const NAVY_TARGET = player.faction === 'FLG' ? 8 : 5;

  // Luft-Doktrin ist fraktionsabhängig: HLX (Luftfraktion) setzt auf Bomber als Panzerbrecher
  // (vs.vehicle 1.3), die übrigen mischen mehr Kanonen-Helis gegen Infanterie/Luft.
  const bomberShare = player.faction === 'HLX' ? 0.65 : 0.4;
  for (const air of airbases) {
    if (air.queue.length >= 1 || airUnits >= AIR_TARGET) continue;
    const kind = airUnits === 0 ? 'recon_drone' : (world.rng() < bomberShare ? 'bomber' : 'gunship');
    if (afford(kind, false)) applyCommand(world, { type: 'produce', building: air.id, kind }, player.id);
  }
  // Marine: Werften bauen Kampfschiffe (Patrouille/Zerstörer/U-Boot).
  for (const sy of shipyards) {
    if (sy.queue.length >= 1 || navalUnits >= NAVY_TARGET) continue;
    const r = world.rng();
    const kind = navalUnits === 0 ? 'patrol_boat' : (r < 0.38 ? 'patrol_boat' : r < 0.68 ? 'destroyer' : r < 0.84 ? 'submarine' : 'underwater_drone');
    if (afford(kind, false)) applyCommand(world, { type: 'produce', building: sy.id, kind }, player.id);
  }
  for (const fac of factories) {
    if (fac.queue.length >= 2) continue;
    // Zweiter Bautrupp zuerst: parallelisiert Baustellen → die Lager-Ökonomie rampt doppelt so schnell.
    if (constructors < 2 && fac.queue.length === 0 && afford('builder')) {
      applyCommand(world, { type: 'produce', building: fac.id, kind: 'builder' }, player.id);
      continue;
    }
    const r = world.rng();
    const kind = r < 0.45 ? 'tank' : r < 0.62 ? 'flak_track' : r < 0.78 ? 'rocket_launcher' : r < 0.9 ? 'scout' : 'artillery';
    if (afford(kind)) applyCommand(world, { type: 'produce', building: fac.id, kind }, player.id);
  }
  // HLX-Schwarmdoktrin: mehr Panzerabwehr-Infanterie (at_soldier, vs.vehicle 1.3) gegen Armee mit viel Panzer.
  const riflemanShare = player.faction === 'HLX' ? 0.5 : 0.7;
  for (const bar of barracks) {
    if (bar.queue.length >= 2) continue;
    const r = world.rng();
    const kind = s.enemyAir && r > 0.72 ? 'aa_soldier' : r < riflemanShare ? 'rifleman' : 'at_soldier';
    if (afford(kind)) applyCommand(world, { type: 'produce', building: bar.id, kind }, player.id);
  }
}

function manageArmy(world, player, s, applyCommand) {
  const all = s.army.filter(u => !u.abilities.includes('harvest'));
  // Marine wird getrennt geführt (eigene Wegfindung/Ziele); rearmende Flieger nicht losschicken.
  const naval = all.filter(u => u.domain === 'water' || u.domain === 'amphibious');
  const air = s.units.filter(u => u.domain === 'air' && u.order.type !== 'rearm');
  const strike = all.filter(u => u.domain === 'land');
  player.ai.attackTimer++;
  const idle = strike.filter(u => u.order.type === 'idle' || u.order.type === 'guard');

  // Land-/Luft-Angriffswelle starten, wenn genug Truppen gesammelt sind.
  // Reguläre Welle ODER periodisches Neusammeln: gestrandete attackmove-Einheiten (Ziel durch
  // Pfadprobleme verloren) bekommen spätestens nach ~2 min wieder einen Marschbefehl.
  const regroup = player.ai.attackTimer > 60 && strike.length >= 4;
  if ((strike.length >= player.ai.waveSize || regroup) && player.ai.attackTimer > 4) {
    const enemy = pickEnemyTarget(world, player);
    if (enemy) {
      applyCommand(world, { type: 'move', units: strike.map(u => u.id), x: enemy.x, y: enemy.y, attackMove: true }, player.id);
      player.ai.attackTimer = 0;
      player.ai.waveSize = Math.min(40, player.ai.waveSize + 2); // Wellen wachsen
    }
  } else if (s.hq && idle.length) {
    // Leerlauf-Truppen zur Verteidigung sammeln — bevorzugt in Deckung (Schützengraben).
    const trench = s.buildings.find(b => b.kind === 'trench' && b.buildProgress >= 1);
    for (const u of idle) {
      // Infanterie zieht in den nächsten Graben (Deckungsbonus), andere bewachen das HQ.
      const anchor = (trench && u.category === 'infantry') ? trench : s.hq;
      if (dist(u, anchor) > (anchor === trench ? 3 : 16))
        applyCommand(world, { type: 'move', units: [u.id], x: anchor.x + (anchor === trench ? 0 : 4), y: anchor.y + (anchor === trench ? 0 : 4) }, player.id);
      else u.order = { type: 'guard' };
    }
  }

  manageAirWing(world, player, air, applyCommand);
  manageNavy(world, player, naval, applyCommand);
}

// Luft-Doktrin: nicht auf Landwellen warten; kleine Rotten fliegen eigenständig.
function manageAirWing(world, player, air, applyCommand) {
  const a = player.ai;
  a.airTimer = (a.airTimer || 0) + 1;
  const ready = air.filter(u => u.order.type === 'idle' || u.order.type === 'guard' || u.order.type === 'attackmove');
  if (ready.length >= (a.airWave || 2) || (ready.length > 0 && a.airTimer > 70)) {
    const tgt = pickEnemyTarget(world, player);
    if (tgt) {
      applyCommand(world, { type: 'move', units: ready.map(u => u.id), x: tgt.x, y: tgt.y, attackMove: true }, player.id);
      a.airTimer = 0;
      a.airWave = Math.min(8, (a.airWave || 2) + 1);
    }
  }
}

// Marine-Doktrin: Flotte sammeln und gegen das nächste Küstenziel des Gegners vorstoßen.
function manageNavy(world, player, naval, applyCommand) {
  const a = player.ai;
  a.navyTimer = (a.navyTimer || 0) + 1;
  if (naval.length >= (a.navyWave || 3) && a.navyTimer > 4) {
    const tgt = pickNavalTarget(world, player);
    if (tgt) {
      applyCommand(world, { type: 'move', units: naval.map(u => u.id), x: tgt.x, y: tgt.y, attackMove: true }, player.id);
      a.navyTimer = 0;
      a.navyWave = Math.min(16, (a.navyWave || 2) + 1);
    }
  }
}

// Nächstes am Wasser erreichbares Gegnerziel; Bewegungspunkt ist die nächste Wasserzelle.
function pickNavalTarget(world, player) {
  const { terrain } = world;
  const own = ownerEntities(world, player.id, 'building');
  const from = own.find(b => b.kind === 'shipyard') || own.find(b => b.kind === 'hq');
  if (!from) return null;
  let best = null, bestD = Infinity;
  for (const e of world.entities.values()) {
    if (e.owner === player.id || e.dead) continue;
    const o = world.players.find(p => p.id === e.owner);
    if (!o || o.defeated) continue;
    const [ex, ey] = worldToTile(e.x, e.y);
    if (!hasWaterNear(terrain, ex, ey, 5)) continue; // nur Küstenziele sind für die Marine erreichbar
    const d = (e.x - from.x) ** 2 + (e.y - from.y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) best = pickEnemyTarget(world, player);
  if (!best) return null;
  const [bx, by] = worldToTile(best.x, best.y);
  const wt = nearestWaterTile(terrain, bx, by, 18);
  if (!wt) return null;
  const [wx, wy] = tileToWorld(wt[0], wt[1]);
  return { x: wx, y: wy };
}

function manageHarvesters(world, player, applyCommand) {
  // Erz-LKWs regeln sich selbst (Economy-System); hier nur ggf. anstoßen.
}

function pickEnemyTarget(world, player) {
  let best = null, bestD = Infinity;
  const hq = ownerEntities(world, player.id, 'building').find(b => b.kind === 'hq');
  const from = hq || ownerEntities(world, player.id, 'unit')[0];
  if (!from) return null;
  for (const e of world.entities.values()) {
    if (e.owner === player.id || e.dead) continue;
    const owner = world.players.find(p => p.id === e.owner);
    if (!owner || owner.defeated) continue;
    // Bevorzugt Produktionsgebäude/HQ
    const prio = e.etype === 'building' ? (e.kind === 'hq' ? 0.5 : 0.8) : 1.2;
    const d = ((e.x - from.x) ** 2 + (e.y - from.y) ** 2) * prio;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Bauplatz im Bauradius des HQ in Spirale suchen.
function pickBuildSpot(world, hq, size, def = null) {
  const hqDef = world.data.buildings.hq;
  const radius = hqDef.buildRadius || 16;
  const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
  for (let tries = 0; tries < 60; tries++) {
    const ang = world.rng() * Math.PI * 2;
    const r = 4 + world.rng() * (radius / 2);
    const tx = Math.round(cx + Math.cos(ang) * r);
    const ty = Math.round(cy + Math.sin(ang) * r);
    if (placeable(world, tx, ty, size, def)) return [tx, ty];
  }
  return null;
}

// Befestigungen in einem Bogen zwischen HQ und nächstem Feind platzieren (Frontverteidigung).
function pickDefensiveSpot(world, player, s, def) {
  const hq = s.hq;
  if (!hq) return null;
  const size = def.size || 1;
  const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
  const enemy = pickEnemyTarget(world, player);
  const base = enemy ? Math.atan2(enemy.y - hq.y, enemy.x - hq.x) : world.rng() * Math.PI * 2;
  for (let tries = 0; tries < 24; tries++) {
    const a = base + (world.rng() - 0.5) * 1.3;     // Streuung entlang der Front, Lücken zum Durchlassen
    const r = 6 + world.rng() * 5;
    const tx = Math.round(cx + Math.cos(a) * r);
    const ty = Math.round(cy + Math.sin(a) * r);
    if (placeable(world, tx, ty, size, def)) return [tx, ty];
  }
  return null;
}

// Bauplatz am Wasser für Werften/Pumpen: im aktuellen Bauradius, platzierbar UND an segelbares Wasser grenzend.
function pickCoastalSpot(world, player, s, size, def = null) {
  return findCoastalBuildSpot(world, player.id, s.hq, size, def);
}

function findCoastalBuildSpot(world, owner, hq, size, def = null) {
  if (!hq) return null;
  const { terrain } = world;
  let best = null, bestScore = Infinity;
  for (const e of world.entities.values()) {
    if (e.owner !== owner || e.etype !== 'building' || e.dead) continue;
    const radius = (e.def.buildRadius || 0) + e.size;
    if (radius <= 0) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    const minX = Math.max(0, Math.floor(ecx - radius - size));
    const maxX = Math.min(terrain.w - size, Math.ceil(ecx + radius));
    const minY = Math.max(0, Math.floor(ecy - radius - size));
    const maxY = Math.min(terrain.h - size, Math.ceil(ecy + radius));
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      const cx = tx + size / 2, cy = ty + size / 2;
      if (Math.hypot(cx - ecx, cy - ecy) > radius) continue;
      if (!placeable(world, tx, ty, size, def)) continue;
      if (!hasWaterNear(terrain, tx, ty, size + 2)) continue;
      const baseD = Math.hypot(cx - (hq.tx + hq.size / 2), cy - (hq.ty + hq.size / 2));
      const providerD = Math.hypot(cx - ecx, cy - ecy);
      const score = baseD * 1.2 + providerD * 0.25;
      if (score < bestScore) { bestScore = score; best = [tx, ty]; }
    }
  }
  return best;
}

function pickOilSpot(world, s, size, def = null) {
  const hq = s.hq, oil = world.terrain.oil;
  if (!hq || !oil) return null;
  const radius = world.data.buildings.hq.buildRadius || 16;
  const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
  let best = null, bestD = Infinity;
  for (const idx of world.terrain.oilList || []) {
    if (oil[idx] <= 0) continue;
    const tx = idx % world.terrain.w, ty = (idx / world.terrain.w) | 0;
    if (Math.hypot(tx + size / 2 - cx, ty + size / 2 - cy) > radius) continue;
    if (!placeable(world, tx, ty, size, def)) continue;
    const d = (tx - hq.tx) ** 2 + (ty - hq.ty) ** 2;
    if (d < bestD) { bestD = d; best = [tx, ty]; }
  }
  return best;
}

function pickCoverageWaterSpot(world, owner, def) {
  return pickCoverageInfrastructureSpot(world, owner, def, (tx, ty) => {
    const t = world.terrain;
    if (!inBounds(t, tx, ty)) return false;
    return waterBlocksLand(t, tIdx(t, tx, ty));
  });
}

function pickTunnelSpot(world, owner, def) {
  return pickCoverageInfrastructureSpot(world, owner, def, (tx, ty) => {
    const t = world.terrain;
    if (!inBounds(t, tx, ty)) return false;
    return t.type[tIdx(t, tx, ty)] === TT.CLIFF;
  });
}

function pickCoverageInfrastructureSpot(world, owner, def, predicate) {
  const t = world.terrain;
  const size = def.size || 1;
  let best = null, bestScore = Infinity;
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead) continue;
    const radius = (e.def.buildRadius || 0) + e.size;
    if (radius <= 0) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    const minX = Math.max(0, Math.floor(ecx - radius - size));
    const maxX = Math.min(t.w - size, Math.ceil(ecx + radius));
    const minY = Math.max(0, Math.floor(ecy - radius - size));
    const maxY = Math.min(t.h - size, Math.ceil(ecy + radius));
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      const cx = tx + size / 2, cy = ty + size / 2;
      if (Math.hypot(cx - ecx, cy - ecy) > radius) continue;
      if (!predicate(tx, ty)) continue;
      if (!placeable(world, tx, ty, size, def)) continue;
      const score = Math.hypot(cx - ecx, cy - ecy);
      if (score < bestScore) { bestScore = score; best = [tx, ty]; }
    }
  }
  return best;
}

function placeable(world, tx, ty, size, def = null) {
  if (!canPlaceBuilding(world, tx, ty, size, def || undefined)) return false;
  const keepGap = !def || !(def.role === 'fortification' || def.pipe || def.bridges || def.tunnels || def.roadBuilt);
  for (const e of world.entities.values()) {
    if (e.etype !== 'building') continue;
    const pad = keepGap ? 1 : 0;
    if (tx < e.tx + e.size + pad && tx + size + pad > e.tx && ty < e.ty + e.size + pad && ty + size + pad > e.ty) return false;
  }
  return true;
}

function inAiBuildRadius(world, owner, tx, ty, size) {
  const cx = tx + size / 2, cy = ty + size / 2;
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner || e.dead) continue;
    const r = (e.def.buildRadius || 0) + e.size;
    if (r <= 0) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    if (Math.hypot(cx - ecx, cy - ecy) <= r) return true;
  }
  return false;
}
