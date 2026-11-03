// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeQuadBoundsSmoke — the split-stroke pass rasterizes a quad that covers its segment, and not much more
//.
//
// THE COST. Every fragment of a segment's quad (incrementalStroke's route, _strokeVertexSetup.glsl) runs the whole
// stroke solve, so the hull's AXIS-ALIGNED box dilated by the stroke's reach is wasteful: a 45-degree line 100 px long
// at half-width 2 px would shade ~6,500 px for the ~1,100 it can reach, and an arc's whole-ellipse box more.
//
// A line or a curve takes its hull's box in the frame of its CHORD (the hull's points projected on the chord and
// its normal), and an arc the box of its endpoints and the axis extremes its sweep passes. Both are conservative: the
// hull holds the curve, the sweep box holds the arc, and the reach is the same.
//
// Both stages run from their shipped text in float32 (test/_glslEmu.mjs buildSplitStrokeEmu, the corner read back from
// strokeVertexSetup):
// (a) CONSERVATIVE: over 240 random lines, quads, cubics and arcs with random free ends, neighbour tangents, caps,
//     joins and miter limits, every fragment the pass paints (coverage > 0) lies inside its quad;
// (b) TIGHT: the 45-degree line's quad is at most a quarter of its axis-aligned box, and a quarter-sweep arc's at most
//     40% of its whole ellipse's box.
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { mkLine, mkQuad, mkCubic } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
const emu = EMU.buildSplitStrokeEmu(ROOT);

