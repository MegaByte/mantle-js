// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCurveCutCloseSmoke — a curve cut's two sides close at the crossings it cut between.
//
// THE TRAP. cutPatchByCurve pairs each root of the extension's implicit along a boundary curve with the
// nearest root of that curve's implicit along the extension, keeps the pair only when the two points lie
// within the pairing tolerance, and then REFINES the extension parameter by Newton on the projection
// condition. Checking the pairing distance only before the refinement is not enough: where the extension's
// tangent is short or the curve turns, Newton walks to another part of the extension, and the seam then
// starts 5.4 units from where its side of the boundary stops. The side is an open loop, the area between is
// in neither piece, and it is a hole: tiger's shape 145 (a pixel the path covers 0.99, drawn 0).
//
// THE RULE. A refinement that does not stay within the pairing tolerance of the boundary point it refines is
// not taken; the pairing's own parameter is kept, which the tolerance already accepted.
//
// WHAT this PINS: the loop that cut is made on (four cubics of tiger's shape 145 in its conversion frame),
// cut along curve 1's extension as the search cuts it: both sides close at every joint to within the pairing
// tolerance, 1e-6 of the loop's coordinates' size. Without the rule a joint is 5.43 open.
const { cutPatchByCurve } = await import('../src/renderer/cpatchConvert.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const LOOP = [
  {
    t: 'cubic',
    P: [
      [81.92598831999976, 96.05115871999988],
      [81.92598831999976, 96.05115871999988],
      [0, 45.20054528000037],
      [64.97578383999962, 49.43809640000018],
    ],
  },
  {
    t: 'cubic',
    P: [
      [64.97578383999962, 49.43809640000018],
      [64.97578383999962, 49.43809640000018],
      [66.18068940043095, 50.053937019776185],
      [68.23659680150912, 51.082860919868345],
    ],
  },
  {
    t: 'cubic',
    P: [
      [68.23659680150912, 51.082860919868345],
      [70.2925042025873, 52.111784819960505],
      [73.19941344431231, 53.553792000368816],
      [76.60342080689969, 55.20612512163341],
    ],
  },
  {
    t: 'line',
    P: [
      [76.60342080689969, 55.20612512163341],
      [81.92598831999976, 96.05115871999988],
    ],
    cut: true,
  },
];
const BB = [39.9203451697971, 49.1872333736962, 81.92598831999976, 96.05115871999988];
let mag = 0;
for (const c of LOOP) for (const p of c.P) mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
const r = cutPatchByCurve(LOOP, 1, BB);
ok(!!(r && r.keep.length && r.drop.length), 'the extension still cuts the loop in two');
if (r)
  for (const [lab, l] of [
    ['keep', r.keep[0]],
    ['drop', r.drop[0]],
  ]) {
    let gap = 0;
    for (let q = 0; q < l.length; q++) {
      const a = l[q].P[l[q].P.length - 1],
        b = l[(q + 1) % l.length].P[0];
      gap = Math.max(gap, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    ok(
      gap <= 1e-6 * mag,
      `the ${lab} side closes at every joint (widest ${gap.toExponential(2)}, bar ${(1e-6 * mag).toExponential(2)})`,
    );
  }

console.log(fail ? `\ncpatchCurveCutCloseSmoke FAIL (${fail})` : '\ncpatchCurveCutCloseSmoke PASS');
process.exit(fail ? 1 : 0);
