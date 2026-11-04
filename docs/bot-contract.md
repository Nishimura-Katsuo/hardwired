# Bot interface contract

The game owns physics, perception, and match rules. The network owns every
decision a player makes. This document is the boundary between them.

## Controller API

`src/brain/index.js` exports:

```js
export function createBrain({ botId, teamId }) // returns a controller
export const BRAIN_INFO // { name, architecture, parameters, trainingSteps: 0, layers: [...] }
```

A controller provides:

| Member | Called | Purpose |
| --- | --- | --- |
| `act(obs, action)` | 20 Hz per living bot, synchronous | Reads a `Float32Array(OBS_SIZE)`, writes a `Float32Array(ACTION_SIZE)`. |
| `reset()` | On every spawn, including match start | Clears recurrent state. |
| `readout()` | At render rate, for the followed bot | Returns up to 8 `{ label, value }` pairs, `value` in `[0, 1]`, naming the network's current intent. Drives the broadcast overlay. Read-only. |

Bots of both teams use the same weights. Per-player temperament reaches the
network as constant inputs (`aggression`, `caution`, `discipline`), so behaviour
differences must come from the weights responding to those inputs.

The module must load unchanged in a browser and under Node: no `fs`, no
dependencies, weights embedded in a generated `.js` module.

## Observation

Layout and index helpers are in `src/sim/observation.js`; values are produced by
`src/sim/sensors.js`. All values are in `[-1, 1]`. Angles use yaw 0 = +x and
positive = counter-clockwise. For any relative bearing `r`, `sin r > 0` means the
thing is to the bot's left, so `forward = cos r`, `strafe = sin r` walks toward it
regardless of where the bot is looking, and `yaw ∝ r` turns toward it.

| Block | Fields |
| --- | --- |
| `SELF` | health, ammo, reloading, overcharge (remaining fraction), grounded, velForward, velStrafe, pitch, sinYaw, cosYaw, posX, posY, posZ, spawnProtect, spread, onTarget (a perfectly accurate shot would hit an enemy right now), timeLeft, scoreDiff, overchargeWait (0 when the overcharge is available), stuck (low-passed blocked-movement ratio), aggression, caution, discipline, aliveRatio, bias (always 1) |
| `RAY_DIST` | 15 depth rays at `RAY_ANGLES_DEG`, encoded `1 / (1 + metres)`, 30 m range, cast at knee height |
| `RAY_FLOOR` | Floor height 1.5 m along each ray relative to the feet, divided by 3. Above `0.18` (0.55 m) cannot be stepped onto. |
| `GOALS` | 9 route channels, each `{active, sin, cos, dist}`: health (nearest available pack), overcharge, contact (nearest enemy position the team knows of, up to 8 s old), ally, north, mid, south, enemyBase, cover (nearest spot hidden from the slot-0 enemy, active only while one is visible). `sin`/`cos` point at the next waypoint on the shortest walkable route; `dist` is remaining path metres / 60. Inactive channels are `0, 0, 0, 1`. |
| `ENEMIES` | 3 slots, each `{present, bearing (radians / pi), sin, cos, pitch (aim error to chest / 0.5 rad), dist (/ 50 m), near (1 / (1 + m / 4)), angVel (rad/s / 3, + = moving to the bot's left), health, facing (cos of the enemy's aim off the bot), overcharge}`. Slot 0 stays on the same enemy while it stays visible. |
| `ALLIES` | 2 slots, nearest first: `{present, sin, cos, near, health, engaged}` |
| `HURT` | `{level, sin, cos}`: level decays from 1 over 1 s; direction of the last hit taken |
| `SOUND` | `{level, sin, cos}`: loudest enemy gunfire within 18 m |

Perception is imperfect on purpose. Enemies need a 120 degree view cone (or to be
within 3 m) and line of sight, and appear only after 0.15 s of continuous sight.
Bearings carry Gaussian noise (`AIM_NOISE`).

Route channels are sensors. The game computes the shortest path to each target
but never decides which target to pursue; choosing among them is the network's job.

## Action

`ACTION` indices, all clamped to `[-1, 1]`:

| Index | Meaning |
| --- | --- |
| `forward`, `strafe` | Body-frame movement. `strafe > 0` is left. Vector length is capped at 1. |
| `yaw`, `pitch` | Turn rate as a fraction of `MAX_YAW_RATE` (6 rad/s, + = left) and `MAX_PITCH_RATE` (3 rad/s, + = up), low-passed with a 60 ms time constant. |
| `fire` | Hold `> 0` to fire. |
| `jump` | `> 0` jumps when grounded. Clears crates (1 m) but not pillars. |
| `reload` | `> 0` starts a reload. An empty magazine reloads automatically. |

Actions are held between brain ticks (3 sim ticks).

## Rules that matter to a policy

All numbers are in `src/sim/constants.js`.

- 4v4 team deathmatch, first to `FRAG_LIMIT`, `TIME_LIMIT` seconds, sudden death if tied.
- 100 health, no regeneration. Rifle: 24 rounds, 9 rounds/s, 10 body / 15 head, 1.8 s reload.
- Spread grows with sustained fire, with movement speed, and in the air, and decays fast.
- Friendly fire is off and shots pass through allies.
- Health packs give 40 and return after 15 s. They are only consumed below full health.
- The overcharge spawns at the centre at 20 s and 40 s after each pickup: 1.5x damage for 15 s.
- Respawn after 3 s, with 1.2 s of protection that ends on firing.

## Evaluation

```sh
npm test
node tools/headless.mjs --a neural --b baseline --matches 20 --seed 1000
node tools/headless.mjs --a neural --b neural --matches 20 --seed 2000 --json
```

`tools/baseline-controller.js` is a simple scripted yardstick. It is never used
for the game's AI.
