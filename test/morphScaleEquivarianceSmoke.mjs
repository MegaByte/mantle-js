// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphScaleEquivarianceSmoke — A MORPH IS THE same MORPH AT every SIZE.
//
// lbCpatchScaleEquivarianceSmoke pins the STATIC builds, lbEmTunedLengthScaleSmoke the
// Loop-Blinn build's em-tuned lengths and cpatchRowGateSmoke the CPatch hull-row gate.
// None of them runs a MORPH, and a morph is not a shape: it is a PAIR of them, and every decision
// that makes one -- the merged cubic split plan, the provenance transform that derives the
// destination mesh, the layout, the certificate over a continuum of poses -- is taken on the pair by
// code those smokes never reach, so absolute tolerances in the pair code are invisible to all three.
//
// THE PROPERTY. Scaling by a power of two is exact through + - * / sqrt, so a morph built on 2^k *
// (both poses) must be the scale-1 morph scaled: the same route (pair / plain-row pair / t-segmented
// / declined to Slug), the same topology, the same certificate verdicts, the same plan boundaries,
// and every number equal under some integer power of the scale. Anything that moves is a comparison
// against something that did not scale. probes/morphScale/ measures it over a corpus; this pins one
// case per site, at the exponent where an absolute tolerance there would fail it.
//
// LOOP-BLINN, the morph pair (lbPartitionPair.js: three bars, and two cross-product divisors beside
// them):
//   L1  the fan triangle's barycentric divisor as `|den| < 1e-18`. A triangle area is S^2, so on a
//       cubic-bearing pair that bar goes from deciding nothing at scale 1 to declining the pair
//       outright below about 2^-8. It is priced by CONDITIONING (sin of the corner angle), which is
//       dimensionless, because a fan triangle's corners are the control points of a cubic PIECE and
//       a piece can be a thousandth of its shape without being degenerate.
//   L2  the crossing-splitter's Steiner divisor, same constant, same pricing, reached by a pair whose
//       drawing is small enough that a whole-shape cross product falls under 1e-18.
//   L3  the dst-side LENGTHS (`nlD`, `chordD`, an invisible quad's sagitta) and the src-side
//       control-point MATCH are one float32 ulp of the pose that owns them -- and the pair keeps
//       TWO units, because its two poses are not the same size.
//
// CPATCH, the morph plan (a flat `tolPx: 0.05` at every hop from the renderer to the
// certificate would mean `defaultTolPx`'s scaling -- which cpatchBuild applies on the static path --
// never runs on a morph):
//   C1  certifyMorphClip normalizes the pair into a unit box and carries the tolerance with it, so a
//       flat bar would become a NORMALIZED bar inversely proportional to the drawing's size.
//   C2  certifyMorphLeak, the same.
//   C3  planMorph: one bar decides the two certificates, validatePatch on every sampled pose and the
//       source decomposition's leak margin, so the plan's SEGMENT BOUNDARIES would move with the size.
//   C4  extractLayout: a seam dropped when shorter than `1e-6 * (max|coord| + 1)` -- a distance
//       from the ORIGIN plus an absolute unit -- drops every seam below a unit across and the
//       layout collapses; likewise an anchor triangle that needs an absolute 1e-12 of area.
//   C5  splitForMorph's inflection solve, testing a cross product against 1e-14, would take the
//       linear branch of a quadratic that has a perfectly good leading term on a small drawing.
//   C6  toCurvesPair's "this segment is zero length" as an absolute 1e-9 would make whether a closing
//       segment counts as geometry -- which changes the SEGMENT COUNT the whole pairing rests on --
//       depend on where the artwork is authored.
import { buildLoopBlinnPartitionPair } from '../src/renderer/lbPartitionPair.js';
import { packLoopBlinnMesh, LB_VERT_FLOATS } from '../src/renderer/lbPack.js';
import {
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
} from '../src/primitives/seg.js'; // SEG_* tag the scaled copies
import { convertContour } from '../src/renderer/cpatchConvert.js';
import {
  planMorph,
  certifyMorphClip,
  certifyMorphLeak,
  splitForMorph,
  extractLayout,
} from '../src/renderer/cpatchMorphCert.js';
// C6's decision is `toCurvesPair`'s, which is module-private and reached only through a bundle and a
// worker pool -- so it is exposed for this smoke. On a tree that does not expose it the case reports
// itself unreachable rather than crashing the file, which keeps the other cases' verdicts readable.
const _toCurvesPair = (await import('../src/renderer/cpatchMorphBuild.js'))._toCurvesPair || null;

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

