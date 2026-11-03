// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterFrame.js -- the FILTER FRAME: a filtered draw that must see pixels beyond the canvas.
//
// A filter reads its SourceGraphic through a neighborhood (a blur's 3 sigma, an offset, a displacement,
// a kernel, a lighting Sobel). The pixels of the neighborhood that lie off the canvas are not transparent
// in the SVG model -- the shape continues -- so evaluating the filter on the canvas rectangle fades every
// filtered shape that crosses an edge (and, zoomed in, every filtered shape that is bigger than the view).
//
// So the filter runs in a bounded FRAME: the canvas plus a margin of `m` device pixels on every side, big enough to
// hold everything the filter can pull in from outside (the graph's reach), no bigger than the shape protrudes,
// and rounded up to a grid so a moving shape keeps its targets' size (frameMarginUp). The filtered draw runs in that frame as if it were the canvas: the viewport is (cw+2m) x
// (ch+2m) and the world matrix is compensated (the same device the viewport-window cache bake uses,
// cacheDraw.js), so the shape lands `m` pixels in. The result is composited back shifted by -m.
//
// This file is the pure part: the reach of a graph, the margin, and the matrix. No GL.

import { convolveReach } from '../filterGraph/bbox.js';

/// Slack on top of a primitive's stated reach: a bilinear tap, the AA ramp of the source's edge, and the box
/// passes a wide blur is built from (their weight past 3 sigma is under a level, but not zero).
export const FRAME_SLACK_PX = 2;

/// Hard default for the frame's area (pixels). A 4096 x 4096 frame is 64 MB of color + depth/stencil, which is
/// the most a single filtered draw may add to the renderer's working set before it degrades (see frameGeometry).
export const FRAME_MAX_PIXELS = 4096 * 4096;

// One primitive's own reach per axis: how far its output pixel reads from its input(s), in device pixels.
function ownReach(nd) {
  const p = nd.params || {};
  switch (nd.type) {
    case 'feGaussianBlur':
      return [Math.ceil(3 * Math.abs(p.sigmaX || 0)), Math.ceil(3 * Math.abs(p.sigmaY || 0))];
    case 'feMorphology':
      // Erode only shrinks, but it READS the radius all around each pixel.
      return [Math.ceil(Math.abs(p.radiusX || 0)), Math.ceil(Math.abs(p.radiusY || 0))];
    case 'feConvolveMatrix':
      return [convolveReach(p.orderX, p.targetX), convolveReach(p.orderY, p.targetY)];
    case 'feOffset':
      return [Math.ceil(Math.abs(p.dx || 0)), Math.ceil(Math.abs(p.dy || 0))];
    case 'feDisplacementMap': {
      const r = Math.ceil(Math.abs(p.scale || 0) / 2);
      return [r, r];
    }
    case 'feSpecularLighting':
    case 'feDiffuseLighting':
      return [1, 1];
    case 'feTile':
      return [Infinity, Infinity]; // repeats its input's whole rect across the region: reads from an unbounded distance
    default:
      return [0, 0]; // pointwise, or a generator
  }
}

/// How far, per axis, a graph pulls its SourceGraphic in from outside the pixels it outputs: the longest path from a source to
/// the root, summing each primitive's own reach. `graph` carries its spatial parameters in DEVICE PIXELS already (filterDraw.js
/// _pxGraph). Infinity = the primitive reads from an unbounded distance (feTile).
export function graphReach(graph) {
  const { gx, gy, root } = forward(graph);
  return graph.nodes.length ? { rx: gx[root], ry: gy[root] } : { rx: 0, ry: 0 };
}
function forward(graph) {
  const nodes = graph.nodes,
    n = nodes.length;
  const gx = new Array(n).fill(0),
    gy = new Array(n).fill(0);
  // The same growth with a blur counted to TAIL_SIGMAS sigma instead of 3: what a source STRICTLY INSIDE the canvas can put past the edge
  // before the kernel's tail is under 2/255 (the edge case of graphFrameNeed).
  const tx = new Array(n).fill(0),
    ty = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const [ox, oy] = ownReach(nodes[i]);
    const bl = nodes[i].type === 'feGaussianBlur';
    const p = nodes[i].params || {};
    const tox = bl ? Math.ceil(TAIL_SIGMAS * Math.abs(p.sigmaX || 0)) : ox,
      toy = bl ? Math.ceil(TAIL_SIGMAS * Math.abs(p.sigmaY || 0)) : oy;
    let ix = 0,
      iy = 0,
      jx = 0,
      jy = 0;
    for (const j of nodes[i].inputs || [])
      if (j >= 0 && j < i) {
        ix = Math.max(ix, gx[j]);
        iy = Math.max(iy, gy[j]);
        jx = Math.max(jx, tx[j]);
        jy = Math.max(jy, ty[j]);
      }
    gx[i] = ox + ix;
    gy[i] = oy + iy;
    tx[i] = tox + jx;
    ty[i] = toy + jy;
  }
  return { gx, gy, tx, ty, root: graph.rootOut >= 0 && graph.rootOut < n ? graph.rootOut : n - 1 };
}
/// On one axis, the reach of everything downstream of each node (`d`) and of the source (`src`): how far past the pixels the root outputs a value there can still reach them.
function downstream(nodes, root, axis) {
  const d = new Array(nodes.length).fill(0);
  let src = 0;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (i > root) continue;
    const above = d[i] + ownReach(nodes[i])[axis];
    for (const j of nodes[i].inputs || []) {
      if (j >= 0 && j < i) d[j] = Math.max(d[j], above);
      else if (j < 0) src = Math.max(src, above);
    }
  }
  return { d, src };
}
/// How far past the canvas each target of a graph can still matter, device px per axis: a node's value further out than the reach of what reads it never gets back to a
/// pixel of the canvas, and neither does the source's. A node's own target counts its own reach too: a blur's passes run in that target, and a later pass reads what an earlier one spread past the edge.
/// All zero for a pointwise graph. `graph` carries its parameters in device pixels (as graphReach).
export function graphSeenMargins(graph) {
  const nodes = graph.nodes,
    root = graph.rootOut >= 0 && graph.rootOut < nodes.length ? graph.rootOut : nodes.length - 1;
  const X = downstream(nodes, root, 0),
    Y = downstream(nodes, root, 1);
  return {
    x: X.d.map((v, i) => v + ownReach(nodes[i])[0]),
    y: Y.d.map((v, i) => v + ownReach(nodes[i])[1]),
    srcX: X.src,
    srcY: Y.src,
  };
}
/// A Gaussian's mass beyond 2.4 sigma is 0.8% (under 2/255 of a level): a source that stops short of the edge by more than that never
/// shows the difference between a frame and the canvas, so it does not get a frame (the draw stays byte-identical to the unframed one).
export const TAIL_SIGMAS = 2.4;

