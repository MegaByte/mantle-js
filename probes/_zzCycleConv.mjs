// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCycleConv — convert each of a shape's CYCLES at two sizes. The packer converts cycles with
// their holes, not the raw contour, so this is the unit the decision trace is actually about.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles, groupContours } from '../src/geom/cpatchGraph.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
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
  const per = {};
  for (const k of (process.env.KS || '0,2').split(',').map(Number)) {
    const S = 2 ** k;
    const cy = pathToCycles(scaleCv(cs, S), false);
    const groups = groupContours(cy, false);
    const counts = [];
    for (const g of groups) {
      const c = convertContour(g.outer, {
        maxCurves: 8,
        holes: g.holes && g.holes.length ? g.holes : null,
      });
      counts.push(c ? c.patches.length : -1);
    }
    per[k] = { cycles: cy.length, groups: groups.length, counts };
  }
  const ks = Object.keys(per);
  console.log(
    `s${s}: cycles ${per[ks[0]].cycles}/${per[ks[1]].cycles}  groups ${per[ks[0]].groups}/${per[ks[1]].groups}`,
  );
  console.log(`   2^${ks[0]}: ${per[ks[0]].counts.join(' ')}`);
  console.log(`   2^${ks[1]}: ${per[ks[1]].counts.join(' ')}`);
}
