# No-WebGL fallback — native-SVG rendering

When `canvas.getContext('webgl2')` returns `null` (GPU blocklist, an old browser, some headless
setups), Mantle can render the **original source SVG** through the browser's own SVG engine. The
fallback mirrors Mantle's scene API, so the same draw loop can run on either backend:

```js
import { importSvg, createBundle, createRenderer, createNativeScene } from '@kontek/mantle';

// Retain the source so the fallback can re-host the markup.
const sections = await importSvg(svgText, { retainSource: true });

const gl = canvas.getContext('webgl2');
const useGL = !!gl;

const renderer = useGL ? createRenderer(gl, shaders) : createNativeScene(host);
const bundle = useGL ? createBundle(gl, sections) : sections; // native path draws `sections` directly

function frame() {
  renderer.setViewport(w, h);
  renderer.beginFrame([r, g, b, a]);
  renderer.drawBundle(bundle, { worldMatrix, overrides });
  renderer.endFrame();
  requestAnimationFrame(frame);
}
```

The `beginFrame` color is straight (non-premultiplied) RGBA in 0..1 on both backends: the WebGL
renderer premultiplies it for the canvas and the native scene writes it as `rgba(...)`, so
`[1, 0, 0, 0.5]` is half-transparent red either way.

`host` is an `<svg>`, a container element (an `<svg>` is created inside), or a `<canvas>` (an
`<svg>` overlay is created — pass an `<svg>`/container to avoid the overlay).

## Auto-selecting factory + forcing the fallback for testing

`createMantleScene(canvas, …)` owns the gl-vs-native decision in one place, so you don't hand-write
the seam — and so you can **force the native path for testing** without touching app code. It is
**async**: it `import()`s only the backend it selects, so a native run never downloads the WebGL
pipeline and a WebGL run never downloads the native fallback.

```js
import { createMantleScene } from '@kontek/mantle';

const scene = await createMantleScene(canvas, { shaders }); // auto: webgl if available
scene.setViewport(w, h);
const drawable = scene.toScene(sections); // once, outside the frame loop (see below)
scene.beginFrame([r, g, b, a]);
scene.drawBundle(drawable, { worldMatrix, overrides });
scene.endFrame();
// scene.backend === 'webgl' | 'native'
```

### Drop-in for an existing `createRenderer` consumer

`createMantleScene` is a **one-line drop-in**. On WebGL it returns the _actual_ renderer object
(augmented with `.backend`, `.gl`, `.toScene`), so every `renderer.*` call you already make —
`drawSprite`, `drawBundleInstanced`, `createBundleHandle`, `enableStaticCache`, `setScissorRect`, …
— keeps working unchanged:

```js
// before
const renderer = createRenderer(gl, shaders);
// after — nothing else in your code changes
const renderer = await createMantleScene(canvas, { shaders });
```

On the **native** backend the scene exposes the same method surface, and most renderer methods are
**real fallbacks**, not stubs:

| Method                                                               | Native behavior                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `drawSprite` / `drawSpriteInstanced`                                 | **real** — draws the sprite's shapes, hides the rest (subset by `spriteRanges`)                 |
| `drawBundleInstanced` / `drawImageInstanced`                         | **real** — one draw per instance (no GPU bind-once to amortize)                                 |
| `drawInstance`                                                       | **real** — `drawBundle` mid-frame                                                               |
| `setScissorRect` / `clearScissorRect`                                | **real** — CSS `clip-path: inset()` on the `<svg>`                                              |
| `createImage`                                                        | a token `drawImage` accepts; a pixel source's is a `blob:` URL (`ready`, `dispose()`)           |
| `createBundleHandle`                                                 | returns `{ bundle }` (no GPU cache to handle)                                                   |
| `enableStaticCache` / `disableStaticCache` / `invalidateRenderState` | **no-op** — GPU render-target caching has no native analogue (the browser re-rasterizes anyway) |

So the scene loop you wrote against the renderer runs on both backends. The only things that can't
run on native are operations with no DOM/SVG equivalent — and those degrade to a real subset draw or
a quiet no-op, never a crash. (The one async change: `createMantleScene` is `await`ed because it
`import()`s the backend.)

