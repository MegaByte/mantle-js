// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// animationAuditSmoke -- contracts of the animation, morph, timeline, sprite and native APIs.
//
//   a primitive tag (rect / roundRect) must not survive into a pose between two different shapes, or the closed-form
//          rect fast path and the hit test treat a rect -> rotated-rect pose as the source rect
//   the pose bbox of an arc morph must cover the lerped arc, not be the (smaller) linear lerp of the endpoint boxes
//   native morph setT(NaN) must not write NaN; the native timeline validates keys as the GL timeline does
//   PathDelta setTime(NaN) must not write NaN into any coordinate; key times are validated; a disposed guard
//   sprite ids must not resolve inherited members ("constructor", "__proto__"); explicit ranges are validated
//   PoseStack: setState after dispose neither throws nor resurrects morphs; a rejected index leaves the state intact
//   filter parameter set() rejects out-of-domain numbers and wrong-length vectors
//   cubic-bezier easing with an x control outside [0, 1] is rejected (it is not a function of time)
//
// CPU only: the real importer, morphs and filter params on test/_fakeGl.mjs.
import { createFakeGl } from './_fakeGl.mjs';

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
    `${m}${e ? ' -- ' + e.message.slice(0, 90) : ' -- did not throw'}`,
  );
};
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { createBundle } = await import('../src/renderer/bundle.js');
const SM = await import('../src/animation/shapeMorph.js');
const SA = await import('../src/animation/shapeAnimation.js');
const { sampleMorphPose } = await import('../src/core/morphPose.js');
const { fillHitShape } = await import('../src/hitTest/hitTest.js');
const { createNativeMorph, createNativeTimeline } = await import('../src/fallback/nativeMorph.js');
const { createFilterParams } = await import('../src/animation/filterParams.js');
const { timelineEase } = await import('../src/core/morphCore.js');

const svg = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const { gl } = createFakeGl();
const bun = async (s, o) => createBundle(gl, await importSvg(s, o));
const grid = (bd) => {
  let c = 0;
  for (let i = 0; i < 41; i++)
    for (let j = 0; j < 41; j++)
      c +=
        fillHitShape(bd, ((i + 0.31) * 100) / 41, ((j + 0.17) * 100) / 41, { mode: 'coverage' }) >=
        0
          ? 1
          : 0;
  return c;
};

// ----------------------------------------------------------------------
console.log('primitive tag in a morph pose');
{
  const rect = svg('<rect id="s" x="30" y="30" width="40" height="40" fill="red"/>');
  const diamond = svg('<path id="s" fill="red" d="M50 20L80 50L50 80L20 50Z"/>');
  const lerped = (t) => {
    const p = [
        [30, 30],
        [70, 30],
        [70, 70],
        [30, 70],
      ],
      q = [
        [50, 20],
        [80, 50],
        [50, 80],
        [20, 50],
      ];
    return svg(
      `<path id="s" fill="red" d="M${p.map((v, i) => v[0] * (1 - t) + q[i][0] * t + ' ' + (v[1] * (1 - t) + q[i][1] * t)).join('L')}Z"/>`,
    );
  };
  const a = await bun(rect),
    b = await bun(diamond);
  ok(a.metaFloats[44] === 2, 'the rect source is tagged primKind 2');
  const m = SM.createShapeMorph(gl, a, b, { cpuLerp: true });
  ok(m.bundle.metaFloats[44] === 0, 'rect -> diamond: the uploaded meta row is untagged');
  m.setT(0.5);
  ok(sampleMorphPose(m.bundle).meta[44] === 0, 'rect -> diamond: the pose row is untagged');
  const lit = grid(await bun(lerped(0.5)));
  ok(
    grid(m.bundle) === lit,
    `rect -> diamond at t=.5: hit ink ${grid(m.bundle)} equals the literal lerp ${lit}`,
  );

  // Same primitive on both sides keeps its fast path.
  const r2 = await bun(svg('<rect id="s" x="10" y="10" width="60" height="30" fill="red"/>'));
  const mm = SM.createShapeMorph(gl, a, r2);
  ok(mm.bundle.metaFloats[44] === 2, 'rect -> rect stays tagged');
  // roundRect: the radius slot is cleared with the tag when the pose is not a roundRect of that radius.
  const rr = (rx) =>
    svg(`<rect id="s" x="10" y="10" width="60" height="40" rx="${rx}" fill="red"/>`);
  const ra = await bun(rr(10)),
    rb = await bun(rr(20));
  ok(
    ra.metaFloats[44] === 3 && ra.metaFloats[46] === 10,
    'roundRect source is primKind 3 with rx in slot 46',
  );
  const m3 = SM.createShapeMorph(gl, ra, rb);
  ok(
    m3.bundle.metaFloats[44] === 0 && m3.bundle.metaFloats[46] === 0,
    'roundRect rx 10 -> 20: tag and rx cleared',
  );
  const m4 = SM.createShapeMorph(gl, ra, await bun(rr(10)));
  ok(
    m4.bundle.metaFloats[44] === 3 && m4.bundle.metaFloats[46] === 10,
    'roundRect -> equal roundRect stays tagged',
  );
}

