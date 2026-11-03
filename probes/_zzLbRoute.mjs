// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbRoute — which of Loop-Blinn's three build routes a shape actually takes, and whether the
// mesh that comes back covers the shape.
//
// buildLoopBlinnCDT declining is NOT the same as the shape falling to Slug: buildLbShape (what the
// worker runs) tries the fast mesh, then the CDT, then the fast mesh AGAIN for cubics -- and that
// third route does not run the over-paint audit the second one declined on. A shape can therefore
// be rejected as unsafe and drawn anyway, by a builder that never asked.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT, buildLoopBlinnMesh } from '../src/renderer/loopBlinn.js';
import { buildLbShape, meshUnderCovers, contoursHaveCubic } from '../src/renderer/lbBuildCore.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const LIST = process.env.SHAPES
  ? process.env.SHAPES.split(',').map(Number)
  : [...Array(meta.numShapes).keys()];
let nCdtDecline = 0,
  nRescued = 0,
  nSlug = 0,
  nOk = 0;
const rescued = [];
for (const s of LIST) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  globalThis.__lbDeclineWhy = null;
  let cdt = null;
  try {
    cdt = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    cdt = null;
  }
  const why = globalThis.__lbDeclineWhy;
  let out = null;
  try {
    out = buildLbShape(cs, false, evenOdd);
  } catch {
    out = null;
  }
  if (cdt && !cdt.fallback.length) {
    nOk++;
    continue;
  }
  nCdtDecline++;
  if (out) {
    nRescued++;
    const under = meshUnderCovers(out.raw, cs);
    rescued.push(
      `s${s} (${why || 'no reason'})  cubic=${contoursHaveCubic(cs)}  underCovers=${under}`,
    );
  } else nSlug++;
}
console.log(`${nOk} shapes take the CDT, ${nCdtDecline} are declined by it`);
console.log(
  `  of those declined: ${nSlug} fall to Slug, ${nRescued} are DRAWN ANYWAY by the fast mesh`,
);
if (rescued.length) console.log('  ' + rescued.slice(0, 20).join('\n  '));
