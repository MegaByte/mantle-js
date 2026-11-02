// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzKindScale — the packed implicit KIND of every curve, at two exactly-related sizes. The kind
// decides which validator runs and which critical-point solver applies, so a curve that is a line
// at one size and a Bezout cubic at another is validated by a different test entirely.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { segImplicitPacked } from '../src/geom/cpatchImplicit.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
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
let bad = 0,
  tot = 0;
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const kinds = (S) => {
    const cy = pathToCycles(scaleCv(cs, S), false);
    const o = [];
    for (const c of cy)
      for (const sg of c) {
        let k = -1;
        try {
          const p = segImplicitPacked(sg);
          k = p ? p.kind : -2;
        } catch {
          k = -3;
        }
        o.push(k);
      }
    return o;
  };
  const b = kinds(1);
  tot++;
  for (const k of (process.env.KS || '-4,-2,-1,1,2,4').split(',').map(Number)) {
    const a = kinds(2 ** k);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      bad++;
      const at =
        a.length === b.length
          ? a
              .map((v, i) => (v !== b[i] ? `${i}:${b[i]}->${v}` : null))
              .filter(Boolean)
              .join(' ')
          : `count ${b.length}->${a.length}`;
      console.log(`s${s} @2^${k}: ${at}`);
      break;
    }
  }
}
console.log(`segImplicitPacked kinds: ${bad} of ${tot} shapes are NOT equivariant`);
