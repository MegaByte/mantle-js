// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coopUploadSmoke -- the loading call's big vertex uploads are cooperative (renderer/coopUpload.js): behind a pipeline build in flight no single call holds the page, and every
// buffer is filled completely before the loading call ends. Runs on the driver-model stand-in (test/_pendingGl.mjs), where a transfer over the command ring waits for the
// build in flight like the real service's (a loading screen hitches 86-126 ms in bufferData). The stand-in waits for any upload of 16 KB or more behind a build.
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
const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
// the byte record per buffer: what was allocated (size or data) and what was filled
const alloc = new Map(),
  filled = new Map();
let bound = null;
{
  const bb = W.gl.bindBuffer;
  W.gl.bindBuffer = (t, b) => {
    if (t === W.gl.ARRAY_BUFFER) bound = b;
    return bb(t, b);
  };
  const bd = W.gl.bufferData;
  W.gl.bufferData = (t, d, u) => {
    if (bound) {
      const n = typeof d === 'number' ? d : d.byteLength;
      alloc.set(bound, n);
      filled.set(bound, typeof d === 'number' ? 0 : n);
    }
    return bd(t, d, u);
  };
  const bs = W.gl.bufferSubData;
  W.gl.bufferSubData = (t, off, d) => {
    if (bound) filled.set(bound, (filled.get(bound) || 0) + d.byteLength);
    return bs(t, off, d);
  };
}
// a GPU thread that is busy for the whole load (other pipelines in flight, in this or another context): the model's free time keeps moving ahead
const busy = setInterval(() => {
  W.model.gpuFree = Math.max(W.model.gpuFree, W.vt() + 150);
}, 20);
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
R.setViewport(256, 256);
const rects = Array.from(
  { length: 2500 },
  (_, i) =>
    `<path d="M${(i * 7) % 90} ${(i * 11) % 90} l6 0 l0 6 l-6 0 Z" fill="#${(100 + (i % 800)).toString(16).padStart(3, '0')}"/>`,
).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${rects}</svg>`;
const bundles = [
  createBundle(W.gl, await importSvg(svg, { preserveViewport: true })),
  createBundle(W.gl, await importSvg(svg.replace('#', '#0'), { preserveViewport: true })),
];
// (only the loading call's uploads are judged: a bundle's own texImage2D in createBundle can land within 100 ms of a `busy` tick, depending on how long the
// SVG parse ran, and wait behind the simulated build)
W.resetWaits();
await R.precompileFillsAsync({});
clearInterval(busy);
if (process.env.DBG) {
  const { pendingUploadBytes } = await import('../src/renderer/coopUpload.js');
  console.log(
    'pending bytes after load',
    pendingUploadBytes(W.gl),
    'phase',
    R.debugStats.coopLoad && R.debugStats.coopLoad.phase,
  );
}
const big = W.model.waits.filter((w) => w.kind === 'upload-behind-build');
if (process.env.DBG)
  for (const w of big) console.log('  WAIT', w.name, Math.round(w.ms), w.stack.slice(0, 600));
ok(
  big.length === 0,
  `no upload waited behind a build during the loading call (${big.length}${
    big.length
      ? ': ' +
        big
          .map((w) => w.name + ' ' + Math.round(w.ms) + ' ms')
          .slice(0, 4)
          .join(', ')
      : ''
  })`,
);
const sizes = [...alloc.values()].sort((a, b) => b - a);
ok(sizes[0] >= 256 * 1024, `the scene has a big upload (largest buffer ${sizes[0]} bytes)`);
const short = [...alloc.entries()].filter(([b, n]) => n >= 256 * 1024 && (filled.get(b) || 0) < n);
ok(
  short.length === 0,
  `every buffer is complete when the loading call ends (${short.length} short${
    short.length
      ? ': ' +
        short
          .slice(0, 3)
          .map(([b, n]) => (filled.get(b) || 0) + '/' + n)
          .join(', ')
      : ''
  })`,
);
ok(W.model.pipelines > 0, `the loading call built pipelines (${W.model.pipelines})`);
R.dispose();
console.log(fail ? `coopUploadSmoke FAIL (${fail})` : 'coopUploadSmoke PASS');
process.exit(fail ? 1 : 0);
