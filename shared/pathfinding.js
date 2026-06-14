// A*-Pfadfindung auf dem Tile-Grid, domänenabhängig (land/air/water/amphibious),
// mit Steigungslimit je Einheit (Straßen erlauben steilere Passagen — Serpentinen).
import { isPassable, inBounds, tIdx, heightAt, TT, tileType, slopeOk, forestBlocks } from './terrain.js';
import { BUILDER_WADE_DEPTH, FLOOD_DEPTH, MUD_IMPASSABLE, SLOPE_ON_ROAD, SLOPE_TERRAFORM_BUILDER, WET_DEPTH } from './constants.js';

const NEI = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];
const GOAL_FALLBACK_RADIUS = 8;

// Bewegungskosten einer Zelle: Steigung & Hügel verteuern, Deckung neutral.
function tileCost(t, tx, ty, opts) {
  let c = 1;
  if (tileType(t, tx, ty) === TT.HILL) c += 0.4;
  if (t.mud) c += t.mud[tIdx(t, tx, ty)] * (opts && opts.heavy ? 8 : 2);
  return c;
}

function mudCrawlerPassable(t, domain, tx, ty, opts) {
  if ((!opts?.mudCrawler && !opts?.builderWade) || domain !== 'land' || !inBounds(t, tx, ty)) return false;
  const i = tIdx(t, tx, ty);
  const inTunnel = t.tunnel && t.tunnel[i] > 0;
  const blocked = t.block && t.block[i] > 0;
  const depth = t.water?.[i] || 0;
  const mudOk = opts?.mudCrawler && t.mud && t.mud[i] > 0.02 && depth <= FLOOD_DEPTH;
  const wadeOk = opts?.builderWade && depth > WET_DEPTH && depth <= BUILDER_WADE_DEPTH;
  return (t.type[i] !== TT.CLIFF || inTunnel)
    && !blocked
    && (mudOk || wadeOk);
}

function passableFor(t, domain, tx, ty, opts) {
  if (!isPassable(t, domain, tx, ty, opts?.category) && !mudCrawlerPassable(t, domain, tx, ty, opts)) return false;
  if (forestBlocks(t, domain, tx, ty, opts)) return false;
  if (opts && opts.heavy && domain === 'land' && t.mud && t.mud[tIdx(t, tx, ty)] >= MUD_IMPASSABLE) return false;
  return true;
}

export function findPath(t, domain, sx, sy, gx, gy, maxIter = 6000, maxSlope = Infinity, opts = null) {
  sx = clampTile(sx, t.w);
  sy = clampTile(sy, t.h);
  gx = clampTile(gx, t.w);
  gy = clampTile(gy, t.h);
  if (sx === gx && sy === gy) return markGoal([], sx, sy);

  const exactI = gy * t.w + gx;
  if (passableFor(t, domain, gx, gy, opts)) {
    return searchPath(t, domain, sx, sy, gx, gy, new Set([exactI]), 0, maxIter, maxSlope, opts);
  }
  const fallback = collectGoalCandidates(t, domain, gx, gy, opts);
  if (!fallback.length) return null;
  return searchPath(t, domain, sx, sy, gx, gy, new Set(fallback), GOAL_FALLBACK_RADIUS, maxIter, maxSlope, opts);
}

function clampTile(v, max) {
  return Math.max(0, Math.min(max - 1, v | 0));
}

function collectGoalCandidates(t, domain, gx, gy, opts) {
  const out = [];
  for (let r = 0; r <= GOAL_FALLBACK_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = gx + dx, ny = gy + dy;
      if (!passableFor(t, domain, nx, ny, opts)) continue;
      out.push({ i: ny * t.w + nx, d: dx * dx + dy * dy });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map(c => c.i);
}

function searchPath(t, domain, sx, sy, hx, hy, goalSet, goalRadius, maxIter, maxSlope, opts) {
  const W = t.w;
  const N = W * t.h;
  const open = [];                 // binärer Min-Heap (Array von [f, idx])
  const came = new Int32Array(N); came.fill(-1);
  const closed = new Uint8Array(N);
  const g = new Float64Array(N); g.fill(Infinity);
  const startI = sy * W + sx;
  if (goalSet.has(startI)) return markGoal([], sx, sy);
  const H = (i) => {
    const ix = i % W, iy = (i / W) | 0;
    return Math.max(0, Math.hypot(ix - hx, iy - hy) - goalRadius);
  };
  g[startI] = 0;
  heapPush(open, [H(startI), startI]);
  let iter = 0;

  while (open.length && iter++ < maxIter) {
    const cur = heapPop(open)[1];
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (goalSet.has(cur)) return reconstruct(came, cur, W);
    const cx = cur % W, cy = (cur / W) | 0;
    const cg = g[cur];
    for (const [dx, dy, base] of NEI) {
      const nx = cx + dx, ny = cy + dy;
      if (!passableFor(t, domain, nx, ny, opts)) continue;
      // Diagonale nicht durch Ecken zwängen.
      if (dx && dy && (!passableFor(t, domain, cx + dx, cy, opts) && !passableFor(t, domain, cx, cy + dy, opts))) continue;
      const ni = ny * W + nx;
      // Steigungslimit (nur Boden): zu steile Übergänge sind tabu — außer auf Straßen.
      if (maxSlope !== Infinity && (domain === 'land' || domain === 'amphibious')
        && !slopeOk(t, cur, ni, maxSlope, SLOPE_ON_ROAD, opts?.terraCrawler ? SLOPE_TERRAFORM_BUILDER : null)) continue;
      const ng = cg + base * tileCost(t, nx, ny, opts);
      if (ng < g[ni]) {
        g[ni] = ng; came[ni] = cur;
        heapPush(open, [ng + H(ni), ni]);
      }
    }
  }
  return null; // kein Pfad gefunden
}

function reconstruct(came, cur, W) {
  const path = [];
  const goal = [cur % W, (cur / W) | 0];
  while (came[cur] >= 0) { path.push([cur % W, (cur / W) | 0]); cur = came[cur]; }
  path.reverse();
  return markGoal(path, goal[0], goal[1]);
}

function markGoal(path, gx, gy) {
  path.goal = [gx, gy];
  return path;
}

// --- Min-Heap ---
function heapPush(h, node) {
  h.push(node); let i = h.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) { h[0] = last; let i = 0; const n = h.length;
    while (true) { let l = 2 * i + 1, r = l + 1, s = i;
      if (l < n && h[l][0] < h[s][0]) s = l;
      if (r < n && h[r][0] < h[s][0]) s = r;
      if (s === i) break; [h[s], h[i]] = [h[i], h[s]]; i = s; } }
  return top;
}
