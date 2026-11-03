// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _f32Sensitivity — every engine is fed FLOAT32; which of them cares?
//
// The renderer stores curves in a Float32Array (curveRangeToContours takes `curveF32`), and
// every engine consumes it: Loop-Blinn and CPatch build from that same decoder, AAC's bands are
// built from the same floats at import, and Slug walks the buffer in the shader. So float32 is
// not something one engine opted into -- it is the data.
//
// The question is which engine's BUILD is conditioned well enough to survive it. Same 32
// identical 16-segment cubic polygons, control points rounded to float32 or not:
//
//               CPatch patches  unresolved  |  LB primitives  fallback  null
//   float64          128            0       |      1472          0        0
//   float32          484            2       |      1472          0        0
//
// Loop-Blinn is unaffected -- byte-identical output. CPatch produces 3.8x the patches and two
// shapes it cannot resolve.
//
// WHY, and it is not that CPatch is careless: LB evaluates each curve's implicit only NEAR that
// curve, where k^3 - lm is well scaled. CPatch composes one curve's implicit ALONG another and
// asks whether the minimum clears zero -- and a circular-arc cubic is nearly a quadratic, whose
// resultant is ~1e-10 everywhere (this file's own words, elsewhere in the converter). Float32
// noise on the control points is then the same order as the quantity under test, so the
// validator sees violations that are not there and cuts against them.
//
// That makes this a CONDITIONING problem in CPatch's validation, not a data-format problem to
// fix at the source. Raising tolPx hides it; it does not condition the test.
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnPartition } from '../src/renderer/lbPartition.js';
import { SEG_CUBIC } from '../src/primitives/seg.js';
const side = Math.ceil(Math.sqrt(32)),
  cell = 120 / side,
  n = 16;
const f32 = (P) => P.map((q) => [Math.fround(q[0]), Math.fround(q[1])]);
const shape = (cx, cy, r, q) => {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  const cs = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n,
      b = a + (Math.PI * 2) / n,
      p = pts[(i + 1) % n],
      p0 = pts[i];
    const k = (4 / 3) * Math.tan((b - a) / 4) * r;
    let P = [
      p0,
      [p0[0] - Math.sin(a) * k, p0[1] + Math.cos(a) * k],
      [p[0] + Math.sin(b) * k, p[1] - Math.cos(b) * k],
      p,
    ];
    if (q) P = f32(P);
    cs.push(P);
  }
  return cs;
};
for (const q of [false, true]) {
  let cpPatches = 0,
    cpUnres = 0,
    lbTris = 0,
    lbFallback = 0,
    lbNull = 0;
  for (let i = 0; i < 32; i++) {
    const cx = ((i % side) + 0.5) * cell + 4,
      cy = (((i / side) | 0) + 0.5) * cell + 4;
    const raw = shape(cx, cy, cell * 0.38, q);
    // CPatch wants {t,P}
    let r = null;
    try {
      r = convertContour(
        raw.map((P) => ({ t: 'cubic', P })),
        { maxCurves: 8, tolPx: 0.05, holes: null },
      );
    } catch {}
    if (r) {
      cpPatches += r.patches.length;
      cpUnres += r.stats.unresolved | 0;
    }
    // LB wants seg records
    const segs = raw.map((P) => ({ type: SEG_CUBIC, p1: P[0], p2: P[1], p3: P[2], p4: P[3] }));
    let m = null;
    try {
      m = buildLoopBlinnPartition([segs], { fillRule: 'nonzero' });
    } catch {}
    if (!m) {
      lbNull++;
      continue;
    }
    lbTris += (m.interior ? m.interior.length / 6 : 0) + m.cubics.length + m.quads.length;
    lbFallback += m.fallback ? m.fallback.length : 0;
  }
  console.log(
    '  ' +
      (q ? 'float32' : 'float64') +
      '   CPatch patches ' +
      String(cpPatches).padStart(4) +
      '  unresolved ' +
      cpUnres +
      '   |   LB prims ' +
      String(lbTris).padStart(4) +
      '  fallback ' +
      lbFallback +
      '  null ' +
      lbNull,
  );
}
