// Computergegner: Wirtschaft hochfahren, Bauen, Produzieren, Angreifen, Verteidigen.
// Dieselbe KI treibt die automatisierten Tests. Zustandsbasiert, datengetrieben.
import {
  AI_REPLAN_TICKS, PIPE_LINK_RANGE, CONSTRUCT_RANGE, TILE,
  SLOPE_BUILDER, SLOPE_HEAVY, SLOPE_ON_ROAD,
} from '../constants.js';
import { ownerEntities, canAfford, effectiveCost, dist, canPlaceBuilding } from '../world.js';
import { findPath } from '../pathfinding.js';
import { validateTunnel } from '../systems/tunnel.js';
import {
  worldToTile, tileToWorld, hasWaterNear, nearestWaterTile, waterBlocksLand,
  inBounds, tIdx, isPassable, TT, roadAtIdx, forestBlocks,
} from '../terrain.js';

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
  { kind: 'factory',     reserve: true, want: (s) => s.factories < 1 },
  { kind: 'shipyard',    reserve: true, want: (s) => s.faction !== 'FLG' && s.coastal && s.shipyards < 1 && s.factories >= 1 && s.vehicleArmy >= 2 },
  { kind: 'power_plant', want: (s) => s.energyRatio < 1 },
  // 2) Hochtechen: Fahrzeuge sind der Standard-Siegpfad; Marine auf Küstenkarten vor Luft.
  { kind: 'shipyard',    reserve: true, want: (s) => s.coastal && s.shipyards < 1 && s.factories >= 1 && s.vehicleArmy >= 3 },
  { kind: 'airbase',     reserve: true, want: (s) => s.airbases < 1 && s.factories >= 1 && s.vehicleArmy >= 5 && (!s.coastal || s.shipyards >= 1 || s.faction === 'HLX') && s.credits > 1800 },
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
  'recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air',
  'patrol_boat', 'destroyer', 'submarine', 'underwater_drone', 'amphib_transport', 'sea_builder',
];
const COVERAGE_SKIP_BUILDINGS = new Set(['hq', 'earth_pile', 'ore_pile']);
const AI_SITE_STUCK_TICKS = 900;        // 90s ohne Baufortschritt: Baustelle blockiert die KI
const AI_PRESSURE_START_TICKS = 4200;   // ab 7 Minuten: KI geht schrittweise ins Endspiel
const AI_PRESSURE_STEP_TICKS = 900;     // alle 90s aggressiver
const AI_STALE_SCORE_EPS = 160;         // Score-Rauschen ignorieren
const AI_DOMINANCE_HOLD_TICKS = 1200;   // 2 Minuten klare Überlegenheit reicht für KI-only Entscheidung
const AI_FORCE_DECISION_PRESSURE = 7;   // nach langer Zeit reicht eine kleinere Führung
const AI_HARD_DECISION_PRESSURE = 10;   // sehr langes KI-only Patt wird deterministisch entschieden
const AI_ROUTE_PLAN_COOLDOWN = AI_REPLAN_TICKS * 2;
const AI_ROUTE_PATH_ITER = 30000;
const AI_CHEAT_STUCK_TICKS = 1500;      // 150s ohne Aufbaufortschritt = Ressourcen-Deadlock → KI darf cheaten

export function initAi(player) {
  player.ai = { phase: 'expand', attackTimer: 0, airTimer: 0, lastBuild: 0, waveSize: 5, airWave: 2, navyTimer: 0, navyWave: 2 };
}

export function stepAi(world, player, applyCommand) {
  if (player.defeated || player.controller !== 'ai') return;
  if (!player.ai) initAi(player);
  updateAiDirector(world);
  if (world.tick % AI_REPLAN_TICKS !== (player.id % AI_REPLAN_TICKS)) return;

  const s = surveyEconomy(world, player);
  manageDeadlockCheat(world, player, s);
  if (manageStalledConstruction(world, player, s)) return;
  const builtCoverage = manageCoverageBuild(world, player, s, applyCommand);
  const builtInfra = !builtCoverage && managePipelines(world, player, s, applyCommand);
  const builtBridge = !builtCoverage && !builtInfra && manageBridges(world, player, s, applyCommand);
  const builtRoute = !builtCoverage && !builtInfra && !builtBridge && manageAccessRoutes(world, player, s, applyCommand);
  if (!builtCoverage && !builtInfra && !builtBridge && !builtRoute) manageBuild(world, player, s, applyCommand);
  if (!manageCoverageProduction(world, player, s, applyCommand) && !world.aiCoverageTest) manageProduction(world, player, s, applyCommand);
  manageArmy(world, player, s, applyCommand);
  manageHarvesters(world, player, applyCommand);
  manageIdleWorkers(world, player, s, applyCommand);
}

