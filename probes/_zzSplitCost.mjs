// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSplitCost — what a more aggressive decomposition costs in GEOMETRY. Loop-Blinn's answer to a
// face that cannot see the whole outline is to subdivide until it does not have to: the piece's
// hull shrinks until nothing else of the shape is inside it. The objection is a geometric
// explosion, and subdivision halves a chord while cutting the sagitta about fourfold -- so the
// count should grow far slower than the accuracy. This measures it rather than assuming it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { buildLbBundle, SLUG } from '../src/renderer/lbBuildCore.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
// test hooks, read only under __MANTLE_DEBUG__
if (process.env.TURN || process.env.DEPTH) globalThis.__MANTLE_DEBUG__ = true;
if (process.env.TURN) globalThis.__LB_SPLIT_TURN = +process.env.TURN;
if (process.env.DEPTH) globalThis.__LB_SPLIT_DEPTH = +process.env.DEPTH;
const sec = await importSvg(SVG, { preserveViewport: true });
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const t0 = Date.now();
const out = buildLbBundle({
  curveFloats: new Float32Array(sec.curves),
  metaFloats: meta.metaFloats,
  metaFloatsPerShape: meta.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: meta.numShapes,
});
const ms = Date.now() - t0;
const raw = out.raw || [];
let real = 0,
  slug = 0,
  cub = 0,
  intr = 0,
  verts = 0;
for (let s = 0; s < meta.numShapes; s++) {
  const m = raw[s];
  if (!m || m === SLUG || m.slug === true) {
    slug++;
    continue;
  }
  real++;
  cub += (m.cubics || []).length;
  intr += ((m.interior || []).length / 6) | 0;
}
for (const pk of out.packed || []) if (pk && pk.vertexCount) verts += pk.vertexCount | 0;
console.log(
  `turn ${globalThis.__LB_SPLIT_TURN ?? -0.17}  depth ${globalThis.__LB_SPLIT_DEPTH ?? 3}` +
    `  ->  ${real} LB / ${slug} Slug   crescents ${cub}  interior ${intr}  packed verts ${verts}  build ${ms}ms`,
);
