// Computergegner: Wirtschaft hochfahren, Bauen, Produzieren, Angreifen, Verteidigen.
// Dieselbe KI treibt die automatisierten Tests. Zustandsbasiert, datengetrieben.
import {
  AI_REPLAN_TICKS, PIPE_LINK_RANGE, CONSTRUCT_RANGE, TILE,
  SLOPE_BUILDER, SLOPE_HEAVY, SLOPE_ON_ROAD,
} from '../constants.js';
import { ownerEntities, canAfford, effectiveCost, dist, canPlaceBuilding, spawnUnit } from '../world.js';
import { findPath } from '../pathfinding.js';
import { validateTunnel } from '../systems/tunnel.js';
import {
  worldToTile, tileToWorld, hasWaterNear, nearestWaterTile, waterBlocksLand, persistentWaterBlocksLand,
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
  // Proaktive Basis-Flugabwehr als Geschwister des mg_turret (gleiches frühes Bau-Fenster, solange noch
  // Erz fließt). Die reguläre flak_turret-Bedingung weiter unten verlangt enemyAir/army≥8, was in
  // KI-vs-KI-Partien fast nie eintritt → flak_turret blieb eine tote Bauoption (Coverage-Ziel C, gemessen
  // coverage.js). Der Gegner KANN Luft bauen → eine billige AA-Stellung ist sinnvolle Doktrin, kein Über-
  // bau (gedeckelt flakTurrets<1, erst ab einer kleinen Armee → kein Verdrängen des Fahrzeugkerns).
  { kind: 'flak_turret', want: (s) => s.flakTurrets < 1 && s.barracks >= 1 && s.army.length >= 5 },
  // Solarpark früh & günstig (350 Erz, wie mg_turret → auch für die oft erz-knappe KI bezahlbar): liefert
  // Tagstrom, entlastet das treibstoffhungrige Ölkraftwerk und kam in der regulären Liste (#49,
  // credits>1000) real fast nie vor (Coverage-Ziel C). Wirtschafts-positiv → kein Risiko für den Siegpfad.
  { kind: 'solar_plant', want: (s) => s.solars < 1 && s.powerPlants >= 1 && s.barracks >= 1 },
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
  'road', 'bridge', 'tunnel', 'wall', 'dam',
];
const COVERAGE_UNIT_ORDER = [
  'builder', 'engineer', 'rifleman', 'at_soldier', 'aa_soldier',
  'truck', 'tractor', 'scout', 'tank', 'flak_track', 'rocket_launcher', 'artillery',
  'recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air',
  'patrol_boat', 'destroyer', 'submarine', 'underwater_drone', 'amphib_transport', 'sea_builder',
];
const COVERAGE_SKIP_BUILDINGS = new Set(['hq', 'earth_pile', 'ore_pile']);
// Grundwirtschaft (Erzfluss), die VOR dem Banken für die Produktionskette stehen muss — sonst blockiert
// das Banken den Aufbau der Erzförderung und die KI kommt nie auf Erz für factory & Co.
const COVERAGE_ECON_PREREQ = ['power_plant', 'ore_depot', 'material_depot', 'refinery'];
// Produktionskette ZUERST bauen (vor dem kosmetischen Schwanz): factory (Fahrzeuge), shipyard (Marine),
// airbase (Luft) — schalten ganze Einheitensparten frei. Früh gebaut, solange die Basis noch frei ist,
// findet besonders die große airbase (5×5) eher einen Platz.
const COVERAGE_PRODUCTION_CHAIN = ['barracks', 'factory', 'shipyard', 'airbase'];
const AI_SITE_STUCK_TICKS = 900;        // 90s ohne Baufortschritt: Baustelle blockiert die KI
const AI_PRESSURE_START_TICKS = 4200;   // ab 7 Minuten: KI geht schrittweise ins Endspiel
const AI_PRESSURE_STEP_TICKS = 900;     // alle 90s aggressiver
const AI_STALE_SCORE_EPS = 160;         // Score-Rauschen ignorieren
const AI_DOMINANCE_HOLD_TICKS = 1200;   // 2 Minuten klare Überlegenheit reicht für KI-only Entscheidung
const AI_FORCE_DECISION_PRESSURE = 7;   // nach langer Zeit reicht eine kleinere Führung
const AI_HARD_DECISION_PRESSURE = 10;   // sehr langes KI-only Patt wird deterministisch entschieden
const AI_ROUTE_PLAN_COOLDOWN = AI_REPLAN_TICKS * 2;
const AI_ROUTE_MAX_CELLS = 24;             // Straße in EINEM Zug bis hierher legen (durchgehende Route)
const INFRA_KINDS = new Set(['road', 'bridge', 'tunnel', 'pipe']); // zählen nicht als Bau-Throttle
const AI_ROUTE_PATH_ITER = 30000;
const AI_CHEAT_STUCK_TICKS = 900;       // 90s ohne Aufbaufortschritt = Deadlock → KI darf cheaten (früh genug, bevor der Director sie aufgibt)
const AI_SECONDARY_TICKS = 240;         // Sekundärziele nur alle ~24s einen Schritt → kein Überbau
const AI_MOAT_RADIUS = 7;               // Wallring-Radius um das HQ
const AI_MOAT_MAX = 16;                 // Höchstzahl Ring-Wälle (Schutzwall, nicht endlos)

export function initAi(player) {
  player.ai = { phase: 'expand', attackTimer: 0, airTimer: 0, lastBuild: 0, waveSize: 5, airWave: 2, navyTimer: 0, navyWave: 2, doctrine: 'combined', doctrineUntil: 0 };
}

// Wechselnde Strategien: die KI wählt regelmäßig eine neue Doktrin (deterministisch über world.rng),
// damit Partien abwechslungsreich verlaufen — mal Luftschlag-fokussiert, mal Sturm, mal belagernd,
// mal Überfall auf die Versorgung, mal Nachtangriff. Beeinflusst Wellengröße, Timing und Zielwahl.
const AI_DOCTRINES = ['combined', 'airstrike', 'naval', 'rush', 'siege', 'raid', 'night', 'flood'];
const AI_DOCTRINE_TICKS = 2400;     // alle ~4 min eine neue Strategie
function updateDoctrine(world, player) {
  const a = player.ai;
  if (a.doctrineUntil && world.tick < a.doctrineUntil) return;
  const r = (world.rng ? world.rng() : 0.5);
  let d = AI_DOCTRINES[Math.min(AI_DOCTRINES.length - 1, Math.floor(r * AI_DOCTRINES.length))];
  a.doctrine = d;
  a.doctrineUntil = world.tick + AI_DOCTRINE_TICKS;
  world.events?.push({ type: 'ai_doctrine', player: player.id, doctrine: d });
}

