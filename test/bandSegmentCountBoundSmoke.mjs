// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bandSegmentCountBoundSmoke — a band may hold MORE THAN 1024 segments of one type, and every
// one of them must be walked.
//
// THE DEFECT CLASS. A band walk written as
//
//     for (int i = 0; i < 1024; i++) { if (i >= nLine) break; }
//
// -- a static bound GLSL ES 1.00 required and #version 300 es does not. The real exit is the
// count, so the constant only ever binds a band holding more than 1024 segments of a type, and
// there it stops the walk early: every segment past the 1024th contributes nothing. No error,
// no warning, just less ink, in exactly the right PLACE, so an engine-vs-engine pixel audit
// cannot see it (both engines read the same truncated band); on one path that packs a single
// band the stroke loses 45% of its coverage and the fill 6%. The band entries are sorted by maxX
// descending for the early-out break, so what a truncated walk drops is the segments furthest
// from the ray's start -- a whole side of the shape.
//
// The class is not one loop: the same shape appears wherever a walk is bounded by a constant
// "big enough" for the data at hand.
//
// WHAT this PINS, all on the CPU (src/hitTest/bandWinding.js is the faithful CPU twin of the shader's
// walk -- the same band and curve buffers, the same loops, the same conventions):
//
//   (a) THE FIXTURE IS THE CASE. A comb of full-height diagonals puts every segment in every H
//       band, so a band header really does report more than 1024 segments of one type. Without
//       this the rest of the smoke would pass on a shape that never reaches the bound.
//   (b) THE WALK IS RIGHT. Away from every edge, the walk's answer equals an independent f64
//       crossing count over the source polygon, under both fill rules.
//   (c) THE GUARD BITES. Clamping every band header count to 1024 is exactly what a static
//       bound does -- the walk takes min(1024, n) either way -- and it must move the answer at a
//       large number of those same points. A fixture that does not move under the clamp cannot
//       catch the defect, so this is a property of the TEST, checked like any other.
//   (d) NO WALK IS BOUNDED BY A CONSTANT. In the shaders and in the CPU port, every band walk is
//       bounded by the band's own count. The defect's shape -- a literal loop bound with `if (i >= n)
//       break` inside -- must not exist anywhere, which is the check that catches a reintroduction
//       in a loop this fixture does not happen to reach.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ── the fixture: a comb whose every segment spans the full height ─────────────────────────────
// Band membership is by overlap with the band's stripe, so a diagonal from y=0 to y=H is in every
// H band. K teeth give 2K such diagonals plus the closing edge along y=0 -- one band, 2K+1 line
// segments. K = 560 clears 1024 with room for the closing edge and for any binning slack.
const K = 560,
  H = 100,
  W = 1;
const pts = [[0, 0]];
for (let i = 0; i < K; i++) {
  pts.push([(2 * i + 1) * W, H]);
  pts.push([(2 * i + 2) * W, 0]);
}
let d = `M ${pts[0][0]} ${pts[0][1]}`;
for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
d += ' Z';
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${2 * K * W} ${H}">` +
  `<path fill="#000" d="${d}"/></svg>`;

const raw = await importSvg(SVG);
const MF = parseMetaBin(raw.meta, raw.metaFloatsPerShape).metaFloats;
const gd = [
  MF[M.META_GLYPH_LOC_X],
  MF[M.META_GLYPH_LOC_Y],
  MF[M.META_BAND_MAX_X],
  MF[M.META_BAND_MAX_Y],
];
const bb = [MF[M.META_BBOX_XMIN], MF[M.META_BBOX_YMIN], MF[M.META_BBOX_XMAX], MF[M.META_BBOX_YMAX]];
const bandF = new Float32Array(raw.bands);
const curveF = new Float32Array(raw.curves);

// The band buffer's texel addressing, as bandFillCoverage does it. A band's header is TWO
// slots: [nLine, nQuad, nCubic, nArc] then [arrIdx, ...] -- so band b's counts are at 2*b, and
// clamping anything else would corrupt an index rather than truncate a walk.
const TEX_W = 4096;
const bTex = (slot) => ((gd[1] | 0) * TEX_W + (gd[0] | 0) + slot) * 4;
const hdrOf = (b) => bTex(b * 2);

// ── (a) the fixture really reaches the bound ──────────────────────────────────────────────────
const nH = (gd[3] | 0) + 1,
  nV = (gd[2] | 0) + 1;
let maxCount = 0,
  bandsOver = 0;
for (let b = 0; b < nH + nV; b++) {
  const o = hdrOf(b);
  const c = Math.max(bandF[o], bandF[o + 1], bandF[o + 2], bandF[o + 3]);
  maxCount = Math.max(maxCount, c);
  if (c > 1024) bandsOver++;
}
ok(
  bandsOver > 0 && maxCount > 1024,
  `(a) ${bandsOver} of ${nH + nV} bands hold more than 1024 segments of one type (max ${maxCount}) ` +
    `— the encoder can express the count, and the fixture reaches the 1024 bound`,
);

// ── the independent truth: an f64 crossing count over the source polygon ──────────────────────
// Nonzero and even-odd of the same ray, computed from the polygon this SVG was written from --
// no band data, no curve buffer, nothing the walk under test reads.
function truth(x, y) {
  let wind = 0,
    cross = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i],
      [bx, by] = pts[(i + 1) % pts.length];
    if (ay > y === by > y) continue;
    const t = (y - ay) / (by - ay);
    if (ax + t * (bx - ax) <= x) continue; // crossings to the RIGHT of the point
    cross++;
    wind += by > ay ? 1 : -1;
  }
  return { nz: wind !== 0 ? 1 : 0, eo: cross & 1 ? 1 : 0 };
}

