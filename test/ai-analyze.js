// KI-Analyse-Modus — deterministische KI-gegen-KI-Partien für die GEZIELTE Fehlersuche.
//
// Unterschied zu match-sim.js (das nur Zielwerte über viele Partien aggregiert): dieser Modus spielt
// EINE (oder wenige) Partie(n) durch und zerlegt die Karte in ein RASTER, um zu sehen, WO etwas
// passiert — wo gekämpft wird, wo Einheiten festhängen, wo sich die Parteien überhaupt begegnen,
// welche Region welches Gelände hat und ob die Basen über Land verbunden sind. Damit lässt sich z. B.
// die Ursache eingefrorener Unentschieden lokalisieren (treffen sich die Armeen je in einer Region?).
//
// Stabile Analysebedingungen: KEIN Tag/Nacht-Wechsel (konstanter Mittag) und KEIN Wetterwechsel
// (dauerhaft klar) — so verfälschen Licht/Sturm/Nebel die Messung nicht und Läufe sind vergleichbar.
//
// Aufruf:
//   node test/ai-analyze.js [seed] [maxTicks] [grid] [factionA] [factionB]
//   z. B. node test/ai-analyze.js 7 9000 6 KBN HLX
//
// Als Modul nutzbar:  import { analyzeMatch } from './ai-analyze.js'  → liefert den Report als Objekt.

import { loadData } from '../shared/data-node.js';
import { createWorld, step } from '../shared/sim.js';
import { worldToTile, tIdx, inBounds, isPassable, slopeOk, TT } from '../shared/terrain.js';
import { SLOPE_VEHICLE, SLOPE_ON_ROAD } from '../shared/constants.js';

const data = loadData();

// Konstante Analysebedingungen erzwingen: fester Mittag, klares Wetter, kein Director-Tag/Nacht.
function freezeEnvironment(world) {
  world.controls = { ...(world.controls || {}), timeMode: 'day' }; // stepEnvironment fixiert dayT=0.5
  if (!world.env) return;
  world.env.weather = 'clear';
  world.env.weatherLeft = 1e9;     // Wetter-Automat löst nie aus
  world.env.forecast = [];
}

// Eine passierbare Zelle in der Nähe eines Punktes (HQ-Mitte ist solide → von dort scheitert jede Suche).
function passableNear(t, cx, cy, category) {
  for (let r = 1; r <= 16; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      if (inBounds(t, x, y) && isPassable(t, 'land', x, y, category)) return [x, y];
    }
  }
  return null;
}

// Land-Erreichbarkeit per Flutfüllung (Infanterie: Kletterer; Fahrzeug: mit Steigungslimit/Klippen).
function landConnected(t, from, to, category) {
  if (!from || !to) return false;
  const W = t.w, H = t.h;
  const seen = new Uint8Array(W * H);
  const stack = [from]; seen[from[1] * W + from[0]] = 1;
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const vehicle = category === 'vehicle';
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x === to[0] && y === to[1]) return true;
    const ci = y * W + x;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(t, nx, ny)) continue;
      const i = ny * W + nx;
      if (seen[i] || !isPassable(t, 'land', nx, ny, category)) continue;
      if (vehicle && !slopeOk(t, ci, i, SLOPE_VEHICLE, SLOPE_ON_ROAD, null)) continue;
      seen[i] = 1; stack.push([nx, ny]);
    }
  }
  return seen[to[1] * W + to[0]] === 1;
}

