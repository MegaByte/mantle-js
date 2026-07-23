// windingTree.js — a hierarchical run tree over a contour-ordered segment list, turning
// O(N)-per-query winding probes into O(log N + near). Pure JS/f64, no GL, no module state.
//
// The far-field identity (same as the GWN fill kernel's, in ray-crossing form): for a query
// point OUTSIDE a node's bounding circle, the signed +x-ray crossings of the node's whole
// contiguous run equal those of its CHORD — the closed loop (run + reversed chord) lies
// inside the circle, the point is outside it, so the loop winds it zero times. Per-contour
// subtrees keep runs contiguous (a chord straddling two contours has no such identity);
// synthetic container nodes above the contour roots carry a DEGENERATE chord (s == e) whose
// crossing is zero — correct, because a far point's winding from entirely-contained CLOSED
// contours is zero.
//
// Exactness: near segments are evaluated by the CALLER's own per-segment crossing routine
// (the same exact solvers the linear walk uses), so results are identical to the linear
// walk — the tree only decides which segments are evaluated exactly and which collapse to
// chords. Consumers: the CDT builder's inkAt probes (previously O(N) rayWinding per probe,
// O(N^2) per build on curved shapes) and the hit-test point-in-fill / stroke-band pruning.
//
// API is representation-agnostic: build(n, api) with
//   api.start(i) -> [x, y]      segment start point
//   api.end(i)   -> [x, y]      segment end point
//   api.bbox(i)  -> [x0,y0,x1,y1]  a bound containing the whole segment
//   api.cross(i, x, yr) -> signed +x-ray crossings of segment i at ray height yr
// treeWinding then returns the exact net signed crossing count (nonzero: != 0;
// even-odd: & 1 — crossing-count parity equals net-signed parity, each crossing is ±1).

const LEAF_MAX = 4;

export function buildWindingTree(n, api) {
  if (n <= 0) return null;
  // contour ranges from endpoint continuity (closed contours share exact floats)
  const starts = [];
  {
    let s0 = 0;
    for (let k = 1; k < n; k++) {
      const e = api.end(k - 1), b = api.start(k);
      if (e[0] !== b[0] || e[1] !== b[1]) { starts.push(s0); s0 = k; }
    }
    starts.push(s0);
  }
  // nodes as parallel flat arrays: chord (sx, sy, ex, ey), circle (cx, cy, r),
  // code (>= 0: left * 2^20 + right; < 0: leaf, -(refStart * 64 + count + 1)).
  const sx = [], sy = [], ex = [], ey = [], cx = [], cy = [], cr = [], code = [];
  const refs = [];
  const build = (i, j) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = i; k < j; k++) {
      const bb = api.bbox(k);
      if (bb[0] < x0) x0 = bb[0]; if (bb[1] < y0) y0 = bb[1];
      if (bb[2] > x1) x1 = bb[2]; if (bb[3] > y1) y1 = bb[3];
    }
    const s = api.start(i), e = api.end(j - 1);
    const idx = sx.length;
    sx.push(s[0]); sy.push(s[1]); ex.push(e[0]); ey.push(e[1]);
    cx.push((x0 + x1) / 2); cy.push((y0 + y1) / 2);
    cr.push(Math.hypot(x1 - x0, y1 - y0) / 2);
    code.push(0);
    if (j - i <= LEAF_MAX) {
      code[idx] = -(refs.length * 64 + (j - i) + 1);
      for (let k = i; k < j; k++) refs.push(k);
    } else {
      const mid = (i + j) >> 1;
      const l = build(i, mid), r = build(mid, j);
      code[idx] = l * 1048576 + r;
    }
    return idx;
  };
  let roots = starts.map((s, ci) => build(s, ci + 1 < starts.length ? starts[ci + 1] : n));
  while (roots.length > 1) {
    const next = [];
    for (let k = 0; k + 1 < roots.length; k += 2) {
      const a = roots[k], b = roots[k + 1];
      const mx = (cx[a] + cx[b]) / 2, my = (cy[a] + cy[b]) / 2;
      const r = Math.max(Math.hypot(cx[a] - mx, cy[a] - my) + cr[a],
                         Math.hypot(cx[b] - mx, cy[b] - my) + cr[b]);
      const idx = sx.length;
      sx.push(mx); sy.push(my); ex.push(mx); ey.push(my);   // degenerate chord
      cx.push(mx); cy.push(my); cr.push(r);
      code.push(a * 1048576 + b);
      next.push(idx);
    }
    if (roots.length & 1) next.push(roots[roots.length - 1]);
    roots = next;
  }
  return {
    root: roots[0], api,
    sx: Float64Array.from(sx), sy: Float64Array.from(sy),
    ex: Float64Array.from(ex), ey: Float64Array.from(ey),
    cx: Float64Array.from(cx), cy: Float64Array.from(cy),
    cr: Float64Array.from(cr),
    code: Float64Array.from(code),
    refs: Int32Array.from(refs),
    stack: new Int32Array(64),
  };
}

/** Exact net signed +x-ray crossings at (x, yr) — identical to the linear walk. */
export function treeWinding(tree, x, yr) {
  const { sx, sy, ex, ey, cx, cy, cr, code, refs, stack, api } = tree;
  let w = 0, sp = 0;
  stack[sp++] = tree.root;
  while (sp > 0) {
    const ni = stack[--sp];
    const dx = x - cx[ni], dy = yr - cy[ni], r = cr[ni];
    if (dx * dx + dy * dy > r * r) {
      // FAR: the chord's crossing IS the run's net crossing (winding-of-outside-point).
      const y0 = sy[ni], y1 = ey[ni];
      if ((y0 > yr) !== (y1 > yr)) {
        const xc = sx[ni] + (yr - y0) / (y1 - y0) * (ex[ni] - sx[ni]);
        if (xc > x) w += y1 > y0 ? 1 : -1;
      }
      continue;
    }
    const c = code[ni];
    if (c < 0) {
      const v = -c - 1;
      const cnt = v % 64, rs = (v - cnt) / 64;
      for (let k = 0; k < cnt; k++) w += api.cross(refs[rs + k], x, yr);
    } else if (sp < 62) {
      const l = Math.floor(c / 1048576);
      stack[sp++] = l;
      stack[sp++] = c - l * 1048576;
    }
  }
  return w;
}

/** Indices of segments whose bounding circle comes within `r` of (x, y) — the stroke-band
 *  pruner (join/cap reach must be folded into r by the caller). Preserves segment order. */
export function treeCollectNear(tree, x, y, r, out) {
  const { cx, cy, cr, code, refs, stack } = tree;
  out.length = 0;
  let sp = 0;
  stack[sp++] = tree.root;
  while (sp > 0) {
    const ni = stack[--sp];
    const dx = x - cx[ni], dy = y - cy[ni], rr = cr[ni] + r;
    if (dx * dx + dy * dy > rr * rr) continue;
    const c = code[ni];
    if (c < 0) {
      const v = -c - 1;
      const cnt = v % 64, rs = (v - cnt) / 64;
      for (let k = 0; k < cnt; k++) out.push(refs[rs + k]);
    } else if (sp < 62) {
      const l = Math.floor(c / 1048576);
      // push right first so leaves emerge in contour order (left popped first)
      stack[sp++] = c - l * 1048576;
      stack[sp++] = l;
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
