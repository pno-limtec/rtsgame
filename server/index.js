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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };

const data = loadData();
const DEFAULT_SLOTS = normalizeSlots(process.env.SLOTS || '2');
const MAX_GAME_LIST = 50;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_CACHE_MAX = 96;
const TTS_STYLES = {
  mixed: { voice: 'marin', instructions: 'Sprich Deutsch wie ein lebendiger, leicht ironischer RTS-Funkoffizier. Kurz, klar, mit spuerbarer Energie, nicht monoton.' },
  infantry: { voice: 'verse', instructions: 'Sprich Deutsch wie ein schneller Infanterie-Funkspruch: nah dran, trocken witzig, wach und leicht ausser Atem.' },
  builder: { voice: 'cedar', instructions: 'Sprich Deutsch wie ein genervter, sympathischer Baggerfahrer. Knurrig, witzig, mit Betonung, aber gut verstaendlich.' },
  truck: { voice: 'ash', instructions: 'Sprich Deutsch wie ein entspannter LKW-Fahrer im Funk. Warm, trocken, ein bisschen frech, nicht hektisch.' },
  vehicle: { voice: 'onyx', instructions: 'Sprich Deutsch wie ein Panzerkommandant im Funk. Tief, entschlossen, mit kurzer komischer Kante, aber nicht gebrüllt.' },
  air: { voice: 'coral', instructions: 'Sprich Deutsch wie ein Pilot im Funk. Hell, schnell, selbstbewusst und spielerisch.' },
  water: { voice: 'sage', instructions: 'Sprich Deutsch wie ein Marineoffizier. Ruhig, salzig-trocken im Humor, klar artikuliert.' },
};
const ttsCache = new Map();
const rooms = new Map();

