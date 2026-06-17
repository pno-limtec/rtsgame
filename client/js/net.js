// Netzwerk-Client: WebSocket-Verbindung, Snapshot-Pufferung für Interpolation.
const KIND_TABLE = [
  'hq', 'power_plant', 'refinery', 'oil_derrick', 'barracks', 'factory', 'airbase', 'shipyard',
  'depot', 'turret', 'sam_site', 'wall', 'trench', 'builder', 'dam',
  'engineer', 'rifleman', 'at_soldier', 'scout', 'tank', 'artillery', 'flak_track', 'harvester',
  'recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air', 'patrol_boat', 'destroyer', 'submarine',
  'amphib_transport', 'sea_builder', 'sonar',
  'solar_plant', 'water_pump', 'pipe', 'bridge', 'tunnel', 'road',
  'ore_depot', 'material_depot', 'water_tower', 'oil_depot', 'truck', 'earth_pile', 'tractor', 'ore_pile',
  'aa_soldier', 'rocket_launcher', 'underwater_drone', 'mg_turret', 'flak_turret',
  'bridgelayer', 'pontoon', 'spotlight',
];
const ROLE_TABLE = [null, 'ore', 'build', 'earth'];
const PIPE_RESOURCE_TABLE = [null, 'water', 'oil'];
// Flugeinheiten brauchen client-seitig die Domäne, damit Picking (entityToScreen/pickRadius) sie an
// ihrer Flughöhe statt am Boden anvisiert — sonst sind sie mit der Maus nicht anklickbar.
const AIR_KINDS = new Set(['recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air']);

export class Net {
  constructor() {
    this.ws = null;
    this.seat = null;
    this.viewSeat = null;
    this.spectator = false;
    this.init = null;            // Init-Paket (Gelände, Spieler)
    this.prev = null;            // vorheriger Snapshot (Interpolation)
    this.cur = null;            // aktueller Snapshot
    this.snapTime = 0;          // Zeitstempel des aktuellen Snapshots (ms)
    this.players = [];
    this.events = [];           // gesammelte Effekt-Events
    this.jobs = [];             // offene Terraform-Aufträge + Erdhügel-Marker
    this.waterBase = [];        // initial sichtbare Hochseen/Flüsse; Snapshots liefern nur Abweichungen
    this.controls = { speed: 1, timeMode: 'auto', aiOnly: false, insanity: 2 };
    this.games = [];
    this.room = null;
    this.name = 'Spieler';
    this.handlers = {};
    this._pendingWatchSeat = null;
    this._outbox = [];
  }

