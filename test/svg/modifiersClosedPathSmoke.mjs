// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// modifiersClosedPathSmoke: the path modifiers on a closed path keep it one closed path, at any size.
//
// (a) trimPath: the whole length under an offset draws the whole path.
// (b) roundCorners: the closing corner is rounded too, with no gap beside it, and each corner's limit reads the edge, not what the
//     corner before it left of the edge.
// (c) polystar: the fillets of a regular polygon are the same at every corner.
// (d) repeater: the copies of a full-turn arc are not empty.
// (e) offsetPath: no gap at a corner, and a curve's facet count does not follow the art's size.
import { trimPath, roundCorners, polystar, repeater, offsetPath } from '../../src/svg/modifiers.js';
import { mkLine, mkArc, mkCubic, segStart, segEnd } from '../../src/svg/segment.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const rect = (x, y, w, h) => [
  mkLine([x, y], [x + w, y]),
  mkLine([x + w, y], [x + w, y + h]),
  mkLine([x + w, y + h], [x, y + h]),
  mkLine([x, y + h], [x, y]),
];
const closed = (segs) =>
  segs.every((s, i) => {
    const e = segEnd(s),
      n = segStart(segs[(i + 1) % segs.length]);
    return Math.hypot(e[0] - n[0], e[1] - n[1]) < 1e-9;
  });
const chord = (s) => Math.hypot(segEnd(s)[0] - segStart(s)[0], segEnd(s)[1] - segStart(s)[1]);
const span = (list) => Math.max(...list) - Math.min(...list);

// (a)
for (const off of [0.25, 0.5, 0.75, 0.1, -0.25]) {
  const out = trimPath(rect(0, 0, 10, 10), 0, 1, off);
  const len = out.reduce((a, s) => a + chord(s), 0);
  ok(Math.abs(len - 40) < 1e-9, `trimPath(0, 1, ${off}) keeps the whole length: ${len}`);
}
{
  const out = trimPath(rect(0, 0, 10, 10), 0, 1, 0.25);
  ok(
    out.length > 0 && segStart(out[0])[0] === 10 && segStart(out[0])[1] === 0,
    `and starts at the offset: ${out.length ? segStart(out[0]) : 'nothing'}`,
  );
}

// (b)
{
  const out = roundCorners(rect(0, 0, 10, 10), 2);
  ok(closed(out), 'roundCorners keeps a closed path closed');
  ok(
    segStart(out[0])[0] === 2 && segStart(out[0])[1] === 0,
    `the closing corner is rounded: first point ${segStart(out[0])}`,
  );
  const big = roundCorners(rect(0, 0, 10, 10), 100)
    .filter((s) => s.type === 1)
    .map(chord);
  ok(
    big.length === 4 && span(big) < 1e-9,
    `a radius past the limit gives four equal fillets: ${big.map((v) => v.toFixed(3))}`,
  );
}

// (c)
{
  const pentagon = polystar(0, 0, 5, 10, 0, 0.5, 0, -90, false);
  const f = pentagon.filter((s) => s.type === 1).map(chord);
  ok(
    f.length === 5 && span(f) < 1e-9,
    `a regular polygon's fillets are equal: ${f.map((v) => v.toFixed(3))}`,
  );
  ok(closed(pentagon), 'and it is closed');
  const star = polystar(0, 0, 4, 10, 5, 0.3, 0.6, -90, true)
    .filter((s) => s.type === 1)
    .map(chord);
  const outer = star.filter((_, i) => i % 2 === 0),
    inner = star.filter((_, i) => i % 2 === 1);
  ok(
    span(outer) < 1e-9 && span(inner) < 1e-9,
    `a star's outer and inner fillets are each equal: ${star.map((v) => v.toFixed(3))}`,
  );
}

// (d)
{
  const circle = mkArc(50, 50, 10, 10, 0, 2 * Math.PI, 0, 1, 1, [60, 50], [60, 50]);
  const out = repeater([circle], 2, 100, 0);
  const copy = out.slice(1);
  ok(
    copy.length >= 2 && copy.every((s) => s.type === 2),
    `the copy of a circle is curves: ${copy.map((s) => s.type)}`,
  );
  let x0 = Infinity,
    x1 = -Infinity;
  for (const s of copy)
    for (const q of [s.p1, s.p2, s.p3, s.p4]) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
    }
  ok(Math.abs(x0 - 140) < 1e-6 && Math.abs(x1 - 160) < 1e-6, `at the copy's place: x ${x0}..${x1}`);
}

// (e)
{
  const out = offsetPath(rect(0, 0, 10, 10), 2);
  ok(closed(out), 'offsetPath keeps a closed path closed');
  const open = offsetPath([mkLine([0, 0], [10, 0]), mkLine([10, 0], [10, 10])], 2);
  ok(open.length === 3 && !closed(open), 'an open path has its corner joined and stays open');
  const sub = offsetPath([mkLine([0, 0], [10, 0]), mkLine([50, 0], [60, 0])], 2);
  ok(sub.length === 2, 'two subpaths stay two');
  const q = (k) => [mkCubic([k, 0], [k, 0.55 * k], [0.55 * k, k], [0, k])];
  const n = [1e-3, 1, 100, 1e5].map((k) => offsetPath(q(k), 0.1 * k).length);
  ok(span(n) === 0, `a curve gets the same facets at any size: ${n}`);
  ok(offsetPath(q(1), 0.1, { minStep: 0.5 }).length === 4, 'an explicit minStep still rules');
}

if (fail) {
  console.log(`modifiersClosedPathSmoke: FAIL (${fail})`);
  process.exit(1);
}
console.log('modifiersClosedPathSmoke: PASS');
process.exit(0);
