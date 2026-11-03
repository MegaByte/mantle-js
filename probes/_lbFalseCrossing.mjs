// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// How often does the shared-endpoint filter's ABSOLUTE 1e-7 misclassify a join
// as a self-crossing? A false crossing sends a healthy shape through unionPaths,
// which can return a degenerate boundary.
//
// Classifies every hit as: at-join (filtered), NEAR-join (missed by 1e-7 but
// within a scale-relative epsilon => FALSE crossing), or real.
import { readFileSync } from 'fs';
import path from 'path';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { intersectSegments } = await import('../src/svg/pathBoolean/intersect/index.js');
if (typeof intersectSegments !== 'function') throw new Error('intersectSegments did not import');

const endOf = (s) => (s.type === 0 ? s.p2 : s.type === 2 ? s.p4 : s.p3);
const share = (p, q) => Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12;

let tShapes = 0,
  tFalseOnly = 0,
  tReal = 0,
  tClean = 0;
const hits = [];
for (const f of process.env.LIST.split(',').filter(Boolean)) {
  if (process.env.TRACE) console.error('  file ' + path.basename(f));
  let b;
  try {
    b = await importSvg(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const cf = new Float32Array(b.curves);
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    let cs;
    try {
      cs = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!cs) continue;
    const segs = cs.flat();
    if (segs.length > 250) continue; // keep the N^2 scan bounded
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of segs)
      for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!p) continue;
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
    const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
    const scaled = 1e-6 * diag; // what chained() already uses
    tShapes++;
    let nFalse = 0,
      nReal = 0;
    // Bbox pre-filter, as resolveSelfOverlap itself does. Without it the N^2
    // intersectSegments calls allocate enough to OOM the heap on real corpora.
    const bb = segs.map((sg) => {
      let a0 = Infinity,
        b0 = Infinity,
        a1 = -Infinity,
        b1 = -Infinity;
      for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!p) continue;
        a0 = Math.min(a0, p[0]);
        a1 = Math.max(a1, p[0]);
        b0 = Math.min(b0, p[1]);
        b1 = Math.max(b1, p[1]);
      }
      return [a0, a1, b0, b1];
    });
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        const bi = bb[i],
          bj = bb[j];
        if (bi[1] < bj[0] || bj[1] < bi[0] || bi[3] < bj[2] || bj[3] < bi[2]) continue;
        const A = segs[i],
          B = segs[j];
        const sh = [];
        for (const pa of [A.p1, endOf(A)])
          for (const pb of [B.p1, endOf(B)]) if (share(pa, pb)) sh.push(pa);
        let hh;
        try {
          hh = intersectSegments(A, B);
        } catch {
          hh = null;
        }
        if (!hh || !hh.length) continue;
        for (const h of hh) {
          let d = Infinity;
          for (const sp of sh)
            d = Math.min(d, Math.max(Math.abs(h.x - sp[0]), Math.abs(h.y - sp[1])));
          if (d < 1e-7) continue; // already filtered
          if (d < scaled) {
            nFalse++;
            if (hits.length < 8)
              hits.push(
                `${path.basename(f)} s${s} ${i}x${j} d=${d.toExponential(2)} scaled=${scaled.toExponential(2)}`,
              );
          } else nReal++;
        }
      }
    if (nReal) tReal++;
    else if (nFalse) tFalseOnly++;
    else tClean++;
  }
}
console.log(`  shapes scanned: ${tShapes}`);
console.log(`  clean (no crossing at all):            ${tClean}`);
console.log(`  have a REAL crossing (union justified): ${tReal}`);
console.log(`  FALSE crossings ONLY -> union run needlessly: ${tFalseOnly}`);
for (const h of hits) console.log('    ' + h);
