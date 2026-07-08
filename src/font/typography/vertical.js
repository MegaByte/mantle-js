// font/typography/vertical — opt-in registration for VORG (vertical
// glyph origins).
//
//   import { registerVerticalReader } from '@kontek/mantle/font/typography/vertical';
//   registerVerticalReader();
//
// Needed only for vertical writing-mode rendering (writing-mode:
// vertical-rl / vertical-lr / tb). Without registration, vorg
// returns a null-object.

import { VorgReader } from './vorgReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerVerticalReader() {
  if (_registered) return;
  _registered = true;
  registerReader('vorg', (tables) => new VorgReader(tables));
}

export { VorgReader };
