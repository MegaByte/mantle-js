// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassNineSliceSmoke: the opaque prepass writes depth from occupancy cells in the bundle's authored frame, so a nine-sliced
// bundle (its fills rewritten into a resized frame) must not run it; the same bundle without the slice still does (node, fake GL).
import { M, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const { R, gl } = await mkRenderer(512, 512, { opaquePrepass: true });
const N = 512;
const blob = (x, y, c) =>
  `<path fill="${c}" d="M ${x - 120} ${y} C ${x - 120} ${y - 150} ${x + 120} ${y - 150} ${x + 120} ${y} C ${x + 120} ${y + 150} ${x - 120} ${y + 150} ${x - 120} ${y} Z"/>`;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: 12 }, (_, i) =>
    blob(256 + (i % 3) * 9, 256 + (i % 4) * 7, `hsl(${i * 29},65%,48%)`),
  ).join('') +
  '</svg>';
R.setLoopBlinnFill('off');
const bundle = M.createBundle(
  gl,
  await imp(svg, { preserveViewport: true, occupancyGrid: { grid: 24 } }),
);
const runs = () => {
  const before = R.debugStats.opaquePrepassCount | 0;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(bundle, {});
  R.endFrame();
  return (R.debugStats.opaquePrepassCount | 0) - before;
};
check('the occupancy grid is ready', bundle.hasOccupancy === true);
check('the unsliced bundle runs the prepass', runs() === 1);
bundle.applyNineSlice({ border: [100, 100, 100, 100], worldSize: [900, 900] });
check('the bundle is nine-sliced', bundle._nineSliceActive === true);
check('a nine-sliced bundle does not run the prepass', runs() === 0);
bundle.applyNineSlice({ border: [0, 0, 0, 0] });
check(
  'restored to the native frame, it runs again',
  bundle._nineSliceActive === false && runs() === 1,
);
finish('opaquePrepassNineSliceSmoke');
