// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { uploadBuffer } from './coopUpload.js';
import { requireRendererFeature } from './featureRegistry.js';
import { monotoneCubicDrawEligible } from './aacCubicPreparation.js';
import {
  deleteGlResource,
  deleteProgramWhenLinked,
  trackGlResource,
  createTrackedProgram,
} from './contextResources.js';
import { clampArg } from '../core/argCheck.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import {
  FS_LAYER,
  FS_NON_SCALING_SIZE,
  FS_NON_ROTATION,
  FS_FIXED_POSITION,
} from '../bundle/layout.js';
// aacPointsDraw.js — AAC for SMALL shapes as 1-px points, the coverage computed in the vertex stage.
//
// WHY. AAC's exact per-segment area kernel is a few hundred operations. Drawn large, a shape's fragments spread over many
// tiles and a tile-based GPU shades those in parallel, so the cost hides. Drawn a few pixels tall, hundreds of cover quads
// overlap several deep in a handful of tiles, and the GPU shades the fragments of overlapping blended primitives in draw
// order. Moving the same work to the vertex stage, which is shaded before tiling, parallelizes wherever the points land.
//
// WHAT. Each drawn row becomes 1-px points over the pixels its cover geometry reaches (aacPoints.vert.glsl). Every point
// runs the fill shader's renderFillAAC at its pixel center, or its stroke pass, and writes color x coverage; points that
// miss the shape carry zero coverage and discard. A tagged primitive fill (circle, rect, round rect) is the one place the
// two shaders differ by design: the fill shader shades it by its closed form, the points by the exact walk.
//
// WHEN. A route choice, not a quality gate: a plain bundle of solid fills and strokes whose point list is small (see THE
// GATE below), drawn with an antialiased kernel. Anything the point shader does not paint -- gradients, clips, masks,
// images, overrides, palette / channelLerp recolor (colorMatrix is supported), sprite subsets, cached handles, moving geometry -- keeps render().
//
// Strokes and one grid per row. The point shader runs the fill shader's stroke pass too, and every row gets its own grid
// from a per-draw list of (row, column, row, paint) points, so a row with a fill and a stroke paints both in order and one
// large shape does not size every row's grid.
//
// The default kernel takes it too. renderFill -- Slug's entry, every default draw's kernel -- is the exact walk, the
// renderFillAAC this route runs, so a small Slug draw on points is the same answer computed where it parallelizes. The
// no-AA kernels (a pinned hard-band or hard-tree, a research define) are not this kernel, and keep their own route.
import { ENGINES, ROUTES, DECLINE } from './engineLedger.js';
import { engineSelection, analyticAllowed } from './engineSwitch.js';
import { LB_MIN_EXTENT_PX, LB_MIN_EXTENT_SHARE } from './lbShapePolicy.js';
import { patternHasFineTile } from './shapeScale.js';

