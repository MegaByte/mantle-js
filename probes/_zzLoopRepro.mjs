// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLoopRepro — replay one extracted loop at a range of scales. A standalone repro is what makes
// an epsilon bisectable: flip a candidate, re-run, read one number.
import { readFileSync } from 'fs';
import { convertContour } from '../src/renderer/cpatchConvert.js';
const J = JSON.parse(readFileSync(process.env.IN, 'utf8'));
const base = J.a.map((sg) => ({
  t: sg.t,
  P: sg.P.map((p) => [p[0] / J.Sa, p[1] / J.Sa]),
  ...(sg.cut ? { cut: true } : {}),
}));
const sc = (S) =>
  base.map((sg) => ({
    t: sg.t,
    P: sg.P.map((p) => [p[0] * S, p[1] * S]),
    ...(sg.cut ? { cut: true } : {}),
  }));
const out = [];
for (const k of (process.env.KS || '-4,-3,-2,-1,0,1,2,3,4').split(',').map(Number)) {
  globalThis.__CP_NODE_TRACE = [];
  globalThis.__CP_CRIT_TRACE = process.env.DETAIL ? [] : null;
  globalThis.__CP_CURVECUT_TRACE = process.env.DETAIL ? [] : null;
  const trace = [];
  const c = convertContour(sc(2 ** k), {
    maxCurves: 8,
    maxDepth: Number(process.env.MAXD || 6),
    trace,
  });
  out.push(`2^${k}:${c ? c.patches.length : 'null'}/${globalThis.__CP_NODE_TRACE.length}n`);
  if (process.env.DETAIL) {
    const S = 2 ** k;
    console.log(`-- 2^${k} --`);
    for (const e of globalThis.__CP_NODE_TRACE)
      console.log(
        '   ' +
          (e.pop
            ? `POP n=${e.n} d=${e.d} ext/S=${(e.ext / S).toExponential(8)}`
            : `  bad ${e.kind} i${e.i}j${e.j} dep/S=${(e.dep / S).toExponential(8)} tol/S=${(e.tol / S).toExponential(8)}`),
      );
    for (const e of globalThis.__CP_CURVECUT_TRACE || [])
      console.log(
        '   cc ' +
          (e.tried
            ? `n=${e.n} worst=${e.worst} tried=[${e.tried}]`
            : `score ci=${e.score} pairs=${e.pairs} depth/S=${(e.depth / S).toExponential(8)} better=${e.better}`),
      );
    console.log('   trace ' + JSON.stringify(trace));
  }
}
console.log(
  `loop n=${base.length} ext=${(() => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const s of base)
      for (const p of s.P) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
    return Math.max(x1 - x0, y1 - y0).toExponential(4);
  })()}`,
);
console.log('  ' + out.join('  '));
