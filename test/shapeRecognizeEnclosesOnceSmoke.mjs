// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shapeRecognizeEnclosesOnceSmoke: a contour is a disc only if it goes round once.
//
// Testing only that every sample of a contour lies on a circle or an ellipse and that it spans the diameter is not enough: a semicircle
// drawn there and back passes, and encloses nothing; a circle drawn twice passes, and is empty under even-odd. Either would be handed
// the disc primitive, which paints the whole disc. Every engine reads this answer.
import { circleFromContours, ellipseFromContours } from '../src/geom/shapeRecognize.js';
import { mkCubic as C, mkLine as L } from '../src/svg/segment.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const k = 0.5522847498 * 10;
const fwd = [C([10, 0], [10, k], [k, 10], [0, 10]), C([0, 10], [-k, 10], [-10, k], [-10, 0])];
const back = [C([-10, 0], [-10, k], [-k, 10], [0, 10]), C([0, 10], [k, 10], [10, k], [10, 0])];
const rest = [
  C([-10, 0], [-10, -k], [-k, -10], [0, -10]),
  C([0, -10], [k, -10], [10, -k], [10, 0]),
];
const full = [...fwd, ...rest];
const wide = (list, sx) =>
  list.map((s) => C(...[s.p1, s.p2, s.p3, s.p4].map((p) => [p[0] * sx, p[1]])));

for (const scale of [1, 2 ** -20, 2 ** 20]) {
  const at = (list) =>
    list.map((s) => C(...[s.p1, s.p2, s.p3, s.p4].map((p) => [p[0] * scale, p[1] * scale])));
  ok(!!circleFromContours([at(full)]), `scale ${scale}: a circle is a circle`);
  ok(
    !circleFromContours([at([...fwd, ...back])]),
    `scale ${scale}: a semicircle there and back is not`,
  );
  ok(!circleFromContours([at([...full, ...full])]), `scale ${scale}: a circle drawn twice is not`);
  ok(!!ellipseFromContours([at(wide(full, 2))]), `scale ${scale}: an ellipse is an ellipse`);
  ok(
    !ellipseFromContours([at(wide([...full, ...full], 2))]),
    `scale ${scale}: an ellipse drawn twice is not`,
  );
}
// A closing stub does not move the answer, and a contour reversed is still once round.
{
  const stub = [...full, L([10, 0], [10, 0])];
  ok(!!circleFromContours([stub]), 'a circle with an empty closing line');
  const rev = full
    .slice()
    .reverse()
    .map((s) => C(s.p4, s.p3, s.p2, s.p1));
  ok(!!circleFromContours([rev]), 'a circle the other way round');
}

if (fail) {
  console.log(`shapeRecognizeEnclosesOnceSmoke: FAIL (${fail})`);
  process.exit(1);
}
console.log('shapeRecognizeEnclosesOnceSmoke: PASS');
process.exit(0);