/// The gate: points when the draw's POINT COUNT P is under a budget that grows with the geometry's OVERLAP DEPTH D,
///     P <= BASE * (1 + GAIN * (D - 1)),  and never past MAX points.
/// Why those two. Points beat cover quads where small overlapping blended primitives pile into few tiles, which a tile-based GPU
/// shades in draw order almost serially. That is overlap DEPTH -- the cover area summed over rows against the area their union
/// covers (em space: a property of the art, the same at every size). The cost per point, a full exact walk, against a fragment's,
/// is why P is budgeted at all, and a stroke row's pass is in P as a second grid. aacPointsBase, aacPointsDepthGain and
/// aacPointsMaxPoints override the defaults, and aacPointsMaxPx (off by default) bounds the largest row.
const AAC_POINTS_BASE = 90000;
const AAC_POINTS_DEPTH_GAIN = 0.25;
const AAC_POINTS_MAX_POINTS = 1 << 19;
/// THE POLICY, ONE PLACE. Every number the route's decisions turn on:
///   BUILD-TIME criteria (bundle properties, evaluated once per bundle in shapesFor / the sheet test; size-free):
///     LONE_PRIM_MAX      a drawing of nothing but fewer than this many tagged primitives keeps its SDF record (sdf@unified)
///     OTHER_ROWS_MIN     with the analytic route off, a primitive among at least this many other rows is not lone: the points paint the rest
///   RENDER-TIME criteria (per draw, from the draw's size and the bundle's geometry: BASE / DEPTH_GAIN / MAX_POINTS above, in pointsFor;
///     scale-free: P counts pixels covered, D is a property of the art in em space)
///   ORDER: in 'auto' / 'off' the route is asked before the analytic LB unified draw (aacPointsFirst); 'on' / 'only' keep the analytic route.
/// THE ROW GATE's numbers (option aacPointsRowGate; see rowPlan): the largest row extent in device px that takes points, the byte
/// budget of the whole point list (8 B per point), and how many runs the cut may have before the drawing keeps one draw.
const AAC_POINTS_EXT_MAX = 30;
/// A TINY-SHAPE bundle (every row under AAC_COVER_EXT_MAX device px across, at least AAC_POINTS_ROWS_MIN rows) takes ONE class for the whole drawing, by
/// its median row: points under AAC_COVER_EXT_MIN px, the cover pass from there. A max of 0 turns the class off.
const AAC_COVER_EXT_MAX = 32;
const AAC_COVER_EXT_MIN = 14;
const AAC_POINTS_BYTES_BUDGET = 32 << 20;
const AAC_POINTS_RUNS_MAX = 8;
/// Minimum rows on points for a multi-run cut to amortize the extra draws.
const AAC_POINTS_ROWS_MIN = 128;
const AAC_POINTS_LONE_PRIM_MAX = 16;
const AAC_POINTS_OTHER_ROWS_MIN = 16;
/// True where the bundle's primitives keep their SDF record and the points decline. `sheet` is the caller that asked first (aacPointsFirst):
/// it spares only a drawing of nothing BUT a few primitives; the fallback caller (the analytic route declined) also spares a few among few rows.
function keepsSdfRecord(numShapes, primCount, sheet) {
  if (!primCount) return false;
  if (sheet) return primCount < AAC_POINTS_LONE_PRIM_MAX && primCount === numShapes;
  return numShapes - primCount < AAC_POINTS_OTHER_ROWS_MIN;
}
/// The list's entries are four 16-bit fields: a bundle of more rows than this cannot name them.
const AAC_POINTS_MAX_ROW = 0xffff;
/// Points per block bound of a generated table (aacPoints.vert pointAt reads id >> 6: keep the two in step).
const PT_BLOCK = 64;
/// A research define that shades cover quads with another kernel (fillDefines): the draw is not the exact walk's.
const NOT_THIS_KERNEL = /^MANTLE_(HARD|HARD_TREE|HARD_MIXED|GWN|GWN_SDF|COVER_KERNEL)$/;

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachAacPointsDraw(R) {
  const progs = new Map(); // 'pair' | 'stripe' (+ ':rot', ':stroke') -> { prog, U } or false after a failed build
  let vao = null,
    genVao = null;
  /// ONE GL BUFFER PER LIST: a list is immutable once built, and a cached list is drawn again every frame (a bucketed list, a static one), so it
  /// is uploaded ONCE and drawn from its own buffer; a frame that draws the same lists as the last uploads nothing (the shared dynamic buffer re-uploaded
  /// megabytes per draw). LRU under a byte budget (option aacPointsBufferBudget, default 48 MB); an evicted list uploads again when next drawn.
  const listBufs = new Map();
  let listBufBytes = 0;
  const BUF_BUDGET = 48 << 20;
  R._disposeAacPoints = () => {
    const gl = R.gl;
    if (gl) {
      const current = gl.getParameter(gl.CURRENT_PROGRAM);
      for (const P of progs.values()) if (P && P.prog === current) R.glUseProgram(null);
      for (const h of [...listBufs.keys()]) _freeListBuf(h);
      for (const r of hookedBundles) {
        const b = r.deref();
        if (b && b._disposeHooks) b._disposeHooks.delete(onBundleDisposed);
      }
      hookedBundles.clear();
      if (vao) deleteGlResource(gl, 'VertexArray', vao);
      if (genVao) deleteGlResource(gl, 'VertexArray', genVao);
      for (const P of progs.values()) if (P) deleteProgramWhenLinked(gl, P.prog);
    }
    listBufs.clear();
    listBufBytes = 0;
    progs.clear();
    vao = null;
    genVao = null;
  };

  // A bundle's lists go with it: dispose frees their buffers then, not when the budget reaches them (40 disposed bundles held 40 lists and pinned their row tables, and a label re-flowed in play left one set per text).
  // Per renderer, as listBufs is: renderers on one context share a bundle's lists and each has its own count of them. The renderer holds a bundle weakly here; the hook comes off at the renderer's dispose.
  const listsOf = new WeakMap(); // bundle -> { lists: Set of its lists with a buffer here, ref }
  const listSet = new WeakMap(); // list -> that Set
  const hookedBundles = new Set(); // WeakRefs of the bundles holding the hook
  let hookedSweepAt = 256;
  function onBundleDisposed(bundle) {
    const e = listsOf.get(bundle);
    if (e) {
      for (const h of [...e.lists]) _freeListBuf(h);
      hookedBundles.delete(e.ref);
      listsOf.delete(bundle);
    }
    bundle._aacPointsShapes = null;
  }
  function noteListOwner(bundle, h) {
    if (listSet.has(h)) return;
    let e = listsOf.get(bundle);
    if (!e) {
      e = { lists: new Set(), ref: new WeakRef(bundle) };
      listsOf.set(bundle, e);
      if (hookedBundles.size >= hookedSweepAt) {
        for (const r of hookedBundles) if (!r.deref()) hookedBundles.delete(r);
        hookedSweepAt = Math.max(256, hookedBundles.size * 2);
      }
      hookedBundles.add(e.ref);
      (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add(onBundleDisposed);
    }
    e.lists.add(h);
    listSet.set(h, e.lists);
  }

  const _tNow = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  /// The memory budget's evictor: drop point lists the current frame has not used, least recently used first. Returns the bytes freed.
  R._memEvictPointLists = (need, inUse) => {
    let freed = 0;
    for (const h of [...listBufs.keys()]) {
      if (freed >= need) break;
      if (inUse(h.frame | 0, h.t)) continue;
      freed += h.bytes;
      _freeListBuf(h);
    }
    return freed;
  };
  R._memPointListStats = () => ({ lists: listBufs.size, bytes: listBufBytes });

  /// (a list handle's GPU buffer; free it and forget it)
  // (a bundle's lists are shared by the renderers on its context, and another renderer may have freed this one: the entry still leaves this renderer's map, or the eviction below never ends)
  function _freeListBuf(h) {
    if (!h) return;
    const own = listSet.get(h);
    if (own) {
      own.delete(h);
      listSet.delete(h);
    }
    if (listBufs.delete(h)) listBufBytes -= h.bytes;
    if (!h.buf) return;
    deleteGlResource(R.gl, h.gen ? 'Texture' : 'Buffer', h.buf);
    h.buf = null;
  }
  function bufferFor(gl, h) {
    if (h.buf) {
      if (!listBufs.delete(h)) listBufBytes += h.bytes;
      listBufs.set(h, h);
      h.frame = R._frameSerial | 0;
      h.t = _tNow();
      return h.buf;
    }
    if (listBufs.delete(h)) listBufBytes -= h.bytes; // (freed by another renderer: counted once when it comes back)
    let b;
    if (h.gen) {
      const { t, W, H } = h.build();
      b = trackGlResource(gl, gl.createTexture(), 'points');
      if (R._parkFillActiveUnit) R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, b);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, W, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      noteExternalGlWrite();
    } else {
      b = trackGlResource(gl, gl.createBuffer(), 'points');
      uploadBuffer(gl, b, h.build(), gl.STATIC_DRAW); // (cooperative in the loading call: coopUpload.js; the array is dropped once uploaded)
    }
    h.buf = b;
    h.frame = R._frameSerial | 0;
    h.t = _tNow();
    listBufs.set(h, h);
    listBufBytes += h.bytes;
    const budget =
      R.opts.aacPointsBufferBudget != null ? +R.opts.aacPointsBufferBudget : BUF_BUDGET;
    while (listBufBytes > budget && listBufs.size > 1) _freeListBuf(listBufs.keys().next().value);
    const st =
      R._aacPointsStats ||
      (R._aacPointsStats = { builds: 0, builtPoints: 0, draws: 0, drawnPoints: 0, resizes: 0 });
    st.resizes++; // an upload
    return b;
  }

  // Compile + link synchronously and validate inline, as the instanced fill program does, so a failure leaves the
  // renderer's deferred validation queue untouched and the draw falls back to render().
  /// `types`: the segment types the bundle holds (its segTypeMask: bit 0 line, 1 quad, 2 cubic, 3 arc), 0xF for all. The program compiles
  /// out the kernels of the types it lacks, as a fill variant does under typeOmit: a text bundle is lines and quads, and the cubic
  /// and arc kernels it never runs still set the program's register high-water mark, which sets its occupancy.
  /// True where a colorMatrix / offset pair changes a color (not an identity matrix with a zero offset), as fillPass.js's gate reads it.
  function cmHasEffect(m, o) {
    if (m)
      for (let i = 0; i < 16; i++)
        if (Math.abs(m[i] - ((i & 3) === i >> 2 ? 1 : 0)) > 1e-6) return true;
    if (o) for (let i = 0; i < 4; i++) if (Math.abs(o[i]) > 1e-6) return true;
    return false;
  }
  /// True where the matrix can make alpha out of nothing: the output alpha takes a color channel or an offset (column-major: m[3], m[7], m[11] are
  /// the alpha row's color terms). The fill shader then paints a transparent paint (fill="none") over the shape's interior, which the point
  /// list (no fill points for a row with no fill) does not; that matrix keeps the cover route.
  function cmMakesAlpha(m, o) {
    if (m && (Math.abs(m[3]) > 1e-6 || Math.abs(m[7]) > 1e-6 || Math.abs(m[11]) > 1e-6))
      return true;
    return !!o && Math.abs(o[3]) > 1e-6;
  }
  /// `begin`: only start the compile and link, asking nothing of the program; the draw that needs it finishes it once the driver has
  /// completed the link. Without KHR_parallel_shader_compile there is nothing to wait for and the program is made at once.
  /// `poll`: a DRAW asking for the program. Where the driver compiles in parallel, an unfinished program answers null (the route declines to the
  /// cover route this frame, a draw that paints the same AAC coverage) and is finished by the first draw that finds the driver done with it.
  /// Reading LINK_STATUS of an unfinished program blocks the main thread until the GPU process has built it: 0.3-1.8 s for a stroked or
  /// rotated point program on a cold cache, in the middle of play.
  const pairBandsOf = (bundle) => !!bundle.pairBands;
  /// Can the point program with args `a` draw what the one with args `w` draws? The same footprint (rotated), a pair-band layout when the
  /// wanted one reads pair bands, every pass the wanted one has (stroke, clip, gradient, mask, pattern), every segment type it keeps,
  /// and no monotone-cubic assumption it does not share.
  function pointsSuperset(a, w) {
    return (
      a.rotated === w.rotated &&
      (a.pairBands || !w.pairBands) &&
      (a.strokes || !w.strokes) &&
      (a.clips || !w.clips) &&
      (a.grads || !w.grads) &&
      (a.masks || !w.masks) &&
      (a.pats || !w.pats) &&
      (a.types & w.types) === w.types &&
      (!a.monotone || w.monotone)
    );
  }
  /// The args of the point program this bundle would want (rotated: under a rotated map), or null when the route cannot take it.
  R._pointsWantArgs = (bundle, rot) => {
    const wanted =
      R.opts.aacPointsPrewarm === undefined ? !!R._khrParallel : !!R.opts.aacPointsPrewarm;
    if (!wanted || !bundle || R._contextLost || R.opts.aacPoints === false) return null;
    const src = R.shaderSources;
    if (!src || !src.aacPointsVert || !src.aacPointsFrag) return null;
    if (
      bundle._geomGen ||
      bundle._morphSrc ||
      bundle._incStroke ||
      bundle._lbStream ||
      bundle._nineSliceActive
    )
      return null;
    const s = shapesFor(bundle);
    if (!s) return null;
    return {
      pairBands: !!bundle.pairBands,
      rotated: !!rot,
      strokes: s.strokes,
      types: typesOf(bundle),
      clips: s.clips,
      grads: s.grads,
      masks: s.masks,
      pats: s.pats,
      monotone:
        !rot && !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
    };
  };
  R._pointsStart = (a) =>
    programFor(
      a.pairBands,
      a.rotated,
      a.strokes,
      a.types,
      a.clips,
      a.grads,
      a.masks,
      a.pats,
      a.monotone,
      true,
    );
  R._pointsSuperset = pointsSuperset;
  (R._wmPrelinkers ||= {}).points = ([
    pairBands,
    rotated,
    strokes,
    types,
    clips,
    grads,
    masks,
    pats,
    monotone,
  ]) => {
    programFor(pairBands, rotated, strokes, types, clips, grads, masks, pats, !!monotone, true);
  };
  /// Generated points (option aacPointsGen, default on): the vertex shader finds each point from gl_VertexID in a per-(row, paint) table; off, the list path.
  const genOn = () => R.opts.aacPointsGen !== false;
  const progKey = (pairBands, rotated, strokes, types, clips, grads, masks, pats, monotone) =>
    (genOn() ? 'gen:' : '') +
    (monotone ? 'monotone:' : '') +
    (pairBands ? 'pair' : 'stripe') +
    (rotated ? ':rot' : '') +
    (strokes ? ':stroke' : '') +
    (clips ? ':clip' : '') +
    (grads ? ':grad' : '') +
    (masks ? ':mask' : '') +
    (pats ? ':pat' : '') +
    (types !== 0xf ? ':t' + types : '');
  function programFor(
    pairBands,
    rotated,
    strokes,
    types = 0xf,
    clips = false,
    grads = false,
    masks = false,
    pats = false,
    monotone = false,
    begin = false,
    poll = false,
  ) {
    const key = progKey(pairBands, rotated, strokes, types, clips, grads, masks, pats, monotone);
    let hit = progs.get(key);
    if (hit === undefined && R._cover && !begin) {
      // A built point program with the same footprint and at least this program's code draws the same pixels: bind it, start nothing.
      const want = { pairBands, rotated, strokes, types, clips, grads, masks, pats, monotone };
      for (const [k, rec] of progs)
        if (rec && rec.args && !rec.pending && pointsSuperset(rec.args, want)) return rec;
    }
    if (hit === undefined) {
      if (!begin && R._noteProgramMiss) R._noteProgramMiss('points', key);
      // (a draw at a scale the image never saw this bundle take the route at: under the stand-in-free policy the strict decline below answers it from the cover key, which is in the image. A link here
      // would be compile work in the GPU process, ahead of every frame, for a program no draw can use: nothing in play draws an unbuilt point program.)
      if (begin || !poll || R.opts.standIns !== false || !R._strictPlay || !R._strictPlay())
        hit = startProgram(
          key,
          pairBands,
          rotated,
          strokes,
          types,
          clips,
          grads,
          masks,
          pats,
          monotone,
        );
    }
    // STRICT PLAY: a point program whose pipeline has never been built (never drawn) is not drawn for the first time in play. A built program that
    // draws what this one would (the same footprint, every pass and segment type it has) stands in; otherwise the route declines to the cover route,
    // which paints the same AAC coverage from a program with a built net, and the program waits for a warm window (R._pointsWantWarm).
    if (poll && !begin && R._strictPlay && R._strictPlay()) {
      if (!(hit && !hit.pending && hit.built)) {
        const want = { pairBands, rotated, strokes, types, clips, grads, masks, pats, monotone };
        for (const rec of progs.values())
          if (rec && rec.args && !rec.pending && rec.built && pointsSuperset(rec.args, want)) {
            (R._pointsWantWarm ||= new Set()).add(key);
            return rec;
          }
        (R._pointsWantWarm ||= new Set()).add(key);
        R._pointsStrictDeclines = (R._pointsStrictDeclines | 0) + 1;
        return null;
      }
    }
    if (hit && hit.pending) {
      if (begin && R._khrParallel) return null;
      // Non-blocking mode: finished only once the driver is done with it AND the GPU thread has caught up (gpuGate.js): the reads in finishProgram
      // wait for both. Otherwise the driver's completion alone.
      if (R._khrParallel) {
        if (R._nbNow()) {
          if (!R._forceLinks && !R._programReady(hit.p)) return null;
        } else if (poll && !R.gl.getProgramParameter(hit.p, R._khrParallel.COMPLETION_STATUS_KHR))
          return null;
      }
      hit = finishProgram(key, hit);
    }
    return hit || null;
  }
  function startProgram(
    key,
    pairBands,
    rotated,
    strokes,
    types,
    clips,
    grads,
    masks,
    pats,
    monotone,
  ) {
    const gl = R.gl;
    const ps0 = R._pendingShaders.length,
      pp0 = R._pendingPrograms.length;
    /** @type {string[]} */
    const defs = [];
    if (genOn()) defs.push('MANTLE_POINTS_GEN');
    if (monotone) defs.push('MANTLE_NO_CUBIC_SPLITS');
    if (pairBands) defs.push('MANTLE_AAC_PAIR_BANDS');
    if (rotated) defs.push('MANTLE_ROTATED_MAP'); // the rotated footprint, as the fill shader's rotated-map program
    if (strokes) defs.push('MANTLE_POINTS_STROKE');
    if (grads) defs.push('MANTLE_POINTS_GRADIENT'); // the gradient sampler: the stop textures are read
    if (masks) defs.push('MANTLE_POINTS_MASK'); // the inline mask walk
    if (pats) defs.push('MANTLE_POINTS_PATTERN'); // the vector-pattern block
    if (clips) defs.push('MANTLE_POINTS_CLIP'); // the clip walk: a second renderFill per point, so only for a bundle with clipped rows
    /** @type {Array<[number, string]>} */
    const typeDefines = [
      [1, 'MANTLE_NO_LINE'],
      [2, 'MANTLE_NO_QUAD'],
      [4, 'MANTLE_NO_CUBIC'],
      [8, 'MANTLE_NO_ARC'],
    ];
    for (const [bit, d] of typeDefines) if (!(types & bit)) defs.push(d); // the stroke pass: most of the program, so only for a draw that strokes
    const vs = R.compile(R.withDefines(R.shaderSources.aacPointsVert, defs), gl.VERTEX_SHADER);
    const fs = R.compile(R.shaderSources.aacPointsFrag, gl.FRAGMENT_SHADER);
    const p = createTrackedProgram(gl);
    if (R._gpuLabel) R._gpuLabel(p, 'points:' + key);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPt'); // one VAO serves every variant
    gl.linkProgram(p);
    R._pendingShaders.length = ps0;
    R._pendingPrograms.length = pp0;
    // The program keeps its attached shaders; their status is read only if the link fails.
    deleteGlResource(gl, 'Shader', vs);
    deleteGlResource(gl, 'Shader', fs);
    const rec = {
      pending: true,
      prog: p,
      p,
      defs,
      args: { pairBands, rotated, strokes, types, clips, grads, masks, pats, monotone },
    };
    progs.set(key, rec);
    return rec;
  }
  function finishProgram(key, rec) {
    const gl = R.gl,
      p = rec.p,
      defs = rec.defs;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const logs = [gl.getProgramInfoLog(p)];
      for (const sh of (gl.getAttachedShaders && gl.getAttachedShaders(p)) || [])
        logs.push(gl.getShaderInfoLog(sh));
      R.mantleWarn(
        '[Mantle] AAC point program failed to build; small shapes keep the cover-quad route.',
        ...logs,
      );
      deleteGlResource(gl, 'Program', p);
      progs.set(key, false);
      return null;
    }
    const U = {};
    for (const n of [
      'uCurveData',
      'uBandData',
      'uMetaTex',
      'uDashTex',
      'uGlobalBBox',
      'uCanvasAR',
      'uViewportSize',
      'uWorldM',
      'uDrawAlpha',
      'uStrokeGates',
      'uStrokeExactAa',
      'uGradientTex',
      'uGradientStops',
      'uColorMatrix',
      'uColorMatrixOffset',
      'uColorMatrixEnabled',
      'uPtTable',
      'uPtEntries',
    ]) {
      U[n] = gl.getUniformLocation(p, n);
    }
    R.glUseProgram(p);
    gl.uniform1i(U.uCurveData, 0);
    gl.uniform1i(U.uBandData, 1);
    gl.uniform1i(U.uMetaTex, 2);
    if (U.uDashTex) gl.uniform1i(U.uDashTex, 3);
    if (U.uGradientTex) gl.uniform1i(U.uGradientTex, 4);
    if (U.uGradientStops) gl.uniform1i(U.uGradientStops, 5);
    if (U.uPtTable) gl.uniform1i(U.uPtTable, 6);
    // THE PROGRAM THAT DRAWS, named as a fill variant's key is (debugStats.drawnFillVariantKey): a point draw binds no fill variant,
    // so a caller asking which program drew -- a bench waiting for its variant to bind -- read null for it forever.
    const P = {
      args: rec.args,
      prog: p,
      U,
      key: ['MANTLE_POINTS']
        .concat(defs.map((d) => (d === 'MANTLE_POINTS_STROKE' ? 'MANTLE_POINTS_STROKE' : d)))
        .sort()
        .join('|'),
    };
    progs.set(key, P);
    return P;
  }

  /// Per bundle: the drawn rows, what each paints (bit 0 its fill, bit 1 its stroke) and each ONE'S own em extent, or null
  /// when some drawn row is one the point shader cannot paint. Keyed on the geometry and cull generations, like the
  /// instanced compact cache.
  ///
  /// PER SHAPE, NOT ONE SYNTHETIC BOX. Keeping a single `max(width)` and `max(height)` across the whole draw
  /// produces a synthetic box no shape in the bundle contains: a run of wide-flat bars and one tall-thin
  /// stem would report a box as wide as the bars and as tall as the stem. Unrotated the two agree, because
  /// max_i max(ex*w_i, ey*h_i) is the same number either way; under a worldMatrix ROTATION they do not, because the
  /// extent mixes both axes (|m00*ex|*w + |m01*ey|*h) and the synthetic box is strictly larger. The extents ride along
  /// per shape and the route maxes the real ones.
  /// THE OVERLAP DEPTH (the gate's second term): the rows' cover boxes summed in area over the area of their union, on a 64 x 64
  /// grid of the art's own box. Em space, so it is a property of the art and the same at every size; 1 for rows that do not overlap.
  const _depthGrid = new Uint8Array(64 * 64);
  function overlapDepth(abs, gbb) {
    const G = 64,
      grid = _depthGrid,
      W = gbb[2],
      H = gbb[3];
    if (!(W > 0 && H > 0)) return 1;
    grid.fill(0);
    let sum = 0;
    for (let i = 0; i < abs.length; i += 4) {
      const x0 = Math.max(abs[i], gbb[0]),
        y0 = Math.max(abs[i + 1], gbb[1]);
      const x1 = Math.min(abs[i + 2], gbb[0] + W),
        y1 = Math.min(abs[i + 3], gbb[1] + H);
      if (!(x1 > x0 && y1 > y0)) continue;
      sum += (x1 - x0) * (y1 - y0);
      const a = Math.floor(((x0 - gbb[0]) / W) * G),
        b = Math.min(G - 1, Math.floor(((x1 - gbb[0]) / W) * G));
      const c = Math.floor(((y0 - gbb[1]) / H) * G),
        d = Math.min(G - 1, Math.floor(((y1 - gbb[1]) / H) * G));
      for (let j = c; j <= d; j++) for (let k = a; k <= b; k++) grid[j * G + k] = 1;
    }
    let u = 0;
    for (let k = 0; k < grid.length; k++) u += grid[k];
    const union = u * (W / G) * (H / G);
    return union > 0 ? Math.max(1, sum / union) : 1;
  }

  /// The bundle's segment types for the program (a mask of 0 or a missing one reads as all four; opts.aacPointsTypeOmit false does too).
  function typesOf(bundle) {
    const m = bundle.segTypeMask | 0;
    return R.opts.aacPointsTypeOmit === false || !m ? 0xf : m & 0xf;
  }

  function shapesFor(bundle) {
    const gen = bundle._geomGen | 0,
      cullGen = bundle._cullGen | 0;
    const c = bundle._aacPointsShapes;
    if (c && c.gen === gen && c.cullGen === cullGen) return c.rows ? c : null;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      dl = bundle.drawList;
    const cq = bundle.coverQuadFloats;
    let rows = [],
      paint = [],
      ext = [],
      box = [],
      abs = [],
      hasPrim = false,
      primRows = [],
      clips = false,
      grads = false,
      masks = false,
      pats = false;
    if (!meta || !st || !dl || !dl.length) rows = null;
    else {
      for (const op of dl) {
        if (
          op.kind !== 'fillShape' ||
          op.shapeIdx > AAC_POINTS_MAX_ROW ||
          op.filterGraphId ||
          op.filterId ||
          op.colrGraphId ||
          op.blendMode
        ) {
          rows = null;
          break;
        }
        const b = op.shapeIdx * st;
        if (st >= 36 && Math.round(meta[b + 35]) !== 0) {
          rows = null;
          break;
        } // an image row
        // a MASKED row: its mask rows (from the first, to FLAG_MASK_END) must be fills and strokes, no image
        const maskId = Math.round(meta[b + 31]);
        if (maskId > 0) {
          masks = true;
          let ok = true;
          for (let r = maskId - 1; r < (bundle.numShapes | 0); r++) {
            const o = r * st,
              fl = Math.round(meta[o + 27]);
            if ((fl & 256) === 0) break;
            if ((fl & (64 | 128)) !== 0 || meta[o + 33] > 0 || Math.round(meta[o + 43]) === 2) {
              ok = false;
              break;
            }
            // The point walk has no nested mask sampler; use the baked-mask route.
            const innerMask = Math.round(meta[o + 31]);
            if (innerMask > 0 && innerMask !== maskId) {
              ok = false;
              break;
            }
            if (st >= 36 && Math.round(meta[o + 35]) !== 0) {
              ok = false;
              break;
            }
            if (meta[o + 28] > 0.5 || meta[o + 29] > 0.5) grads = true;
            if ((fl & 1024) !== 0 || (fl & 512) === 0) break; // MASK_END, or the single-fill row
          }
          if (!ok) {
            rows = null;
            break;
          }
        }
        const fill = meta[b + 7] > 0,
          stroke = meta[b + 11] > 0 && meta[b + 12] > 0;
        // a VECTOR-PATTERN fill (texel 10 .w = 2): its children (texel 10 .xy = first and last row + 1) must not be images
        if (fill && st >= 44 && Math.round(meta[b + 43]) === 2) {
          pats = true;
          // The inline point sampler supports axis-aligned pattern frames.
          if (meta[b + 21] !== 0 || meta[b + 22] !== 0) {
            rows = null;
            break;
          }
          let ok = true;
          for (
            let r = Math.round(meta[b + 40]) - 1;
            r <= Math.round(meta[b + 41]) - 1 && r >= 0;
            r++
          ) {
            const o = r * st;
            if (
              (Math.round(meta[o + 27]) & (64 | 128)) !== 0 ||
              meta[o + 33] > 0 ||
              Math.round(meta[o + 43]) === 2
            ) {
              ok = false;
              break;
            }
            if (st >= 36 && Math.round(meta[o + 35]) !== 0) {
              ok = false;
              break;
            }
            if (meta[o + 28] > 0.5 || meta[o + 29] > 0.5) grads = true;
          }
          if (!ok) {
            rows = null;
            break;
          }
        }
        if (Math.round(meta[b + 30]) !== 0) clips = true; // a clipped row: the clip walk
        if (fill && meta[b + 28] > 0.5) grads = true; // a gradient fill: the point samples the ramp
        if (stroke && meta[b + 29] > 0.5) grads = true; // a gradient stroke
        if (stroke && meta[b + 47] > 0.5) {
          rows = null;
          break;
        } // a bitmap stroke
        // Fixed point grids do not certify screen-space stroke envelopes.
        if (stroke && Math.round(meta[b + 27]) & (1 | 8192 | 16384)) {
          rows = null;
          break;
        }
        // A vector effect cancels part of the world matrix per row, in the cover vertex shader; the point shader has no such code. (Layer rows use these bits for resource brackets.)
        {
          const fl = Math.round(meta[b + 27]);
          if (
            !(fl & FS_LAYER) &&
            fl & (FS_NON_SCALING_SIZE | FS_NON_ROTATION | FS_FIXED_POSITION)
          ) {
            rows = null;
            break;
          }
        }
        if (!fill && !stroke) continue; // no ink
        if (fill && (Math.round(meta[b + 44]) === 1 || Math.round(meta[b + 44]) === 4)) {
          hasPrim = true;
          primRows.push(op.shapeIdx);
        }
        rows.push(op.shapeIdx);
        paint.push((fill ? 1 : 0) | (stroke ? 2 : 0));
        // Where the row paints: its cover geometry, which is not always inside its meta bbox -- a stroke's miter spike and
        // a square cap reach past the bbox's half-width pad, and the cover quad reaches them. Relative to the bbox's
        // low corner, the corner the point shader's grid origin is taken from.
        let x0 = meta[b],
          y0 = meta[b + 1],
          x1 = meta[b + 2],
          y1 = meta[b + 3];
        const ch = op.chunk;
        if (cq && ch && (ch.count | 0) > 0) {
          for (let v = ch.start | 0, e = v + (ch.count | 0); v < e; v++) {
            const x = cq[v * 12],
              y = cq[v * 12 + 1];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        ext.push(x1 - x0, y1 - y0);
        abs.push(x0, y0, x1, y1);
        box.push(
          x0 - meta[b],
          y0 - meta[b + 1],
          x1 - meta[b],
          y1 - meta[b + 1],
          meta[b + 2] - meta[b],
          meta[b + 3] - meta[b + 1],
        );
      }
      if (rows && !rows.length) rows = null;
    }
    const out = {
      gen,
      cullGen,
      fills: !!rows && paint.some((p) => (p & 1) !== 0),
      rows: rows ? new Uint16Array(rows) : null,
      paint: rows ? new Uint8Array(paint) : null,
      ext: rows ? new Float32Array(ext) : null,
      box: rows ? new Float64Array(box) : null,
      strokes: !!rows && paint.some((p) => (p & 2) !== 0),
      depth: rows ? overlapDepth(abs, bundle.globalBBox) : 1,
      hasPrim,
      primRows,
      clips,
      grads,
      masks,
      pats,
      list: null,
    };
    bundle._aacPointsShapes = out;
    return out.rows ? out : null;
  }

  const LIST_CACHE_MAX = 8,
    LIST_CACHE_BYTES = 24 << 20;
  const pts_bytes = (v) => (v && v.bytes) | 0; // (a list handle's GPU size)
  const pstats = () =>
    R._aacPointsStats ||
    (R._aacPointsStats = { builds: 0, builtPoints: 0, draws: 0, drawnPoints: 0, resizes: 0 });
  function lruGet(m, k) {
    const v = m.get(k);
    if (v !== undefined) {
      m.delete(k);
      m.set(k, v);
    }
    return v;
  }
  function lruPut(m, k, v, cap = LIST_CACHE_MAX, bytesOf = null) {
    m.set(k, v);
    let bytes = 0;
    if (bytesOf) for (const x of m.values()) bytes += bytesOf(x);
    while (m.size > 1 && (m.size > cap || (bytesOf && bytes > LIST_CACHE_BYTES))) {
      const k0 = m.keys().next().value,
        v0 = m.get(k0);
      if (bytesOf) {
        bytes -= bytesOf(v0);
        _freeListBuf(v0);
      }
      m.delete(k0);
    }
    return v;
  }
  function bucketJ(J) {
    let sig = 0;
    for (let i = 0; i < 4; i++) sig = Math.max(sig, Math.abs(J[i]));
    if (!(sig > 0) || !isFinite(sig)) return J;
    const sb = Math.pow(1.25, Math.ceil(Math.log(sig) / Math.log(1.25) - 1e-9)) * (1 + 1e-4);
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) out[i] = (Math.round((J[i] / sig) * 1e6) / 1e6) * sb;
    return out;
  }
  /// The bucketed geometry of s for map J, or null when the drawing is static (its list is exact) or the bucketed span would not fit the 16-bit fields.
  function bucketedGeom(s, J) {
    if (!s.animated || R.opts.aacPointsBucket === false) return null;
    const gb = rowGeom(s, bucketJ(J), 'rowGeomB');
    return gb.span < 0x7fff ? gb : null;
  }
  /// Note the map a drawing is asked with; the first CHANGE marks it animated.
  function noteMap(s, J) {
    const k = J.join(',');
    if (s.mapSeen !== undefined && s.mapSeen !== k) s.animated = true;
    s.mapSeen = k;
  }
  /// The list of one points run of a row-gate plan: exact for a static drawing, bucketed (and kept while the bucket holds) for an animated one.
  function runList(s, plan, run, J) {
    const gb = bucketedGeom(s, J);
    if (!gb) return runPoints(s, plan.g, run.a, run.b);
    const cache = s.runLists || (s.runLists = new Map()),
      ck = gb.key + '|' + run.a + ':' + run.b;
    let l = lruGet(cache, ck);
    if (l === undefined)
      l = lruPut(cache, ck, runPoints(s, gb, run.a, run.b), 4 * LIST_CACHE_MAX, pts_bytes);
    return l;
  }
  /// The point list for the draw's map: per row, per paint, its points (row, column, row, paint), in draw order, or null
  /// past the gate. The point shader puts a row's grid origin at floor() of its meta bbox's low pixel corner; a point's
  /// column and row are offsets from there, biased by 2^15 so the paint region may begin before the bbox (a miter spike,
  /// a square cap). The range covers the row's cover geometry plus the fill shader's AA dilation (under a pixel) and the
  /// origin's floor, with a pixel to spare: pixels in it that the row does not reach carry zero coverage and discard. It
  /// depends only on the map's linear part -- the offsets are differences of transformed corners -- so a pan reuses it;
  /// the last one per bundle is kept.
  function pointsFor(s, J, ex, ey, m00, m10, m01, m11, maxPx, maxPoints) {
    const j0 = J[0],
      j1 = J[1],
      j2 = J[2],
      j3 = J[3],
      prev = s.list;
    const bucketed = !!s.animated && R.opts.aacPointsBucket !== false;
    if (
      prev &&
      prev.j0 === j0 &&
      prev.j1 === j1 &&
      prev.j2 === j2 &&
      prev.j3 === j3 &&
      prev.maxPx === maxPx &&
      prev.maxPoints === maxPoints &&
      prev.bucketed === bucketed
    )
      return prev.pts;
    // A larger axis-aligned grid bounds the exact grid's count and span. If it fits,
    // the exact gate must accept the same cached list; only boundary cases need an exact grid.
    if (bucketed && j1 === 0 && j2 === 0) {
      const B = bucketJ(J);
      if (Math.abs(B[0]) >= Math.abs(j0) && Math.abs(B[3]) >= Math.abs(j3)) {
        const gb = bucketedGeom(s, J);
        if (gb) {
          if (gb.total === undefined) {
            gb.total = 0;
            for (let r = 0; r < s.rows.length; r++) gb.total += gb.cnt[r];
          }
          if (
            gb.total <= maxPoints &&
            maxShapeExtentPx(s.ext, ex, ey, m00, m10, m01, m11) <= maxPx
          ) {
            let pts = lruGet(s.listsB || (s.listsB = new Map()), gb.key);
            if (pts === undefined)
              pts = lruPut(
                s.listsB,
                gb.key,
                runPoints(s, gb, 0, s.rows.length),
                LIST_CACHE_MAX,
                pts_bytes,
              );
            s.list = { j0, j1, j2, j3, maxPx, maxPoints, bucketed, pts };
            return pts;
          }
        }
      }
    }
    const n = s.rows.length;
    const g = rowGeom(s, J); // per row and paint: x0, y0 / x1, y1 (the exact ranges), their counts and the largest offset
    const worst = maxShapeExtentPx(s.ext, ex, ey, m00, m10, m01, m11);
    let total = 0;
    for (let r = 0; r < n; r++) total += g.cnt[r];
    let pts = null;
    if (worst <= maxPx && total <= maxPoints && g.span < 0x7fff) {
      // The gate above decided on the exact counts. A drawing whose map has changed between asks (an animated, depth-scaled sprite) is LISTED from the
      // bucketed map instead: the list is a superset of the exact one, so the pixels are the same, and it survives every frame the scale stays in its bucket.
      const gb = bucketedGeom(s, J);
      if (gb) {
        pts = lruGet(s.listsB || (s.listsB = new Map()), gb.key);
        if (pts === undefined)
          pts = lruPut(s.listsB, gb.key, runPoints(s, gb, 0, n), LIST_CACHE_MAX, pts_bytes);
      } else pts = runPoints(s, g, 0, n);
    }
    // (an exact list the bundle no longer holds is nothing's: free its buffer now, not when the budget reaches it)
    if (
      prev &&
      prev.pts &&
      prev.pts !== pts &&
      !(s.listsB && [...s.listsB.values()].includes(prev.pts))
    )
      _freeListBuf(prev.pts);
    s.list = { j0, j1, j2, j3, maxPx, maxPoints, bucketed, pts };
    return pts;
  }

  /// ROW GATE (option aacPointsRowGate, default on, `false` turns it off; auto only: a setFillEngine pin keeps the whole-bundle gate). The whole-bundle gate above (P <= BASE*(1+GAIN*(D-1))) asks one
  /// question of the draw's TOTAL point count, so a bundle of thousands of tiny rows declines when its total point count exceeds the
  /// base whatever each row costs. The row gate asks it of each ROW:
  ///   a row takes points when its device extent E = max(w, h) px is under E_PTS_MAX (option aacPointsExtMax, 30 px), and the points
  ///   of all such rows fit a BYTE budget (aacPointsBytesBudget, 32 MB at 8 B per point; the largest rows leave first if they do not).
  /// Every other row takes the mesh routes, in the painter order the drawing has: the rows are cut into maximal RUNS of one class in draw
  /// order, a points run is one points draw over its rows, a mesh run is the analytic route restricted to the run's row range (the sprite
  /// subset machinery). More than aacPointsRunsMax runs, or any mask, pattern or non-ascending row order, keeps the single draw.
  /// A row's count is the one pointsFor lists: its cover box in pixels, grown by the AA reach, one point per pixel, per paint.
  function rowGeom(s, J, slot = 'rowGeom') {
    const j0 = J[0],
      j1 = J[1],
      j2 = J[2],
      j3 = J[3];
    const key = J.join(',');
    const cache = (s.geoms || (s.geoms = {}))[slot] || (s.geoms[slot] = new Map());
    const hit = lruGet(cache, key);
    if (hit !== undefined) return hit;
    const tg = globalThis.__MANTLE_DEBUG__ === true ? performance.now() : 0;
    const n = s.rows.length,
      lo = new Int32Array(4 * n),
      hi = new Int32Array(4 * n),
      cnt = new Float64Array(n);
    let span = 0;
    for (let r = 0; r < n; r++) {
      const q = 6 * r,
        bw = s.box[q + 4],
        bh = s.box[q + 5];
      let bx = Infinity,
        by = Infinity,
        cx0 = Infinity,
        cy0 = Infinity,
        cx1 = -Infinity,
        cy1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        const u = k & 1 ? bw : 0,
          v = k & 2 ? bh : 0;
        const X = j0 * u + j2 * v,
          Y = j1 * u + j3 * v;
        if (X < bx) bx = X;
        if (Y < by) by = Y;
        const cu = s.box[q + (k & 1 ? 2 : 0)],
          cv = s.box[q + (k & 2 ? 3 : 1)];
        const CX = j0 * cu + j2 * cv,
          CY = j1 * cu + j3 * cv;
        if (CX < cx0) cx0 = CX;
        if (CX > cx1) cx1 = CX;
        if (CY < cy0) cy0 = CY;
        if (CY > cy1) cy1 = CY;
      }
      for (let kind = 0; kind < 2; kind++) {
        if (!((s.paint[r] >> kind) & 1)) continue;
        const M = (kind === 0 ? 0.5 : 0.7072) + 1e-3,
          o = 4 * r + 2 * kind;
        lo[o] = Math.floor(cx0 - bx - 0.5 - M);
        lo[o + 1] = Math.floor(cy0 - by - 0.5 - M);
        hi[o] = Math.floor(cx1 - bx + 0.5 + M);
        hi[o + 1] = Math.floor(cy1 - by + 0.5 + M);
        cnt[r] += (hi[o] - lo[o] + 1) * (hi[o + 1] - lo[o + 1] + 1);
        span = Math.max(span, -lo[o], -lo[o + 1], hi[o], hi[o + 1]);
      }
    }
    if (tg) {
      const st = pstats();
      st.geomMs = (st.geomMs || 0) + performance.now() - tg;
      st.geoms = (st.geoms | 0) + 1;
    }
    return lruPut(cache, key, { key, lo, hi, cnt, span });
  }
  /// The point list of rows [a, b) of s.rows (list indices), in draw order, as a HANDLE: its point count (known from the row counts), its GPU buffer once
  /// uploaded, and how to build it. The CPU array exists only between its build and its upload (bufferFor): kept, every list a scene had drawn stayed
  /// in memory twice (a scene with 763 lists: 493 MB of the renderer process). A buffer the GPU budget evicted is rebuilt from the row counts.
  function runPoints(s, g, a, b) {
    let total = 0;
    for (let r = a; r < b; r++) total += g.cnt[r];
    if (genOn()) {
      let E = 0;
      for (let r = a; r < b; r++)
        for (let kind = 0; kind < 2; kind++) if ((s.paint[r] >> kind) & 1) E++;
      const T = tableTexels(E, total);
      return {
        n: total,
        e: E,
        gen: true,
        bytes: Math.min(Math.max(T, 1), 4096) * Math.max(1, Math.ceil(T / 4096)) * 16,
        buf: null,
        frame: 0,
        t: 0,
        build: () => buildTable(s, g, a, b, E, total),
        points: () => buildPoints(s, g, a, b, total),
      };
    }
    // (`points()`: the per-point list in either mode -- what the generated table encodes; for tests and tools)
    return {
      n: total,
      bytes: total * 8,
      buf: null,
      frame: 0,
      t: 0,
      build: () => buildPoints(s, g, a, b, total),
      points: () => buildPoints(s, g, a, b, total),
    };
  }
  /// The generated points' table (MANTLE_POINTS_GEN): per (row, paint) of rows [a, b), in the list's order -- first point, row | paint << 16, grid width,
  /// grid origin x | y << 16 (biased by 2^15) -- then THE BLOCK BOUNDS: for every PT_BLOCK points, the entry holding the block's first point, four to a
  /// texel, and one more for the last point (the last block's upper bound). A point searches only the entries its block spans (usually one or two)
  /// instead of all of them: the full binary search cost 2-10% GPU on point draws (log2 of the entries, one dependent fetch each). RGBA32UI, 4096 texels to a row.
  function buildTable(s, g, a, b, E, total) {
    const T = tableTexels(E, total),
      W = Math.min(Math.max(T, 1), 4096),
      H = Math.max(1, Math.ceil(T / 4096));
    const t = new Uint32Array(W * H * 4);
    const st =
      R._aacPointsStats ||
      (R._aacPointsStats = { builds: 0, builtPoints: 0, draws: 0, drawnPoints: 0, resizes: 0 });
    st.builds++;
    let e = 0,
      first = 0;
    for (let r = a; r < b; r++) {
      for (let kind = 0; kind < 2; kind++) {
        if (!((s.paint[r] >> kind) & 1)) continue;
        const o = 4 * r + 2 * kind,
          w = g.hi[o] - g.lo[o] + 1,
          h = g.hi[o + 1] - g.lo[o + 1] + 1;
        t[4 * e] = first;
        t[4 * e + 1] = (s.rows[r] | (kind << 16)) >>> 0;
        t[4 * e + 2] = w;
        t[4 * e + 3] =
          (((g.lo[o] + 0x8000) & 0xffff) | (((g.lo[o + 1] + 0x8000) & 0xffff) << 16)) >>> 0;
        first += w * h;
        e++;
      }
    }
    st.builtPoints += first;
    const NB = Math.ceil(total / PT_BLOCK);
    for (let j = 0, k = 0; j <= NB; j++) {
      const p = Math.min(j * PT_BLOCK, total - 1); // (block NB: the last point, the last block's upper bound)
      while (k + 1 < E && t[4 * (k + 1)] <= p) k++;
      t[4 * E + j] = k;
    }
    return { t, W, H };
  }
  /// texels of a generated table: E entries, then (blocks + 1) bounds four to a texel
  function tableTexels(E, total) {
    return E + Math.ceil((Math.ceil(total / PT_BLOCK) + 1) / 4);
  }
  function buildPoints(s, g, a, b, total) {
    const pts = new Uint16Array(total * 4);
    const st =
      R._aacPointsStats ||
      (R._aacPointsStats = { builds: 0, builtPoints: 0, draws: 0, drawnPoints: 0, resizes: 0 });
    st.builds++;
    st.builtPoints += total;
    const tb = globalThis.__MANTLE_DEBUG__ === true ? performance.now() : 0;
    let k = 0;
    for (let r = a; r < b; r++) {
      for (let kind = 0; kind < 2; kind++) {
        if (!((s.paint[r] >> kind) & 1)) continue;
        const o = 4 * r + 2 * kind;
        for (let j = g.lo[o + 1]; j <= g.hi[o + 1]; j++)
          for (let i = g.lo[o]; i <= g.hi[o]; i++) {
            pts[k++] = s.rows[r];
            pts[k++] = i + 0x8000;
            pts[k++] = j + 0x8000;
            pts[k++] = kind;
          }
      }
    }
    if (tb) st.buildMs = (st.buildMs || 0) + performance.now() - tb;
    return pts;
  }
  /// Device extent E of list row r: max over the two axes of the row's em box through the draw's linear part.
  function rowExtentPx(s, r, ex, ey, m00, m10, m01, m11) {
    const w = s.ext[2 * r],
      h = s.ext[2 * r + 1];
    const x = Math.abs(m00 * ex) * w + Math.abs(m01 * ey) * h,
      y = Math.abs(m10 * ex) * w + Math.abs(m11 * ey) * h;
    return x > y ? x : y;
  }
  /// The plan: { runs: [{ a, b, pts: bool, lo, hi (shape rows), points? }], rowsPts, bytes } or null (no row takes points, or the
  /// drawing cannot be cut). `allowMesh` false (the fallback caller, after the analytic route declined) takes only an all-points plan.
  function rowPlan(s, J, ex, ey, m00, m10, m01, m11, allowMesh) {
    const extMax = R.opts.aacPointsExtMax != null ? +R.opts.aacPointsExtMax : AAC_POINTS_EXT_MAX;
    let bytesMax =
      R.opts.aacPointsBytesBudget != null ? +R.opts.aacPointsBytesBudget : AAC_POINTS_BYTES_BUDGET;
    if (R._memRoom) bytesMax = Math.min(bytesMax, R._memRoom()); // the scene memory budget bounds the point lists, in whole megabytes so the plan cache holds
    const runsMax =
      R.opts.aacPointsRunsMax != null ? +R.opts.aacPointsRunsMax : AAC_POINTS_RUNS_MAX;
    const rowsMin =
      R.opts.aacPointsRowsMin != null ? +R.opts.aacPointsRowsMin : AAC_POINTS_ROWS_MIN;
    const covMax = R.opts.aacCoverExtMax != null ? +R.opts.aacCoverExtMax : AAC_COVER_EXT_MAX;
    const covMin = R.opts.aacCoverExtMin != null ? +R.opts.aacCoverExtMin : AAC_COVER_EXT_MIN;
    const key = [
      J.join(','),
      extMax,
      bytesMax,
      runsMax,
      rowsMin,
      covMin,
      covMax,
      allowMesh ? 1 : 0,
    ].join('|');
    const plans = s.plans || (s.plans = new Map()),
      ph = lruGet(plans, key);
    if (ph !== undefined) return ph.v;
    let v = null;
    const n = s.rows.length;
    let ascending = !s.masks && !s.pats;
    for (let r = 1; ascending && r < n; r++) if (s.rows[r] <= s.rows[r - 1]) ascending = false;
    if (ascending) {
      const g = rowGeom(s, J);
      if (g.span < 0x7fff) {
        const cls = new Uint8Array(n),
          E = new Float64Array(n);
        let total = 0,
          nP = 0,
          nC = 0,
          worst = 0;
        for (let r = 0; r < n; r++) {
          E[r] = rowExtentPx(s, r, ex, ey, m00, m10, m01, m11);
          if (E[r] > worst) worst = E[r];
        }
        if (covMax > 0 && n >= rowsMin && worst < covMax) {
          // A TINY-SHAPE BUNDLE (every row under covMax): one class for the whole drawing, by its median row. A point costs a full walk and
          // wins where overlapping blended quads would pile into few tiles (rows under ~14 px); above that the cover pass wins, and one draw
          // beats a cut whose runs alternate row by row. The points list must fit its byte budget, else the cover pass takes it.
          const sorted = Float64Array.from(E).sort();
          const med = sorted[n >> 1];
          let pts = med < covMin;
          if (pts) {
            for (let r = 0; r < n; r++) total += g.cnt[r];
            if (total * 8 > bytesMax) pts = false;
          }
          cls.fill(pts ? 1 : 2);
          if (pts) nP = n;
          else {
            nC = n;
            total = 0;
          }
        } else {
          // classes: 1 points, 0 the mesh routes
          for (let r = 0; r < n; r++)
            if (E[r] < extMax) {
              cls[r] = 1;
              total += g.cnt[r];
              nP++;
            }
          if (total * 8 > bytesMax) {
            // the largest rows leave first until the list fits
            const order = [];
            for (let r = 0; r < n; r++) if (cls[r]) order.push(r);
            order.sort((a, b) => E[b] - E[a]);
            for (let i = 0; i < order.length && total * 8 > bytesMax; i++) {
              cls[order[i]] = 0;
              total -= g.cnt[order[i]];
              nP--;
            }
          }
        }
        const nOwn = nP + nC;
        if (nOwn > 0 && nOwn >= Math.min(rowsMin, n) && (nOwn === n || allowMesh)) {
          const runs = [];
          for (let r = 0; r < n;) {
            let e = r + 1;
            while (e < n && cls[e] === cls[r]) e++;
            runs.push({
              a: r,
              b: e,
              pts: cls[r] === 1,
              cover: cls[r] === 2,
              lo: s.rows[r],
              hi: s.rows[e - 1],
              list: null,
            });
            r = e;
          }
          if (runs.length <= runsMax) v = { runs, rowsPts: nP, rowsCover: nC, bytes: total * 8, g };
        }
      }
    }
    lruPut(plans, key, { v });
    return v;
  }

  /// The largest DRAWN SHAPE's on-screen extent, in device pixels along either axis. `ext` holds (w, h) per shape in em;
  /// (ex, ey) is the em to pixel scale and (m00..m11) the draw's linear part.
  function maxShapeExtentPx(ext, ex, ey, m00, m10, m01, m11) {
    let worst = 0;
    for (let i = 0; i + 1 < ext.length; i += 2) {
      const w = ext[i],
        h = ext[i + 1];
      const x = Math.abs(m00 * ex) * w + Math.abs(m01 * ey) * h;
      const y = Math.abs(m10 * ex) * w + Math.abs(m11 * ey) * h;
      const m = x > y ? x : y;
      if (m > worst) worst = m;
    }
    return worst;
  }
  R._aacPointsMaxShapeExtentPx = maxShapeExtentPx;
  R._aacPointsGate = {
    rowPlan,
    rowGeom,
    bucketJ,
    bucketedGeom,
    shapesFor,
    pointsFor,
    overlapDepth,
    budget: (depth, base = AAC_POINTS_BASE, gain = AAC_POINTS_DEPTH_GAIN) =>
      Math.min(AAC_POINTS_MAX_POINTS, base * (1 + gain * Math.max(0, depth - 1))),
  }; // for the gate's smoke

  /// Why the point route declined. Written only under __MANTLE_DEBUG__, read through debugStats.pointsGateWhy.
  const why = (w) => {
    if (globalThis.__MANTLE_DEBUG__ === true) R._aacPointsWhy = w;
    return false;
  };
  /// Under __MANTLE_DEBUG__ the route's own time and its parts accumulate in debugStats.pointsStats (ms): route (the whole ask, draw included), geom (row ranges), build (list emission).
  function aacPointsRoute(bundle, sheet, meshDraw) {
    if (globalThis.__MANTLE_DEBUG__ !== true) return aacPointsRoute0(bundle, sheet, meshDraw);
    const t0 = performance.now(),
      r = aacPointsRoute0(bundle, sheet, meshDraw);
    const st = pstats();
    st.routeMs = (st.routeMs || 0) + performance.now() - t0;
    st.asks = (st.asks | 0) + 1;
    return r;
  }
  /// THE DECISION ALONE (the warm image's probe, fillPass wantKeysOf): the args of the point program the route would draw this bundle with in the current draw state, or null.
  /// The same gate as the draw, read without side effects: no handle (the probe stands for the transient handle a draw binds: present, no static cache), no map note (a
  /// probe at several sizes must not mark a static drawing animated), counts instead of point lists, the program's args instead of the program (the pass links it), and none
  /// of the draw-time declines that depend on the moment (the GPU thread busy, a program still linking): the image holds the cover keys those declines draw.
  R._aacPointsDecide = (bundle) => {
    const w = R._aacPointsWhy,
      pl = R._aacPointsPlan;
    try {
      return aacPointsRoute0(bundle, null, null, true) || null;
    } finally {
      R._aacPointsWhy = w;
      R._aacPointsPlan = pl;
    }
  };
  /// The program of a probe's args: started if it is not (begin), ready = linked, built = drawn once (its pipeline exists).
  R._pointsProgState = (a) => {
    const hit = progs.get(
      progKey(
        a.pairBands,
        a.rotated,
        a.strokes,
        a.types,
        a.clips,
        a.grads,
        a.masks,
        a.pats,
        a.monotone,
      ),
    );
    return {
      started: hit !== undefined,
      ready: !!hit && (!hit.pending || (!!R._programReady && R._programReady(hit.p))),
      built: !!hit && !hit.pending && !!hit.built,
    };
  };
  /// Would pointsFor list this map? Its gate on the exact counts (the bucketed early answer only accepts what the exact gate accepts), without building the list.
  function pointsAccept(s, J, ex, ey, m00, m10, m01, m11, maxPx, maxPoints) {
    const prev = s.list;
    if (
      prev &&
      prev.j0 === J[0] &&
      prev.j1 === J[1] &&
      prev.j2 === J[2] &&
      prev.j3 === J[3] &&
      prev.maxPx === maxPx &&
      prev.maxPoints === maxPoints
    )
      return !!prev.pts;
    const g = rowGeom(s, J);
    let total = 0;
    for (let r = 0; r < s.rows.length; r++) total += g.cnt[r];
    return (
      maxShapeExtentPx(s.ext, ex, ey, m00, m10, m01, m11) <= maxPx &&
      total <= maxPoints &&
      g.span < 0x7fff
    );
  }
  function aacPointsRoute0(bundle, sheet, meshDraw, probe = false) {
    if (globalThis.__MANTLE_DEBUG__ === true) R._aacPointsWhy = null;
    R._aacPointsPlan = null; // the last row-gate cut belongs to the last ask only
    if (!bundle || R._contextLost) return why('no-bundle-or-context-lost');
    if (R.opts.aacPoints === false || (R.mantleDebugFlag && R.mantleDebugFlag('noAacPoints')))
      return why('option-off');
    if (!analyticAllowed(engineSelection(R), 'aac-points').allow)
      return why('engine-selection-forbids');
    const src = R.shaderSources;
    if (!src || !src.aacPointsVert || !src.aacPointsFrag) return why('no-point-shaders');
    // An antialiased draw (see WHEN above): Slug and AAC are the same exact walk. A pinned no-AA kernel, or a research
    // define that picks another kernel for the cover quads, is not.
    const auto = R.opts.aacFill === 'auto';
    if (R.opts.fillKernel) return why('pinned-no-aa-kernel');
    const fd = R.opts.fillDefines || [];
    for (let i = 0; i < fd.length; i++)
      if (NOT_THIS_KERNEL.test(fd[i])) return why('research-define-kernel');
    const defs = R._instancedEngineDefines ? R._instancedEngineDefines(bundle) : null;
    const aac = auto || (!!defs && defs.indexOf('MANTLE_AAC') >= 0);
    // Static, plain, unmodified draws only.
    if (
      bundle._geomGen ||
      bundle._morphSrc ||
      bundle._incStroke ||
      bundle._lbStream ||
      bundle._nineSliceActive
    )
      return why('bundle-state(geom-gen|morph|incremental|stream|nineslice)');
    const handle = R._handle;
    if (!probe && (!handle || handle.cache)) return why('no-handle-or-static-cache');
    const d = R.draw || {};
    // A colorMatrix is PAINTED (the point shader applies it per draw, as mantle.frag does); the rest of the recolor family and the
    // per-shape modifiers keep the cover route, each under its own code.
    if (R.opts.aacPointsColorMatrix === false && (d.colorMatrix || d.colorMatrixOffset))
      return why('draw-modifier(colorMatrix)'); // option off: a colorMatrix draw keeps the cover route
    if (d.palette) return why('draw-modifier(palette)');
    if ((d.colorMatrix || d.colorMatrixOffset) && cmMakesAlpha(d.colorMatrix, d.colorMatrixOffset))
      return why('draw-modifier(colorMatrix-makes-alpha)');
    if (d.channelLerp) return why('draw-modifier(channelLerp)');
    if (d.overrides || d.extClipTex || d.shapeRange)
      return why('draw-modifier(overrides|extClip|shapeRange)');
    // plain fills and strokes, clipped or not: no filter graph, mask region, blend, image or COLR (shapesFor checks the rows), cover quads present
    if (
      (bundle.filterGraphs && bundle.filterGraphs.length) ||
      bundle._nineSliceActive ||
      !bundle.coverQuadChunks ||
      !bundle.coverQuadChunks.length
    )
      return why('filter-graph-or-no-cover-quads');
    const s = shapesFor(bundle);
    if (!s) return why('shapes-not-eligible(row-kind: image|filter|colr|blend|bitmap-stroke|mask)');
    // A bundle holding a recognizable primitive (a circle or annulus tag, texel 11) waits for its meshes: the analytic route builds the
    // SDF record the first time it is asked, and answering first here would starve that build. Once the meshes exist the analytic route
    // draws it, or declines.
    if (s.hasPrim) {
      const ms = bundle._lbMeshes;
      if (!ms) return why('primitive-mesh-not-built');
      let primCount = 0;
      for (let i = 0; i < s.primRows.length; i++) {
        const m = ms[s.primRows[i]];
        if (!m) return why('primitive-row-mesh-not-built'); // a tagged row whose mesh is not built yet
        if (m.prim) primCount++;
      }
      // Built, a lone primitive keeps its SDF record (sdf@unified): only a SHEET of primitives (aacPointsFirst) is the points' to paint.
      // (A drawing of OTHER_ROWS_MIN or more other rows is not lone: its cover quads are what the points answer.)
      if (keepsSdfRecord(bundle.numShapes | 0, primCount, sheet))
        return why('lone-sdf-primitive-keeps-record');
    }
    const wm = d.worldM;
    if (wm && (Math.abs(wm[2]) > 1e-9 || Math.abs(wm[5]) > 1e-9 || Math.abs(wm[8] - 1) > 1e-9))
      return why('non-affine-world-matrix'); // affine only
    // Each row's on-screen extent, through the same em -> pixel map the shader inverts.
    const [cw, ch] = R.viewportSize();
    const gbb = bundle.globalBBox;
    const [sx, sy] = R.arScale(gbb, cw, ch);
    const ex = (cw * sx) / gbb[2],
      ey = (ch * sy) / gbb[3];
    const m00 = wm ? wm[0] : 1,
      m10 = wm ? wm[1] : 0,
      m01 = wm ? wm[3] : 0,
      m11 = wm ? wm[4] : 1;
    const maxPx = R.opts.aacPointsMaxPx != null ? +R.opts.aacPointsMaxPx : Infinity;
    const base = R.opts.aacPointsBase != null ? +R.opts.aacPointsBase : AAC_POINTS_BASE;
    const gain =
      R.opts.aacPointsDepthGain != null ? +R.opts.aacPointsDepthGain : AAC_POINTS_DEPTH_GAIN;
    let maxPoints = Math.min(
      R.opts.aacPointsMaxPoints != null ? +R.opts.aacPointsMaxPoints : AAC_POINTS_MAX_POINTS,
      base * (1 + gain * Math.max(0, s.depth - 1)),
    );
    if (R._memRoom) maxPoints = Math.min(maxPoints, R._memRoom() / 8); // the scene memory budget: 8 bytes a point
    // the em -> pixel linear part, as the point shader builds it (J, column-major)
    const J = [
      (0.5 * cw * m00 * 2 * sx) / gbb[2],
      (0.5 * ch * m10 * 2 * sx) / gbb[2],
      (-0.5 * cw * m01 * 2 * sy) / gbb[3],
      (-0.5 * ch * m11 * 2 * sy) / gbb[3],
    ];
    if (!probe) noteMap(s, J);
    const pts = probe
      ? pointsAccept(s, J, ex, ey, m00, m10, m01, m11, maxPx, maxPoints)
      : pointsFor(s, J, ex, ey, m00, m10, m01, m11, maxPx, maxPoints);
    const argsOf = () => ({
      pairBands: !!bundle.pairBands,
      rotated: !(m10 === 0 && m01 === 0),
      strokes: s.strokes,
      types: typesOf(bundle),
      clips: s.clips,
      grads: s.grads,
      masks: s.masks,
      pats: s.pats,
      monotone: !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
    });

    if (!pts && R.opts.aacPointsRowGate !== false && !R._forcedCover && !R._forcedKernel) {
      const plan = rowPlan(s, J, ex, ey, m00, m10, m01, m11, !!(sheet && meshDraw));
      if (!plan) return why('row-gate-none');
      if ((s.grads || s.masks || s.pats) && !(m10 === 0 && m01 === 0))
        return why('gradient-under-rotated-map');
      if (s.pats && patternHasFineTile(R, bundle)) return why('pattern-tile-finer-than-a-pixel'); // the cover route averages the tile (MANTLE_PATTERN_MEAN)
      if (probe) return argsOf();
      const P = programFor(
        !!bundle.pairBands,
        !(m10 === 0 && m01 === 0),
        s.strokes,
        typesOf(bundle),
        s.clips,
        s.grads,
        s.masks,
        s.pats,
        !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
        false,
        true,
      );
      if (P && R._wmProgram)
        R._wmProgram('points', [
          pairBandsOf(bundle),
          !(m10 === 0 && m01 === 0),
          s.strokes,
          typesOf(bundle),
          s.clips,
          s.grads,
          s.masks,
          s.pats,
          !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
        ]);
      if (!P) {
        if (R._strictPlay && R._strictPlay() && R._queueWarmBundle) R._queueWarmBundle(bundle);
        return why('points-program-unavailable');
      }
      // Non-blocking mode: the point lists are uploaded per draw (bufferData), and an upload queued behind a pipeline build waits for it. The cover route
      // draws the same picture from buffers already resident.
      if (R._nbNow() && !(R._warmBatch === true || R._gpuClear())) return why('gpu-busy'); // (a batch inside the loading window is one fence's worth, as fillPass gpuClearW)
      for (const run of plan.runs) {
        if (run.pts) {
          if (!run.list) run.list = runList(s, plan, run, J);
          draw(bundle, run.list, P, cw, ch, gbb, sx, sy, wm, aac ? ENGINES.AAC : ENGINES.SLUG, s);
        } else if (run.cover) {
          const dd = R.draw,
            was = dd.shapeRange;
          if (plan.runs.length > 1) dd.shapeRange = [run.lo, run.hi]; // one run is the whole drawing: no sprite subset to slice (a tiny-shape bundle always is)
          R._coverOnlyDraw = true;
          try {
            R._renderCover();
          } finally {
            dd.shapeRange = was;
            R._coverOnlyDraw = false;
          }
          // A pipeline warm (fillPass _warmBundlePso) draws this route and returns: the cover variant it just bound is warm too, or the live draw
          // keeps the universal program until an idle tick finds the demand.
          if (R._psoWarming && R._lastFillVariant) R._lastFillVariant.psoReady = true;
        } else {
          const dd = R.draw,
            was = dd.shapeRange;
          dd.shapeRange = [run.lo, run.hi];
          try {
            meshDraw();
          } finally {
            dd.shapeRange = was;
          }
        }
      }
      R._aacPointsPlan = {
        runs: plan.runs.length,
        rowsPts: plan.rowsPts,
        rowsCover: plan.rowsCover,
        rows: s.rows.length,
        bytes: plan.bytes,
      };
      if (R._noteRowDraw) R._noteRowDraw(bundle, 'points', plan);
      if (auto) R._autoEngine = ENGINES.AAC;
      return true;
    }
    if (!pts) return why('points-for-declined(size-or-budget)');
    if (s.pats && patternHasFineTile(R, bundle)) return why('pattern-tile-finer-than-a-pixel'); // the cover route averages the tile (MANTLE_PATTERN_MEAN)
    if ((s.grads || s.masks || s.pats) && !(m10 === 0 && m01 === 0))
      return why('gradient-under-rotated-map'); // a gradient row under a rotated map: the cover route (the point sampler takes the axis-aligned derivatives)
    if (probe) return argsOf();
    const P = programFor(
      !!bundle.pairBands,
      !(m10 === 0 && m01 === 0),
      s.strokes,
      typesOf(bundle),
      s.clips,
      s.grads,
      s.masks,
      s.pats,
      !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
      false,
      true,
    );
    if (P && R._wmProgram)
      R._wmProgram('points', [
        pairBandsOf(bundle),
        !(m10 === 0 && m01 === 0),
        s.strokes,
        typesOf(bundle),
        s.clips,
        s.grads,
        s.masks,
        s.pats,
        !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
      ]);
    if (!P) return why('points-program-unavailable');
    if (R._nbNow() && !(R._warmBatch === true || R._gpuClear())) return why('gpu-busy'); // (see above)
    draw(bundle, pts, P, cw, ch, gbb, sx, sy, wm, aac ? ENGINES.AAC : ENGINES.SLUG, s);
    if (R._noteRowDraw) R._noteRowDraw(bundle, 'points', null);
    if (auto) R._autoEngine = ENGINES.AAC; // what the selector chose, for debugStats
    return true;
  }

  function draw(bundle, pts, P, cw, ch, gbb, sx, sy, wm, engine, s) {
    const gl = R.gl,
      U = P.U;
    P.built = true; // (its pipeline exists from here: a strict-play draw may bind it)
    noteListOwner(bundle, pts);
    if (pts.gen) {
      // (no vertex input: the shader generates each point from gl_VertexID and the table)
      if (!genVao) genVao = trackGlResource(gl, gl.createVertexArray());
      const tex = bufferFor(gl, pts);
      R.glBindVertexArray(genVao);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    } else {
      if (!vao) {
        vao = trackGlResource(gl, gl.createVertexArray());
        R.glBindVertexArray(vao);
        gl.enableVertexAttribArray(0);
      }
      R.glBindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(gl, pts));
      gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_SHORT, 0, 0);
    }
    {
      const st =
        R._aacPointsStats ||
        (R._aacPointsStats = { builds: 0, builtPoints: 0, draws: 0, drawnPoints: 0, resizes: 0 });
      st.draws++;
      st.drawnPoints += pts.n;
    }
    R.glViewport(0, 0, cw, ch);
    R.glUseProgram(P.prog);
    R.glEnable(gl.BLEND);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    R.glDisable(gl.DEPTH_TEST);
    R.glDepthMask(false);
    R.glDisable(gl.STENCIL_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bundle.bandTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bundle.metaTex);
    // A stroked row reads its dashes: a bundle without a dash table binds the renderer's dummy, as the fill pass does.
    if (U.uGradientTex) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, bundle.gradientTex || R.dummyGradientTex);
    }
    if (U.uGradientStops) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, bundle.gradientStopsTex || R.dummyGradientStops);
    }
    if (U.uDashTex) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, bundle.dashTex || R.dummyDashTex);
    }
    gl.uniform4f(U.uGlobalBBox, gbb[0], gbb[1], gbb[2], gbb[3]);
    gl.uniform2f(U.uCanvasAR, sx, sy);
    gl.uniform2f(U.uViewportSize, cw, ch);
    gl.uniformMatrix3fv(U.uWorldM, false, wm || IDENTITY3);
    gl.uniform1f(U.uDrawAlpha, R.draw && typeof R.draw.alpha === 'number' ? R.draw.alpha : 1);
    if (U.uStrokeExactAa) gl.uniform1i(U.uStrokeExactAa, R.strokeExactAa === false ? 0 : 1);
    // Retain ungated point traversal by default; explicit gate controls apply
    // to both the point and cover programs.
    if (U.uStrokeGates) gl.uniform1i(U.uStrokeGates, R.strokeGates === true ? 1 : 0);
    // The draw's colorMatrix, gated on EFFECT as the fill pass gates it (fillPass.js): an identity matrix with a zero offset is off.
    if (U.uColorMatrixEnabled) {
      const cm = R.draw && R.draw.colorMatrix,
        co = R.draw && R.draw.colorMatrixOffset;
      if (cmHasEffect(cm, co)) {
        gl.uniformMatrix4fv(U.uColorMatrix, false, cm || R.IDENTITY_COLOR_MATRIX);
        gl.uniform4fv(U.uColorMatrixOffset, co || R.ZERO_OFFSET);
        gl.uniform1i(U.uColorMatrixEnabled, 1);
      } else gl.uniform1i(U.uColorMatrixEnabled, 0);
    }
    // One instance of the point list: drawArraysInstanced, the call the point route has always made and its GPU smokes (and the cover
    // smokes' "no point route" checks) key on; the list is per-vertex data, so the instance count is only the call's name.
    if (pts.gen && U.uPtEntries) gl.uniform1i(U.uPtEntries, pts.e);
    gl.drawArraysInstanced(gl.POINTS, 0, pts.n, 1);
    R.glBindVertexArray(null);
    // The next fill pass rebinds its program, textures and units (the instanced fast path does the same).
    R._handle.fillPassAssetDirty = true;
    if (R._forgetFillUnits) R._forgetFillUnits();
    R._aacPointsDraws = (R._aacPointsDraws | 0) + 1;
    // an AAC draw names its kernel as a fill variant's key does (MANTLE_AAC), so a bench pinned to kernel 'aac' reads it as AAC and one
    // pinned to 'slug' still reads Slug (the exact walk, no MANTLE_AAC)
    R._lastDrawnFillVariantKey = engine === ENGINES.AAC ? P.key + '|MANTLE_AAC' : P.key;
    // what shaded it: the fill walk (the engine the draw asked for; Slug and AAC are the same exact walk) for a fill paint, the stroke
    // pass for a stroke paint -- a stroke-only bundle runs no fill kernel, as the cover route reports it
    if (R._engines) {
      if (s.fills) R._engines.drew(engine, ROUTES.POINTS);
      // A pinned CPatch whose build has not landed drew here: the draw says so, as the cover pass does.
      if (s.fills && R.opts.cpatchFill === true && !R._psoWarming)
        R._engines.declined(
          ENGINES.CPATCH,
          bundle._cpatchBuilt ? DECLINE.UNSUPPORTED : DECLINE.PENDING,
        );
      if (s.strokes) R._engines.drew(ENGINES.STROKE, ROUTES.POINTS);
    }
    if (R._drawDebugOverlays) R._drawDebugOverlays(bundle, true);
  }

  /// Points ahead of the analytic route. In 'off' and 'auto' the point route is asked before the analytic LB unified
  /// draw: where its size gate and depth/point budget say the exact walk wins it draws the whole bundle (every row, LB rows and primitives
  /// included); where they do not, or it declines, the analytic route draws as before. 'on' / 'only' (setLoopBlinnFill) ask for the
  /// analytic route and keep it. A lone primitive, or a few among few other rows, keeps its SDF record (sdf@unified).
  function aacPointsFirst(bundle, meshDraw) {
    if (!bundle || !R._lbSlugFallback) return false;
    // Legacy cpatchFill is an explicit route request too, even with LB still in auto.
    // Keep points as its fallback while preparation warms, without letting the
    // size gate permanently preempt a ready CPatch mesh (including under cpatchAuto).
    if (R.opts.cpatchFill === true || (R.opts.cpatchAuto === true && (bundle._cpatchBuilt | 0) > 0))
      return false;
    if (R._lbFillMode === 'on') return false; // the analytic route was ASKED for (setLoopBlinnFill 'on' / 'only'): it draws
    {
      // In 'auto' the point route is asked before the analytic LB unified draw. A mesh's presence is not a reason to decline:
      // the points paint every row, LB rows included, by the exact walk. A drawing of a few tagged primitives and nothing else
      // keeps its SDF record (sdf@unified); a sheet of primitives, or any drawing with other rows, is the points'.
      const ms = bundle._lbMeshes;
      const numShapes = bundle.numShapes | 0;
      if (ms && numShapes < AAC_POINTS_LONE_PRIM_MAX) {
        let primCount = 0;
        for (let i = 0; i < ms.length; i++) if (ms[i] && ms[i].prim) primCount++;
        if (keepsSdfRecord(numShapes, primCount, true)) return false;
      }
    }
    return aacPointsRoute(bundle, true, meshDraw);
  }

  /// START THE POINT PROGRAM AT LOAD, NOT AT THE FIRST DRAW (`aacPointsPrewarm`: on where the driver compiles in parallel, opt-in otherwise;
  /// with the extension only the link is started, never waited for). The
  /// stroked program is the largest the renderer links, and a draw that finds it unfinished waits for it, so without this the first small
  /// stroked draw pays the whole stall. Called from prepareBundle and
  /// prewarmBundle: the axis-aligned variant for the bundle's layout and paints, the one a plain draw takes; a rotated draw's
  /// variant still links at its first draw. A bundle the route can never take links nothing.
  function aacPointsWarm(bundle) {
    // Where the driver compiles in parallel, starting the link costs the main thread nothing, so it is started by default.
    const wanted =
      R.opts.aacPointsPrewarm === undefined ? !!R._khrParallel : !!R.opts.aacPointsPrewarm;
    if (R.opts.coverSet === true) return; // the loading call plans the scene's point programs as a cover set
    if (!wanted || !bundle || R._contextLost || R.opts.aacPoints === false) return;
    const src = R.shaderSources;
    if (!src || !src.aacPointsVert || !src.aacPointsFrag) return;
    if (
      bundle._geomGen ||
      bundle._morphSrc ||
      bundle._incStroke ||
      bundle._lbStream ||
      bundle._nineSliceActive
    )
      return;
    const s = shapesFor(bundle);
    if (s) {
      programFor(
        !!bundle.pairBands,
        false,
        s.strokes,
        typesOf(bundle),
        s.clips,
        s.grads,
        s.masks,
        s.pats,
        !s.clips && !s.masks && !s.pats && monotoneCubicDrawEligible(bundle, R.draw),
        true,
      );
    }
  }

  /// THE EFFECTIVE POLICY OF THE ROW GATE AND E_MIN, as this renderer reads it now (option or default). Every one is a renderer option and
  /// can be given at creation or changed through R.opts; `null` in an option means the default shown here.
  R.getFillPolicyOptions = () => ({
    aacPointsRowGate: R.opts.aacPointsRowGate !== false,
    aacPointsColorMatrix: R.opts.aacPointsColorMatrix !== false, // paint a draw's colorMatrix on points (false: it keeps the cover route)
    aacPointsBucket: R.opts.aacPointsBucket !== false, // bucketed point lists for an animated drawing (false: exact lists)
    aacPointsExtMax: R.opts.aacPointsExtMax != null ? +R.opts.aacPointsExtMax : AAC_POINTS_EXT_MAX,
    aacCoverExtMin: R.opts.aacCoverExtMin != null ? +R.opts.aacCoverExtMin : AAC_COVER_EXT_MIN,
    aacCoverExtMax: R.opts.aacCoverExtMax != null ? +R.opts.aacCoverExtMax : AAC_COVER_EXT_MAX,
    aacPointsBytesBudget:
      R.opts.aacPointsBytesBudget != null ? +R.opts.aacPointsBytesBudget : AAC_POINTS_BYTES_BUDGET,
    aacPointsRunsMax:
      R.opts.aacPointsRunsMax != null ? +R.opts.aacPointsRunsMax : AAC_POINTS_RUNS_MAX,
    aacPointsRowsMin:
      R.opts.aacPointsRowsMin != null ? +R.opts.aacPointsRowsMin : AAC_POINTS_ROWS_MIN,
    aacPointsBase: R.opts.aacPointsBase != null ? +R.opts.aacPointsBase : AAC_POINTS_BASE,
    aacPointsDepthGain:
      R.opts.aacPointsDepthGain != null ? +R.opts.aacPointsDepthGain : AAC_POINTS_DEPTH_GAIN,
    aacPointsMaxPoints:
      R.opts.aacPointsMaxPoints != null ? +R.opts.aacPointsMaxPoints : AAC_POINTS_MAX_POINTS,
    lbMinExtentPx: R.opts.lbMinExtentPx != null ? +R.opts.lbMinExtentPx : LB_MIN_EXTENT_PX,
    lbMinExtentShare:
      R.opts.lbMinExtentShare != null ? +R.opts.lbMinExtentShare : LB_MIN_EXTENT_SHARE,
    cpatchAuto: R.opts.cpatchAuto === true,
  });
  /// Set (or, with null / undefined, reset to the default) any of the options getFillPolicyOptions names. The patch is validated
  /// whole before any option changes: the flags (aacPointsRowGate, aacPointsColorMatrix, aacPointsBucket, cpatchAuto) take a boolean;
  /// every other option takes a number >= 0 (negatives clamp to 0, Infinity is "no limit"); NaN and any other type THROW. A key
  /// that names no option is ignored with one warning per key.
  const FILL_POLICY_FLAGS = new Set([
    'aacPointsRowGate',
    'aacPointsColorMatrix',
    'aacPointsBucket',
    'cpatchAuto',
  ]);
  const _warnedPolicyKeys = new Set();
  R.setFillPolicyOptions = (patch) => {
    if (!patch || typeof patch !== 'object') return R.getFillPolicyOptions();
    const known = Object.keys(R.getFillPolicyOptions());
    /** @type {Array<[string, number|boolean|undefined]>} */
    const next = [];
    for (const k of known) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v == null) {
        next.push([k, undefined]);
        continue;
      }
      if (FILL_POLICY_FLAGS.has(k)) {
        if (typeof v !== 'boolean')
          throw new Error(
            'setFillPolicyOptions: ' + k + ' must be a boolean, got ' + JSON.stringify(v),
          );
        if (k === 'cpatchAuto' && v === true)
          requireRendererFeature('cpatch', 'setFillPolicyOptions({ cpatchAuto: true })');
        next.push([k, v]);
      } else next.push([k, clampArg('setFillPolicyOptions', k, v, 0, Infinity)]);
    }
    for (const k of Object.keys(patch)) {
      if (!known.includes(k) && !_warnedPolicyKeys.has(k)) {
        _warnedPolicyKeys.add(k);
        R.mantleWarn('setFillPolicyOptions: unknown option "' + k + '" ignored');
      }
    }
    for (const [k, v] of next) {
      if (v === undefined) delete R.opts[k];
      else R.opts[k] = v;
    }
    return R.getFillPolicyOptions();
  };
  R._aacPointsRoute = aacPointsRoute;
  R._aacPointsWarm = aacPointsWarm;
  /// Finish every point program whose link was started (the explicit loading call: its wait belongs behind the load screen).
  /// `soft`: finish only the programs that are ready (gpuGate.js), answering how many still link; no query touches the others.
  R._finishPointPrograms = (soft) => {
    let pending = 0;
    for (const [key, rec] of [...progs]) {
      if (!rec || !rec.pending) continue;
      if (soft && R._khrParallel && !R._programReady(rec.p)) {
        pending++;
        continue;
      }
      finishProgram(key, rec);
    }
    return pending;
  };
  R._aacPointsFirst = aacPointsFirst;
}

const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
