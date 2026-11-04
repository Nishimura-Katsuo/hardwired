// The arena is a roofless heightfield: one height per square-metre cell, with
// 180-degree rotational symmetry so neither team has a map advantage.
import { BOT_RADIUS, STEP_HEIGHT } from './constants.js';

export const MAP_W = 64;
export const MAP_H = 40;
export const WALL_HEIGHT = 9;
const WALKABLE_LIMIT = 8;

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(key, value) {
    const a = this.items;
    a.push([key, value]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function paint(h) {
  const set = (x, y, v) => {
    h[y * MAP_W + x] = v;
    h[(MAP_H - 1 - y) * MAP_W + (MAP_W - 1 - x)] = v;
  };
  const rect = (x0, y0, x1, y1, v) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, v);
  };

  // Outer wall.
  rect(0, 0, MAP_W - 1, 1, WALL_HEIGHT);
  rect(0, 0, 1, MAP_H - 1, WALL_HEIGHT);

  // Central sunken bowl, two steps deep, with a raised pedestal for the overcharge.
  rect(22, 12, 41, 27, -0.5);
  rect(24, 14, 39, 25, -1.0);
  rect(30, 18, 33, 21, -0.5);
  rect(31, 19, 32, 20, 0);

  // Base deck with stair flights east, north, and south.
  rect(2, 11, 8, 28, 1.5);
  rect(9, 16, 9, 23, 1.0);
  rect(10, 16, 10, 23, 0.5);
  rect(3, 10, 6, 10, 1.0);
  rect(3, 9, 6, 9, 0.5);
  rect(3, 29, 6, 29, 1.0);
  rect(3, 30, 6, 30, 0.5);

  // Long spine walls that split the side lanes from the midfield.
  rect(14, 10, 18, 11, 4);
  rect(21, 10, 24, 11, 4);
  rect(14, 28, 18, 29, 4);
  rect(21, 28, 24, 29, 4);

  // Lane gantry: a raised run over the north lane, with stairs at both ends.
  rect(26, 2, 37, 7, 2.0);
  rect(25, 2, 25, 7, 1.5);
  rect(24, 2, 24, 7, 1.0);
  rect(23, 2, 23, 7, 0.5);
  rect(38, 2, 38, 7, 1.5);
  rect(39, 2, 39, 7, 1.0);
  rect(40, 2, 40, 7, 0.5);
  rect(28, 7, 29, 7, 3.0);
  rect(34, 7, 35, 7, 3.0);

  // Bowl pillars.
  rect(27, 16, 28, 17, 2.5);
  rect(27, 22, 28, 23, 2.5);

  // Field cover: pillars block sight, crates give half cover and can be vaulted.
  rect(12, 14, 13, 15, 1.0);
  rect(12, 24, 13, 25, 2.5);
  rect(17, 18, 18, 21, 2.5);
  rect(20, 14, 21, 14, 1.0);
  rect(20, 25, 21, 25, 1.0);
  rect(16, 5, 17, 6, 1.0);
  rect(12, 33, 13, 35, 2.5);
  rect(18, 33, 19, 34, 1.0);
  rect(8, 4, 9, 7, 2.5);
}

export class Arena {
  constructor() {
    this.heights = new Float32Array(MAP_W * MAP_H);
    paint(this.heights);

    const mirror = (p) => ({ x: MAP_W - p.x, y: MAP_H - p.y });
    const spawnsA = [
      { x: 4.5, y: 13.5 }, { x: 4.5, y: 19.5 }, { x: 4.5, y: 25.5 },
      { x: 7.5, y: 16.5 }, { x: 7.5, y: 22.5 }, { x: 6.5, y: 12.5 },
      { x: 6.5, y: 27.5 }, { x: 3.5, y: 20.5 },
    ];
    this.spawns = [spawnsA, spawnsA.map(mirror)];

    const packsA = [
      { x: 31.5, y: 4.5 }, { x: 19.5, y: 19.5 }, { x: 5.5, y: 4.5 },
    ];
    this.healthPacks = [...packsA, ...packsA.map(mirror)];
    this.overcharge = { x: 32, y: 20 };

    // Landmarks are expressed per team so "enemy base" stays meaningful.
    this.landmarks = [
      { north: { x: 32, y: 4.5 }, mid: { x: 32, y: 20 }, south: { x: 32, y: 35.5 }, enemyBase: { x: 58.5, y: 20 } },
      { north: { x: 32, y: 35.5 }, mid: { x: 32, y: 20 }, south: { x: 32, y: 4.5 }, enemyBase: { x: 5.5, y: 20 } },
    ];

    this.fieldCache = new Map();
    this.coverPoints = this.findCoverPoints();
  }

