import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Director } from '../src/director/director.js';
import { canSeePoint, solidHeight, viewBlockage } from '../src/director/framing.js';
import { BOT_COUNT, DT } from '../src/sim/constants.js';
import { createView, Recorder } from '../src/sim/recorder.js';
import { World } from '../src/sim/world.js';
import { createBrain } from '../src/brain/index.js';

/** Plays a match through the same recorder-director loop that main.js runs. */
function broadcast(seed, onFrame) {
  const world = new World({ seed, controllers: Array.from({ length: BOT_COUNT }, () => createBrain()) });
  const recorder = new Recorder();
  const view = createView();
  const director = new Director(world.arena, { seed });
  const stats = { cuts: 0, longest: 0, shortest: Infinity, replays: 0, rigs: new Set(), kinds: new Set() };
  let replay = null;
  let hold = 0;
  let cuts = 0;
  for (let i = 0; i < 60 * 60 * 3 && world.phase !== 'ended'; i++) {
    world.tick();
    recorder.capture(world);
    const events = world.drainEvents();
    world.lastKills = events.filter((e) => e.type === 'kill');
    for (const e of events) {
      recorder.addEvent(e);
      director.onEvent(e, world.score);
    }
    const started = director.takeReplay();
    if (started) {
      replay = started;
      stats.replays++;
    }
    if (replay) {
      replay.tick += replay.speed;
      if (replay.tick >= replay.moment.end) {
        director.endReplay();
        replay = null;
        hold = 0;
      }
    }
    recorder.sample(replay ? replay.tick : world.tickCount, view);
    director.update(DT, view);
    hold += DT;
    if (director.cutCount !== cuts) {
      cuts = director.cutCount;
      if (!replay) {
        stats.longest = Math.max(stats.longest, hold);
        if (i > 300) stats.shortest = Math.min(stats.shortest, hold);
      }
      hold = 0;
      stats.cuts++;
    }
    stats.rigs.add(director.shot.rig);
    stats.kinds.add(director.shot.kind);
    onFrame?.(director, view, world);
  }
  return stats;
}

test('recorder interpolates and wraps yaw across the seam', () => {
  const world = new World({ seed: 1 });
  const recorder = new Recorder();
  const view = createView();
  world.tickCount = 10;
  world.bots[0].yaw = 3.1;
  recorder.capture(world);
  world.tickCount = 11;
  world.bots[0].yaw = -3.1;
  recorder.capture(world);
  recorder.sample(10.5, view);
  assert.ok(Math.abs(Math.abs(view.bots[0].yaw) - 3.1416) < 0.05 || Math.abs(view.bots[0].yaw) > 3.1);
  assert.equal(recorder.oldest, 10);
});

test('the camera stays valid and out of the arena geometry for a whole match', () => {
  broadcast(4, (director, _view, world) => {
    const { pos, look, fov } = director.camera;
    for (const v of [...pos, ...look, fov]) assert.ok(Number.isFinite(v));
    assert.ok(pos[2] >= world.arena.heightAt(pos[0], pos[1]) + 0.25, `camera in floor at ${pos}`);
    assert.ok(fov >= 10 && fov <= 90);
  });
});

