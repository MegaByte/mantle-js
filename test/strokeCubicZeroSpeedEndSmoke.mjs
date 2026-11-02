// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCubicZeroSpeedEndSmoke — a stroked CUBIC's butt cap holds at an end whose handle is short or ZERO, at every
// coordinate scale (_strokeMath.glsl strokeCubicAccum). The cubic twin of test/strokeQuadZeroSpeedEndSmoke.mjs.
//
// THE HAZARD. A descending chain over the quintic P.P' written from the START's coefficients uses direct differences at
// t = 0 and cancels segment-sized terms at t = 1. When the end's handle is short or zero the quintic's roots crowd t = 1:
// the chain's bisections read rounding for sign there and stop short of the `t > 1 - 1e-4` end gate for a pixel near the
// cap plane, the butt cap is skipped, and a pixel 0.01 halfW past the end reads 0.200 halfW for 1.010, identically at
// every scale, for end handles from zero to 1e-3 of the chord. The shader solves the reversed cubic (p4, p3, p2, p1) when
// the pixel is nearer p4. The hit test's cubic closest point is a bracketed solve in the unit interval (float64); (c) keeps it right.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// The cubics are exactly collinear as stored (axis-aligned or diagonal chords), so the curve is the segment p1 -> p4 and
// the truth is the butt-capped segment's distance, as in the quad smoke. Two families per handle h (a fraction of the
// chord): only the tested end's handle short (the other inner point at mid-chord), and both inner points bunched at the
// tested end (h and 2h from it).
// (a) the shader at the END, pixels on a grid across the cap plane (depth -0.3 .. 0.8 halfW, lateral -0.8 .. 0.8), at
//     2^-20, 1 and 2^20: within 1e-3 halfW of the truth;
// (b) ...and at the START, the same;
// (c) the hit test at the same points: off the stroke past either cap plane, on it in front;
// (d) mutation: the start-only solve restored in the shader is caught by (a) at every scale.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_STROKE_CUBIC } from './_glslEmu.mjs';
import { pointOnStroke, SEG_CUBIC } from '../src/hitTest/curveGeom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;
const HANDLES = [0, 1e-5, 1e-4, 1e-3, 1e-2];
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
const LENS = [1, 0.75, 1.5, 3];
const DEPTHS = [-0.3, -0.03, -3e-3, -3e-4, 1e-6, 1e-5, 1e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 0.8];
const LATS = [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8];

function cases(S, h, atStart) {
  const out = [];
  for (const kind of ['one', 'two'])
    for (const dir of DIRS)
      for (const L of LENS) {
        const e = [L * dir[0], L * dir[1]],
          at = (k) => [k * e[0], k * e[1]];
        const P = atStart
          ? kind === 'one'
            ? [at(0), at(h), at(0.5), at(1)]
            : [at(0), at(h), at(2 * h), at(1)]
          : kind === 'one'
            ? [at(0), at(0.5), at(1 - h), at(1)]
            : [at(0), at(1 - 2 * h), at(1 - h), at(1)];
        const p = P.map(([x, y]) => [f(x * S), f(y * S)]);
        const len = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1]);
        const D = [(p[3][0] - p[0][0]) / len, (p[3][1] - p[0][1]) / len];
        const halfW = f(0.05 * len),
          V = atStart ? p[0] : p[3];
        const o = atStart ? [-D[0], -D[1]] : D,
          N = [-D[1], D[0]];
        const px = [];
        for (const r of DEPTHS)
          for (const s of LATS) {
            px.push({
              c: [V[0] + (o[0] * r + N[0] * s) * halfW, V[1] + (o[1] * r + N[1] * s) * halfW],
              r,
              s,
              want:
                (r <= 0 ? Math.max(Math.abs(s), 1 + r) : Math.max(Math.hypot(r, s), 1 + r)) * halfW,
            });
          }
        out.push({ kind, p, halfW, px });
      }
  return out;
}

