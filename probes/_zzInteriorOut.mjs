// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzInteriorOut — the over-paint audit scans CUBIC PIECES. It never looks at an INTERIOR face.
//
// Ten of the fifteen wrong-solid components Loop-Blinn leaves on tiger sit on a pixel covered by
// exactly one interior triangle and nothing else: an interior face paints a flat 1.0 with no ramp
// and no implicit, so wherever one reaches past the outline it puts solid ink outside the shape and
// there is nothing in the build that would notice. The partition's interior is bounded by CHORDS,
// and a chord of a concave arc lies OUTSIDE the shape, so the geometry for this exists by
// construction; the crescent is supposed to carve it back.
//
// This asks the interior faces the question the audit asks the crescents, against exact row spans.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';

function spansOf(segs, y, evenOdd) {
  if (!evenOdd) return rowSpans(segs, y) || [];
  const xs = [];
  for (const sg of segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
}
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
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
  if (!m || !m.interior || !m.interior.length) continue;
  let segs = null;
  try {
    const cvv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cvv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of segs)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  const I = m.interior;
  let bad = 0,
    faces = 0,
    worst = 0;
  for (let t = 0; t + 5 < I.length; t += 6) {
    faces++;
    const gx = (I[t] + I[t + 2] + I[t + 4]) / 3,
      gy = (I[t + 1] + I[t + 3] + I[t + 5]) / 3;
    // The same ten points the crescent audit uses, so the two are comparable.
    const pts = [[gx, gy]];
    for (let k = 0; k < 3; k++) {
      pts.push([(I[t + 2 * k] + gx) / 2, (I[t + 2 * k + 1] + gy) / 2]);
      pts.push([I[t + 2 * k] * 0.85 + gx * 0.15, I[t + 2 * k + 1] * 0.85 + gy * 0.15]);
      const j = (k + 1) % 3;
      pts.push([
        ((I[t + 2 * k] + I[t + 2 * j]) / 2) * 0.7 + gx * 0.3,
        ((I[t + 2 * k + 1] + I[t + 2 * j + 1]) / 2) * 0.7 + gy * 0.3,
      ]);
    }
    for (const [px, py] of pts) {
      const sp = spansOf(segs, py, evenOdd);
      let best = -Infinity;
      for (const [a, b] of sp) best = Math.max(best, Math.min(px - a, b - px));
      const rel = best / diag;
      if (rel < -1e-4) {
        bad++;
        if (-rel > worst) worst = -rel;
        break;
      }
    }
  }
  rows.push({ s, bad, faces, worst });
}
const flagged = rows.filter((r) => r.bad > 0);
console.log(
  `${rows.length} shapes with interior faces; ${flagged.length} have an interior face reaching OUTSIDE the path`,
);
if (GUILTY.size) {
  const g = rows.filter((r) => GUILTY.has(r.s)),
    c = rows.filter((r) => !GUILTY.has(r.s));
  const hit = g.filter((r) => r.bad > 0).length,
    fp = c.filter((r) => r.bad > 0).length;
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
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 12)
      .map((r) => `s${r.s}:${r.bad}/${r.faces}@${(r.worst * 100).toFixed(2)}%`)
      .join(' '),
);
