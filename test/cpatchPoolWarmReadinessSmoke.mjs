// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercise the public loading hook with deliberately withheld worker replies.
// Pixel and worker evidence is in the separate physical-GPU check.
import assert from 'node:assert/strict';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { createRenderer } from '../src/renderer/renderer.js';
import '../src/renderer/features/cpatch.js';
import { cpatchPoolStats, disposeCpatchPool } from '../src/renderer/cpatchWorkerPool.js';

globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_POOL_N = 2;
globalThis.__CP_WARM_ROUNDS = 2;
const pending = [];
let posts = 0;
globalThis.Worker = class {
  postMessage(data) {
    posts++;
    pending.push({ worker: this, data });
  }
  terminate() {}
};
const make = () =>
  createRenderer(createFakeGl().gl, taggedShaderSources(), {
    cpatchFill: true,
    loopBlinnFill: 'off',
    psoWarmIdle: () => true,
  });
const a = make(),
  b = make();
assert.equal(typeof a.warmCPatchPool, 'function');
let settled = false;
const promise = a.warmCPatchPool();
promise.then(() => {
  settled = true;
});
assert.equal(a.warmCPatchPool(), promise);
assert.equal(b.warmCPatchPool(), promise);
await Promise.resolve();
assert.equal(settled, false, 'must await the workers, not just schedule them');
assert.equal(cpatchPoolStats().posted, 4);
while (pending.length) {
  const { worker, data } = pending.shift();
  worker.onmessage({ data: { id: data.id, out: [] } });
}
assert.equal(await promise, true);
assert.equal(cpatchPoolStats().inflight + cpatchPoolStats().queued, 0);
for (let i = 0; i < 65; i++) {
  a.beginFrame([0, 0, 0, 0]);
  a.endFrame();
  b.beginFrame([0, 0, 0, 0]);
  b.endFrame();
}
assert.equal(posts, 4, 'later idle frames do not queue another synthetic warm-up');
assert.equal(a.warmCPatchPool(), promise);
disposeCpatchPool();
const c = make();
const stopped = c.warmCPatchPool();
disposeCpatchPool();
assert.equal(await stopped, false, 'disposal settles an unfinished warm-up');
delete globalThis.Worker;
assert.equal(await make().warmCPatchPool(), false, 'worker-less host reports unavailable');
console.log('CPATCH-POOL-WARM-READINESS PASS');
