// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/formats/cff — opt-in registration for CFF / CFF2 outline fonts.
//
//   import { registerCffReader } from '@kontek/mantle/font/formats/cff';
//   registerCffReader();
//
// TrueType (glyf) outlines are always-on core. PostScript-flavored
// fonts (.otf with a `CFF ` table, and CFF2 in variable OpenType) need
// this reader. Without it, glyphReader renders CFF glyphs blank (with a
// one-time console warning) — the same opt-in shape as the color /
// variation / script subpaths.
//
// The full `@kontek/mantle/font` barrel calls this for you; import this
// subpath directly only on the lean `@kontek/mantle/font/text` path
// when your fonts may be CFF-outlined.

import { CffReader } from './cffReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerCffReader() {
  if (_registered) return;
  _registered = true;
  // glyphReader constructs this with (bytes, offset, length, version),
  // so the registry stores the class itself rather than a (tables)
  // factory — glyphReader calls `new Ctor(...)` directly.
  registerReader('cff', CffReader);
}

export { CffReader };
