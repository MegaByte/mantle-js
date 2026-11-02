// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// apiArgumentContractSmoke — one rule for malformed arguments.
//
// CONFIGURATION scalars: NaN and non-numbers THROW, every other number CLAMPS to the documented range. ENUMS: a value outside
// the vocabulary THROWS before any state changes (null / undefined leaves an axis alone). DATA (colors, points, morph t): coerced.
//
//   setFillEngine({route:'bogus'}) must not pin lb silently, setLoopBlinnFill('bogus') does not mean 'off', 'LB' must not skip the cover pin
//   setFillPolicyOptions / setStrokeStrip / setResolutionScale / setViewport / setScissorRect / createImage / palette.set /
//          appendPoints validate what they are given
//   setT(NaN) does not store NaN, setT('0.5') does not store a string, a NaN key time does not make a NaN duration
//   importSvg('' | null | 5) does not throw an opaque TypeError inside the DOM parser; an all-culled document has a finite bbox
//
// CPU only: the real renderer on test/_fakeGl.mjs.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const throws = (fn, re, m) => {
  let e = null;
  try {
    fn();
  } catch (x) {
    e = x;
  }
  ok(
    e !== null && (!re || re.test(e.message)),
    `${m}${e ? ' — ' + e.message.slice(0, 90) : ' — did not throw'}`,
  );
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const eq = (a, b, m) =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const I = await import('../src/index.js');
const doc = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const mkR = async (width = 128, height = 128) => {
  const F = createFakeGl({ width, height });
  const R = I.createRenderer(F.gl, taggedShaderSources(), {});
  if (R.ready) await R.ready;
  return { F, R, gl: F.gl };
};

console.log('fill engine vocabulary');
{
  const { R } = await mkR();
  const snap = () => JSON.stringify(R.getFillEngine());
  const start = snap();
  for (const sel of [
    { route: 'bogus' },
    { route: 'LB' },
    { route: 'only' },
    { route: 'force' },
    { route: 5 },
    { kernel: 'bogus' },
    { kernel: 'AAC' },
    { primitives: 'maybe' },
    { commit: 'yes' },
    { cpatch: 1 },
    { route: 'lb', kernel: 'bogus' },
  ]) {
    throws(
      () => R.setFillEngine(sel),
      /setFillEngine: unknown/,
      `setFillEngine(${JSON.stringify(sel)}) throws`,
    );
    ok(snap() === start, `...and changes nothing`);
  }
  R.setFillEngine({ route: null, kernel: undefined });
  ok(snap() === start, 'null / undefined leave the axes alone');
  R.setFillEngine({ route: 'lb', kernel: 'hard-tree' });
  eq(
    [R.getFillEngine().route, R.getFillEngine().kernel],
    ['lb', 'hard-tree'],
    'a valid selection applies',
  );
  for (const route of ['none', 'cpatch', 'cpatch-auto', 'auto']) R.setFillEngine({ route });
  throws(
    () => R.setLoopBlinnFill('bogus'),
    /setLoopBlinnFill: unknown/,
    'setLoopBlinnFill("bogus") throws (it does not mean off)',
  );
  throws(() => R.setLoopBlinnFill(5), /setLoopBlinnFill: unknown/, 'setLoopBlinnFill(5) throws');
  throws(
    () => R.setLoopBlinnMorphFill('LB'),
    /setLoopBlinnFill: unknown/,
    'setLoopBlinnMorphFill forwards the same rule',
  );
  R.setLoopBlinnFill('on');
  eq(R.getFillEngine().route, 'lb', "'on' is lb");
  R.setLoopBlinnFill(true);
  eq(R.getFillEngine().route, 'lb', 'true is lb');
  R.setLoopBlinnFill(false);
  eq(R.getFillEngine().route, 'none', 'false is none');
  R.setLoopBlinnFill('only');
  eq(R.getFillEngine().route, 'only', "'only' is only");
  R.setLoopBlinnFill('auto');
  R.setLoopBlinnFill();
  eq(R.getFillEngine().route, 'none', 'no argument is off');
  R.dispose();
}

