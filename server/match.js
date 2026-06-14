// Match-Manager: kapselt eine autoritative Simulation.
// Transport-agnostisch (kein WebSocket-Code hier) → headless testbar.
import { createWorld, step, enqueueCommand, applyCommand } from '../shared/sim.js';
import { serializeInit, serializeSnapshot } from './snapshot.js';
import { TICK_RATE } from '../shared/constants.js';
import { deserializeSavegame, serializeSavegame } from './savegame.js';

const SPECTATOR_SPEEDS = [1, 2, 4, 8];
const TIME_MODES = new Set(['auto', 'day', 'night']);

export class Match {
  constructor({ data, seed = 1, slots = 2, map, factions = ['HLX', 'KBN', 'FLG'] }) {
    this.data = data;
    this.seed = seed;
    this.map = map;
    this.slots = slots;
    this.factions = factions;
    const players = this.makePlayers();
    this.world = createWorld({ data, seed, map, players });
    this.world.controls = { speed: 1, timeMode: 'auto', aiOnly: true };
    this.seats = players.map((p) => ({ id: p.id, occupant: null, disconnectAt: null }));
    this.running = false;
    this.onSnapshot = null;     // (snapshot) => void   (vom Transport gesetzt)
    this.reclaimTicks = TICK_RATE * 30; // 30s bis ein leerer Sitz wieder zur KI wird
  }

  makePlayers() {
    const players = [];
    for (let i = 0; i < this.slots; i++)
      players.push({ id: i, name: `KI-${i + 1}`, faction: this.factions[i % this.factions.length], controller: 'ai' });
    return players;
  }

  reset({ sameMap = false } = {}) {
    const oldSeats = this.seats || [];
    if (!sameMap) this.seed = (Date.now() & 0x7fffffff) || 1;
    const oldPlayers = this.world?.players || [];
    const players = this.makePlayers().map(p => {
      const old = oldPlayers.find(op => op.id === p.id);
      const seat = oldSeats.find(s => s.id === p.id);
      return {
        ...p,
        name: seat?.occupant || old?.name || p.name,
        faction: old?.faction || p.faction,
        controller: seat?.occupant ? 'human' : 'ai',
      };
    });
    this.world = createWorld({ data: this.data, seed: this.seed, map: this.map, players });
    this.world.controls = { speed: 1, timeMode: 'auto', aiOnly: this.aiOnly() };
    this.seats = players.map(p => {
      const old = oldSeats.find(s => s.id === p.id);
      return { id: p.id, occupant: old?.occupant || null, disconnectAt: null };
    });
    this.syncSpectatorControls();
  }

  saveGame() {
    return serializeSavegame(this.world);
  }

  loadGame(save) {
    const oldSeats = this.seats || [];
    this.world = deserializeSavegame(save, this.data);
    this.seed = this.world.seed;
    this.map = this.world.map;
    this.slots = this.world.players.length;
    this.seats = this.world.players.map(p => {
      const old = oldSeats.find(s => s.id === p.id);
      const occupant = old?.occupant || null;
      p.controller = occupant ? 'human' : (p.controller === 'human' ? 'ai' : p.controller);
      if (occupant) p.name = occupant;
      return { id: p.id, occupant, disconnectAt: null };
    });
    this.syncSpectatorControls();
  }

  // Ein Mensch tritt bei: bevorzugt einen KI-Sitz übernehmen (KI-Übernahme).
  joinHuman(name, preferredSeat = null) {
    let seat = null;
    if (preferredSeat != null) seat = this.seats.find(s => s.id === preferredSeat && !s.occupant);
    if (!seat) seat = this.seats.find(s => !s.occupant && this.player(s.id).controller === 'ai' && !this.player(s.id).defeated);
    if (!seat) seat = this.seats.find(s => !s.occupant && !this.player(s.id).defeated);
    if (!seat) return null; // voll
    seat.occupant = name; seat.disconnectAt = null;
    applyCommand(this.world, { type: 'setController', playerId: seat.id, controller: 'human', name }, seat.id);
    this.syncSpectatorControls();
    return seat.id;
  }

