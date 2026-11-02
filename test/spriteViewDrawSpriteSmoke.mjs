// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteViewDrawSpriteSmoke -- drawSprite and drawSpriteInstanced take a sprite timeline, and its held frame.
//
// A held frame is a view of its sheet. The `.sprite` getter invites drawSprite(timeline, timeline.sprite), but only drawBundle resolved the view: with the range already set it skipped the
// redirect and setBundle reached createBundleHandle with the view, which throws. CPU, driver-model stand-in.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const M = await import('../src/index.js');
const { createRenderer, createBundle, importSvg } = M;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const rig = async (opts = {}, W = createPendingGl({ linkMs: 1, pipelineMs: 1 })) => {
  const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto', ...opts });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(256, 256);
  return { W, R, gl: W.gl };
};
const bundleOf = async (gl, s, o = { preserveViewport: true }) =>
  createBundle(gl, await importSvg(s, o));
const { gl, R } = await rig();
const sheet = await bundleOf(
  gl,
  svg(
    '<g id="a"><rect x="10" y="10" width="20" height="20" fill="#c00"/></g><g id="b"><rect x="60" y="60" width="20" height="20" fill="#0c0"/></g>',
  ),
);
const tl = M.createSpriteTimeline(
  gl,
  [
    { bundle: sheet, sprite: 'a' },
    { bundle: sheet, sprite: 'b' },
  ],
  [
    { time: 0, refIndex: 0, interp: 'hold' },
    { time: 1, refIndex: 1, interp: 'hold' },
  ],
);
tl.setTime(0.5);
ok(!!tl.bundle._spriteOf, 'the premise: the held frame is a view');
const attempt = (name, f) => {
  let err = null,
    r;
  try {
    R.beginFrame([1, 1, 1, 1]);
    r = f();
    R.endFrame();
  } catch (e) {
    err = e;
    try {
      R.endFrame();
    } catch {
      /* the frame */
    }
  }
  ok(!err && !!r, `${name}: ${err ? 'threw ' + err.message.slice(0, 60) : r}`);
};
attempt('drawSprite(timeline, sprite)', () => R.drawSprite(tl, tl.sprite));
attempt('drawSprite(timeline.bundle, sprite)', () => R.drawSprite(tl.bundle, tl.sprite));
attempt('drawSpriteInstanced(timeline, sprite, instances)', () =>
  R.drawSpriteInstanced(tl, tl.sprite, [{}, {}]),
);
attempt('drawSprite(sheet, sprite) (control)', () => R.drawSprite(sheet, tl.sprite));
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
