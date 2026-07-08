// bidiRegistry.js — opt-in UAX #9 bidirectional algorithm.
//
// textRun / font/text consult this registry instead of statically
// importing bidi.js (class tables + W/N/I rules + L2 reorder). Default
// state: an LTR passthrough — every codepoint at embedding level 0,
// identity line order, base direction Ltr. This is correct for pure
// Latin / Cyrillic / Greek / CJK runs but WRONG for any Hebrew / Arabic
// / RTL-neutral text.
//
// Consumers with RTL or mixed-direction text opt in:
//
//   import { registerBidi } from '@kontek/mantle/font/typography/bidi';
//   registerBidi();
//
// The full `@kontek/mantle/font` barrel registers it for you. This is
// the one subsystem whose fallback changes *rendering* (re-ordering)
// rather than just disabling an optional feature, so import it whenever
// RTL input is possible.

import { BaseDirection } from './bidiConst.js';

const _LTR_FALLBACK = Object.freeze({
  // (baseDir, codepoints) → resolved base direction. LTR always.
  resolveBaseDirection() { return BaseDirection.Ltr; },
  // (codepoints, baseDir) → per-codepoint embedding levels. All 0.
  // Uint8Array so callers can `.subarray()` a per-line slice.
  resolveLevels(codepoints) { return new Uint8Array(codepoints.length); },
  // (levels) → logical→visual index order. Identity.
  reorderLine(levels) {
    const n = levels.length, order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    return order;
  },
  // (codepoint) → BidiClass. L (0) for everything under the fallback.
  getBidiClass() { return 0; },
  // (cls) → is the class a strong RTL type. Never, under LTR.
  isRtlStrong() { return false; },
});

let _impl = null;

/** Wire the real UAX #9 implementation. Called by font/typography/bidi. */
export function registerBidi(impl) { _impl = impl; }

/** The active bidi implementation (real if registered, else LTR fallback). */
export function getBidi() { return _impl || _LTR_FALLBACK; }
