// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// contextCheck.js -- entry checks for the two public factories that take a GL context (createRenderer, createBundle), and
// the createRenderer option validation. Without them a context that cannot run Mantle fails somewhere deep inside (a shader
// compile dump, "reading 'getExtension'", an INVALID_ENUM on a texture upload) or, for createBundle, not at all.

import { mantleWarn } from '../core/diagnostics.js';

/**
 * Throw a message that names the problem when `gl` cannot host Mantle: not an object, not a WebGL context at all, lost,
 * or WebGL1. The checks are property reads and one `isContextLost()` call; they run once per factory call.
 *
 * `lenient` (createBundle) asks only for what a bundle upload uses (`createTexture`, the `RGBA32F` constant that WebGL1 lacks) and reads
 * everything else defensively, so the minimal stub contexts that unit tests and embedders hand it keep working.
 * @param {string} fn  the public entry, for the message
 * @param {any} gl
 * @param {boolean} [lenient]
 */
export function assertUsableGl(fn, gl, lenient = false) {
  if (gl === null || gl === undefined || (typeof gl !== 'object' && typeof gl !== 'function'))
    throw new Error(
      fn +
        ': needs a WebGL2 rendering context (canvas.getContext("webgl2")), got ' +
        (gl === null ? 'null' : typeof gl) +
        '. If getContext returned null the browser has no WebGL2: use createNativeScene or createMantleScene, which fall back to native SVG.',
    );
  const probe = (f) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  }; // an exotic stub may throw on an unknown property read
  if (lenient) {
    if (probe(() => typeof gl.createTexture) !== 'function')
      throw new Error(
        fn +
          ': needs a WebGL2 rendering context (canvas.getContext("webgl2")); this object has no createTexture, so it is not a WebGL context (a 2D or bitmaprenderer context?).',
      );
  } else if (typeof gl.getExtension !== 'function')
    throw new Error(
      fn +
        ': needs a WebGL2 rendering context (canvas.getContext("webgl2")); this object has no getExtension, so it is not a WebGL context (a 2D or bitmaprenderer context?).',
    );
  if (probe(() => typeof gl.isContextLost === 'function' && gl.isContextLost()))
    throw new Error(
      fn +
        ": the WebGL context is lost. Wait for the canvas's webglcontextrestored event, then create the renderer and its bundles on the restored context (or recreate the canvas).",
    );
  const gl2 = lenient
    ? probe(() => gl.RGBA32F) !== undefined
    : typeof gl.createVertexArray === 'function'; // a WebGL1 context has no RGBA32F constant
  if (!gl2)
    throw new Error(
      fn +
        ': needs a WebGL2 context; this one is WebGL1 (canvas.getContext("webgl2") returns null where WebGL2 is unavailable).',
    );
}

const isNum = (v) => typeof v === 'number';
const bad = (name, want, v) =>
  new Error(
    'createRenderer: opts.' +
      name +
      ' must be ' +
      want +
      ', got ' +
      (typeof v === 'string'
        ? JSON.stringify(v)
        : isNum(v)
          ? String(v)
          : Array.isArray(v)
            ? 'an array'
            : typeof v === 'object' && v
              ? 'an object'
              : String(v)),
  );

