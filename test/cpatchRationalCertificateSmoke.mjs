// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A polynomial certificate must interpolate a polynomial, not projected points.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segPt, segSlice, segRev, arcToRQuads } from '../src/geom/cpatchImplicit.js';
import {
  _polyImplicit,
  planMorph,
  certifyMorphClip,
  certifyMorphLeak,
  extractLayout,
  applyLayout,
} from '../src/renderer/cpatchMorphCert.js';
import { convertContour, morphTolPx } from '../src/renderer/cpatchConvert.js';
const source = readFileSync(new URL('../src/renderer/cpatchMorphCert.js', import.meta.url), 'utf8');
const evaluate = (F, x, y) =>
  F.c.reduce((v, row, i) => v + row.reduce((s, k, j) => s + k * x ** i * y ** j, 0), 0);
const start = source.indexOf('function pointH('),
  end = source.indexOf('/// Values at the D+1 equally spaced');
// On a source without pointH, use the actual projected-point calculation. The negative
// control fails numerically, rather than because a helper is absent.
const along =
  start < 0
    ? (F, c, u) => evaluate(F, ...segPt(c, u))
    : new Function('segPt', 'evalPoly', source.slice(start, end) + '\nreturn evalAlong;')(
        segPt,
        evaluate,
      );
const interp = (vs, u) =>
  vs.reduce((sum, v, k) => {
    const n = vs.length - 1;
    let b = 1;
    for (let j = 0; j <= n; j++) if (j !== k) b *= (u - j / n) / (k / n - j / n);
    return sum + v * b;
  }, 0);
let samples = 0,
  fitWorst = 0,
  oldWorst = 0,
  identityWorst = 0,
  gradientWorst = 0;
