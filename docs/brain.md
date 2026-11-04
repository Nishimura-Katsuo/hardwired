# HARDWIRED brain: CIRCUIT-01

This is a directly programmed recurrent neural network. **Training steps: 0.**
Every coefficient and bias is assigned by `tools/brain/build-weights.mjs` from
explicit circuit equations. There is no training, fitting, random construction,
weight search, optimizer, or score-driven parameter selection loop. Development
used permitted match feedback followed by manual, reasoned circuit edits.

## Artifact and API

- `src/brain/index.js`: `createBrain({ botId, teamId })`, `BRAIN_INFO`, and the
  returned `act(obs, action)`, `reset()`, `readout()` interface.
- `src/brain/runtime.js`: generic sparse affine/ReLU forward execution, recurrent
  buffer copying, and final action clamping. No observation semantics or policy
  conditionals occur here.
- `src/brain/weights.generated.js`: browser/Node ES module containing the actual
  coefficients, sparse connection indices, activation types, and output wiring.
- `tools/brain/build-weights.mjs`: deterministic pure-JavaScript construction.
- `test/brain.test.mjs`: API, bounds, reset, reproduction, and circuit checks.

The deployed weight file's SHA-256 is
`bc2f0761ceabbb3ce54402a55a31eb2bb712c0c5e36f6e5ca7ae8102149cbbc9`.
Regenerate it with `node tools/brain/build-weights.mjs`. The reproduction test
compares the generated source against the deployed file byte for byte.

All eight players use the same network. Constructor identity does not affect
weights or state initialization. Aggression, caution, and discipline enter only
through the observation and network connections. Runtime modules import no
filesystem, Node-specific modules, dependencies, or environment-specific APIs.

## Architecture and neuron map

There are **142 inputs, 5 recurrent states, 603 affine/ReLU units, and 7 action
outputs**. The sparse graph stores **1,103 connection coefficients and 603 biases:
1,706 parameters**, counting zero biases. Unstored matrix entries are structural
zeros. Longest feedforward dependency depth is **57**. Block metadata describes
functional groups, not seven dense MLP layers.

Each row computes `v[n] = activation(b[n] + sum(w[j] * v[source[j]]))` with either
identity or ReLU activation. Earlier units remain available through residual
connections. Values and weights use Float64; simulator actions use Float32.
All buffers are allocated at controller construction. `act()` allocates no
arrays, objects, slices, or views. `readout()` reuses eight records and copies
their values directly from the actual named units, without recomputing intent.

Indices below address the runtime's activation vector. The generated module also
contains the exact name of every unit and every sparse connection.

| Units | Circuit | Computation |
| --- | --- | --- |
| 0–141 | Observation | Unchanged binding contract ordering |
| 142–146 | Previous recurrent state | Cosine/sine clock, initialization flag, patrol latch, recent threat |
| 147–148 | Constants | Bias-created one and zero |
| 149–151 | Clock | 3.2-second rotation recurrence; first-step injection starts it from zero state |
| 152–307 | Target tournament | Presence, proximity, health, off-axis cost, enemy overcharge, and slot-0 commitment select among three slots; selected bearing, pitch, velocity, and range are routed onward |
| 308–329 | Survival | Health/caution/aggression and extra visible enemies produce retreat; health and cover availability route escape intent |
| 330–522 | Patrol/routes | Persona selects north/mid/south; arrival sets a latch to enemy base, arrival there clears it; contact, imminent power, active power, cover, and health override in that order |
| 523–625 | Tracking/orientation | Proportional yaw/pitch control with angular-velocity feedforward; route, sound, and hurt orient noncombat movement; deterministic rear-direction tie break |
| 626–705 | Movement | Range control, alternating strafe/plant rhythm, retreat route selection, close-ally repulsion, crate/stuck jump |
| 706–749 | Fire/reload | Aim-error and spread budgets gate firing; recent threat blocks opportunistic reload; retreat permits reload; final readout gates |

The five state outputs are copied simultaneously after the graph completes.
Reset clears both activation and recurrent buffers. The network itself injects
the clock's initial value on its first evaluation; no semantic initialization is
hidden in `reset()`.

### Circuit derivations

Let `R(x) = max(0,x)`.

