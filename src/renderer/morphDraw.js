// morphDraw.js — Loop-Blinn morph, signed morph RT path, bundle LB routes.

import { buildLoopBlinnMesh, refreshLoopBlinnMesh, packLoopBlinnMesh, curveRangeToContours, LB_VERT_FLOATS, buildLoopBlinnPartitionPair } from './loopBlinn.js';
import { setLbPreparer, setLbBuilder, enqueueLbPrepare } from './bundle.js';
import { SEG_LINE } from '../primitives/seg.js';
// The pure fill-route predicates + Slug sentinel live in lbBuildCore.js (the
// GL-free build core, also imported by the LB worker) so the static, morph, and
// worker build paths can't drift. Aliased to the historic underscore names.
import {
  contoursAllStraight as _contoursAllStraight,
  hasDisjointContours as _hasDisjointContours,
  hasCurvedHoles as _hasCurvedHoles,
  SLUG as LB_SLUG,
} from './lbBuildCore.js';
import { requestLbBuild } from './lbWorkerPool.js';

// GLOBAL mesh cache: FNV(curve span)+route bits → {raw, pk} | null(=Slug);
// LRU ≤768. MUST live at MODULE level: declared any narrower it is recreated
// empty on every ensure, and per-frame gen bumps on morph/timeline bundles
// would then rebuild every shape from scratch each frame. (The worker path
// makes draw-time builds rare;
// this still serves the synchronous prewarm + morph endpoints.)
const _lbMeshCache = new Map();
const SLUG = LB_SLUG;

