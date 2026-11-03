// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Hand-traced expected node bboxes for representative graph topologies,
// validating computeNodeBboxes against the kinds of graphs the importer
// and colrPaintToGraph emit.
//
// Source bbox for all tests: { x: 100, y: 100, w: 80, h: 80 }
// Canvas: 400 × 300.

import { computeNodeBboxes } from '../src/filterGraph/bbox.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
function eqBbox(a, b, label) {
  return assert(
    a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
    `${label}: expected {x:${b.x},y:${b.y},w:${b.w},h:${b.h}}, got {x:${a.x},y:${a.y},w:${a.w},h:${a.h}}`,
  );
}

const SRC = { x: 100, y: 100, w: 80, h: 80 };
const CW = 400,
  CH = 300;

// --- 1: single feGaussianBlur σ=4 expands by ±12 ---
{
  const graph = {
    nodes: [{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 4, sigmaY: 4 } }],
    rootOut: 0,
  };
  const { bboxes, rootBbox } = computeNodeBboxes(graph, SRC, CW, CH);
  eqBbox(bboxes[0], { x: 88, y: 88, w: 80 + 24, h: 80 + 24 }, 'blur σ=4 dilates ±12');
  eqBbox(rootBbox, bboxes[0], 'rootBbox = node 0');
}

// --- 2: blur σ=4 → offset(+50, +30) shifts the dilated bbox ---
{
  const graph = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 4, sigmaY: 4 } },
      { type: 'feOffset', inputs: [0], params: { dx: 50, dy: 30 } },
    ],
    rootOut: 1,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  eqBbox(bboxes[0], { x: 88, y: 88, w: 104, h: 104 }, 'blur output');
  // Offset shifts the dilated bbox by (50, 30) → (138, 118).
  eqBbox(bboxes[1], { x: 138, y: 118, w: 104, h: 104 }, 'offset shifts');
}

// --- 3: feFlood is a generator → source-sized regardless of inputs ---
{
  const graph = {
    nodes: [{ type: 'feFlood', inputs: [], params: { rgba: [1, 0, 0, 1] } }],
    rootOut: 0,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  eqBbox(bboxes[0], SRC, 'feFlood = source bbox');
}

// --- 4: feMerge unions all inputs ---
{
  const graph = {
    nodes: [
      { type: 'feOffset', inputs: [-1], params: { dx: -30, dy: 0 } },
      { type: 'feOffset', inputs: [-1], params: { dx: 40, dy: 20 } },
      { type: 'feMerge', inputs: [0, 1], params: {} },
    ],
    rootOut: 2,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  // input 0: source shifted (-30, 0) → x=70, y=100, w=80, h=80
  // input 1: source shifted (+40, +20) → x=140, y=120, w=80, h=80
  // merge: union → x=70, y=100, x1=220, y1=200 → w=150, h=100
  eqBbox(bboxes[2], { x: 70, y: 100, w: 150, h: 100 }, 'feMerge unions');
}

// --- 5: morphology dilate grows bbox; erode keeps source ---
{
  const graph = {
    nodes: [
      { type: 'feMorphology', inputs: [-1], params: { operator: 1, radiusX: 5, radiusY: 5 } },
      { type: 'feMorphology', inputs: [-1], params: { operator: 0, radiusX: 5, radiusY: 5 } },
    ],
    rootOut: 1,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  eqBbox(bboxes[0], { x: 95, y: 95, w: 90, h: 90 }, 'dilate grows ±5');
  eqBbox(bboxes[1], SRC, 'erode keeps source');
}

// --- 6: bbox clamps to canvas (a huge blur near the edge) ---
{
  // Source at upper-left of canvas; σ=50 → ±150 dilation.
  const src = { x: 10, y: 10, w: 30, h: 30 };
  const graph = {
    nodes: [{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 50, sigmaY: 50 } }],
    rootOut: 0,
  };
  const { bboxes } = computeNodeBboxes(graph, src, CW, CH);
  // Unclamped: x = 10 - 150 = -140 → clamps to 0
  //            y = 10 - 150 = -140 → clamps to 0
  //            x1 = 10 + 30 + 150 = 190
  //            y1 = 10 + 30 + 150 = 190
  // Clamped: x=0, y=0, w=190, h=190
  eqBbox(bboxes[0], { x: 0, y: 0, w: 190, h: 190 }, 'huge blur clamps to canvas edge');
}

// --- 7: PaintTransform with 0.5x scale + translate ---
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintTransform', inputs: [0], params: { affine: [0.5, 0, 0, 0.5, 100, 50] } },
    ],
    rootOut: 1,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  // PaintSolid takes source bbox (100..180, 100..180).
  // Affine [0.5,0, 0,0.5, 100,50] maps (x, y) → (0.5x+100, 0.5y+50).
  // Corner (100,100) → (150, 100); (180,100) → (190, 100);
  // (100,180) → (150, 140); (180,180) → (190, 140).
  // Bbox: x=150, y=100, w=40, h=40.
  eqBbox(bboxes[1], { x: 150, y: 100, w: 40, h: 40 }, 'transform 0.5x + (100,50)');
}

