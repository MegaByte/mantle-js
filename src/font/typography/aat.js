// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/typography/aat — opt-in registration for Apple Advanced Typography
// readers (morx glyph metamorphosis + kerx extended kerning + trak tracking).
//
//   import { registerAatReaders } from '@kontek/mantle/font/typography/aat';
//   registerAatReaders();
//
// Enables shaping for AAT-only fonts that ship morx/kerx instead of
// GSUB/GPOS. Without registration, morx/kerx return null-objects and such
// fonts render with unshaped base glyphs.

import { AatMorx } from './aatMorx.js';
import { AatMort } from './aatMort.js';
import { AatKerx } from './aatKerx.js';
import { AatTrak } from './aatTrak.js';
import { FeatReader } from './featReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerAatReaders() {
  if (_registered) return;
  _registered = true;
  registerReader('morx', (tables) => new AatMorx(tables));
  registerReader('mort', (tables) => new AatMort(tables));
  registerReader('kerx', (tables) => new AatKerx(tables));
  registerReader('trak', (tables) => new AatTrak(tables));
  registerReader('feat', (tables) => new FeatReader(tables));
}

export { AatMorx, AatMort, AatKerx, AatTrak, FeatReader };
