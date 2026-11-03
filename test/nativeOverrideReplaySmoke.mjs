// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeOverrideReplaySmoke -- the native scene's draw state across frames, on an override table that has not changed, and its bake.
//
// A table whose generation has not moved skips its scan, and the attributes its last pass wrote are kept alive by replaying their names. That replay must not
//   recolor its own result (a per-draw tint composed on last frame's output would take an overridden fill 128, 64, 32, 16 at a constant tint of 0.5);
//   keep a recolor that has gone (the attribute would hold the recolored value for as long as the table holds);
//   carry what the pass did not write (a sprite's hide, recorded along with the element's overrides, would keep the next sprite hidden and the frame blank);
//   or restore nothing: a hidden draw, or a draw without the table, reverts the attributes, and they come back while the generation holds.
// The static-cache bake draws the inked box, not the whole viewBox squeezed into it (which draws a shape inside its document shrunken), and draws the draw's own
// state, not the source as authored (overrides, a tint and a blend mode would vanish once the bitmap is ready). A scissor keeps no insets of a previous viewport
// across setViewport, drawImage writes no NaN matrix into the markup (it hides, as drawBundle does), and setClipper on a <mask> writes no transform SVG does not honor there.
// Beyond those: morph geometry written straight onto the clone does not outlive its morph (a new morph of the bundle at the same step count is drawn, a disposed one leaves
// no pose, a primitive swapped for a path keeps its geometry), a timeline leaves no tween on the poses behind it, injected shapes do not outlive their table, the instanced
// template path draws inside a frame, the scissor takes y as its bottom as WebGL does, and the export's frame log holds matrices by value, so each instance keeps its own tint.
// CPU (test/_exportHarness.mjs: the real scene on a DOM shim over xmldom). No pixels: the claim is the markup and the bitmap's placement.
const { M, wrap, imp, dom, els, check, finish, mkRenderer, exportDetail } =
  await import('./_exportHarness.mjs');
const idOf = (e) => e.getAttribute('data-oid') || e.getAttribute('id') || '';
const elOf = (scene, id) => els(scene.svg).find((e) => idOf(e) === id);
const newScene = () => {
  const scene = M.createNativeScene(dom.createElement('div'), { document: dom });
  scene.setViewport(100, 100);
  return scene;
};
const frame = (scene, draw, clear = [1, 1, 1, 1]) => {
  scene.beginFrame(clear);
  draw();
  scene.endFrame();
};
const TWO = wrap(
  '<rect id="a" x="10" y="10" width="20" height="20" fill="#808080"/><rect id="b" x="40" y="10" width="20" height="20" fill="#808080"/>',
);

