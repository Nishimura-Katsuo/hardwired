// Bakes the heightfield and the surrounding stadium into one static vertex
// buffer. Materials are picked per quad and shaded procedurally in the shader.
import { STANDS } from '../director/framing.js';
import { MAP_H, MAP_W, WALL_HEIGHT } from '../sim/arena.js';

export const MAT = {
  ground: 0, step: 1, outerWall: 2, spine: 3, pillar: 4, crate: 5, deck: 6, gantry: 7, bowl: 8,
  seats: 9, concrete: 10, lamp: 11, apron: 12,
};
export const VERTEX_FLOATS = 8;

function classify(arena, x, y, h) {
  const at = (cx, cy) => arena.heightAt(cx + 0.5, cy + 0.5);
  if (h >= WALL_HEIGHT) return MAT.outerWall;
  if (h >= 4) return MAT.spine;
  if (h >= 2.5) return MAT.pillar;
  if (h === 2) return MAT.gantry;
  if (h === 1.5) return x < 10 || x > 53 ? MAT.deck : MAT.step;
  if (h === 1) {
    const near = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)];
    return near.some((n) => n === 0.5 || n === 1.5) ? MAT.step : MAT.crate;
  }
  if (h === 0.5) return MAT.step;
  return h < 0 ? MAT.bowl : MAT.ground;
}

export function buildStaticMesh(arena) {
  const v = [];
  const quad = (a, b, c, d, n, mat, ao) => {
    const push = (p, shade) => v.push(p[0], p[1], p[2], n[0], n[1], n[2], mat, shade);
    push(a, ao[0]); push(b, ao[1]); push(c, ao[2]);
    push(a, ao[0]); push(c, ao[2]); push(d, ao[3]);
  };

  const h = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? -1 : arena.heights[y * MAP_W + x]);

  /** Corner darkening from taller cells touching the corner. */
  const cornerAo = (x, y, top) => {
    let occluders = 0;
    for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
      const delta = h(cx, cy) - top;
      if (delta > 0.2) occluders += Math.min(1, delta / 1.5);
    }
    return 1 - 0.3 * Math.min(2, occluders);
  };

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const top = h(x, y);
      const mat = classify(arena, x, y, top);
      quad(
        [x, y, top], [x + 1, y, top], [x + 1, y + 1, top], [x, y + 1, top], [0, 0, 1], mat,
        [cornerAo(x, y, top), cornerAo(x + 1, y, top), cornerAo(x + 1, y + 1, top), cornerAo(x, y + 1, top)],
      );
      const sides = [
        [x + 1, y, [1, 0, 0], [x + 1, y], [x + 1, y + 1]],
        [x - 1, y, [-1, 0, 0], [x, y + 1], [x, y]],
        [x, y + 1, [0, 1, 0], [x + 1, y + 1], [x, y + 1]],
        [x, y - 1, [0, -1, 0], [x, y], [x + 1, y]],
      ];
      for (const [nx, ny, n, p, q] of sides) {
        const low = nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H ? -2 : h(nx, ny);
        if (low >= top) continue;
        const base = [0.72, 0.72];
        quad([p[0], p[1], low], [q[0], q[1], low], [q[0], q[1], top], [p[0], p[1], top], n, mat, [base[0], base[1], 1, 1]);
      }
    }
  }

  // Tiered stands wrapping the arena.
  const { tiers: TIERS, tread: TREAD, rise: RISE, base: STAND_BASE } = STANDS;
  const box = (x0, y0, x1, y1, z0, z1, mat) => {
    const sh = [1, 1, 1, 1];
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], mat, sh);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], mat, sh);
    quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], mat, sh);
    quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], mat, sh);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], mat, sh);
  };
  for (let t = 0; t < TIERS; t++) {
    const o0 = t * TREAD;
    const o1 = o0 + TREAD;
    const z = STAND_BASE + t * RISE;
    box(-o1, -o1, MAP_W + o1, -o0, -1, z, MAT.seats);
    box(-o1, MAP_H + o0, MAP_W + o1, MAP_H + o1, -1, z, MAT.seats);
    box(-o1, -o0, -o0, MAP_H + o0, -1, z, MAT.seats);
    box(MAP_W + o0, -o0, MAP_W + o1, MAP_H + o0, -1, z, MAT.seats);
  }
  const reach = TIERS * TREAD;
  const rim = STAND_BASE + TIERS * RISE + 1.5;
  box(-reach - 2, -reach - 2, MAP_W + reach + 2, -reach, -1, rim, MAT.concrete);
  box(-reach - 2, MAP_H + reach, MAP_W + reach + 2, MAP_H + reach + 2, -1, rim, MAT.concrete);
  box(-reach - 2, -reach, -reach, MAP_H + reach, -1, rim, MAT.concrete);
  box(MAP_W + reach, -reach, MAP_W + reach + 2, MAP_H + reach, -1, rim, MAT.concrete);

  // Floodlight masts at the corners.
  for (const [px, py] of [[-8, -8], [MAP_W + 8, -8], [-8, MAP_H + 8], [MAP_W + 8, MAP_H + 8]]) {
    box(px - 0.6, py - 0.6, px + 0.6, py + 0.6, 0, 38, MAT.concrete);
    box(px - 3.2, py - 1, px + 3.2, py + 1, 38, 41.5, MAT.concrete);
    const dx = Math.sign(MAP_W / 2 - px);
    const dy = Math.sign(MAP_H / 2 - py);
    box(px - 3 + dx * 0.05, py + dy * 1, px + 3, py + dy * 1.12, 38.3, 41.2, MAT.lamp);
  }

  // Apron stretching to the haze.
  const far = 400;
  quad([-far, -far, -1], [far, -far, -1], [far, far, -1], [-far, far, -1], [0, 0, 1], MAT.apron, [1, 1, 1, 1]);

  const data = new Float32Array(v);
  // The apron and stadium never cast into the arena; only the map itself does.
  const arenaVertexCount = countArenaVertices(arena);
  return { data, count: data.length / VERTEX_FLOATS, arenaVertexCount };
}

function countArenaVertices(arena) {
  let quads = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const top = arena.heights[y * MAP_W + x];
      quads++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const low = nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H ? -2 : arena.heights[ny * MAP_W + nx];
        if (low < top) quads++;
      }
    }
  }
  return quads * 6;
}
