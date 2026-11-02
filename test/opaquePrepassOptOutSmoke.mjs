// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassOptOutSmoke: the opaque depth prepass runs by default and createRenderer({ opaquePrepass: false }) turns it off.
// It is a depth-only optimization, so the output must not depend on it (opaquePrepassSmoke and opaquePrepassShapeCountSmoke hold the pixels).
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

const runs = async (ropts) => {
  const { R, gl } = await mkRenderer(N, N, ropts);
  R.setLoopBlinnFill('off'); // the cover pass, where the prepass lives
  const bundle = M.createBundle(
    gl,
    await imp(svg, { preserveViewport: true, occupancyGrid: { grid: 24 } }),
  );
  const before = R.debugStats.opaquePrepassCount | 0;
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(bundle, {});
    R.endFrame();
  }
  return {
    ready: bundle.hasOccupancy === true,
    count: (R.debugStats.opaquePrepassCount | 0) - before,
  };
};

const def = await runs({});
check('the occupancy grid is ready (non-vacuous)', def.ready);
check('the default renderer runs the opaque prepass', def.count === 3, 'ran ' + def.count);
const off = await runs({ opaquePrepass: false });
check('opaquePrepass:false never runs it', off.count === 0, 'ran ' + off.count);
const on = await runs({ opaquePrepass: true });
check('opaquePrepass:true runs it', on.count === 3, 'ran ' + on.count);
finish('opaquePrepassOptOutSmoke');
