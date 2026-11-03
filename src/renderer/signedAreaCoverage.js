// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// signedAreaCoverage.js — exact signed-area coverage (parallel build).
//
// The foundation of the signed-area fill path that is intended, over time, to
// replace the per-primitive analytic coverage (slugCov + the kind-9/10/11 exterior-
// band machinery + the multi-feature-pixel Slug fallback). Per-primitive coverage
// sums each edge's clamped alpha independently, so multiple features in one pixel
// double-count / seam (conflation). Signed-area coverage instead accumulates each
// edge's SIGNED, UNCLAMPED area contribution and applies the winding rule ONCE,
// after accumulation — exact for N features per pixel of one fill, no fallback.
//
// This module is the CPU reference + executable spec for the eventual GPU fragment
// path. It is NOT yet wired into the renderer — it is a parallel
// build validated against ground truth (see test/signedAreaCoverageSmoke.mjs).
//
// Algorithm (AGG / libart / font-rs single-buffer accumulate): each polygon edge is
// subdivided at every integer cell boundary so each sub-segment lies within one
// pixel cell; the sub-segment deposits its signed vertical extent `dy` split by its
// horizontal midpoint into two adjacent cells (`dy*(1-xmid)` here, `dy*xmid` next).
// A horizontal prefix-sum per row then propagates the full `dy` to every cell to the
// right (the "cover"), and combining it with the in-cell area gives the exact signed
// covered-area per pixel. The fill rule is applied last: nonzero → clamp(|sum|),
// even-odd → triangle-wave fold. Curves extend this by replacing the straight
// sub-segment area with the closed-form ∫x dy of the (rational) Bézier arc clipped
// to the cell (Manson–Schaefer polynomial filters; the SIGGRAPH 2024/2025 GWN work
// for rationals) — the rational-arc case is deferred to a later stage.

// Each accumulate* routine reports its cell deposits through `emit(row,col,dy,local)`
// (dy = signed vertical extent, local = dy-weighted mean x within the cell). The
// scanline renderer's emit deposits into the grid; the per-pixel FRAGMENT emit
// (coverageAtPixel) sums only the contributions at-or-left-of the target pixel — the
// two are the same signed sum, reordered. So the fragment logic is validated by the
// scanline: see test/signedAreaCoverageSmoke.mjs (fragment ≡ scanline check).

// Accumulate one straight edge (x0,y0)→(x1,y1), pixel space, via emit.
function accumulateEdge(emit, W, H, x0, y0, x1, y1) {
  if (y0 === y1) return; // horizontal edges carry no winding
  let wind = 1;
  if (y0 > y1) {
    let t = x0;
    x0 = x1;
    x1 = t;
    t = y0;
    y0 = y1;
    y1 = t;
    wind = -1;
  } // make y0<y1
  const dxdy = (x1 - x0) / (y1 - y0);

  const yA = Math.max(y0, 0),
    yB = Math.min(y1, H);
  if (yA >= yB) return;

  // Walk each pixel ROW the edge crosses.
  for (let row = Math.floor(yA); row < yB; row++) {
    const ytop = Math.max(yA, row),
      ybot = Math.min(yB, row + 1);
    if (ytop >= ybot) continue;
    let xa = x0 + (ytop - y0) * dxdy,
      xb = x0 + (ybot - y0) * dxdy; // edge x at row top/bot
    // Within this row, walk the pixel COLUMNS the segment (xa,ytop)→(xb,ybot) crosses,
    // clipping at integer x so each piece lies in one cell.
    const yaL = ytop - row,
      ybL = ybot - row; // local y in [0,1]
    let cy0 = yaL,
      cy1 = ybL,
      cx0 = xa,
      cx1 = xb; // current sub-piece endpoints
    // order by x for the column walk
    const ascending = cx0 <= cx1;
    let lo = Math.min(cx0, cx1),
      hi = Math.max(cx0, cx1);
    const dydx = (cy1 - cy0) / (cx1 - cx0 || 1e-30);
    let col = Math.floor(lo);
    // Degenerate (near-vertical) column: whole row-piece in one cell.
    if (hi - lo < 1e-12) {
      const flc = Math.floor(cx0);
      emit(row, flc, (ybL - yaL) * wind, cx0 - flc);
      continue;
    }
    let x = lo;
    while (x < hi - 1e-15) {
      const xNext = Math.min(hi, col + 1);
      // y at x and xNext along the segment (x increasing)
      const yAtX = cy0Slope(cx0, cy0, dydx, x);
      const yAtN = cy0Slope(cx0, cy0, dydx, xNext);
      const dyLocal = yAtN - yAtX; // local vertical extent in this cell (signed by x-dir)
      // map back to the true vertical direction (top→bottom is +): the segment goes
      // ytop→ybot as x goes xa→xb; if ascending, x increases with the segment param.
      const dvert = ascending ? dyLocal : -dyLocal; // vertical extent contributed (local units)
      const xmid = (x + xNext) * 0.5 - col; // midpoint local x in [0,1]
      emit(row, col, dvert * wind, xmid);
      col++;
      x = xNext;
    }
  }
}
// y along a segment at a given x (linear).
function cy0Slope(x0, y0, dydx, x) {
  return y0 + (x - x0) * dydx;
}
// Grid-deposit emit: dy split by local x into this cell and the next, so the row
// prefix-sum propagates the full cover to the right.
function makeDeposit(acc, W, H) {
  return (row, col, dy, local) => {
    if (row < 0 || row >= H) return;
    if (col < 0) {
      acc[row * W + 0] += dy;
      return;
    } // left of grid → full cover from col 0
    if (col >= W) return; // right of grid → invisible
    acc[row * W + col] += dy * (1 - local);
    if (col + 1 < W) acc[row * W + col + 1] += dy * local;
  };
}

