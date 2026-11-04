// All GLSL lives here. The look: a concrete stadium at golden hour, low warm sun,
// long blue shadows, enamel-bright team paint, and a filmic tonemap.
const HEADER = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
`;

export const LIGHT_COUNT = 6;

const COMMON = `
uniform vec3 u_cam;
uniform vec3 u_sunDir;
uniform float u_time;
uniform mat4 u_shadowVP;
uniform sampler2DShadow u_shadow;
uniform vec4 u_lightPos[${LIGHT_COUNT}];
uniform vec4 u_lightCol[${LIGHT_COUNT}];

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

vec3 skyColor(vec3 d) {
  float sun = max(dot(d, u_sunDir), 0.0);
  float up = clamp(d.z, -0.1, 1.0);
  vec3 zenith = vec3(0.10, 0.24, 0.55);
  vec3 mid = vec3(0.42, 0.56, 0.78);
  vec3 horizon = mix(vec3(0.72, 0.62, 0.66), vec3(1.25, 0.72, 0.38), pow(sun, 3.0));
  vec3 c = mix(horizon, mid, smoothstep(0.0, 0.22, up));
  c = mix(c, zenith, smoothstep(0.15, 0.75, up));
  c += vec3(1.5, 0.75, 0.35) * pow(sun, 24.0) * 0.45;
  c += vec3(14.0, 9.0, 5.0) * smoothstep(0.9993, 0.9997, sun);
  return c;
}

vec3 applyFog(vec3 c, vec3 p) {
  vec3 ray = p - u_cam;
  float d = length(ray);
  vec3 dir = ray / max(d, 1e-3);
  float amount = 1.0 - exp(-max(d - 70.0, 0.0) * 0.0016);
  return mix(c, skyColor(vec3(dir.xy, max(dir.z, 0.015))) * 0.92, amount);
}

float sunShadow(vec3 p, vec3 n) {
  vec4 q = u_shadowVP * vec4(p + n * 0.05, 1.0);
  vec3 s = q.xyz * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return 1.0;
  s.z -= 0.0012;
  float texel = 1.0 / 2048.0;
  float sum = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      sum += texture(u_shadow, s + vec3(float(x), float(y), 0.0) * texel * 1.25);
  return sum / 9.0;
}

