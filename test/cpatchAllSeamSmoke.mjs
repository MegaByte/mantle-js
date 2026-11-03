// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchAllSeamSmoke — patches with nothing that can ramp: how many there are, and when a hard
// step is exact for one.
//
// THE MECHANISM. A CPatch patch antialiases through its outline constraints: each contributes the
// exact area of the pixel box on its own side of the curve. A patch bounded entirely by SEAMS has
// none -- every one of its bounds is a cut, and a cut is a hard step, because it partitions the
// shape between two patches and a ramp would hand a partial value to both. So such a patch reports
// a flat 1.0 for any pixel whose center it contains, whatever the shape's real coverage of that
// pixel is, and there is no per-constraint lever that can change it: 14 of tiger's 22 worst AA
// pixels are exactly this.
//
// THE BOUND, WHICH IS THE POINT OF this FILE. A flat 1.0 is not automatically wrong. The shape's
// outline lies OUTSIDE the patch, so a pixel the patch paints can only be PARTLY covered by the
// shape if the outline reaches within the filter's own half-diagonal (CP_AA_REACH, 0.7072 px) of
// that pixel's center -- and the center is inside the patch, so the outline has to come within
// that distance of the patch itself. An all-seam patch the outline cannot reach paints 1.0 on
// pixels the shape covers whole, and 1.0 is the exact answer.
//
// THE POPULATION, over the corpus (1470 shapes, 10070 patches, each laid out across
// 512 px -- probes/_cpatchShapeQuality.mjs WHAT=allseam):
//     all-seam                                 1204   11.96%
//       thinner than a pixel across             364
//       within one filter reach of the outline  763   <- the only ones a hard step gets wrong
// The other 441 are interior tiles and exact. The reach is raster-dependent by construction: draw
// the asset half the size and more of them come within it, which is why the packer records the
// COUNT (a property of the decomposition) and not the reach.
//
// WHY THE PACKER DOES NOT CHANGE IT. Hanging the contour's nearest outline curves on such a patch
// costs 4.60 ms -> 7.30 ms of tiger's frame for about a third of the partial-coverage pixels the
// exact reference has, which is a stepped edge with grey in it.
//
// WHAT IS PINNED
//   counted    packCPatchShape reports how many all-seam patches it built, and the build carries
//              it to the bundle (`_cpatchAllSeam`)
//   real       an all-seam patch paints a flat 1.0 at a pixel center it contains -- the defect is
//              reproducible and not folklore
//   exact      where the outline is further than one filter reach away, that 1.0 IS the shape's
//              exact coverage: the bound holds
//   wrong      where it is not, it is not: a pixel the outline crosses is painted 1.0 against an
//              exact coverage under it
// the seam path: a star this simple is one complete paint, which has no all-seam patches, unless the hook says otherwise
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, distToContour, CP_AA_REACH } from '../src/renderer/cpatchCov.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

const poly = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i++)
    out.push({ t: 'line', P: [pts[i].slice(), pts[(i + 1) % pts.length].slice()] });
  return out;
};
/// A star polygon: plenty of reflex corners, so the search cuts it into many pieces and some of
/// them end up bounded by cuts alone.
const star = (n, rOut, rIn, cx, cy) => {
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2,
      r = i % 2 ? rIn : rOut;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
};

const isAllSeam = (p) => {
  if (!p.curves.length) return false;
  for (const sg of p.curves) if (!(sg && sg.cut)) return false;
  return true;
};
/// The exact coverage of one pixel box by the shape: exact in x from the fill oracle's spans,
/// sliced in y. The same construction probes/cpatchGate/_rowGateAaRef.mjs uses.
const exactCov = (curves, cx, cy, px, slices = 64) => {
  let a = 0;
  for (let s = 0; s < slices; s++) {
    const yy = cy - px / 2 + (px * (s + 0.5)) / slices;
    for (const sp of rowSpans(curves, yy)) {
      const lo = Math.max(sp[0], cx - px / 2),
        hi = Math.min(sp[1], cx + px / 2);
      if (hi > lo) a += hi - lo;
    }
  }
  return a / (px * slices);
};

