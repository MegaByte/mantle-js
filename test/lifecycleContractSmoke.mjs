// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lifecycleContractSmoke -- the renderer's lifecycle and argument contract.
//
//   after webglcontextrestored a renderer that is not recreated stays lost (it does not draw blank and say it is fine),
//                reports needsRecreate, logs one error and its draw entries THROW a message that says to dispose and recreate
//   awaitLbReady / awaitEngine resolve false for a renderer that cannot draw, and precompileFills throws
//   unusable contexts (null, 2D, WebGL1, lost) fail with a message that names WebGL2
//   createBundle refuses the same contexts
//   setBundle on a disposed renderer allocates nothing
//   drawing a disposed bundle / morph allocates no handle and raises no feedback-loop GL error
//   updateBundleGeometry answers {ok:false} for a disposed bundle and for a lost / restored context
//   options, world matrices, clear colors and the Loop-Blinn budget are validated
//   importSvg's "no DOMParser" message is Node-specific
//   setLoopBlinnMemoryBudget refuses NaN and non-numbers, and keeps Infinity and > 2^31 (not 0)
// CPU only: the real renderer on test/_fakeGl.mjs. The GL-level halves (real WEBGL_lose_context, getError, pixels) are
// test/lifecycleRealContextRenderSmoke.mjs.
import { readFileSync } from 'node:fs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const I = await import('../src/index.js');
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const rejects = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

const warns = [],
  errors = [];
I.setDiagnostics({
  onWarn: (...a) => warns.push(a.join(' ')),
  onError: (...a) => errors.push(a.join(' ')),
});

