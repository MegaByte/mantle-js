// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { uploadBuffer } from './coopUpload.js';
import {
  deleteGlResource,
  deleteProgramWhenLinked,
  trackGlResource,
  createTrackedProgram,
} from './contextResources.js';
// instancedFill.js — instanced fill program, scratch buffer growth.

import { ROUTES, coverKernelOfVariantKey } from './engineLedger.js';
import { isWarmSuperset } from './sceneUnion.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachInstancedFill(R) {
  let _instProg = null,
    _instU = null,
    _instKey = '';
  function _instBindSamplers(U) {
    if (!U || U._samplersBound) return;
    R.gl.uniform1i(U.uCurveData, 0);
    R.gl.uniform1i(U.uBandData, 1);
    R.gl.uniform1i(U.uMetaTex, 2);
    R.gl.uniform1i(U.uDashTex, 3);
    R.gl.uniform1i(U.uGradientTex, 4);
    R.gl.uniform1i(U.uGradientStops, 5);
    R.gl.uniform1i(U.uImageTex, 6);
    R.gl.uniform1i(U.uSecondaryImageTex, 15);
    R.gl.uniform1i(U.uFilterTex, 7);
    R.gl.uniform1i(U.uOverrideTex, 8);
    R.gl.uniform1i(U.uMaskRTArray, 9);
    R.gl.uniform1i(U.uMaskRowToLayerTex, 10);
    R.gl.uniform1i(U.uPalette, 13);
    R.gl.uniform1i(U.uExtClipTex, 14);
    U._samplersBound = true;
  }
  const _instProgs = new Map(); // engineKey ('' Slug | 'MANTLE_AAC…') -> { prog, U }; _instProg/_instU point at the selected one
  let _instAttrBuf = null,
    _instAttrScratch = null,
    _instAttrCap = 0;
  // Compacted (header-free) cover-quad geometry for the instanced draw.
  // Keep an LRU rather than only the last handle: games commonly
  // alternate several instanced assets (cards, HUD pieces, hazards), and a
  // one-entry cache re-packed and re-uploaded both meshes every frame.
  // The cover-quad buffer interleaves a
  // 12-float chunk header between shapes' vertex runs, so a single
  // drawArraysInstanced over the raw buffer would rasterize the headers as
  // garbage triangles. Pack just the vertices (in shape order) + their
  // shapeIdx into dedicated buffers so ONE instanced draw covers the whole
  // bundle, with the instance as the OUTER loop (instance 0's full shape
  // list, then instance 1's, …) — matching the per-instance loop's painter
  // order. Depth is disabled: shapes are emitted in shapeIdx = z order, so
  // painter's order already matches the depth test — and depth can't be
  // reset between instances within one instanced draw.
  const _instCompacts = new Map();
  // The bound on idle meshes. A mesh drawn in this frame or the one before it is not evicted by the bound: a scene that draws more
  // instanced assets per frame than the bound (a forest of tree variants) would otherwise evict each mesh before its next draw and
  // re-pack and re-upload every one of them each frame. Such a working set holds its meshes while it is drawn and gives them back two
  // frames after it shrinks; the memory budget may free any mesh the current frame has not drawn (R._memEvictInstCompacts). A mesh's
  // `frame` is the last frame that drew it (-1 for one built outside any frame, by a warm or a frameless draw: the bound alone keeps it).
  const MAX_INST_COMPACTS = 8;
  const INST_FLOATS = 18; // 3 vec3 worldM columns + alpha + rgba tint + rgba bias
  const COVER_STRIDE_F = 12; // floats per cover-quad vertex
  const _nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  // (a disposed bundle's compact goes with it: the cache's strong key would hold the bundle and its GL buffers until eight newer instanced bundles pushed it out)
  function _onCompactBundleDisposed(bundle) {
    const compact = _instCompacts.get(bundle);
    if (compact) {
      _instCompacts.delete(bundle);
      _dropInstCompact(compact);
    }
  }
  function _retireInstCompact(bundle, compact) {
    _instCompacts.delete(bundle);
    _dropInstCompact(compact);
    if (bundle._disposeHooks) bundle._disposeHooks.delete(_onCompactBundleDisposed);
  }
  /// The first frame whose meshes the bound keeps: inside a frame and at its end, the previous frame's (a mesh it drew may still be
  /// drawn later in this one); between frames, the frame just drawn (the next frame's working set).
  const _keepFromFrame = () => (R._frameSerial | 0) - (R._frameOpen ? 1 : 0);
  /// Evict meshes drawn before `keepFrom`, least recently used first, until `room` more fit under the bound.
  function _trimInstCompacts(room, keepFrom) {
    if (_instCompacts.size + room <= MAX_INST_COMPACTS) return;
    for (const [bundle, compact] of _instCompacts) {
      if (_instCompacts.size + room <= MAX_INST_COMPACTS) break;
      if (compact.frame >= keepFrom) continue;
      _retireInstCompact(bundle, compact);
    }
  }
  function _dropInstCompact(compact) {
    if (!compact) return;
    if (compact.vao) deleteGlResource(R.gl, 'VertexArray', compact.vao);
    if (compact.vbo) deleteGlResource(R.gl, 'Buffer', compact.vbo);
    if (compact.shapeVbo) deleteGlResource(R.gl, 'Buffer', compact.shapeVbo);
  }

  function _createInstCompactVao(compact) {
    const vao = trackGlResource(R.gl, R.gl.createVertexArray());
    R.glBindVertexArray(vao);
    R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.vbo);
    const stride = COVER_STRIDE_F * 4;
    for (let i = 0; i < 7; i++) R.gl.enableVertexAttribArray(i);
    R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, stride, 0);
    R.gl.vertexAttribPointer(1, 2, R.gl.FLOAT, false, stride, 8);
    R.gl.vertexAttribPointer(2, 2, R.gl.FLOAT, false, stride, 16);
    R.gl.vertexAttribPointer(3, 2, R.gl.FLOAT, false, stride, 24);
    R.gl.vertexAttribPointer(4, 2, R.gl.FLOAT, false, stride, 32);
    R.gl.vertexAttribPointer(5, 1, R.gl.FLOAT, false, stride, 40);
    R.gl.vertexAttribPointer(6, 1, R.gl.FLOAT, false, stride, 44);
    for (let i = 0; i < 7; i++) R.gl.vertexAttribDivisor(i, 0);
    R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.shapeVbo);
    R.gl.enableVertexAttribArray(7);
    R.gl.vertexAttribPointer(7, 1, R.gl.FLOAT, false, 0, 0);
    R.gl.vertexAttribDivisor(7, 0);
    R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
    const instanceStride = INST_FLOATS * 4;
    R.gl.enableVertexAttribArray(8);
    R.gl.vertexAttribPointer(8, 3, R.gl.FLOAT, false, instanceStride, 0);
    R.gl.vertexAttribDivisor(8, 1);
    R.gl.enableVertexAttribArray(9);
    R.gl.vertexAttribPointer(9, 3, R.gl.FLOAT, false, instanceStride, 12);
    R.gl.vertexAttribDivisor(9, 1);
    R.gl.enableVertexAttribArray(10);
    R.gl.vertexAttribPointer(10, 3, R.gl.FLOAT, false, instanceStride, 24);
    R.gl.vertexAttribDivisor(10, 1);
    R.gl.enableVertexAttribArray(11);
    R.gl.vertexAttribPointer(11, 1, R.gl.FLOAT, false, instanceStride, 36);
    R.gl.vertexAttribDivisor(11, 1);
    R.gl.enableVertexAttribArray(12);
    R.gl.vertexAttribPointer(12, 4, R.gl.FLOAT, false, instanceStride, 40);
    R.gl.vertexAttribDivisor(12, 1);
    R.gl.enableVertexAttribArray(13);
    R.gl.vertexAttribPointer(13, 4, R.gl.FLOAT, false, instanceStride, 56);
    R.gl.vertexAttribDivisor(13, 1);
    R.glBindVertexArray(null);
    return vao;
  }

  function _instCompactFor(handle) {
    const bundle = handle.bundle;
    const geomGen = bundle._geomGen | 0;
    const cullGen = bundle._cullGen | 0;
    const invalidGen = bundle._instCompactInvalidGen | 0;
    let compact = _instCompacts.get(bundle);
    if (
      compact &&
      compact.geomGen === geomGen &&
      compact.cullGen === cullGen &&
      compact.invalidGen === invalidGen
    ) {
      _instCompacts.delete(bundle);
      _instCompacts.set(bundle, compact);
      if (R._frameOpen) compact.frame = R._frameSerial | 0;
      compact.t = _nowMs();
      return compact;
    }

    if (compact) {
      _instCompacts.delete(bundle);
      _dropInstCompact(compact);
    }
    const cqf = bundle.coverQuadFloats;
    const sidx = bundle.hybridShapeIdxFloats;
    // Build from the draw list so instancing honors shapes removed by the
    // occlusion cull instead of reintroducing hidden AA edges.
    const chunks = [];
    for (const op of bundle.drawList)
      if (op.kind === 'fillShape' && op.chunk) chunks.push(op.chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.count;
    const verts = new Float32Array(total * COVER_STRIDE_F);
    const shapes = new Float32Array(total);
    // Each chunk's shape row and its vertex run in the compacted buffer: a sprite subset (R.draw.shapeRange) draws only its runs.
    const opShape = new Int32Array(chunks.length),
      opStart = new Int32Array(chunks.length),
      opCount = new Int32Array(chunks.length);
    const rows = [];
    for (const op of bundle.drawList)
      if (op.kind === 'fillShape' && op.chunk) rows.push(op.shapeIdx | 0);
    let w = 0,
      ci = 0;
    for (const chunk of chunks) {
      opShape[ci] = rows[ci];
      opStart[ci] = w;
      opCount[ci] = chunk.count;
      ci++;
      const vStart = chunk.start * COVER_STRIDE_F;
      verts.set(cqf.subarray(vStart, vStart + chunk.count * COVER_STRIDE_F), w * COVER_STRIDE_F);
      if (sidx) for (let k = 0; k < chunk.count; k++) shapes[w + k] = sidx[chunk.start + k];
      w += chunk.count;
    }
    compact = {
      geomGen,
      cullGen,
      invalidGen,
      frame: R._frameOpen ? R._frameSerial | 0 : -1,
      t: _nowMs(),
      bytes: verts.byteLength + shapes.byteLength,
      count: total,
      opShape,
      opStart,
      opCount,
      vbo: trackGlResource(R.gl, R.gl.createBuffer(), 'fillStream'),
      shapeVbo: trackGlResource(R.gl, R.gl.createBuffer(), 'fillStream'),
      vao: null,
    };
    uploadBuffer(R.gl, compact.vbo, verts, R.gl.STATIC_DRAW); // (cooperative in the loading call: coopUpload.js)
    uploadBuffer(R.gl, compact.shapeVbo, shapes, R.gl.STATIC_DRAW);
    compact.vao = _createInstCompactVao(compact);
    _trimInstCompacts(1, _keepFromFrame());
    _instCompacts.set(bundle, compact);
    (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add(_onCompactBundleDisposed);
    return compact;
  }
  // Compile+cache the instanced program for a given ENGINE (extra frag defines: [] = Slug,
  // ['MANTLE_AAC'…] = AAC). Sets _instProg/_instU to the selected variant. The VERTEX shader is
  // always MANTLE_INSTANCED (same attrib layout across engines), so the VAO/attr buffer are shared.
  //
  // A program is made in two steps so the second can wait for the driver. _beginInstProg creates, compiles and
  // links without asking any question of the program; _finishInstProg validates the link and captures uniforms,
  // which is what blocks until the driver is done (LINK_STATUS, getUniformLocation). With
  // KHR_parallel_shader_compile the draw path finishes a program only after COMPLETION_STATUS_KHR reports it done.
  function _instKeyOf(extra) {
    return extra && extra.length ? extra.slice().sort().join('|') : '';
  }
  function _beginInstProg(key, extra) {
    const _ps0 = R._pendingShaders.length,
      _pp0 = R._pendingPrograms.length;
    // The vertex stage takes the same loop-blinn defines as the fragment. A pinned engine reaches the fragment
    // through fillDefines (it is how a harness arm forces a kernel), and MANTLE_LB_FILL makes the fragment READ
    // varyings (vLB0...) only the vertex stage emits under the same define; without it the link fails and the draw
    // silently falls back to the per-instance loop, so the pin is not honored. An instanced bundle carries no LB
    // geometry, so the extra vertex outputs read the unbound-attribute zeros and the fragment takes its cover path.
    // MORPH is left out: its attribute slots collide with the instanced ones, and a program is never both.
    const lbDefs = (R.opts.fillDefines || []).filter(
      (d) => /^MANTLE_LB_/.test(d) && d !== 'MANTLE_LB_MORPH',
    );
    const vs = R.compile(
      R.withDefines(R.shaderSources.fillVert, ['MANTLE_INSTANCED'].concat(lbDefs)),
      R.gl.VERTEX_SHADER,
    );
    // The FRAGMENT shader needs MANTLE_INSTANCED too. A per-instance TINT is
    // multiplicative, so the vertex shader can fold it into vOverrideTint, but a
    // per-instance BIAS (a fog's offset) cannot be folded into a multiply, so the
    // fragment shader has to read it — without the define its `in vec4 vInstBias`
    // compiles out and every fog silently renders as a plain tint.
    const fragDefs = (R.opts.fillDefines || []).concat(extra || [], ['MANTLE_INSTANCED']);
    const fs = R.compile(R.withDefines(R.shaderSources.fillFrag, fragDefs), R.gl.FRAGMENT_SHADER);
    const p = createTrackedProgram(R.gl);
    if (R._gpuLabel) R._gpuLabel(p, 'inst:' + key);
    R.gl.attachShader(p, vs);
    R.gl.attachShader(p, fs);
    R.gl.linkProgram(p);
    // The program keeps its attached shaders until it is deleted; their status is read only if the link fails.
    R._pendingShaders.length = _ps0;
    R._pendingPrograms.length = _pp0;
    deleteGlResource(R.gl, 'Shader', vs);
    deleteGlResource(R.gl, 'Shader', fs);
    const rec = {
      prog: p,
      U: null,
      fragKey: (R.opts.fillDefines || [])
        .concat(extra || [])
        .slice()
        .sort()
        .join('|'),
      fragDefs,
      pending: true,
    };
    _instProgs.set(key, rec);
    return rec;
  }
  function _instComplete(rec) {
    const khr = R._khrParallel;
    if (!khr) return true;
    // non-blocking mode: complete AND the GPU thread caught up (finishing it reads the program); otherwise the driver's own completion
    return R._nbNow()
      ? R._programReady(rec.prog)
      : !!R.gl.getProgramParameter(rec.prog, khr.COMPLETION_STATUS_KHR);
  }
  function _finishInstProg(key, rec) {
    const p = rec.prog;
    if (!R.gl.getProgramParameter(p, R.gl.LINK_STATUS)) {
      const logs = [R.gl.getProgramInfoLog(p)];
      for (const sh of (R.gl.getAttachedShaders && R.gl.getAttachedShaders(p)) || [])
        logs.push(R.gl.getShaderInfoLog(sh));
      R.mantleWarn(
        '[Mantle] instanced fill program failed to build; falling back to per-instance loop.',
        ...logs,
      );
      deleteGlResource(R.gl, 'Program', p);
      _instProgs.set(key, { prog: false, U: null });
      return false;
    }
    const U = {};
    for (const n of [
      'uCurveData',
      'uBandData',
      'uMetaTex',
      'uDashTex',
      'uGlobalBBox',
      'uStrokeGates',
      'uStrokeExactAa',
      'uShapeIdxOverride',
      'uNumShapes',
      'uCanvasAR',
      'uViewportSize',
      'uCoverAaReach',
      'uGradientTex',
      'uGradientStops',
      'uGradientCount',
      'uImageTex',
      'uSecondaryImageTex',
      'uSecondaryImageAtlasSize',
      'uImageAtlasSize',
      'uFilterTex',
      'uOverrideTex',
      'uHasOverrides',
      'uHasEmCoord',
      'uMaskRTArray',
      'uMaskRowToLayerTex',
      'uHasOffscreenMask',
      'uHasOccupancy',
      'uColorMatrix',
      'uColorMatrixOffset',
      'uColorMatrixEnabled',
      'uPalette',
      'uPaletteEnabled',
      'uPaletteChannel',
      'uPaletteSize',
      'uChannelLerpPrimary',
      'uChannelLerpContrast',
      'uChannelLerpHighlight',
      'uChannelLerpEnabled',
      'uExtClipTex',
      'uExtClipMode',
    ]) {
      U[n] = R.gl.getUniformLocation(p, n);
    }
    U.boxFilterReach = R._exactCoverDefines(rec.fragDefs);
    rec.U = U;
    rec.pending = false;
    rec.fragDefs = null;
    if (!_instAttrBuf) _instAttrBuf = trackGlResource(R.gl, R.gl.createBuffer(), 'fillStream');
    return true;
  }
  function _useInst(rec) {
    _instProg = rec.prog;
    _instU = rec.U;
    _instKey = rec.fragKey;
  }
  function _ensureInstProg(extra) {
    const key = _instKeyOf(extra);
    let rec = _instProgs.get(key);
    if (!rec) rec = _beginInstProg(key, extra);
    if (rec.prog === false) return false;
    if (rec.pending && !_finishInstProg(key, rec)) return false;
    _useInst(rec);
    return true;
  }
  /// Start a program's compile and link and ask nothing of it; the draw path finishes it once the driver reports
  /// it complete. Without the extension nothing could wait for it, so it is made now.
  function _beginInstProgAsync(extra) {
    if (!R._khrParallel) return _ensureInstProg(extra);
    const key = _instKeyOf(extra);
    if (!_instProgs.has(key)) _beginInstProg(key, extra);
    return true;
  }
  // Strict gate: only the genuinely simple fill case is instanced; anything
  // with clip / mask / filter / group / image / 9-slice falls back to the
  // correct per-instance loop.
  /// The program for one instanced draw. `baseDefs` are the kernel's (instancedEngineDefines)
  /// and the draw's rotated map; this adds the bundle's feature and recolor omissions (instancedOmitDefines) --
  /// what a fill variant compiles out -- once that program is built. Until then the draw takes the base program,
  /// as a fill draw takes the universal one, and asks for the build: it is made where a fill variant's pipeline
  /// warm is made, in frame slack or at the warm deadline (fillPass.js), never at a bundle's first draw. The build
  /// links the program at that tick; its pipeline is built by the draw that follows, in the same frame -- where a
  /// fill variant's one-pixel warm draw would have built it.
  ///
  /// The stand-in reads either layout. baseDefs carry the bundle's band layout (MANTLE_AAC_PAIR_BANDS)
  /// since Slug's kernel is the exact walk too; the program that draws until the full one is built leaves it out, as
  /// the universal fill program does -- a pair list walked as stripes is still exact, a straddling cell just walks
  /// twice -- so it stays the program ensureAuxQueue links ahead of the first draw, not a link at that draw.
  let _baseInstDrawn = false; // a base (unspecialized) instanced program has been selected to draw
  /// With KHR_parallel_shader_compile no draw waits for a link. The program the bundle wants (its lean one, or the base
  /// when it omits nothing) is started and polled by COMPLETION_STATUS_KHR; until it completes the draw declines, and
  /// the per-instance loop draws the frame with the ordinary fill program -- the same picture. A finished base program
  /// does not stand in: its pipeline is built by its first draw, which on a cold driver cache costs seconds, and the
  /// loop's programs are the ones loading has already warmed.
  (R._wmPrelinkers ||= {}).inst = (defs) => {
    const key = _instKeyOf(defs);
    if (!_instProgs.has(key)) _beginInstProg(key, defs);
  };
  function _selectInstProgramAsync(baseDefs, omit) {
    const wantDefs = omit.length && R.opts.psoWarm !== false ? baseDefs.concat(omit) : baseDefs;
    if (R._wmProgram) R._wmProgram('inst', wantDefs);
    const wantKey = _instKeyOf(wantDefs);
    let want = _instProgs.get(wantKey);
    if (!want && R._cover) {
      // A built program that leaves out less draws the same pixels (the cover set, fillPass.js): bind it, start nothing.
      for (const [k, rec] of _instProgs) {
        if (rec && rec.prog && !rec.pending && isWarmSuperset(k, wantKey)) {
          _useInst(rec);
          return true;
        }
      }
    }
    if (!want) {
      if (R._noteProgramMiss) R._noteProgramMiss('inst', wantKey);
      want = _beginInstProg(wantKey, wantDefs);
    }
    if (want.pending && _instComplete(want)) _finishInstProg(wantKey, want);
    want = _instProgs.get(wantKey);
    if (want.prog && !want.pending) {
      _useInst(want);
      return true;
    }
    return false;
  }
  /// Start the program an axis-aligned instanced draw of this bundle will want, when the bundle can be drawn instanced at all, so
  /// that it is usually complete by the time the first instanced draw asks for it (the draw never waits for it). Loading calls
  /// this for each bundle it prepares; a draw that wants a different program (a rotated instance) starts that one itself.
  function _beginInstancedForBundle(bundle) {
    if (R.opts.coverSet === true) return; // the loading call plans the scene's instanced programs as a cover set (R._instWantDefsFor)
    if (
      !R._khrParallel ||
      R.opts.variantFirst === false ||
      !R._instancedFastEnabled ||
      !bundle ||
      !_simpleInstanceableUncached(bundle, false)
    )
      return;
    const base = R._instancedEngineDefines ? R._instancedEngineDefines(bundle) : [];
    const omit = R._instancedOmitDefines ? R._instancedOmitDefines(bundle) : [];
    const defs = omit.length && R.opts.psoWarm !== false ? base.concat(omit) : base;
    const key = _instKeyOf(defs);
    if (!_instProgs.has(key)) _beginInstProg(key, defs);
  }
  /// The defines of the program an instanced draw of this bundle would want (rotated: with the rotated footprint), or null when it cannot be
  /// instanced. The cover-set planner (fillPass.js warmCover) collects these for every live bundle and starts the maximal ones only.
  R._instWantDefsFor = (bundle, rot) => {
    if (
      !R._khrParallel ||
      R.opts.variantFirst === false ||
      !R._instancedFastEnabled ||
      !bundle ||
      !_simpleInstanceableUncached(bundle, false)
    )
      return null;
    const base = (R._instancedEngineDefines ? R._instancedEngineDefines(bundle) : []).slice();
    if (rot) base.push('MANTLE_ROTATED_MAP');
    const omit = R._instancedOmitDefines ? R._instancedOmitDefines(bundle) : [];
    return omit.length && R.opts.psoWarm !== false ? base.concat(omit) : base;
  };
  R._instStart = (defs) => {
    const key = _instKeyOf(defs);
    if (!_instProgs.has(key)) _beginInstProg(key, defs);
  };
  function _selectInstProgram(bundle, baseDefs) {
    const omit = R._instancedOmitDefines ? R._instancedOmitDefines(bundle) : [];
    if (R._khrParallel && R.opts.variantFirst !== false)
      return _selectInstProgramAsync(baseDefs, omit);
    if (omit.length && R.opts.psoWarm !== false && R._noteWarmDemand) {
      const full = baseDefs.concat(omit);
      const key = full.slice().sort().join('|');
      const c = _instProgs.get(key);
      if (c && c.prog && c.ready) {
        _instProg = c.prog;
        _instU = c.U;
        _instKey = c.fragKey;
        return true;
      }
      // LEAN FIRST (opts.variantFirst): until a base instanced program has drawn, build and draw the bundle's own lean program. The
      // base is the whole shader; a cold driver cache can take many seconds to build its pipeline
      // where the lean program takes a fraction of one. Once the base has drawn anyway, the usual warm-in-slack path applies.
      if (R.opts.variantFirst !== false && !_baseInstDrawn && (!c || c.prog)) {
        if (_ensureInstProg(full)) {
          const e = _instProgs.get(key);
          e.ready = true;
          return true;
        }
      }
      if (!c) {
        R._noteWarmDemand(
          'inst:' + key,
          () => {
            if (_ensureInstProg(full)) _instProgs.get(key).ready = true;
          },
          () => _instProgs.has(key),
        );
      }
      _baseInstDrawn = true;
      return _ensureInstProg(baseDefs.filter((d) => d !== 'MANTLE_AAC_PAIR_BANDS'));
    }
    _baseInstDrawn = true;
    return _ensureInstProg(baseDefs);
  }
  function _simpleInstanceable(bundle, handle) {
    if (!bundle || !handle) return false;
    // Pure function of bundle geometry/cull generations + the handle's
    // mask regions — cached (the O(numShapes) meta walk ran per instanced
    // call per frame). A cull can remove the only unsupported op and make
    // the remaining draw list eligible for the compact draw.
    const gen9 = bundle._geomGen | 0;
    const cullGen9 = bundle._cullGen | 0;
    const hasMask9 = !!(handle.maskRegions && handle.maskRegions.length);
    const c9 = bundle._instSimpleCache;
    if (c9 && c9.gen === gen9 && c9.cullGen === cullGen9 && c9.hasMask === hasMask9) return c9.ok;
    const ok9 = _simpleInstanceableUncached(bundle, hasMask9);
    bundle._instSimpleCache = { gen: gen9, cullGen: cullGen9, hasMask: hasMask9, ok: ok9 };
    return ok9;
  }
  function _simpleInstanceableUncached(bundle, hasMask) {
    if (bundle._nineSliceActive) return false;
    if (hasMask) return false;
    if (bundle.filterGraphs && bundle.filterGraphs.length) return false;
    const dl = bundle.drawList;
    if (!dl || !dl.length) return false;
    for (const op of dl) {
      if (op.kind !== 'fillShape') return false;
      if (op.filterGraphId || op.filterId || op.colrGraphId || op.blendMode) return false;
    }
    if (!bundle.coverQuadChunks || !bundle.coverQuadChunks.length) return false;
    // No per-shape clip / mask / image (those need the offscreen / in-shader
    // routes the simple instanced pass doesn't bind).
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      n = bundle.numShapes | 0;
    for (let s = 0; s < n; s++) {
      const b = s * st;
      if (Math.floor(meta[b + 30] + 0.5) !== 0) return false; // clipId
      if (Math.floor(meta[b + 31] + 0.5) !== 0) return false; // maskId
      if (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false; // imageId
    }
    return true;
  }
  /// `packedColor` (optional, 8 floats per instance): the derived tint+bias
  /// when a diagonal color matrix was folded in. It stays in drawDispatch's
  /// reusable scratch buffer so caller-owned instance objects remain untouched.
  function _drawBundleInstancedFast(bundle, instances, packedColor) {
    if (R._wmNoteInst) R._wmNoteInst(bundle, instances);
    const ms = bundle._morphSrc;
    if (ms) {
      const resume = ms.skipUploads || ms.skipCurveUploads;
      ms.skipUploads = false;
      ms.skipCurveUploads = false;
      if (resume && typeof ms.relerp === 'function') ms.relerp();
    }
    const n = instances.length;
    R._instFastCount = (R._instFastCount | 0) + 1; // debugStats.instancedFastCount
    // Upload per-instance worldMatrix (col-major mat3) + alpha + rgba tint.
    if (n > _instAttrCap) {
      _instAttrCap = Math.max(n, _instAttrCap ? _instAttrCap * 2 : 64);
      _instAttrScratch = new Float32Array(_instAttrCap * INST_FLOATS);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
      R.gl.bufferData(R.gl.ARRAY_BUFFER, _instAttrCap * INST_FLOATS * 4, R.gl.DYNAMIC_DRAW);
    }
    const S = _instAttrScratch;
    for (let i = 0; i < n; i++) {
      const inst = instances[i] || {};
      const wm = inst.worldMatrix;
      const o = i * INST_FLOATS;
      if (wm) {
        for (let k = 0; k < 9; k++) S[o + k] = wm[k];
      } else {
        S[o] = 1;
        S[o + 1] = 0;
        S[o + 2] = 0;
        S[o + 3] = 0;
        S[o + 4] = 1;
        S[o + 5] = 0;
        S[o + 6] = 0;
        S[o + 7] = 0;
        S[o + 8] = 1;
      }
      S[o + 9] = typeof inst.alpha === 'number' ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
      // Multiplicative tint. A DIAGONAL per-instance color matrix is exactly a tint, so
      // it lands here too — see _isDiagCm in drawDispatch.
      const pc = packedColor ? i * 8 : -1;
      const tn = inst.tint;
      if (pc >= 0) {
        S[o + 10] = packedColor[pc];
        S[o + 11] = packedColor[pc + 1];
        S[o + 12] = packedColor[pc + 2];
        S[o + 13] = packedColor[pc + 3];
      } else if (tn) {
        S[o + 10] = tn[0];
        S[o + 11] = tn[1];
        S[o + 12] = tn[2];
        S[o + 13] = tn.length > 3 && tn[3] != null ? tn[3] : 1.0;
      } else {
        S[o + 10] = 1;
        S[o + 11] = 1;
        S[o + 12] = 1;
        S[o + 13] = 1;
      }
      // Additive bias — what a fog needs and a tint cannot express.
      if (pc >= 0) {
        S[o + 14] = packedColor[pc + 4];
        S[o + 15] = packedColor[pc + 5];
        S[o + 16] = packedColor[pc + 6];
        S[o + 17] = packedColor[pc + 7];
      } else {
        S[o + 14] = 0;
        S[o + 15] = 0;
        S[o + 16] = 0;
        S[o + 17] = 0;
      }
    }
    R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
    R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, S.subarray(0, n * INST_FLOATS));

    const [cw, ch] = R.viewportSize();
    R.glViewport(0, 0, cw, ch);
    // This path never reads depth or stencil. beginFrame has already cleared
    // them for an accumulated frame, and the normal fill path clears them
    // before it needs either resource. Avoid a full-target resource clear
    // for every simple instanced batch.
    R.glDisable(R.gl.STENCIL_TEST);
    // ...and no color clear: it belongs to the frame (renderer.js renderEntry, the frame-entry contract).

    const compact = _instCompactFor(R._handle);

    R.glBindVertexArray(compact.vao);

    // Bind program + state (trimmed beginFillPass for the simple bundle).
    const b = R._handle.bundle,
      U = _instU;
    R.glUseProgram(_instProg);
    if (U.uStrokeGates) R.gl.uniform1i(U.uStrokeGates, R.strokeGates === false ? 0 : 1);
    if (U.uStrokeExactAa) R.gl.uniform1i(U.uStrokeExactAa, R.strokeExactAa === false ? 0 : 1);
    // Fast instancing bypasses beginFillPass; its covers need the same box support.
    R.gl.uniform1i(
      U.uCoverAaReach,
      R.coverAaReach === true || (R.coverAaReach === undefined && U.boxFilterReach) ? 1 : 0,
    );
    R.glEnable(R.gl.BLEND);
    R.glBlendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
    // Depth OFF: shapes are emitted in shapeIdx order = z order = draw order,
    // so painter's order already matches what the depth test would do — and
    // depth can't be reset between instances within one instanced draw the
    // way the per-instance loop does.
    R.glDisable(R.gl.DEPTH_TEST);
    R.glDepthMask(false);
    _instBindSamplers(U);
    R.gl.activeTexture(R.gl.TEXTURE0);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.curveTex);
    R.gl.activeTexture(R.gl.TEXTURE1);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.bandTex);
    R.gl.activeTexture(R.gl.TEXTURE2);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.metaTex);
    R.gl.activeTexture(R.gl.TEXTURE3);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.dashTex || R.dummyDashTex);
    R.gl.activeTexture(R.gl.TEXTURE4);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientTex || R.dummyGradientTex);
    R.gl.activeTexture(R.gl.TEXTURE5);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientStopsTex || R.dummyGradientStops);
    R.gl.uniform1i(U.uGradientCount, b.gradientCount);
    R.gl.activeTexture(R.gl.TEXTURE6);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.imageAtlasTex || R.dummyGradientStops);
    R.gl.uniform2f(U.uImageAtlasSize, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
    if (U.uSecondaryImageTex !== null) {
      R.gl.activeTexture(R.gl.TEXTURE15);
      R.gl.bindTexture(R.gl.TEXTURE_2D, b.secondaryImageAtlasTex || R.dummyGradientStops);
      R.gl.uniform2f(
        U.uSecondaryImageAtlasSize,
        b.secondaryImageAtlasSize?.[0] || 1,
        b.secondaryImageAtlasSize?.[1] || 1,
      );
    }
    R.gl.activeTexture(R.gl.TEXTURE7);
    R.gl.bindTexture(R.gl.TEXTURE_2D, b.filterTex || R.dummyGradientTex);
    R.gl.uniform4f(
      U.uGlobalBBox,
      b.globalBBox[0],
      b.globalBBox[1],
      b.globalBBox[2],
      b.globalBBox[3],
    );
    R.gl.uniform1f(U.uNumShapes, Math.max(1, b.numShapes));
    R.gl.uniform1i(U.uShapeIdxOverride, -1);
    R.gl.uniform1i(U.uHasEmCoord, 0);
    R.gl.uniform1i(U.uHasOccupancy, b.hasOccupancy ? 1 : 0);
    // Mask off (simple bundle has none) — bind dummies the sampler needs.
    R.gl.activeTexture(R.gl.TEXTURE9);
    R.gl.bindTexture(R.gl.TEXTURE_2D_ARRAY, R.maskRTDummy());
    R.gl.activeTexture(R.gl.TEXTURE10);
    R.gl.bindTexture(R.gl.TEXTURE_2D, R.maskRowToLayerDummy());
    R.gl.uniform1i(U.uHasOffscreenMask, 0);
    // Shared override table (applies to every instance).
    R.gl.activeTexture(R.gl.TEXTURE8);
    if (R.draw.overrides && R.draw.overrides.uploadIfDirty) {
      R.draw.overrides.uploadIfDirty();
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.overrides.texture);
      R.gl.uniform1i(U.uHasOverrides, 1);
    } else {
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientTex);
      R.gl.uniform1i(U.uHasOverrides, 0);
    }
    // Shared recolor state.
    if (R.draw.channelLerp) {
      const cl = R.draw.channelLerp;
      const pp = cl.primary || [0, 0, 0, 1],
        cc = cl.contrast || [0, 0, 0, 1],
        hh = cl.highlight || [1, 1, 1, 1];
      R.gl.uniform4f(U.uChannelLerpPrimary, pp[0], pp[1], pp[2], pp[3] == null ? 1 : pp[3]);
      R.gl.uniform4f(U.uChannelLerpContrast, cc[0], cc[1], cc[2], cc[3] == null ? 1 : cc[3]);
      R.gl.uniform4f(U.uChannelLerpHighlight, hh[0], hh[1], hh[2], hh[3] == null ? 1 : hh[3]);
      R.gl.uniform1i(U.uChannelLerpEnabled, 1);
    } else {
      R.gl.uniform1i(U.uChannelLerpEnabled, 0);
    }
    if (R.draw.colorMatrix || R.draw.colorMatrixOffset) {
      R.gl.uniformMatrix4fv(U.uColorMatrix, false, R.draw.colorMatrix || R.IDENTITY_COLOR_MATRIX);
      R.gl.uniform4fv(U.uColorMatrixOffset, R.draw.colorMatrixOffset || R.ZERO_OFFSET);
      R.gl.uniform1i(U.uColorMatrixEnabled, 1);
    } else {
      R.gl.uniform1i(U.uColorMatrixEnabled, 0);
    }
    R.gl.activeTexture(R.gl.TEXTURE13);
    if (R.draw.palette && R.draw.palette.texture) {
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.palette.texture);
      R.gl.uniform1i(U.uPaletteEnabled, 1);
      R.gl.uniform1i(U.uPaletteChannel, R.draw.paletteChannel | 0);
      R.gl.uniform1i(U.uPaletteSize, Math.max(1, R.draw.palette.size | 0));
    } else {
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops);
      R.gl.uniform1i(U.uPaletteEnabled, 0);
    }
    R.gl.activeTexture(R.gl.TEXTURE14);
    if (R.draw.extClipTex && R.draw.extClipMode > 0) {
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.extClipTex);
      R.gl.uniform1i(U.uExtClipMode, R.draw.extClipMode | 0);
    } else {
      R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops);
      R.gl.uniform1i(U.uExtClipMode, 0);
    }
    const [sx, sy] = R.arScale(b.globalBBox, cw, ch);
    R.gl.uniform2f(U.uCanvasAR, sx, sy);
    R.gl.uniform2f(U.uViewportSize, cw, ch);

    // ONE instanced draw over the whole compacted range. Instance is the
    // outer loop (inst 0's full shape list, then inst 1's, …) → identical
    // painter order to the per-instance render() loop.
    const sr = R.draw.shapeRange;
    if (!sr) R.gl.drawArraysInstanced(R.gl.TRIANGLES, 0, compact.count, n);
    else {
      // A sprite subset: only the runs of the compacted buffer whose shape row is in the range (adjacent chunks merge into one run).
      let from = -1,
        to = 0;
      for (let k = 0; k < compact.opShape.length; k++) {
        const inside = compact.opShape[k] >= sr[0] && compact.opShape[k] <= sr[1];
        if (inside && from < 0) from = compact.opStart[k];
        if (inside) to = compact.opStart[k] + compact.opCount[k];
        if (from >= 0 && (!inside || k === compact.opShape.length - 1)) {
          R.gl.drawArraysInstanced(R.gl.TRIANGLES, from, to - from, n);
          from = -1;
        }
      }
    }

    if (R._engines && !R._psoWarming)
      R._engines.drew(coverKernelOfVariantKey(_instKey, b.numFillShapes === 0), ROUTES.INSTANCED);
    R.glBindVertexArray(null);
    R._handle.fillPassAssetDirty = true;
    R._forgetFillUnits(); // next non-instanced pass rebinds.
    return n;
  }
  // In the per-instance draw loop, a bundle whose render depends on a SHARED
  // bake — multi-shape mask regions, a filter graph, or any per-shape
  // clip/mask/filter/COLR/blend — is cheaper on Slug: the bake runs ONCE and
  // every instance reuses it (the instancing win), whereas the analytic
  // composed path evaluates the mask/filter INLINE per instance (N times). So
  // those bundles stay on Slug; simple solid/gradient/image bundles (no shared
  // bake) may route the analytic fill. (Simple fill-only bundles never reach
  // the loop at all — they take the drawArraysInstanced fast path above.)
  function _instancedPrefersSlug(bundle, handle) {
    if (!bundle) return false;
    // This gate runs before the per-instance fallback loop. Cache its
    // O(drawList + numShapes) inspection; culling swaps drawList without a
    // geometry mutation, so its generation is part of the key.
    const gen = bundle._geomGen | 0;
    const cullGen = bundle._cullGen | 0;
    const hasMask = !!(handle && handle.maskRegions && handle.maskRegions.length);
    const cached = bundle._instSlugPrefersCache;
    if (cached && cached.gen === gen && cached.cullGen === cullGen && cached.hasMask === hasMask)
      return cached.ok;
    if (hasMask) {
      bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
      return true;
    }
    if (bundle.filterGraphs && bundle.filterGraphs.some((g) => g)) {
      bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
      return true;
    }
    const dl = bundle.drawList;
    if (dl)
      for (const op of dl) {
        if (op.filterGraphId || op.filterId || op.colrGraphId || op.blendMode) {
          bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
          return true;
        }
      }
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      n = bundle.numShapes | 0;
    if (meta)
      for (let s = 0; s < n; s++) {
        const b = s * st;
        if (Math.floor(meta[b + 30] + 0.5) !== 0 || Math.floor(meta[b + 31] + 0.5) !== 0) {
          bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
          return true;
        }
      }
    bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: false };
    return false;
  }
  R._ensureInstProg = _ensureInstProg;
  R._beginInstancedFill = _beginInstProgAsync;
  R._beginInstancedForBundle = _beginInstancedForBundle;
  /// Finish every instanced program whose link was started (the explicit loading call).
  R._finishInstancedPrograms = (soft) => {
    let pending = 0;
    for (const [key, rec] of [..._instProgs]) {
      if (!rec || !rec.pending) continue;
      if (soft && R._khrParallel && !R._programReady(rec.prog)) {
        pending++;
        continue;
      }
      _finishInstProg(key, rec);
    }
    return pending;
  };
  R._selectInstProgram = _selectInstProgram;
  R._disposeInstProgs = () => {
    for (const v of _instProgs.values()) if (v && v.prog) deleteProgramWhenLinked(R.gl, v.prog);
    _instProgs.clear();
    _instProg = null;
    _instU = null;
  };
  /// The endFrame safe point: meshes beyond the bound that neither this frame nor the previous one drew go.
  R._instCompactTrim = () => _trimInstCompacts(0, (R._frameSerial | 0) - 1);
  /// The memory budget's evictor: drop meshes the current frame has not drawn, least recently used first. Returns the bytes freed.
  R._memEvictInstCompacts = (need, inUse) => {
    let freed = 0;
    for (const [bundle, compact] of [..._instCompacts]) {
      if (freed >= need) break;
      if (inUse(compact.frame, compact.t)) continue;
      freed += compact.bytes;
      _retireInstCompact(bundle, compact);
    }
    return freed;
  };
  R._disposeInstCompacts = () => {
    for (const [bundle, compact] of _instCompacts) {
      _dropInstCompact(compact);
      if (bundle._disposeHooks) bundle._disposeHooks.delete(_onCompactBundleDisposed);
    }
    _instCompacts.clear();
  };
  R._simpleInstanceable = _simpleInstanceable;
  R._instancedPrefersSlug = _instancedPrefersSlug;
  R._drawBundleInstancedFast = _drawBundleInstancedFast;
  Object.defineProperty(R, '_instProg', { get: () => _instProg });
  Object.defineProperty(R, '_instAttrBuf', { get: () => _instAttrBuf });
}
