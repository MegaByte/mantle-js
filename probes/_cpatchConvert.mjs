// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchConvert — does the converter turn arbitrary contours into VALID CPatches?
//
// probes/_cpatchProto.mjs shows the primitive (exact on valid patches) and the defect
// (extension: 0% error at N<=5 outward-bulging quads, 13.75% at N=16), and that no
// per-FRAGMENT repair can close it. probes/_cpatchCutter.mjs is the converter that answer
// implies. This probe is the audit of it, and it passes:
//
//   shape     uncut        converted
//   ngon8     48 px        0
//   ngon12    4500 px      0
//   ngon16    9012 px      0
//   ngon24    35.27%       0
//   star      -            0    (deeply concave, straight edges: the CUTTING, not extension)
//   serp/loop -            0    (a cubic inflection and an in-span double point)
//
// Ground truth is an exact even/odd ray crossing of the TRUE curves, so neither the converter
// nor the primitive is its own yardstick. Three harness traps are worth naming, because
// each one reports a converter defect that does not exist:
//
//   * a root landing exactly on a subdivision boundary can be pruned from both halves by a
//     "does the hull have both signs?" test — the symmetric lens loses two whole scanlines.
//   * a per-patch grid that samples x and y at the same fraction puts every sample of a triangle
//     whose edge runs corner-to-corner ON that edge: 16 of 256 "disagreements".
//   * a sample sitting exactly on a shared cut passes both patches' >= 0 test, and a
//     45-degree cut runs through whole diagonals of pixel centers — 54 px of "overlap" that
//     is ties, not area. Real overlap needs a margin; a renderer needs a half-open fill rule.
//
// The cost column counts implicits: a CPatch fragment pays N where a Loop-Blinn fragment
// pays 1 (and 0 in the interior). It is an ALU proxy, not a speed ranking; see
// probes/_cpatchRealCorpus.mjs and probes/_cpatchDrawSpeed.mjs.
import {
  convertContour,
  inPatch,
  inPatchBy,
  patchBBox,
  rowSpans,
  gridCheck,
  validatePatch,
} from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const N = 256;
const line = (a, b) => ({ t: 'line', P: [a, b] });
const quad = (a, m, b) => ({ t: 'quad', P: [a, m, b] });
const cubic = (a, c1, c2, b) => ({ t: 'cubic', P: [a, c1, c2, b] });

// Outward-bulging n-gon: the family that exposed the extension defect. `amt` is a fixed
// bulge, so as N rises the chords shorten and the parabolas curl harder — the error grew
// monotonically with N in the prototype.
const ngon = (n, amt = 16) => {
  const C = [128, 128],
    R = 90;
  const pt = (j) => [
    C[0] + R * Math.cos((2 * Math.PI * j) / n),
    C[1] + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C[0],
      oy = my - C[1];
    const L = Math.hypot(ox, oy) || 1;
    out.push(quad(a, [mx + (ox / L) * amt, my + (oy / L) * amt], b));
  }
  return out;
};

const bulgeTri = (amt2) => {
  const p0 = [128, 46],
    p1 = [206, 196],
    p2 = [50, 196];
  const C = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
  const q = (a, b, amt) => {
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C[0],
      oy = my - C[1];
    const L = Math.hypot(ox, oy) || 1;
    return quad(a, [mx + (ox / L) * amt, my + (oy / L) * amt], b);
  };
  return [q(p0, p1, 30), q(p1, p2, amt2), q(p2, p0, 30)];
};

