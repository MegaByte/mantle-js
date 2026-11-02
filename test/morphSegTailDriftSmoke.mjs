// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphSegTailDriftSmoke — a t-segmented morph's extrapolated tail drift, measured and bounded.
//
// SEG_MARGIN is capped at a quarter of an interval's width, so a NARROW flip interval draws past its
// build range, and the extrapolated implicit drifts off its curve (lbMorphEvenOdd near t = 0.07).
//
// IT IS NOT THE INTERVAL WIDTH, AND IT IS NOT THE MARGIN'S SIZE EITHER. On lbMorphEvenOdd the
// segmenter leaves one segment drawing [0.045, 0.0801] from a pair built over [0.045, 0.060] —
// local t to 2.33, not 1.33, because refineByDrift9's split halves the BUILD span while the
// overshoot stays exactly where it is.
//
// THE INSTRUMENT HAS A CEILING. `driftAt9` starts `best` at `lim` and walks no further, with
// `lim = 0.25 * chord`, so a quarter chord is the largest number it can return: "saturated 2.5e-1"
// is not a distance, it is the instrument's maximum, and comparisons taken there compare maxima.
// With the walk widened (`limFrac`, steps still sized by the default window so resolution is
// unchanged) the true readings separate:
//
//   * the margin arm does not merely fail to help, it is NON-MONOTONE and reaches 5.9e-1 — worse
//     than the 3.5e-1 it starts from;
//   * giving the overshooting sliver a pair of its own, with a proportional margin, cuts
//     extrapolated t by 30x (overshoot 133% -> 4.5%) and takes the drift from 3.5e-1 to 1.6e+0.
//     Overshoot fraction is not a proxy for drift, because the narrower sliver ends even closer to
//     the flip, where the conditioning is worse.
//
// WHAT WORKS: bound the implicit's mix parameter to [-0.1, 1.1] while the POSITIONS keep the true
// t. 41x better than unbounded on the overshooting segment and byte-identical on every segment whose
// overshoot already sits inside the bound. It needs a second uniform (positions and implicit share
// one), so it is a shader change; a render is its acceptance gate, and this file is the CPU half of
// the case.
//
// AND ONE ARM THAT MUST NOT BE TRIED: handing over at tHiB instead of at the flip reads 253x
// better and is WRONG. It moves the next segment's draw range across the flip, and a pair spanning
// that range does not build — the drift oracle cannot see CLASSIFICATION, and drawing pre-flip
// poses with a post-flip classification is a wrong picture, not a slightly wrong edge. (f) pins it.
//
//   (a) the oracle exists and reads past the build range, which driftOf does not;
//   (b) the default window SATURATES on this asset — the instrument guard — and
//       the widened one reads a real distance;
//   (c) the margin is not the lever, and is non-monotone;
//   (d) a sliver pair of its own cannot be exact and drifts further with a margin; the segments tile;
//   (e) the bound that works, and that it costs nothing where the overshoot is already small;
//   (f) the early handover crosses a classification barrier.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { segmentPartitionPairMorph, tailDrift9 } = await import('../src/renderer/loopBlinnMorph.js');
const { buildLoopBlinnPartitionPair, pairImplicitDrift } =
  await import('../src/renderer/lbPartitionPair.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// The window every ARM is graded in. 0.25 (the default) is a ceiling this asset sits above, so a
// comparison taken there compares two maxima. 16 is far enough that every reading below is a
// distance — `_tailWindow.mjs` shows them flat from 0.5 to 64.
// Module scope on purpose: (f) also needs it, and a block-scoped copy would make (f)'s catch
// swallow a ReferenceError and report every handover as a barrier.
const lerp = (sc, dc, t) => {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si],
        o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
      if (ss.w != null) o.w = ss.w;
      if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
      if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
      if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
      return o;
    }),
  );
};
const WIDE = { limFrac: 16 };
const EXTRAP_BOUND = 0.1;

async function contoursOf(file) {
  const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
    preserveViewport: true,
  });
  const c = new Float32Array(b.curves),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    if (r) out.push(curveRangeToContours(c, r.begin, r.end));
  }
  return out;
}
const SRC = await contoursOf('examples/smoke/lbMorphEvenOdd__SRC.svg');
const DST = await contoursOf('examples/smoke/lbMorphEvenOdd__DST.svg');
ok(
  SRC.length > 0 && SRC.length === DST.length,
  `the even-odd morph pair imports (${SRC.length} shapes)`,
);

const segs = segmentPartitionPairMorph(SRC[0], DST[0], 'evenodd');
ok(!!segs && segs.length >= 3, `the segmenter cuts it into ${segs ? segs.length : 0} t-segments`);

