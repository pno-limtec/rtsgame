// Autoritativer WebSocket-Server: hostet eine Lobby/ein Match + liefert den Client aus.
// Start:  node server/index.js   →  http://localhost:8080
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname, normalize } from 'path';
import { WebSocketServer } from 'ws';
import { loadData } from '../shared/data-node.js';
import { Match } from './match.js';
import { TICK_RATE } from '../shared/constants.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PORT = process.env.PORT || 8080;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const data = loadData();
const SLOTS = parseInt(process.env.SLOTS || '2', 10);
const match = new Match({ data, seed: (Date.now() & 0x7fffffff) || 1, slots: SLOTS });

// --- HTTP: statische Dateien (Client) ---
const http = createServer(async (req, res) => {
  try {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/client/index.html';
    if (url === '/data') { // gebündelte Balancing-Daten für den Client
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    const path = normalize(join(ROOT, url));
    if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

// --- WebSocket: Spiel-Protokoll ---
const wss = new WebSocketServer({ server: http });
const clients = new Set();

wss.on('connection', (ws) => {
  ws.seat = null;
  clients.add(ws);
  ws.send(JSON.stringify(match.init()));

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    switch (msg.t) {
      case 'join': {
        const seat = match.joinHuman(msg.name || 'Spieler', msg.seat);
        ws.seat = seat;
        ws.send(JSON.stringify({ type: 'joined', seat, ok: seat != null }));
        broadcastLobby();
        break;
      }
      case 'reconnect': {
        const seat = match.reconnect(msg.seat, msg.name);
        ws.seat = seat;
        ws.send(JSON.stringify({ type: 'joined', seat, ok: seat != null }));
        break;
      }
      case 'cmd': {
        if (ws.seat != null) match.command(ws.seat, msg.cmd);
        break;
      }
      case 'spectatorControl': {
        match.setSpectatorControls({ speed: msg.speed, timeMode: msg.timeMode });
        break;
      }
      case 'newGame': {
        match.reset({ sameMap: !!msg.sameMap });
        broadcastInit();
        broadcastLobby();
        break;
      }
      case 'saveGame': {
        ws.send(JSON.stringify({
          type: 'saveGame',
          filename: `iron-frontier-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
          save: match.saveGame(),
        }));
        break;
      }
      case 'loadGame': {
        try {
          match.loadGame(msg.save);
          broadcastInit();
          broadcastLobby();
        } catch (err) {
          ws.send(JSON.stringify({ type: 'menuError', message: err?.message || 'Spielstand konnte nicht geladen werden' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.seat != null) match.markDisconnected(ws.seat); // KI übernimmt nach Timeout
    broadcastLobby();
  });
});

function broadcastLobby() {
  const lobby = JSON.stringify({
    type: 'lobby',
    players: match.world.players.map(p => ({ id: p.id, name: p.name, faction: p.faction, controller: p.controller, defeated: p.defeated })),
    controls: match.controlsView(),
  });
  for (const ws of clients) if (ws.readyState === 1) ws.send(lobby);
}

function broadcastInit() {
  const init = JSON.stringify(match.init());
  for (const ws of clients) if (ws.readyState === 1) ws.send(init);
}

// --- Spiel-Loop: feste Tickrate, Snapshot-Broadcast ---
let acc = 0, last = Date.now();
setInterval(() => {
  const now = Date.now();
  const speed = match.simSpeed();
  acc += ((now - last) / 1000) * speed;
  last = now;
  const dt = 1 / TICK_RATE;
  let n = 0;
  const maxSteps = Math.max(5, Math.ceil(5 * speed));
  while (acc >= dt && n < maxSteps) { match.tick(); acc -= dt; n++; } // Aufholen, aber begrenzt
  if (n > 0) {
    const snap = JSON.stringify(match.snapshot());
    for (const ws of clients) if (ws.readyState === 1) ws.send(snap);
  }
}, 1000 / TICK_RATE);

http.listen(PORT, () => {
  console.log(`\n  Iron Frontier Server läuft auf  http://localhost:${PORT}`);
  console.log(`  ${SLOTS} Sitze · Tickrate ${TICK_RATE} Hz · KI-Übernahme & Join-in-Progress aktiv\n`);
});
