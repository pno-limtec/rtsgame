// Modell-Bibliothek: lädt CC0-glTF-Modelle (Poly Pizza / Quaternius·Zsky) und liefert normalisierte,
// fraktionsgetönte Instanzen. Bei fehlender Datei/Ladefehler liefert instance() null → der Renderer
// fällt automatisch auf das prozedurale Mesh zurück. Geometrie & getönte Materialien werden über
// Instanzen geteilt (clone(true)), damit auch 200 Einheiten je Spieler günstig bleiben.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const PATH = '/client/assets/models/';

// kind → Modelldatei + Normalisierung. size = Ziel-Weltmaß (Footprint-Länge bzw. Höhe), yaw = intrinsische
// Drehung, damit die Modell-„Front" mit der Einheiten-Blickrichtung übereinstimmt, lift = Schwebehöhe (Luft).
const REGISTRY = {
  // Infanterie absichtlich NICHT gemappt: das soldier.glb war zu detailliert für den Look —
  // der Renderer baut stattdessen ein stimmiges Low-Poly-Komposit (renderer.makeMesh).
  // Bodenfahrzeuge bleiben prozedural: simple Low-Poly-Silhouetten sind besser lesbar
  // und vermeiden Front-/Pivot-Probleme externer Modelle.
};

export class ModelLibrary {
  constructor() {
    this.loader = new GLTFLoader();
    this.bases = new Map();      // file → THREE.Object3D (Roh-Szene) | 'error'
    this.templates = new Map();  // "kind|color" → normalisiertes, getöntes Template
  }

  meta(kind) { return REGISTRY[kind] || null; }
  liftFor(kind) { const r = REGISTRY[kind]; return r ? (r.lift || 0) : 0; }

  // Alle eindeutigen Modelldateien laden; onFamilyReady(kinds[]) je fertiger Datei (für Mesh-Neuaufbau).
  async preloadAll(onFamilyReady) {
    const files = [...new Set(Object.values(REGISTRY).map(r => r.file))];
    await Promise.all(files.map(async (file) => {
      try {
        const gltf = await this.loader.loadAsync(PATH + file);
        this.bases.set(file, gltf.scene);
      } catch (e) {
        this.bases.set(file, 'error');
        console.warn('[models] Konnte Modell nicht laden, nutze prozedurales Fallback:', file, e.message || e);
      }
      if (onFamilyReady) onFamilyReady(Object.keys(REGISTRY).filter(k => REGISTRY[k].file === file));
    }));
  }

  // Getöntes, normalisiertes Template (zwischengespeichert) für kind+Farbe bauen.
  _template(kind, colorHex) {
    const reg = REGISTRY[kind];
    if (!reg) return null;
    const base = this.bases.get(reg.file);
    if (!base || base === 'error') return null;
    const key = kind + '|' + colorHex;
    let tmpl = this.templates.get(key);
    if (tmpl) return tmpl;

    const root = base.clone(true);
    const tintCol = new THREE.Color(colorHex);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const tintMat = (m) => {
        const c = m.clone();
        if (c.color) c.color.lerp(tintCol, reg.tint ?? 0.3);  // Fraktionsfarbe einmischen (Teamfarbe)
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(tintMat) : tintMat(o.material);
    });

    // Normalisieren: in Footprint-Größe skalieren, zentrieren, auf den Boden setzen (min y = 0).
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = reg.mode === 'height' ? reg.size / (size.y || 1e-3) : reg.size / Math.max(size.x, size.z || 1e-3);
    root.position.x -= (box.min.x + box.max.x) / 2;
    root.position.z -= (box.min.z + box.max.z) / 2;
    root.position.y -= box.min.y;
    const inner = new THREE.Group(); inner.add(root); inner.scale.setScalar(s);
    const wrap = new THREE.Group(); wrap.add(inner); wrap.rotation.y = reg.yaw || 0;

    this.templates.set(key, wrap);
    return wrap;
  }

  // Klon-Instanz für eine Einheit; null falls kein Modell verfügbar (→ prozedurales Fallback).
  instance(kind, colorHex) {
    const tmpl = this._template(kind, colorHex);
    return tmpl ? tmpl.clone(true) : null;
  }
}
