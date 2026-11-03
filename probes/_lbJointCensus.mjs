// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Node-only: how many faces does the corner cut add? usage: node probes/_lbJointCensus.mjs ROOT file.svg...
import { readFileSync } from 'fs';
import path from 'path';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const root = path.resolve(process.argv[2]);
const { default: importSvg } = await import(path.join(root, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(root, 'src/core/metaBin.js'));
const LC = await import(path.join(root, 'src/geom/lbContour.js'));
const { buildLbShape } = await import(path.join(root, 'src/renderer/lbBuildCore.js'));
const warn = console.warn;
console.warn = () => {};
for (const f of process.argv.slice(3)) {
  const bun = await importSvg(readFileSync(f, 'utf8'));
  const pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
    mst = pm.floatsPerShape,
    meta = pm.metaFloats,
    cf = new Float32Array(bun.curves);
  let shapes = 0,
    quads = 0,
    interior = 0,
    built = 0;
  for (let s = 0; s < bun.numShapes; s++) {
    const r = bun.curveRangesByShape[s];
    let Cs;
    try {
      Cs = LC.curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    let b = null;
    try {
      b = buildLbShape(Cs, false, meta[s * mst + 13] > 0.5);
    } catch {
      b = null;
    }
    shapes++;
    if (!b || !b.raw) continue;
    built++;
    quads += (b.raw.quads || []).length;
    interior += (b.raw.interior || []).length / 6;
  }
  console.log(
    path.basename(f),
    'shapes',
    shapes,
    'built',
    built,
    'quads',
    quads,
    'interiorTris',
    interior,
  );
}