#### Binding factories (overrides / morph / timeline / palette)

These take `gl` as free functions (`createOverrideTable(gl, bundle)`, `createShapeTimeline(gl, …)`,
…) and have separately-named native counterparts — so a consumer using them would otherwise need to
gate each call site (`gl ? createOverrideTable(gl, b) : createNativeOverride- Table(b)`). The scene
exposes **backend-agnostic** versions so you don't:

| Scene method                                            | WebGL routes to                                | Native routes to                                              |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `scene.createOverrideTable(bundle)`                     | `createOverrideTable(gl, bundle)`              | `createNativeOverrideTable(bundle)`                           |
| `scene.createMorph(src, dst, {srcSprite?, dstSprite?})` | `createShapeMorph` / `createSpriteMorph`       | `createNativeMorph`                                           |
| `scene.createTimeline(refs, keys)`                      | `createShapeTimeline` / `createSpriteTimeline` | `createNativeTimeline`                                        |
| `scene.createPalette(entries)`                          | `createPalette(gl, entries)`                   | inert token + warn (GPU-only; use per-shape `fill` overrides) |

`createMorph` picks a sprite vs whole-bundle morph by whether a sprite is named; `createTimeline`
picks sprite vs bundle-array by whether the refs are `{bundle, sprite}` / keys use `refIndex`. So:

```js
// before — gated at every binding site:
const ov = gl ? createOverrideTable(gl, b) : createNativeOverrideTable(b);
const tl = gl ? createSpriteTimeline(gl, refs, keys) : createNativeTimeline(refs, keys);
// after — no gl, no gate:
const ov = scene.createOverrideTable(b);
const tl = scene.createTimeline(refs, keys);
const m = scene.createMorph(src, dst, { srcSprite, dstSprite });
```

The free functions stay exported for low-level/direct use; these scene methods are the drop-in path.
(They're lazy-loaded with the backend, so `/fallback` stays gl-free.)

### Bundle size / code splitting

The whole native fallback is gl-free. Two ways to keep the WebGL pipeline out of a native-only
build:

- **`@kontek/mantle/fallback`** subpath — imports `createNativeScene` / `createNativeMorph` /
  `createMantleScene` without statically pulling `renderer.js`. Statically reachable source
  (unminified, comments included): **1414 KB<!--src:fallback--> vs 6158 KB<!--src:root-->** for the
  package root. `renderer.js` (the GL pipeline) and `bundle.js` are excluded; the SVG importer (with
  the filter-graph builders it uses) and the font code are not (the native scene re-hosts retained
  source SVG and shapes native text), which is most of the difference in size from `/svg` alone.
- **`@kontek/mantle/native`** subpath — the native scene with no WebGL code at all, reached by
  neither a static nor a dynamic import (`test/nativeEntrySmoke.mjs` fails if it reaches
  `src/renderer/` or `src/shaders/`). It exports the same scene factories, the native
  override/morph/timeline/stream helpers and a `createMantleScene` that is always native:
  `backend: 'webgl'` throws, naming `@kontek/mantle/fallback`. Text on the native scene is its own
  import, `@kontek/mantle/native/text`.
- **`createMantleScene`'s dynamic `import()`** — even from the root, the factory only fetches the
  backend it picks at runtime.

The gl-free heart of the morph (`src/core/morphCore.js`) and meta parsing (`src/core/metaBin.js`)
are shared by both the WebGL morph and the native morph, so there's one source of truth and the
native path reuses it with zero GL code. (Verified: the `/fallback` import graph reaches no
`renderer.js` / `bundle.js` module.)

`scene.toScene(sections)` returns the right drawable for the active backend (a GL bundle on webgl,
the sections themselves on native), so the draw loop is identical across both. On WebGL it builds a
GPU bundle, so call it **once per `sections` object, outside the frame loop**: it is memoized per
(`sections`, options), so a repeated call returns the same bundle rather than uploading a new one (a
bundle you `dispose()`, or one built before a lost context was restored, is rebuilt on the next
call). Mutating `sections` afterwards is not picked up; pass a new object for new content. Dispose
the bundle yourself when you are done with it.

The native path is selected when **any** of these is set (in order):

| How                          | Use                       |
| ---------------------------- | ------------------------- |
| `opts.backend: 'native'`     | hard override (strongest) |
| `opts.forceNative: true`     | per-call force            |
| WebGL2 genuinely unavailable | the real fallback trigger |

Force the **other** way with `opts.backend: 'webgl'` (throws if WebGL2 is missing) to A/B the same
page. `chooseBackend(canvas, opts)` exposes just the decision (`{ backend, gl }`) if you want to
branch your own setup — e.g. only fetch shaders when WebGL wins.

For low-level testing you can always skip the factory and call `createNativeScene(host)` directly,
which is unconditionally native.

## The retained source: scoping and sanitizing

The scene clones a bundle's retained `svgSource` into the host document. Two things happen to that
clone:

- **Styles stay with their bundle.** A `<style>` in a bundle is rewritten so every rule applies only
  inside that bundle's own group (selectors are prefixed with `[data-mantle-scope="…"]`, a leading
  `svg` / `:root` names the group), so one bundle's `rect { fill: red }` cannot restyle another
  bundle drawn into the same `<svg>`. Ids the scene renames to keep bundles apart (`a` → `a_b3`) are
  rewritten inside the style text too, in `#a` selectors and `url(#a)` references, so id rules keep
  matching. `@keyframes` names stay global.
