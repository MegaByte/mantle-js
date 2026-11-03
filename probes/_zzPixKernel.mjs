// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPixKernel — replicate the kernel's per-patch coverage at ONE named pixel, from the PACKAGE'S
// packed planes.
//
// Every other instrument here answers "how wrong is the frame". This answers "what does each patch
// SAY about this pixel, and what should it say" -- which is the question a dropped edge pixel
// actually poses, and the one no render-side probe can reach. It reads the planes the packer emits
// (not a re-derived decomposition), evaluates each constraint's signed distance in PIXELS exactly
// as the kernel does, and reports the per-patch minimum beside the exact area of the two tightest
// half-planes' intersection.
//
// It found the lead it was written for. On Roboto 'N' at 512px, pixel (314,209), whose exact
// coverage is 0.496 and which CPatch paints WHITE:
//
//   patch 2: min=0.000  exactBoxCov2=0.496
//            k0 n=(-0.84,0.55) sd=-0.003px cov=0.648 | k8C n=(-0.84,0.55) sd=-0.003px cov=0.000
//
// The seam and the outline are the same PLANE there, the patch's own edge is mid-ramp, and the
// minimum of a ramp and a step is the step. Note what that means for the package kernel: cov is
// under CP_SEAM_NEAR, so the existing relaxation should already have used cutSoft (~0.496) and
// painted it. It does not -- so the fragment at that pixel is not evaluating patch 2 at all, and
// the cover reach, the cuts, the hull planes, the cell grid and the depth claim have each been
// ruled out by measurement. That contradiction is the next thing to resolve.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
globalThis.__CP_PLANES = [];
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { insideContour } = await import('../src/renderer/cpatchConvert.js');

const sec = await importSvg(readFileSync(process.argv[2], 'utf8'), { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const N = +(process.env.N || 512);
const [PI, PJ] = (process.env.PIX || '314,209').split(',').map(Number);
const bb = sec.globalBBox || sec.bbox;
const W = bb[2] - bb[0],
  H = bb[3] - bb[1];
const arX = Math.min(1, W / H),
  arY = Math.min(1, H / W > 1 ? 1 : 1 / (W / H));
const emX = (i) => bb[0] + (W * (((2 * (i + 0.5)) / N - 1) / arX + 1)) / 2;
const emY = (j) => bb[1] + H * (1 - (((2 * (j + 0.5)) / N - 1) / Math.min(1, 1 / (W / H)) + 1) / 2);
const x = emX(PI),
  y = emY(PJ),
  pxEm = emX(1) - emX(0);
// SHAPE=n, because an asset with 300 shapes has 300 different answers and shape 0 is almost never
// the one a wrong pixel belongs to. The frame probes name the shape beside every defect they
// report (s13, s96, ...); this takes that number. Unset still means shape 0, which is what a
// single-glyph asset wants.
const SHAPE = +(process.env.SHAPE || 0);
const r = sec.curveRangesByShape[SHAPE];
if (!r) {
  console.log(`no shape ${SHAPE} (asset has ${sec.curveRangesByShape.length})`);
  process.exit(1);
}
const list = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
packCPatchShape(list, 0, {});
const P = globalThis.__CP_PLANES;
const src = [];
for (const c of list) for (const g of c) src.push(g);
console.log(
  `pixel(${PI},${PJ}) em(${x.toFixed(3)},${y.toFixed(3)}) pxEm=${pxEm.toFixed(4)} insideShape=${insideContour(src, x, y)}`,
);
console.log(`packed planes: ${P.length}`);
// exactBoxCov: area of the unit pixel box on the >=0 side of a plane at signed distance sd (px),
// with unit normal n. Mirrors _boxCov.glsl.
const boxCov = (nx, ny, sd) => {
  const a = Math.abs(nx),
    b = Math.abs(ny);
  const hi = (a + b) / 2,
    lo = Math.abs(a - b) / 2;
  if (sd >= hi) return 1;
  if (sd <= -hi) return 0;
  const f = (u) => {
    // integral of clamped area; piecewise-quadratic
    if (u <= -hi) return 0;
    if (u >= hi) return 1;
    if (hi - lo < 1e-12) return (u + hi) / (2 * hi);
    if (u <= -lo) return ((u + hi) * (u + hi)) / (2 * (hi * hi - lo * lo));
    if (u >= lo) return 1 - ((hi - u) * (hi - u)) / (2 * (hi * hi - lo * lo));
    return (u + hi) / (hi + lo) - lo / (2 * (hi + lo)) - lo / (2 * (hi + lo));
  };
  return Math.min(1, Math.max(0, f(sd)));
};
const G = 4; // constraints per patch for this shape
for (let g = 0; g + G <= P.length; g += G) {
  const parts = [];
  let mn = 1;
  for (let k = 0; k < G; k++) {
    const e = P[g + k];
    const L = Math.hypot(e.a[0], e.a[1]) || 1;
    const sd = (e.a[0] * x + e.a[1] * y + e.a[2]) / L / pxEm;
    const isCut = e.kind > 7.5;
    const cov = isCut ? (sd >= -0.001 ? 1 : 0) : boxCov(e.a[0] / L, e.a[1] / L, sd);
    mn = Math.min(mn, cov);
    parts.push(
      `k${e.kind}${isCut ? 'C' : ''} n=(${(e.a[0] / L).toFixed(2)},${(e.a[1] / L).toFixed(2)}) sd=${sd.toFixed(3)}px cov=${cov.toFixed(3)}`,
    );
  }
  // exact area of the intersection of the tightest edge and tightest cut, on the pixel box
  let best = null,
    bestC = null;
  for (let k = 0; k < G; k++) {
    const e = P[g + k];
    const L = Math.hypot(e.a[0], e.a[1]) || 1;
    const sd = (e.a[0] * x + e.a[1] * y + e.a[2]) / L / pxEm;
    const n = [e.a[0] / L, e.a[1] / L];
    if (e.kind > 7.5) {
      if (!bestC || sd < bestC.sd) bestC = { n, sd };
    } else {
      const c = boxCov(n[0], n[1], sd);
      if (!best || c < best.c) best = { n, sd, c };
    }
  }
  let inter = '-';
  if (best && bestC) {
    // Sutherland-Hodgman clip of [-.5,.5]^2 by {n.p <= sd} for each (mirrors exactBoxCov2's convention)
    let poly = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    for (const h of [
      [[-best.n[0], -best.n[1]], best.sd],
      [[-bestC.n[0], -bestC.n[1]], bestC.sd],
    ]) {
      const [n, d] = h,
        out2 = [];
      for (let k = 0; k < poly.length; k++) {
        const A = poly[k],
          B = poly[(k + 1) % poly.length];
        const da = n[0] * A[0] + n[1] * A[1] - d,
          db = n[0] * B[0] + n[1] * B[1] - d;
        if (da <= 0) out2.push(A);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          out2.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
        }
      }
      poly = out2;
      if (!poly.length) break;
    }
    let a2 = 0;
    for (let k = 0; k < poly.length; k++) {
      const A = poly[k],
        B = poly[(k + 1) % poly.length];
      a2 += A[0] * B[1] - B[0] * A[1];
    }
    inter = Math.abs(a2 / 2).toFixed(3);
  }
  console.log(
    `  patch ${g / G}: min=${mn.toFixed(3)} exactBoxCov2=${inter}   ` + parts.join(' | '),
  );
}
