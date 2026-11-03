// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const A = [];
globalThis.__CP_LOOP_AUDIT = A;
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { rowSpans, insideContour, patchBBox } = await import('../src/renderer/cpatchConvert.js');
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float64Array(sec.curves64);
const K = 11;
A.frac = (l) => {
  if (!l || l.length < 2 || !A.src) return 0;
  const b = patchBBox(l);
  if (!b) return 0;
  let inL = 0,
    out = 0;
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) {
      const x = b[0] + ((b[2] - b[0]) * (i + 0.5)) / K,
        y = b[1] + ((b[3] - b[1]) * (j + 0.5)) / K;
      if (!insideContour(l, x, y)) continue;
      inL++;
      let ok = false;
      for (const sp of rowSpans(A.src, y) || []) if (x >= sp[0] && x <= sp[1]) ok = true;
      if (!ok) out++;
    }
  return inL ? out / inL : 0;
};
let tot = 0;
const only = process.env.S ? process.env.S.split(',').map(Number) : null;
for (let S = 0; S < sec.curveRangesByShape.length; S++) {
  if (only && !only.includes(S)) continue;
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  let list = null;
  try {
    list = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {}
  if (!list || !list.length) continue;
  const src = [];
  for (const c of list) for (const sg of c) src.push(sg);
  A.length = 0;
  A.src = src;
  A.parentBad = false;
  try {
    packCPatchShape(list, 0, {});
  } catch {}
  if (A.length) {
    tot += A.length;
    const by = new Map();
    for (const a of A) by.set(a.op, (by.get(a.op) | 0) + 1);
    console.log(
      `s${S}: ${A.length} first-offender loops — ${[...by].map(([k, v]) => k + ':' + v).join(' ')}`,
    );
    for (const a of A.slice(0, 4))
      console.log(
        `    ${a.op}: parent ${a.parent} -> child ${a.n}, ${(a.bad * 100).toFixed(0)}% of the child is outside the shape`,
      );
  }
}
console.log('total ' + tot);
