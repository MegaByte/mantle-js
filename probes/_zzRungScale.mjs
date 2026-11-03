// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzRungScale — which rung of the refusal ladder a contour comes off, at two sizes. Rung two
// (normalized frame) and rung three (finer tolerance) are DIFFERENT SEARCHES: if a contour clears
// rung one at one size and needs a retry at another, the decomposition legitimately differs, and
// the cause is whatever made rung one refuse.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const flag = (st) =>
  !st
    ? '-'
    : [
        st.retriedFull && 'full',
        st.retriedNormalized && 'norm',
        st.retriedFine && 'fine',
        st.budgetExhausted && 'budget',
        st.unresolved && `unres${st.unresolved}`,
      ]
        .filter(Boolean)
        .join(',') || 'rung1';
for (const s of (process.env.SHAPES || '61,62,63,64,65,66,68,81').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  const out = [];
  for (const k of (process.env.KS || '0,1,2,4,-1,-2,-4').split(',').map(Number)) {
    const c = convertContour(scaleCv(cs, 2 ** k).flat(), { maxCurves: 8 });
    out.push(`2^${k}:${c ? c.patches.length : 'null'}[${flag(c && c.stats)}]`);
  }
  console.log(`s${s}  ` + out.join('  '));
}
