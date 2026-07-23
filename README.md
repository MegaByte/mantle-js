# Mantle Vector Graphics — WebGL2

Mantle is a WebGL2 vector-graphics renderer for the browser. It imports SVG
(or shapes text) into a compact bundle — a curve table, per-shape metadata,
and cover quads, all typed arrays. Its coverage routes draw each shape as a
single quad whose fragment shader computes per-curve coverage through methods
optimized to that shape. They do not flatten curves, and anti-aliasing is
analytic and resolution-independent without MSAA.

The coverage renderer includes the original Slug band walk, signed-area AAC,
and a hierarchical winding-tree kernel. `aacFill: 'auto'` selects Slug or AAC
from each bundle's device-space size and segment types; `exactEdgeAa: true`
adds an opt-in exact pixel-box refinement to Slug, while `slopeAa: true` offers
a lower-state secant reconstruction for near-exact diagonal-edge quality.
Large imported shapes also receive asynchronous interior-occupancy grids by
default.

A separate analytic fill based on Loop-Blinn implicit curves covers the cases
where a mesh wins: GPU-resident shape morphs, streamed geometry, and compact
cubic or arc static meshes. Automatic mode avoids building analytic meshes for
straight, quadratic, mixed-curve, or otherwise consistently slower classes.
`setLoopBlinnFill('on')` builds and enables every eligible class on demand,
including gradient, image, and composed static fills; `'off'` forces the banded
coverage path everywhere.

## Install

```sh
npm install @kontek/mantle
```

Requires WebGL2 (`stencil: true`, `EXT_color_buffer_float`). Tested
on Chromium / Firefox / Safari (16+); Edge inherits Chromium.

TypeScript declarations for the full public API ship with the package
(`"types": "./types/index.d.ts"`, generated from the source JSDoc via
`npm run gen:types`), so imports are typed with no extra `@types` install.

## Quick start

```js
import { importSvg, createBundle, createRenderer } from '@kontek/mantle';
import { bundleShaders } from '@kontek/mantle/shaders';

// 1. Load shaders (self-locating fetch from the installed package) and
//    build the renderer, which owns the GL programs + state. Do this once.
const gl = canvas.getContext('webgl2', { stencil: true, antialias: false });
const shaders  = await bundleShaders.fromPackage();
const renderer = createRenderer(gl, shaders);

// 2. SVG → bundle struct (typed arrays) → GL textures + buffers.
const bundle = createBundle(gl, await importSvg(svgText));

// 3. Draw. The bundle is the render target, not a constructor arg.
renderer.render(bundle);
```

> The second argument to `createRenderer` is the **shader-source dict**, not
> the bundle — the bundle is passed to `render()`/`drawBundle()`. For a fully
> wired-up, no-boilerplate path (incl. the native fallback) see
> `createMantleScene()`, which auto-loads shaders for you.

### Rendering text

Text follows the same shape — shape a run into a bundle, then draw it:

```js
import { createRenderer, MantleFontAsset, buildTextRun, createBundle } from '@kontek/mantle';
import { bundleShaders } from '@kontek/mantle/shaders';

const gl = canvas.getContext('webgl2', { stencil: true, antialias: false });
const renderer = createRenderer(gl, await bundleShaders.fromPackage());

const font = new MantleFontAsset(new Uint8Array(await (await fetch('Inter.ttf')).arrayBuffer()));
const run  = await buildTextRun('Hello, world', font, [0, 0, 0, 1]); // async → bundle dict
renderer.render(createBundle(gl, run));
```

`buildTextRun(text, font, color?)` emits glyphs in font em-units; scale via
the renderer's view/world matrix. For mutable/streamed text use
`createTextBundle`; for tag markup (`<color>`, `<b>`, sprites) use
`buildFromMarkup`; to measure without emitting use `measureText`.

## Capabilities

In brief:

- **Rendering** — Slug, AAC, hierarchical winding, hard interior, and
  Loop-Blinn fill routes; native line/quad/cubic/elliptical-arc segments;
  default-on interior occupancy and opaque-occlusion culling; exact analytic
  AA without MSAA. Depth-backed targets can preclaim certified opaque interiors
  to reject hidden fragments. Filters render into bounded per-node targets and
  cache their output regions instead of allocating a full canvas for every
  primitive.
