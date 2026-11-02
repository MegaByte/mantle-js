// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _importerRefsInk — the ink each drawn row of the importer-reference fixtures puts on the page, measured on the
// CPU so a GPU render can be checked against it without running the importer twice.
//
//   node probes/importerRefs/_importerRefsInk.mjs            # every case
//   node probes/importerRefs/_importerRefsInk.mjs OBB-CLIP        # one case
//
// For every drawn fill row it reports the area and bounding box of the pixels where
//   fill coverage x (max over the row's clip rows) x (max over its mask rows) >= 0.5,
// sampled on a grid in DOCUMENT units through src/hitTest/bandWinding.js — the CPU copy of the fill kernel, the
// same walk the shader does. Areas are in document units squared; a GPU render scales them by (px per unit)^2.
//
// WHAT this IS FOR. The silhouette reference index (computeSilhouette) and objectBoundingBox transforms change WHAT
// GETS DRAWN, so they need a look at real pixels; an arc rebuild must change the bytes without changing the curve.
// The fixtures below are the assets to render, and this probe's numbers are the CPU expectation a GPU render is
// checked against. Case ids are the CLI selectors.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { bandFillCoverage } = await import(path.join(ROOT, 'src/hitTest/bandWinding.js'));

// [id, asset, importSvg options, note]
const CASES = [
  [
    'SILHOUETTE-REFS',
    'examples/smoke/silhouetteRefIndex__SILHOUETTE_REFS.svg',
    { preserveViewport: true, computeSilhouette: true },
    'a pattern carrier, an objectBoundingBox clip and an objectBoundingBox mask, WITH the silhouette on',
  ],
  [
    'SILHOUETTE-REFS-OFF',
    'examples/smoke/silhouetteRefIndex__SILHOUETTE_REFS.svg',
    { preserveViewport: true },
    'the same asset with the silhouette off: the control, unchanged by every fix in this pass',
  ],
  [
    'OBB-CLIP',
    'examples/smoke/objectBoundingBoxTransform__OBB_TRANSFORM_DEMO.svg',
    { preserveViewport: true },
    'four cells, each a rect pale in full and solid where an objectBoundingBox clip of its middle band keeps it',
  ],
  [
    'ARC-ROTATED',
    'examples/smoke/arcRebuildEquivariance__ARC_SVG_ROTATED.svg',
    { preserveViewport: true },
    'five arc shapes under a <g transform>, so every arc goes through the rebuild at scale 1',
  ],
];

const want = (process.argv[2] || '').toUpperCase();
const LAYER = 0x100;
const rowsOf = (b) => new Float32Array(b.meta, 32);
const span = (m, first, beginBit, endBit) => {
  if (!(m[first * 48 + 27] & beginBit)) return [first];
  const out = [];
  for (let q = first; q < m.length / 48; q++) {
    out.push(q);
    if (m[q * 48 + 27] & endBit) break;
  }
  return out;
};

for (const [id, rel, opts, note] of CASES) {
  if (want && id.toUpperCase() !== want) continue;
  const svg = readFileSync(path.join(ROOT, rel), 'utf8');
  const b = await importSvg(svg, opts);
  const m = rowsOf(b),
    bands = new Float32Array(b.bands),
    curves = new Float32Array(b.curves);
  const vb = b.viewBox || [0, 0, 100, 100];
  const N = 1024,
    step = vb[2] / N,
    cell = step * ((vb[3] / vb[2]) * N === N ? step : vb[3] / N);
  const cov = (r, x, y) => {
    const o = r * 48;
    if (x < m[o] || x > m[o + 2] || y < m[o + 1] || y > m[o + 3]) return 0;
    return bandFillCoverage(
      bands,
      curves,
      [m[o + 16], m[o + 17], m[o + 18], m[o + 19]],
      [m[o], m[o + 1], m[o + 2], m[o + 3]],
      x,
      y,
      N / vb[2],
      N / vb[2],
      m[o + 13] > 0.5,
    );
  };
  console.log(
    `\n=== ${id}  ${rel}\n    ${note}\n    viewBox ${vb.join(' ')}, ${b.numShapes} rows, sampled ${N} x ${Math.round((N * vb[3]) / vb[2])}`,
  );
  const rows = m.length / 48;
  for (let r = 0; r < rows; r++) {
    if (m[r * 48 + 27] & LAYER) continue; // clip / mask / pattern-child rows are not drawn
    const fillA = m[r * 48 + 7],
      strokeA = m[r * 48 + 11];
    const clip = m[r * 48 + 30] > 0 ? span(m, m[r * 48 + 30] - 1, 1 << 11, 1 << 12) : [];
    const mask = m[r * 48 + 31] > 0 ? span(m, m[r * 48 + 31] - 1, 1 << 9, 1 << 10) : [];
    if (!(fillA > 0)) {
      console.log(
        `  row ${r} ${b.shapeIds[r] || ''}: stroke only (alpha ${strokeA}), bbox [${Array.from(
          m.slice(r * 48, r * 48 + 4),
        )
          .map((v) => +v.toFixed(2))
          .join(', ')}]`,
      );
      continue;
    }
    let n = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const j0 = Math.max(0, Math.floor((m[r * 48 + 1] - vb[1]) / step) - 2),
      j1 = Math.min(Math.round((N * vb[3]) / vb[2]), Math.ceil((m[r * 48 + 3] - vb[1]) / step) + 2);
    const i0 = Math.max(0, Math.floor((m[r * 48] - vb[0]) / step) - 2),
      i1 = Math.min(N, Math.ceil((m[r * 48 + 2] - vb[0]) / step) + 2);
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const x = vb[0] + (i + 0.5) * step,
          y = vb[1] + (j + 0.5) * step;
        let c = cov(r, x, y);
        if (clip.length) c *= Math.max(...clip.map((q) => cov(q, x, y)));
        if (mask.length) c *= Math.max(...mask.map((q) => cov(q, x, y)));
        if (c >= 0.5) {
          n++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    const area = n * step * step;
    console.log(
      `  row ${r} ${b.shapeIds[r] || ''}: ink ${area.toFixed(1)} units^2` +
        (n
          ? `, bbox [${[x0, y0, x1, y1].map((v) => +v.toFixed(2)).join(', ')}]`
          : ' (NOTHING DRAWN)') +
        (clip.length ? `, clip rows ${clip.join(',')}` : '') +
        (mask.length ? `, mask rows ${mask.join(',')}` : ''),
    );
  }
}
