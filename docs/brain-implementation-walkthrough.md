# HARDWIRED brain implementation walkthrough

I built the HARDWIRED bot controller by translating gameplay decisions into a
recurrent neural network and assigning its weights directly. The delivered
network has 1,706 parameters and zero training steps. It won 38 of 40 held-out
matches against the baseline controller and all 40 matches against idle bots.

This walkthrough records the implementation in order: what I inspected, how I
constructed the circuits, what the development matches revealed, what I changed,
and how I checked the final artifact. [The brain reference](brain.md) contains
the exact neuron ranges, artifact hash, and full per-player acceptance table.

## Step 1 Read the interface and the simulation

I started with the files specified in the task:

- [Bot contract](bot-contract.md): the controller API, observation layout,
  action meanings, and policy/runtime boundary.
- [Observation layout](../src/sim/observation.js): field names and numerical
  indices, including the seven action indices.
- [Sensors](../src/sim/sensors.js): how observations are actually produced,
  including visibility, noise, enemy ordering, and route channels.
- [Constants](../src/sim/constants.js): timing, movement, weapon rules, and
  the roster's aggression, caution, and discipline values.
- [World simulation](../src/sim/world.js): when controllers run and how their
  outputs affect turning, movement, firing, reloading, damage, and pickups.
- [Match runner](../tools/run-match.js), [headless CLI](../tools/headless.mjs),
  and [baseline controller](../tools/baseline-controller.js): how to evaluate
  the actual exported brain against existing opponents.

I also read the arena implementation to understand lane landmarks, the central
overcharge pedestal, obstacle heights, and route steering. I used the
weight-space-programming skill and its circuit cookbook for the construction
method, particularly ReLU arithmetic, bounded gates, and recurrent state.

Several details determined the design. Brains run at 20 Hz; actions persist
between evaluations; turning is filtered by the simulation. Positive yaw and
strafe both point left. Enemy bearing is divided by pi, pitch error by 0.5
radians, and angular velocity by 3 rad/s. Those encodings must be undone in the
weights rather than guessed from field names.

The weapon is hitscan. That means the angular-velocity input is useful for
tracking a moving target and compensating for control lag, rather than aiming
ahead for a projectile's flight time.

The route sensors already provide directions toward health, cover, contacts,
lanes, and objectives. I concluded that no sensor extension was necessary. The
network could decide which route mattered while leaving path geometry to the
existing sensors, as the contract permits.

## Step 2 Separate construction from execution

I kept the policy description and inference engine in different files:

1. The construction script describes decisions using named arithmetic circuits.
2. It compiles those circuits into explicit coefficients, biases, activation
   types, and connection indices.
3. The generated JavaScript module embeds that data for both browser and Node.
4. A generic runtime evaluates the data without knowing what any input means.

This separation enforces the central constraint. For example, the runtime does
not contain a health check followed by a scripted retreat. It evaluates rows
whose assigned weights combine health, temperament, and enemy presence into a
retreat activation. Other rows use that activation to route movement commands.

The construction script contains ordinary JavaScript loops to assemble repeated
circuits. Those loops generate the network; they do not execute gameplay policy
outside it or search for successful weights.

## Step 3 Choose a sparse recurrent ReLU graph

I chose a graph of affine and ReLU units with connections to earlier units.
This supports direct arithmetic, comparisons with finite transition widths,
bounded selection, and persistent state without requiring a large dense matrix.

The final graph has:

| Component | Count |
| --- | ---: |
| Observation inputs | 142 |
| Recurrent state values | 5 |
| Affine or ReLU units | 603 |
| Stored connection coefficients | 1,103 |
| Biases, including zero biases | 603 |
| Total assigned parameters | 1,706 |
| Action outputs | 7 |
| Longest feedforward dependency chain | 57 |

Each unit computes an affine expression, optionally followed by ReLU:

```text
sum = bias + weight0 * source0 + weight1 * source1 + ...
value = sum              for an identity unit
value = max(0, sum)      for a ReLU unit
```

