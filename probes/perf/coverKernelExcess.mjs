// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/coverKernelExcess.mjs — what the Slug/AAC cover kernel is asked to shade that the
// artwork does not cover, and which of four performance claims about it a count can settle.
//
// GL-FREE. The cover-quad geometry is in the imported bundle (`sections.curveGeom`), the ink
// area is exact from the contours, and their ratio is OVERDRAW: the number of fragments the
// kernel runs per fragment of ink. That is the whole of "exterior fragments shade the dilated
// bbox" and "cover-quad dilation unaudited", measured rather than asserted.
//
//   node probes/perf/coverKernelExcess.mjs
//   VERBOSE=1 node probes/perf/coverKernelExcess.mjs
//   COVER_FAN=1 node probes/perf/coverKernelExcess.mjs      (the same survey with importSvg({ coverFan: true }))
//
// ── THE CLAIMS ──────────────────────────────────────────────────────────────────────────────
//
// A. "global x bounds in band entries". FALSE AS WRITTEN. A band entry is one
//    4-float texel `(loc, breakAxis, farAxis, _)` and both bounds are PER SEGMENT: `breakAxis`
//    is the segment's bound on the walk axis (the hoisted `hBreak`/`vBreak` test in
//    _coverage.glsl) and `farAxis` its minimum on that axis, which lets a walk skip a segment
//    wholly past the pixel without fetching its header or control texels. What
//    is NOT bounded is the PERPENDICULAR axis: a segment far from the pixel across the band is
//    still walked. That is the real version of this claim and GPU C prices it.
//
// B. "per-fragment constants". LARGELY DONE ALREADY, and worth saying so, because re-doing it is
//    the expensive mistake: the walker hoists its break thresholds out of the per-segment tests
//    (`hBreak = c.x * px.x - 0.5`, algebraically exact, one subtract saved per segment in the
//    innermost loop). The per-fragment constants that REMAIN
//    are in the blur kernel, not here — see probes/perf/strokesMasksSpritesApi.mjs, which
//    counts up to 32 exp() per fragment, every one a function of one uniform.
//
// C. "exterior fragments shade the dilated bbox". MEASURED HERE, as overdraw. Every fragment of
//    the cover quad that is not ink runs the full band walk and returns ~0.
//
// D. "cover-quad dilation unaudited". AUDITED HERE: the distribution below IS the audit, and it
//    separates the two causes — the OBB's slack against a non-convex shape (large, geometric)
//    from the padEm dilation (small, and it is what makes the AA ramp reachable at all).
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { parseCoverQuadChunks, buildGidToShapeIdx, COVER_QUAD_STRIDE } = await import(
  path.join(JS, 'src/renderer/coverQuadChunks.js')
);
const { curveRangeToContours } = await import(path.join(JS, 'src/geom/lbContour.js'));
const { contourAreaExact } = await import(path.join(JS, 'src/renderer/lbBuildCore.js'));

const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;
const VERBOSE = !!process.env.VERBOSE;

/// Area a chunk's vertices cover, as a TRIANGLE LIST (the cover quad is emitted as triangles,
/// so a shoelace over the raw run would be meaningless). Non-overlapping by construction.
function chunkArea(f32, start, count) {
  let a = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const o0 = (start + t) * COVER_QUAD_STRIDE;
    const o1 = (start + t + 1) * COVER_QUAD_STRIDE;
    const o2 = (start + t + 2) * COVER_QUAD_STRIDE;
    const ax = f32[o0],
      ay = f32[o0 + 1];
    const bx = f32[o1],
      by = f32[o1 + 1];
    const cx = f32[o2],
      cy = f32[o2 + 1];
    a += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
  }
  return a;
}

const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
const files = [];
for (const d of dirs) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  } catch {}
}
files.sort();
const only = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;

const ratios = []; // per shape: cover area / ink area
let coverTot = 0,
  inkTot = 0,
  shapes = 0,
  assets = 0;