/** Every createRenderer option key the renderer reads (R.opts.* and opts.* in createRenderer). A key outside this set is almost always a typo. */
const KNOWN_RENDERER_OPTIONS = new Set(
  (
    'aacCoverExtMax aacCoverExtMin aacFill aacPoints aacPointsBase aacPointsBucket aacPointsBufferBudget aacPointsGen aacPointsBytesBudget aacPointsColorMatrix ' +
    'aacPointsDepthGain aacPointsExtMax aacPointsMaxPoints aacPointsMaxPx aacPointsPrewarm aacPointsRowGate aacPointsRowsMin aacPointsRunsMax ' +
    'aacPointsTypeOmit asyncShaderCompile cacheKeepDepthStencil captureFrames cpatchAreaSplit cpatchAuto cpatchFill cpatchOpts disableFillVariants ' +
    'fillDefines fillKernel glGuard glGuardOptions gpuShedMs gpuShedMaxMs gpuRelaxMs gpuFenceValveMs nonBlocking strictPlay warmPolicy warmQueueMaxLinks warmQueueAllLayouts filterCacheBytes filterFrame filterFrameMaxPixels filterPoolIdleMs groupAtlas groupFilterCache lbAdopt lbAdoptMs lbAdoptShapes ' +
    'lbKindOmit lbMinBundlePx2 lbMinExtentPx lbMinExtentShare lbPrepareAsync memoryBudgetBytes onContextLost onContextRestored precompileFillsBudgetMs psoWarm recordWarmManifest coverSet sceneUnion warmFutureStates warmManifest fillTwins loadingBaseWarm ' +
    'opaquePrepass psoWarmIdle psoWarmMaxWaitFrames strokeExactEdges strokeStrip strokeStripMinSavedPx strokeStripMode typeOmit unifiedFill unifiedFillCurveTex ' +
    'unifiedFillDepthClaim unifiedFillFilters unifiedFillKeepVerts unifiedFillPadFloats unifiedFilterCache unifiedFilterCacheProbe unifiedMorph ' +
    'variantFirst viewCull warmMorphSources ' +
    'warmQueueRelease standIns needMissPolicy needMissWarn warmBindSet declaredNeeds warmEngineCandidates eagerPrograms lazyImagePrograms ' +
    'strictFineUnions strictGenerics strictNetAac strictNetCoarse strictNetFlavors strictNetTypes'
  ).split(' '),
);

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const _warnedOptionKeys = new Set();
function warnUnknownOptions(o) {
  for (const k of Object.keys(o)) {
    if (KNOWN_RENDERER_OPTIONS.has(k) || _warnedOptionKeys.has(k)) continue;
    _warnedOptionKeys.add(k);
    let best = null,
      bestD = 3;
    for (const known of KNOWN_RENDERER_OPTIONS) {
      const d = editDistance(k.toLowerCase(), known.toLowerCase());
      if (d < bestD) {
        bestD = d;
        best = known;
      }
    }
    mantleWarn(
      'createRenderer: unknown option "' +
        k +
        '" is ignored' +
        (best ? ' (did you mean "' + best + '"?)' : '') +
        '. Warned once per key.',
    );
  }
}

/**
 * Validate the createRenderer options whose values select a behavior or set a limit, so a typo'd value cannot select a behavior by
 * truthiness (`aacFill: 'sometimes'` drawing with AAC) or turn a limit into NaN. Keys the renderer never reads draw a one-time warning with the nearest known key. `undefined` always means "default".
 * @param {any} opts  the caller's options argument
 */
export function validateRendererOptions(opts) {
  if (opts === undefined) return;
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts))
    throw new Error(
      'createRenderer: opts must be an object or omitted, got ' +
        (opts === null ? 'null' : Array.isArray(opts) ? 'an array' : typeof opts),
    );
  const o = opts;
  warnUnknownOptions(o);
  if (o.aacFill !== undefined && o.aacFill !== true && o.aacFill !== false && o.aacFill !== 'auto')
    throw bad('aacFill', 'true, false or "auto"', o.aacFill);
  if (
    o.unifiedFill !== undefined &&
    o.unifiedFill !== true &&
    o.unifiedFill !== false &&
    o.unifiedFill !== 'force'
  )
    throw bad('unifiedFill', 'true, false or "force"', o.unifiedFill);
  for (const k of ['psoWarmMaxWaitFrames', 'filterPoolIdleMs', 'precompileFillsBudgetMs']) {
    const v = o[k];
    if (v !== undefined && !(isNum(v) && v >= 0)) throw bad(k, 'a number >= 0', v);
  }
  if (
    o.memoryBudgetBytes !== undefined &&
    o.memoryBudgetBytes !== null &&
    !(isNum(o.memoryBudgetBytes) && o.memoryBudgetBytes >= 0)
  )
    throw bad(
      'memoryBudgetBytes',
      'a number of bytes >= 0 (Infinity or null is no limit)',
      o.memoryBudgetBytes,
    );
  for (const k of [
    'asyncShaderCompile',
    'nonBlocking',
    'strictPlay',
    'captureFrames',
    'psoWarm',
    'variantFirst',
    'disableFillVariants',
    'cacheKeepDepthStencil',
    'warmMorphSources',
  ]) {
    const v = o[k];
    if (v !== undefined && typeof v !== 'boolean') throw bad(k, 'true or false', v);
  }
  if (
    o.warmPolicy !== undefined &&
    o.warmPolicy !== 'strict' &&
    o.warmPolicy !== 'idle' &&
    o.warmPolicy !== 'off'
  )
    throw bad('warmPolicy', '"strict", "idle" or "off"', o.warmPolicy);
  if ((o.warmPolicy === 'idle' || o.warmPolicy === 'off') && o.strictPlay === true)
    throw new Error(
      `createRenderer: warmPolicy "${o.warmPolicy}" excludes strictPlay: true (strict play is the "strict" policy)`,
    );
  for (const k of ['onContextLost', 'onContextRestored', 'psoWarmIdle']) {
    const v = o[k];
    if (v !== undefined && v !== null && typeof v !== 'function') throw bad(k, 'a function', v);
  }
}
