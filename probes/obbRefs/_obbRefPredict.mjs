// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _obbRefPredict — the numbers a GPU render of the three objectBoundingBox demo assets must agree with, and
// the numbers a NAIVE document-space rule gives instead, so a render can be told apart rather than merely looked at.
//
//   node probes/obbRefs/_obbRefPredict.mjs
//
// Every prediction is computed twice: once from the bundle this tree produces (WANT) and once from the rule the
// naive rule gives (WAS), which is re-derived here in closed form from the same bundle -- the document-space
// AABB normalization for a gradient, the document-AABB fractions for a filter region, and the full unclipped
// extent for a silhouette. If a render matches WAS, the bundle's rule did not reach the GPU path; if it matches neither,
// something other than these three items is in the way and the prediction is wrong, not merely unmet.
//
// Coordinates are DOCUMENT units (the asset's viewBox), because that is what does not depend on how the
// harness fits the drawing. Note renderer.setViewport + drawBundle fit the CONTENT bbox, not the viewBox
// so map a document point to a pixel through the content box the harness
// reports, not by assuming the viewBox fills the canvas. Pixel COUNTS below are quoted at the scale
// 1 document unit = 1 px and scale with the square of whatever scale is used.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
console.warn = () => {};

const A = (f) => path.join(ROOT, 'examples', 'smoke', f);
const rowsOf = (b) => new Float32Array(b.meta, 32);
const bboxOf = (m, r) => Array.from(m.slice(r * 48, r * 48 + 4));
const LAYER = 0x100;
const drawnRows = (m) => [...Array(m.length / 48).keys()].filter((r) => !(m[r * 48 + 27] & LAYER));
const f2 = (v) => (Math.abs(v) >= 1e-3 || v === 0 ? (+v).toFixed(2) : (+v).toExponential(2));
const box = (a) => '[' + a.map(f2).join(', ') + ']';

// A GPU render cannot consume console text. With JSON=<path> set, every prediction below is also written out
// in DOCUMENT units, so probes/obbRefs/_obbRefGpuCheck.mjs can classify each readback pixel as WANT, WAS or
// neither instead of a human looking at a picture.
const J = { obbGradient: [], filterRegion: [], clippedSilhouette: null };

// ============================================================================================================
// objectBoundingBox GRADIENTS. examples/smoke/objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg
//
// Four cells, each the same 40 x 20 rect filled with the same objectBoundingBox ramp running along the box's
// own +x, #101418 at x=0 to #f05a28 at x=1, hairline white outline. Cells: plain, rotate(30), skewX(30),
// scale(-1 1), at translate(40 70) / (150 70) / (260 70) / (390 70).
console.log('='.repeat(108));
console.log('gradients  objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg');
console.log('='.repeat(108));
{
  const b = await importSvg(
    readFileSync(A('objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg'), 'utf8'),
    { preserveViewport: true },
  );
  const m = rowsOf(b),
    G = new Float32Array(b.gradients);
  const rows = drawnRows(m).filter((r) => (m[r * 48 + 28] | 0) > 0);
  const C0 = [0x10, 0x14, 0x18],
    C1 = [0xf0, 0x5a, 0x28];
  // The shader's chain (_paintSample.glsl sampleGradient, steps 1-3, in JS) for one gradient record.
  const tAt = (g, bb, p) => {
    let gx = p[0],
      gy = p[1];
    if (g[2] > 0.5) {
      gx = (p[0] - bb[0]) / Math.max(bb[2] - bb[0], 1e-6);
      gy = (p[1] - bb[1]) / Math.max(bb[3] - bb[1], 1e-6);
    }
    const qx = g[4] * gx + g[6] * gy + g[8],
      qy = g[5] * gx + g[7] * gy + g[9];
    const dx = g[14] - g[12],
      dy = g[15] - g[13];
    return ((qx - g[12]) * dx + (qy - g[13]) * dy) / Math.max(dx * dx + dy * dy, 1e-12);
  };
  const rgb = (t) => {
    const u = Math.min(1, Math.max(0, t));
    return C0.map((c, i) => Math.round(c + (C1[i] - c) * u));
  };
  let totalDiff = 0,
    totalPx = 0,
    worstAll = 0;
  rows.forEach((r, k) => {
    const gid = m[r * 48 + 28] | 0;
    const gNew = G.slice((gid - 1) * 16, gid * 16);
    const gOld = G.slice(0, 16); // row 1 is the shared objectBoundingBox record, untouched
    const bb = bboxOf(m, r);
    // Every pixel center in the row's box; the rect covers part of it, and outside the rect nothing is painted,
    // so this is an upper bound that the cell's own area (800 px at 1 unit/px) bounds in turn.
    let n = 0,
      diff = 0,
      worst = 0,
      sample = null;
    for (let y = Math.floor(bb[1]) + 0.5; y < bb[3]; y++)
      for (let x = Math.floor(bb[0]) + 0.5; x < bb[2]; x++) {
        const cNew = rgb(tAt(gNew, bb, [x, y])),
          cOld = rgb(tAt(gOld, bb, [x, y]));
        const d = Math.max(...cNew.map((c, i) => Math.abs(c - cOld[i])));
        n++;
        if (d > 8) diff++;
        if (d > worst) {
          worst = d;
          sample = [x, y, cNew, cOld];
        }
      }
    totalDiff += diff;
    totalPx += n;
    worstAll = Math.max(worstAll, worst);
    const pts = [];
    for (let y = Math.floor(bb[1]) + 0.5; y < bb[3]; y++)
      for (let x = Math.floor(bb[0]) + 0.5; x < bb[2]; x++) {
        const cNew = rgb(tAt(gNew, bb, [x, y])),
          cOld = rgb(tAt(gOld, bb, [x, y]));
        pts.push([x, y, cNew, cOld]);
      }
    J.obbGradient.push({ cell: k, row: r, bbox: bb, gid, units: gNew[2], diff, n, worst, pts });
    console.log(`  cell ${k} row ${r}  bbox ${box(bb)}  gradient row ${gid} (units ${gNew[2]})`);
    console.log(
      `     ${diff} of ${n} px in the row box differ by > 8/255; worst ${worst}/255` +
        (sample
          ? ` at (${f2(sample[0])}, ${f2(sample[1])}): WANT rgb(${sample[2]}) WAS rgb(${sample[3]})`
          : ''),
    );
  });
  console.log(
    `  TOTAL ${totalDiff} of ${totalPx} px differ by > 8/255, worst channel delta ${worstAll}/255.`,
  );
  console.log(
    "  PIN: the gradient record index each row carries (meta float 28) and each record's units flag",
  );
  console.log(
    '       (gradient float 2). Cell 0 must stay on record 1 with units 1; cells 1-3 must be on their',
  );
  console.log('       own records with units 0 and a non-diagonal inverse matrix.');
  console.log(
    "  CLAIM: in cells 1-3 the ramp runs along the RECT's own long axis -- up-and-right at 30 deg,",
  );
  console.log(
    '       sheared, and right-to-left under the flip. WRONG IF: all four ramps run left-to-right',
  );
  console.log(
    '       across the page (the rule did not reach the draw), or cell 0 moved at all (the exact',
  );
  console.log(
    '       positive-diagonal test failed and bundles that were right have been disturbed).',
  );
}