const worstAssets = [];

for (const f of only) {
  let sec, pm;
  try {
    // COVER_FAN=1: import with the cover fan (svg/mesh.js getCoverFanVerts) instead of the box
    sec = await importSvg(readFileSync(f, 'utf8'), {
      preserveViewport: true,
      coverFan: !!process.env.COVER_FAN,
    });
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  } catch {
    continue;
  }
  const cg = sec.curveGeom ? new Float32Array(sec.curveGeom) : null;
  if (!cg || !cg.length) continue;
  const chunks = parseCoverQuadChunks(cg, BUNDLE_FLAG_HYBRID_MESH_CHUNKED);
  if (!chunks.length) continue;
  // buildGidToShapeIdx returns a Map, not an array — indexing it reads undefined for every gid
  // and the whole survey comes back empty, which is exactly the kind of silent zero a probe
  // must not report as a finding.
  const gidToShape = buildGidToShapeIdx(pm.metaFloats, sec.numShapes, pm.floatsPerShape);
  const shapeOf = (gid) =>
    gidToShape && typeof gidToShape.get === 'function'
      ? gidToShape.get(gid)
      : gidToShape
        ? gidToShape[gid]
        : undefined;
  const curves = new Float32Array(sec.curves);
  let aCover = 0,
    aInk = 0,
    aShapes = 0;
  for (const ch of chunks) {
    const s = shapeOf(ch.gid);
    if (s == null || s < 0 || s >= (sec.numShapes | 0)) continue;
    // FILL ROWS only. A stroke row's cover quad is deliberately padded past the path (half the
    // stroke width plus miter), and its "ink" is the stroke band, not the enclosed area — the
    // ratio would be meaningless and would drown the number this is about.
    if (!(pm.metaFloats[s * pm.floatsPerShape + 7] > 0)) continue;
    let ink = 0;
    try {
      const r = sec.curveRangesByShape[s];
      ink = Math.abs(contourAreaExact(curveRangeToContours(curves, r.begin, r.end)) || 0);
    } catch {
      ink = 0;
    }
    if (!(ink > 0)) continue;
    const cov = chunkArea(cg, ch.start, ch.count);
    if (!(cov > 0)) continue;
    ratios.push(cov / ink);
    aCover += cov;
    aInk += ink;
    aShapes++;
  }
  if (!aShapes) continue;
  assets++;
  shapes += aShapes;
  coverTot += aCover;
  inkTot += aInk;
  worstAssets.push([path.basename(f), aCover / aInk, aShapes]);
  if (VERBOSE) {
    console.log(
      `  ${path.basename(f).padEnd(30)} shapes ${String(aShapes).padStart(4)}` +
        `  cover/ink ${(aCover / aInk).toFixed(2)}x`,
    );
  }
}

ratios.sort((a, b) => a - b);
const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
console.log(`\n== C/D: cover-quad OVERDRAW over ${assets} assets / ${shapes} fill shapes ==`);
console.log(`  corpus total cover area / ink area : ${(coverTot / inkTot).toFixed(2)}x`);
console.log(
  '  per shape:  p10 ' +
    q(0.1).toFixed(2) +
    '  p25 ' +
    q(0.25).toFixed(2) +
    '  median ' +
    q(0.5).toFixed(2) +
    '  p75 ' +
    q(0.75).toFixed(2) +
    '  p90 ' +
    q(0.9).toFixed(2) +
    '  p99 ' +
    q(0.99).toFixed(2) +
    '  max ' +
    ratios[ratios.length - 1].toFixed(2),
);
let over2 = 0,
  over4 = 0,
  over10 = 0;
