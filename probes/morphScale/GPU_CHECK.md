# GPU check for morph scale-correctness

## What is checked

Two families of tolerance on the MORPH paths, neither of which the stage probe can see because
`probes/_zzScaleWide.mjs` does not run morphs. The probes compare this tree against a BASE tree
whose morph bars are absolute: run each probe in both trees and diff the digests.

**The Loop-Blinn morph pair** (`src/renderer/lbPartitionPair.js`). Its bails compare a length, an
area or a coordinate against a bar relative to the pose. The one that matters is the fan triangle's
barycentric divisor: `den` is twice a triangle area, so it is an S² quantity, and an absolute
`|den| < 1e-18` decides nothing on a 100-unit drawing and declines every triangle on a drawing 2^-8
of that. A declined pair is not a wrong pixel — it is the whole morph falling to Slug.

**The CPatch morph plan** (`cpatchMorphBuild.js`, `cpatch.worker.js`, `cpatchMorphCert.js`,
`cpatchWorkerPool.js`). Every hop carries `defaultTolPx`'s extent-scaled bar rather than a flat
`tolPx: 0.05`. The bar reaches the two certificates, `validatePatch` on every sampled pose and the
source decomposition's leak margin, so it sets the standard for the whole plan.

## What the CPU says, and therefore what to expect

**Loop-Blinn moves nothing at scale 1.** `probes/morphScale/_scale1.mjs` digests every pair in the
corpus — route taken, both packed meshes' vertex counts, kind masks and an exact checksum over every
packed float — and the two trees diff to **zero lines over 500 pairs** (38 asset pose-pairs from
`examples/smoke`, 8 synthetic pairs, 4 mixed-size pairs, and every shape of `tiger.svg` paired with
an affine of itself, in a grow and a shrink family). Every relative bar is measured against the
distribution of the quantity it guards (`_barCensus.mjs`): the fan triangles' conditioning sines
bottom out at 2^-51 against a bar of 2^-52, the chord/control-mid sines at 2^-17, and the dst-side
lengths at 2^-11 of the pose's extent against a bar of 2^-24. **Nothing in the corpus is within ten
binary orders of magnitude of any bar.**

**The stage probe goes to zero.** `probes/morphScale/_run.mjs` over 274 pairs, one exponent per
process, all five stages (`lbPair`, `lbPairPlain`, `lbSeg`, `cpSplit`, `cpCert`):

```
                    2^-20  2^-16  2^-12   2^-8    2^8   2^12   2^16   2^20
  base (absolute bars)
    lbPair            22     21     21     17      0      0      0      0
    lbPairPlain       22     21     21     17      0      0      0      0
    lbSeg              0      0      0      4      0      0      0      0
    cpSplit            6      0      0      0      0      0      0      0
    cpCert             5      0      0      0      0      0      0      0
  this tree           0      0      0      0      0      0      0      0   (every stage)
```

So the check is not "did the picture change at scale 1". It is "does the picture stop depending on
the size the artwork was authored at".

**CPatch's scale-1 survey is unchanged too, on everything the CPU can reach without a worker.**
`_scale1cp.mjs` digests the same 274 pairs — the inflection split and its cut parameters, the
converted patch count, the layout's shape, and both certificates' verdicts — and the two trees diff
to zero lines. The bar swings by 5x on 124-unit artwork and none of those verdicts moves at scale 1;
the divergences it causes are at 2^-20 (`cpSplit` 6, `cpCert` 5), not at 1. What the survey cannot
reach is the WORKER's `convertContour(pose, { tolPx })`, which is where the bar is actually pinned —
`_morphCov.mjs` scores that directly, with the AA reference (P5 below).

## The artwork

`node probes/morphScale/_mkAssets.mjs` writes `probes/morphScale/assets/`. The blob pairs are
generated outlines. The tiger pairs are extracted from a local tiger SVG and are not committed. Each
pair ships as SRC and DST SVGs, the same outline authored at several sizes with the viewBox scaled
to match, so the renderer's fit maps every size onto the same pixels. **The coordinates are scaled,
not a wrapping `<g transform="scale(S)">`** — the importer flattens that transform, and both files
would then carry identical authored numbers and the check would test nothing.

| pair                              | what it is                                                                                                                                                                                                                                 | sizes                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `blobCubic`                       | a 6-sided bowed CUBIC blob that grows and rotates (phase 2.0 — the fan-triangle case of `test/morphScaleEquivarianceSmoke.mjs`, which the base declines from 2^-8 down; phase 0 builds at every size on both trees and would test nothing) | `u1`, `u256` (2^-8), `u65536` (2^-16) |
| `blobMixed`                       | the same outline, with the destination pose 1/16 of the source                                                                                                                                                                             | `u1`, `u256`                          |
| `tiger64`, `tiger160`, `tiger184` | three outlines from a local tiger SVG, morphed to a 1.1x rotation of themselves — the shapes `_pairWhy.mjs` names as declining at 2^-20. Generated locally; not committed                                                                  | `u1`, `u256`, `u65536`                |

`_pairWhy.mjs` (`STEP=2 ROWS=200`) prints the full list of pairs and the exponent each one starts
declining at, if a different shape is wanted. Over 274 corpus pairs the base declines 17 at 2^-8, 21
at 2^-12, 21 at 2^-16 and 22 at 2^-20; this tree declines 0 at all four.

## How to render

```js
const morph = createShapeMorph(
  gl,
  createBundle(gl, await importSvg(SRC)),
  createBundle(gl, await importSvg(DST)),
);
renderer.setLoopBlinnFill('on'); // and setFillEngine({ route: 'lb' }) if that is the pin in use
const frame = (t) => {
  morph.setT(t);
  r.setViewport(S, S);
  r.beginFrame([0, 0, 0, 1]);
  r.drawBundle(morph, {});
  r.endFrame();
};
frame(0);
await r.awaitLbReady(morph, 20000);
for (const t of [0, 0.25, 0.5, 0.75, 1]) frame(t);
```

