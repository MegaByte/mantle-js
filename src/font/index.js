// Eagerly register every optional shaper + reader. Importing `font`
// pulls in everything. Consumers who want a smaller bundle should
// import the subset they need directly:
//
//   import { buildTextRun } from '@kontek/mantle/font/text';   // Latin-only
//   import { registerArabicShaping }       from '@kontek/mantle/font/scripts/arabic';
//   import { registerColorEmojiReaders }   from '@kontek/mantle/font/color';
//   import { registerVariableFontReaders } from '@kontek/mantle/font/variations';
//   import { registerMathReader }          from '@kontek/mantle/font/math';
//   registerArabicShaping();
//   registerColorEmojiReaders();
//   ...
//
// Each subpath is independently opt-in. The default (Latin-only)
// path through `font/text` skips every script shaper + every
// optional table reader. See `font/scripts/`, `font/color/`,
// `font/variations/`, `font/math/`, `font/formats/`,
// `font/typography/` for the per-subsystem entries.
import { registerAllScriptShapers } from './scripts/index.js';
import { registerColorEmojiReaders }   from './color/index.js';
import { registerVariableFontReaders } from './variations/index.js';
import { registerMathReader }          from './math/index.js';
import { registerCffReader }           from './formats/cff.js';
import { registerWoff2Reader }         from './formats/woff2.js';
import { registerLegacyKernReader }    from './typography/legacyKern.js';
import { registerVerticalReader }      from './typography/vertical.js';
import { registerBaselineReader }      from './typography/baseline.js';
import { registerJustificationReader } from './typography/justification.js';
import { registerAatReaders }          from './typography/aat.js';
import { registerBidi }                from './typography/bidi.js';
registerAllScriptShapers();
registerColorEmojiReaders();
registerVariableFontReaders();
registerMathReader();
registerCffReader();
registerWoff2Reader();
registerLegacyKernReader();
registerVerticalReader();
registerBaselineReader();
registerJustificationReader();
registerAatReaders();
registerBidi();

// Public API for the font subsystem of @kontek/mantle.
//
//   import {
//     MantleFontAsset,            // class wrapping a .ttf / .otf / .woff2 byte blob
//     decodeIfWoff2,               // transparent woff2 → sfnt decoder
//     ttcFaceCount,                // peek at .ttc collection size
//     buildFromMarkup,             // markup string + font → bundle dict
//     buildStyled,                 // pre-styled span list → bundle dict
//     buildTextRun,                // simple text + color → bundle dict
//     measureFromMarkup,           // layout-only metrics (no bundle build)
//     measureText,                 //
//     buildSvgTextGlyphs,          // per-glyph segs for SVG <text> importer
//     BaseDirection,               // UAX #9 base direction enum
//     resolveBaseDirection,        // first-strong / paragraph direction
//   } from '@kontek/mantle/font';
//
// All builders return a sections-shape bundle dict createBundle()
// accepts via `@kontek/mantle` itself — see textBundle.js for
// the end-to-end (font → renderable bundle) wrapper.

export { MantleFontAsset, decodeIfWoff2, ttcFaceCount } from './fontAsset.js';
export {
  buildTextRun, buildStyled, buildFromMarkup,
  measureText, measureFromMarkup, measureGlyphs, measureGlyphsFromText,
  buildSvgTextGlyphs,
} from './textRun.js';
export {
  BaseDirection, resolveBaseDirection, getBidiClass, isRtlStrong,
} from './bidi.js';
export {
  ArabicJoiningType, ArabicForm, getArabicJoiningType,
  isArabicCodepoint, resolveArabicForms,
} from './scripts/arabicJoining.js';
