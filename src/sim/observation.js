// The observation layout is the contract between the game and the network.
// Each field is built by block so indices stay readable on both sides.
export const SELF_FIELDS = [
  'health', 'ammo', 'reloading', 'overcharge', 'grounded',
  'velForward', 'velStrafe', 'pitch', 'sinYaw', 'cosYaw',
  'posX', 'posY', 'posZ', 'spawnProtect', 'spread',
  'onTarget', 'timeLeft', 'scoreDiff', 'overchargeWait', 'stuck',
  'aggression', 'caution', 'discipline', 'aliveRatio', 'bias',
];
export const RAY_ANGLES_DEG = [0, 5, -5, 15, -15, 30, -30, 50, -50, 75, -75, 105, -105, 140, 180];
export const GOAL_NAMES = ['health', 'overcharge', 'contact', 'ally', 'north', 'mid', 'south', 'enemyBase', 'cover'];
export const GOAL_FIELDS = ['active', 'sin', 'cos', 'dist'];
export const ENEMY_SLOTS = 3;
export const ENEMY_FIELDS = [
  'present', 'bearing', 'sin', 'cos', 'pitch', 'dist', 'near', 'angVel', 'health', 'facing', 'overcharge',
];
export const ALLY_SLOTS = 2;
export const ALLY_FIELDS = ['present', 'sin', 'cos', 'near', 'health', 'engaged'];

function block(start, names) {
  const map = {};
  names.forEach((n, i) => (map[n] = start + i));
  return map;
}

let cursor = 0;
function reserve(n) {
  const at = cursor;
  cursor += n;
  return at;
}

export const SELF = block(reserve(SELF_FIELDS.length), SELF_FIELDS);
export const RAY_DIST = reserve(RAY_ANGLES_DEG.length);
export const RAY_FLOOR = reserve(RAY_ANGLES_DEG.length);
export const GOALS = reserve(GOAL_NAMES.length * GOAL_FIELDS.length);
export const ENEMIES = reserve(ENEMY_SLOTS * ENEMY_FIELDS.length);
export const ALLIES = reserve(ALLY_SLOTS * ALLY_FIELDS.length);
export const HURT = block(reserve(3), ['level', 'sin', 'cos']);
export const SOUND = block(reserve(3), ['level', 'sin', 'cos']);
export const OBS_SIZE = cursor;

export const goalIndex = (name, field) =>
  GOALS + GOAL_NAMES.indexOf(name) * GOAL_FIELDS.length + GOAL_FIELDS.indexOf(field);
export const enemyIndex = (slot, field) => ENEMIES + slot * ENEMY_FIELDS.length + ENEMY_FIELDS.indexOf(field);
export const allyIndex = (slot, field) => ALLIES + slot * ALLY_FIELDS.length + ALLY_FIELDS.indexOf(field);

export const ACTION = { forward: 0, strafe: 1, yaw: 2, pitch: 3, fire: 4, jump: 5, reload: 6 };
export const ACTION_SIZE = 7;