/// The margin (device px past the canvas edge) a graph needs for a source that extends `protrusion` px past that edge. `protrusion` is
/// SIGNED: a source that stops `d` px short of the edge is protrusion -d, and a primitive that grows it (a blur) can still reach the edge
/// and past it (so a later offset or blur reads that growth back onto the canvas); a source that never gets there asks for nothing.
///
/// Not simply min(reach, protrusion): a node's output can reach past the SOURCE (a blur grows its input), and a later primitive
/// (an offset) can bring that grown part back onto the canvas. Node i must be known out to D_i past the edge, where D_i is the
/// reach of everything downstream of it (backward, from the root), but it has no content past protrusion + G_i, where G_i is how
/// far the nodes up to and including i grow the source (forward). The frame needs max over the source and every node of
/// min(D_i, protrusion + G_i). For a single blur that is min(reach, protrusion), the simple rule.
export function graphFrameNeed(graph, protrusion) {
  const nodes = graph.nodes,
    n = nodes.length;
  if (!n) return 0;
  const { gx, gy, tx, ty, root } = forward(graph);
  let need = 0;
  for (let axis = 0; axis < 2; axis++) {
    const g = axis ? gy : gx,
      gt = axis ? ty : tx;
    const { d, src } = downstream(nodes, root, axis);
    need = Math.max(need, Math.min(src, Math.max(0, protrusion)));
    // protrusion >= 0: the source itself goes past the edge, growth counts in full (3 sigma). < 0: only the kernel tail that matters.
    for (let i = 0; i <= root; i++)
      need = Math.max(
        need,
        Math.min(d[i], Math.max(0, protrusion + (protrusion >= 0 ? g[i] : gt[i]))),
      );
  }
  return need;
}

/// The reach of a single-kind filter record (kind 1 blur, 5 morphology, 6 convolve) in device pixels. `pxX`/`pxY`
/// are the em -> device scales. Mirrors the sizes filterDraw.js _filterSingleKindRect pads its RT by.
export function singleKindReach(f, pxX, pxY) {
  if (f.kind === 1)
    return {
      rx: Math.ceil(3 * Math.abs(f.sigmaX * pxX)),
      ry: Math.ceil(3 * Math.abs(f.sigmaY * pxY)),
    };
  if (f.kind === 5)
    return { rx: Math.ceil(Math.abs(f.sigmaX * pxX)), ry: Math.ceil(Math.abs(f.sigmaY * pxY)) };
  if (f.kind === 6) return { rx: Math.max(f.orderX | 0, 1), ry: Math.max(f.orderY | 0, 1) };
  return { rx: 0, ry: 0 };
}

