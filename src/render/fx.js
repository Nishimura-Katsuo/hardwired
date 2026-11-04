// Transient effects: tracers, flashes, sparks, and dynamic lights. Effects are
// driven by recorded events, so replays regenerate them exactly on cue.
import { TEAMS } from '../sim/constants.js';
import { cross, norm, sub } from './mat.js';
import { LIGHT_COUNT } from './shaders.js';

const MAX_PARTICLES = 900;
const QUAD_FLOATS = 9;
export const MAX_QUADS = 2200;

export class Fx {
  constructor() {
    this.tracers = [];
    this.flashes = [];
    this.particles = [];
    this.lights = [];
    this.shake = 0;
    this.buffer = new Float32Array(MAX_QUADS * 6 * QUAD_FLOATS);
    this.quadCount = 0;
    this.seed = 1;
  }

  reset() {
    this.tracers.length = 0;
    this.flashes.length = 0;
    this.particles.length = 0;
    this.lights.length = 0;
    this.shake = 0;
  }

  rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  burst(x, y, z, n, color, speed, life, size) {
    for (let i = 0; i < n && this.particles.length < MAX_PARTICLES; i++) {
      const a = this.rand() * Math.PI * 2;
      const v = speed * (0.3 + this.rand());
      this.particles.push({
        x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: this.rand() * v * 1.3,
        life: life * (0.5 + this.rand() * 0.5), age: 0, size, color,
      });
    }
  }

  addLight(x, y, z, color, radius, life) {
    this.lights.push({ x, y, z, color, radius, life, age: 0 });
    if (this.lights.length > LIGHT_COUNT) this.lights.shift();
  }

  consume(e, arena, view) {
    if (e.type === 'shot') {
      const team = TEAMS[e.bot < 4 ? 0 : 1].color;
      const color = e.overcharged ? [2.6, 1.9, 0.5] : [team[0] * 1.7 + 0.5, team[1] * 1.7 + 0.5, team[2] * 1.7 + 0.5];
      this.tracers.push({ a: [e.fx, e.fy, e.fz], b: [e.tx, e.ty, e.tz], color, age: 0, life: 0.11 });
      this.flashes.push({ x: e.fx, y: e.fy, z: e.fz, color: [4, 2.7, 1.2], size: 0.5, age: 0, life: 0.05 });
      this.addLight(e.fx, e.fy, e.fz, [9, 5.5, 2.5], 7, 0.06);
      if (e.wall) {
        const under = e.tz <= arena.heightAt(e.tx, e.ty) + 0.05;
        this.burst(e.tx, e.ty, under ? e.tz + 0.05 : e.tz, 4, [3, 2, 1], 2.5, 0.28, 0.035);
      }
    } else if (e.type === 'hit') {
      const b = view.bots[e.bot];
      const color = e.head ? [5, 4, 1.8] : [3.5, 2.3, 0.9];
      this.burst(b.x, b.y, b.z + (e.head ? 1.6 : 1.1), e.head ? 12 : 7, color, 3.6, 0.35, 0.04);
    } else if (e.type === 'kill') {
      this.burst(e.x, e.y, e.z + 1.1, 46, [5, 2.6, 0.9], 6, 0.75, 0.05);
      this.burst(e.x, e.y, e.z + 1.1, 12, [0.3, 0.3, 0.33], 1.4, 1.5, 0.28);
      this.flashes.push({ x: e.x, y: e.y, z: e.z + 1.1, color: [7, 4.3, 2], size: 2.6, age: 0, life: 0.16 });
      this.addLight(e.x, e.y, e.z + 1.3, [34, 18, 7], 13, 0.3);
      this.shake = Math.max(this.shake, 0.5);
    } else if (e.type === 'spawn') {
      const team = TEAMS[e.bot < 4 ? 0 : 1].color;
      this.burst(e.x, e.y, e.z + 0.2, 26, team.map((c) => c * 4), 2.4, 0.6, 0.05);
      this.flashes.push({ x: e.x, y: e.y, z: e.z + 1, color: team.map((c) => c * 4), size: 1.7, age: 0, life: 0.25 });
    } else if (e.type === 'overchargeTaken') {
      this.addLight(32, 20, 1.5, [30, 24, 8], 20, 0.5);
    }
  }

