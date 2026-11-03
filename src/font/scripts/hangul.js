// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/scripts/hangul.js — opt-in registration for Hangul jamo
// positional-form substitution (ljmo / vjmo / tjmo).
//
//   import { registerHangulShaping } from '@kontek/mantle/font/scripts/hangul';
//   registerHangulShaping();
//
// Only affects raw Hangul Jamo codepoints (U+1100..U+11FF) that NFC
// couldn't compose into precomposed syllables (Old Korean + archaic
// jamo). Modern Korean text uses Hangul Syllables (U+AC00..U+D7A3)
// directly and doesn't need this registration.

import { isHangulJamo, classifyHangulJamo } from './hangulJamo.js';
import { registerHangulShaping as _register } from '../shaperRegistry.js';
import { registerOtScriptTags } from '../otScriptTags.js';

let _registered = false;

export function registerHangulShaping() {
  if (_registered) return;
  _registered = true;
  registerOtScriptTags();
  _register({ isHangulJamo, classifyHangulJamo });
}

export { isHangulJamo, classifyHangulJamo };