// ---- (a) the oracle reads past the build range -------------------------------------------------------
{
  const g = segs[0];
  const span = g.tHiB - g.tLoB;
  const inner = pairImplicitDrift(g.pair.src, g.pair.dst, 0, 1);
  const oF = {};
  const full = tailDrift9(g.pair, g.tLoB - span, g.tHiB + span, g.tLoB, g.tHiB, oF, WIDE);
  ok(
    full > inner,
    `(a) tailDrift9 reads past the build range: over [-1, 2] of a segment it is ${full.toExponential(2)} against ${inner.toExponential(2)} over [0, 1]`,
  );
  ok(
    oF.saturated === false,
    `(a) ...and at limFrac ${WIDE.limFrac} that reading is a DISTANCE, not the ceiling`,
  );
}

// ---- (b) the one segment that overshoots -------------------------------------------------------------
const over = [];
for (const g of segs) {
  const span = g.tHiB - g.tLoB;
  const o = Math.max(g.tLoB - g.tLo, 0) + Math.max(g.tHi - g.tHiB, 0);
  if (o > 1e-9) {
    const oW = {},
      oD = {};
    const tail = tailDrift9(g.pair, g.tLo, g.tHi, g.tLoB, g.tHiB, oW, WIDE);
    tailDrift9(g.pair, g.tLo, g.tHi, g.tLoB, g.tHiB, oD); // the DEFAULT window, for (b)
    over.push({
      g,
      frac: o / span,
      tail,
      sat: oW.saturated,
      satDefault: oD.saturated,
      inner: pairImplicitDrift(g.pair.src, g.pair.dst, 0, 1),
    });
  }
}
{
  const worst = over.slice().sort((a, b) => b.tail - a.tail)[0];
  ok(
    worst && worst.satDefault === true,
    '(b) THE INSTRUMENT GUARD: at the default 0.25-chord window this segment SATURATES, so every ' +
      'number taken there is a ceiling and not a distance. If this goes false the asset does not ' +
      'reach the overshoot and the readings below stop meaning what they say',
  );
  ok(
    worst && worst.sat === false,
    `(b) ...and at limFrac ${WIDE.limFrac} it does not: the tail is ${worst.tail.toExponential(2)} of a chord, ` +
      'which the default window reports as its 2.5e-1 ceiling',
  );
  ok(
    over.length >= 1 && worst && worst.tail > 0.2,
    `(b) ${over.length} of ${segs.length} segments draw past their build range; the worst draws [${worst.g.tLo.toFixed(4)}, ${worst.g.tHi.toFixed(4)}] ` +
      `from a pair built over [${worst.g.tLoB.toFixed(4)}, ${worst.g.tHiB.toFixed(4)}] — local t to ${((worst.g.tHi - worst.g.tLoB) / (worst.g.tHiB - worst.g.tLoB)).toFixed(2)}, ` +
      `tail ${worst.tail.toExponential(2)} of a chord`,
  );
  ok(
    worst && worst.inner < worst.tail / 20,
    `(b) ...while the SAME pair's interpolated drift is ${worst.inner.toExponential(2)} — the segment is fine everywhere it was built and wrong only where it extrapolates`,
  );
  const clean = segs.filter(
    (g) => Math.max(g.tLoB - g.tLo, 0) + Math.max(g.tHi - g.tHiB, 0) <= 1e-9,
  );
  ok(
    clean.every((g) => tailDrift9(g.pair, g.tLo, g.tHi, g.tLoB, g.tHiB, null, WIDE) < 0.01),
    `(b) ...and every segment that builds over everything it draws (${clean.length} of ${segs.length}) is under 1e-2`,
  );
}

