// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coopUploadDrainSmoke -- a loading call does not end with a vertex buffer still unfilled.
//
// The loading call's big uploads only allocate, and its driver fills them while the GPU thread is clear. If, when its deadline passes with the thread busy, it turned the cooperative uploads off
// and returned with nothing pumping the queue again, the buffer would stay zeros and its bundle draw nothing until the next loading call -- and likewise for a loading call cut short by a
// dispose, for another renderer's fills on the same context. Pinned: nothing is pending when the call settles, in the deadline case, the normal case, and the dispose case. CPU, driver-model stand-in.
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
import { pendingUploadBytes } from '../src/renderer/coopUpload.js';
const OPTS = {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  gpuShedMs: 40,
  standIns: true,
  needMissPolicy: 'defer',
};
const paths = Array.from({ length: 900 }, (_, i) => {
  const x = (i % 30) * 3,
    y = ((i / 30) | 0) * 3;
  return `<path d="M${x} ${y} C${x + 2} ${y} ${x + 3} ${y + 1} ${x + 3} ${y + 3} L${x} ${y + 2}Z" fill="#${(i % 7) + 2}${(i % 5) + 2}${(i % 3) + 2}"/>`;
}).join('');
const sec = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${paths}</svg>`,
  { preserveViewport: true },
);
const sized = (pipelineMs) => {
  const W = createPendingGl({ linkMs: 1, pipelineMs });
  const gl = W.gl,
    buf = new Map();
  let cur = null;
  const bb = gl.bindBuffer;
  gl.bindBuffer = (t, b) => {
    if (t === gl.ARRAY_BUFFER) cur = b;
    return bb.call(gl, t, b);
  };
  const bd = gl.bufferData;
  gl.bufferData = (t, d, u) => {
    if (t === gl.ARRAY_BUFFER)
      buf.set(cur, typeof d === 'number' ? { n: d, f: 0 } : { n: d.byteLength, f: d.byteLength });
    return bd.call(gl, t, d, u);
  };
  const bs = gl.bufferSubData || (() => {});
  gl.bufferSubData = (t, off, d) => {
    const e = buf.get(cur);
    if (e) e.f += d.byteLength;
    return bs.call(gl, t, off, d);
  };
  return {
    W,
    unfilled: () => [...buf.values()].filter((e) => e.n >= 16384 && e.f < e.n).length,
    big: () => [...buf.values()].filter((e) => e.n >= 16384).length,
  };
};
async function mk(pipelineMs) {
  const s = sized(pipelineMs);
  const R = createRenderer(s.W.gl, taggedShaderSources(), OPTS);
  R.ready.catch(() => {});
  setTimeout(() => s.W.release(), 10);
  await R.ready;
  R.setViewport(128, 128);
  return { ...s, R };
}
for (const [name, pipelineMs, warmTimeoutMs] of [
  ['normal', 1, 180000],
  ['deadline, the GPU thread busy', 600, 300],
]) {
  console.log(`(${name})`);
  const { W, R, unfilled, big } = await mk(pipelineMs);
  createBundle(W.gl, sec);
  await R.precompileFillsAsync({ warmTimeoutMs, timeoutMs: 50 });
  ok(
    pendingUploadBytes(W.gl) === 0,
    `nothing pending when it settles (${pendingUploadBytes(W.gl)} bytes)`,
  );
  ok(big() > 0 && unfilled() === 0, `every big buffer filled (${unfilled()} of ${big()} unfilled)`);
  R.dispose();
}
console.log(
  '(dispose) a loading call cut short leaves no fill of another renderer on the context behind',
);
{
  const { W, R: A, unfilled } = await mk(800);
  const B = createRenderer(W.gl, taggedShaderSources(), OPTS);
  B.ready.catch(() => {});
  await B.ready;
  B.setViewport(128, 128);
  createBundle(
    W.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>',
      { preserveViewport: true },
    ),
  );
  const load = A.precompileFillsAsync({});
  await sleep(30);
  const big = createBundle(W.gl, sec);
  B.beginFrame([1, 1, 1, 1]);
  B.drawBundle(big);
  B.endFrame();
  ok(
    pendingUploadBytes(W.gl) > 0,
    `the premise: B's big bundle went cooperative (${pendingUploadBytes(W.gl)} bytes)`,
  );
  A.dispose();
  await load.catch(() => {});
  ok(
    pendingUploadBytes(W.gl) === 0 && unfilled() === 0,
    `B's fill finished (${pendingUploadBytes(W.gl)} bytes pending, ${unfilled()} unfilled)`,
  );
  B.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
