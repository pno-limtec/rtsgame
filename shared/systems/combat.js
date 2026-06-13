// Kampfsystem: Zielerfassung, Feuern, Projektile, Flächenschaden.
import { DT, SUB_EXPOSE_TIME } from '../constants.js';
import { nearestEnemy, applyDamage, targetClass, dist, isDetectable } from '../world.js';
import { inBounds, tIdx, worldToTile } from '../terrain.js';
import { setMoveGoal } from './movement.js';

const ENGAGE = new Set(['idle', 'attackmove', 'attack', 'hold', 'guard', 'patrol', 'harvest']);

export function stepCombat(world) {
  for (const e of world.entities.values()) {
    if (e.dead || e.abandoned || !e.weapon) continue;
    if (e.etype === 'building' && e.buildProgress < 1) continue;
    if (e.cd > 0) e.cd -= DT;

    const order = e.order ? e.order.type : 'idle';
    const wantEngage = e.etype === 'building' || ENGAGE.has(order);

    // bestehendes Ziel validieren
    let tgt = e.target != null ? world.entities.get(e.target) : null;
    if (tgt && (tgt.dead || tgt.hp <= 0)) { tgt = null; e.target = null; }
    // Lock auf ein wieder abgetauchtes U-Boot verlieren
    if (tgt && tgt.submerged && !isDetectable(world, e, tgt)) { tgt = null; e.target = null; }
    // Luftfahrzeuge ohne Bordmunition feuern nicht (stepAir schickt sie zur Basis)
    if (e.muniMax && e.muni <= 0) continue;

    // explizites Angriffsziel
    if (order === 'attack' && e.order.targetId != null) {
      const ot = world.entities.get(e.order.targetId);
      if (ot && !ot.dead) tgt = ot; else { e.order = { type: 'idle' }; }
    }

    if (!tgt && wantEngage) {
      const range = acquireRange(world, e);
      tgt = nearestEnemy(world, e, range);
      if (tgt) e.target = tgt.id;
    }

    if (!tgt) continue;

    const d = dist(e, tgt);
    if (d <= weaponRange(world, e, tgt) && d >= (e.weapon.minRange || 0)) {
      e.facing = Math.atan2(tgt.y - e.y, tgt.x - e.x);
      if (e.cd <= 0) fire(world, e, tgt);
    } else if (e.etype === 'unit' && order !== 'move' && order !== 'hold') {
      // Verfolgen (gedrosseltes Repathing)
      e._chaseCd = (e._chaseCd || 0) - DT;
      if (e._chaseCd <= 0) { setMoveGoal(world, e, tgt.x, tgt.y); e._chaseCd = 0.6; }
    }
  }
  stepProjectiles(world);
}

function terrainHeight(world, e) {
  if (!world?.terrain || !e) return 0;
  const [tx, ty] = worldToTile(e.x, e.y);
  const t = world.terrain;
  return inBounds(t, tx, ty) ? t.height[tIdx(t, tx, ty)] : 0;
}

function heightRangeMult(world, e, tgt = null) {
  if (!e || e.domain === 'air') return 1;
  const eh = terrainHeight(world, e);
  let mult = 1 + Math.max(0, Math.min(0.14, (eh - 0.56) * 0.22));
  if (tgt && tgt.domain !== 'air') {
    const dh = eh - terrainHeight(world, tgt);
    mult += Math.max(-0.10, Math.min(0.18, dh * 0.45));
  }
  return Math.max(0.88, Math.min(1.26, mult));
}

function weaponRange(world, e, tgt = null) {
  return e.weapon.range * heightRangeMult(world, e, tgt);
}

function acquireRange(world, e) {
  const mult = heightRangeMult(world, e);
  const wr = e.weapon.range * mult;
  return Math.max(wr, e.etype === 'unit' ? e.sight * mult : wr + 2);
}

function fire(world, e, tgt) {
  const p = world.players.find(pp => pp.id === e.owner);
  const ammoCost = e.weapon.ammo || 0;
  if (p && ammoCost) {
    if ((p.resources.ammo || 0) < ammoCost) return; // kein Nachschub → kein Feuer
    p.resources.ammo -= ammoCost;
  }
  e.cd = e.weapon.cooldown;
  if (e.muniMax) e.muni -= 1;                                  // Luft: Bordmunition verbrauchen
  if (e.submerged) e._exposeUntil = world.time + SUB_EXPOSE_TIME; // U-Boot taucht beim Feuern auf
  world.projectiles.push({
    x: e.x, y: e.y, speed: e.weapon.speed, dmg: e.weapon.damage * (e.vetDmgMult || 1),
    splash: e.weapon.splash || 0, vs: e.weapon.vs, owner: e.owner, attackerId: e.id,
    targetId: tgt.id, gx: tgt.x, gy: tgt.y,
  });
  world.events.push({ type: 'fire', x: e.x, y: e.y, tx: tgt.x, ty: tgt.y, kind: e.weapon.name });
}

function stepProjectiles(world) {
  const live = [];
  for (const pr of world.projectiles) {
    const tgt = world.entities.get(pr.targetId);
    if (tgt && !tgt.dead) { pr.gx = tgt.x; pr.gy = tgt.y; }
    const dx = pr.gx - pr.x, dy = pr.gy - pr.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const step = pr.speed * DT;
    if (d <= step) { detonate(world, pr, tgt); continue; }
    pr.x += (dx / d) * step; pr.y += (dy / d) * step;
    live.push(pr);
  }
  world.projectiles = live;
}

function detonate(world, pr, tgt) {
  world.events.push({ type: 'explosion', x: pr.gx, y: pr.gy, splash: pr.splash });
  const attacker = pr.attackerId != null ? world.entities.get(pr.attackerId) : null; // für Veteranen-XP
  if (pr.splash > 0) {
    for (const o of world.entities.values()) {
      if (o.dead || o.owner === pr.owner) continue;
      const dd = Math.hypot(o.x - pr.gx, o.y - pr.gy);
      if (dd <= pr.splash) {
        const cls = targetClass(o);
        const falloff = 1 - dd / pr.splash * 0.6;
        applyDamage(world, o, pr.dmg * (pr.vs[cls] || 0.3) * falloff, attacker);
      }
    }
  } else if (tgt && !tgt.dead) {
    const cls = targetClass(tgt);
    applyDamage(world, tgt, pr.dmg * (pr.vs[cls] || 0.3), attacker);
  }
}