function updateAiDirector(world) {
  if (world.aiCoverageTest || world._aiDirectorTick === world.tick) return;
  world._aiDirectorTick = world.tick;
  const active = world.players.filter(p => !p.defeated);
  const aiOnly = active.length > 1 && active.every(p => p.controller === 'ai');
  if (!aiOnly) {
    world.aiDirector = { aiOnly: false, pressure: 0 };
    world._aiDirectorLastProgress = world.tick;
    world._aiDirectorScores = null;
    return;
  }

  const scores = active.map(p => ({ player: p, score: aiPowerScore(world, p.id) }))
    .sort((a, b) => b.score - a.score || a.player.id - b.player.id);
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  const prev = world._aiDirectorScores;
  if (!prev || Math.abs(total - prev.total) > AI_STALE_SCORE_EPS) {
    world._aiDirectorLastProgress = world.tick;
    world._aiDirectorScores = { total };
  }

  const timePressure = Math.max(0, Math.floor((world.tick - AI_PRESSURE_START_TICKS) / AI_PRESSURE_STEP_TICKS));
  const stalePressure = Math.max(0, Math.floor((world.tick - (world._aiDirectorLastProgress || world.tick)) / AI_PRESSURE_STEP_TICKS));
  const pressure = Math.min(10, Math.max(timePressure, stalePressure));
  const leader = scores[0], weakest = scores[scores.length - 1];
  world.aiDirector = { aiOnly: true, pressure, leaderId: leader.player.id, weakestId: weakest.player.id };

  if (pressure < 3 || !leader || !weakest || leader.player.id === weakest.player.id) return;
  const forcedDecision = pressure >= AI_HARD_DECISION_PRESSURE;
  const strongLead = forcedDecision
    || leader.score > Math.max(weakest.score * (pressure >= AI_FORCE_DECISION_PRESSURE ? 1.18 : 1.75), weakest.score + (pressure >= AI_FORCE_DECISION_PRESSURE ? 450 : 1800));
  if (!strongLead) { world._aiDirectorDominance = null; return; }
  const dom = world._aiDirectorDominance;
  if (!dom || dom.leaderId !== leader.player.id || dom.weakestId !== weakest.player.id) {
    world._aiDirectorDominance = { leaderId: leader.player.id, weakestId: weakest.player.id, since: world.tick };
    return;
  }
  if (world.tick - dom.since >= AI_DOMINANCE_HOLD_TICKS) {
    weakest.player.defeated = true;
    world.events?.push({ type: 'defeat', player: weakest.player.id, reason: 'ai_stalemate' });
    for (const e of world.entities.values()) if (e.owner === weakest.player.id) { e.dead = true; e.hp = 0; }
    world._aiDirectorDominance = null;
  }
}

function aiPowerScore(world, owner) {
  const player = world.players.find(p => p.id === owner);
  let score = 0;
  for (const e of world.entities.values()) {
    if (e.owner !== owner || e.dead) continue;
    const hp = Math.max(0.05, Math.min(1, (e.hp || 0) / Math.max(1, e.maxHp || e.hp || 1)));
    const cost = effectiveCost(world, owner, e.def || world.data.units[e.kind] || {});
    const costScore = Object.values(cost || {}).reduce((sum, v) => sum + (v || 0), 0);
    if (e.etype === 'building') {
      const role = e.kind === 'hq' ? 900 : e.def?.produces_units || e.def?.produces_category ? 430 : e.weapon ? 300 : 160;
      score += (role + costScore * 0.9) * hp * Math.max(0.25, e.buildProgress ?? 1);
    } else {
      const role = e.weapon ? 260 : e.abilities?.includes('construct') ? 150 : e.abilities?.includes('harvest') ? 130 : 70;
      score += (role + costScore * 0.85) * hp;
    }
  }
  if (player) score += Math.min(1600, (player.resources.ore || 0) * 0.18 + (player.resources.materials || 0) * 0.10 + (player.resources.fuel || 0) * 0.05);
  return score;
}

// Deadlock-Cheat: Hat die KI über lange Zeit KEINEN Aufbaufortschritt mehr (kein neues
// Gebäude/keine neue Einheit) — typischerweise weil eine Ressource fehlt und die Förderkette klemmt
// — darf sie sich das Nötigste selbst gutschreiben, um wieder ins Spiel zu kommen. Greift NUR bei
// echtem Stillstand (wachsende/kämpfende Wirtschaften lösen es nicht aus) und nur für KI-Spieler.
function manageDeadlockCheat(world, player, s) {
  if (world.aiCoverageTest) return;
  const a = player.ai;
  const built = s.units.length + s.buildings.length;
  if (a._cheatBuilt == null || built > a._cheatBuilt) { a._cheatBuilt = built; a._cheatSince = world.tick; return; }
  if (world.tick - (a._cheatSince || world.tick) < AI_CHEAT_STUCK_TICKS) return;
  const res = player.resources;
  let cheated = false;
  const need = (k, to) => { if ((res[k] || 0) < to) { res[k] = to; cheated = true; } };
  need('ore', 800); need('materials', 250); need('fuel', 250); need('water', 150);
  a._cheatSince = world.tick;     // Cooldown bis zum nächsten möglichen Cheat
  a._cheatBuilt = built;
  if (cheated) world.events?.push({ type: 'ai_cheat', player: player.id, x: s.hq?.x || 0, y: s.hq?.y || 0 });
}

function manageStalledConstruction(world, player, s) {
  const sites = s.buildings.filter(b => b.buildProgress < 1 && !b.dead);
  if (!sites.length) return false;
  const hasBuilder = s.units.some(u => u.kind === 'builder' && !u.dead);
  for (const b of sites) {
    const p = b.buildProgress || 0;
    const recentlyWorked = b._builderNear != null && world.tick - b._builderNear <= AI_REPLAN_TICKS * 2;
    if (b._aiProgress == null || p > b._aiProgress + 0.002 || recentlyWorked) {
      b._aiProgress = p;
      b._aiStuckSince = world.tick;
      continue;
    }
    const limit = hasBuilder ? AI_SITE_STUCK_TICKS : Math.floor(AI_SITE_STUCK_TICKS * 0.45);
    if (world.tick - (b._aiStuckSince || world.tick) < limit) continue;
    const refund = effectiveCost(world, player.id, b.def || {});
    for (const [k, v] of Object.entries(refund || {})) player.resources[k] = (player.resources[k] || 0) + Math.round(v * 0.55);
    b.dead = true;
    b.hp = 0;
    world.events?.push({ type: 'site_cancel', x: b.x, y: b.y, owner: player.id, kind: b.kind, reason: 'ai_stalled' });
    return true;
  }
  return false;
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
    if (prepareBuildRoute(world, player, s, spot, def, applyCommand)) return true;
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
    vehicleArmy: u.filter(e => e.category === 'vehicle' && e.weapon).length,
    army: u.filter(e => e.weapon),
    units: u, buildings: b, hq,
  };
}

