// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// submitQueueAllocSmoke — the zOrder submit queue allocates per RENDERER, not per submit.
//
// `submitBundle` is the one call every multi-mount app makes in its inner loop, once per
// bundle per frame. A fresh `{target, opts, z, seq}` record for each one, and a fresh array
// in `_flushSubmitQueue` to replace the list it is about to walk, would make a scene with M
// mounts run M+1 allocations a frame purely to say what it is going to draw, forever, on the
// one path that exists to be called every frame.
//
// Both are pooled. The list swaps with a spare that the previous flush emptied; the
// records come from a free list and are handed back AFTER their draw, with `target` and
// `opts` nulled so a pooled record never keeps a disposed bundle or a caller's options
// object alive.
//
// `R._submitEntryAllocs` counts records ever CREATED — the only way to observe a closure's
// allocation from outside it. Steady state must be the high-water mark of submits in ONE
// frame, never submits x frames.
//
// What must NOT change is the ordering contract, so this re-asserts it here rather than
// trusting that the browser lane covers it: lower zOrder paints first, equal zOrder keeps
// submission order, a submit outside a frame draws immediately, and a submit issued DURING
// the flush is painted in that same frame rather than appended to the list being walked.
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const { attachFrameLoop } = await import('../src/renderer/frameLoop.js');

const glStub = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
    },
  );

function makeRenderer() {
  const painted = [];
  const R = {
    gl: glStub(),
    opts: {},
    draw: {},
    _painted: painted,
    _inFrame: false,
    _contextLost: false,
    _frameSerial: 0,
    _lastSeenW: 0,
    _lastSeenH: 0,
    _scissor: null,
    _captureFrames: false,
    _frameLog: [],
    viewportSize: () => [256, 256],
    _canvasUnsized: () => false,
    glViewport: () => {},
    glDisable: () => {},
    glEnable: () => {},
    glDepthMask: () => {},
    fillWarmTick: () => {},
    drawBundle: (t) => {
      painted.push(t);
    },
  };
  attachFrameLoop(R);
  return R;
}

// ── 1. the allocation ───────────────────────────────────────────────────────
console.log('\n  allocations:');
{
  const R = makeRenderer();
  const MOUNTS = 8,
    FRAMES = 120;
  for (let f = 0; f < FRAMES; f++) {
    R.beginFrame([0, 0, 0, 0]);
    for (let m = 0; m < MOUNTS; m++) R.submitBundle({ id: m }, { zOrder: m });
    R.endFrame();
  }
  ok(
    R._painted.length === MOUNTS * FRAMES,
    `${MOUNTS} mounts x ${FRAMES} frames painted ${R._painted.length} bundles`,
  );
  ok(
    R._submitEntryAllocs === MOUNTS,
    `queue records ever allocated: ${R._submitEntryAllocs} (the per-frame high-water mark, ` +
      `not ${MOUNTS * FRAMES})`,
  );
}
{
  // The pool grows to the WORST frame and then stops, rather than to the total.
  const R = makeRenderer();
  const plan = [3, 11, 5, 11, 2, 7];
  for (const n of plan) {
    R.beginFrame([0, 0, 0, 0]);
    for (let m = 0; m < n; m++) R.submitBundle({ id: m }, null);
    R.endFrame();
  }
  ok(
    R._submitEntryAllocs === Math.max(...plan),
    `a varying frame count allocates the maximum once (${R._submitEntryAllocs} for ` +
      `${JSON.stringify(plan)})`,
  );
}

// ── 2. a pooled record never retains what it painted ────────────────────────
console.log('\n  retention:');
{
  const R = makeRenderer();
  const held = [];
  R.drawBundle = (t) => {
    held.push(t);
  };
  R.beginFrame([0, 0, 0, 0]);
  const opts = { zOrder: 1, worldMatrix: new Float32Array(9) };
  R.submitBundle({ id: 'a' }, opts);
  R.endFrame();
  // Re-submitting once more must take the same record back out of the pool and overwrite it,
  // so a stale target can never be painted twice.
  R.beginFrame([0, 0, 0, 0]);
  R.submitBundle({ id: 'b' }, null);
  R.endFrame();
  ok(R._submitEntryAllocs === 1, "the second frame reused the first frame's record");
  ok(
    held.length === 2 && held[0].id === 'a' && held[1].id === 'b',
    `and painted the right bundle each time (${held.map((h) => h.id).join(',')})`,
  );
}

// ── 3. the ordering contract, unchanged ─────────────────────────────────────
console.log('\n  ordering:');
{
  const R = makeRenderer();
  R.beginFrame([0, 0, 0, 0]);
  R.submitBundle({ id: 'hud' }, { zOrder: 300 });
  R.submitBundle({ id: 'bg' }, { zOrder: 0 });
  R.submitBundle({ id: 'mid1' }, { zOrder: 100 });
  R.submitBundle({ id: 'mid2' }, { zOrder: 100 });
  R.endFrame();
  ok(
    R._painted.map((p) => p.id).join(',') === 'bg,mid1,mid2,hud',
    `lower z first, equal z in submission order (${R._painted.map((p) => p.id).join(',')})`,
  );
}
{
  const R = makeRenderer();
  R.submitBundle({ id: 'stray' }, null); // outside a frame
  ok(
    R._painted.length === 1 && R._painted[0].id === 'stray',
    'a submit outside a frame draws immediately rather than being dropped',
  );
  ok(R._submitEntryAllocs === 0, '...and allocates no queue record at all');
}
{
  // Re-entrancy: drawBundle submits. The new entry must land in a DIFFERENT list from the
  // one being walked, and must still be painted this frame (endFrame drains).
  const R = makeRenderer();
  let once = false;
  R.drawBundle = (t) => {
    R._painted.push(t);
    if (!once) {
      once = true;
      R.submitBundle({ id: 'nested' }, { zOrder: -5 });
    }
  };
  R.beginFrame([0, 0, 0, 0]);
  R.submitBundle({ id: 'first' }, { zOrder: 0 });
  R.submitBundle({ id: 'second' }, { zOrder: 1 });
  R.endFrame();
  ok(
    R._painted.map((p) => p.id).join(',') === 'first,second,nested',
    `a submit issued during the flush paints in the same frame (${R._painted.map((p) => p.id).join(',')})`,
  );
}
{
  // A frame that never reaches endFrame (context lost) must not leave a backlog, and must
  // not hand the pool records still pointing at bundles.
  const R = makeRenderer();
  R.beginFrame([0, 0, 0, 0]);
  R.submitBundle({ id: 'lost' }, null);
  R._contextLost = true;
  R.beginFrame([0, 0, 0, 0]);
  R._contextLost = false;
  R.beginFrame([0, 0, 0, 0]);
  R.submitBundle({ id: 'after' }, null);
  R.endFrame();
  ok(
    R._painted.map((p) => p.id).join(',') === 'after',
    `the stale backlog is dropped, not painted late (${R._painted.map((p) => p.id).join(',')})`,
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
