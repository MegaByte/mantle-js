// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies feDiffuseLighting / feSpecularLighting honor world scale.
// These derive a surface normal from the input alpha treated as a
// height field, sampling the gradient over device texels; without
// folding world scale, a worldMatrix that shrinks the shape steepens
// the per-texel slope and changes the lit surface's appearance.
//
// The per-draw worldMatrix scale (ctx.worldScale) is plumbed into the
// lighting shader as `uWorldScale` and folds into the gradient, so
// surface relief tracks world scale. Identity worldMatrix → [1,1] →
// output unchanged.
//
// Unit test of that plumbing: drive feLightingDispatch with a recording
// fake-GL and assert uWorldScale receives ctx.worldScale verbatim. If
// uWorldScale is dropped, the GLSL uniform defaults to 0 → zero gradient
// → flat (ambient-only) lighting.

import { feLightingDispatch } from '../src/filterGraph/primitives/lighting.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

// Minimal recording fake-GL: captures uniform2f(loc, x, y) by location.
function makeGl() {
  const u2f = new Map();
  const noop = () => {};
  return {
    _u2f: u2f,
    useProgram: noop,
    activeTexture: noop,
    bindTexture: noop,
    bindVertexArray: noop,
    drawArrays: noop,
    bindFramebuffer: noop,
    viewport: noop,
    disable: noop,
    enable: noop,
    clearColor: noop,
    clear: noop,
    uniform1i: noop,
    uniform1f: noop,
    uniform4f: noop,
    uniform3f: noop,
    uniform2f: (loc, x, y) => {
      u2f.set(loc, [x, y]);
    },
    FRAMEBUFFER: 0,
    DEPTH_TEST: 0,
    STENCIL_TEST: 0,
    BLEND: 0,
    TEXTURE0: 0,
    TEXTURE_2D: 0,
    COLOR_BUFFER_BIT: 0,
    TRIANGLE_STRIP: 0,
  };
}

// Uniform-location sentinels (any unique objects/strings work).
const U = {
  uIn: 'uIn',
  uTexel: 'uTexel',
  uWorldScale: 'uWorldScale',
  uSurfaceScale: 'uSurfaceScale',
  uK: 'uK',
  uExponent: 'uExponent',
  uLightColor: 'uLightColor',
  uMode: 'uMode',
  uLightType: 'uLightType',
  uLightPos: 'uLightPos',
  uSpotAt: 'uSpotAt',
  uSpotExp: 'uSpotExp',
  uSpotCosCone: 'uSpotCosCone',
};

function runDispatch(worldScale) {
  const gl = makeGl();
  const ctx = {
    gl,
    // `size` is required: filter RTs gained canvas-space rect addressing
    // (svgFilterShared.rectOfRT), and an RT without one throws there.
    pool: { get: () => ({ tex: {}, fbo: {}, size: [16, 16] }) },
    feLightingProg: {}, // truthy → dispatch runs the shader path
    feLightingU: U,
    coverVao: {},
    sourceRT: { tex: {}, fbo: {}, size: [16, 16] },
  };
  if (worldScale !== undefined) ctx.worldScale = worldScale;
  const node = { type: 'feDiffuseLighting', params: { surfaceScale: 2 } };
  const inputs = [{ kind: 'rt', idx: 0 }];
  const outRT = { fbo: {}, size: [16, 16] };
  feLightingDispatch(node, inputs, outRT, ctx);
  return gl._u2f.get('uWorldScale');
}

// ---- T1: ctx.worldScale flows to uWorldScale verbatim -------------
{
  const ws = runDispatch([0.5, 0.5]);
  if (ws && Math.abs(ws[0] - 0.5) < 1e-9 && Math.abs(ws[1] - 0.5) < 1e-9)
    ok(`T1 worldScale [0.5,0.5] reaches uWorldScale (${ws[0]}, ${ws[1]})`);
  else
    fail(
      `T1 uWorldScale = ${ws ? `(${ws[0]}, ${ws[1]})` : 'UNSET'} (expected 0.5,0.5) — plumbing dropped`,
    );
}

// ---- T2: anisotropic world scale preserved per-axis ---------------
{
  const ws = runDispatch([2, 0.25]);
  if (ws && Math.abs(ws[0] - 2) < 1e-9 && Math.abs(ws[1] - 0.25) < 1e-9)
    ok(`T2 anisotropic worldScale preserved per-axis (${ws[0]}, ${ws[1]})`);
  else fail(`T2 uWorldScale = ${ws ? `(${ws[0]}, ${ws[1]})` : 'UNSET'} (expected 2, 0.25)`);
}

// ---- T3: missing ctx.worldScale defaults to identity [1,1] --------
// (Guards the GLSL-default-0 hazard: an unset uWorldScale would zero the
//  gradient and flatten lighting. The dispatch must always set [1,1].)
{
  const ws = runDispatch(undefined);
  if (ws && ws[0] === 1 && ws[1] === 1)
    ok('T3 absent worldScale defaults to identity [1,1] (no accidental flatten)');
  else fail(`T3 uWorldScale = ${ws ? `(${ws[0]}, ${ws[1]})` : 'UNSET'} (expected 1,1 default)`);
}

console.log();
console.log(
  failures === 0 ? 'FE-LIGHTING-WORLD-SCALE PASS' : `FE-LIGHTING-WORLD-SCALE FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
