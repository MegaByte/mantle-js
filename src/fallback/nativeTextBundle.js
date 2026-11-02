// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeTextBundle.js — text for the no-WebGL fallback.
//
// ONE text pipeline, two materializations: shaping + layout run through the
// same core the GL path uses (font/textSections.js — layout box, alignment,
// origin normalization, run metrics, markup, OpenType features), so a label
// styled with { align: 'center', layoutWidthPx } lands identically on both
// backends. Only the final step differs: the GL path uploads `sections` as
// textures via createBundle; here each glyph shape's curve range is decoded
// into an SVG <path> and assembled into an `svgSource` the native scene
// re-hosts. Outline paths and decoded bitmap glyphs use the shared text layout;
// rendering does not require the browser to have the font installed.
//
//   const tb = await createNativeTextBundle({ font, text: 'Hello',
//                                             style: { fill: [0,0,0,1], fontSizePx: 30 } });
//   scene.drawBundle(tb.bundle, { worldMatrix });   // bundle carries svgSource
//   await tb.setText('World');                       // re-shape + re-emit
//
// Same handle surface AND semantics as createTextBundle (bundle / setText /
// setStyle / fontMetrics / runMetrics / dispose) so a consumer is
// backend-agnostic.

import { buildTextSections, makeEmptyBundle } from '../font/textSections.js';
import { curveRangeToPathD } from './curveToPathD.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function rgbaToCss(c) {
  if (!c) return '#000';
  const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
  const a = c.length > 3 ? Math.max(0, Math.min(1, c[3])) : 1;
  return `rgba(${r},${g},${b},${a})`;
}

// Turn a shaped-text run (the raw textRun output: curveTexels + metaFloats +
// curveRangesByShape) into an SVG source string: one <path> per glyph shape,
// filled from its meta fillColor. The glyph curves are in em-space (+Y down),
// same as an imported SVG, so the emitted markup drops straight into a
// <g transform> like any bundle.
export function sectionsToSvgSource(sections) {
  // Sanitize the bbox: a zero/degenerate/non-finite extent (empty or
  // whitespace-only text, or a transient pre-shape read) would make a
  // 0×0 or invalid <svg viewBox>, which the browser won't rasterize.
  // Clamp width/height to a finite, strictly-positive minimum so the
  // emitted markup is always a valid SVG (glyph paths, if any, still use
  // their own coords). buildStyled already guarantees finiteness; this
  // also covers the zero-size case.
  const raw = sections.globalBBox || [0, 0, 1, 1];
  const x = Number.isFinite(raw[0]) ? raw[0] : 0;
  const y = Number.isFinite(raw[1]) ? raw[1] : 0;
  const w = Number.isFinite(raw[2]) && raw[2] > 0 ? raw[2] : 1e-3;
  const h = Number.isFinite(raw[3]) && raw[3] > 0 ? raw[3] : 1e-3;
  const bbox = [x, y, w, h];
  const vb = `${x} ${y} ${w} ${h}`;
  // curveFloats: buildStyled exposes curveTexels (unpadded Float32Array).
  const curveF =
    sections.curveTexels instanceof Float32Array
      ? sections.curveTexels
      : sections.curves
        ? new Float32Array(sections.curves)
        : new Float32Array(0);
  const ranges = sections.curveRangesByShape || [];
  const meta = sections.metaFloats instanceof Float32Array ? sections.metaFloats : null;
  const stride = sections.metaFloatsPerShape || 48;
  const ids = sections.shapeIds || [];
  const n = sections.numShapes | 0;

  const bitmaps = new Map((sections.bitmapGlyphs || []).map((g) => [g.row, g]));
  const bitmapChildren = new Set((sections.bitmapGlyphs || []).map((g) => g.childRow));
  const imageUrls = new Map();
  function bitmapUrl(glyph) {
    const key = glyph.imageId + ':' + glyph.color.slice(0, 3).join(',');
    if (imageUrls.has(key)) return imageUrls.get(key);
    const [atlasY, width, height] = sections.imageAtlasRects[glyph.imageId - 1];
    const atlasWidth = sections.imageAtlasDim[0],
      pixels = new Uint8Array(sections.imageAtlas);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d'),
      data = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const src = ((atlasY + y) * atlasWidth + x) * 4,
          dst = (y * width + x) * 4;
        for (let c = 0; c < 3; c++)
          data.data[dst + c] = Math.round(pixels[src + c] * glyph.color[c]);
        data.data[dst + 3] = pixels[src + 3];
      }
    ctx.putImageData(data, 0, 0);
    const url = canvas.toDataURL('image/png');
    imageUrls.set(key, url);
    return url;
  }
  let body = '';
  for (let i = 0; i < n; i++) {
    if (bitmapChildren.has(i)) continue;
    const bitmap = bitmaps.get(i);
    if (bitmap) {
      const { u, v, origin, color } = bitmap,
        id = ids[i] ? ` id="${ids[i]}"` : '';
      body += `<image${id} href="${bitmapUrl(bitmap)}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" opacity="${color[3]}" transform="matrix(${u[0]} ${u[1]} ${v[0]} ${v[1]} ${origin[0]} ${origin[1]})"/>`;
      continue;
    }
    const r = ranges[i];
    if (!r) continue;
    const d = curveRangeToPathD(curveF, r.begin, r.end);
    if (!d) continue;
    // Fill color from meta texel 1 (floats 4..7). Default black.
    // Alpha (float 7) is folded into the fill via rgbaToCss.
    let fill = '#000';
    if (meta) {
      const o = i * stride;
      fill = rgbaToCss([meta[o + 4], meta[o + 5], meta[o + 6], meta[o + 7]]);
    }
    // fill-rule from texel 3.y (float 13): 1 = evenodd.
    const evenOdd = meta && meta[i * stride + 13] >= 0.5;
    const id = ids[i] ? ` id="${ids[i]}"` : '';
    body += `<path${id} d="${d}" fill="${fill}"` + (evenOdd ? ' fill-rule="evenodd"' : '') + ' />';
  }
  // overflow="visible": the GL path never clips glyph ink to the bundle
  // bbox, and in layout-box mode (align within a fixed rect) the bbox IS
  // the layout box — ink can legitimately overhang it (italic tails,
  // tight boxes). A nested <svg> clips to its viewBox by default, which
  // would cut the overhang on native only.
  return (
    `<svg xmlns="${SVGNS}" viewBox="${vb}" ` +
    `width="${bbox[2]}" height="${bbox[3]}" overflow="visible">${body}</svg>`
  );
}

