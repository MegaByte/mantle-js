// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// handleExportSmoke -- exportFrameSVG of a frame drawn through a mount is the export of the same frame through drawBundle.
//
// The recorder must run for handle.draw as well as drawDispatch: otherwise a frame drawn with handle.draw exports nothing (drawn 0, skipped 0, an empty SVG with no note). CPU, recording GL stand-in.
import { M, mkRenderer, wrap, imp, dom } from './_exportHarness.mjs';
const { createOverrideTable } = await import('../src/animation/overrides.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const { R, gl: GL } = await mkRenderer(256, 256);
const b = M.createBundle(
  GL,
  await imp(
    wrap(
      '<rect id="vis" x="10" y="10" width="20" height="20" fill="#c00"/><rect id="b" x="50" y="50" width="20" height="20" fill="#00c"/>',
    ),
    { preserveViewport: true },
  ),
);
const run = async (f) => {
  R.setFrameCapture(true);
  R.beginFrame([1, 1, 1, 1]);
  f();
  R.endFrame();
  const r = await R.exportFrameSVG({ detail: true, document: dom });
  return { drawn: r.drawn, skipped: r.skipped, svg: String(r.svg) };
};
const table = createOverrideTable(GL, b);
table.set('b', { fill: [0, 1, 0, 1] });
const CASES = [
  ['plain', {}],
  ['a world matrix', { worldMatrix: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.25, 0.1, 1]) }],
  ['an override table', { overrides: table }],
  ['a fade', { alpha: 0.5 }],
  [
    'a color matrix',
    { colorMatrix: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]) },
  ],
  ['a destination rect', { dstRect: [10, 20, 100, 60] }],
];
const h = R.createBundleHandle(b);
for (const [name, opts] of CASES) {
  const bare = await run(() => R.drawBundle(b, opts));
  const mount = await run(() => h.draw(opts));
  ok(bare.drawn === 1, `${name}: the premise, drawBundle exports its draw`);
  ok(
    mount.drawn === bare.drawn && mount.skipped === bare.skipped,
    `${name}: the mount exports it too (drawn ${mount.drawn}, skipped ${mount.skipped})`,
  );
  ok(mount.svg === bare.svg, `${name}: and the same SVG (${mount.svg.length} characters)`);
}
{
  // A mount drawn outside a frame is not part of the frame's export, as drawBundle's is not.
  R.setFrameCapture(true);
  R.beginFrame([1, 1, 1, 1]);
  R.endFrame();
  h.draw();
  const r = await R.exportFrameSVG({ detail: true, document: dom });
  ok(r.drawn === 0, 'a mount drawn outside a frame is not exported');
}
R.dispose();
console.log(fail ? `handleExportSmoke: ${fail} FAILED` : 'handleExportSmoke: PASS');
process.exit(fail ? 1 : 0);
