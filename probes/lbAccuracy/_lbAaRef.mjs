// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbAaRef — the exact box-filter reference, and the metrics read against it.
//
// THE REFERENCE IS THE PATH'S, not another engine's. A pixel's true coverage is area(pixel box AND
// filled region); `rowSpans` gives a scanline's filled spans exactly, so the x integral of each
// slice is exact and only the y integral is quadrature. This is the same construction
// probes/cpatchGate/_rowGateAaRef.mjs uses for CPatch, for the same reason: comparing two engines
// tells you they differ, not which one is wrong.
//
// READ THE DELTA, NOT THE TOTAL, when the quadrature is coarse — |model - exact| is not smooth, so
// SLICES moves a total by about a percent. Two arms against the same cached reference cancel it.
// The default here is 64 slices.
//
// An open subpath is filled as if closed, which is what both the packer and the LB builder do.
import { existsSync, readFileSync, writeFileSync } from 'fs';

export async function refKit() {
  const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
  const { contoursToConverter } = await import('../../src/renderer/cpatchBuild.js');
  const { segPt } = await import('../../src/geom/cpatchImplicit.js');
  /// An open subpath is filled as if closed; rowSpans over the raw segments would find no interior.
  const closed = (contours) => {
    const o = [];
    for (const q of contours) {
      if (!q.length) continue;
      for (const sg of q) o.push(sg);
      const a = segPt(q[0], 0),
        b = segPt(q[q.length - 1], 1);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9)
        o.push({
          t: 'line',
          P: [
            [b[0], b[1]],
            [a[0], a[1]],
          ],
        });
    }
    return o;
  };
  return { rowSpans, contoursToConverter, closed };
}

/** Spans of one scanline, in pixel coordinates, for a converter curve list. */
export function spansPx(rowSpans, curves, emY, view, evenOdd) {
  const sp = rowSpans(curves, emY, evenOdd);
  const out = [];
  for (const s of sp) out.push([(s[0] - view.ox) / view.basePx, (s[1] - view.ox) / view.basePx]);
  return out;
}

/**
 * Exact-in-x, sliced-in-y coverage of the pixel (i, j).
 * `rows` is a cache keyed by the slice's em y, so a column of pixels pays for its rows once.
 */
export function exactCov(rowSpans, curves, i, j, view, slices, evenOdd, rowCache) {
  let a = 0;
  const x0 = view.ox + i * view.basePx,
    x1 = x0 + view.basePx;
  const y0 = view.oy + j * view.basePx;
  for (let s = 0; s < slices; s++) {
    const key = j * slices + s;
    let sp = rowCache && rowCache.get(key);
    if (!sp) {
      const yy = y0 + (view.basePx * (s + 0.5)) / slices;
      sp = rowSpans(curves, yy, evenOdd);
      if (rowCache) rowCache.set(key, sp);
    }
    for (const q of sp) {
      const lo = Math.max(q[0], x0),
        hi = Math.min(q[1], x1);
      if (hi > lo) a += hi - lo;
    }
  }
  return a / (view.basePx * slices);
}

/** The narrowest filled span covering (or nearest to) pixel column i on the pixel's center row. */
export function featureWidthPx(rowSpans, curves, i, j, view, evenOdd) {
  const yy = view.oy + (j + 0.5) * view.basePx;
  const sp = rowSpans(curves, yy, evenOdd);
  if (!sp.length) return Infinity;
  const cx = view.ox + (i + 0.5) * view.basePx;
  let best = Infinity,
    bestD = Infinity;
  for (const q of sp) {
    const w = (q[1] - q[0]) / view.basePx;
    const d = cx < q[0] ? q[0] - cx : cx > q[1] ? cx - q[1] : 0;
    if (d < bestD - 1e-12 || (Math.abs(d - bestD) <= 1e-12 && w < best)) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

export function loadCache(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
export function saveCache(file, obj) {
  if (file) writeFileSync(file, JSON.stringify(obj));
}