// ----------------------------------------------------------------------
console.log('arc pose bbox');
{
  // The rotation lerps as a number with the end points in place, so the ellipse swings out of both poses' boxes: F.6.6 scales it up to span the chord (4x at 90).
  const ell = (phi, k = 1) => {
    const f = (v) => v * k;
    return svg(
      `<path id="s" fill="red" d="M${f(90)} ${f(50)}A${f(40)} ${f(10)} ${phi} 0 1 ${f(10)} ${f(50)}A${f(40)} ${f(10)} ${phi} 0 1 ${f(90)} ${f(50)}Z"/>`,
      `0 0 ${100 * k} ${100 * k}`,
    );
  };
  const m = SM.createShapeMorph(gl, await bun(ell(0)), await bun(ell(180)), { cpuLerp: true });
  const ms = m.bundle._morphSrc;
  // the geometry of the pose: every arc of the pose plane, sampled
  const poseExtent = (pose) => {
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;
    for (const o of ms.arcOffsets) {
      const c = pose.curve,
        cx = c[o + 4],
        cy = c[o + 5],
        rx = c[o + 6],
        ry = c[o + 7],
        th0 = c[o + 8],
        th1 = c[o + 9],
        phi = c[o + 10];
      for (let i = 0; i <= 2000; i++) {
        const th = th0 + ((th1 - th0) * i) / 2000;
        const x = cx + rx * Math.cos(th) * Math.cos(phi) - ry * Math.sin(th) * Math.sin(phi);
        const y = cy + rx * Math.cos(th) * Math.sin(phi) + ry * Math.sin(th) * Math.cos(phi);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    return [x0, y0, x1, y1];
  };
  for (const t of [0.25, 0.5, 0.75]) {
    m.setT(t);
    // the union of the two poses' box and the arcs' own extent
    const pose = sampleMorphPose(m.bundle),
      arcs = poseExtent(pose),
      want = [
        Math.min(arcs[0], 10),
        Math.min(arcs[1], 40),
        Math.max(arcs[2], 90),
        Math.max(arcs[3], 60),
      ],
      got = Array.from(pose.meta.slice(0, 4));
    ok(
      arcs[1] < 40 && arcs[3] > 60,
      `t=${t}: the arc leaves the poses' box (${arcs.map((v) => v.toFixed(3))})`,
    );
    ok(
      got.every((v, i) => near(v, want[i], 1e-4)),
      `t=${t}: pose bbox ${got.map((v) => v.toFixed(3))} holds the arc extent ${want.map((v) => v.toFixed(3))}`,
    );
  }
  m.setT(0);
  ok(
    Array.from(sampleMorphPose(m.bundle).meta.slice(0, 4)).every(
      (v, i) => v === m.bundle._morphSrc.mergedMetaF32[i],
    ),
    't=0 keeps the source box exactly',
  );
  // the hit test culls on that box: the morph at t=.5 hits where its own geometry is
  m.setT(0.5);
  const pose = sampleMorphPose(m.bundle),
    ext = poseExtent(pose);
  ok(
    fillHitShape(m.bundle, ext[0] + 0.3, 50, { mode: 'coverage' }) >= 0 ||
      fillHitShape(m.bundle, 50, ext[1] + 0.3, { mode: 'coverage' }) >= 0,
    'a point just inside the arc extent is not culled',
  );
  // correct at any scale: the same morph authored 1000x smaller gives the same box, scaled
  {
    const k = 1e-3,
      sm = SM.createShapeMorph(gl, await bun(ell(0, k)), await bun(ell(180, k)), { cpuLerp: true });
    sm.setT(0.5);
    const small = Array.from(sampleMorphPose(sm.bundle).meta.slice(0, 4)),
      big = Array.from(sampleMorphPose(m.bundle).meta.slice(0, 4));
    ok(
      small.every((v, i) => near(v / k, big[i], 1e-3)),
      `scaled 1e-3: box ${small.map((v) => (v / k).toFixed(3))} equals the unit box ${big.map((v) => v.toFixed(3))}`,
    );
  }
  // the GPU mix leaves the bbox texel linear; the widened one is patched over it (a recording proxy sees the uploads)
  const writes = [];
  const spy = new Proxy(gl, {
    get(t, k) {
      const v = t[k];
      if (k !== 'texSubImage2D') return typeof v === 'function' ? v.bind(t) : v;
      return (target, level, x, y, w, h, fmt, type, data) => {
        if (w === 1 && h === 1 && x === 0 && data && data.length >= 4)
          writes.push([y, Array.from(data).slice(0, 4)]);
        return v.call(t, target, level, x, y, w, h, fmt, type, data);
      };
    },
  });
  const sm2 = SM.createShapeMorph(spy, await bun(ell(0)), await bun(ell(180)), { cpuLerp: true });
  sm2.setT(0.4);
  sm2.setT(0.5);
  const w = writes.filter((e) => e[0] === 0).pop();
  const arcs2 = poseExtent(sampleMorphPose(sm2.bundle)),
    want = [
      Math.min(arcs2[0], 10),
      Math.min(arcs2[1], 40),
      Math.max(arcs2[2], 90),
      Math.max(arcs2[3], 60),
    ];
  ok(
    !!w && w[1].every((v, i) => near(v, want[i], 1e-4)),
    'setT patches the bbox texel of the arc row with the widened box',
  );
}

// ----------------------------------------------------------------------
console.log('native NaN t and native timeline keys');
{
  const A = await importSvg(
    svg(
      '<rect id="r" x="10" y="10" width="40" height="40" fill="red"/><rect id="g" x="10" y="60" width="10" height="10" fill="red"/>',
    ),
    { retainSource: true },
  );
  const B = await importSvg(
    svg(
      '<rect id="r" x="50" y="10" width="40" height="40" fill="blue"/><rect id="n" x="60" y="60" width="10" height="10" fill="blue"/>',
    ),
    { retainSource: true },
  );
  const nm = createNativeMorph(A, B);
  const show = () =>
    JSON.stringify([
      nm.overrides.get('r')?.fill,
      nm.overrides.get('g')?.visibility,
      nm.overrides.extraShapes?.[0]?.alpha,
    ]);
  nm.setT(0);
  const at0 = show();
  for (const bad of [NaN, undefined, 'x']) {
    nm.setT(bad);
    ok(show() === at0 && !/NaN|null/.test(show()), `setT(${String(bad)}) reads as 0`);
  }
  nm.setT(Infinity);
  ok(!/NaN/.test(show()), 'setT(Infinity) clamps to 1');
  throws(
    () =>
      createNativeTimeline(
        [A, B],
        [
          { time: 1, bundleIndex: 1 },
          { time: 0, bundleIndex: 0 },
        ],
      ),
    /time-sorted/,
    'unsorted native timeline keys throw',
  );
  throws(
    () =>
      createNativeTimeline(
        [A, B],
        [
          { time: NaN, bundleIndex: 1 },
          { time: 1, bundleIndex: 0 },
        ],
      ),
    /finite/,
    'a NaN native key time throws',
  );
  throws(
    () => createNativeTimeline([A, B], [{ time: 0, bundleIndex: 7 }]),
    /out of range/,
    'a bad native bundleIndex throws a named error',
  );
  const tl = createNativeTimeline(
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
    ],
  );
  tl.setTime(0.5);
  tl.setTime(NaN);
  ok(
    !/NaN/.test(JSON.stringify([A.__streamPathD])),
    'native timeline setTime(NaN) reads as the first key',
  );
}

// ----------------------------------------------------------------------
console.log('PathDelta time');
{
  const A = await bun(svg('<rect id="r" x="10" y="40" width="10" height="20" fill="red"/>'));
  const n = A.curveFloats.length,
    d = (v) => {
      const a = new Float32Array(n);
      for (let i = 4; i < n; i += 2) a[i] = v;
      return a;
    };
  const pd = SA.createPathDeltaMorph(gl, A, [
    { time: 0, vertexDeltas: d(0) },
    { time: 1, vertexDeltas: d(50) },
  ]);
  const nans = () => A.curveFloats.reduce((c, x) => c + (Number.isNaN(x) ? 1 : 0), 0);
  pd.setTime(0.5);
  const mid = A.curveFloats[10];
  for (const bad of [NaN, undefined]) {
    pd.setTime(bad);
    ok(
      nans() === 0 && A.curveFloats[10] !== mid,
      `setTime(${String(bad)}) reads as the first key, no NaN`,
    );
  }
  pd.setTime('0.5');
  ok(near(A.curveFloats[10], mid), 'a numeric string coerces');
  throws(
    () =>
      SA.createPathDeltaMorph(gl, A, [
        { time: NaN, vertexDeltas: d(0) },
        { time: 1, vertexDeltas: d(50) },
      ]),
    /finite/,
    'a NaN delta time throws',
  );
  pd.dispose();
  const before = A.curveFloats[10];
  pd.setTime(1);
  ok(A.curveFloats[10] === before, 'setTime after dispose is a no-op');
}

// ----------------------------------------------------------------------
console.log('sprite ids and ranges');
{
  const sheet = await bun(
    svg(
      '<g id="idle"><rect id="b" x="0" y="0" width="10" height="10"/></g><g id="run"><rect id="b" x="40" y="0" width="10" height="10"/></g><g id="__proto__"><rect id="b" x="70" y="0" width="10" height="10"/></g>',
    ),
  );
  ok(
    Object.keys(sheet.spriteRanges).join() === 'idle,run,__proto__',
    'an id of "__proto__" is an own entry of spriteRanges',
  );
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    throws(
      () =>
        SM.createSpriteMorph(gl, { bundle: sheet, sprite: id }, { bundle: sheet, sprite: 'run' }),
      /unknown src sprite/,
      `createSpriteMorph("${id}") is an unknown id`,
    );
  }
  const m = SM.createSpriteMorph(
    gl,
    { bundle: sheet, sprite: 'idle' },
    { bundle: sheet, sprite: '__proto__' },
  );
  m.dispose();
  ok(true, 'the "__proto__" sprite resolves');
  for (const bad of [
    [1, 0],
    [-3, 1],
    [0, 999],
    [NaN, NaN],
    [0.5, 1],
  ])
    throws(
      () =>
        SM.createSpriteMorph(gl, { bundle: sheet, sprite: bad }, { bundle: sheet, sprite: 'run' }),
      /must be integers/,
      `explicit range [${bad}] is rejected`,
    );
  const M = SM.createSpriteMorph(
    gl,
    { bundle: sheet, sprite: [0, 0] },
    { bundle: sheet, sprite: [1, 1] },
  );
  M.dispose();
  ok(true, 'a valid explicit range is accepted');
}

