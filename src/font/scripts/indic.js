// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/scripts/indic.js — opt-in registration for Indic shaping
// (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gurmukhi,
// Gujarati, Oriya, Sinhala — 10 scripts via OT Indic2).
//
//   import { registerIndicShaping } from '@kontek/mantle/font/scripts/indic';
//   registerIndicShaping();
//
// Pulls in: syllable classifier + per-syllable reorder + GSUB
// feature dispatch (nukt / akhn / rphf / rkrf / pref / blwf / abvf /
// half / pstf / vatu / cjct, then init / pres / abvs / blws / psts /
// haln / calt). All script scripts share the same machinery.

import {
  isIndicCodepoint,
  findIndicSyllables,
  reorderSyllable,
  reorderSyllableExplicitReph,
  hasInitialReph,
  analyzeIndicSyllable,
  consonantPositionFromFont,
  pickBaseConsonant,
  indicScriptOf,
  viramaForScript,
  rephModeForScript,
  isIndicBaseCandidate,
  classifyIsc,
  classifyIpc,
  Isc,
  Ipc,
  ConsPos,
  RephMode,
} from './indicShaper.js';
import { registerIndicShaping as _register } from '../shaperRegistry.js';
import { registerOtScriptTags } from '../otScriptTags.js';

let _registered = false;

export function registerIndicShaping() {
  if (_registered) return;
  _registered = true;
  // Each Indic script has its own language systems ('dev2' carries
  // features DFLT does not), so the run's script has to reach the
  // lookup finder.
  registerOtScriptTags();
  _register({
    isIndicCodepoint,
    findIndicSyllables,
    reorderSyllable,
    reorderSyllableExplicitReph,
    hasInitialReph,
    analyzeIndicSyllable,
    consonantPositionFromFont,
    isIndicBaseCandidate,
    indicScriptOf,
    viramaForScript,
    rephModeForScript,
    classifyIsc,
    classifyIpc,
    Isc,
    Ipc,
    ConsPos,
    RephMode,
  });
}

export {
  isIndicCodepoint,
  findIndicSyllables,
  reorderSyllable,
  reorderSyllableExplicitReph,
  hasInitialReph,
  analyzeIndicSyllable,
  consonantPositionFromFont,
  pickBaseConsonant,
  indicScriptOf,
  viramaForScript,
  rephModeForScript,
  isIndicBaseCandidate,
  ConsPos,
  RephMode,
};
