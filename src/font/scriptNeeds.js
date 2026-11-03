// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scriptNeeds.js — say so when text needs a script module that was not registered.
//
// Complex-script shaping and bidirectional reordering are opt-in (`font/scripts/*`, `font/typography/bidi`). With none
// registered, Latin/Cyrillic/Greek/CJK lay out correctly and everything else lays out WITHOUT the script's rules (no Arabic
// joining forms, no Indic reordering, no right-to-left order). That is a visible change, not a no-op, so the first span that
// contains such text warns once, naming the import. The test is one native regexp pass per span and exits at the first
// non-matching span; nothing here runs when the modules are registered.

import {
  getArabicShaping,
  getHangulShaping,
  getIndicShaping,
  getThaiShaping,
  getUseShaping,
} from './shaperRegistry.js';
import { hasBidi } from './bidiRegistry.js';
import { warnMissingFeature } from '../core/missingFeature.js';

const ANY_COMPLEX = /[֐-໿က-႟ᄀ-ᇿក-៿ꥠ-꥿ힰ-퟿יִ-﷿ﹰ-﻿]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const INDIC = /[ऀ-෿]/;
const THAI_LAO = /[฀-໿]/;
const USE = /[က-႟ក-៿]/;
const HANGUL_OLD = /[ᄀ-ᇿꥠ-꥿ힰ-퟿]/;

const SCRIPTS = '@kontek/mantle/font/scripts/';

/** Warn (once per module) for each script in `text` whose module is not registered. */
export function noteScriptNeeds(text) {
  if (!ANY_COMPLEX.test(text)) return;
  if (!hasBidi() && RTL.test(text))
    warnMissingFeature(
      'bidi',
      'the text has right-to-left characters, which are laid out left to right',
      '@kontek/mantle/font/typography/bidi',
      'registerBidi()',
    );
  if (!getArabicShaping() && ARABIC.test(text))
    warnMissingFeature(
      'script:arabic',
      'the text is Arabic, which is shaped without joining forms',
      SCRIPTS + 'arabic',
      'registerArabicShaping()',
    );
  if (!getIndicShaping() && INDIC.test(text))
    warnMissingFeature(
      'script:indic',
      'the text is in an Indic script, which is laid out without syllable reordering',
      SCRIPTS + 'indic',
      'registerIndicShaping()',
    );
  if (!getThaiShaping() && THAI_LAO.test(text))
    warnMissingFeature(
      'script:thai',
      'the text is Thai or Lao, which is laid out without its mark rules',
      SCRIPTS + 'thai',
      'registerThaiShaping()',
    );
  if (!getUseShaping() && USE.test(text))
    warnMissingFeature(
      'script:use',
      'the text is Khmer or Myanmar, which is laid out without the Universal Shaping Engine',
      SCRIPTS + 'use',
      'registerUseShaping()',
    );
  if (!getHangulShaping() && HANGUL_OLD.test(text))
    warnMissingFeature(
      'script:hangul',
      'the text has conjoining Hangul jamo, which are laid out without positional forms',
      SCRIPTS + 'hangul',
      'registerHangulShaping()',
    );
}
