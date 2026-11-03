// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneSurfaceSmoke.mjs: scene composition, the native scene's arguments and the wire contract (node, CPU only).
//   createMantleScene(...).toScene(sections) is memoized on WebGL
//   the native scene validates its arguments like the GL renderer
//   sceneToSections yields what sceneToBundle yields: same hit answers, ranges, hit bits and ids
//   stroke.fill.opacity, tail, number validation, relative precision, root exports
//   createBundle fails cleanly on truncated, tampered or JSON-round-tripped sections
import { M, wrap, imp, dom, els, check, finish } from './_exportHarness.mjs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

const gl = createFakeGl({ width: 64, height: 64 }).gl;
const throwsMsg = (f) => {
  try {
    f();
    return null;
  } catch (e) {
    return String(e && e.message);
  }
};
const throwsAsync = async (f) => {
  try {
    await f();
    return null;
  } catch (e) {
    return String(e && e.message);
  }
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const F = createFakeGl({ width: 128, height: 128 });
  let textures = 0;
  const ct = F.gl.createTexture.bind(F.gl);
  F.gl.createTexture = () => {
    textures++;
    return ct();
  };
  const canvas = { getContext: () => F.gl, width: 128, height: 128 };
  const scene = await M.createMantleScene(canvas, { shaders: taggedShaderSources() });
  scene.setViewport(128, 128);
  const sections = await imp(wrap('<rect width="50" height="50" fill="red"/>'));
  const first = scene.toScene(sections);
  // (the bundle's first draw may make its one-time GPU resources: a small-shape point route's row table is a texture since the points are generated in the
  //  vertex shader; memoization is about the frames AFTER it, which must make nothing new)
  scene.beginFrame([1, 1, 1, 1]);
  scene.drawBundle(scene.toScene(sections), {});
  scene.endFrame();
  const after = textures;
  for (let f = 0; f < 30; f++) {
    scene.beginFrame([1, 1, 1, 1]);
    scene.drawBundle(scene.toScene(sections), {});
    scene.endFrame();
  }
  check(
    'toScene(sections) in the frame loop returns the one bundle',
    scene.toScene(sections) === first,
  );
  check('the frame loop uploaded no new textures for it', textures - after === 0, textures - after);
  check(
    'another sections object gets its own bundle',
    scene.toScene(await imp(wrap('<rect width="9" height="9"/>'))) !== first,
  );
  const withOpts = scene.toScene(sections, { recolor: true });
  check(
    'different options get a different bundle, itself memoized',
    withOpts !== first && scene.toScene(sections, { recolor: true }) === withOpts,
  );
  first.dispose();
  const rebuilt = scene.toScene(sections);
  check('a disposed bundle is rebuilt', rebuilt !== first && !rebuilt._disposed);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const b = await imp(wrap('<rect id="a" width="10" height="10" fill="red"/>'));
  const host = () => dom.createElement('div');
  check(
    'createNativeScene(null) throws',
    /host required/.test(throwsMsg(() => M.createNativeScene(null, { document: dom })) || ''),
  );
  const sc = M.createNativeScene(host(), { document: dom, coordinateSpace: 'viewport' });
  check(
    'setViewport(NaN) throws',
    /setViewport: width must be a number/.test(throwsMsg(() => sc.setViewport(NaN, 5)) || ''),
  );
  check(
    'setViewport("a") throws',
    /setViewport/.test(throwsMsg(() => sc.setViewport('a', 'b')) || ''),
  );
  sc.setViewport(-5, 0);
  check(
    'setViewport(-5, 0) clamps to 1x1',
    sc.svg.getAttribute('viewBox') === '0 0 1 1',
    sc.svg.getAttribute('viewBox'),
  );
  sc.setViewport(10.9);
  check(
    'setViewport(w) truncates and uses w for the height',
    sc.svg.getAttribute('viewBox') === '0 0 10 10',
    sc.svg.getAttribute('viewBox'),
  );
  check(
    'setScissorRect(NaN, ...) throws',
    /setScissorRect/.test(throwsMsg(() => sc.setScissorRect(NaN, 0, 1, 1)) || ''),
  );
  sc.beginFrame([1, 1, 1, 1]);
  let r = 'unset';
  const msg = throwsMsg(() => {
    r = sc.drawBundle(null, {});
  });
  sc.endFrame();
  check(
    'drawBundle(null) returns false instead of throwing',
    msg === null && r === false,
    msg + ' ' + r,
  );
  sc.dispose();
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const S = await import('../src/scene/index.js');
  const red = { kind: 'solid', color: [1, 0, 0, 1] };
  const cases = {
    plain: { shapes: [{ id: 'a', contours: [M.rectContour(10, 10, 40, 30)], fill: red }] },
    rotated: {
      transform: [Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 30, 5],
      shapes: [{ id: 'a', contours: [M.rectContour(0, 0, 40, 30)], fill: red }],
    },
    evenodd: {
      shapes: [
        {
          id: 'a',
          contours: [M.rectContour(0, 0, 80, 80), M.rectContour(20, 20, 40, 40)],
          fill: { ...red, mode: 'evenodd' },
        },
      ],
    },
    nonzeroHole: {
      shapes: [
        {
          id: 'a',
          contours: [M.rectContour(0, 0, 80, 80), M.rectContour(20, 20, 40, 40)],
          fill: red,
        },
      ],
    },
    fillNull: {
      shapes: [
        { id: 'a', contours: [M.rectContour(0, 0, 50, 50)], fill: null },
        { id: 'b', contours: [M.rectContour(60, 0, 20, 20)], fill: red },
      ],
    },
    alpha: {
      shapes: [
        {
          id: 'a',
          contours: [M.rectContour(0, 0, 50, 50)],
          fill: { kind: 'solid', color: [1, 0, 0, 0.5], opacity: 0.5 },
        },
      ],
    },
    transparent: {
      shapes: [
        {
          id: 'a',
          contours: [M.rectContour(0, 0, 50, 50)],
          fill: { kind: 'solid', color: [1, 0, 0, 0] },
        },
      ],
    },
    open: {
      shapes: [
        {
          id: 'a',
          contours: [
            {
              segments: [
                [0, 0],
                [50, 0],
                [50, 50],
              ].map((p) => S.lineSeg(p)),
              closed: false,
            },
          ],
          fill: red,
        },
      ],
    },
    quad: {
      shapes: [
        {
          id: 'a',
          contours: [
            {
              segments: [S.quadSeg([0, 0], [50, 0]), S.lineSeg([50, 50]), S.lineSeg([0, 50])],
              closed: true,
            },
          ],
          fill: red,
        },
      ],
    },
    noId: {
      shapes: [
        { contours: [M.rectContour(0, 0, 50, 50)], fill: red },
        { contours: [M.rectContour(60, 0, 20, 20)], fill: red },
      ],
    },
    emptyContours: {
      shapes: [
        { id: 'a', contours: [{ segments: [], closed: true }], fill: red },
        { id: 'b', contours: [M.rectContour(0, 0, 10, 10)], fill: red },
      ],
    },
    nested: {
      transform: [1, 0, 0, 1, 10, 0],
      children: [
        {
          transform: [2, 0, 0, 1, 0, 10],
          shapes: [{ id: 'a', contours: [M.rectContour(0, 0, 20, 20)], fill: red }],
        },
      ],
    },
    mirrored: {
      transform: [-1, 0, 0, 1, 100, 0],
      shapes: [{ id: 'a', contours: [M.rectContour(0, 0, 40, 40)], fill: red }],
    },
  };
  for (const [name, root] of Object.entries(cases)) {
    const scene = M.createScene();
    scene.root.shapes = root.shapes || [];
    scene.root.children = root.children || [];
    if (root.transform) scene.root.transform = root.transform;
    const viewBox = [0, 0, 100, 100];
    const viaSvg = await M.sceneToBundle(scene, { viewBox }),
      direct = await M.sceneToSections(scene, { viewBox });
    const A = M.createBundle(gl, viaSvg),
      B = M.createBundle(gl, direct);
    let diff = 0,
      hitsA = 0;
    for (const mode of [undefined, M.HitMode.Bbox, M.HitMode.Coverage, M.HitMode.Outline]) {
      const o = mode === undefined ? {} : { mode };
      for (let j = 0; j < 50; j++)
        for (let i = 0; i < 50; i++) {
          const x = i * 2 + 1,
            y = j * 2 + 1;
          const p = M.fillHitShape(A, x, y, o),
            q = M.fillHitShape(B, x, y, o);
          if (mode === undefined && p >= 0) hitsA++;
          if (p !== q) diff++;
        }
    }
    const same = (k) => JSON.stringify(viaSvg[k]) === JSON.stringify(direct[k]);
    check(
      `${name}: hit answers equal in every mode (${hitsA} default-mode hits)`,
      diff === 0,
      diff + ' differ',
    );
    check(
      `${name}: shapeIds, curveRangesByShape, numShapes equal`,
      same('shapeIds') && same('curveRangesByShape') && viaSvg.numShapes === direct.numShapes,
      JSON.stringify([
        viaSvg.shapeIds,
        direct.shapeIds,
        viaSvg.curveRangesByShape,
        direct.curveRangesByShape,
      ]),
    );
    check(
      `${name}: hitBits equal and no hit-only table`,
      (direct.numShapes === 0 ||
        (direct.hitBits &&
          Array.from(direct.hitBits).join() === Array.from(viaSvg.hitBits).join())) &&
        !direct.hitOnly === !viaSvg.hitOnly,
      `${direct.hitBits} ${viaSvg.hitBits} ${!!viaSvg.hitOnly}`,
    );
  }
  // A direct-path scene with a fully transparent fill must still be hit-testable like the importer's.
  const scene = M.createScene();
  scene.root.shapes = cases.transparent.shapes;
  const sec = await M.sceneToSections(scene, { viewBox: [0, 0, 100, 100] });
  check(
    'a transparent-fill scene routes through the importer (version stamped)',
    sec.version === 3,
    Object.keys(sec).join(),
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const mk = (stroke, contour = M.rectContour(0, 0, 10, 10)) => {
    const s = M.createScene();
    s.root.shapes.push({ contours: [contour], fill: null, pathProps: { stroke } });
    return s;
  };
  let svg = M.sceneToSvg(
    mk({ fill: { kind: 'solid', color: [1, 0, 0, 1], opacity: 0.5 }, halfThickness: 1 }),
  );
  check('stroke.fill.opacity is written as stroke-opacity', /stroke-opacity="0\.5"/.test(svg), svg);
  svg = M.sceneToSvg(
    mk({ fill: { kind: 'solid', color: [1, 0, 0, 0.5], opacity: 0.5 }, halfThickness: 1 }),
  );
  check('stroke opacity multiplies the color alpha', /stroke-opacity="0\.25"/.test(svg), svg);
  svg = M.sceneToSvg(
    mk({
      fill: {
        kind: 'gradient',
        type: 'linear',
        stops: [
          { position: 0, color: [1, 0, 0, 1] },
          { position: 1, color: [0, 0, 1, 1] },
        ],
        opacity: 0.4,
      },
      halfThickness: 1,
    }),
  );
  check('a gradient stroke honors fill.opacity', /stroke-opacity="0\.4"/.test(svg), svg);
  svg = M.sceneToSvg(
    mk({ fill: { kind: 'solid', color: [0, 0, 0, 1] }, halfThickness: 1, tail: 'round' }),
  );
  check('tail stands in when head is absent', /stroke-linecap="round"/.test(svg), svg);
  svg = M.sceneToSvg(
    mk({
      fill: { kind: 'solid', color: [0, 0, 0, 1] },
      halfThickness: 1,
      head: 'square',
      tail: 'square',
    }),
  );
  check('head sets the cap', /stroke-linecap="square"/.test(svg), svg);

  for (const [name, v] of [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['1e21', 1e21],
  ]) {
    const m = throwsMsg(() =>
      M.sceneToSvg(
        mk(
          { fill: { kind: 'solid', color: [0, 0, 0, 1] }, halfThickness: 1 },
          M.rectContour(0, 0, v, 10),
        ),
      ),
    );
    check(`sceneToSvg rejects ${name} in a coordinate`, /finite number/.test(m || ''), m);
  }
  const bad = M.createScene();
  bad.root.shapes.push({
    contours: [M.rectContour(0, 0, NaN, 10)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  check(
    'sceneToSections (direct path) rejects NaN',
    /finite number/.test((await throwsAsync(() => M.sceneToSections(bad))) || ''),
  );
  check(
    'sceneToBundle rejects NaN',
    /finite number/.test((await throwsAsync(() => M.sceneToBundle(bad))) || ''),
  );

  const small = M.createScene();
  small.root.shapes.push({
    contours: [M.rectContour(0.0001234567, 0, 0.0002, 0.0003)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const ssvg = M.sceneToSvg(small, [0, 0, 1, 1]);
  check(
    'small coordinates keep relative precision',
    /M0\.0001234567 0L0\.0003234567 0/.test(ssvg),
    ssvg,
  );
  const big = M.createScene();
  big.root.shapes.push({
    contours: [M.rectContour(10.5, 100.25, 1234.5, 3)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  check(
    'coordinates of 1 or more print as before (six decimals, trailing zeros stripped)',
    /M10\.5 100\.25L1245 100\.25/.test(M.sceneToSvg(big)),
    M.sceneToSvg(big),
  );
  check(
    'lineSeg, quadSeg and polylineContour are exported from the root',
    typeof M.lineSeg === 'function' &&
      typeof M.quadSeg === 'function' &&
      typeof M.polylineContour === 'function',
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const base = await M.importSvg(
    wrap(
      '<rect id="a" width="50" height="50" fill="red" stroke="#000" stroke-dasharray="3 2"/><circle cx="70" cy="70" r="20" fill="blue"/>',
    ),
    {},
  );
  const clone = () => structuredClone(base);
  const cases = {
    noMeta: [
      (s) => {
        delete s.meta;
        return s;
      },
      /sections\.meta must be an ArrayBuffer/,
    ],
    metaTrunc40: [
      (s) => {
        s.meta = s.meta.slice(0, 40);
        return s;
      },
      /meta\.bin size mismatch/,
    ],
    noCurves: [
      (s) => {
        delete s.curves;
        return s;
      },
      /sections\.curves must be an ArrayBuffer/,
    ],
    noBands: [
      (s) => {
        s.bands = null;
        return s;
      },
      /sections\.bands must be an ArrayBuffer/,
    ],
    curvesTrunc: [
      (s) => {
        s.curves = s.curves.slice(0, 64);
        return s;
      },
      /outside sections\.curves/,
    ],
    numShapes999: [
      (s) => {
        s.numShapes = 999;
        return s;
      },
      /does not match the meta header/,
    ],
    numShapesNaN: [
      (s) => {
        s.numShapes = NaN;
        return s;
      },
      /does not match the meta header/,
    ],
    version99: [
      (s) => {
        s.version = 99;
        return s;
      },
      /unsupported sections\.version/,
    ],
    gradientsWrongType: [
      (s) => {
        s.gradients = { a: 1 };
        return s;
      },
      /sections\.gradients must be an ArrayBuffer or null/,
    ],
    nullInput: [() => null, /sections must be an object/],
    stringInput: [() => 'abc', /sections must be an object/],
    jsonRoundTrip: [
      (s) => JSON.parse(JSON.stringify(s)),
      /sections\.meta must be an ArrayBuffer, got a plain object/,
    ],
  };
  for (const [name, [mutate, re]] of Object.entries(cases)) {
    const msg = throwsMsg(() => M.createBundle(gl, mutate(clone())));
    check(
      `${name} fails cleanly`,
      msg !== null && re.test(msg) && !/byteLength|DataView|undefined/.test(msg),
      msg,
    );
  }
  check('an untouched clone still builds', throwsMsg(() => M.createBundle(gl, clone())) === null);
  check(
    'the meta header carries the tag (magic at byte 20, version 2 at byte 24) and a zero pad word',
    new DataView(base.meta).getUint32(20, true) === 0x4c544e4d &&
      new DataView(base.meta).getUint32(24, true) === 2 &&
      new DataView(base.meta).getUint32(28, true) === 0,
  );
}

finish('sceneSurfaceSmoke');
