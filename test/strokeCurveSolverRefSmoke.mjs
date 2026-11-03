// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveSolverRefSmoke — the INSTRUMENT and the verdict.
//
// Under-paint of the curve branch against SVG 2 on the polylines drawn as degenerate quads, where
// _coverage.glsl's line rule scores 0, can come from the TEST TREE'S own CUBIC SOLVER, not the renderer.
//
// A quad whose control point is the MIDPOINT of its endpoints is a straight line exactly, and it is
// how test/strokeCurveJoinSvgShapeSmoke.mjs makes the two branches comparable. Its closest-point
// cubic `2|A|^2 t^3 + 3(A.B) t^2 + (|B|^2 + 2 A.C) t + B.C` has A = p0 - 2 p1 + p2, which is not
// zero but the ROUNDING ERROR of p0 + p2 — so the solver takes its near-degenerate branch, and that
// branch must not do two things (see test/_strokeCurveRef.mjs realRootsCubic):
//   * the naive quadratic formula, whose `(-a1 + sqrt(disc)) / (2 a2)` root is all cancellation in
//     exactly the regime the branch is entered in, where _strokeMath.glsl's quadClosestT uses the
//     stable `qq = -0.5 (a1 + sign(a1) sqrt(disc))` pair;
//   * and return BEFORE the Newton polish that repairs the canceled root.
// With both, the reference reports the START VERTEX as the closest point where the true foot is
// mid-body, runs strokeCapsJoinsDash's JOIN branch on a body pixel, and hands back the radial
// distance to the vertex instead of the perpendicular distance to the segment.
//
//   (a) the named case, in the reference;
//   (b) THE SHIPPED SHADER IS NOT AFFECTED, shown by cutting quadClosestT out of the assembled
//       src/shaders/generated/mantle.frag.glsl and running it as float32;
//   (c) what it cost, as a population: the `legacyRoots` mutation against the fixed solver;
//   (d) THE `along >= 0` BOUND. The curve branch keeps a lower bound on the join wedge's
//       along-tangent extent that the line branch has no twin of. Measured through a broken solver,
//       removing it looks like a gain; with the correct solver it buys nothing on quads and DOUBLES the
//       over-paint on cubics. `noAlongLo` is the mutation that says so.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeStrokeCases,
  pixels,
  minDist,
  svgInside,
  JOINS,
  sub,
  dot,
} from './_strokeShapeRef.mjs';
import {
  realRootsCubic,
  legacyRealRootsCubic,
  quadClosestT,
  quadSegs,
  minDistCurve,
} from './_strokeCurveRef.mjs';
import {
  makeCubicCases,
  pixelsChain,
  minDistChain,
  svgInsideGeneric,
} from './_strokeCubicArcRef.mjs';
import { glslToCpp, cxx, hasCxx } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();

// The named case: the segment, the query, and the answer.
const A0 = [-1.6046321417360476, 3.2226007648648602];
const B0 = [-40.184196928121, 31.78161301832219];
const MID = [(A0[0] + B0[0]) / 2, (A0[1] + B0[1]) / 2];
const QRY = [-6.779670519032516, -0.19840689264237876];
const A = [A0[0] - 2 * MID[0] + B0[0], A0[1] - 2 * MID[1] + B0[1]];
const B = [2 * (MID[0] - A0[0]), 2 * (MID[1] - A0[1])];
const C = sub(A0, QRY);
const T_TRUE = 0.044249187820753905;

// ---- (a) the named case ---------------------------------------------------------------------------
{
  ok(
    A[0] === 0 && A[1] !== 0 && Math.abs(A[1]) < 1e-14,
    `(a) the "straight" quad's A = p0 - 2 p1 + p2 is not zero but the rounding error of p0 + p2: [${A}]`,
  );
  const a3 = 2 * dot(A, A),
    a2 = 3 * dot(A, B),
    a1 = dot(B, B) + 2 * dot(A, C),
    a0 = dot(B, C);
  const legacy = legacyRealRootsCubic(a3, a2, a1, a0).filter((t) => t >= 0 && t <= 1);
  const fixed = realRootsCubic(a3, a2, a1, a0).filter((t) => t >= 0 && t <= 1);
  ok(
    legacy.length === 1 && Math.abs(legacy[0]) < 1e-12,
    `(a) the legacy solver returns t = ${legacy[0]} for a foot whose true parameter is ${T_TRUE} — every digit of (-a1 + sqrt(disc)) canceled`,
  );
  ok(
    fixed.length === 1 && Math.abs(fixed[0] - T_TRUE) < 1e-12,
    `(a) the stable pair plus the polish returns ${fixed[0]}`,
  );
  const at = (t) => Math.hypot((A[0] * t + B[0]) * t + C[0], (A[1] * t + B[1]) * t + C[1]);
  ok(
    Math.abs(quadClosestT(A, B, C, true) - 0) < 1e-12 &&
      Math.abs(quadClosestT(A, B, C) - T_TRUE) < 1e-12,
    `(a) so the closest point moved from the endpoint at distance ${at(0).toFixed(4)} to the body at ${at(T_TRUE).toFixed(4)} — and a half-width of 6 has the two on opposite sides`,
  );
}

