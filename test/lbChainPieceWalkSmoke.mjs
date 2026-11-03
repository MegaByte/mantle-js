// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbChainPieceWalkSmoke — `chainBoxCov` closes every gap along the box border, not just the wrap,
// and a chain that merely TOUCHES the box is a miss.
//
// THE KERNEL. `chainBoxCov` is the Loop-Blinn analytic interior coverage: area(pixel box ∩ fill)
// for a local outline chain of four segments, fill on the LEFT. It clips the chain to the box
// (Liang–Barsky per segment) and shoelaces the fill polygon, closing it along the box border on
// the fill side. Every interior chain face on every LB-drawn shape goes through it.
//
// THREE CLOSURE RULES, pinned where the truth is known in closed form: with the chain route on a
// PURE-STRAIGHT outline the truth is a polygon.
//
//   (1) DISCONNECTED RUNS ARE NOT SHOELACED AS A CHORD. The chain can clip into the box as several
//       disjoint runs — a corner pixel that two far-apart edges of one closed outline both cross.
//       ONE polyline built from them, with the border walked only at the wrap, makes the gap
//       between one run's exit and the next run's entry a straight chord across the box, and the
//       fill rectangle closes as a triangle: exactly HALF. A 12 x 76 unit rectangle's own corner
//       pixel would read 0.447 where the path covers 0.895 — 113/255, on the one case where a
//       chain must be exact.
//
//   (2) A ZERO-LENGTH RUN IS A MISS. An outline VERTEX sitting on the box border clips its two
//       segments to t0 == t1 there. That run has no length, no area and no direction, but it is
//       TWO coincident points, so an `n < 2` test lets it through: the closure walks a zero-length
//       border arc and returns area 0. For an AUXILIARY chain — whose whole contract is that its
//       only safe miss is 1.0, because it can only CARVE — that 0 goes through the caller's `min()`
//       and punches a hole: a 12-gon's vertex pixel would read 0/255 where the path covers 0.837.
//
// (3) INTERLEAVED RUNS ARE CLOSED IN BORDER ORDER. A walk from each run's exit to the NEXT RUN's
//     entry follows the border's own order only when the runs do not interleave along it. A chain
//     that cuts two opposite corners of the box, each with its own fill, exits the first corner and
//     is next met on the border by its own entry; a chain-order walk goes round the far side
//     instead, and of the 12,146 random box-crossing chains below it reads 1,188 wrong, worst 0.999
//     -- up to the complement. The closure sums the border the way the cubic chain does (Green's
//     theorem: half the runs' shoelace plus a quarter of the border length inside the fill, from
//     the crossings' border parameters), which pairs every exit with the next crossing whichever run
//     it belongs to. Two tolerances of the same closure are pinned with it: an end within 1e-4 of
//     the border is still continued where its ray runs back across the box, and a border point
//     within 1e-4 of a corner keeps its own side's parameter. On the random battery below the
//     closure is exact to rounding. `__LB_CHAIN_WALK_CLOSE` selects the chain-order walk with both
//     1e-4 tolerances.
//
// ...and a fourth that only float32 shows. (1) and (2) turn on IDENTITY between clipped points, and
// a clip computed as `A + t * d` = `A + t*(B - A)` CANCELS: at t == 1 on a segment 512 cells long
// it reproduces B to about 1.4e-5 rather than exactly, and at 94 cells to 6e-6. So the zero-length
// test sees a sliver where the truth is a touch and returns 0 for an auxiliary chain, and the ring
// test falls on the wrong side, walks a FULL LAP of the box and returns a solid 1.0 where the truth
// is 0.895 — in the shader only, while a float64 twin is exact. The clip lerps (`mix`), which is
// exact at both ends by construction. A float64 model cannot see this class at all, which is why
// the shipped shader text is run here in float32 rather than trusted to the twin.
//
// WHAT IS PINNED. The truth for a CONVEX chain is the box clipped by each segment's left
// half-plane — exact, in closed form, no supersampling — so these are correctness assertions,
// not tolerance bars. Run against the SHIPPED SHADER TEXT compiled to float32 C++
// (`_glslEmu.mjs`) as well as against the CPU twin, because the last case above exists only in
// float32 and a float64 model cannot see it. `__LB_CHAIN_OLD_CLOSE` selects the single-polyline
// closure in the twin, and the last section checks that every assertion here FAILS on it — an
// assertion that cannot fail is not one.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CHAIN_COV } from './_glslEmu.mjs';
import { chainBoxCov } from '../probes/lbAccuracy/_lbBoxCov.mjs';
import { exactChainArea, randomCrossingChains } from '../probes/lbAccuracy/_chainExact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