export function stepAi(world, player, applyCommand) {
  if (player.defeated || player.controller !== 'ai') return;
  if (!player.ai) initAi(player);
  updateAiDirector(world);
  if (world.tick % AI_REPLAN_TICKS !== (player.id % AI_REPLAN_TICKS)) return;
  updateDoctrine(world, player);

  manageCoverageSubsidy(world, player);
  const s = surveyEconomy(world, player);
  manageDeadlockCheat(world, player, s);
  if (manageStalledConstruction(world, player, s)) return;
  const builtCoverage = manageCoverageBuild(world, player, s, applyCommand);
  const builtInfra = !builtCoverage && managePipelines(world, player, s, applyCommand);
  const builtBridge = !builtCoverage && !builtInfra && manageBridges(world, player, s, applyCommand);
  const builtRoute = !builtCoverage && !builtInfra && !builtBridge && manageAccessRoutes(world, player, s, applyCommand);
  if (!builtCoverage && !builtInfra && !builtBridge && !builtRoute) manageBuild(world, player, s, applyCommand);
  if (!manageCoverageProduction(world, player, s, applyCommand) && !world.aiCoverageTest) manageProduction(world, player, s, applyCommand);
  // Verteidigungs-Filler läuft NACH der Armeeproduktion (die ihren Erzanspruch zuerst geltend macht) und
  // baut nur aus dem Rest, der noch die Kosten eines Kampffahrzeugs übrig lässt → kein Verdrängen des
  // Siegpfads. Bewusst NICHT an „reguläre Liste war untätig" gekoppelt: die Build-Order will fast immer
  // noch irgendein Wirtschaftsgebäude → die Kopplung ließ den Filler praktisch nie laufen.
  manageDefensiveCoverage(world, player, s, applyCommand);
  manageRecovery(world, player, s, applyCommand);
  manageSecondaryObjective(world, player, s, applyCommand);
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
  need('ore', 1000); need('materials', 300); need('fuel', 300); need('water', 200);
  // BAUFÄHIGKEIT garantieren: ohne Bagger kommt die KI aus dem Stillstand nicht raus (Erz allein
  // hilft nicht). Hat sie keinen Bagger, aber ein HQ, einen direkt spawnen — sonst gilt sie sonst
  // grundlos als „besiegt", weil sie nie wieder baut.
  const hasBuilder = s.units.some(u => u.kind === 'builder' && !u.dead);
  if (!hasBuilder && s.hq && world.data.units.builder) {
    spawnUnit(world, player.id, 'builder', s.hq.x + 2, s.hq.y + 2);
    cheated = true;
  }
  // Steckengebliebene Bau-/Sammelaufträge lösen, damit der Bagger neu zugeteilt wird.
  for (const u of s.units) if (u.kind === 'builder' && (u.order?.type === 'idle' || u.order?.type === 'guard')) u._badNodes = null;
  a._cheatSince = world.tick;     // Cooldown bis zum nächsten möglichen Cheat
  a._cheatBuilt = built;
  if (cheated) world.events?.push({ type: 'ai_cheat', player: player.id, x: s.hq?.x || 0, y: s.hq?.y || 0 });
}

// Sekundärziel jenseits des reinen „Armee bauen und angreifen": ein STABILER Schutzwall (Wasserwall/
// Deich) um die eigene Basis. Streng gegated, damit er das Militär nie aushungert.
function manageSecondaryObjective(world, player, s, applyCommand) {
  if (world.aiCoverageTest || !s.hq) return;
  const a = player.ai;
  if (world.tick - (a._secTick || 0) < AI_SECONDARY_TICKS) return;
  const pressure = world.aiDirector?.pressure || 0;
  // Wasserwall/Schutzring: nur wenn wirtschaftlich bequem (viel Erz übrig), eine stehende Armee da ist
  // und gerade kein Endspieldruck herrscht — reiner Bonus, der das Militär nicht verdrängt.
  if (pressure === 0 && s.credits > 1200 && s.army.length >= 8 && s.walls < AI_MOAT_MAX
      && buildMoatRing(world, player, s, applyCommand)) {
    a._secTick = world.tick; return;
  }
  a._secTick = world.tick;
}

// Schutzwall-Ring: setzt EINEN fehlenden Wall auf einem Kreis um das HQ (gleichmäßig verteilte Winkel),
// sodass über die Zeit ein geschlossener Deich entsteht. Wälle sind `waterBlocks` → wirken als Wasserwall.
function buildMoatRing(world, player, s, applyCommand) {
  const def = world.data.buildings.wall;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  const hq = s.hq;
  const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const tx = Math.round(cx + Math.cos(ang) * AI_MOAT_RADIUS);
    const ty = Math.round(cy + Math.sin(ang) * AI_MOAT_RADIUS);
    if (existingOrPendingBuilding(world, player.id, 'wall', tx, ty)) continue;
    if (!placeable(world, tx, ty, 1, def, player.id)) continue;
    applyCommand(world, { type: 'build', building: 'wall', tx, ty }, player.id);
    return true;
  }
  return false;
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

// NUR im Baubarkeits-Oracle (world.aiCoverageTest): hält Erz/Material/Treibstoff/Wasser auf einem Sockel,
// damit Bezahlbarkeit NIE der Grund ist, dass ein Typ in der Abdeckung fehlt. So trennt der Oracle sauber
// STRUKTURELL tote Bauoptionen (kein Platz/kein Producer/keine Tech) von rein wirtschaftlich knappen.
// Im normalen Spiel (organische Abdeckung + reale Matches) ist diese Funktion ein No-Op.
function manageCoverageSubsidy(world, player) {
  if (!world.aiCoverageTest) return;
  const r = player.resources;
  if ((r.ore || 0) < 2000) r.ore = 2000;             // > airbase (1200) + parallele Einheitenproduktion
  if ((r.materials || 0) < 600) r.materials = 600;
  if ((r.fuel || 0) < 600) r.fuel = 600;
  if ((r.water || 0) < 400) r.water = 400;
}

function manageCoverageBuild(world, player, s, applyCommand) {
  if (!world.aiCoverageTest || !s.hq || constructionBusy(s)) return false;
  const existing = new Set(s.buildings.map(b => b.kind));
  // Coverage-Oracle: die Produktionskette (factory/shipyard/airbase) schaltet GANZE Einheitensparten
  // frei (Fahrzeuge/Marine/Luft). Ohne sie kann manageCoverageProduction nur Infanterie produzieren →
  // Einheiten-Abdeckung blieb bei ~24 % hängen. Erst die Grundwirtschaft, dann die Kette ZUERST (vor dem
  // billigen Schwanz) bauen, solange die Basis noch frei ist (Platz für die 5×5-airbase). Bezahlbarkeit
  // ist dank Coverage-Subvention (manageCoverageSubsidy) nie der Engpass — übrig bleibt nur strukturelle
  // Baubarkeit (Platz/Producer/Wasser). Unplatzierbare Glieder → übersprungen (regulärer Schwanz baut sie).
  const haveEcon = COVERAGE_ECON_PREREQ.every(k => !world.data.buildings[k] || existing.has(k));
  if (haveEcon) {
    for (const kind of COVERAGE_PRODUCTION_CHAIN) {
      if (existing.has(kind) || !world.data.buildings[kind]) continue;
      const def = world.data.buildings[kind];
      if (!canAfford(player, effectiveCost(world, player.id, def))) continue;
      const spot = pickCoverageBuildSpot(world, player, s, kind, def);
      if (!spot) continue;                                                          // nicht platzierbar → nächstes Glied
      if (prepareBuildRoute(world, player, s, spot, def, applyCommand)) return true;
      applyCommand(world, { type: 'build', building: kind, tx: spot[0], ty: spot[1] }, player.id);
      return true;
    }
  }
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
    trucks: u.filter(e => e.kind === 'truck').length,
    vehicleArmy: u.filter(e => e.category === 'vehicle' && e.weapon).length,
    army: u.filter(e => e.weapon),
    units: u, buildings: b, hq,
  };
}

