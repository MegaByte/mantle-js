// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercise the retained seam decomposition; complete-paint area is checked separately.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
// cpatchNestedHolesSmoke — a shape with many holes paints none of them.
//
// THE DEFECT FAMILY. Small nonzero holes inside a large contour (a corpus asset's shapes #155 and #70) can
// each be filled, painting ~100 px solid outside the fill. Three defects, one family -- a straight line the
// front end or the converter adds that does not partition the loop it splits:
//
//   (A) the front end's ring cuts (splitRing) and bridges (bridgeHoles) must be tested against every hole
//       still to come, not just the outer and the ONE hole being joined -- and on the curves, not a 12-point
//       flattening. A cut or bridge running through a later hole makes a cycle that crosses itself; a lobe of
//       it winds the wrong way and the converter, which takes a cycle as simple, paints the hole under it
//       (#70). So the test is exact (the line's roots along each curve) and against every hole left, and a
//       hole walled in by the others waits for a round in which it has a clear line (#6 has one only after
//       its neighbour joins).
//   (B) a BRIDGED loop is not simple: it passes through the bridge's two ends twice, a hole hanging at one.
//       earCut's chord from that pinch can close an ear around the hole -- the chord crosses nothing and both
//       pieces come back wound like their parent overall, one with a negative lobe where the hole is -- and
//       the hole paints solid (#155 through the pinched-loop split: 5,064 px at 512 px). So a split of a pinched loop
//       is refused when a vertex of one piece lies inside another (piecesOverlap).
//   (C) the same for a LINE cut of a pinched loop: a line through a bridge crosses its two coincident sides at
//       one point, and the tie in the crossing sort decides which chains close together (#70's bridged loop:
//       53 grid samples painted outside it).
//
// PINNED against the shape's own fill (row spans, exact in x) and the patches' own membership test (inPatch),
// no GPU: 40 random blobs with 3-14 reversed discs, packed as the renderer packs them (0 of 40 spill; 20 of
// 40 without the rules); a hand-built pinched loop whose first ear holds its hole (the hole center in 0
// patches; 3 without); and 60 random bridged loops cut by 60 lines each through a bridge (0 of 3,600 splits
// overlap; 198 without).
import {
  insideRule,
  insideContour,
  inPatch,
  earCut,
  convertContour,
  cutPatchByLine,
} from '../src/renderer/cpatchConvert.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { bridgeHoles } from '../src/geom/cpatchGraph.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
let seed = 1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const K = 0.5522847498;
/// A disc (or an axis-squashed one) as four cubics, wound clockwise when `rev` -- a nonzero hole in a CCW outer.
const disc = (cx, cy, r, rev = true, sq = 1) => {
  const p = [
      [cx + r, cy],
      [cx, cy + r * sq],
      [cx - r, cy],
      [cx, cy - r * sq],
    ],
    s = [];
  for (let i = 0; i < 4; i++) {
    const a = p[i],
      b = p[(i + 1) % 4],
      ta = [-(a[1] - cy) / sq, (a[0] - cx) * sq],
      tb = [-(b[1] - cy) / sq, (b[0] - cx) * sq];
    s.push({
      t: 'cubic',
      P: [a, [a[0] + K * ta[0], a[1] + K * ta[1]], [b[0] - K * tb[0], b[1] - K * tb[1]], b],
    });
  }
  return rev ? s.reverse().map((q) => ({ t: 'cubic', P: q.P.slice().reverse() })) : s;
};
const blob = (R, n) => {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI,
      rr = R * (0.8 + 0.4 * rnd());
    ring.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return ring.map((a, i) => ({ t: 'line', P: [a, ring[(i + 1) % n]] }));
};

console.log('-- A. many nonzero holes, packed as the renderer packs them --');
{
  let spilled = 0,
    packed = 0,
    worst = 0;
  for (let s = 1; s <= 40; s++) {
    seed = s * 7919;
    const outer = blob(100, 6 + Math.floor(rnd() * 6)),
      holes = [],
      want = 3 + Math.floor(rnd() * 12);
    for (let t = 0; holes.length < want && t < 400; t++) {
      const r = 3 + rnd() * 10,
        x = (rnd() * 2 - 1) * 70,
        y = (rnd() * 2 - 1) * 70,
        sq = 0.3 + rnd() * 2.5;
      if (Math.hypot(x, y) + r * Math.max(1, sq) > 75) continue;
      if (
        holes.some(
          (h) => Math.hypot(h.x - x, h.y - y) < h.r * Math.max(1, h.sq) + r * Math.max(1, sq) + 1,
        )
      )
        continue;
      holes.push({ x, y, r, sq });
    }
    const list = [outer, ...holes.map((h) => disc(h.x, h.y, h.r, true, h.sq))];
    const seen = [];
    if (
      packCPatchShape(list, 0, {
        onPatches: (ps) => {
          for (const p of ps) seen.push(p);
        },
      })
    )
      packed++;
    const all = [];
    for (const c of list) for (const g of c) all.push(g);
    let n = 0;
    for (let j = 0; j < 120; j++)
      for (let i = 0; i < 120; i++) {
        const x = -120 + 2 * (i + 0.5),
          y = -120 + 2 * (j + 0.5);
        if (!insideRule(all, x, y, false) && seen.some((p) => inPatch(p, x, y))) n++;
      }
    if (n) {
      spilled++;
      worst = Math.max(worst, n);
    }
  }
  ok(packed === 40, `every shape packs (${packed} of 40)`);
  ok(
    spilled === 0,
    `no shape's patches admit a point its fill leaves empty (${spilled} of 40 do, worst ${worst} of 14,400 samples)`,
  );
}

