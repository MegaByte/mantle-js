// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// meshFreeRaster.js — production CPU rasterizer for the mesh-free signed-area fill,
// and the exact CPU TWIN of the GPU fragment shader.
//
// One algorithm for every curve degree — so CPU and GPU agree by construction (parity),
// and rational quads stay exact conics (NO degree elevation): each segment is split
// into y-monotonic pieces, and a pixel's coverage is the winding-folded sum over pieces
// of the per-pixel signed-area contribution
//     ∫_{y(t)∈[py,py+1]} clamp(px+1 − x(t), 0, 1) · y′(t) dt
// found by (a) bisection band-find of t at y=py and y=py+1 on the seg's NATIVE
// evaluator, then (b) Gauss-style midpoint quadrature over the band. Conflation-free
// (signed sum before the fold), no-flatten (evaluated from the exact curve), no mesh.
//
// Segment types (as the renderer/importer produce them):
//   { type:'line',  a:[x,y], b:[x,y] }
//   { type:'quad',  P0,P1,P2 }
//   { type:'rquad', P0,P1,P2, w }     // exact conic (arcs); w = weight of P1
//   { type:'cubic', P0,P1,P2,P3 }

const QUAD_M = 8; // band quadrature samples (matches the shader; sub-1/255 at pixel scale)

