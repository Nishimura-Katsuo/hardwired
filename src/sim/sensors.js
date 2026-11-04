// Sensors translate world state into the observation vector. They compute
// perception (sight, hearing, routes) but choose nothing: all decisions are
// left to the network.
import {
  AIM_NOISE, BOTS_PER_TEAM, CONTACT_MEMORY, EYE_HEIGHT, FRAG_LIMIT, MAG_SIZE, MAX_HEALTH, OVERCHARGE_DURATION,
  OVERCHARGE_RESPAWN, PITCH_LIMIT, PROXIMITY_RANGE, REACTION_TIME, RUN_SPEED, SPAWN_PROTECT, SPREAD_MAX,
  TIME_LIMIT, VIEW_HALF_FOV, VIEW_RANGE,
} from './constants.js';
import { MAP_H, MAP_W } from './arena.js';
import { clamp, wrapAngle } from './math.js';
import {
  ALLIES, ALLY_FIELDS, ALLY_SLOTS, ENEMIES, ENEMY_FIELDS, ENEMY_SLOTS, GOAL_FIELDS, GOAL_NAMES, GOALS,
  HURT, RAY_ANGLES_DEG, RAY_DIST, RAY_FLOOR, SELF, SOUND,
} from './observation.js';

const RAY_RADIANS = RAY_ANGLES_DEG.map((d) => (d * Math.PI) / 180);
const RAY_RANGE = 30;
const CHEST_HEIGHT = 1.1;
const steerOut = { x: 0, y: 0, dist: 0 };

export function canSee(world, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d > VIEW_RANGE) return false;
  const off = Math.abs(wrapAngle(Math.atan2(dy, dx) - a.yaw));
  if (off > VIEW_HALF_FOV && d > PROXIMITY_RANGE) return false;
  const eye = a.z + EYE_HEIGHT;
  return (
    world.arena.lineOfSight(a.x, a.y, eye, b.x, b.y, b.z + EYE_HEIGHT) ||
    world.arena.lineOfSight(a.x, a.y, eye, b.x, b.y, b.z + CHEST_HEIGHT)
  );
}

/** Advance one bot's spot timers and share what it sees with its team. */
export function updateVision(world, bot, dt) {
  for (const other of world.bots) {
    if (other.team === bot.team) continue;
    const seen = other.alive && canSee(world, bot, other);
    bot.spot[other.id] = seen ? bot.spot[other.id] + dt : 0;
    if (seen) world.contacts[bot.team][other.id] = { x: other.x, y: other.y, t: world.time };
  }
}

function writeGoal(world, bot, out, i, target) {
  const base = GOALS + i * GOAL_FIELDS.length;
  out[base + 3] = 1;
  if (!target) return;
  if (!world.arena.steer(bot.x, bot.y, bot.z, target.x, target.y, steerOut)) return;
  const dx = steerOut.x - bot.x;
  const dy = steerOut.y - bot.y;
  const rel = dx === 0 && dy === 0 ? 0 : wrapAngle(Math.atan2(dy, dx) - bot.yaw);
  out[base] = 1;
  out[base + 1] = Math.sin(rel);
  out[base + 2] = Math.cos(rel);
  out[base + 3] = clamp(steerOut.dist / 60, 0, 1);
}

