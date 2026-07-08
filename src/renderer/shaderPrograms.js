// shaderPrograms.js — compile/link, program queue, async readiness.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachShaderPrograms(R) {
    function _whenProgramsComplete() {
      if (!R._khrParallel) return Promise.resolve();
      const COMPLETE = R._khrParallel.COMPLETION_STATUS_KHR;
      // Drive the poll with setTimeout, NOT requestAnimationFrame: rAF only
      // fires while the page is actively painting, so a renderer created in
      // a worker, on an OffscreenCanvas, or in a backgrounded tab would
      // never see its poll tick and `ready` would hang forever — a worse
      // failure than the stall this avoids. setTimeout fires regardless of
      // paint. ~1 frame cadence keeps it cheap without coupling to rendering.
      const schedule = (cb) => setTimeout(cb, 8);
      return new Promise((resolve) => {
        const tick = () => {
          for (const { prog } of R._pendingPrograms) {
            if (!R.gl.getProgramParameter(prog, COMPLETE)) { schedule(tick); return; }
          }
          resolve();
        };
        tick();
      });
    }
    function compile(src, type) {
      const s = R.gl.createShader(type);
      R.gl.shaderSource(s, src);
      R.gl.compileShader(s);
      R._pendingShaders.push({ shader: s, src });
      return s;
    }
    function program(vertSrc, fragSrc, label) {
      const p = R.gl.createProgram();
      R.gl.attachShader(p, compile(vertSrc, R.gl.VERTEX_SHADER));
      R.gl.attachShader(p, compile(fragSrc, R.gl.FRAGMENT_SHADER));
      R.gl.linkProgram(p);
      R._pendingPrograms.push({ prog: p, label });
      return p;
    }
    // Standard GLSL shader-variant composition: insert `#define <name>` lines
    // right after the mandatory first-line `#version`. The fill shader guards
    // each optional feature with `#ifndef MANTLE_NO_<FEAT>`, so passing e.g.
    // ['MANTLE_NO_CLIP','MANTLE_NO_MASK','MANTLE_NO_FILTER','MANTLE_NO_EXTCLIP',
    //  'MANTLE_NO_RECOLOR'] compiles a lean program (the GLSL preprocessor drops
    // that code → smaller program, fewer samplers/uniforms). No build step, no
    // text markers — the idiomatic WebGL way to do shader variants.
    function withDefines(src, defines) {
      if (!defines || !defines.length || typeof src !== 'string') return src;
      const nl = src.indexOf('\n');
      if (nl < 0 || !/^\s*#version/.test(src)) return defines.map(d => `#define ${d}\n`).join('') + src;
      return src.slice(0, nl + 1) + defines.map(d => `#define ${d}\n`).join('') + src.slice(nl + 1);
    }
    function finalizeShaderCompiles() {
      for (const { shader, src } of R._pendingShaders) {
        if (!R.gl.getShaderParameter(shader, R.gl.COMPILE_STATUS)) {
          const log = R.gl.getShaderInfoLog(shader);
          R.mantleError('shader compile failed:', log, '\n---SRC---\n', src);
          throw new Error('shader compile: ' + log);
        }
      }
      for (const { prog, label } of R._pendingPrograms) {
        if (!R.gl.getProgramParameter(prog, R.gl.LINK_STATUS)) {
          const log = R.gl.getProgramInfoLog(prog);
          R.mantleError('link failed (' + label + '):', log);
          throw new Error('link ' + label + ': ' + log);
        }
      }
      R._pendingShaders.length = 0;
      R._pendingPrograms.length = 0;
    }
    R.fillProg = program(R.shaderSources.fillVert,
                                 withDefines(R.shaderSources.fillFrag, R.opts.fillDefines), 'fill');
    const solidProg    = program(R.shaderSources.solidVert,     R.shaderSources.solidFrag,     'solid');
    const compProg     = program(R.shaderSources.compositeVert, R.shaderSources.compositeFrag, 'composite');
    const blurProg     = program(R.shaderSources.compositeVert, R.shaderSources.blurFrag,      'blur');
    // 3-pass box-blur approximation for very-large σ (Wells 1986 +
    // Kovacs 2011 closed-form radius). The Gaussian shader's tap count
    // grows with σ; for σ > 20 a 3-pass box converges to the same
    // shape at cost O(r) per pass × 6 passes vs the Gaussian's O(σ).
    const boxBlurProg  = R.shaderSources.boxBlurFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.boxBlurFrag, 'boxBlur')
      : null;
    // morphFrag is optional — engines bundling only the legacy shader set
    // (blur but no morph) can still construct a renderer; the kind=5
    // dispatch falls back to passthrough.
    const morphProg    = R.shaderSources.morphFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.morphFrag,    'morph')
      : null;
    const convolveProg = R.shaderSources.convolveFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.convolveFrag, 'convolve')
      : null;
    // Graph-only colorMatrix shader. Independent of mantle.frag's inline
    // color-matrix (which the single-kind path uses via uFilterTex);
    // this version is invoked by filterGraphSvg.feColorMatrix on an
    // arbitrary input RT. Lazy: only compiled when bundled.
    const colorMatrixProg = R.shaderSources.colorMatrixFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.colorMatrixFrag, 'colorMatrix')
      : null;
    // Graph-only feComposite shader (Porter-Duff + arithmetic). Distinct
    // from compProg (which serves group-composite and kind>=2 routes);
    // feComposite is a binary node in the filter graph DAG.
    const feCompositeProg = R.shaderSources.feCompositeFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feCompositeFrag, 'feComposite')
      : null;
    // Graph-only feBlend shader (CSS Blend Modes 0..15). Distinct from
    // compProg, which has the same blend-mode math but is paired with
    // the kind=2..4 sharp+halo composite pipeline; feBlend just takes
    // two graph outputs and blends them.
    const feBlendProg = R.shaderSources.feBlendFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feBlendFrag, 'feBlend')
      : null;
    const feTileProg = R.shaderSources.feTileFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feTileFrag, 'feTile')
      : null;
    const feTurbulenceProg = R.shaderSources.feTurbulenceFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feTurbulenceFrag, 'feTurbulence')
      : null;
    const feDisplacementMapProg = R.shaderSources.feDisplacementMapFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feDisplacementMapFrag, 'feDisplacementMap')
      : null;
    const feLightingProg = R.shaderSources.feLightingFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feLightingFrag, 'feLighting')
      : null;
    // SVG feComponentTransfer — per-channel 1D LUT remap. The LUT is
    // baked CPU-side by the importer; the dispatch uploads it to a
    // 256×4 RGBA8 texture lazily on first use.
    const feComponentTransferProg = R.shaderSources.feComponentTransferFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feComponentTransferFrag, 'feComponentTransfer')
      : null;
    // SVG feImage — source primitive that pulls a bitmap from the
    // bundle's image atlas into the filter graph.
    const feImageProg = R.shaderSources.feImageFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.feImageFrag, 'feImage')
      : null;
    // COLRv1 paint-graph shaders (slice 6+7). All five (3 gradients +
    // PaintTransform + PaintGlyph) + the 28-mode PaintComposite. PaintSolid
    // uses the clearColor fast-path (no shader); PaintMerge reuses
    // feCompositeProg. Programs default to null when shader sources are
    // missing — the dispatch falls back to passthrough / clear.
    const paintLinearGradProg = R.shaderSources.paintLinearGradFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintLinearGradFrag, 'paintLinearGrad') : null;
    const paintRadialGradProg = R.shaderSources.paintRadialGradFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintRadialGradFrag, 'paintRadialGrad') : null;
    const paintSweepGradProg = R.shaderSources.paintSweepGradFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintSweepGradFrag, 'paintSweepGrad') : null;
    const paintTransformProg = R.shaderSources.paintTransformFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintTransformFrag, 'paintTransform') : null;
    const paintGlyphProg = R.shaderSources.paintGlyphFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintGlyphFrag, 'paintGlyph') : null;
    const paintCompositeProg = R.shaderSources.paintCompositeFrag
      ? program(R.shaderSources.compositeVert, R.shaderSources.paintCompositeFrag, 'paintComposite') : null;
    // Multi-shape mask bake program. Per-region offscreen
    // bake into a TEXTURE_2D_ARRAY layer; mantle.frag samples the layer
    // instead of walking children inline. Optional — falls back to the
    // inline kMaxMaskChildren loop when the program isn't bundled.
    const maskBakeProg = (R.shaderSources.maskBakeVert && R.shaderSources.maskBakeFrag)
      ? program(R.shaderSources.maskBakeVert, R.shaderSources.maskBakeFrag, 'maskBake')
      : null;
    // Static-scene cache blit. Required for enableStaticCache(); when
    // absent, the cache hook gates itself off so the renderer behaves
    // exactly like today.
    R.cacheBlitProg = (R.shaderSources.cacheBlitVert && R.shaderSources.cacheBlitFrag)
      ? program(R.shaderSources.cacheBlitVert, R.shaderSources.cacheBlitFrag, 'cacheBlit')
      : null;
    // Direct raster blit (createImage / drawImage). Optional — present when
    // the consumer loaded the drawImage shaders (loadShaders includes them).
    R.drawImageProg = (R.shaderSources.drawImageVert && R.shaderSources.drawImageFrag)
      ? program(R.shaderSources.drawImageVert, R.shaderSources.drawImageFrag, 'drawImage')
      : null;
    // Instanced raster blit — optional, present when the consumer loaded the
    // drawImageInstanced shaders (loadShaders includes them).
    R.drawImageInstProg = (R.shaderSources.drawImageInstancedVert && R.shaderSources.drawImageInstancedFrag)
      ? program(R.shaderSources.drawImageInstancedVert, R.shaderSources.drawImageInstancedFrag, 'drawImageInstanced')
      : null;
    // Additive Loop-Blinn hybrid fill — optional, present when the consumer
    // loaded the loopBlinn shaders (core, so normally present). Two programs:
    // the coverage pass (interior + implicit curves, MAX blend) and the
    // fullscreen composite (paint × coverage). Both null-gated → renderer
    // degrades to the Slug path when absent.
    R.lbProg = (R.shaderSources.loopBlinnVert && R.shaderSources.loopBlinnFrag)
      ? program(R.shaderSources.loopBlinnVert, R.shaderSources.loopBlinnFrag, 'loopBlinn')
      : null;
    // LEAN variant (MANTLE_NO_BEZOUT): drops the kind-4 Bezout attributes (aC0-2),
    // their 6 flat varyings, and the determinant branch — used for the common
    // cusp-free mesh (packed.hasBezout === false). Same VBO/VAO as the full prog
    // (loc 3-5 stay enabled but unread). Null-gated like lbProg.
    R.lbProgLean = R.lbProg
      ? program(withDefines(R.shaderSources.loopBlinnVert, ['MANTLE_NO_BEZOUT']),
                withDefines(R.shaderSources.loopBlinnFrag, ['MANTLE_NO_BEZOUT']), 'loopBlinnLean')
      : null;
    R.lbCompProg = (R.lbProg && R.shaderSources.loopBlinnCompositeVert && R.shaderSources.loopBlinnCompositeFrag)
      ? program(R.shaderSources.loopBlinnCompositeVert, R.shaderSources.loopBlinnCompositeFrag, 'loopBlinnComposite')
      : null;
    // (the legacy GPU-morph program is gone — morphs ride the MANTLE_LB_MORPH_PAIR
    // variant of the STATIC LB program, created lazily by morphDraw)
    // STROKE morph path: GPU-resident stroke coverage — per-segment band quads,
    // the VS lerps control points by uT, the frag distance-fields the morphed curve
    // (MAX blend → round-cap/round-join stroke). Fed into
    // the MANTLE_LB_COV fill variant as strokeCov so stroke composes with the morph
    // (clip/mask/filter included) without uploading the morphing geometry.
    R.morphStrokeProg = (R.lbProg && R.shaderSources.morphStrokeVert && R.shaderSources.morphStrokeFrag)
      ? program(R.shaderSources.morphStrokeVert, R.shaderSources.morphStrokeFrag, 'morphStroke')
      : null;
  // Attach the programs created as locals above onto R (the renderer's _runInit
  // resolves their uniforms via R.<name>Prog).
  Object.assign(R, {
    solidProg, compProg, blurProg, boxBlurProg, morphProg, convolveProg,
    colorMatrixProg, feCompositeProg, feBlendProg, feTileProg, feTurbulenceProg,
    feDisplacementMapProg, feLightingProg, feComponentTransferProg, feImageProg,
    paintLinearGradProg, paintRadialGradProg, paintSweepGradProg, paintTransformProg,
    paintGlyphProg, paintCompositeProg, maskBakeProg,
  });
  R._whenProgramsComplete = _whenProgramsComplete;
  R.compile = compile;
  R.program = program;
  R.withDefines = withDefines;
  R.finalizeShaderCompiles = finalizeShaderCompiles;
}