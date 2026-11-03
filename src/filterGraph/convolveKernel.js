// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// convolveKernel.js — feConvolveMatrix's kernel as the convolve pass reads it.
//
export function flipConvolveKernel(src, off, orderX, orderY, out) {
  out.fill(0);
  if (!src) return out;
  const ox = Math.max(1, Math.min(5, orderX | 0)),
    oy = Math.max(1, Math.min(5, orderY | 0));
  for (let j = 0; j < oy; j++) {
    for (let i = 0; i < ox; i++) {
      const idx = (oy - 1 - j) * ox + (ox - 1 - i);
      out[j * 5 + i] = idx < 25 ? src[off + idx] || 0 : 0;
    }
  }
  return out;
}
