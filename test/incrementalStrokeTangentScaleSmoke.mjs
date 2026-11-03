// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeTangentScaleSmoke — the join tangents incrementalStroke writes are the encoder's, at every size
//.
//
// WHY. A direction rule with an absolute `length > 1e-12` -- a length -- gives a step no direction at 2^-20 under ~1e-6
// of a unit, so the segment's neighbor gets a zero tangent (encodeSeg's "free end" marker) and the joint loses its join.
// And a hull walk that falls back, for a cubic whose first handle is short, to that handle's own direction however
// short disagrees with the encoder and the pass's fragment stage (_strokeMath.glsl strokeCubicAccum), which take the
// NEXT handle under 1e-9 of the span: the two sides of a join would mean different directions.
//
// SO the directions are svg/textures.js segTangentAt, the encoder's rule: the end handle, else the next handle, else the
// chord, each over 1e-9 of the span, and no direction only within 64 ulps of the segment's coordinates.
//
// The handle is driven with no GL (appendSegments writes the prim texels on the CPU; only a draw uploads them):
// (a) a polyline of 1e-6-unit steps, quads with short and zero handles, cubics with a zero first handle, a zero last
//     handle and a first handle 2.8e-10 of the span, and an arc, at 2^-20, 1 and 2^20: every join texel and free flag
//     is exactly scale 1's, and every interior joint has a unit tangent on both sides;
// (b) every join tangent is the one svg/textures.js segTangentAt gives that neighbour.
import { attachIncrementalStroke } from '../src/renderer/incrementalStroke.js';
import { segTangentAt } from '../src/svg/textures.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;
const SEG_TEXELS = [3, 4, 4, 5]; // LINE, QUAD, CUBIC, ARC (an arc's endpoints texel precedes its join)

/// The segments at scale S (every coordinate a float32 at scale 1, times S: exact), in appendSegments' form.
function segments(S) {
  const P = (x, y) => [f(x) * S, f(y) * S];
  const out = [];
  let x = 0.3;
  for (let i = 0; i < 6; i++) {
    x += ((i % 3) + 1) * 1e-6;
    out.push({ type: 'line', to: P(x, 0.2 + (i & 1) * 1e-6) });
  }
  out.push({ type: 'quad', c1: P(x + 0.1, 0.2), to: P(x + 0.2, 0.5) }); // an ordinary quad
  out.push({ type: 'quad', c1: P(x + 0.2, 0.5 + 1e-7), to: P(x + 0.4, 0.3) }); // a short first handle
  out.push({ type: 'quad', c1: P(x + 0.5, 0.2), to: P(x + 0.5, 0.2) }); // a zero last handle
  out.push({ type: 'cubic', c1: P(x + 0.5, 0.2), c2: P(x + 0.7, 0.6), to: P(x + 0.9, 0.3) }); // a zero first handle
  out.push({ type: 'cubic', c1: P(x + 1.0, 0.1), c2: P(x + 1.1, 0.4), to: P(x + 1.1, 0.4) }); // a zero last handle
  out.push({
    type: 'arc',
    center: P(x + 1.1, 0.9),
    radii: [f(0.5) * S, f(0.3) * S],
    theta: [-Math.PI / 2, 0.4],
    phi: 0,
  });
  // back to the origin, then a cubic whose first handle is 2.8e-10 of its span: NO direction by the encoder's rule
  // (under 1e-9 of the span), which takes the next handle, not the handle's own direction
  out.push({ type: 'line', to: P(0, 0) });
  out.push({ type: 'cubic', c1: [2 ** -32 * S, 2 ** -33 * S], c2: P(0.5, 0.8), to: P(1, 0) });
  return { start: P(0.3, 0.2), out };
}
/// Append at scale S; read back every segment's (type, freeS, freeE, inTan, outTan) and its native points.
function written(S) {
  const R = { gl: {} };
  attachIncrementalStroke(R);
  const { start, out } = segments(S);
  const h = R.createIncrementalStroke({
    width: 0.02 * S,
    bbox: [0, 0, 3 * S, 3 * S],
    joinStyle: 'miter',
    capStyle: 'butt',
  });
  h.appendPoints([start]);
  h.appendSegments(out);
  const segs = [];
  for (let i = 0; i < h.segCount; i++) {
    const b = h.segBase[i] * 4,
      ty = h.prim[b] | 0,
      j = (h.segBase[i] + SEG_TEXELS[ty] - 1) * 4;
    segs.push({
      ty,
      freeS: h.prim[b + 1],
      freeE: h.prim[b + 2],
      sd: h.prim[b + 3],
      tan: Array.from(h.prim.subarray(j, j + 4)),
      pts: h.segsMeta[i] && h.segsMeta[i].pts,
    });
  }
  return segs;
}
/// The encoder's direction at one end of a written segment, from its native points.
function encoderDir(sg, atStart) {
  const p = sg.pts;
  const s =
    sg.ty === 3
      ? {
          type: 3,
          cx: p[0][0],
          cy: p[0][1],
          rx: p[1][0],
          ry: p[1][1],
          theta_start: p[2][0],
          theta_end: p[2][1],
          phi: p[3][0],
        }
      : sg.ty === 1
        ? { type: 1, p1: p[0], p2: p[1], p3: p[2] }
        : sg.ty === 2
          ? { type: 2, p1: p[0], p2: p[1], p3: p[2], p4: p[3] }
          : { type: 0, p1: p[0], p2: p[1] };
  return segTangentAt(s, atStart);
}

