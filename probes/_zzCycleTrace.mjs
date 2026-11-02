// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCycleTrace — the converter's decision trace for ONE cycle at two exactly-related sizes,
// with the recorded coordinates divided back out so only real decisions show.
import { readFileSync } from 'fs';
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
const norm = (rec, S) => {
  const o = { ...rec };
  if (o.point) o.point = [o.point[0] / S, o.point[1] / S];
  return JSON.stringify(o);
};
const s = Number(process.env.SHAPE || 61),
  G = Number(process.env.G || 0);
const r = sec.curveRangesByShape[s];
const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
const out = {};
for (const k of (process.env.KS || '0,2').split(',').map(Number)) {
  const S = 2 ** k;
  const g = groupContours(pathToCycles(scaleCv(cs, S), false), false)[G];
  const trace = [];
  globalThis.__CP_NODE_TRACE = [];
  globalThis.__CP_DEP_TRACE = [];
  globalThis.__CP_CRIT_TRACE = [];
  globalThis.__CP_CURVECUT_TRACE = [];
  const c = convertContour(g.outer, {
    maxCurves: 8,
    holes: g.holes && g.holes.length ? g.holes : null,
    trace,
  });
  // Depths, tolerances and extents are LENGTHS: divide the scale back out so equal geometry reads
  // as equal numbers.
  out[k] = {
    n: c ? c.patches.length : -1,
    trace: trace.map((t) => norm(t, S)),
    nodes: globalThis.__CP_NODE_TRACE.map((e) =>
      e.push
        ? `      push n0=${e.n0} n=${e.n} area=${e.area} ext=${(e.ext / S).toExponential(8)}`
        : e.dec
          ? `    dec ${norm(e.dec, S)}`
          : e.pop
            ? `POP wl=${e.wl} n=${e.n} d=${e.d} ext=${(e.ext / S).toExponential(6)}`
            : `  bad ${e.kind || '?'} i${e.i}j${e.j} dep=${(e.dep / S).toExponential(6)} tol=${(e.tol / S).toExponential(6)}`,
    ),
    cc: globalThis.__CP_CURVECUT_TRACE.map((e) =>
      e.tried
        ? `n=${e.n} worst=${e.worst} tried=[${e.tried}]`
        : `score ci=${e.score} pairs=${e.pairs} depth/S=${(e.depth / S).toExponential(8)} better=${e.better}`,
    ),
    crit: globalThis.__CP_CRIT_TRACE.map(
      (e) =>
        `i${e.i} ${e.br}${e.kind !== undefined ? ' kind' + e.kind : ''}` +
        (e.f !== undefined ? ` f=${e.f.toExponential(6)}` : '') +
        (e.gl !== undefined
          ? ` gl*S=${(e.gl * S).toExponential(6)} depth/S=${(e.depth / S).toExponential(6)}`
          : '') +
        (e.q ? ` q=(${(e.q[0] / S).toFixed(6)},${(e.q[1] / S).toFixed(6)})` : ''),
    ),
    // only THE DECISION-RELEVANT QUANTITIES. `min`, `gl` and `bMag` scale differently depending on
    // whether the implicit is a line (degree 1, unit normal) or a curve (normalized to its own
    // frame), so displaying them side by side invents differences. The pair, the parameter and the
    // DEPTH are what the search acts on, and all three are comparable across scales.
    deps: globalThis.__CP_DEP_TRACE.map(
      (e) => `i${e.i}j${e.j} t=${e.t.toFixed(12)} dep/S=${(e.dep / S).toExponential(8)}`,
    ),
  };
}
const ks = Object.keys(out);
const A = out[ks[0]],
  B = out[ks[1]];
console.log(
  `s${s} group ${G}: ${A.n} vs ${B.n} patches;  ${A.trace.length} vs ${B.trace.length} decisions`,
);
let first = -1;
for (let i = 0; i < Math.max(A.nodes.length, B.nodes.length); i++)
  if (A.nodes[i] !== B.nodes[i]) {
    first = i;
    break;
  }
if (first >= 0) {
  const W = Number(process.env.WIN || 3);
  for (
    let i = Math.max(0, first - W);
    i < Math.min(Math.max(A.nodes.length, B.nodes.length), first + W);
    i++
  )
    console.log(
      `  ${i === first ? '>' : ' '}node #${i}: ${A.nodes[i] || '(end)'}\n            ${B.nodes[i] || '(end)'}`,
    );
}
console.log(`  nodes ${A.nodes.length} vs ${B.nodes.length}`);
console.log('  --- curve cuts ---');
{
  let f3 = -1;
  for (let i = 0; i < Math.max(A.cc.length, B.cc.length); i++)
    if (A.cc[i] !== B.cc[i]) {
      f3 = i;
      break;
    }
  const W = Number(process.env.WIN || 3);
  console.log(`  first cc difference at #${f3} of ${A.cc.length}/${B.cc.length}`);
  if (f3 >= 0)
    for (let i = Math.max(0, f3 - W); i < Math.min(Math.max(A.cc.length, B.cc.length), f3 + W); i++)
      console.log(`  ${i === f3 ? '>' : ' '} ${A.cc[i] || '(end)'}\n     ${B.cc[i] || '(end)'}`);
}
console.log('  --- interior critical points ---');
{
  let f2 = -1;
  for (let i = 0; i < Math.max(A.crit.length, B.crit.length); i++)
    if (A.crit[i] !== B.crit[i]) {
      f2 = i;
      break;
    }
  const W = Number(process.env.WIN || 3);
  if (f2 >= 0)
    for (
      let i = Math.max(0, f2 - W);
      i < Math.min(Math.max(A.crit.length, B.crit.length), f2 + W);
      i++
    )
      console.log(
        `  ${i === f2 ? '>' : ' '} ${A.crit[i] || '(end)'}\n     ${B.crit[i] || '(end)'}`,
      );
}
console.log(`  crit count ${A.crit.length} vs ${B.crit.length}`);
console.log('  --- first pair-clip evaluations ---');
{
  let f4 = -1;
  for (let i = 0; i < Math.max(A.deps.length, B.deps.length); i++)
    if (A.deps[i] !== B.deps[i]) {
      f4 = i;
      break;
    }
  console.log(`  first dep difference at #${f4} of ${A.deps.length}/${B.deps.length}`);
  const W = Number(process.env.WIN || 2);
  if (f4 >= 0)
    for (
      let i = Math.max(0, f4 - W);
      i < Math.min(Math.max(A.deps.length, B.deps.length), f4 + W);
      i++
    )
      console.log(
        `  ${i === f4 ? '>' : ' '} ${A.deps[i] || '(end)'}\n     ${B.deps[i] || '(end)'}`,
      );
}
