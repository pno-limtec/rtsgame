// Detaillierte prozedurale 3D-Gebäude (CC0/eigenerstellt): jedes Gebäude ein zusammengesetztes
// Mesh statt eines anonymen Blocks. Materialien kommen vom Renderer (geteilt je Teamfarbe);
// `win` ist das global geteilte Fenster-Material (emissiv bei Nacht — EIN Material für alle,
// damit der Tag/Nacht-Wechsel nur eine einzige emissiveIntensity animiert).
import * as THREE from 'three';

const TILE = 2;

// Hilfen: Box/Zylinder kurz, mit Schattenflags.
function box(w, h, d, mat, x = 0, y = 0, z = 0, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = ry;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// Fensterband (emissives geteiltes Material) an einer Wandfläche.
function windows(g, mat, w, h, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z); m.rotation.y = ry;
  g.add(m);
}

function addAnim(g, type, obj, opts = {}) {
  (g.userData.anims || (g.userData.anims = [])).push({
    type,
    obj,
    speed: opts.speed ?? 1,
    amp: opts.amp ?? 1,
    phase: opts.phase ?? 0,
    baseX: obj.position.x,
    baseY: obj.position.y,
    baseZ: obj.position.z,
    baseRX: obj.rotation.x,
    baseRY: obj.rotation.y,
    baseRZ: obj.rotation.z,
    baseSX: obj.scale.x || 1,
    baseSY: obj.scale.y || 1,
    baseSZ: obj.scale.z || 1,
  });
  return obj;
}

function productionDoor(g, mode, obj, opts = {}) {
  (g.userData.prodDoors || (g.userData.prodDoors = [])).push({
    mode,
    obj,
    open: opts.open ?? 1,
    speed: opts.speed ?? 7,
    minScale: opts.minScale ?? 0.18,
    baseX: obj.position.x,
    baseY: obj.position.y,
    baseZ: obj.position.z,
    baseRX: obj.rotation.x,
    baseRY: obj.rotation.y,
    baseRZ: obj.rotation.z,
    baseSX: obj.scale.x || 1,
    baseSY: obj.scale.y || 1,
    baseSZ: obj.scale.z || 1,
  });
  return obj;
}

function marker(g, list, x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  g.add(o);
  (g.userData[list] || (g.userData[list] = [])).push(o);
  return o;
}

function flameMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0xff8a24, transparent: true, opacity: 0.9, depthWrite: false });
}

