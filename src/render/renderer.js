// WebGL2 forward renderer: shadow map, HDR scene, dual-filter bloom, filmic composite.
import { MAP_H, MAP_W } from '../sim/arena.js';
import { buildStaticMesh, VERTEX_FLOATS } from './arena-mesh.js';
import { INSTANCE_FLOATS, MAX_INSTANCES, writeBot, writeOvercharge, writePack, writeViewmodel } from './bot-rig.js';
import { MAX_QUADS } from './fx.js';
import { lookAt, multiply, norm, ortho, perspective } from './mat.js';
import * as S from './shaders.js';

const SHADOW_SIZE = 2048;
const BLOOM_LEVELS = 4;
const MAX_DPR = 1.5;
const SUN_DIR = norm([-0.62, -0.5, 0.42]);

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program failed to link: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

function colorTarget(gl, w, h, internal, format, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

function makeBoard() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 128;
  const g = c.getContext('2d');
  const paint = [
    ['#12306b', '#ffd23f', 'HARDWIRED LEAGUE'],
    ['#ff6a24', '#fff6e8', 'KILN'],
    ['#ffd23f', '#12306b', 'NO TRAINING ALLOWED'],
    ['#22d3d9', '#06262e', 'TIDE'],
  ];
  const width = c.width / paint.length;
  paint.forEach(([bg, fg, text], i) => {
    g.fillStyle = bg;
    g.fillRect(i * width, 0, width, c.height);
    g.fillStyle = fg;
    g.font = '700 84px Bahnschrift, "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, (i + 0.5) * width, c.height / 2 + 4, width - 40);
  });
  return c;
}

export class Renderer {
  constructor(canvas, arena) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This broadcast needs WebGL2. Turn on hardware acceleration in your browser settings.');
    this.gl = gl;
    this.canvas = canvas;
    this.arena = arena;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');

    this.programs = {
      sky: program(gl, S.SKY_VS, S.SKY_FS),
      arena: program(gl, S.ARENA_VS, S.ARENA_FS),
      inst: program(gl, S.INST_VS, S.INST_FS),
      shadow: program(gl, S.SHADOW_VS, S.EMPTY_FS),
      shadowInst: program(gl, S.SHADOW_INST_VS, S.EMPTY_FS),
      fx: program(gl, S.FX_VS, S.FX_FS),
      down: program(gl, S.POST_VS, S.BLOOM_DOWN_FS),
      up: program(gl, S.POST_VS, S.BLOOM_UP_FS),
      composite: program(gl, S.POST_VS, S.COMPOSITE_FS),
    };

    this.emptyVao = gl.createVertexArray();
    this.buildStatic();
    this.buildInstances();
    this.buildFx();
    this.buildShadow();
    this.buildBoard();
    this.lightPos = new Float32Array(S.LIGHT_COUNT * 4);
    this.lightCol = new Float32Array(S.LIGHT_COUNT * 4);
    this.instances = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
    this.width = 0;
    this.height = 0;
    this.time = 0;