// ------------------------------------------------------------------ comparator
// lbCpatchScaleEquivarianceSmoke's contract: every number equal under SOME integer power of the
// scale, every tag, count, length and key identical. The lanes lbPack fills with packHalf2x16 are
// excused when a half saturates or flushes -- the vertex format's range, not a decision.
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const halfToNum = (h) => {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >>> 10) & 0x1f,
    m = h & 0x3ff;
  return e === 0
    ? s * m * 2 ** -24
    : e === 31
      ? m
        ? NaN
        : s * Infinity
      : s * (1 + m / 1024) * 2 ** (e - 15);
};
const halves = (v) => {
  f32[0] = v;
  const x = u32[0];
  return [halfToNum(x & 0xffff), halfToNum(x >>> 16)];
};
function numEq(a, b, S, tol) {
  if (a === b || (a !== a && b !== b)) return true;
  if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
  for (let e = -8, p = S ** -8; e <= 8; e++, p *= S)
    if (Math.abs(a / p - b) <= Math.abs(b) * tol) return true;
  return false;
}
function cmp(a, b, S, p = '', key = '', seen = new Set()) {
  if (typeof a !== typeof b) return `${p}: ${typeof b} -> ${typeof a}`;
  if (typeof a === 'number') return numEq(a, b, S, 1e-9) ? null : `${p}: ${b} -> ${a}`;
  if (typeof a !== 'object')
    return a === b || typeof a === 'function' ? null : `${p}: ${b} -> ${a}`;
  if (a === null || b === null) return a === b ? null : `${p}: null-ness`;
  if (seen.has(b)) return null;
  seen.add(b);
  if (ArrayBuffer.isView(a)) {
    if (a.constructor !== b.constructor || a.length !== b.length)
      return `${p}: length ${b.length} -> ${a.length}`;
    const lb = key === 'verts' && a.length % LB_VERT_FLOATS === 0;
    for (let i = 0; i < a.length; i++) {
      if (numEq(a[i], b[i], S, a.constructor === Float32Array ? 1e-6 : 1e-9)) continue;
      if (lb) {
        const lane = i % LB_VERT_FLOATS,
          v0 = i - lane,
          kd = Math.floor(b[v0 + 5]);
        const packed =
          kd === 12
            ? lane === 15 || lane === 16 || (lane === 9 && Math.abs(b[v0 + 6]) >= 8192)
            : kd === 4
              ? lane === 22 && b[v0 + 23] === 9
              : false;
        if (packed) {
          const ha = halves(a[i]),
            hb = halves(b[i]);
          if (
            [0, 1].every(
              (j) =>
                numEq(ha[j], hb[j], S, 2e-3) ||
                ha[j] === 0 ||
                hb[j] === 0 ||
                !isFinite(ha[j]) ||
                !isFinite(hb[j]),
            )
          )
            continue;
        }
      }
      return `${p}[${i}]: ${b[i]} -> ${a[i]}`;
    }
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array-ness`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: length ${b.length} -> ${a.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = cmp(a[i], b[i], S, `${p}[${i}]`, key, seen);
      if (r) return r;
    }
    return null;
  }
  const ka = Object.keys(a).sort(),
    kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${p}: keys {${kb}} -> {${ka}}`;
  for (const k of Object.keys(b)) {
    const r = cmp(a[k], b[k], S, `${p}.${k}`, k, seen);
    if (r) return r;
  }
  return null;
}

// ------------------------------------------------------------------ shapes
/// FRESH segments at 2^k, field by field: a spread copy carries the builders' memos (under symbols).
const scaledSegs = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        sg.circle ? { cx: sg.circle.cx * S, cy: sg.circle.cy * S, r: sg.circle.r * S } : null,
      );
    }),
  );
const scaledCurves = (cs, S) =>
  cs.map((c) =>
    c.w !== undefined
      ? { t: c.t, w: c.w, P: c.P.map((q) => [q[0] * S, q[1] * S]) }
      : { t: c.t, P: c.P.map((q) => [q[0] * S, q[1] * S]) },
  );

/// The bowed blob the morph smokes and probes use: K sides, each bowed, growing and rotating with t.
/// `unit` scales the whole thing about its own center, so the same outline can be authored at any size.
function blob(t, phase, kind, unit = 1, K = 6) {
  const R = (40 + 22 * t) * unit,
    cx = 100 * unit,
    cy = 100 * unit;
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    if (kind === 'cubic')
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
    else out.push({ t: 'quad', P: [A, [mx, my], B] });
  }
  return out;
}
/// The same blob as importer segs (what the Loop-Blinn pair builder takes).
const blobSegs = (t, phase, kind, unit) => [
  blob(t, phase, kind, unit).map((c) =>
    c.t === 'cubic' ? mkCubic(c.P[0], c.P[1], c.P[2], c.P[3]) : mkQuad(c.P[0], c.P[1], c.P[2]),
  ),
];

