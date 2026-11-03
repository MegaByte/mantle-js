// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// How far apart do consecutive segments' shared endpoints land, per plane?
//
// The arrangement merges nodes at 1e-11 of the drawing's diagonal. If narrowing the curve plane to
// float32 moves a shared endpoint further than that, the contour stops chaining and its cycle
// never closes -- which is the whole question behind "can CPatch read float32 like every other
// renderer does".
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const file = process.argv[2];
const sections = await importSvg(readFileSync(file, 'utf8'));
const ranges = sections.curveRangesByShape || [];
let diag = 0;
{
  const c = new Float64Array(sections.curves64);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 3 < c.length; i += 4) {
    if (c[i] < x0) x0 = c[i];
    if (c[i] > x1) x1 = c[i];
    if (c[i + 1] < y0) y0 = c[i + 1];
    if (c[i + 1] > y1) y1 = c[i + 1];
  }
  diag = Math.hypot(x1 - x0, y1 - y0);
}
const tol = Math.max(1e-12, 1e-11 * (diag || 1));

for (const plane of ['f64', 'f32']) {
  const cf =
    plane === 'f64' ? new Float64Array(sections.curves64) : new Float32Array(sections.curves);
  let worst = 0,
    overTol = 0,
    pairs = 0,
    byType = new Map();
  for (const r of ranges) {
    const begin = r.begin | 0,
      end = (r.end != null ? r.end : r.begin + r.count) | 0;
    if (end <= begin) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, begin, end);
    } catch {
      continue;
    }
    const list = contoursToConverter(contours || [], null);
    if (!list) continue;
    for (const cs of list) {
      for (let i = 0; i < cs.length; i++) {
        const a = segPt(cs[i], 1),
          b = segPt(cs[(i + 1) % cs.length], 0);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        pairs++;
        if (d > worst) worst = d;
        if (d > tol) {
          overTol++;
          const k = cs[i].t + '->' + cs[(i + 1) % cs.length].t;
          byType.set(k, (byType.get(k) || 0) + 1);
        }
      }
    }
  }
  console.log(
    `${plane}: diag ${diag.toFixed(1)}, node tol ${tol.toExponential(2)}, ` +
      `${pairs} joins, worst gap ${worst.toExponential(3)}, ${overTol} exceed the tolerance`,
  );
  if (overTol)
    console.log(
      '     by segment pair:',
      [...byType.entries()].map(([k, v]) => `${k} x${v}`).join(', '),
    );
}
