// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const sc = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { type: sg.type };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = [sg[k][0] * S, sg[k][1] * S];
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
for (const s of (process.env.SHAPES || '5,7,125,155').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  const out = [];
  for (const k of (process.env.KS || '-4,-3,-2,-1,0,1,2,3,4').split(',').map(Number)) {
    globalThis.__lbDeclineWhy = null;
    globalThis.__lbPartitionErr = null;
    const m = buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    out.push(
      `2^${k}:${m ? 'ok' : (globalThis.__lbDeclineWhy || globalThis.__lbPartitionErr || '?').slice(0, 40)}`,
    );
  }
  console.log(`s${s}  ` + out.join('  '));
}