- Saturation is `lo + R(x-lo) - R(x-hi)`.
- A threshold is a finite-width ramp, `clip((x-t)/width,0,1)`, usually with
  width `0.02` in normalized units. There are no runtime threshold decisions.
- Boolean conjunction is `R(sum(bits) - (count-1))`; negation is `1-bit`.
- Signed routing for `x` in `[-M,M]` uses
  `R(x + M*g - M) - R(-x + M*g - M)`. This passes `x` at `g=1` and zero at
  `g=0`. Two such routes implement a selection.
- The target score is `4*present + .45*near - .25*health - .4*abs(bearing)
  + .1*overcharge`, with a `.22` incumbent bonus for slot 0. Presence dominates
  the other terms. Challenger gates have explicit margins to limit switching.
- Tracking has a desired 0.12-second proportional error time constant:
  yaw gain `pi/(6*.12)` on normalized bearing and pitch gain `.5/(3*.12)`.
  Angular velocity contributes `.5*angVel`, because the input is rad/s divided
  by 3 and maximum yaw speed is 6 rad/s. This is tracking feedforward and lag
  compensation, not ballistic lead: the rifle is hitscan.
- The clock rotates its two states by `2*pi/(3.2*20)` each evaluation. At ranges
  above approximately 15 m, part of the cycle suppresses strafe and reduces
  forward speed to 12%, letting movement spread settle. The remainder relocates.
- Retreat starts when health falls below approximately
  `.22 + .25*caution - .12*aggression + .08*extraEnemy1 + .08*extraEnemy2`,
  or during a visible-threat reload. Thus crossfire raises the break-off threshold.
- Safe reload requires no currently visible target and sufficient decay of the
  recent-threat state; ammo must be below approximately 55–60%. Firing requires
  a selected target, acceptable yaw-plus-pitch error, acceptable spread, and no
  active reload. Discipline tightens aim and spread budgets.

ANVIL/BRINE take north initially, SLAG/KELP south, and EMBER/EDDY plus FLUX/RIP
the direct route. Side-route commitment survives ordinary team contacts until
arrival; direct visual combat still takes precedence. Higher aggression closes
distance more strongly; caution raises retreat/health-seeking thresholds;
discipline tightens shot selection. All are tensor effects.

An active overcharge uses its route channel. The current sensor exposes that
channel only while the item is available, so the network uses the existing mid
channel when the wait is under approximately six seconds. Mid is the pedestal's
position on this arena; no sensor extension was needed.

### Exactness and limitations

Affine arithmetic, absolute value, max, clamp, and Boolean gates are exact in
real arithmetic on their stated domains, subject to floating-point error.
Selection is exact for Boolean gates and bounded signals. Thresholds and
near-tie selections have continuous transition regions; fractional gates are
**not** exact multiplication or hard argmax. The target tournament and route
priority are intentionally approximate in those margins.

The oscillator is the assigned rotation recurrence; finite precision can drift
over an unbounded lifetime. Match resets bound its practical lifetime. The
sin/cos turning law is a heuristic approximation to bearing control and has an
explicit rear-direction tie break. Tracking gains, tactical priorities, health
thresholds, spread budgets, and route preferences are Astra-designed heuristics,
not a proof of optimal play. The five states do not store an enemy identity or
a spatial map; sticky slots and team contacts are existing sensor information.

Readout labels are FIGHT, RETREAT, HEAL, COVER, POWER, CONTACT, FLANK, RELOAD.
FIGHT measures permission to fire. Route intentions can remain active while
combat overrides movement, so these eight activations are not exclusive
probabilities. Tests and headless statistics establish functional behavior;
the final spectator presentation was not visually inspected in this task.

## Feedback-assisted development

No evaluation in the following table changed weights automatically. Every match
set used one fixed artifact. Earlier artifacts were superseded by the explicitly
described circuit changes; their raw results remain in `tools/brain/dev-*.json`.

| Stage | Seeds and matches | Measured result / reason for next edit |
| --- | --- | --- |
| Initial construction | baseline 1–3; self 100–102; idle 200–202 | Baseline 0/3 wins; self accuracy 37.84%; idle 3/3 wins |
| Instrumentation | `node tools/brain/diagnose.mjs 1` on initial network | Visible-target range means 23–26 m; neural movement spread higher than baseline; motivated planting during the strafe cycle |
| Plant/relocate circuit | baseline 10–14; self 110–112 | Baseline 4/5; self accuracy 35.32% |
| Same artifact, broader development check | baseline 20–31 | 10/12 wins |
| Persona and route repair | baseline 40–49 | 9/10 wins; both side lanes now retain commitment and highest aggression takes the direct route |
| Exact-rear tie-break repair | baseline 60–65 | 6/6 wins; added a synthetic rear-sound regression check |

