// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsGateWhySmoke -- the point route's decline REASON (debugStats.pointsGateWhy), a read-only benchmark aid.
//
// The gate returns false in eighteen places; without a reason, a benchmark that pinned the points route and read cover could not name the gate that
// refused it. The reason is written only under __MANTLE_DEBUG__ (one global read per ask, no other work) and never changes the answer. Pinned here:
//   (a) with the hook off the route answers as before and the field stays null;
//   (b) with it on, the same asks answer the same and each refusal names its gate (option off, no shaders, a bundle that is morphing);
//   (c) a successful ask clears it.
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const mk = (opts) => {
  const R = { gl: null, opts: opts || {}, _pendingShaders: [], _pendingPrograms: [] };
  attachAacPointsDraw(R);
  return R;
};
const bundle = { _morphSrc: {}, numShapes: 1 };

let R = mk({ aacPoints: false });
delete globalThis.__MANTLE_DEBUG__;
ok(
  R._aacPointsRoute(bundle, false) === false && !R._aacPointsWhy,
  '(a) hook off: the option-off ask declines and records nothing',
);
R = mk({});
ok(
  R._aacPointsRoute(bundle, false) === false && !R._aacPointsWhy,
  '(a) hook off: a shader-less renderer declines and records nothing',
);

globalThis.__MANTLE_DEBUG__ = true;
R = mk({ aacPoints: false });
ok(
  R._aacPointsRoute(bundle, false) === false && R._aacPointsWhy === 'option-off',
  `(b) hook on: option off names its gate (${R._aacPointsWhy})`,
);
R = mk({});
ok(
  R._aacPointsRoute(bundle, false) === false && R._aacPointsWhy === 'no-point-shaders',
  `(b) hook on: no point shaders names its gate (${R._aacPointsWhy})`,
);
R = mk({});
R.shaderSources = { aacPointsVert: 'v', aacPointsFrag: 'f' };
ok(
  R._aacPointsRoute(bundle, false) === false && /^bundle-state/.test(R._aacPointsWhy || ''),
  `(b) hook on: a morphing bundle names its gate (${R._aacPointsWhy})`,
);
R = mk({});
R._aacPointsWhy = 'stale';
R._aacPointsRoute(null, false);
ok(
  R._aacPointsWhy === 'no-bundle-or-context-lost',
  `(c) each ask overwrites the previous reason (${R._aacPointsWhy})`,
);
// (d) THE DRAW MODIFIERS: a colorMatrix is painted -- it passes the modifier gate and stops at a later one (this bundle has no cover quads) --
// while palette, channelLerp, the per-shape modifiers and a matrix that makes alpha out of nothing each name their own gate.
const plain = { numShapes: 1 };
const askWith = (draw) => {
  const Rd = mk({});
  Rd.shaderSources = { aacPointsVert: 'v', aacPointsFrag: 'f' };
  Rd._handle = {};
  Rd.draw = draw;
  Rd._aacPointsRoute(plain, false);
  return Rd._aacPointsWhy;
};
const fog = new Float32Array([0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 1]);
ok(
  askWith({ colorMatrix: fog, colorMatrixOffset: new Float32Array([0.5, 0.4, 0.2, 0]) }) ===
    'filter-graph-or-no-cover-quads',
  '(d) a diagonal fog colorMatrix passes the modifier gate',
);
ok(
  askWith({ colorMatrix: fog }) === 'filter-graph-or-no-cover-quads',
  '(d) a colorMatrix without an offset passes the modifier gate',
);
ok(
  askWith({ colorMatrixOffset: new Float32Array([0.1, 0, 0, 0]) }) ===
    'filter-graph-or-no-cover-quads',
  '(d) an offset without a matrix passes the modifier gate',
);
ok(askWith({ palette: {} }) === 'draw-modifier(palette)', '(d) palette names its own gate');
ok(
  askWith({ channelLerp: {} }) === 'draw-modifier(channelLerp)',
  '(d) channelLerp names its own gate',
);
ok(
  askWith({ overrides: {} }) === 'draw-modifier(overrides|extClip|shapeRange)',
  '(d) overrides name their gate',
);
ok(
  askWith({ shapeRange: [0, 1] }) === 'draw-modifier(overrides|extClip|shapeRange)',
  '(d) a sprite subset names its gate',
);
ok(
  askWith({ colorMatrix: new Float32Array([1, 0, 0, 0.3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }) ===
    'draw-modifier(colorMatrix-makes-alpha)',
  '(d) a matrix taking alpha from a color channel keeps the cover route',
);
ok(
  askWith({ colorMatrixOffset: new Float32Array([0, 0, 0, 0.1]) }) ===
    'draw-modifier(colorMatrix-makes-alpha)',
  '(d) an alpha offset keeps the cover route',
);
delete globalThis.__MANTLE_DEBUG__;
if (fail) {
  console.error(`aacPointsGateWhySmoke FAIL (${fail})`);
  process.exit(1);
}
console.log('aacPointsGateWhySmoke PASS');
