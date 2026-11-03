// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-draw options of `drawBundle`, `submitBundle` and `bundleDrawMatrix`. The named fields are the documented ones; other
 * fields pass through (the draw entries read the options object, and animation handles add their own).
 *
 * `alpha` (0 to 1, default 1) is GROUP opacity: the whole draw renders into an accumulator and is faded once, as CSS `opacity` on a
 * `<g>`, so overlapping shapes do not show through one another (it does not multiply each leaf). Per-leaf state
 * (`colorMatrix`, `palette`, `channelLerp`, the override table's tint and opacity) applies inside the group, and filters, masks,
 * blend modes and the bundle's own groups composite inside it; `alpha` is applied last. A draw whose leaves cannot overlap (one
 * paint-only leaf, or plain leaves whose painted boxes are disjoint) is drawn directly with the same pixels; `alpha` 1 or absent is the
 * unchanged path. Hit testing ignores it.
 * @typedef {{
 *   dstRect?: number[], fit?: string, clipToRect?: boolean,
 *   worldMatrix?: ArrayLike<number> | null, overrides?: any, alpha?: number,
 *   colorMatrix?: ArrayLike<number> | null, colorMatrixOffset?: ArrayLike<number> | null,
 *   palette?: any, paletteChannel?: string | number, channelLerp?: any,
 *   extClipTex?: any, extClipMode?: number, scissor?: number[] | null,
 * } & Record<string, any>} DrawBundleOptions
 */

/**
 * One scene's state in `renderer.warm.status()`.
 * @typedef {{
 *   id: string, state: 'queued'|'running'|'paused'|'done'|'cancelled', priority: number,
 *   source: 'manifest'|'bundles'|'bundles(fallback)'|'links'|'empty', manifest: 'none'|'ok'|'unverified'|'stale'|'invalid', bundles: number,
 *   total: number|null, done: number, built: number, skipped: number, pending: number|null, progress: number,
 *   scales: { recorded: number[], reachable: number[]|null, missing: number[]|null },
 *   startedAt: number|null, doneAt: number|null, result: WarmSceneResult|null,
 * }} WarmSceneStatus
 */

/**
 * What a scene's `ready` promise (and `warm.focus`) resolves with. Never rejects.
 * @typedef {{ id: string, state: 'done'|'cancelled'|'timeout'|'unknown', source: string, manifest: string, total: number, built: number, skipped: number, ms: number, paused?: number }} WarmSceneResult
 */

/**
 * The background warm queue (`renderer.warm`). Builds happen only while frames do not matter: the tab is hidden, a window is open (`focus`, `window(true)`),
 * or the library infers one (static screen, no input for 700 ms, no frame entered for 300 ms), one pipeline per GPU fence, and never touch a frame.
 * @typedef {{
 *   add: (sceneId: string, o?: { manifest?: object|string, bundles?: object[], priority?: number, declaredNeeds?: any }) => { id: string, ready: Promise<WarmSceneResult>, status: () => WarmSceneStatus },
 *   focus: (sceneId: string, o?: { timeoutMs?: number }) => Promise<WarmSceneResult>,
 *   resume: () => void,
 *   pause: () => void,
 *   cancel: (sceneId: string) => boolean,
 *   window: (on?: boolean|(() => boolean)|null) => void,
 *   setInference: (on: boolean) => void,
 *   setDisplay: (d: { width: number, height: number, dpr?: number }|null) => void,
 *   status: () => { running: boolean, focus: string|null, held: boolean, window: { open: boolean, reason: string, canvas: boolean }, display: object|null, scenes: Record<string, WarmSceneStatus>, totals: Record<string, number> },
 *   ready: (sceneId: string) => Promise<WarmSceneResult>,
 *   idle: () => Promise<object>,
 *   gameStart: (gameId: string, o?: { viewport?: number[], needed?: string[], declaredNeeds?: any, timeoutMs?: number }) => Promise<object>,
 *   gameEnd: () => void,
 *   onResize: (w: number, h: number, o?: { block?: boolean, maxBlockMs?: number, timeoutMs?: number }) => Promise<object>,
 *   setContext: (c: object) => boolean,
 * }} WarmQueue
 */

