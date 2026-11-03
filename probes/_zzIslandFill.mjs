// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does JS's CPatch paint an asset correctly AS AUTHORED?
//
// _cpatchCorpusFill's parser emits only lines, quads and cubics -- it DROPS arc commands -- so an
// asset drawn with arcs reaches the converter as a mangled shape and any over-fill reported for it
// is a fact about that mangling. This runs the REAL pipeline: the importer, the same
// curveRangeToContours decoder the renderer uses, and the FLOAT64 curve plane cpatchBuild reads.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { convertContour, insideContour, inPatch } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const file = process.argv[2];
const plane = process.argv[3] || 'f64';
const sections = await importSvg(readFileSync(file, 'utf8'));
const cf =
  plane === 'f32' || !sections.curves64
    ? new Float32Array(sections.curves)
    : new Float64Array(sections.curves64);
const ranges = sections.curveRangesByShape || [];
console.log(
  `${file}  plane=${cf instanceof Float64Array ? 'FLOAT64' : 'float32'}  shapes=${ranges.length}`,
);

const perCycle = process.argv.includes('percycle');
// CLOSED CONTOURS only, as _cpatchFillArea insists: an open contour has no interior, so both
// sides of the comparison are meaningless and it damns or flatters the converter at random. That
// probe records unclosed input reporting 64.7% over-fill beside 0.02% for the closed contours of
// the same file -- which is exactly the trap this harness fell into.
const isClosed = (cs) => {
  if (!cs.length) return false;
  const a = segPt(cs[0], 0),
    b = segPt(cs[cs.length - 1], 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
};
let openSkipped = 0;
let over = 0,
  under = 0,
  inTot = 0,
  outTot = 0,
  patches = 0,
  drew = 0,
  refused = 0;
const worst = [];
function measure(all, ps, tag) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const p of sg.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0) + 1;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  let lin = 0,
    lov = 0,
    lun = 0;
  const N = 60;
  for (let j = 0; j < N; j++) {
    const y = y0 + (y1 - y0) * ((j + 0.5) / N);
    for (let i = 0; i < N; i++) {
      const x = x0 + (x1 - x0) * ((i + 0.5) / N);
      const truth = insideContour(all, x, y);
      let got = false;
      for (const p of ps)
        if (inPatch(p, x, y)) {
          got = true;
          break;
        }
      if (truth) {
        inTot++;
        lin++;
      }
      if (got && !truth) {
        over++;
        lov++;
      } else if (!got && truth) {
        under++;
        lun++;
      }
    }
  }
  if (lin > 0 && (lov > lin * 0.05 || lun > lin * 0.05))
    worst.push({ tag, n: all.length, ps: ps.length, ov: (100 * lov) / lin, un: (100 * lun) / lin });
}
for (let s = 0; s < ranges.length; s++) {
  const r = ranges[s];
  const begin = r.begin | 0,
    end = (r.end != null ? r.end : r.begin + r.count) | 0;
  if (end <= begin) continue;
  let contours = null;
  try {
    contours = curveRangeToContours(cf, begin, end);
  } catch {
    continue;
  }
  if (!contours || !contours.length) continue;
  const list = contoursToConverter(contours, null);
  if (!list || !list.length) continue;
  let cyc = null;
  try {
    cyc = pathToCycles(list, false);
  } catch {
    cyc = null;
  }
  if (!cyc || !cyc.length) cyc = list;
  // PER CYCLE, as probes/_cpatchCorpusFill.mjs measures: each cycle's patches against that
  // cycle's own region. Measuring a whole shape's union against the shape instead mixes in
  // whatever the nesting resolution decided, which is a different question.
  if (perCycle) {
    for (const c of cyc) {
      if (!isClosed(c)) {
        openSkipped++;
        continue;
      }
      const res = convertContour(c, { tolPx: 0.05 });
      if (!res || !res.patches.length) {
        refused++;
        continue;
      }
      drew++;
      patches += res.patches.length;
      measure(c, res.patches, `shape${s}`);
    }
    continue;
  }
  let ps = [];
  let ok = true;
  for (const c of cyc) {
    const res = convertContour(c, { tolPx: 0.05 });
    if (!res || !res.patches.length) {
      ok = false;
      break;
    }
    ps = ps.concat(res.patches);
  }
  if (!ok || !ps.length) {
    refused++;
    continue;
  }
  drew++;
  patches += ps.length;
  const all = list.flat();
  measure(all, ps, `shape${s}`);
}
console.log(
  `  ${perCycle ? 'cycles' : 'shapes'} drawn ${drew}, refused ${refused}, open skipped ${openSkipped}, patches ${patches}`,
);
console.log(
  `  UNDER ${under} of ${inTot} interior samples (${((100 * under) / Math.max(1, inTot)).toFixed(3)}%)`,
);
console.log(
  `  OVER  ${over} painted outside, ${((100 * over) / Math.max(1, inTot)).toFixed(3)}% of the shape's area`,
);
worst.sort((a, b) => b.ov + b.un - (a.ov + a.un));
for (const w of worst.slice(0, 8))
  console.log(
    `    ${w.tag}: ${w.n} curves, ${w.ps} patches, over ${w.ov.toFixed(1)}%, under ${w.un.toFixed(1)}%`,
  );
console.log(`  (${worst.length} cycles over 5% either way)`);