    const lightView = lookAt(
      [MAP_W / 2 + SUN_DIR[0] * 90, MAP_H / 2 + SUN_DIR[1] * 90, SUN_DIR[2] * 90],
      [MAP_W / 2, MAP_H / 2, 0],
    ).view;
    this.shadowVP = multiply(ortho(-48, 48, -40, 40, 1, 200), lightView);
  }

  buildStatic() {
    const gl = this.gl;
    const mesh = buildStaticMesh(this.arena);
    this.mesh = mesh;
    this.staticVao = gl.createVertexArray();
    gl.bindVertexArray(this.staticVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const stride = VERTEX_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  }

  buildInstances() {
    const gl = this.gl;
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    const v = [];
    for (const [n, u, w] of faces) {
      const c = (a, b) => [n[0] + u[0] * a + w[0] * b, n[1] + u[1] * a + w[1] * b, n[2] + u[2] * a + w[2] * b];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) v.push(...c(a, b), ...n);
    }
    this.boxVao = gl.createVertexArray();
    gl.bindVertexArray(this.boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 4; i++) {
      const loc = 3 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
  }

  buildFx() {
    const gl = this.gl;
    this.fxVao = gl.createVertexArray();
    gl.bindVertexArray(this.fxVao);
    this.fxBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_QUADS * 6 * 9 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 36, 20);
  }

  buildShadow() {
    const gl = this.gl;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
  }

  buildBoard() {
    const gl = this.gl;
    this.boardTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.boardTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeBoard());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const internal = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.resolve = colorTarget(gl, w, h, internal, gl.RGBA, type);

    this.msaaFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    const color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internal, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);

    this.bloom = [];
    let bw = w >> 1;
    let bh = h >> 1;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloom.push(colorTarget(gl, Math.max(2, bw), Math.max(2, bh), internal, gl.RGBA, type));
      bw >>= 1;
      bh >>= 1;
    }
  }

  bindCommon(prog, basis) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    const u = prog.u;
    if (u.u_vp) gl.uniformMatrix4fv(u.u_vp, false, basis.vp);
    if (u.u_cam) gl.uniform3fv(u.u_cam, basis.eye);
    if (u.u_sunDir) gl.uniform3fv(u.u_sunDir, SUN_DIR);
    if (u.u_time) gl.uniform1f(u.u_time, this.time);
    if (u.u_shadowVP) gl.uniformMatrix4fv(u.u_shadowVP, false, this.shadowVP);
    if (u.u_shadow) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
      gl.uniform1i(u.u_shadow, 0);
    }
    if (u.u_lightPos) gl.uniform4fv(u.u_lightPos, this.lightPos);
    if (u.u_lightCol) gl.uniform4fv(u.u_lightCol, this.lightCol);
  }

  drawInstances(count) {
    const gl = this.gl;
    gl.bindVertexArray(this.boxVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
  }

  render(view, cam, fx, state) {
    const gl = this.gl;
    this.resize();
    this.time = state.time;
    const eye = [...cam.pos];
    if (fx.shake > 0 && !cam.viewmodel) {
      eye[0] += Math.sin(state.time * 71) * fx.shake * 0.05;
      eye[1] += Math.sin(state.time * 83) * fx.shake * 0.05;
      eye[2] += Math.sin(state.time * 97) * fx.shake * 0.05;
    }
    const aspect = this.width / this.height;
    const { view: viewM, right, up, forward } = lookAt(eye, cam.look, cam.roll);
    const proj = perspective(cam.fov, aspect, 0.06, 900);
    const basis = { vp: multiply(proj, viewM), eye: new Float32Array(eye) };
    const frame = { right, up, forward };

    // Gather instances for this frame.
    let n = 0;
    const out = this.instances;
    for (const bot of view.bots) {
      if (bot.id === cam.hideBot) continue;
      if (!bot.alive && bot.deathT > 3) continue;
      n = writeBot(out, n, bot, state.time, this.arena);
    }
    const shadowCount = n;
    this.arena.healthPacks.forEach((spot, i) => {
      if (view.packMask & (1 << i)) {
        n = writePack(out, n, spot.x, spot.y, this.arena.heightAt(spot.x, spot.y), state.time, i);
      }
    });
    const spot = this.arena.overcharge;
    const spotZ = this.arena.heightAt(spot.x, spot.y);
    if (view.overchargeActive) n = writeOvercharge(out, n, spot.x, spot.y, spotZ, state.time);
    const worldCount = n;
    if (cam.viewmodel) n = writeViewmodel(out, n, eye, frame, view.bots[cam.hideBot], view.bots[cam.hideBot].team);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out.subarray(0, n * INSTANCE_FLOATS));

    // Shadow pass: only the arena and its players cast.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const shadowBasis = { vp: this.shadowVP, eye: basis.eye };
    this.bindCommon(this.programs.shadow, shadowBasis);
    gl.bindVertexArray(this.staticVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.mesh.arenaVertexCount);
    this.bindCommon(this.programs.shadowInst, shadowBasis);
    this.drawInstances(shadowCount);

    // Scene.
    fx.writeLights(this.lightPos, this.lightCol);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    const sky = this.programs.sky;
    this.bindCommon(sky, basis);
    gl.uniform3fv(sky.u.u_right, right);
    gl.uniform3fv(sky.u.u_up, up);
    gl.uniform3fv(sky.u.u_fwd, forward);
    gl.uniform1f(sky.u.u_tanHalf, Math.tan((cam.fov * Math.PI) / 360));
    gl.uniform1f(sky.u.u_aspect, aspect);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const arena = this.programs.arena;
    this.bindCommon(arena, basis);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boardTex);
    gl.uniform1i(arena.u.u_board, 1);
    gl.uniform1f(arena.u.u_crowd, state.crowd);
    gl.uniform1f(arena.u.u_oc, view.overchargeActive ? 1 : 0);
    gl.bindVertexArray(this.staticVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.mesh.count);

    this.bindCommon(this.programs.inst, basis);
    this.drawInstances(worldCount);
    gl.disable(gl.CULL_FACE);

    // Additive effects.
    const vertexCount = fx.build(eye, frame, view, { x: spot.x, y: spot.y, z: spotZ }, state.time);
    if (vertexCount) {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.bindCommon(this.programs.fx, basis);
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.buffer.subarray(0, vertexCount * 9));
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // Viewmodel on top of the world with cleared depth.
    if (cam.viewmodel) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.CULL_FACE);
      this.bindCommon(this.programs.inst, basis);
      gl.bindVertexArray(this.boxVao);
      this.drawViewmodel(worldCount, n - worldCount);
      gl.disable(gl.CULL_FACE);
    }

    // Resolve and post.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve.fbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.emptyVao);

    const down = this.programs.down;
    gl.useProgram(down.p);
    gl.uniform1i(down.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    let source = this.resolve;
    this.bloom.forEach((target, i) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
      gl.bindTexture(gl.TEXTURE_2D, source.tex);
      gl.uniform2f(down.u.u_texel, 1 / source.w, 1 / source.h);
      gl.uniform1f(down.u.u_threshold, i === 0 ? 1.7 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = target;
    });

    const upward = this.programs.up;
    gl.useProgram(upward.p);
    gl.uniform1i(upward.u.u_tex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const target = this.bloom[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
      gl.bindTexture(gl.TEXTURE_2D, this.bloom[i].tex);
      gl.uniform2f(upward.u.u_texel, 1 / this.bloom[i].w, 1 / this.bloom[i].h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    const composite = this.programs.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(composite.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolve.tex);
    gl.uniform1i(composite.u.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    gl.uniform1i(composite.u.u_bloom, 1);
    gl.uniform1f(composite.u.u_time, state.time);
    gl.uniform1f(composite.u.u_replay, state.replay);
    gl.uniform1f(composite.u.u_hurt, state.hurt);
    gl.uniform1f(composite.u.u_flash, state.flash);
    gl.uniform2f(composite.u.u_res, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
  }

  /** Draws a tail of the instance list by rebinding the attribute offsets. */
  drawViewmodel(first, count) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let i = 0; i < 4; i++) {
      gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, first * INSTANCE_FLOATS * 4 + i * 16);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
    for (let i = 0; i < 4; i++) gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16);
  }
}
