// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCpatchScaleEquivarianceSmoke — the Loop-Blinn static build is the same mesh, up to scale, from 2^-20 to 2^20.
//
// THE PROPERTY. Multiplying every coordinate by a power of two is exact through + - * / sqrt, so a build run
// on 2^k * contours must return 2^k^e * (its output on the contours) -- every number equal under SOME integer
// power of the scale (positions S, gradients 1/S, areas S^2), every tag, count, length and key identical. A
// difference can only come from a comparison against something that did not scale: an absolute epsilon.
// probes/_zzScaleWide.mjs measures it over the corpus; probes/_zzScaleCmpTrace.mjs names the comparison.
//
// One case per absolute tolerance that would break the property, each at the exponent where it would fail
// (2^-20..2^20):
//   decoder      curveRangeToContours' joint test as an absolute 1e-4: a circle's closing ulp splits it at
//                2^8 and up; five subpaths of a clip path merge into one contour at 2^-20 (lbContour.js)
//   tiger #0     the pack's shared-edge count keyed on a 1e-5 grid; a band end's curvature refusing r2 < 1e-12
//   tiger #4     the klmn keep-side sign's triangle test as |det| < 1e-12 (lbCubicMath.js affineEval)
//   tiger #34    quadRoots01's leading coefficient < 1e-12; circleFromContours' leading stub against 1 unit
//   tiger #99    cubicLoopParams' parallel test |c3 x c2| < 1e-9
//   tiger #120   the containment split's shared-endpoint test at 1e-7 on coordinates (lbPartition.js)
//   straddle     the fill-side straddle split tolerating 1e-5 (lbInteriorSplit.js), at 2^8
//   T-junction   the interior split's T-junction gate and prefilter at 1e-4 (lbInteriorSplit.js), at 2^8
//   heal, sector healCracks' candidate prefilter padded by an absolute 1e-4 (lbFastMesh.js), and a circle
//                sector's fan keeping a 2-unit AA pad the DISC vertex push covers (lbContour.js), at 2^8
//   CPatch       the decomposition and wire (exact row gate off) on tiger #12 at 2^-20 and #42/#51 at 2^20: the
//                graph's node-merge floor, segTangent's magnitude seeded at 1, the chord box's absolute pad,
//                cubicLoopCuts' + 1e-12, implCritical's mixed-unit quadratic test
// and, directly: a circle whose closing line comes FIRST is not a disc at 2^-20; a loop cubic keeps its double
// point at 2^-20; an S-curve's inflection is the same parameter at 2^-20.
//
// The (dk, dl) lane of a cubic band is a shared-exponent pair with float32's own range (lbPack's packKlmGrad);
// as two halves it would saturate or flush outside the half range. So the comparator decodes it and holds it
// strictly, and test/lbKlmGradFormatSmoke.mjs owns the format itself. Pinned elsewhere: the em-tuned lengths in lbInteriorSplit.js and
// lbPartition.js (0.015, 0.002, 0.00025) in test/lbEmTunedLengthScaleSmoke.mjs -- along with lbPack's
// straight-edge key lattice, lbFastMesh's cross-product bar, lbCubicMath's control-leg bar and _setKeyOrigin's
// own box, the unit they are all written against -- and CPatch's hull-row gate, which carries no bar
// at all, in test/cpatchRowGateSmoke.mjs.
import { readFileSync } from 'fs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { LB_VERT_FLOATS, unpackKlmGrad } = await import('../src/renderer/lbPack.js');
const { circleFromContours } = await import('../src/geom/shapeRecognize.js');
const { cubicLoopParams, cubicInflections } = await import('../src/geom/lbCubicMath.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

// ------------------------------------------------------------------ comparator (see probes/_zzScaleWide.mjs)
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
        // The lanes lbPack fills with packHalf2x16 are UNIT VECTORS (a curve band's own end normals, a
        // Bezout ring's push normal), so they live in [-1, 1] at every size and only their 2^-11 quantum
        // is excused.
        const lane = i % LB_VERT_FLOATS,
          v0 = i - lane,
          kd = Math.floor(b[v0 + 5]);
        const packed =
          kd === 12
            ? lane === 15 || lane === 16
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
        // The cubic band's klm GRADIENT pair scales as 1/S and is the one packed lane that does. As two
        // halves it would saturate below about 2^-11 of the authored size and flush above 2^7; it is a
        // shared-exponent pair with float32's own range (see lbPack's packKlmGrad), so there is nothing to
        // excuse as "the vertex format's range": DECODE it and
        // hold both components to the format's own 2^-11, with no saturation or flush escape.
        if (kd === 12 && lane === 9 && Math.abs(b[v0 + 6]) >= 8192) {
          const ga = unpackKlmGrad(a[i]),
            gb = unpackKlmGrad(b[i]);
          if ([0, 1].every((j) => numEq(ga[j], gb[j], S, 2e-3) || (ga[j] === 0 && gb[j] === 0)))
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

// ------------------------------------------------------------------ inputs
/// FRESH segments at 2^k, field by field: a spread copy carries the builders' memos (under symbols) along.
const scaled = (cs, S) =>
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
/// The float32 curve plane at 2^k: every coordinate slot scaled, headers and arc angles kept.
function scalePlane(plane, r, S) {
  const out = plane.slice();
  let hdr = r.begin | 0;
  while (hdr + 4 <= r.end) {
    const hw = plane[hdr];
    if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
    const ty = hw & 3,
      d = hdr + 4,
      n = ty === SEG_LINE ? 4 : ty === SEG_QUAD ? 6 : ty === SEG_CUBIC ? 8 : 4;
    for (let i = 0; i < n; i++) out[d + i] = plane[d + i] * S;
    if (ty === 3) for (let i = 8; i < 12; i++) out[d + i] = plane[d + i] * S; // an arc's stored endpoints
    hdr = d + (ty === SEG_LINE ? 8 : ty === 3 ? 16 : 12);
  }
  return out;
}
async function load(file) {
  const svg = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  const sec = await importSvg(svg, { preserveViewport: true });
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return { sec, meta, cf: new Float32Array(sec.curves) };
}
function lbCase(A, s, KS, label) {
  const { sec, meta, cf } = A,
    r = sec.curveRangesByShape[s],
    fps = meta.floatsPerShape,
    mf = meta.metaFloats,
    bb = s * fps;
  const transSolid =
    mf[bb + 7] < 0.996 &&
    Math.floor(mf[bb + 28] + 0.5) === 0 &&
    (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
  const evenOdd = mf[bb + 13] > 0.5;
  const base = curveRangeToContours(cf, r.begin, r.end);
  const run = (S) => {
    const b = buildLbShape(scaled(base, S), transSolid, evenOdd);
    return b
      ? {
          raw: b.raw,
          lbpk: {
            verts: b.pk.verts.subarray(0, b.pk.vertexCount * LB_VERT_FLOATS),
            vertexCount: b.pk.vertexCount,
            kindMask: b.pk.kindMask | 0,
          },
        }
      : null;
  };
  const ref = run(1);
  for (const k of KS) {
    const w = ref ? cmp(run(2 ** k), ref, 2 ** k) : 'declined at scale 1';
    check(
      !w,
      `${label} #${s} buildLbShape at 2^${k} is the scale-1 mesh scaled${w ? ' -- ' + w : ''}`,
    );
  }
}

// ------------------------------------------------------------------ decoder
console.log('curve decoder (curveRangeToContours)');
{
  for (const [file, s, KS] of [
    ['examples/_blur.svg', 1, [8, 20]],
    ['examples/smoke/lbClipParity__SVG.svg', 1, [-20]],
  ]) {
    const { sec, cf } = await load(file);
    const r = sec.curveRangesByShape[s];
    const ref = curveRangeToContours(cf, r.begin, r.end);
    for (const k of KS) {
      const got = curveRangeToContours(scalePlane(cf, r, 2 ** k), r.begin, r.end);
      const w = cmp(got, ref, 2 ** k);
      check(!w, `${file} #${s} decodes to the scale-1 contours at 2^${k}${w ? ' -- ' + w : ''}`);
    }
  }
}

// ------------------------------------------------------------------ the static build
console.log('Loop-Blinn static build (buildLbShape): mesh and pack');
{
  const T = await load('examples/tiger.svg');
  lbCase(T, 0, [-20, 20], 'tiger');
  lbCase(T, 4, [-20], 'tiger');
  lbCase(T, 34, [-20], 'tiger');
  lbCase(T, 99, [-20], 'tiger');
  lbCase(T, 120, [-8], 'tiger');
  lbCase(await load('examples/smoke/lbBlendParity__SVG.svg'), 0, [8], 'lbBlendParity');
  lbCase(await load('examples/smoke/noAaStrokeCover__grid_N_0_0.svg'), 0, [8], 'noAaStrokeCover');
  lbCase(await load('examples/smoke/filterBakeCache__SVG.svg'), 0, [8], 'filterBakeCache');
}

// ------------------------------------------------------------------ CPatch
// The decomposition and its wire. These cases are about the DECOMPOSITION; the exact hull-row gate runs as it ships
// (it is scale-free -- test/cpatchRowGateSmoke.mjs owns it and pins the wire), so a row set that moved with scale
// would fail here too. With absolute tolerances these shapes split differently: the graph's node-merge floor, segTangent's magnitude
// seeded at 1, the chord box's pad (tiger #12 at 2^-20), and cubicLoopCuts' + 1e-12 and implCritical's mixed-unit
// quadratic test (tiger #42 and #51, 2^20).
console.log('CPatch (packCPatchShape): patches and wire');
{
  const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
  const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
  const T = await load('examples/tiger.svg');
  const cf = T.sec.curves64 ? new Float64Array(T.sec.curves64) : T.cf;
  const cvScaled = (cs, S) =>
    cs.map((c) =>
      c.map((sg) => {
        const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
        if (sg.cut) o.cut = true;
        if (sg.w !== undefined) o.w = sg.w;
        return o;
      }),
    );
  const run = (cs, S) => {
    const patches = [];
    const w = packCPatchShape(cvScaled(cs, S), 0, {
      evenOdd: false,
      onPatches: (a) => patches.push(...a),
    });
    return {
      patches: patches.map((q) => ({
        curves: q.curves.map((c) => ({ t: c.t, P: c.P, cut: !!c.cut })),
        inside: q.inside,
        bbox: q.bbox,
      })),
      wire: w
        ? { texels: w.texels, verts: w.verts, vertexCount: w.vertexCount, kindMask: w.kindMask | 0 }
        : null,
    };
  };
  for (const [s, k] of [
    [12, -20],
    [42, 20],
    [51, 20],
  ]) {
    const r = T.sec.curveRangesByShape[s];
    const cs = contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    const w = cmp(run(cs, 2 ** k), run(cs, 1), 2 ** k);
    check(
      !w,
      `tiger #${s} CPatch at 2^${k} is the scale-1 decomposition scaled${w ? ' -- ' + w : ''}`,
    );
  }
  // The refusal ladder's normalized rung carried the flat 0.02 into its frame: lbMemBudget #84 (27.9 units across)
  // decomposed into 26 patches at scale 1 and 32 at 2^8.
  {
    const M = await load('examples/smoke/lbMemBudget__SVG.svg');
    const mf = M.sec.curves64 ? new Float64Array(M.sec.curves64) : M.cf;
    const r = M.sec.curveRangesByShape[84];
    const cs = contoursToConverter(curveRangeToContours(mf, r.begin, r.end), null);
    const w = cmp(run(cs, 2 ** 8), run(cs, 1), 2 ** 8);
    check(
      !w,
      `lbMemBudget #84 CPatch at 2^8 is the scale-1 decomposition scaled${w ? ' -- ' + w : ''}`,
    );
  }
}

// ------------------------------------------------------------------ direct
console.log('recognition and cubic analysis');
{
  // A full circle of tagged arcs whose contour OPENS with a 0.01-unit line: a real edge (1e-3 of the radius is
  // the stub bar), so not a disc -- at every size.
  const r = 10,
    circle = { cx: 0, cy: 0, r },
    segs = [mkLine([r, -0.01], [r, 0])];
  for (let i = 0; i < 4; i++) {
    const a0 = (i * Math.PI) / 2,
      a1 = a0 + Math.PI / 2,
      am = (a0 + a1) / 2,
      w = Math.cos(Math.PI / 4);
    segs.push(
      mkRQuad(
        [r * Math.cos(a0), r * Math.sin(a0)],
        [(r * Math.cos(am)) / w, (r * Math.sin(am)) / w],
        [r * Math.cos(a1), r * Math.sin(a1)],
        w,
        circle,
      ),
    );
  }
  for (const k of [0, -20])
    check(
      !circleFromContours(scaled([segs], 2 ** k)),
      `a circle opened by a 0.01 line is not a disc at 2^${k}`,
    );
  const loop = [
    [0, 0],
    [5, 5],
    [-2, 5],
    [3, 0],
  ];
  const L1 = cubicLoopParams(loop),
    L2 = cubicLoopParams(loop.map((q) => [q[0] * 2 ** -20, q[1] * 2 ** -20]));
  check(
    !!L1 && !!L2 && L1.lo === L2.lo && L1.hi === L2.hi,
    `a loop cubic keeps its double point at 2^-20 (${JSON.stringify(L1)} vs ${JSON.stringify(L2)})`,
  );
  // A few hundredths across, so the inflection quadratic's leading coefficient (a cross product, S^2) is
  // 9e-4 at 1 and 8e-16 at 2^-20: under an absolute 1e-12 the second would take the linear formula.
  // CPatch's segTangent: a first control leg 1e-7 long on a 100-unit curve is a direction at scale 1 (3e-7 against
  // a vanishing bar of 1e-12 of the coordinates), and must stay one at 2^-20 (an absolute 1e-12 bar would lose it there).
  {
    const { segTangent } = await import('../src/geom/cpatchImplicit.js');
    const P = [
      [100, 100],
      [100 + 1e-7, 100],
      [150, 150],
      [200, 100],
    ];
    const t1 = segTangent({ t: 'cubic', P }, 0),
      t2 = segTangent({ t: 'cubic', P: P.map((q) => [q[0] * 2 ** -20, q[1] * 2 ** -20]) }, 0);
    check(
      t1[0] * 2 ** -20 === t2[0] && t1[1] * 2 ** -20 === t2[1],
      `segTangent keeps a short first leg's direction at 2^-20 (${t1} vs ${t2.map((v) => v * 2 ** 20)})`,
    );
    // pathToCycles: a 1e-8 jog on a 100-unit square is two nodes at scale 1 (1e-11 of the diagonal is 1.4e-9) and
    // must stay two at 2^-20 (a merge tolerance floored at an absolute 1e-12 would be a thousand times the bar there).
    const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
    const Ln = (p, q, s) => ({
      t: 'line',
      P: [
        [p[0] * s, p[1] * s],
        [q[0] * s, q[1] * s],
      ],
    });
    const sq = (s) => [
      [
        Ln([0, 0], [100, 0], s),
        Ln([100, 0], [100, 50], s),
        Ln([100, 50], [100 + 1e-8, 50], s),
        Ln([100 + 1e-8, 50], [100 + 1e-8, 100], s),
        Ln([100 + 1e-8, 100], [0, 100], s),
        Ln([0, 100], [0, 0], s),
      ],
    ];
    const c1 = pathToCycles(sq(1), false),
      c2 = pathToCycles(sq(2 ** -20), false);
    check(
      c1.length === c2.length && c1.every((c, i) => c.length === c2[i].length),
      `pathToCycles keeps a 1e-8 jog's two nodes at 2^-20 (${c1.map((c) => c.length)} vs ${c2.map((c) => c.length)})`,
    );
  }
  const S = [
    [0, 0],
    [1, 3],
    [3, -2],
    [4, 2],
  ].map((q) => [q[0] * 0.01, q[1] * 0.01]);
  const i1 = cubicInflections(S),
    i2 = cubicInflections(S.map((q) => [q[0] * 2 ** -20, q[1] * 2 ** -20]));
  check(
    i1.length > 0 && i1.length === i2.length && i1.every((t, j) => Math.abs(t - i2[j]) <= 1e-12),
    `an S-curve's inflections are the same parameters at 2^-20 (${i1} vs ${i2})`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL lbCpatchScaleEquivarianceSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbCpatchScaleEquivarianceSmoke');
