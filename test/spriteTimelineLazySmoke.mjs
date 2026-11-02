// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteTimelineLazySmoke -- a sprite timeline's held frames cost nothing: each is a VIEW of its sheet, drawn as drawSprite(sheet, sprite); only a morph
// between two frames is a bundle of its own, built on first visit.
//
// A held frame built as a sprite morph pinned at t = 0 would be a bundle forwarding the whole sheet's planes: a scene with dozens of sprite timelines
// (thousands of hold frames) would take many GB, and more if built at creation. Pinned: a 40-frame hold flipbook
// allocates no GL objects at creation or when played; its frames are views (currentMorph null, sprite named); the view unwraps and hit-tests as the sheet
// at its sprite; a linear bracket still builds a pair morph on visit, and dispose releases it. CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const { createRenderer, createBundle, importSvg, createSpriteTimeline, fillHitId } =
  await import('../src/index.js');
const { unwrapBundle } = await import('../src/core/unwrapBundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const N = 40;
let body = '';
for (let i = 0; i < N; i++)
  body += `<rect id="f${i}" x="${(i % 8) * 12}" y="${Math.floor(i / 8) * 12}" width="${4 + (i % 5)}" height="${9 - (i % 4)}" fill="#3a7"/>`;
const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 60">${body}</svg>`;

const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
const live = { tex: 0, buf: 0, vao: 0 };
for (const [mk, rm, k] of [
  ['createTexture', 'deleteTexture', 'tex'],
  ['createBuffer', 'deleteBuffer', 'buf'],
  ['createVertexArray', 'deleteVertexArray', 'vao'],
]) {
  const c = W.gl[mk].bind(W.gl),
    d = W.gl[rm].bind(W.gl);
  W.gl[mk] = (...a) => {
    live[k]++;
    return c(...a);
  };
  W.gl[rm] = (o) => {
    if (o) live[k]--;
    return d(o);
  };
}
const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto' });
R.ready.catch(() => {});
setTimeout(() => W.release(), 5);
await R.ready;
R.setViewport(256, 256);
const sheet = createBundle(W.gl, await importSvg(SHEET, { preserveViewport: true }));
const refs = Array.from({ length: N }, (_, i) => ({ bundle: sheet, sprite: 'f' + i }));
const keys = Array.from({ length: N }, (_, i) => ({ time: i / 10, refIndex: i, interp: 'hold' }));
const total = () => live.tex + live.buf + live.vao;

console.log(
  `(sprite timeline) a ${N}-frame hold flipbook over one sheet: its frames are views of the sheet and allocate nothing`,
);
const t0 = total();
const tl = createSpriteTimeline(W.gl, refs, keys);
ok(total() - t0 === 0, `creating it allocated ${total() - t0} GL objects`);
const frame = (i) => {
  tl.setTime(i / 10 + 0.01);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(tl.bundle);
  R.endFrame();
};
frame(0);
const first = total() - t0; // (the sheet's own draw state, once: its first draw sets it up, as drawSprite of the sheet would)
for (let i = 1; i < N; i++) frame(i);
ok(
  total() - t0 === first,
  `drawing the other ${N - 1} frames allocated ${total() - t0 - first} GL objects (the sheet's first draw: ${first})`,
);
tl.setTime(1.21);
ok(
  tl.currentMorph === null &&
    tl.sprite === 'f12' &&
    tl.bundle._spriteOf &&
    tl.bundle._spriteOf.sheet === sheet,
  `a held frame is a view of the sheet naming its sprite (sprite ${tl.sprite}, currentMorph ${tl.currentMorph})`,
);
ok(
  unwrapBundle(tl.bundle) === sheet && tl.bundle.numShapes === sheet.numShapes,
  'the view unwraps to the sheet and reads its fields',
);
{
  // f12 is the 5th of row 1: x 48..48+6, y 12..12+9 in the sheet's units; the hit answers that sprite's id at its own place and nothing elsewhere
  const m = R.bundleDrawMatrix(tl.bundle, {}),
    at = (x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];
  const [hx, hy] = at(50, 15),
    [mx, my] = at(14, 3); // inside f12; inside f1, another frame
  const a = fillHitId(tl.bundle, hx, hy, { worldMatrix: m }),
    b = fillHitId(tl.bundle, mx, my, { worldMatrix: m });
  ok(
    a === 'f12' && b === null,
    `the view hit-tests as its sprite only (at f12: ${a}; at f1: ${b})`,
  );
}
tl.dispose();
ok(
  total() - t0 === first,
  `disposing it left nothing of its own (${total() - t0 - first} objects beyond the sheet's draw state)`,
);

console.log(
  '(sprite timeline) a linear bracket between two frames is a real morph, built on first visit and released on dispose',
);
const t1 = total();
const tl2 = createSpriteTimeline(
  W.gl,
  [refs[0], refs[1]],
  [
    { time: 0, refIndex: 0 },
    { time: 1, refIndex: 1 },
  ],
);
ok(total() - t1 === 0, `creating it allocated ${total() - t1} GL objects`);
tl2.setTime(0.5);
ok(
  tl2.currentMorph !== null && tl2.sprite === null && total() - t1 > 0,
  `mid-bracket it is a morph (${total() - t1} GL objects; sprite ${tl2.sprite})`,
);
tl2.dispose();
ok(total() - t1 === 0, `disposing it released the morph (${total() - t1} objects left)`);
sheet.dispose();
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
