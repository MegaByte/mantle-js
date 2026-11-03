// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/flood.js — feFlood (fill the filter region with one
// premultiplied color).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen } from '../svgFilterShared.js';

function feFlood(node, inputs, outRT, ctx) {
  const { gl } = ctx;
  // The color is stored as authored (sRGB) in any space: the graph tags a flood sRGB and a linearRGB consumer converts it where it reads it.
  const { rgba = [0, 0, 0, 1] } = node.params || {};
  beginFullscreen(gl, outRT);
  // Premultiply per SVG filter spec — feFlood emits premultiplied RGBA
  // throughout the filter graph (CSS Filter Effects §11).
  gl.clearColor(rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

registerSvgFilter('feFlood', feFlood);
export { feFlood };
