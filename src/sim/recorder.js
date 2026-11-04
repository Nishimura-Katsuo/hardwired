// A rolling tape of the match. Rendering always reads from this tape, so live
// play and instant replay are the same code path at different playheads.
import { BOT_COUNT, DT, TICK_RATE } from './constants.js';
import { lerp, wrapAngle } from './math.js';

const CAPACITY = TICK_RATE * 15;
const FIELDS = [
  'x', 'y', 'z', 'yaw', 'pitch', 'vx', 'vy', 'health', 'alive', 'deathT',
  'overcharge', 'reload', 'protect', 'shotAge', 'gait', 'ammo', 'hurt',
];
const F = Object.fromEntries(FIELDS.map((n, i) => [n, i]));
const STRIDE = FIELDS.length;
const FRAME = BOT_COUNT * STRIDE + 2;
const HARD_FIELDS = new Set(['alive', 'ammo']);

export function createView() {
  return {
    tick: 0,
    packMask: 0,
    overchargeActive: false,
    bots: Array.from({ length: BOT_COUNT }, (_, id) => ({ id, team: id < BOT_COUNT / 2 ? 0 : 1 })),
  };
}

export class Recorder {
  constructor() {
    this.frames = new Float32Array(CAPACITY * FRAME);
    this.events = Array.from({ length: CAPACITY }, () => []);
    this.ticks = new Int32Array(CAPACITY).fill(-1);
    this.head = -1;
    this.oldest = -1;
    this.gait = new Float32Array(BOT_COUNT);
  }

  clear() {
    this.ticks.fill(-1);
    this.head = -1;
    this.oldest = -1;
    this.gait.fill(0);
  }

  capture(world) {
    const tick = world.tickCount;
    const slot = tick % CAPACITY;
    const base = slot * FRAME;
    const f = this.frames;
    for (const bot of world.bots) {
      const o = base + bot.id * STRIDE;
      this.gait[bot.id] += Math.hypot(bot.vx, bot.vy) * DT;
      f[o + F.x] = bot.x;
      f[o + F.y] = bot.y;
      f[o + F.z] = bot.z;
      f[o + F.yaw] = bot.yaw;
      f[o + F.pitch] = bot.pitch;
      f[o + F.vx] = bot.vx;
      f[o + F.vy] = bot.vy;
      f[o + F.health] = Math.max(0, bot.health);
      f[o + F.alive] = bot.alive ? 1 : 0;
      f[o + F.deathT] = bot.alive ? 0 : bot.deathT;
      f[o + F.overcharge] = bot.overchargeT;
      f[o + F.reload] = bot.reloadT;
      f[o + F.protect] = bot.protectT;
      f[o + F.shotAge] = Math.min(9, world.time - bot.lastShot);
      f[o + F.gait] = this.gait[bot.id];
      f[o + F.ammo] = bot.ammo;
      f[o + F.hurt] = bot.hurt;
    }
    let mask = 0;
    world.packs.forEach((p, i) => {
      if (p.active) mask |= 1 << i;
    });
    f[base + FRAME - 2] = mask;
    f[base + FRAME - 1] = world.overcharge.active ? 1 : 0;
    this.ticks[slot] = tick;
    this.events[slot] = [];
    this.head = tick;
    this.oldest = this.oldest < 0 ? tick : Math.max(this.oldest, tick - CAPACITY + 1);
  }

  addEvent(event) {
    if (this.head >= 0) this.events[event.tick % CAPACITY].push(event);
  }

  eventsAt(tick) {
    const slot = tick % CAPACITY;
    return this.ticks[slot] === tick ? this.events[slot] : [];
  }

  /** Writes the interpolated state at fractional `tick` into `view`. */
  sample(tick, view) {
    tick = Math.max(this.oldest, Math.min(this.head, tick));
    const t0 = Math.floor(tick);
    const t1 = Math.min(this.head, t0 + 1);
    const a = tick - t0;
    const b0 = (t0 % CAPACITY) * FRAME;
    const b1 = (t1 % CAPACITY) * FRAME;
    const f = this.frames;
    for (const bot of view.bots) {
      const o0 = b0 + bot.id * STRIDE;
      const o1 = b1 + bot.id * STRIDE;
      const respawned = f[o0 + F.alive] !== f[o1 + F.alive];
      for (let i = 0; i < STRIDE; i++) {
        const name = FIELDS[i];
        const v0 = f[o0 + i];
        const v1 = f[o1 + i];
        if (name === 'yaw') bot.yaw = v0 + wrapAngle(v1 - v0) * a;
        else if (respawned || HARD_FIELDS.has(name)) bot[name] = v0;
        else bot[name] = lerp(v0, v1, a);
      }
      bot.alive = bot.alive > 0.5;
    }
    view.tick = tick;
    view.packMask = f[b0 + FRAME - 2];
    view.overchargeActive = f[b0 + FRAME - 1] > 0.5;
    return view;
  }
}
