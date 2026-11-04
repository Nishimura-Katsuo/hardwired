// A plain scripted bot. It exists only as a yardstick for headless evaluation
// and as a debug comparison (?ai=baseline). It is not the game's AI.
import { ACTION, enemyIndex, goalIndex, HURT, SELF, SOUND } from '../src/sim/observation.js';

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export function createBaselineController() {
  return {
    reset() {},
    act(obs, action) {
      action.fill(0);
      if (obs[enemyIndex(0, 'present')] > 0) {
        const bearing = obs[enemyIndex(0, 'bearing')] * Math.PI;
        action[ACTION.yaw] = clamp1(bearing * 3);
        action[ACTION.pitch] = clamp1(obs[enemyIndex(0, 'pitch')] * 2);
        action[ACTION.fire] = Math.abs(bearing) < 0.05 ? 1 : -1;
        action[ACTION.forward] = obs[enemyIndex(0, 'dist')] > 0.25 ? 0.6 : 0;
        return;
      }
      let goal = 'mid';
      if (obs[goalIndex('contact', 'active')] > 0) goal = 'contact';
      if (obs[SELF.health] < 0.5 && obs[goalIndex('health', 'active')] > 0) goal = 'health';
      const sin = obs[goalIndex(goal, 'sin')];
      const cos = obs[goalIndex(goal, 'cos')];
      action[ACTION.forward] = cos;
      action[ACTION.strafe] = sin;
      action[ACTION.yaw] = clamp1(Math.atan2(sin, cos) * 1.5);
      action[ACTION.pitch] = clamp1(-obs[SELF.pitch] * 2);
      if (obs[SELF.ammo] < 0.4) action[ACTION.reload] = 1;
      if (obs[SELF.stuck] > 0.5) action[ACTION.jump] = 1;
      if (obs[HURT.level] > 0) action[ACTION.yaw] = clamp1(Math.atan2(obs[HURT.sin], obs[HURT.cos]) * 2);
      else if (obs[SOUND.level] > 0.3) action[ACTION.yaw] = clamp1(Math.atan2(obs[SOUND.sin], obs[SOUND.cos]) * 2);
    },
  };
}
