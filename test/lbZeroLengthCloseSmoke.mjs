// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbZeroLengthCloseSmoke -- a zero-length closing line is not the neighbor of a corner.
//
// Importers close every subpath with a line back onto its start point; when the path already ends there that line
// has length zero and tangent (0, 0). Taken by edgeEndMeta (lbContour.js) for the neighbor of the contour's first and
// last real edges, it would type the corner at the start vertex collinear (type 0) with no shared plane, and the edge
// strip would cover a pixel box holding only that corner with the whole half-plane of its own edge instead of the
// two-plane intersection (a prepared Loop-Blinn morph of a rotating <image> frame over-covers by up to 6/255).
//
// This asserts, for a square closed with and without the zero-length line, in both orientations and at 2^-20, 1 and
// 2^20: every corner's end metadata (type, neighbor normal, tangent sign, shared plane) is identical, and the start
// corner is convex (type +1 along the interior side), never collinear.
import { mkLine } from '../src/primitives/seg.js';
import { segTangents, edgeEndMeta } from '../src/geom/lbContour.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const square = (scale, flip, zeroClose) => {
  const P = [
    [0, 0],
    [16, 0],
    [16, 16],
    [0, 16],
  ].map(([x, y]) => [x * scale, (flip ? -y : y) * scale + 8.219 * scale]);
  const segs = P.map((p, i) => mkLine(p, P[(i + 1) % 4]));
  if (zeroClose) segs.push(mkLine(P[0], P[0]));
  return segs;
};
const metas = (segs, sign) => {
  const tg = segs.map(segTangents);
  const out = [];
  for (let si = 0; si < 4; si++)
    out.push([edgeEndMeta(segs, tg, si, 0, sign), edgeEndMeta(segs, tg, si, 1, sign)]);
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const scale of [2 ** -20, 1, 2 ** 20])
  for (const flip of [false, true])
    for (const sign of [1, -1]) {
      const plain = metas(square(scale, flip, false), sign),
        closed = metas(square(scale, flip, true), sign);
      const tag = `scale ${scale} flip ${flip} interior ${sign}`;
      check(
        same(plain, closed),
        `${tag}: end metadata matches the contour without the zero-length close`,
      );
      const first = closed[0][0],
        last = closed[3][1];
      check(
        first.type !== 0 && last.type !== 0,
        `${tag}: the start corner is typed (${first.type}, ${last.type}), not collinear`,
      );
      check(
        !!first.cw && !!last.cw && same(first.cc, last.cc),
        `${tag}: both strips share one corner plane`,
      );
    }
console.log(fail ? `LB-ZERO-LENGTH-CLOSE FAIL (${fail})` : 'LB-ZERO-LENGTH-CLOSE PASS');
process.exit(fail ? 1 : 0);
