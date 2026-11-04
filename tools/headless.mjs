#!/usr/bin/env node
// Usage: node tools/headless.mjs [--matches N] [--seed S] [--a neural|baseline|idle] [--b neural|baseline|idle] [--json]
import { parseArgs } from 'node:util';
import { createBaselineController } from './baseline-controller.js';
import { runMatch } from './run-match.js';

const { values: args } = parseArgs({
  options: {
    matches: { type: 'string', default: '10' },
    seed: { type: 'string', default: '1' },
    a: { type: 'string', default: 'neural' },
    b: { type: 'string', default: 'neural' },
    json: { type: 'boolean', default: false },
  },
});

async function factory(kind) {
  if (kind === 'idle') return () => ({ act(_obs, action) { action.fill(0); } });
  if (kind === 'baseline') return () => createBaselineController();
  if (kind === 'neural') {
    const { createBrain } = await import('../src/brain/index.js');
    return (botId, teamId) => createBrain({ botId, teamId });
  }
  throw new Error(`unknown controller kind: ${kind}`);
}

const makeA = await factory(args.a);
const makeB = await factory(args.b);
const count = Number(args.matches);
const results = [];
for (let i = 0; i < count; i++) {
  // Swap sides every match so a one-sided bug cannot hide as a map advantage.
  const swap = i % 2 === 1;
  const seed = Number(args.seed) + i;
  const r = runMatch({
    seed,
    makeController: (botId, teamId) => ((teamId === 0) !== swap ? makeA : makeB)(botId, teamId),
  });
  r.aTeam = swap ? 1 : 0;
  results.push(r);
}

const aWins = results.filter((r) => r.winner === r.aTeam).length;
const bWins = results.filter((r) => r.winner === 1 - r.aTeam).length;
const totals = results.flatMap((r) => r.bots);
const sum = (k) => totals.reduce((n, b) => n + b[k], 0);
const summary = {
  matches: count,
  a: args.a,
  b: args.b,
  aWins,
  bWins,
  unfinished: count - aWins - bWins,
  meanSeconds: results.reduce((n, r) => n + r.seconds, 0) / count,
  meanFrags: sum('kills') / count,
  accuracy: sum('hits') / Math.max(1, sum('shots')),
  meanCellsVisited: sum('cellsVisited') / totals.length,
};
if (args.json) console.log(JSON.stringify({ summary, results }, null, 2));
else {
  console.log(summary);
  for (const r of results) console.log(`seed ${r.seed}: ${r.score.join('-')} in ${r.seconds.toFixed(0)}s`);
}
