// 3D-Rendering mit Three.js: Gelände aus Höhenkarte, Einheiten/Gebäude-Meshes,
// Kamera, Picking, einfache Effekte (Explosionen, Mündungsfeuer).
import * as THREE from 'three';
import { groundTexture, meadowTexture, oilSlickTexture, panelTexture, puffTexture } from './textures.js';
import { ModelLibrary } from './models.js';
import { makeBuildingMesh } from './buildings3d.js';

const HEIGHT_SCALE = 16;   // Weltmeter pro Höhen-Einheit (0..1) — imposantere Berge
const TILE = 2;
export const CAMERA_TILT_MIN = 0.45;
export const CAMERA_TILT_MAX = 1.25;
const VET_COLORS = [0xcd7f32, 0xc0c0c0, 0xffd54a]; // Veteranen-Rang: Bronze, Silber, Gold
const SHADOW_STATIC_REFRESH = 1.25;  // Sekunden: Sonne/Kamera/Statik
const SHADOW_DYNAMIC_REFRESH = 0.08; // Sekunden: fahrende Einheiten
const SHADOW_SUN_MOVE_EPS2 = 8 * 8;
const SHADOW_TARGET_MOVE_EPS2 = 10 * 10;
const PARTICLE_ZOOM_HIDE_DIST = 260;
const PRECIP_MAX_DIST = 520;
const WEATHER_SNOW_LINE = 0.82;
const SUB_DETECT_RANGE = 5;
const TERRA_PREVIEW_DELTA = 0.12;
const TERRA_PREVIEW_MIN_HEIGHT = 0.02;
const TERRA_PREVIEW_MAX_HEIGHT = 1.92;
const CLIENT_NAVIGABLE_DEPTH = 0.12;
const WATER_SHOW_DEPTH = 0.05;
const WATER_HIDE_DEPTH = 0.032;
// Wasser-Glättung: die sichtbare Tiefe gleitet in kleinen Schritten zur Snapshot-Zieltiefe,
// statt alle 250 ms ruckartig zu springen (staccato). Reine Optik, keine Simulationswirkung.
const WATER_EASE_RATE = 3.2;        // Annäherungsrate pro Sekunde — niedriger = der Pegel steigt/fällt sanfter
const WATER_EASE_SNAP = 5e-4;       // unter dieser Restdifferenz auf den Zielwert einrasten
const WATER_ANIM_INTERVAL = 1 / 30; // Glättung mit ~30 Hz auffrischen (begrenzt Mesh-Neuaufbau)
const FLOOD_RUNOFF_DEPTH = 0.022;   // schon dünner Abfluss zählt als Wasser (zeigt Textur, wo es abläuft)
const FLOOD_SURFACE_DEPTH = 0.024;  // ab dieser Tiefe bekommt auch dünnes Ablaufwasser eine Wasseroberfläche
const WET_GROUND_MIN_DEPTH = 0.004;     // schon hauchdünnes Ablaufwasser färbt den Boden nass (entlang der Partikelströme)
const WET_GROUND_FULL_DEPTH = 0.036;
const WET_GROUND_NEIGHBOR_DEPTH = 0.008;
const WATER_EDGE_THRESHOLD = 0.46;
const FLOOD_VIS_SHOW = 0.42;   // niedriger → Ablaufwasser blendet früher und weicher ein (smoother)
const FLOOD_VIS_HIDE = 0.22;
const WATER_SURFACE_CLEAR = 0.075;
const WATER_EDGE_CLOSE_MAX_LIFT = 0.05;  // wie hoch Wasser eine Trockenlücke überbrücken darf — niedriger = weniger Wasserflächen, die durchs Ufer/Felsen stechen (Clipping)
const WATER_PLANE_LINK_EPS = 0.42;     // world units: Zellen mit ähnlichem Pegel bilden eine ebene Fläche
const WATER_PLANE_QUANT = 0;           // 0 = kein Pegel-Raster; Pegel steigt/sinkt kontinuierlich
const WATER_PLANE_DEADBAND = 0.018;    // nur winziges CA-Rauschen ignorieren
const WATER_PLANE_RISE_SMOOTH = 0.070; // Regenpegel weich, aber sichtbar nachführen
const WATER_PLANE_FALL_SMOOTH = 0.045; // Abfluss trocknet langsamer aus als er flutet
const FLOOD_CHANNEL_DEPTH = 0.026;  // dünne Abflussrinnen bekommen schon früh eine Wasseroberfläche
const WATER_DARK_DEPTH_START = 0.085;
const WATER_DARK_DEPTH_RANGE = 0.34;
const WATER_EDGE_TUCK_Y = 0.026;
const WATER_NIGHT_COLOR_MIN = 0.16;
const WATER_NIGHT_OPACITY_MIN = 0.28;   // transparenteres Wasser (Grund scheint mehr durch); Himmelsspiegelung am Streifwinkel macht es trotzdem plastisch
const WATER_STANDING_FLOW_MAX = 0.13;
const WATER_STANDING_LEVEL_QUANTILE = 0.68;

// Tag/Nacht-Farbpaletten für Himmel & Nebel (werden nach Tageslicht überblendet).
const SKY_DAY = new THREE.Color(0x9ec8e8), SKY_NIGHT = new THREE.Color(0x070b14);
const SKY_RAIN = new THREE.Color(0x5d6b78);
const SKY_DROUGHT = new THREE.Color(0xd2b77a);
const WEATHER_FOG_DAY = new THREE.Color(0x9faab0);
const WEATHER_FOG_NIGHT = new THREE.Color(0x111821);
const WATER_KINDS = new Set(['patrol_boat', 'destroyer', 'amphib_transport', 'sea_builder', 'submarine', 'underwater_drone']);
// Wasserbauten schwimmen auf der Oberfläche (Werft, Pumpwerk) statt auf dem Seegrund zu stehen.
const WATER_BUILDINGS = new Set(['shipyard', 'water_pump', 'pontoon']);
const SURFACE_SHIP_KINDS = new Set(['patrol_boat', 'destroyer', 'amphib_transport', 'sea_builder']);
// Bauten, die ans Pipeline-Netz andocken (für die optische Rohrverbindung).
const PIPE_CONNECT = new Set(['pipe', 'water_pump', 'water_tower', 'oil_derrick', 'oil_depot']);
const PIPE_BRIDGE_CHAIN_MIN = TILE * 8;
const PIPE_BRIDGE_SPACING = TILE * 7;
const PIPE_BRIDGE_WIDTH = TILE * 1.8;
const PIPE_BRIDGE_LIFT = 1.05;
const PIPE_FLEX_SAG = 0.34;        // Durchhang des flexiblen Schlauchs am Pumpwerk-/Depot-Anschluss
const PIPE_FLEX_RADIUS = 0.13;     // dünner als das starre Rohr (0.17) — wirkt wie ein Schlauch
const ZERO_OFFSET = { x: 0, z: 0 }; // wiederverwendeter Null-Spurversatz (kein Garbage pro Frame)
const INFANTRY_KINDS = new Set(['engineer', 'rifleman', 'at_soldier', 'aa_soldier']);
const AIR_UNIT_KINDS = new Set(['recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air']);
const LAND_VEHICLE_KINDS = new Set(['scout', 'tank', 'artillery', 'flak_track', 'harvester', 'builder', 'truck', 'tractor']);
const HEAVY_TRACK_KINDS = new Set(['tank', 'artillery', 'harvester']);
const LIGHTED_UNIT_KINDS = new Set([
  'scout', 'tank', 'artillery', 'flak_track', 'harvester', 'builder', 'truck', 'tractor',
  'recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air',
  'patrol_boat', 'destroyer', 'submarine', 'underwater_drone', 'amphib_transport', 'sea_builder',
]);
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const smoothAlpha = (dt, speed) => 1 - Math.exp(-speed * Math.min(0.05, Math.max(0, dt || 1 / 60)));
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};
const UNDERWATER_OBJECT_TINT = new THREE.Color(0x071923);
const DEEP_SEA_SKIRT_COLOR = new THREE.Color(0x062c46);
function hash01(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 224682251);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function detectRenderQuality() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const cores = Number(nav.hardwareConcurrency) || 8;
  const memory = Number(nav.deviceMemory) || 8;
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const ua = nav.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (mobile || cores <= 4 || memory <= 4) return 'low';
  if (cores <= 6 || memory <= 6 || dpr > 1.7) return 'medium';
  return 'high';
}

function perfProfile(level) {
  const profiles = {
    low: {
      pixelRatio: 0.9,
      antialias: false,
      sunShadow: 512,
      vehicleShadow: 256,
      vehicleShadowCasters: 1,
      lightPool: 8,
      vehicleLightPool: 4,
      lightRefresh: 0.34,
      rocks: 150,
      meadows: 18,
      animals: 8,
      fish: 12,
      birdsMin: 4,
      birdsMax: 8,
      rainDrops: 360,
      effectCap: 150,
      faunaStep: 0.10,
      waterAnimStep: 0.11,
      uiInterval: 450,
    },
    medium: {
      pixelRatio: 1.1,
      antialias: false,
      sunShadow: 1024,
      vehicleShadow: 512,
      vehicleShadowCasters: 1,
      lightPool: 16,
      vehicleLightPool: 7,
      lightRefresh: 0.24,
      rocks: 250,
      meadows: 28,
      animals: 14,
      fish: 20,
      birdsMin: 6,
      birdsMax: 12,
      rainDrops: 620,
      effectCap: 250,
      faunaStep: 0.055,
      waterAnimStep: 0.07,
      uiInterval: 320,
    },
    high: {
      pixelRatio: 1.35,
      antialias: true,
      sunShadow: 1024,
      vehicleShadow: 512,
      vehicleShadowCasters: 2,
      lightPool: 22,
      vehicleLightPool: 10,
      lightRefresh: 0.16,
      rocks: 360,
      meadows: 40,
      animals: 20,
      fish: 28,
      birdsMin: 8,
      birdsMax: 18,
      rainDrops: 950,
      effectCap: 360,
      faunaStep: 0.03,
      waterAnimStep: 0.035,
      uiInterval: 250,
    },
  };
  return profiles[level] || profiles.high;
}

export class Renderer {
  constructor(container) {
    this.container = container;
    this.quality = detectRenderQuality();
    this.perf = perfProfile(this.quality);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ec8e8);
    this.scene.fog = new THREE.Fog(0x9ec8e8, 180, 780);

