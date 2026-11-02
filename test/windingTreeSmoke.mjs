// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// windingTreeSmoke — the winding tree (windingTree.js) must agree exactly with the linear
// walks it accelerates, and actually accelerate them.
//
// (a) renderer segs (lbPartition's inkAt): treeWinding vs rayWinding, integer-equal on
//     thousands of probes over a segment-heavy multi-contour shape mixing LINE / QUAD /
//     RQUAD / CUBIC — including probes ON seam rows and far outside (container chords).
// (b) hit-test segs (pointInFill): tree vs linear pointInFill, boolean-equal for nonzero
//     AND even-odd, over all hit seg types incl. ARC records.
// (c) stroke pruning: treeCollectNear's survivor set must contain every segment whose true
//     distance is within the query radius (no false negatives — false positives are fine,
//     they only cost work).
// (d) the tree is a WIN: on the big shape, tree build + Q queries beats Q linear walks.
import { mkLine, mkQuad, mkCubic, mkRQuad } from '../src/primitives/seg.js';
import { rayWinding, buildSegWindingTree, treeWinding } from '../src/geom/lbContour.js';
import { pointInFill, buildFillTree, crossSeg } from '../src/hitTest/fillCoverage.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
// deterministic PRNG (mulberry32) — reproducible probes
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- (a) renderer segs: a 3-contour wavy blob (mixed types), ~400 segs ----
const segs = [];
const ring = (cx, cy, R, K, rev, mode) => {
  const P = (j) => {
    const a = (2 * Math.PI * (rev ? -j : j)) / K;
    const r = R * (1 + 0.18 * Math.sin(5 * a));
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const m = [(A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.2, (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.2];
    const pick = (j + mode) % 4;
    if (pick === 0) segs.push(mkLine(A, B));
    else if (pick === 1) segs.push(mkQuad(A, m, B));
    else if (pick === 2)
      segs.push(
        mkCubic(
          A,
          [A[0] * 0.7 + m[0] * 0.3, A[1] * 0.7 + m[1] * 0.3],
          [B[0] * 0.7 + m[0] * 0.3, B[1] * 0.7 + m[1] * 0.3],
          B,
        ),
      );
    else segs.push(mkRQuad(A, m, B, 0.8));
  }
};
ring(100, 100, 80, 160, false, 0);
ring(100, 100, 40, 128, true, 1);
ring(230, 100, 25, 120, false, 2);
const tree = buildSegWindingTree(segs);
check(!!tree, `renderer tree built over ${segs.length} segs`);
let agree = 0,
  total = 0,
  seamProbes = 0;
for (let q = 0; q < 4000; q++) {
  const x = rnd() * 320 - 20,
    y = rnd() * 240 - 20;
  const a = rayWinding(segs, x, y + 1e-4);
  const b = treeWinding(tree, x, y + 1e-4);
  total++;
  if (a === b) agree++;
}
// seam rows: probe exactly at segment endpoints' y (the tie-handling stress)
for (let k = 0; k < 400; k++) {
  const s = segs[(k * 7) % segs.length];
  const x = rnd() * 320 - 20,
    y = s.p1[1];
  const a = rayWinding(segs, x, y + 1e-4);
  const b = treeWinding(tree, x, y + 1e-4);
  total++;
  seamProbes++;
  if (a === b) agree++;
}
check(
  agree === total,
  `treeWinding == rayWinding on ${total} probes (${seamProbes} on seam rows): ${agree}/${total}`,
);

// ---- (b) hit-test segs incl. ARCs ----
const hsegs = [];
const hring = (cx, cy, R, K) => {
  for (let j = 0; j < K; j++) {
    const a0 = (2 * Math.PI * j) / K,
      a1 = (2 * Math.PI * (j + 1)) / K;
    const A = [cx + R * Math.cos(a0), cy + R * Math.sin(a0)];
    const B = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
    if (j % 3 === 0)
      hsegs.push({
        t: 3,
        cx,
        cy,
        rx: R,
        ry: R,
        th0: a0,
        th1: a1,
        cp: 1,
        sp: 0,
        x0: A[0],
        y0: A[1],
        x1: B[0],
        y1: B[1],
      });
    else if (j % 3 === 1)
      hsegs.push({
        t: 1,
        x0: A[0],
        y0: A[1],
        cx: (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.15,
        cy: (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.15,
        x1: B[0],
        y1: B[1],
      });
    else hsegs.push({ t: 0, x0: A[0], y0: A[1], x1: B[0], y1: B[1] });
  }
};
hring(100, 100, 70, 60);
hring(100, 100, 35, 60); // same wind: even-odd sees a hole, nonzero does not
const htree = buildFillTree(hsegs);
check(!!htree, `hit-test tree built over ${hsegs.length} segs (line/quad/arc)`);
let hAgree = 0,
  hTotal = 0;
for (let q = 0; q < 3000; q++) {
  const x = rnd() * 240 - 20,
    y = rnd() * 240 - 20;
  for (const eo of [false, true]) {
    const a = pointInFill(hsegs, x, y, eo);
    const b = pointInFill(hsegs, x, y, eo, htree);
    hTotal++;
    if (a === b) hAgree++;
  }
}
check(hAgree === hTotal, `pointInFill tree == linear (nonzero + evenodd): ${hAgree}/${hTotal}`);

// ---- (c) stroke pruning: no false negatives ----
const { treeCollectNear } = await import('../src/geom/windingTree.js');
const segDist = (s, x, y) => {
  // sampled true distance (test-grade)
  let best = 1e30;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    let p;
    if (s.t === 0) p = [s.x0 + t * (s.x1 - s.x0), s.y0 + t * (s.y1 - s.y0)];
    else if (s.t === 1) {
      const u = 1 - t;
      p = [
        u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1,
        u * u * s.y0 + 2 * u * t * s.cy + t * t * s.y1,
      ];
    } else {
      const th = s.th0 + t * (s.th1 - s.th0);
      p = [s.cx + s.rx * Math.cos(th), s.cy + s.ry * Math.sin(th)];
    }
    best = Math.min(best, Math.hypot(p[0] - x, p[1] - y));
  }
  return best;
};
let pruneOk = true;
for (let q = 0; q < 600 && pruneOk; q++) {
  const x = rnd() * 240 - 20,
    y = rnd() * 240 - 20,
    r = 2 + rnd() * 10;
  const near = new Set(treeCollectNear(htree, x, y, r, []));
  for (let i = 0; i < hsegs.length; i++) {
    if (segDist(hsegs[i], x, y) <= r && !near.has(i)) {
      pruneOk = false;
      console.log('   missed seg', i, 'at', x.toFixed(1), y.toFixed(1), 'r', r.toFixed(1));
      break;
    }
  }
}
check(pruneOk, 'treeCollectNear has no false negatives over 600 radius queries');

// ---- (d) the tree is a win on the big shape ----
const Q = 2000;
const pts = Array.from({ length: Q }, () => [rnd() * 320 - 20, rnd() * 240 - 20]);
const t0 = performance.now();
for (const [x, y] of pts) rayWinding(segs, x, y + 1e-4);
const tLin = performance.now() - t0;
const t1 = performance.now();
const tree2 = buildSegWindingTree(segs);
for (const [x, y] of pts) treeWinding(tree2, x, y + 1e-4);
const tTree = performance.now() - t1;
check(
  tTree < tLin,
  `tree (build + ${Q} queries) beats linear: ${tTree.toFixed(1)}ms vs ${tLin.toFixed(1)}ms (${(tLin / tTree).toFixed(1)}x)`,
);

if (fail) {
  console.error(`WINDING-TREE FAIL (${fail})`);
  process.exit(1);
}
console.log('WINDING-TREE PASS');
