// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullListRefreshSmoke: the uncut draw list follows every rebuild of the draw list (node, fake GL).
// A bundle whose inline cull dropped a coincident layer keeps the full list in drawListUnculled. applyNineSlice and the full stream
// rebuild make a new list with new chunk objects; the uncut list must be that list, or the first override that retires the cull swaps
// in a list whose chunk ranges belong to the mesh before the rebuild.
import { M, wrap, imp, mkRenderer, check, finish } from './_exportHarness.mjs';
import { mkCubic } from '../src/primitives/seg.js';

const { R, gl } = await mkRenderer(100, 100, { captureFrames: false });
const stale = (b) =>
  b.drawList.filter((op) => op.chunk && !b.chunkByShape.includes(op.chunk)).length;
const layers = wrap(
  '<rect id="under" x="20" y="20" width="60" height="60" fill="green"/><rect id="over" x="20" y="20" width="60" height="60" fill="red"/>',
);

{
  const b = M.createBundle(gl, await imp(layers));
  check(
    'the coincident layer is culled at build',
    b.drawList.length === 1 && b.drawListUnculled.length === 2,
  );
  b.applyNineSlice({ border: [10, 10, 10, 10], worldSize: [200, 200] });
  check('applyNineSlice: the uncut list is the rebuilt list', b.drawListUnculled === b.drawList);
  const table = M.createOverrideTable(gl, b);
  table.set('over', { visibility: 0.5 });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { overrides: table });
  R.endFrame();
  check('applyNineSlice: an override draw keeps current chunk ranges', stale(b) === 0, stale(b));
}

{
  const K = 0.5522847498,
    blob = (cx, cy, r) => {
      const E = [cx + r, cy],
        N = [cx, cy - r],
        W = [cx - r, cy],
        S = [cx, cy + r],
        k = K * r;
      return [
        mkCubic(E, [cx + r, cy - k], [cx + k, cy - r], N),
        mkCubic(N, [cx - k, cy - r], [cx - r, cy - k], W),
        mkCubic(W, [cx - r, cy + k], [cx - k, cy + r], S),
        mkCubic(S, [cx + k, cy + r], [cx + r, cy + k], E),
      ];
    };
  const sections = (r) =>
    M.buildStreamableSections(
      [
        { segs: blob(50, 50, r), fill: [0, 1, 0, 1] },
        { segs: blob(50, 50, r), fill: [1, 0, 0, 1] },
      ],
      null,
      {},
    );
  const b = M.createBundle(gl, sections(30));
  const culledAtBuild = b.drawList !== b.drawListUnculled;
  M.updateBundleGeometry(gl, b, [blob(50, 50, 32), blob(50, 50, 32)]);
  check(
    'stream rebuild: the uncut list is the rebuilt list' +
      (culledAtBuild ? '' : ' (no cull at build)'),
    b.drawListUnculled === b.drawList,
  );
  check('stream rebuild: no stale chunk ranges', stale(b) === 0, stale(b));
}
finish('occlusionCullListRefreshSmoke');
