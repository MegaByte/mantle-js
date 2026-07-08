// font/text — text builder API without auto-registering all script
// shapers. Latin / Cyrillic / Greek / pure-CJK consumers should
// import from here:
//
//   import { MantleFontAsset, buildTextRun, buildFromMarkup }
//     from '@kontek/mantle/font/text';
//
// This entry never imports the script shaper modules. Consumers
// needing additional scripts opt in:
//
//   import { registerArabicShaping } from '@kontek/mantle/font/scripts/arabic';
//   registerArabicShaping();
//
// The script tables drop out of the bundle entirely when no scripts
// are registered.
//
// Compare with `@kontek/mantle/font` which auto-registers every
// script — "all scripts always on" for consumers that don't want to
// think about which scripts they need.

import { getBidi } from './bidiRegistry.js';

export { MantleFontAsset, decodeIfWoff2, ttcFaceCount } from './fontAsset.js';
export {
  buildTextRun, buildStyled, buildFromMarkup,
  measureText, measureFromMarkup, measureGlyphs, measureGlyphsFromText,
  buildSvgTextGlyphs,
} from './textRun.js';

// BaseDirection is a cheap shared constant. The bidi helper functions
// are registry-backed: they delegate to the real UAX #9 implementation
// once `@kontek/mantle/font/typography/bidi` (or the full `font`
// barrel) registers it, and to an LTR passthrough otherwise. This keeps
// the bidi tables out of the lean path until a consumer opts in.
export { BaseDirection } from './bidiConst.js';
export const resolveBaseDirection = (...a) => getBidi().resolveBaseDirection(...a);
export const getBidiClass        = (...a) => getBidi().getBidiClass(...a);
export const isRtlStrong         = (...a) => getBidi().isRtlStrong(...a);
