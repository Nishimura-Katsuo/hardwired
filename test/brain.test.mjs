import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrain, BRAIN_INFO } from '../src/brain/index.js';
import { NETWORK } from '../src/brain/weights.generated.js';
import { createRuntime } from '../src/brain/runtime.js';
import { source } from '../tools/brain/build-weights.mjs';
import { SELF as S, OBS_SIZE, ACTION_SIZE, enemyIndex as E, goalIndex as G, SOUND } from '../src/sim/observation.js';

function observation() {
  const o = new Float32Array(OBS_SIZE);
  o[S.health] = o[S.ammo] = o[S.grounded] = o[S.bias] = 1;
  o[S.aggression] = .6; o[S.caution] = .5; o[S.discipline] = .95;
  o[S.overchargeWait] = .5;
  for (const g of ['north', 'mid', 'south', 'enemyBase']) {
    o[G(g, 'active')] = o[G(g, 'cos')] = 1; o[G(g, 'dist')] = .5;
  }
  return o;
}
function circuit(o, steps = 1) {
  const r = createRuntime(NETWORK), a = new Float32Array(ACTION_SIZE);
  for (let i = 0; i < steps; i++) r.forward(o, a);
  return { a, unit: name => r.values[NETWORK.base + NETWORK.nodes.indexOf(name)] };
}

test('brain API, shared policy, and live readout units', () => {
  assert.equal(BRAIN_INFO.trainingSteps, 0);
  assert.equal(BRAIN_INFO.parameters, NETWORK.weights.length + NETWORK.biases.length);
  const x = createBrain({ botId: 0, teamId: 0 }), y = createBrain({ botId: 7, teamId: 1 });
  const a = new Float32Array(ACTION_SIZE), b = a.slice(), o = observation();
  x.act(o, a); y.act(o, b); assert.deepEqual(a, b);
  const r = circuit(o);
  assert.ok(x.readout().length <= 8);
  for (const v of x.readout()) {
    assert.match(v.label, /^[A-Z]+$/);
    assert.ok(v.value >= 0 && v.value <= 1);
    assert.equal(v.value, r.unit(NETWORK.nodes[NETWORK.readouts.find(([label]) => label === v.label)[1] - NETWORK.base]));
  }
  assert.strictEqual(x.readout(), x.readout());
});

test('finite bounded actions across deterministic domain stress cases', () => {
  const b = createBrain(), o = observation(), a = new Float32Array(ACTION_SIZE);
  for (let k = 0; k < 2000; k++) {
    // Arithmetic test patterns, not policy optimization or fitted examples.
    for (let j = 0; j < OBS_SIZE; j++) o[j] = Math.sin((k + 1) * (j + 1));
    b.act(o, a);
    for (const v of a) assert.ok(Number.isFinite(v) && v >= -1 && v <= 1);
  }
});

test('reset clears activations and exactly replays recurrent trajectory', () => {
  const b = createBrain(), o = observation(), a = new Float32Array(ACTION_SIZE);
  o[E(0, 'present')] = 1; o[E(0, 'dist')] = .2;
  const trajectory = [];
  for (let i = 0; i < 100; i++) { b.act(o, a); trajectory.push([...a]); }
  b.reset();
  for (const r of b.readout()) assert.equal(r.value, 0);
  for (let i = 0; i < 100; i++) { b.act(o, a); assert.deepEqual([...a], trajectory[i]); }
});

test('generator reproduces deployed bytes and all connections are causal', () => {
  assert.equal(readFileSync(new URL('../src/brain/weights.generated.js', import.meta.url), 'utf8'), source());
  for (let n = 0; n < NETWORK.nodes.length; n++) {
    for (let j = NETWORK.offsets[n]; j < NETWORK.offsets[n + 1]; j++) {
      assert.ok(NETWORK.sources[j] < NETWORK.base + n);
      assert.ok(Number.isFinite(NETWORK.weights[j]));
    }
  }
});

test('target tournament selects a visible challenger over absent incumbent', () => {
  for (const slot of [0, 1, 2]) {
    const o = observation(); o[E(slot, 'present')] = 1; o[E(slot, 'bearing')] = .1;
    const r = circuit(o);
    assert.equal(r.unit('target.present'), 1);
    assert.ok(Math.abs(r.unit('target.bearing') - .1) < 1e-6);
    assert.ok(r.a[2] > 0);
    assert.ok(r.a[4] <= 0);
  }
});

test('angular velocity drives lead and off-axis or reload suppresses firing', () => {
  const o = observation(); o[E(0, 'present')] = 1; o[E(0, 'dist')] = .2;
  assert.equal(circuit(o).a[4], 1);
  o[E(0, 'angVel')] = .4;
  assert.ok(Math.abs(circuit(o).a[2] - .2) < 1e-6);
  o[S.reloading] = 1; assert.equal(circuit(o).a[4], -1);
  o[S.reloading] = 0; o[E(0, 'bearing')] = -.3;
  assert.ok(circuit(o).a[2] < 0); assert.equal(circuit(o).a[4], -1);
});

test('health, cover, safe reload, sound, and persona circuits respond to inputs', () => {
  const o = observation(); o[S.ammo] = .2;
  assert.equal(circuit(o).a[6], 1);
  o[E(0, 'present')] = 1;
  assert.equal(circuit(o).a[6], -1);
  o[S.health] = .1; o[G('cover', 'active')] = 1;
  assert.equal(circuit(o).unit('RETREAT'), 1);
  assert.equal(circuit(o).unit('COVER'), 1);
  o[G('health', 'active')] = 1;
  assert.equal(circuit(o).unit('HEAL'), 1);
  o[E(0, 'present')] = 0; o[SOUND.level] = .5; o[SOUND.sin] = -1;
  assert.ok(circuit(o).a[2] < 0);
  o[SOUND.sin] = 0; o[SOUND.cos] = -1;
  assert.ok(circuit(o).a[2] > .5);
  o[S.aggression] = .95; o[S.caution] = .1;
  assert.equal(circuit(o).unit('northPersona'), 0);
  o[S.aggression] = .8;
  assert.equal(circuit(o).unit('northPersona'), 1);
  o[S.aggression] = .4; o[S.caution] = .7;
  assert.equal(circuit(o).unit('southPersona'), 1);
});

test('patrol latch advances on arrival and clears at enemy base', () => {
  const o = observation(); o[G('mid', 'dist')] = 0;
  assert.equal(circuit(o).unit('patrol.next'), 1);
  o[G('enemyBase', 'dist')] = 0;
  assert.equal(circuit(o).unit('patrol.next'), 0);
});
