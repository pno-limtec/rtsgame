// Bagger-System (Phase 15): Gebäude bauen sich nicht mehr von selbst — ein freier
// Bagger fährt zur Baustelle und errichtet das Gebäude nach und nach.
// Dasselbe gilt für Terraforming-Aufträge (Aufschütten/Abgraben): der Spieler markiert eine
// Zelle, ein freier Bautrupp fährt hin und übernimmt die Arbeit.
//
// Läuft in sim.js NACH stepMovement (frische Positionen). Baustellen tragen
// `_builderNear = world.tick`, das stepProduction im Folge-Tick als „Arbeiter vor Ort" liest.
import {
  BUILDER_WADE_DEPTH, DT, CONSTRUCT_RANGE, TERRA_JOB_DELTA, TERRA_JOB_RATE, TERRA_LOWER_YIELD,
} from '../constants.js';
import { TT, tileToWorld, applyHeightDelta, wakeWaterAround, tIdx, inBounds, isPassable } from '../terrain.js';
import { addResource, canPlaceBuilding, hasResourceDepot, spawnBuilding } from '../world.js';
import { setMoveGoal, stopMove } from './movement.js';

let _jid = 1;

export function setNextTerraJobId(id) {
  const n = Math.max(1, Math.floor(Number(id) || 1));
  _jid = n;
}

// Terraforming-Auftrag einreihen (dir +1 = aufschütten, −1 = abgraben). Kosten zahlt applyCommand.
export function addTerraJob(world, owner, tx, ty, dir) {
  if (!world.terraJobs) world.terraJobs = [];
  const job = { id: _jid++, owner, tx, ty, dir: dir > 0 ? 1 : -1, applied: 0 };
  assignEarthPile(world, job, tx, ty);
  world.terraJobs.push(job);
}

const isBuilder = (e) => e.kind === 'builder';
const PILE_KINDS = new Set(['earth_pile', 'ore_pile']);
const pileResource = (pile) => pile?.kind === 'ore_pile' ? 'ore' : 'materials';
const isWorker = (e) => e.etype === 'unit' && !e.dead && e.domain === 'land'
  && (isBuilder(e) || e.abilities?.includes('haul') || e.abilities?.includes('harvest'));
const canBuildSite = (w) => isBuilder(w);
const canTerraform = (w) => isBuilder(w);
const isFree = (e) => e.order.type === 'idle' || e.order.type === 'guard';
const canHaulPile = (u, pile) => u.kind === 'truck' || (pileResource(pile) === 'ore' && u.abilities?.includes('harvest'));
const builderRole = (w) => w.resourceRole === 'materials' ? 'build' : w.resourceRole;

// Liniengebäude (per Linie gezogen): bauen sich von den Enden her durchgehend nach innen.
const isLineInfra = (def) => !!(def && (def.roadBuilt || def.bridges || def.tunnels || def.pipe || def.role === 'fortification'));
const FRONTIER_N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Für jede Linien-Infrastruktur je Besitzer die aktuell baubaren Endzellen ermitteln: eine Zelle ist
// „Bauschnitt-Ende", wenn sie höchstens EINEN noch unfertigen Linien-Nachbarn (8er) hat. So entsteht
// ein zusammenhängend wachsender Bauabschnitt statt verstreuter Einzelteile. Geschlossene Ringe ohne
// Ende fallen auf „alle baubar" zurück (kein Deadlock).
function computeLineFrontiers(world, sites) {
  const t = world.terrain;
  const byOwner = new Map();
  for (const s of sites) {
    if (!isLineInfra(s.def)) continue;
    let set = byOwner.get(s.owner); if (!set) byOwner.set(s.owner, set = new Set());
    set.add(tIdx(t, s.tx, s.ty));
  }
  const frontiers = new Map();
  for (const [owner, set] of byOwner) {
    const front = new Set();
    for (const i of set) {
      const gx = i % t.w, gy = (i / t.w) | 0;
      let n = 0;
      for (const [dx, dy] of FRONTIER_N8) if (set.has((gy + dy) * t.w + (gx + dx))) n++;
      if (n <= 1) front.add(i);
    }
    if (front.size === 0) for (const i of set) front.add(i); // Ring/Knoten → kein Deadlock
    frontiers.set(owner, front);
  }
  return frontiers;
}

