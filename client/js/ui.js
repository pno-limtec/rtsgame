// UI: Ressourcen-HUD, Bauleiste, Produktionsmenü, Minimap, Auswahlpanel, Warnungen, Lobby.
// Die „goldene" Credits-Ressource ist Geschichte: ERZ ist die Hauptressource (Bagger → Raffinerie).
const RES_ICONS = { ore: 'ore', energy: 'energy', oil: 'oil', fuel: 'fuel', ammo: 'ammo', materials: 'materials', water: 'water' };
const RES_ORDER = ['ore', 'materials', 'water', 'oil', 'fuel'];
const RES_COLOR = {
  ore: '#ffcf5a',
  materials: '#cfa277',
  water: '#42d7ff',
  oil: '#b58cff',
  fuel: '#ff8f3d',
  ammo: '#ff6464',
  energy: '#ffe66a',
};
const RES_TIP = {
  ore: 'Erz (Bagger baut es ab, LKW bringt Erzhaufen ins Lager)',
  materials: 'Erde/Baumateriallager',
  water: 'Wasser (nur per Pipeline vom Pumpwerk zum Wasserturm)',
  oil: 'Öl (nur per Pipeline vom Bohrturm zum Öldepot)',
  fuel: 'Treibstoff',
  ammo: 'Munition',
};
const BUILD_ICONS = {
  power_plant: 'gear', solar_plant: 'sun', water_pump: 'water', pipe: 'pipe', refinery: 'refinery',
  oil_derrick: 'oil', barracks: 'barracks', factory: 'factory', airbase: 'air', shipyard: 'ship',
  depot: 'depot', ore_depot: 'ore', material_depot: 'materials', water_tower: 'tower', oil_depot: 'tank',
  mg_turret: 'target', turret: 'target', flak_turret: 'missile', sam_site: 'missile', sonar: 'sonar', spotlight: 'spotlight', road: 'road', bridge: 'bridge', tunnel: 'tunnel',
  wall: 'wall', trench: 'trench', dam: 'dam',
};
const UNIT_ICONS = {
  engineer: 'tools', builder: 'builder', rifleman: 'infantry', at_soldier: 'rocket', aa_soldier: 'missile', scout: 'scout', tank: 'tank',
  artillery: 'artillery', rocket_launcher: 'missile', flak_track: 'missile', harvester: 'ore', truck: 'truck', recon_drone: 'drone',
  gunship: 'gunship', bomber: 'bomber', cloud_seeder: 'rain', transport_air: 'air', patrol_boat: 'boat', destroyer: 'ship',
  submarine: 'submarine', underwater_drone: 'submarine', amphib_transport: 'amphib', sea_builder: 'ship', tractor: 'tractor',
};
const BUILDER_ROLES = [
  ['ore', 'ore', 'Erz', 'Erzabtransport: Bagger legt Erz am Abbauort auf Haufen; LKWs bringen es ins Erzlager.'],
  ['earth', 'down', 'Erde', 'Erdarbeiten: Bagger bevorzugt Abgrabungen, Gräben und Aufschütt-Arbeit.'],
  ['build', 'builder', 'Bauen', 'Bauarbeiter: Bagger bevorzugt Baustellen und Gebäudeaufbau.'],
];
const BUILDER_ROLE_LABEL = { ore: 'Erz', earth: 'Erde', build: 'Bauen', materials: 'Bauen' };
// LKW-Transportmodus: Auto (beides), nur Erz, nur Baumaterial.
const TRUCK_ROLES = [
  ['auto', 'truck', 'Auto', 'Automatik: holt den nächsten Erz- ODER Erdhaufen.'],
  ['ore', 'ore', 'Erz', 'Nur Erz: holt ausschließlich Erzhaufen ins Erzlager.'],
  ['materials', 'down', 'Material', 'Nur Baumaterial: holt ausschließlich Erdhaufen ins Baumateriallager.'],
];
const WEATHER_ICON = { clear: 'sun', rain: 'rain', storm: 'storm', fog: 'fog', drought: 'sun', night: 'moon' };
const WEATHER_LABEL = { clear: 'klar', rain: 'Regen', storm: 'Gewitter', fog: 'Nebel', drought: 'Trockenheit' };
const SPECTATOR_SPEEDS = [1, 2, 4, 8];
const SPECTATOR_TIME_MODES = ['auto', 'day', 'night'];
const SPECTATOR_TIME_LABEL = { auto: 'Auto', day: 'Tag', night: 'Nacht' };
const SPECTATOR_TIME_ICON = { auto: 'clock', day: 'sun', night: 'moon' };
const SPECTATOR_TABS = [
  ['control', 'Sicht/Sim', 'eye'],
  ['events', 'Events', 'storm'],
];
const SPECTATOR_EVENT_META = {
  rain: ['rain', 'Regen'],
  drought: ['sun', 'Dürre'],
  landslide: ['down', 'Rutsch'],
  quake: ['quake', 'Beben'],
  storm: ['storm', 'Sturm'],
  fog: ['fog', 'Nebel'],
};
const BUILD_TABS = [
  ['terrain', 'Gelände&Straße', 'road'],
  ['buildings', 'Gebäude', 'factory'],
  ['units', 'Einheiten', 'infantry'],
];
const BUILD_TERRAIN_KINDS = ['road', 'bridge', 'tunnel', 'wall', 'dam'];
const BUILDING_GROUPS = [
  ['Versorgung', ['power_plant', 'solar_plant', 'water_pump', 'pipe', 'refinery', 'oil_derrick']],
  ['Lager & Logistik', ['ore_depot', 'material_depot', 'water_tower', 'oil_depot', 'depot']],
  ['Produktion', ['barracks', 'factory', 'airbase', 'shipyard']],
  ['Verteidigung', ['mg_turret', 'turret', 'flak_turret', 'sam_site', 'sonar', 'spotlight']],
];
const BUILDING_KINDS = BUILDING_GROUPS.flatMap(([, kinds]) => kinds);
const TECH_TREE_GROUPS = [
  ['Gebäude', [
    ['Basis', ['hq']],
    ['Energie & Rohstoffe', ['power_plant', 'solar_plant', 'water_pump', 'pipe', 'water_tower', 'oil_derrick', 'oil_depot', 'refinery']],
    ['Lager & Logistik', ['ore_depot', 'material_depot', 'depot']],
    ['Produktion', ['barracks', 'factory', 'airbase', 'shipyard']],
    ['Verteidigung', ['mg_turret', 'turret', 'flak_turret', 'sam_site', 'sonar', 'spotlight']],
    ['Wege & Gelände', ['road', 'bridge', 'tunnel', 'wall', 'dam']],
  ]],
  ['Einheiten', [
    ['Infanterie', ['engineer', 'rifleman', 'at_soldier', 'aa_soldier']],
    ['Fahrzeuge', ['builder', 'truck', 'tractor', 'scout', 'tank', 'flak_track', 'rocket_launcher', 'artillery']],
    ['Luft', ['recon_drone', 'gunship', 'bomber', 'cloud_seeder', 'transport_air']],
    ['Marine', ['patrol_boat', 'destroyer', 'submarine', 'underwater_drone', 'amphib_transport', 'sea_builder']],
  ]],
];
const RESOURCE_LABEL = { ore: 'Erz', materials: 'Baumaterial', water: 'Wasser', oil: 'Öl', fuel: 'Treibstoff', ammo: 'Munition', energy: 'Energie' };
const DOMAIN_LABEL = { land: 'Boden', water: 'Wasser', air: 'Luft', amphibious: 'Amphibisch' };
const CATEGORY_LABEL = { infantry: 'Infanterie', vehicle: 'Fahrzeug', air: 'Luft', naval: 'Marine' };
const ROLE_LABEL = {
  command: 'Kommando', economy: 'Wirtschaft', logistics: 'Logistik', production: 'Produktion',
  defense: 'Verteidigung', infrastructure: 'Infrastruktur', fortification: 'Befestigung',
  hydro: 'Wasserbau', terrain: 'Gelände',
};
const TARGET_LABEL = { infantry: 'Infanterie', vehicle: 'Fahrzeuge', building: 'Gebäude', air: 'Luftziele', naval: 'Marineziele' };
const ABILITY_LABEL = {
  construct: 'Gebäude bauen', repair: 'Reparieren', excavate: 'Erdarbeiten', harvest: 'Erz abholen',
  haul: 'Haufen transportieren', tow: 'Bergen/Abschleppen', capture: 'Erobern', transport: 'Transportieren',
  hydro: 'Wasserbau unterstützen',
};

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m${r ? ` ${r}s` : ''}` : `${r}s`;
}

function fmtSeconds(sec) {
  return `${Math.max(0, Math.round(sec || 0))}s`;
}

function normalizeInsanity(value, fallback = 2) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return Math.max(1, Math.min(4, Math.round(Number(fallback) || 2)));
  return Math.max(1, Math.min(4, n));
}

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function iconSvg(name, cls = '') {
  const cn = `svgicon ${cls}`.trim();
  const p = (body, vb = '0 0 24 24') => `<svg class="${cn}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  switch (name) {
    case 'ore': return p(`<circle cx="12" cy="12" r="7" ${stroke}/><path d="M9 12h6M12 8v8" ${stroke}/>`);
    case 'energy': return p(`<path d="M13 2 5 14h6l-1 8 9-13h-6l0-7Z" fill="currentColor"/>`);
    case 'ore': return p(`<path d="M12 3 21 12 12 21 3 12Z" fill="currentColor"/><path d="M8 12h8" ${stroke}/>`);
    case 'materials': return p(`<path d="M4 8h16v10H4Z" ${stroke}/><path d="M7 8l2-3h6l2 3M8 12h8M8 15h8" ${stroke}/>`);
    case 'water': return p(`<path d="M12 3c4 5 6 8 6 12a6 6 0 0 1-12 0c0-4 2-7 6-12Z" fill="currentColor"/>`);
    case 'oil': return p(`<path d="M8 4h8l1 4v11H7V8Z" ${stroke}/><path d="M9 8h6M10 12h4" ${stroke}/>`);
    case 'fuel': return p(`<path d="M6 3h9v18H6Z" ${stroke}/><path d="M9 7h3M15 8l3 3v7a2 2 0 0 0 4 0v-5l-3-3" ${stroke}/>`);
    case 'ammo': return p(`<path d="M7 20V8l3-4h4l3 4v12Z" ${stroke}/><path d="M7 16h10M10 8h4" ${stroke}/>`);
    case 'sun': return p(`<circle cx="12" cy="12" r="4" ${stroke}/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" ${stroke}/>`);
    case 'spotlight': return p(`<path d="M5 20h14M9 20l1.2-6h3.6L15 20M7 14h10l2-7H5Z" ${stroke}/><path d="M16 8h6M15 5l4-3M15 11l4 3" ${stroke}/>`);
    case 'moon': return p(`<path d="M20 15.5A8 8 0 0 1 8.5 4 7 7 0 1 0 20 15.5Z" fill="currentColor"/>`);
    case 'rain': return p(`<path d="M7 15a5 5 0 0 1 2-9 6 6 0 0 1 11 3 4 4 0 0 1-1 8H7Z" ${stroke}/><path d="M8 20l1-2M13 21l1-3M18 20l1-2" ${stroke}/>`);
    case 'storm': return p(`<path d="M7 14a5 5 0 0 1 2-9 6 6 0 0 1 11 3 4 4 0 0 1-1 8H7Z" ${stroke}/><path d="m12 14-2 5h3l-1 3 5-7h-3l1-1Z" fill="currentColor"/>`);
    case 'fog': return p(`<path d="M4 9h16M2 13h18M5 17h16" ${stroke}/>`);
    case 'eye': return p(`<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" ${stroke}/><circle cx="12" cy="12" r="3" ${stroke}/>`);
    case 'speed': return p(`<path d="M5 19a9 9 0 1 1 14 0" ${stroke}/><path d="m12 13 5-5M7 17h10" ${stroke}/>`);
    case 'clock': return p(`<circle cx="12" cy="12" r="8" ${stroke}/><path d="M12 7v5l3 2" ${stroke}/>`);
    case 'flag': return p(`<path d="M5 21V4M6 4h11l-2 4 2 4H6" ${stroke}/>`);
    case 'quake': return p(`<path d="M3 15h4l2-5 4 8 2-5h6M4 20h16" ${stroke}/>`);
    case 'gear': return p(`<circle cx="12" cy="12" r="3" ${stroke}/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1" ${stroke}/>`);
    case 'pipe': return p(`<path d="M3 10h12a4 4 0 0 1 4 4v5M3 14h12M19 19h-4" ${stroke}/>`);
    case 'refinery': return p(`<path d="M5 21V8l7-4 7 4v13M8 21v-7h8v7M9 8h6" ${stroke}/>`);
    case 'barracks': return p(`<path d="M4 20V8l8-5 8 5v12M8 20v-7h8v7" ${stroke}/>`);
    case 'factory': return p(`<path d="M3 21V9l5 4V9l5 4V7h8v14Z" ${stroke}/><path d="M7 17h3M13 17h3" ${stroke}/>`);
    case 'air': return p(`<path d="M12 3 15 21 12 18 9 21Z" fill="currentColor"/><path d="M4 13h16L12 9Z" fill="currentColor"/>`);
    case 'ship': return p(`<path d="M4 14h16l-3 6H7Z" ${stroke}/><path d="M8 14V8h7l2 6" ${stroke}/>`);
    case 'depot': return p(`<path d="M4 8h16v12H4Z" ${stroke}/><path d="M7 8l5-4 5 4M8 13h8M8 16h8" ${stroke}/>`);
    case 'tower': return p(`<path d="M8 21h8M10 21l2-13 2 13M8 8h8l1-4H7Z" ${stroke}/>`);
    case 'tank': return p(`<path d="M6 7h12v10H6ZM4 17h16M9 7l2-3h4l2 3" ${stroke}/>`);
    case 'target': return p(`<circle cx="12" cy="12" r="7" ${stroke}/><circle cx="12" cy="12" r="2" ${stroke}/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" ${stroke}/>`);
    case 'missile': return p(`<path d="M13 3c4 2 6 5 6 9l-7 7c-4 0-7-2-9-6Z" ${stroke}/><path d="m8 16-4 4M15 6l3 3" ${stroke}/>`);
    case 'sonar': return p(`<circle cx="12" cy="12" r="2" ${stroke}/><path d="M7 12a5 5 0 0 1 5-5M4 12a8 8 0 0 1 8-8M17 12a5 5 0 0 1-5 5M20 12a8 8 0 0 1-8 8" ${stroke}/>`);
    case 'road': return p(`<path d="M8 22 11 2M16 22 13 2M12 5v3M12 12v3M12 19v2" ${stroke}/>`);
    case 'bridge': return p(`<path d="M3 16h18M5 16c2-6 12-6 14 0M7 11v5M12 9v7M17 11v5" ${stroke}/>`);
    case 'tunnel': return p(`<path d="M4 20v-7a8 8 0 0 1 16 0v7M8 20v-7a4 4 0 0 1 8 0v7" ${stroke}/>`);
    case 'wall': return p(`<path d="M4 18h16v3H4ZM6 14h12v4H6ZM8 10h8v4H8Z" fill="currentColor"/>`);
    case 'trench': return p(`<path d="M4 15c4-3 12-3 16 0v5H4Z" ${stroke}/><path d="M7 18h10" ${stroke}/>`);
    case 'dam': return p(`<path d="M7 21 11 3h6l-4 18Z" ${stroke}/><path d="M3 14h5M16 14h5" ${stroke}/>`);
    case 'tools': return p(`<path d="m4 20 7-7M14 6l4-4 4 4-4 4ZM10 4l10 10-4 4L6 8Z" ${stroke}/>`);
    case 'builder': return p(`<path d="M4 16h12l4 4H5Z" ${stroke}/><path d="M7 16V9h6v7M13 10l5-5" ${stroke}/>`);
    case 'infantry': return p(`<circle cx="12" cy="5" r="2" ${stroke}/><path d="M12 7v7M8 21l4-7 4 7M8 11h8" ${stroke}/>`);
    case 'rocket': return p(`<path d="M5 15 16 4l4 4L9 19H5Z" ${stroke}/><path d="m14 6 4 4" ${stroke}/>`);
    case 'scout': return p(`<path d="M5 15h14l-2 4H7Z" ${stroke}/><path d="M8 15l2-5h4l2 5M8 19h0M16 19h0" ${stroke}/>`);
    case 'artillery': return p(`<path d="M4 18h10M10 18l8-8M15 8l4 4M7 18v3M14 18v3" ${stroke}/>`);
    case 'truck': return p(`<path d="M3 15V8h10v7M13 11h4l4 4v4h-3M6 19h9" ${stroke}/><circle cx="7" cy="19" r="2" ${stroke}/><circle cx="17" cy="19" r="2" ${stroke}/>`);
    case 'tractor': return p(`<path d="M5 16h10l3-5h3v8H5Z" ${stroke}/><path d="M8 16V9h5v7M15 13l4 4" ${stroke}/><circle cx="8" cy="19" r="3" ${stroke}/><circle cx="18" cy="19" r="2" ${stroke}/>`);
    case 'drone': return p(`<circle cx="12" cy="12" r="3" ${stroke}/><path d="M6 6l4 4M18 6l-4 4M6 18l4-4M18 18l-4-4" ${stroke}/><circle cx="5" cy="5" r="2" ${stroke}/><circle cx="19" cy="5" r="2" ${stroke}/><circle cx="5" cy="19" r="2" ${stroke}/><circle cx="19" cy="19" r="2" ${stroke}/>`);
    case 'gunship': return p(`<path d="M4 13h14l3-3M7 13l3 5h5l-2-5M9 10h7" ${stroke}/>`);
    case 'bomber': return p(`<path d="M12 3 15 21 12 18 9 21Z" ${stroke}/><path d="M3 13h18L12 8Z" ${stroke}/>`);
    case 'rain': return p(`<path d="M7 10a5 5 0 0 1 9-3 4 4 0 0 1 1 8H7a4 4 0 0 1 0-8" ${stroke}/><path d="M8 18v3M12 17v3M16 18v3" ${stroke}/>`);
    case 'boat': return p(`<path d="M4 15h16l-3 5H7Z" ${stroke}/><path d="M12 4v11M8 9h8" ${stroke}/>`);
    case 'submarine': return p(`<path d="M4 15c3-5 13-5 16 0-3 5-13 5-16 0Z" ${stroke}/><path d="M11 10V6h4v4" ${stroke}/>`);
    case 'amphib': return p(`<path d="M4 14h16l-3 5H7Z" ${stroke}/><path d="M8 14V8h8v6M6 20c2-1 4-1 6 0s4 1 6 0" ${stroke}/>`);
    case 'up': return p(`<path d="M12 4 4 14h5v6h6v-6h5Z" fill="currentColor"/>`);
    case 'down': return p(`<path d="M12 20 4 10h5V4h6v6h5Z" fill="currentColor"/>`);
    default: return p(`<path d="M5 5h14v14H5Z" ${stroke}/>`);
  }
}

