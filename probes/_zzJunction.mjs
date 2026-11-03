// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzJunction — are Loop-Blinn's residual wrong pixels at EDGE JUNCTIONS?
//
// LB tiles by GEOMETRY: the CDT's faces are disjoint by construction, so inside a face exactly one
// primitive decides the pixel and there is nothing to get wrong about ownership. Two faces can only
// both reach a pixel where they MEET -- along a shared edge, or at a vertex where several meet. If
// that model is right, the residue should sit on those boundaries and not in face interiors, and
// the distances say so outright.
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
const N = +(process.env.N || 512),
  BB = [0, 0, 900, 900];
const emX = (i) => BB[0] + ((i + 0.5) / N) * BB[2];
const emY = (j) => BB[1] + (1 - (j + 0.5) / N) * BB[3];
const EMPP = BB[2] / N;

// The wrong pixels and who painted them, from _zzEnginePaint (pixel coords, painter shape).
const PTS = (process.env.PTS || '247,152,39 221,108,36 178,145,39 248,154,36 228,178,36 243,179,36')
  .split(' ')
  .map((q) => q.split(',').map(Number));

const meshOf = new Map();
for (const [, , s] of PTS) {
  if (meshOf.has(s)) continue;
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let m = null;
  try {
    m = buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
      fillRule: evenOdd ? 'evenodd' : 'nonzero',
    });
  } catch {}
  meshOf.set(s, m);
}
const segD = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax,
    vy = by - ay,
    L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
console.log(`pixel        painter   to nearest VERTEX   to nearest EDGE   verdict`);
let atVert = 0,
  atEdge = 0,
  interior = 0;
for (const [i, j, s] of PTS) {
  const m = meshOf.get(s);
  if (!m) {
    console.log(`(${i},${j})`.padEnd(13) + `s${s}`.padEnd(10) + 'mesh unavailable');
    continue;
  }
  const x = emX(i),
    y = emY(j);
  const tris = [];
  const I = m.interior || [];
  for (let t = 0; t + 5 < I.length; t += 6)
    tris.push([I[t], I[t + 1], I[t + 2], I[t + 3], I[t + 4], I[t + 5]]);
  for (const c of m.cubics || []) tris.push(Array.from(c.hull).slice(0, 6));
  for (const q of m.quads || []) tris.push(Array.from(q.tri).slice(0, 6));
  let dv = Infinity,
    de = Infinity;
  for (const T of tris) {
    for (let k = 0; k < 3; k++) {
      dv = Math.min(dv, Math.hypot(x - T[2 * k], y - T[2 * k + 1]));
      const n2 = (k + 1) % 3;
      de = Math.min(de, segD(x, y, T[2 * k], T[2 * k + 1], T[2 * n2], T[2 * n2 + 1]));
    }
  }
  const vpx = dv / EMPP,
    epx = de / EMPP;
  const verdict =
    vpx <= 1.0 ? 'AT A VERTEX (junction)' : epx <= 1.0 ? 'on an EDGE' : 'INSIDE a face';
  if (vpx <= 1.0) atVert++;
  else if (epx <= 1.0) atEdge++;
  else interior++;
  console.log(
    `(${i},${j})`.padEnd(13) +
      `s${s}`.padEnd(10) +
      `${vpx.toFixed(2)} px`.padStart(15) +
      `${epx.toFixed(2)} px`.padStart(18) +
      '   ' +
      verdict,
  );
}
console.log(`\n${atVert} at a vertex, ${atEdge} on an edge, ${interior} inside a face.`);
