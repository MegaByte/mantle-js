// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchFillArea — does a CPatch decomposition fill exactly the contour it came from?
//
// The converter's own validatePatch is an ALGEBRAIC test: it asks whether each curve's implicit
// behaves along the patch's edges. It cannot tell you that a contour produced no patches at all,
// and it cannot tell you that the patches it did produce miss part of the shape — neither
// shows up as an invalid patch. A converter can drop whole contours (a fifth of tiger's, a
// third of its fill) while stats.invalid stays 0: a contour that emits nothing has nothing to
// invalidate.
//
// So this measures the only thing that finally matters. Ground truth is the contour's own fill
// (row spans, the same test the converter uses to find an interior point); the decomposition is
// "some patch admits this point". Disagreement in either direction is reported separately,
// because they have different causes — under-fill is coverage, over-fill is a leaking patch.
//
// CLOSED CONTOURS only. An open one has no interior, so both sides of the comparison are
// meaningless and it flatters or damns the converter at random: unclosed input can report
// 64.7% over-fill next to 0.02% for the closed contours of the same file.
import { convertContour, inPatch, insideContour, cpStats } from '../src/renderer/cpatchConvert.js';
// A patch is bounded by at most this many curves. EIGHT, because that is what convertContour
// defaults to and therefore what the renderer builds; any other value reports a decomposition
// the renderer never builds. Measured across the range, tiger's patches fall
// 3979 -> 3293 -> 3226 -> 3224 at 4/6/8/12, so 8 is also where it stops paying.
const MAXC = +(process.env.MAXC || 8);
// How many curves of a loop may be offered as cut candidates. Unset uses the renderer's own
// default; CURVEC=1 offers only the offending curve, for comparison.
const CURVEC = +(process.env.CURVEC || 0);
let convMs = 0;
import { segPt } from '../src/geom/cpatchImplicit.js';
import { tigerCycles } from './_cpatchCycles.mjs';

const G = Number(process.env.G || 100);
const LIMIT = Number(process.env.N || 0);

