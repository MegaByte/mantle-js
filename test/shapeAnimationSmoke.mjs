// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Timeline bracket/easing controls and materialized current-pose CPU queries.
// Fake GL records dataflow; physical rendering is qualified separately.

import {
  createShapeTimeline,
  createSpatialBezierMorph,
  createPathDeltaMorph,
  createSkinnedMorph,
  createPoseStack,
} from '../src/animation/shapeAnimation.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}
function approx(a, b, eps = 1e-5) {
  return Math.abs(a - b) < eps;
}

// ────────────────────────────────────────────────────────────────
// Fake GL — captures the last uploaded Float32Array.
// ────────────────────────────────────────────────────────────────
function makeFakeGL() {
  const fake = {
    TEXTURE_2D: 1,
    RGBA: 2,
    FLOAT: 3,
    UNSIGNED_BYTE: 4,
    RGBA32F: 5,
    TEXTURE_MIN_FILTER: 6,
    TEXTURE_MAG_FILTER: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    NEAREST: 10,
    CLAMP_TO_EDGE: 11,
    _lastUpload: null,
    _lastUploadDims: null,
    _boundTex: null,
    _uploadsByTex: new Map(), // last upload keyed by bound texture object
    bindTexture(target, tex) {
      fake._boundTex = tex;
    },
    texImage2D() {},
    texParameteri() {},
    texSubImage2D(target, level, xOff, yOff, w, h, fmt, type, data) {
      // Guard the WebGL2 invariant real drivers enforce: the source must
      // hold at least w*h*4 elements (RGBA), else the call would throw
      // INVALID_OPERATION. Catches under-padded curve-plane uploads that
      // a permissive fake GL would otherwise let slide.
      if (data && data.length != null && data.length < w * h * 4) {
        throw new Error(
          `texSubImage2D: not enough data for ${w}x${h} (have ${data.length}, need ${w * h * 4})`,
        );
      }
      // Capture a copy of the data — subsequent setT calls reuse the
      // scratch buffer, so we can't keep a live reference.
      let copy = null;
      if (data && data.constructor === Float32Array) copy = new Float32Array(data);
      else if (data && data.constructor === Uint8Array) copy = new Uint8Array(data);
      fake._lastUpload = copy;
      fake._lastUploadDims = [w, h];
      // Also record by texture so the test can grab the curve upload
      // specifically, even if meta / gradient uploads happen later in
      // the same setT.
      if (fake._boundTex && copy) fake._uploadsByTex.set(fake._boundTex, copy);
    },
    createTexture() {
      return { _id: 'tex' };
    },
    deleteTexture() {},
    pixelStorei() {},
    // Stubs for the remaining GL calls the morph/override constructors touch.
    activeTexture() {},
    useProgram() {},
    uniform1i() {},
    uniform1f() {},
    uniform2f() {},
    uniform4f() {},
    bindFramebuffer() {},
    deleteFramebuffer() {},
    createFramebuffer() {
      return { _id: 'fb' };
    },
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return 0x8cd5; /*FRAMEBUFFER_COMPLETE*/
    },
    FRAMEBUFFER: 0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_ATTACHMENT0: 0,
  };
  return fake;
}

