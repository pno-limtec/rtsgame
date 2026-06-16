// Simulations-Orchestrator: fester Tick-Loop, Befehlsverarbeitung, Lebenszyklus.
// Kennt weder Rendering noch Netzwerk — rein deterministische Logik.
import { DT, FLOOD_DEPTH, MAX_UNITS_PER_PLAYER, MUD_IMPASSABLE, TERRA_RAISE_COST } from './constants.js';
import {
  createWorld, spawnBuilding, buildSpatial, ownerEntities,
  canAfford, pay, effectiveCost, canPlaceBuilding, requiresBuildingAnchor, removeFortification, removeSolidBlock, addResource,
} from './world.js';
import { stepEconomy } from './systems/economy.js';
import { stepProduction } from './systems/production.js';
import { stepMovement, setMoveGoal, stopMove } from './systems/movement.js';
import { stepTransport } from './systems/transport.js';
import { stepCombat } from './systems/combat.js';
import { stepWater } from './systems/water.js';
import { stepAir } from './systems/air.js';
import { stepSonar } from './systems/sonar.js';
import { stepGarrison } from './systems/garrison.js';
import { stepRegen } from './systems/veterancy.js';
import { stepEnvironment } from './systems/environment.js';
import { stepRoads } from './systems/roads.js';
import { stepConstruction, addTerraJob, assignEarthPile } from './systems/construction.js';
import { stepRecovery } from './systems/recovery.js';
import { placeTunnel, onTunnelMouthDestroyed, stepTunnels } from './systems/tunnel.js';
import { stepCanal, canalLineTiles } from './systems/canal.js';
import { forestBlocks, inBounds, isPassable, tIdx, worldToTile, tileToWorld } from './terrain.js';
import { stepAi, initAi } from './ai/ai.js';

export { createWorld };

// Einen Simulationstakt ausführen.
export function step(world) {
  world.events = [];

  // 1) eingereihte Befehle anwenden (Netzwerk/lokale Eingaben am Tickrand)
  if (world.cmdQueue && world.cmdQueue.length) {
    for (const { cmd, playerId } of world.cmdQueue) applyCommand(world, cmd, playerId);
    world.cmdQueue.length = 0;
  }

  // 2) KI denken lassen
  for (const p of world.players) if (p.controller === 'ai' && !p.defeated) {
    if (!p.ai) initAi(p);
    stepAi(world, p, applyCommand);
  }

  // 3) räumlichen Index aufbauen (für Ziel- & Separation)
  buildSpatial(world, 8);

  // 4) Systeme in fester Reihenfolge
  stepEnvironment(world);  // Tag/Nacht, Wetter, Blitze, Erdbeben — VOR der Ökonomie (Solar braucht env)
  stepEconomy(world);
  stepProduction(world);
  stepWater(world);        // dynamisches Wasser: Fluss, Stau, Fluten, Ertrinken
  stepAir(world);          // Luft-Logistik: leere Maschinen kehren zur Basis zum Nachladen zurück
  stepMovement(world);
  stepTunnels(world);      // Tunnel: Zugehörigkeit (verborgene Einheiten) + Wasserfluss durch die Röhre
  stepCanal(world);        // Kanal-Schiff: Landengen zu schiffbarem Kanal ausheben
  stepRecovery(world);     // Traktoren bergen verlassene Fahrzeuge aus Matsch/Wasser
  stepConstruction(world); // Bagger: zu Baustellen/Terraform-Aufträgen fahren und arbeiten
  stepRoads(world);        // automatisches Straßennetz zwischen nahen Gebäuden
  stepTransport(world);    // Transporter: Landeinheiten ein-/ausladen (nach Bewegung → Ankunft erkannt)
  stepSonar(world);        // Sonar ortet getauchte U-Boote → Zielerfassung vor dem Kampf aktualisieren
  stepGarrison(world);     // eingegrabene Infanterie markieren + feldreparieren (vor Schadensberechnung)
  stepCombat(world);
  stepRegen(world);        // Helden-Veteranen heilen sich langsam (außer Gefecht)

  // 5) Tote entfernen, Niederlage prüfen
  cleanup(world);

  world.tick++;
  world.time += DT;
}

export function enqueueCommand(world, cmd, playerId) {
  (world.cmdQueue || (world.cmdQueue = [])).push({ cmd, playerId });
}