// ---- (b) the shipped shader answers correctly, in float32 -------------------------------------------
if (!hasCxx()) {
  console.log('  SKIP (b) no C++ compiler ($CXX, clang++, g++, c++) — cannot run the shader text');
} else {
  const HEAD = `#include <cmath>
#include <cstdio>
#include <cstdlib>
namespace glsl {
struct vec2 { float x, y; vec2() : x(0), y(0) {} vec2(float a) : x(a), y(a) {} vec2(float a, float b) : x(a), y(b) {} };
inline vec2 operator+(vec2 a, vec2 b) { return vec2(a.x + b.x, a.y + b.y); }
inline vec2 operator-(vec2 a, vec2 b) { return vec2(a.x - b.x, a.y - b.y); }
inline vec2 operator*(vec2 a, vec2 b) { return vec2(a.x * b.x, a.y * b.y); }
inline vec2 operator*(float a, vec2 b) { return vec2(a * b.x, a * b.y); }
inline vec2 operator*(vec2 a, float b) { return vec2(a.x * b, a.y * b); }
inline float dot(vec2 a, vec2 b) { return a.x * b.x + a.y * b.y; }
inline float abs(float x) { return std::fabs(x); }
inline float sqrt(float x) { return std::sqrt(x); }
inline float sign(float x) { return x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f); }
inline float pow(float a, float b) { return std::pow(a, b); }
inline float acos(float x) { return std::acos(x); }
inline float cos(float x) { return std::cos(x); }
inline float min(float a, float b) { return b < a ? b : a; }
inline float max(float a, float b) { return a < b ? b : a; }
inline float clamp(float x, float a, float b) { return min(max(x, a), b); }
`;
  const glsl = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const body = glslToCpp(glsl, ['quadClosestT']);
  ok(
    /float quadClosestT\(vec2 A, vec2 B, vec2 C\)/.test(body),
    '(b) quadClosestT cut out of the ASSEMBLED shader, not re-typed',
  );
  const src =
    `${HEAD}\n${body}\n}\nusing namespace glsl;\nint main(int argc, char** argv) {\n` +
    `  printf("%.9g\\n", quadClosestT(vec2(atof(argv[1]), atof(argv[2])), vec2(atof(argv[3]), atof(argv[4])), vec2(atof(argv[5]), atof(argv[6]))));\n` +
    `  return 0;\n}\n`;
  const dir = path.join(os.tmpdir(), 'mantle-strokeSolver');
  mkdirSync(dir, { recursive: true });
  const cpp = path.join(dir, `qct_${process.pid}.cpp`),
    exe = path.join(dir, `qct_${process.pid}`);
  writeFileSync(cpp, src);
  const r = spawnSync(cxx(), ['-std=c++17', '-O2', '-ffp-contract=off', '-w', '-o', exe, cpp], {
    encoding: 'utf8',
  });
  ok(
    r.status === 0,
    `(b) it compiles${r.status === 0 ? '' : ':\n' + (r.stderr || '').split('\n').slice(0, 12).join('\n')}`,
  );
  if (r.status === 0) {
    // float32 throughout: round the endpoints first and form A, B, C the way strokeQuadAccum does.
    const f = Math.fround;
    const a32 = A0.map(f),
      b32 = B0.map(f),
      q32 = QRY.map(f);
    const m32 = [f((a32[0] + b32[0]) / 2), f((a32[1] + b32[1]) / 2)];
    const A32 = [f(f(a32[0] - f(2 * m32[0])) + b32[0]), f(f(a32[1] - f(2 * m32[1])) + b32[1])];
    const B32 = [f(2 * f(m32[0] - a32[0])), f(2 * f(m32[1] - a32[1]))];
    const C32 = [f(a32[0] - q32[0]), f(a32[1] - q32[1])];
    const got = Number(
      spawnSync(exe, [A32[0], A32[1], B32[0], B32[1], C32[0], C32[1]].map(String), {
        encoding: 'utf8',
      }).stdout.trim(),
    );
    ok(
      Math.abs(got - T_TRUE) < 1e-5,
      `(b) and the SHIPPED shader answers ${got} against the true ${T_TRUE.toFixed(9)} — in float32, on the input that makes the legacy reference answer 0: the defect is the instrument's, not the renderer's`,
    );
  }
}

