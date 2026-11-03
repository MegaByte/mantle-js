// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A planning floor cannot turn a rejected continuum certificate into a plan.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createBundle, createShapeMorph } from '../src/index.js';
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { headlessCPatchBundle } from '../src/renderer/cpatchBuild.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { _toCurvesPair, setCPatchMorphT } from '../src/renderer/cpatchMorphBuild.js';
import { certifyPolynomialMorph, nativePairIsExact } from '../src/core/polynomialMorph.js';
import {
  planMorph,
  applyLayout,
  certifyMorphClip,
  certifyMorphLeak,
} from '../src/renderer/cpatchMorphCert.js';
import { convertContour, morphTolPx } from '../src/renderer/cpatchConvert.js';
import { arcToRQuads } from '../src/geom/cpatchImplicit.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const svg = (r) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><path d="M${5.5 + r} 12.5 A${r} ${r} 0 0 1 ${5.5 - r} 12.5 A${r} ${r} 0 0 1 ${5.5 + r} 12.5Z"/></svg>`;
const a = headlessCPatchBundle(await importSvg(svg(0.125))),
  b = headlessCPatchBundle(await importSvg(svg(0.375)));
const r = a.curveRangesByShape[0],
  q = b.curveRangesByShape[0];
const { A, B } = _toCurvesPair(
  curveRangeToContours(a.curveFloats, r.begin, r.end, b.curveFloats)[0],
  curveRangeToContours(b.curveFloats, q.begin, q.end, a.curveFloats)[0],
);
function plan(A, B, extra = {}) {
  const tolPx = morphTolPx(A, B),
    report = {};
  const convert = (cs, o) =>
    convertContour(cs, {
      maxCurves: 8,
      tolPx,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: o.leakMargin,
    });
  return { p: planMorph(A, B, convert, { tolPx, report, ...extra }), report, tolPx };
}
// Acceptance by interior samples would return one forced:false span here although
// its leak certificate rejects it. Interior samples are valid; they are not a proof.
const floor = plan(A, B, { minStep: 1 });
assert.equal(floor.p, null);
assert.equal(floor.report.uncertified, true);
assert.equal(floor.report.converts, 1);
// Default planning must refuse the same unsupported imported family promptly,
// rather than walking 512 unproved spans until the time or segment cap.
const ordinary = plan(A, B);
assert.equal(ordinary.p, null);
assert.equal(ordinary.report.uncertified, true);
assert(ordinary.report.certCalls < 64);
assert(ordinary.report.converts < 8);
// The refusal is the proof, rather than either work limit, and no rejected interval is shipped.
assert.equal(ordinary.report.overTime, false);
assert.equal(ordinary.report.overBudget, false);
assert.equal(ordinary.report.forced, 0);
// A genuine continuum proof still produces a usable plan. Re-certify every
// interval independently in both directions, rather than checking only poses.
const circle = (rad) =>
  arcToRQuads({ cx: 0, cy: 0, rx: rad, ry: rad, phi: 0, theta_start: 0, theta_end: 2 * Math.PI });
const C = circle(0.125),
  D = circle(0.375),
  good = plan(C, D);
assert(good.p?.length);
const at = (t) =>
  C.map((c, i) => ({ ...c, P: c.P.map((p, j) => p.map((v, k) => v + (D[i].P[j][k] - v) * t)) }));
for (const s of good.p) {
  assert.equal(s.forced, false);
  const lo = applyLayout(s.layout, at(s.t0)),
    hi = applyLayout(s.layout, at(s.t1));
  for (let i = 0; i < lo.length; i++) {
    const clip = certifyMorphClip(lo[i], hi[i], { tolPx: good.tolPx }),
      leak = certifyMorphLeak(lo[i], hi[i], { tolPx: good.tolPx });
    assert.equal(clip.failures.length, 0);
    assert.equal(clip.inconclusive, 0);
    assert.equal(leak.failures.length, 0);
  }
}
console.log(
  'cpatchMorphCertificationSmoke PASS ' +
    JSON.stringify({ floor: floor.report, ordinary: ordinary.report, certified: good.p.length }),
);

