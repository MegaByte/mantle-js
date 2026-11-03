// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverageHitSmoke.mjs — Coverage / Outline / Auto hit testing against
// real curve geometry from importSvg (no GL needed; sections carries
// curves + curveRangesByShape + meta).
//
// Key cases:
//   T1 triangle: a point in the bbox CORNER (outside the fill) → Bbox
//      hits, Coverage misses.
//   T2 stroke-only ring: a point ON the band hits Outline/Auto/Coverage; the
//      HOLLOW CENTER misses all three (no fill is drawn: Coverage is the
//      rendered coverage, which tests a stroke row's band, not a fill it
//      does not have).

import importSvg from '../../src/svg/importer.js';
import { fillHitShape, HitMode } from '../../src/hitTest/hitTest.js';
import { DOMParser } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);
const hitAt = (b, x, y, mode) => fillHitShape(b, x, y, { mode }) >= 0;

// ---- T1: right triangle (0,0)(100,0)(0,100), filled ----
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<polygon points="0,0 100,0 0,100" fill="black"/></svg>',
  );
  // (10,10) is inside the triangle; (90,90) is in the bbox but outside.
  if (!hitAt(b, 10, 10, HitMode.Coverage)) fail('T1 Coverage should hit inside-triangle (10,10)');
  else if (hitAt(b, 90, 90, HitMode.Coverage))
    fail('T1 Coverage should MISS bbox-corner (90,90) outside triangle');
  else if (!hitAt(b, 90, 90, HitMode.Bbox)) fail('T1 Bbox should still hit the corner (90,90)');
  else if (!hitAt(b, 10, 10, HitMode.Auto)) fail('T1 Auto should hit inside (filled)');
  else if (hitAt(b, 90, 90, HitMode.Auto)) fail('T1 Auto should MISS bbox-corner');
  else ok('T1 triangle: Coverage/Auto reject bbox corner, Bbox accepts it');
}

// ---- T2: stroke-only ring (fill=none), r=40, stroke-width=10 ----
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="40" fill="none" stroke="black" stroke-width="10"/></svg>',
  );
  // Band spans radius 35..45 from center. (50,90) is on it; (50,50) is the hollow center.
  if (!hitAt(b, 50, 90, HitMode.Outline)) fail('T2 Outline should hit the band (50,90)');
  else if (hitAt(b, 50, 50, HitMode.Outline)) fail('T2 Outline should MISS hollow center (50,50)');
  else if (!hitAt(b, 50, 90, HitMode.Auto)) fail('T2 Auto should hit the band');
  else if (hitAt(b, 50, 50, HitMode.Auto))
    fail('T2 Auto should MISS hollow center (fill=none → stroke only)');
  else if (hitAt(b, 50, 50, HitMode.Coverage))
    fail('T2 Coverage (rendered) should MISS the hollow center: no fill is drawn there');
  else if (!hitAt(b, 50, 90, HitMode.Coverage))
    fail('T2 Coverage should hit the drawn stroke band');
  else ok('T2 stroke-only ring: Outline/Auto/Coverage hit the band and miss the hollow');
}

// ---- T3: filled circle — Auto hits center (has fill); fully outside bbox misses ----
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="30" fill="black"/></svg>',
  );
  if (!hitAt(b, 50, 50, HitMode.Auto)) fail('T3 Auto should hit filled circle center');
  else if (hitAt(b, 5, 5, HitMode.Auto)) fail('T3 Auto should miss far corner (5,5)');
  else if (hitAt(b, 22, 22, HitMode.Coverage))
    fail('T3 Coverage should miss bbox-corner-ish (22,22) outside r=30 circle');
  else ok('T3 filled circle: Auto/Coverage inside-only');
}

// ---- T4: rotated elliptical stroke (analytic ellipse closest-point) ----
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<ellipse cx="50" cy="50" rx="35" ry="20" fill="none" stroke="black" stroke-width="8" transform="rotate(25 50 50)"/></svg>',
  );
  // Center is far inside the hole → Outline/Auto miss. The major-axis end
  // of the (rotated) ellipse path is on the band → hit.
  const exX = 50 + 35 * Math.cos((25 * Math.PI) / 180),
    exY = 50 + 35 * Math.sin((25 * Math.PI) / 180);
  if (hitAt(b, 50, 50, HitMode.Outline)) fail('T4 ellipse Outline should MISS center (hole)');
  else if (!hitAt(b, Math.round(exX), Math.round(exY), HitMode.Outline))
    fail('T4 ellipse Outline should hit the major-axis band');
  else if (hitAt(b, 50, 50, HitMode.Auto)) fail('T4 ellipse Auto should MISS center (fill=none)');
  else ok('T4 rotated ellipse: stroke band hit on the path, miss in the hole');
}