function cleanup(world) {
  for (const [id, e] of world.entities) {
    if (e.dead || e.hp <= 0) {
      if (e.etype === 'building' && e._fortified) removeFortification(world, e); // Deckung/Sperre freigeben
      if (e.etype === 'building' && e._solid) removeSolidBlock(world, e);        // Kollisionssperre freigeben
      if (e.etype === 'building' && e._tunnelId != null) onTunnelMouthDestroyed(world, e); // Mündung tot → versiegeln/kollabieren
      // Zerstörter Transporter reißt seine Insassen mit in den Untergang.
      if (e.carried && e.carried.length) {
        const waterDeath = e._deathCause === 'water';
        for (const u of e.carried) world.events.push({
          type: waterDeath ? 'washout' : 'death',
          id: u.id,
          x: e.x,
          y: e.y,
          etype: 'unit',
          kind: u.kind,
          ...(waterDeath && e._deathMeta ? e._deathMeta : {}),
        });
        e.carried.length = 0;
      }
      world.entities.delete(id);
      // Verweise auf totes Ziel auflösen
    }
  }
  for (const p of world.players) {
    if (p.defeated) continue;
    const ents = ownerEntities(world, p.id);
    if (ents.length === 0) { p.defeated = true; world.events.push({ type: 'defeat', player: p.id }); }
  }
}

// Anzahl lebender Einheiten eines Spielers (für Cap).
function unitCount(world, owner) {
  let n = 0;
  for (const e of world.entities.values()) if (e.owner === owner && e.etype === 'unit') n++;
  return n;
}

function commandUnits(world, ids, playerId) {
  const units = [], seen = new Set();
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const u = world.entities.get(id);
    if (u && u.etype === 'unit' && u.owner === playerId) units.push(u);
  }
  return units;
}

function moveGoalsForUnits(world, units, wx, wy) {
  const goals = new Map();
  if (units.length <= 1) {
    if (units[0]) goals.set(units[0].id, { x: wx, y: wy });
    return goals;
  }
  const [gx, gy] = worldToTile(wx, wy);
  const spacing = formationSpacing(units);
  const radius = Math.max(5, Math.ceil(Math.sqrt(units.length)) + 5);
  const candidates = formationOffsets(radius, spacing).map(([dx, dy]) => [gx + dx, gy + dy]);
  const used = new Set();
  const ordered = [...units].sort((a, b) => distSq(a.x, a.y, wx, wy) - distSq(b.x, b.y, wx, wy));
  for (const u of ordered) {
    let best = null, bestCost = Infinity;
    const [ux, uy] = worldToTile(u.x, u.y);
    for (const [tx, ty] of candidates) {
      const key = `${tx},${ty}`;
      if (used.has(key) || !unitCanStopOn(world, u, tx, ty)) continue;
      const goalCost = Math.hypot(tx - gx, ty - gy) * 0.35;
      const travelCost = Math.hypot(tx - ux, ty - uy);
      const cost = travelCost + goalCost;
      if (cost < bestCost) { bestCost = cost; best = [tx, ty, key]; }
    }
    if (!best) {
      goals.set(u.id, { x: wx, y: wy });
      continue;
    }
    used.add(best[2]);
    const [x, y] = tileToWorld(best[0], best[1]);
    goals.set(u.id, { x, y });
  }
  return goals;
}

function formationSpacing(units) {
  return units.some(u => u.category === 'vehicle' || u.heavy) ? 2 : 1;
}

function formationOffsets(radius, spacing = 1) {
  const out = [[0, 0]];
  for (let r = 1; r <= radius; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
      out.push([x * spacing, y * spacing]);
    }
  }
  out.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
  return out;
}

