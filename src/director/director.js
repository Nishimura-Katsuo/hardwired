// The spectator director runs the broadcast. It scores what is happening, and
// what is about to happen, then chooses a subject, a camera rig, and when to cut.
// It only reads the recorder's view and the event stream, so it runs headlessly.
import { BOT_COUNT, EYE_HEIGHT, TICK_RATE } from '../sim/constants.js';
import { clamp, Rng, wrapAngle } from '../sim/math.js';
import { canSeePoint, isClear, viewBlockage } from './framing.js';

const MIN_HOLD = 2.6;
const MAX_HOLD = 9;
const DECISION_INTERVAL = 0.2;
const DEATH_BEAT = 0.9;
const SWITCH_MARGIN = 1.35;

const REPLAY_COOLDOWN = 22;
const REPLAY_THRESHOLD = 3;
const REPLAY_DELAY = 1.5;
const REPLAY_LEAD = 3 * TICK_RATE;
const REPLAY_TAIL = 0.8 * TICK_RATE;
const REPLAY_SPEED = 0.45;

export const RIG_LABELS = {
  shoulder: 'Shoulder cam',
  pov: 'Helmet cam',
  duel: 'Sideline',
  tower: 'Tower',
  crane: 'Jib',
  overview: 'Wide',
  replayOrbit: 'Replay',
  replayKiller: 'Replay',
  victory: 'Winner',
};

const RIG_WEIGHTS = {
  duel: { duel: 3, shoulder: 2, tower: 2, pov: 1.5, crane: 1 },
  approach: { shoulder: 3, pov: 2.2, tower: 1.5, crane: 1 },
  objective: { crane: 3, tower: 2, shoulder: 1.5, pov: 1 },
  lull: { overview: 2, tower: 2, shoulder: 2, crane: 1 },
};

// A camera must keep this far from geometry, and may lose this much of its frame.
const CAMERA_CLEARANCE = 0.7;
const MAX_PLACED_BLOCKAGE = 0.2;
// Past these limits the shot is bad, and the director cuts away after BAD_VIEW_LIMIT.
const BAD_BLOCKAGE = 0.34;
const BAD_VIEW_LIMIT = 0.6;
const BAD_POV_LIMIT = 0.3;
const POV_FOV = 82;
const OCCLUDED_SNAP = 0.25;
const RETRY_BEST_SPOT = 0.5;

/** Alternatives to a rig's ideal position, cheapest change first. */
const SPOTS = (() => {
  const spots = [];
  for (const scale of [1, 0.8, 0.6]) {
    for (const lift of [0, 1.5, 3, 5, 7.5]) {
      for (const az of [0, Math.PI, 0.6, -0.6, 1.2, -1.2, 2, -2]) {
        spots.push({ scale, lift, az, cost: (1 - scale) * 2.5 + lift / 6 + Math.abs(az) / 2.5 });
      }
    }
  }
  return spots.sort((p, q) => p.cost - q.cost);
})();

const TOWER_THROW = 42;
const TOWERS = [
  [32, -11, 24], [32, 51, 24], [-11, 20, 24], [75, 20, 24],
  [-7, -7, 27], [71, 47, 27], [71, -7, 27], [-7, 47, 27],
];

function damp(current, target, tau, dt) {
  return target + (current - target) * Math.exp(-dt / Math.max(tau, 1e-4));
}

const head = (b) => [b.x, b.y, b.z + 1.5];
const chest = (b) => [b.x, b.y, b.z + 1.1];

export class Director {
  constructor(arena, { seed = 1 } = {}) {
    this.arena = arena;
    this.rng = new Rng(seed ^ 0x51ed);
    this.camera = { pos: [32, -8, 20], look: [32, 20, 0], fov: 55, roll: 0, hideBot: -1, viewmodel: false };
    this.shot = { rig: 'overview', a: 0, b: -1, kind: 'lull' };
    this.shotAge = 0;
    this.lastRigs = [];
    this.cutCount = 0;
    this.time = 0;
    this.decideT = 0;
    this.lockBot = -1;
    this.lockRig = null;
    this.snap = true;
    this.spot = 0;
    this.spotAge = 0;
    this.badView = 0;
    this.occluded = 0;
    this.smooth = { pos: [32, -8, 20], look: [32, 20, 0], fov: 55 };
    this.orbit = 0;
    this.side = 1;
    this.heat = new Float32Array(BOT_COUNT);
    this.recentKills = [];
    this.pending = null;
    this.lastReplayAt = -REPLAY_COOLDOWN + 10;
    this.lastKill = null;
    this.bestKill = null;
    this.replay = null;
    this.mvp = 0;
    this.ended = false;
  }

