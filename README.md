# Mantle Vector Graphics — WebGL2

Mantle is a WebGL2 vector-graphics renderer for the browser. It imports SVG (or shapes text) into a
compact bundle — a curve table, per-shape metadata, and cover quads, all typed arrays. Its coverage
routes draw each shape as a single quad whose fragment shader computes per-curve coverage through
methods optimized to that shape. They do not flatten curves, and anti-aliasing is analytic and
resolution-independent without MSAA.

Banded antialiased cover fills integrate curve area over each pixel. The JavaScript `slug` and `aac`
cover entry points share this integral; their names remain in the selection policy and shader
variants. The renderer also includes a hierarchical winding-tree kernel. `aacFill: 'auto'` selects a
cover variant from each bundle's device-space size and segment types. Large imported shapes receive
asynchronous interior-occupancy grids by default.

Automatic mode chooses an engine per fill row. The decision uses only the bundle, the draw's scale,
and the options. A row only a few pixels across draws through an exact AAC point route (a point list
of its pixels) when the list fits a byte budget. A larger cubic or arc row draws through its
analytic Loop-Blinn mesh. A row between those sizes draws with the cover kernel. Straight and
quadratic rows stay on that kernel, as do compact convex cubics made of many short segments; those
classes do not build meshes. Stroke rows draw through conforming strip covers where they save
pixels. `renderer.getFillPolicyOptions()` and `setFillPolicyOptions()` read and set every threshold,
and `debugStats.rowEngines` reports which engine drew each row. CPatch is not part of this decision
unless `cpatchAuto` or `route: 'cpatch-auto'` is set, and that automatic choice never includes
morphs.

A separate analytic fill based on Loop-Blinn implicit curves covers the cases where a mesh wins:
GPU-resident shape morphs, streamed geometry, and compact cubic or arc static meshes.
`setLoopBlinnFill('on')` builds and enables every eligible class on demand, including gradient,
image, and composed static fills; `'off'` forces the banded coverage path everywhere. CPatch, an
analytic area-coverage engine with asynchronous preparation, is opt-in through
`setFillEngine({ route: 'cpatch' })` (the root entry includes the engine; with the subpath entries
add `import '@kontek/mantle/renderer/features/cpatch'` first, or the call throws and names that
import). `route: 'cpatch-auto'` includes CPatch in static per-row selection; the default auto policy
leaves it disabled. Morphs require an explicit CPatch pin. A simple polynomial morph contour retains
its original controls when a certificate proves it valid over the full interval. Static polynomial
paints use certified whole-boundary or spatial area programs. Unsupported geometry and draw states
use the selected cover kernel once per paint, preserving translucent opacity.

## Install

```sh
npm install @kontek/mantle
```

Requires WebGL2 with `EXT_color_buffer_float`. Create the context with `depth: true`: the fill pass
depth-claims so one shape never paints a pixel twice where its own pieces meet, and without a depth
buffer that claim silently does nothing (a translucent self-overlapping shape composites twice, with
no error). Nothing in Mantle uses a stencil buffer on the default framebuffer. Tested on Chromium /
Firefox / Safari (16+); Edge inherits Chromium.

**Node.** `importSvg` parses with the platform's `DOMParser`, which Node does not provide: without
one it throws `importSvg: no global DOMParser`. Install a DOM parser such as `@xmldom/xmldom` and
set `globalThis.DOMParser` and `globalThis.XMLSerializer` before importing SVG (`engines` is Node >=
18; the GL renderer itself needs a browser WebGL2 context). The scene builders and
`sceneToSections`' solid-fill fast path need no DOM; any other scene goes through `importSvg` and
does.

**Module format.** The package is **ESM only** (`"type": "module"`, an `exports` map with no
`require` condition). Use `import`; a CommonJS file can `await import('@kontek/mantle')`.
`require('@kontek/mantle')` works on Node versions that implement `require(esm)` (22.12 and later;
20.19 and later) and throws `ERR_REQUIRE_ESM` on older ones, though `engines` stays `>= 18` because
`import` works there. `require('@kontek/mantle/package.json')` works everywhere (`./package.json` is
exported).

TypeScript declarations for the full public API ship with the package
(`"types": "./types/index.d.ts"`, generated from the source JSDoc via `npm run gen:types`), so
imports are typed with no extra `@types` install. Every subpath has its own declarations, found
through `exports`, so the project needs `moduleResolution` `bundler`, `node16` or `nodenext`. The
legacy `node10` (`node`) resolution does not read `exports` and cannot resolve any subpath
(`@kontek/mantle/svg`, `/shaders`, …) or the root's subpath types; it is not supported.

**Bundlers.** esbuild, webpack 5, rollup and Vite build every subpath for the browser with no
configuration, no `externals` and no `resolve.fallback` (Node's `zlib` is only reached at run time,
on Node). `probes/bundlerMatrix.mjs` rebuilds all 15 entry shapes under each of them from the packed
tarball.

## Quick start

```js
import { importSvg, createBundle, createRenderer } from '@kontek/mantle';
import { bundleShaders } from '@kontek/mantle/shaders';

// 1. Load bundled shaders and create the renderer once.
const gl = canvas.getContext('webgl2', { depth: true, antialias: false });
const shaders = await bundleShaders.fromPackage();
const renderer = createRenderer(gl, shaders);

// 2. Import SVG and upload its textures and buffers.
const bundle = createBundle(gl, await importSvg(svgText));

// 3. Draw the bundle.
renderer.render(bundle);
```

> Pass shader sources to `createRenderer()` and the bundle to `render()` or `drawBundle()`.
> `createMantleScene()` loads shaders and selects the native fallback automatically.

### Canvas alpha and the clear color

Mantle writes **premultiplied** alpha, which is the WebGL default (`premultipliedAlpha: true`) and
what the page compositor expects. Create the context with the default (or pass
`premultipliedAlpha: true` explicitly): a context made with `premultipliedAlpha: false` is read as
straight alpha and every translucent pixel (an anti-aliased edge, `opacity`) comes out darkened, so
`createRenderer` logs a warning when it sees one. An `alpha: false` context has no alpha channel, so
shapes composite against the frame's clear color and the result is opaque.

The color you pass to `beginFrame([r, g, b, a])` is **straight** (non-premultiplied) RGBA in 0..1,
like a CSS color. The renderer premultiplies it for the canvas, so `[1, 0, 0, 0.5]` clears to
half-transparent red; the native scene and `exportFrameSVG` write the same four numbers as
`rgba(...)`. `[r, g, b, 0]` and `[0, 0, 0, 0]` are both fully transparent.

### Context loss and restoration

A lost WebGL context cannot be repaired in place, so Mantle makes loss loud and recovery explicit.

- **While lost** (between `webglcontextlost` and `webglcontextrestored`) a renderer's draw and frame
  entries do nothing, `renderer.isContextLost` is `true`, `awaitLbReady`, `awaitEngine` and
  `warmScene` report not ready (`false` / `complete: false`), `prepareBundle` returns `false`, and
  `precompileFills()` and `updateBundleGeometry` (which returns `{ ok: false, reason }`) refuse.
  Pause your loop.
- **After the restore** the renderer is still unusable: its programs, uniform locations and every
  bundle, override table, morph, handle, palette and uploaded image made before the loss died with
  the lost context, and a bundle keeps no copy of its sections to re-upload.
  `renderer.isContextLost` stays `true`, `renderer.needsRecreate` becomes `true`, one error is
  logged, and the draw entries (`beginFrame`, `render`, `drawBundle`, `drawBundleInstanced`,
  `drawInstance`, `submitBundle`, `drawImage`, `drawSprite`, `setBundle`, `createBundleHandle`,
  `createImage`, `precompileFills`) **throw** a message that says to dispose and recreate. Nothing
  is drawn blank without saying so.
- **Recreate** inside the `onContextRestored` option (or your own `webglcontextrestored` listener):
  `renderer.dispose()`, then `createRenderer` and new bundles (`importSvg` output can be reused;
  `createBundle` it again). Old owners may be disposed before or after their replacements exist.

```js
let renderer = null,
  scene = null;
async function start() {
  renderer = createRenderer(gl, shaders, {
    onContextLost: () => {
      /* pause your loop */
    },
    onContextRestored: () => {
      renderer.dispose();
      start();
    }, // dispose, then recreate
  });
  scene = createBundle(gl, sections);
}
```

`onContextLost(event)` and `onContextRestored(event)` are `createRenderer` options (functions;
anything else throws). The renderer calls `event.preventDefault()` on the loss itself so the browser
may restore the context. If you dispose a renderer during loss, keep a restoration listener on the
canvas in the host application: disposal removes the renderer's own listeners. `createRenderer` and
`createBundle` throw a message that names WebGL2 for a `null`, 2D, WebGL1 or already-lost context;
`createMantleScene` falls back to the native backend when the renderer cannot start (unless you
force `backend: 'webgl'`). Browsers cap live contexts per page (about 16 in Chrome) and silently
drop the oldest, which then reports `isContextLost` and is never restored: dispose renderers you no
longer draw, and share one context where you can.

### Loading shaders

Use shader sources from the same Mantle version as the renderer. Regenerate custom feature entries
after a library upgrade or an asset-set change. `bundleShaders.fromPackage()`, `loadShaders()`, and
generated entries include the current companion stages; a hand-written key list copied from an older
release can omit them.

`createRenderer` takes a dict of GLSL sources. Three ways to get one, in order of effort:

```js
import { bundleShaders } from '@kontek/mantle/shaders';

// 1. Default: the package's own bundled module. Works under any bundler, in Node, and unbundled.
const shaders = await bundleShaders.fromPackage(); // everything
const lean = await bundleShaders.fromPackage({ include: ['feBlendFrag'] }); // core + these keys
// ...or { features: inspectAll(bundles) } for core + what those bundles need.
```

`fromPackage()` is a dynamic `import('./bundledSources.js')`: a code-splitting bundler (Vite,
webpack, rollup, esbuild with `--splitting`) emits the shaders as a lazy chunk fetched on the first
call; without splitting they are inlined into your bundle. The chunk is about 98
KB<!--size:shaders--> gzipped (the sources are stored once and spliced on load, about 10 ms).
`features` and `include` trim the dict, not the chunk.

```js
// 2. Only some shaders, tree-shaken: named, already-assembled exports.
import { createRenderer } from '@kontek/mantle/renderer';
import { fillVert, fillFrag } from '@kontek/mantle/shaders/bundled';

const gl = canvas.getContext('webgl2', { depth: true, antialias: false });
const renderer = createRenderer(gl, { fillVert, fillFrag });
```

```text
// 3. Plain .glsl files for your own GLSL tooling (a minifier, a validator), through the bundler's
//    text loader (Vite: ?raw; esbuild: --loader:.glsl=text):
import fillVert from '@kontek/mantle/shaders/generated/mantle.vert.glsl?raw';
```

To serve the `.glsl` files yourself instead, `loadShaders(baseUrl)` fetches
`<baseUrl>/generated/*.glsl` (a bundler does not emit those files, so this is only for a page that
serves the package directory). It checks every response and throws, naming the URL and status, on a
404 or on a host that answers a missing file with `index.html`. In Node, `loadShaders()` and
`fromPackage()` need no network and no `fetch`, and a `file:` base URL reads through `fs`.
`shaderFilesFor(spec)` lists the generated files a feature set needs.

### Shader preparation and cold GPU caches

Shader linking and a program's first draw can trigger driver compilation. A cold GPU cache can
therefore delay loading or the first use of a draw state. Prepare the states used during play behind
a loading screen:

```js
await renderer.warmScene(states);
// Or, after creating and configuring the scene's bundles:
await renderer.precompileFillsAsync();
```

Geometry readiness and completed shader links do not imply that every driver pipeline is ready.
Pipelines also depend on vertex layouts, render-target formats and draw state. New content, engine
settings or undeclared runtime changes may require another loading call.

#### Warm policy (`warmPolicy`)

`createMantleScene(canvas, { warmPolicy })` and `createRenderer(gl, shaders, { warmPolicy })`
support these policies:

| Policy     | Behavior                                                                                      | Implied options                                                                 |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `'strict'` | Prepare reachable draw states during loading; queue additional preparation for warm windows.  | `nonBlocking`, `strictPlay`, `asyncShaderCompile`, unless explicitly overridden |
| `'idle'`   | Compile on demand and prepare queued work during idle windows.                                | No strict-play options                                                          |
| `'off'`    | Compile on demand without inferred background preparation. Explicit loading calls still work. | No strict-play options                                                          |

`createMantleScene()` defaults to `'strict'` and awaits `renderer.ready`. A direct
`createRenderer(gl, shaders)` call remains synchronous by default, with no strict play or inferred
warm windows. Pass `asyncShaderCompile: true` and await `renderer.ready` for asynchronous
initialization. The `'idle'` and `'off'` policies reject `strictPlay: true`.

Strict renderers default to `standIns: false` and `needMissPolicy: 'block'`. Loading prepares the
exact programs reachable from the loaded content, declared changes and draw scales. A missing state
blocks until its program is ready and increments `debugStats.needMiss`. Declare runtime changes
through `renderer.declareReach()` and `renderer.declareStream()` before loading, and prepare newly
loaded content before drawing it during play.

Pass `{ standIns: true, needMissPolicy: 'defer' }` to allow prepared superset programs while exact
variants are queued. This policy prepares scene unions and broader variants for engine and size
changes. A state outside that prepared set still requires another warm call.
`needMissPolicy: 'defer'` alone cannot provide a replacement program when none is available.

The library infers warm windows from a static screen over 24 frames, no input for 700 ms or a hidden
tab. It stops starting new builds when activity resumes; an in-flight driver build must finish. Use
`await renderer.beginWarmWindow()` to prepare pending work during an application-controlled
transition.

#### Cooperative loading and diagnostics

`precompileFillsAsync()` runs in timer slices (`sliceMs`, default 8). With
`KHR_parallel_shader_compile`, it waits for link completion and GPU fences before validating
programs or submitting further pipeline preparation. `debugStats.coopLoad` reports progress and
timeouts. The synchronous `precompileFills()` remains available.

`nonBlocking: true` avoids querying programs that are still linking. Before preparation completes, a
renderer using stand-ins can use a ready alternative or defer a draw. It can also retain the
previous frame while GPU work is pending (`gpuShedMs`, default 40; `Infinity` disables this;
`gpuShedMaxMs` defaults to 2500). Strict play suppresses frame shedding; exact-program misses follow
`needMissPolicy` as described above.

Failed links are logged in `debugStats.linkFailedKeys`. The next loading call or warm window retries
them once; draws during play do not repeatedly relink failed programs. `debugStats.linkRetries`
reports retries.

`glGuard: true` enables slow-call and incomplete-link diagnostics. `debugStats.blockingLinkWaits`,
`glGuard`, `gpuGate`, `needMiss`, `playBuilds` and `playStandIns` help identify unprepared states.
`renderer.lbCensus()` reports analytic mesh preparation.

Without `KHR_parallel_shader_compile`, preparation uses synchronous linking. Even with asynchronous
linking, driver pipeline builds can delay the browser compositor. Warm on the context used for
rendering when predictable startup behavior matters; reuse of compiled programs across contexts
depends on the browser and driver.

#### Background warm queue (`renderer.warm`)

Hosts with multiple scenes can queue preparation before those scenes load:

```js
const q = renderer.warm;
q.setDisplay({ width: screen.width, height: screen.height, dpr: devicePixelRatio });
for (const game of games) q.add(game.id, { manifest: game.warmManifest });

const warm = q.focus(game.id);
await loadGameAssets();
await renderer.precompileFillsAsync();
await warm;
showGameplay();
q.resume();
```

