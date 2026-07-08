// fillCoverage.js — winding ray-cast, primKind fast paths, point-in-fill.

import {
  solveQuadratic, solveCubicInUnit,
} from '../svg/pathBoolean/polyRoots.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from './curveGeom.js';

const RAY_EPS = 1e-7;   // nudge the fill ray off exact y-extrema (tangencies)

const META_BBOX_XMIN = 0;
const META_BBOX_YMIN = 1;
const META_BBOX_XMAX = 2;
const META_BBOX_YMAX = 3;
const META_PRIMKIND = 44;    // t11.x: 0 ray-cast, 1 circle, 2 rect, 3 roundRect
const META_PRIMRX   = 46;    // t11.z: roundRect corner radius (em) when primKind==3

// ── Fill: exact signed crossings of the +x ray at y = yr with each seg ──
function crossLine(s, px, yr, acc) {
  const y0 = s.y0, y1 = s.y1;
  if ((y0 > yr) !== (y1 > yr)) {
    const x = s.x0 + (yr - y0) / (y1 - y0) * (s.x1 - s.x0);
    if (x > px) { acc.cross++; acc.wind += (y1 > y0) ? 1 : -1; }
  }
}
function crossQuad(s, px, yr, acc) {
  // y-hull cull: the curve lies within its control points' y-range (Bézier convex
  // hull), so it can't cross the ray if yr is outside — skip the root solve.
  if (yr < Math.min(s.y0, s.cy, s.y1) || yr > Math.max(s.y0, s.cy, s.y1)) return;
  const Ay = s.y0 - 2 * s.cy + s.y1, By = 2 * (s.cy - s.y0), Cy = s.y0 - yr;
  for (const t of solveQuadratic(Ay, By, Cy)) {
    if (t < 0 || t >= 1) continue;
    const u = 1 - t;
    const x = u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1;
    if (x > px) {
      const dy = 2 * Ay * t + By;
      if (dy > 0) { acc.cross++; acc.wind++; } else if (dy < 0) { acc.cross++; acc.wind--; }
    }
  }
}
function crossCubic(s, px, yr, acc) {
  // y-hull cull (Bézier convex hull): skip the cubic root solve when yr is outside
  // the control points' y-range.
  if (yr < Math.min(s.y0, s.c1y, s.c2y, s.y1) || yr > Math.max(s.y0, s.c1y, s.c2y, s.y1)) return;
  const D3 = -s.y0 + 3 * s.c1y - 3 * s.c2y + s.y1;
  const D2 = 3 * (s.y0 - 2 * s.c1y + s.c2y);
  const D1 = 3 * (s.c1y - s.y0);
  const D0 = s.y0 - yr;
  // Fill crossing uses the shader's cubic root finder (Yuksel clamped-Newton)
  // rather than Cardano, so the hit test's inside/outside matches what the
  // shader draws and stays robust where Cardano's disc≈0 branch loses
  // precision. Stroke/arc closest-point stays exact-analytic.
  for (const t of solveCubicInUnit(D3, D2, D1, D0)) {
    if (t < 0 || t >= 1) continue;
    const u = 1 - t;
    const x = u * u * u * s.x0 + 3 * u * u * t * s.c1x + 3 * u * t * t * s.c2x + t * t * t * s.x1;
    if (x > px) {
      const dy = 3 * D3 * t * t + 2 * D2 * t + D1;
      if (dy > 0) { acc.cross++; acc.wind++; } else if (dy < 0) { acc.cross++; acc.wind--; }
    }
  }
}
function crossArc(s, px, yr, acc) {
  // y(θ) = cy + rx·sinφ·cosθ + ry·cosφ·sinθ = yr  →  a·cosθ + b·sinθ = C.
  const a = s.rx * s.sp, b = s.ry * s.cp, C = yr - s.cy;
  const R = Math.hypot(a, b);
  if (R < 1e-12 || Math.abs(C) > R) return;
  const phi0 = Math.atan2(b, a);
  const delta = Math.acos(Math.max(-1, Math.min(1, C / R)));
  const dir = (s.th1 >= s.th0) ? 1 : -1;
  const lo = Math.min(s.th0, s.th1), hi = Math.max(s.th0, s.th1);
  for (const base of [phi0 + delta, phi0 - delta]) {
    let th = base;
    while (th < lo) th += 2 * Math.PI;
    while (th >= lo + 2 * Math.PI) th -= 2 * Math.PI;
    if (th > hi) continue;
    const x = s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp;
    if (x > px) {
      const dyth = (-s.rx * s.sp * Math.sin(th) + s.ry * s.cp * Math.cos(th)) * dir;
      if (dyth > 0) { acc.cross++; acc.wind++; } else if (dyth < 0) { acc.cross++; acc.wind--; }
    }
  }
}

/** Point inside the filled region — exact signed crossings of the +x ray. */
export function pointInFill(segs, px, py, evenOdd) {
  // Nudge the ray off exact y-extrema so tangencies (double roots) don't
  // register as crossings, and so JS/C# agree at the degenerate case.
  const yr = py + RAY_EPS;
  const acc = { cross: 0, wind: 0 };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t === SEG_LINE) crossLine(s, px, yr, acc);
    else if (s.t === SEG_QUAD) crossQuad(s, px, yr, acc);
    else if (s.t === SEG_CUBIC) crossCubic(s, px, yr, acc);
    else crossArc(s, px, yr, acc);
  }
  return evenOdd ? (acc.cross & 1) === 1 : acc.wind !== 0;
}

// Analytic inside-test for simple-shape primitives (meta texel 11.x).
// The renderer fills these via a closed-form SDF; the hit test must agree at
// the d=0 boundary AND skip the curve-buffer decode. Returns 1 inside, 0
// outside, or -1 = "not a fast prim here, fall back to winding" (a
// non-uniformly-scaled circle bakes to an ellipse the SDF rejects, so its hit
// test must stay on the exact arc winding too). The SDF bodies are sdCircle /
// sdRoundedBox, so the boundary is identical to the render.
export function pointInPrim(meta, off, px, py) {
  const kind = Math.round(meta[off + META_PRIMKIND]);
  if (kind === 0) return -1;
  const x0 = meta[off + META_BBOX_XMIN], y0 = meta[off + META_BBOX_YMIN];
  const x1 = meta[off + META_BBOX_XMAX], y1 = meta[off + META_BBOX_YMAX];
  const hex = 0.5 * (x1 - x0), hey = 0.5 * (y1 - y0);
  const qx = px - 0.5 * (x0 + x1), qy = py - 0.5 * (y0 + y1);
  if (kind === 1) {
    // circle fast path only when the bbox is (near-)square — same gate the
    // shader uses; otherwise the baked shape is an ellipse → fall back.
    if (Math.abs(hex - hey) > 1e-3 * Math.max(hex, 1e-6)) return -1;
    const r = Math.min(hex, hey);
    return (qx * qx + qy * qy) <= r * r ? 1 : 0;
  }
  const rx = (kind === 3) ? meta[off + META_PRIMRX] : 0;   // rect: rx=0
  const ex = Math.abs(qx) - hex + rx, ey = Math.abs(qy) - hey + rx;
  const ax = Math.max(ex, 0), ay = Math.max(ey, 0);
  const d = Math.min(Math.max(ex, ey), 0) + Math.hypot(ax, ay) - rx;
  return d <= 0 ? 1 : 0;
}