    this.renderer = new THREE.WebGLRenderer({ antialias: this.perf.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, this.perf.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    container.appendChild(this.renderer.domElement);
    this.graphics = { shadows: true, lights: true };

    // near=2: deutlich bessere Tiefenpuffer-Präzision → kein Z-Fighting der Wasserflächen beim Rauszoomen.
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 2, 1600);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDist = 90; this.camAngle = 0.95;

    // Beleuchtung: Sonne wandert mit dem Tag/Nacht-Zyklus (updateEnvironment), Mond hellt die Nacht
    // minimal auf (Spielbarkeit), Hemisphäre liefert weiches Umgebungslicht.
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(90, 95, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.perf.sunShadow, this.perf.sunShadow);
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.00016;
    sun.shadow.normalBias = 0.018;
    sun.shadow.radius = 3.2;
    const s = 130; Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this.moon = new THREE.DirectionalLight(0x7488bb, 0.0);
    this.moon.position.set(-80, 100, -60);
    this.scene.add(this.moon);
    this.hemi = new THREE.HemisphereLight(0x88aacc, 0x33291f, 0.28);
    this.scene.add(this.hemi);

    this.meshes = new Map();    // id -> THREE.Group
    this.effects = [];          // {mesh, life, max, vy?, drift?, grow?, base?}
    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._screenVec = new THREE.Vector3();
    this._screenBox = new THREE.Box3();
    this.time = 0;              // Client-Uhr für Animationen (Rotor, Bob, Sonar)
    this._lastDt = 1 / 60;      // Render-Delta für zeitbasiertes Mesh-Smoothing
    this._quakeAmp = 0;         // Kamera-Shake-Amplitude (Erdbeben)
    this._flash = 0;            // Blitz-Aufhellung (klingt schnell ab)
    this._waterAnimT = 0;
    this._waterDeltaSig = null;
    this._waterSeaIndices = [];
    this._shadowDirty = true;
    this._shadowDynamic = false;
    this._shadowWait = 0;
    this._shadowSunProbe = sun.position.clone();
    this._shadowTargetProbe = new THREE.Vector3();
    this.fowEnabled = false;
    this._fowData = null;
    this._fowCircles = [];
    this._fowHidden = new Set();
    this._fowEnemyMist = new Map();
    this._mistDummy = new THREE.Object3D();
    this._tmpBuildingFxPos = new THREE.Vector3();
    this.jobGhosts = new Map();
    this._terraformJobPreview = [];
    this._terraformDragPreview = [];
    this._terraformPreviewSig = '';
    this.terraformPreviewMesh = null;
    this.oreMats = null;
    this.oreMeshes = [];
    this.oilMesh = null;
    this.oilAmount = null;
    this._oilSet = new Set();
    this._currentFxAt = 0;
    this._modelPreviewCache = new Map();
    this._modelPreviewRenderer = null;

    // Prozedurale Texturen (CC0/eigenerstellt): Boden-Detail + Partikel-Sprite; Material-Cache je Farbe.
    this.tex = { ground: groundTexture(), meadow: meadowTexture(), oil: oilSlickTexture(), puff: puffTexture() };
    this._matCache = new Map();

    // Geteilte neutrale Baumaterialien + EIN globales Fenster-Material (emissiv bei Nacht:
    // der Tag/Nacht-Wechsel animiert genau eine emissiveIntensity für alle Gebäude).
    this.winMat = new THREE.MeshStandardMaterial({ color: 0x14171c, emissive: 0xffd27a, emissiveIntensity: 0, roughness: 0.4 });
    this.winOffMat = new THREE.MeshStandardMaterial({ color: 0x101317, roughness: 0.4 }); // Lastabwurf: Licht aus
    this.envMats = {
      dark: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.9, metalness: 0.1 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.45, metalness: 0.55 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x6e6657, roughness: 0.95 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x2c5d8a, roughness: 0.15, metalness: 0.4, emissive: 0x10334d, emissiveIntensity: 0.4 }),
      hazard: new THREE.MeshStandardMaterial({ color: 0xd0a23a, roughness: 0.7 }),
      water: new THREE.MeshStandardMaterial({ color: 0x38aee8, roughness: 0.32, metalness: 0.12, emissive: 0x0b4d80, emissiveIntensity: 0.34 }),
      oil: new THREE.MeshStandardMaterial({ color: 0x060504, roughness: 0.22, metalness: 0.65 }),
      ore: new THREE.MeshStandardMaterial({ color: 0xb97931, roughness: 0.92, metalness: 0.12 }),
      signal: new THREE.MeshStandardMaterial({ color: 0xb94732, roughness: 0.55, emissive: 0x2b0602, emissiveIntensity: 0.2 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x7d7f82, roughness: 0.95 }),
      win: this.winMat,
    };
    this.treeMats = {
      trunk: new THREE.MeshStandardMaterial({ color: 0x5a3c25, roughness: 0.9 }),
      leaf: new THREE.MeshLambertMaterial({ color: 0x2d5630 }),
      leafDark: new THREE.MeshLambertMaterial({ color: 0x1f3f26 }),
    };
    this.natureMats = {
      rock: new THREE.MeshStandardMaterial({ color: 0x66675f, roughness: 0.96, metalness: 0.0 }),
      grass: new THREE.MeshLambertMaterial({ color: 0xffffff, map: this.tex.meadow, transparent: true, opacity: 0.78, alphaTest: 0.035, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      fur: new THREE.MeshStandardMaterial({ color: 0x8a6847, roughness: 0.92 }),
      furDark: new THREE.MeshStandardMaterial({ color: 0x4e3a2a, roughness: 0.95 }),
      fish: new THREE.MeshLambertMaterial({ color: 0x8fc3c4, transparent: true, opacity: 0.82 }),
      bird: new THREE.MeshLambertMaterial({ color: 0x2f302c }),
    };
    this.wildlife = [];
    this.fish = [];
    this.birds = [];
    // Fahrzeuglichter (vorne weiß, hinten rot) + Gebäudelampen: geteilte Materialien,
    // deren Helligkeit der Tag/Nacht-Zyklus global schaltet.
    this.headMat = new THREE.MeshBasicMaterial({ color: 0x4a4a40 });
    this.rearMat = new THREE.MeshBasicMaterial({ color: 0x451310 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffe2a8, emissiveIntensity: 0 });
    this.rotorBlurMat = new THREE.MeshBasicMaterial({ color: 0xbfd4df, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    // Punktlicht-Pool: die kamera-nächsten Gebäude beleuchten nachts ihre Umgebung.
    // Gebäudelampen werfen bewusst keine Schatten; nachts sind nur Fahrzeugscheinwerfer
    // Teil der Shadow-Map.
    this.lightPool = [];
    for (let i = 0; i < this.perf.lightPool; i++) {
      const pl = new THREE.PointLight(0xffd9a0, 0, 34, 1.7);
      this.scene.add(pl); this.lightPool.push(pl);
    }
    this._lampSpots = [];
    this._cachedLampSpots = [];
    this._cachedBeamSpots = [];
    this._lightRefreshT = 0;
    this.vehicleLightPool = [];
    for (let i = 0; i < this.perf.vehicleLightPool; i++) {
      const sl = new THREE.SpotLight(0xfff7d0, 0, 34, Math.PI / 7, 0.5, 1.45);
      sl.target = new THREE.Object3D();
      sl.userData.vehicleShadow = i < this.perf.vehicleShadowCasters;
      sl.castShadow = false;
      sl.shadow.mapSize.set(this.perf.vehicleShadow, this.perf.vehicleShadow);
      sl.shadow.camera.near = 0.8;
      sl.shadow.camera.far = 40;
      sl.shadow.bias = -0.0025;
      sl.shadow.normalBias = 0.05;
      sl.shadow.radius = 4.0;
      this.scene.add(sl); this.scene.add(sl.target); this.vehicleLightPool.push(sl);
    }
    this.trackFxGeo = new THREE.PlaneGeometry(0.18, 0.9);
    this.trackFxGeo.rotateX(-Math.PI / 2);
    this._faunaUpdateT = 0;

    // CC0-glTF-Modelle laden (async); sobald eine Datei bereit ist, betroffene Meshes neu aufbauen.
    this.models = new ModelLibrary();
    this.models.preloadAll((kinds) => this._onModelsReady(kinds));

    addEventListener('resize', () => this.onResize());
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, this.perf.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
  }

  setGraphicsOptions(opts = {}) {
    this.graphics = {
      shadows: opts.shadows !== false,
      lights: opts.lights !== false,
    };
    this.renderer.shadowMap.enabled = this.graphics.shadows;
    if (!this.graphics.shadows) {
      this.sun.castShadow = false;
      for (const sl of this.vehicleLightPool || []) sl.castShadow = false;
      this._shadowDirty = false;
      this._shadowDynamic = false;
    } else {
      this._markShadowsDirty(false, true);
    }
    if (!this.graphics.lights) {
      this.winMat.emissiveIntensity = 0;
      this.lampMat.emissiveIntensity = 0;
      this.headMat.color.setHex(0x4a4a40);
      this.rearMat.color.setHex(0x451310);
      for (const pl of this.lightPool || []) pl.intensity = 0;
      for (const sl of this.vehicleLightPool || []) {
        sl.intensity = 0;
        sl.castShadow = false;
      }
      this._cachedLampSpots.length = 0;
      this._cachedBeamSpots.length = 0;
    }
  }

  resetWorld() {
    const remove = (obj) => { if (obj?.parent) obj.parent.remove(obj); };
    for (const g of this.meshes.values()) remove(g);
    this.meshes.clear();
    for (const e of this.effects) remove(e.mesh);
    this.effects.length = 0;
    for (const ghost of this.jobGhosts.values()) remove(ghost);
    this.jobGhosts.clear();
    remove(this.terraformPreviewMesh);
    this.terraformPreviewMesh?.geometry?.dispose?.();
    this.terraformPreviewMesh?.material?.dispose?.();
    this.terraformPreviewMesh = null;
    this._terraformJobPreview = [];
    this._terraformDragPreview = [];
    this._terraformPreviewSig = '';
    for (const mist of this._fowEnemyMist.values()) remove(mist);
    this._fowEnemyMist.clear();
    for (const obj of [
      this.terrainMesh, this.fowMesh, this.waterMesh, this.skirtMesh, this.floodMesh,
      this.wetGroundMesh, this.trackMesh, this.mudMesh, this.roadMesh, this.bridgeMesh, this.pipeMesh, this.oilMesh, this.rockInst, this.grassInst,
      ...(this.oreMeshes || []),
      ...Object.values(this.treeInst || {}),
      ...(this.wildlife || []).map(a => a.group),
      ...(this.fish || []).map(f => f.group),
      ...(this.birds || []).map(b => b.group),
    ]) remove(obj);
    this.terrainMesh = this.fowMesh = this.waterMesh = this.skirtMesh = this.floodMesh = null;
    this.wetGroundMesh = null;
    this.trackMesh = this.mudMesh = this.roadMesh = this.bridgeMesh = this.pipeMesh = this.oilMesh = null;
    this.rockInst = this.grassInst = null;
    this.treeInst = null;
    this.oreMats = null;
    this.oreMeshes = [];
    this.oilAmount = null;
    this._oilSet = new Set();
    this._oilSig = null;
    this._wetAmount = null;
    this._wetScratch = null;
    this._currentFxAt = 0;
    this.wildlife = [];
    this.fish = [];
    this.birds = [];
    this.jobGhosts = new Map();
    this._lampSpots.length = 0;
    this._cachedLampSpots.length = 0;
    this._cachedBeamSpots.length = 0;
    this._lastEntities = [];
    this._baseBridgeCells = [];
    this._bridgeSig = '';
    this._pipeSig = '';
    this._waterSurfaceVisual = null;
    this._waterDeltaSig = null;
    this._waterEasing = null;
    this._waterAnimAccum = 0;
    this._floodMaskSettled = false;
    this.waterSources = [];
    this._sourceFxAt = 0;
    this._waterSeaIndices = [];
    this._waterWaveBase = null;
    this._waterAnimT = 0;
    this._rockWaterTint = null;
    this.height = null;
    this.terrainType = null;
    this._permanentWater = null;
    this.mapW = 0;
    this.mapH = 0;
  }

  _markShadowsDirty(dynamic = false, force = false) {
    if (!this.renderer?.shadowMap?.enabled) return;
    this._shadowDirty = true;
    this._shadowDynamic = this._shadowDynamic || !!dynamic;
    if (force) this._shadowWait = 0;
  }

  _commitShadowRefresh() {
    this._shadowWait = Math.max(0, (this._shadowWait || 0) - this._lastDt);
    if (!this._shadowDirty || this._shadowWait > 0) return;
    this.renderer.shadowMap.needsUpdate = true;
    this._shadowWait = this._shadowDynamic ? SHADOW_DYNAMIC_REFRESH : SHADOW_STATIC_REFRESH;
    this._shadowDirty = false;
    this._shadowDynamic = false;
  }

  // --- Gelände aus dem Init-Paket aufbauen ---
  buildTerrain(init) {
    this.mapW = init.map.w; this.mapH = init.map.h;
    const { w, h, height, type } = { w: init.map.w, h: init.map.h, height: init.terrain.height, type: init.terrain.type };
    this.height = height; this.terrainType = type;
    this.treeCells = new Map();
    this.treeFallen = new Set();
    this.treeInst = null;
    // Unverfälschte Ausgangshöhen behalten: Terraforming-Deltas (snap.terra) werden darauf angewandt
    // und beim Verschwinden eines Deltas (Wall zerstört, Graben zu) exakt zurückgesetzt.
    this.height0 = Float64Array.from(height);
    this._terraIdx = new Set();
    const waterLevel = init.terrain.seaLevel ?? 0.32;
    const geo = new THREE.PlaneGeometry(w * TILE, h * TILE, w - 1, h - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cLand = new THREE.Color(0x4a5d34), cHill = new THREE.Color(0x6b5d3e),
      cCliff = new THREE.Color(0x556069), cWater = new THREE.Color(0x1d74b4), cBridge = new THREE.Color(0x4a4036),
      cBeach = new THREE.Color(0xb8a36f);
    for (let i = 0; i < pos.count; i++) {
      const gx = i % w, gy = (i / w) | 0;
      const e = height[gy * w + gx];
      pos.setY(i, e * HEIGHT_SCALE);
      // Weltposition: Plane zentriert → verschieben, damit (0,0)=Ecke
      pos.setX(i, gx * TILE);
      pos.setZ(i, gy * TILE);
      const t = type[gy * w + gx];
      const beach = t !== 3 && t !== 4 && e >= waterLevel - 0.01 && e <= waterLevel + 0.085 && this._isNearSeaCell(gx, gy, 3, type);
      const c = beach ? cBeach : t === 3 ? cWater : t === 2 ? cCliff : t === 1 ? cHill : t === 4 ? cBridge : cLand;
      const v = beach ? 0.92 + hash01(gx, gy, 19) * 0.16 : 0.85 + e * 0.3;
      colors[i * 3] = c.r * v; colors[i * 3 + 1] = c.g * v; colors[i * 3 + 2] = c.b * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this._colAttr = geo.attributes.color;     // für Schnee-Einfärbung (updateSnow)
    this._rawBaseColors = colors.slice();
    this._baseColors = colors.slice();
    this._mudAmount = new Float32Array(w * h);
    this._wetAmount = new Float32Array(w * h);
    this._wetScratch = new Float32Array(w * h);
    this._snowPairs = [];
    this.oilAmount = new Uint8Array(w * h);
    this._oilSet = new Set();
    if (init.terrain.oil) this._applyOilDelta(init.terrain.oil);
    this._snowSet = new Set();
    this._snowAmount = new Map();
    this._snowMeltRockAt = 0;
    // Boden-Detailtextur moduliert die Vertex-Farben; StandardMaterial beleuchtet pro Pixel,
    // damit Gebäudelichter nicht die einzelnen Dreiecke des Terrain-Meshs sichtbar machen.
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, map: this.tex.ground, roughness: 0.96, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrainMesh = mesh;
    this.updateSnow(init.terrain.snow || []);

    const fowGeo = geo.clone();
    const fowPos = fowGeo.attributes.position;
    for (let i = 0; i < fowPos.count; i++) fowPos.setY(i, fowPos.getY(i) + 0.32);
    fowGeo.computeVertexNormals();
    this.fowMesh = new THREE.Mesh(fowGeo, makeFogOfWarMaterial());
    this.fowMesh.renderOrder = 4;
    this.fowMesh.visible = this.fowEnabled;
    this.scene.add(this.fowMesh);

    // TIEFEN-getriebenes Oberflächenmesh: sichtbare Wasserzellen werden zu einer echten
    // zusammenhängenden Quad-Fläche mit gemeinsamen Eckpunkten zusammengebaut.
    const waterY = waterLevel * HEIGHT_SCALE;
    const wgeo = this._makeEmptyWaterGeometry();
    const cellCount = w * h;
    // Basistiefen vom Server (init.terrain.baseWater); Fallback: aus Seehöhe ableiten.
    this.waterBase = init.terrain.baseWater
      ? Float64Array.from(init.terrain.baseWater)
      : Float64Array.from(height, (hv) => Math.max(0, waterLevel - hv));
    this.waterDepth = Float64Array.from(this.waterBase);
    this.waterTarget = Float64Array.from(this.waterBase); // Snapshot-Zieltiefen; waterDepth gleitet hierher
    this._waterEasing = new Set();                        // Zellen, deren sichtbare Tiefe gerade nachzieht
    this._waterAnimAccum = 0;
    this._floodMaskSettled = false;
    this._waterShown = new Uint8Array(cellCount); // Hysterese-Flag gegen Ufer-Flackern
    this._wetCov = new Float32Array(cellCount);    // zeitlich geglättete Zell-Deckung 0..1 (Anti-Ping-Pong)
    this._floodShown = new Uint8Array(cellCount);
    this._floodVisual = new Float32Array(cellCount);
    this._floodGoal = new Float32Array(cellCount);
    this._floodScratch = new Float32Array(cellCount);
    this._waterSurfaceVisual = new Float32Array(cellCount);
    this._permanentWater = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i++) if (type[i] === 3) this._permanentWater[i] = 1;
    if (init.terrain.waterDepth) {
      for (let n = 0; n < init.terrain.waterDepth.length; n += 2) {
        const idx = init.terrain.waterDepth[n];
        const depth = (init.terrain.waterDepth[n + 1] / 255) * 0.7;
        if (idx < 0 || idx >= cellCount || depth <= 0.012) continue;
        this._permanentWater[idx] = 1;
        this.waterBase[idx] = Math.max(this.waterBase[idx] || 0, depth);
        this.waterDepth[idx] = Math.max(this.waterDepth[idx] || 0, depth);
      }
    }
    this._waterOverrides = new Set();
    // Flussquellen: an diesen Zellen quillt sichtbar Wasser auf — so ist erkennbar, WOHER das
    // Oberflächenwasser kommt. Snapshot-Strömungspartikel zeigen anschließend, WOHIN es fließt.
    this.waterSources = Array.isArray(init.terrain.sources) ? init.terrain.sources.slice() : [];
    this._sourceFxAt = 0;
    this._setWaterGeometryRefs(wgeo);
    const wmat = makeWaterMaterial();
    this.waterMat = wmat;
    const water = new THREE.Mesh(wgeo, wmat);
    water.renderOrder = 1;
    water.frustumCulled = false;   // ein Draw-Call, Vertex-Y ändert sich laufend
    this.scene.add(water);
    this.waterMesh = water;
    this.seaLevel = waterLevel;
    this.seaY = waterY;
    this._rebuildWaterMesh(true);

    // Umgebungs-„Skirt": riesige Ozeanfläche rund um die Karte, damit am Kartenrand kein
    // schwarzes Loch klafft. Deutlich unter der Seefläche — kein Z-Fighting in der Distanz.
    const skirtGeo = new THREE.PlaneGeometry(w * TILE * 14, h * TILE * 14);
    skirtGeo.rotateX(-Math.PI / 2);
    this.skirtMat = new THREE.MeshLambertMaterial({ color: DEEP_SEA_SKIRT_COLOR });
    const skirt = new THREE.Mesh(skirtGeo, this.skirtMat);
    skirt.position.set(w * TILE / 2, waterY - 1.4, h * TILE / 2);
    skirt.receiveShadow = true;
    this.scene.add(skirt);
    this.skirtMesh = skirt;

    // Legacy-Overlay bleibt als leeres InstancedMesh erhalten; dynamische Fluten laufen über das
    // kontinuierliche Wassermesh, damit sie aus der Distanz nicht als Blockraster erscheinen.
    const floodGeo = new THREE.PlaneGeometry(TILE, TILE); floodGeo.rotateX(-Math.PI / 2);
    const floodMat = makeFloodWaterMaterial();
    this.floodWaterMat = floodMat;
    this._floodOverlayCap = Math.min(w * h, 12000);
    this.floodMesh = new THREE.InstancedMesh(floodGeo, floodMat, this._floodOverlayCap);
    this.floodMesh.renderOrder = 5;
    this.floodMesh.frustumCulled = false;
    this.floodMesh.count = 0;
    this.floodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.floodMesh);
    this._floodDummy = new THREE.Object3D();
    this._refreshFloodOverlay();
    this._up = new THREE.Vector3(0, 1, 0);
    this._normal = new THREE.Vector3();
    this._oilDummy = new THREE.Object3D();
    this._buildOilOverlay();

    // Fahrzeugspuren: zwei dunkle Rillen je betroffener Zelle. Matsch färbt die Terrainbasis
    // braun, statt als rundes Overlay über der Grastextur zu liegen.
    const rutGeo = new THREE.PlaneGeometry(TILE * 0.18, TILE * 0.78); rutGeo.rotateX(-Math.PI / 2);
    this.trackMesh = new THREE.InstancedMesh(rutGeo, new THREE.MeshLambertMaterial({ color: 0x2b241c, transparent: true, opacity: 0.55, depthWrite: false }), 6000);
    this.trackMesh.renderOrder = 2; this.trackMesh.count = 0; this.trackMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.trackMesh);
    this.mudMesh = null;
    // Krater: dunkle, leicht eingesengte Scheiben, die große Waffen am Einschlag hinterlassen.
    const craterGeo = new THREE.CircleGeometry(TILE * 0.62, 16); craterGeo.rotateX(-Math.PI / 2);
    this.craterMesh = new THREE.InstancedMesh(craterGeo,
      new THREE.MeshLambertMaterial({ color: 0x1c1712, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 160);
    this.craterMesh.renderOrder = 2; this.craterMesh.count = 0; this.craterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.craterMesh);
    this._craterIdx = 0; this._craterCount = 0; this._craterDummy = new THREE.Object3D();
    const wetGeo = new THREE.CircleGeometry(TILE * 0.64, 18); wetGeo.rotateX(-Math.PI / 2);
    this.wetGroundMesh = new THREE.InstancedMesh(wetGeo,
      new THREE.MeshLambertMaterial({ color: 0x2f3d32, transparent: true, opacity: 0.34, depthWrite: false }), 9000);
    this.wetGroundMesh.renderOrder = 1;
    this.wetGroundMesh.count = 0;
    this.wetGroundMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.wetGroundMesh);
    this._refreshWetGroundOverlay();

    // Straßen-/Brücken-/Pipeline-Overlays: ein zusammenhängendes Mesh pro Netz statt
    // einzelner Kacheln/Objektstücke. Die Spiellogik bleibt zellbasiert, nur die Optik glättet.
    this.roadMat = new THREE.MeshLambertMaterial({ color: 0x3b3f44 });
    this.roadMesh = new THREE.Mesh(this._makeEmptyOverlayGeometry(), this.roadMat);
    this.roadMesh.renderOrder = 2;
    this.roadMesh.receiveShadow = true;
    this.scene.add(this.roadMesh);

    // Tunnel: durchgehende, dunkle Röhre entlang der Tunneltiles (ein Mesh, leicht über dem
    // Bergrücken erhaben). Die zwei Mündungsportale rendern als normale Gebäude an den Enden.
    this.tunnelMat = new THREE.MeshStandardMaterial({ color: 0x231f1a, roughness: 0.92, metalness: 0.04 });
    this.tunnelMesh = new THREE.Mesh(this._makeEmptyOverlayGeometry(), this.tunnelMat);
    this.tunnelMesh.renderOrder = 3;
    this.tunnelMesh.castShadow = true;
    this.tunnelMesh.receiveShadow = true;
    this.scene.add(this.tunnelMesh);
    this._tunnelSig = '';

    this.bridgeMat = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.85 });
    this.bridgeMesh = new THREE.Mesh(this._makeEmptyOverlayGeometry(), this.bridgeMat);
    this.bridgeMesh.renderOrder = 3;
    this.bridgeMesh.castShadow = true;
    this.bridgeMesh.receiveShadow = true;
    this.scene.add(this.bridgeMesh);
    this._baseBridgeCells = [];
    if (init.terrain.bridge) {
      for (let i = 0; i < init.terrain.bridge.length; i++) if (init.terrain.bridge[i]) this._baseBridgeCells.push(i);
    }
    this._bridgeSig = '';
    this.updateBridgeOverlay();

    this.pipeMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.42, metalness: 0.55, emissive: 0x18506e, emissiveIntensity: 0 });
    // Durchfluss-Visualisierung: helle Bänder wandern entlang der Bogenlänge (aFlow) durch die Leitung,
    // solange Förderung läuft (uFlowOn). Reines Shader-Overlay auf dem bestehenden Rohr-Mesh.
    this.pipeMat.onBeforeCompile = (shader) => {
      shader.uniforms.uFlowTime = { value: 0 };
      shader.uniforms.uFlowOn = { value: 0 };
      this._pipeShader = shader;
      shader.vertexShader = 'attribute float aFlow;\nvarying float vFlow;\n'
        + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFlow = aFlow;');
      shader.fragmentShader = 'uniform float uFlowTime;\nuniform float uFlowOn;\nvarying float vFlow;\n'
        + shader.fragmentShader.replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  float fb = fract(vFlow * 0.6 - uFlowTime);\n  float band = smoothstep(0.72, 0.98, fb) * (1.0 - smoothstep(0.98, 1.0, fb));\n  totalEmissiveRadiance += vec3(0.25, 0.72, 1.0) * band * uFlowOn * 1.6;');
    };
    this.pipeMesh = new THREE.Mesh(this._makeEmptyOverlayGeometry(), this.pipeMat);
    this.pipeMesh.renderOrder = 3;
    this.pipeMesh.castShadow = true;
    this.pipeMesh.receiveShadow = true;
    this.scene.add(this.pipeMesh);

    // Erzvorkommen: gedämpftes Muttergestein mit erdigen Adern; nachts verschwindet es im Gelände.
    const ore = init.terrain.ore;
    const oreRockGeo = new THREE.DodecahedronGeometry(0.58, 0);
    const oreVeinGeo = new THREE.BoxGeometry(0.12, 0.08, 1.05);
    const oreGlintGeo = new THREE.OctahedronGeometry(0.16, 0);
    const oreRockMat = new THREE.MeshStandardMaterial({ color: 0x3d3a34, roughness: 0.98, metalness: 0.0, transparent: true, opacity: 0.7 });
    const oreVeinMat = new THREE.MeshStandardMaterial({ color: 0x6a5140, roughness: 0.88, metalness: 0.08, transparent: true, opacity: 0.28 });
    const oreGlintMat = new THREE.MeshStandardMaterial({ color: 0x857058, roughness: 0.78, metalness: 0.12, transparent: true, opacity: 0.08 });
    this._oreInit = ore;   // Erzmengen (Startwerte) für die Feld-Ressourcenanzeige beim Anklicken
    const dummy = new THREE.Object3D();
    let count = 0; for (let i = 0; i < ore.length; i++) if (ore[i]) count++;
    if (count) {
      const rockInst = new THREE.InstancedMesh(oreRockGeo, oreRockMat, count);
      const veinInst = new THREE.InstancedMesh(oreVeinGeo, oreVeinMat, count * 2);
      const glintInst = new THREE.InstancedMesh(oreGlintGeo, oreGlintMat, count);
      rockInst.castShadow = true; rockInst.receiveShadow = true;
      veinInst.castShadow = true; veinInst.receiveShadow = true;
      glintInst.castShadow = false;
      let rk = 0, vk = 0, gk = 0;
      const tint = new THREE.Color();
      for (let i = 0; i < ore.length; i++) {
        if (!ore[i]) continue;
        const gx = i % w, gy = (i / w) | 0;
        const wx = gx * TILE, wz = gy * TILE, baseY = this.heightAt(wx, wz);
        const h = (gx * 73856093 ^ gy * 19349663) >>> 0;
        const ang = ((h % 628) / 100);
        const sc = 0.62 + ((h >>> 4) % 11) / 18;
        dummy.position.set(wx, baseY + 0.20, wz);
        dummy.scale.set(sc * 1.18, sc * 0.62, sc * 0.95);
        dummy.rotation.set((h & 7) * 0.17, ang, ((h >>> 3) & 7) * 0.12);
        dummy.updateMatrix(); rockInst.setMatrixAt(rk, dummy.matrix);
        tint.setHex((h & 1) ? 0x4b443b : 0x373633); rockInst.setColorAt(rk++, tint);

        for (let v = 0; v < 2; v++) {
          const side = v ? 1 : -1;
          dummy.position.set(
            wx + Math.cos(ang + Math.PI / 2) * side * 0.22,
            baseY + 0.48 + v * 0.04,
            wz + Math.sin(ang + Math.PI / 2) * side * 0.22,
          );
          dummy.scale.set(0.75 + ((h >>> (v + 6)) & 3) * 0.12, 1, 0.72 + ((h >>> (v + 9)) & 3) * 0.14);
          dummy.rotation.set(0.16 * side, ang + v * 0.35, 0.25 * side);
          dummy.updateMatrix(); veinInst.setMatrixAt(vk, dummy.matrix);
          tint.setHex(v ? 0x765a43 : 0x604b3c); veinInst.setColorAt(vk++, tint);
        }

        if ((h & 3) !== 0) {
          dummy.position.set(wx + Math.cos(ang) * 0.2, baseY + 0.78, wz + Math.sin(ang) * 0.2);
          const gs = 0.75 + ((h >>> 11) & 3) * 0.12;
          dummy.scale.set(gs, gs * 0.9, gs);
          dummy.rotation.set(ang * 0.4, ang, 0.7);
          dummy.updateMatrix(); glintInst.setMatrixAt(gk, dummy.matrix);
          tint.setHex((h & 8) ? 0x8c7351 : 0x73563f); glintInst.setColorAt(gk++, tint);
        }
      }
      rockInst.count = rk; veinInst.count = vk; glintInst.count = gk;
      rockInst.instanceColor.needsUpdate = true;
      veinInst.instanceColor.needsUpdate = true;
      if (gk) glintInst.instanceColor.needsUpdate = true;
      this.scene.add(rockInst); this.scene.add(veinInst); this.scene.add(glintInst);
      this.oreMats = { rock: oreRockMat, vein: oreVeinMat, glint: oreGlintMat };
      this.oreMeshes = [rockInst, veinInst, glintInst];
    }

    // Natürliche Deckung (Wald) als mehrteilige Baum-Instanzen — taktische Verstecke sichtbar machen.
    const cover = init.terrain.cover;
    if (cover) {
      const cells = [];
      for (let i = 0; i < cover.length; i++) if (cover[i] >= 0.2 && type[i] !== 3) cells.push(i);
      if (cells.length) {
        const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1.8, 6);
        const crownGeo = new THREE.ConeGeometry(0.9, 1.8, 7);
        const topGeo = new THREE.ConeGeometry(0.62, 1.35, 7);
        const trunkInst = new THREE.InstancedMesh(trunkGeo, this.treeMats.trunk, cells.length);
        const crownInst = new THREE.InstancedMesh(crownGeo, this.treeMats.leafDark, cells.length);
        const topInst = new THREE.InstancedMesh(topGeo, this.treeMats.leaf, cells.length);
        for (const inst of [trunkInst, crownInst, topInst]) {
          inst.castShadow = true; inst.receiveShadow = true;
          inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
        const dt = new THREE.Object3D();
        const tintC = new THREE.Color();
        for (let k = 0; k < cells.length; k++) {
          const gx = cells[k] % w, gy = (cells[k] / w) | 0;
          const wx = gx * TILE, wz = gy * TILE, baseY = this.heightAt(wx, wz);
          const seed = (gx * 73856093 ^ gy * 19349663) >>> 0;
          const variant = seed % 4;
          const sc = 0.66 + cover[cells[k]] * (0.92 + ((seed >>> 18) % 11) / 36);
          const ang = (seed % 628) / 100;
          // Per-Baum-Farbvariation: Helligkeit + leichter Gelb/Blau-Stich → lebendiger Wald statt Klontruppe.
          const bright = 0.72 + ((seed >>> 9) % 50) / 90;
          tintC.setRGB(bright * (1 + (((seed >>> 14) % 9) - 4) / 40), bright, bright * (1 - (((seed >>> 14) % 9) - 4) / 60));
          crownInst.setColorAt(k, tintC);
          topInst.setColorAt(k, tintC.clone().multiplyScalar(1.12));
          trunkInst.setColorAt(k, tintC.clone().multiplyScalar(0.9));
          dt.rotation.set(0, ang, 0);
          dt.position.set(wx, baseY + 0.86 * sc, wz);
          dt.scale.set(sc * (variant === 1 ? 0.72 : 0.9), sc * (variant === 2 ? 1.28 : 1.0), sc * (variant === 1 ? 0.76 : 0.9));
          dt.updateMatrix(); trunkInst.setMatrixAt(k, dt.matrix);
          dt.rotation.set(variant === 3 ? 0.12 : 0.04, ang + 0.2, variant === 1 ? -0.13 : -0.03);
          dt.position.set(wx + ((seed >>> 4) % 5 - 2) * 0.04, baseY + (variant === 2 ? 2.22 : 1.92) * sc, wz + ((seed >>> 7) % 5 - 2) * 0.04);
          dt.scale.set(sc * (variant === 1 ? 0.86 : 1.08), sc * (variant === 2 ? 1.16 : 0.98), sc * (variant === 3 ? 1.16 : 0.93));
          dt.updateMatrix(); crownInst.setMatrixAt(k, dt.matrix);
          dt.rotation.set(variant === 1 ? -0.16 : -0.03, ang - 0.4, variant === 3 ? 0.16 : 0.05);
          dt.position.set(wx, baseY + (variant === 2 ? 3.24 : variant === 1 ? 2.66 : 2.84) * sc, wz);
          dt.scale.set(sc * (variant === 1 ? 0.72 : 0.93), sc * (variant === 2 ? 1.15 : 0.96), sc * (variant === 3 ? 1.05 : 0.88));
          dt.updateMatrix(); topInst.setMatrixAt(k, dt.matrix);
          this.treeCells.set(cells[k], k);
        }
        trunkInst.instanceColor.needsUpdate = true;
        crownInst.instanceColor.needsUpdate = true;
        topInst.instanceColor.needsUpdate = true;
        this.treeInst = { trunk: trunkInst, crown: crownInst, top: topInst };
        this.scene.add(trunkInst); this.scene.add(crownInst); this.scene.add(topInst);
      }
    }

    this._buildTerrainDetails(init);
    this._spawnWildlife(init);
    this._spawnFishAndBirds(init);

    this.camTarget.set(w * TILE / 2, 0, h * TILE / 2);
    this._markShadowsDirty(false, true);
  }

  _buildTerrainDetails(init) {
    const w = this.mapW, h = this.mapH;
    if (!w || !h || !this.height) return;
    const cover = init.terrain.cover || [];
    const ore = init.terrain.ore || [];
    const rocks = [];
    const meadows = [];
    const maxRocks = this.perf.rocks;
    const maxMeadows = this.perf.meadows;
    const sea = this.seaLevel ?? 0.28;
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if ((this.waterBase?.[i] || 0) > 0.012 || this.terrainType?.[i] === 3 || ore[i]) continue;
      const hv = this.height[i], slope = this._slopeAt(i), cov = cover[i] || 0;
      const r = hash01(x, y, 11);
      const shore = hv > sea - 0.005 && hv < sea + 0.12 && this._isNearSeaCell(x, y, 3);
      const cliffFace = (this.terrainType?.[i] === 2 && slope > 0.060) || slope > 0.082;
      const largeBoulder = slope > 0.048 && hv > sea + 0.10;
      if (((cliffFace && r > 0.74) || (largeBoulder && r > 0.97) || (shore && r > 0.91)) && rocks.length < maxRocks) {
        rocks.push([i, x, y, shore ? 1 : cliffFace ? 2 : 0]);
      }

      if (meadows.length < maxMeadows && this.terrainType?.[i] === 0 && !shore && cov < 0.18 && slope < 0.042 && hv > sea + 0.08 && hv < sea + 0.50) {
        let nearCover = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          nearCover = Math.max(nearCover, cover[ny * w + nx] || 0);
        }
        const edgeBias = nearCover > 0.22 ? 0.020 : nearCover > 0.12 ? 0.010 : 0.0025;
        if (hash01(x, y, 31) > 1 - edgeBias) {
          let spaced = true;
          for (let m = 0; m < meadows.length; m++) {
            const dx = meadows[m][1] - x, dy = meadows[m][2] - y;
            if (dx * dx + dy * dy < 13 * 13) { spaced = false; break; }
          }
          if (spaced) meadows.push([i, x, y, nearCover]);
        }
      }
    }

    const d = this._floodDummy;
    if (rocks.length) {
      const geo = new THREE.DodecahedronGeometry(0.45, 0);
      const inst = new THREE.InstancedMesh(geo, this.natureMats.rock, rocks.length);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.castShadow = true; inst.receiveShadow = true;
      const tint = new THREE.Color();
      const baseColors = new Float32Array(rocks.length * 3);
      const cells = new Int32Array(rocks.length);
      for (let k = 0; k < rocks.length; k++) {
        const [idx, gx, gy, kind] = rocks[k];
        cells[k] = idx;
        const r = hash01(gx, gy, 101);
        const cliff = kind === 2, shore = kind === 1;
        const wx = gx * TILE + (hash01(gx, gy, 111) - 0.5) * TILE * (cliff ? 0.36 : 0.52);
        const wz = gy * TILE + (hash01(gx, gy, 121) - 0.5) * TILE * (cliff ? 0.36 : 0.52);
        const slope = this._slopeAt(idx);
        const sc = (cliff ? 1.55 : shore ? 0.95 : 1.45) + r * (cliff ? 2.0 : shore ? 1.35 : 2.1) + Math.min(0.9, slope * 7);
        d.position.set(wx, this.heightAt(wx, wz) + (cliff ? 0.06 : 0.14) * sc, wz);
        d.rotation.set(r * 1.7, hash01(gx, gy, 131) * Math.PI * 2, hash01(gx, gy, 141) * 1.2);
        if (cliff) {
          this._alignToTerrain(d, idx);
          d.rotateY(hash01(gx, gy, 131) * Math.PI * 2);
          d.scale.set(sc * (1.45 + hash01(gx, gy, 151) * 1.0), sc * (0.26 + hash01(gx, gy, 161) * 0.24), sc * (0.9 + hash01(gx, gy, 171) * 0.7));
        } else {
          d.scale.set(sc * (0.9 + hash01(gx, gy, 151) * 0.7), sc * (0.44 + hash01(gx, gy, 161) * 0.38), sc * (0.8 + hash01(gx, gy, 171) * 0.7));
        }
        d.updateMatrix(); inst.setMatrixAt(k, d.matrix);
        const v = 0.72 + hash01(gx, gy, 181) * 0.38;
        tint.setRGB(v * (shore ? 0.70 : cliff ? 0.58 : 0.62), v * (shore ? 0.68 : cliff ? 0.59 : 0.62), v * (shore ? 0.60 : cliff ? 0.55 : 0.58));
        baseColors[k * 3] = tint.r;
        baseColors[k * 3 + 1] = tint.g;
        baseColors[k * 3 + 2] = tint.b;
        inst.setColorAt(k, tint);
      }
      inst.instanceColor.needsUpdate = true;
      this.scene.add(inst);
      this.rockInst = inst;
      this._rockWaterTint = { inst, cells, baseColors };
    }
    if (meadows.length) {
      const geo = new THREE.PlaneGeometry(TILE * 2.2, TILE * 2.2);
      geo.rotateX(-Math.PI / 2);
      const inst = new THREE.InstancedMesh(geo, this.natureMats.grass, meadows.length);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.receiveShadow = true;
      inst.renderOrder = 1;
      const tint = new THREE.Color();
      for (let k = 0; k < meadows.length; k++) {
        const [idx, gx, gy, nearCover] = meadows[k];
        const wx = gx * TILE + (hash01(gx, gy, 211) - 0.5) * TILE * 1.8;
        const wz = gy * TILE + (hash01(gx, gy, 221) - 0.5) * TILE * 1.8;
        const ang = hash01(gx, gy, 231) * Math.PI * 2;
        const edge = Math.min(1, nearCover * 1.8);
        const sx = 0.75 + hash01(gx, gy, 241) * 1.35 + edge * 0.7;
        const sz = 0.55 + hash01(gx, gy, 251) * 1.00 + edge * 0.45;
        d.position.set(wx, this.heightAt(wx, wz) + 0.045, wz);
        d.rotation.set(0, 0, 0);
        d.scale.set(1, 1, 1);
        this._alignToTerrain(d, idx);
        d.rotateY(ang);
        d.scale.set(sx, 1, sz);
        d.updateMatrix(); inst.setMatrixAt(k, d.matrix);
        const v = 0.72 + hash01(gx, gy, 261) * 0.22;
        tint.setRGB(v * 0.72, v * (0.92 + edge * 0.08), v * 0.68);
        inst.setColorAt(k, tint);
      }
      inst.instanceColor.needsUpdate = true;
      this.scene.add(inst);
      this.grassInst = inst;
    }
    d.scale.set(1, 1, 1);
  }

  _spawnWildlife(init) {
    this.wildlife.length = 0;
    const w = this.mapW, h = this.mapH, cover = init.terrain.cover || [];
    const candidates = [];
    for (let y = 4; y < h - 4; y += 2) for (let x = 4; x < w - 4; x += 2) {
      const i = y * w + x;
      if ((this.waterBase?.[i] || 0) > 0.012 || this.terrainType?.[i] !== 0) continue;
      if ((cover[i] || 0) > 0.22 || this.height[i] < (this.seaLevel ?? 0.28) + 0.08 || this.height[i] > 0.72) continue;
      if (this._slopeAt(i) > 0.07) continue;
      const r = hash01(x, y, 211);
      if (r < 0.11) candidates.push([x, y, r]);
    }
    candidates.sort((a, b) => hash01(a[0], a[1], 221) - hash01(b[0], b[1], 221));
    const count = Math.min(this.perf.animals, candidates.length);
    for (let k = 0; k < count; k++) {
      const [tx, ty] = candidates[k];
      const x = tx * TILE, z = ty * TILE;
      const g = this._makeAnimal(k);
      const phase = hash01(tx, ty, 231) * Math.PI * 2;
      g.position.set(x, this.heightAt(x, z) + 0.06, z);
      this.scene.add(g);
      this.wildlife.push({
        group: g, x, z, ax: x, az: z,
        dir: phase, phase,
        speed: 0.22 + hash01(tx, ty, 241) * 0.22,
        radius: 5 + hash01(tx, ty, 251) * 7,
        seed: tx * 4099 + ty,
      });
    }
  }

  _makeAnimal(seed) {
    const g = new THREE.Group();
    const fur = seed % 3 === 0 ? this.natureMats.furDark : this.natureMats.fur;
    const body = boxMesh(0.32, 0.28, 0.78, fur, 0, 0.42, 0);
    const head = boxMesh(0.24, 0.22, 0.28, fur, 0, 0.56, 0.48);
    const tail = boxMesh(0.08, 0.08, 0.18, this.natureMats.furDark, 0, 0.48, -0.48);
    g.add(body, head, tail);
    g.userData.legs = [];
    for (const sx of [-0.13, 0.13]) for (const sz of [-0.23, 0.23]) {
      const leg = boxMesh(0.055, 0.38, 0.055, this.natureMats.furDark, sx, 0.18, sz);
      g.add(leg); g.userData.legs.push(leg);
    }
    if (seed % 2 === 0) {
      const hornMat = new THREE.MeshStandardMaterial({ color: 0xd6c79a, roughness: 0.8 });
      const left = cylMesh(0.012, 0.025, 0.32, hornMat, -0.08, 0.76, 0.55, 5);
      const right = cylMesh(0.012, 0.025, 0.32, hornMat, 0.08, 0.76, 0.55, 5);
      left.rotation.x = right.rotation.x = 0.45;
      g.add(left, right);
    }
    g.scale.setScalar(1.05 + hash01(seed, seed, 261) * 0.38);
    return g;
  }

  _spawnFishAndBirds(init) {
    this.fish.length = 0;
    this.birds.length = 0;
    const w = this.mapW, h = this.mapH;
    const fishCells = [];
    for (let y = 4; y < h - 4; y += 3) for (let x = 4; x < w - 4; x += 3) {
      const i = y * w + x;
      const depth = this.waterBase?.[i] || 0;
      if (depth < 0.055) continue;
      if (this.terrainType?.[i] !== 3 && depth < 0.085) continue;
      if (hash01(x, y, 301) < 0.18) fishCells.push([x, y, depth]);
    }
    fishCells.sort((a, b) => hash01(a[0], a[1], 311) - hash01(b[0], b[1], 311));
    const fishCount = Math.min(this.perf.fish, fishCells.length);
    for (let k = 0; k < fishCount; k++) {
      const [tx, ty] = fishCells[k];
      const x = tx * TILE, z = ty * TILE;
      const g = this._makeFishSchool(k, tx, ty);
      const phase = hash01(tx, ty, 321) * Math.PI * 2;
      g.position.set(x, this._waterInfoAt(x, z).surface - 0.16, z);
      this.scene.add(g);
      this.fish.push({
        group: g, x, z, ax: x, az: z,
        dir: phase, phase,
        speed: 0.30 + hash01(tx, ty, 331) * 0.32,
        radius: 3.2 + hash01(tx, ty, 341) * 4.2,
        seed: tx * 8191 + ty,
      });
    }

    const birdCount = Math.max(this.perf.birdsMin, Math.min(this.perf.birdsMax, Math.round(Math.min(w, h) / 11)));
    for (let k = 0; k < birdCount; k++) {
      const tx = 8 + Math.floor(hash01(k, 1, 351) * Math.max(1, w - 16));
      const ty = 8 + Math.floor(hash01(k, 2, 351) * Math.max(1, h - 16));
      const x = tx * TILE, z = ty * TILE;
      const g = this._makeBird(k);
      const phase = hash01(k, 3, 351) * Math.PI * 2;
      g.position.set(x, this.heightAt(x, z) + 18 + hash01(k, 4, 351) * 16, z);
      this.scene.add(g);
      this.birds.push({
        group: g, x, z, ax: x, az: z,
        dir: phase,
        phase,
        speed: 5.5 + hash01(k, 5, 351) * 4.5,
        turn: hash01(k, 6, 351) > 0.5 ? 1 : -1,
        altitude: 18 + hash01(k, 7, 351) * 18,
        radius: Math.min(w, h) * (0.23 + hash01(k, 8, 351) * 0.16) * TILE,
      });
    }
  }

  _makeFishSchool(seed, tx, ty) {
    const g = new THREE.Group();
    const count = 5 + (seed % 4);
    for (let i = 0; i < count; i++) {
      const fish = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.035, 0.36), this.natureMats.fish);
      fish.position.set((hash01(tx, ty, 360 + i) - 0.5) * 1.8, (hash01(tx, ty, 370 + i) - 0.5) * 0.12, (hash01(tx, ty, 380 + i) - 0.5) * 1.1);
      fish.rotation.y = (hash01(tx, ty, 390 + i) - 0.5) * 0.45;
      fish.userData.phase = hash01(tx, ty, 400 + i) * Math.PI * 2;
      g.add(fish);
    }
    return g;
  }

  _makeBird(seed) {
    const g = new THREE.Group();
    const body = boxMesh(0.18, 0.08, 0.42, this.natureMats.bird, 0, 0, 0);
    const leftWing = boxMesh(0.46, 0.018, 0.10, this.natureMats.bird, -0.28, 0.0, 0);
    const rightWing = boxMesh(0.46, 0.018, 0.10, this.natureMats.bird, 0.28, 0.0, 0);
    const tail = boxMesh(0.10, 0.025, 0.16, this.natureMats.bird, 0, 0, -0.28);
    g.add(body, leftWing, rightWing, tail);
    g.traverse((m) => { m.castShadow = false; m.receiveShadow = false; });
    g.userData.wings = [leftWing, rightWing];
    g.scale.setScalar(0.85 + hash01(seed, seed, 411) * 0.45);
    return g;
  }

  _updateWildlife(dt) {
    if (!this.wildlife?.length || !this.height) return;
    const step = Math.min(0.05, Math.max(0, dt || 1 / 60));
    let moved = false;
    for (const a of this.wildlife) {
      const home = Math.atan2(a.az - a.z, a.ax - a.x);
      const away = Math.hypot(a.x - a.ax, a.z - a.az) / Math.max(1, a.radius);
      const wobble = Math.sin(this.time * 0.42 + a.phase) * 0.55;
      a.dir = wrapAngle(a.dir + wobble * step + wrapAngle(home - a.dir) * Math.max(0, away - 0.65) * step * 1.8);

      let nx = a.x + Math.cos(a.dir) * a.speed * TILE * step;
      let nz = a.z + Math.sin(a.dir) * a.speed * TILE * step;
      if (away > 1.25 || !this._wildlifeGroundOk(nx, nz)) {
        a.dir = wrapAngle(home + (hash01(a.seed, Math.floor(this.time * 1.7), 271) - 0.5) * 0.65);
        nx = a.x + Math.cos(a.dir) * a.speed * TILE * step;
        nz = a.z + Math.sin(a.dir) * a.speed * TILE * step;
        if (!this._wildlifeGroundOk(nx, nz)) continue;
      }

      a.x = nx; a.z = nz;
      a.group.position.set(a.x, this.heightAt(a.x, a.z) + 0.06, a.z);
      a.group.rotation.y = Math.PI / 2 - a.dir;
      const stride = Math.sin(this.time * 8.0 + a.phase) * 0.42;
      const legs = a.group.userData.legs || [];
      for (let i = 0; i < legs.length; i++) legs[i].rotation.x = stride * (i % 2 ? -1 : 1);
      moved = true;
    }
    if (moved) this._markShadowsDirty(true);
  }

  _updateFish(dt) {
    if (!this.fish?.length || !this.height) return;
    const step = Math.min(0.05, Math.max(0, dt || 1 / 60));
    for (const f of this.fish) {
      const home = Math.atan2(f.az - f.z, f.ax - f.x);
      const away = Math.hypot(f.x - f.ax, f.z - f.az) / Math.max(1, f.radius);
      f.dir = wrapAngle(f.dir + Math.sin(this.time * 0.62 + f.phase) * step * 0.75 + wrapAngle(home - f.dir) * Math.max(0, away - 0.55) * step * 2.1);
      let nx = f.x + Math.cos(f.dir) * f.speed * TILE * step;
      let nz = f.z + Math.sin(f.dir) * f.speed * TILE * step;
      const info = this._waterInfoAt(nx, nz);
      if (away > 1.25 || info.depth < 0.035) {
        f.dir = wrapAngle(home + (hash01(f.seed, Math.floor(this.time * 1.3), 421) - 0.5) * 0.8);
        nx = f.x + Math.cos(f.dir) * f.speed * TILE * step;
        nz = f.z + Math.sin(f.dir) * f.speed * TILE * step;
      }
      const nextInfo = this._waterInfoAt(nx, nz);
      f.group.visible = nextInfo.depth > 0.035;
      if (!f.group.visible) continue;
      f.x = nx; f.z = nz;
      f.group.position.set(f.x, nextInfo.surface - 0.14 - Math.sin(this.time * 1.7 + f.phase) * 0.035, f.z);
      f.group.rotation.y = Math.PI / 2 - f.dir;
      for (const fish of f.group.children) fish.rotation.y = Math.sin(this.time * 4.6 + fish.userData.phase) * 0.22;
    }
  }

  _updateBirds(dt) {
    if (!this.birds?.length || !this.height) return;
    const step = Math.min(0.05, Math.max(0, dt || 1 / 60));
    const cx = this.mapW * TILE * 0.5, cz = this.mapH * TILE * 0.5;
    for (const b of this.birds) {
      const toCenter = Math.atan2(cz - b.z, cx - b.x);
      const far = Math.hypot(b.x - cx, b.z - cz) > b.radius * 1.7;
      b.dir = wrapAngle(b.dir + b.turn * (0.12 + Math.sin(this.time * 0.18 + b.phase) * 0.06) * step + (far ? wrapAngle(toCenter - b.dir) * step * 2.0 : 0));
      b.x += Math.cos(b.dir) * b.speed * step;
      b.z += Math.sin(b.dir) * b.speed * step;
      const y = this.heightAt(b.x, b.z) + b.altitude + Math.sin(this.time * 0.9 + b.phase) * 1.8;
      b.group.position.set(b.x, y, b.z);
      b.group.rotation.y = Math.PI / 2 - b.dir;
      b.group.rotation.z = Math.sin(this.time * 0.55 + b.phase) * 0.08;
      const flap = Math.sin(this.time * 8.0 + b.phase) * 0.75;
      const wings = b.group.userData.wings || [];
      if (wings[0]) wings[0].rotation.z = flap;
      if (wings[1]) wings[1].rotation.z = -flap;
    }
  }

  _wildlifeGroundOk(wx, wz) {
    const gx = Math.round(wx / TILE), gy = Math.round(wz / TILE);
    if (gx < 1 || gy < 1 || gx >= this.mapW - 1 || gy >= this.mapH - 1) return false;
    const idx = gy * this.mapW + gx;
    const water = Math.max(this.waterBase?.[idx] || 0, this.waterDepth?.[idx] || 0);
    return this.terrainType?.[idx] === 0
      && water <= 0.018
      && this.height[idx] > (this.seaLevel ?? 0.28) + 0.05
      && this.height[idx] < 0.78
      && this._slopeAt(idx) < 0.085;
  }

  _isNearSeaCell(gx, gy, radius = 2, typeArr = this.terrainType) {
    const w = this.mapW, h = this.mapH;
    if (!typeArr || !w || !h) return false;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (typeArr[ny * w + nx] === 3) return true;
    }
    return false;
  }

  _makeEmptyWaterGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute('aSea', new THREE.Float32BufferAttribute([], 1));
    geo.setIndex([]);
    return geo;
  }

  _setWaterGeometryRefs(geo, seaIndices = []) {
    this._waterPosAttr = geo.attributes.position || null;
    this._waterSeaAttr = geo.attributes.aSea || null;
    this._waterWaveBase = null;
    this._waterSeaIndices = seaIndices;
  }

  _writeWaterCellData(idx, renderDepth, surface, flowX, flowZ) {
    const terrainY = this.height[idx] * HEIGHT_SCALE;
    const clear = WATER_SURFACE_CLEAR;
    const surf = Math.max((this.height[idx] + renderDepth) * HEIGHT_SCALE, terrainY + clear);
    const flow = this._waterFlowAt(idx);
    surface[idx] = surf;
    flowX[idx] = flow.x;
    flowZ[idx] = flow.z;
  }

  _waterColorForDepth(depth, cover = 1, sea = 0, edgeOpen = 0) {
    const seaAmt = Math.max(0, Math.min(1, sea));
    const openSea = seaAmt * Math.max(0, Math.min(1, edgeOpen));
    const effectiveDepth = seaAmt > 0.35 ? Math.max(depth, 0.18 + openSea * 0.34) : depth;
    const depthDark = smoothstep(WATER_DARK_DEPTH_START, WATER_DARK_DEPTH_START + WATER_DARK_DEPTH_RANGE, effectiveDepth);
    const deep = Math.max(depthDark, openSea * 0.92);
    const shallow = 1 - deep;
    const shore = seaAmt > 0.35
      ? shallow * (1 - openSea) * 0.28
      : Math.max(0, Math.min(1, (0.72 - cover) / 0.26)) * 0.22;
    return {
      r: Math.min(1, Math.max(0.045, 0.08 + shallow * 0.54 + shore * 0.08)),
      g: Math.min(1, Math.max(0.16, 0.20 + shallow * 0.58 + shore * 0.07)),
      b: Math.min(1, Math.max(0.30, 0.34 + shallow * 0.60 + shore * 0.04)),
    };
  }

  _seaEdgeOpenAt(wx, wz) {
    if (!this.mapW || !this.mapH) return 0;
    const gx = wx / TILE, gy = wz / TILE;
    const d = Math.min(gx, gy, this.mapW - 1 - gx, this.mapH - 1 - gy);
    return 1 - smoothstep(2, Math.max(8, Math.min(this.mapW, this.mapH) * 0.075), d);
  }

  _isSeaWaterCell(idx, depth = 0) {
    if (this.terrainType?.[idx] !== 3 || !this.height) return false;
    return this.height[idx] <= (this.seaLevel ?? 0.28) + 0.025
      && Math.max(depth, this.waterBase?.[idx] || 0) > 0.012;
  }

  _stabilizeWaterSurfaces(visible, surface, flowX = null, flowZ = null, seaVis = null) {
    const w = this.mapW, h = this.mapH, n = w * h;
    if (!this._waterSurfaceVisual || this._waterSurfaceVisual.length !== n) this._waterSurfaceVisual = new Float32Array(n);
    const visual = this._waterSurfaceVisual;
    const seen = new Uint8Array(n);
    const broadSeen = new Uint8Array(n);
    const stack = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    for (let i = 0; i < n; i++) {
      if (!visible[i] || broadSeen[i]) continue;
      const cells = [];
      const levels = [];
      let hasSea = false, hasChannel = false, maxFlow = 0;
      broadSeen[i] = 1;
      stack.length = 0;
      stack.push(i);
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        levels.push(surface[cur]);
        hasSea = hasSea || (seaVis ? seaVis[cur] > 0.35 : this._isSeaWaterCell(cur, this.waterDepth?.[cur] || 0));
        hasChannel = hasChannel || (this.terrainType?.[cur] === 3 && (this.waterBase?.[cur] || 0) > WATER_SHOW_DEPTH * 0.75 && !hasSea);
        maxFlow = Math.max(maxFlow, Math.hypot(flowX?.[cur] || 0, flowZ?.[cur] || 0));
        const x = cur % w, y = (cur / w) | 0;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (broadSeen[j] || !visible[j]) continue;
          broadSeen[j] = 1;
          stack.push(j);
        }
      }
      if (hasSea || hasChannel || maxFlow > WATER_STANDING_FLOW_MAX || cells.length < 2) continue;
      levels.sort((a, b) => a - b);
      let target = levels[Math.min(levels.length - 1, Math.floor(levels.length * WATER_STANDING_LEVEL_QUANTILE))] || surface[i];
      if (WATER_PLANE_QUANT > 0) target = Math.round(target / WATER_PLANE_QUANT) * WATER_PLANE_QUANT;
      for (const cell of cells) {
        const minY = this.height[cell] * HEIGHT_SCALE + WATER_SURFACE_CLEAR;
        const cellTarget = target >= minY ? target : Math.max(surface[cell], minY);
        const prev = visual[cell] || cellTarget;
        const alpha = cellTarget > prev ? WATER_PLANE_RISE_SMOOTH : WATER_PLANE_FALL_SMOOTH;
        const next = Math.abs(cellTarget - prev) <= WATER_PLANE_DEADBAND
          ? prev
          : prev + (cellTarget - prev) * alpha;
        visual[cell] = next;
        surface[cell] = next;
        seen[cell] = 1;
      }
    }

    for (let i = 0; i < n; i++) {
      if (!visible[i]) { visual[i] = 0; continue; }
      if (seen[i]) continue;
      const cells = [];
      const levels = [];
      let hasSea = false;
      const seedSurface = surface[i];
      seen[i] = 1;
      stack.length = 0;
      stack.push(i);
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        levels.push(surface[cur]);
        hasSea = hasSea || (seaVis ? seaVis[cur] > 0.35 : this.terrainType?.[cur] === 3);
        const x = cur % w, y = (cur / w) | 0;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (seen[j] || !visible[j]) continue;
          if (Math.abs(surface[j] - seedSurface) > WATER_PLANE_LINK_EPS) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      levels.sort((a, b) => a - b);
      const sample = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.55))] || seedSurface;
      let target = hasSea ? (this.seaY ?? sample) : sample;
      if (WATER_PLANE_QUANT > 0) target = Math.round(target / WATER_PLANE_QUANT) * WATER_PLANE_QUANT;
      for (const cell of cells) {
        const minY = this.height[cell] * HEIGHT_SCALE + WATER_SURFACE_CLEAR;
        const cellTarget = target >= minY ? target : Math.max(surface[cell], minY);
        const prev = visual[cell] || cellTarget;
        const alpha = cellTarget > prev ? WATER_PLANE_RISE_SMOOTH : WATER_PLANE_FALL_SMOOTH;
        const next = Math.abs(cellTarget - prev) <= WATER_PLANE_DEADBAND
          ? prev
          : prev + (cellTarget - prev) * alpha;
        visual[cell] = next;
        surface[cell] = next;
      }
    }
  }

  _rebuildWaterMesh() {
    if (!this.waterMesh || !this.waterDepth || !this.height) return;
    const w = this.mapW, h = this.mapH, n = w * h;
    if (!w || !h) return;

    const visible = new Uint8Array(n);
    // Weiche Zell-Deckung 0..1 (statt binär): eine gerade auftauchende Flut-/Abflusszelle wächst
    // mit ihrer Tiefe von 0 auf voll ein → die Wasserkante gleitet, statt dass Dreiecke aufpoppen.
    const cellCov = new Float32Array(n);
    const surface = new Float32Array(n);
    const flowX = new Float32Array(n);
    const flowZ = new Float32Array(n);
    const depthVis = new Float32Array(n);
    const seaVis = new Float32Array(n);

    let visibleCount = 0;
    let covMoving = false;
    const covState = this._wetCov;
    for (let i = 0; i < n; i++) {
      const depth = this.waterDepth[i] || 0;
      const renderDepth = this._renderWaterDepth(i, depth);
      const permanent = this._isPermanentWaterCell(i);
      // ZIEL-Deckung: permanentes Wasser voll; transientes blendet über die Tiefe ein; nicht
      // sichtbar/zu flach → 0.
      const target = renderDepth <= 0.012 ? 0
        : permanent ? 1
          : smoothstep(0.024, 0.090, depth);
      // ANTI-PING-PONG: die Deckung wird ZEITLICH geglättet — schnell rein, aber LANGSAM raus.
      // Dadurch verschwindet ein Polygon nicht abrupt, wenn die Sim-Tiefe kurz unter die Schwelle
      // wackelt, und taucht nicht sofort wieder auf (kein Flackern). Es blendet weich aus/ein.
      const prev = covState[i] || 0;
      let cov = target > prev ? prev + (target - prev) * 0.34 : prev + (target - prev) * 0.085;
      if (cov < 0.012) cov = 0;
      else if (cov > 0.992) cov = 1;
      covState[i] = cov;
      if (cov <= 0) continue;
      // Auch eine ausblendende Zelle (Sim-Tiefe schon unter der Render-Schwelle) bleibt im Mesh,
      // solange ihre Deckung noch ausläuft — mit ihrer tatsächlichen (sinkenden) Tiefe.
      const dv = Math.max(renderDepth, depth, FLOOD_SURFACE_DEPTH * 0.5);
      visible[i] = 1;
      visibleCount++;
      depthVis[i] = dv;
      seaVis[i] = this._isSeaWaterCell(i, dv) ? 1 : 0;
      cellCov[i] = cov;
      if (Math.abs(cov - target) > 0.004) covMoving = true; // Deckung noch im Übergang → weiter animieren
      this._writeWaterCellData(i, dv, surface, flowX, flowZ);
    }
    this._covAnimating = covMoving;

    // Optische Schließung: schmale, einzelne Trockenlücken zwischen nassen Zellen werden als
    // Wasserhaut überbrückt. Das ändert nicht die Simulation, verhindert aber das blau-schwarze
    // Zellmuster an Flut- und Schneeschmelzfronten.
    for (let pass = 0; pass < 2; pass++) {
      const source = visible.slice();
      const sourceAt = (x, y) => x >= 0 && y >= 0 && x < w && y < h && source[y * w + x];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (visible[i]) continue;
        const l = sourceAt(x - 1, y), r = sourceAt(x + 1, y);
        const u = sourceAt(x, y - 1), d = sourceAt(x, y + 1);
        const ul = sourceAt(x - 1, y - 1), ur = sourceAt(x + 1, y - 1);
        const dl = sourceAt(x - 1, y + 1), dr = sourceAt(x + 1, y + 1);
        const n4 = (l ? 1 : 0) + (r ? 1 : 0) + (u ? 1 : 0) + (d ? 1 : 0);
        const n8 = n4 + (ul ? 1 : 0) + (ur ? 1 : 0) + (dl ? 1 : 0) + (dr ? 1 : 0);
        const bridged = (l && r) || (u && d) || (ul && dr) || (ur && dl);
        if (!(bridged || n4 >= 3 || n8 >= (pass === 0 ? 5 : 6))) continue;

        let count = 0, surfSum = 0, flowSumX = 0, flowSumZ = 0, depthSum = 0, seaSum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!source[j]) continue;
          count++;
          surfSum += surface[j];
          flowSumX += flowX[j];
          flowSumZ += flowZ[j];
          depthSum += depthVis[j];
          seaSum += seaVis[j];
        }
        if (!count) continue;
        const avgSurf = surfSum / count;
        if (this.height[i] * HEIGHT_SCALE + WATER_SURFACE_CLEAR > avgSurf + WATER_EDGE_CLOSE_MAX_LIFT) continue;
        visible[i] = 1;
        cellCov[i] = 1; // überbrückte Lückenfüllung = Innenfläche, volle Deckung
        visibleCount++;
        surface[i] = Math.max(avgSurf, this.height[i] * HEIGHT_SCALE + WATER_SURFACE_CLEAR);
        flowX[i] = flowSumX / count;
        flowZ[i] = flowSumZ / count;
        depthVis[i] = depthSum / count;
        seaVis[i] = seaSum / count;
      }
    }
    this._stabilizeWaterSurfaces(visible, surface, flowX, flowZ, seaVis);

    if (!visibleCount) {
      const old = this.waterMesh.geometry;
      const geo = this._makeEmptyWaterGeometry();
      this.waterMesh.geometry = geo;
      if (old && old !== geo) old.dispose();
      this._setWaterGeometryRefs(geo, []);
      return;
    }

    const positions = [], uvs = [], colors = [], seaVals = [], indices = [];
    const seaIndices = [];
    const fw = w + 1, fh = h + 1, fn = fw * fh;
    const cover = new Float32Array(fn);
    const cornerSurface = new Float32Array(fn);
    const cornerFlowX = new Float32Array(fn);
    const cornerFlowZ = new Float32Array(fn);
    const cornerDepth = new Float32Array(fn);
    const cornerSea = new Float32Array(fn);
    const cornerX = (cx) => Math.max(0, Math.min((w - 1) * TILE, (cx - 0.5) * TILE));
    const cornerZ = (cy) => Math.max(0, Math.min((h - 1) * TILE, (cy - 0.5) * TILE));
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    for (let cy = 0; cy < fh; cy++) for (let cx = 0; cx < fw; cx++) {
      const px = cx - 0.5, py = cy - 0.5;
      let totalWeight = 0, waterWeight = 0, surfSum = 0, flowSumX = 0, flowSumZ = 0, depthSum = 0, seaSum = 0;
      let surfaceFloor = 0;
      for (let yy = Math.max(0, cy - 2); yy <= Math.min(h - 1, cy + 1); yy++) {
        for (let xx = Math.max(0, cx - 2); xx <= Math.min(w - 1, cx + 1); xx++) {
          const dx = xx - px, dy = yy - py, d2 = dx * dx + dy * dy;
          if (d2 > 3.25) continue;
          const weight = d2 <= 0.55 ? 1 : d2 <= 1.65 ? 0.42 : 0.14;
          totalWeight += weight;
          const idx = yy * w + xx;
          if (!visible[idx]) continue;
          const wc = weight * cellCov[idx]; // weiche Deckung → Kante gleitet statt zu poppen
          if (wc <= 0) continue;
          waterWeight += wc;
          surfSum += surface[idx] * wc;
          surfaceFloor = Math.max(surfaceFloor, this.height[idx] * HEIGHT_SCALE + WATER_SURFACE_CLEAR);
          flowSumX += flowX[idx] * wc;
          flowSumZ += flowZ[idx] * wc;
          depthSum += depthVis[idx] * wc;
          seaSum += seaVis[idx] * wc;
        }
      }
      const key = cy * fw + cx;
      const nearestX = Math.max(0, Math.min(w - 1, Math.round(px)));
      const nearestY = Math.max(0, Math.min(h - 1, Math.round(py)));
      const nearest = nearestY * w + nearestX;
      cover[key] = totalWeight > 0 ? waterWeight / totalWeight : 0;
      cornerSurface[key] = waterWeight > 0
        ? Math.max(surfSum / waterWeight, surfaceFloor)
        : (surface[nearest] || this.height[nearest] * HEIGHT_SCALE + WATER_SURFACE_CLEAR);
      cornerFlowX[key] = waterWeight > 0 ? flowSumX / waterWeight : 0;
      cornerFlowZ[key] = waterWeight > 0 ? flowSumZ / waterWeight : 0;
      cornerDepth[key] = waterWeight > 0 ? depthSum / waterWeight : (depthVis[nearest] || 0);
      cornerSea[key] = waterWeight > 0 ? seaSum / waterWeight : (seaVis[nearest] || 0);
    }

    const corner = (cx, cy) => {
      const key = cy * fw + cx;
      return {
        x: cornerX(cx),
        z: cornerZ(cy),
        v: cover[key],
        y: cornerSurface[key],
        fx: cornerFlowX[key],
        fz: cornerFlowZ[key],
        depth: cornerDepth[key],
        sea: cornerSea[key],
      };
    };
    const lerpPoint = (a, b) => {
      const span = b.v - a.v;
      const t = clamp01(Math.abs(span) > 1e-6 ? (WATER_EDGE_THRESHOLD - a.v) / span : 0.5);
      const waterSide = a.v >= WATER_EDGE_THRESHOLD ? a : b;
      const drySide = a.v >= WATER_EDGE_THRESHOLD ? b : a;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const dryGround = this.heightAt(drySide.x, drySide.z);
      const ground = Math.max(this.heightAt(x, z), Math.min(waterSide.y, dryGround));
      return {
        x,
        z,
        v: WATER_EDGE_THRESHOLD,
        y: Math.min(waterSide.y, ground + WATER_EDGE_TUCK_Y),
        fx: a.fx + (b.fx - a.fx) * t,
        fz: a.fz + (b.fz - a.fz) * t,
        depth: a.depth + (b.depth - a.depth) * t,
        sea: a.sea + (b.sea - a.sea) * t,
      };
    };
    const clipWaterPoly = (poly) => {
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const ai = a.v >= WATER_EDGE_THRESHOLD, bi = b.v >= WATER_EDGE_THRESHOLD;
        if (ai && bi) out.push(b);
        else if (ai && !bi) out.push(lerpPoint(a, b));
        else if (!ai && bi) {
          out.push(lerpPoint(a, b));
          out.push(b);
        }
      }
      return out;
    };
    const pushWaterVertex = (p) => {
      const vx = positions.length / 3;
      positions.push(p.x, p.y, p.z);
      const fl = Math.hypot(p.fx, p.fz);
      const dirX = fl > 0.012 ? p.fx / fl : 0.82;
      const dirZ = fl > 0.012 ? p.fz / fl : 0.36;
      const sideX = -dirZ;
      const sideZ = dirX;
      const uvScale = 0.105;
      uvs.push((p.x * sideX + p.z * sideZ) * uvScale, (p.x * dirX + p.z * dirZ) * uvScale);
      const edgeOpen = p.sea > 0.35 ? this._seaEdgeOpenAt(p.x, p.z) : 0;
      const c = this._waterColorForDepth(p.depth, p.v, p.sea, edgeOpen);
      colors.push(c.r, c.g, c.b);
      const seaVal = Math.max(0, Math.min(1, p.sea));
      seaVals.push(seaVal);
      if (seaVal > 0.35) seaIndices.push(vx);
      return vx;
    };

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const poly = clipWaterPoly([
        corner(x, y),
        corner(x + 1, y),
        corner(x + 1, y + 1),
        corner(x, y + 1),
      ]);
      if (poly.length < 3) continue;
      const base = positions.length / 3;
      for (const p of poly) pushWaterVertex(p);
      for (let k = 1; k < poly.length - 1; k++) indices.push(base, base + k, base + k + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aSea', new THREE.Float32BufferAttribute(seaVals, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    const old = this.waterMesh.geometry;
    this.waterMesh.geometry = geo;
    if (old && old !== geo) old.dispose();
    this._setWaterGeometryRefs(geo, seaIndices);
  }

  _renderWaterDepth(idx, depth) {
    if (depth <= 0.012) {
      if (!this._isPermanentWaterCell(idx) && this._floodShown) this._floodShown[idx] = 0;
      return 0;
    }
    if (!this._isPermanentWaterCell(idx)) {
      if (this._waterShown) this._waterShown[idx] = 0;
      return this._floodOverlayDepth(idx, depth, true);
    }
    // Hysterese gegen Ufer-Flackern: eine Zelle wird erst ab klarer Tiefe als Wasser gezeigt
    // und erst weit darunter wieder versteckt. So toggelt eine Uferzelle, deren Sim-Tiefe um
    // die Nässe-Schwelle pendelt, nicht jeden Snapshot zwischen Gras und Wasser.
    const shown = this._waterShown;
    // Binnenwasser erst ab echter Nässe zeigen (deutlich über WET_DEPTH≈0.035). Dünne
    // Feuchtefilme/abklingende Rinnsale werden NICHT als Wasser gezeichnet — sonst entsteht
    // das fleckige „Labyrinth" aus halbnassen Zellen über das ganze Gelände. Hysterese gegen Flackern.
    const sea = this.seaLevel ?? 0.28;
    const open = this.terrainType?.[idx] === 3 || this.height[idx] + depth <= sea + 0.03;
    const stableInland = this._isPermanentWaterCell(idx) && this.terrainType?.[idx] !== 3;
    const showDepth = stableInland ? 0.030 : WATER_SHOW_DEPTH;
    const hideDepth = stableInland ? 0.020 : WATER_HIDE_DEPTH;
    let vis;
    if (open) vis = depth > 0.006;
    else if (depth >= showDepth) vis = true;
    else if (depth <= hideDepth) vis = false;
    else vis = shown ? !!shown[idx] : depth > (stableInland ? 0.026 : 0.04); // im Hysterese-Band: Zustand halten
    if (vis && !open && depth < showDepth) {
      // im Übergang nur halten, wenn genug klar nasse Nachbarn da sind (zusammenhängendes
      // Gewässer statt verstreuter Einzel-Pixel)
      const w = this.mapW, h = this.mapH, x = idx % w, y = (idx / w) | 0;
      let wetN = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if ((this.waterDepth[ny * w + nx] || 0) > hideDepth) wetN++;
      }
      if (wetN < (stableInland ? 1 : 3)) vis = false;
    }
    if (shown) shown[idx] = vis ? 1 : 0;
    return vis ? depth : 0;
  }

  _isPermanentWaterCell(idx) {
    return !!(this._permanentWater?.[idx] || this.terrainType?.[idx] === 3);
  }

  _visibleWaterDepth(idx) {
    const depth = this.waterDepth?.[idx] || 0;
    if (depth <= 0.012) return 0;
    if (this._isPermanentWaterCell(idx)) return depth;
    return this._floodOverlayDepth(idx, depth);
  }

  _floodOverlayDepth(idx, depth, commit = false) {
    if (!this._floodVisual || this._isPermanentWaterCell(idx)) return 0;
    const wet = this._floodVisual[idx] || 0;
    const shown = this._floodShown;
    const vis = (shown?.[idx] ? wet > FLOOD_VIS_HIDE : wet > FLOOD_VIS_SHOW) && depth >= FLOOD_SURFACE_DEPTH;
    if (commit && shown) shown[idx] = vis ? 1 : 0;
    return vis ? Math.max(depth, FLOOD_SURFACE_DEPTH) : 0;
  }

  _floodSourceStrength(idx, depth) {
    if (!this.height || this._isPermanentWaterCell(idx) || depth <= FLOOD_RUNOFF_DEPTH) return 0;
    const w = this.mapW, h = this.mapH, x = idx % w, y = (idx / w) | 0;
    let wetNear = 0, wetWide = 0, nearPermanent = false;
    let maxDownhill = 0, maxUphill = 0, higherGroundNear = 0;
    const s0 = this.height[idx] + depth;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      const d = this.waterDepth[j] || 0;
      if (d > WATER_HIDE_DEPTH) {
        wetWide++;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) wetNear++;
      }
      if (this._isPermanentWaterCell(j) && d > 0.012) nearPermanent = true;
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        const dist = dx && dy ? Math.SQRT2 : 1;
        const grad = (s0 - (this.height[j] + d)) / dist;
        maxDownhill = Math.max(maxDownhill, grad);
        maxUphill = Math.max(maxUphill, -grad);
        if (this.height[j] > this.height[idx] + 0.024) higherGroundNear++;
      }
    }
    const slope = this._slopeAt(idx);
    const dug = this.height0 && this.height0[idx] - this.height[idx] > 0.030;
    const basin = depth >= 0.080 && slope <= 0.035 && wetWide >= 11 && wetNear >= 3;
    const overflow = depth >= 0.095 && nearPermanent && slope <= 0.065 && wetWide >= 9 && wetNear >= 3;
    const deepPool = slope <= 0.05 && depth >= 0.17 && wetWide >= 6;
    const channel = depth >= FLOOD_CHANNEL_DEPTH
      && wetWide >= (dug ? 1 : 2)
      && (dug || higherGroundNear >= 2 || maxUphill > 0.024);
    const runoff = depth >= 0.030     // schon dünnes Ablaufwasser zeigen, solange es WIRKLICH abläuft
      && wetNear >= 2
      && nearPermanent
      && maxDownhill > 0.012
      && slope > 0.020;
    if (!basin && !overflow && !deepPool && !channel && !runoff) return 0;
    const strength = channel
      ? (depth - FLOOD_RUNOFF_DEPTH) / 0.09 + Math.min(0.38, maxUphill * 10) + (dug ? 0.22 : 0)
      : basin || overflow || deepPool
      ? (depth - 0.055) / 0.18
      : (depth - FLOOD_RUNOFF_DEPTH) / 0.12 + Math.min(0.35, maxDownhill * 14);
    return Math.max(0, Math.min(1, strength));
  }

  _refreshFloodVisualMask(force = false) {
    if (!this.waterDepth || !this._floodVisual || !this._floodGoal || !this._floodScratch) return false;
    const n = this.waterDepth.length, w = this.mapW, h = this.mapH;
    const goal = this._floodGoal, scratch = this._floodScratch, visual = this._floodVisual;
    for (let i = 0; i < n; i++) goal[i] = this._floodSourceStrength(i, this.waterDepth[i] || 0);

    // Spatial closing: fills narrow gaps and turns isolated sim cells into coherent flood fronts.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (this._isPermanentWaterCell(i)) { scratch[i] = 0; continue; }
      let sum = goal[i] * 2.0, count = 2.0, maxN = goal[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const g = goal[ny * w + nx] || 0;
        sum += g; count++;
        if (g > maxN) maxN = g;
      }
      const avg = sum / count;
      scratch[i] = maxN > 0.35 && avg > 0.14 ? Math.max(goal[i], avg * 0.92) : goal[i] * 0.72;
    }

    let changed = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let target = scratch[i] || 0;
      let maxFront = 0, nearPermanent = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        maxFront = Math.max(maxFront, visual[j] || 0);
        if (this._isPermanentWaterCell(j)) nearPermanent = true;
      }
      // New water advances from existing water/fronts; strong pooled basins may seed themselves.
      if (target > visual[i] && !nearPermanent && maxFront < 0.08 && target < 0.82) target = Math.min(target, visual[i] + 0.08);
      const rate = target > visual[i] ? (nearPermanent || maxFront > 0.18 ? 0.34 : 0.18) : 0.22;
      const next = force ? target : visual[i] + (target - visual[i]) * rate;
      if (Math.abs(next - visual[i]) > 0.018) changed = true;
      visual[i] = next < 0.018 ? 0 : next;
    }
    return changed || force;
  }

  _refreshWetGroundOverlay() {
    if (!this.wetGroundMesh || !this.waterDepth || !this.height || !this._floodDummy) return;
    if (this.wetGroundMesh.count !== 0) {
      this.wetGroundMesh.count = 0;
      this.wetGroundMesh.instanceMatrix.needsUpdate = true;
    }
    const n = this.waterDepth.length, w = this.mapW, h = this.mapH;
    if (!this._wetAmount || this._wetAmount.length !== n) this._wetAmount = new Float32Array(n);
    if (!this._wetScratch || this._wetScratch.length !== n) this._wetScratch = new Float32Array(n);
    const wet = this._wetAmount, scratch = this._wetScratch;
    scratch.fill(0);
    for (let i = 0; i < n; i++) {
      if (this._isPermanentWaterCell(i)) continue;
      const depth = this.waterDepth[i] || 0;
      if (depth <= WET_GROUND_MIN_DEPTH || this._floodOverlayDepth(i, depth) > 0) continue;
      const gx = i % w, gy = (i / w) | 0;
      const wetDepth = smoothstep(WET_GROUND_MIN_DEPTH, WET_GROUND_FULL_DEPTH, depth);
      const flow = this._waterFlowAt(i);
      const flowMag = Math.hypot(flow.x, flow.z);
      let wetN = 0, nearPermanent = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (this._isPermanentWaterCell(j)) nearPermanent = true;
        else if ((this.waterDepth[j] || 0) > WET_GROUND_NEIGHBOR_DEPTH) wetN++;
      }
      // Strömung stark gewichten: entlang der Abfluss-/Partikelströme wird der Boden deutlich nass
      // eingefärbt, auch wo das Wasser zu dünn für eine eigene Oberfläche ist.
      const visual = Math.min(1, wetDepth * 0.62 + flowMag * 0.85 + (this._floodVisual?.[i] || 0) * 0.36);
      if (visual <= 0.02) continue;
      if (!nearPermanent && wetN < 1 && flowMag < 0.05 && visual < 0.14) continue;
      scratch[i] = Math.max(scratch[i], visual);
    }
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (Math.abs(wet[i] - scratch[i]) > 0.018) { changed = true; break; }
    }
    if (changed) {
      wet.set(scratch);
      this._rebuildTerrainBaseColors();
    }
  }

  _waterFlowAt(idx) {
    const w = this.mapW, h = this.mapH;
    if (!w || !h || !this.height) return { x: 0, z: 0 };
    const x = idx % w, y = (idx / w) | 0;
    const depth = this.waterDepth?.[idx] || 0;
    const openSea = this.terrainType?.[idx] === 3 && this.height[idx] + depth <= (this.seaLevel ?? 0.28) + 0.03;
    if (openSea || depth <= 0.012) return { x: 0, z: 0 };
    const s0 = this.height[idx] + depth;
    let vx = 0, vz = 0, weightSum = 0, maxGrad = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = x + dx, ny = y + dz;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      const dist = dx && dz ? Math.SQRT2 : 1;
      const grad = (s0 - (this.height[j] + (this.waterDepth[j] || 0))) / dist;
      if (grad <= 0.0015) continue;
      const weight = grad / dist;
      vx += (dx / dist) * weight;
      vz += (dz / dist) * weight;
      weightSum += weight;
      maxGrad = Math.max(maxGrad, grad);
    }
    const mag = Math.hypot(vx, vz);
    if (!weightSum || mag < 0.0001) return { x: 0, z: 0 };
    const strength = Math.min(1, (maxGrad - 0.0015) * 42 + Math.min(0.16, depth) * 2.4);
    return { x: (vx / mag) * strength, z: (vz / mag) * strength };
  }

  _animateSeaWaterMesh() {
    const pos = this._waterPosAttr;
    const sea = this._waterSeaAttr;
    const seaIndices = this._waterSeaIndices;
    if (!pos || !sea || !pos.array || !sea.array || !pos.count || !seaIndices?.length) return;
    const step = this.camDist > 360
      ? 0.16
      : this.camDist > 240
      ? Math.max(0.09, this.perf?.waterAnimStep || 0)
      : (this.perf?.waterAnimStep || 0);
    if (step > 0) {
      this._waterAnimT = (this._waterAnimT || 0) + (this._lastDt || 1 / 60);
      if (this._waterAnimT < step) return;
      this._waterAnimT = 0;
    }
    if (!this._waterWaveBase || this._waterWaveBase.length !== pos.count) {
      this._waterWaveBase = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) this._waterWaveBase[i] = pos.array[i * 3 + 1];
    }
    const arr = pos.array;
    const seaArr = sea.array;
    let changed = false;
    for (let n = 0; n < seaIndices.length; n++) {
      const i = seaIndices[n];
      const baseY = this._waterWaveBase[i];
      const si = seaArr[i] || 0;
      const y = baseY + this._seaWaveUnchecked(arr[i * 3], arr[i * 3 + 2]) * si;
      if (Math.abs(arr[i * 3 + 1] - y) > 0.0005) {
        arr[i * 3 + 1] = y;
        changed = true;
      }
    }
    if (changed) pos.needsUpdate = true;
  }

  _refreshFloodOverlay() {
    if (!this.floodMesh || !this.waterDepth || !this.height || !this._floodDummy) return;
    if (this.floodMesh.count !== 0) {
      this.floodMesh.count = 0;
      this.floodMesh.instanceMatrix.needsUpdate = true;
    }
    this.floodMesh.visible = false;
  }

  // Dynamisches Wasser aus dem Snapshot: dauerhafte Gewässer aktualisieren ihr Oberflächenmesh;
  // temporäre Fluten werden nur als größere, flache Staubereiche ins Mesh übernommen.
  updateWater(delta) {
    if (!this.floodMesh || !this.height || !this.waterDepth) return;
    // Snapshot liefert nur ZIELtiefen. Die sichtbare Tiefe (waterDepth) gleitet in animateWater
    // pro Frame in kleinen Schritten dorthin — so breitet sich Wasser fließend aus, statt alle
    // 250 ms ruckartig zu springen. Hier werden nur die Ziele und die zu animierenden Zellen gesetzt.
    const sig = delta ? this._cellListSig(delta) : '0';
    if (sig === this._waterDeltaSig) return;
    this._waterDeltaSig = sig;
    const touched = [];
    const cur = new Set();
    if (delta) for (let n = 0; n < delta.length; n += 2) {
      const idx = delta[n], depth = (delta[n + 1] / 255) * 0.7;
      cur.add(idx);
      this.waterTarget[idx] = depth;
      touched.push(idx);
    }
    for (const idx of this._waterOverrides) {
      if (cur.has(idx)) continue;
      this.waterTarget[idx] = this.waterBase[idx];   // weggefallene Flutzelle: zurück auf Basistiefe
      touched.push(idx);
    }
    this._waterOverrides = cur;
    for (const idx of touched) {
      if (Math.abs(this.waterTarget[idx] - this.waterDepth[idx]) > WATER_EASE_SNAP) this._waterEasing.add(idx);
    }
    this._floodMaskSettled = false;   // Flutmaske muss neu einschwingen
  }

  // Pro-Frame-Glättung: zieht waterDepth in kleinen Schritten an waterTarget heran und schwingt
  // die Flut-Overlay-Maske weich ein. Kostet nichts, sobald alles eingerastet ist.
  animateWater(dt) {
    if (!this.waterMesh || !this.waterDepth || !this._waterEasing) return;
    if (!this._waterEasing.size && this._floodMaskSettled && !this._covAnimating) return;
    this._waterAnimAccum += dt;
    if (this._waterAnimAccum < WATER_ANIM_INTERVAL) return;
    const step = this._waterAnimAccum;
    this._waterAnimAccum = 0;
    const k = 1 - Math.exp(-WATER_EASE_RATE * step);
    let depthChanged = false;
    for (const idx of this._waterEasing) {
      const target = this.waterTarget[idx];
      const diff = target - this.waterDepth[idx];
      if (Math.abs(diff) <= WATER_EASE_SNAP) {
        this.waterDepth[idx] = target;
        this._waterEasing.delete(idx);
      } else {
        this.waterDepth[idx] += diff * k;
      }
      depthChanged = true;
    }
    const maskChanged = this._refreshFloodVisualMask(false);
    this._floodMaskSettled = !maskChanged;
    if (depthChanged || maskChanged || this._covAnimating) {
      this._rebuildWaterMesh();   // setzt _covAnimating neu (läuft, bis alle Deckungen ausgeglichen sind)
      this._updateRockWaterTint();
      this._refreshWetGroundOverlay();
      this._refreshFloodOverlay();
    }
  }

  _updateRockWaterTint() {
    const state = this._rockWaterTint;
    if (!state?.inst?.instanceColor || !this.waterDepth) return;
    const tint = this._rockTintScratch || (this._rockTintScratch = new THREE.Color());
    let changed = false;
    for (let k = 0; k < state.cells.length; k++) {
      const idx = state.cells[k];
      const depth = this.waterDepth[idx] || 0;
      const f = smoothstep(WATER_SHOW_DEPTH * 0.65, WATER_SHOW_DEPTH * 2.8, depth);
      const o = k * 3;
      tint.setRGB(state.baseColors[o], state.baseColors[o + 1], state.baseColors[o + 2]);
      if (f > 0.01) {
        tint.lerp(UNDERWATER_OBJECT_TINT, f * 0.68);
        tint.multiplyScalar(1 - f * 0.34);
      }
      state.inst.setColorAt(k, tint);
      changed = true;
    }
    if (changed) state.inst.instanceColor.needsUpdate = true;
  }

  updateGroundWear(list) {
    if (!this.trackMesh || !this.height || !list) return;
    const sig = list.length + ':' + (list.length ? list[list.length - 1] : 0);
    if (sig === this._groundSig) return;
    this._groundSig = sig;
    this._updateMudTint(list);
    const d = this._floodDummy, w = this.mapW;
    let tk = 0;
    for (let n = 0; n < list.length; n += 4) {
      const idx = list[n], tr = list[n + 1] / 255, md = list[n + 2] / 255, dir = list[n + 3] || 0;
      const gx = idx % w, gy = (idx / w) | 0;
      const baseY = this.height[idx] * HEIGHT_SCALE + 0.09;
      const angle = (dir / 8) * Math.PI * 2;
      if (tr > 0.04 && tk + 1 < 6000) {
        for (const side of [-1, 1]) {
          const ox = Math.cos(angle + Math.PI / 2) * side * TILE * 0.23;
          const oz = Math.sin(angle + Math.PI / 2) * side * TILE * 0.23;
          d.position.set(gx * TILE + ox, baseY, gy * TILE + oz);
          this._alignToTerrain(d, idx);
          d.rotation.y += angle;
          d.scale.set(0.65 + tr * 0.8, 1, 0.7 + tr * 0.9);
          d.updateMatrix(); this.trackMesh.setMatrixAt(tk++, d.matrix);
        }
      }
    }
    d.scale.set(1, 1, 1);
    this.trackMesh.count = tk;
    this.trackMesh.instanceMatrix.needsUpdate = true;
  }

  _updateMudTint(list) {
    if (!this._mudAmount) this._mudAmount = new Float32Array((this.mapW || 0) * (this.mapH || 0));
    this._mudAmount.fill(0);
    for (let n = 0; n < list.length; n += 4) {
      const idx = list[n], md = list[n + 2] / 255;
      if (md > 0.04) this._mudAmount[idx] = md;
    }
    this._rebuildTerrainBaseColors();
  }

  _alignToTerrain(obj, idx) {
    const w = this.mapW, h = this.mapH, x = idx % w, y = (idx / w) | 0;
    const hL = this.height[y * w + Math.max(0, x - 1)] * HEIGHT_SCALE;
    const hR = this.height[y * w + Math.min(w - 1, x + 1)] * HEIGHT_SCALE;
    const hD = this.height[Math.max(0, y - 1) * w + x] * HEIGHT_SCALE;
    const hU = this.height[Math.min(h - 1, y + 1) * w + x] * HEIGHT_SCALE;
    this._normal.set(-(hR - hL) / (2 * TILE), 1, -(hU - hD) / (2 * TILE)).normalize();
    obj.quaternion.setFromUnitVectors(this._up, this._normal);
  }

  _downhillAngle(idx) {
    const w = this.mapW, h = this.mapH, x = idx % w, y = (idx / w) | 0;
    const hL = this.height[y * w + Math.max(0, x - 1)];
    const hR = this.height[y * w + Math.min(w - 1, x + 1)];
    const hD = this.height[Math.max(0, y - 1) * w + x];
    const hU = this.height[Math.min(h - 1, y + 1) * w + x];
    return Math.atan2(hD - hU, hL - hR);
  }

  _slopeAt(idx) {
    const w = this.mapW, h = this.mapH, x = idx % w, y = (idx / w) | 0;
    const hL = this.height[y * w + Math.max(0, x - 1)];
    const hR = this.height[y * w + Math.min(w - 1, x + 1)];
    const hD = this.height[Math.max(0, y - 1) * w + x];
    const hU = this.height[Math.min(h - 1, y + 1) * w + x];
    return Math.hypot(hR - hL, hU - hD) * 0.5;
  }

  _makeEmptyOverlayGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geo.setIndex([]);
    return geo;
  }

  _replaceMeshGeometry(mesh, geo) {
    if (!mesh) return;
    const old = mesh.geometry;
    mesh.geometry = geo;
    if (old && old !== geo) old.dispose();
  }

  _cellListSig(list) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < list.length; i++) h = Math.imul(h ^ (list[i] | 0), 16777619) >>> 0;
    return `${list.length}:${h}`;
  }

  _overlayY(x, z, offset, water = false) {
    const ground = this.heightAt(x, z);
    if (!water) return ground + offset;
    const info = this._waterInfoAt(x, z);
    return Math.max(ground, info.surface, this.seaY ?? ground) + offset;
  }

  _makeRibbonGeometry(cells, opts = {}) {
    const width = opts.width ?? TILE * 0.72;
    const offset = opts.offset ?? 0.08;
    const water = !!opts.water;
    const set = new Set(cells);
    const positions = [], indices = [];
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const addVertex = (x, z) => {
      positions.push(x, this._overlayY(x, z, offset, water), z);
      return positions.length / 3 - 1;
    };
    const addQuad = (a, b, c, d) => {
      const n = positions.length / 3;
      positions.push(
        a[0], this._overlayY(a[0], a[1], offset, water), a[1],
        b[0], this._overlayY(b[0], b[1], offset, water), b[1],
        c[0], this._overlayY(c[0], c[1], offset, water), c[1],
        d[0], this._overlayY(d[0], d[1], offset, water), d[1],
      );
      indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    const addSegment = (x0, z0, x1, z1) => {
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
      if (len <= 0.001) return;
      const px = -dz / len * width * 0.5, pz = dx / len * width * 0.5;
      addQuad([x0 + px, z0 + pz], [x1 + px, z1 + pz], [x1 - px, z1 - pz], [x0 - px, z0 - pz]);
    };
    const addCap = (x, z) => {
      const c = addVertex(x, z);
      const r = width * 0.53, seg = 10;
      const ring = [];
      for (let n = 0; n < seg; n++) {
        const a = (n / seg) * Math.PI * 2;
        ring.push(addVertex(x + Math.cos(a) * r, z + Math.sin(a) * r));
      }
      for (let n = 0; n < seg; n++) indices.push(c, ring[(n + 1) % seg], ring[n]);
    };

    for (const idx of cells) {
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      const x = gx * TILE, z = gy * TILE;
      addCap(x, z);
      for (const [dx, dy] of directions) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= this.mapW || ny >= this.mapH) continue;
        if (!set.has(ny * this.mapW + nx)) continue;
        addSegment(x, z, nx * TILE, ny * TILE);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // Brücken-Deckhöhen: damit eine Brücke eine SCHLUCHT in angemessener Höhe überspannt (statt in den
  // Graben zu tauchen), liegt das Deck auf Höhe der Uferränder. Pro Brückenzelle die maximale Boden-
  // höhe der angrenzenden Nicht-Brückenzellen (= Ufer) ermitteln und über die zusammenhängende Brücke
  // verteilen (max), sodass das Deck flach auf Randniveau verläuft; nie unter Wasser-/Bodenfläche.
  _bridgeDeckHeights(cells, offset) {
    const set = new Set(cells);
    const deck = new Map();
    const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const idx of cells) {
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      let rim = -Infinity;
      for (const [dx, dy] of N8) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= this.mapW || ny >= this.mapH) continue;
        if (set.has(ny * this.mapW + nx)) continue;       // Brückenzelle → kein Ufer
        rim = Math.max(rim, this.heightAt(nx * TILE, ny * TILE));
      }
      deck.set(idx, rim);
    }
    // Randhöhe über die Brücke verteilen (mehrere Durchläufe bis stabil) → flaches Deck.
    for (let pass = 0; pass < 64; pass++) {
      let changed = false;
      for (const idx of cells) {
        const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
        let best = deck.get(idx);
        for (const [dx, dy] of N8) {
          const ni = (gy + dy) * this.mapW + (gx + dx);
          if (set.has(ni)) { const v = deck.get(ni); if (v > best) best = v; }
        }
        if (best > deck.get(idx)) { deck.set(idx, best); changed = true; }
      }
      if (!changed) break;
    }
    // Deck nie unter die lokale Wasser-/Bodenfläche; Boden für die Pfeiler merken.
    const out = new Map();
    for (const idx of cells) {
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      const x = gx * TILE, z = gy * TILE;
      const ground = this.heightAt(x, z);
      const base = this._overlayY(x, z, offset, true);
      const rim = deck.get(idx);
      const top = Math.max(base, (rim > -Infinity ? rim + offset : base));
      out.set(idx, { x, z, top, ground });
    }
    return out;
  }

  // Brücken-Mesh: ebenes Deck auf Uferniveau + Pfeiler hinab zum Schluchtboden.
  _makeBridgeGeometry(cells, opts = {}) {
    if (!cells.length) return this._makeEmptyOverlayGeometry();
    const width = opts.width ?? TILE * 1.15;
    const offset = opts.offset ?? 0.34;
    const heights = this._bridgeDeckHeights(cells, offset);
    const positions = [], indices = [];
    const addQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
      const n = positions.length / 3;
      positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const idx of cells) {
      const c = heights.get(idx);
      // Deck-Kappe (kleines Quadrat) auf Deckhöhe.
      const r = width * 0.5;
      addQuad(c.x - r, c.top, c.z - r, c.x + r, c.top, c.z - r, c.x + r, c.top, c.z + r, c.x - r, c.top, c.z + r);
      // Pfeiler zum Boden, wenn das Deck merklich über dem Untergrund schwebt (Schlucht).
      if (c.top - c.ground > 0.6) {
        const pr = width * 0.18, py = c.ground - 0.2;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = c.x + sx * r * 0.6, pz = c.z + sz * r * 0.6;
          addQuad(px - pr, c.top, pz, px + pr, c.top, pz, px + pr, py, pz, px - pr, py, pz);
          addQuad(px, c.top, pz - pr, px, c.top, pz + pr, px, py, pz + pr, px, py, pz - pr);
        }
      }
    }
    // Deck-Bänder zwischen benachbarten Zellen (auf interpolierter Deckhöhe) → durchgehende Fahrbahn.
    for (const idx of cells) {
      const a = heights.get(idx);
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      for (const [dx, dy] of directions) {
        const ni = (gy + dy) * this.mapW + (gx + dx);
        const b = heights.get(ni);
        if (!b) continue;
        const ddx = b.x - a.x, ddz = b.z - a.z, len = Math.hypot(ddx, ddz);
        if (len <= 0.001) continue;
        const px = -ddz / len * width * 0.5, pz = ddx / len * width * 0.5;
        addQuad(a.x + px, a.top, a.z + pz, b.x + px, b.top, b.z + pz, b.x - px, b.top, b.z - pz, a.x - px, a.top, a.z - pz);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // Straßennetz aus dem Snapshot: Indexliste → durchgehendes Fahrbahn-Ribbon knapp über dem Boden.
  updateRoads(list) {
    if (!this.roadMesh || !this.height || !list) return;
    const sig = this._cellListSig(list) + this._fogSig();
    if (sig === this._roadSig) return;
    this._roadSig = sig;
    let cells = Array.from(list).slice(0, 9000);
    this._roadCellSet = new Set(cells);   // für Rechtsverkehr-Spurversatz der Fahrzeuge
    // Im Nebel: nur Straßen im eigenen Sichtfeld zeigen (gegnerische Straßen verschwinden).
    if (this.fowEnabled) cells = cells.filter(idx => this._infraCellVisible(idx % this.mapW, (idx / this.mapW) | 0));
    // Breite Fahrbahn (zweispurig): Fahrzeuge können sich begegnen und rechts aneinander vorbeifahren.
    this._replaceMeshGeometry(this.roadMesh, this._makeRibbonGeometry(cells, { width: TILE * 1.5, offset: 0.085 }));
  }

  // Tunnel aus dem Snapshot: alle Tunneltiles → eine durchgehende, erhabene dunkle Röhre.
  updateTunnels(tunnels) {
    if (!this.tunnelMesh || !this.height) return;
    const cells = [];
    for (const tn of tunnels || []) {
      const ti = tn.tiles || [];
      // Im Nebel: fremde Tunnel nur zeigen, wenn ein Tile im eigenen Sichtfeld liegt (eigene immer).
      const own = !this.fowEnabled || tn.owner === this._fowSeat;
      let visible = own;
      if (!visible) { for (let k = 0; k + 1 < ti.length; k += 2) { if (this._infraCellVisible(ti[k], ti[k + 1])) { visible = true; break; } } }
      if (!visible) continue;
      for (let k = 0; k + 1 < ti.length; k += 2) {
        const gx = ti[k], gy = ti[k + 1];
        if (gx >= 0 && gy >= 0 && gx < this.mapW && gy < this.mapH) cells.push(gy * this.mapW + gx);
      }
    }
    cells.sort((a, b) => a - b);
    const sig = this._cellListSig(cells) + this._fogSig();
    if (sig === this._tunnelSig) return;
    this._tunnelSig = sig;
    this._replaceMeshGeometry(this.tunnelMesh, this._makeRibbonGeometry(cells, { width: TILE * 0.92, offset: 0.5 }));
  }

  updateBridgeOverlay(entities = null, preparedCells = null) {
    if (!this.bridgeMesh || !this.height) return;
    const cells = preparedCells || new Set(this._baseBridgeCells || []);
    if (!preparedCells) {
      for (const e of entities || []) {
        if (e.etype !== 'building' || e.kind !== 'bridge' || (e.buildProgress ?? 1) < 1) continue;
        const tx = Math.round(e.x / TILE - 0.5), ty = Math.round(e.y / TILE - 0.5);
        const size = Math.max(1, e.size || 1);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const gx = tx + x, gy = ty + y;
          if (gx >= 0 && gy >= 0 && gx < this.mapW && gy < this.mapH) cells.add(gy * this.mapW + gx);
        }
      }
    }
    const list = [...cells].sort((a, b) => a - b);
    const sig = this._cellListSig(list);
    if (sig === this._bridgeSig) return;
    this._bridgeSig = sig;
    this._replaceMeshGeometry(this.bridgeMesh, this._makeBridgeGeometry(list, { width: TILE * 1.15, offset: 0.34 }));
  }

  // Schneedecke: Vertex-Farben Richtung Weiß mischen; geschmolzene Zellen kehren zur Basisfarbe zurück.
  updateSnow(pairs) {
    if (!this._colAttr || !pairs) return;
    if (!this._snowSet) this._snowSet = new Set();
    if (!this._snowAmount) this._snowAmount = new Map();
    this._snowPairs = pairs;
    const sig = pairs.length + ':' + (pairs.length ? pairs[1] + '/' + pairs[pairs.length - 1] : 0);
    if (sig === this._snowSig) return;
    this._snowSig = sig;
    const col = this._colAttr.array, base = this._baseColors;
    const cur = new Set();
    const curAmount = new Map();
    const meltCandidates = [];
    for (let n = 0; n < pairs.length; n += 2) {
      const idx = pairs[n], amount = pairs[n + 1] || 0, f = Math.min(1, (amount / 100) * 1.6);
      cur.add(idx);
      curAmount.set(idx, amount);
      const prev = this._snowAmount?.get(idx) || 0;
      if (prev - amount >= 3 && this._slopeAt(idx) > 0.045) meltCandidates.push(idx);
      const o = idx * 3;
      col[o] = base[o] + (0.93 - base[o]) * f;
      col[o + 1] = base[o + 1] + (0.95 - base[o + 1]) * f;
      col[o + 2] = base[o + 2] + (0.99 - base[o + 2]) * f;
    }
    for (const idx of this._snowSet) {
      if (cur.has(idx)) continue;
      if ((this._snowAmount?.get(idx) || 0) >= 4 && this._slopeAt(idx) > 0.045) meltCandidates.push(idx);
      const o = idx * 3;
      col[o] = base[o]; col[o + 1] = base[o + 1]; col[o + 2] = base[o + 2];
    }
    this._snowSet = cur;
    this._snowAmount = curAmount;
    this._maybeSpawnSnowMeltRock(meltCandidates);
    this._colAttr.needsUpdate = true;
  }

  _maybeSpawnSnowMeltRock(candidates) {
    if (!candidates.length || !this._particlesVisible() || !this._canSpawnEffect(2)) return;
    const gap = this.quality === 'low' ? 2.4 : this.quality === 'medium' ? 1.7 : 1.1;
    if (this.time < (this._snowMeltRockAt || 0)) return;
    this._snowMeltRockAt = this.time + gap + Math.random() * gap;
    const idx = candidates[(Math.random() * candidates.length) | 0];
    const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
    this.spawnRollingRock(gx * TILE, gy * TILE, { size: 0.16 + Math.random() * 0.11, speed: 4.5 + Math.random() * 3.5, life: 2.8 });
  }

  updateOil(delta) {
    if (!this._colAttr || !delta || !this._baseColors) return;
    const sig = delta.length
      ? `${delta.length}:${delta[0]}:${delta[1]}:${delta[delta.length - 2]}:${delta[delta.length - 1]}`
      : '0';
    if (sig === this._oilSig) return;
    this._oilSig = sig;
    this._applyOilDelta(delta);
  }

  // Erz-Restmengen aktualisieren (für die Feld-Ressourcenanzeige): überschreibt die Startwerte in
  // _oreInit mit den vom Server gestreamten aktuellen Restmengen geänderter Zellen.
  updateOre(delta) {
    if (!delta || !this._oreInit) return;
    if (delta === this._oreDeltaSeen) return;   // dasselbe Delta nicht doppelt anwenden
    this._oreDeltaSeen = delta;
    for (let n = 0; n < delta.length; n += 2) this._oreInit[delta[n]] = delta[n + 1] || 0;
  }

  _applyOilDelta(delta) {
    for (let n = 0; n < delta.length; n += 2) {
      const idx = delta[n], q = delta[n + 1] || 0;
      this.oilAmount[idx] = q;
      if (q > 0) this._oilSet.add(idx); else this._oilSet.delete(idx);
    }
    this._rebuildTerrainBaseColors();
    this._refreshOilOverlay();
  }

  _rebuildTerrainBaseColors() {
    const col = this._colAttr?.array, base = this._baseColors, raw = this._rawBaseColors;
    if (!col || !base || !raw) return;
    base.set(raw);
    if (this._mudAmount) {
      const w = this.mapW || 0, h = this.mapH || 0;
      for (let idx = 0; idx < this._mudAmount.length; idx++) {
        const md = this._mudAmount[idx];
        if (md <= 0.04) continue;
        const x = idx % w, y = (idx / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const d = Math.hypot(dx, dy);
          const weight = d < 0.1 ? 1 : d < 1.1 ? 0.45 : 0.22;
          const f = Math.min(0.58, md * 0.62 * weight);
          const o = (ny * w + nx) * 3;
          base[o] = base[o] * (1 - f) + 0.33 * f;
          base[o + 1] = base[o + 1] * (1 - f) + 0.23 * f;
          base[o + 2] = base[o + 2] * (1 - f) + 0.12 * f;
        }
      }
    }
    if (this._wetAmount) {
      const w = this.mapW || 0, h = this.mapH || 0;
      for (let idx = 0; idx < this._wetAmount.length; idx++) {
        const wet = this._wetAmount[idx];
        if (wet <= 0.018) continue;
        const x = idx % w, y = (idx / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const d = Math.hypot(dx, dy);
          const weight = d < 0.1 ? 1 : d < 1.1 ? 0.42 : 0.16;
          // Nass-Färbung in Richtung Wasserton (dunkles Türkis) — entlang der Abflussströme deutlich sichtbar.
          const f = Math.min(0.66, wet * 0.78 * weight);
          const o = (ny * w + nx) * 3;
          base[o] = base[o] * (1 - f) + 0.10 * f;
          base[o + 1] = base[o + 1] * (1 - f) + 0.26 * f;
          base[o + 2] = base[o + 2] * (1 - f) + 0.28 * f;
        }
      }
    }
    if (this.oilAmount && this._oilSet) for (const idx of this._oilSet) {
      const q = this.oilAmount[idx] || 0;
      if (q <= 0) continue;
      const f = Math.min(0.96, (q / 255) * 0.96);
      const o = idx * 3;
      base[o] = base[o] * (1 - f) + 0.004 * f;
      base[o + 1] = base[o + 1] * (1 - f) + 0.0035 * f;
      base[o + 2] = base[o + 2] * (1 - f) + 0.003 * f;
    }
    if (this._snowPairs) {
      this._snowSig = null;
      this.updateSnow(this._snowPairs);
    } else {
      col.set(base);
      this._colAttr.needsUpdate = true;
    }
  }

  _buildOilOverlay() {
    if (!this.scene || !this.height || !this.oilAmount) return;
    if (this.oilMesh?.parent) this.oilMesh.parent.remove(this.oilMesh);
    const cap = Math.max(1, this._oilSet?.size || 0);
    const geo = new THREE.CircleGeometry(TILE * 0.96, 28);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x050403,
      map: this.tex.oil,
      transparent: true,
      opacity: 0.98,
      alphaTest: 0.02,
      roughness: 0.14,
      metalness: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 3;
    mesh.receiveShadow = false;
    this.scene.add(mesh);
    this.oilMesh = mesh;
    this._oilOverlayCap = cap;
    this._refreshOilOverlay();
  }

  _refreshOilOverlay() {
    if (!this.oilMesh || !this.oilAmount || !this._oilSet || !this.height) return;
    if (this._oilSet.size > (this._oilOverlayCap || 0)) {
      this._buildOilOverlay();
      return;
    }
    const d = this._oilDummy || this._floodDummy || new THREE.Object3D();
    let k = 0;
    for (const idx of this._oilSet) {
      const q = this.oilAmount[idx] || 0;
      if (q <= 0) continue;
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      const f = Math.max(0.08, Math.min(1, q / 255));
      const sx = 0.70 + f * (1.25 + hash01(gx, gy, 401) * 0.45);
      const sz = 0.62 + f * (1.12 + hash01(gx, gy, 411) * 0.42);
      d.position.set(gx * TILE, this.heightAt(gx * TILE, gy * TILE) + 0.085, gy * TILE);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, 1, 1);
      this._alignToTerrain(d, idx);
      d.rotateY(hash01(gx, gy, 421) * Math.PI * 2);
      d.scale.set(sx, 1, sz);
      d.updateMatrix();
      this.oilMesh.setMatrixAt(k++, d.matrix);
    }
    this.oilMesh.count = k;
    this.oilMesh.instanceMatrix.needsUpdate = true;
  }

  // Terraforming aus dem Snapshot ins Geländemesh übernehmen: nur veränderte Vertices anheben/absenken.
  // delta = flaches Array [idx, h*1000, …]. Normalen werden nur bei tatsächlicher Änderung neu berechnet.
  updateTerraform(delta) {
    if (!this.terrainMesh || !this.height) return;
    const sig = delta ? delta.length + ':' + (delta.length ? delta[delta.length - 1] : 0) : '0';
    if (sig === this._terraSig) return;       // unverändert → kein teures Normalen-Update
    this._terraSig = sig;
    const pos = this.terrainMesh.geometry.attributes.position;
    const fowPos = this.fowMesh?.geometry.attributes.position;
    // Neue Delta-Menge aufbauen; Zellen, deren Delta verschwunden ist (Wall zerstört, Graben
    // verfüllt), exakt auf die Ausgangshöhe zurücksetzen — vorher blieben sie fälschlich verformt.
    const cur = new Set();
    if (delta) for (let n = 0; n < delta.length; n += 2) {
      const idx = delta[n], hh = delta[n + 1] / 1000;
      cur.add(idx);
      this.height[idx] = hh;                  // lokale Höhenkarte mitführen (Picking/heightAt/Wasser)
      pos.setY(idx, hh * HEIGHT_SCALE);
      if (fowPos) fowPos.setY(idx, hh * HEIGHT_SCALE + 0.32);
    }
    for (const idx of this._terraIdx) {
      if (cur.has(idx)) continue;
      this.height[idx] = this.height0[idx];
      pos.setY(idx, this.height0[idx] * HEIGHT_SCALE);
      if (fowPos) fowPos.setY(idx, this.height0[idx] * HEIGHT_SCALE + 0.32);
    }
    this._terraIdx = cur;
    if (this.waterDepth) {
      this._refreshFloodVisualMask(true);
      this._rebuildWaterMesh();
      this._refreshWetGroundOverlay();
      this._refreshFloodOverlay();
    }
    if (this.oilMesh) this._refreshOilOverlay();
    pos.needsUpdate = true;
    if (fowPos) { fowPos.needsUpdate = true; this.fowMesh.geometry.computeVertexNormals(); }
    this.terrainMesh.geometry.computeVertexNormals();
    if ((this._terraformJobPreview?.length || 0) + (this._terraformDragPreview?.length || 0) > 0) {
      this._terraformPreviewSig = '';
      this._updateTerraformPreviewMesh();
    }
    this._markShadowsDirty(false);
  }

  heightAt(wx, wz) {
    if (!this.height) return 0;
    const gx = Math.max(0, Math.min(this.mapW - 1, Math.round(wx / TILE)));
    const gy = Math.max(0, Math.min(this.mapH - 1, Math.round(wz / TILE)));
    return this.height[gy * this.mapW + gx] * HEIGHT_SCALE;
  }

  // Rohstoffvorkommen an einem Weltpunkt (für die Anzeige beim Anklicken eines Öl-/Erzfeldes):
  // Öl ist live (Snapshot), Erz ist der Startwert (wird serverseitig nicht gestreamt → Näherung).
  resourceAt(wx, wz) {
    if (!this.mapW) return null;
    const gx = Math.max(0, Math.min(this.mapW - 1, Math.round(wx / TILE)));
    const gy = Math.max(0, Math.min(this.mapH - 1, Math.round(wz / TILE)));
    const i = gy * this.mapW + gx;
    const oil = this.oilAmount ? (this.oilAmount[i] || 0) : 0;
    const ore = this._oreInit ? (this._oreInit[i] || 0) : 0;
    return (oil > 0 || ore > 0) ? { ore: Math.round(ore), oil: Math.round(oil) } : null;
  }

  _waterSurfaceYAtIdx(idx) {
    if (!this.height) return 0;
    const ground = this.height[idx] * HEIGHT_SCALE;
    if (!this.waterDepth || this._visibleWaterDepth(idx) <= 0.012) return ground;
    const visual = this._waterSurfaceVisual?.[idx] || 0;
    if (visual > 0) return visual;
    return Math.max((this.height[idx] + (this.waterDepth[idx] || 0)) * HEIGHT_SCALE, ground + 0.14);
  }

  waterSurfaceAt(wx, wz) {
    if (!this.waterDepth || !this.height) return this.heightAt(wx, wz);
    const gx = Math.max(0, Math.min(this.mapW - 1, Math.round(wx / TILE)));
    const gy = Math.max(0, Math.min(this.mapH - 1, Math.round(wz / TILE)));
    return this._waterSurfaceYAtIdx(gy * this.mapW + gx) + this._seaWaveAt(wx, wz);
  }

  _isSeaWorldPoint(wx, wz) {
    const idx = this._tileIndexAt(wx, wz);
    if (idx < 0) return false;
    return this._isSeaWaterCell(idx, this.waterDepth?.[idx] || 0);
  }

  _seaWaveAt(wx, wz) {
    if (!this._isSeaWorldPoint(wx, wz)) return 0;
    return this._seaWaveUnchecked(wx, wz);
  }

  _seaWaveUnchecked(wx, wz) {
    const edgeOpen = this._seaEdgeOpenAt(wx, wz);
    const storm = this._waterStorm || 0;
    const amp = 0.075 + edgeOpen * 0.075 + storm * 0.045;
    const t = this.time;
    return (Math.sin(wx * 0.085 + wz * 0.020 + t * (1.55 + storm * 0.45))
      + Math.sin(wz * 0.070 - wx * 0.032 + t * (1.05 + storm * 0.35)) * 0.58) * amp;
  }

  _seaWaveTiltAt(wx, wz, facing) {
    if (!this._isSeaWorldPoint(wx, wz)) return { pitch: 0, roll: 0 };
    const fx = Math.cos(facing), fz = Math.sin(facing);
    const sx = -fz, sz = fx;
    const l = 2.2;
    const hF = this._seaWaveAt(wx + fx * l, wz + fz * l);
    const hB = this._seaWaveAt(wx - fx * l, wz - fz * l);
    const hL = this._seaWaveAt(wx - sx * l, wz - sz * l);
    const hR = this._seaWaveAt(wx + sx * l, wz + sz * l);
    return {
      pitch: Math.max(-0.24, Math.min(0.24, -Math.atan2(hF - hB, 2 * l))),
      roll: Math.max(-0.28, Math.min(0.28, Math.atan2(hR - hL, 2 * l))),
    };
  }

  setFogOfWar(enabled, data = null) {
    this.fowEnabled = !!enabled;
    if (data) this._fowData = data;
    if (this.fowMesh) this.fowMesh.visible = this.fowEnabled;
    if (!this.fowEnabled) {
      this._fowCircles = [];
      this._fowHidden.clear();
      this._clearEnemyMist();
    }
  }

  updateFogOfWar(entities, seat, data, env) {
    if (data) this._fowData = data;
    if (!this.fowEnabled || seat == null || !this.mapW) {
      if (this.fowMesh) this.fowMesh.visible = false;
      this._fowCircles = [];
      this._fowHidden.clear();
      this._clearEnemyMist();
      return;
    }
    this._fowSeat = seat;
    const night = (env?.d ?? 1) < 0.25;
    this._fowNight = night;
    this._fowWeatherFog = env?.w === 'fog' ? 1 : 0;
    const circles = [];
    for (const e of entities) {
      if (e.owner !== seat) continue;
      const def = e.etype === 'unit' ? this._fowData?.units?.[e.kind] : this._fowData?.buildings?.[e.kind];
      const isB = e.etype === 'building';
      let r = (def?.sight || (isB ? 5 : 4)) * TILE;
      // Größerer Aufklärungsradius — Gebäude überblicken ihr Umland deutlich weiter als Einheiten.
      r *= isB ? 1.6 : 1.3;
      if (night) {
        const litBuilding = isB && e.powered !== false && e.buildProgress >= 1;
        r *= litBuilding ? 0.62 : 0.34;
        if (litBuilding) r = Math.max(r, 11);
      }
      circles.push({ x: e.x, y: e.y, r });
    }
    circles.sort((a, b) => b.r - a.r);
    this._fowCircles = circles.slice(0, 48);
    this._updateFogOverlay(night);
  }

  isHiddenByFog(e, seat) {
    if (!this.fowEnabled || seat == null || e.owner === seat) return false;
    return !this._inOwnSight(e.x, e.y);
  }

  isHiddenSubmerged(e, seat) {
    if (!e.submerged || seat == null || e.owner === seat || e.subExposed) return false;
    if ((e.sonarMask || 0) & (1 << seat)) return false;
    const ents = this._lastEntities || [];
    const r2 = SUB_DETECT_RANGE * SUB_DETECT_RANGE;
    for (const o of ents) {
      if (o.owner !== seat || o.id === e.id) continue;
      const dx = o.x - e.x, dy = o.y - e.y;
      if (dx * dx + dy * dy <= r2) return false;
    }
    return true;
  }

  isHiddenEntity(e, seat) {
    return this.isHiddenSubmerged(e, seat) || this.isHiddenByFog(e, seat);
  }

  _inOwnSight(x, y) {
    for (const c of this._fowCircles) {
      const dx = x - c.x, dy = y - c.y;
      if (dx * dx + dy * dy <= c.r * c.r) return true;
    }
    return false;
  }

  // Infrastruktur-Sichtbarkeit für den Nebel des Krieges: bei aktivem Nebel ist eine Leitung/Straße/
  // Brücke/Tunnel-Zelle nur sichtbar, wenn sie aktuell im eigenen Sichtfeld liegt (Gegner-Infra
  // verschwindet so im Nebel). Tile-Koordinaten → Weltmitte.
  _infraCellVisible(gx, gy) {
    if (!this.fowEnabled) return true;
    return this._inOwnSight(gx * TILE + TILE / 2, gy * TILE + TILE / 2);
  }

  // Rechtsverkehr-Spurversatz: steht eine Landeinheit auf einer Straße, wird sie um eine halbe Spur
  // nach RECHTS (bzgl. Fahrtrichtung) versetzt. Entgegenkommende fahren so rechts aneinander vorbei.
  _laneOffset(e) {
    if (e.domain !== 'land' || !this._roadCellSet || this._roadCellSet.size === 0) return ZERO_OFFSET;
    const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return ZERO_OFFSET;
    if (!this._roadCellSet.has(ty * this.mapW + tx)) return ZERO_OFFSET;
    const f = e.facing || 0;
    const lane = TILE * 0.3;                 // halbe Fahrbahnbreite
    return { x: Math.sin(f) * lane, z: -Math.cos(f) * lane };  // rechte Seite der Fahrtrichtung
  }

  // Grobe Signatur des Sichtfelds — ändert sich nur, wenn sich die Sicht spürbar verschiebt, damit
  // die Overlay-Meshes nicht jeden Frame neu gebaut werden.
  _fogSig() {
    if (!this.fowEnabled) return 'off';
    let h = 2166136261 >>> 0;
    for (const c of this._fowCircles) {
      h = Math.imul(h ^ Math.round(c.x / 8), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(c.y / 8), 16777619) >>> 0;
    }
    return 'f' + h;
  }

  _updateFogOverlay(night) {
    if (!this.fowMesh) return;
    this.fowMesh.visible = this.fowEnabled;
    const u = this.fowMesh.material.uniforms;
    u.uCount.value = this._fowCircles.length;
    u.uNight.value = night ? 1 : 0;
    if (u.uWeatherFog) u.uWeatherFog.value = this._fowWeatherFog || 0;
    if (u.uFogColor && this.scene.fog) u.uFogColor.value.copy(this.scene.fog.color); // Dunst-Harmonie statt Schwarz

    for (let i = 0; i < u.uCircles.value.length; i++) {
      const c = this._fowCircles[i];
      u.uCircles.value[i].set(c?.x || 0, c?.y || 0, c?.r || 0);
    }
  }

  // --- Entities synchronisieren ---
  sync(entities, players, selected, seat = null, events = null) {
    this._lastEntities = entities;
    // Pipeline-Netz: alle verbindbaren Bauten (Leitung + Endpunkte), damit Rohre als
    // durchgehende Leitung mit Kurven/T-Stücken/Kreuzungen aufgebaut werden.
    this._pipeAnchors = [];
    const bridgeCells = new Set(this._baseBridgeCells || []);
    // Im Nebel: fremde Pipelines/Brücken nur sichtbar, wenn im eigenen Sichtfeld (eigene immer).
    const infraVisible = (e) => !this.fowEnabled || e.owner === seat || this._inOwnSight(e.x, e.y);
    for (const e of entities) {
      if (e.etype !== 'building') continue;
      if (PIPE_CONNECT.has(e.kind) && (e.buildProgress ?? 1) >= 1 && infraVisible(e)) {
        const tx = e.x / TILE - 0.5, ty = e.y / TILE - 0.5;
        this._pipeAnchors.push({ id: e.id, owner: e.owner, kind: e.kind, x: e.x, z: e.y, tx, ty, size: e.size || 1 });
      }
      if (e.kind === 'bridge' && (e.buildProgress ?? 1) >= 1 && infraVisible(e)) {
        const tx = Math.round(e.x / TILE - 0.5), ty = Math.round(e.y / TILE - 0.5);
        const size = Math.max(1, e.size || 1);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const gx = tx + x, gy = ty + y;
          if (gx >= 0 && gy >= 0 && gx < this.mapW && gy < this.mapH) bridgeCells.add(gy * this.mapW + gx);
        }
      }
    }
    this.updatePipelineOverlay();
    this.updateBridgeOverlay(null, bridgeCells);
    const seen = new Set();
    const tunnelGhostSeen = new Set();
    const mistBuckets = new Map();
    const washouts = new Map();
    for (const ev of events || []) if (ev.type === 'washout' && ev.id != null) washouts.set(ev.id, ev);
    this._handledWashouts = new Set();
    this._lampSpots.length = 0;
    let movedShadowCaster = false;
    for (const e of entities) {
      seen.add(e.id);
      let g = this.meshes.get(e.id);
      const hiddenSubmerged = this.isHiddenSubmerged(e, seat);
      const hiddenByFog = !hiddenSubmerged && this.isHiddenByFog(e, seat);
      if (hiddenSubmerged || hiddenByFog) {
        if (g) g.visible = false;
        if (hiddenByFog && !this._fowNight && e.etype === 'unit') {
          const bx = Math.floor(e.x / 18), by = Math.floor(e.y / 18);
          const key = bx + ',' + by;
          const m = mistBuckets.get(key) || { x: 0, y: 0, n: 0, key };
          m.x += e.x; m.y += e.y; m.n++;
          mistBuckets.set(key, m);
        }
        continue;
      }
      const color = e.abandoned ? '#8b8d8f' : ((players.find(p => p.id === e.owner) || {}).color || '#cccccc');
      // In der Tunnelröhre verborgen: normales Modell aus, nur ein Umriss-Geist wandert über den Berg.
      if (e.inTunnel) {
        if (g) g.visible = false;
        this._showTunnelGhost(e, color);
        tunnelGhostSeen.add(e.id);
        continue;
      }
      if (g && (g.userData.owner !== e.owner || g.userData.abandoned !== !!e.abandoned)) {
        this.scene.remove(g);
        this.meshes.delete(e.id);
        g = null;
        this._markShadowsDirty(false);
      }
      if (!g) {
        g = this.makeMesh(e, color);
        g.userData.owner = e.owner;
        g.userData.abandoned = !!e.abandoned;
        this.meshes.set(e.id, g); this.scene.add(g);
        this._markShadowsDirty(false);
      }
      g.visible = true;
      let y = this.heightAt(e.x, e.y);
      if (e.etype === 'building') {
        // Gebäude stehen GERADE: auf dem höchsten Punkt des Footprints (4 leicht eingerückte
        // Ecken + Mitte — exakte Footprint-Ecken würden in Nachbarzellen runden und das Gebäude
        // halb im Hang versenken). Das Fundament schließt den Spalt nach unten.
        const half = Math.max(0.4, e.size * TILE / 2 - 0.4);
        y = Math.max(
          y,
          this.heightAt(e.x - half, e.y - half), this.heightAt(e.x + half, e.y - half),
          this.heightAt(e.x - half, e.y + half), this.heightAt(e.x + half, e.y + half)) + 0.04;
        // Lastabwurf: Fenster & Lampe gehen aus, wenn das Gebäude abgeschaltet wurde.
        if (g.userData.winMeshes && g.userData.poweredState !== e.powered) {
          g.userData.poweredState = e.powered;
          for (const wm of g.userData.winMeshes) wm.material = e.powered ? this.winMat : this.winOffMat;
        }
        if (!g.userData.noLamp) {
          this._lampSpots.push({ x: e.x, z: e.y, y, on: e.powered !== false && e.buildProgress >= 1, disco: e.kind === 'hq' });
        }
        // Beschädigte Gebäude brennen: ab <55% HP Rauchsäule, ab <30% züngeln Flammen.
        if (e.buildProgress >= 1 && e.hp < e.maxHp * 0.55 && this._canSpawnEffect(3) && Math.random() < 0.12) {
          const sev = 1 - e.hp / e.maxHp;
          const ox = (Math.random() - 0.5) * e.size * 1.4, oz = (Math.random() - 0.5) * e.size * 1.4;
          this._sprite(0x33302c, e.x + ox, y + 2.2 + Math.random() * 1.5, e.y + oz,
            1.1 + sev * 1.4, 1.5, { grow: 2.0, vy: 1.8, vx: 0.3, opacity: 0.45 });
          if (sev > 0.7 && Math.random() < 0.6) {
            this._sprite(0xff8a30, e.x + ox, y + 1.4, e.y + oz, 0.9, 0.45,
              { additive: true, grow: 0.9, vy: 1.4, opacity: 0.9 });
          }
        }
        // Depot-Aktivität: Öldepot/Wasserturm zeigen mit aufsteigenden Tröpfchen/Dampf, dass über
        // eine funktionierende Pipeline gefördert wird (an die Förderkette gekoppelt).
        if (e.buildProgress >= 1 && this._canSpawnEffect() && Math.random() < 0.10) {
          if (e.kind === 'oil_depot' && this.time - (this._oilFlowT ?? -9) < 1.5) {
            this._sprite(0x20201c, e.x, y + 2.4, e.y, 0.7, 1.0, { grow: 1.4, vy: 1.0, opacity: 0.4 });
          } else if (e.kind === 'water_tower' && this.time - (this._waterFlowT ?? -9) < 1.5) {
            this._sprite(0x6cd2ff, e.x + (Math.random() - 0.5), y + 2.6, e.y + (Math.random() - 0.5), 0.5, 0.8, { additive: true, grow: 1.1, vy: 1.2, opacity: 0.5 });
          }
        }
      }
      if (WATER_KINDS.has(e.kind)) {
        // Schiffe folgen der lokalen dynamischen Wasseroberfläche (Meer, Fluss, See, Flut).
        y = Math.max(this.waterSurfaceAt(e.x, e.y), this.seaY ?? y);
        if (e.kind === 'submarine') y -= 0.5;                                 // getaucht: nur Turm schaut raus
        else if (e.kind === 'underwater_drone') y -= 0.42;                    // klein und knapp unter der Oberfläche
        else if (!this._isSeaWorldPoint(e.x, e.y)) y += Math.sin(this.time * 1.3 + e.id) * 0.06; // Binnenwasser-Dümpeln
      } else if (WATER_BUILDINGS.has(e.kind)) {
        // Werft/Pumpwerk schwimmen: auf der Wasseroberfläche sitzen (nicht auf dem Seegrund).
        y = Math.max(this.waterSurfaceAt(e.x, e.y), this.seaY ?? y) - 0.05;
      } else if ((g.userData.lift || 0) >= 5) {
        y += Math.sin(this.time * 1.7 + e.id * 0.7) * 0.35;                   // Schwebe-Bob der Luftfahrzeuge
      }
      const lift = g.userData.lift || 0;
      const targetY = y + lift;
      if (e.etype === 'unit') {
        const yAlpha = smoothAlpha(this._lastDt, lift >= 5 ? 5.5 : 8.5);
        if (g.userData._smoothY == null) g.userData._smoothY = targetY;
        else g.userData._smoothY += (targetY - g.userData._smoothY) * yAlpha;
        // Rechtsverkehr: auf Straßen scheren Einheiten weich auf die rechte Spur aus → sie begegnen
        // sich und fahren aneinander vorbei (rein visueller Versatz, ohne die Simulation zu stören).
        const off = this._laneOffset(e);
        const la = smoothAlpha(this._lastDt, 3.5);
        g.userData._laneX = (g.userData._laneX || 0) + (off.x - (g.userData._laneX || 0)) * la;
        g.userData._laneZ = (g.userData._laneZ || 0) + (off.z - (g.userData._laneZ || 0)) * la;
        g.position.set(e.x + g.userData._laneX, g.userData._smoothY, e.y + g.userData._laneZ);
      } else {
        g.userData._smoothY = targetY;
        g.position.set(e.x, targetY, e.y);
      }
      const renderY = g.position.y - lift;
      if (e.etype === 'building') { this._updateBuildingAmbientFx(g, e); this._updateBuildingWarn(g, e); this._updateBuildingProduction(g, e); }
      if (e.kind === 'pipe') this._orientPipe(g, e);
      if (e.etype === 'unit' && !e.abandoned && g.userData.vehicleLight) {
        const front = 1.15, side = 0.36;
        const fx = Math.cos(e.facing), fz = Math.sin(e.facing);
        const sx = -fz, sz = fx;
        this._lampSpots.push({
          x: e.x + fx * front + sx * side,
          z: e.y + fz * front + sz * side,
          y: renderY + lift + 0.95,
          on: true,
          vehicle: true,
          fx,
          fz,
        });
        this._lampSpots.push({
          x: e.x + fx * front - sx * side,
          z: e.y + fz * front - sz * side,
          y: renderY + lift + 0.95,
          on: true,
          vehicle: true,
          fx,
          fz,
        });
      }
      this._updateCargoVisual(g, e);
      let animMoved = 0;
      if (e.etype === 'unit') {
        animMoved = Math.hypot(e.x - (g.userData._animX ?? e.x), e.y - (g.userData._animZ ?? e.y));
        g.userData._animX = e.x; g.userData._animZ = e.y;
        if (g.userData.castsShadow) {
          const sx = g.userData._shadowX ?? e.x, sz = g.userData._shadowZ ?? e.y;
          const sf = g.userData._shadowFacing ?? e.facing;
          if ((e.x - sx) ** 2 + (e.y - sz) ** 2 > 0.16 * 0.16 || Math.abs(wrapAngle(e.facing - sf)) > 0.08) {
            g.userData._shadowX = e.x; g.userData._shadowZ = e.y; g.userData._shadowFacing = e.facing;
            movedShadowCaster = true;
          }
        }
        const yaw = -e.facing + Math.PI / 2;
        const yawAlpha = smoothAlpha(this._lastDt, e.category === 'infantry' ? 14 : 7);
        g.userData._smoothYaw = g.userData._smoothYaw == null
          ? yaw
          : g.userData._smoothYaw + wrapAngle(yaw - g.userData._smoothYaw) * yawAlpha;
        if (g.userData.tilts) {
          // Fahrzeuge folgen der Hangneigung: Nick-/Rollwinkel aus Geländehöhen vor/hinter
          // und links/rechts der Fahrtrichtung (geglättet gegen Zittern).
          const smoothFacing = Math.PI / 2 - g.userData._smoothYaw;
          const dx = Math.cos(smoothFacing), dz = Math.sin(smoothFacing), l = 1.1;
          const hF = this.heightAt(e.x + dx * l, e.y + dz * l), hB = this.heightAt(e.x - dx * l, e.y - dz * l);
          const hL = this.heightAt(e.x - dz * l, e.y + dx * l), hR = this.heightAt(e.x + dz * l, e.y - dx * l);
          const pitch = Math.max(-0.5, Math.min(0.5, -Math.atan2(hF - hB, 2 * l)));
          const roll = Math.max(-0.5, Math.min(0.5, Math.atan2(hR - hL, 2 * l)));
          const tiltAlpha = smoothAlpha(this._lastDt, 5.5);
          g.rotation.order = 'YXZ';
          g.rotation.set(
            g.rotation.x + (pitch - g.rotation.x) * tiltAlpha,
            g.userData._smoothYaw,
            g.rotation.z + (roll - g.rotation.z) * tiltAlpha);
        } else {
          g.rotation.y = g.userData._smoothYaw;
        }
        if (SURFACE_SHIP_KINDS.has(e.kind)) {
          const waveTilt = this._seaWaveTiltAt(e.x, e.y, e.facing);
          const waveAlpha = smoothAlpha(this._lastDt, 4.2);
          g.rotation.order = 'YXZ';
          g.rotation.x += (waveTilt.pitch - g.rotation.x) * waveAlpha;
          g.rotation.z += (waveTilt.roll - g.rotation.z) * waveAlpha;
        }
        // Staubfahne fahrender Landfahrzeuge (gedrosselt; nicht auf Straßen-Optik geprüft — günstig).
        if (g.userData.dusts) {
          const moved = Math.hypot(e.x - (g.userData._lx ?? e.x), e.y - (g.userData._lz ?? e.y));
          g.userData._lx = e.x; g.userData._lz = e.y;
          const dry = this._waterInfoAt(e.x, e.y).depth <= 0.018;
          if (moved > 0.06 && dry && Math.random() < 0.42) this._freshTrackFx(e);
          if (moved > 0.04 && dry && Math.random() < 0.18 && this._canSpawnEffect(2)) {
            this._sprite(0x8a7a5e, e.x - Math.cos(e.facing) * 1.2, renderY + 0.4, e.y - Math.sin(e.facing) * 1.2,
              0.9, 0.7, { grow: 1.4, vy: 0.5, opacity: 0.32 });
          }
        }
      }
      // Infanterie-Geh-Animation: leichtes Auf-und-Ab + Pendel-Lean, nur in Bewegung.
      if (g.userData.walks) {
        const wMoved = animMoved;
        if (wMoved > 0.015) {
          g.position.y += Math.abs(Math.sin(this.time * 9 + e.id * 1.7)) * 0.14;
          g.rotation.z = Math.sin(this.time * 9 + e.id * 1.7) * 0.06;
        } else g.rotation.z = 0;
      }
      if (g.userData.unitIdle) this._animateUnitIdle(g, e, animMoved);
      if (g.userData.rotor) g.userData.rotor.rotation.y = this.time * (g.userData.rotorSpeed || 20) + e.id; // Heli-/Drohnenrotor
      if (g.userData.tailRotor) g.userData.tailRotor.rotation.z = this.time * (g.userData.tailRotorSpeed || 28) + e.id * 0.7;
      if (g.userData.loaderArms) {
        const dig = e.working ? (0.5 + Math.sin(this.time * 5.8 + e.id) * 0.5) : 0;
        const idleHydraulic = e.working ? 0 : Math.sin(this.time * 0.85 + e.id * 0.31) * 0.035;
        const armTarget = -0.12 + idleHydraulic - dig * 0.46;
        const bucketTarget = 0.18 - idleHydraulic * 0.55 + dig * 0.62;
        g.userData.loaderArms.rotation.x += (armTarget - g.userData.loaderArms.rotation.x) * smoothAlpha(this._lastDt, 9);
        g.userData.loaderBucket.rotation.x += (bucketTarget - g.userData.loaderBucket.rotation.x) * smoothAlpha(this._lastDt, 10);
        if (e.working && Math.random() < 0.22 && this._canSpawnEffect(2)) {
          this._sprite(0x8a7a5e, e.x + Math.cos(e.facing) * 1.25, renderY + 0.35, e.y + Math.sin(e.facing) * 1.25,
            0.7, 0.45, { grow: 1.1, vy: 0.45, opacity: 0.38 });
        }
      } else if (g.userData.diggerArm) {
        const dig = e.working ? Math.sin(this.time * 10 + e.id) * 0.32 : 0;
        g.userData.diggerArm.rotation.x = Math.PI / 2 - 0.55 + dig;
        g.userData.diggerFore.rotation.x = Math.PI / 2 - 0.95 - dig * 0.8;
        if (e.working && Math.random() < 0.22 && this._canSpawnEffect(2)) {
          this._sprite(0x8a7a5e, e.x + Math.cos(e.facing) * 1.1, renderY + 0.35, e.y + Math.sin(e.facing) * 1.1,
            0.7, 0.45, { grow: 1.1, vy: 0.45, opacity: 0.38 });
        }
      }
      // Auswahlring + HP
      const sel = selected.has(e.id);
      if (g.userData.ring) g.userData.ring.visible = sel;
      if (g.userData.bar) {
        const f = Math.max(0, Math.min(1, e.hp / e.maxHp));
        g.userData.bar.scale.x = Math.max(0.001, f);
        g.userData.bar.position.x = -1 + f;
        g.userData.bar.material.color.setHex(f > 0.5 ? 0x4caf50 : f > 0.25 ? 0xffb300 : 0xf44336);
        // Straßen bekommen KEINE HP-Anzeige (reine Fahrbahn, kein „Gebäude-Gefühl").
        const showHp = !e.abandoned && f < 0.75 && e.kind !== 'road';
        g.userData.bar.visible = showHp;
        if (g.userData.barBack) g.userData.barBack.visible = showHp;
      }
      if (g.userData.build && e.etype === 'building') g.userData.build.visible = e.buildProgress < 1;
      if (e.etype === 'building' && g.userData.body) {
        const p = Math.max(0.03, Math.min(1, e.buildProgress ?? 1));
        if (p < 1) {
          g.userData.body.visible = p > 0.06;
          g.userData.body.scale.y = 0.12 + p * 0.88;
          const wobble = 1 + Math.sin(this.time * 8 + e.id) * 0.025;
          g.userData.body.scale.x = wobble;
          g.userData.body.scale.z = wobble;
          if (g.userData.build) {
            g.userData.build.material.opacity = 0.35 + 0.25 * Math.sin(this.time * 5 + e.id) ** 2;
            g.userData.build.scale.setScalar(0.72 + p * 0.32);
          }
          if (Math.random() < 0.08 && this._canSpawnEffect(3)) {
            this.spawnConstructionDust(e.x + (Math.random() - 0.5) * e.size, e.y + (Math.random() - 0.5) * e.size, false);
          }
        } else {
          g.userData.body.visible = true;
          g.userData.body.scale.set(1, 1, 1);
          if (g.userData.build) g.userData.build.scale.set(1, 1, 1);
        }
      }
      // Veteranen-Rang als Chevrons über der Einheit (Bronze/Silber/Gold je Rangstufe)
      if (g.userData.chevrons) {
        const rank = e.vet || 0;
        const col = VET_COLORS[Math.min(rank, VET_COLORS.length) - 1];
        for (let i = 0; i < g.userData.chevrons.length; i++) {
          const ch = g.userData.chevrons[i];
          ch.visible = i < rank;
          if (ch.visible) ch.material.color.setHex(col);
        }
      }
      this._updateUnderwaterTint(g, e, renderY);
    }
    this._syncEnemyMist(mistBuckets);
    // Tunnel-Umrisse ausblenden, deren Einheit die Röhre verlassen hat (oder weg ist).
    if (this._tunnelGhosts) for (const [id, m] of this._tunnelGhosts) {
      if (!tunnelGhostSeen.has(id)) { m.visible = false; if (!seen.has(id)) { this.scene.remove(m); this._tunnelGhosts.delete(id); } }
    }
    // Entfernte Entities: normale Verluste explodieren, Wasserverluste sinken/treiben weg.
    for (const [id, g] of this.meshes) {
      if (!seen.has(id)) {
        const wash = washouts.get(id);
        if (wash) {
          this.spawnWashout(wash, g);
          this._handledWashouts.add(id);
        } else {
          this.spawnExplosion(g.position.x, g.position.y, g.position.z, g.userData.big ? 3 : 1.2);
          this.scene.remove(g);
        }
        this.meshes.delete(id);
        this._markShadowsDirty(false);
      }
    }
    if (movedShadowCaster) this._markShadowsDirty(true);
  }

  // Umriss-Geist einer Einheit, die gerade verborgen durch eine Tunnelröhre wandert.
  _showTunnelGhost(e, color) {
    const map = this._tunnelGhosts || (this._tunnelGhosts = new Map());
    let m = map.get(e.id);
    if (!m) {
      const box = new THREE.BoxGeometry(1.5, 1.3, 1.5);
      m = new THREE.LineSegments(new THREE.EdgesGeometry(box),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false }));
      m.renderOrder = 8;
      this.scene.add(m);
      map.set(e.id, m);
    }
    m.material.color.set(color);
    m.visible = true;
    m.position.set(e.x, this.heightAt(e.x, e.y) + 1.0, e.y);
  }

  _syncEnemyMist(buckets) {
    if (!this.fowEnabled) { this._clearEnemyMist(); return; }
    const live = new Set();
    for (const [key, b] of buckets) {
      live.add(key);
      let s = this._fowEnemyMist.get(key);
      if (!s) {
        const mat = new THREE.SpriteMaterial({ map: this.tex.puff, color: 0xb72424, transparent: true, opacity: 0.42, depthWrite: false });
        s = new THREE.Sprite(mat);
        s.renderOrder = 6;
        this.scene.add(s);
        this._fowEnemyMist.set(key, s);
      }
      const n = Math.max(1, b.n);
      const x = b.x / n, z = b.y / n;
      const jitter = ((key.length * 37) % 13) * 0.13;
      const y = Math.max(this.heightAt(x, z), this.seaY ?? 0) + 2.2;
      const sz = Math.min(15, 7 + Math.sqrt(n) * 3.2);
      s.position.set(x + Math.sin(this.time * 0.6 + jitter) * 1.2, y, z + Math.cos(this.time * 0.5 + jitter) * 1.2);
      s.scale.set(sz, sz, sz);
      s.material.opacity = 0.34 + Math.min(0.16, n * 0.02);
      s.visible = true;
    }
    for (const [key, s] of this._fowEnemyMist) {
      if (live.has(key)) continue;
      this.scene.remove(s);
      s.material.dispose?.();
      this._fowEnemyMist.delete(key);
    }
  }

  _clearEnemyMist() {
    for (const s of this._fowEnemyMist.values()) {
      this.scene.remove(s);
      s.material.dispose?.();
    }
    this._fowEnemyMist.clear();
  }

  // Getöntes Metall-Material je Fraktionsfarbe (zwischengespeichert → geteilt über alle Einheiten der Farbe).
  // Die Panel-Textur trägt die Tönung; material.color bleibt weiß (sonst doppelte Färbung → zu dunkel).
  unitMat(colorHex) {
    let m = this._matCache.get(colorHex);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: panelTexture(colorHex), roughness: 0.7, metalness: 0.25 });
      this._matCache.set(colorHex, m);
    }
    return m;
  }

  // Eine Modelldatei ist fertig geladen → bestehende Meshes dieser Kinds verwerfen, damit sync()
  // sie beim nächsten Frame mit dem echten Modell statt dem prozeduralen Platzhalter neu aufbaut.
  _onModelsReady(kinds) {
    const set = new Set(kinds);
    for (const [id, g] of this.meshes) {
      if (set.has(g.userData.kind)) { this.scene.remove(g); this.meshes.delete(id); this._markShadowsDirty(false); }
    }
    if (this._modelPreviewCache) for (const key of [...this._modelPreviewCache.keys()]) {
      if (kinds.some(kind => key.includes('|' + kind + '|'))) this._modelPreviewCache.delete(key);
    }
    this.onModelPreviewsReady?.(kinds);
  }

  modelPreviewDataUrl(type, kind, def = {}, colorHex = '#36c5f0', width = 96, height = 76) {
    if (typeof document === 'undefined') return '';
    const etype = type === 'unit' ? 'unit' : 'building';
    const modelLoaded = this.models?.meta(kind) ? (this.models.instance(kind, colorHex) ? 1 : 0) : 1;
    const key = `${etype}|${kind}|${colorHex}|${width}x${height}|${modelLoaded}`;
    const cached = this._modelPreviewCache?.get(key);
    if (cached) return cached;

    const ctx = this._ensureModelPreviewRenderer(width, height);
    if (!ctx) return '';
    const { renderer, scene, camera } = ctx;
    while (scene.children.length > ctx.lightCount) scene.remove(scene.children[ctx.lightCount]);

    const entity = {
      id: -1,
      etype,
      kind,
      owner: 0,
      faction: 'KBN',
      size: def.size || 1,
      hp: def.hp || 100,
      maxHp: def.hp || 100,
      buildProgress: 1,
      x: 0,
      y: 0,
      facing: Math.PI * 0.2,
      category: def.category,
      domain: def.domain,
      abilities: def.abilities || [],
      harvestCap: def.harvestCap || 160,
    };
    let group = this.makeMesh(entity, colorHex);
    this._prepareModelPreviewGroup(group);
    let box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty() || box.getSize(new THREE.Vector3()).length() < 0.1) {
      group = this._makeModelPreviewFallback(etype, kind, colorHex);
      box = new THREE.Box3().setFromObject(group);
    }
    const center = box.getCenter(new THREE.Vector3());
    group.position.sub(center);
    group.rotation.y = -0.55;
    scene.add(group);
    group.updateMatrixWorld(true);

    // Auf die TATSÄCHLICHE Box-Mitte (nach der Drehung) zielen — sonst sitzt das Modell in der Ecke.
    box = new THREE.Box3().setFromObject(group);
    const ctr = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(1, size.x, size.y, size.z);
    camera.aspect = width / height;
    camera.near = 0.1;
    camera.far = Math.max(80, maxDim * 10);
    // Abstand so wählen, dass das Modell die Kachel FÜLLT (FOV 36°; bei breiter als hoher Kachel das
    // Seitenverhältnis einrechnen, damit auch breite Modelle ganz hineinpassen), mit etwas Rand.
    const fov = 36 * Math.PI / 180;
    const fitH = (maxDim * 0.5) / Math.tan(fov / 2);
    const dist = Math.max(fitH, fitH / Math.max(1, camera.aspect)) * 1.12;
    const dir = new THREE.Vector3(0.55, 0.42, 1).normalize();
    camera.position.copy(ctr).addScaledVector(dir, dist);
    camera.lookAt(ctr);
    camera.updateProjectionMatrix();

    renderer.setSize(width, height, false);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(group);
    this._modelPreviewCache.set(key, url);
    return url;
  }

  _ensureModelPreviewRenderer(width, height) {
    if (this._modelPreviewRenderer) return this._modelPreviewRenderer;
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = false;
    renderer.setSize(width, height, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 80);
    const hemi = new THREE.HemisphereLight(0xd8ecff, 0x26301f, 1.75);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 7, 6);
    const fill = new THREE.DirectionalLight(0x7bbdff, 0.75);
    fill.position.set(-5, 4, -3);
    scene.add(hemi, key, fill);
    this._modelPreviewRenderer = { renderer, scene, camera, lightCount: scene.children.length };
    return this._modelPreviewRenderer;
  }

  _prepareModelPreviewGroup(group) {
    // Fundament + Hoflampe ganz aus der Vorschau entfernen (auch aus der Rahmen-Bounding-Box).
    for (const o of group.userData.foundation || []) group.remove(o);
    const hidden = [
      group.userData.ring,
      group.userData.bar,
      group.userData.barBack,
      group.userData.build,
      ...(group.userData.chevrons || []),
    ].filter(Boolean);
    for (const o of hidden) o.visible = false;
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.userData.billboard) o.visible = false;
    });
  }

  _makeModelPreviewFallback(type, kind, colorHex) {
    const g = new THREE.Group();
    const mat = this.unitMat(colorHex);
    const dark = this.envMats.dark;
    if (kind === 'road') {
      g.add(boxMesh(2.8, 0.12, 1.0, dark, 0, 0.06, 0));
      g.add(boxMesh(0.16, 0.14, 0.62, this.envMats.hazard, -0.6, 0.15, 0));
      g.add(boxMesh(0.16, 0.14, 0.62, this.envMats.hazard, 0.25, 0.15, 0));
      g.add(boxMesh(0.16, 0.14, 0.62, this.envMats.hazard, 1.1, 0.15, 0));
    } else if (kind === 'bridge') {
      g.add(boxMesh(3.0, 0.22, 1.15, this.envMats.roof, 0, 0.35, 0));
      g.add(boxMesh(3.1, 0.16, 0.14, dark, 0, 0.58, -0.54));
      g.add(boxMesh(3.1, 0.16, 0.14, dark, 0, 0.58, 0.54));
      for (const x of [-1.1, 0, 1.1]) g.add(cylMesh(0.08, 0.08, 0.7, dark, x, 0.16, -0.42, 6));
    } else {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), mat));
      g.children[0].position.y = 0.6;
    }
    return g;
  }

  updateConstructionJobs(jobs) {
    const live = new Set();
    const terraPreview = [];
    for (const j of jobs || []) {
      const [id, , tx, ty, dir, px, py, appliedRaw = 0] = j;
      const remaining = Math.max(0, TERRA_PREVIEW_DELTA - Math.abs((appliedRaw || 0) / 1000));
      if (remaining > 0.0005) terraPreview.push({ tx, ty, dir: dir > 0 ? 1 : -1, amount: remaining });
      if (px >= 0 && py >= 0) {
        const pkey = 'p' + id; live.add(pkey);
        let pile = this.jobGhosts.get(pkey);
        if (!pile) {
          pile = this._makePileMarker();
          this.jobGhosts.set(pkey, pile);
          this.scene.add(pile);
        }
        const pxw = (px + 0.5) * TILE, pzw = (py + 0.5) * TILE;
        pile.position.set(pxw, this.heightAt(pxw, pzw) + 0.35, pzw);
        pile.visible = true;
      }
    }
    this._terraformJobPreview = terraPreview;
    this._updateTerraformPreviewMesh();
    for (const [key, ghost] of this.jobGhosts) {
      if (!live.has(key)) {
        this.scene.remove(ghost);
        this.jobGhosts.delete(key);
      }
    }
  }

  _makePileMarker() {
    const geo = new THREE.ConeGeometry(0.95, 0.85, 7);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3da9ff, transparent: true, opacity: 0.3, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 6;
    return m;
  }

  _makeCargoLoad(kind) {
    const g = new THREE.Group();
    if (kind === 'ore') {
      for (let i = 0; i < 5; i++) {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + (i % 3) * 0.035, 0), this.envMats.dark);
        rock.position.set((i - 2) * 0.18, 0.05 + (i % 2) * 0.08, -0.16 + (i % 3) * 0.16);
        rock.scale.set(1.2, 0.65 + (i % 2) * 0.2, 1.0);
        rock.rotation.set(i * 0.4, i * 0.7, i * 0.23);
        rock.castShadow = true; rock.receiveShadow = true; g.add(rock);
      }
    } else {
      g.add(boxMesh(0.48, 0.34, 0.52, this.envMats.roof, -0.34, 0.0, -0.18, 0.12));
      g.add(boxMesh(0.44, 0.38, 0.48, this.envMats.roof, 0.26, 0.02, 0.06, -0.1));
      const mound = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.38, 7), this.envMats.roof);
      mound.position.set(0.02, 0.16, -0.12); mound.rotation.y = 0.6;
      mound.castShadow = true; mound.receiveShadow = true; g.add(mound);
    }
    return g;
  }

  _updateCargoVisual(g, e) {
    const cargoKind = e.role === 'ore' ? 'ore' : 'materials';
    const cargo = g.userData.cargoMeshes ? g.userData.cargoMeshes[cargoKind] : g.userData.cargoMesh;
    if (!cargo) return;
    if (g.userData.cargoMeshes) {
      for (const [kind, mesh] of Object.entries(g.userData.cargoMeshes)) mesh.visible = kind === cargoKind && ((e.cargo || 0) > 0 || (g.userData.dumpT || 0) > 0);
    }
    const dumpTime = 1.05;
    const dumping = Math.max(0, g.userData.dumpT || 0);
    const load = Math.max(0, e.cargo || 0);
    cargo.visible = load > 0 || dumping > 0;
    const f = dumping > 0 ? Math.max(0.22, dumping / dumpTime) : Math.min(1, load / Math.max(1, g.userData.cargoCap || 80));
    cargo.scale.set(0.72 + f * 0.35, 0.62 + f * 0.48, 0.72 + f * 0.24);
    if (g.userData.dumpBed) {
      if (dumping > 0) {
        const p = 1 - dumping / dumpTime;
        const lift = Math.sin(Math.min(1, p) * Math.PI);
        g.userData.dumpBed.rotation.x = -lift * 0.72;
        cargo.position.z = -p * 0.95;
        cargo.position.y = 0.38 + lift * 0.18;
        g.userData.dumpT = Math.max(0, dumping - this._lastDt);
      } else {
        g.userData.dumpBed.rotation.x += (0 - g.userData.dumpBed.rotation.x) * smoothAlpha(this._lastDt, 9);
        cargo.position.set(0, 0.38, 0);
      }
    }
  }

  _freshTrackFx(e) {
    if (!this.trackFxGeo || !this._canSpawnEffect(2)) return;
    const fx = Math.cos(e.facing), fz = Math.sin(e.facing);
    const sx = -fz, sz = fx;
    const baseX = e.x - fx * 0.68, baseZ = e.y - fz * 0.68;
    const heavy = HEAVY_TRACK_KINDS.has(e.kind);
    const sideOff = heavy ? 0.58 : 0.46;
    for (const side of [-1, 1]) {
      if (!this._canSpawnEffect()) break;
      const x = baseX + sx * side * sideOff;
      const z = baseZ + sz * side * sideOff;
      const mat = new THREE.MeshLambertMaterial({ color: heavy ? 0x211910 : 0x2b241a, transparent: true, opacity: heavy ? 0.42 : 0.32, depthWrite: false });
      const m = new THREE.Mesh(this.trackFxGeo, mat);
      m.position.set(x, this.heightAt(x, z) + 0.075, z);
      m.rotation.y = Math.PI / 2 - e.facing;
      m.renderOrder = 2;
      this.scene.add(m);
      this._addEffect({ mesh: m, life: 0, max: heavy ? 11 : 7, opacity: mat.opacity });
    }
  }

  spawnDumpCargo(x, z, dx = x, dz = z) {
    const y = this.heightAt(x, z);
    const a = Math.atan2(dz - z, dx - x);
    for (let i = 0; i < 7 && this._canSpawnEffect(); i++) {
      const side = (i - 3) * 0.15;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13 + (i % 3) * 0.035, 0), this.envMats.roof);
      chunk.position.set(x + Math.cos(a + Math.PI / 2) * side, y + 1.1 + i * 0.025, z + Math.sin(a + Math.PI / 2) * side);
      chunk.castShadow = true; chunk.receiveShadow = true;
      this.scene.add(chunk);
      this._addEffect({
        mesh: chunk, life: 0, max: 0.9 + i * 0.05, opacity: 1, noFade: true,
        vx: Math.cos(a) * (1.1 + i * 0.08), vz: Math.sin(a) * (1.1 + i * 0.08), vy: 1.3 + i * 0.12,
        grav: true, spin: 7 + i, groundY: y,
      });
    }
    this.spawnConstructionDust(x + Math.cos(a) * 0.8, z + Math.sin(a) * 0.8, false);
  }

  updatePipelineOverlay() {
    if (!this.pipeMesh || !this.height || !this._pipeAnchors) return;
    const anchors = this._pipeAnchors;
    let h = 2166136261 >>> 0;
    for (const a of anchors) {
      h = Math.imul(h ^ (a.id | 0), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(a.x * 10), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(a.z * 10), 16777619) >>> 0;
    }
    const sig = `${anchors.length}:${h}`;
    if (sig === this._pipeSig) return;
    this._pipeSig = sig;
    this._replaceMeshGeometry(this.pipeMesh, this._makePipelineGeometry(this._pipelineEdges()));
  }

  _pipelineEdges() {
    const edges = [], used = new Set();
    const pipes = (this._pipeAnchors || []).filter(a => a.kind === 'pipe');
    for (const a of pipes) {
      const byDir = new Map();
      for (const b of this._pipeAnchors || []) {
        if (a.id === b.id || a.owner !== b.owner) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.05) continue;
        const tileDist = Math.max(Math.abs(b.tx - a.tx), Math.abs(b.ty - a.ty));
        const maxDist = b.kind === 'pipe' ? 2.05 : 3.15;
        if (tileDist > maxDist) continue;
        const dir = this._pipeDirection(dx, dz);
        if (!dir) continue;
        const key = `${dir.x.toFixed(3)},${dir.z.toFixed(3)}`;
        const prev = byDir.get(key);
        if (!prev || dist < prev.dist) byDir.set(key, { b, dist, dir });
      }
      for (const { b, dist } of byDir.values()) {
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (used.has(key)) continue;
        used.add(key);
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        const ux = dx / len, uz = dz / len;
        let x1 = b.x, z1 = b.z;
        if (b.kind !== 'pipe') {
          const inset = Math.max(0.45, (b.size || 1) * TILE * 0.36);
          x1 -= ux * inset;
          z1 -= uz * inset;
        }
        // Anschluss an ein Gebäude (Pumpwerk/Bohrturm/Depot) → letztes Stück als flexibler Schlauch.
        if (Math.hypot(x1 - a.x, z1 - a.z) > 0.35) edges.push({ x0: a.x, z0: a.z, x1, z1, dist, flex: b.kind !== 'pipe' });
      }
    }
    return edges;
  }

  _makePipelineGeometry(edges) {
    if (!edges.length) return this._makeEmptyOverlayGeometry();
    const positions = [], indices = [], flows = [];
    const seg = 8, radius = 0.17;
    const edgeInfos = edges.map((e, index) => {
      const dx = e.x1 - e.x0, dz = e.z1 - e.z0, len = Math.hypot(dx, dz);
      const ux = len > 0 ? dx / len : 1, uz = len > 0 ? dz / len : 0;
      return { e, index, len, ux, uz, rx: -uz, rz: ux, passThrough: false, flex: !!e.flex };
    });
    const pointKey = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
    const endpointMap = new Map();
    const addEndpoint = (key, index) => {
      const list = endpointMap.get(key);
      if (list) list.push(index);
      else endpointMap.set(key, [index]);
    };
    for (const info of edgeInfos) {
      if (info.len < 0.05) continue;
      info.k0 = pointKey(info.e.x0, info.e.z0);
      info.k1 = pointKey(info.e.x1, info.e.z1);
      addEndpoint(info.k0, info.index);
      addEndpoint(info.k1, info.index);
    }
    const seen = new Set();
    for (const info of edgeInfos) {
      if (info.len < 0.05 || seen.has(info.index)) continue;
      const stack = [info.index], component = [];
      let total = 0;
      seen.add(info.index);
      while (stack.length) {
        const idx = stack.pop();
        const cur = edgeInfos[idx];
        component.push(cur);
        total += cur.len;
        for (const key of [cur.k0, cur.k1]) {
          for (const next of endpointMap.get(key) || []) {
            if (seen.has(next)) continue;
            seen.add(next);
            stack.push(next);
          }
        }
      }
      if (total >= PIPE_BRIDGE_CHAIN_MIN) for (const cur of component) cur.passThrough = true;
    }
    const liftAt = (x, z, ux, uz, enabled) => {
      if (!enabled) return 0;
      const along = x * ux + z * uz;
      const phase = ((along % PIPE_BRIDGE_SPACING) + PIPE_BRIDGE_SPACING) % PIPE_BRIDGE_SPACING;
      const d = Math.abs(phase - PIPE_BRIDGE_SPACING * 0.5);
      const half = PIPE_BRIDGE_WIDTH * 0.5;
      if (d >= half) return 0;
      const u = 1 - d / half;
      return Math.sin(u * Math.PI * 0.5) * PIPE_BRIDGE_LIFT;
    };
    const addRing = (x, y, z, rx, rz, rad = radius, flow = 0) => {
      const start = positions.length / 3;
      for (let n = 0; n < seg; n++) {
        const a = (n / seg) * Math.PI * 2;
        const side = Math.cos(a) * rad, up = Math.sin(a) * rad;
        positions.push(x + rx * side, y + up, z + rz * side);
        flows.push(flow);
      }
      return start;
    };
    for (const info of edgeInfos) {
      if (info.len < 0.05) continue;
      let prev = -1;
      const flexRad = info.flex ? PIPE_FLEX_RADIUS : radius;
      const steps = Math.max(info.flex ? 4 : 1, Math.ceil(info.len / (TILE * 0.45)));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const x = info.e.x0 + (info.e.x1 - info.e.x0) * f;
        const z = info.e.z0 + (info.e.z1 - info.e.z0) * f;
        // Flexibler Schlauch: durchhängende Kettenlinie (Sinus-Bogen) statt starrer Geraden.
        const sag = info.flex ? PIPE_FLEX_SAG * Math.sin(f * Math.PI) : 0;
        const y = this.heightAt(x, z) + 0.42 + liftAt(x, z, info.ux, info.uz, info.passThrough) - sag;
        const cur = addRing(x, y, z, info.rx, info.rz, flexRad, f * info.len); // Bogenlänge → Fluss-Phase
        if (prev >= 0) {
          for (let n = 0; n < seg; n++) {
            const p = (n + 1) % seg;
            indices.push(prev + n, prev + p, cur + p, prev + n, cur + p, cur + n);
          }
        }
        prev = cur;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 1)); // Bogenlänge für Durchfluss-Shader
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // Pipe-Gebäude selbst sind nur noch Kupplungen; die langen Rohrstrecken entstehen im
  // globalen Pipeline-Mesh, damit die Leitung nicht als Sammlung gedrehter Einzelstücke wirkt.
  _orientPipe(g, e) {
    const body = g.userData.body;
    if (!body || !this._pipeAnchors) return;
    g.rotation.y = 0;
    const links = this._pipeLinksFor(e);
    const sig = links.length
      ? links.map(l => `${l.dirX},${l.dirZ},${l.length.toFixed(2)},${l.targetKind}`).join('|')
      : 'stub';
    if (body.userData._pipeSig === sig) return;
    this._rebuildPipeBody(body, links);
    body.userData._pipeSig = sig;
  }

  _pipeLinksFor(e) {
    const tx = e.x / TILE - 0.5, ty = e.y / TILE - 0.5;
    const byDir = new Map();
    for (const a of this._pipeAnchors || []) {
      if (a.id === e.id || a.owner !== e.owner) continue;
      const dx = a.x - e.x, dz = a.z - e.y;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.05) continue;
      const tileDist = Math.max(Math.abs(a.tx - tx), Math.abs(a.ty - ty));
      const isPipe = a.kind === 'pipe';
      const maxDist = isPipe ? 2.05 : 3.15;
      if (tileDist > maxDist) continue;
      const dir = this._pipeDirection(dx, dz);
      if (!dir) continue;
      const key = dir.x + ',' + dir.z;
      const prev = byDir.get(key);
      if (prev && prev.dist <= dist) continue;
      byDir.set(key, { ...dir, dist, targetKind: a.kind, targetSize: a.size || 1 });
    }
    return [...byDir.values()].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x)).map(l => {
      const toPipe = l.targetKind === 'pipe';
      const edgeInset = toPipe ? 0 : Math.max(0.45, l.targetSize * TILE * 0.34);
      return {
        dirX: l.x,
        dirZ: l.z,
        targetKind: l.targetKind,
        length: toPipe ? l.dist * 0.56 : Math.max(TILE * 0.58, l.dist - edgeInset),
      };
    });
  }

  _pipeDirection(dx, dz) {
    const ax = Math.abs(dx), az = Math.abs(dz);
    if (ax < 0.05 && az < 0.05) return null;
    let x = Math.sign(dx), z = Math.sign(dz);
    if (ax < az * 0.45) x = 0;
    if (az < ax * 0.45) z = 0;
    const len = Math.hypot(x, z);
    return len ? { x: x / len, z: z / len } : null;
  }

  _rebuildPipeBody(body, links) {
    for (const child of [...body.children]) {
      child.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
      body.remove(child);
    }
    const metal = this.envMats.metal, dark = this.envMats.dark, signal = this.envMats.signal || this.envMats.hazard;
    const y = 0.28;
    const hub = cylMesh(0.28, 0.28, 0.24, dark, 0, y, 0, 14);
    hub.rotation.x = Math.PI / 2;
    body.add(hub);
    const valve = cylMesh(0.09, 0.09, 0.72, metal, 0, y + 0.1, 0, 8);
    valve.rotation.z = Math.PI / 2;
    body.add(valve);
    body.add(boxMesh(0.46, 0.10, 0.46, dark, 0, 0.05, 0));
    if (links.length <= 1) {
      body.add(boxMesh(0.18, 0.16, 0.18, signal, -0.24, y + 0.04, 0));
    }
  }

  makeMesh(e, colorHex) {
    const g = new THREE.Group();
    g.userData.kind = e.kind;
    const col = new THREE.Color(colorHex);
    let body;
    if (e.etype === 'building') {
      // Detailliertes prozedurales Gebäudemodell; nur unbekannte Kinds fallen auf den Kasten zurück.
      const mats = { ...this.envMats, body: this.unitMat(colorHex) };
      body = e.kind === 'earth_pile' ? makeEarthPileMesh(this.envMats.roof)
        : e.kind === 'ore_pile' ? makeOrePileMesh(this.envMats.dark)
          : makeBuildingMesh(e.kind, e.size, mats);
      const sz = e.size * TILE * 0.8, hgt = 2 + e.size * 1.6;
      if (!body) {
        body = new THREE.Mesh(new THREE.BoxGeometry(sz, hgt, sz), this.unitMat(colorHex));
        body.position.y = hgt / 2;
      }
      if (body.userData) {
        if (body.userData.spin) {
          g.userData.spin = body.userData.spin;
          g.userData.spinSpeed = body.userData.spinSpeed || 1.2;
        }
        if (body.userData.anims) g.userData.buildingAnims = body.userData.anims;
        if (body.userData.smokeStacks) g.userData.smokeStacks = body.userData.smokeStacks;
      }
      g.userData.lift = 0; g.userData.big = e.size >= 3;
      // Schwimmende Wasserbauten (Pumpwerk/Werft/Ponton) bekommen KEIN Betonfundament — sie sitzen auf
      // der Wasseroberfläche; ein tief reichender Sockel würde unter Wasser herausstechen.
      const low = ['wall', 'trench', 'levee', 'pipe', 'bridge', 'road', 'tunnel', 'earth_pile', 'ore_pile'].includes(e.kind)
        || WATER_BUILDINGS.has(e.kind);
      // Fundament: Gebäude stehen gerade (Gruppe auf höchster Ecke), der Betonsockel
      // reicht tief nach unten und schließt am Hang den Spalt zum Gelände.
      if (!low) {
        const sz = e.size * TILE;
        const slab = boxMesh(sz * 1.06, 3.6, sz * 1.06, this.envMats.concrete, 0, -1.82, 0);
        g.add(slab);
        // Hoflampe (Lampen-Mesh an jedem Gebäude; echte Punktlichter kommen aus dem Pool)
        const px = sz * 0.42;
        const pole = cylMesh(0.05, 0.07, 1.7, this.envMats.metal, px, 0.85, px, 6);
        g.add(pole);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), this.lampMat);
        head.position.set(px, 1.78, px); g.add(head);
        // Fundament + Hoflampe für die Vorschau (Techtree/Baumenü) ausblenden — dort nur das Gebäude.
        g.userData.foundation = [slab, pole, head];
      } else g.userData.noLamp = true;
      // Fenster-Meshes einsammeln (Lastabwurf schaltet sie auf das „aus"-Material um).
      const winMeshes = [];
      body.traverse?.((o) => { if (o.isMesh && o.material === this.winMat) winMeshes.push(o); });
      g.userData.winMeshes = winMeshes;
      g.userData.poweredState = true;
      // Bau-Indikator (Gerüst)
      const bm = new THREE.Mesh(new THREE.BoxGeometry(sz * 1.05, low ? 1.4 : hgt * 1.05, sz * 1.05),
        new THREE.MeshBasicMaterial({ color: 0x5cc7ff, transparent: true, opacity: 0.55, wireframe: true }));
      bm.position.y = low ? 0.7 : hgt / 2; bm.visible = false; g.add(bm); g.userData.build = bm;
      addRing(g, e.size * (low ? 1.1 : 1.4), col);
    } else {
      // Echtes CC0-Modell, falls geladen; sonst prozedurales Platzhalter-Mesh.
      const modelBody = this.models.instance(e.kind, colorHex);
      const m = modelBody ? null : this.unitMat(colorHex);
      const dark = this.envMats.dark, metal = this.envMats.metal;
      if (modelBody) {
        body = modelBody; g.userData.lift = this.models.liftFor(e.kind);
        if (e.kind === 'gunship') this._addHeliRotors(g, body);
      } else if (e.kind === 'rifleman' || e.kind === 'at_soldier' || e.kind === 'aa_soldier' || e.kind === 'engineer') {
        // Low-Poly-Infanterie: gemeinsame Grundgröße, aber klare Silhouette je Rolle.
        body = new THREE.Group();
        const heavyInf = e.kind === 'at_soldier' || e.kind === 'aa_soldier';
        const torsoW = e.kind === 'engineer' ? 0.62 : heavyInf ? 0.60 : 0.50;
        body.add(boxMesh(torsoW, 0.72, 0.36, m, 0, 1.0, 0));               // Torso
        body.add(boxMesh(0.30, 0.28, 0.30, dark, 0, 1.52, 0));             // Kopf/Helm
        body.add(boxMesh(0.15, 0.62, 0.20, dark, -0.14, 0.34, 0));         // Beine
        body.add(boxMesh(0.15, 0.62, 0.20, dark, 0.14, 0.34, 0));
        body.add(boxMesh(0.12, 0.52, 0.14, dark, -torsoW * 0.56, 0.98, 0));
        body.add(boxMesh(0.12, 0.52, 0.14, dark, torsoW * 0.56, 0.98, 0));
        if (e.kind === 'rifleman') {
          body.add(boxMesh(0.08, 0.08, 1.05, metal, 0.31, 1.08, 0.34));     // langes Gewehr vorn
          body.add(boxMesh(0.28, 0.08, 0.16, dark, 0.18, 1.13, -0.12));     // Schulterstütze
          body.add(boxMesh(0.38, 0.08, 0.08, dark, 0, 1.70, -0.05));        // flacher Helmrand
        } else if (e.kind === 'at_soldier') {
          const tube = cylMesh(0.11, 0.11, 1.15, metal, 0.36, 1.48, 0.05, 8);
          tube.rotation.x = Math.PI / 2; body.add(tube);                   // dickes Panzerabwehrrohr
          body.add(boxMesh(0.30, 0.46, 0.18, dark, -0.34, 1.04, -0.18));    // Munitionsrucksack
          body.add(boxMesh(0.18, 0.16, 0.20, this.envMats.hazard, 0.36, 1.48, 0.68));
        } else if (e.kind === 'aa_soldier') {
          const tubeA = cylMesh(0.075, 0.075, 1.0, metal, 0.30, 1.46, 0.02, 8);
          const tubeB = cylMesh(0.075, 0.075, 1.0, metal, 0.48, 1.46, 0.02, 8);
          tubeA.rotation.x = Math.PI / 2; tubeB.rotation.x = Math.PI / 2;
          tubeA.rotation.z = -0.22; tubeB.rotation.z = -0.22;
          body.add(tubeA); body.add(tubeB);                                 // Zwillings-Flugabwehrstarter
          body.add(boxMesh(0.22, 0.22, 0.30, this.envMats.signal, 0.42, 1.50, 0.58));
          const sensor = cylMesh(0.13, 0.13, 0.035, this.envMats.glass, -0.36, 1.62, 0.22, 14);
          sensor.rotation.x = Math.PI / 2; body.add(sensor);                // kleiner Suchkopf/Sensor
        } else if (e.kind === 'engineer') {
          body.add(boxMesh(0.34, 0.12, 0.26, this.envMats.hazard, 0, 1.72, 0)); // Bauhelm
          body.add(boxMesh(0.46, 0.54, 0.12, this.envMats.hazard, 0, 1.02, 0.20)); // Warnweste
          body.add(boxMesh(0.24, 0.36, 0.16, dark, -0.38, 1.02, -0.12));    // Werkzeugtasche
          const tool = cylMesh(0.035, 0.035, 0.82, metal, 0.38, 1.04, 0.12, 6);
          tool.rotation.z = 0.72; body.add(tool);                           // Schaufel/Tool am Arm
        }
        g.userData.lift = 0;
        g.userData.walks = true;   // Geh-Animation (Bob + Lean) im sync()
      } else if (e.kind === 'scout') {
        // Späher: niedrige Rad-Silhouette mit klarer Frontscheibe.
        body = new THREE.Group();
        body.add(boxMesh(1.25, 0.45, 1.9, dark, 0, 0.38, -0.05));
        body.add(boxMesh(0.9, 0.55, 0.8, m, 0, 0.85, 0.35));
        body.add(boxMesh(0.62, 0.22, 0.08, this.envMats.glass, 0, 0.95, 0.78));
        body.add(boxMesh(0.5, 0.18, 0.42, dark, 0, 1.16, -0.2));
        const antenna = cylMesh(0.025, 0.025, 0.9, metal, -0.42, 1.32, -0.35, 5);
        antenna.rotation.z = -0.35; body.add(antenna);
        for (const sx of [-0.62, 0.62]) for (const sz of [-0.58, 0.58]) {
          const wh = cylMesh(0.2, 0.2, 0.14, dark, sx, 0.28, sz, 9);
          wh.rotation.z = Math.PI / 2; body.add(wh);
        }
        g.userData.lift = 0;
      } else if (e.kind === 'tank') {
        // Panzer: Ketten, Keilwanne, Turm und langes Rohr.
        body = new THREE.Group();
        for (const sx of [-0.66, 0.66]) body.add(boxMesh(0.38, 0.42, 2.35, dark, sx, 0.32, -0.05));
        body.add(boxMesh(1.45, 0.58, 2.05, m, 0, 0.68, -0.02));
        body.add(boxMesh(1.1, 0.36, 0.9, dark, 0, 1.1, 0.08));
        const turret = cylMesh(0.5, 0.58, 0.34, m, 0, 1.22, 0.08, 8);
        turret.rotation.y = Math.PI / 8; body.add(turret);
        const barrel = cylMesh(0.08, 0.11, 1.75, metal, 0, 1.27, 1.08, 8);
        barrel.rotation.x = Math.PI / 2; body.add(barrel);
        body.add(boxMesh(0.32, 0.16, 0.34, this.envMats.glass, -0.24, 1.42, -0.28));
        g.userData.lift = 0;
      } else if (e.kind === 'flak_track') {
        // Flakfahrzeug: Halbketten-Chassis mit offenem Doppelrohr oben.
        body = new THREE.Group();
        body.add(boxMesh(1.35, 0.42, 2.15, dark, 0, 0.34, -0.05));
        body.add(boxMesh(1.05, 0.58, 1.35, m, 0, 0.78, -0.28));
        body.add(boxMesh(0.9, 0.62, 0.72, m, 0, 0.92, 0.68));
        body.add(boxMesh(0.62, 0.2, 0.08, this.envMats.glass, 0, 1.02, 1.05));
        const mount = cylMesh(0.28, 0.34, 0.24, metal, 0, 1.28, -0.42, 8);
        mount.rotation.y = Math.PI / 6; body.add(mount);
        for (const sx of [-0.12, 0.12]) {
          const gun = cylMesh(0.045, 0.06, 1.1, metal, sx, 1.55, 0.06, 7);
          gun.rotation.x = Math.PI / 2 - 0.45; body.add(gun);
        }
        for (const sx of [-0.62, 0.62]) for (const sz of [-0.65, 0.52]) {
          const wh = cylMesh(0.2, 0.2, 0.14, dark, sx, 0.28, sz, 9);
          wh.rotation.z = Math.PI / 2; body.add(wh);
        }
        g.userData.lift = 0;
      } else if (e.kind === 'builder') {
        // Radlader: zivile Baumaschine mit Frontschaufel statt Kettenbagger.
        body = new THREE.Group();
        body.add(boxMesh(1.45, 0.46, 2.15, dark, 0, 0.44, -0.08));
        body.add(boxMesh(1.15, 0.7, 1.08, m, 0, 0.92, -0.25));
        body.add(boxMesh(0.8, 0.68, 0.66, this.envMats.glass, 0.05, 1.25, -0.12));
        body.add(boxMesh(1.0, 0.34, 0.72, this.envMats.hazard, 0, 0.82, 0.76));
        for (const sx of [-0.68, 0.68]) for (const sz of [-0.72, 0.62]) {
          const wh = cylMesh(0.34, 0.34, 0.2, dark, sx, 0.36, sz, 12);
          wh.rotation.z = Math.PI / 2; body.add(wh);
          const hub = cylMesh(0.16, 0.16, 0.22, metal, sx, 0.36, sz, 10);
          hub.rotation.z = Math.PI / 2; body.add(hub);
        }
        const arms = new THREE.Group();
        arms.position.set(0, 0.88, 0.72);
        for (const sx of [-0.42, 0.42]) {
          const beam = boxMesh(0.08, 0.1, 1.65, this.envMats.hazard, sx, 0, 0.62);
          beam.rotation.x = -0.18; arms.add(beam);
          const link = boxMesh(0.06, 0.08, 0.82, metal, sx, -0.18, 1.12);
          link.rotation.x = 0.28; arms.add(link);
        }
        const bucket = new THREE.Group();
        bucket.position.set(0, -0.22, 1.55);
        bucket.add(boxMesh(1.25, 0.16, 0.54, dark, 0, 0, 0));
        bucket.add(boxMesh(1.28, 0.38, 0.12, dark, 0, 0.16, 0.24));
        bucket.add(boxMesh(0.1, 0.34, 0.54, dark, -0.64, 0.12, 0));
        bucket.add(boxMesh(0.1, 0.34, 0.54, dark, 0.64, 0.12, 0));
        bucket.add(boxMesh(1.38, 0.08, 0.08, metal, 0, -0.06, 0.31));
        bucket.rotation.x = 0.18;
        arms.add(bucket);
        body.add(arms);
        g.userData.loaderArms = arms;
        g.userData.loaderBucket = bucket;
        g.userData.lift = 0;
      } else if (e.kind === 'tractor') {
        // Traktor: Bergungsfahrzeug mit großen Hinterrädern und Abschlepphaken.
        body = new THREE.Group();
        body.add(boxMesh(1.25, 0.44, 1.85, dark, 0, 0.42, -0.08));
        body.add(boxMesh(0.92, 0.82, 0.78, m, 0.02, 0.92, 0.42));
        body.add(boxMesh(0.64, 0.26, 0.08, this.envMats.glass, 0.02, 1.04, 0.82));
        body.add(boxMesh(1.05, 0.32, 0.74, this.envMats.hazard, 0, 0.72, -0.86));
        const hook = cylMesh(0.04, 0.04, 0.7, metal, 0, 0.55, -1.38, 6);
        hook.rotation.x = Math.PI / 2; body.add(hook);
        for (const sx of [-0.64, 0.64]) {
          const rear = cylMesh(0.34, 0.34, 0.18, dark, sx, 0.36, -0.62, 12);
          rear.rotation.z = Math.PI / 2; body.add(rear);
          const front = cylMesh(0.22, 0.22, 0.14, dark, sx * 0.82, 0.32, 0.72, 10);
          front.rotation.z = Math.PI / 2; body.add(front);
        }
        g.userData.lift = 0;
      } else if (e.kind === 'harvester' || e.kind === 'truck') {
        // LKW: Fahrerhaus + klar sichtbare Ladefläche; Erz-LKW mit Mulde, normaler LKW als Pritsche.
        body = new THREE.Group();
        body.add(boxMesh(1.55, 0.45, 2.45, dark, 0, 0.38, 0));
        body.add(boxMesh(1.05, 0.95, 0.85, m, 0, 0.95, 0.75));
        body.add(boxMesh(0.85, 0.34, 0.08, this.envMats.glass, 0, 1.08, 1.19));
        if (e.kind === 'harvester') {
          const bed = boxMesh(1.35, 0.55, 1.45, this.envMats.roof, 0, 0.88, -0.58);
          bed.rotation.x = -0.08; body.add(bed);
          const cargo = this._makeCargoLoad('ore');
          cargo.position.set(0, 1.28, -0.58);
          cargo.visible = false;
          body.add(cargo);
          g.userData.cargoMesh = cargo;
          g.userData.cargoCap = e.harvestCap || 200;
        } else {
          const bed = new THREE.Group();
          bed.position.set(0, 0.78, -0.58);
          bed.add(boxMesh(1.42, 0.16, 1.55, this.envMats.hazard, 0, 0, 0));
          bed.add(boxMesh(0.1, 0.46, 1.5, this.envMats.roof, -0.71, 0.22, 0));
          bed.add(boxMesh(0.1, 0.46, 1.5, this.envMats.roof, 0.71, 0.22, 0));
          bed.add(boxMesh(1.38, 0.34, 0.1, this.envMats.roof, 0, 0.18, -0.74));
          const matCargo = this._makeCargoLoad('materials');
          matCargo.position.set(0, 0.38, 0);
          matCargo.visible = false;
          bed.add(matCargo);
          const oreCargo = this._makeCargoLoad('ore');
          oreCargo.position.set(0, 0.42, 0);
          oreCargo.visible = false;
          bed.add(oreCargo);
          body.add(bed);
          g.userData.dumpBed = bed;
          g.userData.cargoMeshes = { materials: matCargo, ore: oreCargo };
          g.userData.cargoMesh = matCargo;
          g.userData.cargoCap = 80;
        }
        for (const sx of [-0.68, 0.68]) for (const sz of [-0.78, 0.72]) {
          const wh = cylMesh(0.23, 0.23, 0.16, dark, sx, 0.32, sz, 10);
          wh.rotation.z = Math.PI / 2; body.add(wh);
        }
        g.userData.lift = 0;
      } else if (e.kind === 'rocket_launcher') {
        // Raketenwerfer: schweres Fahrgestell mit angewinkeltem Werferkasten.
        body = new THREE.Group();
        for (const sx of [-0.64, 0.64]) body.add(boxMesh(0.36, 0.36, 2.25, dark, sx, 0.32, -0.04));
        body.add(boxMesh(1.42, 0.5, 2.05, m, 0, 0.62, -0.06));
        body.add(boxMesh(0.85, 0.55, 0.7, this.envMats.glass, 0, 0.98, 0.62));
        const rack = new THREE.Group();
        rack.position.set(0, 1.22, -0.42);
        rack.rotation.x = -0.46;
        rack.add(boxMesh(1.15, 0.42, 1.05, dark, 0, 0, 0));
        for (const sx of [-0.34, 0, 0.34]) for (const sy of [-0.12, 0.12]) {
          const tube = cylMesh(0.055, 0.065, 1.15, metal, sx, sy, 0.05, 7);
          tube.rotation.x = Math.PI / 2; rack.add(tube);
        }
        body.add(rack);
        g.userData.lift = 0;
      } else if (e.kind === 'artillery') {
        // Haubitze: flaches Chassis, Lafette, langes aufgerichtetes Rohr.
        body = new THREE.Group();
        body.add(boxMesh(1.7, 0.6, 2.6, m, 0, 0.45, 0));
        body.add(boxMesh(0.9, 0.5, 1.2, dark, 0, 0.95, -0.3));
        const barrel = cylMesh(0.09, 0.13, 3.0, metal, 0, 1.55, 0.7);
        barrel.rotation.x = Math.PI / 2 - 0.5; body.add(barrel);
        body.add(boxMesh(1.9, 0.3, 0.5, dark, 0, 0.2, -1.3));               // Erdsporn
        g.userData.lift = 0;
      } else if (e.kind === 'bomber' || e.kind === 'transport_air' || e.kind === 'cloud_seeder') {
        // Starrflügler: Rumpf, Tragflächen, Leitwerk, Triebwerksgondeln.
        body = new THREE.Group();
        const fat = e.kind === 'transport_air' ? 0.55 : e.kind === 'cloud_seeder' ? 0.34 : 0.4;
        const fus = cylMesh(fat, fat * 0.8, 3.4, m, 0, 0, 0.2, 10);
        fus.rotation.x = Math.PI / 2; body.add(fus);
        const nose = new THREE.Mesh(new THREE.SphereGeometry(fat, 8, 6), m); nose.position.set(0, 0, 1.95); body.add(nose);
        body.add(boxMesh(e.kind === 'cloud_seeder' ? 4.5 : 4.0, 0.12, 1.0, m, 0, 0.1, 0.3)); // Flügel
        body.add(boxMesh(1.5, 0.1, 0.6, m, 0, 0.45, -1.5));                  // Höhenleitwerk
        body.add(boxMesh(0.1, 0.8, 0.7, m, 0, 0.5, -1.5));                   // Seitenleitwerk
        for (const sx of [-1.1, 1.1]) {
          const pod = cylMesh(0.18, 0.18, 0.7, dark, sx, -0.08, 0.55, 8);
          pod.rotation.x = Math.PI / 2; body.add(pod);
        }
        if (e.kind === 'cloud_seeder') {
          for (const sx of [-1.65, 1.65]) {
            const tank = cylMesh(0.16, 0.16, 0.82, this.envMats.glass, sx, -0.12, 0.12, 9);
            tank.rotation.x = Math.PI / 2; body.add(tank);
            const nozzle = cylMesh(0.035, 0.035, 0.34, this.envMats.metal, sx, -0.26, -0.4, 6);
            nozzle.rotation.x = Math.PI / 2; body.add(nozzle);
          }
        }
        g.userData.lift = 9;
      } else if (e.kind === 'recon_drone') {
        // Quadrocopter: Kugelkern, vier Ausleger mit Rotorscheiben (drehen im sync()).
        body = new THREE.Group();
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), m); body.add(core);
        const rotor = new THREE.Group();
        for (const [ax, az] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
          body.add(boxMesh(Math.abs(ax) * 1.6, 0.07, 0.1, dark, ax / 2, 0.1, az / 2, Math.atan2(az, ax)));
          const disc = cylMesh(0.45, 0.45, 0.03, metal, ax, 0.22, az, 10);
          disc.material = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4 });
          rotor.add(disc);
        }
        body.add(rotor); g.userData.rotor = rotor;
        g.userData.lift = 9;
      } else if (e.kind === 'underwater_drone') {
        // Unterwasserdrohne: kleine getauchte Kapsel mit Sensorbuckel und Flossen.
        body = new THREE.Group();
        const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.35, 4, 8), m);
        hull.rotation.x = Math.PI / 2; hull.position.y = 0.18; body.add(hull);
        body.add(new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), this.envMats.glass));
        body.children[1].position.set(0, 0.36, 0.38);
        body.add(boxMesh(1.0, 0.05, 0.28, dark, 0, 0.18, -0.54));
        body.add(boxMesh(0.08, 0.38, 0.28, dark, 0, 0.32, -0.68));
        g.userData.lift = 0;
      } else if (e.kind === 'submarine') {
        // U-Boot: Druckkörper (Kapsel) + Turm + Tiefenruder; liegt tief im Wasser.
        body = new THREE.Group();
        const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 2.6, 4, 8), m);
        hull.rotation.x = Math.PI / 2; hull.position.y = 0.3; body.add(hull);
        body.add(boxMesh(0.5, 0.7, 1.0, dark, 0, 0.95, 0.2));
        body.add(cylMesh(0.04, 0.04, 0.8, metal, 0.1, 1.5, 0.1, 6));        // Periskop
        body.add(boxMesh(1.6, 0.08, 0.5, dark, 0, 0.3, -1.2));              // Heckruder
        g.userData.lift = 0;
      } else if (['recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air'].includes(e.kind)) {
        body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 6), m); body.rotation.x = Math.PI / 2; body.position.y = 0; g.userData.lift = 9;
        if (e.kind === 'gunship') this._addHeliRotors(g, body);
      } else if (['patrol_boat', 'destroyer', 'amphib_transport', 'sea_builder'].includes(e.kind)) {
        body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 3.2), m); body.position.y = 0.4; g.userData.lift = 0;
      } else { // Fahrzeuge
        body = new THREE.Group();
        body.add(boxMesh(1.8, 0.9, 2.6, m, 0, 0.65, 0));
        const tur = boxMesh(0.9, 0.5, 1.1, m, 0, 1.35, -0.1); body.add(tur);
        const gun = cylMesh(0.07, 0.09, 1.7, metal, 0, 1.4, 0.9, 8);
        gun.rotation.x = Math.PI / 2; body.add(gun);
        for (const sx of [-0.95, 0.95]) body.add(boxMesh(0.25, 0.5, 2.5, dark, sx, 0.3, 0)); // Ketten
        g.userData.lift = 0;
      }
      // Fahrzeuglichter: vorne weiße Scheinwerfer, hinten rote Rückleuchten (+z = Fahrtrichtung).
      // Geteilte Materialien — der Tag/Nacht-Zyklus schaltet sie global hell/dunkel.
      if (!e.abandoned && LIGHTED_UNIT_KINDS.has(e.kind)) {
        for (const sx of [-0.55, 0.55]) {
          g.add(boxMesh(0.18, 0.1, 0.06, this.headMat, sx, 0.72, 1.32));
          g.add(boxMesh(0.16, 0.09, 0.05, this.rearMat, sx, 0.68, -1.34));
        }
        g.userData.vehicleLight = true;
      }
      if (LAND_VEHICLE_KINDS.has(e.kind)) {
        g.userData.tilts = true;   // Fahrzeuge legen sich an die Hangneigung an
        g.userData.dusts = !e.abandoned;   // Staubfahne bei Fahrt
      }
      addRing(g, modelBody ? 1.9 : 1.6, col);
      // Veteranen-Chevrons (max 3, anfangs unsichtbar) als kleine Billboard-Dreiecke
      const chevrons = [];
      const triShape = new THREE.Shape();
      triShape.moveTo(-0.32, 0); triShape.lineTo(0.32, 0); triShape.lineTo(0, 0.28); triShape.lineTo(-0.32, 0);
      const triGeo = new THREE.ShapeGeometry(triShape);
      for (let i = 0; i < 3; i++) {
        const ch = new THREE.Mesh(triGeo, new THREE.MeshBasicMaterial({ color: 0xffd54a, depthTest: false }));
        ch.position.set(0, 3.5 + i * 0.34, 0); ch.userData.billboard = true; ch.renderOrder = 1000; ch.visible = false;
        g.add(ch); chevrons.push(ch);
      }
      g.userData.chevrons = chevrons;
    }
    body.castShadow = true; body.receiveShadow = true;
    g.userData.castsShadow = true;
    if (e.abandoned) { body.rotation.z += 0.16; body.rotation.x += 0.04; }
    g.add(body);
    g.userData.body = body;
    if (e.etype === 'unit') this._setupUnitIdle(g, e, body);
    // HP-Balken
    const barY = e.etype === 'building' ? e.size * 2 + 2 : 3;
    const barBack = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.3), new THREE.MeshBasicMaterial({ color: 0x050505, depthTest: false }));
    barBack.position.y = barY - 0.01; barBack.rotation.x = -Math.PI / 2; barBack.renderOrder = 998;
    barBack.visible = false; g.add(barBack); g.userData.barBack = barBack;
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.3), new THREE.MeshBasicMaterial({ color: 0x4caf50, depthTest: false }));
    bar.position.y = barY; bar.rotation.x = -Math.PI / 2; bar.renderOrder = 999;
    bar.visible = false; g.add(bar); g.userData.bar = bar;
    return g;
  }

  _addHeliRotors(g, body = null) {
    if (g.userData.rotor) return;
    let top = 2.16, centerZ = 0.08, radius = 1.82, tailX = 0.62, tailY = 1.18, tailZ = -1.8, tailRadius = 0.34;
    if (body) {
      body.updateWorldMatrix?.(true, true);
      const box = new THREE.Box3().setFromObject(body);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        top = box.max.y + 0.16;
        centerZ = (box.min.z + box.max.z) * 0.5 + size.z * 0.06;
        radius = Math.max(1.25, Math.min(2.25, Math.max(size.x, size.z) * 0.43));
        tailX = Math.max(0.42, size.x * 0.28);
        tailY = box.min.y + size.y * 0.58;
        tailZ = box.min.z + size.z * 0.08;
        tailRadius = Math.max(0.24, Math.min(0.48, radius * 0.2));
      }
    }
    const main = new THREE.Group();
    main.position.set(0, top, centerZ);
    main.add(boxMesh(radius * 1.95, 0.035, 0.15, this.envMats.metal));
    main.add(boxMesh(radius * 1.95, 0.035, 0.15, this.envMats.metal, 0, 0, 0, Math.PI / 2));
    const blur = cylMesh(radius, radius, 0.012, this.rotorBlurMat, 0, 0.012, 0, 36);
    main.add(blur);
    const hub = cylMesh(0.16, 0.16, 0.14, this.envMats.dark, 0, 0.02, 0, 10);
    main.add(hub);
    const tail = new THREE.Group();
    tail.position.set(tailX, tailY, tailZ);
    tail.add(boxMesh(tailRadius * 1.7, 0.065, 0.04, this.envMats.metal));
    tail.add(boxMesh(0.065, tailRadius * 1.7, 0.04, this.envMats.metal));
    const tailBlur = new THREE.Mesh(new THREE.CircleGeometry(tailRadius, 24), this.rotorBlurMat);
    tail.add(tailBlur);
    for (const part of [main, tail]) part.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    g.add(main);
    g.add(tail);
    g.userData.rotor = main;
    g.userData.rotorSpeed = 36;
    g.userData.tailRotor = tail;
    g.userData.tailRotorSpeed = 52;
  }

  _setupUnitIdle(g, e, body) {
    if (!body) return;
    const mode = INFANTRY_KINDS.has(e.kind) ? 'infantry'
      : AIR_UNIT_KINDS.has(e.kind) ? 'air'
        : WATER_KINDS.has(e.kind) ? 'water'
          : LAND_VEHICLE_KINDS.has(e.kind) ? 'vehicle'
            : 'unit';
    g.userData.unitIdle = {
      body,
      mode,
      phase: e.id * 0.73,
      x: body.position.x,
      y: body.position.y,
      z: body.position.z,
      rx: body.rotation.x,
      ry: body.rotation.y,
      rz: body.rotation.z,
    };
  }

  _animateUnitIdle(g, e, moved) {
    const idle = g.userData.unitIdle;
    if (!idle?.body) return;
    const b = idle.body;
    b.position.set(idle.x, idle.y, idle.z);
    b.rotation.set(idle.rx, idle.ry, idle.rz);
    if (e.abandoned) return;
    const still = moved < 0.018 && !e.working;
    const t = this.time + idle.phase;
    if (idle.mode === 'infantry') {
      if (!still) return;
      b.position.y += Math.sin(t * 1.8) * 0.035;
      b.rotation.z += Math.sin(t * 1.35) * 0.028;
      b.rotation.x += Math.sin(t * 1.1) * 0.018;
    } else if (idle.mode === 'vehicle') {
      if (!still) return;
      b.position.y += Math.sin(t * 7.5) * 0.012 + Math.sin(t * 13.1) * 0.006;
      b.rotation.x += Math.sin(t * 8.2) * 0.006;
      b.rotation.z += Math.sin(t * 6.7) * 0.005;
    } else if (idle.mode === 'air') {
      b.position.y += Math.sin(t * 2.0) * (still ? 0.055 : 0.025);
      b.rotation.x += Math.sin(t * 1.35) * 0.026;
      b.rotation.z += Math.sin(t * 1.7) * 0.04;
    } else if (idle.mode === 'water') {
      b.position.y += Math.sin(t * 1.1) * 0.035;
      b.rotation.x += Math.sin(t * 1.25) * 0.035;
      b.rotation.z += Math.sin(t * 0.9) * 0.026;
    } else if (still) {
      b.position.y += Math.sin(t * 1.4) * 0.025;
      b.rotation.z += Math.sin(t * 1.1) * 0.015;
    }
  }

  _animateBuildingAnims(g) {
    const anims = g.userData.buildingAnims;
    if (!anims) return;
    for (const a of anims) {
      const o = a.obj;
      if (!o) continue;
      const speed = a.speed || 1;
      const amp = a.amp ?? 0.1;
      const t = this.time * speed + (a.phase || 0);
      const s = Math.sin(t);
      switch (a.type) {
        case 'spinX':
          o.rotation.x = a.baseRX + this.time * speed;
          break;
        case 'spinY':
          o.rotation.y = a.baseRY + this.time * speed;
          break;
        case 'spinZ':
          o.rotation.z = a.baseRZ + this.time * speed;
          break;
        case 'swingX':
          o.rotation.x = a.baseRX + s * amp;
          break;
        case 'swingY':
          o.rotation.y = a.baseRY + s * amp;
          break;
        case 'swingZ':
          o.rotation.z = a.baseRZ + s * amp;
          break;
        case 'bobY':
          o.position.y = a.baseY + s * amp;
          break;
        case 'slideX':
          o.position.x = a.baseX + s * amp;
          break;
        case 'pulse': {
          const mul = 1 + Math.max(0, s) * amp;
          o.scale.set(a.baseSX * mul, a.baseSY * mul, a.baseSZ * mul);
          break;
        }
        case 'flame': {
          const flicker = Math.abs(s);
          o.scale.set(
            a.baseSX * (0.82 + flicker * amp),
            a.baseSY * (0.95 + flicker * amp * 1.55),
            a.baseSZ * (0.82 + flicker * amp),
          );
          o.rotation.y = a.baseRY + Math.sin(t * 0.73) * 0.35;
          if (o.material && 'opacity' in o.material) o.material.opacity = 0.62 + flicker * 0.32;
          break;
        }
      }
    }
  }

  // Warndreieck über Gebäuden, die ihre Funktion nicht erfüllen können (kein Strom/keine Leitung/
  // kein Rohstoff). Gelbes „⚠" als billboardendes Sprite, das sanft pulsiert.
  _warnTexture() {
    if (this._warnTex) return this._warnTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.beginPath(); x.moveTo(32, 6); x.lineTo(60, 56); x.lineTo(4, 56); x.closePath();
    x.fillStyle = '#ffcf33'; x.fill(); x.lineWidth = 5; x.strokeStyle = '#3a2a00'; x.stroke();
    x.fillStyle = '#3a2a00'; x.font = 'bold 36px sans-serif'; x.textAlign = 'center'; x.fillText('!', 32, 50);
    this._warnTex = new THREE.CanvasTexture(c);
    return this._warnTex;
  }

  _updateBuildingWarn(g, e) {
    const on = !!e.warn && (e.buildProgress ?? 1) >= 1;
    let s = g.userData.warnSprite;
    if (!on) { if (s) s.visible = false; return; }
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._warnTexture(), transparent: true, depthTest: false }));
      s.renderOrder = 9;
      const h = 2.4 + (e.size || 1) * 2.2;   // über dem Dach schweben
      s.position.set(0, h, 0);
      g.add(s); g.userData.warnSprite = s;
    }
    s.visible = true;
    const pulse = 0.85 + 0.25 * Math.sin(this.time * 4);
    const sc = (1.1 + (e.size || 1) * 0.35) * pulse;
    s.scale.set(sc, sc, sc);
  }

  // Sichtbare Produktion: solange ein Gebäude eine Warteschlange hat, sprühen Schweißfunken und ein
  // Lichtschein pulsiert über dem Dach — man sieht, dass drin gearbeitet wird.
  _updateBuildingProduction(g, e) {
    const busy = (e.queue || 0) > 0 && (e.buildProgress ?? 1) >= 1 && e.powered !== false;
    let glow = g.userData.prodGlow;
    if (busy && !glow) {
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.puff, color: 0x8fd8ff, transparent: true, opacity: 0, depthWrite: false }));
      glow.position.set(0, 2.2 + (e.size || 1) * 1.4, 0);
      g.add(glow); g.userData.prodGlow = glow;
    }
    if (glow) {
      const target = busy ? 0.5 + 0.3 * Math.sin(this.time * 5) : 0;
      glow.material.opacity += (target - glow.material.opacity) * Math.min(1, this._lastDt * 6);
      const sc = 1.6 + (e.size || 1) * 0.7;
      glow.scale.set(sc, sc, sc);
      glow.visible = glow.material.opacity > 0.02;
    }
    if (!busy || !this._particlesVisible() || !this._canSpawnEffect()) return;
    if (g.userData._nextProdSpark == null) g.userData._nextProdSpark = this.time;
    if (this.time < g.userData._nextProdSpark) return;
    g.userData._nextProdSpark = this.time + 0.18 + Math.random() * 0.16;
    const sz = (e.size || 1) * TILE;
    const bx = e.x + (Math.random() - 0.5) * sz * 0.7, bz = e.y + (Math.random() - 0.5) * sz * 0.7;
    const by = this.heightAt(e.x, e.y) + 0.6 + Math.random() * 1.2;
    this._sprite(0xffd27a, bx, by, bz, 0.12, 0.22, { additive: true, vy: 0.4, vx: (Math.random() - 0.5) * 1.4, vz: (Math.random() - 0.5) * 1.4, opacity: 0.9 });
  }

  // Fertigstellungs-Blitz, wenn eine Einheit das Gebäude verlässt.
  spawnProduceFx(x, y) {
    if (!this._particlesVisible()) return;
    const yy = this.heightAt(x, y) + 0.9;
    this._sprite(0xbfe9ff, x, yy, y, 1.4, 0.4, { additive: true, grow: 1.6, opacity: 0.8 });
    for (let i = 0; i < 5 && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      this._sprite(0xffe2a8, x, yy, y, 0.16, 0.3, { additive: true, vx: Math.cos(a) * 2.4, vz: Math.sin(a) * 2.4, vy: 0.8, opacity: 0.9 });
    }
  }

  _updateBuildingAmbientFx(g, e) {
    const stacks = g.userData.smokeStacks;
    if (!stacks || !stacks.length) return;
    if ((e.buildProgress ?? 1) < 1 || e.powered === false || !this._particlesVisible() || !this._canSpawnEffect(2)) return;
    const baseInterval = e.kind === 'power_plant' ? 0.42 : e.kind === 'factory' ? 0.72 : e.kind === 'oil_derrick' ? 0.86 : 0.95;
    const qualityMul = this.quality === 'low' ? 1.45 : this.quality === 'medium' ? 1.18 : 1;
    const interval = baseInterval * qualityMul;
    if (g.userData._nextSmokeAt == null) {
      g.userData._nextSmokeAt = this.time + Math.random() * interval;
      return;
    }
    if (this.time < g.userData._nextSmokeAt) return;
    g.userData._nextSmokeAt = this.time + interval * (0.75 + Math.random() * 0.45);

    const count = Math.min(stacks.length, e.kind === 'power_plant' ? 2 : 1);
    const oily = e.kind === 'oil_derrick' || e.kind === 'refinery';
    const color = oily ? 0x2f2a22 : e.kind === 'factory' ? 0x5d5850 : 0x77736a;
    for (let i = 0; i < count && this._canSpawnEffect(); i++) {
      const p = this._tmpBuildingFxPos;
      stacks[i].getWorldPosition(p);
      this._sprite(color, p.x + (Math.random() - 0.5) * 0.28, p.y, p.z + (Math.random() - 0.5) * 0.28,
        oily ? 0.9 : 1.25, oily ? 1.1 : 1.35,
        { grow: oily ? 1.2 : 1.7, vy: oily ? 0.78 : 1.08, vx: 0.12, vz: -0.08, opacity: oily ? 0.32 : 0.35 });
    }
  }

  // --- Effekte ---
  // Sprite-Partikel mit der weichen Puff-Textur; Lebenszyklus in updateEffects.
  _sprite(color, x, y, z, size, life, opts = {}) {
    if (!this._particlesVisible()) return;
    if (!this._canSpawnEffect()) return; // Backstop gegen Effekt-Flut in Großschlachten
    // Mit fadeIn startet das Partikel UNSICHTBAR (kein 1-Frame-Aufblitzen) und blendet dann weich ein.
    const mat = new THREE.SpriteMaterial({ map: this.tex.puff, color, transparent: true, opacity: opts.fadeIn ? 0 : (opts.opacity ?? 0.9),
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z); sp.scale.set(size, size, size);
    this.scene.add(sp);
    this._addEffect({ mesh: sp, life: 0, max: life, base: size, grow: opts.grow || 0, vy: opts.vy || 0,
      vx: opts.vx || 0, vz: opts.vz || 0, opacity: opts.opacity ?? 0.9, fadeIn: opts.fadeIn || 0 });
  }

  _particlesVisible() {
    const maxDist = this.quality === 'low' ? 205 : this.quality === 'medium' ? 235 : PARTICLE_ZOOM_HIDE_DIST;
    return this.camDist < maxDist;
  }

  _effectCap() {
    return this.perf?.effectCap ?? 480;
  }

  _canSpawnEffect(reserve = 0) {
    return this.effects.length + reserve < this._effectCap();
  }

  _disposeEffectMesh(effect) {
    this.scene.remove(effect.mesh);
    if (!effect.noFade) {
      if (effect.mesh.material) effect.mesh.material.dispose?.();
      else effect.mesh.traverse?.((m) => m.material?.dispose?.());
    }
  }

  _addEffect(effect) {
    if (!this._canSpawnEffect()) {
      this._disposeEffectMesh(effect);
      return false;
    }
    effect.mesh.visible = this._particlesVisible();
    this.effects.push(effect);
    return true;
  }

  _waterInfoAt(wx, wz) {
    if (!this.waterDepth || !this.height) return { depth: 0, surface: this.heightAt(wx, wz) };
    const gx = Math.max(0, Math.min(this.mapW - 1, Math.round(wx / TILE)));
    const gy = Math.max(0, Math.min(this.mapH - 1, Math.round(wz / TILE)));
    const idx = gy * this.mapW + gx;
    const depth = this.waterDepth[idx] || 0;
    return { depth, surface: this.waterSurfaceAt(wx, wz) };
  }

  _updateUnderwaterTint(g, e, baseY) {
    const info = this._waterInfoAt(e.x, e.y);
    if (info.depth <= WATER_SHOW_DEPTH * 0.7) {
      this._setObjectUnderwaterTint(g, 0);
      return;
    }
    const cover = info.surface - (baseY + 0.10);
    let factor = smoothstep(0.08, 0.85, cover);
    if (e.submerged || e.kind === 'underwater_drone') factor = Math.max(factor, 0.78);
    else if (e.kind === 'submarine') factor = Math.max(factor, 0.62);
    this._setObjectUnderwaterTint(g, factor);
  }

  _setObjectUnderwaterTint(g, factor) {
    const f = Math.max(0, Math.min(1, factor || 0));
    const skip = new Set([g.userData.ring, g.userData.bar, g.userData.barBack, ...(g.userData.chevrons || [])].filter(Boolean));
    g.traverse((o) => {
      if (!o.isMesh || !o.material || skip.has(o) || o.userData.billboard) return;
      const current = Array.isArray(o.material) ? o.material : [o.material];
      let state = o.userData._underwaterTint;
      const usingBases = state && current.length === state.bases.length && current.every((m, i) => m === state.bases[i]);
      const usingClones = state && current.length === state.clones.length && current.every((m, i) => m === state.clones[i]);
      if (!state || (!usingBases && !usingClones)) {
        state = {
          isArray: Array.isArray(o.material),
          bases: current.slice(),
          clones: current.map((m) => (m?.clone ? m.clone() : m)),
        };
        o.userData._underwaterTint = state;
      }
      if (f <= 0.01) {
        if (!usingBases) o.material = state.isArray ? state.bases : state.bases[0];
        return;
      }
      for (let i = 0; i < state.clones.length; i++) this._syncUnderwaterMaterial(state.clones[i], state.bases[i], f);
      o.material = state.isArray ? state.clones : state.clones[0];
    });
  }

  _syncUnderwaterMaterial(clone, base, factor) {
    if (!clone || !base || clone === base) return;
    if ('transparent' in clone && 'transparent' in base) clone.transparent = base.transparent;
    if ('opacity' in clone && 'opacity' in base) clone.opacity = base.opacity;
    if ('alphaTest' in clone && 'alphaTest' in base) clone.alphaTest = base.alphaTest;
    if ('depthWrite' in clone && 'depthWrite' in base) clone.depthWrite = base.depthWrite;
    if ('depthTest' in clone && 'depthTest' in base) clone.depthTest = base.depthTest;
    if ('side' in clone && 'side' in base) clone.side = base.side;
    if ('roughness' in clone && 'roughness' in base) clone.roughness = base.roughness;
    if ('metalness' in clone && 'metalness' in base) clone.metalness = base.metalness;
    if ('emissiveIntensity' in clone && 'emissiveIntensity' in base) clone.emissiveIntensity = base.emissiveIntensity * (1 - factor * 0.86);
    if (clone.map !== base.map) { clone.map = base.map; clone.needsUpdate = true; }
    if (clone.normalMap !== base.normalMap) { clone.normalMap = base.normalMap; clone.needsUpdate = true; }
    if (clone.color && base.color) {
      clone.color.copy(base.color).lerp(UNDERWATER_OBJECT_TINT, factor * 0.58);
      clone.color.r *= 1 - factor * 0.72;
      clone.color.g *= 1 - factor * 0.62;
      clone.color.b *= 1 - factor * 0.50;
    }
    if (clone.emissive && base.emissive) clone.emissive.copy(base.emissive).multiplyScalar(1 - factor * 0.9);
  }

  // Dunkler Einschlagkrater (Ringpuffer) — große Waffen brennen eine bleibende Narbe ins Gelände.
  spawnCrater(x, z, scale = 1) {
    if (!this.craterMesh) return;
    const d = this._craterDummy;
    const i = this._craterIdx % 160;
    d.position.set(x, this.heightAt(x, z) + 0.05, z);
    d.rotation.set(0, (this._craterIdx * 1.7) % (Math.PI * 2), 0);
    d.scale.set(scale, 1, scale);
    d.updateMatrix();
    this.craterMesh.setMatrixAt(i, d.matrix);
    this.craterMesh.instanceMatrix.needsUpdate = true;
    this._craterIdx++;
    this._craterCount = Math.min(160, this._craterCount + 1);
    this.craterMesh.count = this._craterCount;
  }

  spawnExplosion(x, y, z, scale = 1) {
    const cy = y + 1;
    // 1) greller additiver Blitz
    this._sprite(0xffd27a, x, cy, z, scale * 2.4, 0.28, { additive: true, grow: scale * 3, opacity: 1 });
    // 2) Rauchwölkchen, die aufsteigen, driften und ausbleichen
    const puffs = Math.min(4, 1 + Math.round(scale));
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + scale;
      this._sprite(0x555049, x + Math.cos(a) * 0.6 * scale, cy + 0.4, z + Math.sin(a) * 0.6 * scale,
        scale * 1.6, 0.7 + scale * 0.12, { grow: 1.6, vy: 1.6 + scale * 0.4, vx: Math.cos(a) * 0.8, vz: Math.sin(a) * 0.8, opacity: 0.7 });
    }
    // 3) ein paar helle Funken, die nach außen spritzen
    const sparks = Math.min(6, 2 + Math.round(scale * 1.5));
    for (let i = 0; i < sparks; i++) {
      const a = (i / sparks) * Math.PI * 2 + scale * 1.7;
      this._sprite(0xffb24a, x, cy, z, scale * 0.5, 0.25 + Math.random() * 0.15,
        { additive: true, vx: Math.cos(a) * (4 + scale * 2), vz: Math.sin(a) * (4 + scale * 2), vy: 2 + Math.random() * 2, opacity: 1 });
    }
    // 4) Trümmerstücke: kleine dunkle Brocken fliegen ballistisch (Schwerkraft + Drall).
    if (this._canSpawnEffect(4)) {
      const chunks = Math.min(4, 1 + Math.round(scale));
      for (let i = 0; i < chunks; i++) {
        const a = Math.random() * Math.PI * 2;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.18 + Math.random() * 0.2, 0.15, 0.2), this.envMats.dark);
        m.position.set(x, cy + 0.3, z); m.castShadow = true;
        this.scene.add(m);
        this._addEffect({
          mesh: m, life: 0, max: 0.9 + Math.random() * 0.5, opacity: 1, noFade: true,
          vx: Math.cos(a) * (3 + scale * 2), vz: Math.sin(a) * (3 + scale * 2), vy: 4 + Math.random() * 3,
          grav: true, spin: 6 + Math.random() * 8, groundY: y,
        });
      }
    }
  }

  spawnWashout(ev, sourceGroup = null) {
    const x = ev.x, z = ev.y;
    const info = this._waterInfoAt(x, z);
    const surface = Math.max(info.surface, this.heightAt(x, z)) + 0.06;
    let vx = ev.vx || 0, vz = ev.vy || 0;
    const mag = Math.hypot(vx, vz);
    if (mag < 0.05) {
      const a = Math.random() * Math.PI * 2;
      vx = Math.cos(a) * 0.65; vz = Math.sin(a) * 0.65;
    }
    const inv = 1 / Math.max(0.001, Math.hypot(vx, vz));
    const dx = vx * inv, dz = vz * inv;
    const big = ev.etype === 'building';
    const scale = big ? Math.max(1.6, (ev.size || 2) * 0.9) : 0.9;

    if (sourceGroup) {
      sourceGroup.traverse((m) => {
        if (!m.material) return;
        m.material = m.material.clone();
        m.material.transparent = true;
        m.material.depthWrite = false;
      });
      this._setObjectUnderwaterTint(sourceGroup, 0.82);
      this._addEffect({
        mesh: sourceGroup,
        life: 0,
        max: big ? 1.8 : 1.25,
        opacity: 0.82,
        vx: dx * (big ? 0.8 : 1.2),
        vz: dz * (big ? 0.8 : 1.2),
        vy: big ? -0.9 : -1.25,
        sink: true,
        spin: big ? 0.35 : 1.2,
      });
    }

    const foam = big ? 16 : 9;
    for (let i = 0; i < foam && this._canSpawnEffect(); i++) {
      const side = (Math.random() - 0.5) * scale * 1.6;
      this._sprite(i % 3 ? 0xd8f4ff : 0x8fc7d8,
        x - dx * Math.random() * 0.8 - dz * side,
        surface + 0.05 + Math.random() * 0.22,
        z - dz * Math.random() * 0.8 + dx * side,
        0.45 + Math.random() * 0.55,
        0.8 + Math.random() * 0.7,
        { additive: true, grow: 1.1, vx: dx * (2.0 + Math.random() * 1.8), vz: dz * (2.0 + Math.random() * 1.8), vy: 0.08, opacity: 0.66 });
    }

    const chunks = big ? 12 : 5;
    for (let i = 0; i < chunks && this._canSpawnEffect(); i++) {
      const side = (Math.random() - 0.5) * scale;
      const len = Math.random() * 0.9;
      const mat = new THREE.MeshStandardMaterial({ color: i % 2 ? 0x3a3530 : 0x5f625c, roughness: 0.96, transparent: true, opacity: 0.72, depthWrite: false });
      const geo = i % 2
        ? new THREE.BoxGeometry(0.18 + Math.random() * 0.28, 0.08 + Math.random() * 0.12, 0.18 + Math.random() * 0.32)
        : new THREE.DodecahedronGeometry(0.14 + Math.random() * 0.12, 0);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x - dx * len - dz * side, surface + 0.12, z - dz * len + dx * side);
      m.castShadow = false;
      this.scene.add(m);
      this._addEffect({
        mesh: m,
        life: 0,
        max: 1.5 + Math.random() * 1.2,
        opacity: 0.72,
        vx: dx * (1.2 + Math.random() * 1.8) - dz * side * 0.18,
        vz: dz * (1.2 + Math.random() * 1.8) + dx * side * 0.18,
        vy: -0.10 - Math.random() * 0.18,
        spin: 2 + Math.random() * 5,
        sinkPart: true,
      });
    }
  }

  // Steinschlag beim Hangabbau: kleine Brocken kollern + Staub.
  spawnRockfall(x, z) {
    const y = this.heightAt(x, z);
    this._sprite(0x9a8a72, x, y + 0.8, z, 1.4, 0.7, { grow: 1.5, vy: 0.7, opacity: 0.5 });
    this.spawnRollingRock(x, z, { size: 0.18 + Math.random() * 0.16, speed: 6 + Math.random() * 4, life: 3.0 });
    for (let i = 0; i < 2 && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16 + Math.random() * 0.12, 0), this.envMats.dark);
      m.position.set(x, y + 1.2, z); m.castShadow = true;
      this.scene.add(m);
      this._addEffect({
        mesh: m, life: 0, max: 1.1, opacity: 1, noFade: true,
        vx: Math.cos(a) * 2.5, vz: Math.sin(a) * 2.5, vy: 2.5,
        grav: true, spin: 9, groundY: y,
      });
    }
  }

  _downhillVectorAt(x, z, fallback = null) {
    const step = TILE * 0.9;
    const hL = this.heightAt(x - step, z), hR = this.heightAt(x + step, z);
    const hD = this.heightAt(x, z - step), hU = this.heightAt(x, z + step);
    let dx = hL - hR, dz = hD - hU;
    let mag = Math.hypot(dx, dz);
    if (mag < 0.001 && fallback) {
      dx = fallback.x || 0; dz = fallback.z || 0; mag = Math.hypot(dx, dz);
    }
    if (mag < 0.001) {
      const a = Math.random() * Math.PI * 2;
      return { x: Math.cos(a), z: Math.sin(a), mag: 0 };
    }
    return { x: dx / mag, z: dz / mag, mag };
  }

  spawnRollingRock(x, z, opts = {}) {
    if (!this._canSpawnEffect()) return false;
    const fallback = opts.dirX != null || opts.dirZ != null ? { x: opts.dirX || 0, z: opts.dirZ || 0 } : null;
    const down = this._downhillVectorAt(x, z, fallback);
    const side = (Math.random() - 0.5) * 0.55;
    const dx = down.x * Math.cos(side) - down.z * Math.sin(side);
    const dz = down.x * Math.sin(side) + down.z * Math.cos(side);
    const radius = opts.size ?? 0.22;
    const speed = opts.speed ?? (6 + Math.random() * 5);
    const mat = new THREE.MeshStandardMaterial({ color: opts.snow ? 0xd9d9d4 : 0x5b554c, roughness: 0.96, transparent: true, opacity: 0.95 });
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 0), mat);
    m.position.set(x + (Math.random() - 0.5) * 0.5, this.heightAt(x, z) + radius + 0.05, z + (Math.random() - 0.5) * 0.5);
    m.castShadow = true;
    this.scene.add(m);
    return this._addEffect({
      mesh: m,
      life: 0,
      max: opts.life ?? 3.4,
      opacity: 0.95,
      rollRock: true,
      radius,
      vx: dx * speed,
      vz: dz * speed,
    });
  }

  spawnQuakeRockfalls(x, z, radius = 80, count = 3) {
    if (!this.height || !this._particlesVisible()) return;
    const tries = count * 8;
    let made = 0;
    for (let i = 0; i < tries && made < count && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const wx = x + Math.cos(a) * r;
      const wz = z + Math.sin(a) * r;
      const gx = Math.round(wx / TILE), gy = Math.round(wz / TILE);
      if (gx < 1 || gy < 1 || gx >= this.mapW - 1 || gy >= this.mapH - 1) continue;
      const idx = gy * this.mapW + gx;
      if (this._slopeAt(idx) < 0.05) continue;
      if (this._waterInfoAt(wx, wz).depth > 0.035) continue;
      this.spawnRollingRock(wx, wz, { size: 0.17 + Math.random() * 0.17, speed: 5.5 + Math.random() * 5, life: 3.2 });
      made++;
    }
  }

  spawnMining(x, z) {
    const y = this.heightAt(x, z);
    this._sprite(0x8e7358, x, y + 0.65, z, 1.0, 0.55, { grow: 1.0, vy: 0.45, opacity: 0.42 });
    for (let i = 0; i < 4 && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      this._sprite(i & 1 ? 0xd49a4a : 0xffd074, x, y + 0.9, z, 0.28, 0.25 + Math.random() * 0.12,
        { additive: true, vx: Math.cos(a) * 2.4, vz: Math.sin(a) * 2.4, vy: 1.2 + Math.random(), opacity: 0.9 });
    }
  }

  spawnConstructionDust(x, z, done = false) {
    const y = this.heightAt(x, z);
    const n = done ? 5 : 2;
    for (let i = 0; i < n && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      this._sprite(0x9b8a70, x + (Math.random() - 0.5) * 1.4, y + 0.45, z + (Math.random() - 0.5) * 1.4,
        done ? 1.1 : 0.7, 0.5 + Math.random() * 0.25,
        { grow: 1.4, vy: 0.55, vx: Math.cos(a) * 0.75, vz: Math.sin(a) * 0.75, opacity: done ? 0.55 : 0.38 });
    }
    if (done) {
      for (let i = 0; i < 3 && this._canSpawnEffect(); i++) {
        const a = Math.random() * Math.PI * 2;
        this._sprite(0xffc46b, x, y + 1.0, z, 0.22, 0.2,
          { additive: true, vx: Math.cos(a) * 2.4, vz: Math.sin(a) * 2.4, vy: 1.0, opacity: 0.75 });
      }
    }
  }

  spawnIndustryFx(kind, x, z) {
    const y = this.heightAt(x, z);
    if (kind === 'oil_derrick') {
      this._sprite(0x2f2b25, x + (Math.random() - 0.5) * 0.5, y + 2.4, z + (Math.random() - 0.5) * 0.5,
        1.0, 1.15, { grow: 1.7, vy: 0.85, opacity: 0.38 });
      if (this._canSpawnEffect()) {
        this._sprite(0x1b1713, x, y + 1.0, z, 0.45, 0.45, { grow: 0.8, vy: 0.25, opacity: 0.42 });
      }
    } else if (kind === 'power_plant') {
      this._sprite(0x77736a, x + (Math.random() - 0.5), y + 2.8, z + (Math.random() - 0.5),
        1.4, 1.05, { grow: 1.9, vy: 1.1, opacity: 0.34 });
      if (Math.random() < 0.4) {
        this._sprite(0xffb24a, x + (Math.random() - 0.5) * 0.8, y + 1.5, z + (Math.random() - 0.5) * 0.8,
          0.2, 0.18, { additive: true, vy: 1.1, opacity: 0.8 });
      }
    }
  }

  spawnLandslide(path) {
    if (!path || path.length < 2) return;
    const x0 = path[0], z0 = path[1];
    const x1 = path[path.length - 2], z1 = path[path.length - 1];
    const ang = Math.atan2(z1 - z0, x1 - x0);
    for (let n = 0; n < path.length && this._canSpawnEffect(); n += 2) {
      const x = path[n], z = path[n + 1], y = this.heightAt(x, z);
      this._sprite(0x8b7057, x, y + 0.7, z, 1.7, 0.8 + n * 0.03,
        { grow: 1.6, vy: 0.45, vx: Math.cos(ang) * 1.6, vz: Math.sin(ang) * 1.6, opacity: 0.58 });
      if (n + 3 < path.length) {
        const mx = (x + path[n + 2]) * 0.5, mz = (z + path[n + 3]) * 0.5;
        this._sprite(0x5b493a, mx, this.heightAt(mx, mz) + 0.45, mz, 0.85, 0.65,
          { grow: 0.7, vx: Math.cos(ang) * 2.2, vz: Math.sin(ang) * 2.2, opacity: 0.45 });
      }
    }
    for (let i = 0; i < 3 && this._canSpawnEffect(); i++) {
      const t = i / 3;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, y = this.heightAt(x, z);
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.14 + Math.random() * 0.14, 0), this.envMats.dark);
      m.position.set(x, y + 0.8, z); m.castShadow = true;
      this.scene.add(m);
      this._addEffect({
        mesh: m, life: 0, max: 1.2, opacity: 1, noFade: true,
        vx: Math.cos(ang) * (2.2 + Math.random() * 1.8), vz: Math.sin(ang) * (2.2 + Math.random() * 1.8), vy: 1.5,
        grav: true, spin: 8, groundY: y,
      });
    }
    this.fellTreesNearPath(path, ang);
  }

  fellTreesNearPath(path, angle) {
    if (!this.treeInst || !this.treeCells || !this.treeCells.size) return;
    const d = this._floodDummy;
    let felled = 0;
    for (let n = 0; n < path.length && felled < 5; n += 2) {
      const tx = Math.floor(path[n] / TILE), ty = Math.floor(path[n + 1] / TILE);
      for (let dy = -1; dy <= 1 && felled < 5; dy++) for (let dx = -1; dx <= 1 && felled < 5; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) continue;
        const idx = y * this.mapW + x;
        const instId = this.treeCells.get(idx);
        if (instId == null || this.treeFallen.has(idx)) continue;
        this.treeFallen.add(idx);
        d.position.set(0, -9999, 0);
        d.rotation.set(0, 0, 0);
        d.scale.set(0, 0, 0);
        d.updateMatrix();
        this.treeInst.trunk.setMatrixAt(instId, d.matrix);
        this.treeInst.crown.setMatrixAt(instId, d.matrix);
        this.treeInst.top.setMatrixAt(instId, d.matrix);
        this.treeInst.trunk.instanceMatrix.needsUpdate = true;
        this.treeInst.crown.instanceMatrix.needsUpdate = true;
        this.treeInst.top.instanceMatrix.needsUpdate = true;
        this.spawnFallenTree(x * TILE, y * TILE, angle + (Math.random() - 0.5) * 0.9);
        felled++;
      }
    }
    d.scale.set(1, 1, 1);
  }

  spawnFallenTree(x, z, angle) {
    if (!this._canSpawnEffect()) return;
    const y = this.heightAt(x, z);
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 2.8, 6), this.treeMats.trunk);
    trunk.rotation.x = Math.PI / 2;
    trunk.position.y = 0.22;
    trunk.castShadow = true; trunk.receiveShadow = true;
    g.add(trunk);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.65, 1.4, 7), this.treeMats.leafDark);
    crown.rotation.x = Math.PI / 2;
    crown.position.set(0, 0.38, 1.25);
    crown.castShadow = true;
    g.add(crown);
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.0, 7), this.treeMats.leaf);
    top.rotation.x = Math.PI / 2;
    top.position.set(0, 0.45, 1.9);
    top.castShadow = true;
    g.add(top);
    g.position.set(x, y + 0.08, z);
    g.rotation.y = angle;
    this.scene.add(g);
    this._addEffect({ mesh: g, life: 0, max: 24, opacity: 1, noFade: true });
  }

  // Bau-Linienvorschau (Wall/Graben/Straße/Leitung/Damm per Start→Endpunkt ziehen).
  showBuildLine(cells) {
    if (!this.lineGhost) {
      const geo = new THREE.BoxGeometry(TILE * 0.88, 0.7, TILE * 0.88);
      const mat = new THREE.MeshBasicMaterial({ color: 0x6cd2ff, transparent: true, opacity: 0.35, depthWrite: false });
      this.lineGhost = new THREE.InstancedMesh(geo, mat, 256);
      this.lineGhost.renderOrder = 5;
      this.lineGhost.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.lineGhost);
    }
    const d = this._floodDummy;
    let k = 0;
    for (const [tx, ty] of cells) {
      if (k >= 256) break;
      const wx = (tx + 0.5) * TILE, wz = (ty + 0.5) * TILE;
      d.position.set(wx, this.heightAt(wx, wz) + 0.4, wz);
      d.updateMatrix();
      this.lineGhost.setMatrixAt(k++, d.matrix);
    }
    this.lineGhost.count = k;
    this.lineGhost.instanceMatrix.needsUpdate = true;
  }
  hideBuildLine() {
    if (this.lineGhost) { this.lineGhost.count = 0; this.lineGhost.instanceMatrix.needsUpdate = true; }
  }

  showTerraformPreview(cells, dir) {
    const sign = dir > 0 ? 1 : -1;
    this._terraformDragPreview = (cells || []).map(([tx, ty]) => ({ tx, ty, dir: sign, amount: TERRA_PREVIEW_DELTA }));
    this._updateTerraformPreviewMesh();
  }

  hideTerraformPreview() {
    this._terraformDragPreview = [];
    this._updateTerraformPreviewMesh();
  }

  _ensureTerraformPreviewMesh() {
    if (this.terraformPreviewMesh) return this.terraformPreviewMesh;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x35b7ff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.terraformPreviewMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.terraformPreviewMesh.renderOrder = 6;
    this.terraformPreviewMesh.frustumCulled = false;
    this.scene.add(this.terraformPreviewMesh);
    return this.terraformPreviewMesh;
  }

  _updateTerraformPreviewMesh() {
    const items = [...(this._terraformJobPreview || []), ...(this._terraformDragPreview || [])];
    if (!items.length || !this.height || !this.mapW || !this.mapH) {
      if (this.terraformPreviewMesh) this.terraformPreviewMesh.visible = false;
      this._terraformPreviewSig = '';
      return;
    }
    const deltas = new Map();
    for (const item of items) {
      const tx = item.tx | 0, ty = item.ty | 0;
      if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) continue;
      const idx = ty * this.mapW + tx;
      const amount = Number.isFinite(item.amount) ? item.amount : TERRA_PREVIEW_DELTA;
      deltas.set(idx, (deltas.get(idx) || 0) + (item.dir > 0 ? 1 : -1) * amount);
    }
    if (!deltas.size) {
      if (this.terraformPreviewMesh) this.terraformPreviewMesh.visible = false;
      this._terraformPreviewSig = '';
      return;
    }
    const sig = [...deltas.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, delta]) => `${idx}:${delta.toFixed(4)}:${this.height[idx].toFixed(4)}`)
      .join('|');
    const mesh = this._ensureTerraformPreviewMesh();
    if (sig === this._terraformPreviewSig) {
      mesh.visible = true;
      return;
    }
    this._terraformPreviewSig = sig;
    const quads = new Set();
    for (const idx of deltas.keys()) {
      const tx = idx % this.mapW, ty = (idx / this.mapW) | 0;
      for (let qy = ty - 1; qy <= ty; qy++) for (let qx = tx - 1; qx <= tx; qx++) {
        if (qx >= 0 && qy >= 0 && qx < this.mapW - 1 && qy < this.mapH - 1) quads.add(qy * this.mapW + qx);
      }
    }
    const verts = [];
    const pushVertex = (idx) => {
      const gx = idx % this.mapW, gy = (idx / this.mapW) | 0;
      const targetH = Math.max(
        TERRA_PREVIEW_MIN_HEIGHT,
        Math.min(TERRA_PREVIEW_MAX_HEIGHT, this.height[idx] + (deltas.get(idx) || 0)),
      );
      verts.push(gx * TILE, targetH * HEIGHT_SCALE + 0.04, gy * TILE);
    };
    for (const q of quads) {
      const qx = q % this.mapW, qy = (q / this.mapW) | 0;
      const i00 = qy * this.mapW + qx;
      const i10 = i00 + 1;
      const i01 = i00 + this.mapW;
      const i11 = i01 + 1;
      pushVertex(i00); pushVertex(i10); pushVertex(i01);
      pushVertex(i10); pushVertex(i11); pushVertex(i01);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    mesh.geometry.dispose?.();
    mesh.geometry = geo;
    mesh.visible = verts.length > 0;
  }

  showBuildGhost(tx, ty, size = 1, valid = true) {
    if (!this.buildGhost) {
      const geo = new THREE.BoxGeometry(TILE, 0.55, TILE);
      const mat = new THREE.MeshBasicMaterial({ color: 0x6cd2ff, transparent: true, opacity: 0.32, depthWrite: false });
      this.buildGhost = new THREE.Mesh(geo, mat);
      this.buildGhost.renderOrder = 5;
      this.scene.add(this.buildGhost);
    }
    const wx = (tx + size / 2) * TILE, wz = (ty + size / 2) * TILE;
    this.buildGhost.position.set(wx, this.heightAt(wx, wz) + 0.35, wz);
    this.buildGhost.scale.set(size * 0.92, 1, size * 0.92);
    this.buildGhost.material.color.setHex(valid ? 0x6cd2ff : 0xff5544);
    this.buildGhost.material.opacity = valid ? 0.32 : 0.42;
    this.buildGhost.visible = true;
  }

  hideBuildGhost() {
    if (this.buildGhost) this.buildGhost.visible = false;
  }

  // Bau-Reichweite: zeigt als geländefolgende Ringe, wo ein eingeschränkt platzierbares Gebäude
  // gebaut werden darf (Bauradius ums HQ / Anker-Reichweite). centers = [{x,z,r}], r in Welt-Einheiten.
  showBuildRange(centers) {
    if (!this._buildRangeGroup) { this._buildRangeGroup = new THREE.Group(); this._buildRangeGroup.renderOrder = 6; this.scene.add(this._buildRangeGroup); }
    const g = this._buildRangeGroup;
    const sig = centers.map(c => `${Math.round(c.x)},${Math.round(c.z)},${Math.round(c.r)}`).join('|');
    g.visible = true;
    if (sig === this._buildRangeSig) return;     // gleiche Lage → Geometrie behalten
    this._buildRangeSig = sig;
    for (const ch of g.children) ch.geometry.dispose();
    g.clear();
    const SEG = 72;
    for (const c of centers) {
      const pos = [];
      for (let n = 0; n <= SEG; n++) {
        const a = (n / SEG) * Math.PI * 2;
        const x = c.x + Math.cos(a) * c.r, z = c.z + Math.sin(a) * c.r;
        pos.push(x, this.heightAt(x, z) + 0.3, z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x6cd2ff, transparent: true, opacity: 0.55, depthWrite: false }));
      g.add(line);
    }
  }

  hideBuildRange() { if (this._buildRangeGroup) { this._buildRangeGroup.visible = false; this._buildRangeSig = null; } }

  // Lawinen-Effekt: Schneewolken, Schaum und kompakte Schneebrocken kaskadieren den Pfad entlang.
  spawnAvalanche(path) {
    const rockEvery = this.quality === 'low' ? 8 : this.quality === 'medium' ? 6 : 4;
    for (let n = 0; n < path.length && this._canSpawnEffect(); n += 2) {
      const x = path[n], z = path[n + 1];
      const y = this.heightAt(x, z);
      if ((n % rockEvery) === 0 && this._canSpawnEffect(2)) {
        const nx = path[n + 2] ?? x, nz = path[n + 3] ?? z;
        this.spawnRollingRock(x, z, {
          dirX: nx - x,
          dirZ: nz - z,
          size: 0.18 + Math.random() * 0.18,
          speed: 7 + Math.random() * 5,
          life: 3.6,
          snow: n < path.length * 0.5,
        });
      }
      this._sprite(0xf2f7ff, x, y + 1.2, z, 2.6, 0.9 + n * 0.04,
        { grow: 1.8, vy: 0.8, vx: (Math.random() - 0.5) * 2, vz: (Math.random() - 0.5) * 2, opacity: 0.85 });
      this._sprite(0xdfefff, x + (Math.random() - 0.5), y + 0.55, z + (Math.random() - 0.5), 1.0, 0.55,
        { grow: 1.1, vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, opacity: 0.62 });
      if ((n % 4) === 0 && this._canSpawnEffect()) {
        const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + Math.random() * 0.18, 0),
          new THREE.MeshLambertMaterial({ color: 0xeaf2f8 }));
        m.position.set(x, y + 1.0, z); m.castShadow = true;
        this.scene.add(m);
        this._addEffect({
          mesh: m, life: 0, max: 1.2, opacity: 1,
          vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, vy: 1.8,
          grav: true, spin: 7, groundY: y,
        });
      }
    }
  }
  spawnTracer(x1, y1, z1, x2, y2, z2) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x1, y1 + 1, z1), new THREE.Vector3(x2, y2 + 1, z2)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }));
    this.scene.add(line); this._addEffect({ mesh: line, life: 0, max: 0.12, opacity: 0.9 });
    // Mündungsblitz am Ursprung
    this._sprite(0xfff0b0, x1, y1 + 1, z1, 1.3, 0.1, { additive: true, opacity: 0.95 });
  }

  spawnShotParticles(x1, z1, x2, z2, kind = '') {
    const y1 = this.heightAt(x1, z1);
    const a = Math.atan2(z2 - z1, x2 - x1);
    const heavy = /artillery|cannon|gun|launcher|rocket|missile|bomb|torpedo/.test(kind);
    const muzzleX = x1 + Math.cos(a) * (heavy ? 1.25 : 0.75);
    const muzzleZ = z1 + Math.sin(a) * (heavy ? 1.25 : 0.75);
    this._sprite(0xfff0b0, muzzleX, y1 + 1.1, muzzleZ, heavy ? 1.0 : 0.55, 0.08, { additive: true, opacity: 1 });
    this._sprite(0x6a6258, muzzleX - Math.cos(a) * 0.25, y1 + 1.0, muzzleZ - Math.sin(a) * 0.25,
      heavy ? 0.9 : 0.45, heavy ? 0.42 : 0.28,
      { grow: 1.2, vy: 0.6, vx: -Math.cos(a) * 0.7, vz: -Math.sin(a) * 0.7, opacity: heavy ? 0.48 : 0.28 });
    const sparks = heavy ? 4 : 2;
    for (let i = 0; i < sparks && this._canSpawnEffect(); i++) {
      const s = a + (Math.random() - 0.5) * 0.9;
      this._sprite(0xffbd60, muzzleX, y1 + 1.0, muzzleZ, 0.16, 0.16 + Math.random() * 0.08,
        { additive: true, vx: Math.cos(s) * (2.6 + Math.random() * 2), vz: Math.sin(s) * (2.6 + Math.random() * 2), vy: 0.7, opacity: 0.85 });
    }
  }

  spawnRainCloud(x, z, r = 13, duration = 22) {
    if (!this._particlesVisible()) return;
    const y = this.heightAt(x, z) + 8.5;
    const puffs = this.quality === 'low' ? 3 : this.quality === 'medium' ? 5 : 7;
    for (let i = 0; i < puffs && this._canSpawnEffect(); i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * 0.45;
      this._sprite(0x31434b, x + Math.cos(a) * d, y + (Math.random() - 0.5) * 0.9, z + Math.sin(a) * d,
        r * (0.22 + Math.random() * 0.11), Math.min(8, duration), { opacity: 0.32, grow: 0.25 });
    }
    this._localCloudFxAt = 0;
  }

  // Distanzabhängige Lautstärke relativ zum Kamerafokus (0..1).
  _volAt(x, z) {
    const d = Math.hypot(x - this.camTarget.x, z - this.camTarget.z);
    return Math.max(0, Math.min(1, 1.1 - d / 150));
  }

  processEvents(events, audio, seat) {
    for (const ev of events) {
      const vol = this._volAt(ev.x, ev.y);
      if (ev.type === 'explosion') {
        const sc = 1 + (ev.splash || 0) * 0.6;
        this.spawnExplosion(ev.x, this.heightAt(ev.x, ev.y), ev.y, sc);
        // Große Waffen (ordentlicher Splash) hinterlassen einen bleibenden Krater am Boden.
        if ((ev.splash || 0) >= 1.4 && !this._isSeaWorldPoint(ev.x, ev.y)) this.spawnCrater(ev.x, ev.y, 0.7 + (ev.splash || 0) * 0.35);
        if (audio) audio.explosion(sc, vol);
      } else if (ev.type === 'fire') {
        this.spawnTracer(ev.x, this.heightAt(ev.x, ev.y), ev.y, ev.tx, this.heightAt(ev.tx, ev.ty), ev.ty);
        this.spawnShotParticles(ev.x, ev.y, ev.tx, ev.ty, ev.kind);
        if (audio) audio.fire(ev.kind, vol);
      } else if (ev.type === 'rain_cloud') {
        this.spawnRainCloud(ev.x, ev.y, ev.r || 13, ev.duration || 22);
      } else if (ev.type === 'death') {
        const sc = ev.etype === 'building' ? 3 : 1.2;
        this.spawnExplosion(ev.x, this.heightAt(ev.x, ev.y), ev.y, sc);
        if (audio) audio.explosion(sc, vol);
      } else if (ev.type === 'washout') {
        if (!this._handledWashouts?.has(ev.id)) this.spawnWashout(ev);
      } else if (ev.type === 'build') {
        this.spawnConstructionDust(ev.x, ev.y, true);
        if (audio && ev.owner === seat) audio.build(1);
      } else if (ev.type === 'dig') {
        this.spawnConstructionDust(ev.x, ev.y, false);
      } else if (ev.type === 'dump') {
        const truck = ev.unit != null ? this.meshes.get(ev.unit) : null;
        if (truck) truck.userData.dumpT = 1.05;
        this.spawnDumpCargo(ev.x, ev.y, ev.dx ?? ev.x, ev.dy ?? ev.y);
      } else if (ev.type === 'industry') {
        this.spawnIndustryFx(ev.kind, ev.x, ev.y);
        // Aktive Förderkette merken → Pipeline-Flussanimation + Depot-Aktivität.
        if (ev.kind === 'oil_derrick') this._oilFlowT = this.time;
        else if (ev.kind === 'water_pump') this._waterFlowT = this.time;
      } else if (ev.type === 'produced') {
        if (audio && ev.owner === seat) audio.ready_(1);
        this.spawnProduceFx(ev.x, ev.y);
      } else if (ev.type === 'recover') {
        if (audio && ev.owner === seat) audio.ready_(1);
        this._sprite(0xd8f4ff, ev.x, this.heightAt(ev.x, ev.y) + 1.0, ev.y, 0.8, 0.45, { opacity: 0.55, grow: 0.8 });
      } else if (ev.type === 'defeat') {
        if (audio && ev.player === seat) audio.defeat();
      } else if (ev.type === 'lightning') {
        this.spawnLightning(ev.x, ev.y);
        if (audio) audio.thunder(Math.max(0.25, vol));
      } else if (ev.type === 'quake' && ev.start) {
        this.spawnQuakeRockfalls(ev.x, ev.y, ev.r || 80, this.quality === 'low' ? 3 : 6);
        if (audio) audio.rumble();
      } else if (ev.type === 'quake') {
        if (Math.random() < (this.quality === 'low' ? 0.12 : 0.28)) {
          this.spawnQuakeRockfalls(ev.x, ev.y, ev.r || 80, 1);
        }
      } else if (ev.type === 'avalanche') {
        this.spawnAvalanche(ev.path || [ev.x, ev.y]);
        if (audio) audio.rumble();
      } else if (ev.type === 'landslide') {
        this.spawnLandslide(ev.path || [ev.x, ev.y]);
        if (audio && vol > 0.05) audio.rocks(vol);
      } else if (ev.type === 'mine') {
        this.spawnMining(ev.x, ev.y);
        if (audio && vol > 0.05) audio.excavate(vol);
      } else if (ev.type === 'rockfall') {
        this.spawnRockfall(ev.x, ev.y);
        if (audio && vol > 0.05) audio.rocks(vol);
      } else if (ev.type === 'shipwreck') {
        const y = Math.max(this.heightAt(ev.x, ev.y), this.seaY ?? 0);
        this.spawnExplosion(ev.x, y, ev.y, 1.5);
        for (let i = 0; i < 10; i++) {
          this._sprite(0xd8f4ff, ev.x + (Math.random() - 0.5) * 2.5, y + 0.25, ev.y + (Math.random() - 0.5) * 2.5,
            0.7, 0.7, { vx: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, opacity: 0.65, grow: 1.2 });
        }
        if (audio) audio.explosion(1.2, vol);
      } else if (ev.type === 'abandoned') {
        this._sprite(0x505050, ev.x, this.heightAt(ev.x, ev.y) + 0.8, ev.y, 1.0, 0.9, { opacity: 0.45, grow: 1.2 });
      }
    }
    this._handledWashouts?.clear();
    events.length = 0;
  }

  updateEffects(dt) {
    const visible = this._particlesVisible();
    // Pipeline-Flussanimation: leuchtet/pulsiert, solange Öl- oder Wasserförderung aktiv ist.
    if (this.pipeMat) {
      // Fenster > Intervall der industry-Events (alle 2 s), damit der Durchfluss durchgehend leuchtet.
      const flowActive = (this.time - (this._oilFlowT ?? -9) < 2.6) || (this.time - (this._waterFlowT ?? -9) < 2.6);
      const target = flowActive ? 0.28 + 0.16 * Math.sin(this.time * 6) : 0;
      this.pipeMat.emissiveIntensity += (target - this.pipeMat.emissiveIntensity) * Math.min(1, dt * 6);
      // wandernde Durchfluss-Bänder
      if (this._pipeShader) {
        this._pipeShader.uniforms.uFlowTime.value = (this._pipeShader.uniforms.uFlowTime.value + dt * 0.9) % 1024;
        const on = flowActive ? 1 : 0, u = this._pipeShader.uniforms.uFlowOn;
        u.value += (on - u.value) * Math.min(1, dt * 4);
      }
    }
    this._spawnCurrentParticles(dt);
    this._spawnSourceParticles(dt);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i]; f.life += dt;
      if (f.mesh.visible !== visible) f.mesh.visible = visible;
      const t = f.life / f.max;
      if (f.sink) {
        f.mesh.position.x += (f.vx || 0) * dt;
        f.mesh.position.y += (f.vy || 0) * dt;
        f.mesh.position.z += (f.vz || 0) * dt;
        f.mesh.rotation.y += (f.spin || 0) * dt;
        const s = Math.max(0.35, 1 - t * 0.42);
        f.mesh.scale.setScalar(s);
        f.mesh.traverse((m) => { if (m.material) m.material.opacity = Math.max(0, (f.opacity ?? 0.8) * (1 - t)); });
      } else if (f.rollRock) {
        const beforeX = f.mesh.position.x, beforeZ = f.mesh.position.z;
        const down = this._downhillVectorAt(beforeX, beforeZ);
        if (down.mag > 0.001) {
          f.vx = (f.vx || 0) + down.x * (8 + down.mag * 120) * dt;
          f.vz = (f.vz || 0) + down.z * (8 + down.mag * 120) * dt;
        }
        const drag = Math.pow(0.82, dt);
        f.vx *= drag; f.vz *= drag;
        f.mesh.position.x += f.vx * dt;
        f.mesh.position.z += f.vz * dt;
        const dist = Math.hypot(f.mesh.position.x - beforeX, f.mesh.position.z - beforeZ);
        f.mesh.position.y = this.heightAt(f.mesh.position.x, f.mesh.position.z) + (f.radius || 0.18);
        f.mesh.rotation.x += dist / Math.max(0.08, f.radius || 0.18);
        f.mesh.rotation.z += dist * 0.55 / Math.max(0.08, f.radius || 0.18);
        if (this._particlesVisible() && dist > 0.02 && Math.random() < 0.16 && this._canSpawnEffect(1)) {
          this._sprite(0x80705f, f.mesh.position.x, f.mesh.position.y + 0.05, f.mesh.position.z, 0.28, 0.42,
            { grow: 1.0, vy: 0.22, opacity: 0.28 });
        }
        const gx = Math.round(f.mesh.position.x / TILE), gy = Math.round(f.mesh.position.z / TILE);
        if (gx < 1 || gy < 1 || gx >= this.mapW - 1 || gy >= this.mapH - 1 || this._waterInfoAt(f.mesh.position.x, f.mesh.position.z).depth > 0.05) {
          f.life = Math.max(f.life, f.max * 0.85);
        }
      } else if (f.mesh.isSprite) {
        if (f.grow) { const s = f.base * (1 + t * f.grow); f.mesh.scale.set(s, s, s); }
        f.mesh.position.x += (f.vx || 0) * dt; f.mesh.position.y += (f.vy || 0) * dt; f.mesh.position.z += (f.vz || 0) * dt;
      } else if (f.grav) {
        // Trümmer: ballistische Flugbahn mit Drall, bleiben am Boden liegen.
        f.vy -= 14 * dt;
        f.mesh.position.x += f.vx * dt; f.mesh.position.y += f.vy * dt; f.mesh.position.z += f.vz * dt;
        if (f.groundY != null && f.mesh.position.y < f.groundY + 0.1) {
          f.mesh.position.y = f.groundY + 0.1; f.vx *= 0.4; f.vz *= 0.4; f.vy = 0; f.spin *= 0.3;
        }
        f.mesh.rotation.x += f.spin * dt; f.mesh.rotation.z += f.spin * 0.7 * dt;
      } else {
        f.mesh.position.x += (f.vx || 0) * dt;
        f.mesh.position.y += (f.vy || 0) * dt;
        f.mesh.position.z += (f.vz || 0) * dt;
        if (f.spin) { f.mesh.rotation.x += f.spin * dt; f.mesh.rotation.z += f.spin * 0.6 * dt; }
        if (f.grow) { const s = 1 + t * f.grow; f.mesh.scale.set(s, s, s); }
        if (f.sinkPart) f.mesh.position.y -= 0.16 * dt;
      }
      if (!f.noFade && !f.sink && f.mesh.material) {
        // fadeIn (Anteil der Lebenszeit) → das Partikel blendet langsam EIN statt plötzlich aufzutauchen,
        // danach normales Ausblenden über (1 - t). Ohne fadeIn unverändert (sofort voll sichtbar).
        const fin = f.fadeIn > 0 ? Math.min(1, t / f.fadeIn) : 1;
        f.mesh.material.opacity = Math.max(0, (f.opacity ?? 0.9) * fin * (1 - t));
      }
      // Material freigeben (geteilte Materialien/Texturen NICHT disposen — noFade nutzt envMats).
      if (f.life >= f.max) {
        this._disposeEffectMesh(f);
        this.effects.splice(i, 1);
      }
    }
  }

  _spawnCurrentParticles(dt) {
    if (!this._particlesVisible() || !this.waterDepth || !this.height || !this._canSpawnEffect(3)) return;
    const gap = this.quality === 'low' ? 0.40 : this.quality === 'medium' ? 0.24 : 0.16;
    this._currentFxAt = Math.max(0, (this._currentFxAt || 0) - dt);
    if (this._currentFxAt > 0) return;
    this._currentFxAt = gap;
    const tries = this.quality === 'low' ? 8 : this.quality === 'medium' ? 13 : 20;
    // Wenige, dafür DICHTE Läufe — jeder Lauf zeichnet ein durchgehendes blaues Band (s. _traceFlowToSea).
    const maxMade = this.quality === 'low' ? 1 : this.quality === 'medium' ? 2 : 3;
    const radius = Math.max(14, Math.min(42, this.camDist * 0.22));
    let made = 0;
    for (let n = 0; n < tries && made < maxMade && this._canSpawnEffect(1); n++) {
      const wx = this.camTarget.x + (Math.random() - 0.5) * radius * 2;
      const wz = this.camTarget.z + (Math.random() - 0.5) * radius * 2;
      const gx = Math.round(wx / TILE), gy = Math.round(wz / TILE);
      if (gx < 1 || gy < 1 || gx >= this.mapW - 1 || gy >= this.mapH - 1) continue;
      const idx = gy * this.mapW + gx;
      const depth = this.waterDepth[idx] || 0;
      // Auch das dünne Abfluss-Rinnsal (unter der Render-Schwelle) bekommt Partikel: so ist überall
      // sichtbar, WO Wasser abfließt — bis hinunter zum Meer, auch wenn die Fläche selbst nicht gemalt wird.
      if (depth < 0.020) continue;
      const flow = this._waterFlowAt(idx);
      const speed = Math.hypot(flow.x, flow.z);
      if (speed < 0.20) continue;   // schon sanfte Oberflächenströmung zeigt ihre Richtung
      const surge = Math.max(0, Math.min(1, (speed - 0.20) / 0.5));
      // Von hier dem Gefälle bis zum Meer folgen und entlang des Laufs Partikel setzen — so ist der
      // Abfluss als durchgehender Bach BIS ZUM MEER sichtbar, auch wo die Sim das dünne Rinnsal
      // bereits abgetragen hat (rein optisch, keine Sim-/Perf-Last).
      this._traceFlowToSea(gx, gy, surge);
      made++;
    }
  }

  // Steilsten Abstieg (Boden + Wasser) von einer Wasserzelle bis zum Meer/Rand verfolgen und kleine
  // Strömungspartikel entlang des Pfades streuen. Endet am Meer, am Kartenrand oder in einer Senke.
  _traceFlowToSea(gx, gy, surge) {
    const W = this.mapW, H = this.mapH;
    const PRESENT = 0.018; // ab dieser Tiefe gilt eine Zelle als „hat Wasser"
    const maxLen = this.quality === 'low' ? 8 : this.quality === 'medium' ? 14 : 22;
    let cx = gx, cy = gy;
    for (let step = 0; step < maxLen && this._canSpawnEffect(1); step++) {
      const ci = cy * W + cx;
      // NUR dem nassen Lauf folgen: tiefster Bett-Nachbar, der AUCH Wasser führt. So tauchen die
      // Partikel ausschließlich dort auf, wo wirklich Wasser auf der Karte liegt (kein „Bach" über
      // trockenes Gelände). Endet, sobald das Wasser aufhört oder das Meer erreicht ist.
      if ((this.waterDepth[ci] || 0) <= PRESENT && this.terrainType?.[ci] !== 3) break;
      const g0 = this.height[ci];
      let bx = -1, by = -1, bg = g0 - 0.0004, ndx = 0, ndy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if ((this.waterDepth[j] || 0) <= PRESENT && this.terrainType?.[j] !== 3) continue; // nur nasse Nachbarn
        const gj = this.height[j];
        if (gj < bg) { bg = gj; bx = nx; by = ny; ndx = dx; ndy = dy; }
      }
      if (bx < 0) break; // kein nasser Abstieg mehr → Lauf endet (matcht die sichtbare Wasserfläche)
      const dist = Math.hypot(ndx, ndy) || 1;
      const fx = ndx / dist, fz = ndy / dist;
      const depth = this.waterDepth[ci] || 0;
      const fade = 0.6 + 0.4 * (1 - step / (maxLen + 2)); // Lauf bleibt bis zum Meer gut sichtbar
      const blue = surge > 0.45 ? 0x4fc3f7 : 0x2f9fe0;
      // DURCHGEHENDES BLAUES BAND: pro Segment (Zelle → tieferer Nachbar) mehrere große, überlappende
      // blaue Partikel ENTLANG der Verbindungslinie setzen (wenig Jitter, wenig Drift) — so verschmelzen
      // sie zu einem zusammenhängenden Band statt einzelner Tropfen. Schaum kommt sparsam obendrauf.
      const sx = cx * TILE, sz = cy * TILE, ex = bx * TILE, ez = by * TILE;
      const bandSize = 0.95 + surge * 0.7;
      for (const t of [0.18, 0.5, 0.82]) {
        if (!this._canSpawnEffect(1)) break;
        const wx = sx + (ex - sx) * t + (Math.random() - 0.5) * 0.3;
        const wz = sz + (ez - sz) * t + (Math.random() - 0.5) * 0.3;
        const y = (depth > 0.02 ? this.waterSurfaceAt(wx, wz) : this.height[ci] * HEIGHT_SCALE) + 0.07;
        // fadeIn 0.5 + längere Lebensdauer: jedes Band-Partikel blendet GANZ LANGSAM ein (statt
        // plötzlich aufzutauchen), bleibt sichtbar und blendet dann wieder aus. opacity angehoben,
        // weil das Hüllkurven-Maximum (fadeIn·fadeOut) sonst niedriger liegt.
        this._sprite(blue, wx, y, wz, bandSize, 2.0 + surge * 0.7, {
          vx: fx * (0.45 + surge * 0.5), vz: fz * (0.45 + surge * 0.5), vy: 0.03 + surge * 0.06,
          grow: 1.04 + surge * 0.22, opacity: (0.78 + surge * 0.3) * fade, fadeIn: 0.5,
        });
      }
      // Weiße Schaumkrone obenauf (Funkeln/Gischt), sparsam — nur jeden 2. Schritt; blendet ebenfalls weich ein.
      if (this._canSpawnEffect(1) && (step % 2 === 0 || surge > 0.5)) {
        const wx = sx + (ex - sx) * 0.5, wz = sz + (ez - sz) * 0.5;
        const y = (depth > 0.02 ? this.waterSurfaceAt(wx, wz) : this.height[ci] * HEIGHT_SCALE) + 0.16;
        this._sprite(0xffffff, wx + (Math.random() - 0.5) * 0.5, y, wz + (Math.random() - 0.5) * 0.5,
          0.24 + surge * 0.22, 0.9 + surge * 0.4,
          { vx: fx * 0.6, vz: fz * 0.6, vy: 0.12 + surge * 0.1, grow: 1.25, opacity: (0.55 + surge * 0.4) * fade, fadeIn: 0.45, additive: true });
      }
      cx = bx; cy = by;
      if (this.terrainType?.[by * W + bx] === 3) break; // Meer erreicht
    }
  }

  // Flussquellen sichtbar machen: an jeder Quellzelle nahe der Kamera quillt rhythmisch Wasser auf
  // (kleine, aufsteigende und auseinanderlaufende Tropfen). So erkennt der Spieler den URSPRUNG der
  // Bäche — die Strömungspartikel zeigen danach den Lauf flussabwärts.
  _spawnSourceParticles(dt) {
    if (!this.waterSources || !this.waterSources.length) return;
    if (!this._particlesVisible() || !this.height || !this._canSpawnEffect(2)) return;
    this._sourceFxAt = Math.max(0, (this._sourceFxAt || 0) - dt);
    if (this._sourceFxAt > 0) return;
    this._sourceFxAt = this.quality === 'low' ? 0.5 : this.quality === 'medium' ? 0.34 : 0.24;
    const w = this.mapW;
    const reach = Math.max(46, this.camDist * 0.6);
    for (const idx of this.waterSources) {
      if (!this._canSpawnEffect(2)) break;
      const gx = idx % w, gy = (idx / w) | 0;
      const x = gx * TILE, z = gy * TILE;
      if (Math.abs(x - this.camTarget.x) > reach || Math.abs(z - this.camTarget.z) > reach) continue;
      const y = this.waterSurfaceAt(x, z) + 0.05;
      const ang = Math.random() * Math.PI * 2, spread = 0.45 + Math.random() * 0.5;
      // Aufquellender Kern …
      this._sprite(0xcdeeff, x, y, z, 0.22, 0.62, { vy: 0.55, vx: Math.cos(ang) * spread, vz: Math.sin(ang) * spread, grow: 1.5, opacity: 0.5 });
      // … plus ein paar überlaufende Tropfen ringsum.
      if (this._canSpawnEffect(1) && Math.random() < 0.7) {
        const a2 = Math.random() * Math.PI * 2;
        this._sprite(0xeafbff, x, y + 0.02, z, 0.12, 0.5,
          { vy: 0.32, vx: Math.cos(a2) * (0.7 + Math.random() * 0.6), vz: Math.sin(a2) * (0.7 + Math.random() * 0.6), grow: 1.2, opacity: 0.4 });
      }
    }
  }

  updateCamera() {
    const t = this.camTarget;
    // Erdbeben: abklingender Kamera-Shake.
    let sx = 0, sy = 0;
    if (this._quakeAmp > 0.01) {
      sx = (Math.random() - 0.5) * this._quakeAmp;
      sy = (Math.random() - 0.5) * this._quakeAmp;
    }
    this.camera.position.set(t.x + sx, t.y + Math.sin(this.camAngle) * this.camDist + sy, t.z + Math.cos(this.camAngle) * this.camDist);
    this.camera.lookAt(t.x + sx, t.y + sy, t.z);
  }

  // --- Tag/Nacht, Wetter & Beben aus dem Snapshot-Env auf Licht/Himmel/Partikel anwenden ---
  // env = { t: Tageszeit 0..1, d: Tageslicht 0..1, w: 'clear'|'fog'|'rain'|'storm'|'drought', q: [x,y]|0, c: Wolken }
  updateEnvironment(env, dt) {
    this._lastDt = Math.min(0.05, Math.max(0, dt || 1 / 60));
    this.time += this._lastDt;
    if (!env) return;
    const d = env.d ?? 1;
    const wf = env.w === 'storm' ? 0.35 : env.w === 'rain' ? 0.55 : env.w === 'fog' ? 0.6 : 1; // Wolken/Nebel dämpfen

    // Nebel: Sichtweite bricht ein (dichter Szenen-Nebel), sonst weiter Horizont.
    if (this.scene.fog) {
      const zoom = Math.max(0, this.camDist - 115);
      const fogTarget = env.w === 'fog'
        ? [28 + zoom * 0.42, 120 + zoom * 1.45]
        : [180, 780];
      this.scene.fog.near += (fogTarget[0] - this.scene.fog.near) * Math.min(1, dt * 1.5);
      this.scene.fog.far += (fogTarget[1] - this.scene.fog.far) * Math.min(1, dt * 1.5);
    }

    // Sonne wandert über den Himmel (Tagesbogen um die Kartenmitte); nachts unter dem Horizont.
    const ang = (env.t ?? 0.5) * Math.PI * 2 - Math.PI / 2;              // 0 = Mitternacht
    const c = this.camTarget;
    const elev = Math.max(0, Math.sin(ang));
    this.sun.position.set(c.x + Math.cos(ang) * 220, 28 + elev * 115, c.z + Math.sin(ang * 0.7) * 80 + 95);
    this.sun.target.position.set(c.x, 0, c.z);
    const sunWantsShadow = this.graphics.shadows !== false && d > 0.18;
    if (this.sun.castShadow !== sunWantsShadow) {
      this.sun.castShadow = sunWantsShadow;
      this._markShadowsDirty(false, true);
    }
    if (sunWantsShadow && (this.sun.position.distanceToSquared(this._shadowSunProbe) > SHADOW_SUN_MOVE_EPS2
      || this.sun.target.position.distanceToSquared(this._shadowTargetProbe) > SHADOW_TARGET_MOVE_EPS2)) {
      this._shadowSunProbe.copy(this.sun.position);
      this._shadowTargetProbe.copy(this.sun.target.position);
      this._markShadowsDirty(false);
    }
    const horizonWarm = smoothstep(0.03, 0.50, d) * (1 - smoothstep(0.06, 0.62, elev));
    this.sun.intensity = (0.06 + 2.42 * d + horizonWarm * 0.22) * wf;
    // Sonnenauf- und -untergang: flache Sonne wird deutlich wärmer/rötlicher.
    this.sun.color.setRGB(1, 0.94 - horizonWarm * 0.42, 0.82 - horizonWarm * 0.62);
    this.moon.intensity = 0.20 * (1 - d);
    this.hemi.intensity = (0.11 + 0.30 * d) * (0.60 + 0.40 * wf) + this._flash;
    this._flash = Math.max(0, this._flash - dt * 9);                     // Blitz-Aufhellung klingt ab

    // Himmel & Nebel: Tagblau ↔ Nachtschwarz. Der Szene-Fog hat bei Wetternebel eine
    // eigene Nachtfarbe, sonst würden entfernte Objekte nachts in helles Himmelsgrau ausbleichen.
    const sky = SKY_NIGHT.clone().lerp(SKY_DAY, d);
    if (horizonWarm > 0.01) sky.lerp(new THREE.Color(0xff7650), horizonWarm * 0.22);
    const sceneFog = sky.clone();
    if (env.w === 'fog') {
      const fogDaylight = smoothstep(0.08, 0.85, d);
      const fogColor = WEATHER_FOG_NIGHT.clone().lerp(WEATHER_FOG_DAY, fogDaylight);
      sky.lerp(fogColor, 0.36 + fogDaylight * 0.34);
      sceneFog.copy(fogColor).lerp(sky, 0.18);
    } else if (env.w === 'drought') {
      sky.lerp(SKY_DROUGHT, 0.32 * Math.max(0.35, d));
      sceneFog.copy(sky);
    } else if (env.w !== 'clear') {
      sky.lerp(SKY_RAIN, env.w === 'storm' ? 0.75 : 0.5);
      sceneFog.copy(sky);
    }
    if (this._flash > 0.05) sky.lerp(new THREE.Color(0xcfe8ff), Math.min(1, this._flash));
    this.scene.background.copy(sky);
    if (this.scene.fog) this.scene.fog.color.copy(sceneFog);
    if (this.skirtMat) this.skirtMat.color.copy(DEEP_SEA_SKIRT_COLOR).multiplyScalar(0.34 + 0.58 * d);
    if (this.waterMat) {
      const stormTarget = env.w === 'storm' ? 1 : env.w === 'rain' ? 0.45 : 0;
      this._waterStorm = (this._waterStorm || 0) + (stormTarget - (this._waterStorm || 0)) * Math.min(1, dt * 1.6);
      const tex = this.waterMat.userData.flowTexture || this.waterMat.map;
      if (tex) {
        tex.offset.y = -this.time * (0.006 + this._waterStorm * 0.003);
        tex.offset.x = this.time * 0.0007;
      }
      const base = this.waterMat.userData.baseColor || new THREE.Color(0x49bde8);
      const waterLight = WATER_NIGHT_COLOR_MIN + d * (1 - WATER_NIGHT_COLOR_MIN);
      this.waterMat.color.copy(base);
      if (env.w === 'fog') this.waterMat.color.lerp(new THREE.Color(0x7aa5b0), 0.22);
      else if (stormTarget > 0) this.waterMat.color.lerp(new THREE.Color(0x2b78a5), 0.18 + stormTarget * 0.16);
      this.waterMat.color.multiplyScalar(waterLight);
      this.waterMat.opacity = WATER_NIGHT_OPACITY_MIN + d * 0.28 + this._waterStorm * 0.04;
      // Himmelsspiegelung im Wasser-Shader nachführen: Himmelsfarbe + Stärke (tagsüber mehr).
      if (this.waterMat.userData.uSky) this.waterMat.userData.uSky.value.copy(sky);
      if (this.waterMat.userData.uSkyAmt) this.waterMat.userData.uSkyAmt.value = 0.30 + d * 0.55;
    }
    if (this.floodWaterMat) {
      const farFloodFade = this.camDist <= 150 ? 1 : Math.max(0, 1 - (this.camDist - 150) / 95);
      if (this.floodMesh) this.floodMesh.visible = farFloodFade > 0.03;
      const tex = this.floodWaterMat.userData.flowTexture || this.floodWaterMat.map;
      if (tex) tex.offset.y = -this.time * 0.007;
      const floodBase = this.floodWaterMat.userData.baseColor || new THREE.Color(0x3eb7e2);
      this.floodWaterMat.color.copy(floodBase).multiplyScalar(WATER_NIGHT_COLOR_MIN + d * (1 - WATER_NIGHT_COLOR_MIN));
      this.floodWaterMat.opacity = (WATER_NIGHT_OPACITY_MIN * 0.78 + d * 0.30) * farFloodFade;
    }
    if (this.oreMats) {
      const oreVis = Math.max(0, Math.min(1, (d - 0.18) / 0.42));
      const visible = oreVis > 0.02;
      for (const mesh of this.oreMeshes) mesh.visible = visible;
      this.oreMats.rock.opacity = 0.42 + oreVis * 0.28;
      this.oreMats.vein.opacity = oreVis * 0.28;
      this.oreMats.glint.opacity = Math.max(0, oreVis - 0.45) * 0.16;
    }

    // Nachts leuchten Gebäudefenster, Hoflampen und Fahrzeuglichter (geteilte Materialien).
    const night = 1 - d;
    const dynamicLights = this.graphics.lights !== false;
    this.winMat.emissiveIntensity = dynamicLights ? night * 1.6 : 0;
    this.lampMat.emissiveIntensity = dynamicLights ? night * 1.9 : 0;
    this.headMat.color.setHex(dynamicLights && night > 0.45 ? 0xfff7d0 : 0x4a4a40);
    this.rearMat.color.setHex(dynamicLights && night > 0.45 ? 0xff3b30 : 0x451310);

    // Punktlicht-Pool: die kamera-nächsten (versorgten) Gebäude beleuchten nachts ihre Umgebung.
    // Schatten bleiben hier aus; nachts sollen nur Fahrzeugscheinwerfer Shadow-Maps erzeugen.
    this._lightRefreshT = Math.max(0, (this._lightRefreshT || 0) - dt);
    if (!dynamicLights || night <= 0.08) {
      this._cachedLampSpots.length = 0;
      this._cachedBeamSpots.length = 0;
      this._lightRefreshT = 0;
    } else if (this._lightRefreshT <= 0) {
      this._lightRefreshT = this.perf.lightRefresh;
      this._cachedLampSpots = this._lampSpots.filter(s => s.on && !s.vehicle)
        .map(s => ({ s, d: (s.x - c.x) ** 2 + (s.z - c.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.lightPool.length);
      this._cachedBeamSpots = this._lampSpots.filter(s => s.on && s.vehicle)
        .map(s => ({ s, d: (s.x - c.x) ** 2 + (s.z - c.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.vehicleLightPool?.length || 0);
    }
    if (this.lightPool.length) {
      const spots = dynamicLights && night > 0.08 ? this._cachedLampSpots : [];
      for (let i = 0; i < this.lightPool.length; i++) {
        const pl = this.lightPool[i];
        if (pl.castShadow) {
          pl.castShadow = false;
          this._markShadowsDirty(true);
        }
        if (i < spots.length) {
          const s = spots[i].s;
          const beat = Math.max(0, Math.min(1, this.musicBeat || 0));
          const py = s.y + (s.vehicle ? 1.0 : s.disco ? 5.2 : 3.4);
          pl.position.set(s.x, py, s.z);
          if (s.disco) {
            pl.color.setHSL((this.time * 0.12 + beat * 0.28) % 1, 0.95, 0.58);
            pl.distance = 42 + beat * 18;
            pl.decay = 1.35;
            pl.intensity = night * (18 + beat * 42);
          } else {
            pl.color.setHex(0xffd9a0);
            pl.distance = 34;
            pl.decay = 1.65;
            pl.intensity = night * 22;
          }
        } else pl.intensity = 0;
      }
    }
    if (this.vehicleLightPool?.length) {
      const beams = dynamicLights && night > 0.08 ? this._cachedBeamSpots : [];
      let vehicleShadowMoved = false;
      for (let i = 0; i < this.vehicleLightPool.length; i++) {
        const sl = this.vehicleLightPool[i];
        const wantsShadow = this.graphics.shadows !== false && !!sl.userData.vehicleShadow && i < beams.length && night > 0.4;
        if (sl.castShadow !== wantsShadow) {
          sl.castShadow = wantsShadow;
          vehicleShadowMoved = true;
        }
        if (i < beams.length) {
          const s = beams[i].s;
          const fx = s.fx ?? 1, fz = s.fz ?? 0;
          const ty = s.y - 1.1;
          if (wantsShadow && ((sl.position.x - s.x) ** 2 + (sl.position.y - s.y) ** 2 + (sl.position.z - s.z) ** 2) > 0.12 * 0.12) vehicleShadowMoved = true;
          sl.position.set(s.x, s.y, s.z);
          sl.target.position.set(s.x + fx * 20, ty, s.z + fz * 20);
          sl.intensity = night * 6.2;
          sl.distance = 32;
          sl.angle = Math.PI / 8;
          sl.penumbra = 0.78;
        } else {
          sl.intensity = 0;
          if (sl.castShadow) { sl.castShadow = false; vehicleShadowMoved = true; }
        }
      }
      if (vehicleShadowMoved) this._markShadowsDirty(true);
    }

    // Regen: Partikelvorhang um den Kamerafokus; Dichte/Tempo nach Wetterlage.
    this._updateRain(env.w, dt);
    this._updateLocalRainClouds(env.c, dt);

    // Beben: solange aktiv, Kamera rütteln (stärker nahe am Epizentrum).
    if (env.q) {
      const dist = Math.hypot(env.q[0] - c.x, env.q[1] - c.z);
      this._quakeAmp = Math.max(this._quakeAmp, 1.6 * Math.max(0.2, 1 - dist / 160));
    }
    this._quakeAmp *= Math.pow(0.05, dt);                                // schnelles Abklingen
  }

  _updateRain(weather, dt) {
    const cap = this.perf.rainDrops;
    const want = weather === 'storm' ? cap : weather === 'rain' ? Math.round(cap * 0.6) : 0;
    if (!want || this.camDist > PRECIP_MAX_DIST) {
      if (this.rain) this.rain.visible = false;
      return;
    }
    if (!this.rain && want) {
      // Regen als Liniensegmente (LineSegments): je Tropfen ein kurzer vertikaler Strich.
      const N = cap;
      const pos = new Float32Array(N * 2 * 3);
      const col = new Float32Array(N * 2 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.56 });
      this.rain = new THREE.LineSegments(geo, mat);
      this.rain.frustumCulled = false;
      this._rainCap = N;
      this._rainDrops = new Float32Array(N * 3);
      this._rainTypes = new Uint8Array(N); // 0 = Regen, 1 = Schnee
      for (let i = 0; i < N; i++) this._resetDrop(i, true);
      this.scene.add(this.rain);
    }
    if (!this.rain) return;
    const N = this._rainCap || cap;
    const active = Math.min(N, want);
    this.rain.visible = active > 0;
    if (!active) return;
    this.rain.material.opacity = this.camDist > PARTICLE_ZOOM_HIDE_DIST ? 0.72 : 0.56;
    const pos = this.rain.geometry.attributes.position.array;
    const col = this.rain.geometry.attributes.color.array;
    const speed = weather === 'storm' ? 60 : 42;
    const windX = weather === 'storm' ? 14 : 5;
    for (let i = 0; i < active; i++) {
      let x = this._rainDrops[i * 3], y = this._rainDrops[i * 3 + 1], z = this._rainDrops[i * 3 + 2];
      const snow = this._rainTypes?.[i] === 1;
      const fallSpeed = snow ? (weather === 'storm' ? 28 : 20) : speed;
      const wx = snow ? windX * 0.28 + Math.sin(this.time * 2.0 + i) * 0.8 : windX;
      const wz = snow ? Math.cos(this.time * 1.7 + i * 0.37) * 0.45 : 0;
      y -= fallSpeed * dt; x += wx * dt; z += wz * dt;
      if (y < 0) { this._resetDrop(i, false); x = this._rainDrops[i * 3]; y = this._rainDrops[i * 3 + 1]; z = this._rainDrops[i * 3 + 2]; }
      else { this._rainDrops[i * 3] = x; this._rainDrops[i * 3 + 1] = y; this._rainDrops[i * 3 + 2] = z; }
      const isSnow = this._rainTypes?.[i] === 1;
      const len = isSnow ? 0.45 : 1.4;
      const endX = isSnow ? x + wx * 0.012 : x + windX * 0.02;
      const o = i * 6;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = endX; pos[o + 4] = y + len; pos[o + 5] = z;
      const co = i * 6;
      if (isSnow) {
        col[co] = 0.92; col[co + 1] = 0.96; col[co + 2] = 1.0;
        col[co + 3] = 0.78; col[co + 4] = 0.86; col[co + 5] = 0.95;
      } else {
        col[co] = 0.46; col[co + 1] = 0.63; col[co + 2] = 0.86;
        col[co + 3] = 0.68; col[co + 4] = 0.80; col[co + 5] = 0.96;
      }
    }
    // inaktive Tropfen (bei leichtem Regen) aus dem Sichtfeld parken
    for (let i = active; i < N; i++) { const o = i * 6; pos[o + 1] = -100; pos[o + 4] = -100; }
    this.rain.geometry.attributes.position.needsUpdate = true;
    this.rain.geometry.attributes.color.needsUpdate = true;
  }

  _updateLocalRainClouds(clouds, dt) {
    if (!Array.isArray(clouds) || !clouds.length || !this._particlesVisible() || this.camDist > PARTICLE_ZOOM_HIDE_DIST) return;
    this._localCloudFxAt = Math.max(0, (this._localCloudFxAt || 0) - dt);
    if (this._localCloudFxAt > 0) return;
    this._localCloudFxAt = this.quality === 'low' ? 0.36 : this.quality === 'medium' ? 0.24 : 0.16;
    const maxClouds = this.quality === 'low' ? 1 : 2;
    let shown = 0;
    for (const c of clouds) {
      if (!c || shown >= maxClouds) break;
      const x = c[0], z = c[1], r = c[2] || 13;
      if (Math.hypot(x - this.camTarget.x, z - this.camTarget.z) > Math.max(55, this.camDist * 0.55)) continue;
      shown++;
      const drops = this.quality === 'low' ? 2 : this.quality === 'medium' ? 3 : 5;
      for (let i = 0; i < drops && this._canSpawnEffect(); i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * r * 0.82;
        const px = x + Math.cos(a) * d;
        const pz = z + Math.sin(a) * d;
        const py = this.heightAt(px, pz) + 5.5 + Math.random() * 3.5;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(px, py, pz),
          new THREE.Vector3(px + 0.18, py - 3.2, pz),
        ]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x9fc7e8, transparent: true, opacity: 0.52 }));
        this.scene.add(line);
        this._addEffect({ mesh: line, life: 0, max: 0.34 + Math.random() * 0.16, opacity: 0.52, vy: -8.5 });
      }
    }
  }

  _resetDrop(i, anyHeight) {
    const c = this.camTarget;
    const R = Math.min(250, Math.max(110, this.camDist * 0.92));
    const top = Math.max(55, Math.min(260, this.camera.position.y - 12));
    this._rainDrops[i * 3] = c.x + (Math.random() - 0.5) * R;
    this._rainDrops[i * 3 + 1] = anyHeight ? Math.random() * top : top - 12 + Math.random() * 18;
    this._rainDrops[i * 3 + 2] = c.z + (Math.random() - 0.5) * R;
    if (this._rainTypes) {
      const idx = this._tileIndexAt(this._rainDrops[i * 3], this._rainDrops[i * 3 + 2]);
      const snowy = idx >= 0 && this.height?.[idx] > WEATHER_SNOW_LINE;
      this._rainTypes[i] = snowy ? 1 : 0;
    }
  }

  _tileIndexAt(wx, wz) {
    if (!this.mapW || !this.mapH) return -1;
    const gx = Math.max(0, Math.min(this.mapW - 1, Math.round(wx / TILE)));
    const gy = Math.max(0, Math.min(this.mapH - 1, Math.round(wz / TILE)));
    return gy * this.mapW + gx;
  }

  // Blitzeinschlag: gezackter Leuchtpfad vom Himmel + greller Flash + Bodenexplosion.
  spawnLightning(x, z) {
    const y0 = this.heightAt(x, z);
    const pts = [];
    let px = x, pz = z;
    for (let h = y0 + 60; h > y0; h -= 6 + Math.random() * 5) {
      pts.push(new THREE.Vector3(px, h, pz));
      px += (Math.random() - 0.5) * 4; pz += (Math.random() - 0.5) * 4;
    }
    pts.push(new THREE.Vector3(x, y0, z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 1 }));
    this.scene.add(line);
    this._addEffect({ mesh: line, life: 0, max: 0.22, opacity: 1 });
    this._sprite(0xcfe8ff, x, y0 + 1.5, z, 5, 0.3, { additive: true, grow: 1.5, opacity: 1 });
    this.spawnExplosion(x, y0, z, 1.4);
    this._flash = 1.2;                                                   // ganzer Himmel hellt kurz auf
  }

  render() {
    this._animateSeaWaterMesh();
    if (this.perf.faunaStep > 0) {
      this._faunaUpdateT += this._lastDt;
      if (this._faunaUpdateT >= this.perf.faunaStep) {
        const faunaDt = this._faunaUpdateT;
        this._faunaUpdateT = 0;
        this._updateWildlife(faunaDt);
        this._updateFish(faunaDt);
        this._updateBirds(faunaDt);
      }
    } else {
      this._updateWildlife(this._lastDt);
      this._updateFish(this._lastDt);
      this._updateBirds(this._lastDt);
    }
    // Veteranen-Chevrons zur Kamera ausrichten; kleine Gebäudeteile animieren.
    for (const g of this.meshes.values()) {
      if (g.userData.chevrons) for (const ch of g.userData.chevrons) if (ch.visible) ch.quaternion.copy(this.camera.quaternion);
      if (g.userData.spin) g.userData.spin.rotation.y = this.time * (g.userData.spinSpeed || 1.2);
      if (g.userData.buildingAnims) this._animateBuildingAnims(g);
    }
    this._commitShadowRefresh();
    this.renderer.render(this.scene, this.camera);
  }

  // Bodenpunkt unter Bildschirmkoordinate (Raycast gegen Gelände).
  groundPoint(clientX, clientY) {
    this._ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false);
    return hit.length ? { x: hit[0].point.x, z: hit[0].point.z } : null;
  }

  worldToScreen(x, z) {
    const v = this._screenVec.set(x, this.heightAt(x, z) + 1, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, behind: v.z > 1 };
  }

  entityToScreen(e) {
    const g = e?.id != null ? this.meshes.get(e.id) : null;
    let y = this.heightAt(e.x, e.y) + 1;
    if (g?.visible) {
      if (e.domain === 'air') {
        this._screenBox.setFromObject(g);
        y = this._screenBox.isEmpty() ? g.position.y + 0.9 : this._screenBox.getCenter(this._screenVec).y;
      }
      else if (WATER_KINDS.has(e.kind)) y = g.position.y + 0.8;
    } else if (e.domain === 'air') {
      y += 10;
    }
    const v = this._screenVec.set(e.x, y, e.y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, behind: v.z > 1 };
  }
}