// ----------------------------------------------------------------------
console.log('PoseStack state');
{
  const A = await bun(svg('<rect id="r" x="0" y="0" width="10" height="10"/>')),
    B = await bun(svg('<rect id="r" x="50" y="0" width="10" height="10"/>'));
  const ps = SA.createPoseStack(gl, [A, B]);
  ps.setState({ a: 0, b: 1, tAB: 0.5 });
  throws(
    () => ps.setState({ b: 7, tAB: 0.2 }),
    /out of range/,
    'an out-of-range pose index throws a named error',
  );
  ok(ps.poseB === 1 && ps.tAB === 0.5, 'the rejected call committed nothing');
  let threw = false;
  try {
    ps.setState({ tAB: 0.4 });
  } catch {
    threw = true;
  }
  ok(!threw, 'a later partial setState still works');
  ps.dispose();
  threw = false;
  try {
    ps.setState({ a: 0, b: 1, tAB: 0.6 });
    ps.setState({ a: 1, b: 0 });
  } catch {
    threw = true;
  }
  ok(!threw, 'setState after dispose is a no-op');
}

// ----------------------------------------------------------------------
console.log('filter parameter domains');
{
  const b = await bun(
    svg(
      '<defs><filter id="f"><feGaussianBlur stdDeviation="3"/></filter><filter id="g"><feFlood flood-color="red"/><feOffset dx="2" dy="2"/></filter><filter id="h"><feMorphology operator="dilate" radius="2"/></filter></defs><rect width="50" height="50" filter="url(#f)"/><rect x="50" width="30" height="30" filter="url(#g)"/><rect y="60" width="20" height="20" filter="url(#h)"/>',
    ),
  );
  const fp = createFilterParams(b);
  const by = (type) => fp.targets.find((t) => t.type === type);
  const blur = by('feGaussianBlur') || by('blur'),
    flood = by('feFlood'),
    off = by('feOffset'),
    morph = by('feMorphology') || by('morphology');
  const before = JSON.stringify(blur && fp.get(blur.id));
  if (blur) {
    ok(
      fp.set(blur.id, { sigmaX: -5 }) === false && JSON.stringify(fp.get(blur.id)) === before,
      'a negative sigma is not written',
    );
    ok(fp.set(blur.id, { sigmaX: NaN }) === false, 'a NaN sigma is not written');
    ok(
      fp.set(blur.id, { sigmaX: 0 }) === true && fp.get(blur.id).sigmaX === 0,
      'sigma 0 (the domain edge) is written',
    );
    ok(
      fp.set(blur.id, { sigmaX: 4, sigmaY: -1 }) === true &&
        fp.get(blur.id).sigmaX === 4 &&
        fp.get(blur.id).sigmaY !== -1,
      'a valid field of a mixed patch lands, the bad one does not',
    );
  }
  if (flood) {
    const f0 = JSON.stringify(fp.get(flood.id));
    for (const bad of [
      [1, 0],
      [NaN, 0, 0, 1],
      [2, -1, 0, 1],
      [1, 0, 0, 1, 1],
    ])
      ok(fp.set(flood.id, { rgba: bad }) === false, `rgba ${JSON.stringify(bad)} is rejected`);
    ok(JSON.stringify(fp.get(flood.id)) === f0, 'the flood color is unchanged');
    ok(fp.set(flood.id, { rgba: [0, 1, 0, 0.5] }) === true, 'a valid rgba is written');
  }
  if (off)
    ok(
      fp.set(off.id, { dx: Infinity }) === false && fp.set(off.id, { dx: -7 }) === true,
      'offset: infinite rejected, negative accepted (any finite)',
    );
  if (morph) {
    ok(
      fp.set(morph.id, { operator: 7 }) === false && fp.set(morph.id, { operator: 0.5 }) === false,
      'morphology operator outside {0,1} is rejected',
    );
    ok(fp.set(morph.id, { radiusX: -1 }) === false, 'a negative radius is rejected');
  }
  fp.set(blur.id, { sigmaX: 9 });
  ok(fp.reset() === true && fp.get(blur.id).sigmaX === 3, 'reset restores the imported values');
}