- **Active content is removed.** `<script>`, `<foreignObject>`, `on*` attributes and `javascript:`
  hrefs are dropped from the clone (the bundle's own `svgSource` string is untouched). Pass
  `createNativeScene(host, { allowActiveContent: true })` (or
  `exportFrameSVG({ allowActiveContent: true })`) to keep them for a source you trust; an untrusted
  SVG should never use it.

## Exporting the current frame as SVG

The WebGL renderer can serialize the frame it just drew by replaying its recorded draw list through
this native scene: `renderer.exportFrameSVG(opts)`. Recording must be on before that frame
(`createRenderer(gl, shaders, { captureFrames: true })` or `renderer.setFrameCapture(true)`), or the
call throws. Bundles need `importSvg(text, { retainSource: true })`. It needs a DOM (`document`,
`DOMParser`, `XMLSerializer`); in Node pass a DOM implementation as `{ document }` and install the
parser globals. The README's API section lists the options. Notes on the output:

- Deterministic: authored ids are kept (an id is renamed only when a second clone of the same bundle
  would collide), generated ids restart at 0 for every export, and the internal `data-oid` /
  `data-mantle-rows` markers are not written.
- Repeated draws of one bundle (`drawBundleInstanced`) share one template through `<use>` instead of
  repeating the clone, its `<defs>` and its images.
- `setScissorRect`, `setNodeClip` (`in` and `out`) and a `dstRect` draw's `clipToRect` box are
  replayed per draw in the default `coordinateSpace: 'viewport'`; in `'bundle'` space a note says
  they were not replayed.
- A draw with a non-finite `worldMatrix` or `colorMatrix` is skipped with a note, and a non-finite
  `clearColor` channel is written as 0.

## Why native SVG (not a Canvas2D re-rasterizer)

Mantle's bundle is a one-way GPU encoding: it flattens subpath/contour structure, bakes transforms,
and discards the source `<mask>`/`<filter>`/ `<clipPath>` geometry — so you can't faithfully replay
it into Canvas2D `Path2D`. But the browser already _has_ a complete SVG rasterizer. Handing it the
original markup gets masks, filters, clips, gradients, and patterns for free, re-evaluated every
frame as geometry moves. The cost is keeping the source string (opt-in `retainSource`); regular
WebGL consumers pay nothing.

## One `<svg>`, not N overlaid

The WebGL renderer composites bundles by **painter's algorithm** — each `drawBundle` paints over the
previous in call order, with no cross-bundle pixel interaction. That's exactly SVG's document-order
paint model, so the whole scene maps to sibling `<g transform="matrix(…)">` nodes inside **one**
`<svg>`. Z-order = sibling order = call order. (`worldMatrix` is a column-major mat3 in em space; it
drops into `matrix(m00,m10,m01,m11,tx,ty)`.)

## Animation support

| Feature                                         | Fallback | How                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-shape override: move / scale / rotate       | ✓        | element `transform`                                                                                                                                                                                                                                                                                                                                                                          |
| Per-shape override: visibility                  | ✓        | `opacity` / `display:none`                                                                                                                                                                                                                                                                                                                                                                   |
| Per-shape override: recolor (fill/stroke/width) | ✓        | paint attributes                                                                                                                                                                                                                                                                                                                                                                             |
| Animated clip transform (`setClipper`)          | ✓        | transform on the `<clipPath>`                                                                                                                                                                                                                                                                                                                                                                |
| Masks / filters on animated shapes              | ✓        | browser re-evaluates the source `<mask>`/`<filter>` per frame                                                                                                                                                                                                                                                                                                                                |
| **Geometry morph** (shape / sprite / timeline)  | ✓        | `createNativeMorph` / `createNativeTimeline` rewrite each shape's `d` per frame                                                                                                                                                                                                                                                                                                              |
| Raster `<image>` (data: URI) in a bundle        | ✓        | re-hosted verbatim; browser decodes natively                                                                                                                                                                                                                                                                                                                                                 |
| Raster `<image>` (relative / remote href)       | ✓        | atlas-inlined to a data URI (or absolutized via `baseUrl`)                                                                                                                                                                                                                                                                                                                                   |
| **Raster blit** (`drawImage`) compositing       | ✓        | `scene.drawImage(source, opts)` — the native analogue of the WebGL blit                                                                                                                                                                                                                                                                                                                      |
| Filter-_parameter_ tweening (blur σ over time)  | ✗        | `createFilterParams(bundle)` writes the WebGL bundle's parameters; this backend draws from the retained source SVG, so a tween would have to rewrite the `<filter>`'s attributes in the cloned DOM. Not wired — a scene that tweens a filter renders it at its authored value here.                                                                                                          |
| `drawBundle` `dstRect` / `fit` / `clipToRect`   | ✓        | the same content-bbox fit as WebGL (one shared function), composed into the group's `worldMatrix` through the inverse of the root `viewBox` fit (as is in `coordinateSpace: 'viewport'`), plus a pixel-space `<clipPath>` re-aimed each frame. Needs `setViewport`; a `worldMatrix` given with the rect acts first, in em space. `drawBundleInstanced` refuses a shared rect, as WebGL does. |
| Bit-exact match to WebGL coverage               | ✗        | the browser's rasterizer differs sub-pixel                                                                                                                                                                                                                                                                                                                                                   |

Overrides are driven through a CPU override table with the same surface as the GL one:

```js
import { createNativeOverrideTable } from '@kontek/mantle';
const table = createNativeOverrideTable(sections);
table.set('hat', { localPosition: [10, 0], fill: [1, 0, 0, 1] });
table.setClipper('reveal', { localPosition: [dx, 0] });
scene.drawBundle(sections, { overrides: table });
```

### Geometry morphs

`createNativeMorph` / `createNativeTimeline` reuse the engine's own (pure-CPU) morph plan + curve
lerp — the _only_ thing they do differently from `createShapeMorph` is decode the lerped curve
buffer into an SVG `d` string (`curveRangeToPathD`) instead of uploading it to a texture. The scene
rewrites each matched shape's `<path d="…">` per frame; primitives (`<rect>`/`<circle>/…`) are
auto-promoted to `<path>` the first time a morph touches them.

```js
import { createNativeMorph } from '@kontek/mantle';
const morph = createNativeMorph(sheet, sheet, { srcSprite: 'idle', dstSprite: 'run' });
scene.drawBundle(morph.bundle, { overrides: morph.overrides });
morph.setT(t); // 0 = idle, 1 = run, between = tweened geometry
```

**Limit (shared with the WebGL morph):** only matched-topology shapes (same id / position, same
curve length) tween geometrically; the rest crossfade by visibility. A `dst-only` shape has no
element in the source markup, so the native morph injects a `<path>` for it into the drawn group and
fades it in; every dst-only shape is drawn. `morph.unrenderableDstOnly` is always `[]` (kept so
existing code that reads it still works).

**Native morph paint:** the native morph drives solid fill and stroke colors, stroke width, bitmap
placement, opacity and gradients through the override table. A matched shape's gradient tweens
exactly where the WebGL morph tweens it: both poses paint the shape with a gradient of the same
type, the shape has no image paint, and the parameters (axis or center/radius/focus, the
gradient-space transform) lerp, and the stops (offsets, colors, stop opacity) lerp when both poses
have the same number of stops. A gradient of another type on the other pose is held whole at the
source's; a different number of stops holds the source's stops while the parameters still tween. The
WebGL morph does the same. Spread method and units come from the source pose.

## Raster compositing

Two kinds of raster content, both handled:

**Raster `<image>` inside a bundle** — survives verbatim in the source string. `data:` URIs decode
natively. For relative/remote hrefs (which the browser would otherwise resolve against the _page_
URL, or taint cross-origin), the fallback **inlines them to data URIs from the bundle's decoded
image atlas** (`imageAtlas` / `imageAtlasRects`) — the exact bytes the WebGL path used,
cross-origin-safe. Disable with `drawBundle(b, { inlineFromAtlas: false })`, or absolutize instead
via `{ baseUrl }`.

**Standalone raster blit** — `scene.drawImage(source, opts)` is the native analogue of
`renderer.drawImage`, so you can composite a raw raster _alongside_ SVG bundles in the same scene
(call order = z-order, same as WebGL):

```js
scene.beginFrame([0, 0, 0, 0]);
scene.drawBundle(drawable, { worldMatrix }); // drawable = scene.toScene(sections), made once
scene.drawImage(pixelsOrUrl, { dstRect: [x, y, w, h], alpha, blendMode });
scene.endFrame();
```

`source` is the same set the WebGL `createImage` accepts — `{width, height, rgba}` pixels, an
`<img>`/`<canvas>`/`ImageBitmap`/`ImageData`, or a data/remote URL string. `opts`: `dstRect` (canvas
px, default = natural size at origin), `srcRect` (sub-image), `worldMatrix`, `alpha`, `tint` (RGB →
feColorMatrix, alpha → opacity), `colorMatrix` / `colorMatrixOffset` (per-draw recolor → a second
feColorMatrix chained ahead of the tint's, matching the GL shader's order), `blendMode` (→ CSS
`mix-blend-mode`). Rasters live in a nested `<svg viewBox="0 0 vpW vpH">` so they place in
viewport-pixel space, independent of any bundle's em/bbox viewBox — matching the WebGL blit's
pixel-space semantics.

`scene.createImage(source)` returns a token to draw every frame. A pixel source (a canvas, pixels,
`ImageData`, an `ImageBitmap`) is encoded off the frame to a `blob:` URL of its pixels at creation,
as WebGL uploads them at creation, so each `<image>` of it takes a short href rather than a PNG
`data:` URL. `await token.ready` before the first draw; a token drawn before then takes a `data:`
URL of its pixels at that draw and keeps it. `token.dispose()` revokes the URL. `exportFrameSVG()`
writes each `blob:` href as a `data:` URL, so an exported frame stays self-contained; markup
serialized from `scene.svg` directly keeps the `blob:` hrefs, which resolve only in this page. A raw
canvas passed to `drawImage` stays live: it is encoded again at every draw.

Both `drawBundle` and `drawImage` are on `createMantleScene`'s returned scene too, so raster
compositing is backend-agnostic.

## Rasterization

Native SVG uses the browser's rasterizer, so edge pixels can differ from WebGL output. The scene API
reproduces transforms, visibility, recolor, clip motion and geometry morphs. The browser handles
masks, filters and clips natively.