  resetMatch() {
    this.heat.fill(0);
    this.recentKills = [];
    this.pending = null;
    this.lastKill = null;
    this.bestKill = null;
    this.replay = null;
    this.ended = false;
    this.lastReplayAt = this.time - REPLAY_COOLDOWN + 10;
    this.cut({ rig: 'overview', a: 0, b: -1, kind: 'lull' });
  }

  cut(shot) {
    this.shot = shot;
    this.shotAge = 0;
    this.snap = true;
    this.cutCount++;
    this.orbit = this.rng.range(0, Math.PI * 2);
    this.side = this.rng.next() < 0.5 ? -1 : 1;
    this.spot = 0;
    this.badView = 0;
    this.lastRigs.unshift(shot.rig);
    this.lastRigs.length = Math.min(this.lastRigs.length, 2);
  }

  /** Feed every live event here. */
  onEvent(e, score) {
    const heat = this.heat;
    switch (e.type) {
      case 'shot':
        heat[e.bot] += 0.25;
        break;
      case 'hit':
        heat[e.bot] += 1;
        heat[e.by] += 1;
        break;
      case 'overchargeTaken':
        heat[e.bot] += 4;
        break;
      case 'kill':
        this.onKill(e, score);
        break;
      case 'matchEnd':
        this.ended = true;
        this.mvp = e.mvp ?? e.team * (BOT_COUNT / 2);
        this.queueFinalReplay(e);
        break;
      default:
    }
  }

  onKill(e, score) {
    this.heat[e.bot] += 5;
    this.recentKills.push({ time: this.time, bot: e.bot });
    this.recentKills = this.recentKills.filter((k) => this.time - k.time < 4);
    const multi = this.recentKills.filter((k) => k.bot === e.bot).length;

    let drama = 0;
    if (e.streak >= 3) drama += 2;
    if (e.head) drama += 1;
    if (multi >= 2) drama += 3;
    if (e.victimOvercharged) drama += 2;
    if (e.killerHealth !== undefined && e.killerHealth < 25) drama += 2;
    if (this.shot.a === e.bot || this.shot.a === e.victim || this.shot.b === e.victim) drama += 1;
    if (score && Math.max(...score) >= 35) drama += 1;

    const moment = { ...e, drama, start: e.tick - REPLAY_LEAD, end: e.tick + REPLAY_TAIL };
    this.lastKill = moment;
    if (!this.bestKill || drama >= this.bestKill.drama) this.bestKill = moment;
    if (
      drama >= REPLAY_THRESHOLD &&
      this.lockBot < 0 &&
      !this.pending &&
      !this.replay &&
      this.time - this.lastReplayAt >= REPLAY_COOLDOWN
    ) {
      this.pending = { moment, at: this.time + REPLAY_DELAY };
    }
  }

  queueFinalReplay(e) {
    const moment = this.lastKill && this.lastKill.bot >= 0 ? this.lastKill : null;
    if (moment) this.pending = { moment, at: this.time + 1, final: true, teamWon: e.team };
  }

  /** Main calls this each frame; a non-null result starts a replay. */
  takeReplay() {
    if (!this.pending || this.replay || this.time < this.pending.at) return null;
    const { moment, final } = this.pending;
    this.pending = null;
    this.lastReplayAt = this.time;
    return this.beginReplay(moment, final);
  }

  beginReplay(moment, final = false) {
    this.replay = {
      moment,
      final,
      rig: this.rng.next() < 0.5 ? 'replayOrbit' : 'replayKiller',
      tick: moment.start,
      speed: REPLAY_SPEED,
    };
    this.snap = true;
    return this.replay;
  }

  requestManualReplay() {
    if (this.replay || !this.lastKill) return null;
    return this.beginReplay(this.lastKill);
  }