/// area(box ∩ ∩ᵢ left-of-segmentᵢ), by Sutherland–Hodgman. exact for a convex chain, which is
/// what every case below is: a convex polygon's fill IS the intersection of its edges' left
/// half-planes, and a convex vertex's local fill is the intersection of its two.
function exactLeftArea(pts) {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = pts[i],
      B = pts[i + 1];
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    if (dx * dx + dy * dy < 1e-24) continue;
    const f = (p) => dx * (p[1] - A[1]) - dy * (p[0] - A[0]);
    const out = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k],
        b = poly[(k + 1) % poly.length];
      const fa = f(a),
        fb = f(b);
      if (fa >= 0) out.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
    if (!poly.length) return 0;
  }
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k],
      b = poly[(k + 1) % poly.length];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(area) / 2;
}

const f32 = (p) => {
  const a = new Float32Array(p);
  return [a[0], a[1]];
};
const withFlag = (key) => (fn) => {
  const prev = globalThis[key];
  globalThis[key] = true;
  try {
    return fn();
  } finally {
    globalThis[key] = prev;
  }
};
const withOld = withFlag('__LB_CHAIN_OLD_CLOSE');
const withWalk = withFlag('__LB_CHAIN_WALK_CLOSE');

// ── the two named cases, verbatim from the meshes they came off ───────────────────────────────
// (1) the rect: a 12x76 unit bar at 512 px, the chain is its whole closed boundary, the pixel is
//     the top-left corner. Its left edge lies on the canvas edge, which is why the corner pixel's
//     chain clips as two disjoint runs.
const RECT = [
  [-0.5, -0.3947],
  [511.5, -0.3947],
  [511.5, 363.395],
  [-0.5, 363.395],
  [-0.5, -0.3947],
].map(f32);
// (2) the 12-gon at 512 px, pixel (383,477): the outline's VERTEX sits on the box's right border.
//     The face's own chain carries three real segments; the auxiliary chain carries the arm that
//     runs into the vertex and nothing else, so its only clipped run is that zero-length touch.
const GON_OWN = [
  [94.203, -93.5],
  [0.5, 0.203],
  [-127.5, 34.5],
  [-255.5, 0.203],
  [-255.5, 0.203],
].map(f32);
const GON_AUX = [
  [128.5, -221.5],
  [94.203, -93.5],
  [0.5, 0.203],
  [0.5, 0.203],
  [0.5, 0.203],
].map(f32);
// the ORDINARY case, which this must not move: one edge crossing the box once, one clipped run.
// COLLINEAR on purpose — the reference intersects every segment's half-plane, so a polyline that
// bends would be scored against the intersection of four DIFFERENT lines rather than against the
// line the chain's single clipped run models.
const PLAIN = [
  [-4.0, -0.2],
  [4.0, 0.3],
  [12.0, 0.8],
  [20.0, 1.3],
  [28.0, 1.8],
].map(f32);

const named = [
  ['rect corner, own chain', RECT, 2, exactLeftArea(RECT), 0.44735],
  ['12-gon vertex, own chain', GON_OWN, 2, exactLeftArea(GON_OWN), null],
  ['plain edge across the box', PLAIN, 2, exactLeftArea(PLAIN), null],
];
for (const [name, P, fi, want] of named) {
  const got = chainBoxCov(P[0], P[1], P[2], P[3], P[4], fi);
  ok(
    Math.abs(got - want) <= 1 / 255,
    `${name}: ${got.toFixed(5)} against the exact ${want.toFixed(5)} (${(Math.abs(got - want) * 255).toFixed(2)}/255)`,
  );
}
{
  // The auxiliary chain's contract, stated in the kernel: forceInside = 1 means "I can only carve;
  // a box I miss is INSIDE". A touch is a miss.
  const got = chainBoxCov(GON_AUX[0], GON_AUX[1], GON_AUX[2], GON_AUX[3], GON_AUX[4], 1.0);
  ok(
    got === 1.0,
    `12-gon vertex, AUXILIARY chain: a zero-length touch is a miss, so 1.0 (${got.toFixed(5)})`,
  );
}

