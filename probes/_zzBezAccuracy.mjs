// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBezAccuracy — is the stray ink a BRANCH or an INACCURACY? Both bounds aimed at a branch are
// inert: a disc around the normalization center at |n|<=2 changes nothing, and the arc's own span
// slab changes nothing at zero slack. That leaves the possibility that the resultant's zero set is
// simply in the wrong PLACE near these pixels -- the near-straight cubics that become Bezout
// pieces are exactly the ill-conditioned ones. This compares the distance the implicit implies,
// |f| / |grad f|, against the true distance to the drawn arc.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const emX = (i) => ((i + 0.5) / N) * 900,
  emY = (j) => (1 - (j + 0.5) / N) * 900;
const EPP = 900 / N;
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
  let best = Infinity,
    bt = 0;
  for (let k = 0; k <= 2048; k++) {
    const t = k / 2048,
      P = at(cp, t);
    const d = Math.hypot(P[0] - x, P[1] - y);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return { d: best, t: bt };
};
const inTri = (p, a, b, c) => {
  const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!(Math.abs(d) > 0)) return false;
  const w1 = ((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / d;
  const w2 = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / d;
  return w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9;
};
for (const spec of (process.env.PTS || '269,430,105').split(' ')) {
  const [pi, pj, s] = spec.split(',').map(Number);
  const x = emX(pi),
    y = emY(pj);
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = 1;
  const m = buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
    fillRule: evenOdd ? 'evenodd' : 'nonzero',
  });
  if (!m) {
    console.log(`${spec}: DECLINED`);
    continue;
  }
  console.log(`px(${pi},${pj}) em(${x.toFixed(2)},${y.toFixed(2)}) s${s}`);
  let shown = 0;
  for (const c of m.cubics || []) {
    if (c.klmn || !c.F || !c.cp) continue;
    const H = c.hull,
      n = H.length / 2;
    let hit = false;
    for (let i = 1; i + 1 < n && !hit; i++)
      hit = inTri([x, y], [H[0], H[1]], [H[2 * i], H[2 * i + 1]], [H[2 * i + 2], H[2 * i + 3]]);
    // Also report the nearest crescent even when the point is outside every hull: the GPU pushes
    // ring vertices out, so the piece that paints need not contain the center in em.
    const ad = arcDist(c.cp, x, y);
    if (!hit && ad.d > 4 * EPP) continue;
    const h = 1e-4 * Math.max(1, Math.abs(c.F.s));
    const f0 = evalBezout(c.F, x, y);
    const gx = (evalBezout(c.F, x + h, y) - evalBezout(c.F, x - h, y)) / (2 * h);
    const gy = (evalBezout(c.F, x, y + h) - evalBezout(c.F, x, y - h)) / (2 * h);
    const g = Math.hypot(gx, gy);
    const impl = g > 0 ? Math.abs(f0) / g : Infinity;
    // THE GRADIENT'S DIRECTION AT A ZERO IS THE DISCRIMINATOR, if the stray zero is a second
    // branch. Walking outward from the ink across the TRUE boundary, f must increase; a branch the
    // Bezier never traces has no such obligation. "Outward" here is the direction from the arc's
    // own foot point to the fragment.
    const foot = at(c.cp, ad.t);
    let ox = x - foot[0],
      oy = y - foot[1];
    const oL = Math.hypot(ox, oy) || 1;
    ox /= oL;
    oy /= oL;
    const gdot = (gx * ox + gy * oy) / (g || 1);
    console.log(
      `  ${hit ? 'HULL' : 'near'} crescent sign ${c.sign}: implicit says ${(impl / EPP).toFixed(3)} px from its zero, ` +
        `the drawn arc is ${(ad.d / EPP).toFixed(3)} px away (t=${ad.t.toFixed(3)})   f=${f0.toExponential(2)} |grad|=${g.toExponential(2)}`,
    );
    console.log(
      `      grad . outward = ${(c.sign * gdot).toFixed(3)}  (sign-corrected; a TRUE boundary must be positive)`,
    );
    shown++;
  }
  if (!shown) console.log('  no Bezout crescent within 4px');
}
