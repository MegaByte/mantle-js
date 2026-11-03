// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzDropScale — the collapsed-cubic drop's own numbers at two exactly-related sizes.
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
    globalThis.__lbDropTrace = [];
    buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    runs[k] = globalThis.__lbDropTrace.map((e) => ({ ...e, S: 2 ** k }));
  }
  const [ka, kb] = Object.keys(runs);
  const A = runs[ka],
    B = runs[kb];
  console.log(
    `s${s}: ${A.length} vs ${B.length} cubics tested; kept ${A.filter((e) => e.keep).length} vs ${B.filter((e) => e.keep).length}`,
  );
  for (let i = 0; i < Math.min(A.length, B.length); i++)
    if (A[i].keep !== B[i].keep)
      console.log(
        `  #${i}: e/S ${(A[i].e / A[i].S).toExponential(10)} vs ${(B[i].e / B[i].S).toExponential(10)}` +
          `   bar/S ${(A[i].bar / A[i].S).toExponential(10)} vs ${(B[i].bar / B[i].S).toExponential(10)}` +
          `   diag/S ${(A[i].diag / A[i].S).toExponential(10)} vs ${(B[i].diag / B[i].S).toExponential(10)}`,
      );
}