// ---- (c) the margin is not the lever ------------------------------------------------------------------
{
  const w = over.slice().sort((a, b) => b.tail - a.tail)[0].g;
  const base = over.slice().sort((a, b) => b.tail - a.tail)[0].tail;
  const rows = [];
  let m = w.tHi - w.tHiB;
  for (let k = 0; k < 4; k++) {
    m = Math.max(1e-4, m * 0.5);
    const aLo = w.tLoB,
      aHi = w.tHi - m;
    if (!(aHi > aLo)) break;
    let alt = null;
    try {
      alt = buildLoopBlinnPartitionPair(
        lerp(SRC[0], DST[0], aLo),
        lerp(SRC[0], DST[0], aHi),
        'evenodd',
        { plainDstRows: true },
      );
    } catch {
      alt = null;
    }
    if (!alt) {
      rows.push({ over: (w.tHi - aHi) / (aHi - aLo), tail: null, inner: null });
      continue;
    }
    const oM = {};
    rows.push({
      over: (w.tHi - aHi) / (aHi - aLo),
      tail: tailDrift9(alt, w.tLo, w.tHi, aLo, aHi, oM, WIDE),
      sat: oM.saturated,
      inner: pairImplicitDrift(alt.src, alt.dst, 0, 1),
    });
  }
  const built = rows.filter((r) => r.tail != null);
  ok(built.length >= 3, `(c) ${built.length} of ${rows.length} margin-halving rebuilds succeed`);
  ok(
    built.every((r) => r.sat === false),
    `(c) every margin arm reads a DISTANCE at limFrac ${WIDE.limFrac} — the default window reads them all at its 2.5e-1 ceiling`,
  );
  ok(
    built.every((r) => r.tail >= base * 0.9),
    `(c) and shrinking the margin never helps (base ${base.toExponential(2)}): ` +
      built
        .map((r) => `overshoot ${(100 * r.over).toFixed(1)}% -> ${r.tail.toExponential(2)}`)
        .join(', '),
  );
  ok(
    Math.max(...built.map((r) => r.tail)) > base * 1.3,
    `(c) ...it is NON-MONOTONE and gets WORSE in the middle, peaking at ${Math.max(...built.map((r) => r.tail)).toExponential(2)} ` +
      `against ${base.toExponential(2)} — which the saturated oracle showed as four identical readings`,
  );
  ok(
    built.every((r) => r.inner < 0.05),
    '(c) ...while those same pairs are well behaved over what they build: ' +
      built.map((r) => r.inner.toExponential(2)).join(', ') +
      " — so the margin's SIZE is not the lever",
  );
}

// ---- (d) A PAIR OF ITS own FOR THE SLIVER, AND WHY IT DOES NOT HELP --------------------------------
// Not extrapolating there at all means clamping the remap over the sliver, or giving the sliver a
// pair of its own. As a segmenter arm (cut the segment AT its build boundary, build the overshooting
// sliver its own pair) the second changes nothing without a margin, and with a proportional one
// (overshoot 133% -> 4.5% of a build span, 4 -> 5 segments) the worst tail goes 3.5e-1 -> 1.6e+0,
// 4.5x WORSE. That rests on a property of the pair builder, asserted here directly:
//
//   the exact sliver pair does not build, because the sliver ends AT THE FLIP -- the pose that does
//   not classify -- so an exact sliver is not available; and the sliver built with that margin
//   drifts FURTHER than the extrapolation it would replace.
{
  const w = over.slice().sort((a, b) => b.tail - a.tail)[0];
  const g = w.g,
    hiOver = g.tHi - g.tHiB,
    loOver = g.tLoB - g.tLo;
  ok(
    hiOver > loOver,
    `(d) the worst segment overshoots at its HIGH end (${hiOver.toFixed(4)} of t past its build range)`,
  );
  let exact = null;
  try {
    exact = buildLoopBlinnPartitionPair(
      lerp(SRC[0], DST[0], g.tHiB),
      lerp(SRC[0], DST[0], g.tHi),
      'evenodd',
      { plainDstRows: true },
    );
  } catch {
    exact = null;
  }
  ok(
    !exact,
    `(d) the sliver's EXACT pair, over [${g.tHiB.toFixed(4)}, ${g.tHi.toFixed(4)}], does not build — it ends at the flip`,
  );
  const mOut = Math.min(hiOver * 0.01, 1e-3),
    hiB = g.tHi - mOut;
  let sl = null;
  try {
    sl = buildLoopBlinnPartitionPair(
      lerp(SRC[0], DST[0], g.tHiB),
      lerp(SRC[0], DST[0], hiB),
      'evenodd',
      { plainDstRows: true },
    );
  } catch {
    sl = null;
  }
  ok(
    !!sl,
    `(d) with a proportional margin (${mOut.toExponential(2)}) the sliver's pair does build`,
  );
  if (sl) {
    const t = tailDrift9(sl, g.tHiB, g.tHi, g.tHiB, hiB, null, WIDE);
    ok(
      t > w.tail * 2,
      `(d) ...and drifts ${t.toExponential(2)} of a chord over the sliver, against ${w.tail.toExponential(2)} for the ` +
        `extrapolation it would replace — ${(t / w.tail).toFixed(1)}x WORSE while overshooting ${((100 * mOut) / (hiB - g.tHiB)).toFixed(1)}% ` +
        'instead of ' +
        (100 * w.frac).toFixed(1) +
        '%. Overshoot fraction is not a proxy for drift: the narrower sliver ends closer to the flip',
    );
  }
  const sorted = segs.slice().sort((x, y) => x.tLo - y.tLo);
  let tiles = Math.abs(sorted[0].tLo) < 1e-9 && Math.abs(sorted[sorted.length - 1].tHi - 1) < 1e-9;
  for (let i2 = 0; i2 + 1 < sorted.length; i2++)
    if (Math.abs(sorted[i2].tHi - sorted[i2 + 1].tLo) > 1e-9) tiles = false;
  ok(tiles, `(d) the ${segs.length} shipped segments tile [0, 1] with no gap and no overlap`);
}