// ============================================================================================================
// objectBoundingBox FILTER REGIONS. examples/smoke/filterRegionTransform__FILTER_REGION_DEMO.svg
//
// Two cells, the same 80 x 24 bar under the same blur and the same TIGHT region keeping the left 55% of the
// bar's own box (x=0 y=-0.25 w=0.55 h=1.5). Cell 0 upright at translate(40 60); cell 1 at
// translate(190 60) rotate(30).
console.log('');
console.log('='.repeat(108));
console.log('filter regions  filterRegionTransform__FILTER_REGION_DEMO.svg');
console.log('='.repeat(108));
{
  const b = await importSvg(
    readFileSync(A('filterRegionTransform__FILTER_REGION_DEMO.svg'), 'utf8'),
    { preserveViewport: true },
  );
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const st = pm.floatsPerShape;
  const FR = [0, -0.25, 0.55, 1.5];
  const seen = new Map();
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * st + 32] + 0.5);
    if (fid <= 0 || seen.has(fid)) continue;
    seen.set(fid, Array.from(pm.metaFloats.subarray(s * st, s * st + 4)));
  }
  [...seen.entries()].forEach(([fid, docBb], k) => {
    const want = b.filterRegions[fid - 1];
    // The naive rule: fractions of the claimers' DOCUMENT-space AABB, which for these one-shape groups is
    // exactly the row's own bbox.
    const bw = docBb[2] - docBb[0],
      bh = docBb[3] - docBb[1];
    const was = [docBb[0] + FR[0] * bw, docBb[1] + FR[1] * bh, FR[2] * bw, FR[3] * bh, 1];
    const inter = [
      Math.max(want[0], was[0]),
      Math.max(want[1], was[1]),
      Math.min(want[0] + want[2], was[0] + was[2]),
      Math.min(want[1] + want[3], was[1] + was[3]),
    ];
    const iA = Math.max(0, inter[2] - inter[0]) * Math.max(0, inter[3] - inter[1]);
    const symmetric = want[2] * want[3] + was[2] * was[3] - 2 * iA;
    J.filterRegion.push({
      cell: k,
      fid,
      docBb,
      want: want.slice(0, 4),
      was: was.slice(0, 4),
      symmetric,
    });
    console.log(`  cell ${k} filter ${fid}  document box ${box(docBb)}`);
    console.log(`     WANT scissor ${box(want.slice(0, 4))}   WAS ${box(was.slice(0, 4))}`);
    console.log(
      `     ${symmetric.toFixed(1)} square document units are scissored differently` +
        ` (${((100 * symmetric) / (want[2] * want[3])).toFixed(1)}% of the new region's area)` +
        (symmetric === 0 ? '  <- the positive-diagonal guard: this cell must NOT move' : ''),
    );
  });
  console.log(
    '  PIN: bundle.filterRegions[fid-1] per filtered row, and that the two cells get DIFFERENT filter',
  );
  console.log('       entries (one per group instance).');
  console.log(
    "  CLAIM: the blurred bar in cell 1 is cut SQUARE TO THE BAR, at 55% along the bar's own length,",
  );
  console.log(
    '       so the cut edge is at 30 deg to the page and the kept part is the same fraction of the',
  );
  console.log(
    '       bar as in cell 0. WRONG IF: the cut in cell 1 is vertical on the page, or sits at a',
  );
  console.log(
    '       different fraction of the bar than in cell 0. The scissor is still AXIS-ALIGNED, so the',
  );
  console.log(
    "       corner wedges between the spec's turned rect and its bound are NOT cut: seeing blur",
  );
  console.log('       survive in those wedges is the KNOWN limit, not a failure.');
}