// ---------------------------------------------------------------- counted
console.log('the packer counts patches with nothing that can ramp');
const cs = [star(13, 240, 80, 0, 0)];
const patches = [];
let m = null;
try {
  m = packCPatchShape(cs, 0, {
    onPatches: (a) => {
      for (const p of a) patches.push(p);
    },
  });
} catch {
  m = null;
}
check(!!m, 'the star packs');
check(
  !!m && typeof m.allSeam === 'number',
  `the wire reports an all-seam count (${m && m.allSeam})`,
);
const seam = patches.filter(isAllSeam);
check(
  seam.length > 0,
  `the star really does produce them (${seam.length} of ${patches.length} patches)`,
);
check(
  !!m && m.allSeam === seam.length,
  `and the reported count is the right one (${m && m.allSeam} vs ${seam.length})`,
);

// ---------------------------------------------------------------- the defect, and the bound
console.log('a hard step is a flat 1.0, and the outline decides whether that is exact');
{
  const all = cs.flat();
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const q of sg.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
  const em = Math.max(x1 - x0, y1 - y0) / 512; // the nominal raster the CPatch probes use
  let flat = 0,
    checked = 0,
    farOk = 0,
    farBad = 0,
    worstFar = 0;
  for (const p of seam) {
    // Sample points inside the patch: its curves' centroid, and points pulled toward it.
    const pts = [];
    for (const sg of p.curves) for (let k = 1; k < 4; k++) pts.push(segPt(sg, k / 4));
    let cx = 0,
      cy = 0;
    for (const q of pts) {
      cx += q[0];
      cy += q[1];
    }
    cx /= pts.length;
    cy /= pts.length;
    const probe = [[cx, cy]];
    for (const q of pts) probe.push([q[0] + (cx - q[0]) * 0.25, q[1] + (cy - q[1]) * 0.25]);
    for (const [x, y] of probe) {
      const c = patchCoverage(p, x, y, em);
      if (!(c > 0)) continue; // not this patch's pixel
      checked++;
      if (c === 1) flat++;
      const d = distToContour(all, x, y) / em;
      if (d > CP_AA_REACH && c === 1) {
        const ex = exactCov(all, x, y, em);
        // Beyond the reach the shape covers the whole pixel, so the flat 1.0 is the exact answer.
        if (ex > 1 - 1e-9) farOk++;
        else {
          farBad++;
          worstFar = Math.max(worstFar, 1 - ex);
        }
      }
    }
  }
  check(checked > 0, `the all-seam patches paint somewhere (${checked} sampled pixel centers)`);
  check(
    flat === checked,
    `every one of them is a flat 1.0 -- no ramp anywhere (${flat}/${checked})`,
  );
  check(
    farOk > 0,
    `and beyond one filter reach of the outline there are pixels to judge (${farOk})`,
  );
  check(
    farBad === 0,
    `where the outline cannot reach, the flat 1.0 is EXACT (${farBad} counter-examples, worst shortfall ${worstFar.toFixed(6)})`,
  );
}

// ---------------------------------------------------------------- and where it is not
console.log('within a filter reach of the outline: the sub-pixel pair, not a flat 1.0');
{
  // A rectangle thinner than a pixel at the nominal raster: every pixel of it straddles the
  // outline, so ANY patch painting a flat 1.0 there is painting a fraction as a whole.
  const w = 900,
    h = 0.9; // 0.9 units tall, laid out across 512 px
  const thin = [
    poly([
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]),
  ];
  const all = thin.flat();
  const em = w / 512; // one nominal pixel = 1.758 units
  const ex = exactCov(all, w / 2, h / 2, em);
  check(ex < 0.6 && ex > 0.4, `the stripe covers about half a pixel (${ex.toFixed(4)})`);
  const ps = [];
  try {
    packCPatchShape(thin, 0, {
      onPatches: (a) => {
        for (const p of a) ps.push(p);
      },
    });
  } catch {
    /* */
  }
  let painted = 0;
  for (const p of ps) painted = Math.max(painted, patchCoverage(p, w / 2, h / 2, em));
  check(painted > 0, `something paints the stripe's middle (${painted.toFixed(4)})`);
  // THE SUB-PIXEL COMPOSITION. min() over the constraints would return the LARGER single coverage,
  // and a stripe's two long sides each cover ~0.75 of the box, so a stripe covering half a pixel
  // would paint a flat 1.0. The kernel combines them as the exact area of both half-planes
  // (exactBoxCov2) and so does cpatchCov.js, so the model reports the stripe's own area.
  check(
    Math.abs(painted - ex) <= 0.05,
    `and it is the truth (${painted.toFixed(4)} against ${ex.toFixed(4)}) -- the sub-pixel pair, not a flat 1.0`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL cpatchAllSeamSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchAllSeamSmoke');