/**
 * Options for `createRenderer(gl, shaders, opts)`. Invalid values throw; unlisted keys are test and research hooks and pass through.
 *
 * @typedef {{
 *   aacFill?: boolean|'auto',
 *   unifiedFill?: boolean|'force',
 *   asyncShaderCompile?: boolean,
 *   nonBlocking?: boolean,
 *   strictPlay?: boolean,
 *   warmPolicy?: 'strict'|'idle'|'off',
 *   warmQueueMaxLinks?: number,
 *   warmQueueAllLayouts?: boolean,
 *   glGuard?: boolean,
 *   gpuShedMs?: number,
 *   gpuShedMaxMs?: number,
 *   gpuRelaxMs?: number,
 *   gpuFenceValveMs?: number,
 *   glGuardOptions?: { slowMs?: number, maxSlow?: number, checkDraws?: boolean, onViolation?: (v: object) => void },
 *   captureFrames?: boolean,
 *   psoWarm?: boolean,
 *   psoWarmMaxWaitFrames?: number,
 *   psoWarmIdle?: ((dtMs: number) => boolean)|null,
 *   precompileFillsBudgetMs?: number,
 *   warmFutureStates?: boolean,
 *   recordWarmManifest?: boolean,
 *   coverSet?: boolean,
 *   sceneUnion?: "auto",
 *   warmManifest?: object|string,
 *   filterPoolIdleMs?: number,
 *   groupAtlas?: boolean,
 *   variantFirst?: boolean,
 *   disableFillVariants?: boolean,
 *   cacheKeepDepthStencil?: boolean,
 *   memoryBudgetBytes?: number|null,
 *   warmMorphSources?: boolean,
 *   standIns?: boolean,
 *   needMissPolicy?: 'block'|'defer',
 *   needMissWarn?: boolean,
 *   warmBindSet?: boolean,
 *   warmEngineCandidates?: boolean,
 *   eagerPrograms?: boolean,
 *   lazyImagePrograms?: boolean,
 *   onContextLost?: ((event: Event) => void)|null,
 *   onContextRestored?: ((event: Event) => void)|null,
 * } & Record<string, any>} MantleRendererOptions
 *   THE WARM POLICY (with `strictPlay`, default `standIns: false`, `needMissPolicy: 'block'`): `standIns: false` draws no program in place of the one a draw asks for (no superset, no universal); the loading call builds the exact
 *   image of what the live content can bind instead. `needMissPolicy` is what a draw does when its program is still missing after loading: `'block'` waits for
 *   it (counted in `debugStats.needMiss`), `'defer'` skips the draw. `needMissWarn` logs each miss (on by default under `__MANTLE_DEBUG__`). `warmBindSet`
 *   (default: on with `standIns: false`) is the pass that builds that image; `warmEngineCandidates` also links every candidate engine's program (over-builds).
 *   `eagerPrograms` links the base fill program at creation; `lazyImagePrograms` defers the image programs to the first image draw.
 *   `memoryBudgetBytes` bounds the GPU bytes the library holds on the context (`null` / `Infinity` / absent: no budget). Optional resources past it are refused with
 *   one warning each and caches are evicted in a fixed order, never anything the current frame used; see `getMemoryStats()` and the README, Memory.
 *   `groupAtlas: false` gives every plain group (a faded fill+stroke leaf, a faded instance layer) its own accumulator and its own pass pair, as before the group atlas; the default shares one atlas target and one composite pass between the groups of a run.
 *   `onContextLost(event)` runs on `webglcontextlost` (the renderer has already called `preventDefault()` so the browser may restore the context).
 *   `onContextRestored(event)` runs on `webglcontextrestored`, after the renderer marked itself `needsRecreate`: call `renderer.dispose()` and create a new
 *   renderer and new bundles there; the old renderer cannot draw on the restored context.
 */

