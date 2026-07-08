// font/typography/justification — opt-in registration for the JSTF
// (justification) table.
//
//   import { registerJustificationReader } from '@kontek/mantle/font/typography/justification';
//   registerJustificationReader();
//
// Provides the Arabic kashida extender glyphs the justify path inserts
// at cursive joins to fill line slack. Without registration, jstf
// returns a null-object and justification falls back to space stretching.

import { JstfReader } from './jstfReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerJustificationReader() {
  if (_registered) return;
  _registered = true;
  registerReader('jstf', (tables) => new JstfReader(tables));
}

export { JstfReader };
