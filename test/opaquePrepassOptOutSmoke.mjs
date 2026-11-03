// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassOptOutSmoke: the opaque depth prepass runs by default and createRenderer({ opaquePrepass: false }) turns it off.
// It is a depth-only optimization, so the output must not depend on it (opaquePrepassSmoke and opaquePrepassShapeCountSmoke hold the pixels).
// The prepass writes depth from occupancy cells in the bundle's authored frame, so a nine-sliced bundle (its fills rewritten
// into a resized frame) must not run it; the same bundle back in its native frame does again.
// Node, fake GL: the engagement counter, not pixels.
import { M, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const N = 512;
const blob = (x, y, c) =>
  `<path fill="${c}" d="M ${x - 120} ${y} C ${x - 120} ${y - 150} ${x + 120} ${y - 150} ${x + 120} ${y} C ${x + 120} ${y + 150} ${x - 120} ${y + 150} ${x - 120} ${y} Z"/>`;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: 12 }, (_, i) =>
    blob(256 + (i % 3) * 9, 256 + (i % 4) * 7, `hsl(${i * 29},65%,48%)`),
  ).join('') +
  '</svg>';

const setup = async (ropts) => {
  const { R, gl } = await mkRenderer(N, N, ropts);
  R.setLoopBlinnFill('off'); // the cover pass, where the prepass lives
  const bundle = M.createBundle(
    gl,
    await imp(svg, { preserveViewport: true, occupancyGrid: { grid: 24 } }),
  );
  // Prepass runs over `n` frames of the bundle.
  const runs = (n) => {
    const before = R.debugStats.opaquePrepassCount | 0;
    for (let i = 0; i < n; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(bundle, {});
      R.endFrame();
    }
    return (R.debugStats.opaquePrepassCount | 0) - before;
  };
  return { bundle, runs };
};

const def = await setup({});
check('the occupancy grid is ready (non-vacuous)', def.bundle.hasOccupancy === true);
const defCount = def.runs(3);
check('the default renderer runs the opaque prepass', defCount === 3, 'ran ' + defCount);
const offCount = (await setup({ opaquePrepass: false })).runs(3);
check('opaquePrepass:false never runs it', offCount === 0, 'ran ' + offCount);
const on = await setup({ opaquePrepass: true });
const onCount = on.runs(3);
check('opaquePrepass:true runs it', onCount === 3, 'ran ' + onCount);

// Nine-slice, on the opaquePrepass:true renderer.
const { bundle, runs } = on;
check('the occupancy grid is ready', bundle.hasOccupancy === true);
check('the unsliced bundle runs the prepass', runs(1) === 1);
bundle.applyNineSlice({ border: [100, 100, 100, 100], worldSize: [900, 900] });
check('the bundle is nine-sliced', bundle._nineSliceActive === true);
check('a nine-sliced bundle does not run the prepass', runs(1) === 0);
bundle.applyNineSlice({ border: [0, 0, 0, 0] });
check(
  'restored to the native frame, it runs again',
  bundle._nineSliceActive === false && runs(1) === 1,
);
finish('opaquePrepassOptOutSmoke');
