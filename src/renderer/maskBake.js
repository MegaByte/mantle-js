// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  deleteGlResource,
  deleteProgramWhenLinked,
  trackGlResource,
  createTrackedProgram,
} from './contextResources.js';
import { overrideRowKey } from '../core/overrideRevision.js';
// Bakes mask coverage and group-composited pattern color into per-handle arrays.
// Owns the cache slots, texture lifetimes, dependency passes and bake programs.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMaskBake(R) {
  const { gl, viewportSize, arScale, bindFb, dummyDashTex, dummyGradientTex, dummyGradientStops } =
    R;

  const uniformNames = {
    hasWorld: 'uMaskHasWorld',
    resourceRow: 'uResourcePatternRow',
    hasPatterns: 'uHasPatternGroups',
    world: 'uMaskWorld',
    fullColor: 'uMaskFullColor',
    curve: 'uCurveData',
    band: 'uBandData',
    meta: 'uMetaTex',
    dash: 'uDashTex',
    grad: 'uGradientTex',
    gStops: 'uGradientStops',
    image: 'uImageTex',
    secondaryImage: 'uSecondaryImageTex',
    secondaryAtlasS: 'uSecondaryImageAtlasSize',
    atlasS: 'uImageAtlasSize',
    filter: 'uFilterTex',
    gCount: 'uGradientCount',
    gBB: 'uGlobalBBox',
    emBBox: 'uMaskEmBBox',
    canvasAR: 'uCanvasAR',
    row: 'uMaskChildRow1Based',
    isLum: 'uMaskIsLuminance',
    maskRTArrayPong: 'uMaskRTArrayPong',
    maskRowToLayerTexBake: 'uMaskRowToLayerTexBake',
    viewportSize: 'uViewportSize',
    overrideTex: 'uOverrideTex',
    hasOverrides: 'uHasOverrides',
    ownRow: 'uMaskOwnRow',
    strokeGates: 'uStrokeGates',
  };
  const uniformCache = new Map();
  function bakeUniforms(program) {
    let uniforms = uniformCache.get(program);
    if (!uniforms) {
      uniforms = {};
      for (const [key, name] of Object.entries(uniformNames))
        uniforms[key] = program ? gl.getUniformLocation(program, name) : null;
      uniformCache.set(program, uniforms);
    }
    return uniforms;
  }
  let activeBakeProgram = R.maskBakeProg;
  let bakeU = bakeUniforms(activeBakeProgram);
  const identityWorld = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const cbUOutputChannel = R.cacheBlitProg
    ? gl.getUniformLocation(R.cacheBlitProg, 'uOutputChannel')
    : null;
  // Resource children share the bundle's conservative type mask. Unknown metadata keeps every kernel.
  const typedBakePrograms = new Map(); // key -> program, or { pending: program } while the driver links it
  function startBakeProgram(key, rotated, types) {
    const defs = rotated ? ['MANTLE_ROTATED_MAP'] : [];
    /** @type {Array<[number, string]>} */
    const typeDefines = [
      [1, 'MANTLE_NO_LINE'],
      [2, 'MANTLE_NO_QUAD'],
      [4, 'MANTLE_NO_CUBIC'],
      [8, 'MANTLE_NO_ARC'],
    ];
    for (const [bit, name] of typeDefines) if (!(types & bit)) defs.push(name);
    const shadersAt = R._pendingShaders.length,
      programsAt = R._pendingPrograms.length;
    const vs = R.compile(R.withDefines(R.shaderSources.maskBakeVert, defs), gl.VERTEX_SHADER);
    const fs = R.compile(R.withDefines(R.shaderSources.maskBakeFrag, defs), gl.FRAGMENT_SHADER);
    const candidate = createTrackedProgram(gl);
    if (R._gpuLabel) R._gpuLabel(candidate, 'bake:' + key);
    gl.attachShader(candidate, vs);
    gl.attachShader(candidate, fs);
    gl.linkProgram(candidate);
    R._pendingShaders.length = shadersAt;
    R._pendingPrograms.length = programsAt;
    deleteGlResource(gl, 'Shader', vs);
    deleteGlResource(gl, 'Shader', fs);
    const rec = { pending: candidate };
    typedBakePrograms.set(key, rec);
    return rec;
  }
  (R._wmPrelinkers ||= {}).bake = ([rotated, types]) => {
    if (!rotated && types === 15) return; // the base bake program, linked at creation
    const key = (rotated ? 'rot:' : 'axis:') + types;
    if (!typedBakePrograms.has(key)) startBakeProgram(key, !!rotated, types);
  };
  /// MAY this BAKE DRAW now? The bundle's own lean program (typed or rotated) is what it bakes with; while that one is still linking the general
  /// program stands in -- and the general program's first draw is a pipeline build of seconds on a cold cache (a very large shader), a frozen
  /// compositor for the length, against a fraction of that for the lean one. So a bake whose lean program is not ready defers (the mask keeps its last bake, or none) unless the
  /// general program has been drawn once already; the warm retries, and the first draw after the lean program is ready bakes with it.
  function bakeProgramOk(rotated, bundle) {
    if (!R._khrParallel || R._forceLinks || !R._nbNow()) return true;
    const types =
      R._bakeForce || R.opts?.typeOmit === false ? 15 : (bundle.segTypeMask | 0) & 15 || 15;
    let candidate = R.maskBakeProg;
    if (rotated || types !== 15) {
      const key = (rotated ? 'rot:' : 'axis:') + types;
      let entry = typedBakePrograms.get(key);
      if (!entry) {
        if (R._noteProgramMiss) R._noteProgramMiss('bake', key);
        entry = startBakeProgram(key, rotated, types);
      }
      if (entry.pending) {
        if (R._programReady(entry.pending)) candidate = entry.pending;
        else if (R._strictPlay && R._strictPlay()) {
          // STAND-IN-FREE: no program draws in place of the exact one. A warm comes back for it; a bake in play waits for its link, like a fill (one counted stall).
          if (R.opts.standIns === false) {
            if (R._psoWarming) return false;
            R._needBlocked = (R._needBlocked | 0) + 1;
            if (!gl.getProgramParameter(entry.pending, gl.LINK_STATUS)) {
              deleteGlResource(gl, 'Program', entry.pending);
              typedBakePrograms.delete(key);
              throw new Error('Unable to compile resource coverage');
            }
            typedBakePrograms.set(key, entry.pending);
            return true;
          }
          // STRICT PLAY with stand-ins: the net is the all-types program of the same footprint, built in loading: the general one for an axis-aligned bake, the
          // rotated all-types one for a rotated bake. No net built = the bake defers (counted; the harness fails the run).
          const net = rotated ? typedBakePrograms.get('rot:15') : R.maskBakeProg;
          if (net && !net.pending && (rotated ? R._bakeRot15Drawn : R._bakeBaseDrawn)) {
            candidate = net;
            R._bakeNetDraws = (R._bakeNetDraws | 0) + 1;
          } else return false;
        } else if (R._bakeBaseDrawn) candidate = R.maskBakeProg;
        else return false;
      } else candidate = entry;
    }
    // The general program's uniform locations were asked at creation; any other program's are asked once, with the GPU thread clear.
    return uniformCache.has(candidate) || R._gpuClear();
  }
  function selectBakeProgram(rotated, bundle) {
    const types =
      R._bakeForce || R.opts?.typeOmit === false ? 15 : (bundle.segTypeMask | 0) & 15 || 15;
    if (R._wmProgram) R._wmProgram('bake', [!!rotated, types]);
    // The rotated twin of the program this bundle bakes with starts linking at the first bake, in the background. A rotated bake needs the
    // rotated footprint, which only that program has, and the first one asked for in play would be a link the main thread waits on.
    if (
      R._khrParallel &&
      R.opts?.fillTwins !== false &&
      !(R._wmVariantList && R._wmVariantList().length) &&
      !typedBakePrograms.has('rot:' + types)
    )
      startBakeProgram('rot:' + types, true, types); // (a manifest names the bakes the app runs: a rotated bake program it does not name is seconds of cold compile nobody asked for)
    let program = R.maskBakeProg;
    if (rotated || types !== 15) {
      const key = (rotated ? 'rot:' : 'axis:') + types;
      let entry = typedBakePrograms.get(key);
      if (!entry) {
        if (R._noteProgramMiss) R._noteProgramMiss('bake', key);
        entry = startBakeProgram(key, rotated, types);
      }
      if (entry.pending) {
        const khr = R._khrParallel;
        // An axis-aligned program only leaves out segment types the bundle has none of, so the general program draws the
        // same bake until the driver finishes it. A rotated map exists only in the rotated program, which must be waited for.
        // (Not ready is complete AND the GPU thread caught up, gpuGate.js. A rotated bake has no other program to draw with: it takes the general
        // one for these frames, whose footprint is the axis-aligned one -- no draw waits for a link -- and says so in debugStats.maskBakeStandIns.)
        if (khr && R._nbNow() && !R._forceLinks && !R._programReady(entry.pending)) {
          entry = null;
          if (rotated) {
            const net = R._strictPlay && R._strictPlay() ? typedBakePrograms.get('rot:15') : null;
            if (net && !net.pending) entry = net;
            else R._maskBakeStandIns = (R._maskBakeStandIns | 0) + 1;
          }
        } else if (
          khr &&
          !R._nbNow() &&
          !rotated &&
          !gl.getProgramParameter(entry.pending, khr.COMPLETION_STATUS_KHR)
        )
          entry = null;
        else {
          const candidate = entry.pending;
          if (!gl.getProgramParameter(candidate, gl.LINK_STATUS)) {
            deleteGlResource(gl, 'Program', candidate);
            throw new Error('Unable to compile resource coverage');
          }
          typedBakePrograms.set(key, candidate);
          entry = candidate;
        }
      }
      if (entry) program = entry;
    }
    if (program === activeBakeProgram) return;
    bakeU = bakeUniforms(program);
    activeBakeProgram = program;
  }

  // Mask RT texture-arrays ("ping" = write target), ONE PER MASKED HANDLE, and one shared FBO the
  // bake attaches a layer of the current handle's array to.
  //
  // PER HANDLE, because one shared array would make two masked handles re-bake each other every
  // frame: a validity check that remembers a single handle, drawing A then B then A ..., bakes both
  // every frame, and the full-canvas child draws priced as per-BAKE become per-FRAME work.
  // A slot carries its array and the stamp it was baked at; the least recently drawn handle
  // is evicted past MASK_SLOT_MAX slots or MASK_SLOT_BYTES of layers, so a scene with many masked
  // handles degrades to re-baking rather than growing without bound.
  const MASK_SLOT_MAX = 16;
  const MASK_SLOT_BYTES = 64 * 1024 * 1024;
  const _maskSlots = new Map(); // handle -> slot, least recently drawn first
  let _maskSlot = null; // the slot the current draw bakes into and samples
  let _maskSlotBytes = 0;
  let _maskBakeFbo = null;
  const _slotBytes = (s) => s.size[0] * s.size[1] * s.size[2] * (s.channels || 1); // R8: one byte a texel
  // A filter FRAME (renderer/filterFrame.js) is a second coordinate system for the same handle: its layers are baked at the frame's
  // size and world matrix. They get a slot of their own, keyed by a token held on the handle, so entering and leaving a frame swaps
  // between two valid slots instead of re-baking the one slot twice per draw. A frame that changes (a different margin or scale)
  // re-bakes its slot through the ordinary validity check (canvas size, world matrix), exactly as a resized canvas does.
  function selectMaskSlot(handle, framed = false) {
    const key = framed ? (handle._maskFrameKey ||= { frameSlotOf: handle }) : handle;
    let s = _maskSlots.get(key);
    if (s) {
      _maskSlots.delete(key);
      _maskSlots.set(key, s);
    } else {
      s = { arr: null, size: [0, 0, 0], validGen: -1, validCanvas: [0, 0], validShapeGen: -1 };
      _maskSlots.set(key, s);
      _evictMaskSlots(s);
    }
    _maskSlot = s;
    return s;
  }
  function _evictMaskSlots(keep) {
    for (const [h, s] of _maskSlots) {
      if (_maskSlots.size <= MASK_SLOT_MAX && _maskSlotBytes <= MASK_SLOT_BYTES) break;
      if (s === keep) continue;
      if (s.arr) {
        deleteGlResource(gl, 'Texture', s.arr);
        _maskSlotBytes -= _slotBytes(s);
      }
      _maskSlots.delete(h);
    }
  }
  // Nested-mask depth-1 "pong" array: a frozen copy of the ping array after
  // Pass 1. Lazy-alloc'd only when at least one region has hasInnerMask=true.
  let _maskRTArrayPong = null;
  const _maskRTSizePong = [0, 0, 0];
  let _maskBakeCopyFbo = null;
  const maskBakeVao = trackGlResource(gl, gl.createVertexArray());
  const maskBakeBuf = trackGlResource(gl, gl.createBuffer(), 'core');
  R.glBindVertexArray(maskBakeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, maskBakeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  R.glBindVertexArray(null);

  // What every mask child's override row says, across all regions, as one number. The bake applies each child's override transform (animated <mask>), so the mask-bake
  // cache must re-bake when a mask child's row changes, and two override tables with the same rows are one bake (the filter cache keys the same way, overrideRowKey). 0 when no
  // row moves anything: no table bound (static masks), or a table of identity rows for these children.
  function _maskFeedShapeGen() {
    const ov = R.draw.overrides;
    if (!ov || !R._handle) return 0;
    const regions = R._handle.maskRegions;
    let a = 2166136261,
      b = 0x9e3779b9,
      any = false;
    const mix = (row) => {
      const k = overrideRowKey(ov, row);
      if (k !== 0) any = true;
      a = Math.imul(a ^ (k >>> 0), 16777619);
      b = Math.imul(b ^ ((k / 4294967296) >>> 0), 0x5bd1e995);
    };
    for (let r = 0; r < regions.length; r++) {
      const reg = regions[r];
      if (reg.kind === 'pattern') mix(reg.patternRow);
      for (let row = reg.firstChild; row <= reg.lastChild; row++) mix(row);
    }
    return any ? (a >>> 0) * 2097152 + (b >>> 11) : 0;
  }

  function ensureMaskRTArray(depth, channels = 1) {
    const [cw, ch] = viewportSize();
    if (depth <= 0) return;
    const s = _maskSlot || selectMaskSlot(R._handle);
    if (
      s.arr &&
      s.size[0] === cw &&
      s.size[1] === ch &&
      s.size[2] >= depth &&
      (s.channels || 1) === channels
    )
      return;
    if (s.arr) {
      deleteGlResource(gl, 'Texture', s.arr);
      _maskSlotBytes -= _slotBytes(s);
    }
    if (!_maskBakeFbo) _maskBakeFbo = trackGlResource(gl, gl.createFramebuffer());
    s.arr = trackGlResource(gl, gl.createTexture(), 'mask');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, s.arr);
    // R8 is enough — bake writes vec4(a,a,a,a) but only .r is sampled
    // (single-channel mask RT). Saves 4× the memory.
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      channels === 4 ? gl.RGBA8 : gl.R8,
      cw,
      ch,
      depth,
      0,
      channels === 4 ? gl.RGBA : gl.RED,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    s.size[0] = cw;
    s.size[1] = ch;
    s.size[2] = depth;
    s.channels = channels;
    _maskSlotBytes += _slotBytes(s);
    _evictMaskSlots(s);
  }

  let pongChannels = 1;
  function ensureMaskRTArrayPong(depth, channels = 1) {
    const [cw, ch] = viewportSize();
    if (depth <= 0) return;
    if (
      _maskRTArrayPong &&
      _maskRTSizePong[0] === cw &&
      _maskRTSizePong[1] === ch &&
      _maskRTSizePong[2] >= depth &&
      pongChannels === channels
    )
      return;
    if (_maskRTArrayPong) deleteGlResource(gl, 'Texture', _maskRTArrayPong);
    if (_maskBakeCopyFbo) deleteGlResource(gl, 'Framebuffer', _maskBakeCopyFbo);
    _maskRTArrayPong = trackGlResource(gl, gl.createTexture(), 'mask');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArrayPong);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      channels === 4 ? gl.RGBA8 : gl.R8,
      cw,
      ch,
      depth,
      0,
      channels === 4 ? gl.RGBA : gl.RED,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    _maskBakeCopyFbo = trackGlResource(gl, gl.createFramebuffer());
    pongChannels = channels;
    _maskRTSizePong[0] = cw;
    _maskRTSizePong[1] = ch;
    _maskRTSizePong[2] = depth;
  }

  // Dummy 1×1×1 R8 array, bound to TEXTURE9 when uHasOffscreenMask=0
  // so the sampler unit stays in a valid state (WebGL2 requires
  // declared samplers to have a binding even when never sampled).
  let _maskRTDummy = null;
  function maskRTDummy() {
    if (_maskRTDummy) return _maskRTDummy;
    _maskRTDummy = trackGlResource(gl, gl.createTexture(), 'core');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTDummy);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.R8,
      1,
      1,
      1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0]),
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return _maskRTDummy;
  }
  // Companion dummy 1×1 R32I texture for the rowToLayer sampler unit.
  let _maskRowToLayerDummy = null;
  function maskRowToLayerDummy() {
    if (_maskRowToLayerDummy) return _maskRowToLayerDummy;
    _maskRowToLayerDummy = trackGlResource(gl, gl.createTexture(), 'core');
    gl.bindTexture(gl.TEXTURE_2D, _maskRowToLayerDummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 1, 1, 0, gl.RED_INTEGER, gl.INT, new Int32Array([-1]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return _maskRowToLayerDummy;
  }

  // Bake all regions of the current bundle into its handle's slot's layers.
  // Called once per render() (before processing the drawList) when the
  // bundle has any FLAG_MASK_BEGIN regions and R.maskBakeProg is available.
  function bakeMaskRegions() {
    if (!R.maskBakeProg || !R._handle || !R._handle.bundle || !R._handle.maskRegions.length) return;
    const regions = R._handle.maskRegions;
    const channels = R._handle.hasPatternGroups ? 4 : 1;
    ensureMaskRTArray(regions.length, channels);
    const b = R._handle.bundle;
    const [cw, ch] = viewportSize();
    const [sx, sy] = arScale(b.globalBBox, cw, ch);

    // Detect whether the ping-pong second pass is needed: any region
    // whose children carry an inner-mask reference. Most bundles have
    // none → single pass, no Pong alloc, no extra blit.
    let anyInnerMask = false;
    for (let r = 0; r < regions.length; r++) {
      if (regions[r].hasInnerMask) {
        anyInnerMask = true;
        break;
      }
    }
    if (anyInnerMask) ensureMaskRTArrayPong(regions.length, channels);

    let rotated = regions.some((reg) => reg.kind === 'pattern');
    const world = R.draw.worldM;
    if (world && (world[1] !== 0 || world[3] !== 0)) rotated = true;
    const override = R.draw.overrides && R.draw.overrides.packedBuffer;
    if (!rotated && override) {
      for (const reg of regions)
        for (let row = reg.firstChild; row <= reg.lastChild; row++)
          if (override[row * 24 + 1] !== 0 || override[row * 24 + 2] !== 0) rotated = true;
    }
    R._bakeJustDeferred = false;
    if (!bakeProgramOk(rotated, b)) {
      R._bakeJustDeferred = true;
      R._maskBakeDeferred = (R._maskBakeDeferred | 0) + 1;
      return;
    }
    selectBakeProgram(rotated, b);
    if (activeBakeProgram === R.maskBakeProg) R._bakeBaseDrawn = true;
    else if (rotated && activeBakeProgram === typedBakePrograms.get('rot:15'))
      R._bakeRot15Drawn = true;
    R.glUseProgram(activeBakeProgram);
    if (bakeU.world) gl.uniformMatrix3fv(bakeU.world, false, world || identityWorld);
    if (bakeU.hasWorld) gl.uniform1i(bakeU.hasWorld, world ? 1 : 0);
    // Bind the bake program's bundle textures (same set as mantle.frag).
    R._forgetFillUnits();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.curveTex);
    gl.uniform1i(bakeU.curve, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.bandTex);
    gl.uniform1i(bakeU.band, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, b.metaTex);
    gl.uniform1i(bakeU.meta, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, b.dashTex || dummyDashTex);
    gl.uniform1i(bakeU.dash, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, b.gradientTex || dummyGradientTex);
    gl.uniform1i(bakeU.grad, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, b.gradientStopsTex || dummyGradientStops);
    gl.uniform1i(bakeU.gStops, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, b.imageAtlasTex || dummyGradientStops);
    gl.uniform1i(bakeU.image, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, b.filterTex || dummyGradientTex);
    gl.uniform1i(bakeU.filter, 7);
    gl.uniform2f(bakeU.atlasS, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, b.secondaryImageAtlasTex || dummyGradientStops);
    gl.uniform1i(bakeU.secondaryImage, 15);
    gl.uniform2f(
      bakeU.secondaryAtlasS,
      b.secondaryImageAtlasSize?.[0] || 1,
      b.secondaryImageAtlasSize?.[1] || 1,
    );
    gl.uniform1i(bakeU.gCount, b.gradientCount | 0);
    gl.uniform4f(bakeU.gBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
    gl.uniform2f(bakeU.canvasAR, sx, sy);
    // The stroke walker's skip gates (hull and far rejects, and the saturation early-out a stroke child
    // asks for), set as every fill pass sets them. Left unset, the uniform would read 0 and a bake
    // would walk every segment. They change no pixel (strokeGatesExactSmoke), and
    // renderer.setStrokeGates(false) turns them off here too.
    if (bakeU.strokeGates) gl.uniform1i(bakeU.strokeGates, R.strokeGates === false ? 0 : 1);

    // Nested-mask sample bindings. Pass 1 always binds the dummy
    // (regions in pass 1 don't read any prior bake). Pass 2 swaps in
    // the pong array. The row→layer lookup is the same texture in
    // both passes (matches the visible-shape binding).
    if (bakeU.maskRTArrayPong) {
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskRTDummy());
      gl.uniform1i(bakeU.maskRTArrayPong, 11);
    }
    if (bakeU.maskRowToLayerTexBake) {
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, R._handle.maskRowToLayerTex || maskRowToLayerDummy());
      gl.uniform1i(bakeU.maskRowToLayerTexBake, 12);
    }
    if (bakeU.viewportSize) gl.uniform2f(bakeU.viewportSize, cw, ch);

    if (bakeU.overrideTex) {
      const ov = R.draw.overrides;
      gl.activeTexture(gl.TEXTURE8);
      if (ov && ov.uploadIfDirty && ov.texture) {
        ov.uploadIfDirty();
        gl.bindTexture(gl.TEXTURE_2D, ov.texture);
        gl.uniform1i(bakeU.overrideTex, 8);
        if (bakeU.hasOverrides) gl.uniform1i(bakeU.hasOverrides, 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, dummyGradientTex);
        gl.uniform1i(bakeU.overrideTex, 8);
        if (bakeU.hasOverrides) gl.uniform1i(bakeU.hasOverrides, 0);
      }
    }

    bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
    R.glViewport(0, 0, cw, ch);
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glEnable(gl.BLEND);
    // SOURCE-OVER, premultiplied: each child writes its premultiplied luminance (or alpha) in R and its
    // alpha in A, and the fixed-function blend composites them in document order -- the mask image CSS Masking
    // defines, whose luminance is the mask. One/One, a sum, would be wrong: overlapping children would add up, and a
    // dark child over a light one would add nothing instead of covering it. The target may be R8; the blend reads the SOURCE alpha,
    // which the shader writes whatever the attachment holds.
    R.glBlendEquation(gl.FUNC_ADD);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    R.glBindVertexArray(maskBakeVao);

    if (regions.some((reg) => reg.hasGroups)) {
      const levels = resourceBakeLevels(regions, b);
      for (let level = 0; level < levels.length; level++) {
        if (level > 0) {
          ensureMaskRTArrayPong(regions.length, channels);
          copyPingToPong(regions.length);
          gl.activeTexture(gl.TEXTURE11);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArrayPong);
          bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
          R.glViewport(0, 0, cw, ch);
          R.glUseProgram(activeBakeProgram);
          R.glEnable(gl.BLEND);
          R.glBlendEquation(gl.FUNC_ADD);
          R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          R.glBindVertexArray(maskBakeVao);
        }
        for (const task of levels[level]) bakeOneRegion(regions[task], task);
      }
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskRTDummy());
      R.glBindVertexArray(null);
      bindFb(gl.FRAMEBUFFER, null);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return;
    }

    // -- Pass 1: regions without inner-mask refs --
    // These regions can bake straight into the ping array; their
    // children sample at most the dummy (no-op), so no feedback.
    for (let r = 0; r < regions.length; r++) {
      const reg = regions[r];
      if (reg.hasInnerMask) continue;
      bakeOneRegion(reg, r);
    }

    // -- Pass 2: regions with inner-mask refs --
    // Snapshot ping → pong so Pass 2 can sample the Pass 1 results
    // without forming a read-write loop. Then bake the remaining
    // regions; the shader's inner-mask sample reads from pong on
    // sampler unit 11 while writing to ping via the FBO attachment.
    if (anyInnerMask) {
      copyPingToPong(regions.length);
      // Swap pong onto the bake's inner-mask sampler.
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArrayPong);
      gl.uniform1i(bakeU.maskRTArrayPong, 11);
      // Re-bind the bake FBO (the copy switched it to the copy FBO).
      bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
      R.glViewport(0, 0, cw, ch);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // source-over, as Pass 1
      R.glBindVertexArray(maskBakeVao);
      for (let r = 0; r < regions.length; r++) {
        const reg = regions[r];
        if (!reg.hasInnerMask) continue;
        bakeOneRegion(reg, r);
      }
      // Restore dummy on inner-mask sampler so a subsequent frame's
      // Pass 1 doesn't accidentally read stale pong content.
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskRTDummy());
    }

    R.glBindVertexArray(null);
    bindFb(gl.FRAMEBUFFER, null);
    // Restore src-over for downstream passes.
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  function resourceBakeLevels(regions, bundle) {
    const h = R._handle;
    if (h.resourceBakeLevels) return h.resourceBakeLevels;
    const masks = new Map(),
      patterns = new Map();
    regions.forEach((reg, i) => {
      if (reg.kind === 'pattern') patterns.set(reg.patternRow, i);
      else masks.set(reg.maskRow, i);
    });
    const meta = bundle.metaFloats,
      stride = bundle.metaFloatsPerShape;
    const states = new Uint8Array(regions.length),
      depths = new Int32Array(regions.length),
      levels = [];
    const visit = (i) => {
      if (states[i] === 2) return depths[i];
      if (states[i] === 1) return -1;
      states[i] = 1;
      const reg = regions[i];
      let depth = 0;
      for (let row = reg.firstChild; row <= reg.lastChild; row++) {
        const o = row * stride,
          inner = Math.round(meta[o + 31]);
        const dependencies = [];
        if (inner > 0 && inner !== reg.maskRow && masks.has(inner))
          dependencies.push(masks.get(inner));
        if (Math.round(meta[o + 43]) === 2 && patterns.has(row))
          dependencies.push(patterns.get(row));
        for (const dependency of dependencies) {
          const childDepth = visit(dependency);
          if (childDepth < 0) {
            states[i] = 2;
            depths[i] = -1;
            return -1;
          }
          depth = Math.max(depth, childDepth + 1);
        }
      }
      states[i] = 2;
      depths[i] = depth;
      (levels[depth] || (levels[depth] = [])).push(i);
      return depth;
    };
    for (let i = 0; i < regions.length; i++) visit(i);
    h.resourceBakeLevels = levels;
    return levels;
  }

  // Inline helper used by both passes. Reads bake-program uniforms
  // already bound in bakeMaskRegions().
  function bakeOneRegion(reg, layerIdx) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskSlot.arr, 0, layerIdx);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(bakeU.emBBox, reg.emBBox[0], reg.emBBox[1], reg.emBBox[2], reg.emBBox[3]);
    gl.uniform1i(bakeU.isLum, reg.isLuminance | 0);
    if (bakeU.resourceRow)
      gl.uniform1i(bakeU.resourceRow, reg.kind === 'pattern' ? reg.patternRow + 1 : 0);
    if (bakeU.hasPatterns) gl.uniform1i(bakeU.hasPatterns, R._handle.hasPatternGroups ? 1 : 0);
    if (bakeU.ownRow) gl.uniform1i(bakeU.ownRow, reg.maskRow | 0);
    const b = R._handle.bundle,
      meta = b.metaFloats,
      stride = b.metaFloatsPerShape;
    let grouped = reg.kind === 'pattern';
    for (let row = reg.firstChild; row <= reg.lastChild; row++)
      if ((Math.round(meta[row * stride + 27]) & (64 | 128)) !== 0 || meta[row * stride + 33] > 0) {
        grouped = true;
        break;
      }
    if (grouped) {
      bakeGroupedRegion(reg, layerIdx, b, meta, stride);
      return;
    }
    if (bakeU.fullColor) gl.uniform1i(bakeU.fullColor, 0);
    // Walk every child row, including the FLAG_MASK_BEGIN row itself
    // (it carries the first child shape's geometry — its bbox bracket
    // doesn't preclude it being a renderable shape too).
    if (reg.kind === 'effectClip') R.glBlendEquation(gl.MAX);
    for (let row = reg.firstChild; row <= reg.lastChild; row++) {
      gl.uniform1i(bakeU.row, row + 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (reg.kind === 'effectClip') R.glBlendEquation(gl.FUNC_ADD);
  }

  function bakeGroupedRegion(reg, layerIdx, b, meta, stride) {
    const [cw, ch] = viewportSize();
    const target = R._acquireShapeRT(cw, ch, 'mask-group-root:');
    bindFb(gl.FRAMEBUFFER, target.fbo);
    R.glViewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const resume = () => {
      R.glUseProgram(activeBakeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.curveTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, b.bandTex);
      R.glBindVertexArray(maskBakeVao);
      R.glViewport(0, 0, cw, ch);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (bakeU.fullColor) gl.uniform1i(bakeU.fullColor, 1);
    };
    R._withGroupTarget(target.fbo, () => {
      resume();
      for (let row = reg.firstChild; row <= reg.lastChild; row++) {
        const o = row * stride,
          flags = Math.round(meta[o + 27]);
        if (flags & 64) {
          R._groupBegin(
            {
              shapeIdx: row,
              opacity: meta[o + 7],
              blendMode: Math.round(meta[o + 33]),
              isolation: 1,
            },
            null,
          );
          resume();
        } else if (flags & 128) {
          R._groupEnd();
          resume();
        } else {
          const draw = () => {
            resume();
            gl.uniform1i(bakeU.row, row + 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          };
          const mode = Math.round(meta[o + 33]);
          if (mode) {
            R._blendLeaf(
              { kind: 'fillShape', shapeIdx: row, blendMode: mode, resource: true },
              draw,
            );
            resume();
          } else draw();
        }
      }
    });
    bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskSlot.arr, 0, layerIdx);
    R.glUseProgram(R.cacheBlitProg);
    R.glBindVertexArray(R.coverVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(R.cbUCacheTex, 0);
    gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
    if (R.cbUInMap) gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);
    gl.uniform1i(cbUOutputChannel, reg.kind === 'pattern' ? 0 : reg.isLuminance ? 2 : 1);
    R.glDisable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniform1i(cbUOutputChannel, 0);
    resume();
    if (bakeU.fullColor) gl.uniform1i(bakeU.fullColor, 0);
  }

  // Blit each layer of the ping array onto the matching layer of the
  // pong array via a read FBO + draw FBO blitFramebuffer. Done once
  // per frame, between Pass 1 and Pass 2 of bakeMaskRegions().
  function copyPingToPong(depth) {
    const [cw, ch] = viewportSize();
    for (let l = 0; l < depth; l++) {
      bindFb(gl.READ_FRAMEBUFFER, _maskBakeCopyFbo);
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskSlot.arr, 0, l);
      bindFb(gl.DRAW_FRAMEBUFFER, _maskBakeFbo);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskRTArrayPong, 0, l);
      gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    bindFb(gl.READ_FRAMEBUFFER, null);
    bindFb(gl.DRAW_FRAMEBUFFER, null);
  }

  // Full teardown for renderer.dispose(): delete every mask GL resource.
  function _disposeMaskBake() {
    for (const entry of typedBakePrograms.values())
      deleteProgramWhenLinked(gl, entry.pending || entry);
    typedBakePrograms.clear();
    uniformCache.clear();
    for (const s of _maskSlots.values()) if (s.arr) deleteGlResource(gl, 'Texture', s.arr);
    _maskSlots.clear();
    _maskSlot = null;
    _maskSlotBytes = 0;
    for (const t of [_maskRTArrayPong, _maskRTDummy, _maskRowToLayerDummy])
      if (t) deleteGlResource(gl, 'Texture', t);
    if (_maskBakeFbo) deleteGlResource(gl, 'Framebuffer', _maskBakeFbo);
    if (_maskBakeCopyFbo) deleteGlResource(gl, 'Framebuffer', _maskBakeCopyFbo);
    if (maskBakeVao) deleteGlResource(gl, 'VertexArray', maskBakeVao);
    if (maskBakeBuf) deleteGlResource(gl, 'Buffer', maskBakeBuf);
    _maskBakeFbo = null;
    _maskRTArrayPong = null;
    _maskBakeCopyFbo = null;
    _maskRTDummy = null;
    _maskRowToLayerDummy = null;
    _maskRTSizePong[0] = _maskRTSizePong[1] = _maskRTSizePong[2] = 0;
  }

  // Context-loss forget: drop RT-array/FBO refs WITHOUT deleting (post-loss
  // they're dangling). ensureMaskRTArray rebuilds on the next bake, and the
  // nulled dummy samplers are recreated lazily by their accessors. The bake
  // quad VAO/VBO are created once at attach and are NOT nulled here — a truly
  // lost context needs the consumer to dispose() + recreate the renderer.
  function _forgetMaskBake() {
    typedBakePrograms.clear();
    activeBakeProgram = R.maskBakeProg;
    uniformCache.clear();
    _maskSlots.clear();
    _maskSlot = null;
    _maskSlotBytes = 0;
    _maskBakeFbo = null;
    _maskRTArrayPong = null;
    _maskBakeCopyFbo = null;
    _maskRTDummy = null;
    _maskRowToLayerDummy = null;
    _maskRTSizePong[0] = _maskRTSizePong[1] = _maskRTSizePong[2] = 0;
  }

  // The unit-quad VAO/VBO is shared: drawImages.js draws its image quad on it.
  R.maskBakeVao = maskBakeVao;
  R.maskBakeBuf = maskBakeBuf;
  Object.defineProperty(R, '_maskRTArray', {
    get: () => (_maskSlot ? _maskSlot.arr : null),
    configurable: true,
  });
  R._selectMaskSlot = selectMaskSlot;
  /// A disposed handle's layers go with it, rather than waiting to be evicted.
  R._dropMaskSlot = (handle) => {
    for (const key of [handle, handle._maskFrameKey]) {
      const s = key && _maskSlots.get(key);
      if (!s) continue;
      if (s.arr) {
        deleteGlResource(gl, 'Texture', s.arr);
        _maskSlotBytes -= _slotBytes(s);
      }
      _maskSlots.delete(key);
      if (_maskSlot === s) _maskSlot = null;
    }
  };
  /// Finish the typed and rotated bake programs the bake started (the loading call: a rotated bake met in play must not wait on a link).
  R._finishMaskBakePrograms = (soft) => {
    let pending = 0;
    for (const [key, entry] of [...typedBakePrograms]) {
      if (!entry || !entry.pending) continue;
      const candidate = entry.pending;
      if (soft && R._khrParallel && !R._programReady(candidate)) {
        pending++;
        continue;
      }
      if (!gl.getProgramParameter(candidate, gl.LINK_STATUS)) {
        deleteGlResource(gl, 'Program', candidate);
        typedBakePrograms.delete(key);
        continue;
      }
      typedBakePrograms.set(key, candidate);
    }
    return pending;
  };
  /// A pipeline warm of the bake for the bundle R._handle holds, under the draw state the warm set (a rotated map picks the rotated
  /// program). The bake is skipped by _ensureMaskBake's validity test when a slot is already baked; the warm wants the draws.
  R._warmMaskBakePrograms = (bundle) => {
    const h = R._handle;
    if (!R.maskBakeProg || !h || h.bundle !== bundle || !h.maskRegions.length) return false;
    bakeMaskRegions();
    if (R._bakeJustDeferred) return 'defer'; // the lean bake program is not ready: nothing drawn, the warm asks again
    // STRICT PLAY's bake nets: the same bake with the all-types program (the general one, and the rotated all-types one under a rotated state), so a
    // bake whose lean program is not built in play draws with a built program of the same footprint. They exist only to stand in: 7-8 s of a cold pipeline
    // each, which a stand-in-free renderer never draws.
    if (
      R.opts.strictPlay === true &&
      R.opts.standIns !== false &&
      !(R._bakeBaseDrawn && R._bakeRot15Drawn)
    ) {
      R._bakeForce = true;
      try {
        if (_maskSlot) _maskSlot.validGen = -1;
        bakeMaskRegions();
      } finally {
        R._bakeForce = false;
      }
      if (R._bakeJustDeferred) return 'defer';
    }
    // Pixel-scissored: nothing it drew is a valid mask. The slot goes with it -- a slot left holding the scissored layers drew the unified route's
    // single-level masks wrongly in the draws after the warm (unifiedNestedMaskRenderSmoke, 24-30k px); the first real draw bakes into a fresh one.
    if (_maskSlot) {
      _maskSlot.validGen = -1;
      R._dropMaskSlot(h);
    }
    return true;
  };
  R.bakeMaskRegions = bakeMaskRegions;
  R._effectMaskTexture = () => _maskSlot?.arr || null;
  R.maskRTDummy = maskRTDummy;
  R.maskRowToLayerDummy = maskRowToLayerDummy;
  R._maskFeedShapeGen = _maskFeedShapeGen;
  R._disposeMaskBake = _disposeMaskBake;
  R._forgetMaskBake = _forgetMaskBake;
}
