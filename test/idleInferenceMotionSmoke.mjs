// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// idleInferenceMotionSmoke -- the count of static frames, which the warm that waits for a still screen reads (strict play's inferred windows), climbs on a still screen and on no moving one, whichever entry draws the motion.
//
// Every draw entry notes itself in the signature the inference compares, not only drawBundle with its matrix, table, morph time and alpha: otherwise a scene animated through handle.draw, an
// instanced draw, a sprite's frames, a color matrix or a drawImage reads as static after 24 frames, and the "invisible" window links and builds in the middle of the motion. The signature's hash
// keeps a float's top bits as well as its low ones, or frames 0 and 1 can hash alike.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const sec = await importSvg(
  doc(
    '<path id="a" d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/><path id="b" d="M20 10 C 70 0 90 40 80 90 L 30 70 Z" fill="#a03"/>',
  ),
  { preserveViewport: true },
);
const at = (i) => new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.2 * Math.sin(i / 3), 0, 1]);
const grey = (k) => new Float32Array([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1]);
const MOVING = {
  'drawBundle under a moving matrix': (c, i) => c.R.drawBundle(c.b, { worldMatrix: at(i) }),
  'handle.draw under a moving matrix': (c, i) => c.h.draw({ worldMatrix: at(i) }),
  'an instanced draw of moving copies': (c, i) =>
    c.R.drawBundleInstanced(c.b, [{ worldMatrix: at(i) }, { worldMatrix: at(i + 5) }]),
  'half of 2000 copies moving': (c, i) =>
    c.R.drawBundleInstanced(
      c.b,
      c.field.map((m, k) => ({ worldMatrix: k < 1000 ? m : at(i) })),
    ),
  "a sprite's frames": (c, i) => c.R.drawSprite(c.b, [i & 1, i & 1], { worldMatrix: at(0) }),
  'a color matrix that animates': (c, i) =>
    c.R.drawBundle(c.b, { worldMatrix: at(0), colorMatrix: grey(0.5 + 0.4 * Math.sin(i / 3)) }),
  'whole-pixel moves': (c, i) =>
    c.R.drawBundle(c.b, {
      worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, (i % 7) / 8, (i % 3) / 2, 1]),
    }),
  'drawImage of a moving rect': (c, i) => c.R.drawImage(c.img, { dstRect: [i, 0, 16, 16] }),
  'drawImageInstanced of moving copies': (c, i) =>
    c.R.drawImageInstanced(c.img, [{ dstRect: [i, 0, 16, 16] }, { dstRect: [0, i, 16, 16] }]),
  'a channel lerp that animates': (c, i) =>
    c.R.drawBundle(c.b, {
      worldMatrix: at(0),
      channelLerp: {
        primary: [0.5 + 0.4 * Math.sin(i / 3), 0, 0, 1],
        contrast: [0, 0, 0, 1],
        highlight: [1, 1, 1, 1],
      },
    }),
};
const STILL = {
  drawBundle: (c) => c.R.drawBundle(c.b, { worldMatrix: at(0) }),
  'handle.draw': (c) => c.h.draw({ worldMatrix: at(0) }),
  'an instanced draw': (c) =>
    c.R.drawBundleInstanced(c.b, [{ worldMatrix: at(0) }, { worldMatrix: at(5) }]),
};
const FRAMES = 40;
async function run(fn, image) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(256, 256);
  const b = createBundle(W.gl, sec);
  await R.precompileFillsAsync({});
  const c = {
    R,
    b,
    gl: W.gl,
    h: R.createBundleHandle(b),
    field: Array.from({ length: 2000 }, (_, k) => at(k)),
    img: image ? R.createImage({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }) : null,
  };
  let most = 0;
  for (let i = 0; i < FRAMES; i++) {
    R.beginFrame([1, 1, 1, 1]);
    fn(c, i);
    R.endFrame();
    most = Math.max(most, R._policy.staticFrames());
    await sleep(1);
  }
  R.dispose();
  return most;
}
console.log('(still) a screen that does not move counts as still');
for (const [name, fn] of Object.entries(STILL)) {
  const n = await run(fn);
  ok(n >= 24, `${name}: ${n} static frames of ${FRAMES}`);
}
console.log('(moving) a screen that moves does not, whichever entry moves it');
for (const [name, fn] of Object.entries(MOVING)) {
  const n = await run(fn, /drawImage/.test(name));
  ok(n < 2, `${name}: ${n} static frames of ${FRAMES}`);
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
