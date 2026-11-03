# Slug native-arc fill — minimal regression case

`DIR=probes/_slugArcBug MAP=1 SIZE=40 node probes/_iconAaAudit.mjs`

Two SVGs describing the same 64x64 disc, differing only in WHERE the two 180-degree arcs meet:

| file                  | arc junctions                                         | what it exercises                                                   |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `a-junction-top.svg`  | (32,0) and (32,64) — the Y extremes, vertical chord   | the vertical walker's degenerate phase                              |
| `b-junction-side.svg` | (64,32) and (0,32) — the X extremes, horizontal chord | the control: the same disc, split where the phase is not degenerate |

Both must fill identically, and Loop-Blinn and an independent browser raster must agree with Slug on
both.

What `a` guards: an UNROTATED ellipse (phi = 0, so every circle and axis-aligned ellipse) has
`sin(phi) = +0`, so the vertical walker's `B = -sin(phi) * ry` is NEGATIVE ZERO, and `atan(-0, +A)`
resolves to PI instead of 0. With the phase half a turn out, both roots fall outside the arc's theta
range, the arc contributes no crossings, and the shape does not fill. `_coverage.glsl` writes the
degenerate phase directly (`(B == 0.0) ? (A >= 0.0 ? 0.0 : PI) : curveAtan2(B, A)`); normalizing the
zero with `B += 0.0` is elided by the compiler and does not work. The horizontal walker is immune
(`atan(+y, ±0)` is `+PI/2` either way), which is why the defect shows only as missing fill, and only
for a disc split at the Y extremes.

CAUTION: the audit's reference is Slug at 8x, so for these files a Slug defect moves both columns
(the probe prints a `[warn]`). Read the MAP, or adjudicate cells against a browser raster.
