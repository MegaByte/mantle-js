// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nodeClipBundleDisposeSmoke: a setNodeClip registration ends with its bundle.
//
// The registry is a strong Map keyed by the target bundle, with a canvas-sized coverage texture per entry, so disposing the target must remove its
// entry: otherwise a scene that swaps clipped bundles keeps a texture (8 MB at 1080p) and every disposed bundle for the renderer's life.
// CPU: the memory ledger on a stand-in GL.
const { mkRenderer, wrap } = await import('./_exportHarness.mjs');
const warn = console.warn;
console.warn = () => {};
let fails = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('PASS', name);
  else {
    fails++;
    console.log('FAIL', name, detail ?? '');
  }
};
const { R, bundle } = await mkRenderer(100, 100);
const clipBytes = () => {
  const c = R.getMemoryStats({ bundles: false }).gpu.byCategory.clip;
  return c ? c.bytes : 0;
};
const rect = wrap('<rect width="50" height="50" fill="#f00"/>'),
  disc = wrap('<circle cx="50" cy="50" r="50"/>');
const clip = await bundle(disc);
const held = await bundle(rect);
R.setNodeClip(held, { clipBundle: clip });
const one = clipBytes();
check('the premise: a registration holds a coverage texture', one === 100 * 100 * 4, one);
for (let i = 0; i < 5; i++) {
  const t = await bundle(rect);
  R.setNodeClip(t, { clipBundle: clip });
  check(`bundle ${i}: its texture is held while it lives`, clipBytes() === 2 * one, clipBytes());
  t.dispose();
  check(`bundle ${i}: dispose frees its texture`, clipBytes() === one, clipBytes());
}
R.setNodeClip(held, { clipBundle: clip });
check('setting again replaces the texture', clipBytes() === one, clipBytes());
const hookCount = () => (held._disposeHooks ? [...held._disposeHooks].length : 0);
const before = hookCount();
R.setNodeClip(held, { clipBundle: clip });
check(
  'setting again does not stack hooks',
  hookCount() === before,
  `${before} then ${hookCount()}`,
);
R.clearNodeClip(held);
check('clearNodeClip frees it', clipBytes() === 0, clipBytes());
check('clearNodeClip removes the hook', hookCount() === before - 1, hookCount());
held.dispose();
check('disposing after a clear is safe', clipBytes() === 0);
const last = await bundle(rect);
R.setNodeClip(last, { clipBundle: clip });
const size = () => (last._disposeHooks ? last._disposeHooks.size : 0);
const b0 = size();
R.dispose();
check(
  'renderer dispose removes the hook from a live bundle',
  b0 > 0 && size() === b0 - 1,
  `${b0} then ${size()}`,
);
last.dispose();
console.warn = warn;
if (fails) {
  console.log(`nodeClipBundleDisposeSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('nodeClipBundleDisposeSmoke PASS');
process.exit(0);
