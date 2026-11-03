// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamFrameFixedSmoke -- an update keeps a frame the author fixed (buildStreamableSections' fixedBBox, importSvg's preserveViewport, the scene API's), full or lightweight,
// so the picture does not rescale at the first update. Without a fixed frame the box follows the content, as a fresh tight import would. CPU, driver-model stand-in; the pixels are in streamWarmRenderSmoke.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createBundle, importSvg, buildStreamableSections, updateBundleGeometry, mkLine } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const tri = (x, y, s) => [
  mkLine([x, y], [x + s, y]),
  mkLine([x + s, y], [x, y + s]),
  mkLine([x, y + s], [x, y]),
];
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L 60 10 L 10 60 Z" fill="#303"/></svg>';
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const FRAME = [0, 0, 100, 100],
  CONTENT = [20, 30, 15, 15];
const fill = [0.2, 0, 0.2, 1];
const gl = () => createPendingGl({ linkMs: 1, pipelineMs: 1 }).gl;

for (const lightweight of [false, true]) {
  const mode = { lightweight };
  for (const [name, make, want] of [
    [
      'fixedBBox',
      () => buildStreamableSections([{ segs: tri(10, 10, 50), fill }], FRAME, { lightweight }),
      FRAME,
    ],
    [
      'no fixedBBox',
      () => buildStreamableSections([{ segs: tri(10, 10, 50), fill }], undefined, { lightweight }),
      CONTENT,
    ],
    ['preserveViewport', () => importSvg(svg, { preserveViewport: true }), FRAME],
    ['a tight import', () => importSvg(svg), CONTENT],
  ]) {
    const G = gl();
    const b = createBundle(G, await make());
    const r1 = updateBundleGeometry(G, b, [tri(20, 30, 15)], mode);
    ok(
      r1.ok && same(Array.from(b.globalBBox), want),
      `${name}, ${lightweight ? 'lightweight' : 'full'}: after an update the box is [${Array.from(b.globalBBox)}]`,
    );
    const r2 = updateBundleGeometry(G, b, [tri(20, 30, 15)], mode);
    ok(
      r2.ok && same(Array.from(b.globalBBox), want),
      `${name}, ${lightweight ? 'lightweight' : 'full'}: and after the next`,
    );
  }
}
if (fail) {
  console.error(`\nSTREAM-FRAME-FIXED FAIL (${fail})`);
  process.exit(1);
}
console.log('\nSTREAM-FRAME-FIXED PASS');
