// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchPerturbationSmoke -- CPatch's answer must not flip on a perturbation of the input below the plane's own resolution.
//
// A 64-petal cubic star (every petal a near-quadratic cubic, the cubicStar64 bench asset) is one complete native area paint
// when its contour closes exactly. Perturbing every coordinate by ~6e-8 relative -- the size of float32 rounding, applied in float64
// -- can make it fall to 150-170 decomposed cells and wrong-solid pixels on the GPU, for two reasons this smoke pins:
//   1. segSlice(seg, t, 1) must end exactly on the parent's own end point (`a + (b - a) * 1 != b`), or the pieces a cubic is cut into
//      at its inflections do not join the next curve bit-exactly, and the polynomial-paint certificate (exact joints) declines;
//   2. the closing `Z` of a not-bit-closed subpath is a stub line a few float32 ulps long, which puts the contour's first and last
//      curves within the certificate's separation resolution of each other.
// The petals, scales and perturbation sizes below are swept; every copy must take the same paint as the unperturbed star.
import assert from 'node:assert/strict';
import { mkCubic, mkLine } from '../src/primitives/seg.js';
import { segSlice } from '../src/geom/cpatchImplicit.js';
import { contoursToConverter, setCPatchPreSplit } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';

// 1. the slice ends are the parent's points, exactly
{
  const P = [
    [18.020634658870364, 97.33494790177554],
    [20.94, 94.81],
    [25.2, 91.14],
    [30.741201302805756, 86.22279660098347],
  ];
  for (const t of [0.1, 0.3, 0.77, 0.999]) {
    const s = segSlice({ t: 'cubic', P }, t, 1);
    assert.deepEqual(
      s.P[3],
      P[3],
      'slice end at t=1 is the parent end, bit for bit (t0=' + t + ')',
    );
    const r = segSlice({ t: 'cubic', P }, 0, t);
    assert.deepEqual(r.P[0], P[0], 'slice start at t=0 is the parent start');
  }
}

// 2. a handle the plane cannot resolve is a zero handle (tiger's corner cubics: `P2 = P3` exactly; a 6e-8 perturbation made 142 of them
//    1e-6 vectors of random direction, and one shape mispainted 1237 pixels at 128 px)
for (const scale of [2 ** -20, 1, 2 ** 20])
  for (const origin of [0, 300 * scale]) {
    const q = (x, y) => [x * scale + origin, y * scale + origin];
    for (const noise of [0, 1e-9, 1e-6, 3e-6]) {
      // the authored corner cubic has P2 == P3 and P1 == P0 exactly; the noise is the perturbed copy's
      const c = [
        [
          mkCubic(q(0, 0), q(noise, -noise), q(100 + noise * 3, noise), q(100, 0)),
          mkLine(q(100, 0), q(100, 80)),
          mkLine(q(100, 80), q(0, 0)),
        ],
      ];
      const P = contoursToConverter(c, null)[0].find((g) => g.t === 'cubic').P;
      assert.deepEqual(
        P[2],
        P[3],
        'a sub-plane end handle is a zero handle ' + JSON.stringify({ scale, origin, noise }),
      );
      assert.deepEqual(
        P[1],
        P[0],
        'a sub-plane first handle is a zero handle ' + JSON.stringify({ scale, origin, noise }),
      );
    }
    const real = [
      [
        mkCubic(q(0, 0), q(20, 0), q(100, 1), q(100, 0)),
        mkLine(q(100, 0), q(50, -60)),
        mkLine(q(50, -60), q(0, 0)),
      ],
    ];
    setCPatchPreSplit(1); // no inflection cut: the cubic comes back whole
    const R = contoursToConverter(real, null)[0].find((g) => g.t === 'cubic').P;
    setCPatchPreSplit('singular');
    assert.deepEqual(R[1], q(20, 0), 'a real handle is kept ' + JSON.stringify({ scale, origin }));
    assert.deepEqual(
      R[2],
      q(100, 1),
      'a real 1-unit handle is kept ' + JSON.stringify({ scale, origin }),
    );
  }

// 3. the star
const R = (v) => Math.round(v * 1e4) / 1e4; // authored to 4 decimals, like the asset
const petal = [
  [40, 0],
  [70.6954, 4.2591],
  [70.7725, 2.6908],
  [39.8074, 3.9207],
]; // relative to the center
function starPoints(scale, origin) {
  const pts = []; // 64 petals x 4 control points, closed by sharing
  for (let k = 0; k < 64; k++) {
    const a = (k * 2 * Math.PI) / 64,
      c = Math.cos(a),
      s = Math.sin(a);
    pts.push(
      petal.map(([x, y]) => [
        R(64 + x * c - y * s) * scale + origin,
        R(64 + x * s + y * c) * scale + origin,
      ]),
    );
  }
  for (let k = 0; k < 64; k++) pts[k][3] = pts[(k + 1) % 64][0]; // the end IS the next start
  return pts;
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
function contourOf(pts) {
  // the importer's form: cubics, then the closing Z line
  const segs = pts.map((p) => mkCubic(p[0], p[1], p[2], p[3]));
  const a = pts[0][0],
    z = pts[63][3];
  if (a[0] !== z[0] || a[1] !== z[1]) segs.push(mkLine(z, a));
  return [segs];
}
function paint(contours) {
  const cs = contoursToConverter(contours, null);
  const m = packCPatchShape(cs, 0, { evenOdd: false, pool: false });
  return m ? { cells: m.cells, area: !!m.hasCubicArea } : null;
}
let cases = 0;
for (const [scale, origin] of [
  [1, 0],
  [2 ** -20, 0],
  [2 ** 20, 0],
  [1, 1000],
]) {
  const base = paint(contourOf(starPoints(scale, origin)));
  assert(
    base && base.area && base.cells === 1,
    'the unperturbed star is one native area paint ' + JSON.stringify({ scale, origin, base }),
  );
  for (const rel of [1e-9, 1e-8, 6e-8, 1e-7, 1e-6])
    for (let seed = 1; seed <= 16; seed++) {
      const r = rng(seed * 7919 + 13);
      const pts = starPoints(scale, origin).map((p) =>
        p.map((q) => q.map((v) => v * (1 + rel * (2 * r() - 1)))),
      );
      // A path number is perturbed ONCE: a joint stays one value, as in the authored `d` (the importer reads one number for both
      // curves) -- except the closing point, which the path states a second time and which therefore comes apart from the start.
      for (let k = 0; k < 63; k++) pts[k][3] = pts[k + 1][0];
      const got = paint(contourOf(pts));
      assert(
        got && got.area && got.cells === 1,
        'perturbed star keeps the area paint ' + JSON.stringify({ scale, origin, rel, seed, got }),
      );
      cases++;
    }
}
console.log(
  'cpatchPerturbationSmoke PASS: ' +
    cases +
    " perturbed stars (relative 1e-9..1e-6, 4 scales/origins) all take the unperturbed star's one native area paint; slice ends exact",
);
