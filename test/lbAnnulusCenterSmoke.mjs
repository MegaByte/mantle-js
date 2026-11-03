// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAnnulusCenterSmoke: two circles are one annulus only around one center. Off center they keep their own geometry, whatever the size.
const { extractAnnuli, arcToRationalQuads } = await import('../src/geom/lbContour.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const circle = (cx, cy, r, dir = 1) =>
  arcToRationalQuads(cx, cy, r, r, 0, dir * Math.PI, 0).concat(
    arcToRationalQuads(cx, cy, r, r, dir * Math.PI, dir * 2 * Math.PI, 0),
  );
for (const k of [1 / 1024, 1, 1024]) {
  const outer = circle(50 * k, 50 * k, 40 * k);
  for (const rule of ['evenodd', 'nonzero']) {
    const dir = rule === 'evenodd' ? 1 : -1;
    ok(
      extractAnnuli([outer, circle(50 * k, 50 * k, 30 * k, dir)], rule).annuli.length === 1,
      `scale ${k} ${rule}: concentric circles are an annulus`,
    );
    ok(
      extractAnnuli([outer, circle(50.01 * k, 50 * k, 30 * k, dir)], rule).annuli.length === 1,
      `scale ${k} ${rule}: a center within fit noise still is`,
    );
    ok(
      extractAnnuli([outer, circle(50.9 * k, 50 * k, 30 * k, dir)], rule).annuli.length === 0,
      `scale ${k} ${rule}: 2% of the radius off center is not`,
    );
    ok(
      extractAnnuli([outer, circle(50 * k, 51.1 * k, 30 * k, dir)], rule).annuli.length === 0,
      `scale ${k} ${rule}: nor in y`,
    );
  }
}
console.log(fail ? `FAIL (${fail})` : 'PASS');
process.exit(fail ? 1 : 0);