// ────────────────────────────────────────────────────────────────
// Fake bundle factory.
// Produces a minimal bundle dict that satisfies the primitives'
// expectations:  curveFloats + curveTex + numShapes + shapeIds +
// metaFloats + globalBBox.
// ────────────────────────────────────────────────────────────────
let _fakeTexCtr = 0;
function fakeBundle(curveFloats, numShapes = 1, ids = ['s0']) {
  const stride = 48;
  const meta = new Float32Array(numShapes * stride);
  // texel 4 (offsets 16..17): glyphLoc.x, glyphLoc.y → start at (0,0)
  // for shape 0; (TEX_W=4096, so a single curve buffer of length
  // ≤ 4096*4 lands entirely on row 0).
  for (let s = 0; s < numShapes; s++) {
    meta[s * stride + 16] = 0; // glyphLoc.x
    meta[s * stride + 17] = 0; // glyphLoc.y
  }
  return {
    numShapes,
    shapeIds: ids,
    metaFloats: meta,
    metaFloatsPerShape: stride,
    globalBBox: [0, 0, 100, 100],
    curveFloats,
    bandFloats: new Float32Array(16), // Empty band lists: these fixtures test numeric interpolation, not curve decoding.
    curveTex: { _id: `curveTex-${++_fakeTexCtr}` },
    metaTex: { _id: `metaTex-${++_fakeTexCtr}` },
    flags: 0,
    gradientFloats: null,
    gradientStopsBytes: null,
    gradientStopsCount: 0,
    curveRangesByShape: [{ begin: 0, end: curveFloats.length }],
  };
}

// ────────────────────────────────────────────────────────────────
// 1) ShapeTimeline — bracket selection + cubic Bezier easing
// ────────────────────────────────────────────────────────────────
// Helper: grab the curve-texture upload from a morph's bundle.
function curveUploadFor(gl, morphLike) {
  // morphLike may be a timeline (with currentMorph) or a direct morph.
  const morph = morphLike.currentMorph || morphLike;
  const tex = morph && morph.bundle && morph.bundle.curveTex;
  return tex ? gl._uploadsByTex.get(tex) : null;
}

(() => {
  const gl = makeFakeGL();
  // Two-pose timeline. Both bundles same length so curves can lerp.
  const bA = fakeBundle(new Float32Array([0, 0, 1, 0]));
  const bB = fakeBundle(new Float32Array([10, 10, 11, 10]));
  const tl = createShapeTimeline(
    gl,
    [bA, bB],
    [
      { time: 0, bundleIndex: 0, interp: 'linear' },
      { time: 1, bundleIndex: 1, interp: 'linear' },
    ],
  );
  if (tl.duration !== 1) fail(`timeline duration: expected 1 got ${tl.duration}`);
  tl.setTime(0.5);
  // Expect upload — content lerped to halfway between (0,0,1,0) and (10,10,11,10).
  const buf = curveUploadFor(gl, tl);
  if (!buf) fail(`timeline: no curve upload happened at setTime(0.5)`);
  else if (!approx(buf[0], 5) || !approx(buf[1], 5) || !approx(buf[2], 6) || !approx(buf[3], 5))
    fail(`timeline: lerp at t=0.5 incorrect [${Array.from(buf).slice(0, 4)}]`);
  else ok('shapeTimeline 2-key linear: midpoint at t=0.5 lerps correctly');
  tl.dispose();
})();

(() => {
  // 3-key timeline + cubicBezier between key 1 and 2.
  // Sanity: ease-in at midpoint should produce localT < 0.5 → output
  // closer to keys[1] than to keys[2].
  const gl = makeFakeGL();
  const b0 = fakeBundle(new Float32Array([0, 0]));
  const b1 = fakeBundle(new Float32Array([5, 5]));
  const b2 = fakeBundle(new Float32Array([10, 10]));
  const tl = createShapeTimeline(
    gl,
    [b0, b1, b2],
    [
      { time: 0, bundleIndex: 0, interp: 'linear' },
      { time: 1, bundleIndex: 1, interp: 'cubicBezier', outX: 0.5, outY: 0, inX: 1, inY: 0.5 },
      { time: 2, bundleIndex: 2, interp: 'linear' },
    ],
  );
  // At time=1.5, localT raw = 0.5. The easing curve (outX=0.5, outY=0,
  // inX=1, inY=0.5) is a classic ease-in shape — it maps localT=0.5
  // through x→t→y to a value < 0.5 (slow start, fast end). So the
  // output should be strictly less than the linear midpoint (7.5):
  // somewhere between 5 (key 1 value) and the linear midpoint, with
  // the eased fraction in roughly [0.1, 0.4].
  tl.setTime(1.5);
  const buf = curveUploadFor(gl, tl);
  const v = buf ? buf[0] : NaN;
  if (!buf) fail(`timeline cubic: no upload at setTime(1.5)`);
  else if (!(v > 5 && v < 7.5)) fail(`timeline cubicBezier ease-in: expected ∈(5, 7.5) got ${v}`);
  else
    ok(
      `shapeTimeline cubicBezier ease-in: t=1.5 → ${v.toFixed(4)} (between key value 5 and linear midpoint 7.5)`,
    );
  tl.dispose();
})();