// Native preparation preserves source controls and one layout over the interval.
const line = (P) => ({ t: 'line', P });
const triangle = [
  [
    [0, 0],
    [1, 0],
  ],
  [
    [1, 0],
    [0, 1],
  ],
  [
    [0, 1],
    [0, 0],
  ],
].map(line);
const destination = [
  [
    [0, 0],
    [2, 0],
  ],
  [
    [2, 0],
    [0, 2],
  ],
  [
    [0, 2],
    [0, 0],
  ],
].map(line);
const native = certifyPolynomialMorph(triangle, destination);
assert(native);
assert.equal(native.certificate.maxDepth, 0);
assert.deepEqual(native.frame, [0, 0]);
assert.deepEqual(native.bounds, [0, 0, 2, 2]);
const flipped = [
  [
    [0, 0],
    [0, 1],
  ],
  [
    [0, 1],
    [1, 0],
  ],
  [
    [1, 0],
    [0, 0],
  ],
].map(line);
assert.equal(certifyPolynomialMorph(triangle, flipped), null, 'a collapsing interval must decline');
const gapped = triangle.map((c) => ({ ...c, P: c.P.map((p) => p.slice()) }));
gapped[1].P[0][0] += 2 ** -23;
assert.equal(certifyPolynomialMorph(gapped, gapped), null, 'native joins are exact');

// A cubic whose derivative cone needs a direction between its endpoint rays.
const mixedDirections = [
  {
    t: 'cubic',
    P: [
      [0, 0],
      [1, -4],
      [2, -8],
      [3, -4],
    ],
  },
  {
    t: 'line',
    P: [
      [3, -4],
      [6, 2],
    ],
  },
  {
    t: 'line',
    P: [
      [6, 2],
      [-3, 2],
    ],
  },
  {
    t: 'line',
    P: [
      [-3, 2],
      [0, 0],
    ],
  },
];
const mixedDestination = mixedDirections.map((c) => ({
  ...c,
  P: c.P.map(([x, y]) => [x * 1.25 + 2, y * 1.25 + 1]),
}));
assert(
  certifyPolynomialMorph(mixedDirections, mixedDestination),
  'mixed derivative directions retain whole-interval injectivity',
);
// Opposite sides overlap on both coordinate axes but separate diagonally.
const diagonalPoints = [
  [0, 0],
  [10, 10],
  [9, 11],
  [-1, 1],
];
const diagonal = diagonalPoints.map((p, i) => ({ t: 'line', P: [p, diagonalPoints[(i + 1) % 4]] }));
assert(
  certifyPolynomialMorph(diagonal, diagonal),
  'non-cardinal hull separation remains available',
);

const plane = Float32Array.of(
  8,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
);
assert(nativePairIsExact(plane, plane, { begin: 0, end: 36 }, { A: triangle, B: triangle }));
const changed = plane.slice();
changed[16] = Math.fround(1 + 2 ** -23);
const decoded = _toCurvesPair(
  curveRangeToContours(changed, 0, 36)[0],
  curveRangeToContours(plane, 0, 36)[0],
);
assert(certifyPolynomialMorph(decoded.A, decoded.B), 'decoder closes this join');
assert(
  !nativePairIsExact(changed, plane, { begin: 0, end: 36 }, decoded),
  'normalized controls are not native',
);
const morph = {
  shapes: [
    {
      A: triangle,
      B: destination,
      plan: [{ t0: 0, t1: 1, nativeArea: native }],
      seg: -1,
      planBase: -1,
      pack: null,
    },
  ],
};
setCPatchMorphT(morph, 0, 17);
const start = morph.shapes[0].pack;
setCPatchMorphT(morph, 0.5, 17);
const middle = morph.shapes[0].pack;
assert.equal(middle, start, 'CPU poses reuse buffers');
assert(middle.cpatchAreaOnly);
assert.equal(middle.texels[22], 1.5);
assert.equal(middle.vertexCount, 6);
setCPatchMorphT(morph, 1, 17, {}, true);
assert.notEqual(morph.shapes[0].pack.texels, middle.texels, 'blend samples coexist');
console.log('cpatchMorphCertificationSmoke native PASS');

