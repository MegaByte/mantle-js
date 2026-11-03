// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillSelectThrowSmoke -- a draw on a lost context defers instead of throwing, and a selection that throws has begun no fill pass.
//
// Every link reads as failed on a lost context, in the window before webglcontextlost as after it. A draw whose kernel program is still pending must not throw out of drawBundle there, or the host's
// frame loop ends before its context-lost handler runs. Beside that, the pass must not be marked active before its program is selected: after a real link failure the mark would stay, the next unified
// draw bind no program, and every warm answer "wait" until a classic draw happened to end the pass.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
console.error = () => {};
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
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>',
  { preserveViewport: true },
);
const COMPLETION = 0x91b1;

console.log(
  '(loss window) a draw with its kernel program pending, on a context that has just been lost',
);
for (const [name, O] of [
  ['strict play', { strictPlay: true }],
  ['stand-in-free', { standIns: false }],
  ['non-blocking', {}],
]) {
  const W = createPendingGl({ linkMs: 3, pipelineMs: 3 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    aacPoints: false,
    ...O,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(128, 128);
  R.setFillEngine({ route: 'none', kernel: 'aac' });
  const b = createBundle(W.gl, sec);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
  // what a lost context answers: links complete, every status null, no uniform; no event yet
  W.gl.isContextLost = () => true;
  W.gl.getProgramParameter = (p, n) => (n === COMPLETION ? true : null);
  W.gl.getUniformLocation = () => null;
  let thrown = null;
  for (let i = 0; i < 4; i++) {
    try {
      R.beginFrame([1, 1, 1, 1]);
      R.setFillEngine({ route: 'none', kernel: i % 2 ? 'slug' : 'aac' });
      R.drawBundle(b);
      R.endFrame();
    } catch (e) {
      thrown = thrown || e.message;
    }
  }
  ok(!thrown, `${name}: nothing is thrown (${thrown || 'none'})`);
}

// A stand-in GL whose programs with the AAC kernel fail to link: the thing a shipped shader can only meet on a driver limit.
function failingAac(W) {
  const srcOf = new Map(),
    bad = new Set();
  const ss = W.gl.shaderSource;
  W.gl.shaderSource = (s, t) => {
    srcOf.set(s, t);
    return ss(s, t);
  };
  const at = W.gl.attachShader;
  W.gl.attachShader = (p, s) => {
    if (/#define MANTLE_AAC\b/.test(srcOf.get(s) || '')) bad.add(p);
    return at(p, s);
  };
  const gp = W.gl.getProgramParameter;
  W.gl.getProgramParameter = (p, n) => (n === W.gl.LINK_STATUS && bad.has(p) ? false : gp(p, n));
  return bad;
}
console.log('(a real link failure) it leaves no pass behind');
{
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  failingAac(W);
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    aacPoints: false,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(128, 128);
  const b = createBundle(W.gl, sec);
  R.setFillEngine({ route: 'none', kernel: 'aac' });
  let thrown = null;
  try {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  } catch (e) {
    thrown = e.message;
  }
  ok(
    /failed to link/.test(thrown || ''),
    `the premise: a kernel that cannot link says so (${thrown})`,
  );
  // the app moves on to the kernel that works; a warm refuses to run while a pass is active
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const p0 = W.model.pipelines;
  R.precompileFills({});
  ok(
    W.model.pipelines > p0,
    `the next warm draws: no fill pass was left active (${W.model.pipelines - p0} pipelines)`,
  );
  R.dispose();
}
console.log('(a real link failure) it is not linked again every frame');
for (const [name, O] of [
  ['blocking', {}],
  ['non-blocking', { nonBlocking: true }],
  ['strict play', { nonBlocking: true, strictPlay: true }],
  ['stand-in-free', { nonBlocking: true, standIns: false }],
]) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const bad = failingAac(W);
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    aacPoints: false,
    ...O,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(128, 128);
  const b = createBundle(W.gl, sec);
  R.setFillEngine({ route: 'none', kernel: 'aac' });
  const draw = () => {
    try {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
    } catch {
      /* the blocking draw says so each time */
    }
  };
  // until the failure has been read: the link's own completion, and the gate behind it
  let n = 0;
  while (!bad.size || !R.debugStats.linkFailedKeys) {
    draw();
    await sleep(2);
    if (++n > 400) break;
  }
  const before = bad.size;
  for (let i = 0; i < 20; i++) {
    draw();
    await sleep(2);
  }
  ok(
    bad.size - before === 0,
    `${name}: 20 more frames link nothing (${bad.size - before} links, ${before} before)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