// ----------------------------------------------------------------------
console.log('cubic-bezier x controls');
{
  const ref = (ox, oy, ix, iy, u) => {
    const bx = (t) => 3 * (1 - t) ** 2 * t * ox + 3 * (1 - t) * t * t * ix + t ** 3,
      by = (t) => 3 * (1 - t) ** 2 * t * oy + 3 * (1 - t) * t * t * iy + t ** 3;
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      if (bx(m) < u) lo = m;
      else hi = m;
    }
    return by((lo + hi) / 2);
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let worst = 0;
  for (let k = 0; k < 4000; k++) {
    const ox = rnd() * 3 - 1,
      ix = rnd() * 3 - 1,
      oy = rnd(),
      iy = rnd(),
      u = rnd();
    const cl = (x) => Math.min(1, Math.max(0, x));
    const g = timelineEase({ interp: 'cubicBezier', outX: ox, outY: oy, inX: ix, inY: iy }, u);
    worst = Math.max(worst, Math.abs(g - ref(cl(ox), oy, cl(ix), iy, u)));
  }
  ok(
    worst < 1e-4,
    `x controls in [-1, 2] equal the curve with x clamped to [0, 1] (max err ${worst.toExponential(2)})`,
  );
  ok(
    timelineEase({ interp: 'cubicBezier', outX: -3, outY: 0, inX: 4, inY: 1 }, 0.5) ===
      timelineEase({ interp: 'cubicBezier', outX: 0, outY: 0, inX: 1, inY: 1 }, 0.5),
    'a clamped key equals the key at the bounds',
  );
}

process.exit(fail ? 1 : 0);
