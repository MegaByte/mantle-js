// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzViolScale — the converter's violation list for a contour, at two exactly-related sizes.
// The decision trace says the FIRST cut already acts on a different offending pair, so the
// divergence is in what validatePatch reports, not in which candidate wins.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { framePatch, validatePatch } from '../src/renderer/cpatchConvert.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
for (const s of (process.env.SHAPES || '61').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  const rows = {};
  for (const k of (process.env.KS || '0,4').split(',').map(Number)) {
    const S = 2 ** k;
    const flat = scaleCv(cs, S).flat();
    const f = framePatch(flat);
    if (!f) {
      console.log(`s${s} 2^${k}: no frame`);
      continue;
    }
    const v = validatePatch(f);
    rows[k] = {
      ok: v.ok,
      worst: v.worst,
      tol: v.tolPx,
      viol: (v.viol || []).map((e) => ({ a: e.a, b: e.b, dep: e.dep / S })),
    };
  }
  const ks = Object.keys(rows);
  const A = rows[ks[0]],
    B = rows[ks[1]];
  if (!A || !B) continue;
  console.log(
    `s${s}: ok ${A.ok}/${B.ok}  worst ${A.worst && `i${A.worst.i}j${A.worst.j} d=${(A.worst.depth / 2 ** Number(ks[0])).toExponential(4)} ${A.worst.kind}`}`,
  );
  console.log(
    `             worst ${B.worst && `i${B.worst.i}j${B.worst.j} d=${(B.worst.depth / 2 ** Number(ks[1])).toExponential(4)} ${B.worst.kind}`}`,
  );
  console.log(`  viol count ${A.viol.length} vs ${B.viol.length}`);
  const n = Math.max(A.viol.length, B.viol.length);
  for (let i = 0; i < n && i < 12; i++) {
    const a = A.viol[i],
      b = B.viol[i];
    const same =
      a && b && a.a === b.a && a.b === b.b && Math.abs(a.dep - b.dep) <= 1e-9 * Math.abs(a.dep);
    console.log(
      `   ${same ? ' ' : '*'} ${a ? `${a.a}-${a.b} ${a.dep.toExponential(4)}` : '--'}   ${b ? `${b.a}-${b.b} ${b.dep.toExponential(4)}` : '--'}`,
    );
  }
}
