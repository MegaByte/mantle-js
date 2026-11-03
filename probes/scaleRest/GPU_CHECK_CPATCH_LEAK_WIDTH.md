# GPU check — a CPatch leak's WIDTH, beside its depth

## What is measured

`leakOfInner` reports how far past its own arcs a patch's half-space conjunction reaches (`depth`),
and how much of the conjunction stands behind it there (`width`). The search's width policy is a
parameter the caller states, not a probe step it borrows.

- **`width` is measured** and reported on every leak: walk curve _i_'s inward normal from the
  stretch, doubling while the conjunction still contains the ray and then bisecting the crossing, in
  the patch's own length units, capped at its bbox diagonal. It has no bar of its own.
  `patchDiag * 2^-30` is the measurement's RESOLUTION, relative to the patch and therefore
  scale-equivariant; it decides nothing. It is computed **once, on the leak that is returned**, so
  the search's hot path is a single probe.
- **The policy is two named parameters.** `ask.samePx` is the scale at which a composition along
  curve _i_'s own arc counts as zero (the same-algebraic-curve test), and `ask.minWidthPx` is the
  caller's WIDTH POLICY: how narrow a sliver it is willing to leave uncut. Both default to
  `nudgePx`, which defaults to `tolPx`. With `nudgePx` as the width policy, the search's predicate
  is non-monotone in its own bar.
- **`ask.measuredWidth`** compares the MEASURED width to the policy instead of asking the policy's
  own probe. It is monotone in the policy by construction, because the policy then appears only as a
  threshold on a number that does not depend on it. **Off by default.**
- The SEARCH's policy is stated at `leakOf`, with the trade written down and the measurement that
  settles it (345 of the corpus's 1327 decompositions change under the monotone ask; tiger's
  under-coverage rises 64 px²).

## What the CPU says

`probes/cpatchGate/_leakWidth.mjs`, tiger's first 60 shapes, 1196 patches, tol 0.05, asked at the
GATE's question (the patch's BOX, which is where the renderer's fence sits — against its COVER HULL
a finished patch is valid by construction and both arms return null, a vacuous A/B):

```
  552 of 1196 patches leak
  depth   min 5.305e-2   median 6.439e+0   max 3.009e+2
  width   min 0.000e+0   median 0.000e+0   max 7.090e+1
```

**Depth and width do not track.** Of the 274 leaks deeper than the median depth, **200 are narrower
than the search's own bar** — deep hairlines a depth-only reading cannot tell from a wedge. 423 of
552 are narrower than 0.05 and **408 hold no area at all** just inside the curve; 129 are wider than
0.05, the widest 70.9 on a patch whose extent is 78.4. That population is exactly what the width
policy declines to cut for, and depth alone does not show it.

**The width is exactly scale-equivariant.** 50 positive-width leaks compared at 2^-8 and 2^8 (plus
204 that are zero at both): **worst relative deviation 0.000e+0**.

**The measured predicate would cost almost nothing, and is off.** At the search's ask, 473 of 1196
patches leak, so the comparison is not vacuous, and **2 change**: tiger #38 patch 23 reports the
same depth (13.526) from a different probe parameter, and #39 patch 35 has the probe accept a leak
of **zero measured width** that the measured form declines. Both changes are in the measured form's
favor, and it stays opt-in anyway.

## Scale-1 survey

The default path is unchanged by construction — `samePx` and `minWidthPx` both default to `nudgePx`,
and the only extra work is a `widthAt` call on the leak being returned:

- `probes/_cpatchMeshCensus.mjs --diff` against a build without the width: **1056 of 1056 shapes
  byte-identical**.
- Build time 8674 ms → 8651 ms over the same corpus, i.e. inside the noise.
- `cpatchMorphPlanSmoke` 37/37 and `cpatchRowGateSmoke` green.

## The falsifiable claim

**The width report moves no pixel.** That is the strong form: the decomposition survey is
byte-identical over 1056 shapes, so every CPatch draw of every corpus asset must be ink-identical
with and without it.

1. Pin CPatch (`setFillEngine`, and **check the draw tally** — a shape that declines falls to Slug
   and an unchanged picture then proves nothing). Render the smoke corpus with and without the width
   report. **Predicted: ink XOR 0 everywhere.** _Falsified if_ any pixel moves.
2. Then the experiment the width buys, which is the reason to have it. Re-render with
   `__CP_LEAK_REL` unchanged but the search asked at `{ minWidthPx: 0 }` (a tolerance-free width
   policy, i.e. cut for every leak however thin). **Predicted:** more patches, more seams, and — per
   the measurement in `leakOfInner`'s header — _worse_ coverage, with under-coverage rising while
   over-coverage barely moves, concentrated on thin features (tiger's stripes #28..#38). If that
   reproduces, the search's width policy is confirmed as a policy rather than an oversight, and the
   number to tune is visible. _Falsified if_ a tolerance-free width policy improves coverage — in
   which case the policy is wrong and the width report is what lets it be replaced.
3. The morph plan. Of `cpatchMorphPlanSmoke`'s 201 sampled poses, 7 and 25 report leaks 8–15 deep
   and 0.004–0.025 wide under a tolerance-free nudge. Those leaks carry their width, so the smoke's
   dependency on the policy is legible rather than load-bearing. **Predicted:** the plan is
   unchanged (it is, on the CPU) and the widths of those poses' leaks land in that same 0.004–0.025
   band.
