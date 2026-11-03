// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Node-only: which Loop-Blinn pieces overlap the pixel that holds a curve joint under an anisotropic map.
import { readFileSync } from 'fs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const LC = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#fff" d="M95.8,63.85Q95.8,94.6 64.3,94.6Q32.8,94.6 32.8,63.85Q32.8,33.1 64.3,33.1Q95.8,33.1 95.8,63.85Z"/><rect x="0" y="0" width="1" height="1" fill="#fff" fill-opacity="0.01"/><rect x="127" y="127" width="1" height="1" fill="#fff" fill-opacity="0.01"/></svg>';
const bun = await importSvg(svg, { preserveViewport: true });
const pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
  mst = pm.floatsPerShape,
  meta = pm.metaFloats,
  cf = new Float32Array(bun.curves);
const r = bun.curveRangesByShape[0];
const Cs = LC.curveRangeToContours(cf, r.begin, r.end);
const b = buildLbShape(Cs, false, meta[13] > 0.5);
console.log(
  'shape bbox meta',
  Array.from(meta.slice(0, 16))
    .map((v) => +v.toFixed(3))
    .join(' '),
);
console.log('raw keys', Object.keys(b.raw || b));
for (const k of Object.keys(b.raw || {})) {
  const v = b.raw[k];
  console.log(
    k,
    Array.isArray(v) ? v.length : v && v.length != null ? 'len ' + v.length : typeof v,
  );
}
const raw = b.raw;
for (const k of ['quads', 'cubics', 'tris', 'interior', 'faces'])
  if (raw[k] && raw[k].length)
    console.log(
      k,
      JSON.stringify(raw[k].slice(0, 2), (kk, v) =>
        typeof v === 'number' ? +v.toFixed(3) : v,
      ).slice(0, 700),
    );
console.log('--- all quads');
raw.quads.forEach((q, i) =>
  console.log(
    i,
    JSON.stringify([...Object.values(q.tri)].map((v) => +v.toFixed(2))),
    'sign',
    q.sign,
    'w',
    q.w,
    'e1',
    JSON.stringify(q.e1),
    'e2',
    JSON.stringify(q.e2),
  ),
);
console.log(
  'bandArcs',
  JSON.stringify(raw.bandArcs, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)).slice(
    0,
    1500,
  ),
);
console.log('_topo keys', raw._topo && Object.keys(raw._topo));
