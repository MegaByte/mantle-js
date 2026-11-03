// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeQuadZeroSpeedEndSmoke — a stroked quad's butt cap holds at an end whose handle is short or ZERO (the control point
// ON the end point, so the speed vanishes there), at every coordinate scale (_strokeMath.glsl strokeQuadAccum, and the hit
// test's closest() in src/hitTest/curveGeom.js).
//
// THE HAZARD. Solving the closest point from the cubic dot(Q - P, Q') written from the START: there its
// coefficients are direct differences of the fragment-relative points, and a zero start handle makes two of them exactly
// zero, so the root at t = 0 is exact. At t = 1 the same coefficients cancel segment-sized terms, and when the end handle is
// short three roots crowd t = 1 -- a triple root for a pixel on the cap plane of a zero handle -- where Cardano is good only
// to ~cbrt(ulp). In float32 the closest point lands near t = 0.99984, short of the `t > 1 - 1e-4` end gate, so the butt
// cap is skipped and a pixel 0.01 halfW past the end reads 0.81 halfW nearer than the cap plane: at every scale, for end
// handles from zero to 1e-2 of the chord, while the mirrored start is exact. In float64 (the hit test) the root lands at
// 1 - 4e-14 and ties the endpoint's distance; the interior wins a tie there, so the cap is skipped and points past the end
// hit. Both solve from the NEARER end (the reversed quad p3, p2, p1 when the point is nearer p3), which gives the end the
// start's conditioning.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// The quads are exactly collinear as stored (axis-aligned or diagonal chords, so float32 rounds x and y alike), which makes
// the truth exact: the curve is the segment p1 -> p3, whatever the handle, and its butt-capped distance is
//   in front of the cap plane   max(|lateral|, halfW + depth)       (the shader's end-plane term, depth <= 0)
//   past it                     max(|P - V|, halfW + depth)          (the cap plane itself).
// (a) the shader, pixels on a grid across each end's cap plane (depth -0.3 .. 0.8 halfW, lateral -0.8 .. 0.8), at 2^-20,
//     1 and 2^20, for handles 0 and 1e-5 .. 1e-2 of the chord at the END: within 1e-3 halfW of the truth (a handle this
//     short tilts by float32's resolution of the fragment-relative coordinates, 2e-4 halfW at 1e-5);
// (b) ...and at the START, the same;
// (c) the hit test at the same points, handles 0 and 1e-5 .. 1e-2: a point past either cap plane is off the stroke and one
//     in front of it is on it;
// (d) mutations: the start-only solve restored in the shader is caught by (a), and in the hit test by (c).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasCxx, buildGlslEmu, K_STROKE_QUAD } from './_glslEmu.mjs';

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