function unitCanStopOn(world, u, tx, ty) {
  const t = world.terrain;
  if (!inBounds(t, tx, ty)) return false;
  if (u.domain === 'air') return true;
  const i = tIdx(t, tx, ty);
  const muddyBuilder = u.kind === 'builder'
    && u.domain === 'land'
    && t.mud && t.mud[i] > 0.02
    && (t.water?.[i] || 0) <= FLOOD_DEPTH;
  if (!isPassable(t, u.domain, tx, ty) && !muddyBuilder) return false;
  if (forestBlocks(t, u.domain, tx, ty, { category: u.category, roughCrawler: u.kind === 'tractor' })) return false;
  if (u.heavy && u.domain === 'land' && t.mud && t.mud[i] >= MUD_IMPASSABLE) return false;
  return true;
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// --- Befehlsverarbeitung (autoritativ) ---
export function applyCommand(world, cmd, playerId) {
  const player = world.players.find(p => p.id === playerId);
  if (!player || player.defeated) return;

  switch (cmd.type) {
    case 'move': {
      const units = commandUnits(world, cmd.units, playerId);
      const goals = moveGoalsForUnits(world, units, cmd.x, cmd.y);
      for (const u of units) {
        u.order = { type: cmd.attackMove ? 'attackmove' : 'move' };
        u.target = null;
        const goal = goals.get(u.id) || { x: cmd.x, y: cmd.y };
        setMoveGoal(world, u, goal.x, goal.y);
      }
      break;
    }
    case 'attack': {
      const tgt = world.entities.get(cmd.targetId);
      for (const id of cmd.units) {
        const u = world.entities.get(id);
        if (!u || u.owner !== playerId) continue;
        u.order = { type: 'attack', targetId: cmd.targetId };
        u.target = cmd.targetId;
        if (tgt) setMoveGoal(world, u, tgt.x, tgt.y);
      }
      break;
    }
    case 'seedCloud': {
      const x = Number(cmd.x), y = Number(cmd.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      for (const u of commandUnits(world, cmd.units, playerId)) {
        if (u.kind !== 'cloud_seeder' || !u.weapon?.weatherCloud) continue;
        u.order = { type: 'seedCloud', x, y };
        u.target = null;
        if (Math.hypot(x - u.x, y - u.y) > u.weapon.range * 0.85) setMoveGoal(world, u, x, y);
      }
      break;
    }
    case 'stop': {
      for (const id of cmd.units) {
        const u = world.entities.get(id);
        if (!u || u.owner !== playerId) continue;
        u.order = { type: 'idle' }; u.target = null; stopMove(u);
      }
      break;
    }
    case 'setRole': {
      const rawRole = cmd.role === 'materials' ? 'build' : cmd.role;
      const role = ['ore', 'build', 'earth'].includes(rawRole) ? rawRole : 'build';
      // LKW-Transportmodus: auto (Erz + Material), nur Erz oder nur Baumaterial.
      const haul = cmd.role === 'ore' ? 'ore' : (cmd.role === 'materials' || cmd.role === 'earth') ? 'materials' : 'auto';
      for (const id of cmd.units || []) {
        const u = world.entities.get(id);
        if (!u || u.etype !== 'unit' || u.owner !== playerId) continue;
        if (u.kind === 'builder') {
          u.resourceRole = role;
          if (u.order.type === 'harvest' || u.order.type === 'construct' || u.order.type === 'terra') {
            u.order = { type: 'idle' }; u.target = null; stopMove(u);
          }
        } else if (u.kind === 'truck') {
          u.haulMode = haul;
          // Läuft der LKW gerade zu einem nicht mehr erlaubten Haufen, Auftrag lösen (Ladung behält er).
          if (u.order.type === 'haul_pile' && u.order.state === 'toPile') {
            u.order = { type: 'idle' }; u.target = null; stopMove(u);
          }
        }
      }
      break;
    }
    case 'load': {
      // Ausgewählte Landeinheiten steigen in den Zieltransporter ein.
      const t = world.entities.get(cmd.transport);
      if (!t || t.owner !== playerId || !t.capacity) break;
      for (const id of cmd.units) {
        const u = world.entities.get(id);
        if (!u || u.etype !== 'unit' || u.owner !== playerId) continue;
        if (u.domain !== 'land' || u.id === t.id) continue; // nur Landeinheiten transportierbar
        u.order = { type: 'load', transportId: t.id }; u.target = null;
        setMoveGoal(world, u, t.x, t.y);
      }
      break;
    }
    case 'unload': {
      // Transporter fährt zum Zielpunkt (falls angegeben) und lädt dort alle Insassen aus.
      const t = world.entities.get(cmd.transport);
      if (!t || t.owner !== playerId || !t.capacity) break;
      const ux = cmd.x != null ? cmd.x : t.x, uy = cmd.y != null ? cmd.y : t.y;
      t.order = { type: 'unload', x: ux, y: uy };
      if (cmd.x != null) setMoveGoal(world, t, ux, uy);
      break;
    }
    case 'tow': {
      const target = world.entities.get(cmd.targetId);
      if (!target || !target.abandoned || target.domain !== 'land') break;
      const tractors = commandUnits(world, cmd.units, playerId).filter(u => u.abilities?.includes('tow') && !u.abandoned);
      for (const u of tractors) {
        u.order = { type: 'tow', targetId: target.id };
        u.target = null;
      }
      break;
    }
    case 'build': {
      placeBuilding(world, player, cmd);
      break;
    }
    case 'tunnel': {
      // Tunnel als EIN Liniengebäude (Mündung→Mündung), nicht je Tile ein Gebäude.
      // remoteBuild → überall baubar (kein Bauradius-Zwang); sonst muss eine Mündung im Radius liegen.
      const radCheck = world.data.buildings.tunnel?.remoteBuild ? null : inBuildRadius;
      placeTunnel(world, player, cmd.sx | 0, cmd.sy | 0, cmd.ex | 0, cmd.ey | 0, radCheck);
      break;
    }
    case 'canal': {
      // Kanal-Schiffe (Wasserbau-Einheit mit 'canal') graben entlang einer Linie einen schiffbaren Kanal.
      const path = canalLineTiles(cmd.sx | 0, cmd.sy | 0, cmd.ex | 0, cmd.ey | 0);
      for (const u of commandUnits(world, cmd.units, playerId)) {
        const def = world.data.units[u.kind];
        if (!def || !(def.canal || def.abilities?.includes('canal'))) continue;
        u.order = { type: 'canal', path, step: 0 };
        u.target = null; stopMove(u);
      }
      break;
    }
    case 'assist': {
      // Manuelle Zuweisung: selektierten Bagger/LKW zu Baustelle/Erdhaufen/Terraform-Auftrag
      // schicken — die Funktion passt sich automatisch an (Bagger ↔ Bau/Terraforming, LKW ↔ Abfuhr).
      const tgt = cmd.target != null ? world.entities.get(cmd.target) : null;
      for (const id of cmd.units) {
        const u = world.entities.get(id);
        if (!u || u.etype !== 'unit' || u.owner !== playerId) continue;
        if (tgt && tgt.owner === playerId && tgt.etype === 'building') {
          if ((tgt.kind === 'earth_pile' || tgt.kind === 'ore_pile') && (u.abilities?.includes('haul') || (tgt.kind === 'ore_pile' && u.abilities?.includes('harvest')))) {
            const resource = tgt.kind === 'ore_pile' ? 'ore' : 'materials';
            u.resourceRole = resource;
            u.order = { type: 'haul_pile', pile: tgt.id, state: 'toPile', resource };
            setMoveGoal(world, u, tgt.x, tgt.y);
          } else if (tgt.buildProgress < 1 && u.kind === 'builder') {
            u.resourceRole = 'build';   // Funktion automatisch anpassen
            u.order = { type: 'construct', site: tgt.id }; u.target = null;
            setMoveGoal(world, u, tgt.x, tgt.y);
          }
        } else if (cmd.tx != null && u.kind === 'builder') {
          // Terraform-Auftrag in Klicknähe übernehmen.
          let best = null, bestD = 16;
          for (const j of world.terraJobs || []) {
            if (j.owner !== playerId) continue;
            const d = (j.tx - cmd.tx) ** 2 + (j.ty - cmd.ty) ** 2;
            if (d < bestD) { bestD = d; best = j; }
          }
          if (best) {
            u.resourceRole = 'earth';
            u.order = { type: 'terra', job: best.id }; u.target = null;
            setMoveGoal(world, u, best.tx * 2 + 1, best.ty * 2 + 1);
          }
        }
      }
      break;
    }
    case 'terraform': {
      // Aufschütt-/Abgrab-Auftrag: ein freier Bagger fährt hin und übernimmt die Arbeit.
      if (!inBounds(world.terrain, cmd.tx, cmd.ty)) break;
      const dir = cmd.dir > 0 ? 1 : -1;
      if (dir > 0) {
        if ((player.resources.materials || 0) < TERRA_RAISE_COST) break;
        player.resources.materials -= TERRA_RAISE_COST; // Aufschütten verbraucht Erde
      }
      addTerraJob(world, player.id, cmd.tx, cmd.ty, dir);
      break;
    }
    case 'setPile': {
      const site = world.entities.get(cmd.site);
      if (!site || site.owner !== playerId || !site.earthPileId) break;
      const pile = world.entities.get(site.earthPileId);
      const def = world.data.buildings.earth_pile;
      if (!pile || pile.kind !== 'earth_pile' || !def) break;
      if (Math.hypot((cmd.tx + 0.5) - (site.tx + site.size / 2), (cmd.ty + 0.5) - (site.ty + site.size / 2)) > 12) break;
      if (!canPlaceBuilding(world, cmd.tx, cmd.ty, 1, def)) break;
      removeSolidBlock(world, pile);
      pile.tx = cmd.tx; pile.ty = cmd.ty;
      [pile.x, pile.y] = tileToWorld(cmd.tx, cmd.ty);
      const t = world.terrain, i = tIdx(t, cmd.tx, cmd.ty);
      if (inBounds(t, cmd.tx, cmd.ty)) { t.block[i]++; pile._solid = true; }
      site.pileTx = cmd.tx; site.pileTy = cmd.ty;
      break;
    }
    case 'destroy': {
      // Eigenes Gebäude abreißen: im Bau → volle Rückerstattung (Bau abbrechen), fertig → 50 %.
      // Die normale Cleanup-Routine (siehe cleanup) gibt Sperren/Befestigungen/Tunnel frei.
      const b = world.entities.get(cmd.building);
      if (!b || b.etype !== 'building' || b.owner !== playerId || b.dead) break;
      if (b.kind === 'earth_pile' || b.kind === 'ore_pile') break; // Materialhaufen sind keine Bauten
      const def = b.def || world.data.buildings[b.kind];
      const refundFrac = b.buildProgress < 1 ? 1 : 0.5;   // im Bau: voll zurück, fertig: halb
      const cost = effectiveCost(world, playerId, def) || {};
      for (const [k, v] of Object.entries(cost)) {
        const give = Math.round((v || 0) * refundFrac);
        if (give > 0) addResource(world, player, k, give);
      }
      b.dead = true; b.hp = 0; b._deathCause = 'sold';
      world.events.push({ type: 'death', id: b.id, x: b.x, y: b.y, etype: 'building', kind: b.kind, size: b.size || 1, sold: 1 });
      break;
    }
    case 'produce': {
      enqueueProduction(world, player, cmd);
      break;
    }
    case 'rally': {
      const b = world.entities.get(cmd.building);
      if (b && b.owner === playerId) b.rally = { x: cmd.x, y: cmd.y };
      break;
    }
    case 'setController': {
      // KI-Übernahme / Reconnect: Slot umschalten (server-seitig autorisiert)
      const p = world.players.find(pp => pp.id === cmd.playerId);
      if (p) { p.controller = cmd.controller; if (cmd.name) p.name = cmd.name; }
      break;
    }
  }
}

function placeBuilding(world, player, cmd) {
  const def = world.data.buildings[cmd.building];
  if (!def) return;
  const size = def.size || 1;
  if (!canPlaceBuilding(world, cmd.tx, cmd.ty, size, def, player.id)) return;
  if (!def.remoteBuild && !requiresBuildingAnchor(def) && !inBuildRadius(world, player.id, cmd.tx, cmd.ty, size)) return;
  const bcost = effectiveCost(world, player.id, def);
  if (!canAfford(player, bcost)) return;
  pay(player, bcost);
  const b = spawnBuilding(world, player.id, cmd.building, cmd.tx, cmd.ty);
  if (['wall', 'trench'].includes(cmd.building)) assignEarthPile(world, b, cmd.tx, cmd.ty);
}

function inBuildRadius(world, owner, tx, ty, size) {
  const cx = tx + size / 2, cy = ty + size / 2;
  for (const e of world.entities.values()) {
    if (e.etype !== 'building' || e.owner !== owner) continue;
    const r = (e.def.buildRadius || 0) + e.size;
    if (r <= 0) continue;
    const ecx = e.tx + e.size / 2, ecy = e.ty + e.size / 2;
    if (Math.hypot(cx - ecx, cy - ecy) <= r) return true;
  }
  return false;
}

function enqueueProduction(world, player, cmd) {
  const b = world.entities.get(cmd.building);
  if (!b || b.owner !== player.id || b.buildProgress < 1) return;
  const def = world.data.units[cmd.kind];
  if (!def) return;
  if (!canBuildingProduce(b.def, cmd.kind, def)) return;
  if (unitCount(world, player.id) + (b.queue.length) >= MAX_UNITS_PER_PLAYER) return;
  const ucost = effectiveCost(world, player.id, def);
  if (!canAfford(player, ucost)) return;
  pay(player, ucost);
  b.queue.push({ kind: cmd.kind, category: def.category, timeLeft: def.buildTime, total: def.buildTime });
}

function canBuildingProduce(buildingDef, unitKind, unitDef) {
  const list = buildingDef.produces_units || [];
  if (list.includes(unitKind)) return true;
  const cat = buildingDef.produces_category;
  return !!cat && unitDef.category === cat;
}
