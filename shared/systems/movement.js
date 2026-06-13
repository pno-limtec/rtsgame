// Bewegungssystem: Pfadverfolgung, Fahrzeugphysik (drehen→fahren, Beschleunigung),
// Gelände-/Straßen-/Wetter-Einfluss, leichte Separation.
import { findPath } from '../pathfinding.js';
import { worldToTile, tileToWorld, tileType, TT, inBounds, tIdx, isPassable, slopeOk, roadAtIdx, forestBlocks, waterBlocksLand } from '../terrain.js';
import {
  DT, FLOOD_DEPTH, WET_DEPTH, ROAD_SPEED, ROAD_SPEED_HEAVY, MUD_SPEED_HEAVY,
  TURN_RATE_VEHICLE, TURN_RATE_NAVAL, VEHICLE_ACCEL, SLOPE_ON_ROAD, CONSTRUCT_RANGE,
  RAIN_AIR_SLOW, STORM_NAVAL_SLOW, FOG_NAVAL_SLOW, FOG_NAVAL_DRIFT, FOG_NAVAL_CRASH_DMG,
  TRACK_GAIN_LIGHT, TRACK_GAIN_HEAVY, MUD_GAIN_HEAVY, MUD_IMPASSABLE, MUD_SPEED_MIN,
} from '../constants.js';
import { applyDamage } from '../world.js';

const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// Bewegungsziel setzen → Pfad berechnen. PFAD-BUDGET: höchstens N volle A*-Suchen pro Tick
// (KI-Angriffswellen schicken sonst 30+ Einheiten im selben Tick auf 192²-Suche → 300ms-Spikes);
// über dem Budget wird die Suche auf die Folgeticks verschoben (gestaffelt, deterministisch).
const PATHS_PER_TICK = 6;  // Suchen sind mit 48k-Limit teurer
export function setMoveGoal(world, ent, wx, wy) {
  ent.moveTarget = { x: wx, y: wy };
  ent.repathCd = 0;
  // Luft ignoriert Gelände → direkte Linie, keine A*-Suche (günstiger & sauberer).
  if (ent.domain === 'air') { ent.path = []; ent.pathGoal = null; return; }
  if (world._pbTick !== world.tick) { world._pbTick = world.tick; world._pathBudget = PATHS_PER_TICK; }
  if (world._pathBudget <= 0) {
    ent.path = []; ent.pathGoal = null;
    ent.repathCd = 0.2 + (ent.id % 9) * 0.1;   // Suche nachholen, zeitversetzt
    return;
  }
  world._pathBudget--;
  const [sx, sy] = worldToTile(ent.x, ent.y);
  const [gx, gy] = worldToTile(wx, wy);
  const path = findPath(world.terrain, ent.domain, sx, sy, gx, gy, 48000, ent.maxSlope ?? Infinity,
    { heavy: !!ent.heavy, category: ent.category }); // große Karte → mehr Iterationen
  ent.pathGoal = [gx, gy];
  ent.path = path || [];
}

export function stopMove(ent) { ent.path = []; ent.moveTarget = null; ent.pathGoal = null; }