import { buildMorphStroke, segmentPartitionPairMorph, buildEarcutPair } from './loopBlinnMorph.js';
import { mantleDebugFlag } from '../core/diagnostics.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMorphDraw(R) {
    // Loop-Blinn hybrid fill uniforms + dedicated VAO/VBO. The coverage pass
    // reuses the em→NDC projection uniforms (bbox/canvasAR/worldM); the
    // composite samples the coverage RT and applies the paint color.
    R.lbUGBB = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uGlobalBBox')   : null;
    R.lbUOvrTex = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uOverrideTex') : null;
    R.lbUHasOvr = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uLbHasOvr') : null;
    R.lbUCanvasAR = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uCanvasAR')     : null;
    R.lbUWorldM = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uWorldM')       : null;
    R.lbUHasWorldM = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uHasWorldM')   : null;
    R.lbUViewport = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uViewportSize') : null;
    R.lbUDirect = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uDirect')      : null;
    R.lbUAlpha = R.lbProg ? R.gl.getUniformLocation(R.lbProg, 'uAlpha')       : null;
    // Static-program gradient/image uniforms (loopBlinn.frag already supports
    // them — the per-shape direct draw _drawLBShapeDirect wires them; the
    // combined route leaves them 0). Solid paint rides the constant aColor
    // attribute (location 7), so no uColor.
    const _lbU = (nm) => R.lbProg ? R.gl.getUniformLocation(R.lbProg, nm) : null;
    R.lbUGradId = _lbU('uGradId');
    R.lbUShapeBBox = _lbU('uShapeBBox');
    R.lbUGradientTex = _lbU('uGradientTex');
    R.lbUGradientStops = _lbU('uGradientStops');
    R.lbUImageId = _lbU('uImageId');
    R.lbUImgRect = _lbU('uImgRect');
    R.lbUAtlasSlot = _lbU('uAtlasSlot');
    R.lbUImageTex = _lbU('uImageTex');
    R.lbUImageAtlasSize = _lbU('uImageAtlasSize');
    // Per-draw recolor (channel-lerp + color-matrix) on the combined/direct route,
    // so a solid recolored bundle batches into one draw instead of per-shape.
    R.lbUCLPrimary = _lbU('uChannelLerpPrimary');
    R.lbUCLContrast = _lbU('uChannelLerpContrast');
    R.lbUCLHighlight = _lbU('uChannelLerpHighlight');
    R.lbUCLEnabled = _lbU('uChannelLerpEnabled');
    R.lbUCMatrix = _lbU('uColorMatrix');
    R.lbUCMatrixOffset = _lbU('uColorMatrixOffset');
    R.lbUCMatrixEnabled = _lbU('uColorMatrixEnabled');
    // Set the lbProg recolor uniforms from the current draw (enable=false forces
    // them OFF, so the direct path can't inherit a prior combined draw's recolor).
    R._setLbRecolor = (enable) => {
      const cl = enable ? R.draw.channelLerp : null;
      if (R.lbUCLEnabled) {
        if (cl) {
          const p = cl.primary || [0, 0, 0, 1], c = cl.contrast || [0, 0, 0, 1], h = cl.highlight || [1, 1, 1, 1];
          R.gl.uniform4f(R.lbUCLPrimary, p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
          R.gl.uniform4f(R.lbUCLContrast, c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
          R.gl.uniform4f(R.lbUCLHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
          R.gl.uniform1i(R.lbUCLEnabled, 1);
        } else R.gl.uniform1i(R.lbUCLEnabled, 0);
      }
      const cm = enable ? R.draw.colorMatrix : null, cmo = enable ? R.draw.colorMatrixOffset : null;
      if (R.lbUCMatrixEnabled) {
        if (cm || cmo) {
          R.gl.uniformMatrix4fv(R.lbUCMatrix, false, cm || R.IDENTITY_COLOR_MATRIX);
          R.gl.uniform4fv(R.lbUCMatrixOffset, cmo || R.ZERO_OFFSET);
          R.gl.uniform1i(R.lbUCMatrixEnabled, 1);
        } else R.gl.uniform1i(R.lbUCMatrixEnabled, 0);
      }
    };
    // LEAN program uniforms (same names, different program → different locations).
    R.lbLeanUGBB       = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uGlobalBBox')  : null;
    R.lbLeanUCanvasAR  = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uCanvasAR')    : null;
    R.lbLeanUWorldM    = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uWorldM')      : null;
    R.lbLeanUHasWorldM = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uHasWorldM')   : null;
    R.lbLeanUViewport  = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uViewportSize'): null;
    R.lbLeanUDirect    = R.lbProgLean ? R.gl.getUniformLocation(R.lbProgLean, 'uDirect')      : null;
    R.lbcUCoverage = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uCoverage') : null;
    R.lbcUColor = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uColor')    : null;
    let _lbVao = null, _lbBuf = null, _lbCap = 0;
    // Per-packed-mesh GL objects: the shared _lbBuf + bufferSubData-per-draw pattern
    // re-uploaded every per-shape mesh EVERY frame (6.5% of Contextual's whole profile
    // was bufferSubData). Packed records are immutable post-cache (streaming repacks
    // return fresh wrappers), so each uploads once. Buffers ride the record — shared
    // cache entries share one buffer across bundles.
    function _bindPackedVao(packed) {
      let g = packed._gl;
      if (!g) {
        g = packed._gl = { vao: R.gl.createVertexArray(), buf: R.gl.createBuffer() };
        R.gl.bindVertexArray(g.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, g.buf);
        _specLbAttribs();
        R.gl.bufferData(R.gl.ARRAY_BUFFER, packed.verts, R.gl.STATIC_DRAW);
      } else {
        R.gl.bindVertexArray(g.vao);
      }
    }
    function _ensureLbVao() {
      if (_lbVao) return;
      _lbVao = R.gl.createVertexArray();
      _lbBuf = R.gl.createBuffer();
      R.gl.bindVertexArray(_lbVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbBuf);
      const FS = 24 * 4;   // R.LB_VERT_FLOATS * 4 bytes
      R.gl.bindVertexArray(null);
      _specLbAttribs();
    }
    function _specLbAttribs() {
      const FS = 24 * 4;   // R.LB_VERT_FLOATS * 4 bytes
      R.gl.enableVertexAttribArray(0); R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, FS, 0);
      R.gl.enableVertexAttribArray(1); R.gl.vertexAttribPointer(1, 3, R.gl.FLOAT, false, FS, 8);   // aTC vec3
      R.gl.enableVertexAttribArray(2); R.gl.vertexAttribPointer(2, 2, R.gl.FLOAT, false, FS, 20);  // aFlags
      R.gl.enableVertexAttribArray(3); R.gl.vertexAttribPointer(3, 4, R.gl.FLOAT, false, FS, 28);
      R.gl.enableVertexAttribArray(4); R.gl.vertexAttribPointer(4, 4, R.gl.FLOAT, false, FS, 44);
      R.gl.enableVertexAttribArray(5); R.gl.vertexAttribPointer(5, 4, R.gl.FLOAT, false, FS, 60);
      R.gl.enableVertexAttribArray(6); R.gl.vertexAttribPointer(6, 4, R.gl.FLOAT, false, FS, 76);
      R.gl.enableVertexAttribArray(8); R.gl.vertexAttribPointer(8, 1, R.gl.FLOAT, false, FS, 92);  // aSeamM (pad float): kind-5 rquad mean(R)
    }
    // GPU-resident LB morph resources: program uniforms, a 10-float morph VAO, and
    // a per-primitive control-point data texture (RGBA32F, src texels then dst).
// (legacy lbMorphProg uniform table deleted with the fast/CDT morph draw)
    R.morphStrokeU = R.morphStrokeProg ? {
      uT: R.gl.getUniformLocation(R.morphStrokeProg, 'uT'),
      uPrim: R.gl.getUniformLocation(R.morphStrokeProg, 'uPrim'),
      uPrimW: R.gl.getUniformLocation(R.morphStrokeProg, 'uPrimW'),
      uHalfW: R.gl.getUniformLocation(R.morphStrokeProg, 'uHalfW'),
      uMiterLimit: R.gl.getUniformLocation(R.morphStrokeProg, 'uMiterLimit'),
      uCapStyle: R.gl.getUniformLocation(R.morphStrokeProg, 'uCapStyle'),
      uJoinStyle: R.gl.getUniformLocation(R.morphStrokeProg, 'uJoinStyle'),
      uDashId: R.gl.getUniformLocation(R.morphStrokeProg, 'uDashId'),
      uDashTex: R.gl.getUniformLocation(R.morphStrokeProg, 'uDashTex'),
      uGBB: R.gl.getUniformLocation(R.morphStrokeProg, 'uGlobalBBox'),
      uCanvasAR: R.gl.getUniformLocation(R.morphStrokeProg, 'uCanvasAR'),
      uWorldM: R.gl.getUniformLocation(R.morphStrokeProg, 'uWorldM'),
      uHasWorldM: R.gl.getUniformLocation(R.morphStrokeProg, 'uHasWorldM'),
      uViewport: R.gl.getUniformLocation(R.morphStrokeProg, 'uViewportSize'),
    } : null;
    // ── PARTITION MORPH PAIR (one code path: the static builder/packer/frag serve
    // morphs; only the VS lerps). The pair VBO interleaves the two STATIC packs
    // per vertex ([src 24f | dst 24f], stride 192B); the MANTLE_LB_MORPH_PAIR
    // VS variant mixes each attribute by uMorphT and runs the static body.
    let _lbppVao = null, _lbppBuf = null, _lbppCap = 0, _lbppResident = null;
    function _ensureLbPairProg() {
      if (R.lbPairProg !== undefined) return R.lbPairProg;
      try {
        R.lbPairProg = R.program
          ? R.program(R.withDefines(R.shaderSources.loopBlinnVert, ['MANTLE_LB_MORPH_PAIR']), R.shaderSources.loopBlinnFrag, 'loopBlinnPartitionPair')
          : null;
      } catch { R.lbPairProg = null; }
      if (R.lbPairProg) {
        const g = R.gl, P = R.lbPairProg;
        R.lbppU = {
          uGBB: g.getUniformLocation(P, 'uGlobalBBox'), uCanvasAR: g.getUniformLocation(P, 'uCanvasAR'),
          uWorldM: g.getUniformLocation(P, 'uWorldM'), uHasWorldM: g.getUniformLocation(P, 'uHasWorldM'),
          uViewport: g.getUniformLocation(P, 'uViewportSize'), uDirect: g.getUniformLocation(P, 'uDirect'),
          uAlpha: g.getUniformLocation(P, 'uAlpha'), uMorphT: g.getUniformLocation(P, 'uMorphT'),
          uLbHasOvr: g.getUniformLocation(P, 'uLbHasOvr'), uGradId: g.getUniformLocation(P, 'uGradId'),
          uImageId: g.getUniformLocation(P, 'uImageId'), uDashId: g.getUniformLocation(P, 'uDashId'),
          uShapeBBox: g.getUniformLocation(P, 'uShapeBBox'), uGradientTex: g.getUniformLocation(P, 'uGradientTex'),
          uGradientStops: g.getUniformLocation(P, 'uGradientStops'), uImgRect: g.getUniformLocation(P, 'uImgRect'),
          uAtlasSlot: g.getUniformLocation(P, 'uAtlasSlot'), uImageTex: g.getUniformLocation(P, 'uImageTex'),
        };
      }
      return R.lbPairProg;
    }
    function _ensureLbppVao() {
      if (_lbppVao) return;
      _lbppVao = R.gl.createVertexArray();
      _lbppBuf = R.gl.createBuffer();
      R.gl.bindVertexArray(_lbppVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbppBuf);
      const FS = 48 * 4;   // [src 24f | dst 24f]
      const A = (loc, n, off) => { R.gl.enableVertexAttribArray(loc); R.gl.vertexAttribPointer(loc, n, R.gl.FLOAT, false, FS, off); };
      A(0, 2, 0); A(1, 3, 8); A(2, 2, 20); A(3, 4, 28); A(4, 4, 44); A(5, 4, 60); A(6, 4, 76); A(8, 1, 92);      // A-stream
      A(10, 2, 96); A(11, 3, 104); A(12, 4, 124); A(13, 4, 140); A(14, 4, 156); A(15, 4, 172);                    // B-stream
      R.gl.bindVertexArray(null);
    }
    function _interleavePair(pkS, pkD) {
      const n = pkS.vertexCount, F = LB_VERT_FLOATS;
      const v = new Float32Array(n * F * 2);
      for (let i = 0; i < n; i++) {
        v.set(pkS.verts.subarray(i * F, i * F + F), i * F * 2);
        v.set(pkD.verts.subarray(i * F, i * F + F), i * F * 2 + F);
      }
      return v;
    }
    function _bindPairMesh(mesh) {
      _ensureLbppVao();
      R.gl.bindVertexArray(_lbppVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbppBuf);
      if (_lbppResident !== mesh) {
        if (mesh.vbo.length > _lbppCap) { R.gl.bufferData(R.gl.ARRAY_BUFFER, mesh.vbo, R.gl.STATIC_DRAW); _lbppCap = mesh.vbo.length; }
        else R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, mesh.vbo);
        _lbppResident = mesh;
      }
    }
    // COVERAGE pass for a pair mesh (composed/translucent morphs): same program,
    // uDirect=0 → the static frag emits raw coverage; MAX blend into a pooled RT
    // exactly like the legacy morph cov pass — the composite stage is shared.
    function _renderPairCovRT(meshIn, tIn, bbox, worldM) {
      const _sg9 = _morphFillSeg(meshIn, tIn), mesh = _sg9.mesh, t = _sg9.lt;
      if (R._contextLost || !_ensureLbPairProg() || !mesh || !mesh.vertexCount) return -1;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return -1;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      _bindPairMesh(mesh);
      const rtIdx = R._covPool.acquire(cw, ch);
      const rt = R._covPool.get(rtIdx);
      // a FIRST-TIME acquire just created the RT texture — creation leaves it
      // BOUND on the active unit, and rendering to an attachment that is also
      // bound to a sampler-reachable unit is a feedback loop → the whole draw
      // is INVALID_OPERATION and the first composed morph frame rendered blank.
      // (Pooled reuse doesn't rebind, which is why it self-healed after frame 1;
      // the legacy cov pass masks this by binding its prim texture over unit 0.)
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops || null);
      R.bindFb(R.gl.FRAMEBUFFER, rt.fbo);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.disable(R.gl.DEPTH_TEST); R.gl.depthMask(false); R.gl.disable(R.gl.CULL_FACE);
      R.gl.colorMask(true, true, true, true);
      R.gl.disable(R.gl.STENCIL_TEST);
      R.gl.clearColor(0, 0, 0, 0); R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.MAX); R.gl.blendFunc(R.gl.ONE, R.gl.ONE);
      R.gl.useProgram(R.lbPairProg);
      const U = R.lbppU;
      R.gl.uniform1f(U.uMorphT, t);
      R.gl.uniform4f(U.uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.uCanvasAR, sx, sy);
      R.gl.uniform2f(U.uViewport, cw, ch);
      if (U.uDirect) R.gl.uniform1i(U.uDirect, 0);
      if (U.uAlpha) R.gl.uniform1f(U.uAlpha, 1);
      if (U.uLbHasOvr) R.gl.uniform1i(U.uLbHasOvr, 0);
      if (U.uGradId) R.gl.uniform1i(U.uGradId, 0);
      if (U.uImageId) R.gl.uniform1i(U.uImageId, 0);
      if (U.uDashId) R.gl.uniform1i(U.uDashId, 0);
      if (worldM && U.uWorldM) { R.gl.uniformMatrix3fv(U.uWorldM, false, worldM); R.gl.uniform1i(U.uHasWorldM, 1); }
      else if (U.uHasWorldM) R.gl.uniform1i(U.uHasWorldM, 0);
      R.gl.disableVertexAttribArray(7); R.gl.vertexAttrib4f(7, 1, 1, 1, 1);
      R.gl.disableVertexAttribArray(9); R.gl.vertexAttrib1f(9, 0);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, mesh.vertexCount);
      R.gl.bindVertexArray(null);
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      return rtIdx;
    }
    function _drawLbPartitionPair(meshIn, tIn, o) {
      const _sg9 = _morphFillSeg(meshIn, tIn), mesh = _sg9.mesh, t = _sg9.lt;
      if (R._contextLost || !_ensureLbPairProg() || !mesh || !mesh.vertexCount) return false;
      const bbox = o.bbox;
      if (!bbox) return false;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return false;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      _bindPairMesh(mesh);
      R.gl.viewport(0, 0, cw, ch);
      // the same depth-claim cascade as the static LB draws (the pair packs
      // ARE static packs): pieces reject the interiors' fringe wherever their
      // coverage is authoritative; kind-9/10 claim rules apply identically.
      R.gl.enable(R.gl.DEPTH_TEST); R.gl.depthFunc(R.gl.LEQUAL); R.gl.depthMask(true);
      R.gl.clearDepth(1.0); R.gl.clear(R.gl.DEPTH_BUFFER_BIT);
      R.gl.colorMask(true, true, true, true);
      R.gl.disable(R.gl.STENCIL_TEST);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      R.gl.useProgram(R.lbPairProg);
      const U = R.lbppU;
      R.gl.uniform1f(U.uMorphT, t);
      R.gl.uniform4f(U.uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.uCanvasAR, sx, sy);
      R.gl.uniform2f(U.uViewport, cw, ch);
      if (U.uDirect) R.gl.uniform1i(U.uDirect, 1);
      if (U.uAlpha) R.gl.uniform1f(U.uAlpha, o.alpha == null ? 1 : o.alpha);
      if (U.uLbHasOvr) R.gl.uniform1i(U.uLbHasOvr, 0);
      if (U.uDashId) R.gl.uniform1i(U.uDashId, 0);
      // direct paint: solid (vColor), gradient (uGradId + shape bbox + LUTs),
      // or image (atlas rect/slot) — the same emit() the static direct uses.
      const gradId = (o.gradId | 0) > 0 && o.gradientTex ? (o.gradId | 0) : 0;
      if (U.uGradId) R.gl.uniform1i(U.uGradId, gradId);
      if (gradId) {
        const sb = o.shapeBBox || bbox;
        R.gl.uniform4f(U.uShapeBBox, sb[0], sb[1], sb[2], sb[3]);
        R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, o.gradientTex); R.gl.uniform1i(U.uGradientTex, 1);
        R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, o.gradientStopsTex); R.gl.uniform1i(U.uGradientStops, 2);
      }
      const imageId = (o.imageId | 0) > 0 && o.imageTex ? (o.imageId | 0) : 0;
      if (U.uImageId) R.gl.uniform1i(U.uImageId, imageId);
      if (imageId) {
        R.gl.uniform4f(U.uImgRect, o.imgRect[0], o.imgRect[1], o.imgRect[2], o.imgRect[3]);
        R.gl.uniform4f(U.uAtlasSlot, o.atlasSlot[0], o.atlasSlot[1], o.atlasSlot[2], o.atlasSlot[3]);
        R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, o.imageTex); R.gl.uniform1i(U.uImageTex, 3);
      }
      const wm = o.worldMatrix || null;
      if (wm && U.uWorldM) { R.gl.uniformMatrix3fv(U.uWorldM, false, wm); R.gl.uniform1i(U.uHasWorldM, 1); }
      else if (U.uHasWorldM) R.gl.uniform1i(U.uHasWorldM, 0);
      const c = o.color || [0, 0, 0, 1];
      R.gl.disableVertexAttribArray(7); R.gl.vertexAttrib4f(7, c[0], c[1], c[2], c[3]);
      R.gl.disableVertexAttribArray(9); R.gl.vertexAttrib1f(9, 0);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, mesh.vertexCount);
      R.gl.enableVertexAttribArray(7);
      R.gl.bindVertexArray(null);
      return true;
    }
    // Route VAO: the 24-float geometry + a per-vertex RGBA paint (loc 7) → the
    // whole bundle draws in ONE drawArrays (no per-shape uniform/draw overhead).
    function _specRouteAttribs() {
      const FS = 29 * 4;   // 24 geometry + 4 colour floats + shapeRow
      R.gl.enableVertexAttribArray(0); R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, FS, 0);
      R.gl.enableVertexAttribArray(1); R.gl.vertexAttribPointer(1, 3, R.gl.FLOAT, false, FS, 8);   // aTC vec3
      R.gl.enableVertexAttribArray(2); R.gl.vertexAttribPointer(2, 2, R.gl.FLOAT, false, FS, 20);  // aFlags
      R.gl.enableVertexAttribArray(3); R.gl.vertexAttribPointer(3, 4, R.gl.FLOAT, false, FS, 28);
      R.gl.enableVertexAttribArray(4); R.gl.vertexAttribPointer(4, 4, R.gl.FLOAT, false, FS, 44);
      R.gl.enableVertexAttribArray(5); R.gl.vertexAttribPointer(5, 4, R.gl.FLOAT, false, FS, 60);
      R.gl.enableVertexAttribArray(6); R.gl.vertexAttribPointer(6, 4, R.gl.FLOAT, false, FS, 76);
      R.gl.enableVertexAttribArray(7); R.gl.vertexAttribPointer(7, 4, R.gl.FLOAT, false, FS, 96);
      R.gl.enableVertexAttribArray(8); R.gl.vertexAttribPointer(8, 1, R.gl.FLOAT, false, FS, 92);  // aSeamM (pad float): kind-5 rquad mean(R)
      R.gl.enableVertexAttribArray(9); R.gl.vertexAttribPointer(9, 1, R.gl.FLOAT, false, FS, 112); // aShapeRow (combined route only)
    }
    function drawLoopBlinnMesh(mesh, opts) {
      if (R._contextLost || !R.lbProg || !R.lbCompProg || !mesh) return false;
      const packed = mesh.verts ? mesh : R.packLoopBlinnMesh(mesh);
      if (!packed.vertexCount) return false;
      const o = opts || {};
      const bbox = o.bbox;
      if (!bbox) return false;
      const color = o.color || [0, 0, 0, 1];
      const worldM = o.worldMatrix || null;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return false;
      const [sx, sy] = R.arScale(bbox, cw, ch);
  
      _bindPackedVao(packed);
  
      // --- Pass 1: analytic coverage → R8 cov RT (MAX blend). ---
      const rtIdx = R._covPool.acquire(cw, ch);
      const rt = R._covPool.get(rtIdx);
      R.bindFb(R.gl.FRAMEBUFFER, rt.fbo);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.disable(R.gl.DEPTH_TEST);
      R.gl.depthMask(false);
      R.gl.clearColor(0, 0, 0, 0);
      R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND);
      R.gl.blendEquation(R.gl.MAX);
      R.gl.blendFunc(R.gl.ONE, R.gl.ONE);
      // Pick the LEAN program for a cusp-free mesh (no kind-4 verts); same VBO.
      const lean = !packed.hasBezout && R.lbProgLean;
      const prog = lean ? R.lbProgLean : R.lbProg;
      const uGBB = lean ? R.lbLeanUGBB : R.lbUGBB;
      const uCanvasAR = lean ? R.lbLeanUCanvasAR : R.lbUCanvasAR;
      const uViewport = lean ? R.lbLeanUViewport : R.lbUViewport;
      const uDirect = lean ? R.lbLeanUDirect : R.lbUDirect;
      const uWorldM = lean ? R.lbLeanUWorldM : R.lbUWorldM;
      const uHasWorldM = lean ? R.lbLeanUHasWorldM : R.lbUHasWorldM;
      R.gl.useProgram(prog);
      R.gl.uniform4f(uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(uCanvasAR, sx, sy);
      R.gl.uniform2f(uViewport, cw, ch);
      R.gl.uniform1i(uDirect, 0);
      if (worldM) { R.gl.uniformMatrix3fv(uWorldM, false, worldM); R.gl.uniform1i(uHasWorldM, 1); }
      else R.gl.uniform1i(uHasWorldM, 0);
      _bindPackedVao(packed);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, packed.vertexCount);
  
      // --- Pass 2: composite paint × coverage onto the canvas (OVER blend). ---
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      R.gl.useProgram(R.lbCompProg);
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, rt.tex);
      R.gl.uniform1i(R.lbcUCoverage, 0);
      R.gl.uniform4f(R.lbcUColor, color[0], color[1], color[2], color[3]);
      R.gl.bindVertexArray(R.coverVao);
      R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
      R.gl.bindVertexArray(null);
      // Unbind the coverage texture from unit 0: this RT goes back to the pool, and
      // the NEXT drawLoopBlinnMesh's pass-1 may re-acquire it as its render target.
      // If it were still bound here, that pass-1 draw would form a framebuffer↔texture
      // FEEDBACK LOOP (GL_INVALID_OPERATION → the draw is dropped → blank coverage).
      R.gl.bindTexture(R.gl.TEXTURE_2D, null);
  
      R._covPool.release(rtIdx);
      if (R._handle) R._handle.fillPassAssetDirty = true;   // next Slug pass rebinds
      return true;
    }
  
    // GPU-resident Loop-Blinn morph draw. Same 2-pass coverage→composite as
    // drawLoopBlinnMesh, but the morph vertex shader lerps control points by `t`
    // and recomputes klmn/edge-normals — so an animated morph reuses ONE static
    // mesh with zero CPU rebuild. `morph` = R.buildLoopBlinnMorph(...) output; its
    // VBO + per-primitive control-point texture are uploaded once and cached on it.
    // Resolve a (possibly interval-split) morph FILL mesh + global t to the
    // concrete sub-segment and its LOCAL t. A classification-changing morph is
    // stored as { segments:[{tLo,tHi,tLoB,tHiB,...meshFields}] } (loopBlinnMorph
    // partitionMorph): pick the segment whose draw range [tLo,tHi] owns t, then
    // remap t into its BUILD range [tLoB,tHiB]. The segment's sign/topology is
    // baked from [tLoB,tHiB] (a MARGIN inside the interval, where the curve is
    // unambiguously convex/concave), but its geometry must span the FULL [tLo,
    // tHi]. Because the VS lerp mix(src,dst,uT) is LINEAR, localT is left
    // UNCLAMPED: for t in the margin seam it EXTRAPOLATES (uT<0 or >1) to the
    // exact shape at t — so the seam is exact, not a frozen near-straight frame.
    // (partitionMorph caps the margin at ¼ the interval → localT ∈ [-0.5,1.5],
    // a bounded extrapolation that never folds the reused triangulation.) A
    // stable morph (no .segments) passes straight through. Each segment is a full
    // mesh object (vbo/prim/vertexCount/_primTex), so the existing bind logic —
    // keyed on `_lbmResident !== mesh` — swaps VBOs only when t crosses a seam.
    function _morphFillSeg(m, t) {
      const segs = m && m.segments;
      if (!segs) return { mesh: m, lt: t };
      let seg = segs[segs.length - 1];
      for (let i = 0; i < segs.length; i++) if (t <= segs[i].tHi) { seg = segs[i]; break; }
      const span = seg.tHiB - seg.tLoB;
      return { mesh: seg, lt: span > 1e-9 ? (t - seg.tLoB) / span : 0 };
    }


    let _fillLBCovProg, _lbcU = null;
    const FILL_UNIFORM_NAMES = ['uCurveData', 'uBandData', 'uMetaTex', 'uDashTex', 'uGlobalBBox',
      'uNumShapes', 'uShapeIdxOverride', 'uCanvasAR', 'uViewportSize', 'uGradientTex', 'uGradientStops',
      'uGradientStopsCount', 'uGradientCount', 'uImageTex', 'uImageAtlasSize', 'uFilterTex', 'uOverrideTex',
      'uHasOverrides', 'uHasEmCoord', 'uDrawAlpha', 'uWorldM', 'uHasWorldM', 'uMaskRTArray',
      'uMaskRowToLayerTex', 'uHasOffscreenMask', 'uHasOccupancy', 'uColorMatrixEnabled', 'uColorMatrix',
      'uColorMatrixOffset', 'uPalette', 'uPaletteEnabled', 'uPaletteChannel', 'uPaletteSize',
      'uChannelLerpEnabled', 'uChannelLerpPrimary', 'uChannelLerpContrast', 'uChannelLerpHighlight',
      'uExtClipTex', 'uExtClipMode', 'uLBCovTex', 'uStrokeCovTex',
      'uCoverBBox', 'uLBShapeBBox', 'uLBFill', 'uLBStroke', 'uLBImageRect', 'uLBCovTexSize'];
    function _ensureFillLBCovProg() {
      if (_fillLBCovProg !== undefined) return _fillLBCovProg;
      // Strip ext-clip (gated off in drawBundle's morph branch) + pattern (excluded
      // by eligibility). RECOLOR (palette/colorMatrix/channelLerp) is KEPT: per-draw
      // recolor composes over the analytic fill for static/streamed bundles (the
      // uniforms are coherent → disabled = free, so the morph route, which excludes
      // recolor, pays nothing). One palette sampler → 14 units, under the 16 ceiling.
      const defs = ['MANTLE_LB_COV', 'MANTLE_NO_EXTCLIP', 'MANTLE_NO_PATTERN']
        .concat(R.opts.fillDefines || []);
      // BOTH stages get the define: the VERT expands a static unit quad from
      // uCoverBBox (no per-frame quad upload); the FRAG sources fCov/strokeCov +
      // morph paint from uniforms (no per-frame meta upload).
      const vs = R.compile(R.withDefines(R.shaderSources.fillVert, defs), R.gl.VERTEX_SHADER);
      const fs = R.compile(R.withDefines(R.shaderSources.fillFrag, defs), R.gl.FRAGMENT_SHADER);
      const p = R.gl.createProgram();
      R.gl.attachShader(p, vs); R.gl.attachShader(p, fs); R.gl.linkProgram(p);
      if (!R.gl.getShaderParameter(vs, R.gl.COMPILE_STATUS) || !R.gl.getShaderParameter(fs, R.gl.COMPILE_STATUS)
          || !R.gl.getProgramParameter(p, R.gl.LINK_STATUS)) {
        R.mantleWarn('[Mantle] MANTLE_LB_COV fill variant failed to build; clip/mask/filter morphs fall back to Slug.',
          R.gl.getShaderInfoLog(vs), R.gl.getShaderInfoLog(fs), R.gl.getProgramInfoLog(p));
        R._pendingShaders.length = 0; R._pendingPrograms.length = 0;
        return (_fillLBCovProg = null);
      }
      R._pendingShaders.length = 0; R._pendingPrograms.length = 0;   // validated inline
      const U = {};
      for (const n of FILL_UNIFORM_NAMES) U[n] = R.gl.getUniformLocation(p, n);
      _lbcU = U;
      return (_fillLBCovProg = p);
    }
  
    // Render morph FILL coverage into a pooled RGBA8 RT (screen space), returning
    // the pool index (release after the composed draw). FAST mesh: loopBlinn.frag
    // emit(cov) with uDirect=0 + MAX blend = the union coverage. SIGNED mesh
    // (inversion/serpentine/fold): the 2-pass signed accumulate → cover |Σ| path,
    // with the cover pass writing COVERAGE (white paint, blend off → cov in .r)
    // into the pooled RT instead of compositing to the canvas. So clip/mask
    // compose across ALL morph classes, not just fast.

    // Render STROKE coverage for one shape's stroke mesh into a pooled
    // RGBA8 RT (MAX blend = the round-cap/round-join distance-field union). The VS
    // lerps the segment control points by t; the frag distance-fields the morphed
    // curve at uHalfW. Returns the pool index, or -1 if unavailable.
    let _lbmsVao = null, _lbmsBuf = null, _lbmsCap = 0, _lbmsResident = null;
    function _ensureLbmsVao() {
      if (_lbmsVao) return;
      _lbmsVao = R.gl.createVertexArray();
      _lbmsBuf = R.gl.createBuffer();
      R.gl.bindVertexArray(_lbmsVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbmsBuf);
      R.gl.enableVertexAttribArray(0); R.gl.vertexAttribPointer(0, 1, R.gl.FLOAT, false, 16, 0);
      R.gl.enableVertexAttribArray(1); R.gl.vertexAttribPointer(1, 1, R.gl.FLOAT, false, 16, 4);
      R.gl.enableVertexAttribArray(2); R.gl.vertexAttribPointer(2, 1, R.gl.FLOAT, false, 16, 8);
      R.gl.enableVertexAttribArray(3); R.gl.vertexAttribPointer(3, 1, R.gl.FLOAT, false, 16, 12);
      R.gl.bindVertexArray(null);
    }
    function _renderMorphStrokeCovRT(sMesh, t, halfW, bbox, worldM, dashTex) {
      if (!sMesh || !R.morphStrokeProg || !(halfW > 0)) return -1;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return -1;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      _ensureLbmsVao();
      R.gl.bindVertexArray(_lbmsVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbmsBuf);
      if (_lbmsResident !== sMesh) {
        if (sMesh.vbo.length > _lbmsCap) { R.gl.bufferData(R.gl.ARRAY_BUFFER, sMesh.vbo, R.gl.STATIC_DRAW); _lbmsCap = sMesh.vbo.length; }
        else R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, sMesh.vbo);
        _lbmsResident = sMesh;
      }
      if (!sMesh._primTex) {
        const tex = R.gl.createTexture();
        R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
        R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA32F, sMesh.primW, sMesh.primH, 0, R.gl.RGBA, R.gl.FLOAT, sMesh.prim);
        sMesh._primTex = tex;
      }
      const rtIdx = R._covPool.acquire(cw, ch);
      const rt = R._covPool.get(rtIdx);
      R.bindFb(R.gl.FRAMEBUFFER, rt.fbo);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.disable(R.gl.DEPTH_TEST); R.gl.depthMask(false); R.gl.disable(R.gl.CULL_FACE);
      R.gl.clearColor(0, 0, 0, 0); R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.MAX); R.gl.blendFunc(R.gl.ONE, R.gl.ONE);
      R.gl.useProgram(R.morphStrokeProg);
      R.gl.uniform1f(R.morphStrokeU.uT, t);
      R.gl.uniform1i(R.morphStrokeU.uPrimW, sMesh.primW | 0);
      R.gl.uniform1f(R.morphStrokeU.uHalfW, halfW);
      if (R.morphStrokeU.uMiterLimit) R.gl.uniform1f(R.morphStrokeU.uMiterLimit, sMesh.miterLimit || 4);
      if (R.morphStrokeU.uCapStyle) R.gl.uniform1i(R.morphStrokeU.uCapStyle, sMesh.capStyle | 0);
      if (R.morphStrokeU.uJoinStyle) R.gl.uniform1i(R.morphStrokeU.uJoinStyle, sMesh.joinStyle | 0);
      // Dashes: dashId>0 → the VS prefix-sums arc length + the frag gates on the
      // dash pattern (uDashTex). dashTex bound even when off (sampler needs a binding).
      const dashId = (sMesh.dashId | 0) > 0 && dashTex ? (sMesh.dashId | 0) : 0;
      if (R.morphStrokeU.uDashId) R.gl.uniform1i(R.morphStrokeU.uDashId, dashId);
      R.gl.uniform4f(R.morphStrokeU.uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(R.morphStrokeU.uCanvasAR, sx, sy);
      R.gl.uniform2f(R.morphStrokeU.uViewport, cw, ch);
      if (worldM) { R.gl.uniformMatrix3fv(R.morphStrokeU.uWorldM, false, worldM); R.gl.uniform1i(R.morphStrokeU.uHasWorldM, 1); }
      else R.gl.uniform1i(R.morphStrokeU.uHasWorldM, 0);
      R.gl.activeTexture(R.gl.TEXTURE0); R.gl.bindTexture(R.gl.TEXTURE_2D, sMesh._primTex); R.gl.uniform1i(R.morphStrokeU.uPrim, 0);
      if (R.morphStrokeU.uDashTex) { R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, dashTex || R.dummyDashTex); R.gl.uniform1i(R.morphStrokeU.uDashTex, 1); }
      R.gl.bindVertexArray(_lbmsVao);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, sMesh.vertexCount);
      R.gl.bindVertexArray(null);
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      return rtIdx;
    }
  
    // Per-shape composed cover quad (morphed AABB + shapeIdx), drawn through the
    // MANTLE_LB_COV variant sampling covTex. Mirrors beginFillPass's bundle-texture
    // binding with every per-draw recolor/override/mask path forced OFF (the morph
    // route excludes them); LB coverage rides on TEXTURE11 (free — the default fill
    // pass uses 0-10, 13, 14).
    // STATIC unit-quad VBO (built ONCE): aPos = unit corners (0/1), aNormal =
    // outward bisector. The MANTLE_LB_COV vert expands aPos to the morphed AABB via
    // uCoverBBox, and shapeIdx comes from uShapeIdxOverride — so a composed shape
    // needs NO per-frame vertex/index upload (only uniforms change).
    let _lbcQuadVao = null, _lbcQuadBuf = null;
    function _ensureLbcQuadVao() {
      if (_lbcQuadVao) return;
      _lbcQuadVao = R.gl.createVertexArray();
      _lbcQuadBuf = R.gl.createBuffer();
      R.gl.bindVertexArray(_lbcQuadVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbcQuadBuf);
      R.gl.bufferData(R.gl.ARRAY_BUFFER, new Float32Array([
        0, 0, -1, -1,  1, 0, 1, -1,  1, 1, 1, 1,
        0, 0, -1, -1,  1, 1, 1, 1,   0, 1, -1, 1,
      ]), R.gl.STATIC_DRAW);
      R.gl.enableVertexAttribArray(0); R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, 16, 0);
      R.gl.enableVertexAttribArray(1); R.gl.vertexAttribPointer(1, 2, R.gl.FLOAT, false, 16, 8);
      R.gl.bindVertexArray(null);
    }
    // coverBBox = the GROWN morphed AABB (em) the quad expands to; shapeBBox = the
    // TIGHT lerped shape bbox (gradient objectBoundingBox); fill/stroke = lerped
    // paint. All fed as uniforms — zero per-frame upload.
    // True while the composed program's invariant state (units 2-10 + bundle/canvas
    // uniforms) is still bound from a prior composed shape. The per-shape
    // coverage-RT renders before each composed draw only clobber the program +
    // units 0-1 + GL blend/viewport, so units 2-10 + the uniforms survive across
    // consecutive composed shapes. A pair direct draw or an offscreen filter
    // clobbers more → _drawBundleMorphRoute clears this flag after each.
    let _composedFull = false;
    function _drawComposedMorphShape(bundle, s, covTex, coverBBox, shapeBBox, fill, stroke, worldM, strokeCovTex, imgRect) {
      const prog = _ensureFillLBCovProg();
      if (!prog) return false;
      const U = _lbcU, b = bundle;
      const [cw, ch] = R.viewportSize();
      R.gl.useProgram(prog);
      // Always re-bind the units a coverage-RT render clobbers between per-shape
      // composites: unit 0 (their primTex / curve data), unit 1 (band / the
      // stroke pass's uDashTex), and — critically — units 2 (uMetaTex) and 3
      // (uDashTex), which _renderStaticCovRT unbinds in its feedback-loop guard
      // (`for u<4 → bindTexture(null)`). These are NOT gated behind _composedFull:
      // once shape 0 sets _composedFull, shapes 1..N would otherwise sample a
      // null uMetaTex → their fill reads zeroed shape metadata → blank. Chromium/
      // ANGLE tolerates the null unit, but strict WebGL2 (Firefox) returns zero,
      // so only shape 0 of a fogged/composed static bundle rendered ("only the
      // top mesa"). _renderPairCovRT only touches unit 0, so the morph path was
      // unaffected — this was static-composed-only.
      R.gl.activeTexture(R.gl.TEXTURE0); R.gl.bindTexture(R.gl.TEXTURE_2D, b.curveTex); R.gl.uniform1i(U.uCurveData, 0);
      R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, b.bandTex); R.gl.uniform1i(U.uBandData, 1);
      R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, b.metaTex); R.gl.uniform1i(U.uMetaTex, 2);
      R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, b.dashTex || R.dummyDashTex); R.gl.uniform1i(U.uDashTex, 3);
      if (!_composedFull) {
        // Invariant bundle textures (units 4-10) + their sampler/scalar uniforms.
        // (palette/extclip/pattern are stripped from this variant — no binds.)
        R.gl.activeTexture(R.gl.TEXTURE4); R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientTex || R.dummyGradientTex); R.gl.uniform1i(U.uGradientTex, 4);
        R.gl.activeTexture(R.gl.TEXTURE5); R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientStopsTex || R.dummyGradientStops); R.gl.uniform1i(U.uGradientStops, 5);
        if (U.uGradientStopsCount) R.gl.uniform1i(U.uGradientStopsCount, b.gradientStopsCount | 0);
        if (U.uGradientCount) R.gl.uniform1i(U.uGradientCount, b.gradientCount | 0);
        R.gl.activeTexture(R.gl.TEXTURE6); R.gl.bindTexture(R.gl.TEXTURE_2D, b.imageAtlasTex || R.dummyGradientStops); R.gl.uniform1i(U.uImageTex, 6);
        if (U.uImageAtlasSize) R.gl.uniform2f(U.uImageAtlasSize, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
        R.gl.activeTexture(R.gl.TEXTURE7); R.gl.bindTexture(R.gl.TEXTURE_2D, b.filterTex || R.dummyGradientTex); R.gl.uniform1i(U.uFilterTex, 7);
        R.gl.activeTexture(R.gl.TEXTURE8); R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientTex); R.gl.uniform1i(U.uOverrideTex, 8); R.gl.uniform1i(U.uHasOverrides, 0);
        R.gl.activeTexture(R.gl.TEXTURE9); R.gl.bindTexture(R.gl.TEXTURE_2D_ARRAY, R.maskRTDummy()); R.gl.uniform1i(U.uMaskRTArray, 9);
        R.gl.activeTexture(R.gl.TEXTURE10); R.gl.bindTexture(R.gl.TEXTURE_2D, R.maskRowToLayerDummy()); R.gl.uniform1i(U.uMaskRowToLayerTex, 10);
        R.gl.uniform1i(U.uHasOffscreenMask, 0);
        R.gl.uniform1i(U.uHasOccupancy, 0);
        R.gl.uniform1i(U.uHasEmCoord, 0);
        R.gl.uniform1f(U.uDrawAlpha, R.draw.alpha);
        R.gl.uniform1f(U.uNumShapes, Math.max(1, b.numShapes));
        R.gl.uniform4f(U.uGlobalBBox, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
        const [sx, sy] = R.arScale(b.globalBBox, cw, ch);
        R.gl.uniform2f(U.uCanvasAR, sx, sy);
        R.gl.uniform2f(U.uViewportSize, cw, ch);
        if (worldM) { R.gl.uniformMatrix3fv(U.uWorldM, false, worldM); R.gl.uniform1i(U.uHasWorldM, 1); }
        else R.gl.uniform1i(U.uHasWorldM, 0);
        // Per-draw recolor (channelLerp → palette → colorMatrix), coherent across
        // the draw → set once here. Mirrors beginFillPass's recolor binding so a
        // recolored static/streamed bundle composes through the analytic fill
        // identically to Slug. Disabled flags = free (the morph route leaves them
        // null → all three disabled).
        const cl = R.draw.channelLerp;
        if (cl && U.uChannelLerpEnabled) {
          const p = cl.primary || [0, 0, 0, 1], c = cl.contrast || [0, 0, 0, 1], h = cl.highlight || [1, 1, 1, 1];
          R.gl.uniform4f(U.uChannelLerpPrimary, p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
          R.gl.uniform4f(U.uChannelLerpContrast, c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
          R.gl.uniform4f(U.uChannelLerpHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
          R.gl.uniform1i(U.uChannelLerpEnabled, 1);
        } else if (U.uChannelLerpEnabled) R.gl.uniform1i(U.uChannelLerpEnabled, 0);
        const cm = R.draw.colorMatrix, cmo = R.draw.colorMatrixOffset;
        if ((cm || cmo) && U.uColorMatrixEnabled) {
          R.gl.uniformMatrix4fv(U.uColorMatrix, false, cm || R.IDENTITY_COLOR_MATRIX);
          R.gl.uniform4fv(U.uColorMatrixOffset, cmo || R.ZERO_OFFSET);
          R.gl.uniform1i(U.uColorMatrixEnabled, 1);
        } else if (U.uColorMatrixEnabled) R.gl.uniform1i(U.uColorMatrixEnabled, 0);
        const pal = R.draw.palette;
        R.gl.activeTexture(R.gl.TEXTURE13);
        if (pal && pal.texture && U.uPaletteEnabled) {
          R.gl.bindTexture(R.gl.TEXTURE_2D, pal.texture);
          R.gl.uniform1i(U.uPalette, 13); R.gl.uniform1i(U.uPaletteEnabled, 1);
          R.gl.uniform1i(U.uPaletteChannel, R.draw.paletteChannel | 0);
          R.gl.uniform1i(U.uPaletteSize, Math.max(1, pal.size | 0));
        } else if (U.uPalette) {
          R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops);
          R.gl.uniform1i(U.uPalette, 13); if (U.uPaletteEnabled) R.gl.uniform1i(U.uPaletteEnabled, 0);
        }
        _composedFull = true;
      }
      // Per-shape coverage (units 11/12) + paint/quad uniforms. (Dummy stroke cov when
      // unstroked — the stroke block is gated on vStrokeWidth/vStroke.a but the
      // sampler still needs a binding.)
      R.gl.activeTexture(R.gl.TEXTURE11); R.gl.bindTexture(R.gl.TEXTURE_2D, covTex); R.gl.uniform1i(U.uLBCovTex, 11);
      R.gl.activeTexture(R.gl.TEXTURE12); R.gl.bindTexture(R.gl.TEXTURE_2D, strokeCovTex || R.dummyGradientStops);
      if (U.uStrokeCovTex) R.gl.uniform1i(U.uStrokeCovTex, 12);
      // The coverage RTs are pooled, rounded UP to the pool quantum, so the
      // texture is ≥ the viewport. The coverage fills only the bottom-left
      // viewport region, so the fragment's screen→UV must divide by the
      // ALLOCATED texel size, not uViewportSize (else it samples past the
      // rendered region → a shrunk fill on any canvas not a multiple of the quantum).
      if (U.uLBCovTexSize) { const [tw, th] = R._covPool.sizeFor(cw, ch); R.gl.uniform2f(U.uLBCovTexSize, tw, th); }
      R.gl.uniform1i(U.uShapeIdxOverride, s);    // unit quad has no aShapeIdx → uniform selects the meta row
      // Quad AABB grown so the AA + coverage ramp can't fall outside it (inert — gated by covTex).
      const mx = Math.max(2, (coverBBox[2] - coverBBox[0]) * 0.06), my = Math.max(2, (coverBBox[3] - coverBBox[1]) * 0.06);
      if (U.uCoverBBox) R.gl.uniform4f(U.uCoverBBox, coverBBox[0] - mx, coverBBox[1] - my, coverBBox[2] + mx, coverBBox[3] + my);
      if (U.uLBShapeBBox) R.gl.uniform4f(U.uLBShapeBBox, shapeBBox[0], shapeBBox[1], shapeBBox[2], shapeBBox[3]);
      if (U.uLBFill) R.gl.uniform4f(U.uLBFill, fill[0], fill[1], fill[2], fill[3]);
      if (U.uLBStroke) R.gl.uniform4f(U.uLBStroke, stroke[0], stroke[1], stroke[2], stroke[3]);
      // Image rect (texel 9) lerps per-frame so bitmap fill/stroke mapping
      // follows the morphing silhouette.
      if (U.uLBImageRect && imgRect) R.gl.uniform4f(U.uLBImageRect, imgRect[0], imgRect[1], imgRect[2], imgRect[3]);
      // GL state the coverage-RT renders changed (blend MAX, viewport, FBO, depth).
      _ensureLbcQuadVao();
      R.gl.viewport(0, 0, cw, ch);
      R.gl.disable(R.gl.DEPTH_TEST); R.gl.depthMask(false);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      R.gl.bindVertexArray(_lbcQuadVao);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, 6);
      R.gl.bindVertexArray(null);
      // Unbind the coverage textures (units 11/12): these RTs return to the pool,
      // and the NEXT shape's coverage render may re-acquire one as its render
      // target. Left bound here, that render would form a framebuffer↔texture
      // FEEDBACK LOOP (GL_INVALID_OPERATION → dropped draw → blank coverage).
      R.gl.activeTexture(R.gl.TEXTURE11); R.gl.bindTexture(R.gl.TEXTURE_2D, null);
      R.gl.activeTexture(R.gl.TEXTURE12); R.gl.bindTexture(R.gl.TEXTURE_2D, null);
      if (R._handle) R._handle.fillPassAssetDirty = true;        // next Slug pass rebinds default program
      return true;
    }
  
    // Offscreen FILTER for a morph shape: render the morphed SourceGraphic into
    // R.shapeFbo via `renderSource` (the composed draw), then run the same machinery
    // render() uses — a multi-primitive filterGraph (R.evaluateGraph) or a
    // single-kind blur/morphology/convolve — and composite the result over the
    // snapshotted backdrop. No cache: a morph is dynamic, so the key would miss
    // every frame anyway.
    function _morphShapeFilter(bundle, s, filterId, graph, renderSource) {
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return false;
      R.ensureShapeFbo(); R.ensureMainCopyTex();
      // Snapshot the current canvas (prior shapes) as the filter backdrop.
      R.gl.activeTexture(R.gl.TEXTURE15); R.gl.bindTexture(R.gl.TEXTURE_2D, R.mainCopyTex);
      R.gl.copyTexSubImage2D(R.gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
      // Render the morphed shape alone into R.shapeFbo (SourceGraphic).
      R.bindFb(R.gl.FRAMEBUFFER, R.shapeFbo);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.depthMask(true); R.gl.stencilMask(0xff);
      R.gl.clearColor(0, 0, 0, 0); R.gl.clearStencil(0); R.gl.clearDepth(1.0);
      R.gl.clear(R.gl.COLOR_BUFFER_BIT | R.gl.STENCIL_BUFFER_BIT | R.gl.DEPTH_BUFFER_BIT);
      R.gl.depthMask(false);
      renderSource();
      if (graph && graph.nodes && graph.nodes.length) {
        const px = R._filterPxPerEm(cw, ch);
        const ctx = R._buildFilterCtx(cw, ch, px,
          { fbo: R.shapeFbo, tex: R.shapeFboTex, size: [cw, ch] },
          { fbo: null, tex: R.mainCopyTex, size: [cw, ch] });
        const ctLUTs = [];
        for (const n of graph.nodes) {
          if (n.type !== 'feComponentTransfer') { ctLUTs.push(null); continue; }
          const bytes = n.params && n.params.lutBytes;
          if (!bytes) { ctLUTs.push(null); continue; }
          const tex = R.gl.createTexture(); R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
          R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA8, 256, 4, 0, R.gl.RGBA, R.gl.UNSIGNED_BYTE,
            ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes));
          R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.NEAREST);
          R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.NEAREST);
          R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
          R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
          n.params.lutIndex = ctLUTs.length; ctLUTs.push(tex);
        }
        ctx.componentTransferLUTs = ctLUTs;
        if (R._scissor) R.gl.disable(R.gl.SCISSOR_TEST);
        const fScissors = R._filterNodeScissors(graph, s, cw, ch);
        const rootRT = R.evaluateGraph(R.gl, graph, R._rtPool, R._svgDispatch, ctx, cw, ch, fScissors);
        R._filterEvalCount++;
        for (const tex of ctLUTs) if (tex) R.gl.deleteTexture(tex);
        R._compositeFilteredTex(rootRT.tex, R.mainCopyTex, cw, ch);
      } else {
        const f = R.filterRecord(filterId);
        if (f && f.kind >= 1) {
          const px = R._filterPxPerEm(cw, ch);
          if (f.kind === 1) R.blurShapeFbo(f.sigmaX * px[0], f.sigmaY * px[1]);
          else if (f.kind === 5) R.morphShapeFbo(f.tintR | 0, f.sigmaX * px[0], f.sigmaY * px[1]);
          else if (f.kind === 6) R.convolveShapeFbo(f);
          R._filterEvalCount++;
          R._filterSingleKindComposite(f, cw, ch);
        } else {
          // kind 0 (color matrix) is applied inline by the composed draw; a plain
          // composite of the R.shapeFbo over the backdrop suffices.
          R._compositeFilteredTex(R.shapeFboTex, R.mainCopyTex, cw, ch);
        }
      }
      if (R._handle) R._handle.fillPassAssetDirty = true;
      return true;
    }
  
    // ---- Loop-Blinn drawBundle routing (opt-in whole-bundle fast path) -------
    let _lbLastUploaded = null;   // combined VBO currently resident in _lbBuf

    // ── GPU-resident LB morph route (opt-in via setLoopBlinnMorphFill) ─────────
    // Routes a MORPH handle (dynamic geometry, the OPPOSITE of the static route)
    // whose shapes are all solid-fill + GPU-morphable: build per-shape morph meshes
    // ONCE from the static endpoints (bundle._morphSrc, set by createShapeMorph)
    // and draw each via _drawLbPartitionPair, lerping geometry + recomputing the
    // implicit on the GPU. This both replaces Slug's per-fragment ray-cast AND
    // lets the morph's setT skip its per-frame CPU lerp + texture uploads. Mode:
    // 'off' · 'auto' (DEFAULT — route when morphable + perf says go) · 'on' (route
    // whenever morphable, ignore the perf estimate). Auto by default: any solid-
    // fill geometric morph transparently gets the GPU-resident path; morphs that
    // aren't morphable / not solid-fill fall through to Slug. Set 'off' to force
    // the legacy Slug morph. The mode is the SHARED R._lbFillMode (one toggle for
    // static + streamed + morph); the morph counters are R._lbMorphRouteCount /
    // R._lbMorphComposedCount.
    // SIMILARITY-invariant mesh cache: canonical-form key -> { raw, frame }.
    // Serves any translate/rotate/uniform-scale instance of a shape (flipbook
    // poses, moving sprites, rotating fish) by transforming the FULL cached
    // assembly (transformLoopBlinnRaw) + repacking -- nothing is rebuilt.
    const _lbSimCache = new Map();   // LRU <= 512
    const _lbSimPut = (k, v) => {
      if (k === null) return;
      if (_lbSimCache.size >= 512) _lbSimCache.delete(_lbSimCache.keys().next().value);
      _lbSimCache.set(k, v);
    };
    let _bpFrame = -1, _bpSpent = 0;   // global per-frame build pool (ms)
    let _bpLast = 0;
    const _bpTick = () => {
      const fr9 = R._frameSerial | 0, now9 = Date.now();
      if (_bpFrame !== fr9 || now9 - _bpLast > 16) { _bpFrame = fr9; _bpSpent = 0; }   // 16ms gap = a new frame even without beginFrame
      _bpLast = now9;
    };
    const _lbMorphMeshCache = new Map();   // FNV(src+dst spans)+route bits → morph pair mesh | null; LRU ≤384
    function _ensureBundleMorphMeshes(bundle) {
      if (bundle._morphMeshesBuilt) return bundle._morphMeshes;
      const src = bundle._morphSrc;
      const ranges = src && src.curveRanges, n = bundle.numShapes | 0;
      // latch the failure + fall back (null → the route Slugs the bundle)
      const _mmFail = () => { bundle._morphMeshesBuilt = true; bundle._morphMeshesPartial = null; return null; };
      if (!src || !src.matchedAll || !ranges || n < 1) return _mmFail();
      if (!R._lbMemAdmit(bundle, 2)) return _mmFail();   // dual-stream pair VBOs project 2×
      const meta = src.mergedMetaF32, dmeta = src.dstMetaF32, st = src.metaStride | 0;
      // RESUMABLE build with a per-call TIME BUDGET: a crash-spawned morph set used
      // to build ALL its pair meshes synchronously inside one frame (the tumbleweed
      // ~1s hitch), and a first over-budget bail latched Slug-for-life. Now a cursor
      // + persisted partial list resume where the budget cut off — across draw calls
      // AND the idle prepare queue (setMorphTarget enqueues, so morphs normally
      // finish BEFORE their first draw). Until complete, the morph renders via the
      // whole-bundle Slug fallback (reference-exact).
      const meshes = bundle._morphMeshesPartial || (bundle._morphMeshesPartial = []);
      _bpTick();
      if (_bpSpent > 9) { try { enqueueLbPrepare(bundle); } catch { } return null; }
      const tM0 = Date.now();
      for (let s = bundle._morphBuildS | 0; s < n; s++) {
        if (Date.now() - tM0 > 8) { bundle._morphBuildS = s; _bpSpent += Date.now() - tM0; try { enqueueLbPrepare(bundle); } catch { } return null; }
        const r = ranges[s];
        if (!r) return _mmFail();
        const sc = R.curveRangeToContours(src.mergedCurveF32, r.begin, r.end);
        const dc = R.curveRangeToContours(src.dstCurveF32, r.begin, r.end);
        if (!sc || !dc) return _mmFail();   // arc / empty
        // Translucent SOLID at either endpoint → force the CDT partition mesh (the
        // additive fast path can't composite α without self-conflating). Gradient/
        // image fills must stay on the direct path (their paint is sampled there),
        // so they're excluded — a translucent gradient/image is a rare A gap.
        const b = s * st;
        const hasPaint = Math.floor(meta[b + 28] + 0.5) !== 0 || (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0);
        const stroked = meta[b + 11] > 0 && meta[b + 12] > 0;   // strokeColor.a & strokeWidth
        const hasFill = hasPaint || meta[b + 7] > 0.004 || dmeta[b + 7] > 0.004;  // fillColor.a
        // fill=none (stroke-only / open path): no fill mesh needed — the stroke
        // mesh carries the geometry. Push null so the bundle still routes (the
        // composed path renders stroke-only with fCov=0).
        if (!hasFill) { meshes.push(null); continue; }
        // Route to the CDT partition mesh for (a) a CURVED MULTI-CONTOUR shape — a
        // fill with holes / nested figures whose curve crescent would over-fill
        // the hole under MAX/OVER (the mute-icon ring, glyph counters) — and (b) a
        // translucent solid (the additive fast path can't composite α without self-
        // conflating). A polygon-holed shape (all straight) stays FAST: earcut
        // omits the holes, no crescent over-fills. Same rule the static route uses
        // (_ensureLbMeshes), so a shape renders identically on either path.
        const curvedHoles = _hasCurvedHoles(sc, dc);
        const translucent = !hasPaint && (meta[b + 7] < 0.996 || dmeta[b + 7] < 0.996);
        // MORPH-PAIR MESH CACHE: cycling morphs (waves that re-target
        // the same shape pairs every cycle) rebuilt identical pair meshes forever —
        // 75% of steady-state CPU was builds. Same FNV-span technique as the static
        // cache, hashed over BOTH endpoints.
        let _mpKey = null;
        {
          let h1 = 0x811c9dc5, h2 = 0x01000193;
          const sf = src.mergedCurveF32, df = src.dstCurveF32;
          for (let fi = r.begin; fi < r.end; fi++) {
            const b1 = (sf[fi] * 4096) | 0, b2 = (df[fi] * 4096) | 0;
            h1 = ((h1 ^ b1) * 0x01000193) >>> 0; h1 = ((h1 ^ b2) * 0x01000193) >>> 0;
            h2 = ((h2 + b1) * 0x85ebca6b + 0xc2b2ae35) >>> 0; h2 = ((h2 + b2) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
          }
          _mpKey = h1 + 'm' + h2 + '_' + (r.end - r.begin) + (curvedHoles ? '_h' : '') + (translucent ? '_t' : '');
          const hit = _lbMorphMeshCache.get(_mpKey);
          if (hit !== undefined) {
            _lbMorphMeshCache.delete(_mpKey); _lbMorphMeshCache.set(_mpKey, hit);
            if (hit === null) { if (stroked) { meshes.push(null); continue; } return _mmFail(); }
            meshes.push(hit); continue;
          }
        }
        const _mpPut = (v) => {
          _lbMorphMeshCache.set(_mpKey, v);
          if (_lbMorphMeshCache.size > 384) { for (const k of _lbMorphMeshCache.keys()) { _lbMorphMeshCache.delete(k); break; } }
        };
        let m = null;
        // PARTITION PAIR first (one code path with the static builder). Serves solid,
        // gradient, image, translucent, composed and stroked shapes (dash rides
        // the stroke pass); bails (null) → the legacy builders below.
        {
          if (_ensureLbPairProg()) {
            try {
              // EARCUT pair first, in the SAME places the static route earcuts
              // (single-contour, no translucent solid): 2-4× cheaper build,
              // leaner mesh. Falls to the partition pair on any structure drift.
              const pair9 = (!translucent && buildEarcutPair(sc, dc))
                || buildLoopBlinnPartitionPair(sc, dc, meta[b + 13] > 0.5 ? 'evenodd' : 'nonzero');
              if (pair9) {
                const pkS9 = packLoopBlinnMesh(pair9.src), pkD9 = packLoopBlinnMesh(pair9.dst);
                if (pkS9.vertexCount === pkD9.vertexCount && pkS9.vertexCount > 0) {
                  m = { mode: 'partitionPair', vbo: _interleavePair(pkS9, pkD9), vertexCount: pkS9.vertexCount, hasSlug: false };
                 
                }
              }
            } catch { m = null; }
          }
        }
        // FLIP morphs: the plain pair bails on a classification flip — build
        // t-SEGMENTED pairs instead (each sub-interval reproduces the global
        // lerp exactly; _morphFillSeg picks the segment + local t at draw).
        // The segmentation is a BUILD STORM (dozens of probe builds) that a
        // budget cannot preempt mid-call: if this slice is already spent,
        // yield and resume at this shape next slice instead of freezing.
        if (!m && Date.now() - tM0 > 4) {
          bundle._morphBuildS = s; _bpSpent += Date.now() - tM0;
          try { enqueueLbPrepare(bundle); } catch { }
          return null;
        }
        if (!m) {
          try {
            const segs9 = segmentPartitionPairMorph(sc, dc, meta[b + 13] > 0.5 ? 'evenodd' : 'nonzero');
            if (segs9) {
              const out9 = [];
              let ok9 = true;
              for (const sg9 of segs9) {
                const pkS9 = packLoopBlinnMesh(sg9.pair.src), pkD9 = packLoopBlinnMesh(sg9.pair.dst);
                if (!pkS9.vertexCount || pkS9.vertexCount !== pkD9.vertexCount) { ok9 = false; break; }
                out9.push({ tLo: sg9.tLo, tHi: sg9.tHi, tLoB: sg9.tLoB, tHiB: sg9.tHiB,
                  vbo: _interleavePair(pkS9, pkD9), vertexCount: pkS9.vertexCount, mode: 'partitionPair' });
              }
              if (ok9 && out9.length) { m = { mode: 'partitionPair', segments: out9, vertexCount: out9[0].vertexCount, hasSlug: false }; }
            }
          } catch { }
        }
        // No legacy fallback: the pair (plain or t-segmented) serves every class
        // it can express; the residue (near-flat disagreement, strip-plan
        // divergence, monsters, structure changes) renders via Slug — exact by
        // definition.
        // A fill mesh that can't build (e.g. an open contour) is fine IF the shape
        // is stroke-only; otherwise it's genuinely non-morphable → Slug.
        _mpPut(m || null);
        if (!m) { if (stroked) { meshes.push(null); continue; } return _mmFail(); }
        meshes.push(m);
      }
      _bpSpent += Date.now() - tM0;
      bundle._morphMeshesBuilt = true; bundle._morphMeshesPartial = null;
      {
        let mb9 = 0;
        for (const m9 of meshes) {
          if (!m9) continue;
          if (m9.vbo) mb9 += m9.vbo.byteLength;
          if (m9.segments) for (const sg9 of m9.segments) { if (sg9 && sg9.vbo) mb9 += sg9.vbo.byteLength; }
        }
        R._lbMemUsed += mb9 - (bundle._lbMemBytes || 0);
        bundle._lbMemBytes = mb9;
      }
      return (bundle._morphMeshes = meshes);
    }
    // Per-shape STROKE coverage meshes, built lazily from the same
    // endpoint contours. Entry is null for shapes without a visible stroke (or
    // whose stroke geometry can't be matched). Cached on the bundle. Returns null
    // (whole-bundle) only if _morphSrc is missing; per-shape failure → null entry.
    function _ensureBundleMorphStrokeMeshes(bundle) {
      if (bundle._morphStrokeBuilt) return bundle._morphStrokeMeshes;
      bundle._morphStrokeBuilt = true;
      const src = bundle._morphSrc;
      const ranges = src && src.curveRanges, n = bundle.numShapes | 0;
      if (!src || !ranges || n < 1) return (bundle._morphStrokeMeshes = null);
      const meta = src.mergedMetaF32, st = src.metaStride | 0;
      const out = [];
      for (let s = 0; s < n; s++) {
        const b = s * st;
        const stroked = meta[b + 11] > 0 && meta[b + 12] > 0;   // strokeColor.a & strokeWidth
        const r = stroked ? ranges[s] : null;
        if (!r) { out.push(null); continue; }
        const sc = R.curveRangeToContours(src.mergedCurveF32, r.begin, r.end);
        const dc = R.curveRangeToContours(src.dstCurveF32, r.begin, r.end);
        // Style from meta texel 6: capStyle (24), joinStyle (25), miterLimit (26).
        // joinStyle gates miter-wedge emission at build time; cap/miterLimit ride
        // the mesh for the draw uniforms.
        const capStyle = Math.floor(meta[b + 24] + 0.5);
        const joinStyle = Math.floor(meta[b + 25] + 0.5);
        const miterLimit = meta[b + 26] > 0 ? meta[b + 26] : 4;
        const dashId = st >= 16 ? Math.floor(meta[b + 15] + 0.5) : 0;   // meta texel 3.w
        let m = null; if (sc && dc) { try { m = R.buildMorphStroke(sc, dc); } catch { m = null; } }
        if (m) { m.capStyle = capStyle; m.joinStyle = joinStyle; m.miterLimit = miterLimit; m.dashId = dashId; }
        out.push(m);
      }
      return (bundle._morphStrokeMeshes = out);
    }
    // Perf gate for 'auto'. The GPU morph is flat-cost and beats the Slug morph in
    // every morphable case (Slug never drops below a per-frame setT-lerp +
    // per-shape-bind floor the GPU path skips), so morphable ⇒ faster and this
    // always routes. Kept as an explicit hook (the reason 'auto' ≠ 'on'): a veto
    // for any future losing regime goes here. `anySigned`/`meshes` are passed for that.
    function _morphPerfOk(meshes, anySigned) { return true; }

    // Perf gate for STATIC bundles under 'auto' — the reason 'auto' ≠ 'on'. Only
    // all-solid-opaque bundles route: those take the one-draw COMBINED route,
    // which beats Slug (~3× in probes). Gradient/image shapes take the per-shape
    // DIRECT path (a VBO upload + draw + uniform set PER SHAPE) and composed
    // shapes (clip/mask/filter/stroke/translucent) take per-shape coverage-RT +
    // composite passes — both LOSE to Slug's single ubershader pass (~1.5× slower
    // for gradients), so 'auto' keeps them on Slug. 'on' bypasses this gate. (A
    // future win: batch gradient shapes into the combined route so they qualify
    // too.) Result cached per _geomGen — static bundles compute it once.
    function _staticPerfOk(bundle) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbPerfOkGen === gen) return bundle._lbPerfOk;
      let ok = true;
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (!meta || n < 1) ok = false;
      // (Text routes LB under 'auto' like every other solid-opaque shape: fat
      // cubic hulls are subdivided in buildLoopBlinnCDT so k³−lm stays
      // well-conditioned for concave glyphs; any residual is a per-shape
      // geometry issue, not a font one.)
      else if (bundle.filterGraphs && bundle.filterGraphs.some(g => g)) ok = false;
      else for (let s = 0; s < n; s++) {
        const b = s * st;
        if (meta[b + 7] < 0.996                                       // translucent fill
            || Math.floor(meta[b + 28] + 0.5) !== 0                   // gradient
            || (meta[b + 11] > 0 && meta[b + 12] > 0)                 // visible stroke
            || Math.floor(meta[b + 30] + 0.5) !== 0                   // clip
            || Math.floor(meta[b + 31] + 0.5) !== 0                   // mask
            || (st >= 33 && Math.floor(meta[b + 32] + 0.5) !== 0)     // inline filter
            || (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0)) {  // image
          ok = false; break;
        }
      }
      bundle._lbPerfOkGen = gen; bundle._lbPerfOk = ok;
      return ok;
    }

    // ── Shared per-shape analytic driver (static + morph) ──────────────────────
    // ONE implementation for BOTH static (baked klmn, t=0, paint straight from
    // meta) and morph (VS-recomputed klmn, paint lerped src→dst by t). `mode`
    // abstracts the ONLY real differences — the klmn source (a baked static mesh
    // vs a GPU morph mesh, via mode.renderFillCov / mode.renderDirect), the paint
    // source (mode.meta/dmeta/t — static passes meta as both, t=0 → identity),
    // per-shape fog overrides (mode.ovP, static only), and per-draw recolor
    // (mode.recolor). Everything else is written ONCE: painter order, the composed
    // dispatch (clip/mask/filter/stroke/translucent/recolor → coverage RT(s) →
    // _drawComposedMorphShape), the GPU stroke coverage, the offscreen-filter
    // branch, and the per-shape Slug fallback (mode.renderSlugShape). Returns
    // {drew, composed}. This is the unification: static is NOT a parallel
    // reimplementation — it is this same path in "baked klmn, t=0" mode.
    function _drawBundleLBShaded(bundle, mode) {
      const meshes = mode.meshes, strokeMeshes = mode.strokeMeshes;
      const meta = mode.meta, dmeta = mode.dmeta, st = mode.st | 0, t = mode.t || 0, it = 1 - t;
      const ovP = mode.ovP || null, recolor = !!mode.recolor;
      const bbox = bundle.globalBBox, worldM = R.draw.worldM;
      const dl = bundle.drawList;
      // Painter order: the Slug-cover-quad drawList when present, else shape-index
      // order (a lightweight/streamed bundle has no cover quads → empty drawList).
      const order = (dl && dl.length) ? dl.map(op => op.shapeIdx | 0) : meshes.map((_, i) => i);
      _composedFull = false;
      let drew = 0, composed = 0;
      for (const s of order) {
        const m = meshes[s];
        const b = s * st;
        // Per-shape Slug fallback: a shape LB can't serve — loop/cusp/arc (tagged
        // {slug:true} by the mesh builder), a non-identity per-shape transform
        // override, a blend mode, or a COLR paint graph (mode.forceSlug) — renders
        // through Slug in painter order while the rest stay analytic. (No
        // renderSlugShape on a lightweight streamed bundle → such a shape is
        // skipped; the streamed road hits none of these cases.)
        if ((m && m.slug) || (mode.forceSlug && mode.forceSlug(s))) {
          if (mode.renderSlugShape && mode.renderSlugShape(s)) drew++;
          _composedFull = false;
          continue;
        }
        // Paint: lerp (static it=1,t=0 → identity), then fog overrides (static only).
        let fr = meta[b + 4] * it + dmeta[b + 4] * t, fg = meta[b + 5] * it + dmeta[b + 5] * t,
            fb = meta[b + 6] * it + dmeta[b + 6] * t, fa = meta[b + 7] * it + dmeta[b + 7] * t;
        let gId = Math.floor(meta[b + 28] + 0.5);
        const imageId = st >= 36 ? Math.floor(meta[b + 35] + 0.5) : 0;
        if (ovP) {
          const ob = s * 24, mask = Math.floor(ovP[ob + 7] + 0.5);
          if (mask & 1) { fr = ovP[ob + 12]; fg = ovP[ob + 13]; fb = ovP[ob + 14]; fa = ovP[ob + 15]; gId = 0; }
          fr *= ovP[ob + 8]; fg *= ovP[ob + 9]; fb *= ovP[ob + 10]; fa *= ovP[ob + 11];   // tint
          fa *= ovP[ob + 6];                                                              // visibility → alpha
        }
        const fillCol = [fr, fg, fb, fa];
        const shapeBBox = [meta[b] * it + dmeta[b] * t, meta[b + 1] * it + dmeta[b + 1] * t,
                           meta[b + 2] * it + dmeta[b + 2] * t, meta[b + 3] * it + dmeta[b + 3] * t];
        // Composed (clip/mask/inline-filter/visible-stroke), translucent solid, or
        // recolored solid → coverage RT(s) → MANTLE_LB_COV composite (handles α +
        // post-fill systems exactly). Direct path can't.
        const transSolid = fa > 0.004 && fa < 0.996 && gId === 0 && imageId === 0;
        if (_morphShapeComposed(meta, b, st) || transSolid || (recolor && gId === 0 && imageId === 0)) {
          const coverBBox = shapeBBox.slice();
          const strokeCol = [meta[b + 8] * it + dmeta[b + 8] * t, meta[b + 9] * it + dmeta[b + 9] * t,
                             meta[b + 10] * it + dmeta[b + 10] * t, meta[b + 11] * it + dmeta[b + 11] * t];
          const imgRect = st >= 40
            ? [meta[b + 36] * it + dmeta[b + 36] * t, meta[b + 37] * it + dmeta[b + 37] * t,
               meta[b + 38] * it + dmeta[b + 38] * t, meta[b + 39] * it + dmeta[b + 39] * t]
            : null;
          // Fill coverage only when the shape has a usable fill mesh + visible fill
          // (a fill=none stroke-only shape has fCov=0; the shader skips it via doFill).
          const rtIdx = (m && !m.slug && m.vertexCount && fa > 0.004) ? mode.renderFillCov(m) : -1;
          // GPU stroke coverage for a stroked shape (shared morph stroke pass; t=0
          // for static). halfW = strokeWidth/2 (lerped); grow the cover quad to fit.
          let sRtIdx = -1, sTex = null;
          const sMesh = strokeMeshes && strokeMeshes[s];
          if (sMesh) {
            let halfW = (meta[b + 12] * it + dmeta[b + 12] * t) * 0.5;
            // non-scaling-stroke (flagsShape bit 0, meta texel 6.w = slot 27): width is
            // screen PIXELS → convert to em by the local em-per-pixel (incl. worldMatrix
            // scale), matching mantle.frag's `vStrokeWidth *= emPerPx`.
            if ((Math.floor(meta[b + 27] + 0.5) & 1) !== 0) {
              const [cwN, chN] = R.viewportSize();
              const arN = R.arScale(bbox, cwN, chN);
              const ws = worldM ? Math.hypot(worldM[0], worldM[1]) : 1;
              halfW *= (bbox[2] / Math.max(arN[0] * cwN, 1)) / Math.max(ws, 1e-6);
            }
            coverBBox[0] -= halfW; coverBBox[1] -= halfW; coverBBox[2] += halfW; coverBBox[3] += halfW;
            sRtIdx = _renderMorphStrokeCovRT(sMesh, t, halfW, bbox, worldM, bundle.dashTex);
            if (sRtIdx >= 0) sTex = R._covPool.get(sRtIdx).tex;
          }
          if (rtIdx >= 0 || sTex) {
            const covTex = rtIdx >= 0 ? R._covPool.get(rtIdx).tex : R.dummyGradientStops;
            const drawSrc = () => _drawComposedMorphShape(bundle, s, covTex, coverBBox, shapeBBox, fillCol, strokeCol, worldM, sTex, imgRect);
            // Offscreen filter (multi-primitive graph or single-kind blur/morph/
            // convolve): isolate the shape then post-process. Inline kind-0 color
            // matrix runs in the composed draw, so no offscreen pass for it.
            const filterId = st >= 33 ? Math.floor(meta[b + 32] + 0.5) : 0;
            const graph = (filterId && bundle.filterGraphs) ? bundle.filterGraphs[filterId - 1] : null;
            const fRec = filterId ? R.filterRecord(filterId) : null;
            const offscreen = !!(graph && graph.nodes && graph.nodes.length) || (fRec && fRec.kind >= 1);
            if (offscreen) {
              if (_morphShapeFilter(bundle, s, filterId, (graph && graph.nodes && graph.nodes.length) ? graph : null, drawSrc)) { drew++; composed++; }
              _composedFull = false;   // R.evaluateGraph clobbered the composed program's textures/state
            } else if (drawSrc()) { drew++; composed++; }
          }
          if (rtIdx >= 0) R._covPool.release(rtIdx);
          if (sRtIdx >= 0) R._covPool.release(sRtIdx);
          continue;
        }
        if (!m || m.slug || !m.vertexCount) continue;   // direct path needs a real fill mesh
        _composedFull = false;   // the direct draw clobbers units 0-3 + program
        if (imageId > 0 && bundle.imageAtlasTex && st >= 44) {
          const ir = st >= 40
            ? [meta[b + 36] * it + dmeta[b + 36] * t, meta[b + 37] * it + dmeta[b + 37] * t,
               meta[b + 38] * it + dmeta[b + 38] * t, meta[b + 39] * it + dmeta[b + 39] * t]
            : [0, 0, 1, 1];
          const as = [meta[b + 40], meta[b + 41], meta[b + 42], meta[b + 43]];
          if (mode.renderDirect(m, { color: fillCol, imageId, imgRect: ir, atlasSlot: as, shapeBBox })) drew++;
        } else if (gId > 0 && bundle.gradientTex) {
          if (mode.renderDirect(m, { gradId: gId, color: fillCol, shapeBBox })) drew++;
        } else {
          if (mode.renderDirect(m, { color: fillCol, shapeBBox })) drew++;
        }
      }
      return { drew, composed };
    }

    function _drawBundleMorphRoute(bundle) {
      const meshes = _ensureBundleMorphMeshes(bundle);
      if (!meshes) return false;
      // Gradient fills compose with the LB direct path, so allow them when the
      // bundle carries a gradient texture (Slug otherwise).
      const allowGrad = !!bundle.gradientTex, allowImage = !!bundle.imageAtlasTex;
      // A clip/mask shape composes via the LB-coverage → ubershader path, but
      // only if the MANTLE_LB_COV variant builds AND _renderPairCovRT can serve
      // its mesh (fast → 1-pass MAX coverage; signed → 2-pass |Σ| coverage).
      // Probe up front so the WHOLE bundle cleanly falls to Slug when a composed
      // shape can't be served — never a half-drawn morph.
      // Stroked shapes also compose (a GPU-resident stroke-coverage RT feeds
      // strokeCov). Build the per-shape stroke meshes up front so a stroked shape
      // whose stroke mesh can't build cleanly drops the bundle to Slug.
      const strokeMeshes = _ensureBundleMorphStrokeMeshes(bundle);
      const meta0 = bundle.metaFloats, st0 = bundle.metaFloatsPerShape | 0, n0 = bundle.numShapes | 0;
      let allowComposed = true;
      for (let s = 0; s < n0; s++) {
        const b0 = s * st0;
        if (!_morphShapeComposed(meta0, b0, st0)) continue;
        const stroked = meta0[b0 + 11] > 0 && meta0[b0 + 12] > 0;
        const hasFillMesh = !!meshes[s];
        const sStroke = stroked && R.morphStrokeProg && strokeMeshes && strokeMeshes[s];
        // No coverage at all (fill=none + no usable stroke) → invisible; skip, don't
        // fail the bundle. Otherwise: a fill shape needs a servable fill mesh; a
        // stroke-only (open / fill=none) shape needs only its stroke mesh.
        if (!hasFillMesh && !sStroke) continue;
        const mode = meshes[s] && meshes[s].mode;
        const fillOk = !hasFillMesh || mode === 'partitionPair';
        const strokeOk = !stroked || sStroke;
        if (!fillOk || !strokeOk || !_ensureFillLBCovProg()) { allowComposed = false; break; }
      }
      if (!_loopBlinnEligible(bundle, allowGrad, /* allowTrans */ true, allowImage, allowComposed)) return false;
      if (R._lbFillMode === 'auto' && !_morphPerfOk(meshes, false)) return false;
      const src = bundle._morphSrc;
      src.skipUploads = true;     // setT stops CPU lerp + texture uploads on the LB route
      const bbox = bundle.globalBBox, worldM = R.draw.worldM, alpha = R.draw.alpha;
      // Morph MODE for the shared driver: VS-recomputed klmn (_drawLbPartitionPair /
      // _renderPairCovRT lerp control points by t), paint lerped src→dst, no fog
      // overrides, no per-draw recolor (excluded upstream in _analyticRoute).
      const _mOv = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides.packedBuffer : null;
      const { drew, composed } = _drawBundleLBShaded(bundle, {
        meshes, strokeMeshes,
        meta: src.mergedMetaF32, dmeta: src.dstMetaF32, st: src.metaStride | 0, t: src.t,
        // COLOUR overrides ride the shared per-shape driver (uniforms, not VBOs) — an
        // animated-property morph no longer falls off the LB route to Slug. Transform
        // overrides are still excluded upstream (_analyticRoute → _lbOvrColorOnly).
        ovP: _mOv, recolor: false,
        renderFillCov: (m) => _renderPairCovRT(m, src.t, bbox, worldM),
        renderDirect: (m, p) => {
          const o = { bbox, worldMatrix: worldM, alpha };
          if (p.color) o.color = p.color;
          if (p.gradId) { o.gradId = p.gradId; o.shapeBBox = p.shapeBBox; o.gradientTex = bundle.gradientTex; o.gradientStopsTex = bundle.gradientStopsTex; }
          if (p.imageId) { o.imageId = p.imageId; o.imgRect = p.imgRect; o.atlasSlot = p.atlasSlot; o.imageTex = bundle.imageAtlasTex; o.atlasSize = bundle.imageAtlasSize; }
          return _drawLbPartitionPair(m, src.t, o);
        },
        renderSlugShape: null,   // morphs: whole-bundle fallback (per-shape Slug is static-only)
      });
      R._lbMorphComposedCount += composed;
      void drew;
      R._lbMorphRouteCount++;
      return true;
    }
  
    // A shape carries a CLIP, MASK, inline FILTER (feColorMatrix), or visible STROKE
    // → it composes via the LB-coverage → ubershader path (_drawComposedMorphShape),
    // NOT the direct draw (which would silently skip clip/mask/filter). Clip/mask/
    // filter run below the fCov seam over the LB fill (clip = inline coverage union;
    // mask = inline luminance/alpha walk; filter = applyFilterPre via the static
    // uFilterTex), so feeding LB coverage in composes them.
    // A per-shape override carries a non-identity 2×2 affine basis (texel 0) or
    // translate (texel 1.xy)? Loop-Blinn can't cheaply apply a per-shape transform
    // (the bezout cusp matrices + clip sample-frame would all need transforming),
    // so a transformed shape falls back to Slug per-shape (Slug applies the
    // override transform), while the rest of the bundle stays analytic.
    function _ovHasXform(ovP, s) {
      const ob = s * 24;
      return Math.abs(ovP[ob] - 1) > 1e-4 || Math.abs(ovP[ob + 1]) > 1e-4
          || Math.abs(ovP[ob + 2]) > 1e-4 || Math.abs(ovP[ob + 3] - 1) > 1e-4
          || Math.abs(ovP[ob + 4]) > 1e-4 || Math.abs(ovP[ob + 5]) > 1e-4;
    }
    function _morphShapeComposed(meta, b, st) {
      return Math.floor(meta[b + 30] + 0.5) !== 0             // clipId (texel 7.z)
          || Math.floor(meta[b + 31] + 0.5) !== 0             // maskId (texel 7.w)
          || (st >= 33 && Math.floor(meta[b + 32] + 0.5) !== 0)  // filterId (texel 8.x, inline only)
          || (meta[b + 11] > 0 && meta[b + 12] > 0);          // visible stroke
    }
    function _lbShapeEligible(meta, b, st, allowGrad, allowTrans, allowImage, allowComposed) {
      // Opaque fill only for the additive fast path: overlapping additive coverage
      // composes to the SAME color under OVER (exact at alpha=1). allowTrans callers
      // (the morph route) instead build the CDT partition mesh, whose non-overlapping
      // 1-pass-direct composite is exact at any α, so translucent fills are eligible.
      // A COMPOSED shape (clip/mask/filter/stroke) renders coverage to an RT then
      // a SINGLE composite — which handles any alpha (incl. a fill=none stroke-only
      // shape, alpha 0) — so the opacity gate doesn't apply to it.
      const composed = allowComposed && _morphShapeComposed(meta, b, st);
      if (!allowTrans && !composed && meta[b + 7] < 0.996) return false;     // fill alpha (opaque)
      if (!allowGrad && Math.floor(meta[b + 28] + 0.5) !== 0) return false;   // fillGradId
      // visible stroke: ineligible UNLESS composed (the composed path renders a
      // GPU-resident stroke-coverage RT the MANTLE_LB_COV variant samples as strokeCov).
      if (!allowComposed && meta[b + 11] > 0 && meta[b + 12] > 0) return false;
      // clip/mask: ineligible UNLESS the caller can run the composed path, which
      // feeds the LB fill coverage into the ubershader where the clip union / mask
      // walk still run inline over the LB fill.
      if (!allowComposed && Math.floor(meta[b + 30] + 0.5) !== 0) return false;   // clipId
      if (!allowComposed && Math.floor(meta[b + 31] + 0.5) !== 0) return false;   // maskId
      if (!allowImage && st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false;   // imageId
      if (st >= 44 && Math.floor(meta[b + 43] + 0.5) === 2) return false;     // pattern carrier
      // Closed-form prim: exclude only the kinds Slug's primFast SDF handles
      // (rect=2, roundRect=3, or a SQUARE-bbox circle=1) — those beat LB. But a
      // NON-square circle (primKind 1 baked to an ellipse bbox) has no SDF and
      // would otherwise fall to the per-fragment ray-cast, so let LB serve it
      // (it still carries the arc curve geometry the ray-cast fallback uses).
      if (st >= 45) {
        const pk = Math.floor(meta[b + 44] + 0.5);                            // meta texel 11.x
        if (pk === 2 || pk === 3) return false;
        if (pk === 1) {
          const w = meta[b + 2] - meta[b], h = meta[b + 3] - meta[b + 1];     // texel 0 = (x0,y0,x1,y1)
          if (Math.abs(w - h) <= 1e-3 * Math.max(w, 1e-6)) return false;      // square → SDF
        }
      }
      return true;
    }
    // allowGrad: the caller's direct (1-pass) path can paint a gradient, so
    // gradient-fill shapes are eligible. The static combined route leaves it false
    // (it bakes one per-vertex solid color); the per-shape morph route passes true.
    function _loopBlinnEligible(bundle, allowGrad, allowTrans, allowImage, allowComposed, allowSlugFallback) {
      if (!R.lbProg || !R.lbCompProg || !bundle) return false;
      if (bundle._nineSliceActive) return false;
      // Reject only REAL filter GRAPHS (separate R.evaluateGraph pass). A simple
      // feColorMatrix filter leaves a null placeholder in filterGraphs and rides
      // op.filterId — that runs INLINE in the ubershader below the fCov seam, so it
      // composes via the composed path (allowComposed) exactly like clip/mask.
      // A real filter GRAPH composes via the morph offscreen filter path when
      // composing (R.evaluateGraph over the morphed SourceGraphic); reject only when
      // we can't compose.
      if (!allowComposed && bundle.filterGraphs && bundle.filterGraphs.some(g => g)) return false;
      const dl = bundle.drawList;
      // A lightweight (analytic-only) streamed bundle is built WITHOUT Slug
      // cover-quads, so its drawList — derived from those quads — is empty.
      // That's expected here (it's solid-fill by construction, with pre-built
      // analytic meshes); the per-shape meta check below still gates it. Any
      // other empty/absent drawList is ineligible.
      if (!dl) return false;
      if (!dl.length && !bundle._lbStream) return false;
      for (const op of dl) {
        if (op.kind !== 'fillShape') return false;
        // Blend modes (need a backdrop) + COLR paint graphs aren't served by the
        // analytic fill. With allowSlugFallback (the static path keeps Slug
        // geometry) those shapes fall back to Slug per-shape; otherwise the whole
        // bundle goes to Slug.
        if (!allowSlugFallback && (op.colrGraphId || op.blendMode)) return false;
        // filterId (inline color matrix OR single-kind blur/morph/convolve) and
        // filterGraphId (multi-primitive) both compose via the composed path.
        if (!allowComposed && (op.filterId || op.filterGraphId)) return false;
      }
      if (!bundle.curveFloats || !bundle.curveRangesByShape) return false;
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (!meta || n < 1) return false;
      for (let s = 0; s < n; s++) if (!_lbShapeEligible(meta, s * st, st, allowGrad, allowTrans, allowImage, allowComposed)) return false;
      return true;
    }
    // Lazily decode + build + pack one LB mesh per shape; cached on the bundle,
    // keyed on bundle._geomGen (bumped by markGeometryDirty + morph setT). When a
    // prior build exists at an older gen, the per-shape mesh is REFRESHED
    // (R.refreshLoopBlinnMesh reuses the cached earcut topology, skipping the
    // O(n log n) triangulation) instead of fully rebuilt — the fixed-topology
    // streaming win for morphs / updateBundleGeometry.
    //
    // A shape Loop-Blinn can't serve (arc, loop/cusp, degenerate) becomes a
    // {slug:true} SENTINEL rather than failing the whole bundle: the per-shape
    // static path renders THOSE shapes through Slug (in painter order) while the
    // rest stay analytic (per-shape fallback). `bundle._lbHasSlug` records whether
    // any sentinel is present — the all-solid COMBINED route (one draw, can't mix
    // engines) bails to the per-shape path when it is. Returns null only when the
    // bundle has no usable geometry at all.
    function _lbFail(bundle, gen) { bundle._lbMeshes = null; bundle._lbMeshesRaw = null; bundle._lbGen = gen; bundle._lbHasSlug = false; return null; }
    function _ensureLbMeshes(bundle, budgeted) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbMeshes !== undefined && bundle._lbGen === gen) return bundle._lbMeshes;
      if (!R._lbMemAdmit(bundle, 1)) return _lbFail(bundle, gen);
      // GLOBAL per-frame build pool: a PER-BUNDLE budget stacks (an event that
      // dirties two dozen bundles at once turns into two dozen budgets in one
      // frame). All budgeted ensures draw from ONE pool per frame; when it
      // runs dry the remaining bundles render Slug this frame and resume next.
      if (budgeted) _bpTick();
      const tEns0 = budgeted ? Date.now() : 0;
      let partial = false;
      // Non-blocking draw policy: draw-time builds get a TIME BUDGET (8ms). Shapes
      // beyond it render SLUG this frame (reference-exact) and the ensure re-runs
      // next call — finished shapes come back free from the mesh cache, so the
      // build AMORTIZES across frames instead of freezing one (the tumbleweed
      // crash-morph 1-10s hitch). Small bundles finish inside the budget and are
      // LB on their very first draw; streams never hit this (their gen moves with
      // their meshes).
      const ranges = bundle.curveRangesByShape, cf = bundle.curveFloats, n = bundle.numShapes | 0;
      if (!ranges || !cf || n < 1) return _lbFail(bundle, gen);
      const meta = bundle.metaFloats, mst = bundle.metaFloatsPerShape | 0;
      const prevRaw = bundle._lbMeshesRaw;
      const prevPacked = bundle._lbMeshes;
      // Resumable sliced build. Shapes finalized (built or permanently-Slug) on a
      // prior attempt AT THIS generation are carried forward VERBATIM below, so the
      // slice is spent entirely on new shapes. Without this the loop re-walked from
      // shape 0 every attempt and paid the SELF-cache repack (transformLoopBlinnRaw
      // + packLoopBlinnMesh) for the already-built prefix — which grows until it
      // eats the whole slice and no new shape ever builds, so a heavy multi-shape
      // bundle (dozens of detailed pose-frame SVGs) plateaus and NEVER latches,
      // spinning the idle drain forever. `_lbBuildS` is the resume index; guarded by
      // `_lbRawGen` so a re-dirtied (new-generation) prefix is rebuilt, not reused.
      const resumeS = (bundle._lbRawGen === gen) ? (bundle._lbBuildS | 0) : 0;
      let partialAtS = n;
      const raw = [], packed = [];
      let hasSlug = false, hasReal = false;

      for (let s = 0; s < n; s++) {
        if (s < resumeS && prevRaw && prevRaw[s] !== undefined) {
          // Finalized on an earlier slice at this generation — carry it forward
          // verbatim (no rebuild, no repack), so the budget below only ever pays
          // for NEW shapes and the build makes net forward progress each attempt.
          const pr = prevRaw[s]; raw.push(pr); packed.push(prevPacked ? prevPacked[s] : pr);
          if (pr && pr.slug) hasSlug = true; else hasReal = true;
          continue;
        }
        let _mcKey = null, _simKey = null, _simFrame = null;
        const _mcPut = (v) => {
          if (_mcKey === null) return;
          if (_lbMeshCache.size >= 768) _lbMeshCache.delete(_lbMeshCache.keys().next().value);
          _lbMeshCache.set(_mcKey, v);
          // Slug verdicts and built meshes are similarity-invariant facts --
          // publish to the orbit cache too (frame captured at lookup time).
          if (_simKey) _lbSimPut(_simKey, v === null ? null : { raw: v.raw, frame: _simFrame });
          if (_simKey) (bundle._lbShapeSim || (bundle._lbShapeSim = []))[s] = v === null
            ? { key: _simKey, slug: true }
            : { key: _simKey, frame0: _simFrame, raw0: v.raw };
        };
        if (budgeted && !partial && Date.now() - tEns0 > 8) { partial = true; partialAtS = s; }   // own slice; the POOL gates entry (storm cap ~2 bundles/frame)
        if (partial) {
          // over budget: Slug THIS FRAME only — not cached, gen left unset below so
          // the next ensure resumes (built shapes return from the mesh cache).
          raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
        }
        const r = ranges[s];
        // COMPLEXITY GATE: the time budget is checked BETWEEN shapes — one monster
        // shape (crash-morph tumbleweed, hundreds of segs) can still eat seconds in
        // a single build (resolveSelfOverlap union + CDT). Such shapes render Slug
        // permanently: reference-exact, and the analytic win is irrelevant at that
        // vertex count.
        if (budgeted && r && (r.end - r.begin) > 4000) {
          if (typeof _mcPut === 'function') _mcPut(null);
          raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
        }
        const contours = r ? R.curveRangeToContours(cf, r.begin, r.end) : null;
        let mesh = null;
        // A TRANSLUCENT solid fill (no gradient/image) must be a non-overlapping
        // PARTITION so the combined route's direct OVER composites it exactly at
        // α<1 (the additive earcut crescents self-conflate) — build it as CDT, the
        // same partition the translucent MORPH path uses. Opaque fills keep the
        // cheaper earcut (crescents union correctly at α=1). Lets translucent
        // solids BATCH into the one-draw combined route instead of N composite RTs.
        const bb = meta && mst ? s * mst : -1;
        const transSolid = bb >= 0 && meta[bb + 7] < 0.996 && Math.floor(meta[bb + 28] + 0.5) === 0
          && (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
        if (contours) {
          // Multi-contour shapes with CURVED holes (or nested figures) can't use
          // the additive single-pass mesh: it only ADDS coverage (MAX/OVER), so it
          // can't cancel a hole and fills it. Build the PROPER Loop-Blinn CDT
          // partition instead (holes removed at build time) — one non-overlapping
          // 1-pass draw, same klmn shader, no coverage buffer. This is the
          // static↔morph unification for holes: static and morph share the same
          // CDT path (the signed 2-pass Kokojima baseline it replaced is gone).
          // ANY CURVED shape → CDT: the earcut rim mis-threads CONCAVE cubics
          // (fills a 'C'/'2' mouth, over-fills notches — verified), whereas the
          // CDT partition (with crescent adoption) is robust. STRAIGHT polygons
          // (the streamed road, polygon holes) stay on the cheap earcut fast path
          // — combined-route batching + the road's streaming perf win are untouched.
          // MULTI-CONTOUR straight shapes (nested-hole FRAMES + disjoint regions)
          // also go to CDT: the earcut hole-bridge can cross a thin, near-coincident
          // DIAGONAL sliver between two opposite-winding contours (a folded-corner
          // page outline / chevron / angled frame) and shatter into inverted ears —
          // "wrong wedges" (MANTLE_BUG_LOOPBLINN_THIN_DIAGONAL_FRAME). The CDT
          // partition + winding inside-removal is robust for any hole geometry. Only
          // SINGLE-contour straight polygons (the streamed road strips, simple
          // concave shapes — no hole-bridge) keep the cheap earcut fast path, so the
          // streaming perf win is untouched. (contours.length>1 subsumes the older
          // disjoint check; kept explicit for the disjoint rationale above.)
          // GLOBAL mesh cache: text screens rebuild the SAME glyph outline once per
          // OCCURRENCE and once per BUNDLE (menus: hundreds of builds for ~40 unique
          // glyphs — the "full stop" on text-heavy screens). Key = FNV over the exact
          // curve-float span + the routing bits (fill rule, translucency). Meshes and
          // packed VBOs are read-only downstream (upload copies to the GPU), so
          // sharing across bundles is safe. Gen-churned bundles (prevRaw present)
          // USE the cache too — a bundle whose geometry is re-uploaded without
          // actually changing (a road game streams its static track every
          // frame) hits here and skips the whole build; the static path never
          // packs with `reuse`, and refresh assembles fresh arrays, so cached
          // entries aren't mutated through this path. (True streams don't come
          // through this ensure at all — streamGeometryLightweight owns them.)
          // SELF tier (no map traffic): a bundle whose shape s only MOVED keeps
          // using its own mesh - canonical key match against this bundle's last
          // build transforms the ORIGINAL raw (single hop from frame0, never
          // chained frame-to-frame, so fp error can't accumulate) + repacks.
          // Slug verdicts ride the key too: a moving unservable shape stays
          // Slug without re-attempting a build every frame.
          if (r && contours) {
            _simFrame = R.lbCanonicalFrame(contours);
            const _rb9 = (transSolid ? '_t' : '') + (meta && meta[s * mst + 13] > 0.5 ? '_e' : '');
            _simKey = _simFrame ? R.lbCanonicalHash(contours, _simFrame) + _rb9 : null;
            const selfS = bundle._lbShapeSim && bundle._lbShapeSim[s];
            // near-symmetric shapes: try each tied candidate axis until one matches
            if (_simFrame && _simFrame.cands && selfS && !selfS.slug && selfS.key !== _simKey) {
              for (const cf9 of _simFrame.cands) {
                const k9 = R.lbCanonicalHash(contours, cf9) + _rb9;
                if (k9 === selfS.key) { _simKey = k9; _simFrame = cf9; break; }
              }
            }
            if (_simKey && selfS && selfS.key === _simKey) {
              if (selfS.slug) { raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue; }
              const eF = selfS.frame0, qF = _simFrame;
              const sc9 = qF.scale / eF.scale;
              const co9 = qF.cos * eF.cos + qF.sin * eF.sin;
              const si9 = qF.sin * eF.cos - qF.cos * eF.sin;
              const tRaw = R.transformLoopBlinnRaw(selfS.raw0, {
                s: sc9, cos: co9, sin: si9,
                dx: qF.cx - sc9 * (co9 * eF.cx - si9 * eF.cy),
                dy: qF.cy - sc9 * (si9 * eF.cx + co9 * eF.cy),
              });
              raw.push(tRaw); packed.push(R.packLoopBlinnMesh(tRaw)); hasReal = true; continue;
            }
          }
          if (r) {
            let h1 = 0x811c9dc5, h2 = 0x01000193;
            for (let fi = r.begin; fi < r.end; fi++) {
              const bits = (cf[fi] * 4096) | 0;
              h1 = ((h1 ^ bits) * 0x01000193) >>> 0;
              h2 = ((h2 + bits) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
            }
            _mcKey = h1 + '_' + h2 + '_' + (r.end - r.begin) + (transSolid ? '_t' : '') + (meta && meta[s * mst + 13] > 0.5 ? '_e' : '');
            const hit = _lbMeshCache.get(_mcKey);
            if (hit !== undefined) {
              // LRU touch
              _lbMeshCache.delete(_mcKey); _lbMeshCache.set(_mcKey, hit);
              if (hit === null) { raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue; }
              raw.push(hit.raw); packed.push(hit.pk); hasReal = true; continue;
            }
            // SIMILARITY tier: exact key missed (moved/rotated/scaled instance).
            // Canonicalize and look for the same shape anywhere in its orbit; a
            // hit transforms the cached assembly to this instance's frame and
            // repacks -- ~0.1ms vs a full build. The transformed result is ALSO
            // put under the exact key, so the next frame is an exact hit.
            if (contours) {
              const sHit = _simKey ? _lbSimCache.get(_simKey) : undefined;
              if (sHit !== undefined) {
                _lbSimCache.delete(_simKey); _lbSimCache.set(_simKey, sHit);
                if (sHit === null) {
                  if (_lbMeshCache.size >= 768) _lbMeshCache.delete(_lbMeshCache.keys().next().value);
                  _lbMeshCache.set(_mcKey, null);
                  raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
                }
                const eF = sHit.frame, qF = _simFrame;
                const sc9 = qF.scale / eF.scale;
                // R = rot(query) * rot(entry)^-1
                const co9 = qF.cos * eF.cos + qF.sin * eF.sin;
                const si9 = qF.sin * eF.cos - qF.cos * eF.sin;
                const M9 = {
                  s: sc9, cos: co9, sin: si9,
                  dx: qF.cx - sc9 * (co9 * eF.cx - si9 * eF.cy),
                  dy: qF.cy - sc9 * (si9 * eF.cx + co9 * eF.cy),
                };
                const tRaw = R.transformLoopBlinnRaw(sHit.raw, M9);
                const tPk = R.packLoopBlinnMesh(tRaw);
                (bundle._lbShapeSim || (bundle._lbShapeSim = []))[s] = { key: _simKey, frame0: sHit.frame, raw0: sHit.raw };
                if (_lbMeshCache.size >= 768) _lbMeshCache.delete(_lbMeshCache.keys().next().value);
                _lbMeshCache.set(_mcKey, { raw: tRaw, pk: tPk });
                raw.push(tRaw); packed.push(tPk); hasReal = true; continue;
              }
            }
            // POOL (draw-time only): a cache MISS costs a real build — when this frame's
            // global pool is dry (pose-switch storms dirty ~24 bundles at once), this
            // shape renders Slug THIS frame and the build resumes next frame / in idle.
            // Cache HITS above are never blocked (they cost ~nothing).
            if (budgeted === true && !partial && (_bpSpent + (Date.now() - tEns0)) > 9) { partial = true; partialAtS = s; }
            if (partial) { raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue; }
          }
          if (!_contoursAllStraight(contours) || transSolid || contours.length > 1 || _hasDisjointContours(contours)) {
            // FAST PATH: a single-contour, opaque, CONVEX curved shape (circle,
            // ellipse, pill, convex icon) has no concave curve for the earcut rim to
            // mis-thread and no hole to remove, so the cheap mesh renders it exactly
            // — 15-37× faster to build than the CDT. buildLoopBlinnMesh flags a
            // concave curve (mis-threads) or a loop/cusp (fallback); either → CDT.
            if (!transSolid && contours.length === 1) {
              let m = null;
              // ramp=true: static shapes get the interior boundary-feature ramps (thin-stroke
              // zigzag AA); the streaming path builds its own meshes without the flag.
              try { m = R.buildLoopBlinnMesh(contours, true); } catch { m = null; }
              if (m && !m.fallback.length && !m.hasConcave) {
                const pk = R.packLoopBlinnMesh(m);
                _mcPut({ raw: m, pk });
                raw.push(m); packed.push(pk); hasReal = true; continue;
              }
            }
            // Curved holes / glyph counters / concave curves → PROPER Loop-Blinn
            // (p1000-loop §3.1): CDT of all control points with contour + curve-
            // triangle constraints, then centroid inside-removal drops the hole
            // (no coverage buffer, no hole tessellation). One combined draw, same
            // klmn shader. A loop/cusp cubic (CDT fallback) or degenerate shape
            // goes to SLUG (the robust renderer) — never vanishes. Translucent
            // solids come here too (partition → exact direct OVER at α<1).
            let cdt = null;
            try { cdt = R.buildLoopBlinnCDT(contours, { fillRule: meta && meta[s * mst + 13] > 0.5 ? 'evenodd' : 'nonzero' }); } catch { cdt = null; }
            if (cdt && !cdt.fallback.length) {
              const pk = R.packLoopBlinnMesh(cdt);
              _mcPut({ raw: cdt, pk });
              raw.push(cdt); packed.push(pk); hasReal = true; continue;
            }
            _mcPut(null);
            raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
          }
          try {
            // Reuse a cached FAST triangulation (refresh); a CDT mesh (curved-holed
            // shape from a prior frame) has no _topo, so refresh rebuilds it fast.
            mesh = (prevRaw && prevRaw[s] && !prevRaw[s].slug && !prevRaw[s].mode)
              ? R.refreshLoopBlinnMesh(prevRaw[s], contours) : R.buildLoopBlinnMesh(contours, true);
          } catch { mesh = null; }
          if (mesh && mesh.fallback.length) mesh = null;   // self-intersecting (loop) → Slug
        }
        if (!mesh) { if (typeof _mcPut === 'function') _mcPut(null); raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue; }   // arc/loop/cusp/empty
        {
          const pk = R.packLoopBlinnMesh(mesh);
          if (typeof _mcPut === 'function' && !prevRaw) _mcPut({ raw: mesh, pk });
          raw.push(mesh); packed.push(pk); hasReal = true;
        }
      }
      if (!hasReal && hasSlug && !partial) return _lbFail(bundle, gen);   // nothing analytic to do → whole-bundle Slug
      if (budgeted) _bpSpent += Date.now() - tEns0;
      if (partial) {
        bundle._lbMeshesRaw = raw;
        bundle._lbGen = null;            // NOT gen: re-ensure resumes next draw
        bundle._lbHasSlug = true;
        bundle._lbBuildS = partialAtS;   // resume point: shapes < this are finalized
        bundle._lbRawGen = gen;          // guards the resumed prefix against a stale generation
        try { enqueueLbPrepare(bundle); } catch { }   // idle finishes it even without draws
        _lbMemAccount(bundle, packed);
        return (bundle._lbMeshes = packed);
      }
      bundle._lbMeshesRaw = raw;
      bundle._lbGen = gen;
      bundle._lbHasSlug = hasSlug;
      bundle._lbBuildS = 0;             // fully built → no resume prefix
      bundle._lbRawGen = gen;
      bundle._lbCombined = undefined;   // geometry changed → combined buffer stale
      _lbMemAccount(bundle, packed);
      return (bundle._lbMeshes = packed);
    }
    // One contiguous 28-float VBO (24 geometry + per-vertex RGBA) for the whole
    // bundle in painter order → a single drawArrays. Cached; rebuilt only when
    // geometry changes. Per-shape fill color is baked per vertex (the draw-time
    // global alpha stays a uniform so it doesn't force a rebuild).
    // Use the IMPORTED constant, NOT R.LB_VERT_FLOATS: this runs at
    // attachMorphDraw time, but R.LB_VERT_FLOATS isn't Object.assign'd onto R
    // until later in createRenderer — so R.LB_VERT_FLOATS is undefined here and
    // `undefined + 4` → NaN → an empty combined VBO → drawArrays reads past the
    // 0-byte buffer → GL_INVALID_OPERATION → blank route.
    const _RVF = LB_VERT_FLOATS + 5;   // route vertex floats (29: 24 geom + 4 colour + shapeRow)
    // Draw-path readiness gate — NEVER builds. Returns the worker-delivered packed
    // meshes when they're current (or `null` = whole-bundle Slug, also "ready"), or
    // `undefined` when the build hasn't landed yet so the caller falls back to Slug
    // (LB > Slug > nothing). All LB construction happens off-thread at load; a draw
    // must not stall to triangulate. Mirrors _ensureLbMeshes's cache-hit gate.
    function _lbReadyMeshes(bundle) {
      const gen = bundle._geomGen | 0;
      return (bundle._lbMeshes !== undefined && bundle._lbGen === gen) ? bundle._lbMeshes : undefined;
    }
    function _ensureLbCombined(bundle, overrides) {
      const gen = bundle._geomGen | 0;
      // Per-shape override recolor (fill/tint/visibility — e.g. the road's fog)
      // is baked into the combined VBO's per-vertex colour. The GL override
      // table exposes its CPU mirror (packedBuffer, 24 floats/shape); read it
      // directly. Loop-Blinn klmn are affine-invariant so colour-only overrides
      // need no geometry change. (Per-shape TRANSFORM overrides are NOT applied
      // by this static bake — use the full Slug path if a shape needs one.)
      const ovP = overrides && overrides.packedBuffer ? overrides.packedBuffer : null;
      // TRANSFORM overrides can't ride the static bake — per-shape route handles them
      // (Slug applies the transform). Cheap per-frame scan; everything else is cached.
      if (ovP) {
        const n9 = bundle.numShapes | 0;
        for (let s9 = 0; s9 < n9; s9++) if (_ovHasXform(ovP, s9)) return (bundle._lbCombined = null);
      }
      // COLOUR/TINT/VISIBILITY overrides must not touch the VBO: base colours are
      // baked once and the VERTEX SHADER applies overrides from uOverrideTex (shape
      // index via gl_VertexID + the starts table) — re-assembling the combined
      // buffer per frame collapses under screens of animated text.
      if (bundle._lbCombined !== undefined && bundle._lbCombinedGen === gen)
        return bundle._lbCombined;
      const meshes = _lbReadyMeshes(bundle);   // NO draw-time build — ready LB or Slug
      bundle._lbCombinedGen = gen;
      if (!meshes) return (bundle._lbCombined = null);
      // A slug-sentinel shape (loop/cusp/arc) can't ride the one-draw combined VBO.
      // On a bundle that keeps Slug geometry, bail so _drawBundleLB routes through
      // the per-shape path (sentinel → per-shape Slug fallback). But a lightweight
      // _lbStream bundle (the streamed road) has NO Slug fallback: bailing there
      // would draw each section separately, introducing AA seams between adjacent
      // sections (visible "fragmenting") AND dropping the sentinel anyway. So keep
      // the combined route — its assembly already SKIPS sentinel shapes (no
      // vertexCount), yielding one seamless draw with only the rare sentinel missing.
      // Only a slug-sentinel forces the bail → _drawBundleLB routes per-shape
      // (sentinel → per-shape Slug fallback). A curved-HOLED shape is NOT a
      // sentinel: its CDT partition is a "real" analytic mesh that packs into the
      // same additive VBO and, being non-overlapping + opaque, composes additively
      // exactly like any solid shape — so it keeps the one-draw combined route.
      // Lightweight _lbStream bundles carry no sentinels (solid single-contour
      // strips), so they keep the route too.
      if (bundle._lbHasSlug && !bundle._lbStream) return (bundle._lbCombined = null);
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0;
      // Painter-order shape iteration. The drawList is derived from the Slug
      // cover-quad chunks, so a lightweight (analytic-only) bundle built
      // WITHOUT cover-quads has an empty drawList — fall back to shape-index
      // order (the order shapes were emitted), which is the painter order for
      // a streamed solid-fill bundle.
      // Painter order. For a streamed solid bundle the drawList is empty, so
      // this is the identity [0..n-1] — which depends only on the shape count,
      // not the (per-frame-bumped) geomGen. Cache it so the road's combined
      // route doesn't rebuild an n-length index array every frame.
      let order = bundle._lbOrder;
      if (bundle.drawList && bundle.drawList.length) {
        order = bundle.drawList.map(op => op.shapeIdx | 0);
      } else if (!order || order.length !== meshes.length) {
        order = bundle._lbOrder = meshes.map((_, i) => i);
      }
      let totalVerts = 0;
      for (const s of order) { const m = meshes[s]; if (m && m.vertexCount) totalVerts += m.vertexCount; }   // skip slug sentinels (no vertexCount)
      if (!totalVerts) return (bundle._lbCombined = null);
      // Fixed-topology streaming reuse: refill the prior combined VBO in place
      // when the total vertex count is unchanged (updateBundleGeometryLB leaves
      // _lbCombined in place across frames; only its gen goes stale). Every
      // float is overwritten in the fill loop below, so no stale data. We still
      // return a NEW wrapper object so _drawBundleLoopBlinn's identity check
      // (combined !== _lbLastUploaded) re-uploads the changed data via
      // bufferSubData. Falls back to a fresh buffer on a vertex-count change.
      const _prevC = bundle._lbCombined;
      const verts = (_prevC && _prevC.verts && _prevC.verts.length === totalVerts * _RVF)
        ? _prevC.verts : new Float32Array(totalVerts * _RVF);
      let o = 0;
      let ord9 = 0;   // painter ordinal → per-shape depth layer (rides the kind fraction)
      for (const s of order) {
        const m = meshes[s];
        if (!m || !m.vertexCount) continue;
        const b = s * st;
        const r = meta[b + 4], g = meta[b + 5], bl = meta[b + 6], a = meta[b + 7];
        const src = m.verts;
        const kf9 = Math.min(ord9++, 2047) / 8192;   // ≤2047: bit 11 = the shapes' blend flag
        for (let vi = 0; vi < m.vertexCount; vi++) {
          const si = vi * R.LB_VERT_FLOATS;
          for (let k = 0; k < R.LB_VERT_FLOATS; k++) verts[o + k] = src[si + k];
          verts[o + 5] = src[si + 5] + kf9;
          verts[o + 24] = r; verts[o + 25] = g; verts[o + 26] = bl; verts[o + 27] = a;
          verts[o + 28] = s;   // shape row: the VS reads overrides directly — NO per-vertex search
          o += _RVF;
        }
      }
      return (bundle._lbCombined = { verts, count: totalVerts });
    }
    // Combined whole-bundle draw. Picks the LEAN program for a cusp-free
    // (no-bezout) mesh — the SAME selection drawLoopBlinnMesh makes; the full
    // lbProg over-fills no-bezout cubic coverage (the lean variant is the correct
    // one for them). A bundle with CUBICS also needs MAX coverage accumulation:
    // a cubic subdivides into OVERLAPPING control-hull cover triangles, and the
    // direct-to-canvas OVER blend ACCUMULATES their partial coverages
    // (1−∏(1−cᵢ)) → over-fill toward the convex hull ("wrong wedges"). So a cubic
    // bundle renders premultiplied paint·coverage into a viewport-exact RGBA RT
    // with MAX blend (per-shape colour survives: same colour MAXes to
    // colour·maxCov), then composites that RT over the canvas ONCE with OVER.
    // Straight/quad bundles have no overlapping cover triangles → the cheaper
    // one-draw OVER path, no RT.
    function _drawBundleLoopBlinn(bundle) {
      // Per-shape overrides (fill/tint/visibility, e.g. fog) bake into the
      // combined VBO colour. A GL override table (with a packedBuffer) is
      // applied; a stroke/transform-only or native table is ignored here.
      const ovr = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides : null;
      const combined = _ensureLbCombined(bundle, ovr);
      if (!combined) return false;
      R._lbRouteCount++;
      const [cw, ch] = R.viewportSize();
      const bbox = bundle.globalBBox;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      // PER-BUNDLE buffer + VAO: a single shared buffer with a one-slot "last
      // uploaded" cache degenerates to a full combined-VBO upload per bundle
      // per frame on multi-bundle scenes; per-bundle residency uploads once
      // per geometry change.
      let glR = bundle._lbRouteGl;
      if (!glR) {
        glR = bundle._lbRouteGl = { vao: R.gl.createVertexArray(), buf: R.gl.createBuffer(), uploaded: null, cap: 0 };
        R.gl.bindVertexArray(glR.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, glR.buf);
        _specRouteAttribs();
      } else {
        R.gl.bindVertexArray(glR.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, glR.buf);
      }
      if (glR.uploaded !== combined) {
        if (combined.verts.length > glR.cap) { R.gl.bufferData(R.gl.ARRAY_BUFFER, combined.verts, R.gl.STATIC_DRAW); glR.cap = combined.verts.length; }
        else R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, combined.verts);
        glR.uploaded = combined;
      }
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.viewport(0, 0, cw, ch);
      // DEPTH-CLAIM CASCADE: caps/pieces/interior z-tiers are single-owner —
      // each tier's depth rejects the tiers below wherever it claims (see
      // loopBlinn.vert + the kind-9/kind-10 claim rules in the frag).
      R.gl.enable(R.gl.DEPTH_TEST); R.gl.depthFunc(R.gl.LEQUAL); R.gl.depthMask(true);
      R.gl.clearDepth(1.0); R.gl.clear(R.gl.DEPTH_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      R.gl.useProgram(R.lbProg);
      // VS-applied overrides: bind the shared override table + this bundle's starts
      // table (lazily built RGBA32F, width = drawn-shape count; texel = (firstVertex,
      // shapeRow, 0, 0)). The combined VBO itself never changes for colour animation.
      if (ovr && R.lbUHasOvr && (ovr.uploadIfDirty(), ovr.texture)) {
        R.gl.activeTexture(R.gl.TEXTURE6);
        R.gl.bindTexture(R.gl.TEXTURE_2D, ovr.texture);
        R.gl.uniform1i(R.lbUOvrTex, 6);
        R.gl.uniform1i(R.lbUHasOvr, 1);
        R.gl.activeTexture(R.gl.TEXTURE0);
      } else if (R.lbUHasOvr) {
        R.gl.uniform1i(R.lbUHasOvr, 0);
      }
      R.gl.uniform4f(R.lbUGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(R.lbUCanvasAR, sx, sy);
      R.gl.uniform2f(R.lbUViewport, cw, ch);
      R.gl.uniform1i(R.lbUDirect, 1);
      R.gl.uniform1f(R.lbUAlpha, R.draw.alpha);
      // The combined route is ALWAYS solid (per-vertex aColor). lbProg's uGradId/
      // uImageId are shared with the per-shape direct path (_drawLBShapeDirect),
      // which leaves them >0 after a gradient/image shape — so reset them here or
      // a solid bundle drawn after a gradient one (same frame) would sample a
      // stale gradient and render blank/wrong.
      if (R.lbUGradId) R.gl.uniform1i(R.lbUGradId, 0);
      if (R.lbUImageId) R.gl.uniform1i(R.lbUImageId, 0);
      R._setLbRecolor(true);   // apply this draw's channel-lerp/color-matrix in-shader (batched recolor)
      if (R.draw.worldM) { R.gl.uniformMatrix3fv(R.lbUWorldM, false, R.draw.worldM); R.gl.uniform1i(R.lbUHasWorldM, 1); }
      else R.gl.uniform1i(R.lbUHasWorldM, 0);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, combined.count);
      // reset: lbProg is shared with the per-shape direct/composed paths, which never
      // set uLbHasOvr — a stale 1 there reads a disabled aShapeRow (0) + an unbound
      // override sampler and multiplies visibility to zero (the metaTex-rebind class).
      if (R.lbUHasOvr) R.gl.uniform1i(R.lbUHasOvr, 0);
      R.gl.bindVertexArray(null);
      if (R._handle) R._handle.fillPassAssetDirty = true;
      return true;
    }

    // Per-shape STATIC direct draw (single-pass uDirect=1): solid / gradient /
    // image. Mirrors the pair direct path but for a static packed
    // LB mesh (no morph lerp). loopBlinn.frag already samples gradient/image;
    // solid paint rides the constant aColor attribute (location 7, not enabled
    // in _lbVao). Composites OVER, like the combined route.
    function _drawLBShapeDirect(packed, paint) {
      if (!packed || !packed.vertexCount || !R.lbProg) return false;
      const bbox = paint.bbox, worldM = paint.worldM || null;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return false;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      _bindPackedVao(packed);
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.viewport(0, 0, cw, ch);
      // DEPTH-CLAIM CASCADE: caps/pieces/interior z-tiers are single-owner —
      // each tier's depth rejects the tiers below wherever it claims (see
      // loopBlinn.vert + the kind-9/kind-10 claim rules in the frag).
      R.gl.enable(R.gl.DEPTH_TEST); R.gl.depthFunc(R.gl.LEQUAL); R.gl.depthMask(true);
      R.gl.clearDepth(1.0); R.gl.clear(R.gl.DEPTH_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      R.gl.useProgram(R.lbProg);
      R._setLbRecolor(false);   // per-shape direct never recolors (recolor rides the composed path) — clear stale state
      R.gl.uniform4f(R.lbUGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(R.lbUCanvasAR, sx, sy);
      R.gl.uniform2f(R.lbUViewport, cw, ch);
      R.gl.uniform1i(R.lbUDirect, 1);
      R.gl.uniform1f(R.lbUAlpha, paint.alpha == null ? 1 : paint.alpha);
      // Solid paint via the constant aColor attribute (location 7).
      const c = paint.color || [0, 0, 0, 1];
      R.gl.disableVertexAttribArray(7); R.gl.vertexAttrib4f(7, c[0], c[1], c[2], c[3]);
      const gradId = (paint.gradId | 0) > 0 && paint.gradientTex ? (paint.gradId | 0) : 0;
      if (R.lbUGradId) R.gl.uniform1i(R.lbUGradId, gradId);
      if (gradId) {
        const sb = paint.shapeBBox || bbox;
        R.gl.uniform4f(R.lbUShapeBBox, sb[0], sb[1], sb[2], sb[3]);
        R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.gradientTex); R.gl.uniform1i(R.lbUGradientTex, 1);
        R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.gradientStopsTex); R.gl.uniform1i(R.lbUGradientStops, 2);
      }
      const imageId = (paint.imageId | 0) > 0 && paint.imageTex ? (paint.imageId | 0) : 0;
      if (R.lbUImageId) R.gl.uniform1i(R.lbUImageId, imageId);
      if (imageId) {
        R.gl.uniform4f(R.lbUImgRect, paint.imgRect[0], paint.imgRect[1], paint.imgRect[2], paint.imgRect[3]);
        R.gl.uniform4f(R.lbUAtlasSlot, paint.atlasSlot[0], paint.atlasSlot[1], paint.atlasSlot[2], paint.atlasSlot[3]);
        R.gl.uniform2f(R.lbUImageAtlasSize, paint.atlasSize ? paint.atlasSize[0] : 1, paint.atlasSize ? paint.atlasSize[1] : 1);
        R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.imageTex); R.gl.uniform1i(R.lbUImageTex, 3);
      }
      if (worldM) { R.gl.uniformMatrix3fv(R.lbUWorldM, false, worldM); R.gl.uniform1i(R.lbUHasWorldM, 1); }
      else R.gl.uniform1i(R.lbUHasWorldM, 0);
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, packed.vertexCount);
      R.gl.bindVertexArray(null);
      if (R._handle) R._handle.fillPassAssetDirty = true;
      return true;
    }

    // Render a static packed LB mesh's analytic coverage into a pooled R8 RT
    // (uDirect=0, MAX-blend union) and return the pool index (caller releases).
    // The static analog of _renderPairCovRT — feeds the composed path
    // (_drawComposedMorphShape) so clip/mask/filter compose over a static fill.
    function _renderStaticCovRT(packed, bbox, worldM) {
      if (!packed || !packed.vertexCount || !R.lbProg) return -1;
      const [cw, ch] = R.viewportSize();
      if (cw < 1 || ch < 1) return -1;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      _bindPackedVao(packed);
      const rtIdx = R._covPool.acquire(cw, ch);
      const rt = R._covPool.get(rtIdx);
      R.bindFb(R.gl.FRAMEBUFFER, rt.fbo);
      R.gl.viewport(0, 0, cw, ch);
      R.gl.disable(R.gl.DEPTH_TEST); R.gl.depthMask(false);
      R.gl.clearColor(0, 0, 0, 0); R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.MAX); R.gl.blendFunc(R.gl.ONE, R.gl.ONE);
      // lbProg's gradient/image samplers point at units 0-3; at uDirect=0 they're
      // unused, but a prior pass may have left a pooled coverage RT bound on one
      // of those units. If the RT we just acquired aliases it, this draw forms a
      // framebuffer↔texture FEEDBACK LOOP (GL_INVALID_OPERATION → dropped → blank
      // coverage). Unbind those units so the target RT can't be aliased.
      for (let u = 0; u < 4; u++) { R.gl.activeTexture(R.gl.TEXTURE0 + u); R.gl.bindTexture(R.gl.TEXTURE_2D, null); }
      const lean = !packed.hasBezout && R.lbProgLean;
      const prog = lean ? R.lbProgLean : R.lbProg;
      R.gl.useProgram(prog);
      R.gl.uniform4f(lean ? R.lbLeanUGBB : R.lbUGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(lean ? R.lbLeanUCanvasAR : R.lbUCanvasAR, sx, sy);
      R.gl.uniform2f(lean ? R.lbLeanUViewport : R.lbUViewport, cw, ch);
      R.gl.uniform1i(lean ? R.lbLeanUDirect : R.lbUDirect, 0);
      const uWM = lean ? R.lbLeanUWorldM : R.lbUWorldM, uHWM = lean ? R.lbLeanUHasWorldM : R.lbUHasWorldM;
      if (worldM) { R.gl.uniformMatrix3fv(uWM, false, worldM); R.gl.uniform1i(uHWM, 1); }
      else R.gl.uniform1i(uHWM, 0);
      R.gl.drawArrays(R.gl.TRIANGLES, 0, packed.vertexCount);
      R.gl.bindVertexArray(null);
      // Rebind the canvas + restore default add-blend: _drawComposedMorphShape
      // (the composed consumer) draws straight to whatever FBO is bound, and
      // _renderPairCovRT leaves the canvas bound — match that contract so the
      // composed quad lands on the canvas, not back into this coverage RT (which
      // is also about to be sampled as covTex → a framebuffer↔texture feedback loop).
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      return rtIdx;
    }

    // Per-shape STATIC stroke-coverage meshes, built lazily from the bundle's
    // own contours as a DEGENERATE morph (src == dst): buildMorphStroke +
    // _renderMorphStrokeCovRT at t=0 is a static stroke, so the composed path
    // reuses the morph stroke machinery verbatim (one stroke engine). Entry is
    // null for shapes without a visible stroke (or whose stroke can't be
    // matched). Cached on the bundle, keyed on _geomGen. Returns null only if
    // the bundle has no curves; per-shape failure → null entry.
    function _ensureLbStrokeMeshes(bundle) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbStrokeMeshes !== undefined && bundle._lbStrokeGen === gen) return bundle._lbStrokeMeshes;
      bundle._lbStrokeGen = gen;
      const ranges = bundle.curveRangesByShape, cf = bundle.curveFloats, n = bundle.numShapes | 0;
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0;
      if (!ranges || !cf || !meta || n < 1) return (bundle._lbStrokeMeshes = null);
      const out = [];
      for (let s = 0; s < n; s++) {
        const b = s * st;
        const stroked = meta[b + 11] > 0 && meta[b + 12] > 0;   // strokeColor.a & strokeWidth
        const r = stroked ? ranges[s] : null;
        if (!r) { out.push(null); continue; }
        const contours = R.curveRangeToContours(cf, r.begin, r.end);
        // Style from meta texel 6: capStyle (24), joinStyle (25), miterLimit (26);
        // dashId from texel 3.w (15). Same layout the morph stroke builder reads.
        const capStyle = Math.floor(meta[b + 24] + 0.5);
        const joinStyle = Math.floor(meta[b + 25] + 0.5);
        const miterLimit = meta[b + 26] > 0 ? meta[b + 26] : 4;
        const dashId = st >= 16 ? Math.floor(meta[b + 15] + 0.5) : 0;
        let m = null; if (contours) { try { m = R.buildMorphStroke(contours, contours); } catch { m = null; } }
        if (m) { m.capStyle = capStyle; m.joinStyle = joinStyle; m.miterLimit = miterLimit; m.dashId = dashId; }
        out.push(m);
      }
      return (bundle._lbStrokeMeshes = out);
    }

    // STATIC analytic route (gradient/image/composed/translucent/recolor). A thin
    // wrapper that builds the STATIC mode (baked klmn, t=0, paint from meta, fog
    // overrides) and runs the SHARED driver _drawBundleLBShaded — the same path
    // morphs ride. No parallel loop: the only static-specific bits are the baked
    // mesh primitives (_renderStaticCovRT / _drawLBShapeDirect) and the per-shape
    // Slug fallback (static bundles keep Slug geometry; streamed ones don't).
    function _drawBundleLBStatic(bundle) {
      const meshes = _lbReadyMeshes(bundle);   // NO draw-time build — ready LB or Slug
      if (!meshes) return false;
      const strokeMeshes = _ensureLbStrokeMeshes(bundle);
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0;
      const bbox = bundle.globalBBox, worldM = R.draw.worldM, alpha = R.draw.alpha;
      const ovP = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides.packedBuffer : null;
      const recolor = !!(R.draw.colorMatrix || R.draw.colorMatrixOffset || R.draw.palette || R.draw.channelLerp);
      // A non-lightweight bundle (real Slug cover quads) can fall a shape LB can't
      // serve back to Slug per-shape; a lightweight _lbStream bundle has no Slug
      // geometry, so its mesh builder fails the whole bundle instead.
      const canSlug = !bundle._lbStream && bundle.drawList && bundle.drawList.length > 0;
      // Shapes whose op carries a blend mode or a COLR paint graph → Slug per-shape
      // (Slug applies blend against the backdrop / runs the paint graph).
      const slugOps = new Set();
      if (canSlug) for (const op of bundle.drawList) if (op.blendMode || op.colrGraphId) slugOps.add(op.shapeIdx | 0);
      const forceSlug = (ovP || slugOps.size)
        ? (s) => slugOps.has(s) || (ovP && _ovHasXform(ovP, s))
        : null;
      const { drew } = _drawBundleLBShaded(bundle, {
        meshes, strokeMeshes,
        meta, dmeta: meta, st, t: 0,      // static: src == dst, t=0 → paint is meta verbatim
        ovP, recolor, forceSlug,
        // Static composed shapes (incl. curved holes via CDT) ride the baked
        // static primitives — coverage from _renderStaticCovRT, direct via the
        // static shape draw.
        renderFillCov: (m) => _renderStaticCovRT(m, bbox, worldM),
        renderDirect: (m, p) => {
          const paint = { bbox, worldM, alpha };
          if (p.color) paint.color = p.color;
          if (p.gradId) { paint.gradId = p.gradId; paint.shapeBBox = p.shapeBBox; paint.gradientTex = bundle.gradientTex; paint.gradientStopsTex = bundle.gradientStopsTex; }
          if (p.imageId) { paint.imageId = p.imageId; paint.imgRect = p.imgRect; paint.atlasSlot = p.atlasSlot; paint.imageTex = bundle.imageAtlasTex; paint.atlasSize = bundle.imageAtlasSize; }
          return _drawLBShapeDirect(m, paint);
        },
        renderSlugShape: canSlug ? (s) => R._renderShapeViaSlug(bundle, s) : null,
      });
      if (drew) R._lbRouteCount++;
      return drew > 0;
    }

    // Unified analytic-fill entry: classify the bundle's feature set and pick
    // the cheapest route that serves it. All-solid → the one-draw combined
    // route; gradient/image/composed → the per-shape route. Composed shapes
    // (clip/mask/inline-filter/visible-stroke) ride the shared composed path
    // (LB coverage RT → MANTLE_LB_COV ubershader → _drawComposedMorphShape) so
    // the analytic fill gets the full Slug feature set. Eligibility is checked
    // here with the right allow* flags.
    function _drawBundleLB(bundle) {
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (!meta || n < 1) return false;
      // Fast path for a streamed all-opaque solid bundle (the road): every
      // feature flag the classification loop below would compute is provably
      // false (no gradient/image/stroke/clip/mask/translucent — set at stream
      // time), so skip the O(numShapes) classification + eligibility sweeps and
      // route straight to the one-draw combined route. A per-draw recolor still
      // needs the composite path, so only take it without one. On a sentinel-
      // only frame the combine bails → fall to the per-shape static route.
      if (bundle._lbSolidOnly && bundle._lbOpaque &&
          !(R.draw.colorMatrix || R.draw.colorMatrixOffset || R.draw.palette || R.draw.channelLerp)) {
        if (_drawBundleLoopBlinn(bundle)) return true;
        return _drawBundleLBStatic(bundle);
      }
      let hasGrad = false, hasImage = false, hasComposed = false, hasStroke = false;
      let hasTransSolid = false, hasTransGradImg = false;
      for (let s = 0; s < n; s++) {
        const b = s * st;
        const gId = Math.floor(meta[b + 28] + 0.5);
        const iId = st >= 36 ? Math.floor(meta[b + 35] + 0.5) : 0;
        if (gId) hasGrad = true;
        if (iId) hasImage = true;
        if (meta[b + 11] > 0 && meta[b + 12] > 0) hasStroke = true;            // visible stroke
        if (Math.floor(meta[b + 30] + 0.5) || Math.floor(meta[b + 31] + 0.5)   // clip / mask
            || (st >= 33 && Math.floor(meta[b + 32] + 0.5))) hasComposed = true; // inline filter
        const a = meta[b + 7];                                                 // fill alpha
        if (a > 0.004 && a < 0.996) { if (gId || iId) hasTransGradImg = true; else hasTransSolid = true; }
      }
      // Per-draw recolor (colorMatrix/palette/channelLerp) applies to the paint in
      // the ubershader, so it composes via the composite path (over uLBFill) — but
      // NOT via the direct/combined draws (loopBlinn.frag has no recolor) and NOT
      // over a gradient/image paint (the composite path paints solid uLBFill). So
      // under recolor: reject gradient/image bundles → Slug; otherwise force every
      // shape through the composite path.
      const recolor = !!(R.draw.colorMatrix || R.draw.colorMatrixOffset || R.draw.palette || R.draw.channelLerp);
      // Channel-lerp/color-matrix recolor is uniform math the COMBINED route now
      // applies in-shader → a solid bundle with it batches into ONE draw instead
      // of N per-shape composites. Palette recolor needs a sampler → stays on
      // the per-shape composite path.
      const recolorUniformOnly = recolor && !R.draw.palette;
      if (recolor && (hasGrad || hasImage)) return false;
      // A translucent SOLID fill composes via the coverage→composite path (MAX-blend
      // coverage clamps self-overlap, then a single paint×coverage composite applies
      // alpha exactly). A translucent GRADIENT/IMAGE has no such path here (the
      // direct draw would conflate overlap) → whole bundle to Slug.
      if (hasTransGradImg) return false;
      // A visible stroke composes too (GPU stroke-coverage RT → MANTLE_LB_COV
      // strokeCov). Probe the stroke meshes up front so a stroked shape whose
      // stroke can't build cleanly drops the WHOLE bundle to Slug (never a
      // half-drawn shape).
      if (hasStroke) {
        const sm = _ensureLbStrokeMeshes(bundle);
        if (!sm || !R.morphStrokeProg) return false;
        for (let s = 0; s < n; s++) {
          const b = s * st;
          if (meta[b + 11] > 0 && meta[b + 12] > 0 && !sm[s]) return false;   // stroked but no mesh
        }
      }
      const composed = hasComposed || hasStroke || hasTransSolid || recolor;
      const allowGrad = hasGrad && !!bundle.gradientTex;
      const allowImage = hasImage && !!bundle.imageAtlasTex;
      // Shapes LB can't serve fall back to Slug PER-SHAPE only on a bundle that
      // keeps Slug geometry (real cover quads): a non-identity transform override,
      // a blend mode, or a COLR paint graph. A lightweight _lbStream bundle has no
      // such geometry → those features keep it on Slug via eligibility.
      const ovP = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides.packedBuffer : null;
      const canSlug = !bundle._lbStream && bundle.drawList && bundle.drawList.length > 0;
      let fallbackCount = 0;
      if (canSlug) {
        const slugOps = new Set();
        for (const op of bundle.drawList) if (op.blendMode || op.colrGraphId) slugOps.add(op.shapeIdx | 0);
        for (let s = 0; s < n; s++) {
          if ((ovP && _ovHasXform(ovP, s)) || slugOps.has(s)) fallbackCount++;
        }
        // Per-shape fallback is a win only when the unservable shapes are a
        // minority; if they're the majority, one whole-bundle Slug render beats N
        // per-shape Slug renders (e.g. an all-COLR emoji run) → decline to Slug.
        if (fallbackCount * 2 > n) return false;
      }
      // allowTrans=true only to admit the translucent solids routed to the composite
      // path below (translucent gradient/image were already rejected, so the opacity
      // gate would otherwise only reject the translucent solids we DO serve).
      if (!_loopBlinnEligible(bundle, allowGrad, hasTransSolid, allowImage, composed, canSlug)) return false;
      // All-solid (optionally uniform-recolored) → one-draw combined route. It
      // can't mix engines, so skip it when any shape needs the per-shape Slug
      // fallback (transform/blend/COLR); the combined route also bails (false)
      // for a loop/cusp/arc sentinel. Translucent SOLIDS ride it too: _ensureLbMeshes
      // builds them as CDT PARTITIONS, so the route's direct OVER (premultiplied,
      // painter-order) composites α exactly — no per-shape composite RTs. Palette
      // recolor + clip/mask/filter/stroke stay on the per-shape composite path.
      const combinedBlocked = hasComposed || hasStroke || (recolor && !recolorUniformOnly);
      if (!hasGrad && !hasImage && !combinedBlocked && !fallbackCount && _drawBundleLoopBlinn(bundle)) return true;
      return _drawBundleLBStatic(bundle);
    }

  R.drawLoopBlinnMesh = drawLoopBlinnMesh;

  R._ensureFillLBCovProg = _ensureFillLBCovProg;

  R._ensureLbmsVao = _ensureLbmsVao;
  R._renderMorphStrokeCovRT = _renderMorphStrokeCovRT;
  R._ensureLbcQuadVao = _ensureLbcQuadVao;
  R._drawComposedMorphShape = _drawComposedMorphShape;
  R._morphShapeFilter = _morphShapeFilter;
  R._ensureBundleMorphMeshes = _ensureBundleMorphMeshes;
  R._ensureBundleMorphStrokeMeshes = _ensureBundleMorphStrokeMeshes;
  R._morphPerfOk = _morphPerfOk;
  R._drawBundleMorphRoute = _drawBundleMorphRoute;
  R._lbOvrColorOnly = (ovr) => {
    const p9 = ovr && ovr.packedBuffer;
    if (!p9) return false;
    const n9 = (p9.length / 24) | 0;
    for (let s9 = 0; s9 < n9; s9++) if (_ovHasXform(p9, s9)) return false;
    return true;
  };
  R._morphShapeComposed = _morphShapeComposed;
  R._lbShapeEligible = _lbShapeEligible;
  R._loopBlinnEligible = _loopBlinnEligible;
  R._lbFail = _lbFail;
  R._ensureLbMeshes = _ensureLbMeshes;
  R._ensureLbStrokeMeshes = _ensureLbStrokeMeshes;
  R._ensureLbCombined = _ensureLbCombined;
  R._drawBundleLoopBlinn = _drawBundleLoopBlinn;
  R._drawBundleLB = _drawBundleLB;
  // EAGER BUILD: meshes are otherwise built lazily on FIRST DRAW — the visible hitch
  // when a text-heavy screen appears. Call at asset-load/scene-prepare time to move
  // the build (and the global mesh cache fill) off the first frame. Safe to call on
  // any bundle; no GPU upload happens here (that stays cheap at draw).
  R.prepareBundle = (bundle) => { try { return _ensureLbMeshes(bundle) !== null; } catch { return false; } };
  // Apply an off-thread build result: store the packed meshes so the next draw
  // upgrades this bundle from Slug to LB. `wire[s] === null` ⇒ that shape is Slug.
  // Discards a result whose generation no longer matches (bundle re-dirtied while
  // the worker ran) — a stale prefix must never render.
  // MEMORY-PROJECTED SLUG GATE: packed LB meshes measure ~72 bytes per curve
  // byte (stable across organic sheets and art pieces), so a bundle's mesh
  // footprint is known BEFORE building. When the projected total across live
  // bundles would exceed the budget, the bundle routes Slug instead —
  // reference-exact rendering from the curve buffer it already owns, at a
  // fraction of the memory. Budget via R.setLoopBlinnMemoryBudget(bytes);
  // the default scales down on low-memory devices (navigator.deviceMemory).
  const LB_BYTES_PER_CURVE_BYTE = 72;
  R._lbMemUsed = 0;
  R._lbMemCap = (() => {
    try {
      const gb = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
      return gb <= 4 ? 128 * 1024 * 1024 : 256 * 1024 * 1024;
    } catch { return 256 * 1024 * 1024; }
  })();
  R.setLoopBlinnMemoryBudget = (bytes) => { R._lbMemCap = Math.max(0, bytes | 0); };
  function _lbMemAdmit(bundle, scale) {
    if (bundle._lbMemBytes) return true;             // already accounted (rebuild)
    const projected = ((bundle.curveFloats && bundle.curveFloats.byteLength) || 0) * LB_BYTES_PER_CURVE_BYTE * (scale || 1);
    if (R._lbMemUsed + projected > R._lbMemCap) {
      if (!bundle._lbMemDenied && typeof console !== 'undefined') {
        console.warn('[mantle] LB mesh budget: bundle projected ' + (projected / 1048576).toFixed(0) + 'MB over the ' +
          (R._lbMemCap / 1048576).toFixed(0) + 'MB budget (' + (R._lbMemUsed / 1048576).toFixed(0) + 'MB in use) — rendering via Slug.');
      }
      bundle._lbMemDenied = true;
      return false;
    }
    return true;
  }
  function _lbMemAccount(bundle, packed) {
    let bytes = 0;
    if (packed) for (const pk of packed) { if (pk && pk.verts) bytes += pk.verts.byteLength; }
    R._lbMemUsed += bytes - (bundle._lbMemBytes || 0);
    bundle._lbMemBytes = bytes;
    if (!bundle._lbMemReleased9) {
      bundle._lbMemReleased9 = true;
      const prevDispose = bundle.dispose;
      bundle.dispose = function () { R._lbMemUsed -= (bundle._lbMemBytes || 0); bundle._lbMemBytes = 0; return prevDispose.apply(this, arguments); };
    }
  }
  R._lbMemAdmit = _lbMemAdmit;
  function _applyLbResult(bundle, res, reqGen) {
    if ((bundle._geomGen | 0) !== reqGen) return;
    const wire = res && res.packed;
    if (!wire || !wire.length) {                     // nothing analytic → whole-bundle Slug
      bundle._lbMeshes = null; bundle._lbMeshesRaw = null; bundle._lbGen = reqGen;
      bundle._lbHasSlug = true; bundle._lbCombined = undefined; return;
    }
    const packed = new Array(wire.length);
    for (let s = 0; s < wire.length; s++) packed[s] = (wire[s] === null) ? LB_SLUG : wire[s];
    bundle._lbMeshesRaw = undefined;                 // worker returns no CPU raw (static → no refresh/resume)
    _lbMemAccount(bundle, packed);
    bundle._lbMeshes = packed;
    bundle._lbGen = reqGen;
    bundle._lbHasSlug = !!res.hasSlug;
    bundle._lbCombined = undefined;                  // combined VBO rebuilds from the new packed set
    bundle._lbBuildS = 0; bundle._lbRawGen = reqGen;
  }
  // AUTO-BUILD: hand each newly-created bundle's Loop-Blinn triangulation to the
  // worker at load time. The heavy build runs OFF the main thread; the draw path
  // never builds (it uses ready LB, else Slug). Morph bundles still prepare on the
  // main thread (their build is a different, resumable path).
  try {
    setLbBuilder((b) => {
      try {
        if (R._lbSlugOnly) return;                   // Slug-only mode: don't build LB we'll never draw
        if (!b._geomGen && !b._morphSrc) {           // static bundle → off-thread whole-bundle build
          if (!_lbMemAdmit(b, 1)) { b._lbMeshes = null; b._lbGen = b._geomGen | 0; b._lbHasSlug = true; return; }
          const reqGen = b._geomGen | 0;
          requestLbBuild(b, (res) => _applyLbResult(b, res, reqGen));
        }
        if (b._morphSrc && !b._morphMeshesBuilt) {
          if (!_lbMemAdmit(b, 2)) { b._morphMeshesBuilt = true; b._morphMeshesPartial = null; return; }   // pair VBOs are dual-stream (2×)
          enqueueLbPrepare(b);
        }
      } catch { /* leave on Slug */ }
    });
    // Keep the idle-drain preparer registered as the no-builder fallback + the
    // morph prepare target (setLbBuilder above routes morph bundles here).
    setLbPreparer((b) => {
      try {
        if (b._morphSrc && !b._morphMeshesBuilt) { _ensureBundleMorphMeshes(b); return; }
        const gen9 = b._geomGen | 0;
        if (b._lbMeshes === undefined || b._lbGen !== gen9) _ensureLbMeshes(b, 2);
      } catch { /* draw-time fallback */ }
    });
  } catch { }
  R._drawBundleLBStatic = _drawBundleLBStatic;
  R._drawBundleLBShaded = _drawBundleLBShaded;
  R._drawLBShapeDirect = _drawLBShapeDirect;
  R._ensureLbVao = _ensureLbVao;

  // ONE mode governs the whole analytic (Loop-Blinn) fill path — static,
  // streamed, AND morph — mirroring Slug's single always-available fill path.
  // 'off' · 'auto' (DEFAULT) · 'on'. There is no separate morph toggle: "static
  // vs morph" is not a real axis (klmn-source + batching are, both handled by the
  // shared _drawBundleLBShaded driver), so a split flag would only let the two
  // drift apart.
  R._lbFillMode = 'auto';
  R._lbSlugFallback = true;   // false ('only' mode) → no Slug fallback (draw nothing if LB unready)
  R._lbSlugOnly = false;      // true ('off' mode) → Slug only, skip the off-thread LB build
  // Force option, mirroring __MANTLE_FORCE_NATIVE / ?mantleNative: pin the fill
  // mode for A/B testing + debugging via globalThis.__MANTLE_LB_MODE or the
  // ?lbMode= URL param — 'slug'/'off' (Slug only, LB build skipped) or 'lb'/'only'
  // (LB only, no Slug fallback; the static cache won't bake an empty frame).
  // Absent → 'auto'. Runtime code can also call renderer.setLoopBlinnFill(...).
  {
    let _m = (typeof globalThis !== 'undefined' && globalThis.__MANTLE_LB_MODE) || null;
    if (!_m && typeof location !== 'undefined' && location && location.search) {
      try { _m = new URLSearchParams(location.search).get('lbMode'); } catch { _m = null; }
    }
    if (_m === 'off' || _m === 'slug') { R._lbFillMode = 'off'; R._lbSlugOnly = true; }
    else if (_m === 'only' || _m === 'lb') { R._lbFillMode = 'on'; R._lbSlugFallback = false; }
  }
  // Does this bundle have a ready analytic mesh set (real LB, current generation)?
  // Used by the LB-only draw + static-cache "don't bake nothing" guards.
  R._lbBundleReady = (bundle) => !!bundle && bundle._lbMeshes != null && bundle._lbGen === (bundle._geomGen | 0);
  R._staticPerfOk = _staticPerfOk;
  R._lbRouteCount = 0;
  R._lbMorphRouteCount = 0;
  R._lbMorphComposedCount = 0;
}
