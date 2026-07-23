# No-WebGL fallback — native-SVG rendering

When `canvas.getContext('webgl2')` returns `null` (GPU blocklist, an old
browser, some headless setups), Mantle can render the **original source
SVG** through the browser's own SVG engine instead of the Slug WebGL
renderer. The fallback mirrors the renderer's scene API, so a consumer's
draw loop runs unchanged behind one seam:

```js
import { importSvg, createBundle, createRenderer, createNativeScene } from '@kontek/mantle';

// Retain the source so the fallback can re-host the markup.
const sections = await importSvg(svgText, { retainSource: true });

const gl = canvas.getContext('webgl2');
const useGL = !!gl;

const renderer = useGL ? createRenderer(gl, shaders) : createNativeScene(host);
const bundle   = useGL ? createBundle(gl, sections) : sections;   // native path draws `sections` directly

function frame() {
  renderer.setViewport(w, h);
  renderer.beginFrame([r, g, b, a]);
  renderer.drawBundle(bundle, { worldMatrix, overrides });
  renderer.endFrame();
  requestAnimationFrame(frame);
}
```

`host` is an `<svg>`, a container element (an `<svg>` is created inside),
or a `<canvas>` (an `<svg>` overlay is created — pass an `<svg>`/container
to avoid the overlay).

## Auto-selecting factory + forcing the fallback for testing

`createMantleScene(canvas, …)` owns the gl-vs-native decision in one
place, so you don't hand-write the seam — and so you can **force the
native path for testing** without touching app code. It is **async**: it
`import()`s only the backend it selects, so a native run never downloads
the WebGL pipeline and a WebGL run never downloads the native fallback.

```js
import { createMantleScene } from '@kontek/mantle';

const scene = await createMantleScene(canvas, { shaders });   // auto: webgl if available
scene.setViewport(w, h);
scene.beginFrame([r,g,b,a]);
scene.drawBundle(scene.toScene(sections), { worldMatrix, overrides });
scene.endFrame();
// scene.backend === 'webgl' | 'native'
```

### Drop-in for an existing `createRenderer` consumer

`createMantleScene` is a **one-line drop-in**. On WebGL it returns the
*actual* renderer object (augmented with `.backend`, `.gl`, `.toScene`),
so every `renderer.*` call you already make — `drawSprite`,
`drawBundleInstanced`, `createBundleHandle`, `enableStaticCache`,
`setScissorRect`, … — keeps working unchanged:

```js
// before
const renderer = createRenderer(gl, shaders);
// after — nothing else in your code changes
const renderer = await createMantleScene(canvas, { shaders });
```

On the **native** backend the scene exposes the same method surface, and
most renderer methods are **real fallbacks**, not stubs:

| Method | Native behavior |
|---|---|
| `drawSprite` / `drawSpriteInstanced` | **real** — draws the sprite's shapes, hides the rest (subset by `spriteRanges`) |
| `drawBundleInstanced` / `drawImageInstanced` | **real** — one draw per instance (no GPU bind-once to amortize) |
| `drawInstance` | **real** — `drawBundle` mid-frame |
| `setScissorRect` / `clearScissorRect` | **real** — CSS `clip-path: inset()` on the `<svg>` |
| `createImage` | returns a token `drawImage` accepts |
| `createBundleHandle` | returns `{ bundle }` (no GPU cache to handle) |
| `enableStaticCache` / `disableStaticCache` / `invalidateRenderState` | **no-op** — GPU render-target caching has no native analogue (the browser re-rasterizes anyway) |

So the scene loop you wrote against the renderer runs on both backends.
The only things that can't run on native are operations with no
DOM/SVG equivalent — and those degrade to a real subset draw or a quiet
no-op, never a crash. (The one async change: `createMantleScene` is
`await`ed because it `import()`s the backend.)

#### Binding factories (overrides / morph / timeline / palette)

These take `gl` as free functions (`createOverrideTable(gl, bundle)`,
`createShapeTimeline(gl, …)`, …) and have separately-named native
counterparts — so a consumer using them would otherwise need to gate
each call site (`gl ? createOverrideTable(gl, b) : createNativeOverride-
Table(b)`). The scene exposes **backend-agnostic** versions so you don't:

| Scene method | WebGL routes to | Native routes to |
|---|---|---|
| `scene.createOverrideTable(bundle)` | `createOverrideTable(gl, bundle)` | `createNativeOverrideTable(bundle)` |
| `scene.createMorph(src, dst, {srcSprite?, dstSprite?})` | `createShapeMorph` / `createSpriteMorph` | `createNativeMorph` |
| `scene.createTimeline(refs, keys)` | `createShapeTimeline` / `createSpriteTimeline` | `createNativeTimeline` |
| `scene.createPalette(entries)` | `createPalette(gl, entries)` | inert token + warn (GPU-only; use per-shape `fill` overrides) |