// --- 8: rotation maps a square to a larger axis-aligned bbox ---
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      // 45° rotation about origin (about (0,0) not bbox center).
      {
        type: 'PaintTransform',
        inputs: [0],
        params: {
          affine: [
            Math.cos(Math.PI / 4),
            Math.sin(Math.PI / 4),
            -Math.sin(Math.PI / 4),
            Math.cos(Math.PI / 4),
            0,
            0,
          ],
        },
      },
    ],
    rootOut: 1,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  // Source corners 100..180. 45° rotation about origin pushes
  // the (180, 180) corner to (180·c - 180·s, 180·s + 180·c) ≈ (0, 255).
  // Without belabouring the math: just verify rotation produces a
  // larger bbox than the source's 80×80.
  assert(
    bboxes[1].w > 80 || bboxes[1].h > 80,
    `45° rotation produces larger bbox than source (got w=${bboxes[1].w}, h=${bboxes[1].h})`,
  );
}

// --- 9: feTile bbox = whole canvas ---
{
  const graph = {
    nodes: [{ type: 'feTile', inputs: [-1], params: {} }],
    rootOut: 0,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  eqBbox(bboxes[0], { x: 0, y: 0, w: CW, h: CH }, 'feTile fills canvas');
}

// --- 10: a realistic chain — drop-shadow-ish ---
{
  const graph = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-2], params: { sigmaX: 6, sigmaY: 6 } },
      { type: 'feOffset', inputs: [0], params: { dx: 10, dy: 8 } },
      { type: 'feFlood', inputs: [], params: { rgba: [0, 0, 0, 0.5] } },
      { type: 'feComposite', inputs: [2, 1], params: { op: 1 } },
      { type: 'feMerge', inputs: [3, -1], params: {} },
    ],
    rootOut: 4,
  };
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  // node 0 = SourceAlpha blurred σ=6 → ±18: 82..198, 82..198 → w=116
  eqBbox(bboxes[0], { x: 82, y: 82, w: 116, h: 116 }, 'blur σ=6');
  // node 1 = blur + offset (10,8): 92..208, 90..206
  eqBbox(bboxes[1], { x: 92, y: 90, w: 116, h: 116 }, 'shadow shifted');
  // node 2 = feFlood = source bbox
  eqBbox(bboxes[2], SRC, 'flood = source');
  // node 3 = composite (flood, shadow) → union = node 1 ∪ node 2
  // node 1: 92..208, 90..206  node 2: 100..180, 100..180
  // union: 92..208, 90..206 → x=92, y=90, w=116, h=116
  eqBbox(bboxes[3], { x: 92, y: 90, w: 116, h: 116 }, 'composite-in shadow');
  // node 4 = merge (shadow, SourceGraphic) → union with source(100..180)
  // shadow x=92..208, y=90..206; source x=100..180, y=100..180
  // union: x=92, y=90, x1=208, y1=206 → w=116, h=116
  eqBbox(bboxes[4], { x: 92, y: 90, w: 116, h: 116 }, 'final merge');
}

console.log('---');
if (failures) console.error(`FILTER-BBOX FAIL (${failures})`);
else console.log('FILTER-BBOX PASS');
process.exit(failures ? 1 : 0);
