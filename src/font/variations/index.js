// font/variations — opt-in registration for variable-font readers.
//
//   import { registerVariableFontReaders } from '@kontek/mantle/font/variations';
//   registerVariableFontReaders();
//
// Wires in fvar (axes + named instances), gvar (glyf outline point
// deltas), HVAR (horizontal metric deltas), VVAR (vertical metric
// deltas), MVAR (font-wide metric deltas), and STAT (style attributes).
//
// Without this registration, MantleFontAsset's fvar/hvar/vvar/mvar/
// stat getters return null-objects (isVariable=false, advanceDelta=0,
// etc.) and glyphReader skips gvar deltas — variable fonts render at
// their default axis values.
//
// Bundle-size impact: ~10 KB minified of variation reader code + the
// gvar reader + IVS / DeltaSetIndexMap infrastructure drops out for
// fixed-axis consumers.

import { FvarTable } from './fvarReader.js';
import { GvarTable } from './gvarReader.js';
import { HvarTable } from './hvarReader.js';
import { VvarTable } from './vvarReader.js';
import { MvarTable } from './mvarReader.js';
import { StatReader } from './statReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerVariableFontReaders() {
  if (_registered) return;
  _registered = true;
  registerReader('fvar', (tables) => new FvarTable(tables));
  registerReader('gvar', (tables) => new GvarTable(tables));
  registerReader('hvar', (tables) => new HvarTable(tables));
  registerReader('vvar', (tables) => new VvarTable(tables));
  registerReader('mvar', (tables) => new MvarTable(tables));
  registerReader('stat', (tables) => new StatReader(tables));
}

export { FvarTable, GvarTable, HvarTable, VvarTable, MvarTable, StatReader };
