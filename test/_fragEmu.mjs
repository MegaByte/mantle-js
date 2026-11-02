// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fragEmu.mjs -- a whole FRAGMENT SHADER (a filter, composite or paint pass) run on the CPU in float32, compiled
// from its assembled text (src/shaders/generated/*.frag.glsl, or any assembled text handed in). Built on
// _glslEmu.mjs's lexical GLSL -> C++ translation and vector header, so the same rules hold: every operation is one
// IEEE float32 operation (-ffp-contract=off), nothing is rewritten by hand, transcendentals come from libm.
//
// What it adds for a whole pass: every `uniform` becomes a global set per run (arrays included), every `in` varying a
// global set per fragment, `fragColor` is read back after main(), `discard` is reported, and sampler2D is a float
// RGBA texture with CLAMP_TO_EDGE and NEAREST or LINEAR filtering (texture) plus exact texel reads (texelFetch).
// dFdx/dFdy return zero: a fragment runs alone here, with no quad to difference against, so a shader whose output
// depends on a derivative is only checked where the derivative does not matter.
//
// Its use is A-AGAINST-B: two shader texts (the shipped one and a rewrite) run on identical inputs, compared bit for
// bit or at 8 bits. The texture filter is this file's, not a GPU's, so an absolute answer is not a GPU's answer; the
// same filter under both texts is what makes the comparison exact.
//
// It also COUNTS, per fragment, the texture() and texelFetch() calls made and the calls into any function named in
// `count` -- the work a rewrite claims to remove, read off the same text as its answer.
//
//   const emu = buildFragEmu(glslText, { count: ['unpre'] });
//   const out = emu.run({ uniforms: { uMode: 0, uIn1Map: [1, 1, 0, 0] },
//                         textures: { uIn1: { w, h, data: Float32Array(w*h*4), linear: false } },
//                         frags: [{ vUV: [u, v] }, ...] });
//   // out.stride floats per fragment: r, g, b, a, discarded, texture() calls, texelFetch() calls, then one per `count`
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { glslToCpp, vecHeader, cxx, fpFlags, emuContractDefault } from './_glslEmu.mjs';

export { cxx };
export const hasCxx = () => !!cxx();

