// Authoritative fixed-tick match simulation. It has no DOM or rendering
// dependency, so the same code runs in the browser and under Node.
import * as K from './constants.js';
import { Arena } from './arena.js';
import { clamp, Rng, wrapAngle } from './math.js';
import { ACTION, ACTION_SIZE, OBS_SIZE } from './observation.js';
import { updateVision, writeObservation } from './sensors.js';

let sharedArena = null;
export const getArena = () => (sharedArena ??= new Arena());

const HIT_SPHERES = [
  { z: 1.6, r: 0.2, head: true },
  { z: 1.2, r: 0.36, head: false },
  { z: 0.82, r: 0.34, head: false },
  { z: 0.4, r: 0.3, head: false },
];

function makeBot(id, team) {
  return {
    id, team, name: K.ROSTER[id].name, persona: K.ROSTER[id],
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, yawRate: 0, pitchRate: 0,
    health: K.MAX_HEALTH, ammo: K.MAG_SIZE, reloadT: 0, fireCd: 0, spread: K.SPREAD_BASE, currentSpread: K.SPREAD_BASE,
    overchargeT: 0, protectT: 0, alive: true, respawnT: 0, deathT: 0, grounded: true, stuck: 0,
    hurt: 0, hurtAngle: 0, soundLevel: 0, soundAngle: 0, lastCombat: -99, lastShot: -99,
    spot: new Float32Array(K.BOT_COUNT), stickyTarget: -1,
    damageFrom: new Float32Array(K.BOT_COUNT).fill(-99),
    kills: 0, deaths: 0, assists: 0, damage: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0,
    obs: new Float32Array(OBS_SIZE), action: new Float32Array(ACTION_SIZE),
  };
}

export class World {
  constructor({ seed = 1, arena = getArena(), controllers = null } = {}) {
    this.seed = seed;
    this.arena = arena;
    this.rng = new Rng(seed);
    this.bots = Array.from({ length: K.BOT_COUNT }, (_, i) => makeBot(i, i < K.BOTS_PER_TEAM ? 0 : 1));
    this.controllers = controllers ?? [];
    this.tickCount = 0;
    this.time = 0;
    this.matchTime = 0;
    this.phase = 'warmup';
    this.phaseT = K.WARMUP_TIME;
    this.winner = -1;
    this.score = [0, 0];
    this.events = [];
    this.packs = arena.healthPacks.map(() => ({ active: true, timer: 0 }));
    this.overcharge = { active: false, timer: K.OVERCHARGE_FIRST };
    this.contacts = [new Array(K.BOT_COUNT).fill(null), new Array(K.BOT_COUNT).fill(null)];
    for (const bot of this.bots) this.spawn(bot, true);
  }

