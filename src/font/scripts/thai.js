// font/scripts/thai.js — opt-in registration for Thai + Lao shaping.
//
//   import { registerThaiShaping } from '@kontek/mantle/font/scripts/thai';
//   registerThaiShaping();
//
// Enables SARA AM decomposition and mark classification for Thai
// (U+0E00..U+0E7F) and Lao (U+0E80..U+0EFF). Both scripts are encoded
// in visual order (TUS §16.1) — no glyph reordering is performed.

import {
  isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm,
} from './thaiShaper.js';
import { registerThaiShaping as _register } from '../shaperRegistry.js';

let _registered = false;

export function registerThaiShaping() {
  if (_registered) return;
  _registered = true;
  _register({ isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm });
}

export { isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm };
