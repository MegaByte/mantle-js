// primitives/lighting.js — feDiffuseLighting + feSpecularLighting.
// One handler serves both node types (distinguished by node.type).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough } from '../svgFilterShared.js';

function feLightingDispatch(node, inputs, outRT, ctx) {
  const { gl, pool, feLightingProg, feLightingU, coverVao } = ctx;
  const [w, h] = outRT.size;
  if (!feLightingProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  const isSpecular = node.type === 'feSpecularLighting';
  gl.useProgram(feLightingProg);
  gl.uniform1i(feLightingU.uIn, 0);
  gl.uniform2f(feLightingU.uTexel, 1 / w, 1 / h);
  // Per-draw world scale keeps surface relief invariant under the
  // shape's worldMatrix (default [1,1] = identity → unchanged output).
  const ws = ctx.worldScale || [1, 1];
  if (feLightingU.uWorldScale) gl.uniform2f(feLightingU.uWorldScale, ws[0], ws[1]);
  gl.uniform1f(feLightingU.uSurfaceScale, p.surfaceScale || 1);
  gl.uniform1f(feLightingU.uK, isSpecular ? (p.specularConstant || 1) : (p.diffuseConstant || 1));
  gl.uniform1f(feLightingU.uExponent, p.specularExponent || 1);
  const c = p.lightColor || [1, 1, 1, 1];
  gl.uniform4f(feLightingU.uLightColor, c[0], c[1], c[2], c[3]);
  gl.uniform1i(feLightingU.uMode, isSpecular ? 1 : 0);
  // light.type: 0 distant, 1 point, 2 spot
  const lt = p.lightType | 0;
  gl.uniform1i(feLightingU.uLightType, lt);
  const lp = p.lightPos || [0, 0, 0];
  gl.uniform3f(feLightingU.uLightPos, lp[0], lp[1], lp[2]);
  const sa = p.spotAt || [0, 0, 0];
  gl.uniform3f(feLightingU.uSpotAt, sa[0], sa[1], sa[2]);
  gl.uniform1f(feLightingU.uSpotExp, p.spotExp || 0);
  // spotCosCone > 1 sentinel disables the cone (no falloff). The
  // importer maps limitingConeAngle to cos(angle) and writes 2.0 when
  // the attr is absent.
  gl.uniform1f(feLightingU.uSpotCosCone, (p.spotCosCone !== undefined) ? p.spotCosCone : 2.0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feDiffuseLighting', feLightingDispatch);
registerSvgFilter('feSpecularLighting', feLightingDispatch);
export { feLightingDispatch };
