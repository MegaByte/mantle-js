# strokeCurve — the GPU check for the curve branch's butt ends and joins

Eight standalone SVGs, each a 200x200 viewBox at 200x200 CSS pixels, so **one viewBox unit is one
device pixel** and the sum of the rendered alpha channel is directly comparable to the numbers
below. They are written by, and must stay in step with, the one definition in `_strokeCurveInk.mjs`:

```
node probes/strokeCurve/_strokeCurveInk.mjs            # the table
node probes/strokeCurve/_strokeCurveInk.mjs --write    # rewrite the .svg from the same data
```

`svg2` is the exact area of the SVG 2 stroke shape (16x16 supersampling of the exact shape in
`test/_strokeCurveRef.mjs`). `base` is the ink the curve branch lays down with every rule below
reverted, `fixed` what ships; the rest are single-rule reverts and mutations, which say which part
of the rule is doing the work: `buttPastEnd` reverts the butt-end plane (it cuts only pixels PAST a
free end), `miterClipClamp` the past-the-limit joins (miter-clip caps the along-tangent extent, a
miter keeps a round shoulder, an arcs join bevels), `roundBevelDisc` the round / bevel wedge (both
keep the halfW disc outside the wedge), `noLocality` drops the butt-end plane's locality test and
`noArcsCut` the reach cut. The column names are the rule keys in `test/_strokeCurveRef.mjs`. All of
them are the CPU port summing the renderer's own coverage over pixel centers, at one em per pixel.

| case                       | svg2   | base   | **fixed**  | buttPastEnd | miterClipClamp | roundBevelDisc | noLocality | noArcsCut |
| -------------------------- | ------ | ------ | ---------- | ----------- | -------------- | -------------- | ---------- | --------- |
| `a-butt-ramp.svg`          | 2580.2 | 2584.7 | **2580.2** | 2584.7      | 2580.2         | 2580.2         | 2580.2     | 2580.2    |
| `b-fold-back.svg`          | 2306.9 | 2309.2 | **2306.9** | 2309.2      | 2306.9         | 2306.9         | 1096.1     | 2306.9    |
| `c-miter-clip.svg`         | 4816.4 | 4833.0 | **4817.2** | 4821.8      | 4828.4         | 4817.2         | 4817.2     | 4817.2    |
| `d-miter-past-limit.svg`   | 4764.4 | 4814.4 | **4765.2** | 4769.8      | 4809.9         | 4765.2         | 4765.2     | 4765.2    |
| `e-near-reversal-clip.svg` | 1046.4 | 1046.5 | **1046.4** | 1046.5      | 1046.3         | 1046.4         | 1046.4     | 1046.4    |
| `f-arcs-curved.svg`        | 3851.6 | 3854.6 | **3851.9** | 3854.6      | 3851.9         | 3851.9         | 3851.9     | 3851.9    |
| `g-round-short-leg.svg`    | 2285.2 | 2374.2 | **2286.1** | 2288.9      | 2286.1         | 2371.4         | 2286.1     | 2286.1    |
| `h-bevel-short-leg.svg`    | 2271.1 | 2359.9 | **2271.8** | 2274.6      | 2271.8         | 2357.1         | 2271.8     | 2271.8    |

Error against the exact shape, fixed (base): a 0.0 (4.5), b 0.0 (2.3), c 0.8 (16.5), d 0.8 (50.0), e
0.0 (0.2), f 0.2 (2.9), g 0.9 (89.0), h 0.8 (88.8).

## What to pin

1. **Total ink.** Render each file at exactly 200x200 device pixels on an opaque white ground and
   sum `1 - alpha_of_white` (or render the stroke on transparent and sum alpha). The result should
   be the **fixed** column to within a couple of units — the port is float64 and the bundle is
   float32, and the renderer's exact-area antialiasing differs from the port only where two pieces'
   edges cross inside one pixel.
2. **The two that move visibly.**
   - `d-miter-past-limit.svg`: **4814.4 -> 4765.2**, about 49 units, and it is a _shape_ change, not
     a ramp — the round shoulder at the apex becomes a flat bevel. Diff the `base` and `fixed`
     rasters: the difference should be two crescents at the join, one either side of the bevel
     chord, and nothing anywhere else on the path.
   - `c-miter-clip.svg`: **4833.0 -> 4817.2**, about 16 units. The difference should be a thin wedge
     _past_ the clip line (ink that goes away) and a thin wedge _beside_ it (ink that appears), on
     opposite sides of the bisector at 10 units from the vertex. If the only change is a loss and
     there is no gain, the clip is being applied on the tangent, not on the bisector.
   - `g-round-short-leg.svg` and `h-bevel-short-leg.svg` (`roundBevelDisc` -> `fixed`): **2371.4 ->
     2286.1** and **2357.1 -> 2271.8**, about **85 units each**, and the two are the same geometry
     with two different joins, so they must move by the same amount. It is a _shape_ change: the leg
     into the join is 8 units long against a 14 half-width, so without the wedge rule the join
     vertex's halfW disc reaches 6 units past that leg's own butt cap. Diff the two rasters: the
     difference must be one circular segment, bounded by the cap plane `x = 92` on one side and by
     the circle of radius 14 about `(100, 100)` on the other — area
     `14^2*acos(8/14) - 8*sqrt(14^2-8^2) = 96.8` square units before antialiasing — and nothing
     anywhere else on the path. If ink also goes away on the OUTER side of the join, the butt end is
     being applied inside the wedge as well as outside, and the round join has lost its sector.