const closed = (cs) => {
  const a = segPt(cs[0], 0),
    b = segPt(cs[cs.length - 1], 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
};
// An unclosed cycle is closed with the chord it implies, which is what the fill rule does anyway.
const close = (cs) =>
  closed(cs) ? cs : cs.concat([{ t: 'line', P: [segPt(cs[cs.length - 1], 1), segPt(cs[0], 0)] }]);

// SVGF points this at any file, not just tiger. The measurement is per-CONTOUR and has nothing
// tiger-specific in it, and a defect found on one asset has to be reducible to the shape that
// carries it -- a glyph, a hand-written repro -- or it cannot be worked on.
const SVGF = process.env.SVGF ? new URL('file://' + process.env.SVGF) : undefined;
const contours = tigerCycles(SVGF)
  .cycles.map(close)
  .slice(0, LIMIT || undefined);
let over = 0,
  under = 0,
  ink = 0,
  patches = 0,
  exact = 0,
  refused = 0;
const rows = [];
const t0 = Date.now();
for (let ci = 0; ci < contours.length; ci++) {
  const cs = contours[ci];
  let r = null;
  const _t0 = performance.now();
  try {
    r = convertContour(cs, {
      maxCurves: MAXC,
      tolPx: 0.05,
      ...(CURVEC ? { curveCandidates: CURVEC } : {}),
      ...(process.env.TOP ? { scoreTop: +process.env.TOP } : {}),
      ...(process.env.WIDE === '1' ? { wideCandidates: true } : {}),
    });
  } catch {
    /* counted below */
  }
  // STOP THE CLOCK HERE, not after the ink sampling. Accumulating it further down had the
  // 100x100 grid walk inside the figure and reported the whole probe as conversion time.
  convMs += performance.now() - _t0;
  const st = r && r.stats ? { ...r.stats } : null;
  if (!r || !r.patches) {
    refused++;
    continue;
  }
  patches += r.patches.length;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of cs)
    for (const p of s.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0) + 1;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  let o = 0,
    u = 0,
    k = 0;
  for (let gy = 0; gy < G; gy++) {
    const y = y0 + (y1 - y0) * ((gy + 0.5) / G);
    for (let gx = 0; gx < G; gx++) {
      const x = x0 + (x1 - x0) * ((gx + 0.5) / G);
      const truth = insideContour(cs, x, y);
      let got = false;
      for (const p of r.patches)
        if (inPatch(p, x, y)) {
          got = true;
          break;
        }
      if (truth) k++;
      if (got && !truth) o++;
      else if (!got && truth) u++;
    }
  }
  over += o;
  under += u;
  ink += k;
  if (o + u === 0) exact++;
  const refs = r.patches.reduce((x, q) => x + (q.curves ? q.curves.length : 0), 0);
  rows.push({ ci, n: cs.length, p: r.patches.length, o, u, k, st, refs });
}
console.log('=============== _cpatchFillArea');
console.log(
  'tiger: ' +
    contours.length +
    ' contours, ' +
    patches +
    ' patches, grid ' +
    G +
    'x' +
    G +
    ', ' +
    ((Date.now() - t0) / 1000).toFixed(1) +
    's',
);
console.log('  refused    ' + refused);
console.log('  true ink   ' + ink + ' samples');
console.log(
  '  OVER-fill  ' + over + '  (' + ((100 * over) / Math.max(1, ink)).toFixed(3) + '% of ink)',
);
console.log(
  '  UNDER-fill ' + under + '  (' + ((100 * under) / Math.max(1, ink)).toFixed(3) + '% of ink)',
);
console.log('  EXACT      ' + exact + '/' + rows.length + ' contours');
// PATCHES PER CURVE, which is what the decomposition costs. Accuracy is already good (245/251
// exact); the expensive axis is how many patches a contour is cut into, because that is the data
// the GPU stores and the curves a fragment walks.
{
  const byP = rows.slice().sort((a, b) => b.p / Math.max(1, b.n) - a.p / Math.max(1, a.n));
  const tot = rows.reduce((x, r) => x + r.p, 0),
    totC = rows.reduce((x, r) => x + r.n, 0);
  const refs = rows.reduce((x, r) => x + (r.refs | 0), 0);
  console.log(
    '  patches ' + tot + ' from ' + totC + ' curves = ' + (tot / totC).toFixed(2) + ' per curve',
  );
  // CURVE REFERENCES are what the GPU actually stores and a fragment actually walks — a patch
  // costs its bounding curves, not one slot.
  console.log(
    '  convert ' +
      convMs.toFixed(0) +
      'ms of CPU, ' +
      (cpStats.validate | 0) +
      ' validatePatch, ' +
      (cpStats.cuts | 0) +
      ' trial cuts' +
      '   (' +
      ((convMs * 1e3) / Math.max(1, cpStats.validate | 0)).toFixed(1) +
      'us per validate)',
  );
  console.log(
    '  clip pairs ' +
      (cpStats.pairs | 0) +
      ': pruned ' +
      (cpStats.pruned | 0) +
      ' (' +
      ((100 * (cpStats.pruned | 0)) / Math.max(1, cpStats.pairs | 0)).toFixed(1) +
      '%), COMPOSED ' +
      (cpStats.composed | 0),
  );
  console.log(
    '  curve references ' +
      refs +
      ' = ' +
      (refs / tot).toFixed(2) +
      ' per patch, ' +
      (refs / totC).toFixed(2) +
      ' per source curve',
  );
  const hist = {};
  for (const r of rows) {
    const b = Math.min(8, Math.round(r.p / Math.max(1, r.n)));
    hist[b] = (hist[b] | 0) + 1;
  }
  console.log(
    '  contours by patches/curve: ' +
      Object.keys(hist)
        .sort((a, b) => a - b)
        .map((b) => (b >= 8 ? '8+' : b) + ':' + hist[b])
        .join('  '),
  );
  console.log('  worst by patches/curve, with WHICH STAGE cut them:');
  for (const r of byP.slice(0, 8))
    console.log(
      '    c' +
        String(r.ci).padStart(3) +
        ': ' +
        String(r.n).padStart(3) +
        ' curves -> ' +
        String(r.p).padStart(4) +
        ' patches (' +
        (r.p / Math.max(1, r.n)).toFixed(1) +
        'x)   ' +
        (r.st
          ? Object.entries(r.st)
              .filter(([, v]) => v)
              .map(([k2, v]) => k2 + ' ' + v)
              .join('  ')
          : '-'),
    );
  // The same counts summed over every contour, so the tail can be read against the whole.
  const tot2 = {};
  for (const r of rows)
    for (const [k2, v] of Object.entries(r.st || {})) tot2[k2] = (tot2[k2] | 0) + v;
  console.log(
    '  stages over all contours: ' +
      Object.entries(tot2)
        .filter(([, v]) => v)
        .map(([k2, v]) => k2 + ' ' + v)
        .join('  '),
  );
}
rows.sort((a, b) => (b.o + b.u) / Math.max(1, b.k) - (a.o + a.u) / Math.max(1, a.k));
for (const r of rows.slice(0, 5).filter((r) => r.o + r.u)) {
  console.log(
    '    worst c' +
      r.ci +
      ': ' +
      r.n +
      ' curves, ' +
      r.p +
      ' patches, ink ' +
      r.k +
      ', over ' +
      r.o +
      ', under ' +
      r.u,
  );
}