- `add(sceneId, { manifest, bundles, priority })` returns `{ id, ready, status() }`. Re-adding an ID
  adds bundles, replaces its manifest and queues its work again. Missing or stale manifests use
  loaded bundles when available.
- `focus(sceneId, { timeoutMs })` pauses other scenes and opens a loading window. It resolves with
  status and counts, including `state: 'done'`, `'timeout'` or `'unknown'`. Check the result before
  assuming preparation completed. `resume()` ends focus; `pause()` holds pending work.
- `cancel(sceneId)` removes pending work and resolves its promise with state `'cancelled'`. Programs
  already built remain available.
- `status()` reports scene state, manifest validity, progress, scale coverage and queue totals.
- `window(true | fn)` declares a preparation window. `setInference(false)` disables inferred windows
  when another renderer controls the visible screen.
- `gameStart(id, { viewport, needed, declaredNeeds })`, `onResize(w, h, opts)` and `gameEnd()`
  coordinate preparation with the active game. Resize option `{ block: true }` permits a synchronous
  drain bounded by `maxBlockMs` (default 3000).

The queue submits one pipeline-building item per GPU fence during a loading, declared or inferred
warm window. Missing, stale and unlinkable manifest entries are counted and skipped. A skipped entry
does not establish draw readiness; the renderer's draw policy still applies.

**Warm manifests.** Set `recordWarmManifest: true`, exercise the scene's draw states and call
`renderer.exportWarmManifest()`. Ship that JSON with the scene. Version 3 records program keys,
pipeline state, bundle content keys and shader fingerprints. Minor version 2 records every viewport
class for each variant and pipeline in `vcs`; older minor versions treat each key as needed at any
size. Record with the default exact-program policy: stand-in recordings contain the replacement
programs actually bound.

A shader fingerprint mismatch marks a manifest stale. Version-2 manifests are unverified and replay
links only. `warm.add()` does not supply its manifest to `precompileFillsAsync()`; use
`precompileFillsAsync({ manifest })` explicitly for that call.

**Resizing.** Program selection depends on drawn scale. Record through the viewport sizes the
application supports. `setDisplay({ width, height, dpr })` supplies CSS dimensions and device pixel
ratio; scene status reports recorded, reachable and missing scale classes. Prepare undeclared states
or new content before relying on them during play.

### Rendering text

Text follows the same shape — shape a run into a bundle, then draw it:

```js
import { createRenderer, MantleFontAsset, createTextBundle, createBundle } from '@kontek/mantle';
import { buildTextSections } from '@kontek/mantle/textBundle';
import { bundleShaders } from '@kontek/mantle/shaders';

const gl = canvas.getContext('webgl2', { depth: true, antialias: false });
const renderer = createRenderer(gl, await bundleShaders.fromPackage());

const font = new MantleFontAsset(new Uint8Array(await (await fetch('Inter.ttf')).arrayBuffer()));
const label = await createTextBundle(gl, {
  font,
  text: 'Hello, world',
  style: { fontSizePx: 32, fill: [0, 0, 0, 1] },
});
renderer.render(label.bundle);

// The same run as plain sections (for createBundle, caching or export):
const { sections } = await buildTextSections(font, 'Hello, world', {
  fontSizePx: 32,
  fill: [0, 0, 0, 1],
});
renderer.render(createBundle(gl, sections));
```

`buildTextRun(text, font, color?)` is the low-level shaper: it returns the run's glyph curve data in
font em-units (`curveTexels`, `metaFloats`, …), **not** a bundle dict, so it does not go to
`createBundle` directly — use `createTextBundle` (a mutable, drawable text bundle) or
`buildTextSections` (returns `{ sections, bundleSrc }`; `sections` is what `createBundle` accepts).
Glyph geometry is in em units; scale it via the renderer's view/world matrix. For tag markup
(`<color>`, `<b>`, sprites) use `buildFromMarkup`; to measure without emitting use `measureText`.
PNG sbix/CBDT glyphs and EBDT coverage are decoded during preparation and share an owned image atlas
within the run. Colored glyphs retain their RGB and take the text alpha; EBDT takes the text
foreground color. `createTextBundle` selects a strike using `fontSizePx`; `style.bitmapPpem`
overrides that preference. Direct run builders default to32 pixels per em. Native text uses the same
bitmap placement. The synchronous `buildSvgTextGlyphs` callback emits outlines.

Text layout applies SinglePos and PairPos value records under `kern` and `dist` (placements,
advances and their variation deltas), mark anchors, and the vertical part of cursive attachment.
Contextual/chained GPOS application and the horizontal part of cursive attachment are not applied.
Lookup decoding does not imply that every positioning effect is supported by layout.

Line layout follows the Unicode algorithms. With `maxWidthEm`, a line wraps at the UAX #14 break
opportunities (after hyphens and slashes, around ideographs and so on); a run of breakable spaces at
a wrap point hangs and is dropped, so no line starts with or consists of spaces. LF, CR, CRLF, VT,
FF, NEL, LS and PS are zero-width hard breaks (LF, CR, NEL and PS also end the bidi paragraph, so
alignment follows each paragraph's own direction). A line is as tall as its largest `sizeScale`
(never less than the base size). Letter-spacing (`cspaceEm`) breaks optional `liga` ligatures and is
not applied between joined Arabic-script letters. A tab advances to the next CSS `tab-size` stop
(the `tabSize` layout option: a number of spaces, default 8, each the advance of U+0020 with its
letter- and word-spacing; `tabSizeEm`: a length) counted from the start of the line, and is drawn as
the font's space, never `.notdef`; it still wraps like a space. Small caps (`smallCaps`,
`<smallcaps>`) apply the font's GSUB `smcp` (and `c2sc`); a font without them draws each lowercase
letter as its capital at 0.7 of the size, as browsers do (a letter whose uppercase form has a
different length, such as ß, stays). A space the font does not map is drawn with its U+0020 glyph at
the HarfBuzz fallback width (U+3000 an em, U+2000-200A their fractions of one), and a font with no
`hmtx` advances half an em per glyph. Layout throws a `RangeError` for a non-finite `sizeScale` /
`voffsetEm` (a style that leaves one out reads it as 1 or 0) and a `TypeError` for a span whose
`text` is not a string or that has no `style`. A malformed font table does not throw: it is dropped,
as HarfBuzz drops one, so the font lays out as if it never had the table and warns once per font and
table. A corrupt outline (an unbounded composite fan-out, descending contour ends) draws that glyph
blank, and a bad cmap or metric entry falls back for that entry. `font.malformedTables` lists what
was found. Bytes that are not a font at all still throw.

Font-name decoding accepts `new MantleFontAsset(bytes, { compat: 'harfbuzz' })`; this option affects
name and STAT metadata. Text layout separately accepts `compat: 'spec' | 'harfbuzz'` and `ptem`. The
default is `'spec'`. HarfBuzz mode applies AAT `trak` tracking at `ptem` (12 points when omitted).
It does not promise identical output for every HarfBuzz feature or font.

COLR v1 gradients interpolate as OpenType specifies (CPAL, "Interpolation of colors"): in linear
light, with alpha premultiplied, then converted back to sRGB. Red to green is about (188, 188, 0) at
its midpoint. Chrome instead interpolates the sRGB-encoded values with straight alpha, about (128,
128, 0). `new MantleFontAsset(bytes, { compat: 'chrome' })` draws that font's gradients the way
Chrome does. It is set per font, a fallback font keeps its own setting, and the two modes share one
shader program, so choosing it adds no compile. It does not change name or STAT decoding;
`{ compat: ['harfbuzz', 'chrome'] }` asks for both. SVG gradients are not affected, in either mode.

A font that has both AAT tables (`morx`/`mort`, `kerx`) and OpenType ones (GSUB, GPOS) prefers AAT
by default; `preferAat: false` keeps GSUB/GPOS when present. Substitution and positioning are
selected separately: morx/mort can run with GPOS when there is no kerx. `compat: 'harfbuzz'` uses
HarfBuzz's table priorities.

STAT style names compose in the spec's `axisOrdering` order.
`new MantleFontAsset(bytes, { statNaming: 'fonttools' })` (or the second argument of
`instanceStyleName` / `styleAxisValues`) orders them by design-axis index as fontTools does, and
`ribbiNames(location)` returns the legacy RIBBI family and subfamily records (IDs 1, 2, 16, 17,
4, 6) fontTools' instancer would write, or `null` when the location lacks an exact nominal STAT
value. Picker range naming stays unchanged. Picker values a format or font lacks (`ordering`,
`min`/`default`/`max` of a STAT-only axis, `value`, `rangeMin`, `rangeMax`, `linkedValue`) are
`null`.

JSTF is used by default: the `font` barrel and `autoRegisterForFont` register the reader, and
`useJstf: false` turns it off. A lean build that registers readers by hand calls
`registerJustificationReader()` from `@kontek/mantle/font/typography/justification` to enable
OpenType JSTF priorities, shrinkage, extension and `JstfMax` adjustments during justified layout
(`align: 'justify'`). Set `lastLineAlign: 'justify'` to justify the final line too; the default
`'auto'` keeps that line at its paragraph alignment. Cursive extenders use joining boundaries and
the inline writing axis.

`registerUnicode()` and `segmentWordStarts()` are exported by `@kontek/mantle/font/unicode`. A
provider can supply synchronous `normalizeNFC`, `segmentGraphemes` and `wordStarts` hooks; omitted
hooks keep their current implementation. `wordStarts(text)` returns an iterable of UTF-16 offsets or
`null` when no dictionary hint is available. The default uses `Intl.Segmenter` when available. Word
starts guide wrapping; Unicode line-break rules still apply.

Font metadata methods `pickerCatalog()`, `styleLocation(partial)`, `styleAxisValues(location)` and
`instanceStyleName(location)` expose axes, named values, instances, features and style names.
Register the variations readers for fvar/STAT data and the AAT readers for `feat` names. These
methods return metadata for the caller's picker UI.

## Capabilities

In brief:

- **Rendering** — Slug, AAC (cover and exact point route), hierarchical winding, hard interior,
  Loop-Blinn and opt-in CPatch fill routes with per-row automatic selection; conforming stroke
  strips; native line/quad/cubic/elliptical-arc segments; default-on interior occupancy and
  opaque-occlusion culling; exact analytic AA without MSAA. Depth-backed targets can preclaim
  certified opaque interiors to reject hidden fragments. Filters render into bounded per-node
  targets and cache their output regions instead of allocating a full canvas for every primitive.
- **SVG** — full static SVG 1.1/2 element set: paths (with native arc segments), shapes,
  `<text>`/`<tspan>`/`<textPath>`, `<use>`/`<symbol>`, the full stroke model (caps, joins incl.
  exact miter/bevel, dash arrays, gradient + image stroke paint), gradients, patterns, markers,
  `<clipPath>`, `<mask>` (luminance
  - alpha), `<filter>` (all `fe*` primitives via a generic filter graph; `feImage` takes a `#id` or
    an external raster href — a `data:` URL, or any URL the browser can load — fitted by
    `preserveAspectRatio` into its primitive subregion and clipped to it, while an SVG href, or any
    href in Node, which has no image decoder, draws transparent), nested SVG, CSS (selectors,
    `@media`/`@supports`, `calc`/`var`, CSS Color 4/5), and CSS `clip-path` basic shapes (`inset()`,
    `circle()`, `ellipse()`, `polygon()`, `path()`, `rect()`, `xywh()`, with `round` corners and a
    reference box) on any element, `<use>` or nested `<svg>`. A shape is resolved against its
    reference box (`fill-box`, `stroke-box`, `view-box`; `border-box`, the default, is the stroke
    box on an SVG element, `content-box` and `padding-box` the fill box) in the carrier's own user
    space and becomes exact line-and-arc clip geometry, so it follows the element's transform at any
    scale and the hit test sees it. `white-space` (`normal`, `nowrap`, `pre-line` collapse; `pre`,
    `pre-wrap`, `break-spaces` preserve, and `white-space-collapse`) is read on `<text>` and
    `<tspan>` and inherits, and a tspan's own value beats its `xml:space`; a preserved newline is
    one space, as in browsers (SVG text has no forced line break), and `pre-line` collapses like
    `normal`. A preserved tab goes to the next `tab-size` stop (8 spaces by default).
