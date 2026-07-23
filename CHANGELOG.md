# Changelog

All notable changes to the Mantle JS package are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-23

This release expands the renderer beyond its original Slug-only fill path,
adds game-oriented dynamic rendering controls, and completes broad correctness,
performance, and resource-lifetime work across rendering, animation, text,
fonts, SVG import, hit testing, and the DOM fallback.

### Added

- **Analytic Area Coverage (AAC).** Added a signed-area GPU fill kernel for
  lines, quadratics, cubics, and elliptical arcs without cubic conversion.
  `aacFill` accepts
  `false`, `true`, or `'auto'`; automatic selection uses device-space shape size
  and the segment types present in the bundle. Import-time `engine: 'slug' |
  'aac'` controls the band layout when an engine is known in advance.
- **Hierarchical winding fills.** Added a packed generalized-winding run tree
  with near-edge distance evaluation, exact hard handling for cusp and loop
  cubics, and a winding-only tree route for fills whose edge AA is provably
  hidden by an opaque stroke. SVG imports and `createTextBundle()` accept
  `gwnTree: true` when selecting a GWN fill configuration.
- **Exact edge coverage.** `exactEdgeAa: true` enables the Slug fill's isolated
  edge refinement using exact half-plane pixel-box area; it remains opt-in to
  avoid adding register pressure to fill-bound content. Loop-Blinn line and
  tangent-plane curve coverage now uses the same exact box-area primitive.
  `slopeAa: true` offers a lower-state secant reconstruction for near-exact
  diagonal-edge quality.
- **Interior occupancy acceleration.** SVG import now reserves default-on,
  output-identical occupancy grids for sufficiently large shapes. Occupancy
  grids and automatic GWN tier-3 cells are built off-thread and activate after
  upload; required winding-tree data remains synchronous. Rendering stays
  correct while acceleration is pending. Use `occupancyGrid: false` to opt out.
- **Occlusion culling.** `createBundle()` now omits draws fully covered by later
  opaque geometry while retaining the authored shape data. Boundary-coincident
  cases are resolved synchronously to prevent hidden-edge AA fringes, while
  additional safe culling runs in a worker. Topology-matched morphs are culled
  only when containment is conservatively certified for every interpolation
  value; inconclusive cases remain drawn. Use `occlusionCull: false` to retain
  every authored draw.
- **Opaque fill prepass.** On depth-backed targets, flat opaque fills with
  certified occupancy interiors write depth before the analytic fill so hidden
  fragments reject early without changing edge AA.
  `debugStats.opaquePrepassCount` reports when the path runs.
- **Dynamic stroke API.** `renderer.createIncrementalStroke()` provides an
  append-only paint-tool path with incremental tessellation, normal bundle draw
  integration, finalization to SVG/path data, and explicit disposal.
- **Runtime preparation and quality controls.** Added
  `renderer.setResolutionScale()`, `renderer.resolutionScale`,
  `renderer.prewarmBundle()`, `renderer.awaitLbReady()`, and
  `renderer.precompileFills()` for dynamic resolution, nonblocking warm-up,
  deterministic analytic readiness, and loading-screen pipeline preparation.
- **Ordered frame submission.** `renderer.submitBundle(target, { zOrder })`
  queues draws until `endFrame()`, paints lower values first, and preserves
  submission order for ties.
- **Renderer diagnostics.** `setDiagnostics()` now exposes opt-in engine/draw
  traces, stall reporting, and cache dumps. Aggregate traces are available
  through `diagnosticTraces()` and reset with `clearDiagnosticTraces()`.
- **Independent nine-slice instances.** `bundle.nineSliceInstance()` creates
  per-draw sliced views that share source textures while keeping independent
  geometry, bounds, and cache generations.
- **Text run metrics.** Text bundles expose refreshed `runMetrics` with
  typographic bounds, first and last baselines, line count, and final-line
  advance, including for empty runs.
- **Raster recoloring.** `drawImage()` accepts per-draw `colorMatrix` and
  `colorMatrixOffset` before tint, with equivalent output on the native-SVG
  fallback.

### Changed

- **Diagnostics and debug controls.** Pixel-changing A/B hooks now require
  `globalThis.__MANTLE_DEBUG__ = true`; production renderer selection and
  Loop-Blinn policy use `forceNative`, `setLoopBlinnFill()`, and
  `setLoopBlinnMeshOpts()`. Diagnostic work is disabled by default so normal
  draws retain only a flag check.
- **Static cache strategies.** Cache tiers now use the descriptive
  `WholeAsset`, `ViewportWindow`, and `SharedGroup` names. Viewport targets
  preserve canvas projection and pixel density; shared targets are isolated by
  WebGL context and safely reallocate, adopt, and release their budget slots.
  Whole-asset cache bakes record the content rect and composite only that
  source region, so moved filtered caches no longer stretch from the wrong edge.
  Deprecated `ForceA1` and `ForceA3` aliases remain; the former no-op `ForceA2`
  was removed and numeric strategy `3` now selects `ForceViewportWindow`.
  `CacheReason.LevelNotImplemented` was replaced by `UnsupportedFeatures`.
  Direct `createStaticCache()` consumers must call `dispose()`.
