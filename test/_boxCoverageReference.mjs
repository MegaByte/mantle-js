// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent exact pixel-box coverage of the fixture shapes (rect, circle, rounded rect) under a DIAGONAL clip-space
// map. It imports no Mantle code: the pixel box is pulled back into the authored coordinates and the shape's chord is
// integrated over it (Gauss-Legendre on 512 panels per pixel column), so the answer is the box-averaged area, not a
// model of any renderer's footprint. Everything is normalized by the viewBox size, so it is the same at any scale.
const GL4 = [
  [-0.8611363115940526, 0.3478548451374538],
  [-0.3399810435848563, 0.6521451548625461],
  [0.3399810435848563, 0.6521451548625461],
  [0.8611363115940526, 0.3478548451374538],
];
const PANELS = 512;

/// Chord [lo, hi] of a shape at normalized x, or null outside it. `s` is the normalized shape.
function chord(s, x) {
  if (s.kind === 'circle') {
    const d = x - s.cx;
    if (Math.abs(d) >= s.r) return null;
    const h = Math.sqrt(s.r * s.r - d * d);
    return [s.cy - h, s.cy + h];
  }
  if (x <= s.x0 || x >= s.x1) return null;
  if (s.kind === 'rect') return [s.y0, s.y1];
  const dx = Math.max(s.x0 + s.r - x, x - (s.x1 - s.r), 0);
  const inset = dx > 0 ? s.r - Math.sqrt(Math.max(0, s.r * s.r - dx * dx)) : 0;
  return [s.y0 + inset, s.y1 - inset];
}

/// Box-averaged coverage of the normalized box [u0,u1] x [v0,v1].
function boxCoverage(s, u0, u1, v0, v1) {
  const lo = Math.max(u0, s.kind === 'circle' ? s.cx - s.r : s.x0),
    hi = Math.min(u1, s.kind === 'circle' ? s.cx + s.r : s.x1);
  if (!(hi > lo)) return 0;
  const w = (hi - lo) / PANELS;
  let area = 0;
  for (let p = 0; p < PANELS; p++) {
    const a = lo + p * w,
      mid = a + 0.5 * w;
    for (const [t, wt] of GL4) {
      const c = chord(s, mid + t * 0.5 * w);
      if (!c) continue;
      area += wt * 0.5 * w * Math.max(0, Math.min(c[1], v1) - Math.max(c[0], v0));
    }
  }
  return area / ((u1 - u0) * (v1 - v0));
}

/// Normalized shape from a fixture svg (a single rect/circle with numeric attributes), divided by the viewBox size.
export function shapeFromSvg(svg) {
  const num = (tag, name) => {
    const m = new RegExp('<' + tag + '[^>]*\\s' + name + '="([^"]+)"').exec(svg);
    return m ? +m[1] : null;
  };
  const vb = +/viewBox="0 0 ([^ ]+) /.exec(svg)[1];
  if (svg.includes('<circle'))
    return {
      kind: 'circle',
      cx: num('circle', 'cx') / vb,
      cy: num('circle', 'cy') / vb,
      r: num('circle', 'r') / vb,
    };
  const x = num('rect', 'x') / vb,
    y = num('rect', 'y') / vb,
    w = num('rect', 'width') / vb,
    h = num('rect', 'height') / vb;
  const rx = num('rect', 'rx');
  return { kind: rx ? 'rounded' : 'rect', x0: x, x1: x + w, y0: y, y1: y + h, r: rx ? rx / vb : 0 };
}

/// True for a clip-space map that is only a per-axis scale (axis-aligned or reflected).
export const isDiagonalMap = (M) =>
  !M ||
  (M[1] === 0 && M[3] === 0 && M[2] === 0 && M[5] === 0 && M[6] === 0 && M[7] === 0 && M[8] === 1);

/// Expected alpha (coverage * opacity) of every pixel of a size x size canvas that fits the viewBox to the clip square
/// (row 0 = top). Returns sparse samples: edge pixels (0 < coverage < 1) and their 8 neighbors, which is where a cover
/// that over- or under-reaches shows. `M` is the column-major clip-space world matrix (diagonal).
export function edgeSamples(svg, size, M, opacity) {
  const s = shapeFromSvg(svg),
    sx = M ? M[0] : 1,
    sy = M ? M[4] : 1;
  const cov = new Float64Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      // pixel edge -> clip -> authored (normalized) coordinate; the clip y axis points up, the authored one down
      const ux = (px) => (((2 * px) / size - 1) / sx + 1) / 2,
        vy = (py) => (1 - (1 - (2 * py) / size) / sy) / 2;
      const ua = ux(i),
        ub = ux(i + 1),
        va = vy(j),
        vb = vy(j + 1);
      cov[j * size + i] = boxCoverage(
        s,
        Math.min(ua, ub),
        Math.max(ua, ub),
        Math.min(va, vb),
        Math.max(va, vb),
      );
    }
  const out = [],
    near = new Uint8Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const c = cov[j * size + i];
      if (!(c > 0 && c < 1)) continue;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const y = j + dj,
            x = i + di;
          if (x >= 0 && y >= 0 && x < size && y < size) near[y * size + x] = 1;
        }
    }
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++)
      if (near[j * size + i]) out.push({ x: i, y: j, area: cov[j * size + i] * opacity });
  return out;
}
