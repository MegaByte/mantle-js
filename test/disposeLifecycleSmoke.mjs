// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// disposeLifecycleSmoke — what a disposed owner does, and what a dispose frees.
//
//   a disposed renderer's late frame / handle / prepare must not re-link programs or allocate VAOs, buffers and
//          textures that nothing frees (a requestAnimationFrame that outlives a framework unmount)
//   a bare drawBundle keeps eight transient handles; the ninth ages the first out, and bundle.dispose() must still
//          reach its filter-cache entries (otherwise 40 filtered bundles disposed leave 32 entries, ~2 MB and 34 FBOs)
//   morph.setT after dispose does not throw; sprite timelines do not rebuild morphs after dispose
//   setText / setStyle on a disposed text handle allocate nothing
//   morph.dispose() / timeline.dispose() delete the meta texture once
//
// CPU only: the real renderer on a counting GL wrapper over test/_fakeGl.mjs.
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

// Live GL objects by kind, double deletes and uses of a deleted object.
function countingGl() {
  const F = createFakeGl({ width: 128, height: 128 });
  const live = new Map(),
    deleted = new WeakSet(),
    problems = [];
  const KINDS = 'Texture|Framebuffer|Renderbuffer|Buffer|VertexArray|Program|Shader|Query|Sampler';
  const mk = new RegExp(`^create(${KINDS})$`),
    rm = new RegExp(`^delete(${KINDS})$`);
  // The memory ledger wraps the context's allocation / delete methods by assignment, so a call through this proxy reaches the counting closure,
  // then the ledger's wrapper, which calls the closure it captured at install: the nested call is the same call, counted once.
  let busy = false;
  const gl = new Proxy(F.gl, {
    get(t, k) {
      const v = t[k];
      if (typeof k === 'string' && mk.test(k))
        return (...a) => {
          const o = v.apply(t, a);
          live.set(o, k.slice(6));
          return o;
        };
      if (typeof k === 'string' && rm.test(k))
        return (o) => {
          if (busy) return v.call(t, o);
          if (o == null) return;
          if (!live.has(o)) problems.push(k + ' of an untracked / already deleted object');
          live.delete(o);
          deleted.add(o);
          busy = true;
          try {
            return v.call(t, o);
          } finally {
            busy = false;
          }
        };
      if (
        typeof k === 'string' &&
        /^(bindTexture|bindBuffer|bindFramebuffer|bindVertexArray|useProgram|texImage2D|texSubImage2D|bufferData|bufferSubData)$/.test(
          k,
        )
      )
        return (...a) => {
          if (!busy)
            for (const x of a)
              if (x && typeof x === 'object' && deleted.has(x))
                problems.push('use after delete in ' + k);
          return v.apply(t, a);
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const counts = () => {
    const c = {};
    for (const kind of live.values()) c[kind] = (c[kind] || 0) + 1;
    return c;
  };
  const total = () => live.size;
  return { gl, counts, total, problems };
}
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const newRenderer = async (G) => {
  const R = I.createRenderer(G.gl, taggedShaderSources(), {});
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
  return R;
};
const frame = (R, b, o = {}) => {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, o);
  R.endFrame();
};
const RECT = doc('<rect x="10" y="10" width="30" height="30" fill="red"/>');

console.log('a disposed renderer allocates nothing');
for (const order of ['bundle alive', 'bundle disposed first']) {
  const G = countingGl();
  const R = await newRenderer(G);
  const b = I.createBundle(G.gl, await I.importSvg(RECT));
  frame(R, b);
  if (order === 'bundle disposed first') b.dispose();
  R.dispose();
  const settled = G.total();
  const calls = {
    beginFrame: () => R.beginFrame([1, 1, 1, 1]),
    drawBundle: () => R.drawBundle(b, {}),
    endFrame: () => R.endFrame(),
    render: () => R.render(b),
    submitBundle: () => R.submitBundle(b, {}),
    drawInstance: () => R.drawInstance(b, {}),
    drawBundleInstanced: () =>
      R.drawBundleInstanced(b, [{ worldMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }], {}),
    prepareBundle: () => R.prepareBundle(b),
    prewarmBundle: () => R.prewarmBundle(b),
    precompileFills: () => R.precompileFills(),
    setViewport: () => R.setViewport(64, 64),
    setFillEngine: () => R.setFillEngine({ route: 'lb' }),
    createImage: () => R.createImage({ width: 1, height: 1, data: new Uint8Array(4) }),
  };
  const threw = [];
  for (const [name, fn] of Object.entries(calls)) {
    try {
      fn();
    } catch (e) {
      threw.push(name + ': ' + e.message);
    }
  }
  ok(
    threw.length === 0,
    `${order}: draw / frame / prepare / prewarm entries do not throw after dispose${threw.length ? ' — ' + threw.join('; ') : ''}`,
  );
  ok(
    R.prepareBundle(b) === false &&
      R.createImage({ width: 1, height: 1, data: new Uint8Array(4) }) === null,
    `${order}: prepareBundle returns false, createImage null`,
  );
  ok(
    (await R.awaitLbReady(b, 20)) === false && (await R.awaitEngine(b, 'lb', 20)) === false,
    `${order}: awaitLbReady / awaitEngine resolve false`,
  );
  ok(
    (
      await R.warmScene([
        {
          draw: () => {
            throw new Error('ran');
          },
        },
      ])
    ).complete === false,
    `${order}: warmScene runs no draw`,
  );
  let handleErr = null;
  try {
    R.createBundleHandle(b);
  } catch (e) {
    handleErr = e;
  }
  ok(
    handleErr && /disposed/.test(handleErr.message),
    `${order}: createBundleHandle throws a clear error (${handleErr && handleErr.message})`,
  );
  let strokeErr = null;
  try {
    R.createIncrementalStroke({ width: 2, bbox: [0, 0, 10, 10] });
  } catch (e) {
    strokeErr = e;
  }
  ok(
    strokeErr && /disposed/.test(strokeErr.message),
    `${order}: createIncrementalStroke throws a clear error`,
  );
  ok(
    G.total() === settled,
    `${order}: no GL object was allocated after dispose (${settled} live before the late calls, ${G.total()} after: ${JSON.stringify(G.counts())})`,
  );
  R.dispose();
  ok(
    G.problems.length === 0,
    `${order}: dispose twice is clean (${G.problems.join('; ') || 'no problems'})`,
  );
  ok(R.isContextLost === false, `${order}: a disposed renderer does not report a lost context`);
}

console.log('bundle.dispose() purges filter results of an aged-out handle');
{
  const rich = doc(
    '<defs><filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter></defs><circle cx="50" cy="50" r="20" fill="green" filter="url(#f)"/>',
  );
  const sec = await I.importSvg(rich);
  for (const n of [4, 8, 12, 40]) {
    const G = countingGl();
    const R = await newRenderer(G);
    const base = G.total();
    const bundles = [];
    for (let k = 0; k < n; k++) {
      const b = I.createBundle(G.gl, sec);
      bundles.push(b);
      for (let i = 0; i < 2; i++) frame(R, b);
      await wait(2);
    }
    const drawn = R.debugStats.filterCacheEntries;
    for (const b of bundles) b.dispose();
    await wait(20);
    ok(drawn >= Math.min(n, 4), `${n} bundles: ${drawn} filter results cached while drawn`);
    ok(
      R.debugStats.filterCacheEntries === 0 && R.debugStats.filterCacheBytes === 0,
      `${n} bundles: no filter-cache entry or byte after every bundle is disposed (${R.debugStats.filterCacheEntries} entries, ${R.debugStats.filterCacheBytes} B)`,
    );
    const left = G.total() - base;
    ok(
      left <= 12,
      `${n} bundles: the GL objects left are the renderer's fixed scratch, not per-bundle (${left})`,
    );
    R.dispose();
    ok(
      G.total() === 0 && G.problems.length === 0,
      `${n} bundles: renderer dispose frees the rest (${G.total()} live; ${G.problems.join('; ') || 'no problems'})`,
    );
  }
  // an aged-out bundle that is never disposed does not pin the renderer: the weak hook set drains
  const G = countingGl();
  const R = await newRenderer(G);
  const keep = [];
  for (let k = 0; k < 12; k++) {
    const b = I.createBundle(G.gl, sec);
    keep.push(b);
    frame(R, b);
  }
  R.dispose();
  ok(
    keep.every((b) => !b._disposeHooks || b._disposeHooks.size === 0),
    'renderer dispose removes its hooks from every bundle, resident or aged out',
  );
  keep.forEach((b) => b.dispose());
}

console.log('morph and timeline dispose');
{
  const G = countingGl();
  const R = await newRenderer(G);
  const mk = async (d) =>
    I.createBundle(G.gl, await I.importSvg(doc(`<path id="s" d="${d}" fill="red"/>`)));
  const A = await mk('M10 10H30V30H10Z'),
    B = await mk('M40 40H60V60H40Z');
  const m = I.createShapeMorph(G.gl, A, B);
  m.setT(0.5);
  frame(R, m);
  const tl = I.createShapeTimeline(
    G.gl,
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
    ],
  );
  tl.setTime(0.5);
  frame(R, tl);
  m.dispose();
  let err = null;
  try {
    m.setT(0.7);
    m.dispose();
  } catch (e) {
    err = e;
  }
  ok(
    err === null,
    `morph.setT / dispose after dispose do nothing${err ? ' — ' + err.message : ''}`,
  );
  tl.dispose();
  tl.setTime(0.9);
  tl.dispose();
  const settled = G.total();
  const sheet = await I.importSvg(
    doc(
      '<g id="p0"><rect width="10" height="10" fill="red"/></g><g id="p1"><rect x="20" width="10" height="10" fill="blue"/></g>',
    ),
  );
  const sb = I.createBundle(G.gl, sheet);
  const st = I.createSpriteTimeline(
    G.gl,
    [
      { bundle: sb, sprite: 'p0' },
      { bundle: sb, sprite: 'p1' },
    ],
    [
      { time: 0, refIndex: 0 },
      { time: 1, refIndex: 1 },
    ],
  );
  st.setTime(0.5);
  st.dispose();
  const afterSprite = G.total();
  st.setTime(0.25);
  ok(G.total() === afterSprite, 'sprite timeline: setTime after dispose builds nothing');
  ok(st.bundle === null, 'sprite timeline: .bundle is null after dispose');
  A.dispose();
  B.dispose();
  sb.dispose();
  R.dispose();
  ok(
    G.problems.length === 0,
    `no texture is deleted twice by morph / timeline dispose (${G.problems.join('; ') || 'no problems'})`,
  );
  ok(
    settled > 0 && G.total() === 0,
    `everything is freed at the end (${JSON.stringify(G.counts())})`,
  );
}

console.log('disposed text handle');
{
  const fontPath = new URL('./font/fixtures/roboto-regular.ttf', import.meta.url);
  const FONT = new I.MantleFontAsset(new Uint8Array(readFileSync(fontPath)));
  const G = countingGl();
  const tb = await I.createTextBundle(G.gl, {
    font: FONT,
    text: 'Hi',
    style: { fill: [0, 0, 0, 1], fontSizePx: 20 },
  });
  ok(G.total() > 0, 'a live text bundle holds textures');
  tb.dispose();
  ok(G.total() === 0, 'dispose frees them');
  const r1 = await tb.setText('Hello');
  const r2 = await tb.setStyle({ fill: [1, 0, 0, 1] });
  ok(
    G.total() === 0 && r1 === null && r2 === null && tb.bundle === null,
    `setText / setStyle after dispose build nothing and resolve null (${JSON.stringify(G.counts())})`,
  );
  tb.dispose();
  // dispose while a rebuild is in flight
  const tb2 = await I.createTextBundle(G.gl, {
    font: FONT,
    text: 'Hi',
    style: { fill: [0, 0, 0, 1], fontSizePx: 20 },
  });
  const pending = tb2.setText('Pending text');
  tb2.dispose();
  await pending;
  ok(
    G.total() === 0 && G.problems.length === 0,
    `dispose during an in-flight setText leaves nothing live (${JSON.stringify(G.counts())}; ${G.problems.join('; ') || 'no problems'})`,
  );
}

console.log(fail ? `\nDISPOSE-LIFECYCLE FAIL (${fail})` : '\nDISPOSE-LIFECYCLE PASS');
process.exit(fail ? 1 : 0);
