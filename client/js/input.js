// Eingabe: Auswahlrahmen, Einheitenbefehle, Kamerasteuerung, Bauplatzierung, Hotkeys.
import { CAMERA_TILT_MAX, CAMERA_TILT_MIN } from './renderer.js';

const TILE = 2;
const CLIENT_WET_DEPTH = 0.035;
const CLIENT_NAVIGABLE_DEPTH = 0.12;
const CLIENT_SEA_LEVEL = 0.28;   // spiegelt SEA_LEVEL (constants.js) — Süßwasser-Erkennung fürs Pumpwerk
const TRANSPORT_KINDS = new Set(['transport_air', 'amphib_transport']);
const TRANSPORT_CAP = 6;
const PILE_KINDS = new Set(['earth_pile', 'ore_pile']);
const TERRA_STROKE_RADIUS = 1.12;
// Linien-Bau: diese Gebäude (und Terraform-Aufträge) zieht man per Start→Endpunkt auf.
const LINE_KINDS = new Set(['wall', 'trench', 'road', 'pipe', 'dam', 'tunnel', 'bridge']);
const DOUBLE_CLICK_MS = 320;     // Doppelklick-Fenster: alle sichtbaren Einheiten desselben Typs wählen

export class Input {
  constructor(net, renderer, data = null) {
    this.net = net; this.renderer = renderer; this.data = data;
    this.selected = new Set();
    this.groups = {};            // Kontrollgruppen 1-9
    this.buildMode = null;       // aktiver Bau-Kind oder null
    this.drag = null;            // {x0,y0,x1,y1}
    this.keys = new Set();
    this.onSelectionChange = null;
    this.onBuildPlaced = null;
    this.bind();
  }

  canControl() { return !this.net.spectator && this.net.seat != null; }
  canSelect() { return this.canControl() || this.net.spectator; }
  myEntities() { return this.canControl() ? this.net.entities(1).filter(e => e.owner === this.net.seat) : []; }
  allEntities() { return this.net.entities(1); }
  selectableEntities() {
    if (this.canControl()) return this.myEntities();
    if (!this.net.spectator) return [];
    const seat = this.net.viewSeat;
    return this.allEntities().filter(e => !(this.renderer.isHiddenEntity?.(e, seat) ?? this.renderer.isHiddenByFog?.(e, seat)));
  }

  entityScreen(e) {
    return this.renderer.entityToScreen?.(e) ?? this.renderer.worldToScreen(e.x, e.y);
  }

  pickRadiusSq(e, base) {
    const r = e?.domain === 'air' ? Math.max(base, 42) : base;
    return r * r;
  }

