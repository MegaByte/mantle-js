// morphDraw.js — Loop-Blinn morph, signed morph RT path, bundle LB routes.

import { buildLoopBlinnMesh, refreshLoopBlinnMesh, dropDegenerateFaces, curveRangeToContours, LB_VERT_FLOATS, LB_MAX_VERTS_PER_MESH, LB_MAX_VERTS_PER_BUNDLE } from './loopBlinn.js';
import { meanShapePx2PerSeg } from './shapeScale.js';
import { setLbPreparer, setLbBuilder, enqueueLbPrepare } from './bundle.js';
import { SEG_LINE, SEG_CUBIC, SEG_ARC } from '../primitives/seg.js';
// The pure fill-route predicates + Slug sentinel live in lbBuildCore.js (the
// GL-free build core, also imported by the LB worker) so the static, morph, and
// worker build paths can't drift. Aliased to the historic underscore names.
import {
  contoursAllStraight as _contoursAllStraight,
  hasDisjointContours as _hasDisjointContours,
  SLUG as LB_SLUG,
  meshUnderCovers,
} from './lbBuildCore.js';
import { requestLbBuild, requestMorphBuild } from './lbWorkerPool.js';

// Per-draw scratch (shaded LB path) — avoids 4–5 array literals per composed shape.
const _scFill = new Float32Array(4);
const _scBBox = new Float32Array(4);
const _scCover = new Float32Array(4);
const _scStroke = new Float32Array(4);
const _scImg = new Float32Array(4);
const _scAtlas = new Float32Array(4);

// GLOBAL mesh cache: FNV(curve span)+route bits → {raw, pk} | null(=Slug);
// LRU ≤768. MUST live at MODULE level: declared any narrower it is recreated
// empty on every ensure, and per-frame gen bumps on morph/timeline bundles
// would then rebuild every shape from scratch each frame. (The worker path
// makes draw-time builds rare;
// this still serves the synchronous prewarm + morph endpoints.)
const _lbMeshCache = new Map();
const SLUG = LB_SLUG;

/** Drop module-level LB mesh caches (call from renderer.dispose). */
export function clearLbMeshCaches() {
  _lbMeshCache.clear();
}

const _lbGlStates = new WeakMap();
const MAX_PACKED_GL = 2048;
const MAX_PRIM_GL = 512;

function acquireLbGlState(gl) {
  let state = _lbGlStates.get(gl);
  if (!state) {
    state = { users: 0, packed: new Map(), prim: new Map() };
    _lbGlStates.set(gl, state);
  }
  state.users++;
  return state;
}

