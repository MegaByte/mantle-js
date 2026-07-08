// Gzip decompression via the environment's standard API — browsers expose
// DecompressionStream, Node has zlib. Shared by the SVG `<image>`/.svgz path
// (svg/image.js) and the SVG-in-OpenType glyph path (font/textRun.js) so the
// decompressor lives in exactly one place.

import {
  MAX_DECOMPRESS_BYTES,
  assertDecompressInputSize,
  assertDecompressOutputSize,
} from './decompress.js';

/// Gunzip a Uint8Array. Returns a fresh Uint8Array of the inflated bytes.
export async function gunzipBytes(bytes) {
  assertDecompressInputSize(bytes?.length ?? 0, 'gzip input');
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Response(new Blob([bytes])).body
      .pipeThrough(new DecompressionStream('gzip'));
    const arrBuf = await new Response(stream).arrayBuffer();
    assertDecompressOutputSize(arrBuf.byteLength, 'gzip output');
    return new Uint8Array(arrBuf);
  }
  const zlib = await import('zlib');
  const out = zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESS_BYTES });
  return new Uint8Array(out);
}