function manageBuild(world, player, s, applyCommand) {
  if (!s.hq) return false;
  const pressure = world.aiDirector?.pressure || 0;
  // Bauthrottling: höchstens 2 Baustellen gleichzeitig und nie dasselbe Gebäude doppelt im Bau.
  // Verhindert Überbau (z. B. 7 Kraftwerke auf einmal, weil im Bau befindliche Gebäude noch
  // keine Energie liefern) und sichert geordnetes Hochtechen bis zu Luftbasis/Werft.
  const underConstruction = s.buildings.filter(b => b.buildProgress < 1);
  if (underConstruction.length >= 2) return true;
  const buildingNow = new Set(underConstruction.map(b => b.kind));
  for (const step of BUILD_ORDER) {
    if (buildingNow.has(step.kind)) continue;
    if (pressure > 0 && ['wall', 'trench', 'mg_turret', 'turret'].includes(step.kind)) continue;
    if (pressure > 2 && ['flak_turret', 'sam_site', 'sonar'].includes(step.kind) && !s.enemyAir && !s.enemySubs) continue;
    const def = world.data.buildings[step.kind];
    if (step.want(s)) {
      if (!canAfford(player, effectiveCost(world, player.id, def))) {
        if (step.reserve && pressure < 2) return true;
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
        if (prepareBuildRoute(world, player, s, spot, def, applyCommand)) return true;
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
  // Brücken sind teuer und v. a. für FAHRZEUGE da (Infanterie watet/klettert ohnehin). Deckel niedrig
  // halten, sonst versenkt die KI ihr ganzes Erz in einer endlosen Brückenspur statt in die Armee.
  if (s.bridges >= 6) return false;
  const vehicles = s.army.filter(u => u.domain === 'land' && u.category === 'vehicle');
  if (vehicles.length < 1 && s.vehicleArmy < 1) return false;   // erst Fahrzeuge, dann Brücken für sie
  const def = world.data.buildings.bridge;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  const spot = pickBridgeSpot(world, player, s, def);
  if (!spot) return false;
  applyCommand(world, { type: 'build', building: 'bridge', tx: spot[0], ty: spot[1] }, player.id);
  return true;
}

function manageAccessRoutes(world, player, s, applyCommand) {
  if (!s.hq || constructionBusy(s)) return false;
  const pressure = world.aiDirector?.pressure || 0;
  const landArmy = s.army.filter(u => u.domain === 'land');
  if (landArmy.length < (pressure > 0 ? 2 : 5) && s.vehicleArmy < 1 && s.factories < 1) return false;
  const enemy = pickEnemyTarget(world, player, pressure > 0);
  if (!enemy) return false;
  const vehicles = landArmy.filter(u => u.category === 'vehicle');
  const builders = s.units.filter(u => u.kind === 'builder' && !u.dead);
  const starter = nearestEntityToPoint(vehicles.length ? vehicles : (builders.length ? builders : [s.hq]), enemy.x, enemy.y);
  if (!starter) return false;
  const from = entityTile(starter);
  const [gx, gy] = worldToTile(enemy.x, enemy.y);
  if (canReachTile(world.terrain, from.tx, from.ty, gx, gy, starter.maxSlope ?? SLOPE_HEAVY,
    { heavy: true, category: 'vehicle' }, 5)) return false;
  return planRouteInfrastructure(world, player, s, from, { tx: gx, ty: gy }, applyCommand, { preferRoad: true });
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
      if (!placeable(world, x, y, 1, def, owner)) continue;
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
    if (!placeable(world, tx, ty, def.size || 1, def, owner)) continue;
    if (!def.remoteBuild && !inAiBuildRadius(world, owner, tx, ty, def.size || 1)) continue;
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
  const pressure = world.aiDirector?.pressure || 0;
  // Spar-Reserve: genug Erz zurückhalten, um das nächste Schlüsselgebäude tatsächlich zu
  // erreichen. Fabrik/Werft haben Vorrang; Luftbasis kommt erst nach einer Fahrzeugbasis.
  let reserve = 0;
  if (pressure < 2) {
    if (s.factories < 1) reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.factory).ore || 0);
    if (s.coastal && s.shipyards < 1 && s.factories >= 1 && s.vehicleArmy >= 2) reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.shipyard).ore || 0);
    if (s.airbases < 1 && s.factories >= 1 && s.vehicleArmy >= 5 && (!s.coastal || s.shipyards >= 1 || s.faction === 'HLX')) {
      reserve = Math.max(reserve, effectiveCost(world, player.id, world.data.buildings.airbase).ore || 0);
    }
  }
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
  // Kampfeinheiten produzieren, wenn Wirtschaft steht.
  const barracks = s.buildings.filter(b => b.kind === 'barracks' && b.buildProgress >= 1);
  const factories = s.buildings.filter(b => b.kind === 'factory' && b.buildProgress >= 1);
  const airbases = s.buildings.filter(b => b.kind === 'airbase' && b.buildProgress >= 1);
  const shipyards = s.buildings.filter(b => b.kind === 'shipyard' && b.buildProgress >= 1);

  // Fahrzeuge sind der verlässliche Siegpfad: erst tragfähige Bodenarmee, dann Marine,
  // und Luft als teure Spezialoption.
  const airUnits = s.units.filter(u => u.domain === 'air').length;
  const navalUnits = s.units.filter(u => u.domain === 'water' || u.domain === 'amphibious').length;
  const VEHICLE_TARGET = (player.faction === 'KBN' ? 9 : 7) + pressure * 2;
  const NAVY_TARGET = (player.faction === 'FLG' ? 9 : 6) + pressure;
  const AIR_TARGET = Math.min(player.faction === 'HLX' ? 4 : 2, 1 + Math.floor(pressure / 4));

  // Erz-Reserve für Kampffahrzeuge: Infanterie (billig, 100 Erz) darf die Kasse NICHT leersaugen,
  // sonst sammelt die KI nie die 550–800 Erz für ein Fahrzeug an und greift ewig nur mit Fußvolk an.
  // Solange eine Fabrik steht und die Fahrzeugarmee unter Soll ist, wird Erz für das nächste
  // Kampffahrzeug zurückgehalten (anfangs ein mittleres, später ein günstiges).
  // Infanterie-Soll: genug Masse als Begleitschutz/Deckung, aber kein endloser Schwarm (früher 100+
  // Riflemen, weil billig). Bewusst niedrig, damit sich Erz für FAHRZEUGE ansammelt — Fahrzeuge sind
  // der Hauptsiegpfad, Infanterie nur Begleitung. HLX (Schwarmdoktrin) darf etwas mehr.
  const infantryArmy = s.army.filter(u => u.category === 'infantry' && !u.abilities.includes('harvest')).length;
  const INFANTRY_TARGET = (player.faction === 'HLX' ? 10 : 6) + pressure * 2;

  for (const fac of factories) {
    if (fac.queue.length >= (pressure > 2 ? 3 : 2)) continue;
    // Zweiter Bautrupp zuerst: parallelisiert Baustellen → die Lager-Ökonomie rampt doppelt so schnell.
    if (constructors < 2 && fac.queue.length === 0 && afford('builder')) {
      applyCommand(world, { type: 'produce', building: fac.id, kind: 'builder' }, player.id);
      continue;
    }
    if (s.vehicleArmy >= VEHICLE_TARGET && pressure < 4) continue;
    const r = world.rng();
    const kind = r < 0.36 ? 'tank' : r < 0.55 ? 'flak_track' : r < 0.74 ? 'rocket_launcher' : r < 0.88 ? 'scout' : 'artillery';
    if (afford(kind)) applyCommand(world, { type: 'produce', building: fac.id, kind }, player.id);
  }

  // Marine: Auf Küstenkarten eigener Siegzweig; wird vor Luft gefüllt.
  for (const sy of shipyards) {
    if (!s.coastal && player.faction !== 'FLG') continue;
    if (sy.queue.length >= 1 || navalUnits >= NAVY_TARGET) continue;
    if (s.vehicleArmy < 3 && pressure < 2) continue;
    const r = world.rng();
    const kind = navalUnits === 0 ? 'patrol_boat' : (r < 0.38 ? 'patrol_boat' : r < 0.68 ? 'destroyer' : r < 0.84 ? 'submarine' : 'underwater_drone');
    if (afford(kind)) applyCommand(world, { type: 'produce', building: sy.id, kind }, player.id);
  }

  // HLX-Schwarmdoktrin: mehr Panzerabwehr-Infanterie (at_soldier, vs.vehicle 1.3) gegen Armee mit viel Panzer.
  const riflemanShare = player.faction === 'HLX' ? 0.5 : 0.7;
  for (const bar of barracks) {
    if (bar.queue.length >= (pressure > 2 ? 3 : 2)) continue;
    if (infantryArmy >= INFANTRY_TARGET && pressure < 4) continue;   // Schwarm begrenzen (nicht 100+ Riflemen)
    const r = world.rng();
    const kind = s.enemyAir && r > 0.72 ? 'aa_soldier' : r < riflemanShare ? 'rifleman' : 'at_soldier';
    if (afford(kind)) applyCommand(world, { type: 'produce', building: bar.id, kind }, player.id);
  }

  // Luft-Doktrin: spät und begrenzt. HLX darf etwas mehr, aber die Grundkosten bleiben hoch.
  const airReady = s.vehicleArmy >= (player.faction === 'HLX' ? 5 : 6)
    && (!s.coastal || navalUnits >= (player.faction === 'FLG' ? 3 : 2) || pressure >= 4);
  const bomberShare = player.faction === 'HLX' ? 0.55 : 0.28;
  for (const air of airbases) {
    if (!airReady || air.queue.length >= 1 || airUnits >= AIR_TARGET) continue;
    const seeders = s.units.filter(u => u.kind === 'cloud_seeder').length;
    const kind = airUnits === 0 ? 'recon_drone'
      : (seeders < 1 && airUnits >= 1 && world.rng() < 0.16) ? 'cloud_seeder'
        : (world.rng() < bomberShare ? 'bomber' : 'gunship');
    if (afford(kind)) applyCommand(world, { type: 'produce', building: air.id, kind }, player.id);
  }
}

