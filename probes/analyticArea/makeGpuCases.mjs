// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Preserve analytic degree when serializing the arranged fill boundary back to
// the existing importer/AAC renderer. No curve flattening. Geometry fixtures are
// explicitly single-color fills, not substitutes for complete artwork timings.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { pathToCycles } = await import('../../src/geom/cpatchGraph.js');
const { boundaryArea, point } = await import('./area.mjs');

import { pathData } from './serialize.mjs';
import { splitMonotone } from './monotone.mjs';

const wrap = (d, evenOdd = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><path fill="black" fill-rule="${evenOdd ? 'evenodd' : 'nonzero'}" d="${d}"/></svg>`;
const [out, ...files] = process.argv.slice(2);
if (!out) throw new Error('makeGpuCases.mjs OUT.json [asset.svg#shape,...]');
const sizes = (process.env.SIZES || '32,512').split(',').map(Number),
  cases = [];
const synthetic = [
  ['line', 'M8 15L115 36L97 117L52 90L8 112Z'],
  ['quad', 'M8 15Q65 -10 115 36Q130 80 97 117Q66 70 52 90Q9 131 8 112Z'],
  ['cubic', 'M8 15C52 -4 120 6 115 36C110 62 135 95 97 117C55 118 80 65 52 90C4 142 -6 101 8 15Z'],
  ['arc', 'M12 64A52 31 25 1 1 116 64A52 31 25 1 1 12 64Z'],
  [
    'cubic-hole',
    'M8 15C52 -4 120 6 115 36C110 62 135 95 97 117C55 118 80 65 52 90C4 142 -6 101 8 15Z M45 45L45 65L70 65L70 45Z',
  ],
  [
    'curved-overlap',
    'M20 64A30 30 0 1 1 80 64A30 30 0 1 1 20 64Z M45 64A30 30 0 1 1 105 64A30 30 0 1 1 45 64Z',
  ],
];
const inputs = files.length
  ? files.map((arg) => {
      const [file, ids] = arg.split('#');
      return {
        name: file.split('/').at(-1),
        svg: readFileSync(file, 'utf8'),
        ids: ids?.split(',').map(Number),
      };
    })
  : synthetic.map(([name, d]) => ({ name, svg: wrap(d) }));
for (const input of inputs) {
  const sec = await importSvg(input.svg),
    b = headlessCPatchBundle(sec),
    cf = cpatchCurvePlane(b);
  const ids = input.ids || b.curveRangesByShape.map((_, i) => i);
  for (const i of ids) {
    const range = b.curveRangesByShape[i];
    if (!range) throw new Error('Missing shape ' + i);
    const raw = contoursToConverter(curveRangeToContours(cf, range.begin, range.end), null);
    if (!raw?.length) continue;
    const eo = shapeEvenOdd(b, i),
      t = performance.now(),
      cycles = pathToCycles(raw, eo),
      normalizeMs = performance.now() - t;
    const P = raw.flatMap((c) => c.flatMap((s) => s.P)),
      min = [0, 1].map((k) => Math.min(...P.map((p) => p[k]))),
      max = [0, 1].map((k) => Math.max(...P.map((p) => p[k])));
    const span = Math.max(max[0] - min[0], max[1] - min[1]) * 1.1,
      bbox = [min[0] - 0.05 * span, min[1] - 0.05 * span, span, span];
    for (const size of sizes) {
      const pixels = new Map(),
        step = span / size;
      // Sample all segment locations across the boundary, including corners and
      // neighbouring empty/interior pixels. Reference is unquantized float64 area.
      const flat = raw.flat();
      for (let j = 0; j < 48; j++) {
        const s = flat[Math.floor((j * flat.length) / 48)],
          p = point(s, (j % 5) / 4);
        const x = Math.floor((p[0] - bbox[0]) / step),
          y = Math.floor((p[1] - bbox[1]) / step);
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [-1, -1],
        ])
          if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size)
            pixels.set(`${x + dx},${y + dy}`, [x + dx, y + dy]);
      }
      const samples = [...pixels.values()].map(([x, y]) => ({
        x,
        y,
        area: boundaryArea(cycles.flat(), bbox[0] + x * step, bbox[1] + y * step, step),
      }));
      if (samples.some((s) => s.area < -0.00001 || s.area > 1.00001))
        throw new Error('Invalid arranged boundary ' + input.name);
      cases.push({
        name: input.name + '#' + i,
        size,
        bbox,
        svg: wrap(pathData(raw), eo),
        normalized: wrap(pathData(cycles)),
        monotone: wrap(pathData(splitMonotone(cycles))),
        samples,
        geometry: {
          rawSegments: raw.flat().length,
          areaSegments: cycles.flat().length,
          normalizeMs,
        },
        source: input.name,
      });
    }
  }
}
writeFileSync(
  out,
  JSON.stringify({ defaults: { batch: 4, rounds: 7, repetitions: 8 }, cases }, null, 2) + '\n',
);
console.log(out + ': ' + cases.length + ' cases');
