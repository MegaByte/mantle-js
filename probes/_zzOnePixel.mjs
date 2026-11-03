// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOnePixel — one wrong pixel, traced end to end. Population statistics have now eliminated a
// far branch, the sign, arc endpoints, overlapping hulls and hull containment; what is left is to
// look at a single pixel and see the geometry around it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const S = +(process.env.SHAPE || 175),
  X = +process.env.PXX,
  Y = +process.env.PXY;
const r = sec.curveRangesByShape[S];
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
const m = buildLoopBlinnCDT(cs, { fillRule: 'nonzero' });
const cv = contoursToConverter(cs, null);
const segs = [];
for (const c of cv) for (const sg of c) segs.push(sg);
console.log(`s${S} at em(${X},${Y})`);
console.log(
  `  the path's spans on this row: ` +
    (rowSpans(segs, Y) || []).map((q) => `[${q[0].toFixed(2)}, ${q[1].toFixed(2)}]`).join(' '),
);
console.log(
  `  contours ${cs.length}, segments ${segs.length}, crescents ${(m.cubics || []).length}, interior faces ${((m.interior || []).length / 6) | 0}`,
);
for (const c of m.cubics || []) {
  const H = c.hull;
  const d = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
  if (!(Math.abs(d) > 0)) continue;
  const w1 = ((X - H[0]) * (H[5] - H[1]) - (Y - H[1]) * (H[4] - H[0])) / d;
  const w2 = ((H[2] - H[0]) * (Y - H[1]) - (H[3] - H[1]) * (X - H[0])) / d;
  if (!(w1 >= 0 && w2 >= 0 && 1 - w1 - w2 >= 0)) continue;
  console.log(`  covered by a ${c.klmn ? 'klmn' : 'bezout'} crescent, sign ${c.sign}`);
  console.log(
    `    face      ${[0, 1, 2].map((i) => `(${H[2 * i].toFixed(1)},${H[2 * i + 1].toFixed(1)})`).join(' ')}`,
  );
  if (c.cp) {
    console.log(
      `    its curve ${c.cp.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(' ')}`,
    );
    // Where the curve is on this row, and how far the pixel is from the curve.
    let best = Infinity,
      bt = 0;
    for (let t = 0; t <= 1.0001; t += 1 / 512) {
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
      const dd = Math.hypot(X - ax, Y - ay);
      if (dd < best) {
        best = dd;
        bt = t;
      }
    }
    console.log(
      `    nearest point on its arc: t=${bt.toFixed(3)}, ${best.toFixed(2)} em away (one px = ${(900 / 512).toFixed(2)} em)`,
    );
  }
}