{
  // a constant tint on an unchanged table
  const B = await imp(TWO),
    scene = newScene(),
    T = M.createNativeOverrideTable(B);
  T.set('a', { fill: [1, 0, 0, 1] });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    frame(scene, () => scene.drawBundle(B, { overrides: T, tint: [0.5, 0.5, 0.5, 1] }));
    seen.push(elOf(scene, 'a').getAttribute('fill'));
  }
  check(
    'a constant tint does not compound on an unchanged table',
    seen.every((v) => v === 'rgba(128,0,0,1)'),
    seen.join(' '),
  );
  check(
    '(control) a row with no override keeps its tinted authored paint',
    elOf(scene, 'b').getAttribute('fill') === 'rgba(64,64,64,1)',
    elOf(scene, 'b').getAttribute('fill'),
  );
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    "a recolor that has gone leaves the override's own value",
    elOf(scene, 'a').getAttribute('fill') === 'rgba(255,0,0,1)',
    elOf(scene, 'a').getAttribute('fill'),
  );
  frame(scene, () => scene.drawBundle(B, { overrides: T, tint: [0.25, 0.25, 0.25, 1] }));
  check(
    "a changed tint composes on the override's own value",
    elOf(scene, 'a').getAttribute('fill') === 'rgba(64,0,0,1)',
    elOf(scene, 'a').getAttribute('fill'),
  );
}
{
  // the sprite that was hidden
  const B = await imp(TWO),
    scene = newScene(),
    T = M.createNativeOverrideTable(B);
  T.set('a', { tint: [0, 1, 0, 1] });
  T.set('b', { tint: [1, 0, 0, 1] });
  const display = (id) => elOf(scene, id).style.getPropertyValue('display');
  frame(scene, () => scene.drawSprite(B, 'a', { overrides: T }));
  check('sprite a is drawn, b hidden', display('a') !== 'none' && display('b') === 'none');
  frame(scene, () => scene.drawSprite(B, 'b', { overrides: T }));
  check(
    "the next sprite is drawn: the hide is not the override pass's to keep",
    display('b') !== 'none' && display('a') === 'none',
    `a ${display('a')} b ${display('b')}`,
  );
}
{
  // a draw that dropped the attributes
  const B = await imp(TWO),
    scene = newScene(),
    T = M.createNativeOverrideTable(B);
  T.set('a', { fill: [1, 0, 0, 1] });
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  frame(scene, () => scene.drawBundle(B, { overrides: T, hidden: true }));
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    'an override survives a hidden draw',
    elOf(scene, 'a').getAttribute('fill') === 'rgba(255,0,0,1)',
    elOf(scene, 'a').getAttribute('fill'),
  );
  frame(scene, () => scene.drawBundle(B));
  check(
    '(control) a draw without the table reverts it',
    elOf(scene, 'a').getAttribute('fill') === '#808080',
    elOf(scene, 'a').getAttribute('fill'),
  );
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    'the table drawn again applies again',
    elOf(scene, 'a').getAttribute('fill') === 'rgba(255,0,0,1)',
    elOf(scene, 'a').getAttribute('fill'),
  );
}
{
  // the bake
  let blob = null;
  const pending = [],
    realBlob = globalThis.Blob,
    realImage = globalThis.Image,
    create = URL.createObjectURL,
    revoke = URL.revokeObjectURL,
    ce = dom.createElement;
  globalThis.Blob = class {
    constructor(parts) {
      blob = parts.join('');
    }
  };
  URL.createObjectURL = () => 'blob:bake';
  URL.revokeObjectURL = () => {};
  globalThis.Image = class {
    set src(_v) {
      pending.push(this);
    }
  };
  dom.createElement = function (t) {
    const e = ce.call(this, t);
    if (t === 'canvas') {
      e.getContext = () => ({ drawImage() {} });
      e.toDataURL = () => 'data:image/png;base64,BAKED';
    }
    return e;
  };
  try {
    const SOURCE = wrap(
      '<rect id="c" x="40" y="40" width="20" height="20" fill="#808080"/>',
      'width="500" height="250" viewBox="0 0 100 100"',
    );
    const B = await imp(SOURCE),
      scene = newScene();
    check(
      '(premise) the inked box is not the document',
      String(B.globalBBox) !== String(B.viewBox),
      String(B.globalBBox),
    );
    const h = scene.createBundleHandle(B, { staticCache: {} });
    frame(scene, () => h.draw());
    for (const im of pending.splice(0)) im.onload();
    check('(control) a plain draw bakes', h.staticCache.isCacheValid);
    frame(scene, () =>
      h.draw({ worldMatrix: new Float32Array([2, 0, 0, 0, 2, 0, 1, 2, 1]), alpha: 0.5 }),
    );
    const img = els(scene.svg).find((e) => e.tagName === 'image');
    check(
      '(control) the bitmap carries the matrix and the alpha',
      !!img &&
        img.parentNode.getAttribute('opacity') === '0.5' &&
        /^matrix/.test(img.parentNode.getAttribute('transform') || ''),
    );
    const rect = img && ['x', 'y', 'width', 'height'].map((k) => img.getAttribute(k)).join(' ');
    const root = (blob.match(/<svg\b[^>]*>/) || [''])[0];
    const vb = (root.match(/viewBox="([^"]*)"/) || [])[1];
    check(
      'the bitmap is drawn back at the box its document shows',
      vb === rect,
      `document ${vb}, drawn at ${rect}`,
    );
    check(
      'the document has one size and no letterbox',
      /\swidth="\d+"/.test(root) &&
        !/width="500"/.test(root) &&
        /preserveAspectRatio="none"/.test(root),
      root,
    );
    for (const [name, opts] of [
      ['tint', { tint: [1, 0, 0, 1] }],
      ['blend mode', { blendMode: 1 }],
      ['bad matrix', { worldMatrix: new Float32Array(9).fill(NaN) }],
      ['sprite subset', { shapeRange: [0, 0] }],
    ]) {
      frame(scene, () => h.draw(opts));
      check(
        `a draw with a ${name} is drawn live, not as the bitmap`,
        !els(scene.svg).some((e) => e.tagName === 'image'),
      );
    }
    const T = M.createNativeOverrideTable(B);
    frame(scene, () => h.draw({ overrides: T }));
    for (const im of pending.splice(0)) im.onload();
    frame(scene, () => h.draw({ overrides: T }));
    check(
      '(control) a table with no row set can use the bitmap',
      els(scene.svg).some((e) => e.tagName === 'image'),
    );
    T.set('c', { visibility: 0 });
    frame(scene, () => h.draw({ overrides: T }));
    check(
      'a table with a row set is drawn live',
      !els(scene.svg).some((e) => e.tagName === 'image') &&
        elOf(scene, 'c').style.getPropertyValue('display') === 'none',
    );
  } finally {
    globalThis.Blob = realBlob;
    globalThis.Image = realImage;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    dom.createElement = ce;
  }
}
{
  // an animated mask: <mask> takes no transform, its content does
  const B = await imp(
    wrap(
      '<defs><mask id="m"><rect id="mr" x="10" y="10" width="20" height="20" fill="#fff" transform="scale(2)"/></mask><clipPath id="c"><rect id="cr" width="10" height="10"/></clipPath></defs><rect id="s" width="50" height="50" mask="url(#m)"/><rect id="u" width="50" height="50" clip-path="url(#c)"/>',
    ),
  );
  const scene = newScene(),
    T = M.createNativeOverrideTable(B);
  T.setClipper('m', { localPosition: [10, 0] });
  T.setClipper('c', { localPosition: [10, 0] });
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    'setClipper on a mask moves its content, after the authored transform',
    /^translate\(10 0\).* scale\(2\)$/.test(elOf(scene, 'mr').getAttribute('transform') || ''),
    elOf(scene, 'mr').getAttribute('transform'),
  );
  check(
    '(control) setClipper on a clipPath stays on the element',
    /^translate\(10 0\)/.test(elOf(scene, 'c').getAttribute('transform') || ''),
    elOf(scene, 'c').getAttribute('transform'),
  );
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    'it holds on an unchanged table',
    /^translate\(10 0\)/.test(elOf(scene, 'mr').getAttribute('transform') || ''),
    elOf(scene, 'mr').getAttribute('transform'),
  );
  T.clearClipper('m');
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check(
    'clearClipper restores the authored transform',
    elOf(scene, 'mr').getAttribute('transform') === 'scale(2)',
    elOf(scene, 'mr').getAttribute('transform'),
  );
}
{
  // the scissor's insets
  const scene = newScene();
  scene.setScissorRect(0, 0, 50, 50);
  check(
    "the rect's origin is its lower left, as on WebGL: this one is the bottom-left quarter",
    scene.svg.style.clipPath === 'inset(50px 50px 0px 0px)',
    scene.svg.style.clipPath,
  );
  scene.setViewport(200, 200);
  check(
    'a resize keeps the rect: the far insets follow the viewport',
    scene.svg.style.clipPath === 'inset(150px 150px 0px 0px)',
    scene.svg.style.clipPath,
  );
}
{
  // drawImage's matrix
  const scene = newScene();
  frame(scene, () =>
    scene.drawImage('data:image/png;base64,AA==', {
      dstRect: [0, 0, 10, 10],
      worldMatrix: new Float32Array(9).fill(NaN),
    }),
  );
  const markup = new XMLSerializer().serializeToString(scene.svg);
  check('a NaN matrix does not reach the markup', !/NaN/.test(markup), markup.slice(0, 200));
}
const SHAPE = (x) => wrap(`<path id="s" d="M${x} 10H${x + 20}V30H${x}Z" fill="#111"/>`);
const dOf = (scene) => elOf(scene, 's').getAttribute('d');
{
  // a morph of a bundle ends: its geometry goes with it
  const A = await imp(SHAPE(0)),
    B = await imp(SHAPE(40)),
    C = await imp(SHAPE(60)),
    scene = newScene();
  const m1 = M.createNativeMorph(A, B);
  m1.setT(0.5);
  frame(scene, () => scene.drawBundle(m1.bundle));
  check('(control) the morph is drawn', /^M20 10/.test(dOf(scene)), dOf(scene));
  m1.dispose();
  const m2 = M.createNativeMorph(A, C);
  m2.setT(0.5);
  frame(scene, () => scene.drawBundle(m2.bundle));
  check(
    'a new morph of the bundle at the same step count is drawn, not the previous one',
    /^M30 10/.test(dOf(scene)),
    dOf(scene),
  );
  m2.dispose();
  frame(scene, () => scene.drawBundle(A));
  check('a disposed morph leaves the pose as authored', /^M0 10/.test(dOf(scene)), dOf(scene));
}
{
  // ...and a primitive it swapped for a <path> comes back with its geometry
  const A = await imp(wrap('<rect id="s" x="10" y="10" width="20" height="20" fill="#f00"/>')),
    B = await imp(wrap('<rect id="s" x="10" y="10" width="40" height="20" fill="#00f"/>')),
    scene = newScene();
  const m = M.createNativeMorph(A, B);
  m.setT(0.5);
  frame(scene, () => scene.drawBundle(m.bundle, { overrides: m.overrides }));
  check(
    '(control) the primitive is drawn as a path',
    els(scene.svg).some((e) => e.tagName === 'path' && e.getAttribute('d')),
  );
  m.dispose();
  frame(scene, () => scene.drawBundle(A));
  const after = elOf(scene, 's');
  check(
    'after dispose the shape still has geometry',
    after.tagName === 'rect' ? after.getAttribute('width') === '20' : !!after.getAttribute('d'),
    new XMLSerializer().serializeToString(after),
  );
}
{
  // a timeline moving on
  const a = await imp(SHAPE(0)),
    b = await imp(SHAPE(40)),
    c = await imp(SHAPE(60));
  const T = M.createNativeTimeline(
    [a, b, c],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
      { time: 2, bundleIndex: 2 },
    ],
  );
  T.setTime(0.5);
  T.setTime(1.5);
  check(
    'the pose a timeline has left carries no tween',
    !a.__nativeMorphOverrides && !a.__streamPathD,
  );
  const scene = newScene();
  frame(scene, () => scene.drawBundle(a));
  check('and draws as authored', /^M0 10/.test(dOf(scene)), dOf(scene));
  frame(scene, () => scene.drawBundle(T.bundle, { overrides: T.overrides }));
  check('(control) the timeline draws its bracket', /^M50 10/.test(dOf(scene)), dOf(scene));
  T.dispose();
  check('a disposed timeline leaves its pose clean', !b.__nativeMorphOverrides && !b.__streamPathD);
}
{
  // injected shapes follow their table
  const B = await imp(wrap('<rect id="a" x="10" y="10" width="20" height="20" fill="#111"/>')),
    scene = newScene(),
    T = M.createNativeOverrideTable(B);
  T.setExtraShapes([{ key: 'x', pathD: 'M0 0H1V1Z', fill: [1, 0, 0, 1], alpha: 1 }]);
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check('(control) the table injects its shape', els(scene.svg, 'path').length === 1);
  frame(scene, () => scene.drawBundle(B));
  check('a draw without the table does not draw it', els(scene.svg, 'path').length === 0);
  frame(scene, () => scene.drawBundle(B, { overrides: T }));
  check('the table drawn again injects it again', els(scene.svg, 'path').length === 1);
}
{
  // the instanced template path keeps drawBundle's contract
  const B = await imp(wrap('<rect id="a" x="10" y="10" width="20" height="20" fill="#111"/>')),
    scene = newScene();
  let threw = false;
  try {
    scene.drawBundleInstanced(B, [{}, {}]);
  } catch {
    threw = true;
  }
  check('drawBundleInstanced outside a frame throws, as drawBundle does', threw);
}
{
  // the frame log owns what it records
  const { R, bundle } = await mkRenderer(100, 100);
  const b = await bundle(
    wrap('<rect id="a" x="10" y="10" width="20" height="20" fill="#808080"/>'),
  );
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundleInstanced(b, [{ tint: [1, 0, 0, 1] }, { tint: [0, 1, 0, 1] }]);
  R.endFrame();
  let svg = (await exportDetail(R)).svg;
  check(
    "an export keeps each instance's tint",
    /rgba\(128,0,0,1\)/.test(svg) && /rgba\(0,128,0,1\)/.test(svg),
    svg.slice(0, 300),
  );
  const shared = new Float32Array([1, 0, 0, 0, 1, 0, 3, 0, 1]);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { worldMatrix: shared });
  shared[6] = 7;
  R.drawBundle(b, { worldMatrix: shared });
  R.endFrame();
  svg = (await exportDetail(R, { coordinateSpace: 'bundle' })).svg;
  check(
    'an export keeps the matrix each draw had, when the caller reuses one',
    /matrix\(1,0,0,1,3,0\)/.test(svg) && /matrix\(1,0,0,1,7,0\)/.test(svg),
    svg.slice(0, 400),
  );
  R.dispose();
}
finish('nativeOverrideReplaySmoke');
