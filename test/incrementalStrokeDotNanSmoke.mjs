// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeDotNanSmoke: two gaps between what an incremental stroke draws and what it says it drew, and what it accepts.
//
// 1. A stroke of one point draws a dot. Its pathD must draw it too: a bare moveto draws nothing, so finalize() or svgSource re-hosted (importSvg,
//    frame export) would lose it.
// 2. appendPoints drops a point with a non-finite coordinate, and so does appendSegments: the next segment starts where this one ends, so
//    one accepted NaN would carry into every later segment's texels and into pathD.
// CPU, on a stand-in GL and the real importer.
const { M, imp, mkRenderer } = await import('./_exportHarness.mjs');
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
const { R, gl } = await mkRenderer(100, 100);
const mk = (o = {}) =>
  R.createIncrementalStroke({ width: 4, bbox: [0, 0, 100, 100], color: [1, 0, 0, 1], ...o });

const dot = mk();
dot.appendPoints([[10, 10]]);
check('the premise: one point is one segment', dot.segmentCount === 1, dot.segmentCount);
const rehost = M.createBundle(gl, await imp(dot.finalize().svg));
check(
  'the dot survives a re-host',
  rehost.numShapes === 1 && rehost.drawList.length === 1,
  `${rehost.numShapes} rows, ${rehost.drawList.length} draws`,
);
const box = Array.from(rehost.metaFloats.subarray(0, 4));
check(
  'the re-hosted dot is the width of the stroke, at the point',
  Math.abs(box[0] - 8) < 1e-3 &&
    Math.abs(box[2] - 12) < 1e-3 &&
    Math.abs(box[1] - 8) < 1e-3 &&
    Math.abs(box[3] - 12) < 1e-3,
  box,
);
const line = mk();
line.appendPoints([
  [10, 10],
  [20, 10],
]);
check('a line is unchanged', line.pathD === 'M10 10L20 10', line.pathD);
check('an empty stroke has an empty path', mk().pathD === '');

const cases = {
  'a line to NaN': { type: 'line', to: [NaN, 2] },
  'a line to Infinity': { type: 'line', to: [3, Infinity] },
  'a line with no end': { type: 'line' },
  'a quad with a NaN control': { type: 'quad', c1: [NaN, 0], to: [4, 4] },
  'a cubic with a NaN second control': { type: 'cubic', c1: [1, 1], c2: [2, NaN], to: [4, 4] },
  'an arc with a NaN radius': { type: 'arc', center: [0, 0], radii: [NaN, 1], theta: [0, 1] },
  'an arc with a NaN angle': { type: 'arc', center: [0, 0], radii: [1, 1], theta: [0, NaN] },
};
for (const [name, bad] of Object.entries(cases)) {
  const s = mk();
  let threw = null;
  try {
    s.appendSegments([
      { type: 'line', to: [1, 1] },
      { type: 'line', to: [2, 1] },
      bad,
      { type: 'line', to: [5, 5] },
    ]);
  } catch (e) {
    threw = e;
  }
  check(
    `${name} is dropped, and the stroke goes on`,
    !threw && s.pathD === 'M1 1L2 1L5 5',
    threw ? threw.message : s.pathD,
  );
}
const good = mk();
good.appendSegments([
  { type: 'line', to: [1, 1] },
  { type: 'quad', c1: [2, 2], to: [3, 1] },
  { type: 'cubic', c1: [4, 0], c2: [5, 2], to: [6, 1] },
  { type: 'arc', center: [6, 5], radii: [4, 4], theta: [-Math.PI / 2, 0] },
]);
check(
  'good segments of every type stay',
  good.segmentCount === 3 && /Q/.test(good.pathD) && /C/.test(good.pathD) && /A/.test(good.pathD),
  `${good.segmentCount} ${good.pathD}`,
);
console.warn = warn;
if (fails) {
  console.log(`incrementalStrokeDotNanSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('incrementalStrokeDotNanSmoke PASS');
process.exit(0);
