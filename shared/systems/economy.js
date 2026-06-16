// Ökonomiesystem: Energiebilanz (Öl/Wasser/Solar), Öl→Treibstoff, Pumpwerke & Leitungen,
// Unterhalt (nachts teurer), Erz-Harvesting.
import {
  DT, NIGHT_LIGHT_POWER, NIGHT_FUEL_MULT,
  PLANT_WATER_USE, PLANT_FUEL_USE, PLANT_NO_WATER_MULT, PLANT_NO_FUEL_MULT,
    PUMP_RATE_WATER, PUMP_RATE_GROUND, PUMP_RAIN_BONUS, PIPE_LINK_RANGE,
  MINE_DIG, WET_DEPTH,
} from '../constants.js';
import { worldToTile, tileToWorld, tIdx, inBounds, hasWaterNear, isFreshWater, applyHeightDelta, wakeWaterAround } from '../terrain.js';
import { addResource, hasResourceDepot } from '../world.js';
import { setMoveGoal, stopMove } from './movement.js';
import { assignOrePile, fillOrePile } from './construction.js';

// Erz-Vorkommen regenerieren sich langsam (Erz wächst geologisch nach) bis zur Ausgangsmenge ore0 —
// pro Sekunde und Zelle. Bewusst gemächlich: füllt erschöpfte Felder über ~15–20 min wieder auf, ohne
// die Wirtschaft beim aktiven Abbau (20/s) zu überholen.
const ORE_REGEN_PER_SEC = 1.0;
const ORE_REGEN_INTERVAL = 50; // alle 5 s

function regenOre(world) {
  const t = world.terrain;
  if (!t.ore0 || !t.oreList) return;
  const add = ORE_REGEN_PER_SEC * DT * ORE_REGEN_INTERVAL;
  for (const idx of t.oreList) {
    const cap0 = t.ore0[idx] || 0;
    if (cap0 <= 0 || t.ore[idx] >= cap0) continue;
    t.ore[idx] = Math.min(cap0, t.ore[idx] + add);
  }
}

export function stepEconomy(world) {
  if ((world.tick % 10) === 0) stepPipes(world); // Pipeline-Konnektivität (günstig, alle 1s)
  if (world.tick > 0 && (world.tick % ORE_REGEN_INTERVAL) === 0) regenOre(world);
  computeEnergy(world);
  for (const p of world.players) {
    if (p.defeated) continue;
    // Öl → Treibstoff veredeln (vereinfachte Kette).
    const oil = p.resources.oil || 0;
    if (oil > 0) { const conv = Math.min(oil, 5 * DT); p.resources.oil -= conv; addResource(world, p, 'fuel', conv * 2); }
  }
  stepLogistics(world);
  // Gebäudeproduktion von Rohstoffen (Bohrtürme, Pumpwerke etc.)
  const raining = world.env && world.env.weather !== 'clear';
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    const def = e.def;
    const p = world.players.find(pp => pp.id === e.owner);
    if (!p) continue;
    if (def.produces && (!def.pipelineResource || e._pipelineConnected)) {
      let producedAny = false;
      for (const [k, v] of Object.entries(def.produces)) {
        const amount = k === 'oil' ? extractOil(world, e, v * DT) : v * DT;
        if (k === 'oil') e._oilDry = amount <= 0;   // für die Warn-Markierung „Bohrturm ohne Öl"
        if (amount > 0) { addResource(world, p, k, amount); producedAny = true; }
      }
      if (producedAny && e.kind === 'oil_derrick' && ((world.tick + e.id) % 20) === 0) {
        world.events.push({ type: 'industry', kind: e.kind, x: e.x, y: e.y, owner: e.owner });
      }
    }
    // ERZ IST DIE WÄHRUNG (keine Credits-Umwandlung mehr): Bagger/Erz-LKWs liefern Erz in
    // die Lager (HQ/Raffinerie/Erzlager begrenzen die Kapazität), gebaut wird direkt mit Erz.
    // Pumpwerk: fördert Wasser — echte Wasserpumpen stehen im Wasser; Regen füllt zusätzlich.
    // Liefert nur, wenn es ans eigene Netz angeschlossen ist (Basisnähe ODER Leitungskette) —
    // Leitungen sind damit ein strategisches (und verwundbares) Element.
    if (def.pump) {
      // Pumpwerk fördert NUR, wenn es tatsächlich im (Süß-)Wasser steht — fällt das Wasser (Dürre)
      // unter seine Standfläche, versiegt die Förderung. Live je Tick geprüft (wenige Tiles, billig).
      let inWater = false;
      for (let yy = 0; yy < (e.size || 1) && !inWater; yy++) {
        for (let xx = 0; xx < (e.size || 1) && !inWater; xx++) {
          if (isFreshWater(world.terrain, e.tx + xx, e.ty + yy)) inWater = true;
        }
      }
      e._inWater = inWater;   // für die Warn-Markierung „Pumpwerk ohne Wasser"
      if (e._wConnected === true && inWater) {
        let rate = PUMP_RATE_WATER;
        if (raining) rate += PUMP_RAIN_BONUS;
        addResource(world, p, 'water', rate * DT);
        if (((world.tick + e.id) % 20) === 0) {
          world.events.push({ type: 'industry', kind: e.kind, x: e.x, y: e.y, owner: e.owner }); // Durchfluss-Animation
        }
      }
    }
  }
  stepBuilderOre(world);
  stepHarvesters(world);
  stepUpkeep(world);
}