function cellSplits(X, Y, crit) {
  const ts = [0, ...crit.filter((t) => t > 0 && t < 1).sort((p, q) => p - q), 1],
    out = [0];
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i],
      b = ts[i + 1];
    if (!(b > a)) continue;
    const cuts = [];
    for (const F of [X, Y]) {
      const fa = F(a),
        fb = F(b),
        inc = fb > fa,
        lo = Math.min(fa, fb),
        hi = Math.max(fa, fb);
      for (let k = Math.floor(lo) + 1; k < hi; k++) {
        let l = a,
          h = b;
        for (let it = 0; it < 80; it++) {
          const m = 0.5 * (l + h);
          if (m <= l || m >= h) break;
          if (F(m) < k === inc) l = m;
          else h = m;
        }
        cuts.push(0.5 * (l + h));
      }
    }
    cuts.sort((p, q) => p - q);
    for (const c of cuts) out.push(c);
    out.push(b);
  }
  return out;
}
// The real roots of q2 t^2 + q1 t + q0 (the stable form; a linear or constant one has at most one / none).
function quadRoots(q2, q1, q0) {
  if (q2 === 0) return q1 !== 0 ? [-q0 / q1] : [];
  const d = q1 * q1 - 4 * q2 * q0;
  if (d < 0) return [];
  const q = -0.5 * (q1 + (q1 >= 0 ? 1 : -1) * Math.sqrt(d));
  return q !== 0 ? [q / q2, q0 / q] : [-q1 / (2 * q2)];
}
// Deposit the pieces: each lies in one cell and carries its signed dy split by the dy-weighted mean x, ∫x·y′dt / dy
// (F is that antiderivative, exact for a polynomial).
function emitPieces(emit, X, Y, F, ts) {
  for (let i = 0; i + 1 < ts.length; i++) {
    const ta = ts[i],
      tb = ts[i + 1];
    if (!(tb > ta)) continue;
    const dy = Y(tb) - Y(ta);
    if (dy === 0) continue; // a flat piece: no winding and no area
    const tm = (ta + tb) * 0.5,
      row = Math.floor(Y(tm)),
      col = Math.floor(X(tm));
    emit(row, col, dy, (F(tb) - F(ta)) / dy - col);
  }
}

// Accumulate one QUADRATIC Bézier arc P0→P1→P2 (pixel space) through `emit` — the CLOSED-FORM (no-flatten) curve
// contribution: split into one-cell pieces (THE CELL SPLIT), each depositing its exact signed dy at its dy-weighted
// mean x, the curve generalization of the line midpoint. Polynomial → exact closed form.
function accumulateQuadArc(emit, W, H, P0, P1, P2) {
  const ax = P0[0] - 2 * P1[0] + P2[0],
    bx = 2 * (P1[0] - P0[0]),
    cx = P0[0];
  const ay = P0[1] - 2 * P1[1] + P2[1],
    by = 2 * (P1[1] - P0[1]),
    cy = P0[1];
  const X = (t) => (ax * t + bx) * t + cx,
    Y = (t) => (ay * t + by) * t + cy;
  // F(t) = ∫ x(t)·y′(t) dt (y′ = 2ay t + by); antiderivative of a cubic.
  const c3 = 2 * ax * ay,
    c2 = ax * by + 2 * bx * ay,
    c1 = bx * by + 2 * cx * ay,
    c0 = cx * by;
  const F = (t) => (((c3 / 4) * t + c2 / 3) * t + c1 / 2) * t * t + c0 * t; // ∫₀ᵗ x y′
  const crit = [...quadRoots(0, 2 * ax, bx), ...quadRoots(0, 2 * ay, by)]; // x' = 2ax t + bx, y' likewise
  emitPieces(emit, X, Y, F, cellSplits(X, Y, crit));
}

