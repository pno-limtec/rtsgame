// Veteranensystem (Phase 3): Einheiten sammeln Erfahrung (XP) durch Abschüsse und
// steigen in Ränge auf, die Schaden, max. HP, Sicht und (Held) Selbstheilung verbessern.
// Datengetrieben über data/veterancy.json; rein deterministisch (kein Rendering/Netzwerk).
import { DT } from '../constants.js';

// Fallback, falls keine Veteranen-Daten geladen wurden: nur der Basisrang (keine Boni).
export const DEFAULT_VET = {
  killValueFactor: 0.4, buildingValueFactor: 0.05, regenAfterHitDelay: 5, promoteHealFraction: 0.2,
  ranks: [{ name: 'Rekrut', xp: 0, dmgMult: 1, hpMult: 1, sightMult: 1, regen: 0 }],
};

// Veteranenfelder einer frisch gespawnten Einheit initialisieren (Basiswerte merken).
export function initVet(unit) {
  unit.baseMaxHp = unit.maxHp;
  unit.baseSight = unit.sight;
  unit.xp = 0;
  unit.vet = 0;
  unit.vetDmgMult = 1;
  unit.vetRegen = 0;
}

// XP-Wert eines zerstörten Ziels: skaliert mit Robustheit; Gebäude geben deutlich weniger,
// damit Basis-Abriss keine Rang-Inflation auslöst.
export function killValue(victim, vet = DEFAULT_VET) {
  const base = victim.baseMaxHp || victim.maxHp || 0;
  const f = victim.etype === 'building' ? vet.buildingValueFactor : vet.killValueFactor;
  return base * f;
}

// Boni eines Rangs auf eine Einheit anwenden. Beim Aufstieg (healOnPromote) wird die
// gewonnene Max-HP voll gutgeschrieben plus eine kleine Sofortheilung als Belohnung.
export function applyRank(unit, rank, vet, healOnPromote) {
  const oldMax = unit.maxHp;
  const newMax = Math.round(unit.baseMaxHp * rank.hpMult);
  unit.maxHp = newMax;
  unit.sight = unit.baseSight * rank.sightMult;
  unit.vetDmgMult = rank.dmgMult;
  unit.vetRegen = rank.regen || 0;
  if (healOnPromote) {
    unit.hp = Math.min(newMax, unit.hp + (newMax - oldMax) + unit.baseMaxHp * (vet.promoteHealFraction || 0));
  } else if (unit.hp > newMax) {
    unit.hp = newMax;
  }
}

// XP gutschreiben und ggf. (mehrfach) befördern. Gibt true zurück, wenn aufgestiegen wurde.
export function awardXp(unit, amount, vet = DEFAULT_VET) {
  if (!unit || unit.etype !== 'unit' || unit.dead || !(amount > 0)) return false;
  const ranks = vet.ranks;
  if (!ranks || ranks.length <= 1) return false;
  unit.xp = (unit.xp || 0) + amount;
  let promoted = false;
  while (unit.vet + 1 < ranks.length && unit.xp >= ranks[unit.vet + 1].xp) {
    unit.vet++;
    applyRank(unit, ranks[unit.vet], vet, true);
    promoted = true;
  }
  return promoted;
}

// Helden (Rang mit regen>0) heilen sich langsam, sofern sie kürzlich nicht getroffen wurden.
export function stepRegen(world) {
  const vet = world.vet || DEFAULT_VET;
  const delay = vet.regenAfterHitDelay || 0;
  for (const e of world.entities.values()) {
    if (e.dead || e.etype !== 'unit' || !e.vetRegen) continue;
    if (e.hp <= 0 || e.hp >= e.maxHp) continue;
    if (e._lastHit != null && world.time - e._lastHit < delay) continue;
    e.hp = Math.min(e.maxHp, e.hp + e.vetRegen * DT);
  }
}
