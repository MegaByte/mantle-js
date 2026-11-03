// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzS82Why — is the over-painting shape a self-crossing contour the front end kept?
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { resolveSelfOverlap } from '../src/renderer/shapeResolve.js';
import {
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_RQUAD,
} from '../src/primitives/seg.js';

const N = +(process.env.N || 512);
const S = +(process.env.S || 82);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const SC = sec.viewBox[2] / N;
const r = sec.curveRangesByShape[S];
const list = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
console.log(`s${S}: ${list.length} contours, ${list.map((c) => c.length).join('+')} segments`);

const toSeg = (c) =>
  c.t === 'line'
    ? mkLine(c.P[0], c.P[1])
    : c.t === 'quad'
      ? mkQuad(c.P[0], c.P[1], c.P[2])
      : c.t === 'cubic'
        ? mkCubic(c.P[0], c.P[1], c.P[2], c.P[3])
        : mkRQuad(c.P[0], c.P[1], c.P[2], c.w == null ? 1 : c.w);
const fromSeg = (g) =>
  g.type === SEG_LINE
    ? { t: 'line', P: [g.p1, g.p2] }
    : g.type === SEG_QUAD
      ? { t: 'quad', P: [g.p1, g.p2, g.p3] }
      : g.type === SEG_CUBIC
        ? { t: 'cubic', P: [g.p1, g.p2, g.p3, g.p4] }
        : g.type === SEG_RQUAD
          ? { t: 'rquad', P: [g.p1, g.p2, g.p3], w: g.w }
          : null;
let resolved = null;
try {
  const simple = resolveSelfOverlap(
    list.map((c) => c.map(toSeg)),
    'nonzero',
  );
  resolved =
    simple && simple.map((c) => c.map(fromSeg).filter(Boolean)).filter((c) => c.length >= 2);
} catch (e) {
  console.log('  resolveSelfOverlap threw: ' + e.message);
}
console.log(
  `  resolveSelfOverlap -> ${resolved ? resolved.length + ' contours, ' + resolved.map((c) => c.length).join('+') + ' segments' : 'null'}`,
);

// the exact path, from the ORIGINAL contours: that is the truth either way
const all = [];
for (const c of list) for (const sg of c) all.push(sg);
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const sg of all)
  for (const P of sg.P) {
    if (P[0] < x0) x0 = P[0];
    if (P[0] > x1) x1 = P[0];
    if (P[1] < y0) y0 = P[1];
    if (P[1] > y1) y1 = P[1];
  }
function score(cs, label) {
  const ps = [];
  try {
    packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch (e) {
    console.log(`  ${label}: pack threw ${e.message}`);
    return;
  }
  let out = 0,
    miss = 0,
    ink = 0;
  for (let j = Math.floor((y0 - 2 * SC) / SC); j <= Math.ceil((y1 + 2 * SC) / SC); j++) {
    const cy = (j + 0.5) * SC,
      spans = rowSpans(all, cy) || [];
    for (let i = Math.floor((x0 - 2 * SC) / SC); i <= Math.ceil((x1 + 2 * SC) / SC); i++) {
      const cx = (i + 0.5) * SC;
      let inside = false,
        far = true;
      for (const sp of spans) {
        if (cx >= sp[0] + 0.5 * SC && cx <= sp[1] - 0.5 * SC) inside = true;
        if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
      }
      let cov = 0;
      for (const p of ps) {
        const c = patchCoverage(p, cx, cy, SC);
        if (c > cov) cov = c;
        if (cov > 0.999) break;
      }
      if (inside) {
        ink++;
        if (cov < 0.5) miss++;
      } else if (far && cov > 0.5) out++;
    }
  }
  console.log(
    `  ${label}: ${ps.length} patches — ${out} painted OUTSIDE, ${miss} of ${ink} interior missing`,
  );
}
score(list, 'as packed today');
if (resolved && resolved.length) score(resolved, 'after resolveSelfOverlap');

// ---- and the offending patch itself ----
{
  const ps = [];
  packCPatchShape(list, 0, { onPatches: (a) => ps.push(...a) });
  const PT = (process.env.EM || '452.64,324.32').split(',').map(Number);
  const inShape = (x, y) => {
    let v = false;
    for (const sp of rowSpans(all, y) || []) if (x >= sp[0] && x <= sp[1]) v = true;
    return v;
  };
  for (let k = 0; k < ps.length; k++) {
    const c = patchCoverage(ps[k], PT[0], PT[1], SC);
    if (c <= 0.5) continue;
    const p = ps[k];
    console.log(
      `  patch ${k}: cov ${c.toFixed(3)} at (${PT[0]},${PT[1]}) — inside pt (${p.inside[0].toFixed(3)}, ${p.inside[1].toFixed(3)})` +
        ` which is ${inShape(p.inside[0], p.inside[1]) ? 'IN' : 'OUT of'} the shape`,
    );
    for (let q = 0; q < p.curves.length; q++) {
      const sg = p.curves[q];
      console.log(
        `      [${q}] ${sg.t}${sg.cut ? ' CUT' : ''} ` +
          sg.P.map((P) => `(${P[0].toFixed(2)},${P[1].toFixed(2)})`).join(' '),
      );
    }
  }
}
