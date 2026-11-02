// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullScaleInvariantSmoke — the occlusion cull decides the same at every size.
//
// computeOccludedShapes (and computeMorphOccludedShapes) drop a shape a later opaque shape covers. Their slack -- how
// far a shape's bbox may pass the occluder's, how close a side must be to count as flush, and how far each boundary
// sample is nudged to both sides -- is occluderEps: 1e-4 of the extent, floored at the float32 resolution of the
// coordinates (4 * 2^-23 of the largest), both of which scale with the drawing. An absolute floor breaks: with
// max(1e-5, 1e-4 of the occluder's extent), under scale(2^-20) an occluder 100 units across is 9.5e-5 across, so the
// slack is a tenth of the occluder, and a shape passing its edge by 4% of its size clears the bbox gate, its inward
// nudge lands back inside the occluder, the interior grid falls short of the sliver, and the shape is culled, its
// visible sliver missing.
//
// Assertions, each fixture at 1, 2^-20, 2^-10, 2^10 and 2^20, with and without a translate(16384 S) origin, in both
// modes:
//   1. a shape passing the occluder's edge by 4% of its size (a rect, a vertex bump, a quad bump) is NOT culled;
//   2. a shape flush with the occluder's corner IS culled, and one clear inside it by the full and morph culls (so (1)
//      is not a cull that never culls);
//   3. the morph cull, with the same geometry at both poses, agrees (it calls isContained with occluderEps at each
//      pose; its no-crossing certificate already refuses every protruding fixture, so (1) cannot fail through it);
//   4. occluderEps of the scaled bbox is exactly S times occluderEps of the bbox, from 2^-40 to 2^40;
//   5. the float32 floor: at the 16384 origin, an occluder 10 across whose flush edge comes back one float32 ulp
//      short of the shape's is still an occluder (1e-4 of its extent is half that ulp).
// With max(1e-5, 1e-4 of the extent) put back inside occluderEps, (1) fails for all three fixtures at 2^-20, with and
// without the origin, in both modes; (4) fails from 2^-10 down; (5) fails (slack 0.001, not culled).
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { computeOccludedShapes, occluderEps } = await import('../src/renderer/occlusionCull.js');
const { computeMorphOccludedShapes } = await import('../src/renderer/morphCull.js');

// Import-time culling must retain screen-space strokes at every camera scale.
for (const nss of [false, true]) {
  const sec = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 140 140"><path d="M35 35 L65 35 L65 65 L35 65 Z" fill="none" stroke="blue" stroke-width="6" ${nss ? 'vector-effect="non-scaling-stroke"' : ''}/><rect x="10" y="10" width="80" height="80" fill="red"/></svg>`,
    { preserveViewport: true },
  );
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const culled = computeOccludedShapes(
    new Float32Array(sec.curves),
    sec.curveRangesByShape,
    m.metaFloats,
    m.numShapes,
    m.floatsPerShape,
  );
  if (culled.has(0) === nss) throw new Error(`non-scaling stroke culling: ${nss}`);
}

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const _warn = console.warn;
console.warn = () => {};

const OFF = 16384;
async function rows(body, S, off, vb = [-10, -10, 140, 140], importOpts = {}) {
  const T = off ? OFF * S : 0;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[vb[0] * S + T, vb[1] * S + T, vb[2] * S, vb[3] * S].join(' ')}">` +
    `<g transform="${off ? `translate(${T} ${T}) ` : ''}scale(${S})">${body}</g></svg>`;
  const sec = await importSvg(svg, { preserveViewport: true, ...importOpts });
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return {
    cv: new Float32Array(sec.curves),
    MF: m.metaFloats,
    ST: m.floatsPerShape,
    n: m.numShapes,
    ranges: sec.curveRangesByShape.map((r) => ({ begin: r.begin | 0, end: r.end | 0 })),
  };
}
const culledBy = (R, mode) => computeOccludedShapes(R.cv, R.ranges, R.MF, R.n, R.ST, mode);
const morphCulledBy = (R) =>
  computeMorphOccludedShapes(R.cv, R.cv, R.ranges, R.MF, R.MF, R.n, R.ST);

// Row 0 is the red shape, row 1 the black occluder [0, 100]^2.
const J = '<path fill="#000" d="M0 0 H100 V100 H0 Z"/>';
const PROTRUDING = {
  'a rect 4 past the edge': `<path fill="#f00" d="M0 10 H104 V40 H0 Z"/>${J}`,
  'a vertex bump 4 past the edge': `<path fill="#f00" d="M0 10 H99 L103 25 L99 40 H0 Z"/>${J}`,
  'a quad bump 3.5 past the edge': `<path fill="#f00" d="M0 10 H99 Q106 25 99 40 H0 Z"/>${J}`,
};
const FLUSH = `<path fill="#f00" d="M0 0 H50 V50 H0 Z"/>${J}`;
// The morph cull also certifies that the boundaries never cross, which a flush edge does not pass: its hidden shape
// keeps clear of the occluder's boundary.
const INSIDE = `<path fill="#f00" d="M20 20 H60 V60 H20 Z"/>${J}`;
const SCALES = [0, -20, -10, 10, 20];

