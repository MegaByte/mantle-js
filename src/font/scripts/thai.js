// font/scripts/thai.js — opt-in registration for Thai + Lao shaping.
//
//   import { registerThaiShaping } from '@kontek/mantle/font/scripts/thai';
//   registerThaiShaping();
//
// Enables SARA AM decomposition + pre-base vowel reorder for Thai
// (U+0E00..U+0E7F) and Lao (U+0E80..U+0EFF). Without it, those
// scripts render with vowels in logical order — readable in some
// contexts but visually wrong.

import {
  isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm, reorderThaiLao,
} from './thaiShaper.js';
import { registerThaiShaping as _register } from '../shaperRegistry.js';

let _registered = false;

export function registerThaiShaping() {
  if (_registered) return;
  _registered = true;
  _register({ isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm, reorderThaiLao });
}

export { isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm, reorderThaiLao };