export function stepConstruction(world) {
  const jobs = world.terraJobs || (world.terraJobs = []);
  for (const s of world.entities.values()) {
    if (s.etype === 'building' && !s.dead && s.buildProgress < 1 && needsPile(s) && !s.earthPileId) assignEarthPile(world, s, s.tx, s.ty);
  }

  // Aufgaben sammeln: unfertige Gebäude + offene Terraform-Aufträge, je Besitzer.
  const sites = [];
  for (const e of world.entities.values()) {
    if (e.etype === 'building' && !e.dead && e.buildProgress < 1 && e.def.buildTime) sites.push(e);
  }

  // Linien-Infrastruktur (Straße/Brücke/Leitung/Wall/Graben/Tunnel) wird DURCHGEHEND von den Enden
  // her gebaut, nicht in der Mitte verstreut: nur die Endzellen einer noch unfertigen Linie sind
  // gerade baubar (≤1 unfertiger Linien-Nachbar). So wächst ein zusammenhängender Bauschnitt nach
  // außen, der fertige Teil ist sofort befahrbar. Ringe/Knoten ohne Ende → Fallback: alle baubar.
  const frontierByOwner = computeLineFrontiers(world, sites);
  const buildableNow = (s) => {
    if (!isLineInfra(s.def)) return true;
    const front = frontierByOwner.get(s.owner);
    return !front || front.has(tIdx(world.terrain, s.tx, s.ty));
  };

  // Bereits vergebene Aufgaben ermitteln (lebende Arbeiter mit gültigem Auftrag).
  const claimedSites = new Set(), claimedJobs = new Set();
  const workersByOwner = new Map();
  for (const e of world.entities.values()) {
    if (!isWorker(e)) continue;
    let l = workersByOwner.get(e.owner); if (!l) workersByOwner.set(e.owner, l = []);
    l.push(e);
    if (e.order.type === 'construct') {
      const s = world.entities.get(e.order.site);
      if (s && !s.dead && s.buildProgress < 1) claimedSites.add(s.id);
      else e.order = { type: 'idle' }; // Auftrag erledigt/Baustelle weg → wieder frei
    } else if (e.order.type === 'terra') {
      const j = jobs.find(jj => jj.id === e.order.job);
      if (j) claimedJobs.add(j.id);
      else e.order = { type: 'idle' };
    } else if (e.order.type === 'haul_pile') {
      const p = world.entities.get(e.order.pile);
      if (p && !p.dead && ((p.amount || 0) > 0 || (e.order.state === 'toDepot' && (e.cargo || 0) > 0))) claimedSites.add(p.id);
      else e.order = { type: 'idle' };
    }
  }

  // Unbesetzte Aufgaben an die nächsten freien Arbeiter vergeben.
  for (const s of sites) {
    if (claimedSites.has(s.id)) continue;
    if (!buildableNow(s)) continue;   // Linie nur an ihrem aktuellen Bauschnitt (Ende) weiterbauen
    // Bevorzugt der Bau-Bagger; NOTFALL-RESERVE: ist kein anderer Bauarbeiter mehr am
    // Leben, springt auch der Erz-Bagger ein — sonst Deadlock (Fabrik unfertig → kein
    // Ersatz-Bagger baubar → Wirtschaft steht für immer; in KI-Matches verifiziert).
    const w = nearestFree(workersByOwner.get(s.owner), s.x, s.y, w => canBuildSite(w, s) && builderRole(w) !== 'ore', w => builderRole(w) === 'build')
      || nearestFree(workersByOwner.get(s.owner), s.x, s.y, w => canBuildSite(w, s), null,
        w => isFree(w) || w.order.type === 'harvest');   // Mining unterbrechen — Baustelle geht vor
    if (!w) continue;
    w.order = { type: 'construct', site: s.id }; w.target = null;
    {
      const [ax, ay] = buildingAccessPoint(world, w, s);
      setMoveGoal(world, w, ax, ay);
    }
    claimedSites.add(s.id);
  }
  for (const j of jobs) {
    if (claimedJobs.has(j.id)) continue;
    const [jx, jy] = tileToWorld(j.tx, j.ty);
    const w = nearestFree(workersByOwner.get(j.owner), jx, jy, w => canTerraform(w) && builderRole(w) !== 'ore', w => builderRole(w) === 'earth');
    if (!w) continue;
    w.order = { type: 'terra', job: j.id }; w.target = null;
    setMoveGoal(world, w, jx, jy);
    claimedJobs.add(j.id);
  }

  assignTruckHauling(world, workersByOwner);

  // Arbeit ausführen: Arbeiter in Reichweite stempeln die Baustelle bzw. heben/schütten die Zelle.
  for (const list of workersByOwner.values()) for (const w of list) {
    if (w.order.type === 'construct') {
      const s = world.entities.get(w.order.site);
      if (!s) { w.order = { type: 'idle' }; w._conT = 0; continue; }
      const range = (s.size || 1) + CONSTRUCT_RANGE;
      if (Math.hypot(s.x - w.x, s.y - w.y) <= range) {
        stopMove(w);
        w._conT = 0;
        s._builderNear = world.tick;        // stepProduction lässt den Bau nur damit voranschreiten
        world.events.push({ type: 'dig', x: w.x, y: w.y, owner: w.owner });
      } else {
        if (!w.moveTarget) {
          const [ax, ay] = buildingAccessPoint(world, w, s);
          setMoveGoal(world, w, ax, ay);
        }
        // UNERREICHBARE BAUSTELLE: kommt der Arbeiter 45 s lang nicht an (Fluss/Steilhang/
        // zugebaut), wird die Baustelle abgebrochen und größtenteils erstattet — sonst hängt
        // die gesamte Bauwirtschaft für immer an einem Geisterprojekt (KI-Deadlock, verifiziert).
        w._conT = (w._conT || 0) + DT;
        if (w._conT > 45 && s.buildProgress <= 0.01) {
          const p = world.players.find(pp => pp.id === s.owner);
          if (p && s.def.cost) for (const [k, v] of Object.entries(s.def.cost)) p.resources[k] = (p.resources[k] || 0) + Math.round(v * 0.8);
          s.dead = true; s.hp = 0;          // cleanup räumt Sperren/Fortifikation auf
          w.order = { type: 'idle' }; w._conT = 0;
          world.events.push({ type: 'site_cancel', x: s.x, y: s.y, owner: s.owner, kind: s.kind });
        }
      }
    } else if (w.order.type === 'terra') {
      const j = jobs.find(jj => jj.id === w.order.job);
      if (!j) { w.order = { type: 'idle' }; continue; }
      const [jx, jy] = tileToWorld(j.tx, j.ty);
      if (Math.hypot(jx - w.x, jy - w.y) <= CONSTRUCT_RANGE + 1) {
        stopMove(w);
        const t = world.terrain;
        if (!inBounds(t, j.tx, j.ty)) { finishJob(world, jobs, j, w); continue; }
        const stepAmt = Math.min(TERRA_JOB_RATE * DT, TERRA_JOB_DELTA - Math.abs(j.applied));
        j.applied += stepAmt * j.dir;
        world.events.push({ type: 'dig', x: w.x, y: w.y, owner: w.owner });
        if (Math.abs(j.applied) >= TERRA_JOB_DELTA - 1e-6) finishJob(world, jobs, j, w);
      } else if (!w.moveTarget) setMoveGoal(world, w, jx, jy);
    } else if (w.order.type === 'haul_pile') {
      stepTruckHaul(world, w);
    }
  }
}

