// Einstiegspunkt des Clients: Module verdrahten, Render-Loop mit Snapshot-Interpolation.
import { Net } from './net.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';
import { TICK_MS } from './config.js';

async function boot() {
  const data = await fetch('/data').then(r => r.json());
  const net = new Net();
  const renderer = new Renderer(document.getElementById('game'));
  const input = new Input(net, renderer, data);
  const ui = new UI(net, input, data);
  const audio = new Audio();
  const rawCmd = net.cmd.bind(net);
  const INFANTRY = new Set(['rifleman', 'at_soldier', 'engineer']);
  net.cmd = (cmd) => {
    if (cmd.type === 'move' || cmd.type === 'attack' || cmd.type === 'load' || cmd.type === 'unload') {
      const ids = new Set(cmd.units || []);
      const moved = ids.size ? net.entities(1).filter(e => ids.has(e.id)) : [];
      // Befehls-Quittung im EIGENEN Klang des kommandierten Einheitentyps (statt eines Einheitssounds).
      const prim = moved[0];
      const pdef = prim ? data.units[prim.kind] : null;
      if (prim) audio.unitAck(prim.kind, pdef?.category, pdef?.domain, 1); else audio.command(1);
      if (cmd.type === 'move') {
        // Motorengeräusch nur, wenn tatsächlich Fahrzeuge losfahren — Infanterie macht Schritte.
        if (moved.some(e => !INFANTRY.has(e.kind))) audio.motor(0.8);
        else if (moved.length) audio.steps(0.8);
      }
    }
    if (cmd.type === 'build' || cmd.type === 'terraform') audio.build(0.7);
    rawCmd(cmd);
  };

  const applyFogOption = (fallback = false) => {
    const box = document.getElementById('fowstart');
    renderer.setFogOfWar(box ? !!box.checked : !!fallback, data);
  };

  ui.setupLobby((name, seat, opts = {}) => {
    applyFogOption(!!opts.fow);
    if (opts.spectator) net.watch(seat, name);
    else net.join(name, seat);
  });
  ui.setupMenu(renderer, audio);

  // WebAudio erst nach erstem Nutzer-Gesture entsperren (Browser-Autoplay-Richtlinie).
  const unlock = () => audio.resume();
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  // Debug-Handle für automatisierte Browser-Verifikation (preview MCP); kein Spiel-Logik-Effekt.
  if (typeof window !== 'undefined') window.__if = { net, renderer, input, ui, audio };

  net.on('init', (m) => {
    renderer.resetWorld();
    renderer.buildTerrain(m);
    ui.renderBuildbar();
  });
  net.on('joined', () => {
    applyFogOption();
    input.selected.clear();
    input.onSelectionChange && input.onSelectionChange();
    ui.renderBuildbar();
    ui.renderSpectatorbar();
  });
  net.on('viewseat', () => { ui.renderTop(); ui.renderSpectatorbar(); input.selected.clear(); input.onSelectionChange && input.onSelectionChange(); });

  net.connect();

  // Render-Loop (entkoppelt vom 10-Hz-Simulationstakt)
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    // Interpolationsfaktor zwischen den letzten beiden Snapshots
    const alpha = Math.max(0, Math.min(1, (now - net.snapTime) / TICK_MS));
    const ents = net.entities(alpha);

    input.updateCamera(dt);
    renderer.updateEnvironment(net.env, dt);  // Tag/Nacht-Licht, Wetterpartikel, Beben-Shake
    renderer.updateCamera();
    const perspectiveSeat = net.viewSeat ?? net.seat;
    renderer.updateFogOfWar(ents, perspectiveSeat, data, net.env);
    renderer.sync(ents, net.players, input.selected, perspectiveSeat, net.events);
    audio.beginFrame();
    renderer.processEvents(net.events, audio, perspectiveSeat);
    audio.updateMusic(dt, net.env);
    renderer.musicBeat = audio.musicBeat();
    renderer.animateWater(dt);   // Wasser fließt in kleinen Schritten zur Snapshot-Zieltiefe (kein Staccato)
    renderer.updateEffects(dt);
    renderer.render();

    drawDragBox(input.drag);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // UI-Aktualisierung (seltener als Render → günstig)
  setInterval(() => {
    ui.renderTop();
    ui.renderSpectatorbar();
    ui.renderMinimap(renderer);
    ui.checkWarnings();
    ui.updateBuildProgress();   // C&C-Baufortschritt/Auftragszahl im Baumenü (ohne Neu-Render)
    audio.setWeather(net.env ? net.env.w : 'clear'); // Regen-Ambiente an Wetterlage koppeln
    renderer.updateWater(net.water);   // dynamische Flutflächen aktualisieren
    renderer.updateTerraform(net.terra); // terraformte Geländehöhen übernehmen
    renderer.updateSnow(net.snow);     // Schneedecke (schmilzt bei Sonne, wächst bei Schneefall)
    renderer.updateOil(net.oil);       // Öl-Sickerflecken schrumpfen bei Förderung
    renderer.updateOre(net.oreDelta);  // Erz-Restmengen für die Feldanzeige aktualisieren
    renderer.updateRoads(net.roads);   // automatisches Straßennetz
    renderer.updateTunnels(net.tunnels); // Tunnelröhren (durchgehend)
    renderer.updateGroundWear(net.ground); // Fahrzeugspuren, Pfützenrillen, Matsch
    renderer.updateConstructionJobs(net.jobs);
    // tote/ausgewählte Einheiten bereinigen
    const live = new Set(net.entities(1).map(e => e.id));
    for (const id of [...input.selected]) if (!live.has(id)) input.selected.delete(id);
  }, renderer.perf?.uiInterval ?? 250);

  // Auswahlrahmen als Overlay
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', border: '1px solid #6cff9a', background: '#6cff9a22', pointerEvents: 'none', zIndex: 30, display: 'none' });
  document.body.appendChild(box);
  function drawDragBox(d) {
    if (!d) { box.style.display = 'none'; return; }
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    Object.assign(box.style, { display: 'block', left: x + 'px', top: y + 'px', width: Math.abs(d.x1 - d.x0) + 'px', height: Math.abs(d.y1 - d.y0) + 'px' });
  }
}

boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:40px;left:10px;z-index:99">${e.stack || e}</pre>`); });
