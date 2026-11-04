// Broadcast loop: simulate at a fixed tick, record to tape, render from the
// tape, and let the director choose what the audience sees.
import { Director } from './director/director.js';
import { Fx } from './render/fx.js';
import { dot, norm, sub, lookAt } from './render/mat.js';
import { Renderer } from './render/renderer.js';
import { BOT_COUNT, BOTS_PER_TEAM, DT, TICK_RATE } from './sim/constants.js';
import { createView, Recorder } from './sim/recorder.js';
import { getArena, World } from './sim/world.js';
import { Audio } from './ui/audio.js';
import { Hud } from './ui/hud.js';

const SPEEDS = [0.5, 1, 2, 4];
const params = new URLSearchParams(location.search);

/** The network is the game's AI; ?ai=baseline swaps in the scripted yardstick for comparison. */
async function loadControllers() {
  if (params.get('ai') === 'baseline') {
    const { createBaselineController } = await import('../tools/baseline-controller.js');
    return {
      info: { parameters: 0, trainingSteps: 0 },
      make: () => createBaselineController(),
    };
  }
  const { createBrain, BRAIN_INFO } = await import('./brain/index.js');
  return {
    info: BRAIN_INFO,
    make: (botId) => createBrain({ botId, teamId: botId < BOTS_PER_TEAM ? 0 : 1 }),
  };
}

