// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Dump tiger's arrangement cycles AND what the JS converter does with each, so the C# converter can be
// handed the identical input and compared contour by contour. The front end is then not a
// variable: any difference that shows up is the converter's.
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tigerCycles } from './_cpatchCycles.mjs';
import { convertContour, rowSpans, inPatch } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = process.argv[2] || 'examples/tiger.svg';
const out = process.argv[3] || '/tmp/cycles.json';
const closed = (cs) => {
  if (!cs.length) return true;
  const a = segPt(cs[0], 0),
    b = segPt(cs[cs.length - 1], 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
};
const close = (cs) =>
  closed(cs) ? cs : cs.concat([{ t: 'line', P: [segPt(cs[cs.length - 1], 1), segPt(cs[0], 0)] }]);
const cycles = tigerCycles(new URL('file://' + path.resolve(ROOT, rel))).cycles.map(close);

const recs = [];
for (const run of cycles) {
  if (!run || run.length < 2) continue;
  let r = null;
  const trace = [];
  const t = performance.now();
  try {
    r = convertContour(run, { tolPx: 0.05, trace });
  } catch (e) {
    /* refused */
  }
  const ms = performance.now() - t;
  const s = r && r.stats ? r.stats : {};
  recs.push({
    curves: run.map((sg) => ({ t: sg.t, P: sg.P, w: sg.w, cut: !!sg.cut })),
    ok: !!(r && r.patches),
    patches: r ? r.patches.length : 0,
    refs: r ? r.patches.reduce((a, p) => a + p.curves.length, 0) : 0,
    ms: +ms.toFixed(1),
    ...fill(run, r),
    // One entry per decision, in the order the search made them: what a port is diffed against.
    trace: trace.map((e) =>
      e.op === 'line'
        ? `line:${e.i},${e.j},${e.cand},${e.tag}`
        : e.op === 'ear'
          ? e.split === undefined
            ? 'ear'
            : 'earsplit'
          : e.op === 'curve'
            ? `curve:${e.i}`
            : e.op === 'own'
              ? `own:${e.i}`
              : e.op === 'chord'
                ? `chord:${e.i}`
                : e.op === 'sub'
                  ? `sub:${e.i}`
                  : e.op,
    ),
    st: {
      nodes: s.nodes | 0,
      cuts: s.cuts | 0,
      ear: s.earCuts | 0,
      curveCuts: s.curveCuts | 0,
      chord: s.chordCuts | 0,
      line: s.lineCuts | 0,
      cf: s.curveFallbacks | 0,
      sub: s.subdivisions | 0,
      term: s.terminal | 0,
      termNull: s.terminalNull | 0,
      ext: s.capExtended | 0,
      selfRes: s.selfResolved | 0,
      unresolved: s.unresolved | 0,
      degenerate: s.degenerate | 0,
      interiorRejects: s.interiorRejects | 0,
      maxDepth: s.maxDepth | 0,
      budgetOut: !!s.budgetExhausted,
      retriedFull: !!s.retriedFull,
      retriedNormalized: !!s.retriedNormalized,
      retriedFine: !!s.retriedFine,
    },
  });
}
writeFileSync(out, JSON.stringify(recs));
function fill(cs, r) {
  if (!r || !r.patches || !r.patches.length) return { miss: 0, over: 0 };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of cs)
    for (const p of s.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  let m = 0,
    tot = 0,
    oh = 0;
  const N = 40;
  for (let j = 0; j < N; j++) {
    const y = y0 + ((y1 - y0) * (j + 0.5)) / N;
    const spans = rowSpans(cs, y);
    for (let i = 0; i < N; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / N;
      let inR = false;
      for (const sp of spans)
        if (x >= sp[0] && x <= sp[1]) {
          inR = true;
          break;
        }
      let hit = false;
      for (const p of r.patches)
        if (inPatch(p, x, y)) {
          hit = true;
          break;
        }
      if (inR) {
        tot++;
        if (!hit) m++;
      } else if (hit) oh++;
    }
  }
  return {
    miss: tot ? +((100 * m) / tot).toFixed(3) : 0,
    over: tot ? +((100 * oh) / tot).toFixed(3) : 0,
  };
}
console.log(`wrote ${recs.length} cycles to ${out}`);
console.log(
  `converted ${recs.filter((r) => r.ok).length}, patches ${recs.reduce((a, r) => a + r.patches, 0)}`,
);
