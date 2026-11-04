// Deterministic circuit compiler. No examples, RNG, fitting, or match scores enter here.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SELF as S, HURT, SOUND, OBS_SIZE, enemyIndex as E, goalIndex as G, allyIndex as A, RAY_FLOOR } from '../../src/sim/observation.js';

export function construct() {
  const stateNames = ['clockCos', 'clockSin', 'started', 'patrol', 'threat'];
  const base = OBS_SIZE + stateNames.length;
  const nodes = [], blocks = [];
  const state = Object.fromEntries(stateNames.map((n, i) => [n, OBS_SIZE + i]));
  const row = (name, terms = [], bias = 0, relu = false) => {
    const id = base + nodes.length;
    nodes.push({ name, terms: terms.filter(([, w]) => w !== 0), bias, relu });
    return id;
  };
  const lin = (name, terms, bias = 0) => row(name, terms, bias);
  const relu = (name, terms, bias = 0) => row(name, terms, bias, true);
  const constant = (name, v) => lin(name, [], v);
  const one = constant('one', 1), zero = constant('zero', 0);
  const sub = (name, a, b) => lin(name, [[a, 1], [b, -1]]);
  const clip = (name, x, lo = 0, hi = 1) => lin(name, [
    [relu(name + '.lo', [[x, 1]], -lo), 1], [relu(name + '.hi', [[x, 1]], -hi), -1],
  ], lo);
  const ramp = (name, x, t, width = .02) => clip(name, lin(name + '.scale', [[x, 1 / width]], -t / width));
  const not = (name, a) => sub(name, one, a);
  const and = (name, ...xs) => relu(name, xs.map(x => [x, 1]), 1 - xs.length);
  const max = (name, a, b) => lin(name, [[b, 1], [relu(name + '.diff', [[a, 1], [b, -1]]), 1]]);
  const abs = (name, x) => lin(name, [[relu(name + '+', [[x, 1]]), 1], [relu(name + '-', [[x, -1]]), 1]]);
  // Exact for g in {0,1}, x in [-M,M]; continuous transition for soft gates.
  const gate = (name, x, g, M = 1) => lin(name, [
    [relu(name + '+', [[x, 1], [g, M]], -M), 1],
    [relu(name + '-', [[x, -1], [g, M]], -M), -1],
  ]);
  const mux = (name, x, y, g, M = 1) => lin(name, [[gate(name + '.yes', x, g, M), 1], [gate(name + '.no', y, not(name + '.not', g), M), 1]]);
  const start = name => blocks.push({ name, start: base + nodes.length });

  start('RECURRENT CLOCK');
  const theta = 2 * Math.PI / (3.2 * 20);
  const init = not('initialize', state.started);
  const clockCos = lin('clock.cos', [[state.clockCos, Math.cos(theta)], [state.clockSin, -Math.sin(theta)], [init, 1]]);
  const clockSin = lin('clock.sin', [[state.clockCos, Math.sin(theta)], [state.clockSin, Math.cos(theta)]]);

  start('TARGET TOURNAMENT');
  const scores = [0, 1, 2].map(i => lin(`target.${i}.score`, [
    [E(i, 'present'), 4], [E(i, 'near'), .45], [E(i, 'health'), -.25],
    [abs(`target.${i}.offAxis`, E(i, 'bearing')), -.4], [E(i, 'overcharge'), .1],
  ], i === 0 ? .22 : 0));
  const g1 = ramp('target.challenger1', sub('target.diff1', scores[1], scores[0]), .01);
  const best01 = max('target.best01', scores[0], scores[1]);
  const g2 = ramp('target.challenger2', sub('target.diff2', scores[2], best01), .01);
  const target = {};
  for (const f of ['present', 'bearing', 'pitch', 'dist', 'near', 'angVel', 'sin', 'cos']) {
    const first = mux(`target.${f}.01`, E(1, f), E(0, f), g1);
    target[f] = mux(`target.${f}`, E(2, f), first, g2);
  }
  const fight = target.present;
  const noFight = not('noFight', fight);
  const threat = max('recentThreat', fight, lin('threat.decay', [[state.threat, 1]], -.05));

  start('SURVIVAL AND INTENT');
  const risk = lin('risk', [[S.health, -1], [S.caution, .25], [S.aggression, -.12], [E(1, 'present'), .08], [E(2, 'present'), .08]], .22);
  const losing = ramp('losing', risk, 0);
  const reloadDanger = and('reloadDanger', fight, S.reloading);
  const retreat = max('RETREAT', and('lowHealthFight', losing, fight), reloadDanger);
  const needHealth = ramp('needHealth', lin('healthDeficit', [[S.health, -1], [S.caution, .12]], .55), 0);
  const heal = and('HEAL', G('health', 'active'), needHealth, max('healPermission', noFight, retreat));
  const cover = and('COVER', retreat, G('cover', 'active'), not('noHeal', heal));
  const power = and('POWER', not('powerNoHeal', heal), not('powerNoRetreat', retreat), G('overcharge', 'active'));

  start('PATROL AND ROUTES');
  // Keep the most aggressive persona on the direct route; escort uses north.
  const north = and('northPersona', ramp('escortAggression', S.aggression, .7, .05), not('rusher', ramp('rushAggression', S.aggression, .85, .05)));
  const south = ramp('southPersona', S.caution, .6, .05);
  const lane = {};
  for (const f of ['sin', 'cos', 'dist']) lane[f] = mux(`lane.${f}`, G('south', f), mux(`northOrMid.${f}`, G('north', f), G('mid', f), north), south);
  const reachedLane = not('reachedLane', ramp('laneFar', lane.dist, .035, .015));
  const reachedBase = not('reachedBase', ramp('baseFar', G('enemyBase', 'dist'), .04, .02));
  const patrol = and('patrol.next', max('patrol.latch', state.patrol, reachedLane), not('patrol.return', reachedBase));
  const contact = and('CONTACT', G('contact', 'active'), ramp('contactNotReached', G('contact', 'dist'), .025), not('flankFirst', and('laneInitial', not('notPatrol', patrol), max('sideLane', north, south))));
  const soon = and('powerSoon', not('waitLong', ramp('waitLongRamp', S.overchargeWait, .12, .03)), not('alreadyPowered', ramp('hasPower', S.overcharge, 0)));
  const route = {};
  for (const f of ['sin', 'cos']) {
    let x = mux(`patrol.${f}`, G('enemyBase', f), lane[f], patrol);
    x = mux(`contact.${f}`, G('contact', f), x, contact);
    x = mux(`soon.${f}`, G('mid', f), x, soon);
    x = mux(`power.${f}`, G('overcharge', f), x, power);
    x = mux(`cover.${f}`, G('cover', f), x, cover);
    route[f] = mux(`health.${f}`, G('health', f), x, heal);
  }

  start('TRACKING AND ORIENTING');
  // Error time constant 0.12 s: yaw/pi / (6 * .12), pitch/.5 / (3 * .12).
  // Angular velocity feedforward cancels steady lateral motion; no projectile flight lead (hitscan).
  const aimYaw = clip('aim.yaw', lin('aim.yaw.raw', [[target.bearing, Math.PI / (.12 * 6)], [target.angVel, .5]]), -1, 1);
  const aimPitch = clip('aim.pitch', lin('aim.pitch.raw', [[target.pitch, .5 / (.12 * 3)]]), -1, 1);
  const turn = (name, sin, cos) => {
    const back = not(name + '.front', ramp(name + '.cos', cos, -.2, .2));
    // Break the exact-rear symmetry deterministically to avoid zero turn at pi.
    const sign = lin(name + '.sign', [[ramp(name + '.left', sin, -.02, .01), 2]], -1);
    return clip(name, lin(name + '.raw', [[sin, 1.3], [gate(name + '.behind', sign, back), .8]]), -1, 1);
  };
  let navYaw = turn('route.yaw', route.sin, route.cos);
  navYaw = mux('sound.yaw', turn('sound.turn', SOUND.sin, SOUND.cos), navYaw, ramp('heard', SOUND.level, .25, .05));
  navYaw = mux('hurt.yaw', turn('hurt.turn', HURT.sin, HURT.cos), navYaw, ramp('hurt', HURT.level, .1, .05));
  const yaw = mux('action.yaw', aimYaw, navYaw, fight);
  const pitch = mux('action.pitch', aimPitch, clip('levelPitch', lin('levelPitch.raw', [[S.pitch, -2]]), -1, 1), fight);

  start('MOVEMENT');
  const close = clip('rangeControl', lin('rangeError', [[target.dist, 4], [S.aggression, .5], [S.caution, -.25]], -.9), -.4, .85);
  // Feedback-assisted: long-range running bloomed the rifle. Plant the feet
  // during the middle of each strafe cycle, then relocate between bursts.
  const plant = and('plant', fight, ramp('plantClock', clockCos, -.15, .1), ramp('longRange', target.dist, .25, .05));
  const movingClose = mux('burstForward', lin('steadyForward', [[close, .12]]), close, plant);
  const duelStrafe = mux('burstStrafe', zero, lin('duelStrafe', [[clockSin, .8], [S.aggression, .15]], -.075), plant);
  const moveRoute = max('routeMovement', noFight, max('escapeRoute', retreat, heal));
  let forward = mux('move.forward', route.cos, movingClose, moveRoute);
  let strafe = mux('move.strafe', route.sin, duelStrafe, moveRoute);
  const crowd = ramp('crowded', A(0, 'near'), .65, .15);
  forward = lin('action.forward', [[forward, 1], [gate('separate.forward', A(0, 'cos'), crowd), -.25]]);
  strafe = lin('action.strafe', [[strafe, 1], [gate('separate.strafe', A(0, 'sin'), crowd), -.25]]);
  const vault = and('vault', ramp('crateHigh', RAY_FLOOR, .18, .03), not('pillar', ramp('tooHigh', RAY_FLOOR, .4, .05)), noFight);
  const jump = lin('action.jump', [[max('JUMP', vault, ramp('stuckJump', S.stuck, .45, .1)), 2]], -1);

  start('FIRE AND RELOAD');
  const aimError = lin('aim.error', [[abs('absBearing', target.bearing), Math.PI], [abs('absPitch', target.pitch), .5]]);
  const aimBudget = lin('aim.budget', [[target.near, .1], [S.discipline, -.015]], .055);
  const aligned = not('aligned', ramp('misaligned', sub('aim.excess', aimError, aimBudget), 0, .01));
  const spreadBudget = lin('spread.budget', [[S.discipline, -.15], [target.near, .3]], .95);
  const settled = not('spreadPause', ramp('spread.excess', sub('spread.diff', S.spread, spreadBudget), 0, .05));
  const fireGate = and('FIGHT', fight, aligned, settled, not('notReloading', S.reloading));
  const fire = lin('action.fire', [[fireGate, 2]], -1);
  const safe = and('safeReload', noFight, not('recentContact', ramp('threatPresent', threat, .5, .1)));
  const reload = and('RELOAD', max('reloadPermission', safe, retreat), not('enoughAmmo', ramp('ammoReady', S.ammo, .55, .05)), not('busyReloading', S.reloading));
  const reloadAction = lin('action.reload', [[reload, 2]], -1);
  const flank = and('FLANK', noFight, not('notContact', contact), not('notHeal', heal), not('notPower', power));

  const outputs = [forward, strafe, yaw, pitch, fire, jump, reloadAction];
  const recurrence = [clockCos, clockSin, one, patrol, threat];
  const readouts = [['FIGHT', fireGate], ['RETREAT', retreat], ['HEAL', heal], ['COVER', cover], ['POWER', power], ['CONTACT', contact], ['FLANK', flank], ['RELOAD', reload]];
  const offsets = [0], sources = [], weights = [], biases = [], activations = [];
  for (const n of nodes) {
    for (const [source, weight] of n.terms) { sources.push(source); weights.push(weight); }
    offsets.push(weights.length); biases.push(n.bias); activations.push(+n.relu);
  }
  for (let i = 0; i < blocks.length; i++) blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : base + nodes.length;
  return { inputSize: OBS_SIZE, stateSize: stateNames.length, base, nodes: nodes.map(n => n.name), blocks, offsets, sources, weights, biases, activations, outputs, recurrence, readouts, parameters: weights.length + biases.length };
}

export function source() {
  return '// Generated by tools/brain/build-weights.mjs. Do not edit.\nexport const NETWORK = ' + JSON.stringify(construct()) + ';\n';
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = new URL('../../src/brain/weights.generated.js', import.meta.url);
  mkdirSync(new URL('../../src/brain/', import.meta.url), { recursive: true });
  writeFileSync(path, source());
  console.log(`Constructed ${construct().parameters} assigned parameters.`);
}
