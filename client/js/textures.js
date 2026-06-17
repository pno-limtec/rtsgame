// Prozedurale Texturen per Canvas (CC0/eigenerstellt, keine Downloads). Liefert THREE.CanvasTexture.
import * as THREE from 'three';

// Wert-Rausch-Helfer: deterministisches, gefiltertes Rauschen (mehrere Oktaven).
function fbm(x, y, seed) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) {
    const n = Math.sin((x * f + seed) * 12.9898 + (y * f) * 78.233) * 43758.5453;
    v += (n - Math.floor(n)) * amp;
    amp *= 0.5; f *= 2.1;
  }
  return v;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Gelände-Detailtextur: körniger Boden mit feinem Grün/Braun-Sprenkel. Wird mit den Vertex-Farben
// multipliziert (Lambert map * vertexColors), gibt der großen Fläche Struktur statt Plastiklook.
export function groundTexture(size = 256) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = fbm(x / size * 6, y / size * 6, 11);
    const grain = (Math.random() * 0.12);
    const l = 0.72 + n * 0.4 + grain;       // Helligkeit um ~1.0 → moduliert die Vertex-Farbe
    const i = (y * size + x) * 4;
    img.data[i] = 235 * l; img.data[i + 1] = 240 * l; img.data[i + 2] = 225 * l; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.anisotropy = 4;
  return t;
}

// Einheiten-/Gebäude-Textur: gebürstetes Metall mit dezenten Panel-Linien und Kratzern.
// baseColor (hex) tönt das Metall; gemeinsam genutzt über Materialinstanzen je Farbe.
export function panelTexture(baseColor = 0x8899aa, size = 128) {
  const col = new THREE.Color(baseColor);
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // horizontale Bürstung + feines Rauschen
    const brush = Math.sin(y * 0.9) * 0.04 + fbm(x / size * 10, y / size * 3, 5) * 0.25;
    let l = 0.82 + brush + (Math.random() * 0.06);
    // Panel-Fugen alle ~32 px
    if (x % 32 === 0 || y % 32 === 0) l *= 0.7;
    const i = (y * size + x) * 4;
    img.data[i] = col.r * 255 * l; img.data[i + 1] = col.g * 255 * l; img.data[i + 2] = col.b * 255 * l; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 2;
  return t;
}

// Weicher radialer Alpha-Sprite (Rauchwolke / Funken-Glow) für Partikel.
export function puffTexture(size = 64) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export function cloudReflectionTexture(size = 256) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n1 = fbm(x / size * 2.4, y / size * 2.0, 101);
    const n2 = fbm(x / size * 6.0 + 0.31, y / size * 5.0 - 0.17, 107);
    const cloud = Math.max(0, Math.min(1, (n1 * 0.82 + n2 * 0.34 - 0.38) * 1.55));
    const veil = Math.max(0, Math.min(1, cloud * cloud * (3 - 2 * cloud)));
    const i = (y * size + x) * 4;
    img.data[i] = 138 + veil * 96;
    img.data[i + 1] = 166 + veil * 72;
    img.data[i + 2] = 190 + veil * 56;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.4, 2.4);
  t.anisotropy = 2;
  return t;
}

export function meadowTexture(size = 128) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x / (size - 1)) * 2 - 1, ny = (y / (size - 1)) * 2 - 1;
    const r = Math.hypot(nx * 0.92, ny * 1.08);
    const edge = 0.86 + (fbm(x / size * 3.2, y / size * 3.2, 37) - 0.5) * 0.22;
    const fade = Math.max(0, Math.min(1, (edge - r) / 0.22));
    const n = fbm(x / size * 8, y / size * 8, 41);
    const straw = fbm(x / size * 15, y / size * 5, 43);
    const l = 0.72 + n * 0.35 + straw * 0.12;
    const i = (y * size + x) * 4;
    img.data[i] = 72 * l;
    img.data[i + 1] = 118 * l;
    img.data[i + 2] = 55 * l;
    img.data[i + 3] = Math.round(185 * fade * fade);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 2;
  return t;
}
