// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzResolveScale — is the self-overlap resolver equivariant? It is the retry the partition takes
// when the over-paint audit rejects the first build, so if IT moves with scale, everything the
// second build decides moves with it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { resolveSelfOverlap } from '../src/renderer/shapeResolve.js';
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
const nums = (cs) => {
  const o = [];
  for (const c of cs)
    for (const s of c) {
      o.push(s.type);
      for (const k of ['p1', 'p2', 'p3', 'p4'])
        if (s[k]) {
          o.push(s[k][0]);
          o.push(s[k][1]);
        }
    }
  return o;
};
let bad = 0,
  tot = 0;
for (let s = 0; s < (sec.curveRangesByShape || []).length; s++) {
  const r = sec.curveRangesByShape[s];
  if (!r) continue;
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  if (!cs || !cs.length) continue;
  const b = nums(resolveSelfOverlap(sc(cs, 1), 'nonzero'));
  tot++;
  for (const k of [-4, -2, -1, 1, 2, 4]) {
    const S = 2 ** k;
    const a = nums(resolveSelfOverlap(sc(cs, S), 'nonzero'));
    if (a.length !== b.length) {
      bad++;
      console.log(`s${s}: COUNT ${b.length} -> ${a.length} @2^${k}`);
      break;
    }
    let rel = 0;
    // Types are integers and must match exactly; coordinates scale.
    for (let i = 0; i < a.length; i++) {
      const v = i % 1 === 0 && Number.isInteger(b[i]) && Math.abs(b[i]) < 16 ? a[i] : a[i] / S;
      rel = Math.max(rel, Math.abs(v - b[i]) / Math.max(Math.abs(b[i]), 1e-300));
    }
    if (rel > 1e-9) {
      bad++;
      console.log(`s${s}: VALUES rel ${rel.toExponential(2)} @2^${k}`);
      break;
    }
  }
}
console.log(`resolveSelfOverlap: ${bad} of ${tot} shapes are NOT equivariant`);
