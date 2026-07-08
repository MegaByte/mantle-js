# Mantle Vector Graphics — WebGL2

Mantle is a WebGL2 vector-graphics renderer for the browser. It imports SVG
(or shapes text) into a compact bundle — a curve table, per-shape metadata,
and cover quads, all typed arrays — then draws each shape as a single quad
whose fragment shader computes exact per-curve coverage (the Slug ray-cast
algorithm). Anti-aliasing is analytic and resolution-independent: no
tessellation, no stencil passes, no MSAA.

A second analytic fill based on Loop-Blinn implicit curves covers the cases
where a mesh wins: GPU-resident shape morphs, streamed geometry, and solid
static fills, each in one draw call. The renderer routes between the two
automatically. `setLoopBlinnFill('on')` extends the Loop-Blinn fill to
gradient and composed static fills as well; `'off'` forces the Slug path
everywhere.

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
  orientation (UAX #50), case mapping/folding — all generated for JS+C# from
  one source and passing the official UCD conformance suites at 100%; every cmap
  format incl. format-14 variation sequences; default-ignorable suppression;
  all four color-glyph formats (COLR v0/v1, CBDT/CBLC, EBDT/EBLC, sbix,
  SVG-in-OT); variable fonts (fvar/gvar/HVAR/VVAR/MVAR/avar/STAT, CFF2 blend);
  MATH; JSTF kashida justification.
- **Animation** — per-shape override tables, two-pose shape morph, N-key
  timelines, plus Lottie/Rive-derived modifiers (trim path, repeater,
  pucker/bloat, offset path, polystar, feather, text-on-path).
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
  support; pass `buildSvgTextGlyphs` from the font subpath). Arc
  segments are always preserved end-to-end as exact rationals (never
  flattened or cubic-approximated): the Slug path renders them via the
  coverage walker's `evalArc`, the analytic fill via its rational-quad
  piece kind.
- `createBundle(gl, bundleData) → Bundle` — uploads textures + vertex
  buffers to a WebGL2 context.
- `createRenderer(gl, shaderSources, opts?) → Renderer` — owns shaders +
  state; `shaderSources` is the dict from `bundleShaders.fromPackage()` /
  `loadShaders()` / `@kontek/mantle/shaders/generated`. `renderer.render(bundle)`
  draws a bundle (or animation handle). Synchronous by
  default (fully usable on return). Pass `opts.asyncShaderCompile: true`
  to defer shader link + uniform capture off the main thread via
  `KHR_parallel_shader_compile` — useful on contended/weak GPUs where
  linking ~20 programs can stall tens of ms; then `await renderer.ready`
  before the first draw. `renderer.ready` is a promise that exists in
  both modes (already-resolved in the default sync path).
- `renderer.drawBundle(target, opts?)` / `renderer.render(target)` —
  accept either a bundle or an animation handle (shape morph,
  timeline, override table); the renderer auto-unwraps `.bundle`.
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
  `alpha` (0–1), `tint [r,g,b,a]`, `blendMode` (0 normal / 1 multiply
  / 2 screen / 4 darken / 5 lighten). Composes between
  `beginFrame`/`endFrame` like `drawBundle`.
- `createShapeMorph(gl, src, dst, opts?)` — t-parameter morph
  between two topology-matched bundles. `.setT(t)`, `.bundle` to
  pass to the renderer.
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
  `createTextBundle` builds a mutable text bundle; `buildSvgTextGlyphs`
  backs SVG `<text>`. `decodeIfWoff2` / `ttcFaceCount` are sfnt helpers.
- **Scene** — `createScene(...)` builds a bundle from a programmatic
  scene tree; `sceneToBundle` / `sceneToSvg` serialize a scene.
- **Static-scene cache** — `createStaticCache()` plus the `CacheStrategy`
  / `CacheLevel` / `CacheReason` enums (see the cache note below).
- `fillHitShape(bundle, x, y, opts?)` / `fillHits(...)` /
  `fillHitId(...)` — hit testing (`HitMode.Bbox`, `.Coverage`,
  `.Outline`, `.Auto`). Coverage and Outline test per-shape curve
  geometry analytically (fills via winding ray-cast, strokes via exact
  band distance including caps, joins, and dash arrays). They do **not**
  account for clip paths, masks, filters, or `createOverrideTable`
  visibility/tint/transform — use the same `worldMatrix` as draw time
  for coordinate parity only.
- `setDiagnostics({ onWarn, onError, silent, colrTrace })` — redirect or
  silence library warnings/errors (default: `console.warn` /
  `console.error`); `colrTrace: []` collects a per-node COLR filter-graph
  trace for diagnostics.
- `chooseBackend()` / `createMantleScene(...)` — render via the browser's
  native SVG engine when WebGL2 is absent. Same scene API surface; morph
  emits animated `path d`. The native backend also exposes
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

The static-scene cache implements the A1 (whole-asset) tier. The A2
(viewport-clamped) tier is a no-op here: the cache target is already
viewport-sized, so there is nothing to clamp. `ForceA2` resolves to
`None`; use A1 or the intermediate mask/filter caches.

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
URL query param forces the native backend, and one `globalThis` debug flag
remains for automated harnesses (`__MANTLE_FORCE_NATIVE = true`) — do not
rely on the flag in production.

Everything else is an explicit API: `setDiagnostics({ colrTrace: [] })`
collects a per-node COLR filter-graph trace, and
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

1.0. The API surface (`importSvg`, `createBundle`, `createRenderer`,
`createShapeMorph`, `createOverrideTable`, `inspect`, hit-test API) and
the per-subpath registration modules are stable. Internal helpers + GLSL
helper-substitution markers are not part of the public API.

## Author

Aaron Kaluszka <<megabyte@kontek.net>>

## Credits

Mantle implements published algorithms including:

- **Eric Lengyel** — the Slug ray-cast coverage algorithm and its
  root-eligibility table ("GPU-Centered Font Rendering Directly from Glyph
  Outlines", *JCGT* 6(2), 2017 — https://jcgt.org/published/0006/02/02/).
- **Charles Loop & Jim Blinn** — the implicit-curve rendering method behind
  the analytic mesh fill ("Resolution Independent Curve Rendering using
  Programmable Graphics Hardware", SIGGRAPH 2005).
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