- **Filter-result caching.** Filter outputs are keyed per cache owner and shape,
  kept in an LRU independent of the bare-draw handle LRU, and retained across
  transient handle eviction so alternating mounts do not re-evaluate static
  filters. Persistent handles keep distinct owners when they share a bundle.
- **Automatic scene setup.** `createMantleScene()` now requests stencil while
  disabling browser MSAA, depth, and preserved drawing buffers, and asks for a
  desynchronized high-performance WebGL2 context. Pass `glAttribs` to override
  these defaults. `toScene(sections, opts)` forwards bundle-creation options on
  WebGL and accepts them for native signature parity.
- **Loop-Blinn routing.** Expanded analytic routing across static, streamed,
  instanced, and morph draws. Eligible solid bundles use a combined draw;
  gradients and images can batch through per-shape paint data; composed,
  translucent, stroked, clipped, masked, or filtered shapes use coverage
  composition; unsupported individual shapes retain ordered Slug fallback.
  Automatic static routing is GPU-balanced for compact cubic and arc meshes;
  consistently slower geometry classes skip construction entirely, while
  explicit Loop-Blinn modes build those classes on demand.
- **Shape morphing.** Elliptical arcs now interpolate in endpoint form and are
  converted back on GPU paths, while the DOM fallback emits endpoint-form `A`
  commands directly. This preserves welded contours and avoids center-parameter
  branch changes. Arc sweeps are split at half turns, stroke join tangents are
  rebuilt from interpolated geometry, and gradient stops, clips, masks, filters,
  images, strokes, translucency, and recolor state remain active on analytic
  morph routes.
- **Filter execution.** Filter graphs now allocate render targets exactly to
  quantized canvas-space output rects instead of full-canvas targets. Every
  primitive maps between input and output rects explicitly, and filtered-shape
  caches retain the output rect needed for later composition.
- **Dynamic text identity.** `createTextBundle()` preserves `tb.bundle` object
  identity across `setText()` and `setStyle()`, including empty/non-empty
  transitions. `setText()` skips rebuild when the string is unchanged and no
  style object is supplied. Existing renderer handles detect the geometry
  generation change, refresh buffers, and invalidate dependent caches
  automatically.
- **Rendered-geometry hit testing.** Fill hit tests now walk the bundle's packed
  band and curve data with the renderer's coverage rules. Large shapes also use
  cached winding trees, near-segment pruning, and pointer-coherence memoization
  for fill and stroke queries. Arc junctions use half-open parameter intervals
  so a shared endpoint is not counted twice.
- **Instanced color state.** `drawBundleInstanced()` now supports per-instance
  tint, bias, and color-matrix offsets without mutating caller-owned instance
  objects. Diagonal transforms stay on the GPU instanced path; general matrices
  compose correctly through the loop path.
- **Bundle layout and streaming.** The default imported band layout serves both
  Slug and AAC, cover-quad VBOs omit non-drawable chunk headers, and geometry
  generation changes consistently invalidate masks, analytic meshes, handles,
  and static caches.
- **Package output and typings.** `loadShaders()` / `fromPackage()` prefer
  pre-assembled `shaders/generated/` and fall back to marker assembly.
  Publication uses an explicit JS/GLSL allowlist, declaration generation clears
  stale output, and `createRenderer()` returns the declared `MantleRenderer`
  TypeScript surface.

### Fixed

- **Fill and Loop-Blinn correctness.** Fixed stable quadratic roots at large
  viewports, exact-predicate constrained triangulation, even-odd
  self-intersections, cubic overfill and missing exterior ramps, arc-strip and
  corner partition gaps, acute-tip and crossing-junction coverage, counter-hole
  exterior haze, same-side crotch clipping, exact distance for thick elliptical
  strokes, translucent double-composition along shared mesh edges,
  similarity-cache state loss, lean-program interior-chain fallthrough,
  oversized-mesh fallback, and per-shape fallback ordering.
- **Morph correctness.** Zero-radius arcs preserve their SVG line chord and
  topology, arc endpoints remain joined in both GPU and DOM paths, cusp splitting
  no longer changes authored morph topology, streamed/morphed draw lists avoid
  stale static occlusion results, and morph hit tests evaluate the current `t`
  and visibility overrides even on GPU-only routes. Morph shader/program
  resources are shared and released without cross-renderer deletion. Authored
  touching subpaths and exact per-shape curve ranges retain correspondence
  instead of producing ghost crossfades.
- **Filter, group, and mask composition.** Fixed filter roots and disconnected
  nodes leaking render targets, exception and nested-evaluation cleanup,
  multi-primitive chains dropping sibling nodes, rect-local targets rescaling or
  clipping output, mismatched filter origins, stale recycled pixels,
  filtered/COLR output inside groups, single-child opacity/blend groups,
  group-relative `objectBoundingBox` clips and masks, nested clip intersections,
  external node clips on analytic routes, gradient strokes disappearing from
  masks, and CSS color-dodge/burn endpoint behavior.