export function stepMovement(world) {
  const { terrain } = world;
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead) continue;
    if (e.abandoned) { stopMove(e); e._v = 0; continue; }
    const [ctx, cty] = worldToTile(e.x, e.y);
    if (updateStuckState(world, e, ctx, cty, false)) continue;
    if (!e.moveTarget) continue;

    // Treibstoffmangel bremst Fahrzeuge/Luft.
    const player = world.players.find(p => p.id === e.owner);
    let speed = e.speed;
    if (player && (player.resources.fuel || 0) <= 0 && (e.domain !== 'land' || e.category !== 'infantry')) speed *= 0.55;
    if (tileType(terrain, ctx, cty) === TT.HILL) speed *= 0.8;
    // Straßen beschleunigen (schwere Fahrzeuge am meisten); abseits der Straße bleiben schwere
    // Fahrzeuge bei Regen im Matsch stecken (sehr langsam).
    const weather = world.env ? world.env.weather : 'clear';
    if (e.domain === 'land' && inBounds(terrain, ctx, cty)) {
      const onRoad = roadAtIdx(terrain, tIdx(terrain, ctx, cty));
      const raining = weather === 'rain' || weather === 'storm';
      if (onRoad) speed *= e.heavy ? ROAD_SPEED_HEAVY : ROAD_SPEED;
      else if (raining && e.heavy) speed *= MUD_SPEED_HEAVY;
      if (terrain.mud && !onRoad) {
        const mud = terrain.mud[tIdx(terrain, ctx, cty)];
        if (e.heavy && mud >= MUD_IMPASSABLE) speed = 0;
        else if (mud > 0) speed *= Math.max(MUD_SPEED_MIN, 1 - mud * (e.heavy ? 0.9 : 0.45));
      }
    }
    // Wetter-Risiken je Domäne: Sturm bremst Schiffe (Wellengang) und Flieger, Nebel zwingt
    // Schiffe zum Tasten, Regen bremst die Luftfahrt. Infanterie ist im Gelände am flexibelsten.
    if (e.domain === 'water' || e.domain === 'amphibious') {
      if (weather === 'storm') speed *= STORM_NAVAL_SLOW;
      else if (weather === 'fog') speed *= FOG_NAVAL_SLOW;
    } else if (e.domain === 'air' && (weather === 'rain' || weather === 'storm')) {
      speed *= RAIN_AIR_SLOW;
    }
    // In Flutwasser gefangene Landeinheiten kommen nur kriechend voran.
    if (e.domain === 'land' && inBounds(terrain, ctx, cty) && terrain.water[tIdx(terrain, ctx, cty)] > FLOOD_DEPTH) speed *= 0.35;

    // nächster Wegpunkt
    let tgt;
    if (e.path && e.path.length) {
      const [tx, ty] = e.path[0];
      [tgt] = [{ x: 0, y: 0 }];
      const [wx, wy] = tileToWorld(tx, ty);
      tgt.x = wx; tgt.y = wy;
    } else {
      tgt = e.moveTarget;
    }

    const dx = tgt.x - e.x, dy = tgt.y - e.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const desired = Math.atan2(dy, dx);

    // Fahrzeug-Kinematik: Fahrzeuge fahren ENTLANG DER NASE — nie seitwärts. Sie drehen mit
    // begrenzter Rate zum Ziel und fahren dabei einen Bogen (kein Festnageln an Wegpunkten:
    // Wegpunkte gelten in einem großzügigen Radius als erreicht). Nur wenn das Ziel fast
    // hinter dem Fahrzeug liegt, dreht es am Stand (Pivot), sonst bremst es in engen Kurven.
    let moveDir = desired;
    const isVehicle = e.domain !== 'air' && e.category !== 'infantry';
    if (isVehicle) {
      const turnRate = (e.domain === 'water' || e.domain === 'amphibious' ? TURN_RATE_NAVAL : TURN_RATE_VEHICLE) * (e.heavy ? 0.8 : 1);
      let da = wrapAngle(desired - e.facing);
      const maxTurn = turnRate * DT;
      e.facing = wrapAngle(e.facing + Math.max(-maxTurn, Math.min(maxTurn, da)));
      da = wrapAngle(desired - e.facing);
      moveDir = e.facing;                                        // Bewegung folgt der Nase
      const vTarget = Math.abs(da) > 1.45 ? 0 : speed * Math.max(0.3, Math.cos(da));
      const accel = e.speed * VEHICLE_ACCEL * DT;
      e._v = Math.min(vTarget, (e._v || 0) + accel);
      if (vTarget < (e._v || 0)) e._v = vTarget;                 // bremsen wirkt sofort
    } else {
      e.facing = desired;
      e._v = speed;
    }
    const stepLen = (e._v ?? speed) * DT;

    const followingPath = e.path && e.path.length > 0;
    const ox = e.x, oy = e.y;
    // Wegpunkt-Akzeptanz: Fahrzeuge fahren Bögen — Pfad-Wegpunkte zählen schon in ~1 m
    // Umkreis als passiert (verhindert Orbit um exakt getroffene Punkte).
    const acceptR = followingPath
      ? Math.max(stepLen, isVehicle ? 1.0 : 0.3)
      : (isVehicle ? Math.max(stepLen, 1.1) : stepLen);   // Endziel: Wendekreis > Schrittweite → kein Orbit
    let nx, ny, reached = false;
    if (d <= acceptR) {
      reached = true;
      if (d <= stepLen) { nx = tgt.x; ny = tgt.y; }              // exakt erreichbar → snappen
      else { nx = e.x + Math.cos(moveDir) * stepLen; ny = e.y + Math.sin(moveDir) * stepLen; }
    } else if (stepLen <= 1e-9) { nx = e.x; ny = e.y; }
    else { nx = e.x + Math.cos(moveDir) * stepLen; ny = e.y + Math.sin(moveDir) * stepLen; }
    const fogDrift = applyFogNavalDrift(world, e, weather, ctx, cty);
    if (fogDrift) { nx += fogDrift.x; ny += fogDrift.y; reached = false; }

    // Nicht in unpassierbares Gelände gleiten. Pfad-Wegpunkte sind per Konstruktion passierbar;
    // nur der freie Direktanflug ans Endziel wird geprüft — verhindert z. B. Schiffe, die mangels
    // Wasserpfad in gerader Linie über Land „segeln" (Beaching). Zusätzlich Steigungslimit:
    // zu steile Hänge stoppen Fahrzeuge auch unterwegs (Terraforming/Beben ändern das Gelände).
    const [ntx, nty] = worldToTile(nx, ny);
    const curI = tIdx(terrain, ctx, cty), nxtI = tIdx(terrain, ntx, nty);
    if (fogDrift && !isPassable(terrain, 'water', ntx, nty)) {
      e.x = nx; e.y = ny; e._v = 0; stopMove(e);
      world.events.push({ type: 'shipwreck', x: nx, y: ny });
      applyDamage(world, e, FOG_NAVAL_CRASH_DMG, null);
      continue;
    }
    const blockedByMud = e.heavy && e.domain === 'land' && inBounds(terrain, ntx, nty)
      && terrain.mud && terrain.mud[nxtI] >= MUD_IMPASSABLE;
    const blockedByWater = e.domain === 'land' && inBounds(terrain, ntx, nty)
      && waterBlocksLand(terrain, nxtI) && !(terrain.bridge && terrain.bridge[nxtI] > 0);
    const blockedByForest = forestBlocks(terrain, e.domain, ntx, nty, { category: e.category });
    const tooSteep = (e.domain === 'land' || e.domain === 'amphibious') && nxtI !== curI
      && inBounds(terrain, ntx, nty) && !slopeOk(terrain, curI, nxtI, e.maxSlope ?? Infinity, SLOPE_ON_ROAD);
    if (tooSteep || blockedByMud || blockedByWater || blockedByForest) {
      // Hang oder Matsch unpassierbar geworden → anhalten und neu planen.
      if (updateStuckState(world, e, ntx, nty, blockedByMud || blockedByWater || tooSteep)) continue;
      e.path = []; e._v = 0;
      if (e.repathCd <= 0) { setMoveGoal(world, e, e.moveTarget.x, e.moveTarget.y); e.repathCd = 1.2 + (e.id % 5) * 0.2; }
    } else if (!followingPath && !isPassable(terrain, e.domain, ntx, nty)) {
      // Geradeausfahrt endet vor unpassierbarem Gelände. Das passiert vor allem, wenn das
      // Pfad-Budget die A*-Suche verschoben hat — das ZIEL NICHT verwerfen (sonst stranden
      // ganze Angriffswellen kommandolos), sondern stehen bleiben und nachplanen. Erst nach
      // mehreren echten Fehlversuchen aufgeben (Marine bleibt im Wasser).
      e.path = []; e._v = 0;
      e._pathFails = (e._pathFails || 0) + 1;
      if (e._pathFails > 6) { stopMove(e); e._pathFails = 0; }
      else if (e.repathCd <= 0) e.repathCd = 0.5 + (e.id % 7) * 0.15;
    } else {
      e.x = nx; e.y = ny;
      if (reached) {
        if (e.path && e.path.length) e.path.shift();
        if (!e.path || !e.path.length) {
          const fd = Math.hypot(e.moveTarget.x - e.x, e.moveTarget.y - e.y);
          if (fd < 1.6) stopMove(e);   // großzügig: Fahrzeuge mit Wendekreis nicht ums Ziel kreisen lassen
        }
      }
    }
    stampVehicleTrack(world, e, ox, oy);

    // Periodisches Repathing, falls Pfad leer aber Ziel nicht erreicht. Cooldown je Einheit
    // gestaffelt, damit nicht ganze Armeen im selben Tick A* rechnen (Tick-Spitzen).
    e.repathCd -= DT;
    if ((!e.path || !e.path.length) && e.moveTarget && e.repathCd <= 0) {
      const fd = Math.hypot(e.moveTarget.x - e.x, e.moveTarget.y - e.y);
      if (fd > 1.5) {
        setMoveGoal(world, e, e.moveTarget.x, e.moveTarget.y);
        // Fehlgeschlagene Suchen (kein Pfad) sind teuer (volle Kartenexploration) →
        // deutlich längerer Cooldown, bevor dieselbe Einheit es erneut versucht.
        if (e.path && e.path.length) { e._pathFails = 0; if (e.repathCd <= 0) e.repathCd = 0.8 + (e.id % 7) * 0.13; }
        else if (e.repathCd <= 0) e.repathCd = 2.6 + (e.id % 7) * 0.13;
      } else stopMove(e);
    }
  }

  separation(world);
}

