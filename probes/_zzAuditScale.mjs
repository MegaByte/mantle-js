// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAuditScale — the over-paint audit's own numbers, at two exactly-related sizes.
// The audit is a SIGN test on an implicit, and a sign is scale-invariant except at zero. If the
// samples that condemn a shape at 2^1 sit near zero, the audit is reading cancellation noise, not
// over-paint -- and the klmn branch already has a relative dead band the Bezout branch does not.
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
for (const s of (process.env.SHAPES || '5,7,125,155').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  for (const k of (process.env.KS || '0,1').split(',').map(Number)) {
    globalThis.__lbAuditTrace = 1;
    globalThis.__lbAuditBad = [];
    const m = buildLoopBlinnCDT(sc(cs, 2 ** k), { fillRule: 'nonzero' });
    const b = globalThis.__lbAuditBad;
    // The sample's |f| against the hull's own cube -- the implicit is degree 3, so that is the
    // magnitude a value ON the curve would have to beat to mean anything.
    const rows = b.map((e) => {
      const H = e.hull;
      let d = 0;
      for (let i = 0; i < 6; i += 2)
        for (let j = 0; j < 6; j += 2)
          d = Math.max(d, Math.hypot(H[i] - H[j], H[i + 1] - H[j + 1]));
      return {
        f: e.f,
        rel: Math.abs(e.f) / Math.max(d ** 3, 1e-300),
        kind: e.kind,
        sc: e.sc,
        band: 1e-4 * Math.max(e.sc, 1e-30),
      };
    });
    rows.sort((a, b2) => a.rel - b2.rel);
    console.log(
      `s${s} 2^${k}: ${m ? 'built' : 'DECLINED'}  bad=${b.length}` +
        (rows.length
          ? `  |f|/d^3 min=${rows[0].rel.toExponential(2)} max=${rows[rows.length - 1].rel.toExponential(2)}  kinds=${[...new Set(rows.map((x) => x.kind))]}`
          : ''),
    );
    if (rows.length)
      console.log(
        '    ' +
          rows
            .slice(0, 6)
            .map(
              (x) =>
                `f=${x.f.toExponential(2)} scale=${x.sc.toExponential(2)} band=${x.band.toExponential(2)}`,
            )
            .join('\n    '),
      );
  }
}
