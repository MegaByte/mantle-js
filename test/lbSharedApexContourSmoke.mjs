// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbSharedApexContourSmoke.mjs — subpaths that share a vertex stay SEPARATE
// contours when a bundle's curve range is decoded back to geometry.
//
// The decoder starts a new contour where a segment does not continue from the
// pen. That test alone cannot see the break between two CLOSED subpaths that
// touch: the first ends exactly where the second begins. A fan of wedges around
// a shared apex is the pure case — every subpath both starts and ends at the
// apex — and merging them makes a contour the LB partition builder gives ZERO
// interior triangles, so the shape renders BLANK (2 wedges fine, 3+ blank).
//
// The structure is simply not recoverable from geometry, so the parser's authored
// marker is carried into BIT 3 of the segment header and the decoder reads it.
// Asserted here on hand-built buffers so it needs no GPU.
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { SEG_LINE } from '../src/primitives/seg.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// One LINE record: header(4) + data(4) + join(4), the layout the decoder walks.
// Header .x = type | is_fill_only<<2 | subStart<<3.
const SUB_START = 8;
const lineRec = (sx, sy, ex, ey, sub = false) => [
  SEG_LINE + (sub ? SUB_START : 0),
  0,
  0,
  0,
  sx,
  sy,
  ex,
  ey,
  0,
  0,
  0,
  0,
];
const buf = (recs) => new Float32Array(recs.flat());

// N triangles around a shared apex at the origin, each closed apex→a→b→apex.
function fan(n, apex = [0, 0], r = 100) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * 2 * Math.PI,
      t1 = ((i + 0.6) / n) * 2 * Math.PI;
    const a = [apex[0] + r * Math.cos(t0), apex[1] + r * Math.sin(t0)];
    const b = [apex[0] + r * Math.cos(t1), apex[1] + r * Math.sin(t1)];
    recs.push(lineRec(apex[0], apex[1], a[0], a[1], true)); // marked: opens a subpath
    recs.push(lineRec(a[0], a[1], b[0], b[1]));
    recs.push(lineRec(b[0], b[1], apex[0], apex[1]));
  }
  return buf(recs);
}

for (const n of [1, 2, 3, 4, 8, 16]) {
  const f = fan(n);
  const cs = curveRangeToContours(f, 0, f.length);
  const got = cs ? cs.length : 0;
  ok(got === n, `${n} wedges sharing an apex → ${n} contours (got ${got})`);
  if (cs)
    ok(
      cs.every((c) => c.length === 3),
      `  each of the ${n} contours keeps its 3 segments`,
    );
}

// Control: disjoint squares are separated by a pen JUMP, the case that always
// worked. It must keep working — the new rule adds splits, it must not merge.
{
  const recs = [];
  for (let i = 0; i < 3; i++) {
    const x = i * 500,
      y = 0,
      s = 100;
    recs.push(
      lineRec(x, y, x + s, y),
      lineRec(x + s, y, x + s, y + s),
      lineRec(x + s, y + s, x, y + s),
      lineRec(x, y + s, x, y),
    );
  }
  const f = buf(recs);
  const cs = curveRangeToContours(f, 0, f.length);
  ok(
    cs && cs.length === 3,
    `3 disjoint squares split on the pen JUMP with no marker (got ${cs ? cs.length : 0})`,
  );
}

// Control: an OPEN polyline is one contour — it never returns to its start, so
// the closure rule must not fire and split it.
{
  const f = buf([lineRec(0, 0, 10, 0), lineRec(10, 0, 20, 5), lineRec(20, 5, 30, 20)]);
  const cs = curveRangeToContours(f, 0, f.length);
  ok(cs && cs.length === 1 && cs[0].length === 3, 'an open polyline stays ONE contour');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
