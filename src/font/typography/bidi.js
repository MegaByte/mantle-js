// font/typography/bidi — opt-in UAX #9 bidirectional text.
//
//   import { registerBidi } from '@kontek/mantle/font/typography/bidi';
//   registerBidi();
//
// Wires the real bidi implementation (class tables + W/N/I weak/neutral
// resolution + L2 line reorder + paired-bracket N0 + isolates) into the
// text layout path. Without it, the lean text path falls back to LTR
// passthrough and RTL text renders in logical (wrong) order — see
// bidiRegistry.js.
//
// The full `@kontek/mantle/font` barrel calls this for you. Import this
// subpath directly only on the lean `@kontek/mantle/font/text` path
// when your text may contain Hebrew / Arabic / mixed direction.
//
// Bundle-size impact: ~30 KB minified of bidi-class tables + algorithm
// drops out for LTR-only consumers.

import {
  resolveBaseDirection, resolveLevels, reorderLine, getBidiClass, isRtlStrong,
} from '../bidi.js';
import { registerBidi as _registerBidiImpl } from '../bidiRegistry.js';

let _registered = false;

export function registerBidi() {
  if (_registered) return;
  _registered = true;
  _registerBidiImpl({
    resolveBaseDirection, resolveLevels, reorderLine, getBidiClass, isRtlStrong,
  });
}

// Re-export the raw helpers for consumers building their own pipeline.
export {
  resolveBaseDirection, resolveLevels, reorderLine, getBidiClass, isRtlStrong,
} from '../bidi.js';
export { BaseDirection } from '../bidiConst.js';
