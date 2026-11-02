// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// font/color — opt-in registration for color glyph readers.
//
//   import { registerColorEmojiReaders } from '@kontek/mantle/font/color';
//   registerColorEmojiReaders();
//
// Wires in the four OpenType color glyph formats so MantleFontAsset
// can return COLR (v0 layered + v1 paint graph), CBDT/CBLC (Noto),
// sbix (Apple Color Emoji), and SVG-in-OT (Twemoji) glyphs.
//
// Without this registration, font.colr/cbdt/sbix/svgInOt return
// null-objects (hasColor=false etc.) and the renderer falls back to
// monochrome outlines.

import { ColrReader } from './colrReader.js';
import { colrPaintToGraph } from './colrPaintToGraph.js';
import { SbixReader } from './sbixReader.js';
import { CbdtReader } from './cbdtReader.js';
import { EbdtReader } from './ebdtReader.js';
import { SvgInOtReader } from './svgInOtReader.js';
import { registerReader } from '../readerRegistry.js';

let _registered = false;

export function registerColorEmojiReaders() {
  if (_registered) return;
  _registered = true;
  registerReader('colr', (tables) => new ColrReader(tables));
  registerReader('colrPaintToGraph', colrPaintToGraph); // not a constructor — pure fn
  registerReader('sbix', (tables) => new SbixReader(tables));
  registerReader('cbdt', (tables) => new CbdtReader(tables));
  registerReader('ebdt', (tables) => new EbdtReader(tables));
  registerReader('svgInOt', (tables) => new SvgInOtReader(tables));
}

// Re-export the underlying reader classes for consumers that want to
// build their own font-asset shim (advanced use). Most consumers
// just call registerColorEmojiReaders() and use fontAsset.colr etc.
export { ColrReader, colrPaintToGraph, SbixReader, CbdtReader, EbdtReader, SvgInOtReader };
