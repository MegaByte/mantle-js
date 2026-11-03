// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dump one shape's packed mesh + row arrays as JSON, so two trees can be diffed
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { LB_VERT_FLOATS } = await import('../../src/renderer/lbPack.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const [spec, out] = process.argv.slice(2);
const [file, si] = spec.split('#');
const bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
const meta = new Float32Array(bundle.meta, 32),
  mst = bundle.metaFloatsPerShape;
const cf = new Float32Array(bundle.curves);
const s = +si,
  r = bundle.curveRangesByShape[s],
  bb = s * mst;
const cs = curveRangeToContours(cf, r.begin, r.end);
const b = buildLbShape(
  cs,
  meta[bb + 7] < 0.996 &&
    Math.floor(meta[bb + 28] + 0.5) === 0 &&
    (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0),
  meta[bb + 13] > 0.5,
);
const arr = (a) => (a ? Array.from(a) : null);
const raw = b && b.raw ? b.raw : {};
writeFileSync(
  out,
  JSON.stringify(
    {
      verts: b && b.pk ? arr(b.pk.verts.subarray(0, b.pk.vertexCount * LB_VERT_FLOATS)) : null,
      vertexCount: b && b.pk ? b.pk.vertexCount : 0,
      kindMask: b && b.pk ? b.pk.kindMask : 0,
      interior: arr(raw.interior),
      interiorEdges: arr(raw.interiorEdges),
      interiorEdges2: arr(raw.interiorEdges2),
      interiorEdges3: arr(raw.interiorEdges3),
      chainA: arr(raw.interiorChainA),
      chainB: arr(raw.interiorChainB),
      chainC: arr(raw.interiorChainC),
      chainD: arr(raw.interiorChainD),
      chainE: arr(raw.interiorChainE),
      quads: (raw.quads || []).length,
      cubics: (raw.cubics || []).length,
      edges: (raw.edges || []).length,
    },
    null,
    0,
  ),
);
console.log('wrote', out);
