// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBezSplit — does SUBDIVIDING a Bezout piece make its implicit an honest distance function?
//
// A third of tiger's Bezout crescents understate the distance to their own arc by more than 5% of
// their chord, and that is what paints ink outside the path and cuts holes in pixels the path
// covers whole (s97 at (331,505): the implicit reads 0.282 px from a zero, the arc is 4.536 px
// away, and the pixel renders 0.80 against an exact 1.000). If splitting the cubic fixes the
// conditioning, the fix is a split-until-faithful loop and the machinery already exists. If it
// does not, no amount of geometry helps and the kernel has to be given the arc itself.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout, bezoutCubicImplicit } from '../src/geom/lbCubicMath.js';
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
  for (let k = 0; k <= 192; k++) {
    const P = at(cp, k / 192);
    const d = (P[0] - x) * (P[0] - x) + (P[1] - y) * (P[1] - y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
};
// de Casteljau: the two halves of a cubic at t.
const split = (cp, t) => {
  const L = (A, B) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  const a = L(cp[0], cp[1]),
    b = L(cp[1], cp[2]),
    c = L(cp[2], cp[3]);
  const d = L(a, b),
    e = L(b, c),
    f = L(d, e);
  return [
    [cp[0], a, d, f],
    [f, e, c, cp[3]],
  ];
};
// The worst understatement over a cubic's own control hull, as a fraction of its chord.
const badness = (cp, M) => {
  let F = null;
  try {
    F = bezoutCubicImplicit(cp, null);
  } catch {
    return null;
  }
  if (!F) return null;
  const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]) || 1;
  const h = 1e-5 * chord;
  let worst = 0;
  for (let a = 0; a <= M; a++)
    for (let b = 0; a + b <= M; b++) {
      const wa = a / M,
        wb = b / M,
        wc = 1 - wa - wb;
      // sample the control hull as a triangle fan over the 4 control points
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ]) {
        const x = wa * cp[tri[0]][0] + wb * cp[tri[1]][0] + wc * cp[tri[2]][0];
        const y = wa * cp[tri[0]][1] + wb * cp[tri[1]][1] + wc * cp[tri[2]][1];
        const f0 = evalBezout(F, x, y);
        const gx = (evalBezout(F, x + h, y) - evalBezout(F, x - h, y)) / (2 * h);
        const gy = (evalBezout(F, x, y + h) - evalBezout(F, x, y - h)) / (2 * h);
        const g = Math.hypot(gx, gy);
        if (!(g > 0)) continue;
        const gap = arcDist(cp, x, y) - Math.abs(f0) / g;
        if (gap > worst) worst = gap;
      }
    }
  return worst / chord;
};
const M = +(process.env.GRID || 14);
let n = 0,
  bad = 0,
  fixed1 = 0,
  fixed2 = 0,
  stuck = 0;
const after = [];
for (const s of (process.env.SHAPES || '105,12,96,24,97,13,104').split(',').map(Number)) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r) continue;
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
  const seen = new Set();
  for (const c of m.cubics || []) {
    if (c.klmn || !c.cp || c.cp.length !== 4) continue;
    const key = c.cp.map((p) => p.join(',')).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
    const b0 = badness(c.cp, M);
    if (b0 === null) continue;
    if (!(b0 > 0.05)) continue;
    bad++;
    // one split
    const [h1, h2] = split(c.cp, 0.5);
    const b1 = Math.max(badness(h1, M) ?? 9, badness(h2, M) ?? 9);
    if (b1 <= 0.05) {
      fixed1++;
      after.push(b1);
      continue;
    }
    // two splits
    let worst2 = 0;
    for (const half of [h1, h2]) {
      const [q1, q2] = split(half, 0.5);
      worst2 = Math.max(worst2, badness(q1, M) ?? 9, badness(q2, M) ?? 9);
    }
    if (worst2 <= 0.05) {
      fixed2++;
      after.push(worst2);
    } else {
      stuck++;
      after.push(worst2);
    }
  }
}
after.sort((a, b) => a - b);
const q = (f) =>
  after.length ? after[Math.min(after.length - 1, Math.floor(f * after.length))].toFixed(3) : 'n/a';
console.log(
  `${n} distinct Bezout cubics; ${bad} understate their own arc distance by more than 5% of the chord.`,
);
console.log(
  `  of those: ${fixed1} are fixed by ONE split, ${fixed2} more by TWO, ${stuck} still bad after two.`,
);
console.log(`  worst remaining, over the chord:  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`);
