// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamMorphSmoke -- a shape morph of a CLOSED DASHED contour carries the contour's length at every pose.
//
// svg/textures.js writes -L (L the contour's arc length) into the free-start field of the first segment of a closed dashed contour and the free-end field of
// its last (encodeSeg), and a morph recomputes every segment's startDist per pose (core/morphDashMetrics.js) because arc length is not linear in t. The
// seam lengths are not either: the morph writes them with the startDists, on the CPU (the plane it uploads) and in the GPU fixup pass (shapeMorph.js FIX_DASH
// with the flags in its fourth attribute). This is the CPU half, and the GPU half's INPUT: for poses t = 0, 0.3, 0.5, 1 of a square -> rectangle and a circle ->
// ellipse (four cubics each), the plan's (startDist, L) per segment, written into the lerped plane, equal what a fresh import of that pose's geometry
// writes in the same fields. The pose geometry is the control points' lerp, which is exactly what the morph's plane lerp is.
//   SMOKE_SRC_DIR=<a src tree> runs another tree's core/morphDashMetrics.js
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { buildMorphPlan, composeMorphSections } from '../src/core/morphCore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SMOKE_SRC_DIR || null;
const { prepareMorphDashMetrics, updateMorphDashMetrics } = await import(
  pathToFileURL(path.join(SRC || path.join(ROOT, 'src'), 'core/morphDashMetrics.js')).href
);
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const asBundle = (b) => ({
  ...b,
  metaFloats: new Float32Array(b.meta, 32),
  curveFloats: new Float32Array(b.curves),
  shapeIds: b.shapeIds || [],
});
const doc = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${d}" fill="none" stroke="#000" stroke-width="6" stroke-dasharray="14 10" stroke-dashoffset="3"/></svg>`;
const K = 0.5522847498307936;
// paths as point lists so a pose is a componentwise lerp
const SQUARE = [
    [25, 25],
    [75, 25],
    [75, 75],
    [25, 75],
  ],
  RECT = [
    [15, 35],
    [85, 30],
    [90, 65],
    [20, 70],
  ];
const lineD = (P) =>
  `M${P[0]} ${P.slice(1)
    .map((p) => `L${p}`)
    .join(' ')} Z`;
function cubicsD(cx, cy, rx, ry) {
  const P = (x, y) => `${x} ${y}`;
  return (
    `M${P(cx + rx, cy)} C${P(cx + rx, cy + K * ry)} ${P(cx + K * rx, cy + ry)} ${P(cx, cy + ry)} C${P(cx - K * rx, cy + ry)} ${P(cx - rx, cy + K * ry)} ${P(cx - rx, cy)} ` +
    `C${P(cx - rx, cy - K * ry)} ${P(cx - K * rx, cy - ry)} ${P(cx, cy - ry)} C${P(cx + K * rx, cy - ry)} ${P(cx + rx, cy - K * ry)} ${P(cx + rx, cy)} Z`
  );
}
const lerpP = (A, B, t) =>
  A.map((p, i) => [p[0] * (1 - t) + B[i][0] * t, p[1] * (1 - t) + B[i][1] * t]);
const lerp = (a, b, t) => a * (1 - t) + b * t;
const headers = (curves) => {
  // [startDist, free-start, free-end] of every segment, in plane order
  const out = [];
  for (let h = 4; h + 8 <= curves.length;) {
    const x = curves[h];
    if (!(x >= 0 && x < 16 && x === Math.floor(x))) break;
    out.push({ h, y: curves[h + 1], z: curves[h + 2], w: curves[h + 3] });
    h += (x & 3) === 0 ? 12 : (x & 3) === 3 ? 20 : 16;
  }
  return out;
};

async function pair(name, srcD, dstD, poseD) {
  console.log(`\n-- ${name} --`);
  const src = asBundle(await importSvg(doc(srcD), { compat: 'chrome' })),
    dst = asBundle(await importSvg(doc(dstD), { compat: 'chrome' }));
  const sections = composeMorphSections(src, dst, buildMorphPlan(src, dst));
  const plan = prepareMorphDashMetrics(sections);
  ok(plan && plan.anySeam, 'the plan finds the closed dashed contour (seam segments flagged)');
  const A = sections._srcEpCurveF32 || sections._mergedCurveF32,
    B = sections._dstEpCurveF32 || sections._dstCurveF32;
  for (const t of [0, 0.3, 0.5, 1]) {
    const target = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) target[i] = A[i] * (1 - t) + B[i] * t; // the plane lerp (lines/cubics only here)
    updateMorphDashMetrics(plan, t, target);
    const fresh = headers(
        new Float32Array((await importSvg(doc(poseD(t)), { compat: 'chrome' })).curves),
      ),
      got = headers(target);
    let worst = 0,
      n = 0;
    for (let i = 0; i < fresh.length; i++)
      for (const k of ['y', 'z', 'w']) {
        const a = got[i][k],
          b = fresh[i][k],
          scale = Math.max(1, Math.abs(b), Math.abs(fresh[0].y));
        worst = Math.max(worst, Math.abs(a - b) / scale);
        n++;
      }
    const L = -fresh[0].y;
    ok(
      got.length === fresh.length && worst < 2e-5,
      `t=${t}: ${n} header fields (startDist, seam -L) match a fresh import of the pose, worst relative ${worst.toExponential(2)} (L = ${L.toFixed(3)}; first seg y ${got[0].y.toFixed(3)}, last seg z ${got[got.length - 1].z.toFixed(3)})`,
    );
  }
}
await pair('square -> quadrilateral (lines)', lineD(SQUARE), lineD(RECT), (t) =>
  lineD(lerpP(SQUARE, RECT, t)),
);
{
  const c = (t) => cubicsD(lerp(50, 52, t), lerp(50, 48, t), lerp(26, 40, t), lerp(26, 14, t));
  await pair('circle -> ellipse (four cubics)', c(0), c(1), c);
}
console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
