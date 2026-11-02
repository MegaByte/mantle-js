// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzClipScale — the apex clip's own decisions at two exactly-related sizes.
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
globalThis.__lbAuditTraceAll = 1;
for (const s of (process.env.SHAPES || '155').split(',').map(Number)) {
  const cs = curveRangeToContours(
    cf,
    sec.curveRangesByShape[s].begin | 0,
    sec.curveRangesByShape[s].end | 0,
  );
  for (const k of (process.env.KS || '0,-4').split(',').map(Number)) {
    globalThis.__lbClipDbg = null;
    const m = buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    console.log(
      `s${s} 2^${k}: ${m ? 'built' : 'DECLINED'}  scan1=${JSON.stringify(globalThis.__lbScan1)}  tl=${globalThis.__lbClipTl}  sd=${(globalThis.__lbClipSd || []).map((v) => (v / 2 ** k).toExponential(3)).join(' ')}\n    ${(globalThis.__lbClipDbg || ['(clip not reached)']).join('\n    ')}`,
    );
  }
}
