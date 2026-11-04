// Summarize saved evaluations without executing or changing a policy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NETWORK } from '../../src/brain/weights.generated.js';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const baseline = read('accept-baseline-5000.json');
const self = read('accept-self-6000.json');
const idle = read('accept-idle-7000.json');
const reference = read('reference-baseline-6000.json');
const total = (xs, key) => xs.reduce((sum, x) => sum + x[key], 0);
const roster = Array.from({ length: 8 }, (_, i) => {
  const bots = self.results.map(r => r.bots[i]);
  const yardstick = reference.results.map(r => r.bots[i]);
  return {
    name: bots[0].name, kills: total(bots, 'kills'), zeroKillMatches: bots.filter(b => b.kills === 0).length,
    accuracy: total(bots, 'hits') / total(bots, 'shots'),
    meanCells: total(bots, 'cellsVisited') / bots.length,
    baselineMeanCells: total(yardstick, 'cellsVisited') / yardstick.length,
    minCells: Math.min(...bots.map(b => b.cellsVisited)),
  };
});
const aBots = baseline.results.flatMap(r => r.bots.filter(b => b.team === r.aTeam));
let depth = new Uint16Array(NETWORK.base + NETWORK.nodes.length);
for (let n = 0; n < NETWORK.nodes.length; n++) {
  let d = 0;
  for (let j = NETWORK.offsets[n]; j < NETWORK.offsets[n + 1]; j++) d = Math.max(d, depth[NETWORK.sources[j]]);
  depth[NETWORK.base + n] = d + 1;
}
console.log(JSON.stringify({
  weightsSha256: createHash('sha256').update(readFileSync(new URL('../../src/brain/weights.generated.js', import.meta.url))).digest('hex'),
  architecture: { inputSize: NETWORK.inputSize, states: NETWORK.stateSize, nodes: NETWORK.nodes.length, parameters: NETWORK.parameters, maxDepth: Math.max(...depth) },
  baseline: baseline.summary,
  neuralAccuracyVsBaseline: total(aBots, 'hits') / total(aBots, 'shots'),
  idle: idle.summary, self: self.summary,
  selfSideWins: [0, 1].map(side => self.results.filter(r => r.winner === side).length),
  reference: reference.summary, roster,
}, null, 2));
