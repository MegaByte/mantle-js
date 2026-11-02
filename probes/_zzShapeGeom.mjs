// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzShapeGeom -- one shape's geometry and the mesh built from it: contours, segment count,
// the klmn/Bezout split of its crescents and how many carry a keep half-plane. Which of the
// two cubic tiers a shape lands in decides which machinery its edges depend on, and that is
// not visible from the frame.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const KIND = {
  0: 'INTERIOR',
  2: 'CUBIC',
  4: 'CUBIC_BEZ',
  5: 'ARC',
  7: 'DISC',
  10: 'EDGE_STRIP',
  12: 'CURVE_BAND',
  13: 'CHAIN_STRIP',
};
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
for (const s of (process.env.S || '12').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  const types = new Map();
  let nseg = 0;
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  if (process.env.DUMP1) {
    console.log('  segment 0 =', JSON.stringify(cs[0][0]).slice(0, 300));
  }
  for (const c of cs)
    for (const sg of c) {
      nseg++;
      const pts = sg.P || sg.pts || sg.points || (Array.isArray(sg) ? sg : null);
      const n = pts ? pts.length : -1;
      types.set(
        sg.kind !== undefined ? sg.kind : n,
        (types.get(sg.kind !== undefined ? sg.kind : n) || 0) + 1,
      );
      for (const P of pts || [])
        if (Array.isArray(P)) {
          x0 = Math.min(x0, P[0]);
          x1 = Math.max(x1, P[0]);
          y0 = Math.min(y0, P[1]);
          y1 = Math.max(y1, P[1]);
        }
    }
  const m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  const byk = new Map();
  if (m)
    for (const key of [
      'interior',
      'quads',
      'cubics',
      'edges',
      'stripArcs',
      'interiorEdges',
      'interiorEdges2',
      'interiorEdges3',
      'steiner9',
      'cubicRecs9',
      'hulls9',
    ]) {
      const v = m[key];
      if (v && v.length !== undefined) byk.set(key, v.length);
    }
  if (m && m.cubics) {
    let bez = 0,
      bezKeep = 0,
      klm = 0;
    for (const c of m.cubics) {
      if (c.klmn) klm++;
      else {
        bez++;
        if (c.keep && (c.keep[0] || c.keep[1])) bezKeep++;
      }
    }
    console.log(
      `      crescents: ${klm} klmn, ${bez} bezout of which ${bezKeep} carry a keep half-plane`,
    );
    const bk = new Map();
    for (const c of m.cubics) bk.set(c.kind, (bk.get(c.kind) || 0) + 1);
    console.log(
      '      cubic kinds: ' + [...bk].map(([k, v]) => (KIND[k] || k) + ':' + v).join(' '),
    );
  }
  console.log(
    `s${s}: ${cs.length} contour(s), ${nseg} segments  ctrl-pts ${[...types].map(([k, v]) => k + ':' + v).join(' ')}` +
      `  bbox ${x0.toFixed(1)},${y0.toFixed(1)} .. ${x1.toFixed(1)},${y1.toFixed(1)}  evenOdd=${evenOdd}`,
  );
  console.log(
    `      mesh: ${m ? (m.tris ? m.tris.length / 3 : '?') + ' tris' : 'DECLINED'}   kinds ${[...byk].map(([k, v]) => (KIND[k] || k) + ':' + v).join(' ')}`,
  );
  if (m) console.log(`      keys: ${Object.keys(m).join(' ')}`);
}
