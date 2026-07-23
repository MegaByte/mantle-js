# Slug native-arc fill bug — minimal reproduction

`DIR=probes/_slugArcBug MAP=1 SIZE=40 node probes/_iconAaAudit.mjs`

Two SVGs describing the SAME 64x64 disc, differing only in WHERE the two
180-degree arcs meet:

| file | arc junctions | Slug result |
|---|---|---|
| `a-junction-top.svg` | (32,0) and (32,64) — the Y extremes, vertical chord | **BROKEN**: fills only a narrow central band plus the outline |
| `b-junction-side.svg` | (64,32) and (0,32) — the X extremes, horizontal chord | correct (matches LB) |

Loop-Blinn renders BOTH correctly, and an independent browser raster agrees
with LB, so this is a Slug defect, not an LB one.

Forcing the importer to emit cubics instead of native arcs makes Slug render
`a` correctly, which localises the bug to the NATIVE-ARC fill path
(`_coverage.glsl`, the H/V arc sub-loops around lines 980-1160 and the band
`breakAxis` early-out) for arcs whose endpoints sit at the ellipse's Y extremes.
To re-test that, gate `src/svg/path.js`'s `arcToNative(...)` call behind a flag
and substitute `arcToCubics(...)`.

NOT yet localised to a line. Checked and found correct on inspection:
`arcInRange` (handles wrapped sweeps), the H-arc crossing solve
(`A cos + B sin = C`, roots `atan2(B,A) +- acos(C/Rlen)`), and `arcTightBbox`'s
extremum inclusion. The remaining suspects are the encoded theta range and the
band membership/`breakAxis` values actually written by `src/svg/textures.js` —
measure those directly rather than reasoning about them.

CAUTION: the audit's reference is Slug at 8x, so for these files BOTH columns
are meaningless (the probe prints a `[warn]`). Read the MAP, or adjudicate
cells against a browser raster.
