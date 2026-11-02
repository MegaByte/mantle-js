// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbKlmGradFormatSmoke — the cubic CURVE_BAND's klm gradient lane (aC0.z) must hold its pair at ANY drawing size.
//
// (dk, dl) is d(klm)/d(em position), so it scales as 1/S. Packed as two IEEE halves it would have about 2^18 of
// usable drawing scale while real art spends 2^23 of half's range at ONE size, so the lane would fail at both ends:
// components saturate to INF from about 2^-11 down and flush to ZERO from about 2^7 up -- and some flush even at the
// AUTHORED size, because a half path has no subnormals and drops everything under 6.1e-5. A saturated or flushed
// gradient is not a soft edge: the extruded
// ring vertex carries the wrong klm, so the implicit that decides its coverage is wrong.
//
// This is a FORMAT bound, not a tolerance, so the answer is a format: one 8-bit exponent shared by both
// components (held in the float's own exponent field) plus 11 bits of magnitude and a sign each. Same 32-bit
// lane, same stride, same attribute count -- zero extra bytes.
//
// Pinned here:
//   (a) the SHIPPED GLSL codec (extracted verbatim from src/shaders/generated/mantle.vert.glsl, compiled as C++)
//       agrees with the JS packer bit for bit, both ways, over the corpus's own pairs and a synthetic sweep;
//   (b) every corpus pair survives 2^-30..2^30 -- nothing saturates, nothing flushes -- where the half reference
//       loses thousands of components;
//   (c) the error the kernel actually sees (each component against the PAIR's magnitude, since the pair is
//       multiplied by one ring push and added to klm) stays under 2^-11 at every exponent, and is BETTER than
//       the half reference at scale 1;
//   (d) the packed slot is always a normal float or a signed zero -- never a denormal, an Inf or a NaN, which
//       packHalf2x16 could not promise and which a driver is free to flush on attribute load.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import { cxx, hasCxx } from './_glslEmu.mjs';
import { packKlmGrad, unpackKlmGrad } from '../src/renderer/lbPack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the corpus's own pairs ---------------------------------------------------------------------------------
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');

const dir = (d) =>
  existsSync(path.join(ROOT, d))
    ? readdirSync(path.join(ROOT, d))
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .map((f) => d + '/' + f)
    : [];
const pairs = [];
for (const f of [...dir('examples'), ...dir('examples/smoke')]) {
  let bundle;
  try {
    bundle = await importSvg(readFileSync(path.resolve(ROOT, f), 'utf8'));
  } catch {
    continue;
  }
  if (!bundle.numShapes || !bundle.curves) continue;
  const meta =
    bundle.meta && bundle.meta.byteLength > 32 ? new Float32Array(bundle.meta, 32) : null;
  const mst = bundle.metaFloatsPerShape,
    curveFloats = new Float32Array(bundle.curves);
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const bb = meta && mst ? s * mst : -1;
    const transSolid =
      bb >= 0 &&
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let built = null;
    try {
      built = buildLbShape(curveRangeToContours(curveFloats, r.begin, r.end), transSolid, evenodd);
    } catch {
      built = null;
    }
    if (!built || !built.raw || !built.raw.cubics) continue;
    for (const c of built.raw.cubics)
      if (c._ring) for (const R of c._ring) pairs.push([R.dk, R.dl]);
  }
}
ok(pairs.length > 2000, `corpus cubic curve-band rings: ${pairs.length} (dk, dl) pairs`);

// ---- the two-half format, as the reference --------------------------------------------------------
const _b = new ArrayBuffer(4),
  _f = new Float32Array(_b),
  _u = new Uint32Array(_b);
