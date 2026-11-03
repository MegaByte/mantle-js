// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbScaleWhy — WHY the Loop-Blinn mesh build stops being equivariant, per shape.
// The stage probe says shapes 5, 7, 125 and 155 build at 2^0 and fail at some other power of two.
// A build failure is a decidable signal: it names a scale, and the difference between two runs of
// the same code on the same shape at two exactly-related sizes is a comparison against a constant.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const scaleLb = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { type: sg.type };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = [sg[k][0] * S, sg[k][1] * S];
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const SHAPES = (process.env.SHAPES || '5,7,125,155').split(',').map(Number);
const KS = (process.env.KS || '-4,-3,-2,-1,0,1,2,3,4').split(',').map(Number);
for (const s of SHAPES) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r) {
    console.log(`s${s}: no range`);
    continue;
  }
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  let ext = 0,
    x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of cs)
    for (const sg of c)
      for (const k of ['p1', 'p2', 'p3', 'p4'])
        if (sg[k]) {
          const q = sg[k];
          if (q[0] < x0) x0 = q[0];
          if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1];
          if (q[1] > y1) y1 = q[1];
        }
  ext = Math.max(x1 - x0, y1 - y0);
  const row = [];
  for (const k of KS) {
    const S = Math.pow(2, k);
    let m = null,
      err = '';
    try {
      m = buildLoopBlinnCDT(scaleLb(cs, S), { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    } catch (e) {
      err = String(e.message || e).slice(0, 30);
    }
    const n = m ? (m.interior || []).length / 2 + (m.fallback || []).length / 2 : -1;
    row.push(`2^${k}:${err ? 'ERR ' + err : n < 0 ? 'null' : n}`);
  }
  console.log(
    `s${s} ext=${ext.toFixed(4)} curves=${cs.reduce((a, c) => a + c.length, 0)} eo=${evenOdd}`,
  );
  console.log('   ' + row.join('  '));
}
