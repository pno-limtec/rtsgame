// Sonar-Ortung (Phase 5): Sonarstationen (`def.sonarRange`) decken getauchte gegnerische
// U-Boote in ihrem Umkreis auf. Jedes betroffene U-Boot merkt sich in `_sonarBy` die Spieler,
// die es gerade orten — `isDetectable` macht es dadurch für deren Einheiten angreifbar.
// Leichtgewichtig: iteriert nur U-Boote × Sonarstationen (beides selten). Deterministisch.

export function stepSonar(world) {
  let sonars = null;
  for (const e of world.entities.values()) {
    if (e.etype === 'building' && !e.dead && e.buildProgress >= 1 && e.def && e.def.sonarRange) {
      (sonars || (sonars = [])).push(e);
    }
  }
  for (const e of world.entities.values()) {
    if (e.etype !== 'unit' || !e.submerged || e.dead) continue;
    let by = e._sonarBy;
    if (by) by.clear();                       // Ortung jeden Tick neu bestimmen
    if (!sonars) continue;
    for (const s of sonars) {
      if (s.owner === e.owner) continue;      // eigene Sonarstation ortet nicht das eigene U-Boot
      const r = s.def.sonarRange, dx = s.x - e.x, dy = s.y - e.y;
      if (dx * dx + dy * dy <= r * r) {
        if (!by) by = e._sonarBy = new Set();
        by.add(s.owner);
      }
    }
  }
}
