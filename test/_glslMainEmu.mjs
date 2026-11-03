// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _glslMainEmu.mjs -- a whole fragment main() of a generated shader (mantle.frag.glsl, maskBake.frag.glsl), run on the
// CPU in float32, compiled from the shader text itself. test/_glslEmu.mjs lifts the fill KERNELS; this lifts everything
// main() reaches, so two shader texts can be held to each other fragment for fragment (test/_shaderIdentity.mjs).
//
// Built on _glslEmu.mjs's lexical GLSL -> C++ translator and vector header, so what runs is the generated text, not a
// port. On top of that:
//   * the text goes through the C preprocessor FIRST (clang -E -P) with the variant's defines, so #if chains are resolved
//     before the top-level split (the CPatch section's #if branches otherwise leave the brace depth unbalanced);
//   * `void main()` becomes `void fragMain()`, `discard` a C++ throw, and an rgb/xy swizzle write on a vector a whole-vector
//     write (the translator does not support swizzle writes);
//   * every uniform and varying declaration is parsed and becomes a C++ global, set per job and per fragment;
//   * samplers carry their own width and height; texture() is bilinear with clamp-to-edge and 8-bit sub-texel weights,
//     as filtering hardware quantizes them; textureGrad ignores its gradients; dFdx/dFdy/fwidth of a vec2 return the
//     fragment's em-coordinate derivatives (the only vec2 main() differentiates), of anything else a fixed value.
// Every arm of an A/B runs under the same emulation, so a bit-identical result is a statement about the two TEXTS. It is
// not a statement about interpolation, derivative quads or a GPU compiler's contraction choices -- though `contract: true`
// runs it fused (see _glslEmu.mjs fpFlags), which is the question of whether a text depends on them.
//
// Needs a C++17 compiler (as _glslEmu.mjs) and clang for the preprocessor; `hasMainEmu()` says whether both exist.
//
//   const emu = buildMainEmu(genFragText, ['MANTLE_AAC']);
//   const out = runMainEmu(emu, textures, uniforms, frags);   // Float32Array, 5 per fragment: rgba + discarded
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import { glslToCpp, cxx, vecHeader, fpFlags, emuContractDefault } from './_glslEmu.mjs';

let _clang;
function clang() {
  if (_clang !== undefined) return _clang;
  _clang = spawnSync('clang', ['--version'], { stdio: 'ignore' }).status === 0 ? 'clang' : null;
  return _clang;
}
export const hasMainEmu = () => !!cxx() && !!clang();

/// `clang -E <args>` over `src`, from a FILE and under a time cap. Fed on stdin, the preprocessor can stall at 0% CPU
/// indefinitely; a run that stalls fails after two minutes and is retried, up to three times.
export function clangPreprocess(src, args) {
  let r = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = path.join(os.tmpdir(), `mantle_pp_${process.pid}_${attempt}_${Date.now()}.c`);
    writeFileSync(f, src);
    r = spawnSync('clang', ['-E', ...args, f], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rmSync(f, { force: true });
    if (r.status === 0) return r;
  }
  return r;
}

/// Resolve the text's #if chains for one define set. The #version line goes: the C preprocessor rejects it.
export function preprocessGlsl(text, defines = []) {
  const src = defines.map((d) => `#define ${d}\n`).join('') + text.replace(/^#version[^\n]*\n/, '');
  const r = clangPreprocess(src, ['-P', '-x', 'c', '-std=c99', '-Wno-everything']);
  if (r.status !== 0)
    throw new Error(
      'glslMainEmu: preprocess failed (status ' +
        r.status +
        ', signal ' +
        r.signal +
        '): ' +
        (r.stderr || '').slice(0, 2000),
    );
  return r.stdout;
}

export const CTYPE = {
  float: 1,
  int: 1,
  bool: 1,
  uint: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  ivec2: 2,
  ivec3: 3,
  ivec4: 4,
  mat2: 4,
  mat3: 9,
  mat4: 16,
};
export const SAMPLERS = new Set(['sampler2D', 'isampler2D', 'sampler2DArray']);

/// The uniforms and stage inputs a preprocessed text declares, in declaration order (comma lists included).
export function parseDecls(pre) {
  const uniforms = [],
    varyings = [];
  const re = /^\s*(flat\s+)?(uniform|in)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\w\s,]+?)\s*;/gm;
  let m;
  while ((m = re.exec(pre))) {
    const [, , kind, type, names] = m;
    for (const name of names
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean))
      (kind === 'uniform' ? uniforms : varyings).push({ type, name });
  }
  return { uniforms, varyings };
}

