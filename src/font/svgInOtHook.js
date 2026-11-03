// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgInOtHook.js — the registry slot for SVG-in-OT glyph import.
//
// An 'SVG ' table glyph is imported by the SVG importer, which is far larger than the rest of the text path. So text does
// not import it: `@kontek/mantle/font/color/svgInOtImport` fills this slot (the root and font barrels do), and a font with
// SVG glyphs and an empty slot warns once, naming that import.
let _emit = null;
export function registerSvgInOtEmitter(fn) {
  _emit = fn;
}
export function getSvgInOtEmitter() {
  return _emit;
}
