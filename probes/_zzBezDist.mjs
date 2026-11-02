// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBezDist — is the Bezout crescent's bad coverage a PRECISION problem or a MODEL problem?
//
// The kernel turns the implicit into coverage through a signed distance f/|grad f| measured in
// pixels. At tiger's (145,102) the path covers 26% and Loop-Blinn paints 0%, so the kernel believes
// the fragment is a long way outside. Computed here in float64 from the same determinant and the
// same analytic cofactor gradient: if float64 gives the right distance, the shader's float32 is the
// problem and the fix is conditioning; if float64 is wrong too, f/|grad| is the wrong model for
// this implicit and the fix is a better distance.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const EMPP = 900 / 512;
const S = +(process.env.SHAPE || 35),
  X = +(process.env.PXX || 255.8),
  Y = +(process.env.PXY || 719.8);
const r = sec.curveRangesByShape[S];
const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
const m = buildLoopBlinnCDT(cs, { fillRule: 'nonzero' });
const segs = [];
{
  const cv = contoursToConverter(cs, null);
  for (const c of cv) for (const sg of c) segs.push(sg);
}
// The exact coverage of this pixel, by the same box+Gauss rule the reference uses.
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
let cov = 0;
for (const [q, w] of GL5) {
  const y = Y + 0.5 * EMPP * q;
  let c2 = 0;
  for (const sp of rowSpans(segs, y) || [])
    c2 += Math.max(0, Math.min(X + EMPP / 2, sp[1]) - Math.max(X - EMPP / 2, sp[0]));
  cov += (w * 0.5 * c2) / EMPP;
}
console.log(`s${S} at em(${X},${Y}): exact coverage ${cov.toFixed(4)}`);
for (const c of m.cubics || []) {
  const H = c.hull;
  const d = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
  if (!(Math.abs(d) > 0)) continue;
  const w1 = ((X - H[0]) * (H[5] - H[1]) - (Y - H[1]) * (H[4] - H[0])) / d;
  const w2 = ((H[2] - H[0]) * (Y - H[1]) - (H[3] - H[1]) * (X - H[0])) / d;
  if (w1 < 0 || w2 < 0 || 1 - w1 - w2 < 0) continue;
  if (c.klmn || !c.F) {
    console.log(`  covered by a klmn crescent`);
    continue;
  }
  const f = c.sign * evalBezout(c.F, X, Y);
  const h = 1e-6 * (Math.abs(X) + Math.abs(Y) + 1);
  const gx = (c.sign * evalBezout(c.F, X + h, Y) - c.sign * evalBezout(c.F, X - h, Y)) / (2 * h);
  const gy = (c.sign * evalBezout(c.F, X, Y + h) - c.sign * evalBezout(c.F, X, Y - h)) / (2 * h);
  const gl = Math.hypot(gx, gy);
  const dpx = gl > 0 ? f / gl / EMPP : NaN;
  // And the TRUE distance to the drawn arc, for comparison.
  let ad = Infinity;
  for (let t = 0; t <= 1.0001; t += 1 / 2048) {
    const u = 1 - t,
      cp = c.cp;
    const ax =
      u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0];
    const ay =
      u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1];
    ad = Math.min(ad, Math.hypot(X - ax, Y - ay));
  }
  console.log(`  BEZOUT crescent: f = ${f.toExponential(3)}, |grad| = ${gl.toExponential(3)}`);
  console.log(`    implied signed distance  ${dpx.toFixed(4)} px   (negative = inside)`);
  console.log(`    true distance to its arc ${(ad / EMPP).toFixed(4)} px`);
  console.log(
    `    a coverage of ${cov.toFixed(3)} wants a signed distance near ${(cov - 0.5).toFixed(3)} px`,
  );
}
