// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// decompress.js — shared limits for gzip / brotli inflation.

/** Max bytes accepted for a single decompress operation (untrusted input). */
export const MAX_DECOMPRESS_BYTES = 64 * 1024 * 1024;

export function assertDecompressInputSize(byteLength, label = 'input') {
  if (byteLength > MAX_DECOMPRESS_BYTES) {
    throw new Error(
      `${label} (${byteLength} bytes) exceeds ${MAX_DECOMPRESS_BYTES} byte decompress limit`,
    );
  }
}

export function assertDecompressOutputSize(byteLength, label = 'output') {
  if (byteLength > MAX_DECOMPRESS_BYTES) {
    throw new Error(
      `${label} (${byteLength} bytes) exceeds ${MAX_DECOMPRESS_BYTES} byte decompress limit`,
    );
  }
}
