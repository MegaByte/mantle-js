// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterStrokeRtPadSmoke — a filtered stroke's render target reaches its ink.
//
// renderer/filterDraw.js `_shapeBboxPx` sizes the filter render targets from the shape's meta
// bbox. A stroke row's meta bbox is the path padded by halfW, and the join reaches further, so the
// function adds a pad. GUESSING it as `0.5 * strokeWidth * max(1, min(miterLimit, 4))`, "over-inclusive
// on purpose: pad every join as if it were a miter", is wrong in both directions:
//   * it CLIPS. The true reach is src/bundle/strokeReach.js's strokeReachFactor: miterLimit for a
//     miter, sqrt(miterLimit^2 + 1) for miter-clip and for arcs (the clip line's corners lie up to
//     halfW to either side of the bisector), sqrt(2) for a square cap. Capping at 4 cuts a clipped
//     miter at limit 10 five half-widths short, and a plain miter above limit ~5 the same way.
//   * it OVER-pads. A round or bevel join reaches exactly one half-width, and it got four.
// The quantum that rounds a rect's SIZE up grows it DOWN and RIGHT only (`_bboxToRect`: the origin
// is floored, the extent quantized), so a shortfall on the LEFT or TOP edge is absorbed by nothing
// but the 2 px RECT_PAD.
//
//   (a) over the seeded polylines imported through importSvg, with the meta row's own stored miter
//       limit (bundleFinalize lowers it to the path's worst ratio for plain miters): how much SVG 2
//       ink falls outside each pad;
//   (b) a directed plain-miter case whose own corner ratio is above 5, which the seeded set happens
//       not to contain;
//   (c) the pad is never smaller than the ink and never four half-widths on a round join;
//   (d) the source: filterDraw.js takes the one bound, and the rect quantum still only grows right
//       and down.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { svgInside, makeStrokeCases, pixels, JOINS } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { metaStrokeReachFactor } = await import('../src/bundle/strokeReach.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const CAPS = ['butt', 'round', 'square'];
const M = { BB: 0, FILL_A: 7, STROKE_W: 12, MITER: 26 };

/** The guessed pad: every join padded as a miter, capped at 4. */
const oldFactor = (meta, o) => Math.max(1, Math.min(meta[o + M.MITER] || 1, 4));

/** Import one seeded polyline and return its stroke row's meta view + offset. */
async function strokeRowOf(cs) {
  const reach = cs.halfW * Math.sqrt(Math.max(cs.miterLimit, 1) ** 2 + 1) + 2;
  const xs = cs.P.map((p) => p[0]),
    ys = cs.P.map((p) => p[1]);
  const vb = [
    Math.min(...xs) - reach,
    Math.min(...ys) - reach,
    Math.max(...xs) - Math.min(...xs) + 2 * reach,
    Math.max(...ys) - Math.min(...ys) + 2 * reach,
  ];
  const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ') + (cs.closed ? ' Z' : '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
    ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
  const b = await importSvg(svg);
  const meta = new Float32Array(b.meta, 32),
    stride = b.metaFloatsPerShape || 48;
  for (let i = 0; i * stride < meta.length; i++)
    if (meta[i * stride + M.STROKE_W] > 0 && !(meta[i * stride + M.FILL_A] > 0))
      return { meta, o: i * stride };
  return null;
}

/** The largest distance any SVG 2 ink pixel falls outside `metaBbox +- halfW * factor`, in em. */
function overshoot(cs, meta, o, factor) {
  const halfW = meta[o + M.STROKE_W] * 0.5,
    pad = halfW * factor;
  const bb = [meta[o] - pad, meta[o + 1] - pad, meta[o + 2] + pad, meta[o + 3] + pad];
  let over = 0;
  for (const c of pixels(cs)) {
    if (!svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)) continue;
    over = Math.max(over, bb[0] - c[0], c[0] - bb[2], bb[1] - c[1], c[1] - bb[3]);
  }
  return over;
}

