// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzEdgeRoots — an exact detector for the over-paint the ten-point audit misses.
//
// Both cubic implicits are degree 3 in position (klmn's k^3 - l*m with k,l,m affine, and the
// Bezout determinant alike), so restricted to a triangle EDGE each is a univariate cubic with
// exact roots. A hull crescent's zero set should meet the triangle's boundary only where its own
// ARC does -- at the two curve endpoints. Any further crossing means another branch of the
// algebraic curve enters the triangle, and the region the piece paints is no longer just the
// crescent. That is the family the sampled audit steps over: it looks at ten interior points and a
// wedge that enters through one edge can miss all of them.
//
// Sound in one direction only, and deliberately: no extra crossing does NOT prove the piece is
// clean (a cubic can carry an isolated oval wholly inside the triangle). It is a detector, and
// this measures how well it separates the shapes that over-paint from the ones that do not.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { solveCubicInUnit } from '../src/svg/pathBoolean/polyRoots.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);

// f along the segment A->B, as a cubic in t. Four samples determine a cubic exactly, so the
// coefficients come from the implicit itself with no derivation per kind: Lagrange on t = 0,
// 1/3, 2/3, 1 inverted to the power basis.
function edgeCubic(fAt, A, B) {
  const f0 = fAt(A[0], A[1]);
  const f1 = fAt(A[0] + (B[0] - A[0]) / 3, A[1] + (B[1] - A[1]) / 3);
  const f2 = fAt(A[0] + (2 * (B[0] - A[0])) / 3, A[1] + (2 * (B[1] - A[1])) / 3);
  const f3 = fAt(B[0], B[1]);
  // p(t) = d + c t + b t^2 + a t^3 through those four values.
  const d = f0;
  const a = (-9 * f0 + 27 * f1 - 27 * f2 + 9 * f3) / 2;
  const b = (18 * f0 - 45 * f1 + 36 * f2 - 9 * f3) / 2;
  const c = (-11 * f0 + 18 * f1 - 9 * f2 + 2 * f3) / 2;
  return [a, b, c, d];
}

const REL = +(process.env.REL || 1e-6);
function extraRoots(c9) {
  const H = c9.hull;
  const n = H.length / 2;
  if (n < 3) return 0;
  let fAt;
  if (c9.klmn) {
    const e1x = H[2] - H[0],
      e1y = H[3] - H[1],
      e2x = H[4] - H[0],
      e2y = H[5] - H[1];
    const det = e1x * e2y - e1y * e2x;
    if (!(Math.abs(det) > 1e-12 * Math.sqrt((e1x * e1x + e1y * e1y) * (e2x * e2x + e2y * e2y))))
      return 0;
    const T = c9.klmn;
    fAt = (x, y) => {
      const w1 = ((x - H[0]) * e2y - (y - H[1]) * e2x) / det;
      const w2 = (e1x * (y - H[1]) - e1y * (x - H[0])) / det;
      const w0 = 1 - w1 - w2;
      const k = w0 * T[0] + w1 * T[3] + w2 * T[6];
      const l = w0 * T[1] + w1 * T[4] + w2 * T[7];
      const m = w0 * T[2] + w1 * T[5] + w2 * T[8];
      return c9.sign * (k * k * k - l * m);
    };
  } else if (c9.F) fAt = (x, y) => c9.sign * evalBezout(c9.F, x, y);
  else return 0;
  // The curve's own endpoints, so a root AT one of them is expected rather than extra.
  const ends = c9.cp ? [c9.cp[0], c9.cp[3]] : [];
  let extra = 0;
  for (let i = 0; i < n; i++) {
    const A = [H[2 * i], H[2 * i + 1]],
      B = [H[(2 * i + 2) % (2 * n)], H[(2 * i + 3) % (2 * n)]];
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (!(L > 0)) continue;
    const [a, b, c, d] = edgeCubic(fAt, A, B);
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (!(scale > 0)) continue;
    for (const t of solveCubicInUnit(a, b, c, d) || []) {
      const X = A[0] + t * (B[0] - A[0]),
        Y = A[1] + t * (B[1] - A[1]);
      let atEnd = false;
      for (const e of ends)
        if (Math.hypot(X - e[0], Y - e[1]) <= REL * L * 1e3 + 1e-9) atEnd = true;
      // A root sitting on a triangle CORNER is an endpoint meeting the hull, not a new branch.
      for (let k = 0; k < n && !atEnd; k++)
        if (Math.hypot(X - H[2 * k], Y - H[2 * k + 1]) <= 1e-6 * L) atEnd = true;
      if (!atEnd) extra++;
    }
  }
  return extra;
}

const GUILTY = new Set((process.env.GUILTY || '').split(',').filter(Boolean).map(Number));
const rows = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (!m || !m.cubics) continue; // declined already: not this detector's business
  let ex = 0,
    pieces = 0;
  for (const c9 of m.cubics) {
    pieces++;
    ex += extraRoots(c9);
  }
  rows.push({ s, ex, pieces });
}
const flagged = rows.filter((r) => r.ex > 0);
console.log(
  `${rows.length} LB-routed shapes; ${flagged.length} have a piece whose implicit crosses its own hull boundary away from the arc`,
);
if (GUILTY.size) {
  const g = rows.filter((r) => GUILTY.has(r.s)),
    c = rows.filter((r) => !GUILTY.has(r.s));
  const hit = g.filter((r) => r.ex > 0).length,
    fp = c.filter((r) => r.ex > 0).length;
  console.log(
    `  of the ${g.length} shapes MEASURED to over-paint alone, it flags ${hit} (${((100 * hit) / Math.max(1, g.length)).toFixed(0)}%)`,
  );
  console.log(
    `  of the ${c.length} measured CLEAN, it flags ${fp} (${((100 * fp) / Math.max(1, c.length)).toFixed(0)}%)`,
  );
}
console.log(
  '  worst: ' +
    flagged
      .sort((a, b) => b.ex - a.ex)
      .slice(0, 12)
      .map((r) => `s${r.s}:${r.ex}/${r.pieces}`)
      .join(' '),
);
