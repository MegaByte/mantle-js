// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbBundleRoute — the route the RENDERER'S bundle builder assigns each shape. buildLbShape in
// isolation and buildLbBundle over the whole asset are not the same call: the bundle builder has
// its own gates (size, monster segments, translucency) and its answer is what the draw uses.
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
const sec = await importSvg(SVG, { preserveViewport: true });
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const out = buildLbBundle({
  curveFloats: new Float32Array(sec.curves),
  metaFloats: meta.metaFloats,
  metaFloatsPerShape: meta.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: meta.numShapes,
});
const raw = out.raw || out.meshes || out;
let real = 0,
  slug = 0;
const slugs = [];
for (let s = 0; s < meta.numShapes; s++) {
  const m = Array.isArray(raw) ? raw[s] : out.raw && out.raw[s];
  const isSlug = !m || m === SLUG || (m && m.slug === true);
  if (isSlug) {
    slug++;
    slugs.push(s);
  } else real++;
}
console.log(`${real} shapes carry an LB mesh, ${slug} go to Slug`);
console.log(`  Slug: ${slugs.join(',')}`);
for (const s of (process.env.SHAPES || '105,13,41').split(',').map(Number))
  console.log(`  s${s}: ${slugs.includes(s) ? 'SLUG' : 'LB mesh'}`);
