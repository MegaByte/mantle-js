// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _spanAudit — how well does 65536/_koScale stand for the shape's extent?
//
// _setKeyOrigin builds its bbox from segment START points only (`s.p1`), and falls back to
// _koScale = 64 -- an ABSOLUTE constant -- when that bbox is degenerate. Every tolerance the
// em-tuned-length fix writes against 65536/_koScale inherits both. This prints, per shape, the
// ratio of that stand-in to the true control-point diagonal.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, _setKeyOrigin, _koScale } =
  await import('../../src/geom/lbContour.js');
const lbc = await import('../../src/geom/lbContour.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const dir = (d) =>
  existsSync(path.join(ROOT, d))
    ? readdirSync(path.join(ROOT, d))
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .map((f) => d + '/' + f)
    : [];
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...dir('examples'), ...dir('examples/smoke')];
const rows = [];
for (const f of files) {
  let bundle;
  try {
    bundle = await importSvg(readFileSync(path.resolve(ROOT, f), 'utf8'));
  } catch {
    continue;
  }
  if (!bundle.numShapes || !bundle.curves) continue;
  const cf = new Float32Array(bundle.curves);
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    let cs;
    try {
      cs = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!cs || !cs.length) continue;
    _setKeyOrigin(cs);
    const stand = 65536 / lbc._koScale;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of cs)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
    const truth = Math.hypot(x1 - x0, y1 - y0);
    if (!(truth > 0)) continue;
    rows.push({
      f,
      s,
      stand,
      truth,
      ratio: stand / truth,
      segs: cs.reduce((a, c) => a + c.length, 0),
    });
  }
}
rows.sort((a, b) => b.ratio - a.ratio);
const R = rows.map((r) => r.ratio).sort((a, b) => a - b);
const q = (p) => R[Math.min(R.length - 1, Math.round(p * (R.length - 1)))];
console.log(
  `${rows.length} shapes.  stand-in / true diagonal:  min ${q(0).toFixed(4)}  p05 ${q(0.05).toFixed(4)}  p50 ${q(0.5).toFixed(4)}  p95 ${q(0.95).toFixed(4)}  max ${q(1).toExponential(3)}`,
);
console.log(
  `  within 2x of the truth: ${R.filter((v) => v >= 0.5 && v <= 2).length};  outside 4x: ${R.filter((v) => v < 0.25 || v > 4).length};  outside 64x: ${R.filter((v) => v < 1 / 64 || v > 64).length}`,
);
console.log('worst over-estimates (tolerances too COARSE for the shape):');
for (const r of rows.slice(0, 12))
  console.log(
    `  ${(r.f.replace('examples/', '') + ' #' + r.s).padEnd(60)} segs ${String(r.segs).padStart(4)}  stand ${r.stand.toFixed(3)}  true ${r.truth.toFixed(3)}  x${r.ratio.toFixed(1)}`,
  );
console.log('worst under-estimates (tolerances too FINE):');
for (const r of rows.slice(-6))
  console.log(
    `  ${(r.f.replace('examples/', '') + ' #' + r.s).padEnd(60)} segs ${String(r.segs).padStart(4)}  stand ${r.stand.toFixed(3)}  true ${r.truth.toFixed(3)}  x${r.ratio.toFixed(3)}`,
  );
