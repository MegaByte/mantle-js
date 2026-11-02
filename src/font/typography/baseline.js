// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/typography/baseline — opt-in registration for the BASE
// (baseline alignment) table.
//
//   import { registerBaselineReader } from '@kontek/mantle/font/typography/baseline';
//   registerBaselineReader();
//
// Used for mixed-script line alignment (Latin alphabetic baseline
// vs CJK ideographic-low). Most consumers don't need it; without
// registration, base returns a null-object.

import { BaseReader } from './baseReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerBaselineReader() {
  if (_registered) return;
  _registered = true;
  registerReader('base', (tables) => new BaseReader(tables));
}

export { BaseReader };
