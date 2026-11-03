// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzTolCorpus — what the converter's accepted defect size costs, across the corpus.
//
// tolPx is not an epsilon, it is a POLICY: how far inside a shape a patch may fall short and still
// be called valid. Anything above zero is a hole by design, invisible at the scale the artwork is
// normally drawn and visible when it is zoomed. This prices tightening it -- patches, refusals and
// conversion time -- so the trade is a measurement rather than a preference.
import { readFileSync, readdirSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const dir = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => dir + '/' + f);
const jobs = [];
for (const f of files) {
  let s = null;
  try {
    s = await importSvg(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  if (!s || !s.curves || !s.curveRangesByShape) continue;
  const cf = new Float32Array(s.curves);
  for (const r of s.curveRangesByShape) {
    const cs = curveRangeToContours(
      cf,
      r.begin | 0,
      (r.end != null ? r.end : r.begin + r.count) | 0,
    );
    const list = cs && cs.length ? contoursToConverter(cs, null) : null;
    if (!list || !list.length) continue;
    let cycles = [];
    try {
      cycles = pathToCycles(list, false) || [];
    } catch {
      cycles = [];
    }
    if (!cycles.length)
      cycles = list.map((c) => {
        const a = segPt(c[0], 0),
          b = segPt(c[c.length - 1], 1);
        return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6
          ? c
          : c.concat([{ t: 'line', P: [b, a] }]);
      });
    for (const c of cycles) jobs.push(c);
  }
}
console.log(`${files.length} assets, ${jobs.length} cycles`);
for (const tol of (process.env.TOLS || '0.05,0.02,0.01').split(',').map(Number)) {
  let pat = 0,
    ref = 0;
  const t0 = Date.now();
  for (const c of jobs) {
    try {
      const rr = convertContour(c, { maxCurves: 8, tolPx: tol });
      if (rr && rr.patches) pat += rr.patches.length;
      else ref++;
    } catch {
      ref++;
    }
  }
  console.log(
    `  tolPx ${String(tol).padEnd(6)} ${String(pat).padStart(6)} patches  ${String(ref).padStart(4)} refused  ${Date.now() - t0} ms`,
  );
}
