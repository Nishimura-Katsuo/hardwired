import { performance } from 'node:perf_hooks';
import { createBrain, BRAIN_INFO } from '../../src/brain/index.js';
import { World } from '../../src/sim/world.js';
import { ACTION_SIZE } from '../../src/sim/observation.js';
const controllers = Array.from({ length: 8 }, (_, botId) => createBrain({ botId, teamId: botId < 4 ? 0 : 1 }));
const world = new World({ seed: 300, controllers });
for (let i = 0; i < 1200; i++) { world.tick(); world.drainEvents(); }
const action = new Float32Array(ACTION_SIZE);
for (let i = 0; i < 10000; i++) controllers[i % 8].act(world.bots[i % 8].obs, action);
const calls = 200000, start = performance.now();
for (let i = 0; i < calls; i++) controllers[i % 8].act(world.bots[i % 8].obs, action);
console.log(JSON.stringify({ node: process.version, calls, meanActMs: (performance.now() - start) / calls, parameters: BRAIN_INFO.parameters }));