// ── the invariant, over a randomized battery of CLOSED CONVEX chains ──────────────────────────
// A closed convex quad is the one family whose truth is known exactly AND that a four-segment
// chain can carry whole, so the kernel has no modelling error to hide behind.
function battery() {
  let rnd = 20260920;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff;
  };
  const out = [];
  while (out.length < 4000) {
    const cx = (rand() - 0.5) * 3,
      cy = (rand() - 0.5) * 3;
    const rx = 0.2 + rand() * 6,
      ry = 0.2 + rand() * 6,
      rot = rand() * 6.283;
    const pts = [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * 6.283 + rand() * 1.2;
      const x = rx * Math.cos(a),
        y = ry * Math.sin(a);
      return f32([
        cx + x * Math.cos(rot) - y * Math.sin(rot),
        cy + x * Math.sin(rot) + y * Math.cos(rot),
      ]);
    });
    pts.push(pts[0]);
    const want = exactLeftArea(pts);
    if (want <= 1e-6 || want >= 1 - 1e-6) continue; // only boundary boxes: the interesting set
    out.push({ pts, want });
  }
  return out;
}
const CASES = battery();
const score = (fn) => {
  let worst = 0,
    bad = 0;
  for (const c of CASES) {
    const d = Math.abs(fn(c.pts) - c.want);
    if (d > worst) worst = d;
    if (d > 4 / 255) bad++;
  }
  return { worst, bad };
};
const twin = (p) => chainBoxCov(p[0], p[1], p[2], p[3], p[4], 2.0);
{
  const s = score(twin);
  ok(
    s.bad === 0,
    `${CASES.length} closed convex chains: none off the exact area by more than 4/255 (${s.bad})`,
  );
  ok(s.worst <= 2 / 255, `...worst ${(s.worst * 255).toFixed(2)}/255 over the same set`);
}

// ── the SHIPPED SHADER TEXT, in float32 ───────────────────────────────────────────────────────
if (!hasCxx()) {
  console.log('  SKIP the shipped-shader comparison: no C++ compiler ($CXX, clang++, g++, c++)');
} else {
  const emu = buildGlslEmu(ROOT, { chainCov: true });
  const EMPTY = new Float32Array(4);
  const qs = [],
    want = [];
  for (const [, P, fi, w] of named) {
    qs.push({
      k: K_CHAIN_COV,
      GD: [fi, 0, 0, 0],
      bb: [P[0][0], P[0][1], P[1][0], P[1][1]],
      eo: false,
      c: P[2],
      ePx: P[3],
      x: P[4],
    });
    want.push(w);
  }
  qs.push({
    k: K_CHAIN_COV,
    GD: [1, 0, 0, 0],
    bb: [GON_AUX[0][0], GON_AUX[0][1], GON_AUX[1][0], GON_AUX[1][1]],
    eo: false,
    c: GON_AUX[2],
    ePx: GON_AUX[3],
    x: GON_AUX[4],
  });
  want.push(1.0);
  const nNamed = qs.length;
  for (const c of CASES) {
    const P = c.pts;
    qs.push({
      k: K_CHAIN_COV,
      GD: [2, 0, 0, 0],
      bb: [P[0][0], P[0][1], P[1][0], P[1][1]],
      eo: false,
      c: P[2],
      ePx: P[3],
      x: P[4],
    });
    want.push(c.want);
  }
  const got = emu.run(EMPTY, EMPTY, qs);
  let wNamed = 0,
    wRand = 0,
    badRand = 0;
  for (let i = 0; i < qs.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    if (i < nNamed) wNamed = Math.max(wNamed, d);
    else {
      wRand = Math.max(wRand, d);
      if (d > 4 / 255) badRand++;
    }
  }
  ok(
    wNamed <= 1 / 255,
    `the shipped shader agrees with the exact area on all ${nNamed} named cases (worst ${(wNamed * 255).toFixed(2)}/255)`,
  );
  ok(
    badRand === 0,
    `...and on all ${CASES.length} random convex chains (${badRand} past 4/255, worst ${(wRand * 255).toFixed(2)}/255)`,
  );
  // ...and the twin is the same function, not merely a function that agrees on the answer.
  let wTwin = 0;
  for (let i = nNamed; i < qs.length; i++)
    wTwin = Math.max(wTwin, Math.abs(got[i] - twin(CASES[i - nNamed].pts)));
  ok(
    wTwin <= 2e-3,
    `the CPU twin tracks the shipped shader (max ${(wTwin * 255).toFixed(3)}/255; float32 against float64)`,
  );
}

