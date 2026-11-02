// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Isolate solid fills touching a reported scene pixel, serializing the decoded
// curves and preserving the scene projection for GPU replay.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import importSvg from '../../src/svg/importer.js';
import * as CB from '../../src/renderer/cpatchBuild.js';
import { curveRangeToContours } from '../../src/geom/lbContour.js';
import { insideRule, rowSpans } from '../../src/renderer/cpatchConvert.js';
import { pathToCycles } from '../../src/geom/cpatchGraph.js';
import { splitMonotone } from './monotone.mjs';
import { pathData } from './serialize.mjs';
import * as L from '../../src/bundle/layout.js';
const [file, xs, ys, out] = process.argv.slice(2),
  d = JSON.parse(readFileSync(file)),
  config = d.config || d,
  c = config.cases[0],
  x = +xs,
  y = +ys;
const includeEmpty = process.argv.includes('--include-empty');
const [bx, by, bw, bh] = c.bbox,
  epp = Math.max(bw, bh) / c.size,
  px = bx + bw / 2 + (x + 0.5 - c.size / 2) * epp,
  py = by + bh / 2 + (y + 0.5 - c.size / 2) * epp;
const b = CB.headlessCPatchBundle(await importSvg(c.svg, { preserveViewport: true })),
  cf = CB.cpatchCurvePlane(b),
  doc = new DOMParser().parseFromString(c.svg, 'image/svg+xml');

const cases = [];
for (let i = 0; i < b.numShapes; i++) {
  const m = b.metaFloats.subarray(i * b.metaFloatsPerShape, (i + 1) * b.metaFloatsPerShape);
  if (px < m[0] - epp || px > m[2] + epp || py < m[1] - epp || py > m[3] + epp) continue;
  const range = b.curveRangesByShape[i],
    raw = CB.contoursToConverter(curveRangeToContours(cf, range.begin, range.end), null),
    eo = CB.shapeEvenOdd(b, i);
  let area = 0;
  for (let j = 0; j < 4096; j++)
    for (const [a, z] of rowSpans(raw.flat(), py + ((j + 0.5 - 2048) * epp) / 4096, eo))
      area += Math.max(0, Math.min(z, px + epp / 2) - Math.max(a, px - epp / 2));
  area /= epp * 4096;
  if (area === 0 && !includeEmpty) continue;
  const node = doc.createElement('path');
  node.setAttribute(
    'fill',
    'rgb(' +
      [L.META_FILL_R, L.META_FILL_G, L.META_FILL_B].map((k) => Math.round(m[k] * 255)).join(',') +
      ')',
  );
  node.setAttribute('fill-opacity', m[L.META_FILL_A]);
  node.setAttribute('fill-rule', eo ? 'evenodd' : 'nonzero');
  node.setAttribute('d', pathData(raw));
  const original = new XMLSerializer().serializeToString(node);
  node.setAttribute('d', pathData(splitMonotone(pathToCycles(raw, eo))));
  node.removeAttribute('fill-rule');
  const wrap = (s) => '<svg xmlns="http://www.w3.org/2000/svg">' + s + '</svg>';
  cases.push({
    name: `tiger-shape-${i}`,
    size: c.size,
    bbox: c.bbox,
    svg: wrap(original),
    monotone: wrap(new XMLSerializer().serializeToString(node)),
    pixel: [x, y],
    saveImage: true,
    arms: config.defaults.arms,
  });
  console.log(
    JSON.stringify({ i, point: [px, py], epp, area, inside: insideRule(raw.flat(), px, py, eo) }),
  );
}
writeFileSync(out, JSON.stringify({ ...config, cases }));