(() => {
  // Hold (step) interpolator: t in [1, 2) should produce the lo-key value.
  const gl = makeFakeGL();
  const b0 = fakeBundle(new Float32Array([1, 2]));
  const b1 = fakeBundle(new Float32Array([10, 20]));
  const tl = createShapeTimeline(
    gl,
    [b0, b1],
    [
      { time: 0, bundleIndex: 0, interp: 'hold' },
      { time: 1, bundleIndex: 1, interp: 'linear' },
    ],
  );
  tl.setTime(0.5);
  const buf = curveUploadFor(gl, tl);
  if (!buf) fail(`timeline hold: no upload`);
  else if (!approx(buf[0], 1) || !approx(buf[1], 2))
    fail(`timeline hold: should snap to lo-key (1,2), got (${buf[0]}, ${buf[1]})`);
  else ok('shapeTimeline hold: t=0.5 snaps to lo-key value');
  tl.dispose();
})();

// Materialized bundles: public query geometry, bounds and viewport follow every producer.
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    Object.assign(globalThis, { DOMParser: x.DOMParser, XMLSerializer: x.XMLSerializer });
  }
  const M = await import('../src/index.js'),
    A = await import('../src/animation/shapeAnimation.js'),
    { createFakeGl } = await import('./_fakeGl.mjs'),
    { fillHitShape } = await import('../src/hitTest/hitTest.js');
  const lineCoordinates = (b) =>
    b.curveRangesByShape.flatMap((r) => {
      const slots = [];
      for (let h = r.begin; h < r.end; h += 12) {
        if ((b.curveFloats[h] & 3) !== 0) throw Error('Line control requires line records');
        slots.push(h + 4, h + 5, h + 6, h + 7);
      }
      return slots;
    });
  const { gl } = createFakeGl(),
    rows = [],
    svg = (x, y = 0) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 32"><path id="p" d="M${x} ${y}h8v8h-8Z" fill="red"/></svg>`,
    bundle = async (x, y = 0) =>
      M.createBundle(
        gl,
        await M.importSvg(svg(x, y), { preserveViewport: true, retainSource: true }),
      );
  // Already queued callbacks remain inert even when cancellation is unavailable.
  {
    const saved = globalThis.requestIdleCallback,
      queue = [];
    globalThis.requestIdleCallback = (fn) => {
      queue.push(fn);
      return queue.length;
    };
    const bs = await Promise.all([bundle(0), bundle(20), bundle(40)]);
    const create = gl.createTexture;
    let allocations = 0;
    gl.createTexture = (...args) => {
      allocations++;
      return create(...args);
    };
    try {
      const timeline = A.createShapeTimeline(gl, bs, [
        { time: 0, bundleIndex: 0 },
        { time: 1, bundleIndex: 1 },
        { time: 2, bundleIndex: 2 },
      ]);
      timeline.dispose();
      const before = allocations;
      while (queue.length) queue.shift()();
      timeline.setTime(0.5);
      timeline.dispose();
      if (allocations === before && timeline.currentMorph === null)
        ok('disposed timeline creates no idle or explicit pair resources');
      else fail('disposed timeline allocated pair resources');
    } finally {
      gl.createTexture = create;
      if (saved === undefined) delete globalThis.requestIdleCallback;
      else globalThis.requestIdleCallback = saved;
      bs.forEach((b) => b.dispose());
    }
  }
  const check = (driver, b, x, y) => {
    const oldHit = fillHitShape(b, 4, 4),
      current = fillHitShape(b, x + 4, y + 4),
      bb = Array.from(b.metaFloats.slice(0, 4)),
      frame = b.globalBBox.slice(),
      pass =
        oldHit < 0 &&
        current >= 0 &&
        bb.every((v, i) => Math.abs(v - [x, y, x + 8, y + 8][i]) < 1e-5) &&
        frame.every((v, i) => Math.abs(v - [0, 0, 80, 32][i]) < 1e-5);
    rows.push({ driver, x, y, oldHit, current, bounds: bb, frame, pass });
  };
  {
    const b = await bundle(0),
      base = b.curveFloats,
      layout = { coordinates: lineCoordinates(b) },
      d = new Float32Array(base.length);
    for (const i of layout.coordinates) if (i % 2 === 0) d[i] = 40;
    const m = A.createPathDeltaMorph(gl, b, [
      { time: 0, vertexDeltas: new Float32Array(d.length) },
      { time: 1, vertexDeltas: d },
    ]);
    for (const t of [1, 0.5, 1]) {
      m.setTime(t);
      check('delta', m.bundle, t * 40, 0);
    }
    m.dispose();
    b.dispose();
  }
  {
    const b = await bundle(0),
      m = A.createSkinnedMorph(
        gl,
        b,
        Array.from({ length: b.curveFloats.length / 2 }, () => [{ boneId: 0, weight: 1 }]),
      );
    m.setBoneMatrices(new Float32Array([1, 0, 0, 1, 40, 0]));
    check('skin', m.bundle, 40, 0);
    m.dispose();
    b.dispose();
  }
  {
    const a = await bundle(0),
      b = await bundle(40),
      out = new Float32Array(a.curveFloats.length),
      into = new Float32Array(out.length);
    for (const i of lineCoordinates(a))
      if (i % 2) {
        out[i] = 10;
        into[i] = -10;
      }
    const m = A.createSpatialBezierMorph(gl, a, b, { outTan: out, inTan: into });
    for (const t of [0.5, 1, 0.5]) {
      m.setT(t);
      check('spatial', m.bundle, 40 * t, 30 * t * (1 - t));
    }
    m.dispose();
    a.dispose();
    b.dispose();
  }
  {
    const bs = await Promise.all([bundle(0), bundle(40), bundle(20, 16)]),
      m = A.createPoseStack(gl, bs);
    for (const t of [0.5, 0.25, 0.75, 0.5]) {
      m.setState({ a: 0, b: 1, c: 2, tAB: t, tBC: 0.5 });
      check('stack', m.bundle, 20 * t + 10, 8);
    }
    m.setState({ a: 0, b: 1, c: 1, tAB: 0.5, tBC: 0.5 });
    rows.push({
      driver: 'stack-retarget-same-destination',
      pass: fillHitShape(m.bundle, 34, 4) >= 0,
    });
    m.setState({ a: 0, b: 1, c: 2, tAB: 0.5, tBC: 0 });
    const hit = fillHitShape(m.bundle, 24, 4);
    rows.push({ driver: 'stack-return-two-pose', pass: hit >= 0, hit });
    m.dispose();
    bs.forEach((b) => b.dispose());
  }
  for (const row of rows) {
    if (row.pass) ok('current pose ' + row.driver);
    else fail('current pose ' + JSON.stringify(row));
  }
  {
    const text =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 32"><g opacity=".5"><path d="M0 0h8v8h-8Z"/></g></svg>';
    const a = M.createBundle(gl, await M.importSvg(text, { preserveViewport: true })),
      b = M.createBundle(
        gl,
        await M.importSvg(text.replace('M0 0', 'M40 0'), { preserveViewport: true }),
      );
    const delta = Float32Array.from(a.curveFloats, (v, i) => (b.curveFloats[i] || 0) - v),
      m = A.createPathDeltaMorph(gl, a, [
        { time: 0, vertexDeltas: new Float32Array(delta.length) },
        { time: 1, vertexDeltas: delta },
      ]);
    m.setTime(1);
    if (fillHitShape(a, 44, 4) >= 0 && fillHitShape(a, 4, 4) < 0)
      ok('group markers retain current driven geometry');
    else fail('group marker geometry');
    m.dispose();
    a.dispose();
    b.dispose();
    const empty = M.createBundle(
        gl,
        await M.importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 32"/>', {
          preserveViewport: true,
        }),
      ),
      d = A.createPathDeltaMorph(gl, empty, [
        { time: 0, vertexDeltas: new Float32Array(empty.curveFloats.length) },
      ]);
    d.setTime(0);
    if (empty.numShapes === 0) ok('empty driven bundle remains empty');
    else fail('empty driven bundle');
    d.dispose();
    empty.dispose();
  }
  const circle = (x) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 32"><path id="p" d="M${x} 12A4 4 0 0 1 ${x + 8} 12A4 4 0 0 1 ${x} 12Z" fill="none" stroke="blue" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="2 1"/></svg>`;
  const a = M.createBundle(gl, await M.importSvg(circle(5), { preserveViewport: true })),
    b = M.createBundle(gl, await M.importSvg(circle(45), { preserveViewport: true })),
    out = new Float32Array(a.curveFloats.length),
    into = new Float32Array(out.length);
  for (const r of a.curveRangesByShape)
    for (let h = r.begin; h < r.end;) {
      const type = a.curveFloats[h] & 3;
      if (type === 3)
        for (const i of [h + 13, h + 15]) {
          out[i] = 10;
          into[i] = -10;
        }
      h += type === 3 ? 20 : 12;
    }
  const m = A.createSpatialBezierMorph(gl, a, b, { outTan: out, inTan: into });
  m.setT(0.5);
  const cv = m.bundle.curveFloats;
  let consistent = true,
    count = 0;
  for (const r of m.bundle.curveRangesByShape)
    for (let h = r.begin; h < r.end;) {
      const type = cv[h] & 3;
      if (type === 3) {
        for (const [theta, point] of [
          [h + 8, h + 12],
          [h + 9, h + 14],
        ]) {
          const angle = cv[theta],
            phi = cv[h + 10],
            x =
              cv[h + 4] +
              Math.cos(phi) * cv[h + 6] * Math.cos(angle) -
              Math.sin(phi) * cv[h + 7] * Math.sin(angle),
            y =
              cv[h + 5] +
              Math.sin(phi) * cv[h + 6] * Math.cos(angle) +
              Math.cos(phi) * cv[h + 7] * Math.sin(angle);
          consistent &&= Math.abs(x - cv[point]) < 4e-6 && Math.abs(y - cv[point + 1]) < 4e-6;
          count++;
        }
      }
      h += type === 3 ? 20 : 12;
    }
  if (consistent && count === 4) ok('spatial arc endpoints agree with their current center/angles');
  else fail('spatial arc stored endpoints are stale');
  const ref = M.createBundle(
    gl,
    await M.importSvg(circle(25).replaceAll(' 12', ' 19.5'), { preserveViewport: true }),
  );
  if (cv.length === ref.curveFloats.length && cv.every((v, i) => v === ref.curveFloats[i]))
    ok('current arc joins/prefixes match the independent translated import');
  else fail('current arc derived records disagree with translated import');
  ref.dispose();
  m.dispose();
  a.dispose();
  b.dispose();
}

if (failures === 0) console.log('\nSHAPE-ANIMATION PASS');
else {
  console.error(`\nSHAPE-ANIMATION FAIL (${failures})`);
  process.exit(1);
}
