// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbKlmnRowsSmoke — every Loop-Blinn klmn face carries its piece's own implicit at its vertices AS STORED.
//
// k, l and m are one affine function of position over a whole cubic piece. The morph pair's destination reads a face's
// rows over the piece's widest control triangle at the face's float32 corners. Rows read over the face's own fan
// triangle, at the float64 point the float32 corner was rounded from, and then moved with the finished mesh from the
// shape's own frame back into place (every corner rounded a second time, the rows left as they were), would describe
// the curve displaced by up to a float32 ulp of its corners -- a relative row error that grows as the piece shrinks
// against its coordinates (up to 2.1e-4 of the rows' scale on tiger).
//
// So the static build reads rows over the widest control triangle (lbCubicMath klmnWidestFrame9, the destination's own
// frame), at each corner as stored, and translateLoopBlinnRaw re-reads them at the corners it moves.
//
// No GPU. Against the piece's implicit (the least-squares plane of its four control points' klmn, which is exact for
// an affine function), relative to the rows' scale:
//   - every klmn face of tiger's static build, 1e-6 at most (float32 storage of the rows is 6e-8);
//   - every source and destination klmn face of the morph corpus's synthetic pairs moved 4096 units out, the same.
import { tigerOrFixture } from './_tigerOrFixture.mjs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const LC = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { cubicKLMN } = await import('../src/geom/lbCubicMath.js');
const PAIR = await import('../src/renderer/lbPartitionPair.js');
const { synthPairs } = await import('../probes/morphScale/_morphPairs.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

/// The worst distance, over a face's three corners, between its rows and its piece's implicit there, relative to the
/// largest |k|, |l|, |m| at the piece's control points.
function faceDev(c) {
  const K = cubicKLMN(c.cp);
  if (!K) return null;
  const P = c.cp,
    mx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4,
    my = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  let sxx = 0,
    sxy = 0,
    syy = 0;
  for (const Q of P) {
    const dx = Q[0] - mx,
      dy = Q[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const det = sxx * syy - sxy * sxy;
  let scale = 0;
  const fit = ['k', 'l', 'm'].map((q) => {
    const v = K[q],
      mv = (v[0] + v[1] + v[2] + v[3]) / 4;
    let sxv = 0,
      syv = 0;
    for (let j = 0; j < 4; j++) {
      sxv += (P[j][0] - mx) * v[j];
      syv += (P[j][1] - my) * v[j];
      scale = Math.max(scale, Math.abs(v[j]));
    }
    const a = (syy * sxv - sxy * syv) / det,
      b = (sxx * syv - sxy * sxv) / det;
    return (X, Y) => mv + a * (X - mx) + b * (Y - my);
  });
  let w = 0;
  for (let v = 0; v < 3; v++)
    for (let q = 0; q < 3; q++)
      w = Math.max(
        w,
        Math.abs(fit[q](c.hull[2 * v], c.hull[2 * v + 1]) - c.klmn[3 * v + q]) / scale,
      );
  return w;
}

// ── tiger, static ─────────────────────────────────────────────────────────────────────────────────
{
  const bun = await importSvg(tigerOrFixture());
  const pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
    mst = pm.floatsPerShape,
    meta = pm.metaFloats,
    cf = new Float32Array(bun.curves);
  let faces = 0,
    over = 0,
    worst = 0;
  for (let s = 0; s < bun.numShapes; s++) {
    const r = bun.curveRangesByShape[s];
    let Cs;
    try {
      Cs = LC.curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    let b = null;
    try {
      b = buildLbShape(Cs, false, meta[s * mst + 13] > 0.5);
    } catch {
      b = null;
    }
    if (!b || !b.raw) continue;
    for (const c of b.raw.cubics || []) {
      if (!c.klmn || !c.cp) continue;
      const w = faceDev(c);
      if (w == null) continue;
      faces++;
      if (w > 1e-6) over++;
      worst = Math.max(worst, w);
    }
  }
  ok(
    faces > 1000 && over === 0,
    `tiger, static: ${over} of ${faces} klmn faces more than 1e-6 from their piece's implicit (worst ${worst.toExponential(2)})`,
  );
}

// ── the morph corpus's synthetic pairs, both streams, moved 4096 units out ─────────────────────────
// A float32 ulp at 4096 is 4.9e-4, which makes the rounding of a corner a visible fraction of a 20-unit piece.
{
  const mv = (C) =>
    C.map((c) =>
      c.map((g) => ({
        ...g,
        p1: g.p1 && [g.p1[0] + 4096, g.p1[1] + 4096],
        p2: g.p2 && [g.p2[0] + 4096, g.p2[1] + 4096],
        p3: g.p3 && [g.p3[0] + 4096, g.p3[1] + 4096],
        p4: g.p4 && [g.p4[0] + 4096, g.p4[1] + 4096],
        ...(g.circle
          ? { circle: { ...g.circle, cx: g.circle.cx + 4096, cy: g.circle.cy + 4096 } }
          : {}),
      })),
    );
  const pairs = (await synthPairs(importSvg, parseMetaBin, LC.curveRangeToContours)).map((p) => ({
    ...p,
    src: mv(p.src),
    dst: mv(p.dst),
  }));
  let faces = 0,
    over = 0,
    worst = 0,
    built = 0;
  for (const p of pairs) {
    let pr = null;
    try {
      pr = PAIR.buildLoopBlinnPartitionPair(p.src, p.dst, p.evenOdd ? 'evenodd' : 'nonzero');
    } catch {
      pr = null;
    }
    if (!pr) continue;
    built++;
    for (const M of [pr.src, pr.dst])
      for (const c of M.cubics || []) {
        if (!c.klmn || !c.cp) continue;
        const w = faceDev(c);
        if (w == null) continue;
        faces++;
        if (w > 1e-6) over++;
        worst = Math.max(worst, w);
      }
  }
  ok(
    faces > 50 && over === 0,
    `the corpus's synthetic pairs (${built} built): ${over} of ${faces} klmn faces more than 1e-6 from their piece's implicit (worst ${worst.toExponential(2)})`,
  );
}

console.warn = warn;
console.log(fail ? `LB-KLMN-ROWS FAIL (${fail})` : 'LB-KLMN-ROWS PASS');
process.exit(fail ? 1 : 0);
