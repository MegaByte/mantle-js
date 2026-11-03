// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _spanDelta — for named shapes, the key-origin box and scale a p1-only and an all-control-points
// _setKeyOrigin produce, so a moved mesh can be attributed to one or the other.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const box = (cs, all) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of cs)
    for (const s of c)
      for (const p of all ? [s.p1, s.p2, s.p3, s.p4] : [s.p1]) {
        if (!p) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
  const d = Math.hypot(x1 - x0, y1 - y0);
  return { x0, y0, d, k: d > 0 ? Math.pow(2, Math.round(Math.log2(65536 / d))) : 64 };
};
for (const spec of process.argv.slice(2)) {
  const [file, si] = spec.split('#');
  const bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
  const cf = new Float32Array(bundle.curves);
  const r = bundle.curveRangesByShape[+si];
  const cs = curveRangeToContours(cf, r.begin, r.end);
  const A = box(cs, false),
    B = box(cs, true);
  console.log(`${spec}: segs ${cs.reduce((a, c) => a + c.length, 0)}`);
  console.log(
    `   old  origin (${A.x0.toFixed(4)}, ${A.y0.toFixed(4)})  diag ${A.d.toFixed(5)}  koScale ${A.k}  span ${(65536 / A.k).toFixed(4)}`,
  );
  console.log(
    `   new  origin (${B.x0.toFixed(4)}, ${B.y0.toFixed(4)})  diag ${B.d.toFixed(5)}  koScale ${B.k}  span ${(65536 / B.k).toFixed(4)}   ${A.k === B.k ? 'SAME scale' : 'SCALE MOVED'}${A.x0 === B.x0 && A.y0 === B.y0 ? '' : ', origin moved'}`,
  );
}
