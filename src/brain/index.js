import { NETWORK } from './weights.generated.js';
import { createRuntime } from './runtime.js';

export const BRAIN_INFO = Object.freeze({
  name: 'HARDWIRED / CIRCUIT-01',
  architecture: 'Sparse recurrent affine/ReLU network',
  parameters: NETWORK.parameters,
  trainingSteps: 0,
  layers: NETWORK.blocks.map(b => ({ name: b.name, units: b.end - b.start })),
});

export function createBrain({ botId, teamId } = {}) {
  // Identity is intentionally unused: only observed temperament changes the policy.
  const runtime = createRuntime(NETWORK);
  const readouts = NETWORK.readouts.map(([label]) => ({ label, value: 0 }));
  return {
    act(obs, action) { runtime.forward(obs, action); },
    reset() { runtime.reset(); },
    readout() {
      for (let i = 0; i < readouts.length; i++) readouts[i].value = runtime.values[NETWORK.readouts[i][1]];
      return readouts;
    },
  };
}