  bind() {
    const el = this.renderer.renderer.domElement;
    el.addEventListener('contextmenu', e => e.preventDefault());

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        if (this.buildMode) {
          if (!this.canControl()) { this.cancelBuild(); return; }
          // Linienfähige Bauten/Terraforming: erster Klick = Start, zweiter Klick = Ende.
          if (this.isLineMode()) {
            const g = this.renderer.groundPoint(e.clientX, e.clientY);
            if (!g) return;
            const tx = Math.floor(g.x / TILE), ty = Math.floor(g.z / TILE);
            if (!this.lineDrag) {
              this.lineDrag = { sx: tx, sy: ty, ex: tx, ey: ty };
              this.updateLinePreview();
            } else {
              this.lineDrag.ex = tx; this.lineDrag.ey = ty;
              this.finishLine();
            }
            return;
          }
          this.placeBuild(e.clientX, e.clientY); return;
        }
        if (!this.canSelect()) return;
        this.drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, additive: e.shiftKey };
      } else if (e.button === 2) {
        // Rechte Taste: gedrückt-ziehen = Karte verschieben (Pan); kurzer Klick = Befehl/Bau abbrechen.
        // Entscheidung erst beim Loslassen (movedThreshold), damit Befehle weiter funktionieren.
        this.rpan = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, shift: e.shiftKey, special: e.ctrlKey || e.metaKey };
      }
    });
    addEventListener('mousemove', (e) => {
      if (this.lineDrag) {
        const g = this.renderer.groundPoint(e.clientX, e.clientY);
        if (g) {
          this.lineDrag.ex = Math.floor(g.x / TILE); this.lineDrag.ey = Math.floor(g.z / TILE);
          this.updateLinePreview();
        }
      } else if (this.buildMode && !this.isLineMode()) {
        this.updateBuildGhost(e.clientX, e.clientY);
      }
      if (this.drag) { this.drag.x1 = e.clientX; this.drag.y1 = e.clientY; }
      if (this.rpan) {
        const dx = e.clientX - this.rpan.lx, dy = e.clientY - this.rpan.ly;
        this.rpan.lx = e.clientX; this.rpan.ly = e.clientY;
        if (!this.rpan.moved && Math.hypot(e.clientX - this.rpan.sx, e.clientY - this.rpan.sy) > 5) this.rpan.moved = true;
        if (this.rpan.moved) {
          // Karte unter dem Cursor „greifen": Kamera entgegen der Mausbewegung verschieben.
          const s = this.renderer.camDist * 0.0017;
          this.renderer.camTarget.x -= dx * s;
          this.renderer.camTarget.z -= dy * s;
        }
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.drag) { this.finishDrag(); this.drag = null; }
      else if (e.button === 2 && this.rpan) {
        if (!this.rpan.moved) {  // reiner Klick → Befehl bzw. Bau-Abbruch
          if (!this.canControl()) { /* Zuschauer: Rechtsklick ohne Befehl. */ }
          else if (this.buildMode) { this.cancelBuild(); }
          else this.issueCommand(this.rpan.sx, this.rpan.sy, this.rpan.shift, this.rpan.special || e.ctrlKey || e.metaKey);
        }
        this.rpan = null;
      }
    });
    // Doppelklick auf eine Einheit: alle sichtbaren Einheiten desselben Typs (gleicher Besitzer) wählen.
    el.addEventListener('dblclick', (e) => {
      if (e.button !== 0 || this.buildMode || !this.canSelect()) return;
      this.selectSameType(e.clientX, e.clientY, e.shiftKey);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        const next = this.renderer.camAngle + Math.sign(e.deltaY) * 0.06;
        this.renderer.camAngle = Math.max(CAMERA_TILT_MIN, Math.min(CAMERA_TILT_MAX, next));
      } else {
        this.renderer.camDist = Math.max(25, Math.min(380, this.renderer.camDist + Math.sign(e.deltaY) * 10));
      }
    }, { passive: false });

    addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (e.key === 'Escape') { this.cancelBuild(); }
      if (this.canControl() && e.key >= '1' && e.key <= '9') this.handleGroup(e.key, e.ctrlKey || e.metaKey);
      if (this.canControl() && e.key.toLowerCase() === 's') this.stopSelected();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  // Kamera-Pan pro Frame (WASD / Pfeile / Bildschirmrand).
  updateCamera(dt) {
    const k = this.keys, spd = this.renderer.camDist * 0.9 * dt;
    let dx = 0, dz = 0;
    if (k.has('a') || k.has('arrowleft')) dx -= 1;
    if (k.has('d') || k.has('arrowright')) dx += 1;
    if (k.has('w') || k.has('arrowup')) dz -= 1;
    if (k.has('s') || k.has('arrowdown')) dz += 0; // 's' ist Stop; Pan nur per Pfeil
    if (k.has('arrowdown')) dz += 1;
    this.renderer.camTarget.x += dx * spd;
    this.renderer.camTarget.z += dz * spd;
    // Kamera auf die Karte begrenzen — verhindert Blick ins Leere jenseits des Randes.
    const r = this.renderer;
    if (r.mapW) {
      r.camTarget.x = Math.max(4, Math.min(r.mapW * TILE - 4, r.camTarget.x));
      r.camTarget.z = Math.max(4, Math.min(r.mapH * TILE - 4, r.camTarget.z));
    }
  }

  finishDrag() {
    if (!this.canSelect()) return;
    const d = this.drag;
    const minx = Math.min(d.x0, d.x1), maxx = Math.max(d.x0, d.x1);
    const miny = Math.min(d.y0, d.y1), maxy = Math.max(d.y0, d.y1);
    if (!d.additive) this.selected.clear();
    const box = (maxx - minx) > 6 || (maxy - miny) > 6;
    let picked = [];
    const candidates = this.selectableEntities();
    for (const e of candidates) {
      if (this.canControl() && e.etype !== 'unit') continue;
      const s = this.entityScreen(e);
      if (s.behind) continue;
      if (box) { if (s.x >= minx && s.x <= maxx && s.y >= miny && s.y <= maxy) picked.push(e.id); }
    }
    if (!box) {
      // Einzelklick: Spieler wählen erst eigene Einheiten, dann Gebäude; Zuschauer können alles Sichtbare inspizieren.
      let best = null, bestD = Infinity, bestBuilding = null, bestBuildingD = Infinity;
      for (const e of candidates) {
        const s = this.entityScreen(e); if (s.behind) continue;
        const dd = (s.x - d.x1) ** 2 + (s.y - d.y1) ** 2;
        if (e.etype === 'unit' && dd <= this.pickRadiusSq(e, 30) && dd < bestD) { bestD = dd; best = e.id; }
        else if (e.etype === 'building' && dd <= this.pickRadiusSq(e, 34) && dd < bestBuildingD) { bestBuildingD = dd; bestBuilding = e.id; }
      }
      if (best == null) best = bestBuilding;
      if (best != null) picked.push(best);
      // Leeres Feld angeklickt: Öl-/Erzvorkommen darunter zur Anzeige merken (sonst löschen).
      if (best == null) {
        const g = this.renderer.groundPoint(d.x1, d.y1);
        this.fieldInfo = g ? this.renderer.resourceAt(g.x, g.z) : null;
      } else this.fieldInfo = null;
    }
    for (const id of picked) this.selected.add(id);
    if (picked.length) this.fieldInfo = null;
    this.onSelectionChange && this.onSelectionChange();
  }

  // Doppelklick: die angeklickte Einheit bestimmen und ALLE aktuell sichtbaren Einheiten desselben
  // Typs (kind) und Besitzers in die Auswahl aufnehmen (Standard-RTS-Verhalten).
  selectSameType(cx, cy, additive = false) {
    const candidates = this.selectableEntities();
    const onScreen = (s) => !s.behind && s.x >= 0 && s.y >= 0 && s.x <= innerWidth && s.y <= innerHeight;
    let best = null, bestD = Infinity;
    for (const e of candidates) {
      if (e.etype !== 'unit') continue;
      const s = this.entityScreen(e);
      if (!onScreen(s)) continue;
      const dd = (s.x - cx) ** 2 + (s.y - cy) ** 2;
      if (dd <= this.pickRadiusSq(e, 32) && dd < bestD) { bestD = dd; best = e; }
    }
    if (!best) return;
    if (!additive) this.selected.clear();
    for (const e of candidates) {
      if (e.etype !== 'unit' || e.kind !== best.kind || e.owner !== best.owner) continue;
      const s = this.entityScreen(e);
      if (onScreen(s)) this.selected.add(e.id);
    }
    this.onSelectionChange && this.onSelectionChange();
  }

  issueCommand(cx, cy, shift, special = false) {
    if (!this.canControl()) return;
    if (!this.selected.size) return;
    const byId = new Map(this.allEntities().map(e => [e.id, e]));
    const selectedSites = [...this.selected].map(id => byId.get(id)).filter(e => e && e.etype === 'building' && e.owner === this.net.seat && e.pile);
    if (selectedSites.length) {
      const g = this.renderer.groundPoint(cx, cy);
      if (g) this.net.cmd({ type: 'setPile', site: selectedSites[0].id, tx: Math.floor(g.x / TILE), ty: Math.floor(g.z / TILE) });
      return;
    }
    // Entität unter Cursor (verlassen = Bergen, Feind = Angriff/Ziel, eigener Transporter =
    // Einsteigen, eigene Baustelle/Erdhaufen = Bagger/LKW zuweisen).
    let target = null, towTarget = null, friendlyTransport = null, assistTarget = null;
    let bestD = Infinity, bestTow = Infinity, bestF = Infinity, bestA = Infinity;
    for (const e of this.allEntities()) {
      const s = this.entityScreen(e); if (s.behind) continue;
      const dd = (s.x - cx) ** 2 + (s.y - cy) ** 2;
      if (e.abandoned && dd <= this.pickRadiusSq(e, 30) && dd < bestTow) { bestTow = dd; towTarget = e; continue; }
      if (e.owner !== this.net.seat) {
        if ((this.renderer.isHiddenEntity?.(e, this.net.seat) ?? this.renderer.isHiddenByFog?.(e, this.net.seat))) continue;
        if (dd <= this.pickRadiusSq(e, 28) && dd < bestD) { bestD = dd; target = e; }
      }
      else if (e.etype === 'unit' && TRANSPORT_KINDS.has(e.kind) && dd <= this.pickRadiusSq(e, 28) && dd < bestF) { bestF = dd; friendlyTransport = e; }
      else if (e.etype === 'building' && (e.buildProgress < 1 || PILE_KINDS.has(e.kind)) && dd <= this.pickRadiusSq(e, 30) && dd < bestA) { bestA = dd; assistTarget = e; }
    }
    const sel = [...this.selected].filter(id => {
      const e = byId.get(id);
      return e && e.etype === 'unit';
    });
    if (!sel.length) return;
    const g = this.renderer.groundPoint(cx, cy);
    if (special && g) {
      const seeders = sel.filter(id => byId.get(id)?.kind === 'cloud_seeder');
      if (seeders.length) { this.net.cmd({ type: 'seedCloud', units: seeders, x: g.x, y: g.z }); return; }
    }
    if (towTarget) {
      const tractors = sel.filter(id => byId.get(id)?.kind === 'tractor');
      if (tractors.length) { this.net.cmd({ type: 'tow', units: tractors, targetId: towTarget.id }); return; }
    }
    // Rechtsklick auf eigenen, nicht vollen Transporter → ausgewählte Einheiten steigen ein.
    if (friendlyTransport && (friendlyTransport.cargo || 0) < TRANSPORT_CAP) {
      const passengers = sel.filter(id => id !== friendlyTransport.id);
      if (passengers.length) { this.net.cmd({ type: 'load', transport: friendlyTransport.id, units: passengers }); return; }
    }
    if (target) { this.net.cmd({ type: 'attack', units: sel, targetId: target.id }); return; }
    // Bagger baut Baustellen; LKW fährt Erde vom Erdhügel ab.
    if (assistTarget) {
      const helpers = sel.filter(id => {
        const e = byId.get(id);
        if (!e) return false;
        return PILE_KINDS.has(assistTarget.kind) ? (e.kind === 'truck' || e.kind === 'harvester') : e.kind === 'builder';
      });
      if (helpers.length) { this.net.cmd({ type: 'assist', units: helpers, target: assistTarget.id }); return; }
    }
    if (!g) return;
    // Klick nahe einem geplanten Terraform-Auftrag (blaue Markierung) → Bagger übernimmt ihn.
    const tx = Math.floor(g.x / TILE), ty = Math.floor(g.z / TILE);
    if (this.net.jobs && this.net.jobs.length) {
      const nearJob = this.net.jobs.some(j => j[1] === this.net.seat && (j[2] - tx) ** 2 + (j[3] - ty) ** 2 <= 9);
      if (nearJob) {
        const diggers = sel.filter(id => byId.get(id)?.kind === 'builder');
        if (diggers.length) { this.net.cmd({ type: 'assist', units: diggers, tx, ty }); return; }
      }
    }
    // Beladene Transporter in der Auswahl laden am Zielpunkt aus; übrige Einheiten ziehen normal dorthin.
    const loaded = sel.filter(id => { const e = byId.get(id); return e && TRANSPORT_KINDS.has(e.kind) && (e.cargo || 0) > 0; });
    for (const id of loaded) this.net.cmd({ type: 'unload', transport: id, x: g.x, y: g.z });
    const movers = sel.filter(id => !loaded.includes(id));
    if (movers.length) {
      this.net.cmd({ type: 'move', units: movers, x: g.x, y: g.z, attackMove: shift });
      this.renderer.spawnMoveMarker?.(g.x, g.z);
    }
  }

  isLineMode() {
    return !!this.buildMode && (LINE_KINDS.has(this.buildMode) || this.buildMode.startsWith('_terra_') || this.buildMode === '_canal_' || this.buildMode === '_pontoon_');
  }

  isTerraformMode() {
    return !!this.buildMode && this.buildMode.startsWith('_terra_');
  }

  terraformDir() {
    return this.buildMode?.endsWith('up') ? 1 : -1;
  }

  updateLinePreview() {
    if (this.isTerraformMode()) {
      this.renderer.hideBuildLine();
      this.renderer.showTerraformPreview?.(this.lineCells(), this.terraformDir());
    } else {
      this.renderer.hideTerraformPreview?.();
      this.renderer.showBuildLine(this.lineCells());
    }
  }

  updateBuildGhost(cx, cy) {
    const g = this.renderer.groundPoint(cx, cy);
    if (!g) { this.renderer.hideBuildGhost(); return; }
    const tx = Math.floor(g.x / TILE), ty = Math.floor(g.z / TILE);
    const size = this.data?.buildings?.[this.buildMode]?.size || 1;
    this.updateBuildRangeOverlay();
    const valid = !this.buildBlockedByWater(this.buildMode, tx, ty, size)
      && !this.buildOutsideRange(this.buildMode, tx, ty, size);
    this.renderer.showBuildGhost(tx, ty, size, valid);
  }

  // Erlaubte Bauzonen (Tile-Koordinaten, r in Tiles) für ein eingeschränkt platzierbares Gebäude.
  // null = überall erlaubt (remoteBuild: Pumpwerk, Bohrturm, Pipeline, Straße …). Spiegelt die
  // Server-Regeln aus sim.js (inBuildRadius) bzw. world.js (hasNearbyBuildingAnchor) wider.
  buildAllowedCenters(kind) {
    const def = this.data?.buildings?.[kind];
    if (!def || def.remoteBuild) return null;
    const ANCHOR_ROLES = new Set(['logistics', 'defense', 'production']);
    const anchored = ANCHOR_ROLES.has(def.role) || def.resourceDepot;
    const out = [];
    for (const e of this.myEntities()) {
      if (e.etype !== 'building' || (e.buildProgress ?? 1) < 1 || e.dead) continue;
      const ed = this.data.buildings[e.kind] || {};
      if (anchored) {
        if (['terrain', 'infrastructure', 'fortification', 'hydro'].includes(ed.role)) continue;
        if (ed.pipe || ed.bridges || ed.tunnels || ed.roadBuilt) continue;
        out.push({ x: e.x, z: e.y, r: 7 + (e.size || 1) });   // BUILD_ANCHOR_RANGE = 7 Tiles
      } else {
        const r = (ed.buildRadius || 0) + (e.size || 1);
        if (r > 0) out.push({ x: e.x, z: e.y, r });
      }
    }
    return out;
  }

  buildOutsideRange(kind, tx, ty, size = 1) {
    if (this.isLineMode()) return false;
    const centers = this.buildAllowedCenters(kind);
    if (!centers) return false;                 // überall erlaubt
    if (!centers.length) return true;           // nichts zum Anknüpfen → nirgends erlaubt
    const cwx = (tx + size / 2) * TILE, cwz = (ty + size / 2) * TILE;
    return !centers.some(c => Math.hypot(cwx - c.x, cwz - c.z) <= c.r * TILE);
  }

  updateBuildRangeOverlay() {
    if (!this.buildMode || this.isLineMode()) { this.renderer.hideBuildRange?.(); return; }
    const centers = this.buildAllowedCenters(this.buildMode);
    if (!centers || !centers.length) { this.renderer.hideBuildRange?.(); return; }
    this.renderer.showBuildRange(centers.map(c => ({ x: c.x, z: c.z, r: c.r * TILE })));
  }

  buildBlockedByWater(kind, tx, ty, size = 1) {
    const def = this.data?.buildings?.[kind];
    const r = this.renderer;
    if (!r.mapW || !r.mapH) return false;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = tx + x, ny = ty + y;
      if (nx < 0 || ny < 0 || nx >= r.mapW || ny >= r.mapH) return true;
      const i = ny * r.mapW + nx;
      const depth = r.waterDepth?.[i] || 0;
      const wet = r.terrainType?.[i] === 3 || depth > CLIENT_WET_DEPTH;
      const realWater = depth >= CLIENT_NAVIGABLE_DEPTH;
      const waterOptional = def?.waterOptional;     // Pipeline/Straße: Land ODER Wasser
      if (def?.bridges) { if (!wet) return true; continue; } // Brücke nur übers Wasser (jede Tiefe)
      if (def?.buildOnWater && !realWater) return true;
      if (def?.mustStandInWater && !realWater) return true;
      // Pumpwerk nur in Süßwasser: Bett über Meeresspiegel (Fluss/See), kein Meer.
      if (def?.freshWater && !(realWater && (r.height?.[i] || 0) > CLIENT_SEA_LEVEL + 0.03)) return true;
      if (!def?.buildOnWater && !waterOptional && wet) return true;
    }
    // Pumpwerk (Süßwasser-Bau im Wasser): nur dort erlaubt, wo der BAGGER hinkommt — d. h. der Footprint
    // muss an mindestens eine bagger-zugängliche Zelle grenzen (Land oder watbares Flachwasser, keine
    // Klippe). Sonst stünde das Pumpwerk mitten im tiefen See, unerreichbar für den Bau.
    if (def?.freshWater && !this._builderCanReachFootprint(tx, ty, size)) return true;
    return false;
  }

  // Grenzt der (Wasser-)Footprint an eine Zelle, auf der ein Bagger stehen/waten kann?
  _builderCanReachFootprint(tx, ty, size) {
    const r = this.renderer;
    for (let y = -1; y <= size; y++) for (let x = -1; x <= size; x++) {
      if (x >= 0 && x < size && y >= 0 && y < size) continue;     // nur der Rand zählt
      const nx = tx + x, ny = ty + y;
      if (nx < 0 || ny < 0 || nx >= r.mapW || ny >= r.mapH) continue;
      const i = ny * r.mapW + nx;
      const depth = r.waterDepth?.[i] || 0;
      const cliff = r.terrainType?.[i] === 2;
      if (!cliff && depth < CLIENT_NAVIGABLE_DEPTH) return true;   // Land oder watbares Flachwasser
    }
    return false;
  }

  cancelBuild() {
    this.buildMode = null; this.lineDrag = null;
    this.renderer.hideBuildLine(); this.renderer.hideBuildGhost(); this.renderer.hideTerraformPreview?.();
    this.renderer.hideBuildRange?.();
    this.onBuildPlaced && this.onBuildPlaced();
  }

  // Tile-Zellen der gezogenen Linie (Schrittweite = Gebäudegröße, Damm = 2).
  lineCells() {
    if (this.isTerraformMode()) return this.terraformCells();
    const d = this.lineDrag;
    if (!d) return [];
    const ex = d.ex ?? d.sx, ey = d.ey ?? d.sy;
    // Pipeline: nicht stur die Gerade, sondern den BESTEN Weg über bebaubares, bagger-erreichbares
    // Gelände vorschlagen (umgeht Klippen/tiefes Wasser). Fällt auf die Gerade zurück, wenn kein Weg.
    if (this.buildMode === 'pipe') {
      const route = this.routePipeCells(d.sx, d.sy, ex, ey);
      if (route && route.length) return route;
    }
    const stepSz = this.buildMode === 'dam' ? 2 : 1;
    const n = Math.max(Math.abs(ex - d.sx), Math.abs(ey - d.sy));
    const cells = [];
    let last = null;
    for (let k = 0; k <= n; k += stepSz) {
      const tx = Math.round(d.sx + (ex - d.sx) * (n ? k / n : 0));
      const ty = Math.round(d.sy + (ey - d.sy) * (n ? k / n : 0));
      if (last && last[0] === tx && last[1] === ty) continue;
      cells.push([tx, ty]); last = [tx, ty];
    }
    return cells;
  }

  // Bester Pipeline-Weg (A*, 8-Richtungen) über bagger-erreichbares Gelände: keine Klippen, kein tiefes
  // Wasser; sanftere Hänge werden bevorzugt. Liefert die Zell-Liste Start→Ende oder null (kein Weg).
  routePipeCells(sx, sy, ex, ey) {
    const r = this.renderer; const W = r.mapW, H = r.mapH;
    if (!W || !H) return null;
    const passable = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const i = y * W + x;
      if (r.terrainType?.[i] === 2) return false;                      // Klippe
      if ((r.waterDepth?.[i] || 0) >= CLIENT_NAVIGABLE_DEPTH) return false; // tiefes Wasser (nicht bagger-erreichbar)
      return true;
    };
    if (!passable(sx, sy) || !passable(ex, ey)) return null;
    const N = W * H, gScore = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
    const heightAt = (i) => r.height?.[i] || 0;
    const heap = [];                                                   // [f, idx] Min-Heap
    const push = (f, idx) => { heap.push([f, idx]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let s = c, l = 2 * c + 1, ri = 2 * c + 2; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (ri < heap.length && heap[ri][0] < heap[s][0]) s = ri; if (s === c) break; [heap[s], heap[c]] = [heap[c], heap[s]]; c = s; } } return top; };
    const start = sy * W + sx, goal = ey * W + ex;
    const hEst = (i) => { const x = i % W, y = (i / W) | 0; return Math.hypot(x - ex, y - ey); };
    gScore[start] = 0; push(hEst(start), start);
    const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let iter = 0;
    while (heap.length && iter++ < 40000) {
      const cur = pop()[1];
      if (cur === goal) break;
      const cx = cur % W, cy = (cur / W) | 0, cg = gScore[cur];
      for (const [dx, dy] of N8) {
        const nx = cx + dx, ny = cy + dy;
        if (!passable(nx, ny)) continue;
        if (dx && dy && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue; // keine Eck-Diagonale
        const ni = ny * W + nx;
        const step = (dx && dy ? 1.414 : 1) + Math.abs(heightAt(ni) - heightAt(cur)) * 6; // Steigung leicht meiden
        const ng = cg + step;
        if (ng < gScore[ni]) { gScore[ni] = ng; came[ni] = cur; push(ng + hEst(ni), ni); }
      }
    }
    if (came[goal] < 0 && goal !== start) return null;
    const cells = []; let c = goal;
    while (c >= 0) { cells.push([c % W, (c / W) | 0]); if (c === start) break; c = came[c]; }
    cells.reverse();
    return cells;
  }

  terraformCells() {
    const d = this.lineDrag;
    if (!d) return [];
    return this.terraformStrokeCells(d.sx, d.sy, d.ex ?? d.sx, d.ey ?? d.sy);
  }

  terraformStrokeCells(sx, sy, ex, ey) {
    const vx = ex - sx, vy = ey - sy;
    const len2 = vx * vx + vy * vy;
    const minX = Math.floor(Math.min(sx, ex) - TERRA_STROKE_RADIUS - 1);
    const maxX = Math.ceil(Math.max(sx, ex) + TERRA_STROKE_RADIUS + 1);
    const minY = Math.floor(Math.min(sy, ey) - TERRA_STROKE_RADIUS - 1);
    const maxY = Math.ceil(Math.max(sy, ey) + TERRA_STROKE_RADIUS + 1);
    const out = [];
    const mapW = this.renderer.mapW || Infinity, mapH = this.renderer.mapH || Infinity;
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) continue;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((tx - sx) * vx + (ty - sy) * vy) / len2)) : 0;
      const px = sx + vx * t, py = sy + vy * t;
      const dist = Math.hypot(tx - px, ty - py);
      if (dist <= TERRA_STROKE_RADIUS) out.push({ tx, ty, t, dist });
    }
    out.sort((a, b) => a.t - b.t || a.dist - b.dist || a.ty - b.ty || a.tx - b.tx);
    return out.map(c => [c.tx, c.ty]);
  }

  // Linie abschließen: für jede Zelle einen Bau-/Terraform-Befehl senden.
  // Segmente mit buildRadius verketten sich selbst (jedes platzierte erweitert die Reichweite).
  finishLine() {
    if (!this.canControl()) return;
    const d = this.lineDrag;
    const cells = this.lineCells();
    this.renderer.hideBuildLine();
    this.renderer.hideBuildGhost();
    this.renderer.hideTerraformPreview?.();
    this.lineDrag = null;
    // Kanal: ausgewählte Wasserbau-Schiffe graben entlang Start→Ende einen schiffbaren Kanal.
    if (this.buildMode === '_canal_') {
      if (d) {
        const ex = d.ex ?? d.sx, ey = d.ey ?? d.sy;
        const units = [...this.selected];
        if (units.length) this.net.cmd({ type: 'canal', units, sx: d.sx, sy: d.sy, ex, ey });
      }
      if (!this.keys.has('shift')) { this.buildMode = null; this.onBuildPlaced && this.onBuildPlaced(); }
      return;
    }
    // Ponton verlegen: der Brückenleger baut entlang der Linie Pontonbrücken-Zellen übers Wasser.
    if (this.buildMode === '_pontoon_') {
      for (const [tx, ty] of cells) {
        if (!this.buildBlockedByWater('pontoon', tx, ty, 1)) this.net.cmd({ type: 'build', building: 'pontoon', tx, ty });
      }
      if (!this.keys.has('shift')) { this.buildMode = null; this.onBuildPlaced && this.onBuildPlaced(); }
      return;
    }
    if (!cells.length) return;
    const terra = this.buildMode.startsWith('_terra_');
    for (const [tx, ty] of cells) {
      if (terra) this.net.cmd({ type: 'terraform', tx, ty, dir: this.buildMode.endsWith('up') ? 1 : -1 });
      else if (!this.buildBlockedByWater(this.buildMode, tx, ty, this.data?.buildings?.[this.buildMode]?.size || 1)) {
        this.net.cmd({ type: 'build', building: this.buildMode, tx, ty });
      }
    }
    if (!this.keys.has('shift')) { this.buildMode = null; this.onBuildPlaced && this.onBuildPlaced(); }
  }

  placeBuild(cx, cy) {
    if (!this.canControl()) return;
    const g = this.renderer.groundPoint(cx, cy);
    if (!g) return;
    const tx = Math.floor(g.x / TILE), ty = Math.floor(g.z / TILE);
    // Terraforming-Modus: Aufschütt-/Abgrab-Auftrag — ein freier Bagger übernimmt.
    if (this.buildMode && this.buildMode.startsWith('_terra_')) {
      const dir = this.buildMode.endsWith('up') ? 1 : -1;
      for (const [cx, cy] of this.terraformStrokeCells(tx, ty, tx, ty)) this.net.cmd({ type: 'terraform', tx: cx, ty: cy, dir });
      if (!this.keys.has('shift')) this.cancelBuild();
      return;
    }
    const size = this.data?.buildings?.[this.buildMode]?.size || 1;
    if (this.buildBlockedByWater(this.buildMode, tx, ty, size)) return;
    this.net.cmd({ type: 'build', building: this.buildMode, tx, ty });
    if (!this.keys.has('shift')) this.cancelBuild();
  }

  stopSelected() {
    if (!this.canControl()) return;
    if (this.selected.size) this.net.cmd({ type: 'stop', units: [...this.selected] });
  }

  handleGroup(n, assign) {
    if (!this.canControl()) return;
    if (assign) { this.groups[n] = [...this.selected]; }
    else if (this.groups[n]) { this.selected = new Set(this.groups[n]); this.onSelectionChange && this.onSelectionChange(); }
  }
}