const CACHE = path.join(os.tmpdir(), 'mantle-glslemu');
const TYPE_FLOATS = {
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
  mat3: 9,
  mat4: 16,
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

/// The texture and the built-ins a whole pass needs beyond _glslEmu's header.
const EXTRA = `
struct sampler2D { const float* data = nullptr; int w = 0, h = 0, linear = 0; };
int g_nTexture = 0, g_nFetch = 0;
inline vec4 texelAt(const sampler2D& s, int x, int y) {
  if (!s.data || s.w <= 0 || s.h <= 0) return vec4(0.0f);
  x = x < 0 ? 0 : (x >= s.w ? s.w - 1 : x); y = y < 0 ? 0 : (y >= s.h ? s.h - 1 : y);
  const float* p = s.data + ((long)y * s.w + x) * 4;
  return vec4(p[0], p[1], p[2], p[3]);
}
inline vec4 texelFetch(const sampler2D& s, ivec2 xy, int) {
  g_nFetch = g_nFetch + 1;
  if (!s.data || xy.x < 0 || xy.y < 0 || xy.x >= s.w || xy.y >= s.h) return vec4(0.0f);
  return texelAt(s, xy.x, xy.y);
}
inline vec4 texture(const sampler2D& s, vec2 uv) {
  g_nTexture = g_nTexture + 1;
  if (!s.linear) return texelAt(s, (int)std::floor(uv.x * (float)s.w), (int)std::floor(uv.y * (float)s.h));
  float fx = uv.x * (float)s.w - 0.5f, fy = uv.y * (float)s.h - 0.5f;
  float x0 = std::floor(fx), y0 = std::floor(fy), ax = fx - x0, ay = fy - y0;
  int ix = (int)x0, iy = (int)y0;
  vec4 a = texelAt(s, ix, iy), b = texelAt(s, ix + 1, iy), c = texelAt(s, ix, iy + 1), d = texelAt(s, ix + 1, iy + 1);
  return (a * (1.0f - ax) + b * ax) * (1.0f - ay) + (c * (1.0f - ax) + d * ax) * ay;
}
inline ivec2 textureSize(const sampler2D& s, int) { return ivec2(s.w, s.h); }
// The component-wise comparisons and any() that a texel-bounds test uses (a main-only emulator defines its own set in _glslMainEmu).
template<class T, int N> inline V<bool,N> lessThan(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] < b[i]; return r; }
template<class T, int N> inline V<bool,N> greaterThan(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] > b[i]; return r; }
template<class T, int N> inline V<bool,N> equal(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] == b[i]; return r; }
template<class T, int N> inline V<bool,N> notEqual(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] != b[i]; return r; }
template<int N> inline bool any(const V<bool,N>& v) { for (int i = 0; i < N; i++) if (v[i]) return true; return false; }
template<class T> inline T dFdx(const T&) { return T(0.0f); }
template<class T> inline T dFdy(const T&) { return T(0.0f); }
template<class T> inline T fwidth(const T&) { return T(0.0f); }
inline float degrees(float r) { return r * 57.295779513082320876798154814105f; }
inline float radians(float d) { return d * 0.017453292519943295769236907684886f; }
inline float exp2(float x) { return std::exp2(x); }
inline float log2(float x) { return std::log2(x); }
template<int N> inline V<float,N> step(float e, const V<float,N>& x) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = step(e, x[i]); return r; }
template<int N> inline V<float,N> step(const V<float,N>& e, const V<float,N>& x) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = step(e[i], x[i]); return r; }
template<int N> inline V<float,N> step(const V<float,N>& e, float x) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = step(e[i], x); return r; }
template<int N> inline V<float,N> mix(const V<float,N>& a, const V<float,N>& b, const V<float,N>& t) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = mix(a[i], b[i], t[i]); return r; }
template<int N> inline V<float,N> mix(const V<float,N>& a, const V<float,N>& b, const V<bool,N>& t) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = t[i] ? b[i] : a[i]; return r; }
template<class T, int N> inline V<T,N> min(T a, const V<T,N>& b) { return min(b, a); }
template<class T, int N> inline V<T,N> max(T a, const V<T,N>& b) { return max(b, a); }
template<int N> inline V<float,N> mod(const V<float,N>& x, float y) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = mod(x[i], y); return r; }
inline float smoothstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0f, 1.0f); return t * t * (3.0f - 2.0f * t); }
template<int N> inline V<float,N> pow(const V<float,N>& x, const V<float,N>& y) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = pow(x[i], y[i]); return r; }
template<int N> inline V<float,N> pow(const V<float,N>& x, float y) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = pow(x[i], y); return r; }
inline float distance(vec2 a, vec2 b) { return length(a - b); }
inline float distance(vec3 a, vec3 b) { return length(a - b); }
inline vec3 reflect(vec3 i, vec3 n) { return i - n * (2.0f * dot(n, i)); }
inline float fma_(float a, float b, float c) { return a * b + c; }
// Column-major matrices, as GLSL stores them: m * v sums the columns weighted by v's components.
template<int N> struct M {
  V<float,N> c[N];
  M() {}
  template<class... A> M(A... a) { float f[N * N] = { (float)a... }; for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) c[i][j] = f[i * N + j]; }
};
typedef M<3> mat3; typedef M<4> mat4;
template<int N> inline V<float,N> operator*(const M<N>& m, const V<float,N>& v) {
  V<float,N> r = m.c[0] * v[0];
  for (int i = 1; i < N; i++) r = r + m.c[i] * v[i];
  return r;
}
`;

/// Declarations of one kind (`uniform` or `in`) in declaration order: { type, name, len } (len 0 = not an array).
function decls(text, qual) {
  const out = [];
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:layout\\s*\\([^)]*\\)\\s*)?(?:(?:flat|smooth|centroid)\\s+)*${qual}\\s+(?:(?:highp|mediump|lowp|flat)\\s+)*(\\w+)\\s+(\\w+)\\s*(?:\\[\\s*(\\d+)\\s*\\])?\\s*;`,
    'g',
  );
  let m;
  while ((m = re.exec(text))) out.push({ type: m[1], name: m[2], len: m[3] ? +m[3] : 0 });
  return out;
}

export function buildFragEmu(glslText, { count = [], contract = emuContractDefault() } = {}) {
  const C = cxx();
  if (!C) throw new Error('fragEmu: no C++ compiler ($CXX, clang++, g++, c++)');
  const text = stripComments(glslText);
  const uniforms = decls(text, 'uniform');
  const varyings = decls(text, 'in');
  // gl_FragCoord is the one built-in input a pass reads: a vec4 the case supplies per fragment (window position, pixel centers at +0.5).
  if (/\bgl_FragCoord\b/.test(text)) varyings.push({ type: 'vec4', name: 'gl_FragCoord', len: 0 });
  for (const u of uniforms)
    if (u.type !== 'sampler2D' && !TYPE_FLOATS[u.type])
      throw new Error(`fragEmu: uniform type ${u.type} (${u.name})`);
  const samplers = uniforms.filter((u) => u.type === 'sampler2D');
  const scalars = uniforms.filter((u) => u.type !== 'sampler2D');
  for (const u of scalars) u.floats = TYPE_FLOATS[u.type] * Math.max(1, u.len);
  const nU = scalars.reduce((s, u) => s + u.floats, 0);
  for (const v of varyings) v.floats = TYPE_FLOATS[v.type];
  const nV = varyings.reduce((s, v) => s + v.floats, 0);
  let body = glslToCpp(glslText, ['main']).replace(
    /\bdiscard\s*;/g,
    '{ g_discard = true; return; }',
  );
  count.forEach((fn, i) => {
    const re = new RegExp(`(\\b\\w+\\s+${fn}\\s*\\([^)]*\\)\\s*\\{)`);
    if (!re.test(body)) throw new Error(`fragEmu: no function ${fn} to count`);
    body = body.replace(re, `$1 g_cnt[${i}] = g_cnt[${i}] + 1;`);
  });
  const NC = count.length,
    STRIDE = 7 + NC;
  const decl = (u) => `${u.type} ${u.name}${u.len ? `[${u.len}]` : ''};`;
  const setter = (u, base) => {
    const n = TYPE_FLOATS[u.type],
      isInt = /^(int|ivec|bool|uint)/.test(u.type);
    const one = (dst, off) =>
      n === 1
        ? `${dst} = (${u.type})(${isInt ? '(int)' : ''}U[${off}]);`
        : `${dst} = ${u.type}(${Array.from({ length: n }, (_, k) => `${isInt ? '(int)' : ''}U[${off + k}]`).join(', ')});`;
    if (!u.len) return one(u.name, base);
    return Array.from({ length: u.len }, (_, i) => one(`${u.name}[${i}]`, base + i * n)).join(' ');
  };
  let off = 0;
  const setU = scalars
    .map((u) => {
      const s = setter(u, off);
      off += u.floats;
      return s;
    })
    .join('\n  ');
  let voff = 0;
  const setV = varyings
    .map((v) => {
      const n = v.floats;
      const s =
        n === 1
          ? `${v.name} = Q[${voff}];`
          : `${v.name} = ${v.type}(${Array.from({ length: n }, (_, k) => `Q[${voff + k}]`).join(', ')});`;
      voff += n;
      return s;
    })
    .join(' ');
  const header = vecHeader().replace(
    /struct sampler2D \{[\s\S]*?\n\}\n(?=\}\s*\/\/ namespace glsl)/,
    '',
  );
  const src = `${header.replace('}  // namespace glsl', EXTRA + '}  // namespace glsl')}