// Pipeline-Netz: Pumpwerke liefern nur zum Wasserturm, Bohrtürme nur zum Öldepot.
// Wird eine Leitung zerstört, reißt die Versorgung ab — Leitungen quer über die Karte
// sind also angreifbare Infrastruktur.
function stepPipes(world) {
  const byOwner = new Map(); // owner -> {pipes:[], depots:Map(resource,[]), producers:[]}
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    let g = byOwner.get(e.owner); if (!g) byOwner.set(e.owner, g = { pipes: [], depots: new Map(), producers: [] });
    if (e.def.pipe) g.pipes.push(e);
    else {
      const resources = depotResources(e, true);
      for (const res of resources) {
        let list = g.depots.get(res); if (!list) g.depots.set(res, list = []);
        list.push(e);
        e._fed = false;   // wird unten true, wenn ein angeschlossener Produzent dieses Netz speist
      }
      if (!resources.length && producerResource(e)) g.producers.push(e);
    }
  }
  const tdist = (a, b) => Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty)); // Chebyshev in Tiles
  for (const g of byOwner.values()) {
    for (const prod of g.producers) {
      const res = producerResource(prod);
      const sinks = g.depots.get(res) || [];
      const frontier = g.pipes.filter(pp => tdist(prod, pp) <= PIPE_LINK_RANGE + 1);
      const seen = new Set(frontier.map(pp => pp.id));
      let connected = false;
      while (frontier.length && !connected) {
        const cur = frontier.pop();
        if (sinks.some(s => tdist(cur, s) <= PIPE_LINK_RANGE + 1)) { connected = true; break; }
        for (const nxt of g.pipes) {
          if (seen.has(nxt.id) || tdist(cur, nxt) > PIPE_LINK_RANGE) continue;
          seen.add(nxt.id); frontier.push(nxt);
        }
      }
      prod._pipelineConnected = connected;
      if (prod.def.pump) prod._wConnected = connected;
      if (connected) for (const s of sinks) s._fed = true;   // dieses Lager-Netz ist versorgt
    }
  }
}

function producerResource(e) {
  if (e.def.pump) return 'water';
  return e.def.pipelineResource || null;
}
function depotResources(e, pipelineOnly = false) {
  const out = [];
  if (e.def.resourceDepot) out.push(e.def.resourceDepot);
  if (pipelineOnly) return out;
  if (e.def.integratedStorage) out.push(...Object.keys(e.def.integratedStorage));
  return out;
}

function extractOil(world, derrick, want) {
  const t = world.terrain;
  if (!t.oil || want <= 0) return 0;
  let left = want;
  const minX = derrick.tx - 1, maxX = derrick.tx + derrick.size;
  const minY = derrick.ty - 1, maxY = derrick.ty + derrick.size;
  for (let y = minY; y <= maxY && left > 0; y++) for (let x = minX; x <= maxX && left > 0; x++) {
    if (!inBounds(t, x, y)) continue;
    const i = tIdx(t, x, y);
    const avail = t.oil[i] || 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    t.oil[i] -= take;
    left -= take;
    if (t.oilDirty) t.oilDirty.add(i);
  }
  return want - left;
}