/// The geometry of a filtered draw's frame, or null for none (no margin is needed).
///
///   need        the margin the filter wants past the canvas edge, device px (graphFrameNeed, or a single kind's min(reach,
///               protrusion)); the slack for the AA ramp and the taps is added here
///   cw, ch      the canvas
///   maxDim      the largest RT side the device allows
///   maxPixels   the frame's area budget
///
/// The frame holds the canvas plus a margin on every side. Normally one frame pixel is one canvas pixel (s = 1) and the
/// filter's answer is exact. When the margin the filter wants does not fit the budget (a blur whose sigma is a million
/// pixels wide), the frame is evaluated at 1/s resolution instead: s is the smallest power of two for which it fits, and
/// the result is scaled back up by the composite. That is the graceful degrade: a kernel that wide is smooth at any
/// resolution, so the answer stays right where truncating the margin (fading it out farther out) would not.
///
/// Fields: `s` canvas pixels per frame pixel; `m` the margin in FRAME pixels (even, so every RT origin stays even, the
/// derivative-quad rule of filterDraw.js _bboxToRect); `Mc` = m * s, the margin in canvas pixels; `W`,`H` the frame's size
/// in frame pixels; `wanted` the margin asked for, in canvas pixels; `degraded` s > 1.
export function frameGeometry({ need, cw, ch, maxDim, maxPixels = FRAME_MAX_PIXELS }) {
  if (!(need > 0)) return null;
  const want = need + FRAME_SLACK_PX;
  const budget = Math.max(maxPixels, 2 * cw * ch); // a canvas bigger than the budget is its own budget
  for (let s = 1; s <= 2 ** 30; s *= 2) {
    const exact = evenUp(want / s),
      a = Math.ceil(cw / s),
      b = Math.ceil(ch / s);
    if (fits(a, b, exact, maxDim, budget)) {
      // A degraded frame keeps the exact margin: its kernel spans hundreds of frame pixels and its smooth result, in 8 bits, moves contour bands over nearly every pixel when the frame's size moves.
      const m =
        s > 1
          ? exact
          : Math.min(frameMarginUp(exact, a, b), largestFit(a, b, exact, maxDim, budget));
      return {
        s,
        m,
        Mc: m * s,
        W: a + 2 * m,
        H: b + 2 * m,
        wanted: Math.ceil(want),
        degraded: s > 1,
        cw,
        ch,
        key: m * s + 'x' + s,
      };
    }
  }
  return null;
}
const evenUp = (v) => {
  const c = Math.max(1, Math.ceil(v));
  return c + (c & 1);
};
const fits = (a, b, m, maxDim, budget) =>
  a + 2 * m <= maxDim && b + 2 * m <= maxDim && (a + 2 * m) * (b + 2 * m) <= budget;

/// The margin's grid. A frame's size is its targets' size, and the margin the filter wants follows the shape, so an exact margin would ask for new targets on nearly every frame of a pan or a zoom.
/// The margin is rounded up to the next value of this grid: multiples of a step of FRAME_MARGIN_Q, or an eighth of the canvas's short side where that is less (a smaller canvas spends less on its frame),
/// then eight steps per octave, so a zoom crosses a logarithmic number of sizes. The steps are powers of two, so the margin stays even. A larger margin only shows the filter more of the shape.
export const FRAME_MARGIN_Q = 64;
export function frameMarginUp(m, cw = Infinity, ch = Infinity) {
  const near = Math.min(
    FRAME_MARGIN_Q,
    Math.max(2, 2 ** Math.floor(Math.log2(Math.min(cw, ch) / 8))),
  );
  const step = Math.max(near, 2 ** (Math.floor(Math.log2(m)) - 3));
  return Math.ceil(m / step) * step;
}
/// The largest even margin that fits, at least `least` (which fits). It depends only on the frame's limits, so a margin capped here is as steady as one on the grid.
function largestFit(a, b, least, maxDim, budget) {
  let m =
    Math.floor(
      Math.min(maxDim - a, maxDim - b, (Math.sqrt((a - b) * (a - b) + 4 * budget) - a - b) / 2) / 4,
    ) * 2;
  while (m > least && !fits(a, b, m, maxDim, budget)) m -= 2;
  return Math.max(m, least);
}

/// The world matrix (column-major mat3, as R.draw.worldM) that lays the canvas's content into the frame: canvas pixel p
/// lands at frame pixel (p + Mc) / s. `arC` / `arF` are arScale() of the bundle's box at the canvas and at the frame (the
/// aspect fit differs between them). Same algebra as the viewport-window bake (cacheDraw.js), plus the translation a
/// non-centered frame needs.
export function frameWorldMatrix(world, arC, arF, fr) {
  const dx = fr.cw / (fr.s * fr.W),
    dy = fr.ch / (fr.s * fr.H);
  const tx = (fr.cw + 2 * fr.Mc) / (fr.s * fr.W) - 1,
    ty = (fr.ch + 2 * fr.Mc) / (fr.s * fr.H) - 1;
  const qx = arF[0] ? arC[0] / arF[0] : 1,
    qy = arF[1] ? arC[1] / arF[1] : 1;
  const m = world || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return new Float32Array([
    qx * (dx * m[0] + tx * m[2]),
    qx * (dy * m[1] + ty * m[2]),
    qx * m[2],
    qy * (dx * m[3] + tx * m[5]),
    qy * (dy * m[4] + ty * m[5]),
    qy * m[5],
    dx * m[6] + tx * m[8],
    dy * m[7] + ty * m[8],
    m[8],
  ]);
}