`createMorph` picks a sprite vs whole-bundle morph by whether a sprite is
named; `createTimeline` picks sprite vs bundle-array by whether the refs
are `{bundle, sprite}` / keys use `refIndex`. So:

```js
// before — gated at every binding site:
const ov = gl ? createOverrideTable(gl, b) : createNativeOverrideTable(b);
const tl = gl ? createSpriteTimeline(gl, refs, keys)
              : createNativeTimeline(refs, keys);
// after — no gl, no gate:
const ov = scene.createOverrideTable(b);
const tl = scene.createTimeline(refs, keys);
const m  = scene.createMorph(src, dst, { srcSprite, dstSprite });
```

The free functions stay exported for low-level/direct use; these scene
methods are the drop-in path. (They're lazy-loaded with the backend, so
`/fallback` stays gl-free.)

### Bundle size / code splitting

The whole native fallback is gl-free. Two ways to keep the WebGL
pipeline out of a native-only build:

- **`@kontek/mantle/fallback`** subpath — imports `createNativeScene` /
  `createNativeMorph` / `createMantleScene` without statically pulling
  `renderer.js`. Statically reachable source: **~107 KB vs ~1.6 MB** for
  the package root; `renderer.js` (the 200 KB GL pipeline), filterGraph,
  fonts, and the importer are all excluded.
- **`createMantleScene`'s dynamic `import()`** — even from the root, the
  factory only fetches the backend it picks at runtime.

The gl-free heart of the morph (`src/core/morphCore.js`) and meta parsing
(`src/core/metaBin.js`) are shared by both the WebGL morph and the native
morph, so there's one source of truth and the native path reuses it with
zero GL code. (Verified: the `/fallback` import graph reaches no
`renderer.js` / `bundle.js` / `filterGraph` module.)

`scene.toScene(sections)` returns the right drawable for the active
backend (a GL bundle on webgl, the sections themselves on native), so the
draw loop is identical across both.

The native path is selected when **any** of these is set (in order):

| How | Use |
|---|---|
| `opts.backend: 'native'` | hard override (strongest) |
| `opts.forceNative: true` | per-call force |
| `globalThis.__MANTLE_FORCE_NATIVE = true` | set before init (test setup / dev console) |
| `?mantleNative=1` URL param | poke a live page in a browser |
| WebGL2 genuinely unavailable | the real fallback trigger |

Force the **other** way with `opts.backend: 'webgl'` (throws if WebGL2 is
missing) to A/B the same page. `chooseBackend(canvas, opts)` exposes just
the decision (`{ backend, gl }`) if you want to branch your own setup —
e.g. only fetch shaders when WebGL wins.

For low-level testing you can always skip the factory and call
`createNativeScene(host)` directly, which is unconditionally native.

## Why native SVG (not a Canvas2D re-rasterizer)

Mantle's bundle is a one-way GPU encoding: it flattens subpath/contour
structure, bakes transforms, and discards the source `<mask>`/`<filter>`/
`<clipPath>` geometry — so you can't faithfully replay it into Canvas2D
`Path2D`. But the browser already *has* a complete SVG rasterizer. Handing
it the original markup gets masks, filters, clips, gradients, and patterns
for free, re-evaluated every frame as geometry moves. The cost is keeping
the source string (opt-in `retainSource`); regular WebGL consumers pay
nothing.

## One `<svg>`, not N overlaid

The WebGL renderer composites bundles by **painter's algorithm** — each
`drawBundle` paints over the previous in call order, with no cross-bundle
pixel interaction. That's exactly SVG's document-order paint model, so the
whole scene maps to sibling `<g transform="matrix(…)">` nodes inside **one**
`<svg>`. Z-order = sibling order = call order. (`worldMatrix` is a
column-major mat3 in em space; it drops into `matrix(m00,m10,m01,m11,tx,ty)`.)

## Animation support

| Feature | Fallback | How |
|---|---|---|
| Per-shape override: move / scale / rotate | ✓ | element `transform` |
| Per-shape override: visibility | ✓ | `opacity` / `display:none` |
| Per-shape override: recolor (fill/stroke/width) | ✓ | paint attributes |
| Animated clip transform (`setClipper`) | ✓ | transform on the `<clipPath>` |
| Masks / filters on animated shapes | ✓ | browser re-evaluates the source `<mask>`/`<filter>` per frame |
| **Geometry morph** (shape / sprite / timeline) | ✓ | `createNativeMorph` / `createNativeTimeline` rewrite each shape's `d` per frame |
| Raster `<image>` (data: URI) in a bundle | ✓ | re-hosted verbatim; browser decodes natively |
| Raster `<image>` (relative / remote href) | ✓ | atlas-inlined to a data URI (or absolutized via `baseUrl`) |
| **Raster blit** (`drawImage`) compositing | ✓ | `scene.drawImage(source, opts)` — the native analogue of the WebGL blit |
| Filter-*parameter* tweening (blur σ over time) | n/a | not a Mantle feature in either path |
| Bit-exact match to Slug coverage | ✗ | the browser's rasterizer differs sub-pixel |