function toHalfBits(val) {
  _f[0] = val;
  const x = _u[0],
    s = (x >>> 16) & 0x8000,
    e = ((x >>> 23) & 0xff) - 127,
    m = x & 0x7fffff;
  if (e > 15) return s | 0x7c00;
  if (e > -15) return s | ((e + 15) << 10) | (m >>> 13);
  return s;
}
function fromHalfBits(h) {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 0x1f,
    m = h & 0x3ff;
  if (e === 31) return m ? NaN : s * Infinity;
  if (e === 0) return s * m * Math.pow(2, -24);
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
const halfRound = (v) => fromHalfBits(toHalfBits(v));

// ---- (b) RANGE --------------------------------------------------------------------------------------------
const EXPS = [-30, -20, -15, -11, -8, 0, 4, 7, 11, 16, 20, 30];
function lost(S, rt) {
  let sat = 0,
    flush = 0;
  for (const p of pairs)
    for (const v0 of p) {
      const v = v0 / S,
        r = rt(v);
      if (!Number.isFinite(r)) sat++;
      else if (v !== 0 && r === 0) flush++;
    }
  return sat + flush;
}
const newRt = (v) => unpackKlmGrad(packKlmGrad(v, 0))[0];
{
  const nw = EXPS.map((e) => lost(Math.pow(2, e), newRt));
  const hf = EXPS.map((e) => lost(Math.pow(2, e), halfRound));
  ok(
    nw.every((n) => n === 0),
    `(b) shared exponent: 0 of ${pairs.length * 2} components lost at 2^${EXPS.join(', 2^')} (${nw.join('/')})`,
  );
  ok(
    hf.some((n) => n > 0) && hf[EXPS.indexOf(0)] > 0,
    `(b) the half reference loses ${hf.join('/')} at the same exponents -- ${hf[EXPS.indexOf(0)]} already at the AUTHORED size`,
  );
}

// ---- (c) ACCURACY ------------------------------------------------------------------------------------------
function worstPair(S, pack) {
  let w = 0,
    n = 0;
  for (const [a0, b0] of pairs) {
    const a = a0 / S,
      b = b0 / S,
      G = Math.max(Math.abs(a), Math.abs(b));
    if (!(G > 0)) continue;
    const [ra, rb] = pack(a, b);
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) {
      w = Infinity;
      continue;
    }
    w = Math.max(w, Math.abs(ra - a) / G, Math.abs(rb - b) / G);
    n++;
  }
  return { w, n };
}
const newPair = (a, b) => unpackKlmGrad(packKlmGrad(a, b));
const halfPair = (a, b) => [halfRound(a), halfRound(b)];
const BAR = Math.pow(2, -11);
{
  const rs = EXPS.map((e) => worstPair(Math.pow(2, e), newPair));
  ok(
    rs.every((r) => r.w <= BAR),
    `(c) worst error against the PAIR stays under 2^-11 at every exponent (${rs.map((r) => r.w.toExponential(2)).join(' ')})`,
  );
  const h1 = worstPair(1, halfPair),
    n1 = worstPair(1, newPair);
  ok(
    n1.w < h1.w,
    `(c) ...and beats the half reference at SCALE 1: ${n1.w.toExponential(3)} against ${h1.w.toExponential(3)} (half truncates its mantissa, and flushes what falls under 6.1e-5)`,
  );
}

// ---- (c2) the equivariance comparator's own rule, on both formats -------------------------------------------
// lbCpatchScaleEquivarianceSmoke and lbEmTunedLengthScaleSmoke decode this lane rather than excuse it ("a
// half that saturates or flushes is the vertex format's range, not a decision"), and require both
// components equal under some integer power of the scale, to 2e-3. This is that rule, applied to each format.
{
  const numEq = (a, b, S, tol) => {
    if (a === b) return true;
    if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
    for (let e = -8, p = S ** -8; e <= 8; e++, p *= S)
      if (Math.abs(a / p - b) <= Math.abs(b) * tol) return true;
    return false;
  };
  const strictFails = (S, pack) => {
    let n = 0;
    for (const [a, b] of pairs) {
      const base = pack(a, b),
        at = pack(a / S, b / S);
      if (![0, 1].every((j) => numEq(at[j], base[j], S, 2e-3) || (at[j] === 0 && base[j] === 0)))
        n++;
    }
    return n;
  };
  const SC = [-20, -11, 7, 11, 20];
  const nw = SC.map((e) => strictFails(Math.pow(2, e), newPair));
  const hf = SC.map((e) => strictFails(Math.pow(2, e), halfPair));
  ok(
    nw.every((n) => n === 0),
    `(c2) under the equivariance guards' strict rule, the shared exponent fails 0 of ${pairs.length} pairs at 2^${SC.join(', 2^')} (${nw.join('/')})`,
  );
  ok(
    hf.some((n) => n > 0),
    `(c2) ...the half format fails ${hf.join('/')} of ${pairs.length} at the same exponents, which is why those guards had to excuse this lane`,
  );
}