- **Fonts** — TTF/OTF with CFF1/CFF2 and glyf outlines, WOFF 1.0 and WOFF2 (both through
  `decodeIfWoff2()`), TTC; GSUB/GPOS/GDEF support with script shapers for Latin, Arabic, Indic,
  Thai/Lao, Hangul, and USE (Khmer/Myanmar/…); **Apple Advanced Typography** (`morx`/`mort`/`kerx`/
  `ankr`/`feat`) for AAT-only faces like Zapfino; a UCD-18.0-driven Unicode text layer —
  normalization (UAX #15), grapheme segmentation (UAX #29), line breaking (UAX #14), bidi (UAX #9),
  script itemization (UAX #24), vertical orientation (UAX #50), case mapping/folding — passing the
  official UCD conformance suites at 100%; every cmap format incl. format-14 variation sequences;
  default-ignorable suppression; all four color-glyph formats (COLR v0/v1, CBDT/CBLC, EBDT/EBLC,
  sbix, SVG-in-OT); variable fonts (fvar/gvar/HVAR/VVAR/MVAR/avar/STAT, CFF2 blend); MATH; JSTF
  kashida justification.
- **Animation** — per-shape override tables, two-pose shape morph, N-key timelines. Shape morphs
  preserve elliptical arcs in endpoint form and retain strokes, gradients, images, clips, masks,
  filters, translucency, and recolor state on supported analytic routes.
- **Game/runtime integration** — dynamic resolution scaling, loading-screen fill precompilation,
  asynchronous Loop-Blinn readiness, persistent bundle handles, stable `zOrder` frame submission,
  live instancing with per-instance color state, independent nine-slice views, and incrementally
  growing paint strokes.
- **Color emoji & rich text** — tag-based markup runs (`<color>`, `<size>`, `<b>`/`<i>`, `<link>`,
  …) for runtime text.
- **No-WebGL fallback** — `@kontek/mantle/fallback` renders the source SVG via the browser's native
  SVG engine (incl. morph → animated `path d`) when WebGL2 is unavailable; `chooseBackend()` picks
  automatically.

## API surface

### Root package

- `importSvg(svgText, opts) → Promise<BundleData>` — parses SVG, returns an in-memory bundle struct.
  Opts include `defaultFill`, `defaultStroke`, `defaultStrokeW`, `maxUseInstances` (the most `<use>`
  instances one import may expand, default 100000; a document past it throws
  `svgImporter: the document expands more than N <use> instances` instead of running on, because
  nested `<use>` doubles at every level; `Infinity` disables the budget; the largest real asset
  measured uses 104), `keepInvisibleShapes` (see below), `origin` (`[x, y]` or `false`: the bundle
  origin coordinates are stored relative to; see Known limitations), `fonts` (family names mapped to
  font assets), `svgTextLayout` (for `<text>` support; pass `buildSvgTextGlyphs` from the font
  subpath), `engine` (`'slug'` or `'aac'`, to pin the packed band layout), `gwnTree`, `noAaTree`,
  and `occupancyGrid`, and `languages` — the user's BCP 47 tags a `<switch>` picks its
  `systemLanguage` child by (SVG 2: a user tag equal to a listed one, or a prefix of one up to a
  `-`, so `'en'` matches `en-US` but `'en-US'` does not match `en`; list the base tag too). It
  defaults to `navigator.languages`, else `navigator.language` — in Node 21+ that is the process
  locale — and with neither every `systemLanguage` test passes; pass it explicitly for an import
  that must not depend on the machine it runs on. An `<image>` that references SVG (a
  `data:image/svg+xml` URL, or any `.svg`/`.svgz` href the `svgTextLoader(href) → Promise<string>`
  option resolves) is imported as vector content: placed as SVG 2 §image places it (the image's
  `preserveAspectRatio` fits the document's natural aspect ratio into the image's rect and the
  root's own is ignored; the image's `overflow` clips to that rect, the root's to the fitted box),
  one group under the image's opacity, inheriting nothing from the referencing document, with its
  own `<image>`s loaded in turn (a reference cycle is cut, nesting stops at 8 levels). The
  referenced document's `<defs>` (gradients, clips, masks, filters, patterns, markers, `<use>`
  targets) do not resolve yet. Chrome departs from the spec here — it fits by the referenced root's
  `preserveAspectRatio`, ignores the image's unless it is `none`, and clips to the image's rect
  whatever either `overflow` says. It also draws an `feSpecularLighting` whose `specularConstant` is
  0 as opaque black (Blink runs it as diffuse lighting with a constant of 0) where Filter Effects'
  formula gives a transparent result; in `linearRGB` (the default color space of a filter), an
  `feComponentTransfer` table that Chrome truncates to 8 bits where the spec's function is exact (a
  dark entry is one level of linear light off, up to 13 levels of sRGB); and a dash that is on at
  both ends of a closed subpath, which Chrome continues through the seam with a line join where SVG
  2 13.5.7 lays the dashes along each subpath from its start to its end, each with its own caps and
  joins only between segments inside a dash: the seam is two dash ends. `compat: 'chrome'`
  reproduces Chrome at all four; the default, `'spec'`, draws what the specs say. The option is
  named for Chrome because the behavior is Chrome's: by their source, Firefox and Safari draw the
  specular case as the spec does, and on the `<image>` fit Safari agrees with Chrome while Firefox
  takes the image's `preserveAspectRatio` as the spec does but Chrome's viewport, size-only
  documents and clip. `compat: 'chrome'` also reproduces Chrome at eight more places where it
  departs from the spec text, and the default draws the spec at each: (1) a filter primitive
  subregion with a zero or negative `width` or `height` — Filter Effects 1 (Filter primitive
  subregion) says the primitive is disabled, a transparent black result, and what reads it defaults
  to that empty subregion; Chrome does not clip it (a zero-width `feFlood` floods the whole filter
  region); (2) a `filter` list that names a `url()` with no `<filter>` — Filter Effects 1 (`url()`)
  ignores the whole chain and applies no filter; Chrome skips only that stage and applies the rest;
  (3) the square cap of a zero-length subpath — SVG 2 (path implementation notes, zero-length path
  segments) aligns it to the path's direction there: the end direction of the closest preceding
  segment with length, else the start direction of the closest following one, else the x axis;
  Chrome and Skia draw it aligned to the user-space x axis whatever the path does; (4) an explicit
  `xml:space="default"` — SVG 2 (legacy white-space handling) would remove newlines before it
  collapses spaces, so `a<newline>b` would draw as `ab`, but the spec calls that processing legacy
  and deprecated and no browser does it; Mantle turns the newline into a space, as browsers do and
  as text with no `xml:space` at all (CSS `white-space: normal`) does, in both modes (a deliberate
  choice, so this one is not a `compat` difference); (5) the system colors `AccentColor` and
  `AccentColorText` — CSS Color 4 §6.2 defines them (the values are the user agent's; Mantle uses
  `#0075ff` and white), and Chrome rejects both, so a declaration that uses one is dropped; (6) a
  tab kept by `white-space: pre`, `pre-wrap` or `break-spaces` — CSS Text 3 advances it to the next
  `tab-size` stop (8 spaces by default, counted from the start of the text chunk), and the default
  draws that; Chrome draws it as one space and ignores `tab-size` in SVG text, which
  `compat: 'chrome'` reproduces (`xml:space="preserve"` turns a tab into one space everywhere); (7)
  a `<pattern>` whose `viewBox` has a width or height of zero — SVG applies no paint; Chrome paints
  the fallback of `url(#p) fallback`; (8) `clip-path` on a `<mask>` — the property applies to
  container elements, a mask is one, and CSS Masking 1 names only `opacity`, `filter` and `display`
  as not applying, so the default clips the mask's content; Chrome ignores it. Firefox and Safari
  are unverified at (1)-(8). Also in both modes and by deliberate choice (browsers, not the spec
  text): a newline kept by `white-space: pre`, `pre-wrap` or `break-spaces` is drawn as one space,
  since no browser breaks the line in SVG text, and `pre-line` collapses like `normal`. Where the
  spec text is silent or ambiguous the importer keeps one reading in both modes, the one Chrome has:
  the `feDisplacementMap` scale in `primitiveUnits="objectBoundingBox"` is a fraction of the box
  width on both axes and a light's `z` is of `sqrt((w² + h²) / 2)` (the text says only "the
  coordinate system established by `primitiveUnits`"); a negative gradient `fr` reads as 0 ("an
  error", with no error processing defined) and an `fr` larger than `r` is not clamped (SVG 2: "if
  the start circle fully overlaps with the end circle, no gradient is drawn"); a singular
  `gradientTransform` or `patternTransform` makes the paint server unusable (SVG 2 does not say);
  `feComponentTransfer` `table` with one value is that constant; filter primitive subregion edges
  round out to whole device pixels; CSS font-size keywords are Chrome's table (CSS Fonts 4 gives
  only guidelines). `kernelUnitLength` is defined by Filter Effects 1 and ignored here, with a
  warning, as in Chrome: the convolution runs on one device pixel per cell. `importSvg` throws a
  `TypeError` unless `svgText` is a non-empty string; a document with no ink returns `numShapes: 0`
  and `globalBBox: [0, 0, 0, 0]`. `globalBBox` holds the ink: a stroke's miter tips and a square
  cap's corners are inside it, so a view that fits the content box does not crop them (the stroke
  row's own `bbox` stays path plus half the width, and no other section changes). A geometry stream
  rebuilds it from the rows' boxes, which lack those extents. A fill or stroke whose alpha is 0
  (`fill="transparent"`, `fill-opacity="0"`, `stroke-opacity="0"`, `opacity="0"`) keeps its drawn
  row, at alpha 0 (`keepInvisibleShapes`, on by default): a morph or a timeline through such a pose
  pairs the row and interpolates its geometry and paint, an override table finds it by id and an
  absolute fill or stroke draws it, and it is a hit target. It draws nothing, and adds nothing to a
  draw, until one of those gives it ink. `keepInvisibleShapes: false` is the optimizing mode that
  drops those rows (a smaller bundle; a shape in such a pose then fades in or out at fixed geometry
  in a morph). `keepInvisibleShapes: 'all'` also keeps a fill of `none`, so a stroke-only shape has
  a fill row a morph or an override can reach (one more row per stroke-only shape).

  **Content the document marks as not drawn** (`display: none`, `visibility: hidden` / `collapse`, a
  shape of zero size, a stroke of width 0, the markers of a stroke of width 0, an empty group) is
  never dropped silently. The import drops it by default (a Flash export's hidden layers are most of
  the rows of the files that have them) and says so: `bundle.dropped` counts it by class
  (`displayNoneSubtrees`, `displayNoneShapes`, `hiddenVisibilityLeaves`, `zeroSizeShapes`,
  `zeroWidthStrokes`, `zeroWidthMarkers`, `emptyGroups`, `emptyGeometry`; absent when nothing was
  dropped), and the import warns once, naming `keepHidden`, when it dropped `display: none` or
  `visibility: hidden` content. `keepHidden: true` keeps that content as rows that **draw nothing,
  hit nothing and join no fit, cull or silhouette** until something reveals them: an override
  table's `reveal: true` on the row (or on a group id above it, which reveals every hidden row under
  it) draws and hit-tests it; a morph or timeline pose that hides a shape another pose shows pairs
  the row (its geometry interpolates) and fades it in or out, in the other pose's hue. A hidden row
  is in no draw list and no cull, so a scene draws as it did; the cost is rows and bytes (the bundle
  carries the hidden geometry in full), and `keepHidden` on a document with nothing hidden is the
  same bytes. SVG semantics hold in both modes: `visibility` is inherited and a child may set it
  back to `visible` inside a hidden parent (it draws); `display: none` is not undone by a child's
  `display`; a `display: none` subtree is not a hit target until revealed, while a hidden leaf whose
  `pointer-events` still targets it stays one through `bundle.hitOnly`. A bundle with hidden rows
  has meta header version 3, which an older reader refuses by name instead of drawing them.
  Zero-size shapes, zero-width strokes and their markers are counted, not kept. A hidden shape the
  pointer can still target is in `bundle.hitOnly`. A shape element without an `id` is named by its
  document ordinal (`shape_L<n>_fill`, `shape_L<n>_stroke`), the same in every pose of the same art,
  so a morph pairs it with itself whichever rows a pose drew. Use `engine: 'aac'` only when the
  bundle will always draw through AAC; its compact layout intentionally omits useful Slug vertical
  bands. A GWN fill define requires `gwnTree: true`. `normalizeFill` (default `true`) normalizes
  certified nested and disjoint fill boundaries so Slug, AAC and the point route integrate the fill
  rule inside a pixel; `false` keeps the authored boundaries. Prepared static monotone AAC and
  prepared morph radial-fan AAC are not importer or shader options. `curves64: false` drops the
  unrounded float64 curve twin (CPatch and primitive recognition then read float32). With the
  default precision plane, CPatch retains it for later route changes, refreshes it on full geometry
  streaming, and releases it on bundle disposal. `strokeStrip` (default on; `false` builds none,
  saving 48 B per strip vertex) builds the conforming strip cover the renderer may use for a stroke
  row. Fills fully covered by an opaque stroke draw without AA through band-hard; `noAaTree: true`
  bakes a winding tree for them instead (tree-hard), which measured slower and is kept for
  comparison. Occupancy acceleration is enabled by default for sufficiently large shapes and
  activates asynchronously; pass `occupancyGrid: false` to disable it. Arcs remain dedicated
  elliptical-arc records end-to-end rather than being flattened or cubic-approximated: the banded
  kernel evaluates them directly, and the mesh routes use rational-quadratic pieces. With a `fonts`
  map, text, textPath and textArea use the callback contract
  `(text, font, x, y, fontSize, fallbacks, maxWidthEm, styleOpts)`. textArea passes
  `width / fontSize` as `maxWidthEm`; the other two pass zero. Without a `fonts` map, textArea
  retains its family-resolving callback `(family, text, x, y, fontSize, maxWidthEm)`.

- `createBundle(gl, bundleData, opts?) → Bundle` — uploads textures + vertex buffers to a WebGL2
  context. Safe opaque-occlusion culling is enabled by default; pass `{ occlusionCull: false }` to
  preserve every authored draw.
- `updateBundleGeometry(gl, bundle, perShapeSegs, opts?)` — streams a fixed shape count into a v3
  bundle. Invalid rows or unsupported auxiliary geometry return `{ ok: false }` without changing the
  bundle, and so does a NaN or infinite coordinate. Empty segment arrays are valid, and so is a
  shape with no area (it draws nothing). `opts.lightweight` uses analytic meshes and retains the
  previous CPU curve planes; use full updates for current CPU hit tests. `opts.fills` supplies
  straight RGBA paint. Accepted lightweight updates upload changed paint; repeating the same values
  requires no paint upload. Accepted updates retire source primitive hints that may no longer match
  the geometry. An update moves `bundle.globalBBox` to the new content box, so the picture refits,
  unless the frame was fixed: `buildStreamableSections(shapes, fixedBBox)` and
  `importSvg(src, { preserveViewport: true })` keep theirs. The native counterpart is
  `updateNativeBundleGeometry()` from the fallback subpath. **Streaming and the warm.** A program a
  stream's update asks for has to exist before play, or the update links or builds it in play.
  - An imported bundle you will stream: call `renderer.declareStream(bundle)` before the loading
    call (`false` or `null` undeclares it). The fuller program this builds has a cost: about 20
    percent of a frame on tiger at 3456x2169 and about twice the first load, so declare only what
    you will stream. Its program then holds every segment type and analytic kind, so no update moves
    its key, and its first and later updates link and build nothing in play, under any policy.
    Alone, or among declared bundles, the warm builds no more programs and pipelines than it would
    undeclared: 4 fill programs in the default draw states (as drawn, rotated, recolored, both;
    `declareReach` narrows them), shared by declared bundles with the same paint features. Beside
    undeclared art of the same features they share nothing: 6 more programs and 6 more pipelines for
    the first declared bundle, and none for the next. The bundle draws that fuller program for its
    whole life, which costs fragment time on art that uses few of its kernels. Undeclared, nothing
    changes.
  - A lightweight stream (`opts.lightweight`, `buildStreamableSections({ lightweight: true })`):
    **update it once before the loading call.** Until its first update it has no analytic meshes, so
    the warm has no vertices to draw its programs with: a first update in play builds one pipeline
    there, and on declared imported art links two or three programs as well (three when the update
    brings a new segment type). Updated once before the loading call, its updates in play read 0
    links, 0 pipelines and 0 blocked draws. Imported art streamed this way needs both:
    `declareStream`, for an update that brings a new segment type, and the update before the load.