const SHAPES = {
  lens: [
    cubic([60, 128], [90, 40], [166, 40], [196, 128]),
    cubic([196, 128], [166, 216], [90, 216], [60, 128]),
  ],
  arch: [cubic([50, 200], [50, 40], [206, 40], [206, 200]), line([206, 200], [50, 200])],
  tri: bulgeTri(30),
  concave: bulgeTri(-34),
  // A cubic S-curve boundary — an inflection inside a bounding curve, which splits the
  // implicit's sign and is the case klmn classification is most fragile on.
  serp: [
    cubic([50, 210], [230, 150], [30, 110], [206, 46]),
    line([206, 46], [206, 210]),
    line([206, 210], [50, 210]),
  ],
  // A cubic with an in-span double point: the loop the renderers decline on.
  loop: [cubic([70, 200], [280, 40], [10, 40], [190, 200]), line([190, 200], [70, 200])],
  // Deeply concave: a star, every other vertex pulled in. Straight edges, so any failure
  // here is the CUTTING, not the extension.
  star: (() => {
    const C = [128, 128],
      out = [],
      n = 10;
    const pt = (j) => [
      C[0] + (j % 2 ? 44 : 96) * Math.cos((2 * Math.PI * j) / n - Math.PI / 2),
      C[1] + (j % 2 ? 44 : 96) * Math.sin((2 * Math.PI * j) / n - Math.PI / 2),
    ];
    for (let j = 0; j < n; j++) out.push(line(pt(j), pt((j + 1) % n)));
    return out;
  })(),
  ...Object.fromEntries([3, 5, 8, 12, 16, 24].map((n) => ['ngon' + n, ngon(n)])),
};

/// Reference: exact even/odd ray crossing against the true curves, by dense chording.
function refMask(curves, n) {
  const m = new Uint8Array(n * n);
  const cross = (a, b, x, y) => {
    if (a[1] > y === b[1] > y) return 0;
    const xi = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    return xi > x ? (b[1] > a[1] ? 1 : -1) : 0;
  };
  const poly = curves.map((s) => {
    if (s.t === 'line') return s.P;
    const K = 1024,
      o = [];
    for (let i = 0; i <= K; i++) o.push(segPt(s, i / K));
    return o;
  });
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      let w = 0;
      for (const P of poly)
        for (let i = 0; i + 1 < P.length; i++) w += cross(P[i], P[i + 1], px, py);
      m[y * n + x] = w !== 0 ? 1 : 0;
    }
  return m;
}

console.log(
  'shape     curves  patches  cuts chord unres  maxN  impl/px   missing    extra   grid   time',
);
let anyFail = false;
for (const [name, curves] of Object.entries(SHAPES)) {
  const t0 = process.hrtime.bigint();
  const { patches, stats } = convertContour(curves, { maxCurves: 8, tolPx: 0.05 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ref = refMask(curves, N);
  let bad = 0,
    ink = 0,
    tests = 0,
    covered = 0,
    overlap = 0,
    missing = 0,
    extra = 0;
  const boxes = patches.map((p) => patchBBox(p.curves));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      let hit = 0;
      for (let k = 0; k < patches.length; k++) {
        const b = boxes[k];
        if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
        tests += patches[k].impls.length; // what a fragment in the box pays
        if (inPatch(patches[k], px, py)) hit++;
      }
      const r = ref[y * N + x];
      if (r) ink++;
      if (hit) covered++;
      // Count only overlap with AREA. A sample exactly on a shared cut passes both patches'
      // >= 0 test; on a 45-degree cut that is every pixel center along a diagonal.
      if (hit > 1) {
        let real = 0;
        for (let k = 0; k < patches.length; k++) if (inPatchBy(patches[k], px, py, 0.02)) real++;
        if (real > 1) overlap++;
      }
      if (r && !hit) missing++;
      if (!r && hit) extra++;
      if (hit > 0 !== (r === 1)) bad++;
    }
  let maxN = 0,
    gbad = 0;
  for (const p of patches) {
    maxN = Math.max(maxN, p.impls.length);
    gbad += gridCheck(p, 16).bad;
  }
  const pct = ((100 * bad) / (N * N)).toFixed(2);
  if (bad > N * N * 0.002) anyFail = true;
  console.log(
    `${name.padEnd(9)} ${String(curves.length).padStart(6)} ${String(patches.length).padStart(8)}` +
      ` ${String(stats.cuts).padStart(5)} ${String(stats.chordCuts).padStart(5)} ${String(stats.unresolved).padStart(5)}` +
      ` ${String(maxN).padStart(5)} ${(tests / Math.max(1, ink)).toFixed(2).padStart(8)}` +
      ` ${String(missing).padStart(8)} ${String(extra).padStart(8)} ${String(gbad).padStart(6)} ${ms.toFixed(1).padStart(7)}ms` +
      `  (${pct}%)` +
      (overlap ? `  overlap ${overlap}` : ''),
  );
}
console.log(
  anyFail
    ? '\nFAIL — the converter does not reproduce the region.'
    : '\nEvery contour converted to patches whose union is the region.',
);
