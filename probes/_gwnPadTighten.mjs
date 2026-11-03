// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnPadTighten — is the GWN tier-3 certified pad worth tightening?
//
// The tier-3 occupancy grid stores, per cell, margin = (min over sub-chords of
// dist(cell center, chord) - pad) - halfDiag. The fill shader takes the interior
// SKIP when margin > cellR. `pad` certifies "the true curve is within pad of this
// chord", so a SMALLER (still valid) pad means a LARGER margin and more cells
// skipping — at identical output, since a tighter certified bound is still a bound.
//
// Today's pad is a CONTROL-HULL bound: max deviation of the control points from
// the sub-chord (textures.js). That is provably loose. Writing the perpendicular
// offset of a cubic from its chord as the 1-D Bezier with control values
// (0, d1, d2, 0), its maximum is 3/4*max(d1,d2) when d1 = d2 (at t = 1/2), so the
// hull bound over-states by 4/3. For a quadratic, offset = 2(1-t)t*d1 peaks at
// d1/2 — the hull bound over-states by 2x.
//
// Before implementing any of that, this probe measures the CEILING: it recomputes
// the grid with every pad forced to ZERO — tighter than any valid bound can ever
// be — and reports how many more cells become skippable.
//
// VERDICT: NO. Measured ceiling, extra skippable cells at pad = 0:
//
//   tiger 5.8% | _dash_cubic 1.7% | _concave_cubic 0.8%
//   _arcs_circle 0.0% | _miter_circle 0.0% | _cnstar 0.0%
//
// and that is the ceiling — the 3/4 and 1/2 bounds capture only part of it.
//
// WHY, and this is the part worth keeping: the pad is NOT the binding term. A cell
// skips when margin > cellR, i.e. minDist > pad + ~2*halfDiag. The measured pad is
// 0.84–2.5% of its chord's length, while halfDiag is a full cell radius — roughly
// 35x larger. Tightening pad optimizes ~3% of the gate's threshold. Downstream it
// feeds a mechanism this file documents as worth −4% @1024 / −8% @2048 in total,
// so even the full ceiling is ~0.2–0.5% of render and a real tightening is far
// less: below any A/B noise floor we can measure.
//
// The lever for more tier-3 coverage is a FINER GRID (smaller halfDiag), not a
// tighter pad — and _GWN_GRID_BASE is already at its measured knee (24; 32/48 buy
// ~1% for +38%/+102% band memory). Both levers are spent.
//
// Keep this probe: it is the cheap way to re-answer "should we tighten the pad?"
// without implementing an error metric first.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeTexelBuffer,
  buildTexturesShape,
  computeGwnOccupancyCells,
} from '../src/svg/textures.js';
import { pickBandsXY } from '../src/svg/buildContext.js';
import { parsePathD } from '../src/svg/path.js';
import { segBboxInto } from '../src/svg/bbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/// Every `d` attribute in an SVG, in document order.
function pathDs(svg) {
  const out = [];
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(svg))) out.push(m[1]);
  return out;
}

function bboxOf(segs) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const bb = [0, 0, 0, 0];
  for (const s of segs) {
    if (!s) continue;
    segBboxInto(s, bb, 0);
    if (bb[0] < x0) x0 = bb[0];
    if (bb[1] < y0) y0 = bb[1];
    if (bb[2] > x1) x1 = bb[2];
    if (bb[3] > y1) y1 = bb[3];
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/// Fraction of cells whose margin clears a cell radius — the shader's skip gate.
function skipStats(cells, gridW, gridH, bbW, bbH) {
  const cellR = Math.hypot(bbW / gridW, bbH / gridH) / 2;
  let pos = 0,
    skip = 0,
    sumMargin = 0;
  const n = gridW * gridH;
  for (let i = 0; i < n; i++) {
    const m = cells[i * 2 + 1];
    if (m > 0) pos++;
    if (m > cellR) skip++;
    sumMargin += m;
  }
  return { pos, skip, n, meanMargin: sumMargin / n };
}

// Curve-heavy assets: the pad only exists for curved pieces, so straight-edge art
// would understate the question by construction.
const ASSETS = [
  'examples/tiger.svg',
  'examples/_concave_cubic.svg',
  'examples/_arcs_circle.svg',
  '../fixtures/svg/_circle.svg',
  '../fixtures/svg/_cnstar.svg',
  'examples/_miter_circle.svg',
  'examples/_dash_cubic.svg',
];
const rows = [];
for (const rel of ASSETS) {
  let svg;
  try {
    svg = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  let shapes = 0,
    curCells = 0,
    zeroCells = 0,
    curSkip = 0,
    zeroSkip = 0,
    total = 0;
  let padSum = 0,
    padN = 0,
    chordSum = 0;
  for (const d of pathDs(svg)) {
    let segs;
    try {
      segs = parsePathD(d);
    } catch {
      continue;
    }
    if (!segs || !segs.length) continue;
    const bbox = bboxOf(segs);
    if (!(bbox[2] > 0) || !(bbox[3] > 0)) continue;
    const bxy = pickBandsXY(segs, bbox, true, 32);
    const tier = [];
    try {
      buildTexturesShape(
        segs,
        bxy.bandsX,
        bxy.bandsY,
        bbox,
        makeTexelBuffer(),
        makeTexelBuffer(),
        0,
        true,
        false,
        false,
        true,
        tier,
      );
    } catch {
      continue;
    }
    for (const t of tier) {
      shapes++;
      const ps = t.polySegs;
      // pad relative to chord length: how fat is the certified tube?
      for (let s = 0; s * 5 < ps.length; s++) {
        const o = s * 5;
        const L = Math.hypot(ps[o + 2] - ps[o], ps[o + 3] - ps[o + 1]);
        padSum += ps[o + 4];
        chordSum += L;
        padN++;
      }
      const A = computeGwnOccupancyCells(ps, t.bbX0, t.bbY0, t.bbW, t.bbH, t.gridW, t.gridH);
      const zero = Float64Array.from(ps);
      for (let s = 0; s * 5 < zero.length; s++) zero[s * 5 + 4] = 0;
      const B = computeGwnOccupancyCells(zero, t.bbX0, t.bbY0, t.bbW, t.bbH, t.gridW, t.gridH);
      const a = skipStats(A, t.gridW, t.gridH, t.bbW, t.bbH);
      const b = skipStats(B, t.gridW, t.gridH, t.bbW, t.bbH);
      curCells += a.pos;
      zeroCells += b.pos;
      curSkip += a.skip;
      zeroSkip += b.skip;
      total += a.n;
    }
  }
  if (!shapes) continue;
  rows.push({
    name: path.basename(rel),
    shapes,
    total,
    curSkip,
    zeroSkip,
    curCells,
    zeroCells,
    padRel: padN ? padSum / padN / (chordSum / padN) : 0,
  });
}

console.log('asset          shapes   cells |  skip@pad  skip@pad=0   delta |  mean pad/chord');
for (const r of rows) {
  const d = r.zeroSkip - r.curSkip;
  const pct = r.curSkip ? ((100 * d) / r.curSkip).toFixed(1) + '%' : d ? 'inf' : '0.0%';
  console.log(
    `${r.name.padEnd(14)} ${String(r.shapes).padStart(6)} ${String(r.total).padStart(7)} | ` +
      `${String(r.curSkip).padStart(9)} ${String(r.zeroSkip).padStart(11)} ${String(d).padStart(7)} (${pct}) | ` +
      `${(r.padRel * 100).toFixed(2)}%`,
  );
}
console.log('\nskip@pad=0 is the CEILING: no valid tightening can beat it.');