// ── MUTATION CHECK: every assertion above must fail on the single-polyline closure ────────────────────
// `__LB_CHAIN_OLD_CLOSE` is the twin's hatch for the single-polyline closure: one polyline, one
// border walk at the wrap, zero-length runs kept, no ring join.
{
  const old = (p, fi) =>
    withOld(() => chainBoxCov(p[0], p[1], p[2], p[3], p[4], fi === undefined ? 2.0 : fi));
  const oRect = old(RECT);
  ok(
    Math.abs(oRect - 0.44735) <= 1e-4,
    `single-polyline closure: the rect corner reads ${oRect.toFixed(5)} against the exact ${exactLeftArea(RECT).toFixed(5)} ` +
      `— exactly half, ${(Math.abs(oRect - exactLeftArea(RECT)) * 255).toFixed(1)}/255`,
  );
  const oAux = old(GON_AUX, 1.0);
  ok(
    oAux === 0.0,
    `single-polyline closure: the 12-gon's auxiliary chain reads ${oAux.toFixed(5)} — a hole through the caller's min()`,
  );
  const sOld = withOld(() => score(twin));
  ok(
    sOld.bad > 50,
    `single-polyline closure: ${sOld.bad} of ${CASES.length} random convex chains are off by more than 4/255 (worst ${(sOld.worst * 255).toFixed(1)}/255)`,
  );
  // the ORDINARY case is untouched: these rules reach multi-run and ring chains and nothing else.
  const walk = (p) => withWalk(() => twin(p));
  ok(
    old(PLAIN) === walk(PLAIN),
    'a plain single-run chain is BIT-IDENTICAL under either closure — the ordinary case does not move',
  );
  ok(
    Math.abs(walk(PLAIN) - twin(PLAIN)) <= 1e-12,
    `...and the border sums read it the same as the walk (${Math.abs(walk(PLAIN) - twin(PLAIN)).toExponential(1)})`,
  );
}

