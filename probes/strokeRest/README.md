# strokeRest — the GPU check for the curve join wedge, the filtered-stroke render target and synthetic bold

Five standalone SVGs, each a 200x200 viewBox at 200x200 CSS pixels, so **one viewBox unit is one
device pixel** and the sum of the rendered alpha channel is directly comparable to the numbers
below. They are written by, and must stay in step with, the one definition in `_strokeRestInk.mjs`:

```
node probes/strokeRest/_strokeRestInk.mjs            # the table
node probes/strokeRest/_strokeRestInk.mjs --write    # rewrite the .svg from the same data
```

`svg2` is the exact area of the SVG 2 stroke shape (16x16 supersampling of the exact shape in
`test/_strokeCurveRef.mjs`). `before` is the ink of the ungated curve rule (`wedgeVertexDrop` in
`test/_strokeCurveRef.mjs`), `fixed` what ships, and `drop` the same wedge taken as a hard drop
instead of the butt-end SDF. All of them are the CPU port summing the renderer's own coverage over
pixel centers, at one em per pixel.

| case                         | svg2   | before | **fixed**  | drop   |
| ---------------------------- | ------ | ------ | ---------- | ------ |
| `g-clip-kite-wedge.svg`      | 6427.4 | 6488.0 | **6427.4** | 6427.4 |
| `h-clip-kite-open.svg`       | 3282.0 | 3352.1 | **3282.4** | 3282.4 |
| `i-miter-wedge.svg`          | 4966.8 | 4997.2 | **4967.0** | 4967.0 |
| `j-short-free-tail.svg`      | 4585.4 | 4585.4 | **4585.4** | 4585.4 |
| `k-filter-rt-miter-clip.svg` | 1993.1 | 1910.1 | **1993.5** | 1993.5 |

Error against the exact shape, fixed (before): g 0.0 (60.6), h 0.4 (70.1), i 0.2 (30.4), j 0.1
(0.1), k 0.4 (83.0).

`k` is the render-target case and its `before` column means something different: the rule does not
change there, the RENDER TARGET does, so `before` is the same ink with everything left of x = 32
dropped — what a target padded too little on the left cuts.

## What the cases are

Outside the wedge between two segments' perpendiculars, SVG 2 gives a segment's end a BUTT end — its
own end plane — and no join shape. `_coverage.glsl`'s LINE branch and the CURVE branch both apply
that butt end at every vertex. The ungated rule (`before`) drops there only where
`src/svg/textures.js` makes that side's neighbor reach finite, which it does only next to a free end
(40% of interior vertex-ends on the seeded corpus). Elsewhere the join branch runs outside the wedge
— and for miter-clip past the limit that branch ASSIGNS the distance, so it paints the clipped kite
running backwards past the incoming segment's own perpendicular.

- `g` and `h` are that kite, at miterlimit 1 where every join is past its limit. `g` is CLOSED, so
  every vertex is interior and the ungated rule never drops anywhere on the path.
- `i` is a plain miter, where the branch only LOWERS the distance, so only the radial halfW disc
  outside the wedge goes — a third of the ink `h` loses.
- `j` guards the free-end drop: a SHORT free-ended tail after a miter join, where the encoder DOES
  write a finite reach and the ungated rule already drops. `before == fixed` there is the point of
  the case.

## The render-target case

`k-filter-rt-miter-clip.svg` carries an **identity filter** — an `feColorMatrix` with the identity
matrix, over a `userSpaceOnUse` region that is the whole canvas, so the filter REGION can never be
what clips. A correct renderer must therefore produce exactly the unfiltered image, and the only
thing between the two is the render target `renderer/filterDraw.js` `_shapeBboxPx` sizes.

The path's join ratio is `1/sin(4.576 deg)` = 12.5, past its limit of 10, so SVG 2 clips it square
to the bisector at `10 * halfW` = 50 units from the vertex at x = 60 and the spike's tip lands at
**x = 10**. A pad of `0.5 * strokeWidth * max(1, min(miterLimit, 4))` = 20 would put the target's
left edge at `even(floor(55 - 20 - 2))` = 32 and cut everything left of it.
`src/bundle/strokeReach.js` gives `halfW * sqrt(10^2 + 1)` = 50.25 and a left edge of
`even(floor(4.75 - 2))` = 2.

The spike points LEFT on purpose. `_bboxToRect` floors a rect's ORIGIN and quantizes its SIZE, so
the box grows DOWN and RIGHT — a shortfall on the right or bottom edge is absorbed by up to 127 px
of quantum, and one on the left or top by nothing but the 2 px `RECT_PAD`.