function nearestByPath(world, bot, items) {
  let best = null;
  let bestD = Infinity;
  const c = world.arena.cell(bot.x, bot.y);
  for (const item of items) {
    const d = c < 0 ? Infinity : world.arena.field(world.arena.cell(item.x, item.y))[c];
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

function findCover(world, bot, threat) {
  if (!threat) return null;
  const eye = threat.z + EYE_HEIGHT;
  let best = null;
  let bestScore = Infinity;
  for (const p of world.arena.coverPoints) {
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d > 12 || d < 0.75) continue;
    const away = Math.hypot(p.x - threat.x, p.y - threat.y);
    if (away < 3) continue;
    const score = d - away * 0.25;
    if (score >= bestScore) continue;
    if (world.arena.lineOfSight(threat.x, threat.y, eye, p.x, p.y, p.z + EYE_HEIGHT)) continue;
    best = p;
    bestScore = score;
  }
  return best;
}

function teamContact(world, bot) {
  let best = null;
  let bestD = Infinity;
  for (const c of world.contacts[bot.team]) {
    if (!c || world.time - c.t > CONTACT_MEMORY) continue;
    const d = Math.hypot(c.x - bot.x, c.y - bot.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function selectEnemies(world, bot, dst) {
  dst.length = 0;
  for (const other of world.bots) {
    if (other.team !== bot.team && other.alive && bot.spot[other.id] >= REACTION_TIME) dst.push(other);
  }
  dst.sort((p, q) => {
    if (p.id === bot.stickyTarget) return -1;
    if (q.id === bot.stickyTarget) return 1;
    return Math.hypot(p.x - bot.x, p.y - bot.y) - Math.hypot(q.x - bot.x, q.y - bot.y);
  });
  bot.stickyTarget = dst.length ? dst[0].id : -1;
  return dst;
}

const visible = [];

export function writeObservation(world, bot, out) {
  const { arena } = world;
  out.fill(0);

  // Self.
  const s = Math.sin(bot.yaw);
  const c = Math.cos(bot.yaw);
  out[SELF.health] = bot.health / MAX_HEALTH;
  out[SELF.ammo] = bot.ammo / MAG_SIZE;
  out[SELF.reloading] = bot.reloadT > 0 ? 1 : 0;
  out[SELF.overcharge] = bot.overchargeT / OVERCHARGE_DURATION;
  out[SELF.grounded] = bot.grounded ? 1 : 0;
  out[SELF.velForward] = clamp((bot.vx * c + bot.vy * s) / RUN_SPEED, -1, 1);
  out[SELF.velStrafe] = clamp((-bot.vx * s + bot.vy * c) / RUN_SPEED, -1, 1);
  out[SELF.pitch] = bot.pitch / PITCH_LIMIT;
  out[SELF.sinYaw] = s;
  out[SELF.cosYaw] = c;
  out[SELF.posX] = clamp(bot.x / (MAP_W / 2) - 1, -1, 1);
  out[SELF.posY] = clamp(bot.y / (MAP_H / 2) - 1, -1, 1);
  out[SELF.posZ] = clamp(bot.z / 3, -1, 1);
  out[SELF.spawnProtect] = bot.protectT / SPAWN_PROTECT;
  out[SELF.spread] = clamp(bot.currentSpread / SPREAD_MAX, 0, 1);
  out[SELF.onTarget] = world.onTarget(bot) ? 1 : 0;
  out[SELF.timeLeft] = clamp((TIME_LIMIT - world.matchTime) / TIME_LIMIT, 0, 1);
  out[SELF.scoreDiff] = clamp((world.score[bot.team] - world.score[1 - bot.team]) / FRAG_LIMIT, -1, 1);
  out[SELF.overchargeWait] = world.overcharge.active ? 0 : clamp(world.overcharge.timer / OVERCHARGE_RESPAWN, 0, 1);
  out[SELF.stuck] = clamp(bot.stuck, 0, 1);
  out[SELF.aggression] = bot.persona.aggression;
  out[SELF.caution] = bot.persona.caution;
  out[SELF.discipline] = bot.persona.discipline;
  let alive = 0;
  for (const b of world.bots) if (b.team === bot.team && b.alive) alive++;
  out[SELF.aliveRatio] = alive / BOTS_PER_TEAM;
  out[SELF.bias] = 1;

  // Depth rays and floor probes.
  const rayZ = bot.z + 0.6;
  for (let i = 0; i < RAY_RADIANS.length; i++) {
    const a = bot.yaw + RAY_RADIANS[i];
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const d = arena.raycast(bot.x, bot.y, rayZ, dx, dy, 0, RAY_RANGE);
    out[RAY_DIST + i] = 1 / (1 + d);
    const probe = arena.heightAt(bot.x + dx * 1.5, bot.y + dy * 1.5);
    out[RAY_FLOOR + i] = clamp((probe - bot.z) / 3, -1, 1);
  }

  // Enemies.
  selectEnemies(world, bot, visible);
  for (let slot = 0; slot < ENEMY_SLOTS; slot++) {
    const e = visible[slot];
    if (!e) continue;
    const base = ENEMIES + slot * ENEMY_FIELDS.length;
    const dx = e.x - bot.x;
    const dy = e.y - bot.y;
    const d = Math.max(0.01, Math.hypot(dx, dy));
    const rel = wrapAngle(Math.atan2(dy, dx) - bot.yaw + world.rng.gauss() * AIM_NOISE);
    const elevation = Math.atan2(e.z + CHEST_HEIGHT - (bot.z + EYE_HEIGHT), d);
    // Angular rate of the enemy across the bot's view, in rad/s (+ = moving to bot's left).
    const omega = (dx * (e.vy - bot.vy) - dy * (e.vx - bot.vx)) / (d * d);
    out[base] = 1;
    out[base + 1] = rel / Math.PI;
    out[base + 2] = Math.sin(rel);
    out[base + 3] = Math.cos(rel);
    out[base + 4] = clamp((elevation - bot.pitch + world.rng.gauss() * AIM_NOISE) / 0.5, -1, 1);
    out[base + 5] = clamp(d / VIEW_RANGE, 0, 1);
    out[base + 6] = 1 / (1 + d / 4);
    out[base + 7] = clamp(omega / 3, -1, 1);
    out[base + 8] = e.health / MAX_HEALTH;
    out[base + 9] = Math.cos(wrapAngle(Math.atan2(-dy, -dx) - e.yaw));
    out[base + 10] = e.overchargeT > 0 ? 1 : 0;
  }

  // Allies, nearest first.
  const allies = world.bots
    .filter((b) => b.team === bot.team && b !== bot && b.alive)
    .sort((p, q) => Math.hypot(p.x - bot.x, p.y - bot.y) - Math.hypot(q.x - bot.x, q.y - bot.y));
  for (let slot = 0; slot < ALLY_SLOTS; slot++) {
    const a = allies[slot];
    if (!a) continue;
    const base = ALLIES + slot * ALLY_FIELDS.length;
    const dx = a.x - bot.x;
    const dy = a.y - bot.y;
    const rel = wrapAngle(Math.atan2(dy, dx) - bot.yaw);
    out[base] = 1;
    out[base + 1] = Math.sin(rel);
    out[base + 2] = Math.cos(rel);
    out[base + 3] = 1 / (1 + Math.hypot(dx, dy) / 4);
    out[base + 4] = a.health / MAX_HEALTH;
    out[base + 5] = world.time - a.lastCombat < 1 ? 1 : 0;
  }

  // Pain and hearing.
  if (bot.hurt > 0) {
    const rel = wrapAngle(bot.hurtAngle - bot.yaw);
    out[HURT.level] = bot.hurt;
    out[HURT.sin] = Math.sin(rel);
    out[HURT.cos] = Math.cos(rel);
  }
  if (bot.soundLevel > 0) {
    const rel = wrapAngle(bot.soundAngle - bot.yaw);
    out[SOUND.level] = bot.soundLevel;
    out[SOUND.sin] = Math.sin(rel);
    out[SOUND.cos] = Math.cos(rel);
  }

  // Route goals.
  const packs = arena.healthPacks.filter((_, i) => world.packs[i].active);
  const lm = arena.landmarks[bot.team];
  const targets = {
    health: packs.length ? nearestByPath(world, bot, packs) : null,
    overcharge: world.overcharge.active ? arena.overcharge : null,
    contact: teamContact(world, bot),
    ally: allies[0] ?? null,
    north: lm.north,
    mid: lm.mid,
    south: lm.south,
    enemyBase: lm.enemyBase,
    cover: findCover(world, bot, visible[0] ?? null),
  };
  for (let i = 0; i < GOAL_NAMES.length; i++) writeGoal(world, bot, out, i, targets[GOAL_NAMES[i]]);
  return out;
}
