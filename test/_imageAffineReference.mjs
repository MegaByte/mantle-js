// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent source-space rectangle clipping and nearest-texel reference (the image-morph packets).
// Compares fenced pixels of a 16x16 2x2-texel image under an affine; not a renderer simulation.
function clip(points, axis, value, keepGreater) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const ai = keepGreater ? a[axis] >= value : a[axis] <= value,
      bi = keepGreater ? b[axis] >= value : b[axis] <= value;
    if (ai) result.push(a);
    if (ai !== bi) {
      const t = (value - a[axis]) / (b[axis] - a[axis]);
      result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return result;
}
function areaInPixel(polygon, x, y, pixel) {
  let p = clip(polygon, 0, x, true);
  p = clip(p, 0, x + pixel, false);
  p = clip(p, 1, y, true);
  p = clip(p, 1, y + pixel, false);
  let twice = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    twice += a[0] * b[1] - a[1] * b[0];
  }
  return Math.min(1, Math.max(0, Math.abs(twice) / 2 / (pixel * pixel)));
}
const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];
export function compareAffineBitmap(
  actual,
  matrix,
  opacity,
  { bottomUp = true, straight = false, size = 96, viewport = 48 } = {},
) {
  const [a, b, c, d, e, f] = matrix,
    det = a * d - b * c,
    pixel = viewport / size;
  const polygon = [
    [0, 0],
    [16, 0],
    [16, 16],
    [0, 16],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  let maxByte = 0,
    alphaMaxByte = 0,
    ambiguousPixels = 0,
    pixelsOver1 = 0;
  const mismatches = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const coverage = areaInPixel(polygon, x * pixel, y * pixel, pixel),
        expectedAlpha = Math.round(255 * coverage * opacity),
        at = ((bottomUp ? size - 1 - y : y) * size + x) * 4;
      const centerX = (x + 0.5) * pixel - e,
        centerY = (y + 0.5) * pixel - f;
      const u = (d * centerX - c * centerY) / det / 16,
        v = (-b * centerX + a * centerY) / det / 16;
      const xs = Math.abs(u - 0.5) < 1e-7 ? [0, 1] : [u >= 0.5 ? 1 : 0],
        ys = Math.abs(v - 0.5) < 1e-7 ? [0, 1] : [v >= 0.5 ? 1 : 0];
      if (xs.length > 1 || ys.length > 1) ambiguousPixels++;
      let error = Infinity;
      for (const ty of ys)
        for (const tx of xs) {
          const color = colors[ty * 2 + tx];
          let candidateError = Math.abs(actual[at + 3] - expectedAlpha);
          for (let k = 0; k < 3; k++) {
            const value = straight ? (actual[at + k] * actual[at + 3]) / 255 : actual[at + k];
            candidateError = Math.max(
              candidateError,
              Math.abs(value - (color[k] / 255) * expectedAlpha),
            );
          }
          error = Math.min(error, candidateError);
        }
      maxByte = Math.max(maxByte, error);
      alphaMaxByte = Math.max(alphaMaxByte, Math.abs(actual[at + 3] - expectedAlpha));
      if (error > 1) {
        pixelsOver1++;
        if (mismatches.length < 16)
          mismatches.push({
            x,
            y,
            u,
            v,
            coverage,
            expectedAlpha,
            actual: Array.from(actual.slice(at, at + 4)),
            error,
          });
      }
    }
  return { maxByte, alphaMaxByte, ambiguousPixels, pixelsOver1, mismatches };
}