  on(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); }
  emit(type, d) { const h = this.handlers[type]; if (h) for (const fn of h) fn(d); }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    this.ws.onclose = () => this.emit('disconnect');
    this.ws.onopen = () => {
      const out = this._outbox.splice(0);
      for (const o of out) this.send(o);
      this.emit('connect');
    };
  }

  onMessage(m) {
    switch (m.type) {
      case 'init':
        this.resetStreamState();
        this.init = m;
        this.players = m.players;
        if (this.seat != null && !this.players.some(p => p.id === this.seat)) this.seat = null;
        if (this.viewSeat == null || !this.players.some(p => p.id === this.viewSeat)) this.viewSeat = this.players[0]?.id ?? null;
        this.waterBase = m.terrain.waterDepth || [];
        this.snow = m.terrain.snow || [];
        this.roads = m.terrain.roads || [];
        this.tunnels = m.terrain.tunnels || [];
        this.ground = m.terrain.ground || [];
        if (m.controls) this.controls = m.controls;
        this.applySnap(m.snapshot);
        this.emit('init', m);
        break;
      case 'gameList':
        this.games = Array.isArray(m.games) ? m.games : [];
        this.emit('gameList', this.games);
        break;
      case 'roomInfo':
        this.room = m.room || null;
        this.emit('roomInfo', this.room);
        break;
      case 'snap':
        this.applySnap(m);
        break;
      case 'joined':
        if (!m.ok) { this.emit('joined', m); break; }
        this.seat = m.seat;
        this.spectator = false;
        this.viewSeat = m.seat;
        this.emit('joined', m);
        break;
      case 'spectator':
        this.seat = null;
        this.spectator = true;
        if (this._pendingWatchSeat != null && this.players.some(p => p.id === this._pendingWatchSeat)) this.viewSeat = this._pendingWatchSeat;
        else if (m.seat != null && this.players.some(p => p.id === m.seat)) this.viewSeat = m.seat;
        else if (this.viewSeat == null) this.viewSeat = this.players[0]?.id ?? 0;
        this._pendingWatchSeat = null;
        this.emit('joined', { ...m, spectator: true, seat: null });
        this.emit('viewseat', { seat: this.viewSeat });
        break;
      case 'lobby':
        this.players = this.mergePlayers(m.players || []);
        if (m.room) { this.room = m.room; this.emit('roomInfo', this.room); }
        if (m.controls) { this.controls = m.controls; this.emit('controls', m.controls); }
        this.emit('lobby', m);
        break;
      case 'joinDenied':
        this.emit('joinDenied', m);
        break;
      case 'left':
        this.resetLobbyState();
        this.emit('left', m);
        break;
      case 'saveGame':
        this.emit('saveGame', m);
        break;
      case 'menuError':
        this.emit('menuError', m);
        break;
    }
  }

  resetStreamState() {
    this.prev = null;
    this.cur = null;
    this.events = [];
    this.jobs = [];
    this.water = null;
    this.terra = null;
    this.oil = null;
  }

  mergePlayers(players) {
    const prev = new Map(this.players.map(p => [p.id, p]));
    return players.map(p => {
      const old = prev.get(p.id);
      return old ? { ...old, ...p, res: old.res, cap: old.cap, energy: old.energy } : p;
    });
  }

  applySnap(snap) {
    this.prev = this.cur;
    this.cur = snap;
    this.snapTime = performance.now();
    if (snap.water) this.water = this.mergeWater(snap.water);   // Basis-Binnenwasser + dynamische Flut-/Trockenzellen
    if (snap.oil) this.oil = snap.oil;           // Ölquellen schrumpfen bei Förderung
    if (snap.ore) this.oreDelta = snap.ore;      // Erz-Restmengen (für die Feldanzeige), nur Änderungen
    if (snap.terra) this.terra = snap.terra;   // terraformte Zellen (Höhenänderung durch Bauten/Beben)
    if (snap.env) this.env = snap.env;         // Tageszeit/Wetter/Beben für Licht & Effekte
    if (snap.controls) { this.controls = snap.controls; this.emit('controls', snap.controls); }
    if (snap.snow) this.snow = snap.snow;      // Schneedecke des Zentralbergs (schmilzt/wächst)
    if (snap.roads) this.roads = snap.roads;   // automatisches Straßennetz (nur bei Änderung gesendet)
    if (snap.tunnels) this.tunnels = snap.tunnels; // Tunnel-Strukturen (nur bei Änderung gesendet)
    if (snap.ground) this.ground = snap.ground; // Fahrzeugspuren/Matsch
    if (snap.jobs) this.jobs = snap.jobs;       // offene Terraform-Aufträge + Erdhügel
    if (snap.events && snap.events.length) for (const e of snap.events) this.events.push(e);
    if (snap.players) {
      for (const ps of snap.players) {
        const p = this.players.find(pp => pp.id === ps.id);
        if (p) { p.defeated = ps.defeated; p.controller = ps.controller; p.res = ps.res; p.cap = ps.cap; p.energy = ps.energy; }
      }
    }
  }

  mergeWater(delta) {
    if (!this.waterBase || !this.waterBase.length) return delta;
    const merged = new Map();
    for (let n = 0; n < this.waterBase.length; n += 2) merged.set(this.waterBase[n], this.waterBase[n + 1]);
    for (let n = 0; n < delta.length; n += 2) merged.set(delta[n], delta[n + 1]);
    const out = [];
    for (const [idx, q] of merged) if (q > 0) out.push(idx, q);
    return out;
  }

  // Entity-Listen aus Snapshot in Objektform (mit Interpolation gegen vorherigen Snapshot).
  entities(alpha) {
    if (!this.cur) return [];
    const prevMap = new Map();
    if (this.prev) for (const e of this.prev.ents) prevMap.set(e[0], e);
    const out = [];
    for (const e of this.cur.ents) {
      const isUnit = e[1] === 0;
      const pe = prevMap.get(e[0]);
      let x = e[4], y = e[5], facing = isUnit ? e[8] : 0;
      if (pe) {
        x = pe[4] + (e[4] - pe[4]) * alpha; y = pe[5] + (e[5] - pe[5]) * alpha;
        // Blickrichtung über den kürzesten Bogen interpolieren — sonst „springen" drehende
        // Einheiten zwischen den 10-Hz-Snapshots (sichtbares Ruckeln bei Kurven).
        if (isUnit) {
          let da = e[8] - pe[8];
          if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
          facing = pe[8] + da * alpha;
        }
      }
      out.push({
        id: e[0], etype: isUnit ? 'unit' : 'building', kind: KIND_TABLE[e[2]], owner: e[3],
        domain: isUnit && AIR_KINDS.has(KIND_TABLE[e[2]]) ? 'air' : null,
        x, y, hp: e[6], maxHp: e[7],
        facing, cargo: isUnit ? e[9] : 0, vet: isUnit ? (e[10] || 0) : 0,
        role: isUnit ? (ROLE_TABLE[e[11] || 0] || null) : null,
        working: isUnit ? !!e[12] : false,
        abandoned: isUnit ? !!e[13] : false,
        submerged: isUnit ? !!((e[14] || 0) & 1) : false,
        subExposed: isUnit ? !!((e[14] || 0) & 2) : false,
        inTunnel: isUnit ? !!((e[14] || 0) & 4) : false,
        sonarMask: isUnit ? (e[15] || 0) : 0,
        aim: isUnit ? (e[16] || 0) : (e[14] || 0),   // Geschützturm-Ausrichtung (0 = kein Turm)
        size: isUnit ? 1 : e[8], buildProgress: isUnit ? 1 : e[9] / 100, queue: isUnit ? 0 : e[10],
        powered: isUnit ? true : e[11] !== 0,   // Lastabwurf: Licht aus + Produktion steht
        pile: isUnit ? 0 : (e[12] || 0),
        warn: isUnit ? false : e[13] === 1,     // kann seine Funktion nicht erfüllen → Warndreieck
        // C&C-Baufortschritt: Fortschritt des vorderen Items (0..1) + Warteschlange als Kind-Namen.
        prodFront: isUnit ? 0 : (e[15] || 0) / 100,
        prodKinds: isUnit ? null : (e[16] ? e[16].map(i => KIND_TABLE[i]) : null),
        pipeResource: isUnit ? null : (PIPE_RESOURCE_TABLE[e[17] || 0] || null),
      });
    }
    return out;
  }

  join(name, seat, opts = {}) {
    this.name = name || this.name || 'Spieler';
    this.send({ t: 'join', name: this.name, seat, roomId: opts.roomId, code: opts.code, insanity: opts.insanity });
  }
  createGame(name, opts = {}) {
    this.name = name || this.name || 'Spieler';
    this.send({
      t: 'createGame',
      name: this.name,
      visibility: opts.visibility,
      slots: opts.slots,
      startMode: opts.startMode,
      timeMode: opts.timeMode,
      insanity: opts.insanity,
      spectator: !!opts.spectator,
    });
  }
  joinGame(game, name, opts = {}) {
    const roomId = typeof game === 'string' ? game : game?.id;
    this.join(name, opts.seat ?? null, { ...opts, roomId, code: opts.code });
  }
  requestGameList() { this.send({ t: 'listGames' }); }
  watch(seat = null, name = 'Zuschauer', opts = {}) {
    this.name = name || this.name || 'Zuschauer';
    const viewSeat = seat ?? this.players[0]?.id ?? 0;
    this._pendingWatchSeat = viewSeat;
    if (opts.roomId || opts.code) {
      this.send({ t: 'watch', name: this.name, roomId: opts.roomId, code: opts.code, viewSeat, insanity: opts.insanity });
      return;
    }
    if (opts.insanity != null) this.send({ t: 'matchOptions', insanity: opts.insanity });
    if (this.seat != null) {
      this.send({ t: 'release' });
      return;
    }
    this.spectator = true;
    this.viewSeat = viewSeat;
    this._pendingWatchSeat = null;
    this.emit('joined', { ok: true, seat: null, spectator: true });
  }
  takeoverSeat(seat = this.viewSeat, name = this.name || 'Spieler') {
    if (seat == null) return;
    this.name = name || this.name || 'Spieler';
    this.send({ t: 'takeover', seat, name: this.name });
  }
  releaseSeat() {
    if (this.seat == null || this.spectator) return;
    this.send({ t: 'release' });
  }
  leaveToLobby() {
    if (this.room || this.seat != null || this.spectator) this.send({ t: 'leave' });
    else {
      this.resetLobbyState();
      this.emit('left', { ok: true });
    }
  }
  resetLobbyState() {
    this.seat = null;
    this.viewSeat = null;
    this.spectator = false;
    this.room = null;
    this._pendingWatchSeat = null;
    this.init = null;
    this.players = [];
    this.resetStreamState();
  }
  setViewSeat(seat) {
    if (!this.players.some(p => p.id === seat)) return;
    this.viewSeat = seat;
    this.emit('viewseat', { seat });
  }
  cmd(cmd) { if (!this.spectator && this.seat != null) this.send({ t: 'cmd', cmd }); }
  setSpectatorControls(patch = {}) { if (this.spectator) this.send({ t: 'spectatorControl', ...patch }); }
  newGame(sameMap = false, opts = {}) { this.send({ t: 'newGame', sameMap: !!sameMap, insanity: opts.insanity }); }
  requestSave() { this.send({ t: 'saveGame' }); }
  loadGame(save) { this.send({ t: 'loadGame', save }); }
  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
    else this._outbox.push(o);
  }
}

export { KIND_TABLE };
