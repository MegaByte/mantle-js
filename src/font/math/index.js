// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/math — opt-in registration for the MATH table reader.
//
//   import { registerMathReader } from '@kontek/mantle/font/math';
//   registerMathReader();
//
// Provides per-glyph italic correction, top-accent attachment, math
// kern, MathConstants, stretchy variant records, and GlyphAssembly
// recipes. Math typesetting also needs font/scripts/math (stretchy
// codepoint detection at the textRun layer).

import { MathReader } from './mathReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerMathReader() {
  if (_registered) return;
  _registered = true;
  registerReader('math', (tables) => new MathReader(tables));
}

export { MathReader };