// ---- native evaluators --------------------------------------------------------
function evalAt(s, t) {
  const u = 1 - t;
  switch (s.type) {
    case 'cubic':
      return [
        u * u * u * s.P0[0] +
          3 * u * u * t * s.P1[0] +
          3 * u * t * t * s.P2[0] +
          t * t * t * s.P3[0],
        u * u * u * s.P0[1] +
          3 * u * u * t * s.P1[1] +
          3 * u * t * t * s.P2[1] +
          t * t * t * s.P3[1],
      ];
    case 'rquad': {
      const w = s.w,
        b0 = u * u,
        b1 = 2 * u * t * w,
        b2 = t * t,
        d = b0 + b1 + b2;
      return [
        (b0 * s.P0[0] + b1 * s.P1[0] + b2 * s.P2[0]) / d,
        (b0 * s.P0[1] + b1 * s.P1[1] + b2 * s.P2[1]) / d,
      ];
    }
    case 'quad':
      return [
        u * u * s.P0[0] + 2 * u * t * s.P1[0] + t * t * s.P2[0],
        u * u * s.P0[1] + 2 * u * t * s.P1[1] + t * t * s.P2[1],
      ];
    default:
      return [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
  }
}

// ---- split a segment into y-monotonic pieces (native, exact) -------------------
function lerp(a, b, t) {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
function splitAt(s, t) {
  switch (s.type) {
    case 'cubic': {
      const ab = lerp(s.P0, s.P1, t),
        bc = lerp(s.P1, s.P2, t),
        cd = lerp(s.P2, s.P3, t),
        abc = lerp(ab, bc, t),
        bcd = lerp(bc, cd, t),
        m = lerp(abc, bcd, t);
      return [
        { type: 'cubic', P0: s.P0, P1: ab, P2: abc, P3: m },
        { type: 'cubic', P0: m, P1: bcd, P2: cd, P3: s.P3 },
      ];
    }
    case 'rquad': {
      // homogeneous de Casteljau (weights [1, w, 1]) → exact conic split
      const w = s.w,
        h0 = [s.P0[0], s.P0[1], 1],
        h1 = [s.P1[0] * w, s.P1[1] * w, w],
        h2 = [s.P2[0], s.P2[1], 1];
      const HL = (a, b) => [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
      ];
      const a = HL(h0, h1),
        b = HL(h1, h2),
        m = HL(a, b),
        de = (h) => [h[0] / h[2], h[1] / h[2]];
      const wl = a[2] / Math.sqrt(h0[2] * m[2]),
        wr = b[2] / Math.sqrt(m[2] * h2[2]);
      return [
        { type: 'rquad', w: wl, P0: de(h0), P1: de(a), P2: de(m) },
        { type: 'rquad', w: wr, P0: de(m), P1: de(b), P2: de(h2) },
      ];
    }
    case 'quad': {
      const ab = lerp(s.P0, s.P1, t),
        bc = lerp(s.P1, s.P2, t),
        m = lerp(ab, bc, t);
      return [
        { type: 'quad', P0: s.P0, P1: ab, P2: m },
        { type: 'quad', P0: m, P1: bc, P2: s.P2 },
      ];
    }
    default: {
      const m = lerp(s.a, s.b, t);
      return [
        { type: 'line', a: s.a, b: m },
        { type: 'line', a: m, b: s.b },
      ];
    }
  }
}
// y-extrema by sampling the y′ sign (native, degree-agnostic — robust for rationals too).
function toYMonotone(s, out) {
  const D = 48;
  let prev = evalAt(s, 0)[1],
    sign = 0;
  const ts = [];
  for (let i = 1; i <= D; i++) {
    const y = evalAt(s, i / D)[1],
      d = y - prev;
    if (d !== 0) {
      const sg = d > 0 ? 1 : -1;
      if (sign !== 0 && sg !== sign) ts.push((i - 0.5) / D);
      sign = sg;
    }
    prev = y;
  }
  let cur = s,
    base = 0;
  for (const t of ts) {
    const lt = (t - base) / (1 - base);
    const [l, r] = splitAt(cur, lt);
    out.push(l);
    cur = r;
    base = t;
  }
  out.push(cur);
}

// ---- per-pixel signed-area contribution of a y-monotonic segment --------------
function bandT(s, Y, inc) {
  // bisection: t where y(t)=Y on a y-monotonic seg
  let a = 0,
    b = 1;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) * 0.5;
    if (evalAt(s, m)[1] < Y === inc) a = m;
    else b = m;
  }
  return (a + b) * 0.5;
}
function segContrib(s, px, py) {
  const y0 = evalAt(s, 0)[1],
    y1 = evalAt(s, 1)[1];
  const ymin = Math.min(y0, y1),
    ymax = Math.max(y0, y1);
  const lo = Math.max(py, ymin),
    hi = Math.min(py + 1, ymax);
  if (hi <= lo) return 0;
  const inc = y1 > y0;
  const tA = bandT(s, lo, inc),
    tB = bandT(s, hi, inc);
  const tlo = Math.min(tA, tB),
    thi = Math.max(tA, tB),
    dt = (thi - tlo) / QUAD_M;
  let sum = 0;
  for (let i = 0; i < QUAD_M; i++) {
    const t = tlo + dt * (i + 0.5),
      p = evalAt(s, t);
    const e = 1e-4,
      ta2 = Math.min(t + e, 1),
      tb2 = Math.max(t - e, 0);
    const yp = (evalAt(s, ta2)[1] - evalAt(s, tb2)[1]) / (ta2 - tb2); // y′(t)
    sum += Math.min(Math.max(px + 1 - p[0], 0), 1) * yp * dt;
  }
  return sum;
}

const fold = (run, evenOdd) => {
  if (!evenOdd) return Math.min(Math.abs(run), 1);
  let m = run % 2;
  if (m < 0) m += 2;
  const c = m <= 1 ? m : 2 - m;
  return c < 0 ? 0 : c > 1 ? 1 : c;
};

/**
 * Coverage of ONE pixel — the fragment-shader logic (each pixel independent).
 * @param mono  y-monotonic segments (from prepareSegments)
 */
export function coverageAt(mono, px, py, evenOdd = false) {
  let run = 0;
  for (const s of mono) run += segContrib(s, px, py);
  return fold(run, evenOdd);
}

/** Split arbitrary segments into y-monotonic pieces (do once per shape). */
export function prepareSegments(segs) {
  const out = [];
  for (const s of segs) toYMonotone(s, out);
  return out;
}

/**
 * Rasterize a W×H coverage grid — the production CPU rasterizer (native-path fill,
 * and the shader's exact twin for parity tests). Handles line/quad/rquad/cubic.
 */
export function rasterCoverage(segs, W, H, evenOdd = false) {
  const mono = prepareSegments(segs);
  const cov = new Float32Array(W * H);
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) cov[py * W + px] = coverageAt(mono, px, py, evenOdd);
  return cov;
}