The route repair followed activation inspection: the cautious persona's CONTACT
gate was almost continuously active, defeating its initial lane selection. The
rear tie-break was found by reasoning about `sin(pi)=0`, not by searching scores.
The initial development commands used `node tools/headless.mjs` with the indicated
`--a neural --b baseline|neural|idle --matches N --seed S --json` options.
The final artifact was frozen before any acceptance seed was evaluated and was
not revised after seeing held-out results.

## Acceptance results

Measured on Node **v24.15.0**. These commands were executed on the final artifact:

```sh
node tools/brain/build-weights.mjs
node tools/headless.mjs --a neural --b baseline --matches 40 --seed 5000 --json
node tools/headless.mjs --a neural --b neural --matches 40 --seed 6000 --json
node tools/headless.mjs --a neural --b idle --matches 40 --seed 7000 --json
node tools/headless.mjs --a baseline --b baseline --matches 40 --seed 6000 --json
node tools/brain/benchmark.mjs
npm test
node tools/brain/summarize.mjs
```

Raw output is saved in `tools/brain/accept-baseline-5000.json`,
`accept-self-6000.json`, `accept-idle-7000.json`, `reference-baseline-6000.json`,
`benchmark.json`, and `test-results.txt`. `acceptance-summary.json` contains the
derived per-player statistics and artifact hash. Headless alternates the neural
side in mixed-controller matches; self-play physical-side wins are also counted
explicitly by the summary script.

| Acceptance item | Result |
| --- | --- |
| Idle, seeds 7000–7039 | **40/40 wins**, no unfinished matches; mean 73.20 s |
| Held-out baseline, seeds 5000–5039 | **38/40 wins (95%)**, no unfinished matches; mean 116.22 s |
| Neural self-play, seeds 6000–6039 | **40/40 finished**; physical side wins **19–21**; mean 136.82 s |
| Self-play accuracy | **34.97%** aggregate; individual players 33.95–36.45% |
| Self-play map coverage | **153.17 mean cells**, versus baseline self-play **102.74** on the same seeds |
| Kill participation | Every player scored in every self-play match; totals 338–443 kills per player across 40 matches |
| Inference | **0.00572227 ms mean** over 200,000 calls after 10,000 warm-up calls, using eight real simulation observation snapshots from seed 300 |
| Tests | **21 passed**, including 8 brain tests; no failures or skips |

The mixed-controller headless accuracy is 33.88% across both teams; neural-only
accuracy against baseline is 37.38%. These are separate from the 34.97% self-play
acceptance measurement. Idle-match accuracy is 40.88%.

Per-player coverage and participation in self-play (same-seed baseline reference):

| Player | Neural mean cells | Baseline mean cells | Minimum neural cells in any match | Total kills |
| --- | ---: | ---: | ---: | ---: |
| ANVIL | 153.100 | 102.825 | 125 | 357 |
| EMBER | 152.000 | 102.875 | 118 | 443 |
| SLAG | 155.425 | 105.400 | 132 | 363 |
| FLUX | 152.225 | 100.675 | 131 | 357 |
| BRINE | 154.150 | 101.675 | 126 | 338 |
| EDDY | 149.900 | 103.700 | 122 | 413 |
| KELP | 159.275 | 103.325 | 117 | 353 |
| RIP | 149.275 | 101.425 | 125 | 415 |

Each player's mean coverage exceeds its baseline counterpart by 44–54%. These
are raw cells per completed match, as requested; neural matches also run longer
(136.82 s versus baseline's 104.76 s), so this is not a time-normalized movement
speed comparison. The minimum of 117 visited cells across all 320 player-match
records and the absence of zero-kill records provide additional no-spawn-stall
evidence. They do not assert that every neural run exceeds every baseline run.

No simulation files, observation contract, renderer, director, UI, entry point,
or match rules were changed. No confirmed simulation defect was identified.
No git commit was made. Acceptance results are measured samples, not a guarantee
of identical win rates on every possible future seed or arena.
