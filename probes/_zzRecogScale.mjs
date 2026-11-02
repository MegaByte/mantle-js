// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzRecogScale — how many shapes each RECOGNIZER claims, at several sizes. Recognition picks the
// engine, so a count that moves with scale is a frame that moves with scale.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { circleFromContours, ellipseFromContours } from '../src/geom/shapeRecognize.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
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
      if (sg.circle) o.circle = { cx: sg.circle.cx * S, cy: sg.circle.cy * S, r: sg.circle.r * S };
      return o;
    }),
  );
const out = [];
for (const k of (process.env.KS || '-8,-4,-2,0,2,4,8').split(',').map(Number)) {
  let circ = 0,
    ell = 0,
    tot = 0;
  for (const r of sec.curveRangesByShape || []) {
    if (!r) continue;
    let cs = null;
    try {
      cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
    } catch {
      continue;
    }
    if (!cs || !cs.length) continue;
    tot++;
    const S = sc(cs, 2 ** k);
    if (circleFromContours(S)) circ++;
    else if (ellipseFromContours(S)) ell++;
  }
  out.push(`2^${k}: circle=${circ} ellipse=${ell} of ${tot}`);
}
console.log(out.join('\n'));
