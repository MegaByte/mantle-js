// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const sc = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { type: sg.type };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = [sg[k][0] * S, sg[k][1] * S];
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
for (const s of (process.env.SHAPES || '64').split(',').map(Number)) {
  const cs = curveRangeToContours(
    cf,
    sec.curveRangesByShape[s].begin | 0,
    sec.curveRangesByShape[s].end | 0,
  );
  const runs = {};
  for (const k of (process.env.KS || '0,-8').split(',').map(Number)) {
    globalThis.__lbSegTrace = [];
    buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    const S = 2 ** k;
    runs[k] = globalThis.__lbSegTrace.map((e) =>
      e.loop !== undefined
        ? `si${e.si} loop=${e.loop}`
        : e.gate !== undefined
          ? `si${e.si} ch29/S2=${(e.ch29 / (S * S)).toExponential(8)} gate=${e.gate}`
          : e.emit !== undefined
            ? `EMIT ${e.emit} ${e.hull.map((q) => (q / S).toFixed(9)).join(',')}`
            : e.hull !== undefined
              ? `si${e.si} HULL=${e.hull} klmn=${e.klmn} P=${e.P.map((q) => (q[0] / S).toFixed(9) + ',' + (q[1] / S).toFixed(9)).join(' ')}`
              : `si${e.si} d/S2=${(e.d / (S * S)).toExponential(8)} flat=${e.flat}`,
    );
  }
  const [ka, kb] = Object.keys(runs);
  const A = runs[ka],
    B = runs[kb];
  console.log(`s${s}: ${A.length} vs ${B.length} branch records`);
  for (let i = 0; i < Math.max(A.length, B.length); i++)
    if (A[i] !== B[i]) {
      console.log(`  #${i}: ${A[i] || '(end)'}\n        ${B[i] || '(end)'}`);
      break;
    }
}