/**
 * Byte-accurate memory report of a renderer's WebGL context (`renderer.getMemoryStats()`).
 * @typedef {{
 *   disposed: boolean,
 *   budgetBytes: number,
 *   gpu: { totalBytes: number, textureBytes: number, bufferBytes: number, renderbufferBytes: number, peakBytes: number, resources: number,
 *     byCategory: Record<string, { bytes: number, resources: number }>, unpatched: string[] },
 *   caches: {
 *     filterCache: { entries: number, bytes: number, accountedBytes: number, retainBudgetBytes: number },
 *     pools: null | { rt: object, coverage: object, shapeTargets: { targets: number, bytes: number }, pingTargets: { targets: number, bytes: number }, categoryBytes: number },
 *     atlas: { bytes: number, size: number },
 *     pointLists: { lists?: number, bytes: number },
 *     staticCache: { bytes: number },
 *     loopBlinn: { projectedBytesInUse: number, projectedCapBytes: number },
 *     frameTargets: { bytes: number },
 *   },
 *   bundles: null | Array<{ id: number, label: string|null, shapes: number, gpuBytes: number, textureBytes: number, bufferBytes: number,
 *     renderbufferBytes: number, byCategory: Record<string, number>, cpuBytes: number, disposed: boolean }>,
 *   cpu: { bundleBytes: number|null, workers: { loopBlinn: { pendingJobs: number, pendingInputBytes: number } } },
 *   features: Record<string, object|null>,
 *   programs: { created: number },
 *   preparation: { highWater: { gpuPeakBytes: number, cpuTransientBytes: number, heapPeakDeltaBytes: number, label: string },
 *     recent: Array<{ label: string, gpuPeakBytes: number, cpuTransientBytes: number, heapPeakDeltaBytes: number|null, ms: number }>, open: string[], heapSampled: boolean },
 *   policy: { order: string[], overBudgetBytes: number, evictions: Record<string, { count: number, bytes: number }>,
 *     refusals: Record<string, { count: number, bytes: number }>, enforcements: number },
 * }} MantleMemoryStats
 */