  emit(type, data) {
    this.events.push({ type, tick: this.tickCount, ...data });
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  spawn(bot, initial = false) {
    const points = this.arena.spawns[bot.team];
    let best = points[bot.id % K.BOTS_PER_TEAM];
    if (!initial) {
      let bestScore = -Infinity;
      for (const p of points) {
        let nearest = 40;
        for (const o of this.bots) {
          if (!o.alive || o === bot) continue;
          const d = Math.hypot(o.x - p.x, o.y - p.y);
          nearest = Math.min(nearest, o.team === bot.team ? d * 3 : d);
        }
        const score = nearest + this.rng.range(0, 4);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    Object.assign(bot, {
      x: best.x, y: best.y, vx: 0, vy: 0, vz: 0,
      yaw: bot.team === 0 ? 0 : Math.PI, pitch: 0, yawRate: 0, pitchRate: 0,
      health: K.MAX_HEALTH, ammo: K.MAG_SIZE, reloadT: 0, fireCd: 0, spread: K.SPREAD_BASE,
      overchargeT: 0, protectT: initial ? 0 : K.SPAWN_PROTECT, alive: true, grounded: true, stuck: 0,
      hurt: 0, soundLevel: 0, stickyTarget: -1,
    });
    bot.z = this.arena.heightAt(bot.x, bot.y);
    bot.spot.fill(0);
    bot.damageFrom.fill(-99);
    bot.action.fill(0);
    this.controllers[bot.id]?.reset?.();
    if (!initial) this.emit('spawn', { bot: bot.id, x: bot.x, y: bot.y, z: bot.z });
  }

  tick() {
    this.tickCount++;
    this.time += K.DT;
    if (this.phase === 'warmup') {
      this.phaseT -= K.DT;
      if (this.phaseT <= 0) {
        this.phase = 'live';
        this.emit('matchStart', {});
      }
    } else if (this.phase === 'live' || this.phase === 'overtime') {
      this.matchTime += K.DT;
      if (this.phase === 'live' && this.matchTime >= K.TIME_LIMIT) {
        if (this.score[0] === this.score[1]) {
          this.phase = 'overtime';
          this.emit('overtime', {});
        } else {
          this.finish(this.score[0] > this.score[1] ? 0 : 1);
        }
      }
    } else if (this.phase === 'ended') {
      this.phaseT -= K.DT;
    }

    const frozen = this.phase === 'warmup';
    const stopped = this.phase === 'ended';

    for (const bot of this.bots) {
      if (!bot.alive) {
        bot.deathT += K.DT;
        if (!stopped) {
          bot.respawnT -= K.DT;
          if (bot.respawnT <= 0) this.spawn(bot);
        }
        continue;
      }
      if (stopped) bot.action.fill(0);
      else if ((this.tickCount + bot.id) % K.BRAIN_INTERVAL === 0) this.think(bot);
      this.move(bot, frozen);
      if (!frozen && !stopped) this.weapon(bot);
    }
    this.separate();
    if (!frozen && !stopped) this.pickups();
  }

  think(bot) {
    updateVision(this, bot, K.BRAIN_INTERVAL * K.DT);
    const ctrl = this.controllers[bot.id];
    if (!ctrl) {
      bot.action.fill(0);
      return;
    }
    writeObservation(this, bot, bot.obs);
    ctrl.act(bot.obs, bot.action);
  }

  move(bot, frozen) {
    const a = bot.action;
    const dt = K.DT;
    const blend = 1 - Math.exp(-dt / K.TURN_TAU);
    bot.yawRate += (clamp(a[ACTION.yaw], -1, 1) * K.MAX_YAW_RATE - bot.yawRate) * blend;
    bot.pitchRate += (clamp(a[ACTION.pitch], -1, 1) * K.MAX_PITCH_RATE - bot.pitchRate) * blend;
    bot.yaw = wrapAngle(bot.yaw + bot.yawRate * dt);
    bot.pitch = clamp(bot.pitch + bot.pitchRate * dt, -K.PITCH_LIMIT, K.PITCH_LIMIT);

    let f = frozen ? 0 : clamp(a[ACTION.forward], -1, 1);
    let st = frozen ? 0 : clamp(a[ACTION.strafe], -1, 1);
    const mag = Math.hypot(f, st);
    if (mag > 1) {
      f /= mag;
      st /= mag;
    }
    const speed = f < 0 ? K.BACK_SPEED : K.RUN_SPEED;
    const c = Math.cos(bot.yaw);
    const s = Math.sin(bot.yaw);
    const wantX = (c * f - s * st) * speed;
    const wantY = (s * f + c * st) * speed;
    const accel = (bot.grounded ? K.GROUND_ACCEL : K.AIR_ACCEL) * dt;
    const dvx = wantX - bot.vx;
    const dvy = wantY - bot.vy;
    const dv = Math.hypot(dvx, dvy);
    const k = dv > accel ? accel / dv : 1;
    bot.vx += dvx * k;
    bot.vy += dvy * k;

    if (!frozen && bot.grounded && a[ACTION.jump] > 0) {
      bot.vz = K.JUMP_SPEED;
      bot.grounded = false;
      this.emit('jump', { bot: bot.id });
    }

    const arena = this.arena;
    const nx = bot.x + bot.vx * dt;
    const ny = bot.y + bot.vy * dt;
    let moved = 0;
    if (!arena.blocked(nx, bot.y, bot.z)) {
      moved += Math.abs(nx - bot.x);
      bot.x = nx;
    } else {
      bot.vx = 0;
    }
    if (!arena.blocked(bot.x, ny, bot.z)) {
      moved += Math.abs(ny - bot.y);
      bot.y = ny;
    } else {
      bot.vy = 0;
    }
    const wanted = Math.hypot(wantX, wantY) * dt;
    const blockage = wanted > 0.01 ? clamp(1 - moved / wanted, 0, 1) : 0;
    bot.stuck += (blockage - bot.stuck) * 0.08;

    const ground = arena.groundUnder(bot.x, bot.y, bot.z);
    bot.vz -= K.GRAVITY * dt;
    const nz = bot.z + bot.vz * dt;
    if (nz <= ground) {
      if (!bot.grounded && bot.vz < -6) this.emit('land', { bot: bot.id });
      bot.z = bot.z < ground ? Math.min(ground, bot.z + 9 * dt) : ground;
      bot.vz = 0;
      bot.grounded = true;
    } else {
      bot.z = nz;
      bot.grounded = false;
    }

    bot.hurt = Math.max(0, bot.hurt - dt);
    bot.soundLevel = Math.max(0, bot.soundLevel - dt * 2);
    bot.protectT = Math.max(0, bot.protectT - dt);
    if (bot.overchargeT > 0) {
      bot.overchargeT = Math.max(0, bot.overchargeT - dt);
      if (bot.overchargeT === 0) this.emit('overchargeEnd', { bot: bot.id });
    }

    const moving = Math.hypot(bot.vx, bot.vy) / K.RUN_SPEED;
    bot.spread = Math.max(K.SPREAD_BASE, bot.spread - K.SPREAD_DECAY * dt);
    bot.currentSpread = Math.min(
      K.SPREAD_MAX,
      bot.spread + moving * K.SPREAD_MOVE + (bot.grounded ? 0 : K.SPREAD_AIR),
    );
  }

  weapon(bot) {
    const a = bot.action;
    bot.fireCd -= K.DT;
    if (bot.reloadT > 0) {
      bot.reloadT -= K.DT;
      if (bot.reloadT <= 0) {
        bot.reloadT = 0;
        bot.ammo = K.MAG_SIZE;
        this.emit('reloaded', { bot: bot.id });
      }
      return;
    }
    if ((a[ACTION.reload] > 0 && bot.ammo < K.MAG_SIZE) || bot.ammo === 0) {
      bot.reloadT = K.RELOAD_TIME;
      this.emit('reload', { bot: bot.id });
      return;
    }
    if (a[ACTION.fire] > 0 && bot.fireCd <= 0) this.fire(bot);
  }

  aimDirection(bot, spread, out) {
    let yaw = bot.yaw;
    let pitch = bot.pitch;
    if (spread > 0) {
      const r = spread * Math.sqrt(this.rng.next());
      const t = this.rng.range(0, 2 * Math.PI);
      yaw += Math.cos(t) * r;
      pitch += Math.sin(t) * r;
    }
    const cp = Math.cos(pitch);
    out.x = Math.cos(yaw) * cp;
    out.y = Math.sin(yaw) * cp;
    out.z = Math.sin(pitch);
    return out;
  }

  /** Nearest enemy struck by a ray closer than `limit`. */
  traceBots(bot, ox, oy, oz, d, limit) {
    let best = null;
    let bestT = limit;
    let bestHead = false;
    for (const o of this.bots) {
      if (o.team === bot.team || !o.alive) continue;
      for (const sp of HIT_SPHERES) {
        const cx = o.x - ox;
        const cy = o.y - oy;
        const cz = o.z + sp.z - oz;
        const proj = cx * d.x + cy * d.y + cz * d.z;
        if (proj < 0) continue;
        const dist2 = cx * cx + cy * cy + cz * cz - proj * proj;
        if (dist2 > sp.r * sp.r) continue;
        const t = proj - Math.sqrt(sp.r * sp.r - dist2);
        if (t < bestT) {
          bestT = t;
          best = o;
          bestHead = sp.head;
        }
      }
    }
    return best ? { bot: best, t: bestT, head: bestHead } : null;
  }

  /** Would a perfectly accurate shot right now hit an enemy? */
  onTarget(bot) {
    const d = this.aimDirection(bot, 0, {});
    const oz = bot.z + K.EYE_HEIGHT;
    const wall = this.arena.raycast(bot.x, bot.y, oz, d.x, d.y, d.z, K.WEAPON_RANGE);
    return this.traceBots(bot, bot.x, bot.y, oz, d, wall) !== null;
  }

  fire(bot) {
    const d = this.aimDirection(bot, bot.currentSpread, {});
    const oz = bot.z + K.EYE_HEIGHT;
    const wall = this.arena.raycast(bot.x, bot.y, oz, d.x, d.y, d.z, K.WEAPON_RANGE);
    const hit = this.traceBots(bot, bot.x, bot.y, oz, d, wall);
    const t = hit ? hit.t : wall;

    bot.ammo--;
    bot.fireCd = K.FIRE_INTERVAL;
    bot.spread = Math.min(K.SPREAD_MAX, bot.spread + K.SPREAD_BLOOM);
    bot.shots++;
    bot.protectT = 0;
    bot.lastCombat = this.time;
    bot.lastShot = this.time;

    this.emit('shot', {
      bot: bot.id,
      fx: bot.x + d.x * 0.5, fy: bot.y + d.y * 0.5, fz: oz + d.z * 0.5 - 0.2,
      tx: bot.x + d.x * t, ty: bot.y + d.y * t, tz: oz + d.z * t,
      hitBot: hit ? hit.bot.id : -1, wall: !hit && wall < K.WEAPON_RANGE,
      overcharged: bot.overchargeT > 0,
    });

    for (const o of this.bots) {
      if (o.team === bot.team || !o.alive) continue;
      const dist = Math.hypot(o.x - bot.x, o.y - bot.y);
      if (dist < K.HEARING_RANGE) {
        const level = 1 / (1 + dist / 10);
        if (level >= o.soundLevel) {
          o.soundLevel = level;
          o.soundAngle = Math.atan2(bot.y - o.y, bot.x - o.x);
        }
        this.contacts[o.team][bot.id] = { x: bot.x, y: bot.y, t: this.time };
      }
    }

    if (hit) this.damage(bot, hit.bot, hit.head);
  }

  damage(from, to, head) {
    if (to.protectT > 0) {
      this.emit('blocked', { bot: to.id });
      return;
    }
    const base = head ? K.DAMAGE_HEAD : K.DAMAGE_BODY;
    const amount = base * (from.overchargeT > 0 ? K.OVERCHARGE_MULT : 1);
    const dealt = Math.min(to.health, amount);
    to.health -= amount;
    from.hits++;
    from.damage += dealt;
    from.lastCombat = this.time;
    to.lastCombat = this.time;
    to.hurt = 1;
    to.hurtAngle = Math.atan2(from.y - to.y, from.x - to.x);
    to.damageFrom[from.id] = this.time;
    this.contacts[to.team][from.id] = { x: from.x, y: from.y, t: this.time };
    this.emit('hit', { bot: to.id, by: from.id, amount, head, health: Math.max(0, to.health), x: to.x, y: to.y, z: to.z });
    if (to.health <= 0) this.kill(from, to, head);
  }

  kill(killer, victim, head) {
    const victimOvercharged = victim.overchargeT > 0;
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.respawnT = K.RESPAWN_TIME;
    victim.deathT = 0;
    victim.streak = 0;
    victim.overchargeT = 0;
    killer.kills++;
    killer.streak++;
    killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
    const assists = [];
    for (const o of this.bots) {
      if (o !== killer && o.team === killer.team && this.time - victim.damageFrom[o.id] < K.ASSIST_WINDOW) {
        o.assists++;
        assists.push(o.id);
      }
    }
    this.contacts[killer.team][victim.id] = null;
    this.score[killer.team]++;
    this.emit('kill', {
      bot: killer.id, victim: victim.id, head, streak: killer.streak, assists,
      killerHealth: killer.health, victimOvercharged,
      x: victim.x, y: victim.y, z: victim.z, score: [...this.score],
    });
    if (this.phase === 'overtime' || this.score[killer.team] >= K.FRAG_LIMIT) this.finish(killer.team);
  }

  finish(team) {
    this.phase = 'ended';
    this.phaseT = K.END_TIME;
    this.winner = team;
    const winners = this.bots.filter((b) => b.team === team);
    const mvp = winners.reduce((m, b) => (b.kills * 2 + b.assists > m.kills * 2 + m.assists ? b : m));
    this.emit('matchEnd', { team, mvp: mvp.id, score: [...this.score] });
  }

  separate() {
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const a = bots[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < bots.length; j++) {
        const b = bots[j];
        if (!b.alive || Math.abs(a.z - b.z) > K.BOT_HEIGHT) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = K.BOT_RADIUS * 2;
        if (d >= min || d < 1e-6) continue;
        const push = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        if (!this.arena.blocked(a.x - nx * push, a.y - ny * push, a.z)) {
          a.x -= nx * push;
          a.y -= ny * push;
        }
        if (!this.arena.blocked(b.x + nx * push, b.y + ny * push, b.z)) {
          b.x += nx * push;
          b.y += ny * push;
        }
      }
    }
  }

  pickups() {
    const reach = (bot, p) =>
      Math.hypot(bot.x - p.x, bot.y - p.y) < K.PICKUP_RADIUS &&
      Math.abs(bot.z - this.arena.heightAt(p.x, p.y)) < 1.5;

    this.packs.forEach((pack, i) => {
      if (!pack.active) {
        pack.timer -= K.DT;
        if (pack.timer <= 0) {
          pack.active = true;
          this.emit('packUp', { pack: i });
        }
        return;
      }
      const spot = this.arena.healthPacks[i];
      for (const bot of this.bots) {
        if (bot.alive && bot.health < K.MAX_HEALTH && reach(bot, spot)) {
          bot.health = Math.min(K.MAX_HEALTH, bot.health + K.HEALTH_PACK);
          pack.active = false;
          pack.timer = K.HEALTH_RESPAWN;
          this.emit('packTaken', { pack: i, bot: bot.id });
          break;
        }
      }
    });

    const oc = this.overcharge;
    if (!oc.active) {
      oc.timer -= K.DT;
      if (oc.timer <= 0) {
        oc.active = true;
        this.emit('overchargeUp', {});
      }
      return;
    }
    for (const bot of this.bots) {
      if (bot.alive && reach(bot, this.arena.overcharge)) {
        oc.active = false;
        oc.timer = K.OVERCHARGE_RESPAWN;
        bot.overchargeT = K.OVERCHARGE_DURATION;
        this.emit('overchargeTaken', { bot: bot.id });
        break;
      }
    }
  }
}
