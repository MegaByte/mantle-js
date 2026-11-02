# GPU check — the no-AA / GWN / AAC / SDF / Slug quality batch

Everything below is settled on the CPU against an exact reference (`rowSpans`, the same fill oracle
every CPatch measurement is scored against) with the SHIPPED shader text run in float32 through
`test/_glslEmu.mjs`. That is not a substitute for a render: it proves the kernel's arithmetic, not
the route that reaches it, the cover quad it is rasterized over, or the compositing after it. This
file says what each GPU run should show if the CPU is right, and what it means if it does not.

Every number here is a PREDICTION. A run that contradicts one is the interesting outcome.

---

## 0. Before any arm is read: prove what it compiled

`probes/_gwnAaCeiling.mjs` and `probes/_gwnSampledAaQuality.mjs` print, per row, the variant each
arm actually DREW (`debugStats.drawnFillVariantKey` — not `fillVariantKey`, which is the unified
route's readiness query and is empty on unstroked art). A run whose arms did not draw what they name
prints **DO NOT READ THE TABLE** instead of a number. An "sdf" arm built as
`createRenderer(gl, shaders, {})` draws Slug or Loop-Blinn, not GWN+SDF;
`test/probeArmKernelSmoke.mjs` guards against that, resolved through the fragment shader's own
selection chain.

---

## 1. Band-hard's arc crossings (needs a render)

    SVG=<an arc-heavy asset far from the origin> N=512 ARMS=bandhard,slug KEEPSTROKES=1 \
      node probes/_zzEnginePaint.mjs

**Claim.** `hardCrossArc` does not synthesize a crossing from a tolerance band. On the CPU, over
eight arc-heavy drawings a thousand em from the origin, a tolerance-band crossing gives 100 wrong
pixel centers at 512 and 374 at 1024, with longest wrong RUNS of 96 and 116; the shipped rule gives
**0 and 8**, with runs of **1 and 1**. A run is the signature: one miscounted crossing flips every
pixel of that row to its left.

**Predict.** On an arc-heavy asset (52% arcs) where a tolerance band gives 8 wrong solid pixels at
512 and 28 at 1024, the band-hard fill gives **0 and 0**, or at most isolated single pixels — never
a run of more than one. If a RUN survives, the remaining miscount is not the endpoint rule and the
next place to look is band membership (`src/svg/textures.js` bins arcs with twice the walkers'
tolerance) and the break-early prune (`_coverage.glsl` `segRaw.y < c.x`).

**Falsifier.** Wrong pixels that do not shrink, or any run ≥ 2 px.

---

## 2. The GWN two-edge combine (needs a render)

    SVG=examples/tiger.svg N=512 ARMS=slug,aac ... plus a GWN arm:
    node probes/_gwnSdfAA.mjs           # arms already pinned; read `arms proved`

**Claim.** Where exactly one of the two coverage half-planes contains the pixel center, the exact
crossing count decides convex-vs-reflex instead of a turn whose sign is the sign of zero.

**Predict, tiger at 512, fill only, against the exact reference:** wrong solid pixels **23 -> 1**
(which is Slug's own count on the same asset), pixels whose AA error exceeds half a coverage **31 ->
8**, mean edge error **0.01248 -> 0.01231** (it FALLS), each turn-sign -> crossing-count. On stars,
combs, rings, petals, a cusp and a loop the rule changes **no pixel at all** — so a GPU diff of the
two rules on those must be byte-identical.

**Falsifier.** Any movement on the corner fixtures, or a tiger wrong-solid count above 2.

---

## 3. The SDF circle's curvature offset (needs a render AND a cost check)

    node probes/_zzEnginePaint.mjs SVG=examples/smoke/lbArcCovSmall__SVG.svg N=512

**Claim.** `arcCov` offsets by the exact moment of the arc over the chord the pixel cuts,
`κ(x1² + x1x2 + x2²)/6`, instead of `κ/24` — which is that moment for a chord of length one centered
on the foot of the perpendicular.

**Predict.** Against an exact disc-in-box reference, mean coverage error on a circle of radius r px:

| r px | κ/24     | exact moment | factor |
| ---- | -------- | ------------ | ------ |
| 3    | 0.001357 | 0.000280     | 4.9x   |
| 6    | 0.000673 | 0.000090     | 7.5x   |
| 12   | 0.000299 | 0.000021     | 14.0x  |
| 24   | 0.000154 | 0.000006     | 25.9x  |
| 48   | 0.000080 | 0.000002     | 39.2x  |
| 96   | 0.000042 | 0.000003     | 14.6x  |

In 8-bit terms the worst single pixel goes from 3.1/255 to 0.5/255 at r = 3. **Only the DISC and
RING branch uses it**; the ellipse branch and every Loop-Blinn curve band call `curveCov`, so a GPU
diff of any non-primitive art must be byte-identical.

**Cost.** `arcCov` adds ~14 flops and two divides over `curveCov`, on the SDF-primitive path only.
Measure it where primitives dominate: a page of recognized circles at 3-12 px.

**Falsifier.** Any movement on art with no recognized primitive, or a measurable frame-time cost on
art that has none.

---

## 4. Slug on a curved edge

The default Slug tail takes a pixel one straight edge crosses exactly (the secant through the two
rays' crossings, clipped at a corner pixel) and bends it by the tangents on curves
(`src/renderer/renderer.js`, the `exactEdgeAa` note). `MANTLE_EXACT_EDGE` is reachable through
`fillDefines` for research only. To compare kernels, pin each arm with `setFillEngine`, not by
forcing `fillDefines` on an auto renderer — a forced define set rides a different route and the
timing is of that route.

A 64-pixel-wide text RUN is glyphs about one pixel each (`aacPointsDraw.js`'s header says so); that
size band is what the AAC point route covers.

---

## 5. "Interior pixel error changes with the background"

**Measured (CPU), and it does not reproduce.** A pixel whose rendered color moves with the ground is
one whose ACCUMULATED ALPHA is below 1, so no ground and no render is needed: composite each
engine's per-shape coverage OVER, in document order, and compare the accumulated alpha to the same
composite of exact coverages. Fill-only tiger at 512, 254,669 interior pixels (the reference's own
alpha agreeing with all eight neighbors):

| arm                                  | interior px with dAlpha > 1/255 | > 8/255 (the probe's own ALPHA_BAD)                                     |
| ------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Slug                                 | 2                               | **0**                                                                   |
| AAC                                  | 15                              | **0**                                                                   |
| GWN+SDF                              | 7                               | 4 (the GWN corner remnant; reference alpha 0 there, i.e. paint outside) |
| exact coverage accumulated in 8 BITS | 0                               | 0                                                                       |

The reference's own interior alpha is 1.0000 everywhere, so the OVER conflation floor
(`1 - covA·covB` at a seam) does not reach an interior pixel on this asset, and 8-bit accumulation
over 226 composites does not either.

**So a GPU count of hundreds of such pixels (437 under Slug, 123 under AAC) cannot come from the
fill coverage.** Re-run `probes/_zzEnginePaint.mjs` on tiger with both grounds and, if the numbers
return, the cause is between the kernel and the framebuffer. In order of suspicion: the occlusion
cull (which produces exactly this signature when it tests occluders under the wrong fill rule, and
lands asynchronously), the cover quad's extent, group/RT round-trips, and the depth claim.

**Falsifier.** If the GPU still shows hundreds and a `hard`-kernel arm shows them too, it is not AA
at all. If a run with the cull disabled shows none, it is the cull.

---

## 6. The cover quad's antialiasing margin

A pixel is rasterized only if its center is inside the cover quad, but a pixel center up to half a
pixel OUTSIDE the path still has real box coverage. `coverQuadDilate`
(`src/shaders/mantle.vert.glsl`) pushes every cover-quad edge out by half a DEVICE pixel in the
vertex stage, which is scale-independent (an em pad at import would be wrong at every other zoom).
What is left on a rotated OBB, and `setCoverAaReach`, is in `GPU_CHECK_ARC_DISC_CORNERS.md`
section 4.

---

## 7. An open filled subpath under Slug and AAC

The over-fill of an open filled subpath (Slug and AAC wrong, Loop-Blinn exact) is not band data and
not either coverage kernel: it is the interior-skip occupancy grid, which must be built from the
closed fill segments. See `probes/openSubpathFill/README.md` and `GPU_CHECK_ARC_DISC_CORNERS.md`
section 6.

---

## 8. AAC cost — the timing to run

Not an accuracy item, so not settled here. AAC's per-fragment kernel is a few hundred operations,
and its blowup is not per-pixel but per-OVERDRAW: `aacPointsDraw.js`'s header records roboto text at
64 px taking ~9 ms against ~0.9 ms at 1024 px with 7.4x FEWER kernel calls, because hundreds of
blended cover quads overlap several deep in a few tiles and a tile GPU serializes those. Clipped art
plausibly reaches the same regime by a different road (a clip forces per-shape work and round trips
instead of one batched stream), which would make an aac/slug ratio of 4.6-5.5x a function of
overdraw depth rather than of the clip. `GPU_CHECK_ARC_DISC_CORNERS.md` section 5 has the
per-feature A/B.

**The timing to run** (separate processes, A/A first — a tie inside one process is quantization):

    # 1. is it overdraw depth, or the clip itself?
    REPEAT=16 FRAMES=8 SVG=<clipped asset> N=512 ARMS=slug,aac node probes/_zzEnginePaint.mjs
    REPEAT=16 FRAMES=8 SVG=<the same asset with clip-path removed> N=512 ARMS=slug,aac node probes/_zzEnginePaint.mjs
    # 2. the same two at 1024: if the ratio FALLS with size it is overdraw, not the kernel
    # 3. an A/A control: the same arm twice in one page, which must tie

Pin each arm with `setFillEngine` and check `debugStats.drawnFillVariantKey`, or the numbers are
about a route rather than a kernel.