// --- HTTP: statische Dateien (Client) ---
const http = createServer(async (req, res) => {
  try {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/client/index.html';
    if (url === '/tts') return handleTtsRequest(req, res);
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

async function handleTtsRequest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' });
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  if (!process.env.OPENAI_API_KEY) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'openai_tts_disabled' }));
  }
  try {
    const body = await readJsonBody(req, 4096);
    const text = sanitizeTtsText(body.text);
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'empty_text' }));
    }
    const group = Object.hasOwn(TTS_STYLES, body.group) ? body.group : 'mixed';
    const style = TTS_STYLES[group];
    const cacheKey = `${OPENAI_TTS_MODEL}|${group}|${text}`;
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      res.writeHead(200, { 'content-type': cached.type, 'cache-control': 'private, max-age=3600' });
      return res.end(cached.audio);
    }
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: style.voice,
        input: text,
        instructions: style.instructions,
      }),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 240);
      console.warn(`OpenAI TTS fehlgeschlagen (${upstream.status}): ${detail}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'tts_failed' }));
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get('content-type') || 'audio/mpeg';
    cacheTts(cacheKey, { audio, type });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' });
    res.end(audio);
  } catch (err) {
    res.writeHead(err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err?.code === 'BODY_TOO_LARGE' ? 'body_too_large' : 'bad_request' }));
  }
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sanitizeTtsText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function cacheTts(key, value) {
  if (ttsCache.has(key)) ttsCache.delete(key);
  ttsCache.set(key, value);
  while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
}

// --- WebSocket: Spiel-Protokoll ---
const wss = new WebSocketServer({ server: http });
const clients = new Set();

wss.on('connection', (ws) => {
  ws.seat = null;
  ws.room = null;
  clients.add(ws);
  sendGameList(ws);

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    switch (msg.t) {
      case 'listGames': {
        sendGameList(ws);
        break;
      }
      case 'createGame': {
        const room = createRoom({
          visibility: msg.visibility,
          slots: msg.slots,
          startMode: msg.startMode,
          timeMode: msg.timeMode,
          insanity: msg.insanity,
        });
        if (msg.spectator) watchRoom(ws, room, msg.name || 'Zuschauer', msg.viewSeat);
        else joinRoom(ws, room, msg.name || 'Spieler', 0);
        broadcastGameList();
        break;
      }
      case 'join': {
        const room = findJoinRoom(msg);
        if (!room) {
          ws.send(JSON.stringify({ type: 'joinDenied', message: msg.code ? 'Beitrittscode nicht gefunden' : 'Spiel nicht gefunden' }));
          break;
        }
        if (msg.insanity != null) room.match.setMatchOptions({ insanity: msg.insanity });
        joinRoom(ws, room, msg.name || 'Spieler', msg.seat);
        break;
      }
      case 'watch': {
        const room = findWatchRoom(msg);
        if (!room) {
          ws.send(JSON.stringify({ type: 'joinDenied', message: msg.code ? 'Beitrittscode nicht gefunden' : 'Spiel nicht gefunden' }));
          break;
        }
        watchRoom(ws, room, msg.name || 'Zuschauer', msg.viewSeat);
        break;
      }
      case 'takeover': {
        const room = ws.room;
        if (!room) break;
        const seat = room.match.takeoverAi(msg.name || 'Spieler', msg.seat);
        ws.seat = seat;
        ws.send(JSON.stringify({ type: 'joined', seat, ok: seat != null }));
        if (seat != null) maybeStartRoom(room);
        broadcastLobby(room);
        broadcastGameList();
        break;
      }
      case 'release': {
        const room = ws.room;
        if (!room) break;
        const oldSeat = ws.seat;
        const seat = oldSeat != null ? room.match.releaseHuman(oldSeat) : null;
        if (seat != null) ws.seat = null;
        ws.send(JSON.stringify({ type: 'spectator', seat: seat ?? oldSeat, ok: seat != null }));
        broadcastLobby(room);
        broadcastGameList();
        break;
      }
      case 'leave': {
        leaveRoom(ws);
        ws.send(JSON.stringify({ type: 'left', ok: true }));
        sendGameList(ws);
        break;
      }
      case 'reconnect': {
        const room = ws.room;
        if (!room) break;
        const seat = room.match.reconnect(msg.seat, msg.name);
        ws.seat = seat;
        ws.send(JSON.stringify({ type: 'joined', seat, ok: seat != null }));
        break;
      }
      case 'cmd': {
        if (ws.room && ws.seat != null) ws.room.match.command(ws.seat, msg.cmd);
        break;
      }
      case 'spectatorControl': {
        if (ws.room && ws.seat == null) {
          const patch = {};
          if (Object.prototype.hasOwnProperty.call(msg, 'speed')) patch.speed = msg.speed;
          if (Object.prototype.hasOwnProperty.call(msg, 'timeMode')) patch.timeMode = msg.timeMode;
          if (Object.prototype.hasOwnProperty.call(msg, 'event')) patch.event = msg.event;
          ws.room.match.setSpectatorControls(patch);
        }
        break;
      }
      case 'matchOptions': {
        if (ws.room && ws.seat == null && ws.room.match.setMatchOptions({ insanity: msg.insanity })) broadcastLobby(ws.room);
        break;
      }
      case 'newGame': {
        if (!ws.room) break;
        ws.room.match.reset({ sameMap: !!msg.sameMap, insanity: msg.insanity });
        ws.room.running = ws.room.startMode !== 'wait' || freeSlots(ws.room) === 0;
        broadcastInit(ws.room);
        broadcastLobby(ws.room);
        broadcastGameList();
        break;
      }
      case 'saveGame': {
        if (!ws.room) break;
        ws.send(JSON.stringify({
          type: 'saveGame',
          filename: `faultline-command-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
          save: ws.room.match.saveGame(),
        }));
        break;
      }
      case 'loadGame': {
        if (!ws.room) break;
        try {
          ws.room.match.loadGame(msg.save);
          broadcastInit(ws.room);
          broadcastLobby(ws.room);
          broadcastGameList();
        } catch (err) {
          ws.send(JSON.stringify({ type: 'menuError', message: err?.message || 'Spielstand konnte nicht geladen werden' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const room = ws.room;
    if (room) {
      room.clients.delete(ws);
      if (ws.seat != null) room.match.releaseHuman(ws.seat); // KI spielt sofort weiter
      broadcastLobby(room);
      broadcastGameList();
    }
  });
});

function normalizeSlots(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 2;
  return Math.max(2, Math.min(4, n));
}

function normalizeVisibility(value) {
  return value === 'private' ? 'private' : 'public';
}

function normalizeStartMode(value) {
  return value === 'wait' ? 'wait' : 'instant';
}

function createRoom(opts = {}) {
  const slots = normalizeSlots(opts.slots || DEFAULT_SLOTS);
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const room = {
    id,
    code: makeJoinCode(),
    visibility: normalizeVisibility(opts.visibility),
    startMode: normalizeStartMode(opts.startMode),
    createdAt: Date.now(),
    acc: 0,
    clients: new Set(),
    match: new Match({ data, seed: (Date.now() & 0x7fffffff) || 1, slots, insanity: opts.insanity, timeMode: opts.timeMode }),
  };
  room.running = room.startMode !== 'wait';
  room.match.setMatchOptions({ insanity: opts.insanity, timeMode: opts.timeMode });
  rooms.set(id, room);
  pruneRooms();
  return room;
}

function makeJoinCode() {
  let code = '';
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString(36).toUpperCase();
  } while ([...rooms.values()].some(r => r.code === code));
  return code;
}

function pruneRooms() {
  const empty = [...rooms.values()]
    .filter(r => r.clients.size === 0)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const room of empty.slice(MAX_GAME_LIST * 2)) rooms.delete(room.id);
}

function findJoinRoom(msg = {}) {
  if (msg.roomId && rooms.has(msg.roomId)) {
    const room = rooms.get(msg.roomId);
    if (room.visibility === 'private' && String(msg.code || '').trim().toUpperCase() !== room.code) return null;
    return room;
  }
  if (msg.code) {
    const code = String(msg.code || '').trim().toUpperCase();
    return [...rooms.values()].find(r => r.code === code) || null;
  }
  const publicRooms = publicGameList();
  if (!publicRooms.length) return createRoom({ slots: DEFAULT_SLOTS, visibility: 'public', startMode: 'instant', insanity: msg.insanity });
  return rooms.get(publicRooms[0].id) || null;
}