// Sample points, all far from every edge relative to the pixel size below: the middle of each
// tooth (inside) and each valley vertex at mid-height (outside). At y = H/4 a tooth is 1.5 W
// wide, so an interior sample is 0.75 W from the nearest edge; at y = H/2 a valley sample is
// 0.5 W from each neighbouring tooth.
const PX = 4; // PIXELS PER EM (the walk's AA scale):
// 0.25 units per pixel, so every sample is
// 2+ pixels clear of an edge and the answer
// is a flat 0 or 1. (b) is rerun across a
// scale sweep below, since the 0.5 decision
// level is meant to be scale-independent.
const SAMPLES = [];
for (let i = 0; i < K; i++) {
  SAMPLES.push([(2 * i + 1) * W, H * 0.25]); // inside tooth i
  SAMPLES.push([(2 * i + 2) * W, H * 0.5]); // outside, in the valley after it
}

// ── (b) the walk equals the truth, under both fill rules, at every scale ──────────────────────
for (const evenOdd of [false, true]) {
  let differ = 0,
    first = null,
    n = 0;
  for (const px of [1, 4, 16, 64]) {
    for (const [x, y] of SAMPLES) {
      n++;
      const cov = bandFillCoverage(bandF, curveF, gd, bb, x, y, px, px, evenOdd);
      const want = evenOdd ? truth(x, y).eo : truth(x, y).nz;
      if (Math.abs(cov - want) > 1e-6) {
        differ++;
        if (!first) first = [px, x, y, cov, want];
      }
    }
  }
  ok(
    differ === 0,
    `(b) ${evenOdd ? 'even-odd' : 'nonzero'}: ${n} samples over a ` +
      `${maxCount}-segment band, at 4 scales, all match the f64 crossing count` +
      (first
        ? ` — first miss at ${first[0]} px/em (${first[1]}, ${first[2]}): ${first[3]} vs ${first[4]}`
        : ''),
  );
}

// ── (c) the guard bites: the 1024 clamp IS a static bound, and it must move the answer ─────────
// min(1024, n) is what `for (i < 1024) { if (i >= n) break; }` walked, so clamping the counts
// reproduces the defect exactly, on the shipped walk, with no mutated source.
const clamped = bandF.slice();
for (let b = 0; b < nH + nV; b++) {
  const o = hdrOf(b);
  for (let k = 0; k < 4; k++) clamped[o + k] = Math.min(clamped[o + k], 1024);
}
let moved = 0;
for (const [x, y] of SAMPLES) {
  const a = bandFillCoverage(bandF, curveF, gd, bb, x, y, PX, PX, false);
  const c = bandFillCoverage(clamped, curveF, gd, bb, x, y, PX, PX, false);
  if (Math.abs(a - c) > 1e-6) moved++;
}
// The band's entries are sorted by maxX descending, so a truncated walk drops the LOWEST maxX
// first: the ~(maxCount - 1024) dropped entries are the leftmost teeth, two segments each, and
// the samples inside them go wrong. The bar is well under that count and well over zero -- what
// it must not be is zero, which would mean the fixture proves nothing.
ok(
  moved >= 24,
  `(c) the 1024 clamp — a static bound, exactly — moves ${moved} of ` +
    `${SAMPLES.length} samples (${maxCount - 1024} entries dropped per band), so this fixture ` +
    `can catch the defect`,
);

// ── (d) no band walk is bounded by a constant, in the shaders or in the port ──────────────────
// The counts a band walk is allowed to be bounded by. The forbidden shape is a literal loop bound
// with the count demoted to a `break` inside -- which is what the truncating loops looked like.
const COUNTS = [
  'nLine',
  'nQuad',
  'nCubic',
  'nArc',
  'hLineN',
  'hQuadN',
  'hCubicN',
  'hArcN',
  'vLineN',
  'vQuadN',
  'vCubicN',
  'vArcN',
];
const SHADERS = [
  'src/shaders/_coverage.glsl',
  'src/shaders/mantle.frag.glsl',
  'src/shaders/generated/mantle.frag.glsl',
];
const offenders = [];
let walks = 0;
for (const rel of [...SHADERS, 'src/hitTest/bandWinding.js']) {
  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /for\s*\(\s*(?:int|let|var)\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*([A-Za-z_]\w*|\d+)\s*;/,
    );
    if (!m) continue;
    const [, v, bound] = m;
    // The body's first few lines: a demoted count reads `if (i >= nLine) break;`.
    const body = lines.slice(i + 1, i + 4).join(' ');
    const demoted = COUNTS.find((c) => new RegExp(`\\b${v}\\s*>=\\s*${c}\\b`).test(body));
    if (demoted) {
      offenders.push(`${rel}:${i + 1}: bound by ${bound}, ${demoted} demoted to a break`);
      continue;
    }
    if (COUNTS.includes(bound)) walks++;
  }
}
ok(walks >= 12, `(d) ${walks} band walks found, each bounded by the band's own count`);
ok(
  offenders.length === 0,
  `(d) no band walk is bounded by a constant with the count demoted to a break` +
    (offenders.length ? `\n      ${offenders.join('\n      ')}` : ''),
);

console.log(
  fail ? `FAIL bandSegmentCountBoundSmoke: ${fail} check(s)` : 'PASS bandSegmentCountBoundSmoke',
);
process.exit(fail ? 1 : 0);