export function analyzeMatch({ seed = 7, maxTicks = 9000, grid = 6, factionA = 'KBN', factionB = 'HLX', sample = 50 } = {}) {
  const world = createWorld({ data, seed, players: [
    { id: 0, faction: factionA, controller: 'ai' },
    { id: 1, faction: factionB, controller: 'ai' },
  ] });
  freezeEnvironment(world);
  const t = world.terrain;
  const W = t.w, H = t.h;
  const cellW = W / grid, cellH = H / grid;
  const regionOf = (wx, wy) => {
    const [tx, ty] = worldToTile(wx, wy);
    const gx = Math.max(0, Math.min(grid - 1, Math.floor(tx / cellW)));
    const gy = Math.max(0, Math.min(grid - 1, Math.floor(ty / cellH)));
    return gy * grid + gx;
  };
  const R = grid * grid;
  const combat = new Float64Array(R);          // Feuer/Explosions-Events je Region
  const deaths = new Float64Array(R);          // Tode je Region
  const presence = [new Float64Array(R), new Float64Array(R)]; // Einheiten-Ticks je Region & Spieler
  const contact = new Float64Array(R);         // Ticks, in denen BEIDE Parteien in der Region sind

  let decidedTick = -1, winner = -1;
  for (let tick = 0; tick < maxTicks; tick++) {
    freezeEnvironment(world);                  // jeden Tick festhalten (Director könnte controls überschreiben)
    step(world);
    for (const ev of world.events) {
      if (ev.x == null || ev.y == null) continue;
      if (ev.type === 'fire' || ev.type === 'explosion') combat[regionOf(ev.x, ev.y)]++;
      else if (ev.type === 'death') deaths[regionOf(ev.x, ev.y)]++;
    }
    if (tick % sample === 0) {
      const had = [new Uint8Array(R), new Uint8Array(R)];
      for (const e of world.entities.values()) {
        if (e.etype !== 'unit' || e.dead || e.owner > 1) continue;
        const r = regionOf(e.x, e.y);
        presence[e.owner][r]++; had[e.owner][r] = 1;
      }
      for (let r = 0; r < R; r++) if (had[0][r] && had[1][r]) contact[r]++;
    }
    const active = world.players.filter(p => !p.defeated);
    if (active.length <= 1) { decidedTick = tick; winner = active[0]?.id ?? -1; break; }
  }

  // Geländezusammensetzung je Region.
  const terr = Array.from({ length: R }, () => ({ land: 0, hill: 0, cliff: 0, water: 0, forest: 0 }));
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const i = tIdx(t, tx, ty);
    const r = (Math.min(grid - 1, Math.floor(ty / cellH))) * grid + Math.min(grid - 1, Math.floor(tx / cellW));
    const ty_ = t.type[i];
    if (ty_ === TT.WATER || (t.water?.[i] || 0) > 0.18) terr[r].water++;
    else if (ty_ === TT.CLIFF) terr[r].cliff++;
    else if (ty_ === TT.HILL) terr[r].hill++;
    else terr[r].land++;
    if ((t.cover?.[i] || 0) >= 0.2) terr[r].forest++;
  }

  // Basis-zu-Basis-Erreichbarkeit (von passierbaren Zellen neben den HQs, nicht der soliden Mitte).
  const hqs = [...world.entities.values()].filter(e => e.kind === 'hq');
  const conn = {};
  if (hqs.length >= 2) {
    const a = hqs.find(h => h.owner === 0) || hqs[0], b = hqs.find(h => h.owner === 1) || hqs[1];
    const [ax, ay] = worldToTile(a.x, a.y), [bx, by] = worldToTile(b.x, b.y);
    conn.infantry = landConnected(t, passableNear(t, ax, ay, 'infantry'), passableNear(t, bx, by, 'infantry'), 'infantry');
    conn.vehicle = landConnected(t, passableNear(t, ax, ay, 'vehicle'), passableNear(t, bx, by, 'vehicle'), 'vehicle');
  }

  return {
    seed, factionA, factionB, grid, maxTicks,
    decided: decidedTick >= 0, decidedTick, winner,
    durationSec: ((decidedTick >= 0 ? decidedTick : maxTicks) / 10) | 0,
    map: { w: W, h: H },
    conn,
    regions: Array.from({ length: R }, (_, r) => ({
      r, gx: r % grid, gy: (r / grid) | 0,
      combat: Math.round(combat[r]), deaths: Math.round(deaths[r]),
      contact: Math.round(contact[r]),
      presence0: Math.round(presence[0][r]), presence1: Math.round(presence[1][r]),
      terrain: terr[r],
    })),
  };
}

// Kompakte Konsolenausgabe (eine Region je Zeile, plus Karte als ASCII-Heatmaps).
function printReport(rep) {
  const g = rep.grid;
  console.log(`\n=== KI-Analyse  Seed ${rep.seed}  ${rep.factionA} vs ${rep.factionB}  (${rep.map.w}x${rep.map.h}, Raster ${g}x${g}) ===`);
  console.log(`Ergebnis: ${rep.decided ? `entschieden in ${rep.durationSec}s, Sieger Sitz ${rep.winner}` : `UNENTSCHIEDEN nach ${rep.durationSec}s`}`);
  console.log(`Basis↔Basis erreichbar:  Infanterie=${rep.conn.infantry ? 'JA' : 'NEIN'}  Fahrzeug=${rep.conn.vehicle ? 'JA' : 'nein'}`);

  const totalCombat = rep.regions.reduce((a, x) => a + x.combat, 0);
  const contactRegions = rep.regions.filter(x => x.contact > 0).length;
  console.log(`Kampf-Events gesamt: ${totalCombat}   Kontakt-Regionen (beide Parteien): ${contactRegions}/${rep.regions.length}`);

  const heat = (sel, glyphs = ' .:-=+*#%@') => {
    const vals = rep.regions.map(sel);
    const max = Math.max(1, ...vals);
    let out = '';
    for (let gy = 0; gy < g; gy++) {
      let row = '';
      for (let gx = 0; gx < g; gx++) {
        const v = vals[gy * g + gx];
        row += glyphs[Math.min(glyphs.length - 1, Math.round((v / max) * (glyphs.length - 1)))];
      }
      out += '  ' + row + '\n';
    }
    return out;
  };
  console.log('\nKampf-Heatmap (wo gefeuert/explodiert wird):');
  process.stdout.write(heat(x => x.combat));
  console.log('Kontakt-Heatmap (wo sich beide Parteien begegnen):');
  process.stdout.write(heat(x => x.contact));
  console.log('Gelände: Wald-Dichte:');
  process.stdout.write(heat(x => x.terrain.forest));
  console.log('Gelände: Klippen-Dichte (Fahrzeug-Sperren):');
  process.stdout.write(heat(x => x.terrain.cliff));

  // Auffällige Regionen: viel Präsenz, aber kein Kontakt → mögliche tote Fronten.
  const stuck = rep.regions
    .filter(x => (x.presence0 + x.presence1) > 0 && x.contact === 0 && x.combat === 0)
    .sort((a, b) => (b.presence0 + b.presence1) - (a.presence0 + a.presence1)).slice(0, 5);
  if (stuck.length) {
    console.log('\nRegionen mit Präsenz aber OHNE Kontakt/Kampf (mögliche Stau-/Totzonen):');
    for (const s of stuck) console.log(`  (${s.gx},${s.gy})  P0=${s.presence0} P1=${s.presence1}  Klippen=${s.terrain.cliff} Wasser=${s.terrain.water}`);
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = parseInt(process.argv[2] || '7', 10);
  const maxTicks = parseInt(process.argv[3] || '9000', 10);
  const grid = parseInt(process.argv[4] || '6', 10);
  const factionA = process.argv[5] || 'KBN';
  const factionB = process.argv[6] || 'HLX';
  printReport(analyzeMatch({ seed, maxTicks, grid, factionA, factionB }));
}
