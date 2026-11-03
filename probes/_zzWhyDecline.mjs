// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWhyDecline — for every shape Loop-Blinn still sends to Slug, WHICH clause of the face proof
// it failed. The face proof is the gate, not a sampled audit, so a decline is a specific
// unmet obligation rather than "some sample painted air".
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
globalThis.__lbProofTrace = 1;
const why = new Map(),
  lists = new Map();
let declined = 0,
  other = 0;
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const eo = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  globalThis.__lbProofWhy = null;
  globalThis.__lbDeclineWhy = null;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: eo ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (m) continue;
  declined++;
  if (globalThis.__lbDeclineWhy !== 'coverage-audit') {
    other++;
    const k = 'declined earlier: ' + globalThis.__lbDeclineWhy;
    why.set(k, (why.get(k) || 0) + 1);
    continue;
  }
  const k = globalThis.__lbProofWhy || '(proof passed?)';
  why.set(k, (why.get(k) || 0) + 1);
  if (!lists.has(k)) lists.set(k, []);
  lists.get(k).push(s);
}
console.log(`${declined} shapes go to Slug; ${declined - other} of them on the over-paint gate.`);
for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
  if (process.env.LIST && lists.has(k)) console.log(`       ${lists.get(k).join(',')}`);
}
