// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/scripts/use.js — opt-in registration for Universal Shaping
// Engine scripts (Khmer, Myanmar, Tibetan, and any future USE
// targets).
//
//   import { registerUseShaping } from '@kontek/mantle/font/scripts/use';
//   registerUseShaping();
//
// USE uses the same GSUB feature pipeline as Indic2 (shared
// machinery — Indic feature dispatch handles USE-specific tags too);
// the per-cluster reorder is what's USE-specific.

import {
  isUseCodepoint,
  findUseClusters,
  reorderUseCluster,
  splitVowelPrefix,
} from './useShaper.js';
import { registerUseShaping as _register } from '../shaperRegistry.js';
import { registerOtScriptTags } from '../otScriptTags.js';

let _registered = false;

export function registerUseShaping() {
  if (_registered) return;
  _registered = true;
  registerOtScriptTags();
  _register({ isUseCodepoint, findUseClusters, reorderUseCluster, splitVowelPrefix });
}

export { isUseCodepoint, findUseClusters, reorderUseCluster, splitVowelPrefix };