- `createRenderer(gl, shaderSources, opts?) → Renderer` — owns shaders + state; `shaderSources` is
  the dict from `await bundleShaders.fromPackage()` (or `loadShaders()`), assembled from
  `@kontek/mantle/shaders/bundled`, or built from the `generated/*.glsl` files (see "Loading
  shaders"). It needs at least `fillVert` and `fillFrag`; a dict missing them throws.
  `renderer.render(bundle)` draws a bundle (or animation handle). Synchronous by default for a
  direct call (fully usable on return; it waits on the driver while it links ~30 programs;
  `createMantleScene` passes the option, with `nonBlocking`, for you and awaits `ready`). Pass
  `opts.asyncShaderCompile: true` to defer shader link + uniform capture off the main thread via
  `KHR_parallel_shader_compile` — useful on contended/weak GPUs where linking ~20 programs can stall
  tens of ms; then `await renderer.ready` before the first draw. `renderer.ready` is a promise that
  exists in both modes (already-resolved in the default sync path). Important fill options include
  `aacFill: false | true | 'auto'`, `typeOmit` (defaults to true; omit curve kernels absent from the
  bundle; false retains all types), `strokeExactEdges` (defaults to false; true compiles the exact
  stroke edge records and their exact-area coverage into the stroke programs, the pre-1.2.0 stroke
  anti-aliasing) and `disableFillVariants` (retains all feature blocks while preserving the vertex
  layout required by analytic streams). (`fillDefines`, which compiles extra defines into every fill
  program, is a test hook: it takes effect only while `globalThis.__MANTLE_DEBUG__ === true`, and
  otherwise warns once and is ignored. Pick an engine with `renderer.setFillEngine()`; the fill
  variants omit the features a bundle does not use on their own.) (`exactEdgeAa` is accepted and
  ignored: the default fill is at least as exact.)
- **Engine selection** — `renderer.setFillEngine({ route, kernel, cpatch?, primitives?, commit? })`
  pins the geometry route (`'none'` cover only, `'lb'` Loop-Blinn, `'cpatch'`, `'cpatch-auto'`, or
  `'auto'`) and the cover kernel (`'slug'`, `'aac'`, `'hard-band'`, `'hard-tree'`, or `'auto'`)
  independently; `getFillEngine()` reports the request and `debugStats.engines` /
  `debugStats.rowEngines` report what drew. A pin bypasses automatic cost thresholds:
  `route: 'cpatch'` draws every row CPatch has geometry for, however large, where `'cpatch-auto'`
  gives a large many-curve row to its cover quad. A pin that cannot draw says so in
  `debugStats.engines.declines`: a row without CPatch geometry draws its cover quad
  (`cpatch: { unsupported: n }`), and `kernel: 'hard-tree'` needs the winding tree
  `importSvg(svg, { gwnTree: true })` bakes, so a bundle without one draws `hard-band`
  (`'hard-tree': { 'no-gwn-tree': n }`, with one warning). Pins also apply to retained meshes:
  recognized primitives use the cover kernel unless `primitives: 'on'` is requested. Switching
  primitives off takes effect on already prepared bundles, independently for renderers sharing their
  geometry. Lightweight streams retain their required meshes because they have no cover geometry.
  Analytic rows that fail support, footprint, preparation or memory admission use the selected cover
  kernel. `await renderer.awaitEngine(bundle, engine, timeoutMs?)` resolves when that engine's
  geometry is drawable. Switching a prepared static bundle between LB and CPatch rebuilds its mesh
  for the selected engine. Await readiness and warm its future draw states before gameplay. In
  `'auto'`, `getFillPolicyOptions()` / `setFillPolicyOptions(patch)` read and set the row-gate
  thresholds (`aacPointsRowGate`, `aacPointsExtMax` 30 px, `aacPointsBytesBudget` 32 MB,
  `aacPointsRunsMax` 8, `aacPointsRowsMin` 128, `aacCoverExtMin` 14 px and `aacCoverExtMax` 32 px (a
  drawing of at least `aacPointsRowsMin` rows that are all under `aacCoverExtMax` px takes one class
  by its median row: points under `aacCoverExtMin`, the cover pass above; `aacCoverExtMax: 0` turns
  it off), `aacPointsColorMatrix`, `aacPointsBucket`, `lbMinExtentPx` 8 px, `lbMinExtentShare` 0.1;
  `null` restores a default; `aacPointsRowGate: false` and `lbMinExtentPx: 0` restore the pre-row
  routing). `lbMinBundlePx2` (default 262144), `aacPointsBufferBudget` (default 48 MB) and
  `aacPointsGen` (default `true`: the point route uploads one 16-byte entry per row and paint and
  the vertex shader generates the points; `false` uploads 8 bytes per point) are creation options.
  `setStrokeStrip({ policy: 'auto' | 'on' | 'off', minSavedPxPerVertex: 64, maxMode })` sets the
  stroke strip policy; `estimateRouteBytes(bundles, { perRow?, unitPx2?, viewport? })` prices each
  route's draw-sized storage per bundle and row before any draw; retained cache history and other
  pipeline resources are additional (`getMemoryStats()` reports what is actually held, and
  `setMemoryBudget(bytes)` bounds it: see Memory below). `route: 'cpatch-auto'` (or
  `route: 'auto', cpatch: true`) includes CPatch in static selection. `cpatchAuto: true` is also a
  renderer/fill-policy option. Morphs keep the existing auto routes unless CPatch is explicitly
  pinned.

- `renderer.drawBundle(target, opts?)` / `renderer.render(target)` — accept either a bundle or an
  animation handle (shape morph, timeline, override table); the renderer auto-unwraps `.bundle`.
  **The draw fits the bundle's CONTENT bounding box to the viewport**, not the SVG's `viewBox`: the
  inked bbox is scaled by `min(W/bboxW, H/bboxH)` and centered, so it fills one axis and is
  letterboxed on the other, and any padding the `viewBox` carried around the artwork is not
  reproduced. Size the target with `renderer.setViewport(W, H)` (or the canvas's own drawing buffer)
  and place the result yourself; to compare against an external raster, give the reference SVG the
  inked bbox as its `viewBox` with `preserveAspectRatio="xMidYMid meet"` so it lands in the same
  place.
- **Placing a draw — `opts.dstRect`.** `drawBundle(target, { dstRect: [x, y, w, h] })` performs that
  same content-bbox fit into a **rectangle of the viewport** instead of the whole of it. Units are
  viewport pixels, y-down, origin top-left — the same as `drawImage`'s `dstRect`, so one piece of
  layout code can place a raster and a bundle. `setViewport` still defines the pixel space the rect
  lives in; `dstRect` only picks a sub-rect of it, and the box being fitted is still the inked
  content bbox, never the `viewBox`.
  - `opts.fit` takes `preserveAspectRatio`'s vocabulary: `'xMidYMid meet'` (default, letterbox
    inside the rect), `'… slice'` (cover the rect, overflow the other axis), `'none'` (stretch to
    fill, aspect broken), with the full `xMin|xMid|xMax` × `YMin|YMid|YMax` alignment set.
  - `opts.clipToRect` (default `true`) scissors the draw at the rect's edges, which is what makes
    `slice` usable. It **intersects** an outer `setScissorRect` rather than replacing it, and is
    restored when the draw returns. A filter's own region clip intersects it too, so filtered
    content stays inside the rect. Set it `false` to place without cropping.
  - `renderer.bundleDrawMatrix(target, opts)` returns the em → viewport-pixel matrix (column-major
    `mat3`, y-down) for the draw those same `opts` would perform. Pass it as `fillHitShape`'s
    `worldMatrix` and the hit test answers for the pixels on screen; `opts.worldMatrix` alone
    cannot, because it acts in clip space and carries none of the viewport fit.
  - A `dstRect` composes on top of your own `worldMatrix` (`rect ∘ yours`), so adding one never
    re-interprets a matrix you already pass. It is implemented as that composed per-draw matrix, so
    it inherits `worldMatrix`'s existing limits exactly and adds none: the half-pixel AA dilation is
    computed before the per-draw matrix (a bundle shrunk into a small rect has a proportionally
    smaller AA skirt), `fe*` filter primitives ignore world scale, and SVG 2 `vector-effect`
    cancellation treats the rect as part of the draw-time transform (a `non-scaling-size` /
    `fixed-position` shape is placed by the viewport fit, not by the rect). `drawBundleInstanced`
    does not take a `dstRect` — give each instance a `worldMatrix` instead. The native SVG backend
    takes a `dstRect` too: it fits the same content bbox with the same rule and clips to the rect,
    but it needs `setViewport` first, and a `worldMatrix` given with the rect keeps that scene's own
    meaning (em space, applied before the placement). Every other per-bundle entry point takes it:
    `submitBundle`, `drawInstance`, `drawSprite` and a resident handle's `handle.draw(opts)`. On
    `drawSprite` the fit is still the **whole sheet's** bounding box, as it is without a `dstRect`,
    so the sprite lands at its position within the sheet scaled into the rect — the rect frames the
    sheet, not the sprite.
- `renderer.submitBundle(target, { zOrder, ...opts })` — queues a draw until `endFrame()`. Lower
  `zOrder` values paint underneath; ties preserve submission order. Outside a frame it behaves like
  `drawBundle()`. `zOrder` is a number (default 0); `Infinity` and `-Infinity` are the always-on-top
  and always-underneath layers, and `NaN` or a non-number throws a `TypeError`. The options are
  copied when you submit (including `worldMatrix`, `scissor`, `dstRect` and the color lists), so one
  options object can be reused and mutated between submits.
- **`alpha` is group opacity.** `drawBundle`, `submitBundle`, `drawInstance`, `drawSprite`, a
  handle's `draw()` and each instance of `drawBundleInstanced` take `alpha` (0–1) and fade the
  **whole draw as one unit**, exactly like CSS `opacity` on a `<g>`: the bundle renders into an
  accumulator and that is composited once, so overlapping shapes do not show through one another.
  (Before 1.2.0 `alpha` multiplied each leaf, which did; output changes wherever the art overlaps
  itself.) Per-leaf state is unchanged and applies _inside_ the group: fill/stroke opacity, an
  override table's tint and opacity, `colorMatrix` / `colorMatrixOffset`, `palette`, `channelLerp`;
  filters, masks, clips, blend modes and the bundle's own groups also composite inside it, so a
  filtered bundle fades after its filter and a leaf's `mix-blend-mode` blends against the group, not
  the page. A draw whose leaves cannot overlap (one paint-only leaf, or several plain fills and
  strokes whose painted boxes, with the antialiasing reach, are disjoint) is drawn directly at no
  extra cost; `alpha` 1 or absent is the unchanged path. Any other faded draw costs one accumulator
  clear and one composite, bounded to the painted rectangle; faded instances that do not touch share
  an accumulator, and ones that do are layered in painter order, so `drawBundleInstanced` pays one
  pass per layer and alpha rather than one per instance. A faded draw of a statically cached mount
  is one blit of the cached alpha-1 raster, and animating the alpha does not re-bake it. Hit testing
  ignores `alpha`. Consecutive groups containing only plain fills and strokes share an accumulator
  and a composite pass. Disjoint groups use separate rectangles of that accumulator; overlapping
  groups use separate atlas slots. Include representative morph poses in `warmScene` draws. Once
  used, the shared GPU interpolation helper stays warm while a renderer on that context generation
  remains alive. Disposing the last renderer and morph releases it; standalone morphs retain their
  usual disposal behavior. Morph filters switch from the source filter to the destination filter at
  `t = 0.5`; identical filters retain one resource record. Filter regions in object-bounding-box
  units follow the interpolated group bounds. Fill opacity interpolates independently of fill color;
  a transparent color endpoint borrows the visible endpoint's hue. Eligible morph groups use their
  current-pose bounds and opacity. Morphs with changing clip, mask or filter bindings retain
  ordinary group isolation. `createRenderer(gl, shaders, { groupAtlas: false })` disables group
  batching.
- **Runtime controls** — `renderer.setResolutionScale(scale, { dpr? })` resizes the backing store
  while preserving its CSS size; call it after layout and on resize, not every frame.
  `renderer.prewarmBundle(bundle)` starts the likely fill variants,
  `await renderer.awaitLbReady(bundle)` waits for an enabled off-thread Loop-Blinn build when the
  first visible frame must use it (and resolves `false` when passive automatic policy deliberately
  skips the mesh); `prepareBundle()` remains an explicit request to build it.
  **`await renderer.precompileFillsAsync()` is the loading call** (see "Never blocking the main
  thread" below): it does the same work as the blocking `renderer.precompileFills()` without ever
  freezing the page, and resolves only when everything the first seconds of play need is built,
  warmed and barrier-synced. `renderer.precompileFills()` links loaded fill programs and warms
  pipelines behind a loading screen, **waiting on the driver** (on a cold GPU cache the main thread
  is frozen for the whole link and pipeline build: seconds). Pipeline draws are bounded by a time
  budget (800 ms by default), 128 bundle attempts and a stop after eight attempts that warm no new
  variant. Unvisited entries remain queued: call again during loading or let idle frames finish.
  Eligible small AAC draws warm their point program and vertex layout.
  `precompileFills({ draw: false })` issues no pipeline draws; the first visible point draw can
  still compile its program and build its pipeline. The return value counts attempts in that call,
  not completed scene preparation. Each bundle gets a fill program with unused features compiled
  out. A requested AAC kernel or rotated AAC footprint must be available on the first draw, so an
  unprepared request can synchronously finish its lean program and incur a stall. Other draws can
  use the general program while their lean pipeline warms. A draw switches to it only once its GPU
  pipeline is built, and the renderer builds that where it will not cause a hitch: when frames have
  slack (45 in a row under 20 ms, about 0.75 s at 60 fps), or, for content that never gives it any,
  after 60 frames and a second. `precompileFills()` after creating bundles pays the known compile
  and pipeline work during loading. It does not predict future draw states: await the required
  engine with `awaitEngine`, then draw and GPU-fence the actual transforms, morph intervals, vertex
  layouts, opacity groups, filters, render targets and blend states behind the loading screen. New
  states can require additional pipelines. For CPatch, also `await renderer.warmCPatchPool()` during
  loading. It finishes the shared workers' synthetic converter warm-up (returns `false` when workers
  are unavailable or fail). `awaitEngine` waits for drawable geometry, which can become ready before
  that background warm-up finishes. The pool hook does not prepare asset geometry or shader
  pipelines. `await renderer.warmScene(states)` is the explicit contract: each state is
  `{ bundle?, engine?, draw }`, where `draw` performs one future draw behind the loading screen (the
  same canvas, transform, blend, overrides and morph pose). Include both `bundle` and `engine` to
  await geometry readiness, or await `awaitEngine` separately before warming. Without these fields,
  warming only checks the pipelines used by the callback and can finish while geometry is still
  building. The renderer draws, fences, runs `precompileFills`, fences again and repeats until a
  whole pass builds nothing for that state (or `maxPasses`). The report lists every state's passes,
  whether it reached `stable`, and how many programs and pipelines it built. Program counts include
  engine readiness and the draw/warm passes, covering all library programs in the current GL context
  generation, including shared helpers and other renderers on that context. A context-generation
  change fails the state. The memory-stat program count retains its renderer-local scope. Completion
  requires geometry readiness, no outstanding program demands, and successful GPU fences. Demanded
  specialized programs must draw during a loading pass before completion. Select the intended engine
  with `setFillEngine()` before warming; a state's `engine` waits for readiness and does not change
  draw policy. Set the viewport with `setViewport(width, height)`. The state's callback should
  include any engine selection needed when warming a scene with several engines.
  `renderer.setSceneUnion(bundles)` (opt-in) declares the bundles one scene draws: those whose fill
  programs agree on everything but the features each leaves out bind one program, the union of their
  kernels, instead of one lean variant each, so a scene of mixed bundles links fewer programs and
  pays fewer first-use compiles. Pixels are unchanged; a bundle not declared keeps its own variant,
  and `setSceneUnion(null)` clears it. `prewarmBundle` and `prepareBundle` start work; neither alone
  guarantees a completed first draw. `createRenderer` options: `psoWarmMaxWaitFrames` (default 60; 0
  builds only in slack) and `psoWarmIdle(dtMs)`, a callback that decides instead when a frame is
  idle. `aacPointsPrewarm` (opt-in) links the small-draw point-route program when a bundle is
  prepared, so its first draw does not pay the link. `variantFirst` (default on;
  `variantFirst: false` opts out) draws a bundle with its specialized fill program from its first
  frame instead of the general program: on a cold shader cache the first frame is about 1 s instead
  of about 8 s (the general program's first draw on a cold cache is about 19 s at the 1.2.0 shader
  size). It covers instanced draws as well. Until the general program has drawn, a draw whose
  specialized program is not yet warm uses that program rather than the general one; every feature
  gate is the one the settled path uses, so a feature that appears later (recolor, an external clip,
  group opacity, an override or a morph pose) selects a program that has it before the draw. It
  costs about 0.2-0.3 s per distinct specialized program on a hot first frame at 512 px, and the
  first frame can differ from the general program's by a few pixels (9 px, at most 5/255, on the
  measured drawing). An app that calls `prewarmBundle` plus `precompileFills()` behind a loading
  screen gains nothing from it and can set `variantFirst: false`. `warmMorphSources` (default off)
  skips automatic prewarming of the source poses passed to `createShapeMorph`. Enable it when those
  poses will also be drawn directly, or prewarm them explicitly with `prewarmBundle`. Leaving it
  disabled saved 54 MB of GPU memory in a six-pair scene. A source pose's first direct draw then
  pays its preparation cost (1–3 ms in the measured scenes; 21 ms for CFF text). A stand-in-free
  renderer (the default of `strictPlay`) warms the poses unless `warmMorphSources: false`: no
  pipeline is first built in play. `filterPoolIdleMs` (default 10000; 0 disables): a renderer that
  has drawn nothing filtered for this many milliseconds (wall clock, not frames) frees its filter
  scratch (the RT pool and the shape and ping targets), one target per frame, oldest first, never
  one of the viewport's size class and never one used inside the window. The next filtered frame
  reallocates what it needs: about 1.5 ms per 1536 px target, so a whole filter-heavy pool (a koi
  scene: 45 targets, 99 MB at 1536 px) can cost one frame of up to ~70-100 ms on return from a long
  filter-free stretch. `renderer.debugStats.scratchTrim` reports the trim's ticks and what it freed.
  While filters run, scratch also has a fixed ceiling (the larger of 256 MiB and six canvases of
  color + depth/stencil). Past it, `endFrame` frees the targets neither of the last two frames used,
  oldest first. A working set in use is never freed. `debugStats.scratchTrim.ceilingFreedBytes`
  reports it. `filterFrame` (default on): a filtered shape or `<g>` that crosses the canvas edge is
  filtered in a frame, the canvas plus the margin the filter reaches (a blur's 3 sigma, an offset, a
  displacement, a kernel), no more than the shape protrudes, rounded up to a grid (multiples of 64
  px, or of an eighth of a smaller canvas, then eight steps per octave) so that a moving shape
  reuses its targets. The filter then sees the shape beyond the edge, as in a browser: blur, drop
  shadow, displacement, convolution, morphology and lighting do not fade at the canvas border, and a
  zoomed (`worldMatrix`) filtered shape bigger than the view is correct at any zoom. A filter wholly
  inside the canvas is unaffected. `filterFrameMaxPixels` (default 16.7 M, or twice the canvas if
  larger) bounds the frame; a filter that reaches farther than fits (a blur millions of pixels wide)
  is evaluated at 1/2, 1/4, ... resolution and scaled back, which is exact for such a smooth kernel,
  and warns once. Such a frame keeps the exact margin, off the grid. Not framed: a graph that reads
  `BackgroundImage`, a nine-sliced bundle, a draw with an external clip (`setNodeClip`), and a group
  with a blend mode or a mask on the group itself; those keep the canvas as their filter's world.
  `feTile` repeats the rectangle of its input, which a frame clips to itself.
  `cacheKeepDepthStencil` (default off): a static cache's bake needs a DEPTH24_STENCIL8
  renderbuffer, the cached picture does not, so by default it is freed after each bake and attached
  again at the next bake of the same target (+0.1-0.2 ms per rebake measured on desktop GL). That is
  4 B/px per cache on top of its RGBA8 (8 MB at 1080p, 9.4 MB at 1536 px, 16.8 MB at 2048 px; up to
  6 auto caches). On a tile GPU the driver may already treat the renderbuffer as memoryless after
  the bake, so the saving on a device can be smaller than these figures (not yet measured on iOS).
  `cacheKeepDepthStencil: true` keeps it resident as before. There is deliberately **no API for
  declaring which fill features an app uses**: every fill variant is the same two shader sources
  under a different `#define` set, so there is nothing for a bundler to tree-shake — only a compile
  to schedule — and each bundle already derives its own variant from the features baked into it.
  `createBundle` enqueues the bundle for that warm-up by itself; `prewarmBundle` and
  `precompileFills` are the only knobs, and they say _when_ to pay, not _what_ to compile.