// ============================================================================================================
// The SILHOUETTE of a clipped shape. examples/smoke/silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg
//
// A 220 x 60 plate clipped to a 60-wide band, and a disc. Import with computeSilhouette.
console.log('');
console.log('='.repeat(108));
console.log('silhouette  silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg');
console.log('='.repeat(108));
{
  const src = readFileSync(A('silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg'), 'utf8');
  const OPT = {
    preserveViewport: true,
    computeSilhouette: true,
    outlineWidth: 6,
    outlineColor: [1, 1, 1, 1],
  };
  const b = await importSvg(src, OPT);
  const m = rowsOf(b);
  const want = bboxOf(m, 0);
  // The naive rule: the union at FULL extent, whose box is the union of the drawn rows' own boxes grown by
  // half the outline width.
  let u = null;
  for (const r of drawnRows(m).slice(1)) {
    const bb = bboxOf(m, r);
    if (!(bb[2] > bb[0] && bb[3] > bb[1])) continue;
    u = u
      ? [Math.min(u[0], bb[0]), Math.min(u[1], bb[1]), Math.max(u[2], bb[2]), Math.max(u[3], bb[3])]
      : bb;
  }
  const was = [u[0] - 3, u[1] - 3, u[2] + 3, u[3] + 3];
  console.log(`  silhouette row 0  WANT ${box(want)}   WAS ${box(was)}`);
  // The two outlines, in closed form for this asset. The disc (r 30 at cy 70) is tangent inside the plate
  // (y 40..100), so the naive union's boundary is the plate rectangle alone; the clipped one is the band
  // rectangle plus the disc's circle, both stroked 6 wide (half width 3).
  const HW = 3;
  const dRect = (x, y, r) => {
    // distance to a rectangle's BOUNDARY
    const dx = Math.max(r[0] - x, 0, x - r[2]),
      dy = Math.max(r[1] - y, 0, y - r[3]);
    const outside = Math.hypot(dx, dy);
    if (outside > 0) return outside;
    return Math.min(x - r[0], r[2] - x, y - r[1], r[3] - y);
  };
  const paintedWas = (x, y) => dRect(x, y, [10, 40, 230, 100]) <= HW;
  const paintedWant = (x, y) =>
    dRect(x, y, [40, 40, 100, 100]) <= HW || Math.abs(Math.hypot(x - 170, y - 70) - 30) <= HW;
  let onlyWas = 0,
    onlyWant = 0,
    both = 0;
  for (let y = 0.5; y < 140; y++)
    for (let x = 0.5; x < 240; x++) {
      const a = paintedWas(x, y),
        c = paintedWant(x, y);
      if (a && c) both++;
      else if (a) onlyWas++;
      else if (c) onlyWant++;
    }
  J.clippedSilhouette = {
    want,
    was,
    hw: HW,
    wasRect: [10, 40, 230, 100],
    wantRect: [40, 40, 100, 100],
    disc: [170, 70, 30],
    onlyWas,
    onlyWant,
    both,
  };
  console.log(
    `  outline pixels at 1 unit/px: ${onlyWas} painted only by the naive rule,` +
      ` ${onlyWant} only by this one, ${both} by both.`,
  );
  console.log(
    "       The naive outline is the whole 220-wide plate's rectangle. This one is the 60-wide",
  );
  console.log(
    "       band's rectangle plus a ring around the disc -- and the ring is the easiest thing to",
  );
  console.log(
    '       look for, because the naive rule draws no ring at all (the disc is inside the plate).',
  );
  console.log(
    '  PIN: bundle.numShapes (one more than without the option), bundle.shapeIds[0] === "__silhouette__",',
  );
  console.log("       and meta row 0's bbox.");
  console.log(
    '  CLAIM: the outline hugs the VISIBLE band (x 40..100) and the disc, and draws nothing along the',
  );
  console.log(
    '       clipped-away plate. WRONG IF: an outline runs across the whole 220-wide plate, or if the',
  );
  console.log(
    '       band or the disc has no outline at all (the region was read as empty rather than as the',
  );
  console.log('       clip, which loses ink -- the opposite of the intended direction).');
}
console.log('');
if (process.env.JSON) {
  writeFileSync(process.env.JSON, JSON.stringify(J));
  console.log(`wrote ${process.env.JSON}`);
}