#include <cstdio>
#include <cstdlib>
#include <vector>
namespace glsl {
${scalars.map(decl).join('\n')}
${samplers.map((s) => `sampler2D ${s.name};`).join('\n')}
${varyings.map((v) => `${v.type} ${v.name};`).join('\n')}
vec4 fragColor;
bool g_discard = false;
int g_cnt[${Math.max(1, NC)}];
${body}
}
using namespace glsl;
int main(int argc, char** argv) {
  FILE* f = fopen(argv[1], "rb"); if (!f) return 2;
  int hdr[4]; if (fread(hdr, 4, 4, f) != 4) return 3;
  long nu = hdr[1], nt = hdr[2], nq = hdr[3];
  if (nu != ${nU} || nt != ${samplers.length}) return 5;
  std::vector<float> U((size_t)nu + 1);
  if (nu && fread(U.data(), 4, (size_t)nu, f) != (size_t)nu) return 4;
  std::vector<std::vector<float>> tex((size_t)nt);
  sampler2D* S[${Math.max(1, samplers.length)}] = { ${samplers.length ? samplers.map((s) => `&${s.name}`).join(', ') : 'nullptr'} };
  for (long t = 0; t < nt; t++) {
    int d[3]; if (fread(d, 4, 3, f) != 3) return 4;
    tex[t].resize((size_t)d[0] * d[1] * 4 + 4);
    if (fread(tex[t].data(), 4, (size_t)d[0] * d[1] * 4, f) != (size_t)d[0] * d[1] * 4) return 4;
    S[t]->data = tex[t].data(); S[t]->w = d[0]; S[t]->h = d[1]; S[t]->linear = d[2];
  }
  std::vector<float> Qs((size_t)nq * ${Math.max(1, nV)} + 1), out((size_t)nq * ${STRIDE} + 1);
  if (nq && fread(Qs.data(), 4, (size_t)nq * ${nV}, f) != (size_t)nq * ${nV}) return 4;
  fclose(f);
  ${setU}
  for (long i = 0; i < nq; i++) {
    const float* Q = Qs.data() + i * ${nV};
    ${setV}
    fragColor = vec4(0.0f); g_discard = false; g_nTexture = 0; g_nFetch = 0;
    for (int c = 0; c < ${Math.max(1, NC)}; c++) g_cnt[c] = 0;
    glsl::main();
    float* o = out.data() + i * ${STRIDE};
    o[0] = fragColor.x; o[1] = fragColor.y; o[2] = fragColor.z; o[3] = fragColor.w; o[4] = g_discard ? 1.0f : 0.0f;
    o[5] = (float)g_nTexture; o[6] = (float)g_nFetch;
    for (int c = 0; c < ${NC}; c++) o[7 + c] = (float)g_cnt[c];
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(out.data(), 4, (size_t)nq * ${STRIDE}, g); fclose(g);
  return 0;
}
`;
  const key = createHash('sha1')
    .update(C + '\0' + (contract ? 'fma\0' : '') + src)
    .digest('hex')
    .slice(0, 20);
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(CACHE, `frag_${key}`);
  if (!existsSync(exe)) {
    const cpp = `${exe}.${process.pid}.cpp`,
      tmpExe = `${exe}.${process.pid}.tmp`;
    writeFileSync(cpp, src);
    const r = spawnSync(C, ['-std=c++17', '-O1', ...fpFlags(contract), '-w', '-o', tmpExe, cpp], {
      encoding: 'utf8',
    });
    if (r.status !== 0)
      throw new Error(
        `fragEmu: compile failed (source kept at ${cpp}):\n` +
          (r.stderr || '').split('\n').slice(0, 30).join('\n'),
      );
    rmSync(cpp, { force: true });
    spawnSync('mv', ['-f', tmpExe, exe]);
  }
  return {
    exe,
    stride: STRIDE,
    uniforms: scalars.map((u) => u.name),
    samplers: samplers.map((s) => s.name),
    varyings: varyings.map((v) => v.name),
    /// Run every fragment in `frags` under one set of uniforms and textures. Returns `stride` floats per fragment
    /// (see the top of the file). A uniform left out is 0; a texture left out is empty (reads 0).
    run({ uniforms: uv = {}, textures = {}, frags = [] }) {
      for (const k of Object.keys(uv))
        if (!scalars.some((u) => u.name === k)) throw new Error(`fragEmu: no uniform ${k}`);
      for (const k of Object.keys(textures))
        if (!samplers.some((s) => s.name === k)) throw new Error(`fragEmu: no sampler ${k}`);
      const U = new Float32Array(nU);
      let o = 0;
      for (const u of scalars) {
        const v = uv[u.name];
        if (v !== undefined) {
          const a = typeof v === 'number' || typeof v === 'boolean' ? [+v] : Array.from(v);
          for (let k = 0; k < u.floats; k++) U[o + k] = a[k] || 0;
        }
        o += u.floats;
      }
      const texParts = samplers
        .map((s) => {
          const t = textures[s.name];
          const hd = new Int32Array([t ? t.w : 0, t ? t.h : 0, t && t.linear ? 1 : 0]);
          return [
            Buffer.from(hd.buffer),
            t ? Buffer.from(Float32Array.from(t.data).buffer) : Buffer.alloc(0),
          ];
        })
        .flat();
      const Q = new Float32Array(frags.length * nV);
      frags.forEach((fr, i) => {
        let k = 0;
        for (const v of varyings) {
          const a =
            fr[v.name] === undefined
              ? []
              : typeof fr[v.name] === 'number'
                ? [fr[v.name]]
                : fr[v.name];
          for (let c = 0; c < v.floats; c++) Q[i * nV + k + c] = a[c] || 0;
          k += v.floats;
        }
      });
      const hdr = new Int32Array([0x46524147, nU, samplers.length, frags.length]);
      const buf = Buffer.concat([
        Buffer.from(hdr.buffer),
        Buffer.from(U.buffer),
        ...texParts,
        Buffer.from(Q.buffer),
      ]);
      const job = path.join(CACHE, `fjob_${process.pid}_${Math.random().toString(36).slice(2)}`);
      writeFileSync(job + '.in', buf);
      const r = spawnSync(exe, [job + '.in', job + '.out'], { encoding: 'utf8' });
      rmSync(job + '.in', { force: true });
      if (r.status !== 0) throw new Error(`fragEmu: emulator exit ${r.status} ${r.stderr || ''}`);
      const ob = readFileSync(job + '.out');
      rmSync(job + '.out', { force: true });
      return new Float32Array(
        ob.buffer.slice(ob.byteOffset, ob.byteOffset + frags.length * STRIDE * 4),
      );
    },
  };
}

/// A shipped shader's assembled text.
export function generatedShader(root, file) {
  return readFileSync(path.join(root, 'src/shaders/generated', file), 'utf8');
}

/// Round one float channel to an 8-bit target the way a UNORM8 write does.
export const u8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);

const _emuCache = new Map();
function emuFor(root, file, count) {
  const key = file + '\0' + count.join(',');
  if (!_emuCache.has(key))
    _emuCache.set(key, buildFragEmu(readFileSync(path.join(root, file), 'utf8'), { count }));
  return _emuCache.get(key);
}
const texOf = (t) =>
  t.u8
    ? { w: t.w, h: t.h, linear: !!t.linear, data: Float32Array.from(t.u8, (v) => v / 255) }
    : { w: t.w, h: t.h, linear: !!t.linear, data: t.f32 };

/// Run one test/_filtperfCases.mjs case, both texts, on the CPU. Returns the comparison at float32 and at 8 bits,
/// and the per-fragment averages of the work each text did: { bits, ch8, ties, mx, off, work: { old, new } } where
/// work is { texture, texelFetch, calls: [...per counted function] }.
export function emulateCase(root, c) {
  const [W, H] = c.size;
  const count = c.count || [];
  const res = {};
  for (const side of ['old', 'new']) {
    const e = emuFor(root, c.frag[side], count);
    const io = c.inputs[side];
    // Varyings other than vUV are the vertex stage's outputs, constant across the pass (a flat tint);
    // the case supplies them as its own vertex stage would compute them.
    // A function gives them per fragment (a vertex stage that maps the quad's uv, interpolated).
    const frags = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const vary = typeof io.varyings === 'function' ? io.varyings(x, y, W, H) : io.varyings;
        frags.push(
          Object.assign(
            { vUV: [(x + 0.5) / W, (y + 0.5) / H], gl_FragCoord: [x + 0.5, y + 0.5, 0, 1] },
            vary || {},
          ),
        );
      }
    const textures = {};
    for (const k of Object.keys(io.textures || {})) textures[k] = texOf(io.textures[k]);
    // Only the fragment stage runs here: a uniform the case sets for its vertex stage is not the
    // fragment's to take -- but it must be the vertex stage's, or it is a typo.
    const vertUniforms = c.vert
      ? decls(stripComments(readFileSync(path.join(root, c.vert[side]), 'utf8')), 'uniform').map(
          (u) => u.name,
        )
      : [];
    const uniforms = {};
    for (const [k, v] of Object.entries(io.uniforms || {})) {
      if (e.uniforms.includes(k)) uniforms[k] = v;
      else if (!vertUniforms.includes(k))
        throw new Error(`fragEmu: ${c.name} ${side}: no uniform ${k} in either stage`);
    }
    res[side] = { out: e.run({ uniforms, textures, frags }), st: e.stride };
  }
  const a = res.old.out,
    b = res.new.out,
    sa = res.old.st,
    sb = res.new.st;
  const lsb = c.tol && typeof c.tol === 'object' ? c.tol.lsb : Infinity;
  let bits = 0,
    ch8 = 0,
    ties = 0,
    mx = 0,
    off = null,
    outliers = 0;
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 4; k++) {
      const x = a[i * sa + k],
        y = b[i * sb + k];
      if (Math.fround(x) !== Math.fround(y) && !(Number.isNaN(x) && Number.isNaN(y))) bits++;
      const d = Math.abs(u8(x) - u8(y));
      if (!d) continue;
      ch8++;
      if (d > mx) mx = d;
      if (d > lsb) outliers++;
      const px = i % W,
        py = (i / W) | 0;
      if (c.tol === 'ties' && d === 1 && c.exact && onTieExact(c.exact(px, py, k))) ties++;
      else if (!off) off = { x: px, y: py, c: k, old: u8(x), new: u8(y) };
    }
  }
  const work = (o, st) => {
    const sum = (j) => {
      let n = 0;
      for (let i = 0; i < W * H; i++) n += o[i * st + j];
      return n / (W * H);
    };
    return { texture: sum(5), texelFetch: sum(6), calls: count.map((_, j) => sum(7 + j)) };
  };
  return {
    bits,
    ch8,
    ties,
    mx,
    off,
    outliers,
    n: W * H,
    work: { old: work(a, sa), new: work(b, sb) },
  };
}
const onTieExact = (v) => {
  const x = Math.min(1, Math.max(0, v)) * 255;
  return Math.abs(x - Math.floor(x) - 0.5) < 1e-3;
};

/// Does a comparison meet its case's tolerance? tol 0: identical at 8 bits; 'ties': apart only by 1 LSB at exact
/// rounding ties; n: at most n LSB; { lsb, outliers }: at most lsb LSB but for that fraction of the channels.
export function meetsTol(c, r) {
  if (c.tol === 'ties') return r.ch8 === r.ties;
  if (c.tol && typeof c.tol === 'object') return r.outliers <= c.tol.outliers * r.n * 4;
  return r.mx <= (c.tol | 0);
}