function resIcon(resource, cls = 'ricon') {
  const color = RES_COLOR[resource] || '#eaf6ff';
  return iconSvg(RES_ICONS[resource] || 'ore', cls).replace('<svg ', `<svg style="color:${color}" `);
}

function techObjectText(obj) {
  const parts = Object.entries(obj || {}).filter(([, v]) => v).map(([k, v]) => `${v} ${RESOURCE_LABEL[k] || k}`);
  return parts.length ? parts.join(', ') : 'keine';
}

function techCostHtml(cost) {
  const parts = RES_ORDER.filter(k => cost?.[k])
    .map(k => `<span class="costitem" style="color:${RES_COLOR[k] || '#eaf6ff'}">${resIcon(k, 'costicon')}${escAttr(cost[k])}</span>`);
  return parts.length ? parts.join(' ') : `<span class="costitem" style="color:${RES_COLOR.ore}">${resIcon('ore', 'costicon')}0</span>`;
}

function techProducedBy(data, kind, def) {
  const out = [];
  for (const [bkind, bdef] of Object.entries(data.buildings || {})) {
    if ((bdef.produces_units || []).includes(kind) || (bdef.produces_category && bdef.produces_category === def.category)) {
      out.push(data.buildings[bkind].label || bkind);
    }
  }
  return out;
}

function techProducedUnits(data, bdef) {
  const units = [];
  for (const [kind, def] of Object.entries(data.units || {})) {
    if (def.hidden) continue;
    if ((bdef.produces_units || []).includes(kind) || (bdef.produces_category && bdef.produces_category === def.category)) {
      units.push(def.label || kind);
    }
  }
  return units;
}

function techWeapon(data, def) {
  return def.weapon && data.weapons ? data.weapons[def.weapon] : null;
}

function techTargets(weapon, predicate) {
  return Object.entries(weapon?.vs || {})
    .filter(([, mult]) => predicate(mult))
    .sort((a, b) => b[1] - a[1])
    .map(([target, mult]) => `${TARGET_LABEL[target] || target} (${mult.toFixed(1)}x)`);
}