// ================================================================== Loop-Blinn: the morph pair
console.log('Loop-Blinn morph pair (buildLoopBlinnPartitionPair)');
{
  const pairAt = (src, dst, S, opts) => {
    const pr = buildLoopBlinnPartitionPair(scaledSegs(src, S), scaledSegs(dst, S), 'nonzero', opts);
    if (!pr) return null;
    const pkS = packLoopBlinnMesh(pr.src),
      pkD = packLoopBlinnMesh(pr.dst);
    return {
      src: pr.src,
      dst: pr.dst,
      pkS: {
        verts: pkS.verts.subarray(0, pkS.vertexCount * LB_VERT_FLOATS),
        vertexCount: pkS.vertexCount,
        kindMask: pkS.kindMask | 0,
      },
      pkD: {
        verts: pkD.verts.subarray(0, pkD.vertexCount * LB_VERT_FLOATS),
        vertexCount: pkD.vertexCount,
        kindMask: pkD.kindMask | 0,
      },
    };
  };
  // L1 -- THE FAN TRIANGLE'S DIVISOR. A cubic blob that grows and rotates: the pair builds at scale 1
  // and with `|den| < 1e-18` would DECLINE from 2^-8 down: on an S^2 quantity that bar stops being a
  // degeneracy test and becomes "every triangle". The whole morph would fall to Slug at one size and
  // not at another, which is the defect in its user-visible form.
  for (const phase of [0, 2.0]) {
    const src = blobSegs(0, phase, 'cubic'),
      dst = blobSegs(1, phase, 'cubic');
    const ref = pairAt(src, dst, 1);
    check(!!ref, `L1 cubic blob (rot ${phase}) builds a pair at scale 1`);
    for (const k of [-8, -12, -16, -20]) {
      const got = pairAt(src, dst, 2 ** k);
      const w = ref && got ? cmp(got, ref, 2 ** k) : ref ? 'declined' : 'no scale-1 pair';
      check(
        !!ref && !!got && !w,
        `L1 cubic blob (rot ${phase}) at 2^${k} is the scale-1 pair scaled${w ? ' -- ' + w : ''}`,
      );
    }
  }
  // L2 -- THE same CONSTANT, REACHED BY A SMALL DRAWING. The Steiner divisor is a cross product of two
  // whole-SHAPE edge vectors, so 1e-18 needs a much smaller drawing than L1's piece-sized triangles
  // before it bites. A blob authored at 2^-10 of a unit is one; so is any of the em-sized artwork the
  // renderer is asked to draw. Both poses scale together, so the answer must not move.
  for (const unit of [2 ** -10, 2 ** -6, 2 ** 6]) {
    const src = blobSegs(0, 1.0, 'cubic', unit),
      dst = blobSegs(1, 1.0, 'cubic', unit);
    const ref = pairAt(src, dst, 1);
    for (const k of [-20, 20]) {
      const got = pairAt(src, dst, 2 ** k);
      const w = ref && got ? cmp(got, ref, 2 ** k) : !ref === !got ? null : 'route changed';
      check(
        !ref === !got && !w,
        `L2 cubic blob authored at ${unit} decides the same at 2^${k}${w ? ' -- ' + w : ''}`,
      );
    }
  }
  // L3 -- TWO POSES, TWO SIZES, ONE PAIR. The dst-side bars are one float32 ulp of the DESTINATION's
  // own extent, so a pose that shrinks by 16x through the morph is not measured in the source's
  // units. Scaling the pair must still not move anything.
  for (const [su, du] of [
    [1, 1 / 16],
    [1 / 16, 1],
    [2 ** 6, 2 ** -6],
  ]) {
    const src = blobSegs(0, 0, 'cubic', su),
      dst = blobSegs(1, 0, 'cubic', du);
    const ref = pairAt(src, dst, 1, { plainDstRows: true });
    for (const k of [-20, 20]) {
      const got = pairAt(src, dst, 2 ** k, { plainDstRows: true });
      const w = ref && got ? cmp(got, ref, 2 ** k) : !ref === !got ? null : 'route changed';
      check(
        !ref === !got && !w,
        `L3 mixed-size pair (${su} -> ${du}) decides the same at 2^${k}${w ? ' -- ' + w : ''}`,
      );
    }
  }
}

