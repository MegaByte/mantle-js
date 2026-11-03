// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzInkScale — the audit's ink verdict at two exactly-related sizes. The mesh itself is bit
// equivariant with the audit off, so any sample whose verdict flips is the WINDING TEST changing
// its mind about the same point on the same shape drawn at two sizes.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const sc = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { type: sg.type };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = [sg[k][0] * S, sg[k][1] * S];
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
globalThis.__lbAuditTraceAll = 1;
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
for (const s of (process.env.SHAPES || '5,7,125,155').split(',').map(Number)) {
  const cs = curveRangeToContours(
    cf,
    sec.curveRangesByShape[s].begin | 0,
    sec.curveRangesByShape[s].end | 0,
  );
  const runs = {};
  for (const k of (process.env.KS || '0,1').split(',').map(Number)) {
    globalThis.__lbAuditNeg = [];
    buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    runs[k] = globalThis.__lbAuditNeg.map((e) => ({
      x: e.p[0] / 2 ** k,
      y: e.p[1] / 2 ** k,
      f: e.f,
      ink: e.ink,
      degen: e.degen,
      sc: e.sc,
      shapeSc: e.shapeSc,
      klmn: e.klmn,
    }));
  }
  const ks = Object.keys(runs);
  const a = runs[ks[0]],
    b = runs[ks[1]];
  let flips = 0,
    fdiff = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].ink !== b[i].ink) flips++;
    if (a[i].degen !== b[i].degen) fdiff++;
  }
  console.log(
    `s${s}: neg samples ${a.length} vs ${b.length}   ink verdict flips ${flips}   degen flips ${fdiff}`,
  );
  let shown = 0;
  for (let i = 0; i < n && shown < 3; i++)
    if (a[i].degen !== b[i].degen) {
      shown++;
      console.log(
        `    degen ${a[i].degen}->${b[i].degen}  scale ${a[i].sc.toExponential(3)} -> ${b[i].sc.toExponential(3)} (ratio ${(b[i].sc / a[i].sc).toExponential(2)})`,
      );
      console.log(
        `      shapeScale ${a[i].shapeSc.toExponential(3)} -> ${b[i].shapeSc.toExponential(3)} (ratio ${(b[i].shapeSc / a[i].shapeSc).toExponential(2)})`,
      );
      if (a[i].klmn)
        console.log(
          `      klmn@1 ${a[i].klmn
            .slice(0, 3)
            .map((v) => v.toExponential(2))
            .join(' ')}\n      klmn@2 ${b[i].klmn
            .slice(0, 3)
            .map((v) => v.toExponential(2))
            .join(' ')}`,
        );
    }
}
