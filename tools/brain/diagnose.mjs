// Read-only match instrumentation; does not choose or modify weights.
import { World } from '../../src/sim/world.js';
import { createBrain } from '../../src/brain/index.js';
import { createBaselineController } from '../baseline-controller.js';
import { SELF, enemyIndex as E } from '../../src/sim/observation.js';
const stats = Array.from({ length: 8 }, () => ({ ticks: 0, fight: 0, fire: 0, onTarget: 0, firingOnTarget: 0, dist: 0, spread: 0, aim: 0, pitch: 0, stuck: 0, reloading: 0, intents: {} }));
const controllers = stats.map((s, id) => {
  const ctrl = id < 4 ? createBrain({ botId: id, teamId: 0 }) : createBaselineController();
  return { reset: () => ctrl.reset(), act(o, a) {
    ctrl.act(o, a); s.ticks++;
    s.stuck += +(o[SELF.stuck] > .5);
    for (const r of ctrl.readout?.() ?? []) s.intents[r.label] = (s.intents[r.label] ?? 0) + +(r.value > .5);
    if (o[E(0, 'present')]) {
      s.fight++; s.dist += o[E(0, 'dist')] * 50; s.spread += o[SELF.spread];
      s.aim += Math.abs(o[E(0, 'bearing')]) * Math.PI;
      s.pitch += Math.abs(o[E(0, 'pitch')]) * .5;
      s.onTarget += o[SELF.onTarget]; s.reloading += o[SELF.reloading];
      if (a[4] > 0) { s.fire++; s.firingOnTarget += o[SELF.onTarget]; }
    }
  } };
});
const world = new World({ seed: Number(process.argv[2] ?? 1), controllers });
for (let i = 0; i < 36000 && world.phase !== 'ended'; i++) { world.tick(); world.drainEvents(); }
console.log(JSON.stringify({ score: world.score, seconds: world.time, stats: stats.map((s, i) => ({
  name: world.bots[i].name, kills: world.bots[i].kills, accuracy: world.bots[i].hits / world.bots[i].shots,
  fight: s.fight / s.ticks, fire: s.fire / s.fight, onTarget: s.onTarget / s.fight,
  firingOnTarget: s.firingOnTarget / s.fire, dist: s.dist / s.fight, spread: s.spread / s.fight,
  aim: s.aim / s.fight, pitch: s.pitch / s.fight, stuck: s.stuck / s.ticks, reloading: s.reloading / s.fight,
  intents: Object.fromEntries(Object.entries(s.intents).map(([k, v]) => [k, v / s.ticks])),
})) }, null, 2));
