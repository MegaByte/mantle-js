// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanThinLobeSmoke: a face keeps its fill-rule answer when it is small, when a curve folds back on itself along a straight run,
// when a ray meets a curve at a triple root or an arc at its last angle, and when pieces of the arrangement share a level.
const { parsePathD } = await import('../src/svg/path.js');
const { unionContours } = await import('../src/svg/pathBoolean/union.js');
const { intersectSegmentsExact } = await import('../src/svg/pathBoolean/intersect/exact.js');
const { intersectSegments } = await import('../src/svg/pathBoolean/intersect/index.js');
const { pointInShape } = await import('../src/svg/pathBoolean/planar/fillRule.js');
const { mkLine, mkArc, mkCubic } = await import('../src/svg/segment.js');
const { resolveSelfOverlap } = await import('../src/renderer/shapeResolve.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const union = (d, rule) =>
  unionContours([{ segs: parsePathD(d), fillRule: rule }], { intersect: intersectSegmentsExact });
const covers = (out, p) => pointInShape(p, out.flat(), 'nonzero');

// (a) a lobe where a shape's first and last curves cross a hair from their shared vertex (0.01 by 0.04 in a shape 65 across)
const lobe =
  'M330.9 222.7C330.8 221.5 320.4 228.5 310 236.8C307.4 242.4 296.2 247.7 287.7 247.4C291.3 244.6 290.4 232.2 285.9 222.7C284.5 222 286.3 211.3 289.6 201.5C299.1 200.6 311.7 200.2 314.7 200.6C321.3 204 329.3 215 330.9 222.7Z';
const resolve = (d, rule) => {
  const r = resolveSelfOverlap([parsePathD(d)], rule);
  return r || [];
};
for (const rule of ['nonzero', 'evenodd'])
  ok(
    covers(resolve(lobe, rule), [330.8965, 222.68]),
    `(a) the lobe at a shared vertex stays filled, ${rule}`,
  );
for (const k of [1 / 1024, 1024]) {
  const d = lobe.replace(/[0-9.]+/g, (v) => String(+v * k));
  ok(covers(resolve(d, 'nonzero'), [330.8965 * k, 222.68 * k]), `(a) and at scale ${k}`);
}

// (b) a quad that runs along a level and folds back: the region under the crossing curve keeps its winding
const fold =
  'M70 40Q10 40 60 40Q30 30 30 60Q30 40 50 60L50 80Q50 60 80 90Q50 90 40 50C40 70 70 20 90 90L70 40Z';
ok(
  !covers(union(fold, 'nonzero'), [47, 39.16]) ===
    !pointInShape([47, 39.16], parsePathD(fold), 'nonzero'),
  '(b) a folded level quad: the face above the fold matches the path',
);
const foldS = 'M80 20Q40 60 60 40Q40 20 80 90C80 60 60 80 60 50Q80 70 40 80L80 20Z';
ok(
  covers(union(foldS, 'evenodd'), [62.44, 45.35]) ===
    pointInShape([62.44, 45.35], parsePathD(foldS), 'evenodd'),
  '(b) a folded slanted quad: the same',
);

// (c) a ray level with a curve that leaves it flat: one crossing, not two
{
  const f = 1 / 64,
    s = (p) => [p[0] * f, p[1] * f];
  const closed = [
    mkCubic(s([80, 80]), s([50, 80]), s([20, 80]), s([30, 20])),
    mkLine(s([30, 20]), s([80, 10])),
    mkLine(s([80, 10]), s([80, 80])),
  ];
  ok(
    !pointInShape(s([60, 80]), closed, 'evenodd'),
    '(c) a point level with the flat start of a cubic, outside',
  );
}

// (d) a line through the last angle of an arc
{
  let misses = 0;
  for (let i = 0; i < 2000; i++) {
    const a = mkArc(25, 27, 32 + (i % 7), 46, -2.87 + i * 1e-3, -2.71 + i * 1e-3, 0, 0, 1),
      p = a.p4;
    const H = intersectSegments(mkLine([p[0] - 200, p[1] - 90], [p[0] + 137, p[1] + 61.65]), a);
    if (!H.some((h) => Math.hypot(h.x - p[0], h.y - p[1]) < 1e-6)) misses++;
  }
  ok(misses === 0, `(d) a line through an arc's last angle is a hit (${misses} of 2000 missed)`);
}

// (e) three circles around one center, each two half arcs, their seams on one level: the gap between the ring and the dot is empty
{
  const d =
    'M97.442 71.169A46.195 46.195 0 1 0 5.052 71.169A46.195 46.195 0 1 0 97.442 71.169ZM73.62 71.169A22.373 22.373 0 1 0 28.874 71.169A22.373 22.373 0 1 0 73.62 71.169ZM64.737 71.169A13.49 13.49 0 1 0 37.757 71.169A13.49 13.49 0 1 0 64.737 71.169Z';
  const out = union(d, 'evenodd');
  ok(!covers(out, [51.247 + 15, 65]), '(e) the gap stays empty');
  ok(covers(out, [51.247 + 30, 60]), '(e) the ring stays filled');
  ok(covers(out, [51.247 + 5, 70]), '(e) the dot stays filled');
}
console.log(fail ? `FAIL (${fail})` : 'PASS');
process.exit(fail ? 1 : 0);
