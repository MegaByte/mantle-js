// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCorpusProfile — what an asset IS, before anything is measured about how fast it draws.
//
// tiger is one point in a space with several axes, and the engines are known to trade differently
// along each: Slug's cost follows FILL AREA, Loop-Blinn's follows the per-draw fixed cost and so
// the SHAPE COUNT, CPatch's follows curves-per-patch and the fragment's block count. A corpus
// picked by eye cannot say which axis a number came from, so this measures the axes first and the
// selection is made from the numbers.
//
// Node only -- no GL, no browser. Prints one row per asset:
//   shapes  curves  lines/quads/cubics/arcs  curves-per-shape  viewBox  path
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, cpatchCurvePlane } = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } = await import('../src/svg/segs.js').catch(
  () => ({ SEG_LINE: 0, SEG_QUAD: 1, SEG_CUBIC: 2, SEG_RQUAD: 4 }),
);
const TYPE = { [SEG_LINE]: 'line', [SEG_QUAD]: 'quad', [SEG_CUBIC]: 'cubic', [SEG_RQUAD]: 'rquad' };

const files = process.argv.slice(2);
const rows = [];
for (const f of files) {
  let svg;
  try {
    svg = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (svg.length > 4_000_000) continue;
  let sections, bundle, cf;
  try {
    sections = await importSvg(svg);
    bundle = headlessCPatchBundle(sections);
    cf = cpatchCurvePlane(bundle);
  } catch (e) {
    rows.push({ f, err: String(e.message || e).slice(0, 40) });
    continue;
  }
  let shapes = 0,
    curves = 0,
    contours = 0;
  const mix = { line: 0, quad: 0, cubic: 0, arc: 0, rquad: 0, other: 0 };
  for (let s = 0; s < (bundle.curveRangesByShape || []).length; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r) continue;
    let cs = null;
    try {
      cs = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    shapes++;
    contours += cs.length;
    for (const c of cs)
      for (const sg of c) {
        curves++;
        const t = TYPE[sg.type] || sg.t;
        if (mix[t] === undefined) mix.other++;
        else mix[t]++;
      }
  }
  const vb = sections && sections.viewBox ? sections.viewBox : [0, 0, 0, 0];
  if (shapes) rows.push({ f, shapes, curves, contours, mix, vb, cps: curves / shapes });
}
rows.sort((a, b) => (b.curves | 0) - (a.curves | 0));
console.log('shapes\tcurves\tcont\tc/shape\tline\tquad\tcubic\tarc\tvb\tpath');
for (const r of rows) {
  if (r.err) {
    console.log(`ERR\t${r.err}\t${r.f}`);
    continue;
  }
  const m = r.mix;
  console.log(
    `${r.shapes}\t${r.curves}\t${r.contours}\t${r.cps.toFixed(1)}\t${m.line}\t${m.quad}\t${m.cubic}\t${m.arc + m.rquad}\t${Math.round(r.vb[2])}x${Math.round(r.vb[3])}\t${r.f}`,
  );
}
