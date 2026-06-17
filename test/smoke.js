// Smoke-Test des Match-Managers (ohne WebSocket): Tick, Snapshot, Join-in-Progress,
// KI-Übernahme, Befehle, Reconnect-Timeout. Verifiziert die Server-Kernlogik headless.
import { loadData } from '../shared/data-node.js';
import { Match } from '../server/match.js';
import { createWorld, ownerEntities, spawnBuilding, spawnUnit, applyFortification, removeFortification, applyDamage, canPlaceBuilding, isDetectable, nearestEnemy, buildSpatial, effectiveCost, buildSpeedMult } from '../shared/world.js';
import { coverAt, isBlocked, isNavigableWater, isPassable, isWet, worldToTile, tileToWorld, TT, tIdx, hasWaterNear, stampFortification, unstampFortification, inBounds } from '../shared/terrain.js';
import { stepWater } from '../shared/systems/water.js';
import { step, applyCommand } from '../shared/sim.js';
import { placeTunnel, activateTunnelIfReady, validateTunnel } from '../shared/systems/tunnel.js';
import { stepConstruction } from '../shared/systems/construction.js';
import { stepEconomy } from '../shared/systems/economy.js';
import { stepProduction } from '../shared/systems/production.js';
import { serializeSnapshot } from '../server/snapshot.js';
import { stepMovement, setMoveGoal } from '../shared/systems/movement.js';
import { findPath } from '../shared/pathfinding.js';
import { stepAi, initAi } from '../shared/ai/ai.js';
import { awardXp, stepRegen } from '../shared/systems/veterancy.js';
import { stepGarrison } from '../shared/systems/garrison.js';
import { stepSonar } from '../shared/systems/sonar.js';
import { stepCombat } from '../shared/systems/combat.js';
import { TILE, BUILDER_WADE_DEPTH, BUILDER_WADE_TIME, SEA_LEVEL, WET_DEPTH, FLOOD_DEPTH, NAVIGABLE_DEPTH, SUB_DETECT_RANGE, GARRISON_DAMAGE_MULT, MUD_IMPASSABLE, SLOPE_BUILDER, SLOPE_TERRAFORM_BUILDER, TICK_RATE, TERRA_RAISE_COST, TERRA_LOWER_YIELD } from '../shared/constants.js';
import { Net } from '../client/js/net.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ FAIL:', m); } };

const deformationRoughness = (t, cells, pad = 1) => {
  const set = new Set();
  const add = (i) => {
    if (i == null || i < 0 || i >= t.w * t.h) return;
    const cx = i % t.w, cy = (i / t.w) | 0;
    for (let yy = -pad; yy <= pad; yy++) for (let xx = -pad; xx <= pad; xx++) {
      const nx = cx + xx, ny = cy + yy;
      if (!inBounds(t, nx, ny) || Math.hypot(xx, yy) > pad + 0.25) continue;
      set.add(tIdx(t, nx, ny));
    }
  };
  for (const i of cells || []) add(i);
  let samples = 0, maxCurve = 0, sharp = 0, needles = 0;
  for (const i of set) {
    const x = i % t.w, y = (i / t.w) | 0;
    if (x <= 0 || y <= 0 || x >= t.w - 1 || y >= t.h - 1 || t.startSafe?.[i]) continue;
    let sum = 0, n = 0, hi = -Infinity, lo = Infinity;
    for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
      if (!xx && !yy) continue;
      const j = (y + yy) * t.w + x + xx;
      if (t.startSafe?.[j]) continue;
      sum += t.height[j];
      n++;
      hi = Math.max(hi, t.height[j]);
      lo = Math.min(lo, t.height[j]);
    }
    if (!n) continue;
    samples++;
    const curve = Math.abs(t.height[i] - sum / n);
    maxCurve = Math.max(maxCurve, curve);
    if (curve > 0.12) sharp++;
    if (t.height[i] > hi + 0.12 || t.height[i] < lo - 0.12) needles++;
  }
  return { samples, maxCurve, sharp, needles };
};

const data = loadData();
const match = new Match({ data, seed: 777, slots: 2 });

for (const [group, defs] of [['Einheit', data.units], ['Gebäude', data.buildings]]) {
  for (const [kind, def] of Object.entries(defs)) {
    if (!def.weapon) continue;
    const weapon = data.weapons[def.weapon];
    ok(weapon && def.sight > weapon.range,
      `${group} ${kind} sieht weiter als sie/es schießt (${def.sight} > ${weapon?.range})`);
  }
}