Connections to earlier activations supply residual wiring. The seven named
functional blocks in the metadata are groups of circuits, not seven dense
layers. All players receive the same coefficients. Player and team identifiers
are accepted by the API but do not alter the policy.

## Step 4 Build reusable arithmetic circuits

I implemented small construction helpers in
[build-weights.mjs](../tools/brain/build-weights.mjs). They create rows and return
the indices of the units that compute their results.

For `R(x) = max(0, x)`, the main identities are:

```text
abs(x) = R(x) + R(-x)
max(a, b) = b + R(a - b)
clip(x, lo, hi) = lo + R(x - lo) - R(x - hi)
NOT(g) = 1 - g
AND(g1, ..., gn) = R(g1 + ... + gn - (n - 1))
```

AND is Boolean conjunction when its inputs are bits. A threshold uses a short
continuous ramp:

```text
threshold(x) = clip((x - thresholdStart) / transitionWidth, 0, 1)
```

The default transition width is 0.02 in the relevant normalized signal. This
avoids claiming that a finite ReLU graph implements an exact discontinuous step
on arbitrary continuous inputs.

To pass or suppress a signed signal bounded by `M`, I used:

```text
gate(x, g) = R(x + M*g - M) - R(-x + M*g - M)
```

At `g = 1`, this returns `x`; at `g = 0`, it returns zero. Two gates select
between two alternatives. Within a fractional gate's transition region, this
is a continuous routing approximation, not exact multiplication.

These helpers are the building blocks for target selection, route priorities,
movement mode changes, and fire permission. They produce actual network units
and connections rather than runtime callbacks.

## Step 5 Add recurrent memory

I allocated five state values, all cleared by `reset()`:

| State | Purpose |
| --- | --- |
| `clockCos` | First component of a periodic movement clock |
| `clockSin` | Second component of the same clock |
| `started` | Lets the network initialize the clock after reset |
| `patrol` | Remembers whether to continue from the chosen lane to enemy base |
| `threat` | Retains recent combat presence briefly after visibility is lost |

The clock is a two-dimensional rotation. Its coefficients are the sine and
cosine of `2*pi/(3.2*20)`, giving a nominal 3.2-second period at 20 Hz. The
construction script calculates those constants once. During inference, the
runtime only performs weighted sums; it does not calculate a gameplay clock
using trigonometry or wall-clock time.

Because reset clears memory to zero, the network uses `1 - started` to inject
the first cosine value. It then writes one into `started`. Initialization thus
also lives in the network.

The threat state is the maximum of current target presence and its previous
value minus 0.05. It decays over about one second from full activation. The
reload circuit uses a threshold on that state to avoid immediately treating a
briefly hidden enemy as a safe reload opportunity.

## Step 6 Construct target selection and aiming

The sensor supplies three enemy slots. Slot 0 is already sticky while its enemy
remains visible, but the network can select a challenger. I assigned this score
to each slot:

```text
score = 4*present
      + 0.45*near
      - 0.25*health
      - 0.4*abs(bearing)
      + 0.1*overcharge
```

Slot 0 receives an additional 0.22 commitment bonus. Presence dominates the
other terms so an absent slot cannot win merely because it has zero health or
zero bearing error. Proximity, vulnerability, aim alignment, and enemy
overcharge provide smaller preferences.

A two-stage tournament compares slot 1 against slot 0 and then slot 2 against
the best score. Gates route the selected target's fields into the aiming and
movement circuits. Small score differences have transition regions rather than
an exact hard winner.

I derived aiming gains from a desired proportional error time constant of
0.12 seconds and the simulator's maximum turn rates:

```text
yaw command = clip(bearing * pi / (6 * 0.12)
                   + angVel * 0.5, -1, 1)

pitch command = clip(pitchError * 0.5 / (3 * 0.12), -1, 1)
```

