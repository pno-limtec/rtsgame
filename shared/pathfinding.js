// A*-Pfadfindung auf dem Tile-Grid, domänenabhängig (land/air/water/amphibious),
// mit Steigungslimit je Einheit (Straßen erlauben steilere Passagen — Serpentinen).
import { isPassable, inBounds, tIdx, heightAt, TT, tileType, slopeOk, forestBlocks } from './terrain.js';
import { MUD_IMPASSABLE, SLOPE_ON_ROAD } from './constants.js';

const NEI = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];

// Bewegungskosten einer Zelle: Steigung & Hügel verteuern, Deckung neutral.
function tileCost(t, tx, ty, opts) {
  let c = 1;
  if (tileType(t, tx, ty) === TT.HILL) c += 0.4;
  if (t.mud) c += t.mud[tIdx(t, tx, ty)] * (opts && opts.heavy ? 8 : 2);
  return c;
}

function passableFor(t, domain, tx, ty, opts) {
  if (!isPassable(t, domain, tx, ty)) return false;
  if (forestBlocks(t, domain, tx, ty, opts)) return false;
  if (opts && opts.heavy && domain === 'land' && t.mud && t.mud[tIdx(t, tx, ty)] >= MUD_IMPASSABLE) return false;
  return true;
}

export function findPath(t, domain, sx, sy, gx, gy, maxIter = 6000, maxSlope = Infinity, opts = null) {
  if (!inBounds(t, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];
  // Ziel unpassierbar → nächste passierbare Nachbarzelle suchen.
  if (!passableFor(t, domain, gx, gy, opts)) {
    let best = null, bestD = Infinity;
    for (let r = 1; r <= 4 && !best; r++) {
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        const nx = gx + x, ny = gy + y;
        if (!passableFor(t, domain, nx, ny, opts)) continue;
        const d = x * x + y * y;
        if (d < bestD) { bestD = d; best = [nx, ny]; }
      }
    }
    if (!best) return null;
    gx = best[0]; gy = best[1];
  }

  const W = t.w;
  const open = [];                 // binärer Min-Heap (Array von [f, idx])
  const came = new Map();
  const g = new Map();
  const startI = sy * W + sx, goalI = gy * W + gx;
  const H = (i) => { const ix = i % W, iy = (i / W) | 0; return Math.hypot(ix - gx, iy - gy); };
  g.set(startI, 0);
  heapPush(open, [H(startI), startI]);
  let iter = 0;

  while (open.length && iter++ < maxIter) {
    const cur = heapPop(open)[1];
    if (cur === goalI) return reconstruct(came, cur, W);
    const cx = cur % W, cy = (cur / W) | 0;
    const cg = g.get(cur);
    for (const [dx, dy, base] of NEI) {
      const nx = cx + dx, ny = cy + dy;
      if (!passableFor(t, domain, nx, ny, opts)) continue;
      // Diagonale nicht durch Ecken zwängen.
      if (dx && dy && (!passableFor(t, domain, cx + dx, cy, opts) && !passableFor(t, domain, cx, cy + dy, opts))) continue;
      const ni = ny * W + nx;
      // Steigungslimit (nur Boden): zu steile Übergänge sind tabu — außer auf Straßen.
      if (maxSlope !== Infinity && (domain === 'land' || domain === 'amphibious')
        && !slopeOk(t, cur, ni, maxSlope, SLOPE_ON_ROAD)) continue;
      const ng = cg + base * tileCost(t, nx, ny, opts);
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng); came.set(ni, cur);
        heapPush(open, [ng + H(ni), ni]);
      }
    }
  }
  return null; // kein Pfad gefunden
}

function reconstruct(came, cur, W) {
  const path = [];
  while (came.has(cur)) { path.push([cur % W, (cur / W) | 0]); cur = came.get(cur); }
  path.reverse();
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