// Accumulate one CUBIC Bézier arc P0..P3 (pixel space) through `emit` — closed-form, no flatten, as the quadratic:
// one-cell pieces (THE CELL SPLIT; x' and y' are quadratics), each depositing its signed dy at the dy-weighted mean x
// = ∫x·y′dt / dy (x·y′ is degree 5 → its antiderivative is degree 6, exact).
function accumulateCubicArc(emit, W, H, P0, P1, P2, P3) {
  // power-basis coeffs per axis: c3 t³ + c2 t² + c1 t + c0
  const co = (p0, p1, p2, p3) => [
    -p0 + 3 * p1 - 3 * p2 + p3,
    3 * p0 - 6 * p1 + 3 * p2,
    -3 * p0 + 3 * p1,
    p0,
  ];
  const [ax3, ax2, ax1, ax0] = co(P0[0], P1[0], P2[0], P3[0]);
  const [ay3, ay2, ay1, ay0] = co(P0[1], P1[1], P2[1], P3[1]);
  const X = (t) => ((ax3 * t + ax2) * t + ax1) * t + ax0,
    Y = (t) => ((ay3 * t + ay2) * t + ay1) * t + ay0;
  // p(t) = x(t)·y′(t), y′ = 3ay3 t² + 2ay2 t + ay1 → degree-5 product; F = ∫p.
  const prod = new Array(6).fill(0);
  const xp = [ax3, ax2, ax1, ax0]; // coeffs of t^3,t^2,t^1,t^0
  const ypw = [3 * ay3, 2 * ay2, ay1]; // y′ coeffs of t^2,t^1,t^0
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) {
      const pw = 3 - i + (2 - j);
      prod[pw] += xp[i] * ypw[j];
    }
  // prod[k] = coeff of t^k, k=0..5. F(t)=Σ prod[k]/(k+1) t^(k+1).
  const F = (t) => {
    let s = 0;
    for (let k = 5; k >= 0; k--) s = s * t + prod[k] / (k + 1);
    return s * t;
  };
  const crit = [...quadRoots(3 * ax3, 2 * ax2, ax1), ...quadRoots(3 * ay3, 2 * ay2, ay1)];
  emitPieces(emit, X, Y, F, cellSplits(X, Y, crit));
}

/**
 * Exact signed-area coverage of a set of polygon contours.
 *   @param contours  Array<Array<[x,y]>> — closed contours in PIXEL space
 *   @param W,H       grid size
 *   @param evenOdd   fill rule (default nonzero)
 *   @returns Float32Array(W*H) coverage in [0,1]
 */
export function signedAreaCoverage(contours, W, H, evenOdd = false) {
  const acc = new Float64Array(W * H);
  const emit = makeDeposit(acc, W, H);
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i],
        b = c[(i + 1) % c.length];
      accumulateEdge(emit, W, H, a[0], a[1], b[0], b[1]);
    }
  }
  return resolve(acc, W, H, evenOdd);
}

// Feed every segment's deposits to `emit`. Shared by the scanline renderer and the
// per-pixel fragment (coverageAtPixel).
function emitSegs(segs, emit, W, H) {
  for (const s of segs) {
    if (s.type === 'quad') accumulateQuadArc(emit, W, H, s.P0, s.P1, s.P2);
    else if (s.type === 'cubic') accumulateCubicArc(emit, W, H, s.P0, s.P1, s.P2, s.P3);
    else accumulateEdge(emit, W, H, s.a[0], s.a[1], s.b[0], s.b[1]);
  }
}

/**
 * Coverage of ONE pixel (px,py) computed independently — the FRAGMENT-shader logic.
 * Sums each segment's contribution at-or-left-of the pixel (the reordered row prefix-
 * sum): a cell strictly left of px contributes its full dy, the cell AT px contributes
 * dy·(1−local). Conflation-free (signed sum before the fold), no-flatten. Validated to
 * reproduce the scanline `signedAreaCoverageSegs` exactly (the GPU translation target).
 */
export function coverageAtPixel(segs, W, H, px, py, evenOdd = false) {
  let run = 0;
  const emit = (row, col, dy, local) => {
    if (row !== py) return;
    if (col < px)
      run += dy; // strictly left (incl. col<0 full-cover) → full dy
    else if (col === px) run += dy * (1 - local);
  };
  emitSegs(segs, emit, W, H);
  if (evenOdd) {
    let m = run % 2;
    if (m < 0) m += 2;
    const c = m <= 1 ? m : 2 - m;
    return c;
  }
  return Math.min(Math.abs(run), 1);
}

// Prefix-sum each row and apply the fill rule (shared by the line + curve entries).
function resolve(acc, W, H, evenOdd) {
  const cov = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      run += acc[y * W + x];
      let c;
      if (evenOdd) {
        let m = run % 2;
        if (m < 0) m += 2;
        c = m <= 1 ? m : 2 - m;
      } // triangle wave: 0→0,1→1,2→0
      else c = Math.min(Math.abs(run), 1); // nonzero
      cov[y * W + x] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
  }
  return cov;
}

/**
 * Signed-area coverage of a CURVED contour — the no-flatten curve case. Segments are
 * {type:'line', a:[x,y], b:[x,y]} or {type:'quad', P0,P1,P2} in pixel space; the arc
 * contribution is closed-form (accumulateQuadArc), so coverage is resolution-
 * independent (exact at any zoom, no re-flattening).
 *   @returns Float32Array(W*H) coverage in [0,1]
 */
export function signedAreaCoverageSegs(segs, W, H, evenOdd = false) {
  const acc = new Float64Array(W * H);
  emitSegs(segs, makeDeposit(acc, W, H), W, H);
  return resolve(acc, W, H, evenOdd);
}