The `0.5` angular-velocity coefficient follows from the input scale of 3 rad/s
and maximum yaw rate of 6 rad/s. The time constant is a design choice, not a
fitted parameter or a formal stability guarantee for the filtered simulation.

## Step 7 Construct survival and route decisions

The retreat circuit combines health, temperament, and additional visible
enemies. Its approximate health threshold is:

```text
0.22 + 0.25*caution - 0.12*aggression
     + 0.08*enemySlot1Present + 0.08*enemySlot2Present
```

This makes cautious players break off earlier and raises the threshold when
multiple enemies are visible. A visible enemy during reloading also activates
retreat. When healing is warranted and a health route is available, that route
takes priority; cover is available when retreating without selecting healing.

For ordinary map movement, the network chooses a lane and retains a patrol
latch. Reaching the lane switches the destination to enemy base; reaching enemy
base clears the latch. This prevents the default patrol from simply stopping
at the first landmark.

Route selection is a sequence of network selectors. Starting from patrol, the
network can override with contact pursuit, imminent overcharge, active
overcharge, cover, and finally healing. Combat movement can override ordinary
route movement, while retreat and healing can restore route-following movement.

The overcharge route is inactive before the item spawns. To contest it early,
the network uses the mid route when the remaining wait is roughly six seconds
or less. The arena's mid landmark coincides with the central pedestal, so this
works with the existing observation contract.

## Step 8 Construct movement and weapon control

Outside combat, forward and strafe commands follow the selected route's cosine
and sine. In combat, forward movement depends on range and temperament; the
recurrent clock produces lateral movement. A close-ally circuit adds modest
repulsion to reduce crowding.

Floor-height observations distinguish a low obstacle suitable for vaulting
from a taller obstruction. A separate stuck threshold can request a jump. Both
decisions are network activations.

When no enemy is selected, the turning circuit follows the route, but sound can
override it and recent damage can override sound. With a selected target,
tracking takes precedence. Noncombat pitch returns toward level.

Firing combines four requirements: a selected target, acceptable combined
yaw/pitch error, acceptable spread, and no active reload. The aim budget is
more permissive for close targets and stricter for disciplined personas. The
spread budget similarly tightens with discipline. The fire output converts
permission from `[0,1]` to `[-1,1]` so the simulator's positive-action test has
the intended meaning.

Opportunistic reload requires low ammunition and a sufficiently safe state;
retreat can also permit it. The simulator retains its existing automatic reload
when the magazine is empty. The policy does not modify that rule.

## Step 9 Implement the runtime and public API

I wrote [runtime.js](../src/brain/runtime.js) to allocate buffers once and execute
the graph in index order. Each `act()` evaluation:

1. Copies observations into the activation buffer.
2. Copies previous recurrent state into its input positions.
3. Evaluates every sparse affine/ReLU row.
4. Copies the five designated state outputs into recurrent memory.
5. Copies and clamps the seven designated action outputs.

This path creates no arrays, objects, slices, or views per call. Weights and
internal activations use Float64; the simulator supplies Float32 observation
and action arrays.

In [index.js](../src/brain/index.js), I exposed the required factory and
`BRAIN_INFO`, including `trainingSteps: 0`. The readout records are allocated
once. Each `readout()` call copies values from real units named FIGHT, RETREAT,
HEAL, COVER, POWER, CONTACT, FLANK, and RELOAD.

FIGHT is fire permission, rather than a general probability of being in combat.
The readouts are not mutually exclusive probabilities: a route intention may
remain active while combat temporarily overrides movement.

## Step 10 Run the initial development matches

After generating the first weight artifact, I ran three sets:

```sh
node tools/headless.mjs --a neural --b baseline --matches 3 --seed 1 --json
node tools/headless.mjs --a neural --b neural --matches 3 --seed 100 --json
node tools/headless.mjs --a neural --b idle --matches 3 --seed 200 --json
```

The initial network lost all three baseline matches, won all three idle
matches, and produced 37.84% accuracy in self-play. The baseline losses showed
that functioning circuits were not enough to establish competitive behavior.

