// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeArcQuadEdgeSmoke — the split-stroke segment quad's two float edge cases.
//
// THE HAZARDS in _strokeVertexSetup.glsl:
// (a) a FULL-SWEEP arc (|dth| >= 2 pi) taking all four axis extremes, with rx or ry 0 at phi a multiple of pi/2, hits
//     atan(0, 0) for one of them, which GLSL leaves undefined. A NaN extreme always included, with min/max of a NaN the
//     driver's to pick, can collapse the quad.
// (b) a chord direction of ch / length(ch) squares the chord: under ~1e-19 em it underflows to a denormal, and
//     without flush-to-zero ax comes out not unit length, shrinking the box and its reach by |ax|.
//
// A full turn takes the whole ellipse's box (its half-extents, over the larger radius so no square under- or
// overflows) and the chord is taken over its larger component before it is normalized.
//
// Both stages run from their shipped text in float32 (test/_glslEmu.mjs buildSplitStrokeEmu). `nanPoison` builds the
// GPU the spec permits at its edges -- atan(0, 0) a NaN, min/max handing a NaN back -- which libm's answers (0, and the
// NaN dropped) hide:
// (a) full-sweep arcs, rx or ry 0 at phi 0, pi/2, pi and 3 pi/2, and a round one, one and a half turns included: the
//     quad's corners are finite and every painted fragment lies inside it, under the poisoned build and the default;
// (b) a round-capped line, quad and cubic whose chord is 2.7e-23 to 3.8e-23 em (a stroke of half-width 1, ten pixels
//     to the em): every painted fragment -- the cap's whole disc -- lies inside the quad. The chord's squared length
//     rounds to the smallest denormal, 1.4e-45, so ch / length(ch) would be 0.72 long and the quad fall short of the disc.
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
const EMUS = [
  ['default', EMU.buildSplitStrokeEmu(ROOT)],
  ['nanPoison', EMU.buildSplitStrokeEmu(ROOT, { nanPoison: true })],
];

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const inQuad = (Q, p, tol) => {
  const s = [0, 1, 2, 3].map(
    (i) =>
      cross(Q[i], Q[(i + 1) & 3], p) /
      Math.hypot(Q[(i + 1) & 3][0] - Q[i][0], Q[(i + 1) & 3][1] - Q[i][1]),
  );
  return s.every((v) => v >= -tol) || s.every((v) => v <= tol);
};
const mkArc = (cx, cy, rx, ry, phi, th0, th1) => {
  const ev = (th) => [
    cx + rx * Math.cos(phi) * Math.cos(th) - ry * Math.sin(phi) * Math.sin(th),
    cy + rx * Math.sin(phi) * Math.cos(th) + ry * Math.cos(phi) * Math.sin(th),
  ];
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
/// One free-ended segment: its quad, and its painted fragments on an em grid over [x0, x1] x [y0, y1].
function sweep(emu, s, st, box, pitch, view = null) {
  const buf = makeTexelBuffer();
  const base = encodeSeg(s, buf, true, true, [0, 0], [0, 0], 0);
  const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
  const cq = [];
  for (let m = 1; m <= 8; m++) cq.push({ base, c: [0, 0], ePx: [1, 1], ...st, corner: m });
  const o = emu.run(prim, cq, view);
  const Q = [
    [o[0], o[1]],
    [o[2], o[3]],
    [o[4], o[5]],
    [o[6], o[7]],
  ];
  const qs = [];
  for (let y = box[1] + 0.37 * pitch; y < box[3]; y += pitch)
    for (let x = box[0] + 0.61 * pitch; x < box[2]; x += pitch) {
      qs.push({ base, c: [Math.fround(x), Math.fround(y)], ePx: [0.1, 0.1], ...st });
    }
  const cov = emu.run(prim, qs, view);
  let n = 0,
    out = 0;
  cov.forEach((v, i) => {
    if (v > 0) {
      n++;
      if (!inQuad(Q, qs[i].c, 1e-3)) out++;
    }
  });
  return { finite: o.every(Number.isFinite), n, out, Q };
}

// ---- (a) full-sweep arcs with a zero radius --------------------------------------------------------------------------
for (const [tag, emu] of EMUS) {
  let bad = 0,
    n = 0,
    cases = 0,
    first = '';
  for (const [rx, ry] of [
    [0, 6],
    [6, 0],
    [5, 5],
  ])
    for (const phi of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI])
      for (const turns of [1, 1.5]) {
        const th0 = 0.4,
          s = mkArc(0, 0, rx, ry, phi, th0, th0 + turns * 2 * Math.PI);
        const r = sweep(
          emu,
          s,
          { halfW: 0.5, cap: 1, join: 1, miterLimit: 4 },
          [-8, -8, 8, 8],
          0.05,
        );
        cases++;
        n += r.n;
        if (!r.finite || r.out || r.n < 50) {
          bad++;
          if (!first)
            first = ` -- first rx ${rx} ry ${ry} phi ${phi.toFixed(2)} x${turns}: corners ${r.finite ? 'finite' : 'NaN'}, ${r.out} of ${r.n} painted outside`;
        }
      }
  ok(
    bad === 0,
    `(a) ${tag}: ${cases} full-sweep arcs (rx or ry 0 at phi a multiple of pi/2, and round): ${bad} with a non-finite quad or a painted fragment outside it (${n} painted)${first}`,
  );
}

// ---- (b) tiny chords ---------------------------------------------------------------------------------------------------
{
  const [, emu] = EMUS[0];
  const view = { bbox: [-5, -5, 10, 10], canvasAR: [1, 1], viewport: [100, 100], worldM: null }; // 0.1 em a pixel
  for (const [name, s] of [
    ['line, chord 3.8e-23 at 45 degrees', mkLine([0, 0], [2.7e-23, 2.7e-23])],
    ['line, chord 2.7e-23 upright', mkLine([0, 0], [0, 2.7e-23])],
    ['quad, chord 3.8e-23', mkQuad([0, 0], [1e-23, 2e-23], [2.7e-23, 2.7e-23])],
    ['cubic, chord 3.8e-23', mkCubic([0, 0], [-1e-23, 2e-23], [3e-23, 1e-23], [2.7e-23, 2.7e-23])],
  ]) {
    const r = sweep(
      emu,
      s,
      { halfW: 1, cap: 1, join: 1, miterLimit: 4 },
      [-2, -2, 2, 2],
      0.02,
      view,
    );
    ok(
      r.finite && r.n > 5000 && r.out === 0,
      `(b) ${name}, round caps, half-width 1: ${r.out} of ${r.n} painted fragments outside the quad`,
    );
  }
}
console.log(fail ? `SPLIT-STROKE-ARC-QUAD-EDGE FAIL (${fail})` : 'SPLIT-STROKE-ARC-QUAD-EDGE PASS');
process.exit(fail ? 1 : 0);