const one = written(1);
for (const S of [2 ** -20, 2 ** 20]) {
  const at = written(S);
  let bad = 0,
    first = '';
  for (let i = 0; i < one.length; i++) {
    const a = one[i],
      b = at[i];
    const same =
      a.ty === b.ty &&
      a.freeS === b.freeS &&
      a.freeE === b.freeE &&
      a.tan.every((v, k) => v === b.tan[k]);
    if (!same) {
      bad++;
      if (!first)
        first = `segment ${i}: tangents ${b.tan.map((v) => v.toFixed(3))} for ${a.tan.map((v) => v.toFixed(3))}`;
    }
  }
  const zero = at.filter(
    (s, i) =>
      i > 0 &&
      i < at.length - 1 &&
      (Math.hypot(s.tan[0], s.tan[1]) < 0.5 || Math.hypot(s.tan[2], s.tan[3]) < 0.5),
  ).length;
  ok(
    bad === 0 && zero === 0,
    `(a) at ${lg(S)}: ${bad} of ${one.length} segments' join texels differ from scale 1's, ${zero} interior joints without a direction${first ? ' -- first ' + first : ''}`,
  );
}
{
  let bad = 0,
    n = 0,
    first = '';
  for (let i = 1; i < one.length; i++) {
    const prev = one[i - 1],
      cur = one[i];
    if (!prev.pts || !cur.pts) continue;
    const wantIn = encoderDir(prev, false),
      wantOut = encoderDir(cur, true);
    n += 2;
    const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    if (!near([cur.tan[0], cur.tan[1]], wantIn)) {
      bad++;
      if (!first)
        first = `segment ${i} inTan ${cur.tan.slice(0, 2).map((v) => v.toFixed(4))} for ${wantIn.map((v) => v.toFixed(4))}`;
    }
    if (!near([prev.tan[2], prev.tan[3]], wantOut)) {
      bad++;
      if (!first)
        first = `segment ${i - 1} outTan ${prev.tan.slice(2).map((v) => v.toFixed(4))} for ${wantOut.map((v) => v.toFixed(4))}`;
    }
  }
  ok(
    bad === 0,
    `(b) ${n - bad} of ${n} join tangents are the encoder's (segTangentAt)${first ? ' -- first off: ' + first : ''}`,
  );
}
console.log(
  fail
    ? `INCREMENTAL-STROKE-TANGENT-SCALE FAIL (${fail})`
    : 'INCREMENTAL-STROKE-TANGENT-SCALE PASS',
);
process.exit(fail ? 1 : 0);
