// primitives/image.js — feImage (sample an image-atlas slot as a filter
// source).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen } from '../svgFilterShared.js';

function feImage(node, inputs, outRT, ctx) {
  const { gl, feImageProg, feImageU, coverVao, bundle } = ctx;
  const p = node.params || {};
  // No shader OR no atlas in this bundle → emit transparent black so
  // downstream nodes don't pull garbage. This is the spec's behavior
  // when the href fails to resolve.
  if (!feImageProg || !bundle || !bundle.imageAtlasTex || !bundle.imageAtlasRects) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const slot = bundle.imageAtlasRects[(p.imageId | 0) - 1];
  if (!slot) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const [atlasY, slotW, slotH] = slot;
  gl.useProgram(feImageProg);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bundle.imageAtlasTex);
  gl.uniform1i(feImageU.uIn, 0);
  gl.uniform2f(feImageU.uAtlasSize, bundle.imageAtlasSize[0] || 1, bundle.imageAtlasSize[1] || 1);
  gl.uniform4f(feImageU.uAtlasRect, atlasY, slotW, slotH, 0);
  gl.uniform1i(feImageU.uPreserveAR, p.preserveAR | 0);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feImage', feImage);
export { feImage };