Poses **t = 0, 0.25, 0.5, 0.75, 1**. t = 0 and t = 1 are the static endpoints and should be
identical between arms whatever happens; the interior poses are where a route change shows.

**GATE THE VERDICT ON THE DRAW TALLY.** A declined pair falls to Slug silently and a Slug frame is a
correct frame, so an arm that drew Slug will look like a clean pass. Record
`renderer.debugStats.engines.draws.lb` and the morph's own route (`morph._morphMeshes[i].mode` is
`'partitionPair'` for the analytic route) at every size, in every arm. A check that does not report
these numbers has not tested anything.

Also run an **A/A** (the same arm twice) before believing any pixel count.

## Predictions

**P1 — at `u1`, base and this tree are byte-identical on every pair and every pose. 0 px, ink
XOR 0.** This is the strongest claim and the one the CPU survey makes directly: 500 pairs, every
packed float checksum equal. If a single pixel moves on any `u1` asset at any t, `_scale1.mjs` is
wrong and the Loop-Blinn bars must be re-examined before anything else.

**P2 — on this tree, `u256` renders the same frame as `u1`.** Same LB draw tally, same
`partitionPair` route, ink XOR 0, and pixel differences only at the level of an A/A (the two renders
go through the same float32 curve plane at different magnitudes, so a handful of AA-edge pixels may
differ by 1-2/255; anything beyond an A/A's own spread is a finding).

**P3 — on the BASE, `u256` does NOT render the same frame as `u1`.** The pair declines, the morph
falls to the t-segmented pair or to Slug, and `draws.lb` drops for those shapes. The ROUTE change is
the precise part of this prediction and the part to gate on: `_pairWhy.mjs` says the base declines
`blobCubic` (phase 2.0) from 2^-8 down and tiger #64 / #160 / #184 at 2^-20, so their
`_morphMeshes[i].mode` should stop being `'partitionPair'` at those sizes and not at `u1`.

**The pixel COUNT in P3 is the weak part and is not modeled.** Nothing on the CPU side here scores
an LB morph against a Slug morph — `_scale1.mjs` scores the pair BUILD, not the draw — so the honest
statement is a shape: the two engines agree on the static endpoints and differ through the interior
poses, mostly in the AA band, so expect t = 0 and t = 1 close and t = 0.25 / 0.5 / 0.75 to differ on
the order of the outline's length in pixels (a few hundred at 512 px), not zero and not a fill-sized
number. If it comes back zero the case is not user-visible; if it comes back fill-sized, something
other than AA moved and that is worth chasing.

**P4 — `blobCubic_u1` on the base already builds the pair.** If it does not — if the base declines
at `u1` too — the case is mis-chosen and P3 is untestable on it; fall back to `tiger64`, whose CPU
tracer decline is at 2^-8 and below.

**P5 — CPatch**: pin `cpatchFill` and repeat. Here the scale-1 output IS expected to move, because
the derived bar is about 5x tighter than the flat 0.05 on 100-unit artwork (0.02 × 124/256 ≈
0.0097). `_morphCov.mjs` scores the morph's own conversion at t = 0, 0.5, 1 against the exact
box-filter reference, both bars, one cached reference per pose (`STEP=16 SLICES=16 CANVAS=192`, 216
poses):

```
  summed |model - exact|   859.46 -> 825.91 px^2   (-33.54, -3.9%)
    UNDER (ink the shape has and the engine does not)   198.45 -> 159.16  (-19.8%)
    OVER  (ink the engine has and the shape does not)   661.00 -> 666.75  (+0.87%)
  patches 2240 -> 2306 (+2.9%)     40 poses better, 21 worse, 155 identical
  best   tiger #144  10.69 -> 4.66 px^2 (1 patch -> 2)
  worst  tiger #32    7.35 -> 11.06 px^2 (12 patches -> 14)
```

So: net better, and the improvement is almost all in UNDER-coverage — the tighter bar stops the
decomposition falling short inside the shape, which is exactly what `cpatchBuild.js`'s own table
measures for the static path (more patches, fewer uncovered interior samples). Expect on the GPU a
small net improvement against Slug and AAC, patch seams moving, and **no shape losing ink**; the 21
poses that score worse gain OVER-coverage at new seams, which is the priced cost.

Read the delta and not the total — the reference's y quadrature wobbles the total by about 1%, and
both arms are scored against the same cached reference so it cancels.

### The falsifiable claim

> On this tree, the same morph authored at `u1`, `u256` and `u65536` draws through the same engine
> with the same draw tally and the same route at every pose, and the frames differ only at A/A
> level. On the base they do not.

If the base already matches across sizes on this artwork, the Loop-Blinn bars are not user-visible
here and the corpus evidence (81 of 81 scale-induced declines through one bail in
`lbPartitionPair.js`) does not transfer to the screen — which would mean the declines land only on
shapes whose Slug fallback is pixel-equivalent, and the relative bars are a route/perf matter rather
than a correctness one. That is a real result and should be recorded as such.

If this tree differs from the base at `u1` by more than an A/A, the scale-1 survey is wrong.

## What these models cannot see

`_scale1.mjs` scores the pair BUILD, not the draw: it cannot see the vertex shader's lerp, the
kernels, or the composite. `_scale1cp.mjs` scores the plan and the certificates, not the packed
texels. Neither runs a morph through the worker pool (there is no `Worker` in node), so the CPatch
plan measured here is the one `planMorph` produces in-process — the same function the worker calls,
with the same options, but not the same scheduling. Use them for direction and for route changes,
not for pixel counts.
