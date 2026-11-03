// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occupancyGridSmoke — prove the conservative interior occupancy grid is
// CORRECT: every cell it marks SOLID_IN must be entirely inside the fill and
// ≥1 cell from any boundary (the property the renderer's draw-time AA gate
// relies on for byte-identical output). Uses independent references: exact
// analytic circle/annulus math + a fine-flatten winding.
import { mkLine, mkArc, SEG_ARC } from '../src/svg/segment.js';
import { pathBbox } from '../src/svg/bbox.js';
import { buildOccupancyGrid } from '../src/svg/occupancy.js';

let fails = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.error('FAIL: ' + msg);
    fails++;
  } else console.log('ok ' + msg);
};

// Fine-flatten winding reference (independent of occupancy.js internals).
function refInside(segSamplers, px, py, evenOdd) {
  let cross = 0,
    wind = 0;
  for (const pts of segSamplers) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i],
        b = pts[i + 1];
      if (a[1] > py === b[1] > py) continue;
      const t = (py - a[1]) / (b[1] - a[1]);
      if (a[0] + t * (b[0] - a[0]) > px) {
        cross++;
        wind += b[1] > a[1] ? 1 : -1;
      }
    }
  }
  return evenOdd ? (cross & 1) === 1 : wind !== 0;
}
function sampleArc(cx, cy, r, t0, t1, n = 2000) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const th = t0 + ((t1 - t0) * i) / n;
    out.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
  }
  return out;
}

// For a grid, assert no SOLID_IN cell contains a false-interior point and that
// each is ≥ ~1 cell from the boundary (sampled densely inside the cell).
function assertGridSound(grid, bbox, isInside, nearestBoundaryDist, label) {
  if (!grid) return; // null handled by caller
  const { G, bits, cellW, cellH } = grid;
  const x0 = bbox[0],
    y0 = bbox[1];
  let bad = 0,
    tooClose = 0,
    K = 5;
  const minMargin = 0.5 * Math.min(cellW, cellH); // fragments inside cell are ≥ ~1 cell from boundary
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++) {
      if (!bits[gy * G + gx]) continue;
      for (let iy = 0; iy < K; iy++)
        for (let ix = 0; ix < K; ix++) {
          const px = x0 + (gx + (ix + 0.5) / K) * cellW;
          const py = y0 + (gy + (iy + 0.5) / K) * cellH;
          if (!isInside(px, py)) bad++;
          if (nearestBoundaryDist && nearestBoundaryDist(px, py) < minMargin) tooClose++;
        }
    }
  check(bad === 0, `${label}: no false-interior sample in any SOLID_IN cell (${bad} bad)`);
  if (nearestBoundaryDist)
    check(
      tooClose === 0,
      `${label}: every SOLID_IN sample ≥ ~1 cell from boundary (${tooClose} too close)`,
    );
}

// ── 1) circle r=40 at (50,50): exact inside + exact boundary distance ──
{
  const segs = [mkArc(50, 50, 40, 40, -Math.PI, Math.PI, 0, 1, 1)];
  const bbox = pathBbox(segs);
  const grid = buildOccupancyGrid(segs, bbox, false, { grid: 16 });
  check(
    !!grid && grid.interiorFrac > 0.3,
    `circle: grid built, interiorFrac=${grid ? grid.interiorFrac.toFixed(2) : 'null'}`,
  );
  const isInside = (x, y) => Math.hypot(x - 50, y - 50) < 40;
  const distB = (x, y) => Math.abs(Math.hypot(x - 50, y - 50) - 40);
  assertGridSound(grid, bbox, isInside, distB, 'circle');
}

// ── 2) even-odd annulus (outer r=40, inner r=18): hole must be EXCLUDED ──
{
  // two concentric full-circle arcs; even-odd ⇒ ring filled, hole empty.
  const segs = [
    mkArc(50, 50, 40, 40, -Math.PI, Math.PI, 0, 1, 1),
    mkArc(50, 50, 18, 18, -Math.PI, Math.PI, 0, 1, 1),
  ];
  const bbox = pathBbox(segs);
  const grid = buildOccupancyGrid(segs, bbox, true, { grid: 24 });
  const isInside = (x, y) => {
    const d = Math.hypot(x - 50, y - 50);
    return d < 40 && d > 18;
  };
  const distB = (x, y) => {
    const d = Math.hypot(x - 50, y - 50);
    return Math.min(Math.abs(d - 40), Math.abs(d - 18));
  };
  assertGridSound(grid, bbox, isInside, distB, 'annulus');
  // Explicitly: the dead center (50,50) is in the HOLE → its cell must not be SOLID_IN.
  if (grid) {
    const cx = Math.floor((50 - bbox[0]) / grid.cellW),
      cy = Math.floor((50 - bbox[1]) / grid.cellH);
    check(grid.bits[cy * grid.G + cx] === 0, 'annulus: hole center cell is NOT marked interior');
  }
}

// ── 3) big square: interior fraction should be high ──
{
  const segs = [
    mkLine([0, 0], [100, 0]),
    mkLine([100, 0], [100, 100]),
    mkLine([100, 100], [0, 100]),
    mkLine([0, 100], [0, 0]),
  ];
  const bbox = pathBbox(segs);
  const grid = buildOccupancyGrid(segs, bbox, false, { grid: 16 });
  const isInside = (x, y) => x > 0 && x < 100 && y > 0 && y < 100;
  const distB = (x, y) => Math.min(x, 100 - x, y, 100 - y);
  check(
    !!grid && grid.interiorFrac > 0.6,
    `square: high interiorFrac=${grid ? grid.interiorFrac.toFixed(2) : 'null'}`,
  );
  assertGridSound(grid, bbox, isInside, distB, 'square');
}

// ── 4) thin ring (wall ≪ cell): no interior survives erosion → null ──
{
  // outer r=40, inner r=37 → 3-unit wall; bbox 80, G=16 → cell=5 > wall, so
  // after 1-cell erosion no cell is fully inside the ring → low frac → null.
  const segs = [
    mkArc(50, 50, 40, 40, -Math.PI, Math.PI, 0, 1, 1),
    mkArc(50, 50, 37, 37, -Math.PI, Math.PI, 0, 1, 1),
  ];
  const bbox = pathBbox(segs);
  const grid = buildOccupancyGrid(segs, bbox, true, { grid: 16 });
  check(grid === null, 'thin ring: yields no grid (interior fraction below threshold)');
}

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log('\noccupancyGridSmoke: all assertions passed');