function finishJob(world, jobs, j, worker) {
  jobs.splice(jobs.indexOf(j), 1);
  worker.order = { type: 'idle' };
  const t = world.terrain;
  if (inBounds(t, j.tx, j.ty)) {
    applyHeightDelta(t, tIdx(t, j.tx, j.ty), TERRA_JOB_DELTA * j.dir, true);
    wakeWaterAround(t, j.tx, j.ty, 1);  // Erst der fertige Auftrag beeinflusst Wasser, Pathing und Kollision.
  }
  // Abgraben fördert Erde (Baumaterial) zutage.
  if (j.dir < 0) {
    fillPile(world, j.earthPileId, TERRA_LOWER_YIELD);
  }
  world.events.push({ type: 'terra_done', x: j.tx * 2 + 1, y: j.ty * 2 + 1, owner: j.owner });
}

export function assignEarthPile(world, site, tx, ty) {
  return assignResourcePile(world, site, tx, ty, 'earth_pile', 'earthPileId', true);
}

export function assignOrePile(world, site, tx, ty) {
  return assignResourcePile(world, site, tx, ty, 'ore_pile', 'orePileId', false);
}

function assignResourcePile(world, site, tx, ty, kind, idKey, preferAwayFromBase) {
  const def = world.data.buildings[kind];
  if (!def) return null;
  // EIN Haufen je Arbeitsbereich: existiert in der Nähe schon ein eigener Haufen, wird er
  // wiederverwendet. Erde bleibt an Baustellen gebündelt, Erz an der Abbaugrube.
  const reuseRange = kind === 'ore_pile' ? 7 : 14;
  for (const e of world.entities.values()) {
    if (e.kind !== kind || e.owner !== site.owner || e.dead) continue;
    if (Math.max(Math.abs(e.tx - tx), Math.abs(e.ty - ty)) <= reuseRange) {
      site[idKey] = e.id;
      if (idKey === 'earthPileId') { site.pileTx = e.tx; site.pileTy = e.ty; }
      return e;
    }
  }
  const spot = findPileSpot(world, site.owner, tx, ty, kind, preferAwayFromBase);
  if (!spot) return null;
  const p = spawnBuilding(world, site.owner, kind, spot[0], spot[1]);
  p.amount = 0;
  site[idKey] = p.id;
  if (idKey === 'earthPileId') { site.pileTx = spot[0]; site.pileTy = spot[1]; }
  return p;
}

