// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBuildTime -- what a build-side change costs, in milliseconds and in pieces. Mesh building
// happens off-thread, so it does not show up in a frame time, and a correctness fix that
// quietly triples it is still a regression.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
let best = Infinity,
  tris = 0;
for (let rep = 0; rep < 3; rep++) {
  const t0 = performance.now();
  tris = 0;
  for (let s = 0; s < meta.numShapes; s++) {
    const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
    if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
    const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
    try {
      const m = buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
        fillRule: evenOdd ? 'evenodd' : 'nonzero',
      });
      if (m) tris += (m.interior ? m.interior.length / 6 : 0) + (m.cubics ? m.cubics.length : 0);
    } catch {}
  }
  best = Math.min(best, performance.now() - t0);
}
console.log(
  `${(process.env.SVG || 'tiger').split('/').pop().padEnd(22)} build ${best.toFixed(0)} ms   pieces ${tris}`,
);