// ================================================================== CPatch: the morph plan
console.log('CPatch morph plan (planMorph / certifyMorphClip / certifyMorphLeak)');
{
  // NO tolPx IS PASSED ANYWHERE BELOW, which is the point: the renderer does not pass one either
  // (cpatchMorphBuild omits it so the worker can derive the pair's own bar), so these calls take the
  // same path a real morph takes. Pinning a tolerance here would test a number nothing uses.
  const convert = (cs, o) => {
    try {
      return convertContour(cs, {
        maxCurves: 8,
        noCurveCuts: true,
        forceBezout: true,
        leakMargin: (o && o.leakMargin) || 0,
      });
    } catch {
      return null;
    }
  };
  const verdict = (c) => ({
    ok: !!c.ok,
    pairs: c.pairs | 0,
    certified: c.certified | 0,
    failures: c.failures.length,
    inconclusive: c.inconclusive | 0,
  });

  // C1 / C2 -- THE TWO CERTIFICATES. Each normalizes the pair into a unit box and multiplies the
  // tolerance by the same factor, so a flat bar in world units is a normalized bar of 0.05/r: eight
  // binary orders of magnitude apart between 2^-8 and 2^8 of the same drawing.
  for (const kind of ['quad', 'cubic']) {
    const A0 = blob(0, 1.0, kind),
      B0 = blob(1, 1.0, kind);
    const [A, B] = splitForMorph(A0, B0);
    const refC = verdict(certifyMorphClip(A, B, {})),
      refL = certifyMorphLeak(A, B, {});
    for (const k of [-8, 8]) {
      const S = 2 ** k,
        As = scaledCurves(A, S),
        Bs = scaledCurves(B, S);
      const gotC = verdict(certifyMorphClip(As, Bs, {}));
      check(
        JSON.stringify(gotC) === JSON.stringify(refC),
        `C1 ${kind}: certifyMorphClip is the same verdict at 2^${k} (${JSON.stringify(refC)} vs ${JSON.stringify(gotC)})`,
      );
      const gotL = certifyMorphLeak(As, Bs, {});
      check(
        gotL.failures.length === refL.failures.length &&
          (gotL.certified | 0) === (refL.certified | 0),
        `C2 ${kind}: certifyMorphLeak is the same verdict at 2^${k} (${refL.failures.length}/${refL.certified} vs ${gotL.failures.length}/${gotL.certified})`,
      );
    }
  }

  // C3 -- THE PLAN. Its segment boundaries are parameters in t, so they are scale-free numbers and
  // must come out IDENTICAL, not merely close. A NON-ROTATING blob on purpose: the rotating one
  // plans fifty-odd minStep segments and takes minutes, and the defect shows in one.
  {
    const [A, B] = splitForMorph(blob(0, 0, 'cubic'), blob(1, 0, 'cubic'));
    const spans = (p) =>
      p ? p.map((s) => `${s.t0}:${s.t1}:${s.layout.length}`).join(' ') : 'null';
    // The plan's time bound is off: a plan that has to be the same at every scale has to be the same
    // on every machine, and a wall-clock deadline is not (see planMorph's `maxPlanMs`).
    const ref = spans(planMorph(A, B, convert, { maxPlanMs: 0 }));
    for (const k of [-6, 6]) {
      const S = 2 ** k;
      const got = spans(
        planMorph(scaledCurves(A, S), scaledCurves(B, S), convert, { maxPlanMs: 0 }),
      );
      check(
        got === ref,
        `C3 planMorph gives the same segments at 2^${k}\n       ref ${ref.slice(0, 160)}\n       got ${got.slice(0, 160)}`,
      );
    }
  }

  // C4 -- THE LAYOUT. A seam bar of `1e-6 * (max|coord| + 1)` in `extractLayout` is a distance from
  // the ORIGIN, plus an absolute unit that dominates it for any drawing under a unit across, so every
  // seam of a small drawing would be dropped and the layout would lose its patches; likewise an
  // anchor triangle that needs an absolute 1e-12 of area.
  {
    const shape = (unit) => blob(0.35, 1.0, 'cubic', unit);
    const layoutOf = (unit) => {
      const cs = shape(unit);
      const conv = convert(cs, { leakMargin: 0 });
      const L = conv && conv.patches.length ? extractLayout(conv.patches, cs) : null;
      return L ? L.map((l) => l.length).join(',') : 'null';
    };
    const ref = layoutOf(1);
    check(ref !== 'null', `C4 extractLayout produces a layout at unit 1 (${ref})`);
    for (const unit of [2 ** -20, 2 ** -10, 2 ** 10]) {
      const got = layoutOf(unit);
      check(got === ref, `C4 extractLayout is the same layout at unit ${unit} (${ref} vs ${got})`);
    }
  }

  // C5 -- THE INFLECTION SPLIT. `|A| < 1e-14` on a cross product of power-basis coefficients (S^2):
  // below about a unit across every cubic reads as having no leading term and takes the linear
  // branch, so the poses are cut at different parameters than the same outline drawn larger.
  {
    // A NEAR-QUADRATIC CUBIC, which is where the bar actually decides something: `A` is 6 (b x c)
    // and `c` is the cubic term, so a curve that is a quadratic plus a 1e-7 nudge has |A| ~ 1e-5 at
    // 100 units and ~1e-17 at 2^-20 of that -- one side of an absolute 1e-14 and then the other,
    // which is the difference between solving a quadratic and solving its linear truncation. Its
    // own leading term is perfectly well conditioned the whole time (sin(t) is O(1)), which is what
    // the dimensionless bar sees.
    const nearQuad = (unit) => {
      const q = [
        [0, 0],
        [60, 120],
        [120, 0],
      ].map((p) => [p[0] * unit, p[1] * unit]);
      const el = (a, b) => [a[0] + (2 / 3) * (b[0] - a[0]), a[1] + (2 / 3) * (b[1] - a[1])];
      const p1 = el(q[0], q[1]),
        p2 = el(q[2], q[1]);
      p2[0] += 1e-7 * unit; // the nudge that makes it a cubic at all
      return [
        { t: 'cubic', P: [q[0], p1, p2, q[2]] },
        { t: 'line', P: [q[2], q[0]] },
      ];
    };
    const cuts = (unit, mk) => {
      const [A, B] = splitForMorph(mk(unit), mk(unit * 1.25));
      return `${A.length}/${B.length}`;
    };
    const rq = cuts(1, nearQuad);
    for (const unit of [2 ** -20, 2 ** -12, 2 ** 12])
      check(
        cuts(unit, nearQuad) === rq,
        `C5 splitForMorph cuts a near-quadratic cubic the same at unit ${unit} (${rq} vs ${cuts(unit, nearQuad)})`,
      );
    // ...and the ordinary case, which must not move either.
    const mk = (unit) => blob(0, 2.0, 'cubic', unit);
    const ref = cuts(1, mk);
    for (const unit of [2 ** -20, 2 ** -12, 2 ** 12])
      check(
        cuts(unit, mk) === ref,
        `C5 splitForMorph cuts the blob the same at unit ${unit} (${ref} vs ${cuts(unit, mk)})`,
      );
  }

  // C6 -- "this SEGMENT IS ZERO LENGTH", which decides the SEGMENT COUNT the whole pairing rests on.
  // A closing line a millionth of the shape long is real geometry to an absolute 1e-9 when the shape
  // is 100 units across and nothing at all when the same shape is authored at 1/1000 of that.
  if (!_toCurvesPair) console.log('  -- C6 skipped: this tree does not expose toCurvesPair');
  else {
    // A stub 1e-4 of the shape's own size: a thousand float32 ulps of it, so it is real geometry at
    // every size and must be KEPT at every size. An absolute 1e-9 keeps it down to about 1e-5 units and
    // drops it below that, which changes the curve count the whole pairing is indexed by.
    const withStub = (unit) => {
      const segs = blob(0, 0, 'quad', unit).map((q) => mkQuad(q.P[0], q.P[1], q.P[2]));
      const e = segs[segs.length - 1].p3,
        j = [e[0] + 1e-4 * unit, e[1]];
      segs.push(mkLine(e, j), mkLine(j, segs[0].p1));
      return segs;
    };
    const n = (unit) => {
      const p = _toCurvesPair(withStub(unit), withStub(unit));
      return p ? p.A.length : -1;
    };
    const ref = n(1);
    check(ref > 0, `C6 toCurvesPair keeps a 1e-4-of-the-shape stub at unit 1 (${ref} curves)`);
    for (const unit of [2 ** -20, 2 ** -8, 2 ** 8])
      check(
        n(unit) === ref,
        `C6 toCurvesPair keeps the same segments at unit ${unit} (${ref} vs ${n(unit)})`,
      );
  }
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL morphScaleEquivarianceSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS morphScaleEquivarianceSmoke');