function findWatchRoom(msg = {}) {
  if (msg.roomId && rooms.has(msg.roomId)) {
    const room = rooms.get(msg.roomId);
    if (room.visibility === 'private' && String(msg.code || '').trim().toUpperCase() !== room.code) return null;
    return room;
  }
  if (msg.code) {
    const code = String(msg.code || '').trim().toUpperCase();
    return [...rooms.values()].find(r => r.code === code) || null;
  }
  return null;
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) { ws.seat = null; return false; }
  if (ws.seat != null) room.match.releaseHuman(ws.seat);
  room.clients.delete(ws);
  ws.room = null;
  ws.seat = null;
  broadcastLobby(room);
  broadcastGameList();
  return true;
}

function joinRoom(ws, room, name, preferredSeat = null) {
  if (ws.room && ws.room !== room) {
    if (ws.seat != null) ws.room.match.releaseHuman(ws.seat);
    ws.room.clients.delete(ws);
    broadcastLobby(ws.room);
  }
  room.match.setMatchOptions({ insanity: room.match.controlsView().insanity });
  const seat = room.match.joinHuman(name || 'Spieler', preferredSeat);
  if (seat == null) {
    ws.send(JSON.stringify({ type: 'joinDenied', message: 'Keine freien KI-Slots in diesem Spiel' }));
    return false;
  }
  ws.room = room;
  ws.seat = seat;
  room.clients.add(ws);
  maybeStartRoom(room);
  ws.send(JSON.stringify({ type: 'roomInfo', room: roomView(room, true) }));
  ws.send(JSON.stringify(room.match.init()));
  ws.send(JSON.stringify({ type: 'joined', seat, ok: true }));
  broadcastLobby(room);
  broadcastGameList();
  return true;
}

function watchRoom(ws, room, name, viewSeat = null) {
  if (ws.room) leaveRoom(ws);
  ws.room = room;
  ws.seat = null;
  room.clients.add(ws);
  const seat = Number.isFinite(viewSeat) ? viewSeat : 0;
  ws.send(JSON.stringify({ type: 'roomInfo', room: roomView(room, room.visibility === 'private') }));
  ws.send(JSON.stringify(room.match.init()));
  ws.send(JSON.stringify({ type: 'spectator', seat, ok: true, name }));
  broadcastGameList();
  return true;
}

function maybeStartRoom(room) {
  if (room.startMode === 'wait' && freeSlots(room) === 0) room.running = true;
}

function freeSlots(room) {
  return room.match.seats.filter(s => !s.occupant && !room.match.player(s.id)?.defeated).length;
}

function publicGameList() {
  return [...rooms.values()]
    .filter(r => r.visibility === 'public')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_GAME_LIST)
    .map(r => roomView(r, false));
}

function roomView(room, revealCode = false) {
  const players = room.match.world.players.length;
  return {
    id: room.id,
    code: revealCode && room.visibility === 'private' ? room.code : null,
    visibility: room.visibility,
    startMode: room.startMode,
    running: !!room.running,
    players,
    free: freeSlots(room),
    createdAt: room.createdAt,
  };
}

function sendGameList(ws) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'gameList', games: publicGameList() }));
}

function broadcastGameList() {
  const msg = JSON.stringify({ type: 'gameList', games: publicGameList() });
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

function broadcastLobby(room) {
  const lobby = JSON.stringify({
    type: 'lobby',
    players: room.match.world.players.map(p => ({ id: p.id, name: p.name, faction: p.faction, controller: p.controller, defeated: p.defeated })),
    controls: room.match.controlsView(),
    room: roomView(room, true),
  });
  for (const ws of room.clients) if (ws.readyState === 1) ws.send(lobby);
}

function broadcastInit(room) {
  const init = JSON.stringify(room.match.init());
  for (const ws of room.clients) if (ws.readyState === 1) ws.send(init);
}

// --- Spiel-Loop: feste Tickrate, Snapshot-Broadcast ---
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = (now - last) / 1000;
  last = now;
  const dt = 1 / TICK_RATE;
  for (const room of rooms.values()) {
    if (!room.clients.size || !room.running) continue;
    const speed = room.match.simSpeed();
    room.acc += elapsed * speed;
    let n = 0;
    const maxSteps = Math.max(5, Math.ceil(5 * speed));
    while (room.acc >= dt && n < maxSteps) { room.match.tick(); room.acc -= dt; n++; } // Aufholen, aber begrenzt
    if (n > 0) {
      const snap = JSON.stringify(room.match.snapshot());
      for (const ws of room.clients) if (ws.readyState === 1) ws.send(snap);
    }
  }
}, 1000 / TICK_RATE);

http.listen(PORT, () => {
  console.log(`\n  Faultline Command Server läuft auf  http://localhost:${PORT}`);
  console.log(`  bis zu 4 Spieler · Tickrate ${TICK_RATE} Hz · Räume, Codes & Join-in-Progress aktiv\n`);
});
