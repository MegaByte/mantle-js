// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSignSide — is the crescent painting the WRONG SIDE of its own arc?
//
// Every wrong pixel the declined shapes paint sits within 0.03-0.04 of a chord of the arc its piece
// draws (probes/_zzPaintKind.mjs), so it is not a far algebraic branch -- it is a band hugging the
// curve. A crescent paints between its chord and its arc on the side the ink is on, and which side
// that is comes from `cubicSign`/`cubicSignKLMN`, which PROBE the winding a fixed fraction of the
// chord off the curve. On a fill thinner than that offset the probe lands on the far side and the
// sign comes back inverted -- a known class; 0.01 of the chord is smaller than 0.05, and a fixed
// offset can still overshoot.
//
// The exact answer needs no probe: step off the arc midpoint by a VANISHING amount and read the
// shape's own row spans. This compares the two.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';

function spansOf(segs, y, evenOdd) {
  if (!evenOdd) return rowSpans(segs, y) || [];
  const xs = [];
  for (const sg of segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
}
const inkExact = (segs, evenOdd, x, y) => {
  for (const [a, b] of spansOf(segs, y, evenOdd)) if (x >= a && x <= b) return true;
  return false;
};
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const WANT = (process.env.SHAPES || '').split(',').filter(Boolean).map(Number);

globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
let pieces = 0,
  wrongSide = 0,
  noVerdict = 0,
  sideFlips = 0;
const sideAt = [];
const byShape = new Map();
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
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (!m || !m.cubics) continue;
  let segs = null;
  try {
    const cv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  const seen = new Set();
  let bad = 0,
    n = 0;
  for (const c of m.cubics) {
    const cp = c.cp;
    if (!cp) continue;
    const key = cp.map((p) => p[0].toFixed(4) + ',' + p[1].toFixed(4)).join('|');
    if (seen.has(key)) continue; // fan triangles of one piece share a curve
    seen.add(key);
    pieces++;
    n++;
    // ALONG THE whole ARC, not just its midpoint. On a feature thinner than the crescent the side
    // the ink is on can change from one end of the arc to the other, and a midpoint-only test
    // passes a piece that paints air over most of its span.
    let flipped = 0,
      judged = 0;
    for (let ti = 1; ti <= 9; ti++) {
      const tt = ti / 10,
        uu = 1 - tt;
      const qx =
        uu * uu * uu * cp[0][0] +
        3 * uu * uu * tt * cp[1][0] +
        3 * uu * tt * tt * cp[2][0] +
        tt * tt * tt * cp[3][0];
      const qy =
        uu * uu * uu * cp[0][1] +
        3 * uu * uu * tt * cp[1][1] +
        3 * uu * tt * tt * cp[2][1] +
        tt * tt * tt * cp[3][1];
      const qdx =
        3 *
        (uu * uu * (cp[1][0] - cp[0][0]) +
          2 * uu * tt * (cp[2][0] - cp[1][0]) +
          tt * tt * (cp[3][0] - cp[2][0]));
      const qdy =
        3 *
        (uu * uu * (cp[1][1] - cp[0][1]) +
          2 * uu * tt * (cp[2][1] - cp[1][1]) +
          tt * tt * (cp[3][1] - cp[2][1]));
      const qL = Math.hypot(qdx, qdy);
      if (!(qL > 0)) continue;
      const qnx = -qdy / qL,
        qny = qdx / qL;
      const qc = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]) || qL;
      const qh = 1e-7 * qc;
      const ip = inkExact(segs, evenOdd, qx + qnx * qh, qy + qny * qh);
      const inn = inkExact(segs, evenOdd, qx - qnx * qh, qy - qny * qh);
      if (ip === inn) continue;
      judged++;
      if (ip !== (ti === 5 ? ip : ip)) {
        /* placeholder */
      }
      sideAt.push([ti, ip]);
    }
    // Does the ink side CHANGE along the arc?
    if (sideAt.length > 1) {
      const first = sideAt[0][1];
      if (sideAt.some(([, v]) => v !== first)) sideFlips++;
    }
    sideAt.length = 0;
    // The arc's midpoint and unit normal.
    const t = 0.5,
      u = 0.5;
    const px =
      u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0];
    const py =
      u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1];
    const dx =
      3 *
      (u * u * (cp[1][0] - cp[0][0]) +
        2 * u * t * (cp[2][0] - cp[1][0]) +
        t * t * (cp[3][0] - cp[2][0]));
    const dy =
      3 *
      (u * u * (cp[1][1] - cp[0][1]) +
        2 * u * t * (cp[2][1] - cp[1][1]) +
        t * t * (cp[3][1] - cp[2][1]));
    const L = Math.hypot(dx, dy);
    if (!(L > 0)) {
      noVerdict++;
      continue;
    }
    const nx = -dy / L,
      ny = dx / L;
    const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]) || L;
    // VANISHING offset: the exact side, with no room to overshoot a thin fill.
    const h = 1e-7 * chord;
    const inkPos = inkExact(segs, evenOdd, px + nx * h, py + ny * h);
    const inkNeg = inkExact(segs, evenOdd, px - nx * h, py - ny * h);
    if (inkPos === inkNeg) {
      noVerdict++;
      continue;
    } // both or neither: the midpoint is not a boundary here
    // What the PIECE says: evaluate its implicit a little off the arc on each side and see which
    // side it paints (f < 0). Far enough out to clear the ramp, near enough to stay in the hull.
    const hh = 0.02 * chord;
    const fAt = (X, Y) => {
      if (c.klmn) {
        const H = c.hull;
        const e1x = H[2] - H[0],
          e1y = H[3] - H[1],
          e2x = H[4] - H[0],
          e2y = H[5] - H[1];
        const det = e1x * e2y - e1y * e2x;
        if (!(Math.abs(det) > 0)) return null;
        const w1 = ((X - H[0]) * e2y - (Y - H[1]) * e2x) / det,
          w2 = (e1x * (Y - H[1]) - e1y * (X - H[0])) / det,
          w0 = 1 - w1 - w2;
        const T = c.klmn;
        const K = w0 * T[0] + w1 * T[3] + w2 * T[6],
          Lq = w0 * T[1] + w1 * T[4] + w2 * T[7],
          M = w0 * T[2] + w1 * T[5] + w2 * T[8];
        return c.sign * (K * K * K - Lq * M);
      }
      return c.F ? c.sign * evalBezout(c.F, X, Y) : null;
    };
    const fPos = fAt(px + nx * hh, py + ny * hh),
      fNeg = fAt(px - nx * hh, py - ny * hh);
    if (fPos === null || fNeg === null) {
      noVerdict++;
      continue;
    }
    const paintsPos = fPos < 0,
      paintsNeg = fNeg < 0;
    if (paintsPos === paintsNeg) {
      noVerdict++;
      continue;
    }
    // The piece must paint on the side the shape has ink.
    if (paintsPos !== inkPos) {
      wrongSide++;
      bad++;
    }
  }
  if (bad) byShape.set(s, [bad, n]);
}
console.log(`${pieces} curve pieces examined`);
console.log(`  paint the WRONG SIDE of their own arc: ${wrongSide}`);
console.log(
  `  the ink side CHANGES along the arc (a piece straddling a thin feature): ${sideFlips}`,
);
console.log(
  `  no verdict (midpoint not a clean boundary, or the implicit does not separate): ${noVerdict}`,
);
const rows = [...byShape].sort((a, b) => b[1][0] - a[1][0]);
if (rows.length)
  console.log(
    '  worst shapes: ' +
      rows
        .slice(0, 12)
        .map(([s, [b, n]]) => `s${s}:${b}/${n}`)
        .join(' '),
  );
