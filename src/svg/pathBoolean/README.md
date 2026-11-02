# pathBoolean — exact Bezier path boolean for Mantle

Used by the per-bundle silhouette extraction feature (`importSvg({ computeSilhouette: true })`,
injected as the stroke-only `__silhouette__` shape) and by the renderer's self-overlap resolver
(`shapeResolve`). Computes the **outer silhouette** of the union of all filled paths in a bundle,
preserving native SEG_LINE / SEG_QUAD / SEG_CUBIC / SEG_ARC primitives through the operation.

Not every kernel is exact on its own: quad x cubic and cubic x cubic go to the Bezier clipper, which
drops crossings. Pass `intersect/exact.js`'s `intersectSegmentsExact` as `opts.intersect`, as both
callers do.

## Architecture

```
union(paths) → outer-silhouette segments
   │
   ├─ subdivide each segment at its y-extrema (subdivide.js)
   ├─ intersect every pair of segments and split them at the hits
   │    (planar/segmentSet.js, O(N²) pairs)
   │    └─ intersect/dispatch — 10 primitive-pair kernels
   ├─ build planar subdivision (DCEL: vertices, half-edges, faces)
   ├─ evaluate fill rule per face → "inside" set
   └─ traverse outer boundary of "inside" set → silhouette
```

## Files

- `intersect/lineLine.js` — 1 intersection, closed form.
- `intersect/lineQuad.js` — up to 2 (quadratic in t).
- `intersect/lineCubic.js` — up to 3 (cubic in t).
- `intersect/lineArc.js` — up to 2.
- `intersect/quadQuad.js` — up to 4 (resultant theory).
- `intersect/quadCubic.js` — up to 6.
- `intersect/quadArc.js` — up to 4.
- `intersect/cubicCubic.js` — up to 9 (Bezier clipping / fat-line).
- `intersect/cubicArc.js` — up to 6.
- `intersect/arcArc.js` — up to 4.
- `intersect/coincident.js` — two curves that run along the same underlying curve (a shared stretch
  has no isolated crossing).
- `intersect/index.js` — type-pair dispatcher.
- `intersect/exact.js` — the dispatcher plus exact implicit composition for quad/cubic pairs; what a
  union should run.

- `bezierClip.js` — curve×curve intersection by Bezier clipping (Sederberg & Nishita, CAD 1990).
- `polyRoots.js` — real polynomial roots for the kernels.
- `canonical.js` — puts geometry at a canonical size before a kernel with world-unit epsilons sees
  it.
- `subdivide.js` — split at y-extrema + tangent-x points.

- `planar/segmentSet.js` — pairwise intersection + splitting into elementary segments.
- `planar/dcel.js` — DCEL construction (vertices, half-edges, faces).
- `planar/segGeom.js` — per-edge geometry: points, signed area terms.
- `planar/fillRule.js` — point-in-shape test per fill rule, to classify each face.

- `union.js` — entry point: `unionPaths(filledPaths) → silhouetteContour`.

## Numerical notes

- All intersection kernels return `{ tA, tB, x, y }` records.
- Endpoint coincidences (`tA == 0/1` or `tB == 0/1`) are left out of the split parameters, so a
  segment is never split at its own end.
- The parameter tolerances (`EPS` in `planar/segmentSet.js` and `planar/fillRule.js`) are in t, not
  world units. Geometry is put at a canonical size (`canonical.js`) before a kernel with world-unit
  epsilons looks at it, so the answer does not depend on the bundle's scale.
