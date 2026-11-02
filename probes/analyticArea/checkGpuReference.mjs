// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independently check each measured arm's worst sampled pixel against the RAW
// SVG fill rule, using y integration of rowSpans (not an integral/winding fold).
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const [out, ...files] = process.argv.slice(2),
  rows = [];
const slices = +(process.env.SLICES || 8192);
for (const file of files) {
  const data = JSON.parse(readFileSync(file));
  for (const row of data.rows) {
    const c = data.config.cases.find((c) => c.name === row.name && c.size === row.size);
    if (!c.samples) continue;
    const sec = await importSvg(c.svg),
      b = headlessCPatchBundle(sec),
      r = b.curveRangesByShape[0],
      cs = contoursToConverter(
        curveRangeToContours(cpatchCurvePlane(b), r.begin, r.end),
        null,
      ).flat();
    const eo = shapeEvenOdd(b, 0),
      step = c.bbox[2] / c.size;
    const pixels = new Map();
    for (const a of row.arms) {
      const p = a.quality?.worst;
      if (p) pixels.set(p.x + ',' + p.y, p);
    }
    for (const p of pixels.values()) {
      const x = c.bbox[0] + p.x * step,
        y = c.bbox[1] + p.y * step;
      const ref = (n) => {
        let area = 0;
        for (let j = 0; j < n; j++)
          for (const [a, z] of rowSpans(cs, y + ((j + 0.5) * step) / n, eo))
            area += Math.max(0, Math.min(z, x + step) - Math.max(a, x));
        return area / (step * n);
      };
      const a = ref(slices),
        coarse = ref(slices / 4);
      rows.push({
        file,
        name: c.name,
        size: c.size,
        x: p.x,
        y: p.y,
        analytic: p.area,
        rawFillReference: a,
        delta: Math.abs(a - p.area),
        referenceDrift: Math.abs(a - coarse),
      });
    }
  }
}
const report = {
  slices,
  rows,
  maxDelta: Math.max(...rows.map((r) => r.delta)),
  maxReferenceDrift: Math.max(...rows.map((r) => r.referenceDrift)),
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log({
  pixels: rows.length,
  maxDelta: report.maxDelta,
  maxReferenceDrift: report.maxReferenceDrift,
});
if (report.maxDelta > 0.0001 || report.maxReferenceDrift > 0.0003)
  throw new Error('Reference needs more refinement');
