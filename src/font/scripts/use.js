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
  isUseCodepoint, findUseClusters, reorderUseCluster,
} from './useShaper.js';
import { registerUseShaping as _register } from '../shaperRegistry.js';

let _registered = false;

export function registerUseShaping() {
  if (_registered) return;
  _registered = true;
  _register({ isUseCodepoint, findUseClusters, reorderUseCluster });
}

export { isUseCodepoint, findUseClusters, reorderUseCluster };
