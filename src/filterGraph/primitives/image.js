// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/image.js — feImage (sample an image-atlas slot as a filter
// source).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen, mapFor, rectOfRT } from '../svgFilterShared.js';

function feImage(node, inputs, outRT, ctx) {
  const { gl, feImageProg, feImageU, coverVao, bundle } = ctx;
  const p = node.params || {};
  const secondary = bundle?.imageAtlasSources?.[(p.imageId | 0) - 1] === 1;
  const atlasTex = secondary ? bundle?.secondaryImageAtlasTex : bundle?.imageAtlasTex;
  const atlasSize = (secondary ? bundle?.secondaryImageAtlasSize : bundle?.imageAtlasSize) || [
    0, 0,
  ];
  // No shader OR no atlas in this bundle → emit transparent black so
  // downstream nodes don't pull garbage. This is the spec's behavior
  // when the href fails to resolve.
  if (!feImageProg || !bundle || !atlasTex || !bundle.imageAtlasRects) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const slot = bundle.imageAtlasRects[(p.imageId | 0) - 1];
  if (!slot) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // An EXTERNAL image is placed per spec: fitted into the primitive subregion by preserveAspectRatio and
  // clipped to it (filterDraw.js _feImagePlacements resolves both to canvas px for this shape). One the
  // renderer could not place (a nine-sliced bundle) keeps the region fit below.
  const pl = p.external ? ctx.feImagePlacements && ctx.feImagePlacements[ctx._curIdx | 0] : null;
  if (pl && pl.empty) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const [atlasY, slotW, slotH] = slot;
  gl.useProgram(feImageProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.uniform1i(feImageU.uIn, 0);
  // The placed path maps the slot itself, from the atlas size and rect.
  gl.uniform2f(feImageU.uAtlasSize, atlasSize[0] || 1, atlasSize[1] || 1);
  gl.uniform4f(feImageU.uAtlasRect, atlasY, slotW, slotH, 0);
  if (feImageU.uPlaced) gl.uniform1i(feImageU.uPlaced, pl ? 1 : 0);
  if (pl) {
    const o = rectOfRT(outRT);
    if (feImageU.uOutRect) gl.uniform4f(feImageU.uOutRect, o[0], o[1], o[2], o[3]);
    if (feImageU.uImgRect)
      gl.uniform4f(feImageU.uImgRect, pl.img[0], pl.img[1], pl.img[2], pl.img[3]);
    if (feImageU.uClipRect)
      gl.uniform4f(feImageU.uClipRect, pl.sub[0], pl.sub[1], pl.sub[2], pl.sub[3]);
  }
  // The image is fitted to the filter region (the canvas), not to this pass's
  // output rect — which are the same thing only when the output covers it.
  const maps = feImageMaps(
    mapFor(rectOfRT(outRT), [0, 0, ctx.w, ctx.h]),
    p.preserveAR | 0,
    [atlasY, slotW, slotH],
    [atlasSize[0] || 1, atlasSize[1] || 1],
    ctx.w / Math.max(ctx.h, 1),
  );
  gl.uniform4f(feImageU.uImgMap, maps.img[0], maps.img[1], maps.img[2], maps.img[3]);
  gl.uniform4f(feImageU.uAtlasMap, maps.atlas[0], maps.atlas[1], maps.atlas[2], maps.atlas[3]);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

/// feImage's two maps, composed once per pass: `img` takes the pass's vUV to the
/// image's own [0,1]² -- the region map `regionMap` (vUV -> filter-region uv), then, with
/// `preserveAR` 1, 'xMidYMid meet' in the region (the longer side, relative to the region's, fills;
/// the other is centered) -- and `atlas` takes that to atlas uv for the slot (atlasY, atlasW, atlasH)
/// of an atlas atlasSize[0] x atlasSize[1], the image's top at the region's top.
///
export function feImageMaps(regionMap, preserveAR, slot, atlasSize, regionAspect = 1) {
  const [sx, sy, ox, oy] = regionMap;
  const [atlasY, atlasW, atlasH] = slot;
  let img = [sx, sy, ox, oy];
  if (preserveAR === 1) {
    const dstAR = regionAspect > 0 && Number.isFinite(regionAspect) ? regionAspect : 1;
    const r = atlasW / Math.max(atlasH, 1) / dstAR;
    // uv' = (uv - 0.5) * s + 0.5 on the letterboxed axis: the image is r times the region's aspect,
    // so it fills the width and takes 1/r of the height when r > 1 (s = r vertically), else fills the
    // height and takes r of the width (s = 1/r horizontally).
    if (r > 1) img = [sx, sy * r, ox, (oy - 0.5) * r + 0.5];
    else img = [sx / r, sy, (ox - 0.5) / r + 0.5, oy];
  }
  // The atlas holds each image as decoded, its TOP row first (texture row atlasY), and the pass's
  // uv.y runs UP the region: so uv.y 1 is the slot's first row and uv.y 0 its last. Reading row
  // atlasY + uv.y * atlasH would draw every region-fit image upside down; this reads
  // 1 - uv.y, as the placed path does.
  const ax = Math.max(atlasSize[0], 1),
    ay = Math.max(atlasSize[1], 1);
  return { img, atlas: [atlasW / ax, -atlasH / ay, 0, (atlasY + atlasH) / ay] };
}

registerSvgFilter('feImage', feImage);
export { feImage };