function uniqueLimited(items, limit = 5) {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function techStrengths(type, def, weapon, data) {
  const out = [];
  const strong = techTargets(weapon, mult => mult >= 1.1);
  if (strong.length) out.push(`Stark gegen ${strong.join(', ')}.`);
  if (weapon?.range >= 12) out.push(`Hohe Reichweite (${weapon.range}).`);
  if (weapon?.splash) out.push(`Flächenschaden mit Radius ${weapon.splash}.`);
  if (type === 'unit') {
    const abilities = (def.abilities || []).map(a => ABILITY_LABEL[a] || a);
    if (abilities.length) out.push(`Spezialaufgaben: ${abilities.join(', ')}.`);
    if (def.speed >= 5.5) out.push('Sehr schnell und gut für Aufklärung, Flanken oder Reaktion.');
    if (def.sight >= 12) out.push('Große Sichtweite für Frühwarnung und Zielaufklärung.');
    if (def.hp >= 400) out.push('Hohe Haltbarkeit an der Front.');
    if (def.submerged) out.push('Getaucht schwer zu entdecken; Sonar ist der wichtigste Konter.');
    if (def.capacity) out.push(`Transportiert bis zu ${def.capacity} Einheiten.`);
  } else {
    const produced = techProducedUnits(data, def);
    if (produced.length) out.push(`Schaltet Produktion frei: ${produced.join(', ')}.`);
    if (def.power > 0) out.push(`Erzeugt ${def.power} Energie.`);
    if (def.storage || def.integratedStorage) out.push(`Lagerkapazität: ${techObjectText(def.storage || def.integratedStorage)}.`);
    if (def.resourceDepot) out.push(`Annahmestelle für ${RESOURCE_LABEL[def.resourceDepot] || def.resourceDepot}.`);
    if (def.remoteBuild) out.push('Kann als Außenposten ohne nahen Bauradius begonnen werden.');
    if (def.cover) out.push(`Gibt Deckung (${Math.round(def.cover * 100)}%).`);
    if (def.waterBlocks) out.push('Blockiert und lenkt Wasserströme.');
    if (def.sonarRange) out.push(`Deckt getauchte Ziele im Radius ${def.sonarRange} auf.`);
  }
  return uniqueLimited(out.length ? out : ['Solide Standardoption, wenn ihre Rolle zur Lage passt.']);
}

function techWeaknesses(type, def, weapon) {
  const out = [];
  const weak = techTargets(weapon, mult => mult <= 0.35);
  if (weak.length) out.push(`Kaum Wirkung gegen ${weak.join(', ')}.`);
  if (!weapon && type === 'unit' && !(def.abilities || []).includes('transport')) out.push('Unbewaffnet und auf Begleitschutz angewiesen.');
  if (!weapon && type === 'building' && def.role !== 'defense') out.push('Wehrlos, deshalb auf Mauern, Türme oder mobile Einheiten angewiesen.');
  if (type === 'unit') {
    if (def.category === 'infantry') out.push('Verwundbar gegen MG-Feuer, Artillerie und Flächenschaden.');
    if (def.heavy) out.push('Schwer: meidet Wasser, Matsch und steile Hänge ohne Straßen.');
    if (def.domain === 'air') out.push('Braucht Treibstoff und ist anfällig gegen Flak/SAM.');
    if (def.domain === 'water') out.push('An Wasser gebunden und bei Sonar/Flak-Begleitung besser konterbar.');
    if (def.muni) out.push('Muss Munition an der Luftbasis nachladen.');
    if (weapon?.minRange) out.push(`Mindestreichweite ${weapon.minRange}: schlecht im Nahkampf.`);
  } else {
    if (def.power < 0) out.push(`Verbraucht ${Math.abs(def.power)} Energie.`);
    if (def.burnsFuel) out.push('Leistung hängt von Öl/Treibstoff und Wasser ab.');
    if (def.solar) out.push('Schwach bei Nacht, Regen und Sturm.');
    if (def.requiresWater || def.mustStandInWater) out.push('Muss am oder im Wasser platziert werden.');
    if (def.requiresOil) out.push('Muss auf einem Ölfeld stehen.');
    if (def.pipelineResource) out.push('Fördert erst zuverlässig mit Pipeline zum passenden Lager.');
    if (def.role === 'production') out.push('Hohes Zielprofil: Verlust stoppt neue Einheiten dieser Klasse.');
  }
  return uniqueLimited(out.length ? out : ['Keine harte Schwäche, aber falsche Positionierung oder fehlender Schutz machen sie verwundbar.']);
}

function techStatRows(type, def, weapon) {
  const rows = [
    ['HP', def.hp ?? '-'],
    ['Kosten', techObjectText(def.cost)],
    ['Bauzeit', def.buildTime != null ? fmtDuration(def.buildTime) : '-'],
    ['Sicht', def.sight ?? '-'],
  ];
  if (type === 'unit') {
    rows.push(['Tempo', def.speed ?? '-']);
    rows.push(['Typ', `${CATEGORY_LABEL[def.category] || def.category || '-'} · ${DOMAIN_LABEL[def.domain] || def.domain || '-'}`]);
    rows.push(['Rüstung', def.armor || '-']);
    if (def.upkeep) rows.push(['Unterhalt', techObjectText(def.upkeep)]);
  } else {
    rows.push(['Rolle', ROLE_LABEL[def.role] || def.role || '-']);
    rows.push(['Größe', def.size ?? '-']);
    rows.push(['Energie', def.power ? `${def.power > 0 ? '+' : ''}${def.power}` : '0']);
    if (def.storage || def.integratedStorage) rows.push(['Lager', techObjectText(def.storage || def.integratedStorage)]);
  }
  if (weapon) {
    rows.push(['Waffe', `${weapon.damage} Schaden · R${weapon.range}`]);
    rows.push(['Feuerrate', `${weapon.cooldown}s${weapon.ammo ? ` · ${weapon.ammo} Mun.` : ''}`]);
  }
  return rows.slice(0, 10);
}

export class UI {
  constructor(net, input, data) {
    this.net = net; this.input = input; this.data = data;
    this.techSelected = { type: 'building', kind: 'hq' };
    this.techTreeOpen = false;
    try { this.helpOpen = localStorage.getItem('if_help_open') === '1'; } catch { this.helpOpen = false; }
    this.previewRenderer = null;
    this.warnEl = document.getElementById('warn');
    this.helpPanel = document.getElementById('helppanel');
    this.lastWarn = {};
    this.selPanel = document.getElementById('selpanel');
    this.scoreboard = document.getElementById('scoreboard');
    this.joinCodeHud = document.getElementById('joincodehud');
    this.minimap = document.getElementById('minimap');
    this.mctx = this.minimap.getContext('2d');
    input.onSelectionChange = () => this.renderSelection();
    input.onBuildPlaced = () => this.renderBuildbar();
  }

  setupLobby(onJoin) {
    const lobby = document.getElementById('lobby');
    const sel = document.getElementById('seatsel');
    const list = document.getElementById('seatlist');
    const status = document.getElementById('lobbystatus');
    const gameList = document.getElementById('gamelist');
    const setStatus = (text) => { if (status) status.textContent = text || ''; };
    const lobbyOptions = () => ({
      fow: !!document.getElementById('fowstart')?.checked,
      timeMode: document.getElementById('daynightstart')?.checked === false ? 'day' : 'auto',
      insanity: normalizeInsanity(document.getElementById('insanitystart')?.value, this.net.controls?.insanity),
    });
    const setTab = (tab) => {
      for (const btn of document.querySelectorAll('[data-lobbytab]')) {
        const active = btn.dataset.lobbytab === tab;
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const panel of document.querySelectorAll('[data-lobbypanel]')) panel.hidden = panel.dataset.lobbypanel !== tab;
      if (tab === 'join') this.net.requestGameList();
      setStatus('');
    };
    for (const btn of document.querySelectorAll('[data-lobbytab]')) btn.onclick = () => setTab(btn.dataset.lobbytab);
    for (const btn of document.querySelectorAll('[data-startmode]')) {
      btn.onclick = () => {
        for (const other of document.querySelectorAll('[data-startmode]')) other.setAttribute('aria-pressed', other === btn ? 'true' : 'false');
      };
    }
    const renderGames = (games = this.net.games || []) => {
      if (!gameList) return;
      if (!games.length) {
        gameList.innerHTML = '<div class="gamerow"><span>Keine öffentlichen Spiele gefunden</span><button type="button" data-refresh-games>Aktualisieren</button></div>';
      } else {
        gameList.innerHTML = games.slice(0, 50).map(g => {
          const free = Math.max(0, Number(g.free) || 0);
          const players = Math.max(0, Number(g.players) || 0);
          const label = g.running ? 'läuft' : 'wartet';
          return `<div class="gamerow" data-roomid="${escAttr(g.id)}">
            <span><b>${players} Spieler</b><span class="gmeta"> · ${free} freie KI-Slots · ${label}</span></span>
            <button type="button" data-join-room="${escAttr(g.id)}">Beitreten</button>
          </div>`;
        }).join('');
      }
      gameList.querySelector('[data-refresh-games]')?.addEventListener('click', () => this.net.requestGameList());
      for (const btn of gameList.querySelectorAll('[data-join-room]')) {
        btn.onclick = () => {
          const name = document.getElementById('pname').value || 'Spieler';
          onJoin(name, null, { roomId: btn.dataset.joinRoom, ...lobbyOptions() });
          setStatus('Spiel wird betreten...');
        };
      }
    };
    const render = () => {
      sel.innerHTML = ''; list.innerHTML = '';
      for (const p of this.net.players) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `Sitz ${p.id + 1} — ${this.data.factions[p.faction].label} (${p.controller === 'ai' ? 'KI – übernehmbar' : p.name})`;
        if (p.controller !== 'ai' && !p.defeated) opt.disabled = true;
        sel.appendChild(opt);
        const row = document.createElement('div'); row.className = 'seat';
        row.innerHTML = `<span>Sitz ${p.id + 1} · ${this.data.factions[p.faction].label}</span><span style="color:${p.color}">${p.controller === 'ai' ? 'KI' : p.name}</span>`;
        list.appendChild(row);
      }
    };
    render();
    renderGames();
    this.net.on('lobby', render);
    this.net.on('init', render);
    this.net.on('gameList', renderGames);
    this.net.on('joinDenied', (m) => setStatus(m.message || 'Beitritt nicht möglich'));
    this.net.on('roomInfo', (room) => {
      if (room?.code) setStatus(`Privates Spiel erstellt: ${room.code}`);
    });
    document.getElementById('joinbtn').onclick = () => {
      const name = document.getElementById('pname').value || 'Spieler';
      const seat = parseInt(sel.value, 10);
      onJoin(name, seat, lobbyOptions());
    };
    document.getElementById('watchbtn').onclick = () => {
      const seat = parseInt(sel.value, 10);
      onJoin('Zuschauer', Number.isFinite(seat) ? seat : 0, { ...lobbyOptions(), spectator: true });
    };
    document.getElementById('joincodebtn')?.addEventListener('click', () => {
      const code = String(document.getElementById('joincode')?.value || '').trim().toUpperCase();
      if (!code) { setStatus('Code eingeben'); return; }
      const name = document.getElementById('pname').value || 'Spieler';
      onJoin(name, null, { code, ...lobbyOptions() });
      setStatus('Privates Spiel wird gesucht...');
    });
    document.getElementById('creategamebtn')?.addEventListener('click', () => {
      const name = document.getElementById('pname').value || 'Spieler';
      const startMode = document.querySelector('[data-startmode][aria-pressed="true"]')?.dataset.startmode || 'instant';
      onJoin(name, null, {
        ...lobbyOptions(),
        create: true,
        visibility: document.getElementById('visibilitystart')?.value || 'public',
        slots: parseInt(document.getElementById('slotstart')?.value || '2', 10),
        startMode,
      });
      setStatus('Spiel wird erstellt...');
    });
    this.net.on('joined', (m) => { if (m.ok) lobby.style.display = 'none'; });
    setTab('join');
  }

  setupMenu(renderer, audio = null) {
    this.previewRenderer = renderer || null;
    this.audio = audio || this.audio || null;
    if (renderer) {
      const previousReady = renderer.onModelPreviewsReady;
      renderer.onModelPreviewsReady = (kinds) => {
        previousReady?.(kinds);
        this._bbHtml = null;
        this.renderBuildbar();
        if (this.techTreeOpen) this.renderTechTree();
      };
    }
    const btn = document.getElementById('menubtn');
    const menu = document.getElementById('gamemenu');
    const status = document.getElementById('menustatus');
    const loadInput = document.getElementById('loadsavefile');
    if (!btn || !menu) return;

    const setStatus = (text) => { if (status) status.textContent = text || ''; };
    const setOpen = (open) => {
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) setStatus('');
    };
    btn.onclick = () => setOpen(!menu.classList.contains('open'));
    menu.querySelector('[data-close-menu]')?.addEventListener('click', () => setOpen(false));
    menu.addEventListener('click', (ev) => { if (ev.target === menu) setOpen(false); });
    addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && menu.classList.contains('open')) setOpen(false); });
    this.setupTechTree();

    document.getElementById('menunew')?.addEventListener('click', () => {
      this.input.selected.clear();
      this.net.newGame(false, { insanity: this.net.controls?.insanity });
      setStatus('Neues Spiel wird gestartet...');
      setOpen(false);
    });
    document.getElementById('menunewsame')?.addEventListener('click', () => {
      this.input.selected.clear();
      this.net.newGame(true, { insanity: this.net.controls?.insanity });
      setStatus('Gleiche Karte wird neu gestartet...');
      setOpen(false);
    });
    document.getElementById('menusave')?.addEventListener('click', () => {
      setStatus('Spielstand wird vorbereitet...');
      this.net.requestSave();
    });
    document.getElementById('menuload')?.addEventListener('click', () => {
      if (loadInput) {
        loadInput.value = '';
        loadInput.click();
      }
    });
    document.getElementById('menutechtree')?.addEventListener('click', () => {
      setOpen(false);
      this.openTechTree();
    });
    loadInput?.addEventListener('change', async () => {
      const file = loadInput.files?.[0];
      if (!file) return;
      try {
        const save = JSON.parse(await file.text());
        this.input.selected.clear();
        this.net.loadGame(save);
        setStatus('Spielstand wird geladen...');
        setOpen(false);
      } catch {
        setStatus('Die Datei ist kein gültiges Savegame.');
      }
    });

    const gfx = this.readGraphicsOptions();
    const shadowBox = document.getElementById('gfxshadows');
    const lightBox = document.getElementById('gfxlights');
    const waterV2Box = document.getElementById('gfxwasserv2');
    if (shadowBox) shadowBox.checked = gfx.shadows;
    if (lightBox) lightBox.checked = gfx.lights;
    if (waterV2Box) waterV2Box.checked = gfx.wasserv2;
    renderer.setGraphicsOptions?.(gfx);
    const applyGfx = () => {
      const next = {
        shadows: shadowBox ? !!shadowBox.checked : true,
        lights: lightBox ? !!lightBox.checked : true,
        wasserv2: waterV2Box ? !!waterV2Box.checked : false,
      };
      this.writeGraphicsOptions(next);
      renderer.setGraphicsOptions?.(next);
      setStatus('Grafikeinstellungen übernommen.');
    };
    shadowBox?.addEventListener('change', applyGfx);
    lightBox?.addEventListener('change', applyGfx);
    waterV2Box?.addEventListener('change', applyGfx);

    // Ton: Musik und Soundeffekte getrennt schaltbar (Einstellung wird im Audio-Modul gespeichert).
    const musicBox = document.getElementById('audiomusic');
    const sfxBox = document.getElementById('audiosfx');
    const audioMod = this.audio;
    if (musicBox) musicBox.checked = audioMod ? audioMod.musicEnabled : true;
    if (sfxBox) sfxBox.checked = audioMod ? audioMod.sfxEnabled : true;
    musicBox?.addEventListener('change', () => {
      audioMod?.setMusicEnabled(!!musicBox.checked);
      setStatus(musicBox.checked ? 'Musik eingeschaltet.' : 'Musik ausgeschaltet.');
    });
    sfxBox?.addEventListener('change', () => {
      audioMod?.setSfxEnabled(!!sfxBox.checked);
      setStatus(sfxBox.checked ? 'Soundeffekte eingeschaltet.' : 'Soundeffekte ausgeschaltet.');
    });

    this.net.on('saveGame', (m) => {
      this.downloadSave(m.save, m.filename);
      setStatus('Spielstand wurde als Download angeboten.');
    });
    this.net.on('menuError', (m) => setStatus(m.message || 'Aktion fehlgeschlagen.'));
    this.net.on('init', () => { this._bbHtml = null; this.renderSelection(); if (this.techTreeOpen) this.renderTechTree(); });
  }

  setupTechTree() {
    if (this._techBound) return;
    const overlay = document.getElementById('techtree');
    if (!overlay) return;
    this._techBound = true;
    overlay.querySelector('[data-close-tech]')?.addEventListener('click', () => this.closeTechTree());
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) this.closeTechTree(); });
    addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && overlay.classList.contains('open')) this.closeTechTree();
    });
  }

  openTechTree() {
    const overlay = document.getElementById('techtree');
    if (!overlay) return;
    this.techTreeOpen = true;
    this.techSelected = this.validTechSelection(this.techSelected);
    this.renderTechTree();
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.querySelector('[data-close-tech]')?.focus();
  }

  closeTechTree() {
    const overlay = document.getElementById('techtree');
    if (!overlay) return;
    this.techTreeOpen = false;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  validTechSelection(sel) {
    if (sel?.type === 'unit' && this.data.units?.[sel.kind]) return sel;
    if (sel?.type === 'building' && this.data.buildings?.[sel.kind] && !this.data.buildings[sel.kind].hidden) return sel;
    const firstUnit = Object.keys(this.data.units || {})[0];
    return this.data.buildings?.hq ? { type: 'building', kind: 'hq' } : { type: 'unit', kind: firstUnit };
  }

  renderTechTree() {
    const map = document.getElementById('techmap');
    if (!map) return;
    map.innerHTML = this.techTreeHtml();
    this.renderModelPreviews(map);
    this.renderTechDetail();
    map.querySelectorAll('[data-tech-type][data-tech-kind]').forEach(btn => {
      btn.onclick = () => {
        this.techSelected = { type: btn.dataset.techType, kind: btn.dataset.techKind };
        this.renderTechTree();
      };
    });
  }

  techTreeHtml() {
    return TECH_TREE_GROUPS.map(([section, lanes]) => {
      const type = section === 'Gebäude' ? 'building' : 'unit';
      const laneHtml = lanes.map(([lane, kinds]) => {
        const nodes = kinds.map(kind => this.techNodeHtml(type, kind)).filter(Boolean).join('');
        return nodes ? `<div class="techlane"><div class="techlane-title">${escAttr(lane)}</div><div class="technodes">${nodes}</div></div>` : '';
      }).filter(Boolean).join('');
      return laneHtml ? `<section class="techsection"><h3>${escAttr(section)}</h3>${laneHtml}</section>` : '';
    }).join('');
  }

  techNodeHtml(type, kind) {
    const def = type === 'unit' ? this.data.units?.[kind] : this.data.buildings?.[kind];
    if (!def || def.hidden) return '';
    const selected = this.techSelected?.type === type && this.techSelected?.kind === kind;
    const icon = type === 'unit' ? (UNIT_ICONS[kind] || 'box') : (BUILD_ICONS[kind] || 'box');
    const meta = type === 'unit'
      ? [CATEGORY_LABEL[def.category] || def.category, DOMAIN_LABEL[def.domain] || def.domain].filter(Boolean).join(' · ')
      : (ROLE_LABEL[def.role] || def.role || 'Gebäude');
    return `<button class="technode ${selected ? 'selected' : ''}" type="button" data-tech-type="${type}" data-tech-kind="${escAttr(kind)}" aria-pressed="${selected ? 'true' : 'false'}" title="${escAttr(def.desc || def.label || kind)}">`
      + `<span class="techthumb" aria-hidden="true">${this.modelPreviewHtml(type, kind, 'nodemodel')}<span class="techicon mini">${iconSvg(icon)}</span></span>`
      + `<span><span class="techlabel">${escAttr(def.label || kind)}</span><span class="techmeta">${escAttr(meta)}</span></span>`
      + `</button>`;
  }

  renderTechDetail() {
    const detail = document.getElementById('techdetail');
    if (!detail) return;
    const sel = this.validTechSelection(this.techSelected);
    this.techSelected = sel;
    const def = sel.type === 'unit' ? this.data.units?.[sel.kind] : this.data.buildings?.[sel.kind];
    if (!def) { detail.innerHTML = ''; return; }
    const weapon = techWeapon(this.data, def);
    const icon = sel.type === 'unit' ? (UNIT_ICONS[sel.kind] || 'box') : (BUILD_ICONS[sel.kind] || 'box');
    const kindLabel = sel.type === 'unit' ? 'Einheit' : 'Gebäude';
    const producers = sel.type === 'unit' ? techProducedBy(this.data, sel.kind, def) : [];
    const produced = sel.type === 'building' ? techProducedUnits(this.data, def) : [];
    const chips = [
      sel.type === 'unit' ? `${CATEGORY_LABEL[def.category] || def.category || 'Einheit'} · ${DOMAIN_LABEL[def.domain] || def.domain || '-'}` : ROLE_LABEL[def.role] || def.role,
      producers.length ? `Gebaut in: ${producers.join(', ')}` : '',
      produced.length ? `Produziert: ${produced.join(', ')}` : '',
      weapon ? `Waffe: ${def.weapon}` : '',
      def.requiresWater || def.mustStandInWater ? 'Wasserplatzierung' : '',
      def.requiresOil ? 'Ölfeld benötigt' : '',
      def.pipelineResource ? `Pipeline: ${RESOURCE_LABEL[def.pipelineResource] || def.pipelineResource}` : '',
    ].filter(Boolean);
    const stats = techStatRows(sel.type, def, weapon)
      .map(([k, v]) => `<div class="techstat"><b>${escAttr(k)}</b>${escAttr(v)}</div>`).join('');
    const strengths = techStrengths(sel.type, def, weapon, this.data).map(v => `<li>${escAttr(v)}</li>`).join('');
    const weaknesses = techWeaknesses(sel.type, def, weapon).map(v => `<li>${escAttr(v)}</li>`).join('');
    detail.innerHTML = `<div class="detailtop">`
      + `<div class="detailpreview" aria-hidden="true">${this.modelPreviewHtml(sel.type, sel.kind, 'detailmodel')}<span class="detailicon mini">${iconSvg(icon)}</span></div>`
      + `<div><div class="title">${escAttr(def.label || sel.kind)}</div><div class="kind">${kindLabel} · ${escAttr(sel.kind)}</div></div>`
      + `</div>`
      + `<div class="techchips">${chips.map(c => `<span class="techchip">${escAttr(c)}</span>`).join('')}</div>`
      + `<div class="techstats">${stats}</div>`
      + `<h3>Wofür gut</h3><p class="techpara">${escAttr(def.desc || 'Keine Beschreibung vorhanden.')}</p>`
      + `<h3>Vorteile</h3><ul class="techlist">${strengths}</ul>`
      + `<h3>Nachteile</h3><ul class="techlist">${weaknesses}</ul>`
      + `<h3>Kosten</h3><div class="techchips">${techCostHtml(def.cost)}</div>`;
    this.renderModelPreviews(detail);
  }

  modelPreviewHtml(type, kind, cls = '') {
    return `<img class="modelpreview ${escAttr(cls)}" data-preview-type="${escAttr(type)}" data-preview-kind="${escAttr(kind)}" alt="" width="96" height="76">`;
  }

  previewColor() {
    const seat = this.net.spectator ? this.net.viewSeat : this.net.seat;
    const player = this.net.players.find(p => p.id === seat) || this.net.players[0];
    return player?.color || '#36c5f0';
  }

  renderModelPreviews(root = document) {
    if (!this.previewRenderer?.modelPreviewDataUrl) return;
    const color = this.previewColor();
    for (const img of root.querySelectorAll('img[data-preview-type][data-preview-kind]')) {
      const type = img.dataset.previewType;
      const kind = img.dataset.previewKind;
      const def = type === 'unit' ? this.data.units?.[kind] : this.data.buildings?.[kind];
      if (!def) continue;
      const key = `${type}:${kind}:${color}`;
      if (img.dataset.previewKey === key && img.src) continue;
      const url = this.previewRenderer.modelPreviewDataUrl(type, kind, def, color);
      if (!url) continue;
      img.src = url;
      img.dataset.previewKey = key;
    }
  }

  readGraphicsOptions() {
    try {
      const raw = JSON.parse(localStorage.getItem('if_graphics') || '{}');
      return { shadows: raw.shadows !== false, lights: raw.lights !== false, wasserv2: raw.wasserv2 === true };
    } catch {
      return { shadows: true, lights: true, wasserv2: false };
    }
  }

  writeGraphicsOptions(opts) {
    try { localStorage.setItem('if_graphics', JSON.stringify(opts)); } catch {}
  }

  downloadSave(save, filename) {
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'faultline-command-savegame.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  renderSpectatorbar() {
    const bar = document.getElementById('spectatorbar');
    const sel = document.getElementById('viewselsel');
    if (!bar || !sel) return;
    if (!this.net.spectator) { bar.style.display = 'none'; this._spectatorSig = ''; return; }
    bar.style.display = 'flex';
    if (!SPECTATOR_TABS.some(([id]) => id === this.spectatorTab)) this.spectatorTab = 'control';
    for (const btn of bar.querySelectorAll('[data-spectab]')) {
      const tab = SPECTATOR_TABS.find(([id]) => id === btn.dataset.spectab);
      if (!tab) continue;
      const active = tab[0] === this.spectatorTab;
      btn.innerHTML = `${iconSvg(tab[2], 'tinyicon')}<span>${tab[1]}</span>`;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.onclick = () => { this.spectatorTab = tab[0]; this.renderSpectatorbar(); };
    }
    for (const panel of bar.querySelectorAll('[data-specpanel]')) panel.hidden = panel.dataset.specpanel !== this.spectatorTab;
    const cur = this.net.viewSeat;
    const sig = this.net.players.map(p => `${p.id}:${p.faction}:${p.controller}:${p.defeated ? 1 : 0}`).join('|');
    if (sig !== this._spectatorSig) {
      this._spectatorSig = sig;
      sel.innerHTML = '';
      for (const p of this.net.players) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${this.data.factions[p.faction].label}${p.defeated ? ' (besiegt)' : ''}`;
        sel.appendChild(opt);
      }
      sel.onchange = () => this.net.setViewSeat(parseInt(sel.value, 10));
    }
    if (String(sel.value) !== String(cur)) sel.value = String(cur);

    const controls = this.net.controls || {};
    const speedBtn = document.getElementById('spectatorspeed');
    const timeWrap = document.getElementById('spectatortime');
    const takeBtn = document.getElementById('spectatortakeover');
    const eventWrap = document.getElementById('spectatorevents');
    const viewed = this.net.players.find(p => p.id === cur);
    if (eventWrap) {
      eventWrap.hidden = false;
      for (const btn of eventWrap.querySelectorAll('[data-spectatorevent]')) {
        const [icon, label] = SPECTATOR_EVENT_META[btn.dataset.spectatorevent] || ['storm', btn.textContent || 'Event'];
        btn.classList.add('spec-iconbtn');
        btn.innerHTML = `${iconSvg(icon, 'tinyicon')}<span>${label}</span>`;
      }
      if (!this._spectatorEventBound) {
        this._spectatorEventBound = true;
        for (const btn of eventWrap.querySelectorAll('[data-spectatorevent]')) {
          btn.onclick = () => this.net.setSpectatorControls({ event: btn.dataset.spectatorevent });
        }
      }
    }
    if (takeBtn) {
      const canTake = !!viewed && !viewed.defeated && viewed.controller === 'ai';
      takeBtn.hidden = !canTake;
      takeBtn.classList.add('spec-iconbtn');
      takeBtn.innerHTML = `${iconSvg('flag', 'tinyicon')}<span>Übern.</span>`;
      takeBtn.title = canTake
        ? `${this.data.factions[viewed.faction]?.label || 'KI-Spieler'} übernehmen`
        : 'Nur freie KI-Sitze können übernommen werden';
      takeBtn.onclick = () => {
        const name = document.getElementById('pname')?.value || this.net.name || 'Spieler';
        this.net.takeoverSeat(cur, name);
      };
    }
    if (speedBtn) {
      const speed = SPECTATOR_SPEEDS.includes(controls.speed) ? controls.speed : 1;
      speedBtn.hidden = false;
      speedBtn.disabled = false;
      speedBtn.classList.add('spec-iconbtn');
      speedBtn.innerHTML = `${iconSvg('speed', 'tinyicon')}<span>x${speed}</span>`;
      speedBtn.title = 'Simulationsgeschwindigkeit setzen';
      speedBtn.onclick = () => {
        const idx = SPECTATOR_SPEEDS.indexOf(speed);
        const next = SPECTATOR_SPEEDS[(idx + 1) % SPECTATOR_SPEEDS.length];
        this.net.setSpectatorControls({ speed: next });
      };
    }
    if (timeWrap) {
      const mode = SPECTATOR_TIME_MODES.includes(controls.timeMode) ? controls.timeMode : 'auto';
      timeWrap.hidden = false;
      for (const btn of timeWrap.querySelectorAll('[data-spectatortime]')) {
        const btnMode = btn.dataset.spectatortime;
        const label = SPECTATOR_TIME_LABEL[btnMode] || btnMode;
        btn.disabled = false;
        btn.classList.add('spec-iconbtn');
        btn.innerHTML = `${iconSvg(SPECTATOR_TIME_ICON[btnMode] || 'clock', 'tinyicon')}<span>${label}</span>`;
        btn.setAttribute('aria-pressed', btnMode === mode ? 'true' : 'false');
        btn.title = `${label} setzen`;
        btn.onclick = () => this.net.setSpectatorControls({ timeMode: btnMode });
      }
    }
  }

  // --- Ressourcenleiste (mit Uhr & Wetter) ---
  renderTop() {
    const me = this.net.players.find(p => p.id === (this.net.spectator ? this.net.viewSeat : this.net.seat));
    const bar = document.getElementById('topbar');
    const env = this.net.env;
    // Uhrzeit & Wetter-Symbol aus dem Umwelt-Status (t: 0 = Mitternacht).
    let envHtml = '';
    if (env) {
      const mins = Math.round((env.t ?? 0) * 24 * 60);
      const hh = String(Math.floor(mins / 60) % 24).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      const night = (env.d ?? 1) < 0.25;
      const wIcon = env.w === 'clear' && night ? WEATHER_ICON.night : (WEATHER_ICON[env.w] || 'sun');
      const next = (env.f || [])[0] || null;
      const nextLabel = next ? (WEATHER_LABEL[next[0]] || next[0]) : 'unbekannt';
      const nextIn = fmtSeconds(env.wl || 0);
      const tip = `Tageszeit: ${hh}:${mm}\nAktuell: ${WEATHER_LABEL[env.w] || env.w} noch ${fmtDuration(env.wl || 0)}`
        + (next ? `\nNächstes Wetter: ${nextLabel} in ${nextIn}` : '');
      const nextIcon = next ? iconSvg(WEATHER_ICON[next[0]] || 'sun', 'tinyicon') : '';
      envHtml = `<span class="sep"></span><span class="res weather" title="${escAttr(tip)}">${iconSvg(wIcon, 'topicon')} <b>${hh}:${mm}</b><span class="forecast">${nextIcon}<span class="wtime">${nextIn}</span></span></span>`;
    }
    const helpHtml = `<span class="sep"></span>${this.helpButtonHtml()}`;
    if (!me || !me.res) { bar.innerHTML = `<span class="res">Zuschauer</span>${envHtml}${helpHtml}`; this.bindTopActions(); return; }
    if (this.net.spectator) {
      bar.innerHTML = `<span class="res">Zuschauer</span><span class="sep"></span><span class="res"><span class="dot" style="background:${me.color}"></span><b>Sicht: ${this.data.factions[me.faction].label}</b></span>${envHtml}${helpHtml}`;
      this.bindTopActions();
      return;
    }
    let html = `<span class="res"><span class="dot" style="background:${me.color}"></span><b>${this.data.factions[me.faction].label}</b></span><span class="sep"></span>`;
    for (const k of RES_ORDER) {
      const v = me.res[k] ?? 0;
      const cap = me.cap ? me.cap[k] : null;
      const capText = cap == null ? 'unb.' : Math.round(cap);
      const label = `${Math.round(v)}/${capText}`;
      const low = (k === 'ammo' && v < 50) || (k === 'fuel' && v < 50) || (k === 'ore' && v < 100) || (k === 'water' && v < 30);
      html += `<span class="res" data-res="${escAttr(k)}" style="--res-color:${RES_COLOR[k] || '#eaf6ff'}" title="${RES_TIP[k] || k}: ${label}">${resIcon(k)} <b class="${low ? 'low' : ''}">${label}</b></span>`;
    }
    if (me.energy) {
      const def = me.energy.p < me.energy.c;
      html += `<span class="res" data-res="energy" style="--res-color:${RES_COLOR.energy}" title="Energie: Erzeugung/Verbrauch (nachts höher — Beleuchtung)">${resIcon('energy')} <b class="${def ? 'low' : ''}">${me.energy.p}/${me.energy.c}</b></span>`;
    }
    html += envHtml;
    html += `<span class="sep"></span>${this.helpButtonHtml()}<button id="releasecontrol" class="topaction" type="button" title="Sitz an die KI zurückgeben und weiter zuschauen">Ausklinken</button>`;
    bar.innerHTML = html;
    this.bindTopActions();
  }

  bindTopActions() {
    const help = document.getElementById('helpbtn');
    if (help) help.onclick = () => {
      this.helpOpen = !this.helpOpen;
      try { localStorage.setItem('if_help_open', this.helpOpen ? '1' : '0'); } catch {}
      this.renderTop();
      this.renderAdvisor();
    };
    const release = document.getElementById('releasecontrol');
    if (release) release.onclick = () => this.net.releaseSeat();
    this.renderAdvisor();
  }

  helpButtonHtml() {
    return `<button id="helpbtn" class="topaction ${this.helpOpen ? 'active' : ''}" type="button" aria-pressed="${this.helpOpen ? 'true' : 'false'}" title="Bauvorschlag anzeigen">Hilfe</button>`;
  }

  renderAdvisor() {
    const panel = this.helpPanel || (this.helpPanel = document.getElementById('helppanel'));
    if (!panel) return;
    panel.hidden = !this.helpOpen;
    if (!this.helpOpen) return;
    const rec = this.nextAdvisorRecommendation();
    const def = rec.type === 'unit' ? this.data.units?.[rec.kind] : this.data.buildings?.[rec.kind];
    const icon = rec.type === 'unit' ? (UNIT_ICONS[rec.kind] || 'box') : (BUILD_ICONS[rec.kind] || 'box');
    const cost = def ? this.advisorCostHtml(def.cost || {}) : '';
    const note = def ? this.advisorCostNote(def.cost || {}) : '';
    panel.innerHTML = `<div class="advisorhead"><b>Nächster Schritt</b><span class="advisortype">${escAttr(rec.verb || 'Empfehlung')} · ${rec.type === 'unit' ? 'Einheit' : 'Gebäude'}</span></div>`
      + `<div class="advisoritem"><span class="advisoricon">${iconSvg(icon)}</span><span><span class="advisorlabel">${escAttr(rec.label)}</span><span class="advisorcost">${cost}</span></span></div>`
      + `<p class="advisorwhy"><b>Warum:</b> ${escAttr(rec.why)}</p>`
      + `<div class="advisornote">${escAttr([rec.note, note].filter(Boolean).join(' '))}</div>`;
  }

  advisorCostHtml(cost) {
    const entries = Object.entries(cost || {}).filter(([, v]) => v);
    if (!entries.length) return 'Kostenlos';
    const me = this.advisorPlayer();
    return entries.map(([k, v]) => {
      const have = me?.res?.[k] ?? 0;
      const cls = have < v ? 'low' : '';
      return `<span class="costitem ${cls}">${resIcon(k, 'costicon')}${escAttr(v)}</span>`;
    }).join(' ');
  }

  advisorCostNote(cost) {
    const me = this.advisorPlayer();
    if (!me?.res) return '';
    const missing = Object.entries(cost || {})
      .filter(([, v]) => v)
      .map(([k, v]) => [k, Math.max(0, v - (me.res[k] || 0))])
      .filter(([, v]) => v > 0);
    if (!missing.length) return 'Ressourcen sind vorhanden.';
    return `Noch sparen: ${missing.map(([k, v]) => `${Math.ceil(v)} ${RESOURCE_LABEL[k] || k}`).join(', ')}.`;
  }

  advisorPlayer() {
    const seat = this.net.spectator ? this.net.viewSeat : this.net.seat;
    return this.net.players.find(p => p.id === seat);
  }

  nextAdvisorRecommendation() {
    const me = this.advisorPlayer();
    if (!me) return { type: 'building', kind: 'hq', label: 'Bauhof', verb: 'Beitreten', why: 'Wähle zuerst einen Sitz, damit die Hilfe deine Fraktion bewerten kann.' };
    const seat = me.id;
    const ents = this.net.entities(1);
    const own = ents.filter(e => e.owner === seat && !e.dead);
    const ownBuildings = own.filter(e => e.etype === 'building');
    const readyBuildings = ownBuildings.filter(e => (e.buildProgress ?? 1) >= 1);
    const ownUnits = own.filter(e => e.etype === 'unit' && !e.abandoned);
    const enemyUnits = ents.filter(e => e.owner !== seat && e.owner >= 0 && e.etype === 'unit');
    const res = me.res || {};
    const cap = me.cap || {};
    const countB = (kind) => readyBuildings.filter(e => e.kind === kind).length;
    const anyB = (kind) => ownBuildings.some(e => e.kind === kind);
    const pendingB = (kind) => ownBuildings.some(e => e.kind === kind && (e.buildProgress ?? 1) < 1);
    const countU = (kind) => ownUnits.filter(e => e.kind === kind).length;
    const unitsBy = (pred) => ownUnits.filter(e => pred(this.data.units[e.kind] || {}, e)).length;
    const hasWaterMap = !!(this.net.init?.terrain?.waterDepth?.length);
    const hasReadyProducer = (kind) => !!this.readyProducerForUnit(kind, readyBuildings);
    const recBuilding = (kind, why, note = '') => {
      const def = this.data.buildings[kind] || {};
      return { type: 'building', kind, label: def.label || kind, verb: pendingB(kind) ? 'Fertigstellen' : 'Baue', why, note };
    };
    const recUnit = (kind, why, note = '') => {
      const def = this.data.units[kind] || {};
      const prod = this.readyProducerForUnit(kind, readyBuildings);
      if (prod) return { type: 'unit', kind, label: def.label || kind, verb: 'Produziere', why, note: note || `Produktion: ${this.data.buildings[prod.kind]?.label || prod.kind}.` };
      const unlock = this.firstProducerKindForUnit(kind);
      return unlock ? recBuilding(unlock, `${this.data.units[kind]?.label || kind} wird gebraucht, aber die passende Produktion fehlt noch.`, `Schaltet diese Einheit frei.`) : null;
    };
    const first = (...items) => items.find(Boolean);
    const military = ownUnits.filter(e => this.data.units[e.kind]?.weapon).length;
    const vehicles = unitsBy(d => d.category === 'vehicle' && d.weapon);
    const infantry = unitsBy(d => d.category === 'infantry' && d.weapon);
    const naval = unitsBy(d => d.category === 'naval');
    const air = unitsBy(d => d.category === 'air');
    const enemyAir = enemyUnits.some(e => this.data.units[e.kind]?.domain === 'air');
    const enemyVehicle = enemyUnits.some(e => this.data.units[e.kind]?.category === 'vehicle');
    const enemyNaval = enemyUnits.some(e => ['water', 'amphibious'].includes(this.data.units[e.kind]?.domain));
    const enemySub = enemyUnits.some(e => this.data.units[e.kind]?.submerged);
    const antiAir = own.filter(e => this.entityHitsTarget(e, 'air')).length;
    const defenses = readyBuildings.filter(e => this.data.buildings[e.kind]?.role === 'defense').length;

    if (me.defeated) return recBuilding('hq', 'Deine Fraktion ist besiegt; in einem neuen Spiel ist der Bauhof wieder der Startpunkt.');
    if (!countB('hq')) return recBuilding('hq', 'Ohne Bauhof fehlen Bauradius, integrierte Lager und Ersatz-Bagger.');
    if (countU('builder') < 1) return recUnit('builder', 'Ohne Bagger werden Gebäude, Gräben, Wälle und Erdarbeiten nicht fertig.');
    if (me.energy && me.energy.p < me.energy.c) {
      const kind = countB('oil_depot') && countB('oil_derrick') ? 'power_plant' : 'solar_plant';
      return recBuilding(kind, `Energiedefizit (${me.energy.p}/${me.energy.c}) drosselt Produktion und schaltet Gebäude ab.`);
    }
    if ((res.water || 0) < 30 || (cap.water && (res.water || 0) > cap.water * 0.82)) {
      return first(
        !countB('water_tower') && recBuilding('water_tower', 'Wasser ist knapp oder das kleine Bauhoflager läuft voll; ein Wasserturm schafft Kapazität.'),
        !countB('water_pump') && recBuilding('water_pump', 'Ohne Pumpwerk kommt kein neues Wasser in das Pipeline-Netz.'),
        !anyB('pipe') && recBuilding('pipe', 'Pumpwerk und Wasserturm brauchen eine durchgehende Pipeline, sonst fördert das Pumpwerk nicht.'),
      ) || recBuilding('pipe', 'Prüfe die Leitung zwischen Pumpwerk und Wasserturm; Leitungsbrüche stoppen Wasserförderung.');
    }
    if (cap.ore && (res.ore || 0) > cap.ore * 0.82 && !countB('ore_depot')) {
      return recBuilding('ore_depot', 'Das Erz nähert sich der Lagergrenze; ein Erzlager verhindert Stillstand beim Abtransport.');
    }
    if (cap.materials && (res.materials || 0) > cap.materials * 0.75 && !countB('material_depot')) {
      return recBuilding('material_depot', 'Aushub und Erde brauchen Lagerplatz, sonst verpufft wertvolles Baumaterial.');
    }
    if (countU('builder') < 2) return recUnit('builder', 'Ein zweiter Bagger verhindert Bau-Deadlocks und kann getrennt Erz, Erde oder Gebäude übernehmen.');
    if (countU('truck') < 2) return recUnit('truck', 'LKWs holen Erz- und Erdhaufen ab; ohne sie stauen sich Rohstoffe vor Ort.');
    if (!countB('ore_depot')) return recBuilding('ore_depot', 'Erzhaufen brauchen eine Annahmestelle, damit LKWs Erz zuverlässig einlagern.');
    if (!countB('refinery')) return recBuilding('refinery', 'Mehr Erzkapazität und Verarbeitung stabilisieren den Hauptrohstofffluss.');
    if (!countB('barracks') && military < 6) return recBuilding('barracks', 'Du brauchst frühe Infanterie für Sicht, Deckung und günstige Verteidigung.');
    if (countB('barracks') && infantry < 4) return recUnit('rifleman', 'Günstige Schützen halten Gräben, decken Bagger und sichern die Basis.');
    if (!countB('factory')) return recBuilding('factory', 'Fahrzeuge sind nötig, um Angriffe, Erzlogistik und Frontbewegung zu tragen.');
    if (enemyAir && antiAir < 2) {
      return first(
        hasReadyProducer('flak_track') && recUnit('flak_track', 'Der Gegner hat Luftziele; mobile Flak schützt Fahrzeuge und Bagger.'),
        hasReadyProducer('aa_soldier') && recUnit('aa_soldier', 'Der Gegner hat Luftziele; FlaRak-Trupps sind die schnellste Antwort.'),
        recBuilding('flak_turret', 'Der Gegner hat Luftziele; eine stationäre Flak schützt die Basis.'),
      );
    }
    if (enemySub && !countB('sonar')) return recBuilding('sonar', 'Getauchte Einheiten werden ohne Sonar erst sehr spät sichtbar.');
    if (enemyVehicle && countB('barracks') && !countU('at_soldier')) return recUnit('at_soldier', 'Gegen Fahrzeuge fehlt günstige Panzerabwehr-Infanterie.');
    if (countB('factory') && vehicles < 3) return recUnit(vehicles ? 'tank' : 'scout', vehicles ? 'Mehr Panzer geben deiner Armee Halt gegen Fahrzeuge und Gebäude.' : 'Ein Späher liefert Sicht und reagiert schnell auf Lücken.');
    if (((res.ammo || 0) < 90 || (res.fuel || 0) < 90) && !countB('depot')) {
      return recBuilding('depot', 'Munition oder Treibstoff werden knapp; ein Nachschubdepot erzeugt und puffert beides.');
    }
    if ((res.fuel || 0) < 160 || countB('power_plant')) {
      const oilRec = first(
        !countB('oil_depot') && recBuilding('oil_depot', 'Öl braucht ein Depot, bevor Bohrtürme den Treibstofffluss sinnvoll stützen.'),
        !countB('oil_derrick') && recBuilding('oil_derrick', 'Bohrtürme liefern Öl, das automatisch zu Treibstoff wird.'),
        !anyB('pipe') && recBuilding('pipe', 'Bohrtürme fördern erst mit Pipeline zum Öldepot zuverlässig.'),
      );
      if (oilRec) return oilRec;
    }
    if (hasWaterMap && enemyNaval && !countB('shipyard')) return recBuilding('shipyard', 'Der Gegner nutzt Wasser; ohne Werft fehlen eigene Schiffe und Flusskontrolle.');
    if (hasWaterMap && countB('shipyard') && naval < 2) return recUnit(naval ? 'destroyer' : 'patrol_boat', 'Schiffe sichern Flüsse, Küsten und Brücken gegen Umgehungen.');
    if (defenses < 2 && military >= 6) return recBuilding(defenses ? 'turret' : 'mg_turret', 'Ein paar Türme fangen Gegenangriffe ab und schützen Wirtschaft und Bauhof.');
    if (!countB('airbase') && vehicles >= 5 && (res.ore || 0) > 1200) return recBuilding('airbase', 'Luft ist teuer, aber im späteren Spiel gut für Aufklärung, Druck und Spezialwaffen.');
    if (countB('airbase') && air < 1) return recUnit('recon_drone', 'Eine Drohne erweitert Sicht und findet Angriffe, bevor sie in die Basis rollen.');
    if (countB('factory')) return recUnit(enemyAir ? 'flak_track' : 'rocket_launcher', enemyAir ? 'Zusätzliche mobile Flak bleibt nützlich gegen Luftdruck.' : 'Raketenwerfer brechen Stellungen und bestrafen langsame Fahrzeuggruppen.');
    if (countB('barracks')) return recUnit('aa_soldier', 'Mehr spezialisierte Infanterie gibt günstige Antworten auf Luft und gemischte Angriffe.');
    return recBuilding('road', 'Straßen sind günstig, beschleunigen Fahrzeuge und helfen über steilere Hänge.');
  }

  readyProducerForUnit(kind, readyBuildings) {
    const udef = this.data.units?.[kind];
    if (!udef || udef.hidden) return null;
    return readyBuildings.find(b => {
      const bdef = this.data.buildings?.[b.kind];
      return (bdef?.produces_units || []).includes(kind) || (!!bdef?.produces_category && bdef.produces_category === udef.category);
    }) || null;
  }

  firstProducerKindForUnit(kind) {
    const udef = this.data.units?.[kind];
    if (!udef || udef.hidden) return null;
    for (const [bkind, bdef] of Object.entries(this.data.buildings || {})) {
      if ((bdef.produces_units || []).includes(kind) || (!!bdef.produces_category && bdef.produces_category === udef.category)) return bkind;
    }
    return null;
  }

  entityHitsTarget(e, target) {
    const def = e.etype === 'unit' ? this.data.units?.[e.kind] : this.data.buildings?.[e.kind];
    const weapon = def?.weapon ? this.data.weapons?.[def.weapon] : null;
    return (weapon?.vs?.[target] || 0) >= 1;
  }

  // --- Bauleiste / Produktion ---
  renderBuildbar() {
    const bar = document.getElementById('buildbar');
    if (this.net.spectator) { bar.innerHTML = ''; return; }
    const me = this.net.players.find(p => p.id === this.net.seat);
    if (!me) { bar.innerHTML = ''; return; }
    const owner = me.id ?? this.net.seat;
    const readyBuildings = this.net.entities(1)
      .filter(e => e.etype === 'building' && e.owner === owner && !e.dead && (e.buildProgress ?? 1) >= 1);
    // Kosten-Label inkl. Erde/Baumaterial; Verfügbarkeit prüft beide Ressourcen.
    const costHtml = (cost) => {
      const parts = RES_ORDER.filter(k => cost?.[k])
        .map(k => `<span class="costitem cost-${k}" style="color:${RES_COLOR[k] || '#eaf6ff'}">${resIcon(k, 'costicon')}${cost[k]}</span>`);
      const cls = parts.length > 1 ? ' multi' : '';
      return parts.length
        ? `<span class="costlist${cls}">${parts.join('')}</span>`
        : `<span class="costlist"><span class="costitem cost-ore" style="color:${RES_COLOR.ore}">${resIcon('ore', 'costicon')}0</span></span>`;
    };
    const costText = (cost) => Object.entries(cost || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${RES_TIP[k] || k}: ${v}`)
      .join(', ') || 'Kostenlos';
    const tooltip = (label, def, extra = '') => [
      label,
      def.desc || '',
      `Kosten: ${costText(def.cost)}`,
      def.buildTime != null ? `Bauzeit: ${def.buildTime}s` : '',
      def.power ? `Energie: ${def.power > 0 ? '+' : ''}${def.power}` : '',
      extra,
    ].filter(Boolean).join('\n');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const buttonHtml = ({ cls = '', attrs = '', icon, label, cost, title, previewType = '', previewKind = '', overlay = false }) =>
      `<button class="bbtn ${cls}" ${attrs} title="${esc(title)}" aria-label="${esc(label)}">`
      + (previewType && previewKind
        ? `<span class="bthumb" aria-hidden="true">${this.modelPreviewHtml(previewType, previewKind, 'buttonmodel')}<span class="bicon mini">${iconSvg(icon || 'box')}</span></span>`
        : `<span class="bicon" aria-hidden="true">${iconSvg(icon || 'box')}</span>`)
      + `<span class="bmeta"><span class="blabel">${esc(label)}</span><span class="cost">${cost}</span></span>`
      + (overlay ? `<span class="bprog" aria-hidden="true"></span><span class="bqty" aria-hidden="true"></span>` : '')
      + `</button>`;
    const canPay = (cost) => (me.res?.ore ?? 0) >= (cost.ore || 0)
      && (me.res?.materials ?? 0) >= (cost.materials || 0)
      && (me.res?.oil ?? 0) >= (cost.oil || 0)
      && (me.res?.water ?? 0) >= (cost.water || 0)
      && (me.res?.fuel ?? 0) >= (cost.fuel || 0);
    if (!BUILD_TABS.some(([id]) => id === this.buildTab)) this.buildTab = 'terrain';
    const buildButtonHtml = (kind) => {
      const def = this.data.buildings[kind];
      if (!def || def.hidden) return '';
      const armed = this.input.buildMode === kind;
      return buttonHtml({
        cls: armed ? 'armed' : '',
        attrs: `data-build="${kind}" ${canPay(def.cost) ? '' : 'disabled'}`,
        icon: BUILD_ICONS[kind] || 'box',
        label: def.label,
        cost: costHtml(def.cost),
        title: tooltip(def.label, def),
        previewType: 'building',
        previewKind: kind,
      });
    };
    // Terraforming-Aufträge: Zelle markieren, ein freier Bagger fährt hin und arbeitet.
    const canRaise = (me.res?.materials ?? 0) >= 8;
    const terrainHtml = BUILD_TERRAIN_KINDS.map(buildButtonHtml).join('')
      + buttonHtml({ cls: this.input.buildMode === '_terra_up' ? 'armed' : '', attrs: `data-terra="up" ${canRaise ? '' : 'disabled'}`, icon: 'up', label: 'Aufschütten', cost: `<span class="costitem">${resIcon('materials', 'costicon')}8</span> Bagger`, title: 'Aufschütten\nGelände anheben, Rampen bauen und Wasser stauen.\nKosten: Baumaterial: 8\nBenötigt: freier Bagger.' })
      + buttonHtml({ cls: this.input.buildMode === '_terra_down' ? 'armed' : '', attrs: 'data-terra="down"', icon: 'down', label: 'Abgraben', cost: `<span class="costitem">+${resIcon('materials', 'costicon')}</span> Bagger`, title: 'Abgraben\nGelände absenken, Wasser ableiten oder Hochseen anstechen.\nErtrag: Erde/Baumaterial.\nBenötigt: freier Bagger.' });
    const buildingsHtml = BUILDING_KINDS.map(buildButtonHtml).join('');
    let unitsHtml = '';
    for (const [kind, def] of Object.entries(this.data.units)) {
      const prod = this.readyProducerForUnit(kind, readyBuildings);
      if (!prod) continue;
      unitsHtml += buttonHtml({
        attrs: `data-produce="${kind}" data-bid="${prod.id}" ${canPay(def.cost) ? '' : 'disabled'}`,
        icon: UNIT_ICONS[kind] || 'box',
        label: def.label,
        cost: costHtml(def.cost),
        title: tooltip(def.label, def, def.upkeep ? `Unterhalt: ${costText(def.upkeep)}` : ''),
        previewType: 'unit',
        previewKind: kind,
        overlay: true,
      });
    }
    const panels = { terrain: terrainHtml, buildings: buildingsHtml, units: unitsHtml };
    let html = `<div class="buildtabs" role="tablist">`;
    for (const [id, label, icon] of BUILD_TABS) {
      const active = this.buildTab === id;
      html += `<button class="buildtab" type="button" data-buildtab="${id}" aria-selected="${active ? 'true' : 'false'}" title="${esc(label)}">${iconSvg(icon, 'tinyicon')}<span>${esc(label)}</span></button>`;
    }
    html += `</div><div class="buildpanel"><div class="grid">${panels[this.buildTab] || ''}</div></div>`;
    // Nur bei ECHTER Änderung neu rendern: ständiges innerHTML-Ersetzen zerstörte die nativen
    // Tooltips (das Hover-Element wird ausgetauscht, bevor der Browser den title anzeigt)
    // und klappte offene Gruppen wieder zu.
    if (html === this._bbHtml) return;
    this._bbHtml = html;
    bar.innerHTML = html;
    this.renderModelPreviews(bar);
    bar.querySelectorAll('[data-buildtab]').forEach(b => b.onclick = () => { this.buildTab = b.dataset.buildtab; this.renderBuildbar(); });
    bar.querySelectorAll('[data-build]').forEach(b => b.onclick = () => { this.input.buildMode = b.dataset.build; this.renderBuildbar(); });
    bar.querySelectorAll('[data-terra]').forEach(b => b.onclick = () => { this.input.buildMode = '_terra_' + b.dataset.terra; this.renderBuildbar(); });
    bar.querySelectorAll('[data-produce]').forEach(b => b.onclick = () => this.net.cmd({ type: 'produce', building: +b.dataset.bid, kind: b.dataset.produce }));
    this.updateBuildProgress();
  }

  // C&C-Baufortschritt: füllt das Fortschritts-Overlay des laufenden Items und blendet die
  // Auftragszahl je Einheitentyp ein. Läuft häufig (UI-Intervall), ohne das Menü neu zu rendern —
  // schreibt nur Stil/Text der vorhandenen Overlay-Elemente, damit Tooltips/offene Gruppen bleiben.
  updateBuildProgress() {
    const bar = document.getElementById('buildbar');
    if (!bar) return;
    const btns = bar.querySelectorAll('[data-produce]');
    if (!btns.length) return;
    for (const btn of btns) {
      const b = this.curEntity(+btn.dataset.bid);
      const kinds = (b && b.prodKinds) || [];
      const counts = {};
      for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
      const frontKind = kinds[0];
      const kind = btn.dataset.produce;
      const n = counts[kind] || 0;
      const prog = btn.querySelector('.bprog');
      const qty = btn.querySelector('.bqty');
      if (n > 0) {
        btn.classList.add('producing');
        // Fortschritt nur am vorderen (gerade gebauten) Item zeigen; weitere warten bei 0.
        if (prog) prog.style.height = (kind === frontKind ? Math.round((b.prodFront || 0) * 100) : 0) + '%';
        if (qty) { qty.textContent = n > 1 ? String(n) : ''; qty.style.display = n > 1 ? 'flex' : 'none'; }
      } else {
        btn.classList.remove('producing');
        if (prog) prog.style.height = '0%';
      }
    }
  }

  curEntity(id) { return this.net.entities(1).find(e => e.id === id); }
  findEntity(id) { return this.curEntity(id); }

  // --- Auswahlpanel ---
  renderSelection() {
    const ids = [...this.input.selected];
    const ents = ids.map(id => this.curEntity(id)).filter(Boolean);
    const grid = document.getElementById('selgrid');
    const title = this.selPanel.querySelector('.title');
    if (!ents.length) {
      // Kein Objekt gewählt: zeigt das angeklickte Öl-/Erzfeld die Vorkommensmenge.
      const fi = this.input.fieldInfo;
      if (fi && (fi.ore > 0 || fi.oil > 0)) {
        this.selPanel.classList.remove('empty');
        title.textContent = fi.oil > 0 ? 'Ölfeld' : 'Erzvorkommen';
        let h = '';
        if (fi.ore > 0) h += `<span class="chip" title="Erz im Boden (Startwert)">${resIcon('ore', 'costicon')}${fi.ore}</span>`;
        if (fi.oil > 0) h += `<span class="chip" title="Restöl im Feld">${resIcon('oil', 'costicon')}${fi.oil}</span>`;
        grid.innerHTML = h; this.renderBuildbar(); return;
      }
      this.selPanel.classList.add('empty'); title.textContent = 'Keine Auswahl'; grid.innerHTML = ''; this.renderBuildbar(); return;
    }
    this.selPanel.classList.remove('empty');
    const counts = {};
    for (const e of ents) { const lbl = (this.data.units[e.kind] || this.data.buildings[e.kind] || {}).label || e.kind; counts[lbl] = (counts[lbl] || 0) + 1; }
    title.textContent = `Auswahl (${ents.length})`;
    let html = Object.entries(counts).map(([k, n]) => `<span class="chip" title="${k}${n > 1 ? ' ×' + n : ''}">${k}${n > 1 ? ' ×' + n : ''}</span>`).join('');
    if (ents.length === 1) {
      const e = ents[0];
      const owner = this.net.players.find(p => p.id === e.owner);
      const hp = `${Math.max(0, Math.round(e.hp))}/${Math.round(e.maxHp || e.hp || 0)}`;
      html += `<span class="chip" title="Fraktion">${escAttr(owner ? this.data.factions[owner.faction]?.label || owner.name : 'Neutral')}</span>`;
      html += `<span class="chip" title="Struktur / Trefferpunkte">HP ${hp}</span>`;
      if (e.etype === 'building' && e.buildProgress < 1) html += `<span class="chip" title="Baufortschritt">${Math.round(e.buildProgress * 100)}%</span>`;
      if (e.etype === 'building' && e.queue) html += `<span class="chip" title="Produktionswarteschlange">Queue ${e.queue}</span>`;
      if (e.etype === 'building' && e.powered === false) html += '<span class="chip" title="Lastabwurf">ohne Strom</span>';
      // Lager: gespeicherte Menge der Annahme-Ressource (Vorrat/Kapazität des Besitzers) anzeigen.
      const bdef = this.data.buildings[e.kind] || {};
      const depotRes = bdef.resourceDepot || (bdef.integratedStorage && Object.keys(bdef.integratedStorage)[0]);
      if (e.etype === 'building' && depotRes && owner?.res) {
        const have = Math.round(owner.res[depotRes] ?? 0);
        const cap = owner.cap ? Math.round(owner.cap[depotRes] ?? 0) : 0;
        html += `<span class="chip" title="Eingelagert">${resIcon(depotRes, 'costicon')}${have}${cap ? '/' + cap : ''}</span>`;
      }
      // LKW/Bagger-Ladung: Menge + Ressourcenart.
      if (e.etype === 'unit' && e.cargo) {
        const cr = e.role && e.role !== 'build' ? e.role : 'ore';
        html += `<span class="chip" title="Ladung">${resIcon(cr, 'costicon')}${Math.round(e.cargo)}</span>`;
      }
      if (e.etype === 'unit' && e.role) html += `<span class="chip" title="Bagger/LKW-Rolle">${escAttr(BUILDER_ROLE_LABEL[e.role] || e.role)}</span>`;
    }
    const builders = ents.filter(e => e.kind === 'builder' && e.owner === this.net.seat);
    if (builders.length) {
      const roleOf = (b) => b.role === 'materials' ? 'build' : b.role;
      const firstRole = roleOf(builders[0]);
      const active = builders.every(b => roleOf(b) === firstRole) ? firstRole : null;
      html += '<div class="rolebar">';
      for (const [role, icon, label, tip] of BUILDER_ROLES) {
        html += `<button class="rolebtn ${active === role ? 'active' : ''}" data-role="${role}" title="${tip}">${iconSvg(icon, 'roleicon')} ${label}</button>`;
      }
      html += '</div>';
    }
    // LKW-Transportmodus umstellen (Auto/Erz/Material).
    const trucks = ents.filter(e => e.kind === 'truck' && e.owner === this.net.seat);
    if (trucks.length) {
      const modeOf = (t) => t.role === 'ore' ? 'ore' : t.role === 'earth' ? 'materials' : 'auto';
      const firstMode = modeOf(trucks[0]);
      const active = trucks.every(t => modeOf(t) === firstMode) ? firstMode : null;
      html += '<div class="rolebar">';
      for (const [mode, icon, label, tip] of TRUCK_ROLES) {
        html += `<button class="rolebtn ${active === mode ? 'active' : ''}" data-haul="${mode}" title="${tip}">${iconSvg(icon, 'roleicon')} ${label}</button>`;
      }
      html += '</div>';
    }
    // Kanal-Schiff: Knopf zum Ausheben eines schiffbaren Kanals (Linie Start→Ende ziehen).
    const canalShips = ents.filter(e => e.owner === this.net.seat && (this.data.units[e.kind]?.canal));
    if (canalShips.length) {
      const armed = this.input.buildMode === '_canal_';
      html += `<div class="rolebar"><button class="rolebtn ${armed ? 'active' : ''}" data-canal="1" title="Kanal ausheben\nLinie von Wasser durch Land zu Wasser ziehen — das Schiff gräbt einen schiffbaren Kanal.">${iconSvg('down', 'roleicon')} Kanal ziehen</button></div>`;
    }
    // Brückenleger: Knopf zum Verlegen einer Pontonbrücke (Linie übers Wasser ziehen).
    const layers = ents.filter(e => e.owner === this.net.seat && (this.data.units[e.kind]?.pontoon));
    if (layers.length) {
      const armed = this.input.buildMode === '_pontoon_';
      html += `<div class="rolebar"><button class="rolebtn ${armed ? 'active' : ''}" data-pontoon="1" title="Ponton verlegen\nLinie über das Wasser ziehen — der Brückenleger legt eine schnelle, leicht zerstörbare Pontonbrücke (langsam befahrbar).">${iconSvg('builder', 'roleicon')} Ponton verlegen</button></div>`;
    }
    // Eigene Gebäude abreißen: im Bau volle, fertig halbe Rückerstattung.
    const ownBuildings = ents.filter(e => e.etype === 'building' && e.owner === this.net.seat
      && e.kind !== 'earth_pile' && e.kind !== 'ore_pile');
    if (ownBuildings.length) {
      const construction = ownBuildings.some(e => e.buildProgress < 1);
      const label = construction ? 'Bau abbrechen' : 'Abreißen';
      const refund = construction ? '100 %' : '50 %';
      html += `<div class="rolebar"><button class="rolebtn danger" data-destroy="1" title="${label}\nGebäude abreißen — Rückerstattung ${refund} der Baukosten (im Bau voll, fertig die Hälfte).">${iconSvg('down', 'roleicon')} ${label} (${refund} zurück)</button></div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('[data-destroy]').forEach(b => b.onclick = () => {
      for (const e of ents.filter(e => e.etype === 'building' && e.owner === this.net.seat
        && e.kind !== 'earth_pile' && e.kind !== 'ore_pile')) {
        this.net.cmd({ type: 'destroy', building: e.id });
      }
    });
    grid.querySelectorAll('[data-role]').forEach(b => b.onclick = () => {
      const units = ents.filter(e => e.kind === 'builder' && e.owner === this.net.seat).map(e => e.id);
      if (units.length) this.net.cmd({ type: 'setRole', units, role: b.dataset.role });
    });
    grid.querySelectorAll('[data-haul]').forEach(b => b.onclick = () => {
      const units = ents.filter(e => e.kind === 'truck' && e.owner === this.net.seat).map(e => e.id);
      if (units.length) this.net.cmd({ type: 'setRole', units, role: b.dataset.haul });
    });
    grid.querySelectorAll('[data-canal]').forEach(b => b.onclick = () => {
      this.input.buildMode = this.input.buildMode === '_canal_' ? null : '_canal_';
      this.renderSelection();
    });
    this.renderBuildbar();
  }

  playerScore(player, entities) {
    let score = 0;
    for (const e of entities) {
      if (e.owner !== player.id) continue;
      const def = e.etype === 'unit' ? this.data.units[e.kind] : this.data.buildings[e.kind];
      if (!def) continue;
      const hp = Math.max(0, Math.min(1, (e.hp || 0) / Math.max(1, e.maxHp || e.hp || 1)));
      const costScore = Object.values(def.cost || {}).reduce((sum, v) => sum + (v || 0), 0);
      if (e.etype === 'building') {
        const role = e.kind === 'hq' ? 900 : (def.produces_units || def.produces_category) ? 430 : def.weapon ? 300 : 160;
        score += (role + costScore * 0.9) * hp * Math.max(0.25, e.buildProgress ?? 1);
      } else {
        const role = def.weapon ? 260 : (def.abilities || []).includes('construct') ? 150 : (def.abilities || []).includes('harvest') ? 130 : 70;
        score += (role + costScore * 0.85) * hp;
      }
    }
    const res = player.res || {};
    score += Math.min(1600, (res.ore || 0) * 0.18 + (res.materials || 0) * 0.10 + (res.fuel || 0) * 0.05);
    return Math.max(0, Math.round(score));
  }

  renderScoreboard(entities = this.net.entities(1)) {
    if (!this.scoreboard) return;
    this.renderJoinCode();
    const rows = this.net.players
      .slice()
      .sort((a, b) => a.id - b.id)
      .map(p => {
        const faction = this.data.factions[p.faction]?.label || p.name || `Sitz ${p.id + 1}`;
        const score = this.playerScore(p, entities);
        const faded = p.defeated ? ' opacity:.48;' : '';
        return `<div class="score-row" style="${faded}" title="${escAttr(faction)}">
          <span class="score-dot" style="background:${escAttr(p.color || '#ccc')}"></span>
          <span class="score-name">${escAttr(faction)}</span>
          <span class="score-value">${score.toLocaleString('de-DE')}</span>
        </div>`;
      });
    this.scoreboard.innerHTML = rows.join('');
  }

  renderJoinCode() {
    if (!this.joinCodeHud) return;
    const room = this.net.room;
    this.joinCodeHud.innerHTML = room?.code
      ? `Privates Spiel<b>${escAttr(room.code)}</b>`
      : '';
  }

  // --- Minimap ---
  renderMinimap(renderer) {
    const entities = this.net.entities(1);
    this.renderScoreboard(entities);
    const ctx = this.mctx, W = this.minimap.width, H = this.minimap.height;
    if (!renderer.mapW) return;
    const sx = W / (renderer.mapW * 2), sy = H / (renderer.mapH * 2);
    ctx.fillStyle = '#08111a'; ctx.fillRect(0, 0, W, H);
    // Gelände grob
    const step = 3;
    for (let gy = 0; gy < renderer.mapH; gy += step) for (let gx = 0; gx < renderer.mapW; gx += step) {
      const t = renderer.terrainType[gy * renderer.mapW + gx];
      ctx.fillStyle = t === 3 ? '#16364f' : t === 2 ? '#444c55' : t === 1 ? '#5a4f37' : '#3a4a2c';
      ctx.fillRect(gx * 2 * sx, gy * 2 * sy, step * 2 * sx + 1, step * 2 * sy + 1);
    }
    // Echte Wasserflächen aus der Kartengenerierung: Meer, Flüsse, Hochseen. Keine temporären
    // Feuchtgebiete, Pfützen oder nassen Fahrspuren.
    const staticWater = this.net.init?.terrain?.water;
    if (staticWater && staticWater.length) {
      ctx.fillStyle = '#3d86c4';
      for (let idx = 0; idx < staticWater.length; idx++) {
        if (!staticWater[idx]) continue;
        const gx = idx % renderer.mapW, gy = (idx / renderer.mapW) | 0;
        ctx.fillRect(gx * 2 * sx, gy * 2 * sy, 2 * sx + 1, 2 * sy + 1);
      }
    }
    // Straßennetz
    if (this.net.roads && this.net.roads.length) {
      ctx.fillStyle = '#555a60';
      for (const idx of this.net.roads) {
        const gx = idx % renderer.mapW, gy = (idx / renderer.mapW) | 0;
        ctx.fillRect(gx * 2 * sx, gy * 2 * sy, 2 * sx, 2 * sy);
      }
    }
    // Entities
    for (const e of entities) {
      const p = this.net.players.find(pp => pp.id === e.owner);
      ctx.fillStyle = p ? p.color : '#fff';
      const r = e.etype === 'building' ? 2.5 : 1.5;
      ctx.fillRect(e.x * sx - r / 2, e.y * sy - r / 2, r, r);
    }
    // Kamera-Sichtfeld (grob: Zielpunkt)
    const t = renderer.camTarget;
    ctx.strokeStyle = '#ffffff88'; ctx.strokeRect(t.x * sx - 14, t.z * sy - 10, 28, 20);
    // Klick zum Springen
    if (!this._mmBound) { this._mmBound = true; this.minimap.onclick = (ev) => {
      const r = this.minimap.getBoundingClientRect();
      renderer.camTarget.x = (ev.clientX - r.left) / sx; renderer.camTarget.z = (ev.clientY - r.top) / sy;
    }; }
  }

  warn(key, text) {
    const now = performance.now();
    if (this.lastWarn[key] && now - this.lastWarn[key] < 6000) return;
    this.lastWarn[key] = now;
    const el = document.createElement('div'); el.className = 'warnmsg'; el.textContent = text;
    this.warnEl.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  checkWarnings() {
    const me = this.net.players.find(p => p.id === this.net.seat);
    // Wetterumschwung melden (auch für Zuschauer interessant).
    const env = this.net.env;
    if (env && env.w !== this._lastWeather) {
      if (this._lastWeather !== undefined) {
        const msg = env.w === 'storm' ? 'Gewitter! Wellengang gefährdet Schiffe, Böen und Blitze die Luftflotte.'
          : env.w === 'rain' ? 'Regen: Pegel steigen, schwere Fahrzeuge versinken im Matsch, Schnee wächst (Lawinengefahr).'
          : env.w === 'fog' ? 'Nebel: Sichtweite stark reduziert, riskant für Schiffe und Flieger.'
          : env.w === 'drought' ? 'Trockenphase: Quellen versiegen, Flüsse können austrocknen und Matsch härtet aus.'
          : 'Wetter klart auf.';
        this.warn('weather' + env.w, msg);
      }
      this._lastWeather = env.w;
    }
    if (!me || !me.res) return;
    if (me.energy && me.energy.p < me.energy.c) this.warn('power', 'Energiedefizit: Produktion gedrosselt!');
    if (me.res.ammo < 40) this.warn('ammo', 'Munition knapp: Depot bauen!');
    if (me.res.water < 20) this.warn('water', 'Wasser knapp: Pumpwerk per Pipeline an Wasserturm anschließen!');
    if (me.res.ore < 80) this.warn('ore', 'Erzlager fast leer — Bagger und Stahlwerk prüfen!');
    if (me.defeated) this.warn('defeat', 'Deine Fraktion wurde besiegt.');
  }
}