function makeEarthPileMesh(mat) {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.85, 7), mat);
  mound.position.y = 0.42; mound.rotation.y = 0.4;
  mound.castShadow = true; mound.receiveShadow = true; g.add(mound);
  const cap = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), mat);
  cap.position.set(0.18, 0.78, -0.12); cap.scale.set(1.2, 0.55, 0.9);
  cap.castShadow = true; cap.receiveShadow = true; g.add(cap);
  return g;
}

function makeOrePileMesh(mat) {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.ConeGeometry(0.9, 0.72, 8), mat);
  mound.position.y = 0.36; mound.rotation.y = 0.25;
  mound.scale.set(1.12, 0.78, 0.95);
  mound.castShadow = true; mound.receiveShadow = true; g.add(mound);
  for (let i = 0; i < 5; i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22 + (i % 3) * 0.05, 0), mat);
    rock.position.set((i - 2) * 0.22, 0.50 + (i % 2) * 0.08, -0.18 + (i % 3) * 0.18);
    rock.scale.set(1.2, 0.62, 0.95);
    rock.rotation.set(i * 0.34, i * 0.71, i * 0.19);
    rock.castShadow = true; rock.receiveShadow = true; g.add(rock);
  }
  return g;
}

function makeWaterFlowTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const base = ctx.createLinearGradient(0, 0, 0, size);
  base.addColorStop(0, '#45bde3');
  base.addColorStop(1, '#2f9dcc');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  ctx.globalCompositeOperation = 'screen';
  for (let y = -size; y < size * 2; y += 38) {
    const grad = ctx.createLinearGradient(0, y, 0, y + 24);
    grad.addColorStop(0, 'rgba(255,255,255,0.00)');
    grad.addColorStop(0.50, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + 6);
    ctx.lineTo(size, y + 14);
    ctx.lineTo(0, y + 8);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(225,248,255,0.16)';
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  for (let y = 18; y < size; y += 34) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.28, y - 4, size * 0.72, y + 4, size, y);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(0,78,120,0.10)';
  ctx.lineWidth = 1.4;
  for (let y = 34; y < size; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.33, y + 3, size * 0.66, y - 3, size, y + 1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

function makeWaterMaterial() {
  const flowTexture = makeWaterFlowTexture();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x55c8f2,
    map: flowTexture,
    transparent: true,
    opacity: 0.56,
    vertexColors: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  mat.userData.flowTexture = flowTexture;
  mat.userData.baseColor = new THREE.Color(0x55c8f2);
  // Himmelsspiegelung: am streifenden Blickwinkel spiegelt die Wasseroberfläche den Himmel (Fresnel),
  // beim Blick von oben bleibt sie transparent (Grund scheint durch). uSky/uSkyAmt werden pro Frame
  // aus der Szenen-Himmelsfarbe nachgeführt.
  mat.userData.uSky = { value: new THREE.Color(0x9ec8e8) };
  mat.userData.uSkyAmt = { value: 0.8 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSky = mat.userData.uSky;
    shader.uniforms.uSkyAmt = mat.userData.uSkyAmt;
    shader.vertexShader = 'varying vec3 vWaterWPos;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vWaterWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    shader.fragmentShader = 'uniform vec3 uSky;\nuniform float uSkyAmt;\nvarying vec3 vWaterWPos;\n' + shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      vec3 vDir = normalize(cameraPosition - vWaterWPos);
      float fres = pow(1.0 - clamp(vDir.y, 0.0, 1.0), 3.2);   // 0 = von oben, 1 = streifend
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, fres * uSkyAmt);
      gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.5 * uSkyAmt, 0.0, 0.96);`,
    );
  };
  return mat;
}

function makeFloodWaterMaterial() {
  const flowTexture = makeWaterFlowTexture(96);
  if (flowTexture) flowTexture.repeat.set(0.9, 0.9);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x3eb7e2,
    map: flowTexture,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.userData.flowTexture = flowTexture;
  mat.userData.baseColor = new THREE.Color(0x3eb7e2);
  return mat;
}

function makeFogOfWarMaterial() {
  const circles = Array.from({ length: 48 }, () => new THREE.Vector3());
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uCount: { value: 0 },
      uCircles: { value: circles },
      uNight: { value: 0 },
      uWeatherFog: { value: 0 },
      uFogColor: { value: new THREE.Color(0.62, 0.72, 0.82) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform int uCount;
      uniform vec3 uCircles[48];
      uniform float uNight;
      uniform float uWeatherFog;
      uniform vec3 uFogColor;
      varying vec3 vWorld;
      void main() {
        float seen = 0.0;
        for (int i = 0; i < 48; i++) {
          if (i >= uCount) break;
          vec3 c = uCircles[i];
          float d = distance(vWorld.xz, c.xy);
          seen = max(seen, 1.0 - smoothstep(c.z * 0.78, c.z, d));
        }
        // Kriegsnebel-Deckkraft hängt NUR an Tag/Nacht. Wetter-Nebel macht ihn NICHT dichter und
        // NICHT dunkler (das ergab schwarze Flächen, wo sich Nebel und Kriegsnebel überlagerten),
        // sondern färbt ihn zur Dunstfarbe der Szene → harmoniert mit scene.fog statt schwarz zu werden.
        float alpha = mix(0.58, 0.88, uNight) * (1.0 - seen);
        vec3 col = mix(vec3(0.19, 0.21, 0.22), vec3(0.03, 0.04, 0.05), uNight);
        col = mix(col, uFogColor, uWeatherFog * 0.7);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// Kompakte Primitiven-Helfer für zusammengesetzte Einheitenmodelle.
function boxMesh(w, h, d, mat, x = 0, y = 0, z = 0, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = ry;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cylMesh(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 10) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function addRing(g, r, col) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.8, r, 20),
    new THREE.MeshBasicMaterial({ color: 0x6cff9a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2; ring.visible = false; ring.renderOrder = 998;
  g.add(ring); g.userData.ring = ring;
}
