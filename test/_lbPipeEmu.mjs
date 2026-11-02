// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbPipeEmu.mjs -- the unified fill draw (Loop-Blinn meshes and cover quads) on the CPU, end to end, from the generated
// shader text: the vertex stage per vertex, a rasterizer, and the fragment stage per fragment with REAL 2x2-quad
// derivatives. test/_glslMainEmu.mjs lifts one fragment main() and hands it fixed derivatives; this runs the pipeline a
// draw runs, so a question about what the GPU draws can be asked of the shader itself.
//
// What it models, and how:
//   * VERTEX: mantle.vert's main() per vertex, from the unified stream's attributes (unifiedFillVerts.js), with every
//     `out` and gl_Position written back.
//   * RASTER: gl_Position through the viewport (window y up). A pixel belongs to a triangle when its CENTER is inside,
//     with the top-left rule in a top-down frame -- the same rule probes/lbAccuracy/_lbRaster.mjs uses, so the two
//     agree on ties. No subpixel snapping by default (the knife-edge set, _lbRaster fragileMask, covers it); buildFrag's
//     `snap` rounds window positions to a 1/snap grid first, as a GPU does.
//   * VARYINGS: smooth ones affine over the triangle (barycentrics at the pixel center in double, interpolated in
//     float32); `flat` ones and int ones from the LAST vertex (GL's provoking convention).
//   * DERIVATIVES (buildFrag's `coarse` picks the other convention; which one a GPU uses is its own choice):
//     dFdx / dFdy / fwidth run the quad partner. Each derivative call has an index; at call k the partner
//     pixel (i^1 or j^1, window coordinates) is re-run from its own interpolated inputs up to ITS call k and the
//     difference taken, signed as a fine derivative (odd minus even). Earlier calls are memoized per fragment. A
//     partner outside the triangle is a helper and is extrapolated from the same plane, as on a GPU.
//   * FRAGMENT: main() in float32 (C++ compiled with -ffp-contract=off, or fused with `contract`), `discard` a throw.
// Every fragment is returned, discarded or not: [triangle, x, row (top-down), r, g, b, a, discarded, flags]. The
// compositing is the caller's (OVER, a depth claim, ...), which is the point: that is one of the things to ask about.
//
// A text may call LBPIPE_COUNT(i) (i < 64, returns true) and LBPIPE_FLAG(b) (sets bit b of the fragment's flags) to
// count branches; probe re-runs are not counted.
//
// Needs a C++17 compiler and clang (for the preprocessor), as _glslMainEmu.mjs. Executables are cached by source hash
// in os.tmpdir()/mantle-lbpipe.
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import { glslToCpp, cxx, fpFlags, emuContractDefault } from './_glslEmu.mjs';
import {
  preprocessGlsl,
  PRELUDE_CORE,
  header,
  assign,
  CTYPE,
  SAMPLERS,
  hasMainEmu,
} from './_glslMainEmu.mjs';

export const hasLbPipeEmu = hasMainEmu;
const CACHE = path.join(os.tmpdir(), 'mantle-lbpipe');
const names = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/// Uniforms, vertex attributes, stage inputs and stage outputs of a PREPROCESSED text, in declaration order.
export function parseIO(pre) {
  const uniforms = [],
    ins = [],
    outs = [],
    attribs = [];
  let m;
  const ru = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\w\s,]+?)\s*;/gm;
  while ((m = ru.exec(pre))) for (const n of names(m[2])) uniforms.push({ type: m[1], name: n });
  const ra =
    /^\s*layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm;
  while ((m = ra.exec(pre))) attribs.push({ loc: +m[1], type: m[2], name: m[3] });
  const ri =
    /^\s*(flat\s+|smooth\s+|centroid\s+)?in\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\w\s,]+?)\s*;/gm;
  while ((m = ri.exec(pre)))
    for (const n of names(m[3]))
      ins.push({ type: m[2], name: n, flat: /flat/.test(m[1] || '') || /^[iu]/.test(m[2]) });
  const ro =
    /^\s*(flat\s+|smooth\s+|centroid\s+)?out\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\w\s,]+?)\s*;/gm;
  while ((m = ro.exec(pre)))
    for (const n of names(m[3]))
      outs.push({ type: m[2], name: n, flat: /flat/.test(m[1] || '') || /^[iu]/.test(m[2]) });
  return { uniforms, ins, outs, attribs };
}

