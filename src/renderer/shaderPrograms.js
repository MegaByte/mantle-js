// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  resourceGeneration,
  createTrackedProgram,
  deleteProgramWhenLinked,
} from './contextResources.js';
import { trackGlResource, deleteGlResource } from './contextResources.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachShaderPrograms(R) {
  const generation = resourceGeneration(R.gl);
  // Timer polling also runs in workers and tabs without animation frames.
  function _whenProgramsComplete() {
    if (!R._khrParallel) return Promise.resolve();
    const COMPLETE = R._khrParallel.COMPLETION_STATUS_KHR;

    const schedule = (cb) => setTimeout(cb, 4);
    // A poll is a command like any other: the pending list is walked in time-boxed slices (a completed program is remembered), so a tick is never a
    // held main thread however many programs are linking.
    const done = new Set();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (resourceGeneration(R.gl) !== generation) {
          reject(new Error('WebGL context lost during shader preparation'));
          return;
        }
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        for (const { prog } of R._pendingPrograms) {
          if (done.has(prog)) continue;
          if (!R.gl.getProgramParameter(prog, COMPLETE)) {
            schedule(tick);
            return;
          }
          done.add(prog);
          if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 > 6) {
            schedule(tick);
            return;
          }
        }
        // ...and the GPU thread clear of anything already queued, so the construction that follows asks nothing behind a build.
        if (R._gpuClear && !R._gpuClear()) {
          schedule(tick);
          return;
        }
        resolve();
      };
      tick();
    });
  }
  function compile(src, type, owner = null) {
    const s = trackGlResource(R.gl, R.gl.createShader(type));
    R.gl.shaderSource(s, src);
    R.gl.compileShader(s);
    R._pendingShaders.push({ shader: s, src, owner });
    return s;
  }
  function program(vertSrc, fragSrc, label) {
    R._programsCreated = (R._programsCreated | 0) + 1;
    const p = createTrackedProgram(R.gl);
    const vs = compile(vertSrc, R.gl.VERTEX_SHADER, p);
    const fs = compile(fragSrc, R.gl.FRAGMENT_SHADER, p);
    R.gl.attachShader(p, vs);
    R.gl.attachShader(p, fs);
    R.gl.linkProgram(p);

    // Attachment retains shaders until their owning program is deleted.
    deleteGlResource(R.gl, 'Shader', vs);
    deleteGlResource(R.gl, 'Shader', fs);
    R._pendingPrograms.push({ prog: p, label });
    if (R._gpuLabel) R._gpuLabel(p, label);
    return p;
  }

  // Insert specialization defines after #version in both shader stages.
  function withDefines(src, defines) {
    // All stroke programs share the same opt-in edge-record layout.
    if (
      R.opts.strokeExactEdges === true &&
      typeof src === 'string' &&
      src.indexOf('MANTLE_STROKE_EXACT') >= 0 &&
      !(defines && defines.includes('MANTLE_STROKE_EXACT'))
    )
      defines = (defines || []).concat('MANTLE_STROKE_EXACT');
    if (!defines || !defines.length || typeof src !== 'string') return src;
    const nl = src.indexOf('\n');
    if (nl < 0 || !/^\s*#version/.test(src))
      return defines.map((d) => `#define ${d}\n`).join('') + src;
    return src.slice(0, nl + 1) + defines.map((d) => `#define ${d}\n`).join('') + src.slice(nl + 1);
  }
  // Check deferred compile/link errors, then clear the preparation queue.
  function finalizeShaderCompiles() {
    try {
      if (resourceGeneration(R.gl) !== generation)
        throw new Error('WebGL context lost during shader preparation');

      if (typeof R.gl.isContextLost === 'function' && R.gl.isContextLost())
        throw new Error(
          'createRenderer: the WebGL context was lost while the shaders compiled; wait for webglcontextrestored and create the renderer again.',
        );
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
    } catch (error) {
      for (const { shader } of R._pendingShaders) deleteGlResource(R.gl, 'Shader', shader);
      // A compile failure is found while the other programs are still linking on the driver's thread, and a program deleted there raises GL_INVALID_VALUE later, from no call of ours.
      for (const { prog } of R._pendingPrograms) deleteProgramWhenLinked(R.gl, prog);
      throw error;
    } finally {
      R._pendingShaders.length = 0;
      R._pendingPrograms.length = 0;
    }
  }

  // Defines must match across stages when they add varyings.
  // THE BASE (UNIVERSAL) FILL PROGRAM IS BUILT only WHEN SOMETHING CAN DRAW IT. With the default policy a draw whose lean variant is not
  // built waits (noStandIn) or draws the lean variant itself, and a never-drawn universal is a ~10 s Metal pipeline build, so linking its
  // 320 KB of source at load bought nothing. It is linked at the first read of R.fillProg instead (R._baseFillMade records it), and
  // eagerly when an option makes the base a draw target: variantFirst:false, psoWarm:false or loadingBaseWarm:true.
  {
    let _fp = null;
    const make = () => {
      R._baseFillMade = true;
      return program(
        withDefines(R.shaderSources.fillVert, R._baseFillDefines),
        withDefines(R.shaderSources.fillFrag, R._baseFillDefines),
        'fill',
      );
    };
    Object.defineProperty(R, 'fillProg', {
      configurable: true,
      enumerable: true,
      get() {
        return _fp || (_fp = make());
      },
      set(v) {
        _fp = v;
      },
    });
    if (
      R.opts.variantFirst === false ||
      R.opts.psoWarm === false ||
      R.opts.loadingBaseWarm === true ||
      R.opts.eagerPrograms === true
    )
      void R.fillProg;
  }
  // THE FILL SOURCE CHECK. A broken fillFrag/fillVert fails createRenderer (with the compile log, no leaked shaders) -- a contract
  // aacPointsDisposeGpuSmoke pins -- and with the base program lazy, something else at init has to carry the fill source. A PLAIN-FILL variant
  // (every optional feature omitted: ~20 KB of live code, the variant a solid shape draws) is linked at init instead; it is registered as that variant by fillPass, so it is
  // not extra work when a bundle wants it, and an error in any live path of the source surfaces here.
  if (!R.opts.disableFillVariants) {
    const defs = [
      ...(R.opts.fillDefines || []),
      'MANTLE_NO_ARC',
      'MANTLE_NO_CLIP',
      'MANTLE_NO_CUBIC',
      'MANTLE_NO_FILTER',
      'MANTLE_NO_GRADIENT',
      'MANTLE_NO_IMAGE',
      'MANTLE_NO_MASK',
      'MANTLE_NO_PATTERN',
      'MANTLE_NO_RECOLOR',
      'MANTLE_NO_STROKE',
    ];
    R._fillProbeDefines = defs;
    R._fillProbeProg = program(
      withDefines(R.shaderSources.fillVert, defs),
      withDefines(R.shaderSources.fillFrag, defs),
      'fill:probe',
    );
  }
  const solidProg = program(R.shaderSources.solidVert, R.shaderSources.solidFrag, 'solid');
  const compProg = program(
    R.shaderSources.compositeVert,
    R.shaderSources.compositeFrag,
    'composite',
  );
  const blurProg = program(R.shaderSources.compositeVert, R.shaderSources.blurFrag, 'blur');

  // Missing optional shader sources leave null entries for draw-time fallback.
  const boxBlurProg = R.shaderSources.boxBlurFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.boxBlurFrag, 'boxBlur')
    : null;

  const morphProg = R.shaderSources.morphFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.morphFrag, 'morph')
    : null;
  const convolveProg = R.shaderSources.convolveFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.convolveFrag, 'convolve')
    : null;

  const colorMatrixProg = R.shaderSources.colorMatrixFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.colorMatrixFrag, 'colorMatrix')
    : null;

  const feCompositeProg = R.shaderSources.feCompositeFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.feCompositeFrag, 'feComposite')
    : null;

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
    ? program(
        R.shaderSources.compositeVert,
        R.shaderSources.feDisplacementMapFrag,
        'feDisplacementMap',
      )
    : null;
  const feLightingProg = R.shaderSources.feLightingFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.feLightingFrag, 'feLighting')
    : null;

  const feComponentTransferProg = R.shaderSources.feComponentTransferFrag
    ? program(
        R.shaderSources.compositeVert,
        R.shaderSources.feComponentTransferFrag,
        'feComponentTransfer',
      )
    : null;

  const feImageProg = R.shaderSources.feImageFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.feImageFrag, 'feImage')
    : null;

  const paintLinearGradProg = R.shaderSources.paintLinearGradFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintLinearGradFrag, 'paintLinearGrad')
    : null;
  const paintRadialGradProg = R.shaderSources.paintRadialGradFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintRadialGradFrag, 'paintRadialGrad')
    : null;
  const paintSweepGradProg = R.shaderSources.paintSweepGradFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintSweepGradFrag, 'paintSweepGrad')
    : null;
  const paintTransformProg = R.shaderSources.paintTransformFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintTransformFrag, 'paintTransform')
    : null;
  const paintGlyphProg = R.shaderSources.paintGlyphFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintGlyphFrag, 'paintGlyph')
    : null;
  const paintCompositeProg = R.shaderSources.paintCompositeFrag
    ? program(R.shaderSources.compositeVert, R.shaderSources.paintCompositeFrag, 'paintComposite')
    : null;

  const maskBakeProg =
    R.shaderSources.maskBakeVert && R.shaderSources.maskBakeFrag
      ? program(R.shaderSources.maskBakeVert, R.shaderSources.maskBakeFrag, 'maskBake')
      : null;

  R.cacheBlitProg =
    R.shaderSources.cacheBlitVert && R.shaderSources.cacheBlitFrag
      ? program(R.shaderSources.cacheBlitVert, R.shaderSources.cacheBlitFrag, 'cacheBlit')
      : null;

  // THE IMAGE PROGRAMS: eager by default; `lazyImagePrograms: true` builds them at the first draw of an image. (Left eager because the first draw's uniform reads wait on the link --
  // a main-thread stall in play for an app that draws images without declaring them; warmQueueSmoke checks it. The lazy mode is proven by universalProgramsSmoke.)
  // With lazyImagePrograms: drawImage / drawImageInstanced are the only callers (a public API: reachable, so not dropped), and
  // Most content never draws an image, yet linking both costs tens of KB of source each and on the order of a second of GPU-process compile. They are built when the app declares them
  // (needs manifest program kind 'drawImage'), when it asks (`renderer.warmPrograms(['drawImage'])`), or else at the first read --
  // the first image draw, counted as a need miss (debugStats.needMiss) with the build on the draw's own thread.
  R._lazyMade = {};
  const lazyProgram = (name, vertKey, fragKey, label) => {
    let prog = null,
      made = false;
    R._lazyMade[name] = () => made;
    Object.defineProperty(R, name, {
      configurable: true,
      enumerable: true,
      get() {
        if (!made) {
          if (!(R.shaderSources[vertKey] && R.shaderSources[fragKey])) {
            made = true;
            return null;
          }
          made = true;
          if (R._noteProgramMiss) R._noteProgramMiss('program', label);
          prog = program(R.shaderSources[vertKey], R.shaderSources[fragKey], label);
        }
        return prog;
      },
      set(v) {
        prog = v;
        made = true;
      },
    });
    if (R.opts.lazyImagePrograms !== true) void R[name]; // (opt-in: see above)
  };
  lazyProgram('drawImageProg', 'drawImageVert', 'drawImageFrag', 'drawImage');
  lazyProgram(
    'drawImageInstProg',
    'drawImageInstancedVert',
    'drawImageInstancedFrag',
    'drawImageInstanced',
  );
  R._wmPrelinkers = R._wmPrelinkers || {};
  R._wmPrelinkers.drawImage = () => {
    void R.drawImageProg;
    void R.drawImageInstProg;
  };

  R.lbCompProg =
    R.shaderSources.loopBlinnCompositeVert && R.shaderSources.loopBlinnCompositeFrag
      ? program(
          R.shaderSources.loopBlinnCompositeVert,
          R.shaderSources.loopBlinnCompositeFrag,
          'loopBlinnComposite',
        )
      : null;

  // Forward stroke defines to the standalone coverage program as well.
  R.splitStrokeProg =
    R.shaderSources.splitStrokeVert && R.shaderSources.splitStrokeFrag
      ? program(
          withDefines(R.shaderSources.splitStrokeVert, R.opts.fillDefines),
          withDefines(R.shaderSources.splitStrokeFrag, R.opts.fillDefines),
          'splitStroke',
        )
      : null;

  Object.assign(R, {
    solidProg,
    compProg,
    blurProg,
    boxBlurProg,
    morphProg,
    convolveProg,
    colorMatrixProg,
    feCompositeProg,
    feBlendProg,
    feTileProg,
    feTurbulenceProg,
    feDisplacementMapProg,
    feLightingProg,
    feComponentTransferProg,
    feImageProg,
    paintLinearGradProg,
    paintRadialGradProg,
    paintSweepGradProg,
    paintTransformProg,
    paintGlyphProg,
    paintCompositeProg,
    maskBakeProg,
  });
  R._whenProgramsComplete = _whenProgramsComplete;
  R.compile = compile;
  R.program = program;
  R.withDefines = withDefines;
  R.finalizeShaderCompiles = finalizeShaderCompiles;
}
