// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCubicEndTangentSmoke — a stroked cubic's END DIRECTIONS are the encoder's, at every coordinate scale
// (_strokeMath.glsl strokeCubicAccum's dStart / dEnd, and the hit test's tangentStart / tangentEnd in
// src/hitTest/curveGeom.js; the rule's owner is src/svg/textures.js segTangentAt).
//
// THE RULE. The encoder takes the end handle 3 (p2 - p1), else the next handle p3 - p2, else the chord, each while it is
// over 1e-9 of the control-point span; strokeCubicAccum must take the same fallback. Forming the end derivative as
// Horner's 3a + 2b + c at t = 1 sums segment-sized terms to get one the size of the end handle (and the end POINT as
// a + b + c + d), so a coincident handle -- an SVG `S` continuation writes p2 == p1 -- would take a rounding residue
// pointing anywhere into the cap and the join (a butt cap 0.8-0.9 halfW off at every scale), and a short end handle would
// come out tilted by cancellation, 7.7e-3 halfW for a handle 1e-6 of the span. The start (3 (p2 - p1) is Horner's c, a
// direct difference) is exact either way. The hit test must use the same relative rule: an absolute |d|^2 < 1e-18 and a
// different second choice (c2 - p0) would take a handle under ~1e-3 of the span at 2^-20.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// (a) cubics with the tested end's handle 1e-2 .. 1e-6 of the span perpendicular to the chord, or ZERO (p2 == p1 / p3 == p4:
//     the encoder takes the next handle), or DOUBLE zero (p1 == p2 == p3: the chord), at 2^-20, 1 and 2^20, each end
//     butt-capped: at pixels BEHIND each end along the encoder's tangent the shader's distance is the butt cap's, halfW + the
//     depth behind the plane the ENCODER's tangent defines, to 1e-4 halfW;
// (b) the hit test's own end direction (tangentStart / tangentEnd, which its caps and joins are built from) is the
//     encoder's on the same points, at every scale;
// (c) mutations: the shader's Horner end derivative with no fallback restored is caught by (a); the hit test's absolute
//     rule restored is caught by (b) at 2^-20.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasCxx, buildGlslEmu, K_STROKE_CUBIC } from './_glslEmu.mjs';
import { segTangentAt } from '../src/svg/textures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;
const SEG_CUBIC = 2;

/// The families: the chord runs along +x, and the tested end's handle is perpendicular to it (short), absent (zero: the
/// next handle is the direction), or absent twice over (double zero: the chord is).
const FAMS = [];
for (const h of [1e-2, 1e-3, 1e-4, 1e-5, 1e-6]) {
  FAMS.push({
    name: `handle ${h}`,
    atStart: true,
    P: [
      [0, 0],
      [0, h],
      [0.7, 0.3],
      [1, 0],
    ],
  });
  FAMS.push({
    name: `handle ${h}`,
    atStart: false,
    P: [
      [0, 0],
      [0.3, 0.3],
      [1, h],
      [1, 0],
    ],
  });
}
FAMS.push({
  name: 'zero handle',
  atStart: true,
  P: [
    [0, 0],
    [0, 0],
    [0.5, 0.4],
    [1, 0],
  ],
});
FAMS.push({
  name: 'zero handle',
  atStart: false,
  P: [
    [0, 0],
    [0.5, 0.4],
    [1, 0],
    [1, 0],
  ],
});
FAMS.push({
  name: 'double zero',
  atStart: true,
  P: [
    [0, 0],
    [0, 0],
    [0, 0],
    [1, 0.5],
  ],
});
FAMS.push({
  name: 'double zero',
  atStart: false,
  P: [
    [0, 0],
    [1, 0.5],
    [1, 0.5],
    [1, 0.5],
  ],
});

function cases(S) {
  return FAMS.map((fam) => {
    const p = fam.P.map(([x, y]) => [f(x * S), f(y * S)]);
    const T = segTangentAt(
      { type: SEG_CUBIC, p1: p[0], p2: p[1], p3: p[2], p4: p[3] },
      fam.atStart,
    );
    const halfW = f(0.05 * S),
      V = fam.atStart ? p[0] : p[3];
    const o = fam.atStart ? [-T[0], -T[1]] : T;
    // sideways AWAY from the rest of the curve, so the end stays the closest point
    let N = [-T[1], T[0]];
    const toRest = [
      p[0][0] + p[1][0] + p[2][0] + p[3][0] - 4 * V[0],
      p[0][1] + p[1][1] + p[2][1] + p[3][1] - 4 * V[1],
    ];
    if (N[0] * toRest[0] + N[1] * toRest[1] > 0) N = [-N[0], -N[1]];
    const px = [];
    for (const r of [0.2, 0.5, 0.8])
      for (const s of [0, 0.4])
        px.push({
          c: [V[0] + (o[0] * r + N[0] * s) * halfW, V[1] + (o[1] * r + N[1] * s) * halfW],
          want: halfW * (1 + r),
        });
    return { ...fam, p, T, o, V, halfW, px };
  });
}