function updateStuckState(world, e, tx, ty, blocked) {
  if (e.kind === 'tractor' || e.domain !== 'land' || e.category !== 'vehicle') { e._stuckTime = 0; return false; }
  const t = world.terrain;
  let hazard = !!blocked;
  let waterHazard = false, mudHazard = false;
  if (inBounds(t, tx, ty)) {
    const i = tIdx(t, tx, ty);
    waterHazard = waterBlocksLand(t, i);
    mudHazard = e.heavy && t.mud && t.mud[i] >= MUD_IMPASSABLE * 0.8;
    const s = e.order?.type === 'construct' ? world.entities.get(e.order.site) : null;
    const nearSite = s && Math.hypot(s.x - e.x, s.y - e.y) <= (s.size || 1) + CONSTRUCT_RANGE;
    if (nearSite && !mudHazard && (!waterHazard || t.water[i] < FLOOD_DEPTH)) {
      e._stuckTime = 0;
      e._fleeing = false;
      return false;
    }
    hazard = hazard || waterHazard || mudHazard;
  }
  if (!hazard) { e._stuckTime = Math.max(0, (e._stuckTime || 0) - DT * 2); e._fleeing = false; return false; }
  e._stuckTime = (e._stuckTime || 0) + DT;
  // ERST FLIEHEN: Wer in einer wachsenden Pfütze parkt, ist nicht verloren — aufs Trockene
  // fahren. Aufgegeben wird erst, wenn auch die Flucht 8 s lang scheitert (wirklich festgefahren).
  // Ohne das verlor die KI ständig geparkte Fahrzeuge an Regenpfützen → endlose Ersatzproduktion.
  const abandonAfter = mudHazard ? 4.0 : 8.0;
  if (waterHazard && !mudHazard && e._stuckTime > 1.0 && e._stuckTime < abandonAfter) {
    if (!e._fleeing || !e.moveTarget) {
      const dry = findDryEscape(t, tx, ty);
      if (dry) {
        e._fleeing = true;
        e.order = e.order.type === 'idle' || e.order.type === 'guard' ? { type: 'move' } : e.order;
        setMoveGoal(world, e, dry[0] * 2 + 1, dry[1] * 2 + 1);
      }
    }
    return false;
  }
  if (e._stuckTime < abandonAfter) return false;
  abandonVehicle(world, e);
  return true;
}