// What main() needs beyond _glslEmu.mjs's header: bvec, matrices, the other sampler types, texture() and bit casts.
// Shared with test/_lbPipeEmu.mjs, which brings its own derivatives (real 2x2 quads) and stage globals.
export const PRELUDE_CORE = `
namespace glsl {
typedef V<bool,2> bvec2; typedef V<bool,3> bvec3; typedef V<bool,4> bvec4;
template<class T, int N> inline V<bool,N> notEqual(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] != b[i]; return r; }
template<class T, int N> inline V<bool,N> equal(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] == b[i]; return r; }
template<int N> inline bool any(const V<bool,N>& v) { for (int i = 0; i < N; i++) if (v[i]) return true; return false; }
template<class T, int N> inline V<bool,N> greaterThan(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] > b[i]; return r; }
template<int N> inline V<bool,N> isnan(const V<float,N>& v) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = std::isnan(v[i]); return r; }
template<int N> inline V<bool,N> isinf(const V<float,N>& v) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = std::isinf(v[i]); return r; }
#ifndef GLSL_EMU_ALL
#define GLSL_EMU_ALL
template<int N> inline bool all(const V<bool,N>& v) { for (int i = 0; i < N; i++) if (!v[i]) return false; return true; }
#endif
template<int N> inline V<float,N> step(const V<float,N>& e, const V<float,N>& x) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = step(e[i], x[i]); return r; }
template<int N> inline V<float,N> mix(const V<float,N>& a, const V<float,N>& b, const V<float,N>& t) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = mix(a[i], b[i], t[i]); return r; }
template<int N> inline V<float,N> mod(const V<float,N>& a, float b) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = mod(a[i], b); return r; }
inline float fma(float a, float b, float c) { return a * b + c; }
// (floatBitsToUint / uintBitsToFloat come with _glslEmu.mjs's header)
inline int floatBitsToInt(float f) { int u; std::memcpy(&u, &f, 4); return u; }
inline float halfToFloat(unsigned h) { unsigned s = (h >> 15) & 1, e = (h >> 10) & 31, m = h & 1023; float v;
  if (e == 0) v = std::ldexp((float)m, -24); else if (e == 31) v = m ? NAN : INFINITY; else v = std::ldexp((float)(m | 1024), (int)e - 25); return s ? -v : v; }
inline vec2 unpackHalf2x16(uint u) { return vec2(halfToFloat(u & 0xFFFFu), halfToFloat(u >> 16)); }
// float -> half, round to nearest even (the morph vertex stage re-packs half pairs: lbMixHalfUnit, lbPackKlmGrad's min).
inline unsigned floatToHalf(float f) { unsigned x; std::memcpy(&x, &f, 4); unsigned s = (x >> 16) & 0x8000u, m = x & 0x7FFFFFu;
  int be = (int)((x >> 23) & 0xFFu), e = be - 127 + 15;
  if (be == 0xFF) return s | 0x7C00u | (m ? 0x200u : 0u);
  if (e >= 31) return s | 0x7C00u;
  if (e <= 0) { if (e < -10) return s; m |= 0x800000u; unsigned sh = (unsigned)(14 - e), hm = m >> sh, rem = m & ((1u << sh) - 1u), hf = 1u << (sh - 1u);
    if (rem > hf || (rem == hf && (hm & 1u))) hm++; return s | hm; }
  unsigned hm = m >> 13, rem = m & 0x1FFFu, h = s | ((unsigned)e << 10) | hm; if (rem > 0x1000u || (rem == 0x1000u && (hm & 1u))) h++; return h; }
inline uint packHalf2x16(vec2 v) { return floatToHalf(v.x) | (floatToHalf(v.y) << 16); }
struct mat2 { vec2 c[2]; mat2() {} explicit mat2(float s) { c[0] = vec2(s, 0.0f); c[1] = vec2(0.0f, s); }
  mat2(float a, float b, float d, float e) { c[0] = vec2(a, b); c[1] = vec2(d, e); } mat2(vec2 a, vec2 b) { c[0] = a; c[1] = b; }
  // mat2(mat3): the upper-left 2x2 (GLSL's matrix-from-matrix constructor); a template so mat3 may be declared after this.
  template <class M, class = typename std::enable_if<(sizeof(M) > 16)>::type> explicit mat2(const M& m) { c[0] = vec2(m.c[0].x, m.c[0].y); c[1] = vec2(m.c[1].x, m.c[1].y); }
  vec2& operator[](int i) { return c[i]; } const vec2& operator[](int i) const { return c[i]; } };
inline vec2 operator*(const mat2& m, const vec2& v) { vec2 r; for (int i = 0; i < 2; i++) r[i] = m.c[0][i] * v.x + m.c[1][i] * v.y; return r; }
inline mat2 operator*(const mat2& a, const mat2& b) { mat2 r; r.c[0] = a * b.c[0]; r.c[1] = a * b.c[1]; return r; }
inline vec2 operator*(const vec2& v, const mat2& m) { return vec2(dot(v, m.c[0]), dot(v, m.c[1])); }
inline mat2 operator*(const mat2& a, float s) { mat2 r; r.c[0] = a.c[0] * s; r.c[1] = a.c[1] * s; return r; }
inline mat2 inverse(const mat2& m) { float det = m.c[0].x * m.c[1].y - m.c[1].x * m.c[0].y; return mat2(m.c[1].y / det, -m.c[0].y / det, -m.c[1].x / det, m.c[0].x / det); }
inline float determinant(const mat2& m) { return m.c[0].x * m.c[1].y - m.c[1].x * m.c[0].y; }
inline mat2 transpose(const mat2& m) { return mat2(m.c[0].x, m.c[1].x, m.c[0].y, m.c[1].y); }
struct mat3 { vec3 c[3]; mat3() {} explicit mat3(float s) { c[0] = vec3(s, 0.0f, 0.0f); c[1] = vec3(0.0f, s, 0.0f); c[2] = vec3(0.0f, 0.0f, s); }
  mat3(vec3 a, vec3 b, vec3 d) { c[0] = a; c[1] = b; c[2] = d; }
  mat3(float a, float b, float d, float e, float f, float g, float h, float k, float l) { c[0] = vec3(a, b, d); c[1] = vec3(e, f, g); c[2] = vec3(h, k, l); }
  vec3& operator[](int i) { return c[i]; } const vec3& operator[](int i) const { return c[i]; } };
inline vec3 operator*(const mat3& m, const vec3& v) { vec3 r; for (int i = 0; i < 3; i++) r[i] = m.c[0][i] * v.x + m.c[1][i] * v.y + m.c[2][i] * v.z; return r; }
inline mat3 operator*(const mat3& a, const mat3& b) { return mat3(a * b.c[0], a * b.c[1], a * b.c[2]); }
struct mat4 { vec4 c[4]; mat4() {} vec4& operator[](int i) { return c[i]; } const vec4& operator[](int i) const { return c[i]; } };
inline vec4 operator*(const mat4& m, const vec4& v) { vec4 r; for (int i = 0; i < 4; i++) r[i] = m.c[0][i] * v.x + m.c[1][i] * v.y + m.c[2][i] * v.z + m.c[3][i] * v.w; return r; }
struct isampler2D { const float* data; int w; int h; };
struct sampler2DArray { const float* data; int w; int h; int layers; };
inline ivec4 texelFetch(const isampler2D& s, ivec2 p, int) {
  if (!s.data || p.x < 0 || p.y < 0 || p.x >= s.w || p.y >= s.h) return ivec4(0);
  const float* q = s.data + ((long)p.y * s.w + p.x) * 4; return ivec4((int)q[0], (int)q[1], (int)q[2], (int)q[3]); }
inline vec4 texelAt(const float* data, int w, int h, int x, int y) {
  x = x < 0 ? 0 : (x >= w ? w - 1 : x); y = y < 0 ? 0 : (y >= h ? h - 1 : y);
  const float* q = data + ((long)y * w + x) * 4; return vec4(q[0], q[1], q[2], q[3]); }
inline vec4 bilinear(const float* data, int w, int h, vec2 uv) {
  if (!data) return vec4(0.0f);
  float fx = uv.x * (float)w - 0.5f, fy = uv.y * (float)h - 0.5f;
  float x0 = std::floor(fx), y0 = std::floor(fy);
  float ax = std::round((fx - x0) * 256.0f) / 256.0f, ay = std::round((fy - y0) * 256.0f) / 256.0f;
  int ix = (int)x0, iy = (int)y0;
  if (ax >= 1.0f) { ix++; ax = 0.0f; } if (ay >= 1.0f) { iy++; ay = 0.0f; }
  vec4 a = texelAt(data, w, h, ix, iy), b = texelAt(data, w, h, ix + 1, iy), c = texelAt(data, w, h, ix, iy + 1), d = texelAt(data, w, h, ix + 1, iy + 1);
  vec4 r; for (int i = 0; i < 4; i++) { float top = ax == 0.0f ? a[i] : a[i] * (1.0f - ax) + b[i] * ax; float bot = ax == 0.0f ? c[i] : c[i] * (1.0f - ax) + d[i] * ax; r[i] = ay == 0.0f ? top : top * (1.0f - ay) + bot * ay; }
  return r; }
inline vec4 texture(const sampler2D& s, vec2 uv) { return bilinear(s.data, s.w, s.h, uv); }
inline vec4 texture(const sampler2DArray& s, vec3 uvl) { int l = (int)std::floor(uvl.z + 0.5f); if (!s.data || l < 0 || l >= s.layers) return vec4(0.0f);
  return bilinear(s.data + (long)l * s.w * s.h * 4, s.w, s.h, vec2(uvl.x, uvl.y)); }
inline vec4 texelFetch(const sampler2DArray& s, ivec3 p, int) { if (!s.data || p.z < 0 || p.z >= s.layers || p.x < 0 || p.y < 0 || p.x >= s.w || p.y >= s.h) return vec4(0.0f);
  const float* q = s.data + (((long)p.z * s.h + p.y) * s.w + p.x) * 4; return vec4(q[0], q[1], q[2], q[3]); }
inline vec4 textureGrad(const sampler2D& s, vec2 uv, vec2, vec2) { return bilinear(s.data, s.w, s.h, uv); }
inline ivec2 textureSize(const sampler2D& s, int) { return ivec2(s.w, s.h); }
inline ivec3 textureSize(const sampler2DArray& s, int) { return ivec3(s.w, s.h, s.layers); }
template<class T> inline T __setxy(T v, vec2 e) { v.x = e.x; v.y = e.y; return v; }
}
`;
// main()'s derivatives: the fragment's em-coordinate derivatives for a vec2 (the only vec2 main() differentiates), a
// fixed value for anything else.
const PRELUDE =
  PRELUDE_CORE +
  `
namespace glsl {
vec2 g_dx, g_dy; const float g_dfs = 0.01f;
inline vec2 dFdx(vec2) { return g_dx; } inline vec2 dFdy(vec2) { return g_dy; } inline vec2 fwidth(vec2) { return abs(g_dx) + abs(g_dy); }
inline float dFdx(float) { return g_dfs; } inline float dFdy(float) { return g_dfs; } inline float fwidth(float) { return 2.0f * g_dfs; }
inline vec3 dFdx(vec3) { return vec3(g_dfs); } inline vec3 dFdy(vec3) { return vec3(g_dfs); }
vec4 gl_FragCoord; vec4 fragColor;
}
`;