// ---- (e) THE BOUND THAT WORKS -----------------------------------------------------------------
// Bound the implicit's mix parameter to [-b, 1+b] and leave the POSITIONS on the true t. That is a
// second uniform in the vertex stage, which is why it is measured here on the CPU: one
// `uMorphT` drives both the lerped control points and the lerped implicit coefficients.
//
// It is the only arm that is better everywhere. A hard clamp (b = 0) is NOT: it wins big on the
// segment that extrapolates to 2.33 and loses by two orders of magnitude on the one that reaches
// only -0.05, because freezing the implicit costs more than a mild extrapolation does.
{
  const armOf = (g, opts) => {
    const span = g.tHiB - g.tLoB;
    return pairImplicitDrift(
      g.pair.src,
      g.pair.dst,
      (g.tLo - g.tLoB) / span,
      (g.tHi - g.tLoB) / span,
      null,
      opts,
    );
  };
  const wide = (b2) => ({ limFrac: WIDE.limFrac, clamp: [-b2, 1 + b2] });
  const now = over.map((o) => armOf(o.g, WIDE));
  const bounded = over.map((o) => armOf(o.g, wide(EXTRAP_BOUND)));
  const hard = over.map((o) => armOf(o.g, wide(0)));
  const wNow = Math.max(...now),
    wB = Math.max(...bounded),
    wH = Math.max(...hard);
  ok(
    wB < wNow / 10,
    `(e) bounding the implicit's mix to [${-EXTRAP_BOUND}, ${1 + EXTRAP_BOUND}] takes the worst tail ` +
      `${wNow.toExponential(2)} -> ${wB.toExponential(2)}, ${(wNow / wB).toFixed(1)}x`,
  );
  ok(
    bounded.every((v, i) => v <= now[i] * 1.001),
    '(e) ...and it is never worse on any overshooting segment: ' +
      over.map((o, i) => `${now[i].toExponential(2)}->${bounded[i].toExponential(2)}`).join(', '),
  );
  ok(
    wH > wB * 1.5,
    `(e) ...where a HARD clamp (bound 0) is worse overall (${wH.toExponential(2)} against ${wB.toExponential(2)}): ` +
      'it freezes the implicit for a segment whose extrapolation was mild enough to be nearly exact',
  );
}

// ---- (f) THE ARM THAT READS BEST AND IS WRONG -------------------------------------------------
// Handing over at tHiB instead of at the flip reads 253x better and must not be tried:
// it moves the NEXT segment's draw range down across the flip, and the drift oracle cannot see
// CLASSIFICATION. The segmenter's own definition of a flip is "a pair spanning it does not build",
// so the builder answers this directly. Drawing pre-flip poses with a post-flip classification is a
// wrong picture, not a slightly wrong edge.
{
  const sorted = segs.slice().sort((x, y) => x.tLo - y.tLo);
  const spans = buildLoopBlinnPartitionPair;
  let crossed = 0,
    checked = 0;
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1].tHiB,
      to = sorted[i].tHiB;
    if (!(to > from)) continue;
    checked++;
    // The lerps run OUTSIDE the try: a throw from them is a broken harness, not a barrier, and a
    // block-scoped lerp would hide exactly that (every handover would "cross", and the assertion
    // would pass for the wrong reason).
    const A = lerp(SRC[0], DST[0], from),
      B = lerp(SRC[0], DST[0], to);
    let built = false;
    try {
      built = !!spans(A, B, 'evenodd', { plainDstRows: true });
    } catch {
      built = false;
    }
    if (!built) crossed++;
  }
  ok(
    checked > 0 && crossed > 0,
    `(f) the early-handover arm crosses a classification barrier on ${crossed} of ${checked} handovers — ` +
      'a pair spanning the range it would draw does not build, so its 253x drift win is the oracle ' +
      'answering a question it was not asked',
  );
}

console.log(fail ? `morphSegTailDriftSmoke FAIL (${fail})` : 'morphSegTailDriftSmoke PASS');
process.exit(fail ? 1 : 0);