test('the broadcast keeps showing the match instead of a nearby wall', () => {
  let frames = 0;
  let buried = 0;
  let walled = 0;
  let hidden = 0;
  let bad = 0;
  let worstRun = 0;
  for (const seed of [201, 202]) {
    broadcast(seed, (director, view, world) => {
      const { pos, look, fov } = director.camera;
      const { arena } = world;
      const replay = director.replay;
      const rig = replay ? replay.rig : director.shot.rig;
      const followsVictim = rig === 'replayOrbit';
      const subject = view.bots[replay ? (followsVictim ? replay.moment.victim : replay.moment.bot) : director.shot.a];
      const isBuried = solidHeight(arena, pos[0], pos[1]) > pos[2];
      const isWalled = viewBlockage(arena, pos, look, fov) >= 0.34;
      const third = rig !== 'pov' && rig !== 'overview';
      const isHidden = third && subject.alive && !canSeePoint(arena, pos, [subject.x, subject.y, subject.z + 1.3]);
      frames++;
      buried += isBuried ? 1 : 0;
      walled += isWalled ? 1 : 0;
      hidden += isHidden ? 1 : 0;
      bad = isBuried || isWalled || isHidden ? bad + 1 : 0;
      worstRun = Math.max(worstRun, bad);
    });
  }
  assert.equal(buried, 0, 'camera was inside solid geometry');
  assert.ok(walled / frames < 0.02, `wall filled the frame in ${((100 * walled) / frames).toFixed(1)}% of frames`);
  assert.ok(hidden / frames < 0.02, `subject hidden in ${((100 * hidden) / frames).toFixed(1)}% of frames`);
  assert.ok(worstRun <= 60, `bad view lasted ${(worstRun / 60).toFixed(1)}s`);
});

test('the director paces cuts, varies rigs, and cuts to replays', () => {
  const stats = broadcast(6);
  assert.ok(stats.cuts >= 12, `only ${stats.cuts} cuts`);
  assert.ok(stats.longest <= 11, `held a shot for ${stats.longest}s`);
  assert.ok(stats.rigs.size >= 4, `rigs used: ${[...stats.rigs]}`);
  assert.ok(stats.kinds.has('duel'));
  assert.ok(stats.replays >= 1, 'no replay was triggered');
});

test('the director is on the action: most kills happen to a player it is covering', () => {
  let kills = 0;
  let covered = 0;
  broadcast(8, (director, _view, world) => {
    for (const k of world.lastKills ?? []) {
      if (director.replay) continue;
      kills++;
      const { a, b } = director.shot;
      if ([a, b].includes(k.bot) || [a, b].includes(k.victim)) covered++;
    }
  });
  assert.ok(kills > 20, `only ${kills} live kills observed`);
  assert.ok(covered / kills > 0.4, `covered ${covered} of ${kills} kills`);
});

test('the match ends on a replay of the winning kill, then the winner shot', () => {
  const world = new World({ seed: 11, controllers: Array.from({ length: BOT_COUNT }, () => createBrain()) });
  const recorder = new Recorder();
  const view = createView();
  const director = new Director(world.arena, { seed: 11 });
  let finalKill = null;
  while (world.phase !== 'ended') {
    world.tick();
    recorder.capture(world);
    for (const e of world.drainEvents()) {
      recorder.addEvent(e);
      if (e.type === 'kill') finalKill = e;
      director.onEvent(e, world.score);
    }
    director.takeReplay() && director.endReplay();
    recorder.sample(world.tickCount, view);
    director.update(DT, view);
  }
  assert.equal(director.pending?.final, true);
  let replay = null;
  for (let i = 0; i < 90 && !replay; i++) {
    director.update(DT, view);
    replay = director.takeReplay();
  }
  assert.ok(replay, 'final replay never started');
  assert.equal(replay.moment.bot, finalKill.bot);
  assert.equal(replay.moment.victim, finalKill.victim);
  assert.ok(replay.moment.start >= recorder.oldest);
  director.update(DT, view);
  director.endReplay();
  director.update(DT, view);
  assert.equal(director.shot.rig, 'victory');
  assert.equal(world.bots[director.shot.a].team, world.winner);
});

test('a manual lock holds the chosen player', () => {
  const world = new World({ seed: 2, controllers: Array.from({ length: BOT_COUNT }, () => createBrain()) });
  const recorder = new Recorder();
  const view = createView();
  const director = new Director(world.arena);
  director.lockTo(5);
  for (let i = 0; i < 1200; i++) {
    world.tick();
    world.drainEvents();
    recorder.capture(world);
    recorder.sample(world.tickCount, view);
    director.update(DT, view);
    assert.equal(director.shot.a, 5);
  }
});
