// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzNodeRepro — pull the loop at the first divergent node out of both runs and check it is the
// same geometry up to the scale. If it is, the divergence is in how that one node is handled and
// the loop can be replayed on its own; if it is not, the divergence is upstream of it.
import { readFileSync, writeFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles, groupContours } from '../src/geom/cpatchGraph.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const s = Number(process.env.SHAPE || 68),
  G = Number(process.env.G || 0);
const cs = contoursToConverter(
  curveRangeToContours(cf, sec.curveRangesByShape[s].begin | 0, sec.curveRangesByShape[s].end | 0),
  null,
);
globalThis.__CP_NODE_CURVES = 1;
const runs = {};
for (const k of (process.env.KS || '0,2').split(',').map(Number)) {
  const S = 2 ** k;
  const g = groupContours(pathToCycles(scaleCv(cs, S), false), false)[G];
  globalThis.__CP_NODE_TRACE = [];
  convertContour(g.outer, { maxCurves: 8, holes: g.holes && g.holes.length ? g.holes : null });
  runs[k] = { S, nodes: globalThis.__CP_NODE_TRACE };
}
const [ka, kb] = Object.keys(runs);
const A = runs[ka],
  B = runs[kb];
// The node's TYPES as well as its size: two loops can agree on curve count, depth and extent and
// still be different geometry, and aligning on the coarse key then reports the wrong node.
const key = (e, S) =>
  e.pop
    ? `POP ${e.n} ${e.d} ${(e.ext / S).toExponential(12)} ${(e.curves || []).map((c) => c.t[0] + c.P.length + (c.cut ? 'c' : '')).join('')}`
    : `bad ${e.kind} ${e.i} ${e.j}`;
let first = -1;
for (let i = 0; i < Math.max(A.nodes.length, B.nodes.length); i++)
  if (key(A.nodes[i] || {}, A.S) !== key(B.nodes[i] || {}, B.S)) {
    first = i;
    break;
  }
console.log(`first divergent node: #${first} of ${A.nodes.length}/${B.nodes.length}`);
// The last node both runs agree on, and its loop: that is the input to the step that differs.
const at = first - 1;
for (let i = at; i >= 0; i--)
  if (A.nodes[i].pop && B.nodes[i].pop) {
    const a = A.nodes[i],
      b = B.nodes[i];
    let rel = 0,
      shape = '';
    for (let c = 0; c < a.curves.length; c++) {
      const ca = a.curves[c],
        cb = b.curves[c];
      if (!cb || ca.t !== cb.t || ca.P.length !== cb.P.length) {
        shape = `curve ${c}: ${ca.t}/${ca.P.length}pt vs ${cb ? cb.t + '/' + cb.P.length + 'pt' : 'missing'}`;
        break;
      }
      for (let q = 0; q < ca.P.length; q++)
        for (let d = 0; d < 2; d++) {
          const u = ca.P[q][d] / A.S,
            v = cb.P[q][d] / B.S;
          rel = Math.max(rel, Math.abs(u - v) / Math.max(Math.abs(u), 1e-300));
        }
    }
    console.log(
      `last agreed POP #${i}: n=${a.n} d=${a.d} ext/S=${(a.ext / A.S).toExponential(6)}  ` +
        (shape
          ? `SHAPE DIFFERS -- ${shape}`
          : `curve coords differ by rel ${rel.toExponential(2)}`),
    );
    writeFileSync(
      process.env.OUT || '/tmp/node.json',
      JSON.stringify({ a: a.curves, b: b.curves, Sa: A.S, Sb: B.S }),
    );
    break;
  }
