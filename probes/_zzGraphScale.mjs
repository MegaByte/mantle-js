// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzGraphScale — the CPatch front end (pathToCycles: exact crossings, arrangement, fill scoring,
// cycle extraction) at two exactly-related sizes. The converter itself proved equivariant on these
// contours, so whatever moves the decomposition moves here first.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const nums = (cy) => {
  const o = [];
  for (const c of cy || []) {
    o.push(-1);
    for (const s of c) {
      o.push(s.P.length);
      for (const p of s.P) {
        o.push(p[0]);
        o.push(p[1]);
      }
    }
  }
  return o;
};
let bad = 0,
  tot = 0;
const which = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  let b = null;
  try {
    b = nums(pathToCycles(scaleCv(cs, 1), evenOdd));
  } catch {
    continue;
  }
  tot++;
  for (const k of (process.env.KS || '-4,-2,-1,1,2,4').split(',').map(Number)) {
    const S = 2 ** k;
    let a = null;
    try {
      a = nums(pathToCycles(scaleCv(cs, S), evenOdd));
    } catch {
      a = null;
    }
    if (!a || a.length !== b.length) {
      bad++;
      which.push(`${s}(count ${b.length}->${a ? a.length : 'throw'}@2^${k})`);
      break;
    }
    let rel = 0;
    for (let i = 0; i < a.length; i++) {
      // The structural markers (-1, control-point counts) are small integers and must match
      // exactly; everything else is a coordinate and scales.
      const v = Number.isInteger(b[i]) && Math.abs(b[i]) <= 4 ? a[i] : a[i] / S;
      rel = Math.max(rel, Math.abs(v - b[i]) / Math.max(Math.abs(b[i]), 1e-300));
    }
    if (rel > 1e-9) {
      bad++;
      which.push(`${s}(rel ${rel.toExponential(1)}@2^${k})`);
      break;
    }
  }
}
console.log(`pathToCycles: ${bad} of ${tot} shapes are NOT equivariant`);
if (which.length) console.log('  ' + which.slice(0, 12).join(' '));