// ---- (a), (b) the shader ---------------------------------------------------------------------------------------------------
function shaderWorst(emu, atStart) {
  const res = new Map();
  for (const S of SCALES) {
    let worst = 0,
      n = 0,
      bad = 0,
      at = '';
    for (const h of HANDLES) {
      const qs = [],
        meta = [];
      for (const q of cases(S, h, atStart))
        for (const b of q.px) {
          const rel = q.p.map(([x, y]) => [f(x - b.c[0]), f(y - b.c[1])]);
          qs.push({
            k: K_STROKE_CUBIC,
            bb: [rel[0][0], rel[0][1], rel[1][0], rel[1][1]],
            c: rel[2],
            ePx: [4, q.halfW],
            GD: [1, 1, 0, 0],
            ex: [rel[3][0], rel[3][1], 0, 0, 0, 0],
          });
          meta.push({ b, q });
        }
      const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
      for (let i = 0; i < qs.length; i++) {
        const e = Math.abs(got[i] - meta[i].b.want) / meta[i].q.halfW;
        n++;
        if (e > 1e-3) bad++;
        if (e > worst) {
          worst = e;
          at = `handle ${h} (${meta[i].q.kind}), depth ${meta[i].b.r}, lateral ${meta[i].b.s}: ${(got[i] / meta[i].q.halfW).toFixed(3)} for ${(meta[i].b.want / meta[i].q.halfW).toFixed(3)} halfW`;
        }
      }
    }
    res.set(S, { worst, n, bad, at });
  }
  return res;
}
const fmt = (w) =>
  [...w]
    .map(
      ([S, v]) =>
        `${lg(S)}: ${v.bad} of ${v.n} off, worst ${v.worst.toExponential(1)}${v.worst > 1e-3 ? ' (' + v.at + ')' : ''}`,
    )
    .join('; ');
if (!hasCxx()) {
  console.log(
    '  SKIPPED (a), (b), (d): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const emu = buildGlslEmu(ROOT, { stroke: true });
  const wEnd = shaderWorst(emu, false),
    wStart = shaderWorst(emu, true);
  ok(
    [...wEnd.values()].every((v) => v.bad === 0),
    `(a) behind and before a short or zero END handle the cubic's distance is the butt-capped segment's to 1e-3 halfW -- ${fmt(wEnd)}`,
  );
  ok(
    [...wStart.values()].every((v) => v.bad === 0),
    `(b) ...and at the START -- ${fmt(wStart)}`,
  );

  // ---- (d) mutation --------------------------------------------------------------------------------------------------------------
  const HINGE = 'bool fromEnd = dot(p34.zw, p34.zw) < dot(p12.xy, p12.xy);';
  ok(
    GLSL.split(HINGE).length === 2,
    '(d) the nearer-end choice is in the shipped text once (the mutation hinge)',
  );
  const mut = shaderWorst(
    buildGlslEmu(ROOT, { stroke: true, glsl: GLSL.replace(HINGE, 'bool fromEnd = false;') }),
    false,
  );
  ok(
    [...mut.values()].every((v) => v.worst > 0.5),
    `(d) the start-only solve restored is caught at every scale -- ${fmt(mut)}`,
  );
}

// ---- (c) the hit test ------------------------------------------------------------------------------------------------------------
{
  const bad = [];
  let n = 0;
  for (const S of SCALES)
    for (const h of HANDLES)
      for (const atStart of [false, true])
        for (const q of cases(S, h, atStart)) {
          const seg = {
            t: SEG_CUBIC,
            x0: q.p[0][0],
            y0: q.p[0][1],
            c1x: q.p[1][0],
            c1y: q.p[1][1],
            c2x: q.p[2][0],
            c2y: q.p[2][1],
            x1: q.p[3][0],
            y1: q.p[3][1],
            f: false,
            freeS: true,
            freeE: true,
            sd: 0,
            itx: 0,
            ity: 0,
            otx: 0,
            oty: 0,
            kSS: 0,
            kSE: 0,
            kPE: 0,
            kNS: 0,
          };
          for (const b of q.px) {
            n++;
            if (pointOnStroke([seg], b.c[0], b.c[1], q.halfW, 0, 0, 4, null, 0) !== b.r <= 0)
              bad.push(
                `${atStart ? 'start' : 'end'} handle ${h} (${q.kind}) depth ${b.r} lateral ${b.s} at ${lg(S)}`,
              );
          }
        }
  ok(
    bad.length === 0,
    `(c) the hit test puts every point past a cubic's butt cap off the stroke and every one before it on (${bad.length} of ${n} wrong${bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''})`,
  );
}

console.log(
  fail ? `STROKE-CUBIC-ZERO-SPEED-END FAIL (${fail})` : 'STROKE-CUBIC-ZERO-SPEED-END PASS',
);
process.exit(fail ? 1 : 0);