// ── A JOINT THE BOX MISSES IS THE SECTOR BETWEEN ITS TWO SEGMENTS ───────────────────────────────
// When a face's own chain misses the pixel box, chainMissCov answers from the NEAREST chain segment,
// modelled as its infinite LINE. Where that nearest point is an interior JOINT, one line is not the
// boundary: the fill beside a vertex is the sector between its two segments -- the INTERSECTION of
// their left half-planes at a convex (left) turn and their UNION at a reflex (right) one -- and each
// line's continuation past the vertex runs through the other side of it. A one-line model takes
// the whole far side of that continuation off a reflex joint: a star's core pixel two px below a
// reflex vertex would read 0.59 where the path covers it whole (a hole), and a frame's inner
// corner 0.21 where it covers 0.94.
//
// TRUTH, exactly: the box clipped by the two half-planes (convex), or area(H1) + area(H2) - area(both)
// (reflex). The battery holds joints within reach of the box (|V| < 1.35 cells) whose chain misses
// the box and whose nearest point to the pixel center is the vertex itself -- the case the rule is.
// Such a box touches neither segment, so it lies wholly on one side of the two and the truth is 0
// or 1; a one-line model returns the fraction of the box past ONE line's continuation instead.
function jointBattery() {
  // Math.imul: the float product in battery()'s generator passes 2^53 and cycles after ~11k draws,
  // which a rejection sampler can exhaust.
  let rnd = 20260922;
  const rand = () => {
    rnd = (Math.imul(rnd, 1103515245) + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff;
  };
  const segMissesBox = (A, B) => {
    // Liang-Barsky against [-0.5, 0.5]^2
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    let t0 = 0,
      t1 = 1;
    for (const [p, q] of [
      [-dx, A[0] + 0.5],
      [dx, 0.5 - A[0]],
      [-dy, A[1] + 0.5],
      [dy, 0.5 - A[1]],
    ]) {
      if (p === 0) {
        if (q < 0) return true;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return true;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return true;
        if (r < t1) t1 = r;
      }
    }
    return t0 > t1;
  };
  const clampT = (A, B) => {
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    return (-A[0] * dx - A[1] * dy) / (dx * dx + dy * dy);
  };
  const out = [];
  let convex = 0,
    reflex = 0;
  for (let tries = 0; out.length < 2000 && tries < 2e6; tries++) {
    const r = 0.72 + rand() * 0.63,
      a = rand() * 6.283;
    const V = [r * Math.cos(a), r * Math.sin(a)];
    const aA = rand() * 6.283,
      aB = rand() * 6.283,
      L = 20;
    const A = f32([V[0] + L * Math.cos(aA), V[1] + L * Math.sin(aA)]),
      B = f32([V[0] + L * Math.cos(aB), V[1] + L * Math.sin(aB)]);
    const Vf = f32(V);
    if (!segMissesBox(A, Vf) || !segMissesBox(Vf, B)) continue;
    if (clampT(A, Vf) < 1 || clampT(Vf, B) > 0) continue; // the nearest chain point is the vertex
    const turn = (Vf[0] - A[0]) * (B[1] - Vf[1]) - (Vf[1] - A[1]) * (B[0] - Vf[0]);
    if (Math.abs(turn) < 1e-3 * L * L) continue; // not a near-straight joint
    const h1 = exactLeftArea([A, Vf]),
      h2 = exactLeftArea([Vf, B]),
      h12 = exactLeftArea([A, Vf, B]);
    const want = turn > 0 ? h12 : h1 + h2 - h12;
    // A line that misses the box would make the case trivial for any model; keep the ones where at
    // least one of the two lines' continuations cuts the box, which is where a one-line model errs.
    const cuts = (h) => h > 1e-3 && h < 1 - 1e-3;
    if (!cuts(h1) && !cuts(h2)) continue;
    if (turn > 0) convex++;
    else reflex++;
    out.push({ pts: [A, Vf, B, B, B], want, reflex: turn < 0 });
  }
  return { cases: out, convex, reflex };
}
{
  const J = jointBattery();
  let worst = 0,
    bad = 0,
    badReflex = 0;
  for (const c of J.cases) {
    const d = Math.abs(chainBoxCov(c.pts[0], c.pts[1], c.pts[2], c.pts[3], c.pts[4], 2.0) - c.want);
    if (d > worst) worst = d;
    if (d > 1 / 255) {
      bad++;
      if (c.reflex) badReflex++;
    }
  }
  ok(
    bad === 0,
    `${J.cases.length} missed joints (${J.convex} convex, ${J.reflex} reflex): the twin is the exact sector on all of them ` +
      `(${bad} past 1/255, ${badReflex} of them reflex; worst ${(worst * 255).toFixed(2)}/255)`,
  );
  if (hasCxx()) {
    const emu = buildGlslEmu(ROOT, { chainCov: true });
    const EMPTY = new Float32Array(4);
    const qs = J.cases.map((c) => ({
      k: K_CHAIN_COV,
      GD: [2, 0, 0, 0],
      bb: [c.pts[0][0], c.pts[0][1], c.pts[1][0], c.pts[1][1]],
      eo: false,
      c: c.pts[2],
      ePx: c.pts[3],
      x: c.pts[4],
    }));
    const got = emu.run(EMPTY, EMPTY, qs);
    let wE = 0,
      bE = 0;
    for (let i = 0; i < qs.length; i++) {
      const d = Math.abs(got[i] - J.cases[i].want);
      if (d > wE) wE = d;
      if (d > 2 / 255) bE++;
    }
    ok(
      bE === 0,
      `...and so is the SHIPPED shader text in float32 (${bE} past 2/255, worst ${(wE * 255).toFixed(2)}/255)`,
    );
  }
}

// ── every CROSSING CHAIN IS exact ─────────────────────────────────────────────────
// TRUTH, exactly, for ANY chain that crosses the box and is simple with its end rays: the chain continued
// along its end segments and closed far away on its LEFT is a polygon, and the box clipped by it is its fill
// in the box (probes/lbAccuracy/_chainExact.mjs, which also says which random chains are cases).
//
// Two named cases, one per defect:
//   TWO_CORNERS cuts the box's bottom-left corner, goes round outside, and cuts its top-right corner, fill
//     toward each corner -- two triangles, of legs 1/4 by 1/4 and 1/2 by 1/4, 3/32 in all. Crossings
//     counterclockwise along the border: entry 1 (1/4), exit 2 (7/4), entry 2 (5/2), exit 1 (15/4), so
//     each run's exit is next met by its own entry, and a chain-order walk goes round the far side.
//   NEAR_TOP starts 1/2^14 below the top border and leaves straight up through it; its start ray runs back
//     down the box's middle, so the fill is the box's left half, 1/2. With a 1e-4 border tolerance the start
//     would not be continued, and the closure would read the sliver above it: nothing.
const TWO_CORNERS = [
  [0.25, -1.0],
  [-1.0, 0.25],
  [-1.0, 1.5],
  [-0.5, 0.75],
  [1.0, 0.0],
];
const NEAR_TOP = [
  [0.0, 0.5 - 2 ** -14],
  [0.0, 1.5],
  [-1.5, 2.0],
  [-2.5, 2.0],
  [-3.5, 1.5],
];
{
  for (const [name, P, want] of [
    ['two-corner chain', TWO_CORNERS, 3 / 32],
    ['near-top start', NEAR_TOP, 1 / 2],
  ]) {
    const exact = exactChainArea(P),
      got = twin(P),
      walked = withWalk(() => twin(P));
    ok(
      Math.abs(exact - want) <= 1e-12 && Math.abs(got - want) <= 1e-12,
      `${name}: the twin reads the exact ${want.toFixed(6)} (${got.toFixed(6)}; the reference ${exact.toFixed(6)})`,
    );
    ok(
      Math.abs(walked - want) > 0.25,
      `...where the closure as it stood read ${walked.toFixed(4)} (${(Math.abs(walked - want) * 255).toFixed(1)}/255) -- the assertion can fail`,
    );
  }
  const B = randomCrossingChains(60000, 0x2545f491, f32),
    nMulti = B.filter((c) => c.runs > 1).length;
  const judge = (fn) => {
    let worst = 0,
      worstMulti = 0,
      bad = 0;
    for (const c of B) {
      const d = Math.abs(fn(c.pts) - c.want);
      worst = Math.max(worst, d);
      if (c.runs > 1) worstMulti = Math.max(worstMulti, d);
      if (d > 1e-9) bad++;
    }
    return { worst, worstMulti, bad };
  };
  const sT = judge(twin);
  ok(
    B.length > 10000 && nMulti > 1000 && sT.bad === 0,
    `${B.length} random box-crossing chains (${nMulti} clipped as several runs): the twin is exact on all of them ` +
      `(worst ${(sT.worst * 255).toExponential(2)}/255, several-run worst ${(sT.worstMulti * 255).toExponential(2)}/255)`,
  );
  const sW = withWalk(() => judge(twin));
  ok(
    sW.bad > 1000 && sW.worstMulti > 0.9,
    `...where the closure as it stood read ${sW.bad} of them wrong (worst ${sW.worstMulti.toFixed(3)}) -- the assertion can fail`,
  );
  if (hasCxx()) {
    const emu = buildGlslEmu(ROOT, { chainCov: true });
    const EMPTY = new Float32Array(4);
    const all = [{ pts: TWO_CORNERS, want: 3 / 32 }, { pts: NEAR_TOP, want: 1 / 2 }, ...B];
    const qs = all.map((c) => ({
      k: K_CHAIN_COV,
      GD: [2, 0, 0, 0],
      bb: [c.pts[0][0], c.pts[0][1], c.pts[1][0], c.pts[1][1]],
      eo: false,
      c: c.pts[2],
      ePx: c.pts[3],
      x: c.pts[4],
    }));
    const got = emu.run(EMPTY, EMPTY, qs);
    let wE = 0,
      bE = 0;
    for (let i = 0; i < qs.length; i++) {
      const d = Math.abs(got[i] - all[i].want);
      if (d > wE) wE = d;
      if (d > 0.05 / 255) bE++;
    }
    ok(
      bE === 0,
      `...and the SHIPPED shader text in float32 agrees on both named chains and all ${B.length} ` +
        `(${bE} past 0.05/255, worst ${(wE * 255).toFixed(4)}/255)`,
    );
  }
}

console.log(fail ? `LB-CHAIN-PIECE-WALK FAIL (${fail})` : 'LB-CHAIN-PIECE-WALK OK');
process.exit(fail ? 1 : 0);
