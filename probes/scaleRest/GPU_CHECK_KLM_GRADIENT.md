# GPU check — the cubic curve band's klm gradient lane

## The format

Lane 9 of a cubic `CURVE_BAND` vertex (`aC0.z`) carries `(dk, dl)`, the klm gradient along the
ring's push normal. `dk` and `dl` are `d(klm)/d(em position)`, so they scale as **1/S**: the same
drawing authored smaller pushes them up. Two IEEE halves would stop at 65504 and (with a packer that
has no subnormal path) at 6.1e-5, so a half-precision lane fails at both ends.

This is a **vertex-format bound, not a tolerance** — no guard can widen it — so the lane is a
shared-exponent format:

```
  bit 31      sign of dk
  bits 30:23  the shared exponent E, IN THE FLOAT'S OWN EXPONENT FIELD
  bits 22:12  |dk| * 1024 / 2^(E-127),  0..2047
  bits 11:1   |dl| * 1024 / 2^(E-127),  0..2047
  bit 0       sign of dl
```

`E` is `2^floor(log2 max(|dk|,|dl|))` read straight off the float, so the LARGER component lands in
[1024, 2047] and keeps an 11-bit significand — the same relative precision half gave it — while both
components' absolute error is bounded by 2^-11 of the pair's magnitude. That is what the kernel
needs: the pair is multiplied by one 1.5px ring push and added to klm, so its error reaches the edge
as a fraction of a pixel, and half's 2^-11 is already far beyond what the ramp can show. What the
kernel needs is RANGE, and the range is float32's own.

**Cost: zero bytes.** Same 32-bit lane, same stride, same attribute count — against the 8 bytes per
LB vertex that widening the pair to two floats would cost on every kind, not just this one. Shader
cost: decode is one AND, one bitcast, two shifts, two masks and two int-to-floats in the VERTEX
stage, once per extruded ring vertex (15,177 of them across the whole corpus). The morph path
additionally re-encodes, which adds a compare, a divide and two rounds — also per vertex, also in
the vertex stage.

Holding `E` in the float's own exponent field is not cosmetic: a vertex attribute IS a float, and
every pattern this writes is a normal float or a plain zero — never a denormal, an Inf or a NaN.
`packHalf2x16` cannot promise that (with `dl == 0` and `dk != 0` the top sixteen bits are zero and
the slot IS a denormal, which a driver is free to flush on attribute load and take `dk` with it).

## What the CPU says, and therefore what to expect

Corpus: 345 assets, 1263 shapes, **498 shapes carry cubic curve-band rings, 8302 (dk, dl) pairs**.
At scale 1 the magnitudes run 5.643e-6 to 3.779e+1 — a spread of 2^22.7 **at one size**, inside a
format with about 2^40 of range in total.

Components lost (saturated to inf, or flushed to zero), of 16,604:

```
     2^e      half: sat  flush      shared-exponent: sat  flush
     -30          10102      0                        0      0
     -20           1883      0                        0      0
     -15             36      0                        0      0
     -11              3      0                        0      0
      -8              0      0                        0      0
       0              0     15                        0      0     <-- the AUTHORED size
       4              0    434                        0      0
       7              0   2660                        0      0
      11              0   8855                        0      0
      20              0  10117                        0      0
      30              0  10117                        0      0
```

Error the kernel actually sees (each component against the PAIR's magnitude, since the pair is
multiplied by one push and added to klm):

```
    2^e   format             worst/own       worst/pair        mean/pair
      -8  half                9.721e-4         9.721e-4         2.675e-4
      -8  shared-exponent     1.000e+0         4.730e-4         1.710e-4
       0  half                1.000e+0         9.414e-2         2.845e-4
       0  shared-exponent     1.000e+0         4.730e-4         1.710e-4
       4  half                1.000e+0         1.000e+0         1.895e-2
       4  shared-exponent     1.000e+0         4.730e-4         1.710e-4
      20  half                1.000e+0         1.000e+0         7.720e-1
      20  shared-exponent     1.000e+0         4.730e-4         1.710e-4
```

