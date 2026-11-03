// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzS82Fill — one shape, painted by the model over its own bbox, against the exact path. Says how
// much of what a shape's patches claim is not the shape.
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

const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const SC = sec.viewBox[2] / N;
const LIST = (process.env.S || '').length
  ? process.env.S.split(',').map(Number)
  : (sec.curveRangesByShape || []).map((_, i) => i);
let tot = 0,
  worstS = -1,
  worstN = 0;
for (const S of LIST) {
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const ps = [];
  try {
    packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  if (!ps.length) continue;
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
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
  let out = 0,
    miss = 0,
    ink = 0;
  const at = [];
  const i0 = Math.floor((x0 - 2 * SC) / SC),
    i1 = Math.ceil((x1 + 2 * SC) / SC);
  const j0 = Math.floor((y0 - 2 * SC) / SC),
    j1 = Math.ceil((y1 + 2 * SC) / SC);
  for (let j = j0; j <= j1; j++) {
    const cy = (j + 0.5) * SC;
    const spans = rowSpans(all, cy) || [];
    for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * SC;
      let inside = false;
      for (const sp of spans) if (cx >= sp[0] + 0.5 * SC && cx <= sp[1] - 0.5 * SC) inside = true;
      let far = true;
      for (const sp of spans) if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
      let cov = 0;
      for (const p of ps) {
        const c = patchCoverage(p, cx, cy, SC);
        if (c > cov) cov = c;
        if (cov > 0.999) break;
      }
      if (inside) {
        ink++;
        if (cov < 0.5) miss++;
      } else if (far && cov > 0.5) {
        out++;
        if (at.length < 4) at.push(`${i},${j}`);
      }
    }
  }
  if (out || miss) {
    tot += out;
    if (out > worstN) {
      worstN = out;
      worstS = S;
    }
    console.log(
      `s${S}: ${ps.length} patches, ${ink} ink px — ${out} painted OUTSIDE (>1.5px clear), ${miss} interior missing` +
        (at.length ? `  e.g. ${at.join(' ')}` : ''),
    );
  }
}
console.log(`total painted outside: ${tot}${worstS >= 0 ? `, worst s${worstS} (${worstN})` : ''}`);
