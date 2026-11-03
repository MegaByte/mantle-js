// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmQueueReleaseSmoke -- a cache-filling renderer (warmQueueRelease: the hub's warmer) deletes each program once the queue needs it no more.
//
// The warmer's only job is to fill the browser's shader caches, so keeping every program it ever built live for its whole life is waste. With
// warmQueueRelease a program is deleted once it is linked and its pipelines are built, a released key counts as done for every later
// scene (nothing is linked twice), and without the option nothing is released.
// CPU, driver-model stand-in (test/_pendingGl.mjs).

globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const listeners = {};
globalThis.window = {
  addEventListener: (t, f) => {
    (listeners[t] ||= []).push(f);
  },
};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await sleep(5);
  return f();
};
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const SRC = {
  bg: doc('<rect x="0" y="0" width="100" height="100" fill="#234"/>'),
  fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  gradient: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  mask: doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
  quad: doc('<path d="M10 80 Q 50 0 90 80 Z" fill="#a40"/>'),
};
const sections = {};
for (const [k, s] of Object.entries(SRC))
  sections[k] = await importSvg(s, { preserveViewport: true });
const strictOpts = {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  glGuard: true,
  gpuShedMs: 40,
};
// (the assertions are counts of programs built, released, deleted and linked: short model durations)
async function mk(extra = {}) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  let live = 0,
    deleted = 0;
  const cp = W.gl.createProgram.bind(W.gl),
    dp = W.gl.deleteProgram.bind(W.gl);
  W.gl.createProgram = () => {
    live++;
    return cp();
  };
  W.gl.deleteProgram = (p) => {
    if (p) {
      live--;
      deleted++;
    }
    return dp(p);
  };
  const R = createRenderer(W.gl, taggedShaderSources(), { ...strictOpts, ...extra });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(128, 128);
  return { W, R, live: () => live, deleted: () => deleted };
}
async function record(keys) {
  const { W, R } = await mk({ recordWarmManifest: true });
  const bs = keys.map((k) => createBundle(W.gl, sections[k]));
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of bs) R.drawBundle(b);
    R.endFrame();
    await sleep(3);
  }
  const m = R.exportWarmManifest();
  R.dispose();
  return m;
}
const mA = await record(['bg', 'fill', 'gradient', 'stroke']);

console.log(
  '(release) the warmer deletes each program once built; a released key is done for a later scene; without the option nothing is released',
);
for (const releaseOn of [true, false]) {
  const { W, R, live, deleted } = await mk(releaseOn ? { warmQueueRelease: true } : {});
  R.warm.window(true);
  const base = live();
  const h = R.warm.add('A', { manifest: mA });
  const rA = await h.ready;
  const st = R.warm.status();
  if (releaseOn) {
    ok(rA.state === 'done' && rA.built > 0, `the scene was warmed (${rA.built} built)`);
    ok((st.totals.released | 0) > 0, `programs were released (${st.totals.released | 0})`);
    ok(
      R.debugStats.baseFillBuilt === false,
      'releasing a program does not link the universal fill program',
    );
    const rel = st.totals.released | 0,
      d0 = deleted();
    await until(() => deleted() >= rel, 3000); // (a program still linking is deleted when its link completes)
    ok(
      deleted() >= rel,
      `every released program was deleted (${deleted()} deletes for ${rel} released)`,
    );
    const keys = new Set(R.debugStats.variantKeys || []);
    ok(
      (mA.pipelines || []).every((p) => !keys.has(p.k)),
      `no warmed key is left in the variant cache (${(mA.pipelines || []).filter((p) => keys.has(p.k)).length} left)`,
    );
    const links0 = W.model.links;
    const h2 = R.warm.add('A2', { manifest: mA });
    const r2 = await h2.ready;
    ok(
      r2.state === 'done' && W.model.links === links0,
      `a second scene over the same keys finished without a link (${W.model.links - links0} links)`,
    );
  } else {
    ok(
      (st.totals.released | 0) === 0 && live() > base,
      `without the option nothing is released (${live() - base} programs live)`,
    );
  }
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
