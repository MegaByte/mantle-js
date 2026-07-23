// fillPass.js — Slug coverage fill-pass setup (beginFillPass / endFillPass /
// fill variants). Attached onto the renderer context after shader programs.

import { inspect, Features } from '../bundle/featureSet.js';
import { enqueueFillPrewarm, takeFillPrewarm } from './bundle.js';
import { meanShapePx2 as sharedMeanShapePx2, minLinearScalePx } from './shapeScale.js';
import { fillOmitDefines } from '../shaders/index.js';
import { diagFlags } from '../core/diagnostics.js';

// Fill content-features that are BAKED into the bundle geometry/tables, so a
// bundle that lacks one can compile it out of its shader variant. recolor and
// extclip are deliberately absent: they are PER-DRAW state (any bundle can turn
// them on via drawBundle options / setNodeClip), so omitting them would silently
// drop a feature a later draw enables. Names match FILL_FEATURES / featureSet.
/** @type {[string, bigint][]} */
const BAKED_FILL_FEATURES = [
  ['gradient', Features.Gradients],
  ['clip',     Features.Clips],
  ['mask',     Features.Masks],
  ['filter',   Features.Filters],
  ['stroke',   Features.Strokes],
  ['pattern',  Features.VectorPattern],
  ['image',    Features.Images],
];

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFillPass(R) {
  const { gl, viewportSize, arScale, dummyDashTex, dummyGradientTex, dummyGradientStops,
          IDENTITY_COLOR_MATRIX, ZERO_OFFSET } = R;

  // Fill-unit (TEXTURE0..7) bind dedup. The asset block re-binds ~8 textures every draw,
  // but the dummy dash/grad/image/filter textures are IDENTICAL across consecutive solid
  // bundles, so most binds repeat what the unit already holds. R._fpU[unit] shadows what
  // THIS helper last bound; R._fpUValid says the shadow is trustworthy — it is cleared by
  // every OTHER pass that binds units 0..7 (mask/filter/image/cache/stroke/LB), so a stale
  // skip is impossible. NO global gl wrapping (that broke AAC under SwiftShader). AAC is a
  // fill VARIANT sharing these textures, so the sampler-location uniforms (set every block)
  // carry the program switch while the identical texture binds are skipped.
  R._fpU = new Array(8).fill(null);
  R._fpUValid = false;
  const bindFillTex = (unit, tex) => {
    if (R._fpUValid && R._fpU[unit] === tex) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    R._fpU[unit] = tex;
  };

  // Reused scratch for variant-cache keys (avoids per-draw slice+sort alloc).
  const _defKeyBuf = [];
  function definesKey(defines) {
    if (!defines || !defines.length) return '';
    _defKeyBuf.length = 0;
    for (let i = 0; i < defines.length; i++) _defKeyBuf.push(defines[i]);
    _defKeyBuf.sort();
    return _defKeyBuf.join('|');
  }

  // Resolve every fill uniform location for one program variant. Keyed by the
  // exact local names beginFillPass uses, so the pass body destructures the
  // active variant's table (`const { ... } = variant.u`) and stays unchanged.
  function captureFillUniforms(prog) {
    return {
      uCurveLoc:              gl.getUniformLocation(prog, 'uCurveData'),
      uBandLoc:               gl.getUniformLocation(prog, 'uBandData'),
      uMetaLoc:               gl.getUniformLocation(prog, 'uMetaTex'),
      uDashLoc:               gl.getUniformLocation(prog, 'uDashTex'),
      uGBB:                   gl.getUniformLocation(prog, 'uGlobalBBox'),
      uShapeIdxOverride:      gl.getUniformLocation(prog, 'uShapeIdxOverride'),
      uFillNumShapes:         gl.getUniformLocation(prog, 'uNumShapes'),
      uFillCanvasAR:          gl.getUniformLocation(prog, 'uCanvasAR'),
      uFillViewportSize:      gl.getUniformLocation(prog, 'uViewportSize'),
      uFillFragOrigin:        gl.getUniformLocation(prog, 'uFragOrigin'),
      uFillGradTex:           gl.getUniformLocation(prog, 'uGradientTex'),
      uFillGradStops:         gl.getUniformLocation(prog, 'uGradientStops'),
      uFillGradStopsCount:    gl.getUniformLocation(prog, 'uGradientStopsCount'),
      uFillGradCount:         gl.getUniformLocation(prog, 'uGradientCount'),
      uFillImageTex:          gl.getUniformLocation(prog, 'uImageTex'),
      uFillImageAtlasSize:    gl.getUniformLocation(prog, 'uImageAtlasSize'),
      uFillFilterTex:         gl.getUniformLocation(prog, 'uFilterTex'),
      uFillOverrideTex:       gl.getUniformLocation(prog, 'uOverrideTex'),
      uFillHasOverrides:      gl.getUniformLocation(prog, 'uHasOverrides'),
      uFillHasEmCoord:        gl.getUniformLocation(prog, 'uHasEmCoord'),
      uFillDrawAlpha:         gl.getUniformLocation(prog, 'uDrawAlpha'),
      uFillColorMatrix:       gl.getUniformLocation(prog, 'uColorMatrix'),
      uFillColorMatrixOffset: gl.getUniformLocation(prog, 'uColorMatrixOffset'),
      uFillColorMatrixEnabled:gl.getUniformLocation(prog, 'uColorMatrixEnabled'),
      uFillExtClipTex:        gl.getUniformLocation(prog, 'uExtClipTex'),
      uFillExtClipMode:       gl.getUniformLocation(prog, 'uExtClipMode'),
      uFillChLerpPrimary:     gl.getUniformLocation(prog, 'uChannelLerpPrimary'),
      uFillChLerpContrast:    gl.getUniformLocation(prog, 'uChannelLerpContrast'),
      uFillChLerpHighlight:   gl.getUniformLocation(prog, 'uChannelLerpHighlight'),
      uFillChLerpEnabled:     gl.getUniformLocation(prog, 'uChannelLerpEnabled'),
      uFillPalette:           gl.getUniformLocation(prog, 'uPalette'),
      uFillPaletteEnabled:    gl.getUniformLocation(prog, 'uPaletteEnabled'),
      uFillPaletteChannel:    gl.getUniformLocation(prog, 'uPaletteChannel'),
      uFillPaletteSize:       gl.getUniformLocation(prog, 'uPaletteSize'),
      uFillWorldM:            gl.getUniformLocation(prog, 'uWorldM'),
      uFillHasWorldM:         gl.getUniformLocation(prog, 'uHasWorldM'),
      uFillMaskRTArray:       gl.getUniformLocation(prog, 'uMaskRTArray'),
      uFillMaskRowToLayerTex: gl.getUniformLocation(prog, 'uMaskRowToLayerTex'),
      uFillHasOffscreenMask:  gl.getUniformLocation(prog, 'uHasOffscreenMask'),
      uFillHasOccupancy:      gl.getUniformLocation(prog, 'uHasOccupancy'),
    };
  }

  // PER-BUNDLE SHADER SPECIALIZATION. A bundle that uses only a subset of the
  // fill features compiles (once, lazily) a leaner program with the unused
  // features' `#ifndef MANTLE_NO_<FEAT>` blocks stripped — fewer samplers +
  // uniforms and less per-fragment branching (measured 1.8–2.6× on solid
  // content vs the full ubershader). Output is byte-identical: an omitted
  // feature's branch is exactly the one this bundle's draws would never enter.
  // Cache is keyed by the sorted omit-define string; the default (full) program
  // registers under its own key so full-feature bundles reuse it (no recompile).
  const variantCache = new Map();
  const defaultKey = (R.opts.fillDefines || []).slice().sort().join('|');
  const _psoWarmQueue = [];        // bundles whose Metal pipeline-state to build at load (fill-only warm)
  let _psoWarmHead = 0;
  let _auxProgQueue = null;        // one-time queue of aux-program compile thunks (morph/instanced), prewarmed at load
  let _auxProgHead = 0;
  const aacBaseKey = (R.opts.fillDefines || []).concat(['MANTLE_AAC']).slice().sort().join('|');
  // The universal (all-feature) fallback. psoReady:true — it is what a lean
  // variant falls back to until its own pipeline is warmed, so it is always
  // usable; its one-time pipeline compile lands on the first fill draw (behind
  // the load screen), then every draw reuses it → no per-variant stalls.
  variantCache.set(defaultKey, { prog: R.fillProg, u: captureFillUniforms(R.fillProg), psoReady: true });

  // The BAKED omit-features a bundle can strip (cached on the bundle): every
  // baked feature it lacks. null = inspection unavailable → strip nothing baked.
  function bakedOmitFor(bundle) {
    if (bundle._fillBakedOmit !== undefined) return bundle._fillBakedOmit;
    let bits = null;
    try { bits = inspect(bundle); } catch { bits = null; }
    let omit = null;
    if (bits != null) {
      omit = [];
      for (const [name, bit] of BAKED_FILL_FEATURES) if ((bits & bit) === 0n) omit.push(name);
    }
    return (bundle._fillBakedOmit = omit);
  }
  // Identity matrices, zero offsets, and absent palette textures do not activate
  // the recolor path.
  function _isIdentityCm(m) {
    if (!m) return true;
    for (let i = 0; i < 16; i++) {
      const want = (i % 5 === 0) ? 1 : 0;      // diagonal
      if (Math.abs(m[i] - want) > 1e-6) return false;
    }
    return true;
  }
  function _isZeroOff(o) {
    if (!o) return true;
    for (let i = 0; i < 4; i++) if (Math.abs(o[i]) > 1e-6) return false;
    return true;
  }
  function drawUsesRecolor() {
    const d = R.draw;
    return !!(d.channelLerp || (d.palette && d.palette.texture)
      || !_isIdentityCm(d.colorMatrix) || !_isZeroOff(d.colorMatrixOffset));
  }

  // AAC selection uses device-space area per shape and a threshold for each
  // curve type. The area includes the full bundle-to-pixel transform; local
  // bbox area alone would misclassify scaled text and animated geometry.
  // Thresholds are per curve type and mixed bundles take the maximum. Do not
  // use px²/segment here: segment count and fragment count both increase Slug's
  // work, so dividing one by the other loses the useful signal, especially for arcs.
  const AAC_MIN_PX2 = [
    512,                      // line
    2e5,                      // quadratic
    3e3,                      // cubic
    Number.POSITIVE_INFINITY, // arc
  ];

  const meanShapePx2 = (bundle) => sharedMeanShapePx2(R, bundle);

  // Small shapes stay on Slug because AAC's larger fragment kernel cannot be
  // amortized. Unknown geometry also resolves to Slug.
  function preferAac(bundle) {
    // A V-less bundle (engine:'aac' pinned at import) has one V band holding every
    // segment; Slug's vertical ray would walk all of them, per fragment. Never
    // route it to Slug, whatever its size.
    if (bundle && bundle.noVBands) {
      R._autoMeanShapePx2 = meanShapePx2(bundle);
      R._autoSegsPerShape = bundle.meanSegsPerShape || 0;
      R._autoPx2PerSeg = R._autoSegsPerShape ? R._autoMeanShapePx2 / R._autoSegsPerShape : R._autoMeanShapePx2;
      R._autoEngine = 'aac';
      return true;
    }
    const px2 = meanShapePx2(bundle);
    const mask = (bundle && bundle.segTypeMask) || 0xF;
    let need = 0;
    for (let t = 0; t < 4; t++) if (mask & (1 << t)) need = Math.max(need, AAC_MIN_PX2[t]);
    const pick = px2 >= need;
    R._autoMeanShapePx2 = px2;
    R._autoSegsPerShape = (bundle && bundle.meanSegsPerShape) || 0;
    R._autoPx2PerSeg = R._autoSegsPerShape ? px2 / R._autoSegsPerShape : px2;                   // surfaced via renderer.debugStats
    R._autoEngine = pick ? 'aac' : 'slug';
    return pick;
  }

  // Opaque covering strokes can hide the fill's AA fringe. The importer proves
  // static eligibility; draw-time state and minimum device stroke width complete
  // the proof. Cubic/arc fills use the winding tree, while line/quad fills use
  // band crossings.
  const NOAA_MIN_PX2 = 2e3;
  // band-hard walks every band segment with no spatial prune, and its per-cubic CROSSING solve
  // (hardCrossCubic) is pricier than AAC's per-cubic area — so on cubic/arc it beats AAC only at
  // LOW segment counts, and the crossover DROPS with scale as more fragments amplify the per-seg
  // gap (probes/_bhVsAac: band-hard wins ≤24 segs @1024 but only ≤8 @2048). 12 is the value that
  // stays a win across the tested scales; above it, AAC. (Static cubic/arc no-AA bundles route
  // tree-hard — spatial prune — instead; they carry the GWN tree, so they never hit this gate.)
  const NOAA_BANDHARD_MAX_SEGS = 12;
  function preferNoAa(bundle) {
    if (R.opts.aacFill !== 'auto') return false;         // only the auto path routes no-AA
    if (!bundle || !bundle.noAaFill) return false;        // not all fills are stroke-covered
    if (R.draw.overrides || R.draw.alpha < 0.996 || drawUsesRecolor()) return false;
    const mask = bundle.segTypeMask || 0xF;
    // cubic/arc: tree-hard (needs the GWN tree, bundle.noAaTree) beats band-hard when it's baked.
    // Without the tree (e.g. a MORPH — the tree is too costly to rebuild per frame) band-hard is
    // the only no-AA option, and it beats AAC only below NOAA_BANDHARD_MAX_SEGS; above that, AA.
    if ((mask & ((1 << 2) | (1 << 3))) && !bundle.noAaTree
        && (bundle.meanSegsPerShape || 0) > NOAA_BANDHARD_MAX_SEGS) return false;
    const px2 = meanShapePx2(bundle);
    if (px2 < NOAA_MIN_PX2) return false;                 // too small — AA already cheap
    if ((bundle.minStrokeEmW || 0) * minLinearScalePx(R, bundle) < 2) return false;
    return true;
  }
  // Let the static LB gate prefer this cheaper route when its proof holds.
  R._preferNoAa = preferNoAa;

  /// The extra FRAGMENT defines the instanced fast path should compile for a bundle — Slug (none)
  /// or AAC. Same size gate as the non-instanced path (preferAac), so a large bundle instanced N
  /// times gets AAC's per-fragment win multiplied across all N. (no-AA is Slug/AAC-only here: it
  /// needs an opaque covering stroke, which the fill-only instanced fast path doesn't draw.)
  function instancedEngineDefines(bundle) {
    const wantAac = (R.opts.aacFill === 'auto') ? preferAac(bundle) : !!R.opts.aacFill;
    if (!wantAac) return [];
    const defs = ['MANTLE_AAC'];
    if (bundle && bundle.pairBands) defs.push('MANTLE_AAC_PAIR_BANDS');
    return defs;
  }
  R._instancedEngineDefines = instancedEngineDefines;

  /// Start compiling the fill variants this bundle may use. Safe to call repeatedly.
  ///
  /// Only creates the program; the link status is polled later by selectFillVariant, which
  /// keeps drawing with the un-specialized base until it is ready. With no
  /// KHR_parallel_shader_compile there is nothing to poll, so this just moves the same stall
  /// earlier — which is still the right place for it (load, not first frame).
  function prewarmFillVariant(bundle) {
    if (R.opts.disableFillVariants) return;
    // A disposed bundle — or a spent transplant shell (textBundle.setText) — owns no GL
    // objects. Warming it compiles variants for content that no longer exists, and the
    // PSO warm below would bind its dead textures.
    if (!bundle || bundle._disposed) return;
    try {
      for (const eng of variantEnginesFor(bundle)) {
        const defines = variantDefinesFor(bundle, eng.aac, eng.noAa);
        const key = defines.slice().sort().join('|');
        if (variantCache.has(key)) continue;
        const prog = R.program(R.shaderSources.fillVert,
          R.withDefines(R.shaderSources.fillFrag, defines),
          'fill:prewarm:' + (key || 'full'));
        variantCache.set(key, { prog, u: null, pending: true, psoReady: false });
      }
    } catch { /* prewarm is best-effort: a failure just means the draw path compiles it */ }
  }

  /// Which engines might this bundle be drawn with? `aacFill:'auto'` decides per draw from the
  /// on-screen size, which load time cannot know — so prewarm all candidates and let the draw pick.
  function variantEnginesFor(bundle) {
    if (R.opts.aacFill === 'auto') {
      const out = (bundle && bundle.noVBands) ? [{ aac: true }] : [{ aac: false }, { aac: true }];
      if (bundle && bundle.noAaFill) out.push({ aac: false, noAa: true });   // band-hard candidate
      return out;
    }
    return [{ aac: !!R.opts.aacFill }];
  }

  /// Shared define selection for draw and prewarm. External clipping remains compiled
  /// because it is per-draw state. The three recolor operations are independent; omit
  /// inactive ones so matrix-only draws do not carry palette and channel-lerp code.
  /// The full program remains the immediate fallback while a lazy variant warms.
  function variantDefinesFor(bundle, useAac, useNoAa) {
    const baked = bakedOmitFor(bundle);
    // Mutate a fresh array only when baking; otherwise start empty (no slice).
    const omit = baked ? baked.slice() : [];
    let defines = fillOmitDefines(omit);
    const optDefs = R.opts.fillDefines;
    if (optDefs) for (let i = 0; i < optDefs.length; i++) {
      const d = optDefs[i];
      if (!defines.includes(d)) defines.push(d);
    }
    const noRecolor = !drawUsesRecolor();
    if (noRecolor) {
      if (!defines.includes('MANTLE_NO_RECOLOR')) defines.push('MANTLE_NO_RECOLOR');
    } else {
      if (!R.draw.channelLerp && !defines.includes('MANTLE_NO_CHANNEL_LERP'))
        defines.push('MANTLE_NO_CHANNEL_LERP');
      if (!(R.draw.palette && R.draw.palette.texture) && !defines.includes('MANTLE_NO_PALETTE'))
        defines.push('MANTLE_NO_PALETTE');
      if (_isIdentityCm(R.draw.colorMatrix) && _isZeroOff(R.draw.colorMatrixOffset)
          && !defines.includes('MANTLE_NO_COLOR_MATRIX'))
        defines.push('MANTLE_NO_COLOR_MATRIX');
    }
    // A GWN kernel walks the run tree the IMPORTER bakes. Ask for the kernel without asking
    // for the tree and it reads a header that was never written: the shader renders nothing,
    // silently, and a blank canvas gives you no way to find that out. Say it once, per bundle.
    // (MANTLE_HARD without MANTLE_HARD_TREE is the BAND walk — MANTLE_GWN only rides along to
    // compile the kernel in, and it needs no tree. Don't warn about that one.)
    const _fd = R.opts.fillDefines || [];
    const _needsTree = _fd.includes('MANTLE_HARD_TREE')
      || (_fd.includes('MANTLE_GWN') && !_fd.includes('MANTLE_HARD'));
    if (bundle && !bundle.gwnTree && !bundle._gwnWarned && _needsTree) {
      bundle._gwnWarned = true;
      console.warn('[mantle] this renderer compiles a GWN fill kernel, but the bundle has no GWN '
        + 'run tree and will render EMPTY. Import it with importSvg(svg, { gwnTree: true }).');
    }
    // no-AA band-hard: MANTLE_HARD selects renderFillHardBand (it precedes every other
    // coverage branch in the frag #if chain, so MANTLE_GWN here is inert — kept to match
    // the validated config). Mutually exclusive with MANTLE_AAC.
    if (useNoAa) {
      if (!defines.includes('MANTLE_HARD')) defines.push('MANTLE_HARD');
      // cubic/arc tree-hard: the GWN run tree (baked at build) walks winding-only; MANTLE_HARD_TREE
      // selects renderFillGWNSDF over renderFillHardBand. Band-hard (line/quad) omits it.
      if (bundle && bundle.noAaTree && !defines.includes('MANTLE_HARD_TREE')) defines.push('MANTLE_HARD_TREE');
      if (!defines.includes('MANTLE_GWN')) defines.push('MANTLE_GWN');
    }
    if (useAac && !useNoAa && !defines.includes('MANTLE_AAC')) defines.push('MANTLE_AAC');
    if (useAac && bundle && bundle.pairBands && !defines.includes('MANTLE_AAC_PAIR_BANDS'))
      defines.push('MANTLE_AAC_PAIR_BANDS');
    const tm = R.opts.typeOmit ? ((bundle && bundle.segTypeMask) || 0xF) : 0xF;
    const TYPE_DEFS = ['MANTLE_NO_LINE', 'MANTLE_NO_QUAD', 'MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'];
    for (let t = 0; t < 4; t++)
      if (!(tm & (1 << t)) && !defines.includes(TYPE_DEFS[t])) defines.push(TYPE_DEFS[t]);
    return defines;
  }
  function selectFillVariant(bundle) {
    // Escape hatch: force the single default program (no per-bundle/per-draw
    // specialization). For deterministic baselines (byte-identity tests) and
    // debugging.
    if (R.opts.disableFillVariants) return variantCache.get(defaultKey);
    // No-AA band-hard wins over AA when the fill is opaque-stroke-covered (draw-time gate).
    const useNoAa = preferNoAa(bundle);
    const useAac = useNoAa ? false
      : (R.opts.aacFill === 'auto') ? preferAac(bundle) : !!R.opts.aacFill;
    if (useNoAa) R._autoEngine = bundle.noAaTree ? 'noaa-tree' : 'noaa-band';
    const defines = variantDefinesFor(bundle, useAac, useNoAa);
    const key = definesKey(defines);
    let v = variantCache.get(key);
    if (!v) {
      // Start specialization without blocking. The base variant is a strict
      // functional superset and remains usable while linking completes.
      R._variantCompiles = (R._variantCompiles || 0) + 1;
      const prog = _traceStall(`fill-variant compile MID-DRAW [${key || 'full'}]`, () =>
        R.program(R.shaderSources.fillVert,
          R.withDefines(R.shaderSources.fillFrag, defines), 'fill:' + (key || 'full')));
      v = { prog, u: null, pending: true, psoReady: false };
      variantCache.set(key, v);
    }
    if (v.pending) {
      const khr = R._khrParallel;
      if (khr) R._variantPolls = (R._variantPolls || 0) + 1;
      const done = khr ? gl.getProgramParameter(v.prog, khr.COMPLETION_STATUS_KHR) : true;
      if (!done) return baseVariant(useAac);   // still linking: draw with the un-specialized base
      // Promote here as well as in the warm tick so a completed variant does not
      // remain pending until the next scheduler pass.
      if (!promote(key, v)) return baseVariant(useAac);
    }
    // Progressive specialization: a lean variant is USED only once its Metal
    // pipeline is ALSO warmed (built off the critical path in _warmBundlePso during
    // frame-slack). Until then draw with the pipeline-warm universal — so a real
    // draw NEVER compiles a pipeline and content appearing mid-scene can't stall.
    // R._psoWarming bypasses this so the warm draw itself can build the pipeline.
    if (!v.psoReady && !R._psoWarming) return baseVariant(useAac);
    return v;
  }

  /// Validate a linked variant and capture its uniforms. Only this program is checked:
  /// finalizeShaderCompiles() reads LINK_STATUS on EVERY pending program, and reading it is what
  /// FORCES a link — one finished variant would force all the others still compiling.
  function promote(key, v) {
    // The LINK_STATUS read inside is what blocks until the driver has finished.
    if (!diagFlags.stallMs) return _promote(key, v);
    return _traceStall(`shader LINK [${key || 'full'}]`, () => _promote(key, v));
  }
  function _promote(key, v) {
    dropPending(v.prog);
    if (!gl.getProgramParameter(v.prog, gl.LINK_STATUS)) {
      R.mantleError('link failed (fill variant):', gl.getProgramInfoLog(v.prog));
      variantCache.delete(key);
      return false;
    }
    v.u = captureFillUniforms(v.prog);
    v.pending = false;
    return true;
  }

  // The program a specialized variant draws with while it still links is its AAC BASE, not the
  // Slug default: the specialized variants differ from their base only by omit-defines (which
  // strip kernels the bundle never uses), so the base is a strict superset and the picture is
  // identical. Substituting Slug for a pending AAC variant silently swaps the engine for a few
  // frames — near-identical now that both are exact, but not identical, and the AAC-referenced
  // LB gates caught it.
  //
  // Before the AAC base has linked, use Slug briefly rather than blocking; load-time
  // prewarm starts the base link and the KHR poll promotes it asynchronously.
  /// Take a program out of the global pending queue, so finalizeShaderCompiles()/`renderer.ready`
  /// neither re-checks it nor blocks on the others.
  function dropPending(prog) {
    const pp = R._pendingPrograms;
    if (pp) for (let i = pp.length - 1; i >= 0; i--) if (pp[i].prog === prog) pp.splice(i, 1);
  }

  function baseVariant(useAac) {
    if (!useAac) return variantCache.get(defaultKey);
    let b = variantCache.get(aacBaseKey);
    if (!b) {
      // Start the compile without reading LINK_STATUS, which can block the main
      // thread. Use the Slug default until the async link completes.
      const defs = (R.opts.fillDefines || []).concat(['MANTLE_AAC']);
      const prog = R.program(R.shaderSources.fillVert,
        R.withDefines(R.shaderSources.fillFrag, defs), 'fill:aac-base');
      variantCache.set(aacBaseKey, { prog, u: null, pending: true, psoReady: true });
      return variantCache.get(defaultKey);
    }
    if (b.pending) {
      // Prewarmed at load: promote only once its async link is CONFIRMED done via the
      // KHR poll (non-blocking). Without KHR, or while still linking, draw the Slug
      // default this frame — the load-time promote loop finishes the link. Never read
      // LINK_STATUS here: that is the synchronous ~1s block we are removing.
      const khr = R._khrParallel;
      if (!khr || !gl.getProgramParameter(b.prog, khr.COMPLETION_STATUS_KHR) || !promote(aacBaseKey, b))
        return variantCache.get(defaultKey);
    }
    return b;
  }

  /// Per-frame tick: start the compile of variants for bundles that have just been created, and
  /// promote (validate + capture uniforms) at most one whose link has completed. Runs once per
  /// frame BEFORE any geometry is bound, so promotion never lands in the middle of a fill pass.
  ///
  /// It also builds the driver pipeline state with a one-pixel scissored draw on
  /// the default framebuffer. Default and texture framebuffers can use different
  /// pipelines, so an offscreen warm would not prepare the canvas path. Disable
  /// with `psoWarm:false`.

  // Stall tracer. setDiagnostics({ stallMs: N }) — any mantle-side op that
  // blocks the main thread ≥ N ms logs what it was. Off by default: _traceStall
  // is a single number compare + direct call when disabled.
  function _traceStall(what, fn) {
    const thr = diagFlags.stallMs;
    if (!thr) return fn();
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const r = fn();
    const d = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (d >= thr) console.warn(`[mantle] STALL ${d.toFixed(0)}ms — ${what}`);
    return r;
  }
  R._traceStall = _traceStall;

  function _warmBundlePso(bundle) {
    if (R._captureFrames || fillPassActive || !bundle || bundle._disposed || !bundle.curveTex) return;
    const [cw, ch] = viewportSize();
    if (!(cw > 0 && ch > 0)) return;                       // canvas not sized yet — try again next frame
    // Use renderer-shadowed state because driver state queries may flush the GPU.
    const savedFbo = R._boundDrawFbo || null;
    const savedCl = R.draw.channelLerp;
    R.setBundle(bundle);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);              // default FB = the real draw target (canvas PSO)
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);    // 1px, nothing visible; scissor not baked into the PSO
    // Warm mode: selectFillVariant returns the ACTUAL lean variant (bypassing the
    // psoReady gate) so this warm draw builds ITS pipeline; then mark it usable, so
    // the next real draw of this content upgrades off the universal with no stall.
    R._psoWarming = true;
    const warm1 = () => {
      // Cover VAO must hold ≥6 verts (one cover quad). Empty / lightweight
      // bundles never uploaded triBuf — drawing 6 against a 0-byte VBO is
      // exactly `Vertex buffer is not big enough`.
      if (!R._handle || ((R._handle.coverVertCount | 0) < 6)) return;
      beginFillPass(); gl.drawArrays(gl.TRIANGLES, 0, 6); endFillPass();
      if (R._lastFillVariant) R._lastFillVariant.psoReady = true;
    };
    // ONE warm. The bundle's variant already IS its recolour variant (or isn't), so the
    // pipeline this builds is the pipeline its draws will use. There is no second program
    // to warm, and nothing left to discover mid-play.
    R.draw.channelLerp = null;
    _traceStall('pipeline warm', warm1);
    R._psoWarming = false;
    R.draw.channelLerp = savedCl;
    // bindFb restores the scissor for us when a user scissor is set; when there is
    // none it leaves SCISSOR_TEST alone, and we enabled it above, so turn it off.
    R.bindFb(gl.FRAMEBUFFER, savedFbo);
    if (!R._scissor) gl.disable(gl.SCISSOR_TEST);
    R._lastFillPassHandle = null; R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;   // next real draw rebinds
  }
  // Frame-slack gate for pipeline warming. A PSO warm is a synchronous main-thread
  // block; only spend it when recent frames are healthy, so it never turns a busy
  // frame (e.g. a scene transition) into a jank spike. Under load, warms defer and
  // content keeps drawing on the pipeline-warm universal — priority: no stalls > fps.
  // Games can widen/narrow the window or force-allow via R.opts.psoWarmIdle().
  // A single fast frame is not proof of idleness. Require sustained slack, or let
  // the host provide an authoritative psoWarmIdle callback.
  const PSO_WARM_MAX_FRAME_MS = 20;   // a "slack" frame runs at least this fast
  const PSO_WARM_IDLE_FRAMES  = 45;   // ~0.75s of uninterrupted slack ⇒ genuinely idle
  function _psoWarmAllowed(dtMs) {
    if (typeof R.opts.psoWarmIdle === 'function') { try { return !!R.opts.psoWarmIdle(dtMs); } catch { /* fall through */ } }
    if (typeof document !== 'undefined' && document.hidden) return false;
    return (R._idleFrames | 0) >= PSO_WARM_IDLE_FRAMES;
  }
  function fillWarmTick() {
    if (R._contextLost) return;
    const _now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const _dt = R._lastWarmTickT ? (_now - R._lastWarmTickT) : 16;
    R._lastWarmTickT = _now;
    // Sustained-idle accrual: heavy frame → reset; slack frame → +1.
    R._idleFrames = (_dt > 0 && _dt <= PSO_WARM_MAX_FRAME_MS) ? ((R._idleFrames | 0) + 1) : 0;
    // Bundles enqueue themselves by WebGL context at creation time.
    let budget = 8;
    while (budget-- > 0) {
      const b = takeFillPrewarm(gl);
      if (!b) break;
      prewarmFillVariant(b);
      if (R.opts.psoWarm !== false) _psoWarmQueue.push(b);
    }
    // Promote at most one linked variant per frame, before any geometry is bound.
    const khr = R._khrParallel;
    for (const [key, v] of variantCache) {
      if (!v.pending) continue;
      if (khr) {
        R._variantPolls = (R._variantPolls || 0) + 1;
        if (!gl.getProgramParameter(v.prog, khr.COMPLETION_STATUS_KHR)) continue;
      }
      promote(key, v);
      return;   // one promote/frame; aux + PSO warm below wait until every fill link has settled
    }
    // Warm auxiliary morph and instanced programs after fill variants settle,
    // draining one compile per frame — unless precompileFills already drained them
    // behind the load screen, which is where they belong.
    ensureAuxQueue();
    if (_auxProgHead < _auxProgQueue.length) {
      try { _auxProgQueue[_auxProgHead++](); } catch { /* best-effort */ }
      if (_auxProgHead === _auxProgQueue.length) {
        _auxProgQueue.length = 0;
        _auxProgHead = 0;
      }
      return;
    }
    // Links all settled ⇒ build one bundle's pipeline state this frame (fill-only, off the frame
    // that first shows it). Drains during load; gameplay is untouched once empty.
    if (R.opts.psoWarm !== false && _psoWarmHead < _psoWarmQueue.length && _psoWarmAllowed(_dt)) {
      _warmBundlePso(_psoWarmQueue[_psoWarmHead++]);
      if (_psoWarmHead === _psoWarmQueue.length) {
        _psoWarmQueue.length = 0;
        _psoWarmHead = 0;
      } else if (_psoWarmHead >= 1024 && _psoWarmHead * 2 >= _psoWarmQueue.length) {
        _psoWarmQueue.splice(0, _psoWarmHead);
        _psoWarmHead = 0;
      }
    }
  }

  // The auxiliary programs a scene may reach for AFTER the fill variants: the LB morph
  // pair, the LB coverage fill (clip/mask/filter/stroke morphs) and the instanced Slug
  // fill. Each links SYNCHRONOUSLY inside its own _ensure*, so where they are built is
  // where the stall lands. Built once, then drained either by precompileFills (behind
  // the load screen — the right place) or one per frame by fillWarmTick (the fallback
  // for a consumer that never calls it).
  function ensureAuxQueue() {
    if (_auxProgQueue !== null) return;
    _auxProgQueue = [];
    _auxProgHead = 0;
    if (R._lbFillMode !== 'off') {
      if (R._ensureLbPairProg)    _auxProgQueue.push(() => R._ensureLbPairProg());     // GPU-resident LB morph
      if (R._ensureFillLBCovProg) _auxProgQueue.push(() => R._ensureFillLBCovProg());  // clip/mask/filter/stroke morphs
    }
    if (R._instancedFastEnabled && R._ensureInstProg) {
      _auxProgQueue.push(() => R._ensureInstProg([]));                                  // instanced Slug
      if (R.opts.aacFill) _auxProgQueue.push(() => R._ensureInstProg(['MANTLE_AAC']));  // instanced AAC
    }
    // Compile the AAC base asynchronously during load so pending variants have a
    // compatible fallback without a first-draw link.
    if (R.opts.aacFill && !variantCache.has(aacBaseKey)) _auxProgQueue.push(() => {
      if (variantCache.has(aacBaseKey)) return;
      const prog = R.program(R.shaderSources.fillVert,
        R.withDefines(R.shaderSources.fillFrag, (R.opts.fillDefines || []).concat(['MANTLE_AAC'])), 'fill:aac-base');
      variantCache.set(aacBaseKey, { prog, u: null, pending: true, psoReady: true });
    });
  }

  R.fillWarmTick = fillWarmTick;

  /// Explicit up-front warm of every loaded bundle's fill pipelines. Use this when
  /// gameplay has no idle warm window. Call it behind the loading screen after bundles are
  /// created, before gameplay — to pay the compile + pipeline cost where a pause is
  /// invisible. Blocking by design (that's the point): it force-links every pending
  /// fill program and builds every bundle's Metal pipeline now, so gameplay runs on
  /// the lean variants from frame one with zero mid-play warm stalls. No-op if
  /// psoWarm is disabled. Returns the number of bundles warmed.
  function precompileFills() {
    if (R.opts.psoWarm === false || R._contextLost) return 0;
    // Bundle-level recolor declarations make the required variant known at load.
    // 1) Compile every enqueued bundle's variant programs; queue them for PSO warm.
    let b;
    while ((b = takeFillPrewarm(gl))) { prewarmFillVariant(b); _psoWarmQueue.push(b); }
    // 2) Force-link every pending fill program NOW (promote reads LINK_STATUS, which
    //    blocks until the driver finishes — acceptable behind a load screen).
    for (const [key, v] of variantCache) if (v.pending) promote(key, v);
    // 2b) And the AUXILIARY programs — the LB morph pair, the LB coverage fill, the
    //     instanced Slug fill. fillWarmTick otherwise drains these one per frame, and
    //     each one links synchronously, so the first frames of a scene paid a blocking
    //     link apiece: measured 6.8ms and 5.2ms on frames 1 and 2 of a six-card board.
    //     A game that calls precompileFills has said "stall me HERE"; take it here.
    ensureAuxQueue();
    while (_auxProgHead < _auxProgQueue.length) {
      try { _auxProgQueue[_auxProgHead++](); } catch { /* best-effort */ }
    }
    _auxProgQueue.length = 0;
    _auxProgHead = 0;
    // 3) Build each DISTINCT pipeline, bypassing the idle gate (warm-mode inside
    //    _warmBundlePso marks each lean variant psoReady). A pipeline is per
    //    (variant × blend), NOT per bundle — so warming ONE bundle per distinct
    //    variant covers all bundles that share it. A scrolling-road game can hold
    //    thousands of bundles; warming every one here would freeze at first paint.
    //    Warm until a run of consecutive bundles introduces no new psoReady variant
    //    (all distinct pipelines built), capped so precompile is O(variants).
    // Time-budgeted so it can never stall the load: each pipeline compile is
    // 150-700ms on Metal, and a game may have many distinct variants — warm what
    // fits, and let the rest fall back to the (pipeline-warm) universal at draw
    // time with no stall (they upgrade later during any idle window). Budget
    // overridable via R.opts.precompileFillsBudgetMs.
    const readyCount = () => { let r = 0; for (const v of variantCache.values()) if (v.psoReady) r++; return r; };
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const budget = (R.opts.precompileFillsBudgetMs != null) ? R.opts.precompileFillsBudgetMs : 800;
    const nowMs = () => ((typeof performance !== 'undefined') ? performance.now() : Date.now());
    let n = 0, stale = 0;
    while (_psoWarmHead < _psoWarmQueue.length && stale < 8 && n < 128 && (nowMs() - t0) < budget) {
      const before = readyCount();
      _warmBundlePso(_psoWarmQueue[_psoWarmHead++]);
      n++;
      if (readyCount() > before) stale = 0; else stale++;
    }
    _psoWarmQueue.length = 0;   // remaining bundles share an already-warm pipeline
    _psoWarmHead = 0;
    return n;
  }
  R.precompileFills = precompileFills;

  R.prewarmFillVariant = prewarmFillVariant;

  // Free every specialized fill variant (the default entry aliases R.fillProg,
  // which renderer.dispose() deletes itself). Without this, each bundle's
  // lean variant outlived the renderer.
  R._disposeFillVariants = () => {
    for (const v of variantCache.values()) {
      if (v && v.prog && v.prog !== R.fillProg) R.gl.deleteProgram(v.prog);
    }
    variantCache.clear();
    _psoWarmQueue.length = 0;
    _psoWarmHead = 0;
    if (_auxProgQueue) _auxProgQueue.length = 0;
    _auxProgHead = 0;
  };

  let fillPassActive = false;
  let lastVariantProg = null;   // force a full re-bind when the bound variant changes

  function beginFillPass() {
    if (fillPassActive) {
      // Fill pass already live — still rebind the cover VAO. Nested filter /
      // composite / LB paths often leave VAO=null (or coverVao) without
      // endFillPass; a later flushPending used to skip this bind and draw
      // against the default VAO → "Vertex buffer is not big enough".
      if (R._handle && R._handle.triVao) gl.bindVertexArray(R._handle.triVao);
      return;
    }
    fillPassActive = true;
    // Select this bundle's specialized fill program + its uniform table. The
    // pass body below reads the destructured locals, so it is variant-agnostic.
    const variant = selectFillVariant(R._handle.bundle);
    R._lastFillVariant = variant;   // so _warmBundlePso can mark the warmed pipeline ready
    const {
      uCurveLoc, uBandLoc, uMetaLoc, uDashLoc, uGBB, uShapeIdxOverride,
      uFillNumShapes, uFillCanvasAR, uFillViewportSize, uFillFragOrigin, uFillGradTex,
      uFillGradStops, uFillGradStopsCount, uFillGradCount, uFillImageTex,
      uFillImageAtlasSize, uFillFilterTex, uFillOverrideTex, uFillHasOverrides,
      uFillHasEmCoord, uFillDrawAlpha, uFillColorMatrix, uFillColorMatrixOffset,
      uFillColorMatrixEnabled, uFillExtClipTex, uFillExtClipMode,
      uFillChLerpPrimary, uFillChLerpContrast, uFillChLerpHighlight,
      uFillChLerpEnabled, uFillPalette, uFillPaletteEnabled, uFillPaletteChannel,
      uFillPaletteSize, uFillWorldM, uFillHasWorldM, uFillMaskRTArray,
      uFillMaskRowToLayerTex, uFillHasOffscreenMask, uFillHasOccupancy,
    } = variant.u;
    const [cw, ch] = viewportSize();
    // The fill pass always projects the CANVAS. When the target framebuffer is a
    // rect of it — a filtered shape rendering into an RT covering only itself —
    // the same projection is simply TRANSLATED: a viewport at -rect.origin lands
    // canvas pixel (x,y) on RT texel (x-rx, y-ry). No clip-space math changes.
    // (This owns the viewport: a caller that set its own would have it clobbered
    // here, which is exactly what happened the first time.)
    const _fo = R._fragOrigin;
    gl.viewport(_fo ? -_fo[0] : 0, _fo ? -_fo[1] : 0, cw, ch);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(!R._opaquePrepassActive);
    gl.useProgram(variant.prog);
    // Multi-handle pattern: if the previous fill pass bound
    // textures + uniforms for a DIFFERENT handle, our per-handle
    // fillPassAssetDirty flag isn't enough — the texture units still
    // hold the other handle's bindings, AND the canvas-AR cache
    // below is keyed on (cw, ch) which is bundle-independent, so
    // without an explicit reset different bundles silently inherit
    // the prior handle's `arScale(globalBBox, ...)` result. That's
    // the "dimensions wrong across the board" symptom:
    // mount B's draw uses mount A's scale factor when both have
    // different globalBBox. Force a full re-bind + re-AR-compute.
    // A variant switch (different program) also forces a full re-bind: GL
    // uniform + sampler state is per-program, so the newly-bound variant starts
    // with NONE of the prior program's texture/uGBB/uniform bindings. Same
    // reasoning as the handle-change reset above.
    if (R._lastFillPassHandle !== R._handle || lastVariantProg !== variant.prog) {
      R._handle.fillPassAssetDirty = true;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
      // The palette/extClip OFF-state shadow (below) tracks what THIS program's unit
      // 13/14 + enable uniforms were last set to. A variant switch is a new program with
      // fresh uniform state, so force the next palette/extClip block to run.
      R._fpPalOff = false;
      R._fpClipOff = false;
    }
    lastVariantProg = variant.prog;
    if (R._handle.fillPassAssetDirty) {
      const b = R._handle.bundle;
      // bindFillTex skips the driver bindTexture when the unit already holds that texture
      // (dummy dash/grad/image/filter are identical across solid bundles). Sampler-location
      // uniforms are set unconditionally — they are per-program (an AAC/lean variant switch
      // needs them) and cheap.
      bindFillTex(0, b.curveTex); gl.uniform1i(uCurveLoc, 0);
      bindFillTex(1, b.bandTex);  gl.uniform1i(uBandLoc, 1);
      bindFillTex(2, b.metaTex);  gl.uniform1i(uMetaLoc, 2);
      bindFillTex(3, b.dashTex || dummyDashTex); gl.uniform1i(uDashLoc, 3);
      bindFillTex(4, b.gradientTex || dummyGradientTex); gl.uniform1i(uFillGradTex, 4);
      bindFillTex(5, b.gradientStopsTex || dummyGradientStops); gl.uniform1i(uFillGradStops, 5);
      gl.uniform1i(uFillGradStopsCount, b.gradientStopsCount | 0);
      gl.uniform1i(uFillGradCount, b.gradientCount);
      bindFillTex(6, b.imageAtlasTex || dummyGradientStops); gl.uniform1i(uFillImageTex, 6);
      gl.uniform2f(uFillImageAtlasSize, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
      bindFillTex(7, b.filterTex || dummyGradientTex); gl.uniform1i(uFillFilterTex, 7);
      R._fpUValid = true;   // units 0..7 now match R._fpU — cleared by any other pass that binds them
      gl.uniform4f(uGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      gl.uniform1f(uFillNumShapes, Math.max(1, b.numShapes));
      gl.uniform1i(uShapeIdxOverride, -1);
      // Multi-shape mask offscreen RT. When the bundle has regions and
      // the bake program is bundled, R._maskRTArray was filled by
      // R.bakeMaskRegions() at the top of render(); bind it on TEXTURE9
      // and the row-to-layer lookup on TEXTURE10. Otherwise bind dummy
      // 1×1×1 R8 array + 1×1 R32I textures (WebGL2 validation requires
      // every declared sampler to have a binding).
      gl.activeTexture(gl.TEXTURE9);
      if (R.maskBakeProg && R._handle.maskRegions.length && R._maskRTArray && R._handle.maskRowToLayerTex) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, R._maskRTArray);
        gl.uniform1i(uFillMaskRTArray, 9);
        gl.activeTexture(gl.TEXTURE10);
        gl.bindTexture(gl.TEXTURE_2D, R._handle.maskRowToLayerTex);
        gl.uniform1i(uFillMaskRowToLayerTex, 10);
        gl.uniform1i(uFillHasOffscreenMask, 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, R.maskRTDummy());
        gl.uniform1i(uFillMaskRTArray, 9);
        gl.activeTexture(gl.TEXTURE10);
        gl.bindTexture(gl.TEXTURE_2D, R.maskRowToLayerDummy());
        gl.uniform1i(uFillMaskRowToLayerTex, 10);
        gl.uniform1i(uFillHasOffscreenMask, 0);
      }
      // Interior-skip occupancy is a per-bundle property (opt-in importer
      // grids). Coherent uniform → the fill shader's occupancy branch is free
      // on bundles without it.
      const occOff = R.mantleDebugFlag('noOccupancy');
      gl.uniform1i(uFillHasOccupancy, (!occOff && R._handle.bundle && R._handle.bundle.hasOccupancy) ? 1 : 0);
      R._handle.fillPassAssetDirty = false;
      R._lastFillPassHandle = R._handle;
    }
    // Per-draw bindings: override texture + world
    // matrix. These flip per drawBundle call inside one frame, so we
    // can't gate them on _handle.fillPassAssetDirty. Cheap: 2 uniform writes
    // + one texture bind.
    //
    // Always pin uOverrideTex to TEXTURE8 — even when overrides are
    // off — so the sampler doesn't alias TEXTURE0 (curveTex). WebGL2
    // validates sampler-unit usage even when the sampling op is
    // gated by a uniform-bool; aliasing curveTex on unit 0 has been
    // observed to fire spurious feedback-loop errors when the fill
    // pass's framebuffer (shapeFbo) is also bound to TEXTURE0
    // earlier in the frame.
    gl.activeTexture(gl.TEXTURE8);
    const ov = R.draw.overrides;
    if (ov && ov.uploadIfDirty) {
      ov.uploadIfDirty();
      gl.bindTexture(gl.TEXTURE_2D, ov.texture);
      gl.uniform1i(uFillOverrideTex, 8);
      gl.uniform1i(uFillHasOverrides, 1);
    } else {
      // Dummy 1x1 RGBA32F texture so unit 8 has something compatible
      // with a sampler2D-RGBA32F lookup (driver-defensive).
      gl.bindTexture(gl.TEXTURE_2D, dummyGradientTex);
      gl.uniform1i(uFillOverrideTex, 8);
      gl.uniform1i(uFillHasOverrides, 0);
    }
    // Per-draw opacity multiplier. The fill vert shader folds this
    // into the per-shape tint alpha so it works whether or not the
    // caller bound an override table. drawBundle/drawInstance set
    // _drawAlpha to opts.alpha (defaults to 1.0).
    gl.uniform1f(uFillDrawAlpha, R.draw.alpha);
    // 9-slice em-coord: nineSlice.applyNineSlice stamps the bundle
    // with `_nineSliceActive=true` so the vert shader reads the
    // native em coord from aEmCoord (v1.xy slot) instead of aPos.
    gl.uniform1i(uFillHasEmCoord, (R._handle.bundle && R._handle.bundle._nineSliceActive) ? 1 : 0);
    if (R.draw.worldM) {
      // Pass row-major 3x3 as a mat3 (GLSL is column-major; flip).
      gl.uniformMatrix3fv(uFillWorldM, false, R.draw.worldM);
      gl.uniform1i(uFillHasWorldM, 1);
    } else {
      gl.uniform1i(uFillHasWorldM, 0);
    }
    // Per-draw bilinear channel-lerp recolor (bilinear recolor).
    // The channel-lerp formula: out = mix(R·primary +
    // B·contrast, highlight, G + 1 - A). Non-linear, can't be expressed
    // as a color matrix. Runs first in the pipeline so palette + matrix
    // can stack downstream if the caller wants.
    if (uFillChLerpEnabled) {
      if (R.draw.channelLerp) {
        const cl = R.draw.channelLerp;
        const p = cl.primary   || [0, 0, 0, 1];
        const c = cl.contrast  || [0, 0, 0, 1];
        const h = cl.highlight || [1, 1, 1, 1];
        gl.uniform4f(uFillChLerpPrimary,   p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
        gl.uniform4f(uFillChLerpContrast,  c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
        gl.uniform4f(uFillChLerpHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
        gl.uniform1i(uFillChLerpEnabled, 1);
      } else {
        gl.uniform1i(uFillChLerpEnabled, 0);
      }
    }
    // Per-draw color matrix recolor (dual-tint fill recolor).
    // Caller supplies a 4x4 matrix + offset; the fragment shader
    // transforms vFill (and vStroke) via `out = M * in + offset` after
    // per-shape overrides and before coverage. When neither matrix nor
    // offset is set, the enabled flag stays 0 and the shader branch is
    // skipped (uniform branch, coherent across the draw → free).
    // Gate on EFFECT, not presence. An identity matrix with a zero offset produces the
    // colour it started with — enabling it just made every fragment pay a 4x4 multiply to
    // learn that. (It also dragged the draw onto the recolour variant.)
    if (uFillColorMatrixEnabled) {
      if (!_isIdentityCm(R.draw.colorMatrix) || !_isZeroOff(R.draw.colorMatrixOffset)) {
        gl.uniformMatrix4fv(
          uFillColorMatrix, false,
          R.draw.colorMatrix || IDENTITY_COLOR_MATRIX);
        gl.uniform4fv(
          uFillColorMatrixOffset,
          R.draw.colorMatrixOffset || ZERO_OFFSET);
        gl.uniform1i(uFillColorMatrixEnabled, 1);
      } else {
        gl.uniform1i(uFillColorMatrixEnabled, 0);
      }
    }
    // Per-draw palette LUT. Always pin uPalette to TEXTURE13 (even
    // when disabled) so the sampler has a valid binding; the enabled
    // flag gates the shader path. Caller's palette can be mutated
    // between draws at gl.texSubImage2D cost; no plumbing needed
    // here beyond the texture bind.
    // Palette is OFF for the vast majority of draws, yet the branch re-binds a dummy to
    // unit 13 + sets uniforms every draw. Skip the whole block when it was OFF last draw
    // too (R._fpPalOff): unit 13 is fill-pass-owned so the dummy bind persists, and the
    // enable uniform is per-program (reset on variant switch above). Palette-ON always
    // runs (the texture/params can change between draws).
    const palOn = !!(uFillPaletteEnabled && R.draw.palette && R.draw.palette.texture);
    if (uFillPaletteEnabled && (palOn || !R._fpPalOff)) {
      gl.activeTexture(gl.TEXTURE13);
      if (palOn) {
        gl.bindTexture(gl.TEXTURE_2D, R.draw.palette.texture);
        gl.uniform1i(uFillPalette, 13);
        gl.uniform1i(uFillPaletteEnabled, 1);
        gl.uniform1i(uFillPaletteChannel, R.draw.paletteChannel | 0);
        gl.uniform1i(uFillPaletteSize, Math.max(1, R.draw.palette.size | 0));
      } else {
        gl.bindTexture(gl.TEXTURE_2D, dummyGradientStops);
        gl.uniform1i(uFillPalette, 13);
        gl.uniform1i(uFillPaletteEnabled, 0);
      }
      R._fpPalOff = !palOn;
    }
    // Per-draw external clip mask (setNodeClip). Always pin to
    // TEXTURE14 so the sampler has a valid binding; uExtClipMode gates the
    // shader path (default 0 → off, byte-identical to unclipped draws).
    // Same OFF-state skip as palette: external clip is off for almost every draw. Unit 14
    // is fill-pass-owned; uFillExtClipMode is per-program (reset on variant switch above).
    const clipOn = !!(R.draw.extClipTex && R.draw.extClipMode > 0);
    if (clipOn || !R._fpClipOff) {
      gl.activeTexture(gl.TEXTURE14);
      if (clipOn) {
        gl.bindTexture(gl.TEXTURE_2D, R.draw.extClipTex);
        gl.uniform1i(uFillExtClipTex, 14);
        gl.uniform1i(uFillExtClipMode, R.draw.extClipMode | 0);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, dummyGradientStops);
        gl.uniform1i(uFillExtClipTex, 14);
        gl.uniform1i(uFillExtClipMode, 0);
      }
      R._fpClipOff = !clipOn;
    }
    if (cw !== R.fillPassCanvasW || ch !== R.fillPassCanvasH) {
      const [sx, sy] = arScale(R._handle.bundle.globalBBox, cw, ch);
      gl.uniform2f(uFillCanvasAR, sx, sy);
      gl.uniform2f(uFillViewportSize, cw, ch);
      R.fillPassCanvasW = cw;
      R.fillPassCanvasH = ch;
    }
    // Canvas position of the bound framebuffer's origin. Zero for every pass that
    // targets the canvas; non-zero only when a filtered shape is being rendered into
    // an RT covering just its own rect (renderer.acquireShapeRT), where gl_FragCoord
    // is rect-local and the canvas-space textures (mask, external clip, coverage RTs)
    // must still be sampled in canvas space. Not cached on cw/ch — it changes per
    // draw target, and a stale one silently shifts every screen-space sample.
    if (uFillFragOrigin) {
      const fo = R._fragOrigin;
      gl.uniform2f(uFillFragOrigin, fo ? fo[0] : 0, fo ? fo[1] : 0);
    }
    gl.bindVertexArray(R._handle.triVao);
  }

  // The frame origin belongs to ONE fill pass — the caller sets it, this pass honours
  // it, and it dies here. Leaving the caller to clear it is how a filtered shape's
  // origin leaked into the NEXT draw, which then rendered with a shifted viewport:
  // silently, in a later frame, far from the code that set it.
  function endFillPass() { fillPassActive = false; R._fragOrigin = null; }

  R.beginFillPass = beginFillPass;
  R.endFillPass = endFillPass;
}
