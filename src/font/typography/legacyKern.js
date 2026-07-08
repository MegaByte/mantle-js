// font/typography/legacyKern — opt-in registration for the pre-GPOS
// 'kern' table (used by some older Latin fonts that lack GPOS pair
// adjustments). Falls back to GPOS when both are present.
//
//   import { registerLegacyKernReader } from '@kontek/mantle/font/typography/legacyKern';
//   registerLegacyKernReader();
//
// Skip for modern fonts (GPOS-only).

import { LegacyKernReader } from './legacyKernReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerLegacyKernReader() {
  if (_registered) return;
  _registered = true;
  registerReader('legacyKern', (tables) => new LegacyKernReader(tables));
}

export { LegacyKernReader };
