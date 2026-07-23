// opaquePrepass.js -- depth-only hidden-surface removal for flat opaque fills.
// Occupancy cells are certified one-cell inside a fill boundary. At a sufficient
// device size they are fully opaque, so depth can reject hidden fill fragments
// without touching analytic-AA edge pixels.

import { isPlainOpaque } from './occlusionCull.js';
import { minLinearScalePx } from './shapeScale.js';

const OCC_BASE = 20;
const OCC_GRID = 21;
const VECTOR_EFFECT_FLAGS = 1024 | 2048 | 4096;
const MIN_CELLS = 512;
const OVERLAP_GRID = 64;
const MIN_OVERLAP = 1.35;

const VERT = `#version 300 es
layout(location=0) in vec2 aEm;
layout(location=1) in float aShape;
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform float uNumShapes;
uniform mat3 uWorldM;
uniform int uHasWorldM;
void main() {
  vec2 uv = (aEm - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip = uWorldM * clip;
  float z = uNumShapes > 0.0 ? 1.0 - aShape / uNumShapes : 0.0;
  gl_Position = vec4(clip.xy, z, clip.z);
}`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0); }`;

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachOpaquePrepass(R) {
  const { gl, viewportSize, arScale } = R;
  const prog = R.program(VERT, FRAG, 'opaque-prepass');
  const uGlobalBBox = gl.getUniformLocation(prog, 'uGlobalBBox');
  const uCanvasAR = gl.getUniformLocation(prog, 'uCanvasAR');
  const uNumShapes = gl.getUniformLocation(prog, 'uNumShapes');
  const uWorldM = gl.getUniformLocation(prog, 'uWorldM');
  const uHasWorldM = gl.getUniformLocation(prog, 'uHasWorldM');
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  let uploadedPlan = null;

  function drawStateAllowsPrepass() {
    const d = R.draw;
    return !d.overrides && d.alpha >= 0.996 && !d.shapeRange
      && !d.extClipTex && !d.channelLerp && !d.palette
      && !d.colorMatrix && !d.colorMatrixOffset;
  }

  function isFlatDrawList(bundle) {
    const ops = bundle.drawList;
    if (!ops || !ops.length) return false;
    const meta = bundle.metaFloats, stride = bundle.metaFloatsPerShape | 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.kind !== 'fillShape' || op.filterId || op.filterGraphId || op.colrGraphId || op.blendMode)
        return false;
      const o = (op.shapeIdx | 0) * stride;
      // Mask baking re-enters the fill pass on an offscreen target. Keep this
      // optimization on the simple canvas-only path rather than coupling its
      // depth state to that separate lifecycle.
      if (!meta || Math.floor(meta[o + 30] + 0.5) !== 0 || Math.floor(meta[o + 31] + 0.5) !== 0)
        return false;
    }
    return true;
  }

  function buildPlan(bundle) {
    const meta = bundle.metaFloats;
    const stride = bundle.metaFloatsPerShape | 0;
    const curves = bundle.curveFloats;
    const n = bundle.numShapes | 0;
    const gbb = bundle.globalBBox;
    if (!meta || !curves || !gbb || !stride || !n || !(gbb[2] > 0) || !(gbb[3] > 0)) return null;

    const live = new Uint8Array(n);
    for (const op of bundle.drawList) live[op.shapeIdx | 0] = 1;
    const gridBits = new Uint8Array(OVERLAP_GRID * OVERLAP_GRID);
    let cellCount = 0;
    let totalArea = 0;
    let minCell = Number.POSITIVE_INFINITY;
    for (let s = 0; s < n; s++) {
      if (!live[s] || !isPlainOpaque(meta, stride, s)) continue;
      const o = s * stride;
      if ((Math.floor(meta[o + 27] + 0.5) & VECTOR_EFFECT_FLAGS) !== 0) continue;
      const base = Math.floor(meta[o + OCC_BASE] + 0.5);
      const G = Math.floor(meta[o + OCC_GRID] + 0.5);
      if (!(base > 0 && G > 0)) continue;
      const x0 = meta[o], y0 = meta[o + 1], x1 = meta[o + 2], y1 = meta[o + 3];
      const cw = (x1 - x0) / G, ch = (y1 - y0) / G;
      if (!(cw > 0 && ch > 0)) continue;
      minCell = Math.min(minCell, cw, ch);
      for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
        const idx = gy * G + gx;
        if (!(curves[(base + (idx >> 2)) * 4 + (idx & 3)] > 0.5)) continue;
        const ax = x0 + gx * cw, ay = y0 + gy * ch, bx = ax + cw, by = ay + ch;
        cellCount++;
        totalArea += cw * ch;
        let ix0 = Math.floor(((ax - gbb[0]) / gbb[2]) * OVERLAP_GRID);
        let iy0 = Math.floor(((ay - gbb[1]) / gbb[3]) * OVERLAP_GRID);
        let ix1 = Math.floor(((bx - gbb[0]) / gbb[2]) * OVERLAP_GRID);
        let iy1 = Math.floor(((by - gbb[1]) / gbb[3]) * OVERLAP_GRID);
        ix0 = Math.max(0, Math.min(OVERLAP_GRID - 1, ix0));
        iy0 = Math.max(0, Math.min(OVERLAP_GRID - 1, iy0));
        ix1 = Math.max(0, Math.min(OVERLAP_GRID - 1, ix1));
        iy1 = Math.max(0, Math.min(OVERLAP_GRID - 1, iy1));
        for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++)
          gridBits[iy * OVERLAP_GRID + ix] = 1;
      }
    }
    if (cellCount < MIN_CELLS) return null;
    let occupied = 0;
    for (let i = 0; i < gridBits.length; i++) occupied += gridBits[i];
    const unionArea = occupied * (gbb[2] * gbb[3] / gridBits.length);
    if (!(unionArea > 0) || totalArea / unionArea < MIN_OVERLAP) return null;
    const verts = new Float32Array(cellCount * 18);
    let at = 0;
    // Count first, then write directly into the final GPU-upload buffer to
    // avoid a transient boxed vertex array when occupancy becomes ready.
    for (let s = 0; s < n; s++) {
      if (!live[s] || !isPlainOpaque(meta, stride, s)) continue;
      const o = s * stride;
      if ((Math.floor(meta[o + 27] + 0.5) & VECTOR_EFFECT_FLAGS) !== 0) continue;
      const base = Math.floor(meta[o + OCC_BASE] + 0.5), G = Math.floor(meta[o + OCC_GRID] + 0.5);
      if (!(base > 0 && G > 0)) continue;
      const x0 = meta[o], y0 = meta[o + 1], x1 = meta[o + 2], y1 = meta[o + 3];
      const cw = (x1 - x0) / G, ch = (y1 - y0) / G;
      if (!(cw > 0 && ch > 0)) continue;
      for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
        const idx = gy * G + gx;
        if (!(curves[(base + (idx >> 2)) * 4 + (idx & 3)] > 0.5)) continue;
        const ax = x0 + gx * cw, ay = y0 + gy * ch, bx = ax + cw, by = ay + ch;
        verts[at++] = ax; verts[at++] = ay; verts[at++] = s;
        verts[at++] = bx; verts[at++] = ay; verts[at++] = s;
        verts[at++] = bx; verts[at++] = by; verts[at++] = s;
        verts[at++] = ax; verts[at++] = ay; verts[at++] = s;
        verts[at++] = bx; verts[at++] = by; verts[at++] = s;
        verts[at++] = ax; verts[at++] = by; verts[at++] = s;
      }
    }
    return {
      verts,
      count: cellCount * 6,
      minCell,
      geomGen: bundle._geomGen | 0,
      cullGen: bundle._cullGen | 0,
    };
  }

  function getPlan(bundle) {
    // Bits land asynchronously; wait so a partial plan is never cached.
    if (!bundle.hasOccupancy || bundle._occupancyBuildPending) return null;
    const old = bundle._opaquePrepassPlan;
    if (old && old.geomGen === (bundle._geomGen | 0) && old.cullGen === (bundle._cullGen | 0))
      return old.none ? null : old;
    const plan = buildPlan(bundle);
    bundle._opaquePrepassPlan = plan || {
      none: true,
      geomGen: bundle._geomGen | 0,
      cullGen: bundle._cullGen | 0,
    };
    return plan;
  }

  function runOpaquePrepass(handle) {
    R._opaquePrepassActive = false;
    const bundle = handle && handle.bundle;
    if (!bundle || (handle.maskRegions && handle.maskRegions.length)
      || !drawStateAllowsPrepass() || !isFlatDrawList(bundle)) return false;
    const plan = getPlan(bundle);
    if (!plan) return false;
    const minPxPerEm = minLinearScalePx(R, bundle);
    // The prepass has no coverage ramp, so the smallest cell must stay more
    // than one AA pixel from every boundary after the full world transform.
    if (!(minPxPerEm > 0) || plan.minCell * minPxPerEm < 1.5) return false;
    if (uploadedPlan !== plan) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, plan.verts, gl.STATIC_DRAW);
      uploadedPlan = plan;
    }
    const [cw, ch] = viewportSize();
    const [sx, sy] = arScale(bundle.globalBBox, cw, ch);
    gl.useProgram(prog);
    gl.uniform4f(uGlobalBBox, bundle.globalBBox[0], bundle.globalBBox[1], bundle.globalBBox[2], bundle.globalBBox[3]);
    gl.uniform2f(uCanvasAR, sx, sy);
    gl.uniform1f(uNumShapes, Math.max(1, bundle.numShapes));
    if (R.draw.worldM) {
      gl.uniformMatrix3fv(uWorldM, false, R.draw.worldM);
      gl.uniform1i(uHasWorldM, 1);
    } else {
      gl.uniform1i(uHasWorldM, 0);
    }
    gl.bindVertexArray(vao);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, plan.count);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(null);
    R._opaquePrepassActive = true;
    R._opaquePrepassCount = (R._opaquePrepassCount | 0) + 1;
    return true;
  }

  R.runOpaquePrepass = runOpaquePrepass;
  R.disposeOpaquePrepass = () => {
    gl.deleteProgram(prog);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(vbo);
    uploadedPlan = null;
  };
}