// ---- (c) what the instrument's solver cost, as a population -------------------------------------------
{
  const tally = {};
  for (const cs of makeStrokeCases(0x51de, 360)) {
    const Q = cs.segs.map((s) => [s.a, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], s.b]);
    const qs = quadSegs(Q, cs.closed);
    const t = (tally[JOINS[cs.joinStyle]] ??= { n: 0, line: 0, u: {}, o: {} });
    for (const c of pixels(cs)) {
      t.n++;
      const sv = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (
        minDist('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW !==
        sv
      )
        t.line++;
      for (const r of ['legacyRoots', 'fixed']) {
        const inS =
          minDistCurve(r, c, qs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <= cs.halfW;
        if (!inS && sv) t.u[r] = (t.u[r] ?? 0) + 1;
        if (inS && !sv) t.o[r] = (t.o[r] ?? 0) + 1;
      }
    }
  }
  const g = (J, k, r) => tally[J][k][r] ?? 0;
  ok(
    JOINS.every((J) => tally[J].line === 0),
    '(c) the line rule is exact on this population',
  );
  for (const J of JOINS)
    console.log(
      `       ${J.padEnd(11)} of ${tally[J].n}: unpainted ${String(g(J, 'u', 'legacyRoots')).padStart(5)} -> ${g(J, 'u', 'fixed')}   outside ${g(J, 'o', 'legacyRoots')} -> ${g(J, 'o', 'fixed')}`,
    );
  ok(
    JOINS.every((J) => g(J, 'u', 'legacyRoots') > 0 && g(J, 'u', 'fixed') === 0),
    `(c) every one of the residual under-paints is the solver: ${JOINS.reduce((a, J) => a + g(J, 'u', 'legacyRoots'), 0)} centres of ` +
      `${JOINS.reduce((a, J) => a + tally[J].n, 0)} -> 0, on all five joins`,
  );
  ok(
    g('round', 'u', 'legacyRoots') > 0 && g('bevel', 'u', 'legacyRoots') > 0,
    `(c) including round (${g('round', 'u', 'legacyRoots')}) and bevel (${g('bevel', 'u', 'legacyRoots')}), which take NO join-wedge branch at all — which is what says the closest-point solve is the cause`,
  );
}

// ---- (d) the verdict: the `along >= 0` bound stays ------------------------------------------------------
{
  const quad = {};
  for (const cs of makeStrokeCases(0x51de, 360)) {
    const Q = cs.segs.map((s) => [s.a, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], s.b]);
    const qs = quadSegs(Q, cs.closed);
    for (const c of pixels(cs)) {
      const sv = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      for (const r of ['fixed', 'noAlongLo']) {
        const inS =
          minDistCurve(r, c, qs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <= cs.halfW;
        const b = (quad[r] ??= { u: 0, o: 0 });
        if (!inS && sv) b.u++;
        if (inS && !sv) b.o++;
      }
    }
  }
  ok(
    quad.fixed.u === quad.noAlongLo.u && quad.fixed.o === quad.noAlongLo.o,
    `(d) on straight quads, with the solver fixed, dropping the bound buys NOTHING: unpainted ${quad.fixed.u} either way, outside ${quad.fixed.o} either way ` +
      '(a gain measured through the broken solver is that solver being partly compensated — without a foot on the body, `along` comes out negative and the bound throws the join away)',
  );
  const cub = {};
  for (const cs of makeCubicCases(0x3d19, 240)) {
    for (const c of pixelsChain(cs)) {
      const sv = svgInsideGeneric(
        c,
        cs.segs,
        cs.closed,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      for (const r of ['fixed', 'noAlongLo']) {
        const inS =
          minDistChain(r, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW;
        const b = (cub[r] ??= { u: 0, o: 0, n: 0 });
        b.n++;
        if (!inS && sv) b.u++;
        if (inS && !sv) b.o++;
      }
    }
  }
  ok(
    cub.noAlongLo.o > cub.fixed.o * 1.5 && cub.noAlongLo.u === cub.fixed.u,
    `(d) and on CUBICS it is actively harmful — the mutation is caught: of ${cub.fixed.n} centers, painted outside the SVG 2 shape ${cub.fixed.o} with the bound and ${cub.noAlongLo.o} without, with the unpainted count unmoved at ${cub.fixed.u}`,
  );
  const ex = {};
  for (const cs of makeCubicCases(0x3d19, 240)) {
    for (const c of pixelsChain(cs)) {
      for (const r of ['fixed', 'noAlongLo']) {
        const inS =
          minDistChain(
            r,
            c,
            cs.segs,
            cs.halfW,
            cs.cap,
            cs.joinStyle,
            cs.miterLimit,
            cs.cap,
            'exact',
          ).minD <= cs.halfW;
        const sv = svgInsideGeneric(
          c,
          cs.segs,
          cs.closed,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
        );
        const b = (ex[r] ??= { o: 0 });
        if (inS && !sv) b.o++;
      }
    }
  }
  ok(
    ex.fixed.o === ex.noAlongLo.o,
    `(d) and the extra over-paint is entirely the SHIPPED cubic solver's wrong basins: under an EXACT solver the two rules are identical at ${ex.fixed.o} centres outside. ` +
      'The bound is what stops a wrong-basin t ~ 0 taking the join branch and painting the distance to the tangent line at the vertex',
  );
}

console.log(
  `${fail ? 'STROKE-CURVE-SOLVER-REF FAIL' : 'STROKE-CURVE-SOLVER-REF PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