for (const r of ratios) {
  if (r > 2) over2++;
  if (r > 4) over4++;
  if (r > 10) over10++;
}
console.log(
  `  shapes whose cover quad is > 2x their ink: ${over2} (${((100 * over2) / ratios.length).toFixed(1)}%)` +
    `,  > 4x: ${over4} (${((100 * over4) / ratios.length).toFixed(1)}%)` +
    `,  > 10x: ${over10} (${((100 * over10) / ratios.length).toFixed(1)}%)`,
);
worstAssets.sort((a, b) => b[1] - a[1]);
console.log('  worst assets by whole-asset ratio:');
for (const [n, r, k] of worstAssets.slice(0, 8)) {
  console.log(`    ${n.padEnd(30)} ${r.toFixed(2)}x  (${k} fill shapes)`);
}
console.log('  EVERY ONE OF THOSE EXTRA FRAGMENTS RUNS THE FULL BAND WALK and returns ~0. The');
console.log("  overdraw has two causes and they need different answers: the OBB's slack against");
console.log('  a non-convex shape (geometric, large, and what a tighter cover primitive would');
console.log('  address) and the padEm dilation (small, and it is what makes the AA ramp');
console.log('  reachable at all, so it is not slack).');
console.log('  Compare: the CPatch cover fans measure 1.06x overdraw on tiger, so this is the');
console.log('  number that says whether a tighter fill cover is worth building.');

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A  What the band walk costs on an EXTERIOR fragment.
  The overdraw above is a fragment COUNT. What it is worth depends on what those fragments do,
  and the kernel's own switches answer it without new code:
    arm A: default.
    arm B: __MANTLE_FILL_DEFINES='MANTLE_COV_STUB' (under __MANTLE_DEBUG__=true) — replaces the fill's coverage with a
           constant while every other per-fragment stage still runs. Renders WRONG on purpose;
           read the timer, and CHECK debugStats.engines.draws is unchanged.
    arm C: __MANTLE_FILL_DEFINES='MANTLE_WALK_CAP=1' — caps the walk to one segment per type,
           so B - C separates "walking many segments" from "running the walk at all".
  asset:  the worst assets listed above, plus tiger, at 512 and 2048, REPEAT>=8.
  PREDICTION: (A - B) is the whole fill kernel's share; (A - C) is the marginal per-segment
  part. If (A - C) is small and (A - B) large, the cost is per-FRAGMENT rather than
  per-segment, and the lever is the cover quad's area, not the band layout — which is the
  question everything here turns on and which the counts above cannot settle.
  fill in: A/A ____ %  |  B/A ____ x  |  C/A ____ x  |  verdict ____

GPU B  Would a tighter cover primitive pay?
  Do NOT build one first. Price the ceiling with a scissor, which costs nothing to try: draw
  each shape with the scissor set to its own axis-aligned device bbox. That removes only the
  part of the OBB slack outside the AABB, so it is a LOWER bound on a tighter cover's win, and
  it is output-identical (the fragments removed are outside the shape's own bbox and paint
  nothing).
  fill in: A/A ____ %  |  worst asset ____ x  |  tiger ____ x
  decide: if the lower bound is inside the A/A floor, the OBB is not the problem and claims
  C and D are settled. If it is not, the next step is a per-shape cover FAN, and the number to
  beat is CPatch's 1.06x on the same asset.

GPU C  The perpendicular-axis bound (the real version of claim A).
  A band entry bounds its segment on the WALK axis only, so a segment far across the band is
  still fetched and solved. Adding a perpendicular bound costs one float per entry (the band
  buffer is already 66% of bundle bytes, so this is a +25% band-buffer change, not free).
  measure FIRST, with no format change: instrument nothing, and instead run arm C above with
  MANTLE_WALK_CAP at 1, 2, 4, 8, 16 on the assets with the highest segments-per-band. The
  curve's knee says how many segments a typical fragment actually solves; if it is already
  1-2, a perpendicular bound cannot buy anything and the format change is refused on that
  number alone.
  fill in: cap 1 ____ x  2 ____ x  4 ____ x  8 ____ x  16 ____ x  |  knee at ____
`);
