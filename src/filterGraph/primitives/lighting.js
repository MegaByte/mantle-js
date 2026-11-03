// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/lighting.js — feDiffuseLighting + feSpecularLighting.
// One handler serves both node types (distinguished by node.type).
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  passthrough,
  setInMap,
  texelOf,
  rectOfRT,
} from '../svgFilterShared.js';
import { opSpace, srgbToLinear, CS_LINEAR } from '../colorSpace.js';

function feLightingDispatch(node, inputs, outRT, ctx) {
  const { gl, pool, feLightingProg, feLightingU, coverVao } = ctx;
  if (!feLightingProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  const isSpecular = node.type === 'feSpecularLighting';
  gl.useProgram(feLightingProg);
  gl.uniform1i(feLightingU.uIn, 0);
  setInMap(gl, feLightingU.uInMap, inputs[0], outRT, ctx);
  const [tx, ty] = texelOf(inputs[0], ctx);
  gl.uniform2f(feLightingU.uTexel, tx, ty); // sobel taps step ONE CANVAS PIXEL
  // Light positions are canvas-space, so the shader needs this pass's rect to
  // place the surface point it is lighting.
  const oR = rectOfRT(outRT);
  if (feLightingU.uOutRect) gl.uniform4f(feLightingU.uOutRect, oR[0], oR[1], oR[2], oR[3]);
  // Per-draw world scale keeps surface relief invariant under the
  // shape's worldMatrix (default [1,1] = identity → unchanged output).
  // The element's own scale (the importer's `ls`, under a transform on the element that references the filter) is part of it: the relief is
  // `surfaceScale` USER units per unit of alpha.
  const ls = p.ls || [1, 1];
  const ws = ctx.worldScale || [1, 1];
  if (feLightingU.uWorldScale) gl.uniform2f(feLightingU.uWorldScale, ws[0] * ls[0], ws[1] * ls[1]);
  // `??`, not `||`: surfaceScale 0 is a flat surface, and a diffuse or specular constant of 0 lights
  // nothing -- all three are legitimate, and `|| 1` would replace each with 1.
  gl.uniform1f(feLightingU.uSurfaceScale, p.surfaceScale ?? 1);
  // A SPECULAR CONSTANT OF 0 lights nothing, and Filter Effects' formula (S = ks * ..., alpha = max(S))
  // makes that a TRANSPARENT result -- the default. Chrome departs from it: Blink picks its lighting TYPE
  // by `specular_constant_ > 0` (fe_lighting.cc GetLightingType) and FESpecularLighting hands FELighting a
  // diffuse constant of 0, so a specular primitive with a constant of 0 (or a negative one, which it
  // clamps to 0) runs as DIFFUSE lighting with kd 0: black at alpha 1 over the whole subregion. Firefox and
  // Safari follow the formula (transparent). The importer marks a node `chromeSpecular` under
  // importSvg({ compat: 'chrome' }), and then this does what Blink does. specularExponent clamps to the
  // spec's range, 1..128, in both modes (so do Blink and WebKit; Gecko drops a primitive whose exponent is
  // outside it); `|| 1` would catch only 0.
  const ks = p.specularConstant ?? 1;
  const asDiffuse = isSpecular && p.chromeSpecular === true && !(ks > 0);
  gl.uniform1f(feLightingU.uK, isSpecular ? (asDiffuse ? 0 : ks) : (p.diffuseConstant ?? 1));
  gl.uniform1f(feLightingU.uExponent, Math.min(128, Math.max(1, p.specularExponent ?? 1)));
  let c = p.lightColor || [1, 1, 1, 1];
  // lighting-color is an sRGB color; in linearRGB the lighting equations run on its linear value and the result is tagged linear.
  if (opSpace(ctx) === CS_LINEAR)
    c = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]];
  gl.uniform4f(feLightingU.uLightColor, c[0], c[1], c[2], c[3]);
  gl.uniform1i(feLightingU.uMode, isSpecular && !asDiffuse ? 1 : 0);
  // light.type: 0 distant, 1 point, 2 spot
  const lt = p.lightType | 0;
  gl.uniform1i(feLightingU.uLightType, lt);
  // The pass works in GL space (y up, origin bottom-left); the node carries SVG space (y down). A distant light's
  // direction only flips y. A point or spot light's position and pointsAt are user-space points: the renderer's
  // lightToGL takes them to GL canvas px; without one (a bare context) the user unit is one px, y measured down
  // from the canvas top.
  const lp = p.lightPos || [0, 0, 0],
    sa = p.spotAt || [0, 0, 0];
  const toGL = ctx.lightToGL || ((x, y, z) => [x, (ctx.h || 0) - y, z]);
  const gp = lt === 0 ? [lp[0], -lp[1], lp[2]] : toGL(lp[0], lp[1], lp[2]);
  gl.uniform3f(feLightingU.uLightPos, gp[0], gp[1], gp[2]);
  const ga = lt === 2 ? toGL(sa[0], sa[1], sa[2]) : sa;
  gl.uniform3f(feLightingU.uSpotAt, ga[0], ga[1], ga[2]);
  // The surface point's height above the canvas plane: Filter Effects 1 (feDiffuseLighting, light vector) -- Lz = Light_z - Z(x, y) with
  // Z(x, y) = surfaceScale * A(x, y), in user units; px = user units * the same scale the light's z took (ctx.lightToGL).
  const zs = (ctx.lightZScale ? ctx.lightZScale() : 1) * Math.sqrt(ls[0] * ls[1]);
  if (feLightingU.uSurfaceZ)
    gl.uniform1f(feLightingU.uSurfaceZ, lt === 0 ? 0 : (p.surfaceScale ?? 1) * zs);
  gl.uniform1f(feLightingU.uSpotExp, p.spotExp || 0);
  // spotCosCone > 1 sentinel disables the cone (no falloff). The
  // importer maps limitingConeAngle to cos(angle) and writes 2.0 when
  // the attr is absent.
  gl.uniform1f(feLightingU.uSpotCosCone, p.spotCosCone !== undefined ? p.spotCosCone : 2.0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feDiffuseLighting', feLightingDispatch);
registerSvgFilter('feSpecularLighting', feLightingDispatch);
export { feLightingDispatch };