// ---- (a) the seeded polylines ----------------------------------------------------------------------
{
  const byJoin = {};
  let nOld = 0,
    nNew = 0,
    worst = { over: 0 };
  const cases = makeStrokeCases(0x51de, 360).concat(makeStrokeCases(0x7a11, 360));
  for (const cs of cases) {
    const row = await strokeRowOf(cs);
    if (!row) continue;
    const { meta, o } = row;
    const k = JOINS[cs.joinStyle];
    byJoin[k] ??= { n: 0, old: 0, worstHw: 0 };
    byJoin[k].n++;
    const halfW = meta[o + M.STROKE_W] * 0.5;
    const oOld = overshoot(cs, meta, o, oldFactor(meta, o));
    const oNew = overshoot(cs, meta, o, metaStrokeReachFactor(meta, o));
    if (oOld > 0) {
      nOld++;
      byJoin[k].old++;
      byJoin[k].worstHw = Math.max(byJoin[k].worstHw, oOld / halfW);
      if (oOld > worst.over)
        worst = { over: oOld, hw: oOld / halfW, join: k, ml: cs.miterLimit, halfW };
    }
    if (oNew > 0) nNew++;
  }
  ok(
    nOld > 0 && nNew === 0,
    `(a) over ${cases.length} imported stroke rows the guessed pad leaves ink outside the render target on ${nOld}, the reach bound on ${nNew}`,
  );
  console.log(
    `       ${Object.entries(byJoin)
      .map(([k, v]) => `${k} ${v.old}/${v.n} (worst ${v.worstHw.toFixed(2)} half-widths)`)
      .join(', ')}`,
  );
  ok(
    worst.over > 2,
    `(a) worst: ${worst.over.toFixed(2)} em, ${worst.hw.toFixed(2)} half-widths of a ${worst.join} join at miterlimit ${worst.ml} cut off the RT`,
  );
}

// ---- (b) a plain miter whose own corner is sharper than limit 5 ---------------------------------------
{
  // A flat V whose legs leave the vertex 16.4 degrees apart, so the miter ratio is 1/sin(8.2 deg)
  // = 7.0: sharp enough that the stored limit lands above 5 (bundleFinalize lowers a plain miter's
  // to the path's own worst ratio), and still INSIDE the declared limit of 10, so the join really
  // draws its spike instead of returning bevel.
  const cs = {
    P: [
      [158.98, 83.74],
      [60, 98],
      [158.98, 112.26],
    ],
    closed: false,
    halfW: 8,
    cap: 0,
    joinStyle: 0,
    miterLimit: 10,
    off: [0.5, 0.5],
  };
  const row = await strokeRowOf(cs);
  ok(!!row, '(b) the directed miter case imports');
  const { meta, o } = row;
  const stored = meta[o + M.MITER];
  ok(
    stored > 5,
    `(b) its stored miter limit is ${stored.toFixed(2)} — bundleFinalize lowers a plain miter's limit to the path's own worst ratio, and this path's is above 5`,
  );
  const oOld = overshoot(cs, meta, o, oldFactor(meta, o));
  const oNew = overshoot(cs, meta, o, metaStrokeReachFactor(meta, o));
  ok(
    oOld > 10 && oNew === 0,
    `(b) the guessed pad cuts ${oOld.toFixed(1)} em off its spike (${(oOld / cs.halfW).toFixed(2)} half-widths); the reach bound cuts ${oNew.toFixed(1)}`,
  );
}

// ---- (c) and it is not four half-widths on a round join ----------------------------------------------
{
  const cs = {
    P: [
      [40, 100],
      [100, 40],
      [160, 100],
    ],
    closed: false,
    halfW: 8,
    cap: 0,
    joinStyle: 1,
    miterLimit: 4,
    off: [0.5, 0.5],
  };
  const { meta, o } = await strokeRowOf(cs);
  ok(
    Math.abs(metaStrokeReachFactor(meta, o) - 1) < 1e-6 && oldFactor(meta, o) === 4,
    `(c) a round join with a butt cap reaches exactly one half-width; the guessed pad gives it ${oldFactor(meta, o)}, so its RT would be larger than its ink`,
  );
}

// ---- (d) the source -----------------------------------------------------------------------------------
{
  const fd = readFileSync(path.join(ROOT, 'src/renderer/filterDraw.js'), 'utf8');
  ok(
    /import \{ metaStrokeReachFactor \} from '\.\.\/bundle\/strokeReach\.js';/.test(fd) &&
      /if \(strokeW > 0\) padEm = 0\.5 \* strokeW \* metaStrokeReachFactor\(meta, mb\);/.test(fd),
    '(d) filterDraw.js sizes the pad from the one bound',
  );
  ok(!/Math\.min\(miter, 4\)/.test(fd), '(d) and the min(miterLimit, 4) guess is gone');
  ok(
    /const w = qUp\(Math\.ceil\(bb\.x \+ bb\.w \+ px\) - x0\);/.test(fd) &&
      /The quantized box grows DOWN and RIGHT from \(x0, yTop\), so it still contains the/.test(fd),
    '(d) the rect quantum still only grows right and down, so a shortfall on the left or top edge is absorbed by nothing but RECT_PAD',
  );
}

console.log(
  `${fail ? 'FILTER-STROKE-RT-PAD FAIL' : 'FILTER-STROKE-RT-PAD PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
