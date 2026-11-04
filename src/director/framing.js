// Measures what a camera can actually see. The director uses these checks to
// reject bad positions, and the tests use them to judge whole broadcasts.
import { MAP_H, MAP_W, WALL_HEIGHT } from '../sim/arena.js';

export const STANDS = { tiers: 11, tread: 1.5, rise: 1.35, base: WALL_HEIGHT + 0.3 };

const NEAR_WALL = 3.5;
const GRID_X = [-0.85, -0.42, 0, 0.42, 0.85];
const GRID_Y = [-0.7, 0, 0.7];
const RAYS = GRID_X.length * GRID_Y.length;

/** Height of whatever is solid at (x, y), including the stands outside the map. */
export function solidHeight(arena, x, y) {
  if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) return arena.heightAt(x, y);
  const outward = Math.max(-x, x - MAP_W, -y, y - MAP_H);
  const tier = Math.min(Math.floor(outward / STANDS.tread), STANDS.tiers - 1);
  return STANDS.base + tier * STANDS.rise;
}

/** True when a sphere of `radius` at the camera position touches nothing. */
export function isClear(arena, x, y, z, radius) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (solidHeight(arena, x + dx * radius, y + dy * radius) > z - radius * 0.5) return false;
    }
  }
  return true;
}

function unit(a, b) {
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const z = b[2] - a[2];
  const d = Math.hypot(x, y, z) || 1;
  return [x / d, y / d, z / d];
}

/**
 * Fraction of the frame filled by a wall closer than NEAR_WALL.
 * Floors do not count: looking down at the ground is a normal shot.
 */
export function viewBlockage(arena, pos, look, fovDeg, aspect = 16 / 9) {
  if (solidHeight(arena, pos[0], pos[1]) > pos[2]) return 1;
  const f = unit(pos, look);
  const side = Math.hypot(f[1], f[0]) || 1;
  const r = [f[1] / side, -f[0] / side, 0];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tanY = Math.tan((fovDeg * Math.PI) / 360);
  const tanX = tanY * aspect;
  let blocked = 0;
  for (const gy of GRID_Y) {
    for (const gx of GRID_X) {
      const x = f[0] + r[0] * gx * tanX + u[0] * gy * tanY;
      const y = f[1] + r[1] * gx * tanX + u[1] * gy * tanY;
      const z = f[2] + r[2] * gx * tanX + u[2] * gy * tanY;
      const d = Math.hypot(x, y, z);
      const t = arena.raycast(pos[0], pos[1], pos[2], x / d, y / d, z / d, NEAR_WALL);
      if (t >= NEAR_WALL) continue;
      const hitX = pos[0] + (x / d) * (t + 0.02);
      const hitY = pos[1] + (y / d) * (t + 0.02);
      const hitZ = pos[2] + (z / d) * t;
      if (hitZ < arena.heightAt(hitX, hitY) - 0.04) blocked++;
    }
  }
  return blocked / RAYS;
}

/** True when the camera has an unobstructed line to `point`. */
export function canSeePoint(arena, pos, point) {
  if (solidHeight(arena, pos[0], pos[1]) > pos[2]) return false;
  return arena.lineOfSight(pos[0], pos[1], pos[2], point[0], point[1], point[2]);
}
