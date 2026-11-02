// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamFillsCheckSmoke: updateBundleGeometry refuses a fill it cannot use, as it refuses a non-finite coordinate, before anything is mutated.
// A three-element fill or a NaN channel must not reach the row's color and alpha as NaN and be reported as ok.
// CPU, on a stand-in GL.
const { M, mkRenderer } = await import('./_exportHarness.mjs');
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
const { gl } = await mkRenderer(100, 100);
const { mkLine } = M;
const tri = (x) => [
  mkLine([x, 0], [x + 10, 0]),
  mkLine([x + 10, 0], [x, 10]),
  mkLine([x, 10], [x, 0]),
];
const lightOptions = [{ lightweight: true }, { lightweight: false }];
for (const base of lightOptions) {
  const b = M.createBundle(
    gl,
    M.buildStreamableSections(
      [
        { segs: tri(0), fill: [1, 0, 0, 1] },
        { segs: tri(20), fill: [0, 1, 0, 1] },
      ],
      [0, 0, 100, 100],
      base,
    ),
  );
  const row = () => Array.from(b.metaFloats.subarray(48 + 4, 48 + 8)).join();
  const before = row(),
    gen = b._geomGen;
  for (const bad of [
    [0, 0, 1],
    [NaN, 0, 1, 1],
    [0, 0, 1, Infinity],
    [0, 0, 1, undefined],
  ]) {
    const r = M.updateBundleGeometry(gl, b, [tri(1), tri(21)], { ...base, fills: [null, bad] });
    check(
      `${JSON.stringify(base)}: fill ${String(bad)} is refused`,
      r.ok === false && /fills\[1\]/.test(r.reason || ''),
      JSON.stringify(r),
    );
    check(
      `${JSON.stringify(base)}: fill ${String(bad)} leaves the bundle as it was`,
      row() === before && b._geomGen === gen,
      row(),
    );
  }
  const good = M.updateBundleGeometry(gl, b, [tri(1), tri(21)], {
    ...base,
    fills: [null, [0, 0, 1, 0.5]],
  });
  check(
    `${JSON.stringify(base)}: a good fill still lands`,
    good.ok === true && row() === '0,0,1,0.5',
    row(),
  );
  const none = M.updateBundleGeometry(gl, b, [tri(2), tri(22)], base);
  check(
    `${JSON.stringify(base)}: no fills, as before`,
    none.ok === true && row() === '0,0,1,0.5',
    row(),
  );
  b.dispose();
}
console.warn = warn;
if (fails) {
  console.log(`streamFillsCheckSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('streamFillsCheckSmoke PASS');
process.exit(0);