// Nächste trockene, befahrbare Zelle (Spiralsuche) als Fluchtziel.
function findDryEscape(t, tx, ty) {
  for (let r = 1; r <= 10; r++) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
      const nx = tx + x, ny = ty + y;
      if (!inBounds(t, nx, ny)) continue;
      const i = tIdx(t, nx, ny);
      if (t.water[i] <= FLOOD_DEPTH * 0.3 && isPassable(t, 'land', nx, ny)) return [nx, ny];
    }
  }
  return null;
}

function abandonVehicle(world, e) {
  e.abandoned = true;
  e.owner = -1;
  e.order = { type: 'abandoned' };
  e.target = null;
  e._v = 0;
  stopMove(e);
  world.events.push({ type: 'abandoned', x: e.x, y: e.y, kind: e.kind });
}

function applyFogNavalDrift(world, e, weather, ctx, cty) {
  if (weather !== 'fog' || e.category !== 'naval') { e._fogDrift = null; return null; }
  const t = world.terrain;
  if (!inBounds(t, ctx, cty) || t.water[tIdx(t, ctx, cty)] <= WET_DEPTH) return null;
  if (!e.moveTarget) return null;
  if (!e._fogDrift || e._fogDrift.left <= 0) {
    const a = hashAngle(e.id, world.tick);
    e._fogDrift = {
      x: Math.cos(a),
      y: Math.sin(a),
      left: 2.4 + ((e.id * 17 + world.tick) % 23) / 10,
    };
  }
  e._fogDrift.left -= DT;
  return { x: e._fogDrift.x * FOG_NAVAL_DRIFT * DT, y: e._fogDrift.y * FOG_NAVAL_DRIFT * DT };
}

