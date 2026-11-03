# GPU check — the invisible-boundary ink probe's floor

## What it guards

`lbSeg` (the morph's t-segmentation) must give the same segments for a drawing and for the same
drawing authored 2^k smaller with the viewport fitted back. With absolute floors in the static
builder's ink probe it does not: under offset-quantized geometry, 2 of 274 pairs at 2^-20..2^-8
(tiger #112/grow and #114/grow) segment differently.

**It is a real scale dependence, not the offset's own rounding.** `offset-differs` compares OFFSET@1
against OFFSET@2^k, and the probe forms each as `r32((q + 16384) * S)`. Multiplying by a power of
two commutes with float32 rounding, so that is _exactly_ `S * r32(q + 16384)` — the two geometries
are the same numbers to the last bit, one scaled. Any scale-equivariant predicate must therefore
answer identically, and one that does not is an absolute bar. (This is the opposite of
`offset-decisions`, where the translation genuinely destroys bits and the residue is inherent.)

**Localization.** The segmenter's own numbers are all dimensionless — 0.02 flip merge, `SEG_MARGIN`
0.04, `mOut` 1e-3, `MORPH_DRIFT_FRAC` 0.002 of a chord — so the size cannot enter there. It enters
through the ORACLE: the 24-cell scan asks `buildLoopBlinnPartitionPair` per cell and segments where
that answer flips. The scans (`probes/scaleRest/_inkProbeFloorLocalize.mjs`, one exponent per
process), with absolute floors:

```
  tiger#112/grow   offset@1      001001111111111111111110
                   offset@2^-20  111111111111111111111110    cells 0,1,3,4
  tiger#114/grow   offset@1      111111001001111111111111
                   offset@2^-20  111111011111111111111111    cells 7,9,10
```

Tagging every `return null` in the pair builder: **both pairs bail at the same site** in
`lbPartitionPair.js` — the dst piece's normal and chord against `emD9.eps`, the dst pose's own em
unit. Dumping the source partition there shows the split PLANS identical at both scales and
**exactly one record different**: `c0/s4/p3` is INVISIBLE at offset@1 and not at offset@2^-20.

That classification is taken in the STATIC builder, by an ink probe. Gated on absolute em lengths,

```js
  if (nl9 > 1e-12 && chord9 > 1e-12) { ... invisCubic9 = true; }     // cubic branch
  if (nl9 < 1e-9) sign = 1;                                          // quad branch
```

it disagrees with the pair builder's own twin of the same test, which uses the pose's `emD9.eps`.
The piece in question has `nl9` ≈ 2.6e-11 against a span of 64, i.e. 4e-13 of the shape: a
numerically dead sliver the 16384-unit float32 quantization creates. At offset@1 it clears 1e-12 and
the probe runs; one binade of drawing scale later it does not. The plain sweeps never reach it
because no tiger piece is that small without the offset.

**The floor** is the symmetric one: one float32 ulp of the shape's extent, `emEps()`, which is what
the whole Loop-Blinn builder is written against and what the pair side of this very test uses. Below
that bar the two probe points `cm ± (n/nl)·off` are the same packed position, so the two `inkAt`
calls read one point and "both sides are ink" is whatever that point happens to be — the bar is not
a tolerance, it is the resolution of the question.

## What the CPU says

- The 24-cell scans are **identical at 2^0, 2^-20 and 2^-8** for both pairs.
- `probes/morphScale/_run.mjs`, `STAGES=lbSeg OFFSET=1`, one exponent per process, **500 pairs**:
  `offset-differs` **2 with absolute floors, 0 with `emEps()`, at 2^-20, 2^-16, 2^-12 and 2^-8**, in
  every kind bucket (asset 36, mixed 4, self 226, selfMixed 226, synth 8).
- **Scale-1 survey: 1263 of 1263 shapes byte-identical** between the two floors
  (`probes/_lbMeshCensus.mjs --diff`). Not one corpus piece has `nl9` or `chord9` in the window
  between 1e-12 and one float32 ulp of its own extent, so the relative bar refuses nothing the
  absolute one accepts at any authored size: there is no changed shape to explain.
- And the dependence is not confined to the offset case. The per-piece `(sign, invisible)` vector of
  `buildLoopBlinnPartition` over 120 corpus shapes, at 2^-20, 2^-40, 2^-44, 2^-48, 2^8 and 2^20:
  **110 of 120 change under the absolute floors** (first at 2^-44, where an ordinary 100-unit
  cubic's `nl9` crosses 1e-12), and **0 of 120 under `emEps()`**. An absolute bar always has a size
  at which it bites; this one's is just below the sweeps. `test/lbInvisibleBoundaryScaleSmoke.mjs`
  (7 checks, 3 of which fail with absolute floors) pins both that and the two named tiger scans.

## The falsifiable claim

This one is hard to see on a GPU: the corpus survey says **zero pixels should move on any asset at
any ordinary size**, so the GPU's job here is to confirm a null result and to check the morph path
that the survey cannot reach.

1. **Static, any asset, any size: ink XOR 0** between the two floors. The mesh survey is
   byte-identical, so a pixel that moves means the survey is measuring the wrong thing.
2. **The morph, at the two named pairs.** Build `tiger` #112 and #114 morphed to a 1.1x/0.05rad
   rotation of themselves (`probes/morphScale/_morphPairs.mjs` `selfPairs` makes exactly these),
   render at t = 0, 0.25, 0.5, 0.75, 1, and compare the drawing authored at its own size against the
   same drawing authored 2^-20 smaller with the viewport fitted back. **Predicted with `emEps()`:**
   the two arms agree at every t, and the number of t-segments is the same. **Predicted with
   absolute floors:** the segment counts differ, so the two arms draw a different sequence of pair
   meshes and the mid-morph frames diverge. _Falsified if_ the `emEps()` arm still shows a different
   segment count or different mid-morph ink.
3. **Nothing else moves.** Pin LB, check the draw tally (a broken build falls to Slug and reads as a
   triumph), and confirm the tally is unchanged on the whole smoke corpus.
