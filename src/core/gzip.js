// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Gzip decompression via the environment's standard API — browsers expose
// DecompressionStream, Node has zlib. Shared by the SVG `<image>`/.svgz path
// (svg/image.js) and the SVG-in-OpenType glyph path (font/textRun.js) so the
// decompressor lives in exactly one place.

import {
  MAX_DECOMPRESS_BYTES,
  assertDecompressInputSize,
  assertDecompressOutputSize,
} from './decompress.js';
import { nodeZlib } from './nodeBuiltin.js';

/// Gunzip a Uint8Array. Returns a fresh Uint8Array of the inflated bytes.
///
/// The output limit is enforced WHILE inflating, not after. Buffering the whole
/// stream first and measuring it afterwards reports a decompression bomb only
/// once it has already been allocated: a 200 KB gzip of zeros drove 658 MB of
/// RSS before the check fired, against a 64 MB limit. Both inputs that reach
/// here are untrusted content — .svgz images and SVG-in-OpenType glyphs — so on
/// a browser tab that is an out-of-memory kill, not a caught error.
export async function gunzipBytes(bytes) {
  return decompressBytes(bytes, 'gzip');
}

export async function inflateZlibBytes(bytes) {
  return decompressBytes(bytes, 'deflate');
}

async function decompressBytes(bytes, format) {
  assertDecompressInputSize(bytes?.length ?? 0, format + ' input');
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Response(new Blob([bytes])).body.pipeThrough(
      new DecompressionStream(format),
    );
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;

        assertDecompressOutputSize(total, format + ' output');
        chunks.push(value);
      }
    } catch (e) {
      // Stop the producer; without this the stream keeps inflating in the
      // background and the bomb wins anyway.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw e;
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
  const zlib = await nodeZlib(format + ' decompression');
  // The Node path already aborts mid-inflation via maxOutputLength.
  const out =
    format === 'gzip'
      ? zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESS_BYTES })
      : zlib.inflateSync(bytes, { maxOutputLength: MAX_DECOMPRESS_BYTES });
  return new Uint8Array(out);
}