Overrides are driven through a CPU override table with the same surface as
the GL one:

```js
import { createNativeOverrideTable } from '@kontek/mantle';
const table = createNativeOverrideTable(sections);
table.set('hat', { localPosition: [10, 0], fill: [1, 0, 0, 1] });
table.setClipper('reveal', { localPosition: [dx, 0] });
scene.drawBundle(sections, { overrides: table });
```

### Geometry morphs

`createNativeMorph` / `createNativeTimeline` reuse the engine's own
(pure-CPU) morph plan + curve lerp — the *only* thing they do differently
from `createShapeMorph` is decode the lerped curve buffer into an SVG `d`
string (`curveRangeToPathD`) instead of uploading it to a texture. The
scene rewrites each matched shape's `<path d="…">` per frame; primitives
(`<rect>`/`<circle>/…`) are auto-promoted to `<path>` the first time a
morph touches them.

```js
import { createNativeMorph } from '@kontek/mantle';
const morph = createNativeMorph(sheet, sheet, { srcSprite: 'idle', dstSprite: 'run' });
scene.drawBundle(morph.bundle, { overrides: morph.overrides });
morph.setT(t);                 // 0 = idle, 1 = run, between = tweened geometry
```

**Limit (shared with the WebGL morph):** only matched-topology shapes
(same id / position, same curve length) tween geometrically; the rest
crossfade by visibility. `dst-only` shapes have no element in the source
markup, so they can't be drawn — they're listed in
`morph.unrenderableDstOnly`.

## Raster compositing

Two kinds of raster content, both handled:

**Raster `<image>` inside a bundle** — survives verbatim in the source
string. `data:` URIs decode natively. For relative/remote hrefs (which
the browser would otherwise resolve against the *page* URL, or taint
cross-origin), the fallback **inlines them to data URIs from the bundle's
decoded image atlas** (`imageAtlas` / `imageAtlasRects`) — the exact
bytes the WebGL path used, cross-origin-safe. Disable with
`drawBundle(b, { inlineFromAtlas: false })`, or absolutize instead via
`{ baseUrl }`.

**Standalone raster blit** — `scene.drawImage(source, opts)` is the
native analogue of `renderer.drawImage`, so you can composite a raw
raster *alongside* SVG bundles in the same scene (call order = z-order,
same as WebGL):

```js
scene.beginFrame([0,0,0,0]);
scene.drawBundle(scene.toScene(sections), { worldMatrix });
scene.drawImage(pixelsOrUrl, { dstRect: [x, y, w, h], alpha, blendMode });
scene.endFrame();
```

`source` is the same set the WebGL `createImage` accepts — `{width,
height, rgba}` pixels, an `<img>`/`<canvas>`/`ImageBitmap`/`ImageData`,
or a data/remote URL string. `opts`: `dstRect` (canvas px, default =
natural size at origin), `srcRect` (sub-image), `worldMatrix`, `alpha`,
`tint` (RGB → feColorMatrix, alpha → opacity), `colorMatrix` /
`colorMatrixOffset` (per-draw recolor → a second feColorMatrix chained
ahead of the tint's, matching the GL shader's order), `blendMode` (→ CSS
`mix-blend-mode`). Rasters live in a nested `<svg viewBox="0 0 vpW vpH">`
so they place in viewport-pixel space, independent of any bundle's
em/bbox viewBox — matching the WebGL blit's pixel-space semantics.

Both `drawBundle` and `drawImage` are on `createMantleScene`'s returned
scene too, so raster compositing is backend-agnostic.

## What's lost

The single unavoidable caveat is **rasterization fidelity**: output is the
browser's SVG rasterizer, not Mantle's Slug coverage — visually
equivalent, not bit-identical. Everything the animation system actually
drives (transforms, visibility, recolor, clip motion, geometry morphs) is
reproduced; the browser handles masks/filters/clips natively.

## Tests

`test/nativeFallbackSmoke.mjs` (puppeteer, **no WebGL context created**):
source retention opt-in, single-`<svg>` composition, native rasterization
(pixel check), per-shape override by id, `setClipper` on the live clip
element, `curveRangeToPathD` round-trip, and a geometry morph that
rasterizes sliding pose A → pose B (centroid 49 → 249, midpoint 149).
