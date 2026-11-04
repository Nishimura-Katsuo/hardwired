<img src="assets/icon.svg" width="64" height="64" alt="">

# HARDWIRED

A 4v4 first-person shooter league played entirely by robots and shown as a live
TV broadcast. None of the players were trained: their network's weights were
designed and written directly with weight-space programming.

**[Watch it live](https://nishimura-katsuo.github.io/hardwired/)**

```sh
npm start        # then open http://localhost:8080
```

No build step and no dependencies. Needs Node 20+ and a WebGL2 browser.

## Initial Prompt

Design a a basic competitive first person shooter game played by bots with a dynamic spectator camera. For the bots' AI, use an Astra 6 extra high subagent to design a neural network and program the weights directly (no training of any kind) using weight-space programming. You can handle everything about the game except for the neural network, since Astra is better at weight-space programming.

## Watching

An automated director runs the broadcast. It scores fights already happening and
fights about to happen, picks a subject and a camera, cuts between them, and rolls
instant replays of the best kills. You can take over at any time.

| Key | Action |
| --- | --- |
| `1` to `8` | Follow a player |
| `0` | Hand back to the director |
| `C` | Change camera while following |
| `R` | Replay the last kill |
| `Tab` | Hold for the scoreboard |
| `Space` | Pause |
| `[` `]` | Match speed |
| `H` | Hide graphics |
| `M` | Mute |

Add `?seed=123` for a repeatable match, or `?ai=baseline` to watch the scripted
yardstick bots instead of the network.

## How it fits together

| Path | Role |
| --- | --- |
| `src/sim/` | Deterministic 60 Hz match simulation, sensors, and the replay tape. No DOM. |
| `src/brain/` | The network and its inference runtime. Decisions live in the weights. |
| `src/director/` | The spectator camera: event scoring, shot selection, camera rigs, replays. |
| `src/render/` | WebGL2 renderer: shadows, HDR, bloom, procedural materials, effects. |
| `src/ui/` | Broadcast graphics and procedural audio. |
| `tools/` | Dev server, headless match runner, scripted baseline, weight generator. |

Live play and replays share one path: the sim writes to a rolling tape, and the
renderer, director, and effects all read from it at a playhead.

[`docs/bot-contract.md`](docs/bot-contract.md) defines the boundary between the
game and the network. [`docs/brain.md`](docs/brain.md) describes the network.

## Testing

```sh
npm test
node tools/headless.mjs --a neural --b baseline --matches 20 --seed 1000
```

The sim and director run headlessly, so whole matches and broadcasts are tested in
Node at many times real speed.