  cell(x, y) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return -1;
    return cy * MAP_W + cx;
  }

  heightAt(x, y) {
    const c = this.cell(x, y);
    return c < 0 ? WALL_HEIGHT : this.heights[c];
  }

  /** Highest surface under a circle whose top is reachable from feet height z. */
  groundUnder(x, y, z, r = BOT_RADIUS) {
    let best = -Infinity;
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const h = cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H ? WALL_HEIGHT : this.heights[cy * MAP_W + cx];
        if (h > z + STEP_HEIGHT) continue;
        const nx = Math.max(cx, Math.min(x, cx + 1));
        const ny = Math.max(cy, Math.min(y, cy + 1));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < r * r && h > best) best = h;
      }
    }
    return best;
  }

  /** True when the circle overlaps a cell too tall to step onto from z. */
  blocked(x, y, z, r = BOT_RADIUS) {
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const h = cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H ? WALL_HEIGHT : this.heights[cy * MAP_W + cx];
        if (h <= z + STEP_HEIGHT) continue;
        const nx = Math.max(cx, Math.min(x, cx + 1));
        const ny = Math.max(cy, Math.min(y, cy + 1));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  /**
   * Amanatides-Woo traversal against the heightfield.
   * (dx, dy, dz) must be unit length. Returns the hit distance, or maxDist.
   * Above the outer wall the ray leaves the map and travels freely.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let cx = Math.floor(ox);
    let cy = Math.floor(oy);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? cx + 1 - ox : ox - cx) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? cy + 1 - oy : oy - cy) * tDeltaY : Infinity;
    let t = 0;
    while (t < maxDist) {
      if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return maxDist;
      const h = this.heights[cy * MAP_W + cx];
      const tNext = Math.min(tMaxX, tMaxY, maxDist);
      const zIn = oz + dz * t;
      const zOut = oz + dz * tNext;
      if (zIn < h) return t;
      if (zOut < h) return t + ((zIn - h) / (zIn - zOut)) * (tNext - t);
      t = tNext;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
    return maxDist;
  }

  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 1e-3;
  }

  canStep(from, to) {
    return this.heights[to] < WALKABLE_LIMIT && this.heights[to] - this.heights[from] <= STEP_HEIGHT;
  }

  /** Can you walk from cell `a` to its neighbour offset (dx, dy)? */
  edge(a, dx, dy) {
    const ax = a % MAP_W;
    const ay = (a - ax) / MAP_W;
    const bx = ax + dx;
    const by = ay + dy;
    if (bx < 0 || by < 0 || bx >= MAP_W || by >= MAP_H) return false;
    const b = by * MAP_W + bx;
    if (!this.canStep(a, b)) return false;
    if (dx !== 0 && dy !== 0) {
      if (!this.canStep(a, ay * MAP_W + bx) || !this.canStep(a, by * MAP_W + ax)) return false;
    }
    return true;
  }

  /** Walking distance to `goal` from every cell, by reverse Dijkstra. Cached. */
  field(goal) {
    const cached = this.fieldCache.get(goal);
    if (cached) return cached;
    const dist = new Float32Array(MAP_W * MAP_H).fill(Infinity);
    dist[goal] = 0;
    const heap = new MinHeap();
    heap.push(0, goal);
    while (heap.size) {
      const [d, c] = heap.pop();
      if (d > dist[c]) continue;
      const cx = c % MAP_W;
      const cy = (c - cx) / MAP_W;
      for (const [nx, ny, w] of NEIGHBOURS) {
        const px = cx - nx;
        const py = cy - ny;
        if (px < 0 || py < 0 || px >= MAP_W || py >= MAP_H) continue;
        const p = py * MAP_W + px;
        if (this.heights[p] >= WALKABLE_LIMIT) continue;
        if (!this.edge(p, nx, ny)) continue;
        const nd = d + w;
        if (nd < dist[p]) {
          dist[p] = nd;
          heap.push(dist[p], p);
        }
      }
    }
    this.fieldCache.set(goal, dist);
    return dist;
  }

  /** True if a bot at feet height z can walk straight from a to b. */
  walkLine(ax, ay, bx, by, z) {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(d / 0.35));
    let footZ = z;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      if (this.blocked(x, y, footZ, BOT_RADIUS + 0.02)) return false;
      const g = this.groundUnder(x, y, footZ, BOT_RADIUS + 0.02);
      if (g > -Infinity) footZ = g;
    }
    return true;
  }

  /**
   * Next waypoint on the shortest walking route to (gx, gy).
   * Writes { x, y, dist } into `out`; returns false if the goal is unreachable.
   */
  steer(x, y, z, gx, gy, out) {
    const goal = this.cell(gx, gy);
    if (goal < 0) return false;
    const field = this.field(goal);
    let c = this.cell(x, y);
    if (c < 0) return false;
    if (field[c] === Infinity) {
      let best = -1;
      let bestD = Infinity;
      const cx = c % MAP_W;
      const cy = (c - cx) / MAP_W;
      for (const [nx, ny] of NEIGHBOURS) {
        const qx = cx + nx;
        const qy = cy + ny;
        if (qx < 0 || qy < 0 || qx >= MAP_W || qy >= MAP_H) continue;
        const q = qy * MAP_W + qx;
        if (field[q] < bestD) {
          bestD = field[q];
          best = q;
        }
      }
      if (best < 0) return false;
      c = best;
    }

    out.dist = field[c];
    let wx = gx;
    let wy = gy;
    if (c !== goal) {
      let cur = c;
      wx = (c % MAP_W) + 0.5;
      wy = Math.floor(c / MAP_W) + 0.5;
      for (let i = 0; i < 6 && cur !== goal; i++) {
        let next = -1;
        let nextD = field[cur];
        for (const [nx, ny] of NEIGHBOURS) {
          if (!this.edge(cur, nx, ny)) continue;
          const q = cur + ny * MAP_W + nx;
          if (field[q] < nextD) {
            nextD = field[q];
            next = q;
          }
        }
        if (next < 0) break;
        cur = next;
        const px = cur === goal ? gx : (cur % MAP_W) + 0.5;
        const py = cur === goal ? gy : Math.floor(cur / MAP_W) + 0.5;
        if (!this.walkLine(x, y, px, py, z)) break;
        wx = px;
        wy = py;
      }
    }
    out.x = wx;
    out.y = wy;
    return true;
  }

  findCoverPoints() {
    const anchor = this.cell(4.5, 19.5);
    const field = this.field(anchor);
    const points = [];
    for (let c = 0; c < field.length; c++) {
      if (field[c] === Infinity || this.heights[c] >= WALKABLE_LIMIT) continue;
      const cx = c % MAP_W;
      const cy = (c - cx) / MAP_W;
      let sheltered = false;
      for (const [nx, ny] of NEIGHBOURS) {
        const q = (cy + ny) * MAP_W + cx + nx;
        if (this.heights[q] >= this.heights[c] + 1.8) sheltered = true;
      }
      if (sheltered) points.push({ x: cx + 0.5, y: cy + 0.5, z: this.heights[c] });
    }
    return points;
  }
}
