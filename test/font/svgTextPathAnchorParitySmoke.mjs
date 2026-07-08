// svgTextPathAnchorParitySmoke.mjs — verifies glyph spacing along a
// path matches the SVG spec by using PenX + Advance/2 as the path
// anchor (not bbox-center, which drifts on glyphs with asymmetric
// bearings).
//
// Strategy: lay out a string of mixed-bearing characters on a
// straight horizontal line, then verify the SPACING between
// adjacent glyphs equals their pen-advance — not their bbox-center
// distance. With bbox-center anchoring, an italic-style or
// overhang-heavy glyph would land closer/farther from its neighbour
// than its advance dictates.

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const META = 32;
const f32 = (b) => new Float32Array(b.meta, META, b.numShapes * b.metaFloatsPerShape);
const xC = (b, mf, i) => (mf[i * b.metaFloatsPerShape] + mf[i * b.metaFloatsPerShape + 2]) / 2;

// T1: a string with characters that have notable bearing asymmetry
// ('f' is the classic example — heavy bar overhang past the advance).
// On a STRAIGHT path, the spacing between adjacent glyph bbox-CENTERS
// must equal the spacing between their pen positions (since the path
// is the identity transform for a horizontal line). Reference: lay
// out the same string off-path with anchor=start, measure the bbox
// centers, then compare with the textPath placement at startOffset=0.
{
  const text = 'fjAfjAf';
  const svgFlat = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
  <text x="50" y="100" font-family="Arial" font-size="48" fill="black" text-anchor="start">${text}</text>
</svg>`;
  const svgPath = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
  <defs><path id="line" d="M 50 100 L 750 100"/></defs>
  <text font-family="Arial" font-size="48" fill="black">
    <textPath href="#line">${text}</textPath>
  </text>
</svg>`;
  const bFlat = await importSvg(svgFlat, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const bPath = await importSvg(svgPath, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (bFlat.numShapes !== text.length || bPath.numShapes !== text.length) {
    fail(`shape count: flat=${bFlat.numShapes} path=${bPath.numShapes} (expected ${text.length})`);
  } else {
    const mfFlat = f32(bFlat);
    const mfPath = f32(bPath);
    // Glyph-i bbox-center on the path MINUS glyph-0 bbox-center on
    // the path should equal the same delta on the flat layout.
    // (Both layouts start at x=50; path tangent is +x; identity warp.)
    let maxDelta = 0;
    for (let i = 0; i < text.length; i++) {
      const dFlat = xC(bFlat, mfFlat, i) - xC(bFlat, mfFlat, 0);
      const dPath = xC(bPath, mfPath, i) - xC(bPath, mfPath, 0);
      const diff = Math.abs(dFlat - dPath);
      if (diff > maxDelta) maxDelta = diff;
    }
    // On a HORIZONTAL line the math is self-consistent so maxDelta is
    // 0 regardless of anchor choice. The divergence shows up on CURVED
    // paths — see T2.
    if (maxDelta > 0.1) fail(`T1 line: max bbox-center divergence ${maxDelta.toFixed(3)}px (expected 0 on straight line)`);
    else ok(`T1 straight path: bbox centers match flat layout (max Δ=${maxDelta.toFixed(3)}px)`);
  }
}

// T2: REAL divergence test. On a CURVED path with characters that
// have asymmetric bearings, bbox-center anchoring would place
// adjacent glyphs at distances proportional to their bbox-center
// spacing, while spec (pen-midpoint) anchoring places them at
// pen-advance spacing. Verify the chord-length between consecutive
// glyph centers along a circular arc matches the expected
// arc-length step (one advance per glyph).
//
// Path: a quarter-circle of radius 200 centered at (400, 400),
// going from (200, 400) up to (400, 200) — 90°, arc length =
// π/2 · 200 ≈ 314.16.
{
  const text = 'fjfjfjfj';
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
  <defs><path id="arc" d="M 200 400 A 200 200 0 0 1 400 200"/></defs>
  <text font-family="Arial" font-size="32" fill="black">
    <textPath href="#arc">${text}</textPath>
  </text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== text.length) {
    fail(`T2 expected ${text.length} shapes, got ${b.numShapes}`);
  } else {
    const mf = f32(b);
    // Compute the Euclidean (chord) distance between consecutive
    // glyph bbox-centers. On an arc of constant curvature, with the
    // SPEC anchor (penX + advance/2), each chord equals
    //   2 · r · sin(advance / (2·r))
    // For r=200 and Arial 'f','j' at 32px (advances ~17 and ~9
    // respectively), the per-glyph chord oscillates between two
    // values matching the actual font advances — but the *sum*
    // over a pair (f+j) should match the pair-advance sum exactly.
    let chords = [];
    for (let i = 1; i < text.length; i++) {
      const dx = xC(b, mf, i) - xC(b, mf, i - 1);
      const yi   = (mf[i*b.metaFloatsPerShape+1] + mf[i*b.metaFloatsPerShape+3]) / 2;
      const ypi  = (mf[(i-1)*b.metaFloatsPerShape+1] + mf[(i-1)*b.metaFloatsPerShape+3]) / 2;
      const dy = yi - ypi;
      chords.push(Math.hypot(dx, dy));
    }
    // The chord lengths form a regular alternating pattern: each
    // chord length depends on the corresponding advance pair. With
    // pen-midpoint anchoring the chords stay smooth; bbox-center
    // anchoring would distort them by 'f' bbox-asymmetry (bunched/
    // spread pairs).
    //
    // Sanity: every chord > 0 (no overlapping glyphs) and < 30
    // (advance-bound).
    let okT2 = true;
    for (let i = 0; i < chords.length; i++) {
      if (chords[i] < 4 || chords[i] > 30) {
        fail(`T2 chord ${i} = ${chords[i].toFixed(3)} out of range [4,30]`);
        okT2 = false;
      }
    }
    // The pair-sum invariant: chord[0] + chord[1] should match
    // chord[2] + chord[3] etc., because each pair is one f+j
    // advance pair regardless of position along the arc (modulo
    // small curvature effects). With bbox-center anchoring this would
    // be visibly off because bbox-asymmetry drift accumulates.
    if (okT2) {
      const pairs = [chords[0]+chords[1], chords[2]+chords[3], chords[4]+chords[5]];
      const range = Math.max(...pairs) - Math.min(...pairs);
      if (range > 0.5) fail(`T2 fj-pair sums diverge: ${pairs.map(p=>p.toFixed(2)).join(', ')} (range ${range.toFixed(2)})`);
      else ok(`T2 curved-path pair sums consistent: ${pairs.map(p=>p.toFixed(2)).join(', ')} (range ${range.toFixed(3)})`);
    }
  }
}

// T3: direct test of the spec — synthetic layout where bbox-center
// is DELIBERATELY offset from advance-midpoint, placed on a CURVED
// path so the anchor choice actually moves the glyph along the
// curve. (On a straight path the cx term cancels: sample at s=cx
// produces sample.x = cx, so the glyph ends up at the same xy
// regardless of which cx we picked. Curvature breaks that symmetry.)
//
// Layout: pen at 0, advance 50, bbox shifted to [30, 40].
//   • Spec anchor (penX + adv/2): cx = 25, sample at s=25
//   • Bbox-center: cx = 35, sample at s=35
// Path: quarter-circle radius 100 centered at (0, 0), from
// (100, 0) sweeping CCW to (0, -100) — at s=25 we're at angle
// θ = 25/100 rad ≈ 0.25 rad, point = (100 cos(.25), -100 sin(.25))
//                                  ≈ (96.89, -24.74).
// At s=35: angle 0.35 rad, point ≈ (93.93, -34.29). Tangent
// directions also differ. The transformed glyph's xmin will
// distinguish: spec anchor gives one value, bbox-center another.
{
  const segLine = (x0, y0, x1, y1) =>
    ({ type: 0, p1: [x0, y0], p2: [x1, y1] });
  const asymLayout = (text, font, x, y, fontSize) => {
    if (!text || !text.trim()) return { glyphs: [], advance: 0 };
    const segs = [
      segLine(x + 30, y - 10, x + 40, y - 10),
      segLine(x + 40, y - 10, x + 40, y),
      segLine(x + 40, y, x + 30, y),
      segLine(x + 30, y, x + 30, y - 10),
    ];
    return {
      glyphs: [{ segs, codepoint: 0x41, penX: 0, advance: 50 }],
      advance: 50,
    };
  };
  // Quarter-circle r=100 starting at (100, 0). A= flag pattern for
  // SVG arc: rx=ry=100, large-arc=0, sweep=1, end at (0, -100).
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><defs><path id="arc" d="M 100 0 A 100 100 0 0 1 0 -100"/></defs><text font-family="X" font-size="40" fill="black"><textPath href="#arc" startOffset="0">A</textPath></text></svg>`;
  const b = await importSvg(svg, { fonts: { X: arial }, svgTextLayout: asymLayout });
  if (b.numShapes !== 1) {
    fail(`T3 expected 1 shape, got ${b.numShapes}`);
  } else {
    const mf = f32(b);
    const xCnow = (mf[0] + mf[2]) / 2, yCnow = (mf[1] + mf[3]) / 2;
    // Compare two analytical samples on the same curve:
    //   • spec   = sample at s = penX + advance/2 = 25
    //   • bbox-c = sample at s = bbox-center      = 35
    // Sample the path LIVE from the importer's helpers? Easier to
    // re-derive by importing the same SVG twice and comparing one
    // result to a reference. But the test is precisely measuring
    // "spec vs bbox-center" — and the only way to get the
    // bbox-center sample is to run the old code. Instead: sample
    // the importer's behavior at TWO different penX values (0 and
    // 10) and confirm the difference matches a *pure pen shift*
    // rather than a *bbox-shift induced sample change*.
    //
    // With spec anchor (penX + adv/2):
    //   penX=0  → cx=25 → glyph center at sample(25) + (rotated bbox offset)
    //   penX=10 → cx=35 → glyph center at sample(35) + (rotated bbox offset)
    // The two centers differ by sample(35) − sample(25) (≈ tangent
    // direction × arc-length 10).
    // With bbox-center anchor (always cx=35 regardless of penX):
    //   penX=0  → cx=35 → identical to penX=10 case (sample(35)).
    //   penX=10 → cx=35 → identical → SAME result either way.
    // ⇒ spec anchor: glyph SHIFTS as penX changes; bbox anchor: it
    // stays put. Compare two layouts.
    // Two glyphs at the SAME pen position (penX=0) but with
    // DIFFERENT bbox extents. Glyph-A bbox spans [30, 40] (offset
    // 35 from pen); glyph-B bbox spans [60, 70] (offset 65). Real
    // fonts can't overlap pens, but the synthetic test isolates
    // the anchor logic.
    //   Spec anchor: cx_A = cx_B = penX + advance/2 = 0 + 25 = 25.
    //     Both glyphs sampled at SAME path point s=25. Distance
    //     between bbox centers = (65-35) = 30 (rotated by tangent
    //     direction), straight line in flat → chord ≈30 on curve.
    //   Bbox-center anchor: cx_A = 35, cx_B = 65. Different
    //     samples; arc-length difference 30 along an r=100 arc
    //     produces chord ≈29.55 — close to 30 but with very
    //     different y components. KEY DIVERGENCE: under bbox-
    //     center the glyph centers sit ON the path (at sample(35)
    //     and sample(65)), so the connecting line stays close to
    //     the path's chord. Under SPEC, only the pen-midpoint is
    //     on the path; the glyph centers are displaced outward by
    //     the bbox-vs-pen offset (5 and 35 respectively) along
    //     the tangent direction — so the two glyphs end up
    //     COLINEAR with the tangent at s=25, NOT along the arc's
    //     chord.
    // Discriminator: under SPEC, both glyph centers lie on the
    // tangent line at s=25 (same direction, different offsets).
    // Under BBOX-CENTER they lie close to the arc itself.
    const dualLayout = (text, font, x, y, fontSize) => {
      if (!text || !text.trim()) return { glyphs: [], advance: 0 };
      const mk = (offset) => [
        segLine(x + offset,      y - 10, x + offset + 10, y - 10),
        segLine(x + offset + 10, y - 10, x + offset + 10, y),
        segLine(x + offset + 10, y,      x + offset,      y),
        segLine(x + offset,      y,      x + offset,      y - 10),
      ];
      return {
        glyphs: [
          { segs: mk(30), codepoint: 0x41, penX: 0, advance: 50 },
          { segs: mk(60), codepoint: 0x42, penX: 0, advance: 50 },
        ],
        advance: 50,
      };
    };
    const b2 = await importSvg(svg, { fonts: { X: arial }, svgTextLayout: dualLayout });
    if (b2.numShapes !== 2) { fail(`T3 dual shape count ${b2.numShapes}`); }
    else {
      const md = f32(b2);
      const ox = b2.metaFloatsPerShape;
      const xA = (md[0] + md[2]) / 2,    yA = (md[1] + md[3]) / 2;
      const xB = (md[ox] + md[ox+2])/2,  yB = (md[ox+1] + md[ox+3])/2;
      // Spec: both glyphs share the same path-anchor s=25, so
      //   xB-xA = 30·ax, yB-yA = 30·ay (pure tangent vector × 30).
      //   Magnitude of (xB-xA, yB-yA) = 30 EXACTLY (no curve
      //   compression).
      // Bbox-center: glyphs sample at different s → centers track
      //   the curve → distance is the curve's chord ≈29.55, plus
      //   the centers are NOT collinear with the s=25 tangent.
      const dist = Math.hypot(xB - xA, yB - yA);
      // Spec expectation: dist = 30 exactly.
      // Bbox-center: dist = 2·r·sin(15/r) = 2·100·sin(0.15) ≈ 29.888.
      if (Math.abs(dist - 30) > 0.05)
        fail(`T3 distance=${dist.toFixed(4)} (spec: 30 exact; bbox-center: ≈29.89)`);
      else
        ok(`T3 spec anchor: same-pen glyphs land collinear, dist=${dist.toFixed(4)} (bbox-center anchor would give ≈29.89)`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'SVG-TEXTPATH-ANCHOR PASS' : `SVG-TEXTPATH-ANCHOR FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