/// The emulator's texel fetch honors each sampler's own width (the meta plane is 12 wide, the stop LUT 2048, ...), where
/// _glslEmu.mjs's kernels only ever read the 4096-wide curve and band textures.
export function header() {
  const h = vecHeader()
    // _glslEmu.mjs's sampler carries its own row width (defaulting to the curve plane's 4096) and its fetch
    // counter's slot (0 band, 1 curve, 2 other); here every sampler is built with its own width and height,
    // and a main-shader sampler is `other`, set where it is bound below.
    .replace(
      'struct sampler2D { const float* data; long texels; long w = 4096; int id = 2; };',
      'struct sampler2D { const float* data; long texels; int id; int w; int h; };',
    )
    .replace(
      'long idx = (long)xy.y * s.w + xy.x;',
      'if (!s.data || xy.x >= s.w) return vec4(0.0f); long idx = (long)xy.y * s.w + xy.x;',
    );
  if (!h.includes('int w; int h;') || !h.includes('xy.x >= s.w'))
    throw new Error('glslMainEmu: the _glslEmu.mjs header changed; patch its sampler2D here');
  return '#include <cstring>\n' + h;
}

export function assign(d, arr, o) {
  const n = d.name,
    a = (k) => `${arr}[${o + k}]`;
  switch (d.type) {
    case 'float':
      return `${n} = ${a(0)};`;
    case 'int':
    case 'uint':
      return `${n} = (int)${a(0)};`;
    case 'bool':
      return `${n} = ${a(0)} != 0.0f;`;
    case 'vec2':
      return `${n} = vec2(${a(0)}, ${a(1)});`;
    case 'vec3':
      return `${n} = vec3(${a(0)}, ${a(1)}, ${a(2)});`;
    case 'vec4':
      return `${n} = vec4(${a(0)}, ${a(1)}, ${a(2)}, ${a(3)});`;
    case 'ivec2':
      return `${n} = ivec2((int)${a(0)}, (int)${a(1)});`;
    case 'ivec4':
      return `${n} = ivec4((int)${a(0)}, (int)${a(1)}, (int)${a(2)}, (int)${a(3)});`;
    case 'mat2':
      return `${n} = mat2(${a(0)}, ${a(1)}, ${a(2)}, ${a(3)});`;
    case 'mat3':
      return `${n} = mat3(vec3(${a(0)}, ${a(1)}, ${a(2)}), vec3(${a(3)}, ${a(4)}, ${a(5)}), vec3(${a(6)}, ${a(7)}, ${a(8)}));`;
    case 'mat4':
      return `for (int c = 0; c < 4; c++) ${n}.c[c] = vec4(${arr}[${o} + c * 4], ${arr}[${o} + c * 4 + 1], ${arr}[${o} + c * 4 + 2], ${arr}[${o} + c * 4 + 3]);`;
    default:
      throw new Error('glslMainEmu: unsupported type ' + d.type + ' for ' + n);
  }
}