console.log('configuration scalars');
{
  const { R, F } = await mkR();
  // setFillPolicyOptions
  const before = JSON.stringify(R.getFillPolicyOptions());
  for (const patch of [
    { aacPointsExtMax: NaN },
    { aacPointsExtMax: '30' },
    { lbMinExtentPx: {} },
    { aacPointsRowGate: 'yes' },
    { aacPointsBucket: 1 },
    { lbMinExtentShare: 0.2, aacPointsBase: NaN },
  ]) {
    throws(
      () => R.setFillPolicyOptions(patch),
      /setFillPolicyOptions/,
      `setFillPolicyOptions(${JSON.stringify(patch)}) throws`,
    );
    ok(JSON.stringify(R.getFillPolicyOptions()) === before, '...and applies none of the patch');
  }
  eq(
    R.setFillPolicyOptions({ aacPointsExtMax: -5 }).aacPointsExtMax,
    0,
    'a negative number clamps to 0',
  );
  eq(
    R.setFillPolicyOptions({ aacPointsBytesBudget: Infinity }).aacPointsBytesBudget,
    Infinity,
    'Infinity is no limit',
  );
  eq(
    R.setFillPolicyOptions({ lbMinExtentPx: 12, aacPointsRowGate: false }).lbMinExtentPx,
    12,
    'a valid patch applies',
  );
  eq(R.getFillPolicyOptions().aacPointsRowGate, false, '...flags included');
  R.setFillPolicyOptions({
    aacPointsExtMax: null,
    lbMinExtentPx: null,
    aacPointsRowGate: null,
    aacPointsBytesBudget: null,
  });
  eq(JSON.stringify(R.getFillPolicyOptions()), before, 'null restores every default');
  const warnings = [];
  I.setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });
  R.setFillPolicyOptions({ nonsense: 1, alsoNonsense: 2 });
  R.setFillPolicyOptions({ nonsense: 1 });
  I.setDiagnostics({ onWarn: null });
  ok(
    warnings.filter((w) => /onsense/.test(w)).length === 2,
    `an unknown key warns once per key (${warnings.length} warnings)`,
  );

  // setStrokeStrip (the renderer keeps its own copy of the options, so only the contract is observable: what throws, what does not)
  for (const sel of [
    { policy: 'on', minSavedPxPerVertex: 10, maxMode: 1 },
    { policy: 'off' },
    { policy: true },
    { policy: false },
    { policy: 'auto', maxMode: 2 },
    { minSavedPxPerVertex: -4 },
    { minSavedPxPerVertex: Infinity },
    { policy: null, maxMode: undefined },
    {},
  ]) {
    let e = null;
    try {
      R.setStrokeStrip(sel);
    } catch (x) {
      e = x;
    }
    ok(e === null, `setStrokeStrip(${JSON.stringify(sel)}) is accepted`);
  }
  for (const sel of [
    { policy: 'bogus' },
    { policy: 3 },
    { minSavedPxPerVertex: NaN },
    { minSavedPxPerVertex: '10' },
    { maxMode: 3 },
    { maxMode: 'x' },
    { policy: 'off', maxMode: 7 },
  ]) {
    throws(
      () => R.setStrokeStrip(sel),
      /setStrokeStrip/,
      `setStrokeStrip(${JSON.stringify(sel)}) throws`,
    );
  }

  // setViewport / setResolutionScale / setScissorRect: errors
  throws(() => R.setViewport(NaN, 5), /setViewport/, 'setViewport(NaN) throws');
  throws(() => R.setViewport(10, 'x'), /setViewport/, 'setViewport(10, "x") throws');
  throws(() => R.setViewport('64'), /setViewport/, 'setViewport("64") throws');
  throws(() => R.setResolutionScale(NaN), /setResolutionScale/, 'setResolutionScale(NaN) throws');
  throws(
    () => R.setResolutionScale('0.5'),
    /setResolutionScale/,
    'setResolutionScale("0.5") throws',
  );
  throws(() => R.setScissorRect(NaN, 0, 5, 5), /setScissorRect/, 'setScissorRect(NaN, ...) throws');
  throws(
    () => R.setScissorRect(0, 0, 5, undefined),
    /setScissorRect/,
    'setScissorRect with a missing height throws',
  );
  // ...and the clamps, read through the draw matrix of a 100 x 100 bundle (it is fitted into the viewport by min(w, h) / 100)
  const b = I.createBundle(
    F.gl,
    await I.importSvg(doc('<rect width="100" height="100" fill="red"/>')),
  );
  const fit = () => R.bundleDrawMatrix(b, {})[0];
  R.setViewport(250.9, 50.7);
  ok(near(fit(), 0.5), `setViewport truncates 50.7 to 50 pixels (fit ${fit()})`);
  R.setViewport(200);
  ok(near(fit(), 2), 'one number is a square');
  R.setViewport(1e12, 1e12);
  ok(near(fit(), 327.67), `setViewport clamps to 32767 (fit ${fit()})`);
  R.setViewport(Infinity, Infinity);
  ok(near(fit(), 327.67), 'setViewport(Infinity) clamps too');
  R.setViewport(-4, -9);
  ok(near(fit(), 0.01), 'setViewport(-4, -9) clamps to 1 pixel');
  R.setViewport(0, 50);
  ok(near(fit(), 0.01), 'setViewport(0, 50) clamps the width to 1 pixel');
  R.setViewport(null);
  R.setViewport(128, 128);
  R.setScissorRect(1.9, 2.9, 3.9, -4);
  eq(F.scissorNow(), [1, 2, 3, 0], 'setScissorRect truncates and clamps the size at 0');
  R.setScissorRect(-5, 7, Infinity, 2);
  eq(F.scissorNow(), [-5, 7, 2 ** 30, 2], 'setScissorRect clamps an infinite size');
  R.clearScissorRect();
  b.dispose();
  R.dispose();
}