// Liefert eine Group für `kind`. mats = { body, dark, metal, roof, win, glass, hazard, water, oil, ore, signal }.
// userData.spin = optional rotierendes Teil (Radar/Sonar), userData.windows vorhanden implizit über win-Material.
export function makeBuildingMesh(kind, size, mats) {
  const g = new THREE.Group();
  const s = size * TILE;            // Footprint in Weltmetern
  const { body, dark, metal, roof, win, glass, hazard } = mats;
  const water = mats.water || glass;
  const oil = mats.oil || dark;
  const ore = mats.ore || hazard;
  const signal = mats.signal || hazard;

  switch (kind) {
    case 'hq': {
      g.add(box(s * 0.9, 2.6, s * 0.7, body, 0, 1.3, 0));
      g.add(box(s * 0.42, 4.6, s * 0.42, body, -s * 0.18, 2.3, -s * 0.1));   // Turm
      g.add(box(s * 0.5, 0.5, s * 0.5, dark, -s * 0.18, 4.85, -s * 0.1));    // Turmkranz
      const ant = cyl(0.04, 0.06, 3.2, metal, -s * 0.18, 6.6, -s * 0.1, 6); g.add(ant);
      const radar = new THREE.Group(); radar.position.set(-s * 0.18, 7.95, -s * 0.1);
      radar.add(box(0.9, 0.06, 0.08, signal, 0, 0, 0));
      radar.add(cyl(0.07, 0.07, 0.12, metal, 0, 0, 0, 8));
      g.add(radar); addAnim(g, 'spinY', radar, { speed: 1.6 });
      g.add(box(s * 0.34, 1.2, s * 0.3, dark, s * 0.26, 0.6, s * 0.22));     // Eingang
      windows(g, win, s * 0.7, 0.7, 0, 1.7, s * 0.7 / 2 + 0.02);
      windows(g, win, s * 0.3, 2.6, -s * 0.18 + s * 0.215, 2.6, -s * 0.1, Math.PI / 2);
      break;
    }
    case 'power_plant': {
      g.add(box(s * 0.85, 1.6, s * 0.55, body, 0, 0.8, s * 0.16));           // Maschinenhalle
      g.add(cyl(0.62, 0.95, 2.9, metal, -s * 0.24, 1.45, -s * 0.24, 14));    // Kühlturm 1
      g.add(cyl(0.5, 0.78, 2.4, metal, s * 0.26, 1.2, -s * 0.26, 14));       // Kühlturm 2
      g.add(cyl(0.24, 0.34, 5.8, dark, s * 0.07, 2.9, -s * 0.06, 10));       // großer Schornstein
      g.add(cyl(0.34, 0.28, 0.22, metal, s * 0.07, 5.9, -s * 0.06, 10));     // Schornsteinkappe
      marker(g, 'smokeStacks', s * 0.07, 6.04, -s * 0.06);
      marker(g, 'smokeStacks', -s * 0.24, 2.95, -s * 0.24);
      const fan = new THREE.Group(); fan.position.set(s * 0.28, 2.55, -s * 0.26);
      fan.add(box(0.9, 0.06, 0.1, metal, 0, 0, 0));
      fan.add(box(0.1, 0.06, 0.9, metal, 0, 0, 0));
      g.add(fan); addAnim(g, 'spinY', fan, { speed: 2.4 });
      g.add(box(0.5, 0.5, 1.6, dark, 0, 0.35, s * 0.42));                    // Rohrleitung zur Halle
      windows(g, win, s * 0.7, 0.5, 0, 1.0, s * 0.16 + s * 0.55 / 2 + 0.02);
      break;
    }
    case 'solar_plant': {
      g.add(box(s * 0.3, 0.8, s * 0.3, body, -s * 0.32, 0.4, -s * 0.32));    // Wechselrichterhaus
      for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.9), glass);
        p.position.set((c - 1) * 1.25, 0.55, r * 1.5 - 0.3);
        p.rotation.x = -0.5;                                                  // zur Sonne geneigt
        p.castShadow = true;
        addAnim(g, 'swingX', p, { speed: 0.32, amp: 0.06, phase: c * 0.4 + r });
        const post = cyl(0.05, 0.05, 0.5, metal, (c - 1) * 1.25, 0.25, r * 1.5 - 0.3, 6);
        g.add(p, post);
      }
      break;
    }
    case 'water_pump': {
      g.add(box(s * 0.98, 0.16, s * 0.72, dark, 0, 0.26, 0));                // schwimmendes Deck
      for (const z of [-s * 0.34, s * 0.34]) {
        const pontoon = cyl(0.22, 0.22, s * 0.92, metal, 0, 0.04, z, 12);
        pontoon.rotation.z = Math.PI / 2;
        g.add(pontoon);
      }
      g.add(box(s * 0.44, 1.0, s * 0.36, body, -s * 0.2, 0.82, -s * 0.02));  // leichtes Pumpenhaus
      g.add(cyl(0.5, 0.5, 0.78, water, s * 0.24, 0.78, -s * 0.16, 14));      // blauer Wassertank
      g.add(box(0.9, 0.1, 0.14, water, s * 0.24, 1.2, -s * 0.16));           // Tank-Markierung
      const intake = cyl(0.16, 0.16, 1.3, metal, s * 0.16, -0.28, s * 0.26, 8);
      intake.rotation.x = Math.PI / 2; g.add(intake);                        // Ansaugrohr ins Wasser
      const pipe1 = cyl(0.13, 0.13, 1.45, metal, s * 0.08, 0.48, s * 0.28, 8);
      pipe1.rotation.z = Math.PI / 2; g.add(pipe1);                          // liegendes Rohr
      g.add(cyl(0.13, 0.13, 0.9, metal, s * 0.26, 0.66, s * 0.28, 8));       // Steigrohr
      const wheel = new THREE.Group(); wheel.position.set(s * 0.02, 1.04, s * 0.27);
      const wh = cyl(0.34, 0.34, 0.08, metal, 0, 0, 0, 12); wh.rotation.x = Math.PI / 2; wheel.add(wh);
      wheel.add(box(0.7, 0.05, 0.06, water, 0, 0, 0));
      wheel.add(box(0.06, 0.05, 0.7, water, 0, 0, 0));
      g.add(wheel); addAnim(g, 'spinZ', wheel, { speed: 3.1 });
      windows(g, win, 0.62, 0.32, -s * 0.2, 0.86, s * 0.16 + 0.02);
      break;
    }
    case 'pipe': {
      // Die durchgehende Pipeline wird im Renderer als Netzmesh aufgebaut; dieses Objekt bleibt
      // nur die lokale Kupplung/Armatur, damit keine unverbundenen Rohrstücke entstehen.
      const hub = cyl(0.3, 0.3, 0.34, dark, 0, 0.26, 0, 12);
      hub.rotation.z = Math.PI / 2; g.add(hub);
      const valve = cyl(0.09, 0.09, 0.7, metal, 0, 0.36, 0, 8);
      valve.rotation.z = Math.PI / 2; g.add(valve);
      g.add(box(0.5, 0.1, 0.5, dark, 0, 0.05, 0));
      break;
    }
    case 'road': {
      g.add(box(s * 0.96, 0.08, s * 0.7, dark, 0, 0.05, 0));                // Fahrbahn
      g.add(box(s * 0.96, 0.04, s * 0.1, roof, 0, 0.09, -s * 0.39));         // Bankett
      g.add(box(s * 0.96, 0.04, s * 0.1, roof, 0, 0.09, s * 0.39));
      for (const x of [-s * 0.3, 0, s * 0.3]) {
        g.add(box(s * 0.16, 0.035, 0.045, hazard, x, 0.12, 0));
      }
      break;
    }
    case 'bridge': {
      g.add(box(s * 1.02, 0.18, s * 0.92, roof, 0, 0.26, 0));               // breites, ebenes Deck
      g.add(box(s * 1.04, 0.18, 0.12, dark, 0, 0.48, -s * 0.43));
      g.add(box(s * 1.04, 0.18, 0.12, dark, 0, 0.48, s * 0.43));
      for (const x of [-s * 0.38, 0, s * 0.38]) {
        g.add(cyl(0.05, 0.06, 0.62, metal, x, 0.31, -s * 0.34, 6));
        g.add(cyl(0.05, 0.06, 0.62, metal, x, 0.31, s * 0.34, 6));
      }
      g.add(box(s * 0.24, 0.045, 0.05, hazard, -s * 0.22, 0.39, 0));
      g.add(box(s * 0.24, 0.045, 0.05, hazard, s * 0.22, 0.39, 0));
      break;
    }
    case 'pontoon': {
      // Pontonbrücke: flaches Floß-Segment knapp über der Wasseroberfläche (improvisiert, niedrig).
      g.add(box(s * 0.92, 0.18, s * 0.92, dark, 0, 0.12, 0));               // Deck
      g.add(box(s * 0.96, 0.22, s * 0.16, metal, 0, 0.05, -s * 0.4));       // Schwimmkörper vorn
      g.add(box(s * 0.96, 0.22, s * 0.16, metal, 0, 0.05, s * 0.4));        // Schwimmkörper hinten
      break;
    }
    case 'tunnel': {
      g.add(box(s * 1.05, 0.22, s * 1.05, roof, 0, 0.05, 0));                // Fels-/Betonsockel
      g.add(box(0.5, 2.0, s * 0.98, dark, -s * 0.4, 1.0, 0));                // Portalwangen
      g.add(box(0.5, 2.0, s * 0.98, dark, s * 0.4, 1.0, 0));
      g.add(box(s * 1.0, 0.55, s * 0.98, dark, 0, 2.18, 0));                 // Sturz
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(s * 0.55, 1.7),
        new THREE.MeshBasicMaterial({ color: 0x000000 }));
      hole.position.set(0, 0.9, s * 0.49); g.add(hole);                      // dunkle Röhre
      const hole2 = hole.clone(); hole2.rotation.y = Math.PI; hole2.position.z = -s * 0.49; g.add(hole2);
      g.add(box(s * 1.0, 0.22, s * 1.0, roof, 0, 2.55, 0));                  // Überdeckung
      g.add(box(s * 0.64, 0.08, 0.08, hazard, 0, 1.9, s * 0.52));
      g.add(box(s * 0.64, 0.08, 0.08, hazard, 0, 1.9, -s * 0.52));
      break;
    }
    case 'refinery': {
      g.add(cyl(1.05, 1.05, 1.7, oil, -s * 0.22, 0.85, -s * 0.18, 16));      // dunkler Tank 1
      g.add(cyl(0.8, 0.8, 1.3, metal, s * 0.05, 0.65, -s * 0.3, 16));        // Tank 2
      g.add(cyl(0.28, 0.34, 4.2, body, s * 0.3, 2.1, s * 0.05, 10));         // Destillationskolonne
      g.add(cyl(0.16, 0.2, 3.0, dark, s * 0.38, 1.5, -s * 0.2, 8));          // Fackelturm
      const flare = cyl(0.0, 0.16, 0.55, flameMaterial(), s * 0.38, 3.2, -s * 0.2, 8); // sichtbare Fackel
      g.add(flare); addAnim(g, 'flame', flare, { speed: 11, amp: 0.28, phase: 0.5 });
      marker(g, 'smokeStacks', s * 0.38, 3.35, -s * 0.2);
      g.add(box(s * 0.6, 1.1, s * 0.4, body, -s * 0.1, 0.55, s * 0.3));      // Annahmehalle
      const pr = cyl(0.1, 0.1, s * 0.55, dark, 0, 1.5, -s * 0.05, 6);
      pr.rotation.z = Math.PI / 2; g.add(pr);                                // Verbindungsrohr
      windows(g, win, s * 0.45, 0.4, -s * 0.1, 0.75, s * 0.3 + s * 0.2 + 0.02);
      break;
    }
    case 'ore_depot': {
      g.add(box(s * 0.95, 0.18, s * 0.95, dark, 0, 0.09, 0));
      for (let i = 0; i < 5; i++) {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42 + i * 0.03, 0), i % 2 ? ore : roof);
        rock.position.set((i % 3 - 1) * 0.55, 0.35 + i * 0.07, (i > 2 ? 0.38 : -0.28));
        rock.rotation.set(i * 0.4, i * 0.8, i * 0.2);
        rock.castShadow = true; rock.receiveShadow = true; g.add(rock);
      }
      const belt = box(s * 0.75, 0.12, 0.22, ore, 0.05, 1.08, -s * 0.35, -0.12); // Förderband-Akzent
      g.add(belt); addAnim(g, 'slideX', belt, { speed: 1.8, amp: 0.10 });
      g.add(box(s * 0.32, 1.0, s * 0.22, body, -s * 0.3, 0.62, s * 0.28));
      windows(g, win, s * 0.22, 0.3, -s * 0.3, 0.76, s * 0.28 + s * 0.11 + 0.02);
      break;
    }
    case 'material_depot': {
      g.add(box(s * 0.95, 0.16, s * 0.95, dark, 0, 0.08, 0));
      for (let i = 0; i < 4; i++) {
        const pile = cyl(0.95 - i * 0.12, 1.15 - i * 0.12, 0.45, roof, (i % 2 ? 0.45 : -0.35), 0.35 + i * 0.08, (i > 1 ? 0.34 : -0.28), 5);
        pile.rotation.y = i * 0.8; g.add(pile);
      }
      const loader = box(1.0, 0.9, 0.75, hazard, s * 0.28, 0.55, -s * 0.25);
      g.add(loader); addAnim(g, 'bobY', loader, { speed: 1.2, amp: 0.06 });
      break;
    }
    case 'water_tower': {
      g.add(box(s * 0.55, 0.7, s * 0.5, body, -s * 0.2, 0.35, s * 0.18));
      for (const [dx, dz] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
        g.add(cyl(0.06, 0.08, 3.6, metal, dx, 1.8, dz, 6));
      }
      g.add(cyl(0.9, 0.9, 1.25, water, 0, 4.0, 0, 18));
      const level = box(1.55, 0.16, 0.18, glass, 0, 4.15, 0.92);
      g.add(level); addAnim(g, 'pulse', level, { speed: 1.1, amp: 0.05 });
      g.add(cyl(0.74, 0.9, 0.38, metal, 0, 4.82, 0, 18));
      break;
    }
    case 'oil_depot': {
      g.add(box(s * 0.95, 0.14, s * 0.95, dark, 0, 0.07, 0));
      g.add(cyl(0.85, 0.85, 1.25, oil, -s * 0.22, 0.7, -s * 0.1, 18));
      g.add(cyl(0.72, 0.72, 1.05, oil, s * 0.28, 0.6, s * 0.18, 18));
      const h1 = box(1.25, 0.13, 0.16, hazard, -s * 0.22, 1.26, -s * 0.1);
      const h2 = box(1.05, 0.13, 0.16, hazard, s * 0.28, 1.08, s * 0.18);
      g.add(h1, h2); addAnim(g, 'pulse', h1, { speed: 1.8, amp: 0.08 }); addAnim(g, 'pulse', h2, { speed: 1.6, amp: 0.08, phase: 1.1 });
      const pr = cyl(0.1, 0.1, s * 0.62, metal, 0, 0.34, s * 0.02, 8);
      pr.rotation.z = Math.PI / 2; g.add(pr);
      g.add(box(s * 0.24, 0.9, s * 0.22, body, -s * 0.36, 0.52, s * 0.32));
      break;
    }
    case 'oil_derrick': {
      // Bohrturm: vier zusammenlaufende Streben + Querriegel + Pumpenkopf.
      const hgt = 4.2;
      g.add(cyl(1.08, 1.16, 0.06, oil, 0, 0.03, 0, 18));                    // schwarzer Ölfleck unter dem Turm
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = box(0.14, hgt, 0.14, metal, dx * 0.8, hgt / 2, dz * 0.8);
        leg.rotation.z = -dx * 0.18; leg.rotation.x = dz * 0.18;
        g.add(leg);
      }
      g.add(box(0.9, 0.18, 0.9, metal, 0, hgt * 0.55, 0));
      const beam = box(1.75, 0.14, 0.22, signal, -0.1, hgt * 0.7, 0.42, -0.35); // Pumpjack-Balken als Silhouette
      g.add(beam); addAnim(g, 'swingZ', beam, { speed: 2.0, amp: 0.22 });
      g.add(box(0.5, 0.4, 0.5, dark, 0, hgt + 0.1, 0));                       // Kopf
      const flame = cyl(0.0, 0.2, 0.75, flameMaterial(), 0, hgt + 0.72, 0, 8);
      g.add(flame); addAnim(g, 'flame', flame, { speed: 12, amp: 0.35 });
      marker(g, 'smokeStacks', 0, hgt + 1.12, 0);
      g.add(box(1.2, 0.7, 0.9, body, s * 0.3, 0.35, s * 0.3));               // Pumpenhaus
      g.add(cyl(0.5, 0.5, 0.8, dark, -s * 0.3, 0.4, s * 0.3, 12));           // Öltank
      break;
    }
    case 'barracks': {
      g.add(box(s * 0.95, 1.15, s * 0.56, body, 0, 0.58, 0));                // lange Baracke
      const r = cyl(s * 0.46, s * 0.46, s * 0.9, roof, 0, 1.3, 0, 3);
      r.rotation.z = Math.PI / 2; r.rotation.x = Math.PI;                     // Satteldach (3-seitiger Zylinder)
      r.scale.set(1, 0.55, 0.72); g.add(r);
      const porch = box(s * 0.42, 0.08, 0.38, dark, 0, 0.08, s * 0.42);      // kleiner Vorplatz
      g.add(porch);
      const doorPivot = new THREE.Group(); doorPivot.position.set(-0.32, 0.58, s * 0.28 + 0.055);
      doorPivot.add(box(0.64, 0.96, 0.08, dark, 0.32, 0, 0));                // Schwenktür mit linker Angel
      g.add(doorPivot); productionDoor(g, 'swingY', doorPivot, { open: -1.28, speed: 9 });
      g.add(box(s * 0.34, 0.08, 0.12, hazard, 0, 1.12, s * 0.3 + 0.05));     // Eingangsmarkierung
      for (const x of [-s * 0.32, s * 0.32]) {
        g.add(box(0.52, 0.36, 0.1, dark, x, 0.44, -s * 0.31));              // Ausrüstungskisten hinten
      }
      g.add(cyl(0.05, 0.05, 2.2, metal, s * 0.4, 1.1, -s * 0.24, 6));        // Fahnenmast
      const flag = box(0.5, 0.3, 0.04, hazard, s * 0.4 + 0.26, 1.95, -s * 0.24); // Fahne
      g.add(flag); addAnim(g, 'swingZ', flag, { speed: 3.0, amp: 0.16 });
      windows(g, win, s * 0.22, 0.34, -s * 0.3, 0.82, s * 0.3 + 0.03);
      windows(g, win, s * 0.22, 0.34, s * 0.3, 0.82, s * 0.3 + 0.03);
      break;
    }
    case 'factory': {
      g.add(box(s * 0.95, 1.9, s * 0.7, body, 0, 0.95, 0));                  // Halle
      for (let i = 0; i < 3; i++) {                                          // Sheddach
        const w = cyl(s * 0.16, s * 0.16, s * 0.66, roof, -s * 0.3 + i * s * 0.3, 2.05, 0, 3);
        w.rotation.z = Math.PI / 2; w.rotation.x = Math.PI; w.scale.set(1, 0.8, 1);
        g.add(w);
      }
      g.add(cyl(0.18, 0.24, 3.4, dark, -s * 0.36, 1.9, -s * 0.26, 8));       // Kamin
      marker(g, 'smokeStacks', -s * 0.36, 3.72, -s * 0.26);
      const vent = new THREE.Group(); vent.position.set(s * 0.3, 2.42, -s * 0.1);
      vent.add(box(0.75, 0.05, 0.1, metal, 0, 0, 0));
      vent.add(box(0.1, 0.05, 0.75, metal, 0, 0, 0));
      g.add(vent); addAnim(g, 'spinY', vent, { speed: 2.8 });
      const rollDoor = box(s * 0.5, 1.46, 0.1, dark, 0, 0.73, s * 0.35 + 0.03);
      g.add(rollDoor); productionDoor(g, 'rollY', rollDoor, { open: 0.72, speed: 8, minScale: 0.16 });
      g.add(box(s * 0.54, 0.16, 0.14, metal, 0, 1.5, s * 0.37 + 0.045));     // Rolltorkasten
      g.add(box(s * 0.56, 0.16, 0.12, hazard, 0, 1.55, s * 0.37 + 0.04));    // gelbe Hallenmarkierung
      windows(g, win, s * 0.8, 0.5, 0, 1.5, s * 0.35 + 0.04);
      break;
    }
    case 'airbase': {
      g.add(box(s * 0.96, 0.08, s * 0.28, dark, 0.03, 0.04, s * 0.18));      // lange Start-/Landebahn
      for (const x of [-s * 0.32, -s * 0.12, s * 0.08, s * 0.28]) {
        g.add(box(s * 0.08, 0.045, s * 0.035, signal, x, 0.1, s * 0.18));
      }
      g.add(box(s * 0.9, 0.05, s * 0.05, metal, 0, 0.11, s * 0.02));         // Rollweg
      const pad = cyl(s * 0.18, s * 0.18, 0.12, dark, -s * 0.28, 0.08, -s * 0.22, 20);
      g.add(pad);                                                             // Landeplattform
      g.add(cyl(s * 0.055, s * 0.055, 0.05, hazard, -s * 0.28, 0.16, -s * 0.22, 20)); // Markierung
      g.add(box(s * 0.18, 3.4, s * 0.18, body, -s * 0.4, 1.7, -s * 0.32));   // Tower
      g.add(box(s * 0.24, 0.7, s * 0.24, glass, -s * 0.4, 3.7, -s * 0.32));  // Kanzel
      const radar = new THREE.Group(); radar.position.set(-s * 0.4, 4.2, -s * 0.32);
      radar.add(box(1.1, 0.05, 0.08, signal, 0, 0, 0));
      radar.add(cyl(0.05, 0.05, 0.25, metal, 0, -0.12, 0, 8));
      g.add(radar); g.userData.spin = radar; g.userData.spinSpeed = 2.5;
      const hangar = cyl(s * 0.14, s * 0.14, s * 0.36, roof, s * 0.22, 0, -s * 0.31, 12, true);
      hangar.rotation.z = Math.PI / 2;                                        // Hangar (Halbtonne)
      g.add(hangar);
      g.add(box(1.55, 0.12, 0.55, metal, s * 0.22, 0.72, -s * 0.31));        // sichtbares Flugzeugprofil im Hangar
      const windsock = box(0.34, 0.28, 0.18, signal, -s * 0.46, 1.7, s * 0.38); // Windsack
      g.add(windsock); addAnim(g, 'swingZ', windsock, { speed: 2.6, amp: 0.18 });
      windows(g, win, s * 0.14, 1.6, -s * 0.4 + s * 0.095, 1.9, -s * 0.32, Math.PI / 2);
      break;
    }
    case 'shipyard': {
      g.add(box(s * 0.95, 0.5, s * 0.6, dark, 0, 0.25, s * 0.16));           // Kai
      g.add(box(s * 0.74, 0.08, s * 0.42, water, s * 0.05, 0.55, -s * 0.08)); // blaues Dockbecken
      g.add(box(s * 0.42, 0.16, s * 0.12, metal, s * 0.05, 0.68, -s * 0.08)); // Schiffskiel auf Slip
      g.add(box(s * 0.4, 1.2, s * 0.34, body, -s * 0.26, 1.1, s * 0.26));    // Werfthalle
      // Portalkran
      g.add(box(0.18, 3.2, 0.18, metal, -s * 0.3, 1.6, -s * 0.2));
      g.add(box(0.18, 3.2, 0.18, metal, s * 0.3, 1.6, -s * 0.2));
      g.add(box(s * 0.78, 0.22, 0.3, metal, 0, 3.2, -s * 0.2));
      g.add(cyl(0.03, 0.03, 1.6, dark, s * 0.1, 2.4, -s * 0.2, 4));          // Kranseil
      const load = box(0.4, 0.3, 0.4, hazard, s * 0.1, 1.5, -s * 0.2);       // Last
      g.add(load); addAnim(g, 'bobY', load, { speed: 1.4, amp: 0.28 });
      windows(g, win, s * 0.3, 0.4, -s * 0.26, 1.3, s * 0.26 + s * 0.17 + 0.02);
      break;
    }
    case 'depot': {
      // Nachschubdepot = ÜBERDACHTE Versorgungshalle (klar abgegrenzt von den OFFENEN Rohstoffhöfen:
      // ore_depot = Felsen, material_depot = Schütthaufen, oil_depot = Tanks). Tonnendach + Ladebucht
      // mit Rolltor + gestapelte Paletten geben eine eindeutige Logistik-Silhouette (Ziel F).
      g.add(box(s * 0.95, 0.16, s * 0.95, dark, 0, 0.08, 0));                 // Betonplatte
      g.add(box(s * 0.8, 1.05, s * 0.66, body, 0, 0.62, -s * 0.08));         // Lagerhalle
      for (let i = 0; i < 4; i++) {                                          // geripptes Tonnendach
        const rib = cyl(s * 0.2, s * 0.2, s * 0.78, roof, -s * 0.3 + i * s * 0.2, 1.18, -s * 0.08, 3);
        rib.rotation.z = Math.PI / 2; rib.rotation.x = Math.PI; rib.scale.set(1, 0.62, 1);
        g.add(rib);
      }
      // Ladebucht vorn: Vordach auf zwei Stützen + Rolltor mit Warnstreifen
      g.add(box(s * 0.84, 0.1, s * 0.26, metal, 0, 1.16, s * 0.32));         // Vordach
      for (const sx of [-s * 0.36, s * 0.36]) g.add(cyl(0.06, 0.07, 1.1, metal, sx, 0.62, s * 0.42, 6));
      g.add(box(s * 0.4, 0.92, 0.08, dark, 0, 0.58, s * 0.25 + 0.02));       // Rolltor
      g.add(box(s * 0.44, 0.12, 0.1, hazard, 0, 1.06, s * 0.25 + 0.03));     // gelber Bucht-Warnbalken
      // gestapelte Versorgungspaletten neben der Bucht (eine pulsiert = Umschlag)
      g.add(box(0.78, 0.5, 0.62, roof, -s * 0.3, 0.41, s * 0.32, 0.18));
      const pallet = box(0.74, 0.46, 0.58, hazard, s * 0.3, 0.39, s * 0.32, -0.22);
      g.add(pallet); addAnim(g, 'pulse', pallet, { speed: 1.35, amp: 0.05 });
      g.add(box(0.6, 0.4, 0.5, metal, s * 0.32, 0.78, s * 0.3, -0.22));      // zweite Lage
      windows(g, win, s * 0.5, 0.34, 0, 0.86, -s * 0.08 - s * 0.33 - 0.02, Math.PI); // Rückfenster
      break;
    }
    case 'mg_turret': {
      g.add(cyl(0.72, 0.92, 0.56, dark, 0, 0.28, 0, 12));
      g.add(cyl(0.72, 0.72, 0.08, signal, 0, 0.61, 0, 18));
      const head = new THREE.Group(); head.position.y = 0.92;
      head.add(box(0.78, 0.34, 0.62, body, 0, 0, 0));
      for (const sx of [-0.13, 0.13]) {
        const gun = cyl(0.035, 0.045, 1.05, metal, sx, 0.08, 0.56, 7);
        gun.rotation.x = Math.PI / 2; head.add(gun);
      }
      g.add(head); addAnim(g, 'swingY', head, { speed: 0.9, amp: 0.45 });
      g.userData.turretHead = head;   // dreht im Gefecht zum Ziel statt zu scannen
      break;
    }
    case 'turret': {
      g.add(cyl(0.85, 1.0, 0.7, dark, 0, 0.35, 0, 12));                      // Sockel
      g.add(cyl(0.98, 0.98, 0.08, signal, 0, 0.74, 0, 18));                  // rote Verteidigungsmarkierung
      g.add(cyl(0.6, 0.7, 0.5, body, 0, 0.95, 0, 12));                       // Drehkranz
      const head = new THREE.Group();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), body);
      dome.position.y = 1.2; dome.castShadow = true; head.add(dome);
      const barrel = cyl(0.08, 0.1, 1.6, metal, 0, 1.35, 0.8, 8);
      barrel.rotation.x = Math.PI / 2 - 0.12; head.add(barrel);               // Rohr
      g.add(head); addAnim(g, 'swingY', head, { speed: 0.7, amp: 0.55 });
      g.userData.turretHead = head;
      break;
    }
    case 'flak_turret': {
      g.add(cyl(0.72, 1.0, 0.34, dark, 0, 0.17, 0, 12));
      g.add(cyl(0.86, 0.86, 0.08, signal, 0, 0.39, 0, 18));
      for (const [sx, sz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) {
        const leg = cyl(0.035, 0.055, 1.75, metal, sx * 0.55, 1.12, sz * 0.55, 5);
        leg.rotation.x = sz * 0.18; leg.rotation.z = -sx * 0.18; g.add(leg);
      }
      g.add(box(1.2, 0.12, 1.2, dark, 0, 1.92, 0));                         // offene Plattform
      g.add(box(1.36, 0.08, 0.08, signal, 0, 2.02, -0.58));
      g.add(box(1.36, 0.08, 0.08, signal, 0, 2.02, 0.58));
      const head = new THREE.Group(); head.position.y = 2.18;
      head.add(cyl(0.28, 0.34, 0.22, body, 0, 0, 0, 10));
      for (const sx of [-0.28, -0.09, 0.09, 0.28]) {
        const gun = cyl(0.045, 0.06, 1.45, metal, sx, 0.08, 0.58, 7);
        gun.rotation.x = Math.PI / 2 - 0.58; head.add(gun);
      }
      const sight = new THREE.Group(); sight.position.set(0.48, 0.12, -0.25);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), signal);
      dish.rotation.x = Math.PI / 2.5; dish.castShadow = true; sight.add(dish);
      head.add(sight);
      g.add(head); addAnim(g, 'swingY', head, { speed: 1.0, amp: 0.5 });
      g.userData.turretHead = head;
      break;
    }
    case 'sam_site': {
      g.add(cyl(0.9, 1.0, 0.5, dark, 0, 0.25, 0, 12));
      const rack = new THREE.Group(); rack.position.y = 0.8; rack.rotation.x = -0.7;
      for (const [dx, dy] of [[-0.22, 0.12], [0.22, 0.12], [-0.22, -0.14], [0.22, -0.14]]) {
        const tube = cyl(0.11, 0.11, 1.4, metal, dx, 0, dy, 8);
        tube.rotation.x = Math.PI / 2; rack.add(tube);
        const tip = cyl(0.0, 0.1, 0.25, hazard, dx, 0.8, dy, 8);
        tip.rotation.x = Math.PI / 2; rack.add(tip);
      }
      g.add(rack); addAnim(g, 'swingX', rack, { speed: 0.75, amp: 0.18 });
      g.userData.turretHead = rack;   // schwenkt zusätzlich in der Azimut-Ebene zum Ziel
      g.add(box(0.5, 0.5, 0.5, body, 0.7, 0.45, -0.5));                      // Leitkabine
      break;
    }
    case 'sonar': {
      g.add(box(1.1, 0.7, 1.1, body, 0, 0.35, 0));
      const mast = cyl(0.07, 0.09, 1.8, metal, 0, 1.5, 0, 8); g.add(mast);
      const dish = new THREE.Group(); dish.position.y = 2.5;
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 3), metal);
      d.rotation.x = Math.PI / 2.6; d.castShadow = true;
      dish.add(d);
      g.add(dish);
      g.userData.spin = dish; g.userData.spinSpeed = 1.2;                     // rotiert im render()
      break;
    }
    case 'spotlight': {
      g.add(cyl(0.62, 0.82, 0.34, dark, 0, 0.17, 0, 12));
      g.add(box(0.9, 0.12, 0.9, signal, 0, 0.42, 0));
      const mast = cyl(0.08, 0.1, 2.15, metal, 0, 1.44, 0, 8); g.add(mast);
      for (const sx of [-0.34, 0.34]) {
        const brace = cyl(0.035, 0.04, 2.1, metal, sx * 0.5, 1.2, 0, 6);
        brace.rotation.z = -sx * 0.18; g.add(brace);
      }
      const head = new THREE.Group(); head.position.y = 2.62; head.rotation.x = -0.2;
      const lamp = cyl(0.34, 0.48, 0.62, body, 0, 0, 0, 16);
      lamp.rotation.x = Math.PI / 2; head.add(lamp);
      const glassPane = cyl(0.32, 0.32, 0.035, glass, 0, 0, 0.34, 16);
      glassPane.rotation.x = Math.PI / 2; head.add(glassPane);
      const yoke = box(1.0, 0.08, 0.08, metal, 0, 0, -0.08); head.add(yoke);
      g.add(head); addAnim(g, 'swingY', head, { speed: 0.42, amp: 0.42 });
      g.userData.turretHead = head;
      const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.12, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.ConeGeometry(1.25, 3.2, 18, 1, true), beamMat);
      beam.position.set(0, 2.52, 1.75); beam.rotation.x = Math.PI / 2; g.add(beam);
      break;
    }
    case 'dam': {
      g.add(box(s * 0.98, 2.8, s * 0.55, dark, 0, 1.4, 0));                  // Mauer
      g.add(box(s * 0.98, 0.3, s * 0.7, metal, 0, 2.85, 0));                 // Krone
      g.add(box(s * 0.3, 1.0, s * 0.3, body, s * 0.28, 3.4, 0));             // Schalthaus
      for (let i = 0; i < 3; i++) {
        const outlet = cyl(0.14, 0.14, 0.5, metal, -s * 0.3 + i * s * 0.3, 0.5, s * 0.3, 8);
        g.add(outlet); addAnim(g, 'spinZ', outlet, { speed: 1.7 + i * 0.25 });
      } // Ausläufe
      windows(g, win, s * 0.22, 0.4, s * 0.28, 3.5, s * 0.15 + 0.02);
      break;
    }
    case 'levee': {
      const wedge = cyl(s * 0.5, s * 0.5, s * 0.96, roof, 0, 0, 0, 3);
      wedge.rotation.z = Math.PI / 2; wedge.rotation.x = Math.PI;
      wedge.scale.set(1, 0.62, 0.85); wedge.position.y = 0.62;
      wedge.castShadow = true; wedge.receiveShadow = true;
      g.add(wedge);                                                           // Erdwall-Keil
      break;
    }
    case 'wall': {
      // Befestigungsmauer: gebatterter (unten breiter) Betonsockel, Wandkörper in Teamfarbe,
      // umlaufender Laufgang, Warnstreifen und abwechselnde Zinnen (Merlonen/Scharten) +
      // diagonale Strebepfeiler hinten — eindeutige Fortifikations-Silhouette.
      g.add(box(s * 0.98, 0.5, s * 0.62, dark, 0, 0.25, 0));                  // breiter Fuß (Batter)
      g.add(box(s * 0.9, 0.82, s * 0.46, body, 0, 0.9, 0));                   // Wandkörper
      g.add(box(s * 0.96, 0.13, s * 0.5, dark, 0, 1.38, 0));                  // Laufgang-Lippe
      g.add(box(s * 0.9, 0.09, 0.04, hazard, 0, 0.95, s * 0.24 + 0.01));      // Warnstreifen vorne
      g.add(box(s * 0.9, 0.09, 0.04, hazard, 0, 0.95, -s * 0.24 - 0.01));     // Warnstreifen hinten
      for (let i = 0; i < 4; i++) {
        g.add(box(s * 0.17, 0.44, s * 0.5, dark, -s * 0.345 + i * s * 0.23, 1.66, 0)); // Merlonen (Lücken = Scharten)
      }
      for (const sx of [-s * 0.3, s * 0.3]) {
        const but = box(0.24, 1.05, 0.46, dark, sx, 0.62, -s * 0.34);
        but.rotation.x = -0.3; g.add(but);                                    // Strebepfeiler
      }
      break;
    }
    case 'trench': {
      // Eingegrabene Feuerstellung: abgesenkter dunkler Grabenboden, umlaufende Erdböschung,
      // gestaffelte Sandsackbrüstung (Einzelsäcke in zwei Lagen), Hazard-Markierung am Feuertritt
      // und Holz-Stützpfosten in den Ecken — liest sich klar als Schützengraben, nicht als Block.
      g.add(box(s * 0.94, 0.12, s * 0.94, dark, 0, -0.16, 0));                // abgesenkter Grabenboden
      g.add(box(s * 0.98, 0.46, 0.16, dark, 0, 0.0, s * 0.43));               // Erdböschung vorn
      g.add(box(s * 0.98, 0.46, 0.16, dark, 0, 0.0, -s * 0.43));              // Erdböschung hinten
      g.add(box(0.16, 0.46, s * 0.72, dark, s * 0.43, 0.0, 0));               // Erdböschung rechts
      g.add(box(0.16, 0.46, s * 0.72, dark, -s * 0.43, 0.0, 0));              // Erdböschung links
      for (let i = 0; i < 5; i++) {
        const sxp = -s * 0.36 + i * s * 0.18;
        for (const sz of [s * 0.44, -s * 0.44]) {
          g.add(box(s * 0.17, 0.2, 0.24, roof, sxp, 0.3, sz, (i % 2) * 0.1)); // untere Sandsacklage
          if (i % 2 === 0) g.add(box(s * 0.15, 0.18, 0.2, roof, sxp + s * 0.09, 0.5, sz)); // versetzte 2. Lage
        }
      }
      g.add(box(0.28, 0.2, 0.26, hazard, 0, 0.5, s * 0.44));                  // markierter Feuertritt
      for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        g.add(cyl(0.05, 0.06, 0.74, metal, sx * s * 0.4, 0.18, sz * s * 0.4, 6)); // Stützpfosten
      }
      break;
    }
    default:
      return null; // unbekannt → generischer Kasten im Renderer
  }
  return g;
}