  update(dt) {
    const age = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].age += dt;
        if (list[i].age >= list[i].life) list.splice(i, 1);
      }
    };
    age(this.tracers);
    age(this.flashes);
    age(this.lights);
    age(this.particles);
    for (const p of this.particles) {
      p.vz -= 9 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  writeLights(pos, col) {
    pos.fill(0);
    col.fill(0);
    this.lights.forEach((l, i) => {
      const k = 1 - l.age / l.life;
      pos.set([l.x, l.y, l.z, l.radius], i * 4);
      col.set([l.color[0] * k, l.color[1] * k, l.color[2] * k, 0], i * 4);
    });
  }

  quad(p, q, r, s, color, alpha) {
    if (this.quadCount >= MAX_QUADS) return;
    const b = this.buffer;
    let o = this.quadCount * 6 * QUAD_FLOATS;
    const put = (v, u, w) => {
      b[o++] = v[0]; b[o++] = v[1]; b[o++] = v[2]; b[o++] = u; b[o++] = w;
      b[o++] = color[0]; b[o++] = color[1]; b[o++] = color[2]; b[o++] = alpha;
    };
    put(p, -1, -1); put(q, 1, -1); put(r, 1, 1);
    put(p, -1, -1); put(r, 1, 1); put(s, -1, 1);
    this.quadCount++;
  }

  billboard(x, y, z, size, color, alpha, right, up) {
    const rx = right[0] * size; const ry = right[1] * size; const rz = right[2] * size;
    const ux = up[0] * size; const uy = up[1] * size; const uz = up[2] * size;
    this.quad(
      [x - rx - ux, y - ry - uy, z - rz - uz], [x + rx - ux, y + ry - uy, z + rz - uz],
      [x + rx + ux, y + ry + uy, z + rz + uz], [x - rx + ux, y - ry + uy, z - rz + uz],
      color, alpha,
    );
  }

  /** A camera-facing ribbon. Negative alpha selects the shader's ribbon falloff. */
  ribbon(a, b, width, color, alpha, eye) {
    const dir = norm(sub(b, a));
    const side = norm(cross(dir, sub(eye, a)));
    const w = [side[0] * width, side[1] * width, side[2] * width];
    this.quad(
      [a[0] - w[0], a[1] - w[1], a[2] - w[2]], [b[0] - w[0], b[1] - w[1], b[2] - w[2]],
      [b[0] + w[0], b[1] + w[1], b[2] + w[2]], [a[0] + w[0], a[1] + w[1], a[2] + w[2]],
      color, -alpha,
    );
  }

  /** Fills the vertex buffer for this frame; returns the vertex count. */
  build(camPos, basis, view, overchargeSpot, time) {
    this.quadCount = 0;
    const { right, up } = basis;
    for (const t of this.tracers) {
      const k = 1 - t.age / t.life;
      const dx = t.b[0] - t.a[0];
      const dy = t.b[1] - t.a[1];
      const dz = t.b[2] - t.a[2];
      const head = Math.min(1, t.age / t.life + 0.35);
      const tail = Math.max(0, t.age / t.life - 0.1);
      const a = [t.a[0] + dx * tail, t.a[1] + dy * tail, t.a[2] + dz * tail];
      const b = [t.a[0] + dx * head, t.a[1] + dy * head, t.a[2] + dz * head];
      this.ribbon(a, b, 0.026, t.color, k * 1.2, camPos);
    }
    for (const f of this.flashes) {
      const k = 1 - f.age / f.life;
      this.billboard(f.x, f.y, f.z, f.size * (0.6 + k * 0.6), f.color, k, right, up);
    }
    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      this.billboard(p.x, p.y, p.z, p.size, p.color, k, right, up);
    }
    if (view.overchargeActive && overchargeSpot) {
      const { x, y, z } = overchargeSpot;
      const pulse = 0.7 + 0.3 * Math.sin(time * 3);
      this.ribbon([x, y, z], [x, y, z + 42], 1.1, [1.7, 1.1, 0.25], 0.38 * pulse, camPos);
      this.billboard(x, y, z + 1, 1.7, [2.6, 1.8, 0.6], 0.8 * pulse, right, up);
    }
    for (const b of view.bots) {
      if (b.alive && b.overcharge > 0) {
        this.billboard(b.x, b.y, b.z + 1.1, 1.7, [2.2, 1.45, 0.3], 0.4 + Math.sin(time * 9) * 0.1, right, up);
      }
    }
    return this.quadCount * 6;
  }
}