console.log(
  "a shape past the occluder's edge survives at every size; a flush one is culled at every size",
);
for (const [name, body] of Object.entries(PROTRUDING)) {
  const wrong = [];
  for (const off of [false, true])
    for (const e of SCALES) {
      const R = await rows(body, 2 ** e, off);
      for (const mode of ['coincident', 'full'])
        if (culledBy(R, mode).has(0)) wrong.push(`${mode} 2^${e}${off ? '+origin' : ''}`);
      if (morphCulledBy(R).has(0)) wrong.push(`morph 2^${e}${off ? '+origin' : ''}`);
    }
  check(
    wrong.length === 0,
    `${name} is never culled${wrong.length ? ' -- culled at ' + wrong.join(', ') : ''}`,
  );
}
{
  const missed = [];
  for (const off of [false, true])
    for (const e of SCALES) {
      const R = await rows(FLUSH, 2 ** e, off),
        Q = await rows(INSIDE, 2 ** e, off);
      for (const mode of ['coincident', 'full'])
        if (!culledBy(R, mode).has(0)) missed.push(`flush ${mode} 2^${e}${off ? '+origin' : ''}`);
      if (!culledBy(Q, 'full').has(0)) missed.push(`inside full 2^${e}${off ? '+origin' : ''}`);
      if (!morphCulledBy(Q).has(0)) missed.push(`inside morph 2^${e}${off ? '+origin' : ''}`);
    }
  check(
    missed.length === 0,
    `a shape flush with the occluder's corner is culled in both modes, and one inside it by the full and morph culls, at every size${missed.length ? ' -- missed at ' + missed.join(', ') : ''}`,
  );
}

console.log('occluderEps scales with the drawing');
{
  const bad = [];
  for (const [x0, y0, x1, y1] of [
    [0, 0, 100, 100],
    [3, -7, 5, 1e-3],
    [-250, 40, -249.5, 90],
    [0, 0, 1e-6, 2e-6],
  ]) {
    const base = occluderEps(x0, y0, x1, y1);
    for (const off of [0, OFF])
      for (const e of [-40, -20, -10, 10, 20, 40]) {
        const S = 2 ** e,
          T = off * S;
        const baseOff = occluderEps(x0 + off, y0 + off, x1 + off, y1 + off);
        const got = occluderEps(x0 * S + T, y0 * S + T, x1 * S + T, y1 * S + T);
        const want = (off ? baseOff : base) * S;
        if (Math.abs(got - want) > 1e-12 * want)
          bad.push(`[${x0},${y0},${x1},${y1}] 2^${e}${off ? '+origin' : ''}: ${got} vs ${want}`);
      }
  }
  check(
    bad.length === 0,
    `occluderEps(S bbox + T) = S occluderEps(bbox + 16384) for S = 2^-40 .. 2^40${bad.length ? ' -- ' + bad.slice(0, 3).join('; ') : ''}`,
  );
}

console.log('the float32 floor');
{
  // At the 16384 origin a float32 ulp is 2^-9 = 0.00195. The shape's right edge, authored 0.0015 past the occluder's,
  // is stored one ulp past it; 1e-4 of the occluder's extent is 0.001, under that ulp, so a bbox gate at 1e-4 alone would
  // refuse an occluder whose edge is flush at the resolution the curve plane has.
  const body = `<path fill="#f00" d="M0 0 H10.0015 V5 H0 Z"/><path fill="#000" d="M0 0 H10 V10 H0 Z"/>`;
  const R = await rows(body, 1, true, [-1, -1, 12, 12], { origin: false }); // (a bundle origin removes the float32 floor this checks: absolute coordinates on purpose)
  const b = (i, k) => R.MF[i * R.ST + k];
  const ulps = (b(0, 2) - b(1, 2)) / 2 ** -9;
  check(
    ulps === 1,
    `the shape's right edge is stored one float32 ulp past the occluder's (${ulps})`,
  );
  check(
    occluderEps(b(1, 0), b(1, 1), b(1, 2), b(1, 3)) >= 4 * 2 ** -9,
    `the slack is at least 4 ulps of the coordinates (${occluderEps(b(1, 0), b(1, 1), b(1, 2), b(1, 3))})`,
  );
  check(
    culledBy(R, 'coincident').has(0) && culledBy(R, 'full').has(0),
    'and the shape is culled in both modes',
  );
}

for (const style of ['opacity=".35"', 'style="mix-blend-mode:plus-lighter"', 'opacity="1"']) {
  const body =
    '<rect width="100" height="100" fill="red" opacity=".6"/><g ' +
    style +
    '><rect width="100" height="100" fill="blue"/><rect width="100" height="100" fill="white"/></g>';
  const R = await rows(body, 1, false);
  for (const mode of ['coincident', 'full']) {
    const culled = culledBy(R, mode);
    if (style === 'opacity="1"') {
      check(
        R.n === 3 && culled.has(0) && culled.has(1),
        'neutral group keeps flat culling: ' + mode,
      );
    } else {
      check(!culled.has(0), 'group boundary keeps its backdrop: ' + style + ' ' + mode);
      check(culled.has(2), 'opaque siblings still cull inside one group: ' + style + ' ' + mode);
    }
  }
  check(!morphCulledBy(R).has(0), 'morph cull respects the group boundary: ' + style);
}

console.warn = _warn;

// Morph containment of a centerline cannot certify the surrounding stroke band.
for (const width of [6, 80]) {
  const sec = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-64 -64 228 228"><path d="M35 35 L65 35 L65 65 L35 65 Z" fill="none" stroke="blue" stroke-width="${width}"/><rect x="10" y="10" width="80" height="80" fill="red"/></svg>`,
    { preserveViewport: true },
  );
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
    cv = new Float32Array(sec.curves);
  if (
    computeMorphOccludedShapes(
      cv,
      cv,
      sec.curveRangesByShape,
      m.metaFloats,
      m.metaFloats,
      m.numShapes,
      m.floatsPerShape,
    ).has(0)
  )
    throw new Error('morph stroke band culled by centerline');
}

console.log(failures ? `\nOCCLUSION-CULL-SCALE FAIL (${failures})` : '\nOCCLUSION-CULL-SCALE PASS');
process.exit(failures ? 1 : 0);