- **Live instancing and mounts** — `renderer.drawBundleInstanced(bundle, instances, shared?)`
  accepts per-instance `worldMatrix`, `alpha`, `tint`, `colorMatrix`, and `colorMatrixOffset`;
  diagonal color transforms remain GPU-instanced. `renderer.createBundleHandle(bundle)` keeps one
  mount's GL state resident. A bare `drawBundle` / `drawInstance` keeps a transient handle per
  bundle: one for each bundle drawn in this frame or the last (of a `beginFrame` / `endFrame` pair)
  and eight idle ones (eight in all without frames); the memory budget may evict the idle ones.
  `bundle.nineSliceInstance(opts)` creates an independent drawable nine-slice view sharing the base
  bundle's textures, so one asset can be mounted at several sizes simultaneously. Invalid nine-slice
  options (a non-finite or negative `border`, a non-finite `worldSize`, a `nativeBBox` without
  positive extent) throw before anything changes; a zero `border` or a `worldSize` of zero or less
  restores the native state. Hit tests (`fillHitShape` and the rest) answer for the sliced picture:
  the query point is mapped back through the cut table.
- `renderer.createIncrementalStroke({ width, bbox, color?, capStyle?, joinStyle?, miterLimit?, points? })`
  — creates a paint-tool stroke whose `appendPoints()` updates only new segments. Draw
  `stroke.bundle` normally; `finalize()` returns `{ pathD, svg }`, and `dispose()` releases its GL
  state.
- `renderer.createImage(source, opts?) → ImageHandle` / `renderer.drawImage(handleOrSource, opts?)`
  — composite a raster image directly into the current frame (no SVG wrapper needed). `source`
  accepts the same forms as an SVG `<image>`: a `WebGLTexture` (not owned), `{width, height, data}`
  RGBA pixels, an `ImageBitmap` / `HTMLImageElement` / `HTMLCanvasElement` / `ImageData`, or a
  string href / data-URL / encoded bytes (async → use `await createImage(...)` then draw the
  handle). `createImage` uploads a reusable premultiplied texture (`{width, height, dispose()}`);
  pass it to `drawImage` every frame for the hot path, or hand `drawImage` a raw source for a
  one-shot upload. `drawImage` opts: `dstRect [x,y,w,h]` (viewport px, y-down), `worldMatrix`
  (column-major mat3, for rotation/skew), `srcRect [x,y,w,h]` (source sub-rect in px, for
  atlases/sprite-sheets), `alpha` (0–1), `tint [r,g,b,a]`, `colorMatrix` (column-major mat4) +
  `colorMatrixOffset` — the same per-draw recolor as `drawBundle`
  (`out = colorMatrix * in + colorMatrixOffset` on straight color, before the tint), so N blits
  sharing ONE image handle can each take their own color — and `blendMode` (0 normal / 1 multiply /
  2 screen / 4 darken / 5 lighten). Composes between `beginFrame`/`endFrame` like `drawBundle`.
