// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// PNG raster decoding for embedded font glyphs, including worker/Node preparation.
import { inflateZlibBytes } from './gzip.js';
import { assertDecompressInputSize, assertDecompressOutputSize } from './decompress.js';
export async function decodePng(bytes) {
  assertDecompressInputSize(bytes?.byteLength || 0, 'PNG input');
  if (
    !bytes ||
    bytes.length < 33 ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v)
  )
    throw new Error('Invalid PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    chunks = [];
  let width = 0,
    height = 0,
    depth = 0,
    type = -1,
    interlace = 0,
    palette = null,
    transparency = null,
    compressedSize = 0;
  for (let p = 8; p + 12 <= bytes.length;) {
    const n = view.getUint32(p),
      end = p + 12 + n;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const tag = String.fromCharCode(...bytes.subarray(p + 4, p + 8)),
      data = bytes.subarray(p + 8, p + 8 + n);
    if (tag === 'IHDR') {
      if (n !== 13 || width) throw new Error('Invalid PNG header');
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      depth = data[8];
      type = data[9];
      interlace = data[12];
      if (!width || !height || data[10] || data[11] || interlace > 1)
        throw new Error('Unsupported PNG header');
      assertDecompressOutputSize(width * height * 4, 'PNG pixels');
    } else if (tag === 'PLTE') palette = data;
    else if (tag === 'tRNS') transparency = data;
    else if (tag === 'IDAT') {
      chunks.push(data);
      compressedSize += data.length;
    } else if (tag === 'IEND') break;
    p = end;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (
    !channels ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    (type !== 0 && type !== 3 && depth < 8) ||
    (type === 3 && depth === 16) ||
    !chunks.length
  )
    throw new Error('Unsupported PNG pixel format');
  if (type === 3 && (!palette || palette.length % 3)) throw new Error('Invalid PNG palette');
  const compressed = new Uint8Array(compressedSize);
  let at = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, at);
    at += chunk.length;
  }
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)),
      h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) expected += (Math.ceil((w * channels * depth) / 8) + 1) * h;
  }
  assertDecompressOutputSize(expected, 'PNG scanlines');
  const raw = await inflateZlibBytes(compressed);
  if (raw.length !== expected) throw new Error('Invalid PNG scanline length');
  const rgba = new Uint8Array(width * height * 4),
    bpp = Math.max(1, Math.ceil((channels * depth) / 8)),
    maximum = 2 ** depth - 1;
  const t = transparency,
    transparentGray = t && t.length >= 2 ? t[0] * 256 + t[1] : -1;
  const transparentRgb =
    t && t.length >= 6 ? [t[0] * 256 + t[1], t[2] * 256 + t[3], t[4] * 256 + t[5]] : null;
  const paeth = (a, b, c) => {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  at = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x0) / dx)),
      h = Math.max(0, Math.ceil((height - y0) / dy));
    if (!w || !h) continue;
    const stride = Math.ceil((w * channels * depth) / 8);
    let previous = new Uint8Array(stride),
      row = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      const filter = raw[at++];
      if (filter > 4) throw new Error('Invalid PNG row filter');
      for (let k = 0; k < stride; k++) {
        const left = k >= bpp ? row[k - bpp] : 0,
          up = previous[k],
          corner = k >= bpp ? previous[k - bpp] : 0;
        row[k] =
          (raw[at++] +
            (filter === 0
              ? 0
              : filter === 1
                ? left
                : filter === 2
                  ? up
                  : filter === 3
                    ? Math.floor((left + up) / 2)
                    : paeth(left, up, corner))) &
          255;
      }
      const sample = (i) =>
        depth === 16
          ? row[i * 2] * 256 + row[i * 2 + 1]
          : depth === 8
            ? row[i]
            : (row[(i * depth) >> 3] >> (8 - depth - ((i * depth) & 7))) & maximum;
      for (let x = 0; x < w; x++) {
        const i = x * channels,
          o = ((y0 + y * dy) * width + x0 + x * dx) * 4,
          c0 = sample(i);
        if (type === 3) {
          const p = c0 * 3;
          if (p + 2 >= palette.length) throw new Error('PNG palette index out of range');
          rgba.set(palette.subarray(p, p + 3), o);
          rgba[o + 3] = t && c0 < t.length ? t[c0] : 255;
        } else if (type === 0 || type === 4) {
          const g = Math.round((c0 * 255) / maximum);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
          rgba[o + 3] =
            type === 4
              ? Math.round((sample(i + 1) * 255) / maximum)
              : c0 === transparentGray
                ? 0
                : 255;
        } else {
          const c1 = sample(i + 1),
            c2 = sample(i + 2);
          rgba[o] = Math.round((c0 * 255) / maximum);
          rgba[o + 1] = Math.round((c1 * 255) / maximum);
          rgba[o + 2] = Math.round((c2 * 255) / maximum);
          rgba[o + 3] =
            type === 6
              ? Math.round((sample(i + 3) * 255) / maximum)
              : transparentRgb &&
                  c0 === transparentRgb[0] &&
                  c1 === transparentRgb[1] &&
                  c2 === transparentRgb[2]
                ? 0
                : 255;
        }
      }
      const swap = previous;
      previous = row;
      row = swap;
    }
  }
  return { w: width, h: height, rgba };
}