  endReplay() {
    this.replay = null;
    this.snap = true;
    this.cutCount++;
    this.pickShot(this.lastView, true);
  }

  lockTo(bot) {
    this.lockBot = bot;
    this.lockRig = null;
    if (bot >= 0) this.cut({ rig: 'shoulder', a: bot, b: -1, kind: 'lull' });
  }

  cycleLockedRig() {
    if (this.lockBot < 0) return;
    const rigs = ['shoulder', 'pov', 'crane', 'tower'];
    const next = rigs[(rigs.indexOf(this.shot.rig) + 1) % rigs.length];
    this.lockRig = next;
    this.cut({ rig: next, a: this.lockBot, b: -1, kind: 'lull' });
  }

  /** Scores every possible focus, returning the best one. */
  bestFocus(view) {
    const { arena } = this;
    const bots = view.bots;
    let best = { score: 0.2, a: this.shot.a, b: -1, kind: 'lull' };
    const offer = (score, a, b, kind) => {
      if (this.sameFocus(a, b)) score *= SWITCH_MARGIN;
      if (score > best.score) best = { score, a, b, kind };
    };

    for (const a of bots) {
      if (!a.alive || a.team !== 0) continue;
      for (const b of bots) {
        if (!b.alive || b.team !== 1) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 42) continue;
        const heat = this.heat[a.id] + this.heat[b.id];
        const sees = arena.lineOfSight(a.x, a.y, a.z + EYE_HEIGHT, b.x, b.y, b.z + EYE_HEIGHT);
        if (sees) {
          const facingA = Math.cos(wrapAngle(Math.atan2(b.y - a.y, b.x - a.x) - a.yaw));
          const facingB = Math.cos(wrapAngle(Math.atan2(a.y - b.y, a.x - b.x) - b.yaw));
          offer(1.5 + 12 / (3 + d * 0.35) + heat * 0.6 + Math.max(0, facingA + facingB), a.id, b.id, 'duel');
        } else {
          const field = arena.field(arena.cell(b.x, b.y));
          const path = field[arena.cell(a.x, a.y)];
          if (path < 14) offer(1.2 + (14 - path) / 5 + heat * 0.3, a.id, b.id, 'approach');
        }
      }
    }