// Nachschub-Logistik: Munition & Treibstoff werden vom HQ und von Depots erzeugt.
// Bewusst spürbar (große Armeen brauchen Depots), aber kein Mikromanagement-Puzzle.
function stepLogistics(world) {
  const acc = new Map(); // owner -> {ammo, fuel, ammoCap, fuelCap}
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    let a = acc.get(e.owner); if (!a) acc.set(e.owner, a = { ammo: 0, fuel: 0, ammoCap: 0, fuelCap: 0 });
    if (e.kind === 'hq') { a.ammo += 18; a.fuel += 10; a.ammoCap += 500; a.fuelCap += 600; }
    else if (e.kind === 'depot') { a.ammo += 12; a.fuel += 12; a.ammoCap += 600; a.fuelCap += 500; }
    else if (e.def.role === 'production') { a.ammo += 4; a.ammoCap += 150; }
  }
  for (const p of world.players) {
    if (p.defeated) continue;
    const a = acc.get(p.id); if (!a) continue;
    p.resources.ammo = Math.min(a.ammoCap, (p.resources.ammo || 0) + a.ammo * DT * p.energy.ratio);
    p.resources.fuel = Math.min(Math.max(a.fuelCap, p.resources.fuel || 0), (p.resources.fuel || 0) + a.fuel * DT);
  }
}

function computeEnergy(world) {
  const env = world.env || { daylight: 1, solar: 1 };
  const night = 1 - env.daylight;
  for (const p of world.players) { p.energy.produced = 0; p.energy.consumed = 0; }
  const consumers = new Map(); // owner -> [{e, need}]
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.dead || e.buildProgress < 1) continue;
    const p = world.players.find(pp => pp.id === e.owner);
    if (!p) continue;
    if (e.power > 0) {
      let out = e.power;
      if (e.def.burnsFuel) {
        // Ölkraftwerk: verbrennt Treibstoff und braucht Kühlwasser — ohne beides bricht die Leistung ein.
        const fuelOk = (p.resources.fuel || 0) >= PLANT_FUEL_USE * DT;
        const waterOk = (p.resources.water || 0) >= PLANT_WATER_USE * DT;
        if (fuelOk) p.resources.fuel -= PLANT_FUEL_USE * DT; else out *= PLANT_NO_FUEL_MULT;
        if (waterOk) p.resources.water -= PLANT_WATER_USE * DT; else out *= PLANT_NO_WATER_MULT;
        e._eff = out / e.power;
      } else if (e.def.solar) {
        // Solarkraftwerk: Ertrag folgt Tageslicht und Wetter — nachts und bei Regen (fast) nichts.
        out = e.power * env.solar;
        e._eff = env.solar;
      }
      e._powered = true;
      p.energy.produced += out;
      if (out > 1 && e.kind === 'power_plant' && ((world.tick + e.id) % 24) === 0) {
        world.events.push({ type: 'industry', kind: e.kind, x: e.x, y: e.y, owner: e.owner, eff: e._eff ?? 1 });
      }
    } else {
      // Nachts brauchen Gebäude Beleuchtung → höherer Verbrauch.
      const need = -e.power * (1 + NIGHT_LIGHT_POWER * night);
      p.energy.consumed += need;
      let list = consumers.get(e.owner); if (!list) consumers.set(e.owner, list = []);
      if (need > 0) list.push({ e, need }); else e._powered = true;
    }
  }
  // Lastabwurf bei Defizit: kleine Verbraucher werden zuerst versorgt — die GROSSEN Verbraucher
  // (Fabriken, Luftbasen …) fallen zuerst aus: Produktion stoppt, Lichter gehen aus.
  for (const p of world.players) {
    let budget = p.energy.produced;
    const list = (consumers.get(p.id) || []).sort((a, b) => a.need - b.need || a.e.id - b.e.id);
    for (const c of list) {
      if (budget >= c.need - 1e-9) { budget -= c.need; c.e._powered = true; }
      else c.e._powered = false;
    }
    p.energy.produced = Math.round(p.energy.produced);
    p.energy.consumed = Math.round(p.energy.consumed);
    p.energy.ratio = p.energy.consumed <= 0 ? 1 : Math.min(1, p.energy.produced / p.energy.consumed);
  }
}

function stepUpkeep(world) {
  // Nachts fahren Fahrzeuge mit Scheinwerfern → höherer Treibstoffverbrauch.
  const night = world.env ? 1 - world.env.daylight : 0;
  const mult = 1 + NIGHT_FUEL_MULT * night;
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead) continue;
    const def = world.data.units[e.kind];
    const up = def.upkeep;
    if (up && up.fuel) {
      const p = world.players.find(pp => pp.id === e.owner);
      if (p) p.resources.fuel = Math.max(0, (p.resources.fuel || 0) - up.fuel * mult * DT);
    }
  }
}

