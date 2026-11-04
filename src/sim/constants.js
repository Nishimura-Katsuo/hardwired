// Every gameplay number lives here so the sim, sensors, and brain agree.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** Brains run at 20 Hz. Each bot is staggered onto its own tick slot. */
export const BRAIN_INTERVAL = 3;

export const TEAM_COUNT = 2;
export const BOTS_PER_TEAM = 4;
export const BOT_COUNT = TEAM_COUNT * BOTS_PER_TEAM;

export const FRAG_LIMIT = 40;
export const TIME_LIMIT = 240;
export const WARMUP_TIME = 3;
export const END_TIME = 14;

export const BOT_RADIUS = 0.4;
export const BOT_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.55;
export const MAX_HEALTH = 100;
export const RESPAWN_TIME = 3;
export const SPAWN_PROTECT = 1.2;

export const RUN_SPEED = 5.6;
export const BACK_SPEED = 4.2;
export const GROUND_ACCEL = 40;
export const AIR_ACCEL = 8;
export const GRAVITY = 18;
export const JUMP_SPEED = 6.6;
export const STEP_HEIGHT = 0.55;

export const MAX_YAW_RATE = 6.0;
export const MAX_PITCH_RATE = 3.0;
export const TURN_TAU = 0.06;
export const PITCH_LIMIT = 1.2;

export const MAG_SIZE = 24;
export const FIRE_INTERVAL = 1 / 9;
export const RELOAD_TIME = 1.8;
export const DAMAGE_BODY = 10;
export const DAMAGE_HEAD = 15;
export const WEAPON_RANGE = 60;
export const SPREAD_BASE = 0.012;
export const SPREAD_MOVE = 0.02;
export const SPREAD_AIR = 0.03;
export const SPREAD_BLOOM = 0.007;
export const SPREAD_DECAY = 0.05;
export const SPREAD_MAX = 0.065;

export const HEALTH_PACK = 40;
export const HEALTH_RESPAWN = 15;
export const OVERCHARGE_FIRST = 20;
export const OVERCHARGE_RESPAWN = 40;
export const OVERCHARGE_DURATION = 15;
export const OVERCHARGE_MULT = 1.5;
export const PICKUP_RADIUS = 1.0;

export const VIEW_HALF_FOV = (60 * Math.PI) / 180;
export const VIEW_RANGE = 50;
export const PROXIMITY_RANGE = 3;
export const REACTION_TIME = 0.15;
export const AIM_NOISE = 0.006;
export const CONTACT_MEMORY = 8;
export const HEARING_RANGE = 18;
export const ASSIST_WINDOW = 5;

export const TEAMS = [
  { id: 0, name: 'KILN', tag: 'KLN', color: [1.0, 0.36, 0.1], css: '#ff6a24' },
  { id: 1, name: 'TIDE', tag: 'TDE', color: [0.1, 0.78, 0.82], css: '#22d3d9' },
];

/**
 * Temperament is constant per player and is fed to the network as input.
 * aggression, caution, discipline are all in [0, 1].
 */
export const ROSTER = [
  { name: 'ANVIL', aggression: 0.8, caution: 0.3, discipline: 0.5 },
  { name: 'EMBER', aggression: 0.95, caution: 0.1, discipline: 0.3 },
  { name: 'SLAG', aggression: 0.4, caution: 0.7, discipline: 0.8 },
  { name: 'FLUX', aggression: 0.6, caution: 0.5, discipline: 0.95 },
  { name: 'BRINE', aggression: 0.8, caution: 0.3, discipline: 0.5 },
  { name: 'EDDY', aggression: 0.95, caution: 0.1, discipline: 0.3 },
  { name: 'KELP', aggression: 0.4, caution: 0.7, discipline: 0.8 },
  { name: 'RIP', aggression: 0.6, caution: 0.5, discipline: 0.95 },
];