console.log('data values');
{
  const { R, gl } = await mkR();
  // createImage: a short pixel array has no handle
  const warns = [];
  I.setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
  ok(
    R.createImage({ width: 4, height: 4, data: new Uint8Array(16) }) === null,
    'createImage: 16 bytes for a 4x4 image gives null',
  );
  ok(
    warns.some((w) => /createImage/.test(w)),
    '...with a warning',
  );
  const h = R.createImage({ width: 2, height: 2, data: new Uint8Array(16) });
  ok(h && h.width === 2 && h.height === 2, 'createImage: an exact pixel array gives a handle');
  const buf = new Uint8Array(64);
  const view = buf.subarray(16, 32);
  ok(
    R.createImage({ width: 2, height: 2, data: view }) !== null,
    'createImage: a subarray view is read at its own offset',
  );
  I.setDiagnostics({ onWarn: null });
  h.dispose();

  // palette
  const pal = I.createPalette(gl, [
    [300, -5, 12.9, 255],
    [1, 2, 3],
  ]);
  eq(
    Array.from(pal._bytes.slice(0, 8)),
    [255, 0, 12, 255, 1, 2, 3, 255],
    'createPalette clamps to [0, 255] and defaults a missing alpha to 255',
  );
  pal.set(1, [300, -1, NaN, 999]);
  eq(
    Array.from(pal._bytes.slice(4, 8)),
    [255, 0, 0, 255],
    'palette.set clamps 300 to 255 (it wrapped to 44), -1 to 0, NaN to 0',
  );
  pal.update([[256, 128, 64]]);
  eq(Array.from(pal._bytes.slice(0, 4)), [255, 128, 64, 255], 'palette.update clamps too');
  pal.dispose();

  // incremental stroke
  const s = R.createIncrementalStroke({ width: 4, bbox: [0, 0, 100, 100], points: [[10, 10]] });
  s.appendPoints([
    [20, 20],
    [NaN, 30],
    [30, Infinity],
    [undefined, 5],
    [40, 40],
  ]);
  eq(s.pointCount, 3, 'appendPoints drops points with a non-finite coordinate');
  ok(!/NaN|Infinity|undefined/.test(s.pathD), `...so the path data is clean (${s.pathD})`);
  s.dispose();
  R.dispose();
}

