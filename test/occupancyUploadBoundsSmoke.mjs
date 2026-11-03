// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Validate CPU-generated upload packets and callback eligibility, without
// modeling GPU storage. The GPU companion checks real texture contents.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
let worker;
globalThis.Worker = class {
  constructor() {
    worker = this;
    this.jobs = [];
  }
  postMessage(job) {
    this.jobs.push(job);
  }
  terminate() {}
};
const root =
  process.env.MANTLE_OCCUPANCY_SOURCE_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import(pathToFileURL(path.join(root, 'src/svg/importer.js')));
const { createBundle } = await import(pathToFileURL(path.join(root, 'src/renderer/bundle.js')));
const { disposeOccupancyWorker } = await import(
  pathToFileURL(path.join(root, 'src/renderer/occupancyWorkerPool.js'))
);
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10H90V90H10Z"/></svg>',
  { occupancyGrid: false },
);
const W = 4096,
  RF = W * 4;
function uploadSpy() {
  const canvas = new EventTarget(),
    calls = [],
    constants = new Map();
  const methods = {
    canvas,
    createTexture: () => ({}),
    deleteTexture() {},
    deleteBuffer() {},
    deleteVertexArray() {},
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    getParameter: () => 4096,
    texSubImage2D(target, level, x, y, w, h, format, type, data) {
      calls.push({ target, level, x, y, w, h, format, type, data: data.slice() });
    },
  };
  for (const name of [
    'texImage3D',
    'texStorage2D',
    'texStorage3D',
    'generateMipmap',
    'bufferData',
    'renderbufferStorage',
    'renderbufferStorageMultisample',
    'deleteRenderbuffer',
  ])
    methods[name] = undefined;
  const gl = new Proxy(methods, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) {
        if (!constants.has(key)) constants.set(key, Symbol(key));
        return constants.get(key);
      }
      throw Error('Unexpected native call ' + String(key));
    },
  });
  return { gl, calls, lose: () => canvas.dispatchEvent(new Event('webglcontextlost')) };
}
function run(label, length, grids, expectedRanges, state = 'live') {
  const cv = Float32Array.from({ length }, (_, i) => (i % 113) + 0.25),
    expected = cv.slice();
  const { gl, calls, lose } = uploadSpy();
  const bundle = createBundle(
    gl,
    {
      ...sec,
      curves: cv.buffer,
      pendingTier3: [],
      pendingOccupancy: grids.map((g) => ({ base: g.base, G: g.G })),
    },
    { deferPreparation: true },
  );
  calls.length = 0;
  const job = worker.jobs.pop();
  assert(job);
  if (state === 'generation') bundle._geomGen = (bundle._geomGen | 0) + 1;
  if (state === 'replacement') bundle.curveFloats = new Float32Array(length);
  if (state === 'disposed') bundle.dispose();
  if (state === 'resource-generation') lose();
  const out = grids.map((g) => ({
    ...g,
    bits: Float32Array.from({ length: g.G * g.G }, (_, i) => i + 1),
  }));
  if (state === 'live') for (const g of out) expected.set(g.bits, g.base * 4);
  worker.onmessage({ data: { id: job.id, occ: out, tier3: [] } });
  assert.deepEqual(cv, expected, label + ' CPU curve data');
  assert.equal(bundle.hasOccupancy, state === 'live', label + ' activation');
  assert.equal(bundle._occupancyBuildPending, false);
  const ranges = calls.map(({ x, y, w, h }) => ({ x, y, w, h }));
  assert.deepEqual(ranges, expectedRanges, label + ' upload ranges');
  for (const call of calls) {
    assert.equal(call.target, gl.TEXTURE_2D);
    assert.equal(call.level, 0);
    assert.equal(call.format, gl.RGBA);
    assert.equal(call.type, gl.FLOAT);
    assert(call.x >= 0 && call.y >= 0 && call.w > 0 && call.h > 0 && call.x + call.w <= W);
    assert.equal(call.data.length, call.w * call.h * 4);
    assert(call.h === 1 || (call.x === 0 && call.w === W));
    const start = (call.y * W + call.x) * 4,
      end = start + call.data.length;
    assert(end <= length, label + ' must not upload padding or appended coefficients');
    assert.deepEqual(call.data, expected.subarray(start, end), label + ' upload payload');
  }
  console.log(label, JSON.stringify(ranges));
  bundle.dispose();
  disposeOccupancyWorker();
}
try {
  run('short final row', 320, [{ base: 10, G: 16 }], [{ x: 0, y: 0, w: 80, h: 1 }]);
  run('exact full row', RF, [{ base: W - 64, G: 16 }], [{ x: 0, y: 0, w: W, h: 1 }]);
  run(
    'full row and final tail',
    RF + 320,
    [{ base: W - 32, G: 16 }],
    [
      { x: 0, y: 0, w: W, h: 1 },
      { x: 0, y: 1, w: 80, h: 1 },
    ],
  );
  run(
    'three affected rows',
    RF * 2 + 320,
    [
      { base: 10, G: 16 },
      { base: W * 2 + 10, G: 16 },
    ],
    [
      { x: 0, y: 0, w: W, h: 2 },
      { x: 0, y: 2, w: 80, h: 1 },
    ],
  );
  run('late row only', RF * 2 + 320, [{ base: W * 2 + 10, G: 16 }], [{ x: 0, y: 2, w: 80, h: 1 }]);
  run(
    'unchanged append beyond affected row',
    RF * 2 + 320,
    [{ base: 10, G: 16 }],
    [{ x: 0, y: 0, w: W, h: 1 }],
  );
  for (const state of ['generation', 'replacement', 'disposed', 'resource-generation'])
    run('ignore ' + state, 320, [{ base: 10, G: 16 }], [], state);
  console.log('occupancyUploadBoundsSmoke PASS');
} finally {
  disposeOccupancyWorker();
  delete globalThis.Worker;
}
