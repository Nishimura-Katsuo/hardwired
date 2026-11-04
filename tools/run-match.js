// Plays complete matches headlessly and returns plain statistics.
import { BOT_COUNT, BOTS_PER_TEAM, TICK_RATE } from '../src/sim/constants.js';
import { World } from '../src/sim/world.js';

/** Plays one match. `makeController(botId, teamId)` returns { reset?, act(obs, action) }. */
export function runMatch({ seed, makeController, maxSeconds = 600 }) {
  const controllers = [];
  for (let i = 0; i < BOT_COUNT; i++) controllers.push(makeController(i, i < BOTS_PER_TEAM ? 0 : 1));
  const world = new World({ seed, controllers });
  const limit = maxSeconds * TICK_RATE;
  const visited = world.bots.map(() => new Set());
  let ticks = 0;
  while (world.phase !== 'ended' && ticks < limit) {
    world.tick();
    world.drainEvents();
    if (ticks % 30 === 0) {
      for (const b of world.bots) if (b.alive) visited[b.id].add(world.arena.cell(b.x, b.y));
    }
    ticks++;
  }
  return {
    seed,
    seconds: ticks / TICK_RATE,
    phase: world.phase,
    winner: world.winner,
    score: [...world.score],
    bots: world.bots.map((b) => ({
      name: b.name, team: b.team, kills: b.kills, deaths: b.deaths, assists: b.assists,
      damage: b.damage, shots: b.shots, hits: b.hits, bestStreak: b.bestStreak,
      cellsVisited: visited[b.id].size,
    })),
  };
}
