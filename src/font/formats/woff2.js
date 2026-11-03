// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/formats/woff2 — opt-in registration for WOFF2 decompression.
//
//   import { registerWoff2Reader } from '@kontek/mantle/font/formats/woff2';
//   registerWoff2Reader();
//
// Without registration, decodeIfWoff2() passes its input through
// unchanged. A WOFF2 payload would fail to parse downstream — error
// surfaces immediately rather than silently mis-decoding.

import { isWoff2, decodeWoff2 } from './woff2Reader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerWoff2Reader() {
  if (_registered) return;
  _registered = true;
  registerReader('isWoff2', isWoff2);
  registerReader('decodeWoff2', decodeWoff2);
}

export { isWoff2, decodeWoff2 };
