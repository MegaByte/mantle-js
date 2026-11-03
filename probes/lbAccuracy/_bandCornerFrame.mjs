// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bandCornerFrame — the curve band's corner-combine frame. Intersecting the band's own plane, whose normal comes from
// dFdx/dFdy of vTC (GL window, y up), with the NEIGHBOUR's plane, whose normal is an em vector (y down), combines a
// y-mirrored pair. Per shape, the twin with the mirrored pair (opt.mirroredCornerFrame) and as the kernel runs (both planes in
// the window frame) against the exact box coverage of the shape (_lbAaRef, 64 slices), at every pixel where the two
// differ.
//
//   node probes/lbAccuracy/_bandCornerFrame.mjs [svg]      CANVAS=512
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shapesOf, viewOf, buildMesh, rasterMesh } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = +(process.env.CANVAS || 512);
const FILE = process.argv[2] || path.join(ROOT, 'examples/tiger.svg');
console.warn = () => {};
const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const bundle = await importSvg(readFileSync(FILE, 'utf8'));
const { shapes, bbox } = await shapesOf(bundle, { rows: 'fill' });
const view = viewOf(bbox, N);
const { rowSpans, contoursToConverter, closed } = await refKit();
let px = 0,
  kernelWorse = 0,
  kernelBetter = 0,
  sumK = 0,
  sumP = 0,
  maxK = 0,
  maxP = 0;
const rows = [];
for (const sh of shapes) {
  const built = await buildMesh(sh);
  if (!built) continue;
  const k = new Float64Array(N * N).fill(1),
    p = new Float64Array(N * N).fill(1);
  rasterMesh(built.pk, view, k, { mirroredCornerFrame: true }, null, null, null);
  rasterMesh(built.pk, view, p, {}, null, null, null);
  let curves = null;
  const cache = new Map();
  for (let q = 0; q < k.length; q++) {
    if (Math.abs(k[q] - p[q]) * 255 <= 1) continue;
    if (!curves) curves = closed(contoursToConverter(sh.contours, null));
    const i = q % N,
      j = (q / N) | 0;
    const ex = exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, cache);
    const ek = Math.abs(1 - k[q] - ex) * 255,
      ep = Math.abs(1 - p[q] - ex) * 255;
    px++;
    sumK += ek;
    sumP += ep;
    maxK = Math.max(maxK, ek);
    maxP = Math.max(maxP, ep);
    if (ek > ep + 0.5) kernelWorse++;
    else if (ep > ek + 0.5) kernelBetter++;
    rows.push(
      `  shape ${sh.s} (${i},${j}): exact ${(ex * 255).toFixed(1)}  mirrored ${((1 - k[q]) * 255).toFixed(1)} (off ${ek.toFixed(1)})  window ${((1 - p[q]) * 255).toFixed(1)} (off ${ep.toFixed(1)})`,
    );
  }
}
console.log(
  `${path.basename(FILE)} @ ${N} px: ${px} pixels where the frame matters (per shape, > 1/255)`,
);
console.log(
  `  |mirrored - exact|  mean ${(sumK / Math.max(px, 1)).toFixed(2)}/255  max ${maxK.toFixed(1)}`,
);
console.log(
  `  |window - exact|    mean ${(sumP / Math.max(px, 1)).toFixed(2)}/255  max ${maxP.toFixed(1)}`,
);
console.log(`  mirrored is further from exact on ${kernelWorse}, nearer on ${kernelBetter}`);
console.log(rows.slice(0, 30).join('\n'));