    for (const b of bots) {
      if (!b.alive) continue;
      const toOc = Math.hypot(b.x - arena.overcharge.x, b.y - arena.overcharge.y);
      if (b.overcharge > 0) offer(3 + this.heat[b.id] * 0.5, b.id, -1, 'objective');
      else if (view.overchargeActive && toOc < 12) offer(2 + (12 - toOc) / 4, b.id, -1, 'objective');
      if (this.heat[b.id] > 1) offer(0.6 + this.heat[b.id] * 0.5, b.id, -1, 'lull');
    }
    return best;
  }

  sameFocus(a, b) {
    const s = this.shot;
    return (a === s.a && (b === s.b || b < 0)) || (a === s.b && b === s.a) || (b === s.a && a === s.b);
  }

  /** Helmet cam is only worth cutting to if the player is looking at something. */
  povIsBlocked(bot) {
    const eye = [bot.x, bot.y, bot.z + EYE_HEIGHT];
    const look = [eye[0] + Math.cos(bot.yaw) * 10, eye[1] + Math.sin(bot.yaw) * 10, eye[2] + Math.sin(bot.pitch) * 10];
    return viewBlockage(this.arena, eye, look, POV_FOV) > MAX_PLACED_BLOCKAGE;
  }

  pickRig(kind, subject) {
    const weights = RIG_WEIGHTS[kind];
    const options = Object.entries(weights).filter(
      ([rig]) => !this.lastRigs.includes(rig) && !(rig === 'pov' && this.povIsBlocked(subject)),
    );
    const total = options.reduce((n, [, w]) => n + w, 0);
    let r = this.rng.next() * total;
    for (const [rig, w] of options) {
      r -= w;
      if (r <= 0) return rig;
    }
    return options[options.length - 1][0];
  }

  pickShot(view, force) {
    const focus = this.bestFocus(view);
    const dead = !view.bots[this.shot.a].alive;
    const same = this.sameFocus(focus.a, focus.b);
    const wantsMove = !same && this.shotAge >= MIN_HOLD;
    const expired = this.shotAge >= MAX_HOLD;
    if (!force && !wantsMove && !expired && !(dead && this.shotAge > DEATH_BEAT)) return;

    let a = focus.a;
    if (!view.bots[a].alive) a = view.bots.find((b) => b.alive)?.id ?? 0;
    this.cut({ rig: this.pickRig(focus.kind, view.bots[a]), a, b: focus.b, kind: focus.kind });
  }

  update(dt, view) {
    this.lastView = view;
    this.time += dt;
    this.shotAge += dt;
    for (let i = 0; i < BOT_COUNT; i++) this.heat[i] *= Math.exp(-dt / 2.5);

    if (this.replay) {
      this.runRig(this.replay.rig, dt, view);
      return this.camera;
    }

    if (this.ended) {
      if (this.shot.rig !== 'victory') this.cut({ rig: 'victory', a: this.mvp, b: -1, kind: 'lull' });
    } else if (this.lockBot >= 0) {
      this.shot.a = this.lockBot;
    } else {
      this.decideT -= dt;
      if (this.decideT <= 0) {
        this.decideT = DECISION_INTERVAL;
        this.pickShot(view, false);
      }
    }
    this.runRig(this.shot.rig, dt, view);
    if (this.lockBot < 0 && !this.ended) this.watchShot(dt, view);
    return this.camera;
  }

  /** Cuts away from any shot that has stopped showing anything. */
  watchShot(dt, view) {
    const cam = this.camera;
    const { rig, a } = this.shot;
    const subject = view.bots[a];
    const needsSubject = rig !== 'pov' && rig !== 'overview' && rig !== 'tower' && subject.alive;
    const bad =
      viewBlockage(this.arena, cam.pos, cam.look, cam.fov) >= BAD_BLOCKAGE ||
      (needsSubject && !canSeePoint(this.arena, cam.pos, [subject.x, subject.y, subject.z + 1.3]));
    this.badView = bad ? this.badView + dt : 0;
    if (this.badView < (rig === 'pov' ? BAD_POV_LIMIT : BAD_VIEW_LIMIT)) return;
    this.badView = 0;
    this.pickShot(view, true);
    this.runRig(this.shot.rig, 0, view);
  }

  runRig(rig, dt, view) {
    const moment = this.replay?.moment;
    const a = view.bots[moment ? moment.bot : this.shot.a];
    const bIndex = moment ? moment.victim : this.shot.b;
    const b = bIndex >= 0 ? view.bots[bIndex] : null;
    const cam = this.camera;
    cam.hideBot = -1;
    cam.viewmodel = false;
    cam.roll = 0;
    this[`rig_${rig}`](dt, view, a, b);
    this.snap = false;
    this.spotAge += dt;

    // Final safety: never let a camera sit inside geometry.
    const floor = this.arena.heightAt(cam.pos[0], cam.pos[1]) + 0.3;
    if (cam.pos[2] < floor) cam.pos[2] = floor;
  }

  spotPosition(pivot, want, spot) {
    const x = (want[0] - pivot[0]) * spot.scale;
    const y = (want[1] - pivot[1]) * spot.scale;
    const c = Math.cos(spot.az);
    const s = Math.sin(spot.az);
    return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, pivot[2] + (want[2] - pivot[2]) * spot.scale + spot.lift];
  }

  spotWorks(pos, aim, fov, sights) {
    return (
      isClear(this.arena, pos[0], pos[1], pos[2], CAMERA_CLEARANCE) &&
      sights.every((p) => canSeePoint(this.arena, pos, p)) &&
      viewBlockage(this.arena, pos, aim, fov) <= MAX_PLACED_BLOCKAGE
    );
  }

  /**
   * Finds the nearest usable camera position to `want`, orbiting around `pivot`.
   * A working spot is kept, and the ideal is only retried now and then, so the
   * camera does not flicker between positions. Returns where to stand and aim.
   */
  place(pivot, want, look, fov, sights) {
    const aimFor = (spot) => (spot.az === 0 && spot.scale === 1 ? look : pivot);
    const attempt = (i) => {
      const spot = SPOTS[i];
      const pos = this.spotPosition(pivot, want, spot);
      const aim = aimFor(spot);
      return this.spotWorks(pos, aim, fov, sights) ? { pos, look: aim, moved: i !== 0 } : null;
    };

    const retry = this.spotAge >= RETRY_BEST_SPOT;
    const held = !retry && !this.snap ? attempt(this.spot) : null;
    if (held) return held;
    for (let i = 0; i < SPOTS.length; i++) {
      const found = attempt(i);
      if (found) {
        this.spot = i;
        this.spotAge = 0;
        return found;
      }
    }

    // Nothing at ground level works, so go overhead, leaning in from the map edge.
    const lean = pivot[0] < 32 ? 2.5 : -2.5;
    return { pos: [pivot[0] + lean, pivot[1], Math.max(pivot[2] + 9, 10.5)], look: pivot, moved: true };
  }

  apply(pos, look, fov, tauPos, tauLook, dt, sight = null) {
    const s = this.smooth;
    for (let i = 0; i < 3; i++) {
      s.pos[i] = this.snap ? pos[i] : damp(s.pos[i], pos[i], tauPos, dt);
      s.look[i] = this.snap ? look[i] : damp(s.look[i], look[i], tauLook, dt);
    }
    s.fov = this.snap ? fov : damp(s.fov, fov, 0.5, dt);

    // Smoothing can drag a camera behind cover on its way to a good spot.
    if (sight && !this.snap) {
      const blocked =
        !isClear(this.arena, s.pos[0], s.pos[1], s.pos[2], CAMERA_CLEARANCE * 0.5) ||
        !canSeePoint(this.arena, s.pos, sight);
      this.occluded = blocked ? this.occluded + dt : 0;
      if (this.occluded > OCCLUDED_SNAP) {
        this.occluded = 0;
        for (let i = 0; i < 3; i++) {
          s.pos[i] = pos[i];
          s.look[i] = look[i];
        }
      }
    }
    this.camera.pos = [...s.pos];
    this.camera.look = [...s.look];
    this.camera.fov = s.fov;
  }

  rig_shoulder(dt, _view, a, b) {
    const yaw = a.alive ? a.yaw : a.yaw + a.deathT * 0.5;
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const eye = head(a);
    const distance = a.alive ? 3.2 : 4.5;
    const want = [eye[0] - fx * distance - fy * 0.8, eye[1] - fy * distance + fx * 0.8, eye[2] + 0.9];
    let look = [eye[0] + fx * 9, eye[1] + fy * 9, eye[2] + Math.sin(a.pitch) * 9];
    if (b?.alive) {
      const target = head(b);
      look = look.map((v, i) => v * 0.6 + target[i] * 0.4);
    }
    const spot = this.place(eye, want, look, 68, [eye, chest(a)]);
    this.apply(spot.pos, spot.look, 68, spot.moved ? 0.3 : 0.1, spot.moved ? 0.2 : 0.07, dt, eye);
  }

  rig_pov(dt, _view, a) {
    const cp = Math.cos(a.pitch);
    const pos = [a.x + Math.cos(a.yaw) * 0.12, a.y + Math.sin(a.yaw) * 0.12, a.z + EYE_HEIGHT];
    const look = [pos[0] + Math.cos(a.yaw) * cp * 10, pos[1] + Math.sin(a.yaw) * cp * 10, pos[2] + Math.sin(a.pitch) * 10];
    this.apply(pos, look, POV_FOV, 0.001, 0.001, dt);
    this.camera.hideBot = a.alive ? a.id : -1;
    this.camera.viewmodel = a.alive;
    this.camera.roll = clamp(-(a.vx * -Math.sin(a.yaw) + a.vy * Math.cos(a.yaw)) * 0.004, -0.03, 0.03);
  }

  rig_duel(dt, _view, a, b) {
    if (!b) {
      this.rig_crane(dt, _view, a);
      return;
    }
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const mz = Math.max(a.z, b.z) + 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const span = clamp(d * 0.72 + 3.5, 5.5, 22);
    this.orbit += dt * 0.05;
    const swing = Math.sin(this.orbit) * 0.3;
    const nx = (-dy / d) * this.side;
    const ny = (dx / d) * this.side;
    const px = mx + (nx * Math.cos(swing) - ny * Math.sin(swing)) * span;
    const py = my + (nx * Math.sin(swing) + ny * Math.cos(swing)) * span;
    const mid = [mx, my, mz];
    const fovAt = (range) => clamp((2 * Math.atan((d / 2 + 2) / range) * 180) / Math.PI, 34, 72);
    const spot = this.place(mid, [px, py, mz + 1.2], mid, fovAt(span), [head(a), head(b), chest(a), chest(b)]);
    const fov = fovAt(Math.hypot(spot.pos[0] - mx, spot.pos[1] - my, spot.pos[2] - mz));
    this.apply(spot.pos, spot.look, fov, 0.28, 0.16, dt, chest(a));
  }

  rig_tower(dt, _view, a, b) {
    if (this.snap || !this.towerAt) {
      // A far tower gives the long-lens look and clears the near wall.
      let best = TOWERS[0];
      let bestMiss = Infinity;
      for (const t of TOWERS) {
        const miss = Math.abs(Math.hypot(t[0] - a.x, t[1] - a.y) - TOWER_THROW);
        if (miss < bestMiss) {
          bestMiss = miss;
          best = t;
        }
      }
      this.towerAt = best;
    }
    const target = b?.alive ? [(a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(a.z, b.z) + 1] : [a.x, a.y, a.z + 1];
    const d = Math.hypot(target[0] - this.towerAt[0], target[1] - this.towerAt[1], target[2] - this.towerAt[2]);
    const reach = b?.alive ? Math.hypot(a.x - b.x, a.y - b.y) / 2 + 4 : 5;
    this.apply(this.towerAt, target, clamp((2 * Math.atan(reach / d) * 180) / Math.PI, 12, 45), 0.001, 0.3, dt);
  }

  rig_crane(dt, _view, a) {
    this.orbit += dt * 0.16;
    const focus = [a.x, a.y, a.z + 0.8];
    const eye = head(a);
    const want = [a.x + Math.cos(this.orbit) * 11, a.y + Math.sin(this.orbit) * 11, a.z + 7.5];
    const spot = this.place(focus, want, focus, 50, [eye, chest(a)]);
    this.apply(spot.pos, spot.look, 50, 0.35, 0.2, dt, eye);
  }

  rig_overview(dt, view) {
    this.orbit += dt * 0.04;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const b of view.bots) {
      if (b.alive) {
        cx += b.x;
        cy += b.y;
        n++;
      }
    }
    cx = n ? cx / n : 32;
    cy = n ? cy / n : 20;
    const pos = [32 + Math.sin(this.orbit) * 22, 20 - this.side * 17, 21];
    this.apply(pos, [(cx + 32) / 2, (cy + 20) / 2, 0], 56, 1.5, 0.8, dt);
  }

  rig_replayOrbit(dt, _view, killer, victim) {
    this.orbit += dt * 0.5;
    const r = 6;
    const eye = head(victim);
    const want = [victim.x + Math.cos(this.orbit) * r, victim.y + Math.sin(this.orbit) * r, victim.z + 1.3];
    const look = [victim.x * 0.75 + killer.x * 0.25, victim.y * 0.75 + killer.y * 0.25, victim.z + 1.1];
    const spot = this.place(eye, want, look, 58, [eye, chest(victim)]);
    this.apply(spot.pos, spot.look, 58, spot.moved ? 0.3 : 0.12, 0.12, dt, eye);
  }

  rig_replayKiller(dt, _view, killer, victim) {
    const yaw = Math.atan2(victim.y - killer.y, victim.x - killer.x);
    const eye = head(killer);
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const want = [eye[0] - fx * 2 - fy * 0.75, eye[1] - fy * 2 + fx * 0.75, eye[2] + 0.35];
    const spot = this.place(eye, want, head(victim), 46, [eye, chest(killer)]);
    this.apply(spot.pos, spot.look, 46, spot.moved ? 0.3 : 0.08, 0.1, dt, eye);
  }

  rig_victory(dt, _view, a) {
    this.orbit += dt * 0.28;
    const r = 5.5;
    const c = [a.x, a.y, a.z + 1.1];
    const want = [a.x + Math.cos(this.orbit) * r, a.y + Math.sin(this.orbit) * r, a.z + 2.2];
    const spot = this.place(c, want, c, 44, [c]);
    this.apply(spot.pos, spot.look, 44, 0.3, 0.2, dt, c);
  }
}
