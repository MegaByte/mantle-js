// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeQuadTangentScaleSmoke — a stroked quad's END DIRECTIONS are the encoder's, at every coordinate scale
// (_strokeMath.glsl strokeQuadAccum's dStart / dEnd, and the hit test's tangentStart / tangentEnd in
// src/hitTest/curveGeom.js; the rule's owner is src/svg/textures.js segTangentAt).
//
// THE HAZARD. The encoder takes the chord for a quad end only under 1e-9 of the segment's control-point span (DEG_REL),
// and it is what hands a segment's NEIGHBOUR its idea of this end's tangent, while the cap and join planes at that end
// are built from the shader's own. A shader that took the CHORD whenever |d|^2 < 1e-18 -- an absolute length -- would,
// at 2^-20, take the chord for a quad whose handle is under ~5e-4 of its span where the encoder takes the handle: its butt
// cap turned by up to 90 degrees against the same drawing at scale 1, and a join's two sides disagreeing about the
// direction they meet in. The hit test must use the same relative rule.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// (a) quads with a handle 1e-2 .. 1e-5 of their span perpendicular to the chord, at 2^-20, 1 and 2^20, each
//     end butt-capped: at pixels BEHIND each end along the encoder's tangent the shader's distance is exactly the
//     butt cap's, halfW + the depth behind the plane the ENCODER's tangent defines. That also needs the end derivative
//     formed as the encoder forms it, 2 (p3 - p2): as 2A + B it cancels segment-sized terms down to the handle and
//     comes out tilted, 2.4e-3 halfW at the cap for a handle 1e-5 of the span, at every scale;
// (b) the hit test cuts the same pixels off at every scale (a point half a width behind the cap plane is not on the
//     stroke), with a zero handle as well;
// (c) mutation: the absolute |d|^2 < 1e-18 restored is caught by (a) at 2^-20.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_STROKE_QUAD } from './_glslEmu.mjs';
import { segTangentAt } from '../src/svg/textures.js';
import { pointOnStroke, SEG_QUAD } from '../src/hitTest/curveGeom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;
// Handles the float32 fragment-relative coordinates can hold. A handle under DEG_REL is also under float32's resolution
// of those coordinates, so it reads as zero in the shader under either rule; the hit test takes the zero handle too.
// The SHADER leaves it out for a reason of its own, found here and not fixed: a quad whose control point sits ON its end
// point has zero speed at t = 1, quadClosestT stalls short of the `t > 1 - 1e-4` end gate, and the butt cap is skipped --
// a pixel 0.8 halfW past that end reads 1.0 halfW nearer than the cap plane, at every scale (the start is unaffected).
const HANDLES = [1e-2, 1e-3, 1e-4, 1e-5];

/// One quad per handle and end: the chord runs along +x, and the handle at the tested end runs along +y (start) or
/// comes in along -y (end), so the derivative and the chord are perpendicular there. Float32 coordinates, as stored.
function quads(S, handles = HANDLES) {
  const out = [];
  for (const h of handles)
    for (const atStart of [true, false]) {
      const P = atStart
        ? [
            [0, 0],
            [0, h],
            [1, 0],
          ]
        : [
            [0, 0],
            [1, h],
            [1, 0],
          ];
      const p = P.map(([x, y]) => [f(x * S), f(y * S)]);
      out.push({
        h,
        atStart,
        p,
        T: segTangentAt({ type: SEG_QUAD, p1: p[0], p2: p[1], p3: p[2] }, atStart),
        halfW: f(0.05 * S),
        S,
      });
    }
  return out;
}
/// Pixels behind the tested end, along the ENCODER's tangent T (outward: -T at the start, +T at the end), offset
/// sideways away from the rest of the curve so the end stays the closest point.
function behind(q) {
  const V = q.atStart ? q.p[0] : q.p[2];
  const out = q.atStart ? [-q.T[0], -q.T[1]] : [q.T[0], q.T[1]];
  let N = [-q.T[1], q.T[0]];
  const toRest = [
    q.p[1][0] + q.p[2][0] + q.p[0][0] - 3 * V[0],
    q.p[1][1] + q.p[2][1] + q.p[0][1] - 3 * V[1],
  ];
  if (N[0] * toRest[0] + N[1] * toRest[1] > 0) N = [-N[0], -N[1]];
  const pts = [];
  for (const r of [0.2, 0.5, 0.8])
    for (const s of [0, 0.4]) {
      pts.push({
        c: [V[0] + (out[0] * r + N[0] * s) * q.halfW, V[1] + (out[1] * r + N[1] * s) * q.halfW],
        depth: r * q.halfW,
      });
    }
  return pts;
}