- `a-butt-ramp.svg`: **2584.7 -> 2580.2**, about 4.5 units, all of it at the two butt ends. Pin the
  ramp itself, not the total: sample the row of pixels straddling each end plane; coverage should
  pass through 0.5 _at_ the plane and reach 1 half a pixel inside. Under `buttPastEnd` it is 1
  already a quarter pixel inside.

3. **That nothing else moves.** `b`, `e` and `f` move by 2.3, 0.1 and 2.7 units respectively; a
   `base`/`fixed` diff on those three should be confined to the butt ends (`b`, `f`) and to the join
   (`f`). Any difference along the middle of a segment means the end-plane term is firing where it
   must not.
4. **The locality test, which the GPU cannot show on its own.** `b-fold-back.svg` is the case the
   test exists for: the curve crosses its own start plane again 29 units to the side of the start
   point. Without the test the end plane would erase the returning arm — `noLocality` 1096.1 against
   2306.9, **less than half the ink**. To see that on the GPU, delete the
   `aOut <= 0.0 && abs(dot(qv, ...)) <= halfW` guard in `_strokeMath.glsl`, rebuild the shaders and
   re-render: `b` should lose its whole returning arm and `a` should not change at all.

## What would falsify the model

- **The rendered total for any case differs from `fixed` by more than ~5 units.** The port and the
  shader are meant to be the same rule; a gap that size is a real disagreement, not float32.
  Localize it by rendering with the `buttPastEnd` / `miterClipClamp` behavior (each is one hunk in
  `_strokeMath.glsl`) and seeing which column the GPU lands on.
- **`d` does not lose ~49 units, or loses them somewhere other than the join.** That would mean the
  bevel branch is not reached — most likely the join is not past its limit in the shader's own
  arithmetic, which would put the defect in `sinHalf` / `miterLen` rather than in the bevel.
- **`c` loses ink without gaining any.** See above: it would mean the cut is still on the tangent.
- **`a` changes anywhere but within half a pixel of the two end planes.** The end-plane term would
  then be escaping its `|lateral| <= halfW` gate.
- **`b` loses more than ~3 units.** The locality test would be failing to protect the fold-back.
- **`g` and `h` do not lose ~85 units, or lose different amounts from each other.** They are one
  path under two joins and the region removed is the same one, so a split between them means the
  butt end is reaching the bevel chord (`h`) or the sector (`g`) rather than standing outside both.
- **`g` or `h` loses much more than 89 units.** `svg2` is 2285.2 and 2271.1; dropping below that is
  the butt end firing INSIDE the join wedge, which is the half-plane the join owns.

## What this probe deliberately does NOT claim

`e-near-reversal-clip.svg` and `f-arcs-curved.svg` are the reach cases, and they are predicted to
move **almost nothing** on the GPU — that is the honest result, not a weak probe. The unbounded
regions the reach cut bounds (an arcs join's band intersection meeting again 2/|kappa| from the
vertex; a clipped miter's kite running backwards from a near-reversal) live in the join _branch_,
and three things already stop them reaching a pixel: a fragment only evaluates that branch when its
closest point on the segment IS the join vertex, and the row's cover quad and the band membership
pad are both sized to `halfW * sqrt(miterLimit^2 + 1)`. So without the cut the excess is a latent
hole in an assumed bound, not a visible artifact, and the cut makes the bound true rather than
repairing a render. The evidence for it is `test/strokeCurveJoinSvgShapeSmoke.mjs` (f), which
measures the branch's own region: 201 half-widths at `kappa * halfW = 0.01` without the cut, within
the bound with it.

It also does not claim SVG 2 fidelity for an arcs join between curved segments. The renderer draws
the intersection of two osculating-circle bands; SVG 2 draws the region bounded by those arcs out to
their closest intersection with each other, and that region can reach 2.6x the bound at
miterLimit 3. That gap is recorded, not closed.