async function start() {
  const arena = getArena();
  const canvas = document.getElementById('screen');
  const renderer = new Renderer(canvas, arena);
  const { info, make } = await loadControllers();
  const brains = Array.from({ length: BOT_COUNT }, (_, i) => make(i));

  let seed = Number(params.get('seed') ?? (Date.now() % 100000));
  let world = new World({ seed, controllers: brains });
  const recorder = new Recorder();
  const director = new Director(arena, { seed });
  const fx = new Fx();
  const audio = new Audio();
  const hud = new Hud(arena, info);
  const view = createView();

  let accumulator = 0;
  let speedIndex = 1;
  let paused = false;
  let replay = null;
  let lastViewTick = 0;
  let last = performance.now();
  let time = 0;
  let crowd = 0;
  let flash = 0;
  let replayMix = 0;
  const wipe = document.getElementById('wipe');
  let wipeT = 0;
  let wipeAction = null;

  recorder.capture(world);

  const runWipe = (action) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    wipe.classList.remove('run');
    void wipe.offsetWidth;
    wipe.classList.add('run');
    wipeT = 0.67;
    wipeAction = action;
    audio.whoosh();
  };

  const beginReplay = (r) => {
    runWipe(() => {
      replay = r;
      lastViewTick = Math.max(recorder.oldest, r.moment.start);
      r.tick = lastViewTick;
      fx.reset();
      document.body.classList.add('replaying');
    });
  };

  const endReplay = () => {
    runWipe(() => {
      replay = null;
      director.endReplay();
      lastViewTick = recorder.head;
      fx.reset();
      document.body.classList.remove('replaying');
    });
  };

  const nextMatch = () => {
    replay = null;
    wipeAction = null;
    document.body.classList.remove('replaying');
    seed += 1;
    world = new World({ seed, controllers: brains });
    for (const b of brains) b.reset?.();
    recorder.clear();
    recorder.capture(world);
    lastViewTick = recorder.head;
    accumulator = 0;
    fx.reset();
    director.resetMatch();
    hud.newMatch();
  };

  const spot = (x, y, z) => {
    const cam = director.camera;
    const to = sub([x, y, z], cam.pos);
    const d = Math.hypot(to[0], to[1], to[2]);
    const { right } = lookAt(cam.pos, cam.look);
    return { gain: 1 / (1 + d * 0.06), pan: Math.max(-0.8, Math.min(0.8, dot(norm(to), right) * 0.8)) };
  };

  const replayEvent = (e) => {
    fx.consume(e, arena, view);
    audio.event(e, spot, replay ? replay.speed : 1);
    if (e.type === 'kill') {
      crowd = Math.max(crowd, 1);
      audio.cheer(0.7);
    }
  };

  const onKey = (e) => {
    if (document.getElementById('title').classList.contains('gone') === false) return;
    const key = e.key.toLowerCase();
    if (key >= '1' && key <= '8') director.lockTo(Number(key) - 1);
    else if (key === '0') director.lockTo(-1);
    else if (key === 'c') director.cycleLockedRig();
    else if (key === 'r') {
      const r = director.requestManualReplay();
      if (r) beginReplay(r);
    } else if (key === ' ') {
      paused = !paused;
      e.preventDefault();
    } else if (key === '[') speedIndex = Math.max(0, speedIndex - 1);
    else if (key === ']') speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1);
    else if (key === 'h') hud.toggle();
    else if (key === 'm') audio.toggleMute();
    else if (key === 'tab') {
      e.preventDefault();
      hud.setTable(true);
    }
  };
  addEventListener('keydown', onKey);
  addEventListener('keyup', (e) => {
    if (e.key === 'Tab') hud.setTable(false);
  });

  const dismiss = (withSound) => {
    if (withSound) audio.start();
    else {
      audio.start();
      audio.toggleMute();
    }
    document.getElementById('title').classList.add('gone');
    hud.show();
  };
  document.getElementById('start').addEventListener('click', () => dismiss(true));
  document.getElementById('start-muted').addEventListener('click', () => dismiss(false));
  if (params.has('skip')) dismiss(false);

  const advance = () => {
    world.tick();
    recorder.capture(world);
    for (const e of world.drainEvents()) {
      recorder.addEvent(e);
      director.onEvent(e, world.score);
      hud.onEvent(e, world);
    }
    if (world.phase === 'ended' && world.phaseT <= 0) nextMatch();
  };

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;

    if (!paused) {
      accumulator += dt * SPEEDS[speedIndex];
      while (accumulator >= DT) {
        accumulator -= DT;
        advance();
      }
    }

    if (wipeT > 0) {
      wipeT -= dt;
      if (wipeT <= 0.34 && wipeAction) {
        wipeAction();
        wipeAction = null;
      }
      if (wipeT <= 0) wipe.classList.remove('run');
    }

    if (!replay && !wipeAction) {
      const started = director.takeReplay();
      if (started) beginReplay(started);
    }

    const liveTick = Math.max(recorder.oldest, recorder.head - 1 + accumulator * TICK_RATE);
    if (replay && !paused) {
      replay.tick += dt * TICK_RATE * replay.speed;
      if (replay.tick >= replay.moment.end && !wipeAction) endReplay();
    }
    const viewTick = replay ? replay.tick : liveTick;
    recorder.sample(viewTick, view);

    const pending = Math.floor(viewTick);
    for (let t = lastViewTick + 1; t <= pending; t++) for (const e of recorder.eventsAt(t)) replayEvent(e);
    lastViewTick = Math.max(lastViewTick, pending);

    const visualDt = paused ? 0 : dt * (replay ? replay.speed : 1);
    fx.update(visualDt);
    const cam = director.update(paused ? 0 : dt * (replay ? replay.speed : SPEEDS[speedIndex]), view);

    crowd = Math.max(0, crowd - dt * 0.35);
    flash = Math.max(0, flash - dt * 4);
    replayMix += ((replay ? 1 : 0) - replayMix) * Math.min(1, dt * 8);
    const followed = view.bots[cam.hideBot >= 0 ? cam.hideBot : 0];
    renderer.render(view, cam, fx, {
      time,
      crowd,
      replay: replayMix,
      hurt: cam.viewmodel ? Math.max(0, followed.hurt - 0.4) : 0,
      flash,
    });

    audio.update(dt);
    hud.update(dt, world, view, director, brains);
    requestAnimationFrame(frame);
  }

  window.__hardwired = {
    get world() { return world; },
    director, recorder, view, renderer,
    advance(ticks) {
      for (let i = 0; i < ticks; i++) advance();
    },
  };
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  el.textContent = err.message;
  el.hidden = false;
});