function carveMiningFurrows(world, tx, ty, amount, scale = 1) {
  const terrain = world.terrain;
  const dig = amount * MINE_DIG * scale;
  if (dig <= 0) return;
  const seed = ((tx * 73856093) ^ (ty * 19349663) ^ (world.tick * 83492791)) >>> 0;
  const axes = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const [ax, ay] = axes[seed & 3];
  const sx = -ay, sy = ax;
  const cuts = [
    [0, 0, 0.95],
    [ax, ay, 0.52], [-ax, -ay, 0.44],
    [sx, sy, 0.34], [-sx, -sy, 0.30],
    [ax + sx, ay + sy, 0.24], [ax - sx, ay - sy, 0.24],
    [-ax + sx, -ay + sy, 0.18], [-ax - sx, -ay - sy, 0.18],
  ];
  for (const [dx, dy, m] of cuts) {
    const x = tx + dx, y = ty + dy;
    if (!inBounds(terrain, x, y)) continue;
    const idx = tIdx(terrain, x, y);
    applyHeightDelta(terrain, idx, dig * m, false);
    if (terrain.tracks) terrain.tracks[idx] = Math.min(1, (terrain.tracks[idx] || 0) + amount * 0.0025 * m);
    if (terrain.trackDir) terrain.trackDir[idx] = seed & 7;
  }
  wakeWaterAround(terrain, tx - 1, ty - 1, 3, 2);
}

// Erz-LKWs laden jetzt nur noch fertige Erzhaufen. Der eigentliche Abbau passiert durch
// den Bagger in stepBuilderOre(); stepConstruction weist LKWs/Erz-LKWs den Haufen zu.
function stepHarvesters(world) {
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead || !e.abilities.includes('harvest')) continue;
    if (e.order.type !== 'idle' && e.order.type !== 'harvest') continue;
    e.resourceRole = 'ore';
    e.harvestNode = null;
    e.harvestState = 'seek';
    e.order = { type: 'idle' };
  }
}

