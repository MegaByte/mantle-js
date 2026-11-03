# GPU check — two absolute floors in GWN and the square-bbox gate

## What is checked

**`gwnCross`** (`src/shaders/_coverage.glsl`) decides a `+x`-ray crossing from the signs of `t` and
`dy`, not from `t * dy > 0.0`. `t` is a cross product (em²) and `dy` a length (em), so the product
is em³ and leaves float32's NORMAL range at an em scale of about `(2^-126)^(1/3) ≈ 2.3e-13`. A GPU
flushes a denormal result to zero, so past that scale the test reads `0.0 > 0.0` and the crossing is
**not counted**. That is not a soft edge: a contour's winding is wrong, so a filled region vanishes
or inverts. Only the two SIGNS are wanted, and `dy` is never zero there (the straddle test above
returns for `a.y == b.y`), so the sign comparison is bit-identical wherever the product survives and
correct where it does not. It is also one instruction cheaper — two compares and a select against a
multiply, a compare and a `sign()`.

**`squareBB`** (`src/shaders/mantle.frag.glsl`, and its hit-test twin `src/hitTest/fillCoverage.js`
`pointInPrim`) gates the circle and annulus closed-form fast paths on the baked bbox being square,
and read `abs(w - h) <= 1e-3 * max(w, 1e-6)`. The `1e-6` is an absolute em length inside a test that
is otherwise a pure ratio, so below that extent the bar IS the shape and every ellipse reads square:
a non-uniformly scaled circle takes the circle fast path and is drawn as a circle. The gate compares
against `max(w, h)`, where both sides scale by exactly S, so the decision cannot move with size.

## What the CPU says, and therefore what to expect

Through the float32 emulation of the shipped `src/shaders/generated/mantle.frag.glsl`
(`test/_glslEmu.mjs`), five shapes covering piece types 0, 1, 4, 5 and 6, 37,868 pixel centers, data
scaled exactly by a power of two (`scaleFillData`), GWN early exits compiled out:

```
                          2^-40   2^-44   2^-48   2^-52   2^-56   2^-60
  sign form (shipped)
    winding                   0       -       0       -       0       0
    SDF                       0       -       0       -       0       0
  t*dy, C++ denormals
    winding                   0       0       0     371   15325   14778
    SDF                       0       0       0     390   15323   14774
  t*dy, denormals FLUSHED (the GPU)
    winding                   0     371   15325   14778   14778   14778
    SDF                       0     390   15323   14774   14774   14774
```

15,325 of 37,868 sampled pixel centers is not an edge effect — it is whole shapes reading
inside-out. C++ keeps denormals and a GPU does not, so the hardware reading is the third block:
**the defect starts at 2^-44 and destroys the drawing by 2^-48.** The sign form holds to 2^-60; the
12 SDF pixels that move at 2^-62 are the SQUARES in `gwnChordT` reaching their own float32 floor,
which is the floor this file already documents as the kernel's (`gwnSegEval`'s header: "squares
underflow near 1e-19 em").

For `squareBB`, the shipped line evaluated over a unit box scaled by 2^-30..2^30, per aspect (1 =
the bar calls it square):

```
                        2^-30 -24 -20 -12  -6   0   6  12  20  24  30
  max(w,h)  circle          1   1   1   1   1   1   1   1   1   1   1
            0.2% off        0   0   0   0   0   0   0   0   0   0   0
            2:1             0   0   0   0   0   0   0   0   0   0   0
  max(w,1e-6)  circle       1   1   1   1   1   1   1   1   1   1   1
            0.2% off        1   1   0   0   0   0   0   0   0   0   0
            2:1             1   0   0   0   0   0   0   0   0   0   0
```

**Under `max(w, 1e-6)` a 2:1 ellipse at an extent of 2^-30 em is drawn as a circle.**

## Scale-1 survey

- `gwnCross`: **0 of 37,868 pixels** differ between the sign form and the product form at scale 1,
  in both the winding-only and the GWN+SDF configurations (`probes/scaleRest/_gwnFloorSurvey.mjs`).
- `squareBB`: over the 357-SVG corpus (`examples/` + `examples/smoke/`), 1,273 fill shapes —
  smallest baked bbox side **5.0e-2 em**, so the 1e-6 floor never binds; **0 of 1,273 verdicts
  differ**, including all 70 circle/annulus-tagged shapes and all 353 shapes taller than wide.

So **no GPU pixel should move on any corpus asset at any ordinary size.** That is the first
prediction and it is the easy one.

## The falsifiable claim

Render `examples/smoke/_arcs_circle.svg` (or any asset with a `primKind == 1` circle) **twice**,
once with the drawing's own transform and once with an added `scale(2^-30)` and the viewport fitted
so the rendered size is identical, with a non-uniform `scale(1, 2)` applied to the circle in both
arms.

- **Predicted, under `max(w, 1e-6)`:** the two arms differ. The 2^-30 arm takes the circle fast path
  on a shape whose baked bbox is an ellipse and draws a CIRCLE — a visibly different silhouette, not
  an edge shift.
- **Predicted, under `max(w, h)`:** the two arms are ink-identical (XOR 0), because the gate does
  not read the size.
- **Falsified if:** the two arms differ under `max(w, h)`, or any corpus asset moves a pixel at
  ordinary size (the survey says 0).

For `gwnCross`, pin the GWN route (`setFillEngine`, and check the draw tally so a fallback to Slug
is not read as a triumph) on a drawing whose transform is `scale(2^-44)` with the viewport fitted
back:

- **Predicted, with `t * dy > 0.0`:** a few hundred pixels of wrong winding at 2^-44, and roughly
  40% of the shape's own pixels wrong at 2^-48 — filled regions inverted, not softened.
- **Predicted, with the sign form:** ink XOR 0 against the same drawing at scale 1, at 2^-44 and at
  2^-48.
- **Falsified if:** the sign-form arm differs from scale 1 at 2^-48, or if the A/A (same arm twice)
  is not exactly 0 px.

**Caution.** `_zzScaleWide`-style probes memoize per module, so run one exponent per process. And a
broken shader falls back to Slug silently — check the draw tally before believing either arm.