// A counting wrapper over the fake GL whose context can be "lost" for isContextLost() (a real loss is driven with F.loseContext()).
function countingGl({ webgl1 = false } = {}) {
  const F = createFakeGl({ width: 128, height: 128 });
  let made = 0,
    lost = false;
  const gl = new Proxy(F.gl, {
    get(t, k) {
      const v = t[k];
      if (k === 'isContextLost') return () => lost;
      if (webgl1 && (k === 'createVertexArray' || k === 'RGBA32F')) return undefined; // what a WebGL1 context lacks
      if (
        typeof k === 'string' &&
        /^create(Texture|Framebuffer|Renderbuffer|Buffer|VertexArray|Program|Shader)$/.test(k)
      )
        return (...a) => {
          made++;
          return v.apply(t, a);
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return {
    F,
    gl,
    made: () => made,
    setLost: (b) => {
      lost = b;
    },
  };
}
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const RECT = doc('<rect x="10" y="10" width="30" height="30" fill="red"/>');
const sec = await I.importSvg(RECT);
const newRenderer = async (G, o = {}) => {
  const R = I.createRenderer(G.gl, taggedShaderSources(), o);
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
  return R;
};
const frame = (R, b, o = {}) => {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, o);
  R.endFrame();
};

console.log('an unusable context fails with a message that names WebGL2');
{
  const SH = taggedShaderSources();
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['a 2D-like object', { fillRect() {} }],
    ['a WebGL1-like context', countingGl({ webgl1: true }).gl],
    [
      'a lost context',
      (() => {
        const G = countingGl();
        G.setLost(true);
        return G.gl;
      })(),
    ],
  ];
  for (const [name, gl] of cases) {
    const a = throws(() => I.createRenderer(gl, SH, {}));
    ok(
      a &&
        /createRenderer: /.test(a.message) &&
        /WebGL2|lost/.test(a.message) &&
        a.message.length < 400,
      `createRenderer(${name}) throws a short message (${a && a.message.slice(0, 90)})`,
    );
    const b = throws(() => I.createBundle(gl, sec));
    ok(
      b &&
        /createBundle: /.test(b.message) &&
        /WebGL2|lost/.test(b.message) &&
        b.message.length < 400,
      `createBundle(${name}) throws the same kind of message (${b && b.message.slice(0, 90)})`,
    );
  }
  const G = countingGl();
  const e1 = throws(() => I.createRenderer(G.gl, null, {}));
  ok(
    e1 && /shaderSources/.test(e1.message),
    `createRenderer(gl, null) names shaderSources (${e1 && e1.message.slice(0, 80)})`,
  );
  const e2 = throws(() => I.createRenderer(G.gl, SH, null));
  ok(
    e2 && /opts must be an object/.test(e2.message),
    `createRenderer(gl, sh, null) throws (${e2 && e2.message.slice(0, 80)})`,
  );
  ok(throws(() => I.createRenderer(G.gl, SH, 'fast')) !== null, 'a string for opts throws');
  const R = I.createRenderer(G.gl, SH, undefined);
  ok(!!R, 'opts omitted still works');
  R.dispose();
  const b = I.createBundle(G.gl, sec);
  ok(!!b && b.numShapes === 1, 'a usable context still builds a bundle');
  b.dispose();
}

console.log('option validation: invalid values throw, valid ones still work');
{
  const G = countingGl();
  const SH = taggedShaderSources();
  const bad = [
    ['aacFill', 'sometimes'],
    ['aacFill', 1],
    ['unifiedFill', 'maybe'],
    ['psoWarmMaxWaitFrames', 'x'],
    ['psoWarmMaxWaitFrames', -1],
    ['psoWarmMaxWaitFrames', NaN],
    ['filterPoolIdleMs', -5],
    ['precompileFillsBudgetMs', -5],
    ['precompileFillsBudgetMs', '5'],
    ['onContextLost', 'x'],
    ['onContextRestored', 3],
    ['asyncShaderCompile', 'yes'],
    ['captureFrames', 1],
  ];
  for (const [k, v] of bad) {
    const e = throws(() => I.createRenderer(G.gl, SH, { [k]: v }));
    ok(
      e && e.message.includes('opts.' + k),
      `${k}: ${JSON.stringify(v)} throws and names the option`,
    );
  }
  for (const o of [
    {},
    { aacFill: true },
    { aacFill: false },
    { aacFill: 'auto' },
    { unifiedFill: 'force' },
    { unifiedFill: false },
    { psoWarmMaxWaitFrames: 0 },
    { psoWarmMaxWaitFrames: Infinity },
    { filterPoolIdleMs: 0 },
    { precompileFillsBudgetMs: 5000 },
    { onContextLost() {}, onContextRestored() {} },
    { psoWarmIdle: () => true },
    { aacFill: undefined },
  ]) {
    let e = null,
      R = null;
    try {
      R = I.createRenderer(G.gl, SH, o);
    } catch (x) {
      e = x;
    }
    ok(!e, `valid options ${JSON.stringify(o)} are accepted${e ? ' -- ' + e.message : ''}`);
    if (R) R.dispose();
  }
}

console.log('per-draw and per-frame values');
{
  const G = countingGl();
  const R = await newRenderer(G);
  const b = I.createBundle(G.gl, sec);
  const M9 = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
  frame(R, b, { worldMatrix: M9 });
  ok(
    !throws(() => frame(R, b, { worldMatrix: new Float32Array(M9) })),
    'a Float32Array(9) worldMatrix is accepted',
  );
  ok(
    !throws(() => frame(R, b, { worldMatrix: null })) &&
      !throws(() => frame(R, b, {})) &&
      !throws(() => frame(R, b)),
    'null / absent worldMatrix is accepted',
  );
  for (const [name, m] of [
    ['6 floats', [0.5, 0, 0, 0.5, 0, 0]],
    ['16 floats', new Array(16).fill(0)],
    ['a NaN entry', [NaN, 0, 0, 0, 1, 0, 0, 0, 1]],
    ['an Infinity entry', [1, 0, 0, 0, Infinity, 0, 0, 0, 1]],
    ['a string', 'ident'],
    ['a number', 1],
  ]) {
    const e = throws(() => R.drawBundle(b, { worldMatrix: m }));
    ok(
      e && /worldMatrix/.test(e.message),
      `drawBundle worldMatrix ${name} throws (${e && e.message.slice(0, 80)})`,
    );
  }
  const ei = throws(() =>
    R.drawBundleInstanced(b, [{ worldMatrix: M9 }, { worldMatrix: [1, 2, 3] }], {}),
  );
  ok(
    ei && /instances\[1\]\.worldMatrix/.test(ei.message),
    `drawBundleInstanced names the bad instance (${ei && ei.message.slice(0, 90)})`,
  );
  R.beginFrame([1, 1, 1, 1]);
  const es = throws(() => R.submitBundle(b, { worldMatrix: [1] }));
  ok(es && /worldMatrix/.test(es.message), 'submitBundle validates at submit time');
  R.endFrame();
  for (const [name, c] of [
    ['a string', 'red'],
    ['NaN', [NaN, 0, 0, 1]],
    ['3 floats', [0, 0, 0]],
    ['a number', 1],
  ]) {
    const e = throws(() => R.beginFrame(c));
    ok(
      e && /clearColor/.test(e.message),
      `beginFrame(${name}) throws (${e && e.message.slice(0, 70)})`,
    );
  }
  ok(
    !throws(() => {
      R.beginFrame();
      R.endFrame();
      R.beginFrame(null);
      R.endFrame();
      R.beginFrame(new Float32Array([0, 0, 0, 1]));
      R.endFrame();
    }),
    'beginFrame() / (null) / Float32Array(4) are accepted',
  );
  // the documented clamps stay clamps (test/apiArgumentContractSmoke.mjs)
  ok(
    !throws(() => {
      R.setViewport(1e12, 1e12);
      R.setViewport(Infinity);
      R.setViewport(-5);
      R.setResolutionScale(0);
      R.setResolutionScale(1e6);
    }),
    'setViewport / setResolutionScale keep their documented clamping',
  );
  ok(
    throws(() => R.setViewport(NaN)) && throws(() => R.setResolutionScale('x')),
    'NaN and non-numbers still throw',
  );
  // the Loop-Blinn budget
  for (const v of [NaN, -1, 'big', undefined, null])
    ok(
      throws(() => R.setLoopBlinnMemoryBudget(v)) !== null,
      `setLoopBlinnMemoryBudget(${String(v)}) throws`,
    );
  ok(
    !throws(() => {
      R.setLoopBlinnMemoryBudget(0);
      R.setLoopBlinnMemoryBudget(1024);
      R.setLoopBlinnMemoryBudget(Infinity);
      R.setLoopBlinnMemoryBudget(3 * 2 ** 30);
    }),
    'setLoopBlinnMemoryBudget accepts 0, bytes, Infinity and more than 2 GiB',
  );
  R.dispose();
  b.dispose();
}

console.log('importSvg without a DOMParser explains the main-thread rule');
{
  const saved = globalThis.DOMParser;
  delete globalThis.DOMParser;
  const e = await rejects(() => I.importSvg(RECT));
  globalThis.DOMParser = saved;
  ok(
    e && /Worker/.test(e.message) && /main thread/.test(e.message),
    `the message mentions Workers and the main thread (${e && e.message.slice(0, 120)})`,
  );
}

console.log('a restored context does not revive the renderer: it fails loudly');
{
  const G = countingGl();
  const events = [];
  const R = await newRenderer(G, {
    onContextLost: () => events.push('lost'),
    onContextRestored: () => events.push('restored'),
  });
  const b = I.createBundle(G.gl, sec);
  frame(R, b);
  const handle = R.createBundleHandle(b);
  ok(
    R.isContextLost === false && R.needsRecreate === false,
    'a healthy renderer: isContextLost false, needsRecreate false',
  );
  // an LB wait pending when the loss lands
  const pending = R.awaitLbReady(b, 5000);
  warns.length = 0;
  G.F.loseContext();
  G.setLost(true);
  ok(
    warns.some((w) => /lost/.test(w) && /16/.test(w) && /dispose/.test(w)),
    'the loss logs one warning that names the live-context cap and the recovery',
  );
  ok(
    R.isContextLost === true && R.needsRecreate === false,
    'lost: isContextLost true, not yet needsRecreate',
  );
  ok(
    !throws(() => frame(R, b)) && !throws(() => handle.draw({})),
    "while lost the draw entries (a resident handle's draw too) are inert, they do not throw",
  );
  ok((await pending) === false, 'an awaitLbReady pending at the loss resolves false');
  ok(
    (await R.awaitLbReady(b, 50)) === false &&
      (await R.awaitEngine(b, 'lb', 50)) === false &&
      (await R.awaitEngine(b, 'cpatch', 50)) === false,
    'awaitLbReady / awaitEngine called while lost resolve false',
  );
  ok(
    (await R.awaitEngine(b, 'slug', 50)) === false,
    'even the engines that need no build resolve false: the renderer cannot draw',
  );
  ok(
    (await R.warmScene([{ draw: () => frame(R, b) }])).complete === false,
    'warmScene reports complete:false',
  );
  const pl = throws(() => R.precompileFills());
  ok(
    pl && /lost/.test(pl.message),
    `precompileFills throws while lost (${pl && pl.message.slice(0, 80)})`,
  );
  ok(R.prepareBundle(b) === false, 'prepareBundle returns false while lost');
  errors.length = 0;
  G.F.restoreContext();
  G.setLost(false);
  ok(
    events.join() === 'lost,restored',
    `onContextLost then onContextRestored ran (${events.join()})`,
  );
  ok(
    R.isContextLost === true && R.needsRecreate === true,
    'restored: isContextLost stays true and needsRecreate is true until the renderer is recreated',
  );
  ok(
    errors.length === 1 && /dispose/.test(errors[0]) && /new renderer/.test(errors[0]),
    `one error is logged and it says to dispose and recreate (${errors.length}: ${(errors[0] || '').slice(0, 100)})`,
  );
  const before = G.made();
  for (const [name, fn] of Object.entries({
    beginFrame: () => R.beginFrame([1, 1, 1, 1]),
    drawBundle: () => R.drawBundle(b, {}),
    drawBundleInstanced: () => R.drawBundleInstanced(b, [{}], {}),
    drawInstance: () => R.drawInstance(b, {}),
    submitBundle: () => R.submitBundle(b, {}),
    render: () => R.render(b),
    setBundle: () => R.setBundle(b),
    createBundleHandle: () => R.createBundleHandle(b),
    precompileFills: () => R.precompileFills(),
    createImage: () => R.createImage({ width: 1, height: 1, data: new Uint8Array(4) }),
  })) {
    const e = throws(fn);
    ok(
      e &&
        e.message.startsWith(name + ': ') &&
        /dispose\(\)/.test(e.message) &&
        /new renderer/.test(e.message),
      `${name} throws after the restore and says to dispose and recreate`,
    );
  }
  const hd = throws(() => handle.draw({}));
  ok(
    hd && /^handle\.draw: /.test(hd.message) && /dispose\(\)/.test(hd.message),
    "a resident handle's draw throws the same message after the restore",
  );
  ok(G.made() === before, 'nothing is allocated by the throwing entries');
  ok(
    (await R.awaitLbReady(b, 50)) === false &&
      (await R.awaitEngine(b, 'lb', 50)) === false &&
      R.prepareBundle(b) === false,
    'awaits resolve false and prepareBundle returns false after the restore',
  );
  ok(
    (await R.warmScene([{ draw: () => frame(R, b) }])).complete === false,
    'warmScene is incomplete after the restore',
  );
  ok(
    !throws(() => {
      R.endFrame();
    }),
    'endFrame stays inert',
  );
  R.dispose();
  ok(R.isContextLost === false && R.needsRecreate === false, 'a disposed renderer reports neither');
  // the documented recovery: dispose and recreate on the same context
  const R2 = await newRenderer(G);
  const b2 = I.createBundle(G.gl, sec);
  ok(
    !throws(() => frame(R2, b2)) && R2.isContextLost === false && R2.needsRecreate === false,
    'a renderer created after the restore draws and reports healthy',
  );
  R2.dispose();
  b.dispose();
  b2.dispose();
}

console.log('a disposed renderer or bundle allocates nothing');
{
  const G = countingGl();
  const R = await newRenderer(G);
  const b = I.createBundle(G.gl, sec);
  frame(R, b);
  frame(R, b);
  const live = I.createBundle(
    G.gl,
    await I.importSvg(doc('<rect x="50" y="50" width="20" height="20" fill="blue"/>')),
  );
  for (let i = 0; i < 4; i++) frame(R, live); // the live bundle's own fill variant is built by the warm ticks, not by the disposed draws below
  b.dispose();
  warns.length = 0;
  let base = G.made();
  for (let i = 0; i < 5; i++) frame(R, b);
  ok(G.made() === base, `drawBundle(disposed bundle) x5 allocates nothing (${G.made() - base})`);
  ok(
    warns.filter((w) => /disposed/.test(w)).length === 1,
    `...and warns once per bundle (${warns.filter((w) => /disposed/.test(w)).length})`,
  );
  base = G.made();
  ok(
    R.drawBundleInstanced(b, [{}, {}], {}) === 0 && G.made() === base,
    'drawBundleInstanced(disposed bundle) draws 0 and allocates nothing',
  );
  R.setBundle(b);
  ok(G.made() === base, 'setBundle(disposed bundle) allocates nothing');
  frame(R, live);
  ok(!throws(() => frame(R, live)), 'a live bundle still draws after a disposed one was refused');
  const mk = async (d) =>
    I.createBundle(G.gl, await I.importSvg(doc(`<path id="s" d="${d}" fill="red"/>`)));
  const A = await mk('M10 10H30V30H10Z'),
    B = await mk('M40 40H60V60H40Z');
  const m = I.createShapeMorph(G.gl, A, B);
  m.setT(0.5);
  frame(R, m);
  m.dispose();
  base = G.made();
  for (let i = 0; i < 3; i++) frame(R, m);
  ok(G.made() === base, `drawBundle(disposed morph) x3 allocates nothing (${G.made() - base})`);
  R.dispose();
  base = G.made();
  for (let i = 0; i < 20; i++) {
    const x = I.createBundle(G.gl, sec);
    const m0 = G.made();
    R.setBundle(x);
    if (G.made() !== m0) {
      ok(false, 'setBundle on a disposed renderer allocated');
      break;
    }
    x.dispose();
  }
  ok(true, 'setBundle on a disposed renderer x20 allocates nothing');
}

console.log('updateBundleGeometry reports what it did');
{
  const mkSegs = (x) => [
    I.mkLine([x, 10], [x + 40, 10]),
    I.mkLine([x + 40, 10], [x + 40, 50]),
    I.mkLine([x + 40, 50], [x, 50]),
    I.mkLine([x, 50], [x, 10]),
  ];
  const G = countingGl();
  const ssec = I.buildStreamableSections(
    [{ segs: mkSegs(10), fill: [1, 0, 0, 1] }],
    [0, 0, 128, 128],
  );
  const b = I.createBundle(G.gl, ssec);
  ok(I.updateBundleGeometry(G.gl, b, [mkSegs(20)]).ok === true, 'a live bundle streams: ok:true');
  const b2 = I.createBundle(G.gl, ssec);
  G.F.loseContext();
  G.setLost(true);
  const rLost = I.updateBundleGeometry(G.gl, b2, [mkSegs(25)]);
  ok(rLost.ok === false && /lost/.test(rLost.reason), `while lost: ok:false (${rLost.reason})`);
  G.F.restoreContext();
  G.setLost(false);
  const rStale = I.updateBundleGeometry(G.gl, b2, [mkSegs(25)]);
  ok(
    rStale.ok === false && /context loss/.test(rStale.reason),
    `a bundle from before the loss, after the restore: ok:false (${rStale.reason})`,
  );
  const b3 = I.createBundle(G.gl, ssec);
  b3.dispose();
  const rDisp = I.updateBundleGeometry(G.gl, b3, [mkSegs(25)]);
  ok(
    rDisp.ok === false && /disposed/.test(rDisp.reason),
    `a disposed bundle: ok:false (${rDisp.reason})`,
  );
  const b4 = I.createBundle(G.gl, ssec);
  ok(
    I.updateBundleGeometry(G.gl, b4, [mkSegs(30)]).ok === true,
    'a bundle created after the restore streams again',
  );
}

console.log('docs: the README, rendererApi and CHANGELOG describe the context-loss contract');
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const readme = read('../README.md'),
    api = read('../src/renderer/rendererApi.js'),
    rend = read('../src/renderer/renderer.js');
  ok(
    /onContextRestored/.test(readme) && /needsRecreate/.test(readme) && /dispose/.test(readme),
    'README documents onContextLost / onContextRestored, needsRecreate and dispose-and-recreate',
  );
  ok(
    /needsRecreate/.test(api) && /onContextRestored/.test(api),
    'rendererApi.js types needsRecreate and the hooks',
  );
  ok(
    /\} MantleRendererOptions\b/.test(api) &&
      /import\('\.\/rendererApi\.js'\)\.MantleRendererOptions/.test(rend),
    "a MantleRendererOptions typedef carries the hooks into the .d.ts and types createRenderer's opts",
  );
  ok(
    /Worker/.test(readme) && /DOMParser/.test(readme),
    'README says importSvg needs DOMParser (the main thread)',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
