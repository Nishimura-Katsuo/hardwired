// Bots are assembled from boxes and animated procedurally. On death every plate
// flies off on a ballistic arc computed from deathT alone, so a replay of the
// same moment is identical and slow motion costs nothing.
import { TEAMS } from '../sim/constants.js';

export const INSTANCE_FLOATS = 16;
const BODY = [0.74, 0.73, 0.70];
const DARK = [0.075, 0.08, 0.1];
const STEEL = [0.26, 0.27, 0.3];

/** Rest pose. `joint` picks the animation channel the part follows. */
const PARTS = [
  { joint: 'root', at: [0, 0, 0.98], half: [0.15, 0.2, 0.1], tint: DARK },
  { joint: 'spine', at: [0, 0, 1.26], half: [0.17, 0.25, 0.2], tint: 'team' },
  { joint: 'spine', at: [0.13, 0, 1.3], half: [0.055, 0.18, 0.13], tint: BODY },
  { joint: 'spine', at: [-0.23, 0, 1.3], half: [0.075, 0.15, 0.17], tint: DARK },
  { joint: 'spine', at: [-0.3, 0, 1.3], half: [0.018, 0.09, 0.11], tint: 'teamGlow', glow: 1.4 },
  { joint: 'spine', at: [0, 0.32, 1.42], half: [0.13, 0.095, 0.08], tint: 'team' },
  { joint: 'spine', at: [0, -0.32, 1.42], half: [0.13, 0.095, 0.08], tint: 'team' },
  { joint: 'head', at: [0, 0, 1.63], half: [0.13, 0.115, 0.11], tint: BODY },
  { joint: 'head', at: [0.115, 0, 1.65], half: [0.03, 0.098, 0.034], tint: 'teamGlow', glow: 3.4 },
  { joint: 'head', at: [-0.05, 0.1, 1.81], half: [0.012, 0.012, 0.07], tint: DARK },
  { joint: 'legL', at: [0, 0.13, 0.72], half: [0.075, 0.075, 0.2], tint: BODY },
  { joint: 'legR', at: [0, -0.13, 0.72], half: [0.075, 0.075, 0.2], tint: BODY },
  { joint: 'shinL', at: [0, 0.13, 0.3], half: [0.08, 0.075, 0.2], tint: 'team' },
  { joint: 'shinR', at: [0, -0.13, 0.3], half: [0.08, 0.075, 0.2], tint: 'team' },
  { joint: 'shinL', at: [0.06, 0.13, 0.06], half: [0.15, 0.08, 0.05], tint: DARK },
  { joint: 'shinR', at: [0.06, -0.13, 0.06], half: [0.15, 0.08, 0.05], tint: DARK },
  { joint: 'aim', at: [0.18, 0.31, 1.27], half: [0.2, 0.05, 0.05], tint: DARK },
  { joint: 'aim', at: [0.2, -0.28, 1.27], half: [0.22, 0.05, 0.05], tint: DARK },
  { joint: 'aim', at: [0.42, 0.06, 1.3], half: [0.3, 0.035, 0.055], tint: STEEL },
  { joint: 'aim', at: [0.82, 0.06, 1.32], half: [0.16, 0.016, 0.016], tint: DARK },
  { joint: 'aim', at: [0.42, 0.06, 1.17], half: [0.05, 0.025, 0.09], tint: DARK },
  { joint: 'aim', at: [0.38, 0.06, 1.39], half: [0.12, 0.018, 0.022], tint: 'teamGlow', glow: 2.6 },
];

const PIVOTS = { root: [0, 0, 0.98], spine: [0, 0, 1.05], head: [0, 0, 1.52], aim: [0, 0, 1.3], legL: [0, 0.13, 0.92], legR: [0, -0.13, 0.92] };

const hash = (n) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

function writeInstance(out, i, m, color, glow) {
  const o = i * INSTANCE_FLOATS;
  out.set(m, o);
  out[o + 12] = color[0];
  out[o + 13] = color[1];
  out[o + 14] = color[2];
  out[o + 15] = glow;
}

/** 3x4 transform stored as three rows: rotation R, translate T, scale S. */
function compose(out, r, t, s) {
  out[0] = r[0] * s[0]; out[1] = r[1] * s[1]; out[2] = r[2] * s[2]; out[3] = t[0];
  out[4] = r[3] * s[0]; out[5] = r[4] * s[1]; out[6] = r[5] * s[2]; out[7] = t[1];
  out[8] = r[6] * s[0]; out[9] = r[7] * s[1]; out[10] = r[8] * s[2]; out[11] = t[2];
}