I then wrote [diagnose.mjs](../tools/brain/diagnose.mjs) to instrument one match
without altering decisions or weights. It recorded combat frequency, fire
permission, alignment, range, spread, reload time, stuck time, and readout
activity. I ran it on seed 1.

The initial diagnostic showed mean visible-target distances of about 23–26 m
for the neural players. Their normalized spread averages were approximately
0.53–0.59, compared with about 0.44–0.50 for the baseline players. That suggested
that persistent movement was hurting long-range shooting enough to warrant a
reasoned movement change.

## Step 11 Add planted firing phases

I changed the movement circuit so that, at longer range, part of the existing
clock cycle plants the bot's feet: strafe is suppressed and the forward command
is reduced to 12% of its normal value. The remainder of the cycle relocates the
bot. The transition to this behavior spans roughly 12.5–15 m.

This was a feedback-assisted edit. I did not try a list of speeds or periods
and retain the highest-scoring value. I used the observed long-range spread
problem to change the movement mechanism, then evaluated the resulting fixed
artifact.

The next checks were:

```sh
node tools/headless.mjs --a neural --b baseline --matches 5 --seed 10 --json
node tools/headless.mjs --a neural --b neural --matches 3 --seed 110 --json
node tools/headless.mjs --a neural --b baseline --matches 12 --seed 20 --json
```

The baseline results were 4/5 wins and then 10/12 wins. Self-play accuracy was
35.32%. Because these sets used different seeds from the initial matches, the
results supported continuing with the revised policy; they were not an isolated
same-seed causal measurement of the planting circuit alone.

## Step 12 Test the interface and important circuits

I added eight tests in [brain.test.mjs](../test/brain.test.mjs):

1. API shape, zero training steps, shared behavior across identities, and readout
   values matching actual network units.
2. Finite, bounded actions across 2,000 deterministic input patterns.
3. Reset clearing activations and exactly replaying a 100-step trajectory.
4. Byte-for-byte generator reproduction and connections referring only to
   previously available inputs or units.
5. Selecting a visible target in any of the three slots over absent targets.
6. Angular-velocity feedforward and suppression of firing when off-axis or
   reloading.
7. Responses to health, cover, safe reload, sound, and persona inputs.
8. The patrol latch advancing at the lane and clearing at enemy base.

The input stress patterns vary observations, not weights. They are numerical
robustness checks rather than training examples. Tests inspect named units
through the generic runtime, so a fault can be localized to a circuit instead
of inferred only from match scores.

## Step 13 Repair route commitment and the rear-direction edge case

The diagnostic also showed the cautious player's CONTACT activation was almost
always active. Reading the route circuitry explained why: the original
commitment exception protected the north route but not the south route.
Contacts therefore displaced the cautious player's south-lane choice too soon.

I extended commitment to both side lanes and adjusted persona routing so the
most aggressive player takes the direct route. The final initial preferences
are ANVIL/BRINE north, SLAG/KELP south, and EMBER/EDDY plus FLUX/RIP mid. These
preferences come from temperament values, not player-name branches.

I tested this artifact on baseline seeds 40–49 and measured 9/10 wins.

I then identified a mathematical edge case in the noncombat turning law. A
direction exactly behind the bot has sine zero and negative cosine; a symmetric
sign ramp could produce zero turn. I shifted that ramp to choose a deterministic
turn direction at the exact rear. I added a rear-sound assertion to the tests.
The following final development run won 6/6:

```sh
node tools/headless.mjs --a neural --b baseline --matches 6 --seed 60 --json
```

The route change was informed by feedback and inspection. The rear-direction
repair followed from the circuit's boundary behavior. Neither involved fitting
or automated weight selection.

## Step 14 Freeze the artifact and evaluate held-out seeds

I froze the resulting weights before evaluating the acceptance seeds. The
baseline seeds 5000–5039 had not been used in development. I ran the four
independent match sets below, preserving the full JSON outputs:

