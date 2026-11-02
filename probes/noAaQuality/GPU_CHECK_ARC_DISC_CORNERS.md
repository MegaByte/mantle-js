# GPU check — band-hard arcs, small-circle arc coverage, GWN corners and AAC reach

Three kernel rules (band-hard's arc crossing window, the Loop-Blinn disc branch's `arcCov`, and
GWN's two-edge corner combine) are hard to see in a render. All three branches are reachable from
ordinary content, every harness below feeds the kernel real encoder output, and each one's
visibility on a GPU follows from a statement the CPU can make exactly. What follows is a set of runs
with PREDICTIONS from those statements — each with a falsifier that would put the CPU work back in
question — plus three AAC questions.

Every number below comes from a registered node smoke. Run the smokes first
(`node scripts/runSmokes.mjs`); a GPU run that contradicts one is the interesting outcome.

---

## 1. Band-hard arc crossings — reachable, given open canvas

    SVG=examples/smoke/noAaArcRow__GAP.svg N=512 ARMS=bandhard,slug node probes/_zzEnginePaint.mjs

`noAaArcRow__FAR.svg` scores 0 wrong solid under both the shipped window and an em-space one,
because its shapes are closed ellipses whose two arcs share both endpoints: a miscounted crossing's
run ends at the same shape's other side a few pixels later, and all 29 wrong pixels of the em-space
window lie within 0.71 em of the outline — under a 1.5 em opaque stroke half-width. The stroke that
legalizes band-hard paints the whole defect over. (`test/noAaArcRenderReachSmoke.mjs`, part (a).)

`noAaArcRow__GAP.svg` gives the flipped run open canvas. Nothing is pinned: `noAaFill` is set, the
arc bit is in `segTypeMask`, mean segments per shape is 13.5 against band-hard's ceiling of 64, and
the stroke is 4.27 device px at 512 against `preferNoAa`'s 2 px floor.

**Predict.** With the shipped kernel, 0 wrong solid outside the stroke (the CPU leaves 6 wrong
pixels total, none more than 0.5 px from the outline, all under the stroke). With `hardCrossArc`'s
window made an em-space width (`1e-5 * (|cy| + rx + ry)`), **4,528 wrong pixel centers at 512 in
runs up to 461 px, 4,327 of them outside the stroke** — a defect nobody could miss.

**Falsifier.** The shipped kernel showing any run of 2 or more; or the em-space-window kernel
showing nothing, which would mean the em-space window does not reach the raster the way the CPU
says.

**The reachability condition:** an em-space window is a width in em, so it spans a pixel row only
when `1e-5 * (|cy| + rx + ry) >= extent / N` — a distance from the origin of about `1e5 / N` times
the drawing's own extent (555x at N = 512 on GAP). The importer keeps document coordinates, so art
authored in a large coordinate space meets it.

---

## 2. `arcCov` on small circles — always reached; visible only at small radius

    SVG=examples/smoke/lbArcCovSmall__SVG.svg N=512 ARMS=auto node probes/_zzEnginePaint.mjs

There is no separate primitive-SDF shader: a recognized circle IS a Loop-Blinn kind-7 vertex
(shapeRecognize -> `mesh.circles` -> lbPack's `disc`, aC3.w = -1) and `_lbCoverage.glsl`'s DISC
branch calls `arcCov` for every `cHalf >= -1.5`. `lbCircleSdf__SVG.svg` packs six of them. The `sdf`
in the draw tally is the name for that same vertex. (`test/lbArcCovReachSmoke.mjs`.)

Whether it shows depends on the radius. Worst edge pixel, shipped kernel against `curveCov`:

| r (device px) | worst pixel  |
| ------------- | ------------ |
| 3             | 2.80/255     |
| 6             | 2.17/255     |
| 12            | 0.61/255     |
| 128           | **0.09/255** |

`lbCircleSdf` is radius 40 in a 160 em viewBox: **128 device px at 512**. A tenth of a quantization
step is byte-identical on any GPU, so that asset cannot tell the two apart.

**Predict.** On `lbArcCovSmall__SVG.svg` (49 recognized circles at 3.10–12.39 device px at 512, all
disc mode), a diff between the shipped `arcCov` and `kPx / 24.0` in its place is NOT byte-identical:
it concentrates on the r = 3 and r = 4 rows, worst pixel about 3/255, and nothing moves in any
interior.

**Falsifier.** A byte-identical diff; or any movement on art with no recognized primitive (the
ellipse branch and every Loop-Blinn curve band call `curveCov`, so those must be identical).

---

## 3. GWN's two-edge corner combine — a per-shape count is not a frame count

Nothing to run here. The harness's 23 -> 1 is a PER-SHAPE count: a pixel whose coverage disagrees
with that shape's exact fill, at a pixel flat in THAT SHAPE'S window. A render composites 226 fills
and compares the frame.

Measured with the same kernels, the same encoder output and the same 512 px grid
(`test/gwnCornerCompositeSmoke.mjs`):

- the shape subset is not the gap — over all 226 shapes the per-shape metric is 23 -> 1;
- **18 of the 23 are painted over by a later shape** and never reach the frame;
- scored the way a render scores it (composited alpha, flat pixels of the composited reference) the
  rule takes **5 to 0** — which is the GPU's improvement of six pixels, 30 -> 24;
- with the rule on, 47 flat composited pixels are off by more than a quarter coverage. That is what
  the remaining 24 is, and the two-edge combine does not address it.

**The rule this leaves:** a per-shape kernel count is not a frame count, and a kernel rule's frame
effect is bounded by how much of what it changes is still visible.

---

## 4. AAC cover-quad reach — the dilation exists; the question is a ROTATED quad

    # quality
    SVG=<a glyph span or any asset with italic/diagonal shapes> N=16,64 ARMS=aac node probes/_zzEnginePaint.mjs
    # ...with renderer.setCoverAaReach(true) on the second arm
    # cost
    REPEAT=16 FRAMES=8 SVG=<a cover-quad-heavy asset> N=512 ARMS=aac,aac node probes/_zzEnginePaint.mjs

A quad too small for the AA ramp is true of the quad the IMPORTER writes and false of the quad that
is RASTERIZED: `coverQuadDilate` (mantle.vert.glsl) pushes every cover-quad EDGE out by half a
device pixel in the vertex stage, and the unified stream copies the bisector normal that drives it.
Ink whose center falls outside the raw quad: S glyph 3.443%, slab 8.884% at 16 px. Outside the
DILATED quad: 0.071% and 0.000%. (`test/coverQuadAaReachSmoke.mjs`.)

Half a pixel is exactly the box filter's reach on an axis-aligned edge. What is left is the
PCA-fitted OBB, where the reach along the normal runs to 0.7071 px. `setCoverAaReach(true)` (uniform
`uCoverAaReach`, not a define, so the A/B is one program) scales the push by the unit box's support
in the edge's own direction.

**Predict, quality.** With the flag OFF the frame is byte-identical to the default. With it ON, only
shapes whose cover quad is a rotated OBB move, and they gain the outer sliver of their AA ramp at
their bbox extrema.

**Predict, cost.** Extra rasterized area per quad: **0.0% on every axis-aligned quad** (the factor
is exactly 1 there), +4.37% on an S glyph's OBB and +6.98% on a tilted quad at 16 px, +1.15% /
+1.85% at 64, +0.29% / +0.47% at 256. It is a one-ring cost, so it falls as 1/size.

**Falsifier.** Any movement on a slab, a disc or an axis-aligned glyph; or a frame-time change on
art with no OBB.

---

## 5. AAC cost on clipped art — the A/B, and why it is not "clipped vs unclipped"

    # one feature per arm, each in its own process, an A/A pair FIRST
    REPEAT=16 FRAMES=8 SVG=<arm>.svg N=256 ARMS=slug,aac node probes/_zzEnginePaint.mjs
    # arms: A0 as authored  A1 -clip  A2 -mask  A3 -group opacity  A4 gradients to solid  A5 all off
    # at 256, 512 and 1024; print probes/_aacOverdrawDepth.mjs per arm alongside the times

Three things are settled without a GPU (`test/aacClipConfoundSmoke.mjs`,
`probes/_aacOverdrawDepth.mjs`):

1. **The clip runs the same kernel in both arms.** mantle.frag.glsl samples every clip and mask
   child with `renderFill` at all 11 call sites and never with `renderFillAAC`. A cost both arms pay
   identically pushes their ratio toward 1.
2. **A clip does not change the overdraw at all.** Fragments, mean depth, the tile-serialization
   proxy and the band walk move by exactly 0.0% when the clip is stripped, on the disc stack and on
   both dense assets below. The trap that says otherwise is counting the clip's own carrier rows
   (`bundle.clipperRows`) as cover quads: +31% on the fixture, -22.9% and -48.1% on those assets.
3. **Overdraw does not explain the ratio anyway.** At 256 px tiger has 3.7x the cover fragments,
   2.5x the depth and 1.9x the tile serialization of a dense UI illustration, with a SHORTER band
   walk, and reads 1.83x aac/slug where the illustration reads 4.13x. Per AAC cover fragment the
   excess is 2.1 ns on tiger and 76 ns on the illustration.

And a corpus in which every clipPath cell also carries mask, gradient, paint-server fill and group
opacity cannot identify the clip: `clipPath with no mask/opacity/filter` is ZERO cells and
`mask with no clipPath` is ZERO cells. Its worst cell is 4.13x at 256, and the ratio falls with size
on clipped and unclipped art alike.

**Predict.** A1 barely moves the ratio. A2 and A3 move it a lot: a mask and a group opacity are what
force per-shape draws and RT round trips, and AAC's cost there is per DRAW, not per fragment.

**Falsifier.** A1 collapsing the ratio to A5's, which would mean the clip IS the cause and (1) is
wrong about where its cost lands.

---

## 6. The band discriminator — both branches are negative

Nothing to run. Against the exact fill oracle at 512 and 1024, over every solid-interior pixel
center of every fill shape, Slug, AAC and BAND-HARD all read **0** on the open-subpath twin
(`test/bandDiscriminatorSmoke.mjs`; a prune made one em too eager moves band-hard to 965 and leaves
the other two at 0, so the instrument is live).

So an over-fill there is not band membership, not the break-early prune, not a bounded loop, not the
shared AA tail, and not either coverage kernel: it is the interior-skip occupancy grid, which must
be built from the closed fill segments (`probes/openSubpathFill/README.md`,
`test/openSubpathOccupancySmoke.mjs`).

---

## 7. The AAC points route

The route paints every drawn row as points from one instanced call, so it is a whole-draw choice;
its gate is a point-count budget that grows with the geometry's overlap depth
(`src/renderer/aacPointsDraw.js`), and `aacPointsMaxPx` (off by default) bounds the largest row. Any
per-shape size bound under a worldMatrix rotation must read each shape's own box: `max(width)` and
`max(height)` taken from shapes that need not be the same shape make a synthetic box strictly larger
than any real shape (a 6x1 and a 1x6 read 8.49 px against a true 4.95 at 45 degrees).

`probes/_aacPointsShapeCensus.mjs` prices a mixed draw (points per shape, the rest as cover quads)
under an 8 px per-shape bound, over 382 assets: **0 take the route whole at 512** (0.01% of fill ink
in qualifying shapes of rejected assets), 1 at 128 (0.29%), 6 at 64 (1.34%).
