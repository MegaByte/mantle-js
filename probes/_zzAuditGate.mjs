// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAuditGate — did the over-paint audit RUN on the shapes that over-paint? It is gated on
// `tot9 >= 8` (a noise floor: a shape with too few judgeable samples gets no verdict), so a shape
// whose pieces yield fewer than eight samples ships whatever it paints, unexamined. Tiger's shape
// 181 puts 360 solid pixels outside its own path and is NOT declined; this asks whether the audit
// looked at it and passed, or never looked.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const WANT = (process.env.SHAPES || '').split(',').filter(Boolean).map(Number);
globalThis.__lbAuditTrace = 1;
let noGate = 0,
  ran = 0,
  passed = 0,
  declined = 0;
const under8 = [];
for (const s of WANT.length ? WANT : [...Array(meta.numShapes).keys()]) {
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
  globalThis.__lbAuditTot = undefined;
  globalThis.__lbAuditBadN = undefined;
  globalThis.__lbAuditPieces = undefined;
  globalThis.__lbDeclineWhy = null;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  const tot = globalThis.__lbAuditTot,
    bad = globalThis.__lbAuditBadN,
    np = globalThis.__lbAuditPieces;
  if (tot === undefined) {
    noGate++;
    if (WANT.length) console.log(`  s${s}: the audit never ran (no cubic pass)`);
    continue;
  }
  if (tot < 8) {
    under8.push(s);
    if (WANT.length)
      console.log(
        `  s${s}: tot=${tot} bad=${bad} pieces=${np} -> UNDER THE NOISE FLOOR, no verdict`,
      );
    continue;
  }
  ran++;
  if (!m && globalThis.__lbDeclineWhy === 'coverage-audit') {
    declined++;
    if (WANT.length) console.log(`  s${s}: tot=${tot} bad=${bad} pieces=${np} -> DECLINED`);
  } else {
    passed++;
    if (WANT.length)
      console.log(
        `  s${s}: tot=${tot} bad=${bad} pieces=${np} -> passed${m ? '' : ' (declined for another reason: ' + globalThis.__lbDeclineWhy + ')'}`,
      );
  }
}
if (!WANT.length) {
  console.log(`audit coverage over ${noGate + under8.length + ran} shapes:`);
  console.log(`  never reached the cubic audit : ${noGate}`);
  console.log(
    `  under the tot>=8 noise floor  : ${under8.length}   ${under8.slice(0, 30).join(',')}${under8.length > 30 ? ' ...' : ''}`,
  );
  console.log(`  audited and passed            : ${passed}`);
  console.log(`  audited and declined          : ${declined}`);
}
