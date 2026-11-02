// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// debugStatsSerializableSmoke -- renderer.debugStats is plain data: a harness reads it with page.evaluate (structured clone / JSON), and one function or live bundle in it
// makes the whole read fail (a debugStats.viewportWarm.derived holding the live bundles and debug hooks loses a harness its entire `ds`).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const W = createPendingGl({ linkMs: 30, pipelineMs: 120 });
const R = createRenderer(W.gl, taggedShaderSources(), {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  glGuard: true,
  gpuShedMs: 40,
});
R.ready.catch(() => {});
setTimeout(() => W.release(), 40);
await R.ready;
R.setViewport(512, 512);
createBundle(
  W.gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>',
    { preserveViewport: true },
  ),
);
await R.precompileFillsAsync({});
let json = null,
  clone = null;
try {
  json = JSON.stringify(R.debugStats);
} catch (e) {
  json = 'ERR ' + e.message;
}
try {
  clone = structuredClone(R.debugStats.viewportWarm);
} catch (e) {
  clone = 'ERR ' + e.message;
}
ok(
  typeof json === 'string' && !json.startsWith('ERR'),
  'JSON.stringify(debugStats) works' + (json && json.startsWith('ERR') ? ': ' + json : ''),
);
ok(
  clone && typeof clone === 'object',
  'structuredClone(debugStats.viewportWarm) works (the loading report holds no function or live bundle)' +
    (typeof clone === 'string' ? ': ' + clone : ''),
);
const d = R.debugStats.viewportWarm && R.debugStats.viewportWarm.derived;
ok(
  !!d && d.method === 'analytic' && Array.isArray(d.bundles),
  'the derived-region report is there and is data',
);
R.dispose();
console.log(
  fail ? `debugStatsSerializableSmoke FAIL (${fail})` : 'debugStatsSerializableSmoke PASS',
);
process.exit(fail ? 1 : 0);