/// One quad per direction, length and end: p1 at the origin, p3 = L dir, and the handle at the tested end h L dir long,
/// pointing along the chord (so the three points stay collinear in float32). Each comes with its pixels.
function cases(S, h, atStart) {
  const out = [];
  for (const dir of DIRS)
    for (const L of LENS) {
      const e = [L * dir[0], L * dir[1]];
      const P = atStart
        ? [[0, 0], [h * e[0], h * e[1]], e]
        : [[0, 0], [e[0] - h * e[0], e[1] - h * e[1]], e];
      const p = P.map(([x, y]) => [f(x * S), f(y * S)]);
      const len = Math.hypot(p[2][0] - p[0][0], p[2][1] - p[0][1]);
      const D = [(p[2][0] - p[0][0]) / len, (p[2][1] - p[0][1]) / len];
      const halfW = f(0.05 * len);
      const V = atStart ? p[0] : p[2];
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
      out.push({ p, halfW, px });
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
            k: K_STROKE_QUAD,
            bb: [rel[0][0], rel[0][1], rel[1][0], rel[1][1]],
            c: rel[2],
            ePx: [4, q.halfW],
            GD: [1, 1, 0, 0],
            ex: [0, 0, 0, 0],
          });
          meta.push({ b, halfW: q.halfW });
        }
      const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
      for (let i = 0; i < qs.length; i++) {
        const e = Math.abs(got[i] - meta[i].b.want) / meta[i].halfW;
        n++;
        if (e > 1e-3) bad++;
        if (e > worst) {
          worst = e;
          at = `handle ${h}, depth ${meta[i].b.r}, lateral ${meta[i].b.s}: ${(got[i] / meta[i].halfW).toFixed(3)} for ${(meta[i].b.want / meta[i].halfW).toFixed(3)} halfW`;
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
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
if (!hasCxx()) {
  console.log(
    '  SKIPPED (a), (b), (d, shader): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  const emu = buildGlslEmu(ROOT, { stroke: true });
  const wEnd = shaderWorst(emu, false),
    wStart = shaderWorst(emu, true);
  ok(
    [...wEnd.values()].every((v) => v.bad === 0),
    `(a) behind and before a short or zero END handle the shader's distance is the butt-capped segment's to 1e-3 halfW -- ${fmt(wEnd)}`,
  );
  ok(
    [...wStart.values()].every((v) => v.bad === 0),
    `(b) ...and at the START -- ${fmt(wStart)}`,
  );

  // ---- (d) the shader mutation -----------------------------------------------------------------------------------------------
  const HINGE = 'bool fromEnd = dot(p3, p3) < dot(p1, p1);';
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

// ---- (c) the hit test ----------------------------------------------------------------------------------------------------------
const GEOM_PATH = path.join(ROOT, 'src/hitTest/curveGeom.js');
const GEOM_SRC = readFileSync(GEOM_PATH, 'utf8');
const loadGeom = (src) =>
  import(
    'data:text/javascript;base64,' +
      Buffer.from(
        src.replace(
          /from '(\.\.?\/[^']+)'/g,
          (m, rel) => `from '${new URL(rel, pathToFileURL(GEOM_PATH)).href}'`,
        ),
      ).toString('base64')
  );
function hitWrong(geom) {
  const bad = [];
  let n = 0;
  for (const S of SCALES)
    for (const h of HANDLES)
      for (const atStart of [false, true])
        for (const q of cases(S, h, atStart)) {
          const seg = {
            t: geom.SEG_QUAD,
            x0: q.p[0][0],
            y0: q.p[0][1],
            cx: q.p[1][0],
            cy: q.p[1][1],
            x1: q.p[2][0],
            y1: q.p[2][1],
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
            if (geom.pointOnStroke([seg], b.c[0], b.c[1], q.halfW, 0, 0, 4, null, 0) !== b.r <= 0)
              bad.push(
                `${atStart ? 'start' : 'end'} handle ${h} depth ${b.r} lateral ${b.s} at ${lg(S)}`,
              );
          }
        }
  return { bad, n };
}
{
  const r = hitWrong(await loadGeom(GEOM_SRC));
  ok(
    r.bad.length === 0,
    `(c) the hit test puts every point past a butt cap off the stroke and every one before it on (${r.bad.length} of ${r.n} wrong${r.bad.length ? ': ' + r.bad.slice(0, 3).join('; ') : ''})`,
  );
  const HINGE = 'const rev = dE < dS;';
  // The quad's choice is the first occurrence (String.replace takes only that one); the cubic's, which strokeCubicZeroSpeedEndSmoke covers, is the second.
  ok(
    GEOM_SRC.split(HINGE).length === 3 &&
      GEOM_SRC.indexOf(HINGE) <
        GEOM_SRC.indexOf('SEG_CUBIC', GEOM_SRC.indexOf('export function closest')),
    "(d) the hit test's nearer-end choice is in curveGeom.js for the quad and the cubic (the mutation hinge is the quad's)",
  );
  const m = hitWrong(await loadGeom(GEOM_SRC.replace(HINGE, 'const rev = false;')));
  ok(
    m.bad.length > 0,
    `(d) the start-only solve restored in the hit test is caught (${m.bad.length} of ${m.n} wrong: ${m.bad.slice(0, 2).join('; ')})`,
  );
}

console.log(fail ? `STROKE-QUAD-ZERO-SPEED-END FAIL (${fail})` : 'STROKE-QUAD-ZERO-SPEED-END PASS');
process.exit(fail ? 1 : 0);
