// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillNormalizeBandsSmoke -- A nonzero path with a contour wholly inside another of the same orientation (a face and its slab)
// is counted twice by the winding integrators, so the BANDS are built from the list without it (svg/fillNormalize.js). Everything
// else keeps the authored contours. Pinned here:
//   * the fill row's curve range, and so the morph, the hit test and the other builders, still holds both contours;
//   * the bands refer to fewer records (the contained contour is not in them) and the authored band region is kept;
//   * a stroke on the path still strokes both outlines;
//   * a morph between two such poses pairs by index and its mid pose equals the one built from authored bands;
//   * the winding hit test is unchanged; content with no contained contour imports byte-identically (normalizeFill false vs true).
import path from 'path';
import { fileURLToPath } from 'url';
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createShapeMorph } = await import('../src/animation/shapeMorph.js');
const { createBundle } = await import('../src/renderer/bundle.js');
const { META_GLYPH_LOC_X, META_GLYPH_LOC_Y } = await import('../src/bundle/layout.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const face = (dx = 0) =>
  `M${10 + dx} 10 L90 10 L90 60 L${10 + dx} 60 Z M${10 + dx} 10 L90 10 L90 30 L${10 + dx} 30 Z`; // the second contour sits inside the first, sharing three edges
const svg = (d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#c00" ${extra} d="${d}"/></svg>`;
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const A = await importSvg(svg(face(0))),
  N = await importSvg(svg(face(0)), { normalizeFill: false });
ok(
  A.authoredBandsByShape && A.authoredBandsByShape.some(Boolean),
  'the contained contour is detected (authored band region recorded)',
);
ok(!N.authoredBandsByShape, 'normalizeFill:false imports the authored bands only');
const rg = (s) => s.curveRangesByShape[0],
  len = (s) => rg(s).end - rg(s).begin;
ok(
  len(A) === len(N),
  `the fill row's curve range holds both contours as authored (${len(A)} floats, same as unnormalized)`,
);
ok(
  same(
    new Float32Array(A.curves).slice(rg(A).begin, rg(A).end),
    new Float32Array(N.curves).slice(rg(N).begin, rg(N).end),
  ),
  'the authored curve records are byte-identical to the unnormalized import',
);
ok(
  A.bands.byteLength !== N.bands.byteLength,
  'the drawn bands differ (they list the kept contour only)',
);
// a stroke strokes both outlines: the stroke row is built from the authored segments
const S = await importSvg(svg(face(0), 'stroke="#000" stroke-width="2"')),
  SN = await importSvg(svg(face(0), 'stroke="#000" stroke-width="2"'), { normalizeFill: false });
const strokeLen = (s) => {
  let t = 0;
  for (let i = 0; i < s.shapeIds.length; i++)
    if (/_stroke$/.test(s.shapeIds[i]))
      t += s.curveRangesByShape[i].end - s.curveRangesByShape[i].begin;
  return t;
};
ok(
  strokeLen(S) > 0 && strokeLen(S) === strokeLen(SN),
  `the stroke row still carries both outlines (${strokeLen(S)} floats, same as unnormalized)`,
);
// hit testing reads the bands: the union is unchanged
const { gl } = createFakeGl();
const bA = createBundle(gl, A),
  bN = createBundle(gl, N);
let hitDiff = 0;
for (let y = 0; y <= 100; y += 5)
  for (let x = 0; x <= 100; x += 5)
    if (
      fillHitShape(bA, x, y, HitMode.Coverage) >= 0 !==
      fillHitShape(bN, x, y, HitMode.Coverage) >= 0
    )
      hitDiff++;
ok(hitDiff === 0, 'hit testing agrees with the unnormalized bundle on a 21x21 grid');
// a morph pairs by index and its mid pose is the unnormalized pipeline's
const B = await importSvg(svg(face(20))),
  BN = await importSvg(svg(face(20)), { normalizeFill: false });
const mA = createShapeMorph(gl, createBundle(gl, A), createBundle(gl, B)),
  mN = createShapeMorph(gl, createBundle(gl, N), createBundle(gl, BN));
const msA = mA._morphSrc || mA.bundle._morphSrc,
  msN = mN._morphSrc || mN.bundle._morphSrc;
ok(
  msA &&
    msN &&
    msA.matchedAll === msN.matchedAll &&
    msA.curveRanges.length === msN.curveRanges.length,
  'the morph matches the shape exactly as the unnormalized pipeline does',
);
// the pose curves of the matched shapes only (the plane also carries each build's own trailing records)
const mid = (ms) => {
  const out = [];
  for (const r of ms.curveRanges) {
    if (!r) continue;
    for (let j = r.begin; j < r.end; j++)
      out.push(ms.mergedCurveF32[j] * 0.5 + ms.dstCurveF32[j] * 0.5);
  }
  return new Float32Array(out);
};
ok(same(mid(msA), mid(msN)), "the mid pose curves equal the unnormalized pipeline's");
// the morph rebuilds each matched shape's bands as one region (the meta row points at it) that lists every authored segment: the
// bytes the row points at are the unnormalized pipeline's. Texels are 4 floats; the 4096-wide plane is addressed (x, y) -> y * 4096 + x.
// The plane is PACKED (regions abut; no row of padding follows a region), so the region is read at its exact length: 4 header texels
// plus one H and one V entry per segment (the header's four counts sum to the segment count). A fixed window would read into the
// next record, which is a different build's own data.
const region = (b) => {
  const m = b.metaFloats,
    f = b.bandFloats,
    at = (m[META_GLYPH_LOC_Y] * 4096 + m[META_GLYPH_LOC_X]) * 4,
    n = f[at] + f[at + 1] + f[at + 2] + f[at + 3];
  return { at, data: f.slice(at, at + 4 * (4 + 2 * n)) };
};
const rA = region(mA.bundle),
  rN = region(mN.bundle);
ok(
  rA.data.some((v) => v !== 0) && same(rA.data, rN.data),
  "the morph bundle's rebuilt band region equals the unnormalized pipeline's (it was built from the authored bands)",
);
// no contained contour: identical import
const P = svg('M10 10 L40 10 L40 40 L10 40 Z M60 60 L90 60 L90 90 L60 90 Z'),
  p1 = await importSvg(P),
  p2 = await importSvg(P, { normalizeFill: false });
ok(
  same(new Uint8Array(p1.bands), new Uint8Array(p2.bands)) &&
    same(new Uint8Array(p1.curves), new Uint8Array(p2.curves)) &&
    same(new Uint8Array(p1.meta), new Uint8Array(p2.meta)),
  'two disjoint squares import byte-identically with and without the normalization',
);
// Polynomial boundaries: same-winding nested loops disappear; even-odd
// holes reverse, while authored records and morph bands remain unchanged.
const outer =
  'M28 16C28 22.6 22.6 28 16 28C9.4 28 4 22.6 4 16C4 9.4 9.4 4 16 4C22.6 4 28 9.4 28 16Z';
const inner =
  'M20 16C20 18.2 18.2 20 16 20C13.8 20 12 18.2 12 16C12 13.8 13.8 12 16 12C18.2 12 20 13.8 20 16Z';
for (const rule of ['nonzero', 'evenodd']) {
  const source = svg(outer + ' ' + inner, `fill-rule="${rule}" stroke="#000" stroke-width=".1"`);
  const a = await importSvg(source),
    n = await importSvg(source, { normalizeFill: false });
  ok(a.authoredBandsByShape?.some(Boolean), `${rule} polynomial nesting normalizes coverage`);
  ok(
    same(
      new Float32Array(a.curves).slice(rg(a).begin, rg(a).end),
      new Float32Array(n.curves).slice(rg(n).begin, rg(n).end),
    ),
    `${rule} polynomial authored curves remain byte-identical`,
  );
  ok(strokeLen(a) === strokeLen(n), `${rule} polynomial stroke retains both outlines`);
  const ma = createShapeMorph(gl, createBundle(gl, a), createBundle(gl, a)),
    mn = createShapeMorph(gl, createBundle(gl, n), createBundle(gl, n));
  ok(
    same(region(ma.bundle).data, region(mn.bundle).data),
    `${rule} polynomial morph restores authored bands`,
  );
}
const { normalizedFillSegs, closedContours } = await import('../src/svg/fillNormalize.js');
const { mkLine } = await import('../src/primitives/seg.js');
const square = (x, y, size, reverse = false) => {
  let points = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
  if (reverse) points.reverse();
  const result = points.map((p, i) => mkLine(p, points[(i + 1) % 4]));
  result.push(mkLine(points[0], points[0], true));
  return result;
};
const triple = [...square(0, 0, 12), ...square(2, 2, 8, true), ...square(4, 4, 4, true)];
const before = JSON.stringify(triple),
  norm = normalizedFillSegs(triple, false);
ok(
  norm && closedContours(norm).length === 3,
  'three nested opposite-winding contours retain the inner island',
);
ok(
  JSON.stringify(triple) === before,
  'normalization never mutates authored segments or closing markers',
);
const disjoint = [...square(0, 0, 1), ...square(2, 0, 1, true)];
ok(
  normalizedFillSegs(disjoint, false) !== null,
  'opposite disjoint boundaries normalize their area signs',
);
ok(
  normalizedFillSegs([...square(0, 0, 4), ...square(2, 2, 4)], true) === null,
  'crossing boundaries decline',
);
ok(
  normalizedFillSegs([...square(0, 0, 4), ...square(4, 0, 4)], true) === null,
  'touching boundaries decline',
);
ok(
  normalizedFillSegs(
    [...square(0, 0, 4), { type: 3, p1: [1, 1], p4: [1, 1], is_fill_only: true }],
    true,
  ) === null,
  'native arcs decline',
);
ok(
  normalizedFillSegs([...square(0, 0, 1, true), ...square(2, 0, 1, true)], false) === null,
  'global reversal avoids duplicate coverage bands',
);
// A dropped contour can be the only native cubic or quadratic. The retained
// authored curve plane needs that kernel when morph bands are restored.
for (const command of ['C21.666666666666668 30 18.333333333333332 27 15 24', 'Q20 28.5 15 24']) {
  const source = svg('M0 0H30V40H0Z M5 5L15 14L25 33' + command + 'L5 5Z');
  const a = await importSvg(source),
    n = await importSvg(source, { normalizeFill: false });
  ok(a.authoredBandsByShape?.some(Boolean), 'mixed-degree redundant contour normalizes coverage');
  ok(a.segTypeMask === n.segTypeMask, 'coverage normalization retains authored curve-type flags');
  const ma = createShapeMorph(gl, createBundle(gl, a), createBundle(gl, a)),
    mn = createShapeMorph(gl, createBundle(gl, n), createBundle(gl, n));
  ok(
    ma.bundle.segTypeMask === mn.bundle.segTypeMask,
    'morph restored bands retain the authored kernel set',
  );
}
if (fail) {
  console.error(`FAIL fillNormalizeBandsSmoke: ${fail}`);
  process.exit(1);
}
console.log('fillNormalizeBandsSmoke PASS');