function manageBuild(world, player, s, applyCommand) {
  if (!s.hq) return false;
  // Logistik-Bootstrap schützen: ohne LKW werden Erz- und Erdhaufen nicht zuverlässig abgefahren.
  if (s.factories >= 1 && s.refineries >= 1 && s.trucks < 1) {
    const truckOre = effectiveCost(world, player.id, world.data.units.truck).ore || 0;
    if (player.resources.ore < truckOre + 150) return false;
  }
  const pressure = world.aiDirector?.pressure || 0;
  // Bauthrottling: höchstens 2 Baustellen gleichzeitig und nie dasselbe Gebäude doppelt im Bau.
  // Verhindert Überbau (z. B. 7 Kraftwerke auf einmal, weil im Bau befindliche Gebäude noch
  // keine Energie liefern) und sichert geordnetes Hochtechen bis zu Luftbasis/Werft.
  // Infrastruktur (Routen) nicht mitzählen, damit eine im Bau befindliche Straße/Brücke die Wirtschaft
  // nicht einfriert.
  const underConstruction = s.buildings.filter(b => b.buildProgress < 1 && !INFRA_KINDS.has(b.kind));
  if (underConstruction.length >= 2) return true;
  const buildingNow = new Set(underConstruction.map(b => b.kind));
  for (const step of BUILD_ORDER) {
    if (buildingNow.has(step.kind)) continue;
    if (pressure > 0 && ['wall', 'trench', 'mg_turret'].includes(step.kind)) continue;
    // Erz für KAMPFFAHRZEUGE reservieren: solange eine Fabrik steht, die Fahrzeugarmee aber noch klein
    // ist, KEINE diskretionären Verteidigungsbauten (Wall/Graben) — sonst versickert der Erzüberschuss
    // in Mauern statt in Panzern (gemessene Ursache der Mini-Armeen/frozen draws).
    if (['wall', 'trench'].includes(step.kind) && s.factories >= 1 && s.vehicleArmy < 5) continue;
    // Ein zweiter, stärkerer Geschützturm (turret, Deckel turrets<2) darf auch unter Druck noch
    // entstehen: in eingefrorenen KI-Partien rampt stalePressure schnell (>0 nach ~90s), sonst
    // erreicht die Build-Order den turret-Schritt nie → tote Bauoption. Ein Hardpoint ist billig,
    // gedeckelt und hilft dem Führenden, die Front zu festigen (Coverage-Ziel C/F).
    if (pressure > 2 && ['flak_turret', 'sam_site', 'sonar'].includes(step.kind) && !s.enemyAir && !s.enemySubs) continue;
    const def = world.data.buildings[step.kind];
    if (step.want(s)) {
      if (!canAfford(player, effectiveCost(world, player.id, def))) {
        if (step.reserve && pressure < 2) return true;
        continue;
      }
      let spot;
      if (def.role === 'fortification') spot = pickDefensiveSpot(world, player, s, def);
      // Pumpwerk/Werft ans Wasser; Pumpwerk sucht Süßwasser (Fluss/See) auch fernab der Basis (remoteBuild).
      else if (def.requiresWater) spot = pickCoastalSpot(world, player, s, def.size || 1, def)
        || (def.pump ? findFreshWaterPumpSpot(world, player.id, s.hq, def.size || 1, def) : null);
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
  if (!s.hq || constructionBusy(s)) return false;
  const def = world.data.buildings.pipe;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  const producers = s.buildings.filter(b => b.buildProgress >= 1 && producerResource(b));
  for (const prod of producers) {
    if (prod._pipelineConnected === true) continue;
    const resource = producerResource(prod);
    const sinks = s.buildings.filter(b => b.buildProgress >= 1 && depotResources(b).includes(resource));
    if (!sinks.length) continue;
    if (pipelineConnected(world, player.id, prod, sinks)) continue;
    // Liegt von diesem Produzenten schon eine Leitung IM BAU Richtung Senke? Dann NICHT noch eine
    // danebenlegen — sonst entsteht das gemeldete „Spinnennetz" (jede Runde eine neue Parallelleitung).
    // Erst fertig bauen lassen; bleiben danach echte Lücken, füllt planFullPipeline sie gezielt nach.
    let near = null, nd = Infinity;
    for (const k of sinks) { const d = pipeDist(prod, k); if (d < nd) { nd = d; near = k; } }
    if (near && pipeWorkPending(world, player.id, prod, near)) continue;
    // KOMPLETTE Pipeline in einem Zug legen — nicht ein Segment pro Runde, das mitten im Nichts
    // stehen bleibt. So ist die Förderkette Bohrturm/Pumpwerk → Lager IMMER durchgängig.
    if (planFullPipeline(world, player, prod, sinks, def, applyCommand)) return true;
  }
  return false;
}

// Legt die gesamte Leitungskette vom Produzenten zur nächsten passenden Senke entlang der direkten
// Linie (Segmente im Abstand PIPE_LINK_RANGE), soweit Erz reicht — der Rest folgt in der nächsten
// Runde. Garantiert, dass die Pipeline komplett bis zum Lager durchgezogen wird.
function planFullPipeline(world, player, prod, sinks, def, applyCommand) {
  let sink = null, sd = Infinity;
  for (const k of sinks) { const d = pipeDist(prod, k); if (d < sd) { sd = d; sink = k; } }
  if (!sink) return false;
  // EINE durchgehende Leitung entlang eines Pfades um Hindernisse (Klippen/Erz/Öl/Gebäude) herum —
  // statt einer starren Geraden, die an Hindernissen abreißt (und die KI sonst mit Parallelrohren
  // „umbaut" → Spinnennetz). Segmente im Abstand PIPE_LINK_RANGE, plus die letzte Pfadzelle an der
  // Senke, damit die Kette sicher anschließt.
  const path = pipePathTiles(world, player.id, prod, sink, def);
  if (!path || !path.length) return false;
  const cost = effectiveCost(world, player.id, def);
  const t = world.terrain;
  const stepN = Math.max(1, PIPE_LINK_RANGE);
  let built = false;
  const placeAt = (idx) => {
    const [tx, ty] = path[idx];
    if ((t.pipe && t.pipe[tIdx(t, tx, ty)] > 0) || existingOrPendingBuilding(world, player.id, 'pipe', tx, ty)) return true;
    if (!placeable(world, tx, ty, 1, def, player.id)) return true;
    if (!canAfford(player, cost)) return false;   // Erz alle → Rest in der nächsten Runde
    applyCommand(world, { type: 'build', building: 'pipe', tx, ty }, player.id);
    built = true;
    return true;
  };
  // Segmente im Raster PIPE_LINK_RANGE (Lücken ≤ Reichweite), inkl. produzentennaher Startzelle ...
  for (let i = 0; i < path.length - 1; i += stepN) if (!placeAt(i)) return built;
  // ... PLUS die allerletzte Pfadzelle an der Senke, damit die Kette sicher anschließt (Lücke ≤ Raster).
  if (path.length >= 2) placeAt(path.length - 1);
  return built;
}

// Kürzester Leitungspfad (BFS, 4er-Nachbarschaft) von der Produzenten-Fußfläche bis an die Senke,
// nur über leitungstaugliche Zellen (Wasser ok, aber keine Klippe/Erz/Öl/massives Gebäude). Liefert
// die Tile-Liste oder null, wenn keine Verbindung möglich ist.
function pipePathTiles(world, owner, prod, sink, def) {
  const t = world.terrain, W = t.w;
  const passable = (x, y) => {
    if (!inBounds(t, x, y)) return false;
    const i = tIdx(t, x, y);
    if (t.pipe && t.pipe[i] > 0) return true;                 // bestehende Leitung ist begehbar
    if (t.type[i] === TT.CLIFF) return false;                 // Leitung kann nicht durch Klippen
    if ((t.ore && t.ore[i] > 0) || (t.oil && t.oil[i] > 0)) return false;
    if (t.block && t.block[i] > 0) return false;              // massives Gebäude im Weg
    return true;                                              // Land ODER Wasser (Leitung ist waterOptional)
  };
  const inSink = (x, y) => x >= sink.tx - 1 && x <= sink.tx + sink.size && y >= sink.ty - 1 && y <= sink.ty + sink.size;
  const prev = new Map(); const q = [];
  for (let yy = -1; yy <= prod.size; yy++) for (let xx = -1; xx <= prod.size; xx++) {
    const x = prod.tx + xx, y = prod.ty + yy;
    if (passable(x, y)) { const k = y * W + x; if (!prev.has(k)) { prev.set(k, -1); q.push(k); } }
  }
  let qi = 0, goal = -1, iter = 0;
  while (qi < q.length && iter++ < 12000) {
    const k = q[qi++], x = k % W, y = (k / W) | 0;
    if (inSink(x, y)) { goal = k; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!passable(nx, ny)) continue;
      const nk = ny * W + nx;
      if (prev.has(nk)) continue;
      prev.set(nk, k); q.push(nk);
    }
  }
  if (goal < 0) return null;
  const path = [];
  for (let c = goal; c !== -1; c = prev.get(c)) path.push([c % W, (c / W) | 0]);
  path.reverse();
  return path;
}

function manageBridges(world, player, s, applyCommand) {
  if (!s.hq || constructionBusy(s) || buildingInProgress(s, 'bridge')) return false;
  // Deckel etwas höher als eine einzelne Querung (5–7 Zellen, diagonal länger), damit eine vollständige
  // Ufer-zu-Ufer-Brücke passt; durch die Erreichbarkeitsprüfung baut die KI ohnehin nur EINE Querung.
  if (s.bridges >= 14) return false;
  const vehicles = s.army.filter(u => u.domain === 'land' && u.category === 'vehicle');
  if (vehicles.length < 1 && s.vehicleArmy < 1) return false;   // erst Fahrzeuge, dann Brücken für sie
  const def = world.data.buildings.bridge;
  if (!def || !canAfford(player, effectiveCost(world, player.id, def))) return false;
  // Nur überbrücken, wenn der Gegner NICHT ohnehin über Land erreichbar ist (sonst keine Brücke nötig).
  const enemy = pickEnemyTarget(world, player);
  if (!enemy) return false;
  const from = { tx: Math.round(s.hq.tx + s.hq.size / 2), ty: Math.round(s.hq.ty + s.hq.size / 2) };
  const [gx, gy] = worldToTile(enemy.x, enemy.y);
  if (canReachTile(world.terrain, from.tx, from.ty, gx, gy, SLOPE_HEAVY, { heavy: true, category: 'vehicle' }, 5)) return false;
  // EINE durchgehende Querung planen: der zusammenhängende Wasserlauf auf der Linie HQ→Gegner.
  const span = planBridgeCrossing(world, from, gx, gy);
  if (!span || !span.length) return false;
  // Die ganze Spannweite auf einmal setzen — der Frontier-Bau (construction.js) zieht sie Ufer→Ufer
  // als zusammenhängende Brücke hoch, statt verstreute Einzelteile, die nie eine Querung ergeben.
  const t = world.terrain;
  let placed = 0;
  for (const [tx, ty] of span) {
    const i = tIdx(t, tx, ty);
    if (t.bridge && t.bridge[i] > 0) continue;
    if (!placeable(world, tx, ty, 1, def, player.id)) continue;
    if (!canAfford(player, effectiveCost(world, player.id, def))) break;
    applyCommand(world, { type: 'build', building: 'bridge', tx, ty }, player.id);
    placed++;
  }
  return placed > 0;
}

// Plant die Brückenquerung: den ersten echten Wasserlauf auf der Linie HQ→Gegner,
// aber als gerade orthogonale Ufer-zu-Ufer-Spannweite. Keine diagonalen Treppen.
function planBridgeCrossing(world, from, gx, gy) {
  const line = lineTiles(from.tx, from.ty, gx, gy);
  for (const [tx, ty] of line) {
    const span = bridgeSpanFromEntry(world, tx, ty);
    if (span) return span.cells;
  }
  return null;
}

function bridgeSpanFromEntry(world, ex, ey, maxLen = 30) {
  if (!isBridgeCandidateCell(world, ex, ey)) return null;
  const t = world.terrain;
  const bridgeAnchor = (x, y) => {
    if (!inBounds(t, x, y)) return false;
    const i = tIdx(t, x, y);
    if (t.bridge && t.bridge[i] > 0) return true;
    return !waterBlocksLand(t, i) && isPassable(t, 'land', x, y, 'vehicle');
  };
  const scan = (dx, dy) => {
    const cells = [];
    let x = ex, y = ey;
    while (inBounds(t, x, y) && cells.length < maxLen) {
      const i = tIdx(t, x, y);
      if (!waterBlocksLand(t, i) || !persistentWaterBlocksLand(t, i) || (t.bridge && t.bridge[i] > 0)) break;
      cells.push([x, y]);
      x += dx; y += dy;
    }
    if (!cells.length) return null;
    const before = [ex - dx, ey - dy];
    const after = [x, y];
    if (!bridgeAnchor(before[0], before[1]) || !bridgeAnchor(after[0], after[1])) return null;
    return { cells, dx, dy };
  };
  let best = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const span = scan(dx, dy);
    if (!span) continue;
    if (!best || span.cells.length < best.cells.length) best = span;
  }
  return best;
}