```sh
node tools/headless.mjs --a neural --b baseline --matches 40 --seed 5000 --json
node tools/headless.mjs --a neural --b neural --matches 40 --seed 6000 --json
node tools/headless.mjs --a neural --b idle --matches 40 --seed 7000 --json
node tools/headless.mjs --a baseline --b baseline --matches 40 --seed 6000 --json
```

| Evaluation | Measured outcome |
| --- | --- |
| Neural versus baseline | 38/40 wins, or 95%; all finished |
| Neural versus idle | 40/40 wins; all finished |
| Neural self-play | All 40 finished; physical-side wins 19–21 |
| Neural self-play accuracy | 34.97% aggregate |
| Neural self-play participation | Every player scored in every match |
| Neural self-play coverage | 153.17 mean cells per player per match |
| Baseline self-play coverage | 102.74 mean cells on the same seeds |

Each player's mean coverage was 44–54% above the corresponding baseline
player's mean. The lowest neural coverage in any of the 320 player-match records
was 117 cells, and each player's total kills across the set ranged from 338 to
443. Those measurements support the no-spawn-stall and shared-participation goals.

Coverage is raw cells per match. Neural self-play lasted 136.82 seconds on
average, compared with 104.76 seconds for baseline self-play, so the coverage
comparison is not a measure of movement speed normalized by time.

I did not change the weights after seeing the held-out results.

## Step 15 Measure inference cost and finish verification

I wrote [benchmark.mjs](../tools/brain/benchmark.mjs) to create a real world at
seed 300, advance it 1,200 simulation ticks, and use the resulting eight player
observation snapshots for inference timing. It warms up with 10,000 calls, then
times 200,000 calls across the eight controllers.

On Node v24.15.0, the saved final result is **0.0057222695 milliseconds per
call**, approximately 5.72 microseconds. This measures inference on fixed real
observation snapshots, not the cost of sensing, physics, rendering, or complete
live matches. It is below the requested 0.25 ms mean inference limit.

I ran the full repository test suite with `npm test`. At that point it contained
21 tests, including the eight brain tests; all passed with no skips. These are
the recorded implementation-run results, not a claim that this documentation
follow-up reran the suite.

The saved weight file has SHA-256:

```text
bc2f0761ceabbb3ce54402a55a31eb2bb712c0c5e36f6e5ca7ae8102149cbbc9
```

The reproduction test checks generated bytes against the deployed module. It
does not merely compare parameter counts or model outputs.

## Step 16 Preserve the implementation and evidence

I added [summarize.mjs](../tools/brain/summarize.mjs) to read the saved acceptance
outputs, compute per-player totals and coverage, count physical-side wins,
calculate graph depth, and hash the weight file. It does not run matches or
modify weights.

The main evidence files are:

- [Acceptance summary](../tools/brain/acceptance-summary.json).
- [Held-out baseline matches](../tools/brain/accept-baseline-5000.json).
- [Self-play matches](../tools/brain/accept-self-6000.json).
- [Idle matches](../tools/brain/accept-idle-7000.json).
- [Baseline coverage reference](../tools/brain/reference-baseline-6000.json).
- [Inference benchmark](../tools/brain/benchmark.json).
- [Recorded test output](../tools/brain/test-results.txt).

The earlier development match outputs are also retained as `dev-*.json` in
`tools/brain/`. Earlier weight artifacts were not separately checkpointed.
Running a development command now evaluates the final network, not the earlier
version that produced its historical log. Likewise, rerunning `diagnose.mjs`
now instruments the final network; the initial diagnostic figures above refer
to the diagnostic run performed before the edits.

All implementation changes stayed within the assigned brain, brain-tool, test,
and documentation areas. I made no simulation or observation-contract changes,
identified no confirmed simulation defect, and made no git commit.

The headless results establish the measured performance and behavior described
here. The tactical constants remain manually chosen heuristics, and the final
spectator presentation was not visually inspected during this implementation.