function hashAngle(id, tick) {
  const n = Math.sin(id * 12.9898 + tick * 0.071) * 43758.5453;
  return (n - Math.floor(n)) * Math.PI * 2;
}

function stampVehicleTrack(world, e, ox, oy) {
  if (e.domain !== 'land' || e.category !== 'vehicle') return;
  const moved = Math.hypot(e.x - ox, e.y - oy);
  if (moved < 0.04) return;
  const t = world.terrain;
  const [tx, ty] = worldToTile(e.x, e.y);
  if (!inBounds(t, tx, ty)) return;
  const i = tIdx(t, tx, ty);
  if (roadAtIdx(t, i) || waterBlocksLand(t, i)) return;
  if (t.tracks) {
    const gain = moved * (e.heavy ? TRACK_GAIN_HEAVY : TRACK_GAIN_LIGHT);
    t.tracks[i] = Math.min(1, t.tracks[i] + gain);
    t.trackDir[i] = Math.round((((e.facing + Math.PI) / (Math.PI * 2)) * 8)) & 7;
  }
  if (e.heavy && t.mud && t.tracks && t.tracks[i] > 0.2 && t.water[i] > WET_DEPTH) {
    t.mud[i] = Math.min(1, t.mud[i] + moved * MUD_GAIN_HEAVY * (1 + t.tracks[i]));
  }
  if (t.waterActive && (t.tracks?.[i] > 0.15 || t.mud?.[i] > 0.05)) t.waterActive.add(i);
}

// Leichte Separation, damit Einheiten sich nicht stapeln (über Spatial-Hash).
function separation(world) {
  const { spatial } = world;
  if (!spatial) return;
  const { grid, cell } = spatial;
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || e.dead || e.domain === 'air') continue;
    const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell);
    let px = 0, py = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const b = grid.get((cx + x) + ',' + (cy + y)); if (!b) continue;
      for (const o of b) {
        if (o === e || o.etype !== 'unit' || o.domain === 'air') continue;
        const ddx = e.x - o.x, ddy = e.y - o.y;
        const dd = ddx * ddx + ddy * ddy;
        const want = desiredSpacing(e, o);
        if (dd < want * want) {
          if (dd <= 1e-6) {
            const a = hashAngle(e.id, o.id);
            px += Math.cos(a) * 0.45; py += Math.sin(a) * 0.45;
          } else {
            const dist = Math.sqrt(dd);
            const push = (want - dist) / want;
            px += (ddx / dist) * push;
            py += (ddy / dist) * push;
          }
        }
      }
    }
    const mag = Math.hypot(px, py);
    if (mag > 0) {
      // Separation darf Einheiten nicht in unpassierbares Gelände drücken (z. B. Schiffe an Land).
      // Fahrzeuge nur sanft schieben — starke Seitwärts-Schübe sehen aus wie Seitwärtsfahren.
      const isVeh = e.category !== 'infantry';
      const strength = e.moveTarget ? (isVeh ? 0.1 : 0.22) : (isVeh ? 0.06 : 0.12);
      const step = Math.min(isVeh ? 0.1 : 0.28, mag * strength);
      const nx = e.x + (px / mag) * step, ny = e.y + (py / mag) * step;
      const [stx, sty] = worldToTile(nx, ny);
      if (isPassable(world.terrain, e.domain, stx, sty) && !forestBlocks(world.terrain, e.domain, stx, sty, { category: e.category })) { e.x = nx; e.y = ny; }
    }
  }
}

function desiredSpacing(a, b) {
  if (a.category === 'vehicle' || b.category === 'vehicle' || a.heavy || b.heavy) return 2.1;
  if (a.domain === 'water' || b.domain === 'water') return 2.4;
  return 1.35;
}
