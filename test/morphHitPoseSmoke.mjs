#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// morphHitPoseSmoke — hit tests must evaluate a morphing bundle at the
// current t, not the frozen t=0 curve plane createShapeMorph leaves on CPU.
import { fillHitShape, HitMode } from '../src/hitTest/hitTest.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
}
function ok(msg) {
  console.log('ok', msg);
}

// Synthetic 1-shape morph: axis-aligned square that slides from x∈[0,10] to x∈[20,30].
const STRIDE = 48;
const srcCurve = new Float32Array([
  // sentinel
  0, 0, 0, 0,
  // line (0,0)→(10,0)  type=0, floats: hdr(4) + p0(2)+p1(2) + join(4) = 12
  0, 2, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0,
  // line (10,0)→(10,10)
  0, 2, 0, 0, 10, 0, 10, 10, 0, 0, 0, 0,
  // line (10,10)→(0,10)
  0, 2, 0, 0, 10, 10, 0, 10, 0, 0, 0, 0,
  // line (0,10)→(0,0)
  0, 2, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0,
]);
const dstCurve = new Float32Array(srcCurve);
for (let i = 4; i < dstCurve.length; i += 12) {
  // translate every endpoint by +20 in x (p0.x and p1.x at +4,+6 within the 12-float record)
  dstCurve[i + 4] += 20;
  dstCurve[i + 6] += 20;
}

const srcMeta = new Float32Array(STRIDE);
srcMeta[0] = 0;
srcMeta[1] = 0;
srcMeta[2] = 10;
srcMeta[3] = 10;
srcMeta[4] = 1;
srcMeta[5] = 0;
srcMeta[6] = 0;
srcMeta[7] = 1; // fill rgba
const dstMeta = new Float32Array(srcMeta);
dstMeta[0] = 20;
dstMeta[2] = 30;

const bundle = {
  numShapes: 1,
  metaFloatsPerShape: STRIDE,
  metaFloats: srcMeta.slice(),
  curveFloats: srcCurve.slice(),
  curveRangesByShape: [{ begin: 4, end: srcCurve.length }],
  _geomGen: 0,
  _morphSrc: {
    mergedCurveF32: srcCurve,
    dstCurveF32: dstCurve,
    curveRanges: [{ begin: 4, end: srcCurve.length }],
    mergedMetaF32: srcMeta,
    dstMetaF32: dstMeta,
    metaStride: STRIDE,
    matchedSrcIdxs: [0],
    t: 0,
  },
};

// t=0: center of src square hits; center of dst misses
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) === 0, 't=0 src center hits');
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) < 0, 't=0 dst center misses');
ok('t=0 pose');

bundle._morphSrc.t = 1;
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) === 0, 't=1 dst center hits');
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) < 0, 't=1 src center misses');
ok('t=1 pose');

bundle._morphSrc.t = 0.5;
assert(fillHitShape(bundle, 15, 5, HitMode.Coverage) === 0, 't=0.5 mid center hits');
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) < 0, 't=0.5 src center misses');
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) < 0, 't=0.5 dst center misses');
ok('t=0.5 pose');

// Nearby poses must not alias in the cache. These two values round to the same
// 1/1024 key even though the interpolated bbox crosses x=10.003, so t is keyed exactly.
bundle._morphSrc.t = 0.5001;
assert(fillHitShape(bundle, 10.003, 5, HitMode.Bbox) === 0, 'nearby pose A hits');
bundle._morphSrc.t = 0.5002;
assert(fillHitShape(bundle, 10.003, 5, HitMode.Bbox) < 0, 'nearby pose B misses');
ok('exact t cache key');

// A geometry rewrite at the same t must invalidate both pose and decoded caches.
{
  const m = { ...bundle, _morphSrc: { ...bundle._morphSrc, t: 0.5 }, _geomGen: 0 };
  assert(fillHitShape(m, 15, 5, HitMode.Coverage) === 0, 'rewrite control initially hits');
  const ms = m._morphSrc;
  for (const key of ['mergedCurveF32', 'dstCurveF32']) {
    ms[key] = ms[key].slice();
    for (let i = 4; i < ms[key].length; i += 12) {
      ms[key][i + 4] += 20;
      ms[key][i + 6] += 20;
    }
  }
  for (const key of ['mergedMetaF32', 'dstMetaF32']) {
    ms[key] = ms[key].slice();
    ms[key][0] += 20;
    ms[key][2] += 20;
  }
  m._geomGen++;
  assert(fillHitShape(m, 15, 5, HitMode.Coverage) < 0, 'rewritten prior position misses');
  assert(
    fillHitShape(m, 35, 5, HitMode.Coverage) === 0,
    'rewritten current position hits at unchanged t',
  );
  ok('same-pose geometry rewrite');
}

