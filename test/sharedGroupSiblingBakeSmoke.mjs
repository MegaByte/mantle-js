// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sharedGroupSiblingBakeSmoke -- members of a shared static-cache group never blit a raster that shows something else.
//
// A member's isCacheValid is its own flag, and the raster is shared: when one member's per-draw state changed and it baked again, the others went on blitting that bake (a sibling drawn untinted showed the tint).
// One raster cannot show two contents, so the member that finds it in use by another draws live; an equal bake is adopted. CPU, recording GL stand-in: which program drew where, from which texture.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, CacheStrategy } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M40 40 L60 40 L50 60 Z" fill="#d33"/></svg>';
const TINT = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
const rig = async () => {
  const F = createFakeGl({ width: 256, height: 256 });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setViewport(256, 256);
  const bundle = createBundle(F.gl, await importSvg(SVG, { preserveViewport: true }));
  const cfg = {
    staticCache: { strategy: CacheStrategy.ForceSharedGroup, instanceGroupKey: 'cards' },
  };
  const A = R.createBundleHandle(bundle, cfg),
    B = R.createBundleHandle(bundle, cfg);
  let n = 0;
  const isBlit = (e) =>
    e.op === 'draw' && e.fbo === null && F.progKeys(e.prog).has('cacheBlitFrag');
  const frame = (aOpts = {}, bOpts = {}) => {
    F.setFrame(++n);
    R.beginFrame([1, 1, 1, 1]);
    if (aOpts) A.draw(aOpts);
    if (bOpts) B.draw(bOpts);
    R.endFrame();
    const log = F.log.filter((e) => e.frame === n);
    return {
      blits: log.filter(isBlit),
      bakes: log.filter((e) => e.op === 'draw' && e.fbo !== null),
      live: log.filter((e) => e.op === 'draw' && e.fbo === null && !isBlit(e)),
    };
  };
  return { F, R, A, B, frame };
};

{
  const { A, B, R, frame } = await rig();
  let f;
  for (let i = 0; i < 6; i++) f = frame();
  ok(
    f.blits.length === 2 && f.bakes.length === 0 && f.blits[0].units[0] === f.blits[1].units[0],
    'the premise: two members, one raster, no bake on a steady frame',
  );
  const raster = f.blits[0].units[0];
  // A takes a color matrix and keeps it; B is drawn as before.
  let baked = 0,
    blitsByTwo = 0;
  for (let i = 0; i < 8; i++) {
    f = frame({ colorMatrix: TINT });
    baked += f.bakes.length;
    if (f.blits.length === 2) blitsByTwo++;
  }
  ok(
    baked === 0,
    `the tinted member does not bake over the raster its sibling draws from (${baked} draws into targets in 8 frames)`,
  );
  ok(
    blitsByTwo <= 1,
    `after the frame the change is seen, one member blits (${blitsByTwo} frames with two blits)`,
  );
  ok(
    f.blits.length === 1 && f.blits[0].units[0] === raster,
    'the untinted member blits the raster, unchanged',
  );
  ok(f.live.length >= 1, 'and the tinted member draws live');
  // ...and back: they share again, with no extra bake.
  baked = 0;
  for (let i = 0; i < 6; i++) {
    f = frame();
    baked += f.bakes.length;
  }
  ok(
    f.blits.length === 2 && f.blits[0].units[0] === f.blits[1].units[0] && f.live.length === 0,
    'the state back: both blit one raster again',
  );
  ok(
    baked <= 1,
    `and at most the one bake of the member that left (${baked} draws into the target)`,
  );
  R.dispose();
}
{
  // The raster goes free when nobody draws from it: then the other content may take it, and the first member, back, finds it taken and does not blit it.
  const { R, frame } = await rig();
  let f;
  for (let i = 0; i < 6; i++) f = frame();
  let baked = 0;
  for (let i = 0; i < 8; i++) {
    f = frame({ colorMatrix: TINT }, null);
    baked += f.bakes.length;
  }
  ok(
    baked > 0 && f.blits.length === 1,
    `the only member drawn takes the raster (${baked} draws into it)`,
  );
  f = frame({ colorMatrix: TINT }, {});
  ok(
    f.blits.length === 1 && f.live.length >= 1 && f.bakes.length === 0,
    'the sibling back: it draws live, one blit in the frame, no bake',
  );
  R.dispose();
}
{
  // Equal content: a sibling's fresh bake is adopted, not baked again, and not blitted on the flag alone.
  const { A, R, frame } = await rig();
  let f;
  for (let i = 0; i < 6; i++) f = frame();
  A.staticCache.invalidate();
  f = frame();
  ok(
    f.bakes.length > 0 && f.blits.length === 2,
    `an equal bake: one bake (${f.bakes.length} draws), two blits`,
  );
  const baked = f.bakes.length;
  f = frame();
  ok(
    f.bakes.length === 0 && f.blits.length === 2 && baked > 0,
    'and the sibling adopted it: the next frame bakes nothing',
  );
  R.dispose();
}
{
  // Members at different translations: the content box belongs to the raster, so a member that adopts a sibling's bake crops by that bake's box, offset by its own translation.
  const { A, R, frame } = await rig();
  const at = (tx, ty) => ({ worldMatrix: new Float32Array([0.5, 0, 0, 0, 0.5, 0, tx, ty, 1]) }); // (half size: the bundle's box stays on the canvas at each place, as a bake requires)
  let f;
  for (let i = 0; i < 6; i++) f = frame(at(0, 0), at(0.25, 0));
  ok(f.blits.length === 2, 'two translations, one raster');
  A.staticCache.invalidate();
  frame(at(-0.25, 0), at(0.25, 0));
  f = frame(at(-0.25, 0), at(0.25, 0));
  const va = f.blits[0]?.vp || [0, 0, 0, 0],
    vb = f.blits[1]?.vp || [0, 0, 0, 0];
  ok(
    f.blits.length === 2 &&
      vb[0] - va[0] === 64 &&
      vb[2] === Math.min(va[2], 256 - vb[0]) &&
      vb[3] === va[3],
    `after a re-bake at another translation both crop one box, 64 px apart, the far one at the canvas edge (${va} and ${vb})`,
  );
  R.dispose();
}
console.log(
  fail ? `sharedGroupSiblingBakeSmoke: ${fail} FAILED` : 'sharedGroupSiblingBakeSmoke: PASS',
);
process.exit(fail ? 1 : 0);