/// The stage's main() renamed, `discard` a throw, and the swizzle writes the translator cannot express rewritten.
function stageBody(pre, fn) {
  if (!/void\s+main\s*\(\s*\)\s*\{/.test(pre)) throw new Error('lbPipeEmu: no main() in the text');
  const t = pre
    .replace(/void\s+main\s*\(\s*\)\s*\{/, `void ${fn}() {`)
    .replace(/\bdiscard\s*;/g, 'throw 1;')
    .replace(
      /(\b[A-Za-z_]\w*)\.rgb\s*=(?!=)\s*([^;]+);/g,
      (_, v, e) => `${v} = vec4(${e}, ${v}.a);`,
    )
    .replace(
      /(\b[A-Za-z_]\w*)\.xy\s*=(?!=)\s*([^;]+);/g,
      (_, v, e) => `${v} = __setxy(${v}, ${e});`,
    );
  return glslToCpp(t, [fn]);
}

function setters(uniforms) {
  const out = [];
  let nu = 0;
  for (const u of uniforms) {
    if (SAMPLERS.has(u.type)) {
      const bind =
        u.type === 'sampler2D'
          ? `${u.name}.data = TX[ti].data; ${u.name}.texels = (long)TX[ti].w * TX[ti].h * TX[ti].l; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h * TX[ti].l;`
          : u.type === 'isampler2D'
            ? `${u.name}.data = TX[ti].data; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h;`
            : `${u.name}.data = TX[ti].data; ${u.name}.w = TX[ti].w; ${u.name}.h = TX[ti].h; ${u.name}.layers = TX[ti].l;`;
      out.push(`{ int ti = (int)U[${nu}]; if (ti >= 0 && ti < nTex) { ${bind} } }`);
      nu += 1;
    } else {
      if (!CTYPE[u.type]) throw new Error('lbPipeEmu: uniform type ' + u.type);
      out.push(assign(u, 'U', nu));
      nu += CTYPE[u.type];
    }
  }
  return { code: out, nu };
}

const READ_COMMON = `
struct Tex { const float* data; int w, h, l; };
static FILE* F_IN; static Tex* TX; static int nTex; static float* U;
static void rd(void* p, size_t n) { if (fread(p, 1, n, F_IN) != n) { fprintf(stderr, "short read\\n"); exit(4); } }
static void readTexUni(int nUexp) {
  int hdr[2]; rd(hdr, 8); nTex = hdr[0]; int nU = hdr[1];
  if (nU != nUexp) { fprintf(stderr, "uniform count %d != %d\\n", nU, nUexp); exit(5); }
  TX = (Tex*)calloc(nTex + 1, sizeof(Tex));
  for (int t = 0; t < nTex; t++) { int d[3]; rd(d, 12); size_t n = (size_t)d[0] * d[1] * d[2] * 4;
    float* p = (float*)malloc(4 * (n + 4)); rd(p, 4 * n); TX[t] = { p, d[0], d[1], d[2] }; }
  U = (float*)malloc(4 * ((size_t)nU + 1)); rd(U, 4 * (size_t)nU);
}`;

function writeOut(d, arr, o) {
  const n = CTYPE[d.type];
  if (!n || /^mat/.test(d.type)) throw new Error('lbPipeEmu: out type ' + d.type);
  if (n === 1) return `${arr}[${o}] = (float)${d.name};`;
  return Array.from({ length: n }, (_, k) => `${arr}[${o + k}] = (float)${d.name}[${k}];`).join(
    ' ',
  );
}

function compile(src, tag, opt = '-O2', contract = emuContractDefault()) {
  const C = cxx();
  if (!C || !hasMainEmu()) throw new Error('lbPipeEmu: needs a C++17 compiler and clang');
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(
    CACHE,
    `${tag}_${createHash('sha1')
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
        `lbPipeEmu: compile failed (source kept at ${cpp}):\n` +
          (r.stderr || '').split('\n').slice(0, 40).join('\n'),
      );
    rmSync(cpp, { force: true });
    spawnSync('mv', ['-f', tmp, exe]);
  }
  return exe;
}

function texUniParts(uniforms, textures, values) {
  const U = [];
  for (const u of uniforms) {
    const v = values.get(u.name);
    if (SAMPLERS.has(u.type)) {
      U.push(v == null ? -1 : v);
      continue;
    }
    for (let k = 0; k < CTYPE[u.type]; k++)
      U.push(v == null ? 0 : Array.isArray(v) || ArrayBuffer.isView(v) ? (v[k] ?? 0) : v);
  }
  const parts = [];
  const hdr = Buffer.alloc(8);
  hdr.writeInt32LE(textures.length, 0);
  hdr.writeInt32LE(U.length, 4);
  parts.push(hdr);
  for (const t of textures) {
    const d = Buffer.alloc(12);
    d.writeInt32LE(t.w, 0);
    d.writeInt32LE(t.h, 4);
    d.writeInt32LE(t.l, 8);
    parts.push(d);
    const n = t.w * t.h * t.l * 4;
    let s = t.data;
    if (s.length !== n) {
      const z = new Float32Array(n);
      z.set(s.subarray(0, Math.min(n, s.length)));
      s = z;
    }
    parts.push(Buffer.from(s.buffer, s.byteOffset, n * 4));
  }
  parts.push(Buffer.from(new Float32Array(U).buffer));
  return parts;
}

function runExe(exe, parts) {
  mkdirSync(CACHE, { recursive: true });
  const job = path.join(CACHE, `job_${process.pid}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(job + '.in', Buffer.concat(parts));
  const r = spawnSync(exe, [job + '.in', job + '.out'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout: 1800000,
  });
  rmSync(job + '.in', { force: true });
  if (r.status !== 0)
    throw new Error(
      `lbPipeEmu: exit ${r.status} ${r.signal || ''} ${(r.stderr || '').slice(0, 2000)}`,
    );
  const ob = readFileSync(job + '.out');
  rmSync(job + '.out', { force: true });
  return {
    out: new Float32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + ob.length)),
    stderr: r.stderr || '',
  };
}

// ---- the VERTEX stage --------------------------------------------------------------------------------------------------
/// Compile mantle.vert (generated text) under `defines`.
export function buildVert(vertText, defines, { contract = emuContractDefault() } = {}) {
  const pre = preprocessGlsl(vertText, defines);
  const io = parseIO(pre);
  const body = stageBody(pre, 'vertMain');
  const { code: set, nu } = setters(io.uniforms);
  let outN = 4;
  const outOff = [];
  for (const o of io.outs) {
    outOff.push(outN);
    outN += CTYPE[o.type];
  }
  const attrSet = io.attribs.map((a) => {
    const n = CTYPE[a.type],
      c = (k) => `A[${a.loc * 4 + k}]`;
    if (n === 1) return a.type === 'int' ? `${a.name} = (int)${c(0)};` : `${a.name} = ${c(0)};`;
    return `${a.name} = ${a.type}(${Array.from({ length: n }, (_, k) => c(k)).join(', ')});`;
  });
  const src = `${header()}
#include <cstdio>
#include <cstdlib>
${PRELUDE_CORE}
namespace glsl {
vec4 gl_Position;
${[...io.uniforms, ...io.outs].map((d) => `${d.type} ${d.name};`).join('\n')}
${io.attribs.map((a) => `${a.type} ${a.name};`).join('\n')}
${body}
}
using namespace glsl;
${READ_COMMON}
int main(int argc, char** argv) {
  F_IN = fopen(argv[1], "rb"); if (!F_IN) return 2;
  readTexUni(${nu});
  ${set.join('\n  ')}
  int nv; rd(&nv, 4);
  float* AA = (float*)malloc(4 * ((size_t)nv * 64 + 4)); rd(AA, 4 * (size_t)nv * 64);
  fclose(F_IN);
  float* O = (float*)malloc(4 * ${outN} * ((size_t)nv + 1));
  for (long v = 0; v < nv; v++) {
    const float* A = AA + v * 64;
    ${attrSet.join('\n    ')}
    gl_Position = vec4(0.0f);
    ${io.outs.map((d) => `${d.name} = ${d.type}(${CTYPE[d.type] === 1 ? '0' : '0.0f'});`).join('\n    ')}
    vertMain();
    float* o = O + v * ${outN};
    o[0] = gl_Position.x; o[1] = gl_Position.y; o[2] = gl_Position.z; o[3] = gl_Position.w;
    ${io.outs.map((d, i) => writeOut(d, 'o', outOff[i])).join('\n    ')}
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(O, 4, (size_t)nv * ${outN}, g); fclose(g);
  return 0;
}
`;
  return { exe: compile(src, 'vert', '-O2', contract), io, outN, outOff, nu };
}

/// attrs: Float32Array(nv * 64) -- 16 locations x 4 components per vertex (unused components 0, w 1 by convention).
export function runVert(v, textures, uniforms, attrs, nv) {
  const parts = texUniParts(v.io.uniforms, textures, uniforms);
  const n = Buffer.alloc(4);
  n.writeInt32LE(nv, 0);
  parts.push(n);
  parts.push(Buffer.from(attrs.buffer, attrs.byteOffset, nv * 64 * 4));
  return runExe(v.exe, parts).out;
}

// ---- ALU COUNTING (buildFrag's `alu`) -----------------------------------------------------------------------------------
// The shader's own float arithmetic, counted per fragment: every float of the text becomes `aluf`, a float that counts
// each operation it takes part in, so the count is of the TEXT as it runs, branch by branch, not an estimate. Two
// tallies: g_alu, the full-rate operations (add, mul, compare, floor...; a mix or clamp counts as the operations it is
// written with, and negation and abs are free, as source modifiers on a GPU), and g_aluT, the ones a GPU sends to its
// transcendental unit (sqrt, the reciprocal a division takes, sin, cos, acos, exp, log; pow counts two). Integer
// arithmetic, branches, derivatives (the quad partner's re-run is not counted) and texture fetches are not counted.
// A fragment's record carries g_alu + 65536 g_aluT in its flags slot (each capped), in place of LBPIPE_FLAG's bits.
const ALU_PRELUDE = `#include <cmath>
#include <cstring>
static long g_alu = 0, g_aluT = 0; static bool g_aluOn = true;
#define ALU_1 (g_aluOn ? (void)++g_alu : (void)0)
#define ALU_T (g_aluOn ? (void)++g_aluT : (void)0)
struct aluf {
  float v;
  aluf() : v(0.0f) {}
  aluf(float x) : v(x) {} aluf(double x) : v((float)x) {} aluf(int x) : v((float)x) {} aluf(unsigned x) : v((float)x) {}
  aluf(long x) : v((float)x) {} aluf(unsigned long x) : v((float)x) {}
  explicit operator float() const { return v; } explicit operator double() const { return v; }
  explicit operator int() const { return (int)v; } explicit operator unsigned() const { return (unsigned)v; }
  aluf& operator+=(const aluf& b) { ALU_1; v = v + b.v; return *this; } aluf& operator-=(const aluf& b) { ALU_1; v = v - b.v; return *this; }
  aluf& operator*=(const aluf& b) { ALU_1; v = v * b.v; return *this; } aluf& operator/=(const aluf& b) { ALU_1; ALU_T; v = v / b.v; return *this; }
};
inline aluf operator+(aluf a, aluf b) { ALU_1; return aluf(a.v + b.v); } inline aluf operator-(aluf a, aluf b) { ALU_1; return aluf(a.v - b.v); }
inline aluf operator*(aluf a, aluf b) { ALU_1; return aluf(a.v * b.v); } inline aluf operator/(aluf a, aluf b) { ALU_1; ALU_T; return aluf(a.v / b.v); }
inline aluf operator-(aluf a) { return aluf(-a.v); }
inline bool operator<(aluf a, aluf b) { ALU_1; return a.v < b.v; } inline bool operator>(aluf a, aluf b) { ALU_1; return a.v > b.v; }
inline bool operator<=(aluf a, aluf b) { ALU_1; return a.v <= b.v; } inline bool operator>=(aluf a, aluf b) { ALU_1; return a.v >= b.v; }
inline bool operator==(aluf a, aluf b) { ALU_1; return a.v == b.v; } inline bool operator!=(aluf a, aluf b) { ALU_1; return a.v != b.v; }
namespace alufstd {
using std::memcpy; using std::ldexp; using std::floor; using std::ceil; using std::trunc; using std::round; using std::fabs;
using std::sqrt; using std::sin; using std::cos; using std::tan; using std::asin; using std::acos; using std::atan; using std::atan2;
using std::exp; using std::log; using std::pow; using std::isinf; using std::isnan; using std::enable_if;
inline aluf floor(aluf x) { ALU_1; return aluf(std::floor(x.v)); } inline aluf ceil(aluf x) { ALU_1; return aluf(std::ceil(x.v)); }
inline aluf trunc(aluf x) { ALU_1; return aluf(std::trunc(x.v)); } inline aluf round(aluf x) { ALU_1; return aluf(std::round(x.v)); }
inline aluf fabs(aluf x) { return aluf(std::fabs(x.v)); }
inline aluf sqrt(aluf x) { ALU_T; return aluf(std::sqrt(x.v)); } inline aluf sin(aluf x) { ALU_T; return aluf(std::sin(x.v)); }
inline aluf cos(aluf x) { ALU_T; return aluf(std::cos(x.v)); } inline aluf tan(aluf x) { ALU_T; return aluf(std::tan(x.v)); }
inline aluf asin(aluf x) { ALU_T; return aluf(std::asin(x.v)); } inline aluf acos(aluf x) { ALU_T; return aluf(std::acos(x.v)); }
inline aluf atan(aluf x) { ALU_T; return aluf(std::atan(x.v)); } inline aluf atan2(aluf y, aluf x) { ALU_T; return aluf(std::atan2(y.v, x.v)); }
inline aluf exp(aluf x) { ALU_T; return aluf(std::exp(x.v)); } inline aluf log(aluf x) { ALU_T; return aluf(std::log(x.v)); }
inline aluf pow(aluf x, aluf y) { ALU_T; ALU_T; ALU_1; return aluf(std::pow(x.v, y.v)); }
inline aluf ldexp(aluf x, int e) { return aluf(std::ldexp(x.v, e)); }
inline bool isinf(aluf x) { return std::isinf(x.v); } inline bool isnan(aluf x) { return std::isnan(x.v); }
}
`;
// A vector of aluf against a float literal: the header's templates deduce one scalar type from both sides.
const ALU_VEC = `
namespace glsl {
#define ALUF_VBIN(OP) \\
template<int N> inline V<aluf,N> operator OP(const V<aluf,N>& a, float b) { return a OP aluf(b); } \\
template<int N> inline V<aluf,N> operator OP(float a, const V<aluf,N>& b) { return aluf(a) OP b; } \\
template<int N> inline V<aluf,N>& operator OP##=(V<aluf,N>& a, float b) { return a OP##= aluf(b); }
ALUF_VBIN(+) ALUF_VBIN(-) ALUF_VBIN(*) ALUF_VBIN(/)
template<int N> inline V<aluf,N> min(const V<aluf,N>& a, float b) { return min(a, aluf(b)); }
template<int N> inline V<aluf,N> max(const V<aluf,N>& a, float b) { return max(a, aluf(b)); }
template<int N> inline V<aluf,N> clamp(const V<aluf,N>& x, float a, float b) { return clamp(x, aluf(a), aluf(b)); }
}
`;
function aluSource(src) {
  const rep = (s, from, to) => {
    if (!s.includes(from)) throw new Error('lbPipeEmu alu: hinge not found: ' + from.slice(0, 80));
    return s.split(from).join(to);
  };
  // The header and PRELUDE_CORE end where the stage's globals begin.
  const cut = src.indexOf('namespace glsl {\nvec4 gl_FragCoord;');
  if (cut < 0) throw new Error('lbPipeEmu alu: the stage globals were not found');
  let head = src.slice(0, cut),
    rest = src.slice(cut);
  head = head.replace(/\bfloat\b(?!\s*\*)/g, 'aluf').replace(/\bstd::/g, 'alufstd::');
  head = ALU_PRELUDE + head + ALU_VEC;
  // The stage: every float the text declares, but not the harness's float buffers.
  const bodyStart = rest.indexOf('// ---- derivatives:');
  const decls = rest.slice(0, bodyStart).replace(/\bfloat\b/g, 'aluf');
  rest = decls + rest.slice(bodyStart);
  rest = rep(
    rest,
    'template<> struct Lanes<float> { static void to(const float& v, float* a) { a[0] = v; a[1] = a[2] = a[3] = 0; } static float from(const float* a) { return a[0]; } };',
    'template<> struct Lanes<aluf> { static void to(const aluf& v, float* a) { a[0] = v.v; a[1] = a[2] = a[3] = 0; } static aluf from(const float* a) { return aluf(a[0]); } };',
  );
  rest = rep(
    rest,
    'template<int N> struct Lanes<V<float,N>> { static void to(const V<float,N>& v, float* a) { for (int i = 0; i < 4; i++) a[i] = i < N ? v[i] : 0.0f; }',
    'template<int N> struct Lanes<V<aluf,N>> { static void to(const V<aluf,N>& v, float* a) { for (int i = 0; i < 4; i++) a[i] = i < N ? v[i].v : 0.0f; }',
  );
  rest = rep(
    rest,
    '  static V<float,N> from(const float* a) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = a[i]; return r; } };',
    '  static V<aluf,N> from(const float* a) { V<aluf,N> r; for (int i = 0; i < N; i++) r[i] = aluf(a[i]); return r; } };',
  );
  rest = rep(
    rest,
    'inline float dFdx(float v) { return derivCall(v, 0); } inline float dFdy(float v) { return derivCall(v, 1); } inline float fwidth(float v) { return derivCall(v, 2); }',
    'inline aluf dFdx(aluf v) { return derivCall(v, 0); } inline aluf dFdy(aluf v) { return derivCall(v, 1); } inline aluf fwidth(aluf v) { return derivCall(v, 2); }',
  );
  for (const f of ['dFdx', 'dFdy', 'fwidth'])
    rest = rep(
      rest,
      `template<int N> inline V<float,N> ${f}(const V<float,N>& v)`,
      `template<int N> inline V<aluf,N> ${f}(const V<aluf,N>& v)`,
    );
  rest = rep(rest, 'g_probeTarget = k; g_dc = 0;', 'g_probeTarget = k; g_dc = 0; g_aluOn = false;');
  rest = rep(
    rest,
    'g_probeTarget = -1; g_dc = dc;',
    'g_probeTarget = -1; g_aluOn = true; g_dc = dc;',
  );
  // The shader's text, from the derivative helpers on to the raster context: its floats are counted.
  const b0 = rest.indexOf('\n', rest.indexOf('template<int N> inline V<aluf,N> fwidth(')) + 1,
    b1 = rest.indexOf('// ---- raster context ----');
  if (b0 <= 0 || b1 < 0) throw new Error('lbPipeEmu alu: the stage body was not found');
  rest = rest.slice(0, b0) + rest.slice(b0, b1).replace(/\bfloat\b/g, 'aluf') + rest.slice(b1);
  rest = rep(
    rest,
    'memset(g_has, 0, sizeof g_has); g_fragFlags = 0;',
    'memset(g_has, 0, sizeof g_has); g_fragFlags = 0; g_alu = 0; g_aluT = 0;',
  );
  rest = rep(
    rest,
    'rec[3] = fragColor.x; rec[4] = fragColor.y; rec[5] = fragColor.z; rec[6] = fragColor.w;',
    'rec[3] = (float)fragColor.x; rec[4] = (float)fragColor.y; rec[5] = (float)fragColor.z; rec[6] = (float)fragColor.w;',
  );
  rest = rep(
    rest,
    'rec[8] = (float)g_fragFlags;',
    'rec[8] = (float)(g_alu < 65535 ? g_alu : 65535) + 65536.0f * (float)(g_aluT < 255 ? g_aluT : 255);',
  );
  return head + rest;
}

// ---- the FRAGMENT stage, behind the rasterizer --------------------------------------------------------------------------
/// Compile mantle.frag (generated text) under `defines`, with the rasterizer in front of it.
export function buildFrag(
  fragText,
  defines,
  { coarse = false, snap = 0, contract = emuContractDefault(), alu = false, tie = 'topleft' } = {},
) {
  const pre = preprocessGlsl(fragText, defines);
  const io = parseIO(pre);
  const body = stageBody(pre, 'fragMain');
  const { code: set, nu } = setters(io.uniforms);
  let inN = 0;
  const inOff = [];
  for (const d of io.ins) {
    inOff.push(inN);
    inN += CTYPE[d.type];
  }
  const flatMask = [];
  io.ins.forEach((d) => {
    for (let k = 0; k < CTYPE[d.type]; k++) flatMask.push(d.flat ? 1 : 0);
  });
  const src = `${header()}
#include <cstdio>
#include <cstdlib>
${coarse ? '#define LBPIPE_COARSE 1' : ''}
${snap ? `#define LBPIPE_SNAP ${snap}.0` : ''}
${tie === 'bottomright' ? '#define LBPIPE_TIE_BR 1' : ''}
${PRELUDE_CORE}
namespace glsl {
vec4 gl_FragCoord; vec4 fragColor;
${io.uniforms.map((d) => `${d.type} ${d.name};`).join('\n')}
${io.ins.map((d) => `${d.type} ${d.name};`).join('\n')}
long g_counters[64];
unsigned g_fragFlags = 0;
void fragMain();
// ---- derivatives: re-run the quad partner up to the same call ----
struct ProbeDone {};
int g_dc = 0, g_probeTarget = -1; float g_probeOut[4];
#define LBPIPE_COUNT(i) (g_probeTarget < 0 ? (g_counters[(i)]++, true) : true)
#define LBPIPE_FLAG(b) (g_probeTarget < 0 ? ((g_fragFlags |= (1u << (b))), true) : true)
float g_memo[2][128][4]; unsigned char g_has[128];
int g_pi, g_pj;
void setInputsAt(int i, int j);
template<class T> struct Lanes;
template<> struct Lanes<float> { static void to(const float& v, float* a) { a[0] = v; a[1] = a[2] = a[3] = 0; } static float from(const float* a) { return a[0]; } };
template<int N> struct Lanes<V<float,N>> { static void to(const V<float,N>& v, float* a) { for (int i = 0; i < 4; i++) a[i] = i < N ? v[i] : 0.0f; }
  static V<float,N> from(const float* a) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = a[i]; return r; } };
static bool probeAt(int k, int pi, int pj, float* out) {
  int dc = g_dc; vec4 fc = fragColor, fcd = gl_FragCoord;
  setInputsAt(pi, pj);
  g_probeTarget = k; g_dc = 0;
  bool ok = false;
  try { fragMain(); } catch (ProbeDone&) { memcpy(out, g_probeOut, 16); ok = true; } catch (int) {}
  g_probeTarget = -1; g_dc = dc; fragColor = fc;
  setInputsAt(g_pi, g_pj); gl_FragCoord = fcd;
  return ok;
}
// axis 0 = dFdx, 1 = dFdy, 2 = fwidth. Fine derivatives, odd minus even, in window coordinates (y up).
template<class T> T derivCall(const T& v, int axis) {
  int k = g_dc++;
  float self[4]; Lanes<T>::to(v, self);
  if (g_probeTarget >= 0) {
    if (k == g_probeTarget) { memcpy(g_probeOut, self, 16); throw ProbeDone(); }
    if (k >= 128 || !g_has[k]) return Lanes<T>::from(self) * 0.0f;
    float r[4]; for (int c = 0; c < 4; c++) r[c] = axis == 0 ? g_memo[0][k][c] : axis == 1 ? g_memo[1][k][c] : std::fabs(g_memo[0][k][c]) + std::fabs(g_memo[1][k][c]);
    return Lanes<T>::from(r);
  }
  float dx[4] = {0, 0, 0, 0}, dy[4] = {0, 0, 0, 0}, p[4];
#ifndef LBPIPE_COARSE
  if (probeAt(k, g_pi ^ 1, g_pj, p)) { float s = (g_pi & 1) ? -1.0f : 1.0f; for (int c = 0; c < 4; c++) dx[c] = s * (p[c] - self[c]); }
  if (probeAt(k, g_pi, g_pj ^ 1, p)) { float s = (g_pj & 1) ? -1.0f : 1.0f; for (int c = 0; c < 4; c++) dy[c] = s * (p[c] - self[c]); }
#else
  // COARSE: one difference per quad, taken at its top-left pixel in the IMAGE (top-down) -- window row j|1 on an
  // even-height target, column i&~1 -- for all four lanes.
  { int qi = g_pi & ~1, jt = g_pj | 1, jb = jt - 1;
    float a[4], b[4], c4[4];
    auto at = [&](int pi, int pj, float* o) { if (pi == g_pi && pj == g_pj) { memcpy(o, self, 16); return true; } return probeAt(k, pi, pj, o); };
    bool oa = at(qi, jt, a), ob = at(qi + 1, jt, b), oc = at(qi, jb, c4);
    if (oa && ob) for (int c = 0; c < 4; c++) dx[c] = b[c] - a[c];
    if (oa && oc) for (int c = 0; c < 4; c++) dy[c] = a[c] - c4[c]; }
#endif
  if (k < 128) { g_has[k] = 1; for (int c = 0; c < 4; c++) { g_memo[0][k][c] = dx[c]; g_memo[1][k][c] = dy[c]; } }
  float r[4]; for (int c = 0; c < 4; c++) r[c] = axis == 0 ? dx[c] : axis == 1 ? dy[c] : std::fabs(dx[c]) + std::fabs(dy[c]);
  return Lanes<T>::from(r);
}
inline float dFdx(float v) { return derivCall(v, 0); } inline float dFdy(float v) { return derivCall(v, 1); } inline float fwidth(float v) { return derivCall(v, 2); }
template<int N> inline V<float,N> dFdx(const V<float,N>& v) { return derivCall(v, 0); }
template<int N> inline V<float,N> dFdy(const V<float,N>& v) { return derivCall(v, 1); }
template<int N> inline V<float,N> fwidth(const V<float,N>& v) { return derivCall(v, 2); }
${body}
// ---- raster context ----
static const float* g_tri[3]; static double g_wx[3], g_wy[3], g_area;
static const int IN_N = ${inN};
static const unsigned char FLAT[${Math.max(1, inN)}] = {${flatMask.length ? flatMask.join(',') : '0'}};
static float g_in[${Math.max(1, inN)}];
void setInputsAt(int i, int j) {
  double px = i + 0.5, py = j + 0.5;
  double l0 = ((g_wx[1] - px) * (g_wy[2] - py) - (g_wy[1] - py) * (g_wx[2] - px)) / g_area;
  double l1 = ((g_wx[2] - px) * (g_wy[0] - py) - (g_wy[2] - py) * (g_wx[0] - px)) / g_area;
  double l2 = 1.0 - l0 - l1;
  for (int c = 0; c < IN_N; c++) g_in[c] = FLAT[c] ? g_tri[2][4 + c] : (float)(l0 * g_tri[0][4 + c] + l1 * g_tri[1][4 + c] + l2 * g_tri[2][4 + c]);
  const float* F = g_in;
  ${io.ins.map((d, i) => assign(d, 'F', inOff[i])).join('\n  ')}
  gl_FragCoord = vec4((float)px, (float)py, 0.5f, 1.0f);
}
}
using namespace glsl;
${READ_COMMON}
// The top-left rule in a TOP-DOWN frame (x right, y down, pixel centres at integers), as _lbRaster.mjs states it
// (buildFrag's tie: 'bottomright' takes the other one).
static bool topLeft(double ax, double ay, double bx, double by) { return (ay == by) ? (bx < ax) : (by < ay); }
static bool edgeAccept(double ax, double ay, double bx, double by, double px, double py, bool tl) {
  double e = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
#ifdef LBPIPE_TIE_BR
  // The other watertight convention (bottom-right): GL leaves the tie rule to the implementation, and a pixel centre
  // exactly on a shared edge goes to the OTHER primitive under it -- a kernel must be right for either owner.
  return e > 0 || (e == 0 && !tl);
#else
  return e > 0 || (e == 0 && tl);
#endif
}
int main(int argc, char** argv) {
  F_IN = fopen(argv[1], "rb"); if (!F_IN) return 2;
  readTexUni(${nu});
  ${set.join('\n  ')}
  int hd[7]; rd(hd, 28); int W = hd[0], H = hd[1], nTri = hd[2];
  int sx0 = hd[3], sr0 = hd[4], sx1 = hd[5], sr1 = hd[6];   // the scissor, inclusive, top-down rows
  const int R = 4 + IN_N;
  float* T = (float*)malloc(4 * ((size_t)R * 3 * nTri + 4)); rd(T, 4 * (size_t)R * 3 * nTri);
  fclose(F_IN);
  FILE* g = fopen(argv[2], "wb");
  float rec[9];
  for (int t = 0; t < nTri; t++) {
    double X[3], Y[3];
    for (int k = 0; k < 3; k++) {
      const float* v = T + ((size_t)t * 3 + k) * R;
      g_tri[k] = v;
      double w = v[3];
      g_wx[k] = ((double)v[0] / w + 1.0) * 0.5 * W;
      g_wy[k] = ((double)v[1] / w + 1.0) * 0.5 * H;
#ifdef LBPIPE_SNAP
      // A GPU's vertex snap: window positions onto a 1/LBPIPE_SNAP subpixel grid before the edge functions and the
      // attribute planes are set up (the attribute VALUES are not moved).
      g_wx[k] = std::round(g_wx[k] * LBPIPE_SNAP) / LBPIPE_SNAP;
      g_wy[k] = std::round(g_wy[k] * LBPIPE_SNAP) / LBPIPE_SNAP;
#endif
      X[k] = g_wx[k] - 0.5; Y[k] = (H - g_wy[k]) - 0.5;
    }
    g_area = (g_wx[1] - g_wx[0]) * (g_wy[2] - g_wy[0]) - (g_wy[1] - g_wy[0]) * (g_wx[2] - g_wx[0]);
    if (!(std::fabs(g_area) > 1e-12)) continue;
    // Orient counterclockwise in the top-down frame (positive edge functions inside).
    int o0 = 0, o1 = 1, o2 = 2;
    if ((X[1] - X[0]) * (Y[2] - Y[0]) - (Y[1] - Y[0]) * (X[2] - X[0]) < 0) { o1 = 2; o2 = 1; }
    double ax = X[o0], ay = Y[o0], bx = X[o1], by = Y[o1], cx = X[o2], cy = Y[o2];
    bool tl01 = topLeft(ax, ay, bx, by), tl12 = topLeft(bx, by, cx, cy), tl20 = topLeft(cx, cy, ax, ay);
    int i0 = (int)std::ceil(std::fmin(ax, std::fmin(bx, cx)) - 1e-9), i1 = (int)std::floor(std::fmax(ax, std::fmax(bx, cx)) + 1e-9);
    int r0 = (int)std::ceil(std::fmin(ay, std::fmin(by, cy)) - 1e-9), r1 = (int)std::floor(std::fmax(ay, std::fmax(by, cy)) + 1e-9);
    if (i0 < sx0) i0 = sx0; if (r0 < sr0) r0 = sr0; if (i1 > sx1) i1 = sx1; if (r1 > sr1) r1 = sr1;
    for (int r = r0; r <= r1; r++) for (int i = i0; i <= i1; i++) {
      if (!edgeAccept(ax, ay, bx, by, i, r, tl01) || !edgeAccept(bx, by, cx, cy, i, r, tl12) || !edgeAccept(cx, cy, ax, ay, i, r, tl20)) continue;
      int j = H - 1 - r;                                   // window row
      g_pi = i; g_pj = j; g_dc = 0; memset(g_has, 0, sizeof g_has); g_fragFlags = 0;
      setInputsAt(i, j);
      fragColor = vec4(0.0f);
      float disc = 0.0f;
      try { fragMain(); } catch (int) { disc = 1.0f; fragColor = vec4(0.0f); } catch (ProbeDone&) { disc = 1.0f; }
      rec[0] = (float)t; rec[1] = (float)i; rec[2] = (float)r;
      rec[3] = fragColor.x; rec[4] = fragColor.y; rec[5] = fragColor.z; rec[6] = fragColor.w; rec[7] = disc; rec[8] = (float)g_fragFlags;
      fwrite(rec, 4, 9, g);
    }
  }
  fclose(g);
  for (int c = 0; c < 64; c++) if (g_counters[c]) fprintf(stderr, "C %d %ld\\n", c, g_counters[c]);
  return 0;
}
`;
  // (An operation count is of the unfused text: every operation is one count, fused or not.)
  return {
    exe: alu
      ? compile(aluSource(src), 'fragalu', '-O2', false)
      : compile(src, 'frag', '-O2', contract),
    io,
    inN,
    inOff,
    nu,
    alu,
  };
}

/// Rasterize and shade. `vOut` is runVert's output; `tris` the vertex indices, three per triangle; `scissor` an optional
/// [x0, row0, x1, row1] pixel rectangle (inclusive, rows top-down) outside which no fragment is shaded -- a derivative's
/// partner outside it is still run, as a helper is. Returns { recs: Float32Array(9 per fragment), counts }.
export function runRaster(f, vert, vOut, tris, textures, uniforms, W, H, scissor = null) {
  const parts = texUniParts(f.io.uniforms, textures, uniforms);
  const nTri = (tris.length / 3) | 0,
    R = 4 + f.inN;
  const sc = scissor || [0, 0, W - 1, H - 1];
  const hd = Buffer.alloc(28);
  hd.writeInt32LE(W, 0);
  hd.writeInt32LE(H, 4);
  hd.writeInt32LE(nTri, 8);
  for (let k = 0; k < 4; k++)
    hd.writeInt32LE(Math.max(0, Math.min(k & 1 ? H - 1 : W - 1, sc[k] | 0)), 12 + 4 * k);
  parts.push(hd);
  // The fragment's inputs are the vertex stage's outputs of the same name.
  const src = f.io.ins.map((d) => {
    const i = vert.io.outs.findIndex((o) => o.name === d.name);
    return i < 0 ? -1 : vert.outOff[i];
  });
  const T = new Float32Array(nTri * 3 * R);
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k],
        o = (t * 3 + k) * R,
        b = v * vert.outN;
      T[o] = vOut[b];
      T[o + 1] = vOut[b + 1];
      T[o + 2] = vOut[b + 2];
      T[o + 3] = vOut[b + 3];
      f.io.ins.forEach((d, i) => {
        const s = src[i],
          n = CTYPE[d.type];
        if (s >= 0) for (let c = 0; c < n; c++) T[o + 4 + f.inOff[i] + c] = vOut[b + s + c];
      });
    }
  parts.push(Buffer.from(T.buffer));
  const r = runExe(f.exe, parts);
  const counts = {};
  for (const l of r.stderr.split('\n')) {
    const m = /^C (\d+) (\d+)/.exec(l);
    if (m) counts[m[1]] = +m[2];
  }
  return { recs: r.out, counts };
}
