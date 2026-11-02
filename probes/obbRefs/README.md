# objectBoundingBox reference renders — the GPU check

Three importer rules change what is DRAWN: objectBoundingBox gradients and filter regions under a
transformed carrier, and the silhouette of a clipped shape. Node smokes pin the bundle they produce,
and the bundle is what the shaders read; this is the recipe for putting those bundles in front of a
GPU, and the numbers to hold a render to.

Run

    node probes/obbRefs/_obbRefPredict.mjs

first. For every asset it prints **WANT** (what this tree's bundle says the GPU must draw) and
**WAS** (what a naive document-space rule gives), both derived from the same bundle, so a render can
be _told apart_ rather than looked at. A render that matches WAS means the bundle's rule did not
reach the draw. A render that matches neither means something other than these three rules is in the
way, and the prediction below is wrong rather than merely unmet. `_obbRefGpuCheck.mjs` does the
render and the classification:

    JSON=/tmp/obb.json node probes/obbRefs/_obbRefPredict.mjs
    GPU=1 JSON=/tmp/obb.json node probes/obbRefs/_obbRefGpuCheck.mjs

## Assets

All three are derived from their smokes by `scripts/genSmokeAssets.mjs`, so they cannot go stale:

| asset                                                                 | smoke                                     | case           |
| --------------------------------------------------------------------- | ----------------------------------------- | -------------- |
| `examples/smoke/objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg`     | `test/objectBoundingBoxGradientSmoke.mjs` | gradients      |
| `examples/smoke/filterRegionTransform__FILTER_REGION_DEMO.svg`        | `test/filterRegionTransformSmoke.mjs`     | filter regions |
| `examples/smoke/silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg` | `test/silhouetteClippedExtentSmoke.mjs`   | silhouette     |

Import options: the first two need none beyond `preserveViewport`. The third needs
`{ computeSilhouette: true, outlineWidth: 6, outlineColor: [1, 1, 1, 1] }` — the silhouette is
opt-in, and with no outline color stated it is white, which the demo has no background to show
against. The demo carries **no background rect on purpose**: a full-canvas filled rect is part of
the drawing, so it would swallow the silhouette. Clear to something dark instead.

Render them the way the other render smokes do (`test/_launch.mjs` → `scripts/runRenderSmokes.mjs`),
one draw per asset, and read back the framebuffer. Each case wants a **three-engine run**
(`setFillEngine` pinned to Slug, Loop-Blinn and CPatch in turn, checking the draw tally so a
fallback is not read as a pass): the gradient and filter-region cases both ride shared per-fragment
code, and a variant that does not compile silently falls back.

Map a document point to a pixel through the **content box the harness reports**, not by assuming the
viewBox fills the canvas: `setViewport` + `drawBundle` fit the content bbox. Every number the probe
prints is in document units; pixel counts are quoted at 1 document unit = 1 px and scale with the
square of whatever scale you render at.

---

## objectBoundingBox gradients

Four cells, the same 40 × 20 rect under the same objectBoundingBox ramp (`#101418` at the box's x =
0 to `#f05a28` at x = 1), a hairline white outline on each: plain, `rotate(30)`, `skewX(30)`,
`scale(-1 1)`.

**Pin** the gradient record index each meta row carries (meta float 28) and each record's units flag
(gradient float 2). Cell 0 must stay on record 1 with units 1; cells 1–3 must each be on their own
record with units 0 and a non-diagonal inverse matrix.

**Predicted difference** (from the probe): 2814 of 4305 pixels inside the four rows' boxes differ
from the naive rule by more than 8/255, worst channel delta **218/255** — cell 3, the reflected one,
at (350.5, 70.5): this tree paints `rgb(237, 89, 40)` where the naive rule paints `rgb(19, 21, 24)`.
Cell 0 is **0 of 800**: it must not move at all.

**Claim.** In cells 1–3 the ramp runs along the _rect's_ own long axis — up-and-right at 30°,
sheared with the skew, and right-to-left under the flip.

**Wrong if** all four ramps run left-to-right across the page (the rule did not reach the draw), or
cell 0 moved at all (the exact positive-diagonal test failed, and bundles that need no instancing
have been disturbed).

---

## objectBoundingBox filter regions

Two cells, the same 80 × 24 blurred bar under the same _tight_ region
(`x=0 y=-0.25 width=0.55 height=1.5`), keeping the left 55 % of the bar's own box. Cell 0 is
upright; cell 1 is at `rotate(30)`.

**Pin** `bundle.filterRegions[fid-1]` for each filtered row, and that the two cells get
**different** filter entries (one per group instance).

**Predicted difference** (from the probe): cell 0 is the same under both rules — scissor
`[40, 54, 44, 36]`, the positive-diagonal guard. Cell 1 is `[178, 44.80, 44.71, 91.18]` under the
naive rule and `[175, 54.80, 56.11, 53.18]` in the bundle: **2305 square document units scissored
differently, 77.3 % of the bundle region's area.**

**Claim.** The bar in cell 1 is cut _square to the bar_, at 55 % along the bar's own length, so the
cut edge runs at 30° to the page and the kept fraction of the bar matches cell 0's.

**Wrong if** the cut in cell 1 is vertical on the page, or sits at a different fraction of the bar
than cell 0's.

**Known limit, not a failure.** The renderer clips the filter with a _scissor_, which is
axis-aligned by construction, so what goes into the bundle is the AABB of the spec's turned rect.
Blur surviving in the four corner wedges between the turned rect and its bound is expected: closing
that needs a render target that turns with the element, which is renderer work. The same render
target is what would let the graph run in the element's local space, so a non-uniform carrier scales
the blur with it (filter primitives do not yet follow the world matrix's scale).

---

## The silhouette of a clipped shape

A 220 × 60 plate clipped to a 60-wide band, and a disc that sits inside the plate's y range. Import
with `computeSilhouette`.

**Pin** `bundle.numShapes` (one more than without the option),
`bundle.shapeIds[0] === '__silhouette__'`, and meta row 0's bbox: `[37, 37, 203, 103]` in the
bundle, `[7, 37, 233, 103]` under the naive rule.

**Predicted difference** (from the probe, at 1 unit/px): **2252 outline pixels painted only by the
naive rule, 1476 only by the bundle, 1104 by both.** The naive outline is the whole 220-wide plate's
rectangle; the bundle's is the 60-wide band's rectangle plus a ring around the disc.

**Claim.** The outline hugs the visible band (x 40…100) and the disc, and draws nothing along the
clipped-away plate. The **ring around the disc is the easiest thing to look for**: the naive rule
draws no ring at all, because the disc is inside the plate and the union swallows it.

**Wrong if** an outline runs across the whole 220-wide plate, or if the band or the disc has _no_
outline — that would mean the region came back empty rather than as the clip, which loses ink, the
opposite of the intended direction.

---

## What a pass here does not cover

- The Unity (C#) importer and shaders: they are a separate implementation and are not exercised
  here.
- A shape's **own** objectBoundingBox filter region is stored as fractions and resolved at draw time
  against the meta row's document-space box (`importWalk.js` `resolveFilterRegion`, `filterDraw.js`
  `_filterRegionRectPx`). A rotated _shape_ with its own region is still wrong; only a rotated
  _group_ is handled.
- An objectBoundingBox **stroke** gradient on a positive-diagonal carrier normalizes through the
  stroke row's halfW/miter-padded box, which §7.11 says it must not ("without the stroke").