- **SVG** — full static SVG 1.1/2 element set: paths (with native arc
  segments), shapes, `<text>`/`<tspan>`/`<textPath>`, `<use>`/`<symbol>`,
  the full stroke model (caps, joins incl. exact miter/bevel, dash arrays,
  gradient + image stroke paint), gradients, patterns, markers,
  `<clipPath>`, `<mask>` (luminance + alpha),
  `<filter>` (all `fe*` primitives via a generic filter graph), nested SVG,
  CSS (selectors, `@media`/`@supports`, `calc`/`var`, CSS Color 4/5).
- **Fonts** — aims to render *any* TTF/OTF faithfully: CFF1/CFF2 + glyf
  outlines, WOFF2, TTC; full OpenType shaping (GSUB/GPOS/GDEF, all lookup
  types) with script shapers for Latin, Arabic, Indic, Thai/Lao, Hangul, and
  USE (Khmer/Myanmar/…); **Apple Advanced Typography** (`morx`/`mort`/`kerx`/
  `ankr`/`feat`) for AAT-only faces like Zapfino; a UCD-17.0-driven Unicode
  text layer — normalization (UAX #15), grapheme segmentation (UAX #29), line
  breaking (UAX #14), bidi (UAX #9), script itemization (UAX #24), vertical
  orientation (UAX #50), case mapping/folding — passing the official UCD
  conformance suites at 100%; every cmap
  format incl. format-14 variation sequences; default-ignorable suppression;
  all four color-glyph formats (COLR v0/v1, CBDT/CBLC, EBDT/EBLC, sbix,
  SVG-in-OT); variable fonts (fvar/gvar/HVAR/VVAR/MVAR/avar/STAT, CFF2 blend);
  MATH; JSTF kashida justification.
- **Animation** — per-shape override tables, two-pose shape morph, N-key
  timelines, plus Lottie/Rive-derived modifiers (trim path, repeater,
  pucker/bloat, offset path, polystar, feather, text-on-path). Shape morphs
  preserve elliptical arcs in endpoint form and retain strokes, gradients,
  images, clips, masks, filters, translucency, and recolor state on supported
  analytic routes.
- **Game/runtime integration** — dynamic resolution scaling, loading-screen
  fill precompilation, asynchronous Loop-Blinn readiness, persistent bundle
  handles, stable `zOrder` frame submission, live instancing with per-instance
  color state, independent nine-slice views, and incrementally growing paint
  strokes.
- **Color emoji & rich text** — tag-based markup runs (`<color>`, `<size>`,
  `<b>`/`<i>`, `<link>`, …) for runtime text.
- **No-WebGL fallback** — `@kontek/mantle/fallback` renders the source SVG via
  the browser's native SVG engine (incl. morph → animated `path d`) when WebGL2
  is unavailable; `chooseBackend()` picks automatically.

## API surface

### Root package

- `importSvg(svgText, opts) → Promise<BundleData>` — parses SVG,
  returns an in-memory bundle struct. Opts include `defaultFill`,
  `defaultStroke`, `defaultStrokeW`, `svgTextLayout` (for `<text>`
  support; pass `buildSvgTextGlyphs` from the font subpath), `engine`
  (`'slug'` or `'aac'`, to pin the packed band layout), `gwnTree`, and
  `occupancyGrid`. Use `engine: 'aac'` only when the bundle will always draw
  through AAC; its compact layout intentionally omits useful Slug vertical
  bands. A GWN fill define requires `gwnTree: true`. Occupancy acceleration is
  enabled by default for sufficiently large shapes and activates
  asynchronously; pass
  `occupancyGrid: false` to disable it. Arcs remain dedicated elliptical-arc
  records end-to-end rather than being flattened or cubic-approximated: the
  Slug path evaluates them directly, and the analytic fill uses rational-quad
  pieces.
- `createBundle(gl, bundleData, opts?) → Bundle` — uploads textures + vertex
  buffers to a WebGL2 context. Safe opaque-occlusion culling is enabled by
  default; pass `{ occlusionCull: false }` to preserve every authored draw.
- `createRenderer(gl, shaderSources, opts?) → Renderer` — owns shaders +
  state; `shaderSources` is the dict from `bundleShaders.fromPackage()` /
  `loadShaders()` / `@kontek/mantle/shaders/generated`. `renderer.render(bundle)`
  draws a bundle (or animation handle). Synchronous by
  default (fully usable on return). Pass `opts.asyncShaderCompile: true`
  to defer shader link + uniform capture off the main thread via
  `KHR_parallel_shader_compile` — useful on contended/weak GPUs where
  linking ~20 programs can stall tens of ms; then `await renderer.ready`
  before the first draw. `renderer.ready` is a promise that exists in
  both modes (already-resolved in the default sync path). Important fill
  options include `aacFill: false | true | 'auto'`, `exactEdgeAa: true`,
  `slopeAa: true` (both opt-in), `typeOmit`, `disableFillVariants`, and
  `fillDefines` for specialized kernels such as GWN.
- `renderer.drawBundle(target, opts?)` / `renderer.render(target)` —
  accept either a bundle or an animation handle (shape morph,
  timeline, override table); the renderer auto-unwraps `.bundle`.
- `renderer.submitBundle(target, { zOrder, ...opts })` — queues a draw until
  `endFrame()`. Lower `zOrder` values paint underneath; ties preserve submission
  order. Outside a frame it behaves like `drawBundle()`.
- **Runtime controls** — `renderer.setResolutionScale(scale, { dpr? })`
  resizes the backing store while preserving its CSS size; call it after
  layout and on resize, not every frame. `renderer.prewarmBundle(bundle)`
  starts the likely fill variants, `await renderer.awaitLbReady(bundle)`
  waits for an enabled off-thread Loop-Blinn build when the first visible frame
  must use it (and resolves `false` when passive automatic policy deliberately
  skips the mesh); `prepareBundle()` remains an explicit request to build it.
  `renderer.precompileFills()` drains loaded fill pipelines behind a loading screen.
- **Live instancing and mounts** — `renderer.drawBundleInstanced(bundle,
  instances, shared?)` accepts per-instance `worldMatrix`, `alpha`, `tint`,
  `colorMatrix`, and `colorMatrixOffset`; diagonal color transforms remain
  GPU-instanced. `renderer.createBundleHandle(bundle)` keeps one mount's GL
  state resident. `bundle.nineSliceInstance(opts)` creates an independent
  drawable nine-slice view sharing the base bundle's textures, so one asset can
  be mounted at several sizes simultaneously.
- `renderer.createIncrementalStroke({ width, bbox, color?, capStyle?,
  joinStyle?, miterLimit?, points? })` — creates a paint-tool stroke whose
  `appendPoints()` updates only new segments. Draw `stroke.bundle` normally;
  `finalize()` returns `{ pathD, svg }`, and `dispose()` releases its GL state.
- `renderer.createImage(source, opts?) → ImageHandle` /
  `renderer.drawImage(handleOrSource, opts?)` — composite a raster
  image directly into the current frame (no SVG wrapper needed).
  `source` accepts the same forms as an SVG `<image>`: a `WebGLTexture`
  (not owned), `{width, height, data}` RGBA pixels, an
  `ImageBitmap` / `HTMLImageElement` / `HTMLCanvasElement` /
  `ImageData`, or a string href / data-URL / encoded bytes (async →
  use `await createImage(...)` then draw the handle). `createImage`
  uploads a reusable premultiplied texture (`{width, height,
  dispose()}`); pass it to `drawImage` every frame for the hot path,
  or hand `drawImage` a raw source for a one-shot upload.
  `drawImage` opts: `dstRect [x,y,w,h]` (viewport px, y-down),
  `worldMatrix` (column-major mat3, for rotation/skew), `srcRect
  [x,y,w,h]` (source sub-rect in px, for atlases/sprite-sheets),
  `alpha` (0–1), `tint [r,g,b,a]`, `colorMatrix` (column-major mat4)
  + `colorMatrixOffset` — the same per-draw recolor as `drawBundle`
  (`out = colorMatrix * in + colorMatrixOffset` on straight color,
  before the tint), so N blits sharing ONE image handle can each take
  their own colour — and `blendMode` (0 normal / 1 multiply
  / 2 screen / 4 darken / 5 lighten). Composes between
  `beginFrame`/`endFrame` like `drawBundle`.
- `createShapeMorph(gl, src, dst, opts?)` — t-parameter morph
  between two topology-matched bundles. `.setT(t)`, `.bundle` to
  pass to the renderer. Elliptical arcs interpolate in endpoint form so
  contours stay welded; analytic routes preserve supported paint, stroke,
  clip, mask, and filter composition.
- More animation builders — all return a handle exposing `.bundle` (plus
  `.setT(t)` / frame setters where applicable): `createShapeTimeline`
  (N-key timeline), `createSpatialBezierMorph` / `createPathDeltaMorph`
  (path-space morphs), `createSkinnedMorph` (bone-weighted),
  `createPoseStack` (additive poses), `createSpriteMorph` /
  `createSpriteTimeline` (sprite-sheet frames).
- `createOverrideTable(gl, bundle)` — per-shape fill / stroke /
  strokeWidth / tint / visibility / transform overrides. Drives
  animation systems (Lottie / Rive / SMIL).
- **Recolor** — `createPalette(gl, bundle)` for per-shape palette
  overrides, plus the `colorMatrix*` helpers (`colorMatrixIdentity`,
  `colorMatrixMonochrome`, `colorMatrixDualTint`, `colorMatrixTripleTint`,
  `colorMatrixCombine`) for building 4×5 color matrices.
- **Text** — `MantleFontAsset(bytes)` wraps a TTF/OTF; `buildTextRun` /
  `buildStyled` / `buildFromMarkup` shape a run into per-glyph geometry;
  `measureText` / `measureFromMarkup` measure without emitting;
  `createTextBundle` builds a mutable text bundle and accepts `gwnTree: true`
  for a GWN-capable text bundle; `buildSvgTextGlyphs` backs SVG `<text>`. A text
  handle preserves `tb.bundle` identity across `setText()` / `setStyle()`
  (including empty runs), so existing renderer handles update automatically.
  Use `tb.runMetrics.typoBBox`, `firstBaselineY`, `lastBaselineY`, `lineCount`,
  and `lastLineAdvance` for stable layout rather than the ink-tight
  `globalBBox`.
  `decodeIfWoff2` / `ttcFaceCount` are sfnt helpers.
- **Scene** — `createScene(...)` builds a bundle from a programmatic
  scene tree; `sceneToBundle` / `sceneToSvg` serialize a scene.
- **Static-scene cache** — `createStaticCache()` plus the `CacheStrategy`
  / `CacheLevel` / `CacheReason` enums (see the cache note below).
- `fillHitShape(bundle, x, y, opts?)` / `fillHits(...)` /
  `fillHitId(...)` — hit testing (`HitMode.Bbox`, `.Coverage`,
  `.Outline`, `.Auto`). Coverage fill tests walk the bundle's packed band and
  curve data with the renderer's edge rules, so the hit boundary matches what
  is drawn. Large shapes use cached winding trees and near-segment pruning;
  strokes include caps, joins, and dash arrays. Morph hit tests use the current
  pose and honor the morph's visibility table (or an explicit `overrides`
  table). Hit tests do **not** account for clip paths, masks, filters, override
  tint/transform, or other compositing effects; pass the draw's `worldMatrix`
  for coordinate parity.
- `setDiagnostics({ onWarn, onError, silent, colrTrace, stallMs,
  engineTrace, dumpCache })` — redirect or silence library warnings/errors
  (default: `console.warn` / `console.error`); `colrTrace: []` collects a
  per-node COLR filter-graph trace; `stallMs` / `engineTrace` / `dumpCache`
  opt into draw/engine/cache diagnostics (off by default — a single flag
  check on hot paths). Read aggregates via `diagnosticTraces()` and reset them
  with `clearDiagnosticTraces()`.
- `chooseBackend()` / `createMantleScene(...)` — render via the browser's
  native SVG engine when WebGL2 is absent. Same scene API surface; morph
  emits animated `path d`. The automatic WebGL path requests stencil, disables
  browser MSAA, depth, and preserved drawing buffers, and prefers a
  desynchronized high-performance context; pass `glAttribs` to override those
  defaults. `scene.toScene(sections, bundleOpts)` forwards bundle options on
  WebGL and accepts them for native signature parity. The native backend also
  exposes
  `createNativeScene` / `createNativeMorph` / `createNativeOverrideTable`
  / `createNativeTextBundle` / `createNativeTimeline` (also under
  `@kontek/mantle/fallback`).
- `inspect(bundle)` / `inspectAll(bundles)` / `Features` / `toNames` —
  feature-bitmask introspection (gradients / strokes / dash /
  vector-effect / clips / masks / filters / patterns / …) for
  distribution stripping. Exported from `@kontek/mantle/bundle` (the
  introspection subpath has no GL dependency).

The root barrel also re-exports lower-level building blocks that back the
API above and are each reachable from a subpath too: segment primitives
(`SEG_*` tags + `mkLine`/`mkQuad`/`mkCubic` + `*Contour` constructors),
cover-quad + meta packers (`getCoverQuadMesh`, `parseMetaBin`, texel helpers),
the shader toolchain (`bundleShaders`, `shaderFilesFor`, `loadShaders`),
and path-`d` helpers (`curveRangeToPathD`, `curvesToPathDMap`).

### Static cache note

The static-scene cache exposes three descriptive levels:

- `WholeAsset` (`ForceWholeAsset`) caches one fully visible bundle in a
  viewport-sized target. `Auto` can promote stable assets to this level.
- `ViewportWindow` (`ForceViewportWindow`) caches the viewport plus a
  configurable `viewportWindowMarginPixels` around it and reuses that bake for
  pans within the margin. It is opt-in because it did not improve the measured
  JS workloads enough to justify automatic promotion; test it against the
  direct path for the target game. Bundles using `non-scaling-size`,
  `non-rotation`, or `fixed-position` draw live because those vector effects
  intentionally cancel the projection compensation used by this level.
- `SharedGroup` (`ForceSharedGroup`) lets handles with the same
  `instanceGroupKey` share one target.

`ForceA1` and `ForceA3` remain deprecated aliases for compatibility. The
former no-op `ForceA2` was removed; numeric strategy value `3` now selects
`ForceViewportWindow`, and `CacheReason.LevelNotImplemented` was replaced by
`CacheReason.UnsupportedFeatures`.
Screen-space external clips also draw live because their texture contents can
change independently of bundle cache invalidation. Renderer-created shared
groups are isolated per WebGL context. Handles release cache state on disposal;
direct `createStaticCache()` consumers should call `dispose()` when finished.

### Subpath exports

Each `register*` module is a side-effect import — call it once at
app boot to enable the corresponding subsystem. A consumer that
doesn't import these subpaths pays nothing for them (the bundler
tree-shakes the readers + shapers).

| Subpath                                          | What it enables                            |
|--------------------------------------------------|--------------------------------------------|
| `@kontek/mantle/bundle`                  | Bundle introspection only (~2 KB gz).      |
| `@kontek/mantle/bundle/featureManifest`  | Feature-bits → required JS module map (distribution stripping). |
| `@kontek/mantle/svg`                     | SVG → bundle (~38 KB gz, no text).         |
| `@kontek/mantle/svg/auto`                | **Auto-register**: inspect an SVG and dynamic-`import()` exactly the filter / COLR handlers it uses — the SVG peer of `font/auto`. |
| `@kontek/mantle/renderer`                | WebGL bundle factory + render state machine. |
| `@kontek/mantle/fallback`                | No-WebGL native-SVG backend (`chooseBackend`, native morph/override/text). |
| `@kontek/mantle/shaders`                 | GLSL sources + build/feature-select toolchain (`assembleShader`, `minifyGlsl`, `shaderFilesFor`). |
| `@kontek/mantle/filterGraph`             | Generic filter-graph evaluator (SVG `<filter>` + COLRv1 dispatch). |
| `@kontek/mantle/animation`               | Animation primitives (overrides, shape morph, timelines). |
| `@kontek/mantle/hitTest`                 | Point-in-shape queries (no GL dep).        |
| `@kontek/mantle/scene`                   | Programmatic scene tree → Mantle bundle.   |
| `@kontek/mantle/font/auto`               | **Auto-register**: sniff a font's tables + scripts and dynamic-`import()` exactly the readers/shapers it needs (see below). |
| `@kontek/mantle/font/text`               | Lean text core: glyf outlines, LTR, default OT shaper (~73 KB gz). CFF, bidi, scripts, colour, variations are each opt-in below. |
| `@kontek/mantle/font`                    | Everything eagerly registered: all scripts + all OT readers + AAT (`morx`/`mort`/`kerx`/`ankr`/`feat`) + CFF + bidi (~92 KB gz). |
| `@kontek/mantle/font/formats/cff`        | CFF / CFF2 PostScript outlines (`.otf`). Glyf is always-on; this is opt-in. |
| `@kontek/mantle/font/color`              | COLR v0 + v1 + sbix + CBDT/CBLC + EBDT/EBLC + SVG-in-OT. |
| `@kontek/mantle/font/variations`         | fvar + gvar + HVAR + VVAR + MVAR + avar + STAT. |
| `@kontek/mantle/font/math`               | OpenType MATH.                             |
| `@kontek/mantle/font/formats/woff2`      | WOFF2 (Brotli + glyf-transform decode).    |
| `@kontek/mantle/font/typography/aat`     | Apple Advanced Typography (`morx`/`mort`/`kerx`/`feat`/`ankr`) for AAT-only faces (Zapfino, GeezaPro, …). |
| `@kontek/mantle/font/typography/legacyKern` | Legacy `kern` table (positioning — sits with `kerx` under typography, not formats). |
| `@kontek/mantle/font/typography/vertical`| VORG (vertical glyph origin).              |
| `@kontek/mantle/font/typography/baseline`| BASE table.                                |
| `@kontek/mantle/font/typography/bidi`    | UAX #9 bidi (RTL). Opt-in: the lean path is LTR passthrough until registered — import this whenever Hebrew/Arabic/mixed-direction text is possible. |
| `@kontek/mantle/font/typography/justification` | JSTF kashida justification (Arabic extender glyphs). |
| `@kontek/mantle/font/scripts/{arabic,hangul,indic,math,thai,use}` | Per-script shapers (Arabic joining + forms, Hangul jamo, Devanagari / Bengali / Tamil / Telugu / Kannada / Malayalam / Gurmukhi / Gujarati / Oriya / Sinhala, Thai / Lao, Khmer / Myanmar). |
| `@kontek/mantle/font/scripts`            | All script shapers in one barrel.          |

Finer-grained subpaths exist for advanced/tree-shaking use:
`@kontek/mantle/animation/colorMatrix` + `@kontek/mantle/animation/colorPalette`
(recolor helpers in isolation), `@kontek/mantle/core/metaBin` +
`@kontek/mantle/core/morphCore` (low-level bundle/morph cores), and
`@kontek/mantle/filterGraph/{dispatchRegistry,primitives/all,colr/paints}`
(register custom filter-graph primitives).

For distribution stripping, `inspect(bundle)` / `Features` (from
`@kontek/mantle/bundle`) report which subsystems an asset uses, and
`@kontek/mantle/bundle/featureManifest` maps those bits to the modules you
need to register.

```js
// Manual: you know exactly what your fonts use (smallest initial bundle).
// Latin + woff2 + variable-font web app:
import { MantleFontAsset, buildTextRun } from '@kontek/mantle/font/text';
import { registerWoff2Reader }            from '@kontek/mantle/font/formats/woff2';
import { registerVariableFontReaders }    from '@kontek/mantle/font/variations';
registerWoff2Reader();
registerVariableFontReaders();
```

#### Automatic registration

Don't want to hand-enumerate? `font/auto` sniffs the font's sfnt table
directory + GSUB/GPOS script list (and OS/2 ranges for AAT/RTL fonts) and
registers exactly what it needs — CFF, variations, colour, MATH, AAT, the
right script shaper(s), and bidi for RTL — and still tree-shakes: every
optional subsystem is loaded with a dynamic `import()`, so a bundler emits
one lazily-loaded chunk per subsystem and your *initial* bundle stays at the
lean core. WOFF2 input is decoded transparently.

```js
import { MantleFontAsset } from '@kontek/mantle/font/text';
import { autoRegisterForFont } from '@kontek/mantle/font/auto';

const raw = new Uint8Array(await (await fetch('/fonts/MyFont.otf')).arrayBuffer());
const { bytes, registered } = await autoRegisterForFont(raw); // bytes = raw sfnt (woff2-decoded)
const font = new MantleFontAsset(bytes);
// registered → e.g. ['font/formats/cff', 'font/scripts/arabic', 'font/typography/bidi']
```

This is the "just give it any font and it works" path; the manual form above
is for when you want the very smallest initial bundle with no per-font async
chunk loading.

## Test / debug hooks

Backend selection is an explicit API: `createMantleScene(canvas, { backend:
'native' })` (or `forceNative: true`) pins the no-WebGL fallback, and
`chooseBackend()` exposes the same decision for callers that branch their
own setup. For manual testing without touching code, a `?mantleNative=1`
URL query param forces the native backend, and
`globalThis.__MANTLE_FORCE_NATIVE = true` remains for automated harnesses —
do not rely on the flag in production.

Additional A/B hooks (`__MANTLE_NO_*`) are gated behind
`globalThis.__MANTLE_DEBUG__ = true` and read through `mantleDebugFlag(name)`.
Without that master switch they are inert. Prefer explicit APIs
(`renderer.setLoopBlinnFill(...)`, `renderer.setLoopBlinnMeshOpts({ forceCdt })`,
`importSvg({ gwnTree: true })`, `setDiagnostics(...)`) in application code.

Everything else is an explicit API: `setDiagnostics({ colrTrace: [],
engineTrace: true })` collects traces, and
`createShapeMorph(gl, src, dst, { cpuLerp: true })` pins a morph to the CPU
curve-lerp path (parity tests compare it against the GPU path). Prefer
`setDiagnostics({ silent: true })` to silence library warnings in
production builds.

## Layout

```
src/
  index.js            Public API barrel — re-exports the canonical names
                      from every cluster below.
  bundle/             Bundle data spec + featureSet introspection (no GL).
  renderer/           WebGL2 runtime: bundle factory (GL textures + drawList),
                      render state machine, cover-quad chunk parser. Split into
                      focused attach*(R) modules (fillPass / filterDraw / maskBake
                      / clipDraw / bundleHandle / frameLoop / drawDispatch / …)
                      sharing one context object R, whose members are contracted
                      by rendererContext.js (checked by `npm run check:types`).
                      The Loop-Blinn analytic fill is its own module family
                      (loopBlinn.js barrel + lb* satellites: contour decode,
                      cubic math, earcut, fast mesh, exact partition, morph
                      pair, interior split, packing).
  filterGraph/        Generic filter-graph evaluator + SVG / COLRv1 dispatch
                      + bbox propagation. 28-mode composite, blur, ramps, …
  animation/          Renderer-side animation primitives: per-shape
                      overrides, two-pose shape morph, N-key timelines.
  hitTest/            Point-in-shape queries. Pure CPU; no GL dep.
  primitives/         Shared low-level types (seg.js: SEG_* tags + mk* factories,
                      one source of truth for font + svg).
  scene/              Programmatic scene tree → bundle (scene API).
  fallback/           No-WebGL native-SVG backend: renders source SVG via the
                      browser, native morph emits animated path d (chooseBackend).
  core/               Runtime-shared helpers (metaBin parser, morphCore).
  textBundle.js       Mutable text bundle (createTextBundle).
  shaders/            GLSL ES 3.00 sources (mantle.frag, mantle.vert, paint*,
                      composite, blur, maskBake, …) + index.js, which is both
                      the runtime loader and the build/feature-select toolchain
                      (assembleShader, minifyGlsl, shaderFilesFor) that emits
                      the canonical generated/*.glsl.
  font/               Font subsystem (one fontAsset.js per .ttf; textRun.js
                      lays out + emits per-glyph shapes; readers under
                      color/, variations/, math/, formats/, typography/ —
                      incl. AAT morx/mort/kerx — and scripts/).
  svg/                SVG parser internals (importer.js is the entry;
                      mesh/textures/meta/gradient/clipMask/buildContext/...).
```

## Tests

```sh
node test/featureSetSmoke.mjs
node test/font/colrV1RichSmoke.mjs
node test/font/aatMorxSmoke.mjs      # AAT shaping
# ...200+ smokes across test/, test/font/, test/svg/
```

Each smoke is a standalone `node test/<name>.mjs` (exit 0 = pass). Files
prefixed `_` are shared fixture/harness modules, not standalone smokes.
Visual smokes require headless Chromium (Puppeteer) and live in
`test/*VisualSmoke.mjs` + `test/font/*VisualSmoke.mjs`; they write
inspection PNGs under `test/visuals/` (gitignored). Some font smokes need
third-party fixture fonts — `npm run fetch:fixtures` downloads them once
(pinned URLs, sha256-verified; also runs automatically before `npm test`).

## Status

1.1.0. The API surface (`importSvg`, `createBundle`, `createRenderer`,
`createShapeMorph`, `createOverrideTable`, `createTextBundle`, renderer
preparation/dynamic-resolution APIs, instancing, incremental strokes,
`inspect`, and hit testing) and the per-subpath registration modules are
stable. Internal helpers and GLSL helper-substitution markers are not part of
the public API.

## Author

Aaron Kaluszka <<megabyte@kontek.net>>

## Credits

Mantle implements published algorithms including:

- **Charles Loop & Jim Blinn** — the implicit-curve rendering method behind
  the analytic mesh fill ("Resolution Independent Curve Rendering using
  Programmable Graphics Hardware", SIGGRAPH 2005).
- **Josiah Manson & Scott Schaefer** — the closed-form per-pixel curve-area
  integral ("Analytic Rasterization of Curves
  with Polynomial Filters", *Computer Graphics Forum* (Eurographics 2013) 32(2)
  — https://doi.org/10.1111/cgf.12042).
- **Eric Lengyel** — the Slug ray-cast coverage algorithm and its
  root-eligibility table ("GPU-Centered Font Rendering Directly from Glyph
  Outlines", *JCGT* 6(2), 2017 — https://jcgt.org/published/0006/02/02/).
- **Alec Jacobson, Ladislav Kavan & Olga Sorkine-Hornung** — the generalized
  winding number behind the tree fill: winding as a sum of
  per-segment subtended angles ("Robust Inside-Outside Segmentation using
  Generalized Winding Numbers", SIGGRAPH 2013). The curved-arc term — a chord's
  subtended angle plus the winding of the arc↔chord lune — is the curve-domain
  GWN of **Spainhour, Gunderman & Weiss** ("Robust Containment Queries over
  Collections of Rational Parametric Curves via Generalized Winding Numbers",
  SIGGRAPH 2024).
- **Cem Yuksel** — the polynomial root finder used for cubic coverage
  ("High-Performance Polynomial Root Finding for Graphics", *PACMCGIT*
  5(3), 2022 — https://doi.org/10.1145/3543865).
- **Sederberg & Nishita** — Bézier clipping ("Curve intersection using
  Bézier clipping", *CAD* 22(9), 1990), used for curve×curve intersection.
- **Mapbox** — the ear-clipping triangulator is a port of
  [earcut](https://github.com/mapbox/earcut) (ISC, © 2016 Mapbox); notice
  preserved in `NOTICE`.

## License

Licensed under Apache-2.0 — see [`LICENSE`](LICENSE).