// ---- (a) the shader -------------------------------------------------------------------------------------------------------
function shaderWorst(emu) {
  const worst = new Map(SCALES.map((S) => [S, { d: 0, at: '' }]));
  for (const S of SCALES) {
    const qs = [],
      meta = [];
    for (const q of quads(S))
      for (const b of behind(q)) {
        const rel = q.p.map(([x, y]) => [f(x - b.c[0]), f(y - b.c[1])]);
        qs.push({
          k: K_STROKE_QUAD,
          bb: [rel[0][0], rel[0][1], rel[1][0], rel[1][1]],
          c: rel[2],
          ePx: [4, q.halfW],
          GD: [1, 1, 0, 0],
          ex: [0, 0, 0, 0],
        });
        meta.push({ q, want: q.halfW + b.depth });
      }
    const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
    for (let i = 0; i < qs.length; i++) {
      const e = Math.abs(got[i] - meta[i].want) / meta[i].q.halfW;
      if (e > worst.get(S).d)
        worst.set(S, {
          d: e,
          at: `handle ${meta[i].q.h} at the ${meta[i].q.atStart ? 'start' : 'end'}`,
        });
    }
  }
  return worst;
}
if (!hasCxx()) {
  console.log(
    '  SKIPPED (a), (c): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const w = shaderWorst(buildGlslEmu(ROOT, { stroke: true }));
  ok(
    [...w.values()].every((v) => v.d <= 1e-4),
    `(a) behind every butt-capped end the shader's distance is the cap plane of the ENCODER's tangent: worst ${[...w].map(([S, v]) => `${v.d.toExponential(1)} halfW at ${lg(S)}${v.d > 1e-4 ? ' (' + v.at + ')' : ''}`).join(', ')} (bar 1e-4)`,
  );

  // ---- (c) mutation -----------------------------------------------------------------------------------------------------------
  const RULE = 'if (!(length(dStart) > dirMin)) dStart = p3 - p1;';
  ok(
    GLSL.split(RULE).length === 2,
    '(c) the relative start rule is in the shipped text once (the mutation hinge)',
  );
  const mut = shaderWorst(
    buildGlslEmu(ROOT, {
      stroke: true,
      glsl: GLSL.replace(RULE, 'if (dot(dStart, dStart) < 1e-18) dStart = p3 - p1;').replace(
        'if (!(length(dEnd) > dirMin)) dEnd = p3 - p1;',
        'if (dot(dEnd, dEnd) < 1e-18) dEnd = p3 - p1;',
      ),
    }),
  );
  ok(
    mut.get(2 ** -20).d > 0.1,
    `(c) the absolute |d|^2 < 1e-18 restored is caught: ${mut.get(2 ** -20).d.toFixed(2)} halfW off at 2^-20 (${mut.get(2 ** -20).at})`,
  );
}

// ---- (b) the hit test ------------------------------------------------------------------------------------------------------
{
  const bad = [];
  let n = 0;
  for (const S of SCALES)
    for (const q of quads(S, [...HANDLES, 0])) {
      const seg = {
        t: SEG_QUAD,
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
      const V = q.atStart ? q.p[0] : q.p[2],
        o = q.atStart ? -1 : 1;
      const c = [V[0] + o * q.T[0] * 0.5 * q.halfW, V[1] + o * q.T[1] * 0.5 * q.halfW];
      n++;
      if (pointOnStroke([seg], c[0], c[1], q.halfW, 0, 0, 4, null, 0))
        bad.push(`handle ${q.h} ${q.atStart ? 'start' : 'end'} at ${lg(S)}`);
    }
  ok(
    bad.length === 0,
    `(b) the hit test cuts off the point half a width behind every butt cap, at every scale (${bad.length} of ${n} painted${bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''})`,
  );
}

console.log(fail ? `STROKE-QUAD-TANGENT-SCALE FAIL (${fail})` : 'STROKE-QUAD-TANGENT-SCALE PASS');
process.exit(fail ? 1 : 0);
