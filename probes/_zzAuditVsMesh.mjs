// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAuditVsMesh — the audit predicts a 9-to-24 pixel thick wedge of wrong ink for the very shapes
// that, rendered alone, paint nothing outside their path at all. One of the two is wrong about
// what the mesh contains, and this asks the FINAL mesh directly: at each sample the audit
// condemned, is there a cubic piece whose triangle covers the point and whose implicit says paint?
//
// The audit scans `cubics` BEFORE the interior carve appends more pieces and before the apex clip
// may replace them, so its verdict is about a prefix of the mesh -- not necessarily about anything
// that ships.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const WANT = new Set((process.env.SHAPES || '175,176,187,189').split(',').map(Number));

function inTri(H, x, y) {
  const d = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
  if (!(Math.abs(d) > 0)) return null;
  const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d;
  const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d;
  const w0 = 1 - w1 - w2;
  const s = -1e-9;
  return w0 >= s && w1 >= s && w2 >= s ? [w0, w1, w2] : null;
}
function implicitAt(c, x, y) {
  const w = inTri(c.hull, x, y);
  if (!w) return null;
  if (c.klmn) {
    const T = c.klmn;
    const k = w[0] * T[0] + w[1] * T[3] + w[2] * T[6];
    const l = w[0] * T[1] + w[1] * T[4] + w[2] * T[7];
    const m = w[0] * T[2] + w[1] * T[5] + w[2] * T[8];
    return c.sign * (k * k * k - l * m);
  }
  if (c.F) return c.sign * evalBezout(c.F, x, y);
  return null;
}

globalThis.__lbAuditTrace = 1;
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1; // build the mesh the audit would have rejected, so it can be asked
let tot = 0,
  covered = 0,
  paints = 0,
  keptOut = 0;
for (let s = 0; s < meta.numShapes; s++) {
  if (!WANT.has(s)) continue;
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  globalThis.__lbAuditBad = [];
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  const bad = (globalThis.__lbAuditBad || []).slice();
  if (!m || !bad.length) {
    console.log(`s${s}: ${m ? 'no bad samples' : 'still declined'}`);
    continue;
  }
  const cubs = m.cubics || [];
  let sCov = 0,
    sPaint = 0,
    sKeep = 0;
  for (const b of bad) {
    tot++;
    const [x, y] = b.p;
    let anyCover = false,
      anyPaint = false,
      anyKeptOut = false;
    for (const c of cubs) {
      const f = implicitAt(c, x, y);
      if (f === null) continue;
      anyCover = true;
      if (f >= 0) continue;
      // The kernel's far-branch fence, asked exactly as the shader asks it (the 1.5px release is
      // resolution-dependent slack the audit deliberately does not model).
      const kp = c.keep;
      if (kp && kp[0] * x + kp[1] * y > kp[2]) {
        anyKeptOut = true;
        continue;
      }
      anyPaint = true;
    }
    if (anyCover) {
      covered++;
      sCov++;
    }
    if (anyPaint) {
      paints++;
      sPaint++;
    } else if (anyKeptOut) {
      keptOut++;
      sKeep++;
    }
  }
  console.log(
    `s${s}: ${bad.length} condemned samples -> ${sCov} covered by a final-mesh piece, ${sPaint} actually painted, ${sKeep} fenced off by keep`,
  );
}
console.log(
  `total: ${tot} condemned, ${covered} covered by the FINAL mesh, ${paints} painted by it, ${keptOut} fenced`,
);
