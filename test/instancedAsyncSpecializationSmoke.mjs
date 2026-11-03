// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedAsyncSpecializationSmoke -- an instanced draw never waits for a shader link when the driver compiles in
// parallel (KHR_parallel_shader_compile).
//
// A synchronous link read (LINK_STATUS, getUniformLocation) on a program the driver is still building blocks the
// main thread until the GPU process finishes: 84-86 ms for a lean instanced program, 300-550 ms for others, in the middle of
// play. Node only, on the recording WebGL stand-in with a driver whose links stay unfinished until the test releases them:
//   (a) with the extension present, drawing instances while their program is unfinished reads no link state of any
//       unfinished program (no LINK_STATUS, no uniform location, no shader parameter), and the frame still draws, through the
//       per-instance loop (no instanced draw yet) -- also when loading built and finished the general instanced program,
//       whose first draw would build a pipeline;
//   (b) once the driver reports the program complete, the next draws take the instanced fast path;
//   (c) without the extension nothing changes: the first instanced draw links the program at once.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>';
const sec = await importSvg(SVG, { preserveViewport: true });
const COMPLETION = 0x91b1;

/// A driver whose links stay unfinished once armed, and which records every read that would block on one.
function slowDriver(F, { extension }) {
  const gl = F.gl;
  const unfinished = new Set();
  const state = { armed: false, blocking: [] };
  gl.getExtension = (n) =>
    extension && n === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: COMPLETION } : null;
  const linked = new Set(),
    read = new Set();
  gl.linkProgram = (p) => {
    linked.add(p);
    p.__site = new Error().stack.split('\n').slice(2, 5).join('|');
    if (state.armed) unfinished.add(p);
  };
  const note = (what, p) => {
    if (unfinished.has(p)) {
      state.blocking.push(what);
      if (process.env.TRACE && state.blocking.length < 3)
        console.log(new Error(what).stack.split('\n').slice(2, 9).join('\n'));
    }
  };
  gl.getProgramParameter = (p, pname) => {
    if (pname === COMPLETION) return !unfinished.has(p);
    note('getProgramParameter', p);
    if (pname === gl.LINK_STATUS) read.add(p);
    return true;
  };
  gl.getUniformLocation = (p, name) => {
    note('getUniformLocation', p);
    read.add(p);
    return { uniform: name };
  };
  gl.getAttribLocation = (p) => {
    note('getAttribLocation', p);
    return 0;
  };
  gl.getProgramInfoLog = (p) => {
    note('getProgramInfoLog', p);
    return '';
  };
  state.arm = () => {
    state.armed = true;
  };
  state.release = () => unfinished.clear();
  state.pending = () => unfinished.size;
  state.linked = () => linked.size;
  state.unreadList = () => [...linked].filter((p) => !read.has(p));
  state.unread = () => state.unreadList().length;
  state.isUnfinished = (p) => unfinished.has(p);
  return state;
}
const instancedDraws = (F, from) =>
  F.log.slice(from).filter((e) => e.op === 'draw' && e.instances > 1).length;
const draws = (F, from) => F.log.slice(from).filter((e) => e.op === 'draw').length;
const AXIS = [
  { worldMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  { worldMatrix: [1, 0, 0, 0, 1, 0, 20, 0, 1] },
  { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 40, 40, 1] },
];