export function fillSitePile(world, site, amount) {
  if (!site || !amount) return;
  fillPile(world, site.earthPileId, amount);
}

export function fillOrePile(world, site, amount) {
  if (!site || !amount) return;
  fillPile(world, site.orePileId, amount);
}

function fillPile(world, id, amount) {
  const p = world.entities.get(id);
  if (p && PILE_KINDS.has(p.kind)) p.amount = (p.amount || 0) + amount;
}

function needsPile(s) {
  return s && s.etype === 'building' && ['wall', 'trench'].includes(s.kind);
}

function findPileSpot(world, owner, tx, ty, kind = 'earth_pile', preferAwayFromBase = true) {
  const def = world.data.buildings[kind];
  let bx = tx, by = ty, best = null, bestScore = -Infinity;
  const hq = [...world.entities.values()].find(e => e.owner === owner && e.kind === 'hq');
  if (hq) { bx = hq.tx; by = hq.ty; }
  for (let r = 2; r <= 9; r++) for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
    const px = tx + x, py = ty + y;
    if (!canPlaceBuilding(world, px, py, 1, def)) continue;
    const near = Math.hypot(x, y);
    const farBase = Math.hypot(px - bx, py - by);
    const score = preferAwayFromBase ? farBase * 1.8 - near : -near;
    if (score > bestScore) { bestScore = score; best = [px, py]; }
  }
  return best;
}

function assignTruckHauling(world, workersByOwner) {
  for (const [owner, list] of workersByOwner) {
    const piles = [...world.entities.values()].filter(e => e.owner === owner && PILE_KINDS.has(e.kind) && (e.amount || 0) > 0
      && hasResourceDepot(world, owner, pileResource(e)));
    for (const t of list) {
      if (!isFree(t)) continue;
      if ((t.cargo || 0) > 0 && t.cargoResource && hasResourceDepot(world, owner, t.cargoResource)) {
        t.resourceRole = t.cargoResource;
        t.order = { type: 'haul_pile', pile: t.order.pile || null, state: 'toDepot', resource: t.cargoResource };
        const depot = nearestResourceDepot(world, t, t.cargoResource);
        if (depot) {
          const [ax, ay] = buildingAccessPoint(world, t, depot);
          setMoveGoal(world, t, ax, ay);
        }
        continue;
      }
      if (!piles.length) continue;
      let best = null, bestD = Infinity;
      for (const p of piles) {
        if (!canHaulPile(t, p)) continue;
        // Manuell gewählter Transportmodus: nur Erz bzw. nur Baumaterial holen (auto = beides).
        if (t.haulMode === 'ore' && pileResource(p) !== 'ore') continue;
        if (t.haulMode === 'materials' && pileResource(p) !== 'materials') continue;
        const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) continue;
      const resource = pileResource(best);
      t.resourceRole = resource;
      t.order = { type: 'haul_pile', pile: best.id, state: 'toPile', resource };
      const [ax, ay] = pileAccessPoint(world, t, best);
      setMoveGoal(world, t, ax, ay);
    }
  }
}