/** The raw textRun output after this module augments it. It mirrors a GL
 *  bundle's surface for the native scene and layout consumers, but the two
 *  fields added here are not part of what buildTextSections returns — declared
 *  so they are visible rather than bolted on invisibly.
 *
 *  @typedef {Record<string, any> & {
 *    numShapes: number,
 *    runMetrics: object|null,
 *    svgSource: string,
 *  }} NativeTextBundleSrc
 *  runMetrics is lifted off `sections` exactly as createBundle does on the GL
 *  path; svgSource is the markup the native scene clones. The index signature
 *  keeps the rest of the raw run's surface (globalBBox, shapeIds,
 *  curveRangesByShape, fontMetrics, …) reachable without restating it here.
 */

// Build a native text bundle from shaped text: the SHARED shaping core
// (identical layout semantics to the GL path), materialized as the raw
// textRun output + an svgSource for the native scene.
/** @returns {Promise<NativeTextBundleSrc>} */
async function buildNativeTextBundle(font, text, style, markup) {
  const { sections, bundleSrc } = await buildTextSections(font, text, style, markup);
  // Empty runs (no glyphs in the input font / text): same stub the GL path
  // returns, carrying font metrics for layout, plus a valid (blank) source.
  if (!bundleSrc || bundleSrc.numShapes === 0) {
    const empty = /** @type {NativeTextBundleSrc} */ (
      /** @type {unknown} */ (makeEmptyBundle(font))
    );
    empty.svgSource = `<svg xmlns="${SVGNS}" viewBox="0 0 1 1" width="1" height="1"></svg>`;
    return empty;
  }
  // The raw run carries everything the native scene + layout consumers read
  // (numShapes, globalBBox — the layout box when one was set — shapeIds,
  // curveRangesByShape, fontMetrics), mirroring a GL bundle's surface.
  // runMetrics is computed by the shared core on `sections`; surface it on
  // the bundle exactly like createBundle does on the GL path.
  const out = /** @type {NativeTextBundleSrc} */ (/** @type {unknown} */ (bundleSrc));
  out.runMetrics = sections.runMetrics || null;
  out.svgSource = sectionsToSvgSource(out);
  return out;
}

/**
 * Native text bundle. Same handle surface as createTextBundle (minus the
 * gl arg). The returned `bundle` carries `svgSource`, so it renders on the
 * native scene like any imported SVG.
 *
 * @param {object} opts
 * @param {object} opts.font    MantleFontAsset
 * @param {string} [opts.text]
 * @param {object} [opts.style] TextStyle (same contract as createTextBundle)
 * @param {boolean} [opts.markup] treat text as rich-text markup
 */
export async function createNativeTextBundle(opts) {
  if (!opts || !opts.font) throw new Error('createNativeTextBundle: opts.font required');
  const font = opts.font;
  const markup = !!opts.markup;
  let text = typeof opts.text === 'string' ? opts.text : '';
  let style = opts.style || {};

  let bundle = await buildNativeTextBundle(font, text, style, markup);
  let runMetrics = bundle.runMetrics || null;

  return {
    get bundle() {
      return bundle;
    },
    get text() {
      return text;
    },
    get style() {
      return style;
    },
    get font() {
      return font;
    },
    get fontMetrics() {
      return bundle ? bundle.fontMetrics : null;
    },
    get runMetrics() {
      return runMetrics;
    },

    // Same replace-semantics as the GL handle (style is REPLACED when
    // provided, not merged) so styling behaves identically per backend.
    async setText(newText, newStyle) {
      text = typeof newText === 'string' ? newText : '';
      if (newStyle != null) style = newStyle;
      bundle = await buildNativeTextBundle(font, text, style, markup);
      runMetrics = bundle.runMetrics || null;
      return bundle;
    },

    async setStyle(newStyle) {
      if (newStyle != null) style = newStyle;
      bundle = await buildNativeTextBundle(font, text, style, markup);
      runMetrics = bundle.runMetrics || null;
      return bundle;
    },

    dispose() {
      /* gl-free; nothing to release */
    },
  };
}
