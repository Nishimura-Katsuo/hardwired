import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arena, MAP_H, MAP_W } from '../src/sim/arena.js';
import { BOT_COUNT, DAMAGE_BODY, EYE_HEIGHT, MAG_SIZE, MAX_HEALTH } from '../src/sim/constants.js';
import { OBS_SIZE } from '../src/sim/observation.js';
import { World } from '../src/sim/world.js';
import { createBaselineController } from '../tools/baseline-controller.js';
import { runMatch } from '../tools/run-match.js';

const arena = new Arena();

test('arena has 180-degree rotational symmetry', () => {
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      assert.equal(arena.heights[y * MAP_W + x], arena.heights[(MAP_H - 1 - y) * MAP_W + (MAP_W - 1 - x)]);
    }
  }
});

test('every pickup, landmark, and enemy base is reachable from every spawn', () => {
  const lm = arena.landmarks[0];
  const goals = [...arena.healthPacks, arena.overcharge, lm.north, lm.south, lm.mid, lm.enemyBase, arena.landmarks[1].enemyBase];
  for (const goal of goals) {
    const field = arena.field(arena.cell(goal.x, goal.y));
    for (const s of arena.spawns.flat()) {
      assert.ok(Number.isFinite(field[arena.cell(s.x, s.y)]), `no route ${s.x},${s.y} -> ${goal.x},${goal.y}`);
    }
  }
});

test('steering waypoints walk a bot to the goal without touching a wall', () => {
  const out = { x: 0, y: 0, dist: 0 };
  let x = 4.5;
  let y = 19.5;
  let z = arena.heightAt(x, y);
  const goal = arena.overcharge;
  for (let i = 0; i < 2000 && Math.hypot(x - goal.x, y - goal.y) > 0.5; i++) {
    assert.ok(arena.steer(x, y, z, goal.x, goal.y, out));
    const d = Math.hypot(out.x - x, out.y - y) || 1;
    const nx = x + ((out.x - x) / d) * 0.09;
    const ny = y + ((out.y - y) / d) * 0.09;
    assert.equal(arena.blocked(nx, ny, z), false);
    x = nx;
    y = ny;
    z = arena.groundUnder(x, y, z);
  }
  assert.ok(Math.hypot(x - goal.x, y - goal.y) <= 0.5);
});

test('raycast stops at a wall face and passes over low cover', () => {
  assert.ok(Math.abs(arena.raycast(5, 20, 3, -1, 0, 0, 50) - 3) < 1e-4);
  assert.equal(arena.raycast(11, 14.5, 1.55, 1, 0, 0, 5), 5);
  assert.ok(arena.raycast(11, 14.5, 0.5, 1, 0, 0, 5) < 1.1);
});

test('matches are deterministic for a seed', () => {
  const play = () => runMatch({ seed: 9, makeController: () => createBaselineController(), maxSeconds: 60 });
  assert.deepEqual(play(), play());
});

test('observations are finite, bounded, and the right size', () => {
  const controllers = Array.from({ length: BOT_COUNT }, () => {
    const inner = createBaselineController();
    return {
      act(obs, action) {
        assert.equal(obs.length, OBS_SIZE);
        for (let i = 0; i < obs.length; i++) {
          assert.ok(Number.isFinite(obs[i]) && Math.abs(obs[i]) <= 1.0001, `obs[${i}]=${obs[i]}`);
        }
        inner.act(obs, action);
      },
    };
  });
  const world = new World({ seed: 3, controllers });
  for (let i = 0; i < 1800; i++) world.tick();
});

test('a body shot deals body damage and uses a round', () => {
  const world = new World({ seed: 1 });
  world.phase = 'live';
  const a = world.bots[0];
  const b = world.bots[4];
  const z = arena.heightAt(15, 15);
  Object.assign(a, { x: 15, y: 15, z, yaw: 0, pitch: 0, currentSpread: 0 });
  Object.assign(b, { x: 16.5, y: 15, z: z + (EYE_HEIGHT - 1.2) });
  world.fire(a);
  assert.equal(b.health, MAX_HEALTH - DAMAGE_BODY);
  assert.equal(a.ammo, MAG_SIZE - 1);
});

test('the first team to the frag limit wins and bots really fight', () => {
  const r = runMatch({ seed: 5, makeController: () => createBaselineController() });
  assert.equal(r.phase, 'ended');
  assert.ok(r.winner === 0 || r.winner === 1);
  assert.ok(r.score[0] + r.score[1] > 10);
  for (const bot of r.bots) assert.ok(bot.cellsVisited > 15, `${bot.name} barely moved`);
});