- `createShapeMorph(gl, src, dst, opts?)` — t-parameter morph between two bundles. Compatible
  records match by id or position; incompatible or unmatched shapes use an ordered visibility fade.
  `.setT(t)`, `.bundle` to pass to the renderer. A morph's own `.bundle` can be `src` or `dst` of
  another morph: it is sampled at its current `t` when the new morph is created (a snapshot, not a
  live link). Generated hidden rows are retained at `t = 0`. Chaining an intermediate visibility
  fade, changing gradient or filter opacity throws. User transforms, tint, absolute paint and group
  overrides must be restored to their generated values before chaining. Elliptical arcs interpolate
  in endpoint form so contours stay welded; analytic routes preserve supported paint, stroke, clip,
  mask, and filter composition. Each arc number interpolates as the number the two poses state (SVG
  2, 9.3.2): a rotation of 350 going to 10 passes through 180, and two poses that spell one ellipse
  differently (radii swapped with a quarter turn, or 360 added) spin on the way. Write each rotation
  as the nearest number to the same arc's rotation in the pose before it; a loop that turns all the
  way needs a closing pose that repeats the first with the turns added. Art exported with a running
  angle (a rotation that keeps counting past 360) should either write its poses that way or set
  `opts.arcRotation: 'shortest'`, which spells each destination ellipse the nearest way to its
  source first (`'spec'` is the default, with no cost). An arc flag that differs between the poses
  is 1 at every pose between them; `opts.compat: 'chrome'` steps it at `t = 0.5` as Chrome's `d`
  animation does (`'spec'` is the default; a morph holding such a flag then interpolates its curves
  on the CPU). Both options also go on `createShapeTimeline`, `createSpriteTimeline`,
  `createNativeTimeline` and `scene.createTimeline` as a last argument, and on `createPoseStack`,
  `createSpatialBezierMorph`, `createShapeMorph`, `createSpriteMorph` and `createNativeMorph`;
  timelines over the same poses share a pair morph only when they agree on them. A pose pair that
  changes an arc's rotation, flags or scaled radii draws through the cover-quad kernel on every
  route, pinned Loop-Blinn and CPatch included, since a control-point lerp cannot draw it.
  `opts.cpuLerp: true` selects CPU interpolation. Direction is preserved by default.
  `opts.alignFullTurnDirection: true` matches a full-turn arc's direction to its paired partial arc,
  preventing a zero-sweep collapse. This can change dash phase and compound-path winding; use it
  only when that correspondence is intended. `createSpriteMorph` accepts the same options as its
  fourth argument; `createNativeMorph` also accepts the flag. Dashed matched strokes prepare segment
  addresses once and update dash lengths from the current geometry, including the stroke frame.
  Draws and geometry hit tests share these prefixes. Morph preparation retains the source's authored
  miter ceiling as joins deform. If you cache imported sections, retain their optional
  `strokeMiterLimits` array. Older cached sections without that array keep their stored ceiling;
  re-import the SVG to recover the authored value. **What interpolates:** geometry, bbox,
  fill/stroke colors, stroke width, compatible bitmap rectangles, and compatible gradient
  parameters/stops (both renderers; `docs/NATIVE_FALLBACK.md`, which ships in the package, says
  where the native-SVG morph holds a gradient's stops). Matched resource IDs, image content, dash
  patterns, filter selection, blend mode, flags, and clip/mask bindings retain source structure.
  Scene-group opacity (`<g opacity>`) interpolates, and so does the opacity of a leaf whose fill and
  stroke composite as one (an element with `opacity` below 1 that paints both): a pose that has no
  group over the same shapes counts as a group of opacity 1, so a fade across 1 (`.5` to `1`, `1` to
  `.5`) holds the group around the same shapes in painter order and ends at exactly the target's
  opacity. Only opacity-only groups (no clip, mask, filter or blend mode) are paired this way, by
  the shapes they wrap; any other group keeps the matching it always had. A leaf shape's own
  `opacity` interpolates. A matched bitmap paired with a solid paint retains its source image
  mapping. Added shapes use their destination gradient, image, dash and filter resources;
  preparation rebases those IDs into owned tables. Image morphs retain separate mip chains for at
  most two independent atlases. Composing endpoints that already require more than two independent
  planes is refused; use imported endpoints. Unchanged carried scene groups retain the added child's
  target sibling order. A clip binding is a row index, not a quantity, so **a morph cannot change
  which `clipPath` a shape uses per pose**: a pose that binds a different clip in `dst` still draws
  under `src`'s clip at every `t`, and the morph warns when it sees the two disagree. A clip's
  _shape_ is not frozen, though — a `<clipPath>`'s children are ordinary rows in the same bundle, so
  give them matching `id`s in both bundles and the clip path deforms with `t` like anything else. A
  shape that exists only in `dst` and is clipped there has its binding remapped to the corresponding
  merged layer rows. Missing, invalid or noncontiguous layer bindings are dropped with a warning.
- More animation builders — all return a handle exposing `.bundle` (plus `.setT(t)` / frame setters
  where applicable): `createShapeTimeline` (N-key timeline), `createSpatialBezierMorph` /
  `createPathDeltaMorph` (path-space morphs), `createSkinnedMorph` (bone-weighted),
  `createPoseStack` (additive poses), `createSpriteMorph` / `createSpriteTimeline` (sprite-sheet
  frames). Timelines over the same poses on one context SHARE their pair morphs (one per pose pair:
  a game's many identical sprites cost one set of curve data, not one per sprite). A pair holds one
  current time, so draw through the timeline: `drawBundle(timeline)` or
  `drawBundle(timeline.bundle, { morphT: timeline.t })` draw that timeline's own pose. A bare
  `drawBundle(timeline.bundle)` draws whichever timeline sharing the pair set its time last; call
  `setTime` right before it. `hitTest` and export read the pair's current pose the same way. Curve
  drivers require materialized v3 bundles. They keep current geometry, bounds, stroke records and
  CPU hit queries aligned while retaining the viewport. Delta/tangent arrays use `curveFloats`
  indexing; derived headers, joins and distances are rebuilt. Spatial arcs use endpoint trajectories
  with interpolated radii and rotation. A skinned arc has one affine frame: endpoint weights may be
  omitted or must match its center weights. Full geometry updates invalidate prepared fill meshes.
  Retaining source markup also retains current SVG export geometry; ordinary rendering does not
  build SVG paths.
- `createOverrideTable(gl, bundle)` — per-shape fill / stroke / strokeWidth / tint / visibility /
  transform / reveal overrides. `reveal: true` draws and hit-tests a row that
  `importSvg({ keepHidden: true })` kept hidden (on a group id: every hidden row under it);
  `visibility` still multiplies, so a revealed row at visibility 0 stays hidden. Drives animation
  systems (Lottie / Rive / SMIL). A numeric key must be an integer row index (anything else returns
  `false`). An absolute `fill` / `stroke` is `[r, g, b, a]`: a missing or non-finite component takes
  its default (0 for r, g, b; 1 for a, so `[0, 1, 0]` is opaque green; `update` keeps the row's
  current color instead). `strokeWidth` must be a finite number and is clamped to `>= 0`; any other
  value sets no width override.

  _Hit-only shapes and group overrides._ A bundle with hit-only shapes (shapes that draw nothing but
  are pointer targets, see the hit model) gives its table `numHitOnly` extra rows. They follow the
  `numShapes` drawn rows in `packedBuffer` (`numShapes + numHitOnly` rows of 24 floats; only the
  drawn rows are uploaded, so `textureHeight` and the GPU cost do not change), and they have
  override state like any row: a numeric key `numShapes + k` is hit-only shape `k` (the index
  `fillHitShape` answers), a string key is its id (a hit-only shape of an element that also has a
  drawn row, `id` / `id_stroke`, is that element's companion: its id addresses the drawn row and it
  follows it; a hit-only stroke band of an element whose fill is drawn has the id `id_stroke`). The
  hit test reads those rows, so the hit follows the override exactly as it follows a drawn row
  (visibility 0 hides it; tint, opacity and absolute paint are paint and never matter). Such a
  bundle also makes a **group** addressable: the id of an ancestor element of rows (a `<g id>`, a
  `<use id>` or a nested `<svg id>`) is a key when no row has that id, `table.groupIds` lists them,
  and `set` / `update` / `get` / `clear` on it take `localPosition`, `localRotation`, `localScale`,
  `visibility` and `tint` (absolute `fill`, `stroke` and `strokeWidth` are ignored with a warning:
  set them on the rows). A group override is applied over every row under that element, drawn and
  hit-only, outermost group last: the row's matrix is `G_outer * ... * G_inner * M_row` (the group
  transform acts in em space about the em origin, like a row's own override), visibilities and tints
  multiply, and a `<use>` target id moves all its instances (an instance's own id moves one).
  Filtered-group transforms move the filter region and frame with the member paints. Tint and
  visibility affect those paints once. `get(row)` keeps reading the row's own override;
  `getEffective(row)` reads it as drawn (with an exact `matrix` when a group covers it, since a
  composition can shear). Writing `packedBuffer` directly and calling `markDirty()` is for rows no
  group covers: a covered row is recomposed from its own override when its group changes. The
  no-WebGL table (`createNativeOverrideTable`) resolves keys, composes groups and answers hit tests
  the same way (its `packedForHit()` is the same rows), and a hit test reads a native table's
  overrides. Group ids are not tied to hit-only shapes: every bundle `importSvg` makes carries the
  group tree (`bundle.groupTree`: `groupNames`, `groupParent`, `drawnGroup`, `format` 2) when some
  drawn row sits under an element with an `id`, so `set('G', ...)` works on any such bundle, with or
  without a hit-only table (a bundle with one adds `hitOnly.rowGroup` for its own rows). A document
  with no id on a container carries no new field and is byte-identical to before. A morph bundle
  keeps the source's containers and takes the destination's for the rows only it has; `bundleForm`
  output and bundles that did not come from `importSvg` carry none.

- **Filter parameters** — `createFilterParams(bundle)` makes a filter's numbers animatable after
  import. `fp.targets` lists every primitive in the bundle with the parameters it will accept —
  `sigmaX`/`sigmaY`, `dx`/`dy`, `rgba`, `matrix`, `k` (k1..k4), `mode`, `scale`,
  `baseFreqX`/`baseFreqY`, the lighting constants, a morphology `radiusX`/`radiusY` — and each
  target's `id` addresses it (`'f1:0'` for a graph node, `'f1'` for a single-primitive filter).
  `fp.set(id, patch)` writes them, `fp.get(id)` reads them back, and `fp.reset()` restores the
  imported values. A write takes effect on the next frame — the filter caches and the static-scene
  cache key on it. **Only parameters that reach the GPU as uniforms are writable**, and each target
  says why it is not when it is not: `feComponentTransfer`'s transfer functions are a LUT baked at
  import, `feConvolveMatrix`'s kernel values live in a texture (its `divisor`/`bias` are writable),
  a single-primitive `feColorMatrix` is sampled inline from the filter table, and `feImage`'s
  source, `feMerge`'s inputs and anything that changes the graph's shape are a re-import. So is a
  value the importer **dropped**: a zero `stdDeviation`, a zero `feMorphology` radius and a zero
  `feOffset` are identities and emit no primitive, so a filter must be authored with a nonzero value
  to be tweened from one. One `<filter>` shared by several elements — and a morph, which shares its
  source bundle's graphs — is handled by copy-on-write, so one bundle's tween never reaches
  another's picture.
- **Recolor** — `createPalette(gl, entries)` builds a palette LUT from `[r, g, b, a]` entries (each
  channel 0–255; up to 256 entries) that a draw applies per shape through
  `drawBundle(bundle, { palette, paletteChannel })`, plus the `colorMatrix*` helpers
  (`colorMatrixIdentity`, `colorMatrixMonochrome`, `colorMatrixDualTint`, `colorMatrixTripleTint`,
  `colorMatrixCombine`) for building 4×5 color matrices.
- **Text** — `MantleFontAsset(bytes)` wraps a TTF/OTF; `buildTextRun` / `buildStyled` /
  `buildFromMarkup` shape a run into per-glyph geometry; `measureText` / `measureFromMarkup` measure
  without emitting; `createTextBundle` builds a mutable text bundle and accepts `gwnTree: true` for
  a GWN-capable text bundle; `buildSvgTextGlyphs` backs SVG `<text>`. A text handle preserves
  `tb.bundle` identity across `setText()` / `setStyle()` (including empty runs), so existing
  renderer handles update automatically. Use `tb.runMetrics.typoBBox`, `firstBaselineY`,
  `lastBaselineY`, `lineCount`, and `lastLineAdvance` for stable layout rather than the ink-tight
  `globalBBox`. `decodeIfWoff2` / `ttcFaceCount` are sfnt helpers.
- **Scene** — `createScene(...)` builds a bundle from a programmatic scene tree; `sceneToBundle` /
  `sceneToSvg` serialize a scene.
- **Static-scene cache** — `createStaticCache()` plus the `CacheStrategy` / `CacheLevel` /
  `CacheReason` enums (see the cache note below).
- `fillHitShape(bundle, x, y, opts?)` / `fillHits(...)` / `fillHitId(...)` / `fillHitHref(...)` —
  hit testing, **by default the SVG model** (`HitMode.Auto`; also `.Bbox`, `.Coverage`, `.Outline`).
  `fillHitHref` answers the `<a href>` (or `xlink:href`) of the innermost anchor around the topmost
  hit shape — `''` when that shape is in no anchor, `null` on a miss; `bundle.shapeHrefs` holds the
  same per shape. `{ sprite: id | [first, last] }` in the options restricts the answer to one sprite
  of a sheet (the argument of `drawSprite`), so a sprite under another one is reachable.

  **The hit model (SVG 1.1 §16.4, SVG 2 `pointer-events`, CSS Masking).** A point hits a shape's
  fill when it is inside the interior by the fill rule, and its stroke when it is inside the exact
  stroked outline (stroke width, caps, joins, miter limit, dashes,
  `vector-effect: non-scaling-stroke`). Both are tested exactly on the bundle's native curves: no
  coverage, alpha or pixel threshold, and no `worldMatrix` is needed, so a result is the same from
  2^-20 to 2^20. _Painted_ means paint other than `none`, never alpha above zero:
  `fill="transparent"`, `fill-opacity: 0`, `opacity: 0`, a gradient or a pattern (its whole
  interior) are hit. `opacity`, `fill-opacity`, `stroke-opacity`, `mask`, `filter` and blend modes
  never change an answer; `clip-path` does (clipped-out areas receive no pointer events). **Masks do
  not affect hit testing**, as SVG 2 says ("pointer events must still be captured even in areas
  where the mask goes to zero opacity") and Chrome does; combine a mask with a `clip-path` to let
  events through its transparent part. Which regions answer is the element's `pointer-events`, read
  through the cascade (presentation attribute, `style`, stylesheet; inherited, so a group's value
  reaches its children and a `<use>` instance):

  | `pointer-events`                            | fill answers                              | stroke answers                   |
  | ------------------------------------------- | ----------------------------------------- | -------------------------------- |
  | `visiblePainted` (default, `auto`)          | `visibility: visible` and fill not `none` | `visible` and stroke not `none`  |
  | `visibleFill` / `visibleStroke` / `visible` | `visible` (fill paint ignored)            | `visible` (stroke paint ignored) |
  | `painted`                                   | fill not `none` (visibility ignored)      | stroke not `none`                |
  | `fill` / `stroke` / `all`                   | always / never / always                   | never / always / always          |
  | `bounding-box`                              | the geometry box (no stroke)              | never                            |
  | `none`                                      | never                                     | never                            |

  `display: none` never hits (a row kept by `keepHidden` hits only while an override reveals it);
  `visibility: hidden` / `collapse` are not `visible`. A stroke region needs a nonzero
  `stroke-width`. Shapes that draw nothing but can still be targeted (a transparent fill, a hidden
  leaf under `pointer-events: all`) are not drawn and cost the renderer nothing: they live in
  `bundle.hitOnly`, which only the hit queries read, and answer as shape index `numShapes + k` in
  document order among the drawn rows (`bundle.shapeIds` does not list them; `fillHitId` and
  `fillHitHref` do). **An override table moves them**: a table made for the bundle keeps a row for
  each hit-only shape after the drawn rows (see _Hit-only shapes and group overrides_ under the
  override table), so `table.set(id, ...)` or `table.set(numShapes + k, ...)` moves, scales, rotates
  or hides one, and an override on the id of a group they sit in (`<g id>`, `<use id>`) moves them
  with the drawn shapes of that group. A morph carries its source's table, static, until `t = 0.5`
  and its destination's after, and a streaming update does not move them (both warn once); see
  _Known limitations_.

  Not modeled: a _marker_ is not a separate target (its content belongs to the referencing path's
  rendering and Chrome does not hit-test it); a _text_ glyph answers by its outline, not by the
  character cell the spec describes; a _sprite_ of a sheet answers for every sprite at its authored
  position (test its `bundle.spriteRanges` row range against `fillHits`); a `<g>` with a `filter`
  keeps its `clip-path` on the group, which the hit test of its children does not see; filters,
  blend modes, group opacity and recolor change nothing.

  **Ties are inclusive**: a point exactly on a fill edge (within 1e-6 of the shape's extent of a
  boundary that has fill beside it) hits, from every side, so two shapes that abut on an edge both
  answer there and the edge leaves no gap; strokes (distance at most half the width) and recognized
  circle / rect primitives are inclusive too. `fillHits` lists every target front to back;
  `fillHitShape` is the first of them (topmost in document order).

  **Other modes.** `HitMode.Coverage` is opt-in and means _rendered pixel coverage_: where a row's
  fill is drawn, the fill's exact coverage of the pixel box centered on the point (with a
  `worldMatrix`; point-in-fill without one) reaches one half, where its stroke is drawn the point is
  in the stroke band; opacity, mask and `minAlpha` apply, `pointer-events` is ignored, and nothing
  that draws nothing answers. `HitMode.Outline` tests the stroke band of every row that has a width,
  whatever its paint. `HitMode.Bbox` is the row's box. `minAlpha` applies to those and is ignored by
  `Auto`. Coverage and bbox thresholds include enclosing group opacity, including the current morph
  pose and its paint order. Morph hit tests honor the morph's visibility table (or an explicit
  `overrides` table); an override moves, hides or restrokes the row it addresses, its clip-path with
  it (tint and absolute colors are paint and change nothing). Large shapes use cached winding trees
  and near-segment pruning.

  Hit-test rules: `bundle` may be a bundle or an animation / text handle that owns one (every public
  entry that takes a bundle accepts both, and works on its `.bundle`). A non-finite `x` or `y`
  misses (`-1`, `[]`, `null`); a bundle with no shapes and no hit-only table misses. Without a
  `worldMatrix` the point is in the bundle's own units; with one (`renderer.bundleDrawMatrix(...)`)
  it is in pixels, which changes no `Auto` answer except the width of a non-scaling stroke.

- `setDiagnostics({ onWarn, onError, silent, colrTrace, stallMs, engineTrace, dumpCache })` —
  redirect or silence library warnings/errors (default: `console.warn` / `console.error`);
  `colrTrace: []` collects a per-node COLR filter-graph trace; `stallMs` / `engineTrace` /
  `dumpCache` opt into draw/engine/cache diagnostics (off by default — a single flag check on hot
  paths). Read aggregates via `diagnosticTraces()` and reset them with `clearDiagnosticTraces()`.
- `chooseBackend()` / `createMantleScene(...)` — render via the browser's native SVG engine when
  WebGL2 is absent. Same scene API surface; morph emits animated `path d`. The automatic WebGL path
  requests a depth buffer (the fill pass's depth claim needs one; without it the claim does
  nothing), no stencil, no browser MSAA and no preserved drawing buffer, and prefers a
  desynchronized high-performance context; pass `glAttribs` to override those defaults.
  `scene.toScene(sections, bundleOpts)` forwards bundle options on WebGL and accepts them for native
  signature parity. On WebGL it builds a GPU bundle, so call it once per `sections` object, outside
  the frame loop; repeated calls return the same bundle (memoized per `sections` and options). The
  native backend also exposes `createNativeScene` / `createNativeMorph` /
  `createNativeOverrideTable` / `createNativeTextBundle` / `createNativeTimeline` (also under
  `@kontek/mantle/fallback`).
- `renderer.exportFrameSVG(opts)` / `renderer.setFrameCapture(on)` — serialize the frame just drawn
  to an SVG string by replaying its recorded draw list through the native scene. Recording is off by
  default and must be on **before** the frame you export: create the renderer with
  `{ captureFrames: true }` or call `setFrameCapture(true)`, otherwise `exportFrameSVG` throws. With
  the subpath entries (not the root) it also needs
  `import '@kontek/mantle/renderer/features/frameExport'`; without it the call rejects and names
  that import. Every bundle drawn must carry its source (`importSvg(text, { retainSource: true })`);
  a draw without it is skipped and listed in `notes`. `opts`: `detail: true` returns
  `{ svg, drawn, skipped, notes }`, `recoverText: true` emits a real `<text>` for text bundles
  created with `retainText`, `coordinateSpace`, `viewport`, `serialize`, and `document`. The export
  needs a DOM: a browser's `document` with `DOMParser` / `XMLSerializer`, or in Node a DOM
  implementation (for example `@xmldom/xmldom`) installed as the globals plus `{ document }`. The
  result is deterministic (authored ids are kept; ids Mantle generates restart at 0 for every
  export), a bundle's `<style>` is scoped to its own group, `<script>`, `<foreignObject>`, `on*`
  handlers and `javascript:` hrefs of the retained source are removed unless you pass
  `allowActiveContent: true` for a trusted source, and `setScissorRect`, `setNodeClip` and a
  `dstRect` draw's `clipToRect` are replayed per draw (in `coordinateSpace: 'viewport'`; `'bundle'`
  adds a note instead). `docs/NATIVE_FALLBACK.md` describes the native scene the export is built on.
- `inspect(bundle)` / `inspectAll(bundles)` / `Features` / `toNames` — feature-bitmask introspection
  (gradients / strokes / dash / vector-effect / clips / masks / filters / patterns / …) for
  distribution stripping. Exported from `@kontek/mantle/bundle` (the introspection subpath has no GL
  dependency).

The root barrel also re-exports lower-level building blocks that back the API above and are each
reachable from a subpath too: segment primitives (`SEG_*` tags + `mkLine`/`mkQuad`/`mkCubic` +
`*Contour` constructors), cover-quad + meta packers (`getCoverQuadMesh`, `parseMetaBin`, texel
helpers), the shader toolchain (`bundleShaders`, `shaderFilesFor`, `loadShaders`), and path-`d`
helpers (`curveRangeToPathD`, `curvesToPathDMap`).

### Static cache note

The static-scene cache exposes three descriptive levels:

- `WholeAsset` (`ForceWholeAsset`) caches one fully visible bundle in a viewport-sized target.
  `Auto` can promote stable assets to this level.
- `ViewportWindow` (`ForceViewportWindow`) caches the viewport plus a configurable
  `viewportWindowMarginPixels` around it and reuses that bake for pans within the margin. It is
  opt-in because it did not improve the measured JS workloads enough to justify automatic promotion;
  test it against the direct path for the target game. Bundles using `non-scaling-size`,
  `non-rotation`, or `fixed-position` draw live because those vector effects intentionally cancel
  the projection compensation used by this level.
- `SharedGroup` (`ForceSharedGroup`) lets handles with the same `instanceGroupKey` share one target.

`ForceA1` and `ForceA3` remain deprecated aliases for compatibility. The former no-op `ForceA2` was
removed; numeric strategy value `3` now selects `ForceViewportWindow`, and
`CacheReason.LevelNotImplemented` was replaced by `CacheReason.UnsupportedFeatures`. A draw with
`alpha` below 1 (a group fade) and a multi-leaf bundle composes live too, and so does a bundle with
a row that blends with what lies under it (`mix-blend-mode` outside an isolating group), under every
strategy: a bake has no backdrop to blend with. Screen-space external clips also draw live because
their texture contents can change independently of bundle cache invalidation. Renderer-created
shared groups are isolated per WebGL context. Handles release cache state on disposal; direct
`createStaticCache()` consumers should call `dispose()` when finished.

### Memory: accounting, budget and preparation peak

`renderer.getMemoryStats()` reports nominal GPU allocation sizes.
`createRenderer(gl, shaders, { memoryBudgetBytes })` or `renderer.setMemoryBudget(bytes)` applies
the budget policy below. Required resources can exceed that budget. There is no budget by default.

```js
const m = renderer.getMemoryStats(); // { bundles: false } skips the per-bundle rows
m.gpu.totalBytes; // textures + buffers + renderbuffers the library created, on this context
m.gpu.byCategory; // { bundle, coverGeometry, fillStream, points, filterCache, pool, atlas, staticCache,
//   mask, clip, frameTargets, morph, images, overrides, strokes, filterScratch, core }
m.gpu.peakBytes; // the GPU high-water, inside frames too (resetMemoryPeaks() restarts it)
m.bundles; // [{ id, label, shapes, gpuBytes, textureBytes, bufferBytes, cpuBytes, byCategory, disposed }]
m.caches; // filterCache { entries, bytes, retainBudgetBytes }, pools, atlas, pointLists, staticCache, loopBlinn
m.cpu; // bundleBytes (typed-array backing stores reachable from live bundles), workers { loopBlinn }
m.features; // what each registered renderer feature reports (cpatch: conversion jobs in flight and queued)
m.programs.created; // this renderer’s standard program-factory count
m.preparation; // { highWater, recent: [{ label, gpuPeakBytes, cpuTransientBytes, heapPeakDeltaBytes, ms }], open, heapSampled }
m.policy; // { order, overBudgetBytes, evictions, refusals, enforcements }
```

**What the bytes are.** The nominal size of every allocating call: `texImage2D` / `texImage3D` /
`texStorage*` (width x height x depth x bytes per texel of the internal format, per level;
`generateMipmap` adds the rest of the chain), `bufferData` (the size, or the data's bytes with the
`srcOffset` / `length` overload) and `renderbufferStorage` (times the sample count). Driver padding,
alignment and compression are not visible to a page and are not counted. A texture the host made on
the same context is never counted, and a resource that is dropped without a delete leaves the total
when it is garbage collected. The numbers are exact against a spy on those calls and return to zero
when every bundle and the renderer are disposed (`test/memoryLedgerSmoke.mjs`, and on a real context
`test/memoryBudgetRenderSmoke.mjs`). The ledger belongs to the WebGL context: several renderers on
one context share one total, and `getMemoryStats()` reports it. It wraps the context's allocation
methods by assignment; a context behind a `Proxy` that forwards method reads to its target cannot
take the wrapper (it would loop), so that method is left alone and listed in `gpu.unpatched` (its
allocations are then not counted; deletes the library makes still subtract).

**Budget policy.** The budget bounds the total in bytes (`Infinity` or `null` removes it; a negative
or non-number throws). It acts in three ways, and every act is counted in `getMemoryStats().policy`:

1. _Optional resources are refused._ A Loop-Blinn mesh set, a CPatch coefficient plane, a
   static-cache raster, the group atlas target (32 MiB at 2048 × 2048, up to 128 MiB at 4096 × 4096
   on larger canvases, including RGBA8 and depth/stencil) and the point lists are optional: each
   asks first. A resource larger than the entire budget is refused without evicting useful caches.
   Otherwise, if the budget would be passed, the caches below are evicted; if that is not enough the
   request is refused with one warning per kind and the scene draws through a cheaper route (the
   cover route for a refused mesh or plane, a live draw for a refused raster, a canvas-sized
   accumulator for a refused atlas). A refusal is not retried for a Loop-Blinn bundle (`debugStats`
   / `getFillEngine()` still name the engine you pinned; the engine ledger says what drew). A pinned
   engine is subject to the budget like an unpinned one. The warning names the refused mesh or plane
   and the cover/Slug fallback, including when the engine was explicitly pinned. Capture it with
   `setDiagnostics({ onWarn })`; `getMemoryStats().policy.refusals` also records the resource,
   refusal count and requested bytes. The opaque prepass's depth meshes ask too; a refused one is a
   bundle drawn without the depth prepass, which changes no pixel.
2. _Eviction order._ When an allocation would pass the budget, or at a safe point (`endFrame`, the
   end of `prepareBundle`, `setMemoryBudget`), the renderer frees, in this order and least recently
   used first: the filter-result cache, the idle pools (released filter and coverage targets, idle
   shape and ping targets), the opaque prepass's depth meshes, the compacted meshes of
   `drawBundleInstanced`, the transient handles of bare draws (the handle `drawBundle`,
   `drawInstance`, `setBundle` or `render(bundle)` keeps for a bundle: its cover mesh and mask
   layers, made again by the bundle's next draw), the point lists, the group atlas. Bundles, the
   handles of `createBundleHandle` (with their mask arrays) and static-cache rasters are not
   evictable, and neither is the bound transient handle or one holding a static cache
   (`enableStaticCache`); dispose a bundle to free it.
3. _Nothing in use is evicted._ A cache entry, pool target, instanced or prepass mesh, transient
   handle, point list or atlas run that the current frame used is kept: inside an open frame, and at
   that frame's `endFrame` (it is the next frame's working set). An API call between frames finds no
   frame open, so everything idle is evictable. With no `beginFrame` ever called, "in use" means
   touched in the last 250 ms.

Essential resources (a bundle's own textures, the frame's targets, the targets a draw is using) are
never refused: a draw that needs them cannot be skipped. If they alone exceed the budget the excess
is reported in `policy.overBudgetBytes` with one warning, not hidden. Inside a frame the total can
pass the budget transiently (a filter target is allocated before the frame ends); `gpu.peakBytes`
shows that high-water and the budget is enforced at `endFrame`.

**Preparation peak.** `importSvg`, `createBundle`, `prepareBundle` and `createShapeMorph` run inside
brackets. Each records the exact GPU high-water inside it (`gpuPeakBytes`), the CPU bytes the
builders noted as transient (`cpuTransientBytes`; the CPatch plane, for one), and the JS heap growth
sampled at the bracket's edges and checkpoints where the host exposes a heap figure
(`heapPeakDeltaBytes`: Node, and Chrome's `performance.memory`; `null` elsewhere, and a sampled
lower bound, not an exact peak). `preparation.highWater` is the maximum over every bracket since
`resetMemoryPeaks()`. To bound a preparation peak, set a budget before preparing (the optional parts
are refused rather than allocated), prepare one bundle at a time, and read `preparation.recent`
after each.

### Arguments and lifetime

- **Handles.** Every public entry that takes a bundle (`drawBundle`, `submitBundle`,
  `drawBundleInstanced`, `drawInstance`, `drawSprite`, `createBundleHandle`, `prepareBundle`,
  `prewarmBundle`, `awaitEngine`, `awaitLbReady`, `warmScene`, `setSceneUnion`,
  `estimateRouteBytes`, `createOverrideTable`, `createFilterParams`, `updateBundleGeometry` and the
  four hit queries) also takes a morph, timeline or text handle and uses its `.bundle`.
- **Configuration setters** take numbers: `NaN` and non-numbers throw, every other number clamps.
  `setResolutionScale` clamps to `[0.05, 4]`; `setViewport(w, h)` truncates to whole pixels and
  clamps to `[1, 32767]`; `setScissorRect` truncates and clamps `x`, `y` to ±2^30 and `w`, `h` to
  `[0, 2^30]`; `setStrokeStrip` throws on an unknown `policy` or a `maxMode` other than 1 or 2 and
  clamps `minSavedPxPerVertex` to at least 0; `setFillPolicyOptions` takes booleans for the flags
  (`aacPointsRowGate`, `aacPointsColorMatrix`, `aacPointsBucket`, `cpatchAuto`) and numbers at least
  0 for the rest (`Infinity` is no limit), validates the whole patch before applying any of it, and
  warns once per key that names no option. `lbMinBundlePx2`, `aacPointsBufferBudget` and
  `aacPointsGen` are creation options and are not settable here.
- **Fill engine.** `setFillEngine({ route, kernel, primitives, commit, cpatch })` accepts
  `route: 'none' | 'lb' | 'cpatch' | 'cpatch-auto' | 'auto'`,
  `kernel: 'slug' | 'aac' | 'hard-band' | 'hard-tree' | 'auto'`,
  `primitives: 'on' | 'off' | boolean`; `null` / `undefined` leaves an axis alone and any other
  value throws before anything changes. `setLoopBlinnFill(mode)` takes
  `'off' | 'auto' | 'on' | 'only'` or a boolean (`true` is `'on'`, `false` / no argument is `'off'`)
  and throws on anything else. `getFillEngine()` may report `'only'` and `'force'` for the route;
  select those with `setLoopBlinnFill('only')` and the `unifiedFill: 'force'` option.
- **Data values are coerced.** Palette channels clamp to `[0, 255]`; an override table's
  `visibility` clamps to `[0, 1]` and a non-finite or missing field of `localScale`,
  `localPosition`, `localRotation`, `tint` keeps its identity value in `set()` and its current value
  in `update()`; a zero scale is kept (it hides the shape and keeps its rotation); `get()` reports
  the signed scale, so a mirror `localScale: [-1, 1]` reads back as rotation 0, scale `[-1, 1]`;
  `clearClipper` releases the row from `hasAny` / `activeIndices()` unless another override is set
  on it. `createImage` returns `null` (with a warning) for a pixel array shorter than
  `width * height * 4`. `appendPoints` drops a point with a non-finite coordinate. A morph's `setT`
  takes a number or numeric string clamped to `[0, 1]` (`NaN` reads as 0); a timeline's key times
  must be finite.
- **Options and per-draw values** are checked where they would otherwise pick a behavior by
  accident. `createRenderer` throws on `opts` that is not an object, on `aacFill` other than
  `true | false | 'auto'`, `unifiedFill` other than `true | false | 'force'`, on
  `psoWarmMaxWaitFrames`, `filterPoolIdleMs`, and `precompileFillsBudgetMs` that are not numbers at
  least 0, on `asyncShaderCompile`, `captureFrames`, `psoWarm`, `variantFirst`,
  `disableFillVariants`, `cacheKeepDepthStencil` and `warmMorphSources` that are not booleans, and
  on `onContextLost` / `onContextRestored` / `psoWarmIdle` that are not functions. A draw's
  `worldMatrix` must be a 9-float column-major mat3 of finite numbers (`null` or absent is none),
  `beginFrame`'s clear color `null`, absent or four finite numbers, and `setLoopBlinnMemoryBudget`
  takes a number of bytes at least 0 (`Infinity` is no limit). A disposed bundle or morph passed to
  `drawBundle` / `drawBundleInstanced` draws nothing, allocates nothing and warns once.
  `setResolutionScale` keeps the canvas's on-screen size: on a canvas with no CSS size it pins the
  current size first, so a scale is a fraction of the same screen size and repeating it changes
  nothing.
- **Workers.** `importSvg` needs `DOMParser`, which a browser has on the main thread but not inside
  a Worker: import on the main thread and transfer the sections (`createRenderer` / `createBundle`
  run in a Worker on an `OffscreenCanvas`). The shared worker pools (CPatch, Loop-Blinn, occupancy,
  occlusion) are created on first use, bounded in size, and live for the page. Each pool starts a
  module worker with `new Worker(new URL('./x.worker.js', import.meta.url))`, which Vite and webpack
  5 turn into emitted worker chunks. Where that cannot work (esbuild and rollup leave the URL
  pointing at a file they never emitted; a Content-Security-Policy `worker-src` forbids workers; a
  cross-origin module graph cannot start one) the pool logs one warning that names the cause and the
  same work runs on the main thread: slower, never wrong. `configureWorkers(options)` (from the root
  or `/renderer`) is the explicit control; call it before the first renderer or bundle:

  ```js
  import { configureWorkers } from '@kontek/mantle';

  configureWorkers({ enabled: false }); // never start a worker; no warnings
  // or give a pool your own script (a URL, or a factory returning a started Worker):
  configureWorkers({
    lb: '/assets/lbBuild.worker.js', // a URL or string; a module worker is started from it
    cpatch: () => new Worker('/assets/cpatch.worker.js', { type: 'module' }),
  });
  ```

  The pools are `lb` (Loop-Blinn mesh builds), `cpatch` (CPatch conversion), `occlusion` and
  `occupancy`. The worker scripts are exported (`@kontek/mantle/renderer/lbBuild.worker.js`,
  `cpatch.worker.js`, `occlusion.worker.js`, `occupancy.worker.js`); with esbuild, add them as extra
  entry points and pass the emitted URLs. Unknown options throw. `terminateWorkers()` stops every
  pool's running worker (for a page that is finished with Mantle or an app that wants its threads
  back): queued work finishes on the main thread, the policy above is unchanged, and the next
  request starts a fresh worker. It returns how many pools were asked to stop.