console.log("-- B. an ear from a bridged loop's pinch --");
{
  // A square with a diamond hole bridged to the bottom edge at A. The ear run that starts on the bridge back
  // (A -> P) and ends at B closes on the chord B -> A, which crosses nothing and passes the hole on its far side.
  const L = (a, b, cut) => ({ t: 'line', P: [a, b], ...(cut ? { cut: true } : {}) });
  const A = [50, 40],
    P = [50, 0],
    B = [0, 58.2];
  const loop = [
    L(A, P, true),
    L(P, [100, 0]),
    L([100, 0], [100, 100]),
    L([100, 100], [0, 100]),
    L([0, 100], B),
    L(B, [0, 0]),
    L([0, 0], P),
    L(P, A, true),
    L(A, [40, 50]),
    L([40, 50], [50, 60]),
    L([50, 60], [60, 50]),
    L([60, 50], A),
  ];
  const ec = earCut(loop, 6);
  ok(!!ec, 'the loop has an ear');
  ok(
    ec && ec.every((pc) => !insideContour(pc, 50, 50)),
    `no piece holds the hole's center (pick ${ec && JSON.stringify(ec.pick)})`,
  );
  const r = convertContour(loop, { maxCurves: 6 });
  const bad =
    r && r.patches ? r.patches.filter((p) => inPatch(p, 50, 50) || inPatch(p, 45, 52)).length : -1;
  ok(bad === 0, `the conversion admits no point of the hole (${bad} patches do)`);
}

console.log('-- C. line cuts through a bridge --');
{
  const key = (p) => p[0] + ',' + p[1];
  const overlap = (pcs) => {
    for (let a = 0; a < pcs.length; a++) {
      const ks = new Set(pcs[a].map((s) => key(s.P[0])));
      for (let b = 0; b < pcs.length; b++) {
        if (a === b) continue;
        for (const s of pcs[b]) {
          const p = s.P[0];
          if (!ks.has(key(p)) && insideContour(pcs[a], p[0], p[1])) return true;
        }
      }
    }
    return false;
  };
  let cuts = 0,
    bad = 0,
    loops = 0;
  for (let s = 1; s <= 60; s++) {
    seed = s * 104729;
    const outer = blob(100, 5 + Math.floor(rnd() * 4)),
      holes = [],
      k = 1 + Math.floor(rnd() * 3);
    for (let t = 0; holes.length < k && t < 100; t++) {
      const r = 5 + rnd() * 15,
        x = (rnd() * 2 - 1) * 50,
        y = (rnd() * 2 - 1) * 50;
      if (holes.some((h) => Math.hypot(h[0] - x, h[1] - y) < h[2] + r + 2)) continue;
      holes.push([x, y, r]);
    }
    const loop = bridgeHoles(
      outer,
      holes.map((h) => disc(...h)),
    );
    if (!loop) continue;
    loops++;
    const bridges = loop.filter((q) => q.cut);
    for (let n = 0; n < 60; n++) {
      const q = bridges[Math.floor(rnd() * bridges.length)],
        m = [(q.P[0][0] + q.P[1][0]) / 2, (q.P[0][1] + q.P[1][1]) / 2];
      const th = rnd() * Math.PI,
        h = [Math.sin(th), -Math.cos(th), 0];
      h[2] = -(h[0] * m[0] + h[1] * m[1]);
      const r = cutPatchByLine(loop, h, [0, 0]);
      cuts++;
      if (r && overlap([...r.keep, ...r.drop])) bad++;
    }
  }
  ok(loops > 50, `the holes bridge (${loops} of 60 loops)`);
  ok(
    bad === 0,
    `no line through a bridge splits the loop into overlapping pieces (${bad} of ${cuts} cuts do)`,
  );
}

console.log(fail ? `cpatchNestedHolesSmoke FAIL (${fail})` : 'cpatchNestedHolesSmoke PASS');
process.exit(fail ? 1 : 0);