/**
 * Methods and state installed after renderer initialization. This explicit
 * contract is required because TypeScript cannot infer properties added with
 * `Object.defineProperties` to the synchronously returned renderer stub.
 *
 * @typedef {object} MantleRendererApi
 * @property {boolean} showTriOutline
 * @property {boolean} showBBoxes
 * @property {(bundle: object|null) => void} setBundle
 * @property {(target?: object) => void} render  Draws the bound bundle (or `target`). Its first frames use
 *   the general fill program: the bundle's specialized one is used once its GPU pipeline is built, in frame
 *   slack (45 frames under 20 ms, ~0.75 s at 60 fps) or, without slack, after 60 frames and one second
 *   (`opts.psoWarmMaxWaitFrames`). Call `precompileFills()` at load to draw it from the first frame.
 * @property {() => void} invalidateRenderState
 * @property {() => void} markGeometryDirty
 * @property {(enabled: boolean) => void} _setFilterBbox
 * @property {(enabled: boolean) => void} _setInstancedFast
 * @property {(bundle: object) => boolean} _drawBundleUnifiedFill Internal unified submission.
 * @property {(enabled: boolean) => void} setStrokePartition
 * @property {(enabled: boolean) => void} setStrokeGates
 * @property {(enabled: boolean) => void} setCoverAaReach
 * @property {(enabled: boolean) => void} setStrokeExactAa
 * @property {(enabled: boolean) => void} setSdfPrimitives
 * @property {(defines: string[]|null) => void} __setAbDefines Internal shader diagnostic.
 * @property {() => void} dispose  Idempotent. Afterwards the draw, frame, prepare, prewarm, await and warm entries do nothing and allocate nothing,
 *   `createImage` returns null, and `createBundleHandle` / `createIncrementalStroke` throw.
 * @property {() => string[]} __glAuditState Internal: compare the GL
 *   pipeline-state shadow against the driver ([] = agree). Diagnostic only.
 * @property {boolean} isContextLost  True from `webglcontextlost` until the renderer is disposed: it stays true after the restore, because a restored
 *   context does not revive this renderer (see `needsRecreate`). While lost the draw entries do nothing; `awaitLbReady` / `awaitEngine` resolve false,
 *   `warmScene` reports `complete: false`, `prepareBundle` returns false and `precompileFills` throws.
 * @property {boolean} needsRecreate  True once the context came back after a loss. The renderer's programs, uniform locations and every bundle made
 *   before the loss are dead: `beginFrame`, `render`, `drawBundle`, `drawBundleInstanced`, `drawInstance`, `submitBundle`, `drawImage`, `drawSprite`,
 *   `setBundle`, `createBundleHandle`, `createImage` and `precompileFills` throw until the host calls `dispose()` and creates a new renderer and bundles
 *   (the `onContextRestored` option is the place). `dispose()` still works.
 * @property {(widthPx: number|null, heightPx?: number, dpr?: number) => void} setViewport  Sizes truncate to whole pixels and clamp to [1, 32767];
 *   NaN and non-numbers throw; null returns to the canvas's own size.
 * @property {(scale: number, opts?: {dpr?: number}) => ([number, number]|null)} setResolutionScale  `scale` clamps to [0.05, 4]; NaN and non-numbers throw.
 * @property {number} resolutionScale
 * @property {(clearColor?: [number,number,number,number]|null) => void} beginFrame  `clearColor` is null / absent or four finite numbers; anything else throws. The clear color is STRAIGHT (non-premultiplied) RGBA in 0..1, as a CSS
 *   color is; the renderer premultiplies it for the canvas, and the native scene and exportFrameSVG write it as `rgba(...)`. `null` skips the clear.
 * @property {() => void} endFrame
 * @property {(opts?: object) => Promise<string|object>} exportFrameSVG
 * @property {(enabled: boolean) => boolean} setFrameCapture
 * @property {boolean} frameCaptureEnabled
 * @property {(x: number, y: number, width: number, height: number) => void} setScissorRect  Truncated to whole pixels; x and y clamp to +-2^30, width and height to
 *   [0, 2^30]; NaN and non-numbers throw.
 * @property {() => void} clearScissorRect
 * @property {(texture: object|null) => void} deleteClipTexture
 * @property {(target: object, opts?: object) => object|null} renderClipCoverage
 * @property {(target: object, opts?: object) => void} setNodeClip
 * @property {(target: object) => void} clearNodeClip
 * @property {(target: object, opts?: DrawBundleOptions) => void} drawBundle
 *   `dstRect` [x, y, w, h] in viewport pixels (y-down) draws the bundle into that rectangle
 *   instead of the whole viewport; `fit` is a `preserveAspectRatio` value ('xMidYMid meet' by
 *   default, 'none' to stretch, '… slice' to cover); `clipToRect` (default true) scissors the
 *   draw to the rect.
 * @property {(target: object, opts?: DrawBundleOptions) => (Float32Array|null)} bundleDrawMatrix
 *   The em → viewport-pixel matrix (column-major mat3, y-down) for the draw
 *   `drawBundle(target, opts)` would perform; pass it as `fillHitShape`'s `worldMatrix`.
 * @property {(target: object, opts?: DrawBundleOptions & {zOrder?: number}) => void} submitBundle
 * @property {(bundle: object) => boolean} prepareBundle
 * @property {() => Promise<boolean>} warmCPatchPool  Warms the shared CPatch conversion workers.
 *   Await during loading; resolves false when workers are unavailable or fail. Does not prepare
 *   a bundle or its GPU pipelines. Repeated calls share the same completion promise.
 * @property {(states: Array<{name?: string, bundle?: object, engine?: string, draw: () => (void|Promise<void>)}>, opts?: {maxPasses?: number, fenceTimeoutMs?: number, readyTimeoutMs?: number}) => Promise<{complete: boolean, programs: number, ms: number, states: Array<{name: string, ready: boolean, passes: number, stable: boolean, programsCreated: number, variantsAdded: number, pipelinesReadied: number, fenced: boolean, error: (string|null)}>}>} warmScene
 *   Warms the draw states a scene will use and says whether it is warm. Each state's `draw` runs the exact future draw (canvas, viewport,
 *   transform, blend, overrides, morph pose) behind a loading screen; after every pass the renderer fences, runs `precompileFills`, fences
 *   again and compares what was built. A state is `stable` when a whole pass built nothing; passes repeat until then or `maxPasses` (8).
 *   Program counts include engine readiness and draw/warm passes. They cover all library programs in the current GL context generation,
 *   including shared helpers and other renderers.
 *   A context-generation change fails the state. The legacy memory-stat program count retains its renderer-local scope.
 *   `complete` is true only when every state was ready (when `bundle` and `engine` are given), stable and fenced. The first visible frame must still
 *   clear the warm pixels.
 * @property {(bundle: object, engine: string, timeoutMs?: number) => Promise<boolean>} awaitEngine
 * @property {(bundle: object, timeoutMs?: number) => Promise<boolean>} awaitLbReady  Resolves true when the bundle's Loop-Blinn meshes have landed. It starts the unified variant and tries up to three rounds for it, but returns on the mesh: a true does not promise the variant is linked (the loading call or frame slack finishes it). Under 'auto' a STATIC bundle takes the cover pass
 *   and no mesh is built for it, so this resolves false at once; a morph, a streamed bundle, `unifiedFill: 'force'`, CPatch and a pinned mode (setLoopBlinnFill('on'|'only')) still build and resolve true.
 *   `debugStats.fillRouteReason` names the route class of the last drawn bundle ('static-cover', 'morph', 'stream', 'force', 'pinned-mode', ...); `debugStats.unifiedFillGate` reports 'static-cover' when it declines.
 * @property {(bundles: (object[]|null)) => void} setSceneUnion  Declares the bundles one scene draws: bundles whose fill programs share a kernel class bind one
 *   program (the union of their kernels, the intersection of their omissions). Pixels are unchanged; program, link and first-pipeline counts fall.
 *   Pass null to clear.
 * @property {(bundle: object) => string[]} _variantDefinesNow  The fill defines this bundle's draw would bind now (tests, probes).
 * @property {(bundle: object) => void} prewarmBundle
 * @property {(bytes: number) => void} setLoopBlinnMemoryBudget  A number of bytes >= 0 (`Infinity` is no limit); NaN, negatives and non-numbers throw.
 * @property {() => Record<string, number|boolean>} getFillPolicyOptions  The effective row-gate / E_MIN options (aacPointsRowGate, aacPointsColorMatrix, aacPointsBucket, aacPointsExtMax, aacCoverExtMin, aacCoverExtMax, aacPointsBytesBudget, aacPointsRunsMax, aacPointsRowsMin, aacPointsBase, aacPointsDepthGain, aacPointsMaxPoints, lbMinExtentPx, lbMinExtentShare), defaults included.
 * @property {(patch: Record<string, number|boolean|null>) => Record<string, number|boolean>} setFillPolicyOptions  Set any of them at run time (null restores the default; aacPointsRowGate false and lbMinExtentPx 0 turn the rules off); returns the effective values. The flags (aacPointsRowGate, aacPointsColorMatrix, aacPointsBucket, cpatchAuto) take a boolean, the rest a number >= 0 (Infinity is no limit); NaN and any other type throw, the patch is validated whole before any option changes, and a key that names no option is ignored with one warning. lbMinBundlePx2 and aacPointsBufferBudget are creation options and are not set here.
 * @property {(bundles: any, options?: {unitPx2?: number, viewport?: [number, number], perRow?: boolean}) => {bundles: any[], total: Record<string, number>}} estimateRouteBytes  bytes per route, per bundle and per row, before any draw
 * @property {(opts?: {bundles?: boolean}) => MantleMemoryStats} getMemoryStats  GPU bytes by category, cache and bundle (exact against the allocating calls), CPU bytes, worker inputs, programs, the preparation peak and the budget policy counters. `bundles: false` skips the per-bundle rows.
 * @property {(bytes: number|null) => void} setMemoryBudget  Bound the GPU bytes held on the context (null / Infinity: none; a negative or non-number throws). Optional resources are refused with a warning and caches are evicted in order (filter results, idle pools, opaque prepass meshes, instanced meshes, the transient handles of bare draws, point lists, atlas), never what the current frame used. The handles of createBundleHandle are not evictable.
 * @property {() => number} getMemoryBudget
 * @property {() => void} resetMemoryPeaks  Restart the GPU high-water and clear the preparation log.
 * @property {(bytes: number) => void} setLoopBlinnShapeMemoryBudget
 * @property {(opts?: {forceCdt?: boolean}) => void} setLoopBlinnMeshOpts
 * @property {() => number} getLoopBlinnMemoryUse
 * @property {(bundle: object, opts?: object) => void} drawInstance
 * @property {(source: any, opts?: object) => (object|Promise<object|null>|null)} createImage  null for an unsupported source or a pixel array shorter than width * height * 4.
 * @property {(source: any, opts?: object) => boolean} drawImage
 * @property {(sel: {route?: 'none'|'lb'|'cpatch'|'cpatch-auto'|'auto', kernel?: 'slug'|'aac'|'hard-band'|'hard-tree'|'auto',
 *   commit?: boolean, cpatch?: boolean, primitives?: 'on'|'off'|boolean}) => void} setFillEngine  `commit: false` with route 'auto' returns to the
 *   DEFAULT 'auto' without making the build commitment an explicit selection carries; `cpatch: true` (or `route: 'cpatch-auto'`) includes CPatch in static per-row auto selection. null / undefined leaves an axis alone; a value outside
 *   the vocabulary throws before any state changes ('only' and 'force', which getFillEngine reports, are selected with setLoopBlinnFill('only') and the unifiedFill: 'force' option). A pin draws at any size and takes the cost; `debugStats.engines.declines` records one that could not draw: 'hard-tree' on a bundle without its winding tree, a row with no CPatch geometry.
 * @property {(sel: {policy?: 'auto'|'on'|'off'|boolean, minSavedPxPerVertex?: number, maxMode?: 1|2}) => void} setStrokeStrip  the conforming strip covers of stroke rows (an unknown policy or a maxMode other than 1 or 2 throws; minSavedPxPerVertex clamps to >= 0, NaN throws)
 *   (importSvg builds them by default): 'auto' takes one per row where the device pixels it saves per vertex reach minSavedPxPerVertex (default 64), 'on'
 *   takes every eligible row, 'off' keeps the quads; maxMode 1 never takes a self-overlapping strip (which needs a depth attachment).
 * @property {() => {route: string, kernel: string, routeCommitted: boolean, cpatchAuto?: boolean}} getFillEngine  route
 *   also reports 'only' (LB with no Slug fallback) and 'force' (unifiedFill: 'force'); kernel also
 *   reports the no-AA pins; routeCommitted says whether 'auto' was selected or merely left alone; cpatchAuto reports whether CPatch is active in the 'auto' decision tree.
 * @property {(mode?: 'off'|'auto'|'on'|'only'|boolean) => void} setLoopBlinnFill  true is 'on'; false, null and no argument are 'off'; any other value throws.
 * @property {(mode?: 'off'|'auto'|'on'|'only'|boolean) => void} setLoopBlinnMorphFill
 * @property {(source: any, instances: object[], opts?: object) => number} drawImageInstanced
 * @property {(target: object, instances: object[], opts?: object) => number} drawBundleInstanced
 * @property {(target: object, sprite: string|[number,number], opts?: object) => boolean} drawSprite
 * @property {(target: object, sprite: string|[number,number], instances: object[], opts?: object) => number} drawSpriteInstanced
 * @property {(bundle: object, opts?: object) => object} createBundleHandle
 * @property {(opts?: {draw?: boolean, futureStates?: boolean}) => number} precompileFills  BLOCKING loading call, kept for callers that want it: it waits for every
 *   pending link (the main thread is frozen until the driver finishes them: seconds on a cold GPU cache) and ends with a GPU read-back
 *   barrier. Links loaded fill variants and attempts pipeline draws within the renderer's `precompileFillsBudgetMs` (default 800).
 *   Unvisited bundles remain queued for a later call. `draw:false` links without pipeline draws;
 *   first visible use can still compile a point program or build a pipeline. `futureStates: true` (or the renderer option `warmFutureStates`) also warms the bundles under a
 *   rotated map and a recolor. Returns warm attempts in this call, not completed scene preparation. PREFER `precompileFillsAsync`, which does the
 *   same work without ever blocking the page.
 * @property {(opts?: object) => Promise<number>} beginWarmWindow  A warm window for a `strictPlay` renderer: builds the lean programs that play drew on a safety net (and the programs of a new size class), cooperatively, then resolves. The library opens windows itself when the screen is idle (see `strictPlay`); calling this is optional and only moves the work to a moment the app chooses (a results screen).
 * @property {(bundle: object, tags: string[]|null) => void} declareReach  The draw states this bundle can enter, named by the app: 'rotate', 'recolor', 'palette', 'channelLerp', 'overrides', 'strokeWidth', 'alpha' ([] = drawn as is only; null = undeclared again). The warm builds those and no others; a state outside them, drawn anyway, is a need miss in play. A shared pair morph reaches the union of its poses' states.
 * @property {(bundle: object, on?: boolean|null) => void} declareStream  This imported bundle will be streamed with updateBundleGeometry (false or null: it will not, again). Declared before the loading call, the warm builds what its updates bind, in place of the programs its content alone would need, so its first update links and builds nothing in play. A lightweight update also needs one update before the loading call.
 * @property {(bundle: object, opts?: object) => Promise<number>} awaitBundleReady  For a bundle created after the loading call: resolves 0 at once when every fill program its draw states and reachable sizes need was already built, otherwise opens one warm window and resolves when it is done. Call it behind your own screen before the bundle's first draw; cheap enough to ask per trial.
 * @property {(opts?: {draw?: boolean, timeoutMs?: number, warmTimeoutMs?: number, sliceMs?: number, viewport?: [number, number], viewports?: Array<[number, number]>, classes?: boolean, manifest?: object|string, minViewportPx?: number, maxViewportPx?: number}) => Promise<number>} precompileFillsAsync  The
 *   NON-BLOCKING loading call, and the one to await behind a loading screen. Awaits every
 *   bundle's analytic meshes (so the unified-route, area-split and kind-narrowed variants play will use are the ones warmed), warms the scene as
 *   drawn and under a rotated map and a recolor (variants, point programs, mask bakes, instanced programs), then waits for the GPU thread to
 *   drain what the warm draws queued, and resolves only when everything the first seconds of play will ask for is built, warmed and
 *   barrier-synced. It never waits on the driver: it works in budgeted slices (`sliceMs`, default 8) on timer turns, asks a program nothing until
 *   KHR_parallel_shader_compile reports it complete AND a fence says the GPU thread has caught up, and skips (and retries) a warm whose program
 *   is not ready; the loading screen keeps animating and answering input for the whole of it. Without KHR_parallel_shader_compile there is no
 *   way to ask whether a program is done, so the work runs synchronously (the documented fallback). With `opts.manifest` (see
 *   `exportWarmManifest`) only the recorded states are warmed. Resolves with the warm-attempt count. `timeoutMs` (default 20000) bounds the mesh
 *   wait and the drain; `viewport: [w, h]` / `viewports: [[w, h], ...]` (drawing-buffer pixels) are HINTS: starting points for the size classes warmed at load (engine choice follows the drawn scale). Size is a continuous input: a viewport change after loading (a drag, rotation, fullscreen, another display) is handled automatically -- once the size has settled for 350 ms, a scale class not yet warm is warmed in the background, a few ms a frame behind the fence gate, with the lean stand-ins drawing meanwhile (`debugStats.viewportWarm`). The app has nothing to do; `warmTimeoutMs` (default 180000) bounds the whole warm (`debugStats.coopLoad.incomplete` says if it ran out).
 * @property {(bundle?: object) => (object|object[]|null)} lbCensus  Cold-start diagnostics: where a bundle's analytic (Loop-Blinn) build stands
 *   (`state`: 'off' | 'skipped-by-type' | 'pending' | 'built-declined' | 'built-picked', with row counts); for every live bundle when none is given.
 * @property {() => object} exportWarmManifest  The draw states this renderer has met, per bundle (a bundle is named by a hash of its content), for a later
 *   session's `precompileFillsAsync({ manifest })`, `createRenderer(..., { warmManifest })` or `renderer.warm.add(sceneId, { manifest })`: those warm exactly the recorded
 *   states instead of every state a bundle could be drawn in, and a bundle the manifest does not know gets the exhaustive warm. Needs `recordWarmManifest: true`.
 *   Version 3 adds `format` and `shaders` (fingerprints of the build that recorded it), `bundleSet` (a hash of the bundle content keys), `pipelines` (every
 *   fill program x vertex layout x target kind x instancing x blend x color mask the session built) and `scales` (the live-resize scale classes it drew in),
 *   which let `renderer.warm` build a scene's programs WITHOUT its bundles. A manifest from another build (`shaders` differs) is `stale`: it is never an error.
 * @property {(c: {game?: string|null, active?: boolean, viewport?: number[], needed?: string[], declaredNeeds?: any}) => boolean} setWarmContext  The game context of the warm policy (`warm.setContext`): which game runs, its viewport, extra needed variant keys, a declared-needs manifest.
 * @property {any} _policy  Test and tool hooks of the warm policy (null unless `__MANTLE_DEBUG__`).
 * @property {WarmQueue} warm  The background warm queue: warm several scenes' shaders while the app is idle (a hub's boot), steer the work as the user acts.
 * @property {(opts: object) => object} createIncrementalStroke
 * @property {() => number} gpuMemoryEstimate
 * @property {object} debugStats
 * @property {(opts?: object) => boolean} enableStaticCache
 * @property {(key: string|null) => void} setInstanceGroup
 * @property {() => void} disableStaticCache
 * @property {() => void} invalidateStaticCache
 * @property {object|null} staticCache
 */

/**
 * Public surface returned by `createRenderer()`.
 * @typedef {MantleRendererApi & {ready: Promise<MantleRenderer>}} MantleRenderer
 */

export {};