// Override visibility=0 must miss even when geometry covers the point.
// An identity affine (texel 0), as createOverrideTable writes every row: an all-zero basis collapses the row to a
// point, which the render does not draw and the hit test does not hit.
const packed = new Float32Array(24);
packed[0] = packed[3] = 1;
packed[6] = 0;
packed[8] = packed[9] = packed[10] = packed[11] = 1;
bundle._morphSrc.t = 0;
assert(
  fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, overrides: packed }) < 0,
  'visibility 0 hides hit',
);
packed[6] = 0.8;
packed[11] = 0.8;
assert(
  fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, minAlpha: 0.7, overrides: packed }) < 0,
  'visibility and tint alpha affect minAlpha',
);
assert(
  fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, minAlpha: 0.6, overrides: packed }) === 0,
  'effective alpha above minAlpha hits',
);
ok('override visibility and alpha');

// Imported fixed fades retain their native geometry and paint. Visibility alone fades them.
{
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const { importSvg, createBundle, createShapeMorph } = await import('../src/index.js');
  const { gl } = createFakeGl();
  const svg = (alpha) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="paint" x="10" y="10" width="60" height="60" fill="blue" fill-opacity="' +
    alpha +
    '"/></svg>';
  for (const [from, to] of [
    [0, 0.8],
    [0.8, 0],
    [0.4, 0.8],
  ]) {
    const a = createBundle(gl, await importSvg(svg(from)));
    const b = createBundle(gl, await importSvg(svg(to)));
    const m = createShapeMorph(gl, a, b);
    try {
      for (const t of [0, 0.25, 0.5, 0.75, 1, 0.5, 0]) {
        m.setT(t);
        const alpha = from + (to - from) * t;
        for (const mode of [HitMode.Bbox, HitMode.Coverage]) {
          const low = fillHitShape(m.bundle, 40, 40, {
            mode,
            minAlpha: Math.max(0.01, alpha - 0.01),
          });
          const high = fillHitShape(m.bundle, 40, 40, { mode, minAlpha: alpha + 0.01 });
          assert(low >= 0 === alpha > 0.01, 'imported fade hit ' + [from, to, t, mode, alpha, low]);
          assert(high < 0, 'imported fade opacity threshold ' + [from, to, t, mode, alpha, high]);
          assert(fillHitShape(m.bundle, 90, 90, { mode }) < 0, 'imported fade exterior misses');
        }
      }
    } finally {
      m.dispose();
      a.dispose();
      b.dispose();
    }
  }
  ok('imported fade geometry, opacity thresholds and reverse pose order');
}
// Current-pose dashes use the lengths of the deformed path, including CPU hits.
{
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const { importSvg, createBundle, createShapeMorph } = await import('../src/index.js');
  const { gl } = createFakeGl();
  const svg = (t) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path id="p" d="M8 8L${32 - 24 * t} ${8 + 24 * t}L${56 - 48 * t} ${8 + 48 * t}" fill="none" stroke="black" stroke-width="2" stroke-dasharray="4 4"/></svg>`;
  const a = createBundle(gl, await importSvg(svg(0), { preserveViewport: true }));
  const b = createBundle(gl, await importSvg(svg(1), { preserveViewport: true }));
  const m = createShapeMorph(gl, a, b, { cpuLerp: true });
  try {
    for (const t of [0, 0.25, 0.5, 0.75, 1, 0.5, 0]) {
      m.setT(t);
      const dx = 24 * (1 - t),
        dy = 24 * t,
        length = Math.hypot(dx, dy);
      for (const f of [0.2, 0.3, 0.4, 0.6, 0.7, 0.8]) {
        const x = 8 + dx * (1 + f),
          y = 8 + dy * (1 + f);
        const phase = (length * (1 + f)) % 8;
        // Avoid a dash boundary's antialias ramp in this CPU membership test.
        if (Math.min(phase, Math.abs(phase - 4), 8 - phase) < 0.2) continue;
        assert(
          fillHitShape(m.bundle, x, y, HitMode.Outline) >= 0 === phase < 4,
          'current-pose dash hit ' + [t, f, phase],
        );
      }
    }
  } finally {
    m.dispose();
    a.dispose();
    b.dispose();
  }
  ok('deformed dash prefixes and reverse pose order');
}
// Arcs joins use current endpoint curvature, including a curve with two free ends.
{
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const { importSvg, createBundle, createShapeMorph } = await import('../src/index.js');
  for (const kind of ['quad', 'cubic', 'arc', 'quad-one', 'cubic-one']) {
    const d = (t) =>
      kind.startsWith('quad')
        ? 'M8 8Q' +
          (20 - 8 * t) +
          ' ' +
          (4 + 16 * t) +
          ' ' +
          (32 - 24 * t) +
          ' ' +
          (8 + 24 * t) +
          (kind === 'quad'
            ? 'Q' + (44 - 32 * t) + ' ' + (4 + 40 * t) + ' ' + (56 - 48 * t) + ' ' + (8 + 48 * t)
            : '')
        : kind.startsWith('cubic')
          ? 'M8 8C' +
            (12 + 2 * t) +
            ' ' +
            (2 + 10 * t) +
            ' ' +
            (24 - 16 * t) +
            ' ' +
            (2 + 20 * t) +
            ' ' +
            (32 - 24 * t) +
            ' ' +
            (8 + 24 * t) +
            (kind === 'cubic'
              ? 'C' +
                (36 - 28 * t) +
                ' ' +
                (4 + 28 * t) +
                ' ' +
                (50 - 40 * t) +
                ' ' +
                (4 + 40 * t) +
                ' ' +
                (56 - 48 * t) +
                ' ' +
                (8 + 48 * t)
              : '')
          : 'M8 8A20 16 0 0 1 ' +
            (32 - 24 * t) +
            ' ' +
            (8 + 24 * t) +
            'L' +
            (56 - 48 * t) +
            ' ' +
            (8 + 48 * t);
    const svg = (t) =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><path id="p" d="' +
      d(t) +
      '" fill="none" stroke="black" stroke-width="8" stroke-linejoin="arcs"/></svg>';
    let uploaded;
    const { gl: transport } = createFakeGl();
    const gl = new Proxy(transport, {
      get(target, key) {
        if (key === 'texSubImage2D')
          return (...args) => {
            if (args[4] === 4096 && args[8] instanceof Float32Array) uploaded = args[8].slice();
            return target[key](...args);
          };
        return target[key];
      },
    });
    const a = createBundle(gl, await importSvg(svg(0), { preserveViewport: true }));
    const b = createBundle(gl, await importSvg(svg(1), { preserveViewport: true }));
    const m = createShapeMorph(gl, a, b, { cpuLerp: true });
    try {
      assert(m.plan.matched.length === 1, 'current-curvature row matches');
      for (const t of [0, 0.5, 1, 0.5, 0]) {
        m.setT(t);
        const ref = await importSvg(svg(t), { preserveViewport: true }),
          expected = new Float32Array(ref.curves);
        const range = m.bundle.curveRangesByShape[0];
        let off = range.begin,
          other = ref.curveRangesByShape[0].begin;
        while (off < range.end) {
          const type = uploaded[off] & 3,
            len = type === 0 ? 12 : type === 3 ? 20 : 16;
          for (let k = 0; k < 4; k++)
            assert(
              Math.abs(uploaded[off + len + k] - expected[other + len + k]) <=
                3e-5 * Math.max(1, Math.abs(expected[other + len + k])),
              'current curvature ' + [kind, t, k],
            );
          off += len + 4;
          other += len + 4;
        }
      }
    } finally {
      m.dispose();
      a.dispose();
      b.dispose();
    }
  }
  ok('current arcs-join curvature and free-end records');
}

console.log('MORPH-HIT-POSE PASS');

// Production mask-paint queries sample current gradient stops, including cached/backward poses.
{
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const { importSvg, createBundle, createShapeMorph } = await import('../src/index.js');
  const { gl } = createFakeGl();
  const svg = (alpha) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g"><stop stop-color="white" stop-opacity="${alpha}"/><stop offset="1" stop-color="white" stop-opacity="${alpha}"/></linearGradient><mask id="mask" mask-type="alpha"><rect id="mask-paint" width="64" height="64" fill="url(#g)"/></mask></defs><rect id="main" width="64" height="64" fill="white" mask="url(#mask)"/></svg>`;
  const a = createBundle(gl, await importSvg(svg(0.8), { preserveViewport: true })),
    b = createBundle(gl, await importSvg(svg(0.2), { preserveViewport: true })),
    m = createShapeMorph(gl, a, b, { cpuLerp: true });
  try {
    for (const t of [0, 0.5, 1, 0.25, 0.75, 0.5, 0]) {
      m.setT(t);
      const ref = createBundle(
        gl,
        await importSvg(svg(0.8 * (1 - t) + 0.2 * t), { preserveViewport: true }),
      );
      try {
        for (const minAlpha of [0.25, 0.6, 0.9]) {
          const opts = { mode: HitMode.Coverage, minAlpha };
          assert(
            fillHitShape(m.bundle, 32, 32, opts) === fillHitShape(ref, 32, 32, opts),
            `current gradient mask hit t=${t} alpha=${minAlpha}`,
          );
        }
      } finally {
        ref.dispose();
      }
    }
    ok('current gradient mask hit poses');
  } finally {
    m.dispose();
    a.dispose();
    b.dispose();
  }
}