vec3 shade(vec3 albedo, vec3 p, vec3 n, float gloss, float ao) {
  vec3 v = normalize(u_cam - p);
  float nl = max(dot(n, u_sunDir), 0.0);
  float sh = nl > 0.0 ? sunShadow(p, n) : 0.0;
  vec3 sunCol = vec3(2.45, 1.62, 1.0);
  vec3 skyAmb = mix(vec3(0.30, 0.22, 0.20), vec3(0.34, 0.46, 0.68), n.z * 0.5 + 0.5);
  vec3 c = albedo * (skyAmb * ao + sunCol * nl * sh);
  vec3 h = normalize(u_sunDir + v);
  c += sunCol * sh * nl * pow(max(dot(n, h), 0.0), 8.0 + gloss * 120.0) * gloss * 0.8;
  for (int i = 0; i < ${LIGHT_COUNT}; i++) {
    vec3 l = u_lightPos[i].xyz - p;
    float d2 = dot(l, l);
    float r = u_lightPos[i].w;
    if (r <= 0.0 || d2 > r * r) continue;
    float fall = 1.0 - sqrt(d2) / r;
    c += albedo * u_lightCol[i].rgb * max(dot(n, normalize(l)), 0.0) * fall * fall;
  }
  return c;
}
`;

export const SKY_VS = `${HEADER}
out vec2 v_uv;
void main() {
  v_uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v_uv * 2.0 - 1.0, 0.9999, 1.0);
}`;

export const SKY_FS = `${HEADER}
in vec2 v_uv;
out vec4 o;
${COMMON}
uniform vec3 u_right, u_up, u_fwd;
uniform float u_tanHalf, u_aspect;
void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  vec3 d = normalize(u_fwd + u_right * ndc.x * u_tanHalf * u_aspect + u_up * ndc.y * u_tanHalf);
  vec3 c = skyColor(d);
  if (d.z > 0.01) {
    vec2 q = d.xy / (d.z + 0.12);
    float streak = fbm(q * vec2(0.7, 1.7) + vec2(u_time * 0.004, 3.0));
    float cloud = smoothstep(0.5, 0.82, streak) * smoothstep(0.01, 0.2, d.z);
    float toSun = pow(max(dot(d, u_sunDir), 0.0), 3.0);
    c = mix(c, mix(vec3(0.75, 0.55, 0.62), vec3(2.2, 1.15, 0.65), toSun), cloud * 0.8);
  }
  o = vec4(c, 1.0);
}`;

export const SHADOW_VS = `${HEADER}
layout(location = 0) in vec3 a_pos;
uniform mat4 u_vp;
void main() { gl_Position = u_vp * vec4(a_pos, 1.0); }`;

export const SHADOW_INST_VS = `${HEADER}
layout(location = 0) in vec3 a_pos;
layout(location = 3) in vec4 i_r0;
layout(location = 4) in vec4 i_r1;
layout(location = 5) in vec4 i_r2;
uniform mat4 u_vp;
void main() {
  vec4 p = vec4(a_pos, 1.0);
  gl_Position = u_vp * vec4(dot(i_r0, p), dot(i_r1, p), dot(i_r2, p), 1.0);
}`;

export const EMPTY_FS = `${HEADER}
void main() {}`;

export const ARENA_VS = `${HEADER}
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_matAo;
uniform mat4 u_vp;
out vec3 v_p;
out vec3 v_n;
flat out int v_mat;
out float v_ao;
void main() {
  v_p = a_pos;
  v_n = a_normal;
  v_mat = int(a_matAo.x + 0.5);
  v_ao = a_matAo.y;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

export const ARENA_FS = `${HEADER}
in vec3 v_p;
in vec3 v_n;
flat in int v_mat;
in float v_ao;
layout(location = 0) out vec4 o;
${COMMON}
uniform sampler2D u_board;
uniform float u_crowd;
uniform float u_oc;
const vec3 KILN = vec3(1.0, 0.24, 0.05);
const vec3 TIDE = vec3(0.03, 0.62, 0.68);
const vec3 SIGNAL = vec3(1.0, 0.70, 0.08);

float seam(float v, float period, float width) {
  float f = abs(fract(v / period + 0.5) - 0.5) * period;
  return smoothstep(width, width * 0.4, f);
}
vec3 teamWash(float x) { return x < 32.0 ? KILN : TIDE; }

void main() {
  vec3 p = v_p;
  vec3 n = normalize(v_n);
  vec2 flat2 = abs(n.z) > 0.5 ? p.xy : vec2(p.x + p.y, p.z);
  float grain = fbm(flat2 * 1.3) * 0.55 + fbm(flat2 * 7.0) * 0.45;
  vec3 concrete = mix(vec3(0.27, 0.26, 0.26), vec3(0.50, 0.47, 0.44), grain);
  vec3 c = concrete;
  vec3 glow = vec3(0.0);
  float gloss = 0.08;
  float centerDist = length(p.xy - vec2(32.0, 20.0));

  if (v_mat == 0) {
    float panels = max(seam(p.x, 4.0, 0.05), seam(p.y, 4.0, 0.05));
    c *= 1.0 - panels * 0.42;
    float toBase = smoothstep(21.0, 12.0, min(p.x, 64.0 - p.x));
    c = mix(c, teamWash(p.x) * (0.7 + grain * 0.5), toBase * 0.28);
    float halfway = smoothstep(0.09, 0.05, abs(p.x - 32.0));
    float lane = smoothstep(0.09, 0.05, abs(abs(p.y - 20.0) - 11.0));
    c = mix(c, vec3(0.82, 0.8, 0.72), max(halfway, lane) * smoothstep(0.35, 0.6, grain + 0.2) * 0.8);
  } else if (v_mat == 1) {
    float stripes = step(0.5, fract((p.x + p.y) * 0.75));
    c = n.z > 0.5 ? concrete * 0.95 : mix(vec3(0.05), SIGNAL, stripes);
  } else if (v_mat == 2) {
    float ribs = 1.0 - seam(p.x + p.y, 3.0, 0.05) * 0.5;
    c = vec3(0.055, 0.10, 0.25) * (0.8 + grain * 0.5) * ribs;
    if (n.z < 0.5) {
      vec3 boardRight = cross(-n, vec3(0.0, 0.0, 1.0));
      float along = dot(p, boardRight);
      float band = step(2.1, p.z) * step(p.z, 4.3);
      if (band > 0.5) {
        vec2 uv = vec2(along / 40.0 + u_time * 0.015, 1.0 - (p.z - 2.1) / 2.2);
        vec3 led = texture(u_board, uv).rgb;
        float dots = smoothstep(0.5, 0.2, length(fract(vec2(along, p.z) * 9.0) - 0.5));
        glow = led * (0.28 + dots * 0.75) * (1.0 + u_crowd * 1.2);
        c *= 0.2;
      }
      float cap = step(8.5, p.z);
      c = mix(c, vec3(0.46, 0.44, 0.40), cap);
    }
  } else if (v_mat == 3) {
    float blocks = max(seam(p.z, 1.0, 0.03), seam(p.x + p.y, 2.0, 0.03));
    c *= 1.0 - blocks * 0.35;
    vec3 team = teamWash(p.x);
    float band = step(2.6, p.z) * step(p.z, 3.2);
    c = mix(c, team, band * 0.9);
  } else if (v_mat == 4) {
    vec3 team = teamWash(p.x);
    float base = p.z + (centerDist < 13.0 ? 1.0 : 0.0);
    c = vec3(0.46, 0.44, 0.40) * (0.62 + grain * 0.6);
    c = mix(c, vec3(0.06, 0.07, 0.1), smoothstep(0.55, 0.5, base));
    c = mix(c, team, step(1.25, base) * step(base, 1.75));
    if (n.z > 0.5) c = team * (0.55 + grain * 0.4);
    gloss = 0.2;
  } else if (v_mat == 5) {
    vec3 team = teamWash(p.x) * 0.72;
    float ribs = 0.8 + 0.2 * sin((abs(n.x) > 0.5 ? p.y : p.x) * 22.0);
    c = (n.z > 0.5 ? team * 0.9 : team) * ribs * (0.72 + grain * 0.45);
    gloss = 0.35;
  } else if (v_mat == 6) {
    vec3 team = teamWash(p.x);
    float grid = max(seam(p.x, 2.0, 0.04), seam(p.y, 2.0, 0.04));
    c = mix(concrete * 0.82, team * 0.72, 0.36) * (1.0 - grid * 0.3);
    float edge = smoothstep(0.26, 0.2, abs(min(p.x, 64.0 - p.x) - 8.8));
    c = mix(c, team, edge);
    gloss = 0.15;
  } else if (v_mat == 7) {
    float tread = 0.75 + 0.25 * step(0.5, fract(p.x * 3.0)) * step(0.5, fract(p.y * 3.0));
    c = n.z > 0.5 ? vec3(0.32, 0.34, 0.38) * tread * (0.7 + grain * 0.6) : vec3(0.15, 0.18, 0.26) * (0.8 + grain * 0.4);
    gloss = 0.45;
  } else if (v_mat == 8) {
    c = vec3(0.13, 0.19, 0.30) * (0.72 + grain * 0.6);
    gloss = 0.5;
    float ring = smoothstep(0.1, 0.05, abs(centerDist - 9.5)) + smoothstep(0.09, 0.04, abs(centerDist - 4.0));
    c = mix(c, vec3(0.86, 0.84, 0.76), ring * 0.8);
    float pulse = 0.6 + 0.4 * sin(u_time * 4.0);
    glow += SIGNAL * smoothstep(0.24, 0.06, abs(centerDist - 2.9)) * (0.35 + u_oc * pulse * 5.0);
  } else if (v_mat == 9) {
    float outward = max(max(-p.x, p.x - 64.0), max(-p.y, p.y - 40.0));
    float along = abs(p.x - 32.0) / 32.0 * max(0.0, abs(p.y - 20.0) - 20.0) > abs(p.y - 20.0) / 20.0 * max(0.0, abs(p.x - 32.0) - 32.0) ? p.x : p.y;
    float row = n.z > 0.5 ? outward * 1.45 : p.z * 1.45;
    row = floor(row);
    vec2 seat = vec2(along * 2.1 + row * 0.37, row + fract(n.z > 0.5 ? outward * 1.45 : p.z * 1.45));
    vec2 cell = floor(seat);
    float h = hash(cell * 0.73);
    float h2 = hash(cell.yx + 3.1);
    float occupied = step(0.14, h);
    vec2 f = fract(seat) - 0.5;
    float body = smoothstep(0.52, 0.28, length(f * vec2(1.2, 0.8)));
    bool orangeSide = p.x + (h2 - 0.5) * 34.0 < 32.0;
    vec3 shirt = orangeSide ? vec3(0.95, 0.34, 0.1) : vec3(0.05, 0.62, 0.72);
    if (h2 > 0.72) shirt = vec3(0.86, 0.82, 0.74);
    float bounce = max(0.0, sin(u_time * (5.0 + h * 5.0) + h * 40.0)) * u_crowd;
    c = mix(vec3(0.1, 0.12, 0.18), shirt * (0.55 + 0.5 * h2 + bounce), occupied * body);
    float crowdBlur = clamp(fwidth(seat.x) * 1.6 + fwidth(seat.y) * 1.6 - 0.6, 0.0, 1.0);
    vec3 crowdMean = mix(vec3(0.34, 0.2, 0.15), vec3(0.14, 0.28, 0.32), smoothstep(14.0, 50.0, p.x));
    c = mix(c, crowdMean * (1.0 + u_crowd * 0.6), crowdBlur);
    float flash = step(0.9985, hash(cell + floor(u_time * 9.0))) * (0.08 + u_crowd);
    glow += vec3(3.5) * flash * body;
    gloss = 0.0;
  } else if (v_mat == 10) {
    c = concrete * 0.55;
  } else if (v_mat == 11) {
    c = vec3(0.1);
    vec2 g = fract(vec2(p.x + p.y, p.z) * 1.4) - 0.5;
    glow = vec3(4.2, 3.8, 3.1) * smoothstep(0.42, 0.18, length(g));
  } else {
    c = vec3(0.22, 0.2, 0.2) * (0.7 + grain * 0.5);
  }

  vec3 lit = shade(c, p, n, gloss, v_ao) + glow;
  o = vec4(applyFog(lit, p), 1.0);
}`;

export const INST_VS = `${HEADER}
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 3) in vec4 i_r0;
layout(location = 4) in vec4 i_r1;
layout(location = 5) in vec4 i_r2;
layout(location = 6) in vec4 i_color;
uniform mat4 u_vp;
out vec3 v_p;
out vec3 v_n;
out vec4 v_color;
out vec3 v_local;
void main() {
  vec4 q = vec4(a_pos, 1.0);
  v_p = vec3(dot(i_r0, q), dot(i_r1, q), dot(i_r2, q));
  vec4 n = vec4(a_normal, 0.0);
  v_n = vec3(dot(i_r0, n), dot(i_r1, n), dot(i_r2, n));
  v_color = i_color;
  v_local = a_pos;
  gl_Position = u_vp * vec4(v_p, 1.0);
}`;

export const INST_FS = `${HEADER}
in vec3 v_p;
in vec3 v_n;
in vec4 v_color;
in vec3 v_local;
layout(location = 0) out vec4 o;
${COMMON}
void main() {
  vec3 n = normalize(v_n);
  // Soften box edges so hard-surface parts catch a highlight.
  vec3 a = abs(v_local);
  float edge = smoothstep(0.86, 1.0, max(max(min(a.x, a.y), min(a.y, a.z)), min(a.x, a.z)));
  vec3 lit = shade(v_color.rgb * (1.0 + edge * 0.45), v_p, n, 0.55, 0.92);
  lit += v_color.rgb * v_color.a;
  o = vec4(applyFog(lit, v_p), 1.0);
}`;

export const FX_VS = `${HEADER}
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
uniform mat4 u_vp;
out vec2 v_uv;
out vec4 v_color;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

export const FX_FS = `${HEADER}
in vec2 v_uv;
in vec4 v_color;
layout(location = 0) out vec4 o;
void main() {
  float d = length(v_uv);
  float falloff = v_color.a < 0.0 ? smoothstep(1.0, 0.0, abs(v_uv.y)) : pow(max(1.0 - d, 0.0), 2.2);
  o = vec4(v_color.rgb * falloff * abs(v_color.a), 1.0);
}`;

export const POST_VS = `${HEADER}
out vec2 v_uv;
void main() {
  v_uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v_uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLOOM_DOWN_FS = `${HEADER}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_threshold;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 4.0;
  c += texture(u_tex, v_uv + u_texel * vec2(-1, -1)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1, -1)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(-1, 1)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1, 1)).rgb;
  c /= 8.0;
  if (u_threshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(u_threshold, u_threshold + 1.2, l);
  }
  o = vec4(min(c, vec3(40.0)), 1.0);
}`;

export const BLOOM_UP_FS = `${HEADER}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_tex, v_uv + u_texel * vec2(-1, 0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1, 0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(0, -1)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(0, 1)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(-0.7, -0.7)).rgb * 2.0;
  c += texture(u_tex, v_uv + u_texel * vec2(0.7, -0.7)).rgb * 2.0;
  c += texture(u_tex, v_uv + u_texel * vec2(-0.7, 0.7)).rgb * 2.0;
  c += texture(u_tex, v_uv + u_texel * vec2(0.7, 0.7)).rgb * 2.0;
  o = vec4(c / 12.0, 1.0);
}`;

export const COMPOSITE_FS = `${HEADER}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_time;
uniform float u_replay;
uniform float u_hurt;
uniform float u_flash;
uniform vec2 u_res;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 c = v_uv - 0.5;
  float shift = u_replay * 0.0016 * dot(c, c) * 8.0;
  vec3 hdr = vec3(
    texture(u_scene, v_uv + c * shift).r,
    texture(u_scene, v_uv).g,
    texture(u_scene, v_uv - c * shift).b
  );
  hdr += texture(u_bloom, v_uv).rgb * 0.55;
  vec3 col = aces(hdr * 0.82);
  col = pow(col, vec3(1.0 / 2.2));

  float vig = 1.0 - dot(c, c) * 0.75;
  col *= mix(1.0, vig, 0.85);

  if (u_replay > 0.0) {
    float gray = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, mix(vec3(gray), col, 0.62) * vec3(0.93, 0.97, 1.08), u_replay);
    col *= 1.0 - u_replay * 0.05 * (0.5 + 0.5 * sin(v_uv.y * u_res.y * 1.57));
  }

  float edge = smoothstep(0.1, 0.5, length(c));
  col = mix(col, vec3(0.75, 0.05, 0.03), u_hurt * edge * 0.45);
  col += vec3(u_flash);
  col += (rand(v_uv * u_res + u_time) - 0.5) * 0.016;
  o = vec4(col, 1.0);
}`;
