// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCubicSet — which cubic pieces the partition produced, at two exactly-related sizes.
// The audit's degenerate-frame test is relative to the LARGEST klmn scale in the shape, so a
// single piece changing its representation moves the bar for every other piece.
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
const scaleOf = (k) => {
  if (!k) return 0;
  let m = 0;
  for (let r = 0; r < 3; r++)
    m = Math.max(m, Math.abs(k[r * 3] ** 3), Math.abs(k[r * 3 + 1] * k[r * 3 + 2]));
  return m;
};
for (const s of (process.env.SHAPES || '5').split(',').map(Number)) {
  const cs = curveRangeToContours(
    cf,
    sec.curveRangesByShape[s].begin | 0,
    sec.curveRangesByShape[s].end | 0,
  );
  const runs = {};
  for (const k of (process.env.KS || '0,1').split(',').map(Number)) {
    buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    runs[k] = globalThis.__lbCubicDump;
  }
  const [k0, k1] = Object.keys(runs);
  const a = runs[k0],
    b = runs[k1];
  console.log(
    `s${s}: pieces ${a.length} vs ${b.length}   klmn ${a.filter((e) => e.klmn).length} vs ${b.filter((e) => e.klmn).length}`,
  );
  const sa = a.map((e) => scaleOf(e.klmn)),
    sb = b.map((e) => scaleOf(e.klmn));
  console.log(
    `  max klmn scale ${Math.max(...sa).toExponential(3)} vs ${Math.max(...sb).toExponential(3)}`,
  );
  const S0 = 2 ** Number(k0),
    S1 = 2 ** Number(k1);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (
      Math.abs(sa[i] - sb[i]) > 1e-12 * Math.max(sa[i], sb[i], 1e-300) ||
      !a[i].klmn !== !b[i].klmn
    )
      console.log(
        `  piece ${i}: klmn ${!!a[i].klmn}->${!!b[i].klmn}  scale ${sa[i].toExponential(3)} -> ${sb[i].toExponential(3)}`,
      );
    // HULLS TOO: the piece list can agree on count and klmn and still be different geometry.
    let hr = 0;
    for (let j = 0; j < 6; j++) {
      const u = a[i].hull[j] / S0,
        v = b[i].hull[j] / S1;
      hr = Math.max(hr, Math.abs(u - v) / Math.max(Math.abs(u), 1e-300));
    }
    if (hr > 1e-9)
      console.log(
        `  piece ${i}: HULL differs by ${hr.toExponential(2)}  sign ${a[i].sign}->${b[i].sign}`,
      );
    else if (a[i].sign !== b[i].sign) console.log(`  piece ${i}: SIGN ${a[i].sign}->${b[i].sign}`);
  }
}
