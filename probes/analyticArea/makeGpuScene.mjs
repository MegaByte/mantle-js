// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Solid fill-only artwork, preserving shape order and paint. Reject unsupported
// paint/compositing rather than silently benchmark a simplified scene.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { pathToCycles } = await import('../../src/geom/cpatchGraph.js');
const L = await import('../../src/bundle/layout.js');
const { pathData } = await import('./serialize.mjs');
const { splitMonotone } = await import('./monotone.mjs');
const [file, out] = process.argv.slice(2);
const svg = readFileSync(file, 'utf8'),
  sec = await importSvg(svg),
  b = headlessCPatchBundle(sec),
  cf = cpatchCurvePlane(b);
const paths = [],
  monotonePaths = [],
  stats = [];
for (let i = 0; i < b.numShapes; i++) {
  const m = b.metaFloats.subarray(i * b.metaFloatsPerShape, (i + 1) * b.metaFloatsPerShape);
  for (const key of [
    'META_STROKE_A',
    'META_FILL_GRAD',
    'META_CLIP_ID',
    'META_MASK_ID',
    'META_FILTER_ID',
    'META_BLEND_MODE',
    'META_ISOLATION',
    'META_IMAGE_ID',
    'META_COLR_GRAPH',
  ])
    if (m[L[key]]) throw new Error('Unsupported ' + key + ' on shape ' + i);
  if (!m[L.META_FILL_A]) continue;
  const range = b.curveRangesByShape[i],
    raw = contoursToConverter(curveRangeToContours(cf, range.begin, range.end), null);
  if (!raw) throw new Error('Unconvertible fill ' + i);
  const t = performance.now(),
    cycles = pathToCycles(raw, shapeEvenOdd(b, i));
  if (!cycles.length) throw new Error('Empty normalization ' + i);
  stats.push({
    shape: i,
    raw: raw.flat().length,
    normalized: cycles.flat().length,
    ms: performance.now() - t,
  });
  const rgb = [L.META_FILL_R, L.META_FILL_G, L.META_FILL_B].map((k) => Math.round(m[k] * 255));
  paths.push(
    `<path fill="rgb(${rgb.join(',')})" fill-opacity="${m[L.META_FILL_A]}" d="${pathData(cycles)}"/>`,
  );
  monotonePaths.push(
    `<path fill="rgb(${rgb.join(',')})" fill-opacity="${m[L.META_FILL_A]}" d="${pathData(splitMonotone(cycles))}"/>`,
  );
}
const normalized = '<svg xmlns="http://www.w3.org/2000/svg">' + paths.join('') + '</svg>';
const monotone = '<svg xmlns="http://www.w3.org/2000/svg">' + monotonePaths.join('') + '</svg>';
writeFileSync(
  out,
  JSON.stringify(
    {
      forceUnified: true,
      defaults: {
        rounds: 11,
        batch: 4,
        repetitions: 2,
        arms: [
          { name: 'cpatch', engine: 'cpatch' },
          { name: 'areaUnified', engine: 'aac', normalized: true },
          { name: 'slugUnified', engine: 'slug' },
          { name: 'cpatchAA', engine: 'cpatch' },
        ],
      },
      preparation: {
        file,
        shapes: stats.length,
        normalizeMs: stats.reduce((s, x) => s + x.ms, 0),
        stats,
      },
      cases: [32, 512].map((size) => ({
        name: file.split('/').at(-1),
        size,
        svg,
        normalized,
        monotone,
        bbox: sec.globalBBox,
      })),
    },
    null,
    2,
  ),
);
console.log(out, stats.length + ' shapes');
