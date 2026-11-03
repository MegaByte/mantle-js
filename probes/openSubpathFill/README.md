# An open filled subpath over-filled under Slug and AAC

`examples/smoke/openFillNoZ__SVG.svg` is the minimal case: one filled cubic with no `Z`, which SVG
fills as if closed. With the interior-skip occupancy grid built from the path as authored, Slug
paints **33,850 px outside the path at full opacity** at 1024 px (ink +31.6% over an exact
reference); Loop-Blinn, which builds its own mesh, is exact.

## What the probes establish

| probe                     | question                                         | answer                                                                                                                                            |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SegCmp.mjs`              | does the implicit close differ from `Z`?         | No. Both get a closing line; `Z` merely adds a ZERO-LENGTH third segment.                                                                         |
| `Hdr.mjs`                 | is the closing edge in the curve buffer?         | Yes, `hdr=4` (`is_fill_only`), ends not free-marked.                                                                                              |
| `Raw.mjs`                 | what is in the shape's curve range?              | The raw texels, four floats per row.                                                                                                              |
| `Cpu.mjs`                 | is the CPU winding right?                        | **Yes** — `pointInFill` gives an identical 6,785 inside px for the 2-seg and 3-seg variants.                                                      |
| `DropLast.mjs`            | would dropping the closing edge explain the ink? | No. Dropping it over-fills far more than the observed 1.3156x.                                                                                    |
| `Bands.mjs`, `VBands.mjs` | is the band data right?                          | **Yes** — header `(nLine=1, nQuad=0, nCubic=1, nArc=0)`, entries `LINE loc=5` then `CUBIC loc=1`, correct order and break/far values, in H and V. |
| `Bbox.mjs`                | do the two forms get the same cover quad?        | Yes, identical meta bboxes.                                                                                                                       |
| `Walk.mjs`                | what does a direct GPU render paint?             | The Slug ink and grey-level histogram of one fixture.                                                                                             |

So the geometry, the crossing rule, the band data and the cover quad are all correct.

## Eliminated, with the test that eliminated it

- **NOT `is_fill_only`.** Suppressing bit 2 at encode time changes the render by exactly nothing.
  The authored-`L` control decodes as THREE segments (the synthetic close is always appended), so it
  does not isolate the segment count.
- **NOT the segment TYPE.** quad+close (2 segs) fails at 2,938 px just as cubic+close does.
- **NOT band structure.** bandK 1 / 4 / 32 give identical wrong counts.
- **NOT the band-list sort key.** Masking it (`segTypes[a] & 3`, which the counts already use and
  `encodeSeg` explicitly demands) is inert here.

## Cause

An interior-skip occupancy grid built from the path as authored over-fills: its inside test never
closes an open subpath, while the fill encoding does, so cells past the closing chord are certified
interior and the shader's skip paints them solid under every kernel that reads the grid (Slug, AAC,
band-hard, GWN). The grid is built off-thread and lands a few frames in, so a direct first-frame
render (`Walk.mjs`) reads clean while a page that waits for the grid (`probes/_zzEnginePaint.mjs`)
shows the over-fill. The renderer builds the grid from the closed fill segments;
`test/openSubpathOccupancySmoke.mjs` and `test/bandDiscriminatorSmoke.mjs` guard it.
