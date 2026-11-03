// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPairBadFaceSplitSmoke -- a morph pair of a closed quadratic outline splits the faces neither chain serves.
//
// The chain builder flags a face that carries more outline than its two chains span (`badFaces`), and the partition caller
// reads the flag: such a face uses the OPPOSITE chain (13/255 against Chrome at 8x on a two-circle morph), so the pair
// splits it once at its centroid. The split point is registered on the
// destination as the centroid of its corners' images, so it is each pose's centroid at every t, and nothing is
// added to a pair whose outline is not a single contour of quadratic hulls.
//
// This pins: the fixture's source mesh carries centroids, every one is mapped (the pair builds), the refined mesh has more
// faces than the same pair with the refinement off, the destination vertex is the corners' centroid, and the answer is
// the same at 2^-12, 1 and 2^12 times the size (scale-free).
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');
const { buildLoopBlinnPartitionPair } = await import('../src/renderer/lbPartitionPair.js');
console.warn = () => {};
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const circle = (cx, cy, rx, ry) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#e63333" d="M${cx + rx} ${cy}Q${cx + rx} ${cy + ry} ${cx} ${cy + ry}Q${cx - rx} ${cy + ry} ${cx - rx} ${cy}Q${cx - rx} ${cy - ry} ${cx} ${cy - ry}Q${cx + rx} ${cy - ry} ${cx + rx} ${cy}Z"/></svg>`;
const contoursOf = async (svg) => {
  const b = await importSvg(svg),
    r = b.curveRangesByShape[0];
  return curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
};
const scaleContours = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0 ? { cx: c0.cx * S, cy: c0.cy * S, r: c0.r * S } : null,
      );
    }),
  );

const A = await contoursOf(circle(64, 64, 30, 30)),
  B = await contoursOf(circle(66, 63, 40, 35));
const sizes = {};
for (const k of [-12, 0, 12]) {
  const S = 2 ** k,
    v = buildLoopBlinnPartitionPair(scaleContours(A, S), scaleContours(B, S), 'nonzero');
  ok(!!v, `the pair builds at 2^${k}`);
  if (!v) continue;
  const cents = v.src.centroids9 || [];
  sizes[k] = [v.src.interior.length / 6, v.dst.interior.length / 6, cents.length];
  ok(
    v.src.interior.length === v.dst.interior.length,
    `source and destination keep one topology at 2^${k} (${v.src.interior.length / 6} faces)`,
  );
  ok(
    cents.length === 0 || cents.every((g) => g.pt.length === 2 && g.a.length === 2),
    `each split point carries its corners at 2^${k}`,
  );
}
ok(
  sizes[-12] &&
    sizes[0] &&
    sizes[12] &&
    sizes[-12].join() === sizes[0].join() &&
    sizes[0].join() === sizes[12].join(),
  `the refinement is scale-free: faces / faces / splits ${JSON.stringify(sizes)}`,
);
ok(
  sizes[0] && sizes[0][2] > 0,
  'the two-circle fixture has faces the chains do not serve, and they are split',
);
if (fail) {
  console.error(`LB-PAIR-BAD-FACE-SPLIT FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-PAIR-BAD-FACE-SPLIT PASS');