function manageAccessRoutes(world, player, s, applyCommand) {
  if (!s.hq || constructionBusy(s)) return false;
  const pressure = world.aiDirector?.pressure || 0;
  const landArmy = s.army.filter(u => u.domain === 'land');
  // Angriffsstraßen/-brücken zum Gegner sind für FAHRZEUGE da (Infanterie watet/klettert ohnehin) und
  // dürfen den Bau der ERSTEN Fabrik nicht verdrängen: Infrastruktur läuft im stepAi VOR manageBuild,
  // d. h. solange die KI Straßen legt, kommt die Fabrik nie dran (gemessen: Seiten mit 60+ Straßen, aber
  // ohne Fabrik → reine Infanterie). Erst ab einer Fabrik (= Fahrzeug-Siegpfad existiert) Routen bauen.
  if (s.factories < 1) return false;
  if (landArmy.length < (pressure > 0 ? 2 : 5) && s.vehicleArmy < 1) return false;
  const enemy = pickEnemyTarget(world, player, pressure > 0);
  if (!enemy) return false;
  // Route IMMER vom (unbeweglichen) HQ aus planen — sonst wandert die Linie mit der jeweils
  // nächsten Einheit und die KI verstreut Brückenpfeiler über viele Flussreihen, statt EINE
  // Überquerung fertigzustellen. Stabiler Ankerpunkt = eine durchgehende Brücke/Straße.
  const from = { tx: Math.round(s.hq.tx + s.hq.size / 2), ty: Math.round(s.hq.ty + s.hq.size / 2) };
  const [gx, gy] = worldToTile(enemy.x, enemy.y);
  if (canReachTile(world.terrain, from.tx, from.ty, gx, gy, SLOPE_HEAVY,
    { heavy: true, category: 'vehicle' }, 5)) return false;
  return planRouteInfrastructure(world, player, s, from, { tx: gx, ty: gy }, applyCommand, { preferRoad: true });
}

