// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAuditTruth — is the over-paint audit's verdict TRUE? It condemns a piece when its implicit
// paints a sample the shape has no ink at, and that second half is answered by the builder's own
// `inkAt` (a ray-winding probe with a y nudge). Measured in isolation, 48 of the 84 shapes the
// audit declines paint nothing at all outside their path -- so for those the audit is wrong about
// something, and the candidate is the ink verdict itself.
//
// The independent answer here is the same one the renderer is scored against: exact row spans of
// the shape's own segments, folded by the shape's own fill rule. A disagreement names the defect.
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
// Shapes the frame-isolation probe found CLEAN when admitted, and the ones it found GUILTY.
const CLEAN = new Set((process.env.CLEAN || '').split(',').filter(Boolean).map(Number));
const GUILTY = new Set((process.env.GUILTY || '').split(',').filter(Boolean).map(Number));

globalThis.__lbAuditTrace = 1;
let nIn = 0,
  nOut = 0,
  nRim = 0,
  cIn = 0,
  cOut = 0,
  gIn = 0,
  gOut = 0;
const depthIn = [],
  depthOut = [],
  thick = [];
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
  globalThis.__lbAuditBad = [];
  globalThis.__lbDeclineWhy = null;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (m || globalThis.__lbDeclineWhy !== 'coverage-audit') continue;
  let segs = null;
  try {
    const cv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  if (!segs.length) continue;
  // The shape's own scale, so "how far outside" is a fraction of the shape and not an em.
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
  let mxPx = 0;
  for (const b of globalThis.__lbAuditBad || []) {
    const [px, py] = b.p;
    const sp = spansOf(segs, py, evenOdd);
    // Signed distance to the row's spans, in units of the shape diagonal: > 0 inside.
    let best = -Infinity;
    for (const [a2, b2] of sp) best = Math.max(best, Math.min(px - a2, b2 - px));
    const rel = best / diag;
    if (rel > 1e-4) {
      nIn++;
      depthIn.push(rel);
      if (CLEAN.has(s)) cIn++;
      if (GUILTY.has(s)) gIn++;
    } else if (rel < -1e-4) {
      nOut++;
      depthOut.push(-rel);
      if (CLEAN.has(s)) cOut++;
      if (GUILTY.has(s)) gOut++;
    } else nRim++;
    // HOW THICK THE OVER-PAINT IS, IN PIXELS -- the quantity the kernel actually thresholds. The
    // audit asks only for the SIGN of the piece's implicit; curveCov converts it to coverage
    // through f/|grad| measured in pixels, so a claim the audit treats as solid ink can be a
    // fraction of a pixel deep. The thickness is bounded by both how deep the piece holds the
    // point and how far outside the shape it is: whichever is smaller is how much wrong ink there
    // can be. Resolution-free in em; reported at two zooms because the mesh serves both.
    if (b.dEm != null && rel < 0) {
      const t = Math.min(b.dEm, -rel * diag);
      if (t > mxPx) mxPx = t;
    }
  }
  if (mxPx > 0) thick.push([s, mxPx]);
}
const q = (a, f) => {
  a.sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(5) : 'n/a';
};
console.log(`bad samples the audit counted as over-paint, judged by EXACT row spans:`);
console.log(`  actually INSIDE the shape : ${nIn}   (the audit's ink test was wrong)`);
console.log(`  actually OUTSIDE          : ${nOut}`);
console.log(`  on the rim (|d| <= 1e-4 of the diagonal): ${nRim}`);
console.log(`  how far INSIDE the wrongly-condemned samples are, over the shape diagonal:`);
console.log(`    median ${q(depthIn, 0.5)}  p90 ${q(depthIn, 0.9)}  max ${q(depthIn, 1)}`);
console.log(`  how far OUTSIDE the genuine ones are:`);
console.log(`    median ${q(depthOut, 0.5)}  p90 ${q(depthOut, 0.9)}  max ${q(depthOut, 1)}`);
if (CLEAN.size) console.log(`  shapes CLEAN in isolation : ${cIn} samples inside, ${cOut} outside`);
if (GUILTY.size)
  console.log(`  shapes GUILTY in isolation: ${gIn} samples inside, ${gOut} outside`);

// The asset's em-per-pixel at the two resolutions the corpus checks are run at.
const EM = +(process.env.EM || 900);
for (const [label, res] of [
  ['512px', 512],
  ['2048px', 2048],
]) {
  const epp = EM / res;
  const g = [],
    c = [];
  for (const [s, t] of thick) (GUILTY.has(s) ? g : CLEAN.has(s) ? c : g).push(t / epp);
  const st = (a2) => {
    a2.sort((x, y) => x - y);
    const f = (q2) =>
      a2.length ? a2[Math.min(a2.length - 1, Math.floor(q2 * a2.length))].toFixed(2) : 'n/a';
    return `n=${a2.length} median ${f(0.5)}px  p90 ${f(0.9)}px  max ${f(1)}px`;
  };
  console.log(`  thickest over-paint per shape at ${label}:`);
  console.log(`    GUILTY: ${st(g)}`);
  console.log(`    CLEAN : ${st(c)}`);
}
