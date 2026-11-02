// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzNormDiff — which shapes convert differently in the normalized frame?
//
// Converting in a power-of-two normalized frame is exact, so a shape that converts one way plainly
// and another way normalized has found a site whose threshold depends on where the artwork sits.
// Each row here is one such site to fix; when this prints nothing, the epsilons are relative.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchBBox } from '../src/renderer/cpatchConvert.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const run = (list) => {
  const ps = [];
  let ok = null;
  try {
    ok = packCPatchShape(list, 0, { onPatches: (q) => ps.push(...q) });
  } catch (e) {
    return { err: e.message };
  }
  return { ok: !!ok, n: ps.length };
};
const rows = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  globalThis.__CP_FORCE_NORM = 0;
  const a = run(list);
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_FORCE_NORM = 1;
  const b = run(list);
  globalThis.__CP_FORCE_NORM = 0;
  if (a.n !== b.n || a.ok !== b.ok || a.err || b.err) {
    const bb = patchBBox(list.flat());
    rows.push({
      si,
      a,
      b,
      ext: Math.max(bb[2] - bb[0], bb[3] - bb[1]),
      curves: list.flat().length,
    });
  }
}
console.log(`${rows.length} shape(s) convert differently normalized:`);
for (const r of rows.slice(0, 14))
  console.log(
    `  shape ${String(r.si).padStart(3)} (${String(r.curves).padStart(3)} curves, extent ${r.ext.toFixed(1)} em): ` +
      `plain ${r.a.err ? 'THREW ' + r.a.err : r.a.ok ? r.a.n + ' patches' : 'declined'}` +
      `  |  normalized ${r.b.err ? 'THREW ' + r.b.err : r.b.ok ? r.b.n + ' patches' : 'declined'}`,
  );