// ---- T5: quadratic-Bézier filled arch (analytic quad winding) ----
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<path d="M10 80 Q 50 5 90 80 Z" fill="black"/></svg>',
  );
  // Under the arch (near the baseline) is inside; above the Q apex is outside
  // but inside the bbox — a flattened chord would misjudge points near the curve.
  if (!hitAt(b, 50, 70, HitMode.Coverage)) fail('T5 quad fill should hit under the arch (50,70)');
  else if (hitAt(b, 50, 20, HitMode.Coverage))
    fail('T5 quad fill should MISS above the apex (50,20)');
  else if (hitAt(b, 15, 20, HitMode.Coverage)) fail('T5 quad fill should MISS bbox corner (15,20)');
  else ok('T5 quad-Bézier fill: inside under the arch, outside above the apex');
}

// ---- T6: line caps — butt clips at the end, round/square extend ----
{
  const line = (cap) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    `<line x1="20" y1="50" x2="80" y2="50" stroke="black" stroke-width="10" stroke-linecap="${cap}"/></svg>`;
  const probe = async (cap) => {
    const b = await importSvg(line(cap));
    return (x, y) => hitAt(b, x, y, HitMode.Outline);
  };
  const butt = await probe('butt'),
    round = await probe('round'),
    square = await probe('square');
  // halfW=5; end at x=80. 3px beyond (83,50): butt miss; round/square hit. far (88,50): all miss.
  if (butt(83, 50)) fail('T6 butt should clip 3px beyond the end (83,50)');
  else if (!round(83, 50)) fail('T6 round cap should reach 3px beyond (83,50)');
  else if (!square(83, 50)) fail('T6 square cap should reach 3px beyond (83,50)');
  else if (round(88, 50) || square(88, 50)) fail('T6 caps should miss 8px beyond (88,50)');
  else if (!butt(79, 53)) fail('T6 butt should still hit just inside the end (79,53)');
  else ok('T6 caps: butt clips at the end, round/square extend by halfW');
}

// ---- T7: joins — miter spike vs bevel/round + miterlimit fallback ----
{
  const peak = (join, ml) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    `<path d="M44 85 L50 25 L56 85" fill="none" stroke="black" stroke-width="10" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
  const probe = async (j, ml) => {
    const b = await importSvg(peak(j, ml));
    return (x, y) => hitAt(b, x, y, HitMode.Outline);
  };
  const miter = await probe('miter', 20),
    bevel = await probe('bevel', 20),
    round = await probe('round', 20),
    lim = await probe('miter', 2);
  // peak (50,25), halfW=5, an 11-degree apex. SVG 2: the miter spike reaches far above; the round
  // join is the SECTOR of radius halfW (to y=20); the bevel is the triangle (P, P1, P2), whose chord
  // sits only 0.5 above so sharp an apex; and a miter past its limit IS that bevel. (A bevel does
  // not hit (50,22): a full-disc fallback would, where the renderer never paints it.)
  if (!miter(50, 8)) fail('T7 miter spike should hit well above the peak (50,8)');
  else if (bevel(50, 8) || round(50, 8))
    fail('T7 bevel and round should NOT reach the spike (50,8)');
  else if (!miter(50, 22) || !round(50, 22))
    fail('T7 miter and round should hit just past the apex (50,22)');
  else if (bevel(50, 22))
    fail('T7 bevel should NOT hit (50,22): its chord is 0.5 past so sharp an apex');
  else if (lim(50, 8) || lim(50, 22))
    fail('T7 miterlimit=2 is a bevel: no spike (50,8), no round shoulder (50,22)');
  else
    ok(
      'T7 joins: miter spike hits, round stops at its sector, bevel at its chord, miterlimit falls back to bevel',
    );
}

// ---- T7b: miter-clip — clips the spike at miterLimit·halfW (does NOT bevel) --
// Same apex path. halfW=5; the natural miter tip is ~50 above the peak (25,25).
// With miterlimit=2 the clip is at maxTip = halfW·2 = 10 (bisector distance):
// the spike is RETAINED up to y=15 (25−10), then cut — unlike plain miter which
// would drop to the disc entirely (bevel fallback) past the limit.
{
  const peak = (join, ml) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    `<path d="M44 85 L50 25 L56 85" fill="none" stroke="black" stroke-width="10" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
  const probe = async (j, ml) => {
    const b = await importSvg(peak(j, ml));
    return (x, y) => hitAt(b, x, y, HitMode.Outline);
  };
  const clip = await probe('miter-clip', 2),
    miter = await probe('miter', 20),
    bevel = await probe('bevel', 2);
  // (50,18): s=7 < clip 10 → clip HITS; bevel MISSES (past the disc) → proves it
  // kept the spike, not fell back to bevel.
  if (!clip(50, 18)) fail('T7b miter-clip should retain the spike inside the clip (50,18)');
  else if (bevel(50, 18)) fail('T7b bevel(ml=2) should NOT reach (50,18) — proves clip ≠ bevel');
  // (50,8): s=17 > clip 10 → clip MISSES the cut-off tip, but full miter HITS.
  else if (clip(50, 8)) fail('T7b miter-clip should cut the tip past miterLimit·halfW (miss 50,8)');
  else if (!miter(50, 8)) fail('T7b unclipped miter should still reach (50,8)');
  else ok('T7b miter-clip: keeps the spike up to miterLimit·halfW, cuts the tip, ≠ bevel');
}