- **After `dispose()`.** A disposed renderer's draw, frame, `render`, `prepareBundle`,
  `prewarmBundle`, `precompileFills`, `awaitEngine`, `awaitLbReady` and `warmScene` entries do
  nothing (and allocate nothing), `createImage` returns `null`, `createBundleHandle` and
  `createIncrementalStroke` throw, and `dispose()` is idempotent. A disposed text handle's `setText`
  / `setStyle` resolve without building anything; a disposed morph's `setT` and a disposed
  timeline's `setTime` do nothing; an override table's `uploadIfDirty()` does nothing and its
  `texture` is `null`. A bundle's `dispose()` also frees the renderer's cached filter results for
  it.

### Subpath exports

Each `register*` module is a side-effect import — call it once at app boot to enable the
corresponding subsystem. A consumer that imports the subpaths it needs, and not the root barrel,
pays nothing for the others (the bundler leaves out the readers + shapers). The root barrel
registers everything and is marked as having side effects:
`import { importSvg } from '@kontek/mantle'` is about 345 KB<!--size:root:importSvg--> gzipped
against 150 KB<!--size:svg--> for `@kontek/mantle/svg`, and the whole root is about 783
KB<!--size:root-->. Sizes are single-file esbuild bundles, min + gzip;
`node scripts/measureBundleSizes.mjs` reproduces them (see STRIPPING.md in the repository for every
subpath, the usage matrix of what each way of using Mantle costs, and the import-map recipe for
serving the unbundled package from a CDN to several games). A feature you use without its import is
reported once, naming the exact import to add.

