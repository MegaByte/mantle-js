// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCacheMorphHashSmoke: the static cache's draw-state hash covers a morph bundle's t on its own. A handle created without the
// isMorphActive hook must not keep blitting the raster baked at another t (node, fake GL).
import { M, wrap, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const { R, gl } = await mkRenderer(100, 100);
const rect = (x) => `<rect id="a" x="${x}" y="10" width="20" height="20" fill="red"/>`;
const a = M.createBundle(gl, await imp(wrap(rect(0)))),
  b = M.createBundle(gl, await imp(wrap(rect(50))));
const morph = M.createShapeMorph(gl, a, b);
const handle = R.createBundleHandle(morph, {
  staticCache: { strategy: M.CacheStrategy.ForceWholeAsset },
});
const hashAt = (t) => {
  morph.setT(t);
  R.beginFrame([1, 1, 1, 1]);
  handle.draw({});
  R.endFrame();
  return handle._lastSeenDrawHash;
};
const h0 = hashAt(0),
  h0b = hashAt(0),
  h5 = hashAt(0.5),
  h5b = hashAt(0.5),
  h1 = hashAt(1);
check('the hash is stable at an unchanged t', h0 === h0b && h5 === h5b);
check(
  'the hash moves with the morph t',
  h0 !== h5 && h5 !== h1 && h0 !== h1,
  [h0, h5, h1].join(' '),
);
finish('staticCacheMorphHashSmoke');
