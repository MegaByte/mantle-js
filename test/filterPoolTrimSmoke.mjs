// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPoolTrimSmoke -- the filter RT pool's idle trim (opts.filterPoolIdleMs) frees only what a live scene will not ask for.
//
// Untrimmed, the pool keeps every size it was ever asked for (99 MB of 45 targets at 1536 px on a corpus scene, still allocated after
// every bundle is disposed). trim() frees ONE free target per call, and only when (a) the pool as a whole has had no acquire for idleMs, (b) the
// target itself has been idle that long, (c) it is not the viewport's size class (equal or larger). Pinned here on the pool alone
// (a fake GL counts deleteTexture); the renderer-level behavior is filterPoolTrimRenderSmoke.
import { createFakeGl } from './_fakeGl.mjs';
import { createRTPool } from '../src/filterGraph/filterGraph.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const { gl: base } = createFakeGl();
let deleted = 0,
  created = 0;
const gl = new Proxy(base, {
  get(t, k) {
    if (k === 'deleteTexture')
      return (x) => {
        deleted++;
        return t.deleteTexture(x);
      };
    if (k === 'createTexture')
      return () => {
        created++;
        return t.createTexture();
      };
    return t[k];
  },
});
const pool = createRTPool(gl);
const T0 = performance.now();
const take = (w, h) => {
  const i = pool.acquire(w, h);
  pool.release(i);
  return i;
};
take(40, 40);
take(64, 48);
take(256, 256); // two region-sized targets and one the size of a 256 px viewport
const IDLE = 1000;
ok(
  pool.trim(T0 + IDLE - 50, IDLE, 256, 256) === 0 && deleted === 0,
  'nothing is freed before the pool has been idle for the whole window',
);
ok(pool.trim(T0 + IDLE + 5000, 0, 256, 256) === 0, 'an idle window of 0 disables the trim');
const b1 = pool.trim(T0 + IDLE + 5000, IDLE, 256, 256);
ok(b1 > 0 && deleted === 1, `one target is freed per call (${b1} bytes)`);
const b2 = pool.trim(T0 + IDLE + 5000, IDLE, 256, 256);
ok(b2 > 0 && deleted === 2, 'the second call frees the other region-sized target');
ok(
  pool.trim(T0 + IDLE + 5000, IDLE, 256, 256) === 0 && deleted === 2,
  'the viewport-sized target is never freed, however idle',
);
ok(
  pool.trim(T0 + IDLE + 5000, IDLE, 300, 300) > 0 && deleted === 3,
  'a larger viewport makes the 256 px target ordinary (the protected class follows the viewport)',
);
// reuse after a trim allocates fresh and works
const before = created;
const i = pool.acquire(40, 40);
ok(created > before && pool.get(i) && pool.get(i).tex, 'a trimmed size is reallocated on demand');
pool.release(i);
// alternating scenes: acquires keep arriving inside the window, so nothing is ever eligible
{
  const p2 = createRTPool(gl);
  let d0 = deleted;
  const sizes = [
    [40, 40],
    [64, 48],
  ];
  for (let step = 0; step < 50; step++) {
    const [w, h] = sizes[step & 1];
    const idx = p2.acquire(w, h);
    p2.release(idx);
    p2.trim(performance.now() + 0, IDLE, 256, 256);
  }
  ok(deleted === d0, 'alternating acquires inside the window never trigger a trim');
}
{
  const p3 = createRTPool(gl);
  const k = p3.acquire(40, 40); // still ACQUIRED (a frame in progress): never freed whatever the clock says
  ok(p3.trim(performance.now() + 1e9, IDLE, 256, 256) === 0, 'an acquired target is never freed');
  p3.release(k);
  p3.invalidate();
  ok(true, 'invalidate() copes with a pool that has trimmed slots');
}
process.exit(fail ? 1 : 0);