| Subpath                                                           | What it enables                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kontek/mantle/bundle`                                           | Bundle introspection only (2.6 KB<!--size:bundle--> gz).                                                                                                                                                                      |
| `@kontek/mantle/bundle/featureManifest`                           | Feature-bits → required JS module map (distribution stripping).                                                                                                                                                               |
| `@kontek/mantle/svg`                                              | SVG → bundle (150 KB<!--size:svg--> gz, no text).                                                                                                                                                                             |
| `@kontek/mantle/svg/auto`                                         | **Auto-register**: inspect an SVG and dynamic-`import()` exactly the filter / COLR handlers it uses — the SVG peer of `font/auto`.                                                                                            |
| `@kontek/mantle/renderer`                                         | WebGL bundle factory + render state machine (298 KB<!--size:renderer--> gz).                                                                                                                                                  |
| `@kontek/mantle/fallback`                                         | The auto chooser (`createMantleScene` / `chooseBackend`: WebGL when available, native when not; loads each lazily) and the native morph/override/text helpers.                                                                |
| `@kontek/mantle/native`                                           | The native-SVG scene with **no WebGL code** (66 KB<!--size:native--> gz): `createNativeScene`, `createMantleScene` (always native; `backend: 'webgl'` throws and names `/fallback`), override table, morph, timeline, stream. |
| `@kontek/mantle/native/text`                                      | Registers `scene.createTextBundle()` for the native entry (adds the font engine).                                                                                                                                             |
| `@kontek/mantle/renderer/features/{cpatch,frameExport,all}`       | Renderer features the `renderer` entry does not carry: the CPatch engine (`cpatchFill` / `cpatchAuto` / `route: 'cpatch'`) and `renderer.exportFrameSVG()`. Importing one registers it; the root imports all.                 |
| `@kontek/mantle/shaders`                                          | Shader loading (`bundleShaders.fromPackage()`, `loadShaders`) + build/feature-select toolchain (`assembleShader`, `minifyGlsl`, `shaderFilesFor`).                                                                            |
| `@kontek/mantle/shaders/bundled`                                  | The assembled shaders as named string exports (`fillVert`, `fillFrag`, …); import only the ones you use.                                                                                                                      |
| `@kontek/mantle/filterGraph`                                      | Generic filter-graph evaluator (SVG `<filter>` + COLRv1 dispatch).                                                                                                                                                            |
| `@kontek/mantle/animation`                                        | Animation primitives (overrides, shape morph, timelines).                                                                                                                                                                     |
| `@kontek/mantle/hitTest`                                          | Point-in-shape queries (no GL dep).                                                                                                                                                                                           |
| `@kontek/mantle/scene`                                            | Programmatic scene tree → Mantle bundle.                                                                                                                                                                                      |
| `@kontek/mantle/font/auto`                                        | **Auto-register**: sniff a font's tables + scripts and dynamic-`import()` exactly the readers/shapers it needs (see below).                                                                                                   |
| `@kontek/mantle/font/text`                                        | Lean text core: glyf outlines, LTR, default OT shaper (96 KB<!--size:font/text--> gz). CFF, bidi, scripts, color, variations are each opt-in below.                                                                           |
| `@kontek/mantle/font`                                             | Everything eagerly registered: all scripts + all OT readers + AAT (`morx`/`mort`/`kerx`/`ankr`/`feat`) + CFF + bidi (262 KB<!--size:font--> gz).                                                                              |
| `@kontek/mantle/font/formats/cff`                                 | CFF / CFF2 PostScript outlines (`.otf`). Glyf is always-on; this is opt-in.                                                                                                                                                   |
| `@kontek/mantle/font/color`                                       | COLR v0 + v1 + sbix + CBDT/CBLC + EBDT/EBLC + the SVG-in-OT table reader.                                                                                                                                                     |
| `@kontek/mantle/font/color/svgInOtImport`                         | SVG-in-OT glyph import (`registerSvgInOtImport()`); it carries the SVG importer, so it is its own import.                                                                                                                     |
| `@kontek/mantle/font/variations`                                  | fvar + gvar + HVAR + VVAR + MVAR + avar + STAT.                                                                                                                                                                               |
| `@kontek/mantle/font/math`                                        | OpenType MATH.                                                                                                                                                                                                                |
| `@kontek/mantle/font/formats/woff2`                               | WOFF2 (Brotli + glyf-transform decode).                                                                                                                                                                                       |
| `@kontek/mantle/font/typography/aat`                              | Apple Advanced Typography (`morx`/`mort`/`kerx`/`feat`/`ankr`) for AAT-only faces (Zapfino, GeezaPro, …).                                                                                                                     |
| `@kontek/mantle/font/typography/legacyKern`                       | Legacy `kern` table (positioning — sits with `kerx` under typography, not formats).                                                                                                                                           |
| `@kontek/mantle/font/typography/vertical`                         | VORG (vertical glyph origin).                                                                                                                                                                                                 |
| `@kontek/mantle/font/typography/baseline`                         | BASE table.                                                                                                                                                                                                                   |
| `@kontek/mantle/font/typography/bidi`                             | UAX #9 bidi (RTL). Opt-in: the lean path is LTR passthrough until registered — import this whenever Hebrew/Arabic/mixed-direction text is possible.                                                                           |
| `@kontek/mantle/font/typography/justification`                    | JSTF kashida justification (Arabic extender glyphs).                                                                                                                                                                          |
| `@kontek/mantle/font/scripts/{arabic,hangul,indic,math,thai,use}` | Per-script shapers (Arabic joining + forms, Hangul jamo, Devanagari / Bengali / Tamil / Telugu / Kannada / Malayalam / Gurmukhi / Gujarati / Oriya / Sinhala, Thai / Lao, Khmer / Myanmar).                                   |
| `@kontek/mantle/font/scripts`                                     | All script shapers in one barrel.                                                                                                                                                                                             |

Finer-grained subpaths exist for advanced/tree-shaking use: `@kontek/mantle/animation/colorMatrix` +
`@kontek/mantle/animation/colorPalette` (recolor helpers in isolation),
`@kontek/mantle/core/metaBin` + `@kontek/mantle/core/morphCore` (low-level bundle/morph cores), and
`@kontek/mantle/filterGraph/{dispatchRegistry,primitives/all,colr/paints}` (register custom
filter-graph primitives).

For distribution stripping, `inspect(bundle)` / `Features` (from `@kontek/mantle/bundle`) report
which subsystems an asset uses, and `@kontek/mantle/bundle/featureManifest` maps those bits to the
modules you need to register.

```js
// Manual: you know exactly what your fonts use (smallest initial bundle).
// Latin + woff2 + variable-font web app:
import { MantleFontAsset, buildTextRun } from '@kontek/mantle/font/text';
import { registerWoff2Reader } from '@kontek/mantle/font/formats/woff2';
import { registerVariableFontReaders } from '@kontek/mantle/font/variations';
registerWoff2Reader();
registerVariableFontReaders();
```

#### Automatic registration

Don't want to hand-enumerate? `font/auto` sniffs the font's sfnt table directory

- GSUB/GPOS script list (and OS/2 ranges for AAT/RTL fonts) and registers exactly what it needs —
  CFF, variations, color, MATH, AAT, the right script shaper(s), and bidi for RTL — and still
  tree-shakes: every optional subsystem is loaded with a dynamic `import()`, so a bundler emits one
  lazily-loaded chunk per subsystem and your _initial_ bundle stays at the lean core. WOFF2 input is
  decoded transparently.

```js
import { MantleFontAsset } from '@kontek/mantle/font/text';
import { autoRegisterForFont } from '@kontek/mantle/font/auto';

const raw = new Uint8Array(await (await fetch('/fonts/MyFont.otf')).arrayBuffer());
const { bytes, registered } = await autoRegisterForFont(raw); // bytes = raw sfnt (woff2-decoded)
const font = new MantleFontAsset(bytes);
// registered → e.g. ['font/formats/cff', 'font/scripts/arabic', 'font/typography/bidi']
```

Automatic registration loads modules detected from the font tables. Manual registration keeps module
loading under application control.

## Test / debug hooks

Backend selection is an explicit API: `createMantleScene(canvas, { backend: 'native' })` (or
`forceNative: true`) pins the no-WebGL fallback, and `chooseBackend()` exposes the same decision for
callers that branch their own setup. Those options are the only way to force it: there is no URL
parameter or global that picks the backend from outside the app.

Additional A/B hooks (`__MANTLE_NO_*`) are gated behind `globalThis.__MANTLE_DEBUG__ = true` and
read through `mantleDebugFlag(name)`. Without that master switch they are inert. Prefer explicit
APIs (`renderer.setLoopBlinnFill(...)`, `renderer.setLoopBlinnMeshOpts({ forceCdt })`,
`importSvg({ gwnTree: true })`, `setDiagnostics(...)`) in application code.

Everything else is an explicit API: `setDiagnostics({ colrTrace: [], engineTrace: true })` collects
traces, and `createShapeMorph(gl, src, dst, { cpuLerp: true })` pins a morph to the CPU curve
interpolation path. Prefer `setDiagnostics({ silent: true })` to silence library warnings in
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

## Status

The public API in the 1.2.0 release (`importSvg`, `createBundle`, `createRenderer`,
`createShapeMorph`, `createOverrideTable`, `createTextBundle`, renderer
preparation/dynamic-resolution APIs, instancing, incremental strokes, `inspect`, and hit testing)
and the per-subpath registration modules are stable. Internal helpers and GLSL helper-substitution
markers are not part of the public API.

## Known limitations

- **Far art is stored relative to a bundle origin.** Coordinates are float32 on the GPU, and a
  float32 at 1e7 spaces 1.0 apart, so unit-sized art at a game-world or UTM offset would be a smear.
  `importSvg` therefore subtracts an **origin** from every coordinate in float64 before the float32
  store whenever the art lies more than 64 of its own sizes from the document origin (art near the
  origin is stored exactly as before, byte for byte). `opts.origin = [x, y]` forces one (a sprite
  sheet's bundles can share one), `opts.origin = false` stores absolute coordinates. `bundle.origin`
  is the pair (`[0, 0]` for art near the origin); a document point is `stored + origin`. Everything
  that takes or returns a position in _bundle units_ is in the stored frame: `bundle.globalBBox` and
  `viewBox`, `fillHit*` points (pass `x - bundle.origin[0]`), `renderer.bundleDrawMatrix`, a
  nine-slice `nativeBBox`, the SVG and scene exports. The draw fits the content box, so where a
  bundle lands on screen does not depend on the origin. What keeps its document meaning: an override
  table (`localRotation` and `localScale` turn about the document origin, as before; `localPosition`
  is a move), `updateBundleGeometry` (segments in document coordinates; `buildStreamableSections`
  takes `opts.origin`). A morph needs one origin for both poses
  (`importSvg(svg, { origin: [x, y] })` pins it; two bundles with different origins are refused by
  name), and `retainSource` (the native SVG fallback draws the retained markup as written) keeps
  absolute coordinates.
- **Deep zoom meets float32.** The coverage kernels hold coordinates and curve parameters in
  float32, so accuracy depends on how many device pixels a segment spans and how far the pixel lies
  from the bundle's coordinate origin; the error in pixels is about that distance times 2^-24,
  whatever the matrix. A cubic spanning 2^17 px is off by about 3/255 at worst, 2^19 px by about
  12/255, 2^21 px by about a third of a pixel, and past 2^22 px neighboring pixels read different
  edges and the fill speckles. A native arc stays filled at any zoom, but from a radius of 2^21
  device px its edge is limited by the float32 ulp of an angle, about the radius times 2^-21 at
  worst. A `<circle>` or a round `<rect>` the importer tags (flat fill, no clip or mask) takes a
  closed form from that radius, with half to an eighth of that error, except under a pinned engine,
  which keeps the walk it asked for. On a 512 px canvas, with art filling the canvas at zoom 1,
  those are `worldMatrix` scales of 2^8, 2^10, 2^12 and 2^14. Art whose segments in view are short
  and whose coordinates there are small draws correctly at any matrix (measured to 2^20). To zoom
  further into long curves, cut the path near the view and import that piece with `opts.origin` near
  the view.
- **Hit-only shapes follow overrides, not morphs or streaming.** A shape the importer draws nothing
  for but a pointer can still target (see the hit model above) follows an override table by id, by
  index and through its group, but a morph pose and a streaming update do not move it: a morph keeps
  the source's hit-only shapes until `t = 0.5` and the destination's after, at their authored
  places, and `updateBundleGeometry` leaves them where they were authored. Both warn once per bundle
  that has hit-only shapes. `importSvg` finds them with a second pass over the document, only when
  there is one to find; `bundleForm` output and bundles that did not come from `importSvg` carry
  none (so their transparent targets are missing from the hit test, silently), and the SVG and scene
  exports do not write them.
- **Thin and folded Loop-Blinn geometry.** Where an arc's sag is under about 0.7 px, or a sliver is
  thinner than a pixel, the Loop-Blinn route can paint an interior pixel too dark (up to about
  105/255 at the worst pixel of an 80:1 sliver) because a face carries either a straight ramp or the
  arc, never both. Capsule and rounded-rectangle ends can show a few pixels off by 50-107/255 where
  a line meets an arc. Slug, AAC and CPatch do not show this; pin `setFillEngine` to one of them if
  an asset needs it.
- **`keepHidden` reveal on the Loop-Blinn route.** An override `reveal` of a kept-hidden row drawn
  beside visible rows is exact on the cover-quad route and differs from Chrome by up to 221/255 on
  the Loop-Blinn route. `keepHidden` is off by default.
- **Zero-size content is not a morph source.** A zero-width stroke, a zero-size rect/circle/ellipse
  and a marker at stroke width 0 are counted in `bundle.dropped` but not kept, so a width override
  or a morph cannot grow them in.
- **Cold GPU caches.** Shader links and first draws can trigger driver compilation. Use
  `precompileFillsAsync()` or `warmScene()` behind a loading screen. New or undeclared draw states
  can still block under the default strict policy; see _Shader preparation and cold GPU caches_.
- **Native (no-WebGL) scene.** A morph does not switch filters between poses and drops
  destination-only rows that carry no curves (their group opacity and clip); geometry writes to a
  `<use>` inside a pattern, clipPath, mask or marker hold the authored pose and warn once;
  `FillPaint`/`StrokePaint` and `feImage` element references are not drawn.
- **Text.** Only CPAL palette 0 is read for color fonts; adjacent glyphs painted with separate alpha
  paints can show a seam along their shared edge (shared-edge coverage is not correlated between
  rows).
- Hit tests do not account for filters, blend modes, group opacity, masks or recolor.

## Author

Aaron Kaluszka <<megabyte@kontek.net>>

## Credits

Mantle implements published algorithms including:

- **Charles Loop & Jim Blinn** — the implicit-curve rendering method behind the analytic mesh fill
  ("Resolution Independent Curve Rendering using Programmable Graphics Hardware", SIGGRAPH 2005 —
  https://doi.org/10.1145/1073204.1073303).
- **Josiah Manson & Scott Schaefer** — the closed-form per-pixel curve-area integral ("Analytic
  Rasterization of Curves with Polynomial Filters", _Computer Graphics Forum_ (Eurographics 2013)
  32(2) — https://doi.org/10.1111/cgf.12042).
- **Eric Lengyel** — the Slug ray-cast coverage algorithm and its root-eligibility table
  ("GPU-Centered Font Rendering Directly from Glyph Outlines", _JCGT_ 6(2), 2017 —
  https://jcgt.org/published/0006/02/02/).
- **Alec Jacobson, Ladislav Kavan & Olga Sorkine-Hornung** — the generalized winding number behind
  the tree fill: winding as a sum of per-segment subtended angles ("Robust Inside-Outside
  Segmentation using Generalized Winding Numbers", SIGGRAPH 2013 —
  https://doi.org/10.1145/2461912.2461916). The curved-arc term — a chord's subtended angle plus the
  winding of the arc↔chord lune — is the curve-domain GWN of **Jacob Spainhour, David Gunderman &
  Kenneth Weiss** ("Robust Containment Queries over Collections of Rational Parametric Curves via
  Generalized Winding Numbers", SIGGRAPH 2024 — https://doi.org/10.1145/3658228).
- **Mark Dokter, Jozef Hladky, Mathias Parger, Dieter Schmalstieg, Hans-Peter Seidel & Markus
  Steinberger** — the CPatch fill, a region bounded by implicit half-spaces inside a box
  ("Hierarchical Rasterization of Curved Primitives for Vector Graphics Rendering on the GPU",
  _Computer Graphics Forum_ (Eurographics 2019) 38(2) — https://doi.org/10.1111/cgf.13622).
- **Cem Yuksel** — the polynomial root finder used for cubic coverage ("High-Performance Polynomial
  Root Finding for Graphics", _PACMCGIT_ 5(3), 2022 — https://doi.org/10.1145/3543865).
- **Thomas Sederberg & Tomoyuki Nishita** — Bézier clipping ("Curve intersection using Bézier
  clipping", _CAD_ 22(9), 1990 — https://doi.org/10.1016/0010-4485(90)90039-F), used for curve×curve
  intersection.
- **Mapbox** — the ear-clipping triangulator is a port of [earcut](https://github.com/mapbox/earcut)
  (ISC, © 2016 Mapbox); notice preserved in `NOTICE`.

## License

Licensed under Apache-2.0 — see [`LICENSE`](LICENSE).