for (const [arm, extension, loaded] of [
  ['extension, program started and finished during loading', true, true],
  ['extension, nothing started by loading', true, false],
  ['no extension', false, true],
]) {
  const F = createFakeGl({ width: 128, height: 128 });
  const D = slowDriver(F, { extension });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false });
  R.setLoopBlinnFill('off');
  const b = createBundle(F.gl, sec);
  R.setViewport(128, 128);
  // The application's loading call: it links everything and draws the base fill before play starts. A loading call that
  // never saw the instanced path starts no instanced program.
  if (!loaded) R._setInstancedFast(false);
  R.prewarmBundle(b);
  R.precompileFills();
  if (!loaded) R._setInstancedFast(true);
  D.arm();
  const frame = () => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, AXIS);
    R.endFrame();
  };
  const mark = F.log.length;
  frame();
  console.log(arm);
  if (extension && loaded) {
    ok(D.blocking.length === 0, '(a) no blocking read at the first draw');
    ok(
      instancedDraws(F, mark) > 0,
      '(a) the program the loading call started is complete: the first draw is instanced',
    );
  } else if (extension) {
    ok(
      D.pending() > 0,
      '(a) the specialized instanced program is still unfinished after its first draw',
    );
    ok(
      D.blocking.length === 0,
      `(a) no blocking read of an unfinished program during the draw (${D.blocking.join(',') || 'none'})`,
    );
    ok(
      draws(F, mark) > 0 &&
        !F.log.slice(mark).some((e) => e.op === 'draw' && D.isUnfinished(e.prog)),
      `(a) the frame drew, and no draw bound an unfinished program (${draws(F, mark)} draws)`,
    );
    ok(instancedDraws(F, mark) === 0, '(a) the per-instance loop drew the frame');
    for (let i = 0; i < 3; i++) frame();
    ok(
      D.blocking.length === 0,
      `(a) none in later frames while the link is unfinished (${D.blocking.join(',') || 'none'})`,
    );
    D.release();
    const m2 = F.log.length;
    for (let i = 0; i < 3; i++) frame();
    ok(D.blocking.length === 0, '(b) none after completion either');
    ok(
      instancedDraws(F, m2) === 3,
      `(b) once complete every draw takes the instanced fast path (${instancedDraws(F, m2)} of 3)`,
    );
  } else {
    ok(
      instancedDraws(F, mark) > 0,
      '(c) without the extension the first draw takes the instanced fast path',
    );
  }
  R.dispose();
}
// (d) preparing a bundle starts the small-shape point program's link (more unfinished links than with the point route off) and waits for none of it.
{
  const prepared = (aacPoints) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const D = slowDriver(F, { extension: true });
    const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints });
    D.arm();
    const b = createBundle(F.gl, sec);
    R.setViewport(128, 128);
    const before = D.blocking.length,
      p0 = D.pending();
    R.prepareBundle(b);
    const r = { blocked: D.blocking.length - before, pending: D.pending() - p0 };
    R.dispose();
    return r;
  };
  const off = prepared(false),
    on = prepared(true);
  console.log('prepare');
  ok(
    on.pending > off.pending,
    `(d) the point program was started (${on.pending} unfinished links against ${off.pending} with the point route off)`,
  );
  ok(on.blocked === 0, `(d) preparing waited for no unfinished link (${on.blocked})`);
}
// (e) preparing a filtered bundle starts the small filter helper programs, so they are not first asked for in play.
{
  const FSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="f"><feGaussianBlur stdDeviation="3"/></filter></defs><path d="M10 10 L90 10 L90 90 L10 90 Z" fill="#303" filter="url(#f)"/></svg>';
  const PSVG = FSVG.replace(' filter="url(#f)"', '');
  const started = async (svg) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const D = slowDriver(F, { extension: true });
    const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false });
    D.arm();
    const b = createBundle(F.gl, await importSvg(svg, { preserveViewport: true }));
    R.setViewport(128, 128);
    const before = D.blocking.length,
      p0 = D.pending();
    R.prewarmBundle(b);
    const r = { blocked: D.blocking.length - before, pending: D.pending() - p0 };
    R.dispose();
    return r;
  };
  const plain = await started(PSVG),
    filtered = await started(FSVG);
  console.log('filtered');
  ok(
    plain.blocked === 0 && filtered.blocked === 0,
    `(e) preparing waited for no unfinished link (${plain.blocked}, ${filtered.blocked})`,
  );
  ok(
    filtered.pending - plain.pending >= 5,
    `(e) a filtered bundle also starts the fused-blur, linear-blit and effect-mask programs (${filtered.pending} unfinished links against ${plain.pending})`,
  );
}
// (f) creating a shape morph starts the GPU lerp helper's link, so its first setT in play finds it finished.
{
  const { createShapeMorph } = await import('../src/index.js');
  const A = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90 Z" fill="#303"/></svg>',
    { preserveViewport: true },
  );
  const B = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 20 L80 10 L90 80 L10 70 Z" fill="#303"/></svg>',
    { preserveViewport: true },
  );
  const F = createFakeGl({ width: 128, height: 128 });
  const D = slowDriver(F, { extension: true });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false });
  const a = createBundle(F.gl, A),
    b = createBundle(F.gl, B);
  D.arm();
  const before = D.blocking.length,
    p0 = D.pending();
  const m = createShapeMorph(F.gl, a, b, {});
  console.log('morph');
  ok(
    D.blocking.length === before,
    `(f) creating a morph waited for no unfinished link (${D.blocking.slice(before).join(',') || 'none'})`,
  );
  ok(
    D.pending() > p0,
    `(f) the lerp helper's link was started (${D.pending() - p0} new unfinished)`,
  );
  try {
    m.dispose && m.dispose();
  } catch {
    /* fake GL */
  }
  R.dispose();
}
// (g) the automatic prewarm that runs from the per-frame idle tick (a bundle created during play) only starts links, the point program's included.
{
  const idle = (aacPoints) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const D = slowDriver(F, { extension: true });
    const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints });
    R.setViewport(128, 128);
    D.arm();
    createBundle(F.gl, sec); // created mid-play: only the idle tick's prewarm queue sees it
    const p0 = D.pending();
    for (let i = 0; i < 6; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.endFrame();
    }
    const r = { blocked: D.blocking.slice(), pending: D.pending() - p0 };
    R.dispose();
    return r;
  };
  const off = idle(false),
    on = idle(true);
  console.log('idle tick');
  ok(
    on.pending > off.pending,
    `(g) the idle tick started the new bundle's point program (${on.pending} unfinished links against ${off.pending} with the point route off)`,
  );
  ok(
    on.blocked.length === 0,
    `(g) and waited for none of them (${on.blocked.join(',') || 'none'})`,
  );
}
// (h) the explicit loading call finishes the links the prewarm only started (the point program among them), so that on a cold driver
// cache their compile does not run through the first seconds of play.
{
  const loaded = async (aacPoints) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const D = slowDriver(F, { extension: true });
    const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints, warmFutureStates: false }); // the single pass: the future-state passes link variants of their own
    R.setViewport(128, 128);
    createBundle(F.gl, sec);
    R.precompileFills();
    const r = {
      linked: D.linked(),
      unread: D.unread(),
      keys: D.unreadList()
        .map((p) => p.__site)
        .join(','),
    };
    R.dispose();
    return r;
  };
  const off = await loaded(false),
    on = await loaded(true);
  console.log('loading');
  ok(
    on.linked > off.linked,
    `(h) the point program was started (${on.linked} links against ${off.linked} with the point route off)`,
  );
  ok(
    on.unread === 0,
    `(h) and every started link was finished by the loading call (${on.unread} unread: ${on.keys})`,
  );
}
// (i) the loading call waits for the pipeline builds its warm draws queued (gl.finish), so a cold driver cache does not stall the first seconds of play.
{
  const loadingFinishes = (opts) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false });
    R.setViewport(128, 128);
    createBundle(F.gl, sec);
    let finishes = 0;
    F.gl.finish = () => {
      finishes++;
    };
    R.precompileFills(opts);
    const drew = F.log.some((e) => e.op === 'draw');
    R.dispose();
    return { finishes, drew };
  };
  const noDraw = loadingFinishes({ draw: false }),
    drawn = loadingFinishes();
  console.log('finish');
  ok(
    noDraw.finishes === 0 && !noDraw.drew,
    '(i) a precompileFills that draws nothing does not wait for the GPU',
  );
  ok(
    drawn.drew && drawn.finishes >= 1,
    `(i) the loading call that drew warm pipelines waited for the GPU (${drawn.finishes} finish)`,
  );
}
console.log(
  fail ? `INSTANCED-ASYNC-SPECIALIZATION FAIL (${fail})` : 'INSTANCED-ASYNC-SPECIALIZATION PASS',
);
process.exit(fail ? 1 : 0);
