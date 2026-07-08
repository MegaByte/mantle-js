// font/scripts/indic.js — opt-in registration for Indic shaping
// (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gurmukhi,
// Gujarati, Oriya, Sinhala — 10 scripts via OT Indic2).
//
//   import { registerIndicShaping } from '@kontek/mantle/font/scripts/indic';
//   registerIndicShaping();
//
// Pulls in: syllable classifier + per-syllable reorder + GSUB
// feature dispatch (nukt / akhn / rphf / rkrf / pref / blwf / half /
// vatu / cjct / pres / abvs / blws / psts / haln / calt). All script
// scripts share the same machinery.

import {
  isIndicCodepoint, findIndicSyllables,
  reorderSyllable, reorderSyllableExplicitReph, hasInitialReph,
} from './indicShaper.js';
import { registerIndicShaping as _register } from '../shaperRegistry.js';

let _registered = false;

export function registerIndicShaping() {
  if (_registered) return;
  _registered = true;
  _register({
    isIndicCodepoint, findIndicSyllables,
    reorderSyllable, reorderSyllableExplicitReph, hasInitialReph,
  });
}

export {
  isIndicCodepoint, findIndicSyllables,
  reorderSyllable, reorderSyllableExplicitReph, hasInitialReph,
};