// Hit-only anchors follow merged paint order while geometry keeps stable row addresses.
{
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const I = await import('../src/index.js');
  const { gl } = createFakeGl();
  const rect = (id, fill = 'blue') =>
    `<rect id="${id}" x="5" y="5" width="20" height="20" fill="${fill}"/>`;
  const hit = (id) => rect(id, 'transparent');
  const group = (body) => `<g id="carried" opacity=".8">${body}</g>`;
  const load = async (body) =>
    I.createBundle(
      gl,
      await I.importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${body}</svg>`,
        { keepInvisibleShapes: false, keepHidden: true, preserveViewport: true },
      ),
    );
  const stack = (b, mode) =>
    I.fillHits(b, 15, 15, { mode }).map((row) => {
      const only = b._morphSrc && b._morphSrc.t >= 0.5 && b.hitOnlyTo ? b.hitOnlyTo : b.hitOnly;
      return row < b.numShapes ? b.shapeIds[row] : only.shapeIds[only.rows[row - b.numShapes]];
    });
  const cases = [
    [
      'sprite omitted anchors',
      rect('outsideS') + '<g id="target">' + rect('A') + rect('B') + '</g>' + rect('afterS'),
      hit('early') +
        rect('outsideD') +
        '<g id="target">' +
        rect('A') +
        rect('B') +
        '</g>' +
        hit('late') +
        rect('afterD'),
      hit('early') + rect('A') + rect('B') + hit('late'),
      1,
      false,
      true,
    ],
    [
      'neutral source end',
      rect('A') + rect('B') + hit('sourceHit'),
      group(rect('A') + rect('B')),
      rect('A') + rect('B') + hit('sourceHit'),
      0.25,
      true,
    ],
    [
      'relocated slots',
      rect('A') + rect('B'),
      rect('A') +
        hit('early1') +
        hit('early2') +
        rect('D') +
        hit('middle') +
        rect('B') +
        hit('tail'),
      rect('A') +
        hit('middle') +
        rect('B') +
        hit('early1') +
        hit('early2') +
        rect('D') +
        hit('tail'),
      1,
      false,
    ],
    [
      'source end',
      rect('A') + rect('B') + hit('sourceHit'),
      rect('A') + rect('B') + rect('D'),
      rect('A') + rect('B') + rect('D') + hit('sourceHit'),
      0.25,
      false,
    ],
    [
      'carried group',
      group(rect('A') + rect('B')),
      group(rect('A') + rect('D') + hit('middle') + rect('B')) + hit('tail'),
      null,
      1,
      true,
    ],
    [
      'carried group main only',
      group(rect('A') + rect('B')),
      group(rect('A') + rect('D') + rect('B')),
      null,
      1,
      true,
    ],
  ];
  for (const [name, source, destination, reference, t, grouped, sprite] of cases) {
    const a = await load(source),
      b = await load(destination),
      ref = await load(reference || destination);
    const morph = sprite
      ? I.createSpriteMorph(
          gl,
          { bundle: a, sprite: 'target' },
          { bundle: b, sprite: 'target' },
          { cpuLerp: true },
        )
      : I.createShapeMorph(gl, a, b, { cpuLerp: true });
    try {
      morph.setT(t);
      assert(
        morph.plan.matched.length >= 2 &&
          morph.plan.dstOnly.length === (sprite || name === 'neutral source end' ? 0 : 1),
        `${name}: matched rows and one destination-only row`,
      );
      if (grouped)
        assert(
          morph.bundle._drawOrder.some((row, i) => row !== i),
          `${name}: paint order differs from row addresses`,
        );
      for (const mode of Object.values(I.HitMode)) {
        const expected = stack(ref, mode),
          actual = stack(morph.bundle, mode);
        assert(
          JSON.stringify(actual) === JSON.stringify(expected),
          `${name}/${mode}: full stack follows independently authored merged paint order`,
        );
        assert(
          I.fillHitId(morph.bundle, 15, 15, { mode }) === (expected[0] || null),
          `${name}/${mode}: first hit follows full stack`,
        );
        const aRow = morph.bundle.shapeIds.indexOf('A'),
          bRow = morph.bundle.shapeIds.indexOf('B');
        const selected = I.fillHits(morph.bundle, 15, 15, {
          mode,
          sprite: [Math.min(aRow, bRow), Math.max(aRow, bRow)],
        }).map((row) => morph.bundle.shapeIds[row]);
        assert(
          JSON.stringify(selected) ===
            JSON.stringify(expected.filter((id) => id === 'A' || id === 'B')),
          `${name}/${mode}: sprite window preserves paint order`,
        );
      }
    } finally {
      morph.dispose();
      a.dispose();
      b.dispose();
      ref.dispose();
    }
  }
  // A neutral t=0 morph remains a valid endpoint even when its metadata rows have a different paint order.
  {
    const { createKeySpace } = await import('../src/animation/overrideKeys.js');
    const hidden = rect('H').replace(
      '<rect ',
      '<rect visibility="hidden" pointer-events="painted" ',
    );
    const body = (opacity) =>
      `<g id="chainG" opacity="${opacity}">${rect('A') + hidden + hit('A') + rect('B')}</g>`;
    const a = await load(body(1)),
      b = await load(body(0.8));
    for (const endpoint of [a, b]) {
      const h = endpoint.hitOnly,
        slot = Array.from(h.rows).findIndex((row) => h.shapeIds[row] === 'A');
      assert(
        slot >= 0 && h.hiddenOwner,
        'chain fixture has actual hidden ownership and an independent repeated-ID target',
      );
      h.hiddenOwner[slot] = -2;
    }
    const first = I.createShapeMorph(gl, a, b, { cpuLerp: true });
    first.setT(0);
    const chain = I.createShapeMorph(gl, first.bundle, first.bundle, { cpuLerp: true });
    chain.setT(0);
    try {
      assert(
        first.plan.dstOnly.length === 0 &&
          first.plan.matched.length === first.bundle.numShapes &&
          first.bundle._drawOrder.some((row, i) => row !== i),
        'chain endpoint is fully matched, neutral and has nonidentity paint order',
      );
      const names = (bundle) =>
        I.fillHits(bundle, 15, 15).map((row) =>
          row < bundle.numShapes
            ? bundle.shapeIds[row]
            : 'hit:' + bundle.hitOnly.shapeIds[bundle.hitOnly.rows[row - bundle.numShapes]],
        );
      assert(
        JSON.stringify(names(chain.bundle)) === JSON.stringify(names(a)),
        'chaining decodes prepared paint ranks before relocating anchors',
      );
      const pairs = (bundle, h) =>
        Array.from(h.rows, (row, k) => [
          h.shapeIds[row],
          h.hiddenOwner[k],
          bundle.groupTree.groupNames[h.rowGroup[k]],
        ]);
      assert(
        JSON.stringify(pairs(first.bundle, first.bundle.hitOnly)) ===
          JSON.stringify(pairs(chain.bundle, chain.bundle.hitOnlyTo)),
        'chain preserves paired owners, declined-owner sentinels and group membership',
      );
      const ho = chain.bundle.hitOnlyTo,
        slot = Array.from(ho.rows).findIndex((row) => ho.shapeIds[row] === 'A');
      const space = createKeySpace(
        { ...chain.bundle, _morphBindingAliases: null, hitOnly: ho },
        chain.bundle.numShapes,
      );
      assert(
        !(space.companions?.get(chain.bundle.shapeIds.indexOf('A')) || []).includes(
          chain.bundle.numShapes + slot,
        ),
        'declined owner is not inferred again from its authored ID',
      );
    } finally {
      chain.dispose();
      first.dispose();
      a.dispose();
      b.dispose();
    }
  }
  ok('merged morph hit anchors and carried-group paint order');
}