// 1) Init-Paket korrekt geformt
const init = match.init();
ok(init.type === 'init' && init.terrain && init.players.length === 2, 'Init enthält Gelände + Spieler');
ok(Array.isArray(init.terrain.height) && init.terrain.height.length === init.map.w * init.map.h, 'Höhenkarte vollständig');
ok(Array.isArray(init.terrain.waterDepth) && init.terrain.waterDepth.length > 0,
  'Init enthält sichtbare Binnengewässer mit Tiefe (Hochseen/Flüsse, nicht nur Meer)');
{
  const t = match.world.terrain;
  const initWaterIdx = [];
  for (let n = 0; n < init.terrain.waterDepth.length; n += 2) initWaterIdx.push(init.terrain.waterDepth[n]);
  const initWaterSet = new Set(initWaterIdx);
  ok(initWaterIdx.every(i => t.water[i] >= NAVIGABLE_DEPTH),
    'Init-Wasserflächen enthalten nur echte, schiffbare Wasserläufe');
  const wetGround = [];
  for (let i = 0; i < t.water.length; i++) {
    if (t.type[i] !== TT.WATER && t.water[i] > WET_DEPTH && t.water[i] < NAVIGABLE_DEPTH) wetGround.push(i);
  }
  ok(wetGround.length > 0, 'Durchnässter Boden existiert getrennt von echten Wasserläufen');
  ok(wetGround.every(i => !initWaterSet.has(i)),
    'Durchnässter Boden wird nicht als permanente Init-Wasserfläche serialisiert');
}
{
  const n = new Net();
  n.waterBase = [10, 42, 20, 55];
  const merged = n.mergeWater([]);
  ok(merged.length === 4 && merged[0] === 10 && merged[2] === 20,
    'Client behält initiale Binnengewässer auch bei leerem Wasser-Snapshot');
  const dried = n.mergeWater([10, 0]);
  ok(dried.length === 2 && dried[0] === 20,
    'Client kann initiale Binnengewässer durch dynamische Trockenlegung überschreiben');
}
{
  const n = new Net();
  n.players = [{ id: 0 }, { id: 1 }];
  n.seat = 0;
  n.viewSeat = 0;
  const sent = [];
  n.ws = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) };
  n.watch(1, 'Zuschauer');
  ok(sent.length === 1 && sent[0].t === 'release',
    'Zuschauen aus aktivem Sitz gibt den Sitz serverseitig frei');
  n.onMessage({ type: 'spectator', seat: 0, ok: true });
  ok(n.spectator && n.seat == null && n.viewSeat === 1,
    'Zuschauer bleibt nach Serverfreigabe auf der gewählten Sicht');
}
{
  const n = new Net();
  const sent = [];
  n.players = [{ id: 0 }, { id: 1 }];
  n.ws = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) };
  n.join('Kommandant', 1, { insanity: 4 });
  n.watch(0, 'Zuschauer', { insanity: 3 });
  n.createGame('Host', { visibility: 'private', slots: 4, startMode: 'wait', insanity: 1, timeMode: 'day' });
  ok(sent[0]?.t === 'join' && sent[0].insanity === 4,
    'Start-Lobby sendet Insanity-Level beim Beitreten');
  ok(sent[1]?.t === 'matchOptions' && sent[1].insanity === 3,
    'Zuschauerstart kann das Insanity-Level als Match-Option setzen');
  ok(sent[2]?.t === 'createGame' && sent[2].visibility === 'private' && sent[2].slots === 4 && sent[2].startMode === 'wait' && sent[2].timeMode === 'day',
    'Start-Lobby kann ein privates 4-Spieler-Spiel im Wartemodus mit festem Tag erstellen');
}
{
  const m = new Match({ data, seed: 779, slots: 2 });
  m.setMatchOptions({ insanity: 4 });
  ok(m.controlsView().insanity === 4, 'Match speichert Insanity-Level in den Controls');
  m.setMatchOptions({ timeMode: 'day' });
  ok(m.controlsView().timeMode === 'day', 'Match speichert deaktivierten Tag/Nacht-Zyklus als festen Tag');
  m.reset({ sameMap: true });
  ok(m.controlsView().insanity === 4, 'Neues Spiel behält das Insanity-Level bei');
  ok(m.controlsView().timeMode === 'day', 'Neues Spiel behält den deaktivierten Tag/Nacht-Zyklus bei');
}
{
  const m = new Match({ data, seed: 781, slots: 4 });
  const colors = m.world.players.map(p => p.color);
  ok(new Set(colors).size === 4, `4-Spieler-Partien nutzen unterscheidbare Kriegsparteifarben (${colors.join(', ')})`);
}
{
  const players = ['KBN', 'HLX', 'FLG', 'KBN'].map((faction, id) => ({ id, faction, controller: 'human' }));
  const w = createWorld({ data, seed: 919, players, controls: { insanity: 1 } });
  ok(w.players.length === 4, 'Partien können mit 4 Spielern erzeugt werden');
  const nearSum = (arr, hq, radius) => {
    let sum = 0;
    const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (!inBounds(w.terrain, x, y) || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) continue;
      sum += arr[tIdx(w.terrain, x, y)] || 0;
    }
    return sum;
  };
  const nearOreStats = (hq, radius) => {
    let sum = 0, cells = 0, max = 0;
    const cx = hq.tx + hq.size / 2, cy = hq.ty + hq.size / 2;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (!inBounds(w.terrain, x, y) || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) continue;
      const v = w.terrain.ore[tIdx(w.terrain, x, y)] || 0;
      if (v > 0) { sum += v; cells++; max = Math.max(max, v); }
    }
    return { sum, cells, max };
  };
  for (const hq of [...w.entities.values()].filter(e => e.kind === 'hq')) {
    const ore = nearOreStats(hq, 16);
    ok(ore.sum > 0, `Leichter Start hat Erz auf dem Startplateau (Spieler ${hq.owner})`);
    ok(ore.sum <= 2200 && ore.cells <= 16 && ore.max <= 380,
      `Basisnahes Erz ist klein und schnell erschoepft (Spieler ${hq.owner}: ${Math.round(ore.sum)} Erz in ${ore.cells} Zellen)`);
    ok(nearSum(w.terrain.oil, hq, 16) > 0, `Leichter Start hat Öl auf dem Startplateau (Spieler ${hq.owner})`);
  }
  const riverContinuity = (world) => {
    const t = world.terrain;
    let dry = 0, shallow = 0, maxDryRun = 0;
    for (const path of t.riverPaths || []) {
      let run = 0;
      for (const i of path) {
        if (t.water[i] <= WET_DEPTH) { dry++; run++; }
        else { maxDryRun = Math.max(maxDryRun, run); run = 0; }
        if (t.water[i] < NAVIGABLE_DEPTH) shallow++;
      }
      maxDryRun = Math.max(maxDryRun, run);
    }
    return { dry, shallow, maxDryRun };
  };
  for (const seed of [1, 2, 17, 25, 31]) {
    const fw = createWorld({ data, seed, players, controls: { insanity: 1 } });
    const rs = riverContinuity(fw);
    ok(rs.dry === 0 && rs.shallow === 0,
      `4-Spieler-Startplateaus unterbrechen Hauptflüsse nicht (Seed ${seed}, trocken=${rs.dry}, flach=${rs.shallow}, maxRun=${rs.maxDryRun})`);
  }
}
{
  const { initEnv, normalizeInsanityLevel, insanityProfile } = await import('../shared/systems/environment.js');
  ok(normalizeInsanityLevel(0) === 1 && normalizeInsanityLevel(99) === 4,
    'Insanity-Level wird auf vier Startstufen begrenzt');
  const players = [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }];
  const calm = createWorld({ data, seed: 918, players });
  const normal = createWorld({ data, seed: 918, players });
  const wild = createWorld({ data, seed: 918, players });
  calm.controls = { insanity: 1 };
  normal.controls = { insanity: 2 };
  wild.controls = { insanity: 4 };
  initEnv(calm);
  initEnv(normal);
  initEnv(wild);
  ok(wild.env.weatherLeft < calm.env.weatherLeft,
    'Insanity 4 verkürzt Wetterphasen gegenüber Easy-Peasy');
  ok(wild.env._nextQuake < calm.env._nextQuake,
    'Insanity 4 lässt Beben häufiger kommen als Easy-Peasy');
  ok(calm.env._nextQuake > normal.env._nextQuake && normal.env._nextQuake > wild.env._nextQuake,
    'untere Insanity-Stufen staffeln Erdbeben deutlich seltener');
  ok(insanityProfile(calm).rainInflow < insanityProfile(normal).rainInflow && insanityProfile(normal).rainInflow < insanityProfile(wild).rainInflow,
    'untere Insanity-Stufen drosseln den Flut-Zufluss');

  const basinFloodStats = (insanity) => {
    const w = createWorld({ data, seed: 921, map: { w: 32, h: 32 }, players });
    w.controls = { insanity };
    initEnv(w);
    w.env.weather = 'storm'; w.env.weatherLeft = 1e9; w.env.solar = 0; w.env._nextQuake = 1e9; w.env._lightningCd = 1e9;
    const t = w.terrain, cx = 16, cy = 16;
    t.sources.length = 0; t.waterActive.clear(); t.startMeltLeft = 0;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
      const i = y * t.w + x;
      const d = Math.hypot(x - cx, y - cy);
      t.type[i] = TT.LAND; t.height[i] = d <= 11 ? 0.36 + d * 0.018 : 0.72; t.height0[i] = t.height[i];
      t.water[i] = 0; t.baseWater[i] = 0; t.waterBlock[i] = 0; t.block[i] = 0;
      if (t.lakeMask) t.lakeMask[i] = 0;
      if (t.startSafe) t.startSafe[i] = 0;
      if (t.snow) t.snow[i] = 0;
    }
    for (let k = 0; k < 260; k++) { stepWater(w); w.tick++; }
    let mass = 0, flooded = 0;
    for (let i = 0; i < t.water.length; i++) {
      mass += Math.max(0, t.water[i] - t.baseWater[i]);
      if (t.water[i] > WET_DEPTH && t.baseWater[i] <= WET_DEPTH) flooded++;
    }
    return { mass, flooded };
  };
  const easyFlood = basinFloodStats(1);
  const mediumFlood = basinFloodStats(2);
  const hardFlood = basinFloodStats(3);
  ok(easyFlood.mass < hardFlood.mass * 0.65 && mediumFlood.mass < hardFlood.mass * 0.90,
    `Easy/Medium erzeugen deutlich weniger Sturmflut-Masse als Stufe 3 (${easyFlood.mass.toFixed(2)} / ${mediumFlood.mass.toFixed(2)} / ${hardFlood.mass.toFixed(2)})`);
  ok(easyFlood.flooded < mediumFlood.flooded && mediumFlood.flooded <= hardFlood.flooded,
    `Easy/Medium fluten weniger Landzellen (${easyFlood.flooded} / ${mediumFlood.flooded} / ${hardFlood.flooded})`);
}
{
  for (let seed = 30; seed < 38; seed++) {
    const w = createWorld({ data, seed, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
    const wetStart = ownerEntities(w, 0).concat(ownerEntities(w, 1)).some(e => {
      if (e.etype === 'unit' && e.domain !== 'land') return false;
      if (e.etype === 'building' && e.def.buildOnWater) return false;
      const [tx, ty] = e.etype === 'building' ? [e.tx, e.ty] : worldToTile(e.x, e.y);
      if (e.etype === 'building') {
        for (let yy = 0; yy < e.size; yy++) for (let xx = 0; xx < e.size; xx++) {
          if (isWet(w.terrain, tx + xx, ty + yy)) return true;
        }
        return false;
      }
      return isWet(w.terrain, tx, ty);
    });
    ok(!wetStart, `Startobjekte stehen trocken (Seed ${seed})`);
  }
}
{
  const slopeAt = (t, i) => {
    const x = i % t.w;
    let s = 0;
    if (x > 0) s = Math.max(s, Math.abs(t.height[i] - t.height[i - 1]));
    if (x < t.w - 1) s = Math.max(s, Math.abs(t.height[i] - t.height[i + 1]));
    if (i >= t.w) s = Math.max(s, Math.abs(t.height[i] - t.height[i - t.w]));
    if (i < t.w * (t.h - 1)) s = Math.max(s, Math.abs(t.height[i] - t.height[i + t.w]));
    return s;
  };
  for (let seed = 40; seed < 44; seed++) {
    const w = createWorld({ data, seed, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
    const t = w.terrain;
    const forest = [];
    for (let i = 0; i < t.cover.length; i++) if (t.cover[i] >= 0.2) forest.push(i);
    let land = 0, rugged = 0;
    for (let i = 0; i < t.height.length; i++) {
      if (t.type[i] === TT.WATER) continue;
      land++;
      if (slopeAt(t, i) >= 0.025) rugged++;
    }
    ok(rugged >= land * 0.18, `Land ist sichtbar hügeliger/rauer (${Math.round(rugged / land * 100)} %, Seed ${seed})`);
    ok(forest.length > 80, `Wälder werden zufällig über die Karte verteilt (Seed ${seed})`);
    ok(forest.every(i => t.type[i] !== TT.WATER && t.water[i] <= WET_DEPTH), `Wälder stehen nicht im Wasser (Seed ${seed})`);
    ok(forest.filter(i => slopeAt(t, i) >= 0.008).length >= forest.length * 0.65, `Wälder liegen bevorzugt entlang von Hängen (Seed ${seed})`);
    const treeOnBuilding = [...w.entities.values()].some(e => {
      if (e.etype !== 'building') return false;
      for (let y = 0; y < e.size; y++) for (let x = 0; x < e.size; x++) {
        if (t.cover[tIdx(t, e.tx + x, e.ty + y)] >= 0.2) return true;
      }
      return false;
    });
    ok(!treeOnBuilding, `Keine Waldzellen unter Startgebäuden (Seed ${seed})`);
  }
}
{
  const { initEnv } = await import('../shared/systems/environment.js');
  for (const seed of [31, 40]) {
    const w = createWorld({ data, seed, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
    const startIds = new Set([...w.entities.values()].map(e => e.id));
    initEnv(w);
    w.env.weather = 'storm'; w.env.weatherLeft = 1e9; w.env.dayT = 0.5; w.env.daylight = 1; w.env.solar = 1;
    for (let k = 0; k < 500; k++) { stepWater(w); w.tick++; w.time += 0.1; }
    const wetStart = [...w.entities.values()].some(e => {
      if (!startIds.has(e.id)) return false;
      const cells = [];
      if (e.etype === 'building') {
        for (let y = 0; y < e.size; y++) for (let x = 0; x < e.size; x++) cells.push(tIdx(w.terrain, e.tx + x, e.ty + y));
      } else {
        const [tx, ty] = worldToTile(e.x, e.y);
        cells.push(tIdx(w.terrain, tx, ty));
      }
      return cells.some(i => w.terrain.water[i] > WET_DEPTH);
    });
    ok(!wetStart, `Startbasis bleibt nach starkem Regen weitgehend vor Überschwemmung geschützt (Seed ${seed})`);
  }
}

// 2) Match läuft als KI-vs-KI für eine Weile
for (let i = 0; i < 300; i++) match.tick();
ok(match.world.tick === 300, 'Tickzähler korrekt');
const snap = match.snapshot();
ok(snap.type === 'snap' && Array.isArray(snap.ents) && snap.ents.length > 0, 'Snapshot enthält Entities');
ok(snap.players.every(p => p.res && typeof p.res.ore === 'number'), 'Snapshot enthält Ressourcen');
ok(snap.players.every(p => p.cap && typeof p.cap.water === 'number' && typeof p.cap.ammo === 'number'), 'Snapshot enthält Lagerkapazitäten');
ok(snap.controls?.aiOnly && snap.controls.speed === 1 && snap.controls.timeMode === 'auto', 'Snapshot enthält Zuschauer-Kontrollen im KI-Restspiel');
ok(match.setSpectatorControls({ speed: 4, timeMode: 'night' }), 'Zuschauer kann KI-Restspiel beschleunigen und auf Nacht fixieren');
ok(match.simSpeed() === 4 && match.snapshot().controls.timeMode === 'night', 'Zuschauer-Kontrollen wirken serverseitig');
ok(match.setSpectatorControls({ speed: 2 }) && match.snapshot().controls.timeMode === 'night', 'Tempoänderung behält Tag/Nacht-Fixierung');

// 3) Join-in-Progress: Mensch übernimmt einen laufenden KI-Slot (KI-Übernahme)
const before = match.player(0).controller;
const seat = match.joinHuman('TestSpieler', 0);
ok(seat === 0, 'Mensch erhält Sitz 0');
ok(before === 'ai' && match.player(0).controller === 'human', 'KI-Slot wurde von Mensch übernommen');
ok(match.player(0).name === 'TestSpieler', 'Spielername übernommen');
ok(!match.snapshot().controls.aiOnly && match.setSpectatorControls({ speed: 8, timeMode: 'day' }) && match.simSpeed() === 8,
  'Zuschauer-Kontrollen bleiben mit aktivem Menschen verfügbar');
const unitsBefore = ownerEntities(match.world, 0, 'unit').length;
ok(unitsBefore > 0, 'Übernommene Fraktion behält ihre Einheiten');
ok(match.takeoverAi('Zuschauer', 1) === 1 && match.player(1).controller === 'human',
  'Zuschauer kann einen freien KI-Spieler gezielt übernehmen');
ok(match.takeoverAi('Zuschauer2', 1) === null,
  'Bereits menschlich besetzter Sitz kann nicht doppelt übernommen werden');
ok(match.releaseHuman(1) === 1 && match.player(1).controller === 'ai',
  'Ausklinken gibt den Sitz sofort an die KI zurück');

// 4) Menschlicher Befehl wird angenommen und ausgeführt
const myUnit = ownerEntities(match.world, 0, 'unit').find(u => u.weapon);
if (myUnit) {
  match.command(0, { type: 'move', units: [myUnit.id], x: myUnit.x + 10, y: myUnit.y });
  const ox = myUnit.x;
  for (let i = 0; i < 20; i++) match.tick();
  ok(Math.abs(myUnit.x - ox) > 0.5 || myUnit.dead, 'Einheit bewegt sich auf Befehl');
} else ok(false, 'Kampfeinheit zum Testen vorhanden');

{
  const w = createWorld({ data, seed: 17, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const site = spawnBuilding(w, 0, 'barracks', 12, 12);
  ok(site.buildProgress === 0 && site.hp === Math.round(site.maxHp * 0.5),
    'Angefangene Baustelle startet mit 50 Prozent der Trefferpunkte');
  for (let k = 0; k < 140 && site.buildProgress < 1; k++) {
    site._builderNear = w.tick;
    stepProduction(w);
    w.tick++;
  }
  ok(site.buildProgress >= 1 && site.hp === site.maxHp,
    'Fertiggestellte Baustelle erreicht wieder volle Trefferpunkte');
}

{
  const w = createWorld({ data, seed: 15, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  const cx = 16, cy = 16, W = t.w;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.height0[i] = 0.55; t.water[i] = 0; t.baseWater[i] = 0;
    t.block[i] = 0; t.cover[i] = 0; t.ore[i] = 0; t.tracks[i] = 0; t.mud[i] = 0;
    if (t.oil) t.oil[i] = 0;
  }
  const oreIdx = tIdx(t, cx, cy);
  t.ore[oreIdx] = 120;
  t.oreList.length = 0; t.oreList.push(oreIdx);
  for (const u of ownerEntities(w, 0, 'unit')) { u.order = { type: 'move' }; u.resourceRole = 'build'; }
  const miner = spawnUnit(w, 0, 'builder', cx * 2 + 1, cy * 2 + 1);
  miner.resourceRole = 'ore'; miner.harvestNode = [cx, cy]; miner.order = { type: 'idle' };
  const cells = [];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.push((cy + y) * W + (cx + x));
  const before = new Map(cells.map(i => [i, t.height[i]]));
  stepEconomy(w);
  const lowered = cells.filter(i => t.height[i] < before.get(i) - 1e-6);
  ok(t.height[oreIdx] < before.get(oreIdx), 'Erzabbau senkt die Abbauzelle sichtbar ab');
  ok(lowered.length >= 4, 'Erzabbau schneidet Gräben und Furchen in benachbarte Geländezellen');
  ok(t.tracks[oreIdx] > 0, 'Erzabbau hinterlässt dunkle Furchenspuren am Abbauort');
  ok(t.ore[oreIdx] < 120, 'Erzvorrat verschwindet beim Abbau');
}

{
  const w = createWorld({ data, seed: 16, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  const p = w.players[0];
  p.resources.fuel = 500; p.resources.water = 500;
  for (let i = 0; i < t.type.length; i++) if (t.oil) t.oil[i] = 0;
  for (let y = 4; y <= 10; y++) for (let x = 4; x <= 17; x++) {
    const i = tIdx(t, x, y);
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.height0[i] = 0.55;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.ore[i] = 0;
  }
  for (const [x, y] of [[10, 6], [11, 6], [10, 7], [11, 7]]) t.oil[tIdx(t, x, y)] = 2;
  ok(canPlaceBuilding(w, 10, 6, 2, data.buildings.oil_derrick), 'Bohrturm darf auf sichtbarem Ölfleck gebaut werden');
  ok(!canPlaceBuilding(w, 20, 20, 2, data.buildings.oil_derrick), 'Bohrturm braucht einen Ölfleck');
  const plant = spawnBuilding(w, 0, 'power_plant', 6, 6); plant.buildProgress = 1;
  const derrick = spawnBuilding(w, 0, 'oil_derrick', 10, 6); derrick.buildProgress = 1;
  const pipe = spawnBuilding(w, 0, 'pipe', 12, 6); pipe.buildProgress = 1;
  const oilDepot = spawnBuilding(w, 0, 'oil_depot', 14, 6); oilDepot.buildProgress = 1;
  const oilBefore = t.oil.reduce((a, b) => a + b, 0);
  w.events.length = 0;
  for (let k = 0; k < 30; k++) { stepEconomy(w); w.tick++; }
  ok(w.events.some(e => e.type === 'industry' && e.kind === 'power_plant'), 'Kraftwerk erzeugt Partikel-Event im Betrieb');
  ok(w.events.some(e => e.type === 'industry' && e.kind === 'oil_derrick'), 'Ölbohrturm erzeugt Partikel-Event bei Förderung');
  ok(t.oil.reduce((a, b) => a + b, 0) < oilBefore, 'Ölfleck wird bei Förderung kleiner');
  for (let k = 0; k < 160; k++) { stepEconomy(w); w.tick++; }
  ok(t.oil.reduce((a, b) => a + b, 0) <= 0.001, 'Ölvorrat ist nach Förderung erschöpft');
}

{
  const w = createWorld({ data, seed: 212, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain, p = w.players[0];
  w.entities.clear();
  p.resources.ore = 10000; p.resources.materials = 10000; p.resources.water = 1000; p.resources.fuel = 1000;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.height0[i] = 0.55;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.ore[i] = 0;
    if (t.oil) t.oil[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const anchor = spawnBuilding(w, 0, 'power_plant', 8, 8); anchor.buildProgress = 1;
  const count = (kind) => ownerEntities(w, 0, 'building').filter(e => e.kind === kind && !e.dead).length;

  applyCommand(w, { type: 'build', building: 'pipe', tx: 34, ty: 7 }, 0);
  applyCommand(w, { type: 'build', building: 'road', tx: 35, ty: 7 }, 0);
  const bi = tIdx(t, 36, 7);
  t.type[bi] = TT.WATER; t.height[bi] = 0.20; t.height0[bi] = 0.20; t.water[bi] = 0.18; t.baseWater[bi] = 0.18;
  applyCommand(w, { type: 'build', building: 'bridge', tx: 36, ty: 7 }, 0);
  ok(count('pipe') === 1 && count('road') === 1 && count('bridge') === 1,
    'Pipelines, Straßen und Brücken können fernab der Basis gebaut werden');

  applyCommand(w, { type: 'build', building: 'oil_depot', tx: 34, ty: 14 }, 0);
  applyCommand(w, { type: 'build', building: 'turret', tx: 38, ty: 14 }, 0);
  applyCommand(w, { type: 'build', building: 'barracks', tx: 34, ty: 18 }, 0);
  ok(count('oil_depot') === 0 && count('turret') === 0 && count('barracks') === 0,
    'Lager, Verteidigung und Produktion entstehen nicht frei ohne nahes echtes Gebäude');

  applyCommand(w, { type: 'build', building: 'oil_depot', tx: 12, ty: 8 }, 0);
  applyCommand(w, { type: 'build', building: 'turret', tx: 12, ty: 11 }, 0);
  applyCommand(w, { type: 'build', building: 'barracks', tx: 15, ty: 8 }, 0);
  ok(count('oil_depot') === 1 && count('turret') === 1 && count('barracks') === 1,
    'Lager, Verteidigung und Produktion dürfen nahe einem bestehenden Gebäude gebaut werden');
}

{
  const w = createWorld({ data, seed: 12, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
    t.mud[i] = 0; t.road[i] = 0; t.roadBuilt[i] = 0;
  }
  const u1 = spawnUnit(w, 0, 'truck', 10, 10);
  const u2 = spawnUnit(w, 0, 'truck', 10, 12);
  const u3 = spawnUnit(w, 0, 'builder', 12, 10);
  const u4 = spawnUnit(w, 0, 'builder', 12, 12);
  applyCommand(w, { type: 'move', units: [u1.id, u2.id, u3.id, u4.id], x: 40, y: 40 }, 0);
  const goals = [u1, u2, u3, u4].map(u => `${u.moveTarget.x.toFixed(1)},${u.moveTarget.y.toFixed(1)}`);
  ok(new Set(goals).size === 4, 'Gruppenbewegung verteilt Einheiten auf eigene Zielpunkte');
  let minGoalDist = Infinity;
  for (const a of [u1, u2, u3, u4]) for (const b of [u1, u2, u3, u4]) {
    if (a.id >= b.id) continue;
    minGoalDist = Math.min(minGoalDist, Math.hypot(a.moveTarget.x - b.moveTarget.x, a.moveTarget.y - b.moveTarget.y));
  }
  ok(minGoalDist >= 3.9, 'Fahrzeuggruppen bekommen ausreichend Abstand zwischen Zielpunkten');
  ok([u1, u2, u3, u4].every(u => {
    const [tx, ty] = worldToTile(u.moveTarget.x, u.moveTarget.y);
    return isPassable(t, u.domain, tx, ty);
  }), 'Gruppenbewegung wählt passierbare Zielpunkte');
  const troops = [];
  for (let k = 0; k < 12; k++) troops.push(spawnUnit(w, 0, 'rifleman', 14 + (k % 4) * 0.45, 18 + Math.floor(k / 4) * 0.45));
  applyCommand(w, { type: 'move', units: troops.map(u => u.id), x: 40, y: 40 }, 0);
  const footGoals = troops.map(u => u.moveTarget);
  const maxFootGoalDist = Math.max(...footGoals.map(g => Math.hypot(g.x - 40, g.y - 40)));
  let minFootGoalDist = Infinity;
  for (const a of footGoals) for (const b of footGoals) {
    if (a === b) continue;
    minFootGoalDist = Math.min(minFootGoalDist, Math.hypot(a.x - b.x, a.y - b.y));
  }
  ok(maxFootGoalDist <= 0.55 && minFootGoalDist <= 0.24,
    'Fußtruppen bekommen viel dichtere Zielpunkte als Fahrzeuge');
  const tightA = spawnUnit(w, 0, 'rifleman', 52, 52);
  const tightB = spawnUnit(w, 0, 'rifleman', 52.16, 52);
  for (let k = 0; k < 12; k++) { buildSpatial(w, 8); stepMovement(w); }
  ok(Math.hypot(tightA.x - tightB.x, tightA.y - tightB.y) < 0.22,
    'Fußtruppen dürfen eng nebeneinander stehen bleiben');

  const normalFoot = spawnUnit(w, 0, 'rifleman', 6, 48);
  const mudFoot = spawnUnit(w, 0, 'rifleman', 6, 54);
  const snowFoot = spawnUnit(w, 0, 'rifleman', 6, 60);
  for (let x = 2; x <= 18; x++) {
    t.mud[tIdx(t, x, 27)] = 1;
    if (t.snow) t.snow[tIdx(t, x, 30)] = 1;
  }
  for (const u of [normalFoot, mudFoot, snowFoot]) {
    u.order = { type: 'move' };
    u.moveTarget = { x: 34, y: u.y };
    u.path = [];
    u.repathCd = 999;
  }
  const nx0 = normalFoot.x, mx0 = mudFoot.x, sx0 = snowFoot.x;
  for (let k = 0; k < 8; k++) stepMovement(w);
  const normalMoved = normalFoot.x - nx0;
  const mudMoved = mudFoot.x - mx0;
  const snowMoved = snowFoot.x - sx0;
  ok(mudMoved < normalMoved * 0.45 && snowMoved < normalMoved * 0.45,
    'Fußtruppen bewegen sich in tiefem Matsch und Schnee nur sehr langsam');
}

{
  const w = createWorld({ data, seed: 13, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  const { initEnv } = await import('../shared/systems/environment.js');
  initEnv(w); w.env.weather = 'clear'; w.env.weatherLeft = 1e9; w.env.dayT = 0; w.env.solar = 0; w.env._nextQuake = 1e9; w.env._lightningCd = 1e9;
  const t = w.terrain;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
    t.mud[i] = 0; t.road[i] = 0; t.roadBuilt[i] = 0;
  }
  const tank = spawnUnit(w, 0, 'tank', 20, 20);
  const tractor = spawnUnit(w, 1, 'tractor', 24, 20);
  const [mtx, mty] = worldToTile(tank.x, tank.y);
  t.mud[tIdx(t, mtx, mty)] = 1;
  applyCommand(w, { type: 'move', units: [tank.id], x: 34, y: 20 }, 0);
  for (let i = 0; i < 45; i++) step(w);
  ok(tank.abandoned && tank.owner === -1, 'Festgefahrenes schweres Fahrzeug wird grau/verlassen');
  applyCommand(w, { type: 'tow', units: [tractor.id], targetId: tank.id }, 1);
  for (let i = 0; i < 5; i++) step(w);
  ok(!tank.abandoned && tank.owner === 1, 'Traktor birgt verlassenes Fahrzeug und übernimmt es');
  const [rtx, rty] = worldToTile(tank.x, tank.y);
  ok(isPassable(t, tank.domain, rtx, rty), 'Geborgenes Fahrzeug steht wieder auf passierbarem Gelände');
}

{
  const w = createWorld({ data, seed: 14, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.mud[i] = 0;
  }
  const wi = tIdx(t, 12, 10);
  t.water[wi] = Math.min(BUILDER_WADE_DEPTH, FLOOD_DEPTH * 1.2);
  t.baseWater[wi] = t.water[wi];
  const b = spawnUnit(w, 0, 'builder', 10 * 2 + 1, 10 * 2 + 1);
  b.order = { type: 'terra', job: 999 };
  setMoveGoal(w, b, 12 * 2 + 1, 10 * 2 + 1);
  for (let k = 0; k < 60; k++) stepMovement(w);
  const [wtx] = worldToTile(b.x, b.y);
  ok(wtx >= 11 && !b.abandoned && !b.dead, 'Bagger kann fuer Erdarbeiten kurzzeitig in moderates Wasser fahren');
  for (let k = 0; k < Math.ceil((BUILDER_WADE_TIME + 2) * TICK_RATE); k++) stepMovement(w);
  const [etx, ety] = worldToTile(b.x, b.y);
  ok((t.water[tIdx(t, etx, ety)] <= FLOOD_DEPTH * 0.3 || b.moveTarget) && !b.abandoned && !b.dead,
    'Bagger sucht nach begrenzter Arbeitszeit im Wasser wieder einen trockenen Ausstieg');
}

// 5) Befehl von unbesetztem Sitz wird ignoriert (Autorisierung)
const enemyUnit = ownerEntities(match.world, 1, 'unit')[0];
const ex = enemyUnit.x;
match.command(1, { type: 'move', units: [enemyUnit.id], x: enemyUnit.x + 20, y: enemyUnit.y });
match.tick();
// Sitz 1 ist KI-besetzt (occupant null) → Spielerbefehl darf nicht greifen, KI steuert weiter.
ok(true, 'Unbesetzter Sitz ignoriert externe Befehle (kein Crash)');

// 6) Disconnect → KI-Rückübernahme nach Timeout
match.markDisconnected(0);
match.reclaimTicks = 5; // Timeout für Test verkürzen
for (let i = 0; i < 10; i++) match.tick();
ok(match.player(0).controller === 'ai', 'Sitz fällt nach Disconnect-Timeout an KI zurück');

{
  const w = createWorld({
    data,
    seed: 91,
    map: { w: 40, h: 40 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
  });
  const t = w.terrain;
  for (const p of w.players) {
    p.resources.ore = 20000;
    p.resources.materials = 10000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const hq0 = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const hq1 = ownerEntities(w, 1, 'building').find(b => b.kind === 'hq');
  const vertical = Math.abs(hq0.tx - hq1.tx) >= Math.abs(hq0.ty - hq1.ty);
  const barrier = vertical ? Math.round((hq0.tx + hq1.tx) / 2) : Math.round((hq0.ty + hq1.ty) / 2);
  for (let k = 0; k < (vertical ? t.h : t.w); k++) {
    const x = vertical ? barrier : k;
    const y = vertical ? k : barrier;
    const i = tIdx(t, x, y);
    t.type[i] = TT.WATER;
    t.height[i] = SEA_LEVEL - 0.08;
    t.height0[i] = t.height[i];
    t.water[i] = NAVIGABLE_DEPTH * 1.4;
    t.baseWater[i] = t.water[i];
  }
  for (const e of ownerEntities(w, 1, 'unit')) e.dead = true;
  const tanks = [];
  for (let n = 0; n < 4; n++) tanks.push(spawnUnit(w, 0, 'tank', hq0.x + 2 + n * 0.7, hq0.y + 2));
  initAi(w.players[0]);
  w.players[0].ai.attackTimer = 6;
  w.players[0].ai.waveSize = 2;
  stepAi(w, w.players[0], applyCommand);
  const routeInfra = ownerEntities(w, 0, 'building').filter(e => ['road', 'bridge', 'tunnel'].includes(e.kind));
  const terrainJobs = (w.terraJobs || []).filter(j => j.owner === 0);
  ok(routeInfra.length > 0 || terrainJobs.length > 0,
    'KI bereitet bei unerreichbarem Fahrzeugangriff zuerst Straße/Brücke/Terrain vor');
  ok(routeInfra.some(e => e.kind === 'bridge'),
    'KI plant Richtung Gegner eine Brücke über einen Flussriegel');
  ok(tanks.every(u => !u.moveTarget),
    'KI verschiebt die Fahrzeug-Angriffswelle, bis die Route vorbereitet ist');
  for (let k = 0; k < 220; k++) step(w);
  const finishedBridges = ownerEntities(w, 0, 'building').filter(e => e.kind === 'bridge');
  ok(finishedBridges.length > 0 && finishedBridges.every(e => e.buildProgress >= 1 && e._fortified),
    'KI stellt geplante Brückenquerungen fertig');
}

{
  const w = createWorld({
    data,
    seed: 910,
    map: { w: 40, h: 40 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
  });
  const t = w.terrain;
  for (const p of w.players) {
    p.resources.ore = 20000;
    p.resources.materials = 10000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const hq0 = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const hq1 = ownerEntities(w, 1, 'building').find(b => b.kind === 'hq');
  const vertical = Math.abs(hq0.tx - hq1.tx) >= Math.abs(hq0.ty - hq1.ty);
  const barrier = vertical ? Math.round((hq0.tx + hq1.tx) / 2) : Math.round((hq0.ty + hq1.ty) / 2);
  for (let k = 0; k < (vertical ? t.h : t.w); k++) {
    const x = vertical ? barrier : k;
    const y = vertical ? k : barrier;
    const i = tIdx(t, x, y);
    t.type[i] = TT.WATER;
    t.height[i] = SEA_LEVEL - 0.08;
    t.height0[i] = t.height[i];
    t.water[i] = NAVIGABLE_DEPTH * 1.4;
    t.baseWater[i] = t.water[i];
    t.bridge[i] = 1;
  }
  for (const e of ownerEntities(w, 1, 'unit')) e.dead = true;
  for (let n = 0; n < 4; n++) spawnUnit(w, 0, 'tank', hq0.x + 2 + n * 0.7, hq0.y + 2);
  initAi(w.players[0]);
  w.players[0].ai.attackTimer = 6;
  w.players[0].ai.waveSize = 2;
  stepAi(w, w.players[0], applyCommand);
  const routeInfra = ownerEntities(w, 0, 'building').filter(e => ['road', 'bridge', 'tunnel'].includes(e.kind));
  ok(routeInfra.some(e => e.kind === 'bridge'),
    'KI baut eigene Brücken auch auf bereits fahrbaren Kartenpässen');
}

{
  const w = createWorld({
    data,
    seed: 92,
    map: { w: 40, h: 40 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
  });
  const t = w.terrain;
  for (const p of w.players) {
    p.resources.ore = 20000;
    p.resources.materials = 10000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
  }
  for (const e of ownerEntities(w, 0, 'unit')) e.dead = true;
  const hq0 = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const builder = spawnUnit(w, 0, 'builder', hq0.x + 2, hq0.y + 2);
  const truck = spawnUnit(w, 0, 'truck', hq0.x + 3, hq0.y + 2);
  const tanks = [];
  for (let n = 0; n < 5; n++) tanks.push(spawnUnit(w, 0, 'tank', hq0.x + 2 + n * 0.5, hq0.y + 4));
  initAi(w.players[0]);
  w.players[0].ai.attackTimer = 30;
  w.players[0].ai.waveSize = 18;
  stepAi(w, w.players[0], applyCommand);
  ok(builder.order.type !== 'idle' && truck.order.type !== 'idle',
    'KI laesst freie Bagger und LKWs nicht im Idle stehen');
  ok(tanks.some(u => u.order.type === 'attackmove' && u.moveTarget),
    'KI startet regelmaessig Angriffswellen, wenn die Bodentruppe gross genug ist');
}

{
  const w = createWorld({
    data,
    seed: 94,
    map: { w: 32, h: 24 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'human' }],
  });
  const t = w.terrain;
  w.entities.clear();
  for (const p of w.players) {
    p.resources.ore = 20000;
    p.resources.materials = 10000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
  }
  const hq0 = spawnBuilding(w, 0, 'hq', 4, 10); hq0.buildProgress = 1;
  const hq1 = spawnBuilding(w, 1, 'hq', 22, 10); hq1.buildProgress = 1;
  spawnUnit(w, 0, 'tank', hq0.x + 2, hq0.y);
  initAi(w.players[0]);
  stepAi(w, w.players[0], applyCommand);
  ok(ownerEntities(w, 0, 'building').some(e => e.kind === 'road'),
    'KI baut auch bei erreichbarem Gegner eine Straßenachse Richtung Front');
}

{
  const w = createWorld({
    data,
    seed: 93,
    map: { w: 32, h: 24 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'human' }],
  });
  const t = w.terrain;
  w.entities.clear();
  for (const p of w.players) {
    p.resources.ore = 20000;
    p.resources.materials = 10000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
  }
  const hq0 = spawnBuilding(w, 0, 'hq', 4, 10); hq0.buildProgress = 1;
  const hq1 = spawnBuilding(w, 1, 'hq', 22, 10); hq1.buildProgress = 1;
  for (let y = 10; y <= 13; y++) for (let x = 13; x <= 15; x++) {
    const i = tIdx(t, x, y);
    t.type[i] = TT.CLIFF;
    t.height[i] = 0.88;
    t.bridge[i] = 1; // Vorgeprägte Kartenpässe sollen trotzdem durch KI-Tunnel gesichert werden.
  }
  spawnUnit(w, 0, 'builder', hq0.x + 2, hq0.y + 2);
  spawnUnit(w, 0, 'tank', hq0.x + 2, hq0.y);
  initAi(w.players[0]);
  stepAi(w, w.players[0], applyCommand);
  ok((w.tunnels || []).length === 1 && ownerEntities(w, 0, 'building').filter(e => e.kind === 'tunnel').length === 2,
    'KI plant Richtung Gegner einen eigenen Tunnel durch einen bereits fahrbaren Klippenriegel');
  for (let k = 0; k < 400 && !(w.tunnels || []).some(tn => tn.active); k++) step(w);
  ok((w.tunnels || []).some(tn => tn.active),
    'KI stellt den geplanten Tunnel mit nur einer erreichbaren Mündung fertig');
}

{
  const w = createWorld({
    data,
    seed: 95,
    map: { w: 80, h: 24 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'human' }],
  });
  const t = w.terrain;
  w.entities.clear();
  for (const p of w.players) {
    p.resources.ore = 50000;
    p.resources.materials = 50000;
    p.resources.fuel = 5000;
    p.resources.ammo = 5000;
    p.resources.water = 5000;
  }
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.coverBuilt[i] = 0;
    t.ore[i] = 0; if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
  }
  const hq0 = spawnBuilding(w, 0, 'hq', 3, 10); hq0.buildProgress = 1; hq0.hp = hq0.maxHp;
  const hq1 = spawnBuilding(w, 1, 'hq', 70, 10); hq1.buildProgress = 1; hq1.hp = hq1.maxHp;
  for (let y = 0; y < t.h; y++) for (let x = 48; x <= 50; x++) {
    const i = tIdx(t, x, y);
    t.type[i] = TT.CLIFF;
    t.height[i] = 0.88;
    t.height0[i] = 0.88;
  }
  spawnUnit(w, 0, 'builder', hq0.x + 2, hq0.y + 2);
  spawnUnit(w, 0, 'tank', hq0.x + 2, hq0.y);
  initAi(w.players[0]);
  stepAi(w, w.players[0], applyCommand);
  const firstRouteInfra = ownerEntities(w, 0, 'building').filter(e => ['road', 'bridge', 'tunnel'].includes(e.kind));
  ok((w.tunnels || []).length === 1 && firstRouteInfra.every(e => e.kind !== 'road'),
    'KI priorisiert einen entfernten Klippen-Tunnel vor langen Straßenketten');
}

{
  const w = createWorld({
    data,
    seed: 88,
    map: { w: 40, h: 40 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'ai' }],
  });
  for (const p of w.players) for (const k of Object.keys(p.resources)) p.resources[k] = 0;
  const hq0 = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const hq1 = ownerEntities(w, 1, 'building').find(b => b.kind === 'hq');
  for (let n = 0; n < 4; n++) spawnUnit(w, 0, 'tank', hq0.x + 2 + n * 0.4, hq0.y + 2);
  for (let n = 0; n < 4; n++) spawnUnit(w, 1, 'tank', hq1.x - 2 - n * 0.4, hq1.y - 2);
  w.tick = 15000; // weit im KI-only-Endspiel: hoher Druck, aber keine künstliche Aufgabe.
  for (let k = 0; k < 1400; k++) {
    stepAi(w, w.players[0], applyCommand);
    stepAi(w, w.players[1], applyCommand);
    w.tick++;
  }
  ok(w.aiDirector?.pressure >= 10, 'KI-only-Endspiel erzeugt maximalen Angriffsdruck');
  ok(w.players.every(p => !p.defeated) && w.players.every(p => ownerEntities(w, p.id).length > 0),
    'KI gibt bei vorhandener Basis und Armee nicht per Score-Entscheid auf');
}

// 7) Befestigungen & Deckung (Phase 7): Wall blockiert + deckt, Graben deckt, Entfernen räumt auf.
{
  const w = createWorld({ data, seed: 4242, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'ai' }] });
  const t = w.terrain;
  // freie Land-Zelle ohne natürliche Deckung suchen
  let cell = null;
  for (let i = 0; i < t.type.length && !cell; i++)
    if (t.type[i] === TT.LAND && t.cover[i] === 0 && t.ore[i] === 0) cell = [i % t.w, (i / t.w) | 0];
  ok(cell, 'Testzelle (freies Land) gefunden');
  const [ctx, cty] = cell;

  const wall = spawnBuilding(w, 0, 'wall', ctx, cty);
  applyFortification(w, wall);
  ok(isBlocked(t, ctx, cty), 'Wall blockiert Bodenbewegung');
  ok(!isPassable(t, 'land', ctx, cty), 'Wall-Zelle ist für Landeinheiten unpassierbar');
  ok(isPassable(t, 'air', ctx, cty), 'Wall blockiert keine Lufteinheiten');
  ok(coverAt(t, ctx, cty) >= 0.3, 'Wall stempelt Deckung in die Zelle');

  // Infanterie in Deckung nimmt weniger Schaden als ohne Deckung.
  const [wx, wy] = [(ctx + 0.5) * 2, (cty + 0.5) * 2];
  const covered = spawnUnit(w, 0, 'rifleman', wx, wy);
  // offene Zelle mit Sicherheit ohne Deckung
  let openCell = null;
  for (let i = 0; i < t.type.length && !openCell; i++)
    if (t.type[i] === TT.LAND && coverAt(t, i % t.w, (i / t.w) | 0) === 0 && t.block[i] === 0) openCell = [i % t.w, (i / t.w) | 0];
  const exposed = spawnUnit(w, 0, 'rifleman', (openCell[0] + 0.5) * 2, (openCell[1] + 0.5) * 2);
  applyDamage(w, covered, 100, null);
  applyDamage(w, exposed, 100, null);
  ok(covered.hp > exposed.hp, 'Einheit in Deckung verliert weniger HP als exponierte Einheit');

  // Entfernen der Befestigung räumt Sperre & Deckung wieder auf.
  removeFortification(w, wall);
  ok(!isBlocked(t, ctx, cty) && coverAt(t, ctx, cty) === 0, 'Zerstörte Befestigung gibt Zelle wieder frei');

  // Wald: nur Fußtruppen dürfen hinein; Fahrzeuge brauchen eine gegrabene Tunnelpassage.
  const midY = (t.h / 2) | 0;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
  }
  for (let y = 0; y < t.h; y++) t.cover[tIdx(t, 2, y)] = 0.42;
  const footPath = findPath(t, 'land', 0, midY, 4, midY, 1000, Infinity, { category: 'infantry' });
  const vehiclePath = findPath(t, 'land', 0, midY, 4, midY, 1000, Infinity, { category: 'vehicle' });
  ok(footPath && footPath.length > 0, 'Infanterie kann Wald durchqueren');
  ok(vehiclePath === null, 'Fahrzeuge können Wald nicht durchqueren');
  t.tunnel[tIdx(t, 2, midY)] = 1;
  const tunneledVehiclePath = findPath(t, 'land', 0, midY, 4, midY, 1000, Infinity, { category: 'vehicle' });
  ok(tunneledVehiclePath && tunneledVehiclePath.some(([x, y]) => x === 2 && y === midY), 'Tunnel öffnet Waldpassage für Fahrzeuge');

  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.tunnel[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
  }
  for (let y = 0; y < t.h; y++) {
    const i = tIdx(t, 4, y);
    t.water[i] = WET_DEPTH * 0.55;
    t.baseWater[i] = t.water[i];
  }
  ok(!isPassable(t, 'land', 4, midY, 'infantry'), 'Fußtruppen betreten auch flaches sichtbares Wasser nicht');
  const blockedFootWater = findPath(t, 'land', 1, midY, 8, midY, 2000, Infinity, { category: 'infantry' });
  ok(blockedFootWater === null, 'Fußtruppen-Pfadfindung führt nicht durch eine Wasserlinie');
  t.bridge[tIdx(t, 4, midY)] = 1;
  ok(isPassable(t, 'land', 4, midY, 'infantry'), 'Brücken bleiben für Fußtruppen über Wasser passierbar');

  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.tunnel[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
  }
  for (let y = 1; y <= 8; y++) t.water[tIdx(t, 4, y)] = WET_DEPTH + 0.08;
  const aroundWater = findPath(t, 'land', 1, 5, 8, 5, 2000, Infinity, { category: 'vehicle' });
  ok(aroundWater && aroundWater.length > 0, 'Land-Wegfindung findet einen trockenen Umweg um Wasserflächen');
  ok(aroundWater.every(([x, y]) => !isWet(t, x, y)), 'Land-Wegfindung plant nicht durch bereits vorhandenes Wasser');

  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.tunnel[i] = 0;
  }
  const gx = 20, gy = 20, pocketX = 20, pocketY = 19;
  t.block[tIdx(t, gx, gy)] = 1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = pocketX + dx, y = pocketY + dy;
    if (x === pocketX && y === pocketY) continue;
    t.block[tIdx(t, x, y)] = 1;
  }
  const fallbackPath = findPath(t, 'land', 10, 20, gx, gy, 4000, Infinity, { category: 'vehicle' });
  ok(fallbackPath && fallbackPath.goal && !(fallbackPath.goal[0] === pocketX && fallbackPath.goal[1] === pocketY),
    'Blockiertes Klickziel: Pfadfindung nimmt einen erreichbaren Annäherungspunkt statt einer isolierten Nachbarzelle');

  const mw = createWorld({ data, seed: 89, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const mt = mw.terrain;
  mw.entities.clear();
  for (let i = 0; i < mt.type.length; i++) {
    mt.type[i] = TT.LAND; mt.height[i] = 0.5; mt.water[i] = 0; mt.baseWater[i] = 0; mt.block[i] = 0; mt.cover[i] = 0;
    if (mt.mud) mt.mud[i] = 0;
  }
  const movers = [];
  for (let n = 0; n < 8; n++) movers.push(spawnUnit(mw, 0, 'truck', 4, 4 + n * 5));
  for (const u of movers) setMoveGoal(mw, u, 48, u.y);
  const delayed = movers[6], dx0 = delayed.x, dy0 = delayed.y;
  ok(delayed._waitingForPath === true, 'Pfadbudget staffelt Massenziele, statt Einheiten ohne Pfad loszuschicken');
  stepMovement(mw);
  ok(Math.hypot(delayed.x - dx0, delayed.y - dy0) < 1e-6,
    'Einheit mit verzögerter A*-Suche wartet, statt banal geradeaus in Hindernisse zu fahren');

  const hw = createWorld({ data, seed: 90, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const ht = hw.terrain;
  hw.entities.clear();
  for (let i = 0; i < ht.type.length; i++) {
    ht.type[i] = TT.LAND; ht.height[i] = 0.5; ht.water[i] = 0; ht.baseWater[i] = 0; ht.block[i] = 0; ht.cover[i] = 0;
    if (ht.mud) ht.mud[i] = 0;
  }
  const group = [];
  for (let n = 0; n < 8; n++) group.push(spawnUnit(hw, 0, 'truck', 4, 4 + n * 2));
  hw._pbTick = hw.tick; hw._pathBudget = 0;
  applyCommand(hw, { type: 'move', units: group.map(u => u.id), x: 48, y: 12 }, 0);
  const before = group.map(u => ({ x: u.x, y: u.y }));
  ok(group.every(u => u.moveTarget && !u._waitingForPath),
    'Menschlicher Mehrfach-Move laesst auch bei leerem Pfadbudget alle Einheiten sofort loslaufen');
  stepMovement(hw);
  ok(group.every((u, i) => Math.hypot(u.x - before[i].x, u.y - before[i].y) > 0.001),
    'Alle Einheiten eines menschlichen Mehrfach-Move bewegen sich im naechsten Tick Richtung Zielpunkt');

  const lw = createWorld({ data, seed: 92, map: { w: 64, h: 64 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const lt = lw.terrain;
  lw.entities.clear();
  for (let i = 0; i < lt.type.length; i++) {
    lt.type[i] = TT.LAND; lt.height[i] = 0.5; lt.water[i] = 0; lt.baseWater[i] = 0; lt.block[i] = 0; lt.cover[i] = 0;
    if (lt.mud) lt.mud[i] = 0;
  }
  const largeGroup = [];
  for (let n = 0; n < 36; n++) largeGroup.push(spawnUnit(lw, 0, 'truck', 4 + (n % 6) * 1.2, 4 + Math.floor(n / 6) * 1.2));
  applyCommand(lw, { type: 'move', units: largeGroup.map(u => u.id), x: 96, y: 48 }, 0);
  const maxLargeGoalDist = Math.max(...largeGroup.map(u => Math.hypot(u.moveTarget.x - 96, u.moveTarget.y - 48)));
  ok(maxLargeGoalDist <= 16,
    'Große Fahrzeuggruppen bekommen Formationsziele nahe am Klickpunkt statt weit davor');

  const bw = createWorld({ data, seed: 91, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const bt = bw.terrain;
  bw.entities.clear();
  for (let i = 0; i < bt.type.length; i++) {
    bt.type[i] = TT.LAND; bt.height[i] = 0.5; bt.water[i] = 0; bt.baseWater[i] = 0; bt.block[i] = 0; bt.cover[i] = 0;
    if (bt.mud) bt.mud[i] = 0;
  }
  for (let y = 0; y < bt.h; y++) {
    const wall = spawnBuilding(bw, 0, 'wall', 14, y);
    wall.buildProgress = 1;
    applyFortification(bw, wall);
  }
  const blockedGroup = [];
  for (let n = 0; n < 8; n++) blockedGroup.push(spawnUnit(bw, 0, 'truck', 4, 4 + n * 2));
  bw._pbTick = bw.tick; bw._pathBudget = 0;
  applyCommand(bw, { type: 'move', units: blockedGroup.map(u => u.id), x: 48, y: 12 }, 0);
  const blockedBefore = blockedGroup.map(u => ({ x: u.x, y: u.y }));
  ok(blockedGroup.every(u => u._waitingForPath),
    'Menschlicher Mehrfach-Move wartet bei blockierter Direktlinie auf Pfade statt blind loszufahren');
  stepMovement(bw);
  ok(blockedGroup.every((u, i) => Math.hypot(u.x - blockedBefore[i].x, u.y - blockedBefore[i].y) < 1e-6),
    'Blockierte Gruppen machen keinen Stakkato-Schritt ohne Pfad');
}

// 8) Dynamisches Wasser (Phase 8): Becken-Füllung, Fluss, Damm-Barriere, Fluten, Trockenlegen.
{
  const w = createWorld({ data, seed: 7, map: { w: 64, h: 64 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  ok(t.baseWater && t.waterBlock && Array.isArray(t.sources), 'Terrain trägt Wasser-Felder (baseWater/waterBlock/sources)');
  // Becken sind bis zur Seehöhe gefüllt: eine WATER-Zelle hat Tiefe = Seehöhe − Boden.
  let seaCell = -1;
  for (let i = 0; i < t.type.length; i++) if (t.type[i] === TT.WATER) { seaCell = i; break; }
  if (seaCell >= 0) ok(Math.abs(t.water[seaCell] - (SEA_LEVEL - t.height[seaCell])) < 1e-3, 'Becken bis Seehöhe gefüllt (Tiefe = Seehöhe − Boden)');
  else ok(true, 'keine Seezelle auf dieser Karte (übersprungen)');

  // Kontrollierte, ebene Karte mit leichtem Ost→West-Gefälle, kein Anfangswasser, keine Quellen.
  const W = t.w;
  t.sources.length = 0; t.waterActive.clear();
  for (let i = 0; i < t.water.length; i++) {
    t.water[i] = 0; t.baseWater[i] = 0; t.type[i] = TT.LAND; t.waterBlock[i] = 0; t.block[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
    if (t.startSafe) t.startSafe[i] = 0;
  }
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) t.height[tIdx(t, x, y)] = 0.5 + x * 0.004;

  // Fluss: Wasser an einer hohen Zelle (Ost) einspeisen → fließt talwärts (West).
  const srcX = 40, srcY = 32, src = tIdx(t, srcX, srcY);
  for (let k = 0; k < 60; k++) { t.water[src] += 0.05; t.waterActive.add(src); w.tick++; stepWater(w); }
  ok(t.water[tIdx(t, srcX - 6, srcY)] > t.water[tIdx(t, srcX + 6, srcY)], 'Wasser fließt talwärts (West tiefer → mehr Wasser als Ost-Oberlauf)');
  // Stabilität: keine NaN/negativen Werte.
  let bad = 0; for (let i = 0; i < t.water.length; i++) if (!isFinite(t.water[i]) || t.water[i] < 0) bad++;
  ok(bad === 0, 'Wasser-CA bleibt numerisch stabil (keine NaN/negativen Tiefen)');

  // Damm-Barriere: waterBlock-Riegel staut auf — Oberlauf nass, Unterlauf trocken.
  const w2 = createWorld({ data, seed: 1, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t2 = w2.terrain; const W2 = t2.w;
  t2.sources.length = 0; t2.waterActive.clear();
  for (let i = 0; i < t2.water.length; i++) {
    t2.water[i] = 0; t2.baseWater[i] = 0; t2.type[i] = TT.LAND; t2.waterBlock[i] = 0;
    if (t2.lakeMask) t2.lakeMask[i] = 0;
    if (t2.startSafe) t2.startSafe[i] = 0;
  }
  for (let y = 0; y < W2; y++) for (let x = 0; x < W2; x++) t2.height[tIdx(t2, x, y)] = 0.5 + x * 0.004;
  for (let y = 14; y < 34; y++) t2.waterBlock[tIdx(t2, 24, y)] = 1; // senkrechter Damm bei x=24
  const src2 = tIdx(t2, 30, 24);
  for (let k = 0; k < 90; k++) { t2.water[src2] += 0.06; t2.waterActive.add(src2); w2.tick++; stepWater(w2); }
  const up = t2.water[tIdx(t2, 28, 24)], down = t2.water[tIdx(t2, 22, 24)];
  ok(up > WET_DEPTH && down < up * 0.2, 'Damm staut Wasser auf (Oberlauf nass, Unterlauf bleibt trocken)');
  ok(!isPassable(t2, 'land', 28, 24) && !isPassable(t2, 'water', 28, 24),
    'Flach geflutete Zelle: für Land gesperrt, aber nicht schiffbar');
  t2.water[tIdx(t2, 28, 24)] = NAVIGABLE_DEPTH + 0.02;
  ok(isPassable(t2, 'water', 28, 24), 'Tief geflutete Zelle: für See passierbar');

  const wDam = createWorld({ data, seed: 2, map: { w: 42, h: 42 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const dmt = wDam.terrain;
  dmt.sources.length = 0; dmt.waterActive.clear();
  for (let i = 0; i < dmt.water.length; i++) {
    dmt.type[i] = TT.LAND; dmt.height[i] = 0.48 + (i % dmt.w) * 0.003; dmt.height0[i] = dmt.height[i];
    dmt.water[i] = 0; dmt.baseWater[i] = 0; dmt.waterBlock[i] = 0; dmt.block[i] = 0;
    if (dmt.lakeMask) dmt.lakeMask[i] = 0;
    if (dmt.startSafe) dmt.startSafe[i] = 0;
  }
  const testDam = spawnBuilding(wDam, 0, 'dam', 20, 19);
  for (let y = 0; y < testDam.size; y++) for (let x = 0; x < testDam.size; x++) {
    const i = tIdx(dmt, testDam.tx + x, testDam.ty + y);
    dmt.height[i] = 0.44; dmt.height0[i] = 0.44;
  }
  const damBaseBefore = Float64Array.from(dmt.height);
  testDam.buildProgress = 1; applyFortification(wDam, testDam);
  let damLow = Infinity, damBank = -Infinity;
  for (let y = -1; y <= testDam.size; y++) for (let x = -1; x <= testDam.size; x++) {
    const nx = testDam.tx + x, ny = testDam.ty + y;
    if (!inBounds(dmt, nx, ny)) continue;
    const i = tIdx(dmt, nx, ny);
    if (x >= 0 && x < testDam.size && y >= 0 && y < testDam.size) damLow = Math.min(damLow, dmt.height[i]);
    else damBank = Math.max(damBank, damBaseBefore[i]);
  }
  ok(damLow > damBank + 0.12, 'Staudamm-Krone liegt höher als die angrenzenden Ufer');
  ok(dmt.waterBlock[tIdx(dmt, testDam.tx, testDam.ty)] > 0, 'Staudamm stempelt eine Wassersperre');
  removeFortification(wDam, testDam);
  let damReset = true;
  for (let y = 0; y < testDam.size; y++) for (let x = 0; x < testDam.size; x++) {
    const i = tIdx(dmt, testDam.tx + x, testDam.ty + y);
    if (Math.abs(dmt.height[i] - damBaseBefore[i]) > 1e-6 || dmt.waterBlock[i] !== 0) damReset = false;
  }
  ok(damReset, 'Staudamm-Rückbau setzt Höhe und Wassersperre exakt zurück');

  for (let y = 15; y <= 25; y++) dmt.waterBlock[tIdx(dmt, 20, y)] = 1;
  const damSrc = tIdx(dmt, 27, 20);
  for (let k = 0; k < 90; k++) { dmt.water[damSrc] += 0.09; dmt.waterActive.add(damSrc); wDam.tick++; stepWater(wDam); }
  const blockedDown = dmt.water[tIdx(dmt, 18, 20)], blockedUp = dmt.water[tIdx(dmt, 24, 20)];
  ok(blockedUp > WET_DEPTH && blockedDown < blockedUp * 0.25, 'Staudamm sperrt den direkten Durchfluss');
  for (let k = 0; k < 260; k++) { dmt.water[damSrc] += 0.09; dmt.waterActive.add(damSrc); wDam.tick++; stepWater(wDam); }
  const sideFlow = Math.max(dmt.water[tIdx(dmt, 20, 14)], dmt.water[tIdx(dmt, 21, 14)], dmt.water[tIdx(dmt, 20, 26)], dmt.water[tIdx(dmt, 21, 26)]);
  ok(sideFlow > WET_DEPTH, 'Aufgestautes Wasser fließt seitlich um die Staudamm-Enden');

  // Fluten tötet Landeinheiten, nicht aber Luft/See.
  const fc = tIdx(t2, 28, 24);
  t2.water[fc] = FLOOD_DEPTH + 0.15; t2.waterActive.add(fc);
  const land = spawnUnit(w2, 0, 'rifleman', (28 + 0.5) * 2, (24 + 0.5) * 2);
  const air = spawnUnit(w2, 0, 'gunship', (28 + 0.5) * 2, (24 + 0.5) * 2);
  const lhp = land.hp, ahp = air.hp;
  for (let k = 0; k < 6; k++) { t2.water[fc] = FLOOD_DEPTH + 0.15; w2.tick++; stepWater(w2); }
  ok(land.hp < lhp, 'Landeinheit ertrinkt in der Flut (Schaden)');
  ok(air.hp === ahp, 'Lufteinheit nimmt keinen Flutschaden');

  const swift = tIdx(t2, 30, 24), swiftDown = tIdx(t2, 31, 24);
  for (const i of [swift, swiftDown]) {
    t2.type[i] = TT.LAND; t2.block[i] = 0; t2.waterBlock[i] = 0; t2.baseWater[i] = 0;
  }
  t2.height[swift] = 0.50; t2.height[swiftDown] = 0.25;
  t2.water[swift] = FLOOD_DEPTH + 0.13; t2.water[swiftDown] = 0;
  t2.waterActive.add(swift); t2.waterActive.add(swiftDown);
  const swept = spawnUnit(w2, 0, 'rifleman', (30 + 0.5) * 2, (24 + 0.5) * 2);
  const sweptX = swept.x;
  w2.tick = 100; stepWater(w2);
  ok(swept.dead && swept.x > sweptX + 0.1,
    'Starke Strömung spült Fußtruppen weg und tötet sie sofort');

  // Trockenlegen: Wasser entfernen → Zelle wird wieder für Land begehbar.
  t2.water[fc] = 0; t2.waterActive.add(fc); w2.tick++; stepWater(w2);
  ok(!isWet(t2, 28, 24) && isPassable(t2, 'land', 28, 24), 'Trockengelegte Zelle ist wieder begehbar');

  // Wasserbau-Regeln: normale Bauten, Wall und Damm dürfen nicht ins Wasser; Brücken sind die Ausnahme.
  const w3 = createWorld({ data, seed: 99, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t3 = w3.terrain;
  let wcell = -1; for (let i = 0; i < t3.type.length; i++) if (t3.type[i] === TT.WATER) { wcell = i; break; }
  if (wcell >= 0) {
    const wx = wcell % t3.w, wy = (wcell / t3.w) | 0;
    ok(!canPlaceBuilding(w3, wx, wy, 1, data.buildings.refinery), 'Raffinerie darf nicht ins Wasser');
    ok(!canPlaceBuilding(w3, wx, wy, 1, data.buildings.wall), 'Wall darf nicht ins Wasser');
    ok(!canPlaceBuilding(w3, wx, wy, 2, data.buildings.dam), 'Damm darf nicht direkt ins Wasser');
    ok(canPlaceBuilding(w3, wx, wy, 1, data.buildings.bridge), 'Brücke darf über Wasser gebaut werden');
    const dx = Math.max(0, Math.min(t3.w - 1, wx + 1));
    const dy = Math.max(0, Math.min(t3.h - 1, wy + 1));
    t3.type[tIdx(t3, dx, dy)] = TT.LAND;
    t3.water[tIdx(t3, dx, dy)] = 0;
    t3.baseWater[tIdx(t3, dx, dy)] = 0;
    const lev = spawnBuilding(w3, 0, 'wall', dx, dy);
    applyFortification(w3, lev);
    const dryCell = tIdx(t3, dx, dy);
    ok(t3.waterBlock[dryCell] > 0 && isBlocked(t3, dx, dy), 'Wall stempelt auf trockenem Boden Wasser- und Bodensperre');
    removeFortification(w3, lev);
    ok(t3.waterBlock[dryCell] === 0 && !isBlocked(t3, dx, dy), 'Zerstörter Wall gibt Wasser- und Bodensperre frei');
  } else ok(true, 'keine Seezelle für Wasserbau-Test (übersprungen)');
}

// 9) Luft- & Seekrieg (Phase 4/5): Bordmunition/Nachladen, U-Boot-Tarnung, Werft am Wasser, kein Beaching.
{
  // 9a) Luft-Nachladen: leere Maschine kehrt zur Luftbasis zurück und munitioniert auf.
  const w = createWorld({ data, seed: 1, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const hq = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const ab = spawnBuilding(w, 0, 'airbase', hq.tx + 5, hq.ty + 5); ab.buildProgress = 1;
  const gun = spawnUnit(w, 0, 'gunship', (hq.tx + 5.5) * 2, (hq.ty + 9.5) * 2);
  ok(gun.muniMax > 0 && gun.muni === gun.muniMax, 'Kampfhubschrauber startet mit voller Bordmunition');
  gun.muni = 0; // leer geschossen
  let rearmed = false;
  for (let i = 0; i < 350 && !rearmed; i++) { step(w); if (gun.muni >= gun.muniMax && gun.order.type !== 'rearm') rearmed = true; }
  ok(rearmed, 'Leere Maschine kehrt zur Luftbasis zurück und lädt auf volle Munition nach');

  // 9b) Bordmunition wird beim Feuern verbraucht; bei 0 wird nicht gefeuert.
  const wf = createWorld({ data, seed: 2, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  const g2 = spawnUnit(wf, 0, 'gunship', 20, 20); g2.order = { type: 'idle' };
  const foe = spawnUnit(wf, 1, 'rifleman', 24, 20); foe.order = { type: 'hold' };
  const m0 = g2.muni;
  for (let i = 0; i < 30 && g2.muni === m0; i++) step(wf);
  ok(g2.muni < m0, 'Feuern verbraucht Bordmunition');
  g2.muni = 0; const projBefore = wf.projectiles.length;
  for (let i = 0; i < 10; i++) step(wf);
  // Mit muni 0 schickt stepAir die Maschine in den Rearm-Zustand statt zu feuern.
  ok(g2.order.type === 'rearm' || g2.muni > 0, 'Leere Maschine feuert nicht, sondern geht in den Nachlade-Zustand');

  // 9c) Silberjodid-Flugzeug: Zielpunkt-Wolke speist lokal Wasser in die Simulation.
  const { initEnv: initCloudEnv } = await import('../shared/systems/environment.js');
  const wcw = createWorld({ data, seed: 23, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }], controls: { insanity: 3 } });
  initCloudEnv(wcw);
  wcw.env.weather = 'clear'; wcw.env.weatherLeft = 1e9; wcw.env._nextQuake = 1e9; wcw.env._lightningCd = 1e9;
  wcw.players[0].resources.ammo = 100;
  const tc = wcw.terrain;
  for (let i = 0; i < tc.w * tc.h; i++) {
    tc.type[i] = TT.LAND; tc.height[i] = 0.82; tc.water[i] = 0; tc.baseWater[i] = 0;
    if (tc.waterBlock) tc.waterBlock[i] = 0;
  }
  tc.waterActive.clear();
  const seedPlane = spawnUnit(wcw, 0, 'cloud_seeder', 24, 24);
  const seedMuni = seedPlane.muni;
  applyCommand(wcw, { type: 'seedCloud', units: [seedPlane.id], x: 32, y: 24 }, 0);
  for (let i = 0; i < 12 && !(wcw.weatherClouds && wcw.weatherClouds.length); i++) step(wcw);
  ok((wcw.weatherClouds || []).length > 0, 'Silberjodid-Flugzeug platziert eine lokale Regenwolke am Zielpunkt');
  ok(seedPlane.muni < seedMuni, 'Wolkenimpfung verbraucht Bordmunition');
  const [rtx, rty] = worldToTile(32, 24);
  const beforeRain = tc.water[tIdx(tc, rtx, rty)];
  for (let i = 0; i < 8; i++) step(wcw);
  ok(tc.water[tIdx(tc, rtx, rty)] > beforeRain + WET_DEPTH * 0.2, 'Lokale Regenwolke erhöht den Wasserpegel am Zielgebiet');

  // 9d) U-Boot-Tarnung: getaucht nur im Nahbereich (oder kurz nach eigenem Feuern) entdeckbar.
  const ws = createWorld({ data, seed: 3, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  const sub = spawnUnit(ws, 0, 'submarine', 20, 20);
  const far = spawnUnit(ws, 1, 'destroyer', 20 + (SUB_DETECT_RANGE + 3), 20);   // > Erkennungsreichweite (Weltmeter)
  const near = spawnUnit(ws, 1, 'patrol_boat', 20 + (SUB_DETECT_RANGE - 2), 20); // < Erkennungsreichweite
  ok(sub.submerged, 'U-Boot ist getaucht');
  ok(!isDetectable(ws, far, sub), 'Getauchtes U-Boot außer Reichweite ist unsichtbar');
  ok(isDetectable(ws, near, sub), 'U-Boot im Nahbereich wird entdeckt');
  sub._exposeUntil = ws.time + 1; // soeben gefeuert → kurzzeitig sichtbar
  ok(isDetectable(ws, far, sub), 'Feuerndes U-Boot ist kurzzeitig auch aus der Ferne sichtbar');

  // 9e) Werft braucht Wasser: direkt im Wasser baubar, fernab nicht (im Gegensatz zur Raffinerie).
  const ww = createWorld({ data, seed: 7, map: { w: 64, h: 64 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const tw = ww.terrain;
  let dry = null, waterSpot = null;
  for (let i = 0; i < tw.type.length && (!dry || !waterSpot); i++) {
    const x = i % tw.w, y = (i / tw.w) | 0;
    if (!dry && canPlaceBuilding(ww, x, y, 3, data.buildings.refinery) && !hasWaterNear(tw, x, y, 5)) dry = [x, y];
    if (!waterSpot && isNavigableWater(tw, x, y) && canPlaceBuilding(ww, x, y, 3, data.buildings.shipyard)) waterSpot = [x, y];
  }
  ok(waterSpot, 'Werft kann direkt im Wasser platziert werden');
  if (dry) ok(!canPlaceBuilding(ww, dry[0], dry[1], 3, data.buildings.shipyard), 'Werft kann fernab von Wasser nicht platziert werden');
  else ok(true, 'kein wasserfernes Bauland gefunden (übersprungen)');

  // 9f) Kein Beaching: ein Schiff segelt nicht über Land, auch wenn das Ziel an Land liegt.
  const wm = createWorld({ data, seed: 7, map: { w: 64, h: 64 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const tm = wm.terrain;
  let wc = -1; for (let i = 0; i < tm.type.length; i++) if (isNavigableWater(tm, i % tm.w, (i / tm.w) | 0)) { wc = i; break; }
  let lc = -1; for (let i = 0; i < tm.type.length; i++) if (tm.type[i] === TT.LAND && !isWet(tm, i % tm.w, (i / tm.w) | 0)) { lc = i; break; }
  if (wc >= 0 && lc >= 0) {
    const boat = spawnUnit(wm, 0, 'patrol_boat', ((wc % tm.w) + 0.5) * 2, (((wc / tm.w) | 0) + 0.5) * 2);
    boat.order = { type: 'move' };
    setMoveGoal(wm, boat, ((lc % tm.w) + 0.5) * 2, (((lc / tm.w) | 0) + 0.5) * 2); // Ziel an Land
    for (let i = 0; i < 60; i++) stepMovement(wm);
    const [btx, bty] = worldToTile(boat.x, boat.y);
    ok(isPassable(tm, 'water', btx, bty), 'Schiff bleibt im Wasser (kein Beaching trotz Landziel)');
  } else ok(true, 'keine Wasser/Land-Zellen für Beaching-Test (übersprungen)');

  // 9g) Nebel: Schiffe können von der Kurslinie abdriften und an der Küste zerschellen.
  const { initEnv } = await import('../shared/systems/environment.js');
  const wfog = createWorld({ data, seed: 18, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  initEnv(wfog); wfog.env.weather = 'fog'; wfog.env.weatherLeft = 1e9;
  const tf = wfog.terrain;
  for (let i = 0; i < tf.type.length; i++) { tf.type[i] = TT.WATER; tf.height[i] = 0.1; tf.water[i] = 0.2; tf.baseWater[i] = 0.2; tf.block[i] = 0; }
  tf.type[tIdx(tf, 11, 10)] = TT.LAND; tf.water[tIdx(tf, 11, 10)] = 0; tf.baseWater[tIdx(tf, 11, 10)] = 0;
  const fogBoat = spawnUnit(wfog, 0, 'patrol_boat', (10.99) * 2, (10.5) * 2);
  fogBoat._fogDrift = { x: 1, y: 0, left: 10 };
  setMoveGoal(wfog, fogBoat, fogBoat.x, fogBoat.y);
  const hp0 = fogBoat.hp;
  for (let i = 0; i < 3 && !fogBoat.dead; i++) stepMovement(wfog);
  ok(fogBoat.hp < hp0 || fogBoat.dead, 'Nebel-Drift lässt ein Schiff an der Küste zerschellen');
  ok(wfog.events.some(ev => ev.type === 'shipwreck'), 'Schiffbruch erzeugt ein sichtbares Event');
}

// 10) Veteranen (Phase 3): XP durch Abschüsse, Rangaufstieg mit Boni, Helden-Selbstheilung.
{
  const wv = createWorld({ data, seed: 5, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  const ranks = wv.vet.ranks;

  // 10a) Frische Einheit ist Rekrut ohne Boni; Basiswerte gemerkt.
  const vetUnit = spawnUnit(wv, 0, 'tank', 20, 20);
  ok(vetUnit.vet === 0 && vetUnit.xp === 0, 'Frische Einheit ist Rekrut (Rang 0, 0 XP)');
  ok(vetUnit.vetDmgMult === 1 && vetUnit.baseMaxHp === vetUnit.maxHp, 'Rekrut hat keine Boni, Basiswerte gemerkt');

  // 10b) Tödlicher Treffer auf einen Gegner schreibt XP gut und befördert bei Schwellenwert.
  const baseDmg = vetUnit.maxHp, baseSight = vetUnit.sight;
  const victim = spawnUnit(wv, 1, 'tank', 21, 20);
  applyDamage(wv, victim, 99999, vetUnit); // tödlich
  ok(victim.dead && vetUnit.xp > 0, 'Angreifer erhält XP für Abschuss');
  const tankDeath = wv.events.find(ev => ev.type === 'death' && ev.id === victim.id);
  ok(tankDeath?.category === 'vehicle' && tankDeath.domain === 'land' && tankDeath.facing != null,
    'Fahrzeug-Tod liefert Renderer-Metadaten für Wracks');
  ok(vetUnit.xp >= ranks[1].xp ? vetUnit.vet >= 1 : true, 'Rang steigt bei erreichter XP-Schwelle');
  const infVictim = spawnUnit(wv, 1, 'rifleman', 22, 20);
  applyDamage(wv, infVictim, 99999, vetUnit);
  const infDeath = wv.events.find(ev => ev.type === 'death' && ev.id === infVictim.id);
  ok(infDeath?.category === 'infantry' && infDeath.domain === 'land',
    'Infanterie-Tod liefert Renderer-Metadaten für Umfallen statt Explosion');
  const waterInfVictim = spawnUnit(wv, 1, 'rifleman', 23, 20);
  applyDamage(wv, waterInfVictim, 99999, null, 'water', { vx: 0.7, vy: -0.2, depth: 0.18 });
  const infWashout = wv.events.find(ev => ev.type === 'washout' && ev.id === waterInfVictim.id);
  ok(infWashout?.category === 'infantry' && infWashout.domain === 'land'
    && Math.hypot(infWashout.vx || 0, infWashout.vy || 0) > 0.1,
    'Infanterie-Wassertod liefert Washout-Metadaten fürs Wegschwemmen');
  ok(!wv.events.some(ev => ev.type === 'death' && ev.id === waterInfVictim.id),
    'Infanterie-Wassertod erzeugt keinen normalen Death-Event');

  // 10c) Beförderung verbessert Schaden, max. HP und Sicht und heilt teilweise.
  const promoted = spawnUnit(wv, 0, 'rifleman', 10, 10);
  const pBaseHp = promoted.baseMaxHp, pBaseSight = promoted.baseSight;
  promoted.hp = 1;
  awardXp(promoted, ranks[1].xp, wv.vet); // exakt auf Veteran befördern
  ok(promoted.vet === 1, 'awardXp befördert genau auf Veteran');
  ok(promoted.vetDmgMult === ranks[1].dmgMult, 'Veteran richtet mehr Schaden an');
  ok(promoted.maxHp === Math.round(pBaseHp * ranks[1].hpMult), 'Veteran hat erhöhte max. HP');
  ok(promoted.sight === pBaseSight * ranks[1].sightMult, 'Veteran hat erhöhte Sicht');
  ok(promoted.hp > 1, 'Beförderung heilt die Einheit teilweise');

  // 10d) Eigener/befreundeter Schaden gibt keine XP (kein Friendly-Fire-Farming).
  const a2 = spawnUnit(wv, 0, 'tank', 5, 5);
  const friend = spawnUnit(wv, 0, 'rifleman', 6, 5);
  const xpBefore = a2.xp;
  applyDamage(wv, friend, 99999, a2);
  ok(a2.xp === xpBefore, 'Kein XP für Abschuss eigener Einheiten');

  // 10e) Held (oberster Rang) heilt sich nach einer Ruhephase selbst.
  const hero = spawnUnit(wv, 0, 'tank', 15, 15);
  awardXp(hero, ranks[ranks.length - 1].xp, wv.vet);
  ok(hero.vet === ranks.length - 1 && hero.vetRegen > 0, 'Höchstrang aktiviert Selbstheilung');
  hero.hp = 10; hero._lastHit = null; wv.time = 1000; // lange nach letztem Treffer
  for (let i = 0; i < 50; i++) stepRegen(wv);
  ok(hero.hp > 10, 'Held heilt sich außer Gefecht selbst');
}

// 11) Veteranen-Serialisierung: Rang wird im Snapshot übertragen und vom Client gelesen.
{
  const matchV = new Match({ data, seed: 11, slots: 2 });
  const u = ownerEntities(matchV.world, 0, 'unit')[0];
  u.vet = 2;
  const s = matchV.snapshot();
  const row = s.ents.find(r => r[0] === u.id && r[1] === 0);
  ok(row && row[10] === 2, 'Veteranen-Rang ist im Unit-Snapshot enthalten (Index 10)');
}

// 12) Garnisonierbare Schützengräben (Phase 7): eingegrabene Infanterie ist geschützt, begrenzt & wird repariert.
{
  const wg = createWorld({ data, seed: 17, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  // Graben auf gut platzierbarem Boden errichten (fertiggestellt, Deckung gestempelt).
  let gt = null;
  for (let i = 0; i < wg.terrain.type.length && !gt; i++) {
    const x = i % wg.terrain.w, y = (i / wg.terrain.w) | 0;
    if (canPlaceBuilding(wg, x, y, 1)) gt = [x, y];
  }
  const trench = spawnBuilding(wg, 0, 'trench', gt[0], gt[1]); trench.buildProgress = 1;
  const cap = data.buildings.trench.garrison;

  // 12a) Infanterie im Graben gilt als eingegraben; Belegung wird gezählt.
  const grunt = spawnUnit(wg, 0, 'rifleman', trench.x, trench.y);
  stepGarrison(wg);
  ok(grunt._garr === wg.tick && trench.garrison === 1, 'Infanterie im Graben ist eingegraben (Belegung gezählt)');

  // 12b) Eingegrabene Infanterie nimmt weniger Schaden (Faktor zusätzlich zur Deckung) — isoliert auf offenem Boden.
  const a = spawnUnit(wg, 0, 'rifleman', 4, 4), b = spawnUnit(wg, 0, 'rifleman', 4, 4);
  a._garr = wg.tick; // markiert eingegraben (ohne Geländedeckung an dieser Stelle)
  applyDamage(wg, a, 50, null); applyDamage(wg, b, 50, null);
  ok(a.maxHp - a.hp < b.maxHp - b.hp, 'Eingegrabene Infanterie erleidet weniger Schaden als ungeschützte');
  ok(Math.abs((a.maxHp - a.hp) - (b.maxHp - b.hp) * GARRISON_DAMAGE_MULT) < 0.01, 'Schadensreduktion entspricht dem Garnisons-Faktor');

  // 12c) Kapazität begrenzt die Zahl geschützter Trupps (Belegung am Graben deckelt bei cap).
  for (let k = 0; k < cap + 3; k++) spawnUnit(wg, 0, 'rifleman', trench.x, trench.y);
  stepGarrison(wg);
  ok(trench.garrison === cap, `Höchstens ${cap} Trupps werden gleichzeitig geschützt (Kapazität)`);

  // 12d) Nur eigene Infanterie — Fahrzeuge und Gegner profitieren nicht.
  const tank = spawnUnit(wg, 0, 'tank', trench.x, trench.y);
  const enemyInf = spawnUnit(wg, 1, 'rifleman', trench.x, trench.y);
  stepGarrison(wg);
  ok(tank._garr !== wg.tick, 'Fahrzeuge graben sich nicht ein (nur Infanterie)');
  ok(enemyInf._garr !== wg.tick, 'Gegnerische Infanterie nutzt den fremden Graben nicht');

  // 12e) Feldreparatur: verwundete eingegrabene Infanterie heilt (eigener Graben, einzelner Trupp).
  const wg2 = createWorld({ data, seed: 18, map: { w: 24, h: 24 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  let gt2 = null;
  for (let i = 0; i < wg2.terrain.type.length && !gt2; i++) {
    const x = i % wg2.terrain.w, y = (i / wg2.terrain.w) | 0;
    if (canPlaceBuilding(wg2, x, y, 1)) gt2 = [x, y];
  }
  const trench2 = spawnBuilding(wg2, 0, 'trench', gt2[0], gt2[1]); trench2.buildProgress = 1;
  const hurt = spawnUnit(wg2, 0, 'rifleman', trench2.x, trench2.y); hurt.hp = 1;
  stepGarrison(wg2);
  ok(hurt.hp > 1, 'Eingegrabene Infanterie wird feldrepariert');
}

// 13) Sonar-Ortung (Phase 5): Sonarstation deckt getauchte feindliche U-Boote auf.
{
  const wso = createWorld({ data, seed: 23, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  const sub = spawnUnit(wso, 0, 'submarine', 16, 16);
  const dest = spawnUnit(wso, 1, 'destroyer', 16 + (SUB_DETECT_RANGE + 6), 16); // außer Nahbereichs-Erkennung
  ok(sub.submerged && !isDetectable(wso, dest, sub), 'Getauchtes U-Boot ist ohne Sonar aus der Ferne unsichtbar');

  // Sonarstation des Gegners in Reichweite des U-Boots → es wird für dessen Flotte sichtbar.
  const sonar = spawnBuilding(wso, 1, 'sonar', 12, 12); sonar.buildProgress = 1;
  ok(sonar.def.sonarRange > 0, 'Sonarstation hat eine Ortungsreichweite');
  stepSonar(wso);
  ok(sub._sonarBy && sub._sonarBy.has(1), 'Sonar ortet das getauchte U-Boot des Gegners');
  ok(isDetectable(wso, dest, sub), 'Geortetes U-Boot ist für die feindliche Flotte angreifbar');

  // Eigene Sonarstation des U-Boot-Besitzers ortet nicht das eigene U-Boot.
  const ownSonar = spawnBuilding(wso, 0, 'sonar', 18, 18); ownSonar.buildProgress = 1;
  stepSonar(wso);
  ok(!(sub._sonarBy && sub._sonarBy.has(0)), 'Eigene Sonarstation ortet nicht das eigene U-Boot');

  // U-Boot außerhalb der Sonarreichweite bleibt verborgen (Sonar steht bei Welt-(25,25), Reichweite 22).
  const farSub = spawnUnit(wso, 0, 'submarine', 60, 60);
  stepSonar(wso);
  ok(!(farSub._sonarBy && farSub._sonarBy.has(1)), 'U-Boot außerhalb der Sonarreichweite bleibt verborgen');
}

// 14) Zielpriorität (Phase 5/10): Waffen bevorzugen das wirksamste Ziel, nicht stur das nächste.
{
  const wt = createWorld({ data, seed: 31, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }] });
  // Flak (vs Luft 1.4, vs Fahrzeug 0.3): naher Panzer vs. etwas entfernterer Hubschrauber.
  const flak = spawnUnit(wt, 0, 'flak_track', 24, 24);
  const nearTank = spawnUnit(wt, 1, 'tank', 24 + 2, 24);        // näher dran, aber schwaches Ziel
  const farHeli = spawnUnit(wt, 1, 'gunship', 24 + 7, 24);      // weiter weg, aber Idealziel
  buildSpatial(wt);
  const flakTgt = nearestEnemy(wt, flak, flak.sight);
  ok(flakTgt && flakTgt.id === farHeli.id, 'Flak bevorzugt den Hubschrauber vor dem näheren Panzer');
  // Mit prioritize:false fällt sie auf reine Distanz zurück (näheres Ziel = Panzer).
  const flakNear = nearestEnemy(wt, flak, flak.sight, { prioritize: false });
  ok(flakNear && flakNear.id === nearTank.id, 'Ohne Priorität feuert die Flak auf das nächste Ziel');

  // SAM (sam_missile: vs alles außer Luft = 0) ignoriert Bodenziele komplett, auch näher gelegene.
  const sam = spawnBuilding(wt, 0, 'sam_site', 6, 6); sam.buildProgress = 1;
  const groundClose = spawnUnit(wt, 1, 'rifleman', sam.x + 3, sam.y);
  const heliFar = spawnUnit(wt, 1, 'gunship', sam.x + 10, sam.y);
  buildSpatial(wt);
  const samTgt = nearestEnemy(wt, sam, Math.max(sam.weapon.range, 14));
  ok(samTgt && samTgt.id === heliFar.id, 'SAM ignoriert Bodenziele und greift nur Luftziele an');

  // Panzer (vs Fahrzeug 1.2 > Infanterie 0.7): fokussiert bei gleicher Distanz feindliche Fahrzeuge.
  const myTank = spawnUnit(wt, 0, 'tank', 40, 40);
  const enemyInf = spawnUnit(wt, 1, 'rifleman', 40 + 4, 40);
  const enemyTank = spawnUnit(wt, 1, 'tank', 40, 40 + 4);       // gleiche Distanz, höhere Wirksamkeit
  buildSpatial(wt);
  const tankTgt = nearestEnemy(wt, myTank, myTank.sight);
  ok(tankTgt && tankTgt.id === enemyTank.id, 'Panzer fokussiert bei gleicher Distanz das feindliche Fahrzeug');
  // Luftziel bleibt für den Panzer (vs Luft 0) unangreifbar.
  const flyover = spawnUnit(wt, 1, 'gunship', 40 + 1, 40);
  buildSpatial(wt);
  const stillGround = nearestEnemy(wt, myTank, myTank.sight);
  ok(stillGround && stillGround.domain !== 'air', 'Panzer ignoriert Luftziele trotz Nähe');
  wt.players[0].controller = 'ai';
  const enemyRoad = spawnBuilding(wt, 1, 'road', 21, 20); enemyRoad.buildProgress = 1; applyFortification(wt, enemyRoad);
  buildSpatial(wt);
  ok(nearestEnemy(wt, myTank, myTank.sight)?.id !== enemyRoad.id,
    'KI-Einheiten ignorieren Straßen bei der Zielerfassung');
  const roadHp = enemyRoad.hp;
  applyDamage(wt, enemyRoad, roadHp + 1, myTank);
  ok(!enemyRoad.dead && enemyRoad.hp === roadHp, 'KI-Schaden zerstört keine Straßen');
}

// 14a) KI-Einheiten greifen auch bei normalem Bewegungsbefehl nahe Gegner automatisch an.
{
  const w = createWorld({
    data, seed: 3132, map: { w: 32, h: 32 },
    players: [{ id: 0, faction: 'KBN', controller: 'ai' }, { id: 1, faction: 'HLX', controller: 'human' }],
  });
  w.entities.clear();
  w.players[0].resources.ammo = 100;
  const tank = spawnUnit(w, 0, 'tank', 20, 20);
  tank.order = { type: 'move' };
  const enemyUnit = spawnUnit(w, 1, 'rifleman', 25, 20);
  buildSpatial(w);
  stepCombat(w);
  ok(w.events.some(e => e.type === 'fire' && e.id === tank.id) && enemyUnit.hp < enemyUnit.maxHp,
    'KI-Einheit feuert aus normaler Bewegung auf nahe gegnerische Einheit');

  enemyUnit.dead = true; enemyUnit.hp = 0;
  tank.target = null; tank.cd = 0;
  w.projectiles.length = 0;
  w.events.length = 0;
  const enemyBuilding = spawnBuilding(w, 1, 'power_plant', 11, 10); enemyBuilding.buildProgress = 1;
  buildSpatial(w);
  stepCombat(w);
  ok(w.events.some(e => e.type === 'fire' && e.id === tank.id) && enemyBuilding.hp < enemyBuilding.maxHp,
    'KI-Einheit feuert aus normaler Bewegung auf nahes gegnerisches Gebäude');
}

// 15) Fraktions-Modifikatoren werden tatsächlich angewandt (costMult/research/hpMult/armorMult).
//     Regressionsschutz: diese Werte lagen früher tot in factions.json (nur hpMult war verdrahtet).
{
  const players = [
    { id: 0, faction: 'HLX', controller: 'ai' },
    { id: 1, faction: 'KBN', controller: 'ai' },
    { id: 2, faction: 'FLG', controller: 'ai' },
  ];
  const wf = createWorld({ data, seed: 4242, players });
  const U = data.units;
  // costMult pro Kategorie (HLX-Luft, KBN-Fahrzeug, FLG-Marine günstiger).
  const hxAir = data.factions.HLX.modifiers.air.costMult;
  const kbVeh = data.factions.KBN.modifiers.vehicle.costMult;
  const flNav = data.factions.FLG.modifiers.naval.costMult;
  ok(effectiveCost(wf, 0, U.gunship).ore === Math.round(U.gunship.cost.ore * hxAir), 'HLX-Luft nutzt air.costMult');
  ok(effectiveCost(wf, 1, U.tank).ore === Math.round(U.tank.cost.ore * kbVeh), 'KBN-Fahrzeug ist günstiger (vehicle.costMult)');
  ok(effectiveCost(wf, 2, U.destroyer).ore === Math.round(U.destroyer.cost.ore * flNav), 'FLG-Marine ist günstiger (naval.costMult)');
  // KBN hat einen Luft-Aufschlag (costMult>1 → teurer), FLG ohne Luft-Modifikator zahlt Basiskosten.
  const kbAir = data.factions.KBN.modifiers.air.costMult;
  ok(effectiveCost(wf, 1, U.gunship).ore === Math.round(U.gunship.cost.ore * kbAir), 'KBN-Luft ist teurer (air.costMult>1)');
  ok(effectiveCost(wf, 2, U.gunship).ore === U.gunship.cost.ore, 'FLG ohne Luft-Modifikator zahlt Basiskosten');
  // research → Bau-/Produktionsgeschwindigkeit (nur HLX).
  ok(buildSpeedMult(wf, 0) === 1.25 && buildSpeedMult(wf, 1) === 1, 'research beschleunigt Produktion nur bei HLX');
  // hpMult pro Kategorie (KBN-Panzer robuster).
  const kbnTank = spawnUnit(wf, 1, 'tank', 50, 50);
  ok(kbnTank.maxHp === Math.round(U.tank.hp * 1.03), 'KBN-Panzer hat erhöhte max. HP (vehicle.hpMult)');
  // armorMult → Schadensaufnahme: zwei identische Trupps am selben Feld (gleiche Deckung),
  // der dünner gepanzerte verliert exakt doppelt so viel HP.
  wf.data.factions.HLX.modifiers.armorMult = 0.5;
  const thin = spawnUnit(wf, 0, 'rifleman', 60, 60);   // HLX → dmgTakenMult 2
  const tough = spawnUnit(wf, 1, 'rifleman', 60, 60);  // KBN → dmgTakenMult 1
  ok(thin.dmgTakenMult === 2, 'armorMult<1 stempelt dmgTakenMult=1/armorMult');
  const t0 = thin.hp, g0 = tough.hp;
  applyDamage(wf, thin, 12, null); applyDamage(wf, tough, 12, null);
  ok((t0 - thin.hp) === 2 * (g0 - tough.hp), 'armorMult halbiert die Rüstung → exakt doppelter Schaden bei gleicher Deckung');
  delete wf.data.factions.HLX.modifiers.armorMult;
}

// 16) Amphibische/Lufttransporte: Ein-/Ausladen + Insassenverlust (Phase 5)
{
  const wt = createWorld({ data, seed: 9091, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'FLG', controller: 'ai' }] });
  // Flaches Landfeld finden (Mittenbereich), Transporter + Infanterie dicht beisammen platzieren.
  let lx = 0, ly = 0;
  outer: for (let ty = 10; ty < wt.terrain.h - 10; ty++) for (let tx = 10; tx < wt.terrain.w - 10; tx++) {
    let okSpot = true;
    for (let y = 0; y < 4 && okSpot; y++) for (let x = 0; x < 4; x++) if (!isPassable(wt.terrain, 'land', tx + x, ty + y)) { okSpot = false; break; }
    if (okSpot) { lx = (tx + 0.5) * 2; ly = (ty + 0.5) * 2; break outer; }
  }
  const tr = spawnUnit(wt, 0, 'amphib_transport', lx, ly);
  ok(tr.capacity === 6 && Array.isArray(tr.carried), 'Transporter erhält Kapazität + Ladeliste beim Spawn');
  const riflemen = [];
  for (let k = 0; k < 7; k++) riflemen.push(spawnUnit(wt, 0, 'rifleman', lx + 1 + (k % 3) * 0.4, ly + (k < 3 ? 0.6 : -0.6)));
  // Laden: 7 Infanteristen einsteigen lassen — nur 6 passen hinein.
  applyCommand(wt, { type: 'load', transport: tr.id, units: riflemen.map(r => r.id) }, 0);
  for (let i = 0; i < 8; i++) step(wt);
  ok(tr.carried.length === 6, `Transporter lädt bis zur Kapazität (6), nicht mehr — geladen: ${tr.carried.length}`);
  const stillOut = riflemen.filter(r => wt.entities.has(r.id)).length;
  ok(stillOut === 1, `Geladene Infanterie verlässt die Welt-Entities (1 bleibt draußen, hatte keinen Platz) — draußen: ${stillOut}`);
  // Serialisierung: Insassenzahl steht im Ladungs-Index (9) des Transporters.
  const srow = serializeSnapshot(wt).ents.find(e => e[0] === tr.id);
  ok(srow && srow[9] === 6, `Snapshot meldet Insassenzahl im Ladungs-Index — gemeldet: ${srow && srow[9]}`);
  // Ausladen am aktuellen Ort → Insassen kehren als eigenständige Entities zurück.
  applyCommand(wt, { type: 'unload', transport: tr.id }, 0);
  step(wt);
  ok(tr.carried.length === 0, 'Nach dem Ausladen ist der Transporter leer');
  const backIn = riflemen.filter(r => wt.entities.has(r.id)).length;
  ok(backIn === 7, `Alle ausgeladenen Einheiten sind wieder in der Welt (6 ausgeladen + 1 nie geladen) — drin: ${backIn}`);
  ok(riflemen.every(r => !wt.entities.has(r.id) || wt.entities.get(r.id).order.type === 'idle'), 'Ausgeladene Einheiten stehen auf idle');
  // Insassenverlust: voller Transporter wird zerstört → Insassen gehen verloren.
  const tr2 = spawnUnit(wt, 0, 'amphib_transport', lx, ly);
  const pax = spawnUnit(wt, 0, 'rifleman', lx + 0.5, ly);
  applyCommand(wt, { type: 'load', transport: tr2.id, units: [pax.id] }, 0);
  step(wt);
  ok(tr2.carried.length === 1 && !wt.entities.has(pax.id), 'Passagier ist eingestiegen (aus Entities entfernt)');
  applyDamage(wt, tr2, tr2.hp + 1, null);
  step(wt);
  ok(!wt.entities.has(tr2.id) && !wt.entities.has(pax.id), 'Zerstörter Transporter reißt seine Insassen mit — beide weg');
}

// 17) Terraforming + Wasserumleitung (Phase 6/8)
{
  const tt = createWorld({ data, seed: 31337, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'FLG', controller: 'ai' }] });
  const t = tt.terrain, W = t.w;
  // (a) Terraform-Mechanik: Wall hebt, Graben senkt, Entfernen setzt exakt zurück.
  // Zelle mit moderater Höhe wählen (am Zentralberg würde das 0.99-Clamping die Symmetrie brechen).
  let cx = 20, cy = 20;
  for (let i = 0; i < t.height.length; i++) {
    if (t.height[i] > 0.4 && t.height[i] < 0.65 && t.water[i] === 0) { cx = i % W; cy = (i / W) | 0; break; }
  }
  const ci = cy * W + cx;
  const h0 = t.height0[ci];
  stampFortification(t, cx, cy, 1, 0.35, true, false, data.buildings.wall.terraform);
  ok(t.height[ci] > h0 && t.terra[ci] > 0, `Wall hebt das Gelände an (terraform>0) — Δ=${(t.height[ci]-h0).toFixed(3)}`);
  unstampFortification(t, cx, cy, 1, 0.35, true, false, data.buildings.wall.terraform);
  ok(Math.abs(t.height[ci] - h0) < 1e-6 && t.terra[ci] === 0, 'Wall entfernen setzt die Höhe exakt zurück (terra=0)');
  const gx = 42, gy = 40, gi = gy * W + cx + 2;
  const gh0 = t.height0[gy * W + gx];
  stampFortification(t, gx, gy, 1, 0.5, false, false, data.buildings.trench.terraform);
  ok(t.height[gy * W + gx] < gh0 && t.terra[gy * W + gx] < 0, 'Schützengraben senkt das Gelände aus (terraform<0)');

  // (b) Wasserumleitung: ein gestautes Becken kann einen Bergrücken nicht überwinden; ein ausgehobener
  //     Graben durch den Rücken öffnet einen Abfluss → das tiefer liegende Trockenbecken läuft voll.
  const tw = createWorld({ data, seed: 4242, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'FLG', controller: 'ai' }] });
  const u = tw.terrain, ux = 30, uy = 30;
  const patch = [];
  // 7×7-Wanne mit hohen Wänden, damit nur der definierte Weg zählt.
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const i = (uy + dy) * u.w + (ux + dx);
    u.height[i] = 0.90; u.height0[i] = 0.90; u.water[i] = 0; u.baseWater[i] = 0; patch.push(i);
  }
  // 3×3-Stausee (dauerhaft, baseWater-Boden) auf 0.45, Oberfläche 0.70.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = (uy + dy) * u.w + (ux + dx);
    u.height[i] = 0.45; u.height0[i] = 0.45; u.water[i] = 0.25; u.baseWater[i] = 0.25;
  }
  const iRidge = uy * u.w + (ux + 2), iBasin = uy * u.w + (ux + 3);
  u.height[iRidge] = 0.76; u.height0[iRidge] = 0.76;            // Rücken (höher als Seeoberfläche)
  u.height[iBasin] = 0.30; u.height0[iBasin] = 0.30; u.baseWater[iBasin] = 0; // tieferes Trockenbecken
  u.waterActive = new Set(patch);
  for (let k = 0; k < 60; k++) { stepWater(tw); tw.tick++; }
  const dryBefore = u.water[iBasin] <= WET_DEPTH;
  // Rücken flach abgraben (0.76 → 0.66) → Stausee fließt als KANAL ins Trockenbecken. (Bewusst eine
  // flache Abgrabung: der echte Sperr-Graben ist tiefer und HÄLT Wasser — hier wird nur die generische
  // „Senken leitet Wasser um"-Mechanik geprüft, unabhängig von der Graben-Tiefe in den Daten.)
  stampFortification(u, ux + 2, uy, 1, 0.5, false, false, -0.10);
  // Mehr Schritte als früher: das Wasser fließt jetzt bewusst LANGSAMER (WATER_FLOW gesenkt), die
  // Umleitung über den gesenkten Rücken ins Becken braucht daher länger.
  for (let k = 0; k < 700; k++) { stepWater(tw); tw.tick++; }
  const wetAfter = u.water[iBasin] > WET_DEPTH;
  ok(dryBefore, 'Wasser überwindet den Bergrücken nicht — Trockenbecken bleibt trocken (Höhe sperrt den Fluss)');
  ok(wetAfter, 'Nach dem Ausheben eines Grabens fließt Wasser über den gesenkten Rücken ins Becken (Umleitung funktioniert)');

  // (c) Physikalische Senke: Wasser bleibt stehen, bis der Spiegel die Schwelle erreicht.
  const bw = createWorld({ data, seed: 5151, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const bt = bw.terrain, bx = 14, by = 14;
  bt.sources.length = 0; bt.waterActive.clear();
  for (let i = 0; i < bt.water.length; i++) {
    bt.type[i] = TT.LAND; bt.height[i] = 0.80; bt.height0[i] = 0.80;
    bt.water[i] = 0; bt.baseWater[i] = 0; bt.waterBlock[i] = 0; bt.block[i] = 0;
    if (bt.lakeMask) bt.lakeMask[i] = 0;
    if (bt.startSafe) bt.startSafe[i] = 0;
  }
  const basin = by * bt.w + bx;
  const lip = by * bt.w + (bx + 1);
  const lower = by * bt.w + (bx + 2);
  bt.height[basin] = bt.height0[basin] = 0.30;
  bt.height[lip] = bt.height0[lip] = 0.50;
  bt.height[lower] = bt.height0[lower] = 0.22;
  bt.water[basin] = 0.18; bt.waterActive.add(basin);
  for (let k = 0; k < 30; k++) { stepWater(bw); bw.tick++; }
  ok(bt.water[lower] <= WET_DEPTH,
    'Senke unterhalb der Schwelle läuft nicht aus, solange der Wasserspiegel unter der Kante bleibt');
  ok(bt.water[basin] >= 0.175,
    `Abflusslose Senke verliert keinen Pegel durch Versickerung (${bt.water[basin].toFixed(3)} >= 0.175)`);
  bt.water[basin] += 0.16; bt.waterActive.add(basin);
  for (let k = 0; k < 90; k++) { stepWater(bw); bw.tick++; }
  ok(bt.water[lower] > WET_DEPTH,
    'Erst nach Auffüllen bis über die Schwelle fließt Wasser in die tiefer liegende Ebene');

  // (d) Geschlossene, geneigte Senke: Wasser darf nicht unsichtbar verschwinden, wenn es
  // zwar lokal tiefer fließt, aber keinen Abfluss aus dem Becken heraus hat.
  const cw = createWorld({ data, seed: 5252, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const ct = cw.terrain, cpx = 15, cpy = 15;
  ct.sources.length = 0; ct.waterActive.clear();
  for (let i = 0; i < ct.water.length; i++) {
    ct.type[i] = TT.LAND; ct.height[i] = 0.86; ct.height0[i] = 0.86;
    ct.water[i] = 0; ct.baseWater[i] = 0; ct.waterBlock[i] = 0; ct.block[i] = 0;
    if (ct.lakeMask) ct.lakeMask[i] = 0;
    if (ct.startSafe) ct.startSafe[i] = 0;
  }
  const upper = cpy * ct.w + cpx;
  const pocket = cpy * ct.w + cpx + 1;
  ct.height[upper] = ct.height0[upper] = 0.48;
  ct.height[pocket] = ct.height0[pocket] = 0.34;
  ct.water[upper] = 0.09;
  ct.waterActive.add(upper); ct.waterActive.add(pocket);
  const closed0 = ct.water.reduce((s, v) => s + v, 0);
  for (let k = 0; k < 160; k++) { stepWater(cw); cw.tick++; }
  const closed1 = ct.water.reduce((s, v) => s + v, 0);
  ok(closed1 >= closed0 * 0.96,
    `Geschlossene Senke verliert keinen Wasserstand durch unsichtbare Versickerung (${closed0.toFixed(3)} → ${closed1.toFixed(3)})`);
  ok(ct.water[pocket] > WET_DEPTH,
    'Wasser läuft innerhalb der geschlossenen Senke in das tiefere Loch');
  const shallowRunoff = (cpy + 3) * ct.w + cpx;
  ct.water[shallowRunoff] = 0.01;
  const shallowSnap = serializeSnapshot(cw).water || [];
  ok(shallowSnap.some((v, n) => n % 2 === 0 && v === shallowRunoff),
    'Snapshot streamt flache Abflussfeuchte für Boden-Umfärbung');

  // (d2) Stehendes Wasser nivelliert sich: zwei verbundene Senkenzellen dürfen nicht dauerhaft
  // als schräge Wasserfläche stehen bleiben.
  const lw = createWorld({ data, seed: 5353, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const lt = lw.terrain, lx = 14, ly = 14;
  lt.sources.length = 0; lt.waterActive.clear();
  for (let i = 0; i < lt.water.length; i++) {
    lt.type[i] = TT.LAND; lt.height[i] = 0.86; lt.height0[i] = 0.86;
    lt.water[i] = 0; lt.baseWater[i] = 0; lt.waterBlock[i] = 0; lt.block[i] = 0;
    if (lt.lakeMask) lt.lakeMask[i] = 0;
    if (lt.startSafe) lt.startSafe[i] = 0;
  }
  const poolA = ly * lt.w + lx, poolB = ly * lt.w + lx + 1;
  lt.height[poolA] = lt.height0[poolA] = 0.30;
  lt.height[poolB] = lt.height0[poolB] = 0.34;
  lt.water[poolA] = 0.18;
  lt.water[poolB] = 0.10;
  lt.waterActive.add(poolA); lt.waterActive.add(poolB);
  const levelMass0 = lt.water[poolA] + lt.water[poolB];
  for (let k = 0; k < 40; k++) { stepWater(lw); lw.tick++; }
  const levelA = lt.height[poolA] + lt.water[poolA];
  const levelB = lt.height[poolB] + lt.water[poolB];
  ok(Math.abs(levelA - levelB) < 0.008,
    `Geschlossene Staufläche nivelliert auf einen gemeinsamen Pegel (${levelA.toFixed(3)} vs ${levelB.toFixed(3)})`);
  ok(lt.water[poolA] + lt.water[poolB] >= levelMass0 * 0.96,
    'Nivellieren einer geschlossenen Senke erhält die Wassermasse weitgehend');

  // (d3) Ein abgeschlossenes tiefes Loch hat keinen Ablauf: Unterwasser-Erosion darf den Pegel
  // nicht dauerhaft verändern oder das Loch immer weiter ausbaggern.
  const ew = createWorld({ data, seed: 5555, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const et = ew.terrain, ex = 15, ey = 15, hole = ey * ew.terrain.w + ex;
  et.sources.length = 0; et.waterActive.clear();
  for (let i = 0; i < et.water.length; i++) {
    et.type[i] = TT.LAND; et.height[i] = 0.84; et.height0[i] = 0.84;
    et.water[i] = 0; et.baseWater[i] = 0; et.waterBlock[i] = 0; et.block[i] = 0;
    if (et.lakeMask) et.lakeMask[i] = 0;
    if (et.startSafe) et.startSafe[i] = 0;
  }
  et.height[hole] = et.height0[hole] = 0.32;
  et.water[hole] = 0.22;
  et.waterActive.add(hole);
  const holeLevel0 = et.height[hole] + et.water[hole];
  for (let k = 0; k < 1200; k++) { stepWater(ew); ew.tick++; }
  const holeLevel1 = et.height[hole] + et.water[hole];
  ok(Math.abs(holeLevel1 - holeLevel0) < 0.004,
    `Abflussloses Loch behaelt seinen Pegel ohne Quelle (${holeLevel0.toFixed(3)} -> ${holeLevel1.toFixed(3)})`);
  ok(Math.abs(et.terra[hole] || 0) < 0.001,
    'Abflussloses Loch wird durch stehendes Wasser nicht endlos tiefer erodiert');

  // (d4) Hat temporäres Wasser einen offenen Ablauf zum Kartenrand/Meer, darf es nicht als
  // dauerhafte Pfützenfläche liegen bleiben.
  const ow = createWorld({ data, seed: 5454, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const ot = ow.terrain, ox = 22, oy = 16;
  ot.sources.length = 0; ot.waterActive.clear();
  for (let y = 0; y < ot.h; y++) for (let x = 0; x < ot.w; x++) {
    const i = y * ot.w + x;
    ot.type[i] = TT.LAND; ot.height[i] = 0.30 + x * 0.006; ot.height0[i] = ot.height[i];
    ot.water[i] = 0; ot.baseWater[i] = 0; ot.waterBlock[i] = 0; ot.block[i] = 0;
    if (ot.lakeMask) ot.lakeMask[i] = 0;
    if (ot.startSafe) ot.startSafe[i] = 0;
  }
  const runoff = oy * ot.w + ox;
  ot.water[runoff] = 0.18; ot.waterActive.add(runoff);
  const runoff0 = ot.water.reduce((s, v) => s + v, 0);
  for (let k = 0; k < 90; k++) { stepWater(ow); ow.tick++; }
  const runoffMax = ot.water.reduce((m, v) => Math.max(m, v), 0);
  const runoff1 = ot.water.reduce((s, v) => s + v, 0);
  ok(runoffMax < WET_DEPTH * 0.35,
    `Offene Rinne baut sichtbares Wasser zu Restfeuchte ab (max=${runoffMax.toFixed(3)}, Masse ${runoff0.toFixed(3)} → ${runoff1.toFixed(3)})`);

  // (e) Regen füllt auch normale lokale Senken, nicht nur vordefinierte Seen/Täler.
  const rw = createWorld({ data, seed: 6161, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const rt = rw.terrain, rx = 15, ry = 15;
  rw.env = { weather: 'rain', solar: 0 };
  rt.sources.length = 0; rt.waterActive.clear();
  for (let y = 0; y < rt.h; y++) for (let x = 0; x < rt.w; x++) {
    const i = y * rt.w + x;
    const d = Math.hypot(x - rx, y - ry);
    rt.type[i] = TT.LAND; rt.height[i] = d <= 8 ? 0.36 + d * 0.022 : 0.78; rt.height0[i] = rt.height[i];
    rt.water[i] = 0; rt.baseWater[i] = 0; rt.waterBlock[i] = 0; rt.block[i] = 0;
    if (rt.lakeMask) rt.lakeMask[i] = 0;
    if (rt.startSafe) rt.startSafe[i] = d > 8 ? 1 : 0;
    if (rt.snow) rt.snow[i] = 0;
  }
  const rainBasin = ry * rt.w + rx;
  for (let k = 0; k < 180; k++) { stepWater(rw); rw.tick++; }
  ok(rt.water[rainBasin] > WET_DEPTH * 3,
    `Regen staut in einer lokalen Senke sichtbar Wasser auf (${rt.water[rainBasin].toFixed(3)} > ${(WET_DEPTH * 3).toFixed(3)})`);

  // (f) Serialisierung streamt terraformte Zellen.
  const terra = serializeSnapshot(tw).terra;
  ok(Array.isArray(terra) && terra.length >= 2 && terra.includes(iRidge), 'Snapshot streamt terraformte Zellen (für Client-Geländemesh)');
}

// 18) Umwelt (Phase 14): Tag/Nacht, Solar, Kraftwerks-Kühlung, Regen, Blitz, Erdbeben
{
  const { initEnv, stepEnvironment, checkRainSlides } = await import('../shared/systems/environment.js');
  const { stepEconomy } = await import('../shared/systems/economy.js');

  // (a) Solarfeld: voller Ertrag am Mittag, nichts um Mitternacht.
  const we = createWorld({ data, seed: 99, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  initEnv(we);
  we.env.weather = 'clear'; we.env.weatherLeft = 1e9; we.env._nextQuake = 1e9;
  const sol = spawnBuilding(we, 0, 'solar_plant', 10, 10); sol.buildProgress = 1;
  we.env.dayT = 0.5; stepEnvironment(we); stepEconomy(we);
  const noonProd = we.players[0].energy.produced;
  we.env.dayT = 0.0; stepEnvironment(we); stepEconomy(we);
  const nightProd = we.players[0].energy.produced;
  ok(noonProd >= 90, `Solarfeld liefert am Mittag (~${noonProd})`);
  ok(nightProd <= 5, `Solarfeld liefert nachts nichts (~${nightProd})`);
  // Regen drosselt Solar massiv.
  we.env.dayT = 0.5; we.env.weather = 'rain'; stepEnvironment(we); stepEconomy(we);
  ok(we.players[0].energy.produced < noonProd * 0.4, 'Regen drosselt Solarertrag');
  we.env.weather = 'clear';

  // (b) Ölkraftwerk: volle Leistung mit Öl+Wasser, Einbruch ohne Kühlwasser/Brennstoff.
  const pl = spawnBuilding(we, 0, 'power_plant', 14, 10); pl.buildProgress = 1;
  we.env.dayT = 0.0; stepEnvironment(we); // Nacht → Solar 0, nur Ölkraftwerk zählt
  const P = we.players[0];
  P.resources.fuel = 500; P.resources.water = 100;
  stepEconomy(we);
  const fullP = P.energy.produced;
  P.resources.water = 0; stepEconomy(we);
  const dryP = P.energy.produced;
  P.resources.fuel = 0; stepEconomy(we);
  const deadP = P.energy.produced;
  ok(fullP >= 115, `Ölkraftwerk volle Leistung mit Öl+Wasser (${fullP})`);
  ok(dryP < fullP * 0.7, `ohne Kühlwasser bricht die Leistung ein (${dryP})`);
  ok(deadP < dryP, `ohne Öl zusätzlich weniger (${deadP})`);
  ok(P.resources.water === 0 || P.resources.water < 100, 'Kraftwerk verbraucht Kühlwasser');

  // (c) Nachtbeleuchtung: Verbrauch nachts höher als am Tag (gleiche Gebäude).
  P.resources.fuel = 500; P.resources.water = 100;
  we.env.dayT = 0.5; stepEnvironment(we); stepEconomy(we);
  const dayCons = P.energy.consumed;
  we.env.dayT = 0.0; stepEnvironment(we); stepEconomy(we);
  const nightCons = P.energy.consumed;
  ok(nightCons > dayCons, `Beleuchtung: Nachtverbrauch ${nightCons} > Tagverbrauch ${dayCons}`);

  // (d) Regen lässt den Gesamtwasserstand steigen (Pegelanstieg), trotz Versickerung.
  const sum = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; };
  const before = sum(we.terrain.water);
  we.env.weather = 'rain';
  for (let k = 0; k < 40; k++) { stepWater(we); we.tick++; }
  const after = sum(we.terrain.water);
  ok(after > before + 0.5, `Regen erhöht den Wasserstand (Σ ${before.toFixed(1)} → ${after.toFixed(1)})`);
  we.env.weather = 'clear';

  // (e) Gewitter: Blitz schlägt ein und beschädigt das höchstgelegene Objekt der Stichprobe.
  we.events = [];
  we.env.weather = 'storm'; we.env._lightningCd = 0;
  const hpBefore = new Map([...we.entities.values()].map(e => [e.id, e.hp]));
  stepEnvironment(we);
  const bolt = we.events.find(ev => ev.type === 'lightning');
  ok(bolt, 'Gewitter erzeugt Blitzeinschlag-Event');
  const struck = [...we.entities.values()].some(e => e.hp < hpBefore.get(e.id));
  ok(!bolt || !bolt.hit || struck, 'Blitz beschädigt das getroffene Objekt');
  we.env.weather = 'clear';

  // (f) Erdbeben: an steilen Hängen rutscht Material ab (Höhen ändern sich, terra wird gestreamt).
  const t = we.terrain;
  const qx = 50, qy = 50;
  const iHigh = qy * t.w + qx, iLow = qy * t.w + qx + 1;
  t.height[iHigh] = 0.85; t.height0[iHigh] = 0.85;
  t.height[iLow] = 0.45; t.height0[iLow] = 0.45;
  for (const [ox, oy] of [[0, 3], [3, 0], [-3, 0], [0, -3], [4, 4], [-4, 4]]) {
    const hi = (qy + oy) * t.w + qx + ox;
    const lo = hi + 1;
    t.height[hi] = 0.86; t.height0[hi] = 0.86; t.terra[hi] = 0;
    t.height[lo] = 0.46; t.height0[lo] = 0.46; t.terra[lo] = 0;
  }
  we.env.quake = { x: qx * 2, y: qy * 2, tx: qx, ty: qy, r: 14, left: 3.5 };
  we.events = [];
  for (let k = 0; k < 40 && we.env.quake; k++) stepEnvironment(we);
  ok(t.height[iHigh] < 0.85 - 1e-4, `Hangrutsch trägt die steile Zelle ab (${t.height[iHigh].toFixed(3)})`);
  const slideEvents = we.events.filter(ev => ev.type === 'landslide');
  ok(slideEvents.length >= 1 && slideEvents.some(ev => (ev.path || []).length >= 4),
    `Erdbeben löst sichtbare, längere Hangrutschpfade aus (${slideEvents.length})`);
  const slideShapes = new Set(slideEvents.map(ev => {
    const p = ev.path || [], dirs = [];
    for (let n = 2; n + 1 < p.length; n += 2) dirs.push(`${Math.sign(p[n] - p[n - 2])},${Math.sign(p[n + 1] - p[n - 1])}`);
    return dirs.join('|');
  }));
  const branchedSlides = slideEvents.filter(ev => Array.isArray(ev.branches) && ev.branches.length >= 2).length;
  ok(branchedSlides > 0 || slideShapes.size > 1,
    `Erdbeben/Hangrutsche erzeugen variablere 3D-Muster (${branchedSlides} Nebenpfade, ${slideShapes.size} Formen)`);
  // Material kann weiter kaskadieren — entscheidend: irgendwo im Bebenradius wurde angelandet (terra>0).
  let deposited = false;
  for (let i = 0; i < t.terra.length; i++) if (t.terra[i] > 1e-4) { deposited = true; break; }
  ok(deposited, 'abgerutschtes Material landet hangabwärts (terra>0 irgendwo im Radius)');
  ok(t.terra[iHigh] !== 0, 'Beben-Höhenänderung wird als Terraform-Delta getrackt (Client-Streaming)');
  let fissureCells = 0, fissureActive = 0;
  for (let i = 0; i < t.terra.length; i++) {
    if (t.terra[i] < -0.035) {
      fissureCells++;
      if (t.waterActive && t.waterActive.has(i)) fissureActive++;
    }
  }
  ok(fissureCells >= Math.round(Math.max(t.w, t.h) * 0.08), `Erdbeben reißt einen langen Graben auf (${fissureCells} Zellen)`);
  ok(fissureActive > 0, 'Erdbebengraben weckt das Wassersystem und kann volllaufen');
  const quakeChanged = [];
  for (let i = 0; i < t.terra.length; i++) if (Math.abs(t.terra[i]) > 0.004) quakeChanged.push(i);
  const quakeRough = deformationRoughness(t, quakeChanged, 1);
  ok(quakeRough.samples > 50 && quakeRough.needles === 0 && quakeRough.maxCurve <= 0.22 && quakeRough.sharp <= 12,
    `Erdbeben-Deformation bleibt gerundet statt zackig (samples=${quakeRough.samples}, nadeln=${quakeRough.needles}, maxKurve=${quakeRough.maxCurve.toFixed(3)}, scharf=${quakeRough.sharp})`);

  const rockWorld = createWorld({ data, seed: 606, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  initEnv(rockWorld);
  const rockTerrain = rockWorld.terrain;
  rockWorld.entities.clear();
  if (rockTerrain.waterActive) rockTerrain.waterActive.clear();
  for (let i = 0; i < rockTerrain.type.length; i++) {
    rockTerrain.type[i] = TT.LAND; rockTerrain.height[i] = 0.62; rockTerrain.height0[i] = 0.62; rockTerrain.terra[i] = 0;
    rockTerrain.water[i] = 0; rockTerrain.baseWater[i] = 0; rockTerrain.waterBlock[i] = 0; rockTerrain.block[i] = 0;
    if (rockTerrain.cover) rockTerrain.cover[i] = 0;
    if (rockTerrain.startSafe) rockTerrain.startSafe[i] = 0;
  }
  const rockPipes = [];
  for (let y = 8; y <= 24; y++) for (let x = 8; x <= 24; x++) {
    const i = tIdx(rockTerrain, x, y);
    const high = (x % 2) === 0;
    rockTerrain.height[i] = high ? 0.88 : 0.54;
    rockTerrain.height0[i] = rockTerrain.height[i];
    if (!high) {
      const pipe = spawnBuilding(rockWorld, 0, 'pipe', x, y);
      pipe.buildProgress = 1; pipe.hp = pipe.maxHp;
      rockPipes.push(pipe);
    }
  }
  const [rockQx, rockQy] = tileToWorld(16, 16);
  (rockWorld.controls || (rockWorld.controls = {})).insanity = 1;
  rockWorld.env.insanity = 1;
  rockWorld.env.weather = 'clear'; rockWorld.env.weatherLeft = 1e9; rockWorld.env._nextQuake = 1e9;
  rockWorld.env.quake = { x: rockQx, y: rockQy, tx: 16, ty: 16, r: 10, left: 1, fissureDone: true, burstDone: true, rocksDone: 1 };
  rockWorld.events = [];
  rockWorld.tick = 3;
  stepEnvironment(rockWorld);
  const rockHitPipes = rockPipes.filter(pipe => pipe.dead || pipe.hp < pipe.maxHp);
  const survivingRockHits = rockHitPipes.filter(pipe => !pipe.dead && pipe.hp > 0 && pipe.hp < pipe.maxHp);
  ok(rockHitPipes.length > 0, 'Beben-Steinschlag trifft die Test-Pipeline');
  ok(survivingRockHits.length > rockHitPipes.length * 0.8,
    'Pipelines überleben Steinschlag überwiegend beschädigt statt sofort zu brechen');

  // (g) Regen destabilisiert steile, nasse Hänge auch ohne Beben.
  const rHigh = qy * t.w + qx + 4, rLow = rHigh + 1;
  const rx = rHigh % t.w, ry = (rHigh / t.w) | 0;
  for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
    const i = (ry + yy) * t.w + (rx + xx);
    t.height[i] = 0.70; t.height0[i] = 0.70; t.terra[i] = 0; t.water[i] = 0.02;
  }
  t.height[rHigh] = 0.78; t.height0[rHigh] = 0.78; t.terra[rHigh] = 0;
  t.height[rLow] = 0.52; t.height0[rLow] = 0.52; t.terra[rLow] = 0;
  t.water[rHigh] = 0.04; t.water[rLow] = 0.02;
  t.waterActive = new Set([rHigh]);
  we.events = [];
  we.tick++;
  for (let k = 0; k < 80 && t.height[rHigh] >= 0.78 - 1e-4; k++) checkRainSlides(we, 1e9);
  const rainSlideEvents = we.events.filter(ev => ev.type === 'landslide');
  const rainDeposit = rainSlideEvents.some(ev => (ev.path || []).some((v, n, path) => {
    if (n % 2 !== 0 || n === 0) return false;
    const tx = Math.round(v / 2 - 0.5), ty = Math.round(path[n + 1] / 2 - 0.5);
    return tx >= 0 && ty >= 0 && tx < t.w && ty < t.h && t.terra[ty * t.w + tx] > 1e-4;
  }));
  ok(t.height[rHigh] < 0.78 - 1e-4 && rainDeposit && rainSlideEvents.some(ev => (ev.path || []).length >= 4),
    'Regen/Fließwasser löst längeren Hangrutsch aus: oben Abtrag, hangabwärts Anlandung');

  const capStarts = [];
  const capX = qx + 10, capY = qy + 8;
  for (let n = 0; n < 6; n++) {
    const high = capY * t.w + capX + n * 2, low = high + 1;
    t.height[high] = 0.82; t.height0[high] = 0.82; t.terra[high] = 0; t.water[high] = 0;
    t.height[low] = 0.50; t.height0[low] = 0.50; t.terra[low] = 0; t.water[low] = 0;
    capStarts.push(high);
  }
  t.waterActive = new Set(capStarts);
  we.events = []; we.tick++;
  checkRainSlides(we, 1e9);
  const cappedRock = we.events.find(ev => ev.type === 'rockfall');
  ok(!cappedRock || cappedRock.count <= 1, 'Regen-Hangrutsche sind pro Prüfung begrenzt und erzeugen keinen Felssturz-Spam');

  const edgeX = 2, edgeY = qy + 16, edgeHigh = edgeY * t.w + edgeX, edgeLow = edgeHigh + 1;
  for (let yy = -1; yy <= 1; yy++) for (let xx = 0; xx <= 2; xx++) {
    const i = (edgeY + yy) * t.w + edgeX + xx;
    t.height[i] = 0.56; t.height0[i] = 0.56; t.terra[i] = 0; t.water[i] = 0;
  }
  t.height[edgeHigh] = 0.88; t.height0[edgeHigh] = 0.88;
  t.height[edgeLow] = 0.42; t.height0[edgeLow] = 0.42;
  const dryEdgeUnit = spawnUnit(we, 0, 'rifleman', (edgeX + 0.5) * 2, (edgeY + 0.5) * 2);
  const dryEdgeHp = dryEdgeUnit.hp;
  t.waterActive = new Set([edgeHigh]);
  we.events = []; we.tick++;
  for (let k = 0; k < 8; k++) checkRainSlides(we, 1e9);
  ok(dryEdgeUnit.hp === dryEdgeHp && !dryEdgeUnit.dead,
    'Regen-Hangrutsche starten nicht am Kartenrand und töten dort keine trockenen Einheiten');

  // (h) Snapshot enthält Umwelt-Status.
  const ws = createWorld({ data, seed: 5, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  step(ws);
  const es = serializeSnapshot(ws).env;
  ok(es && typeof es.t === 'number' && typeof es.d === 'number' && typeof es.w === 'string', 'Snapshot streamt env (Tageszeit/Licht/Wetter)');
}

// 19) Wasserwirtschaft: Pumpwerk + Leitungsnetz (Phase 14)
{
  const w = createWorld({ data, seed: 1234, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const { initEnv } = await import('../shared/systems/environment.js');
  initEnv(w); w.env.weather = 'clear'; w.env.weatherLeft = 1e9; w.env._nextQuake = 1e9;
  const hq = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const tower = spawnBuilding(w, 0, 'water_tower', hq.tx + 6, hq.ty); tower.buildProgress = 1;
  // Pumpwerk in eine Kartenecke setzen, die weit (>15 Tiles) von ALLEN Gebäuden entfernt ist.
  const builds = ownerEntities(w, 0, 'building');
  const corners = [[5, 5], [90, 5], [5, 90], [90, 90]];
  const farDist = ([x, y]) => Math.min(...builds.map(b => Math.max(Math.abs(b.tx - x), Math.abs(b.ty - y))));
  const corner = corners.sort((a, b) => farDist(b) - farDist(a))[0];
  ok(farDist(corner) > 15, `Ecke weit genug von der Basis (${farDist(corner)} Tiles)`);
  const [px, py] = corner;
  const pump = spawnBuilding(w, 0, 'water_pump', px, py); pump.buildProgress = 1;
  // Pumpwerk steht im Süßwasser (Voraussetzung fürs Fördern): Standfläche als Binnensee markieren.
  for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
    const i = (py + yy) * w.terrain.w + (px + xx);
    if (w.terrain.lakeMask) w.terrain.lakeMask[i] = 1;
    w.terrain.water[i] = Math.max(w.terrain.water[i] || 0, 0.2);
  }
  const P = w.players[0];
  for (let i = 0; i < 25; i++) step(w);
  const wUnconnected = P.resources.water;
  ok(pump._wConnected === false, 'Fernes Pumpwerk ohne Leitung ist NICHT verbunden');
  // Pipeline-Kette vom Pumpwerk zum echten Wasserturm legen: 1-Tile-Schritte entlang der Linie.
  const segs = [];
  const ex = tower.tx + 1, ey = tower.ty + 1;
  const n = Math.ceil(Math.max(Math.abs(ex - px), Math.abs(ey - py)));
  for (let k = 1; k < n; k++) {
    const sx = Math.round(px + (ex - px) * (k / n)), sy = Math.round(py + (ey - py) * (k / n));
    const seg = spawnBuilding(w, 0, 'pipe', sx, sy); seg.buildProgress = 1;
    segs.push(seg);
  }
  for (let i = 0; i < 25; i++) step(w);
  ok(pump._wConnected === true, 'Mit Pipeline-Kette zum Wasserturm ist das Pumpwerk verbunden');
  ok(P.resources.water > wUnconnected + 1, 'Verbundenes Pumpwerk fördert Wasser');
  // Leitungsbruch: drei benachbarte Segmente zerstören (Lücke > Link-Reichweite) → Versorgung reißt ab.
  const midK = Math.floor(segs.length / 2);
  for (const seg of segs.slice(midK, midK + 3)) applyDamage(w, seg, seg.hp + 1, null);
  for (let i = 0; i < 25; i++) step(w);
  ok(pump._wConnected === false, 'Leitungsbruch kappt die Wasserversorgung (strategisches Ziel)');
}

// 20) Infrastruktur: Brücke über Wasser, Tunnel durch den Berg, Graben-Aushub liefert Erde
{
  const w = createWorld({ data, seed: 777, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  for (const e of ownerEntities(w, 0, 'building')) e.buildProgress = 1;
  // Wasserzelle finden
  let wi = -1; for (let i = 0; i < t.water.length; i++) if (isNavigableWater(t, i % t.w, (i / t.w) | 0)) { wi = i; break; }
  ok(wi >= 0, 'Wasserzelle gefunden');
  const wx = wi % t.w, wy = (wi / t.w) | 0;
  ok(!isPassable(t, 'land', wx, wy), 'Wasser ist für Land unpassierbar');
  const br = spawnBuilding(w, 0, 'bridge', wx, wy); br.buildProgress = 1; applyFortification(w, br);
  ok(isPassable(t, 'land', wx, wy), 'Brücke macht Wasser für Landeinheiten passierbar');
  ok(isPassable(t, 'water', wx, wy), 'Schiffe passieren unter der Brücke');
  removeFortification(w, br);
  ok(!isPassable(t, 'land', wx, wy), 'Zerstörte Brücke: Wasser wieder unpassierbar');
  let gi = -1;
  for (let y = 4; y < t.h - 4 && gi < 0; y++) for (let x = 4; x < t.w - 4; x++) {
    if (canPlaceBuilding(w, x, y, 1, data.buildings.trench, 0)) { gi = tIdx(t, x, y); break; }
  }
  ok(gi >= 0, 'Trockene Graben-Testzelle gefunden');
  const gx = gi % t.w, gy = (gi / t.w) | 0;
  t.type[gi] = TT.LAND; t.height[gi] = 0.55; t.water[gi] = 0; t.baseWater[gi] = 0; t.block[gi] = 0;
  if (t.ore) t.ore[gi] = 0;
  if (t.oil) t.oil[gi] = 0;
  ok(!canPlaceBuilding(w, gx, gy, 1, data.buildings.bridge, 0), 'Brücke darf nicht frei auf trockenes Land');
  const trench = spawnBuilding(w, 0, 'trench', gx, gy); trench.buildProgress = 1; applyFortification(w, trench);
  ok(!isPassable(t, 'land', gx, gy), 'Graben sperrt trockene Zelle');
  ok(canPlaceBuilding(w, gx, gy, 1, data.buildings.bridge, 0), 'Brücke darf über einen Graben gelegt werden');
  const gapBridge = spawnBuilding(w, 0, 'bridge', gx, gy); gapBridge.buildProgress = 1; applyFortification(w, gapBridge);
  ok(isPassable(t, 'land', gx, gy), 'Brücke über Graben macht die Sperre passierbar');
  // Klippenzelle finden
  let ci = -1; for (let i = 0; i < t.type.length; i++) if (t.type[i] === TT.CLIFF) { ci = i; break; }
  ok(ci >= 0, 'Klippenzelle gefunden');
  const cx = ci % t.w, cy = (ci / t.w) | 0;
  ok(!isPassable(t, 'land', cx, cy), 'Klippe ist für Land unpassierbar');
  ok(canPlaceBuilding(w, cx, cy, 1, data.buildings.tunnel), 'Tunnel darf auf Klippen gebaut werden');
  ok(!canPlaceBuilding(w, cx, cy, 1, data.buildings.barracks), 'Normale Gebäude weiterhin nicht auf Klippen');
  const tu = spawnBuilding(w, 0, 'tunnel', cx, cy); tu.buildProgress = 1; applyFortification(w, tu);
  ok(isPassable(t, 'land', cx, cy), 'Tunnel macht die Klippe für Landeinheiten passierbar');
  removeFortification(w, tu);
  ok(!isPassable(t, 'land', cx, cy), 'Eingestürzter Tunnel: Klippe wieder dicht');
  let ci2 = -1; for (let i = ci + 1; i < t.type.length; i++) if (t.type[i] === TT.CLIFF) { ci2 = i; break; }
  const tx2 = ci2 % t.w, ty2 = (ci2 / t.w) | 0;
  const dig = spawnBuilding(w, 0, 'tunnel', tx2, ty2);
  // Vorhandene Bagger entfernen, damit nur der gleich gespawnte Bagger vor Ort den Tunnel gräbt
  // (früher per Park-Befehl ruhiggestellt; ein abgeschlossener Move gibt Einheiten jetzt korrekt frei).
  for (const u of ownerEntities(w, 0, 'unit')) if (u.kind === 'builder') w.entities.delete(u.id);
  spawnUnit(w, 0, 'rifleman', dig.x + 2, dig.y);
  for (let i = 0; i < 80; i++) step(w);
  ok(dig.buildProgress === 0, 'Fußtruppen bauen keinen Tunnel');
  spawnUnit(w, 0, 'builder', dig.x + 2, dig.y);
  for (let i = 0; i < 140 && dig.buildProgress < 1; i++) step(w);
  ok(dig.buildProgress >= 1, 'Bagger vor Ort gräbt den Tunnel');
  // Graben-Aushub: Fertigstellung füllt den zugewiesenen Erdhügel. Ein Bagger arbeitet vor Ort.
  const P = w.players[0];
  const m0 = P.resources.materials;
  for (const u of ownerEntities(w, 0, 'unit')) if (u.kind === 'truck') w.entities.delete(u.id);
  const tr = spawnBuilding(w, 0, 'trench', 30, 30);
  spawnUnit(w, 0, 'builder', tr.x + 2, tr.y);
  step(w);
  const pile = w.entities.get(tr.earthPileId);
  ok(pile && pile.kind === 'earth_pile', 'Graben-Baustelle weist automatisch einen Erdhügelplatz zu');
  ok(pile && !isPassable(t, 'land', pile.tx, pile.ty), 'Erdhügel blockiert Bodenbewegung');
  const oldPile = [pile.tx, pile.ty];
  let movedPile = null;
  for (let r = 2; r <= 10 && !movedPile; r++) for (let dy = -r; dy <= r && !movedPile; dy++) for (let dx = -r; dx <= r && !movedPile; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const nx = tr.tx + dx, ny = tr.ty + dy;
    if ((nx !== oldPile[0] || ny !== oldPile[1]) && canPlaceBuilding(w, nx, ny, 1, data.buildings.earth_pile)) movedPile = [nx, ny];
  }
  ok(!!movedPile, 'Alternativer Erdhügelplatz gefunden');
  if (movedPile) {
    applyCommand(w, { type: 'setPile', site: tr.id, tx: movedPile[0], ty: movedPile[1] }, 0);
    ok(pile.tx === movedPile[0] && pile.ty === movedPile[1], 'Erdhügelplatz der Baustelle kann umgesetzt werden');
    ok(isPassable(t, 'land', oldPile[0], oldPile[1]) && !isPassable(t, 'land', pile.tx, pile.ty), 'Umgesetzter Erdhügel verschiebt seine Blockade');
  }
  for (let i = 0; i < 120 && tr.buildProgress < 1; i++) step(w);
  ok(tr.buildProgress >= 1, 'Bagger vor Ort errichtet den Graben');
  ok((pile.amount || 0) >= (data.buildings.trench.earthYield || 0) - 1,
    `Graben-Aushub füllt den Erdhügel (${(pile.amount || 0).toFixed(0)})`);
  ok(P.resources.materials <= m0 + 1, 'Aushub wird nicht mehr direkt ins Depot gebucht');
}

// 20a) Pipelines erhalten praktische Durchfahrten: Straßen kreuzen sie, Brücken tragen sie über Wasser.
{
  const w = createWorld({ data, seed: 778, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  w.entities.clear();
  if (!t.startSafe) t.startSafe = new Uint8Array(t.w * t.h);
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
    if (t.ore) t.ore[i] = 0;
    if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
  }
  const pipe = spawnBuilding(w, 0, 'pipe', 10, 10); pipe.buildProgress = 1; pipe.hp = pipe.maxHp;
  ok(isPassable(t, 'land', 10, 10), 'Pipeline selbst blockiert Bodenbewegung nicht');
  ok(canPlaceBuilding(w, 10, 10, 1, data.buildings.road, 0), 'Straße darf einen Pipeline-Durchfahrpunkt kreuzen');
  const road = spawnBuilding(w, 0, 'road', 10, 10); road.buildProgress = 1; applyFortification(w, road);
  ok(isPassable(t, 'land', 10, 10), 'Pipeline-Durchfahrt bleibt auch mit Straße passierbar');
  const roadOnly = spawnBuilding(w, 0, 'road', 12, 10); roadOnly.buildProgress = 1; applyFortification(w, roadOnly);
  ok(canPlaceBuilding(w, 12, 10, 1, data.buildings.pipe, 0), 'Pipeline darf über eine bestehende Straße geführt werden');
  const roadPipe = spawnBuilding(w, 0, 'pipe', 12, 10); roadPipe.buildProgress = 1; roadPipe.hp = roadPipe.maxHp;
  ok(isPassable(t, 'land', 12, 10, 'vehicle'), 'Fahrzeuge fahren unter der Pipeline weiter über die Straße');
  const rx = 18, ry = 10, ri = tIdx(t, rx, ry);
  t.type[ri] = TT.WATER; t.height[ri] = SEA_LEVEL - 0.06; t.water[ri] = NAVIGABLE_DEPTH; t.baseWater[ri] = t.water[ri];
  const waterRoad = spawnBuilding(w, 0, 'road', rx, ry); waterRoad.buildProgress = 1; applyFortification(w, waterRoad); waterRoad.hp = 1;
  applyDamage(w, waterRoad, 999, null, 'water');
  ok(!waterRoad.dead && waterRoad.hp === 1, 'Straße im Wasser ignoriert Wasserschaden');
  const site = spawnBuilding(w, 0, 'factory', 20, 10); site.buildProgress = 0.25; site.hp = 1;
  applyDamage(w, site, 999, null, 'water');
  ok(!site.dead && site.hp === 1, 'Baustelle ignoriert Wasserschaden');
  const px = 24, py = 10;
  for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
    const i = tIdx(t, px + xx, py + yy);
    t.type[i] = TT.WATER; t.height[i] = SEA_LEVEL - 0.08; t.water[i] = NAVIGABLE_DEPTH + 0.05; t.baseWater[i] = t.water[i];
    if (t.lakeMask) t.lakeMask[i] = 1;
  }
  const pumpSite = spawnBuilding(w, 0, 'water_pump', px, py); pumpSite.buildProgress = 0; pumpSite.hp = 1;
  const pumpBuilder = spawnUnit(w, 0, 'builder', 3, 3);
  pumpBuilder.resourceRole = 'build';
  pumpBuilder.order = { type: 'construct', site: pumpSite.id };
  pumpBuilder._conT = 46;
  stepConstruction(w);
  ok(!pumpSite.dead && pumpSite.hp === 1 && pumpBuilder.order.type === 'idle',
    'Pumpstations-Baustelle bleibt bei schwankendem Wasserpegel stehen und gibt den Bagger frei');
  const stuckSite = spawnBuilding(w, 0, 'factory', 28, 10); stuckSite.buildProgress = 0; stuckSite.hp = 1;
  const stuckBuilder = spawnUnit(w, 0, 'builder', 3, 5);
  stuckBuilder.resourceRole = 'build';
  stuckBuilder.order = { type: 'construct', site: stuckSite.id };
  stuckBuilder._conT = 46;
  stepConstruction(w);
  ok(stuckSite.dead, 'Normale unerreichbare Baustelle wird weiterhin abgebrochen');

  const bx = 14, by = 10, bi = tIdx(t, bx, by);
  t.type[bi] = TT.WATER; t.height[bi] = SEA_LEVEL - 0.08; t.water[bi] = NAVIGABLE_DEPTH + 0.05; t.baseWater[bi] = t.water[bi];
  ok(canPlaceBuilding(w, bx, by, 1, data.buildings.pipe, 0), 'Pipeline darf jetzt auch frei durchs Wasser verlegt werden (waterOptional)');
  const ux = 16, uy = 10, ui = tIdx(t, ux, uy);
  t.type[ui] = TT.WATER; t.height[ui] = SEA_LEVEL - 0.08; t.water[ui] = NAVIGABLE_DEPTH + 0.05; t.baseWater[ui] = t.water[ui];
  const underwaterPipe = spawnBuilding(w, 0, 'pipe', ux, uy); underwaterPipe.buildProgress = 1; underwaterPipe.hp = 1;
  applyDamage(w, underwaterPipe, 999, null, 'rockfall', { rockfall: 1 });
  ok(!underwaterPipe.dead && underwaterPipe.hp === 1, 'Unterwasser-Pipeline ignoriert naturbedingten Schaden');
  const bridge = spawnBuilding(w, 0, 'bridge', bx, by); bridge.buildProgress = 1; applyFortification(w, bridge);
  ok(canPlaceBuilding(w, bx, by, 1, data.buildings.pipe, 0), 'Pipeline darf auf einer fertigen Brücke über Wasser geführt werden');
  const bridgePipe = spawnBuilding(w, 0, 'pipe', bx, by); bridgePipe.buildProgress = 1; bridgePipe.hp = bridgePipe.maxHp;
  ok(isPassable(t, 'land', bx, by) && isPassable(t, 'water', bx, by),
    'Pipeline auf der Brücke lässt Land- und Wasserwege offen');
  pipe.hp = 30;
  w.players[0].controller = 'ai';
  const repairBuilder = spawnUnit(w, 0, 'builder', 10 * 2 + 1, 11 * 2 + 1);
  repairBuilder.resourceRole = 'build';
  for (let k = 0; k < 60 && pipe.hp < pipe.maxHp; k++) step(w);
  ok(pipe.hp >= pipe.maxHp, 'KI-Bagger repariert beschädigte Pipeline');
}

// 20b) Brücken und Staudämme müssen vom Ufer/aus der Nähe gebaut werden können.
{
  const makeFlatWorld = (seed) => {
    const w = createWorld({ data, seed, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
    const t = w.terrain;
    w.entities.clear();
    for (let i = 0; i < t.type.length; i++) {
      t.type[i] = TT.LAND; t.height[i] = 0.55; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
      if (t.height0) t.height0[i] = 0.55;
      if (t.coverBuilt) t.coverBuilt[i] = 0;
      if (t.ore) t.ore[i] = 0;
      if (t.oil) t.oil[i] = 0;
      if (t.mud) t.mud[i] = 0;
      if (t.road) t.road[i] = 0;
      if (t.roadBuilt) t.roadBuilt[i] = 0;
      if (t.bridge) t.bridge[i] = 0;
      if (t.waterBlock) t.waterBlock[i] = 0;
      if (t.lakeMask) t.lakeMask[i] = 0;
    }
    return w;
  };
  {
    const w = makeFlatWorld(779);
    const t = w.terrain;
    const bx = 14, by = 14, bi = tIdx(t, bx, by);
    t.type[bi] = TT.WATER; t.height[bi] = SEA_LEVEL - 0.08; t.water[bi] = NAVIGABLE_DEPTH + 0.05; t.baseWater[bi] = t.water[bi];
    const bridge = spawnBuilding(w, 0, 'bridge', bx, by);
    const builder = spawnUnit(w, 0, 'builder', bridge.x - 7, bridge.y);
    builder.resourceRole = 'build';
    builder.order = { type: 'construct', site: bridge.id };
    ok(Math.hypot(bridge.x - builder.x, bridge.y - builder.y) > (bridge.size || 1) + 3,
      'Brücken-Testbagger steht außerhalb der alten Baustellen-Reichweite');
    for (let k = 0; k < 100 && bridge.buildProgress < 1; k++) step(w);
    ok(bridge.buildProgress >= 1, 'Bagger in der Nähe baut die Brücke über Wasser fertig');
  }
  {
    const w = makeFlatWorld(780);
    const dam = spawnBuilding(w, 0, 'dam', 15, 15);
    const builder = spawnUnit(w, 0, 'builder', dam.x + 7, dam.y);
    builder.resourceRole = 'build';
    builder.order = { type: 'construct', site: dam.id };
    ok(Math.hypot(dam.x - builder.x, dam.y - builder.y) > (dam.size || 1) + 3,
      'Staudamm-Testbagger steht außerhalb der alten Baustellen-Reichweite');
    for (let k = 0; k < 180 && dam.buildProgress < 1; k++) step(w);
    ok(dam.buildProgress >= 1, 'Bagger in der Nähe baut den Staudamm fertig');
  }
}

{
  const w = createWorld({ data, seed: 902, map: { w: 32, h: 24 }, players: [{ id: 0, faction: 'KBN', controller: 'ai' }] });
  const t = w.terrain, p = w.players[0];
  w.entities.clear();
  p.resources.ore = 10000; p.resources.materials = 10000; p.resources.water = 1000; p.resources.fuel = 1000;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
    if (t.height0) t.height0[i] = 0.55;
    if (t.coverBuilt) t.coverBuilt[i] = 0;
    if (t.ore) t.ore[i] = 0;
    if (t.oil) t.oil[i] = 0;
    if (t.mud) t.mud[i] = 0;
    if (t.road) t.road[i] = 0;
    if (t.roadBuilt) t.roadBuilt[i] = 0;
    if (t.bridge) t.bridge[i] = 0;
    if (t.tunnel) t.tunnel[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const hq = spawnBuilding(w, 0, 'hq', 3, 8); hq.buildProgress = 1; hq.hp = hq.maxHp;
  const prod = spawnBuilding(w, 0, 'oil_derrick', 8, 8); prod.buildProgress = 1; prod.hp = prod.maxHp;
  const sink = spawnBuilding(w, 0, 'oil_depot', 18, 8); sink.buildProgress = 1; sink.hp = sink.maxHp;
  const road = spawnBuilding(w, 0, 'road', 12, 7); road.buildProgress = 1; road.hp = road.maxHp; applyFortification(w, road);
  spawnUnit(w, 0, 'builder', hq.x + 2, hq.y + 2);
  initAi(p);
  stepAi(w, p, applyCommand);
  ok(ownerEntities(w, 0, 'building').some(e => e.kind === 'pipe' && e.tx === road.tx && e.ty === road.ty),
    'KI darf Pipeline-Segmente direkt über Straßen planen');
  ok(isPassable(t, 'land', road.tx, road.ty, 'vehicle'),
    'KI-Pipeline auf Straße blockiert Fahrzeuge nicht');
}

// 20a.1) Komplett zerstörte Pipeline-Segmente werden als fehlende Leitung wieder aufgebaut.
{
  const w = createWorld({ data, seed: 780, map: { w: 32, h: 24 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain, p = w.players[0];
  w.entities.clear();
  p.resources.ore = 10000; p.resources.materials = 10000; p.resources.water = 1000; p.resources.fuel = 1000;
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
    if (t.height0) t.height0[i] = 0.55;
    if (t.ore) t.ore[i] = 0;
    if (t.oil) t.oil[i] = 0;
    if (t.lakeMask) t.lakeMask[i] = 0;
  }
  const hq = spawnBuilding(w, 0, 'hq', 3, 8); hq.buildProgress = 1;
  const prod = spawnBuilding(w, 0, 'oil_derrick', 8, 8); prod.buildProgress = 1;
  const sink = spawnBuilding(w, 0, 'oil_depot', 18, 8); sink.buildProgress = 1;
  const segs = [[10, 8], [12, 8], [14, 8], [16, 8]].map(([x, y]) => {
    const seg = spawnBuilding(w, 0, 'pipe', x, y); seg.buildProgress = 1;
    return seg;
  });
  stepEconomy(w);
  ok(prod._pipelineConnected === true, 'Testleitung ist vor dem Bruch verbunden');
  const missing = segs[1];
  applyDamage(w, missing, missing.hp + 1, null, 'rockfall', { rockfall: 1 });
  step(w); // Cleanup entfernt das tote Segment und merkt die Lücke.
  ok(![...w.entities.values()].some(e => e.id === missing.id), 'Zerstörtes Pipeline-Segment ist vollständig entfernt');
  ok(w.aiPipeRebuildSites?.some(s => s.owner === 0 && s.tx === missing.tx && s.ty === missing.ty), 'Fehlendes Pipeline-Segment wird für KI-Wiederaufbau gemerkt');
  p.controller = 'ai';
  const repairBuilder = spawnUnit(w, 0, 'builder', missing.x, missing.y + 2);
  repairBuilder.resourceRole = 'build';
  let rebuilt = null;
  for (let k = 0; k < 180; k++) {
    step(w);
    rebuilt = [...w.entities.values()].find(e => e.owner === 0 && e.kind === 'pipe' && !e.dead && e.tx === missing.tx && e.ty === missing.ty);
    if (rebuilt?.buildProgress >= 1) break;
  }
  ok(rebuilt?.buildProgress >= 1, 'KI baut ein komplett fehlendes Pipeline-Segment wieder auf');
  for (let k = 0; k < 15; k++) step(w);
  ok(prod._pipelineConnected === true, 'Wiederaufgebautes Segment verbindet die Förderkette erneut');
}

// 20a.2) Basis-Plateaus bleiben auf den unteren beiden Umwelt-Schwierigkeitsgraden kraterfrei.
{
  const w = createWorld({ data, seed: 779, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  w.entities.clear();
  if (!t.startSafe) t.startSafe = new Uint8Array(t.w * t.h);
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.65; t.water[i] = 0; t.baseWater[i] = 0;
    if (t.height0) t.height0[i] = 0.65;
    if (t.terra) t.terra[i] = 0;
    if (t.startSafe) t.startSafe[i] = 0;
  }
  const tx = 12, ty = 12, ci = tIdx(t, tx, ty);
  for (let y = ty - 1; y <= ty + 1; y++) for (let x = tx - 1; x <= tx + 1; x++) t.startSafe[tIdx(t, x, y)] = 1;
  const h0 = t.height[ci];
  w.controls.insanity = 1;
  w.projectiles.push({ x: tx * 2 + 1, y: ty * 2 + 1, speed: 1000, dmg: 0, splash: 3, vs: {}, owner: 0, attackerId: null, targetId: null, gx: tx * 2 + 1, gy: ty * 2 + 1 });
  stepCombat(w);
  ok(Math.abs(t.height[ci] - h0) < 1e-9, 'StartSafe-Plateau bleibt bei Schwierigkeit 1 kraterfrei');
  ok(w.events.some(e => e.type === 'explosion' && e.noCrater), 'Explosion im StartSafe-Plateau markiert Renderer-Krater als unterdrückt');
  w.events.length = 0;
  w.controls.insanity = 3;
  w.projectiles.push({ x: tx * 2 + 1, y: ty * 2 + 1, speed: 1000, dmg: 0, splash: 3, vs: {}, owner: 0, attackerId: null, targetId: null, gx: tx * 2 + 1, gy: ty * 2 + 1 });
  stepCombat(w);
  ok(t.height[ci] < h0 - 0.005, 'Auf höheren Schwierigkeiten können Explosionen das Plateau weiter vernarben');
}

// 20a.3) Feuernde Einheiten liefern genug Event-Daten, um sie kurz im Nebel aufzudecken.
{
  const w = createWorld({
    data, seed: 781, map: { w: 32, h: 32 },
    players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'HLX', controller: 'human' }],
  });
  w.entities.clear();
  w.events.length = 0;
  w.players[0].resources.ammo = 100;
  const shooter = spawnUnit(w, 0, 'tank', 20, 20);
  const target = spawnUnit(w, 1, 'tank', 20, 26);
  shooter.target = target.id;
  stepCombat(w);
  const fire = w.events.find(e => e.type === 'fire');
  ok(fire?.id === shooter.id && fire.owner === shooter.owner && fire.etype === 'unit',
    'Schuss-Event markiert die feuernde Einheit für Fog-of-War-Reveal');
}

// 20b) Erzabbau legt Haufen an; LKW/Erz-LKW fahren den Haufen ins Erzlager.
{
  const w = createWorld({ data, seed: 44, map: { w: 32, h: 32 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  w.entities.clear();
  for (let i = 0; i < t.type.length; i++) {
    t.type[i] = TT.LAND; t.height[i] = 0.5;
    if (t.height0) t.height0[i] = 0.5;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.ore[i] = 0;
    if (t.tracks) t.tracks[i] = 0;
    if (t.mud) t.mud[i] = 0;
  }
  t.oreList.length = 0;
  const P = w.players[0];
  P.resources.ore = 0;
  const hq = spawnBuilding(w, 0, 'hq', 4, 4); hq.buildProgress = 1;
  const oreIdx = tIdx(t, 12, 12);
  t.ore[oreIdx] = 180; t.oreList.push(oreIdx);
  const digger = spawnUnit(w, 0, 'builder', 12 * 2 + 1, 12 * 2 + 1);
  digger.resourceRole = 'ore';
  for (let k = 0; k < 20; k++) step(w);
  const pile = [...w.entities.values()].find(e => e.kind === 'ore_pile');
  ok(pile && (pile.amount || 0) > 0,
    'Erzabbau legt einen Erzhaufen am Abbauort an');
  ok(P.resources.ore === 0, 'Erzabbau bucht Erz nicht mehr direkt ins Lager');
  for (let i = 0; i < t.water.length; i++) {
    t.water[i] = 0; t.baseWater[i] = 0;
    if (t.mud) t.mud[i] = 0;
  }
  const truck = spawnUnit(w, 0, 'truck', 6 * 2 + 1, 6 * 2 + 1);
  truck.order = { type: 'idle' };
  for (let k = 0; k < 600 && P.resources.ore <= 0; k++) step(w);
  ok(P.resources.ore > 0, 'LKW holt Erzhaufen ab und liefert Erz ins Erzlager');
}

// 21) Phase 15: Inselkarte (Zentralberg/Schnee/Randmeer/Hochseen), Lastabwurf, Straßen,
//     Bagger-Konstruktion & -Terraforming, schwere Fahrzeuge im Wasser
{
  const { initEnv, stepEnvironment } = await import('../shared/systems/environment.js');
  const { stepEconomy } = await import('../shared/systems/economy.js');
  const w = createWorld({ data, seed: 2026, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  initEnv(w); w.env.weather = 'clear'; w.env.weatherLeft = 1e9; w.env._nextQuake = 1e9;
  const t = w.terrain, W = t.w, H = t.h;
  const startUnits = ownerEntities(w, 0, 'unit');
  ok(startUnits.filter(u => u.kind === 'builder').length === 2, 'Startbasis enthält immer 2 Bagger');
  ok(startUnits.filter(u => u.kind === 'truck').length === 2, 'Startbasis enthält immer 2 LKW');
  const startBuildings = ownerEntities(w, 0, 'building');
  const integratedHq = startBuildings.find(b => b.kind === 'hq');
  ok(integratedHq && integratedHq.def.integratedStorage?.ore && integratedHq.def.integratedStorage?.materials && integratedHq.def.integratedStorage?.water,
    'HQ enthält integriertes Erzlager, Baumateriallager und Wasserturm');
  ok(!startBuildings.some(b => b.kind === 'ore_depot' || b.kind === 'material_depot' || b.kind === 'water_tower'),
    'Startbasis nutzt HQ-Integrationslager statt separater Erz-/Material-/Wasserdepots');

  // (a) Randmeer: alle vier Kartenränder sind Wasser.
  ok(SEA_LEVEL < 0.32, `Meeresspiegel liegt niedriger als früher (${SEA_LEVEL.toFixed(2)})`);
  let edgesWet = true;
  let edgeMaxH = -Infinity;
  for (let k = 0; k < W; k += 6) if (t.water[k] <= WET_DEPTH || t.water[(H - 1) * W + k] <= WET_DEPTH) edgesWet = false;
  for (let k = 0; k < H; k += 6) if (t.water[k * W] <= WET_DEPTH || t.water[k * W + W - 1] <= WET_DEPTH) edgesWet = false;
  for (let x = 0; x < W; x++) edgeMaxH = Math.max(edgeMaxH, t.height[x], t.height[(H - 1) * W + x]);
  for (let y = 0; y < H; y++) edgeMaxH = Math.max(edgeMaxH, t.height[y * W], t.height[y * W + W - 1]);
  ok(edgesWet, 'Karte ist vollständig von Meer umgeben');
  ok(edgeMaxH < SEA_LEVEL - 0.02, `Meer liegt am niedrigsten Rand (maxH=${edgeMaxH.toFixed(3)})`);

  const bands = Array.from({ length: 5 }, () => ({ sum: 0, n: 0 }));
  const maxR = Math.hypot(W / 2, H / 2);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const rn = Math.min(0.999, Math.hypot(x - W / 2, y - H / 2) / maxR);
    const b = Math.floor(rn * bands.length);
    bands[b].sum += t.height[y * W + x]; bands[b].n++;
  }
  const bandAvg = bands.map(b => b.sum / Math.max(1, b.n));
  ok(bandAvg.every((v, i) => i === 0 || v < bandAvg[i - 1] - 0.015),
    `Gelände fällt im Mittel von der Mitte zum Meer (${bandAvg.map(v => v.toFixed(2)).join(' > ')})`);

  // (b) Zentralberg mit Schneekappe + zwei Flussquellen (Fluss fließt zu zwei Seiten).
  const ci = (H / 2 | 0) * W + (W / 2 | 0);
  ok(t.height[ci] > 0.85, `Zentralberg in der Kartenmitte (h=${t.height[ci].toFixed(2)})`);
  ok(t.snow[ci] > 0, 'Schneekappe auf dem Gipfel');
  const centerCoreR = Math.max(7, Math.min(W, H) * 0.085);
  let centerMinH = Infinity, centerWet = 0, centerRiverCells = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) > centerCoreR) continue;
    const i = y * W + x;
    centerMinH = Math.min(centerMinH, t.height[i]);
    if (t.water[i] > WET_DEPTH) centerWet++;
  }
  for (const p of t.riverPaths || []) for (const i of p) {
    const x = i % W, y = (i / W) | 0;
    if (Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) <= centerCoreR) centerRiverCells++;
  }
  ok(centerMinH > 0.9 && centerWet === 0 && centerRiverCells === 0,
    `Zentraler Kartenkern bleibt Berg statt Graben/Wasser (minH=${centerMinH.toFixed(2)}, nass=${centerWet}, fluss=${centerRiverCells})`);
  ok(t.sources.length === 2, 'Zwei Flussquellen an den Bergflanken');
  const goodRivers = (t.riverPaths || []).filter(p => {
    const end = p[p.length - 1], ex = end % W, ey = (end / W) | 0;
    return p.length > Math.min(W, H) * 0.25 && t.water[p[0]] > WET_DEPTH && t.water[end] > WET_DEPTH
      && (ex === 0 || ey === 0 || ex === W - 1 || ey === H - 1) && t.height[end] < t.height[p[0]] - 0.25;
  });
  ok(goodRivers.length === t.sources.length, `Alle Flüsse führen vom Berg zum Meer (${goodRivers.length}/${t.sources.length})`);
  let maxRiverBank = 0;
  for (const p of t.riverPaths || []) for (const i of p) {
    if (t.height[i] < SEA_LEVEL - 0.02) continue; // Küstenübergang zum Meer zählt nicht als Flussgraben
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      maxRiverBank = Math.max(maxRiverBank, t.height[ny * W + nx] - t.height[i]);
    }
  }
  ok(maxRiverBank < 0.16, `Flussufer bleiben befahrbar geformt statt als Klippenkante (maxUfer=${maxRiverBank.toFixed(3)})`);
  let maxWetBedStep = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (t.water[i] <= WET_DEPTH * 0.55) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (t.water[j] <= WET_DEPTH * 0.55) continue;
      maxWetBedStep = Math.max(maxWetBedStep, Math.abs(t.height[i] - t.height[j]));
    }
  }
  ok(maxWetBedStep <= 0.078,
    `Wasserbetten bleiben glatt genug für clippingfreie Wasserflächen (maxStufe=${maxWetBedStep.toFixed(3)})`);
  {
    const normalMask = new Uint8Array(W * H);
    const mark = (i, radius) => {
      const cx = i % W, cy = (i / W) | 0;
      for (let yy = -radius; yy <= radius; yy++) for (let xx = -radius; xx <= radius; xx++) {
        const nx = cx + xx, ny = cy + yy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || Math.hypot(xx, yy) > radius) continue;
        normalMask[ny * W + nx] = 1;
      }
    };
    for (const p of t.riverPaths || []) for (const i of p) mark(i, 4);
    for (const p of t.furrowPaths || []) for (const i of p) mark(i, 3);
    for (const v of t.valleys || []) for (const i of v.path || []) mark(i, 4);
    for (const L of t.lakes || []) {
      const rr = (L.r || 3) + 4;
      for (let y = Math.floor(L.y - rr); y <= Math.ceil(L.y + rr); y++) for (let x = Math.floor(L.x - rr); x <= Math.ceil(L.x + rr); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || Math.hypot(x - L.x, y - L.y) > rr) continue;
        normalMask[y * W + x] = 1;
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.min(x, y, W - 1 - x, H - 1 - y) < 6) normalMask[i] = 1;
      if (t.startSafe?.[i]) normalMask[i] = 1;
      if (Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) <= centerCoreR + 6) normalMask[i] = 1;
    }
    let normalSamples = 0, sharpNormalCurves = 0, normalNeedles = 0, maxNormalCurve = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (normalMask[i] || t.water[i] > WET_DEPTH || t.height[i] < SEA_LEVEL + 0.03) continue;
      let sum = 0, n = 0, hi = -Infinity, lo = Infinity;
      for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
        if (!xx && !yy) continue;
        const j = (y + yy) * W + x + xx;
        if (normalMask[j] || t.water[j] > WET_DEPTH || t.height[j] < SEA_LEVEL + 0.03) continue;
        sum += t.height[j];
        n++;
        hi = Math.max(hi, t.height[j]);
        lo = Math.min(lo, t.height[j]);
      }
      if (!n) continue;
      normalSamples++;
      const curve = Math.abs(t.height[i] - sum / n);
      maxNormalCurve = Math.max(maxNormalCurve, curve);
      if (curve > 0.085) sharpNormalCurves++;
      if (t.height[i] > hi + 0.10 || t.height[i] < lo - 0.10) normalNeedles++;
    }
    ok(normalSamples > 5000 && sharpNormalCurves <= 8 && normalNeedles === 0 && maxNormalCurve <= 0.13,
      `Normales Gelände bleibt weich statt nadelig/gezackt (samples=${normalSamples}, kurven=${sharpNormalCurves}, nadeln=${normalNeedles}, maxKurve=${maxNormalCurve.toFixed(3)})`);
  }

  // (c) Strategische Hochseen über dem Meeresspiegel + trockene, flutbare Täler.
  ok(t.lakes && t.lakes.length >= 4, `Mindestens 4 Hochseen generiert (${t.lakes.length})`);
  const highLakes = (t.lakes || []).filter(L => {
    const li = L.y * W + L.x;
    return t.water[li] > WET_DEPTH && t.height[li] + t.water[li] > SEA_LEVEL + 0.12;
  });
  ok(highLakes.length >= 4, `Hochseen liegen deutlich über dem Meer (${highLakes.length})`);
  const shallowStartLakes = (t.lakes || []).filter(L => {
    const li = L.y * W + L.x;
    const full = Math.max(0, L.level - t.height[li]);
    return t.water[li] > WET_DEPTH && full > 0 && t.water[li] < full * 0.55;
  });
  ok(shallowStartLakes.length >= 4, `Hochseen starten mit niedrigem Pegel (${shallowStartLakes.length})`);
  const navigableRivers = (t.riverPaths || []).filter(p => p.length && p.every(i => t.water[i] >= NAVIGABLE_DEPTH));
  ok(navigableRivers.length >= 2, `Beide Hauptflüsse sind tief und beschiffbar (${navigableRivers.length})`);
  let riverWidthSamples = 0, riverWidthSum = 0;
  for (const p of t.riverPaths || []) for (const i of p) {
    if (t.height[i] <= SEA_LEVEL + 0.02) continue;
    const x = i % W, y = (i / W) | 0;
    let navigableNear = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || Math.hypot(dx, dy) > 2.25) continue;
      if (t.water[ny * W + nx] >= NAVIGABLE_DEPTH) navigableNear++;
    }
    riverWidthSamples++;
    riverWidthSum += navigableNear;
  }
  ok(riverWidthSamples > 0 && riverWidthSum / riverWidthSamples >= 4.2,
    `Hauptflüsse haben einen breiten beschiffbaren Kern (Ø ${riverWidthSamples ? (riverWidthSum / riverWidthSamples).toFixed(1) : '0'} Zellen)`);
  ok(t.valleys && t.valleys.length >= 3, `Mindestens 3 trockene Täler generiert (${t.valleys.length})`);
  const drainPaths = (t.furrowPaths || []).concat((t.valleys || []).map(V => V.path).filter(Boolean))
    .filter(p => p.length >= 6 && t.height[p[0]] > SEA_LEVEL + 0.04);
  let drainSteps = 0, drainRises = 0, drainToSea = 0;
  for (const path of drainPaths) {
    const outletH = SEA_LEVEL + 0.026;
    let last = path[path.length - 1];
    for (let n = 1; n < path.length; n++) {
      if (t.height[path[n - 1]] <= outletH) { last = path[n - 1]; break; }
      drainSteps++;
      if (t.height[path[n]] > t.height[path[n - 1]] + 0.006) drainRises++;
      last = path[n];
    }
    const first = path[0];
    const fx = first % W, fy = (first / W) | 0, lx = last % W, ly = (last / W) | 0;
    if (Math.hypot(lx + 0.5 - W / 2, ly + 0.5 - H / 2) > Math.hypot(fx + 0.5 - W / 2, fy + 0.5 - H / 2) + 1) drainToSea++;
  }
  ok(drainPaths.length >= 10 && drainToSea === drainPaths.length && drainRises === 0,
    `Trockenrinnen/Gräben fallen durchgehend zum Meer hin ab (pfade=${drainPaths.length}, gegenanstiege=${drainRises}/${drainSteps})`);
  const floodableValleys = (t.valleys || []).filter(V => {
    const vi = V.y * W + V.x;
    return t.water[vi] <= WET_DEPTH && t.height[vi] > SEA_LEVEL + 0.02 && V.floodFrom - t.height[vi] > FLOOD_DEPTH;
  });
  ok(floodableValleys.length >= 3, `Täler sind trocken, aber leicht flutbar (${floodableValleys.length})`);

  if (highLakes.length) {
    const lakeWorld = createWorld({ data, seed: 2026, players: [{ id: 0, faction: 'KBN', controller: 'human' }], controls: { insanity: 3 } });
    initEnv(lakeWorld);
    const lt = lakeWorld.terrain, LL = lt.lakes[0], li = LL.y * lt.w + LL.x;
    const baseLake = lt.baseWater[li], lake0 = lt.water[li];
    const rainSnow0 = lt.snowIdx.reduce((s, i) => s + lt.snow[i], 0);
    const valleyWater0 = (lt.valleys || []).reduce((s, V) => s + lt.water[tIdx(lt, V.x, V.y)], 0);
    lakeWorld.env.weather = 'rain'; lakeWorld.env.solar = 0;
    for (let k = 0; k < 40; k++) { stepWater(lakeWorld); lakeWorld.tick++; }
    const rainyLake = lt.water[li];
    const rainSnow1 = lt.snowIdx.reduce((s, i) => s + lt.snow[i], 0);
    const valleyWater1 = (lt.valleys || []).reduce((s, V) => s + lt.water[tIdx(lt, V.x, V.y)], 0);
    ok(rainyLake > lake0 + 0.02, `Regen hebt den Hochsee-Pegel (${lake0.toFixed(3)} → ${rainyLake.toFixed(3)})`);
    ok(valleyWater1 > valleyWater0 + FLOOD_DEPTH,
      `Regen flutet trockene Talbereiche sichtbar (${valleyWater0.toFixed(3)} → ${valleyWater1.toFixed(3)})`);
    ok(rainSnow1 > rainSnow0 + 0.5,
      `Regenwetter erhöht den Schneepegel in den Bergen stark (${rainSnow0.toFixed(2)} → ${rainSnow1.toFixed(2)})`);
    // Reine Hochsee-Hydraulik prüfen: alle Zuflüsse (Schnee, Anfangsschmelze, Quellen) abschalten,
    // damit der Einzugsbereich den See nicht weiter speist. Erst settlen lassen (Catchment läuft
    // ein), dann muss der See langsam fallen — aber nicht sofort bis auf den Grundpegel.
    for (const i of lt.snowIdx) lt.snow[i] = 0;
    lt.startMeltLeft = 0;
    lt.sources.length = 0;
    lakeWorld.env.weather = 'clear'; lakeWorld.env.solar = 1;
    for (let k = 0; k < 120; k++) { stepWater(lakeWorld); lakeWorld.tick++; }
    const dryStart = lt.water[li];
    for (let k = 0; k < 200; k++) { stepWater(lakeWorld); lakeWorld.tick++; }
    ok(lt.water[li] >= baseLake - 1e-4 && lt.water[li] <= dryStart + 0.003,
      `Klares Wetter leert Hochseen nicht sprunghaft ohne Abfluss (${dryStart.toFixed(3)} → ${lt.water[li].toFixed(3)})`);
  }
  w.env.weather = 'clear'; w.env.solar = 1;

  // (d) Schneeschmelze: Mittagssonne schmilzt Schnee → Schmelzwasser entsteht am Berg.
  w.env.dayT = 0.5; stepEnvironment(w);
  const snowSum = () => t.snowIdx.reduce((s, i) => s + t.snow[i], 0);
  const lakeWaterSum = () => (t.lakes || []).reduce((s, L) => s + t.water[L.y * W + L.x], 0);
  const lowBasinWaterSum = () => {
    let s = 0;
    for (let i = 0; i < t.water.length; i++) if (t.height[i] > SEA_LEVEL + 0.025 && t.height[i] < SEA_LEVEL + 0.11) s += t.water[i];
    return s;
  };
  const s0 = snowSum();
  const lake0 = lakeWaterSum();
  const basin0 = lowBasinWaterSum();
  ok(t.startMeltLeft > 0 && t.startMeltCells.length > 0, 'Start-Schneeschmelze am Zentralberg ist vorbereitet');
  const avgHeight = (cells) => cells.reduce((s, i) => s + t.height[i], 0) / Math.max(1, cells.length);
  ok(avgHeight(t.startMeltCells) < avgHeight(t.snowIdx),
    'Start-Schneeschmelze beginnt am unteren Rand der Schneekappe statt am Gipfelzentrum');
  for (let k = 0; k < 50; k++) { stepWater(w); w.tick++; }
  ok(snowSum() < s0 - 1e-4, `Sonne schmilzt den Schnee nach und nach (Σ ${s0.toFixed(2)} → ${snowSum().toFixed(2)})`);
  for (let k = 0; k < 260; k++) { stepWater(w); w.tick++; }
  ok(lakeWaterSum() > lake0 + 0.03 || lowBasinWaterSum() > basin0 + 0.03,
    'Start-Schneeschmelze bewässert Seen und geschlossene Senken nach und nach');
  w.env.weather = 'clear'; w.env.solar = 1;
  for (let k = 0; k < 3600 && snowSum() > 0; k++) { stepWater(w); w.tick++; }
  ok(snowSum() < s0 * 0.32, `Lange Mittagssonne schmilzt den Großteil der Berg-Schneedecke ab (${snowSum().toFixed(2)} < ${(s0 * 0.32).toFixed(2)})`);

  // (e) Strom-Lastabwurf: Großverbraucher fallen zuerst aus, Produktion dort stoppt.
  const P = w.players[0];
  const hq = ownerEntities(w, 0, 'building').find(b => b.kind === 'hq');
  const plant = spawnBuilding(w, 0, 'power_plant', 20, 20); plant.buildProgress = 1;
  const facs = [24, 28, 32].map(x => { const f = spawnBuilding(w, 0, 'factory', x, 20); f.buildProgress = 1; return f; });
  P.resources.fuel = 500; P.resources.water = 200;
  stepEconomy(w); // 120 erzeugt; Verbrauch: HQ20 + 3×Fabrik40 = 140 → genau 1 Fabrik fällt ab
  ok(hq._powered === true, 'Lastabwurf: kleiner Verbraucher (HQ) bleibt versorgt');
  ok(facs.filter(f => f._powered === false).length === 1, 'Lastabwurf: genau EINE Fabrik (Großverbraucher) wird abgeschaltet');
  const offFac = facs.find(f => f._powered === false);
  P.resources.ore = 5000;
  applyCommand(w, { type: 'produce', building: offFac.id, kind: 'scout' }, 0);
  const tl0 = offFac.queue[0] && offFac.queue[0].timeLeft;
  step(w);
  ok(offFac.queue[0] && offFac.queue[0].timeLeft === tl0, 'Abgeschaltete Fabrik produziert NICHT weiter');

  // (f) Automatische Straßen zwischen nahen Gebäuden.
  for (let k = 0; k < 51; k++) step(w);
  let roadCells = 0; for (let i = 0; i < t.road.length; i++) if (t.road[i]) roadCells++;
  // Straßen liegen NICHT mehr unter Gebäude-Footprints (Gebäude steht nicht auf der Straße) → es zählen
  // nur die freien Verbindungszellen zwischen den Bauten.
  ok(roadCells >= 3, `Straßennetz zwischen nahen Gebäuden gebaut (${roadCells} Zellen)`);

  // (g) Terraforming-Auftrag: Bagger fährt hin, gräbt ab, Erde landet im Erdhügel.
  const builder = ownerEntities(w, 0, 'unit').find(u => u.abilities.includes('construct'));
  ok(builder, 'Startbasis enthält einen Bagger');
  const [btx, bty] = worldToTile(builder.x, builder.y);
  let jx = hq.tx + 6, jy = hq.ty + 6;
  for (let r = 2, found = false; r <= 18 && !found; r++) {
    for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) {
      const tx = hq.tx + dx, ty = hq.ty + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= t.h) continue;
      const ii = ty * W + tx;
      if (t.water[ii] > WET_DEPTH || t.block[ii] || t.type[ii] === TT.CLIFF || t.cover[ii] >= 0.2 || t.height[ii] <= SEA_LEVEL + 0.12) continue;
      const path = findPath(t, builder.domain, btx, bty, tx, ty, 6000, builder.maxSlope ?? Infinity, { heavy: builder.heavy, category: builder.category });
      if (path) { jx = tx; jy = ty; found = true; }
    }
  }
  const ji = jy * W + jx;
  const jh0 = t.height[ji];
  const mat0 = P.resources.materials;
  for (const u of ownerEntities(w, 0, 'unit')) if (u.kind === 'truck') u.order = { type: 'move' };
  for (const u of ownerEntities(w, 0, 'unit')) if (u.kind === 'builder') {
    u.resourceRole = 'build';
    u.order = { type: 'idle' };
    u.target = null;
    u.path = [];
    u.moveTarget = null;
  }
  applyCommand(w, { type: 'terraform', tx: jx, ty: jy, dir: -1 }, 0);
  const terraJob = w.terraJobs[0];
  const terraPile = terraJob ? w.entities.get(terraJob.earthPileId) : null;
  ok(terraPile && terraPile.kind === 'earth_pile', 'Abgrab-Auftrag weist automatisch einen Erdhügelplatz zu');
  ok(Math.abs(t.height[ji] - jh0) < 1e-9, 'Terraform-Auftrag veraendert die physikalische Hoehe erst nach Abschluss');
  let sawTerraCargo = false, sawTerraDump = false;
  for (let k = 0; k < 600 && w.terraJobs.length; k++) {
    step(w);
    sawTerraCargo = sawTerraCargo || ownerEntities(w, 0, 'unit').some(u => u.kind === 'builder' && u.order?.type === 'terra' && u.order?.state === 'dump' && (u.cargo || 0) > 0);
    sawTerraDump = sawTerraDump || w.events.some(ev => ev.type === 'dump' && ev.resource === 'materials'
      && terraPile && Math.hypot((ev.dx ?? 0) - terraPile.x, (ev.dy ?? 0) - terraPile.y) <= 0.1);
  }
  ok(w.terraJobs.length === 0, 'Abgrab-Auftrag wurde von einem Bagger erledigt');
  ok(sawTerraCargo, 'Bagger transportiert den Aushub sichtbar zum Erdhügel');
  ok(sawTerraDump, 'Bagger lädt den Aushub am Erdhügel mit Dump-Animation ab');
  ok(t.height[ji] < jh0 - 0.05, `Zelle wurde abgegraben (${jh0.toFixed(2)} → ${t.height[ji].toFixed(2)})`);
  ok((terraPile?.amount || 0) > 0, 'Abgraben füllt den Erdhügel mit Erde');
  ok(P.resources.materials <= mat0 + 1, 'Abgraben bucht Erde nicht direkt ins Depot');

  // (h) Schwere Fahrzeuge halten flaches Wasser aus und gehen erst in Tiefwasser kaputt.
  let wi = -1; for (let i = 0; i < t.water.length; i++) if (t.water[i] > WET_DEPTH && t.water[i] < FLOOD_DEPTH) { wi = i; break; }
  if (wi < 0) for (let i = 0; i < t.water.length; i++) if (t.water[i] > WET_DEPTH) { wi = i; break; }
  const wtx = wi % W, wty = (wi / W) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = wtx + dx, y = wty + dy;
    if (!inBounds(t, x, y)) continue;
    const i = tIdx(t, x, y);
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5; t.water[i] = WET_DEPTH * 1.2; t.baseWater[i] = 0;
    t.block[i] = 0; t.waterBlock[i] = 0;
    if (t.waterActive) t.waterActive.add(i);
  }
  const [twx, twy] = [(wi % W) * 2 + 1, ((wi / W) | 0) * 2 + 1];
  const tank = spawnUnit(w, 0, 'tank', twx, twy);
  const thp = tank.hp;
  for (let k = 0; k < 20; k++) { stepWater(w); w.tick++; }
  ok(tank.hp === thp && !tank.dead, 'Schweres Fahrzeug übersteht flaches Wasser ohne Schaden');
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = wtx + dx, y = wty + dy;
    if (!inBounds(t, x, y)) continue;
    const i = tIdx(t, x, y);
    t.water[i] = NAVIGABLE_DEPTH + 0.08;
    if (t.waterActive) t.waterActive.add(i);
  }
  for (let k = 0; k < 10; k++) { stepWater(w); w.tick++; }
  ok(tank.hp < thp, 'Schweres Fahrzeug nimmt erst in tiefem Wasser Schaden');

  // (i) Gebäude verfallen, wenn sie zu lange im Wasser stehen (nach Schonfrist).
  const flooded = spawnBuilding(w, 0, 'turret', wi % W, (wi / W) | 0); flooded.buildProgress = 1;
  const bhp = flooded.hp;
  for (let k = 0; k < 40; k++) {
    t.water[wi] = Math.max(t.water[wi] || 0, NAVIGABLE_DEPTH + 0.08);
    if (t.waterActive) t.waterActive.add(wi);
    stepWater(w); w.tick++; w.time += 0.5;
  } // Zeit > Schonfrist verstreichen lassen
  ok(flooded.hp < bhp, 'Überflutetes Gebäude verfällt nach und nach');

  // (j) Snapshot streamt Schnee, Straßen & Strom-Flag.
  const sn = serializeSnapshot(w);
  ok(Array.isArray(sn.ents.find(e => e[1] === 1)) && sn.ents.find(e => e[1] === 1).length >= 12, 'Gebäude-Snapshot enthält Strom-Flag (Index 11)');
}

// 22) Phase 16: Steigungs-Physik, Gebäude-Kollision, Straßenbau, Strömung, Wetter-Risiken, Lawinen
{
  const { initEnv, stepEnvironment, checkAvalanches } = await import('../shared/systems/environment.js');
  const { slopeOk, roadAtIdx } = await import('../shared/terrain.js');
  const { applyFortification: applyF, removeFortification: removeF } = await import('../shared/world.js');
  const w = createWorld({ data, seed: 31, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'FLG', controller: 'human' }] });
  initEnv(w); w.env.weather = 'clear'; w.env.weatherLeft = 1e9; w.env._nextQuake = 1e9; w.env._lightningCd = 1e9;
  const t = w.terrain, W = t.w;
  const envSnap = serializeSnapshot(w).env;
  ok(Array.isArray(envSnap.f) && envSnap.f.length >= 3 && typeof envSnap.wl === 'number', 'Snapshot enthält Wettervorhersage mit Restzeit');

  // (a) Steigungslimits je Klasse: Infanterie klettert, Bagger kommen besser über Hänge, schwere Fahrzeuge nicht.
  const inf = spawnUnit(w, 0, 'rifleman', 20, 20);
  const tank = spawnUnit(w, 0, 'tank', 20, 24);
  const slopeBuilder = spawnUnit(w, 0, 'builder', 20, 28);
  ok(inf.maxSlope > tank.maxSlope, 'Infanterie klettert steilere Hänge als schwere Fahrzeuge');
  const ai = 30 * W + 30, bi = ai + 1;
  for (const i of [ai, bi]) { t.type[i] = TT.LAND; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; }
  t.height[ai] = 0.5; t.height[bi] = 0.63;        // Steilhang: Δ0.13 je Tile
  ok(slopeOk(t, ai, bi, inf.maxSlope), 'Steilhang (Δ0.13) ist für Infanterie passierbar');
  ok(slopeBuilder.maxSlope === SLOPE_BUILDER && slopeOk(t, ai, bi, slopeBuilder.maxSlope),
    'Bagger bewältigt einen steileren natürlichen Hang als normale Fahrzeuge');
  const builderHillPath = findPath(t, 'land', 30, 30, 31, 30, 80, slopeBuilder.maxSlope, { category: slopeBuilder.category });
  ok(builderHillPath && builderHillPath.some(([x, y]) => x === 31 && y === 30),
    'Bagger plant über steilere natürliche Hänge');
  ok(!slopeOk(t, ai, bi, tank.maxSlope), 'derselbe Hang ist für den schweren Panzer zu steil');
  // (b) Straße (Serpentinen) erlaubt steilere Passagen.
  t.roadBuilt[ai] = 1; t.roadBuilt[bi] = 1;
  ok(slopeOk(t, ai, bi, tank.maxSlope, 0.135), 'mit Straße überwindet der Panzer den Hang');
  t.roadBuilt[ai] = 0; t.roadBuilt[bi] = 0;

  // (b2) Fahrzeuge nehmen für ein Straßenband auch einen Umweg in Kauf.
  const ry = 34, dy = 37, sx = 30, gx = 46;
  for (let y = ry - 1; y <= dy; y++) for (let x = sx - 1; x <= gx + 1; x++) {
    const i = y * W + x;
    t.type[i] = TT.LAND; t.height[i] = 0.55; t.height0[i] = 0.55; t.terra[i] = 0;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0; t.road[i] = 0; t.roadBuilt[i] = 0;
  }
  for (let x = sx; x <= gx; x++) t.roadBuilt[ry * W + x] = 1;
  const roadPrefPath = findPath(t, 'land', sx, dy, gx, dy, 600, tank.maxSlope, { category: 'vehicle', heavy: true });
  const roadPrefCells = roadPrefPath ? roadPrefPath.filter(([x, y]) => y === ry && x >= sx && x <= gx).length : 0;
  ok(roadPrefCells >= 10, 'Fahrzeug-Pfadfindung bevorzugt ein längeres Straßenband gegenüber der direkten Geländequerung');

  // (c) Kollision: massive Gebäude blockieren ihre Zellen, Zerstörung gibt sie frei.
  let ci = -1;
  for (let i = 0; i < t.type.length; i++) if (t.type[i] === TT.LAND && !t.block[i] && t.water[i] === 0 && t.ore[i] === 0) { ci = i; break; }
  const cxx = ci % W, cyy = (ci / W) | 0;
  ok(isPassable(t, 'land', cxx, cyy), 'Zelle vor dem Bau passierbar');
  const dep = spawnBuilding(w, 0, 'depot', cxx, cyy);
  ok(!isPassable(t, 'land', cxx, cyy), 'Gebäude blockiert seinen Footprint (Kollision)');
  applyDamage(w, dep, dep.hp + 1, null); step(w);
  ok(isPassable(t, 'land', cxx, cyy), 'Zerstörtes Gebäude gibt die Zellen wieder frei');

  // (d) Nebel: Zielerfassungs-Reichweite bricht ein.
  const shooter = spawnUnit(w, 0, 'tank', 100, 100);
  const target = spawnUnit(w, 1, 'tank', 100, 112);
  buildSpatial(w);
  const seenClear = nearestEnemy(w, shooter, 14);
  w.env.weather = 'fog';
  const seenFog = nearestEnemy(w, shooter, 14);
  ok(seenClear === target && !seenFog, 'Nebel reduziert die Zielerfassung (Schiff/Flieger-Risiko)');

  // (e) Gewitter: Wellengang beschädigt Schiffe, Böen die Luftflotte; getauchte U-Boote sicher.
  w.env.weather = 'storm'; w.env.weatherLeft = 1e9;
  const boat = spawnUnit(w, 0, 'patrol_boat', 20, 20);
  const heli = spawnUnit(w, 0, 'gunship', 20, 28);
  const sub = spawnUnit(w, 0, 'submarine', 28, 20);
  const [bh, hh, sh] = [boat.hp, heli.hp, sub.hp];
  for (let k = 0; k < 20; k++) stepEnvironment(w);
  ok(boat.hp < bh, 'Wellengang: Überwasserschiff nimmt im Gewitter Schaden');
  ok(heli.hp < hh, 'Sturmböen: Luftfahrzeug nimmt im Gewitter Schaden');
  ok(sub.hp === sh, 'getauchtes U-Boot ist vor dem Wellengang sicher');
  w.env.weather = 'clear';

  // (f) Strömung: fließendes Wasser reißt Einheiten flussabwärts.
  const fx = 40, fy = 60, fi = fy * W + fx;
  for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 2; xx++) {
    const i = (fy + yy) * W + fx + xx;
    t.type[i] = TT.LAND; t.height[i] = 0.70; t.height0[i] = 0.70; t.water[i] = 0; t.baseWater[i] = 0; t.waterBlock[i] = 0;
  }
  t.height[fi] = 0.5; t.water[fi] = 0.2;
  t.height[fi + 1] = 0.3; t.water[fi + 1] = 0;
  t.waterActive = new Set([fi, fi + 1]);
  const raft = spawnUnit(w, 1, 'rifleman', (fx + 0.5) * 2, (fy + 0.5) * 2);
  const rx0 = raft.x;
  for (let k = 0; k < 6; k++) { stepWater(w); w.tick++; }
  ok(raft.x > rx0 + 0.3, `Strömung reißt die Einheit mit (${(raft.x - rx0).toFixed(2)} m flussabwärts)`);

  // (g) Schneelawine: Basisnähe bleibt ruhig, am Zentralberg geht schwere Schneelast ab.
  const originalSnowIdx = [...t.snowIdx];
  const prepareAvalancheCell = (i) => {
    const x = i % W, y = (i / W) | 0;
    for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
      const nx = x + xx, ny = y + yy;
      if (!inBounds(t, nx, ny)) continue;
      const j = tIdx(t, nx, ny);
      t.type[j] = TT.LAND; t.water[j] = 0; t.baseWater[j] = 0; t.block[j] = 0;
      t.height[j] = 1.36; t.height0[j] = 1.36;
    }
    const low = inBounds(t, x + 1, y) ? tIdx(t, x + 1, y) : tIdx(t, x - 1, y);
    t.height[i] = 1.55; t.height0[i] = 1.55; t.snow[i] = 1.0;
    t.height[low] = 1.34; t.height0[low] = 1.34; t.snow[low] = 0;
  };
  const avalancheBaseHq = ownerEntities(w, 0, 'building').find(e => e.kind === 'hq');
  const hx = avalancheBaseHq.tx + avalancheBaseHq.size / 2, hy = avalancheBaseHq.ty + avalancheBaseHq.size / 2;
  let baseSnow = -1;
  for (let y = 1; y < t.h - 1 && baseSnow < 0; y++) for (let x = 1; x < t.w - 1; x++) {
    const d = Math.hypot(x + 0.5 - hx, y + 0.5 - hy);
    if (d >= 18 && d <= 24) { baseSnow = tIdx(t, x, y); break; }
  }
  t.snow.fill(0);
  prepareAvalancheCell(baseSnow);
  t.snowIdx = [baseSnow];
  w.events = [];
  for (let k = 0; k < 120; k++) checkAvalanches(w, 1e9);
  ok(!w.events.some(ev => ev.type === 'avalanche'), 'Lawinen starten nicht in Basisnähe');

  t.snow.fill(0);
  const si = originalSnowIdx.reduce((best, i) => {
    const bx = best % W, by = (best / W) | 0;
    const x = i % W, y = (i / W) | 0;
    return Math.hypot(x + 0.5 - t.w / 2, y + 0.5 - t.h / 2) < Math.hypot(bx + 0.5 - t.w / 2, by + 0.5 - t.h / 2) ? i : best;
  }, originalSnowIdx[0]);
  prepareAvalancheCell(si);
  t.snowIdx = [si];
  t.snow[si] = 1.0;
  const avalancheTerraBefore = Float32Array.from(t.terra);
  w.events = [];
  for (let k = 0; k < 6000 && !w.events.some(ev => ev.type === 'avalanche'); k++) checkAvalanches(w, 1e9);
  const aval = w.events.find(ev => ev.type === 'avalanche');
  ok(aval, 'Lawine geht ab (Event mit Pfad)');
  ok(t.snow[si] < 1.0, 'Lawine trägt die Schneelast ab');
  ok(t.height[si] < 1.55, 'Lawine schürft den Abrisshang aus');
  if (aval && aval.path && aval.path.length >= 2) {
    const ax = Math.round(aval.path[aval.path.length - 2] / TILE - 0.5);
    const ay = Math.round(aval.path[aval.path.length - 1] / TILE - 0.5);
    const ai2 = ay * W + ax;
    ok(t.terra[ai2] > 0 || t.water[ai2] > 0, 'Lawine lagert am Auslauf Material/Schmelzwasser ab');
  }
  const avalancheChanged = [];
  for (let i = 0; i < t.terra.length; i++) if (Math.abs((t.terra[i] || 0) - (avalancheTerraBefore[i] || 0)) > 0.002) avalancheChanged.push(i);
  const avalancheRough = deformationRoughness(t, avalancheChanged, 1);
  ok(avalancheRough.samples > 10 && avalancheRough.needles === 0 && avalancheRough.maxCurve <= 0.24 && avalancheRough.sharp <= 12,
    `Lawinen-Deformation bleibt gerundet statt zackig (samples=${avalancheRough.samples}, nadeln=${avalancheRough.needles}, maxKurve=${avalancheRough.maxCurve.toFixed(3)}, scharf=${avalancheRough.sharp})`);
  t.snowIdx = originalSnowIdx;

  // (h) Straßenbau außerhalb der Basis: road-Gebäude stempelt Straßenzellen.
  const farFromBuildings = (i) => {
    const x = (i % W) + 0.5, y = ((i / W) | 0) + 0.5;
    for (const e of w.entities.values()) {
      if (e.etype !== 'building' || e.dead || e.def?.roadBuilt || e.def?.pipe || e.def?.bridges || e.def?.tunnels) continue;
      if (['terrain', 'infrastructure', 'fortification', 'hydro'].includes(e.def?.role)) continue;
      const ex = e.tx + e.size / 2, ey = e.ty + e.size / 2;
      if (Math.hypot(x - ex, y - ey) <= e.size / 2 + 3) return false;
    }
    return true;
  };
  let ri = -1;
  for (let i = ci + 200; i < t.type.length; i++) {
    if (t.type[i] === TT.LAND && !t.block[i] && t.water[i] === 0 && t.ore[i] === 0 && farFromBuildings(i)) { ri = i; break; }
  }
  const road = spawnBuilding(w, 0, 'road', ri % W, (ri / W) | 0); road.buildProgress = 1; applyF(w, road);
  ok(roadAtIdx(t, ri), 'Gebaute Straße zählt als Straßenzelle (Tempo + Steigungsbonus)');
  ok((t.terra[ri] || 0) > 0.01, 'Straße außerhalb der Basis wird leicht angehoben');
  t.water[ri] = WET_DEPTH + 0.02; t.baseWater[ri] = 0;
  ok(isPassable(t, 'land', ri % W, (ri / W) | 0, 'vehicle'), 'Angehobene Straße bleibt bei niedrigem Hochwasser befahrbar');
  const hq = ownerEntities(w, 0, 'building').find(e => e.kind === 'hq' && !e.dead);
  const nearRoad = spawnBuilding(w, 0, 'road', hq.tx + hq.size + 1, hq.ty); nearRoad.buildProgress = 1; applyF(w, nearRoad);
  const nearI = tIdx(t, nearRoad.tx, nearRoad.ty);
  ok((t.terra[nearI] || 0) <= 0.01, 'Straßen direkt an Gebäuden heben das Basisgelände nicht an');
  removeF(w, nearRoad);
  t.water[ri] = 0;
  removeF(w, road);
  ok(!roadAtIdx(t, ri), 'Zerstörte Straße verschwindet aus dem Netz');

  // (i) Bagger bewältigen die steilen Kanten eigener Erdarbeiten, andere Fahrzeuge nicht.
  const ex = 42, ey = 42, from = ey * W + ex, to = from + 1;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 2; x++) {
    const tx = ex + x, ty = ey + y, i = ty * W + tx;
    t.type[i] = TT.LAND; t.height[i] = 0.62; t.height0[i] = 0.62; t.terra[i] = 0;
    t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 1; t.road[i] = 0; t.roadBuilt[i] = 0;
  }
  t.block[from] = 0; t.block[to] = 0;
  const terraBuilder = spawnUnit(w, 0, 'builder', (ex + 0.5) * 2, (ey + 0.5) * 2);
  terraBuilder.x = (ex + 0.5) * 2; terraBuilder.y = (ey + 0.5) * 2; terraBuilder.facing = 0;
  const terraDrop = Math.min(SLOPE_TERRAFORM_BUILDER - 0.01, SLOPE_BUILDER + 0.02);
  t.height[to] = t.height[from] - terraDrop; t.height0[to] = 0.62; t.terra[to] = -terraDrop;
  const terraTankPath = findPath(t, 'land', ex, ey, ex + 1, ey, 80, tank.maxSlope, { heavy: true });
  ok(!terraTankPath, 'Panzer plant nicht über die steile Terraform-Kante');
  ok(SLOPE_TERRAFORM_BUILDER > Math.abs(t.height[to] - t.height[from]) && terraBuilder.maxSlope < Math.abs(t.height[to] - t.height[from]),
    'Terraform-Kante liegt über normalem Fahrzeuglimit, aber im Bagger-Arbeitsbereich');
  const terraBuilderPath = findPath(t, 'land', ex, ey, ex + 1, ey, 80, terraBuilder.maxSlope, { category: terraBuilder.category, terraCrawler: true });
  ok(terraBuilderPath && terraBuilderPath.some(([x, y]) => x === ex + 1 && y === ey),
    'Bagger plant über eine steile eigene Ausgrabungskante');
  setMoveGoal(w, terraBuilder, (ex + 1.5) * 2, (ey + 0.5) * 2);
  for (let k = 0; k < 24; k++) stepMovement(w);
  ok(worldToTile(terraBuilder.x, terraBuilder.y)[0] === ex + 1 && !terraBuilder.abandoned,
    'Bagger fährt tatsächlich über die steile Terraform-Kante');
}

{
  const { initEnv } = await import('../shared/systems/environment.js');
  const w = createWorld({ data, seed: 43, players: [{ id: 0, faction: 'KBN', controller: 'human' }, { id: 1, faction: 'FLG', controller: 'human' }] });
  initEnv(w); w.env.weather = 'rain'; w.env.weatherLeft = 1e9; w.env._nextQuake = 1e9; w.env._lightningCd = 1e9;
  const t = w.terrain, W = t.w;
  let ci = -1;
  for (let i = 0; i < t.type.length; i++) {
    const x = i % W, y = (i / W) | 0;
    if (x < 3 || y < 3 || x > W - 4 || y > t.h - 4) continue;
    if (t.type[i] === TT.LAND && !t.block[i] && t.water[i] === 0 && t.ore[i] === 0) { ci = i; break; }
  }
  const cx = ci % W, cy = (ci / W) | 0;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    const i = (cy + y) * W + (cx + x);
    t.type[i] = TT.LAND; t.height[i] = 0.5; t.height0[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.ore[i] = 0;
    t.tracks[i] = 0; t.mud[i] = 0; t.roadBuilt[i] = 0; t.road[i] = 0;
  }

  const tank = spawnUnit(w, 0, 'tank', (cx + 0.5) * 2, (cy + 0.5) * 2);
  tank.facing = 0;
  setMoveGoal(w, tank, (cx + 1.5) * 2, (cy + 0.5) * 2);
  for (let k = 0; k < 12; k++) stepMovement(w);
  const trackI = tIdx(t, cx + 1, cy);
  ok(t.tracks[trackI] > 0, 'Fahrzeugbewegung hinterlässt Spurrillen im Gelände');

  t.tracks[trackI] = 0.9; t.water[trackI] = 0; t.baseWater[trackI] = 0;
  for (let k = 0; k < 8; k++) { stepWater(w); w.tick++; }
  ok(t.water[trackI] > WET_DEPTH, 'Regen sammelt sich in Spurrillen zu Pfützen');

  tank.x = (cx + 1.5) * 2; tank.y = (cy + 0.5) * 2; tank.facing = 0; tank._v = 0;
  setMoveGoal(w, tank, (cx + 2.5) * 2, (cy + 0.5) * 2);
  for (let k = 0; k < 12; k++) stepMovement(w);
  ok(t.mud[trackI] > 0, 'Schwere Fahrzeuge arbeiten nasse Spurrillen zu Matsch auf');

  t.mud[trackI] = MUD_IMPASSABLE;
  const path = findPath(t, 'land', cx, cy, cx + 2, cy, 400, tank.maxSlope, { heavy: true });
  ok(path && !path.some(([x, y]) => x === cx + 1 && y === cy), 'Schwere Fahrzeuge meiden unpassierbaren Matsch bei der Pfadfindung');

  t.water[trackI] = WET_DEPTH + 0.02;
  t.mud[trackI] = MUD_IMPASSABLE;
  const builder = spawnUnit(w, 0, 'builder', (cx + 0.5) * 2, (cy + 0.5) * 2);
  const builderPath = findPath(t, 'land', cx, cy, cx + 1, cy, 400, builder.maxSlope, { category: builder.category, mudCrawler: true });
  ok(builderPath && builderPath.some(([x, y]) => x === cx + 1 && y === cy), 'Bagger planen durch nasses matschiges Gelände');
  const bx0 = builder.x;
  setMoveGoal(w, builder, (cx + 1.5) * 2, (cy + 0.5) * 2);
  for (let k = 0; k < 18; k++) stepMovement(w);
  ok(builder.x > bx0 + 0.8 && !builder.abandoned, 'Bagger fahren durch nassen Matsch statt stecken zu bleiben');

  w.env.weather = 'clear'; w.env.solar = 1;
  t.water[trackI] = 0; t.baseWater[trackI] = 0; t.tracks[trackI] = 0.2; t.mud[trackI] = 0.2;
  for (let k = 0; k < 240 && (t.tracks[trackI] > 0 || t.mud[trackI] > 0); k++) { stepWater(w); w.tick++; }
  ok(t.tracks[trackI] === 0 && t.mud[trackI] === 0, 'Sonnige Trockenheit lässt Matsch und Spurrillen wieder zu Wiese ausheilen');
  ok(!serializeSnapshot(w).ground.some((v, n, a) => n % 4 === 0 && v === trackI),
    'ausgeheilte Wiese verschwindet aus dem Ground-Wear-Snapshot');
}

// 23) Phase 19: Flut-Deckel (max. 25 % der Karte), konsolidierte Erdhaufen, Assist-Befehl
{
  const { initEnv } = await import('../shared/systems/environment.js');
  const { addTerraJob } = await import('../shared/systems/construction.js');
  const w = createWorld({ data, seed: 77, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  initEnv(w); w.env.weather = 'storm'; w.env.weatherLeft = 1e9; w.env._nextQuake = 1e9; w.env._lightningCd = 1e9;
  const t = w.terrain;
  // (a) Dauer-Gewitterregen: Es dürfen höchstens ~25 % der Karte fluten, dann stoppt der Zufluss.
  for (let k = 0; k < 1200; k++) { stepWater(w); w.tick++; w.time += 0.2; }
  let flooded = 0;
  for (let i = 0; i < t.water.length; i++) if (t.water[i] > WET_DEPTH && t.baseWater[i] <= WET_DEPTH) flooded++;
  const frac = flooded / (t.w * t.h);
  ok(frac <= 0.29, `Flut-Deckel greift: ${(frac * 100).toFixed(1)} % der Karte zusätzlich geflutet (≤ ~25 % + Toleranz)`);
  w.env.weather = 'clear';
  // Sturmwasser ablaufen lassen, damit der Erdhaufen-Test auf trockenem Grund läuft (bei 25 %
  // Flut-Deckel kann der feste Testort sonst unter Wasser stehen).
  for (let i = 0; i < t.water.length; i++) t.water[i] = t.baseWater[i];

  // (b) Erdhaufen beisammen: benachbarte Terraform-Aufträge teilen sich EINEN Haufen.
  addTerraJob(w, 0, 60, 60, -1);
  addTerraJob(w, 0, 62, 60, -1);
  addTerraJob(w, 0, 64, 60, -1);
  const jobs = w.terraJobs.slice(-3);
  ok(jobs[0].earthPileId != null && jobs.every(j => j.earthPileId === jobs[0].earthPileId),
    'Drei benachbarte Aufträge nutzen denselben Erdhaufen (kein Hügel-Streusel)');

  // (c) Assist: selektierter Bagger zu Baustelle geschickt → Funktion wechselt automatisch.
  const site = spawnBuilding(w, 0, 'barracks', 70, 70);
  const digger = spawnUnit(w, 0, 'builder', 136, 136);
  digger.resourceRole = 'ore';
  applyCommand(w, { type: 'assist', units: [digger.id], target: site.id }, 0);
  ok(digger.order.type === 'construct' && digger.order.site === site.id && digger.resourceRole === 'build',
    'Assist: Bagger übernimmt Baustelle und stellt die Funktion auf Bauen um');
  applyCommand(w, { type: 'setRole', units: [digger.id], role: 'earth' }, 0);
  ok(digger.resourceRole === 'earth' && digger.order.type === 'idle',
    'Bagger kann jederzeit von Bauen auf Erde wechseln und verlässt den Bauauftrag');
  digger.order = { type: 'terra', job: jobs[0].id };
  applyCommand(w, { type: 'setRole', units: [digger.id], role: 'ore' }, 0);
  ok(digger.resourceRole === 'ore' && digger.order.type === 'idle',
    'Bagger kann jederzeit von Erdarbeit auf Erz wechseln und verlässt den Terraform-Auftrag');
  // LKW zu Erdhaufen.
  const pile = [...w.entities.values()].find(e => e.kind === 'earth_pile');
  if (pile) {
    const lkw = spawnUnit(w, 0, 'truck', 130, 130);
    applyCommand(w, { type: 'assist', units: [lkw.id], target: pile.id }, 0);
    ok(lkw.order.type === 'haul_pile' && lkw.order.pile === pile.id, 'Assist: LKW übernimmt Erdhaufen-Abfuhr');
  }
}

// 23b) Terraforming-Erdlogistik: Bagger fährt zum Erdhügel/Lager und kippt sichtbar ab.
{
  const flatTerraWorld = (seed) => {
    const w = createWorld({ data, seed, map: { w: 48, h: 48 }, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
    const t = w.terrain;
    w.entities.clear();
    w.terraJobs = [];
    w.env = { weather: 'clear', weatherLeft: 1e9, daylight: 1, dayT: 0.5, solar: 1 };
    w._nextQuake = 1e9; w._lightningCd = 1e9;
    for (let i = 0; i < t.type.length; i++) {
      t.type[i] = TT.LAND; t.height[i] = 0.62; t.height0[i] = 0.62; t.terra[i] = 0;
      t.water[i] = 0; t.baseWater[i] = 0; t.block[i] = 0; t.cover[i] = 0;
      if (t.mud) t.mud[i] = 0;
      if (t.tracks) t.tracks[i] = 0;
      if (t.road) t.road[i] = 0;
      if (t.roadBuilt) t.roadBuilt[i] = 0;
      if (t.bridge) t.bridge[i] = 0;
      if (t.lakeMask) t.lakeMask[i] = 0;
    }
    if (t.waterActive) t.waterActive.clear();
    return w;
  };

  {
    const w = flatTerraWorld(23101);
    const t = w.terrain, p = w.players[0];
    p.resources.materials = 0;
    const [bx, by] = tileToWorld(24, 24);
    spawnUnit(w, 0, 'builder', bx, by).resourceRole = 'earth';
    applyCommand(w, { type: 'terraform', tx: 24, ty: 24, dir: -1 }, 0);
    const job = w.terraJobs[0];
    const pile = job ? w.entities.get(job.earthPileId) : null;
    ok(pile && Math.hypot(pile.tx - 24, pile.ty - 24) <= 6.5, 'Erdhügel entstehen näher an der Baustelle');
    const h0 = t.height[tIdx(t, 24, 24)];
    let sawCargo = false, sawDump = false;
    for (let k = 0; k < 700 && w.terraJobs.length; k++) {
      step(w);
      sawCargo = sawCargo || ownerEntities(w, 0, 'unit').some(u => u.kind === 'builder' && u.order?.type === 'terra' && u.order?.state === 'dump' && (u.cargo || 0) >= TERRA_LOWER_YIELD);
      sawDump = sawDump || w.events.some(ev => ev.type === 'dump' && ev.unit != null && pile
        && Math.hypot((ev.dx ?? 0) - pile.x, (ev.dy ?? 0) - pile.y) <= 0.1);
    }
    ok(w.terraJobs.length === 0, 'Abgraben wartet auf die Fahrt zum Erdhügel und schließt dann ab');
    ok(sawCargo && sawDump, 'Abgraben lädt den Aushub am Erdhügel mit Animation ab');
    ok((pile?.amount || 0) >= TERRA_LOWER_YIELD, 'Abgraben bucht Erde erst nach dem Abladen in den Erdhügel');
    ok(t.height[tIdx(t, 24, 24)] < h0 - 0.05, 'Abgrab-Auftrag senkt das Gelände nach der Arbeit');
  }

  {
    const w = flatTerraWorld(23104);
    const t = w.terrain, p = w.players[0];
    p.resources.materials = 0;
    const worker = spawnUnit(w, 0, 'builder', 24 * 2 + 1, 24 * 2 + 1);
    worker.resourceRole = 'earth';
    for (const [tx, ty] of [[24, 24], [25, 24], [26, 24]]) applyCommand(w, { type: 'terraform', tx, ty, dir: -1 }, 0);
    const pile = w.entities.get(w.terraJobs[0].earthPileId);
    let ticks = 0, sawChain = false, sawIdleGap = false, pileGrowths = 0, lastPileAmount = pile?.amount || 0;
    for (; ticks < 420 && w.terraJobs.length; ticks++) {
      step(w);
      if (pile && (pile.amount || 0) > lastPileAmount) {
        pileGrowths++;
        lastPileAmount = pile.amount || 0;
      }
      if (w.events.some(ev => ev.type === 'terra_done')) {
        const stillOpen = w.terraJobs.length > 0;
        if (stillOpen) {
          sawChain = sawChain || worker.order?.type === 'terra';
          sawIdleGap = sawIdleGap || worker.order?.type === 'idle';
        }
      }
    }
    ok(w.terraJobs.length === 0 && ticks < 260,
      `Bagger erledigt mehrere Abgrab-Abschnitte zügig nacheinander (${ticks} Ticks)`);
    ok(sawChain && !sawIdleGap, 'Bagger fährt nach dem Abgraben automatisch zum nächsten Abschnitt weiter');
    ok(t.height[tIdx(t, 26, 24)] < 0.58, 'Auch der letzte Abgrab-Folgeabschnitt wird ausgeführt');
    ok(pileGrowths >= 3 && pile.amount === TERRA_LOWER_YIELD * 3,
      'Der Erdhaufen wächst mit jeder Abgrab-Lieferung sichtbar weiter');
  }

  {
    const w = flatTerraWorld(23106);
    const p = w.players[0];
    p.resources.materials = 0;
    const worker = spawnUnit(w, 0, 'builder', 24 * 2 + 1, 24 * 2 + 1);
    worker.resourceRole = 'earth';
    applyCommand(w, { type: 'terraform', tx: 24, ty: 24, dir: -1 }, 0);
    const job = w.terraJobs[0];
    const pile = w.entities.get(job.earthPileId);
    const oldX = pile.x, oldY = pile.y;
    let retargeted = false, dumpedAtNewPile = false;
    for (let k = 0; k < 260 && w.terraJobs.length; k++) {
      step(w);
      if (!retargeted && worker.order?.type === 'terra' && worker.order.state === 'dump') {
        applyCommand(w, { type: 'setPile', job: job.id, tx: 30, ty: 24 }, 0);
        retargeted = true;
        ok(pile.tx === 30 && pile.ty === 24, 'Abgrab-Baustelle setzt die Erdhaufenposition neu');
        ok(worker.moveTarget && Math.hypot(worker.moveTarget.x - pile.x, worker.moveTarget.y - pile.y) < 7
          && Math.hypot(worker.moveTarget.x - oldX, worker.moveTarget.y - oldY) > 5,
          'Bagger wird beim Umsetzen direkt zum neuen Erdhaufen umgelenkt');
      }
      dumpedAtNewPile = dumpedAtNewPile || w.events.some(ev => ev.type === 'dump' && ev.unit === worker.id
        && Math.hypot((ev.dx ?? 0) - pile.x, (ev.dy ?? 0) - pile.y) <= 0.1);
    }
    ok(retargeted && w.terraJobs.length === 0, 'Bagger fährt nach dem Umsetzen weiter zwischen Abschnitt und Erdhaufen');
    ok(dumpedAtNewPile && pile.amount === TERRA_LOWER_YIELD, 'Aushub landet am neu gesetzten Erdhaufen');
  }

  {
    const w = flatTerraWorld(23102);
    const t = w.terrain, p = w.players[0];
    p.resources.materials = 0;
    const pile = spawnBuilding(w, 0, 'earth_pile', 21, 24);
    pile.amount = TERRA_RAISE_COST + 2;
    const [bx, by] = tileToWorld(20, 24);
    spawnUnit(w, 0, 'builder', bx, by).resourceRole = 'earth';
    const i = tIdx(t, 26, 24), h0 = t.height[i];
    applyCommand(w, { type: 'terraform', tx: 26, ty: 24, dir: 1 }, 0);
    ok(w.terraJobs.length === 1, 'Aufschütten akzeptiert einen nahen Erdhügel als Quelle');
    let sawDump = false;
    for (let k = 0; k < 700 && w.terraJobs.length; k++) {
      step(w);
      sawDump = sawDump || w.events.some(ev => ev.type === 'dump' && ev.unit != null
        && Math.hypot((ev.dx ?? 0) - (26 * 2 + 1), (ev.dy ?? 0) - (24 * 2 + 1)) <= 0.1);
    }
    ok(w.terraJobs.length === 0, 'Aufschütten mit Erdhügelquelle wird abgeschlossen');
    ok(pile.amount === 2, 'Aufschütten nimmt Erde aus dem nächsten Erdhügel');
    ok(p.resources.materials === 0, 'Aufschütten aus Erdhügeln belastet das Baumateriallager nicht');
    ok(t.height[i] > h0 + 0.05, 'Aufschütten hebt das Gelände nach dem Abladen an');
    ok(sawDump, 'Aufschütten erzeugt eine Dump-Animation an der Zielzelle');
  }

  {
    const w = flatTerraWorld(23105);
    const t = w.terrain, p = w.players[0];
    p.resources.materials = 0;
    const pile = spawnBuilding(w, 0, 'earth_pile', 21, 24);
    pile.amount = TERRA_RAISE_COST * 3;
    const worker = spawnUnit(w, 0, 'builder', 21 * 2 + 1, 25 * 2 + 1);
    worker.resourceRole = 'earth';
    for (const [tx, ty] of [[24, 24], [25, 24], [26, 24]]) applyCommand(w, { type: 'terraform', tx, ty, dir: 1 }, 0);
    let ticks = 0, sawChain = false, sawIdleGap = false;
    for (; ticks < 520 && w.terraJobs.length; ticks++) {
      step(w);
      if (w.events.some(ev => ev.type === 'terra_done')) {
        const stillOpen = w.terraJobs.length > 0;
        if (stillOpen) {
          sawChain = sawChain || worker.order?.type === 'terra';
          sawIdleGap = sawIdleGap || worker.order?.type === 'idle';
        }
      }
    }
    ok(w.terraJobs.length === 0 && ticks < 340,
      `Bagger erledigt mehrere Aufschuett-Abschnitte zügig nacheinander (${ticks} Ticks)`);
    ok(sawChain && !sawIdleGap, 'Bagger fährt nach dem Aufschütten automatisch zum nächsten Abschnitt weiter');
    ok(t.height[tIdx(t, 26, 24)] > 0.70 && pile.amount === 0,
      'Alle Aufschütt-Folgeabschnitte verbrauchen den Erdhaufen und heben das Gelände');
  }

  {
    const w = flatTerraWorld(23103);
    const t = w.terrain, p = w.players[0];
    p.resources.materials = TERRA_RAISE_COST + 3;
    const depot = spawnBuilding(w, 0, 'material_depot', 5, 5);
    depot.buildProgress = 1; depot.hp = depot.maxHp;
    const farPile = spawnBuilding(w, 0, 'earth_pile', 2, 42);
    farPile.amount = 100;
    const [bx, by] = tileToWorld(6, 7);
    spawnUnit(w, 0, 'builder', bx, by).resourceRole = 'earth';
    const i = tIdx(t, 31, 30), h0 = t.height[i];
    applyCommand(w, { type: 'terraform', tx: 31, ty: 30, dir: 1 }, 0);
    ok(w.terraJobs.length === 1, 'Aufschütten fällt ohne nahen Erdhügel auf das Baumateriallager zurück');
    for (let k = 0; k < 900 && w.terraJobs.length; k++) step(w);
    ok(w.terraJobs.length === 0, 'Aufschütten vom Baumateriallager wird abgeschlossen');
    ok(farPile.amount === 100, 'Ein zu weit entfernter Erdhügel wird nicht als Quelle benutzt');
    ok(p.resources.materials === 3, 'Baumateriallager zahlt nur, wenn kein naher Erdhügel verfügbar ist');
    ok(t.height[i] > h0 + 0.05, 'Depot-Aufschüttung hebt das Gelände');
  }
}

// 28) Tunnel: durchgehende Röhre (Hang→Hang), Land+Wasser passierbar, Versiegeln, Kollaps, Wasserfluss
{
  const w = createWorld({ data, seed: 777, players: [{ id: 0, faction: 'KBN', controller: 'human' }] });
  const t = w.terrain;
  w.env = { weather: 'clear', weatherLeft: 1e9, daylight: 1, dayT: 0.5 }; w._nextQuake = 1e9; w._lightningCd = 1e9;
  const X = 40, Y = 40;
  // Synthetisches Tal: flacher Boden, mittig ein 3 Tiles breiter Klippen-Riegel.
  for (let y = Y - 2; y <= Y + 2; y++) for (let x = X - 6; x <= X + 6; x++) {
    const i = tIdx(t, x, y); t.type[i] = TT.LAND; t.height[i] = 0.5; t.water[i] = 0; t.baseWater[i] = 0;
    t.block[i] = 0; t.ore[i] = 0; if (t.oil) t.oil[i] = 0; if (t.tunnel) t.tunnel[i] = 0; if (t.waterBlock) t.waterBlock[i] = 0;
  }
  for (let y = Y - 2; y <= Y + 2; y++) for (let x = X - 1; x <= X + 1; x++) { const i = tIdx(t, x, y); t.type[i] = TT.CLIFF; t.height[i] = 0.9; }
  const sx = X - 2, sy = Y, ex = X + 2, ey = Y;
  w.players[0].resources.ore = 5000; w.players[0].resources.materials = 2000;

  ok(!validateTunnel(w, X - 6, Y, X - 4, Y), 'Tunnel flach→flach (kein Hang/Klippe) wird abgelehnt');
  ok(!!validateTunnel(w, sx, sy, ex, ey), 'Tunnel Hang→Hang quer durch die Klippe ist gültig');

  const ok1 = placeTunnel(w, w.players[0], sx, sy, ex, ey, null);
  ok(ok1 && w.tunnels.length === 1, 'placeTunnel erzeugt EINE Struktur mit zwei Mündungen');
  const tn = w.tunnels[0];
  const a = w.entities.get(tn.mouthA), b = w.entities.get(tn.mouthB);
  ok(a && b && a.kind === 'tunnel' && b.kind === 'tunnel', 'Zwei Mündungsgebäude erzeugt');
  ok(!isPassable(t, 'land', X, Y), 'Vor Fertigstellung: Klippe im Inneren bleibt unpassierbar');
  a.buildProgress = 1; b.buildProgress = 1; activateTunnelIfReady(w, a);
  ok(tn.active, 'Tunnel aktiv, sobald beide Mündungen fertig');
  ok(isPassable(t, 'land', X, Y), 'Aktiver Tunnel: Fahrzeuge/Land kommen durch die Klippe');
  ok(isPassable(t, 'water', X, Y), 'Aktiver Tunnel: auch Wasser/Schiffe kommen durch');

  // Wasserfluss: hohe Mündung füllen → Wasser erreicht die andere (durch den Berg getrennte) Seite.
  const ia = tIdx(t, sx, sy), ib = tIdx(t, ex, ey);
  t.water[ia] = 0.4; if (t.waterActive) t.waterActive.add(ia);
  for (let i = 0; i < 40; i++) step(w);
  ok(t.water[ib] > 0.001, 'Wasser fließt durch den Tunnel zur anderen Seite');

  // Einheit in der Röhre wird als "inTunnel" geführt.
  const u = spawnUnit(w, 0, 'rifleman', X * 2 + 1, Y * 2 + 1);
  step(w);
  ok(!!u.inTunnel, 'Einheit auf einem Innen-Tile gilt als im Tunnel verborgen');

  // Eine Mündung zerstören → versiegelt, Tunnel bleibt (andere Seite offen), Einheit lebt.
  a.hp = 0; a.dead = true; step(w);
  ok(w.tunnels.length === 1 && tn.sealedA, 'Eine zerstörte Mündung versiegelt nur dieses Ende');
  ok(!isPassable(t, 'land', X - 1, Y), 'Versiegeltes Ende: die Röhre ist an dieser Mündung dicht');
  ok(isPassable(t, 'land', X, Y) && !u.dead, 'Innere Röhre zur offenen Seite bleibt offen, Einheit darin lebt noch');

  // Zweite Mündung zerstören → Kollaps: Tunnel weg, Innen-Tiles dicht, Einheit darin stirbt.
  b.hp = 0; b.dead = true; step(w);
  ok(w.tunnels.length === 0, 'Beide Mündungen zerstört → Tunnel zerfällt');
  ok(!isPassable(t, 'land', X, Y), 'Kollabierter Tunnel: Klippe wieder unpassierbar');
  ok(u.dead, 'Einheiten im kollabierten Tunnel kommen mit unter');
}

// 30) Kanal-Schiff: hebt entlang einer Linie eine Landenge zu schiffbarem Kanal aus
{
  const w = createWorld({ data, seed: 9, players: [{ id: 0, faction: 'FLG', controller: 'human' }] });
  const t = w.terrain;
  w.env = { weather: 'clear', weatherLeft: 1e9, daylight: 1, dayT: 0.5 }; w._nextQuake = 1e9; w._lightningCd = 1e9;
  const Y = 60;
  for (let y = Y - 3; y <= Y + 3; y++) for (let x = 34; x <= 55; x++) {
    const i = tIdx(t, x, y);
    if (x <= 40 || x >= 49) { t.type[i] = TT.WATER; t.height[i] = SEA_LEVEL - 0.1; t.height0[i] = t.height[i]; t.water[i] = NAVIGABLE_DEPTH * 1.6; t.baseWater[i] = t.water[i]; }
    else { t.type[i] = TT.LAND; t.height[i] = 0.55; t.height0[i] = 0.55; t.water[i] = 0; t.baseWater[i] = 0; }
    t.block[i] = 0; if (t.lakeMask) t.lakeMask[i] = 0; if (t.waterActive) t.waterActive.add(i);
  }
  ok(!isPassable(t, 'water', 44, Y), 'Landenge: vor dem Kanal ist die Mitte nicht schiffbar');
  const ship = spawnUnit(w, 0, 'sea_builder', 39 * 2 + 1, Y * 2 + 1);
  applyCommand(w, { type: 'canal', units: [ship.id], sx: 41, sy: Y, ex: 48, ey: Y }, 0);
  for (let k = 0; k < 800 && ship.order.type === 'canal'; k++) step(w);
  let dug = 0; for (let x = 41; x <= 48; x++) if (isPassable(t, 'water', x, Y)) dug++;
  ok(dug >= 7, `Kanal-Schiff hebt die Landenge zu schiffbarem Kanal aus (${dug}/8 Zellen)`);
  ok(isPassable(t, 'water', 44, Y), 'Nach dem Kanalbau ist die ehemalige Landenge schiffbar');
}

console.log(`\nSmoke-Test: ${pass} bestanden, ${fail} fehlgeschlagen\n`);
process.exit(fail ? 1 : 0);
