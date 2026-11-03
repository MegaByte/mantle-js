// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Sample real imported fill boundaries. CPU only, no browser, no GPU timing.
// node probes/analyticArea/corpus.mjs OUT.json /absolute/asset.svg[#shape,shape] ...
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { pathToCycles } = await import('../../src/geom/cpatchGraph.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const { boundaryArea, point } = await import('./area.mjs');

const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) throw new Error('Expected OUT.json and asset.svg[#shape,shape] ...');
const sizes = (process.env.SIZES || '32,128,512').split(',').map(Number),
  slices = +(process.env.SLICES || 512);
const refine = process.env.REFINE
  ? JSON.parse(readFileSync(process.env.REFINE, 'utf8')).rows
  : null;
function close(cs) {
  return cs.map((c) => {
    const a = point(c[0], 0),
      b = point(c.at(-1), 1);
    return a[0] === b[0] && a[1] === b[1] ? c : [...c, { t: 'line', P: [b, a] }];
  });
}
function reference(curves, evenodd, x, y, px, n) {
  let area = 0;
  for (let i = 0; i < n; i++)
    for (const [a, b] of rowSpans(curves, y + (px * (i + 0.5)) / n, evenodd))
      area += Math.max(0, Math.min(b, x + px) - Math.max(a, x));
  return area / (px * n);
}
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sizes,
  slices,
  rows: [],
  assets: [],
  scope:
    'Stratified edge samples, not full images. Float64 CPU reference, not GPU evidence. Raw fill-rule reference uses numerical y integration.',
};
for (const arg of files) {
  const [file, indices] = arg.split('#'),
    svg = readFileSync(file, 'utf8');
  const b = headlessCPatchBundle(await importSvg(svg)),
    cf = cpatchCurvePlane(b);
  const shapes = b.curveRangesByShape
    .map((r, i) => {
      if (!r) return null;
      const cs = contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
      return cs?.length ? { i, cs: close(cs) } : null;
    })
    .filter(Boolean);
  const allPoints = shapes.flatMap((s) => s.cs.flatMap((c) => c.flatMap((s) => s.P)));
  const ox = Math.min(...allPoints.map((p) => p[0])),
    oy = Math.min(...allPoints.map((p) => p[1]));
  const ext = Math.max(
    Math.max(...allPoints.map((p) => p[0])) - ox,
    Math.max(...allPoints.map((p) => p[1])) - oy,
  );
  const ids = indices
    ? indices.split(',').map(Number)
    : [0, Math.floor(shapes.length / 2), shapes.length - 1].map((j) => shapes[j]?.i);
  report.assets.push({
    file,
    sha256: createHash('sha256').update(svg).digest('hex'),
    shapes: shapes.length,
  });
  for (const i of [...new Set(ids)]) {
    const s = shapes.find((s) => s.i === i);
    if (!s) throw new Error(`Missing shape ${i}: ${file}`);
    const evenodd = shapeEvenOdd(b, i),
      raw = s.cs.flat(),
      start = performance.now();
    const boundary = pathToCycles(s.cs, evenodd).flat(),
      buildMs = performance.now() - start;
    for (const size of sizes) {
      const px = ext / size,
        pixels = new Map();
      for (let k = 0; k < 24; k++) {
        const seg = raw[Math.floor((k * raw.length) / 24)],
          p = point(seg, ((k % 3) + 1) / 4);
        const ix = Math.floor((p[0] - ox) / px),
          iy = Math.floor((p[1] - oy) / px);
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [-1, -1],
        ])
          pixels.set(`${ix + dx},${iy + dy}`, [ox + (ix + dx) * px, oy + (iy + dy) * px]);
      }
      if (refine) {
        pixels.clear();
        const previous = refine.find((r) => r.file === file && r.shape === i && r.size === size);
        if (!previous?.worst) continue;
        pixels.set('previous-worst', [previous.worst.x, previous.worst.y]);
      }
      let sumError = 0,
        maxError = 0,
        maxReferenceDelta = 0,
        maxBoundaryIntegralError = 0,
        invalid = 0,
        worst = null;
      const stats = { polynomialEquations: 0, arcEquations: 0, intervals: 0 };
      for (const [x, y] of pixels.values()) {
        const area = boundaryArea(boundary, x, y, px, stats);
        const ref = reference(raw, evenodd, x, y, px, slices),
          coarse = reference(raw, evenodd, x, y, px, slices / 4);
        const boundaryRef = reference(boundary, false, x, y, px, slices);
        const error = Math.abs(area - ref);
        sumError += error;
        maxReferenceDelta = Math.max(maxReferenceDelta, Math.abs(ref - coarse));
        maxBoundaryIntegralError = Math.max(maxBoundaryIntegralError, Math.abs(area - boundaryRef));
        if (area < -1e-7 || area > 1 + 1e-7) invalid++;
        if (error > maxError) {
          maxError = error;
          worst = { x, y, area, ref, boundaryRef };
        }
      }
      const row = {
        file,
        shape: i,
        size,
        segments: raw.length,
        boundarySegments: boundary.length,
        buildMs,
        pixels: pixels.size,
        meanError: sumError / pixels.size,
        maxError,
        maxReferenceDelta,
        maxBoundaryIntegralError,
        invalid,
        stats,
        worst,
      };
      report.rows.push(row);
      console.log(
        `${file.split('/').at(-1)} #${i} @${size}: ${pixels.size} px, max ${maxError.toExponential(2)}, ref drift ${maxReferenceDelta.toExponential(2)}, boundary integral ${maxBoundaryIntegralError.toExponential(2)}, invalid ${invalid}`,
      );
    }
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