function stepTruckHaul(world, t) {
  const pile = world.entities.get(t.order.pile);
  const resource = t.order.resource || t.cargoResource || pileResource(pile);
  if (t.order.state !== 'toDepot' && (!pile || pile.dead || !PILE_KINDS.has(pile.kind) || !canHaulPile(t, pile))) { t.order = { type: 'idle' }; return; }
  if (t.order.state === 'toPile') {
    const [ax, ay] = pileAccessPoint(world, t, pile);
    const nearPile = Math.hypot(pile.x - t.x, pile.y - t.y) <= 3.2;
    const nearAccess = Math.hypot(ax - t.x, ay - t.y) <= 2.4;
    if (!nearPile && !nearAccess) {
      if (!t.moveTarget) {
        setMoveGoal(world, t, ax, ay);
      }
      return;
    }
    stopMove(t);
    const cap = t.harvestCap || 80;
    const amt = Math.min(cap, pile.amount || 0);
    if (amt <= 0) { t.order = { type: 'idle' }; return; }
    pile.amount -= amt; t.cargo = amt; t.cargoResource = resource; t.resourceRole = resource; t.order.state = 'toDepot';
  }
  const depot = nearestResourceDepot(world, t, resource);
  if (!depot) { t.order = { type: 'idle' }; return; }
  const [dx, dy] = buildingAccessPoint(world, t, depot);
  const nearDepot = Math.hypot(depot.x - t.x, depot.y - t.y) <= depot.size + 3.5
    || Math.hypot(dx - t.x, dy - t.y) <= 2.0;
  if (!nearDepot) {
    if (!t.moveTarget) setMoveGoal(world, t, dx, dy);
    return;
  }
  const pl = world.players.find(p => p.id === t.owner);
  if (pl) addResource(world, pl, resource, t.cargo || 0);
  world.events.push({ type: 'dump', x: t.x, y: t.y, dx: depot.x, dy: depot.y, unit: t.id, owner: t.owner, amount: Math.round(t.cargo || 0), resource });
  t.cargo = 0; t.cargoResource = null; stopMove(t); t.order = { type: 'idle' };
}

function pileAccessPoint(world, unit, pile) {
  const terrain = world.terrain;
  let best = null, bestD = Infinity;
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = pile.tx + dx, ty = pile.ty + dy;
      if (!workerAccessPassable(terrain, unit, tx, ty)) continue;
      const [wx, wy] = tileToWorld(tx, ty);
      const d = (wx - unit.x) ** 2 + (wy - unit.y) ** 2;
      if (d < bestD) { bestD = d; best = [wx, wy]; }
    }
  }
  return best || [pile.x, pile.y];
}

function buildingAccessPoint(world, unit, building) {
  const terrain = world.terrain;
  let best = null, bestD = Infinity;
  const size = building.size || 1;
  for (let r = 1; r <= 5; r++) {
    for (let ty = building.ty - r; ty < building.ty + size + r; ty++) {
      for (let tx = building.tx - r; tx < building.tx + size + r; tx++) {
        const edge = tx === building.tx - r || tx === building.tx + size + r - 1
          || ty === building.ty - r || ty === building.ty + size + r - 1;
        if (!edge || !workerAccessPassable(terrain, unit, tx, ty)) continue;
        const [wx, wy] = tileToWorld(tx, ty);
        if (Math.hypot(building.x - wx, building.y - wy) > size + 2) continue;
        const d = (wx - unit.x) ** 2 + (wy - unit.y) ** 2;
        if (d < bestD) { bestD = d; best = [wx, wy]; }
      }
    }
    if (best) break;
  }
  return best || [building.x, building.y];
}

function workerAccessPassable(terrain, unit, tx, ty) {
  if (!inBounds(terrain, tx, ty)) return false;
  if (isPassable(terrain, unit.domain || 'land', tx, ty)) return true;
  if (unit.kind !== 'builder' || unit.domain !== 'land') return false;
  const i = tIdx(terrain, tx, ty);
  if ((terrain.water?.[i] || 0) > BUILDER_WADE_DEPTH) return false;
  const inTunnel = terrain.tunnel && terrain.tunnel[i] > 0;
  const blocked = terrain.block && terrain.block[i] > 0;
  return (terrain.type[i] !== TT.CLIFF || inTunnel) && !blocked;
}

function nearestResourceDepot(world, t, resource) {
  let best = null, bestD = Infinity;
  for (const e of world.entities.values()) {
    if (e.owner !== t.owner || e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    if (e.def.resourceDepot !== resource && !(e.def.integratedStorage && e.def.integratedStorage[resource])) continue;
    const d = (e.x - t.x) ** 2 + (e.y - t.y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function nearestFree(list, x, y, eligible = null, preferred = null, freeFn = isFree) {
  if (!list) return null;
  for (const wantPreferred of [true, false]) {
    let best = null, bestD = Infinity;
    for (const w of list) {
      if (!freeFn(w)) continue;
      if (eligible && !eligible(w)) continue;
      if (wantPreferred && preferred && !preferred(w)) continue;
      if (!wantPreferred && preferred && list.some(c => freeFn(c) && (!eligible || eligible(c)) && preferred(c))) continue;
      const d = (w.x - x) ** 2 + (w.y - y) ** 2;
      if (d < bestD) { bestD = d; best = w; }
    }
    if (best) return best;
  }
  return null;
}
