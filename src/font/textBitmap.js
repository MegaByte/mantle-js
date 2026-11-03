// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { emitShape } from '../svg/buildContext.js';
import { mkLine } from '../svg/segment.js';
import { assertDecompressOutputSize } from '../core/decompress.js';
import { noteMalformedTable } from './fontTableGuard.js';
const rasterCaches = new WeakMap();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
function rasterFor(font, gid, glyph) {
  let cache = rasterCaches.get(font);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    rasterCaches.set(font, cache);
  }
  const key = gid + ':' + glyph.source + ':' + glyph.strikePpem;
  let entry = cache.entries.get(key);
  if (entry) {
    cache.entries.delete(key);
    cache.entries.set(key, entry);
    return entry.promise;
  }
  entry = { bytes: 0, promise: null };
  cache.entries.set(key, entry);
  entry.promise = (async () => {
    let raster;
    if (glyph.alphaBitmap) {
      const w = glyph.pixelWidth,
        h = glyph.pixelHeight;
      assertDecompressOutputSize(w * h * 4, 'bitmap glyph pixels');
      if (!w || !h || glyph.alphaBitmap.length !== w * h)
        throw new Error('Invalid bitmap glyph coverage');
      const rgba = new Uint8Array(w * h * 4);
      rgba.fill(255);
      for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = glyph.alphaBitmap[i];
      raster = { w, h, rgba };
    } else {
      const { decodePng } = await import('../core/png.js');
      raster = await decodePng(glyph.pngBytes);
    }
    if (cache.entries.get(key) === entry) {
      entry.bytes = raster.rgba.byteLength;
      if (entry.bytes > MAX_CACHE_BYTES) {
        cache.entries.delete(key);
        return raster;
      }
      cache.bytes += entry.bytes;
      while (
        cache.entries.size > 1 &&
        (cache.bytes > MAX_CACHE_BYTES || cache.entries.size > 128)
      ) {
        const first = cache.entries.keys().next().value,
          old = cache.entries.get(first);
        cache.entries.delete(first);
        cache.bytes -= old.bytes;
      }
    }
    return raster;
  })().catch((error) => {
    if (cache.entries.get(key) === entry) cache.entries.delete(key);
    throw error;
  });
  return entry.promise;
}
const rectangle = (a, b, c, d) => [mkLine(a, b), mkLine(b, c), mkLine(c, d), mkLine(d, a)];
export async function emitBitmapGlyphIfPresent(
  slot,
  font,
  ctx,
  gidBox,
  bboxBox,
  ox,
  oy,
  sx,
  sy,
  rotDeg,
  shearTan,
  shapeId,
  targetPpem = 32,
) {
  if (!font.hasBitmaps) return false;
  const glyph = font.getBitmapGlyphByGid(slot.glyphId, targetPpem);
  if (!glyph) return false;
  let raster;
  // An image that does not decode costs this glyph its bitmap: the caller goes on to the outline.
  try {
    raster = await rasterFor(font, slot.glyphId, glyph);
  } catch (error) {
    noteMalformedTable(
      font._tables,
      glyph.source === 'sbix' ? 'sbix' : glyph.source.toUpperCase(),
      error,
      'kept, this glyph without its bitmap',
    );
    return false;
  }
  const width = raster.w / glyph.strikePpem,
    height = raster.h / glyph.strikePpem;
  let left = glyph.originXEm,
    top = glyph.originYEm;
  if (glyph.source === 'sbix') {
    const outline = font.getMetricsByGid(slot.glyphId).bbox;
    left += outline[0];
    top += outline[1] + height;
  }
  const scaleX = sx * font.unitsPerEm,
    scaleY = sy * font.unitsPerEm,
    rad = (rotDeg * Math.PI) / 180,
    c = Math.cos(rad),
    s = Math.sin(rad);
  const point = (x, y) => {
    let a = x * scaleX,
      b = y * scaleY;
    a += b * shearTan;
    return [ox + c * a - s * b, oy - s * a - c * b];
  };
  const tl = point(left, top),
    tr = point(left + width, top),
    br = point(left + width, top - height),
    bl = point(left, top - height);
  const u = [tr[0] - tl[0], tr[1] - tl[1]],
    v = [bl[0] - tl[0], bl[1] - tl[1]],
    det = u[0] * v[1] - u[1] * v[0];
  if (!Number.isFinite(det) || det === 0) return true;
  const cache = ctx._bitmapImages || (ctx._bitmapImages = new WeakMap());
  let ids = cache.get(font);
  if (!ids) {
    ids = new Map();
    cache.set(font, ids);
  }
  const key = slot.glyphId + ':' + glyph.source + ':' + glyph.strikePpem;
  let imageId = ids.get(key);
  if (!imageId) {
    imageId = ctx.imagesUsed.length + 1;
    ctx.imagesUsed.push(raster);
    ids.set(key, imageId);
  }
  const color = glyph.source === 'ebdt' ? slot.style.color.slice() : [1, 1, 1, slot.style.color[3]],
    parent = ctx.metas.length;
  emitShape(ctx, rectangle(tl, tr, br, bl), { fillRgba: color, shapeId }, gidBox, bboxBox);
  const meta = ctx.metas[parent];
  if (u[1] === 0 && v[0] === 0 && u[0] > 0 && v[1] > 0) {
    meta.imageId = imageId;
    meta.imageRect = [tl[0], tl[1], u[0], v[1]];
  } else {
    // One local image child lets the existing pattern frame carry rotation/shear.
    const child = ctx.metas.length,
      inv = [v[1] / det, -u[1] / det, -v[0] / det, u[0] / det];
    meta.patInvLinear = inv;
    meta.imageRect = [inv[0] * tl[0] + inv[2] * tl[1], inv[1] * tl[0] + inv[3] * tl[1], 1, 1];
    meta.atlasSlot = [child + 1, child + 1, 0, 2];
    emitShape(
      ctx,
      rectangle([0, 0], [1, 0], [1, 1], [0, 1]),
      { fillRgba: [1, 1, 1, 1], flagsShape: 256, skipCoverQuad: true, parentIdx: parent },
      gidBox,
    );
    const image = ctx.metas[child];
    image.accumGroupId = 0;
    image.imageId = imageId;
    image.imageRect = [0, 0, 1, 1];
  }
  (ctx.bitmapGlyphs || (ctx.bitmapGlyphs = [])).push({
    row: parent,
    childRow: ctx.metas.length > parent + 1 ? parent + 1 : -1,
    imageId,
    origin: tl,
    u,
    v,
    color,
  });
  return true;
}
export function finishBitmapAtlas(ctx) {
  const images = ctx.imagesUsed;
  if (!images.length) return { imageAtlas: null, imageAtlasDim: null, imageAtlasRects: null };
  let width = 0,
    height = 0;
  const rects = [];
  for (const image of images) {
    width = Math.max(width, image.w);
    rects.push([height, image.w, image.h]);
    height += image.h;
  }
  assertDecompressOutputSize(width * height * 4, 'text image atlas');
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < images.length; i++) {
    const image = images[i],
      y = rects[i][0];
    for (let row = 0; row < image.h; row++)
      rgba.set(
        image.rgba.subarray(row * image.w * 4, (row + 1) * image.w * 4),
        (y + row) * width * 4,
      );
  }
  for (const meta of ctx.metas) {
    const id = meta.imageId || meta.strokeImageId;
    if (id > 0) {
      const rect = rects[id - 1];
      meta.atlasSlot = [...rect, (images[id - 1].isPattern ? 1 : 0) | (meta.pixelated ? 4 : 0)];
    }
  }
  return { imageAtlas: rgba.buffer, imageAtlasDim: [width, height], imageAtlasRects: rects };
}