const rotZ = (a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
/** Rotation about local +y; positive tips the +x axis downward. */
const rotY = (a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const mul3 = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const apply3 = (r, v) => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];

const tmp = new Float32Array(12);

/** Appends instances for one bot starting at slot `n`; returns the next slot. */
export function writeBot(out, n, bot, time, arena) {
  const team = TEAMS[bot.team].color;
  const glowTeam = [team[0] * 1.1, team[1] * 1.1, team[2] * 1.1];
  const speed = Math.hypot(bot.vx, bot.vy);
  const stride = Math.sin(bot.gait * 2.5) * Math.min(1, speed / 3) * 0.62;
  const kick = bot.shotAge < 0.09 ? (0.09 - bot.shotAge) * 1.1 : 0;
  const bob = Math.abs(Math.cos(bot.gait * 2.5)) * Math.min(1, speed / 3) * 0.035;
  const lean = Math.min(0.2, speed * 0.03);
  const reloadDip = bot.reload > 0 ? 0.5 * Math.sin(Math.min(1, bot.reload / 1.8) * Math.PI) : 0;
  const yawRot = rotZ(bot.yaw);
  const spawnPulse = bot.protect > 0 ? 2.5 * (0.5 + 0.5 * Math.sin(time * 34)) : 0;
  const hurtPulse = bot.alive && bot.hurt > 0.75 ? 7 * (bot.hurt - 0.75) : 0;
  const oc = bot.overcharge > 0 ? 3.5 + Math.sin(time * 9) * 1.5 : 0;

  const channel = {
    root: { r: rotY(0), lift: bob },
    spine: { r: rotY(lean - bot.pitch * 0.25), lift: bob },
    head: { r: rotY(-bot.pitch * 0.7 + lean * 0.5), lift: bob },
    aim: { r: rotY(-bot.pitch + kick * 0.9 + reloadDip), lift: bob, push: -kick },
    legL: { r: rotY(-stride), lift: bob },
    legR: { r: rotY(stride), lift: bob },
  };
  channel.shinL = { ...channel.legL, r: mul3(channel.legL.r, rotY(Math.max(0, stride) * 1.1)) };
  channel.shinR = { ...channel.legR, r: mul3(channel.legR.r, rotY(Math.max(0, -stride) * 1.1)) };

  const ground = bot.alive ? 0 : arena.heightAt(bot.x, bot.y);
  for (let p = 0; p < PARTS.length; p++) {
    const part = PARTS[p];
    let rot;
    let pos;
    let scale = part.half;
    if (bot.alive) {
      const ch = channel[part.joint];
      const pivot = PIVOTS[part.joint] ?? PIVOTS[part.joint.replace('shin', 'leg')];
      const local = apply3(ch.r, [part.at[0] - pivot[0], part.at[1] - pivot[1], part.at[2] - pivot[2]]);
      const worldLocal = apply3(yawRot, [local[0] + pivot[0] + (ch.push ?? 0), local[1] + pivot[1], local[2] + pivot[2] + ch.lift]);
      pos = [bot.x + worldLocal[0], bot.y + worldLocal[1], bot.z + worldLocal[2]];
      rot = mul3(yawRot, ch.r);
    } else {
      // Scrapping sequence. Each plate has its own launch from a per-part seed.
      const t = bot.deathT;
      const seed = bot.id * 31 + p * 7;
      const angle = hash(seed) * Math.PI * 2;
      const burst = 1.2 + hash(seed + 1) * 3.2;
      const up = 2 + hash(seed + 2) * 4.8;
      const spin = 3 + hash(seed + 3) * 9;
      const rest = apply3(yawRot, part.at);
      let z = bot.z + rest[2] + up * t - 7 * t * t;
      const floor = Math.max(ground, arena.heightAt(bot.x + rest[0], bot.y + rest[1])) + part.half[2];
      const settled = z <= floor;
      if (settled) z = floor;
      const flight = settled ? Math.min(t, (up + Math.sqrt(Math.max(0, up * up + 28 * (bot.z + rest[2] - floor)))) / 14) : t;
      pos = [bot.x + rest[0] + Math.cos(angle) * burst * flight, bot.y + rest[1] + Math.sin(angle) * burst * flight, z];
      rot = mul3(rotZ(bot.yaw + spin * flight), rotY(spin * 0.7 * flight));
      const fade = t > 2.4 ? Math.max(0, 1 - (t - 2.4) / 0.5) : 1;
      scale = [part.half[0] * fade, part.half[1] * fade, part.half[2] * fade];
    }
    compose(tmp, rot, pos, scale);
    const isTeam = part.tint === 'team';
    const isGlow = part.tint === 'teamGlow';
    const color = isGlow || isTeam ? (isGlow ? glowTeam : team) : part.tint;
    let glow = (part.glow ?? 0) + (isGlow && !bot.alive ? -part.glow * 0.8 : 0);
    if (isGlow) glow += oc;
    glow += spawnPulse * 0.5 + (isTeam ? spawnPulse * 0.35 : 0) + (part.tint === BODY ? hurtPulse : hurtPulse * 0.4);
    writeInstance(out, n++, tmp, oc && isTeam ? [1, 0.8, 0.25] : color, glow);
  }
  return n;
}

/** Floating health pack: a plate with a glowing cross. */
export function writePack(out, n, x, y, z, time, index) {
  const r = rotZ(time * 1.1 + index);
  const lift = z + 0.55 + Math.sin(time * 2 + index) * 0.07;
  const bars = [
    { h: [0.22, 0.22, 0.09], c: [0.9, 0.9, 0.86], g: 0 },
    { h: [0.17, 0.05, 0.11], c: [0.25, 1, 0.5], g: 5 },
    { h: [0.05, 0.17, 0.11], c: [0.25, 1, 0.5], g: 5 },
  ];
  for (const b of bars) {
    compose(tmp, r, [x, y, lift], b.h);
    writeInstance(out, n++, tmp, b.c, b.g);
  }
  return n;
}

/** The overcharge core: two counter-rotating gold plates around a white heart. */
export function writeOvercharge(out, n, x, y, z, time) {
  const lift = z + 1 + Math.sin(time * 1.7) * 0.12;
  const gold = [1, 0.72, 0.1];
  compose(tmp, mul3(rotZ(time * 1.6), rotY(time * 0.9)), [x, y, lift], [0.36, 0.36, 0.05]);
  writeInstance(out, n++, tmp, gold, 5);
  compose(tmp, mul3(rotZ(-time * 1.2), rotY(-time * 1.4 + 1.2)), [x, y, lift], [0.05, 0.36, 0.36]);
  writeInstance(out, n++, tmp, gold, 5);
  compose(tmp, rotZ(time * 3), [x, y, lift], [0.14, 0.14, 0.14]);
  writeInstance(out, n++, tmp, [1, 0.96, 0.82], 16);
  return n;
}

/** First-person rifle, placed in world space from the camera basis. */
export function writeViewmodel(out, n, cam, basis, bot, team) {
  const color = TEAMS[team].color;
  const kick = bot.shotAge < 0.1 ? (0.1 - bot.shotAge) * 1.1 : 0;
  const bob = Math.sin(bot.gait * 2.5) * Math.min(1, Math.hypot(bot.vx, bot.vy) / 4) * 0.008;
  const reloadDip = bot.reload > 0 ? 0.13 * Math.sin(Math.min(1, bot.reload / 1.8) * Math.PI) : 0;
  const { right: rx, up: ux, forward: fx } = basis;
  const rot = [rx[0], ux[0], -fx[0], rx[1], ux[1], -fx[1], rx[2], ux[2], -fx[2]];
  const parts = [
    { o: [0.17, -0.155, -0.36], h: [0.017, 0.024, 0.17], c: STEEL, g: 0 },
    { o: [0.17, -0.145, -0.58], h: [0.007, 0.007, 0.08], c: DARK, g: 0 },
    { o: [0.17, -0.2, -0.33], h: [0.015, 0.036, 0.026], c: DARK, g: 0 },
    { o: [0.17, -0.126, -0.33], h: [0.005, 0.004, 0.05], c: color, g: 1 },
    { o: [0.26, -0.24, -0.2], h: [0.035, 0.035, 0.13], c: BODY, g: 0 },
  ];
  for (const part of parts) {
    const off = [part.o[0], part.o[1] + bob - reloadDip, part.o[2] + kick];
    const p = [
      cam[0] + rot[0] * off[0] + rot[1] * off[1] + rot[2] * off[2],
      cam[1] + rot[3] * off[0] + rot[4] * off[1] + rot[5] * off[2],
      cam[2] + rot[6] * off[0] + rot[7] * off[1] + rot[8] * off[2],
    ];
    compose(tmp, rot, p, part.h);
    writeInstance(out, n++, tmp, part.c, part.g);
  }
  return n;
}

export const MAX_INSTANCES = PARTS.length * 8 + 40;