// Chord admission requires the actual endpoint interpolation plane and a common
// zero radius; zero at each endpoint alone does not prove a flat interval.
const flat = new Float32Array(44);
flat.set(plane.subarray(0, 24));
flat[24] = 3;
flat.set([0, 1, 0, 0], 28);
const ep = flat.slice();
ep[32] = 1;
ep[33] = 0;
const flatRange = { begin: 0, end: 44 },
  flatPair = { A: triangle, B: triangle },
  arcPlanes = { A: ep, B: ep, offsets: Int32Array.of(24) };
assert(!nativePairIsExact(flat, flat, flatRange, flatPair));
assert(nativePairIsExact(flat, flat, flatRange, flatPair, arcPlanes));
assert(
  !nativePairIsExact(flat, flat, flatRange, flatPair, { ...arcPlanes, offsets: new Int32Array() }),
);
const growing = ep.slice();
growing[33] = 1;
assert(!nativePairIsExact(flat, flat, flatRange, flatPair, { ...arcPlanes, B: growing }));
const crossed = ep.slice();
crossed[32] = 0;
crossed[33] = 1;
assert(!nativePairIsExact(flat, flat, flatRange, flatPair, { ...arcPlanes, B: crossed }));
const movedEndpoint = ep.slice();
movedEndpoint[28] = 2 ** -23;
assert(!nativePairIsExact(flat, flat, flatRange, flatPair, { ...arcPlanes, A: movedEndpoint }));
console.log('cpatchMorphCertificationSmoke chord-plane guards PASS');

// Imported rects begin implicitly; inspect the actual morph request range.
const rectSvg = (x) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="${x}" y="8" width="24" height="48"/></svg>`;
const { gl: rectGl } = makeFakeWebgl2();
const rectA = createBundle(rectGl, await importSvg(rectSvg(8), { preserveViewport: true }));
const rectB = createBundle(rectGl, await importSvg(rectSvg(24), { preserveViewport: true }));
const rectMorph = createShapeMorph(rectGl, rectA, rectB),
  rectMs = rectMorph.bundle._morphSrc;
try {
  const range = rectMs.curveRanges[0],
    rawA = rectMs.mergedCurveF32,
    rawB = rectMs.dstCurveF32;
  assert.equal(rawA[range.begin] & 8, 0, 'rectangle request starts without an explicit move flag');
  const ca = curveRangeToContours(rawA, range.begin, range.end, rawB),
    cb = curveRangeToContours(rawB, range.begin, range.end, rawA);
  assert.equal(ca.length, 1);
  assert.equal(cb.length, 1);
  const pair = _toCurvesPair(ca[0], cb[0]);
  assert(certifyPolynomialMorph(pair.A, pair.B));
  assert(
    nativePairIsExact(rawA, rawB, range, pair),
    'implicit rectangle start preserves exact wire controls',
  );
  const wire = rawA.slice(range.begin, range.end),
    moved = wire.slice();
  for (let at = 0; at < moved.length; at += 12) for (let k = 4; k < 8; k++) moved[at + k] += 128;
  const multi = new Float32Array(wire.length + moved.length);
  multi.set(wire);
  multi.set(moved, wire.length);
  assert.equal(
    curveRangeToContours(multi, 0, multi.length).length,
    2,
    'implicit disconnected contour is not one native boundary',
  );
  assert(
    !nativePairIsExact(multi, multi, { begin: 0, end: multi.length }, { A: pair.A, B: pair.A }),
    'extra implicit contour cannot disappear from the wire count',
  );
  multi[wire.length] |= 8;
  assert(
    !nativePairIsExact(multi, multi, { begin: 0, end: multi.length }, { A: pair.A, B: pair.A }),
    'subsequent explicit contour remains separate',
  );
  const extraMove = new Float32Array(wire.length + 12);
  extraMove.set(wire);
  extraMove[wire.length] = 8;
  extraMove.set([128, 128, 128, 128], wire.length + 4);
  assert(
    !nativePairIsExact(
      extraMove,
      extraMove,
      { begin: 0, end: extraMove.length },
      { A: pair.A, B: pair.A },
    ),
    'an extra moved degenerate contour is not admitted',
  );
} finally {
  rectMorph.dispose();
  rectA.dispose();
  rectB.dispose();
}
console.log('cpatchMorphCertificationSmoke implicit-start provenance PASS');
