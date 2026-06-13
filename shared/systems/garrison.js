// Garnisonierbare Schützengräben (Phase 7): Infanterie, die in einem eigenen Graben steht,
// gilt diesen Tick als "eingegraben" — sie nimmt zusätzlich zur Geländedeckung weniger Schaden
// (Schadensfaktor in applyDamage) und wird langsam feldrepariert. Pro Graben begrenzt die
// `garrison`-Kapazität (data/buildings.json) die Zahl geschützter Trupps.
// Rein deterministisch (kein Rendering/Netzwerk).
import { DT, GARRISON_RADIUS, GARRISON_REGEN } from '../constants.js';

const R2 = GARRISON_RADIUS * GARRISON_RADIUS;

export function stepGarrison(world) {
  for (const t of world.entities.values()) {
    if (t.etype !== 'building' || t.dead || t.kind !== 'trench' || t.buildProgress < 1) continue;
    const cap = (t.def && t.def.garrison) || 0;
    if (!cap) { t.garrison = 0; continue; }
    let n = 0;
    for (const u of world.entities.values()) {
      if (n >= cap) break;
      if (u.etype !== 'unit' || u.dead || u.category !== 'infantry' || u.owner !== t.owner) continue;
      const dx = u.x - t.x, dy = u.y - t.y;
      if (dx * dx + dy * dy > R2) continue;
      u._garr = world.tick;                                              // diesen Tick eingegraben → Schadensbonus
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + GARRISON_REGEN * DT); // Feldreparatur im Graben
      n++;
    }
    t.garrison = n;                                                      // aktuelle Belegung (Stat/Telemetrie)
  }
}