function constructionBusy(s) {
  // Infrastruktur (Straße/Brücke/Tunnel/Leitung) zählt NICHT als Bau-Throttle — sonst blockiert eine
  // gerade entstehende Route den restlichen Bau (und sich selbst).
  return s.buildings.filter(b => b.buildProgress < 1 && !INFRA_KINDS.has(b.kind)).length >= 2;
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
  // NUR über dauerhafte Gewässer (Fluss/See/Meer) brücken. Eine vorübergehende Überflutung
  // (Regen, Damm, Flutkanal) hebt zwar t.water, ist aber kein Fluss → sonst stellt die KI bei
  // jeder Pfütze im Gelände Brückenpfeiler ab. baseWater unterscheidet beides.
  return waterBlocksLand(t, i) && persistentWaterBlocksLand(t, i) && !(t.bridge && t.bridge[i] > 0);
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

// Welche Belagerungswaffe fehlt der Fahrzeugarmee gerade am dringendsten? Liefert den
// Einheitentyp oder null. Quote: ab 3 Fahrzeugen ≥1 Raketenwerfer (~20 %), ab 5 zusätzlich
// ≥1 Artillerie (~15 %). Raketenwerfer hat Vorrang (billiger, früher verfügbar).
function siegeDeficit(s) {
  const veh = s.units.filter(u => u.category === 'vehicle' && u.weapon);
  const n = veh.length;
  if (n < 3) return null;
  const rockets = veh.filter(u => u.kind === 'rocket_launcher').length;
  if (rockets < Math.max(1, Math.round(n * 0.20))) return 'rocket_launcher';
  // Artillerie ab 3 Fahrzeugen (vorher 4, davor 5): gemessen (coverage.js + econ-Diag) erreicht die
  // Fahrzeugarmee selbst mit der neuen Fahrzeug-Erzreserve oft nur 3 gleichzeitig Lebende, 4 nur
  // sporadisch → bei Schwelle 4 kam Artillerie auf vielen Seeds NIE vor. Bei n≥3 baut der Override
  // GENAU EINE Artillerie (Quote round(3·0.15)=0 → max(1,0)=1) nachdem die Raketenquote steht — also
  // kein Über-Belagern, nur die Garantie, dass der Typ vorkommt (Ziel C) und Turtling bricht.
  if (n >= 3) {
    const arty = veh.filter(u => u.kind === 'artillery').length;
    if (arty < Math.max(1, Math.round(n * 0.15))) return 'artillery';
  }
  return null;
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
  // Fahrzeug-Erzreserve AUCH UNTER DRUCK: in frozen/Dauerdruck-Partien rampt pressure hoch →
  // die obige (reserve nur bei pressure<2) Sperre fällt weg, und billige Infanterie (100–200 Erz)
  // saugt die Kasse leer, bevor sich die 460+ Erz für ein Kampffahrzeug ansammeln. Folge (gemessen
  // via coverage.js): vehicleArmy bleibt oft 0–3, Artillerie/Belagerung kommen NIE vor (Ziel C) und
  // die Angriffe verpuffen als reiner Fußvolk-Schwarm. Solange eine Fabrik steht und die
  // Fahrzeugarmee unter einem Mindestkern liegt, hält affordInfantry zusätzlich die Kosten des
  // nächsten Panzers zurück → Erz sammelt sich für Fahrzeuge an. Die FABRIK selbst nutzt weiter das
  // lockerere afford() (sonst würde die Reserve auch das Fahrzeug blockieren). Kein world.rng()
  // hier → RNG-Stream/brittle-Tests unverändert.
  const vehReserve = (s.factories >= 1 && s.vehicleArmy < 4)
    ? (effectiveCost(world, player.id, world.data.units.tank).ore || 0) : 0;
  const affordInfantry = (kind) => {
    const cost = effectiveCost(world, player.id, world.data.units[kind]);
    if (!canAfford(player, cost)) return false;
    return (player.resources.ore - (cost.ore || 0)) >= reserve + vehReserve;
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

  // LKW sicherstellen — bei kritischem Logistikmangel hat Wiederaufbau Vorrang vor Armee (ohne Reserve).
  const trucks = s.units.filter(u => u.kind === 'truck').length;
  const wantTrucks = Math.min(4, 2 + s.refineries);
  if (trucks < wantTrucks && s.refineries >= 1) {
    const fac = s.buildings.find(b => b.kind === 'factory' && b.buildProgress >= 1);
    if (fac && fac.queue.length === 0 && canAfford(player, effectiveCost(world, player.id, world.data.units.truck)))
      applyCommand(world, { type: 'produce', building: fac.id, kind: 'truck' }, player.id);
    if (trucks < 2 && s.airbases < 1 && s.shipyards < 1) return; // Wirtschaftsnotstand: bis Spezialproduktion steht, Credits sparen
  }
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
    let kind = r < 0.36 ? 'tank' : r < 0.55 ? 'flak_track' : r < 0.74 ? 'rocket_launcher' : r < 0.88 ? 'scout' : 'artillery';
    // Belagerungs-Garantie: ohne sie verdrängen billigere Würfe (Panzer/Flak/Spähwagen) die
    // teuren Raketenwerfer/Artillerie aus der Mischung (unbezahlbare Würfe bauen nichts → die
    // Armee füllt sich mit Günstigem bis zum Cap). Ein deterministischer Quoten-Override
    // erzwingt Belagerungswaffen, sobald sie bezahlbar sind — Coverage-Ziel C + bricht Turtling.
    // Der world.rng()-Aufruf bleibt erhalten → RNG-Stream/Tests unverändert.
    const siege = siegeDeficit(s);
    if (siege && afford(siege)) {
      kind = siege;
    } else if (siege && s.vehicleArmy >= 5) {
      // Belagerungs-/Panzer-Defizit, aber gerade unbezahlbar (gemessen via diag_arty: Armeen wuchsen
      // auf 13 Fahrzeuge, aber NUR Spähwagen(240)+Flak(360) — Erz floss so schnell in Billiges, dass
      // es nie die 480–520 für Rakete/Artillerie erreichte). Bei TRAGFÄHIGER Kernarmee (≥5 Fahrzeuge)
      // diesen Tick AUSSETZEN und ansparen statt billig kaufen → Erz klettert auf die Belagerungs-
      // kosten, der Typ wird gebaut. WICHTIG: nur ab 5 Fahrzeugen — früher würde das Aussetzen die
      // Armee ausdünnen und kostete in match-sim den einen Sieg (1/6→0/6). Ab 5 ist genug Masse da,
      // das Ansparen ist decisiveness-neutral. world.rng() oben bleibt → RNG-Stream unverändert.
      continue;
    }
    if (afford(kind)) applyCommand(world, { type: 'produce', building: fac.id, kind }, player.id);
  }

  // Marine: Auf Küstenkarten eigener Siegzweig; wird vor Luft gefüllt.
  for (const sy of shipyards) {
    if (!s.coastal && player.faction !== 'FLG') continue;
    if (sy.queue.length >= 1 || navalUnits >= NAVY_TARGET) continue;
    if (s.vehicleArmy < 3 && pressure < 2) continue;
    const r = world.rng();
    // Zerstörer als GARANTIERTES zweites Schiff: ohne die Garantie blieb die Marine in kurzen Partien
    // meist bei 1–2 Spähbooten stehen (rng würfelte den teureren Zerstörer/U-Boot selten) → destroyer/
    // submarine kamen NIE vor (Coverage-Ziel C, gemessen coverage.js: nur patrol_boat). r wird weiter
    // gelesen → RNG-Stream/brittle-Tests unverändert; balance-neutral (Zerstörer ist der reguläre
    // Marine-Kern nach dem Spähboot).
    const kind = navalUnits === 0 ? 'patrol_boat'
      : navalUnits === 1 ? 'destroyer'
      : (r < 0.38 ? 'patrol_boat' : r < 0.68 ? 'destroyer' : r < 0.84 ? 'submarine' : 'underwater_drone');
    if (afford(kind)) applyCommand(world, { type: 'produce', building: sy.id, kind }, player.id);
  }

  // HLX-Schwarmdoktrin: mehr Panzerabwehr-Infanterie (at_soldier, vs.vehicle 1.3) gegen Armee mit viel Panzer.
  const riflemanShare = player.faction === 'HLX' ? 0.5 : 0.7;
  for (const bar of barracks) {
    if (bar.queue.length >= (pressure > 2 ? 3 : 2)) continue;
    if (infantryArmy >= INFANTRY_TARGET && pressure < 4) continue;   // Schwarm begrenzen (nicht 100+ Riflemen)
    const r = world.rng();
    const kind = s.enemyAir && r > 0.72 ? 'aa_soldier' : r < riflemanShare ? 'rifleman' : 'at_soldier';
    if (affordInfantry(kind)) applyCommand(world, { type: 'produce', building: bar.id, kind }, player.id);
  }

  // Luft-Doktrin: spät und begrenzt. HLX darf etwas mehr, aber die Grundkosten bleiben hoch.
  // Luft-Produktionsschwelle gesenkt parallel zur Luftbasis (vehicleArmy 5/6→3/4, küstennahe Marine-
  // Vorbedingung von 2–3 Schiffen → 1 bzw. pressure≥2 statt ≥4). Vorher unerreichbar → Luftbasis stand
  // leer (coverage.js Ziel C). Luft bleibt durch afford()/AIR_TARGET begrenzt und kommt erst nach einem
  // Fahrzeugkern → kein Verdrängen des Siegpfads.
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

// Abdeckungs-/Festigungs-Reserve (läuft NUR, wenn die reguläre Build-Order in dieser Runde nichts
// gebaut hat → Wirtschaft steht, kein dringenderes Gebäude offen). Errichtet EIN noch fehlendes
// statisches Verteidigungs-/Wirtschaftsgebäude aus dem BUILD_ORDER-Schwanz (turret/flak_turret/
// sam_site/solar_plant/depot/sonar), das die reguläre Liste in kurzen Partien fast nie erreicht
// (frühere Wirtschafts-Einträge triggern immer wieder den 1-Gebäude-pro-Runde-Slot). Holt diese
// Typen zuverlässig ins Spiel (Coverage-Ziel C; eindeutige Verteidigungssilhouetten Ziel F) OHNE den
// Siegpfad zu gefährden: streng erz-überschuss-gated + tragfähige Armee + nie unter Endspieldruck +
// eigener Bau-Throttle. KEIN world.rng() → RNG-Stream und brittle terrain-/wave-Smoke-Tests unberührt.
// flak_turret/sam_site/sonar zuerst: ihre regulären BUILD_ORDER-Bedingungen verlangen enemyAir/
// enemySubs, was in KI-vs-KI-Partien (kaum jemand baut Luft/U-Boote) praktisch NIE eintritt → diese
// Typen sind in der regulären Liste DEADLOCKED und kamen real nie vor. Der proaktive Filler übernimmt
// sie (billige Luftabwehr/Sensorik ist realistische Doktrin — der Gegner KANN Luft bauen). solar/depot/
// turret kann die reguläre Liste selbst erreichen → niedrigere Priorität.
const COVERAGE_FILL_BUILDINGS = ['flak_turret', 'sam_site', 'sonar', 'solar_plant', 'depot', 'turret'];
function manageDefensiveCoverage(world, player, s, applyCommand) {
  if (!s.hq) return;
  const pressure = world.aiDirector?.pressure || 0;
  if (pressure >= 2) return;                            // ab Endspieldruck fließt Erz in die Armee, nicht in Filler
  if (s.vehicleArmy < 3) return;                        // erst ein tragfähiger Fahrzeugkern, dann Festigung
  // GEMESSEN (coverage.js 2026-06-16): den Filler stattdessen auf army.length≥4 zu öffnen ließ ihn jeden
  // Tick aus dem Erz-Überschuss bauen und würgte trotz Tank-Puffer die Kampffahrzeug-Produktion komplett
  // ab (tank/artillery fielen auf 0, Einheiten-Abdeckung 56%→40%). Darum bewusst beim engen, stehenden
  // Fahrzeugkern-Gate bleiben — die selten gebauten Verteidigungstypen bleiben Restlücke (Ziel C), aber
  // der Siegpfad ist unangetastet.
  const underConstruction = s.buildings.filter(b => b.buildProgress < 1 && !INFRA_KINDS.has(b.kind));
  if (underConstruction.length >= 2) return;
  const have = new Set(s.buildings.map(b => b.kind));
  for (const kind of COVERAGE_FILL_BUILDINGS) {
    if (have.has(kind)) continue;
    const def = world.data.buildings[kind];
    if (!def) continue;
    if (kind === 'sonar' && !(s.coastal && s.shipyards >= 1)) continue;  // Sonar nur am Wasser sinnvoll
    const cost = effectiveCost(world, player.id, def);
    if (!canAfford(player, cost)) continue;
    // Armee-Puffer wahren: nach dem Bau müssen noch die Kosten EINES Kampffahrzeugs übrig bleiben, damit
    // der Filler den Fahrzeugnachschub nicht abwürgt (jeder Typ wird ohnehin nur EINMAL gebaut → die
    // gesamte Lebenszeit-Umleitung ist auf wenige Gebäude begrenzt).
    const tankOre = effectiveCost(world, player.id, world.data.units.tank).ore || 0;
    if ((player.resources.ore - (cost.ore || 0)) < tankOre) continue;
    let spot;
    if (def.requiresWater) spot = pickCoastalSpot(world, player, s, def.size || 1, def);
    else if (def.role === 'fortification') spot = pickDefensiveSpot(world, player, s, def);
    else spot = pickBuildSpot(world, s.hq, def.size || 1, def);
    if (!spot) continue;
    if (prepareBuildRoute(world, player, s, spot, def, applyCommand)) return;
    applyCommand(world, { type: 'build', building: kind, tx: spot[0], ty: spot[1] }, player.id);
    return;
  }
}

// Bergungs-/Spezialdoktrin: stellt ein Bergefahrzeug und einen Flugabwehrschützen bereit
// (beide kamen real NIE vor → tote Bauoptionen; coverage.js Ziel C) und setzt das Bergefahrzeug ECHT
// ein, um verlassene Fahrzeuge zu bergen (25%-HP-Fahrzeug gratis statt Dauerersatz). Läuft NACH
// manageProduction, damit aa_soldier/tractor erst slotten, wenn die Hauptarmee ihr Soll erreicht
// hat (freier Queue-Slot) → kein Verdrängen des Siegpfads. KEIN world.rng() → RNG-Stream und die
// brittle terrain-/wave-Smoke-Tests bleiben unberührt.
function manageRecovery(world, player, s, applyCommand) {
  const pressure = world.aiDirector?.pressure || 0;
  const cap = pressure > 2 ? 3 : 2;
  const hasKind = (k) => s.units.some(u => u.kind === k)
    || s.buildings.some(b => (b.queue || []).some(q => q.kind === k));
  const free = (kind) => s.buildings.find(b => b.buildProgress >= 1 && b.kind === kind && b.queue.length < cap);
  const can = (k) => world.data.units[k] && canAfford(player, effectiveCost(world, player.id, world.data.units[k]));

  // Flugabwehr-Schütze: kleine proaktive Luftverteidigung, sobald eine Infanteriebasis steht
  // (nicht erst wenn Feindluft sichtbar — der Gegner KANN Luft bauen, AA ist billige Versicherung).
  const infArmy = s.army.filter(u => u.category === 'infantry' && !u.abilities.includes('harvest')).length;
  if (!hasKind('aa_soldier') && infArmy >= 4 && can('aa_soldier')) {
    const bar = free('barracks');
    if (bar) { applyCommand(world, { type: 'produce', building: bar.id, kind: 'aa_soldier' }, player.id); return; }
  }

  // Bergefahrzeug: eines, sobald die Fahrzeugarmee trägt (tractor hat kein weapon → zählt nicht
  // gegen VEHICLE_TARGET, verdrängt also keine Kampffahrzeuge).
  if (!hasKind('tractor') && s.vehicleArmy >= 4 && can('tractor')) {
    const fac = free('factory');
    if (fac) { applyCommand(world, { type: 'produce', building: fac.id, kind: 'tractor' }, player.id); return; }
  }

  // Vorhandene Bergefahrzeuge auf nahe verlassene Fahrzeuge ansetzen (nur im Umkreis der eigenen Basis,
  // kein Selbstmord-Trip ins Feindgebiet). Verlassene Fahrzeuge sind owner -1 (neutral) → frei bergbar.
  const tractors = s.units.filter(u => u.kind === 'tractor' && u.abilities?.includes('tow') && !u.abandoned);
  if (!tractors.length || !s.hq) return;
  let wreck = null, bestD = 70 * 70;
  for (const e of world.entities.values()) {
    if (!e.abandoned || e.dead || e.domain !== 'land') continue;
    const d = (e.x - s.hq.x) ** 2 + (e.y - s.hq.y) ** 2;
    if (d < bestD) { bestD = d; wreck = e; }
  }
  if (!wreck) return;
  const idleTr = tractors.filter(u => u.order?.type !== 'tow');
  if (idleTr.length) applyCommand(world, { type: 'tow', targetId: wreck.id, units: idleTr.map(u => u.id) }, player.id);
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
  let waveNeed = pressure > 0 ? Math.max(minWave, Math.min(player.ai.waveSize, 6 - Math.min(4, pressure))) : player.ai.waveSize;
  // STRATEGIE/DOKTRIN beeinflusst Größe & Zeitpunkt der Welle (nur solange kein Endspieldruck — unter
  // Druck entscheidet der Director ohnehin). Gibt Partien wechselnde Angriffsmuster.
  const doc = player.ai.doctrine || 'combined';
  if (pressure < 2) {
    if (doc === 'rush') waveNeed = Math.max(2, Math.floor(waveNeed * 0.55));        // früher Sturm
    else if (doc === 'siege') waveNeed += 2;                                         // etwas länger aufbauen
  }
  // Nacht-Doktrin: Hauptwelle bevorzugt nachts; Luftschlag: erst losschlagen, wenn Flieger da sind.
  // Holds nur bei sehr geringem Druck — sobald die Partie drängt, wird normal angegriffen (sonst Patt).
  let doctrineHold = false;
  if (pressure < 2) {
    if (doc === 'night' && (world.env?.daylight ?? 1) > 0.45) doctrineHold = true;
    else if (doc === 'airstrike' && s.airbases >= 1 && air.length < 1) doctrineHold = true;
  }
  const regroup = player.ai.attackTimer > regroupLimit && strike.length >= minWave;
  const regularNeed = Math.max(minWave, Math.min(waveNeed, pressure > 0 ? 3 : 5));
  const regularPulse = strike.length >= regularNeed && player.ai.attackTimer > Math.max(12, Math.floor(regroupLimit * 0.45));
  const vehicleReady = s.factories < 1 || vehicleStrike.length >= (pressure >= 4 ? 1 : 2) || pressure >= 6;
  if (!doctrineHold && vehicleReady && (strike.length >= waveNeed || regroup || regularPulse) && player.ai.attackTimer > 4) {
    const enemy = pickEnemyTarget(world, player, pressure > 0, doc === 'raid');
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
  // Alte Harvester bleiben für Saves kompatibel; neue Erzlogistik läuft über LKWs.
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

function pickEnemyTarget(world, player, decisive = false, raid = false) {
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
    // Raid-Doktrin: greift die VERSORGUNG an — Pipelines, Bohrtürme, Pumpwerke, Depots zuerst.
    const supply = e.etype === 'building' && (e.def?.pipe || e.def?.pipelineResource || e.def?.pump || e.def?.resourceDepot || e.kind === 'oil_derrick');
    // Begehbare Infrastruktur (Straße/Brücke/Tunnel/Leitung) und Befestigungen (Wall/Graben) sind als
    // Angriffsziel wertlos — eine zerstörte Straße tut dem Gegner kaum weh, bindet aber die Armee fernab
    // der eigentlichen Ziele. Stark depriorisieren, damit die KI Produktion/Wirtschaft/Armee angreift.
    const lowValue = e.etype === 'building'
      && (e.def?.roadBuilt || e.def?.bridges || e.def?.tunnels || e.def?.pipe || e.def?.role === 'fortification');
    let prio = e.etype === 'building'
      ? e.kind === 'hq' ? (decisive ? 0.25 : 0.5)
        : production ? (decisive ? 0.45 : 0.8)
        : decisive ? 0.9 : 1.0
      : decisive ? 1.8 : 1.2;
    if (e.etype === 'building' && buildingTouchesFlood(world.terrain, e)) prio *= 4;
    if (lowValue) prio *= 12;            // Straße/Brücke/Leitung/Wall fast nie ansteuern
    if (raid && supply) prio *= 0.25;   // Versorgungsziele stark bevorzugen
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
    { heavy: true, category: lead.category }, 1.25)) return false;
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
  let roadsBuilt = 0;
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
    if (action) {
      if (action.type === 'build' && action.kind === 'road') {
        // DURCHGEHENDE STRASSE in EINEM Zug: ALLE Routenzellen der Reihe nach belegen, bis das Erz
        // alle ist (Rest folgt, sobald dieses Stück steht) — statt nur EINER Kachel pro Planungsrunde,
        // was wie verstreute Einzelfelder aussah. routeWorkPending verhindert Doppelplanung.
        if (issueRouteAction(world, player, action, applyCommand)) {
          if (++roadsBuilt >= AI_ROUTE_MAX_CELLS) break;
        } else break;                      // Erz/Platz alle → aufhören
      } else if (issueRouteAction(world, player, action, applyCommand)) {
        // Terraform (Steilhang einebnen) u. Ä.: Einzelaktion, Runde danach beenden.
        player.ai.routePlanTick = world.tick;
        return true;
      }
    }
    if (world.terrain.type[i] !== TT.CLIFF && !waterBlocksLand(world.terrain, i)) prev = { tx, ty };
  }
  if (roadsBuilt > 0) { player.ai.routePlanTick = world.tick; return true; }
  return false;
}

// Eine zusammenhängende Wasserspanne (Fluss) auf der Route in EINEM Zug überbrücken: ab der ersten
// Wasserzelle alle folgenden Wasserzellen als Brücke setzen, soweit das Erz reicht (Rest folgt in
// den nächsten Runden). So entsteht eine durchgehende Brücke statt verstreuter Einzelpfeiler.
function planBridgeSpan(world, player, cells, n, applyCommand) {
  const t = world.terrain;
  const def = world.data.buildings.bridge;
  if (!def) return false;
  const [ex, ey] = cells[n];
  // KÜRZESTE ORTHOGONALE Überquerung ab der Eintrittszelle (x- ODER y-Richtung). Wichtig: eine
  // diagonale Brückentreppe ist für Fahrzeuge NICHT passierbar (A* schneidet keine Wasser-Ecken),
  // darum bauen wir eine gerade, orthogonal zusammenhängende Spanne quer durch den Fluss.
  const span = bridgeSpanFromEntry(world, ex, ey);
  if (!span) return false;
  const cost = effectiveCost(world, player.id, def);
  let built = false;
  for (const [x, y] of span.cells) {
    const i = tIdx(t, x, y);
    if (!(t.bridge && t.bridge[i] > 0) && !existingOrPendingBuilding(world, player.id, 'bridge', x, y)
      && placeable(world, x, y, 1, def, player.id)) {
      if (!canAfford(player, cost)) break;                     // Erz alle → Rest in der nächsten Runde
      applyCommand(world, { type: 'build', building: 'bridge', tx: x, ty: y }, player.id);
      built = true;
    }
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
    return null;
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

// Ist von diesem Produzenten bereits eine Leitung IM BAU (buildProgress<1) im Korridor zur Senke?
// Verhindert, dass die KI Runde für Runde neue Parallelleitungen daneben legt (Spinnennetz).
function pipeWorkPending(world, owner, prod, sink) {
  const ax = prod.tx + prod.size / 2, ay = prod.ty + prod.size / 2;
  const bx = sink.tx + sink.size / 2, by = sink.ty + sink.size / 2;
  for (const e of world.entities.values()) {
    if (e.owner !== owner || e.dead || e.etype !== 'building' || e.kind !== 'pipe' || e.buildProgress >= 1) continue;
    if (nearLine(e.tx, e.ty, ax, ay, bx, by, 3)) return true;
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

function buildingTouchesFlood(t, e) {
  const size = e.size || 1;
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const tx = e.tx + xx, ty = e.ty + yy;
    if (inBounds(t, tx, ty) && waterBlocksLand(t, tIdx(t, tx, ty))) return true;
  }
  return false;
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

// Pumpwerk ans Süßwasser: findet (per Ringsuche ab HQ) das nächste Wasser, auf dem ein Pumpwerk
// platzierbar ist — auch fernab der Basis (remoteBuild). placeable() lässt dank `freshWater`-Flag nur
// Fluss/See zu (kein Meer), also liefert die Suche automatisch Süßwasser-Standorte.
function findFreshWaterPumpSpot(world, owner, hq, size, def) {
  if (!hq) return null;
  const t = world.terrain;
  const cx = Math.round(hq.tx + hq.size / 2), cy = Math.round(hq.ty + hq.size / 2);
  for (let r = 4; r <= 64; r += 2) {                       // wachsender Ring → nächstgelegenes Meer zuerst
    let best = null, bestD = Infinity;
    const lo = -r, hi = r;
    for (let dy = lo; dy <= hi; dy++) for (let dx = lo; dx <= hi; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // nur der Ringrand
      const tx = cx + dx, ty = cy + dy;
      if (!inBounds(t, tx, ty) || !inBounds(t, tx + size - 1, ty + size - 1)) continue;
      if (!placeable(world, tx, ty, size, def, owner)) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = [tx, ty]; }
    }
    if (best) return best;
  }
  return null;
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