// ---- T8: dasharray gate on a curved stroke (TRUE arc length) ----
// A cubic whose arc length (320) is exactly 2× its chord (160), dashed
// "16 16". On the centerline, dash centers (arc-length k·32+8) must hit
// Outline; gap centers (k·32+24) must miss. Chord-based gating would
// invert these mid-curve — so this also guards the hit/draw agreement.
{
  const { _segLenInvert, segArcLen } = await import('../../src/svg/textures.js');
  const TX = await import('../../src/svg/textures.js');
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
      '<path d="M20 180 C 20 20, 180 20, 180 180" fill="none" stroke="black" ' +
      'stroke-width="8" stroke-dasharray="16 16"/></svg>',
  );
  const seg = {
    type: TX.SEG_CUBIC ?? 2,
    p1: [20, 180],
    p2: [20, 20],
    p3: [180, 20],
    p4: [180, 180],
  };
  const total = segArcLen(seg);
  const pt = (s) => {
    // centerline point at arc-length s
    const t = _segLenInvert(seg, s, total),
      u = 1 - t;
    const b0 = u * u * u,
      b1 = 3 * u * u * t,
      b2 = 3 * u * t * t,
      b3 = t * t * t;
    return [
      b0 * seg.p1[0] + b1 * seg.p2[0] + b2 * seg.p3[0] + b3 * seg.p4[0],
      b0 * seg.p1[1] + b1 * seg.p2[1] + b2 * seg.p3[1] + b3 * seg.p4[1],
    ];
  };
  let bad = 0;
  for (let k = 1; k <= 8; k++) {
    const dC = pt(k * 32 + 8),
      gC = pt(k * 32 + 24); // dash center / gap center
    if (!hitAt(b, dC[0], dC[1], HitMode.Outline)) {
      fail(`T8 dash center k=${k} (arcLen ${k * 32 + 8}) should HIT Outline`);
      bad++;
    }
    if (hitAt(b, gC[0], gC[1], HitMode.Outline)) {
      fail(`T8 gap center k=${k} (arcLen ${k * 32 + 24}) should MISS Outline`);
      bad++;
    }
  }
  if (!bad)
    ok(
      'T8 dashed cubic: arc-length dash centers hit, gap centers miss (hit-test matches drawn dashes)',
    );
}

// ---- T9: dasharray gate on a native ARC (circle) — hit test must agree
// with the renderer (which gates arcs too). r=40 circumference 251,
// "10 10" → ~12-13 dash runs. Walk the centerline by angle, count
// backdrop→Outline-hit transitions; a solid (un-gated) ring would be 1.
{
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="40" fill="none" stroke="black" stroke-width="6" stroke-dasharray="10 10"/></svg>',
  );
  const N = 720,
    cx = 50,
    cy = 50,
    r = 40;
  const seq = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI;
    seq.push(hitAt(b, cx + r * Math.cos(a), cy + r * Math.sin(a), HitMode.Outline));
  }
  let runs = 0;
  for (let i = 0; i < N; i++) if (seq[i] && !seq[(i + N - 1) % N]) runs++;
  if (runs >= 10 && runs <= 15)
    ok(
      `T9 dashed circle hit test: ${runs} dash runs around the ring (gated; matches the renderer)`,
    );
  else
    fail(
      `T9 dashed circle: ${runs} hit-test dash runs (expected ~12-13; 1 ⇒ arc dash gate missing in hit test)`,
    );
}

console.log(failures ? `\nCOVERAGE-HIT FAIL (${failures})` : '\nCOVERAGE-HIT PASS');
process.exit(failures ? 1 : 0);