function releaseLbGlState(gl, state) {
  if (!state || --state.users > 0) return;
  for (const g of state.packed.values()) {
    gl.deleteVertexArray(g.vao);
    gl.deleteBuffer(g.buf);
  }
  for (const tex of state.prim.values()) gl.deleteTexture(tex);
  state.packed.clear();
  state.prim.clear();
  _lbGlStates.delete(gl);
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMorphDraw(R) {
    const _lbGlState = acquireLbGlState(R.gl);
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
    R.lbUPaintTex = _lbU('uLbPaintTex');
    R.lbUHasPaint = _lbU('uLbHasPaint');
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
    R._setLbRecolor = (enable, U = _lbFullU) => {
      const cl = enable ? R.draw.channelLerp : null;
      if (U.CLEnabled) {
        if (cl) {
          const p = cl.primary || [0, 0, 0, 1], c = cl.contrast || [0, 0, 0, 1], h = cl.highlight || [1, 1, 1, 1];
          R.gl.uniform4f(U.CLPrimary, p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
          R.gl.uniform4f(U.CLContrast, c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
          R.gl.uniform4f(U.CLHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
          R.gl.uniform1i(U.CLEnabled, 1);
        } else R.gl.uniform1i(U.CLEnabled, 0);
      }
      const cm = enable ? R.draw.colorMatrix : null, cmo = enable ? R.draw.colorMatrixOffset : null;
      if (U.CMatrixEnabled) {
        if (cm || cmo) {
          R.gl.uniformMatrix4fv(U.CMatrix, false, cm || R.IDENTITY_COLOR_MATRIX);
          R.gl.uniform4fv(U.CMatrixOffset, cmo || R.ZERO_OFFSET);
          R.gl.uniform1i(U.CMatrixEnabled, 1);
        } else R.gl.uniform1i(U.CMatrixEnabled, 0);
      }
    };
    const _lbUniformSet = (prog) => {
      const u = (name) => prog ? R.gl.getUniformLocation(prog, name) : null;
      return {
        prog,
        GBB: u('uGlobalBBox'), OvrTex: u('uOverrideTex'), HasOvr: u('uLbHasOvr'),
        CanvasAR: u('uCanvasAR'), WorldM: u('uWorldM'), HasWorldM: u('uHasWorldM'),
        Viewport: u('uViewportSize'), Direct: u('uDirect'), Alpha: u('uAlpha'),
        GradId: u('uGradId'), PaintTex: u('uLbPaintTex'), HasPaint: u('uLbHasPaint'),
        ShapeBBox: u('uShapeBBox'), GradientTex: u('uGradientTex'), GradientStops: u('uGradientStops'),
        ImageId: u('uImageId'), ImgRect: u('uImgRect'), AtlasSlot: u('uAtlasSlot'),
        ImageTex: u('uImageTex'), ImageAtlasSize: u('uImageAtlasSize'),
        CLPrimary: u('uChannelLerpPrimary'), CLContrast: u('uChannelLerpContrast'),
        CLHighlight: u('uChannelLerpHighlight'), CLEnabled: u('uChannelLerpEnabled'),
        CMatrix: u('uColorMatrix'), CMatrixOffset: u('uColorMatrixOffset'),
        CMatrixEnabled: u('uColorMatrixEnabled'),
      };
    };
    const _lbFullU = _lbUniformSet(R.lbProg);
    const _lbLeanU = _lbUniformSet(R.lbProgLean);
    const _lbSetFor = (packed) => {
      if (packed && packed.hasBezout === false && _lbLeanU.prog) return _lbLeanU;
      return _lbFullU;
    };
    R.lbcUCoverage = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uCoverage') : null;
    R.lbcUColor = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uColor')    : null;
    // viewport / allocated-RT-size — the pooled coverage RT is quantized (>= viewport),
    // so the composite quad's UV must be scaled into the rendered region.
    R.lbcUCovScale = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uCovScale') : null;
    let _lbVao = null, _lbBuf = null, _lbCap = 0;
    // Packed meshes are immutable, so keep one uploaded copy per WebGL context.
    // Re-upload if the CPU buffer grew (identity reuse / cache hits).
    function _bindPackedVao(packed) {
      let g = _lbGlState.packed.get(packed);
      const bytes = (packed.verts && packed.verts.byteLength) || 0;
      if (!g) {
        g = { vao: R.gl.createVertexArray(), buf: R.gl.createBuffer(), bytes: 0 };
        _lbGlState.packed.set(packed, g);
        R.gl.bindVertexArray(g.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, g.buf);
        _specLbAttribs();
        R.gl.bufferData(R.gl.ARRAY_BUFFER, packed.verts, R.gl.STATIC_DRAW);
        g.bytes = bytes;
        if (_lbGlState.packed.size > MAX_PACKED_GL) {
          const oldest = _lbGlState.packed.entries().next().value;
          if (oldest && oldest[0] !== packed) {
            _lbGlState.packed.delete(oldest[0]);
            R.gl.deleteVertexArray(oldest[1].vao);
            R.gl.deleteBuffer(oldest[1].buf);
          }
        }
      } else {
        _lbGlState.packed.delete(packed);
        _lbGlState.packed.set(packed, g);
        R.gl.bindVertexArray(g.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, g.buf);
        if (bytes !== g.bytes) {
          R.gl.bufferData(R.gl.ARRAY_BUFFER, packed.verts, R.gl.STATIC_DRAW);
          g.bytes = bytes;
        }
      }
    }
    /** Clamp a drawArrays count to what the VBO can feed at `floatsPerVert`.
     *  Pass `byteLength` from the CPU upload (or tracked GL cap) — do NOT rely
     *  on ARRAY_BUFFER_BINDING after bindVertexArray (that binding is not VAO
     *  state). Prevents `GL_INVALID_OPERATION: Vertex buffer is not big enough`. */
    function _lbClampDrawCount(want, floatsPerVert, byteLength) {
      const n = want | 0;
      if (n <= 0) return 0;
      const fpv = floatsPerVert | 0;
      if (fpv <= 0) return 0;
      const bytes = byteLength | 0;
      if (bytes <= 0) return 0;
      const maxN = (bytes / (fpv * 4)) | 0;
      if (maxN < n && typeof console !== 'undefined') {
        console.warn('[mantle] LB draw clamped ' + n + ' → ' + maxN +
          ' verts (VBO too small for draw call)');
      }
      return maxN < n ? maxN : n;
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
      // aColor (7) + aShapeRow (9) are constants on the packed path — leave them
      // DISABLED so a stale enable from the combined route VAO can't demand
      // bytes past the 24-float pack (that trips "Vertex buffer is not big enough").
      R.gl.disableVertexAttribArray(7);
      R.gl.disableVertexAttribArray(9);
    }
    // GPU-resident morph-STROKE resources: program uniforms + a per-primitive
    // control-point data texture (RGBA32F, src texels then dst). Morph FILL
    // draws ride the pair program (_ensureLbPairProg / lbppU) above.
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
    function _bindPairMesh(mesh) {
      _ensureLbppVao();
      R.gl.bindVertexArray(_lbppVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbppBuf);
      const bytes = (mesh.vbo && mesh.vbo.byteLength) || 0;
      if (_lbppResident !== mesh || bytes !== _lbppCap) {
        R.gl.bufferData(R.gl.ARRAY_BUFFER, mesh.vbo, R.gl.STATIC_DRAW);
        _lbppCap = bytes;
        _lbppResident = mesh;
      }
    }
    // COVERAGE pass for a pair mesh (composed/translucent morphs): same program,
    // uDirect=0 → the static frag emits raw coverage; MAX blend into a pooled RT;
    // the composite stage (lbCompProg) is shared with the static cov path.
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
      // (Pooled reuse doesn't rebind, which is why it self-healed after frame 1.)
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
      // Pair VBO is 48 floats/vert ([src24|dst24]).
      const nPair = _lbClampDrawCount(mesh.vertexCount, 48, mesh.vbo && mesh.vbo.byteLength);
      if (nPair > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nPair);
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
      const nPair = _lbClampDrawCount(mesh.vertexCount, 48, mesh.vbo && mesh.vbo.byteLength);
      if (nPair > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nPair);
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
      const U = _lbSetFor(packed);
      R.gl.useProgram(U.prog);
      R.gl.uniform4f(U.GBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.CanvasAR, sx, sy);
      R.gl.uniform2f(U.Viewport, cw, ch);
      R.gl.uniform1i(U.Direct, 0);
      if (worldM) { R.gl.uniformMatrix3fv(U.WorldM, false, worldM); R.gl.uniform1i(U.HasWorldM, 1); }
      else R.gl.uniform1i(U.HasWorldM, 0);
      _bindPackedVao(packed);
      const nCov = _lbClampDrawCount(packed.vertexCount, LB_VERT_FLOATS, packed.verts && packed.verts.byteLength);
      if (nCov > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nCov);
  
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
      // The pooled RT is quantized (>= viewport); map the quad's UV into the
      // bottom-left viewport-sized region actually rendered. Without this the
      // composite reads past the coverage on any canvas that isn't a multiple
      // of the pool quantum (content shrunk toward the origin).
      if (R.lbcUCovScale) R.gl.uniform2f(R.lbcUCovScale, cw / rt.size[0], ch / rt.size[1]);
      R.gl.bindVertexArray(R.coverVao);
      R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
      R.gl.bindVertexArray(null);
      // Unbind the coverage texture from unit 0: this RT goes back to the pool, and
      // the NEXT drawLoopBlinnMesh's pass-1 may re-acquire it as its render target.
      // If it were still bound here, that pass-1 draw would form a framebuffer↔texture
      // FEEDBACK LOOP (GL_INVALID_OPERATION → the draw is dropped → blank coverage).
      R.gl.bindTexture(R.gl.TEXTURE_2D, null);
  
      R._covPool.release(rtIdx);
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;   // next Slug pass rebinds
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
      const _ps0 = R._pendingShaders.length, _pp0 = R._pendingPrograms.length;
      const vs = R.compile(R.withDefines(R.shaderSources.fillVert, defs), R.gl.VERTEX_SHADER);
      const fs = R.compile(R.withDefines(R.shaderSources.fillFrag, defs), R.gl.FRAGMENT_SHADER);
      const p = R.gl.createProgram();
      R.gl.attachShader(p, vs); R.gl.attachShader(p, fs); R.gl.linkProgram(p);
      if (!R.gl.getShaderParameter(vs, R.gl.COMPILE_STATUS) || !R.gl.getShaderParameter(fs, R.gl.COMPILE_STATUS)
          || !R.gl.getProgramParameter(p, R.gl.LINK_STATUS)) {
        R.mantleWarn('[Mantle] MANTLE_LB_COV fill variant failed to build; clip/mask/filter morphs fall back to Slug.',
          R.gl.getShaderInfoLog(vs), R.gl.getShaderInfoLog(fs), R.gl.getProgramInfoLog(p));
        // Drop ONLY our tail entries — zeroing the whole queue dropped
        // deferred validation for unrelated in-flight programs.
        R._pendingShaders.length = _ps0; R._pendingPrograms.length = _pp0;
        R.gl.deleteProgram(p); R.gl.deleteShader(vs); R.gl.deleteShader(fs);
        return (_fillLBCovProg = null);
      }
      R._pendingShaders.length = _ps0; R._pendingPrograms.length = _pp0;   // validated inline (ours only)
      R.gl.deleteShader(vs); R.gl.deleteShader(fs);
      const U = {};
      for (const n of FILL_UNIFORM_NAMES) U[n] = R.gl.getUniformLocation(p, n);
      _lbcU = U;
      return (_fillLBCovProg = p);
    }
    let _lbGlStateReleased = false;
    R._disposeLbCovPrograms = () => {
      if (_fillLBCovProg) R.gl.deleteProgram(_fillLBCovProg);
      if (_lbVao) R.gl.deleteVertexArray(_lbVao);
      if (_lbBuf) R.gl.deleteBuffer(_lbBuf);
      if (_lbppVao) R.gl.deleteVertexArray(_lbppVao);
      if (_lbppBuf) R.gl.deleteBuffer(_lbppBuf);
      if (_lbmsVao) R.gl.deleteVertexArray(_lbmsVao);
      if (_lbmsBuf) R.gl.deleteBuffer(_lbmsBuf);
      if (_lbcQuadVao) R.gl.deleteVertexArray(_lbcQuadVao);
      if (_lbcQuadBuf) R.gl.deleteBuffer(_lbcQuadBuf);
      _lbVao = _lbBuf = _lbppVao = _lbppBuf = null;
      _lbmsVao = _lbmsBuf = _lbcQuadVao = _lbcQuadBuf = null;
      if (!_lbGlStateReleased) {
        _lbGlStateReleased = true;
        releaseLbGlState(R.gl, _lbGlState);
      }
      _fillLBCovProg = undefined;
      _lbcU = null;
    };
  
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
      if (_lbmsResident !== sMesh || ((sMesh.vbo && sMesh.vbo.byteLength) || 0) !== _lbmsCap) {
        const bytes = (sMesh.vbo && sMesh.vbo.byteLength) || 0;
        R.gl.bufferData(R.gl.ARRAY_BUFFER, sMesh.vbo, R.gl.STATIC_DRAW);
        _lbmsCap = bytes;
        _lbmsResident = sMesh;
      }
      let primTex = _lbGlState.prim.get(sMesh);
      if (!primTex) {
        primTex = R.gl.createTexture();
        R.gl.bindTexture(R.gl.TEXTURE_2D, primTex);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
        R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA32F, sMesh.primW, sMesh.primH, 0, R.gl.RGBA, R.gl.FLOAT, sMesh.prim);
        _lbGlState.prim.set(sMesh, primTex);
        if (_lbGlState.prim.size > MAX_PRIM_GL) {
          const oldest = _lbGlState.prim.entries().next().value;
          if (oldest && oldest[0] !== sMesh) {
            _lbGlState.prim.delete(oldest[0]);
            R.gl.deleteTexture(oldest[1]);
          }
        }
      } else {
        _lbGlState.prim.delete(sMesh);
        _lbGlState.prim.set(sMesh, primTex);
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
      R.gl.activeTexture(R.gl.TEXTURE0); R.gl.bindTexture(R.gl.TEXTURE_2D, primTex); R.gl.uniform1i(R.morphStrokeU.uPrim, 0);
      if (R.morphStrokeU.uDashTex) { R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, dashTex || R.dummyDashTex); R.gl.uniform1i(R.morphStrokeU.uDashTex, 1); }
      R.gl.bindVertexArray(_lbmsVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _lbmsBuf);
      // Stroke mesh: 4 floats/vert.
      const nStroke = _lbClampDrawCount(sMesh.vertexCount, 4, sMesh.vbo && sMesh.vbo.byteLength);
      if (nStroke > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nStroke);
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
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;        // next Slug pass rebinds default program
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
        // The morph route keeps the canvas-sized SourceGraphic (its shape FBO is shared
        // with the morph passes), so it takes the node rects only.
        const fInfo = R._filterNodeRects(graph, s, cw, ch);
        const rootRT = R.evaluateGraph(R.gl, graph, R._rtPool, R._svgDispatch, ctx, cw, ch,
          fInfo ? fInfo.rects : null);
        R._filterEvalCount++;
        for (const tex of ctLUTs) if (tex) R.gl.deleteTexture(tex);
        R._compositeFilteredTex(rootRT.tex, R.mainCopyTex, cw, ch, null, rootRT.rect || null);
        R.releaseRoot(R._rtPool, rootRT);   // hand the root back — see renderer.js
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
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;
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
    // the Slug morph path. The mode is the SHARED R._lbFillMode (one toggle for
    // static + streamed + morph); the morph counters are R._lbMorphRouteCount /
    // R._lbMorphComposedCount.
    // SIMILARITY-invariant mesh cache: canonical-form key -> { raw, frame }.
    // Serves any translate/rotate/uniform-scale instance of a shape by transforming the full cached
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
    R._clearLbCaches = () => {
      clearLbMeshCaches();
      _lbSimCache.clear();
    };
    // Adopt the worker's (or deferred-sync's) morph-pair build. `src` is the
    // _morphSrc captured at kickoff — if it no longer matches, the bundle was
    // re-targeted or disposed while the build was in flight, so drop the result.
    function _applyMorphResult(bundle, res, src) {
      if (!bundle || bundle._disposed || bundle._morphSrc !== src) return;
      bundle._morphWorkerSrc = src;
      bundle._morphMeshesBuilt = true;
      bundle._morphMeshesPartial = null;
      if (!res || res.err || res.hasSlug || !res.meshes) { bundle._morphMeshes = null; return; }   // whole-bundle Slug
      bundle._morphMeshes = res.meshes;
      let mb = 0;
      for (const m of res.meshes) {
        if (!m) continue;
        if (m.vbo) mb += m.vbo.byteLength;
        if (m.segments) for (const sg of m.segments) if (sg && sg.vbo) mb += sg.vbo.byteLength;
      }
      R._lbMemUsed += mb - (bundle._lbMemBytes || 0);
      bundle._lbMemBytes = mb;
    }
    function _ensureBundleMorphMeshes(bundle) {
      if (bundle._morphMeshesBuilt) return bundle._morphMeshes;
      const src = bundle._morphSrc;
      const ranges = src && src.curveRanges, n = bundle.numShapes | 0;
      // latch the failure + fall back (null → the route Slugs the bundle)
      const _mmFail = () => { bundle._morphMeshesBuilt = true; bundle._morphMeshesPartial = null; return null; };
      if (!src || !src.matchedAll || !ranges || n < 1) return _mmFail();
      if (!R._lbMemAdmit(bundle, 2)) return _mmFail();   // dual-stream pair VBOs project 2×
      // OFF-THREAD BUILD. The morph-pair mesh build (the former 8ms/frame
      // main-thread hitch on animated content) runs in the LB worker, keyed by the
      // morph SOURCE object (a re-target sets a fresh _morphSrc → a fresh build).
      // While it's in flight we render Slug — the SAME "Slug until built" behaviour
      // the budgeted main-thread build had, now off the main thread. The worker (or
      // its deferred-sync fallback where Worker is unavailable) fills _morphMeshes
      // via _applyMorphResult. requestMorphBuild catches internally — the worker
      // post AND the no-Worker deferred-sync fallback (_scheduleSyncBuild) — so a
      // throw here is only a can't-even-issue edge; degrade the bundle to Slug.
      if (bundle._morphWorkerSrc === src) return null;   // worker in flight → Slug this frame
      try { requestMorphBuild(bundle, (res) => _applyMorphResult(bundle, res, src)); }
      catch { return _mmFail(); }
      bundle._morphWorkerSrc = src;
      return null;
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

    // Static auto-routing accepts features served by the combined batch and
    // rejects features that require per-shape coverage/composite passes. The
    // result is geometry-dependent and cached by generation.
    function _staticPerfOk(bundle) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbPerfOkGen === gen) return bundle._lbPerfOk;
      let ok = true;
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (!meta || n < 1) ok = false;
      // Text is not feature-vetoed; mesh density and device coverage decide it
      // with the other cubic geometry after construction.
      else if (bundle.filterGraphs && bundle.filterGraphs.some(g => g)) ok = false;
      // Translucent solids and opaque gradients/images remain eligible because
      // their paint data rides the combined batch. Unsupported translucent paint
      // and recolor combinations are rejected by the draw route itself.
      else for (let s = 0; s < n; s++) {
        const b = s * st;
        if ((meta[b + 11] > 0 && meta[b + 12] > 0)                    // visible stroke
            || Math.floor(meta[b + 30] + 0.5) !== 0                   // clip
            || Math.floor(meta[b + 31] + 0.5) !== 0                   // mask
            || (st >= 33 && Math.floor(meta[b + 32] + 0.5) !== 0)) {  // inline filter
          ok = false; break;
        }
        if (st >= 45) {
          const pk = Math.floor(meta[b + 44] + 0.5);
          if (pk === 2 || pk === 3) { ok = false; break; }
          if (pk === 1) {
            const w = meta[b + 2] - meta[b], h = meta[b + 3] - meta[b + 1];
            if (Math.abs(w - h) <= 1e-3 * Math.max(w, 1e-6)) { ok = false; break; }
          }
        }
      }
      bundle._lbPerfOkGen = gen; bundle._lbPerfOk = ok;
      return ok;
    }

    const LB_CURVED_MASK = (1 << SEG_CUBIC) | (1 << SEG_ARC);
    const LB_MAX_BYTES_PER_SEG = 128;
    const LB_MAX_PX2_PER_SEG = 1000;

    // The full-window GPU balance suite found a stable static-LB region only for
    // bundles whose curved geometry is exclusively cubic or exclusively arc.
    // Straight and quadratic fills lose to the coverage engines, while mixing
    // cubic and arc work prevents either specialization from paying for the mesh.
    // This type-only test can run before construction and therefore avoids the
    // worker time and resident memory for bundles auto mode will never serve.
    function _lbAutoTypeOk(bundle) {
      if (!bundle) return false;
      const curved = (bundle.segTypeMask | 0) & LB_CURVED_MASK;
      return curved === (1 << SEG_CUBIC) || curved === (1 << SEG_ARC);
    }

    // The post-build auto gate uses measured mesh complexity as well as device
    // size. Compact cubic/arc meshes win while the coverage per segment remains
    // moderate; high-subdivision meshes and large per-segment screen footprints
    // favor AAC/Slug. A single compact arc shape remains a consistent LB win.
    // This is intentionally not cached because the viewport/world matrix changes.
    const LB_BAIL_XOVER = 8;
    function _lbSizeOk(bundle) {
      if (!_lbAutoTypeOk(bundle) || bundle._lbHasSlug) return false;
      const totalSegs = (bundle.numShapes | 0) * bundle.meanSegsPerShape;
      if (!bundle.meanShapeArea || !(totalSegs > 0) || !(bundle._lbMemBytes > 0)) return false;
      const bytesPerSeg = bundle._lbMemBytes / totalSegs;
      const px2PerSeg = meanShapePx2PerSeg(R, bundle);
      R._lbAutoPx2PerSeg = px2PerSeg;
      R._lbAutoBytesPerSeg = bytesPerSeg;
      if (bytesPerSeg > LB_MAX_BYTES_PER_SEG) return false;
      const curved = (bundle.segTypeMask | 0) & LB_CURVED_MASK;
      return (curved === (1 << SEG_ARC) && (bundle.numShapes | 0) === 1)
        || px2PerSeg <= LB_MAX_PX2_PER_SEG;
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
      // Cached per _geomGen/_cullGen (immutable between rebuilds) — no per-frame alloc.
      const order = _ensureLbOrder(bundle, meshes);
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
        _scFill[0] = fr; _scFill[1] = fg; _scFill[2] = fb; _scFill[3] = fa;
        const fillCol = _scFill;
        _scBBox[0] = meta[b] * it + dmeta[b] * t;
        _scBBox[1] = meta[b + 1] * it + dmeta[b + 1] * t;
        _scBBox[2] = meta[b + 2] * it + dmeta[b + 2] * t;
        _scBBox[3] = meta[b + 3] * it + dmeta[b + 3] * t;
        const shapeBBox = _scBBox;
        // Composed (clip/mask/inline-filter/visible-stroke), translucent solid, or
        // recolored solid → coverage RT(s) → MANTLE_LB_COV composite (handles α +
        // post-fill systems exactly). Direct path can't.
        const transSolid = fa > 0.004 && fa < 0.996 && gId === 0 && imageId === 0;
        if (_morphShapeComposed(meta, b, st) || transSolid || (recolor && gId === 0 && imageId === 0)) {
          _scCover[0] = shapeBBox[0]; _scCover[1] = shapeBBox[1];
          _scCover[2] = shapeBBox[2]; _scCover[3] = shapeBBox[3];
          const coverBBox = _scCover;
          _scStroke[0] = meta[b + 8] * it + dmeta[b + 8] * t;
          _scStroke[1] = meta[b + 9] * it + dmeta[b + 9] * t;
          _scStroke[2] = meta[b + 10] * it + dmeta[b + 10] * t;
          _scStroke[3] = meta[b + 11] * it + dmeta[b + 11] * t;
          const strokeCol = _scStroke;
          let imgRect = null;
          if (st >= 40) {
            _scImg[0] = meta[b + 36] * it + dmeta[b + 36] * t;
            _scImg[1] = meta[b + 37] * it + dmeta[b + 37] * t;
            _scImg[2] = meta[b + 38] * it + dmeta[b + 38] * t;
            _scImg[3] = meta[b + 39] * it + dmeta[b + 39] * t;
            imgRect = _scImg;
          }
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
          if (st >= 40) {
            _scImg[0] = meta[b + 36] * it + dmeta[b + 36] * t;
            _scImg[1] = meta[b + 37] * it + dmeta[b + 37] * t;
            _scImg[2] = meta[b + 38] * it + dmeta[b + 38] * t;
            _scImg[3] = meta[b + 39] * it + dmeta[b + 39] * t;
          } else { _scImg[0] = 0; _scImg[1] = 0; _scImg[2] = 1; _scImg[3] = 1; }
          _scAtlas[0] = meta[b + 40]; _scAtlas[1] = meta[b + 41];
          _scAtlas[2] = meta[b + 42]; _scAtlas[3] = meta[b + 43];
          if (mode.renderDirect(m, { color: fillCol, imageId, imgRect: _scImg, atlasSlot: _scAtlas, shapeBBox })) drew++;
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
      if (!_loopBlinnEligible(bundle, allowGrad, /* allowTrans */ true, allowImage, allowComposed, undefined, /* allowPrim */ true)) return false;
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
    function _lbShapeEligible(meta, b, st, allowGrad, allowTrans, allowImage, allowComposed, allowPrim) {
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
      // allowPrim (the MORPH route): primFast SDF params don't lerp on the Slug
      // morph path — its per-frame CPU curve lerp + upload is the cost the
      // GPU-resident pair removes — so a morphing prim IS worth the analytic
      // route (a circle pairs as kind-7/crescents whose params lerp in the VS).
      if (st >= 45 && !allowPrim) {
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
    function _loopBlinnEligible(bundle, allowGrad, allowTrans, allowImage, allowComposed, allowSlugFallback, allowPrim) {
      if (!R.lbProg || !R.lbCompProg || !bundle) return false;
      // Pure function of (geometry gen, flags) — cache per bundle. The
      // O(numShapes) meta sweep ran per draw per frame for static
      // LB-routed bundles.
      const gen9 = bundle._geomGen | 0;
      const fk9 = (allowGrad ? 1 : 0) | (allowTrans ? 2 : 0) | (allowImage ? 4 : 0)
                | (allowComposed ? 8 : 0) | (allowSlugFallback ? 16 : 0) | (allowPrim ? 32 : 0);
      const ec9 = bundle._lbEligCache;
      if (ec9 && ec9.gen === gen9 && ec9.fk === fk9) return ec9.ok;
      const ok9 = _loopBlinnEligibleUncached(bundle, allowGrad, allowTrans, allowImage, allowComposed, allowSlugFallback, allowPrim);
      bundle._lbEligCache = { gen: gen9, fk: fk9, ok: ok9 };
      return ok9;
    }
    function _loopBlinnEligibleUncached(bundle, allowGrad, allowTrans, allowImage, allowComposed, allowSlugFallback, allowPrim) {
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
      for (let s = 0; s < n; s++) if (!_lbShapeEligible(meta, s * st, st, allowGrad, allowTrans, allowImage, allowComposed, allowPrim)) return false;
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
    function _lbFail(bundle, gen) { bundle._lbMeshes = null; bundle._lbMeshesRaw = null; bundle._lbGen = gen; bundle._lbHasSlug = true; return null; }
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
      // build AMORTIZES across frames instead of freezing one (a heavy morph
      // set can take seconds to build). Small bundles finish inside the budget and are
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
        // shape (hundreds of segs) can still eat seconds in
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
          // Curved / multi-contour / translucent → CDT; single-contour opaque
          // straight polygons keep earcut (streaming). Exact FNV cache, then
          // similarity orbit (canonical frame + near-tie axes).
          if (r && contours) {
            _simFrame = R.lbCanonicalFrame(contours);
            const _rb9 = (transSolid ? '_t' : '') + (meta && meta[s * mst + 13] > 0.5 ? '_e' : '');
            if (_simFrame) {
              // One contour walk for primary + near-tie candidate axes.
              const frames = _simFrame.cands
                ? [_simFrame, ..._simFrame.cands]
                : [_simFrame];
              const keys = R.lbCanonicalHashes(contours, frames);
              _simKey = keys[0] + _rb9;
              const selfS = bundle._lbShapeSim && bundle._lbShapeSim[s];
              if (selfS && !selfS.slug && selfS.key !== _simKey && frames.length > 1) {
                for (let ci = 1; ci < frames.length; ci++) {
                  const k9 = keys[ci] + _rb9;
                  if (k9 === selfS.key) { _simKey = k9; _simFrame = frames[ci]; break; }
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
            } else {
              _simKey = null;
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
            if (!transSolid && contours.length === 1 && !R._lbForceCdt) {
              let m = null;
              // ramp=true: static shapes get the interior boundary-feature ramps (thin-stroke
              // zigzag AA); the streaming path builds its own meshes without the flag.
              try { m = R.buildLoopBlinnMesh(contours, true); } catch { m = null; }
              // The cheap mesh must be able to COVER the shape; see meshUnderCovers.
              // A mesh that cannot is missing paint no shader can recover, so fall
              // through to the CDT below exactly as hasConcave does.
              if (m && !m.fallback.length && !m.hasConcave && !meshUnderCovers(m, contours)) {
                dropDegenerateFaces(m);
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
            try { cdt = R.buildLoopBlinnCDT(contours, {
              fillRule: meta && meta[s * mst + 13] > 0.5 ? 'evenodd' : 'nonzero',
              transSolid,
            }); } catch { cdt = null; }
            if (cdt && !cdt.fallback.length) {
              dropDegenerateFaces(cdt);
              const pk = R.packLoopBlinnMesh(cdt);
              _mcPut({ raw: cdt, pk });
              raw.push(cdt); packed.push(pk); hasReal = true; continue;
            }
            _mcPut(null);
            raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
          }
          try {
            // forceCdt (setLoopBlinnMeshOpts): skip fast mesh → CDT partitions.
            if (R._lbForceCdt) mesh = null;
            else
            // Reuse a cached FAST triangulation (refresh); a CDT mesh (curved-holed
            // shape from a prior frame) has no _topo, so refresh rebuilds it fast.
            mesh = (prevRaw && prevRaw[s] && !prevRaw[s].slug && !prevRaw[s].mode)
              ? R.refreshLoopBlinnMesh(prevRaw[s], contours) : R.buildLoopBlinnMesh(contours, true);
          } catch { mesh = null; }
          if (mesh && mesh.fallback.length) mesh = null;   // self-intersecting (loop) → Slug
          if (!mesh) {
            // A straight single contour the fast rim can't thread (self-CROSSING
            // outline — pentagram/bowtie) — the CDT partition splits the crossing
            // constraints at their intersection (lbPartition) and winding-deletes to
            // the exact even-odd/nonzero fill, so it renders via LB instead of Slug.
            let cdt9 = null;
            try { cdt9 = R.buildLoopBlinnCDT(contours, { fillRule: meta && meta[s * mst + 13] > 0.5 ? 'evenodd' : 'nonzero' }); } catch { cdt9 = null; }
            if (cdt9 && !cdt9.fallback.length && cdt9.interior && cdt9.interior.length) mesh = cdt9;
          }
        }
        // Straight single contour the fast rim can't thread AND the G4 CDT above
        // couldn't partition (a degenerate/empty self-crossing outline). Curved
        // loop/cusp shapes decline earlier (the CDT-fallback branch at ~1616); native
        // ARCS build (rational-quad kind-5), so they never reach here. Rare in practice.
        if (!mesh) { if (typeof _mcPut === 'function') _mcPut(null); raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue; }
        {
          // Drop degenerate crack-heal shards on junction-heavy glyphs before
          // packing (output-exact: sub-1e-9-em faces paint nothing). Deterministic,
          // so a per-frame refresh re-derives the same swept mesh.
          dropDegenerateFaces(mesh);
          const pk = R.packLoopBlinnMesh(mesh);
          if (!pk || pk.overBudget || !(pk.vertexCount > 0) || pk.vertexCount > LB_MAX_VERTS_PER_MESH) {
            if (typeof _mcPut === 'function') _mcPut(null);
            raw.push(SLUG); packed.push(SLUG); hasSlug = true; continue;
          }
          if (typeof _mcPut === 'function' && !prevRaw) _mcPut({ raw: mesh, pk });
          raw.push(mesh); packed.push(pk); hasReal = true;
        }
      }
      if (!hasReal && hasSlug && !partial) return _lbFail(bundle, gen);   // nothing analytic to do → whole-bundle Slug
      // Whole-bundle vert cap (many mid-size shapes).
      if (!partial && hasReal) {
        let nV = 0;
        for (const pk of packed) if (pk && pk.vertexCount) nV += pk.vertexCount;
        if (nV > LB_MAX_VERTS_PER_BUNDLE) {
          if (typeof console !== 'undefined') {
            console.warn('[mantle] LB mesh budget: bundle has ' + nV + ' verts (cap '
              + LB_MAX_VERTS_PER_BUNDLE + ') — rendering via Slug.');
          }
          return _lbFail(bundle, gen);
        }
      }
      if (budgeted) _bpSpent += Date.now() - tEns0;
      if (partial) {
        bundle._lbMeshesRaw = raw;
        bundle._lbGen = null;            // NOT gen: re-ensure resumes next draw
        bundle._lbHasSlug = true;
        bundle._lbBuildS = partialAtS;   // resume point: shapes < this are finalized
        bundle._lbRawGen = gen;          // guards the resumed prefix against a stale generation
        try { enqueueLbPrepare(bundle); } catch { }   // idle finishes it even without draws
        if (!_lbMemAccount(bundle, packed)) return null;
        return (bundle._lbMeshes = packed);
      }
      bundle._lbMeshesRaw = raw;
      bundle._lbGen = gen;
      bundle._lbHasSlug = hasSlug;
      bundle._lbBuildS = 0;             // fully built → no resume prefix
      bundle._lbRawGen = gen;
      bundle._lbCombined = undefined;   // geometry changed → combined buffer stale
      if (!_lbMemAccount(bundle, packed)) return null;
      return (bundle._lbMeshes = packed);
    }
    // One contiguous 28-float VBO (24 geometry + per-vertex RGBA) for the whole
    // bundle in painter order → a single drawArrays. Cached; rebuilt only when
    // geometry changes. Per-shape fill color is baked per vertex (the draw-time
    // global alpha stays a uniform so it doesn't force a rebuild).
    // The imported stride is available before renderer members are published.
    const _RVF = LB_VERT_FLOATS + 5;   // route vertex floats (29: 24 geom + 4 colour + shapeRow)
    // Draw-path readiness gate — NEVER builds. Returns the worker-delivered packed
    // meshes when they're current (or `null` = whole-bundle Slug, also "ready"), or
    // `undefined` while the build is pending so the caller falls back to Slug
    // (LB > Slug > nothing). All LB construction happens off-thread at load; a draw
    // must not stall to triangulate. Mirrors _ensureLbMeshes's cache-hit gate.
    function _lbReadyMeshes(bundle) {
      const gen = bundle._geomGen | 0;
      return (bundle._lbMeshes !== undefined && bundle._lbGen === gen) ? bundle._lbMeshes : undefined;
    }
    // Can the slug-sentinel shapes be DEFERRED to after the combined draw?
    //
    // _ensureLbCombined's VBO already skips sentinels; the only reason it bailed on
    // _lbHasSlug was painter order. Moving a sentinel later in paint order is a no-op
    // for every shape it does not overlap — so if no LB shape painted AFTER a sentinel
    // overlaps that sentinel's bbox, the sentinels can all be drawn last, via Slug,
    // and the other shapes keep the one-draw combined route.
    //
    // (Shapes painted BEFORE a sentinel are unaffected: the sentinel was on top of
    // them already and still is. Sentinels keep their relative order among themselves.)
    //
    // Non-overlapping sentinels can be deferred without changing painter order;
    // overlapping artwork fails the test and uses the per-shape path.
    // Returns the sentinel shape indices in paint order, or null if not deferrable.
    function _lbDeferrableSentinels(bundle, order, meshes) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbDeferGen === gen) return bundle._lbDefer;
      bundle._lbDeferGen = gen;
      // A sentinel is drawn via the per-shape Slug fallback, which needs Slug geometry.
      if (bundle._lbStream || !(bundle.drawList && bundle.drawList.length))
        return (bundle._lbDefer = null);
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0;
      if (!meta || !st) return (bundle._lbDefer = null);
      const sent = [];
      for (let i = 0; i < order.length; i++) {
        const m = meshes[order[i]];
        if (!m || !m.vertexCount) sent.push(i);
      }
      if (!sent.length) return (bundle._lbDefer = null);
      for (const i of sent) {
        const b = order[i] * st;
        const ax0 = meta[b], ay0 = meta[b + 1], ax1 = meta[b + 2], ay1 = meta[b + 3];
        for (let j = i + 1; j < order.length; j++) {
          const m = meshes[order[j]];
          if (!m || !m.vertexCount) continue;            // another sentinel: order kept
          const c = order[j] * st;
          const disjoint = meta[c + 2] <= ax0 || meta[c] >= ax1
                        || meta[c + 3] <= ay0 || meta[c + 1] >= ay1;
          if (!disjoint) return (bundle._lbDefer = null);   // a later LB shape overlaps it
        }
      }
      return (bundle._lbDefer = sent.map((i) => order[i]));
    }

    // Pack the bundle's ready LB meshes into ONE interleaved VBO in painter order
    // (sentinels skipped — they carry no vertexCount). Shared by the one-draw combined
    // route and the segmented split route. Returns { verts, count, vFirst, vCount };
    // vFirst/vCount are per-SHAPE-ROW vertex spans (0 for skipped shapes), so a caller
    // can slice a contiguous shape range (a sprite) or a contiguous run (the split).
    function _packLbCombined(bundle, meshes, order, prevVerts) {
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0;
      const VF = LB_VERT_FLOATS;
      let totalVerts = 0, hasBezout = false;
      for (const s of order) {
        const m = meshes[s];
        if (!m || !m.vertexCount || !m.verts) continue;
        const capped = Math.min(m.vertexCount | 0, (m.verts.length / VF) | 0);
        if (capped > 0) {
          totalVerts += capped;
          hasBezout ||= !!m.hasBezout;
        }
      }
      if (!totalVerts) return null;
      // Fixed-topology streaming reuse: refill the prior buffer in place when the total
      // vertex count is unchanged (every float is overwritten below, so no stale data).
      const verts = (prevVerts && prevVerts.length === totalVerts * _RVF)
        ? prevVerts : new Float32Array(totalVerts * _RVF);
      let o = 0;
      let ord9 = 0;   // painter ordinal → per-shape depth layer (rides the kind fraction)
      let written = 0;
      const vFirst = new Int32Array(bundle.numShapes | 0);
      const vCount = new Int32Array(bundle.numShapes | 0);
      for (const s of order) {
        const m = meshes[s];
        if (!m || !m.vertexCount || !m.verts) continue;
        const b = s * st;
        // An IMAGE shape's paint is the atlas sample TINTED by (1,1,1,opacity) — exactly what
        // the per-shape direct path passes. Baking the shape's fill colour (black for a plain
        // <image>) into aColor instead multiplies the image to black: "rendered solid".
        const iid9 = (st >= 44 && bundle.imageAtlasTex) ? Math.floor(meta[b + 35] + 0.5) : 0;
        const r = iid9 > 0 ? 1 : meta[b + 4];
        const g = iid9 > 0 ? 1 : meta[b + 5];
        const bl = iid9 > 0 ? 1 : meta[b + 6];
        const a = meta[b + 7];
        const src = m.verts;
        const nVert = Math.min(m.vertexCount | 0, (src.length / VF) | 0);
        if (nVert <= 0) continue;
        // Per-shape vertex span. Shapes are packed contiguously in painter order, so a sprite
        // subset (a contiguous SHAPE range) is a contiguous VERTEX range — which lets a sprite
        // draw slice this one VBO instead of declining the analytic route entirely.
        vFirst[s] = written; vCount[s] = nVert;
        const kf9 = Math.min(ord9++, 2047) / 8192;   // ≤2047: bit 11 = the shapes' blend flag
        for (let vi = 0; vi < nVert; vi++) {
          const si = vi * VF;
          verts.set(src.subarray(si, si + VF), o);
          verts[o + 5] = src[si + 5] + kf9;
          verts[o + 24] = r; verts[o + 25] = g; verts[o + 26] = bl; verts[o + 27] = a;
          verts[o + 28] = s;   // shape row: the VS reads overrides directly — NO per-vertex search
          o += _RVF;
        }
        written += nVert;
      }
      return { verts, count: written, vFirst, vCount, hasBezout };
    }

    // Compute (and cache) the bundle's painter-order shape iteration. Extracted so the
    // combined route and the split route derive the same order.
    function _ensureLbOrder(bundle, meshes) {
      const gen = bundle._geomGen | 0;
      let order = bundle._lbOrder;
      const cullG = bundle._cullGen | 0;
      const drawList = bundle.drawList;
      if (drawList && drawList.length) {
        if (!order || bundle._lbOrderGen !== gen || bundle._lbOrderCull !== cullG
            || bundle._lbOrderDrawList !== drawList || order.length !== drawList.length) {
          order = bundle._lbOrder = drawList.map(op => op.shapeIdx | 0);
          bundle._lbOrderGen = gen;
          bundle._lbOrderCull = cullG;
          bundle._lbOrderDrawList = drawList;
        }
      } else if (!order || bundle._lbOrderGen !== gen || bundle._lbOrderCull !== cullG
          || bundle._lbOrderDrawList !== drawList || order.length !== meshes.length) {
        order = bundle._lbOrder = meshes.map((_, i) => i);
        bundle._lbOrderGen = gen;
        bundle._lbOrderCull = cullG;
        bundle._lbOrderDrawList = drawList;
      }
      return order;
    }

    // Shape indices whose drawList op forces a per-shape Slug fallback (blend mode or
    // COLR graph). Cache against geometry and cull generations instead of
    // rebuilding the Set every frame.
    function _ensureSlugOps(bundle) {
      const gen = bundle._geomGen | 0, cullGen = bundle._cullGen | 0;
      let s = bundle._slugOps;
      if (!s || bundle._slugOpsGen !== gen || bundle._slugOpsCull !== cullGen
          || bundle._slugOpsDrawList !== bundle.drawList) {
        s = bundle._slugOps = new Set();
        const dl = bundle.drawList;
        if (dl) for (const op of dl) if (op.blendMode || op.colrGraphId) s.add(op.shapeIdx | 0);
        bundle._slugOpsGen = gen;
        bundle._slugOpsCull = cullGen;
        bundle._slugOpsDrawList = bundle.drawList;
      }
      return s;
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
      const order = _ensureLbOrder(bundle, meshes);
      // Sentinels can't ride the one-draw VBO. Defer them past the combined draw when
      // painter order allows (see _lbDeferrableSentinels); otherwise bail so _drawBundleLB
      // routes through the segmented split (batched runs + interleaved sentinels).
      bundle._lbDeferredSlug = null;
      if (bundle._lbHasSlug && !bundle._lbStream) {
        const deferred = _lbDeferrableSentinels(bundle, order, meshes);
        if (!deferred) return (bundle._lbCombined = null);
        bundle._lbDeferredSlug = deferred;
      }
      const _prevC = bundle._lbCombined;
      const packed = _packLbCombined(bundle, meshes, order, _prevC && _prevC.verts ? _prevC.verts : null);
      return (bundle._lbCombined = packed);
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
    // Per-shape paint for the BATCHED gradient/image route: 4 texels/shape,
    //   (0,row) = (gradientId, imageId, 0, 0)   (1,row) = shape em bbox (x0,y0,x1,y1)
    //   (2,row) = image rect (em)               (3,row) = atlas slot
    // The one-draw combined route paints solid colour from the aColor attribute — without
    // this texture a gradient shape would force the per-shape route (a draw + a uniform
    // set each).
    // Vertex-attribute locations are exhausted (loc 15 is taken; GL guarantees 16), so the
    // per-shape paint rides a TEXTURE indexed by the aShapeRow the route already carries.
    // Cached per _geomGen. Returns null when the bundle has no gradient shape.
    function _ensureLbPaintTex(bundle) {
      const gen = bundle._geomGen | 0;
      if (bundle._lbPaintGen === gen) return bundle._lbPaint;
      bundle._lbPaintGen = gen;
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (!meta || !st || n < 1) return (bundle._lbPaint = null);
      // Scan first — solid-only bundles skip the Float32Array alloc entirely.
      let any = false;
      for (let s = 0; s < n; s++) {
        const b = s * st;
        if (Math.floor(meta[b + 28] + 0.5) > 0) { any = true; break; }
        if (st >= 44 && bundle.imageAtlasTex && Math.floor(meta[b + 35] + 0.5) > 0) { any = true; break; }
      }
      if (!any) return (bundle._lbPaint = null);
      const data = new Float32Array(4 * n * 4);
      for (let s = 0; s < n; s++) {
        const b = s * st, gid = Math.floor(meta[b + 28] + 0.5);
        const iid = (st >= 44 && bundle.imageAtlasTex) ? Math.floor(meta[b + 35] + 0.5) : 0;
        const o = s * 16;
        data[o] = gid; data[o + 1] = iid;
        data[o + 4] = meta[b + 0]; data[o + 5] = meta[b + 1];
        data[o + 6] = meta[b + 2]; data[o + 7] = meta[b + 3];
        if (iid > 0) {
          // imgRect (texel 36..39) is identity for a shape without an explicit rect
          data[o + 8]  = st >= 40 ? meta[b + 36] : 0; data[o + 9]  = st >= 40 ? meta[b + 37] : 0;
          data[o + 10] = st >= 40 ? meta[b + 38] : 1; data[o + 11] = st >= 40 ? meta[b + 39] : 1;
          data[o + 12] = meta[b + 40]; data[o + 13] = meta[b + 41];
          data[o + 14] = meta[b + 42]; data[o + 15] = meta[b + 43];
        }
      }
      let tex = bundle._lbPaintTexGl;
      if (!tex) {
        tex = bundle._lbPaintTexGl = R.gl.createTexture();
        R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
      } else R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
      R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA32F, 4, n, 0, R.gl.RGBA, R.gl.FLOAT, data);
      R.gl.bindTexture(R.gl.TEXTURE_2D, null);
      return (bundle._lbPaint = { tex });
    }

    function _drawBundleLoopBlinn(bundle) {
      // Per-shape overrides (fill/tint/visibility, e.g. fog) bake into the
      // combined VBO colour. A GL override table (with a packedBuffer) is
      // applied; a stroke/transform-only or native table is ignored here.
      const ovr = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides : null;
      const combined = _ensureLbCombined(bundle, ovr);
      if (!combined) return false;
      R._lbRouteCount++;
      const nComb = _lbClampDrawCount(combined.count, _RVF,
        (combined.verts && combined.verts.byteLength) || 0);
      // SPRITE SUBSET: draw only that sprite's slice of the combined VBO. Shapes were packed in
      // ascending painter order, so the shapes of a contiguous shape range occupy a contiguous
      // vertex range — scan just the range (a sprite is a handful of shapes, NOT the bundle) and
      // sum. Shapes missing from the VBO have vCount 0 and simply contribute nothing.
      let firstV = 0, countV = nComb;
      const sr = R.draw.shapeRange;
      if (sr && combined.vCount) {
        const lo = sr[0] | 0, hi = Math.min(sr[1] | 0, combined.vCount.length - 1);
        let f = -1, tot = 0;
        for (let s = lo; s <= hi; s++) {
          const c = combined.vCount[s];
          if (!c) continue;
          if (f < 0) f = combined.vFirst[s];
          tot += c;
        }
        if (f < 0) return true;                       // nothing of this sprite is in the VBO
        firstV = f; countV = Math.min(tot, Math.max(0, nComb - f));
      }
      _drawLbCombinedSegment(bundle, combined, firstV, countV);
      // Loop/cusp sentinels, painted last via Slug. Order-safe by construction:
      // _lbDeferrableSentinels only returns a list when no LB shape painted after a
      // sentinel overlaps it.
      // Sentinels (loop/cusp shapes LB cannot mesh) are painted by Slug — unless the caller asked
      // for LB ONLY, in which case they are simply absent, which is the point of asking.
      const deferred = R._lbSlugFallback ? bundle._lbDeferredSlug : null;
      if (deferred) for (const s of deferred) R._renderShapeViaSlug(bundle, s);
      return true;
    }

    // Draw a contiguous vertex slice [firstV, firstV+countV) of the combined VBO with
    // the full combined-route GL state (depth-claim cascade, OVER blend, batched
    // paint + VS overrides). All state is (re)established each call, so it is safe to
    // interleave between Slug sentinel draws (the split route): every call re-clears
    // depth, making each run its own single-owner depth pass — exactly like the
    // per-shape direct path, but batching a whole run into one drawArrays.
    function _drawLbCombinedSegment(bundle, combined, firstV, countV) {
      const maxV = combined.count | 0;
      if (firstV < 0) firstV = 0;
      if (firstV + countV > maxV) countV = maxV - firstV;
      if (countV <= 0) return;
      const ovr = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides : null;
      const [cw, ch] = R.viewportSize();
      const bbox = bundle.globalBBox;
      const [sx, sy] = R.arScale(bbox, cw, ch);
      // PER-BUNDLE buffer + VAO: a single shared buffer with a one-slot "last
      // uploaded" cache degenerates to a full combined-VBO upload per bundle
      // per frame on multi-bundle scenes; per-bundle residency uploads once
      // per geometry change (and once across a split's runs — glR.uploaded holds).
      let glR = bundle._lbRouteGl;
      if (!glR) {
        glR = bundle._lbRouteGl = { vao: R.gl.createVertexArray(), buf: R.gl.createBuffer(), uploaded: null, cap: 0, bytes: 0 };
        R.gl.bindVertexArray(glR.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, glR.buf);
        _specRouteAttribs();
      } else {
        R.gl.bindVertexArray(glR.vao);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, glR.buf);
      }
      if (glR.uploaded !== combined) {
        // Always bufferData: SubData into a prior larger cap left glR.bytes as
        // capacity, and clamping to that capacity could allow a draw past the
        // bytes actually written for this combined mesh.
        R.gl.bufferData(R.gl.ARRAY_BUFFER, combined.verts, R.gl.STATIC_DRAW);
        glR.bytes = combined.verts.byteLength;
        glR.cap = combined.verts.length;
        glR.uploaded = combined;
      }
      R.bindFb(R.gl.FRAMEBUFFER, R._cacheTargetFbo || null);
      R.gl.viewport(0, 0, cw, ch);
      // DEPTH-CLAIM CASCADE: caps/pieces/interior z-tiers are single-owner —
      // each tier's depth rejects the tiers below wherever it claims (see
      // loopBlinn.vert + the kind-9/kind-10 claim rules in the frag).
      R.gl.enable(R.gl.DEPTH_TEST); R.gl.depthFunc(R.gl.LEQUAL); R.gl.depthMask(true);
      R.gl.clearDepth(1.0); R.gl.clear(R.gl.DEPTH_BUFFER_BIT);
      // LB owns its stencil state. It uses no stencil, but an ambient STENCIL_TEST
      // left enabled by another pass (Slug's clip/mask, a cache blit) tests LB's
      // fragments against a buffer LB never wrote — and rejects them. The Slug path
      // disables stencil per bundle, so an LB bundle only ever inherited a clean
      // state by luck; when it doesn't, the fill silently vanishes.
      R.gl.disable(R.gl.STENCIL_TEST); R.gl.disable(R.gl.CULL_FACE);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      const U = _lbSetFor(combined);
      R.gl.useProgram(U.prog);
      // VS-applied overrides: bind the shared override table + this bundle's starts
      // table (lazily built RGBA32F, width = drawn-shape count; texel = (firstVertex,
      // shapeRow, 0, 0)). The combined VBO itself never changes for colour animation.
      if (ovr && U.HasOvr && (ovr.uploadIfDirty(), ovr.texture)) {
        R.gl.activeTexture(R.gl.TEXTURE6);
        R.gl.bindTexture(R.gl.TEXTURE_2D, ovr.texture);
        R.gl.uniform1i(U.OvrTex, 6);
        R.gl.uniform1i(U.HasOvr, 1);
        R.gl.activeTexture(R.gl.TEXTURE0);
      } else if (U.HasOvr) {
        R.gl.uniform1i(U.HasOvr, 0);
      }
      R.gl.uniform4f(U.GBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.CanvasAR, sx, sy);
      R.gl.uniform2f(U.Viewport, cw, ch);
      R.gl.uniform1i(U.Direct, 1);
      R.gl.uniform1f(U.Alpha, R.draw.alpha);
      // BATCHED gradients: per-shape id + bbox from the paint texture (unit 5); the gradient
      // LUTs on units 1/2. Same textures and the same sampleGradient the per-shape path uses,
      // so the batched and per-shape paints cannot drift.
      const paint = (bundle.gradientTex || bundle.imageAtlasTex) ? _ensureLbPaintTex(bundle) : null;
      if (paint && U.HasPaint) {
        if (bundle.gradientTex) {
          R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, bundle.gradientTex);
          if (U.GradientTex) R.gl.uniform1i(U.GradientTex, 1);
          R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, bundle.gradientStopsTex);
          if (U.GradientStops) R.gl.uniform1i(U.GradientStops, 2);
        }
        if (bundle.imageAtlasTex) {
          R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, bundle.imageAtlasTex);
          if (U.ImageTex) R.gl.uniform1i(U.ImageTex, 3);
          if (U.ImageAtlasSize) R.gl.uniform2f(U.ImageAtlasSize, bundle.imageAtlasSize[0] || 1, bundle.imageAtlasSize[1] || 1);
        }
        R.gl.activeTexture(R.gl.TEXTURE5); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.tex);
        if (U.PaintTex) R.gl.uniform1i(U.PaintTex, 5);
        R.gl.uniform1i(U.HasPaint, 1);
        R.gl.activeTexture(R.gl.TEXTURE0);
      } else if (U.HasPaint) R.gl.uniform1i(U.HasPaint, 0);
      // The combined route is ALWAYS solid (per-vertex aColor). lbProg's uGradId/
      // uImageId are shared with the per-shape direct path (_drawLBShapeDirect),
      // which leaves them >0 after a gradient/image shape — so reset them here or
      // a solid bundle drawn after a gradient one (same frame) would sample a
      // stale gradient and render blank/wrong.
      if (U.GradId) R.gl.uniform1i(U.GradId, 0);
      if (U.ImageId) R.gl.uniform1i(U.ImageId, 0);
      R._setLbRecolor(true, U);   // apply this draw's channel-lerp/color-matrix in-shader (batched recolor)
      if (R.draw.worldM) { R.gl.uniformMatrix3fv(U.WorldM, false, R.draw.worldM); R.gl.uniform1i(U.HasWorldM, 1); }
      else R.gl.uniform1i(U.HasWorldM, 0);
      R.gl.drawArrays(R.gl.TRIANGLES, firstV, countV);
      // reset: lbProg is shared with the per-shape direct/composed paths, which never
      // set uLbHasOvr — a stale 1 there reads a disabled aShapeRow (0) + an unbound
      // override sampler and multiplies visibility to zero (the metaTex-rebind class).
      if (U.HasOvr) R.gl.uniform1i(U.HasOvr, 0);
      R.gl.bindVertexArray(null);
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;
    }

    // SPLIT route: the one-draw combined route BAILED (a sentinel overlaps a later
    // LB shape, so sentinels can't all be deferred to the end), but the run+sentinel
    // count is low enough that batching still beats a whole-bundle Slug render. Walk
    // painter order; draw each maximal run of consecutive LB shapes as ONE combined-VBO
    // segment, and each maximal run of consecutive sentinels as ONE Slug pass
    // (shapeRange batch). Painter order is preserved exactly; each LB run is its own
    // depth-cleared pass. Returns false if it can't build (caller falls to per-shape).
    function _drawBundleLBSplit(bundle) {
      const meshes = _lbReadyMeshes(bundle);
      if (!meshes) return false;
      const order = _ensureLbOrder(bundle, meshes);
      if (!order || !order.length) return false;
      const ovr = R.draw.overrides && R.draw.overrides.packedBuffer ? R.draw.overrides : null;
      // TRANSFORM overrides can't ride the static bake (the combined VBO); the caller's
      // fallbackCount gate already excluded them, but guard defensively.
      const ovP = ovr ? ovr.packedBuffer : null;
      if (ovP) for (const s of order) if (_ovHasXform(ovP, s)) return false;
      const gen = bundle._geomGen | 0;
      let sv = bundle._lbSplitVbo;
      if (!sv || sv.gen !== gen) {
        const packed = _packLbCombined(bundle, meshes, order, sv && sv.vbo ? sv.vbo.verts : null);
        if (!packed) return false;
        sv = bundle._lbSplitVbo = { gen, vbo: packed };
      }
      const combined = sv.vbo, vFirst = combined.vFirst, vCount = combined.vCount;
      const canSlug = R._lbSlugFallback;
      let drew = false;
      let runFirst = -1, runCount = 0;                 // accumulating LB-run vertex span
      const sentRun = [];                              // accumulating sentinel-run shape indices
      const flushRun = () => {
        if (runCount > 0) { _drawLbCombinedSegment(bundle, combined, runFirst, runCount); drew = true; }
        runFirst = -1; runCount = 0;
      };
      const flushSent = () => {
        if (!sentRun.length) return;
        if (canSlug) {
          let lo = sentRun[0], hi = sentRun[0];
          for (const s of sentRun) { if (s < lo) lo = s; if (s > hi) hi = s; }
          // A gap-free index block (span === count) holds EXACTLY this sentinel run — no LB
          // shape's index falls inside — so one shapeRange pass batches them all. Otherwise
          // the block would also pull in an LB shape (double-draw), so paint them one by one.
          if (hi - lo + 1 === sentRun.length) R._renderShapeViaSlug(bundle, lo, hi);
          else for (const s of sentRun) R._renderShapeViaSlug(bundle, s);
          drew = true;
        }
        sentRun.length = 0;
      };
      for (const s of order) {
        if ((vCount[s] | 0) > 0) {                     // LB shape: extend the current run, close any sentinel run
          flushSent();
          const f = vFirst[s] | 0, c = vCount[s] | 0;
          if (runFirst < 0) { runFirst = f; runCount = c; }
          else if (f === runFirst + runCount) runCount += c;   // contiguous in the VBO (guaranteed within a run)
          else { flushRun(); runFirst = f; runCount = c; }
        } else {                                       // sentinel: close any LB run, accumulate the sentinel block
          flushRun();
          sentRun.push(s);
        }
      }
      flushRun();
      flushSent();
      if (drew) R._lbRouteCount++;
      return drew;
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
      // LB owns its stencil state. It uses no stencil, but an ambient STENCIL_TEST
      // left enabled by another pass (Slug's clip/mask, a cache blit) tests LB's
      // fragments against a buffer LB never wrote — and rejects them. The Slug path
      // disables stencil per bundle, so an LB bundle only ever inherited a clean
      // state by luck; when it doesn't, the fill silently vanishes.
      R.gl.disable(R.gl.STENCIL_TEST); R.gl.disable(R.gl.CULL_FACE);
      R.gl.enable(R.gl.BLEND); R.gl.blendEquation(R.gl.FUNC_ADD); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      const U = _lbSetFor(packed);
      R.gl.useProgram(U.prog);
      R._setLbRecolor(false, U);   // per-shape direct never recolors (recolor rides the composed path) — clear stale state
      R.gl.uniform4f(U.GBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.CanvasAR, sx, sy);
      R.gl.uniform2f(U.Viewport, cw, ch);
      R.gl.uniform1i(U.Direct, 1);
      R.gl.uniform1f(U.Alpha, paint.alpha == null ? 1 : paint.alpha);
      // Solid paint via the constant aColor attribute (location 7).
      const c = paint.color || [0, 0, 0, 1];
      R.gl.disableVertexAttribArray(7); R.gl.vertexAttrib4f(7, c[0], c[1], c[2], c[3]);
      const gradId = (paint.gradId | 0) > 0 && paint.gradientTex ? (paint.gradId | 0) : 0;
      if (U.GradId) R.gl.uniform1i(U.GradId, gradId);
      if (gradId) {
        const sb = paint.shapeBBox || bbox;
        R.gl.uniform4f(U.ShapeBBox, sb[0], sb[1], sb[2], sb[3]);
        R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.gradientTex); R.gl.uniform1i(U.GradientTex, 1);
        R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.gradientStopsTex); R.gl.uniform1i(U.GradientStops, 2);
      }
      const imageId = (paint.imageId | 0) > 0 && paint.imageTex ? (paint.imageId | 0) : 0;
      if (U.ImageId) R.gl.uniform1i(U.ImageId, imageId);
      if (imageId) {
        R.gl.uniform4f(U.ImgRect, paint.imgRect[0], paint.imgRect[1], paint.imgRect[2], paint.imgRect[3]);
        R.gl.uniform4f(U.AtlasSlot, paint.atlasSlot[0], paint.atlasSlot[1], paint.atlasSlot[2], paint.atlasSlot[3]);
        R.gl.uniform2f(U.ImageAtlasSize, paint.atlasSize ? paint.atlasSize[0] : 1, paint.atlasSize ? paint.atlasSize[1] : 1);
        R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, paint.imageTex); R.gl.uniform1i(U.ImageTex, 3);
      }
      if (worldM) { R.gl.uniformMatrix3fv(U.WorldM, false, worldM); R.gl.uniform1i(U.HasWorldM, 1); }
      else R.gl.uniform1i(U.HasWorldM, 0);
      R.gl.activeTexture(R.gl.TEXTURE0);
      const nDraw = _lbClampDrawCount(packed.vertexCount, LB_VERT_FLOATS, packed.verts && packed.verts.byteLength);
      if (nDraw > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nDraw);
      R.gl.bindVertexArray(null);
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;
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
      const U = _lbSetFor(packed);
      R.gl.useProgram(U.prog);
      R.gl.uniform4f(U.GBB, bbox[0], bbox[1], bbox[2], bbox[3]);
      R.gl.uniform2f(U.CanvasAR, sx, sy);
      R.gl.uniform2f(U.Viewport, cw, ch);
      R.gl.uniform1i(U.Direct, 0);
      if (worldM) { R.gl.uniformMatrix3fv(U.WorldM, false, worldM); R.gl.uniform1i(U.HasWorldM, 1); }
      else R.gl.uniform1i(U.HasWorldM, 0);
      const nCov = _lbClampDrawCount(packed.vertexCount, LB_VERT_FLOATS, packed.verts && packed.verts.byteLength);
      if (nCov > 0) R.gl.drawArrays(R.gl.TRIANGLES, 0, nCov);
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
      //
      // 'only' mode (setLoopBlinnFill('only')) means SHOW ME WHAT LOOP-BLINN CAN DO: the shapes it
      // can serve, and nothing in their place for the ones it cannot. Without the _lbSlugFallback
      // term here, every shape LB declined was quietly drawn by Slug anyway, so the forced mode
      // rendered pixel-for-pixel what the unforced one did and answered nothing.
      const canSlug = R._lbSlugFallback && !bundle._lbStream && bundle.drawList && bundle.drawList.length > 0;
      // Shapes whose op carries a blend mode or a COLR paint graph → Slug per-shape
      // (Slug applies blend against the backdrop / runs the paint graph). Cached per
      // _geomGen (immutable drawList) — no per-frame Set rebuild. null when fallback off.
      const slugOps = canSlug ? _ensureSlugOps(bundle) : null;
      const forceSlug = (ovP || (slugOps && slugOps.size))
        ? (s) => (slugOps !== null && slugOps.has(s)) || (ovP && _ovHasXform(ovP, s))
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
      // Pure function of the immutable meta → cache per _geomGen. The
      // O(numShapes) sweep ran on EVERY drawBundle of every static
      // LB-routed bundle (hundreds of shapes × dozens of bundles × 60fps).
      let cls9 = bundle._lbClass;
      if (!cls9 || cls9.gen !== (bundle._geomGen | 0)) {
        cls9 = { gen: bundle._geomGen | 0, hasGrad: false, hasImage: false,
                 hasComposed: false, hasStroke: false,
                 hasTransSolid: false, hasTransGradImg: false };
        for (let s = 0; s < n; s++) {
          const b = s * st;
          const gId = Math.floor(meta[b + 28] + 0.5);
          const iId = st >= 36 ? Math.floor(meta[b + 35] + 0.5) : 0;
          if (gId) cls9.hasGrad = true;
          if (iId) cls9.hasImage = true;
          if (meta[b + 11] > 0 && meta[b + 12] > 0) cls9.hasStroke = true;          // visible stroke
          if (Math.floor(meta[b + 30] + 0.5) || Math.floor(meta[b + 31] + 0.5)      // clip / mask
              || (st >= 33 && Math.floor(meta[b + 32] + 0.5))) cls9.hasComposed = true; // inline filter
          const a = meta[b + 7];                                                    // fill alpha
          if (a > 0.004 && a < 0.996) { if (gId || iId) cls9.hasTransGradImg = true; else cls9.hasTransSolid = true; }
        }
        bundle._lbClass = cls9;
      }
      const hasGrad = cls9.hasGrad, hasImage = cls9.hasImage;
      const hasComposed = cls9.hasComposed, hasStroke = cls9.hasStroke;
      const hasTransSolid = cls9.hasTransSolid, hasTransGradImg = cls9.hasTransGradImg;
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
      const canSlug = R._lbSlugFallback && !bundle._lbStream && bundle.drawList && bundle.drawList.length > 0;
      let fallbackCount = 0;
      if (canSlug) {
        const slugOps = _ensureSlugOps(bundle);
        for (const op of bundle.drawList) {
          const s = op.shapeIdx | 0;
          if ((ovP && _ovHasXform(ovP, s)) || slugOps.has(s)) fallbackCount++;
        }
        // Per-shape fallback is a win only when the unservable shapes are a
        // minority; if they're the majority, one whole-bundle Slug render beats N
        // per-shape Slug renders (e.g. an all-COLR emoji run) → decline to Slug.
        if (fallbackCount * 2 > bundle.drawList.length) return false;
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
      // Gradients now BATCH: per-shape id + bbox ride the paint texture, so a bundle of many
      // DIFFERENT gradients still draws in ONE call. (Translucent gradient/image were already
      // rejected above; a palette/channel recolor with a gradient is rejected at `recolor`.)
      const gradOk = !hasGrad || !!bundle.gradientTex;
      const imgOk  = !hasImage || (!!bundle.imageAtlasTex && (bundle.metaFloatsPerShape | 0) >= 44);
      if (gradOk && imgOk && !combinedBlocked && !fallbackCount) {
        if (_drawBundleLoopBlinn(bundle)) return true;
        // COMBINED BAILED: the bundle has loop/cusp/arc/over-paint SENTINELS that
        // can't all be deferred past the one-draw batch (one is painted UNDER a later
        // LB shape). Two ways to finish it, and we ESTIMATE which is cheaper:
        //   • the SPLIT (_drawBundleLBSplit): one batched draw per CONTIGUOUS run of LB
        //     shapes + one Slug pass per CONTIGUOUS run of sentinels, in painter order —
        //     keeps LB's sub-visibly-better curve AA. Cost ≈ (LB runs + sentinel runs).
        //   • whole-bundle Slug: batches everything into ~one draw, visually equivalent.
        // The split wins only while its run count stays within a few draws of Slug's one;
        // past that the per-draw cost dominates (e.g. the tiger: ~50 runs ≫ 1) → Slug.
        if (canSlug) {
          const rm = _lbReadyMeshes(bundle);
          if (rm) {
            const ord = bundle._lbOrder || rm.map((_, i) => i);
            let runs = 0, sentRuns = 0, prevLb = false, prevSent = false;
            for (const si of ord) {
              const lb = !!(rm[si] && rm[si].vertexCount);
              if (lb) { if (!prevLb) runs++; prevSent = false; }
              else { if (!prevSent) sentRuns++; prevSent = true; }
              prevLb = lb;
            }
            // LB_BAIL_XOVER: the batched-Slug/per-draw-LB crossover (measured ~a
            // handful of draws — LB per-draw ≈ 30µs, Slug batches ~1 draw). Above it,
            // even the split can't beat one Slug render → whole-bundle Slug.
            if (runs + sentRuns > LB_BAIL_XOVER) return false;
            // Otherwise the split's few batched draws beat Slug AND keep LB's AA.
            if (_drawBundleLBSplit(bundle)) return true;
          }
        }
      }
      return _drawBundleLBStatic(bundle);
    }

  R.drawLoopBlinnMesh = drawLoopBlinnMesh;

  R._ensureFillLBCovProg = _ensureFillLBCovProg;
  R._ensureLbPairProg = _ensureLbPairProg;   // exposed for load-time program prewarm (fillWarmTick)

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
  // prepareBundle is the app's "I am about to draw this" hook, so it is also the right place
  // to kick off the FILL VARIANT link (non-blocking; see fillPass.prewarmFillVariant). The
  // driver links on its own threads while the app finishes loading, and the first draw finds
  // the program ready instead of paying a ~20ms synchronous link per bundle feature-set.
  R.prepareBundle = (bundle) => {
    if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
    if (R._lbSlugOnly) return false;
    try { return _ensureLbMeshes(bundle) !== null; } catch { return false; }
  };
  // Apply an off-thread build result: store the packed meshes so the next draw
  // upgrades this bundle from Slug to LB. `wire[s] === null` ⇒ that shape is Slug.
  // Discards a result whose generation no longer matches (bundle re-dirtied while
  // the worker ran) — a stale prefix must never render.
  // MEMORY-PROJECTED SLUG GATE: packed LB meshes measure ~120 bytes per curve
  // byte under kind-12 bands (conservative vs the old ~72 strip zoo). When the
  // projected total across live bundles would exceed the budget, the bundle
  // routes Slug instead — reference-exact from the curve buffer it already owns.
  // Hard vert caps (LB_MAX_VERTS_*) are a second line of defense after build.
  // Budget via R.setLoopBlinnMemoryBudget(bytes); default scales with deviceMemory.
  const LB_BYTES_PER_CURVE_BYTE = 120;
  R._lbMemUsed = 0;
  R._lbMemCap = (() => {
    try {
      // navigator.deviceMemory is the non-standard Device Memory API (absent from
      // TS's lib.dom); cast through any.
      const gb = (typeof navigator !== 'undefined' && /** @type {any} */ (navigator).deviceMemory) || 8;
      return gb <= 4 ? 96 * 1024 * 1024 : 192 * 1024 * 1024;
    } catch { return 192 * 1024 * 1024; }
  })();
  R.setLoopBlinnMemoryBudget = (bytes) => { R._lbMemCap = Math.max(0, bytes | 0); };
  /** Mesh-build policy for Loop-Blinn. Extensible opts object.
   *  `forceCdt`: skip the convex fast-mesh path; always CDT (or Slug if CDT fails). */
  R.setLoopBlinnMeshOpts = (opts = {}) => {
    if (opts && opts.forceCdt !== undefined) R._lbForceCdt = !!opts.forceCdt;
  };
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
    let bytes = 0, nV = 0;
    if (packed) for (const pk of packed) {
      if (!pk || pk.slug) continue;
      if (pk.verts) bytes += pk.verts.byteLength;
      nV += pk.vertexCount | 0;
    }
    // Post-build revoke: projection can under-estimate; if the real mesh blows
    // the budget, drop to Slug rather than uploading an oversized VBO.
    if (bytes > R._lbMemCap || nV > LB_MAX_VERTS_PER_BUNDLE) {
      if (typeof console !== 'undefined') {
        console.warn('[mantle] LB mesh budget: built ' + (bytes / 1048576).toFixed(1) + 'MB / '
          + nV + ' verts exceeds cap — rendering via Slug.');
      }
      R._lbMemUsed -= (bundle._lbMemBytes || 0);
      bundle._lbMemBytes = 0;
      bundle._lbMeshes = null;
      bundle._lbMeshesRaw = null;
      bundle._lbHasSlug = true;
      bundle._lbMemDenied = true;
      bundle._lbCombined = undefined;
      return false;
    }
    R._lbMemUsed += bytes - (bundle._lbMemBytes || 0);
    bundle._lbMemBytes = bytes;
    if (!bundle._lbMemReleased9) {
      bundle._lbMemReleased9 = true;
      const prevDispose = bundle.dispose;
      bundle.dispose = function () { R._lbMemUsed -= (bundle._lbMemBytes || 0); bundle._lbMemBytes = 0; return prevDispose.apply(this, arguments); };
    }
    return true;
  }
  R._lbMemAdmit = _lbMemAdmit;
  function _applyLbResult(bundle, res, reqGen) {
    if (bundle._disposed || (bundle._geomGen | 0) !== reqGen) return;
    const wire = res && res.packed;
    if (!wire || !wire.length || res.overBudget) {   // nothing analytic / over budget → whole-bundle Slug
      bundle._lbMeshes = null; bundle._lbMeshesRaw = null; bundle._lbGen = reqGen;
      bundle._lbHasSlug = true; bundle._lbCombined = undefined;
      if (res && res.overBudget) bundle._lbMemDenied = true;
      return;
    }
    const packed = new Array(wire.length);
    let hasReal = false;
    for (let s = 0; s < wire.length; s++) {
      const pk = wire[s];
      if (pk === null || (pk && pk.overBudget)) packed[s] = LB_SLUG;
      else { packed[s] = pk; hasReal = hasReal || !!(pk && (pk.vertexCount | 0) > 0); }
    }
    // Match the synchronous builder: an all-sentinel result has no analytic work.
    // Publishing it as ready only replays Slug through slower shape-range draws.
    if (!hasReal) {
      bundle._lbMeshes = null; bundle._lbMeshesRaw = null; bundle._lbGen = reqGen;
      bundle._lbHasSlug = true; bundle._lbCombined = undefined;
      return;
    }
    bundle._lbMeshesRaw = undefined;                 // worker returns no CPU raw (static → no refresh/resume)
    if (!_lbMemAccount(bundle, packed)) return;      // post-build revoke → already Slugged
    bundle._lbMeshes = packed;
    bundle._lbGen = reqGen;
    bundle._lbHasSlug = !!res.hasSlug || packed.some((p) => p && p.slug);
    bundle._lbCombined = undefined;                  // combined VBO rebuilds from the new packed set
    bundle._lbBuildS = 0; bundle._lbRawGen = reqGen;
  }
  // AUTO-BUILD: hand each newly-created bundle's Loop-Blinn triangulation to the
  // worker at load time. The heavy build runs OFF the main thread; the draw path
  // never builds (it uses ready LB, else Slug). Morph bundles still prepare on the
  // main thread (their build is a different, resumable path).
  try {
    R._lbBuilderFn = (b, force = false) => {
      try {
        if (!b || b._disposed) return true;
        // DECLINE, explicitly (false) — do not just return. Every renderer registers a builder, so
        // "I am Slug-only" must not be mistaken for "handled": another renderer may still want these
        // meshes, and the bundle is shared.
        if (R._lbSlugOnly) return false;             // Slug-only mode: don't build LB we'll never draw
        if (!b._geomGen && !b._morphSrc) {           // static bundle → off-thread whole-bundle build
          const reqGen = b._geomGen | 0;
          if (b._lbMeshes !== undefined && (b._lbGen | 0) === reqGen) return true;
          if (b._lbWorkerPendingGen === reqGen) return true;
          if (!force && R._lbFillMode === 'auto'
              && !(_lbAutoTypeOk(b) && _staticPerfOk(b))) return false;
          if (!_lbMemAdmit(b, 1)) { b._lbMeshes = null; b._lbGen = b._geomGen | 0; b._lbHasSlug = true; return; }
          b._lbWorkerPendingGen = reqGen;
          requestLbBuild(b, (res) => {
            if (b._lbWorkerPendingGen === reqGen) b._lbWorkerPendingGen = undefined;
            _applyLbResult(b, res, reqGen);
          });
        }
        if (b._morphSrc && !b._morphMeshesBuilt) {
          if (!_lbMemAdmit(b, 2)) { b._morphMeshesBuilt = true; b._morphMeshesPartial = null; return true; }   // pair VBOs are dual-stream (2×)
          enqueueLbPrepare(b);
        }
        return true;
      } catch { /* leave on Slug */ }
      return true;
    };
    setLbBuilder(R._lbBuilderFn);
    R._requestLbBuild = (b) => R._lbBuilderFn(b, R._lbFillMode === 'on');
    // Keep the idle-drain preparer registered as the no-builder fallback + the
    // morph prepare target (setLbBuilder above routes morph bundles here).
    R._lbPreparerFn = (b) => {
      try {
        if (b._morphSrc && !b._morphMeshesBuilt) { _ensureBundleMorphMeshes(b); return; }
        const gen9 = b._geomGen | 0;
        if (b._lbMeshes === undefined || b._lbGen !== gen9) _ensureLbMeshes(b, 2);
      } catch { /* draw-time fallback */ }
    };
    setLbPreparer(R._lbPreparerFn);
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
  R._lbForceCdt = false;      // setLoopBlinnMeshOpts({ forceCdt }) — skip convex fast mesh
  // Pin via renderer.setLoopBlinnFill('off'|'auto'|'on'|'only').
  // Does this bundle have a ready analytic mesh set (real LB, current generation)?
  // Used by the LB-only draw + static-cache "don't bake nothing" guards.
  R._lbBundleReady = (bundle) => !!bundle && bundle._lbMeshes != null && bundle._lbGen === (bundle._geomGen | 0);
  R._staticPerfOk = _staticPerfOk;
  R._lbAutoTypeOk = _lbAutoTypeOk;
  R._lbSizeOk = _lbSizeOk;
  R._lbRouteCount = 0;
  R._lbMorphRouteCount = 0;
  R._lbMorphComposedCount = 0;
}