// ---- (a) the shader -------------------------------------------------------------------------------------------------------
function shaderWorst(emu) {
  const worst = new Map();
  for (const S of SCALES) {
    const qs = [],
      meta = [];
    for (const q of cases(S))
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
        meta.push({ q, want: b.want });
      }
    const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
    let w = { d: 0, at: '' };
    for (let i = 0; i < qs.length; i++) {
      const e = Math.abs(got[i] - meta[i].want) / meta[i].q.halfW;
      if (e > w.d)
        w = { d: e, at: `${meta[i].q.name} at the ${meta[i].q.atStart ? 'start' : 'end'}` };
    }
    worst.set(S, w);
  }
  return worst;
}
if (!hasCxx()) {
  console.log(
    '  SKIPPED (a), (c, shader): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const w = shaderWorst(buildGlslEmu(ROOT, { stroke: true }));
  ok(
    [...w.values()].every((v) => v.d <= 1e-4),
    `(a) behind every butt-capped cubic end the shader's distance is the cap plane of the ENCODER's tangent: worst ${[...w].map(([S, v]) => `${v.d.toExponential(1)} halfW at ${lg(S)}${v.d > 1e-4 ? ' (' + v.at + ')' : ''}`).join(', ')} (bar 1e-4)`,
  );

  // ---- (c) the shader mutation --------------------------------------------------------------------------------------------
  const RULE = [
    '  vec2 dEnd = 3.0 * (p34.zw - p34.xy);',
    '  if (!(length(dEnd) > dirMin)) dEnd = p34.xy - p12.zw;',
    '  if (!(length(dEnd) > dirMin)) dEnd = p34.zw - p12.xy;',
  ].join('\n');
  ok(
    GLSL.split(RULE).length === 2,
    '(c) the end rule is in the shipped text once (the mutation hinge)',
  );
  const mut = shaderWorst(
    buildGlslEmu(ROOT, {
      stroke: true,
      glsl: GLSL.replace(RULE, '  vec2 dEnd = vec2(evalCD(cx, 1.0), evalCD(cy, 1.0));'),
    }),
  );
  ok(
    [...mut.values()].every((v) => v.d > 0.1),
    `(c) the Horner end derivative with no fallback restored is caught at every scale: ${[...mut].map(([S, v]) => `${v.d.toFixed(2)} halfW at ${lg(S)} (${v.at})`).join(', ')}`,
  );
}

// ---- (b) the hit test -----------------------------------------------------------------------------------------------------
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
/// The hit test's end direction against the encoder's, on the same float32 control points (both are float64 arithmetic,
/// so they agree to rounding when they take the same vector).
function hitOff(geom) {
  const bad = [];
  let n = 0,
    worst = 0;
  for (const S of SCALES)
    for (const q of cases(S)) {
      const seg = {
        t: geom.SEG_CUBIC,
        x0: q.p[0][0],
        y0: q.p[0][1],
        c1x: q.p[1][0],
        c1y: q.p[1][1],
        c2x: q.p[2][0],
        c2y: q.p[2][1],
        x1: q.p[3][0],
        y1: q.p[3][1],
      };
      const T = q.atStart ? geom.tangentStart(seg) : geom.tangentEnd(seg);
      const e = Math.hypot(T[0] - q.T[0], T[1] - q.T[1]);
      n++;
      worst = Math.max(worst, e);
      if (!(e <= 1e-12))
        bad.push(`${q.name} ${q.atStart ? 'start' : 'end'} at ${lg(S)} (${e.toExponential(1)})`);
    }
  return { bad, n, worst };
}
{
  const r = hitOff(await loadGeom(GEOM_SRC));
  ok(
    typeof (await loadGeom(GEOM_SRC)).tangentStart === 'function',
    '(b) curveGeom.js exports its tangentStart / tangentEnd',
  );
  ok(
    r.bad.length === 0,
    `(b) the hit test's cubic end direction is the encoder's at every scale (${r.bad.length} of ${r.n} differ, worst ${r.worst.toExponential(1)}${r.bad.length ? ': ' + r.bad.slice(0, 3).join('; ') : ''})`,
  );
  const HINGE = 'const m = 1e-9 * cubicSpan(s);';
  ok(
    GEOM_SRC.split(HINGE).length === 2,
    "(c) the hit test's relative rule is in curveGeom.js once (the mutation hinge)",
  );
  const m = hitOff(await loadGeom(GEOM_SRC.replace(HINGE, 'const m = 1e-9;')));
  ok(
    m.bad.length > 0,
    `(c) the absolute rule restored in the hit test is caught (${m.bad.length} of ${m.n} differ: ${m.bad.slice(0, 2).join('; ')})`,
  );
}

console.log(fail ? `STROKE-CUBIC-END-TANGENT FAIL (${fail})` : 'STROKE-CUBIC-END-TANGENT PASS');
process.exit(fail ? 1 : 0);
