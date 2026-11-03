// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleTrace — the FIRST decision that differs between two scales.
//
// Counting non-equivariant shapes says how bad it is; it does not say which comparison did it. The
// converter already records one decision per node (opts.trace, for replayContour), so running the
// same shape at 2^0 and 2^k and diffing those two sequences lands on the exact step where the two
// runs part company -- and the op name says which test.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const SHAPES = (process.env.SHAPES || Array.from({ length: 60 }, (_, i) => i + 10).join(','))
  .split(',')
  .map(Number);
const K = +(process.env.K || 4);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const tally = new Map();
let same = 0;
for (const s of SHAPES) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cv = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  if (!cv || !cv.length) continue;
  // The packer only KEEPS a trace when it is recording a bake, so ask for one: traceOut is the
  // Map it fills, keyed by the contour (whose key differs between scales, so read the values).
  const run = (S) => {
    const traceOut = new Map();
    try {
      packCPatchShape(scaleCv(cv, S), 0, { evenOdd, traceOut });
    } catch {
      /* the diff stands */
    }
    const out = [];
    for (const v of traceOut.values()) if (Array.isArray(v)) out.push(...v);
    return out;
  };
  // A DECISION, NOT ITS COORDINATES. The trace records the point a cut was aimed at, and that point
  // scales with the artwork -- comparing it raw makes every equivariant run look divergent. Divide
  // the coordinates back out and compare what was DECIDED.
  const S = Math.pow(2, K);
  const norm = (r, sc) => {
    if (!r) return r;
    const o = {};
    for (const k2 of Object.keys(r).sort()) {
      const v = r[k2];
      o[k2] = Array.isArray(v)
        ? v.map((x) => (typeof x === 'number' ? +(x / sc).toPrecision(9) : x))
        : k2 === 'point' && typeof v === 'number'
          ? +(v / sc).toPrecision(9)
          : v;
    }
    return JSON.stringify(o);
  };
  const A = run(1),
    B = run(S);
  let i = 0;
  while (i < A.length && i < B.length && norm(A[i], 1) === norm(B[i], S)) i++;
  if (i >= A.length && i >= B.length) {
    same++;
    continue;
  }
  const a = A[i],
    b = B[i];
  const key = `${a ? a.op : '(end)'}${a && a.tag ? '/' + a.tag : ''} -> ${b ? b.op : '(end)'}${b && b.tag ? '/' + b.tag : ''}`;
  tally.set(key, (tally.get(key) | 0) + 1);
  if (tally.size <= 6)
    console.log(
      `s${s}: ${A.length} vs ${B.length} decisions; first differs at #${i}: ` +
        `${norm(a, 1)} vs ${norm(b, S)}`,
    );
}
console.log(`\n${same} shapes identical, ${tally.size} distinct divergences`);
console.log(
  '  ' +
    [...tally]
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} x${v}`)
      .join('  '),
);