The shared exponent is **4.730e-4 at every exponent**, under the 2^-11 = 4.883e-4 bar, and is BETTER
than half at scale 1 on both worst case and mean — the half packer truncates its mantissa
(`m >>> 13`) rather than rounding, and flushes anything under 6.1e-5.

`worst/own` reads 1.000e+0 for the shared exponent because a subordinate component far below the
pair's magnitude quantizes to zero. That is the shared exponent's defining trade and it is bounded:
such a component contributes at most 2^-11 of the pair to the klm delta either way, which is the
same bound the DOMINANT component carries. It is the pair, not the component, that the kernel
multiplies.

## Scale-1 survey — every differing float explained

`probes/scaleRest/_klmGradCensus.mjs`, rebuilding a half-precision slot from the same decoded pair
so the diff is exact:

- 498 shapes carry rings; **2,249,064 packed floats; 15,177 extruded ring vertices**.
- **445 of 498 shapes differ in bytes. 15,177 floats differ — 0.67% of the pack — and every one is
  lane 9**, one per extruded ring vertex. Nothing else in the pack differs, because the format is
  one assignment (`lbPack.js` `v[o + 9] = packKlmGrad(R9.dk, R9.dl)`); vertex counts, kind masks and
  every other lane are the same.
- **39 components the half codec turns into a hard zero or an inf are carried.**
- The worst half round-trip error, relative to the pair, is **9.446e-2** — 9.4% of the gradient's
  own magnitude, at the authored size. The shared exponent bounds it by 4.730e-4.

So every differing float is the same gradient, quantized more accurately. This is the case where
"shown correct, not identical" is easy: the new value is closer to the builder's own double.

## The falsifiable claim

Pin the LB route (`setFillEngine`, and **check the draw tally** — a shader that fails to link falls
back to Slug and reads as a triumph) and render an asset with cubic curve-band rings.
`engineDeclineIsolation__STAR` (1794 moved floats), `gwnCurveRange__CLAW` and `tiger` are the
densest.

1. **At the authored size, ink XOR should be 0 or near it.** The gradient moves by at most 4.7e-4 of
   its own pair, which reaches the edge as under a thousandth of a pixel — below one level of 8-bit
   alpha. Predicted: **0 pixels differ** on every corpus asset; if any do, they are single-level
   edge pixels on a shape whose half slot flushes (39 components corpus-wide). _Falsified if_ a
   solid region moves, or a silhouette changes, anywhere.

2. **At `scale(2^-20)` with the viewport fitted back, a half-precision lane should be visibly wrong
   and the shared exponent should not.** 1883 of 16,604 components saturate to inf under half at
   that scale, and an infinite klm gradient makes the extruded ring vertex's implicit meaningless —
   so the AA band around a cubic paints garbage or nothing. Predicted: the shared-exponent arm is
   ink-identical to the same drawing at scale 1; the half arm is not. _Falsified if_ the
   shared-exponent arm still differs from its own scale-1 render.

3. **At `scale(2^7)` and above, the same the other way.** 2660 components flush to zero at 2^7,
   which welds the extruded vertex's klm to the hull's — the ring stops carrying a gradient at all
   and the AA band collapses. Predicted: shared-exponent arm ink-identical to scale 1; half arm
   loses the band.

4. **The morph path.** `lbMixKlmGrad` unpacks both endpoints, mixes the vector and re-packs. Render
   a cubic morph (`lbMorphEvenOdd`, `unifiedMorphSmoke`'s blob) at t = 0, 0.25, 0.5, 0.75, 1.
   Predicted: t = 0 and t = 1 are bit-identical to the static draws of those poses (the mix is the
   identity there), and no dropout appears at intermediate t. A wrong re-encode shows as isolated
   dropouts at 0 < t < 1 with both endpoints exact. _Falsified if_ any intermediate t shows a
   dropout the endpoints do not.

**Note.** The two GLSL codec functions are checked by compiling them VERBATIM as C++ and comparing
against the JS packer over 43,459 cases (0 differences, pack and unpack). That is not a GLSL
compile. **The first thing to confirm on a GPU is that the program links.**