function manageArmy(world, player, s, applyCommand) {
  const pressure = world.aiDirector?.pressure || 0;
  const all = s.army.filter(u => !u.abilities.includes('harvest'));
  // Marine wird getrennt geführt (eigene Wegfindung/Ziele); rearmende Flieger nicht losschicken.
  const naval = all.filter(u => u.domain === 'water' || u.domain === 'amphibious');
  const air = s.units.filter(u => u.domain === 'air' && u.order.type !== 'rearm');
  const strike = all.filter(u => u.domain === 'land');
  const vehicleStrike = strike.filter(u => u.category === 'vehicle');
  player.ai.attackTimer++;
  const idle = strike.filter(u => u.order.type === 'idle' || u.order.type === 'guard');

  // Landangriffswelle starten, wenn genug Truppen gesammelt sind. Ab Fabrik sind Fahrzeuge
  // Pflichtanker der Offensive; Infanterie allein bleibt vor allem Sicherung/Deckung.
  // Reguläre Welle ODER periodisches Neusammeln: gestrandete attackmove-Einheiten (Ziel durch
  // Pfadprobleme verloren) bekommen spätestens nach ~2 min wieder einen Marschbefehl.
  const regroupLimit = pressure > 0 ? Math.max(10, 60 - pressure * 7) : 60;
  const minWave = pressure >= 4 ? 1 : pressure >= 2 ? 2 : 4;
  const waveNeed = pressure > 0 ? Math.max(minWave, Math.min(player.ai.waveSize, 6 - Math.min(4, pressure))) : player.ai.waveSize;
  const regroup = player.ai.attackTimer > regroupLimit && strike.length >= minWave;
  const regularNeed = Math.max(minWave, Math.min(waveNeed, pressure > 0 ? 3 : 5));
  const regularPulse = strike.length >= regularNeed && player.ai.attackTimer > Math.max(12, Math.floor(regroupLimit * 0.45));
  const vehicleReady = s.factories < 1 || vehicleStrike.length >= (pressure >= 4 ? 1 : 2) || pressure >= 6;
  if (vehicleReady && (strike.length >= waveNeed || regroup || regularPulse) && player.ai.attackTimer > 4) {
    const enemy = pickEnemyTarget(world, player, pressure > 0);
    if (enemy) {
      if (vehicleStrike.length && prepareVehicleAttackRoute(world, player, s, vehicleStrike, enemy, applyCommand)) return;
      applyCommand(world, { type: 'move', units: strike.map(u => u.id), x: enemy.x, y: enemy.y, attackMove: true }, player.id);
      player.ai.attackTimer = 0;
      player.ai.waveSize = pressure > 0 ? Math.max(3, player.ai.waveSize - 1) : Math.min(18, player.ai.waveSize + 1); // Wellen wachsen im Normalspiel
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
  const pressure = world.aiDirector?.pressure || 0;
  a.airTimer = (a.airTimer || 0) + 1;
  const ready = air.filter(u => u.order.type === 'idle' || u.order.type === 'guard' || u.order.type === 'attackmove');
  const seeders = ready.filter(u => u.kind === 'cloud_seeder' && (!u.muniMax || u.muni > 0));
  if (seeders.length && a.airTimer > 25) {
    const tgt = pickEnemyTarget(world, player, true);
    if (tgt) {
      applyCommand(world, { type: 'seedCloud', units: seeders.map(u => u.id), x: tgt.x, y: tgt.y }, player.id);
      a.airTimer = 0;
      return;
    }
  }
  const strikeReady = ready.filter(u => u.kind !== 'cloud_seeder');
  const wait = pressure > 0 ? Math.max(16, 70 - pressure * 8) : 70;
  const wave = pressure >= 3 ? 1 : (a.airWave || 2);
  if (strikeReady.length >= wave || (strikeReady.length > 0 && a.airTimer > wait)) {
    const tgt = pickEnemyTarget(world, player, pressure > 0);
    if (tgt) {
      applyCommand(world, { type: 'move', units: strikeReady.map(u => u.id), x: tgt.x, y: tgt.y, attackMove: true }, player.id);
      a.airTimer = 0;
      a.airWave = pressure > 0 ? Math.max(1, (a.airWave || 2) - 1) : Math.min(8, (a.airWave || 2) + 1);
    }
  }
}

// Marine-Doktrin: Flotte sammeln und gegen das nächste Küstenziel des Gegners vorstoßen.
function manageNavy(world, player, naval, applyCommand) {
  const a = player.ai;
  const pressure = world.aiDirector?.pressure || 0;
  a.navyTimer = (a.navyTimer || 0) + 1;
  const wave = pressure >= 3 ? 1 : (a.navyWave || 3);
  const wait = pressure > 0 ? Math.max(18, 90 - pressure * 9) : 90;
  if ((naval.length >= wave && a.navyTimer > 4) || (naval.length > 0 && a.navyTimer > wait)) {
    const tgt = pickNavalTarget(world, player);
    if (tgt) {
      applyCommand(world, { type: 'move', units: naval.map(u => u.id), x: tgt.x, y: tgt.y, attackMove: true }, player.id);
      a.navyTimer = 0;
      a.navyWave = pressure > 0 ? Math.max(1, (a.navyWave || 2) - 1) : Math.min(16, (a.navyWave || 2) + 1);
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
  if (!best) best = pickEnemyTarget(world, player, world.aiDirector?.pressure > 0);
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

function manageIdleWorkers(world, player, s, applyCommand) {
  const idleLike = (u) => u.order.type === 'idle' || u.order.type === 'guard';
  const pendingSites = s.buildings.some(b => b.buildProgress < 1 && !b.dead);
  const pendingTerra = (world.terraJobs || []).some(j => j.owner === player.id);
  const oreBuilderMissing = (s.oreDepots > 0 || s.refineries > 0)
    && !s.units.some(u => u.kind === 'builder' && u.resourceRole === 'ore' && !u.dead);
  let assignedOreBuilder = !oreBuilderMissing;
  for (const b of s.units.filter(u => u.kind === 'builder' && !u.dead && idleLike(u))) {
    if (pendingTerra) b.resourceRole = 'earth';
    else if (pendingSites) b.resourceRole = 'build';
    else if (!assignedOreBuilder) { b.resourceRole = 'ore'; assignedOreBuilder = true; }
    if (pendingSites || pendingTerra || b.resourceRole === 'ore') {
      b.order = { type: b.resourceRole === 'ore' ? 'idle' : 'guard' };
      continue;
    }
    parkSupportUnit(world, b, s, applyCommand);
  }

  const pendingPiles = [...world.entities.values()].some(e => e.owner === player.id
    && (e.kind === 'earth_pile' || e.kind === 'ore_pile') && !e.dead && (e.amount || 0) > 0);
  for (const t of s.units.filter(u => u.kind === 'truck' && !u.dead && idleLike(u))) {
    if (pendingPiles || (t.cargo || 0) > 0) {
      t.order = { type: 'guard' };
      continue;
    }
    parkSupportUnit(world, t, s, applyCommand);
  }
}

function parkSupportUnit(world, unit, s, applyCommand) {
  const anchor = logisticsAnchor(s);
  if (!anchor) return;
  const a = ((unit.id % 16) / 16) * Math.PI * 2;
  const r = 5 + (unit.id % 4);
  const x = anchor.x + Math.cos(a) * r;
  const y = anchor.y + Math.sin(a) * r;
  if (Math.hypot(unit.x - x, unit.y - y) > 7) {
    applyCommand(world, { type: 'move', units: [unit.id], x, y }, unit.owner);
  } else {
    unit.order = { type: 'guard' };
  }
}

function logisticsAnchor(s) {
  return s.buildings.find(b => b.buildProgress >= 1 && ['material_depot', 'ore_depot', 'refinery', 'depot'].includes(b.kind))
    || s.hq;
}

function pickEnemyTarget(world, player, decisive = false) {
  let best = null, bestD = Infinity;
  const hq = ownerEntities(world, player.id, 'building').find(b => b.kind === 'hq');
  const from = hq || ownerEntities(world, player.id, 'unit')[0];
  if (!from) return null;
  for (const e of world.entities.values()) {
    if (e.owner === player.id || e.dead) continue;
    const owner = world.players.find(p => p.id === e.owner);
    if (!owner || owner.defeated) continue;
    // Bevorzugt Produktionsgebäude/HQ; im Endspiel noch stärker auf Entscheidungsziele.
    const production = e.etype === 'building' && (e.def?.produces_units || e.def?.produces_category);
    const prio = e.etype === 'building'
      ? e.kind === 'hq' ? (decisive ? 0.25 : 0.5)
        : production ? (decisive ? 0.45 : 0.8)
        : decisive ? 0.9 : 1.0
      : decisive ? 1.8 : 1.2;
    const d = ((e.x - from.x) ** 2 + (e.y - from.y) ** 2) * prio;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function prepareBuildRoute(world, player, s, spot, def, applyCommand) {
  if (!spot || !def || def.bridges || def.tunnels || def.roadBuilt || def.pipe || def.role === 'fortification') return false;
  const builders = s.units.filter(u => u.kind === 'builder' && !u.dead);
  if (!builders.length) return false;
  const size = def.size || 1;
  const target = { tx: Math.round(spot[0] + size / 2), ty: Math.round(spot[1] + size / 2) };
  const builder = nearestEntityToTile(builders, target.tx, target.ty);
  if (!builder) return false;
  if (canReachBuildSpot(world.terrain, builder, spot[0], spot[1], size)) return false;
  const [sx, sy] = worldToTile(builder.x, builder.y);
  return planRouteInfrastructure(world, player, s, { tx: sx, ty: sy }, target, applyCommand, { preferRoad: true });
}

function prepareVehicleAttackRoute(world, player, s, vehicles, enemy, applyCommand) {
  const lead = nearestEntityToPoint(vehicles, enemy.x, enemy.y);
  if (!lead) return false;
  const [sx, sy] = worldToTile(lead.x, lead.y);
  const [gx, gy] = worldToTile(enemy.x, enemy.y);
  if (canReachTile(world.terrain, sx, sy, gx, gy, lead.maxSlope ?? SLOPE_HEAVY,
    { heavy: true, category: lead.category }, 5)) return false;
  return planRouteInfrastructure(world, player, s, { tx: sx, ty: sy }, { tx: gx, ty: gy }, applyCommand, { preferRoad: true });
}

function canReachTile(t, sx, sy, gx, gy, maxSlope, opts, maxGoalError) {
  if (!inBounds(t, sx, sy) || !inBounds(t, gx, gy)) return false;
  const path = findPath(t, 'land', sx, sy, gx, gy, AI_ROUTE_PATH_ITER, maxSlope, opts);
  if (!path) return false;
  const goal = path.goal || [gx, gy];
  return Math.hypot(goal[0] - gx, goal[1] - gy) <= maxGoalError;
}

function canReachBuildSpot(t, builder, tx, ty, size) {
  const [sx, sy] = worldToTile(builder.x, builder.y);
  const opts = { category: builder.category, mudCrawler: true, terraCrawler: true };
  const maxSlope = builder.maxSlope ?? SLOPE_BUILDER;
  const maxRing = Math.max(3, Math.ceil((size + CONSTRUCT_RANGE) / TILE) + 2);
  const cx = (tx + size / 2) * TILE;
  const cy = (ty + size / 2) * TILE;
  for (let r = 1; r <= maxRing; r++) {
    for (let y = ty - r; y < ty + size + r; y++) for (let x = tx - r; x < tx + size + r; x++) {
      const edge = x === tx - r || x === tx + size + r - 1 || y === ty - r || y === ty + size + r - 1;
      if (!edge || !inBounds(t, x, y) || !isPassable(t, builder.domain || 'land', x, y)) continue;
      const [wx, wy] = tileToWorld(x, y);
      if (Math.hypot(cx - wx, cy - wy) > size + CONSTRUCT_RANGE) continue;
      if (canReachTile(t, sx, sy, x, y, maxSlope, opts, 0.25)) return true;
    }
  }
  return false;
}

function planRouteInfrastructure(world, player, s, from, to, applyCommand, opts = {}) {
  if (!from || !to || !s.hq) return false;
  if (routeWorkPending(world, player.id, from, to)) return true;
  if ((world.tick - (player.ai.routePlanTick || -Infinity)) < AI_ROUTE_PLAN_COOLDOWN) return true;
  if (constructionBusy(s)) return true;

  const cells = lineTiles(from.tx, from.ty, to.tx, to.ty);
  let prev = from;
  for (let n = 0; n < cells.length; n++) {
    const [tx, ty] = cells[n];
    if (!inBounds(world.terrain, tx, ty)) break;
    const i = tIdx(world.terrain, tx, ty);
    // Klippen-Riegel: EINEN durchgehenden Tunnel von der Mündung diesseits zur Mündung jenseits
    // planen (statt je Klippen-Tile ein eigenes Gebäude).
    if (world.terrain.type[i] === TT.CLIFF && !(world.terrain.tunnel && world.terrain.tunnel[i] > 0)) {
      const tunnelAct = planTunnelOverRidge(world, cells, n, prev);
      if (tunnelAct && issueRouteAction(world, player, tunnelAct, applyCommand)) {
        player.ai.routePlanTick = world.tick;
        return true;
      }
    }
    // Wasserlauf (Fluss): die GANZE zusammenhängende Wasserspanne auf einmal überbrücken, statt eine
    // Kachel pro Planungsrunde — sonst bleibt die Brücke unvollständig und kein Fahrzeug kommt rüber.
    if (waterBlocksLand(world.terrain, i) && !(world.terrain.bridge && world.terrain.bridge[i] > 0)) {
      if (planBridgeSpan(world, player, cells, n, applyCommand)) {
        player.ai.routePlanTick = world.tick;
        return true;
      }
    }
    const action = routeCellAction(world, player, prev, { tx, ty }, n, opts);
    if (action && issueRouteAction(world, player, action, applyCommand)) {
      player.ai.routePlanTick = world.tick;
      return true;
    }
    if (world.terrain.type[i] !== TT.CLIFF && !waterBlocksLand(world.terrain, i)) prev = { tx, ty };
  }
  return false;
}

// Eine zusammenhängende Wasserspanne (Fluss) auf der Route in EINEM Zug überbrücken: ab der ersten
// Wasserzelle alle folgenden Wasserzellen als Brücke setzen, soweit das Erz reicht (Rest folgt in
// den nächsten Runden). So entsteht eine durchgehende Brücke statt verstreuter Einzelpfeiler.
function planBridgeSpan(world, player, cells, n, applyCommand) {
  const t = world.terrain;
  const def = world.data.buildings.bridge;
  if (!def) return false;
  const cost = effectiveCost(world, player.id, def);
  let built = false;
  for (let k = n; k < cells.length; k++) {
    const [tx, ty] = cells[k];
    if (!inBounds(t, tx, ty)) break;
    const i = tIdx(t, tx, ty);
    if (!waterBlocksLand(t, i)) break;                         // Wasserlauf zu Ende → Spanne fertig
    if (t.bridge && t.bridge[i] > 0) continue;                 // schon überbrückt
    if (existingOrPendingBuilding(world, player.id, 'bridge', tx, ty)) continue;
    if (!canAfford(player, cost)) break;                       // Erz alle → Rest später
    if (!placeable(world, tx, ty, 1, def, player.id)) continue;
    applyCommand(world, { type: 'build', building: 'bridge', tx, ty }, player.id);
    built = true;
  }
  return built;
}

// Über einen Klippen-Riegel entlang der Route einen gültigen Tunnel finden: Mündung A = letzte
// begehbare Zelle vor dem Riegel (prev), Mündung B = erste begehbare Zelle dahinter.
function planTunnelOverRidge(world, cells, n, prev) {
  let m = n;
  while (m < cells.length && world.terrain.type[tIdx(world.terrain, cells[m][0], cells[m][1])] === TT.CLIFF) m++;
  if (m >= cells.length) return null;
  const [ex, ey] = cells[m];
  if (validateTunnel(world, prev.tx, prev.ty, ex, ey)) {
    return { type: 'tunnel', sx: prev.tx, sy: prev.ty, ex, ey };
  }
  return null;
}

function routeCellAction(world, player, prev, cur, step, opts) {
  const t = world.terrain;
  const i = tIdx(t, cur.tx, cur.ty);
  const prevI = tIdx(t, prev.tx, prev.ty);
  if (waterBlocksLand(t, i) && !(t.bridge && t.bridge[i] > 0)) {
    if (step > 2 && opts.preferRoad && !roadAtIdx(t, prevI)) return { type: 'build', kind: 'road', tx: prev.tx, ty: prev.ty };
    return { type: 'build', kind: 'bridge', tx: cur.tx, ty: cur.ty };
  }
  // Klippen werden in planRouteInfrastructure als durchgehender Tunnel behandelt (nicht hier).
  if (t.type[i] === TT.CLIFF && !(t.tunnel && t.tunnel[i] > 0)) return null;

  const dh = Math.abs((t.height?.[i] || 0) - (t.height?.[prevI] || 0));
  if (dh > SLOPE_ON_ROAD) {
    const high = (t.height[i] > t.height[prevI]) ? cur : prev;
    return { type: 'terraform', tx: high.tx, ty: high.ty, dir: -1 };
  }
  if (dh > SLOPE_HEAVY && (!roadAtIdx(t, i) || !roadAtIdx(t, prevI))) {
    const target = !roadAtIdx(t, prevI) ? prev : cur;
    return { type: 'build', kind: 'road', tx: target.tx, ty: target.ty };
  }
  if (forestBlocks(t, 'land', cur.tx, cur.ty, { category: 'vehicle' }) && !roadAtIdx(t, i)) {
    return { type: 'build', kind: 'road', tx: cur.tx, ty: cur.ty };
  }
  // Durchgehende Straße statt verstreuter Einzelflecken: jede noch unbefestigte Routenzelle wird
  // belegt. Da planRouteInfrastructure die Zellen der Reihe nach abarbeitet, füllen sich die Tiles
  // konsekutiv zu einem zusammenhängenden Weg/einer Serpentine; die Erreichbarkeitsprüfung in
  // manageAccessRoutes stoppt den Bau, sobald die Fahrzeuge durchkommen.
  if (opts.preferRoad && step > 0 && !roadAtIdx(t, i)) {
    return { type: 'build', kind: 'road', tx: cur.tx, ty: cur.ty };
  }
  return null;
}

function issueRouteAction(world, player, action, applyCommand) {
  if (action.type === 'terraform') {
    if (terraJobPending(world, player.id, action.tx, action.ty)) return true;
    applyCommand(world, { type: 'terraform', tx: action.tx, ty: action.ty, dir: action.dir }, player.id);
    return true;
  }
  if (action.type === 'tunnel') {
    // placeTunnel prüft Hang/Länge/Kosten selbst; bei zu wenig Erz No-op (Cooldown verhindert Spam).
    applyCommand(world, { type: 'tunnel', sx: action.sx, sy: action.sy, ex: action.ex, ey: action.ey }, player.id);
    return true;
  }
  const def = world.data.buildings[action.kind];
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  if (existingOrPendingBuilding(world, player.id, action.kind, action.tx, action.ty)) return true;
  if (!placeable(world, action.tx, action.ty, def.size || 1, def, player.id)) return false;
  applyCommand(world, { type: 'build', building: action.kind, tx: action.tx, ty: action.ty }, player.id);
  return true;
}

function routeWorkPending(world, owner, from, to) {
  for (const e of world.entities.values()) {
    if (e.owner !== owner || e.dead || e.etype !== 'building' || e.buildProgress >= 1) continue;
    if (!['road', 'bridge', 'tunnel'].includes(e.kind)) continue;
    if (nearLine(e.tx, e.ty, from.tx, from.ty, to.tx, to.ty, 3)) return true;
  }
  for (const j of world.terraJobs || []) {
    if (j.owner === owner && nearLine(j.tx, j.ty, from.tx, from.ty, to.tx, to.ty, 3)) return true;
  }
  return false;
}

function existingOrPendingBuilding(world, owner, kind, tx, ty) {
  return [...world.entities.values()].some(e => e.owner === owner && !e.dead && e.etype === 'building'
    && e.kind === kind && e.tx === tx && e.ty === ty);
}

function terraJobPending(world, owner, tx, ty) {
  return (world.terraJobs || []).some(j => j.owner === owner && j.tx === tx && j.ty === ty);
}

function nearLine(px, py, ax, ay, bx, by, pad) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay) <= pad;
  const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * u), py - (ay + vy * u)) <= pad;
}

function nearestEntityToTile(list, tx, ty) {
  return nearestBy(list, e => {
    const [ex, ey] = worldToTile(e.x, e.y);
    return (ex - tx) ** 2 + (ey - ty) ** 2;
  });
}

function nearestEntityToPoint(list, x, y) {
  return nearestBy(list, e => (e.x - x) ** 2 + (e.y - y) ** 2);
}

function entityTile(e) {
  if (e.etype === 'building') return { tx: Math.round(e.tx + (e.size || 1) / 2), ty: Math.round(e.ty + (e.size || 1) / 2) };
  const [tx, ty] = worldToTile(e.x, e.y);
  return { tx, ty };
}

function nearestBy(list, scoreFn) {
  let best = null, bestScore = Infinity;
  for (const item of list) {
    const score = scoreFn(item);
    if (score < bestScore) { bestScore = score; best = item; }
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
    if (placeable(world, tx, ty, size, def, hq.owner)) return [tx, ty];
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
    if (placeable(world, tx, ty, size, def, player.id)) return [tx, ty];
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
      if (!placeable(world, tx, ty, size, def, owner)) continue;
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
  const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
  let best = null, bestD = Infinity;
  for (const idx of world.terrain.oilList || []) {
    if (oil[idx] <= 0) continue;
    const tx = idx % world.terrain.w, ty = (idx / world.terrain.w) | 0;
    if (!placeable(world, tx, ty, size, def, hq.owner)) continue;
    const d = (tx + size / 2 - cx) ** 2 + (ty + size / 2 - cy) ** 2;
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
      if (!placeable(world, tx, ty, size, def, owner)) continue;
      const score = Math.hypot(cx - ecx, cy - ecy);
      if (score < bestScore) { bestScore = score; best = [tx, ty]; }
    }
  }
  return best;
}

function placeable(world, tx, ty, size, def = null, owner = null) {
  if (!canPlaceBuilding(world, tx, ty, size, def || undefined, owner)) return false;
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
