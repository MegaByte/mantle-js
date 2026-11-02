// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullRetiredSmoke: a cull an override retired stays retired (node, fake GL, the real occlusion worker).
// Scene: a small square wholly inside a larger opaque one that is drawn later. The worker half of the cull finds it only after the
// bundle is built. An override that hides the occluder retires the cull on the first draw, while the worker is still out; the
// worker's late answer must not put the cut list back over the draw, and the kill-switch tick must not either.
import { M, wrap, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const { R, gl } = await mkRenderer(100, 100, { captureFrames: false });
const bundle = M.createBundle(
  gl,
  await imp(
    wrap(
      '<rect id="under" x="40" y="40" width="10" height="10" fill="green"/><rect id="over" x="10" y="10" width="80" height="80" fill="red"/>',
    ),
  ),
);
check(
  'the worker half is still pending',
  bundle._occlusionCullPending === true && bundle.drawList.length === 2,
);
const table = M.createOverrideTable(gl, bundle);
table.set('over', { visibility: 0 });
R.beginFrame([1, 1, 1, 1]);
R.drawBundle(bundle, { overrides: table });
R.endFrame();
check(
  'the first override draw retires the cull before the worker answers',
  bundle._cullRetired === true,
);
for (let i = 0; i < 100 && bundle._occlusionCullPending; i++)
  await new Promise((r) => setTimeout(r, 50));
check(
  'the worker answered',
  bundle._occlusionCullPending === false && bundle._culledShapes && bundle._culledShapes.has(0),
);
check(
  'the late cull leaves the full list in place',
  bundle.drawList === bundle.drawListUnculled && bundle.drawList.length === 2,
  bundle.drawList.length,
);
const handle = R.createBundleHandle(bundle);
R.beginFrame([1, 1, 1, 1]);
handle.draw({ overrides: table });
R.endFrame();
check(
  'a handle draw (it ticks the kill switch) does not restore the cut list',
  bundle.drawList === bundle.drawListUnculled && bundle.drawList.length === 2,
);

// The instanced fast path reads the draw list too: it retires the cull itself, not only the classic pass.
R.setLoopBlinnFill('off');
const layered = M.createBundle(
  gl,
  await imp(
    wrap(
      '<rect id="under" x="20" y="20" width="60" height="60" fill="green"/><rect id="over" x="20" y="20" width="60" height="60" fill="red"/>',
    ),
  ),
);
check(
  'coincident layers are cut at build',
  layered.drawList.length === 1 && layered.drawListUnculled.length === 2,
);
const shared = M.createOverrideTable(gl, layered);
shared.set('over', { visibility: 0 });
const place = [
  { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
  { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.1, 0, 1]) },
];
R.beginFrame([1, 1, 1, 1]);
R.drawBundleInstanced(layered, place, { overrides: shared });
R.endFrame();
check(
  'an instanced draw with an override draws the whole list',
  layered.drawList === layered.drawListUnculled && layered.drawList.length === 2,
  layered.drawList.length,
);

// A sprite shows only its own rows: a row cut for an occluder in another sprite must come back for that sprite's draw.
const sheet = M.createBundle(
  gl,
  await imp(
    wrap(
      '<rect id="under" x="20" y="20" width="60" height="60" fill="green"/><rect id="over" x="20" y="20" width="60" height="60" fill="red"/>',
    ),
  ),
);
check(
  'the sheet cuts the covered sprite at build',
  sheet.drawList.length === 1 && sheet.drawListUnculled.length === 2,
);
const calls = [];
const instanced = gl.drawArraysInstanced.bind(gl);
gl.drawArraysInstanced = (mode, first, count, n) => {
  calls.push([first, count, n].join(','));
  return instanced(mode, first, count, n);
};
R.beginFrame([1, 1, 1, 1]);
R.drawSpriteInstanced(sheet, 'under', place);
R.endFrame();
check('the covered sprite still draws its own quad', calls.join(';') === '0,6,2', calls.join(';'));
check(
  'the sheet keeps a whole list once a sprite needed it',
  sheet.drawList === sheet.drawListUnculled,
);
finish('occlusionCullRetiredSmoke');
process.exit(0);