// ---- (d) the packed slot is always a well-behaved float ------------------------------------------------------
{
  let bad = 0;
  const probe = [
    ...pairs.map(([a, b]) => [a, b]),
    ...pairs.map(([a, b]) => [a / 1048576, b / 1048576]),
    ...pairs.map(([a, b]) => [a * 1048576, b * 1048576]),
    [0, 0],
    [0, 1],
    [1, 0],
    [-0, -0],
    [1e-40, 0],
    [0, -1e-40],
    [3.4e38, 1],
    [1, -3.4e38],
  ];
  for (const [a, b] of probe) {
    _f[0] = packKlmGrad(a, b);
    const e = (_u[0] >>> 23) & 0xff,
      m = _u[0] & 0x7fffff;
    if (e === 0xff)
      bad++; // Inf or NaN
    else if (e === 0 && m !== 0) bad++; // denormal
  }
  ok(
    bad === 0,
    `(d) ${probe.length} packed slots are all a normal float or a signed zero (${bad} were not)`,
  );
}

// ---- (a) the SHIPPED GLSL codec, compiled and compared -------------------------------------------------------
if (!hasCxx()) console.log('  SKIP (a): no C++ compiler ($CXX, clang++, g++, c++)');
else {
  const VERT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
  const cut = (name) => {
    const i = VERT.indexOf(`${name === 'lbUnpackKlmGrad' ? 'vec2' : 'float'} ${name}(`);
    if (i < 0) return null;
    let d = 0,
      j = VERT.indexOf('{', i);
    for (let k = j; k < VERT.length; k++) {
      if (VERT[k] === '{') d++;
      else if (VERT[k] === '}' && --d === 0) return VERT.slice(i, k + 1);
    }
    return null;
  };
  const un = cut('lbUnpackKlmGrad'),
    pk = cut('lbPackKlmGrad');
  ok(
    !!un && !!pk,
    `(a) both shipped GLSL codec functions extracted (${un ? un.length : 0} + ${pk ? pk.length : 0} chars)`,
  );
  if (un && pk) {
    // A shim, not a translation: the two function bodies go in VERBATIM, so this tests the text that ships.
    const src = `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
typedef unsigned int uint;
struct vec2 { float x, y; vec2() : x(0), y(0) {} vec2(float a, float b) : x(a), y(b) {} };
static inline vec2 operator*(vec2 a, float s) { return vec2(a.x * s, a.y * s); }
static inline vec2 abs(vec2 a) { return vec2(std::fabs(a.x), std::fabs(a.y)); }
static inline float max(float a, float b) { return a > b ? a : b; }
static inline uint min(uint a, uint b) { return a < b ? a : b; }
static inline uint floatBitsToUint(float f) { uint u; std::memcpy(&u, &f, 4); return u; }
static inline float uintBitsToFloat(uint u) { float f; std::memcpy(&f, &u, 4); return f; }
${un}
${pk}
int main(int argc, char** argv) {
  FILE* f = fopen(argv[1], "rb"); if (!f) return 2;
  int n; if (fread(&n, 4, 1, f) != 1) return 3;
  float* in = (float*)malloc(8 * (size_t)n); if (fread(in, 4, (size_t)n * 2, f) != (size_t)n * 2) return 4;
  fclose(f);
  float* out = (float*)malloc(12 * (size_t)n);
  for (int i = 0; i < n; i++) {
    float p = lbPackKlmGrad(vec2(in[2 * i], in[2 * i + 1]));
    vec2 d = lbUnpackKlmGrad(p);
    out[3 * i] = p; out[3 * i + 1] = d.x; out[3 * i + 2] = d.y;
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(out, 4, (size_t)n * 3, g); fclose(g);
  return 0;
}
`;
    const C = cxx();
    const CACHE = path.join(os.tmpdir(), 'mantle-glslemu');
    mkdirSync(CACHE, { recursive: true });
    const exe = path.join(
      CACHE,
      `klmgrad_${createHash('sha1')
        .update(C + '\0' + src)
        .digest('hex')
        .slice(0, 20)}`,
    );
    let built = existsSync(exe);
    if (!built) {
      const cpp = `${exe}.${process.pid}.cpp`,
        tmp = `${exe}.${process.pid}.tmp`;
      writeFileSync(cpp, src);
      const r = spawnSync(C, ['-std=c++17', '-O2', '-ffp-contract=off', '-w', '-o', tmp, cpp], {
        encoding: 'utf8',
      });
      if (r.status !== 0)
        ok(
          false,
          `(a) the shipped GLSL codec compiles: ${(r.stderr || '').split('\n').slice(0, 6).join(' | ')}`,
        );
      else {
        rmSync(cpp, { force: true });
        spawnSync('mv', ['-f', tmp, exe]);
        built = true;
      }
    }
    if (built) {
      // The corpus's pairs at five exponents, plus a synthetic sweep across the whole float32 exponent range and
      // the sign/zero corners. float32 inputs, since that is what the shader's morph mixer hands the packer.
      const cases = [];
      for (const e of [-30, -11, 0, 7, 30])
        for (const [a, b] of pairs)
          cases.push([Math.fround(a / Math.pow(2, e)), Math.fround(b / Math.pow(2, e))]);
      for (let e = -120; e <= 120; e += 3)
        for (const r of [1, 0.5, 1.9999, 1 / 3, 1e-4, 0]) {
          const s = Math.pow(2, e);
          cases.push(
            [Math.fround(s), Math.fround(s * r)],
            [Math.fround(-s), Math.fround(s * r)],
            [Math.fround(s * r), Math.fround(-s)],
            [Math.fround(-s * r), Math.fround(-s)],
          );
        }
      cases.push([0, 0], [0, 1], [1, 0], [-1, 0], [0, -1]);
      const buf = Buffer.alloc(4 + cases.length * 8);
      buf.writeInt32LE(cases.length, 0);
      const fin = new Float32Array(buf.buffer, buf.byteOffset + 4, cases.length * 2);
      cases.forEach((c, i) => {
        fin[2 * i] = c[0];
        fin[2 * i + 1] = c[1];
      });
      const job = path.join(CACHE, `klmjob_${process.pid}`);
      writeFileSync(job + '.in', buf);
      const r = spawnSync(exe, [job + '.in', job + '.out'], { encoding: 'utf8' });
      rmSync(job + '.in', { force: true });
      if (r.status !== 0) ok(false, `(a) the shipped GLSL codec runs (exit ${r.status})`);
      else {
        const ob = readFileSync(job + '.out');
        rmSync(job + '.out', { force: true });
        const g = new Float32Array(
          ob.buffer.slice(ob.byteOffset, ob.byteOffset + cases.length * 12),
        );
        const bits = (v) => {
          _f[0] = v;
          return _u[0];
        };
        let packDiff = 0,
          unpackDiff = 0,
          worst = null;
        cases.forEach((c, i) => {
          const jp = packKlmGrad(c[0], c[1]);
          if (bits(jp) !== bits(g[3 * i])) {
            if (!worst)
              worst = `${c[0]},${c[1]}: js ${bits(jp).toString(16)} glsl ${bits(g[3 * i]).toString(16)}`;
            packDiff++;
          }
          const [ja, jb] = unpackKlmGrad(g[3 * i]);
          if (bits(ja) !== bits(g[3 * i + 1]) || bits(jb) !== bits(g[3 * i + 2])) unpackDiff++;
        });
        ok(
          packDiff === 0 && unpackDiff === 0,
          `(a) the shipped GLSL codec agrees with the JS packer on all ${cases.length} cases (pack ${packDiff}, unpack ${unpackDiff}${worst ? '; first ' + worst : ''})`,
        );
      }
    }
  }
}

if (fail) {
  console.error(`LB-KLM-GRAD-FORMAT FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-KLM-GRAD-FORMAT PASS');