console.log('morph parameter and timeline times');
{
  const { gl, R } = await mkR();
  const mk = async (d) =>
    I.createBundle(gl, await I.importSvg(doc(`<path id="s" d="${d}" fill="red"/>`)));
  const A = await mk('M10 10H30V30H10Z'),
    B = await mk('M40 40H60V60H40Z');
  const m = I.createShapeMorph(gl, A, B);
  m.setT(NaN);
  eq(m.t, 0, 'setT(NaN) reads as 0');
  m.setT('0.5');
  ok(m.t === 0.5 && typeof m.t === 'number', 'setT("0.5") stores the number 0.5');
  m.setT(7);
  eq(m.t, 1, 'setT(7) clamps to 1');
  m.setT(-Infinity);
  eq(m.t, 0, 'setT(-Infinity) clamps to 0');
  m.setT(Infinity);
  eq(m.t, 1, 'setT(Infinity) clamps to 1');
  m.setT(undefined);
  eq(m.t, 0, 'setT(undefined) reads as 0');
  throws(
    () =>
      I.createShapeTimeline(
        gl,
        [A, B],
        [
          { time: 0, bundleIndex: 0 },
          { time: NaN, bundleIndex: 1 },
        ],
      ),
    /finite/,
    'a NaN key time throws',
  );
  throws(
    () =>
      I.createShapeTimeline(
        gl,
        [A, B],
        [
          { time: 0, bundleIndex: 0 },
          { time: Infinity, bundleIndex: 1 },
        ],
      ),
    /finite/,
    'an Infinity key time throws',
  );
  throws(
    () =>
      I.createShapeTimeline(
        gl,
        [A, B],
        [
          { time: '0', bundleIndex: 0 },
          { time: 1, bundleIndex: 1 },
        ],
      ),
    /finite/,
    'a string key time throws',
  );
  const tl = I.createShapeTimeline(
    gl,
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 2, bundleIndex: 1 },
    ],
  );
  tl.setTime(NaN);
  tl.setTime('1');
  eq(tl.duration, 2, 'a finite timeline has its duration');
  ok(R.estimateRouteBytes([tl]).total.cover > 0, 'and setTime(NaN) / setTime("1") left it usable');
  R.dispose();
}

console.log('importSvg input');
{
  for (const [label, v] of [
    ['empty string', ''],
    ['whitespace', '  \n '],
    ['null', null],
    ['undefined', undefined],
    ['number', 5],
    ['object', {}],
  ]) {
    let e = null;
    try {
      await I.importSvg(v);
    } catch (x) {
      e = x;
    }
    ok(
      e instanceof TypeError && /importSvg: svgText must be a non-empty SVG string/.test(e.message),
      `${label}: a TypeError that names the argument${e ? '' : ' — did not throw'}`,
    );
  }
  for (const body of [
    '',
    '<g/>',
    '<rect width="9" height="9" fill="none"/>',
    '<rect width="9" height="9" display="none"/>',
    '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="url(#p)"/></pattern><rect width="9" height="9" fill="url(#p)"/>',
    '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"/><rect width="9" height="9" fill="url(#p)"/>',
  ]) {
    const sec = await I.importSvg(doc(body, '0 0 10 10'));
    eq(
      [sec.numShapes, sec.globalBBox],
      [0, [0, 0, 0, 0]],
      `a document with no ink has the bbox [0, 0, 0, 0]: ${body.slice(0, 40) || '(empty)'}`,
    );
  }
  const some = await I.importSvg(doc('<rect width="9" height="9" fill="red"/>', '0 0 10 10'));
  ok(
    some.numShapes === 1 && some.globalBBox.every(Number.isFinite) && some.globalBBox[2] > 0,
    'a document with ink keeps its bbox',
  );
}

console.log(fail ? `\nAPI-ARGUMENT-CONTRACT FAIL (${fail})` : '\nAPI-ARGUMENT-CONTRACT PASS');
process.exit(fail ? 1 : 0);