- **Static cache correctness.** Fixed bundle-local filter-cache collisions,
  cache feedback loops, missing depth/stencil attachments on cache bakes,
  stale bakes after resize, palette, or external-clip changes, off-screen bakes,
  filtered nine-slice clipping, and shared-target growth and disposal.
- **Nine-slice correctness.** Re-sliced bundles refresh already-bound handles,
  and filtered shapes stretch to the sliced target instead of being clipped to
  their native bounds.
- **Font and text conformance.** Corrected CFF2 blend/hint handling and 32-bit
  INDEX counts, CID-keyed CFF1 local subroutines, Extension-wrapped GSUB/GPOS,
  COLRv1 paint numbering and sweep angles, MATH variant advances, AAT
  `morx`/`kerx`, WOFF2 decoding bounds, embedded bitmap metrics, paragraph bidi,
  composite `gvar`, cmap format 2, vertical advances, Thai/Lao shaping, legacy
  `kern`, mark attachment, multiline baselines, and ligature lookup behavior.
  Also fixed variation-store long-delta decoding, unsigned delta-map indexes,
  `gvar` region-edge scalars, STAT fallback-name offsets, transformed WOFF2
  glyph bitmaps, letter/word spacing, wrapped-mark anchors, and very long runs.
- **SVG conformance.** Corrected percentage lengths, `userSpaceOnUse` gradient
  percentages, `maskContentUnits`, paint-reference grammar, nested symbol
  viewports, dash scaling under transforms, marker orientation, incomplete point
  lists, path/arc degeneracies, effect/stroke bounds, compact arc flags,
  malformed post-close path recovery, CSS `grad` hue units, filter-type casing,
  document-order gradient-stop clamping, cyclic `<use>` references, and
  zero-opacity vector patterns.
- **Animation and scene behavior.** Negative-scale overrides retain reflection,
  retargeting an in-flight pose blend no longer jumps backward, repeated sprite
  morph pairs are reused, direct scene fills preserve even-odd rules, and DOM
  fallback geometry updates map bundle rows to the correct retained elements.
  Scene-to-SVG serialization scales elliptical-arc radii under supported uniform
  transforms.
- **Renderer lifetime and state.** Fixed cross-context GL cache reuse, stale
  fill-program uniforms after variant switches, worker-failure job loss, canvas
  resize leaks, filter and mask texture ownership, disposed analytic builders,
  texture-unit feedback, and incomplete program/VAO/FBO/renderbuffer teardown.
  Pending occupancy/occlusion callbacks now complete during worker disposal;
  occupancy results are generation-checked after streaming updates, and compact
  cover meshes keep shape-index buffers and draw ranges in bounds.
- **Feature inspection.** `featureSet.inspect()` now preserves linear, radial,
  and sweep-gradient subtype flags when inspecting uploaded bundles.

### Performance

- Fill programs specialize by engine and segment types, compile through
  `KHR_parallel_shader_compile` when available, warm outside draw calls, and can
  be fully prepared before gameplay. Queue drains are indexed/deduplicated and
  no longer introduce linear-shift overhead. Automatic Slug/AAC thresholds are
  balanced per curve family and hard fill remains limited to opaque strokes
  that provably hide fill-edge AA.
- Loop-Blinn mesh construction runs off the main thread, uses exact winding-tree
  probes and spatially indexed boundary candidates for complex contours,
  isolates cubic features with substantially less subdivision, applies hard
  per-shape and per-bundle vertex caps, and batches compatible solid, gradient,
  and image shapes. Pixel-disjoint chain segments reject before clipping;
  simple convex translucent quadratic partitions omit unnecessary interior
  chains, while concave and holed partitions retain them. Cusp-free combined,
  direct, and coverage draws use the lean Loop-Blinn program.
- Occupancy and occlusion workers remove fragment walks and fully hidden draws
  without adding import-time stalls; failed worker jobs fall back to deferred
  main-thread execution instead of being dropped. Occupancy samples use
  interleaved xy storage rather than per-sample arrays.
- Bounding filter nodes, groups, backdrops, cache blits, and single-kind effects
  reduce render-target memory and fragment work to the affected screen region.
- Added concurrent image decoding, cached hit-test geometry, binary-search cmap
  lookup, linear ligature scans, shared text-segmentation instances, memoized
  variable-font coordinates, and reusable `gvar` working buffers.
- LB cache hashing computes primary and near-tie candidate axes in one contour
  walk; combined VBO assembly uses bulk typed-array copies, solid-only draws skip
  paint-texture allocation, and painter order is reused across frames. Slug-only
  and auto-ineligible renderers no longer enqueue unused LB worker builds or
  retain their mesh memory.
- Opaque overlapping fills use the depth prepass to skip covered interior
  fragments. `drawBundleInstanced()` retains compact header-free meshes per
  bundle and defers ordinary cover uploads, while bare-draw handles retain a
  small working set across alternating assets. Fill programs omit inactive
  palette, channel-lerp, and color-matrix paths. Certified opaque convex
  streaming bands can skip full interior-ramp crack healing.

[1.1.0]: https://github.com/MegaByte/mantle-js/releases/tag/v1.1.0