function stepBuilderOre(world) {
  const { terrain } = world;
  // ROLLEN-SELBSTHEILUNG: Stirbt der Erz-Bagger, ist das Einkommen 0 und die KI verhungert
  // (verifiziert: erz friert ein, kein Gebäude mehr leistbar → Dauerpatt). Existiert kein
  // Bagger mit Erz-Rolle mehr, übernimmt der nächste freie Bagger das Erzschürfen.
  if ((world.tick % 20) === 0) {
    const byOwner = new Map();
    for (const e of world.entities.values()) {
      if (e.etype !== 'unit' || e.dead || e.abandoned || e.kind !== 'builder') continue;
      let l = byOwner.get(e.owner); if (!l) byOwner.set(e.owner, l = []);
      l.push(e);
    }
    for (const [owner, list] of byOwner) {
      const player = world.players.find(p => p.id === owner);
      if (player?.controller === 'human') continue;
      if (list.some(b => b.resourceRole === 'ore')) continue;
      const cand = list.find(b => b.order.type === 'idle' || b.order.type === 'guard') || list[0];
      if (cand) { cand.resourceRole = 'ore'; cand.harvestNode = null; }
    }
  }
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead || e.kind !== 'builder' || e.resourceRole !== 'ore') continue;
    if (e.order.type !== 'idle' && e.order.type !== 'harvest') continue;
    const p = world.players.find(pp => pp.id === e.owner);
    if (!p || !hasResourceDepot(world, e.owner, 'ore')) { e.order = { type: 'idle' }; continue; }
    e.order = { type: 'harvest' };
    // WASSER-FLUCHT: Die Abbaufurchen sammeln Regen-/Flusswasser — steigt es unter dem Bagger,
    // sofort die Grube verlassen (sonst gilt er nach 4 s als steckengeblieben und ist verloren).
    const [btx, bty] = worldToTile(e.x, e.y);
    const bIdx = tIdx(terrain, btx, bty);
    if (terrain.water[bIdx] > WET_DEPTH * 0.8) {
      e.harvestNode = null;
      if (!e.moveTarget) {
        const dry = findDrySpot(terrain, btx, bty);
        if (dry) setMoveGoal(world, e, dry[0] * 2 + 1, dry[1] * 2 + 1);
      }
      continue;
    }
    if (e.harvestNode && terrain.water[tIdx(terrain, e.harvestNode[0], e.harvestNode[1])] > WET_DEPTH * 0.8) e.harvestNode = null;
    if (!e.harvestNode || terrain.ore[tIdx(terrain, e.harvestNode[0], e.harvestNode[1])] <= 0) {
      e.harvestNode = findOre(world, e);
      if (!e.harvestNode) { e.order = { type: 'idle' }; e.moveTarget = null; continue; }
      const [wx, wy] = tileToWorld(e.harvestNode[0], e.harvestNode[1]);
      setMoveGoal(world, e, wx, wy);
    }
    const [nx, ny] = tileToWorld(e.harvestNode[0], e.harvestNode[1]);
    if (Math.hypot(nx - e.x, ny - e.y) > 2.4) {
      if (!e.moveTarget) setMoveGoal(world, e, nx, ny);
      // ANFAHRT-WATCHDOG: Erz liegt an Hängen — manche Vorkommen sind für den Bagger
      // schlicht unerreichbar (Steigungslimit/Fluss). Nach 25 s ohne Ankunft wird das
      // Vorkommen auf die schwarze Liste gesetzt und ein anderes gesucht (sonst stand der
      // Bagger für IMMER davor und das Einkommen blieb 0 → KI-Dauerpatt, verifiziert).
      e._mineIdle = (e._mineIdle || 0) + DT;
      if (e._mineIdle > 25) {
        if (!e._badNodes) e._badNodes = new Set();
        e._badNodes.add(tIdx(terrain, e.harvestNode[0], e.harvestNode[1]));
        if (e._badNodes.size > 60) e._badNodes.clear();   // Karte ändert sich (Terraforming) → neu probieren
        e.harvestNode = null; e._mineIdle = 0; stopMove(e);
      }
      continue;
    }
    e._mineIdle = 0;
    stopMove(e);
    const idx = tIdx(terrain, e.harvestNode[0], e.harvestNode[1]);
    const amt = Math.min(20 * DT, terrain.ore[idx]); // Förderrate: KI-Ramp braucht Tempo (Lager-Caps bremsen ohnehin)
    if (amt <= 0) continue;
    const pile = assignOrePile(world, e, e.harvestNode[0], e.harvestNode[1]);
    if (!pile) { e._mineIdle = 24; continue; }
    terrain.ore[idx] -= amt;
    (terrain.oreDirty || (terrain.oreDirty = new Set())).add(idx); // Restmenge an den Client streamen
    fillOrePile(world, e, amt);
    carveMiningFurrows(world, e.harvestNode[0], e.harvestNode[1], amt, 0.65);
    if (((world.tick + e.id) % 10) === 0) world.events.push({ type: 'mine', x: e.harvestNode[0] * 2 + 1, y: e.harvestNode[1] * 2 + 1 });
  }
}

// Nächste trockene, passierbare Zelle (Spiralsuche) — Fluchtziel für Bagger in volllaufenden Gruben.
function findDrySpot(terrain, tx, ty) {
  for (let r = 1; r <= 8; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
      const nx = tx + x, ny = ty + y;
      if (!inBounds(terrain, nx, ny)) continue;
      const i = tIdx(terrain, nx, ny);
      if (terrain.water[i] <= WET_DEPTH * 0.3 && terrain.type[i] !== 2 && (!terrain.block || !terrain.block[i])) return [nx, ny];
    }
  }
  return null;
}

function findOre(world, e) {
  const { terrain } = world;
  const [ex, ey] = worldToTile(e.x, e.y);
  const W = terrain.w;
  let best = null, bestD = Infinity;
  // Über die zwischengespeicherte Erz-Tile-Liste die nächste ergiebige Zelle suchen.
  for (let k = 0; k < terrain.oreList.length; k++) {
    const idx = terrain.oreList[k];
    if (terrain.ore[idx] <= 0) continue;
    if (terrain.water[idx] > WET_DEPTH) continue; // überflutete Vorkommen meiden (Bagger säuft sonst ab)
    if (e._badNodes && e._badNodes.has(idx)) continue; // als unerreichbar markierte Vorkommen überspringen
    const tx = idx % W, ty = (idx / W) | 0;
    const d = (tx - ex) * (tx - ex) + (ty - ey) * (ty - ey);
    if (d < bestD) { bestD = d; best = [tx, ty]; }
  }
  return best;
}