const CACHE = path.join(os.tmpdir(), 'mantle-mainemu');

/// Compile `genText`'s main() under `defines`. Cached by the C++ source's hash, so an unchanged text compiles once.
export function buildMainEmu(
  genText,
  defines = [],
  { opt = '-O1', contract = emuContractDefault() } = {},
) {
  const C = cxx();
  if (!C || !clang()) throw new Error('glslMainEmu: needs a C++17 compiler and clang');
  let pre = preprocessGlsl(genText, defines);
  const decls = parseDecls(pre);
  if (!/void\s+main\s*\(\s*\)\s*\{/.test(pre))
    throw new Error('glslMainEmu: no main() in the text');
  pre = pre
    .replace(/void\s+main\s*\(\s*\)\s*\{/, 'void fragMain() {')
    .replace(/\bdiscard\s*;/g, 'throw 1;')
    .replace(
      /(\b[A-Za-z_]\w*)\.rgb\s*=(?!=)\s*([^;]+);/g,
      (_, v, e) => `${v} = vec4(${e}, ${v}.a);`,
    )
    .replace(
      /(\b[A-Za-z_]\w*)\.xy\s*=(?!=)\s*([^;]+);/g,
      (_, v, e) => `${v} = __setxy(${v}, ${e});`,
    );
  const body = glslToCpp(pre, ['fragMain']);
  const setters = [];
  let nu = 0;
  for (const u of decls.uniforms) {
    if (SAMPLERS.has(u.type)) {
      const bind =
        u.type === 'sampler2D'
          ? `${u.name}.data = TX[ti].data; ${u.name}.texels = (long)TX[ti].w * TX[ti].h * TX[ti].l; ${u.name}.id = 2; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h * TX[ti].l;`
          : u.type === 'isampler2D'
            ? `${u.name}.data = TX[ti].data; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h;`
            : `${u.name}.data = TX[ti].data; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h; ${u.name}.layers = TX[ti].l;`;
      setters.push(`{ int ti = (int)U[${nu}]; if (ti >= 0 && ti < nTex) { ${bind} } }`);
      nu += 1;
    } else {
      if (!CTYPE[u.type]) throw new Error('glslMainEmu: uniform type ' + u.type);
      setters.push(assign(u, 'U', nu));
      nu += CTYPE[u.type];
    }
  }
  const vset = [];
  let nv = 0;
  for (const v of decls.varyings) {
    if (!CTYPE[v.type]) throw new Error('glslMainEmu: varying type ' + v.type);
    vset.push(assign(v, 'F', nv));
    nv += CTYPE[v.type];
  }
  const FR = nv + 6; // varyings, then dx, dy, fragCoord.xy
  const src = `${header()}
#include <cstdio>
#include <cstdlib>
${PRELUDE}
namespace glsl {
${[...decls.uniforms, ...decls.varyings].map((d) => `${d.type} ${d.name};`).join('\n')}
${body}
}
using namespace glsl;
struct Tex { const float* data; int w, h, l; };
int main(int argc, char** argv) {
  FILE* f = fopen(argv[1], "rb"); if (!f) return 2;
  int hdr[4]; if (fread(hdr, 4, 4, f) != 4) return 3;
  int nTex = hdr[0], nU = hdr[1], nF = hdr[2];
  if (nU != ${nu}) { fprintf(stderr, "uniform count %d != ${nu}\\n", nU); return 5; }
  Tex* TX = (Tex*)calloc(nTex + 1, sizeof(Tex));
  for (int t = 0; t < nTex; t++) { int d[3]; if (fread(d, 4, 3, f) != 3) return 4; size_t n = (size_t)d[0] * d[1] * d[2] * 4;
    float* p = (float*)malloc(4 * (n + 4)); if (fread(p, 4, n, f) != n) return 4; TX[t] = { p, d[0], d[1], d[2] }; }
  float* U = (float*)malloc(4 * (nU + 1)); if (fread(U, 4, nU, f) != (size_t)nU) return 4;
  float* FD = (float*)malloc(4 * ((size_t)nF * ${FR} + 1)); if (fread(FD, 4, (size_t)nF * ${FR}, f) != (size_t)nF * ${FR}) return 4;
  fclose(f);
  ${setters.join('\n  ')}
  float* out = (float*)malloc(4 * 5 * ((size_t)nF + 1));
  for (long i = 0; i < nF; i++) {
    const float* F = FD + i * ${FR};
    ${vset.join('\n    ')}
    g_dx = vec2(F[${nv}], F[${nv + 1}]); g_dy = vec2(F[${nv + 2}], F[${nv + 3}]);
    gl_FragCoord = vec4(F[${nv + 4}], F[${nv + 5}], 0.5f, 1.0f);
    fragColor = vec4(0.0f);
    float disc = 0.0f;
    try { fragMain(); } catch (int) { disc = 1.0f; fragColor = vec4(0.0f); }
    out[i * 5] = fragColor.x; out[i * 5 + 1] = fragColor.y; out[i * 5 + 2] = fragColor.z; out[i * 5 + 3] = fragColor.w; out[i * 5 + 4] = disc;
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(out, 4, (size_t)nF * 5, g); fclose(g);
  return 0;
}
`;
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(
    CACHE,
    `main_${createHash('sha1')
      .update(C + '\0' + opt + '\0' + (contract ? 'fma\0' : '') + src)
      .digest('hex')
      .slice(0, 20)}`,
  );
  if (!existsSync(exe)) {
    const cpp = `${exe}.${process.pid}.cpp`,
      tmp = `${exe}.${process.pid}.tmp`;
    writeFileSync(cpp, src);
    const r = spawnSync(C, ['-std=c++17', opt, ...fpFlags(contract), '-w', '-o', tmp, cpp], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    if (r.status !== 0)
      throw new Error(
        `glslMainEmu: compile failed (source kept at ${cpp}):\n` +
          (r.stderr || '').split('\n').slice(0, 40).join('\n'),
      );
    rmSync(cpp, { force: true });
    spawnSync('mv', ['-f', tmp, exe]);
  }
  return { exe, decls, nU: nu, nV: nv, FR };
}

/// Run one job. textures: [{ w, h, l, data: Float32Array }] (RGBA, row-major, layer-major); uniforms: Map name -> number
/// or number[] (a sampler takes a texture index; an unset uniform reads 0, a sampler -1 = unbound); frags: [{ varyings:
/// Map name -> number | number[], dx: [x, y], dy: [x, y], fc: [x, y] }]. Returns 5 floats per fragment: the rgba
/// fragColor and 1 where the fragment discarded.
export function runMainEmu(emu, textures, uniforms, frags) {
  const { decls, nU, FR, nV } = emu;
  const U = new Float32Array(nU);
  let o = 0;
  for (const u of decls.uniforms) {
    const v = uniforms.get(u.name);
    if (SAMPLERS.has(u.type)) {
      U[o] = v == null ? -1 : v;
      o += 1;
      continue;
    }
    for (let k = 0; k < CTYPE[u.type]; k++)
      U[o + k] = v == null ? 0 : Array.isArray(v) ? (v[k] ?? 0) : v;
    o += CTYPE[u.type];
  }
  const FD = new Float32Array(frags.length * FR);
  frags.forEach((fr, i) => {
    let p = i * FR;
    for (const v of decls.varyings) {
      const val = fr.varyings.get(v.name);
      for (let k = 0; k < CTYPE[v.type]; k++)
        FD[p + k] = val == null ? 0 : Array.isArray(val) ? (val[k] ?? 0) : val;
      p += CTYPE[v.type];
    }
    FD.set([fr.dx[0], fr.dx[1], fr.dy[0], fr.dy[1], fr.fc[0], fr.fc[1]], i * FR + nV);
  });
  let size = 16 + U.byteLength + FD.byteLength;
  for (const t of textures) size += 12 + t.w * t.h * t.l * 16;
  const buf = Buffer.alloc(size);
  buf.writeInt32LE(textures.length, 0);
  buf.writeInt32LE(nU, 4);
  buf.writeInt32LE(frags.length, 8);
  let q = 16;
  for (const t of textures) {
    buf.writeInt32LE(t.w, q);
    buf.writeInt32LE(t.h, q + 4);
    buf.writeInt32LE(t.l, q + 8);
    q += 12;
    const n = t.w * t.h * t.l * 4;
    let src = t.data;
    if (src.length < n) {
      src = new Float32Array(n);
      src.set(t.data);
    }
    Buffer.from(src.buffer, src.byteOffset, n * 4).copy(buf, q);
    q += n * 4;
  }
  Buffer.from(U.buffer).copy(buf, q);
  q += U.byteLength;
  Buffer.from(FD.buffer).copy(buf, q);
  mkdirSync(CACHE, { recursive: true });
  const job = path.join(CACHE, `job_${process.pid}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(job + '.in', buf);
  const r = spawnSync(emu.exe, [job + '.in', job + '.out'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  rmSync(job + '.in', { force: true });
  if (r.status !== 0)
    throw new Error(`glslMainEmu: emulator exit ${r.status} ${r.signal || ''} ${r.stderr || ''}`);
  const ob = readFileSync(job + '.out');
  rmSync(job + '.out', { force: true });
  return new Float32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + frags.length * 20));
}