To pin it: render `k` with the filter and again with `filter="url(#identity)"` removed. **The two
must be byte-identical.** A target that is too small shows as a hard vertical edge at x = 32 with 83
units of ink missing to the left of it. If they differ anywhere else, or by a soft edge, the cause
is not the render target.

## Synthetic bold

Synthetic bold has no SVG form, so it gets a script rather than a file:

```
node probes/strokeRest/_synthBoldInk.mjs
```

(It skips unless `test/font/fixtures/roboto-regular.ttf` is fetched —
`node scripts/fetchTestFixtures.mjs`.) With no bold face to select, `font/textColrEmit.js` paints
the run's color as a 0.04 em STROKE on top of each glyph's fill, through the one
`svg/buildContext.js` `emitShape` every glyph goes through. A row sized from the PATH box — band pad
0, cover-quad pad 0, meta bbox path-tight — leaves the outer half of the synthesized weight with no
fragments wherever the outline touches its own bbox, so `emitShape` pads the row by the stroke's
reach.

The script builds a real run and re-emits each glyph's decoded outline through the shipped
`emitShape` and through a path-tight one, taking the **difference** in rendered ink. (The
antialiasing ramp is the slope tail in DEVICE pixels, not the emulator's own `cov`, which is only
valid at one em per pixel.) The model itself is `test/_synthBoldInkModel.mjs`; the probe prints it.

To pin it: render that run at 96 px per em on an opaque ground, sum `1 - alpha_of_white`, and
compare against the same render from a build whose `emitShape` sizes the row from the path box.
`_synthBoldInkGpu.mjs` does exactly that, through `dstRect` so one em is exactly 96 device pixels
(the default fit would cut the very ink being counted — the bbox accumulator is the PATH box).

**Measured: the render gains 724.0 px at 96 px/em and 3,548.4 at 192** (the model: 746.6 and
3,548.8), on a 0.000 A/A floor, byte-identical across Slug, Loop-Blinn and CPatch, with the ink box
growing outward on the left, right and bottom. Without the stroke's AA reach in the band walk the
gain is 736.2 and 3,601.7 (`_synthBoldInk.mjs`'s `MEASURED` table holds these). The ink bounding box
of each glyph must also grow by 1.92 px on every side (more at a sharp corner, where a miter at
limit 4 reaches 4 * halfW), and the outer edge must carry an antialiasing ramp rather than ending in
a hard cut.

### The model's two terms

A model that asks only "how much stroke coverage does the path-tight COVER QUAD exclude" answers
**1,307.1** at 96 px/em and **4,892.1** at 192 — 43.7% and 26.4% above the render, too wrong to tell
a partly-working padding from a working one. Two terms close the gap, each with the scaling it
predicts:

- **The baked quad is not the quad that rasterizes.** `mantle.vert.glsl`'s `coverQuadDilate` pushes
  every cover-quad edge out by half a **device** pixel before rasterization, so a path-tight row
  already paints a band that naive model counts as excluded. Being a perimeter times a fixed device
  reach, it is **scale-linear**: 310.7 px at 96 px/em and 627.4 at 192, a ratio of 2.02.
- **The excluded region is not disjoint from the fill.** `emitShape` puts the fill and the stroke on
  **one** meta row, and the padded row's band membership reaches the full stroke reach (up to
  `4 * halfW` at a miter) where a path-tight row indexes a bbox with pad 0. So the padded band walk
  reaches pixels a path-tight walk misses, including pixels on the **inner** half of the stroke —
  inside the path, where the fill is already solid and the row's coverage is the union, so the
  render gains nothing there. Being a region fixed in the artwork it is **scale-invariant in em**:
  237.8 px at 96 px/em and 662.7 at 192, a ratio of 2.79, which no device-fixed dilation produces.

The gain per pixel is therefore `max(fill, strokeNew) - max(fill, strokeOld)`, both strokes gated on
the dilated quad. That gives **758.6** at 96 px/em (+3.05%) and **3,601.9** at 192 (+0.01%) against
the renders without the AA reach. `test/synthBoldInkModelSmoke.mjs` holds it there.

