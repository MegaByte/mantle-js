// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAdoptScale — does the packer ADOPT the front end's cycles, at two exactly-related sizes?
// The cycles themselves are equivariant and each converts identically, so a shape whose patch
// count still moves with scale must be taking a different route through the adoption gate.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const scaleCv = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
for (const s of (process.env.SHAPES || '25,68,82,105').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  const out = [];
  for (const k of (process.env.KS || '-4,-2,-1,0,1,2,4').split(',').map(Number)) {
    globalThis.__CP_ADOPT_TRACE = [];
    const ps = [];
    try {
      packCPatchShape(scaleCv(cs, 2 ** k), 0, { evenOdd, onPatches: (a) => ps.push(...a) });
    } catch {
      /* refused */
    }
    const t = globalThis.__CP_ADOPT_TRACE[0];
    out.push(
      `2^${k}:${ps.length}${t ? `[${t.keep ? 'adopt' : 'raw'} cy${t.cycles}/c${t.contours}]` : '[no-gate]'}`,
    );
  }
  console.log(`s${s} eo=${evenOdd}  ` + out.join('  '));
}
