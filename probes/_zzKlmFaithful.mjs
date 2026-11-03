// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzKlmFaithful — a Bezout tier can ramp coverage on a distance that is not one (for a third of
// its pieces). The klm tier ramps on the same kind of quantity from an affine (k,l,m) field, and
// k^3 - l*m vanishes on the cubic's whole algebraic curve too -- its continuation past t=0 and t=1,
// and the other branch of a self-intersecting one. So the same question has to be asked of it
// before the Bezout fix is called the end of the story.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
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
let n = 0;
const gaps = [];
for (const s of (process.env.SHAPES || '105,12,96,24,97,13,104,66,116').split(',').map(Number)) {
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
  for (const c of m.cubics || []) {
    if (!c.klmn || !c.cp || c.cp.length !== 4) continue;
    const H = c.hull;
    if (H.length / 2 < 3) continue;
    const A = [H[0], H[1]],
      B = [H[2], H[3]],
      C = [H[4], H[5]];
    const K = c.klmn; // 3 rows of (k,l,m), one per hull vertex — affine in position
    if (!K || K.length < 9) continue;
    const det = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (!(Math.abs(det) > 0)) continue;
    n++;
    const chord = Math.hypot(c.cp[3][0] - c.cp[0][0], c.cp[3][1] - c.cp[0][1]) || 1;
    const arc = [];
    for (let k = 0; k <= 16; k++) arc.push(at(c.cp, k / 16));
    const fld = (x, y) => {
      const w1 = ((x - A[0]) * (C[1] - A[1]) - (y - A[1]) * (C[0] - A[0])) / det;
      const w2 = ((B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (x - A[0])) / det;
      const w0 = 1 - w1 - w2;
      const kk = w0 * K[0] + w1 * K[3] + w2 * K[6],
        ll = w0 * K[1] + w1 * K[4] + w2 * K[7],
        mm = w0 * K[2] + w1 * K[5] + w2 * K[8];
      return kk * kk * kk - ll * mm;
    };
    const h = 1e-5 * chord;
    let worst = 0;
    const G = 6;
    for (let a = 0; a <= G; a++)
      for (let b = 0; a + b <= G; b++) {
        const wa = a / G,
          wb = b / G,
          wc = 1 - wa - wb;
        const x = wa * A[0] + wb * B[0] + wc * C[0],
          y = wa * A[1] + wb * B[1] + wc * C[1];
        const f0 = fld(x, y);
        const g = Math.hypot(
          (fld(x + h, y) - fld(x - h, y)) / (2 * h),
          (fld(x, y + h) - fld(x, y - h)) / (2 * h),
        );
        if (!(g > 0)) continue;
        let ad = Infinity;
        for (const P of arc) {
          const d = (P[0] - x) * (P[0] - x) + (P[1] - y) * (P[1] - y);
          if (d < ad) ad = d;
        }
        const gap = Math.sqrt(ad) - Math.abs(f0) / g;
        if (gap > worst) worst = gap;
      }
    gaps.push(worst / chord);
  }
}
gaps.sort((a, b) => a - b);
const q = (f) =>
  gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(f * gaps.length))].toFixed(3) : 'n/a';
const over = gaps.filter((g) => g > 0.05).length;
console.log(
  `${n} klm crescents; ${over} (${((100 * over) / Math.max(1, n)).toFixed(1)}%) understate the distance`,
);
console.log(
  `to their own arc by more than 5% of the chord.  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`,
);
