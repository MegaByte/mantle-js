// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from './contextResources.js';
import { uploadBuffer, uploadQueued } from './coopUpload.js';
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
  // PREPASS DEPTH IS WRITTEN 0.25 SHAPE-SPACINGS FARTHER THAN THE SHAPE'S OWN FILL DEPTH. The fill's vertex program computes z = 1 - shape / N in
  // its own shader, and a compiler (fast math: a divide turned into a reciprocal multiply) may round that float one ulp apart from this one. The fill
  // is drawn with LEQUAL against this depth, so a fill z one ulp ABOVE the prepass z fails in every certified interior cell and the shape draws as a
  // hollow outline. The margin is 0.25 / N:
  //   - the same shape's fill z = 1 - i/N <= this z = 1 - i/N + 0.25/N, so LEQUAL passes, with a margin far above float and depth-buffer noise
  //     (a 24-bit buffer resolves 1.2e-7 of z here, so 0.25/N exceeds one depth step for every N below about 2 million shapes; at 65536 shapes
  //     the margin is 3.8e-6, thirty float32 ulps). Beyond that the margin is lost in the noise and the depth test behaves as it would with no margin.
  //   - the previous shape's fill z = 1 - (i-1)/N = this z + 0.75/N is still behind it, so a later shape's cells still reject the fills under
  //     them: the occlusion semantics are unchanged. Margin and spacing scale together, so nothing here depends on the draw's size or scale.
  //   - shape 0: its fill z = 1 - 0/N is exactly 1.0 (0/N is exactly 0); min(., 1.0) keeps the prepass at exactly 1.0, never 1.0 + margin, so it
  //     is neither clipped by the far plane nor off by a margin. The gl_Position w is 1 for the affine world matrices this path takes, so the
  //     depth range maps z the same way for both passes (depthRange(0, 1) is never changed on the prepass or the fill path).
  float z = uNumShapes > 0.0 ? min(1.0 - aShape / uNumShapes + 0.25 / uNumShapes, 1.0) : 0.0;
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
  // Non-blocking mode: the uniform locations are asked once the program is ready (complete, GPU thread clear: gpuGate.js), not at creation: asking
  // at creation is a wait for the link. Until then the prepass declines, which is an optimization turned off, not a different picture.
  let U = null;
  const uniforms = () => {
    if (U) return U;
    if (R._nbNow() && !R._programReady(prog)) return null;
    U = {
      uGlobalBBox: gl.getUniformLocation(prog, 'uGlobalBBox'),
      uCanvasAR: gl.getUniformLocation(prog, 'uCanvasAR'),
      uNumShapes: gl.getUniformLocation(prog, 'uNumShapes'),
      uWorldM: gl.getUniformLocation(prog, 'uWorldM'),
      uHasWorldM: gl.getUniformLocation(prog, 'uHasWorldM'),
    };
    return U;
  };
  if (!R._nbNow()) uniforms(); // blocking mode: asked at creation

  // ONE MESH PER BUNDLE. A bundle's plan is uploaded once, into a buffer of its own, so a frame that draws several bundles with a plan binds
  // each one's mesh instead of uploading every plan again in every frame (a detailed asset's plan is hundreds of KB).
  // The bound: a mesh drawn in this frame or the previous one is never evicted by it, however many the frame draws (its working set);
  // beyond those, at most MESH_BOUND meshes stay, least recently drawn out first, so a scene that draws one such bundle holds one buffer.
  // A mesh's `frame` is the last frame that drew it (-1 for one drawn outside any frame: the bound alone keeps it). The memory budget may
  // free any mesh the current frame has not drawn (R._memEvictOpaquePrepass); the plan stays on the bundle, so a freed mesh is one upload
  // away. A disposed bundle's mesh goes with it.
  const MESH_BOUND = 1;
  const meshes = new Map(); // bundle -> { plan, vbo, vao, bytes, frame, t }, least recently drawn first
  const nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  function createVao(vbo) {
    const vao = trackGlResource(gl, gl.createVertexArray());
    R.glBindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    R.glBindVertexArray(null);
    return vao;
  }
  function dropMesh(m) {
    deleteGlResource(gl, 'VertexArray', m.vao);
    deleteGlResource(gl, 'Buffer', m.vbo);
  }
  function onBundleDisposed(bundle) {
    const m = meshes.get(bundle);
    if (m) {
      meshes.delete(bundle);
      dropMesh(m);
    }
  }
  function retireMesh(bundle, m) {
    meshes.delete(bundle);
    dropMesh(m);
    if (bundle._disposeHooks) bundle._disposeHooks.delete(onBundleDisposed);
  }
  /// The first frame whose meshes the bound keeps: inside a frame, the previous frame's (a mesh it drew may still be drawn later in this
  /// one); between frames, the frame just drawn (the next frame's working set).
  const keepFromFrame = () => (R._frameSerial | 0) - (R._frameOpen ? 1 : 0);
  /// Evict meshes drawn before `keepFrom`, least recently drawn first, until `room` more fit under the bound.
  function trimMeshes(room, keepFrom) {
    if (meshes.size + room <= MESH_BOUND) return;
    for (const [bundle, m] of meshes) {
      if (meshes.size + room <= MESH_BOUND) break;
      if (m.frame >= keepFrom) continue;
      retireMesh(bundle, m);
    }
  }
  /// The bundle's mesh of `plan`, uploaded on first use and marked drawn; null when the memory budget refuses it or while its upload is
  /// still being filled by the loading call (coopUpload.js): the prepass is then not drawn, which changes no pixel.
  function meshFor(bundle, plan) {
    let m = meshes.get(bundle);
    if (m && m.plan !== plan) {
      retireMesh(bundle, m);
      m = null;
    }
    if (m) {
      meshes.delete(bundle);
      meshes.set(bundle, m);
    } else {
      trimMeshes(1, keepFromFrame());
      const bytes = plan.verts.byteLength;
      if (R._memAdmit && !R._memAdmit(bytes, 'opaque prepass mesh')) return null;
      const vbo = trackGlResource(gl, gl.createBuffer(), 'fillStream');
      uploadBuffer(gl, vbo, plan.verts, gl.STATIC_DRAW); // (cooperative in the loading call: coopUpload.js)
      m = { plan, vbo, vao: createVao(vbo), bytes, frame: -1, t: 0 };
      meshes.set(bundle, m);
      (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add(onBundleDisposed);
    }
    if (R._frameOpen) m.frame = R._frameSerial | 0;
    m.t = nowMs();
    return uploadQueued(gl, m.vbo) ? null : m;
  }

  function drawStateAllowsPrepass() {
    const d = R.draw;
    return (
      !d.overrides &&
      d.alpha >= 0.996 &&
      !d.shapeRange &&
      !d.extClipTex &&
      !d.channelLerp &&
      !d.palette &&
      !d.colorMatrix &&
      !d.colorMatrixOffset
    );
  }

  function isFlatDrawList(bundle) {
    const ops = bundle.drawList;
    if (!ops || !ops.length) return false;
    const meta = bundle.metaFloats,
      stride = bundle.metaFloatsPerShape | 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (
        op.kind !== 'fillShape' ||
        op.filterId ||
        op.filterGraphId ||
        op.colrGraphId ||
        op.blendMode
      )
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
      const x0 = meta[o],
        y0 = meta[o + 1],
        x1 = meta[o + 2],
        y1 = meta[o + 3];
      const cw = (x1 - x0) / G,
        ch = (y1 - y0) / G;
      if (!(cw > 0 && ch > 0)) continue;
      minCell = Math.min(minCell, cw, ch);
      for (let gy = 0; gy < G; gy++)
        for (let gx = 0; gx < G; gx++) {
          const idx = gy * G + gx;
          if (!(curves[(base + (idx >> 2)) * 4 + (idx & 3)] > 0.5)) continue;
          const ax = x0 + gx * cw,
            ay = y0 + gy * ch,
            bx = ax + cw,
            by = ay + ch;
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
          for (let iy = iy0; iy <= iy1; iy++)
            for (let ix = ix0; ix <= ix1; ix++) gridBits[iy * OVERLAP_GRID + ix] = 1;
        }
    }
    if (cellCount < MIN_CELLS) return null;
    let occupied = 0;
    for (let i = 0; i < gridBits.length; i++) occupied += gridBits[i];
    const unionArea = occupied * ((gbb[2] * gbb[3]) / gridBits.length);
    if (!(unionArea > 0) || totalArea / unionArea < MIN_OVERLAP) return null;
    const verts = new Float32Array(cellCount * 18);
    let at = 0;
    // Count first, then write directly into the final GPU-upload buffer to
    // avoid a transient boxed vertex array when occupancy becomes ready.
    for (let s = 0; s < n; s++) {
      if (!live[s] || !isPlainOpaque(meta, stride, s)) continue;
      const o = s * stride;
      if ((Math.floor(meta[o + 27] + 0.5) & VECTOR_EFFECT_FLAGS) !== 0) continue;
      const base = Math.floor(meta[o + OCC_BASE] + 0.5),
        G = Math.floor(meta[o + OCC_GRID] + 0.5);
      if (!(base > 0 && G > 0)) continue;
      const x0 = meta[o],
        y0 = meta[o + 1],
        x1 = meta[o + 2],
        y1 = meta[o + 3];
      const cw = (x1 - x0) / G,
        ch = (y1 - y0) / G;
      if (!(cw > 0 && ch > 0)) continue;
      for (let gy = 0; gy < G; gy++)
        for (let gx = 0; gx < G; gx++) {
          const idx = gy * G + gx;
          if (!(curves[(base + (idx >> 2)) * 4 + (idx & 3)] > 0.5)) continue;
          const ax = x0 + gx * cw,
            ay = y0 + gy * ch,
            bx = ax + cw,
            by = ay + ch;
          verts[at++] = ax;
          verts[at++] = ay;
          verts[at++] = s;
          verts[at++] = bx;
          verts[at++] = ay;
          verts[at++] = s;
          verts[at++] = bx;
          verts[at++] = by;
          verts[at++] = s;
          verts[at++] = ax;
          verts[at++] = ay;
          verts[at++] = s;
          verts[at++] = bx;
          verts[at++] = by;
          verts[at++] = s;
          verts[at++] = ax;
          verts[at++] = by;
          verts[at++] = s;
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
    if (
      !bundle ||
      (handle.maskRegions && handle.maskRegions.length) ||
      // a mode-2 strip draw claims depth (clear + LESS) on the classic pass, which would wipe the prepass's depth
      bundle._stripModeNow === 2 ||
      // the plan's cells are in the bundle's authored frame; a nine-sliced draw moves the fills, so the depth would reject the wrong fragments
      bundle._nineSliceActive ||
      !drawStateAllowsPrepass() ||
      !isFlatDrawList(bundle)
    )
      return false;
    const plan = getPlan(bundle);
    if (!plan) return false;
    const u = uniforms();
    if (!u) return false;
    const { uGlobalBBox, uCanvasAR, uNumShapes, uWorldM, uHasWorldM } = u;
    const minPxPerEm = minLinearScalePx(R, bundle);
    // The prepass has no coverage ramp, so the smallest cell must stay more
    // than one AA pixel from every boundary after the full world transform.
    if (!(minPxPerEm > 0) || plan.minCell * minPxPerEm < 1.5) return false;
    const mesh = meshFor(bundle, plan);
    if (!mesh) return false;
    const [cw, ch] = viewportSize();
    const [sx, sy] = arScale(bundle.globalBBox, cw, ch);
    R.glUseProgram(prog);
    gl.uniform4f(
      uGlobalBBox,
      bundle.globalBBox[0],
      bundle.globalBBox[1],
      bundle.globalBBox[2],
      bundle.globalBBox[3],
    );
    gl.uniform2f(uCanvasAR, sx, sy);
    gl.uniform1f(uNumShapes, Math.max(1, bundle.numShapes));
    if (R.draw.worldM) {
      gl.uniformMatrix3fv(uWorldM, false, R.draw.worldM);
      gl.uniform1i(uHasWorldM, 1);
    } else {
      gl.uniform1i(uHasWorldM, 0);
    }
    R.glBindVertexArray(mesh.vao);
    R.glColorMask(false, false, false, false);
    R.glDisable(gl.BLEND);
    R.glDisable(gl.STENCIL_TEST);
    R.glEnable(gl.DEPTH_TEST);
    R.glDepthFunc(gl.LEQUAL);
    R.glDepthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, plan.count);
    R.glColorMask(true, true, true, true);
    R.glBindVertexArray(null);
    R._opaquePrepassActive = true;
    R._opaquePrepassCount = (R._opaquePrepassCount | 0) + 1;
    return true;
  }

  /// strictPlay's loading draws the depth-only prepass once (a triangle of a throwaway buffer, one pixel, no color), so its pipeline is built behind the loading
  /// screen: its first draw in play could otherwise be a fence of many seconds on a scene's first frame. False while its program is not ready.
  R.warmOpaquePrepass = () => {
    const u = uniforms();
    if (!u) return false;
    R.glUseProgram(prog);
    gl.uniform4f(u.uGlobalBBox, 0, 0, 1, 1);
    gl.uniform2f(u.uCanvasAR, 1, 1);
    gl.uniform1f(u.uNumShapes, 1);
    gl.uniform1i(u.uHasWorldM, 0);
    // (the meshes' vertex layout, on a buffer deleted once the draw is queued)
    const vbo = trackGlResource(gl, gl.createBuffer(), 'fillStream');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(36), gl.STATIC_DRAW);
    const vao = createVao(vbo);
    R.glBindVertexArray(vao);
    R.glColorMask(false, false, false, false);
    R.glDisable(gl.BLEND);
    R.glDisable(gl.STENCIL_TEST);
    R.glEnable(gl.DEPTH_TEST);
    R.glDepthFunc(gl.LEQUAL);
    R.glDepthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    R.glColorMask(true, true, true, true);
    R.glDisable(gl.DEPTH_TEST);
    R.glDepthMask(false);
    R.glBindVertexArray(null);
    dropMesh({ vao, vbo });
    return true;
  };
  R.runOpaquePrepass = runOpaquePrepass;
  /// The endFrame safe point: meshes beyond the bound that neither this frame nor the previous one drew go.
  R._opaquePrepassTrim = () => trimMeshes(0, (R._frameSerial | 0) - 1);
  /// The memory budget's evictor: drop meshes the current frame has not drawn, least recently drawn first. Returns the bytes freed.
  R._memEvictOpaquePrepass = (need, inUse) => {
    let freed = 0;
    for (const [bundle, m] of [...meshes]) {
      if (freed >= need) break;
      if (inUse(m.frame, m.t)) continue;
      freed += m.bytes;
      retireMesh(bundle, m);
    }
    return freed;
  };
  R.disposeOpaquePrepass = () => {
    deleteGlResource(gl, 'Program', prog);
    for (const [bundle, m] of [...meshes]) retireMesh(bundle, m);
  };
}