/// The quad the vertex stage emits for the segment at `base`: four corners.
function quadOf(prim, base, halfW, cap, join, miterLimit) {
  const qs = [];
  for (let m = 1; m <= 8; m++)
    qs.push({ base, c: [0, 0], ePx: [1, 1], halfW, cap, join, miterLimit, corner: m });
  const o = emu.run(prim, qs);
  return [
    [o[0], o[1]],
    [o[2], o[3]],
    [o[4], o[5]],
    [o[6], o[7]],
  ];
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/// Inside a convex quad (either winding), by a margin of a hundredth of a pixel.
const inQuad = (Q, p) => {
  const s = [0, 1, 2, 3].map(
    (i) =>
      cross(Q[i], Q[(i + 1) & 3], p) /
      Math.hypot(Q[(i + 1) & 3][0] - Q[i][0], Q[(i + 1) & 3][1] - Q[i][1]),
  );
  return s.every((v) => v >= -0.01) || s.every((v) => v <= 0.01);
};
const area = (Q) => Math.abs(cross(Q[0], Q[1], Q[2]) + cross(Q[0], Q[2], Q[3])) / 2;
const mkArc = (cx, cy, rx, ry, phi, th0, th1) => {
  const ev = (th) => [
    cx + rx * Math.cos(phi) * Math.cos(th) - ry * Math.sin(phi) * Math.sin(th),
    cy + rx * Math.sin(phi) * Math.cos(th) + ry * Math.cos(phi) * Math.sin(th),
  ];
  // an arc carries its endpoints (p1, p4) as segment.js mkArc builds it: encodeSeg stores them in the record
  return {
    type: 3,
    cx,
    cy,
    rx,
    ry,
    phi,
    theta_start: th0,
    theta_end: th1,
    p1: ev(th0),
    p4: ev(th1),
  };
};

// ---- (a) conservative ------------------------------------------------------------------------------------------------
{
  let seed = 0x5e65;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const P = () => [Math.fround(rnd() * 40 - 20), Math.fround(rnd() * 40 - 20)];
  const U = () => {
    const a = rnd() * 6.283;
    return [Math.cos(a), Math.sin(a)];
  };
  let n = 0,
    out = 0,
    first = '';
  for (let k = 0; k < 240; k++) {
    const ty = k % 4;
    const s =
      ty === 0
        ? mkLine(P(), P())
        : ty === 1
          ? mkQuad(P(), P(), P())
          : ty === 2
            ? mkCubic(P(), P(), P(), P())
            : mkArc(
                rnd() * 10 - 5,
                rnd() * 10 - 5,
                3 + rnd() * 15,
                3 + rnd() * 15,
                rnd() * 3.14,
                rnd() * 6.28,
                0,
              );
    if (ty === 3) {
      s.theta_end = s.theta_start + (rnd() < 0.5 ? 1 : -1) * (0.2 + rnd() * 5);
      Object.assign(s, mkArc(s.cx, s.cy, s.rx, s.ry, s.phi, s.theta_start, s.theta_end)); // its end moved with it
    }
    const fs = rnd() < 0.4,
      fe = rnd() < 0.4;
    const buf = makeTexelBuffer();
    const base = encodeSeg(s, buf, fs, fe, fs ? [0, 0] : U(), fe ? [0, 0] : U(), 0);
    const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
    const halfW = 0.3 + rnd() * 5,
      cap = k % 3,
      join = (k >> 2) % 5,
      miterLimit = [1, 1.5, 4, 10][k % 4];
    const Q = quadOf(prim, base, halfW, cap, join, miterLimit);
    const qs = [];
    for (let j = 0; j < 90; j++)
      for (let i = 0; i < 90; i++)
        qs.push({
          base,
          c: [-60 + (i * 120) / 90 + 0.013, -60 + (j * 120) / 90 + 0.029],
          ePx: [1, 1],
          halfW,
          cap,
          join,
          miterLimit,
        });
    const cov = emu.run(prim, qs);
    cov.forEach((v, i) => {
      if (!(v > 0)) return;
      n++;
      if (!inQuad(Q, qs[i].c)) {
        out++;
        if (!first)
          first = `segment ${k} (type ${ty}) at (${qs[i].c.map((x) => x.toFixed(2))}), coverage ${v.toFixed(3)}`;
      }
    });
  }
  ok(
    n > 10000 && out === 0,
    `(a) of ${n} painted fragments over 240 random segments, ${out} fall outside their quad${first ? ' -- first ' + first : ''}`,
  );
}

// ---- (b) tight ---------------------------------------------------------------------------------------------------------
{
  const aabb = (Q) => {
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  const one = (s, halfW) => {
    const buf = makeTexelBuffer();
    const base = encodeSeg(s, buf, true, true, [0, 0], [0, 0], 0);
    return quadOf(new Float32Array(buf.floats.subarray(0, buf.count * 4)), base, halfW, 0, 1, 4);
  };
  const L = 100 / Math.SQRT2,
    line = one(mkLine([0, 0], [L, L]), 2);
  // the axis-aligned box it would have been: the segment's own box dilated by the same reach (halfW + 3 px margin)
  const r = 2 + 3,
    lineWas = (L + 2 * r) * (L + 2 * r);
  ok(
    area(line) <= 0.25 * lineWas,
    `(b) a 45-degree line 100 px long, half-width 2 px: its quad ${area(line).toFixed(0)} px against the axis-aligned box's ${lineWas.toFixed(0)} (bar a quarter)`,
  );
  const arc = one(mkArc(0, 0, 50, 50, 0, 0.3, 0.3 + Math.PI / 2), 2),
    arcWas = (100 + 2 * r) * (100 + 2 * r);
  ok(
    area(arc) <= 0.4 * arcWas,
    `(b) a quarter of a circle of radius 50 px: its quad ${area(arc).toFixed(0)} px against the whole ellipse's box ${arcWas.toFixed(0)} (bar 40%)`,
  );
  ok(
    Math.abs(aabb(arc) - area(arc)) < 1e-3 * area(arc),
    '(b) (an arc keeps an axis-aligned box: the sweep box is one)',
  );
}
console.log(fail ? `SPLIT-STROKE-QUAD-BOUNDS FAIL (${fail})` : 'SPLIT-STROKE-QUAD-BOUNDS PASS');
process.exit(fail ? 1 : 0);