for (const w of [-0.5, 0.1, 0.25, Math.SQRT1_2, 0.95, 1, 1.5])
  for (const F of [
    { deg: 1, c: [[0.2, 1], [-0.7]] },
    { deg: 2, c: [[0.2, 1, 0.7], [-0.7, 0.3], [1.4]] },
    { deg: 3, c: [[0.2, 1, 0.7, -0.2], [-0.7, 0.3, 0.4], [1.4, 0.1], [-0.5]] },
  ]) {
    const c = {
        t: 'rquad',
        w,
        P: [
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      degree = 2 * F.deg;
    const values = Array.from({ length: degree + 1 }, (_, k) => along(F, c, k / degree));
    const old = Array.from({ length: degree + 1 }, (_, k) => evaluate(F, ...segPt(c, k / degree)));
    const dx = {
      deg: Math.max(0, F.deg - 1),
      c: F.c.slice(1).map((r, i) => r.map((v) => v * (i + 1))),
    };
    for (let k = 0; k <= 256; k++) {
      const u = k / 256,
        p = segPt(c, u),
        W = (1 - u) ** 2 + 2 * w * u * (1 - u) + u * u,
        physical = evaluate(F, ...p),
        cleared = physical * W ** F.deg;
      fitWorst = Math.max(fitWorst, Math.abs(interp(values, u) - cleared));
      oldWorst = Math.max(oldWorst, Math.abs(interp(old, u) - physical));
      identityWorst = Math.max(identityWorst, Math.abs(along(F, c, u) - cleared));
      gradientWorst = Math.max(
        gradientWorst,
        Math.abs(along(dx, c, u, F.deg) - evaluate(dx, ...p) * W ** F.deg),
      );
      samples++;
    }
  }
assert(oldWorst > 0.01);
assert(fitWorst < 1e-10);
assert(identityWorst < 1e-11);
assert(gradientWorst < 1e-11);
// Resultants and substituted controls both move: the tensor-product degree in
// (s,t) must reconstruct off-lattice points, not just the fitted nodes.
let tensorWorst = 0,
  tensorSamples = 0;
for (const kind of ['line', 'quad', 'rquad', 'cubic'])
  for (const w of [0.25, Math.SQRT1_2, 1.5]) {
    const count = { line: 2, quad: 3, rquad: 3, cubic: 4 }[kind],
      P = [
        [-0.4, -0.7],
        [0.8, 0.2],
        [0.1, 0.95],
        [-0.6, 0.35],
      ].slice(0, count);
    const A = { t: kind, w: 0.75, P },
      B = { ...A, P: P.map((p, i) => [p[0] * 1.1 + 0.07 * i, p[1] * 0.9 - 0.03 * i]) };
    const implicit = (t) =>
      _polyImplicit({ ...A, P: A.P.map((p, i) => p.map((v, k) => v + (B.P[i][k] - v) * t)) });
    const walk = (t) => ({
      t: 'rquad',
      w,
      P: [
        [0.7 - 0.1 * t, -0.3],
        [0.4 + 0.2 * t, 0.8],
        [0.1, 0.4 - 0.2 * t],
      ],
    });
    const d = implicit(0).deg,
      ns = 2 * d,
      nt = 3 * d;
    const grid = Array.from({ length: nt + 1 }, (_, j) =>
      Array.from({ length: ns + 1 }, (_, i) => along(implicit(j / nt), walk(j / nt), i / ns)),
    );
    for (const t of [0.03125, 0.173, 0.421, 0.707, 0.96875])
      for (const u of [0.041, 0.237, 0.519, 0.813, 0.977]) {
        const F = implicit(t),
          c = walk(t),
          W = (1 - u) ** 2 + 2 * w * u * (1 - u) + u * u,
          expected = evaluate(F, ...segPt(c, u)) * W ** d;
        const got = interp(
          grid.map((row) => interp(row, u)),
          t,
        );
        const scale = Math.max(1, ...grid.flat().map(Math.abs));
        tensorWorst = Math.max(tensorWorst, Math.abs(got - expected) / scale);
        tensorSamples++;
      }
  }
assert(tensorWorst < 1e-10);
const circle = (r) =>
  arcToRQuads({ cx: 0, cy: 0, rx: r, ry: r, phi: 0, theta_start: 0, theta_end: 2 * Math.PI });
const A = circle(1),
  B = circle(1.5),
  tolPx = morphTolPx(A, B);
const convert = (cs, o) =>
  convertContour(cs, {
    maxCurves: 8,
    tolPx,
    noCurveCuts: true,
    forceBezout: true,
    leakMargin: o.leakMargin,
  });
const good = planMorph(A, B, convert, { tolPx });
assert(good?.length);
for (const s of good) {
  const at = (t) =>
    A.map((c, i) => ({ ...c, P: c.P.map((p, j) => p.map((v, k) => v + (B[i].P[j][k] - v) * t)) }));
  const lo = applyLayout(s.layout, at(s.t0)),
    hi = applyLayout(s.layout, at(s.t1));
  for (let i = 0; i < lo.length; i++) {
    assert(certifyMorphClip(lo[i], hi[i], { tolPx }).ok);
    assert(certifyMorphLeak(lo[i], hi[i], { tolPx }).ok);
  }
}
// The affine model has no proof for changing or unsafe primary weights. It
// must decline before conversion instead of silently using the source weight.
for (const w of [0.25, 0, -0.25, -1, NaN, Infinity]) {
  const C = B.map((c) => ({ ...c, w })),
    report = {};
  let converts = 0;
  assert.equal(
    planMorph(
      A,
      C,
      (...args) => {
        converts++;
        return convert(...args);
      },
      { tolPx, report },
    ),
    null,
  );
  assert.equal(converts, 0);
  assert.equal(report.unsupportedWeights, true);
  assert.equal(certifyMorphClip(A, C, { tolPx }).ok, false);
  assert.equal(certifyMorphLeak(A, C, { tolPx }).ok, false);
}

for (const w of [0, -0.25, -1, NaN, Infinity]) {
  const C = A.map((c) => ({ ...c, w })),
    D = B.map((c) => ({ ...c, w })),
    report = {};
  assert.equal(
    planMorph(
      C,
      D,
      () => {
        throw Error('Unsafe primary weights reached conversion');
      },
      { tolPx, report },
    ),
    null,
  );
  assert.equal(report.unsupportedWeights, true);
  assert.equal(certifyMorphClip(C, D, { tolPx }).ok, false);
  assert.equal(certifyMorphLeak(C, D, { tolPx }).ok, false);
}

// Canonical rational subdivision changes parameters. Source provenance must
// still reproduce every nested/reversed piece on the original curve.
let provenanceWorst = 0,
  inverseWorst = 0;
{
  const root = {
    t: 'rquad',
    P: [
      [0, 0],
      [50, 80],
      [100, 0],
    ],
    w: 0.5,
    _src: { k: 0, a: 0, b: 1 },
  };
  const sourceAt = (p, u) =>
    p.map ? (p.map[0] * u + p.map[1]) / (p.map[2] * u + p.map[3]) : p.a + (p.b - p.a) * u;
  for (const w of [0.2, 0.5, 0.8, 1, 1.5])
    for (const range of [
      [0.1, 0.6],
      [0.8, 0.2],
      [-0.1, 0.7],
    ]) {
      const original = { ...root, w },
        piece = segRev(segSlice(segSlice(original, ...range), 0.2, 0.8));
      for (let j = 0; j <= 20; j++) {
        const u = j / 20,
          a = segPt(piece, u),
          b = segPt(original, sourceAt(piece._src, u));
        provenanceWorst = Math.max(provenanceWorst, Math.hypot(a[0] - b[0], a[1] - b[1]));
        if (w === 1)
          assert(
            Math.abs(
              sourceAt(piece._src, u) - (range[0] + (range[1] - range[0]) * (0.8 - 0.6 * u)),
            ) < 1e-14,
          );
      }
      const extension = segSlice(piece, -0.25, 1.25),
        map = extension._src.map;
      for (let j = 0; j <= 20; j++) {
        const u = j / 20,
          s = sourceAt(extension._src, u);
        const recovered = (map[1] - map[3] * s) / (map[2] * s - map[0]);
        inverseWorst = Math.max(inverseWorst, Math.abs(u - recovered));
      }
    }
  assert(provenanceWorst < 1e-10);
  assert(inverseWorst < 1e-10);
  // A common projective scale has no geometric effect and must not overflow.
  const scaled = { ...root, _src: { k: 0, a: 0, b: 1, map: [1e300, 0, 0, 1e300] } };
  const nested = segSlice(segSlice(scaled, 0.1, 0.6), 0.2, 0.8);
  assert(nested._src.map.every(Number.isFinite));
  for (let j = 0; j <= 20; j++) {
    const u = j / 20,
      a = segPt(nested, u),
      b = segPt(root, sourceAt(nested._src, u));
    assert(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-10);
  }
  // Search may use extensions crossing source-parameter infinity. A layout
  // that stores only finite source endpoints cannot replay that branch.
  const extension = segSlice(segSlice(root, 0.1, 0.6), -50, 50),
    map = extension._src.map;
  assert(Math.sign(map[3]) !== Math.sign(map[2] + map[3]));
  const closing = { t: 'line', cut: true, P: [extension.P[2], extension.P[0]] };
  assert.equal(extractLayout([{ curves: [extension, closing] }], [root]), null);
  // Real conversion creates nested rational pieces. Replay at the same pose
  // must retain their control geometry, independently of patch validity.
  const K = 7,
    point = (j) => [
      100 + (j % 2 ? 14 : 50) * Math.cos((2 * Math.PI * j) / K),
      100 + (j % 2 ? 14 : 50) * Math.sin((2 * Math.PI * j) / K),
    ];
  const curves = Array.from({ length: K }, (_, j) => {
    const a = point(j),
      b = point((j + 1) % K);
    return {
      t: 'rquad',
      P: [a, [(a[0] + b[0]) / 2 + b[1] - a[1], (a[1] + b[1]) / 2 - b[0] + a[0]], b],
      w: 0.8,
    };
  });
  const converted = convertContour(curves, {
    maxCurves: 8,
    tolPx: 0.05,
    noCurveCuts: true,
    forceBezout: true,
  });
  const replayed = applyLayout(extractLayout(converted.patches, curves), curves);
  assert(replayed);
  assert.equal(replayed.length, converted.patches.length);
  for (let i = 0; i < converted.patches.length; i++)
    for (let j = 0; j < converted.patches[i].curves.length; j++) {
      const before = converted.patches[i].curves[j],
        after = replayed[i][j];
      if (before.t !== 'rquad') continue;
      for (let k = 0; k < before.P.length; k++)
        assert(Math.hypot(before.P[k][0] - after.P[k][0], before.P[k][1] - after.P[k][1]) < 1e-10);
    }
}

console.log(
  'cpatchRationalCertificateSmoke PASS ' +
    JSON.stringify({
      samples,
      fitWorst,
      oldWorst,
      identityWorst,
      gradientWorst,
      tensorSamples,
      tensorWorst,
      certifiedIntervals: good.length,
      provenanceWorst,
      inverseWorst,
    }),
);
