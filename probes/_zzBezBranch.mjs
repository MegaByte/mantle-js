// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBezBranch — how many Bezout crescents have a zero of the resultant INSIDE their own hull that
// is not their own arc? That is the stray ink: measured at three over-painting pixels the implicit
// puts its zero 0.035-0.063 px away while the drawn arc is 0.76-0.95 px away, so the fragment sits
// on a branch the Bezier never traces. A bound cannot separate them -- a disc at |n|<=2 and the
// arc's own span slab are both inert -- so the question is whether the HULL can be made to exclude
// them, and that question starts with how many pieces are affected and how far in the branch sits.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const at = (cp, t) => {
  const u = 1 - t;
  return [
    u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0],
    u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1],
  ];
};
const arcDist = (cp, x, y) => {
  let best = Infinity;
  for (let k = 0; k <= 256; k++) {
    const P = at(cp, k / 256);
    const d = (P[0] - x) * (P[0] - x) + (P[1] - y) * (P[1] - y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
};
const SH = (process.env.SHAPES || Array.from({ length: 260 }, (_, i) => i).join(','))
  .split(',')
  .map(Number);
const M = +(process.env.GRID || 24);
let nBez = 0,
  nBad = 0,
  nGap = 0;
const frac = [];
const gaps = [];
for (const s of SH) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = 1;
  let m = null;
  try {
    m = buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
      fillRule: evenOdd ? 'evenodd' : 'nonzero',
    });
  } catch {
    continue;
  }
  if (!m) continue;
  for (const c of m.cubics || []) {
    if (c.klmn || !c.F || !c.cp) continue;
    nBez++;
    const H = c.hull,
      n = H.length / 2;
    const chord = Math.hypot(c.cp[3][0] - c.cp[0][0], c.cp[3][1] - c.cp[0][1]) || 1;
    // Barycentric sweep of the hull's fan triangles, looking for a point that reads as ON a zero
    // (|f| / |grad f| tiny against the chord) while the DRAWN arc is far (a twentieth of the chord
    // or more). Both thresholds are relative to the piece, so this says the same thing at any size.
    let worst = 0,
      worstGap = 0;
    for (let ti = 1; ti + 1 < n; ti++) {
      const A = [H[0], H[1]],
        B = [H[2 * ti], H[2 * ti + 1]],
        C = [H[2 * ti + 2], H[2 * ti + 3]];
      for (let a = 0; a <= M; a++)
        for (let b = 0; a + b <= M; b++) {
          const wa = a / M,
            wb = b / M,
            wc = 1 - wa - wb;
          const x = wa * A[0] + wb * B[0] + wc * C[0],
            y = wa * A[1] + wb * B[1] + wc * C[1];
          const h = 1e-5 * chord;
          const f0 = evalBezout(c.F, x, y);
          const gx = (evalBezout(c.F, x + h, y) - evalBezout(c.F, x - h, y)) / (2 * h);
          const gy = (evalBezout(c.F, x, y + h) - evalBezout(c.F, x, y - h)) / (2 * h);
          const g = Math.hypot(gx, gy);
          if (!(g > 0)) continue;
          const impl = Math.abs(f0) / g;
          const ad = arcDist(c.cp, x, y);
          // HOW BADLY THE IMPLICIT MISREPRESENTS THE DISTANCE TO ITS own ARC. Near the arc a faithful
          // implicit has |f|/|grad f| ~ the arc distance; where a second branch runs, the implied
          // distance collapses while the real one does not, and the kernel then ramps coverage --
          // painting ink outside the path, or cutting a hole in a pixel the path covers whole.
          // Measured in the frame: an interior pixel of s97 reads 0.282 px from a zero while its
          // arc is 4.536 px away, and renders 0.80 where the path says 1.000.
          if (ad - impl > worstGap) worstGap = ad - impl;
          if (impl > 0.004 * chord) continue; // not on a zero
          if (ad > worst) worst = ad;
        }
    }
    if (worst > 0.05 * chord) {
      nBad++;
    }
    gaps.push(worstGap / chord);
    if (worstGap > 0.05 * chord) {
      nGap++;
      frac.push(worstGap / chord);
    }
  }
}
frac.sort((a, b) => a - b);
const q = (f) =>
  frac.length ? frac[Math.min(frac.length - 1, Math.floor(f * frac.length))].toFixed(3) : 'n/a';
gaps.sort((a, b) => a - b);
const qg = (f) =>
  gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(f * gaps.length))].toFixed(3) : 'n/a';
console.log(`${nBez} Bezout crescents.`);
console.log(
  `  ${nBad} (${((100 * nBad) / Math.max(1, nBez)).toFixed(1)}%) carry a zero in their own hull that is not their arc`,
);
console.log(
  `  ${nGap} (${((100 * nGap) / Math.max(1, nBez)).toFixed(1)}%) understate the distance to their own arc by more than 5% of the chord`,
);
console.log(
  `  worst understatement per crescent, over the chord:  median ${qg(0.5)}  p90 ${qg(0.9)}  max ${qg(1)}`,
);