  // Zuschauer übernimmt gezielt einen aktuell von der KI gesteuerten, freien Sitz.
  takeoverAi(name, preferredSeat) {
    const seat = this.seats.find(s => s.id === preferredSeat && !s.occupant);
    const player = seat ? this.player(seat.id) : null;
    if (!seat || !player || player.defeated || player.controller !== 'ai') return null;
    seat.occupant = name || 'Spieler';
    seat.disconnectAt = null;
    applyCommand(this.world, { type: 'setController', playerId: seat.id, controller: 'human', name: seat.occupant }, seat.id);
    this.syncSpectatorControls();
    return seat.id;
  }

  // Mensch gibt seinen Sitz sofort wieder an die KI zurück und kann weiter zuschauen.
  releaseHuman(seatId) {
    const seat = this.seats.find(s => s.id === seatId);
    const player = seat ? this.player(seat.id) : null;
    if (!seat || !player || !seat.occupant) return null;
    seat.occupant = null;
    seat.disconnectAt = null;
    applyCommand(this.world, {
      type: 'setController',
      playerId: seat.id,
      controller: 'ai',
      name: `KI-${seat.id + 1}`,
    }, seat.id);
    this.syncSpectatorControls();
    return seat.id;
  }

  // Verbindung verloren: Sitz nicht sofort räumen — KI übernimmt nach Timeout (Reconnect-Fenster).
  markDisconnected(seatId) {
    const seat = this.seats.find(s => s.id === seatId);
    if (seat) seat.disconnectAt = this.world.tick;
  }

  reconnect(seatId, name) {
    const seat = this.seats.find(s => s.id === seatId);
    if (seat && seat.occupant) { seat.disconnectAt = null; this.syncSpectatorControls(); return seatId; }
    return null;
  }

  command(seatId, cmd) {
    const seat = this.seats.find(s => s.id === seatId);
    if (!seat || !seat.occupant) return; // nur besetzte Sitze dürfen befehlen
    enqueueCommand(this.world, cmd, seatId);
  }

  player(id) { return this.world.players.find(p => p.id === id); }

  aiOnly() {
    const active = this.world.players.filter(p => !p.defeated);
    return active.length > 0 && active.every(p => p.controller === 'ai');
  }

  syncSpectatorControls() {
    const controls = this.world.controls || (this.world.controls = {});
    controls.aiOnly = this.aiOnly();
    if (!controls.aiOnly) {
      controls.speed = 1;
      controls.timeMode = 'auto';
    } else {
      controls.speed = normalizeSpeed(controls.speed) || 1;
      if (!TIME_MODES.has(controls.timeMode)) controls.timeMode = 'auto';
    }
    if (this.world.env) this.world.env.timeMode = controls.timeMode;
  }

  setSpectatorControls(patch = {}) {
    this.syncSpectatorControls();
    if (!this.world.controls.aiOnly) return false;
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(patch, 'speed')) {
      const speed = normalizeSpeed(patch.speed);
      if (speed && speed !== this.world.controls.speed) {
        this.world.controls.speed = speed;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'timeMode')) {
      const timeMode = String(patch.timeMode || 'auto');
      if (TIME_MODES.has(timeMode) && timeMode !== this.world.controls.timeMode) {
        this.world.controls.timeMode = timeMode;
        changed = true;
      }
    }
    this.syncSpectatorControls();
    return changed;
  }

  simSpeed() {
    this.syncSpectatorControls();
    return this.world.controls.aiOnly ? this.world.controls.speed : 1;
  }

  controlsView() {
    this.syncSpectatorControls();
    return { ...this.world.controls };
  }

  tick() {
    // Getrennte Spieler nach Timeout wieder der KI übergeben.
    for (const seat of this.seats) {
      if (seat.disconnectAt != null && this.world.tick - seat.disconnectAt > this.reclaimTicks) {
        seat.occupant = null; seat.disconnectAt = null;
        applyCommand(this.world, { type: 'setController', playerId: seat.id, controller: 'ai' }, seat.id);
      }
    }
    this.syncSpectatorControls();
    step(this.world);
  }

  init() { this.syncSpectatorControls(); return serializeInit(this.world); }
  snapshot() { this.syncSpectatorControls(); return serializeSnapshot(this.world); }

  isOver() { return this.world.players.filter(p => !p.defeated).length <= 1; }
}

function normalizeSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return SPECTATOR_SPEEDS.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best), 1);
}