What is still approximated, and where the 3.05% at 96 px/em lives: coverage is sampled at the pixel
**center** through the slope ramp rather than integrated, so a pixel holding a corner, a join, or
both edges of a 3.84 px-wide stroke is off by a little. That is a boundary effect, so **the relative
error must shrink with size** — the smoke asserts that too, because a residual that grew would mean
the model is wrong about something other than sampling. The fill's coverage is also taken from one
build, so a sliver of FILL ink the render gains where a path-tight fill is clipped at the path bbox
is not modeled; it is named rather than folded into a fudge factor, and it is why the model
over-predicts at both sizes rather than straddling.

## What to pin

1. **Total ink.** Render each file at exactly 200x200 device pixels on an opaque white ground and
   sum `1 - alpha_of_white` (or render the stroke on transparent and sum alpha). The result should
   be the **fixed** column to within a couple of units — the port is float64 and the bundle is
   float32, and the renderer's exact-area antialiasing differs from the port only where two pieces'
   edges cross inside one pixel.
2. **Where the ink goes.** Diff the `before` and `fixed` rasters of `h`:
   - the difference must be a WEDGE at each interior join, on the far side of the incoming segment's
     perpendicular — ink that goes away, with nothing appearing anywhere;
   - nothing may change along the middle of any segment, at either butt end, or at the outer
     boundary of the join itself. The clip line at `miterLimit * halfW` along the bisector does not
     move; only the part of the kite behind a perpendicular does.
3. **`j` does not move.** Not by a pixel. If it loses ink at the far side of the short tail's cap,
   the butt end is not reproducing the free-end drop and that bulge is back.
4. **Both routes agree.** The four join-wedge files rendered through the split-stroke route
   (`_strokeCoverage.glsl`) must give the same totals as through the main band walk. That is the
   check the GPU can make and the CPU cannot. It holds for these four files because none of them
   uses an ARCS join: that route cannot reach a neighbor's curvature (only one neighbor control
   point per side rides the vertex data, so `curv.z` and `curv.w` stay 0), so an arcs join draws a
   different region there.

## What would falsify the model

- **The rendered total for any case differs from `fixed` by more than ~5 units.** The port and the
  shader are meant to be the same rule; a gap that size is a real disagreement, not float32.
  Localize it by gating the drop in `_strokeMath.glsl` on `startPrevReach < 1e8` (one hunk, four
  sites) and seeing whether the GPU lands on `before`.
- **`h` loses much more or much less than ~70 units, or loses it somewhere other than behind a
  perpendicular.** Losing it at the clip line instead would mean the wedge test is firing on the
  bisector rather than on the neighbor's tangent.
- **Anything APPEARS.** The butt end can only raise a distance, so the wedge can only remove ink. A
  pixel that gains coverage means the wedge test has the wrong sense and is taking the butt-end
  branch where the join should run.
- **`j` moves at all.**
- **`k` with the filter differs from `k` without it, anywhere, by anything.**
- **`k`'s difference is at a soft edge, or somewhere other than a vertical line.** Then the render
  target is not what is clipping and the case is measuring something else.
- **`k` is the whole-canvas RT.** If `renderer.mantleDebugFlag('noFilterBbox')` is on, or the bundle
  is nine-sliced, `_shapeBboxPx` returns null and every filter runs canvas-sized -- the case then
  passes for the wrong reason. Check the RT size before believing it.
- **The two routes disagree on any case.** Then one of the four sites was missed.
- **The bold run gains ink somewhere other than the outer boundary of a glyph.** The padding only
  adds fragments outside the path-tight cover quad, which is the path's own bbox, so nothing inside
  a glyph can move.
- **The bold run's ink is cut at the CANVAS edge instead.** A text bundle's globalBBox is the PATH
  box (recorded in `emitShape`; widening it would move every synthetically bolded run), so a
  renderer that fits the content box will clip the added half-width there. That is a different
  defect, and seeing it here does not falsify this one.

## What this probe deliberately does NOT claim

It does not claim the curve branch matches SVG 2 everywhere. It claims it does not paint OUTSIDE the
shape at a join: over 433 seeded quad chains and 1.69M pixel centers, miter goes from 42 centers
painted outside under the ungated rule to 0 and miter-clip from 139 to 0. What is left is an
UNDER-paint of the curve branch — 263 and 103 centers on the same sweep, and on straight segments
(where the line rule is exact) 580, 864 and 899 for miter, miter-clip and arcs; the wedge test
removes 9, 86 and 7 of those. `test/strokeCurveWedgeSmoke.mjs` measures both directions; the
residual is recorded, not closed.

It also does not claim anything about `arcs` between CURVED segments, whose region is a known gap
against SVG 2's own construction.
