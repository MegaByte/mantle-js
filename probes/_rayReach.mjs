// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillRule.js bounds its ray by max ENDPOINT x + 100. A curve can extend past
// its endpoints (up to its control hull), so the ray can stop INSIDE the shape
// and miss crossings. Absolute 100 is a scale-blind margin. How close is real
// content to breaking it?
import { readFileSync } from 'fs';
import path from 'path';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const eo = (s) => (s.type === 0 ? s.p2 : s.type === 2 ? s.p4 : s.p3);
let worst = 0,
  worstAt = '',
  over = 0,
  n = 0;
for (const f of process.env.LIST.split(',').filter(Boolean)) {
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
    if (!segs.length) continue;
    n++;
    let endMax = -Infinity,
      ctrlMax = -Infinity;
    for (const sg of segs) {
      endMax = Math.max(endMax, sg.p1[0], eo(sg)[0]);
      for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) if (p) ctrlMax = Math.max(ctrlMax, p[0]);
    }
    const excess = ctrlMax - endMax; // how far control points reach past endpoints
    if (excess > worst) {
      worst = excess;
      worstAt = `${path.basename(f)} s${s}`;
    }
    if (excess > 100) over++;
  }
}
console.log(`  shapes: ${n}`);
console.log(`  worst control-point reach past max ENDPOINT x: ${worst.toFixed(2)}  (${worstAt})`);
console.log(`  shapes where that exceeds the absolute +100 margin: ${over}`);
